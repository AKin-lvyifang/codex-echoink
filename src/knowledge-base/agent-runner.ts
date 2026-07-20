import * as path from "path";
import { createAgentTaskRuntime } from "../agent/factory";
import type { AgentEventTaskRuntime, AgentTaskRuntime, PreparedAgentResources } from "../agent/runtime";
import type { AgentBackendKind, AgentInputModality, AgentModelInfo, AgentPromptPart, AgentTaskInput } from "../agent/types";
import { OpenCodeBackend, type OpenCodeHistorySnapshot } from "../core/opencode-backend";
import { ensureOpenCodeModelSupportsFiles, requiredModalityForMime, selectOpenCodeModelForTask } from "../core/opencode-models";
import { harnessBackendDisplayName, harnessTaskAgent, harnessTaskModel, harnessTaskProfile } from "../harness/agents/backend-runtime-profile";
import { TaskRuntimeAgentAdapter, type TaskRuntimeAgentAdapterOptions } from "../harness/agents/adapters/task-runtime-adapter";
import type { NativeExecutionRef } from "../harness/contracts/native-execution";
import type { HarnessRunResult, HarnessWorkflow, OutputContract } from "../harness/contracts/run";
import type { ContextSection } from "../harness/contracts/context";
import type { HarnessRunWithAdapterInput } from "../harness/kernel/harness-kernel";
import { memoryRequestPolicy } from "../harness/memory/workflow-policy";
import { resourceSelectionFromPreparedResources } from "../resources/registry";
import type { CodexForObsidianSettings } from "../settings/settings";
import type { UserInput } from "../types/app-server";
import { formatAgentTaskFailureContext, isKnowledgeBaseCancelError, KNOWLEDGE_BASE_CANCEL_ERROR } from "./failure";
import type { KnowledgeBaseSource } from "./types";
import {
  isTrustedKnowledgeAgentNativeTerminationReceipt,
  issueKnowledgeAgentNativeTerminationReceipt,
  type KnowledgeAgentNativeTerminationReceipt
} from "./native-termination";

const MAX_ATTACHED_SOURCES = 20;
const CODEX_KNOWLEDGE_INACTIVITY_TIMEOUT_MS = 20 * 60 * 1000;
const OPENCODE_KNOWLEDGE_TASK_TIMEOUT_MS = 20 * 60 * 1000;
const HERMES_KNOWLEDGE_TASK_TIMEOUT_MS = 20 * 60 * 1000;
const OPENCODE_KNOWLEDGE_INNER_DEADLINE_GRACE_MS = 5_000;
const OPENCODE_RICH_RUNTIME_MIN_TIMEOUT_MS = 1_000;

export interface KnowledgeAgentHarnessOptions {
  vaultPath: string;
  cwd?: string;
  sessionId?: string;
  sessionProvider?: HarnessRunWithAdapterInput["sessionProvider"];
  nativeRefContextForBackend?(backendId: AgentBackendKind): TaskRuntimeAgentAdapterOptions["nativeRefContext"];
  runWithAdapter(input: HarnessRunWithAdapterInput): Promise<HarnessRunResult>;
}

export type KnowledgeAgentTaskInput = Omit<AgentTaskInput, "onRunId"> & {
  harnessRunId?: string;
  workflow?: HarnessWorkflow;
  outputKind?: OutputContract["kind"];
  vaultProfileSections?: ContextSection[];
  onSubmitted?: () => void;
  onRunId?: (
    runId: string,
    native: NativeExecutionRef
  ) => void | Promise<void>;
};

export type KnowledgeAgentTaskOutput = {
  text: string;
  harnessResult?: HarnessRunResult;
  harnessRunId?: string;
  workflowRunId?: string;
  attemptId?: string;
  backend?: AgentBackendKind;
  submittedAt?: number;
};

export type KnowledgeJournalNativeHistory = OpenCodeHistorySnapshot | null;

export type KnowledgeAgentArtifactRecovery = () => Promise<string | null>;

export interface KnowledgeAgentTurnOptionOverrides {
  codexInactivityTimeoutMs?: number;
  opencodeTaskTimeoutMs?: number;
  hermesTaskTimeoutMs?: number;
}

