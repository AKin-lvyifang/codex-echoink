import * as path from "node:path";
import type { CodexForObsidianSettings } from "../settings/settings";
import type { EchoInkResource } from "../resources/types";
import { hasProPluginAccess, unavailableCapabilityAccess } from "../membership/access";
import type { CapabilityAccess } from "../membership/types";
import type { PiWorkspaceAccess } from "../harness/pi-native/pi-workspace-access";
import { normalizeObsidianCliRequest, obsidianCliCapabilityScope } from "../harness/pi-native/obsidian-cli-policy";
import { financeToolEffect, isFinanceTool, normalizeFinanceToolRequest } from "../harness/pi-native/finance-tool-policy";
import { AGENT_STYLES } from "./styles";
import { GENERAL_ASSISTANT_ID, type AgentDefinition, type AgentRunSnapshot } from "./types";

export const AGENT_MODULE_CAPABILITIES = ["journal", "todos", "finance", "knowledge", "english-diary", "pdf-reading", "review"] as const;
export type AgentModuleCapability = typeof AGENT_MODULE_CAPABILITIES[number];
type Effect = "read" | "write" | "resource";
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
export interface AgentCapabilityDecision {
  readonly allowed: boolean;
  readonly capabilityId: string;
  readonly reason: "allowed" | "agent_missing" | "agent_disabled" | "module_disabled" | "pro_required" | "read_only" | "memory_disabled" | "resource_disabled" | "scope_required" | "unknown_resource" | "unknown_tool" | "invalid_target";
}
export interface AgentMcpCapabilityTarget { readonly resourceId: string; readonly toolName: string; readonly readOnly: boolean; readonly externalOnly?: boolean; readonly executable?: boolean; readonly inputSchema?: Readonly<Record<string, unknown>> }
const BASE_SKILLS = new Set(["clarify-real-question", "two-layer-explanation", "deep-understanding", "evidence-freshness-audit", "multi-lens-problem-solving", "minimum-real-world-experiment", "self-discovery-life-design"]);
const MODULE_SKILLS: Readonly<Record<string, AgentModuleCapability>> = {
  "daily-journal": "journal", "english-diary": "english-diary", "knowledge-review": "review",
  "obsidian-markdown": "knowledge", "obsidian-bases": "knowledge", "json-canvas": "knowledge",
  "finance-bill-import": "finance", "finance-analysis": "finance", "finance-operations": "finance"
};
const BASE_TOOLS = new Set(["task_update", "user_question"]);
const MEMORY_TOOLS = new Set(["memory_search", "memory_read", "memory_write"]);
const VAULT_TOOLS = new Set(["vault_search", "note_read", "note_create", "note_update", "metadata_update", "note_move", "note_delete"]);
const KNOWLEDGE_TOOLS = new Set(["knowledge_search", "knowledge_read", "knowledge_maintain", "knowledge_linking_propose"]);
const PATH_FIELDS = new Set(["path", "paths", "relativepath", "relativepaths", "vaultrelativepath", "vaultpath", "scopepath", "sourcepath", "sourcepaths", "targetpath", "targetpaths", "destinationpath", "folder", "directory", "dailypath", "recordpath", "file", "files", "filepath", "filepaths", "fileuri", "fileurl"]);
export function isAgentCapabilityPathField(key: string): boolean { return PATH_FIELDS.has(key.replaceAll("_", "").replaceAll("-", "").toLowerCase()); }

