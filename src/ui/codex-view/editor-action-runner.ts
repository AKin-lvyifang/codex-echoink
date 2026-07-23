import { Notice } from "obsidian";
import type { AgentEvent } from "../../agent/events";
import { getAgentBackendDefinition } from "../../agent/registry";
import { NativeRunRegistrationError, type AgentBackendKind } from "../../agent/types";
import { createHarnessAgentAdapter } from "../../harness/agents/adapter-factory";
import { harnessBackendDisplayName, harnessEditorActionBackend, harnessEditorActionModel, harnessEditorActionTaskModel } from "../../harness/agents/backend-runtime-profile";
import type { AgentAdapter } from "../../harness/agents/adapter";
import type { HarnessEvent } from "../../harness/contracts/event";
import type {
  LocalRunCommitResult,
  NativeDisposition,
  NativeExecutionRecord,
  NativeExecutionRef,
  NativeRunOutcome
} from "../../harness/contracts/native-execution";
import type { HarnessRunResult, HarnessWorkflow } from "../../harness/contracts/run";
import { buildActiveEchoInkResourceCatalog, codexResourceOverridesFromEchoInkResources, prepareAgentResources, resourceSelectionFromPreparedResources } from "../../resources/registry";
import { newId, resolveEditorActionModeConfig } from "../../settings/settings";
import type { CodexForObsidianSettings } from "../../settings/settings";
import { buildEditorActionPrompt, buildEditorActionReviewPrompt, resolveEditorActionStyle } from "../../editor-actions/prompt";
import { buildEditorActionTurnOptions } from "../../editor-actions/turn-options";
import { buildArticleUnderstandingPrompt, makeArticleUnderstandingCacheEntry, resolveArticleUnderstandingCache, upsertArticleUnderstandingCache, type EditorActionSummarySource } from "../../editor-actions/summary-cache";
import type { ArticleUnderstandingEntry, EditorActionQualityMode, EditorActionRequest } from "../../editor-actions/types";
import { cleanEditorActionOutput, validateEditorActionCandidateText } from "../../editor-actions/output";
import type { ArticleUnderstandingPanelState } from "./header";
import { agentEventToEditorStatus } from "./agent-event-renderer";
import type {
  CodexViewEditorActionContext,
  CodexViewLifecycleSnapshot
} from "./runner-context";

export async function sendEditorActionRequest(view: CodexViewEditorActionContext, request: EditorActionRequest): Promise<string> {
  const viewLifecycle = captureEditorActionViewLifecycle(view);
  const blockReason = view.editorActionStartBlockReason();
  if (blockReason) throw new Error(blockReason);
  const harnessRunId = newId("editor-action-harness");
  view.editorActionHarnessRunId = harnessRunId;
  const timeoutMs = editorActionTimeoutForMode(view.plugin.settings.editorActions.timeoutMs, request.qualityMode);
  const requestStartedAt = Date.now();
  try {
    setArticleUnderstandingPanelState(view, {
      status: request.qualityMode === "fast" ? "idle" : "missing",
      source: request.source,
      mode: request.qualityMode,
      modeLabel: request.modeConfig.label,
      model: request.modeConfig.model,
      usedInLastRun: false
    });
    view.setEditorActionStatus({ status: "connecting", actionLabel: request.action.label, qualityMode: request.qualityMode, modeLabel: request.modeConfig.label, filePath: request.source.filePath, model: request.modeConfig.model, startedAt: requestStartedAt });
    const backend = resolveEditorActionBackend(view);
    const status = await awaitEditorActionViewLifecycle(
      view,
      viewLifecycle,
      connectEditorActionBackend(view, backend, timeoutMs, "写作操作连接超时")
    );
    view.applyStatus();

    const availableModels = editorActionAvailableModels(status);
    const model = editorActionModelForBackend(view, backend, availableModels, request.modeConfig.model);
    const understanding = await ensureArticleUnderstanding(
      view,
      request,
      availableModels,
      model,
      timeoutMs,
      false,
      viewLifecycle
    );
    const snapshot = understanding
      ? {
        ...request.snapshot,
        articleUnderstanding: understanding.understanding,
        articleUnderstandingState: view.articleUnderstandingPanelState.status === "reused" ? "reusable" as const : "fresh" as const
      }
      : request.snapshot;
    const contextChars = request.snapshot.beforeContext.length + request.snapshot.afterContext.length;
    const debugMessage = `${request.modeConfig.label} · 模型 ${model} · 上下文 ${contextChars} 字 · 超时 ${Math.round(timeoutMs / 1000)}s`;
    let result = await runEditorActionPromptTurn(view, {
      prompt: buildEditorActionPrompt({ action: request.action, style: request.style, snapshot, qualityMode: request.qualityMode, modeLabel: request.modeConfig.label }),
      actionLabel: request.action.label,
      qualityMode: request.qualityMode,
      modeLabel: request.modeConfig.label,
      model,
      phase: "generating",
      workflow: editorWorkflowForAction(request.action.id),
      statusMessage: debugMessage,
      timeoutMs,
      startedAt: requestStartedAt
    }, viewLifecycle);
    if (request.qualityMode === "strict") {
      const candidateText = cleanEditorActionOutput(result);
      const candidateValidation = validateEditorActionCandidateText(candidateText);
      if (!candidateValidation.ok) throw new Error(candidateValidation.reason);
      result = await runEditorActionPromptTurn(view, {
        prompt: buildEditorActionReviewPrompt({ action: request.action, style: request.style, snapshot, qualityMode: request.qualityMode, modeLabel: request.modeConfig.label, candidateText }),
        actionLabel: request.action.label,
        qualityMode: request.qualityMode,
        modeLabel: request.modeConfig.label,
        model,
        phase: "reviewing",
        workflow: editorWorkflowForAction(request.action.id),
        statusMessage: `${request.modeConfig.label}审校中`,
        timeoutMs: Math.max(45000, Math.min(timeoutMs, 90000)),
        startedAt: requestStartedAt
      }, viewLifecycle);
    }
    return result;
  } catch (error) {
    if (isEditorActionViewLifecycleCurrent(view, viewLifecycle)) {
      const diagnostic = resolveEditorActionDiagnostic(view, error);
      view.running = false;
      view.activeTurnId = "";
      view.editorActionActiveTimeoutMs = 0;
      view.clearTurnWatchdog();
      view.clearActiveRun();
      view.editorActionCurrentItemIds.clear();
      view.applyStatus();
      setArticleUnderstandingPanelState(view, { ...view.articleUnderstandingPanelState, status: "failed", error: diagnostic.text });
    }
    throw error;
  } finally {
    if (view.editorActionHarnessRunId === harnessRunId) view.editorActionHarnessRunId = "";
  }
}

