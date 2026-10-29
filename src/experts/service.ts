import type { DataAdapter } from "obsidian";
import type { AccountService } from "../membership/account-service";
import { MembershipNetworkError } from "../membership/network-error";
import { skillPluginVersionSupported, type SkillAuthorization } from "../membership/skill-delivery";
import { mobileAtomicFilePort } from "../mobile/finance-store";
import { sha256Hex } from "../utils/sha256";
import { MAX_EXPERT_OFFLINE_MS, MAX_EXPERT_PACKAGE_BYTES, parseExpertCatalog, parseExpertDelivery, parseExpertPackage,
  validExpertId, type ExpertCatalog, type ExpertDeliveryResponse, type ExpertMetadata, type ExpertPackageResponse, type ExpertLicense, type ExpertPlatform } from "./contracts";
import { buildExpertTransientPrompt, type ExpertPromptInput } from "./prompt";

export type ExpertDeliveryAccount = Pick<AccountService, "apiUrl" | "skillAuthorization" | "getExpertCatalog" | "getExpertPackage">;
export interface ExpertContentFiles {
  read(path: string): Promise<string | null>;
  write(path: string, content: string): Promise<void>;
}
export interface ResolvedExpertPackage {
  id: string; version: string; revision: string; meta: ExpertMetadata; summary: string; name: string;
  avatar: { kind: "custom"; mimeType: "image/webp" | "image/png"; dataUrl: string; width: 256; height: 256 };
  assertAvailable(): void;
  /** Return only for a transient private system context, never messages or persisted run reports. */
  buildTransientPrompt(input: ExpertPromptInput): string;
  /** Public licenses are the sole full texts exposed to the About UI. */
  licenseTexts(): ExpertLicense[];
}
interface CachePointer { scope: string; id: string; version: string; sha256: string; issuedAt: number; path: string }
interface CachedExpert { response: ExpertPackageResponse; path: string }
export type ExpertDeliveryState = { kind: "offline"; until: number } | { kind: "error"; message: string };

