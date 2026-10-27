import assert from "node:assert/strict";
import { WorkspaceLeaf, TFile } from "obsidian";
import { EchoInkWorkbenchView, VIEW_TYPE_ECHOINK_WORKBENCH, groupWorkbenchTasks, workbenchInlineQuestion } from "../home/workbench-view";
import { openWorkbenchModule } from "../home/module-navigation";
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
  let memoryNotice: VaultMemoryNotice | null = null;
  let memoryError: string | null = null;
  let projectionsInFlight = 0, maxProjectionConcurrency = 0;
  let pro = true;
  const projectionReads = new Map<string, number>(), projectionText = new Map<string, string>(), failedProjections = new Set<string>();
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
  let snapshot: WorkbenchSnapshot = { generatedAt: Date.now(), signals: [], todayTodos: [], modules: ["journal", "todos", "finance", "knowledge-base", "english-diary", "pdf-reading"], issues: [] };
  const port: WorkbenchDataPort = {
    async load() { dataReads++; if (failData) throw new Error("本地事项读取失败"); return snapshot; },
    subscribe(listener) { dataSubscribers.add(listener); return () => { dataSubscribers.delete(listener); }; },
    async recordTaskAccepted() {}, async recordTaskCompleted() {}, dispose() { throw new Error("view must not dispose plugin-owned service"); }
  };
  (globalThis as unknown as { __p5WorkbenchPort: WorkbenchDataPort }).__p5WorkbenchPort = port;
  const files = Array.from({ length: 8 }, (_, index) => Object.assign(new TFile(), { path: `wiki/note-${index}.md`, basename: `笔记 ${index}`, stat: { mtime: now + index, size: 30 } }));
  const host = {
    app: {
      vault: { getMarkdownFiles: () => files, cachedRead: async () => "正文检索测试", getAbstractFileByPath: (path: string) => files.find(file => file.path === path) },
      metadataCache: { getFileCache: () => ({ frontmatter: { aliases: ["别名"] }, tags: [{ tag: "#fixture" }] }) },
      workspace: { on() { return {}; }, getLeaf() { return { async openFile(file: TFile) { calls.push(["note", file.path]); } }; } }
    },
    settings: { settingsLanguage: "zh-CN", lifestyle: { finance: { enabled: true } }, pdfReading: { enabled: true }, englishDiary: { ...DEFAULT_ENGLISH_DIARY_SETTINGS, enabled: false }, sessions: [] as { id: string; messages: ChatMessage[] }[], agentRegistry: { agents: [{ id: "sol", name: "总助", avatar: { kind: "default" } }], moduleOwners: Object.fromEntries(["journal", "todos", "finance", "knowledge-base", "english-diary", "pdf-reading", "review"].map(id => [id, "sol"])) } },
    accountService: { checkCapability: () => pro, subscribe: () => () => {} },
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
        return { catalog: tasks.find(task => task.conversationId === taskId)!, activeLeafId: null, diagnostics: [], drafts: [], messages: text ? [{ id: "answer", role: "assistant", text }] : [] };
      } finally { projectionsInFlight--; }
    },
    async setPiConversationTaskMetadata() { calls.push(["metadata-write"]); throw new Error("overview must not mark results read"); },
    async ensurePiRuntimeBundle() { calls.push(["provider"]); throw new Error("overview must not initialize Provider"); },
    async readTaskInterruption(taskId: string) { return { taskId, reason: "user_stopped", at: now, stage: "真实步骤", uncertainOperations: [] }; },
    async openTaskDetail(id: string) { calls.push(["detail", id]); },
    async resumeTaskAndOpenDetail(id: string) { calls.push(["resume", id]); await new Promise<void>(resolve => { releaseResume = resolve; }); },
    async openAgentTaskList(...args: unknown[]) { calls.push(["list", ...args]); return true; },
    async readPiConversationCatalogEntry(id: string) { return tasks.find(task => task.conversationId === id); },
    piTurnInteractionBinding(identity: unknown) { return { submit(answers: unknown) { calls.push(["answer", identity, answers]); return true; } }; },
    async activateKnowledgeView() { calls.push(["knowledge"]); },
    async activateTodoView() { calls.push(["todos"]); },
    async activateJournalView() { calls.push(["journal"]); },
    async activateEnglishDiaryPage() { calls.push(["english"]); },
    async activatePdfReadingPage() { calls.push(["pdf"]); },
    async openEchoInkGeneralSettings() { calls.push(["settings"]); },
    async openEchoInkAccountSettings(target?: "login" | "benefits") { calls.push(["account", target]); },
    async openEchoInkKnowledgeSettings() { calls.push(["knowledge"]); },
    lifestyle: { async open(kind: string) { calls.push(["lifestyle", kind]); } },
    englishDiary: { async openToday() { calls.push(["english"]); } },
    getTodoStore: () => ({ async toggleDone(todo: ParsedTodoRecord, done: boolean) { calls.push(["todo", todo.id, done]); if (todoFailure) throw new Error("保存失败"); snapshot = { ...snapshot, todayTodos: [] }; } })
  };
  const plugin = host as unknown as CodexForObsidianPlugin;
  const content = document.body.createDiv();
  const container = document.body.createDiv(); container.appendChild(content);
  Object.defineProperty(container, "getClientRects", { value: () => [{ width: 900, height: 800 }] });
  Object.defineProperty(document, "hasFocus", { configurable: true, value: () => hasFocus });
  const view = new EchoInkWorkbenchView(new WorkspaceLeaf(), plugin);
  const cleanups: (() => void)[] = [];
  Object.assign(view, { contentEl: content, containerEl: container, app: host.app,
    register: (dispose: () => void) => cleanups.push(dispose), registerEvent() {},
    registerDomEvent(element: EventTarget, type: string, callback: EventListener, options?: AddEventListenerOptions) { element.addEventListener(type, callback, options); cleanups.push(() => element.removeEventListener(type, callback, options)); }
  });
  const button = (key: string) => Array.from(content.querySelectorAll<HTMLButtonElement>("[data-wb-focus]")).find(node => node.dataset.wbFocus === key)!;
  const click = async (key: string) => { button(key).click(); await tick(); };
  try {
    assert.equal(view.getViewType(), VIEW_TYPE_ECHOINK_WORKBENCH);
    await view.onOpen();
    assert.match(content.textContent ?? "", /正在读取任务/);
    assert.equal(content.querySelectorAll('[data-wb-group][data-state="loading"]').length, 6);
    assert.equal(content.querySelectorAll('[data-wb-group] .wb-count:not([hidden])').length, 0, "unread groups never claim zero");
    await tick();
    assert.equal(content.querySelectorAll('[data-wb-group][data-state="empty"]').length, 0);
    assert.equal(content.querySelectorAll('[data-wb-group] .wb-count:not([hidden])').length, 0);
    assert.equal(content.querySelector("time")?.getAttribute("datetime"), localDate(new Date()));
    memoryNotice = { kind: "mismatch", reason: "Personal Memory manifest belongs to another Vault" };
    await view.refresh();
    assert.equal(content.querySelectorAll(".wb-memory-notice").length, 1);
    assert.equal(content.querySelectorAll('[data-wb-group][data-state="error"]').length, 0, "memory failure does not fail task groups");
    assert.equal(content.querySelector(".wb-memory-notice details")?.hasAttribute("open"), false);
    assert.ok(content.querySelector(".wb-memory-notice details")?.textContent?.includes(memoryNotice.reason));
    const memoryHost = content.querySelector<HTMLElement>('[data-wb="memory-notice"]')!;
    assert.equal(memoryHost.nextElementSibling?.getAttribute("data-wb"), "starters", "memory explanation precedes starter cards and task groups");
    const useMemory = memoryHost.querySelector<HTMLButtonElement>(".is-primary")!;
    assert.equal(useMemory.textContent, "沿用这份记忆"); useMemory.click(); await tick();
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
    assert.equal(memoryHost.querySelector<HTMLButtonElement>(".is-primary")!.textContent, "Use this memory");
    memoryHost.querySelector<HTMLButtonElement>(".is-primary")!.click(); await tick();
    assert.deepEqual(calls.at(-1), ["resolve-memory", "adopt"]); assert.equal(memoryHost.children.length, 0);
    memoryError = "fixture unsupported schema"; await view.refresh();
    assert.equal(memoryHost.children.length, 0); assert.match(content.querySelector('[data-wb="status"]')?.textContent ?? "", /Memory unavailable/u);
    assert.equal(content.querySelectorAll('[data-wb-group][data-state="error"]').length, 0);
    memoryError = null; host.settings.settingsLanguage = "zh-CN"; await view.refresh();
    await click("new-task"); assert.deepEqual(calls.at(-1), ["list", GENERAL_ASSISTANT_ID]);
    await click("settings"); assert.deepEqual(calls.at(-1), ["settings"]);
    for (const module of snapshot.modules) await openWorkbenchModule(plugin, module);
    assert.ok(calls.some(call => JSON.stringify(call) === '["journal"]'));
    assert.ok(calls.some(call => JSON.stringify(call) === '["todos"]'));
    assert.ok(calls.some(call => JSON.stringify(call) === '["lifestyle","finance"]'));
    assert.ok(calls.some(call => call[0] === "knowledge")); assert.ok(calls.some(call => call[0] === "english"));

    pro = false; host.settings.englishDiary.enabled = true; await view.refresh();
    for (const id of ["finance", "english-diary", "pdf-reading"] as const) {
      assert.equal(button(`module-${id}`).hidden, false);
      assert.ok(button(`module-${id}`).querySelector('[data-plugin-edition="pro"]'));
      const previousCalls = calls.length;
      await click(`module-${id}`);
      const locked = content.querySelector<HTMLElement>(`[data-locked-module="${id}"]`)!;
      assert.ok(locked); assert.match(locked.textContent ?? "", /PRO 模块/);
      assert.equal(calls.length, previousCalls, "locked navigation never opens the module service");
      assert.equal(content.querySelector<HTMLElement>('[data-wb="page"]')!.inert, true);
      await click("module-lock-login"); assert.deepEqual(calls.at(-1), ["account", "login"]);
      await click("module-lock-benefits"); assert.deepEqual(calls.at(-1), ["account", "benefits"]);
      await click("module-lock-back"); assert.equal(document.activeElement, button(`module-${id}`));
    }
    host.settings.lifestyle.finance.enabled = false; await view.refresh();
    assert.equal(button("module-finance").hidden, true);
    const disabledCalls = calls.length;
    button("module-finance").click(); await tick(); assert.equal(calls.length, disabledCalls, "stale hidden navigation cannot open a disabled module");
    host.settings.lifestyle.finance.enabled = true; pro = true; await view.refresh();
    assert.equal(button("module-finance").querySelector('[data-plugin-edition="pro"]'), null);
    await click("module-finance"); assert.deepEqual(calls.at(-1), ["lifestyle", "finance"]);
    host.settings.englishDiary.enabled = false;

    const completed = Object.freeze({ ...entry("done", "completed"), unreadAnswerAt: Date.now() });
    const runningTitle = `完整工作台标题 ${"长".repeat(110)}`, runningStage = "😀".repeat(110);
    tasks = [stopped, waiting, { ...entry("run", "running"), title: runningTitle, taskStage: runningStage }, completed];
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
    assert.deepEqual(Array.from(content.querySelectorAll("[data-wb-group] h2")).map(node => node.textContent), ["等你回应", "正在进行", "没做完", "可以交给 Agent", "今天完成"]);
    assert.match(content.textContent ?? "", /被你停止/);
    assert.equal(content.querySelectorAll('[data-wb-group="signals"] .wb-row').length, 5);
    const retained = button("signal-signal-0");
    button("signal-toggle").focus(); await click("signal-toggle");
    assert.equal(content.querySelectorAll('[data-wb-group="signals"] .wb-row').length, 7);
    assert.equal(button("signal-signal-0"), retained, "expansion preserves existing controls");
    assert.equal(document.activeElement, button("signal-toggle"));
    await click("signal-toggle"); assert.equal(content.querySelectorAll('[data-wb-group="signals"] .wb-row').length, 5);
    await click("task-stop"); assert.deepEqual(calls.at(-1), ["detail", "stop"]);
    const resume = button("resume-stop"); resume.focus(); resume.click(); resume.click(); await tick();
    assert.equal(calls.filter(call => call[0] === "resume").length, 1, "double click only resumes once");
    assert.equal(button("resume-stop"), resume, "pending state preserves the control being used");
    assert.equal(resume.disabled, true); assert.equal(document.activeElement, resume);
    releaseResume!(); await tick(); assert.equal(button("resume-stop"), resume); assert.equal(resume.disabled, false);
    await click("answer-wait-a"); assert.ok(calls.some(call => call[0] === "answer"));
    const answers = calls.filter(call => call[0] === "answer").length;
    await click("answer-wait-b"); assert.equal(calls.filter(call => call[0] === "answer").length, answers + 1, "option meaning follows the schema rather than guessing from its label");
    pending.set(waiting.conversationId, { ...question, questions: [{ ...question.questions[0], allowSupplement: true }] }); await view.refresh();
    await click("answer-wait-a"); assert.equal(calls.filter(call => call[0] === "answer").length, answers + 2, "optional supplement still allows direct submission");
    assert.equal(button("detail-wait"), undefined, "supplement entry stays on the clickable card instead of adding a third option");
    assert.deepEqual(Array.from(content.querySelectorAll('[data-task="wait"] .wb-options button')).map(node => node.textContent), ["选项 A", "其他"]);
    content.querySelector<HTMLElement>('[data-task="wait"] .wb-question > div')!.click(); await tick();
    assert.deepEqual(calls.at(-1), ["detail", "wait"], "the question card still opens the complete question and supplement");
    await click("signal-signal-0"); assert.equal(calls.at(-1)?.[0], "list"); assert.equal(snapshot.signals.length, 7, "prefill does not consume a signal");
    assert.ok([...subscribers].every(listener => listener.isTaskVisible("done") === false), "overview never marks all tasks read");
    assert.equal(content.querySelectorAll("button button").length, 0);

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
    assert.match(content.querySelector('[data-task="cold-1"] .wb-secondary')?.textContent ?? "", /结果暂时读不到/);
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
    assert.match(partialCard.textContent ?? "", /没做完.*《合成条目》.*不覆盖你的修改.*继续/u);
    assert.equal(maintenanceVisibleCopyIsSafe(partialCard.textContent ?? ""), true);
    assert.equal(maintenanceVisibleCopyIsSafe(button("task-maintenance").getAttribute("aria-label") ?? ""), true);
    assert.equal(maintenanceTask.taskStatus, "running", "business display never rewrites the Catalog object");
    assert.equal(content.querySelectorAll('[data-task="maintenance"]').length, 1);
    publishActivities({ ...activity, status: "completed", completedAt: Date.now(), updatedAt: activity.updatedAt + 2 });
    const completedCard = content.querySelector<HTMLElement>('[data-task="maintenance"]')!;
    assert.equal(completedCard.closest<HTMLElement>("[data-wb-group]")?.dataset.wbGroup, "completed");
    assert.ok(completedCard.textContent?.includes(maintenanceCompletionText(activity)));
    assert.equal(completedCard.querySelector(".wb-row-title")?.textContent, "整理知识库（20 篇资料）");
    assert.deepEqual(Array.from(content.querySelectorAll("[data-wb-group] h2")).map(node => node.textContent), ["可以交给 Agent", "今天完成"], "maintenance never renames visible groups");
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
    console.log("Workbench UI passed: task groups, cold-shell result projections and revision cache, no duplicate summaries after redraw, bounded read concurrency and retry, local date, real routes, valid question binding, prefill, collapse and focus, stale errors, to-do success/failure, search keyboard, foreground lifecycle.");
  } finally {
    await view.onClose(); for (const cleanup of cleanups.reverse()) cleanup(); container.remove();
    assert.equal(subscribers.size, 0); assert.equal(dataSubscribers.size, 0); assert.equal(activityListeners.size, 0);
  }
  await runDesktopModuleSettingsTests();
}
function signal(index: number): WorkbenchSignal {
  const moduleId: AgentModuleId = "todos";
  return { id: 1, key: `signal-${index}`, moduleId, icon: "list-todo", description: `真实事项 ${index}`, prompt: `处理事项 ${index}`, source: { version: 1, signalId: 1, businessKey: `signal-${index}`, moduleId, objects: [], prompt: `处理事项 ${index}`, capturedAt: Date.now() } };
}
function localDate(date: Date): string { return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`; }
