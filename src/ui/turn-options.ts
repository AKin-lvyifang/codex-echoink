import type { WorkspaceResourceToggles } from "../settings/settings";
import type {
  PermissionMode,
  ReasoningEffort,
  UiMode
} from "../types/app-server";

export interface TurnOptions {
  /** Independent, one-turn drawing intent; never a Skill. */
  drawingRequested?: boolean;
  cwd?: string;
  providerSettingsId: string;
  /** Runtime Provider identity frozen with this exact turn. */
  runtimeProviderId: string;
  model: string;
  developerInstructions?: string;
  ephemeral?: boolean;
  reasoning: ReasoningEffort;
  permission: PermissionMode;
  mode: UiMode;
  mcpEnabled: boolean;
  persistExtendedHistory?: boolean;
  requestTimeoutMs?: number;
  writableRoots?: string[];
  workspaceResources?: WorkspaceResourceToggles;
  externalResources?: "disabled";
}