/** Shared across desktop, iPhone and iPad. Hidden bodies are never ordinary resources. */
export class ExpertContentService {
  private catalog: ExpertCatalog | null = null;
  private catalogAt = 0;
  private catalogOwner: ExpertDeliveryAccount | null | undefined;
  private catalogFlight: Promise<ExpertCatalog> | null = null;
  private resolutions = new Map<string, Promise<ResolvedExpertPackage>>();
  private readonly listeners = new Set<() => void>();
  private readonly states = new Map<string, { binding: string; value: ExpertDeliveryState }>();
  constructor(private readonly options: {
    files: ExpertContentFiles; cacheRoot: string; account(): ExpertDeliveryAccount | null | undefined;
    pluginVersion: string; platform: ExpertPlatform; now?: () => number;
  }) { safeExpertCachePath(options.cacheRoot); }
  private now(): number { return this.options.now?.() ?? Date.now(); }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private emit(): void { for (const listener of this.listeners) listener(); }
  hasRemoteAccess(): boolean { return !!this.options.account()?.skillAuthorization(); }
  catalogEntry(id: string): ExpertMetadata | undefined { return this.catalog?.experts.find(expert => expert.id === id); }
  compatible(metadata: ExpertMetadata): boolean {
    return metadata.platforms.includes(this.options.platform) && skillPluginVersionSupported(this.options.pluginVersion, metadata.minPluginVersion);
  }
  deliveryState(id: string): ExpertDeliveryState | null {
    const auth = this.options.account()?.skillAuthorization(), state = this.states.get(id);
    if (!auth || !state || state.binding !== `${auth.scope}:${auth.session}`) return null;
    return state.value.kind === "offline" && this.now() >= Math.min(state.value.until, auth.validUntil)
      ? { kind: "error", message: "专家缓存已到期，请联网重新下载。" } : state.value;
  }
  private setState(id: string, auth: SkillAuthorization, value: ExpertDeliveryState | null): void {
    const current = this.options.account()?.skillAuthorization();
    if (!current || current.scope !== auth.scope || current.session !== auth.session) return;
    const next = value ? { binding: `${auth.scope}:${auth.session}`, value } : undefined;
    if (JSON.stringify(this.states.get(id)) === JSON.stringify(next)) return;
    if (next) this.states.set(id, next); else this.states.delete(id);
    this.emit();
  }
  private async read(path: string): Promise<string | null> {
    const value = await this.options.files.read(safeExpertCachePath(path));
    if (value !== null && new TextEncoder().encode(value).length > MAX_EXPERT_PACKAGE_BYTES + 16384) throw new Error("专家缓存超过大小限制。");
    return value;
  }
  async publicCatalog(force = false): Promise<ExpertCatalog> {
    const account = this.options.account();
    if (this.catalogOwner !== account) { this.catalogOwner = account; this.catalog = null; this.catalogAt = 0; this.catalogFlight = null; }
    if (!force && this.catalog && this.now() - this.catalogAt < 5 * 60 * 1000) return this.catalog;
    if (this.catalogFlight) return this.catalogFlight;
    const file = `${this.options.cacheRoot}/catalog-${sha256Hex(account?.apiUrl ?? "disabled")}.json`;
    const flight = (async () => {
      if (!account) throw new Error("账号服务不可用，暂时无法加载专家。");
      let catalog: ExpertCatalog;
      try { catalog = await account.getExpertCatalog(); }
      catch (error) {
        // Public metadata may be retained offline. Never hide an online invalid response.
        if (!(error instanceof MembershipNetworkError)) throw error;
        const raw = await this.read(file);
        if (!raw) throw error;
        catalog = parseExpertCatalog(JSON.parse(raw) as unknown, account.apiUrl);
      }
      if (account !== this.options.account()) throw new Error("账号服务已切换，本次加载已取消。");
      await this.options.files.write(file, JSON.stringify(catalog));
      if (account !== this.options.account()) throw new Error("账号服务已切换，本次加载已取消。");
      this.catalog = catalog; this.catalogAt = this.now();
      return catalog;
    })().finally(() => { if (this.catalogFlight === flight) this.catalogFlight = null; });
    this.catalogFlight = flight;
    return flight;
  }
  async resolve(id: string): Promise<ResolvedExpertPackage> {
    if (!validExpertId(id)) throw new Error("专家标识无效。");
    const account = this.options.account(), auth = account?.skillAuthorization();
    if (!account || !auth) throw new Error("聘请和使用专家需要有效 PRO，请在账号与会员中启用本机。");
    const key = `${auth.scope}:${auth.session}:${id}`, existing = this.resolutions.get(key);
    if (existing) return existing;
    const flight = this.remote(id, account, auth).catch((error: unknown) => {
      this.setState(id, auth, { kind: "error", message: error instanceof Error ? error.message : "专家暂时不可用，请重试。" });
      throw error;
    }).finally(() => { if (this.resolutions.get(key) === flight) this.resolutions.delete(key); });
    this.resolutions.set(key, flight);
    return flight;
  }
  private assertAuthorization(account: ExpertDeliveryAccount, expected: SkillAuthorization): void {
    const current = account.skillAuthorization();
    if (account !== this.options.account() || !current || current.scope !== expected.scope || current.session !== expected.session
      || this.now() >= current.validUntil) throw new Error("账号、设备或授权已变化，本次专家已停止提供。");
  }
  private validCache(response: ExpertPackageResponse): boolean {
    const now = this.now();
    return now >= response.issuedAt - 300000 && now < response.issuedAt + Math.min(MAX_EXPERT_OFFLINE_MS, response.maxOfflineSeconds * 1000);
  }
  private base(scope: string, id: string, version: string, hash: string): string {
    return `${this.options.cacheRoot}/${sha256Hex(scope)}/${id}/${sha256Hex(version)}/${hash}`;
  }
  private pointer(scope: string, id: string): string { return `${this.options.cacheRoot}/${sha256Hex(scope)}/${id}/current.json`; }
  private async cached(id: string, auth: SkillAuthorization, account: ExpertDeliveryAccount): Promise<CachedExpert | null> {
    try {
      const raw = await this.read(this.pointer(auth.scope, id));
      if (!raw) return null;
      const pointer = JSON.parse(raw) as CachePointer;
      if (pointer.scope !== auth.scope || pointer.id !== id || typeof pointer.version !== "string" || typeof pointer.sha256 !== "string"
        || !/^[a-f0-9]{64}$/u.test(pointer.sha256) || pointer.path !== `${this.base(auth.scope, id, pointer.version, pointer.sha256)}-${pointer.issuedAt}.json`) return null;
      const body = await this.read(pointer.path);
      if (!body) return null;
      const response = parseExpertDelivery(JSON.parse(body) as unknown, id);
      if ("notModified" in response || response.version !== pointer.version || response.sha256 !== pointer.sha256 || response.issuedAt !== pointer.issuedAt) return null;
      parseExpertPackage(response, account.apiUrl);
      return { response, path: pointer.path };
    } catch { return null; }
  }
  private resolved(cache: CachedExpert, account: ExpertDeliveryAccount, auth: SkillAuthorization): ResolvedExpertPackage {
    const body = parseExpertPackage(cache.response, account.apiUrl);
    const assertAvailable = () => {
      this.assertAuthorization(account, auth);
      if (!this.validCache(cache.response)) throw new Error("专家缓存已到期，请联网重新下载。");
      if (!this.compatible(body)) throw new Error("请更新插件，或在支持的设备上使用此专家。");
    };
    assertAvailable();
    const { persona: _persona, skills: _skills, avatar, licenses: _licenses, schema: _schema, ...meta } = body;
    return {
      id: body.id, name: body.name, summary: body.summary, version: body.version, meta,
      revision: sha256Hex(`${body.version}\0${cache.response.sha256}`),
      avatar: { kind: "custom", mimeType: avatar.mimeType, dataUrl: `data:${avatar.mimeType};base64,${avatar.base64}`, width: 256, height: 256 },
      assertAvailable,
      buildTransientPrompt: input => { assertAvailable(); return buildExpertTransientPrompt(body, input); },
      licenseTexts: () => { assertAvailable(); return body.licenses.map(license => ({ ...license })); },
    };
  }
  private async remote(id: string, account: ExpertDeliveryAccount, auth: SkillAuthorization): Promise<ResolvedExpertPackage> {
    this.assertAuthorization(account, auth);
    const previous = await this.cached(id, auth, account);
    await this.publicCatalog(); this.assertAuthorization(account, auth);
    const metadata = this.catalogEntry(id);
    if (!metadata) throw new Error("此专家已不在当前目录中，请刷新后重试。");
    if (!this.compatible(metadata)) throw new Error("请更新插件，或在支持的设备上使用此专家。");
    let response: ExpertDeliveryResponse;
    try {
      response = await account.getExpertPackage(id, { pluginVersion: this.options.pluginVersion, platform: this.options.platform,
        ...(previous && this.validCache(previous.response) ? { knownVersion: previous.response.version } : {}) });
    } catch (error) {
      this.assertAuthorization(account, auth);
      if (!(error instanceof MembershipNetworkError) || !previous || !this.validCache(previous.response)) throw error;
      const resolved = this.resolved(previous, account, auth);
      this.setState(id, auth, { kind: "offline", until: Math.min(account.skillAuthorization()!.validUntil,
        previous.response.issuedAt + Math.min(MAX_EXPERT_OFFLINE_MS, previous.response.maxOfflineSeconds * 1000)) });
      return resolved;
    }
    this.assertAuthorization(account, auth);
    // AccountService validates too; verify again at the cache boundary, independent of its caller.
    response = parseExpertDelivery(response, id);
    if ("notModified" in response) {
      if (!previous || response.version !== previous.response.version || !this.validCache(previous.response)) throw new Error("专家缓存已到期，请重新下载完整包。");
      this.setState(id, auth, null);
      return this.resolved(previous, account, auth);
    }
    parseExpertPackage(response, account.apiUrl);
    if (!this.validCache(response)) throw new Error("专家包签发时间已过期或无效，旧版本已保留。");
    const path = `${this.base(auth.scope, id, response.version, response.sha256)}-${response.issuedAt}.json`;
    const serialized = JSON.stringify(response);
    await this.options.files.write(path, serialized); this.assertAuthorization(account, auth);
    if (await this.read(path) !== serialized) throw new Error("专家缓存写入失败，旧版本已保留。");
    this.assertAuthorization(account, auth);
    const pointer: CachePointer = { scope: auth.scope, id, version: response.version, sha256: response.sha256, issuedAt: response.issuedAt, path };
    await this.options.files.write(this.pointer(auth.scope, id), JSON.stringify(pointer));
    this.assertAuthorization(account, auth);
    this.setState(id, auth, null);
    return this.resolved({ response, path }, account, auth);
  }
}

export function safeExpertCachePath(value: string): string {
  const normalized = value.replace(/\\/gu, "/");
  if (!normalized || normalized !== normalized.trim() || normalized.startsWith("/") || /^[a-z]:/iu.test(normalized)
    || normalized.split("/").some(part => !part || part === "." || part === "..") || /(?:^|\/)resources\/skills(?:\/|$)/u.test(normalized)) throw new Error("专家缓存必须位于当前插件私有目录。");
  return normalized;
}
export function adapterExpertContentFiles(adapter: DataAdapter): ExpertContentFiles {
  return {
    read: path => mobileAtomicFilePort(adapter, safeExpertCachePath(path)).read(true),
    write: async (path, content) => {
      const port = mobileAtomicFilePort(adapter, safeExpertCachePath(path)), previous = await port.read();
      if (previous !== content) await port.write(content, previous);
    }
  };
}