export interface KnowledgeCodexRuntimeTaskRequest {
  harnessRunId?: string;
  prompt: string;
  sources: KnowledgeBaseSource[];
  permission: AgentTaskInput["permission"];
  writeScope: "knowledge-base" | "knowledge-lint" | "journal";
  turnOptionOverrides?: KnowledgeAgentTurnOptionOverrides;
  managedKind: string;
  resources?: PreparedAgentResources;
  artifactRecovery?: KnowledgeAgentArtifactRecovery;
  vaultProfileSections?: ContextSection[];
  onSubmitted?: () => void;
  vaultPathOverride?: string;
  writableRootsOverride?: string[];
  requireExactWriteFence?: boolean;
  exactWriteFence?: AgentTaskInput["exactWriteFence"];
  onExactWriteFenceConfigured?: AgentTaskInput["onExactWriteFenceConfigured"];
  onNativeRunId?: (
    backend: AgentBackendKind,
    runId: string,
    native: NativeExecutionRef
  ) => void | Promise<void>;
}

type ActiveKnowledgeRuntimeRun = {
  backend: AgentBackendKind;
  runtime: AgentTaskRuntime;
  nativeRunId: string;
  abortController: AbortController;
  cancel?: (error: Error) => void;
};

export interface KnowledgeAgentRuntimeControllerOptions {
  settings: CodexForObsidianSettings;
  vaultPath(): string;
  saveSettings(): Promise<void>;
  isCanceled(): boolean;
  harness(vaultPathOverride?: string): KnowledgeAgentHarnessOptions;
  runCodexTask?(input: KnowledgeCodexRuntimeTaskRequest): Promise<KnowledgeAgentTaskOutput>;
}

export interface KnowledgeRuntimeTaskRequest {
  harnessRunId?: string;
  backend: AgentBackendKind;
  prompt: string;
  sources: KnowledgeBaseSource[];
  permission?: AgentTaskInput["permission"];
  codexWriteScope?: KnowledgeCodexRuntimeTaskRequest["writeScope"];
  resources?: PreparedAgentResources;
  toolBridge?: AgentTaskInput["toolBridge"];
  timeoutMs?: number;
  turnOptionOverrides?: KnowledgeAgentTurnOptionOverrides;
  workflow: HarnessWorkflow;
  outputKind: OutputContract["kind"];
  onNativeRunId?: (
    backend: AgentBackendKind,
    runId: string,
    native: NativeExecutionRef
  ) => void | Promise<void>;
  managedKind?: string;
  artifactRecovery?: KnowledgeAgentArtifactRecovery;
  vaultProfileSections?: ContextSection[];
  /** Fires once, immediately before the runtime can submit the Agent prompt. */
  onSubmitted?: () => void;
  /** Per-attempt isolated Vault root used by runtime, cwd and Harness workspace. */
  vaultPathOverride?: string;
  /** Exact per-attempt write roots; maintenance must not default to the whole Shadow. */
  writableRootsOverride?: string[];
  /**
   * Fail closed unless the selected backend can preserve the exact Shadow
   * writable-root fence without falling back to a broader transport.
   */
  requireExactWriteFence?: boolean;
  exactWriteFence?: AgentTaskInput["exactWriteFence"];
  onExactWriteFenceConfigured?: AgentTaskInput["onExactWriteFenceConfigured"];
}

export interface KnowledgeRuntimePreflightRequest {
  backend: Exclude<AgentBackendKind, "codex-cli">;
  sources: KnowledgeBaseSource[];
  vaultPathOverride?: string;
}

type KnowledgeRuntimeRunner = (
  controller: KnowledgeAgentRuntimeController,
  input: KnowledgeRuntimeTaskRequest
) => Promise<KnowledgeAgentTaskOutput>;

const KNOWLEDGE_RUNTIME_RUNNERS: Record<AgentBackendKind, KnowledgeRuntimeRunner> = {
  "codex-cli": async (controller, input) => await controller.runCodexTask(input),
  opencode: async (controller, input) => await controller.runTaskRuntime(input),
  hermes: async (controller, input) => await controller.runTaskRuntime(input)
};

const KNOWLEDGE_JOURNAL_COLLECTORS: Partial<Record<AgentBackendKind, typeof collectOpenCodeKnowledgeJournalHistory>> = {
  opencode: collectOpenCodeKnowledgeJournalHistory
};

