import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import net from "node:net";
import { AccountService, MembershipApiError, type MembershipTransport } from "../../src/membership/account-service";
import { MembershipNetworkError } from "../../src/membership/network-error";
import { deviceIdentity } from "../../src/membership/crypto";
import type { LocalAccountState, MembershipStorage } from "../../src/membership/types";
import { ExpertContentService } from "../../src/experts/service";
import { MAX_EXPERT_PACKAGE_BYTES, type ExpertPackageResponse } from "../../src/experts/contracts";
import { expertFixtureFiles } from "../../src/tests/expert-delivery-fixture";
import { defaultAgentRegistry, normalizeAgentRegistry } from "../../src/agents/registry";
import { hireExpert } from "../../src/agents/expert-lifecycle";

const backend = process.env.ECHOINK_EXPERT_BACKEND_ROOT;
if (!backend || process.env.NODE_ENV === "production") throw new Error("An explicit local backend checkout is required.");
const backendRequire = createRequire(path.join(backend, "package.json"));
const { fixture } = await import(pathToFileURL(path.join(backend, "test/helpers.ts")).href);
const { serve } = await import(pathToFileURL(backendRequire.resolve("@hono/node-server")).href);
const port = await new Promise<number>((resolve, reject) => {
  const probe = net.createServer(); probe.once("error", reject);
  probe.listen(0, "127.0.0.1", () => { const selected = (probe.address() as net.AddressInfo).port; probe.close(error => error ? reject(error) : resolve(selected)); });
});
const baseURL = `http://127.0.0.1:${port}`;
const runtime = await fixture({ baseURL, origins: [baseURL], adminEmails: [] });
const cache = await mkdtemp(path.join(os.tmpdir(), "echoink-expert-http-cache-"));
const services: AccountService[] = [];
let server: ReturnType<typeof serve> | undefined;
let scenarios = 0;
const test = async (name: string, run: () => Promise<void> | void) => { await run(); scenarios++; console.log(`OK expert HTTP: ${name}`); };
const seeded = ["pro", "free"] as const;
const localPassword = "Expert-local-only-2026"; // Same disposable identities as backend dev:experts, never a live credential.
try {
  for (const kind of seeded) {
    const email = `expert-${kind}@example.test`;
    await runtime.request("/api/auth/code", { email, purpose: "login" });
    const code = runtime.authentication.captured.get(`${email}:login`);
    const registered = await runtime.request("/api/auth/register", { email, code, password: localPassword });
    assert.equal(registered.response.status, 200, "isolated account seed failed");
    if (kind === "pro") {
      const user = (await runtime.request("/api/account", undefined, registered.data.token)).data;
      const product = runtime.db.prepare("SELECT snapshot FROM products WHERE id='month'").get() as { snapshot: string };
      runtime.db.prepare("INSERT INTO purchases(id,user_id,product,snapshot,starts,ends,created,reason) VALUES(?,?,?,?,?,?,?,?)")
        .run(randomUUID(), user.id, "month", product.snapshot, Date.now() - 1000, Date.now() + 30 * 86400000, Date.now(), "disposable plugin expert HTTP integration");
    }
  }
  server = await new Promise<ReturnType<typeof serve>>(resolve => {
    const listening = serve({ hostname: "127.0.0.1", port, fetch: (request: Request) => runtime.app.fetch(request) }, () => resolve(listening));
  });
  console.log("Local HTTP server: loopback only; database/mail/keys are disposable fixtures.");
  const makeAccount = async () => {
    let saved: LocalAccountState = {};
    const identity = await deviceIdentity();
    const calls: { path: string; method: string; status: number; credential: boolean }[] = [];
    const deliveries: ExpertPackageResponse[] = [];
    const transport: MembershipTransport = async (route, method, body, token) => {
      let response: Response;
      try {
        response = await fetch(`${baseURL}${route}`, { method,
          headers: { "X-EchoInk-Client": "plugin", ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      } catch { throw new MembershipNetworkError("Local HTTP service unavailable."); }
      calls.push({ path: route, method, status: response.status, credential: !!token });
      const value = await response.json() as Record<string, unknown>;
      if (!response.ok) throw new MembershipApiError(typeof value.error === "string" ? value.error : "SERVICE_UNAVAILABLE", Number(value.retryAfter));
      if (route.endsWith("/package") && typeof value.content === "string") deliveries.push(value as unknown as ExpertPackageResponse);
      return value;
    };
    const storage: MembershipStorage = { persistent: true, read: async () => structuredClone(saved), write: async value => { saved = structuredClone(value); }, identity: async () => identity };
    const service = new AccountService(storage, transport, baseURL, () => {}, baseURL, () => "configured");
    services.push(service); await service.initialize();
    return { service, transport, calls, deliveries, state: () => saved };
  };
  const pro = await makeAccount();
  const content = new ExpertContentService({ files: expertFixtureFiles(cache), cacheRoot: ".isolated/plugins/echoink/expert-cache", account: () => pro.service, pluginVersion: "2.8.8", platform: "desktop" });
  let catalog = await content.publicCatalog();
  await test("anonymous catalog supplies nine dynamic public cards and no account credentials", () => {
    assert.equal(catalog.experts.length, 9);
    assert.ok(pro.calls.filter(call => call.path === "/api/experts/catalog").every(call => !call.credential));
    assert.ok(!JSON.stringify(catalog).includes('"persona"'));
  });
  await pro.service.actions.signIn!({ email: "expert-pro@example.test", method: "password", credential: localPassword });
  await pro.service.actions.activateDevice!("Disposable expert HTTP test");
  await test("real password login, challenge proof, device binding and signed lease authorize PRO", () => {
    assert.ok(pro.service.skillAuthorization());
    assert.ok(pro.calls.some(call => call.path === "/api/devices/challenge" && call.status === 200));
    assert.ok(pro.calls.some(call => call.path === "/api/devices/activate" && call.status === 200));
  });
  catalog = await content.publicCatalog(true);
  const packs = new Map<string, Awaited<ReturnType<ExpertContentService["resolve"]>>>();
  await test("all nine real packages validate hashes, offline bounds, bundled avatars and complete licenses", async () => {
    for (const metadata of catalog.experts) {
      const pack = await content.resolve(metadata.id); pack.assertAvailable(); packs.set(metadata.id, pack);
      const delivery = pro.deliveries.at(-1)!;
      const bytes = Buffer.byteLength(JSON.stringify(delivery), "utf8");
      assert.ok(bytes <= MAX_EXPERT_PACKAGE_BYTES, "package envelope byte limit");
      assert.ok(createHash("sha256").update(delivery.content, "utf8").digest("hex") === delivery.sha256, "exact content digest");
      assert.ok(delivery.maxOfflineSeconds > 0 && delivery.maxOfflineSeconds <= 604800, "offline range");
      const until = delivery.issuedAt + delivery.maxOfflineSeconds * 1000;
      assert.ok(until <= pro.service.skillAuthorization()!.validUntil, "offline bounded by signed lease");
      const expiresAt = pro.state().rights!.expiresAt;
      const membershipEnd = typeof expiresAt === "string" ? Date.parse(expiresAt) : expiresAt;
      assert.ok(typeof membershipEnd === "number" && until <= membershipEnd, "offline bounded by membership");
      const response = await fetch(metadata.avatarUrl);
      assert.equal(response.status, 200); assert.equal(response.headers.get("content-type"), "image/webp");
      const avatar = Buffer.from(await response.arrayBuffer()), embedded = Buffer.from(pack.avatar.dataUrl.split(",")[1], "base64");
      assert.ok(avatar.equals(embedded), "public and offline avatar equivalence");
      assert.ok(pack.licenseTexts().length >= 2 && pack.licenseTexts().every(license => license.text.includes("THE SOFTWARE IS PROVIDED")), "complete bundled licenses");
      assert.ok(!JSON.stringify(pack).includes('"persona"'), "public resolved handle hides package body");
      console.log(`PACKAGE id=${metadata.id} version=${pack.version} bytes=${bytes} sha256=${delivery.sha256} offlineSeconds=${delivery.maxOfflineSeconds} avatarBytes=${avatar.length}`);
    }
  });
  await test("same version returns notModified through real HTTP without renewing signed issue time", async () => {
    const metadata = catalog.experts[0], original = pro.deliveries.find(delivery => delivery.id === metadata.id)!;
    const result = await pro.service.getExpertPackage(metadata.id, { pluginVersion: "2.8.8", platform: "desktop", knownVersion: metadata.version });
    assert.ok("notModified" in result && result.notModified);
    const fresh = await content.resolve(metadata.id);
    assert.equal(fresh.revision, packs.get(metadata.id)!.revision);
    assert.equal(pro.deliveries.filter(delivery => delivery.id === metadata.id).length, 1);
    assert.ok(Date.now() < original.issuedAt + original.maxOfflineSeconds * 1000);
  });
  await test("a downloaded package becomes a valid persisted hire identity without persona or skill bodies", () => {
    const pack = packs.get(catalog.experts[0].id)!;
    const registry = defaultAgentRegistry(), agent = hireExpert(registry, pack);
    const persisted = normalizeAgentRegistry(JSON.parse(JSON.stringify(registry)));
    const restored = persisted.agents.find(item => item.id === agent.id)!;
    assert.ok(restored.expert?.hired && restored.expert.packageVersion === pack.version);
    assert.equal(restored.avatar.kind, "custom"); assert.equal(restored.persona, undefined);
    assert.ok(!JSON.stringify(persisted).includes('"skills"'));
  });
  const free = await makeAccount();
  await free.service.actions.signIn!({ email: "expert-free@example.test", method: "password", credential: localPassword });
  await test("free account is refused locally and by the actual HTTP package endpoint", async () => {
    const id = catalog.experts[0].id;
    await assert.rejects(free.service.getExpertPackage(id, { pluginVersion: "2.8.8", platform: "desktop" }), error => error instanceof MembershipApiError && error.code === "PRO_REQUIRED");
    await assert.rejects(free.transport(`/api/experts/${id}/package`, "POST", { deviceId: "unbound-free-fixture", lease: "none", pluginVersion: "2.8.8", platform: "desktop" }, free.state().token), error => error instanceof MembershipApiError && error.code === "PRO_REQUIRED");
    assert.equal(free.calls.at(-1)!.status, 403);
  });
  await test("real online device removal denies cached packages and invalidates an active package handle", async () => {
    const id = catalog.experts[0].id, selected = packs.get(id)!;
    await pro.transport(`/api/devices/${pro.state().deviceId}`, "DELETE", {}, pro.state().token);
    await assert.rejects(content.resolve(id)); assert.equal(pro.service.skillAuthorization(), null);
    assert.throws(() => selected.assertAvailable());
    assert.ok(pro.calls.some(call => call.path.endsWith("/package") && call.status === 403));
  });
  console.log(`Expert HTTP integration: ${scenarios} scenarios passed; ${packs.size} dynamic packages validated.`);
} finally {
  services.forEach(service => service.dispose());
  if (server) await new Promise<void>((resolve, reject) => server!.close((error?: Error) => error ? reject(error) : resolve()));
  await Promise.all([runtime.checkout.stop(), runtime.pluginDownloads.stop(), runtime.weather.stop(), runtime.runReports.stop()]);
  runtime.cleanup(); await rm(cache, { recursive: true, force: true });
  const removed = await stat(runtime.dir).then(() => false, () => true);
  console.log(`CLEANUP local_http_closed=true temporary_database_removed=${removed}`);
}
