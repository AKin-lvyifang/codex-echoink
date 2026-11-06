import assert from "node:assert/strict";
import vm from "node:vm";
import { webcrypto } from "node:crypto";
import esbuild from "esbuild";
import { mobileBuildOptions } from "./mobile-build.mjs";

// All fixtures and bundles remain in memory; no Vault or network is accessed.
const build = await esbuild.build({ ...mobileBuildOptions("tests/mobile-model-settings/entry.ts"), metafile: true });
assert.ok(!Object.keys(build.metafile.inputs).some(file => /pi-provider-configuration-service|settings\/pi-model-catalog|node_modules\/@earendil-works\/pi-ai\/dist\/providers\//u.test(file)));
const module = { exports: {} };
let fastTimeout = false;
const fixtureSetTimeout = (callback, delay, ...args) => setTimeout(callback, fastTimeout && delay === 20_000 ? 1 : delay, ...args);
vm.runInNewContext(build.outputFiles[0].text, {
  module, exports: module.exports, URL, TextEncoder, TextDecoder, AbortController, structuredClone, crypto: webcrypto,
  // Production uses window timers (Obsidian review rule); this VM has no DOM.
  window: { setTimeout: fixtureSetTimeout, clearTimeout }, setTimeout: fixtureSetTimeout, clearTimeout,
  require: name => { assert.equal(name, "obsidian"); return { requestUrl: () => { throw new Error("Unexpected real request"); } }; }
});
const { MobileModelConfiguration, MOBILE_MODEL_GROUPS, validateMobileModelParameters, loadMobileSettings, mobileProvider, mobileModel, mobilePresets, mobileStreamingEnabled, supportedProvider, piModel, buildMobileRequest, mobileGenerateText, mobileStream, visibleReasoning, MOBILE_STREAM_BLOCKED } = module.exports;
const plain = value => JSON.parse(JSON.stringify(value));
const answer = (protocol = "openai-completions") => ({ status: 200, json: protocol === "openai-responses"
  ? { output: [{ type: "message", content: [{ type: "output_text", text: "OK" }] }], status: "completed" }
  : { choices: [{ message: { role: "assistant", content: "OK" }, finish_reason: "stop" }] } });
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const turn = () => new Promise(resolve => setTimeout(resolve, 0));
function fixture({ protocol = "openai-completions", request = async () => answer(protocol), persist = async () => {} } = {}) {
  const provider = mobileProvider("custom");
  Object.assign(provider, { name: "Fixture", baseUrl: "https://models.example/v1", apiKey: "synthetic-fixture-key", models: [mobileModel("one"), mobileModel("two")], defaultModelId: "one", apiProtocol: protocol });
  const settings = loadMobileSettings({ apiProviders: [provider], activeApiProviderId: provider.id, defaultModel: "one", unrelated: { keep: true } });
  let saves = 0, calls = [];
  const save = async () => { saves++; await persist(settings); };
  const config = new MobileModelConfiguration(() => settings, save, async input => { calls.push(input); return await request(input); });
  return { provider, settings, config, save, calls, counts: () => ({ saves, calls: calls.length }) };
}
let passed = 0;
async function test(name, run) { await run(); console.log(`OK ${++passed} ${name}`); }

await test("six addable presets and legacy API-key compatibility preserve stored desktop providers", () => {
  assert.deepEqual(plain(MOBILE_MODEL_GROUPS.flatMap(group => group.ids)), ["glm", "kimi", "deepseek", "qwen", "qwen-token-plan", "custom"]);
  assert.deepEqual(plain(mobilePresets.map(preset => preset.id)), ["glm", "kimi", "deepseek", "qwen", "qwen-token-plan", "custom"]);
  const f = fixture();
  for (const providerId of ["openai-codex", "anthropic", "minimax", "ollama"]) assert.equal(supportedProvider({ ...f.provider, providerId }), false);
  for (const providerId of ["openai", "custom", undefined]) assert.equal(supportedProvider({ ...f.provider, providerId }), true);
  assert.equal(supportedProvider({ ...f.provider, authMode: "oauth" }), false);
  const raw = { ...f.provider, providerId: "ollama", extra: { keep: true } };
  assert.deepEqual(plain(loadMobileSettings({ apiProviders: [raw] }).apiProviders), plain([raw]));
  assert.equal(loadMobileSettings({}).autoOpenHome, false);
  assert.equal(loadMobileSettings({ autoOpenHome: true }).autoOpenHome, true);
  assert.equal(loadMobileSettings({ autoOpenHome: "true" }).autoOpenHome, false);
});
await test("tool calling migrates unknown and ID-only discovery while preserving declared and manual false", () => {
  const base = mobileModel("uncatalogued");
  const models = [
    { ...base, metadataSource: "unknown", toolCalling: false },
    { ...base, metadataSource: "discovery", discovery: { id: base.id }, toolCalling: false },
    { ...base, metadataSource: "discovery", discovery: { id: base.id, toolCalling: false }, toolCalling: false },
    { ...base, capabilityOverrides: { toolCalling: false }, toolCalling: false },
    { ...base, toolCalling: false },
    { ...base, capabilityOverrides: { reasoning: false }, toolCalling: false },
    { ...base, metadataSource: "preset", toolCalling: false },
    { ...base, metadataSource: "catalog", toolCalling: false }
  ];
  const raw = { apiProviders: [{ ...mobileProvider("custom"), extra: { keep: true }, models }] };
  const before = plain(raw), once = loadMobileSettings(raw);
  assert.deepEqual(plain(once.apiProviders[0].models.map(model => model.toolCalling)), [true, true, false, false, false, true, false, false]);
  assert.deepEqual(plain(raw), before, "loading cannot mutate its saved input");
  assert.deepEqual(plain(loadMobileSettings(once).apiProviders), plain(once.apiProviders));
  assert.deepEqual(plain(once.apiProviders[0].extra), { keep: true });
});
await test("explicit recovery saves only the target capability fields without connection testing or changing defaults", async () => {
  const f = fixture(); const target = { providerSettingsId: f.provider.id, modelId: "two" };
  f.settings.apiProviders[0].models[1].toolCalling = false;
  f.settings.apiProviders[0].models[1].capabilityOverrides = { reasoning: false, toolCalling: false };
  delete f.settings.providerMode;
  const before = plain(f.settings), expected = plain(before);
  expected.apiProviders[0].models[1].toolCalling = true;
  expected.apiProviders[0].models[1].capabilityOverrides.toolCalling = true;
  await f.config.enableToolCalling(target);
  assert.deepEqual(plain(f.settings), expected); assert.deepEqual(f.counts(), { saves: 1, calls: 0 });
  await f.config.enableToolCalling(target); assert.deepEqual(f.counts(), { saves: 1, calls: 0 });
});
await test("recovery settings save failure restores the original capability and unrelated settings", async () => {
  const f = fixture({ persist: async () => { throw new Error("synthetic save failure"); } });
  f.settings.apiProviders[0].models[1].toolCalling = false;
  const before = plain(f.settings);
  await assert.rejects(f.config.enableToolCalling({ providerSettingsId: f.provider.id, modelId: "two" }), /设置保存失败/u);
  assert.deepEqual(plain(f.settings), before); assert.equal(f.calls.length, 0);
});
await test("recovery and normal model selection share the existing settings queue", async () => {
  const gate = deferred(); const f = fixture({ persist: async () => { await gate.promise; } });
  f.settings.apiProviders[0].models[1].toolCalling = false;
  const enabling = f.config.enableToolCalling({ providerSettingsId: f.provider.id, modelId: "two" });
  const selecting = f.config.selectDefault(f.provider.id, "two");
  await turn(); assert.equal(f.settings.defaultModel, "one"); assert.equal(f.counts().saves, 1);
  gate.resolve(); await Promise.all([enabling, selecting]);
  assert.equal(f.settings.defaultModel, "two"); assert.equal(f.settings.apiProviders[0].models[1].toolCalling, true);
  assert.deepEqual(f.counts(), { saves: 2, calls: 0 });
});
await test("GET discovery uses shared URL/parser, metadata and unknown old model fields survive", async () => {
  const f = fixture({ request: async () => ({ status: 200, json: { data: [{ id: "one", context_window: 256000, supports_tool_calling: false }, { id: "new", name: "New", context_window: 64000, max_output_tokens: 1024, supports_reasoning: true }], has_more: true } }) });
  f.provider.models[0].unknown = { retained: true }; f.provider.models[0].limitsOverride = { maxOutputTokens: 1000 };
  f.provider.queryParams = { version: "fixture" };
  const before = plain(f.provider), result = await f.config.fetchModels(f.provider);
  assert.equal(result.incomplete, true); assert.equal(result.models.length, 2);
  assert.equal(f.calls[0].method, "GET"); assert.equal(f.calls[0].url, "https://models.example/v1/models?version=fixture");
  assert.equal(f.calls[0].headers.Authorization, `Bearer ${f.provider.apiKey}`);
  assert.equal(result.models[0].contextWindow, before.models[0].contextWindow);
  assert.deepEqual(plain(result.models[0].unknown), { retained: true });
  assert.equal(result.models[1].maxOutputTokens, 1024); assert.equal(result.models[1].reasoningEnabled, true);
  assert.deepEqual(plain(f.provider), before); assert.equal(f.counts().saves, 0);
});
await test("empty discovery is valid and does not modify configured models", async () => {
  const f = fixture({ request: async () => ({ status: 200, json: { data: [] } }) });
  assert.deepEqual(plain(await f.config.fetchModels(f.provider)), { models: [], incomplete: false }); assert.equal(f.provider.models.length, 2);
});
for (const [name, response, message] of [
  ["401", { status: 401, json: { error: { message: "synthetic-fixture-key" } } }, /API Key/u],
  ["403", { status: 403, json: {} }, /API Key/u],
  ["429", { status: 429, json: {} }, /频繁/u],
  ["503", { status: 503, json: {} }, /不可用/u],
  ["404", { status: 404, json: {} }, /404/u],
  ["bad format", { status: 200, json: { models: [] } }, /格式/u]
]) await test(`discovery ${name} reports a safe actionable error`, async () => {
  const f = fixture({ request: async () => response });
  await assert.rejects(f.config.fetchModels(f.provider), error => message.test(error.message) && !error.message.includes(f.provider.apiKey));
});
await test("network errors never expose an echoed API key", async () => {
  const f = fixture({ request: async () => { throw new Error("synthetic-fixture-key"); } });
  await assert.rejects(f.config.fetchModels(f.provider), error => /网络/u.test(error.message) && !error.message.includes(f.provider.apiKey));
});
await test("an invalid JSON getter cannot leak response content or an echoed key", async () => {
  const f = fixture({ request: async () => ({ status: 200, get json() { throw new Error("Invalid JSON: synthetic-fixture-key"); } }) });
  await assert.rejects(f.config.fetchModels(f.provider), error => /格式/u.test(error.message) && !error.message.includes(f.provider.apiKey));
});
await test("discovery timeout settles, late completion cannot replace a retry", async () => {
  const pending = deferred(); let first = true;
  const f = fixture({ request: async () => { if (first) { first = false; return pending.promise; } return { status: 200, json: { data: [{ id: "retry" }] } }; } });
  fastTimeout = true;
  try { await assert.rejects(f.config.fetchModels(f.provider), /超时/u); } finally { fastTimeout = false; }
  assert.equal((await f.config.fetchModels(f.provider)).models[0].id, "retry");
  pending.resolve({ status: 200, json: { data: [{ id: "late" }] } }); await turn();
  assert.equal(f.provider.models[0].id, "one");
});
await test("duplicate discovery coalesces and changed fields invalidate an old result", async () => {
  const pending = deferred(), f = fixture({ request: () => pending.promise });
  const first = f.config.fetchModels(f.provider), duplicate = f.config.fetchModels(f.provider);
  assert.equal(first, duplicate); assert.equal(f.counts().calls, 1);
  f.provider.apiKey = "different-synthetic-key";
  pending.resolve({ status: 200, json: { data: [{ id: "stale" }] } });
  await assert.rejects(first, /已变更/u);
});
await test("a newer discovery request wins when responses finish out of order", async () => {
  const old = deferred(), latest = deferred(); let calls = 0;
  const f = fixture({ request: () => (++calls === 1 ? old.promise : latest.promise) });
  const draft = f.config.createDraft(f.provider), first = f.config.fetchModels(draft); draft.baseUrl = "https://next.example/v1";
  const second = f.config.fetchModels(draft);
  latest.resolve({ status: 200, json: { data: [{ id: "latest" }] } }); assert.equal((await second).models[0].id, "latest");
  old.resolve({ status: 200, json: { data: [{ id: "old" }] } }); await assert.rejects(first, /已变更/u);
});
await test("model parameter bounds match desktop contract and reject invalid preferences", () => {
  for (const value of [1024, 2_000_000]) validateMobileModelParameters({ ...mobileModel("ok"), contextWindow: value, maxOutputTokens: 1 });
  for (const [key, values] of [["contextWindow", [1023, 2_000_001, NaN, 1.5]], ["modelMaxTokens", [0, 1_000_001]], ["maxOutputTokens", [0, 8193, Infinity]], ["id", ["", "white space", "x".repeat(257)]], ["reasoningEffort", ["none", "invalid"]]]) {
    for (const value of values) assert.throws(() => validateMobileModelParameters({ ...mobileModel("ok"), [key]: value }));
  }
  assert.throws(() => validateMobileModelParameters({ ...mobileModel("ok"), limitsOverride: { contextWindow: 1023 } }));
  assert.throws(() => validateMobileModelParameters({ ...mobileModel("ok"), input: ["image"] }));
  assert.throws(() => validateMobileModelParameters({ ...mobileModel("ok"), reasoningEnabled: true }));
});
for (const protocol of ["openai-completions", "openai-responses"]) await test(`${protocol} saves only after a minimal real transport request`, async () => {
  const f = fixture({ protocol }); f.settings.defaultModel = "two";
  const draft = f.config.createDraft(f.provider); draft.name = "Changed";
  await f.config.save(draft);
  assert.equal(f.counts().calls, 1); assert.equal(f.counts().saves, 1); assert.equal(f.settings.apiProviders[0].name, "Changed");
  assert.equal(f.settings.providerMode, "api");
  const body = JSON.parse(f.calls[0].body);
  assert.equal(body.model, "two"); assert.equal(body.stream, false); assert.equal(body.tools, undefined);
  assert.equal(body.max_tokens ?? body.max_output_tokens, 32);
  if (protocol === "openai-responses") assert.equal(body.store, false);
});
await test("duplicate saves coalesce without mutating the input draft", async () => {
  const pending = deferred(), f = fixture({ request: () => pending.promise });
  const draft = f.config.createDraft(f.provider), before = plain(draft);
  const first = f.config.save(draft), duplicate = f.config.save(draft); assert.equal(first, duplicate);
  await turn(); assert.equal(f.counts().calls, 1); assert.equal(f.counts().saves, 0);
  pending.resolve(answer()); await first; assert.deepEqual(plain(draft), before);
});
await test("testing failures retain memory settings and retryable draft without exposing key", async () => {
  let fail = true;
  const f = fixture({ request: async () => fail ? { status: 401, json: { error: { message: "synthetic-fixture-key" } } } : answer() });
  const before = plain(f.settings), draft = f.config.createDraft(f.provider); draft.name = "Unsaved";
  await assert.rejects(f.config.save(draft), error => /API Key/u.test(error.message) && !error.message.includes(draft.apiKey));
  assert.deepEqual(plain(f.settings), before); assert.equal(draft.name, "Unsaved"); assert.equal(f.counts().saves, 0);
  fail = false; await f.config.save(draft); assert.equal(f.settings.apiProviders[0].name, "Unsaved");
});
await test("connection timeout leaves all settings untouched", async () => {
  const f = fixture({ request: () => new Promise(() => {}) }), before = plain(f.settings);
  fastTimeout = true;
  try { await assert.rejects(f.config.save(f.config.createDraft(f.provider)), /超时/u); } finally { fastTimeout = false; }
  assert.deepEqual(plain(f.settings), before); assert.equal(f.counts().saves, 0);
});
await test("malformed or empty connection success is not saved", async () => {
  for (const json of [{}, { choices: [{ message: { content: "" }, finish_reason: "stop" }] }]) {
    const f = fixture({ request: async () => ({ status: 200, json }) });
    await assert.rejects(f.config.save(f.config.createDraft(f.provider)), /连接测试/u); assert.equal(f.counts().saves, 0);
  }
});
await test("failed persistence restores the provider and shared default, retains unrelated edits and draft", async () => {
  const f = fixture({ persist: async settings => { settings.unrelated = { advanced: true }; throw new Error("synthetic-fixture-key"); } });
  const before = plain(f.provider), draft = f.config.createDraft(f.provider); draft.models = [draft.models[1]];
  await assert.rejects(f.config.save(draft), error => /保存失败/u.test(error.message) && !error.message.includes(draft.apiKey));
  assert.deepEqual(plain(f.settings.apiProviders[0]), before); assert.equal(f.settings.defaultModel, "one");
  assert.deepEqual(plain(f.settings.unrelated), { advanced: true }); assert.equal(draft.models[0].id, "two");
});
await test("provider/model unknown fields survive partial editor data", async () => {
  const f = fixture(); f.provider.future = { retained: true }; f.provider.models[0].futureModel = { retained: true };
  const draft = f.config.createDraft(f.provider); delete draft.future; delete draft.models[0].futureModel;
  await f.config.save(draft);
  assert.deepEqual(plain(f.settings.apiProviders[0].future), { retained: true }); assert.deepEqual(plain(f.settings.apiProviders[0].models[0].futureModel), { retained: true });
});
await test("rollback never replaces an edit made while persistence is pending", async () => {
  const pending = deferred(), f = fixture({ persist: () => pending.promise });
  const draft = f.config.createDraft(f.provider); draft.name = "Mine";
  const saving = f.config.save(draft); await turn();
  f.settings.apiProviders[0].name = "Newer external edit";
  pending.reject(new Error("disk")); await assert.rejects(saving, /保存失败/u);
  assert.equal(f.settings.apiProviders[0].name, "Newer external edit");
});
await test("optimistic conflict before testing never overwrites another editor", async () => {
  const f = fixture(), draft = f.config.createDraft(f.provider); draft.name = "Mine"; f.provider.name = "Other editor";
  await assert.rejects(f.config.save(draft), /其他位置修改/u); assert.equal(f.provider.name, "Other editor"); assert.equal(f.counts().calls, 0);
});
await test("optimistic conflict during testing retains the newer edit", async () => {
  const pending = deferred(), f = fixture({ request: () => pending.promise }), draft = f.config.createDraft(f.provider);
  const saving = f.config.save(draft); await turn(); f.provider.future = { otherEdit: true }; pending.resolve(answer());
  await assert.rejects(saving, /其他位置修改/u); assert.equal(f.counts().saves, 0); assert.deepEqual(plain(f.provider.future), { otherEdit: true });
});
await test("editing the tested draft while request is pending requires a fresh test", async () => {
  const pending = deferred(), f = fixture({ request: () => pending.promise }), draft = f.config.createDraft(f.provider);
  const saving = f.config.save(draft); await turn(); draft.baseUrl = "https://changed.example/v1"; pending.resolve(answer());
  await assert.rejects(saving, /其他位置修改/u); assert.equal(f.counts().saves, 0);
});
await test("two endpoint instances serialize writes and reject the second stale edit", async () => {
  const pending = deferred(); let writes = 0;
  const f = fixture({ persist: async () => { if (++writes === 1) await pending.promise; } });
  const other = new MobileModelConfiguration(() => f.settings, f.save, async () => answer());
  const firstDraft = f.config.createDraft(f.provider), secondDraft = other.createDraft(f.provider);
  firstDraft.name = "First"; secondDraft.name = "Second";
  const first = f.config.save(firstDraft), second = other.save(secondDraft); await turn(); assert.equal(writes, 1);
  pending.resolve(); await first; await assert.rejects(second, /其他位置修改/u); assert.equal(f.settings.apiProviders[0].name, "First");
});
await test("new provider is added atomically with a valid default and rollback permits retry", async () => {
  let fail = true;
  const f = fixture({ persist: async () => { if (fail) throw new Error("disk"); } }); f.settings.apiProviders = []; f.settings.activeApiProviderId = ""; f.settings.defaultModel = "";
  const draft = f.config.createDraft(); Object.assign(draft, { apiKey: "synthetic-new-key", baseUrl: "https://new.example/v1", models: [mobileModel("new")], defaultModelId: "missing" });
  await assert.rejects(f.config.save(draft), /保存失败/u); assert.equal(f.settings.apiProviders.length, 0); assert.equal(f.settings.activeApiProviderId, "");
  fail = false; await f.config.save(draft); assert.equal(f.settings.activeApiProviderId, draft.id); assert.equal(f.settings.defaultModel, "new");
});
await test("default selection persists shared settings without inference or changing task drafts", async () => {
  const f = fixture(); f.settings.taskDraft = { modelId: "one" };
  await f.config.selectDefault(f.provider.id, "two"); assert.equal(f.settings.defaultModel, "two"); assert.equal(f.settings.taskDraft.modelId, "one"); assert.equal(f.counts().calls, 0);
  await assert.rejects(f.config.selectDefault(f.provider.id, "missing"), /不可用/u);
  f.provider.authMode = "oauth"; await assert.rejects(f.config.selectDefault(f.provider.id, "one"), /不可用/u);
});
await test("failed default selection rolls back and queue remains usable", async () => {
  let fail = true; const f = fixture({ persist: async () => { if (fail) throw new Error("disk"); } });
  f.settings.providerMode = "codex";
  await assert.rejects(f.config.selectDefault(f.provider.id, "two"), /保存失败/u); assert.equal(f.settings.defaultModel, "one");
  assert.equal(f.settings.providerMode, "codex");
  fail = false; await f.config.selectDefault(f.provider.id, "two"); assert.equal(f.settings.defaultModel, "two"); assert.equal(f.settings.providerMode, "api");
});
await test("failed persistence preserves a newer provider mode from another editor", async () => {
  const f = fixture({ persist: async settings => { settings.providerMode = "newer-mode"; throw new Error("disk"); } });
  f.settings.providerMode = "codex";
  await assert.rejects(f.config.selectDefault(f.provider.id, "two"), /保存失败/u); assert.equal(f.settings.providerMode, "newer-mode");
});
await test("remove chooses a supported fallback and never deletes desktop-only data", async () => {
  const f = fixture(), desktop = { ...structuredClone(f.provider), id: "desktop", providerId: "ollama" }, next = { ...structuredClone(f.provider), id: "next" };
  f.settings.apiProviders.push(desktop, next);
  await f.config.remove(f.provider.id); assert.equal(f.settings.activeApiProviderId, "next"); assert.ok(f.settings.apiProviders.some(provider => provider.id === "desktop"));
  await f.config.remove("next"); assert.equal(f.settings.activeApiProviderId, ""); assert.equal(f.settings.defaultModel, "");
});
await test("failed remove restores the service and original default", async () => {
  const f = fixture({ persist: async () => { throw new Error("disk"); } }), before = plain(f.settings);
  await assert.rejects(f.config.remove(f.provider.id), /保存失败/u); assert.deepEqual(plain(f.settings), before);
});
const context = { systemPrompt: "Fixture", messages: [{ role: "user", content: "Only OK", timestamp: 1 }], tools: [] };
const reasoningModel = (id, enabled = true, effort = "high") => ({ ...mobileModel(id), reasoning: true, reasoningEnabled: enabled, reasoningEffort: effort });
const bodyFor = (provider, model) => JSON.parse(buildMobileRequest(provider, piModel(provider, model), context).body);
await test("Pi model keeps configured reasoning level separately from capability and copies image input", () => {
  const provider = mobileProvider("deepseek"), model = { ...reasoningModel("deepseek-v4-flash", false, "max"), input: ["text", "image"] };
  const resolved = piModel(provider, model);
  assert.equal(resolved.reasoning, true); assert.equal(resolved.mobileReasoningLevel, "off");
  assert.deepEqual(plain(resolved.input), ["text", "image"]); resolved.input.pop(); assert.equal(model.input.length, 2);
  assert.equal(piModel(provider, { ...model, reasoningEnabled: true }).mobileReasoningLevel, "max");
});
await test("DeepSeek enable/off and strength reach the actual body, including V4 supported effort mapping", () => {
  const provider = mobileProvider("deepseek");
  const enabled = bodyFor(provider, reasoningModel("deepseek-v4-flash", true, "max"));
  assert.deepEqual(enabled.thinking, { type: "enabled" }); assert.equal(enabled.reasoning_effort, "max");
  assert.equal(bodyFor(provider, reasoningModel("deepseek-v4-flash", true, "low")).reasoning_effort, "high");
  assert.equal(bodyFor(provider, reasoningModel("deepseek-v4-flash", true, "xhigh")).reasoning_effort, "max");
  const disabled = bodyFor(provider, reasoningModel("deepseek-v4-flash", false));
  assert.deepEqual(disabled.thinking, { type: "disabled" }); assert.equal(disabled.reasoning_effort, undefined);
  assert.deepEqual(bodyFor(provider, mobileModel("deepseek-v4-flash")).thinking, { type: "disabled" });
  const legacy = bodyFor(provider, reasoningModel("deepseek-reasoner", true, "high")); assert.equal(legacy.reasoning_effort, "high");
});
await test("GLM follows Zai on/off compatibility and omits its unsupported effort parameter", () => {
  const provider = mobileProvider("glm"), enabled = bodyFor(provider, reasoningModel("glm-4.7"));
  assert.deepEqual(enabled.thinking, { type: "enabled", clear_thinking: false }); assert.equal(enabled.reasoning_effort, undefined);
  assert.deepEqual(bodyFor(provider, reasoningModel("glm-4.7", false)).thinking, { type: "disabled" });
});
await test("ordinary Qwen thinking sends a boolean without an unsupported effort parameter", () => {
  for (const providerId of ["qwen", "qwen-token-plan"]) {
    const provider = mobileProvider(providerId), enabled = bodyFor(provider, reasoningModel("qwen3.6-plus"));
    assert.equal(enabled.enable_thinking, true); assert.equal(enabled.reasoning_effort, undefined);
    const disabled = bodyFor(provider, reasoningModel("qwen3.6-plus", false));
    assert.equal(disabled.enable_thinking, false); assert.equal(disabled.reasoning_effort, undefined);
    assert.equal(bodyFor(provider, mobileModel("qwen3.6-plus")).enable_thinking, false);
    assert.equal(bodyFor(provider, mobileModel("qwen-max")).enable_thinking, undefined);
  }
});
await test("Qwen 3.8 uses the existing pure policy for every effort and disabled state", () => {
  for (const [providerId, modelId] of [["qwen", "qwen3.8-max"], ["qwen-token-plan", "qwen3.8-max"], ["qwen-token-plan", "qwen3.8-max-preview"]]) {
    const provider = mobileProvider(providerId);
    for (const [level, expected] of [["minimal", "low"], ["low", "low"], ["medium", "medium"], ["high", "xhigh"], ["xhigh", "xhigh"], ["max", "xhigh"]]) {
      const body = bodyFor(provider, reasoningModel(modelId, true, level)); assert.equal(body.enable_thinking, true); assert.equal(body.reasoning_effort, expected);
    }
    const disabled = bodyFor(provider, reasoningModel(modelId, false));
    assert.equal(disabled.enable_thinking, false); assert.equal(disabled.reasoning_effort, undefined);
    const defaultModel = reasoningModel(modelId); delete defaultModel.reasoningEffort;
    assert.equal(bodyFor(provider, defaultModel).reasoning_effort, "xhigh");
  }
});
await test("Kimi K2 toggles thinking without unsupported effort and respects K2.7 no-off compatibility", () => {
  const provider = mobileProvider("kimi"), enabled = bodyFor(provider, reasoningModel("kimi-k2.5"));
  assert.deepEqual(enabled.thinking, { type: "enabled" }); assert.equal(enabled.reasoning_effort, undefined);
  assert.deepEqual(bodyFor(provider, reasoningModel("kimi-k2.5", false)).thinking, { type: "disabled" });
  assert.deepEqual(bodyFor(provider, mobileModel("kimi-k2.5")).thinking, { type: "disabled" });
  assert.equal(bodyFor(provider, reasoningModel("kimi-k2.7-code", false)).thinking, undefined);
});
await test("OpenAI Responses consumes configured effort/off and skips models without that capability", () => {
  const provider = { ...mobileProvider("custom"), providerId: "openai", runtimeProviderId: "openai", apiProtocol: "openai-responses", baseUrl: "https://api.openai.com/v1" };
  assert.deepEqual(bodyFor(provider, reasoningModel("gpt-5.4", true, "high")).reasoning, { effort: "high" });
  assert.deepEqual(bodyFor(provider, reasoningModel("gpt-5.4", false)).reasoning, { effort: "none" });
  assert.equal(bodyFor(provider, mobileModel("gpt-4.1")).reasoning, undefined);
  assert.equal(bodyFor(provider, reasoningModel("o3", false)).reasoning, undefined);
  assert.equal(bodyFor(provider, reasoningModel("gpt-5.4")).reasoning_effort, undefined);
});
await test("unknown custom endpoints and unsupported protocols receive no invented reasoning fields", () => {
  for (const protocol of ["openai-completions", "openai-responses"]) {
    const provider = { ...mobileProvider("custom"), apiProtocol: protocol, baseUrl: "https://custom.example/v1" };
    const body = bodyFor(provider, reasoningModel("custom-model"));
    for (const field of ["thinking", "enable_thinking", "reasoning", "reasoning_effort"]) assert.equal(body[field], undefined);
  }
  const qwenResponses = { ...mobileProvider("qwen"), apiProtocol: "openai-responses" };
  const body = bodyFor(qwenResponses, reasoningModel("qwen3.8-max"));
  assert.equal(body.reasoning, undefined); assert.equal(body.enable_thinking, undefined);
});
await test("custom service on an official known endpoint uses that endpoint's documented format", () => {
  const provider = { ...mobileProvider("custom"), baseUrl: "https://api.deepseek.com/v1" };
  assert.deepEqual(bodyFor(provider, reasoningModel("deepseek-v4-flash", false)).thinking, { type: "disabled" });
});
await test("connection test explicitly disables DeepSeek thinking while retaining saved preference", async () => {
  const f = fixture(); Object.assign(f.provider, { providerId: "deepseek", runtimeProviderId: "deepseek", baseUrl: "https://api.deepseek.com", models: [reasoningModel("deepseek-v4-flash", true, "max")], defaultModelId: "deepseek-v4-flash" });
  f.settings.defaultModel = "deepseek-v4-flash";
  const draft = f.config.createDraft(f.provider); await f.config.save(draft);
  const body = JSON.parse(f.calls[0].body);
  assert.deepEqual(body.thinking, { type: "disabled" }); assert.equal(body.reasoning_effort, undefined); assert.equal(body.max_tokens, 32);
  assert.equal(f.settings.apiProviders[0].models[0].reasoningEnabled, true); assert.equal(f.settings.apiProviders[0].models[0].reasoningEffort, "max");
});
await test("streaming and one-shot requests consume configured reasoning without Agent defaults overriding it", async () => {
  const provider = { ...mobileProvider("deepseek"), apiKey: "synthetic-fixture-key" }, model = reasoningModel("deepseek-v4-flash", true, "max");
  let body;
  const request = async input => { body = JSON.parse(input.body); return answer(); };
  const stream = mobileStream(provider, request)(piModel(provider, model), context, { reasoning: "low" });
  await stream.result(); assert.equal(body.reasoning_effort, "max");
  await mobileGenerateText(provider, { ...model, reasoningEnabled: false }, request, "Fixture", "Only OK", 32, new AbortController().signal);
  assert.deepEqual(body.thinking, { type: "disabled" }); assert.equal(body.reasoning_effort, undefined);
});
// Streaming fixtures: bytes are cut at arbitrary offsets, including inside CRLF and a UTF-8 character.
const sseBytes = events => new TextEncoder().encode(events.map(event => `data: ${typeof event === "string" ? event : JSON.stringify(event)}\r\n\r\n`).join(""));
const sseFetch = (bytes, cuts = [], status = 200, type = "text/event-stream") => {
  const calls = [], bounds = [0, ...cuts, bytes.length];
  const fetch = async (url, init) => {
    calls.push({ url, init }); let index = 0;
    return { status, headers: { get: name => name === "content-type" ? type : null }, text: async () => new TextDecoder().decode(bytes),
      body: { getReader: () => ({ read: async () => index < bounds.length - 1 ? { done: false, value: bytes.slice(bounds[index], bounds[++index]) } : { done: true }, cancel: async () => {} }) } };
  };
  return { fetch, calls };
};
const collect = async stream => { const events = []; for await (const event of stream) events.push(event); return { events, message: await stream.result() }; };
const noRequest = async () => { throw new Error("requestUrl must not be used while streaming"); };
await test("Chat Completions streaming emits thinking then text and stores the buffered message shape", async () => {
  const provider = { ...mobileProvider("deepseek"), apiKey: "synthetic-fixture-key" }, model = reasoningModel("deepseek-v4-flash", true, "max");
  const bytes = sseBytes([{ id: "r1", model: "deepseek-v4-flash", choices: [{ delta: { reasoning_content: "先想" } }] }, { choices: [{ delta: { reasoning_content: "一下" } }] },
    { choices: [{ delta: { content: "你好，" } }] }, { choices: [{ delta: { content: "世界" }, finish_reason: "stop" }] }, "[DONE]"]);
  const utf8 = bytes.indexOf(0xe4), cuts = [3, 40, utf8 + 1, utf8 + 2, bytes.indexOf(13) + 1, bytes.length - 4];
  const { fetch, calls } = sseFetch(bytes, cuts.filter((cut, i, all) => cut > 0 && cut < bytes.length && all.indexOf(cut) === i).sort((a, b) => a - b));
  const { events, message } = await collect(mobileStream(provider, noRequest, undefined, "conversation", fetch)(piModel(provider, model), context, {}));
  assert.equal(JSON.parse(calls[0].init.body).stream, true); assert.equal(calls[0].init.headers.Authorization, "Bearer synthetic-fixture-key");
  assert.deepEqual(events.map(event => event.type), ["start", "thinking_start", "thinking_delta", "thinking_delta", "thinking_end", "text_start", "text_delta", "text_delta", "text_end", "done"]);
  assert.equal(events.filter(event => event.type === "text_delta").map(event => event.delta).join(""), "你好，世界");
  assert.deepEqual(plain(message.content), [{ type: "text", text: "你好，世界" }]);
  assert.equal(message.mobileReasoning, "先想一下"); assert.equal(message.responseId, "r1"); assert.equal(message.stopReason, "stop");
  assert.equal(visibleReasoning(message), "先想一下");
});
await test("streamed tool calls assemble like buffered ones and DeepSeek reasoning returns on the next turn", async () => {
  const provider = { ...mobileProvider("deepseek"), apiKey: "synthetic-fixture-key" }, model = { ...reasoningModel("deepseek-v4-flash"), toolCalling: true };
  const { fetch } = sseFetch(sseBytes([{ choices: [{ delta: { reasoning_content: "查一下" } }] },
    { choices: [{ delta: { tool_calls: [{ id: "call-1", function: { name: "note_", arguments: "{\"pa" } }] } }] },
    { choices: [{ delta: { tool_calls: [{ function: { name: "read", arguments: "th\":\"a.md\"}" } }] }, finish_reason: "tool_calls" }] }]));
  const { message } = await collect(mobileStream(provider, noRequest, undefined, "conversation", fetch)(piModel(provider, model), context, {}));
  assert.equal(message.stopReason, "toolUse");
  assert.deepEqual(plain(message.content), [{ type: "toolCall", id: "call-1", name: "note_read", arguments: { path: "a.md" } }]);
  const next = { ...context, messages: [...context.messages, message, { role: "toolResult", toolCallId: "call-1", toolName: "note_read", content: [{ type: "text", text: "内容" }], isError: false, timestamp: 2 }] };
  const assistant = JSON.parse(buildMobileRequest(provider, piModel(provider, model), next).body).messages.find(item => item.role === "assistant");
  assert.equal(assistant.reasoning_content, "查一下"); assert.equal(assistant.tool_calls[0].function.arguments, "{\"path\":\"a.md\"}");
});
await test("Responses streaming shows summary deltas and stores the completed response object", async () => {
  const provider = { ...mobileProvider("custom"), apiProtocol: "openai-responses", baseUrl: "https://custom.example/v1", apiKey: "synthetic-fixture-key" };
  const response = { id: "resp-1", status: "completed", usage: { input_tokens: 5, output_tokens: 3 }, output: [
    { type: "reasoning", summary: [{ type: "summary_text", text: "概括思路" }] }, { type: "message", content: [{ type: "output_text", text: "结论" }] }] };
  const { fetch } = sseFetch(sseBytes([{ type: "response.reasoning_summary_text.delta", delta: "概括" }, { type: "response.reasoning_summary_text.delta", delta: "思路" },
    { type: "response.output_text.delta", delta: "结论" }, { type: "response.completed", response }]), [17]);
  const { events, message } = await collect(mobileStream(provider, noRequest, undefined, "conversation", fetch)(piModel(provider, mobileModel("gpt-x")), context, {}));
  assert.equal(events.filter(event => event.type === "thinking_delta").map(event => event.delta).join(""), "概括思路");
  assert.deepEqual(plain(message.content), [{ type: "text", text: "结论" }]); assert.equal(message.responseId, "resp-1");
  assert.equal(visibleReasoning(message), "概括思路"); assert.equal(message.usage.input, 5);
});
await test("streaming failures keep the Provider message, name a blocked stream, and never save half an answer", async () => {
  const provider = { ...mobileProvider("deepseek"), apiKey: "synthetic-fixture-key" }, model = piModel(provider, mobileModel("deepseek-v4-flash"));
  const run = async fetch => (await collect(mobileStream(provider, noRequest, undefined, "conversation", fetch)(model, context, {}))).message;
  const denied = await run(sseFetch(new TextEncoder().encode(JSON.stringify({ error: { message: "Authentication Fails" } })), [], 401, "application/json").fetch);
  assert.equal(denied.stopReason, "error"); assert.match(denied.errorMessage, /401.*Authentication Fails/u);
  const blocked = await run(async () => { throw new TypeError("Load failed"); });
  assert.equal(blocked.errorMessage, MOBILE_STREAM_BLOCKED); assert.deepEqual(plain(blocked.content), []);
  const cut = await run(sseFetch(sseBytes([{ choices: [{ delta: { content: "半句" } }] }])).fetch);
  assert.equal(cut.stopReason, "error"); assert.match(cut.errorMessage, /中断/u); assert.deepEqual(plain(cut.content), []);
  const midStream = await run(sseFetch(sseBytes([{ choices: [{ delta: { content: "先" } }] }, { error: { message: "rate limited" } }])).fetch);
  assert.match(midStream.errorMessage, /rate limited/u);
});
await test("Stop mid-stream aborts at once and late chunks cannot change the result or emit events", async () => {
  const provider = { ...mobileProvider("deepseek"), apiKey: "synthetic-fixture-key" }, controller = new AbortController();
  const first = sseBytes([{ choices: [{ delta: { content: "第一段" } }] }]), late = sseBytes([{ choices: [{ delta: { content: "迟到" }, finish_reason: "stop" }] }]);
  let reads = 0, release;
  const fetch = async (_url, init) => {
    assert.equal(init.signal, controller.signal);
    return { status: 200, headers: { get: () => "text/event-stream" }, text: async () => "", body: { getReader: () => ({ cancel: async () => {},
      read: () => reads++ === 0 ? Promise.resolve({ done: false, value: first }) : reads === 2 ? new Promise(resolve => { release = () => resolve({ done: false, value: late }); }) : Promise.resolve({ done: true }) }) } };
  };
  const stream = mobileStream(provider, noRequest, undefined, "conversation", fetch)(piModel(provider, mobileModel("deepseek-v4-flash")), context, { signal: controller.signal });
  const deltas = []; const consumed = (async () => { for await (const event of stream) if (event.type === "text_delta") deltas.push(event.delta); })();
  while (!release) await turn();
  controller.abort(); const message = await stream.result(); await consumed;
  assert.equal(message.stopReason, "aborted"); assert.deepEqual(plain(message.content), []); assert.deepEqual(deltas, ["第一段"]);
  release(); await turn(); await turn();
  assert.deepEqual(deltas, ["第一段"]); assert.deepEqual(plain(message.content), []);
});
await test("streaming defaults follow verified presets, explicit choices win and survive mobile loading", () => {
  assert.deepEqual(["glm", "kimi", "deepseek", "qwen", "qwen-token-plan", "custom"].map(id => mobileStreamingEnabled(mobileProvider(id))), [false, true, true, true, false, false]);
  assert.equal(mobileStreamingEnabled({ ...mobileProvider("deepseek"), mobileStreaming: false }), false);
  assert.equal(mobileStreamingEnabled({ ...mobileProvider("glm"), mobileStreaming: true }), true);
  assert.equal(Object.hasOwn(mobileProvider("deepseek"), "mobileStreaming"), false, "new services inherit future preset changes");
  // Desktop normalization is covered in provider-settings-behavior.ts (Node-only bundle).
  const kept = loadMobileSettings({ apiProviders: [{ ...mobileProvider("kimi"), mobileStreaming: false }] }).apiProviders[0];
  assert.equal(kept.mobileStreaming, false);
});
await test("connection test uses the streaming path when streaming is on and keeps the blocked-stream reason", async () => {
  const f = fixture(), stream = sseFetch(sseBytes([{ choices: [{ delta: { content: "OK" }, finish_reason: "stop" }] }]));
  const streaming = new MobileModelConfiguration(() => f.settings, f.save, async input => { f.calls.push(input); return answer(); }, undefined, stream.fetch);
  const draft = streaming.createDraft(f.provider); draft.mobileStreaming = true; await streaming.save(draft);
  assert.equal(stream.calls.length, 1); assert.equal(f.calls.length, 0); assert.equal(f.settings.apiProviders[0].mobileStreaming, true);
  const blocked = new MobileModelConfiguration(() => f.settings, f.save, async () => answer(), undefined, async () => { throw new TypeError("Load failed"); });
  await assert.rejects(blocked.save(blocked.createDraft(f.settings.apiProviders[0])), error => error.message === MOBILE_STREAM_BLOCKED);
  const off = blocked.createDraft(f.settings.apiProviders[0]); off.mobileStreaming = false; await blocked.save(off);
  assert.equal(f.settings.apiProviders[0].mobileStreaming, false, "turning streaming off falls back to requestUrl and saves");
});
console.log(`OK ${passed} mobile model settings tests; browser-only shared service; fixtures stay in memory`);