const KNOWLEDGE_TASK_TIMEOUT_NORMALIZERS: Record<AgentBackendKind, (value: number | undefined) => number> = {
  "codex-cli": normalizeCodexInactivityTimeoutMs,
  opencode: normalizeOpenCodeTaskTimeoutMs,
  hermes: normalizeHermesTaskTimeoutMs
};

export async function collectOpenCodeKnowledgeJournalHistory(input: {
  settings: CodexForObsidianSettings;
  vaultPath: string;
  startMs: number;
  endMs: number;
  saveSettings(): Promise<void>;
}) {
  const backend = new OpenCodeBackend({
    ...input.settings.opencode,
    vaultPath: input.vaultPath
  });
  try {
    await backend.connect();
    input.settings.opencode.lastConnectedAt = Date.now();
    input.settings.opencode.lastError = "";
    await input.saveSettings();
    return await backend.collectHistoryMessages({
      startMs: input.startMs,
      endMs: input.endMs
    });
  } catch (error) {
    input.settings.opencode.lastError = error instanceof Error ? error.message : String(error);
    await input.saveSettings();
    throw error;
  } finally {
    await backend.disconnect();
  }
}

export async function collectKnowledgeJournalHistoryForBackend(input: {
  backend: AgentBackendKind;
  settings: CodexForObsidianSettings;
  vaultPath: string;
  startMs: number;
  endMs: number;
  saveSettings(): Promise<void>;
}): Promise<KnowledgeJournalNativeHistory> {
  const collector = KNOWLEDGE_JOURNAL_COLLECTORS[input.backend];
  return collector ? await collector(input) : null;
}

export class KnowledgeAgentRuntimeController {
  private activeRun: ActiveKnowledgeRuntimeRun | null = null;

  constructor(private readonly options: KnowledgeAgentRuntimeControllerOptions) {}

  get hasActiveRun(): boolean {
    return Boolean(this.activeRun);
  }

  clear(): void {
    this.activeRun = null;
  }

  async cancel(error = new Error(KNOWLEDGE_BASE_CANCEL_ERROR)): Promise<boolean> {
    const run = this.activeRun;
    if (!run) return false;
    if (run.cancel) {
      run.cancel(error);
      return true;
    }
    if (run.nativeRunId) await run.runtime.abort(run.nativeRunId).catch(() => undefined);
    return true;
  }

  async run(input: KnowledgeRuntimeTaskRequest): Promise<KnowledgeAgentTaskOutput> {
    const runner = KNOWLEDGE_RUNTIME_RUNNERS[input.backend];
    if (!runner) throw new Error(`Unsupported knowledge backend: ${input.backend}`);
    return await runner(this, input);
  }

  /**
   * Checks a task-runtime backend without submitting a prompt. Maintenance uses
   * this before an attempt so only definitive infrastructure/model failures can
   * move to the next Agent.
   */
  async preflight(input: KnowledgeRuntimePreflightRequest): Promise<void> {
    const runtime = this.createRuntime(input.backend, input.vaultPathOverride);
    try {
      const status = await runtime.connect();
      if (!status.connected) {
        throw knowledgeBackendUnavailableError(
          input.backend,
          status.errors[0] || `${status.label || harnessBackendDisplayName(input.backend)} 连接未就绪`
        );
      }
      throwIfKnowledgeTaskCanceled(this.options.isCanceled());
      const models = await runtime.listModels();
      throwIfKnowledgeTaskCanceled(this.options.isCanceled());
      const parts = knowledgeSourcesToPromptParts(input.sources);
      const required = requiredModalities(parts);
      const configured = harnessTaskModel(this.options.settings, input.backend);
      const selected = input.backend === "opencode"
        ? selectOpenCodeModelForTask(
          models,
          configured?.providerId ?? this.options.settings.opencode.providerId,
          configured?.modelId ?? this.options.settings.opencode.modelId,
          required
        )
        : selectAgentModel(
          models,
          configured?.providerId ?? this.options.settings.agents.hermes.providerId,
          configured?.modelId ?? this.options.settings.agents.hermes.modelId
        );
      if (!selected) {
        throw knowledgeBackendUnavailableError(input.backend, "预检没有发现可用模型");
      }
      const missing = required.filter((modality) => !selected.inputModalities.includes(modality));
      if (missing.length) {
        throw knowledgeBackendUnavailableError(
          input.backend,
          `模型 ${selected.displayName || selected.modelId} 不支持 ${missing.join(" / ")} 输入`
        );
      }
    } catch (error) {
      if (shouldPreserveMaintenancePreflightError(error, this.options.isCanceled())) throw error;
      throw knowledgeBackendUnavailableError(
        input.backend,
        error instanceof Error ? error.message : String(error)
      );
    } finally {
      await runtime.disconnect?.().catch(() => undefined);
    }
  }

