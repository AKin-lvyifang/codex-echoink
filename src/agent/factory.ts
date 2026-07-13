import { HermesBackend } from "../core/hermes-backend";
import { OpenCodeBackend } from "../core/opencode-backend";
import { ensureOpenCodeModelSupportsFiles, requiredModalityForMime, selectOpenCodeModelForTask } from "../core/opencode-models";
import { resolveHermesCommand } from "../core/hermes-models";
import type { CodexForObsidianSettings } from "../settings/settings";
import type { AgentBackend, AgentBackendKind, AgentConnectionStatus, AgentInputModality, AgentModelInfo, AgentPromptPart, AgentTaskInput, AgentTaskResult } from "./types";
import type { AgentTaskRuntime } from "./runtime";
import { AcpAgentRuntime } from "./acp-runtime";
import { createAgentEventRuntimeWithFallback } from "./event-task";

export interface AgentRuntimeFactoryInput {
  backend: AgentBackendKind;
  settings: CodexForObsidianSettings;
  vaultPath: string;
  codexRunner?: (input: AgentTaskInput) => Promise<AgentTaskResult>;
  codexModels?: () => Promise<AgentModelInfo[]>;
  codexBackend?: AgentBackend;
}

export function createAgentTaskRuntime(input: AgentRuntimeFactoryInput): AgentTaskRuntime {
  if (input.backend === "codex-cli") return createCodexTaskRuntime(input);
  if (input.backend === "opencode") return createOpenCodeTaskRuntime(input);
  return createHermesTaskRuntime(input);
}

function createCodexTaskRuntime(input: AgentRuntimeFactoryInput): AgentTaskRuntime {
  return {
    kind: "codex-cli",
    async connect(): Promise<AgentConnectionStatus> {
      if (input.codexBackend) {
        const status = await input.codexBackend.connect();
        if (status) return status;
      }
      return { connected: true, label: "Codex", errors: [] };
    },
    async disconnect(): Promise<void> {
      await input.codexBackend?.disconnect();
    },
    async listModels(): Promise<AgentModelInfo[]> {
      if (input.codexBackend) return await input.codexBackend.listModels();
      return input.codexModels ? await input.codexModels() : [];
    },
    async runTask(task: AgentTaskInput): Promise<AgentTaskResult> {
      if (!input.codexRunner) throw new Error("Codex rich runtime 由 CodexService 管理，当前没有提供 task runner。");
      return await input.codexRunner(task);
    },
    async abort(runId: string): Promise<void> {
      if (!input.codexBackend) throw new Error("Codex runtime 缺少 CodexService，无法取消任务。");
      await input.codexBackend.abort(runId);
    }
  };
}

function createOpenCodeTaskRuntime(input: AgentRuntimeFactoryInput): AgentTaskRuntime {
  const backend = new OpenCodeBackend({ ...input.settings.opencode, vaultPath: input.vaultPath });
  const fallbackRuntime: AgentTaskRuntime = {
    kind: "opencode",
    async connect(): Promise<AgentConnectionStatus> {
      await backend.connect();
      const info = backend.getConnectionInfo();
      input.settings.opencode.lastConnectedAt = Date.now();
      input.settings.opencode.lastError = "";
      return { connected: info.connected, label: "OpenCode", errors: info.errors };
    },
    async disconnect(): Promise<void> {
      await backend.disconnect();
    },
    async listModels(): Promise<AgentModelInfo[]> {
      return await backend.listModels();
    },
    async listAgents() {
      return await backend.listAgents();
    },
    async hasNativeSession(sessionId: string): Promise<boolean> {
      return await backend.hasSession(sessionId);
    },
    async deleteNativeSession(sessionId: string): Promise<boolean> {
      return await backend.deleteSession(sessionId);
    },
    async runTask(task: AgentTaskInput): Promise<AgentTaskResult> {
      throwIfTaskAborted(task.abortSignal);
      const sources = task.sources ?? [];
      const parts = [
        { type: "text" as const, text: withResourcePrefix(task.prompt, task.resources) },
        ...sources
      ];
      const required = requiredModalities(parts);
      const selectedModel = selectOpenCodeModelForTask(
        await backend.listModels(),
        task.model?.providerId ?? input.settings.opencode.providerId,
        task.model?.modelId ?? input.settings.opencode.modelId,
        required
      );
      ensureOpenCodeModelSupportsFiles(selectedModel, parts);
      if (selectedModel) {
        input.settings.opencode.providerId = selectedModel.providerId;
        input.settings.opencode.modelId = selectedModel.modelId;
        input.settings.opencode.textEnabled = selectedModel.inputModalities.includes("text");
        input.settings.opencode.imageEnabled = selectedModel.inputModalities.includes("image");
        input.settings.opencode.pdfEnabled = selectedModel.inputModalities.includes("pdf");
      }
      const result = await backend.runCliTask({
        prompt: withResourcePrefix(task.prompt, task.resources),
        nativeSessionId: task.nativeSessionId,
        parts: sources,
        agent: input.settings.opencode.agent,
        ...(selectedModel ? { model: { providerId: selectedModel.providerId, modelId: selectedModel.modelId } } : {}),
        timeoutMs: task.timeoutMs,
        abortSignal: task.abortSignal,
        onRunId: task.onRunId
      });
      return {
        ...result,
        ...(selectedModel ? { effectiveModel: { providerId: selectedModel.providerId, modelId: selectedModel.modelId } } : {})
      };
    },
    async abort(runId: string): Promise<void> {
      await backend.abort(runId);
    }
  };
  // OpenCode 1.4 `opencode acp` starts an HTTP ACP server, not a stdio JSON-RPC process.
  // Keep the real OpenCode path on lifecycle events until EchoInk owns an HTTP ACP client.
  return createAgentEventRuntimeWithFallback(fallbackRuntime);
}

