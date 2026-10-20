import { AccountService, MembershipApiError, type MembershipTransport } from "../../src/membership/account-service";
import { deviceIdentity, encode, keyHash } from "../../src/membership/crypto";
import { PRO_CAPABILITIES, type LeaseClaims, type LocalAccountState, type MembershipStorage } from "../../src/membership/types";

/** Explicit visual-test issuer. No email, account, payment or network leaves this fixture. */
export async function createMobileAccountFixture() {
  const signer = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const keys = [{ kid: "mobile-visual-test", alg: "ES256", publicKey: await crypto.subtle.exportKey("jwk", signer.publicKey) }];
  const identity = await deviceIdentity(), encoder = new TextEncoder();
  let saved: LocalAccountState = {}, state = "free", bound = false, other = true;
  const account = { id: "mobile-visual-test", email: "mobile-visual@example.invalid", name: "测试用户", joinedAt: "2026-10-19", avatar: null, passwordSet: true };
  const calls: { path: string; method: string }[] = [];
  const storage: MembershipStorage = { persistent: true, read: async () => structuredClone(saved), write: async value => { saved = structuredClone(value); }, identity: async () => identity };
  const lease = async () => {
    const now = Date.now();
    const claims: LeaseClaims = { schema: 1, iss: "echoink", sub: account.id, deviceId: "test-current", keyHash: await keyHash(identity.publicKey), capabilities: [...PRO_CAPABILITIES], major: 2, iat: now, exp: now + 6 * 86400000 };
    const payload = `${encode(encoder.encode(JSON.stringify({ alg: "ES256", typ: "JWT", kid: keys[0].kid })))}.${encode(encoder.encode(JSON.stringify(claims)))}`;
    return `${payload}.${encode(new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, signer.privateKey, encoder.encode(payload))))}`;
  };
  const transport: MembershipTransport = async (path, method, raw) => {
    calls.push({ path, method });
    const body = raw as Record<string, unknown> | undefined;
    if (path === "/api/auth/code" || path === "/api/auth/logout") return {};
    if (path === "/api/auth/login" || path === "/api/auth/password") {
      if (body?.email !== account.email) throw new MembershipApiError("INVALID_CREDENTIALS");
      return { token: "synthetic-session-only" };
    }
    if (path === "/api/account") { if (method === "PATCH" && typeof body?.name === "string" && body.name) account.name = body.name; return { ...account }; }
    if (path === "/api/products") return { products: [] };
    if (path === "/api/membership") return { state, serverTime: Date.now(), planId: state === "active" ? "year" : null, planName: state === "active" ? "年卡" : null,
      expiresAt: state === "active" ? Date.now() + 365 * 86400000 : null, deviceLimit: 3,
      devices: [...(bound ? [{ id: "test-current", name: "本机测试设备", platform: "Obsidian test", verified: Date.now() }] : []), ...(other ? [{ id: "test-other", name: "另一台测试电脑", platform: "macOS test", verified: Date.now() }] : [])], capabilities: [...PRO_CAPABILITIES] };
    if (path === "/api/redeem") { if (body?.code !== "TEST-PRO") throw new MembershipApiError("CODE_INVALID"); state = "active"; return {}; }
    if (path === "/api/devices/challenge") return { challengeId: "test-challenge", nonce: "test-nonce" };
    if (path === "/api/devices/activate" || path === "/api/devices/lease") { if (!body?.signature) throw new Error("Missing device proof"); if (path === "/api/devices/lease" && !bound) throw new MembershipApiError("DEVICE_REVOKED"); bound = true; return { lease: await lease(), deviceId: "test-current", serverTime: Date.now() }; }
    if (path === "/api/keys") return { keys };
    if (path === "/api/devices/test-other" && method === "DELETE") { other = false; return {}; }
    throw new Error("Unexpected visual-test route");
  };
  const service = new AccountService(storage, transport, "https://mobile-visual.invalid", () => {}, "https://mobile-visual.invalid", () => "configured");
  await service.initialize();
  return { service, calls };
}
