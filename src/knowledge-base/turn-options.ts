import * as path from "path";
import type { CodexForObsidianSettings } from "../settings/settings";
import type { CodexModel, PermissionMode } from "../types/app-server";
import type { TurnOptions } from "../core/codex-service";

export function buildCodexKnowledgeTurnOptions(input: {
  settings: Pick<CodexForObsidianSettings, "defaultModel" | "defaultReasoning" | "defaultServiceTier" | "mcpEnabled">;
  availableModels: Array<Pick<CodexModel, "model" | "isDefault">>;
  vaultPath: string;
  permission: PermissionMode;
  writeScope?: "knowledge-base" | "knowledge-lint" | "journal";
  overrides?: Pick<TurnOptions, "model" | "reasoning" | "serviceTier" | "mcpEnabled" | "workspaceResources">;
}): TurnOptions {
  const model = input.overrides?.model || input.settings.defaultModel || input.availableModels.find((item) => item.isDefault)?.model || input.availableModels[0]?.model || "";
  const writableRoots = input.permission === "workspace-write" ? writableRootsForScope(input.vaultPath, input.writeScope ?? "knowledge-base") : undefined;
  return {
    model,
    reasoning: input.overrides?.reasoning ?? input.settings.defaultReasoning,
    serviceTier: input.overrides?.serviceTier ?? input.settings.defaultServiceTier,
    permission: input.permission,
    mode: "agent",
    mcpEnabled: input.overrides?.mcpEnabled ?? input.settings.mcpEnabled,
    persistExtendedHistory: false,
    requestTimeoutMs: 60000,
    workspaceResources: input.overrides?.workspaceResources,
    ...(writableRoots ? { writableRoots } : {})
  };
}

function writableRootsForScope(vaultPath: string, scope: "knowledge-base" | "knowledge-lint" | "journal"): string[] {
  if (scope === "journal") {
    return [
      path.join(vaultPath, "journal"),
      path.join(vaultPath, "01-日记")
    ];
  }
  if (scope === "knowledge-lint") {
    return [
      path.join(vaultPath, "outputs")
    ];
  }
  return [
    path.join(vaultPath, "raw", "index.md"),
    path.join(vaultPath, "wiki"),
    path.join(vaultPath, "outputs"),
    path.join(vaultPath, "inbox"),
    path.join(vaultPath, "projects")
  ];
}
