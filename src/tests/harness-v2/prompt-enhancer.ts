import * as assert from "node:assert/strict";
import { FakeAgentAdapter } from "../../harness/agents/adapters/fake";
import type { HarnessRunRequest, HarnessRunResult } from "../../harness/contracts/run";
import { DEFAULT_SETTINGS } from "../../settings/settings";
import { enhanceChatInput } from "../../ui/codex-view/editor-action-runner";
import { sendMessage } from "../../ui/codex-view/turn-runner";

export async function runPromptEnhancerHarnessTests(): Promise<void> {
  await assertEmptyInputDoesNotStartHarness();
  await assertDetailedInputDoesNotStartHarness();
  await assertSuccessOnlyChangesDraftAndRestoresExactOriginal();
  await assertFailureAndCancellationKeepDraftUntouched();
  await assertEnhancedDraftSendsExactlyOneChatTurn();
}

async function assertEmptyInputDoesNotStartHarness(): Promise<void> {
  const setup = createPromptEnhancerHarness("   \n", completedCandidate("不应运行"));
  await enhanceChatInput(setup.view);
  assert.equal(setup.harnessRequests.length, 0);
  assert.equal(setup.chatTurns, 0);
  assert.equal(setup.view.inputEl.value, "   \n");
}

async function assertDetailedInputDoesNotStartHarness(): Promise<void> {
  const detailed = [
    "# 任务",
    "请分析这份销售数据，明确目标、数据范围、指标口径、异常处理、输出表格、结论、风险和后续行动。",
    "1. 不得编造缺失数据。",
    "2. 结论必须逐条引用指标证据。"
  ].join("\n");
  const setup = createPromptEnhancerHarness(detailed, completedCandidate("不应运行"));
  await enhanceChatInput(setup.view);
  assert.equal(setup.harnessRequests.length, 0);
  assert.equal(setup.chatTurns, 0);
  assert.equal(setup.view.inputEl.value, detailed);
}

async function assertSuccessOnlyChangesDraftAndRestoresExactOriginal(): Promise<void> {
  const original = "  帮我写一份周报  \n";
  const enhanced = "请根据本周真实工作记录生成周报，按成果、问题、风险和下周计划组织。";
  const setup = createPromptEnhancerHarness(original, completedCandidate(enhanced));
  const conversationBefore = structuredClone(setup.conversation);

  await enhanceChatInput(setup.view);

  assert.equal(setup.harnessRequests.length, 1);
  assert.equal(setup.harnessRequests[0]?.surface, "editor");
  assert.equal(setup.harnessRequests[0]?.outputContract.kind, "editor-candidate");
  assert.equal(setup.harnessRequests[0]?.permissions.mode, "read-only");
  assert.deepEqual(setup.harnessRequests[0]?.permissions.writableRoots, []);
  assert.equal(setup.view.inputEl.value, enhanced);
  assert.deepEqual(setup.conversation, conversationBefore);
  assert.equal(setup.chatTurns, 0);

  setup.review.restore();
  assert.equal(setup.view.inputEl.value, original);
  assert.deepEqual(setup.conversation, conversationBefore);
}

async function assertFailureAndCancellationKeepDraftUntouched(): Promise<void> {
  for (const result of [
    { runId: "editor-failed", status: "failed", error: "model failed" } as HarnessRunResult,
    { runId: "editor-cancelled", status: "cancelled", error: "已取消" } as HarnessRunResult
  ]) {
    const original = "  帮我整理这个需求  ";
    const setup = createPromptEnhancerHarness(original, result);
    const conversationBefore = structuredClone(setup.conversation);
    await enhanceChatInput(setup.view);
    assert.equal(setup.harnessRequests.length, 1);
    assert.equal(setup.view.inputEl.value, original);
    assert.deepEqual(setup.conversation, conversationBefore);
    assert.equal(setup.chatTurns, 0);
  }
}

async function assertEnhancedDraftSendsExactlyOneChatTurn(): Promise<void> {
  const setup = createPromptEnhancerHarness("帮我写周报", completedCandidate("请根据真实记录写周报。"));
  await enhanceChatInput(setup.view);
  await sendMessage(setup.view);

  assert.equal(setup.harnessRequests.length, 1);
  assert.equal(setup.chatTurns, 1);
  assert.equal(setup.userTurns, 1);
  assert.equal(setup.lastSentText, "请根据真实记录写周报。");
}

