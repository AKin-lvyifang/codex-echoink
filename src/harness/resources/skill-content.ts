export { SKILL_PRODUCT_RULES } from "./skill-rules";
import type { DataAdapter } from "obsidian";
import { mobileAtomicFilePort } from "../../mobile/finance-store";
import type { AccountService } from "../../membership/account-service";
import { MembershipNetworkError } from "../../membership/network-error";
import { MAX_SKILL_CONTENT_BYTES, MAX_SKILL_OFFLINE_MS, parseOfficialSkillCatalog, parseSkillDelivery,
  skillPluginVersionSupported, type OfficialSkillCatalog, type OfficialSkillCatalogEntry, type SkillAuthorization,
  type SkillContentResponse, type SkillDeliveryResponse, type SkillPlatform } from "../../membership/skill-delivery";
import { sha256Hex } from "../../utils/sha256";
import { getBuiltinSkillDefinition, isRemoteOnlySkill, REMOTE_ONLY_SKILL_IDS, renderBuiltinSkill, renderOfficialSkillPointer } from "./builtin-skills";
import { LEGACY_OFFICIAL_SKILL_HASHES } from "./legacy-official-skill-hashes";
import { parseVaultSkillDocument } from "./skill-document";

export type SkillDeliveryAccount = Pick<AccountService, "apiUrl" | "skillAuthorization" | "getSkillCatalog" | "getSkillContent">;
export interface SkillContentFiles {
  read(path: string): Promise<string | null>;
  write(path: string, content: string): Promise<void>;
  list(path: string): Promise<{ files: string[]; folders: string[] }>;
}
export interface ResolvedSkillContent {
  id: string; source: "builtin" | "official-remote" | "user";
  content: string; path: string; revision: string; version: string;
  runtimeHash?: string;
  /** Recheck authority, without fetching a different version during this run. */
  assertAvailable(): void;
}
interface CachedSkill extends SkillContentResponse { scope: string; path: string; runtimePath: string }
/** A single source/entitlement/version boundary used by all three devices. */
export class SkillContentResolver {
  private catalog: OfficialSkillCatalog | null = null;
  private catalogAt = 0;
  private catalogFlight: Promise<OfficialSkillCatalog | null> | null = null;
  private catalogOwner: SkillDeliveryAccount | null | undefined;
  private catalogFailure: unknown = null;
  private readonly resolutions = new Map<string, Promise<ResolvedSkillContent>>();
  private readonly denied = new Set<string>();
  constructor(private readonly options: {
    files: SkillContentFiles; cacheRoot: string; account(): SkillDeliveryAccount | null | undefined;
    pluginVersion: string; platform: SkillPlatform; now?: () => number;
  }) { safeSkillPath(options.cacheRoot); }
  private now(): number { return this.options.now?.() ?? Date.now(); }
  private root(): string { return this.options.cacheRoot; }
  private async read(path: string): Promise<string | null> {
    const value = await this.options.files.read(safeSkillPath(path));
    if (value !== null && new TextEncoder().encode(value).length > MAX_SKILL_CONTENT_BYTES + 16000) throw new Error("Skill 文件超过大小限制。");
    return value;
  }
  async publicCatalog(force = false): Promise<OfficialSkillCatalog | null> {
    const account = this.options.account();
    if (this.catalogOwner !== account) { this.catalogOwner = account; this.catalog = null; this.catalogAt = 0; this.catalogFlight = null; }
    if (!force && this.catalog && this.now() - this.catalogAt < 5 * 60 * 1000) return this.catalog;
    if (this.catalogFlight) return this.catalogFlight;
    const file = `${this.root()}/catalog-${sha256Hex(account?.apiUrl ?? "disabled")}.json`;
    const flight: Promise<OfficialSkillCatalog | null> = (async () => {
      try {
        if (!account) throw new Error("账号服务不可用。");
        const catalog = await account.getSkillCatalog();
        if (account !== this.options.account()) throw new Error("账号服务已切换。");
        await this.options.files.write(file, JSON.stringify(catalog));
        if (account !== this.options.account()) return null;
        this.catalog = catalog; this.catalogAt = this.now(); this.catalogFailure = null;
        return catalog;
      } catch (error) {
        if (account !== this.options.account()) return null;
        this.catalogFailure = error;
        const saved = await this.read(file);
        try { this.catalog = saved ? parseOfficialSkillCatalog(JSON.parse(saved) as unknown) : null; } catch { this.catalog = null; }
        this.catalogAt = this.now();
        return this.catalog;
      }
    })().finally(() => { if (this.catalogFlight === flight) this.catalogFlight = null; });
    this.catalogFlight = flight;
    return flight;
  }
  catalogEntry(id: string): OfficialSkillCatalogEntry | undefined { return this.catalog?.skills.find(item => item.id === id); }
  hasRemoteAccess(): boolean { return !!this.options.account()?.skillAuthorization(); }
  async isUserCopy(id: string, contentPath = skillLocalPath(id)): Promise<boolean> {
    const content = await this.read(contentPath);
    if (content === null) return false;
    const definition = getBuiltinSkillDefinition(id);
    if (!definition) return true;
    if (!isRemoteOnlySkill(id)) return content !== renderBuiltinSkill(definition);
    if (content !== renderOfficialSkillPointer(definition) && !LEGACY_OFFICIAL_SKILL_HASHES[id]?.includes(sha256Hex(content))) return true;
    // References/templates or any additional user file make this a user copy.
    const listing = await this.options.files.list(contentPath.slice(0, contentPath.lastIndexOf("/")));
    return listing.folders.length > 0 || listing.files.some(file => file.split("/").pop() !== "SKILL.md");
  }
  async migrateOfficialCopies(): Promise<void> {
    for (const id of REMOTE_ONLY_SKILL_IDS) {
      const target = skillLocalPath(id), raw = await this.read(target);
      if (raw === null || await this.isUserCopy(id)) continue;
      const pointer = renderOfficialSkillPointer(getBuiltinSkillDefinition(id)!);
      if (raw !== pointer) await this.options.files.write(target, pointer);
    }
  }
  async resolve(id: string, local?: { path?: string; content?: string }): Promise<ResolvedSkillContent> {
    const definition = getBuiltinSkillDefinition(id), localPath = local?.path || skillLocalPath(id);
    const raw = local?.content ?? await this.read(localPath);
    const userCopy = definition ? await this.isUserCopy(id, localPath) : true;
    const remote = isRemoteOnlySkill(id) || id === "knowledge-review" && this.hasRemoteAccess();
    if (remote && !userCopy) {
      const account = this.options.account(), auth = account?.skillAuthorization();
      if (!account || !auth) throw new Error("此 Skill 需要有效 PRO，请在账号与会员中启用本机。");
      const key = `${auth.scope}:${auth.session}:${id}`;
      const flight = this.resolutions.get(key);
      if (flight) return flight;
      const promise = this.remote(id, account, auth).catch((error: unknown): ResolvedSkillContent => {
        if (id !== "knowledge-review" || !(error instanceof MembershipNetworkError)) throw error;
        this.assertAuthorization(account, auth);
        const content = raw ?? renderBuiltinSkill(definition!);
        return { id, source: "builtin", content, path: localPath, revision: sha256Hex(content), version: "1.0.0", assertAvailable() {} };
      }).finally(() => { if (this.resolutions.get(key) === promise) this.resolutions.delete(key); });
      this.resolutions.set(key, promise);
      return promise;
    }
    const content = raw ?? (definition && !isRemoteOnlySkill(id) ? renderBuiltinSkill(definition) : "");
    if (!content.trim()) throw new Error("Skill 正文尚未导入当前笔记库。");
    const parsed = parseVaultSkillDocument(content, definition ? id : "user-skill");
    if (definition && parsed.frontmatter.id !== id || !parsed.instruction.trim()) throw new Error("Skill 正文身份或内容无效。");
    return { id, source: userCopy ? "user" : "builtin", content, path: localPath, revision: sha256Hex(content), version: parsed.frontmatter.version || "local", assertAvailable() {} };
  }
  private assertAuthorization(account: SkillDeliveryAccount, expected: SkillAuthorization): void {
    const current = account.skillAuthorization();
    if (this.options.account() !== account || !current || current.scope !== expected.scope || current.session !== expected.session) throw new Error("账号、设备或授权已变化，本次 Skill 已停止提供。");
  }
  private validCache(cache: CachedSkill): boolean {
    const now = this.now();
    return now >= cache.issuedAt - 300000 && now < cache.issuedAt + Math.min(MAX_SKILL_OFFLINE_MS, cache.maxOfflineSeconds * 1000);
  }
  private async cached(id: string, scope: string): Promise<CachedSkill | null> {
    try {
      const raw = await this.read(`${this.root()}/${scope}/${id}/current.json`);
      if (!raw) return null;
      const data = JSON.parse(raw) as CachedSkill;
      if (typeof data.version !== "string" || typeof data.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(data.sha256) || data.scope !== scope) return null;
      const base = `${this.root()}/${scope}/${id}/${sha256Hex(data.version)}/${data.sha256}`;
      if (data.path !== `${base}.md` || data.runtimePath !== `${base}-${data.issuedAt}-runtime.md`) return null;
      const content = await this.read(data.path);
      const response = parseSkillDelivery({ ...data, content }, id);
      if ("notModified" in response) return null;
      if (content !== response.content || sha256Hex(content) !== response.sha256) return null;
      return { ...response, scope, path: data.path, runtimePath: data.runtimePath };
    } catch { return null; }
  }
  private resolved(cache: CachedSkill, account: SkillDeliveryAccount, auth: SkillAuthorization): ResolvedSkillContent {
    const assertAvailable = () => {
      this.assertAuthorization(account, auth);
      if (this.denied.has(`${auth.scope}:${cache.id}`) || !this.validCache(cache)) throw new Error("Skill 缓存已到期或授权已失效，请联网重新下载。");
    };
    assertAvailable();
    return { id: cache.id, source: "official-remote", content: cache.content, path: this.runtimePath(cache, auth),
      revision: sha256Hex(`${cache.version}\0${cache.sha256}`), version: cache.version,
      runtimeHash: sha256Hex(renderRemoteSkillRuntimeDocument(cache.id, cache.content)), assertAvailable };
  }
  private async remote(id: string, account: SkillDeliveryAccount, auth: SkillAuthorization): Promise<ResolvedSkillContent> {
    this.assertAuthorization(account, auth);
    const deniedKey = `${auth.scope}:${id}`, previous = await this.cached(id, auth.scope);
    await this.publicCatalog(); this.assertAuthorization(account, auth);
    const metadata = this.catalogEntry(id);
    if (!metadata) {
      if (this.catalogFailure instanceof MembershipNetworkError) throw this.catalogFailure;
      throw new Error("无法读取官方 Skill 目录，请联网后重试。");
    }
    if (!metadata.platforms.includes(this.options.platform)) throw new Error("此 Skill 不支持当前设备。");
    if (!skillPluginVersionSupported(this.options.pluginVersion, metadata.minPluginVersion)) throw new Error("请更新插件后再使用此 Skill。");
    let response: SkillDeliveryResponse;
    try {
      response = await account.getSkillContent(id, { pluginVersion: this.options.pluginVersion, platform: this.options.platform,
        ...(previous && this.validCache(previous) && !this.denied.has(deniedKey) ? { knownVersion: previous.version } : {}) });
    } catch (error) {
      this.assertAuthorization(account, auth);
      if (error instanceof MembershipNetworkError && previous && !this.denied.has(deniedKey) && this.validCache(previous)) {
        await this.ensureRuntimeFile(previous, auth); this.assertAuthorization(account, auth);
        return this.resolved(previous, account, auth);
      }
      if (!(error instanceof MembershipNetworkError)) this.denied.add(deniedKey);
      throw error;
    }
    this.assertAuthorization(account, auth);
    if ("notModified" in response) {
      if (!previous || response.version !== previous.version || !this.validCache(previous)) throw new Error("Skill 缓存已到期，请重新下载完整正文。");
      this.denied.delete(deniedKey);
      await this.ensureRuntimeFile(previous, auth); this.assertAuthorization(account, auth);
      return this.resolved(previous, account, auth);
    }
    if (sha256Hex(response.content) !== response.sha256) throw new Error("Skill 正文校验失败，旧版本已保留。");
    const base = `${this.root()}/${auth.scope}/${id}/${sha256Hex(response.version)}/${response.sha256}`;
    const cached: CachedSkill = { ...response, scope: auth.scope, path: `${base}.md`, runtimePath: `${base}-${response.issuedAt}-runtime.md` };
    if (!this.validCache(cached)) throw new Error("Skill 签发时间已过期或无效，旧版本已保留。");
    await this.options.files.write(cached.path, cached.content);
    this.assertAuthorization(account, auth);
    if (await this.read(cached.path) !== cached.content) throw new Error("Skill 缓存写入失败，旧版本已保留。");
    await this.ensureRuntimeFile(cached, auth);
    this.assertAuthorization(account, auth);
    // The pointer is the last write, after verification. Existing versions are immutable.
    const { content: _content, ...metadataOnly } = cached;
    await this.options.files.write(`${this.root()}/${auth.scope}/${id}/current.json`, JSON.stringify(metadataOnly));
    this.assertAuthorization(account, auth);
    this.denied.delete(deniedKey);
    return this.resolved(cached, account, auth);
  }
  private runtimePath(cache: CachedSkill, auth: SkillAuthorization): string {
    return cache.runtimePath.replace(/-runtime\.md$/u, `-${sha256Hex(auth.session)}-runtime.md`);
  }
  private async ensureRuntimeFile(cache: CachedSkill, auth: SkillAuthorization): Promise<void> {
    const envelope = renderRemoteSkillRuntimeDocument(cache.id, cache.content);
    const target = this.runtimePath(cache, auth);
    if (await this.read(target) !== envelope) await this.options.files.write(target, envelope);
    if (await this.read(target) !== envelope) throw new Error("Skill 运行正文写入失败。");
  }
}

