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
  async function fixture(options: { active?: boolean; bound?: boolean; anonymous?: boolean } = {}) {
    let wall = start, state = options.active ? "active" : "free", offline = false, limit = false, invalidLease = false;
    let identityError: Error | null = null;
    let saved: LocalAccountState = options.anonymous ? {} : { token: "A", account: account() };
    const activeDevices = new Set(options.bound ? ["A"] : []);
    const calls: string[] = [];
    const storage: MembershipStorage = { persistent: true, read: async () => structuredClone(saved), write: async value => { saved = structuredClone(value); }, identity: async () => { if (identityError) throw identityError; return identity; } };
    const expiresAt = start + 2000;
    async function lease(id = "A") {
      const claims: LeaseClaims = { schema: 1, iss: "echoink", sub: id, deviceId: `device-${id}`, keyHash: await keyHash(identity.publicKey), capabilities: [...PRO_CAPABILITIES], major: 2, iat: start, exp: expiresAt };
      const data = `${encode(encoder.encode(JSON.stringify({ alg: "ES256", typ: "JWT", kid: "fixture" })))}.${encode(encoder.encode(JSON.stringify(claims)))}`;
      const signature = encode(new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, signer.privateKey, encoder.encode(data))));
      return `${data}.${signature}`;
    }
    let waitRights: (() => Promise<void>) | null = null;
    let waitLease: (() => Promise<void>) | null = null;
    const transport: MembershipTransport = async (path, _method, body: any, token) => {
      calls.push(path);
      if (offline) throw new Error("OFFLINE");
      if (path === "/api/auth/logout") return {};
      if (path === "/api/auth/login") return { token: body.email.startsWith("B") ? "B" : "A" };
      if (path === "/api/account") return account(token);
      if (path === "/api/products") return { products: [] };
      if (path === "/api/membership") {
        if (waitRights) await waitRights();
        const devices = activeDevices.has(token!) ? [{ id: `device-${token}`, name: "test", platform: "fixture", verified: wall }] : [];
        while (limit && devices.length < 3) devices.push({ id: `other-${devices.length}`, name: "other", platform: "fixture", verified: wall });
        return { state, serverTime: wall, expiresAt: state === "active" ? expiresAt : null, deviceLimit: 3, devices, capabilities: [...PRO_CAPABILITIES] };
      }
      if (path === "/api/redeem") { state = "active"; return {}; }
      if (path === "/api/devices/challenge") return { challengeId: "challenge", nonce: "nonce" };
      if (path === "/api/devices/activate" || path === "/api/devices/lease") {
        assert.ok(body.signature, "activation and renewal use device proof");
        if (path === "/api/devices/activate") {
          if (!activeDevices.has(token!) && limit) throw new MembershipApiError("DEVICE_LIMIT");
          activeDevices.add(token!);
        } else if (!activeDevices.has(token!)) throw new MembershipApiError("DEVICE_REVOKED");
        const response = { lease: invalidLease ? "invalid" : await lease(token), deviceId: `device-${token}`, serverTime: wall };
        if (path === "/api/devices/lease" && waitLease) await waitLease();
        return response;
      }
      if (path === `/api/devices/device-${token}` && _method === "DELETE") { activeDevices.delete(token!); return {}; }
      if (path === "/api/keys") return { keys };
      throw new Error(`unexpected route ${path}`);
    };
    const service = new AccountService(storage, transport, "https://fixture.invalid", () => {}, "https://fixture.invalid", () => "configured", () => wall);
    await service.initialize();
    return { service, storage, calls, bindings: () => [...activeDevices], offline(value: boolean) { offline = value; }, limit(value: boolean) { limit = value; }, invalid(value: boolean) { invalidLease = value; }, wall(value: number) { wall = value; }, failIdentity(error: Error | null) { identityError = error; }, waitRights(value: (() => Promise<void>) | null) { waitRights = value; }, waitLease(value: (() => Promise<void>) | null) { waitLease = value; } };
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

  const relogin = await fixture();
  try {
    await relogin.service.actions.redeem!("synthetic-code");
    const activations = relogin.calls.filter(path => path === "/api/devices/activate").length;
    relogin.limit(true);
    await relogin.service.actions.signIn!({ email: "A@example.test", method: "password", credential: "synthetic-only" });
    assert.equal(relogin.service.read().membership.state, "active", "same-account login restores an existing device even when all seats are occupied");
    assert.equal(relogin.service.read().membership.devices?.find(device => device.current)?.id, "device-A");
    assert.equal(relogin.calls.filter(path => path === "/api/devices/activate").length, activations, "restoring a device never activates a new seat");
    assert.deepEqual(relogin.bindings(), ["A"]);
  } finally { relogin.service.dispose(); }

  const anotherVault = await fixture({ active: true, bound: true, anonymous: true });
  try {
    await anotherVault.service.actions.signIn!({ email: "A@example.test", method: "password", credential: "synthetic-only" });
    assert.equal(anotherVault.service.read().membership.state, "active", "a fresh local session recovers the server binding using the shared persistent device key");
    assert.equal(anotherVault.service.checkCapability("finance.export"), true);
    assert.ok(anotherVault.calls.includes("/api/devices/lease"));
    assert.ok(!anotherVault.calls.includes("/api/devices/activate"));
  } finally { anotherVault.service.dispose(); }

  const unbound = await fixture({ active: true, anonymous: true });
  try {
    await unbound.service.actions.signIn!({ email: "A@example.test", method: "password", credential: "synthetic-only" });
    assert.equal(unbound.service.read().membership.state, "device-required", "first login leaves an unbound device awaiting explicit activation");
    assert.equal(unbound.service.read().verificationError, null, "an unbound device is not a connection or verification failure");
    assert.equal(unbound.service.checkCapability("finance.export"), false);
    unbound.limit(true);
    await unbound.service.actions.verify!();
    assert.equal(unbound.service.read().membership.state, "device-limit", "a new device still respects the account's occupied seats");
    assert.equal(unbound.service.read().verificationError, null);
    assert.deepEqual(unbound.bindings(), []);
    assert.ok(!unbound.calls.includes("/api/devices/activate"));
  } finally { unbound.service.dispose(); }

  const removed = await fixture({ active: true, bound: true });
  try {
    assert.equal(removed.service.read().membership.state, "active");
    await removed.service.actions.removeDevice!("device-A");
    await removed.service.actions.verify!();
    await removed.service.actions.signIn!({ email: "A@example.test", method: "password", credential: "synthetic-only" });
    assert.equal(removed.service.read().membership.state, "device-required", "refresh and relogin do not recreate a deliberately removed binding");
    assert.equal(removed.service.read().verificationError, null);
    assert.equal(removed.service.checkCapability("finance.export"), false);
    assert.deepEqual(removed.bindings(), []);
    assert.ok(!removed.calls.includes("/api/devices/activate"));
  } finally { removed.service.dispose(); }

  const unreadable = await fixture({ active: true, bound: true, anonymous: true });
  try {
    unreadable.failIdentity(new Error("synthetic device storage unavailable"));
    await unreadable.service.actions.signIn!({ email: "A@example.test", method: "password", credential: "synthetic-only" });
    assert.equal(unreadable.service.read().membership.state, "verification-required", "identity failure must not be treated as a new, unbound device");
    assert.equal(unreadable.service.read().verificationError, "synthetic device storage unavailable");
    assert.equal(unreadable.service.checkCapability("finance.export"), false);
    await assert.rejects(unreadable.service.actions.activateDevice!("test"), /synthetic device storage unavailable/);
    assert.ok(!unreadable.calls.includes("/api/devices/challenge"));
    assert.ok(!unreadable.calls.includes("/api/devices/activate"));
    assert.deepEqual(unreadable.bindings(), ["A"]);
  } finally { unreadable.service.dispose(); }

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

  const lateLease = await fixture({ active: true, bound: true });
  try {
    let entered!: () => void, finish!: () => void;
    const requested = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { finish = resolve; });
    lateLease.waitLease(() => { entered(); return held; });
    const stale = lateLease.service.refresh(true);
    await requested;
    const login = lateLease.service.actions.signIn!({ email: "B@example.test", method: "password", credential: "synthetic-only" });
    assert.equal(lateLease.service.checkCapability("finance.export"), false);
    lateLease.waitLease(null);
    finish();
    await Promise.all([stale, login]);
    assert.equal(lateLease.service.read().identity?.email, "B@example.test");
    assert.equal(lateLease.service.read().membership.state, "device-required");
    assert.equal(lateLease.service.checkCapability("finance.export"), false, "an A lease arriving after a switch cannot authorize B");
    assert.deepEqual(lateLease.bindings(), ["A"], "recovering B cannot register it automatically");
    assert.ok(!lateLease.calls.includes("/api/devices/activate"));
  } finally { lateLease.service.dispose(); }
  console.log("PASS membership signed account service: activation, offline restart/expiry, device recovery across login and fresh sessions, unbound/full/removed devices, identity failures and late account/lease responses");
}
