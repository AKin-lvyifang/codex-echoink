import { Notice, setIcon } from "obsidian";
import type CodexForObsidianPlugin from "../main";
import { redactEchoInkLocalSecretsV1, REDACTED_SECRET } from "../harness/pi-native/vault-tool-result-safety";
import {
  isKnowledgeInitializationMarkdownPath,
  isKnowledgeInitializationRole,
  KNOWLEDGE_INITIALIZATION_ROOTS,
  knowledgeInitializationSourceDefaultRole,
  type KnowledgeBaseStructureRepairProgress,
  type KnowledgeBaseStructureSnapshot,
  type KnowledgeInitializationAssignment,
  type KnowledgeInitializationJob,
  type KnowledgeInitializationMode,
  type KnowledgeInitializationProviderSnapshot,
  type KnowledgeInitializationRole
} from "../knowledge-base/initializer";
import {
  buildKnowledgeInitializationProgress,
  type KnowledgeInitializationProgressStage
} from "../knowledge-base/initialization-progress";
import {
  deriveKnowledgeInitializationRecovery,
  type KnowledgeInitializationRecovery
} from "./knowledge-initialization-recovery";
import {
  apiProviderHasUsableCredential,
  getActiveApiProviderModel
} from "./settings";
import { attachSettingsTooltip, createSettingsSection, createSettingsState } from "./settings-v2";
import { KnowledgeNotePickerModal } from "./knowledge-note-picker-modal";
import { createOriginButton, disposeOriginControls } from "./origin-controls";
import {
  applyAmicroButton,
  applyParticleButton,
  triggerParticleButton
} from "./amicro-buttons";

type KnowledgeInitDirectoryRole = Exclude<KnowledgeInitializationRole, "keep">;

interface KnowledgeInitDirectoryDef {
  readonly role: KnowledgeInitDirectoryRole;
  readonly labelZh: string;
  readonly labelEn: string;
  readonly descriptionZh: string;
  readonly descriptionEn: string;
}

/**
 * 自定义分配的十个固定目录。前九个可分配 Markdown；assets 是附件目录，
 * 只展示、不参与笔记分配。
 */
export const KNOWLEDGE_INIT_DIRECTORIES: readonly KnowledgeInitDirectoryDef[] = Object.freeze([
  { role: "raw", labelZh: "Raw", labelEn: "Raw", descriptionZh: "现有原始文件和后续待提炼资料", descriptionEn: "Original files and new material waiting to be distilled" },
  { role: "wiki", labelZh: "Wiki", labelEn: "Wiki", descriptionZh: "AI 提炼后的长期知识与索引", descriptionEn: "Long-term knowledge and indexes distilled by AI" },
  { role: "projects", labelZh: "Projects", labelEn: "Projects", descriptionZh: "按项目组织的资料与知识", descriptionEn: "Notes and knowledge organized by project" },
  { role: "outputs", labelZh: "Outputs", labelEn: "Outputs", descriptionZh: "整理过程记录与生成结果", descriptionEn: "Processing records and generated results" },
  { role: "inbox", labelZh: "Inbox", labelEn: "Inbox", descriptionZh: "暂时还没分类的新笔记", descriptionEn: "New notes that have not been sorted yet" },
  { role: "journal", labelZh: "Journal", labelEn: "Journal", descriptionZh: "日记、复盘与时间记录", descriptionEn: "Journals, reviews, and time-based notes" },
  { role: "work", labelZh: "Work", labelEn: "Work", descriptionZh: "正在处理的工作资料", descriptionEn: "Active working material" },
  { role: "archive", labelZh: "Archive", labelEn: "Archive", descriptionZh: "已结束或暂时不用的内容", descriptionEn: "Completed or inactive material" },
  { role: "templates", labelZh: "Templates", labelEn: "Templates", descriptionZh: "可重复使用的笔记模板", descriptionEn: "Reusable note templates" }
]);

const FOCUS_KEY = "knowledge:initialize";

interface KnowledgeInitProgressRefs {
  readonly rootEl: HTMLElement;
  readonly statusEl: HTMLElement;
  readonly barEl: HTMLElement;
  readonly indicatorEl: HTMLElement;
  readonly percentEl: HTMLElement;
  readonly stepEl: HTMLElement;
  readonly countEl: HTMLElement;
  readonly stepsEl?: HTMLElement;
}

/**
 * 知识库初始化体验的唯一渲染入口。settings-tab.ts 只负责创建本类、
 * 调用 render() 并在 hide() 时 dispose()；全部初始化 UI 状态在这里维护。
 *
 * 普通主界面不暴露 revision/hash、冻结计划、Provider/model 快照、WAL、CAS、
 * Readback 等内部概念；它们只保留在后台 job 中。
 *
 * 渲染优先级：当前作业优先；没有待处理作业时，以实时 Vault 目录结构
 * 为准。settings 里的 initialized 只保留历史，不再决定当前状态。
 */
export class KnowledgeInitializationSection {
  private job: Readonly<KnowledgeInitializationJob> | null = null;
  private loaded = false;
  private loading = false;
  private loadGeneration = 0;
  private loadError = "";
  private busy = false;
  private customPreviewLoading = false;
  private selectedTab: KnowledgeInitializationMode = "recommended";
  private reselecting = false;
  private pollTimer: number | null = null;
  private pageEl: HTMLElement | null = null;
  private zh = true;
  private actionError = "";
  private actionErrorEl: HTMLElement | null = null;
  private structure: Readonly<KnowledgeBaseStructureSnapshot> | null = null;
  private structureRepairProgress: Readonly<KnowledgeBaseStructureRepairProgress> | null = null;
  private tabButtonEls: Record<KnowledgeInitializationMode, HTMLElement | null> = {
    recommended: null,
    custom: null
  };
  private tabBodyEl: HTMLElement | null = null;
  private assignmentsEl: HTMLElement | null = null;
  private expandedDirectories = new Set<KnowledgeInitDirectoryRole>();
  private directoryButtons = new Map<KnowledgeInitDirectoryRole, HTMLButtonElement>();
  private progressRefs: KnowledgeInitProgressRefs | null = null;

  constructor(
    private readonly plugin: CodexForObsidianPlugin,
    private readonly scheduleRender: () => void,
    private readonly openProviderSettings: () => void | Promise<void>
  ) {}

  get showDashboard(): boolean {
    return this.loaded && this.structure !== null
      && this.structure.state !== "uninitialized"
      && !this.reselecting
      && (!this.job || this.job.status === "initialized");
  }