function renderRemoteSkillRuntimeDocument(id: string, content: string): string {
  const metadata = getBuiltinSkillDefinition(id)!;
  const parsed = parseVaultSkillDocument(content, id);
  if (parsed.frontmatter.id !== id || !parsed.instruction.trim()) throw new Error("官方 Skill 正文身份无效。");
  return ["---", `name: ${id}`, `description: ${JSON.stringify(metadata.description)}`, "---", "", parsed.instruction, ""].join("\n");
}

export function skillLocalPath(id: string): string {
  if (!/^[a-zA-Z0-9_-]+$/u.test(id)) throw new Error("Skill 标识无效。");
  return `.echoink/resources/skills/${id}/SKILL.md`;
}
export function safeSkillPath(value: string): string {
  const normalized = value.replace(/\\/gu, "/");
  if (!normalized || normalized !== normalized.trim() || normalized.startsWith("/") || /^[a-z]:/iu.test(normalized)
    || normalized.split("/").some(part => !part || part === "." || part === "..")) throw new Error("Skill 路径必须位于当前笔记库。");
  return normalized;
}
export function adapterSkillContentFiles(adapter: DataAdapter): SkillContentFiles {
  return {
    read: async file => mobileAtomicFilePort(adapter, safeSkillPath(file)).read(true),
    list: async folder => await adapter.exists(safeSkillPath(folder)) ? adapter.list(folder) : { files: [], folders: [] },
    write: async (file, content) => {
      const port = mobileAtomicFilePort(adapter, safeSkillPath(file)), previous = await port.read();
      try { if (previous !== content) await port.write(content, previous); }
      catch (error) {
        if (error instanceof Error && error.message.startsWith("财务资料已变化")) throw new Error("Skill 文件已变化，请重试。");
        throw error;
      }
    }
  };
}
