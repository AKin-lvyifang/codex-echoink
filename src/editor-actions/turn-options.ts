import type { TurnOptions } from "../core/codex-service";
import type { WorkspaceResourceToggles } from "../settings/settings";
import type { ServiceTierChoice } from "../types/app-server";
import { DEFAULT_EDITOR_ACTION_MODEL } from "./types";

const EMPTY_RESOURCES: WorkspaceResourceToggles = { plugins: {}, mcpServers: {}, skills: {} };
export { DEFAULT_EDITOR_ACTION_MODEL };

export function resolveEditorActionModel(input: { configuredModel?: string; availableModels?: string[]; utilityModel: string }): string {
  const configuredModel = input.configuredModel?.trim() || DEFAULT_EDITOR_ACTION_MODEL;
  if (configuredModel) return configuredModel;
  const utilityModel = input.utilityModel.trim();
  if (utilityModel) return utilityModel;
  const availableModels = Array.from(new Set((input.availableModels ?? []).map((model) => model.trim()).filter(Boolean)));
  return availableModels[0] ?? "";
}

export function buildEditorActionTurnOptions(input: { model: string; serviceTier: ServiceTierChoice; timeoutMs?: number; workspaceResources?: WorkspaceResourceToggles }): TurnOptions {
  const requestTimeoutMs = normalizeEditorActionTimeout(input.timeoutMs);
  return {
    model: input.model,
    reasoning: "medium",
    serviceTier: input.serviceTier === "flex" ? "flex" : "fast",
    permission: "read-only",
    mode: "agent",
    mcpEnabled: false,
    persistExtendedHistory: false,
    requestTimeoutMs,
    workspaceResources: input.workspaceResources ?? EMPTY_RESOURCES
  };
}

function normalizeEditorActionTimeout(value: number | undefined): number {
  if (!Number.isFinite(value)) return 45000;
  return Math.max(10000, Math.min(300000, Math.round(value!)));
}
