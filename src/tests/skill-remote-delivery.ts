import { requiresProductFreshnessVerification } from "../harness/resources/skill-routing";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, rename, mkdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SkillContentResolver, SKILL_PRODUCT_RULES, skillLocalPath } from "../harness/resources/skill-content";
import { renderBuiltinSkill, getBuiltinSkillDefinition, isRemoteOnlySkill, REMOTE_ONLY_SKILL_IDS } from "../harness/resources/builtin-skills";
import { SkillRuntimeCoordinator } from "../harness/resources/skill-runtime";
import { createControlledVaultResourceLoader } from "../harness/pi-native/controlled-resources";
import { skillPluginVersionSupported } from "../membership/skill-delivery";
import { MobileSkillsService } from "../mobile/skills";
import { loadMobileSettings } from "../mobile/settings";
import type { MobileCapabilityPolicy } from "../mobile/capability-policy";
import type { DataAdapter } from "obsidian";
import { createSkillAccountFixture, nodeSkillFiles } from "./skill-delivery-fixture";

export async function runRemoteSkillDeliveryTests(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "echoink-skill-remote-"));
  const accounts: Awaited<ReturnType<typeof createSkillAccountFixture>>[] = [];
  const account = async (options?: Parameters<typeof createSkillAccountFixture>[0]) => { const fixture = await createSkillAccountFixture(options); accounts.push(fixture); return fixture; };
  let passed = 0;
  const test = async (name: string, run: () => Promise<void> | void) => { await run(); passed++; console.log(`OK remote Skill: ${name}`); };
  try {
    await test("SemVer minimum handles prereleases, numeric identifiers and build metadata", () => {
      for (const [current, minimum, expected] of [["2.8.8", "2.8.7", true], ["2.8.8-beta.1", "2.8.8", false], ["2.8.8+build", "2.8.8", true], ["2.8.8-beta.10", "2.8.8-beta.2", true], ["2.8.8-beta.2", "2.8.8-beta.10", false], ["2.8.8-01", "2.8.8", false]] as const) assert.equal(skillPluginVersionSupported(current, minimum), expected);
    });
    const free = await account({ pro: false });
    const freeFiles = nodeSkillFiles(path.join(root, "free"));
    const freeResolver = new SkillContentResolver({ files: freeFiles, cacheRoot: ".custom/plugins/echoink/skill-cache", account: () => free.service, pluginVersion: "2.8.8", platform: "desktop", now: free.now });
    await test("no PRO: public catalog, basic Review and free Skills; remote content never requested", async () => {
      assert.equal((await freeResolver.publicCatalog())?.skills.length, 8);
      await assert.rejects(freeResolver.resolve("deep-understanding"), /PRO/u);
      assert.match((await freeResolver.resolve("knowledge-review")).content, /每个 available Raw/u);
      for (const id of ["daily-journal", "finance-operations", "finance-bill-import", "finance-analysis", "english-diary", "obsidian-markdown", "todo-operations"]) assert.equal((await freeResolver.resolve(id)).source, "builtin");
      assert.equal(free.calls.some(call => call.path.endsWith("/content")), false);
      assert.equal(requiresProductFreshnessVerification("核对现在的政策与当前价格"), true);
      assert.equal(requiresProductFreshnessVerification("记一下我今天早餐花了12块"), false);
      assert.match(SKILL_PRODUCT_RULES, /推进/u); assert.match(SKILL_PRODUCT_RULES, /版本冲突保护/u);
    });
    const f = await account(), vault = path.join(root, "paid"), files = nodeSkillFiles(vault);
    const resolver = (platform: "desktop" | "ios" | "android" = "desktop") => new SkillContentResolver({ files, cacheRoot: ".configured/plugins/codex-echoink/skill-cache", account: () => f.service, pluginVersion: "2.8.8", platform, now: f.now });
    let content = resolver();
    await test("manual + automatic + default Review resolve into immutable controlled-loader paths", async () => {
      const coordinator = new SkillRuntimeCoordinator(vault, { content });
      await coordinator.initialize();
      const manual = await coordinator.resolveById("deep-understanding");
      const auto = await coordinator.selectForTask({ text: "请深入拆解这个方案，用大白话解释" });
      const review = await coordinator.resolveById("knowledge-review");
      assert.ok(auto?.skills.some(skill => skill.id === "deep-understanding"));
      for (const selected of [manual, auto!, review]) {
        const loader = await createControlledVaultResourceLoader({ vaultRoot: vault, skillPaths: selected.skills.map(skill => skill.skillPath),
          assertSkillAllowed: async target => { assert.ok(await coordinator.assertResolvedPath(target)); }, systemPrompt: SKILL_PRODUCT_RULES });
        const prompt = await loader.renderSelectedSkillSetPrompt(selected.skills.map(skill => skill.skillName));
        for (const skill of selected.skills) assert.match(prompt, new RegExp(`SERVER:${skill.id}:fixture-1`, "u"));
        assert.ok(selected.skills.every(skill => skill.skillPath.includes(".configured/plugins/")));
      }
      assert.equal((await coordinator.read()).records["deep-understanding"].userModified, false, "downloading official content never turns it into a user copy");
      await coordinator.recordUse("two-layer-explanation"); await coordinator.recordUse("knowledge-review");
      assert.equal((await coordinator.read()).records["two-layer-explanation"].userModified, false, "official usage does not mark the pointer as a user edit");
      assert.equal((await coordinator.read()).records["knowledge-review"].userModified, false, "using the enhancement does not mark the free base as edited");
    });
    let first = await content.resolve("deep-understanding"); const issuedAt = f.now();
    await test("Review keeps the full free procedure when its remote enhancement is unavailable offline", async () => {
      const isolated = new SkillContentResolver({ files: nodeSkillFiles(path.join(root, "offline-review")), cacheRoot: ".config/plugins/echoink/skill-cache", account: () => f.service, pluginVersion: "2.8.8", platform: "desktop", now: f.now });
      // Retain public directory metadata, but do not cache paid Review text.
      await isolated.publicCatalog(); f.offline(true);
      const basic = await isolated.resolve("knowledge-review");
      assert.equal(basic.source, "builtin"); assert.match(basic.content, /每个 available Raw/u);
      f.offline(false);
    });
    await test("notModified and cache reads do not renew the full-response issue time", async () => {
      f.at(issuedAt + 86400000); await f.service.refresh(true);
      const same = await content.resolve("deep-understanding");
      assert.equal(same.path, first.path);
      const pointer = JSON.parse((await files.read(first.path.slice(0, first.path.indexOf("/deep-understanding/")) + "/deep-understanding/current.json"))!) as { issuedAt: number };
      assert.equal(pointer.issuedAt, issuedAt);
      assert.ok(f.calls.filter(call => call.path.endsWith("/content")).some(call => (call.body as { knownVersion?: string }).knownVersion === "fixture-1"));
      f.offline(true); content = resolver(); const offline = await content.resolve("deep-understanding");
      assert.equal(offline.path, first.path); offline.assertAvailable();
      f.offline(false);
    });
    await test("cache stops after 7 days even with a freshly renewed valid device lease", async () => {
      f.at(issuedAt + 6 * 86400000); await f.service.refresh(true);
      f.at(issuedAt + 7 * 86400000 + 1); assert.ok(f.service.skillAuthorization());
      f.offline(true);
      await assert.rejects(resolver().resolve("deep-understanding"));
      assert.throws(() => first.assertAvailable(), /到期/u);
      f.offline(false);
      const fresh = await content.resolve("deep-understanding"); assert.notEqual(fresh.path, first.path); first = fresh;
      const last = f.calls.filter(call => call.path.endsWith("/content")).at(-1)!;
      assert.equal("knownVersion" in (last.body as object), false, "expired cache requests a full response");
    });
    await test("corrupt or failed new downloads preserve the last valid version; a run keeps its version", async () => {
      const original = await content.resolve("deep-understanding"), raw = await readFile(path.join(vault, original.path), "utf8");
      f.version("fixture-2"); f.corrupt(true);
      await assert.rejects(content.resolve("deep-understanding"), /校验失败/u);
      assert.equal(await readFile(path.join(vault, original.path), "utf8"), raw);
      f.corrupt(false); const updated = await content.resolve("deep-understanding");
      assert.notEqual(updated.revision, original.revision); assert.notEqual(updated.path, original.path);
      assert.match(updated.content, /fixture-2/u); assert.match(original.content, /fixture-1/u);
      original.assertAvailable();
    });
    await test("three platforms deliver the same selected server version into actual Skill prompt text", async () => {
      for (const platform of ["desktop", "ios", "android"] as const) {
        const selected = await resolver(platform).resolve("two-layer-explanation");
        assert.match(selected.content, /SERVER:two-layer-explanation:fixture-2/u);
        assert.equal((f.calls.filter(call => call.path.endsWith("/content")).at(-1)!.body as { platform: string }).platform, platform);
      }
    });
    await test("migration preserves edited copies and custom Skills, replaces only known generated pointers", async () => {
      for (const id of REMOTE_ONLY_SKILL_IDS) await files.write(skillLocalPath(id), renderBuiltinSkill(getBuiltinSkillDefinition(id)!));
      const edited = `${renderBuiltinSkill(getBuiltinSkillDefinition("deep-understanding")!)}\nMY PERSONAL PROCEDURE\n`;
      await files.write(skillLocalPath("deep-understanding"), edited);
      await files.write(skillLocalPath("my-user-skill"), "# Custom\nMy own procedure.");
      await content.migrateOfficialCopies();
      assert.equal(await files.read(skillLocalPath("deep-understanding")), edited);
      assert.equal((await content.resolve("deep-understanding")).source, "user");
      const userResolver = new SkillContentResolver({ files, cacheRoot: ".configured/plugins/codex-echoink/skill-cache", account: () => free.service, pluginVersion: "2.8.8", platform: "desktop", now: free.now });
      const upgraded = new SkillRuntimeCoordinator(vault, { content: userResolver }); await upgraded.initialize();
      assert.equal((await upgraded.selectForTask({ text: "请深入拆解这个方案" }))?.id, "deep-understanding", "a modified legacy copy retains its existing trigger rules without PRO");
      assert.equal(await files.read(skillLocalPath("my-user-skill")), "# Custom\nMy own procedure.");
      assert.ok(isRemoteOnlySkill("deep-understanding"));
    });
    await test("iPhone/iPad service locks public details without content calls and uses shared manual/auto resolution", async () => {
      const mobileRoot = path.join(root, "mobile"), mobileFiles = nodeSkillFiles(mobileRoot), settings = loadMobileSettings({ review: { enabled: true } });
      const adapter = { read: async (p: string) => (await mobileFiles.read(p))!, exists: async (p: string) => stat(path.join(mobileRoot, p)).then(() => true, () => false),
        write: mobileFiles.write, mkdir: async (p: string) => { await mkdir(path.join(mobileRoot, p), { recursive: true }); }, list: mobileFiles.list,
        rename: async (from: string, to: string) => { await rename(path.join(mobileRoot, from), path.join(mobileRoot, to)); },
        remove: async (p: string) => { await rm(path.join(mobileRoot, p), { force: true }); } } as unknown as DataAdapter;
      const policy = { assertSkill(id: string) { if (id === "obsidian-cli") throw new Error("desktop only"); } } as MobileCapabilityPolicy;
      const create = (service: typeof f.service) => new MobileSkillsService(adapter, () => settings, async () => {}, () => policy, undefined,
        new SkillContentResolver({ files: mobileFiles, cacheRoot: ".ipad-config/plugins/echoink/skill-cache", account: () => service, pluginVersion: "2.8.8", platform: "ios", now: service === f.service ? f.now : free.now }));
      const locked = create(free.service), before = free.calls.filter(call => call.path.endsWith("/content")).length;
      const snapshot = await locked.readSkill("two-layer-explanation"); assert.equal(snapshot.locked, true); assert.equal(snapshot.content, "");
      assert.equal(free.calls.filter(call => call.path.endsWith("/content")).length, before);
      for (const device of ["iphone", "ipad"]) {
        const mobile = create(f.service);
        const manual = await mobile.resolveRunSkills(device, "sol", "explain", "two-layer-explanation");
        assert.match(manual[0].content, /SERVER:two-layer-explanation:fixture-2/u);
        const auto = await mobile.resolveRunSkills(`${device}-auto`, "sol", "我没听懂，请用大白话解释这件事");
        assert.match(auto[0].content, /SERVER:two-layer-explanation:fixture-2/u);
        mobile.assertRunSkills(device); mobile.releaseRunSkills(device);
        await assert.rejects(mobile.resolveRunSkills(device, "sol", "", "obsidian-cli"), /desktop only/u);
      }
    });
    await test("a renewed login cannot revive another run bound to the previous authorization", async () => {
      const coordinator = new SkillRuntimeCoordinator(vault, { content }); await coordinator.initialize();
      const before = await coordinator.resolveById("two-layer-explanation");
      f.refusal("DEVICE_REVOKED"); await assert.rejects(coordinator.resolveById("two-layer-explanation"));
      f.refusal(null); await f.service.refresh(true);
      const after = await coordinator.resolveById("two-layer-explanation");
      assert.equal(after.revision, before.revision, "the server version can remain unchanged");
      assert.notEqual(after.skillPath, before.skillPath, "authorization bindings remain independent even for the same cached content");
      await assert.rejects(coordinator.assertResolvedPath(before.skillPath));
      assert.equal(await coordinator.assertResolvedPath(after.skillPath), "two-layer-explanation");
    });
    await test("explicit revocation stops cache and current version assertions", async () => {
      const selected = await content.resolve("two-layer-explanation");
      f.refusal("DEVICE_REVOKED"); await assert.rejects(content.resolve("two-layer-explanation"));
      assert.equal(f.service.skillAuthorization(), null); assert.throws(() => selected.assertAvailable());
      f.refusal(null); await f.service.refresh(true);
      assert.throws(() => selected.assertAvailable(), "re-activating the same device cannot revive an earlier authorization snapshot");
    });
    await test("unactivated device and logout cannot retrieve cached or remote text", async () => {
      const unbound = await account({ bound: false });
      const blocked = new SkillContentResolver({ files, cacheRoot: ".configured/plugins/codex-echoink/skill-cache", account: () => unbound.service, pluginVersion: "2.8.8", platform: "desktop", now: unbound.now });
      await assert.rejects(blocked.resolve("two-layer-explanation"), /PRO/u);
      const selected = await content.resolve("two-layer-explanation"); await f.service.actions.signOut!();
      assert.throws(() => selected.assertAvailable()); await assert.rejects(content.resolve("two-layer-explanation"), /PRO/u);
    });
    await test("account switches cancel a delayed download before it can become a cache pointer", async () => {
      const switched = await account(), switchedFiles = nodeSkillFiles(path.join(root, "switch"));
      const resolver = new SkillContentResolver({ files: switchedFiles, cacheRoot: ".custom/plugins/echoink/skill-cache", account: () => switched.service, pluginVersion: "2.8.8", platform: "desktop", now: switched.now });
      let release!: () => void, entered!: () => void;
      const barrier = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
      switched.block(async () => { entered(); await barrier; });
      const pending = resolver.resolve("clarify-real-question"); const result = assert.rejects(pending);
      await started;
      const scope = switched.service.skillAuthorization()!.scope;
      await switched.service.actions.signIn!({ email: "B@example.test", method: "password", credential: "synthetic" });
      release(); await result;
      assert.equal(await switchedFiles.read(`.custom/plugins/echoink/skill-cache/${scope}/clarify-real-question/current.json`), null);
    });
    console.log(`Remote Skill delivery: ${passed} scenarios passed.`);
  } finally { accounts.forEach(f => f.service.dispose()); await rm(root, { recursive: true, force: true }); }
}
