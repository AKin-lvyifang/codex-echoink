import { openObsidianGraphLeaf } from "../open-native-graph";
import { Notice, TFile, setIcon } from "obsidian";
import type CodexForObsidianPlugin from "../../main";
import { createOriginButton, disposeOriginControls } from "../../settings/origin-controls";
import { applyAmicroButton, setAmicroButtonPending } from "../../settings/amicro-buttons";
import {
  knowledgeSystemReminderText,
  type KnowledgeSystemReminder,
} from "../../knowledge-base/knowledge-system-reminders";
import { openObsidianLocalGraphLeaf } from "../open-native-graph";
import { prefillWorkbenchModule } from "../module-navigation";
import { knowledgeMapIcon } from "./icon";
import type { KnowledgeMapDomain, KnowledgeMapEntry } from "./data";

export class KnowledgeMapPanel {
  private selected = "";
  private collapsed = new Set<string>();
  private domains: readonly KnowledgeMapDomain[] = [];
  private reminders: readonly KnowledgeSystemReminder[] = [];
  private toolbar: HTMLElement | null = null;
  private signature = "";
  constructor(
    private readonly mapHost: HTMLElement,
    private readonly reminderHost: HTMLElement,
    private readonly plugin: CodexForObsidianPlugin,
    private readonly refresh: () => Promise<void>,
  ) {}

  private t(zh: string, en: string): string {
    return this.plugin.settings.settingsLanguage === "en" ? en : zh;
  }
  private reset(host: HTMLElement): void {
    disposeOriginControls(host);
    host.empty();
  }
  private button(
    host: HTMLElement,
    text: string,
    action: () => unknown,
    icon?: string,
    tertiary = false,
  ): HTMLButtonElement {
    const button = createOriginButton(host, {
      text: icon ? "" : text,
      cls: `knowledge-button${tertiary ? " is-tertiary" : ""}${!text ? " is-icon" : ""}`,
    });
    if (icon) knowledgeMapIcon(button, icon);
    if (text && icon) button.append(button.ownerDocument.createTextNode(text));
    button.onclick = async () => {
      if (button.disabled) return;
      try {
        const result = action();
        if (result instanceof Promise) {
          button.disabled = true;
          const pending = !button.classList.contains("knowledge-map-entry");
          if (pending) {
            applyAmicroButton(button, { variant: tertiary ? "tertiary" : "secondary" });
            setAmicroButtonPending(button, true);
          }
          try {
            await result;
          } finally {
            button.disabled = false;
            if (pending) setAmicroButtonPending(button, false);
          }
        }
      } catch (error) {
        new Notice(error instanceof Error ? error.message : String(error));
      }
    };
    return button;
  }

  update(
    domains: readonly KnowledgeMapDomain[],
    reminders: readonly KnowledgeSystemReminder[],
    inboxCount: number | null,
    error?: string,
  ): void {
    this.domains = domains;
    this.reminders = reminders;
    const signature = JSON.stringify([
      domains,
      reminders,
      inboxCount,
      error,
      this.plugin.settings.settingsLanguage,
    ]);
    if (signature === this.signature) {
      this.refreshActions();
      return;
    }
    this.signature = signature;
    if (!domains.some((domain) => domain.domain === this.selected))
      this.selected = domains[0]?.domain ?? "";
    this.renderReminders();
    this.reset(this.mapHost);
    const heading = this.mapHost.createDiv({ cls: "knowledge-heading" });
    heading.createEl("h2", { text: this.t("知识地图", "Knowledge map") });
    const summary = heading.createDiv({ cls: "knowledge-map-summary" });
    summary.createSpan({ cls: "knowledge-map-count",
      text: `${domains.reduce((sum, domain) => sum + domain.count, 0)} ${this.t("条", "notes")}` });
    const graph = this.button(summary, "",
      () => openObsidianGraphLeaf(this.plugin.app, this.plugin.settings.settingsLanguage), "globe");
    graph.setAttribute("aria-label", this.t("全库图谱", "Vault graph"));
    if (error) {
      const failure = this.mapHost.createDiv({ cls: "knowledge-error", attr: { role: "status" } });
      failure.createSpan({ text: error });
      this.button(failure, this.t("重试", "Retry"), this.refresh);
      return;
    }
    if (!domains.length) {
      this.toolbar = null;
      const empty = this.mapHost.createDiv({ cls: "knowledge-map-empty" });
      empty.createDiv({
        text: inboxCount
          ? this.t(
              `收件箱有 ${inboxCount} 份资料还没整理`,
              `${inboxCount} sources are waiting in Inbox`,
            )
          : this.t("还没有知识条目", "No knowledge notes yet"),
      });
      this.button(empty, this.t("开始整理", "Start organizing"), () =>
        prefillWorkbenchModule(
          this.plugin,
          "knowledge-base",
          this.t("帮我整理资料，建立知识库", "Help me organize sources into my knowledge base"),
        ),
      );
      return;
    }
    const map = this.mapHost.createDiv({ cls: "knowledge-map" });
    const navigation = map.createDiv({
      cls: "knowledge-map-domains",
      attr: { role: "group", "aria-label": this.t("领域", "Domains") },
    });
    const detail = map.createDiv({ cls: "knowledge-map-detail" });
    for (const domain of domains) {
      const button = this.button(navigation, "", () => {
        this.selected = domain.domain;
        for (const row of Array.from(navigation.querySelectorAll("button"))) {
          row.setAttribute("aria-pressed", String(row === button));
        }
        this.renderDetail(detail, domain);
      });
      button.className = "knowledge-button knowledge-map-domain";
      button.dataset.domain = domain.domain;
      button.setAttribute("aria-pressed", String(domain.domain === this.selected));
      button.createSpan({ text: domain.domain, cls: "knowledge-map-name" });
      button.createSpan({ text: String(domain.count), cls: "knowledge-map-count" });
    }
    this.renderDetail(detail, domains.find((domain) => domain.domain === this.selected)!);
  }

