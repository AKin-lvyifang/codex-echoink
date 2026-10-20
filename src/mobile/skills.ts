import type { DataAdapter } from "obsidian";
import { BUILTIN_SKILLS, renderBuiltinSkill } from "../harness/resources/builtin-skills";
import type { EchoInkResource } from "../resources/types";
import { sha256Hex } from "../utils/sha256";
import { skillIcon } from "../agents/skill-icons";
import { checkAgentSkill, type AgentCapabilityContext } from "../agents/capability-core";
import { mobileAtomicFilePort } from "./finance-store";
import type { MobileCapabilityPolicy } from "./capability-policy";
import type { MobileSettings } from "./settings";
import type { MobileSkillSnapshot, MobileSkillSummary } from "./capabilities-contracts";

const conflict = () => new Error("Skill 已在其他位置修改，请重新读取后再保存；编辑草稿已保留。");
function safePath(path: string): string {
  const normalized = path.replace(/\\/gu, "/");
  if (!normalized || normalized !== normalized.trim() || normalized.startsWith("/") || /^[a-z]:/iu.test(normalized) || [...normalized].some(char => char.charCodeAt(0) < 32)
    || normalized.split("/").some(part => !part || part === "." || part === "..")) throw new Error("Skill 正文路径必须位于当前笔记库内。");
  return normalized;
}
interface SkillEntry { id: string; name: string; description: string; enabled: boolean; builtin: boolean; content: string; path: string; resource?: EchoInkResource }
export class MobileSkillsService {
  private writes: Promise<unknown> = Promise.resolve();
  constructor(private adapter: DataAdapter, private settings: () => MobileSettings, private save: () => Promise<void>, _policy: (agentId: string) => MobileCapabilityPolicy) {}
  private serialize<T>(run: () => Promise<T>): Promise<T> { const pending = this.writes.then(run, run); this.writes = pending.catch(() => {}); return pending; }
  entries(): SkillEntry[] {
    const settings = this.settings(), saved = settings.resources.catalog.filter(item => item.kind === "skill");
    const builtin = BUILTIN_SKILLS.map(skill => {
      const resource = saved.find(item => item.id === skill.id || item.metadata?.resourceId === skill.id);
      return { id: skill.id, name: resource?.name || skill.title, description: resource?.description || skill.description, builtin: true,
        enabled: resource?.enabled ?? settings.resources.legacyEnabledOverrides?.[skill.id] ?? true, content: renderBuiltinSkill(skill),
        path: safePath(resource?.contentPath || `.echoink/resources/skills/${skill.id}/SKILL.md`), resource };
    });
    return [...builtin, ...saved.filter(resource => !BUILTIN_SKILLS.some(skill => skill.id === resource.id || skill.id === resource.metadata?.resourceId)).map(resource => {
      const id = resource.id;
      // Catalog identities need not be legal directory names; never derive a path from an unchecked ID.
      const fallback = /^[a-zA-Z0-9_-]+$/u.test(id) ? `.echoink/resources/skills/${id}/SKILL.md` : "";
      return { id, name: resource.name, description: resource.description, builtin: false, enabled: resource.enabled, content: "",
        path: resource.contentPath ? safePath(resource.contentPath) : fallback, resource };
    })];
  }
  private entry(id: string): SkillEntry { const found = this.entries().find(item => item.id === id); if (!found) throw new Error("此 Skill 不存在。"); return found; }
  private async raw(item: SkillEntry): Promise<string | null> { return item.path ? mobileAtomicFilePort(this.adapter, item.path).read(true) : null; }
  private configuredGrant(item: SkillEntry, agentId: string): boolean {
    const settings = this.settings();
    const resource: EchoInkResource = item.resource ?? { id: item.id, kind: "skill", source: "echoink-local", name: item.name,
      description: item.description, bridgeMode: "prompt-only", enabled: true, metadata: { resourceId: item.id } };
    // The detail page lists configured Agent ownership, even while a global
    // switch, entitlement, missing file, or platform prevents actual execution.
    // Keep the shared Skill -> Agent capability mapping authoritative.
    const context: AgentCapabilityContext = {
      settings: { agentRegistry: settings.agentRegistry, memory: { useLongTermMemory: true }, lifestyle: settings.lifestyle,
        pdfReading: { enabled: false }, englishDiary: settings.englishDiary, tavily: settings.tavily, knowledgeBase: settings.knowledgeBase },
      agentId, resources: [{ ...resource, enabled: true }],
      relativeTarget: () => null, resolvePath: value => value,
      toolAdapters: { isTodoTool: () => false, normalizeTodoToolRequest: () => {}, isFinanceTool: () => false,
        financeEffect: () => "read", obsidianCli: () => { throw new Error("Skill 授权展示不执行工具。"); } }
    };
    const decision = checkAgentSkill(context, item.id);
    return decision.allowed || decision.reason === "module_disabled" || decision.reason === "pro_required" || decision.reason === "read_only";
  }
  private async summary(item: SkillEntry): Promise<MobileSkillSummary> {
    const actualPath = item.path && await this.adapter.exists(item.path) ? item.path : item.path && await this.adapter.exists(`${item.path}.finance-replace-backup.json`) ? `${item.path}.finance-replace-backup.json` : null;
    const exists = actualPath !== null;
    const mobileAvailable = item.id !== "obsidian-cli" && (item.builtin || exists);
    return { id: item.id, name: item.name, description: item.description, builtin: item.builtin, enabled: item.enabled, icon: skillIcon(item.id),
      mobileAvailable, ...(!mobileAvailable ? { unavailableReason: item.id === "obsidian-cli" ? "此 Skill 仅在电脑运行；移动端可以查看和编辑。" : "Skill 正文尚未导入当前笔记库。" } : {}),
      contentPath: actualPath, sourceLabel: actualPath ?? (item.builtin ? "EchoInk 内置正文" : "正文尚未导入"),
      agents: this.settings().agentRegistry.agents.map(agent => {
        return { id: agent.id, name: agent.name, allowed: this.configuredGrant(item, agent.id) };
      }) };
  }
  async listSkills(): Promise<MobileSkillSummary[]> { return Promise.all(this.entries().map(item => this.summary(item))); }
  async readSkill(id: string): Promise<MobileSkillSnapshot> {
    const item = this.entry(id), raw = await this.raw(item);
    const content = raw ?? item.content;
    if (!content) throw new Error("Skill 正文尚未导入当前笔记库。");
    return { ...await this.summary(item), content, version: sha256Hex(JSON.stringify([item.path, raw, item.content])) };
  }
  defaultSkillContent(id: string): string | null { const builtin = BUILTIN_SKILLS.find(item => item.id === id); return builtin ? renderBuiltinSkill(builtin) : null; }
  saveSkill(id: string, content: string, version: string): Promise<MobileSkillSnapshot> {
    return this.serialize(async () => {
      if (!content.trim() || new TextEncoder().encode(content).length > 200_000) throw new Error("Skill 正文不能为空，且不能超过 200 KB。");
      if (content.startsWith("---\n")) {
        const end = content.indexOf("\n---", 4);
        if (end >= 0) {
          const frontId = /^id:\s*["']?([^\s"']+)["']?\s*$/mu.exec(content.slice(4, end))?.[1];
          if (frontId && frontId !== id || !content.slice(end + 4).trim()) throw new Error("Skill 的标识不能改变，且指令正文不能为空。");
        }
      }
      const before = await this.readSkill(id);
      if (before.version !== version) throw conflict();
      const item = this.entry(id), port = mobileAtomicFilePort(this.adapter, item.path), expected = await port.read();
      if ((await this.readSkill(id)).version !== version) throw conflict();
      await port.write(content, expected);
      if (await this.adapter.read(item.path) !== content) throw new Error("Skill 保存后核对失败，原稿与恢复备份已保留。");
      return this.readSkill(id);
    });
  }
  setSkillEnabled(id: string, enabled: boolean): Promise<MobileSkillSummary> {
    return this.serialize(async () => {
      const item = this.entry(id);
      if (enabled && !(await this.summary(item)).mobileAvailable) throw new Error("此 Skill 暂不能在移动端启用。");
      const settings = this.settings(), existing = item.resource;
      const resource: EchoInkResource = existing ? { ...existing, enabled } : { id, kind: "skill", source: "echoink-local", name: item.name,
        description: item.description, enabled, bridgeMode: "prompt-only", metadata: { resourceId: id } };
      if (existing) settings.resources.catalog[settings.resources.catalog.indexOf(existing)] = resource;
      else settings.resources.catalog.push(resource);
      try { await this.save(); }
      catch {
        const index = settings.resources.catalog.indexOf(resource);
        if (index >= 0 && resource.enabled === enabled) {
          if (existing) resource.enabled = existing.enabled;
          else if (JSON.stringify(resource) === JSON.stringify({ id, kind: "skill", source: "echoink-local", name: item.name, description: item.description, enabled, bridgeMode: "prompt-only", metadata: { resourceId: id } })) settings.resources.catalog.splice(index, 1);
        }
        throw new Error("Skill 启用状态保存失败，请重试。");
      }
      return this.summary(this.entry(id));
    });
  }
  /** One durable usage record for an actual admitted run; configuration reads never increment it. */
  recordUse(id: string): Promise<void> {
    return this.serialize(async () => {
      const item = this.entry(id), path = ".echoink/resources/skill-state.json";
      const port = mobileAtomicFilePort(this.adapter, path), raw = await port.read();
      let state: { schema: string; records: Record<string, Record<string, unknown>> };
      try { state = raw ? JSON.parse(raw) as typeof state : { schema: "echoink.skill-runtime.v1", records: {} }; }
      catch { throw new Error("Skill 使用状态不可读取，原文件已保留。"); }
      if (state?.schema !== "echoink.skill-runtime.v1" || !state.records || typeof state.records !== "object" || Array.isArray(state.records)) throw new Error("Skill 使用状态不可读取，原文件已保留。");
      const before = state.records[id], now = Date.now();
      if (before && (!Number.isSafeInteger(before.usageCount) || Number(before.usageCount) < 0)) throw new Error("Skill 使用状态不可读取，原文件已保留。");
      if (before) state.records[id] = { ...before, lastUsedAt: now, usageCount: Number(before.usageCount) + 1 };
      else {
        const content = (await this.readSkill(id)).content;
        state.records[id] = { id, origin: item.builtin ? "builtin" : "user", userModified: item.builtin && content !== item.content, createdAt: now,
          status: "active", statusChangedAt: now, contentHash: sha256Hex(content), semanticFingerprint: item.builtin ? sha256Hex(`builtin\u0000${id}`) : sha256Hex(content), triggerPhrases: [],
          lastUsedAt: now, usageCount: 1 };
      }
      await port.write(`${JSON.stringify(state, null, 2)}\n`, raw);
    });
  }
}
