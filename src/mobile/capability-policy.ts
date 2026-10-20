import type { App } from "obsidian";
import { checkAgentSkill, checkAgentTarget, checkAgentTool, checkAgentCapability, resolveAgentRunSnapshot,
  type AgentCapabilityContext, type AgentCapabilityDecision, type AgentCapabilityToolAdapters } from "../agents/capability-core";
import { GENERAL_ASSISTANT_ID, type AgentRunSnapshot } from "../agents/types";
import type { KnowledgeFolderBindings } from "../knowledge-base/folder-bindings";
import { knowledgeSearchPathKind, VaultBodySearch, type KnowledgeBodySearchPort } from "../knowledge-base/vault-body-search";
import { FINANCE_BILINGUAL_ROOT, FINANCE_DEFAULT_ROOT, FINANCE_LEGACY_ROOT } from "../lifestyle/finance-paths";
import { PRO_CAPABILITIES, type CapabilityAccess } from "../membership/types";
import { sha256Hex } from "../utils/sha256";
import { BUILTIN_SKILLS } from "../harness/resources/builtin-skills";
import type { EchoInkResource } from "../resources/types";
import { loadMobileSettings, type MobileSettings } from "./settings";
import { mobileModuleEnabled } from "./module-settings";
import { mobileMcpAdmitted, mobileMcpToolName } from "./remote-tools";
import type { MobilePermission, MobileStore } from "./store";
import { PI_FINANCE_TOOL_IDS, isFinanceTool, normalizeFinanceToolRequest, financeToolEffect, type PiFinanceToolId } from "../harness/pi-native/finance-tool-policy";

const MOBILE_TOOLS = new Set(["task_update", "user_question", "vault_search", "note_read", "note_create", "memory_search", "memory_read", "memory_write", "web_search", ...PI_FINANCE_TOOL_IDS]);
const scopedPolicies = new WeakMap<KnowledgeBodySearchPort, MobileCapabilityPolicy>();
export function isScopedMobileBodySearch(port: KnowledgeBodySearchPort, policy: MobileCapabilityPolicy): boolean { return scopedPolicies.get(port) === policy; }
const toolAdapters: AgentCapabilityToolAdapters = {
  isTodoTool: () => false, normalizeTodoToolRequest: () => { throw new Error("mobile_tool_unavailable"); },
  isFinanceTool, financeEffect: (name, args) => financeToolEffect(name as PiFinanceToolId, normalizeFinanceToolRequest(name as PiFinanceToolId, args)),
  obsidianCli: () => { throw new Error("mobile_tool_unavailable"); }
};
function relativePath(value: string): string | null {
  return value && value === value.trim() && !value.startsWith("/") && !/[\\:]/u.test(value) && !Array.from(value).some(character => character.charCodeAt(0) < 32)
    && value.split("/").every(part => part && !part.startsWith(".")) ? value : null;
}
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function denied(capabilityId: string, reason: AgentCapabilityDecision["reason"]): AgentCapabilityDecision {
  return { allowed: false, capabilityId, reason };
}
const denialMessages: Record<AgentCapabilityDecision["reason"], string> = {
  allowed: "操作无法执行。",
  agent_missing: "当前 Agent 已不存在，请重新选择。",
  agent_disabled: "当前 Agent 未获准执行此操作。",
  module_disabled: "此功能已关闭，暂时无法执行。",
  pro_required: "此操作需要有效 PRO，已有资料仍可查看。",
  read_only: "当前为只读权限，未写入资料。",
  memory_disabled: "长期记忆已关闭。",
  resource_disabled: "此 Skill 或资源已停用。",
  scope_required: "操作范围尚未明确，请指定已授权的笔记。",
  unknown_resource: "此 Skill 或资源不存在或尚未接通。",
  unknown_tool: "此工具尚未接通，无法执行。",
  invalid_target: "目标不在当前允许范围内，请重新选择。"
};
/** Local UI receives useful copy; diagnostic consumers retain the exact shared failure code. */
export function requireMobileAgentCapability(result: AgentCapabilityDecision): void {
  if (!result.allowed) throw Object.assign(new Error(denialMessages[result.reason]), {
    code: `agent_capability_${result.reason}:${result.capabilityId}`, reason: result.reason, capabilityId: result.capabilityId
  });
}
function currentResources(settings: MobileSettings): EchoInkResource[] {
  const saved = settings.resources.catalog, skills = saved.filter(item => item.kind === "skill");
  const builtins: EchoInkResource[] = BUILTIN_SKILLS.map(skill => {
    const record = skills.find(item => item.id === skill.id || item.metadata?.resourceId === skill.id);
    return { ...record, id: record?.id ?? skill.id, kind: "skill", source: record?.source ?? "echoink-local",
      name: record?.name ?? skill.title, description: record?.description ?? skill.description, bridgeMode: record?.bridgeMode ?? "prompt-only",
      enabled: record?.enabled ?? settings.resources.legacyEnabledOverrides?.[skill.id] ?? true,
      metadata: { ...record?.metadata, resourceId: skill.id } };
  });
  return [...builtins, ...saved.filter(item => item.kind !== "skill" || !BUILTIN_SKILLS.some(skill => skill.id === item.id || skill.id === item.metadata?.resourceId))];
}
export interface MobileCapabilityPolicyOptions {
  readonly store: MobileStore;
  readonly settings: () => MobileSettings;
  readonly agentId: string;
  /** Frozen at run admission; subsequent permission increases do not widen this run. */
  readonly permission?: MobilePermission;
  readonly proAccess?: () => CapabilityAccess | undefined;
}

