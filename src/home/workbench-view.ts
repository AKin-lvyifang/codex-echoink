import { ownedEl, ownedDiv } from "../ui/owned-dom";
import { openTaskMenu } from "../ui/codex-view/task-menu";
import { isImeKeyEvent, watchImeComposition, isComposingInput } from "../ui/ime-composition";
import { attachNativeTooltip } from "../ui/native-tooltip";
import { WorkbenchWeatherStage, type WorkbenchWeather } from "./workbench-weather";
import { workbenchModuleSetupReason, renderWorkbenchModuleSetup } from "./workbench-module-setup";
import { WorkbenchStarters } from "./workbench-starters";
import { workbenchResultType, type WorkbenchResultType } from "./workbench-result";
import { getTodoProjects, resolveTodoProject } from "./todo-projects";
import { ItemView, Menu, Notice, TFile, WorkspaceLeaf, setIcon, setTooltip } from "obsidian";
import type CodexForObsidianPlugin from "../main";
import { GENERAL_ASSISTANT_ID, type AgentDefinition } from "../agents/types";
import { isUserTask, localDateLabel, localTaskTime, maintenanceActivityForTask, taskCardHintSummary, taskState, taskStateLabel, taskSummary, type TaskEntry } from "../agents/task-presentation";
import type { TaskInterruptionInfo } from "../agents/task-resume";
import type { EchoInkQuestionPrompt, EchoInkTurnInteraction } from "../types/conversation-turn";
import { createOriginButton, createOriginCheck, createOriginInput, disposeOriginControls } from "../settings/origin-controls";
import { applyAmicroButton, setAmicroButtonPending } from "../settings/amicro-buttons";
import { renderTaskAvatar } from "../ui/codex-view/agent-roster";
import { ForegroundView } from "../ui/foreground-view";
import { HomeSearchService, type HomeSearchMatch } from "./home-search";
import { isHomeNotePath } from "./home-note-visibility";
import { formatHomeRelativeTime } from "./home-i18n";
import { getWorkbenchDataService } from "./workbench-data";
import type { WorkbenchDataPort, WorkbenchSignal, WorkbenchSnapshot } from "./workbench-types";
import { answerWorkbenchQuestion, launchWorkbenchSignal } from "./task-launcher";
import { openWorkbenchModule, WORKBENCH_MODULES } from "./module-navigation";
import type { ParsedTodoRecord } from "./todo-markdown";
import { createPluginEditionBadge } from "../settings/plugin-edition-badge";
import { isProWorkbenchModule, renderWorkbenchModuleLock, workbenchHasPro } from "./workbench-module-lock";
import { maintenanceActivityText, maintenanceTaskTitle, maintenanceTaskStatus, type KnowledgeActivitySource, type MaintenanceActivity } from "../knowledge-base/maintenance-activity";
import type { MaintenanceUpgradeSurface } from "../knowledge-base/maintenance-upgrade-contract";
import { renderMaintenanceProgressBar } from "../ui/codex-view/knowledge-linking-progress";
import { renderVaultMemoryBanner } from "./vault-memory-banner";
import { renderDiaryOrganizerBanner } from "./diary-organizer-banner";
import { diaryHomeSummary } from "./diary-organizer-summary";
import type { VaultMemoryNotice } from "../storage/vault-identity";

// Preserve existing desktop workspace restoration; the old view has its own ID.
export const VIEW_TYPE_ECHOINK_WORKBENCH = "codex-echoink-home";
type TaskGroups = Record<"interrupted" | "waiting" | "running" | "completed", TaskEntry[]>;
let viewId = 0;

function latestMaintenanceActivities(activities: readonly Readonly<MaintenanceActivity>[], entries: readonly TaskEntry[] = []): Map<string, Readonly<MaintenanceActivity>> {
  const latest = new Map<string, Readonly<MaintenanceActivity>>();
  for (const activity of activities) {
    const previous = latest.get(activity.originConversationId);
    if (!previous || activity.updatedAt > previous.updatedAt) latest.set(activity.originConversationId, activity);
  }
  for (const entry of entries) {
    const activity = maintenanceActivityForTask(entry, activities);
    if (activity) latest.set(entry.conversationId, activity); else latest.delete(entry.conversationId);
  }
  return latest;
}
export function groupWorkbenchTasks(entries: readonly TaskEntry[], now = Date.now(), maintenance: readonly Readonly<MaintenanceActivity>[] = []): TaskGroups {
  const groups: TaskGroups = { interrupted: [], waiting: [], running: [], completed: [] };
  const activities = latestMaintenanceActivities(maintenance, entries);
  const completedAt = (entry: TaskEntry) => activities.has(entry.conversationId) ? activities.get(entry.conversationId)!.completedAt : entry.taskCompletedAt ?? entry.updatedAt;
  for (const entry of entries) {
    if (entry.status !== "active" || !isUserTask(entry)) continue;
    const activity = activities.get(entry.conversationId), state = activity ? maintenanceTaskStatus(activity) : taskState(entry);
    const at = completedAt(entry);
    if (state !== "completed" || at !== undefined && sameDay(at, now)) groups[state].push(entry);
  }
  groups.interrupted.sort((a, b) => (activities.get(b.conversationId)?.updatedAt ?? b.taskInterruptedAt ?? b.updatedAt) - (activities.get(a.conversationId)?.updatedAt ?? a.taskInterruptedAt ?? a.updatedAt));
  groups.waiting.sort((a, b) => (activities.get(a.conversationId)?.updatedAt ?? a.updatedAt) - (activities.get(b.conversationId)?.updatedAt ?? b.updatedAt));
  groups.running.sort((a, b) => (a.taskStartedAt ?? a.updatedAt) - (b.taskStartedAt ?? b.updatedAt));
  groups.completed.sort((a, b) => (completedAt(b) ?? 0) - (completedAt(a) ?? 0));
  return groups;
}

/** One remaining source set supplies both the reminder count and its draft scope. */
export function workbenchSignalsWithoutActiveMaintenance(signals: readonly WorkbenchSignal[], covered: ReadonlySet<string>, english = false): WorkbenchSignal[] {
  return signals.flatMap(signal => {
    if (signal.id !== 7 || signal.moduleId !== "knowledge-base") return [signal];
    const objects = signal.source.objects.filter(path => !covered.has(path));
    if (objects.length === signal.source.objects.length) return [signal];
    if (!objects.length) return [];
    return [{ ...signal, description: english ? `${objects.length} sources to organize` : `${objects.length} 篇资料待整理`,
      source: { ...signal.source, objects, ...(signal.source.versions ? {
        versions: Object.fromEntries(Object.entries(signal.source.versions).filter(([path]) => objects.includes(path)))
      } : {}) } }];
  });
}

/** Only a current, single-choice question can be answered from the overview. */
export function workbenchInlineQuestion(entry: TaskEntry, pending?: Readonly<EchoInkTurnInteraction>): Readonly<EchoInkQuestionPrompt> | undefined {
  if (!pending || pending.kind !== "question" || pending.status !== "pending"
    || pending.conversationId !== entry.conversationId || pending.piSessionId !== entry.piSessionId
    || pending.turnId !== entry.pendingResponse?.runId || entry.pendingResponse.kind !== "question"
    || pending.questions.length !== 1) return;
  const question = pending.questions[0];
  if (question.selection === "single" && question.questionId === entry.pendingResponse.questionId) return question;
}

export class EchoInkWorkbenchView extends ItemView {
  private weatherStage?: WorkbenchWeatherStage;
  private starters?: WorkbenchStarters;
  private navObserver?: ResizeObserver;
  private navFrame?: number;
  private overflowModules: typeof WORKBENCH_MODULES[number][] = [];
  private memoryNotice: VaultMemoryNotice | null = null;
  private memoryError: string | null = null;
  private readonly port: WorkbenchDataPort;
  private readonly searchService: HomeSearchService;
  private readonly id = `echoink-workbench-${++viewId}`;
  private foreground: ForegroundView | null = null;
  private closed = true;
  private unsubscribers: (() => void)[] = [];
  private refreshTimer: number | null = null;
  private clockTimer: number | null = null;
  private refreshVersion = 0;
  private refreshPending = false;
  private languagePending = false;
  private refreshFlight: Promise<void> | null = null;
  private entries: readonly TaskEntry[] | null = null;
  private snapshot: WorkbenchSnapshot | null = null;
  private knowledgeSource?: KnowledgeActivitySource;
  private knowledgeUnsubscribe?: () => void;
  private maintenanceActivities: readonly Readonly<MaintenanceActivity>[] = [];
  private maintenance = new Map<string, Readonly<MaintenanceActivity>>();
  private interruptions = new Map<string, TaskInterruptionInfo | null>();
  private interruptionRevisions = new Map<string, string>();
  private interruptionErrors = new Set<string>();
  private readonly completedPreviews = new Map<string, { revision: string; text?: string; type?: WorkbenchResultType; error?: string }>();
  private readonly taskCardBodies = new Map<HTMLElement, HTMLElement>();
  private taskError = "";
  private dataError = "";
  private selectedTask = "";
  private signalsExpanded = false;
  private readonly busy = new Set<string>();
  private searchOpen = false;
  private searchTimer: number | null = null;
  private searchAbort: AbortController | null = null;
  private searchResolvedQuery: string | null = null;
  private searchMatches: HomeSearchMatch[] = [];
  private searchIndex = -1;
  private lockedModule: typeof WORKBENCH_MODULES[number]["id"] | null = null;
  private modulePageState = "";

