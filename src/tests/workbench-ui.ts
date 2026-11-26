import assert from "node:assert/strict";
import { WorkspaceLeaf, TFile } from "obsidian";
import { defaultWorkbenchNavigation, isDefaultWorkbenchNavigation, normalizeWorkbenchNavigation } from "../settings/workbench-navigation-settings";
import { renderWorkbenchNavigationSettings } from "../settings/workbench-navigation-section";
import { EchoInkWorkbenchView, VIEW_TYPE_ECHOINK_WORKBENCH, groupWorkbenchTasks, workbenchInlineQuestion } from "../home/workbench-view";
import { WorkbenchModulePanel } from "../home/workbench-module-panel";
import { openWorkbenchModule } from "../home/module-navigation";
import { LifestyleService } from "../lifestyle/service";
import type { OriginCheckElement } from "../settings/origin-controls";
import { DEFAULT_SETTINGS, createApiProviderConfig, createApiProviderModelConfig } from "../settings/settings";
import { ReleaseUpdateController } from "../settings/release-update";
import { toolCallRecoveryGuidance } from "../agents/tool-call-recovery";
import type { KnowledgeLinkingTask } from "../knowledge-base/knowledge-linking-types";
import { knowledgeLinkingProgressText } from "../ui/codex-view/knowledge-linking-progress";
import type { TaskEntry } from "../agents/task-presentation";
import type { WorkbenchDataPort, WorkbenchSignal, WorkbenchSnapshot } from "../home/workbench-types";
import type { EchoInkQuestionInteraction } from "../types/conversation-turn";
import { GENERAL_ASSISTANT_ID, type AgentModuleId } from "../agents/types";
import type CodexForObsidianPlugin from "../main";
import type { ConversationRunSubscriber } from "../plugin/conversation-run-service";
import type { ParsedTodoRecord } from "../home/todo-markdown";
import { DEFAULT_ENGLISH_DIARY_SETTINGS } from "../english-diary/types";
import type { ChatMessage } from "../settings/settings";
import { runDesktopModuleSettingsTests } from "./desktop-module-settings";
import { MAINTENANCE_ACTIVITY_STAGES, maintenanceCompletionText, type KnowledgeActivitySnapshot, type MaintenanceActivity } from "../knowledge-base/maintenance-activity";
import { maintenanceVisibleCopyIsSafe } from "../knowledge-base/maintenance-user-copy";
import type { VaultMemoryNotice } from "../storage/vault-identity";
import { openTestNotices, openTestNoticeMessages } from "./obsidian-shim";
import { WorkbenchSetupRequired } from "../home/workbench-action-feedback";
import { PaperGuideModal, type PaperGuideModalOptions } from "../ui/paper-guide-modal";
import { emptyKnowledgeFolderBindings } from "../knowledge-base/folder-bindings";
import type { OnboardingSetupPlan } from "../knowledge-base/onboarding-setup-plan";

const tick = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setTimeout(resolve, 0)); };
const entry = (id: string, state: TaskEntry["taskStatus"], at = Date.now()): TaskEntry => ({ conversationId: id, piSessionId: `session-${id}`, vaultId: "fixture", title: `任务 ${id}`, status: "active", defaultMemoryMode: "normal", createdAt: at, updatedAt: at, agentId: "sol", taskStatus: state, taskStartedAt: at, taskCompletedAt: at, taskInterruptedAt: at });
const questionFor = (task: TaskEntry): EchoInkQuestionInteraction => ({ interactionId: "interaction", conversationId: task.conversationId, piSessionId: task.piSessionId, turnId: "run", createdAt: Date.now(), updatedAt: Date.now(), kind: "question", status: "pending", questions: [{ questionId: "question", prompt: "选哪一项？", selection: "single", allowSupplement: false, options: [{ optionId: "a", label: "选项 A" }, { optionId: "b", label: "其他" }] }] });