function createHermesTaskRuntime(input: AgentRuntimeFactoryInput): AgentTaskRuntime {
  const backend = new HermesBackend({ ...input.settings.agents.hermes, vaultPath: input.vaultPath });
  const fallbackRuntime: AgentTaskRuntime = {
    kind: "hermes",
    async connect(): Promise<AgentConnectionStatus> {
      const status = await backend.connect();
      input.settings.agents.hermes.lastConnectedAt = Date.now();
      input.settings.agents.hermes.lastError = "";
      if (status.version) input.settings.agents.hermes.version = status.version;
      return status;
    },
    async disconnect(): Promise<void> {
      await backend.disconnect();
    },
    async listModels(): Promise<AgentModelInfo[]> {
      return await backend.listModels();
    },
    async listAgents() {
      return await backend.listAgents();
    },
    async runTask(task: AgentTaskInput): Promise<AgentTaskResult> {
      const models = await backend.listModels();
      const selectedModel = task.model ?? selectAgentModel(models, input.settings.agents.hermes.providerId, input.settings.agents.hermes.modelId);
      if (selectedModel) {
        input.settings.agents.hermes.providerId = selectedModel.providerId;
        input.settings.agents.hermes.modelId = selectedModel.modelId;
      }
      return await backend.runTask({
        ...task,
        prompt: appendFilePartList(task.prompt, task.sources ?? []),
        ...(selectedModel ? { model: { providerId: selectedModel.providerId, modelId: selectedModel.modelId } } : {}),
        profile: task.profile ?? input.settings.agents.hermes.profile
      });
    },
    async abort(runId: string): Promise<void> {
      await backend.abort(runId);
    }
  };
  const richRuntime = acpRuntimeDisabled()
    ? undefined
    : new AcpAgentRuntime({
    backend: "hermes",
    command: {
      command: () => resolveHermesCommand(input.settings.agents.hermes.cliPath),
      args: () => ["acp"],
      cwd: input.vaultPath,
      env: input.settings.agents.hermes.apiKey.trim() ? { HERMES_API_KEY: input.settings.agents.hermes.apiKey.trim() } : undefined
    }
  });
  return createAgentEventRuntimeWithFallback(fallbackRuntime, richRuntime);
}

function withResourcePrefix(prompt: string, resources: AgentTaskInput["resources"]): string {
  return [
    resources?.promptPrefix ?? "",
    resources?.warnings?.length ? `资源提示：\n${resources.warnings.map((item) => `- ${item}`).join("\n")}` : "",
    prompt
  ].filter(Boolean).join("\n\n");
}

function throwIfTaskAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("Agent 任务已取消。");
}

function acpRuntimeDisabled(): boolean {
  return process.env.ECHOINK_DISABLE_ACP === "1";
}

function requiredModalities(parts: AgentPromptPart[]): AgentInputModality[] {
  const modalities = new Set<AgentInputModality>(["text"]);
  for (const part of parts) {
    if (part.type === "file") modalities.add(requiredModalityForMime(part.mime));
  }
  return Array.from(modalities);
}

function selectAgentModel(models: AgentModelInfo[], providerId: string, modelId: string): AgentModelInfo | null {
  const configured = models.find((model) => model.providerId === providerId && model.modelId === modelId);
  return configured ?? models[0] ?? null;
}

function appendFilePartList(prompt: string, parts: AgentPromptPart[]): string {
  const files = parts.filter((part) => part.type === "file");
  if (!files.length) return prompt;
  return [
    prompt,
    "",
    "## 附件路径",
    ...files.map((part) => `- ${part.path}`)
  ].join("\n");
}