  dispose(): void {
    if (this.pollTimer !== null) {
      window.clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    this.pageEl = null;
    this.progressRefs = null;
    this.actionErrorEl = null;
    this.invalidate();
  }

  /** 离开再进入知识库设置时强制重新读取真实 Vault 结构。 */
  invalidate(): void {
    this.loadGeneration += 1;
    this.loaded = false;
    this.loading = false;
    this.loadError = "";
    this.structure = null;
  }

  render(page: HTMLElement, zh: boolean): void {
    this.pageEl = page;
    this.zh = zh;
    this.progressRefs = null;
    this.actionErrorEl = null;
    const section = createSettingsSection(page, {
      surface: "flat"
    });
    const panel = section.createDiv({
      cls: "echoink-settings-feature-card echoink-knowledge-init-panel",
      // Stable tutorial anchor: unlike the initialization CTA, this remains in
      // the DOM after the knowledge base is already initialized.
      attr: { "data-echoink-focus-key": "knowledge:onboarding" }
    });
    if (!this.loaded && !this.loading && !this.loadError) void this.load();
    if (this.loading && !this.loaded) {
      panel.createDiv({
        cls: "echoink-knowledge-init-meta",
        text: zh ? "正在读取初始化状态…" : "Loading initialization state…"
      });
      return;
    }
    const job = this.job;
    if (this.loadError && !this.loaded) {
      createSettingsState(panel, this.loadError, "error", {
        label: zh ? "重试" : "Retry",
        onActivate: () => void this.load()
      });
      const rescan = createOriginButton(panel, { cls: "button echoink-knowledge-init-secondary", text: zh ? "重新扫描" : "Rescan", attr: { type: "button" } });
      rescan.onclick = () => void this.startRecommended();
      return;
    }
    // 用户动作失败提示：所有面板共用，成功或重新执行时清除。
    this.renderActionError(panel);
    if (this.structureRepairProgress) {
      this.renderStructureRepairProgress(panel, this.structureRepairProgress);
      return;
    }
    // 当前作业优先：运行中 > 重新选择方案 > 预览 > 可恢复态。
    if (job && job.status === "active") {
      this.renderProgressPanel(panel, job);
      this.schedulePoll();
      return;
    }
    if (this.reselecting) {
      this.renderTabsPanel(panel);
      return;
    }
    if (job && job.status === "preview") {
      this.renderTabsPanel(panel);
      return;
    }
    if (job && job.status !== "initialized") {
      this.renderPausedPanel(panel, job);
      return;
    }
    if (job?.status === "initialized") { this.renderDonePanel(panel); return; }
    const structure = this.structure;
    if (!structure) {
      createSettingsState(
        panel,
        zh ? "无法确认知识库目录状态，请重试。" : "Unable to verify the Knowledge folder structure. Try again.",
        "error",
        { label: zh ? "重试" : "Retry", onActivate: () => void this.load() }
      );
      return;
    }
    if (structure.state === "uninitialized") {
      this.renderTabsPanel(panel);
      return;
    }
    if (structure.state === "incomplete") {
      this.renderStructureWarningPanel(panel, structure);
      return;
    }
    this.renderDonePanel(panel);
  }

  // ---------------------------------------------------------------- loading

  private async load(): Promise<void> {
    const generation = ++this.loadGeneration;
    this.loading = true;
    this.loadError = "";
    try {
      const [job, structure] = await Promise.all([
        this.plugin.getEchoInkKnowledgeInitializationState(),
        this.plugin.getEchoInkKnowledgeBaseStructure()
      ]);
      if (generation !== this.loadGeneration) return;
      this.job = job;
      this.structure = structure;
      this.loaded = true;
      this.selectedTab = this.job?.mode === "custom"
        && this.job.status !== "initialized"
        ? "custom"
        : "recommended";
    } catch (error) {
      if (generation !== this.loadGeneration) return;
      this.loadError = `${this.zh ? "读取初始化状态失败，请重新扫描或重试" : "Unable to read initialization status; rescan or retry"}: ${this.errorTextForDisplay(error)}`;
    } finally {
      if (generation === this.loadGeneration) {
        this.loading = false;
        this.scheduleRender();
      }
    }
  }

  private async reloadAfterActionError(): Promise<void> {
    try {
      const [job, structure] = await Promise.all([
        this.plugin.getEchoInkKnowledgeInitializationState(),
        this.plugin.getEchoInkKnowledgeBaseStructure()
      ]);
      this.job = job;
      this.structure = structure;
      this.loaded = true;
    } catch {
      // 保留当前界面状态；由下一次渲染展示可重试的状态。
    }
  }

  // ------------------------------------------------------------ action errors

  /** 保留真实失败原因，复用本地凭据脱敏后再显示。 */
  private recordActionError(error: unknown, message?: string): void {
    const summary = message ?? (this.zh
      ? "操作没有完成，可以再试一次。"
      : "The action didn't complete. You can try again.");
    const detail = this.errorTextForDisplay(error);
    this.actionError = detail ? `${summary} ${detail}` : summary;
  }

  private errorTextForDisplay(error: unknown): string {
    let message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
    const credential = this.plugin.settings.openAICodexCredential;
    const secrets = [
      ...this.plugin.settings.apiProviders.map((provider) => provider.apiKey),
      credential?.access,
      credential?.refresh
    ].filter((value): value is string => typeof value === "string" && value.length > 0);
    for (const secret of secrets.sort((left, right) => right.length - left.length)) {
      message = message.split(secret).join(REDACTED_SECRET);
    }
    // 先完整脱敏，再压缩为设置页可读的一段文字，避免截断后漏出半截凭据。
    const redacted = redactEchoInkLocalSecretsV1(message).replaceAll("\u0000", " ").replace(/\s+/gu, " ").trim();
    return redacted;
  }

  private clearActionError(): void {
    this.actionError = "";
    if (this.actionErrorEl?.isConnected) this.actionErrorEl.remove();
    this.actionErrorEl = null;
  }

  private renderActionError(panel: HTMLElement): void {
    if (!this.actionError) return;
    const box = panel.createDiv({
      cls: "echoink-knowledge-init-action-error",
      attr: { role: "alert" }
    });
    this.actionErrorEl = box;
    box.createDiv({ cls: "echoink-knowledge-init-action-error-text", text: this.actionError });
  }

  /** 统一的动作包装：开始清错误、失败记错误并刷新状态、绝不静默。 */
  private async runAction(action: () => Promise<void>): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.clearActionError();
    try {
      await action();
    } catch (error) {
      this.recordActionError(error);
      await this.reloadAfterActionError();
    } finally {
      this.busy = false;
      this.scheduleRender();
    }
  }

  private renderStatusHeading(
    panel: HTMLElement,
    iconName: string,
    title: string,
    tone: "ready" | "warning" | "loading"
  ): void {
    const row = panel.createDiv({
      cls: `echoink-knowledge-init-status-heading is-init-${tone}`
    });
    const icon = row.createSpan({
      cls: "echoink-knowledge-init-status-icon",
      attr: { "aria-hidden": "true" }
    });
    setIcon(icon, iconName);
    row.createDiv({ cls: "echoink-knowledge-init-heading", text: title });
  }

  private mountProgress(
    panel: HTMLElement,
    data: Readonly<{
      percent: number;
      completed: number;
      total: number;
      status: string;
      step: string;
      ariaLabel: string;
    }>
  ): KnowledgeInitProgressRefs {
    const rootEl = panel.createDiv({ cls: "echoink-knowledge-init-progress" });
    const statusEl = rootEl.createDiv({
      cls: "echoink-knowledge-init-status",
      text: data.status,
      attr: { role: "status", "aria-live": "polite" }
    });
    const barRow = rootEl.createDiv({ cls: "echoink-knowledge-init-bar-row" });
    const barEl = barRow.createDiv({
      cls: "echoink-knowledge-init-bar",
      attr: {
        role: "progressbar",
        "aria-valuemin": "0",
        "aria-valuemax": "100",
        "aria-valuenow": String(data.percent),
        "aria-label": data.ariaLabel
      }
    });
    const indicatorEl = barEl.createDiv({
      cls: "echoink-knowledge-init-bar-indicator",
      attr: { "aria-hidden": "true" }
    });
    indicatorEl.style.setProperty(
      "--echoink-knowledge-init-progress",
      `${data.percent}%`
    );
    const percentEl = barRow.createSpan({
      cls: "echoink-knowledge-init-percent",
      text: `${data.percent}%`
    });
    panel.querySelector<HTMLElement>(".echoink-knowledge-init-status-heading")?.appendChild(percentEl);
    const stepEl = rootEl.createDiv({
      cls: "echoink-knowledge-init-step",
      text: data.step
    });
    const countEl = rootEl.createDiv({
      cls: "echoink-knowledge-init-count",
      text: data.total > 0 ? `${data.completed} / ${data.total}` : ""
    });
    return {
      rootEl,
      statusEl,
      barEl,
      indicatorEl,
      percentEl,
      stepEl,
      countEl
    };
  }

  // ------------------------------------------------------------------- tabs