/** Current Agent grants intersect with run-frozen and live workspace permission. */
export class MobileCapabilityPolicy {
  private readonly permission: MobilePermission;
  constructor(private readonly options: MobileCapabilityPolicyOptions) {
    this.permission = options.permission ?? options.store.permission;
  }
  private inputs(): AgentCapabilityContext {
    const s = this.options.settings();
    return { settings: {
      agentRegistry: s.agentRegistry,
      // The mobile v2 switch is authoritative; preserved desktop settings are not a second switch.
      memory: { useLongTermMemory: this.options.store.memoryEnabled },
      lifestyle: { finance: { enabled: s.lifestyle.finance.enabled } }, pdfReading: { enabled: false }, englishDiary: { enabled: s.englishDiary.enabled },
      tavily: s.tavily, knowledgeBase: { folderBindings: s.knowledgeBase.folderBindings }
    }, agentId: this.options.agentId, resources: currentResources(s), proAccess: this.options.proAccess?.(),
    access: { permission: this.permission === "read-only" || this.options.store.permission === "read-only" ? "read-only" : "workspace-write",
      mode: "agent", memoryMode: this.options.store.memoryEnabled ? "default" : "no_memory" },
    moduleEnabled: { knowledge: mobileModuleEnabled(s, "knowledge-base"), journal: mobileModuleEnabled(s, "journal"),
      todos: mobileModuleEnabled(s, "todos"), review: s.review.enabled && mobileModuleEnabled(s, "review") },
    modulePaths: {
      journal: [s.journalDirectory].filter(Boolean),
      todos: ["EchoInk/待办.md"],
      finance: [FINANCE_DEFAULT_ROOT, FINANCE_BILINGUAL_ROOT, FINANCE_LEGACY_ROOT, s.lifestyle.finance.analysisDirectory].filter((path): path is string => !!path),
      "english-diary": [s.englishDiary.englishDirectory, s.englishDiary.expressionDirectory, ...(s.englishDiary.legacyEnglishDirectories ?? []),
        ...(s.englishDiary.legacyExpressionDirectories ?? []), "outputs/.english-diary", ".echoink/english-diary"],
      review: [s.review.outputDir]
    },
    isRootJournalPath: path => !!s.knowledgeBase.folderBindings?.roles.journal.native
      && !s.knowledgeBase.folderBindings.roles.journal.readPaths.length && /^\d{4}-\d{2}-\d{2}\.(?:md|markdown)$/u.test(path),
    relativeTarget: relativePath, resolvePath: value => relativePath(value) ?? "", toolAdapters };
  }
  snapshot(): AgentRunSnapshot { this.assertTool("task_update"); return resolveAgentRunSnapshot(this.options.settings(), this.options.agentId); }
  assertSkill(skillId: string): void {
    if (skillId === "obsidian-cli") requireMobileAgentCapability(denied(skillId, "unknown_tool"));
    requireMobileAgentCapability(checkAgentSkill(this.inputs(), skillId));
  }
  assertMcp(resourceId: string, toolName: string, args?: Readonly<Record<string, unknown>>): void {
    const connection = this.options.settings().resources.mcpConnections[resourceId], tool = connection?.tools.find(item => item.name === toolName);
    if (!connection || connection.transport !== "http" || !tool || !mobileMcpAdmitted(connection, toolName)) requireMobileAgentCapability(denied(resourceId, "resource_disabled"));
    if (connection?.transport !== "http" || !tool) return;
    if (connection.credential && !Object.keys(connection.headers ?? {}).some(key => key.toLowerCase() === connection.credential!.targetName.toLowerCase() && connection.headers?.[key])) {
      throw new Error("此 MCP 的电脑凭据不可在移动端读取，请填写认证请求头。");
    }
    requireMobileAgentCapability(checkAgentTool(this.inputs(), mobileMcpToolName(resourceId, toolName), args, undefined,
      { resourceId, toolName, readOnly: tool.readOnly, inputSchema: tool.inputSchema }));
  }
  assertTool(name: string, args?: Readonly<Record<string, unknown>>, resolvedTarget?: unknown): void {
    if (name.startsWith("mcp_")) {
      for (const [id, connection] of Object.entries(this.options.settings().resources.mcpConnections)) for (const tool of connection.tools ?? []) {
        if (mobileMcpToolName(id, tool.name) === name) { this.assertMcp(id, tool.name, args); return; }
      }
    }
    if (!MOBILE_TOOLS.has(name)) {
      requireMobileAgentCapability(denied(name, name.startsWith("pdf_") ? "module_disabled" : "unknown_tool"));
      return;
    }
    const context = this.inputs();
    if (name === "finance_record" && !args) { requireMobileAgentCapability(checkAgentCapability(context, "finance", "write")); return; }
    if (name === "vault_search") {
      // The scoped search port checks every candidate before any content is read.
      requireMobileAgentCapability(checkAgentTool(context, name));
      return;
    }
    if (name === "note_read" || name === "note_create") {
      const target = typeof resolvedTarget === "string" ? resolvedTarget
        : typeof object(resolvedTarget).path === "string" ? object(resolvedTarget).path as string
          : typeof args?.path === "string" ? args.path : undefined;
      if (target !== undefined) {
        requireMobileAgentCapability(checkAgentTool(context, name, { relativePath: target }));
        if (name === "note_read") this.assertReadPath(target);
      } else requireMobileAgentCapability(checkAgentTool(context, name));
      return;
    }
    requireMobileAgentCapability(checkAgentTool(context, name, args, resolvedTarget));
  }
  canReadPath(path: string): boolean {
    if (!relativePath(path) || knowledgeSearchPathKind(path, this.options.settings().knowledgeBase.folderBindings) === null) return false;
    return checkAgentTarget(this.inputs(), path, "read").allowed;
  }
  assertReadPath(path: string): void {
    const context = this.inputs();
    requireMobileAgentCapability(checkAgentTarget(context, path, "read"));
    if (knowledgeSearchPathKind(path, this.options.settings().knowledgeBase.folderBindings) === null) requireMobileAgentCapability(denied(path, "invalid_target"));
  }
  /** No credentials or prose: only effective authority and current path/resource ownership. */
  signature(): string {
    const input = this.inputs(), pro = input.proAccess;
    const { agentRegistry, ...modules } = input.settings;
    const agent = agentRegistry.agents.find(item => item.id === input.agentId);
    return sha256Hex(JSON.stringify([modules, agent ? { id: agent.id, capabilityIds: agent.capabilityIds, disabledCapabilityIds: agent.disabledCapabilityIds } : null,
      input.access, input.modulePaths, input.moduleEnabled, this.options.settings().resources.mcpConnections,
      input.agentId, input.resources.map(resource => [resource.id, resource.kind, resource.enabled, resource.metadata?.resourceId]),
      PRO_CAPABILITIES.map(capability => pro?.checkCapability(capability) === true)]));
  }
}