export async function runWorkbenchUiTests(): Promise<void> {
  const now = new Date(2026, 9, 18, 9).getTime();
  const stopped = entry("stop", "interrupted", now), waiting = { ...entry("wait", "waiting", now), pendingResponse: { kind: "question" as const, runId: "run", questionId: "question" } };
  const frozen = [stopped, waiting, entry("run", "running", now), entry("done", "completed", now), entry("yesterday", "completed", now - 86_400_000), { ...entry("archive", "running", now), status: "archived" as const }, { ...entry("delete", "interrupted", now), status: "deleted" as const }, entry("knowledge-linking-internal", "running", now)].map(value => Object.freeze(value));
  const before = JSON.stringify(frozen);
  const groups = groupWorkbenchTasks(frozen, now);
  assert.deepEqual(Object.values(groups).map(values => values.map(value => value.conversationId)), [["stop"], ["wait"], ["run"], ["done"]]);
  assert.equal(JSON.stringify(frozen), before, "overview must not write task metadata");
  assert.equal(groupWorkbenchTasks([entry("midnight", "completed", new Date(2026, 9, 17, 23, 59).getTime())], now).completed.length, 0);
  const question = questionFor(waiting);
  assert.equal(workbenchInlineQuestion(waiting, question)?.questionId, "question");
  assert.equal(workbenchInlineQuestion(waiting, { ...question, questions: [{ ...question.questions[0], allowSupplement: true }] })?.questionId, "question", "optional supplement does not block valid single-choice answers");
  for (const invalid of [{ ...question, piSessionId: "old" }, { ...question, turnId: "old" }, { ...question, status: "answered" as const }, { ...question, questions: [...question.questions, question.questions[0]] }, { ...question, questions: [{ ...question.questions[0], selection: "multiple" as const }] }]) assert.equal(workbenchInlineQuestion(waiting, invalid), undefined);

  const calls: unknown[][] = [], subscribers = new Set<ConversationRunSubscriber>(), dataSubscribers = new Set<() => void>();
  let tasks: readonly TaskEntry[] = [], failTasks = false, failData = false, hasFocus = true, todoFailure = false;
  let taskReads = 0, dataReads = 0;
  const guideProvider = createApiProviderConfig("custom", "guide-provider");
  guideProvider.models = [createApiProviderModelConfig("custom", "guide-model")];
  let guideMode = "disabled";
  let memoryNotice: VaultMemoryNotice | null = null;
  let memoryError: string | null = null;
  let projectionsInFlight = 0, maxProjectionConcurrency = 0;
  let pro = true;
  const projectionReads = new Map<string, number>(), projectionText = new Map<string, string>(), failedProjections = new Set<string>();
  const projectedUsers = new Set<string>(), savedSettings: unknown[] = [];
  let releaseResume: (() => void) | undefined;
  let upgradeTaskId = "maintenance";
  const pending = new Map([[waiting.conversationId, question]]);
  let activitySnapshot: KnowledgeActivitySnapshot = { primary: null, other: null, maintenance: [] };
  const activityListeners = new Set<(snapshot: Readonly<KnowledgeActivitySnapshot>) => void>();
  const activitySource = { ready: Promise.resolve(), snapshot: () => activitySnapshot,
    subscribe(listener: (snapshot: Readonly<KnowledgeActivitySnapshot>) => void) { activityListeners.add(listener); listener(activitySnapshot); return () => { activityListeners.delete(listener); }; } };
  const publishActivities = (...activities: MaintenanceActivity[]) => {
    activitySnapshot = { primary: activities[0] ?? null, other: null, maintenance: activities };
    for (const listener of activityListeners) listener(activitySnapshot);
  };
  let dispatchError: Error | undefined;
  let dispatchGate: Promise<void> | undefined;
  let snapshot: WorkbenchSnapshot = { generatedAt: Date.now(), signals: [], todayTodos: [], modules: ["journal", "todos", "finance", "knowledge-base", "english-diary", "pdf-reading"], issues: [] };
  const port: WorkbenchDataPort = {
    async load() { dataReads++; if (failData) throw new Error("本地事项读取失败"); return snapshot; },
    subscribe(listener) { dataSubscribers.add(listener); return () => { dataSubscribers.delete(listener); }; },
    async recordTaskAccepted() {}, async recordTaskCompleted() {}, dispose() { throw new Error("view must not dispose plugin-owned service"); }
  };
  (globalThis as unknown as { __p5WorkbenchPort: WorkbenchDataPort }).__p5WorkbenchPort = port;
  const files = Array.from({ length: 8 }, (_, index) => Object.assign(new TFile(), { path: `wiki/note-${index}.md`, basename: `笔记 ${index}`, stat: { mtime: now + index, size: 30 } }));
  const host = {
    manifest: { version: "2.9.0" },
    releaseUpdate: new ReleaseUpdateController(async () => ({ releases: [{ tag: "2.9.1" }, { tag: "2.9.0", body: "更新内容" }] })),
    app: {
      vault: { getMarkdownFiles: () => files, cachedRead: async () => "正文检索测试", getAbstractFileByPath: (path: string) => files.find(file => file.path === path) },
      metadataCache: { getFileCache: () => ({ frontmatter: { aliases: ["别名"] }, tags: [{ tag: "#fixture" }] }) },
      workspace: { containerEl: document.body, on() { return {}; }, getLeaf() { return { async openFile(file: TFile) { calls.push(["note", file.path]); } }; } }
    },
    settings: { ...structuredClone(DEFAULT_SETTINGS), expertsEnabled: undefined as boolean | undefined, settingsLanguage: "zh-CN", workbenchOnboardingDismissed: false, knowledgeBase: structuredClone(DEFAULT_SETTINGS.knowledgeBase), lifestyle: { finance: { enabled: true } }, pdfReading: { enabled: true }, englishDiary: { ...DEFAULT_ENGLISH_DIARY_SETTINGS, enabled: false }, sessions: [] as { id: string; messages: ChatMessage[] }[], agentRegistry: { agents: [{ id: "sol", name: "总助", avatar: { kind: "default" } }, { id: "generalist", name: "通才", avatar: { kind: "default" } }], moduleOwners: Object.fromEntries(["journal", "todos", "finance", "knowledge-base", "english-diary", "pdf-reading", "review"].map(id => [id, "generalist"])) } },
    async saveSettings() { savedSettings.push(structuredClone(host.settings)); },
    notifyHomeSurfacesChanged() {},
    async openWorkbenchSetup(target: string) { calls.push(["setup", target]); },
    accountService: { checkCapability: () => pro, checkInSession: () => null, subscribe: () => () => {} },
    getConversationRunService: () => ({ pendingInteractions: pending, runs: new Map(), subscribe(listener: ConversationRunSubscriber) { subscribers.add(listener); return () => { subscribers.delete(listener); }; } }),
    getKnowledgeActivitySource: () => activitySource,
    getKnowledgeSurfaceService: () => ({ getUpgradeSnapshot: async () => ({ status: "running", taskId: upgradeTaskId }), stopUpgrade: async () => { calls.push(["stop-upgrade", upgradeTaskId]); } }),
    async listAgentTaskEntries() { taskReads++; if (failTasks) throw new Error("任务读取失败"); return tasks; },
    async getVaultMemoryNotice() { return memoryNotice; },
    async getVaultMemoryError() { return memoryError; },
    async resolveVaultMemory(action: string) { calls.push(["resolve-memory", action]); memoryNotice = null; memoryError = null; },
    async readPiConversationProjection(taskId: string) {
      projectionReads.set(taskId, (projectionReads.get(taskId) ?? 0) + 1);
      maxProjectionConcurrency = Math.max(maxProjectionConcurrency, ++projectionsInFlight);
      try {
        await new Promise(resolve => setTimeout(resolve, 0));
        if (failedProjections.has(taskId)) throw new Error("结果文件读取失败");
        const text = projectionText.get(taskId) ?? "## 真正结果\n已整理 **3** 篇笔记。";
        return { catalog: tasks.find(task => task.conversationId === taskId)!, activeLeafId: null, diagnostics: [], drafts: [], messages: [...(projectedUsers.has(taskId) ? [{ id: "user", role: "user", text: "真实问题" }] : []), ...(text ? [{ id: "answer", role: "assistant", text }] : [])] };
      } finally { projectionsInFlight--; }
    },
    async setPiConversationTaskMetadata() { calls.push(["metadata-write"]); throw new Error("overview must not mark results read"); },
    async ensurePiRuntimeBundle() { calls.push(["provider"]); throw new Error("overview must not initialize Provider"); },
    async readTaskInterruption(taskId: string) { return { taskId, reason: "user_stopped", at: now, stage: "真实步骤", uncertainOperations: [],
      ...(taskId.startsWith("guide-") ? { toolCallTextFailure: guideMode === "enabled" ? "model_tool_call_text_incompatible" as const : "model_tool_call_text_disabled" as const,
        ...(guideMode === "legacy" ? {} : { providerSettingsId: guideProvider.id, modelId: "guide-model" }) } : {}) }; },
    taskToolCallRecovery(_id: string, info: any) { return toolCallRecoveryGuidance(info, [guideProvider], "desktop"); },
    async openRunReport(taskId: string) { calls.push(["report", taskId]); },
    async openTaskDetail(id: string) { calls.push(["detail", id]); },
    async resumeTaskAndOpenDetail(id: string) { calls.push(["resume", id]); await new Promise<void>(resolve => { releaseResume = resolve; }); },
    async openAgentTaskList(...args: unknown[]) { if (dispatchError) throw dispatchError; calls.push(["list", ...args]); await dispatchGate; return true; },
    async openPaperGuideAfterOnboarding(manual: boolean) { calls.push(["setup-guide", manual]); },
    async openAgentPersonaEditor(id: string) { calls.push(["persona", id]); return true; },
    async openModuleOwnerSettings(id: string) { calls.push(["owner-settings", id]); },
    async startWorkbenchSignalTask(...args: unknown[]) { if (dispatchError) throw dispatchError; calls.push(["dispatch", ...args]); await dispatchGate; return "new-task"; },
    async readPiConversationCatalogEntry(id: string) { return tasks.find(task => task.conversationId === id); },
    piTurnInteractionBinding(identity: unknown) { return { submit(answers: unknown) { calls.push(["answer", identity, answers]); return true; } }; },
    async activateKnowledgeView() { calls.push(["knowledge"]); },
    async activateMemoryView() { calls.push(["memory"]); },
    async activateTodoView() { calls.push(["todos"]); },
    async activateJournalView() { calls.push(["journal"]); },
    async activateEnglishDiaryPage() { calls.push(["english"]); },
    async activatePdfReadingPage() { calls.push(["pdf"]); },
    async openExpertHall() { calls.push(["experts"]); },
    async activateNewsPage() { calls.push(["news"]); },
    async openEchoInkGeneralSettings() { calls.push(["settings"]); },
    async openEchoInkAccountSettings(target?: "login" | "benefits") { calls.push(["account", target]); },
    async openEchoInkKnowledgeSettings() { calls.push(["knowledge"]); },
    async openKnowledgeLinkingDetails(id?: string) { calls.push(["linking-settings", id]); },
    async openWorkbenchModuleSettings(id: string) { calls.push(["module-settings", id]); },
    lifestyle: { async open(kind: string) { calls.push(["lifestyle", kind]); } },
    englishDiary: { async openToday() { calls.push(["english"]); } },
    getTodoStore: () => ({ async toggleDone(todo: ParsedTodoRecord, done: boolean) { calls.push(["todo", todo.id, done]); if (todoFailure) throw new Error("保存失败"); snapshot = { ...snapshot, todayTodos: [] }; } })
  };
  const plugin = host as unknown as CodexForObsidianPlugin;
  const content = document.body.createDiv();
  const container = document.body.createDiv(); container.appendChild(content);
  Object.defineProperty(container, "getClientRects", { value: () => [{ width: 900, height: 800 }] });
  Object.defineProperty(document, "hasFocus", { configurable: true, value: () => hasFocus });
  const leaf = new WorkspaceLeaf();
  const view = new EchoInkWorkbenchView(leaf, plugin);
  const history: unknown[] = [];
  Object.assign(leaf, { getHistoryState: () => view.getState(), history: { pushState(state: unknown) { history.push(state); } } });
  const cleanups: (() => void)[] = [];
  // Module pages have their own suites; here the panel only records what the workbench asked it to show.
  const panelShows: string[] = [];
  let panelCurrent: string | null = null;
  let panelOpen: ((id: string) => Promise<void> | undefined) | undefined;
  const fakePanel = { get current() { return panelCurrent ? {} : null; }, get currentId() { return panelCurrent; },
    async show(id: string) {
      if (panelCurrent === id) return true;
      panelShows.push(id);
      const loading = panelOpen?.(id);
      if (loading) await loading;
      else panelCurrent = id;
      return true;
    }, async clear() { panelCurrent = null; } };
  Object.assign(view, { contentEl: content, containerEl: container, app: host.app, createModulePanel: () => fakePanel,
    register: (dispose: () => void) => cleanups.push(dispose), registerEvent() {},
    registerDomEvent(element: EventTarget, type: string, callback: EventListener, options?: AddEventListenerOptions) { element.addEventListener(type, callback, options); cleanups.push(() => element.removeEventListener(type, callback, options)); }
  });
  const button = (key: string) => Array.from(content.querySelectorAll<HTMLButtonElement>("[data-wb-focus]")).find(node => node.dataset.wbFocus === key)!;
  const click = async (key: string) => {
    const target = button(key); target.click();
    await tick();
  };
  try {
    assert.equal(view.getViewType(), VIEW_TYPE_ECHOINK_WORKBENCH);
    await view.onOpen();
    assert.match(content.textContent ?? "", /正在读取任务/);
    assert.equal(content.querySelectorAll('[data-wb-group][data-state="loading"]').length, 6);
    assert.equal(content.querySelectorAll('[data-wb-group] .wb-count:not([hidden])').length, 0, "unread groups never claim zero");
    await tick();
    const reminder = content.querySelector<HTMLElement>('[data-wb="reminders"]')!;
    assert.equal(reminder.previousElementSibling, content.querySelector('[data-wb="status"]'), "reminders follow the notices that block work");
    const reminderRows = () => Array.from(reminder.querySelectorAll<HTMLElement>(".wb-setup-todo:not(.is-more)"));
    const todoTexts = () => reminderRows().map(row => row.querySelector(".wb-setup-todo-text")?.textContent);
    const reminderKinds = () => reminderRows().map(row => row.dataset.setupTodo ?? row.dataset.releaseReminder ?? row.dataset.guideStep);
    const guide = () => button("guide-dismiss-all") ?? null;
    assert.equal(content.querySelector(".wb-deck"), null, "the starter carousel is gone");
    assert.equal(reminder.querySelector("h2")?.textContent, "提醒");
    assert.equal(reminder.querySelector(".wb-count")?.textContent, "10");
    assert.deepEqual(todoTexts(), ["未设置知识库", "未连接模型服务"], "two rows show; setup problems lead");
    assert.ok(!(reminder.textContent ?? "").includes("交给了") && !(reminder.textContent ?? "").includes("没有负责人"), "ownership reminders are gone");
    assert.equal(button("reminders-more").textContent?.trim(), "还有 8 条");
    assert.equal(button("reminders-more").getAttribute("aria-expanded"), "false");
    await click("reminders-more");
    assert.deepEqual(reminderKinds(), ["knowledge", "model", "update", "notes", "avatar", "appearance", "journal", "reading", "english", "pdf"], "release news follows setup; onboarding comes last");
    assert.equal(button("reminders-more").textContent?.trim(), "收起");
    assert.equal(button("guide:english").textContent?.trim(), "开始写", "PRO users get the step itself");
    await click("guide:avatar"); assert.deepEqual(calls.at(-1), ["setup", "agent"]);
    assert.equal(reminder.querySelector('[data-guide-step="avatar"]'), null, "a clicked step counts as done");
    assert.deepEqual((savedSettings.at(-1) as typeof host.settings).setup.onboardingGuideDone, ["avatar"]);
    assert.equal(button("guide:journal").textContent?.trim(), "开始写");
    host.settings.agentRegistry.moduleOwners.journal = ""; await view.refresh();
    assert.equal(button("guide:journal").textContent?.trim(), "指定负责人", "an unowned journal shows the owner action before the click");
    host.settings.agentRegistry.moduleOwners.journal = "generalist"; await view.refresh();
    await click("guide:journal");
    assert.deepEqual(calls.at(-1), ["list", "generalist", "帮我开始写今天的日记，先问我三个问题。"], "the journal step goes to the journal owner");
    await click("guide-dismiss:reading");
    assert.equal(reminder.querySelector('[data-guide-step="reading"]'), null, "a dismissed step leaves");
    assert.equal(reminder.querySelector('[data-wb-focus="setup-todo:knowledge"]')?.textContent?.trim(), "设置");
    await click("setup-todo:knowledge"); assert.deepEqual(calls.at(-1), ["setup-guide", true]);
    await click("setup-todo:model"); assert.deepEqual(calls.at(-1), ["setup", "models"]);
    host.settings.sessions.push({ id: "empty-onboarding", messages: [] }); projectionText.set("empty-onboarding", "");
    tasks = [entry("empty-onboarding", "interrupted")]; await view.refresh();
    assert.ok(guide(), "empty shells and task metadata cannot dismiss onboarding");
    assert.equal(host.settings.workbenchOnboardingDismissed, false);
    projectedUsers.add("legacy-onboarding"); tasks = [entry("legacy-onboarding", "completed")]; await view.refresh();
    assert.equal(guide(), null, "legacy stored user messages hide onboarding without resident bodies");
    assert.equal(host.settings.workbenchOnboardingDismissed, true);
    assert.equal((savedSettings.at(-1) as typeof host.settings).workbenchOnboardingDismissed, true);
    tasks = []; host.settings.sessions = []; await view.refresh();
    assert.equal(guide(), null, "deleting the old conversation cannot restore onboarding");
    host.settings.workbenchOnboardingDismissed = false; await view.refresh();
    assert.ok(guide()); await click("guide-dismiss-all");
    assert.equal(host.settings.workbenchOnboardingDismissed, true); assert.equal(guide(), null, "closing getting started keeps the other reminders");
    assert.equal(reminder.querySelectorAll("[data-release-reminder]").length, 2, "dismissing onboarding preserves both release reminders");
    assert.equal(button("release:update").textContent?.trim(), "更新");
    await click("release:notes:dismiss");
    assert.equal(reminder.querySelector('[data-release-reminder="notes"]'), null);
    assert.equal(reminder.hidden, false);
    await click("release:update:dismiss");
    assert.equal(reminder.querySelector("[data-release-reminder]"), null);
    assert.equal(reminder.hidden, false, "knowledge setup reminder is independent of conversation onboarding");
    await click("setup-todo-dismiss:knowledge");
    assert.notEqual(host.settings.knowledgeBase.initialized, true);
    assert.equal(host.settings.setup.setupTodoDismissed?.knowledge, "knowledge");
    assert.equal((savedSettings.at(-1) as typeof host.settings).setup.setupTodoDismissed?.knowledge, "knowledge");
    await view.refresh();
    assert.deepEqual(todoTexts(), ["未连接模型服务"], "dismissing one item keeps the others");
    await click("setup-todo-dismiss:model");
    assert.equal(reminder.hidden, true, "an empty reminders list leaves no space"); await view.refresh(); assert.equal(reminder.hidden, true);
    for (const [phase, group] of [["scanning", "running"], ["judging", "running"], ["writing", "running"], ["queued", "running"], ["awaiting-confirmation", "waiting"], ["partial", "interrupted"], ["failed", "interrupted"], ["interrupted", "interrupted"], ["completed", null], ["cancelled", null]] as const) {
      const linking: KnowledgeLinkingTask = { schemaVersion: 1, id: "system-linking", mode: "manual", phase, judgment: "aliases", bindingSignature: "test", createdAt: 1, updatedAt: 2, processed: 9, total: 20, proposals: [], patches: [], results: [] };
      activitySnapshot = { primary: null, other: null, maintenance: [], linking };
      for (const listener of activityListeners) listener(activitySnapshot);
      const row = content.querySelector<HTMLElement>('[data-wb="knowledge-linking"]');
      if (!group) { assert.equal(row, null, `${phase} needs no workbench action`); continue; }
      assert.ok(row, `${phase} remains visible even without a conversation task`);
      assert.equal(row.closest<HTMLElement>("[data-wb-group]")?.dataset.wbGroup, group);
      assert.match(row.textContent!, /补全知识关联/u);
      assert.ok(row.textContent!.includes(knowledgeLinkingProgressText(linking)));
      assert.equal(row.closest("section")?.querySelector(".wb-count")?.textContent, "1");
      row.querySelector<HTMLButtonElement>("button")!.click(); await tick();
      assert.deepEqual(calls.at(-1), ["linking-settings", "system-linking"]);
    }
    activitySnapshot = { primary: null, other: null, maintenance: [], linking: null };
    for (const listener of activityListeners) listener(activitySnapshot);
    assert.equal(content.querySelectorAll('[data-wb-group][data-state="empty"]').length, 0);
    assert.equal(content.querySelectorAll('[data-wb-group] .wb-count:not([hidden])').length, 0);
    assert.equal(content.querySelector("time")?.getAttribute("datetime"), localDate(new Date()));
    memoryNotice = { kind: "mismatch", reason: "Personal Memory manifest belongs to another Vault" };
    await view.refresh();
    assert.equal(content.querySelectorAll(".wb-memory-notice").length, 1);
    assert.equal(content.querySelectorAll('[data-wb-group][data-state="error"]').length, 0, "memory failure does not fail task groups");
    assert.equal(content.querySelector(".wb-memory-notice details"), null, "an English internal reason gets no Details disclosure");
    assert.ok(!content.querySelector(".wb-memory-notice")?.textContent?.includes(memoryNotice.reason), "the raw reason never reaches the banner");
    const memoryHost = content.querySelector<HTMLElement>('[data-wb="memory-notice"]')!;
    assert.equal(memoryHost.nextElementSibling, content.querySelector('[data-wb="status"]'), "the memory notice leads the overview, ahead of reminders");
    const useMemory = memoryHost.querySelector<HTMLButtonElement>(".is-primary")!;
    assert.equal(useMemory.textContent, "沿用现有记忆"); useMemory.click(); await tick();
    assert.deepEqual(calls.at(-1), ["resolve-memory", "adopt"]); assert.equal(memoryHost.children.length, 0);
    memoryNotice = { kind: "mismatch", reason: "Personal Memory manifest belongs to another Vault" }; await view.refresh();
    const restart = memoryHost.querySelector<HTMLButtonElement>(".is-secondary")!;
    restart.click(); await tick();
    assert.equal(calls.at(-1)?.[1], "adopt", "asking for confirmation does not reset memory");
    assert.equal(memoryHost.querySelector<HTMLElement>(".wb-memory-notice-row")!.hidden, true);
    memoryHost.querySelector<HTMLButtonElement>(".review-confirm button:first-child")!.click(); await tick();
    assert.equal(memoryHost.querySelector(".review-confirm"), null); assert.equal(document.activeElement, restart);
    restart.click(); await tick();
    memoryHost.querySelector<HTMLButtonElement>(".review-confirm button:last-child")!.click(); await tick();
    assert.deepEqual(calls.at(-1), ["resolve-memory", "reset"]); assert.equal(memoryHost.children.length, 0);
    memoryNotice = { kind: "mismatch", reason: "Personal Memory manifest belongs to another Vault" }; host.settings.settingsLanguage = "en"; await view.refresh();
    assert.match(memoryHost.textContent ?? "", /does not belong to this vault/u);
    assert.equal(memoryHost.querySelector<HTMLButtonElement>(".is-primary")!.textContent, "Use existing memory");
    memoryHost.querySelector<HTMLButtonElement>(".is-primary")!.click(); await tick();
    assert.deepEqual(calls.at(-1), ["resolve-memory", "adopt"]); assert.equal(memoryHost.children.length, 0);
    memoryError = "fixture unsupported schema"; await view.refresh();
    assert.equal(memoryHost.children.length, 0); assert.match(content.querySelector('[data-wb="status"]')?.textContent ?? "", /Memory is temporarily unavailable/u);
    assert.equal(content.querySelectorAll('[data-wb-group][data-state="error"]').length, 0);
    memoryError = null; host.settings.settingsLanguage = "zh-CN"; await view.refresh();
    await click("new-task"); assert.deepEqual(calls.at(-1), ["list", GENERAL_ASSISTANT_ID]);
    await click("settings"); assert.deepEqual(calls.at(-1), ["settings"]);
    const navOrder = () => Array.from(content.querySelectorAll<HTMLElement>('.wb-modules [data-module]')).map(node => node.dataset.module);
    const overviewEl = content.querySelector<HTMLElement>('[data-wb="overview"]')!, panelEl = content.querySelector<HTMLElement>('[data-wb="module-panel"]')!;
    const onModule = (id: string) => {
      assert.equal(overviewEl.hidden, true, `${id}: the overview steps aside`); assert.equal(overviewEl.inert, true);
      assert.equal(panelEl.hidden, false); assert.equal(button(`module-${id}`).getAttribute("aria-current"), "page");
      assert.equal(button("module-overview").hasAttribute("aria-current"), false);
    };
    const onOverview = () => {
      assert.equal(overviewEl.hidden, false); assert.equal(overviewEl.inert, false); assert.equal(panelEl.hidden, true);
      assert.equal(button("module-overview").getAttribute("aria-current"), "page");
    };
    assert.deepEqual(navOrder(), ["overview", "journal", "todos", "finance", "knowledge-base", "english-diary", "pdf-reading", "experts", "news"],
      "the overview leads; modules keep the existing order followed by Experts and News");
    onOverview();
    const journalButton = button("module-journal"), callsBeforeNavigation = calls.length;
    journalButton.click(); journalButton.click(); await tick();
    assert.ok(journalButton.classList.contains("is-nav-animating"), "activation starts playback immediately");
    assert.deepEqual(panelShows, ["journal"], "rapid activations show the module once, below the navigation, without waiting");
    assert.equal(calls.length, callsBeforeNavigation, "in-page navigation opens no tab");
    onModule("journal");
    assert.deepEqual(view.getState(), { module: "journal" }, "the panel is part of the view state, so Obsidian back/forward follow it");
    journalButton.dispatchEvent(new Event("animationend"));
    assert.equal(journalButton.classList.contains("is-nav-animating"), false, "animation completion clears its playback state");
    await click("module-journal");
    assert.ok(journalButton.classList.contains("is-nav-animating"), "later activation restarts the same icon");
    assert.deepEqual(panelShows, ["journal"], "choosing the current module keeps its page");
    (view as unknown as { foregroundChanged(active: boolean): void }).foregroundChanged(false);
    assert.equal(journalButton.classList.contains("is-nav-animating"), false, "leaving the workbench clears playback before return");
    (view as unknown as { foregroundChanged(active: boolean): void }).foregroundChanged(true);
    button("module-todos").dispatchEvent(new MouseEvent("click", { bubbles: true, metaKey: true })); await tick();
    assert.deepEqual(calls.at(-1), ["todos"], "Cmd-click keeps opening the module in its own tab");
    button("module-finance").dispatchEvent(new MouseEvent("auxclick", { bubbles: true, button: 1 })); await tick();
    assert.deepEqual(calls.at(-1), ["lifestyle", "finance"], "middle-click also opens a tab");
    onModule("journal");
    const result = { history: false };
    await view.setState({ module: "overview" }, result);
    assert.equal(result.history, true, "a panel change is recorded in the leaf history"); onOverview();
    await view.setState({ module: "todos" }, { history: false }); onModule("todos");
    await view.setState({ module: "unknown-module" }, { history: false }); onOverview();
    history.length = 0;
    let failSlowPanel!: () => void;
    panelOpen = id => id === "journal" ? new Promise((_, reject) => { failSlowPanel = () => reject(new Error("old page failed")); }) : undefined;
    await click("module-journal");
    onModule("journal");
    assert.deepEqual(history, [{ module: "overview" }], "Back is recorded when the slow selection becomes visible");
    await click("module-todos");
    onModule("todos");
    const staleNotices = openTestNoticeMessages.length;
    failSlowPanel(); await tick();
    assert.deepEqual(history, [{ module: "overview" }, { module: "journal" }], "a stale open adds no late history and loses no previous step");
    assert.equal(openTestNoticeMessages.length, staleNotices, "a stale failure does not notify on the current module");
    panelOpen = id => id === "journal" ? Promise.reject(new Error("page open failed")) : undefined;
    await click("module-journal");
    const beforeRetry = history.length;
    panelOpen = undefined;
    await click("module-journal");
    assert.equal(panelCurrent, "journal", "clicking the selected module retries a failed open");
    assert.equal(history.length, beforeRetry, "a retry of the same module adds no history");
    await click("module-overview");
    const beforeExperts = JSON.stringify(host.settings.agentRegistry);
    assert.ok(button("module-experts"), "PRO discovers the expert tab by default");
    await click("module-experts"); assert.equal(panelShows.at(-1), "experts"); onModule("experts");
    await click("module-news"); assert.equal(panelShows.at(-1), "news", "News shows its own page; the page handles locked and rollout states");
    host.settings.expertsEnabled = false; await view.refresh();
    assert.equal(button("module-experts"), undefined);
    assert.equal(JSON.stringify(host.settings.agentRegistry), beforeExperts, "hiding the hall never dismisses hired Agents");
    host.settings.expertsEnabled = true; await view.refresh();
    assert.ok(button("module-experts"));
    host.settings.expertsEnabled = undefined;
    host.settings.workbenchNavigation = { order: ["news", "pdf-reading", "english-diary", "knowledge-base", "finance", "todos", "journal", "experts"], hidden: ["english-diary", "experts"] };
    view.refreshNavigation();
    assert.deepEqual(navOrder(), ["overview", "news", "pdf-reading", "knowledge-base", "finance", "todos", "journal"], "settings order and hidden entries apply in place; the overview stays first");
    assert.equal(button("module-news").getAttribute("aria-current"), "page", "the current page keeps its selection after a reorder");
    host.settings.workbenchNavigation = structuredClone(DEFAULT_SETTINGS.workbenchNavigation); view.refreshNavigation();
    await click("module-overview"); onOverview();
    for (const module of snapshot.modules) await openWorkbenchModule(plugin, module);
    assert.ok(calls.some(call => JSON.stringify(call) === '["journal"]'));
    assert.ok(calls.some(call => JSON.stringify(call) === '["todos"]'));
    assert.ok(calls.some(call => JSON.stringify(call) === '["lifestyle","finance"]'));
    assert.ok(calls.some(call => call[0] === "knowledge")); assert.ok(calls.some(call => call[0] === "english"));

    pro = false; host.settings.englishDiary.enabled = true; await view.refresh();
    assert.equal(button("module-experts"), undefined, "free defaults to a hidden expert tab");
    assert.equal(content.querySelector('[data-module="memory"]'), null, "memory is available from Settings instead of workbench navigation");
    const navLandmark = content.querySelector('[data-wb="modules"]')!;
    assert.equal(navLandmark.hasAttribute("aria-label"), false, "the nav landmark must not trigger a delegated tooltip");
    assert.ok(navLandmark.getAttribute("aria-labelledby"), "the nav landmark keeps a screen reader name");
    for (const id of ["finance", "english-diary", "pdf-reading"] as const) {
      assert.equal(button(`module-${id}`).hidden, false);
      assert.ok(button(`module-${id}`).querySelector('[data-plugin-edition="pro"]'));
      const previousCalls = calls.length, previousShows = panelShows.length;
      await click(`module-${id}`);
      const locked = panelEl.querySelector<HTMLElement>(`[data-locked-module="${id}"]`)!;
      assert.ok(locked, "the PRO notice shows below the navigation"); assert.match(locked.textContent ?? "", /PRO 模块/);
      assert.equal(calls.length, previousCalls, "locked navigation never opens the module service");
      assert.equal(panelShows.length, previousShows, "locked navigation never mounts the module page");
      onModule(id);
      assert.notEqual(content.querySelector<HTMLElement>('[data-wb="page"]')!.inert, true, "the navigation stays usable");
      button(`module-${id}`).dispatchEvent(new MouseEvent("click", { bubbles: true, metaKey: true })); await tick();
      assert.equal(calls.length, previousCalls, "Cmd-click on a locked module keeps the notice instead of opening a tab");
      await click("module-lock-login"); assert.deepEqual(calls.at(-1), ["account", "login"]);
      await click("module-lock-benefits"); assert.deepEqual(calls.at(-1), ["account", "benefits"]);
      await click("module-lock-back"); onOverview();
    }
    host.settings.lifestyle.finance.enabled = false; await view.refresh();
    assert.equal(button("module-finance").hidden, false);
    const disabledCalls = calls.length;
    await click("module-finance"); assert.equal(calls.length, disabledCalls, "disabled PRO navigation cannot open the module service");
    assert.ok(panelEl.querySelector('[data-locked-module="finance"]'), "PRO gating precedes setup");
    await click("module-overview");
    pro = true; host.settings.pdfReading.enabled = false;
    snapshot = { ...snapshot, modules: ["todos"] }; await view.refresh();
    const configured = { ...host.settings };
    Object.assign(host.settings, structuredClone(DEFAULT_SETTINGS)); await view.refresh();
    assert.equal(content.querySelectorAll('[data-module]:not([hidden])').length, 9, "default/unconfigured modules remain discoverable independently of snapshot.modules");
    Object.assign(host.settings, configured); await view.refresh();
    for (const id of ["journal", "knowledge-base"] as const) {
      await click(`module-${id}`);
      assert.equal(content.querySelector('[data-wb="module-setup"]'), null, "basic modules open even without configured directories");
      assert.equal(panelShows.at(-1), id);
    }
    for (const id of ["finance", "pdf-reading"] as const) {
      const before = calls.length, shows = panelShows.length; await click(`module-${id}`);
      const setup = panelEl.querySelector<HTMLElement>(`[data-setup-module="${id}"]`)!;
      assert.ok(setup); assert.equal(setup.querySelectorAll(".is-primary").length, 1);
      assert.equal(calls.length, before, "setup landing never starts a module or reads its data");
      assert.equal(panelShows.length, shows);
      await click("module-setup-settings"); assert.deepEqual(calls.at(-1), ["module-settings", id]);
      await click("module-setup-back"); onOverview();
    }
    host.settings.englishDiary.enabled = false; await click("module-english-diary");
    assert.match(panelEl.querySelector('[data-wb="module-setup"]')?.textContent ?? "", /英文日记尚未开启/);
    host.settings.englishDiary.enabled = true; await view.refresh(); await tick();
    assert.equal(content.querySelector('[data-wb="module-setup"]'), null, "configuration completion opens the actual module");
    assert.equal(panelShows.at(-1), "english-diary");
    host.settings.pdfReading.enabled = true;
    snapshot = { ...snapshot, modules: ["journal", "todos", "finance", "knowledge-base", "english-diary", "pdf-reading"] };
    host.settings.lifestyle.finance.enabled = true; pro = true; await view.refresh();
    assert.equal(button("module-finance").querySelector('[data-plugin-edition="pro"]'), null);
    await click("module-finance"); assert.equal(panelShows.at(-1), "finance");
    const beforeGateUpdates = history.length;
    pro = false; view.refreshIfSettingsChanged(); await tick();
    assert.equal(panelCurrent, null);
    assert.ok(panelEl.querySelector('[data-locked-module="finance"]'), "a mounted finance page follows the workbench lock after PRO expires");
    pro = true; view.refreshIfSettingsChanged(); await tick();
    assert.equal(panelCurrent, "finance", "regaining PRO restores the selected module");
    host.settings.lifestyle.finance.enabled = false; view.refreshIfSettingsChanged(); await tick();
    assert.equal(panelCurrent, null);
    assert.ok(panelEl.querySelector('[data-setup-module="finance"]'), "manual disable replaces a mounted module with the same setup state as a fresh entry");
    assert.equal(history.length, beforeGateUpdates, "changing entry eligibility does not add a navigation step");
    host.settings.lifestyle.finance.enabled = true; view.refreshIfSettingsChanged(); await tick();
    await click("module-overview"); onOverview();
    host.settings.englishDiary.enabled = false;

    const completed = Object.freeze({ ...entry("done", "completed"), unreadAnswerAt: Date.now() });
    const runningTitle = `完整工作台标题 ${"长".repeat(110)}`, runningStage = "😀".repeat(110);
    // The overview reads the clock: an unfinished task from this week shows, an older one folds.
    const recentStop = { ...stopped, updatedAt: Date.now(), taskInterruptedAt: Date.now() };
    tasks = [recentStop, waiting, { ...entry("run", "running"), title: runningTitle, taskStage: runningStage }, completed];
    host.settings.sessions.push({ id: completed.conversationId, messages: [] });
    snapshot = { ...snapshot, signals: Array.from({ length: 7 }, (_, index) => signal(index)) };
    await view.refresh();
    assert.equal(button("task-run").getAttribute("aria-label"), `${runningTitle}\n${"😀".repeat(99)}…`);
    assert.equal(button("task-run").getAttribute("data-tooltip-class"), "echoink-task-card-tooltip");
    assert.equal(button("task-run").hasAttribute("title"), false, "use the existing host tooltip rather than a browser title");
    assert.equal(button("task-run").querySelector(".wb-task-step")?.textContent, runningStage, "visible stage remains intact");
    await click("task-run"); assert.deepEqual(calls.at(-1), ["detail", "run"]);
    calls.pop();
    assert.match(content.querySelector('[data-task="done"] .wb-secondary')?.textContent ?? "", /真正结果 已整理 3 篇笔记。/);
    assert.equal(projectionReads.get("done"), 1, "cold settings shells read the real stored projection");
    assert.equal(host.settings.sessions[0].messages.length, 0, "preview does not hydrate or mutate the resident shell");
    assert.equal(calls.some(call => call[0] === "detail"), false, "completed preview is available before opening the sidebar task");
    assert.ok(completed.unreadAnswerAt); assert.equal(calls.some(call => call[0] === "metadata-write" || call[0] === "provider"), false);
    const completedSummary = content.querySelector('[data-task="done"] .wb-secondary');
    await view.refresh();
    assert.equal(projectionReads.get("done"), 1, "streaming or surface refreshes reuse the same completed revision");
    assert.equal(content.querySelectorAll('[data-task="done"] .wb-secondary').length, 1, "redraw does not duplicate the result summary");
    assert.equal(content.querySelector('[data-task="done"] .wb-secondary'), completedSummary, "unchanged result keeps its existing summary node");
    projectionText.set("done", "更新后的**真实结果**");
    tasks = tasks.map(task => task.conversationId === "done" ? { ...task, updatedAt: task.updatedAt + 1 } : task);
    await view.refresh();
    assert.equal(projectionReads.get("done"), 2, "a changed Catalog revision reloads the result");
    assert.match(content.querySelector('[data-task="done"] .wb-secondary')?.textContent ?? "", /更新后的真实结果/);
    assert.deepEqual(Array.from(content.querySelectorAll<HTMLElement>("[data-wb-group]")).map(node => node.dataset.wbGroup), ["waiting", "running", "interrupted", "signals", "completed"]);
    assert.deepEqual(Array.from(content.querySelectorAll("[data-wb-group] h2")).map(node => node.textContent), ["待确认", "正在进行", "未完成", "可以交给 Agent", "今日已完成"]);
    assert.match(content.querySelector('[data-task="wait"] .wb-task-status')?.textContent ?? "", /待确认/u);
    assert.equal(button("signal-signal-0").textContent?.trim(), "梳理优先级", "the button names the action, not an Agent");
    assert.match(content.textContent ?? "", /被你停止/);
    assert.equal(content.querySelectorAll('[data-wb-group="signals"] .wb-row').length, 5);
    const retained = button("signal-signal-0");
    retained.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    snapshot = { ...snapshot, generatedAt: Date.now() + 1, signals: snapshot.signals.map(signal => ({ ...signal, source: { ...signal.source, capturedAt: signal.source.capturedAt + 1 } })) };
    await view.refresh();
    assert.equal(button("signal-signal-0"), retained, "timestamp-only refresh cannot replace a pressed button and swallow click");
    retained.dispatchEvent(new Event("pointerup", { bubbles: true }));
    button("signal-toggle").focus(); await click("signal-toggle");
    assert.equal(content.querySelectorAll('[data-wb-group="signals"] .wb-row').length, 7);
    assert.equal(button("signal-signal-0"), retained, "expansion preserves existing controls");
    assert.equal(document.activeElement, button("signal-toggle"));
    await click("signal-toggle"); assert.equal(content.querySelectorAll('[data-wb-group="signals"] .wb-row').length, 5);
    const beforeDismissed = snapshot;
    snapshot = { ...snapshot, signals: [], dismissedCount: 1 }; await view.refresh();
    assert.ok(content.querySelector('[data-wb="signal-restore"]'), "restore remains reachable after dismissing the last suggestion");
    assert.equal(content.querySelector('[data-wb-group="signals"] .wb-count')?.textContent, "", "empty suggestions do not show a zero count");
    assert.equal(content.querySelector<HTMLElement>('[data-wb-group="signals"] .wb-count')?.hidden, true);
    assert.equal(content.querySelector<HTMLElement>('[data-wb-group="signals"] .wb-rows')?.hidden, true, "only the heading and restore action remain");
    snapshot = beforeDismissed; await view.refresh();
    await click("task-stop"); assert.deepEqual(calls.at(-1), ["detail", "stop"]);
    const resume = button("resume-stop"); resume.focus(); resume.click(); resume.click(); await tick();
    assert.equal(calls.filter(call => call[0] === "resume").length, 1, "double click only resumes once");
    assert.equal(button("resume-stop"), resume, "pending state preserves the control being used");
    assert.equal(resume.disabled, true); assert.equal(document.activeElement, resume);
    assert.equal(button("report-stop").disabled, true, "both card actions stay disabled during the shared resume flight");
    releaseResume!(); await tick(); assert.equal(button("resume-stop"), resume); assert.equal(resume.disabled, false);
    const tasksBeforeGuide = tasks;
    for (const mode of ["disabled", "enabled", "legacy"]) {
      guideMode = mode; guideProvider.models[0].toolCalling = mode === "enabled";
      const id = `guide-${mode}`; tasks = [entry(id, "interrupted")]; await view.refresh(); await tick();
      const card = content.querySelector<HTMLElement>(`[data-task="${id}"]`)!;
      assert.deepEqual(Array.from(card.querySelectorAll<HTMLButtonElement>(".wb-task-footer button")).map(node => node.textContent?.trim()), ["上报问题", mode === "disabled" ? "开启工具调用并继续" : "继续"]);
      assert.equal(card.textContent!.split("未实际执行工具调用").length - 1, 1);
      assert.equal(card.textContent!.includes("模型设置"), false);
      if (mode === "legacy") assert.match(card.textContent!, /模型服务 → 对应服务 → 参数 → 对应模型/u);
    }
    tasks = tasksBeforeGuide; await view.refresh(); await tick();
    console.log("PASS desktop task cards: closed/enabled/legacy guide has two buttons and one failure prompt");

    await click("answer-wait-a"); assert.ok(calls.some(call => call[0] === "answer"));
    const answers = calls.filter(call => call[0] === "answer").length;
    await click("answer-wait-b"); assert.equal(calls.filter(call => call[0] === "answer").length, answers + 1, "option meaning follows the schema rather than guessing from its label");
    pending.set(waiting.conversationId, { ...question, questions: [{ ...question.questions[0], allowSupplement: true }] }); await view.refresh();
    await click("answer-wait-a"); assert.equal(calls.filter(call => call[0] === "answer").length, answers + 2, "optional supplement still allows direct submission");
    assert.equal(button("detail-wait"), undefined, "supplement entry stays on the clickable card instead of adding a third option");
    assert.deepEqual(Array.from(content.querySelectorAll('[data-task="wait"] .wb-options button')).map(node => node.textContent), ["选项 A", "其他"]);
    content.querySelector<HTMLElement>('[data-task="wait"] .wb-question > div')!.click(); await tick();
    assert.deepEqual(calls.at(-1), ["detail", "wait"], "the question card still opens the complete question and supplement");
    await click("signal-signal-0");
    assert.deepEqual(calls.at(-1)?.slice(0, 3), ["list", GENERAL_ASSISTANT_ID, "处理事项 0"], "the general assistant gets a new conversation with the request prefilled");
    assert.equal(JSON.parse(calls.at(-1)![3] as string).businessKey, "signal-0", "the frozen source travels with the draft");
    assert.equal(snapshot.signals.length, 7, "prefilling does not invent completion");
    let releaseDispatch!: () => void;
    dispatchGate = new Promise(resolve => { releaseDispatch = resolve; });
    const dispatches = calls.filter(call => call[0] === "list").length;
    button("signal-signal-0").click(); button("signal-signal-0").click(); await tick();
    assert.equal(button("signal-signal-0").disabled, true);
    assert.match(button("signal-signal-0").textContent!, /正在打开/);
    assert.equal(calls.filter(call => call[0] === "list").length, dispatches + 1, "double click opens once while pending");
    releaseDispatch(); await tick(); dispatchGate = undefined;
    dispatchError = new Error("真实派发异常");
    await click("signal-signal-0");
    assert.match(openTestNoticeMessages.at(-1)!, /^操作未能完成。真实派发异常/);
    assert.equal(button("signal-signal-0").disabled, false, "errors release the action's busy state");
    dispatchError = new WorkbenchSetupRequired("先配置可用的模型。", "models");
    await click("signal-signal-0");
    const setupContent = openTestNotices.at(-1)!.message as unknown as DocumentFragment;
    assert.match(setupContent.textContent!, /先配置可用的模型/);
    assert.equal(setupContent.querySelector("button")?.textContent, "去设置模型");
    setupContent.querySelector("button")!.click(); await tick();
    assert.deepEqual(calls.at(-1), ["setup", "models"]);
    dispatchError = undefined;
    const claims = snapshot.signals.map((signal, index) => ({ id: `claimed-${index}`, messages: [] as ChatMessage[], taskStatus: "running", businessKey: signal.key }));
    host.settings.sessions.push(claims[0]); view.refreshHomeSurfaces();
    assert.equal(button("signal-signal-0"), undefined, "new live handoff removes the row before the next data load");
    assert.equal(content.querySelector('[data-wb-group="signals"] .wb-count')?.textContent, "6");
    claims[0].taskStatus = "waiting"; await view.refresh();
    assert.equal(button("signal-signal-0"), undefined, "waiting never restores the assign button");
    host.settings.sessions.push(...claims.slice(1)); view.refreshHomeSurfaces();
    assert.equal(content.querySelector('[data-wb-group="signals"]'), null, "zero unassigned signals hides the whole section");
    for (const claim of claims) claim.taskStatus = "completed";
    await view.refresh();
    assert.ok(button("signal-signal-0"), "ended conversations re-evaluate the current data");
    host.settings.sessions = host.settings.sessions.filter(session => !session.id.startsWith("claimed-"));
    assert.ok([...subscribers].every(listener => listener.isTaskVisible("done") === false), "overview never marks all tasks read");
    assert.equal(content.querySelectorAll("button button").length, 0);

    const tasksBeforeFold = tasks;
    tasks = [recentStop, { ...stopped, conversationId: "old-stop" }]; await view.refresh();
    const unfinished = () => Array.from(content.querySelectorAll<HTMLElement>('[data-wb-group="interrupted"] [data-task]')).map(node => node.dataset.task);
    assert.deepEqual(unfinished(), ["stop"], "only the last seven days of unfinished work show");
    assert.equal(content.querySelector('[data-wb-group="interrupted"] .wb-count')?.textContent, "2", "the count still covers every unfinished task");
    assert.equal(button("unfinished-older").textContent?.trim(), "更早 1 项");
    await click("unfinished-older"); assert.deepEqual(unfinished(), ["stop", "old-stop"]);
    assert.equal(button("unfinished-older").textContent?.trim(), "收起"); assert.equal(button("unfinished-older").getAttribute("aria-expanded"), "true");
    await click("unfinished-older"); assert.deepEqual(unfinished(), ["stop"]);
    const remote = Array.from({ length: 5 }, (_, index) => ({ id: `remote-${index}`, deviceId: "phone", deviceName: "iPhone", title: `远端对话 ${index}`, updatedAt: Date.now() - index, continuedOn: [], preview: "预览" }));
    Object.assign(host, { syncOverview: { snapshot: () => ({ projects: [], docs: {}, conversations: remote }), subscribe: () => () => {} } });
    await view.refresh();
    const remoteGroup = () => content.querySelector<HTMLElement>('[data-wb-group="remote-conversations"]')!;
    assert.equal(remoteGroup().querySelector("h2")?.textContent, "其他设备会话");
    assert.equal(remoteGroup().querySelectorAll("[data-remote-conversation]").length, 3, "three rows show");
    assert.equal(button("remote-more").textContent?.trim(), "还有 2 条");
    await click("remote-more"); assert.equal(remoteGroup().querySelectorAll("[data-remote-conversation]").length, 5);
    assert.equal(content.querySelector("[data-wb-group]:last-child")?.getAttribute("data-wb-group"), "remote-conversations", "other devices close the overview");
    Object.assign(host, { syncOverview: { snapshot: () => ({ projects: [], docs: {}, conversations: [] }), subscribe: () => () => {} } });
    const diaryItem = { id: "diary-1", documentId: "journal", status: "review", reasons: [], revision: 1, createdAt: Date.now(), updatedAt: Date.now(), sourceFingerprint: "fixture",
      candidate: { type: "todo", quote: "周五前寄回合同", text: "周五前寄回合同", confidence: "high", occurred: true, ownership: "self" } };
    let diaryItems = [diaryItem];
    const diaryConfirms: string[] = [];
    Object.assign(host.settings, { diaryOrganizerEnabled: true });
    Object.assign(host, { diaryOrganizer: { hasJournals: true, engine: { getState: () => ({ items: diaryItems, documents: [] }),
      async confirm(id: string) { diaryConfirms.push(id); diaryItems = []; return { status: "written" }; }, async ignore() { return { status: "blocked", reason: "fixture" }; } } } });
    tasks = [waiting]; await view.refresh();
    const diaryCard = content.querySelector<HTMLElement>('[data-wb-group="waiting"] [data-wb="diary-review-card"]')!;
    assert.ok(diaryCard, "journal items to check join 待确认");
    assert.match(diaryCard.textContent ?? "", /1 项待办与账目.*周五前寄回合同/u);
    assert.equal(content.querySelector('[data-wb-group="waiting"] .wb-count')?.textContent, "2", "the waiting task and the journal item count together");
    await click("diary-review-toggle");
    assert.ok(content.querySelector('[data-wb-group="waiting"] [data-wb-part="diary-review"] .diary-organizer-review'), "rows open below the cards");
    assert.equal(button("diary-review-toggle").getAttribute("aria-expanded"), "true");
    await click("diary-confirm-all"); await view.refresh();
    assert.deepEqual(diaryConfirms, ["diary-1"]);
    assert.equal(content.querySelector('[data-wb="diary-review-card"]'), null, "a confirmed list leaves the group");
    Object.assign(host, { diaryOrganizer: undefined }); Object.assign(host.settings, { diaryOrganizerEnabled: false });
    tasks = tasksBeforeFold; await view.refresh();

    failTasks = true; failData = true; await view.refresh();
    assert.match(content.textContent ?? "", /尚未更新/);
    assert.equal(button("resume-stop").disabled, true); assert.equal(button("signal-signal-0").disabled, true);
    assert.equal(content.querySelector('[data-wb="empty"]')?.hasAttribute("hidden"), true);
    failTasks = failData = false; await click("retry");
    assert.equal(button("resume-stop").disabled, false);
    snapshot = { ...snapshot, issues: ["请先选择收件箱位置"] }; await view.refresh();
    assert.match(content.textContent ?? "", /部分事项暂时无法确认/);

    const todo: ParsedTodoRecord = { id: "today", title: "真实待办", people: "", dueDate: localDate(new Date()), dueTime: "14:30", categoryName: "工作", done: false, lineStart: 0, lineEnd: 0, extraMetaLines: [] };
    snapshot = { ...snapshot, issues: [], todayTodos: [todo] }; await view.refresh();
    todoFailure = true; await click("todo-today"); assert.equal(snapshot.todayTodos.length, 1);
    assert.ok(button("todo-today")); todoFailure = false; await click("todo-today"); await view.refresh();
    assert.equal(content.querySelector('[data-wb-group="todos"]')?.getAttribute("data-state"), undefined);

    await click("search-trigger"); await new Promise(resolve => setTimeout(resolve, 120)); await tick();
    assert.equal(content.querySelectorAll('[role="option"]').length, 6);
    assert.equal(content.querySelector('[data-wb="search-heading"]')?.textContent, "最近编辑", "before any input the list is the most recently edited notes");
    const input = content.querySelector<HTMLInputElement>('[data-wb="search-input"]')!;
    input.value = "别名"; input.dispatchEvent(new Event("input", { bubbles: true })); await new Promise(resolve => setTimeout(resolve, 120)); await tick();
    assert.equal(content.querySelectorAll('[role="option"]').length, 6, "original metadata search is used");
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    assert.ok(input.getAttribute("aria-activedescendant"));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); await tick();
    assert.equal(calls.at(-1)?.[0], "note"); assert.equal(document.activeElement, button("search-trigger"));
    await click("search-trigger"); input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); assert.equal(document.activeElement, button("search-trigger"));

    hasFocus = false; window.dispatchEvent(new Event("blur"));
    const reads = [taskReads, dataReads];
    for (const listener of subscribers) listener.refresh("run"); for (const listener of dataSubscribers) listener();
    await new Promise(resolve => setTimeout(resolve, 130));
    assert.deepEqual([taskReads, dataReads], reads, "background updates only set a pending flag");
    assert.equal((view as unknown as { refreshTimer: number | null }).refreshTimer, null);
    assert.equal((view as unknown as { clockTimer: number | null }).clockTimer, null);
    hasFocus = true; window.dispatchEvent(new Event("focus")); await tick();
    assert.ok(taskReads > reads[0] && dataReads > reads[1]);
    tasks = Array.from({ length: 5 }, (_, index) => entry(`cold-${index}`, "completed"));
    projectionText.set("cold-0", ""); failedProjections.add("cold-1");
    await view.refresh();
    assert.equal(maxProjectionConcurrency, 3, "stored result reads have bounded concurrency");
    assert.match(content.querySelector('[data-task="cold-0"] .wb-secondary')?.textContent ?? "", /未记录结果摘要/);
    assert.match(content.querySelector('[data-task="cold-1"] .wb-secondary')?.textContent ?? "", /暂时无法读取结果/);
    const failedReads = projectionReads.get("cold-1");
    await view.refresh(); assert.equal(projectionReads.get("cold-1"), failedReads, "failed revisions are not repeatedly read during streaming refreshes");
    failedProjections.delete("cold-1"); await click("retry");
    assert.equal(projectionReads.get("cold-1"), failedReads! + 1);
    assert.match(content.querySelector('[data-task="cold-1"] .wb-secondary')?.textContent ?? "", /真正结果/);
    assert.equal(calls.some(call => call[0] === "metadata-write" || call[0] === "provider"), false);
    const maintenanceTask = entry("maintenance", "running"); tasks = [maintenanceTask];
    const activity: MaintenanceActivity = { kind: "maintenance", id: "maintenance-record", originConversationId: maintenanceTask.conversationId,
      status: "running", stage: "write", sourceCount: 20, sourcePaths: ["Raw/合成资料.md"], batch: { index: 1, total: 1 },
      activeElapsedMs: 1000, etaMs: null, updatedAt: Date.now(), currentPath: "Wiki/合成条目.md", pageCounts: { written: 14, created: 10, updated: 4 }, failures: [],
      steps: MAINTENANCE_ACTIVITY_STAGES.map((stage, index) => ({ stage, completed: stage === "write" ? 7 : 0, total: stage === "write" ? 12 : null, state: index < 3 ? "completed" : index === 3 ? "running" : "pending" })) };
    publishActivities(activity); await view.refresh();
    assert.match(content.querySelector('[data-task="maintenance"]')?.textContent ?? "", /进行中.*已写好 7 页，还剩 5 页（共 12 页）/u);
    assert.equal(content.querySelector('[data-task="maintenance"] .wb-task-title')?.textContent, "整理知识库（20 篇资料）");
    assert.doesNotMatch(content.querySelector('[data-task="maintenance"] .wb-task-step')?.textContent ?? "", /第 1 批/u);
    publishActivities({ ...activity, batch: { index: 1, total: 2 } });
    assert.match(content.querySelector('[data-task="maintenance"] .wb-task-step')?.textContent ?? "", /第 1 批（共 2 批）/u);
    publishActivities({ ...activity, sourceCount: null });
    assert.equal(content.querySelector('[data-task="maintenance"] .wb-task-title')?.textContent, "整理知识库");
    const partial: MaintenanceActivity = { ...activity, status: "partial", updatedAt: activity.updatedAt + 1,
      failures: [{ key: "write:internal", message: "CAS revision stage resume targetPath Wiki/合成条目.md 冲突", at: Date.now() }] };
    publishActivities(partial);
    const partialCard = content.querySelector<HTMLElement>('[data-task="maintenance"]')!;
    assert.equal(partialCard.closest<HTMLElement>("[data-wb-group]")?.dataset.wbGroup, "interrupted");
    assert.match(partialCard.textContent ?? "", /未完成.*《合成条目》.*保留您的修改.*继续/u);
    assert.equal(maintenanceVisibleCopyIsSafe(partialCard.textContent ?? ""), true);
    assert.equal(maintenanceVisibleCopyIsSafe(button("task-maintenance").getAttribute("aria-label") ?? ""), true);
    assert.equal(maintenanceTask.taskStatus, "running", "business display never rewrites the Catalog object");
    assert.equal(content.querySelectorAll('[data-task="maintenance"]').length, 1);
    publishActivities({ ...activity, status: "completed", completedAt: Date.now(), updatedAt: activity.updatedAt + 2 });
    const completedCard = content.querySelector<HTMLElement>('[data-task="maintenance"]')!;
    assert.equal(completedCard.closest<HTMLElement>("[data-wb-group]")?.dataset.wbGroup, "completed");
    assert.ok(completedCard.textContent?.includes(maintenanceCompletionText(activity)));
    assert.equal(completedCard.querySelector(".wb-row-title")?.textContent, "整理知识库（20 篇资料）");
    assert.deepEqual(Array.from(content.querySelectorAll("[data-wb-group] h2")).map(node => node.textContent), ["可以交给 Agent", "今日已完成"], "maintenance never renames visible groups");
    const firstBatch = { ...activity, batch: { index: 1, total: 2 }, sourcePaths: ["Raw/长文.md"],
      status: "completed" as const, completedAt: Date.now() };
    const secondBatch = { ...activity, id: "second-record", batch: { index: 2, total: 2 }, sourcePaths: ["Raw/笔记甲.md", "Raw/笔记乙.md"],
      stage: "plan" as const, status: "failed" as const, updatedAt: firstBatch.updatedAt + 1 };
    publishActivities(firstBatch, secondBatch);
    assert.match(content.querySelector('[data-wb-group="interrupted"] [data-task="maintenance"]')?.textContent ?? "", /第 2 批.*第 3 步.*汇总查重/u);
    const batchesCompletedAt = Date.now();
    publishActivities(firstBatch, { ...secondBatch, stage: "finalize", status: "completed", completedAt: batchesCompletedAt });
    assert.equal(content.querySelector('[data-wb-group="interrupted"]'), null, "completed batches leave no interrupted group");
    assert.equal(content.querySelector('[data-wb-group="completed"] [data-task="maintenance"] .wb-row-title')?.textContent, "整理知识库（3 篇资料）");
    tasks = [{ ...maintenanceTask, taskStartedAt: batchesCompletedAt + 1 }]; await view.refresh();
    assert.equal(content.querySelector('[data-wb-group="running"] [data-task="maintenance"] .wb-task-title')?.textContent, maintenanceTask.title);
    tasks = [maintenanceTask]; await view.refresh();
    const upgrade = { ...activity, taskKind: "upgrade" as const, upgradeCounts: { sourceTotal: 20, sourceCompleted: 20, linkTotal: 4, linksCompleted: 4, wikiTotal: 3, wikiCompleted: 3 } };
    publishActivities(upgrade);
    assert.equal(content.querySelector('[data-task="maintenance"] .wb-task-title')?.textContent, "升级旧知识");
    await click("stop-upgrade-maintenance");
    assert.equal(calls.filter(call => call[0] === "stop-upgrade").length, 1, "Upgrade stop does not depend on a Pi agent run");
    upgradeTaskId = "another-upgrade";
    await click("stop-upgrade-maintenance");
    assert.equal(calls.filter(call => call[0] === "stop-upgrade").length, 1, "A task cannot stop a foreign upgrade");
    const completedAt = Date.now();
    publishActivities({ ...upgrade, status: "completed", completedAt, updatedAt: completedAt });
    assert.equal(content.querySelector('[data-task="maintenance"] .wb-row-title')?.textContent, "升级旧知识");
    assert.doesNotMatch(content.querySelector('[data-task="maintenance"] .wb-secondary')?.textContent ?? "", /生成.*Wiki/u);
    assert.match(content.querySelector('[data-task="maintenance"] .wb-secondary')?.textContent ?? "", /20.*篇.*4.*条.*3.*页/u);
    tasks = [{ ...maintenanceTask, taskStartedAt: completedAt + 1 }]; await view.refresh();
    assert.equal(content.querySelector('[data-task="maintenance"] .wb-task-title')?.textContent, maintenanceTask.title, "A later ordinary task retains its original title");
    publishActivities();
    tasks = []; snapshot = { ...snapshot, signals: [], todayTodos: [] }; await view.refresh();
    assert.equal(content.querySelectorAll('[data-wb-group][data-state="empty"]').length, 0);
    snapshot = { ...snapshot, issues: ["待办读取失败：合成错误"] }; await view.refresh();
    assert.equal(content.querySelector('[data-wb-group="signals"]')?.getAttribute("data-state"), "unconfirmed");
    assert.equal(content.querySelector('[data-wb-group="todos"]')?.getAttribute("data-state"), "unconfirmed");
    assert.equal(content.querySelector('[data-wb-group="todos"] .wb-count')?.hasAttribute("hidden"), true);
    assert.doesNotMatch(content.querySelector('[data-wb-group="todos"]')?.textContent ?? "", /今天没有待办/);
    snapshot = { ...snapshot, issues: ["财务：合成错误"] }; await view.refresh();
    assert.equal(content.querySelector('[data-wb-group="todos"]')?.getAttribute("data-state"), undefined, "unrelated finance errors do not hide verified to-dos");
    failTasks = failData = true; await view.refresh();
    assert.equal(content.querySelectorAll('[data-wb-group][data-state="error"]').length, 6);
    assert.equal(content.querySelectorAll('[data-wb-group] .wb-count:not([hidden])').length, 0);
    failTasks = failData = false; pro = false; host.settings.englishDiary.enabled = true;
    snapshot = { ...snapshot, issues: [] }; await view.refresh();
    // Hiding one module leaves the overview plus the same six widths this layout case has always measured.
    host.settings.workbenchNavigation = { ...structuredClone(DEFAULT_SETTINGS.workbenchNavigation), hidden: ["journal"] }; view.refreshNavigation();
    const header = content.querySelector<HTMLElement>(".wb-header")!, nav = content.querySelector<HTMLElement>(".wb-modules")!;
    const navStyles = document.createElement("style"); navStyles.textContent = ".wb-header { column-gap: 16px } .wb-modules { column-gap: 4px }"; document.head.append(navStyles);
    cleanups.push(() => navStyles.remove());
    const navButtons = Array.from(nav.querySelectorAll<HTMLButtonElement>("[data-module]")), more = content.querySelector<HTMLElement>('[data-wb="module-more"]')!;
    [80, 80, 140, 105, 160, 160, 60].forEach((width, index) => { navButtons[index].getBoundingClientRect = () => ({ width } as DOMRect); });
    more.getBoundingClientRect = () => ({ width: 74 } as DOMRect);
    let withoutWeather = 1020;
    nav.getBoundingClientRect = () => ({ width: Math.max(1, withoutWeather
      - (header.classList.contains("is-weather-condensed") ? 0 : content.querySelector(".wb-sky.is-feedback") ? 350 : 170)
      + 2 * (16 - Number.parseFloat(header.style.columnGap || "16"))) } as DOMRect);
    const layout = view as unknown as { fitNavigation(): void; weatherStage: { say(text: string): void; clearFeedback(): void } };
    layout.weatherStage.clearFeedback(); layout.fitNavigation();
    assert.equal(more.hidden, true); assert.equal(header.classList.contains("is-weather-condensed"), false, "weather stays when every module fits");
    layout.weatherStage.say("签到成功 · 第 2 天"); layout.fitNavigation();
    assert.equal(header.classList.contains("is-weather-condensed"), true, "check-in feedback yields weather space before modules");
    assert.match(content.querySelector(".wb-checkin-message")?.textContent ?? "", /签到成功/);
    assert.equal(navButtons.filter(button => !button.hidden).length, 7);
    layout.weatherStage.clearFeedback(); layout.fitNavigation();
    assert.equal(header.classList.contains("is-weather-condensed"), false, "weather returns after the temporary message clears");
    withoutWeather = 900; layout.fitNavigation();
    assert.equal(more.hidden, true, "hide weather before overflowing modules");
    withoutWeather = 140; layout.fitNavigation();
    assert.equal(navButtons[0].hidden, false, "narrow layout reclaims column gaps before losing the first module");
    assert.equal(more.hidden, false); assert.equal(navButtons.filter(button => !button.hidden).length, 1);
    assert.ok(Number.parseFloat(header.style.columnGap) < 16);
    console.log("Workbench UI passed: task groups, cold-shell result projections and revision cache, no duplicate summaries after redraw, bounded read concurrency and retry, local date, real routes, valid question binding, prefill, collapse and focus, stale errors, to-do success/failure, search keyboard, foreground lifecycle.");
  } finally {
    const beforeClose = calls.length;
    button("module-journal")?.click(); await tick();
    await view.onClose();
    assert.equal(panelCurrent, null, "closing the workbench closes the module page it was showing");
    assert.equal(calls.length, beforeClose, "closing the view opens nothing else");
    for (const cleanup of cleanups.reverse()) cleanup(); container.remove();
    assert.equal(subscribers.size, 0); assert.equal(dataSubscribers.size, 0); assert.equal(activityListeners.size, 0);
  }
  await runDesktopModuleSettingsTests();
  await runGuidedSetupModelDependencyTest();
  await runWorkbenchNavigationSettingsTest();
}
async function runWorkbenchNavigationSettingsTest(): Promise<void> {
  assert.deepEqual(normalizeWorkbenchNavigation(undefined), defaultWorkbenchNavigation(), "missing settings fall back to the product order");
  const saved = normalizeWorkbenchNavigation({ order: ["news", "removed-module", "todos", "news", 3], hidden: ["todos", "overview", "todos", "gone"] });
  assert.deepEqual(saved.order, ["news", "todos", "journal", "finance", "knowledge-base", "english-diary", "pdf-reading", "experts"],
    "unknown and repeated entries drop; entries the saved order lacks join at the end");
  assert.deepEqual(saved.hidden, ["todos"], "only real modules can be hidden; the overview never is");
  assert.equal(isDefaultWorkbenchNavigation(defaultWorkbenchNavigation()), true);
  assert.equal(isDefaultWorkbenchNavigation(saved), false);
  const settings = { workbenchNavigation: defaultWorkbenchNavigation(), expertsEnabled: false, settingsLanguage: "zh-CN" };
  const writes: { candidate: typeof saved; finish(): void; fail(): void }[] = [];
  let onDisk = structuredClone(settings.workbenchNavigation);
  const host = { settings, refreshWorkbenchNavigation() {}, persistPiNativeSettings: () => new Promise<void>((resolve, reject) => {
    const candidate = structuredClone(settings.workbenchNavigation);
    writes.push({ candidate, finish() { onDisk = candidate; resolve(); }, fail() { reject(new Error("fixture write failure")); } });
  }) } as unknown as CodexForObsidianPlugin;
  const page = document.body.createDiv();
  try {
    renderWorkbenchNavigationSettings(page, host, true);
    const journalToggle = () => page.querySelector<OriginCheckElement>('[data-workbench-nav-toggle="journal"]')!;
    const hideJournal = () => {
      const toggle = journalToggle(); toggle.checked = false; toggle.dispatchEvent(new Event("change"));
    };
    const moveTodosUp = () => page.querySelector('[data-workbench-nav-handle="todos"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp" }));
    hideJournal(); moveTodosUp(); await tick();
    assert.equal(writes.length, 1, "quick changes wait for the preceding durable write");
    assert.deepEqual(writes[0].candidate.hidden, ["journal"]);
    assert.equal(writes[0].candidate.order[0], "journal");
    writes[0].fail(); await tick();
    assert.deepEqual(writes[1].candidate.hidden, [], "the queued reorder does not carry the failed toggle");
    assert.equal(writes[1].candidate.order[0], "todos");
    assert.equal(journalToggle().checked, true, "the failed toggle recovers in the live settings section");
    writes[1].finish(); await tick();
    hideJournal(); await tick();
    writes[2].fail(); await tick();
    assert.deepEqual(settings.workbenchNavigation, onDisk, "failure restores the most recent durable order");
    assert.equal(journalToggle().checked, true);
  } finally { page.remove(); }
  console.log("PASS workbench navigation settings: defaults, durable saves and recovery across queued toggle/reorder");
}

export async function runWorkbenchFinancePreparationTest(fixture: string): Promise<void> {
  const workspace = { layoutReady: false, tabOpens: 0, getLeaf() { this.tabOpens++; return new WorkspaceLeaf(); }, setActiveLeaf() {} };
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.lifestyle.finance.enabled = true;
  const host = { settings, app: { workspace }, getVaultPath: () => fixture, getPluginDataDirName: () => ".obsidian/plugins/finance-fixture" };
  const plugin = host as unknown as CodexForObsidianPlugin;
  const service = new LifestyleService(plugin);
  Object.assign(host, { lifestyle: service });
  let starts = 0;
  let finish!: () => void;
  service.finance.initialize = () => { starts++; return new Promise(resolve => { finish = resolve; }); };
  const element = document.body.createDiv();
  const panel = new WorkbenchModulePanel(element, new WorkspaceLeaf(), plugin);
  try {
    assert.equal(await panel.show("finance"), false, "the embedded page cannot open before the workspace layout is ready");
    assert.equal(starts, 0);
    workspace.layoutReady = true;
    const opening = panel.show("finance"); await tick();
    assert.equal(starts, 1);
    assert.equal(panel.current, null, "the embedded view waits for ledger initialization");
    await panel.clear(); finish();
    assert.equal(await opening, false);
    assert.equal(element.childElementCount, 0, "finance preparation cannot mount after leaving the panel");
    const standalone = service.open("finance"); await tick();
    assert.equal(workspace.tabOpens, 0);
    finish(); await standalone;
    assert.equal(workspace.tabOpens, 1, "the standalone route preserves enabled finance access for read-only users");
  } finally { await panel.clear(); service.dispose(); element.remove(); }
  console.log("PASS finance open: shared readiness, stale embedded preparation and standalone read-only entry");
}
async function runGuidedSetupModelDependencyTest(): Promise<void> {
  const bindings = emptyKnowledgeFolderBindings();
  for (const [role, path] of [["raw", "资料"], ["wiki", "知识成果"], ["inbox", "收件箱"], ["outputs", "产出"], ["journal", "日记"]] as const) {
    Object.assign(bindings.roles[role], { enabled: true, readPaths: [path], writePath: path });
  }
  const plan: OnboardingSetupPlan = { directoryPlan: { baseRevision: 0, bindings, issues: [], create: [], reuse: [], moves: [], mode: "build",
    sources: ["资料"], baseSignature: "fixture", changes: [], excluded: [], fileSnapshot: "fixture" }, sources: [{ path: "资料", noteCount: 1, existingBinding: false }],
    folders: ["资料"], sourceCandidates: [{ path: "资料", noteCount: 1 }], skipped: [], rootNotes: { count: 0, description: "" }, noteCount: 1,
    outputLocations: { answer: "产出", generation: "产出" }, guide: { path: "产出/开始使用 EchoInk.md", action: "create" } };
  for (const connected of [false, true]) {
    const unexpectedWrite = async (): Promise<never> => { throw new Error("Reviewing choices must not execute setup"); };
    const options: PaperGuideModalOptions = { language: "zh-CN",
      preferences: {
        read: async () => ({
          state: "custom", content: "已有偏好", revision: "fixture",
          profileVersion: "echoink-knowledge-preference-profile-v1",
        }),
        save: async () => { throw new Error("not used"); },
        available: () => false,
        generate: async () => { throw new Error("not used"); },
      },
      preview: async choices => ({ ...plan, choices }), model: () => connected ? "Fixture model" : null,
      apply: unexpectedWrite, connect: unexpectedWrite, writeGuide: unexpectedWrite, openGuide: unexpectedWrite, refine: unexpectedWrite,
      onManual: unexpectedWrite, onTry: unexpectedWrite, onDismiss: async () => {}, onClosed() {} };
    const dialog = new PaperGuideModal({ scope: {}, keymap: { pushScope() {}, popScope() {} } } as unknown as import("obsidian").App, options);
    dialog.open();
    try {
      dialog.modalEl.querySelector<HTMLButtonElement>('[data-setup-choice="guided"]')!.click(); await tick();
      for (let step = 0; step < 2; step++) {
        Array.from(dialog.modalEl.querySelectorAll<HTMLButtonElement>(".echoink-setup-footer button")).find(button => button.textContent?.startsWith("下一步"))!.click(); await tick();
      }
      const refine = dialog.modalEl.querySelector<HTMLButtonElement>('[role="checkbox"][aria-label="马上提炼最近 20 篇"]')!;
      assert.equal(refine.disabled, !connected, "finishing a render must preserve the missing-model dependency");
      assert.equal(refine.getAttribute("aria-checked"), "false", "distillation starts off even with a model");
      refine.click(); await tick();
      assert.equal(refine.getAttribute("aria-checked"), String(connected), "only an available model permits opting in");
      assert.match(dialog.modalEl.textContent ?? "", /模型额度/);
    } finally { dialog.dispose(); }
  }
  console.log("PASS guided setup: model dependency survives busy-state rendering; distillation defaults off and requires explicit opt-in");
}
function signal(index: number): WorkbenchSignal {
  const moduleId: AgentModuleId = "todos";
  return { id: 1, key: `signal-${index}`, moduleId, icon: "list-todo", description: `真实事项 ${index}`, prompt: `处理事项 ${index}`, source: { version: 1, signalId: 1, businessKey: `signal-${index}`, moduleId, objects: [], prompt: `处理事项 ${index}`, capturedAt: Date.now() } };
}
function localDate(date: Date): string { return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`; }
