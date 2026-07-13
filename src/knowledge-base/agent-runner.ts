import * as path from "path";
import { createAgentTaskRuntime } from "../agent/factory";
import type { AgentTaskRuntime, PreparedAgentResources } from "../agent/runtime";
import type { AgentBackendKind, AgentInputModality, AgentModelInfo, AgentPromptPart, AgentTaskInput } from "../agent/types";
import { OpenCodeBackend } from "../core/opencode-backend";
import { ensureOpenCodeModelSupportsFiles, requiredModalityForMime } from "../core/opencode-models";
import { harnessBackendDisplayName, harnessTaskAgent, harnessTaskModel, harnessTaskProfile } from "../harness/agents/backend-runtime-profile";
import { TaskRuntimeAgentAdapter, type TaskRuntimeAgentAdapterOptions } from "../harness/agents/adapters/task-runtime-adapter";
import type { HarnessRunResult, HarnessWorkflow, OutputContract } from "../harness/contracts/run";
import type { HarnessRunWithAdapterInput } from "../harness/kernel/harness-kernel";
import { resourceSelectionFromPreparedResources } from "../resources/registry";
import type { CodexForObsidianSettings } from "../settings/settings";
import type { UserInput } from "../types/app-server";
import { formatAgentTaskFailureContext, isKnowledgeBaseCancelError, KNOWLEDGE_BASE_CANCEL_ERROR } from "./failure";
import type { KnowledgeBaseSource } from "./types";

const MAX_ATTACHED_SOURCES = 20;
const CODEX_KNOWLEDGE_INACTIVITY_TIMEOUT_MS = 20 * 60 * 1000;
const OPENCODE_KNOWLEDGE_TASK_TIMEOUT_MS = 20 * 60 * 1000;
const HERMES_KNOWLEDGE_TASK_TIMEOUT_MS = 20 * 60 * 1000;

export interface KnowledgeAgentHarnessOptions {
  vaultPath: string;
  cwd?: string;
  sessionId?: string;
  sessionProvider?: HarnessRunWithAdapterInput["sessionProvider"];
  nativeRefContextForBackend?(backendId: AgentBackendKind): TaskRuntimeAgentAdapterOptions["nativeRefContext"];
  runWithAdapter(input: HarnessRunWithAdapterInput): Promise<HarnessRunResult>;
}

export type KnowledgeAgentTaskInput = AgentTaskInput & {
  harnessRunId?: string;
  workflow?: HarnessWorkflow;
  outputKind?: OutputContract["kind"];
};

export type KnowledgeAgentTaskOutput = {
  text: string;
  harnessResult?: HarnessRunResult;
};

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
  harness(): KnowledgeAgentHarnessOptions;
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
  onNativeRunId?: (backend: AgentBackendKind, runId: string) => void;
  managedKind?: string;
  artifactRecovery?: KnowledgeAgentArtifactRecovery;
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