export async function ensureArticleUnderstanding(
  view: CodexViewEditorActionContext,
  request: EditorActionRequest,
  availableModels: string[],
  model: string,
  timeoutMs: number,
  forceRefresh = false,
  viewLifecycle = captureEditorActionViewLifecycle(view)
): Promise<ArticleUnderstandingEntry | null> {
  assertEditorActionViewLifecycleCurrent(view, viewLifecycle);
  if (request.qualityMode === "fast") {
    setArticleUnderstandingPanelState(view, {
      status: "idle",
      source: request.source,
      mode: request.qualityMode,
      modeLabel: request.modeConfig.label,
      model,
      entry: null,
      usedInLastRun: false
    });
    return null;
  }
  const settings = view.plugin.settings.editorActions;
  const cached = forceRefresh ? { state: "stale" as const, entry: null } : resolveArticleUnderstandingCache(settings.articleUnderstandingCache, request.source, request.qualityMode, model);
  if (!forceRefresh && cached.entry && (cached.state === "fresh" || cached.state === "reusable")) {
    setArticleUnderstandingPanelState(view, {
      status: cached.state === "fresh" ? "fresh" : "reused",
      source: request.source,
      mode: request.qualityMode,
      modeLabel: request.modeConfig.label,
      model,
      entry: cached.entry,
      usedInLastRun: true
    });
    return cached.entry;
  }

  setArticleUnderstandingPanelState(view, {
    status: "running",
    source: request.source,
    mode: request.qualityMode,
    modeLabel: request.modeConfig.label,
    model,
    entry: null,
    usedInLastRun: false
  });
  const understandingRaw = await runEditorActionPromptTurn(view, {
    prompt: buildArticleUnderstandingPrompt(request.source),
    actionLabel: "理解文章",
    qualityMode: request.qualityMode,
    modeLabel: request.modeConfig.label,
    model,
    phase: "understanding",
    statusMessage: `${request.modeConfig.label} · 正在理解文章`,
    timeoutMs: Math.max(45000, Math.min(timeoutMs, 90000)),
    startedAt: Date.now()
  }, viewLifecycle);
  assertEditorActionViewLifecycleCurrent(view, viewLifecycle);
  const understanding = cleanEditorActionOutput(understandingRaw);
  if (!understanding.trim()) throw new Error("文章理解为空");
  const entry = makeArticleUnderstandingCacheEntry(request.source, understanding, request.qualityMode, model);
  settings.articleUnderstandingCache = upsertArticleUnderstandingCache(settings.articleUnderstandingCache, entry);
  await awaitEditorActionViewLifecycle(
    view,
    viewLifecycle,
    view.plugin.saveSettings()
  );
  setArticleUnderstandingPanelState(view, {
    status: "fresh",
    source: request.source,
    mode: request.qualityMode,
    modeLabel: request.modeConfig.label,
    model,
    entry,
    usedInLastRun: true
  });
  return entry;
}