  async runCodexTask(input: KnowledgeRuntimeTaskRequest): Promise<KnowledgeAgentTaskOutput> {
    if (!this.options.runCodexTask) throw new Error("Codex knowledge task runner is unavailable.");
    return await this.options.runCodexTask({
      harnessRunId: input.harnessRunId,
      prompt: input.prompt,
      sources: input.sources,
      permission: input.permission,
      writeScope: input.codexWriteScope ?? "knowledge-base",
      turnOptionOverrides: input.turnOptionOverrides,
      managedKind: input.managedKind ?? "unknown",
      resources: input.resources,
      artifactRecovery: input.artifactRecovery,
      vaultProfileSections: input.vaultProfileSections,
      onSubmitted: input.onSubmitted,
      vaultPathOverride: input.vaultPathOverride,
      writableRootsOverride: input.writableRootsOverride,
      requireExactWriteFence: input.requireExactWriteFence,
      exactWriteFence: input.exactWriteFence,
      onExactWriteFenceConfigured: input.onExactWriteFenceConfigured,
      onNativeRunId: input.onNativeRunId
    });
  }

  async runTaskRuntime(input: KnowledgeRuntimeTaskRequest): Promise<KnowledgeAgentTaskOutput> {
    const runtime = this.createRuntime(input.backend, input.vaultPathOverride);
    const timeoutMs = normalizeKnowledgeTaskTimeoutMs(input.backend, input.timeoutMs);
    const runtimeTimeoutMs = knowledgeRuntimeTimeoutWithGuardGrace(input.backend, timeoutMs);
    try {
      await runtime.connect();
      throwIfKnowledgeTaskCanceled(this.options.isCanceled());
      await runtime.listModels();
      throwIfKnowledgeTaskCanceled(this.options.isCanceled());
      await this.options.saveSettings();
      throwIfKnowledgeTaskCanceled(this.options.isCanceled());
      return await this.sendTaskWithGuards(input.backend, runtime, {
        prompt: input.prompt,
        sources: knowledgeSourcesToPromptParts(input.sources),
        permission: input.permission,
        writableRoots: input.permission === "read-only"
          ? []
          : input.writableRootsOverride ?? [input.vaultPathOverride ?? this.options.vaultPath()],
        resources: input.resources,
        toolBridge: input.toolBridge,
        timeoutMs: runtimeTimeoutMs,
        model: harnessTaskModel(this.options.settings, input.backend),
        agent: harnessTaskAgent(this.options.settings, input.backend),
        profile: harnessTaskProfile(this.options.settings, input.backend),
        requireNativeRegistrationBeforePrompt: input.managedKind !== "ask",
        onRunId: async (runId, native) => {
          await input.onNativeRunId?.(input.backend, runId, native);
        },
        tools: {
          write: input.permission !== "read-only",
          edit: input.permission !== "read-only",
          read: true,
          bash: false
        },
        requireExactWriteFence: input.requireExactWriteFence,
        exactWriteFence: input.exactWriteFence,
        onExactWriteFenceConfigured: input.onExactWriteFenceConfigured,
        vaultProfileSections: input.vaultProfileSections,
        onSubmitted: input.onSubmitted
      }, timeoutMs, input.workflow, input.outputKind, input.harnessRunId, input.vaultPathOverride);
    } catch (error) {
      if (!this.options.isCanceled() && !isKnowledgeBaseCancelError(error instanceof Error ? error.message : String(error))) {
        this.recordRuntimeError(input.backend, error);
      }
      throw error;
    } finally {
      await runtime.disconnect?.();
    }
  }

