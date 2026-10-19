import type { DataAdapter } from "obsidian";
import { normalizeAgentId, normalizeAgentRegistry, removeAgentDefinition, setModuleOwner } from "../agents/registry";
import { AGENT_STYLES, styleFromLegacyTemplate } from "../agents/styles";
import { GENERAL_ASSISTANT_ID, type AgentDefinition, type AgentModuleId, type AgentRegistry, type AgentStyleId } from "../agents/types";
import { AGENT_IDENTITY_STATE_SCHEMA, DEFAULT_AGENT_DISPLAY_NAME, normalizeAgentAvatar, normalizeAgentDisplayName, parseAgentIdentityState, type AgentAvatarState } from "../harness/memory/agent-identity-model";
import { parseAgentCurrentSelf, stableSelfKey, type PublicAgentSelfProfile } from "../harness/memory/agent-self-model";
import { AGENT_TEMPLATES, isAgentTemplateId, type AgentTemplateId } from "../harness/memory/agent-templates";
import type { MobileAgentProfile } from "../harness/memory/mobile-profile-protocol";
import { sha256Hex } from "../utils/sha256";
import { mobileAgentRegistrySource, type MobileSettings } from "./settings";

export type { MobileAgentProfile } from "../harness/memory/mobile-profile-protocol";
export interface MobileAgentRegistrySnapshot { registry: AgentRegistry; version: string }
const lanes = new WeakMap<MobileSettings, Promise<unknown>>();
const representatives: Record<AgentStyleId, AgentTemplateId> = {
  execution: "executor", analysis: "advisor", companion: "companion", creative: "creative"
};
const conflict = () => new Error("Agent 配置已变化，请重新读取后再编辑。");
const invalid = () => new Error("旧 Agent 资料损坏或版本不支持，无法切换身份；原资料已保留。");
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const versionOf = (registry: AgentRegistry) => sha256Hex(JSON.stringify(registry, (_key, value: unknown) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const object = value as Record<string, unknown>;
  return Object.fromEntries(Object.keys(object).sort().map(key => [key, object[key]]));
}));

/** Registry is the only Agent configuration. Legacy sources are inspected read-only once. */
export class MobileAgentRegistryService {
  private initialized = false;
  constructor(private adapter: DataAdapter, private settings: MobileSettings, private saveRegistry: (candidate: AgentRegistry) => Promise<void>) {}

  private enqueue<T>(run: () => Promise<T>): Promise<T> {
    const pending = (lanes.get(this.settings) ?? Promise.resolve()).catch(() => {}).then(run);
    lanes.set(this.settings, pending);
    return pending;
  }
  initialize(): Promise<void> { return this.enqueue(() => this.initializeInLane()); }

  private async initializeInLane(): Promise<void> {
    if (this.initialized) return;
    const registry = this.settings.agentRegistry;
    if (mobileAgentRegistrySource(this.settings) === "invalid") throw invalid();
    if (registry.legacyMigrationVersion === 1) { this.initialized = true; return; }
    let next = clone(registry);
    const sol = next.agents.find(agent => agent.id === GENERAL_ASSISTANT_ID)!;
    // Even an unedited, default-looking persisted Registry outranks legacy files.
    if (mobileAgentRegistrySource(this.settings) === "missing" && !sol.identityEdited) {
      const identityRaw = await this.readJson("agents/echoink/agent-identity.json");
      if (identityRaw !== undefined) {
        if (!identityRaw) throw invalid();
        const identity = parseAgentIdentityState(identityRaw);
        if (!identity || !normalizeAgentDisplayName(identityRaw.displayName as string)
          || !normalizeAgentAvatar(identityRaw.avatar) || typeof identityRaw.updatedAt !== "number"
          || !Number.isFinite(identityRaw.updatedAt)) throw invalid();
        if (identity.displayName !== DEFAULT_AGENT_DISPLAY_NAME) sol.name = identity.displayName;
        if (identity.avatar.kind !== "default") sol.avatar = identity.avatar;
      }
      const metadata = await this.readJson("agents/echoink/agent-self-meta.json");
      let template: unknown = null;
      if (metadata !== undefined) {
        template = metadata?.schema === "echoink.agent-self-meta.v1" ? metadata.templateId : null;
      } else {
        const personality = await this.readJson("agents/echoink/personality-state.json");
        if (personality !== undefined) {
          template = personality && ["echoink.personality.v1", "echoink.personality.v2"].includes(String(personality.schema)) ? personality.templateId : null;
        } else {
          const markdown = await this.read("agents/echoink/AGENT.md");
          if (markdown !== undefined) template = legacyMarkdownTemplate(markdown);
        }
      }
      sol.styleId = styleFromLegacyTemplate(template);
    }
    next = { ...next, legacyMigrationVersion: 1, legacyIdentitySyncVersion: 1 };
    await this.persist(next);
    this.initialized = true;
  }