export async function runEditorActionPromptTurn(view: CodexViewEditorActionContext, input: {
  prompt: string;
  actionLabel: string;
  qualityMode: EditorActionQualityMode;
  modeLabel: string;
  model: string;
  phase: "understanding" | "generating" | "reviewing";
  workflow?: HarnessWorkflow;
  statusMessage: string;
  timeoutMs: number;
  startedAt: number;
}, viewLifecycle = captureEditorActionViewLifecycle(view)): Promise<string> {
  assertEditorActionViewLifecycleCurrent(view, viewLifecycle);
  const backend = resolveEditorActionBackend(view);
  const runId = newId(`editor-${input.phase}-run`);
  view.editorActionCurrentItemIds.clear();
  const catalog = await awaitEditorActionViewLifecycle(
    view,
    viewLifecycle,
    runtimeEchoInkResourceCatalog(view.plugin)
  );
  const resources = prepareAgentResources(catalog, {
    scope: "editor-actions",
    backendCapabilities: getAgentBackendDefinition(backend).capabilities,
    enabledByScope: view.plugin.settings.resources.enabledByScope,
    mcpConnections: view.plugin.settings.resources.mcpConnections
  });
  const turnOptions = buildEditorActionTurnOptions({
    model: input.model,
    serviceTier: "fast",
    timeoutMs: input.timeoutMs,
    workspaceResources: codexResourceOverridesFromEchoInkResources(catalog, "editor-actions", view.plugin.settings.resources.enabledByScope)
  });
  const prompt = appendPreparedResourcesToPrompt(input.prompt, resources);
  const adapterSettings = editorActionAdapterSettings(view.plugin.settings, backend, input.model);
  const workflow = input.workflow ?? "editor.rewrite";
  const sessionId = `editor-action:${runId}`;
  let adapter: AgentAdapter | null = null;
  const nativeLifecycle = new EditorNativeLifecycle({
    view,
    runId,
    sessionId,
    workflow,
    backend,
    adapter: () => adapter
  });
  let runOutcome: NativeRunOutcome = "failed";
  let localCommit = editorLocalCommitResult(false, "Run Ledger terminal 未提交");
  let terminalCommitAttempted = false;
  try {
    assertEditorActionViewLifecycleCurrent(view, viewLifecycle);
    view.activeRunId = runId;
    view.activeRunSessionId = "";
    view.activeRunKind = "editor";
    view.running = true;
    view.setEditorActionStatus({ status: "generating", actionLabel: input.actionLabel, qualityMode: input.qualityMode, modeLabel: input.modeLabel, phase: input.phase, model: input.model, message: input.statusMessage, startedAt: input.startedAt });
    view.applyStatus();
    adapter = (view.createEditorActionHarnessAdapter ?? createHarnessAgentAdapter)({
      backendId: backend,
      settings: adapterSettings,
      vaultPath: view.plugin.getVaultPath(),
      nativeRefContext: view.plugin.getNativeExecutionRefContext(backend),
      createCodexRichAdapter: (options) => view.plugin.createCodexRichAgentAdapter(options),
      codexRich: {
        turnOptions,
        getNativeThreadId: () => undefined,
        setNativeThreadId: (threadId) => {
          if (!isEditorActionRunViewCurrent(view, viewLifecycle, runId)) return;
          view.editorActionThreadId = threadId;
        },
        buildInput: () => [{ type: "text", text: prompt, text_elements: [] }],
        startThread: async () => {
          const threadId = await view.takeEditorActionThread(turnOptions);
          await nativeLifecycle.registerId(threadId, true);
          return { threadId, title: "EchoInk Editor Action" };
        },
        onTurnStarted: ({ threadId, turnId }) => {
          if (!isEditorActionRunViewCurrent(view, viewLifecycle, runId)) return;
          view.editorActionThreadId = threadId;
          view.activeTurnId = turnId;
        },
        nativeRefContext: view.plugin.getNativeExecutionRefContext(backend)
      },
      task: {
        resources,
        toolBridge: null,
        timeoutMs: input.timeoutMs,
        tools: { read: true, write: false, edit: false, bash: false },
        model: harnessEditorActionTaskModel(adapterSettings, backend, input.model),
        abortSignal: viewLifecycle.signal,
        requireNativeRegistrationBeforePrompt: true,
        onRunId: async (nativeId, native) =>
          await nativeLifecycle.registerRuntime(nativeId, native)
      }
    });
    const harnessResult = await view.plugin.runHarnessWithAdapter({
      adapter,
      terminalAuthority: "surface",
      request: {
        runId,
        sessionId,
        surface: "editor",
        workflow,
        backendId: backend,
        workspace: {
          vaultPath: view.plugin.getVaultPath(),
          cwd: view.plugin.getVaultPath()
        },
        input: {
          text: prompt,
          attachments: []
        },
        permissions: {
          mode: "read-only",
          writableRoots: [],
          requireApproval: true
        },
        resourceSelection: resourceSelectionFromPreparedResources(resources, backend),
        memoryPolicy: {
          enabled: false,
          maxItems: 0
        },
        outputContract: {
          kind: "editor-candidate"
        }
      },
      sink: (event) => {
        if (!isEditorActionViewLifecycleCurrent(view, viewLifecycle)) return;
        const agentEvent = harnessEventToAgentEvent(event, backend);
        if (!agentEvent) return;
        view.setEditorActionStatus(agentEventToEditorStatus({
          event: agentEvent,
          actionLabel: input.actionLabel,
          qualityMode: input.qualityMode,
          modeLabel: input.modeLabel,
          phase: input.phase,
          model: input.model,
          startedAt: input.startedAt
        }));
        view.applyStatus();
      }
    });
    assertEditorActionViewLifecycleCurrent(view, viewLifecycle);
    await nativeLifecycle.registerFallback(harnessResult.nativeExecution);
    assertEditorActionViewLifecycleCurrent(view, viewLifecycle);
    const turnResult = await resolveEditorActionResult(adapter, runId, harnessResult, input.timeoutMs);
    assertEditorActionViewLifecycleCurrent(view, viewLifecycle);
    await nativeLifecycle.registerFallback(turnResult.nativeExecution);
    assertEditorActionViewLifecycleCurrent(view, viewLifecycle);
    const cleaned = cleanEditorActionOutput(turnResult.text);
    const validation = validateEditorActionCandidateText(cleaned);
    if (!validation.ok) throw new Error(validation.reason);
    assertEditorActionViewLifecycleCurrent(view, viewLifecycle);
    runOutcome = "success";
    terminalCommitAttempted = true;
    try {
      await commitEditorRunTerminal(view, {
        runId,
        status: "completed",
        backendId: backend,
        text: cleaned
      });
      localCommit = editorLocalCommitResult(true);
    } catch (terminalError) {
      localCommit = editorLocalCommitResult(false, errorMessage(terminalError));
      throw terminalError;
    }
    assertEditorActionViewLifecycleCurrent(view, viewLifecycle);
    view.setEditorActionStatus({ status: "awaiting-confirm", actionLabel: input.actionLabel, qualityMode: input.qualityMode, modeLabel: input.modeLabel, model: input.model, message: "候选已生成，等待确认", startedAt: input.startedAt });
    return cleaned;
  } catch (error) {
    const runError = error instanceof Error ? error : new Error(String(error));
    if (!terminalCommitAttempted) {
      const cancelled = isEditorActionCancellation(runError);
      runOutcome = cancelled ? "cancelled" : "failed";
      terminalCommitAttempted = true;
      try {
        await commitEditorRunTerminal(view, {
          runId,
          status: cancelled ? "cancelled" : "failed",
          backendId: backend,
          error: runError.message
        });
        localCommit = editorLocalCommitResult(true);
      } catch (terminalError) {
        localCommit = editorLocalCommitResult(false, errorMessage(terminalError));
      }
    }
    throw runError;
  } finally {
    await adapter?.dispose().catch(() => undefined);
    await nativeLifecycle.settleAndCleanup(runOutcome, localCommit);
    if (isEditorActionRunViewCurrent(view, viewLifecycle, runId)) {
      view.running = false;
      view.activeTurnId = "";
      view.editorActionThreadId = "";
      view.editorActionActiveTimeoutMs = 0;
      view.clearTurnWatchdog();
      view.clearActiveRun();
      view.releaseEditorActionRunLock(runId);
      view.applyStatus();
    }
  }
}

