import assert from "node:assert/strict";
import { AccountService, MembershipApiError, type MembershipTransport } from "../membership/account-service";
import { deviceIdentity, encode, keyHash } from "../membership/crypto";
import { PRO_CAPABILITIES, type LeaseClaims, type LocalAccountState, type MembershipStorage } from "../membership/types";
import { getProPluginAccess } from "../membership/access";

/** In-memory server and real ES256 leases; no network, mail, model or Vault. */
export async function runMembershipAccountServiceTests(): Promise<void> {
  const signer = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const keys = [{ kid: "fixture", alg: "ES256", publicKey: await crypto.subtle.exportKey("jwk", signer.publicKey) }];
  const identity = await deviceIdentity();
  const encoder = new TextEncoder();
  const account = (id = "A") => ({ id, email: `${id}@example.test`, name: id, joinedAt: "2026-10-08", avatar: null, passwordSet: true });
  const start = Date.parse("2026-10-08T00:00:00Z");
  async function fixture() {
    let wall = start, state = "free", offline = false, limit = false, invalidLease = false;
    let saved: LocalAccountState = { token: "A", account: account() };
    const calls: string[] = [];
    const storage: MembershipStorage = { persistent: true, read: async () => structuredClone(saved), write: async value => { saved = structuredClone(value); }, identity: async () => identity };
    const expiresAt = start + 2000;
    async function lease(id = "A") {
      const claims: LeaseClaims = { schema: 1, iss: "echoink", sub: id, deviceId: "device", keyHash: await keyHash(identity.publicKey), capabilities: [...PRO_CAPABILITIES], major: 2, iat: start, exp: expiresAt };
      const data = `${encode(encoder.encode(JSON.stringify({ alg: "ES256", typ: "JWT", kid: "fixture" })))}.${encode(encoder.encode(JSON.stringify(claims)))}`;
      const signature = encode(new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, signer.privateKey, encoder.encode(data))));
      return `${data}.${signature}`;
    }
    let waitRights: (() => Promise<void>) | null = null;
    const transport: MembershipTransport = async (path, _method, body: any, token) => {
      calls.push(path);
      if (offline) throw new Error("OFFLINE");
      if (path === "/api/auth/logout") return {};
      if (path === "/api/auth/login") return { token: body.email.startsWith("B") ? "B" : "A" };
      if (path === "/api/account") return account(token);
      if (path === "/api/products") return { products: [] };
      if (path === "/api/membership") {
        if (waitRights) await waitRights();
        return { state, serverTime: wall, expiresAt: state === "active" ? expiresAt : null, deviceLimit: 3, devices: [], capabilities: [...PRO_CAPABILITIES] };
      }
      if (path === "/api/redeem") { state = "active"; return {}; }
      if (path === "/api/devices/challenge") return { challengeId: "challenge", nonce: "nonce" };
      if (path === "/api/devices/activate" || path === "/api/devices/lease") {
        if (limit) throw new MembershipApiError("DEVICE_LIMIT");
        assert.ok(body.signature, "activation and renewal use device proof");
        return { lease: invalidLease ? "invalid" : await lease(token), deviceId: "device", serverTime: wall };
      }
      if (path === "/api/keys") return { keys };
      throw new Error(`unexpected route ${path}`);
    };
    const service = new AccountService(storage, transport, "https://fixture.invalid", () => {}, "https://fixture.invalid", () => "configured", () => wall);
    await service.initialize();
    return { service, storage, calls, offline(value: boolean) { offline = value; }, limit(value: boolean) { limit = value; }, invalid(value: boolean) { invalidLease = value; }, wall(value: number) { wall = value; }, waitRights(value: (() => Promise<void>) | null) { waitRights = value; } };
  }
  const f = await fixture();
  try {
    assert.equal(f.service.read().membership.state, "free");
    assert.equal(getProPluginAccess(f.service, false).canToggle, false);
    await f.service.actions.redeem!("synthetic-code");
    assert.ok(f.calls.includes("/api/devices/activate"), "redemption activates this device automatically");
    assert.equal(f.service.read().membership.state, "active");
    assert.equal(f.service.checkCapability("finance.export"), true);
    f.offline(true);
    await assert.rejects(f.service.actions.verify!(), /OFFLINE/);
    assert.equal(f.service.read().membership.state, "offline-valid");
    assert.equal(f.service.checkCapability("finance.export"), true, "strict failure preserves valid signed offline rights");
    await f.service.refresh(); // Background refresh catches the same failure.
    const restarted = new AccountService(f.storage, async () => { throw new Error("OFFLINE"); }, "https://fixture.invalid", () => {}, "https://fixture.invalid", () => "configured", () => start);
    try { await restarted.initialize(); assert.equal(restarted.read().membership.state, "offline-valid"); assert.equal(getProPluginAccess(restarted, true).canWrite, true); }
    finally { restarted.dispose(); }
    f.wall(start + 2001);
    assert.equal(f.service.read().membership.state, "expired", "known subscription expiry presents Free, not an unknown verification state");
    assert.equal(getProPluginAccess(f.service, true).canEnter, true);
    assert.equal(getProPluginAccess(f.service, true).canWrite, false);
    await f.service.actions.signOut!();
    assert.equal(f.service.read().membership.state, "anonymous");
    assert.equal(f.service.checkCapability("finance.export"), false);
  } finally { f.service.dispose(); }

  const full = await fixture();
  try {
    full.limit(true);
    await assert.rejects(full.service.actions.redeem!("synthetic-code"), /设备名额已满/);
    assert.equal(full.service.checkCapability("finance.export"), false, "redeem POST alone does not grant PRO");
    full.limit(false); full.invalid(true);
    await assert.rejects(full.service.actions.activateDevice!("test"), /LEASE_INVALID/);
    assert.equal(full.service.checkCapability("finance.export"), false, "invalid signature grants no product permission");
    full.invalid(false);
    await full.service.actions.activateDevice!("test");
    assert.equal(full.service.checkCapability("finance.export"), true, "device-management recovery obtains signed PRO");
  } finally { full.service.dispose(); }

  const switched = await fixture();
  try {
    await switched.service.actions.redeem!("synthetic-code");
    let finish!: () => void;
    const held = new Promise<void>(resolve => { finish = resolve; });
    switched.waitRights(() => held);
    const stale = switched.service.refresh(true);
    const login = switched.service.actions.signIn!({ email: "B@example.test", method: "password", credential: "synthetic-only" });
    assert.equal(switched.service.checkCapability("finance.export"), false, "account switch removes A rights immediately");
    switched.waitRights(null); finish();
    await Promise.all([stale, login]);
    assert.equal(switched.service.read().identity?.email, "B@example.test");
    assert.equal(switched.service.checkCapability("finance.export"), false, "late A refresh cannot restore A lease to B");
  } finally { switched.service.dispose(); }
  console.log("PASS membership signed account service: activation, strict offline failure, valid offline restart, natural expiry, device limit/recovery and late account switch");
}
