import * as path from "path";
import type { CodexForObsidianSettings } from "../settings/settings";
import type { CodexModel, PermissionMode } from "../types/app-server";
import type { TurnOptions } from "../core/codex-service";

export function buildCodexKnowledgeTurnOptions(input: {
  settings: Pick<CodexForObsidianSettings, "defaultModel" | "defaultReasoning" | "defaultServiceTier" | "mcpEnabled">;
  availableModels: Array<Pick<CodexModel, "model">>;
  vaultPath: string;
  permission: PermissionMode;
}): TurnOptions {
  const model = input.settings.defaultModel || input.availableModels[0]?.model || "gpt-5.5";
  const writableRoots = input.permission === "workspace-write"
    ? [
      path.join(input.vaultPath, "wiki"),
      path.join(input.vaultPath, "outputs"),
      path.join(input.vaultPath, "raw", "index.md")
    ]
    : undefined;
  return {
    model,
    reasoning: input.settings.defaultReasoning,
    serviceTier: input.settings.defaultServiceTier,
    permission: input.permission,
    mode: "agent",
    mcpEnabled: input.settings.mcpEnabled,
    persistExtendedHistory: false,
    requestTimeoutMs: 60000,
    ...(writableRoots ? { writableRoots } : {})
  };
}