async function commitEditorRunTerminal(
  view: CodexViewEditorActionContext,
  input: {
    runId: string;
    status: "completed" | "failed" | "cancelled";
    backendId: AgentBackendKind;
    text?: string;
    error?: string;
  }
): Promise<void> {
  const receipt = await view.plugin.settleHarnessRunTerminal(input);
  if (!receipt) {
    throw new Error(
      `Editor Run Ledger terminal receipt missing for ${input.runId}`
    );
  }
  const expectedType = `run.${input.status}`;
  const payloadMatches = input.status === "completed"
    ? receipt.text === input.text
    : receipt.error === input.error;
  if (
    receipt.runId !== input.runId
    || receipt.type !== expectedType
    || receipt.backendId !== input.backendId
    || !payloadMatches
  ) {
    throw new Error(
      `Editor Run Ledger terminal receipt mismatch: expected ${expectedType} for ${input.runId}`
    );
  }
}

function isEditorActionCancellation(error: Error): boolean {
  return (error as Error & { code?: string }).code === "EDITOR_ACTION_VIEW_CLOSED"
    || /已中断|已取消|cancelled|canceled/i.test(error.message);
}

function captureEditorActionViewLifecycle(
  view: CodexViewEditorActionContext
): CodexViewLifecycleSnapshot {
  const lifecycle = view.captureViewLifecycle();
  assertEditorActionViewLifecycleCurrent(view, lifecycle);
  return lifecycle;
}

