import { getTodoProjects, resolveTodoProject } from "./todo-projects";
import { ItemView, Notice, TFile, WorkspaceLeaf, setIcon } from "obsidian";
import type CodexForObsidianPlugin from "../main";
import { GENERAL_ASSISTANT_ID, type AgentDefinition } from "../agents/types";
import { isUserTask, localDateLabel, localTaskTime, taskState, taskSummary, type TaskEntry } from "../agents/task-presentation";
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
import type { WorkbenchDataPort, WorkbenchSnapshot } from "./workbench-types";
import { answerWorkbenchQuestion, launchWorkbenchSignal } from "./task-launcher";
import { openWorkbenchModule, WORKBENCH_MODULES } from "./module-navigation";
import type { ParsedTodoRecord } from "./todo-markdown";

// Preserve existing desktop workspace restoration; the old view has its own ID.
export const VIEW_TYPE_ECHOINK_WORKBENCH = "codex-echoink-home";
type TaskGroups = Record<"interrupted" | "waiting" | "running" | "completed", TaskEntry[]>;
let viewId = 0;

export function groupWorkbenchTasks(entries: readonly TaskEntry[], now = Date.now()): TaskGroups {
  const groups: TaskGroups = { interrupted: [], waiting: [], running: [], completed: [] };
  for (const entry of entries) {
    if (entry.status !== "active" || !isUserTask(entry)) continue;
    const state = taskState(entry);
    if (state !== "completed" || sameDay(entry.taskCompletedAt ?? entry.updatedAt, now)) groups[state].push(entry);
  }
  groups.interrupted.sort((a, b) => (b.taskInterruptedAt ?? b.updatedAt) - (a.taskInterruptedAt ?? a.updatedAt));
  groups.waiting.sort((a, b) => a.updatedAt - b.updatedAt);
  groups.running.sort((a, b) => (a.taskStartedAt ?? a.updatedAt) - (b.taskStartedAt ?? b.updatedAt));
  groups.completed.sort((a, b) => (b.taskCompletedAt ?? b.updatedAt) - (a.taskCompletedAt ?? a.updatedAt));
  return groups;
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
  private interruptions = new Map<string, TaskInterruptionInfo | null>();
  private interruptionRevisions = new Map<string, string>();
  private interruptionErrors = new Set<string>();
  private readonly completedPreviews = new Map<string, { revision: string; text?: string; error?: string }>();
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
    this.closed = false;
    this.contentEl.addClass("echoink-workbench");
    this.contentEl.tabIndex = -1;
    this.renderShell();
    this.foreground = new ForegroundView(this, active => this.foregroundChanged(active));
    const service = this.plugin.getConversationRunService();
    this.unsubscribers.push(this.port.subscribe(() => this.scheduleRefresh()));
    this.unsubscribers.push(service.subscribe({ refresh: () => this.scheduleRefresh(), clearAcceptedDraft() {}, isTaskVisible: () => false }));
    this.registerDomEvent(this.contentEl, "keydown", event => this.handleKeys(event));
    this.registerDomEvent(this.contentEl, "input", event => {
      if ((event.target as HTMLElement).dataset.wb === "search-input" && !(event as InputEvent).isComposing) this.scheduleSearch();
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
    this.scheduleRefresh(0);
  }
  async onClose(): Promise<void> {
    this.closed = true; this.refreshVersion++;
    this.foreground?.dispose(); this.foreground = null;
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
    this.clearTimers(); this.stopSearchWork();
    disposeOriginControls(this.contentEl); this.contentEl.empty(); this.contentEl.removeClass("echoink-workbench");
  }
  private clearTimers(): void {
    const win = this.contentEl.ownerDocument.defaultView;
    if (this.refreshTimer !== null) win?.clearTimeout(this.refreshTimer);
    if (this.clockTimer !== null) win?.clearTimeout(this.clockTimer);
    this.refreshTimer = this.clockTimer = null;
  }
  private foregroundChanged(active: boolean): void {
    if (this.closed) return;
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
  async refresh(): Promise<void> {
    if (!this.active()) { this.refreshPending = true; return; }
    if (this.refreshFlight) { this.refreshPending = true; return this.refreshFlight; }
    this.refreshPending = false;
    const version = ++this.refreshVersion;
    const now = Date.now();
    this.refreshFlight = (async () => {
      const [tasks, snapshot] = await Promise.allSettled([this.plugin.listAgentTaskEntries(), this.port.load(now)]);
      if (!this.active() || version !== this.refreshVersion) return;
      if (tasks.status === "fulfilled") { this.entries = tasks.value; this.taskError = ""; }
      else this.taskError = message(tasks.reason);
      if (snapshot.status === "fulfilled") { this.snapshot = snapshot.value; this.dataError = ""; }
      else this.dataError = message(snapshot.reason);
      const groups = tasks.status === "fulfilled" ? groupWorkbenchTasks(tasks.value, now) : undefined;
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
    if (this.entries?.some(entry => entry.status === "active" && taskState(entry) === "running")) targets.push(now + 60_000);
    this.clockTimer = win?.setTimeout(() => { this.clockTimer = null; this.scheduleRefresh(0); }, Math.max(1, Math.min(...targets) - now + 25)) ?? null;
  }

  private button(parent: HTMLElement, text: string, key: string, action: () => unknown, variant: "primary" | "secondary" | "tertiary" | "icon" = "secondary", icon?: string): HTMLButtonElement {
    const button = createOriginButton(parent, { cls: `wb-button is-${variant}`, text, attr: { "data-wb-focus": key, ...(variant === "icon" ? { "aria-label": text, title: text } : {}) } });
    if (variant === "icon") button.textContent = "";
    applyAmicroButton(button, { variant });
    if (icon) { const node = button.createSpan({ cls: "wb-button-icon", attr: { "aria-hidden": "true" } }); setIcon(node, icon); button.prepend(node); }
    button.onclick = () => { void Promise.resolve().then(action).catch(error => new Notice(message(error))); };
    return button;
  }
  private renderShell(): void {
    disposeOriginControls(this.contentEl); this.contentEl.empty(); this.searchOpen = false;
    const page = this.contentEl.createDiv({ cls: "wb-page" });
    const header = page.createEl("header", { cls: "wb-header" });
    const titles = header.createDiv({ cls: "wb-heading" });
    titles.createEl("h1", { text: this.t("工作台", "Workbench") });
    titles.createEl("time", { cls: "wb-date", attr: { "data-wb": "date" } });
    const actions = header.createDiv({ cls: "wb-header-actions" });
    this.button(actions, this.t("搜索笔记", "Search notes"), "search-trigger", () => this.openSearch(), "icon", "search").dataset.wb = "search-trigger";
    this.button(actions, this.t("插件设置", "Plugin settings"), "settings", () => this.plugin.openEchoInkGeneralSettings(), "icon", "settings");
    this.button(actions, this.t("新任务", "New task"), "new-task", () => this.plugin.openAgentTaskList(GENERAL_ASSISTANT_ID), "primary", "plus");
    this.renderSearchShell(page);
    const nav = page.createEl("nav", { cls: "wb-modules", attr: { "data-wb": "modules", "aria-label": this.t("插件导航", "Modules") } });
    for (const module of WORKBENCH_MODULES) {
      const button = this.button(nav, this.language === "en" ? module.en : module.zh, `module-${module.id}`, () => openWorkbenchModule(this.plugin, module.id), "tertiary", module.icon);
      button.dataset.module = module.id; button.hidden = !this.snapshot?.modules.includes(module.id);
    }
    page.createDiv({ cls: "wb-status", attr: { "data-wb": "status", "aria-live": "polite" } });
    page.createDiv({ cls: "wb-groups", attr: { "data-wb": "groups" } });
    page.createDiv({ cls: "wb-empty", text: this.t("暂时没有待处理的事", "Nothing to handle right now"), attr: { "data-wb": "empty" } }).hidden = true;
    this.render();
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
      button.hidden = !this.snapshot?.modules.some(id => id === button.dataset.module);
    });
    this.renderStatus();
    const groups = groupWorkbenchTasks(this.entries ?? [], now);
    const pending = this.plugin.getConversationRunService().pendingInteractions;
    groups.waiting.sort((a, b) => (pending.get(a.conversationId)?.createdAt ?? a.updatedAt) - (pending.get(b.conversationId)?.createdAt ?? b.updatedAt));
    for (const [state, zh, en] of [["interrupted", "上次中断", "Interrupted"], ["waiting", "等你回应", "Waiting for you"], ["running", "正在进行", "In progress"]] as const) {
      this.taskGroup(state, this.t(zh, en), groups[state], now);
    }
    this.renderSignals();
    this.taskGroup("completed", this.t("今天完成", "Completed today"), groups.completed, now);
    this.renderTodos();
    this.updateActionStates();
    this.field("empty").hidden = !this.entries || !this.snapshot || !!this.taskError || !!this.dataError || !!this.snapshot.issues.length || this.field("groups").children.length > 0;
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
    const signature = JSON.stringify([this.language, !!this.entries, !!this.snapshot, this.taskError, this.dataError, this.snapshot?.issues, previewErrors]);
    if (host.dataset.signature === signature) return;
    disposeOriginControls(host); host.empty(); host.dataset.signature = signature;
    if (!this.entries && !this.taskError) host.createDiv({ text: this.t("正在读取任务…", "Reading tasks…"), attr: { "aria-busy": "true" } });
    if (!this.snapshot && !this.dataError) host.createDiv({ text: this.t("正在查看本地事项…", "Checking local items…"), attr: { "aria-busy": "true" } });
    if (this.taskError || this.dataError || this.snapshot?.issues.length || previewErrors.length) {
      const row = host.createDiv({ cls: "wb-error", attr: { role: "status" } });
      const copy = row.createDiv({ cls: "wb-grow" });
      if (this.taskError) copy.createDiv({ text: this.t(`任务暂时读不到${this.entries ? "，尚未更新" : ""}`, `Tasks unavailable${this.entries ? "; not updated" : ""}`) });
      if (this.dataError) copy.createDiv({ text: this.t(`本地事项暂时读不到${this.snapshot ? "，尚未更新" : ""}`, `Local items unavailable${this.snapshot ? "; not updated" : ""}`) });
      if (this.snapshot?.issues.length) copy.createDiv({ text: this.t("部分事项暂时无法确认", "Some items could not be checked") });
      if (previewErrors.length) copy.createDiv({ text: this.t("部分任务结果暂时读不到", "Some task results are unavailable") });
      const details = copy.createEl("details");
      details.createEl("summary", { text: this.t("查看原因", "Details") });
      for (const reason of [this.taskError, this.dataError, ...(this.snapshot?.issues ?? []), ...previewErrors].filter(Boolean)) details.createDiv({ text: reason });
      this.button(row, this.t("重试", "Retry"), "retry", () => {
        for (const [id, preview] of this.completedPreviews) if (preview.error) this.completedPreviews.delete(id);
        return this.refresh();
      }, "secondary");
    }
  }

  private group(key: string, title: string, count: number, list: boolean): HTMLElement | null {
    const host = this.field("groups");
    let section = Array.from(host.children).find(node => (node as HTMLElement).dataset.wbGroup === key) as HTMLElement | undefined;
    if (!count) { if (section) { disposeOriginControls(section); section.remove(); } return null; }
    if (!section) {
      section = host.createEl("section", { cls: "wb-section", attr: { "data-wb-group": key } });
      const heading = section.createDiv({ cls: "wb-section-heading" });
      heading.createEl("h2", { attr: { tabindex: "-1" } });
      heading.createSpan({ cls: "wb-count" });
      section.createDiv({ cls: list ? "wb-rows" : "wb-grid" });
    }
    section.querySelector("h2")!.textContent = title;
    section.querySelector(".wb-count")!.textContent = String(count);
    // Reorder only when a group appears; retained rows and focused controls stay put.
    const order = ["interrupted", "waiting", "running", "signals", "completed", "todos"];
    const next = Array.from(host.children).find(node => order.indexOf((node as HTMLElement).dataset.wbGroup!) > order.indexOf(key));
    if (next && section.nextElementSibling !== next) host.insertBefore(section, next);
    return section;
  }
  private syncRows<T>(host: HTMLElement, items: readonly T[], key: (item: T) => string, signature: (item: T) => string, build: (item: T) => HTMLElement): void {
    const wanted = new Set(items.map(key));
    for (const node of Array.from(host.children) as HTMLElement[]) if (!wanted.has(node.dataset.key!)) { disposeOriginControls(node); node.remove(); }
    items.forEach((item, index) => {
      const id = key(item), version = signature(item);
      let node = Array.from(host.children).find(node => (node as HTMLElement).dataset.key === id) as HTMLElement | undefined;
      if (!node || node.dataset.signature !== version) {
        const replacement = build(item); replacement.dataset.key = id; replacement.dataset.signature = version;
        if (node) { disposeOriginControls(node); node.replaceWith(replacement); }
        node = replacement;
      }
      if (host.children[index] !== node) host.insertBefore(node, host.children[index] ?? null);
    });
  }
  private taskGroup(state: keyof TaskGroups, title: string, entries: readonly TaskEntry[], now: number): void {
    const section = this.group(state, title, entries.length, state === "completed");
    if (!section) return;
    const host = section.lastElementChild as HTMLElement;
    this.syncRows(host, entries, entry => entry.conversationId,
      entry => JSON.stringify([this.language, entry, this.agent(entry), this.summary(entry), this.pending(entry), this.interruptions.get(entry.conversationId), this.interruptionErrors.has(entry.conversationId), !!this.taskError]),
      entry => state === "completed" ? this.completedRow(entry) : this.taskCard(entry));
    host.querySelectorAll<HTMLElement>("[data-started-at]").forEach(time => { time.textContent = this.elapsed(Number(time.dataset.startedAt), now); });
  }
  private agent(entry: TaskEntry): AgentDefinition {
    const registry = this.plugin.settings.agentRegistry;
    return registry.agents.find(agent => agent.id === (entry.agentId ?? GENERAL_ASSISTANT_ID)) ?? registry.agents.find(agent => agent.id === GENERAL_ASSISTANT_ID)!;
  }
  private pending(entry: TaskEntry): Readonly<EchoInkTurnInteraction> | undefined { return this.plugin.getConversationRunService().pendingInteractions.get(entry.conversationId); }
  private summary(entry: TaskEntry): string {
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
    const missing = entries.filter(entry => !this.plugin.settings.sessions.find(session => session.id === entry.conversationId)?.messages.some(item => item.role === "assistant" && item.text.trim())
      && this.completedPreviews.get(entry.conversationId)?.revision !== this.completedPreviewRevision(entry));
    let next = 0;
    const worker = async () => {
      while (next < missing.length && this.active() && version === this.refreshVersion) {
        const entry = missing[next++], revision = this.completedPreviewRevision(entry);
        try {
          const projection = await this.plugin.readPiConversationProjection(entry.conversationId);
          if (!this.active() || version !== this.refreshVersion) return;
          const hasAnswer = projection.messages.some(item => item.role === "assistant" && item.text.trim());
          this.completedPreviews.set(entry.conversationId, { revision, text: hasAnswer ? taskSummary(entry, projection, this.language) : "" });
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
    const card = this.contentEl.ownerDocument.createElement("article"); card.className = "wb-task"; card.dataset.task = entry.conversationId;
    const state = taskState(entry), agent = this.agent(entry);
    const body = this.button(card, "", `task-${entry.conversationId}`, () => this.openTask(entry.conversationId), "tertiary");
    body.classList.add("wb-task-body"); body.setAttribute("aria-label", `${entry.title}，${this.summary(entry)}`);
    const header = body.createSpan({ cls: "wb-task-header" }); renderTaskAvatar(header, agent);
    header.createSpan({ cls: "wb-agent-name", text: agent.name });
    const status = header.createSpan({ cls: `wb-task-status is-${state}` });
    if (state === "running") {
      const spinner = status.createSpan({ cls: "wb-spinner", attr: { "aria-hidden": "true" } }); setIcon(spinner, "loader-circle");
      status.createSpan({ text: this.t("进行中", "Running") });
      const started = this.plugin.getConversationRunService().runs.get(entry.conversationId)?.turnStartedAt || entry.taskStartedAt;
      if (started) status.createSpan({ attr: { "data-started-at": String(started) } });
    } else { setIcon(status.createSpan({ attr: { "aria-hidden": "true" } }), state === "waiting" ? "message-circle" : "circle-pause"); status.createSpan({ text: state === "waiting" ? this.t("等你回应", "Waiting for you") : this.t("已中断", "Interrupted") }); }
    body.createSpan({ cls: "wb-task-title", text: entry.title });
    const inline = state === "waiting" ? workbenchInlineQuestion(entry, this.pending(entry)) : undefined;
    const step = inline ? entry.taskStage : this.summary(entry);
    if (step && !(state === "interrupted" && step === this.t("已中断", "Interrupted"))) body.createSpan({ cls: "wb-task-step", text: state === "interrupted" ? this.t(`停在：${step}`, `Stopped at: ${step}`) : step });
    if (state === "interrupted") {
      const footer = card.createDiv({ cls: "wb-task-footer" });
      const info = this.interruptions.get(entry.conversationId);
      footer.createSpan({ cls: "wb-interruption wb-grow", text: this.interruptionText(entry, info) });
      const key = `resume-${entry.conversationId}`;
      const resume = this.button(footer, this.busy.has(key) ? this.t("正在核对…", "Checking…") : this.t("继续", "Continue"), key,
        () => this.runAction(key, async () => { this.selectedTask = entry.conversationId; await this.plugin.resumeTaskAndOpenDetail(entry.conversationId); }), "secondary", "play");
      resume.classList.add("is-small"); resume.disabled = !!this.taskError || this.busy.has(key); setAmicroButtonPending(resume, this.busy.has(key));
      resume.dataset.wbBusy = key; resume.dataset.wbSource = "tasks"; resume.dataset.wbResume = "true";
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
          button.classList.add("is-small"); button.title = option.description ?? option.label;
          button.disabled = !!this.taskError || this.busy.has(key); setAmicroButtonPending(button, this.busy.has(key));
          button.dataset.wbBusy = key; button.dataset.wbSource = "tasks";
        }
        if (question.allowSupplement) this.button(options, this.t("查看并回答", "View and answer"), `detail-${entry.conversationId}`, () => this.openTask(entry.conversationId), "tertiary").classList.add("is-small");
      } else {
        ask.createDiv({ cls: "wb-options" });
        this.button(ask.lastElementChild as HTMLElement, entry.pendingResponse?.kind === "confirmation" ? this.t("查看并确认", "Review and confirm") : this.t("查看并回答", "View and answer"), `detail-${entry.conversationId}`, () => this.openTask(entry.conversationId), "tertiary").classList.add("is-small");
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
    const row = this.contentEl.ownerDocument.createElement("div"); row.className = "wb-completed"; row.dataset.task = entry.conversationId;
    const button = this.button(row, "", `task-${entry.conversationId}`, () => this.openTask(entry.conversationId), "tertiary"); button.classList.add("wb-completed-body");
    const agent = this.agent(entry); renderTaskAvatar(button, agent);
    const copy = button.createSpan({ cls: "wb-grow" }); copy.createSpan({ cls: "wb-row-title", text: entry.title });
    copy.createSpan({ cls: "wb-secondary", text: `${agent.name} · ${this.summary(entry)}` });
    if (entry.unreadAnswerAt !== undefined) { button.createSpan({ cls: "wb-unread", attr: { "aria-hidden": "true" } }); button.setAttribute("aria-label", `${entry.title}，${this.t("有新结果", "New result")}`); }
    button.createEl("time", { cls: "wb-time", text: localTaskTime(entry.taskCompletedAt ?? entry.updatedAt), attr: { datetime: new Date(entry.taskCompletedAt ?? entry.updatedAt).toISOString() } });
    return row;
  }
  private renderSignals(): void {
    const signals = this.snapshot?.signals ?? [];
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
    } else if (toggle) { disposeOriginControls(toggle); toggle.remove(); }
    const host = section.lastElementChild as HTMLElement; host.id = `${this.id}-signals`;
    this.syncRows(host, this.signalsExpanded ? signals : signals.slice(0, 5), signal => signal.key,
      signal => JSON.stringify([this.language, signal, this.plugin.settings.agentRegistry, !!this.dataError]),
      signal => {
        const row = this.contentEl.ownerDocument.createElement("div"); row.className = "wb-row";
        const icon = row.createSpan({ cls: "wb-lead", attr: { "aria-hidden": "true" } }); setIcon(icon, signal.icon);
        row.createSpan({ cls: "wb-grow", text: signal.description });
        const registry = this.plugin.settings.agentRegistry;
        const owner = registry.agents.find(agent => agent.id === registry.moduleOwners[signal.moduleId]) ?? registry.agents.find(agent => agent.id === GENERAL_ASSISTANT_ID)!;
        const key = `signal-${signal.key}`;
        const button = this.button(row, this.t(`交给 ${owner.name}`, `Assign to ${owner.name}`), key,
          () => this.runAction(key, async () => { await launchWorkbenchSignal(this.plugin, signal); }), "secondary");
        button.classList.add("is-small"); button.disabled = !!this.dataError || this.busy.has(key); setAmicroButtonPending(button, this.busy.has(key));
        button.dataset.wbBusy = key; button.dataset.wbSource = "data";
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
      const row = this.contentEl.ownerDocument.createElement("div"); row.className = "wb-row wb-todo";
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
      const pending = this.busy.has(button.dataset.wbBusy!);
      button.disabled = pending || !!(button.dataset.wbSource === "tasks" ? this.taskError : this.dataError);
      setAmicroButtonPending(button, pending);
      if (button.dataset.wbResume) {
        for (const child of Array.from(button.childNodes)) if (child.nodeType === 3) child.textContent = pending ? this.t("正在核对…", "Checking…") : this.t("继续", "Continue");
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
    this.field("search-input").removeAttribute("aria-activedescendant"); disposeOriginControls(this.field("search-results")); this.field("search-results").empty(); this.field("search-empty").hidden = true;
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
      const host = this.field("search-results"); disposeOriginControls(host); host.empty();
      this.field("search-heading").textContent = this.t(`找到 ${result.count} 篇笔记`, `${result.count} notes found`);
      result.matches.forEach((match, index) => {
        const option = this.button(host, "", `search-${index}`, async () => { this.closeSearch(true); await this.openNote(match.path); }, "tertiary");
        option.classList.add("wb-search-result"); option.dataset.searchIndex = String(index); option.id = `${this.id}-option-${index}`; option.tabIndex = -1;
        option.setAttribute("role", "option"); option.setAttribute("aria-selected", "false");
        const icon = option.createSpan({ attr: { "aria-hidden": "true" } }); setIcon(icon, "file-text");
        const copy = option.createSpan({ cls: "wb-grow" }); copy.createEl("strong", { text: match.title });
        copy.createSpan({ text: match.snippet || match.path }); copy.createSpan({ cls: "wb-secondary", text: `${match.path} · ${formatHomeRelativeTime(match.mtime, this.language)}` });
      });
      this.field("search-empty").hidden = result.count > 0;
      this.field("search-hint").textContent = result.failed ? this.t(`${result.failed} 篇笔记读取失败`, `${result.failed} notes could not be read`) : this.t("↑ ↓ 选择 · Enter 打开 · 最多显示 6 项", "↑ ↓ Select · Enter Open · Up to 6 results");
    } catch { if (!abort.signal.aborted && this.active()) this.field("search-heading").textContent = this.t("搜索失败，请重试", "Search failed. Try again."); }
  }
  private handleKeys(event: KeyboardEvent): void {
    if (event.isComposing || event.keyCode === 229) return;
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