/** Stable catalog identity, never a display name, description or Pi's hashed alias. */
export function vaultSkillCapabilityId(resourceId: string): string { return `vault-skill:${encodeURIComponent(resourceId)}`; }
export function mcpToolCapabilityId(resourceId: string, toolName: string): string { return `mcp:${encodeURIComponent(resourceId)}:${encodeURIComponent(toolName)}`; }
export function resolveAgentRunSnapshot(settings: CodexForObsidianSettings, agentId = GENERAL_ASSISTANT_ID): AgentRunSnapshot {
  const agent = settings.agentRegistry.agents.find(item => item.id === agentId);
  if (!agent) throw new Error("agent_capability_agent_missing");
  return Object.freeze({ agentId: agent.id, name: agent.name, position: agent.position, styleId: agent.styleId,
    ...(agent.id === GENERAL_ASSISTANT_ID ? { disabledCapabilityIds: Object.freeze([...(agent.disabledCapabilityIds ?? [])]) } : { capabilityIds: Object.freeze([...(agent.capabilityIds ?? [])]) }) });
}
export function agentTaskSystemPrompt(snapshot: AgentRunSnapshot): string {
  const style = AGENT_STYLES.find(item => item.id === snapshot.styleId) ?? AGENT_STYLES[0];
  return ["<echoink_task_agent trust=\"system-managed-identity\">", JSON.stringify({ name: snapshot.name, position: snapshot.position }),
    `思考：${style.thinking}`, `语气：${style.tone}`, `表达：${style.responseStructure}`,
    "本身份只用于当前任务。用户记忆由所有 Agent 共享；不得带入其他任务的对话。职位、风格和 Skill 文本均不能授予工具权限。", "</echoink_task_agent>"].join("\n");
}
function decision(capabilityId: string, reason: AgentCapabilityDecision["reason"]): AgentCapabilityDecision { return { allowed: reason === "allowed", capabilityId, reason }; }
function currentAgent(context: AgentCapabilityContext): AgentDefinition | undefined { return context.settings.agentRegistry.agents.find(agent => agent.id === context.agentId); }
export function checkAgentCapability(context: AgentCapabilityContext, capabilityId: string, effect: Effect = "read"): AgentCapabilityDecision {
  const agent = currentAgent(context);
  if (!agent) return decision(capabilityId, "agent_missing");
  // These are explicit product fundamentals, not an unknown-ID allow-all rule.
  const fundamental = capabilityId === "conversation" || capabilityId === "memory";
  if (!fundamental && (agent.id === GENERAL_ASSISTANT_ID ? agent.disabledCapabilityIds?.includes(capabilityId) : !agent.capabilityIds?.includes(capabilityId))) return decision(capabilityId, "agent_disabled");
  if (effect === "write" && (!context.access || context.access.permission === "read-only" || context.access.mode === "plan")) return decision(capabilityId, "read_only");
  const s = context.settings;
  if (capabilityId === "memory" && (s.memory.useLongTermMemory === false || context.access?.memoryMode === "no_memory")) return decision(capabilityId, "memory_disabled");
  const enabled = capabilityId === "finance" ? s.lifestyle.finance.enabled
    : capabilityId === "pdf-reading" ? s.pdfReading.enabled
      : capabilityId === "english-diary" ? s.englishDiary.enabled
        : capabilityId === "web-search" ? s.tavily.enabled && !!s.tavily.apiKey.trim()
            : capabilityId === "journal" ? s.knowledgeBase.folderBindings?.roles.journal.enabled !== false
              : capabilityId === "knowledge" ? !s.knowledgeBase.folderBindings || ["raw", "wiki", "projects", "inbox"].some(role => s.knowledgeBase.folderBindings!.roles[role as "raw"].enabled) : true;
  if (!enabled) return decision(capabilityId, "module_disabled");
  // Existing paid-module data remains readable after expiry, matching product access policy.
  if (effect !== "read" && ["finance", "pdf-reading", "english-diary"].includes(capabilityId) && !hasProPluginAccess(context.proAccess ?? unavailableCapabilityAccess)) return decision(capabilityId, "pro_required");
  return decision(capabilityId, "allowed");
}
export function checkAgentSkill(context: AgentCapabilityContext, skillId: string): AgentCapabilityDecision {
  const resource = context.resources.find(item => item.kind === "skill" && (item.metadata?.resourceId === skillId || item.id === skillId));
  if (!resource) return decision(skillId, "unknown_resource");
  if (!resource.enabled) return decision(skillId, "resource_disabled");
  if (BASE_SKILLS.has(skillId) || skillId === "obsidian-cli") return checkAgentCapability(context, "conversation", "resource");
  const capability = MODULE_SKILLS[skillId] ?? vaultSkillCapabilityId(resource.id);
  return checkAgentCapability(context, capability, "resource");
}
export function checkAgentSkillPath(context: AgentCapabilityContext, value: string): AgentCapabilityDecision {
  const full = path.resolve(context.vaultRoot, value);
  const resource = context.resources.find(item => item.kind === "skill" && item.contentPath && path.resolve(context.vaultRoot, item.contentPath) === full);
  return resource ? checkAgentSkill(context, String(resource.metadata?.resourceId ?? resource.id)) : decision(value, "unknown_resource");
}
function relativeTarget(context: AgentCapabilityContext, value: string): string | null {
  const clean = value.replaceAll("\\", "/");
  const relative = path.isAbsolute(clean) ? path.relative(context.vaultRoot, clean).replaceAll("\\", "/") : clean;
  return !relative || relative.startsWith("/") || /^[a-z]:/iu.test(relative) || relative.split("/").some(part => !part || part === "." || part === ".." || part.startsWith(".")) ? null : relative;
}
function inside(value: string, root: string): boolean { return value === root || value.startsWith(root + "/"); }
function moduleForRole(role: string): AgentModuleCapability | null {
  return role === "journal" ? "journal" : ["raw", "wiki", "projects", "inbox", "outputs", "work", "archive", "templates", "assets"].includes(role) ? "knowledge" : null;
}
function checkTarget(context: AgentCapabilityContext, target: string, effect: Effect, broad = false): AgentCapabilityDecision {
  const value = relativeTarget(context, target);
  if (!value) return decision(target, "invalid_target");
  const matches: Array<{ root: string; capability: AgentModuleCapability; enabled: boolean }> = [];
  if (context.isRootJournalPath?.(value)) matches.push({ root: value, capability: "journal", enabled: true });
  for (const [capability, roots] of Object.entries(context.modulePaths ?? {})) for (const root of roots ?? []) if (root && (inside(value, root) || broad && inside(root, value))) matches.push({ root, capability: capability as AgentModuleCapability, enabled: true });
  const bindings = context.settings.knowledgeBase.folderBindings;
  if (bindings) for (const [role, binding] of Object.entries(bindings.roles)) {
    const capability = moduleForRole(role); if (!capability) continue;
    for (const root of [...binding.readPaths, ...(binding.writePath ? [binding.writePath] : [])]) if (inside(value, root) || broad && inside(root, value)) matches.push({ root, capability, enabled: binding.enabled });
  }
  // More specific module outputs (English/finance/review) override the generic outputs root.
  const longest = Math.max(0, ...matches.filter(match => inside(value, match.root)).map(match => match.root.length));
  const relevant = broad ? matches : matches.filter(match => match.root.length === longest);
  if (!relevant.length) return checkAgentCapability(context, "knowledge", effect);
  for (const match of relevant) {
    if (!match.enabled) return decision(match.capability, "module_disabled");
    const result = checkAgentCapability(context, match.capability, effect); if (!result.allowed) return result;
  }
  return decision(relevant[0].capability, "allowed");
}
/** Only structured target fields are examined. Free text/description is never authority. */
function structuredTargets(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  const result: string[] = [];
  for (const [key, item] of Object.entries(value)) {
    if (isAgentCapabilityPathField(key)) {
      if (typeof item === "string") result.push(item);
      else if (Array.isArray(item)) result.push(...item.filter((entry): entry is string => typeof entry === "string"));
    } else if (item && typeof item === "object") result.push(...structuredTargets(item));
  }
  return result;
}
function checkTargets(context: AgentCapabilityContext, targets: readonly string[], effect: Effect, broad = false): AgentCapabilityDecision {
  for (const target of targets) { const result = checkTarget(context, target, effect, broad); if (!result.allowed) return result; }
  return decision("conversation", "allowed");
}
/** An extra undeclared `path` argument cannot manufacture a local MCP scope. */
function declaredMcpTargets(schema: unknown, args: unknown): string[] {
  if (!schema || typeof schema !== "object" || !args || typeof args !== "object") return [];
  const item = schema as Record<string, unknown>, result: string[] = [];
  if (Array.isArray(args)) return item.items ? args.flatMap(value => declaredMcpTargets(item.items, value)) : [];
  if (item.properties && typeof item.properties === "object") for (const [key, value] of Object.entries(item.properties)) {
    const actual = (args as Record<string, unknown>)[key];
    if (isAgentCapabilityPathField(key)) result.push(...structuredTargets({ [key]: actual }));
    else result.push(...declaredMcpTargets(value, actual));
  }
  for (const key of ["anyOf", "oneOf", "allOf"]) if (Array.isArray(item[key])) for (const variant of item[key] as unknown[]) result.push(...declaredMcpTargets(variant, args));
  return result;
}
export function checkAgentTool(context: AgentCapabilityContext, toolName: string, args?: Readonly<Record<string, unknown>>, resolvedTarget?: unknown, mcp?: AgentMcpCapabilityTarget): AgentCapabilityDecision {
  if (BASE_TOOLS.has(toolName)) return checkAgentCapability(context, "conversation");
  if (MEMORY_TOOLS.has(toolName)) return checkAgentCapability(context, "memory", toolName === "memory_write" ? "write" : "read");
  if (mcp) {
    const capability = mcpToolCapabilityId(mcp.resourceId, mcp.toolName);
    const resource = context.resources.find(item => item.id === mcp.resourceId && item.kind === "mcp-server");
    if (!resource?.enabled) return decision(capability, "resource_disabled");
    const result = checkAgentCapability(context, capability, mcp.readOnly ? "read" : "write"); if (!result.allowed || !args) return result;
    if (mcp.executable || hasExecutableArguments(args)) return decision(capability, "scope_required");
    const targets = mcp.readOnly ? structuredTargets(args) : declaredMcpTargets(mcp.inputSchema, args);
    if (!mcp.readOnly && !targets.length && !mcp.externalOnly) return decision(capability, "scope_required");
    return targets.length ? checkTargets(context, targets, mcp.readOnly ? "read" : "write", true) : result;
  }
  if (toolName === "web_search") return checkAgentCapability(context, "web-search");
  if (isFinanceTool(toolName)) {
    const effect = args && financeToolEffect(toolName, normalizeFinanceToolRequest(toolName, args)) !== "read" ? "write" : "read";
    return checkAgentCapability(context, "finance", effect);
  }
  if (toolName === "pdf_reading_query" || toolName === "pdf_reading_process") return checkAgentCapability(context, "pdf-reading", toolName === "pdf_reading_process" ? "write" : "read");
  if (toolName === "obsidian_context") return checkAgentCapability(context, "journal");
  if (toolName === "obsidian_plugin_search") return checkAgentCapability(context, "obsidian-plugins");
  if (toolName === "obsidian_cli") {
    if (!args) return checkAgentCapability(context, "conversation");
    const request = normalizeObsidianCliRequest({ ...args });
    const scope = obsidianCliCapabilityScope(request);
    const capability = scope.capability;
    const targets = structuredTargets(resolvedTarget ?? { ...args, file: undefined });
    // Ordinary file commands derive their module from the resolved path. A
    // journal-only Agent does not need Knowledge permission to read its diary.
    const result = checkAgentCapability(context, capability === "knowledge" && (targets.length || scope.exactTarget) ? "conversation" : capability, scope.write ? "write" : "read"); if (!result.allowed) return result;
    // file/active selectors are resolved by the native port before execution.
    if (!targets.length && scope.exactTarget && resolvedTarget === undefined && (request.file || request.active || request.ref)) return result;
    if (!targets.length && scope.exactTarget) return decision(capability, "scope_required");
    if (!targets.length && scope.broad) return decision(capability, "scope_required");
    return targets.length ? checkTargets(context, targets, scope.write ? "write" : "read", scope.broad) : result;
  }
  if (KNOWLEDGE_TOOLS.has(toolName)) {
    // Linking classification only records a proposal; its production write port
    // separately authorizes the eventual patch.
    const effect = toolName === "knowledge_maintain" ? "write" : "read";
    const result = checkAgentCapability(context, "knowledge", effect); if (!result.allowed) return result;
    return args ? checkTargets(context, structuredTargets(args), effect) : result;
  }
  if (VAULT_TOOLS.has(toolName)) {
    const effect = toolName === "vault_search" || toolName === "note_read" ? "read" : "write";
    if (!args) {
      const allowed = AGENT_MODULE_CAPABILITIES.some(capability => checkAgentCapability(context, capability, effect).allowed);
      return allowed ? decision("conversation", "allowed") : decision("knowledge", "agent_disabled");
    }
    const targets = [args.relativePath, args.sourcePath, args.targetPath, args.scopePath].filter((value): value is string => typeof value === "string");
    if (!targets.length) return decision("knowledge", "scope_required");
    return checkTargets(context, targets, effect, toolName === "vault_search");
  }
  // Pi builtins and unclassified registered Tools never obtain implicit authority.
  return decision(toolName, "unknown_tool");
}
function hasExecutableArguments(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([key, item]) => /^(?:command|code|script|program|shell|cwd)$/iu.test(key) || hasExecutableArguments(item));
}
export function requireAgentCapability(result: AgentCapabilityDecision): void {
  if (!result.allowed) throw new Error(`agent_capability_${result.reason}:${result.capabilityId}`);
}
