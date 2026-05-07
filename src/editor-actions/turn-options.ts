import type { TurnOptions } from "../core/codex-service";
import type { WorkspaceResourceToggles } from "../settings/settings";
import type { ServiceTierChoice } from "../types/app-server";
import { DEFAULT_EDITOR_ACTION_MODEL } from "./types";

const EMPTY_RESOURCES: WorkspaceResourceToggles = { plugins: {}, mcpServers: {}, skills: {} };
export { DEFAULT_EDITOR_ACTION_MODEL };

const EDITOR_ACTION_MODEL_PREFERENCE = [
  DEFAULT_EDITOR_ACTION_MODEL,
  "gpt-5.4",
  "gpt-5.5"
];

export function resolveEditorActionModel(input: { configuredModel?: string; availableModels?: string[]; fallbackModel: string; preferConfiguredWithoutAvailability?: boolean }): string {
  const configuredModel = input.configuredModel?.trim() || DEFAULT_EDITOR_ACTION_MODEL;
  const availableModels = Array.from(new Set((input.availableModels ?? []).map((model) => model.trim()).filter(Boolean)));
  if (!availableModels.length) return input.preferConfiguredWithoutAvailability ? configuredModel || input.fallbackModel : input.fallbackModel;
  if (availableModels.includes(configuredModel)) return configuredModel;
  for (const model of EDITOR_ACTION_MODEL_PREFERENCE) {
    if (availableModels.includes(model)) return model;
  }
  if (availableModels.includes(input.fallbackModel)) return input.fallbackModel;
  return availableModels[0] ?? input.fallbackModel;
}

export function buildEditorActionTurnOptions(input: { model: string; serviceTier: ServiceTierChoice; workspaceResources?: WorkspaceResourceToggles }): TurnOptions {
  return {
    model: input.model,
    reasoning: "medium",
    serviceTier: input.serviceTier === "flex" ? "flex" : "fast",
    permission: "read-only",
    mode: "agent",
    mcpEnabled: false,
    persistExtendedHistory: false,
    requestTimeoutMs: 25000,
    workspaceResources: input.workspaceResources ?? EMPTY_RESOURCES
  };
}
