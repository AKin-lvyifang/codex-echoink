import type CodexForObsidianPlugin from "../main";
import type { AgentTaskRuntime, AgentToolBridgeRuntime, PreparedAgentResources } from "../agent/runtime";
import type { AgentBackendKind, AgentTaskInput } from "../agent/types";
import { diagnoseCodexError } from "../core/codex-diagnostics";
import { swallowError } from "../core/error-handling";
import { ensureOpenCodeModelSupportsFiles } from "../core/opencode-models";
import { providerConnectionLabel, type KnowledgeBaseManagedThreadKind } from "../settings/settings";
import type { CodexNotification, PermissionMode } from "../types/app-server";
import {
  buildCodexKnowledgeInput,
  buildOpenCodeKnowledgeParts,
  formatAgentTaskGuardError,
  formatDurationForError,
  normalizeCodexInactivityTimeoutMs,
  normalizeHermesTaskTimeoutMs,
  normalizeOpenCodeTaskTimeoutMs,
  rejectAfterTimeout,
  requiredModalities,
  runKnowledgeAgentTask,
  selectAgentModel,
  selectOpenCodeModel
} from "./agent-runner";
import { extractKnowledgeBaseNotificationIds, routeKnowledgeBaseCodexNotification } from "./codex-route";
import { formatAgentTaskFailureContext, formatKnowledgeBaseCodexFailureSignal, isKnowledgeBaseCancelError, KNOWLEDGE_BASE_CANCEL_ERROR } from "./failure";
import { KnowledgeBaseManagedThreadStore } from "./managed-threads";
import { buildCodexKnowledgeTurnOptions } from "./turn-options";
import type { KnowledgeBaseSource } from "./types";
import type { KnowledgeBaseTurnOptionOverrides } from "./command-router";

type CodexKbWaiter = {
  threadId: string;
  turnId: string;
  itemIds: Set<string>;
  assistantItems: Map<string, string>;
  assistantItemOrder: string[];
  resolve: (text: string) => void;
  reject: (error: Error) => void;
  model: string;
  startTurnPending: boolean;
  inactivityTimeoutMs: number;
  inactivityTimer: ReturnType<typeof setTimeout> | null;
  pendingTerminal?: { method: "turn/completed" | "error"; params: unknown };
};

type ActiveOpenCodeRun = {
  runtime: AgentTaskRuntime;
  runId: string;
  cancel?: (error: Error) => void;
};

type ActiveHermesRun = {
  runtime: AgentTaskRuntime;
  runId: string;
  abortController: AbortController;
  cancel?: (error: Error) => void;
};

type GuardedAgentBackend = Extract<AgentBackendKind, "opencode" | "hermes">;
type GuardedAgentRun = ActiveOpenCodeRun | ActiveHermesRun;

export interface KnowledgeBaseAgentTaskServiceContext {
  isCancelRequested(): boolean;
  createKnowledgeAgentRuntime(backend: AgentBackendKind): AgentTaskRuntime;
}

export class KnowledgeBaseAgentTaskService {
  private codexWaiterRef: CodexKbWaiter | null = null;
  private activeCodexRunRef: { threadId: string; turnId: string; cancel?: (error: Error) => void } | null = null;
  private activeOpenCodeRef: ActiveOpenCodeRun | null = null;
  private activeHermesRef: ActiveHermesRun | null = null;

  constructor(
    private readonly plugin: CodexForObsidianPlugin,
    private readonly managedThreads: KnowledgeBaseManagedThreadStore,
    private readonly context: KnowledgeBaseAgentTaskServiceContext
  ) {}

  get codexWaiter(): CodexKbWaiter | null {
    return this.codexWaiterRef;
  }

  get activeCodexRun(): { threadId: string; turnId: string; cancel?: (error: Error) => void } | null {
    return this.activeCodexRunRef;
  }

  get activeOpenCode(): ActiveOpenCodeRun | null {
    return this.activeOpenCodeRef;
  }

  get activeHermes(): ActiveHermesRun | null {
    return this.activeHermesRef;
  }

  get hasActiveTask(): boolean {
    return !!(this.codexWaiterRef || this.activeCodexRunRef || this.activeOpenCodeRef || this.activeHermesRef);
  }

