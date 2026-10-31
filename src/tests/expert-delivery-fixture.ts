import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { AccountService, MembershipApiError, type MembershipTransport } from "../membership/account-service";
import { MembershipNetworkError } from "../membership/network-error";
import { deviceIdentity, encode, keyHash } from "../membership/crypto";
import { PRO_CAPABILITIES, type LeaseClaims, type LocalAccountState, type MembershipStorage } from "../membership/types";
import type { ExpertContentFiles } from "../experts/service";
import type { ExpertCatalog, ExpertPackageBody, ExpertPackageResponse } from "../experts/contracts";
import { sha256Hex } from "../utils/sha256";

export const fixtureExpertId = "synthetic-adviser";
export function expertFixtureBody(version = "fixture-1"): ExpertPackageBody {
  return { schema: 1, id: fixtureExpertId, name: "合成测试顾问", scene: "测试", summary: "仅用于合同测试的公开简介", quote: "测试用原创句子",
    tags: ["整理计划", "练习写作", "检查方案"], avatarUrl: "/expert-avatars/synthetic.webp", version,
    minPluginVersion: "2.8.8", platforms: ["desktop", "ios", "android"], status: "draft",
    persona: `SYNTHETIC PRIVATE PERSONA ${version} 🧪`,
    skills: [
      { id: "write-plan", name: "写计划", description: "拟定项目计划与里程碑", keywords: ["项目计划"], content: `SYNTHETIC PRIVATE PLAN ${version}` },
      { id: "review-text", name: "审稿", description: "修改文章与段落表达", keywords: ["审稿"], content: `SYNTHETIC PRIVATE REVIEW ${version}` },
      { id: "budget", name: "预算", description: "核对收支预算", keywords: ["预算"], content: `SYNTHETIC PRIVATE BUDGET ${version}` },
    ], avatar: { mimeType: "image/webp", base64: "UklGRgAAAABXRUJQ" },
    licenses: [{ name: "Synthetic test permission", source: "https://example.test/license", text: "SYNTHETIC LICENSE FULL TEXT" }] };
}
export function expertFixtureFiles(root: string): ExpertContentFiles {
  return {
    read: async target => { try { return await readFile(path.join(root, target), "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; } },
    write: async (target, content) => { await mkdir(path.dirname(path.join(root, target)), { recursive: true }); await writeFile(path.join(root, target), content, "utf8"); },
  };
}
/** Production AccountService, ES256 device proof and signed leases; synthetic HTTP data only. */
export async function createExpertAccountFixture(options: { pro?: boolean; leaseDurationMs?: number; bodyFields?: Record<string, unknown> } = {}) {
  let now = Date.parse("2026-10-29T12:00:00Z"), pro = options.pro ?? true, offline = false, version = "fixture-1";
  let refusal: string | null = null, corrupt = false, blocked: (() => Promise<void>) | null = null, forceNotModified = false;
  let bodyFields = structuredClone(options.bodyFields ?? {}), forceFullBody = false;
  const signer = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const keys = [{ kid: "expert-fixture", alg: "ES256", publicKey: await crypto.subtle.exportKey("jwk", signer.publicKey) }];
  const identity = await deviceIdentity();
  const account = (id: string) => ({ id, email: `${id}@example.test`, name: id, joinedAt: "2026-10-29", avatar: null, passwordSet: true });
  let saved: LocalAccountState = { token: "synthetic-A", account: account("synthetic-A") };
  const storage: MembershipStorage = { persistent: true, read: async () => structuredClone(saved), write: async value => { saved = structuredClone(value); }, identity: async () => identity };
  const calls: { path: string; body: unknown; token?: string }[] = [];
  const deliveries: ExpertPackageResponse[] = [];
  const lease = async (id: string) => {
    const claims: LeaseClaims = { schema: 1, iss: "echoink", sub: id, deviceId: `device-${id}`, keyHash: await keyHash(identity.publicKey), capabilities: [...PRO_CAPABILITIES], major: 2, iat: now, exp: now + (options.leaseDurationMs ?? 604800000) };
    const encoder = new TextEncoder(), text = `${encode(encoder.encode(JSON.stringify({ alg: "ES256", typ: "JWT", kid: "expert-fixture" })))}.${encode(encoder.encode(JSON.stringify(claims)))}`;
    return `${text}.${encode(new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, signer.privateKey, encoder.encode(text))))}`;
  };
  const catalog = (): ExpertCatalog => {
    const { schema: _schema, persona: _persona, skills: _skills, avatar: _avatar, licenses: _licenses, ...meta } = expertFixtureBody(version);
    return { catalogVersion: version, experts: [{ ...meta, avatarUrl: `https://fixture.invalid${meta.avatarUrl}` }] };
  };
  const transport: MembershipTransport = async (route, method, raw, token) => {
    calls.push({ path: route, body: structuredClone(raw), token });
    if (offline) throw new MembershipNetworkError("synthetic offline");
    const input = raw as Record<string, unknown> | undefined;
    if (route === "/api/auth/logout") return {};
    if (route === "/api/auth/login") return { token: String(input?.email).startsWith("B") ? "synthetic-B" : "synthetic-A" };
    if (route === "/api/products") return { products: [], salesOpen: false };
    if (route === "/api/account") return account(token!);
    if (route === "/api/membership") return { state: pro ? "active" : "free", serverTime: now, expiresAt: now + 30 * 86400000,
      capabilities: pro ? [...PRO_CAPABILITIES] : [], deviceLimit: 3, devices: [{ id: `device-${token}`, name: "Synthetic device", platform: "fixture", verified: now }] };
    if (route === "/api/devices/challenge") return { challengeId: "synthetic-challenge", nonce: "synthetic-nonce" };
    if (route === "/api/keys") return { keys };
    if (route === "/api/devices/lease" || route === "/api/devices/activate") return { lease: await lease(token!), deviceId: `device-${token}`, serverTime: now };
    if (route === "/api/experts/catalog") {
      if (token) throw new Error("public expert catalog sent a credential");
      return catalog();
    }
    if (route === `/api/experts/${fixtureExpertId}/package` && method === "POST") {
      if (blocked) await blocked();
      if (refusal) throw new MembershipApiError(refusal);
      if (!pro) throw new MembershipApiError("PRO_REQUIRED");
      if (!token || input?.deviceId !== `device-${token}` || typeof input.lease !== "string" || !["desktop", "ios", "android"].includes(String(input.platform))) throw new Error("invalid expert request contract");
      if (forceNotModified || !forceFullBody && input.knownVersion === version) return { id: fixtureExpertId, version, notModified: true };
      const content = JSON.stringify({ ...expertFixtureBody(version), ...bodyFields });
      const delivery = { id: fixtureExpertId, version, content, sha256: corrupt ? "0".repeat(64) : sha256Hex(content), issuedAt: now, maxOfflineSeconds: 604800 };
      deliveries.push(delivery); return delivery;
    }
    throw new Error(`unexpected synthetic route ${route}`);
  };
  const service = new AccountService(storage, transport, "https://fixture.invalid", () => {}, "https://fixture.invalid", () => "configured", () => now);
  await service.initialize();
  return { service, calls, deliveries, now: () => now, at: (value: number) => { now = value; }, offline: (value: boolean) => { offline = value; },
    version: (value: string) => { version = value; }, corrupt: (value: boolean) => { corrupt = value; }, refusal: (value: string | null) => { refusal = value; },
    block: (value: (() => Promise<void>) | null) => { blocked = value; }, notModified: (value: boolean) => { forceNotModified = value; },
    bodyFields: (value: Record<string, unknown>) => { bodyFields = structuredClone(value); }, fullBody: (value: boolean) => { forceFullBody = value; } };
}