function isEditorActionViewLifecycleCurrent(
  view: CodexViewEditorActionContext,
  lifecycle: CodexViewLifecycleSnapshot
): boolean {
  if (lifecycle.signal.aborted) return false;
  const current = view.captureViewLifecycle();
  return current.generation === lifecycle.generation
    && current.signal === lifecycle.signal
    && !current.signal.aborted;
}

function isEditorActionRunViewCurrent(
  view: CodexViewEditorActionContext,
  lifecycle: CodexViewLifecycleSnapshot,
  runId: string
): boolean {
  return isEditorActionViewLifecycleCurrent(view, lifecycle)
    && view.activeRunId === runId;
}

function assertEditorActionViewLifecycleCurrent(
  view: CodexViewEditorActionContext,
  lifecycle: CodexViewLifecycleSnapshot
): void {
  if (isEditorActionViewLifecycleCurrent(view, lifecycle)) return;
  throw editorActionViewClosedError();
}

async function awaitEditorActionViewLifecycle<T>(
  view: CodexViewEditorActionContext,
  lifecycle: CodexViewLifecycleSnapshot,
  promise: Promise<T>
): Promise<T> {
  assertEditorActionViewLifecycleCurrent(view, lifecycle);
  let removeAbortListener: () => void = () => undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    const onAbort = () => reject(editorActionViewClosedError());
    lifecycle.signal.addEventListener("abort", onAbort, { once: true });
    removeAbortListener = () => lifecycle.signal.removeEventListener("abort", onAbort);
    if (lifecycle.signal.aborted) onAbort();
  });
  try {
    const result = await Promise.race([promise, aborted]);
    assertEditorActionViewLifecycleCurrent(view, lifecycle);
    return result;
  } finally {
    removeAbortListener();
  }
}

function editorActionViewClosedError(): Error {
  return Object.assign(
    new Error("EchoInk 侧栏已关闭，Editor 操作已取消。"),
    { code: "EDITOR_ACTION_VIEW_CLOSED" }
  );
}

function appendPreparedResourcesToPrompt(prompt: string, resources: ReturnType<typeof prepareAgentResources>): string {
  return [
    resources.promptPrefix,
    resources.warnings.length ? `资源提示：\n${resources.warnings.map((item) => `- ${item}`).join("\n")}` : "",
    prompt
  ].filter(Boolean).join("\n\n");
}

async function runtimeEchoInkResourceCatalog(plugin: CodexViewEditorActionContext["plugin"]) {
  return typeof plugin.buildRuntimeEchoInkResourceCatalog === "function"
    ? await plugin.buildRuntimeEchoInkResourceCatalog()
    : buildActiveEchoInkResourceCatalog({ settings: plugin.settings.resources });
}

async function resolveEditorActionResult(
  adapter: AgentAdapter,
  runId: string,
  result: HarnessRunResult,
  timeoutMs: number
): Promise<{ text: string; nativeExecution?: NativeExecutionRef }> {
  if (result.status === "completed") {
    return {
      text: result.outputText ?? "",
      ...(result.nativeExecution ? { nativeExecution: result.nativeExecution } : {})
    };
  }
  if (result.status === "running") {
    if (typeof adapter.awaitResult !== "function") throw new Error("当前 Agent 不支持异步结果收口");
    const awaited = await withTimeout(adapter.awaitResult(runId), timeoutMs, "写作操作超时，请重试");
    if (awaited.status === "completed") {
      return {
        text: awaited.outputText ?? "",
        ...(awaited.nativeExecution ? { nativeExecution: awaited.nativeExecution } : {})
      };
    }
    throw new Error(awaited.error || (awaited.status === "cancelled" ? "写作操作已中断" : "Agent 写作任务未完成"));
  }
  throw new Error(result.error || "Agent 写作任务未完成");
}

interface EditorNativeLifecycleOptions {
  view: CodexViewEditorActionContext;
  runId: string;
  sessionId: string;
  workflow: HarnessWorkflow;
  backend: AgentBackendKind;
  adapter(): AgentAdapter | null;
}

interface EditorNativeLifecycleEntry {
  recordId: string;
  native: NativeExecutionRef;
  registration: Promise<void>;
  cleanupRegistrationFailureLocally: boolean;
  bestEffortAttempted: boolean;
}

export class EditorNativeLifecycle {
  private readonly entries = new Map<string, EditorNativeLifecycleEntry>();
  private nextRecordOrdinal = 0;

  constructor(private readonly options: EditorNativeLifecycleOptions) {}

  async registerId(
    nativeId: string,
    cleanupRegistrationFailureLocally: boolean
  ): Promise<void> {
    const id = nativeId.trim();
    if (!id) return;
    await this.registerRef(editorNativeExecutionRef(
      this.options.view,
      this.options.backend,
      id
    ), cleanupRegistrationFailureLocally);
  }