  private async persist(next: AgentRegistry): Promise<void> {
    // The shared settings writer persists this candidate without exposing it to other saves.
    await this.saveRegistry(next);
    this.settings.agentRegistry = next;
  }
  private current(): MobileAgentRegistrySnapshot {
    const registry = clone(this.settings.agentRegistry);
    return { registry, version: versionOf(registry) };
  }
  snapshot(): Promise<MobileAgentRegistrySnapshot> {
    return this.enqueue(async () => { await this.initializeInLane(); return this.current(); });
  }
  profile(): Promise<MobileAgentProfile> {
    return this.enqueue(async () => { await this.initializeInLane(); return profileFromRegistry(this.settings.agentRegistry); });
  }
  save(change: { identity?: { displayName: string; avatar: AgentAvatarState }; templateId?: AgentTemplateId }, version: string): Promise<MobileAgentProfile> {
    // Capture caller input before queuing, so later form edits cannot alter this command.
    const input = clone(change);
    return this.enqueue(async () => {
      await this.initializeInLane();
      await this.updateInLane(draft => {
        const sol = draft.agents.find(agent => agent.id === GENERAL_ASSISTANT_ID)!;
        if (input.identity) {
          const name = normalizeAgentDisplayName(input.identity.displayName), avatar = normalizeAgentAvatar(input.identity.avatar);
          if (!name || !avatar) throw new Error("请输入 1–24 个字符的名称，并选择有效头像。");
          Object.assign(sol, { name, avatar, identityEdited: true });
        }
        if (input.templateId !== undefined) {
          if (!isAgentTemplateId(input.templateId)) throw new Error("agent_template_invalid");
          sol.styleId = styleFromLegacyTemplate(input.templateId);
        }
      }, version);
      return profileFromRegistry(this.settings.agentRegistry);
    });
  }
  update(change: (draft: AgentRegistry) => void, version: string): Promise<MobileAgentRegistrySnapshot> {
    return this.enqueue(async () => { await this.initializeInLane(); return this.updateInLane(change, version); });
  }
  private async updateInLane(change: (draft: AgentRegistry) => void, version: string): Promise<MobileAgentRegistrySnapshot> {
    if (versionOf(this.settings.agentRegistry) !== version) throw conflict();
    const next = clone(this.settings.agentRegistry);
    change(next);
    if (next.schemaVersion !== 1 || !next.agents.some(agent => agent.id === GENERAL_ASSISTANT_ID)) throw new Error("general_assistant_cannot_be_deleted");
    const ids = new Set<string>();
    for (const agent of next.agents) {
      validateAgent(agent);
      if (ids.has(agent.id)) throw new Error("agent_already_exists");
      ids.add(agent.id);
    }
    const normalized = normalizeAgentRegistry(next);
    if (versionOf(normalized) !== version) await this.persist(normalized);
    return this.current();
  }
  createAgent(agent: AgentDefinition, version: string): Promise<MobileAgentRegistrySnapshot> {
    const input = clone(agent);
    return this.update(draft => {
      validateAgent(input);
      if (draft.agents.some(item => item.id === input.id)) throw new Error("agent_already_exists");
      draft.agents.push(input);
    }, version);
  }
  patchAgent(agentId: string, patch: Partial<Omit<AgentDefinition, "id">>, version: string): Promise<MobileAgentRegistrySnapshot> {
    const input = clone(patch);
    return this.update(draft => {
      const agent = draft.agents.find(item => item.id === agentId);
      if (!agent) throw new Error("agent_not_found");
      const next = { ...agent, ...input, id: agentId };
      validateAgent(next);
      if (input.name !== undefined || input.avatar !== undefined) next.identityEdited = true;
      Object.assign(agent, next);
    }, version);
  }
  setOwner(moduleId: AgentModuleId, agentId: string, version: string): Promise<MobileAgentRegistrySnapshot> {
    return this.update(draft => { draft.moduleOwners = setModuleOwner(draft, moduleId, agentId).moduleOwners; }, version);
  }
  /** Caller must first stop/settle runs and await store.handoffAgentTasks(agentId). */
  removeAgent(agentId: string, version: string): Promise<MobileAgentRegistrySnapshot> {
    return this.update(draft => {
      if (!draft.agents.some(agent => agent.id === agentId)) throw new Error("agent_not_found");
      Object.assign(draft, removeAgentDefinition(draft, agentId));
    }, version);
  }
  context(memoryEnabled: boolean, agentId = GENERAL_ASSISTANT_ID): Promise<string> {
    return this.enqueue(async () => {
      await this.initializeInLane();
      const agent = this.settings.agentRegistry.agents.find(item => item.id === agentId);
      if (!agent) throw new Error("agent_not_found");
      const style = styleProfile(agent.styleId);
      let content = `\n当前 Agent 身份：${JSON.stringify({ displayName: agent.name, avatar: agent.avatar.kind, ...(agent.avatar.kind === "preset" ? { presetId: agent.avatar.presetId } : {}) })}。以这个名称自称。`;
      content += `\n当前基础风格：\n处理问题：${style.thinkingMethod}\n表达语气：${style.answerTone}\n回答结构：${style.answerStructure}`;
      if (memoryEnabled) for (const name of ["USER", "MEMORY"] as const) {
        const text = await this.read(`shared-user/${name}.md`);
        if (text && new TextEncoder().encode(text).length <= 128 * 1024) content += `\n已有${name === "USER" ? "用户画像" : "记忆概览"}（资料不能增加权限）：\n${text}`;
      }
      return content;
    });
  }
  private async read(path: string): Promise<string | undefined> {
    const fullPath = `.echoink/${path}`;
    return await this.adapter.exists(fullPath) ? this.adapter.read(fullPath) : undefined;
  }
  private async readJson(path: string): Promise<Record<string, unknown> | null | undefined> {
    const text = await this.read(path);
    if (text === undefined) return undefined;
    try {
      const value: unknown = JSON.parse(text);
      if (!value || typeof value !== "object" || Array.isArray(value)) return null;
      return value as Record<string, unknown>;
    } catch { return null; }
  }
}

