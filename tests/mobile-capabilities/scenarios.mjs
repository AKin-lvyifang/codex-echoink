import assert from "node:assert/strict";
import { createHost } from "../mobile/host.mjs";

export async function runMobileCapabilityScenarios(api) {
  const { MobileCapabilityPolicy, createScopedMobileBodySearch, mobileTools, MobileStore, loadMobileSettings, emptyKnowledgeFolderBindings } = api;
  const signal = () => new AbortController().signal;
  const code = expression => error => typeof error?.code === "string" && expression.test(error.code);
  const source = { "raw/来源.md": "# 来源\n共同检索词 公开资料", "journal/2026-10-19.md": "# 日记\n共同检索词 私人日记",
    "finance/transactions/账目.md": "# 财务\n共同检索词 私人账目", "outputs/英文日记/今日.md": "# 英文\n共同检索词 英文模块内容", "普通/笔记.md": "# 普通\n共同检索词 普通笔记" };
  const memory = { kind: "view", title: "偏好", content: "用户明确喜欢先说结论", recallWhen: "表达偏好", basis: "explicit" };
  async function setup({ grants = ["knowledge"], agentId = "writer", permission = "workspace-write", pro = false } = {}) {
    const host = createHost(source), store = new MobileStore(host.adapter, "plugin/mobile", "capability-fixture");
    await store.load();
    const bindings = emptyKnowledgeFolderBindings();
    for (const [role, root] of [["raw", "raw"], ["wiki", "wiki"], ["journal", "journal"], ["outputs", "outputs"]]) {
      Object.assign(bindings.roles[role], { enabled: true, readPaths: [root], writePath: root });
    }
    const settings = loadMobileSettings({ knowledgeBase: { folderBindings: bindings }, lifestyle: { finance: { enabled: true } }, englishDiary: { enabled: true }, review: { enabled: true } });
    settings.agentRegistry.agents.push({ id: "writer", name: "写作员", avatar: { kind: "default" }, position: "写文档", styleId: "analysis", capabilityIds: grants });
    await store.patchSession(store.session.id, { agentId });
    const paid = { active: pro };
    const access = { checkCapability: () => paid.active, requireCapability() { if (!paid.active) throw new Error("no pro"); }, subscribe: () => () => {} };
    const policy = new MobileCapabilityPolicy({ store, settings: () => settings, agentId, permission, proAccess: () => access });
    const search = createScopedMobileBodySearch(host.app, () => settings.knowledgeBase.folderBindings, policy);
    const tools = () => mobileTools(host.app, store, () => "raw/来源.md", () => settings.knowledgeBase.folderBindings, search, store.session.id, policy);
    const calls = { read: [], metadata: [], folders: [], create: [] };
    const read = host.app.vault.read.bind(host.app.vault), cache = host.app.metadataCache.getFileCache.bind(host.app.metadataCache);
    const folder = host.app.vault.createFolder.bind(host.app.vault), create = host.app.vault.create.bind(host.app.vault);
    host.app.vault.read = async file => { calls.read.push(file.path); return read(file); };
    host.app.metadataCache.getFileCache = file => { calls.metadata.push(file.path); return cache(file); };
    host.app.vault.createFolder = async path => { calls.folders.push(path); return folder(path); };
    host.app.vault.create = async (path, text) => { calls.create.push(path); return create(path, text); };
    return { ...host, store, settings, policy, search, tools, calls, paid, grant: settings.agentRegistry.agents.find(agent => agent.id === agentId) };
  }
  function tool(f, name) { const found = f.tools().find(item => item.name === name); assert.ok(found, `expected published ${name}`); return found; }
  let passed = 0;
  async function test(name, run) { await run(); passed++; console.log(`OK ${name}`); }

  await test("mobile v2 Memory switch remains authoritative over preserved desktop fields", async () => {
    const f = await setup();
    f.settings.memory = { useLongTermMemory: false, preserved: true };
    assert.doesNotThrow(() => f.policy.assertTool("memory_search"));
    await f.store.setMemoryEnabled(false);
    assert.throws(() => f.policy.assertTool("memory_search"), code(/memory_disabled/u));
    assert.equal(f.settings.memory.preserved, true);
    f.search.dispose();
  });

  await test("ordinary whitelist and sol disabled list gate direct tools with zero side effects", async () => {
    const f = await setup(); const writer = tool(f, "note_create");
    await assert.rejects(writer.execute("write", { path: "journal/越权.md", content: "不能写" }, signal()), code(/agent_disabled:journal/u));
    await assert.rejects(writer.execute("write", { path: "finance/transactions/越权.md", content: "不能写" }, signal()), code(/agent_disabled:finance/u));
    assert.equal(f.calls.folders.length, 0); assert.equal(f.calls.create.length, 0);
    f.grant.capabilityIds = [];
    await assert.rejects(writer.execute("write", { path: "raw/越权.md", content: "不能写" }, signal()), code(/agent_disabled:knowledge/u));
    const sol = await setup({ agentId: "sol" }), solWriter = tool(sol, "note_create");
    sol.grant.disabledCapabilityIds.push("knowledge");
    await assert.rejects(solWriter.execute("write", { path: "raw/越权.md", content: "不能写" }, signal()), code(/agent_disabled:knowledge/u));
    assert.equal(sol.calls.create.length, 0);
    f.search.dispose(); sol.search.dispose();
  });

  await test("frozen read-only and live permission revocation both stop notebook and Memory writes", async () => {
    const frozen = await setup({ permission: "read-only" });
    assert.throws(() => frozen.policy.assertTool("note_create", { path: "raw/禁止.md" }), code(/read_only/u));
    assert.throws(() => frozen.policy.assertTool("memory_write"), code(/read_only/u));
    assert.ok(!frozen.tools().some(item => item.name === "note_create" || item.name === "memory_write"));
    const live = await setup(); const write = tool(live, "note_create"), memoryWrite = tool(live, "memory_write");
    await live.store.setPermission("read-only");
    await assert.rejects(write.execute("write", { path: "raw/禁止.md", content: "禁止" }, signal()), code(/read_only/u));
    await assert.rejects(memoryWrite.execute("memory", memory, signal()), code(/read_only/u));
    assert.equal(live.calls.create.length, 0); assert.equal(live.store.state.memories.length, 0);
    live.search.dispose(); frozen.search.dispose();
  });

  await test("module switches, paid-module write eligibility and expiry are checked on the actual target", async () => {
    const f = await setup({ agentId: "sol" }); const write = tool(f, "note_create");
    await assert.rejects(write.execute("write", { path: "finance/transactions/需会员.md", content: "禁止" }, signal()), code(/pro_required/u));
    assert.doesNotThrow(() => f.policy.assertReadPath("finance/transactions/账目.md"));
    f.paid.active = true;
    await write.execute("write", { path: "finance/transactions/已授权.md", content: "已授权" }, signal());
    f.paid.active = false;
    await assert.rejects(write.execute("write", { path: "finance/transactions/已过期.md", content: "禁止" }, signal()), code(/pro_required/u));
    f.settings.lifestyle.finance.enabled = false;
    assert.throws(() => f.policy.assertReadPath("finance/transactions/账目.md"), code(/module_disabled/u));
    f.settings.knowledgeBase.folderBindings.roles.raw.enabled = false;
    await assert.rejects(write.execute("write", { path: "raw/禁止.md", content: "禁止" }, signal()), code(/module_disabled/u));
    assert.equal(f.calls.create.length, 1); f.search.dispose();
  });

  await test("Memory off, disabled Skill, unknown resources/tools and mobile PDF remain denied", async () => {
    const f = await setup({ agentId: "sol", pro: true });
    assert.equal(f.settings.resources.catalog.length, 0);
    assert.doesNotThrow(() => f.policy.assertSkill("daily-journal"));
    assert.doesNotThrow(() => f.policy.assertSkill("clarify-real-question"));
    const restricted = await setup();
    assert.throws(() => restricted.policy.assertSkill("daily-journal"), code(/agent_disabled:journal/u));
    restricted.search.dispose();
    f.settings.resources.legacyEnabledOverrides = { "daily-journal": false };
    assert.throws(() => f.policy.assertSkill("daily-journal"), code(/resource_disabled/u));
    f.settings.resources.catalog.push({ id: "built-in", kind: "skill", enabled: true, metadata: { resourceId: "daily-journal" } });
    assert.doesNotThrow(() => f.policy.assertSkill("daily-journal"));
    f.settings.resources.catalog[0].enabled = false;
    assert.throws(() => f.policy.assertSkill("daily-journal"), code(/resource_disabled/u));
    // Same first matching saved record as services.skills(), even when a later duplicate differs.
    f.settings.resources.catalog.unshift({ id: "daily-journal", kind: "skill", enabled: true });
    assert.doesNotThrow(() => f.policy.assertSkill("daily-journal"));
    f.settings.resources.catalog.shift();
    assert.throws(() => f.policy.assertSkill("unknown"), code(/unknown_resource/u));
    for (const name of ["bash", "note_delete", "todo_query", "finance_query", "mcp_execute", "web_search"]) assert.throws(() => f.policy.assertTool(name, {}), code(/unknown_tool/u));
    for (const name of ["pdf_reading_query", "pdf_reading_process"]) assert.throws(() => f.policy.assertTool(name, {}), code(/module_disabled/u));
    assert.ok(!f.tools().some(item => /pdf|finance|todo|web_search/u.test(item.name)));
    const read = tool(f, "memory_read"), write = tool(f, "memory_write");
    await f.store.setMemoryEnabled(false);
    await assert.rejects(read.execute("read", { id: "irrelevant" }, signal()), code(/memory_disabled/u));
    await assert.rejects(write.execute("write", memory, signal()), code(/memory_disabled/u));
    await assert.rejects(read.execute("read", { id: "irrelevant" }, signal()), error => {
      assert.match(error.message, /已关闭/u); assert.doesNotMatch(error.message, /agent_capability_/u);
      return code(/memory_disabled/u)(error);
    });
    assert.throws(() => new MobileCapabilityPolicy({ store: f.store, settings: () => f.settings, agentId: "sol", permission: "read-only" }).assertTool("note_create", { path: "raw/只读.md" }), error => {
      assert.match(error.message, /只读权限/u); return code(/read_only/u)(error);
    });
    assert.equal(f.store.state.memories.length, 0); f.search.dispose();
  });

  await test("unsafe paths, hidden files and rebinding to another module cannot cross grants", async () => {
    const f = await setup(), write = tool(f, "note_create");
    for (const path of ["../秘密.md", "/秘密.md", "raw/../秘密.md", "raw/.秘密.md", "C:/秘密.md", "raw\\秘密.md"]) {
      assert.equal(f.policy.canReadPath(path), false);
      await assert.rejects(write.execute("write", { path, content: "禁止" }, signal()));
    }
    const oldSignature = f.policy.signature();
    f.settings.knowledgeBase.folderBindings.roles.journal.readPaths = ["raw"];
    f.settings.knowledgeBase.folderBindings.revision++;
    assert.notEqual(f.policy.signature(), oldSignature);
    await assert.rejects(write.execute("write", { path: "raw/改绑后禁止.md", content: "禁止" }, signal()), code(/agent_disabled:journal/u));
    assert.equal(f.calls.create.length, 0); assert.equal(f.calls.folders.length, 0); f.search.dispose();
  });

  await test("revocation while exists awaits prevents mkdir/create; every later mkdir boundary is checked", async () => {
    const f = await setup(), write = tool(f, "note_create"), exists = f.adapter.exists.bind(f.adapter);
    f.adapter.exists = async path => { if (path.endsWith("禁止.md")) f.grant.capabilityIds = []; return exists(path); };
    await assert.rejects(write.execute("write", { path: "raw/新目录/禁止.md", content: "禁止" }, signal()), code(/agent_disabled/u));
    assert.equal(f.calls.folders.length, 0); assert.equal(f.calls.create.length, 0);
    f.grant.capabilityIds = ["knowledge"];
    const mkdir = f.app.vault.createFolder;
    f.app.vault.createFolder = async path => { await mkdir(path); f.grant.capabilityIds = []; };
    await assert.rejects(write.execute("write", { path: "新目录/次级/禁止2.md", content: "禁止" }, signal()), code(/agent_disabled/u));
    assert.deepEqual(f.calls.folders, ["新目录"]); assert.equal(f.calls.create.length, 0); f.search.dispose();
  });

  await test("memory_write rechecks current permission and Memory toggle inside the real store queue", async () => {
    for (const field of ["permission", "memoryEnabled"]) {
      const f = await setup(), write = tool(f, "memory_write");
      const first = field === "permission" ? f.store.setPermission("read-only") : f.store.setMemoryEnabled(false);
      const second = write.execute("memory", memory, signal());
      await first;
      await assert.rejects(second, code(field === "permission" ? /read_only/u : /memory_disabled/u));
      assert.equal(f.store.state.memories.length, 0); f.search.dispose();
    }
  });

  await test("body pre-search reads/indexes only authorized candidates and yields empty material to chat-only Agents", async () => {
    const f = await setup(); const found = await f.search.search({ query: "共同检索词", limit: 20 });
    assert.ok(found.hits.some(hit => hit.vaultRelativePath === "raw/来源.md"));
    for (const forbidden of ["journal/2026-10-19.md", "finance/transactions/账目.md", "outputs/英文日记/今日.md"]) {
      assert.ok(!f.calls.read.includes(forbidden)); assert.ok(!f.calls.metadata.includes(forbidden));
      assert.ok(!found.hits.some(hit => hit.vaultRelativePath === forbidden));
    }
    const none = await setup({ grants: [] }); const empty = await none.search.search({ query: "共同检索词" });
    assert.equal(empty.hits.length, 0); assert.equal(none.calls.read.length, 0); assert.equal(none.calls.metadata.length, 0);
    assert.doesNotThrow(() => none.policy.assertTool("task_update")); assert.doesNotThrow(() => none.policy.assertTool("user_question"));
    f.search.dispose(); none.search.dispose();
  });

  await test("search caches and note_read cannot return previously authorized material after in-flight revocation", async () => {
    const f = await setup(); await f.search.search({ query: "共同检索词" });
    f.grant.capabilityIds = [];
    assert.equal((await f.search.search({ query: "共同检索词" })).hits.length, 0);
    f.grant.capabilityIds = ["knowledge"]; const reader = tool(f, "note_read"), read = f.app.vault.read;
    f.app.vault.read = async file => { const text = await read(file); f.grant.capabilityIds = []; return text; };
    await assert.rejects(reader.execute("read", { path: "raw/来源.md" }, signal()), code(/agent_disabled/u));
    assert.equal((await f.search.search({ query: "共同检索词" })).hits.length, 0);
    f.search.dispose(); await assert.rejects(f.search.search({ query: "共同检索词" }), /disposed/u);
  });

  await test("policy signatures cover live authority without credentials and snapshots cannot grant rights", async () => {
    const f = await setup(), initial = f.policy.signature(), snapshot = f.policy.snapshot();
    assert.equal(snapshot.agentId, "writer"); assert.ok(Object.isFrozen(snapshot));
    f.settings.unrelatedProviderKey = "never-in-signature";
    assert.equal(f.policy.signature(), initial);
    Object.assign(f.grant, { name: "改名", position: "新职位", styleId: "creative", avatar: { kind: "preset", presetId: "aya" } });
    assert.equal(f.policy.signature(), initial);
    assert.ok(!f.policy.signature().includes("never-in-signature"));
    for (const change of [() => { f.paid.active = true; }, () => { f.settings.englishDiary.enabled = false; },
      () => { f.settings.resources.catalog.push({ id: "skill", kind: "skill", enabled: false }); }, () => { f.settings.knowledgeBase.folderBindings.revision++; },
      () => { f.grant.capabilityIds = []; }]) {
      const before = f.policy.signature(); change(); assert.notEqual(f.policy.signature(), before);
    }
    assert.deepEqual([...snapshot.capabilityIds], ["knowledge"]);
    assert.throws(() => f.policy.assertTool("note_create", { path: "raw/禁止.md" }), code(/agent_disabled/u)); f.search.dispose();
  });

  await test("legacy direct fixture calls default safely to sol and do not grant non-sol or paid writes", async () => {
    const f = await setup({ agentId: "sol" });
    const tools = mobileTools(f.app, f.store, () => "raw/来源.md", () => f.settings.knowledgeBase.folderBindings);
    await assert.rejects(tools.find(item => item.name === "note_create").execute("write", { path: "finance/禁止.md", content: "禁止" }, signal()), code(/module_disabled|pro_required/u));
    await f.store.patchSession(f.store.session.id, { agentId: "writer" });
    assert.equal(mobileTools(f.app, f.store, () => "raw/来源.md").length, 0); f.search.dispose();
  });
  console.log(`${passed} mobile capability checks passed (real tool executors, store queue and body index; memory fixtures).`);
}