  async registerFallback(native: NativeExecutionRef | undefined): Promise<void> {
    if (!native?.id.trim()) return;
    await this.registerRef(native, false);
  }

  async registerRuntime(
    nativeId: string,
    native: NativeExecutionRef
  ): Promise<void> {
    const id = nativeId.trim();
    if (
      !id
      || native.id.trim() !== id
      || native.backendId !== this.options.backend
    ) {
      throw new NativeRunRegistrationError(
        "Editor Native execution registration received an inconsistent runtime descriptor"
      );
    }
    await this.registerRef(native, false);
  }

  async settleAndCleanup(runOutcome: NativeRunOutcome, localCommit: LocalRunCommitResult): Promise<void> {
    for (const entry of this.entries.values()) {
      const registered = await entry.registration.then(
        () => true,
        () => false
      );
      if (!registered) continue;
      let settled: NativeExecutionRecord | null;
      try {
        settled = await this.options.view.plugin.settleNativeExecution({
          recordId: entry.recordId,
          runOutcome,
          localCommit
        });
      } catch (error) {
        console.error("Editor Native lifecycle settlement failed", error);
        continue;
      }
      if (settled?.localCommit !== "committed" || settled.cleanup !== "pending") continue;
      try {
        await this.options.view.cleanupNativeExecutionRecord(entry.recordId);
      } catch (error) {
        console.error("Editor Native exact cleanup failed", error);
      }
    }
  }

  private async registerRef(
    native: NativeExecutionRef,
    cleanupRegistrationFailureLocally: boolean
  ): Promise<void> {
    const key = nativeExecutionKey(native);
    const existing = this.entries.get(key);
    if (existing) return await existing.registration;

    const entry = {} as EditorNativeLifecycleEntry;
    entry.recordId = `editor-native:${this.options.runId}:${this.options.backend}:${++this.nextRecordOrdinal}`;
    entry.native = native;
    entry.cleanupRegistrationFailureLocally = cleanupRegistrationFailureLocally;
    entry.bestEffortAttempted = false;
    entry.registration = this.persist(entry);
    this.entries.set(key, entry);
    await entry.registration;
  }

  private async persist(entry: EditorNativeLifecycleEntry): Promise<void> {
    try {
      await this.options.view.plugin.recordNativeExecution(editorNativeExecutionRecord(
        entry.recordId,
        this.options,
        entry.native
      ));
    } catch (error) {
      if (entry.cleanupRegistrationFailureLocally) {
        await this.bestEffortCleanup(entry);
      }
      throw new NativeRunRegistrationError(
        `Native execution 登记失败：${errorMessage(error)}`,
        error
      );
    }
  }

  private async bestEffortCleanup(entry: EditorNativeLifecycleEntry): Promise<void> {
    if (entry.bestEffortAttempted) return;
    entry.bestEffortAttempted = true;
    const adapter = this.options.adapter();
    if (!adapter) return;
    const requested = bestEffortDisposition(adapter);
    try {
      if (requested && adapter.disposeNativeExecution) {
        await adapter.disposeNativeExecution({
          ref: entry.native,
          requested,
          reason: "manual"
        });
        return;
      }
      await adapter.cancel(this.options.runId);
    } catch {
      // Registration failure is authoritative; cleanup is intentionally one-shot.
    }
  }
}

function editorNativeExecutionRecord(
  recordId: string,
  options: EditorNativeLifecycleOptions,
  native: NativeExecutionRef
): NativeExecutionRecord {
  const now = Date.now();
  return {
    id: recordId,
    runId: options.runId,
    sessionId: options.sessionId,
    surface: "editor",
    workflow: options.workflow,
    native,
    policy: {
      historyAuthority: "echoink",
      mode: "ephemeral-run",
      preferredDisposition: ["delete", "archive", "process-exit", "retain"],
      retainWhenLocalCommitFails: true,
      cleanupRequiredForTaskSuccess: false
    },
    localCommit: "pending",
    cleanup: "not-needed",
    attempts: 0,
    nextAttemptAt: 0,
    lastError: "",
    createdAt: now,
    settledAt: 0,
    committedAt: 0,
    disposedAt: 0
  };
}

function editorNativeExecutionRef(
  view: CodexViewEditorActionContext,
  backend: AgentBackendKind,
  nativeId: string
): NativeExecutionRef {
  return {
    backendId: backend,
    id: nativeId,
    kind: backend === "codex-cli" ? "thread" : backend === "opencode" ? "session" : "run",
    persistence: backend === "hermes" ? "unknown" : "provider-persistent",
    ...view.plugin.getNativeExecutionRefContext(backend),
    createdAt: Date.now()
  };
}

function nativeExecutionKey(native: NativeExecutionRef): string {
  return `${native.backendId}\u0000${native.kind}\u0000${native.id}`;
}