  unload(): void {
    if (this.codexWaiterRef) {
      this.codexWaiterRef.reject(new Error(KNOWLEDGE_BASE_CANCEL_ERROR));
      this.codexWaiterRef = null;
    }
    this.clearActiveRuns();
  }

  clearActiveRuns(): void {
    this.activeCodexRunRef = null;
    this.activeOpenCodeRef = null;
    this.activeHermesRef = null;
  }

  async cancelActiveTasks(): Promise<void> {
    const codexRun = this.activeCodexRunRef;
    const openCodeRun = this.activeOpenCodeRef;
    const hermesRun = this.activeHermesRef;
    const waiter = this.codexWaiterRef;
    if (codexRun?.threadId && codexRun.turnId && this.plugin.codex) {
      await this.plugin.codex.interruptTurn(codexRun.threadId, codexRun.turnId).catch(swallowError("cancel knowledge base Codex turn"));
    }
    if (codexRun?.cancel) codexRun.cancel(new Error(KNOWLEDGE_BASE_CANCEL_ERROR));
    if (openCodeRun?.runId) {
      if (openCodeRun.cancel) openCodeRun.cancel(new Error(KNOWLEDGE_BASE_CANCEL_ERROR));
      else void openCodeRun.runtime.abort(openCodeRun.runId).catch(swallowError("cancel knowledge base OpenCode run"));
    }
    if (hermesRun?.runId) {
      hermesRun.abortController.abort();
      if (hermesRun.cancel) hermesRun.cancel(new Error(KNOWLEDGE_BASE_CANCEL_ERROR));
      else void hermesRun.runtime.abort(hermesRun.runId).catch(swallowError("cancel knowledge base Hermes run"));
    }
    if (waiter && this.codexWaiterRef === waiter) {
      waiter.reject(new Error(KNOWLEDGE_BASE_CANCEL_ERROR));
      this.codexWaiterRef = null;
    }
    this.clearActiveRuns();
  }

  handleCodexNotification(notification: CodexNotification): boolean {
    const waiter = this.codexWaiterRef;
    if (!waiter) return false;
    const { method, params } = notification;
    const ids = extractKnowledgeBaseNotificationIds(params);
    const route = routeKnowledgeBaseCodexNotification(method, params, {
      threadId: waiter.threadId,
      turnId: waiter.turnId,
      itemIds: waiter.itemIds
    });
    const retryingError = method === "error" && isRetryingCodexError(params);
    if (!route.swallow) {
      if (retryingError && waiter.startTurnPending && ids.threadId === waiter.threadId) {
        this.markCodexWaiterActivity(waiter);
        return true;
      }
      return false;
    }
    this.markCodexWaiterActivity(waiter);
    if (method === "turn/started" && ids.turnId) waiter.turnId = ids.turnId;
    if (route.rememberItemId) waiter.itemIds.add(route.rememberItemId);
    if (ids.itemId && ids.turnId && ids.turnId === waiter.turnId) waiter.itemIds.add(ids.itemId);
    if (route.collectAssistantDelta) appendCodexWaiterAssistantDelta(waiter, ids.itemId, codexNotificationDelta(params));
    if (method === "turn/completed") {
      if (waiter.startTurnPending) {
        waiter.pendingTerminal = { method, params };
        return true;
      }
      this.finishCodexWaiter(waiter, method, params);
    }
    if (method === "error") {
      if (retryingError) return true;
      if (waiter.startTurnPending) {
        waiter.pendingTerminal = { method, params };
        return true;
      }
      this.finishCodexWaiter(waiter, method, params);
    }
    return true;
  }