  private renderTabsPanel(panel: HTMLElement): void {
    const zh = this.zh;
    panel.addClass("init-setup");
    const header = panel.createDiv({ cls: "settings-card-header" });
    const copy = header.createDiv();
    copy.createEl("h3", { text: zh ? "让现有笔记成为知识库" : "Turn your notes into a knowledge base" });
    copy.createEl("p", { text: zh ? "先安放原始资料，再提炼为可以持续积累的 Wiki。" : "Organize source material, then distill it into a growing Wiki." });
    header.createSpan({ cls: "settings-badge", text: zh ? "待初始化" : "Ready to initialize" });
    const tablist = panel.createDiv({
      cls: "echoink-knowledge-init-tabs",
      attr: {
        role: "tablist",
        "aria-label": zh ? "知识库初始化方案" : "Knowledge initialization plans"
      }
    });
    this.tabButtonEls = { recommended: null, custom: null };
    for (const mode of ["recommended", "custom"] as const) {
      const tab = tablist.createEl("button", {
        cls: "echoink-knowledge-init-tab",
        text: mode === "recommended"
          ? (zh ? "默认方案" : "Default plan")
          : (zh ? "自定义方案" : "Custom plan"),
        attr: {
          type: "button",
          role: "tab",
          id: `echoink-knowledge-init-tab-${mode}`,
          "aria-controls": "echoink-knowledge-init-tabpanel",
          "aria-selected": String(this.selectedTab === mode),
          tabindex: this.selectedTab === mode ? "0" : "-1"
        }
      });
      tab.onclick = () => this.selectTab(mode);
      tab.onkeydown = (event: KeyboardEvent) => this.handleTabKeydown(event, mode);
      this.tabButtonEls[mode] = tab;
    }
    this.tabBodyEl = panel.createDiv({
      cls: "echoink-knowledge-init-tabpanel",
      attr: {
        role: "tabpanel",
        id: "echoink-knowledge-init-tabpanel",
        "aria-labelledby": `echoink-knowledge-init-tab-${this.selectedTab}`
      }
    });
    this.renderTabBody();
    if (this.selectedTab === "custom") this.ensureCustomPreview();
  }

  private handleTabKeydown(
    event: KeyboardEvent,
    mode: KnowledgeInitializationMode
  ): void {
    // 两个 Tab：左右方向键切换并聚焦（roving tabindex，自动激活）。
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const next: KnowledgeInitializationMode =
      mode === "recommended" ? "custom" : "recommended";
    this.selectTab(next);
    this.tabButtonEls[next]?.focus();
  }

  private selectTab(mode: KnowledgeInitializationMode): void {
    if (this.selectedTab === mode) return;
    this.selectedTab = mode;
    for (const candidate of ["recommended", "custom"] as const) {
      const tab = this.tabButtonEls[candidate];
      if (!tab) continue;
      tab.setAttr("aria-selected", String(candidate === mode));
      tab.setAttr("tabindex", candidate === mode ? "0" : "-1");
    }
    this.tabBodyEl?.setAttr(
      "aria-labelledby",
      `echoink-knowledge-init-tab-${mode}`
    );
    // Tab 切换只替换同一面板主体，不移动文件、不调用 Provider。
    this.renderTabBody();
    if (mode === "custom") this.ensureCustomPreview();
  }

  private renderTabBody(): void {
    const body = this.tabBodyEl;
    if (!body) return;
    disposeOriginControls(body);
    body.empty();
    this.assignmentsEl = null;
    this.directoryButtons.clear();
    if (this.selectedTab === "recommended") this.renderRecommendedBody(body);
    else this.renderCustomBody(body);
  }

  // -------------------------------------------------------------- default tab

  private renderRecommendedBody(body: HTMLElement): void {
    const zh = this.zh;
    body.createEl("p", {
      cls: "echoink-knowledge-init-copy init-plan-description",
      text: zh
        ? "现有笔记与附件原样归入 Raw，保留原文和相对路径。Markdown 笔记由 AI 每批最多 20 篇提炼到 Wiki，没有可提炼内容时跳过。"
        : "Existing notes and attachments move into Raw unchanged, preserving their relative paths. AI distills Markdown into Wiki in batches of up to 20, skipping files with nothing to extract."
    });
    const route = body.createDiv({ cls: "init-route" });
    const stops = [
      ["files", zh ? "现有笔记与附件" : "Notes and attachments"],
      ["folders", zh ? "Raw · 原始资料" : "Raw · source material"],
      ["book-text", zh ? "Wiki · 提炼后的知识" : "Wiki · distilled knowledge"]
    ];
    stops.forEach(([icon, label], index) => {
      if (index) setIcon(route.createSpan({ cls: "init-route-arrow" }), "arrow-right");
      const stop = route.createSpan({ cls: index === 2 ? "init-route-destination" : "" });
      setIcon(stop.createSpan(), icon); stop.createSpan({ text: label });
    });
    this.renderFolderChips(body);
    const actions = this.renderInitializationFooter(body);
    const cta = actions.createEl("button", {
      cls: "mod-cta echoink-knowledge-init-cta",
      text: zh ? "开始初始化" : "Start initialization",
      attr: { type: "button", "data-echoink-focus-key": FOCUS_KEY }
    });
    applyAmicroButton(cta, { variant: "primary", motion: "complete" });
    cta.disabled = this.busy;
    cta.onclick = () => void this.startRecommended();
  }

  private renderFolderChips(body: HTMLElement): void {
    const folders = body.createDiv({ cls: "init-folders" });
    folders.createSpan({ text: this.zh ? "将建立的目录" : "Folders to create" });
    const chips = folders.createDiv();
    const addChip = (name: string, description: string, role: string) => {
      const chip = chips.createSpan({ cls: "init-folder-chip", attr: {
        tabindex: "0", "data-echoink-focus-key": `knowledge:init-folder:${role}`
      } });
      setIcon(chip.createSpan(), "folders"); chip.createSpan({ text: name });
      attachSettingsTooltip(chip, description);
    };
    for (const directory of KNOWLEDGE_INIT_DIRECTORIES) {
      addChip(directory.labelEn, this.zh ? directory.descriptionZh : directory.descriptionEn, directory.role);
    }
    addChip("Assets", this.zh ? "知识库后续使用的图片、PDF 等附件" : "Images, PDFs, and other attachments used by the knowledge base", "assets");
  }

  private renderInitializationFooter(body: HTMLElement): HTMLElement {
    const footer = body.createDiv({ cls: "init-bottom" });
    const items = this.job?.items;
    const markdown = items?.filter((item) => isKnowledgeInitializationMarkdownPath(item.sourcePath)).length ?? 0;
    const copy = footer.createSpan({ text: items
      ? (this.zh ? `${markdown} 篇 Markdown · ${items.length - markdown} 个其他文件` : `${markdown} Markdown · ${items.length - markdown} other files`)
      : (this.zh ? "开始时将扫描现有资料" : "Existing material is scanned when you start") });
    const model = this.currentProviderSnapshot()?.model;
    copy.createSpan({ text: model ? (this.zh ? `当前模型：${model}` : `Current model: ${model}`)
      : (this.zh ? "提炼知识需要可用模型" : "Knowledge extraction requires an available model") });
    return footer.createDiv({ cls: "echoink-knowledge-init-actions" });
  }

  private async startRecommended(): Promise<void> {
    this.reselecting = false;
    await this.runAction(async () => {
      // 单次明确确认：UI 内部依次生成推荐 preview 并立即确认执行。
      this.job = await this.plugin.startEchoInkKnowledgeInitialization("recommended");
      this.job = await this.plugin.confirmEchoInkKnowledgeInitialization();
      this.loaded = true;
    });
  }

  // --------------------------------------------------------------- custom tab

  private renderCustomBody(body: HTMLElement): void {
    const zh = this.zh;
    if (this.customPreviewLoading) {
      body.createDiv({
        cls: "echoink-knowledge-init-meta",
        text: zh ? "正在扫描可分配的笔记…" : "Scanning assignable notes…"
      });
      return;
    }
    const job = this.job;
    if (!job || job.mode !== "custom" || job.status !== "preview") {
      body.createDiv({
        cls: "echoink-knowledge-init-meta",
        text: zh ? "正在准备自定义分配…" : "Preparing custom assignments…"
      });
      return;
    }
    body.createDiv({
      cls: "echoink-knowledge-init-copy",
      text: zh
        ? "你可以把 Markdown 笔记分配到指定目录。未指定的笔记和普通附件会按原路径归入 Raw。"
        : "Assign Markdown notes to specific folders. Unassigned notes and ordinary attachments move into Raw while keeping their original paths."
    });
    const conflicts = job.items.filter((item) => item.state === "conflict").length;
    if (conflicts > 0) {
      const warning = body.createDiv({ cls: "echoink-knowledge-init-warning" });
      const icon = warning.createSpan({ cls: "echoink-knowledge-init-warning-icon" });
      setIcon(icon, "alert-triangle");
      icon.setAttr("aria-hidden", "true");
      warning.createSpan({
        cls: "echoink-knowledge-init-warning-text",
        text: zh
          ? `有 ${conflicts} 个文件的目标位置已存在内容，需要先处理这些冲突。`
          : `${conflicts} files already have content at their target paths; resolve these conflicts first.`
      });
    }
    this.assignmentsEl = body.createDiv({ cls: "echoink-knowledge-init-custom directory-planner" });
    this.renderAssignments();
    const actions = this.renderInitializationFooter(body);
    const cta = actions.createEl("button", {
      cls: "mod-cta echoink-knowledge-init-cta",
      text: zh ? "开始初始化" : "Start initialization",
      attr: { type: "button", "data-echoink-focus-key": FOCUS_KEY }
    });
    applyAmicroButton(cta, { variant: "primary", motion: "complete" });
    cta.disabled = this.busy;
    cta.onclick = () => void this.confirmCustom();
  }