function createPromptEnhancerHarness(initialDraft: string, runResult: HarnessRunResult) {
  const harnessRequests: HarnessRunRequest[] = [];
  const review = new FakeReviewElement();
  const inputEl = new FakeTextArea(initialDraft);
  const conversation = {
    revision: 7,
    messages: [{ id: "existing", role: "assistant", text: "existing" }],
    backendBindings: {
      "codex-cli": { leaseId: "lease-existing", leaseTurnCount: 2 }
    }
  };
  const state = {
    chatTurns: 0,
    userTurns: 0,
    lastSentText: ""
  };
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.agentBackend = "codex-cli";
  const view: any = {
    plugin: {
      settings,
      getVaultPath: () => "/vault",
      getNativeExecutionRefContext: () => ({ deviceKey: "test-device", vaultId: "/vault" }),
      ensureHarnessBackendConnected: async () => ({ connected: true, errors: [], models: [{ model: "gpt-test" }] }),
      createCodexRichAgentAdapter: () => new FakeAgentAdapter({ backendId: "codex-cli", responseText: "unused" }),
      runHarnessWithAdapter: async (input: { request: HarnessRunRequest }) => {
        harnessRequests.push(input.request);
        return { ...runResult, runId: input.request.runId };
      },
      settleHarnessRunTerminal: async () => undefined
    },
    inputEl,
    promptEnhanceReviewEl: review,
    editorSummaryRun: null,
    editorActionHarnessRunId: "",
    editorActionActiveTimeoutMs: 0,
    editorActionRun: null,
    editorActionThreadId: "",
    editorActionThreadIds: new Set<string>(),
    editorActionTurnIds: new Set<string>(),
    editorActionCurrentItemIds: new Set<string>(),
    articleUnderstandingPanelState: { status: "idle", usedInLastRun: false },
    selectedServiceTier: "auto",
    running: false,
    activeRunId: "",
    activeRunKind: "",
    activeRunSessionId: "",
    activeTurnId: "",
    editorActionStartBlockReason: () => null,
    setEditorActionStatus: () => undefined,
    withEditorActionTimeout: async <T>(promise: Promise<T>) => await promise,
    prewarmEditorActionThread: () => undefined,
    rejectEditorActionRun: () => undefined,
    effectiveEditorActionModel: (_available: string[], configured: string) => configured,
    takeEditorActionThread: async () => "unused-thread",
    resolveEditorActionRun: () => undefined,
    releaseEditorActionRunLock: () => undefined,
    renderEditorActionStatus: () => undefined,
    activeProviderModels: () => [],
    cancelEditorSummaryRun: () => undefined,
    applyStatus: () => undefined,
    armTurnWatchdog: () => undefined,
    clearTurnWatchdog: () => undefined,
    clearActiveRun() {
      this.activeRunId = "";
      this.activeRunKind = "";
      this.activeRunSessionId = "";
    },
    renderToolbar: () => undefined,
    diagnoseCodexFailure: (error: unknown) => ({ title: "failed", text: String(error) }),
    onInputChanged: () => undefined,
    focusInput: () => undefined,
    ensureSession: () => ({ id: "chat", messages: [] }),
    composerStateForSession: () => ({ viewRunning: false, knowledgeTaskRunning: false, hasDraft: true, hasQueuedItems: false }),
    createQueuedTurnFromComposer: async () => ({
      id: "enhanced-turn",
      sessionId: "chat",
      text: inputEl.value,
      attachments: [],
      createdAt: 1,
      turnOptions: {},
      kind: "chat"
    }),
    startQueuedTurnItemSafely: async (item: { text: string }) => {
      state.chatTurns += 1;
      state.userTurns += 1;
      state.lastSentText = item.text;
      return "running";
    },
    afterTurnSettled: async () => undefined
  };
  return {
    view,
    review,
    conversation,
    harnessRequests,
    get chatTurns() { return state.chatTurns; },
    get userTurns() { return state.userTurns; },
    get lastSentText() { return state.lastSentText; }
  };
}

function completedCandidate(text: string): HarnessRunResult {
  return { runId: "editor-completed", status: "completed", outputText: `<codex-candidate>${text}</codex-candidate>` };
}

class FakeTextArea {
  selectionStart = 0;
  selectionEnd = 0;

  constructor(public value: string) {}

  setSelectionRange(start: number, end: number): void {
    this.selectionStart = start;
    this.selectionEnd = end;
  }
}

class FakeReviewElement {
  private restoreHandler: (() => void) | null = null;
  private readonly classes = new Set<string>();

  empty(): void {
    this.restoreHandler = null;
  }

  addClass(name: string): void {
    this.classes.add(name);
  }

  removeClass(name: string): void {
    this.classes.delete(name);
  }

  createSpan(): FakeReviewElement {
    return new FakeReviewElement();
  }

  createEl(_tag: string, options?: { cls?: string }): FakeReviewElement {
    const element = new FakeReviewElement();
    if (options?.cls === "codex-composer-enhance-restore") {
      Object.defineProperty(element, "onclick", {
        set: (handler: () => void) => { this.restoreHandler = handler; }
      });
    }
    return element;
  }

  set onclick(handler: (() => void) | null) {
    this.restoreHandler = handler;
  }

  restore(): void {
    assert.ok(this.restoreHandler, "restore handler should be rendered after enhancement");
    this.restoreHandler();
  }
}