  refreshActions(): void {
    const domain = this.domains.find((domain) => domain.domain === this.selected);
    if (this.toolbar && domain) this.renderActions(this.toolbar, domain);
    this.renderReminders();
  }
  private task(domain: string) {
    return this.plugin
      .getKnowledgeSystemService()
      .list()
      .find((task) => task.domain === domain && !["completed", "deferred"].includes(task.phase));
  }
  private actionText(domain: KnowledgeMapDomain): string {
    const task = this.task(domain.domain);
    if (!task)
      return domain.mode === "tree"
        ? this.t("重新梳理", "Reorganize")
        : this.t("梳理体系", "Organize");
    if (task.phase === "awaiting-confirmation") return this.t("等你确认", "Awaiting confirmation");
    if (task.phase === "interrupted") return this.t("梳理已停下", "Paused");
    if (task.phase === "waiting-maintain") return this.t("等待维护", "Waiting for maintenance");
    return this.t("正在梳理", "Organizing");
  }
  private renderActions(host: HTMLElement, domain: KnowledgeMapDomain): void {
    this.reset(host);
    const graph = this.button(
      host,
      "",
      () =>
        openObsidianLocalGraphLeaf(
          this.plugin.app,
          domain.mapPath!,
          this.plugin.settings.settingsLanguage,
        ),
      "network",
    );
    graph.setAttribute("aria-label", this.t("查看领域图谱", "Open domain graph"));
    graph.disabled = !domain.mapPath;
    if (domain.mode === "tree" && domain.mapPath) {
      const map = this.button(host, "", () => this.openNote(domain.mapPath!), "file-text");
      map.setAttribute("aria-label", this.t("打开地图笔记", "Open map note"));
    }
    const task = this.task(domain.domain);
    const label = this.actionText(domain);
    const organize = this.button(
      host,
      task || domain.mode === "list" ? label : "",
      () => this.plugin.getKnowledgeSystemService().launch(domain.domain),
      task ? "message-circle" : domain.mode === "tree" ? "refresh-cw" : undefined,
    );
    organize.dataset.knowledgeAction = "organize";
    organize.setAttribute("aria-label", label);
  }
  private renderReminders(): void {
    this.reset(this.reminderHost);
    for (const reminder of this.reminders) {
      if (this.task(reminder.domain)) continue;
      const row = this.reminderHost.createDiv({ cls: "knowledge-map-reminder" });
      const icon = row.createSpan({ cls: "knowledge-map-icon", attr: { "aria-hidden": "true" } });
      setIcon(icon, "sparkles");
      row.createSpan({
        cls: "knowledge-map-reminder-copy",
        text: knowledgeSystemReminderText(reminder, this.plugin.settings.settingsLanguage === "en"),
      });
      const actions = row.createDiv({ cls: "knowledge-map-reminder-actions" });
      this.button(
        actions,
        this.t("先放着", "Later"),
        async () => {
          await this.plugin.getKnowledgeSystemService().deferReminder(reminder);
          await this.refresh();
        },
        undefined,
        true,
      );
      this.button(
        actions,
        reminder.mode === "tree"
          ? this.t("重新梳理", "Reorganize")
          : this.t("梳理体系", "Organize"),
        () => this.plugin.getKnowledgeSystemService().launch(reminder.domain),
      );
    }
  }
  private renderDetail(host: HTMLElement, domain: KnowledgeMapDomain): void {
    this.reset(host);
    const header = host.createDiv({ cls: "knowledge-map-detail-header" });
    header.createEl("h3", { text: domain.title || domain.domain });
    this.toolbar = header.createDiv({ cls: "knowledge-map-actions" });
    this.renderActions(this.toolbar, domain);
    const body = host.createDiv({ cls: "knowledge-map-body" });
    if (domain.indexing)
      body.createDiv({ cls: "knowledge-empty", text: this.t("索引还在读取…", "Reading index…") });
    for (const group of domain.groups) {
      const section = body.createDiv({ cls: "knowledge-map-group" });
      if (group.title === "待归位" && domain.mode === "tree") {
        section.addClass("knowledge-map-unplaced");
        section.createDiv({ cls: "knowledge-map-label", text: this.t("待归位", "Unplaced") });
        for (const entry of group.entries) {
          const row = section.createDiv({ cls: "knowledge-map-pending" });
          this.renderEntries(row, [entry]);
          if (entry.path && entry.suggestedBranch) {
            this.button(
              row,
              this.t(`放入 ${entry.suggestedBranch}`, `Place in ${entry.suggestedBranch}`),
              async () => {
                await this.plugin
                  .getKnowledgeSystemService()
                  .acceptPlacement(
                    domain.mapPath!,
                    domain.domain,
                    entry.path!,
                    entry.suggestedBranch!,
                  );
                await this.refresh();
              },
            );
          }
        }
        continue;
      }
      const key = `${domain.domain}\0${group.title}`;
      const branch = this.button(section, "", () => {
        const collapsed = !children.hidden;
        children.hidden = collapsed;
        branch.setAttribute("aria-expanded", String(!collapsed));
        if (collapsed) this.collapsed.add(key);
        else this.collapsed.delete(key);
      });
      branch.className = "knowledge-button knowledge-map-branch";
      branch.setAttribute("aria-expanded", String(!this.collapsed.has(key)));
      const chevron = branch.createSpan({
        cls: "knowledge-map-chevron",
        attr: { "aria-hidden": "true" },
      });
      setIcon(chevron, "chevron-right");
      branch.createSpan({ cls: "knowledge-map-name", text: group.title });
      const count = (entries: readonly KnowledgeMapEntry[]): number =>
        entries.reduce((sum, entry) => sum + 1 + count(entry.children), 0);
      branch.createSpan({ cls: "knowledge-map-count", text: String(count(group.entries)) });
      const children = section.createDiv({ cls: "knowledge-map-children" });
      children.hidden = this.collapsed.has(key);
      this.renderEntries(children, group.entries);
    }
    if (domain.gaps.length) {
      const gaps = body.createDiv({ cls: "knowledge-map-gaps" });
      gaps.createDiv({ cls: "knowledge-map-label", text: this.t("缺口", "Gaps") });
      for (const gap of domain.gaps) {
        const row = gaps.createDiv({ cls: "knowledge-map-gap" });
        const icon = row.createSpan({ cls: "knowledge-map-icon", attr: { "aria-hidden": "true" } });
        setIcon(icon, "circle-dashed");
        row.createSpan({ cls: "knowledge-map-name", text: gap });
        this.button(row, this.t("不再提示", "Dismiss"), async () => {
          await this.plugin
            .getKnowledgeSystemService()
            .rejectGap(domain.mapPath!, domain.domain, gap);
          await this.refresh();
        });
      }
    }
  }
  private renderEntries(host: HTMLElement, entries: readonly KnowledgeMapEntry[]): void {
    for (const entry of entries) {
      const row = this.button(host, "", () => this.openNote(entry.path!));
      row.className = "knowledge-button knowledge-map-entry";
      row.disabled = !entry.path;
      if (entry.path) row.dataset.path = entry.path;
      const icon = row.createSpan({ cls: "knowledge-map-icon", attr: { "aria-hidden": "true" } });
      setIcon(icon, "file-text");
      row.createSpan({ text: entry.title });
      if (entry.children.length)
        this.renderEntries(host.createDiv({ cls: "knowledge-map-children" }), entry.children);
    }
  }
  private async openNote(path: string): Promise<void> {
    const file = this.plugin.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile))
      throw new Error(this.t("笔记已移动，请刷新知识库", "The note moved; refresh Knowledge"));
    await this.plugin.app.workspace.getLeaf("tab").openFile(file);
  }
}