  private ensureCustomPreview(): void {
    const job = this.job;
    if (job?.mode === "custom" && job.status === "preview") return;
    if (this.busy || this.customPreviewLoading) return;
    void this.generateCustomPreview();
  }

  private async generateCustomPreview(): Promise<void> {
    // 本地扫描并持久化 preview；不移动文件、不调用 Provider。
    this.customPreviewLoading = true;
    this.renderTabBody();
    try {
      this.job = await this.plugin.startEchoInkKnowledgeInitialization("custom");
      this.loaded = true;
      this.clearActionError();
    } catch (error) {
      this.recordActionError(error);
      await this.reloadAfterActionError();
    } finally {
      this.customPreviewLoading = false;
      this.scheduleRender();
    }
  }

  private async confirmCustom(): Promise<void> {
    this.reselecting = false;
    await this.runAction(async () => {
      this.job = await this.plugin.confirmEchoInkKnowledgeInitialization();
      this.loaded = true;
    });
  }

  // ---------------------------------------------------- directory assignments

  private renderAssignments(): void {
    const container = this.assignmentsEl;
    const job = this.job;
    if (!container || !job) return;
    const zh = this.zh;
    disposeOriginControls(container);
    container.empty();
    this.directoryButtons.clear();
    const descriptions = zh
      ? ["原始资料", "长期知识", "项目资料", "生成结果", "待分类", "日记与复盘", "工作资料", "归档", "笔记模板"]
      : ["Source material", "Knowledge", "Project material", "Generated results", "Unsorted", "Journals and reviews", "Work material", "Archive", "Note templates"];
    const notes = job.items.filter(item => isKnowledgeInitializationMarkdownPath(item.sourcePath));
    const list = container.createDiv({ cls: "directory-plan" });
    const heading = list.createDiv({ cls: "directory-plan-heading", attr: { "aria-hidden": "true" } });
    for (const label of zh ? ["目录", "已分配", "操作"] : ["Folder", "Assigned", "Actions"]) heading.createSpan({ text: label });
    KNOWLEDGE_INIT_DIRECTORIES.forEach((directory, index) => {
      const role = directory.role;
      const assigned = notes.filter(note => note.role === role);
      const description = zh ? directory.descriptionZh : directory.descriptionEn;
      const section = list.createEl("section", { cls: "directory-item" });
      const row = section.createDiv({ cls: "directory-row" });
      const toggle = row.createEl("button", { cls: "directory-reveal", attr: {
        type: "button", "data-directory-toggle": role,
        "aria-expanded": String(this.expandedDirectories.has(role)),
        "aria-controls": `echoink-directory-${role}`
      } });
      setIcon(toggle.createSpan({ cls: "directory-chevron", attr: { "aria-hidden": "true" } }), "chevron-right");
      setIcon(toggle.createSpan({ cls: "directory-icon", attr: { "aria-hidden": "true" } }), "folders");
      const name = toggle.createSpan({ cls: "directory-name", text: directory.labelEn });
      name.createEl("small", { text: descriptions[index] });
      attachSettingsTooltip(toggle, description);
      const count = row.createSpan({ cls: "directory-count", text: String(assigned.length), attr: {
        "aria-label": zh ? `${directory.labelEn} 已分配 ${assigned.length} 篇` : `${assigned.length} notes assigned to ${directory.labelEn}`
      } });
      count.setAttr("data-directory-count", role);
      const add = createOriginButton(row, { cls: "button directory-add", attr: {
        type: "button", "data-directory-add": role,
        "data-echoink-focus-key": `knowledge:init-add:${role}`,
        "aria-label": role === "raw"
          ? (zh ? "把其他目录的笔记移回 Raw" : "Move notes back to Raw")
          : (zh ? `添加笔记到 ${directory.labelEn}` : `Add notes to ${directory.labelEn}`)
      } });
      setIcon(add.createSpan({ attr: { "aria-hidden": "true" } }), role === "raw" ? "history" : "plus");
      add.createSpan({ text: role === "raw" ? (zh ? "移回 Raw" : "Move to Raw") : (zh ? "添加笔记" : "Add notes") });
      add.disabled = this.busy;
      add.onclick = () => void this.openNotePicker(role, add);
      this.directoryButtons.set(role, add);
      const assignedList = section.createDiv({ cls: "directory-notes", attr: { id: `echoink-directory-${role}` } });
      assignedList.hidden = !this.expandedDirectories.has(role);
      // Expand in place: keep pointer/keyboard focus and the other lists' scroll positions.
      toggle.onclick = () => {
        assignedList.hidden = !assignedList.hidden;
        if (assignedList.hidden) this.expandedDirectories.delete(role);
        else this.expandedDirectories.add(role);
        toggle.setAttr("aria-expanded", String(!assignedList.hidden));
      };
      assignedList.createEl("p", { cls: "directory-purpose", text: description });
      if (!assigned.length) assignedList.createEl("p", { cls: "directory-none", text: zh
        ? (role === "raw" ? "还没有归入 Raw 的笔记。" : "还没有分配笔记，点击右侧「添加笔记」。")
        : (role === "raw" ? "No notes are assigned to Raw yet." : "No notes assigned yet. Use Add notes to choose some.") });
      for (const note of assigned) {
        const noteRow = assignedList.createDiv();
        setIcon(noteRow.createSpan({ cls: "directory-file-icon", attr: { "aria-hidden": "true" } }), "file-text");
        noteRow.createSpan({ cls: "directory-note-path", text: note.sourcePath });
        if (role !== "raw") {
          const remove = noteRow.createEl("button", { cls: "icon-button", attr: {
            type: "button", "data-directory-remove": note.sourcePath,
            "aria-label": zh ? `将 ${note.sourcePath} 移回 Raw` : `Move ${note.sourcePath} back to Raw`
          } });
          setIcon(remove, "x");
          remove.disabled = this.busy;
          remove.onclick = () => void this.applyAssignments([{ sourcePath: note.sourcePath, role: "raw" }], role);
        }
      }
    });
    const attachments = list.createDiv({ cls: "directory-attachments" });
    setIcon(attachments.createSpan({ attr: { "aria-hidden": "true" } }), "folders");
    attachments.createEl("strong", { text: "Assets" });
    attachments.createSpan({ text: zh ? "附件目录" : "Attachments" });
    const help = attachments.createEl("button", { cls: "settings-help", text: "?", attr: {
      type: "button", "aria-label": zh ? "附件如何安放" : "How attachments are organized"
    } });
    attachSettingsTooltip(help, zh
      ? "普通附件会随原始笔记归入 Raw，保留相对路径。Assets 用于后续生成或导入的附件。"
      : "Ordinary attachments stay with original notes in Raw, preserving relative paths. Assets holds attachments generated or imported later.");
    const summary = container.createDiv({ cls: "directory-summary" });
    setIcon(summary.createSpan({ attr: { "aria-hidden": "true" } }), "circle-help");
    summary.createSpan({ text: zh
      ? "未分配的笔记留在 Raw；这里只调整预览，开始初始化后才整理文件。"
      : "Unassigned notes stay in Raw. These changes only update the preview; files are organized when you start initialization." });
    const kept = notes.filter(note => note.role === "keep").length;
    if (kept) container.createEl("p", { cls: "directory-summary", text: zh
      ? `${kept} 篇笔记按已有计划保留原位置。` : `${kept} notes keep their original locations under the existing plan.` });
  }