export async function testOpenCodeKnowledgeConnection(input: {
  settings: CodexForObsidianSettings;
  vaultPath: string;
  saveSettings(): Promise<void>;
}): Promise<{ modelCount: number }> {
  const backend = new OpenCodeBackend({
    ...input.settings.opencode,
    vaultPath: input.vaultPath
  });
  try {
    await backend.connect();
    const models = await backend.listModels();
    const selected = selectOpenCodeModel(
      models,
      input.settings.opencode.providerId,
      input.settings.opencode.modelId,
      ["text"]
    );
    if (selected) {
      input.settings.opencode.providerId = selected.providerId;
      input.settings.opencode.modelId = selected.modelId;
      input.settings.opencode.textEnabled = selected.inputModalities.includes("text");
      input.settings.opencode.imageEnabled = selected.inputModalities.includes("image");
      input.settings.opencode.pdfEnabled = selected.inputModalities.includes("pdf");
    }
    input.settings.opencode.lastConnectedAt = Date.now();
    input.settings.opencode.lastError = "";
    await input.saveSettings();
    return { modelCount: models.length };
  } catch (error) {
    input.settings.opencode.lastError = error instanceof Error ? error.message : String(error);
    await input.saveSettings();
    throw error;
  } finally {
    await backend.disconnect();
  }
}

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
}) {
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
      artifactRecovery: input.artifactRecovery
    });
  }

  async runTaskRuntime(input: KnowledgeRuntimeTaskRequest): Promise<KnowledgeAgentTaskOutput> {
    const runtime = this.createRuntime(input.backend);
    const timeoutMs = normalizeKnowledgeTaskTimeoutMs(input.backend, input.timeoutMs);
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
        resources: input.resources,
        toolBridge: input.toolBridge,
        timeoutMs,
        model: harnessTaskModel(this.options.settings, input.backend),
        agent: harnessTaskAgent(this.options.settings, input.backend),
        profile: harnessTaskProfile(this.options.settings, input.backend),
        onRunId: (runId) => input.onNativeRunId?.(input.backend, runId),
        tools: {
          write: input.permission !== "read-only",
          edit: input.permission !== "read-only",
          read: true,
          bash: false
        }
      }, timeoutMs, input.workflow, input.outputKind, input.harnessRunId);
    } catch (error) {
      if (!this.options.isCanceled() && !isKnowledgeBaseCancelError(error instanceof Error ? error.message : String(error))) {
        this.recordRuntimeError(input.backend, error);
      }
      throw error;
    } finally {
      await runtime.disconnect?.();
    }
  }

  private createRuntime(backend: AgentBackendKind): AgentTaskRuntime {
    return createAgentTaskRuntime({
      backend,
      settings: this.options.settings,
      vaultPath: this.options.vaultPath()
    });
  }

  private async sendTaskWithGuards(
    backend: AgentBackendKind,
    runtime: AgentTaskRuntime,
    input: AgentTaskInput,
    timeoutMs: number,
    workflow: HarnessWorkflow,
    outputKind: OutputContract["kind"],
    harnessRunId?: string
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
        abortController.abort();
        const timeoutError = new Error(formatAgentTaskFailureContext({
          backend,
          phase: lastPhase,
          runId: activeRun.nativeRunId,
          message: `${harnessBackendDisplayName(backend)} 长时间没有返回（${formatDurationForError(timeoutMs)}），已请求中断。`
        }));
        if (activeRun.nativeRunId) {
          void runtime.abort(activeRun.nativeRunId).catch(() => undefined);
          fail(timeoutError);
          return;
        }
        setTimeout(() => {
          if (activeRun.nativeRunId) void runtime.abort(activeRun.nativeRunId).catch(() => undefined);
          fail(timeoutError);
        }, 20);
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
          onRunId: (runId) => {
            activeRun.nativeRunId = runId;
            input.onRunId?.(runId);
          }
        }, (event) => {
          lastPhase = event.type;
        }, this.options.harness()).then(
          (output) => finish(() => resolve({ text: output.text, harnessResult: output.harnessResult })),
          (error) => fail(formatAgentTaskGuardError(backend, lastPhase, activeRun.nativeRunId, error))
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
    runtime,
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
      memoryPolicy: {
        enabled: workflow === "knowledge.ask",
        maxItems: workflow === "knowledge.ask" ? 8 : 0
      },
      outputContract: {
        kind: input.outputKind ?? "knowledge-ledger"
      }
    },
    sink: (event) => {
      onEvent?.({ type: event.type, runId: event.runId });
    }
  });
  if (result.status === "cancelled") throw new Error(KNOWLEDGE_BASE_CANCEL_ERROR);
  if (result.status === "failed") throw new Error(result.error || `${harnessBackendDisplayName(runtime.kind)} 知识库任务失败`);
  return {
    text: result.outputText ?? result.error ?? "",
    runId: result.backendBinding?.nativeSessionId,
    harnessResult: result,
    usage: undefined
  };
}

export function formatAgentTaskGuardError(backend: AgentBackendKind, phase: string, runId: string, error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (isKnowledgeBaseCancelError(message)) return error instanceof Error ? error : new Error(message);
  return new Error(formatAgentTaskFailureContext({ backend, phase, runId, message }));
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