  private createRuntime(backend: AgentBackendKind, vaultPathOverride?: string): AgentTaskRuntime {
    return createAgentTaskRuntime({
      backend,
      settings: this.options.settings,
      vaultPath: vaultPathOverride ?? this.options.vaultPath()
    });
  }

  private async sendTaskWithGuards(
    backend: AgentBackendKind,
    runtime: AgentTaskRuntime,
    input: KnowledgeAgentTaskInput,
    timeoutMs: number,
    workflow: HarnessWorkflow,
    outputKind: OutputContract["kind"],
    harnessRunId?: string,
    vaultPathOverride?: string
  ): Promise<KnowledgeAgentTaskOutput> {
    const abortController = new AbortController();
    const activeRun: ActiveKnowledgeRuntimeRun = {
      backend,
      runtime,
      nativeRunId: "",
      abortController
    };
    let lastPhase = "starting";
    this.activeRun = activeRun;
    return await new Promise<KnowledgeAgentTaskOutput>((resolve, reject) => {
      let settled = false;
      let timeoutStarted = false;
      let timer: ReturnType<typeof setTimeout>;
      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (this.activeRun === activeRun) this.activeRun = null;
        activeRun.cancel = undefined;
        callback();
      };
      const fail = (error: Error): void => finish(() => reject(this.options.isCanceled() ? new Error(KNOWLEDGE_BASE_CANCEL_ERROR) : error));
      timer = setTimeout(() => {
        timeoutStarted = true;
        const timeoutError = new Error(formatAgentTaskFailureContext({
          backend,
          phase: lastPhase,
          runId: activeRun.nativeRunId,
          message: `${harnessBackendDisplayName(backend)} 长时间没有返回（${formatDurationForError(timeoutMs)}），已请求中断。`
        }));
        void (async () => {
          abortController.abort();
          if (!activeRun.nativeRunId) {
            await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 20));
          }
          const nativeRunId = activeRun.nativeRunId;
          if (nativeRunId) {
            const nativeTerminationReceipt = await confirmRuntimeAbort(
              backend,
              runtime,
              nativeRunId,
              harnessRunId ?? activeRun.nativeRunId
            );
            if (nativeTerminationReceipt) {
              Object.assign(timeoutError, {
                terminationConfirmedAt: nativeTerminationReceipt.confirmedAt,
                nativeTerminationReceipt
              });
            }
          }
          fail(timeoutError);
        })();
      }, Math.max(1, timeoutMs));
      activeRun.cancel = (error: Error) => {
        abortController.abort();
        if (activeRun.nativeRunId) void runtime.abort(activeRun.nativeRunId).catch(() => undefined);
        fail(error);
      };
      try {
        runKnowledgeAgentTask(runtime, {
          ...input,
          harnessRunId,
          workflow,
          outputKind,
          abortSignal: abortController.signal,
          onRunId: async (runId, native) => {
            activeRun.nativeRunId = runId;
            await input.onRunId?.(runId, native);
          }
        }, (event) => {
          lastPhase = event.type;
        }, this.options.harness(vaultPathOverride)).then(
          (output) => {
            if (!timeoutStarted) finish(() => resolve({ text: output.text, harnessResult: output.harnessResult }));
          },
          (error) => {
            if (!timeoutStarted) fail(formatAgentTaskGuardError(backend, lastPhase, activeRun.nativeRunId, error));
          }
        );
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private recordRuntimeError(backend: AgentBackendKind, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    const recorders: Partial<Record<AgentBackendKind, () => void>> = {
      opencode: () => { this.options.settings.opencode.lastError = message; },
      hermes: () => { this.options.settings.agents.hermes.lastError = message; }
    };
    recorders[backend]?.();
  }
}

export function buildCodexKnowledgeInput(prompt: string, sources: KnowledgeBaseSource[]): UserInput[] {
  const input: UserInput[] = [{ type: "text", text: prompt, text_elements: [] }];
  for (const source of sources.slice(0, MAX_ATTACHED_SOURCES)) {
    if (source.modality === "image") {
      input.push({ type: "localImage", path: source.absolutePath });
    } else {
      input.push({ type: "mention", name: path.basename(source.absolutePath), path: source.absolutePath });
    }
  }
  return input;
}

export function knowledgeSourcesToPromptParts(sources: KnowledgeBaseSource[]): AgentPromptPart[] {
  return sources.slice(0, MAX_ATTACHED_SOURCES).map((source): AgentPromptPart => ({
    type: "file",
    path: source.absolutePath,
    filename: path.basename(source.absolutePath),
    mime: source.mime
  }));
}

export function buildOpenCodeKnowledgeParts(prompt: string, sources: KnowledgeBaseSource[]): AgentPromptPart[] {
  return [
    { type: "text", text: prompt },
    ...knowledgeSourcesToPromptParts(sources)
  ];
}

export function requiredModalities(parts: AgentPromptPart[]): AgentInputModality[] {
  const modalities = new Set<AgentInputModality>(["text"]);
  for (const part of parts) {
    if (part.type === "file") modalities.add(requiredModalityForMime(part.mime));
  }
  return Array.from(modalities);
}

export function selectOpenCodeModel(models: AgentModelInfo[], providerId: string, modelId: string, required: AgentInputModality[]): AgentModelInfo | null {
  const configured = models.find((model) => model.providerId === providerId && model.modelId === modelId);
  if (configured) return configured;
  return models.find((model) => required.every((modality) => model.inputModalities.includes(modality))) ?? models[0] ?? null;
}

export function selectAgentModel(models: AgentModelInfo[], providerId: string, modelId: string): AgentModelInfo | null {
  const configured = models.find((model) => model.providerId === providerId && model.modelId === modelId);
  return configured ?? models[0] ?? null;
}

export async function runKnowledgeAgentTask(
  runtime: AgentTaskRuntime,
  input: KnowledgeAgentTaskInput,
  onEvent: ((event: { type: string; runId?: string }) => void) | undefined,
  harness: KnowledgeAgentHarnessOptions
) {
  const workflow = input.workflow ?? "knowledge.maintain";
  const adapter = new TaskRuntimeAgentAdapter({
    backendId: runtime.kind,
    displayName: harnessBackendDisplayName(runtime.kind),
    version: "legacy-runtime",
    runtime: runtimeWithSubmissionBoundary(runtime, input.onSubmitted),
    nativeRefContext: harness.nativeRefContextForBackend?.(runtime.kind),
    capabilities: "legacy",
    legacyTaskDefaults: {
      resources: input.resources,
      toolBridge: input.toolBridge ?? null,
      timeoutMs: input.timeoutMs,
      tools: input.tools,
      model: input.model,
      agent: input.agent,
      profile: input.profile,
      requireNativeRegistrationBeforePrompt: input.requireNativeRegistrationBeforePrompt,
      requireExactWriteFence: input.requireExactWriteFence,
      exactWriteFence: input.exactWriteFence,
      onExactWriteFenceConfigured: input.onExactWriteFenceConfigured,
      abortSignal: input.abortSignal,
      onRunId: input.onRunId
    }
  });
  const result = await harness.runWithAdapter({
    adapter,
    sessionProvider: harness.sessionProvider,
    request: {
      runId: input.harnessRunId ?? `knowledge-${Date.now()}`,
      sessionId: harness.sessionId || "knowledge",
      surface: "knowledge",
      workflow,
      backendId: runtime.kind,
      workspace: {
        vaultPath: harness.vaultPath,
        cwd: harness.cwd ?? harness.vaultPath
      },
      input: {
        text: input.prompt,
        attachments: (input.sources ?? [])
          .filter((part) => part.type === "file")
          .map((part) => ({
            type: part.mime === "application/pdf" ? "pdf" as const : part.mime.startsWith("image/") ? "image" as const : "file" as const,
            path: part.path,
            name: part.filename,
            mime: part.mime
          }))
      },
      permissions: {
        mode: input.permission ?? "workspace-write",
        writableRoots: input.writableRoots ?? [],
        requireApproval: true
      },
      resourceSelection: {
        ...(input.resources
          ? resourceSelectionFromPreparedResources(input.resources, runtime.kind)
          : { selected: [], resolvedAt: Date.now(), warnings: [] })
      },
      memoryPolicy: memoryRequestPolicy(workflow),
      outputContract: {
        kind: input.outputKind ?? "knowledge-ledger"
      },
      vaultProfileSections: input.vaultProfileSections
    },
    sink: (event) => {
      onEvent?.({ type: event.type, runId: event.runId });
    }
  });
  if (result.status === "cancelled") {
    throw Object.assign(new Error(KNOWLEDGE_BASE_CANCEL_ERROR), {
      harnessResult: result
    });
  }
  if (result.status === "failed") {
    throw Object.assign(
      new Error(result.error || `${harnessBackendDisplayName(runtime.kind)} 知识库任务失败`),
      { harnessResult: result }
    );
  }
  return {
    text: result.outputText ?? result.error ?? "",
    runId: result.backendBinding?.nativeSessionId,
    harnessResult: result,
    usage: undefined
  };
}

function runtimeWithSubmissionBoundary(
  runtime: AgentTaskRuntime,
  onSubmitted: (() => void) | undefined
): AgentTaskRuntime & Partial<AgentEventTaskRuntime> {
  if (!onSubmitted) return runtime;
  let submitted = false;
  const markSubmitted = (): void => {
    if (submitted) return;
    submitted = true;
    onSubmitted();
  };
  const eventRuntime = runtime as AgentTaskRuntime & Partial<AgentEventTaskRuntime>;
  return {
    kind: runtime.kind,
    connect: () => runtime.connect(),
    disconnect: runtime.disconnect ? () => runtime.disconnect!() : undefined,
    listModels: () => runtime.listModels(),
    listAgents: runtime.listAgents ? () => runtime.listAgents!() : undefined,
    hasNativeSession: runtime.hasNativeSession ? (sessionId) => runtime.hasNativeSession!(sessionId) : undefined,
    deleteNativeSession: runtime.deleteNativeSession ? (sessionId) => runtime.deleteNativeSession!(sessionId) : undefined,
    runTask: (task) => runtime.runTask(withExactFenceSubmissionBoundary(task, markSubmitted)),
    ...(eventRuntime.runTaskEvents ? {
      runTaskEvents: (task: AgentTaskInput, emit: Parameters<AgentEventTaskRuntime["runTaskEvents"]>[1]) => {
        return eventRuntime.runTaskEvents!(withExactFenceSubmissionBoundary(task, markSubmitted), emit);
      }
    } : {}),
    abort: (runId) => runtime.abort(runId)
  };
}

function withExactFenceSubmissionBoundary(
  task: AgentTaskInput,
  markSubmitted: () => void
): AgentTaskInput {
  if (!task.requireExactWriteFence) {
    markSubmitted();
    return task;
  }
  const onExactWriteFenceConfigured = task.onExactWriteFenceConfigured;
  return {
    ...task,
    onExactWriteFenceConfigured: async (receipt) => {
      await onExactWriteFenceConfigured?.(receipt);
      // The trusted transport calls this hook after its exact policy ACK and
      // immediately before the prompt crosses the native submission boundary.
      markSubmitted();
    }
  };
}

function knowledgeBackendUnavailableError(backend: AgentBackendKind, detail: string): Error {
  return Object.assign(
    new Error(`${harnessBackendDisplayName(backend)} Agent backend unavailable：${detail}`),
    { code: "BACKEND_UNAVAILABLE" }
  );
}

function shouldPreserveMaintenancePreflightError(error: unknown, canceled: boolean): boolean {
  const message = error instanceof Error ? error.message : String(error);
  if (canceled || isKnowledgeBaseCancelError(message)) return true;
  if (!error || typeof error !== "object") return false;
  const code = String((error as { code?: unknown }).code ?? "").trim().toUpperCase();
  return code === "BACKEND_UNAVAILABLE"
    || code === "AUTH_REQUIRED"
    || code === "UNAUTHENTICATED"
    || code === "POLICY_DENIED"
    || code === "UNSAFE_VAULT"
    || code === "EXACT_WRITE_FENCE_UNAVAILABLE";
}

export function formatAgentTaskGuardError(backend: AgentBackendKind, phase: string, runId: string, error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (isKnowledgeBaseCancelError(message)) return error instanceof Error ? error : new Error(message);
  const formatted = new Error(formatAgentTaskFailureContext({ backend, phase, runId, message }));
  if (error && typeof error === "object") {
    const code = (error as { code?: unknown }).code;
    const terminationConfirmedAt = (error as { terminationConfirmedAt?: unknown }).terminationConfirmedAt;
    const nativeTerminationReceipt = (error as { nativeTerminationReceipt?: unknown }).nativeTerminationReceipt;
    if (typeof code === "string" && code) Object.assign(formatted, { code });
    if (typeof terminationConfirmedAt === "number" && Number.isFinite(terminationConfirmedAt)) {
      Object.assign(formatted, { terminationConfirmedAt });
    }
    if (isTrustedKnowledgeAgentNativeTerminationReceipt(nativeTerminationReceipt)) {
      Object.assign(formatted, { nativeTerminationReceipt });
    }
    const harnessResult = (error as { harnessResult?: unknown }).harnessResult;
    if (harnessResult) Object.assign(formatted, { harnessResult });
  }
  return formatted;
}

async function confirmRuntimeAbort(
  backend: AgentBackendKind,
  runtime: AgentTaskRuntime,
  runId: string,
  harnessRunId: string
): Promise<KnowledgeAgentNativeTerminationReceipt | undefined> {
  try {
    await rejectAfterTimeout(
      runtime.abort(runId),
      5_000,
      () => undefined,
      "Agent abort acknowledgement timed out"
    );
    return issueKnowledgeAgentNativeTerminationReceipt({
      backend,
      harnessRunId,
      nativeExecutionId: runId,
      kind: "abort-ack"
    });
  } catch {
    return undefined;
  }
}

export function buildPromptWithPreparedResources(prompt: string, resources: PreparedAgentResources): string {
  return [
    resources.promptPrefix,
    resources.warnings.length ? `资源提示：\n${resources.warnings.map((item) => `- ${item}`).join("\n")}` : "",
    prompt
  ].filter(Boolean).join("\n\n");
}

export function normalizeCodexInactivityTimeoutMs(value: number | undefined): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  return CODEX_KNOWLEDGE_INACTIVITY_TIMEOUT_MS;
}

