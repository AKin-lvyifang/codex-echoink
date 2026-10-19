import assert from "node:assert/strict";

export async function runAgentScenarios(api) {
  const { MobileAgentRegistryService, loadMobileSettings, defaultAgentRegistry, AGENT_TEMPLATES, renderAgentMarkdown, agentSelfFromTemplate } = api;
  const path = name => `.echoink/agents/echoink/${name}`;
  const json = value => JSON.stringify(value);
  const plain = value => JSON.parse(json(value));
  const identity = (displayName = "旧名字", avatar = { kind: "preset", presetId: "lin" }) => ({ schema: "echoink.agent-identity.v1", revision: 2, displayName, avatar, updatedAt: 123 });
  const metadata = templateId => ({ schema: "echoink.agent-self-meta.v1", templateId });
  const personality = templateId => ({ schema: "echoink.personality.v2", templateId });
  function setup(initial = {}, raw = {}) {
    const files = new Map(Object.entries(initial)), before = new Map(files), reads = [];
    const settings = loadMobileSettings(raw);
    let saved, writes = 0, fail = false, hold;
    const adapter = { exists: async name => files.has(name), read: async name => { reads.push(name); return files.get(name); },
      write: async () => { throw new Error("legacy write forbidden"); }, remove: async () => { throw new Error("legacy remove forbidden"); } };
    const service = new MobileAgentRegistryService(adapter, settings, async candidate => {
      writes++;
      if (hold) await hold();
      if (fail) throw new Error("fixture save failed");
      saved = json({ ...settings, agentRegistry: candidate });
    });
    return { files, before, settings, service, reads, get saved() { return saved; }, get writes() { return writes; },
      fail(value) { fail = value; }, hold(value) { hold = value; }, unchanged() { assert.deepEqual(files, before); } };
  }
  let passed = 0;
  async function test(name, run) { await run(); passed++; console.log(`OK ${name}`); }

  await test("fresh install: only sol, one initialization and no legacy writes", async () => {
    const f = setup();
    await Promise.all([f.service.initialize(), f.service.profile(), f.service.context(false)]);
    assert.equal(f.writes, 1);
    const snapshot = await f.service.snapshot(), profile = await f.service.profile();
    assert.equal(snapshot.registry.agents.length, 1);
    assert.equal(snapshot.registry.agents[0].id, "sol");
    assert.equal(profile.identity.displayName, "总助");
    assert.equal(profile.identity.avatar.presetId, "sol");
    assert.equal(profile.templateId, "executor");
    assert.equal(profile.profile.representativeHabits.length, 0);
    assert.ok(Object.values(snapshot.registry.moduleOwners).every(owner => owner === "sol"));
    const reopened = setup({}, JSON.parse(f.saved));
    assert.equal((await reopened.service.profile()).version, profile.version);
    f.unchanged();
  });

  const expected = { executor: ["execution", "executor"], pragmatist: ["execution", "executor"], advisor: ["analysis", "advisor"],
    butler: ["analysis", "advisor"], companion: ["companion", "companion"], steward: ["companion", "companion"], creative: ["creative", "creative"], enthusiast: ["creative", "creative"] };
  for (const [template, [style, representative]] of Object.entries(expected)) await test(`legacy template ${template}: formal metadata outranks personality and preserves source`, async () => {
    const f = setup({ [path("agent-identity.json")]: json(identity()), [path("agent-self-meta.json")]: json(metadata(template)),
      [path("personality-state.json")]: json(personality("creative")), [path("AGENT.md")]: "原人格正文与后天习惯必须原样保留" });
    const profile = await f.service.profile();
    assert.equal(profile.identity.displayName, "旧名字");
    assert.equal(profile.identity.avatar.presetId, "lin");
    assert.equal(profile.templateId, representative);
    assert.equal(f.settings.agentRegistry.agents[0].styleId, style);
    assert.equal(profile.profile.representativeHabits.length, 0);
    assert.ok(!f.reads.includes(path("personality-state.json")));
    assert.ok(!f.reads.includes(path("AGENT.md")));
    assert.ok(!(await f.service.context(true)).includes("后天习惯"));
    f.unchanged();
  });

  for (const value of [null, "future-template"]) await test(`unselected/unknown metadata (${value}): execution fallback`, async () => {
    const f = setup({ [path("agent-self-meta.json")]: json(metadata(value)), [path("personality-state.json")]: json(personality("creative")) });
    assert.equal((await f.service.profile()).templateId, "executor");
    assert.ok(!f.reads.includes(path("personality-state.json")));
    f.unchanged();
  });

  for (const broken of ["{", "null", "[]", json({ schema: "unknown", templateId: "creative" })]) await test(`damaged/unknown metadata is authoritative: ${broken}`, async () => {
    const f = setup({ [path("agent-self-meta.json")]: broken, [path("personality-state.json")]: json(personality("creative")) });
    assert.equal((await f.service.profile()).templateId, "executor");
    assert.ok(!f.reads.includes(path("personality-state.json")));
    f.unchanged();
  });

  await test("missing metadata falls back to personality; present damaged personality blocks markdown fallback", async () => {
    for (const [source, representative] of [[json(personality("butler")), "advisor"], ["{", "executor"]]) {
      const f = setup({ [path("personality-state.json")]: source, [path("AGENT.md")]: "unread authoritative predecessor" });
      assert.equal((await f.service.profile()).templateId, representative);
      assert.ok(!f.reads.includes(path("AGENT.md")));
      f.unchanged();
    }
  });

  await test("AGENT markdown is the final template fallback, without reading learned habits into context", async () => {
    for (const template of AGENT_TEMPLATES) {
      const markdown = renderAgentMarkdown({ identity: identity(), styleName: template.labelZh, self: agentSelfFromTemplate(template) });
      const f = setup({ [path("AGENT.md")]: markdown });
      assert.equal((await f.service.profile()).templateId, expected[template.id][1]);
      assert.equal((await f.service.profile()).profile.representativeHabits.length, 0);
      f.unchanged();
    }
    const f = setup({ [path("AGENT.md")]: "unrecognized user content" });
    await assert.rejects(f.service.initialize(), /原资料已保留/u);
    assert.equal(f.writes, 0); f.unchanged();
  });

  await test("desktop legacy projection v1/v2 and unselected/default markdown use the same template mapping", async () => {
    const expressions = ["## 表达方式", "", "- 语言自然、具体、克制。", "- 详略服从当前任务，不固定成长短模板。",
      "- 二级事实（llm-inferred-reference）只能作为系统推理参考，不得表述为用户亲口确认。", ""];
    for (const v2 of [false, true]) for (const template of [...AGENT_TEMPLATES, null]) {
      const markdown = ["# EchoInk Agent", "", template
        ? `> 初始模板：${template.labelZh}。人格由 EchoInk 依据模板与有效长期 Memory 自动生成，不由用户直接编辑。`
        : "> 人格由 EchoInk 依据有效长期 Memory 自动生成，不由用户直接编辑。", "",
      ...(v2 ? ["## 身份", "", "- 当前名称：旧名字", "- 名称由用户在 EchoInk 设置中指定；人格与长期要求仍由模板和有效 Memory 自动生成。", ""] : []),
      "## 当前人格", "", v2 ? "- 创意度（中等）：保持变化" : "- 思维：保持变化", "",
      "## 从长期协作中学到的要求", "", "- 旧习惯不得进入新上下文", "", ...expressions].join("\n");
      const f = setup({ [path("AGENT.md")]: markdown });
      assert.equal((await f.service.profile()).templateId, template ? expected[template.id][1] : "executor");
      assert.ok(!(await f.service.context(true)).includes("旧习惯"));
      f.unchanged();
      const broken = setup({ [path("AGENT.md")]: markdown.replace("- 语言自然、具体、克制。", "损坏投影") });
      await assert.rejects(broken.service.initialize(), /原资料已保留/u); assert.equal(broken.writes, 0); broken.unchanged();
    }
    const staticMarkdown = ["# EchoInk Agent", "", "EchoInk 是同一 Vault 中持续协作的一位个人 Agent。", "", "## 表达", "",
      "- 先理解当前目标，再决定是否需要历史。", "- 真实、克制，有证据时才提醒、纠正或反对。", ""].join("\n");
    assert.equal((await setup({ [path("AGENT.md")]: staticMarkdown }).service.profile()).templateId, "executor");
    const template = AGENT_TEMPLATES[0];
    const modern = renderAgentMarkdown({ identity: identity(), styleName: template.labelZh, self: agentSelfFromTemplate(template) });
    const broken = setup({ [path("AGENT.md")]: modern.replace("<!-- echoink:current-self:end -->", "") });
    await assert.rejects(broken.service.initialize(), /原资料已保留/u); broken.unchanged();
  });

  await test("unknown Registry version and source I/O failure cannot write defaults or cut over", async () => {
    const unknown = setup({}, { agentRegistry: { schemaVersion: 99, agents: [{ id: "old" }] } });
    await assert.rejects(unknown.service.initialize(), /原资料已保留/u); assert.equal(unknown.writes, 0);
    const settings = loadMobileSettings({}); const before = json(settings.agentRegistry); let writes = 0;
    const unreadable = new MobileAgentRegistryService({ exists: async () => true, read: async () => { throw new Error("adapter read failed"); } }, settings, async () => { writes++; });
    await assert.rejects(unreadable.initialize(), /adapter read failed/u);
    assert.equal(json(settings.agentRegistry), before); assert.equal(writes, 0);
  });

  await test("damaged formal identity refuses cutover and identity switching, preserving every source", async () => {
    for (const broken of ["{", "null", "[]", json({ ...identity(), schema: "future" }), json({ ...identity(), revision: -1 }), json(identity("bad\nname")), json(identity("名字", { kind: "custom" }))]) {
      const f = setup({ [path("agent-identity.json")]: broken, [path("agent-self-meta.json")]: json(metadata("creative")) });
      const before = json(f.settings.agentRegistry);
      await assert.rejects(f.service.initialize(), /原资料已保留/u);
      await assert.rejects(f.service.save({ identity: { displayName: "覆盖", avatar: { kind: "default" } } }, "unused"), /原资料已保留/u);
      assert.equal(json(f.settings.agentRegistry), before); assert.equal(f.writes, 0); f.unchanged();
    }
  });

  await test("persisted Registry (including default-looking or edited identity) outranks any changed/broken legacy source", async () => {
    for (const edited of [false, true]) {
      const registry = defaultAgentRegistry();
      if (edited) Object.assign(registry.agents[0], { name: "Registry名字", styleId: "creative", identityEdited: true });
      const f = setup({ [path("agent-identity.json")]: "{", [path("agent-self-meta.json")]: "{" }, { agentRegistry: registry });
      assert.equal((await f.service.profile()).identity.displayName, edited ? "Registry名字" : "总助");
      assert.equal(f.reads.length, 0);
      f.files.set(path("agent-identity.json"), json(identity("后来旧名字")));
      assert.equal((await f.service.profile()).identity.displayName, edited ? "Registry名字" : "总助");
    }
    const registry = defaultAgentRegistry(); registry.agents[0].identityEdited = true;
    const f = setup({ [path("agent-identity.json")]: "{" }); f.settings.agentRegistry = registry;
    assert.equal((await f.service.profile()).identity.displayName, "总助"); assert.equal(f.reads.length, 0);
  });

  await test("legacy page save: canonical name/avatar/style and context stay consistent after reopen", async () => {
    const f = setup({ [path("agent-identity.json")]: json(identity()), [path("agent-self-meta.json")]: json(metadata("companion")),
      ".echoink/shared-user/USER.md": "共享用户画像", ".echoink/shared-user/MEMORY.md": "共享长期记忆" });
    const initial = await f.service.profile();
    const saved = await f.service.save({ identity: { displayName: "新名字😀", avatar: { kind: "preset", presetId: "aya" } }, templateId: "butler" }, initial.version);
    assert.equal(saved.templateId, "advisor");
    assert.equal(f.settings.agentRegistry.agents[0].name, "新名字😀");
    assert.equal(f.settings.agentRegistry.agents[0].identityEdited, true);
    assert.notEqual(saved.version, initial.version);
    const reopened = setup(Object.fromEntries(f.files), JSON.parse(f.saved));
    assert.deepEqual(plain(await reopened.service.profile()), plain(saved));
    const context = await reopened.service.context(true);
    assert.match(context, /新名字😀/u); assert.match(context, /aya/u); assert.match(context, /先核对前提/u);
    assert.match(context, /共享用户画像/u); assert.match(context, /共享长期记忆/u);
    const noMemory = await reopened.service.context(false);
    assert.ok(!noMemory.includes("共享用户画像")); assert.ok(!noMemory.includes("共享长期记忆"));
    assert.equal(reopened.reads.filter(name => name.includes("/agents/")).length, 0);
    assert.ok(!Object.keys(f.settings.agentRegistry.agents[0]).includes("templateId")); f.unchanged();
  });

  await test("settings preserve desktop taskWorkspace and unknown fields during Registry persistence", async () => {
    const taskWorkspace = { schemaVersion: 99, tasks: [{ id: "desktop", unknown: [1, { untouched: true }] }], current: "desktop" };
    const f = setup({}, { taskWorkspace, futureUnknown: { preserve: "原样" }, mobileUi: { futureControl: true, reports: { futureReport: { preserve: true } } } });
    assert.equal(f.settings.taskWorkspace, taskWorkspace);
    const profile = await f.service.profile();
    await f.service.save({ templateId: "creative" }, profile.version);
    const saved = JSON.parse(f.saved);
    assert.deepEqual(saved.taskWorkspace, taskWorkspace); assert.deepEqual(saved.futureUnknown, { preserve: "原样" });
    assert.equal(saved.mobileUi.futureControl, true); assert.deepEqual(saved.mobileUi.reports.futureReport, { preserve: true });
  });

  await test("save failure rolls Registry back, initialization retries, and queued CAS rejects stale edits", async () => {
    const f = setup(); f.fail(true);
    const fresh = json(f.settings.agentRegistry);
    await assert.rejects(f.service.initialize(), /fixture save failed/u);
    assert.equal(json(f.settings.agentRegistry), fresh);
    f.fail(false); const profile = await f.service.profile();
    f.fail(true);
    await assert.rejects(f.service.save({ templateId: "creative" }, profile.version), /fixture save failed/u);
    assert.deepEqual(plain(await f.service.profile()), plain(profile));
    f.fail(false);
    let release, started;
    const writing = new Promise(resolve => { started = resolve; });
    f.hold(() => { started(); return new Promise(resolve => { release = resolve; }); });
    const first = f.service.save({ templateId: "creative" }, profile.version);
    await writing;
    assert.equal(json(f.settings.agentRegistry), json(JSON.parse(f.saved).agentRegistry));
    assert.equal(f.settings.agentRegistry.agents[0].styleId, "execution");
    const stale = f.service.save({ templateId: "companion" }, profile.version);
    release(); await first;
    await assert.rejects(stale, /配置已变化/u);
    f.hold(undefined);
    assert.equal((await f.service.profile()).templateId, "creative");
  });

  await test("pending/failed Registry saves never expose candidate identity to unrelated settings writes", async () => {
    const f = setup(); const initial = await f.service.profile();
    let start, release;
    const writing = new Promise(resolve => { start = resolve; });
    f.fail(true); f.hold(() => { start(); return new Promise(resolve => { release = resolve; }); });
    const saving = f.service.save({ identity: { displayName: "尚未保存", avatar: { kind: "preset", presetId: "aya" } } }, initial.version);
    await writing;
    // A different settings control snapshots committed settings while the candidate is pending.
    const unrelatedSaved = json({ ...f.settings, customWelcomeTitle: "同时保存欢迎语" });
    assert.equal(JSON.parse(unrelatedSaved).agentRegistry.agents[0].name, "总助");
    release(); await assert.rejects(saving, /fixture save failed/u);
    assert.equal((await f.service.profile()).identity.displayName, "总助");
    const reopened = setup({}, JSON.parse(unrelatedSaved));
    assert.equal((await reopened.service.profile()).identity.displayName, "总助");
    f.hold(undefined); f.fail(false);
    const saved = await f.service.save({ identity: { displayName: "已保存", avatar: { kind: "preset", presetId: "aya" } } }, initial.version);
    assert.equal(f.settings.agentRegistry.agents[0].name, "已保存");
    assert.deepEqual(plain(await setup({}, JSON.parse(f.saved)).service.profile()), plain(saved));
  });

  await test("Registry CRUD, owner uniqueness, snapshots and general assistant protection", async () => {
    const f = setup(); let snapshot = await f.service.snapshot();
    snapshot.registry.agents[0].name = "must not leak";
    assert.equal((await f.service.profile()).identity.displayName, "总助");
    snapshot = await f.service.createAgent({ id: "researcher", name: "研究员", avatar: { kind: "preset", presetId: "lin" }, position: "资料研究", styleId: "analysis", capabilityIds: ["web-search"] }, snapshot.version);
    snapshot = await f.service.setOwner("knowledge-base", "researcher", snapshot.version);
    assert.equal(snapshot.registry.moduleOwners["knowledge-base"], "researcher");
    snapshot = await f.service.patchAgent("researcher", { name: "新研究员", styleId: "creative" }, snapshot.version);
    assert.match(await f.service.context(false, "researcher"), /新研究员/u);
    await assert.rejects(f.service.setOwner("finance", "missing", snapshot.version), /agent_module_owner_invalid/u);
    await assert.rejects(f.service.removeAgent("sol", snapshot.version), /general_assistant_cannot_be_deleted/u);
    await assert.rejects(f.service.update(draft => { draft.agents = []; }, snapshot.version), /general_assistant_cannot_be_deleted/u);
    // Synthetic empty-task precondition: caller has no runs/tasks left to hand off.
    snapshot = await f.service.removeAgent("researcher", snapshot.version);
    assert.equal(snapshot.registry.agents.length, 1);
    assert.equal(snapshot.registry.moduleOwners["knowledge-base"], "sol");
    await assert.rejects(f.service.context(false, "researcher"), /agent_not_found/u);
  });
  console.log(`${passed} mobile Agent Registry checks passed (memory adapter; no UI, Provider or Vault).`);
}