/** Compatibility callers have only sol's default grants and no paid entitlement. */
export function defaultMobileCapabilityPolicy(store: MobileStore, bindings: () => KnowledgeFolderBindings | null | undefined, sessionId: string): MobileCapabilityPolicy {
  const defaults = loadMobileSettings({});
  return new MobileCapabilityPolicy({ store, agentId: store.getSession(sessionId)?.agentId ?? GENERAL_ASSISTANT_ID,
    settings: () => ({ ...defaults, knowledgeBase: { ...defaults.knowledgeBase, folderBindings: bindings() ?? null } }) });
}

/** Filter candidate files before indexing. Revoked material never reaches the index or model. */
export function createScopedMobileBodySearch(app: App, bindings: () => KnowledgeFolderBindings | null | undefined,
  policy: MobileCapabilityPolicy, onJournalSearch?: () => void | Promise<void>): KnowledgeBodySearchPort {
  const scopedApp = {
    vault: {
      getMarkdownFiles: () => app.vault.getMarkdownFiles().filter(file => policy.canReadPath(file.path)),
      getAbstractFileByPath: (path: string) => { policy.assertReadPath(path); return app.vault.getAbstractFileByPath(path); },
      read: async (file: Parameters<App["vault"]["read"]>[0]) => {
        const signature = policy.signature();
        policy.assertReadPath(file.path);
        const content = await app.vault.read(file);
        policy.assertReadPath(file.path);
        if (signature !== policy.signature()) throw scopeChanged();
        return content;
      }
    },
    metadataCache: { getFileCache: (file: Parameters<App["metadataCache"]["getFileCache"]>[0]) => {
      policy.assertReadPath(file.path); return app.metadataCache?.getFileCache(file) ?? null;
    } },
    workspace: {
      getActiveFile: () => { const file = app.workspace?.getActiveFile(); return file && policy.canReadPath(file.path) ? file : null; },
      getLastOpenFiles: () => (app.workspace?.getLastOpenFiles?.() ?? []).filter(path => policy.canReadPath(path))
    }
  } as unknown as App;
  const body = new VaultBodySearch(scopedApp, bindings, { onJournalSearch });
  let signature = policy.signature();
  let disposed = false;
  const current = () => {
    if (disposed) throw Object.assign(new Error("Knowledge search disposed"), { code: "disposed" });
    const next = policy.signature();
    if (next !== signature) { signature = next; body.invalidate(); }
    return next;
  };
  const scoped: KnowledgeBodySearchPort = {
    allowsPath: path => { current(); return policy.canReadPath(path) && body.allowsPath(path); },
    scopeKey: () => { current(); return JSON.stringify([signature, body.scopeKey()]); },
    invalidate: path => body.invalidate(path),
    dispose: () => { if (!disposed) { disposed = true; body.dispose(); } },
    async search(request) {
      const before = current(); policy.assertTool("task_update");
      const found = await body.search(request);
      if (before !== current()) throw scopeChanged();
      found.hits.forEach(hit => policy.assertReadPath(hit.vaultRelativePath));
      return found;
    },
    async read(input) {
      const before = current(); policy.assertReadPath(input.vaultRelativePath);
      const source = await body.read(input);
      policy.assertReadPath(input.vaultRelativePath);
      if (before !== current()) throw scopeChanged();
      return source;
    }
  };
  scopedPolicies.set(scoped, policy);
  return scoped;
}
function scopeChanged(): Error { return Object.assign(new Error("Agent search scope changed"), { code: "source_changed" }); }
