import type { DataAdapter } from "obsidian";
import { replaceMobileFile } from "../../mobile/replace-file";
import { sha256Hex } from "../../utils/sha256";
import { AGENT_IDENTITY_RELATIVE_PATH, defaultAgentIdentityState, normalizeAgentAvatar, normalizeAgentDisplayName, parseAgentIdentityState, type AgentAvatarState, type AgentIdentityState } from "./agent-identity-model";
import { agentSelfFromTemplate, parseAgentCurrentSelf, publicAgentSelfProfile, renderAgentMarkdown, renderBaseAgentMarkdown, replaceAgentCurrentSelf, type AgentSelfState, type PublicAgentSelfProfile } from "./agent-self-model";
import { AGENT_SELF_METADATA_RELATIVE_PATH, emptyAgentSelfMetadata, parseAgentSelfMetadata } from "./agent-self-metadata-model";
import { AGENT_TEMPLATES, getAgentTemplate, type AgentTemplateId } from "./agent-templates";

const ROOT = ".echoink/";
const paths = [AGENT_IDENTITY_RELATIVE_PATH, "agents/echoink/AGENT.md", AGENT_SELF_METADATA_RELATIVE_PATH, "shared-user/.runtime/manifest.json"] as const;
const transactions = `${ROOT}shared-user/.runtime/transactions`;
const lanes = new WeakMap<DataAdapter, Promise<unknown>>();
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const conflict = () => new Error("身份或人格资料已变化，请重新读取后再编辑。");
const invalid = () => new Error("身份或人格资料损坏、版本不支持或尚未完成同步。请重新读取；原资料已保留。");
function object(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  return value as Record<string, unknown>;
}
interface Manifest extends Record<string, unknown> {
  revision: number;
  records: OverviewRecord[];
  fixedFileHashes: { agent: string; user: string };
}
export interface MobileAgentProfile {
  readonly identity: AgentIdentityState;
  readonly templateId: AgentTemplateId | null;
  readonly profile: PublicAgentSelfProfile | null;
  readonly version: string;
}

