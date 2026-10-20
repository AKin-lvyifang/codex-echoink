import assert from "node:assert/strict";
import vm from "node:vm";
import http from "node:http";
import { webcrypto } from "node:crypto";
import esbuild from "esbuild";
import { mobileBuildOptions } from "./mobile-build.mjs";

// Production modules in a browser bundle; synthetic data and a real loopback HTTP
// MCP server only. No Vault files, production keys, or third-party service calls.
const build = await esbuild.build({ ...mobileBuildOptions("tests/mobile-capabilities-settings/entry.ts"), metafile: true });
assert.ok(!Object.keys(build.metafile.inputs).some(file => /mcp-broker|skill-runtime\.ts|pi-ai\/dist\/providers\//u.test(file)));
const module = { exports: {} };
vm.runInNewContext(build.outputFiles[0].text, { module, exports: module.exports, URL, TextEncoder, TextDecoder, AbortController,
  structuredClone, crypto: webcrypto, setTimeout, clearTimeout, require: name => { assert.equal(name, "obsidian"); return {
    requestUrl: () => { throw new Error("Unexpected third-party request"); }, Notice: class {}, TFile: class {}, TFolder: class {}
  }; } });
const { MobileCapabilitiesService, MobileCapabilityPolicy, MobileHttpMcpClient, MobileRuntime, MobileStore, loadMobileSettings, mobileModel, mobileProvider,
  inspectMobileTaskResume, inspectMobileMcpTools, skillIcon, mobileMcpToolName } = module.exports;
const plain = value => JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
let passed = 0;
async function test(name, run) { await run(); console.log(`OK ${++passed} ${name}`); }
function adapterFixture() {
  const files = new Map(); let failInstall = false;
  return { files, failNextInstall: () => { failInstall = true; }, adapter: {
    exists: async path => files.has(path), read: async path => { if (!files.has(path)) throw new Error("missing"); return files.get(path); },
    write: async (path, content) => { files.set(path, content); }, mkdir: async path => { files.set(path, "directory"); },
    remove: async path => { files.delete(path); }, rename: async (from, to) => {
      if (failInstall && from.endsWith(".tmp")) { failInstall = false; throw new Error("fixture install failure"); }
      if (files.has(to) || !files.has(from)) throw new Error("rename conflict"); files.set(to, files.get(from)); files.delete(from);
    }
  } };
}
function fixture(request, persist = async () => {}, realStore = false) {
  const f = adapterFixture(), settings = loadMobileSettings({}), sessions = new Map();
  const provider = mobileProvider("custom"); Object.assign(provider, { apiKey: "synthetic-provider-key", baseUrl: "https://model.invalid/v1", models: [mobileModel("fixture")], defaultModelId: "fixture" });
  settings.apiProviders = [provider]; settings.activeApiProviderId = provider.id; settings.defaultModel = "fixture";
  const store = realStore ? new MobileStore(f.adapter, "plugin/mobile", "capabilities-restart-fixture") : { permission: "workspace-write", memoryEnabled: true, state: { memories: [], sessions: [] },
    getSession: id => sessions.get(id), flush: async () => {}, updateSession: async (id, change) => { const current = structuredClone(sessions.get(id)); change(current); sessions.set(id, current); } };
  const policy = id => new MobileCapabilityPolicy({ store, settings: () => settings, agentId: id ?? "sol" });
  const service = new MobileCapabilitiesService({ adapter: f.adapter, settings: () => settings, saveSettings: () => persist(settings), policy, request });
  return { ...f, service, settings, store, sessions, policy, provider };
}
await test("18 builtin icons, real empty custom list, disabled configuration remains readable/editable", async () => {
  const f = fixture(async () => { throw new Error("No network"); });
  const skills = await f.service.listSkills(); assert.equal(skills.length, 18); assert.equal(new Set(skills.map(item => item.icon)).size, 18);
  assert.equal(skillIcon("todo-operations"), "list-todo"); assert.equal(skillIcon("custom"), "sparkles");
  const original = await f.service.readSkill("daily-journal"); assert.equal(original.contentPath, null); assert.match(original.sourceLabel, /内置/u);
  await f.service.setSkillEnabled("daily-journal", false); assert.equal((await f.service.readSkill("daily-journal")).enabled, false);
  assert.throws(() => f.policy().assertSkill("daily-journal"));
  const changed = await f.service.saveSkill(original.id, `${original.content}\nCustom`, original.version); assert.match(changed.content, /Custom$/u); assert.ok(changed.contentPath);
  const writes = f.files.size; assert.ok(f.service.defaultSkillContent("daily-journal")); assert.equal(f.files.size, writes);
  assert.throws(() => f.policy().assertSkill("obsidian-cli")); assert.equal(skills.find(item => item.id === "obsidian-cli").mobileAvailable, false);
});
await test("Skill Agent rows retain configured grants while global/runtime availability changes", async () => {
  const f = fixture(), sol = f.settings.agentRegistry.agents.find(agent => agent.id === "sol");
  f.settings.agentRegistry.agents.push({ ...plain(sol), id: "journal-granted", name: "Journal", capabilityIds: ["journal"] },
    { ...plain(sol), id: "journal-not-granted", name: "Other", capabilityIds: ["knowledge"] });
  const granted = snapshot => plain(snapshot.agents.filter(agent => agent.allowed).map(agent => agent.id));
  const before = await f.service.readSkill("daily-journal"); assert.deepEqual(granted(before), ["sol", "journal-granted"]);
  await f.service.setSkillEnabled("daily-journal", false);
  const disabled = await f.service.readSkill("daily-journal"); assert.deepEqual(granted(disabled), granted(before));
  assert.throws(() => f.policy("journal-granted").assertSkill("daily-journal"));
  sol.disabledCapabilityIds = ["journal"]; assert.deepEqual(granted(await f.service.readSkill("daily-journal")), ["journal-granted"]);
  await f.service.setSkillEnabled("daily-journal", true);
  f.settings.mobileUi.moduleEnabled = { journal: false };
  assert.deepEqual(granted(await f.service.readSkill("daily-journal")), ["journal-granted"]);
  assert.throws(() => f.policy("journal-granted").assertSkill("daily-journal"));
  const desktopOnly = await f.service.readSkill("obsidian-cli"); assert.equal(desktopOnly.mobileAvailable, false); assert.equal(desktopOnly.agents.find(agent => agent.id === "sol").allowed, true);
  assert.throws(() => f.policy().assertSkill("obsidian-cli"));
});
await test("Skill external edit conflict, failed atomic install restores original, retry retains custom metadata", async () => {
  const f = fixture(); const path = "Skills/custom/SKILL.md";
  f.files.set(path, "Original"); f.settings.resources.catalog.push({ id: "custom", kind: "skill", source: "manual", enabled: false, name: "Mine", description: "Custom", bridgeMode: "prompt-only", contentPath: path, metadata: { future: true } });
  const original = await f.service.readSkill("custom"); f.files.set(path, "Other editor");
  await assert.rejects(f.service.saveSkill("custom", "Mine", original.version), /其他位置修改/u); assert.equal(f.files.get(path), "Other editor");
  const current = await f.service.readSkill("custom"); f.failNextInstall(); await assert.rejects(f.service.saveSkill("custom", "Mine", current.version)); assert.equal(f.files.get(path), "Other editor");
  await f.service.saveSkill("custom", "Mine", current.version); assert.equal(f.files.get(path), "Mine"); assert.equal(f.service.defaultSkillContent("custom"), null);
  assert.equal(f.settings.resources.catalog[0].metadata.future, true);
});
await test("Skill usage writes actual counters, configuration reads never count, malformed state preserved", async () => {
  const f = fixture(); await f.service.readSkill("daily-journal"); assert.equal(f.files.has(".echoink/resources/skill-state.json"), false);
  await f.service.recordSkillUse("daily-journal"); await f.service.recordSkillUse("daily-journal");
  const path = ".echoink/resources/skill-state.json"; assert.equal(JSON.parse(f.files.get(path)).records["daily-journal"].usageCount, 2);
  f.files.set(path, "broken"); await assert.rejects(f.service.recordSkillUse("daily-journal")); assert.equal(f.files.get(path), "broken");
});
await test("existing Skill usage changes only count/time and preserves all owned/unknown metadata", async () => {
  const f = fixture(), path = ".echoink/resources/skill-state.json";
  const record = { status: "active", usageCount: 7, lastUsedAt: null, contentHash: "preserved", userModified: false, semanticFingerprint: "old-contract", futureMetadata: { keep: true } };
  f.files.set(path, JSON.stringify({ schema: "echoink.skill-runtime.v1", unowned: { keep: true }, records: { "finance-analysis": record } }));
  await Promise.all([f.service.recordSkillUse("finance-analysis"), f.service.recordSkillUse("finance-analysis")]);
  const state = JSON.parse(f.files.get(path)), after = state.records["finance-analysis"];
  assert.equal(after.usageCount, 9); assert.equal(typeof after.lastUsedAt, "number");
  assert.deepEqual({ ...after, usageCount: record.usageCount, lastUsedAt: record.lastUsedAt }, record); assert.deepEqual(state.unowned, { keep: true });
});
await test("Skill reads and saves an interrupted replacement from its preserved recovery copy", async () => {
  const f = fixture(), path = ".echoink/resources/skills/daily-journal/SKILL.md", recovery = `${path}.finance-replace-backup.json`;
  f.files.set(recovery, "Preserved user instruction");
  const snapshot = await f.service.readSkill("daily-journal"); assert.equal(snapshot.content, "Preserved user instruction"); assert.equal(snapshot.contentPath, recovery);
  await f.service.saveSkill("daily-journal", "Updated user instruction", snapshot.version); assert.equal(f.files.get(path), "Updated user instruction"); assert.equal(f.files.has(recovery), false);
});
await test("targeted setting rollback preserves drafts and unrelated fields", async () => {
  const f = fixture(undefined, async settings => { settings.unrelated = "kept"; throw new Error("synthetic-secret"); });
  await assert.rejects(f.service.setSkillEnabled("daily-journal", false), /保存失败/u); assert.equal((await f.service.readSkill("daily-journal")).enabled, true); assert.equal(f.settings.unrelated, "kept");
  const draft = f.service.readTavily(); draft.apiKey = "synthetic-tavily-key"; draft.enabled = true;
  await assert.rejects(f.service.saveTavily(draft), error => /保存失败/u.test(error.message) && !error.message.includes(draft.apiKey));
  assert.equal(f.service.readTavily().apiKey, ""); assert.equal(draft.apiKey, "synthetic-tavily-key");
});

const requests = [], gates = new Map(); let nextMode = "normal", actualValue = "", sessions = 0;
const schema = { type: "object", properties: { value: { type: "string" } } };
const rawTools = [
  { name: "read_item", description: "Read", inputSchema: schema, annotations: { readOnlyHint: true } },
  { name: "write_item", description: "Write", inputSchema: schema, _meta: { "echoink/readback": { toolName: "read_item", argumentMap: { value: "value" }, assertions: [{ resultPath: "structuredContent.value", argumentKey: "value" }] } } },
  { name: "unknown_write", description: "No readback", inputSchema: schema }
];
const server = http.createServer(async (req, res) => {
  let bytes = ""; for await (const chunk of req) bytes += chunk;
  const body = JSON.parse(bytes), entry = { body, headers: req.headers }; requests.push(entry);
  const respond = result => { if (!res.writableEnded) { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result })); } };
  if (body.method === "initialize") { sessions++; res.setHeader("Mcp-Session-Id", `fixture-${sessions}`); respond({ protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "controlled-loopback", version: "1" } }); }
  else if (body.method === "notifications/initialized") { res.writeHead(202).end(); }
  else if (body.method === "notifications/cancelled") { const pending = gates.get("pending"); pending?.resolve(); res.writeHead(202).end(); }
  else if (body.method === "tools/list") {
    if (nextMode === "invalid") { nextMode = "normal"; respond({ tools: [{ name: "bad", inputSchema: { type: "string" } }] }); }
    else respond(body.params.cursor ? { tools: rawTools.slice(1) } : { tools: rawTools.slice(0, 1), nextCursor: "page-2" });
  } else if (body.method === "tools/call") {
    if (nextMode === "typed-values") {
      nextMode = "normal"; respond({ content: [{ type: "text", text: "1" }], structuredContent: { count: 1, ratio: 1.5, ready: true, empty: null, list: [1, "1", false, null] } }); return;
    }
    if (nextMode === "echo-secret" || nextMode === "echo-error") {
      const isError = nextMode === "echo-error", secret = String(req.headers.authorization).replace(/^Bearer /u, ""); nextMode = "normal";
      respond({ content: [{ type: "text", text: secret }], structuredContent: { [secret]: secret, nested: [{ value: `prefix ${secret} suffix` }] }, ...(isError ? { isError: true } : {}) }); return;
    }
    if (nextMode === "slow") { nextMode = "normal"; const pending = deferred(); gates.set("pending", pending); gates.get("arrived")?.resolve(); await pending.promise; gates.delete("pending"); }
    if (body.params.name !== "read_item") actualValue = body.params.arguments.value;
    respond({ content: [{ type: "text", text: "OK" }], structuredContent: { value: actualValue } });
  } else { res.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${server.address().port}/mcp`;
let afterResponse;
const transport = async input => {
  const response = await fetch(input.url, { method: input.method, headers: input.headers, body: input.body }); const text = await response.text();
  const value = { status: response.status, headers: Object.fromEntries(response.headers), text, get json() { return text ? JSON.parse(text) : undefined; } };
  afterResponse?.(JSON.parse(input.body)); return value;
};
async function connected(f, token = "synthetic-mcp-key") {
  let draft = await f.service.createMcpDraft(); draft.name = "Controlled service"; draft.url = url; draft.headers = { Authorization: `Bearer ${token}` };
  draft = await f.service.discoverMcp(draft); draft.trusted = true;
  for (const tool of draft.tools) draft.toolPolicies[tool.name] = { enabled: true, trusted: true };
  await f.service.saveMcp(draft); return draft.id;
}
try {
  await test("real HTTP initialize/session headers/paginated discovery/save/runtime call", async () => {
    const f = fixture(transport), id = await connected(f), before = requests.length;
    const response = await f.service.callMcp(id, "read_item", {}, f.policy()); assert.equal(response.result.structuredContent.value, actualValue);
    assert.deepEqual(requests.slice(before).map(row => row.body.method), ["initialize", "notifications/initialized", "tools/list", "tools/list", "tools/call"]);
    assert.ok(requests.slice(before + 1).every(row => row.headers["mcp-session-id"]));
    const summaries = await f.service.listMcp(); assert.equal(summaries[0].status, "connected"); assert.equal(summaries[0].headers, undefined);
    assert.equal(f.service.runtimeTools(f.policy(), async input => (await input.call()).result).filter(tool => tool.name.startsWith("mcp_")).length, 3);
    const draft = await f.service.createMcpDraft(id), stale = plain(draft); draft.name = "Updated"; await f.service.saveMcp(draft);
    await assert.rejects(f.service.saveMcp(stale), /其他位置修改/u);
  });
  await test("each live revocation blocks the next action and HTTP call count proves it", async () => {
    for (const revoke of [f => { f.settings.resources.catalog[0].enabled = false; }, f => { f.settings.resources.mcpConnections[f.id].toolPolicies.read_item.enabled = false; },
      f => { f.settings.agentRegistry.agents[0].disabledCapabilityIds = [`mcp:${encodeURIComponent(f.id)}:read_item`]; }]) {
      const f = fixture(transport); f.id = await connected(f); const before = requests.length; revoke(f);
      await assert.rejects(f.service.callMcp(f.id, "read_item", {}, f.policy())); assert.equal(requests.length, before);
    }
    const f = fixture(transport), id = await connected(f), before = requests.length;
    afterResponse = body => { if (body.method === "tools/list" && !body.params.cursor) f.settings.resources.catalog[0].enabled = false; };
    await assert.rejects(f.service.callMcp(id, "read_item", {}, f.policy())); afterResponse = undefined;
    assert.deepEqual(requests.slice(before).map(row => row.body.method), ["initialize", "notifications/initialized", "tools/list"]);
    const g = fixture(transport), gid = await connected(g); g.store.permission = "read-only";
    const count = requests.length; await assert.rejects(g.service.callMcp(gid, "write_item", { value: "blocked" }, g.policy())); assert.equal(requests.length, count);
  });
  await test("endpoint/authentication edits require discovery and reset server/tool trust", async () => {
    const f = fixture(transport), id = await connected(f), draft = await f.service.createMcpDraft(id);
    draft.headers.Authorization = "Bearer synthetic-replacement-key";
    await assert.rejects(f.service.saveMcp(draft), /重新连接/u);
    const discovered = await f.service.discoverMcp(draft); assert.equal(discovered.trusted, false);
    assert.ok(Object.values(discovered.toolPolicies).every(policy => policy.trusted === false));
    await f.service.saveMcp(discovered); assert.equal(f.service.runtimeTools(f.policy(), async () => {}).length, 0);
  });
  await test("cancel stops an active HTTP call, emits MCP cancellation, and never dispatches a next action", async () => {
    const f = fixture(transport), id = await connected(f), controller = new AbortController(), arrived = deferred(); gates.set("arrived", arrived); nextMode = "slow";
    const pending = f.service.callMcp(id, "read_item", {}, f.policy(), controller.signal); await arrived.promise; const before = requests.length; controller.abort();
    await assert.rejects(pending, /停止/u); await tick(); await tick();
    assert.ok(requests.slice(before).some(row => row.body.method === "notifications/cancelled"));
    assert.ok(!requests.slice(before).some(row => row.body.method === "tools/call"));
    await assert.rejects(f.service.callMcp(id, "read_item", {}, f.policy(), controller.signal));
    gates.delete("arrived");
  });
  await test("malformed tool discovery is rejected; stdio/unknown fields and desktop credentials survive", async () => {
    const f = fixture(transport), id = await connected(f), original = f.settings.resources.mcpConnections[id];
    original.future = { keep: true }; original.credential = { credentialRef: "desktop-only", purpose: "mcp_header", targetName: "Authorization", endpointRevision: 1 };
    const draft = await f.service.createMcpDraft(id); draft.name = "Preserved"; await f.service.saveMcp(draft); assert.equal(f.settings.resources.mcpConnections[id].future.keep, true); assert.equal(f.settings.resources.mcpConnections[id].credential.credentialRef, "desktop-only");
    nextMode = "invalid"; await assert.rejects(new MobileHttpMcpClient({ url }, transport).discover(), /格式|名称/u);
    f.settings.resources.catalog.push({ id: "local", kind: "mcp-server", name: "Local", source: "manual", enabled: true, description: "", bridgeMode: "native-mcp" });
    f.settings.resources.mcpConnections.local = { transport: "stdio", command: "keep", env: { TOKEN: "synthetic" }, tools: [], trusted: true, toolPolicies: {} };
    const local = await f.service.createMcpDraft("local"); assert.equal(local.readonly, true); await assert.rejects(f.service.saveMcp(local), /电脑/u); assert.equal(f.settings.resources.mcpConnections.local.env.TOKEN, "synthetic");
    assert.throws(() => inspectMobileMcpTools([{ name: "bad", inputSchema: { type: "string" } }]));
  });
  function runtimeFixture(f, id) {
    const policy = f.policy(), turn = { id: "run-1", agentSnapshot: policy.snapshot(), permission: "workspace-write", notePath: "" };
    const run = { taskId: "task", turn, policy, signature: policy.signature(), provider: f.provider, model: f.provider.models[0], controller: new AbortController() };
    f.sessions.set("task", { id: "task", messages: [], runs: [{ id: turn.id, status: "running", startedAt: Date.now() }] });
    const runtime = new MobileRuntime({ vault: { adapter: f.adapter } }, f.store, () => f.settings, transport);
    const question = { execute: async (_id, args) => ({ details: { answers: [{ questionId: args.questions[0].questionId, selectedOptionIds: ["approve"] }] } }) };
    return { runtime, run, policy, tools: f.service.runtimeTools(policy, input => runtime.invokeRemoteTool(run, input, question)), id };
  }
  await test("runtime MCP writes persist intent, verify readback, and reject repeated write calls", async () => {
    const f = fixture(transport), id = await connected(f), r = runtimeFixture(f, id), write = r.tools.find(tool => tool.name === mobileMcpToolName(id, "write_item"));
    const answer = await write.execute("write-1", { value: "verified" }, r.run.controller.signal); assert.equal(answer.details.writeResult, "verified");
    assert.equal(f.sessions.get("task").operations[0].status, "completed"); const before = requests.length;
    await assert.rejects(write.execute("write-2", { value: "verified" }, r.run.controller.signal), /不能重复/u); assert.equal(requests.length, before);
    const snapshot = await inspectMobileTaskResume({ vault: { adapter: f.adapter } }, f.store, "task"); assert.equal(snapshot.issues.length, 0);
  });
  await test("unknown external writes survive recovery and cannot replay after user review", async () => {
    const f = fixture(transport), id = await connected(f), r = runtimeFixture(f, id), write = r.tools.find(tool => tool.name === mobileMcpToolName(id, "unknown_write"));
    const answer = await write.execute("unknown-1", { value: "unknown" }, r.run.controller.signal); assert.equal(answer.details.writeResult, "unknown");
    const snapshot = await inspectMobileTaskResume({ vault: { adapter: f.adapter } }, f.store, "task"); assert.equal(snapshot.issues.length, 1); assert.match(snapshot.issues[0].label, /外部 MCP/u);
    r.run.resume = snapshot; const before = requests.length; await assert.rejects(write.execute("unknown-2", { value: "unknown" }, r.run.controller.signal)); assert.equal(requests.length, before);
    assert.ok(!JSON.stringify(f.sessions.get("task").operations).includes("synthetic-mcp-key"));
  });
  await test("real MobileStore commits MCP intent, cold-loads unknown facts, and runtime resume blocks replay", async () => {
    const f = fixture(transport, undefined, true); await f.store.load();
    const id = await connected(f), taskId = f.store.session.id, policy = f.policy(), app = { vault: { adapter: f.adapter } };
    const turn = { id: "durable-run", agentSnapshot: policy.snapshot(), permission: "workspace-write", notePath: "" };
    const run = { taskId, turn, policy, signature: policy.signature(), provider: f.provider, model: f.provider.models[0], controller: new AbortController() };
    await f.store.updateSession(taskId, task => { task.runs = [{ id: turn.id, status: "running", startedAt: Date.now() }]; task.taskStatus = "running"; });
    const statuses = [], originalWrite = f.adapter.write;
    f.adapter.write = async (path, bytes) => {
      if (path.startsWith(f.store.statePath)) { const parsed = JSON.parse(bytes), operation = parsed.sessions.find(task => task.id === taskId)?.operations?.[0]; if (operation) statuses.push(operation.status); }
      await originalWrite(path, bytes);
    };
    const question = { execute: async (_id, args) => ({ details: { answers: [{ questionId: args.questions[0].questionId, selectedOptionIds: ["approve"] }] } }) };
    const runtime = new MobileRuntime(app, f.store, () => f.settings, transport);
    const write = f.service.runtimeTools(policy, input => runtime.invokeRemoteTool(run, input, question)).find(tool => tool.name === mobileMcpToolName(id, "unknown_write"));
    await write.execute("durable-write", { value: "cold-start-effect" }, run.controller.signal);
    assert.deepEqual(statuses, ["prepared", "started", "uncertain"]);
    const persisted = JSON.parse(f.files.get(f.store.statePath)), operation = persisted.sessions.find(task => task.id === taskId).operations[0];
    assert.equal(operation.status, "uncertain"); assert.deepEqual(operation.mcp, { resourceId: id, toolName: "unknown_write" });
    assert.ok(!JSON.stringify(operation).includes("synthetic-mcp-key"));
    const before = requests.length, restarted = new MobileStore(f.adapter, "plugin/mobile", f.store.instanceId); await restarted.load();
    assert.deepEqual(plain(restarted.getSession(taskId).operations[0]), operation);
    const coldRuntime = new MobileRuntime(app, restarted, () => f.settings, transport);
    await assert.rejects(coldRuntime.resumeTask(taskId), error => error.code === "mobile_resume_review_required");
    const snapshot = coldRuntime.stateFor(taskId).resumeReview; assert.equal(snapshot.issues.length, 1); assert.match(snapshot.issues[0].label, /外部 MCP/u);
    assert.equal(requests.length, before, "cold start and resume review must issue no HTTP requests");
    const coldPolicy = new MobileCapabilityPolicy({ store: restarted, settings: () => f.settings, agentId: "sol" });
    const coldTurn = { ...turn, id: "reviewed-new-run" }, coldRun = { ...run, turn: coldTurn, policy: coldPolicy, signature: coldPolicy.signature(), resume: snapshot };
    await restarted.updateSession(taskId, task => { task.runs.push({ id: coldTurn.id, status: "running", startedAt: Date.now() }); });
    const coldService = new MobileCapabilitiesService({ adapter: f.adapter, settings: () => f.settings, saveSettings: async () => {}, policy: () => coldPolicy, request: transport });
    const repeated = coldService.runtimeTools(coldPolicy, input => coldRuntime.invokeRemoteTool(coldRun, input, question)).find(tool => tool.name === mobileMcpToolName(id, "unknown_write"));
    await assert.rejects(repeated.execute("new-call-id", { value: "cold-start-effect" }, coldRun.controller.signal), /不能重复|不能重放/u);
    assert.equal(requests.length, before);
  });
  await test("quoted/backslash credentials echoed over HTTP never enter runtime/model output or durable messages", async () => {
    const absent = (value, secret) => {
      if (typeof value === "string") assert.ok(!value.includes(secret), "credential string reached a consumer");
      else if (Array.isArray(value)) value.forEach(item => absent(item, secret));
      else if (value && typeof value === "object") for (const [key, item] of Object.entries(value)) { assert.ok(!key.includes(secret), "credential object key reached a consumer"); absent(item, secret); }
    };
    for (const secret of ['synthetic-quote-"-token', "synthetic-backslash-\\-token", 'synthetic-both-"-\\-token']) {
      const f = fixture(transport, undefined, true); await f.store.load(); const id = await connected(f, secret), taskId = f.store.session.id, policy = f.policy();
      const app = { vault: { adapter: f.adapter } }, runtime = new MobileRuntime(app, f.store, () => f.settings, transport);
      const run = { taskId, turn: { id: "redaction-run", agentSnapshot: policy.snapshot(), permission: "workspace-write", notePath: "" }, policy,
        signature: policy.signature(), provider: f.provider, model: f.provider.models[0], controller: new AbortController() };
      const read = f.service.runtimeTools(policy, input => runtime.invokeRemoteTool(run, input, {})).find(tool => tool.name === mobileMcpToolName(id, "read_item"));
      nextMode = "echo-secret"; const received = await read.execute("redacted-call", {}, run.controller.signal);
      absent(received.details, secret); received.content.forEach(block => absent(JSON.parse(block.text), secret));
      assert.equal(received.details.content[0].text, "[redacted]"); assert.equal(received.details.structuredContent["[redacted]"], "[redacted]");
      await f.store.updateSession(taskId, task => { task.messages.push({ role: "toolResult", toolName: read.name, toolCallId: "redacted-call", content: received.content, details: received.details, isError: false, timestamp: 1 }); });
      const restarted = new MobileStore(f.adapter, "plugin/mobile", f.store.instanceId); await restarted.load();
      absent(restarted.getSession(taskId).messages, secret); restarted.getSession(taskId).messages[0].content.forEach(block => absent(JSON.parse(block.text), secret));
      nextMode = "echo-error"; await assert.rejects(read.execute("redacted-error", {}, run.controller.signal), error => { absent(error.message, secret); return /执行失败/u.test(error.message); });
      absent(await f.service.listMcp(), secret);
    }
  });
  await test("a numeric-looking header secret redacts text while preserving JSON numbers/booleans/null", async () => {
    const client = new MobileHttpMcpClient({ url, headers: { "X-Tenant-ID": "1" } }, transport); await client.discover();
    nextMode = "typed-values"; const response = await client.callTool("read_item", {});
    assert.equal(response.content[0].text, "[redacted]");
    assert.deepEqual(plain(response.structuredContent), { count: 1, ratio: 1.5, ready: true, empty: null, list: [1, "[redacted]", false, null] });
  });
  await test("revocation after external dispatch blocks readback and persists unknown effect", async () => {
    const f = fixture(transport), id = await connected(f), r = runtimeFixture(f, id), write = r.tools.find(tool => tool.name === mobileMcpToolName(id, "write_item"));
    afterResponse = body => { if (body.method === "tools/call" && body.params.name === "write_item") f.settings.resources.mcpConnections[id].toolPolicies.read_item.enabled = false; };
    const before = requests.length;
    await assert.rejects(write.execute("revoked-write", { value: "sent-before-revocation" }, r.run.controller.signal)); afterResponse = undefined;
    assert.deepEqual(requests.slice(before).filter(row => row.body.method === "tools/call").map(row => row.body.params.name), ["write_item"]);
    assert.equal(f.sessions.get("task").operations[0].status, "uncertain");
  });
  await test("simultaneous remote calls have separate HTTP sessions and no shared receipt", async () => {
    const f = fixture(transport), id = await connected(f), before = requests.length;
    const responses = await Promise.all([f.service.callMcp(id, "read_item", { value: "one" }, f.policy()), f.service.callMcp(id, "read_item", { value: "two" }, f.policy())]);
    assert.equal(responses.length, 2);
    const calls = requests.slice(before).filter(row => row.body.method === "tools/call");
    assert.equal(new Set(calls.map(row => row.headers["mcp-session-id"])).size, 2); assert.deepEqual(calls.map(row => row.body.params.arguments.value).sort(), ["one", "two"]);
  });
} finally { afterResponse = undefined; gates.get("pending")?.resolve(); await new Promise(resolve => server.close(resolve)); }
await test("MobileStore accepts all external effect stages and strictly rejects malformed/foreign fields on load", async () => {
  const f = fixture(undefined, undefined, true); await f.store.load(); const taskId = f.store.session.id, hash = "a".repeat(64);
  await f.store.updateSession(taskId, task => { task.runs = [{ id: "stage-run", status: "running", startedAt: 1 }]; });
  for (const status of ["prepared", "started", "completed", "uncertain"]) {
    await f.store.updateSession(taskId, task => { task.operations = [{ id: "external-op", taskId, runId: "stage-run", toolCallId: "stage-call", toolName: "mcp_write",
      mcp: { resourceId: "remote-service", toolName: "write_item" }, target: "remote-service/write_item", semanticKey: `mcp_write:remote-service/write_item:${hash}`,
      expectedHash: hash, status, createdAt: 1, updatedAt: 2 }]; });
    const loaded = new MobileStore(f.adapter, "plugin/mobile", f.store.instanceId); await loaded.load(); assert.equal(loaded.getSession(taskId).operations[0].status, status);
  }
  const valid = f.files.get(f.store.statePath);
  for (const mutate of [operation => { delete operation.mcp; }, operation => { operation.mcp.headers = { Authorization: "forbidden" }; },
    operation => { operation.mcp.resourceId = ""; }, operation => { operation.mcp.toolName = 1; }, operation => { operation.mcp.toolName = "write\nitem"; },
    operation => { operation.target = "another-service/write_item"; }, operation => { operation.semanticKey = "mcp_write:mismatch"; },
    operation => { operation.targetWasMissing = true; }, operation => { operation.beforeRevision = 1; }, operation => { operation.completedRevision = 1; },
    operation => { operation.toolName = "memory_write"; }, operation => { operation.arguments = { secret: "forbidden" }; }]) {
    const damaged = JSON.parse(valid); mutate(damaged.sessions.find(task => task.id === taskId).operations[0]); const bytes = JSON.stringify(damaged); f.files.set(f.store.statePath, bytes);
    const loaded = new MobileStore(f.adapter, "plugin/mobile", f.store.instanceId); await assert.rejects(loaded.load(), /数据格式无法读取/u); assert.equal(f.files.get(f.store.statePath), bytes);
  }
});
await test("transport failures are safe, timeout settles, SSE works and expired sessions never replay", async () => {
  for (const status of [401, 503]) await assert.rejects(new MobileHttpMcpClient({ url }, async () => ({ status, json: { message: "synthetic-mcp-secret" } })).discover(), error => !error.message.includes("synthetic-mcp-secret"));
  await assert.rejects(new MobileHttpMcpClient({ url }, async () => { throw new Error("synthetic-mcp-secret"); }).discover(), error => !error.message.includes("synthetic-mcp-secret"));
  await assert.rejects(new MobileHttpMcpClient({ url }, () => new Promise(() => {}), 1).discover(), /超时/u);
  const methods = [], client = new MobileHttpMcpClient({ url }, async input => {
    const body = JSON.parse(input.body); methods.push(body.method);
    if (body.method === "tools/call") return { status: 404, json: {} };
    if (body.method === "notifications/initialized") return { status: 202, json: undefined };
    const result = body.method === "initialize" ? { protocolVersion: "2025-03-26", capabilities: {} } : { tools: [] };
    return { status: 200, headers: { "mcp-session-id": "sse-session" }, text: `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result })}\n\n`, get json() { throw new Error("SSE, not JSON"); } };
  });
  await client.discover(); await assert.rejects(client.callTool("read_item", {}), /失效/u); assert.equal(methods.filter(method => method === "tools/call").length, 1);
  const secret = "synthetic-header-secret", echo = new MobileHttpMcpClient({ url, headers: { Authorization: `Bearer ${secret}` } }, async input => {
    const body = JSON.parse(input.body); return { status: 200, json: { jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: secret }] } } };
  });
  assert.ok(!JSON.stringify(await echo.callTool("read_item", {})).includes(secret));
});
await test("Tavily uses real production request shape, no missing-key request, safe results and runtime revocation", async () => {
  const calls = [], key = "synthetic-tavily-secret", f = fixture(async input => { calls.push(input); return { status: 200, json: { results: [{ title: key, url: "https://example.com", content: `Result ${key}` }] } }; });
  await assert.rejects(f.service.testTavily(f.service.readTavily()), /API Key/u); assert.equal(calls.length, 0);
  const draft = f.service.readTavily(); Object.assign(draft, { enabled: true, apiKey: key }); await f.service.saveTavily(draft);
  const tool = f.service.runtimeTools(f.policy(), async () => {}).find(tool => tool.name === "web_search"); assert.ok(tool);
  const response = await tool.execute("search", { query: "fixture" }); assert.equal(calls[0].url, "https://api.tavily.com/search"); assert.equal(calls[0].headers.Authorization, `Bearer ${key}`);
  assert.deepEqual(JSON.parse(calls[0].body), { query: "fixture", search_depth: "basic", auto_parameters: false, max_results: 5, include_answer: false, include_raw_content: false });
  assert.ok(!JSON.stringify(response).includes(key)); f.settings.tavily.enabled = false;
  await assert.rejects(tool.execute("search-2", { query: "blocked" })); assert.equal(calls.length, 1);
});
console.log(`OK ${passed} mobile capabilities settings tests; controlled loopback HTTP only; third-party MCP/Tavily unverified`);
