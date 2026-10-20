import * as path from "node:path";
import type { CodexForObsidianSettings } from "../settings/settings";
import type { EchoInkResource } from "../resources/types";
import type { CapabilityAccess } from "../membership/types";
import type { PiWorkspaceAccess } from "../harness/pi-native/pi-workspace-access";
import { normalizeObsidianCliRequest, obsidianCliCapabilityScope } from "../harness/pi-native/obsidian-cli-policy";
import { financeToolEffect, isFinanceTool, normalizeFinanceToolRequest, type PiFinanceToolId } from "../harness/pi-native/finance-tool-policy";
import { isPiTodoTool, normalizeTodoToolRequest, type PiTodoToolId } from "../harness/pi-native/todo-tool-policy";
import { GENERAL_ASSISTANT_ID, type AgentRunSnapshot } from "./types";
import * as core from "./capability-core";
import { DESKTOP_KNOWLEDGE_ROOT_ROLES } from "../knowledge-base/root-paths-core";
import type { AgentModuleCapability, AgentCapabilityDecision, AgentMcpCapabilityTarget } from "./capability-core";
export { AGENT_MODULE_CAPABILITIES, isAgentCapabilityPathField, vaultSkillCapabilityId, mcpToolCapabilityId, agentTaskSystemPrompt, requireAgentCapability } from "./capability-core";
export type { AgentModuleCapability, AgentCapabilityDecision, AgentMcpCapabilityTarget } from "./capability-core";

export interface AgentCapabilityContext {
  readonly settings: CodexForObsidianSettings;
  readonly agentId: string;
  readonly vaultRoot: string;
  readonly resources: readonly EchoInkResource[];
  readonly access?: Readonly<PiWorkspaceAccess> | null;
  readonly proAccess?: CapabilityAccess;
  /** Actual relocated module roots, including disabled modules. */
  readonly modulePaths?: Partial<Record<AgentModuleCapability, readonly string[]>>;
  readonly isRootJournalPath?: (value: string) => boolean;
}
function relativeTarget(context: AgentCapabilityContext, value: string): string | null {
  const clean = value.replaceAll("\\", "/");
  const relative = path.isAbsolute(clean) ? path.relative(context.vaultRoot, clean).replaceAll("\\", "/") : clean;
  return !relative || relative.startsWith("/") || /^[a-z]:/iu.test(relative) || relative.split("/").some(part => !part || part === "." || part === ".." || part.startsWith(".")) ? null : relative;
}
const toolAdapters: core.AgentCapabilityToolAdapters = {
  isTodoTool: isPiTodoTool,
  normalizeTodoToolRequest: (name, args) => { normalizeTodoToolRequest(name as PiTodoToolId, args); },
  isFinanceTool,
  financeEffect: (name, args) => financeToolEffect(name as PiFinanceToolId, normalizeFinanceToolRequest(name as PiFinanceToolId, args)),
  obsidianCli: args => { const request = normalizeObsidianCliRequest(args); return { request, scope: obsidianCliCapabilityScope(request) }; }
};
function inputs(context: AgentCapabilityContext): core.AgentCapabilityContext {
  return { ...context, relativeTarget: value => relativeTarget(context, value),
    resolvePath: value => path.resolve(context.vaultRoot, value), knowledgeRoles: DESKTOP_KNOWLEDGE_ROOT_ROLES, toolAdapters };
}
export function resolveAgentRunSnapshot(settings: CodexForObsidianSettings, agentId = GENERAL_ASSISTANT_ID): AgentRunSnapshot {
  return core.resolveAgentRunSnapshot(settings, agentId);
}
export function checkAgentCapability(context: AgentCapabilityContext, capabilityId: string, effect: "read" | "write" | "resource" = "read"): AgentCapabilityDecision {
  return core.checkAgentCapability(inputs(context), capabilityId, effect);
}
export function checkAgentSkill(context: AgentCapabilityContext, skillId: string): AgentCapabilityDecision {
  return core.checkAgentSkill(inputs(context), skillId);
}
export function checkAgentSkillPath(context: AgentCapabilityContext, value: string): AgentCapabilityDecision {
  return core.checkAgentSkillPath(inputs(context), value);
}
export function checkAgentTool(context: AgentCapabilityContext, toolName: string, args?: Readonly<Record<string, unknown>>, resolvedTarget?: unknown, mcp?: AgentMcpCapabilityTarget): AgentCapabilityDecision {
  return core.checkAgentTool(inputs(context), toolName, args, resolvedTarget, mcp);
}