  async runCodexKnowledgeTask(
    prompt: string,
    sources: KnowledgeBaseSource[],
    permission: PermissionMode = "workspace-write",
    writeScope: "knowledge-base" | "knowledge-lint" | "journal" = "knowledge-base",
    turnOptionOverrides?: KnowledgeBaseTurnOptionOverrides,
    managedKind: KnowledgeBaseManagedThreadKind = "unknown"
  ): Promise<string> {
    let status = await this.plugin.ensureCodexConnected(false, { silent: true });
    if (!status.connected) {
      status = await this.plugin.ensureCodexConnected(true, { silent: true }).catch(() => status);
    }
    if (!status.connected || !this.plugin.codex) throw new Error(this.formatCodexDiagnostic(status.errors[0] || "Codex 未连接", this.plugin.settings.defaultModel));
    this.throwIfCanceled();
    const options = buildCodexKnowledgeTurnOptions({
      settings: this.plugin.settings,
      availableModels: status.models,
      vaultPath: this.plugin.getVaultPath(),
      permission,
      writeScope,
      overrides: turnOptionOverrides
    });
    let started: { threadId: string; title: string };
    try {
      started = await this.plugin.codex.startThread(options);
    } catch (error) {
      status = await this.plugin.ensureCodexConnected(true, { silent: true }).catch(() => status);
      if (!status.connected || !this.plugin.codex) throw error;
      started = await this.plugin.codex.startThread(options);
    }
    const managedRunId = this.managedThreads.remember(started.threadId, managedKind);
    await this.plugin.codex.setThreadName?.(started.threadId, `Codex EchoInk KB: ${managedKind}`).catch(swallowError("rename knowledge base Codex thread"));
    this.throwIfCanceled();
    const inactivityTimeoutMs = normalizeCodexInactivityTimeoutMs(turnOptionOverrides?.codexInactivityTimeoutMs);
    let waiterRef: CodexKbWaiter | null = null;
    const result = new Promise<string>((resolve, reject) => {
      waiterRef = { threadId: started.threadId, turnId: "", itemIds: new Set<string>(), assistantItems: new Map<string, string>(), assistantItemOrder: [], resolve, reject, model: options.model, startTurnPending: true, inactivityTimeoutMs, inactivityTimer: null };
      this.codexWaiterRef = waiterRef;
    });
    try {
      this.throwIfCanceled();
      let startTurnAbandoned = false;
      let cancelStartTurn: ((error: Error) => void) | null = null;
      const cancelStartTurnPromise = new Promise<never>((_, reject) => {
        cancelStartTurn = (error: Error) => {
          startTurnAbandoned = true;
          reject(error);
        };
      });
      this.activeCodexRunRef = { threadId: started.threadId, turnId: "", cancel: cancelStartTurn ?? undefined };
      const startTurnPromise = this.plugin.codex.startTurn(started.threadId, buildCodexKnowledgeInput(prompt, sources), options).then((turnId) => {
        if (startTurnAbandoned) void this.plugin.codex?.interruptTurn(started.threadId, turnId).catch(swallowError("interrupt abandoned knowledge base Codex turn"));
        return turnId;
      });
      const turnId = await rejectAfterTimeout(
        Promise.race([startTurnPromise, cancelStartTurnPromise]),
        inactivityTimeoutMs,
        () => { startTurnAbandoned = true; },
        `长时间没有收到 Codex turn id（${formatDurationForError(inactivityTimeoutMs)}），已结束本轮知识库任务。`
      );
      this.activeCodexRunRef = { threadId: started.threadId, turnId };
      if (this.codexWaiterRef) {
        const waiter = this.codexWaiterRef;
        if (waiter.turnId && waiter.turnId !== turnId) {
          waiter.itemIds.clear();
          waiter.assistantItems.clear();
          waiter.assistantItemOrder = [];
          waiter.pendingTerminal = undefined;
        }
        waiter.turnId = turnId;
        waiter.startTurnPending = false;
        const pendingTerminal = waiter.pendingTerminal;
        waiter.pendingTerminal = undefined;
        if (pendingTerminal) this.finishCodexWaiter(waiter, pendingTerminal.method, pendingTerminal.params);
        else this.armCodexWaiterInactivityTimer(waiter);
      }
      if (this.context.isCancelRequested()) {
        await this.plugin.codex.interruptTurn(started.threadId, turnId).catch(swallowError("interrupt canceled knowledge base Codex turn"));
        throw new Error(KNOWLEDGE_BASE_CANCEL_ERROR);
      }
    } catch (error) {
      if (waiterRef) this.clearCodexWaiterTimer(waiterRef);
      this.codexWaiterRef = null;
      this.managedThreads.markPendingArchive(started.threadId, managedRunId);
      throw error;
    }
    try {
      return await result;
    } finally {
      if (waiterRef) this.clearCodexWaiterTimer(waiterRef);
      if (this.codexWaiterRef === waiterRef) this.codexWaiterRef = null;
      this.managedThreads.markPendingArchive(started.threadId, managedRunId);
    }
  }