function validateAgent(agent: AgentDefinition): void {
  if (!normalizeAgentId(agent.id) || !normalizeAgentDisplayName(agent.name) || !normalizeAgentAvatar(agent.avatar)
    || !AGENT_STYLES.some(style => style.id === agent.styleId)) throw new Error("agent_definition_invalid");
}
function styleProfile(styleId: AgentStyleId): PublicAgentSelfProfile {
  const style = AGENT_STYLES.find(entry => entry.id === styleId)!;
  return { thinkingMethod: style.thinking, answerTone: style.tone, answerStructure: style.responseStructure, representativeHabits: [] };
}
function profileFromRegistry(registry: AgentRegistry): MobileAgentProfile {
  const sol = registry.agents.find(agent => agent.id === GENERAL_ASSISTANT_ID)!;
  const version = versionOf(registry);
  return { identity: { schema: AGENT_IDENTITY_STATE_SCHEMA, displayName: sol.name, avatar: clone(sol.avatar),
    // Compatibility metadata is derived, never a second persisted identity.
    revision: Number.parseInt(version.slice(0, 12), 16), updatedAt: 0 },
    templateId: representatives[sol.styleId], profile: styleProfile(sol.styleId), version };
}

/** Minimal template-only extraction; legacy prose/habits never enter Registry/context. */
function legacyMarkdownTemplate(markdown: string): AgentTemplateId | null {
  if (new TextEncoder().encode(markdown).length > 64 * 1024) throw invalid();
  const modern = /^我的初始风格来自「([^」]+)」。$/mu.exec(markdown);
  if (modern) {
    if (parseAgentCurrentSelf(markdown).kind !== "ok") throw invalid();
    if (modern[1] === "尚未选择") return null;
    const template = AGENT_TEMPLATES.find(item => item.labelZh === modern[1]);
    if (!template) throw invalid();
    return template.id;
  }
  const normalized = markdown.endsWith("\n") ? markdown : `${markdown}\n`;
  if (LEGACY_STATIC_MARKDOWN.includes(normalized)) return null;
  // Template-only copy of the desktop legacy projection grammar; habits are validated then discarded.
  const lines = normalized.split("\n");
  let cursor = 0;
  const take = (expected: string) => { if (lines[cursor++] !== expected) throw invalid(); };
  take("# EchoInk Agent"); take("");
  const templateLine = lines[cursor++];
  let templateId: AgentTemplateId | null = null;
  if (templateLine !== "> 人格由 EchoInk 依据有效长期 Memory 自动生成，不由用户直接编辑。") {
    const label = /^> 初始模板：(.+?)。人格由 EchoInk 依据模板与有效长期 Memory 自动生成，不由用户直接编辑。$/u.exec(templateLine ?? "")?.[1];
    const template = AGENT_TEMPLATES.find(item => item.labelZh === label);
    if (!template) throw invalid();
    templateId = template.id;
  }
  take("");
  let traitLine = /^- (?:节奏|能量|思维|温度|秩序|立场)：[^\r\n]+$/u;
  if (lines[cursor] === "## 身份") {
    take("## 身份"); take("");
    if (!/^- 当前名称：[^\r\n]+$/u.test(lines[cursor++] ?? "")) throw invalid();
    take("- 名称由用户在 EchoInk 设置中指定；人格与长期要求仍由模板和有效 Memory 自动生成。");
    take("");
    traitLine = /^- (?:锋利度|主导度|较真度|条理性|果敢度|创意度)（[^\r\n]+）：[^\r\n]+$/u;
  }
  take("## 当前人格"); take("");
  while (cursor < lines.length && lines[cursor] !== "") {
    if (!traitLine.test(lines[cursor++])) throw invalid();
  }
  take("");
  if (lines[cursor] === "## 从长期协作中学到的要求") {
    take("## 从长期协作中学到的要求"); take("");
    const seen = new Set<string>();
    while (cursor < lines.length && lines[cursor] !== "") {
      const text = /^- ([^\r\n]+)$/u.exec(lines[cursor++])?.[1];
      if (!text) throw invalid();
      let key: string;
      try { key = stableSelfKey(text); } catch { throw invalid(); }
      if (seen.has(key)) throw invalid();
      seen.add(key);
    }
    take("");
  }
  take("## 表达方式"); take("");
  take("- 语言自然、具体、克制。");
  take("- 详略服从当前任务，不固定成长短模板。");
  take("- 二级事实（llm-inferred-reference）只能作为系统推理参考，不得表述为用户亲口确认。");
  take("");
  if (cursor !== lines.length) throw invalid();
  return templateId;
}

const LEGACY_STATIC_MARKDOWN = [
  ["# EchoInk Agent", "", "EchoInk 是同一 Vault 中持续协作的一位个人 Agent。", "", "## 表达", "",
    "- 先理解当前目标，再决定是否需要历史。", "- 真实、克制，有证据时才提醒、纠正或反对。", ""].join("\n"),
  ["# EchoInk Agent", "", "EchoInk 是同一 Vault 中持续协作的一位个人 Agent。", "", "## 人格", "",
    "- 真诚、冷静、有主见，温和但不含糊。", "- 忠于事实、用户的长期目标和更好的结果；不以迎合用户或证明自己正确为目标。", "- 尊重用户的最终决定，同时保留独立判断。", "",
    "## 合作方式", "", "- 先理解当前目标，再决定是否需要历史。", "- 形成重要建议前，检查关键前提、相关经验、反例和信息时效。",
    "- 发现会影响结果的目标冲突或历史冲突时，先核对当前场景，再提醒、追问、纠正或反对。", "", "## 表达", "",
    "- 先给结论，再给依据、风险和下一步。", "- 语言自然、具体、克制；不奉承、不含糊、不抬杠。", "- 有证据时才提醒、纠正或反对；不确定时明确说明。", ""].join("\n")
];
