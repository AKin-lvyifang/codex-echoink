import { ModuleOwnerRequired } from "../../agents/registry";
import { Notice, setIcon } from "obsidian";
import type CodexForObsidianPlugin from "../../main";
import {
  createOriginButton,
  createOriginCheck,
  createOriginPagination,
  disposeOriginControls,
} from "../../settings/origin-controls";
import { applyAmicroButton, setAmicroButtonPending } from "../../settings/amicro-buttons";
import {
  checkupTitle,
  type KnowledgeCheckupSnapshot,
} from "../../knowledge-base/knowledge-checkup";
import type { DeepCheckupSnapshot } from "../../knowledge-base/knowledge-deep-checkup";
import type { CheckupSelection, CheckupFollowup } from "../../plugin/knowledge-checkup-service";
import type {
  MaintenanceUpgradePreview,
  MaintenanceUpgradeSnapshot,
} from "../../knowledge-base/maintenance-upgrade-contract";
import { prefillWorkbenchModule } from "../module-navigation";
import { CHECKUP_GROUPS, checkupRows, rowRepair, type CheckupRow } from "./rows";
import { renderCheckupRow } from "./list-row";
import { renderCheckupPreview, renderCheckupReceipt } from "./results";

/** Page state only. Diagnosis and the durable upgrade executor own data and writes. */
export class KnowledgeCheckupPanel {
  private snapshot?: KnowledgeCheckupSnapshot;
  private deep?: DeepCheckupSnapshot;
  private preview?: MaintenanceUpgradePreview;
  private job?: MaintenanceUpgradeSnapshot;
  private state: "list" | "preview" | "job" = "list";
  private readonly selections = new Map<string, CheckupSelection>();
  private readonly pages = new Map<string, number>();
  private selectedKind = "";
  private readonly expandedEvidence = new Set<string>();
  private busy = false;
  private pendingIgnore = false;
  private error = "";
  private disposed = false;
  private generation = 0;
  private deepGeneration = 0;
  private restored = false;
  private cost?: { calls: number; maximumCalls: number; resolve(value: boolean): void };
  private readonly releases: Array<() => void> = [];
  constructor(
    private readonly host: HTMLElement,
    private readonly plugin: CodexForObsidianPlugin,
    private readonly back: () => void,
    private readonly upgrade: (path?: string) => void,
  ) {
    const release = plugin.getKnowledgeActivitySource()?.subscribe(() => {
      if (this.job?.recordId) void this.refreshJob();
    });
    if (release) this.releases.push(release);
    this.releases.push(
      this.service().deep.subscribe(() => {
        void this.refreshDeep()
          .then(() => this.render())
          .catch((error) => {
            this.error = error instanceof Error ? error.message : String(error);
            this.render();
          });
      }),
    );
  }
  private service() {
    return this.plugin.getKnowledgeSurfaceService()!.checkup;
  }
  dispose() {
    this.disposed = true;
    this.generation++;
    this.cost?.resolve(false);
    this.releases.forEach((release) => release());
    disposeOriginControls(this.host);
    this.host.empty();
  }
  async refresh() {
    const generation = ++this.generation;
    try {
      const data = await this.service().quick();
      if (this.disposed || generation !== this.generation) return;
      this.snapshot = data;
      await this.refreshDeep();
      if (this.disposed || generation !== this.generation) return;
      this.initializeSelections();
      if (!this.restored) {
        this.restored = true;
        this.job = await this.plugin.getKnowledgeSurfaceService()!.upgrade.getUpgradeSnapshot();
        if (this.job.purpose !== "checkup") this.job = undefined;
        else if (this.job.status === "running") this.state = "job";
      }
      this.render();
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
      this.render();
    }
  }
  private rows(): CheckupRow[] {
    return this.snapshot ? checkupRows(this.snapshot, this.deep) : [];
  }
  private initializeSelections() {
    const rows = this.rows();
    const ids = new Set(rows.map((row) => row.id));
    for (const id of this.selections.keys()) if (!ids.has(id)) this.selections.delete(id);
    for (const row of rows)
      if (!this.selections.has(row.id))
        this.selections.set(row.id, {
          id: row.id,
          action: row.kind === "unplaced" ? "later" : row.recommended,
          ...(row.issue?.candidates?.length === 1 ? { target: row.issue.candidates[0] } : {}),
        });
  }
  private async refreshDeep() {
    const generation = ++this.deepGeneration;
    const snapshot = await this.service().deep.snapshot();
    if (this.disposed || generation !== this.deepGeneration) return;
    this.deep = snapshot;
    this.initializeSelections();
  }
  private async refreshJob() {
    const job = await this.plugin.getKnowledgeSurfaceService()!.upgrade.getUpgradeSnapshot();
    if (this.disposed) return;
    this.job = job.purpose === "checkup" ? job : undefined;
    if (this.pendingIgnore && job.status !== "running") {
      this.pendingIgnore = false;
      if (job.status === "completed") {
        this.job = undefined;
        await this.refresh();
        return;
      }
      this.error = job.message ?? "不再提示尚未保存，请继续修复。";
    }
    this.render();
  }
  private button(
    parent: HTMLElement,
    text: string,
    action: () => unknown,
    variant: "primary" | "secondary" | "tertiary" = "secondary",
  ) {
    const primary = variant === "primary";
    const button = createOriginButton(parent, {
      text,
      cls: `knowledge-button is-${variant}${primary ? " mod-cta" : ""}`,
    });
    applyAmicroButton(button, { variant });
    button.disabled = this.busy || this.pendingIgnore;
    button.onclick = () => {
      if (button.disabled) return;
      button.disabled = true;
      this.busy = true;
      setAmicroButtonPending(button, true);
      this.error = "";
      this.host.querySelector(".knowledge-error")?.remove();
      void Promise.resolve()
        .then(action)
        .catch((error) => {
          if (error instanceof ModuleOwnerRequired) this.plugin.openModuleOwnerPicker(error.moduleId, async () => action());
          else this.error = error instanceof Error ? error.message : String(error);
        })
        .finally(() => {
          this.busy = false;
          if (!this.disposed) this.render();
        });
    };
    return button;
  }
  private render() {
    if (this.disposed) return;
    const scroll = this.host.scrollTop;
    disposeOriginControls(this.host);
    this.host.empty();
    const page = this.host.createDiv({
      cls: "knowledge-checkup",
      attr: { "data-checkup-state": this.state },
    });
    const header = page.createDiv({ cls: "knowledge-checkup-header" });
    const back = this.button(
      header,
      "",
      async () => {
        if (this.state === "list") this.back();
        else {
          this.state = "list";
          await this.refresh();
        }
      },
      "tertiary",
    );
    back.setAttribute("aria-label", "返回");
    back.addClass("is-icon");
    setIcon(back, "arrow-left");
    const count = this.preview?.checkupActions?.length ?? this.preview?.automatic.length ?? 0;
    header.createEl("h1", {
      text:
        this.state === "list"
          ? "知识库体检"
          : this.state === "preview"
            ? `修复 ${count} 项`
            : this.job?.status === "running"
              ? "正在修复"
              : "修复结果",
    });
    const actions = header.createDiv({ cls: "knowledge-checkup-actions" });
    if (this.error)
      page.createDiv({ cls: "knowledge-error", text: this.error, attr: { role: "alert" } });
    if (this.state === "preview" && this.preview) {
      this.button(
        actions,
        "开始修复",
        async () => {
          this.job = await this.plugin
            .getKnowledgeSurfaceService()!
            .upgrade.confirmUpgrade(this.preview!.id);
          this.state = "job";
        },
        "primary",
      ).dataset.checkupAction = "confirm";
      renderCheckupPreview(page.createDiv({ cls: "knowledge-checkup-results" }), this.preview, {
        app: this.plugin.app,
        disabled: this.busy,
        change: async (id, value) => {
          const selection = this.selections.get(id);
          if (!selection || this.busy) return;
          this.busy = true;
          this.render();
          try {
            selection.target = value;
            this.preview = await this.service().prepare(this.selected());
          } catch (error) {
            this.error = error instanceof Error ? error.message : String(error);
          } finally { this.busy = false; if (!this.disposed) this.render(); }
        },
      });
    } else if (this.state === "job") this.renderJob(page, actions);
    else this.renderList(page, actions);
    this.host.scrollTop = scroll;
  }
  private selected(): CheckupSelection[] {
    return this.rows()
      .map((row) => this.selections.get(row.id)!)
      .filter((item) => item?.action !== "later");
  }
  private async runDeep() {
    try {
      if (this.deep?.status === "interrupted") await this.service().deep.resume();
      else
        await this.service().deep.start(
          (calls, maximumCalls) =>
            new Promise<boolean>((resolve) => {
              this.busy = false;
              this.cost = { calls, maximumCalls, resolve };
              this.render();
            }),
        );
      await this.refreshDeep();
    } catch (error) {
      if (error instanceof Error && error.name === "KnowledgeDeepCheckupModelMissing") {
        new Notice(error.message);
        await this.plugin.openWorkbenchSetup("models");
      } else throw error;
    }
  }
  private renderDeepButton(actions: HTMLElement) {
    const running = this.deep?.status === "running";
    const progress =
      this.deep && this.deep.status !== "idle"
        ? ` · 已查 ${this.deep.completedDomains}/${this.deep.totalDomains} 个领域`
        : "";
    const text = running ? "深查中" : this.deep?.status === "interrupted" ? "继续深查" : "深查";
    const start = this.button(actions, text + progress, () => this.runDeep());
    start.dataset.checkupDeep = "start";
    if (running) {
      start.disabled = true;
      setAmicroButtonPending(start, true);
      this.button(actions, "停止深查", () => this.service().deep.stop()).dataset.checkupDeep =
        "stop";
    }
  }
  private renderList(page: HTMLElement, actions: HTMLElement) {
    this.renderDeepButton(actions);
    const resume =
      this.job?.recordId && ["interrupted", "failed", "running"].includes(this.job.status);
    const selected = this.selected();
    const repair = this.button(
      actions,
      resume ? "继续修复" : `修复 ${selected.length} 项`,
      async () => {
        if (resume) {
          this.job = await this.plugin.getKnowledgeSurfaceService()!.upgrade.resumeUpgrade();
          this.state = "job";
        } else {
          this.preview = await this.service().prepare(selected);
          this.state = "preview";
        }
      },
      "primary",
    );
    repair.dataset.checkupAction = resume ? "resume" : "preview";
    repair.disabled ||= !resume && !selected.length;
    if (this.cost) {
      const cost = this.cost;
      const confirm = page.createDiv({ cls: "knowledge-checkup-cost", attr: { role: "alert" } });
      confirm.createSpan({ text: `正常约 ${cost.calls} 次模型，本轮含自动重试最多 ${cost.maximumCalls} 次，使用你自己的 Key。` });
      this.button(confirm, "先不查", () => {
        this.cost = undefined;
        cost.resolve(false);
      });
      this.button(confirm, "开始深查", () => {
        this.cost = undefined;
        cost.resolve(true);
      });
      startDisable(actions);
    }
    if (!this.snapshot) {
      page.createDiv({ text: "正在读取…" });
      return;
    }
    const rows = this.rows();
    const summary = page.createDiv({ cls: "knowledge-checkup-summary" });
    const health = this.plugin.getKnowledgeSurfaceService()!.getHealthSnapshot();
    summary.createSpan({ text: `知识健康 ${health.status === "unknown" ? "—" : health.score}` });
    summary.createSpan({ text: `待处理 ${rows.length}` });
    if (this.snapshot.loading) summary.createSpan({ text: "链接仍在解析" });
    if (this.deep?.message) summary.createSpan({ text: this.deep.message });
    const frame = page.createDiv({ cls: "knowledge-checkup-browser" });
    if (!rows.length) {
      frame.createDiv({ cls: "knowledge-checkup-empty", text: this.deep?.status === "interrupted"
        ? "深查尚未完成，请继续检查" : this.deep?.status === "running" ? "正在深查…"
        : "知识库很健康，没有待处理的问题" });
      return;
    }
    if (!rows.some((row) => row.kind === this.selectedKind)) {
      this.selectedKind = CHECKUP_GROUPS.flatMap((group) => [...group.kinds]).find(([kind]) =>
        rows.some((row) => row.kind === kind),
      )![0];
    }
    const nav = frame.createDiv({
      cls: "knowledge-checkup-nav",
      attr: { "aria-label": "问题分类" },
    });
    for (const group of CHECKUP_GROUPS) {
      const kinds = group.kinds.filter(([kind]) => rows.some((row) => row.kind === kind));
      if (!kinds.length) continue;
      nav.createDiv({ cls: "knowledge-checkup-nav-label", text: group.label });
      for (const [kind, label] of kinds) {
        const button = this.button(
          nav,
          "",
          () => {
            this.selectedKind = kind;
            this.render();
          },
          "tertiary",
        );
        button.addClass("knowledge-checkup-category");
        button.dataset.checkupCategory = kind;
        button.setAttribute("aria-pressed", String(kind === this.selectedKind));
        button.createSpan({ text: label });
        button.createSpan({ text: String(rows.filter((row) => row.kind === kind).length) });
      }
    }
    const detail = frame.createDiv({ cls: "knowledge-checkup-detail" });
    const current = rows.filter((row) => row.kind === this.selectedKind);
    const heading = detail.createDiv({ cls: "knowledge-checkup-class-heading" });
    const selectable = current.filter(
      (row) => rowRepair(row, this.selections.get(row.id)!) !== "later",
    );
    const count = selectable.filter(
      (row) => this.selections.get(row.id)!.action !== "later",
    ).length;
    const slot = heading.createDiv({ cls: "knowledge-checkup-slot" });
    if (selectable.length) {
      const master = createOriginCheck(slot, { attr: { "aria-label": "全选当前类" } });
      master.checked = count === selectable.length;
      master.indeterminate = count > 0 && count < selectable.length;
      master.disabled = this.busy || this.pendingIgnore;
      master.addEventListener("change", () => {
        for (const row of selectable) {
          const selection = this.selections.get(row.id)!;
          selection.action = master.checked ? rowRepair(row, selection) : "later";
        }
        this.render();
      });
    }
    heading.createEl("strong", {
      text:
        CHECKUP_GROUPS.flatMap((group) => [...group.kinds]).find(
          ([kind]) => kind === this.selectedKind,
        )?.[1] ?? this.selectedKind,
    });
    heading.createSpan({
      cls: "knowledge-checkup-class-count",
      text: selectable.length ? `${count} / ${current.length}` : `${current.length}`,
    });
    const list = detail.createDiv({ cls: "knowledge-checkup-list" });
    const currentPage = Math.min(
      this.pages.get(this.selectedKind) ?? 1,
      Math.ceil(current.length / 20),
    );
    for (const row of current.slice((currentPage - 1) * 20, currentPage * 20)) {
      renderCheckupRow(list, row, this.selections.get(row.id)!, {
        app: this.plugin.app,
        busy: this.busy || this.pendingIgnore,
        expanded: this.expandedEvidence.has(row.id),
        toggle: () => {
          if (this.expandedEvidence.has(row.id)) this.expandedEvidence.delete(row.id);
          else this.expandedEvidence.add(row.id);
        },
        button: (parent, text, action, variant) => this.button(parent, text, action, variant),
        change: () => this.render(),
        ignore: async () => {
          const preview = await this.service().prepare([{ id: row.id, action: "ignore" }]);
          this.job = await this.plugin
            .getKnowledgeSurfaceService()!
            .upgrade.confirmUpgrade(preview.id);
          this.pendingIgnore = true;
          await this.refreshJob();
        },
      });
    }
    if (current.length > 20)
      createOriginPagination(detail, currentPage, Math.ceil(current.length / 20), (value) => {
        this.pages.set(this.selectedKind, value);
        this.render();
      });
  }
  private renderJob(page: HTMLElement, actions: HTMLElement) {
    const job = this.job;
    if (!job) return;
    const successes =
      job.checkupResults?.filter((row) => row.status === "success").length ??
      job.completed?.wiki ??
      0;
    const total = job.checkupResults?.length ?? job.counts.wikiCount;
    page.createDiv({
      cls: "knowledge-checkup-summary",
      text:
        job.status === "running" ? `已处理 ${successes} / ${total} 项` : `已修复 ${successes} 项`,
      attr: { role: "status", "aria-live": "polite" },
    });
    if (job.status === "running") {
      const progress = page.createEl("progress");
      progress.max = Math.max(1, total);
      progress.value = successes;
      progress.setAttribute("aria-label", "修复进度");
      this.button(actions, "停止", () =>
        this.plugin.getKnowledgeSurfaceService()!.upgrade.stopUpgrade(),
      ).dataset.checkupAction = "stop";
    } else if (["interrupted", "failed"].includes(job.status)) {
      this.button(
        actions,
        "继续修复",
        async () => {
          this.job = await this.plugin.getKnowledgeSurfaceService()!.upgrade.resumeUpgrade();
        },
        "primary",
      ).dataset.checkupAction = "resume";
    } else
      this.button(
        actions,
        "完成",
        async () => {
          this.state = "list";
          this.job = undefined;
          this.preview = undefined;
          await this.refresh();
        },
        "primary",
      ).dataset.checkupAction = "rescan";
    renderCheckupReceipt(page.createDiv({ cls: "knowledge-checkup-results" }), job);
    if (job.message) page.createDiv({ cls: "knowledge-error", text: job.message });
    if (job.status === "completed")
      for (const followup of job.preview?.followups ?? []) this.followup(page, followup);
  }
  private followup(page: HTMLElement, item: CheckupFollowup) {
    const row = page.createDiv({ cls: "knowledge-checkup-row" });
    row.createSpan({ text: checkupTitle(item.path) });
    this.button(row, item.action === "upgrade" ? "去升级核对" : "继续提炼", () =>
      item.action === "upgrade"
        ? this.upgrade(item.path)
        : prefillWorkbenchModule(
            this.plugin,
            "knowledge-base",
            `/maintain 请根据以下真实来源重新提炼并补充已有页「${item.path}」，不要重复新建。来源：${item.sources?.join("、")}。`,
          ),
    );
  }
}

function startDisable(actions: HTMLElement) {
  actions.querySelectorAll<HTMLButtonElement>("button").forEach((button) => {
    button.disabled = true;
  });
}