  async runOpenCodeKnowledgeTask(
    prompt: string,
    sources: KnowledgeBaseSource[],
    permission: PermissionMode = "workspace-write",
    resources?: PreparedAgentResources,
    toolBridge?: AgentToolBridgeRuntime | null,
    turnOptionOverrides?: KnowledgeBaseTurnOptionOverrides
  ): Promise<string> {
    const runtime = this.context.createKnowledgeAgentRuntime("opencode");
    try {
      await runtime.connect();
      this.throwIfCanceled();
      this.plugin.settings.opencode.lastConnectedAt = Date.now();
      this.plugin.settings.opencode.lastError = "";
      const models = await runtime.listModels();
      this.throwIfCanceled();
      const parts = buildOpenCodeKnowledgeParts(prompt, sources);
      const selectedModel = selectOpenCodeModel(models, this.plugin.settings.opencode.providerId, this.plugin.settings.opencode.modelId, requiredModalities(parts));
      ensureOpenCodeModelSupportsFiles(selectedModel, parts);
      if (selectedModel) {
        this.plugin.settings.opencode.providerId = selectedModel.providerId;
        this.plugin.settings.opencode.modelId = selectedModel.modelId;
        this.plugin.settings.opencode.textEnabled = selectedModel.inputModalities.includes("text");
        this.plugin.settings.opencode.imageEnabled = selectedModel.inputModalities.includes("image");
        this.plugin.settings.opencode.pdfEnabled = selectedModel.inputModalities.includes("pdf");
      }
      await this.plugin.saveSettings();
      this.throwIfCanceled();
      return await this.sendOpenCodeTaskWithGuards(runtime, {
        prompt,
        sources: parts.filter((part) => part.type === "file"),
        permission,
        resources,
        toolBridge,
        timeoutMs: normalizeOpenCodeTaskTimeoutMs(turnOptionOverrides?.opencodeTaskTimeoutMs),
        agent: this.plugin.settings.opencode.agent,
        ...(selectedModel ? { model: { providerId: selectedModel.providerId, modelId: selectedModel.modelId } } : {}),
        tools: {
          write: permission !== "read-only",
          edit: permission !== "read-only",
          read: true,
          bash: false
        }
      }, normalizeOpenCodeTaskTimeoutMs(turnOptionOverrides?.opencodeTaskTimeoutMs));
    } catch (error) {
      if (!this.context.isCancelRequested() && !isKnowledgeBaseCancelError(error instanceof Error ? error.message : String(error))) {
        this.plugin.settings.opencode.lastError = error instanceof Error ? error.message : String(error);
      }
      throw error;
    } finally {
      await runtime.disconnect?.();
    }
  }

  async runHermesKnowledgeTask(
    prompt: string,
    _sources: KnowledgeBaseSource[],
    permission: PermissionMode = "workspace-write",
    resources?: PreparedAgentResources,
    toolBridge?: AgentToolBridgeRuntime | null,
    turnOptionOverrides?: KnowledgeBaseTurnOptionOverrides
  ): Promise<string> {
    const runtime = this.context.createKnowledgeAgentRuntime("hermes");
    try {
      const status = await runtime.connect();
      this.throwIfCanceled();
      const hermes = this.plugin.settings.agents.hermes;
      hermes.lastConnectedAt = Date.now();
      hermes.lastError = "";
      if (status.version) hermes.version = status.version;
      const models = await runtime.listModels();
      this.throwIfCanceled();
      const selectedModel = selectAgentModel(models, hermes.providerId, hermes.modelId);
      if (selectedModel) {
        hermes.providerId = selectedModel.providerId;
        hermes.modelId = selectedModel.modelId;
      }
      await this.plugin.saveSettings();
      this.throwIfCanceled();
      return await this.sendHermesTaskWithGuards(runtime, {
        prompt,
        permission,
        resources,
        toolBridge,
        timeoutMs: normalizeHermesTaskTimeoutMs(turnOptionOverrides?.hermesTaskTimeoutMs),
        ...(selectedModel ? { model: { providerId: selectedModel.providerId, modelId: selectedModel.modelId } } : {}),
        profile: hermes.profile,
        tools: {
          write: permission !== "read-only",
          edit: permission !== "read-only",
          read: true,
          bash: false
        }
      }, normalizeHermesTaskTimeoutMs(turnOptionOverrides?.hermesTaskTimeoutMs));
    } catch (error) {
      if (!this.context.isCancelRequested() && !isKnowledgeBaseCancelError(error instanceof Error ? error.message : String(error))) {
        this.plugin.settings.agents.hermes.lastError = error instanceof Error ? error.message : String(error);
      }
      throw error;
    } finally {
      await runtime.disconnect?.();
    }
  }

