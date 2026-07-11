import type { CodexForObsidianSettings } from "../settings/settings";
import type { PermissionMode } from "../types/app-server";
import { createAgentTaskRuntime } from "./factory";
import type { AgentEventSink } from "./events";
import { runAgentTaskWithToolBridge } from "./tool-bridge";
import type { AgentToolBridgeRuntime, PreparedAgentResources } from "./runtime";
import type { AgentBackendKind, AgentPromptPart, AgentTaskResult } from "./types";
import { swallowError } from "../core/error-handling";

export interface RunAgentTaskOnceInput {
  backend: Exclude<AgentBackendKind, "codex-cli">;
  settings: CodexForObsidianSettings;
  vaultPath: string;
  title: string;
  prompt: string;
  parts?: AgentPromptPart[];
  resources?: PreparedAgentResources;
  toolBridge?: AgentToolBridgeRuntime | null;
  permission?: PermissionMode;
  timeoutMs: number;
}

export async function runAgentTaskOnce(input: RunAgentTaskOnceInput): Promise<string> {
  const result = await runAgentTaskWithEvents(input, () => undefined);
  return result.text;
}

export async function runAgentTaskWithEvents(input: RunAgentTaskOnceInput, emit: AgentEventSink): Promise<AgentTaskResult> {
  const runtime = createAgentTaskRuntime({
    backend: input.backend,
    settings: input.settings,
    vaultPath: input.vaultPath
  });
  try {
    const taskInput = {
      prompt: input.prompt,
      sources: input.parts ?? [],
      resources: input.resources,
      toolBridge: input.toolBridge ?? null,
      permission: input.permission ?? "workspace-write",
      timeoutMs: input.timeoutMs,
      tools: {
        read: true,
        write: input.permission !== "read-only",
        edit: input.permission !== "read-only",
        bash: false
      }
    };
    return await runAgentTaskWithToolBridge(runtime, taskInput, emit);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (input.backend === "opencode") input.settings.opencode.lastError = message;
    if (input.backend === "hermes") input.settings.agents.hermes.lastError = message;
    throw error;
  } finally {
    await runtime.disconnect?.().catch(swallowError(`${input.backend} runtime disconnect cleanup`));
  }
}