  constructor(leaf: WorkspaceLeaf, private readonly plugin: CodexForObsidianPlugin) {
    super(leaf);
    this.port = getWorkbenchDataService(plugin);
    this.searchService = new HomeSearchService(plugin.app, path => isHomeNotePath(path, plugin.settings.englishDiary));
  }
  getViewType(): string { return VIEW_TYPE_ECHOINK_WORKBENCH; }
  getDisplayText(): string { return this.t("工作台", "Workbench"); }
  getIcon(): string { return "layout-grid"; }
  private get language() { return this.plugin.settings.settingsLanguage; }
  private t(zh: string, en: string): string { return this.language === "en" ? en : zh; }
  private field(name: string): HTMLElement { return this.contentEl.querySelector<HTMLElement>(`[data-wb="${name}"]`)!; }
  private active(): boolean { return !this.closed && (this.foreground?.isActive() ?? true); }

  async onOpen(): Promise<void> {
    this.register(watchImeComposition(this.contentEl));
    this.closed = false;
    this.contentEl.addClass("echoink-workbench");
    this.contentEl.tabIndex = -1;
    this.renderShell();
    this.observeKnowledgeActivity();
    this.foreground = new ForegroundView(this, active => this.foregroundChanged(active));
    const service = this.plugin.getConversationRunService();
    this.unsubscribers.push(this.port.subscribe(() => this.scheduleRefresh()));
    this.unsubscribers.push(service.subscribe({ refresh: () => this.scheduleRefresh(), clearAcceptedDraft() {}, isTaskVisible: () => false }));
    this.registerDomEvent(this.contentEl, "keydown", event => this.handleKeys(event));
    this.registerDomEvent(this.contentEl, "input", event => {
      if ((event.target as HTMLElement).dataset.wb === "search-input" && !isComposingInput(event)) this.scheduleSearch();
    });
    this.registerDomEvent(this.contentEl, "compositionend", () => this.scheduleSearch());
    this.registerDomEvent(this.contentEl, "pointermove", event => {
      const option = (event.target as HTMLElement).closest<HTMLElement>("[data-search-index]");
      if (option && this.searchOpen) this.selectSearchIndex(Number(option.dataset.searchIndex), false);
    });
    this.registerDomEvent(this.contentEl, "focusout", event => {
      if (event.relatedTarget && !this.field("search").contains(event.relatedTarget as Node)) this.closeSearch(false);
    });
    this.registerDomEvent(this.contentEl.ownerDocument, "pointerdown", event => {
      if (!this.field("search").contains(event.target as Node) && !this.field("search-trigger").contains(event.target as Node)) this.closeSearch(false);
    });
    for (const event of ["pointerover", "pointerout", "pointerdown", "pointerup", "focusin", "focusout", "keydown"] as const) {
      this.registerDomEvent(this.contentEl, event, () => queueMicrotask(() => this.syncTaskCardFeedback()));
    }
    this.registerDomEvent(this.contentEl, "scroll", () => this.syncTaskCardFeedback(), true);
    this.scheduleRefresh(0);
  }
  async onClose(): Promise<void> {
    this.closed = true; this.refreshVersion++;
    this.foreground?.dispose(); this.foreground = null;
    this.disposeHeader(); this.starters?.dispose(); this.starters = undefined;
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
    this.knowledgeUnsubscribe?.(); this.knowledgeUnsubscribe = undefined; this.knowledgeSource = undefined; this.maintenanceActivities = []; this.maintenance.clear();
    this.clearTimers(); this.stopSearchWork();
    this.disposeControls(this.contentEl); this.contentEl.empty(); this.contentEl.removeClass("echoink-workbench");
  }
  private clearTimers(): void {
    const win = this.contentEl.ownerDocument.defaultView;
    if (this.refreshTimer !== null) win?.clearTimeout(this.refreshTimer);
    if (this.clockTimer !== null) win?.clearTimeout(this.clockTimer);
    this.refreshTimer = this.clockTimer = null;
  }
  private foregroundChanged(active: boolean): void {
    if (this.closed) return;
    this.weatherStage?.setActive(active); this.starters?.setActive(active);
    if (!active) {
      this.clearTimers(); this.stopSearchWork(); this.refreshVersion++; this.refreshPending = true;
      return;
    }
    if (this.languagePending) { this.languagePending = false; void this.refreshLanguage(); return; }
    this.scheduleRefresh(0);
    if (this.searchOpen) this.scheduleSearch();
  }
  private scheduleRefresh(delay = 100): void {
    this.refreshPending = true;
    if (!this.active()) return;
    const win = this.contentEl.ownerDocument.defaultView;
    if (this.refreshTimer !== null) win?.clearTimeout(this.refreshTimer);
    this.refreshTimer = win?.setTimeout(() => { this.refreshTimer = null; void this.refresh(); }, delay) ?? null;
  }
  private observeKnowledgeActivity(): void {
    const source = this.plugin.getKnowledgeActivitySource?.();
    if (source === this.knowledgeSource) return;
    this.knowledgeUnsubscribe?.(); this.knowledgeUnsubscribe = undefined; this.knowledgeSource = source;
    this.maintenanceActivities = source?.snapshot().maintenance ?? [];
    this.maintenance = latestMaintenanceActivities(this.maintenanceActivities, this.entries ?? []);
    if (source) this.knowledgeUnsubscribe = source.subscribe(snapshot => {
      this.maintenanceActivities = snapshot.maintenance;
      this.maintenance = latestMaintenanceActivities(this.maintenanceActivities, this.entries ?? []);
      if (this.active()) this.render(); else this.refreshPending = true;
    });
  }
  private taskGroups(now: number): TaskGroups { return groupWorkbenchTasks(this.entries ?? [], now, [...this.maintenance.values()]); }
  private taskState(entry: TaskEntry): keyof TaskGroups {
    const activity = this.maintenance.get(entry.conversationId);
    return activity ? maintenanceTaskStatus(activity) : taskState(entry);
  }
  async refresh(): Promise<void> {
    if (!this.active()) { this.refreshPending = true; return; }
    if (this.refreshFlight) { this.refreshPending = true; return this.refreshFlight; }
    this.refreshPending = false;
    const version = ++this.refreshVersion;
    this.observeKnowledgeActivity();
    const now = Date.now();
    this.refreshFlight = (async () => {
      const [tasks, snapshot, memory, memoryError] = await Promise.allSettled([this.plugin.listAgentTaskEntries(), this.port.load(now), this.plugin.getVaultMemoryNotice?.(), this.plugin.getVaultMemoryError?.()]);
      if (!this.active() || version !== this.refreshVersion) return;
      if (memory.status === "fulfilled") this.memoryNotice = memory.value ?? null;
      if (memoryError.status === "fulfilled") this.memoryError = memoryError.value ?? null;
      if (tasks.status === "fulfilled") {
        this.entries = tasks.value;
        this.maintenance = latestMaintenanceActivities(this.maintenanceActivities, this.entries);
        this.taskError = "";
      }
      else this.taskError = message(tasks.reason);
      if (snapshot.status === "fulfilled") { this.snapshot = snapshot.value; this.dataError = ""; }
      else this.dataError = message(snapshot.reason);
      const groups = tasks.status === "fulfilled" ? this.taskGroups(now) : undefined;
      const interrupted = groups?.interrupted ?? [];
      const unread = interrupted.filter(entry => {
        const changed = this.interruptionRevisions.get(entry.conversationId) !== this.interruptionRevision(entry) || this.interruptionErrors.has(entry.conversationId);
        if (changed) { this.interruptions.delete(entry.conversationId); this.interruptionErrors.delete(entry.conversationId); }
        return changed;
      });
      if (tasks.status === "fulfilled") {
        const ids = new Set(interrupted.map(entry => entry.conversationId));
        for (const id of this.interruptions.keys()) if (!ids.has(id)) { this.interruptions.delete(id); this.interruptionRevisions.delete(id); this.interruptionErrors.delete(id); }
        const completedIds = new Set(groups!.completed.map(entry => entry.conversationId));
        for (const id of this.completedPreviews.keys()) if (!completedIds.has(id)) this.completedPreviews.delete(id);
      }
      this.render(now);
      await Promise.all([
        this.loadCompletedPreviews(groups?.completed ?? [], version, now),
        (async () => {
          if (!unread.length) return;
          const records = await Promise.allSettled(unread.map(entry => this.plugin.readTaskInterruption(entry.conversationId)));
          if (!this.active() || version !== this.refreshVersion) return;
          records.forEach((result, index) => {
            const entry = unread[index], id = entry.conversationId;
            if (result.status === "fulfilled") { this.interruptions.set(id, result.value); this.interruptionRevisions.set(id, this.interruptionRevision(entry)); }
            else this.interruptionErrors.add(id);
          });
          this.render(now);
        })()
      ]);
    })().catch(error => {
      if (this.active() && version === this.refreshVersion) { this.taskError = message(error); this.render(now); }
    }).finally(() => {
      this.refreshFlight = null;
      if (this.active()) {
        if (this.refreshPending) this.scheduleRefresh(0);
        else this.scheduleClock();
      }
    });
    return this.refreshFlight;
  }
  async refreshLanguage(): Promise<void> {
    if (!this.active()) { this.languagePending = true; this.refreshPending = true; return; }
    const query = this.searchOpen ? (this.field("search-input") as HTMLInputElement).value : null;
    this.stopSearchWork(); this.renderShell(); this.render();
    if (query !== null) { (this.field("search-input") as HTMLInputElement).value = query; this.openSearch(); }
    await this.refresh();
  }
  refreshIfSettingsChanged(): void { this.scheduleRefresh(0); }
  refreshHomeSurfaces(): void { this.scheduleRefresh(0); }
  private scheduleClock(): void {
    if (!this.active()) return;
    const win = this.contentEl.ownerDocument.defaultView;
    if (this.clockTimer !== null) win?.clearTimeout(this.clockTimer);
    const now = Date.now(), date = new Date(now);
    const targets = [new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime()];
    const evening = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 18).getTime();
    if (evening > now) targets.push(evening);
    if (this.snapshot?.nextRefreshAt && this.snapshot.nextRefreshAt > now) targets.push(this.snapshot.nextRefreshAt);
    const diaryRefreshAt = diaryHomeSummary(this.plugin.diaryOrganizer?.engine.getState().items ?? [], now).nextRefreshAt;
    if (diaryRefreshAt && diaryRefreshAt > now) targets.push(diaryRefreshAt);
    if (this.entries?.some(entry => entry.status === "active" && !this.maintenance.has(entry.conversationId) && taskState(entry) === "running")) targets.push(now + 60_000);
    this.clockTimer = win?.setTimeout(() => { this.clockTimer = null; this.scheduleRefresh(0); }, Math.max(1, Math.min(...targets) - now + 25)) ?? null;
  }

  private button(parent: HTMLElement, text: string, key: string, action: () => unknown, variant: "primary" | "secondary" | "tertiary" | "icon" = "secondary", icon?: string): HTMLButtonElement {
    const button = createOriginButton(parent, { cls: `wb-button is-${variant}`, text, attr: { "data-wb-focus": key, ...(variant === "icon" ? { "aria-label": text } : {}) } });
    if (variant === "icon") { button.textContent = ""; attachNativeTooltip(button, text); }
    applyAmicroButton(button, { variant });
    if (icon) { const node = button.createSpan({ cls: "wb-button-icon", attr: { "aria-hidden": "true" } }); setIcon(node, icon); button.prepend(node); }
    button.onclick = () => { void Promise.resolve().then(action).catch(error => new Notice(message(error))); };
    return button;
  }
  private renderShell(): void {
    this.disposeHeader(); this.starters?.dispose(); this.starters = undefined;
    this.disposeControls(this.contentEl); this.contentEl.empty(); this.searchOpen = false;
    const page = this.contentEl.createDiv({ cls: "wb-page", attr: { "data-wb": "page" } });
    const header = page.createEl("header", { cls: "wb-header" });
    const titles = header.createDiv({ cls: "wb-heading" });
    titles.createEl("h1", { text: this.t("工作台", "Workbench") });
    titles.createEl("time", { cls: "wb-date", attr: { "data-wb": "date" } });
    const nav = header.createEl("nav", { cls: "wb-modules", attr: { "data-wb": "modules", "aria-label": this.t("插件导航", "Modules") } });
    for (const module of WORKBENCH_MODULES) {
      const button = this.button(nav, this.language === "en" ? module.en : module.zh, `module-${module.id}`, () => this.openModule(module.id), "tertiary", module.icon);
      button.dataset.module = module.id;
    }
    this.button(nav, this.t("更多", "More"), "module-more", () => this.openMoreModules(), "tertiary", "ellipsis").dataset.wb = "module-more";
    this.weatherStage = new WorkbenchWeatherStage(header, this.plugin, weather => {
      const key = { drizzle: "interrupted", overcast: "waiting", breeze: "running", fair: "completed", still: "" }[weather];
      const section = this.field("groups").querySelector<HTMLElement>(`[data-wb-group="${key}"]`);
      section?.scrollIntoView({ block: "start", behavior: this.contentEl.ownerDocument.defaultView?.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
      section?.querySelector<HTMLElement>("h2")?.focus({ preventScroll: true });
    }, () => this.scheduleNav());
    const actions = header.createDiv({ cls: "wb-header-actions" });
    this.button(actions, this.t("搜索笔记", "Search notes"), "search-trigger", () => this.openSearch(), "icon", "search").dataset.wb = "search-trigger";
    this.button(actions, this.t("插件设置", "Plugin settings"), "settings", () => this.plugin.openEchoInkGeneralSettings(), "icon", "settings");
    this.button(actions, this.t("新任务", "New task"), "new-task", () => this.plugin.openAgentTaskList(GENERAL_ASSISTANT_ID), "primary", "plus");
    this.renderSearchShell(page);
    page.createDiv({ attr: { "data-wb": "memory-notice", "aria-live": "polite" } });
    page.createDiv({ attr: { "data-wb": "starters" } });
    page.createDiv({ attr: { "data-wb": "diary-organizer", "aria-live": "polite" } });
    const Observer = this.contentEl.ownerDocument.defaultView?.ResizeObserver;
    if (Observer) { this.navObserver = new Observer(() => this.scheduleNav()); this.navObserver.observe(header); this.navObserver.observe(actions); this.navObserver.observe(this.weatherStage.element); }
    void this.contentEl.ownerDocument.fonts?.ready.then(() => this.scheduleNav());
    page.createDiv({ cls: "wb-status", attr: { "data-wb": "status", "aria-live": "polite" } });
    page.createDiv({ cls: "wb-groups", attr: { "data-wb": "groups" } });
    page.createDiv({ cls: "wb-empty", text: this.t("暂时没有待处理的事", "Nothing to handle right now"), attr: { "data-wb": "empty" } }).hidden = true;
    if (this.lockedModule) this.showModuleLock(this.lockedModule);
    this.render();
  }

  private disposeHeader(): void {
    this.navObserver?.disconnect(); this.navObserver = undefined;
    if (this.navFrame !== undefined) this.contentEl.ownerDocument.defaultView?.cancelAnimationFrame(this.navFrame);
    this.navFrame = undefined; this.weatherStage?.dispose(); this.weatherStage = undefined;
  }
  private scheduleNav(): void {
    if (this.closed || this.navFrame !== undefined) return;
    this.navFrame = this.contentEl.ownerDocument.defaultView?.requestAnimationFrame(() => { this.navFrame = undefined; this.fitNavigation(); this.syncTaskCardFeedback(); });
  }
  private fitNavigation(): void {
    if (this.closed || !this.active()) return;
    const nav = this.field("modules"), more = this.field("module-more");
    const header = nav.closest<HTMLElement>(".wb-header")!;
    // Always retry with the full layout so weather returns when space becomes available.
    header.classList.remove("is-weather-condensed"); header.style.removeProperty("column-gap");
    const visible = WORKBENCH_MODULES;
    const buttons = visible.map(module => nav.querySelector<HTMLButtonElement>(`[data-module="${module.id}"]`)!);
    buttons.forEach(button => { button.hidden = false; }); more.hidden = true; this.overflowModules = [];
    if (!nav.getBoundingClientRect().width) return;
    const gap = Number.parseFloat(this.contentEl.ownerDocument.defaultView!.getComputedStyle(nav).columnGap) || 4;
    const total = () => { const shown = buttons.filter(button => !button.hidden); return shown.reduce((sum, button) => sum + button.getBoundingClientRect().width, 0) + Math.max(0, shown.length - 1) * gap; };
    // Subpixel layout rounding must not hide a module that otherwise fits.
    const fits = (width: number) => width <= nav.getBoundingClientRect().width + .5;
    if (fits(total())) return;
    header.classList.add("is-weather-condensed");
    if (fits(total())) return;
    more.hidden = false;
    const moreWidth = more.getBoundingClientRect().width;
    const firstWithMore = (buttons[0]?.getBoundingClientRect().width ?? 0) + gap + moreWidth;
    if (!fits(firstWithMore)) {
      // At narrow English widths, reclaim the two column gaps before losing the first item.
      const columnGap = Number.parseFloat(this.contentEl.ownerDocument.defaultView!.getComputedStyle(header).columnGap) || 0;
      header.style.columnGap = `${Math.max(0, columnGap - (firstWithMore - nav.getBoundingClientRect().width) / 2)}px`;
    }
    for (let i = buttons.length - 1; i >= 0 && !fits(total() + moreWidth + (buttons.some(button => !button.hidden) ? gap : 0)); i--) {
      buttons[i].hidden = true; this.overflowModules.unshift(visible[i]);
    }
    const focused = this.contentEl.ownerDocument.activeElement;
    if (buttons.some(button => button.hidden && button === focused)) (more as HTMLButtonElement).focus();
  }
  private openMoreModules(): void {
    const menu = new Menu();
    for (const module of this.overflowModules) menu.addItem(item => item.setTitle(`${this.language === "en" ? module.en : module.zh}${isProWorkbenchModule(module.id) && !workbenchHasPro(this.plugin) ? " · PRO" : ""}`).setIcon(module.icon).onClick(() => { void this.openModule(module.id); }));
    const box = this.field("module-more").getBoundingClientRect(); menu.showAtPosition({ x: box.left, y: box.bottom });
  }
  private renderStarters(): void {
    const show = this.entries !== null && !this.taskError && !this.entries.some(isUserTask);
    const host = this.field("starters"); host.hidden = !show;
    if (!show) { this.starters?.dispose(); this.starters = undefined; return; }
    if (!this.starters) this.starters = new WorkbenchStarters(host, {
      english: () => this.language === "en", hasPro: () => workbenchHasPro(this.plugin),
      avatar: () => { const avatar = this.plugin.settings.agentRegistry.agents.find(agent => agent.id === GENERAL_ASSISTANT_ID)?.avatar; return avatar?.kind === "preset" ? avatar.presetId : "sol"; },
      act: async index => {
        if (index < 3) return this.plugin.openWorkbenchSetup((["agent", "knowledge", "appearance"] as const)[index]);
        if (index === 3 || index === 4) return this.plugin.openAgentTaskList(GENERAL_ASSISTANT_ID, index === 3
          ? this.t("帮我开始写今天的日记，先问我三个问题。", "Help me start today's journal. Ask me three questions first.") : this.t("带我精读 @", "Read closely @"));
        return this.openModule(index === 5 ? "english-diary" : "pdf-reading");
      }, upgrade: () => this.plugin.openEchoInkAccountSettings("benefits"), error: error => new Notice(message(error))
    });
    else this.starters.update();
  }

  private async openModule(id: typeof WORKBENCH_MODULES[number]["id"]): Promise<void> {
    if (isProWorkbenchModule(id) && !workbenchHasPro(this.plugin) || workbenchModuleSetupReason(this.plugin, id)) { this.showModuleLock(id); return; }
    await openWorkbenchModule(this.plugin, id);
  }
  private showModuleLock(id: typeof WORKBENCH_MODULES[number]["id"]): void {
    this.closeSearch(false);
    const previous = this.contentEl.querySelector<HTMLElement>('[data-wb="module-lock"], [data-wb="module-setup"]');
    if (previous) { this.disposeControls(previous); previous.remove(); }
    this.lockedModule = id;
    this.weatherStage?.setActive(false); this.starters?.setActive(false);
    this.field("page").hidden = true;
    this.field("page").inert = true;
    const reason = workbenchModuleSetupReason(this.plugin, id);
    const locked = isProWorkbenchModule(id) && !workbenchHasPro(this.plugin);
    this.modulePageState = locked ? "pro" : reason ?? "";
    const page = locked ? renderWorkbenchModuleLock(this.contentEl, this.plugin, id, () => this.closeModuleLock())
      : renderWorkbenchModuleSetup(this.contentEl, this.plugin, id, reason!, () => this.closeModuleLock());
    page.querySelector<HTMLButtonElement>("button")?.focus();
  }
  private closeModuleLock(): void {
    const id = this.lockedModule;
    const page = this.contentEl.querySelector<HTMLElement>('[data-wb="module-lock"], [data-wb="module-setup"]');
    if (page) { this.disposeControls(page); page.remove(); }
    this.lockedModule = null; this.modulePageState = "";
    this.field("page").hidden = false;
    this.field("page").inert = false;
    this.weatherStage?.setActive(this.active()); this.starters?.setActive(this.active());
    this.field("modules").querySelector<HTMLButtonElement>(`[data-module="${id}"]`)?.focus();
  }

  private render(now = Date.now()): void {
    if (this.closed) return;
    if (!this.active()) { this.refreshPending = true; return; }
    const active = this.contentEl.ownerDocument.activeElement as HTMLElement | null;
    const focus = active && this.field("groups").contains(active) ? active.dataset.wbFocus : undefined;
    const oldGroup = active?.closest<HTMLElement>("[data-wb-group]")?.dataset.wbGroup;
    const oldScroll = this.contentEl.scrollTop;
    const date = this.field("date");
    date.textContent = new Intl.DateTimeFormat(this.language, { month: "long", day: "numeric", weekday: "long" }).format(new Date(now));
    date.setAttribute("datetime", dayKey(now));
    this.field("modules").querySelectorAll<HTMLButtonElement>("[data-module]").forEach(button => {
      const id = button.dataset.module as typeof WORKBENCH_MODULES[number]["id"];
      const proModule = isProWorkbenchModule(id);
      button.hidden = false;
      const badge = button.querySelector<HTMLElement>('[data-plugin-edition="pro"]');
      const locked = proModule && !workbenchHasPro(this.plugin);
      if (locked && !badge) createPluginEditionBadge(button, "pro", this.language);
      else if (!locked) badge?.remove();
    });
    if (this.lockedModule) {
      const id = this.lockedModule;
      const state = isProWorkbenchModule(id) && !workbenchHasPro(this.plugin) ? "pro" : workbenchModuleSetupReason(this.plugin, id) ?? "";
      if (!state) { this.closeModuleLock(); void this.openModule(id).catch(error => new Notice(message(error))); }
      else if (state !== this.modulePageState) this.showModuleLock(id);
    }
    this.scheduleNav();
    this.renderStarters();
    this.renderStatus();
    renderDiaryOrganizerBanner(this.field("diary-organizer"), this.plugin);
    renderVaultMemoryBanner(this.field("memory-notice"), this.memoryNotice, this.language, {
      resolve: async action => { await this.plugin.resolveVaultMemory(action); await this.refresh(); },
      error: () => { new Notice(this.t("记忆恢复未完成，原内容和备份已保留。", "Memory recovery could not finish. Your original content and backup are preserved.")); void this.refresh(); }
    });
    const groups = this.taskGroups(now);
    const weather: WorkbenchWeather | null = this.taskError || this.entries === null ? null
      : groups.interrupted.length ? "drizzle" : groups.waiting.length ? "overcast" : groups.running.length ? "breeze" : groups.completed.length ? "fair" : "still";
    const count = weather === "drizzle" ? groups.interrupted.length : weather === "overcast" ? groups.waiting.length : weather === "breeze" ? groups.running.length : groups.completed.length;
    this.weatherStage?.update(weather, weather === "drizzle" ? this.t(`${count} 件没做完`, `${count} unfinished`) : weather === "overcast" ? this.t(`${count} 件等你回应`, `${count} waiting for you`) : weather === "breeze" ? this.t(`${count} 件在跑`, `${count} in progress`) : weather === "fair" ? this.t(`今天做完 ${count} 件`, `${count} completed today`) : this.t("一切安静", "All quiet"));
    const pending = this.plugin.getConversationRunService().pendingInteractions;
    groups.waiting.sort((a, b) => (pending.get(a.conversationId)?.createdAt ?? a.updatedAt) - (pending.get(b.conversationId)?.createdAt ?? b.updatedAt));
    for (const [state, zh, en] of [["waiting", "等你回应", "Waiting for you"], ["running", "正在进行", "In progress"], ["interrupted", "没做完", "Not finished"]] as const) {
      this.taskGroup(state, this.t(zh, en), groups[state], now);
    }
    this.renderSignals();
    this.taskGroup("completed", this.t("今天完成", "Completed today"), groups.completed, now);
    this.renderTodos();
    this.updateActionStates();
    this.field("empty").hidden = !this.entries || !this.snapshot || !!this.taskError || !!this.dataError || !!this.snapshot.issues.length || this.field("groups").children.length > 0 || !!this.starters;
    this.updateSelection();
    this.contentEl.scrollTop = oldScroll;
    if (focus && active && !active.isConnected) {
      const target = Array.from(this.field("groups").querySelectorAll<HTMLElement>("[data-wb-focus]")).find(node => node.dataset.wbFocus === focus);
      const group = Array.from(this.field("groups").children).find(node => (node as HTMLElement).dataset.wbGroup === oldGroup) as HTMLElement | undefined;
      ((target?.matches(":disabled") ? null : target) ?? group?.querySelector<HTMLElement>("button:not(:disabled)") ?? group?.querySelector<HTMLElement>("h2") ?? this.field("groups").querySelector<HTMLElement>("h2") ?? this.contentEl).focus({ preventScroll: true });
    }
  }
  private renderStatus(): void {
    const host = this.field("status");
    const previewErrors = [...this.completedPreviews.values()].flatMap(preview => preview.error ? [preview.error] : []);
    const signature = JSON.stringify([this.language, !!this.entries, !!this.snapshot, this.taskError, this.dataError, this.memoryError, this.snapshot?.issues, previewErrors]);
    if (host.dataset.signature === signature) return;
    this.disposeControls(host); host.empty(); host.dataset.signature = signature;
    if (!this.entries && !this.taskError) host.createDiv({ text: this.t("正在读取任务…", "Reading tasks…"), attr: { "aria-busy": "true" } });
    if (!this.snapshot && !this.dataError) host.createDiv({ text: this.t("正在查看本地事项…", "Checking local items…"), attr: { "aria-busy": "true" } });
    if (this.taskError || this.dataError || this.memoryError || this.snapshot?.issues.length || previewErrors.length) {
      const row = host.createDiv({ cls: "wb-error", attr: { role: "status" } });
      const copy = row.createDiv({ cls: "wb-grow" });
      if (this.memoryError) copy.createDiv({ text: this.t("记忆暂时读不到", "Memory unavailable") });
      if (this.taskError) copy.createDiv({ text: this.t(`任务暂时读不到${this.entries ? "，尚未更新" : ""}`, `Tasks unavailable${this.entries ? "; not updated" : ""}`) });
      if (this.dataError) copy.createDiv({ text: this.t(`本地事项暂时读不到${this.snapshot ? "，尚未更新" : ""}`, `Local items unavailable${this.snapshot ? "; not updated" : ""}`) });
      if (this.snapshot?.issues.length) copy.createDiv({ text: this.t("部分事项暂时无法确认", "Some items could not be checked") });
      if (previewErrors.length) copy.createDiv({ text: this.t("部分任务结果暂时读不到", "Some task results are unavailable") });
      const details = copy.createEl("details");
      details.createEl("summary", { text: this.t("查看原因", "Details") });
      for (const reason of [this.taskError, this.dataError, this.memoryError, ...(this.snapshot?.issues ?? []), ...previewErrors].filter((value): value is string => !!value)) details.createDiv({ text: reason });
      this.button(row, this.t("重试", "Retry"), "retry", async () => {
        if (this.memoryError) await this.plugin.resolveVaultMemory("retry");
        for (const [id, preview] of this.completedPreviews) if (preview.error) this.completedPreviews.delete(id);
        return this.refresh();
      }, "secondary");
    }
  }

  private group(key: string, title: string, count: number, list: boolean): HTMLElement | null {
    const host = this.field("groups");
    let section = Array.from(host.children).find(node => (node as HTMLElement).dataset.wbGroup === key) as HTMLElement | undefined;
    if (!section) {
      section = host.createEl("section", { cls: "wb-section", attr: { "data-wb-group": key } });
      const heading = section.createDiv({ cls: "wb-section-heading" });
      heading.createEl("h2", { attr: { tabindex: "-1" } });
      heading.createSpan({ cls: "wb-count" });
      section.createDiv({ cls: "wb-group-status", attr: { role: "status", "aria-live": "polite" } });
      section.createDiv({ cls: list ? "wb-rows" : "wb-grid" });
    }
    section.querySelector("h2")!.textContent = title;
    const taskGroup = !["signals", "todos"].includes(key);
    const available = taskGroup ? this.entries !== null : this.snapshot !== null;
    const error = taskGroup ? this.taskError : this.dataError;
    const uncertain = !taskGroup && !!this.snapshot?.issues.some(issue => key === "signals" || /待办|工作区仍在加载/u.test(issue));
    const status = error ? "error" : !available ? "loading" : uncertain ? "unconfirmed" : count ? "ready" : "empty";
    if (status === "empty") { this.disposeControls(section); section.remove(); return null; }
    section.dataset.state = status;
    const counter = section.querySelector<HTMLElement>(".wb-count")!;
    counter.hidden = status === "loading" || status === "error" || status === "unconfirmed";
    counter.textContent = counter.hidden ? "" : String(count);
    const feedback = section.querySelector<HTMLElement>(".wb-group-status")!;
    this.disposeControls(feedback); feedback.empty();
    feedback.hidden = status === "ready";
    feedback.setAttribute("aria-busy", String(status === "loading"));
    if (status === "loading") feedback.createSpan({ text: this.t("正在读取…", "Reading…") });
    else if (status === "error") {
      feedback.createSpan({ text: available ? this.t("读取失败，尚未更新", "Could not refresh; showing previous items") : this.t("读取失败", "Could not read items") });
      this.button(feedback, this.t("重试", "Retry"), `retry-${key}`, () => this.refresh(), "tertiary");
    } else if (status === "unconfirmed") feedback.createSpan({ text: this.t("部分事项尚未确认", "Some items have not been checked") });
    section.lastElementChild?.classList.toggle("is-empty", !count);
    // Reorder only when a group appears; retained rows and focused controls stay put.
    const order = ["waiting", "running", "interrupted", "signals", "completed", "todos"];
    const next = Array.from(host.children).find(node => order.indexOf((node as HTMLElement).dataset.wbGroup!) > order.indexOf(key));
    if (next && section.nextElementSibling !== next) host.insertBefore(section, next);
    return section;
  }
  private syncRows<T>(host: HTMLElement, items: readonly T[], key: (item: T) => string, signature: (item: T) => string, build: (item: T) => HTMLElement): void {
    const wanted = new Set(items.map(key));
    for (const node of Array.from(host.children) as HTMLElement[]) if (!wanted.has(node.dataset.key!)) { this.disposeControls(node); node.remove(); }
    items.forEach((item, index) => {
      const id = key(item), version = signature(item);
      let node = Array.from(host.children).find(node => (node as HTMLElement).dataset.key === id) as HTMLElement | undefined;
      if (!node || node.dataset.signature !== version) {
        const replacement = build(item); replacement.dataset.key = id; replacement.dataset.signature = version;
        if (node) { this.disposeControls(node); node.replaceWith(replacement); }
        node = replacement;
      }
      if (host.children[index] !== node) host.insertBefore(node, host.children[index] ?? null);
    });
    this.syncTaskCardFeedback();
  }
  private syncTaskCardFeedback(): void {
    if (this.closed) return;
    for (const [card, body] of this.taskCardBodies) {
      card.classList.toggle("has-active-task-body", body.matches(":hover") || body.matches(":focus-visible"));
    }
  }
  private disposeControls(root: HTMLElement): void {
    for (const card of this.taskCardBodies.keys()) if (root === card || root.contains(card)) {
      card.classList.remove("has-active-task-body"); this.taskCardBodies.delete(card);
    }
    disposeOriginControls(root);
  }
  private taskGroup(state: keyof TaskGroups, title: string, entries: readonly TaskEntry[], now: number): void {
    const section = this.group(state, title, entries.length, state === "completed");
    if (!section) return;
    const host = section.lastElementChild as HTMLElement;
    this.syncRows(host, entries, entry => entry.conversationId,
      entry => JSON.stringify([this.language, entry, this.maintenance.get(entry.conversationId), this.agent(entry), this.summary(entry), this.pending(entry), this.interruptions.get(entry.conversationId), this.plugin.taskToolCallRecovery?.(entry.conversationId, this.interruptions.get(entry.conversationId)), this.interruptionErrors.has(entry.conversationId), !!this.taskError]),
      entry => state === "completed" ? this.completedRow(entry) : this.taskCard(entry));
    host.querySelectorAll<HTMLElement>("[data-started-at]").forEach(time => { time.textContent = this.elapsed(Number(time.dataset.startedAt), now); });
  }
  private agent(entry: TaskEntry): AgentDefinition {
    const registry = this.plugin.settings.agentRegistry;
    return registry.agents.find(agent => agent.id === (entry.agentId ?? GENERAL_ASSISTANT_ID)) ?? registry.agents.find(agent => agent.id === GENERAL_ASSISTANT_ID)!;
  }
  private pending(entry: TaskEntry): Readonly<EchoInkTurnInteraction> | undefined { return this.plugin.getConversationRunService().pendingInteractions.get(entry.conversationId); }
  private summary(entry: TaskEntry): string {
    const activity = this.maintenance.get(entry.conversationId);
    if (activity) return maintenanceActivityText(activity, this.language === "en");
    const session = this.plugin.settings.sessions.find(session => session.id === entry.conversationId);
    if (taskState(entry) === "completed" && !session?.messages.some(item => item.role === "assistant" && item.text.trim())) {
      const preview = this.completedPreviews.get(entry.conversationId);
      if (preview?.revision !== this.completedPreviewRevision(entry)) return this.t("正在读取结果…", "Reading result…");
      return preview.error ? this.t("结果暂时读不到", "Result unavailable") : preview.text || this.t("未记录结果摘要", "No result summary recorded");
    }
    return (taskState(entry) === "interrupted" ? this.interruptions.get(entry.conversationId)?.stage : "") || taskSummary(entry, session, this.language, this.pending(entry));
  }
  private completedPreviewRevision(entry: TaskEntry): string { return JSON.stringify([entry.piSessionId, entry.updatedAt, entry.taskCompletedAt, entry.taskMetadataUpdatedAt]); }
  /** Same read-only projection as P3; retain only today's plain-text summaries. */
  private async loadCompletedPreviews(entries: readonly TaskEntry[], version: number, now: number): Promise<void> {
    const missing = entries.filter(entry => !this.maintenance.has(entry.conversationId) && !this.plugin.settings.sessions.find(session => session.id === entry.conversationId)?.messages.some(item => item.role === "assistant" && item.text.trim())
      && this.completedPreviews.get(entry.conversationId)?.revision !== this.completedPreviewRevision(entry));
    let next = 0;
    const worker = async () => {
      while (next < missing.length && this.active() && version === this.refreshVersion) {
        const entry = missing[next++], revision = this.completedPreviewRevision(entry);
        try {
          const projection = await this.plugin.readPiConversationProjection(entry.conversationId);
          if (!this.active() || version !== this.refreshVersion) return;
          const hasAnswer = projection.messages.some(item => item.role === "assistant" && item.text.trim());
          this.completedPreviews.set(entry.conversationId, { revision, text: hasAnswer ? taskSummary(entry, projection, this.language) : "", type: workbenchResultType(projection.messages, entry.taskStartedAt) });
        } catch (error) {
          if (!this.active() || version !== this.refreshVersion) return;
          this.completedPreviews.set(entry.conversationId, { revision, error: `${entry.title}：${message(error)}` });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(3, missing.length) }, worker));
    if (missing.length && this.active() && version === this.refreshVersion) this.render(now);
  }
  private taskCard(entry: TaskEntry): HTMLElement {
    const card = ownedEl(this.contentEl.ownerDocument, "article"); card.className = "wb-task"; card.dataset.task = entry.conversationId;
    card.oncontextmenu = event => { void openTaskMenu(this.plugin, event, entry.conversationId, () => this.scheduleRefresh(0)); };
    card.onclick = event => {
      if ((event.target as Element).closest("button, input, textarea, select, label, a, summary")) return;
      void this.openTask(entry.conversationId).catch(error => new Notice(message(error)));
    };
    const activity = this.maintenance.get(entry.conversationId), state = this.taskState(entry), agent = this.agent(entry);
    const body = this.button(card, "", `task-${entry.conversationId}`, () => this.openTask(entry.conversationId), "tertiary");
    body.classList.add("wb-task-body");
    this.taskCardBodies.set(card, body);
    const title = activity ? maintenanceTaskTitle(activity, this.language === "en") : entry.title;
    setTooltip(body, `${title}\n${taskCardHintSummary(this.summary(entry))}`, { classes: ["echoink-task-card-tooltip"] });
    const header = body.createSpan({ cls: "wb-task-header" }); renderTaskAvatar(header, agent);
    header.createSpan({ cls: "wb-agent-name", text: agent.name });
    const status = header.createSpan({ cls: `wb-task-status is-${state}` });
    if (state === "running") {
      const spinner = status.createSpan({ cls: "wb-spinner wb-status-icon", attr: { "aria-hidden": "true" } }); setIcon(spinner, "loader-circle");
      status.createSpan({ text: this.t("进行中", "Running") });
      const started = !activity && (this.plugin.getConversationRunService().runs.get(entry.conversationId)?.turnStartedAt || entry.taskStartedAt);
      if (started) status.createSpan({ attr: { "data-started-at": String(started) } });
    } else { setIcon(status.createSpan({ cls: "wb-status-icon", attr: { "aria-hidden": "true" } }), state === "waiting" ? "message-circle" : "circle-pause"); status.createSpan({ text: taskStateLabel({ ...entry, taskStatus: state, ...(state !== "waiting" ? { pendingResponse: undefined } : {}) }, this.language) }); }
    body.createSpan({ cls: "wb-task-title", text: title });
    const inline = state === "waiting" ? workbenchInlineQuestion(entry, this.pending(entry)) : undefined;
    const recovery = state === "interrupted" ? this.plugin.taskToolCallRecovery?.(entry.conversationId, this.interruptions.get(entry.conversationId)) : undefined;
    const step = recovery?.message ?? (activity && state === "interrupted" ? undefined : activity ? this.summary(entry) : inline ? entry.taskStage : this.summary(entry));
    if (step && !(state === "interrupted" && step === this.t("没做完", "Not finished"))) body.createSpan({ cls: `wb-task-step${activity ? " wb-maintenance-summary" : ""}`, text: state === "interrupted" && !activity && !recovery ? this.t(`停在：${step}`, `Stopped at: ${step}`) : step });
    if (activity) renderMaintenanceProgressBar(body, activity);
    if (state === "interrupted") {
      const footer = card.createDiv({ cls: "wb-task-footer" });
      const info = this.interruptions.get(entry.conversationId);
      const interruptedAt = info?.at ?? entry.taskInterruptedAt ?? entry.updatedAt;
      footer.createSpan({ cls: "wb-interruption wb-grow", text: recovery ? `${localDateLabel(interruptedAt, Date.now(), this.language)} ${localTaskTime(interruptedAt)}` : activity ? this.summary(entry) : this.interruptionText(entry, info) });
      const key = `resume-${entry.conversationId}`;
      const pending = this.busy.has(key) || !!this.plugin.isTaskResuming?.(entry.conversationId);
      const report = this.button(footer, this.t("上报问题", "Report a problem"), `report-${entry.conversationId}`, () => this.plugin.openRunReport(entry.conversationId), "secondary");
      report.classList.add("is-small"); report.disabled = pending; report.dataset.action = "report-task";
      report.dataset.wbBusy = key; report.dataset.wbSource = "tasks";
      const resume = this.button(footer, pending ? this.t("正在核对…", "Checking…") : recovery?.enable ? this.t("开启工具调用并继续", "Enable tools and continue") : this.t("继续", "Continue"), key,
        () => this.runAction(key, async () => { this.selectedTask = entry.conversationId; await this.plugin.resumeTaskAndOpenDetail(entry.conversationId); }), "primary");
      resume.classList.add("is-small"); resume.disabled = !!this.taskError || pending; setAmicroButtonPending(resume, pending);
      resume.dataset.wbMemory = "true"; resume.dataset.wbBusy = key; resume.dataset.wbSource = "tasks"; resume.dataset.wbResume = "true";
    } else if (activity?.taskKind === "upgrade" && state === "running") {
      const footer = card.createDiv({ cls: "wb-task-footer" }), key = `stop-upgrade-${entry.conversationId}`;
      const stop = this.button(footer, this.t("停止", "Stop"), key, () => this.runAction(key, async () => {
        const current = maintenanceActivityForTask(entry, this.plugin.getKnowledgeActivitySource?.()?.snapshot().maintenance ?? []);
        const service = this.plugin.getKnowledgeSurfaceService() as Partial<MaintenanceUpgradeSurface> | null;
        const snapshot = await service?.getUpgradeSnapshot?.();
        if (current?.taskKind !== "upgrade" || current.originConversationId !== entry.conversationId || snapshot?.taskId !== entry.conversationId || snapshot.status !== "running" || !service?.stopUpgrade) throw new Error(this.t("升级任务已更新，请重新打开", "Upgrade task changed. Reopen it."));
        await service.stopUpgrade();
      }), "secondary", "square");
      stop.classList.add("is-small"); stop.disabled = this.busy.has(key); setAmicroButtonPending(stop, this.busy.has(key));
      stop.dataset.wbBusy = key; stop.dataset.wbSource = "tasks";
    } else if (state === "waiting") {
      const question = workbenchInlineQuestion(entry, this.pending(entry));
      const ask = card.createDiv({ cls: "wb-question" });
      if (question) {
        ask.createDiv({ text: question.prompt });
        const options = ask.createDiv({ cls: "wb-options" });
        const key = `answer-${entry.conversationId}`;
        for (const option of question.options) {
          const button = this.button(options, option.label, `${key}-${option.optionId}`,
            () => this.runAction(key, async () => { await answerWorkbenchQuestion(this.plugin, entry, question.questionId, option.optionId); }), "secondary");
          button.classList.add("is-small"); attachNativeTooltip(button, option.description ?? option.label);
          button.disabled = !!this.taskError || this.busy.has(key); setAmicroButtonPending(button, this.busy.has(key));
          button.dataset.wbMemory = "true"; button.dataset.wbBusy = key; button.dataset.wbSource = "tasks";
        }
      } else if (entry.pendingResponse?.kind === "confirmation") {
        ask.createDiv({ cls: "wb-options" });
        this.button(ask.lastElementChild as HTMLElement, this.t("查看并确认", "Review and confirm"), `detail-${entry.conversationId}`, () => this.openTask(entry.conversationId), "tertiary").classList.add("is-small");
      }
    }
    return card;
  }
  private interruptionText(entry: TaskEntry, info: TaskInterruptionInfo | null | undefined): string {
    const at = info?.at ?? entry.taskInterruptedAt;
    const time = at === undefined ? "" : `${localDateLabel(at, Date.now(), this.language)} ${localTaskTime(at)} · `;
    if (this.interruptionErrors.has(entry.conversationId)) return `${time}${this.t("中断记录暂时读不到", "Interruption details unavailable")}`;
    if (info === undefined) return `${time}${this.t("正在读取中断记录…", "Reading interruption details…")}`;
    if (!info) return `${time}${this.t("中断原因未记录", "Cause was not recorded")}`;
    const reasons: Record<TaskInterruptionInfo["reason"], [string, string]> = {
      app_closed: ["关闭 Obsidian 时中断", "Obsidian closed"], user_stopped: ["被你停止", "Stopped by you"],
      plugin_disabled: ["插件关闭时中断", "Plugin stopped"], run_failed: ["执行失败后中断", "Execution failed"],
      process_unknown: ["意外中断", "Unexpected interruption"], watchdog: ["等待超时后中断", "Timed out"]
    };
    return `${time}${this.t(...reasons[info.reason])}${info.detail ? ` · ${info.detail}` : ""}`;
  }
  private interruptionRevision(entry: TaskEntry): string { return JSON.stringify([entry.updatedAt, entry.taskMetadataUpdatedAt, entry.taskInterruptedAt, entry.taskStage]); }
  private completedRow(entry: TaskEntry): HTMLElement {
    const row = ownedDiv(this.contentEl.ownerDocument); row.className = "wb-completed"; row.dataset.task = entry.conversationId;
    row.oncontextmenu = event => { void openTaskMenu(this.plugin, event, entry.conversationId, () => this.scheduleRefresh(0)); };
    const button = this.button(row, "", `task-${entry.conversationId}`, () => this.openTask(entry.conversationId), "tertiary"); button.classList.add("wb-completed-body");
    const agent = this.agent(entry), activity = this.maintenance.get(entry.conversationId);
    const session = this.plugin.settings.sessions.find(session => session.id === entry.conversationId);
    const type = session?.messages.some(message => message.role === "assistant") ? workbenchResultType(session.messages, entry.taskStartedAt) : this.completedPreviews.get(entry.conversationId)?.type ?? "answer";
    const kind = button.createSpan({ cls: "wb-result-kind", attr: { "aria-label": type === "note" ? this.t("存成笔记", "Saved note") : type === "plan" ? this.t("计划", "Plan") : this.t("回答", "Answer") } });
    setIcon(kind, type === "note" ? "file-text" : type === "plan" ? "list-checks" : "message-square-text");
    const title = activity ? maintenanceTaskTitle(activity, this.language === "en") : entry.title;
    const copy = button.createSpan({ cls: "wb-grow" }); copy.createSpan({ cls: "wb-row-title", text: title });
    const sub = copy.createSpan({ cls: "wb-completed-sub" }); renderTaskAvatar(sub, agent, 16);
    sub.createSpan({ cls: "wb-completed-agent", text: agent.name }); sub.createSpan({ cls: "wb-secondary", text: `· ${this.summary(entry)}` });
    if (activity) { copy.classList.add("wb-maintenance-completed"); renderMaintenanceProgressBar(copy, activity); }
    if (entry.unreadAnswerAt !== undefined) { button.createSpan({ cls: "wb-unread", attr: { "aria-hidden": "true" } }); button.setAttribute("aria-label", `${title}，${this.t("有新结果", "New result")}`); }
    const completedAt = activity?.completedAt ?? entry.taskCompletedAt ?? entry.updatedAt;
    button.createEl("time", { cls: "wb-time", text: localTaskTime(completedAt), attr: { datetime: new Date(completedAt).toISOString() } });
    return row;
  }
  private remainingSignals(signals: readonly WorkbenchSignal[]): WorkbenchSignal[] {
    const activeIds = new Set((this.entries ?? []).filter(entry => entry.status === "active" && isUserTask(entry)).map(entry => entry.conversationId));
    const covered = new Set([...this.maintenance.values()].filter(activity => activeIds.has(activity.originConversationId) && activity.status !== "completed").flatMap(activity => activity.sourcePaths));
    return workbenchSignalsWithoutActiveMaintenance(signals, covered, this.language === "en");
  }
  private renderSignals(): void {
    const signals = this.remainingSignals(this.snapshot?.signals ?? []);
    const section = this.group("signals", this.t("可以交给 Agent", "Ready for an Agent"), signals.length, true);
    if (!section) return;
    const heading = section.firstElementChild as HTMLElement;
    let toggle = heading.querySelector<HTMLButtonElement>("[data-wb=signal-toggle]");
    if (signals.length > 5) {
      if (!toggle) {
        toggle = this.button(heading, "", "signal-toggle", () => { this.signalsExpanded = !this.signalsExpanded; this.render(); }, "tertiary");
        toggle.dataset.wb = "signal-toggle";
      }
      toggle.textContent = this.signalsExpanded ? this.t("收起", "Collapse") : this.t(`还有 ${signals.length - 5} 条`, `${signals.length - 5} more`);
      toggle.setAttribute("aria-expanded", String(this.signalsExpanded)); toggle.setAttribute("aria-controls", `${this.id}-signals`);
    } else if (toggle) { this.disposeControls(toggle); toggle.remove(); }
    const host = section.lastElementChild as HTMLElement; host.id = `${this.id}-signals`;
    this.syncRows(host, this.signalsExpanded ? signals : signals.slice(0, 5), signal => signal.key,
      signal => JSON.stringify([this.language, signal, this.plugin.settings.agentRegistry, !!this.dataError]),
      signal => {
        const row = ownedDiv(this.contentEl.ownerDocument); row.className = "wb-row";
        const icon = row.createSpan({ cls: "wb-lead", attr: { "aria-hidden": "true" } }); setIcon(icon, signal.icon);
        row.createSpan({ cls: "wb-grow", text: signal.description });
        const registry = this.plugin.settings.agentRegistry;
        const owner = registry.agents.find(agent => agent.id === registry.moduleOwners[signal.moduleId]) ?? registry.agents.find(agent => agent.id === GENERAL_ASSISTANT_ID)!;
        const key = `signal-${signal.key}`;
        const button = this.button(row, this.t(`交给 ${owner.name}`, `Assign to ${owner.name}`), key,
          () => this.runAction(key, async () => {
            await launchWorkbenchSignal(this.plugin, signal, { load: async now => {
              const current = await this.port.load(now);
              return { ...current, signals: this.remainingSignals(current.signals) };
            } });
          }), "secondary");
        button.classList.add("is-small"); button.disabled = !!this.dataError || this.busy.has(key); setAmicroButtonPending(button, this.busy.has(key));
        button.dataset.wbMemory = "true"; button.dataset.wbBusy = key; button.dataset.wbSource = "data";
        return row;
      });
  }
  private renderTodos(): void {
    const todos = this.snapshot?.todayTodos ?? [];
    const projects = getTodoProjects(this.plugin);
    const section = this.group("todos", this.t("今日待办", "Today's to-dos"), todos.length, true);
    if (!section) return;
    const heading = section.firstElementChild as HTMLElement;
    if (!heading.querySelector("button")) this.button(heading, this.t("全部待办", "All to-dos"), "all-todos", () => openWorkbenchModule(this.plugin, "todos"), "tertiary", "chevron-right");
    this.syncRows(section.lastElementChild as HTMLElement, todos, todo => this.todoKey(todo), todo => JSON.stringify([this.language, todo, resolveTodoProject(todo.project, projects), !!this.dataError]), todo => {
      const row = ownedDiv(this.contentEl.ownerDocument); row.className = "wb-row wb-todo";
      const key = this.todoKey(todo);
      const check = createOriginCheck(row, { cls: "wb-todo-check", attr: { "aria-label": this.t(`完成：${todo.title}`, `Complete: ${todo.title}`), "data-wb-focus": key } });
      check.checked = todo.done; check.disabled = !!this.dataError || this.busy.has(key);
      check.dataset.wbBusy = key; check.dataset.wbSource = "data";
      check.addEventListener("change", () => {
        check.checked = todo.done;
        void this.runAction(key, () => this.plugin.getTodoStore().toggleDone(todo, true)).catch(error => new Notice(message(error)));
      });
      const copy = row.createSpan({ cls: "wb-grow" });
      copy.createSpan({ text: todo.title });
      if (todo.project) {
        const project = resolveTodoProject(todo.project, projects);
        const label = project.status === "missing" ? this.t("项目已不存在", "Project no longer exists")
          : project.status === "ambiguous" ? this.t("有同名项目，请重新选择", "Choose between projects with the same name") : project.label;
        const tag = copy.createSpan({ cls: "wb-todo-project", text: label });
        setIcon(tag.createSpan({ attr: { "aria-hidden": "true" } }), "folder");
      }
      row.createSpan({ cls: "wb-time", text: todo.dueTime || this.t("今天", "Today") });
      return row;
    });
  }
  private todoKey(todo: ParsedTodoRecord): string { return `todo-${todo.id || `${todo.lineStart}-${todo.title}`}`; }
  private updateActionStates(): void {
    this.field("groups").querySelectorAll<HTMLButtonElement>("[data-wb-busy]").forEach(button => {
      const taskId = button.closest<HTMLElement>("[data-task]")?.dataset.task;
      const pending = this.busy.has(button.dataset.wbBusy!) || !!taskId && !!this.plugin.isTaskResuming?.(taskId);
      button.disabled = pending || !!(button.dataset.wbSource === "tasks" ? this.taskError : this.dataError)
        || button.dataset.wbMemory === "true" && !!(this.memoryNotice || this.memoryError);
      setAmicroButtonPending(button, pending);
      if (button.dataset.wbResume) {
        const recovery = taskId ? this.plugin.taskToolCallRecovery?.(taskId, this.interruptions.get(taskId)) : undefined;
        for (const child of Array.from(button.childNodes)) if (child.nodeType === 3) child.textContent = pending ? this.t("正在核对…", "Checking…") : recovery?.enable ? this.t("开启工具调用并继续", "Enable tools and continue") : this.t("继续", "Continue");
      }
    });
  }
  private async runAction(key: string, action: () => Promise<unknown>): Promise<void> {
    if (this.busy.has(key)) return;
    this.busy.add(key); this.render();
    try { await action(); }
    finally { this.busy.delete(key); if (!this.closed) { this.render(); this.scheduleRefresh(0); } }
  }
  private async openTask(id: string): Promise<void> { this.selectedTask = id; this.updateSelection(); await this.plugin.openTaskDetail(id); }
  private updateSelection(): void { this.field("groups").querySelectorAll<HTMLElement>("[data-task]").forEach(node => { const selected = node.dataset.task === this.selectedTask; node.classList.toggle("is-current", selected); node.querySelector("button")?.setAttribute("aria-current", selected ? "true" : "false"); }); }
  private elapsed(started: number, now: number): string { const minutes = Math.floor(Math.max(0, now - started) / 60_000); return minutes < 1 ? this.t("不足 1 分钟", "<1 min") : this.t(`${minutes} 分钟`, `${minutes} min`); }

  private renderSearchShell(parent: HTMLElement): void {
    const search = parent.createDiv({ cls: "wb-search", attr: { "data-wb": "search" } }); search.hidden = true;
    const line = search.createDiv({ cls: "wb-search-line" });
    const icon = line.createSpan({ cls: "wb-search-icon", attr: { "aria-hidden": "true" } }); setIcon(icon, "search");
    createOriginInput(line, { cls: "wb-search-input", attr: { "data-wb": "search-input", role: "combobox", autocomplete: "off", "aria-autocomplete": "list", "aria-expanded": "false", "aria-label": this.t("搜索笔记", "Search notes"), "aria-controls": `${this.id}-results`, placeholder: this.t("搜索笔记…", "Search notes…") } });
    this.button(line, this.t("关闭搜索", "Close search"), "search-close", () => this.closeSearch(true), "icon", "x");
    const panel = search.createDiv({ cls: "wb-search-panel" });
    panel.createDiv({ cls: "wb-search-heading", attr: { "data-wb": "search-heading", "aria-live": "polite" } });
    panel.createDiv({ cls: "wb-search-results", attr: { "data-wb": "search-results", id: `${this.id}-results`, role: "listbox", "aria-label": this.t("搜索结果", "Search results") } });
    panel.createDiv({ cls: "wb-search-empty", text: this.t("没有找到笔记", "No notes found"), attr: { "data-wb": "search-empty" } });
    panel.createDiv({ cls: "wb-search-hint", attr: { "data-wb": "search-hint" } });
    this.field("search-trigger").setAttribute("aria-expanded", "false"); this.field("search-trigger").setAttribute("aria-controls", `${this.id}-results`);
  }
  private openSearch(): void { this.searchOpen = true; this.field("search").hidden = false; this.field("search-trigger").setAttribute("aria-expanded", "true"); this.field("search-input").setAttribute("aria-expanded", "true"); this.field("search-input").focus(); this.scheduleSearch(); }
  private closeSearch(focus: boolean): void {
    this.stopSearchWork(); if (!this.searchOpen) return;
    this.searchOpen = false; this.searchMatches = []; this.searchIndex = -1; this.searchResolvedQuery = null;
    this.field("search").hidden = true; (this.field("search-input") as HTMLInputElement).value = "";
    this.field("search-input").setAttribute("aria-expanded", "false"); this.field("search-input").removeAttribute("aria-activedescendant"); this.field("search-trigger").setAttribute("aria-expanded", "false");
    if (focus) this.field("search-trigger").focus();
  }
  private stopSearchWork(): void {
    if (this.searchTimer !== null) this.contentEl.ownerDocument.defaultView?.clearTimeout(this.searchTimer);
    this.searchTimer = null; this.searchAbort?.abort(); this.searchAbort = null; this.searchResolvedQuery = null; this.searchService.clear();
  }
  private scheduleSearch(): void {
    if (!this.searchOpen || !this.active()) return;
    this.searchAbort?.abort(); this.searchResolvedQuery = null; this.searchMatches = []; this.searchIndex = -1;
    this.field("search-input").removeAttribute("aria-activedescendant"); this.disposeControls(this.field("search-results")); this.field("search-results").empty(); this.field("search-empty").hidden = true;
    this.field("search-heading").textContent = this.t("正在查找…", "Searching…");
    const win = this.contentEl.ownerDocument.defaultView;
    if (this.searchTimer !== null) win?.clearTimeout(this.searchTimer);
    this.searchTimer = win?.setTimeout(() => { this.searchTimer = null; void this.runSearch(); }, 100) ?? null;
  }
  private async runSearch(): Promise<void> {
    if (!this.searchOpen || !this.active()) return;
    const abort = new AbortController(); this.searchAbort = abort;
    const query = (this.field("search-input") as HTMLInputElement).value;
    try {
      const result = await this.searchService.search(query, abort.signal);
      if (abort.signal.aborted || !this.searchOpen || !this.active() || query !== (this.field("search-input") as HTMLInputElement).value) return;
      this.searchResolvedQuery = query; this.searchMatches = result.matches; this.searchIndex = -1;
      const host = this.field("search-results"); this.disposeControls(host); host.empty();
      this.field("search-heading").textContent = this.t(`找到 ${result.count} 篇笔记`, `${result.count} notes found`);
      result.matches.forEach((match, index) => {
        const option = this.button(host, "", `search-${index}`, async () => { this.closeSearch(true); await this.openNote(match.path); }, "tertiary");
        option.classList.add("wb-search-result"); option.dataset.searchIndex = String(index); option.id = `${this.id}-option-${index}`; option.tabIndex = -1;
        option.setAttribute("role", "option"); option.setAttribute("aria-selected", "false");
        const icon = option.createSpan({ cls: "wb-result-icon", attr: { "aria-hidden": "true" } }); setIcon(icon, "file-text");
        const copy = option.createSpan({ cls: "wb-grow" }); copy.createEl("strong", { text: match.title });
        copy.createSpan({ text: match.snippet || match.path }); copy.createSpan({ cls: "wb-secondary", text: `${match.path} · ${formatHomeRelativeTime(match.mtime, this.language)}` });
      });
      this.field("search-empty").hidden = result.count > 0;
      this.field("search-hint").textContent = result.failed ? this.t(`${result.failed} 篇笔记读取失败`, `${result.failed} notes could not be read`) : this.t("↑ ↓ 选择 · Enter 打开 · 最多显示 6 项", "↑ ↓ Select · Enter Open · Up to 6 results");
    } catch { if (!abort.signal.aborted && this.active()) this.field("search-heading").textContent = this.t("搜索失败，请重试", "Search failed. Try again."); }
  }
  private handleKeys(event: KeyboardEvent): void {
    if (isImeKeyEvent(event)) return;
    if (this.lockedModule) {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); this.closeModuleLock(); }
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); event.stopPropagation(); this.openSearch(); return; }
    if (!this.searchOpen) return;
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); this.closeSearch(true); return; }
    if ((event.target as HTMLElement).dataset.wb !== "search-input") return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault(); if (!this.searchMatches.length) return;
      const count = this.searchMatches.length;
      this.selectSearchIndex(this.searchIndex < 0 ? (event.key === "ArrowUp" ? count - 1 : 0) : (this.searchIndex + (event.key === "ArrowDown" ? 1 : -1) + count) % count, true);
    }
    if (event.key === "Enter") {
      event.preventDefault(); if (this.searchResolvedQuery !== (this.field("search-input") as HTMLInputElement).value) return;
      const match = this.searchMatches[Math.max(0, this.searchIndex)];
      if (match) { this.closeSearch(true); void this.openNote(match.path).catch(error => new Notice(message(error))); }
    }
  }
  private selectSearchIndex(index: number, scroll: boolean): void {
    if (!Number.isInteger(index) || index < 0 || index >= this.searchMatches.length) return;
    this.searchIndex = index;
    const options = this.field("search-results").querySelectorAll<HTMLElement>("[role=option]");
    options.forEach((node, current) => node.setAttribute("aria-selected", String(current === index)));
    const option = options[index]; if (!option) return;
    this.field("search-input").setAttribute("aria-activedescendant", option.id);
    if (scroll) option.scrollIntoView({ block: "nearest" });
  }
  private async openNote(path: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) throw new Error(this.t("笔记已不存在", "This note no longer exists"));
    await this.app.workspace.getLeaf("tab").openFile(file, { active: true });
  }
}

function dayKey(at: number): string { const date = new Date(at); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`; }
function sameDay(a: number, b: number): boolean { return dayKey(a) === dayKey(b); }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