  private async sendHermesTaskWithGuards(runtime: AgentTaskRuntime, input: AgentTaskInput, timeoutMs: number): Promise<string> {
    return this.sendAgentTaskWithGuards("hermes", runtime, input, timeoutMs);
  }

  private async sendOpenCodeTaskWithGuards(runtime: AgentTaskRuntime, input: AgentTaskInput, timeoutMs: number): Promise<string> {
    return this.sendAgentTaskWithGuards("opencode", runtime, input, timeoutMs);
  }

  private async sendAgentTaskWithGuards(backend: GuardedAgentBackend, runtime: AgentTaskRuntime, input: AgentTaskInput, timeoutMs: number): Promise<string> {
    const abortController = new AbortController();
    const activeRun: GuardedAgentRun = backend === "hermes"
      ? { runtime, runId: `hermes-${Date.now()}`, abortController }
      : { runtime, runId: "" };
    const backendLabel = backend === "hermes" ? "Hermes" : "OpenCode";
    let lastPhase = "starting";
    this.setActiveGuardedRun(backend, activeRun);
    return await new Promise<string>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout>;
      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.clearActiveGuardedRun(backend, activeRun);
        activeRun.cancel = undefined;
        callback();
      };
      const fail = (error: Error): void => finish(() => reject(error));
      timer = setTimeout(() => {
        abortController.abort();
        const timeoutError = new Error(formatAgentTaskFailureContext({
          backend,
          phase: lastPhase,
          runId: activeRun.runId,
          message: `${backendLabel} 长时间没有返回（${formatDurationForError(timeoutMs)}），已请求中断。`
        }));
        if (backend === "hermes" || activeRun.runId) {
          void runtime.abort(activeRun.runId).catch(swallowError(`abort timed out ${backend} knowledge base run`));
          fail(timeoutError);
          return;
        }
        setTimeout(() => {
          if (activeRun.runId) void runtime.abort(activeRun.runId).catch(swallowError(`abort delayed ${backend} knowledge base run`));
          fail(timeoutError);
        }, 20);
      }, Math.max(1, timeoutMs));
      activeRun.cancel = (error: Error) => {
        abortController.abort();
        if (backend === "hermes" || activeRun.runId) void runtime.abort(activeRun.runId).catch(swallowError(`abort canceled ${backend} knowledge base run`));
        fail(error);
      };
      try {
        runKnowledgeAgentTask(runtime, {
          ...input,
          abortSignal: abortController.signal,
          onRunId: (runId) => {
            activeRun.runId = runId;
            input.onRunId?.(runId);
          }
        }, (event) => {
          lastPhase = event.type;
          if (event.runId) activeRun.runId = event.runId;
        }).then(
          (output) => finish(() => resolve(output.text)),
          (error) => fail(formatAgentTaskGuardError(backend, lastPhase, activeRun.runId, error))
        );
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private finishCodexWaiter(waiter: CodexKbWaiter, method: "turn/completed" | "error", params: unknown): void {
    if (method === "error" && isRetryingCodexError(params)) return;
    this.clearCodexWaiterTimer(waiter);
    if (this.codexWaiterRef === waiter) this.codexWaiterRef = null;
    if (method === "turn/completed" && codexNotificationTurnStatus(params) !== "failed") {
      if (this.context.isCancelRequested()) waiter.reject(new Error(KNOWLEDGE_BASE_CANCEL_ERROR));
      else waiter.resolve(finalCodexWaiterAssistantText(waiter));
      return;
    }
    waiter.reject(new Error(this.formatCodexDiagnostic(formatKnowledgeBaseCodexFailureSignal(method, params, "Codex 知识库任务失败"), waiter.model)));
  }

  private markCodexWaiterActivity(waiter: CodexKbWaiter): void {
    if (waiter.startTurnPending || this.codexWaiterRef !== waiter) return;
    this.armCodexWaiterInactivityTimer(waiter);
  }

  private armCodexWaiterInactivityTimer(waiter: CodexKbWaiter): void {
    this.clearCodexWaiterTimer(waiter);
    waiter.inactivityTimer = setTimeout(() => {
      if (this.codexWaiterRef !== waiter) return;
      this.clearCodexWaiterTimer(waiter);
      this.codexWaiterRef = null;
      const threadId = waiter.threadId;
      const turnId = waiter.turnId;
      if (this.activeCodexRunRef?.threadId === threadId && this.activeCodexRunRef.turnId === turnId) {
        this.activeCodexRunRef = null;
      }
      if (threadId && turnId) {
        void this.plugin.codex?.interruptTurn(threadId, turnId).catch(swallowError("interrupt inactive knowledge base Codex turn"));
      }
      waiter.reject(new Error(`长时间没有收到 Codex 终态（${formatDurationForError(waiter.inactivityTimeoutMs)}），已请求中断。`));
    }, Math.max(1, waiter.inactivityTimeoutMs));
  }

  private clearCodexWaiterTimer(waiter: CodexKbWaiter): void {
    if (!waiter.inactivityTimer) return;
    clearTimeout(waiter.inactivityTimer);
    waiter.inactivityTimer = null;
  }

  private setActiveGuardedRun(backend: GuardedAgentBackend, activeRun: GuardedAgentRun): void {
    if (backend === "hermes") {
      this.activeHermesRef = activeRun as ActiveHermesRun;
      return;
    }
    this.activeOpenCodeRef = activeRun as ActiveOpenCodeRun;
  }

  private clearActiveGuardedRun(backend: GuardedAgentBackend, activeRun: GuardedAgentRun): void {
    if (backend === "hermes") {
      if (this.activeHermesRef === activeRun) this.activeHermesRef = null;
      return;
    }
    if (this.activeOpenCodeRef === activeRun) this.activeOpenCodeRef = null;
  }

  private formatCodexDiagnostic(error: unknown, model: string): string {
    return diagnoseCodexError(error, {
      model,
      providerLabel: providerConnectionLabel(this.plugin.settings),
      proxyEnabled: this.plugin.settings.proxyEnabled,
      proxyUrl: this.plugin.settings.proxyUrl
    }).text;
  }

  private throwIfCanceled(): void {
    if (this.context.isCancelRequested()) throw new Error(KNOWLEDGE_BASE_CANCEL_ERROR);
  }
}

function isRetryingCodexError(params: unknown): boolean {
  const record = codexNotificationRecord(params);
  const error = codexNotificationRecord(record.error);
  return record.willRetry === true || error.willRetry === true;
}

function codexNotificationDelta(params: unknown): string {
  const delta = codexNotificationRecord(params).delta;
  return typeof delta === "string" ? delta : "";
}

function codexNotificationTurnStatus(params: unknown): string {
  const turn = codexNotificationRecord(codexNotificationRecord(params).turn);
  return typeof turn.status === "string" ? turn.status : "";
}

function codexNotificationRecord(params: unknown): Record<string, unknown> {
  return params && typeof params === "object" && !Array.isArray(params) ? params as Record<string, unknown> : {};
}

function appendCodexWaiterAssistantDelta(waiter: CodexKbWaiter, itemId: string, delta: string): void {
  if (!delta) return;
  const id = itemId || "__assistant__";
  if (!waiter.assistantItems.has(id)) waiter.assistantItemOrder.push(id);
  waiter.assistantItems.set(id, `${waiter.assistantItems.get(id) ?? ""}${delta}`);
}

function finalCodexWaiterAssistantText(waiter: CodexKbWaiter): string {
  for (let index = waiter.assistantItemOrder.length - 1; index >= 0; index -= 1) {
    const text = (waiter.assistantItems.get(waiter.assistantItemOrder[index]) ?? "").trim();
    if (text) return text;
  }
  return "";
}
