import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { answer } from "./host.mjs";
import { createProfileHost as createHost } from "./profile-host.mjs";

export async function profileScenarios(api, test, settings) {
  const { renderPersonalMemoryOverview, MobileProfileProtocol, renderAgentMarkdown, agentSelfFromTemplate, parseAgentCurrentSelf, emptyAgentSelfMetadata, getAgentTemplate, stableSelfKey, MobileStore, MobileRuntime, MobileServices } = api;
  const root = ".echoink/", identityPath = root + "agents/echoink/agent-identity.json", agentPath = root + "agents/echoink/AGENT.md", metaPath = root + "agents/echoink/agent-self-meta.json", manifestPath = root + "shared-user/.runtime/manifest.json";
  const hash = text => createHash("sha256").update(text).digest("hex");
  const identity = { schema: "echoink.agent-identity.v1", revision: 2, displayName: "墨墨", avatar: { kind: "preset", presetId: "sol" }, updatedAt: 42 };
  const habits = [{ key: "short-first", text: "长期习惯独有证据" }];
  await test("finance replacement supports non-overwriting adapters and restores failed saves", async () => {
    const path = "custom/lifestyle.json", initial = JSON.stringify({ version: 1, unowned: { keep: true }, budgets: [] });
    const host = createHost({ [path]: initial }), store = api.mobileLifestyleStore(host.adapter, path);
    await store.initialize();
    await store.update(data => { data.budgets.push({ month: "2026-10", totalCents: 5000, allocations: {} }); });
    const before = host.files.get(path), snapshot = JSON.stringify(store.snapshot());
    const rename = host.adapter.rename.bind(host.adapter); let failed = false;
    host.adapter.rename = async (from, to) => { if (to === path && !failed) { failed = true; throw new Error("finance-install-failure"); } await rename(from, to); };
    await assert.rejects(store.update(data => { data.budgets = []; }), /finance-install/u);
    assert.equal(host.files.get(path), before); assert.equal(JSON.stringify(store.snapshot()), snapshot);
    assert.ok(![...host.files.keys()].some(file => file.endsWith(".tmp")));
    host.adapter.rename = rename;
    const reopened = api.mobileLifestyleStore(host.adapter, path); await reopened.initialize();
    assert.equal(reopened.snapshot().budgets[0].totalCents, 5000); assert.equal(reopened.snapshot().unowned.keep, true);
    const remove = host.adapter.remove.bind(host.adapter), replacement = `${path}.finance-replace-backup.json`;
    host.adapter.remove = async file => { if (file === replacement) throw new Error("completed-save-cleanup-failure"); await remove(file); };
    await reopened.update(data => { data.budgets[0].totalCents = 7000; });
    assert.equal(reopened.snapshot().budgets[0].totalCents, 7000); assert.equal(JSON.parse(host.files.get(path)).budgets[0].totalCents, 7000);
    assert.equal(host.files.get(replacement), before);
  });
  await test("finance failed restoration keeps its backup and reopening recovers without overwriting a current ledger", async () => {
    const path = "custom/lifestyle.json", replacement = `${path}.finance-replace-backup.json`;
    const initial = JSON.stringify({ version: 1, unowned: { keep: true }, budgets: [] });
    const host = createHost({ [path]: initial }), store = api.mobileLifestyleStore(host.adapter, path);
    await store.initialize(); const before = JSON.stringify(store.snapshot());
    const rename = host.adapter.rename.bind(host.adapter);
    host.adapter.rename = async (from, to) => { if (to === path) throw new Error(from === replacement ? "finance-restore-failure" : "finance-install-failure"); await rename(from, to); };
    await assert.rejects(store.update(data => { data.budgets.push({ month: "2026-10", totalCents: 5000, allocations: {} }); }), error => {
      assert.match(error.message, /恢复/u); assert.ok(error.errors.some(cause => /finance-install/u.test(cause.message))); assert.ok(error.errors.some(cause => /finance-restore/u.test(cause.message))); return true;
    });
    assert.equal(host.files.has(path), false); assert.equal(host.files.get(replacement), initial);
    assert.equal(JSON.stringify(store.snapshot()), before); assert.ok(![...host.files.keys()].some(file => file.endsWith(".tmp")));
    host.adapter.rename = rename;
    const reopened = api.mobileLifestyleStore(host.adapter, path); await reopened.initialize();
    assert.equal(host.files.get(path), initial); assert.equal(host.files.has(replacement), false); assert.equal(reopened.snapshot().unowned.keep, true);
    const external = JSON.stringify({ version: 1, unowned: { external: true }, budgets: [] });
    host.files.set(path, external); host.files.set(replacement, initial);
    const current = api.mobileLifestyleStore(host.adapter, path); await current.initialize();
    assert.equal(host.files.get(path), external); assert.equal(host.files.get(replacement), initial); assert.equal(current.snapshot().unowned.external, true);
    await assert.rejects(reopened.update(data => { data.budgets = []; }), /资料已变化/u);
    assert.equal(host.files.get(path), external); assert.equal(host.files.get(replacement), initial);
  });
  await test("finance detects changes during preparation and preserves original errors when temporary cleanup fails", async () => {
    const path = "custom/lifestyle.json", initial = JSON.stringify({ version: 1, budgets: [] });
    const host = createHost({ [path]: initial }), store = api.mobileLifestyleStore(host.adapter, path); await store.initialize();
    const write = host.adapter.write.bind(host.adapter), external = '{"version":1,"external":true}';
    host.adapter.write = async (file, content) => { await write(file, content); if (file.endsWith(".tmp")) host.files.set(path, external); };
    await assert.rejects(store.update(data => { data.budgets = []; }), /资料已变化/u);
    assert.equal(host.files.get(path), external); assert.ok(![...host.files.keys()].some(file => file.endsWith(".tmp")));
    host.adapter.write = write;
    const current = api.mobileLifestyleStore(host.adapter, path); await current.initialize();
    const rename = host.adapter.rename.bind(host.adapter), remove = host.adapter.remove.bind(host.adapter);
    host.adapter.rename = async (from, to) => { if (to === path && from.endsWith(".tmp")) throw new Error("original-install-failure"); await rename(from, to); };
    host.adapter.remove = async file => { if (file.endsWith(".tmp")) throw new Error("temporary-cleanup-failure"); await remove(file); };
    await assert.rejects(current.update(data => { data.budgets = []; }), error => {
      assert.ok(error.errors.some(cause => /original-install/u.test(cause.message))); assert.ok(error.errors.some(cause => /temporary-cleanup/u.test(cause.message))); return true;
    });
    assert.equal(host.files.get(path), external);
  });
  function seed() {
    const agent = renderAgentMarkdown({ identity, styleName: getAgentTemplate("advisor").labelZh, self: agentSelfFromTemplate(getAgentTemplate("advisor"), habits) }) + "\n额外既有正文必须保留。\n";
    const memoryRecord = id => ({ schema: "echoink.memory.v1", id, kind: "fact", status: "current", title: "旧记忆独有证据", date: "2026-10-11", basis: "explicit", source: "fixture://profile-seed", recallWhen: "核对旧记忆", revision: 12, file: `shared-user/memory/facts/${id}.md` });
    const record = memoryRecord("existing-memory"), records = [{ ...record, contentHash: hash("旧记忆独有证据") }];
    const recordText = value => ["---", ...Object.entries({ schema: value.schema, id: value.id, kind: value.kind, status: value.status, date: value.date, source: value.source, basis: value.basis, title: value.title, recall_when: value.recallWhen, revision: value.revision }).map(([key, field]) => `${key}: ${JSON.stringify(field)}`), "---", "", "旧记忆独有证据", ""].join("\n");
    const forgottenPath = "shared-user/.runtime/backups/forgets/forgotten-memory-42.md";
    const user = "用户画像独有证据", memory = renderPersonalMemoryOverview({revision:12}, records);
    return { [identityPath]: JSON.stringify(identity), [agentPath]: agent, [metaPath]: JSON.stringify({ ...emptyAgentSelfMetadata(42), revision: 3, templateId: "advisor" }),
      [manifestPath]: JSON.stringify({ schemaVersion: 1, vaultId: "fixture-vault", revision: 12, records, tombstones: [{ recordId: "forgotten-memory", forgottenAt: 42, reason: "fixture", backupFile: forgottenPath, source: "ui://personal-memory-control" }], fixedFileHashes: { agent: hash(agent), user: hash(user) }, updatedAt: 42, unknownFutureField: "preserved" }),
      [root + record.file]: recordText(record), [root + forgottenPath]: recordText(memoryRecord("forgotten-memory")),
      [root + "shared-user/USER.md"]: user, [root + "shared-user/MEMORY.md"]: memory, [root + "shared-user/.runtime/audit.jsonl"]: '{"type":"initialized","revision":12}\n',
      [root + "agents/echoink/dream-state.json"]: "dream-progress-must-stay", [root + "shared-user/.runtime/search-index.json"]: '{"schemaVersion":3,"revision":12,"checksum":"original"}' };
  }
  await test("mobile profile shares Unicode habit keys with desktop SHA-256", () => {
    for (const value of ["先解释因果", "用户偏好 A", "同一条习惯😀"]) {
      const canonical = value.normalize("NFKC").toLocaleLowerCase("en-US").replaceAll(/\s+/gu, " ").trim();
      assert.equal(stableSelfKey(value), `h-${hash(canonical).slice(0, 16)}`);
    }
  });
  await test("profile initialize is explicit; same identity/template and open/cancel make zero writes", async () => {
    const host = createHost({}), protocol = new MobileProfileProtocol(host.adapter, () => 99);
    const empty = await protocol.profile(); assert.equal(empty.profile, null); assert.equal(host.writes.length, 0);
    const initial = await protocol.save({ identity: { displayName: "😀".repeat(24), avatar: { kind: "preset", presetId: "nova" } }, templateId: "advisor" }, empty.version);
    assert.equal(initial.identity.revision, 1); assert.equal(initial.templateId, "advisor"); assert.equal(host.files.has(manifestPath), false);
    const before = [...host.files]; const count = host.writes.length;
    await protocol.save({ templateId: "advisor" }, initial.version);
    await protocol.save({ identity: { displayName: initial.identity.displayName, avatar: initial.identity.avatar } }, initial.version);
    assert.deepEqual([...host.files], before); assert.equal(host.writes.length, count);
    await assert.rejects(protocol.save({ identity: { displayName: "😀".repeat(25), avatar: identity.avatar } }, initial.version), /1–24/u);
  });
  await test("identity and template transactions preserve growth and fixed-file manifest interoperability", async () => {
    const initial = seed(), host = createHost(initial), protocol = new MobileProfileProtocol(host.adapter, () => 123);
    const profile = await protocol.profile(); assert.ok(!JSON.stringify(profile).includes("echoink:current-self"));
    const renamed = await protocol.save({ identity: { displayName: "新墨墨", avatar: { kind: "preset", presetId: "lin" } } }, profile.version);
    assert.equal(renamed.identity.revision, 3); assert.equal(renamed.profile.representativeHabits[0], "长期习惯独有证据。");
    const switched = await protocol.save({ templateId: "executor" }, renamed.version);
    assert.equal(switched.identity.displayName, "新墨墨"); assert.equal(switched.templateId, "executor");
    assert.equal(parseAgentCurrentSelf(host.files.get(agentPath)).state.currentLearnedHabits[0].text, habits[0].text);
    assert.ok(host.files.get(agentPath).includes("额外既有正文必须保留"));
    const manifest = JSON.parse(host.files.get(manifestPath)); assert.equal(manifest.revision, 14); assert.equal(manifest.fixedFileHashes.agent, hash(host.files.get(agentPath)));
    assert.equal(manifest.unknownFutureField, "preserved"); assert.equal(manifest.records[0].id, "existing-memory");
    assert.equal(host.files.get(root + "shared-user/MEMORY.md"), renderPersonalMemoryOverview(manifest, manifest.records));
    for (const path of [root + "shared-user/USER.md", root + "agents/echoink/dream-state.json", root + "shared-user/.runtime/search-index.json"]) assert.equal(host.files.get(path), initial[path]);
    const audit = host.files.get(root + "shared-user/.runtime/audit.jsonl").trim().split("\n").map(JSON.parse);
    assert.equal(audit.at(-1).type, "cognitive_update"); assert.equal(audit.at(-1).revision, 14);
    assert.equal(JSON.parse(host.files.get(metaPath)).revision, 4);
  });
  await test("malformed, unsupported, missing current-self and inconsistent manifest reject writes", async () => {
    for (const [path, bytes] of [[identityPath, "{broken"], [identityPath, JSON.stringify({ ...identity, schema: "future" })], [identityPath, JSON.stringify({ ...identity, displayName: "bad\nname" })], [metaPath, '{"schema":"future"}'], [agentPath, "existing legacy prose"], [manifestPath, JSON.stringify({ schemaVersion: 2 })]]) {
      const initial = { ...seed(), [path]: bytes }, host = createHost(initial), protocol = new MobileProfileProtocol(host.adapter);
      await assert.rejects(protocol.profile()); await assert.rejects(protocol.save({ templateId: "butler" }, "invalid"));
      assert.deepEqual([...host.files], Object.entries(initial)); assert.equal(host.writes.length, 0);
    }
  });
  await test("stale editor/concurrent changes reject; failed rename restores all previous files", async () => {
    const host = createHost(seed()), protocol = new MobileProfileProtocol(host.adapter), other = new MobileProfileProtocol(host.adapter);
    const data = await protocol.profile(); const saved = await other.save({ templateId: "butler" }, data.version);
    const before = [...host.files]; await assert.rejects(protocol.save({ templateId: "companion" }, data.version), /变化/u); assert.deepEqual([...host.files], before);
    const rename = host.adapter.rename.bind(host.adapter); let failed = false;
    host.adapter.rename = async (from, to) => { if (!failed && to === metaPath) { failed = true; throw new Error("injected disk failure"); } await rename(from, to); };
    await assert.rejects(protocol.save({ templateId: "executor" }, saved.version), /injected/u); assert.deepEqual([...host.files].sort(), [...before].sort());
    assert.equal((await protocol.profile()).version, saved.version);
  });
  await test("actual mobile send reads Registry identity/four-style mapping; memory gate preserves legacy source", async () => {
    const original = seed(), host = createHost(original), store = new MobileStore(host.adapter, "plugin/mobile", "fixture-instance"); await store.load();
    const config = settings(); let services, payload;
    const runtime = new MobileRuntime(host.app, store, () => config, async request => { payload = JSON.parse(request.body); return answer("openai-completions", "ok"); }, (id, turn) => services.context(id, turn));
    services = new MobileServices({ app: host.app, settings: config, store, runtime, navigation: {}, registerEvent() {}, async saveSettings() {}, async showPage() {} }, "plugin/mobile");
    await services.initialize(); await store.setMemoryEnabled(false);
    const originalRead = host.adapter.read.bind(host.adapter), reads = [];
    host.adapter.read = async path => { reads.push(path); return originalRead(path); };
    await runtime.send("off"); const off = payload.messages.find(item => item.role === "system").content;
    assert.ok(off.includes("墨墨")); assert.ok(off.includes("先核对前提、证据和遗漏")); assert.ok(!off.includes("Nova"));
    for (const text of [habits[0].text, "用户画像独有证据", "旧记忆独有证据"]) assert.ok(!off.includes(text));
    assert.ok(!reads.some(path => /shared-user\/(USER|MEMORY)\.md$/u.test(path)));
    await store.setMemoryEnabled(true); await runtime.send("on"); const on = payload.messages.find(item => item.role === "system").content;
    for (const text of ["用户画像独有证据", "旧记忆独有证据"]) assert.ok(on.includes(text));
    assert.ok(!on.includes(habits[0].text)); assert.equal(host.files.get(agentPath), original[agentPath]);
    await services.dispose();
  });
  await test("own interrupted journal recovers; foreign owner and external writes remain untouched", async () => {
    for (const scenario of ["own", "foreign", "external"]) {
      const initial = seed(), next = JSON.stringify({ ...identity, revision: 3, displayName: "中断修改" });
      const directory = root + "shared-user/.runtime/transactions/txn_mobile_interrupted";
      const host = createHost({ ...initial, [identityPath]: scenario === "external" ? "external-content" : next,
        [`${directory}/backup/0.bak`]: initial[identityPath], [`${directory}/state`]: "applying\n",
        [`${directory}/plan.json`]: JSON.stringify({ schemaVersion: 1, ownerId: scenario === "foreign" ? "another-device" : "this-device", entries: [{ relativePath: identityPath.slice(root.length), existed: true, backupFile: "backup/0.bak", contentHash: hash(next) }] }) });
      const protocol = new MobileProfileProtocol(host.adapter, () => 99, { read: () => "this-device", create: () => "this-device" });
      if (scenario === "own") { assert.equal((await protocol.profile()).identity.displayName, "墨墨"); assert.deepEqual([...host.files].sort(), Object.entries(initial).sort()); }
      else { const before = [...host.files]; await assert.rejects(protocol.profile()); assert.deepEqual([...host.files], before); assert.equal(host.writes.length, 0); }
    }
  });
  await test("profile recovery can restart from a missing target and from a second interrupted legacy recovery", async () => {
    for (const scenario of ["parked-original", "interrupted-recovery"]) {
      const initial = seed(), next = JSON.stringify({ ...identity, revision: 3, displayName: "中断修改" });
      const directory = root + "shared-user/.runtime/transactions/txn_mobile_this-device_interrupted";
      const files = { ...initial, [`${directory}/backup/0.bak`]: initial[identityPath], [`${directory}/state`]: "applying\n",
        [`${directory}/plan.json`]: JSON.stringify({ schemaVersion: 1, ownerId: "this-device", entries: [{ relativePath: identityPath.slice(root.length), existed: true, backupFile: "backup/0.bak", contentHash: hash(next) }] }) };
      if (scenario === "parked-original") { delete files[identityPath]; files[`${directory}/replace/0.bak`] = initial[identityPath]; }
      else files[identityPath] = next;
      const host = createHost(files), owner = { read: () => "this-device", create: () => "this-device" };
      if (scenario === "interrupted-recovery") {
        const rename = host.adapter.rename.bind(host.adapter);
        host.adapter.rename = async (from, to) => { if (to === identityPath) throw new Error("second-recovery-interruption"); await rename(from, to); };
        await assert.rejects(new MobileProfileProtocol(host.adapter, () => 99, owner).profile());
        assert.equal(host.files.has(identityPath), false); assert.equal(host.files.get(`${directory}/replace/0.bak`), next);
        assert.equal(host.files.get(`${directory}/backup/0.bak`), initial[identityPath]);
        host.adapter.rename = rename;
      }
      const recovered = await new MobileProfileProtocol(host.adapter, () => 99, owner).profile();
      assert.equal(recovered.identity.displayName, "墨墨"); assert.deepEqual([...host.files].sort(), Object.entries(initial).sort());
    }
  });
  await test("preparation failure and own plan-less restart leave business files unchanged", async () => {
    const initial = seed(), host = createHost(initial);
    const owner = { read: () => "fixture-device", create: () => "fixture-device" }, protocol = new MobileProfileProtocol(host.adapter, () => 99, owner);
    const data = await protocol.profile(), write = host.adapter.write.bind(host.adapter);
    host.adapter.write = async (path, content) => { if (path.endsWith(".bak")) throw new Error("backup-preparation-failure"); await write(path, content); };
    await assert.rejects(protocol.save({ templateId: "executor" }, data.version), /backup-preparation/u); assert.deepEqual([...host.files].sort(), Object.entries(initial).sort());
    host.files.set(root + "shared-user/.runtime/transactions/txn_mobile_fixture-device_interrupted/backup/0.bak", "temporary-only");
    assert.equal((await protocol.profile()).version, data.version); assert.deepEqual([...host.files].sort(), Object.entries(initial).sort());
  });
  await test("avatar-only change keeps exact current-self bytes and active reads wait for commit", async () => {
    const initial = seed(); initial[agentPath] = initial[agentPath].replace("## 我怎样回答", "\n## 我怎样回答");
    const manifest = JSON.parse(initial[manifestPath]); manifest.fixedFileHashes.agent = hash(initial[agentPath]); initial[manifestPath] = JSON.stringify(manifest);
    const host = createHost(initial), protocol = new MobileProfileProtocol(host.adapter); const data = await protocol.profile();
    const rename = host.adapter.rename.bind(host.adapter); let release, applying;
    const started = new Promise(resolve => { applying = resolve; });
    host.adapter.rename = async (from, to) => { if (to === identityPath) { applying(); await new Promise(resolve => { release = resolve; }); } await rename(from, to); };
    const save = protocol.save({ identity: { displayName: "墨墨", avatar: { kind: "preset", presetId: "nova" } } }, data.version);
    await started; const reader = protocol.profile(); release(); const [saved, read] = await Promise.all([save, reader]);
    assert.equal(read.version, saved.version); assert.equal(host.files.get(agentPath), initial[agentPath]);
  });
}