function bestEffortDisposition(adapter: AgentAdapter): NativeDisposition | null {
  const dispositions = adapter.manifest.nativeExecution?.dispositions;
  if (dispositions?.delete) return "delete";
  if (dispositions?.archive) return "archive";
  if (dispositions?.processExit) return "process-exit";
  return null;
}

function editorLocalCommitResult(committed: boolean, error = ""): LocalRunCommitResult {
  return {
    committed,
    conversationCommitted: committed,
    runLedgerCommitted: committed,
    artifactsCommitted: committed,
    historyIndexCommitted: committed,
    ...(error ? { error } : {})
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const timer = globalThis.setTimeout(() => reject(new Error(message)), Math.max(1000, timeoutMs));
    promise.then(
      (value) => {
        globalThis.clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        globalThis.clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function harnessEventToAgentEvent(event: HarnessEvent, backend: AgentBackendKind): AgentEvent | null {
  const base = {
    backend,
    createdAt: event.createdAt,
    runId: event.runId,
    title: event.title,
    text: event.text,
    status: event.status,
    toolName: event.toolName,
    resourceId: event.resourceId,
    data: event.data,
    error: event.error
  };
  switch (event.type) {
    case "agent.connecting": return { ...base, type: "connecting" };
    case "agent.connected": return { ...base, type: "connected" };
    case "run.started": return { ...base, type: "run_started" };
    case "agent.message.delta": return { ...base, type: "message_delta" };
    case "agent.message.completed": return { ...base, type: "message_completed" };
    case "agent.reasoning.started":
    case "agent.reasoning.summary.delta":
    case "agent.thinking.delta": return { ...base, type: "thinking_delta" };
    case "agent.reasoning.summary.completed":
    case "agent.thinking.completed": return { ...base, type: "thinking_completed" };
    case "adapter.fallback.started": return { ...base, type: "fallback_started" };
    case "agent.plan.updated": return { ...base, type: "plan_updated" };
    case "tool.requested":
    case "tool.started": return { ...base, type: "tool_call_requested" };
    case "tool.approval.requested": return { ...base, type: "permission_requested" };
    case "tool.completed": return { ...base, type: "tool_call_completed" };
    case "tool.failed": return { ...base, type: "tool_call_failed" };
    case "usage.updated": return { ...base, type: "usage" };
    case "run.completed": return { ...base, type: "completed" };
    case "run.failed": return { ...base, type: "failed" };
    case "run.cancelled": return { ...base, type: "cancelled" };
    default: return null;
  }
}

export function setArticleUnderstandingPanelState(view: CodexViewEditorActionContext, state: ArticleUnderstandingPanelState): void {
  view.articleUnderstandingPanelState = state;
  view.renderEditorActionStatus();
}

export async function refreshArticleUnderstandingPanelSourceState(view: CodexViewEditorActionContext): Promise<void> {
  const settings = view.plugin.settings.editorActions;
  const source = await currentArticleUnderstandingSource(view);
  if (!source) {
    setArticleUnderstandingPanelState(view, { status: "idle", usedInLastRun: false });
    return;
  }
  const mode = settings.qualityMode;
  const modeConfig = resolveEditorActionModeConfig(settings, mode);
  const backend = resolveEditorActionBackend(view);
  const model = editorActionModelForBackend(view, backend, view.activeProviderModels(), modeConfig.model);
  const cached = resolveArticleUnderstandingCache(settings.articleUnderstandingCache, source, mode, model);
  const status = mode === "fast"
    ? "idle"
    : cached.state === "fresh"
      ? "fresh"
      : cached.state === "reusable"
        ? "reused"
        : cached.state === "stale"
          ? "stale"
          : "missing";
  setArticleUnderstandingPanelState(view, {
    status,
    source,
    mode,
    modeLabel: modeConfig.label,
    model,
    entry: cached.entry,
    usedInLastRun: false
  });
}

export async function refreshArticleUnderstandingFromPanel(view: CodexViewEditorActionContext): Promise<void> {
  const viewLifecycle = view.captureViewLifecycle();
  if (!isEditorActionViewLifecycleCurrent(view, viewLifecycle)) return;
  let source: EditorActionSummarySource | null;
  try {
    source = await awaitEditorActionViewLifecycle(
      view,
      viewLifecycle,
      currentArticleUnderstandingSource(view)
    );
  } catch (error) {
    if (!isEditorActionViewLifecycleCurrent(view, viewLifecycle)) return;
    throw error;
  }
  if (!source) {
    new Notice("当前没有可理解的笔记");
    return;
  }
  const settings = view.plugin.settings.editorActions;
  const mode = settings.qualityMode === "fast" ? "quality" : settings.qualityMode;
  const modeConfig = resolveEditorActionModeConfig(settings, mode);
  const backend = resolveEditorActionBackend(view);
  let status: Awaited<ReturnType<typeof connectEditorActionBackend>>;
  try {
    status = await awaitEditorActionViewLifecycle(
      view,
      viewLifecycle,
      connectEditorActionBackend(view, backend, settings.timeoutMs, "连接 Agent 超时")
    );
  } catch (error) {
    if (!isEditorActionViewLifecycleCurrent(view, viewLifecycle)) return;
    throw error;
  }
  const availableModels = editorActionAvailableModels(status);
  const model = editorActionModelForBackend(view, backend, availableModels, modeConfig.model);
  const request: EditorActionRequest = {
    id: newId("article-understanding-refresh"),
    action: settings.actions[0],
    style: settings.styles[0],
    source,
    snapshot: {
      filePath: source.filePath,
      fileName: source.fileName,
      fromOffset: 0,
      toOffset: 0,
      from: { line: 0, ch: 0 },
      to: { line: 0, ch: 0 },
      selectedText: "",
      beforeContext: source.text,
      afterContext: ""
    },
    qualityMode: mode,
    modeConfig,
    prompt: "",
    createdAt: Date.now()
  };
  try {
    await ensureArticleUnderstanding(
      view,
      request,
      availableModels,
      model,
      editorActionTimeoutForMode(settings.timeoutMs, mode),
      true,
      viewLifecycle
    );
  } catch (error) {
    if (!isEditorActionViewLifecycleCurrent(view, viewLifecycle)) return;
    const diagnostic = resolveEditorActionDiagnostic(view, error);
    setArticleUnderstandingPanelState(view, {
      status: "failed",
      source,
      mode,
      modeLabel: modeConfig.label,
      model,
      error: diagnostic.text,
      usedInLastRun: false
    });
    new Notice(`文章理解失败：${diagnostic.title}`);
  }
}

export async function currentArticleUnderstandingSource(view: CodexViewEditorActionContext) {
  const active = view.app.workspace.getActiveViewOfType((await import("obsidian")).MarkdownView);
  if (!active?.file) return null;
  const text = active.editor.getValue();
  if (!text.trim()) return null;
  const stat = active.file.stat;
  return {
    filePath: active.file.path,
    fileName: active.file.basename,
    text,
    mtime: stat.mtime,
    size: stat.size
  };
}

function editorActionTimeoutForMode(baseTimeoutMs: number, mode: EditorActionQualityMode): number {
  if (mode === "strict") return Math.max(baseTimeoutMs, 120000);
  if (mode === "quality") return Math.max(baseTimeoutMs, 90000);
  return baseTimeoutMs;
}

function resolveEditorActionBackend(view: CodexViewEditorActionContext): AgentBackendKind {
  return harnessEditorActionBackend(view.plugin.settings);
}

function editorWorkflowForAction(actionId: string): HarnessWorkflow {
  if (actionId === "expand") return "editor.expand";
  if (actionId === "continue") return "editor.continue";
  if (actionId === "translate") return "editor.translate";
  return "editor.rewrite";
}

function editorActionModelForBackend(view: CodexViewEditorActionContext, backend: AgentBackendKind, availableModels: string[], configuredModel: string): string {
  const preferredModel = harnessEditorActionModel(view.plugin.settings, backend, configuredModel);
  return backend === "codex-cli"
    ? view.effectiveEditorActionModel(availableModels, preferredModel)
    : preferredModel;
}

function editorActionAdapterSettings(settings: CodexForObsidianSettings, backend: AgentBackendKind, resolvedModel: string): CodexForObsidianSettings {
  if (backend === "codex-cli") return settings;
  const cloned = JSON.parse(JSON.stringify(settings)) as CodexForObsidianSettings;
  if (backend === "hermes" && !resolvedModel) {
    cloned.agents.hermes.providerId = "";
    cloned.agents.hermes.modelId = "";
  }
  return cloned;
}

function resolveEditorActionDiagnostic(view: CodexViewEditorActionContext, error: unknown): { title: string; text: string } {
  const backend = resolveEditorActionBackend(view);
  const message = error instanceof Error ? error.message : String(error);
  return {
    title: `${harnessBackendDisplayName(backend)} 写作失败`,
    text: message
  };
}

async function connectEditorActionBackend(
  view: CodexViewEditorActionContext,
  backend: AgentBackendKind,
  timeoutMs: number,
  message: string
) {
  const status = await view.withEditorActionTimeout(
    view.plugin.ensureHarnessBackendConnected(backend, { silent: true }),
    timeoutMs,
    message
  );
  if (status && !status.connected) throw new Error(status.errors[0] || `${harnessBackendDisplayName(backend)} 未连接`);
  return status;
}

function editorActionAvailableModels(status: Awaited<ReturnType<CodexViewEditorActionContext["plugin"]["ensureHarnessBackendConnected"]>>): string[] {
  return status?.models.map((model) => model.model) ?? [];
}
