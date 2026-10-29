import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { ExpertContentService } from "../experts/service";
import { MAX_EXPERT_PACKAGE_BYTES, parseExpertCatalog, parseExpertDelivery, parseExpertPackage } from "../experts/contracts";
import { selectExpertSkills } from "../experts/prompt";
import { createExpertAccountFixture, expertFixtureBody, expertFixtureFiles, fixtureExpertId } from "./expert-delivery-fixture";

export async function runExpertContentTests(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "echoink-expert-content-"));
  const accounts: Awaited<ReturnType<typeof createExpertAccountFixture>>[] = [];
  const account = async (options?: Parameters<typeof createExpertAccountFixture>[0]) => { const fixture = await createExpertAccountFixture(options); accounts.push(fixture); return fixture; };
  let passed = 0;
  const test = async (name: string, run: () => void | Promise<void>) => { await run(); ++passed; console.log(`OK expert content: ${name}`); };
  try {
    await test("catalog accepts new dynamic IDs and only public fields", () => {
      const { schema: _schema, persona: _persona, skills: _skills, avatar: _avatar, licenses: _licenses, ...meta } = expertFixtureBody();
      const catalog = parseExpertCatalog({ catalogVersion: "new", experts: [{ ...meta, id: "another-new-expert" }] }, "https://fixture.invalid");
      assert.equal(catalog.experts[0].id, "another-new-expert");
      assert.equal("persona" in catalog.experts[0], false);
    });
    await test("hash uses original UTF-8 bytes and envelope includes escaping and avatar overhead", () => {
      const content = JSON.stringify(expertFixtureBody());
      const delivery = { id: fixtureExpertId, version: "fixture-1", content, sha256: createHash("sha256").update(content, "utf8").digest("hex"), issuedAt: Date.now(), maxOfflineSeconds: 604800 };
      assert.equal(parseExpertDelivery(delivery, fixtureExpertId).version, "fixture-1");
      assert.throws(() => parseExpertDelivery({ ...delivery, content: content.replace(/,/u, ", ") }, fixtureExpertId), /校验/u);
      assert.throws(() => parseExpertDelivery({ ...delivery, content: "😀".repeat(Math.floor(MAX_EXPERT_PACKAGE_BYTES / 3)) }, fixtureExpertId), /大小/u);
      const body = expertFixtureBody(); body.persona = "😀".repeat(4000);
      const valid = { ...delivery, content: JSON.stringify(body) };
      assert.equal(Array.from(parseExpertPackage(valid, "https://fixture.invalid").persona).length, 4000);
      body.persona += "😀";
      assert.throws(() => parseExpertPackage({ ...valid, content: JSON.stringify(body) }, "https://fixture.invalid"), /内容无效/u);
      assert.throws(() => parseExpertPackage({ ...valid, content: "PRIVATE SECRET MALFORMED JSON" }, "https://fixture.invalid"), error => error instanceof Error && !error.message.includes("PRIVATE"));
    });
    const free = await account({ pro: false });
    const make = (f: typeof free, name = "paid", platform: "desktop" | "ios" | "android" = "desktop") => new ExpertContentService({
      files: expertFixtureFiles(path.join(root, name)), cacheRoot: ".custom/plugins/echoink/expert-cache", account: () => f.service,
      pluginVersion: "2.8.8", platform, now: f.now });
    await test("free can browse without credentials and cannot request or reuse private packages", async () => {
      const service = make(free, "free"); assert.equal((await service.publicCatalog()).experts.length, 1);
      await assert.rejects(service.resolve(fixtureExpertId), /PRO/u);
      assert.equal(free.calls.some(call => call.path.endsWith("/package")), false);
    });
    const f = await account(); let service = make(f);
    const initial = await service.resolve(fixtureExpertId), issuedAt = f.now();
    await test("resolved handle serializes only public data and injects only relevant preconfigured skills", () => {
      const serialized = JSON.stringify(initial);
      assert.doesNotMatch(serialized, /PRIVATE|SYNTHETIC LICENSE/u);
      const plain = initial.buildTransientPrompt({ text: "你好" });
      assert.match(plain, /PRIVATE PERSONA/u); assert.doesNotMatch(plain, /PRIVATE PLAN|PRIVATE REVIEW|PRIVATE BUDGET/u);
      const selected = initial.buildTransientPrompt({ text: "请帮我拟定项目计划" });
      assert.match(selected, /PRIVATE PLAN/u); assert.doesNotMatch(selected, /PRIVATE REVIEW|PRIVATE BUDGET/u);
      assert.ok(selectExpertSkills(expertFixtureBody().skills, { text: "项目计划、审稿和预算" }).length <= 2);
      assert.equal(initial.licenseTexts()[0].text, "SYNTHETIC LICENSE FULL TEXT");
      assert.equal(initial.avatar.kind, "custom");
    });
    await test("private cache contains JSON only and notModified never renews issue time", async () => {
      f.at(issuedAt + 86400000); await f.service.refresh(true);
      const same = await service.resolve(fixtureExpertId); assert.equal(same.revision, initial.revision);
      const files = await readdir(path.join(root, "paid"), { recursive: true });
      assert.equal(files.some(file => file.endsWith(".md")), false);
      const pointer = files.find(file => file.endsWith("current.json"))!;
      const raw = JSON.parse(await readFile(path.join(root, "paid", pointer), "utf8"));
      assert.equal(raw.issuedAt, issuedAt);
      assert.equal((f.calls.filter(call => call.path.endsWith("/package")).at(-1)!.body as { knownVersion: string }).knownVersion, "fixture-1");
      f.offline(true); service = make(f); (await service.resolve(fixtureExpertId)).assertAvailable();
      assert.equal(service.deliveryState(fixtureExpertId)?.kind, "offline"); f.offline(false);
    });
    await test("expired caches request full body and reject forged notModified even with a renewed lease", async () => {
      f.at(issuedAt + 6 * 86400000); await f.service.refresh(true);
      f.at(issuedAt + 7 * 86400000 + 1);
      assert.throws(() => initial.assertAvailable(), /到期/u);
      f.offline(true); await assert.rejects(make(f).resolve(fixtureExpertId)); f.offline(false);
      f.notModified(true); await assert.rejects(service.resolve(fixtureExpertId), /完整包/u); f.notModified(false);
      await service.resolve(fixtureExpertId);
      assert.equal("knownVersion" in (f.calls.filter(call => call.path.endsWith("/package")).at(-1)!.body as object), false);
    });
    await test("bad new checksum leaves the previous valid immutable package untouched", async () => {
      const before = await service.resolve(fixtureExpertId);
      f.version("fixture-2"); f.corrupt(true); await assert.rejects(service.resolve(fixtureExpertId), /校验/u);
      before.assertAvailable(); f.corrupt(false);
      const updated = await service.resolve(fixtureExpertId); assert.notEqual(updated.revision, before.revision);
      assert.match(before.buildTransientPrompt({ text: "你好" }), /fixture-1/u);
      assert.match(updated.buildTransientPrompt({ text: "你好" }), /fixture-2/u);
    });
    await test("all platforms resolve through the same account/device request contract", async () => {
      for (const platform of ["desktop", "ios", "android"] as const) {
        await make(f, `platform-${platform}`, platform).resolve(fixtureExpertId);
        assert.equal((f.calls.filter(call => call.path.endsWith("/package")).at(-1)!.body as { platform: string }).platform, platform);
      }
    });
    await test("online device refusal invalidates live handles and never falls back to valid cache", async () => {
      const before = await service.resolve(fixtureExpertId); f.refusal("DEVICE_REVOKED");
      await assert.rejects(service.resolve(fixtureExpertId)); assert.equal(f.service.skillAuthorization(), null);
      assert.throws(() => before.assertAvailable()); f.refusal(null); await f.service.refresh(true);
      assert.throws(() => before.assertAvailable(), "renewed session cannot revive an old handle");
    });
    await test("account switch during download cancels before publishing any cache pointer", async () => {
      const switched = await account(), resolver = make(switched, "switch");
      let release!: () => void, entered!: () => void;
      const blocked = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
      switched.block(async () => { entered(); await blocked; });
      const pending = resolver.resolve(fixtureExpertId), rejected = assert.rejects(pending);
      await started; await switched.service.actions.signIn!({ email: "B@example.test", method: "password", credential: "synthetic" });
      release(); await rejected;
      const files = await readdir(path.join(root, "switch"), { recursive: true }); assert.equal(files.some(file => file.endsWith("current.json")), false);
    });
    await test("another signed-in account cannot read an earlier account's cached package offline", async () => {
      await service.resolve(fixtureExpertId);
      await f.service.actions.signIn!({ email: "B@example.test", method: "password", credential: "synthetic" });
      f.offline(true); await assert.rejects(make(f).resolve(fixtureExpertId)); f.offline(false);
    });
    await test("a shorter signed device lease stops an otherwise fresh seven-day cache", async () => {
      const short = await account({ leaseDurationMs: 86400000 }), resolver = make(short, "short-lease");
      const selected = await resolver.resolve(fixtureExpertId), expires = short.service.skillAuthorization()!.validUntil;
      short.at(expires + 1); short.offline(true);
      assert.throws(() => selected.assertAvailable()); await assert.rejects(resolver.resolve(fixtureExpertId));
    });
    console.log(`Expert content: ${passed} scenarios passed.`);
  } finally { accounts.forEach(f => f.service.dispose()); await rm(root, { recursive: true, force: true }); }
}
