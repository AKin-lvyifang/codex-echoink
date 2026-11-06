import type { WorkspaceResourceToggles } from "../settings/settings";
import type {
  PermissionMode,
  ReasoningEffort,
  UiMode
} from "../types/app-server";

export interface TurnOptions {
  /** Trusted company-origin turn; skips automatic Knowledge and Memory retrieval. */
  companyProgrammatic?: boolean;
  /** One live approval, never inherited by ordinary turns. */
  companyApprovalKey?: string;
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