  private async openNotePicker(role: KnowledgeInitDirectoryRole, triggerEl: HTMLElement): Promise<void> {
    // Rescan through the existing preview service; preserve earlier assignments.
    // Neither scanning nor choosing notes moves files or calls a Provider.
    if (!await this.rebuildCustomPreviewPreservingAssignments()) return;
    if (!this.pageEl?.isConnected || this.selectedTab !== "custom") return;
    if (this.assignmentsEl?.isConnected) this.renderTabBody();
    const job = this.job;
    if (!job) return;
    const modal = new KnowledgeNotePickerModal(this.plugin.app, {
      zh: this.zh, targetRole: role, targetLabel: this.dirLabel(role),
      notes: job.items.filter(item => item.role !== "keep" && isKnowledgeInitializationMarkdownPath(item.sourcePath))
        .map(item => ({ sourcePath: item.sourcePath, role: item.role })),
      triggerEl: this.directoryButtons.get(role) ?? triggerEl,
      restoreFocus: () => this.focusDirectoryButton(role),
      onConfirm: assignments => this.applyAssignments(assignments, role, true)
    });
    modal.open();
  }

  private focusDirectoryButton(role: KnowledgeInitDirectoryRole): void {
    const button = this.directoryButtons.get(role);
    if (button?.isConnected) button.focus({ preventScroll: true });
  }

  private async applyAssignments(
    assignments: readonly KnowledgeInitializationAssignment[],
    focusRole: KnowledgeInitDirectoryRole,
    rethrow = false
  ): Promise<void> {
    if (this.busy || assignments.length === 0) return;
    this.busy = true;
    this.clearActionError();
    this.assignmentsEl?.querySelectorAll<HTMLButtonElement>("button").forEach(button => { button.disabled = true; });
    try {
      this.job = await this.plugin.assignManyEchoInkKnowledgeInitializationNotes(assignments);
      this.loaded = true;
      this.busy = false;
      if (this.assignmentsEl?.isConnected) {
        this.renderAssignments();
        this.focusDirectoryButton(focusRole);
      } else this.scheduleRender();
    } catch (error) {
      this.recordActionError(error);
      await this.reloadAfterActionError();
      this.scheduleRender();
      if (rethrow) throw error;
    } finally {
      this.busy = false;
    }
  }

  // -------------------------------------------------------- structure recovery

  private renderStructureWarningPanel(
    panel: HTMLElement,
    structure: Readonly<KnowledgeBaseStructureSnapshot>
  ): void {
    const zh = this.zh;
    this.renderStatusHeading(
      panel,
      "alert-triangle",
      zh ? "知识库文件夹结构不完整" : "Knowledge folders need attention",
      "warning"
    );
    panel.createDiv({
      cls: "echoink-knowledge-init-copy",
      text: zh
        ? "EchoInk 需要完整的固定目录来存放原始笔记、Wiki 和附件。目录缺失时，整理和提炼功能可能无法正常工作。"
        : "EchoInk needs the complete fixed folder structure for original notes, Wiki content, and attachments. Missing folders can interrupt organization and distillation."
    });
    if (structure.missingRoots.length > 0) {
      panel.createDiv({
        cls: "echoink-knowledge-init-structure-detail",
        text: zh
          ? `缺少目录：${structure.missingRoots.join("、")}`
          : `Missing folders: ${structure.missingRoots.join(", ")}`
      });
    }
    if (structure.conflictingRoots.length > 0) {
      const warning = panel.createDiv({ cls: "echoink-knowledge-init-warning" });
      const icon = warning.createSpan({ cls: "echoink-knowledge-init-warning-icon" });
      setIcon(icon, "alert-triangle");
      icon.setAttr("aria-hidden", "true");
      warning.createSpan({
        cls: "echoink-knowledge-init-warning-text",
        text: zh
          ? `这些路径已被同名文件占用：${structure.conflictingRoots.join("、")}。EchoInk 不会覆盖或移动它们，请先重命名这些文件。`
          : `These paths are occupied by files: ${structure.conflictingRoots.join(", ")}. EchoInk will not overwrite or move them; rename those files first.`
      });
    }
    panel.createDiv({
      cls: "echoink-knowledge-init-plan-copy",
      text: zh
        ? "补建缺少的文件夹和速记模板，补齐原生日记与模板设置；保留已有笔记、用户模板和自定义配置，无需模型。"
        : "Create missing folders and the quick journal template, and complete Daily notes and Templates settings. Existing notes, templates, and custom settings are preserved. No model is needed."
    });
    const actions = panel.createDiv({ cls: "echoink-knowledge-init-actions" });
    const restore = actions.createEl("button", {
      cls: "mod-cta echoink-knowledge-init-cta",
      text: structure.missingRoots.length > 0
        ? (zh ? "恢复文件夹体系" : "Restore folder structure")
        : (zh ? "重新检查" : "Check again"),
      attr: { type: "button", "data-echoink-focus-key": FOCUS_KEY }
    });
    applyAmicroButton(restore, { variant: "primary", motion: "complete" });
    restore.disabled = this.busy;
    restore.onclick = () => void this.restoreStructure();
  }

  private async restoreStructure(): Promise<void> {
    if (this.busy) return;
    const generation = this.loadGeneration;
    this.busy = true;
    this.clearActionError();
    const total = Math.max(1,
      (this.structure?.existingRoots.length ?? 0)
      + (this.structure?.missingRoots.length ?? 0)
      + (this.structure?.conflictingRoots.length ?? 0));
    this.structureRepairProgress = Object.freeze({
      completed: 0,
      total,
      percent: 0,
      currentRoot: null
    });
    this.scheduleRender();
    try {
      const result = await this.plugin.restoreEchoInkKnowledgeBaseStructure((progress) => {
        if (generation !== this.loadGeneration) return;
        this.structureRepairProgress = progress;
        this.scheduleRender();
      });
      if (generation !== this.loadGeneration) return;
      this.structure = result.structure;
      this.loaded = true;
      if (result.warnings?.length) {
        this.recordActionError(new Error(result.warnings.join("\n")), this.zh ? "可用项目已补齐，以下项目仍需处理。" : "Available items were repaired; the following still need attention.");
      } else {
        new Notice(this.zh ? "日记与模板设置已补齐，已有自定义配置已保留。" : "Journal and template settings are ready. Existing custom settings were preserved.");
      }
    } catch (error) {
      if (generation !== this.loadGeneration) return;
      this.recordActionError(
        error,
        this.zh
          ? "文件夹、日记或模板设置未补齐。请检查原生插件与 Vault 是否可用后重试。"
          : "Folder, journal, or template setup is incomplete. Check the core plugins and Vault, then try again."
      );
      await this.reloadAfterActionError();
    } finally {
      this.structureRepairProgress = null;
      this.busy = false;
      if (generation === this.loadGeneration) this.scheduleRender();
    }
  }

  private renderStructureRepairProgress(
    panel: HTMLElement,
    progress: Readonly<KnowledgeBaseStructureRepairProgress>
  ): void {
    const zh = this.zh;
    panel.addClass("init-progress");
    this.renderStatusHeading(
      panel,
      "loader-circle",
      zh ? "正在恢复文件夹体系" : "Restoring folder structure",
      "loading"
    );
    panel.createDiv({
      cls: "echoink-knowledge-init-plan-copy",
      text: zh
        ? "正在检查并补齐固定目录；现有笔记保持原样。"
        : "Checking and restoring fixed folders; existing notes remain unchanged."
    });
    const current = progress.currentRoot
      ? (zh ? `正在处理 ${progress.currentRoot}` : `Checking ${progress.currentRoot}`)
      : (zh ? "准备检查目录" : "Preparing to check folders");
    this.progressRefs = this.mountProgress(panel, {
      percent: progress.percent,
      completed: progress.completed,
      total: progress.total,
      status: zh
        ? `恢复文件夹体系 · ${progress.completed} / ${progress.total} · ${progress.percent}%`
        : `Restoring folders · ${progress.completed} / ${progress.total} · ${progress.percent}%`,
      step: current,
      ariaLabel: zh ? "文件夹恢复进度" : "Folder recovery progress"
    });
  }

  // ---------------------------------------------------------------- progress