export function rejectAfterTimeout<T>(promise: Promise<T>, timeoutMs: number, onTimeout: () => void, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return new Promise<T>((resolve, reject) => {
    timer = setTimeout(() => {
      timer = null;
      onTimeout();
      reject(new Error(message));
    }, Math.max(1, timeoutMs));
    promise.then((value) => {
      if (timer) clearTimeout(timer);
      timer = null;
      resolve(value);
    }, (error) => {
      if (timer) clearTimeout(timer);
      timer = null;
      reject(error);
    });
  });
}

export function normalizeOpenCodeTaskTimeoutMs(value: number | undefined): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  return OPENCODE_KNOWLEDGE_TASK_TIMEOUT_MS;
}

export function normalizeHermesTaskTimeoutMs(value: number | undefined): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  return HERMES_KNOWLEDGE_TASK_TIMEOUT_MS;
}

/**
 * The controller owns the user-visible timeout and must be the first layer to
 * abort a stalled OpenCode run so it can attach a trusted termination receipt.
 * Keep the subordinate rich runtime's recovery deadline strictly later. Values
 * below the rich-runtime threshold stay unchanged so the grace cannot alter
 * transport selection.
 */
export function knowledgeRuntimeTimeoutWithGuardGrace(
  backend: AgentBackendKind,
  guardTimeoutMs: number
): number {
  if (backend !== "opencode" || guardTimeoutMs < OPENCODE_RICH_RUNTIME_MIN_TIMEOUT_MS) {
    return guardTimeoutMs;
  }
  return guardTimeoutMs + OPENCODE_KNOWLEDGE_INNER_DEADLINE_GRACE_MS;
}

function normalizeKnowledgeTaskTimeoutMs(backend: AgentBackendKind, value: number | undefined): number {
  return KNOWLEDGE_TASK_TIMEOUT_NORMALIZERS[backend](value);
}

export function formatDurationForError(ms: number): string {
  if (ms >= 60_000) return `${Math.round(ms / 60_000)} 分钟`;
  return `${Math.round(ms / 1000)} 秒`;
}

function throwIfKnowledgeTaskCanceled(cancelRequested: boolean): void {
  if (cancelRequested) throw new Error(KNOWLEDGE_BASE_CANCEL_ERROR);
}
