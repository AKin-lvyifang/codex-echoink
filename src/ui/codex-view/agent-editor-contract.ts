import type { AgentDefinition, AgentModuleId } from "../../agents/types";
import type { EchoInkResource } from "../../resources/types";
import type { CodexForObsidianSettings } from "../../settings/settings";

/** The editor only edits its draft; the plugin owns durable Agent/task changes. */
export interface AgentEditorHost {
  readonly settings: CodexForObsidianSettings;
  /** Stable plugin identity for data-only form drafts across View instances. */
  readonly draftCacheKey: object;
  loadResources(): Promise<readonly EchoInkResource[]>;
  /** Display only: global/module/PRO availability, never an authorization grant. */
  getCapabilityAvailability?(capabilityId: string): { available: boolean; reason?: string };
  saveAgent(agent: AgentDefinition, moduleIds: readonly AgentModuleId[]): Promise<void>;
  deleteAgent(agentId: string): Promise<void>;
  getDeleteCounts(agentId: string): Promise<{ total: number; running: number }>;
  onClose(agentId?: string): void;
}

/** AgentEditorController(host): open(agentId?: string), render(root), dispose(). */