  private renderProgressPanel(
    panel: HTMLElement,
    job: Readonly<KnowledgeInitializationJob>
  ): void {
    const zh = this.zh;
    this.renderStatusHeading(
      panel,
      "loader-circle",
      zh ? "正在初始化知识库" : "Initializing your knowledge base",
      "loading"
    );
    // 进度只来自真实 job 字段；运行中不会出现 100%（完成即切换完成态）。
    const progress = buildKnowledgeInitializationProgress(job, false);
    const step = progressStepLabel(progress.stage, zh);
    this.progressRefs = this.mountProgress(panel, {
      percent: progress.percent,
      completed: progress.completed,
      total: progress.total,
      status: progressStatusSentence(progress.stage, progress, zh),
      step,
      ariaLabel: zh ? "初始化进度" : "Initialization progress"
    });
    const stepsEl = panel.createEl("ol", { cls: "echoink-knowledge-init-steps" });
    this.renderProgressSteps(stepsEl, progress.stage);
    this.progressRefs = { ...this.progressRefs, stepsEl };
    const actions = this.renderInitializationFooter(panel);
    const pause = actions.createEl("button", {
      cls: "echoink-knowledge-init-secondary",
      text: zh ? "暂停初始化" : "Pause initialization",
      attr: { type: "button" }
    });
    pause.onclick = () => void this.pauseRun();
  }

  private async pollTick(): Promise<void> {
    this.pollTimer = null;
    const page = this.pageEl;
    if (!page || !page.isConnected) return;
    if (this.plugin.settings.settingsTab !== "knowledgeBase") return;
    try {
      const job = await this.plugin.getEchoInkKnowledgeInitializationState();
      const structure = job?.status === "active"
        ? this.structure
        : await this.plugin.getEchoInkKnowledgeBaseStructure();
      this.job = job;
      this.structure = structure;
      this.loaded = true;
    } catch (error) {
      this.recordActionError(error, this.zh ? "进度暂未更新，请重试。" : "Progress could not be refreshed. Please retry.");
      this.scheduleRender();
      this.schedulePoll();
      return;
    }
    if (this.job?.status === "active" && this.updateProgressInPlace()) {
      this.schedulePoll();
      return;
    }
    this.scheduleRender();
  }

  private updateProgressInPlace(): boolean {
    const refs = this.progressRefs;
    if (!refs || !refs.rootEl.isConnected || !this.job) return false;
    const progress = buildKnowledgeInitializationProgress(this.job, false);
    refs.barEl.setAttr("aria-valuenow", String(progress.percent));
    refs.indicatorEl.style.setProperty(
      "--echoink-knowledge-init-progress",
      `${progress.percent}%`
    );
    refs.percentEl.setText(`${progress.percent}%`);
    refs.stepEl.setText(progressStepLabel(progress.stage, this.zh));
    refs.countEl.setText(progress.total > 0 ? `${progress.completed} / ${progress.total}` : "");
    refs.statusEl.setText(progressStatusSentence(progress.stage, progress, this.zh));
    if (refs.stepsEl) this.renderProgressSteps(refs.stepsEl, progress.stage);
    return true;
  }

  private renderProgressSteps(container: HTMLElement, stage: KnowledgeInitializationProgressStage): void {
    container.empty();
    const stages: KnowledgeInitializationProgressStage[] = ["directories", "moving", "extracting", "guide", "done"];
    const active = stages.indexOf(stage);
    [this.zh ? "建立目录" : "Create folders", this.zh ? "安放资料" : "Place sources", this.zh ? "提炼知识" : "Distill knowledge", this.zh ? "生成索引" : "Create indexes"].forEach((label, index) => {
      const complete = active > index;
      const item = container.createEl("li", { cls: complete ? "complete" : "", attr: active === index ? { "aria-current": "step" } : undefined });
      const marker = item.createEl("b");
      if (complete) setIcon(marker, "check"); else marker.setText(String(index + 1));
      item.createSpan({ text: label });
    });
  }

  private schedulePoll(): void {
    if (this.pollTimer !== null) return;
    if (this.job?.status !== "active") return;
    this.pollTimer = window.setTimeout(() => void this.pollTick(), 750);
  }

  private async pauseRun(): Promise<void> {
    await this.runAction(async () => {
      // 复用现有 cancel API；后台 cancelled 状态仍可通过「继续初始化」恢复。
      this.job = await this.plugin.cancelEchoInkKnowledgeInitialization();
      this.loaded = true;
    });
  }

  // -------------------------------------------------------------- paused/error

  private renderPausedPanel(
    panel: HTMLElement,
    job: Readonly<KnowledgeInitializationJob>
  ): void {
    const zh = this.zh;
    panel.addClass("echoink-knowledge-init-recovery");
    // 恢复方式完全由结构化字段派生（status / 两个 digest / Provider 快照），
    // 不解析 lastError 中文字符串。
    const recovery = deriveKnowledgeInitializationRecovery({
      job,
      currentProvider: this.currentProviderSnapshot()
    });
    const needsProviderSetup = this.recoveryNeedsProviderSetup(recovery, job);
    const stoppedWithoutCompletion = job.status === "failed_recoverable"
      || job.status === "write_uncertain";
    const heading = panel.createDiv({ cls: "echoink-knowledge-init-recovery-heading" });
    const icon = heading.createSpan({ cls: "echoink-knowledge-init-pause-icon" });
    setIcon(icon, "alert-triangle");
    icon.setAttr("aria-hidden", "true");
    heading.createDiv({
      cls: "echoink-knowledge-init-heading",
      text: recovery.kind === "recheck-conflict"
        ? (zh ? "初始化遇到冲突" : "Initialization hit a conflict")
        : stoppedWithoutCompletion
          ? (zh ? "初始化没有完成" : "Initialization did not finish")
          : (zh ? "初始化已暂停" : "Initialization paused")
    });
    const notice = panel.createDiv({ cls: "echoink-knowledge-init-pause" });
    const pauseText = notice.createDiv({ cls: "echoink-knowledge-init-pause-text" });
    const pauseDetails = pauseText.createDiv({
      cls: "echoink-knowledge-init-pause-details",
      attr: { role: "status", "aria-live": "polite" }
    });
    const details = [
      {
        label: stoppedWithoutCompletion
          ? (zh ? "失败原因" : "What stopped")
          : (zh ? "暂停原因" : "Why it paused"),
        value: this.pauseReasonText(recovery, job, zh, needsProviderSetup)
      },
      {
        label: zh ? "已完成" : "Completed",
        value: this.pauseCompletedText(job, zh)
      },
      {
        label: zh ? "下一步" : "Next step",
        value: this.pauseNextStepText(recovery, job, zh, needsProviderSetup)
      }
    ];
    for (const detail of details) {
      const detailRow = pauseDetails.createDiv({
        cls: "echoink-knowledge-init-pause-detail"
      });
      detailRow.createDiv({
        cls: "echoink-knowledge-init-pause-label",
        text: detail.label
      });
      detailRow.createDiv({
        cls: "echoink-knowledge-init-pause-value",
        text: detail.value
      });
    }
    if (needsProviderSetup) {
      const providerLink = pauseText.createEl("button", {
        cls: "echoink-knowledge-init-provider-link",
        text: zh ? "去设置 API Provider" : "Set up API Provider",
        attr: { type: "button" }
      });
      providerLink.onclick = () => void this.openProviderSettings();
    }
    const actions = panel.createDiv({ cls: "echoink-knowledge-init-actions" });
    if (recovery.kind === "recheck-conflict") {
      // blocked_conflict：禁止展示必然失败的「继续初始化」。
      const recheck = actions.createEl("button", {
        cls: "mod-cta echoink-knowledge-init-cta",
        text: zh ? "重新检查冲突" : "Recheck conflicts",
        attr: { type: "button", "data-echoink-focus-key": FOCUS_KEY }
      });
      recheck.onclick = () => void this.recheckConflict();
      const reselect = actions.createEl("button", {
        cls: "echoink-knowledge-init-secondary",
        text: job.mode === "custom"
          ? (zh ? "修改分配" : "Edit assignments")
          : (zh ? "重新选择方案" : "Choose a different plan"),
        attr: { type: "button" }
      });
      reselect.onclick = () => {
        if (job.mode === "custom") {
          void this.rescanCustomPreservingAssignments();
          return;
        }
        this.enterPlanSelection();
      };
    } else if (recovery.kind === "recheck-preview") {
      // 文件计划未确认或已变化时重新预览；模型切换不作废文件计划。
      const recheck = actions.createEl("button", {
        cls: "mod-cta echoink-knowledge-init-cta",
        text: zh ? "重新检查并继续" : "Recheck and continue",
        attr: { type: "button", "data-echoink-focus-key": FOCUS_KEY }
      });
      applyParticleButton(recheck, "refresh-cw");
      recheck.onclick = () => {
        triggerParticleButton(recheck);
        void this.recheckPreviewAndContinue();
      };
      // 保留「重新选择方案」出口：计划已失效时用户也可以直接回到方案选择。
      const reselect = actions.createEl("button", {
        cls: "echoink-knowledge-init-secondary",
        text: zh ? "重新选择方案" : "Choose a different plan",
        attr: { type: "button" }
      });
      reselect.onclick = () => this.enterPlanSelection();
    } else {
      const resume = actions.createEl("button", {
        cls: "mod-cta echoink-knowledge-init-cta",
        text: zh ? "继续初始化" : "Continue initialization",
        attr: { type: "button", "data-echoink-focus-key": FOCUS_KEY }
      });
      resume.onclick = () => void this.resumeRun();
      const reselect = actions.createEl("button", {
        cls: "echoink-knowledge-init-secondary",
        text: zh ? "重新选择方案" : "Choose a different plan",
        attr: { type: "button" }
      });
      reselect.onclick = () => this.enterPlanSelection();
    }
  }