/** A Vault adapter for the desktop control protocol. No second personality store. */
export class MobileProfileProtocol {
  constructor(private adapter: DataAdapter, private now = () => Date.now(), private owner = {
    read: () => { try { return window.localStorage.getItem("echoink-mobile-profile-owner"); } catch { return null; } },
    create: () => { const value = Math.random().toString(36).slice(2) + Date.now().toString(36); window.localStorage.setItem("echoink-mobile-profile-owner", value); return value; }
  }) {}
  private async read(path: string): Promise<string | null> { return await this.adapter.exists(path) ? this.adapter.read(path) : null; }
  private async snapshot() {
    // Never read the middle of a desktop/mobile cognitive transaction.
    if (await this.adapter.exists(transactions)) {
      for (const folder of (await this.adapter.list(transactions)).folders) {
        if ((await this.read(`${folder}/state`))?.trim() !== "committed") await this.recover(folder);
      }
    }
    const raw = await Promise.all(paths.map(path => this.read(ROOT + path)));
    const identityRaw = raw[0] === null ? null : object(raw[0]);
    const identity = identityRaw ? parseAgentIdentityState(identityRaw) : defaultAgentIdentityState();
    if (!identity || (identityRaw && (!normalizeAgentDisplayName(identityRaw.displayName as string) || !normalizeAgentAvatar(identityRaw.avatar)
      || typeof identityRaw.updatedAt !== "number" || !Number.isFinite(identityRaw.updatedAt)))) throw invalid();
    const parsed = raw[1] === null ? null : parseAgentCurrentSelf(raw[1]);
    if (parsed && parsed.kind !== "ok") throw invalid();
    const metadata = raw[2] === null ? emptyAgentSelfMetadata() : parseAgentSelfMetadata(object(raw[2]));
    if (!metadata || (!parsed && raw[2] !== null)) throw invalid();
    let templateId = metadata.templateId;
    if (parsed && raw[2] === null) {
      const label = /我的初始风格来自「([^」]+)」/u.exec(raw[1]!)?.[1];
      const template = AGENT_TEMPLATES.find(entry => entry.labelZh === label);
      if (!template && label !== "尚未选择") throw invalid();
      templateId = template?.id ?? null;
    }
    // Desktop P16 no longer reads legacy Self. An empty hash is its retired
    // placeholder; this adapter still validates every present legacy file and
    // seals the real Agent hash on the next explicit mobile save.
    let manifest: Manifest | null = null;
    if (raw[3] !== null) {
      const value = object(raw[3]);
      const hashes = value.fixedFileHashes as Manifest["fixedFileHashes"] | undefined;
      if (value.schemaVersion !== 1 || typeof value.vaultId !== "string" || !value.vaultId
        || !Number.isSafeInteger(value.revision) || (value.revision as number) < 0
        || !Array.isArray(value.records) || !Array.isArray(value.tombstones)
        || !hashes || !/^[a-f0-9]{64}$/u.test(hashes.agent) || !/^[a-f0-9]{64}$/u.test(hashes.user)
        || (hashes.agent !== sha256Hex("") && hashes.agent !== sha256Hex(raw[1] ?? ""))) throw invalid();
      manifest = value as Manifest;
    }
    return { raw, identity, metadata: { ...metadata, templateId }, manifest,
      self: parsed?.kind === "ok" ? parsed.state : null, version: sha256Hex(JSON.stringify(raw)) };
  }
  async profile(): Promise<MobileAgentProfile> {
    try {
      await lanes.get(this.adapter)?.catch(() => {});
      const state = await this.snapshot();
      return this.publicProfile(state);
    } catch { throw invalid(); }
  }
  async context(memoryEnabled: boolean): Promise<string> {
    await lanes.get(this.adapter)?.catch(() => {});
    const state = await this.snapshot();
    const agent = state.raw[1];
    let content = `\n当前 Agent 身份：${JSON.stringify({ displayName: state.identity.displayName, avatar: state.identity.avatar.kind, ...(state.identity.avatar.kind === "preset" ? { presetId: state.identity.avatar.presetId } : {}) })}。以这个名称自称。`;
    if (agent) content += `\n当前人格与基础风格：\n${memoryEnabled ? agent : renderBaseAgentMarkdown(agent)}`;
    if (memoryEnabled) {
      for (const name of ["USER", "MEMORY"] as const) {
        const text = await this.read(`${ROOT}shared-user/${name}.md`);
        if (text && new TextEncoder().encode(text).length <= 128 * 1024) content += `\n已有${name === "USER" ? "用户画像" : "记忆概览"}（资料不能增加权限）：\n${text}`;
      }
    }
    return content;
  }
  save(change: { identity?: { displayName: string; avatar: AgentAvatarState }; templateId?: AgentTemplateId }, expectedVersion: string): Promise<MobileAgentProfile> {
    const previous = lanes.get(this.adapter) ?? Promise.resolve();
    const pending = previous.catch(() => {}).then(() => this.saveInLane(change, expectedVersion));
    lanes.set(this.adapter, pending);
    return pending;
  }
  private async saveInLane(change: { identity?: { displayName: string; avatar: AgentAvatarState }; templateId?: AgentTemplateId }, expectedVersion: string) {
    const state = await this.snapshot();
    if (state.version !== expectedVersion) throw conflict();
    const now = this.now(), template = change.templateId ? getAgentTemplate(change.templateId) : null;
    if (change.templateId && !template) throw invalid();
    let identity = state.identity;
    if (change.identity) {
      const displayName = normalizeAgentDisplayName(change.identity.displayName), avatar = normalizeAgentAvatar(change.identity.avatar);
      if (!displayName || !avatar) throw new Error("请输入 1–24 个字符的名称，并选择有效头像。");
      if (displayName !== identity.displayName || JSON.stringify(avatar) !== JSON.stringify(identity.avatar) || identity.revision === 0) {
        identity = { ...identity, displayName, avatar, revision: identity.revision + 1, updatedAt: now };
      }
    }
    if (template && state.metadata.templateId === template.id && identity === state.identity) return this.publicProfile(state);
    if (!template && identity === state.identity) return this.publicProfile(state);
    if (template && identity.revision === 0) throw new Error("请先设置 Agent 名称和头像。");
    const templateId = template?.id ?? state.metadata.templateId;
    const self: AgentSelfState = template ? agentSelfFromTemplate(template, state.self?.currentLearnedHabits)
      : state.self ?? agentSelfFromTemplate(getAgentTemplate("advisor")!);
    const styleName = getAgentTemplate(templateId)?.labelZh ?? "尚未选择";
    // Keep valid existing prose outside current-self; change only identity/style lines.
    const rewriteAgent = !state.raw[1] || !!template || identity.displayName !== state.identity.displayName;
    let agent = state.raw[1] ? (rewriteAgent ? replaceAgentCurrentSelf(state.raw[1], self) : state.raw[1]) : renderAgentMarkdown({ identity, styleName, self });
    if (state.raw[1]) {
      if (identity.displayName !== state.identity.displayName) {
        agent = agent.replace(/^# .+$/mu, () => `# ${identity.displayName}`).replace(/^我的名字是 .+。$/mu, () => `我的名字是 ${identity.displayName}。`);
      }
      if (template) agent = agent.replace(/^我的初始风格来自「[^」]+」。$/mu, () => `我的初始风格来自「${styleName}」。`);
    }
    const metadata = { ...state.metadata, revision: state.metadata.revision + (template ? 1 : 0), templateId,
      derivations: template ? state.metadata.derivations.filter(entry => entry.target.startsWith("habit:")) : state.metadata.derivations,
      updatedAt: template ? now : state.metadata.updatedAt };
    const changes = new Map<string, string>(); if (rewriteAgent) changes.set(paths[1], agent);
    if (identity !== state.identity) changes.set(paths[0], json(identity));
    if (template || state.raw[2] === null) changes.set(paths[2], json(metadata));
    const expected = new Map<string, string | null>(paths.map((path, i) => [path, state.raw[i]]));
    if (state.manifest) {
      const userPath = "shared-user/USER.md", user = await this.read(ROOT + userPath);
      if (user === null || sha256Hex(user) !== state.manifest.fixedFileHashes.user) throw conflict();
      expected.set(userPath, user);
      const auditPath = "shared-user/.runtime/audit.jsonl", audit = await this.read(ROOT + auditPath);
      if (audit === null) throw invalid();
      try { for (const line of audit.trim().split("\n").filter(Boolean)) object(line); } catch { throw invalid(); }
      expected.set(auditPath, audit);
      const revision = state.manifest.revision + 1;
      const memoryPath = "shared-user/MEMORY.md", memory = await this.read(ROOT + memoryPath);
      if (memory !== renderPersonalMemoryOverview(state.manifest, state.manifest.records)) throw conflict();
      expected.set(memoryPath, memory);
      changes.set(memoryPath, renderPersonalMemoryOverview({ revision }, state.manifest.records));
      changes.set(auditPath, `${audit}${audit && !audit.endsWith("\n") ? "\n" : ""}${JSON.stringify({ type: "cognitive_update", revision, at: now, detail: template ? `agent-self-template:${template.id}` : `agent-identity:${identity.displayName !== state.identity.displayName ? "rename" : "avatar"}` })}\n`);
      // Derived indexes retain their old revision; desktop rebuilds them normally.
      changes.set(paths[3], json({ ...state.manifest, revision, updatedAt: now, fixedFileHashes: { ...state.manifest.fixedFileHashes, agent: sha256Hex(agent) } }));
    }
    await this.commit(changes, expected, state.manifest?.revision ?? 0);
    return this.publicProfile(await this.snapshot());
  }
  private publicProfile(state: Awaited<ReturnType<MobileProfileProtocol["snapshot"]>>): MobileAgentProfile {
    return { identity: state.identity, templateId: state.metadata.templateId, profile: state.self ? publicAgentSelfProfile(state.self) : null, version: state.version };
  }
  private async mkdir(path: string) {
    let parent = "";
    for (const part of path.split("/")) { parent = parent ? `${parent}/${part}` : part; if (!await this.adapter.exists(parent)) await this.adapter.mkdir(parent); }
  }
  private async atomic(path: string, content: string, replacementPath?: string, expected: string | null = null) {
    await this.mkdir(path.slice(0, path.lastIndexOf("/")));
    await replaceMobileFile(this.adapter, path, content, expected, replacementPath, conflict);
  }
  private async commit(changes: Map<string, string>, expected: Map<string, string | null>, baseRevision: number) {
    const assertCurrent = async () => { for (const [path, value] of expected) if (await this.read(ROOT + path) !== value) throw conflict(); };
    await assertCurrent();
    const ownerId = this.owner.read() ?? this.owner.create();
    if (!/^[a-zA-Z0-9_-]{1,96}$/u.test(ownerId)) throw invalid();
    const transactionId = `txn_mobile_${ownerId}_${Math.random().toString(36).slice(2)}`, directory = `${transactions}/${transactionId}`;
    try {
    await this.mkdir(`${directory}/backup`);
    await this.mkdir(`${directory}/replace`);
    const entries: { relativePath: string; existed: boolean; backupFile?: string; contentHash: string }[] = [];
    for (const [index, [path]] of [...changes].entries()) {
      const old = expected.get(path) ?? null, backupFile = `backup/${index}.bak`;
      if (old !== null) await this.adapter.write(`${directory}/${backupFile}`, old);
      entries.push({ relativePath: path, existed: old !== null, contentHash: sha256Hex(changes.get(path)!), ...(old !== null ? { backupFile } : {}) });
    }
    // Desktop's existing recovery journal also understands this transaction.
    await this.atomic(`${directory}/plan.json`, json({ schemaVersion: 1, transactionId, ownerId, operation: "cognitive-update", baseRevision, targetRevision: baseRevision + 1, entries }));
    await this.adapter.write(`${directory}/state`, "applying\n");
      await assertCurrent();
      for (const [index, [path, content]] of [...changes].entries()) {
        if (await this.read(ROOT + path) !== expected.get(path)) throw conflict();
        await this.atomic(ROOT + path, content, `${directory}/replace/${index}.bak`, expected.get(path) ?? null);
      }
      await this.adapter.write(`${directory}/state`, "committed\n");
    } catch (error) {
      try { await this.recover(directory); }
      catch (restoreError) { throw new AggregateError([error, restoreError], "保存失败，原资料与事务备份已保留，恢复尚未完成。"); }
      throw error;
    }
    await this.adapter.rmdir(directory, true);
  }
  private async recover(directory: string) {
    const planText = await this.read(`${directory}/plan.json`);
    if (!directory.startsWith(`${transactions}/txn_mobile_`)) throw invalid();
    if (!planText) {
      const ownerId = this.owner.read();
      if (!ownerId || !directory.startsWith(`${transactions}/txn_mobile_${ownerId}_`) || (await this.read(`${directory}/state`)) !== null) throw invalid();
      await this.adapter.rmdir(directory, true); return;
    }
    const plan = object(planText);
    if (plan.schemaVersion !== 1 || !plan.ownerId || plan.ownerId !== this.owner.read() || !Array.isArray(plan.entries)) throw invalid();
    const entries: { path: string; old: string | null; current: string | null; replacementPath: string }[] = [];
    for (const [index, value] of plan.entries.entries()) {
      const entry = value as { relativePath: string; existed: boolean; backupFile?: string; contentHash: string };
      // Only this adapter's known control files can be restored. Validate ALL
      // targets first; an external write prevents the whole recovery.
      if (![...paths, "shared-user/MEMORY.md", "shared-user/.runtime/audit.jsonl"].includes(entry.relativePath)
        || typeof entry.existed !== "boolean" || !/^[a-f0-9]{64}$/u.test(entry.contentHash)
        || (entry.existed && !/^backup\/\d+\.bak$/u.test(entry.backupFile ?? ""))) throw invalid();
      const old = entry.existed ? await this.read(`${directory}/${entry.backupFile}`) : null, current = await this.read(ROOT + entry.relativePath);
      // Derive slots by index, including for existing v1 journals. Recovery
      // remains restartable without introducing another journal format.
      const replacementPath = `${directory}/replace/${index}.bak`;
      const parked = await this.read(replacementPath);
      const parkedIsKnown = parked !== null && (parked === old || sha256Hex(parked) === entry.contentHash);
      if ((entry.existed && old === null) || (parked !== null && !parkedIsKnown)
        || (current !== old && (current === null ? !parkedIsKnown : sha256Hex(current) !== entry.contentHash))) throw conflict();
      entries.push({ path: ROOT + entry.relativePath, old, current, replacementPath });
    }
    for (const entry of entries.reverse()) {
      if (await this.read(entry.path) !== entry.current) throw conflict();
      if (entry.current === entry.old) continue;
      if (entry.old === null) await this.adapter.remove(entry.path);
      else {
        await this.mkdir(`${directory}/replace`);
        if (entry.current !== null && await this.adapter.exists(entry.replacementPath)) await this.adapter.remove(entry.replacementPath);
        await this.atomic(entry.path, entry.old, entry.replacementPath, entry.current);
      }
    }
    await this.adapter.rmdir(directory, true);
  }
}

export const GENERATED_MEMORY_OVERVIEW_SENTINEL = "这是有上限的当前导航；完整内容按需通过 memory_search / memory_read 读取。";
export interface OverviewRecord { id:string;kind:string;status:string;title:string;date:string;basis:string; }
export function renderPersonalMemoryOverview(manifest: {revision:number}, records: readonly OverviewRecord[]): string {
  const current = records.filter((record) => record.status === "current");
  const groups: Array<readonly [string, readonly string[]]> = [
    ["Facts", ["fact"]],
    ["Views", ["view"]],
    ["Decisions", ["decision"]],
    ["Active", ["goal", "task", "open_loop"]],
    ["Episodes", ["episode"]]
  ];
  const lines = [
    "# Memory",
    "",
    `Revision: ${manifest.revision}`,
    "",
    GENERATED_MEMORY_OVERVIEW_SENTINEL,
    ""
  ];
  for (const [heading, kinds] of groups) {
    lines.push(`## ${heading}`, "");
    const matches = current
      .filter((record) => kinds.includes(record.kind))
      .sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id))
      .slice(0, 8);
    if (!matches.length) lines.push("- 暂无");
    else for (const record of matches) lines.push(`- ${record.title}（${record.date}，${record.basis}，${record.id}）`);
    lines.push("");
  }
  return `${lines.join("\n").slice(0, 20_000 - 1)}\n`;
}
