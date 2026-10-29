import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import path from "node:path";
import { AccountService, MembershipApiError, type MembershipTransport } from "../membership/account-service";
import { MembershipNetworkError } from "../membership/network-error";
import { deviceIdentity, encode, keyHash } from "../membership/crypto";
import { PRO_CAPABILITIES, type LeaseClaims, type LocalAccountState, type MembershipStorage } from "../membership/types";
import { REMOTE_SKILL_IDS, type OfficialSkillCatalog } from "../membership/skill-delivery";
import { sha256Hex } from "../utils/sha256";
import { SkillContentResolver, type SkillContentFiles, type SkillDeliveryAccount } from "../harness/resources/skill-content";

export const skillFixtureCatalog: OfficialSkillCatalog = { catalogVersion: "fixture-1", skills: REMOTE_SKILL_IDS.map(id => ({
  id, name: id, nameEn: id, summary: `Public summary for ${id}`, summaryEn: `Public summary for ${id}`,
  tier: "pro", variant: id === "knowledge-review" ? "enhanced" : "full", version: "fixture-1", minPluginVersion: "2.8.7",
  platforms: ["desktop", "ios", "android"], compareUrl: "https://example.test/skill-comparison"
})) };

export function nodeSkillFiles(root: string): SkillContentFiles {
  return {
    read: async target => { try { return await readFile(path.join(root, target), "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; } },
    write: async (target, content) => { await mkdir(path.dirname(path.join(root, target)), { recursive: true }); await writeFile(path.join(root, target), content, "utf8"); },
    list: async target => { try { const entries = await readdir(path.join(root, target), { withFileTypes: true }); return {
      files: entries.filter(entry => entry.isFile()).map(entry => `${target}/${entry.name}`), folders: entries.filter(entry => entry.isDirectory()).map(entry => `${target}/${entry.name}`) };
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { files: [], folders: [] }; throw error; } }
  };
}

/** For pre-existing routing/lifecycle tests: remote text is a synthetic marker, never the removed methodology. */
export function routingFixtureResolver(root: string): SkillContentResolver {
  const account: SkillDeliveryAccount = {
    apiUrl: "https://fixture.invalid", skillAuthorization: () => ({ scope: "a".repeat(64), session: "fixture-1", validUntil: Date.now() + 86400000 }),
    getSkillCatalog: async () => structuredClone(skillFixtureCatalog),
    getSkillContent: async id => { const content = `# Remote fixture\n\nSYNTHETIC:${id}`; return { id, version: "fixture-1", content, sha256: sha256Hex(content), issuedAt: Date.now(), maxOfflineSeconds: 604800 }; }
  };
  return new SkillContentResolver({ files: nodeSkillFiles(root), cacheRoot: ".fixture-config/plugins/codex-echoink/skill-cache", account: () => account, pluginVersion: "2.8.8", platform: "desktop" });
}

/** Real AccountService, ES256 proof and signed leases behind an in-memory HTTP contract. */
export async function createSkillAccountFixture(options: { pro?: boolean; bound?: boolean } = {}) {
  let now = Date.parse("2026-10-28T12:00:00Z"), pro = options.pro ?? true, bound = options.bound ?? true, offline = false;
  let version = "fixture-1", corrupt = false, refusal: string | null = null;
  let blocked: (() => Promise<void>) | null = null;
  const signer = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const keys = [{ kid: "skill-fixture", alg: "ES256", publicKey: await crypto.subtle.exportKey("jwk", signer.publicKey) }];
  const identity = await deviceIdentity();
  const account = (id: string) => ({ id, email: `${id}@example.test`, name: id, joinedAt: "2026-10-28", avatar: null, passwordSet: true });
  let saved: LocalAccountState = { token: "synthetic-A", account: account("synthetic-A") };
  const storage: MembershipStorage = { persistent: true, read: async () => structuredClone(saved), write: async value => { saved = structuredClone(value); }, identity: async () => identity };
  const calls: { path: string; body: unknown; authenticated: boolean }[] = [];
  async function lease(id: string): Promise<string> {
    const claims: LeaseClaims = { schema: 1, iss: "echoink", sub: id, deviceId: `device-${id}`, keyHash: await keyHash(identity.publicKey), capabilities: [...PRO_CAPABILITIES], major: 2, iat: now, exp: now + 604800000 };
    const encoder = new TextEncoder(), text = `${encode(encoder.encode(JSON.stringify({ alg: "ES256", typ: "JWT", kid: "skill-fixture" })))}.${encode(encoder.encode(JSON.stringify(claims)))}`;
    return `${text}.${encode(new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, signer.privateKey, encoder.encode(text))))}`;
  }
  const transport: MembershipTransport = async (route, method, raw, token) => {
    calls.push({ path: route, body: structuredClone(raw), authenticated: !!token });
    if (offline) throw new MembershipNetworkError("synthetic offline");
    const input = raw as Record<string, unknown> | undefined;
    if (route === "/api/auth/logout") return {};
    if (route === "/api/auth/login") return { token: String(input?.email).startsWith("B") ? "synthetic-B" : "synthetic-A" };
    if (route === "/api/products") return { products: [], salesOpen: false };
    if (route === "/api/account") return account(token!);
    if (route === "/api/membership") return { state: pro ? "active" : "free", serverTime: now, expiresAt: now + 30 * 86400000,
      capabilities: pro ? [...PRO_CAPABILITIES] : [], deviceLimit: 3, devices: bound ? [{ id: `device-${token}`, name: "Synthetic device", platform: "fixture", verified: now }] : [] };
    if (route === "/api/devices/challenge") return { challengeId: "synthetic-challenge", nonce: "synthetic-nonce" };
    if (route === "/api/keys") return { keys };
    if (route === "/api/devices/lease" || route === "/api/devices/activate") {
      if (!bound && route.endsWith("lease")) throw new MembershipApiError("DEVICE_REVOKED");
      bound = true; return { lease: await lease(token!), deviceId: `device-${token}`, serverTime: now };
    }
    if (method === "DELETE" && route.startsWith("/api/devices/")) { bound = false; return {}; }
    if (route === "/api/skills/catalog") { assertPublic(!token); return structuredClone(skillFixtureCatalog); }
    if (route.endsWith("/content")) {
      const id = route.split("/")[3];
      if (blocked) await blocked();
      if (refusal) throw new MembershipApiError(refusal);
      if (!pro) throw new MembershipApiError("PRO_REQUIRED");
      if (!bound) throw new MembershipApiError("DEVICE_REVOKED");
      if (!token || !input?.deviceId || !input.lease || !["desktop", "ios", "android"].includes(String(input.platform))) throw new Error("bad request contract");
      if (input.knownVersion === version) return { id, version, notModified: true };
      const content = `# Official synthetic procedure\n\nSERVER:${id}:${version}\n`;
      return { id, version, content, sha256: corrupt ? "0".repeat(64) : sha256Hex(content), issuedAt: now, maxOfflineSeconds: 604800 };
    }
    throw new Error(`unexpected synthetic route: ${route}`);
  };
  const service = new AccountService(storage, transport, "https://fixture.invalid", () => {}, "https://fixture.invalid", () => "configured", () => now);
  await service.initialize();
  return { service, storage, calls, files: nodeSkillFiles,
    now: () => now, at: (value: number) => { now = value; }, offline: (value: boolean) => { offline = value; },
    pro: (value: boolean) => { pro = value; }, bound: (value: boolean) => { bound = value; },
    version: (value: string) => { version = value; }, corrupt: (value: boolean) => { corrupt = value; }, refusal: (value: string | null) => { refusal = value; },
    block: (value: (() => Promise<void>) | null) => { blocked = value; }
  };
}
function assertPublic(value: boolean): void { if (!value) throw new Error("public Skill catalog sent a credential"); }