  private pauseReasonText(
    recovery: KnowledgeInitializationRecovery,
    job: Readonly<KnowledgeInitializationJob>,
    zh: boolean,
    needsProviderSetup = this.recoveryNeedsProviderSetup(recovery, job)
  ): string {
    const detail = this.errorTextForDisplay(job.lastError);
    if (detail) return detail;
    if (recovery.kind === "recheck-conflict") {
      return zh
        ? "有文件的目标位置已存在内容。EchoInk 已停止移动，避免覆盖原文件。"
        : "Some target paths already contain files. EchoInk stopped before moving anything there so the existing files are not overwritten.";
    }
    if (recovery.kind === "recheck-preview") {
      // 作业快照本身没有 Provider（创建时就没配）且还有待提炼内容：
      // 直接说「先设置模型」，而不是「模型已变化」。
      if (needsProviderSetup) {
        return zh
          ? "当前没有可用的 API Provider，因此 AI 还不能提炼 Raw 笔记。"
          : "No API Provider is currently available, so AI cannot distill the Raw notes yet.";
      }
      return zh
        ? "文件计划在确认后发生了变化，EchoInk 已停止使用旧计划。"
        : "The file plan changed after confirmation, so EchoInk stopped using the old plan.";
    }
    if (job.status === "cancelled") {
      return zh ? "你暂停了这次初始化。" : "You paused this initialization.";
    }
    if (job.status === "write_uncertain") {
      return zh
        ? "上一步的文件写入结果还无法确认，EchoInk 已停止后续操作，避免重复写入。"
        : "The previous file write could not be verified, so EchoInk stopped to avoid writing it twice.";
    }
    if (job.phase === "create_directories") {
      return zh
        ? "有固定目录未能创建或被同名文件占用。"
        : "A required folder could not be created or its path is occupied by a file.";
    }
    if (job.phase === "move_notes") {
      return zh
        ? "有文件未能安全归入 Raw。EchoInk 已停止，不会覆盖原文件。"
        : "A file could not be moved safely into Raw. EchoInk stopped without overwriting the source.";
    }
    if (job.phase === "batch_extraction") {
      return zh
        ? "当前这批笔记的 AI 检查尚未完成。Raw 原文和已完成的整理都会保留。"
        : "The AI review of the current batch has not finished. Raw sources and completed organization are preserved.";
    }
    if (job.phase === "generate_guide") {
      return zh
        ? "Wiki 使用指南或索引还没有完成。"
        : "The Wiki guide or index has not finished generating.";
    }
    return zh
      ? "初始化没有完成，EchoInk 已保留当前进度。"
      : "Initialization did not finish, and EchoInk preserved the current progress.";
  }

  private pauseCompletedText(
    job: Readonly<KnowledgeInitializationJob>,
    zh: boolean
  ): string {
    const moveTotal = job.items.filter((item) => item.targetPath !== null).length;
    const moved = job.items.filter((item) => item.state === "moved").length;
    const directoryTotal = KNOWLEDGE_INITIALIZATION_ROOTS.length;
    const directories = Math.min(job.createdDirectories.length, directoryTotal);
    if (zh) {
      return `目录 ${directories}/${directoryTotal}；归档文件 ${moved}/${moveTotal}；AI 检查 ${job.extractionCursor}/${job.extractionQueue.length}。已完成内容和 Raw 原文都会保留。`;
    }
    return `Folders ${directories}/${directoryTotal}; archived files ${moved}/${moveTotal}; AI sources ${job.extractionCursor}/${job.extractionQueue.length}. Completed work and Raw source files are preserved.`;
  }

  private pauseNextStepText(
    recovery: KnowledgeInitializationRecovery,
    job: Readonly<KnowledgeInitializationJob>,
    zh: boolean,
    needsProviderSetup = this.recoveryNeedsProviderSetup(recovery, job)
  ): string {
    if (recovery.kind === "recheck-conflict") {
      return zh
        ? "先处理目标路径的同名文件，然后点击“重新检查冲突”。"
        : "Resolve the files occupying the target paths, then select Recheck conflicts.";
    }
    if (recovery.kind === "recheck-preview") {
      if (needsProviderSetup) {
        return zh
          ? "先设置可用的 API Provider，再点击“重新检查并继续”。"
          : "Set up an available API Provider, then select Recheck and continue.";
      }
      return zh
        ? "点击“重新检查并继续”，EchoInk 会根据当前模型和文件重建计划。"
        : "Select Recheck and continue to rebuild the plan from the current model and files.";
    }
    if (job.phase === "batch_extraction") {
      return zh
        ? "根据上面的原因检查后，点击“继续初始化”。已完成的批次不会重做。"
        : "Check the reason above, then select Continue initialization. Completed batches will not run again.";
    }
    return zh
      ? "根据上面的原因检查后，点击“继续初始化”。已完成的内容会保留。"
      : "Check the reason above, then select Continue initialization. Completed work is preserved.";
  }

  private recoveryNeedsProviderSetup(
    recovery: KnowledgeInitializationRecovery,
    job: Readonly<KnowledgeInitializationJob>
  ): boolean {
    if (recovery.kind !== "recheck-preview") return false;
    const jobLacksProvider =
      job.provider === null && job.extractionQueue.length > 0;
    return jobLacksProvider || this.currentProviderSnapshot() === null;
  }

  /**
   * 通用「重新选择方案」：直接回到 Tab 选择界面，不做任何后台调用。
   * custom 预览由 renderTabsPanel → ensureCustomPreview 自动重建
   * （只产生一次 start:custom，不移动文件、不调用 Provider）。
   * 保留旧分配的一次性恢复只发生在恢复按钮的 recheck 路径里。
   */
  private enterPlanSelection(): void {
    this.reselecting = true;
    this.clearActionError();
    this.scheduleRender();
  }

  private async resumeRun(): Promise<void> {
    this.reselecting = false;
    await this.runAction(async () => {
      this.job = await this.plugin.continueEchoInkKnowledgeInitialization();
      this.loaded = true;
    });
  }

  /** blocked_conflict 的重新检查：绝不直接调用 continue。 */
  private async recheckConflict(): Promise<void> {
    const job = this.job;
    if (!job) return;
    if (job.mode === "recommended") {
      // 推荐模式：重新扫描后立即确认；若冲突仍在，confirm 会再次停在冲突态。
      this.reselecting = false;
      await this.runAction(async () => {
        this.job = await this.plugin.startEchoInkKnowledgeInitialization("recommended");
        this.job = await this.plugin.confirmEchoInkKnowledgeInitialization();
        this.loaded = true;
      });
      return;
    }
    // 自定义模式：回到可修改的 preview，不直接移动文件。
    await this.rescanCustomPreservingAssignments();
  }

  /** Provider/digest 变化后的重新检查：必须重新生成 preview，不直接 continueJob。 */
  private async recheckPreviewAndContinue(): Promise<void> {
    const job = this.job;
    if (!job) return;
    if (job.mode === "recommended") {
      // 推荐模式：用户点击后重新 preview + confirm。
      this.reselecting = false;
      await this.runAction(async () => {
        this.job = await this.plugin.startEchoInkKnowledgeInitialization("recommended");
        this.job = await this.plugin.confirmEchoInkKnowledgeInitialization();
        this.loaded = true;
      });
      return;
    }
    // 自定义模式：重新扫描、保留合法旧分配，然后停在 preview 让用户再确认。
    await this.rescanCustomPreservingAssignments();
  }

  /**
   * 自定义模式重新扫描：按 sourcePath 保留仍然存在且合法的旧目录分配，
   * 用一次 assignMany() 恢复，然后停在 preview 让用户再次确认。
   * 重新 preview 阶段不移动文件、不调用 Provider。
   */
  private async rescanCustomPreservingAssignments(): Promise<void> {
    this.reselecting = false;
    if (await this.rebuildCustomPreviewPreservingAssignments()) {
      this.scheduleRender();
    }
  }

  private customAssignmentsToPreserve(
    job: Readonly<KnowledgeInitializationJob> | null
  ): KnowledgeInitializationAssignment[] {
    return (job?.items ?? [])
      .filter((item) => item.role === "keep"
        || item.role !== knowledgeInitializationSourceDefaultRole(item.sourcePath))
      .map((item) => ({ sourcePath: item.sourcePath, role: item.role }));
  }

  private async rebuildCustomPreviewPreservingAssignments(): Promise<boolean> {
    if (this.busy) return false;
    const previous = this.job;
    const preserved = this.customAssignmentsToPreserve(previous);
    this.busy = true;
    this.clearActionError();
    try {
      this.job = await this.plugin.startEchoInkKnowledgeInitialization("custom");
      this.loaded = true;
      const validPaths = new Set((this.job?.items ?? []).map((item) => item.sourcePath));
      const restorable = preserved.filter(
        (assignment) => validPaths.has(assignment.sourcePath)
          && isKnowledgeInitializationRole(assignment.role)
      );
      if (restorable.length > 0) {
        this.job = await this.plugin.assignManyEchoInkKnowledgeInitializationNotes(
          Object.freeze(restorable)
        );
      }
      this.selectedTab = "custom";
      return true;
    } catch (error) {
      this.recordActionError(error);
      await this.reloadAfterActionError();
      this.scheduleRender();
      return false;
    } finally {
      this.busy = false;
    }
  }

  // ------------------------------------------------------------------- done

  private renderDonePanel(panel: HTMLElement): void {
    const zh = this.zh;
    panel.addClass("initialization", "is-ready");
    const icon = panel.createSpan({ cls: "ready-icon", attr: { "aria-hidden": "true" } });
    setIcon(icon, "check");
    const copy = panel.createDiv({ cls: "echoink-init-ready-copy" });
    const job = this.job;
    copy.createEl("h3", { text: job?.status === "initialized" ? (zh ? "初始化已完成" : "Initialization complete") : (zh ? "知识库目录已就绪" : "Knowledge folders are ready") });
    copy.createEl("p", { text: job?.status === "initialized"
      ? (job.analysisOnly ? (zh ? "本轮为只读分析，未执行知识写入；未读来源列为待处理。" : "This run was read-only; no knowledge was written and unread sources remain pending.") : (zh ? "已完成的整理与分析已保留；无需新增也是正常结果。" : "Completed organization and analysis are preserved; no new notes is a valid result."))
      : (zh ? "固定目录完整，EchoInk 可以正常整理原始笔记、Wiki 和附件。" : "The fixed folder structure is complete, so EchoInk can organize notes and attachments.") });
    if (job?.warnings?.length) {
      const details = copy.createEl("details");
      details.createEl("summary", { text: zh ? `完成提醒（${job.warnings.length}）` : `Completion notes (${job.warnings.length})` });
      for (const warning of job.warnings) details.createEl("p", { text: this.errorTextForDisplay(warning) });
    }
    if (job?.pendingSourcePaths?.length) copy.createEl("p", { text: `${zh ? "待处理来源" : "Pending sources"}: ${job.pendingSourcePaths.join("、")}` });
    const actions = panel.createDiv({ cls: "echoink-knowledge-init-actions init-actions" });
    if (job?.savePending || job?.pendingMoves || job?.pendingSourcePaths?.length) {
      const retry = createOriginButton(actions, { cls: "button echoink-knowledge-init-secondary", text: zh ? (job.savePending ? "重试保存状态" : job.pendingMoves ? "继续待确认移动" : "继续待处理来源") : "Resume pending work" });
      retry.onclick = () => { void this.plugin.continueEchoInkKnowledgeInitialization().then((next) => { this.clearActionError(); this.job = next; this.scheduleRender(); }).catch((error) => { this.recordActionError(error); this.scheduleRender(); }); };
    }
    const open = createOriginButton(actions, {
      cls: "button echoink-init-ready-open",
      text: zh ? "打开 Wiki 首页" : "Open Wiki home",
      attr: { type: "button" }
    });
    setIcon(open.createSpan({ attr: { "aria-hidden": "true" } }), "arrow-up-right");
    open.onclick = () => void this.openFile("wiki/index.md");
    const maintain = createOriginButton(actions, {
      cls: "text-button",
      text: zh ? "整理新增笔记" : "Maintain new notes",
      attr: { type: "button" }
    });
    setIcon(maintain.createSpan({ attr: { "aria-hidden": "true" } }), "arrow-right");
    maintain.onclick = () => void this.startRecommended();
    const journal = createOriginButton(actions, {
      cls: "text-button",
      text: zh ? "补齐日记与模板设置" : "Complete journal and template setup",
      attr: { type: "button" }
    });
    journal.disabled = this.busy;
    journal.onclick = () => void this.restoreStructure();
  }

  // ---------------------------------------------------------------- helpers

  private dirLabel(role: KnowledgeInitializationRole): string {
    const dir = KNOWLEDGE_INIT_DIRECTORIES.find((candidate) => candidate.role === role);
    if (dir) return this.zh ? dir.labelZh : dir.labelEn;
    return this.zh ? "保持原位" : "Keep in place";
  }

  /** 当前设置派生的可用 Provider 快照；不可用时为 null。 */
  private currentProviderSnapshot(): KnowledgeInitializationProviderSnapshot | null {
    const active = getActiveApiProviderModel(this.plugin.settings);
    if (!active || !apiProviderHasUsableCredential(
      active.provider,
      this.plugin.settings.openAICodexCredential
    )) return null;
    return { providerId: active.provider.id, model: active.model.id };
  }

  private currentProviderReady(): boolean {
    return this.currentProviderSnapshot() !== null;
  }

  private async openFile(relativePath: string): Promise<void> {
    const file = this.plugin.app.vault.getFileByPath(relativePath);
    if (!file) {
      new Notice(this.zh ? "知识库文件暂不可用。" : "The Knowledge file is unavailable.");
      return;
    }
    await this.plugin.app.workspace.getLeaf("tab").openFile(file);
  }
}

function progressStepLabel(
  stage: KnowledgeInitializationProgressStage,
  zh: boolean
): string {
  const labels: Record<KnowledgeInitializationProgressStage, [string, string]> = {
    idle: ["准备中", "Preparing"],
    plan: ["正在准备计划", "Preparing the plan"],
    directories: ["正在创建固定目录", "Creating fixed folders"],
    moving: ["正在移动笔记", "Moving notes"],
    extracting: ["正在提炼 Wiki", "Distilling into Wiki"],
    guide: ["正在生成指南并回读", "Writing and verifying the guide"],
    done: ["即将完成", "Finishing up"]
  };
  return labels[stage][zh ? 0 : 1];
}

function progressStatusSentence(
  stage: KnowledgeInitializationProgressStage,
  progress: { percent: number; completed: number; total: number },
  zh: boolean
): string {
  const step = progressStepLabel(stage, zh);
  if (progress.total <= 0) return `${step} · ${progress.percent}%`;
  return `${step} · ${progress.completed} / ${progress.total} · ${progress.percent}%`;
}
