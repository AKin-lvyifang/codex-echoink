import assert from "node:assert/strict";
import { searchDeepSeek, DeepSeekSearchError } from "../tools/deepseek-search";
import { normalizeWebSearchSettings, searchWeb, webSearchAvailable, webSearchApiKey, webSearchKeySource, deepSeekModelApiKey, setWebSearchApiKey, webSearchErrorMessage, type WebSearchSettings, type WebSearchTransport } from "../tools/web-search";
import { normalizeSettingsData, createApiProviderConfig } from "../settings/settings";
import { loadMobileSettings } from "../mobile/settings";
import { MobileCapabilitiesService } from "../mobile/capabilities";
import { MobileCapabilityPolicy } from "../mobile/capability-policy";
import { GENERAL_ASSISTANT_ID } from "../agents/types";
import { PiWebSearchSecurity, createWebSearchTool } from "../harness/pi-native/pi-web-search";
import { setRequestUrlForTests } from "./obsidian-shim";

const key = "synthetic-deepseek-secret", tavilyKey = "synthetic-tavily-secret";
const requests: Parameters<WebSearchTransport>[0][] = [];
const transport: WebSearchTransport = async request => { requests.push(request); return { status: 200, json: { results: [
  { title: `Title ${key}`, url: "https://example.com/news", summary: `Summary ${key} ${tavilyKey}`, snippet: "ignored", content: "ignored full content", date: "2026-10-27" },
  { title: "Fallback", url: "http://example.com/fallback", snippet: "Fallback snippet" },
  { title: "Unsafe", url: "javascript:alert(1)", summary: "Unsafe" }
] } }; };
const settings: WebSearchSettings = { enabled: true, apiKey: tavilyKey, provider: "deepseek", deepseekApiKey: key };
const found = await searchWeb(settings, { query: "  搜索词  ", transport });
assert.equal(requests.length, 1); assert.equal(requests[0].url, "https://api.deepseek.com/v1/tools/search"); assert.equal(requests[0].method, "POST"); assert.equal(requests[0].throw, false);
assert.deepEqual(requests[0].headers, { Authorization: `Bearer ${key}`, "Content-Type": "application/json" });
assert.deepEqual(JSON.parse(requests[0].body), { query: "搜索词", count: 5, need_content: false });
assert.deepEqual(found, { source: "web", provider: "DeepSeek", results: [
  { title: "Title [redacted]", url: "https://example.com/news", summary: "Summary [redacted] [redacted]", publishedDate: "2026-10-27" },
  { title: "Fallback", url: "http://example.com/fallback", summary: "Fallback snippet" }
] });
for (const [maximum, expected] of [[1, 1], [0, 1], [99, 5], [2.5, 2], [NaN, 5]]) {
  await searchDeepSeek({ apiKey: key, query: "count", maxResults: maximum, transport: async request => { assert.equal(JSON.parse(request.body).count, expected); return { status: 200, json: { results: [] } }; } });
}
let dispatched = 0;
const empty: WebSearchTransport = async () => { dispatched++; return { status: 200, json: { results: [] } }; };
for (const query of ["", "  ", "汉".repeat(129), "😀".repeat(129)]) {
  await assert.rejects(searchDeepSeek({ apiKey: key, query, transport: empty }), error => error instanceof DeepSeekSearchError && error.code === "invalid_query" && /128/.test(webSearchErrorMessage(error, false)));
}
assert.equal(dispatched, 0, "invalid queries never dispatch or silently truncate");
for (const query of ["汉".repeat(128), "😀".repeat(128)]) {
  const response = await searchDeepSeek({ apiKey: key, query, transport: async request => { assert.equal(JSON.parse(request.body).query, query); return empty(request); } });
  assert.deepEqual(response.results, [], "empty results are successful");
}
await assert.rejects(searchDeepSeek({ apiKey: " ", query: "news", transport: empty }), /key_missing/);
for (const [status, code] of [[401, "key_invalid"], [402, "quota"], [429, "rate_limit"], [500, "network"]] as const) {
  await assert.rejects(searchDeepSeek({ apiKey: key, query: "news", transport: async () => ({ status, json: { error: key } }) }), error => error instanceof DeepSeekSearchError && error.code === code && !error.message.includes(key));
}
await assert.rejects(searchDeepSeek({ apiKey: key, query: "news", transport: async () => { throw new Error(key); } }), /deepseek_search_network/);
for (const json of [{}, { results: null }, { results: [{}] }, { results: [{ title: "x", url: "invalid", summary: "x" }] }]) await assert.rejects(searchDeepSeek({ apiKey: key, query: "news", transport: async () => ({ status: 200, json }) }), /invalid_response/);
await assert.rejects(searchDeepSeek({ apiKey: key, query: "news", timeoutMs: 1, transport: () => new Promise(() => {}) }), /timeout/);
const before = new AbortController(); before.abort(); const prior = dispatched;
await assert.rejects(searchDeepSeek({ apiKey: key, query: "news", signal: before.signal, transport: empty }), /cancelled/); assert.equal(dispatched, prior);
const pending = new AbortController(), running = searchDeepSeek({ apiKey: key, query: "news", signal: pending.signal, transport: () => new Promise(() => {}) }); pending.abort(); await assert.rejects(running, /cancelled/);

const legacy = { enabled: true, apiKey: ` ${tavilyKey} ` };
for (const normalized of [normalizeSettingsData({ tavily: legacy }).settings.tavily, loadMobileSettings({ tavily: legacy }).tavily]) {
  assert.deepEqual(normalized, { enabled: true, apiKey: tavilyKey, provider: "tavily", deepseekApiKey: "" });
}
const roundTrip = normalizeWebSearchSettings(JSON.parse(JSON.stringify(settings))); assert.deepEqual(roundTrip, settings);
roundTrip.provider = "tavily"; setWebSearchApiKey(roundTrip, "edited-tavily"); assert.equal(roundTrip.deepseekApiKey, key);
roundTrip.provider = "deepseek"; assert.equal(webSearchApiKey(roundTrip), key); assert.equal(roundTrip.apiKey, "edited-tavily");
assert.equal(webSearchAvailable({ ...settings, deepseekApiKey: "" }), false, "another provider's key cannot enable search");
assert.equal(webSearchAvailable({ ...settings, apiKey: "" }), true, "DeepSeek is independent from the Tavily key");
assert.equal(normalizeWebSearchSettings({ ...settings, provider: "unknown" }).provider, "tavily");
await searchWeb({ ...settings, provider: "tavily" }, { query: "Tavily", transport: async request => { assert.equal(request.url, "https://api.tavily.com/search"); assert.equal(request.headers.Authorization, `Bearer ${tavilyKey}`); return { status: 200, json: { results: [] } }; } });
let noFallback = 0;
await assert.rejects(searchWeb(settings, { query: "failed", transport: async request => { noFallback++; assert.equal(request.url, "https://api.deepseek.com/v1/tools/search"); return { status: 402, json: {} }; } }), /quota/); assert.equal(noFallback, 1);

const modelKey = "synthetic-model-search-key", model = { ...createApiProviderConfig("deepseek", "search-model"), apiKey: ` ${modelKey} ` };
const modelOnly: WebSearchSettings = { enabled: true, provider: "deepseek", apiKey: tavilyKey, deepseekApiKey: "" };
assert.equal(webSearchKeySource(modelOnly, [model]), "model");
assert.equal(webSearchApiKey(settings, [model]), modelKey, "official model key takes precedence over an old independent search key");
assert.equal(webSearchKeySource(settings, []), "legacy");
assert.equal(webSearchKeySource(modelOnly, []), "missing");
for (const baseUrl of ["https://api.deepseek.com", "https://api.deepseek.com/", "https://api.deepseek.com/v1", "https://api.deepseek.com/v1/"]) {
  assert.equal(deepSeekModelApiKey([{ ...model, baseUrl }]), modelKey);
}
for (const rejected of [
  { ...model, providerId: "custom", name: "DeepSeek" }, { ...model, providerId: undefined, name: "DeepSeek" },
  ...["https://proxy.example/v1", "https://api.deepseek.com.example/v1", "http://api.deepseek.com", "https://api.deepseek.com/proxy", "https://api.deepseek.com?proxy=1", "https://user@api.deepseek.com", "https://api.deepseek.com:8443", "invalid"].map(baseUrl => ({ ...model, baseUrl }))
]) {
  assert.equal(webSearchAvailable(modelOnly, [rejected]), false, "only the official provider and endpoint can supply a model key");
  assert.equal(webSearchApiKey(settings, [rejected]), key, "an old independent key remains a fallback");
}
for (const normalized of [normalizeSettingsData({ tavily: modelOnly, apiProviders: [model] }).settings, loadMobileSettings({ tavily: modelOnly, apiProviders: [model] })]) {
  assert.equal(normalized.tavily.enabled, true, "normalization retains enabled when only the model key exists");
  assert.equal(normalized.tavily.deepseekApiKey, "", "model credentials are never copied into the legacy field");
  assert.equal(webSearchAvailable(normalized.tavily, normalized.apiProviders), true);
}
assert.equal(normalizeWebSearchSettings(modelOnly).enabled, true, "saved intent is independent of credential availability");
await searchWeb(settings, { query: "model credential", transport: async request => {
  assert.equal(request.headers.Authorization, `Bearer ${modelKey}`);
  return { status: 200, json: { results: [{ title: modelKey, url: "https://example.com", summary: `${modelKey} ${key} ${tavilyKey}` }] } };
} }, [model]).then(response => assert.equal(response.results[0].summary, "[redacted] [redacted] [redacted]"));
assert.equal(settings.deepseekApiKey, key);

const mobileSettings = loadMobileSettings({ tavily: modelOnly, apiProviders: [structuredClone(model)] });
const policy = new MobileCapabilityPolicy({ settings: () => mobileSettings, store: { permission: "workspace-write", memoryEnabled: true } as any, agentId: GENERAL_ASSISTANT_ID });
let mobileRequests = 0, mobileSaves = 0;
const mobile = new MobileCapabilitiesService({ adapter: {} as any, settings: () => mobileSettings, saveSettings: async () => { mobileSaves++; }, policy: () => policy,
  request: async request => { mobileRequests++; assert.equal(request.headers.Authorization, `Bearer ${modelKey}`); return { status: 200, json: { results: [] } }; } });
const savedMobile = await mobile.saveTavily(mobile.readTavily());
assert.equal(savedMobile.enabled, true); assert.equal(savedMobile.deepseekApiKey, ""); assert.equal(mobileSaves, 1);
await mobile.testTavily(savedMobile);
const mobileSearch = mobile.runtimeTools(policy, async () => ({})).find(tool => tool.name === "web_search")!;
assert.ok(mobileSearch, "the actual mobile policy advertises model-key-only search");
await mobileSearch.execute("model-mobile", { query: "current facts" });
assert.equal(mobileRequests, 2, "both mobile connection test and runtime search use the official model key");
mobileSettings.apiProviders[0].providerId = "custom";
assert.equal(mobile.runtimeTools(policy, async () => ({})).some(tool => tool.name === "web_search"), false);

let piProviders = [{ ...model }];
const modelSecurity = new PiWebSearchSecurity(() => modelOnly, undefined, () => piProviders);
assert.equal(modelSecurity.available(), true);
await modelSecurity.handleToolCall({ toolName: "web_search", toolCallId: "model-key", input: { query: "facts" } } as any);
await modelSecurity.execute("model-key", { query: "facts" }, undefined, async input => { assert.equal(input.apiKey, modelKey); return { source: "web", provider: "DeepSeek", results: [] }; });
assert.equal((await modelSecurity.handleToolResult({ toolName: "web_search", toolCallId: "model-key" } as any)).isError, false);
await modelSecurity.handleToolCall({ toolName: "web_search", toolCallId: "rotated-model-key", input: { query: "facts" } } as any);
piProviders[0].apiKey = "synthetic-rotated-model-key";
await modelSecurity.execute("rotated-model-key", { query: "facts" }, undefined, async () => { assert.fail("a changed model key must block dispatch"); });
assert.equal((await modelSecurity.handleToolResult({ toolName: "web_search", toolCallId: "rotated-model-key" } as any)).isError, true);

let selected = { ...settings }, allow = true, calls = 0, resolve: ((value: unknown) => void) | undefined;
const restore = setRequestUrlForTests(async request => { calls++; assert.equal(typeof request === "string" ? request : request.url, "https://api.deepseek.com/v1/tools/search"); return await new Promise(done => { resolve = done as typeof resolve; }); });
try {
  const security = new PiWebSearchSecurity(() => selected, async () => { if (!allow) throw new Error("denied"); });
  const call = (id: string, query = "facts") => security.handleToolCall({ type: "tool_call", toolName: "web_search", toolCallId: id, input: { query } } as any);
  const result = (id: string) => security.handleToolResult({ toolName: "web_search", toolCallId: id } as any);
  assert.ok(/128/.test(createWebSearchTool(security).description));
  await call("unicode", "😀".repeat(128)); const success = security.execute("unicode", { query: "😀".repeat(128) });
  await new Promise(done => setTimeout(done, 0)); resolve!({ status: 200, json: { results: [] } }); await success;
  const actual = await result("unicode"); assert.equal(actual.details.provider, "DeepSeek"); assert.equal(actual.isError, false);
  await call("switch-at-egress"); const completed = security.execute("switch-at-egress", { query: "facts" });
  await new Promise(done => setTimeout(done, 0)); resolve!({ status: 200, json: { results: [{ title: "withheld", url: "https://example.com", summary: "withheld" }] } }); await completed;
  selected.provider = "tavily"; const egress = await result("switch-at-egress"); assert.equal(egress.isError, true); assert.doesNotMatch(egress.content[0].text, /withheld/); selected.provider = "deepseek";
  assert.ok((await call("unicode"))?.block, "replayed call is blocked");
  await call("long", "汉".repeat(129)); const count = calls; await security.execute("long", { query: "汉".repeat(129) });
  const invalid = await result("long"); assert.equal(invalid.isError, true); assert.match(invalid.content[0].text, /128/); assert.match(invalid.content[0].text, /[Ss]horten/); assert.equal(calls, count);
  await call("switch-before"); selected.provider = "tavily"; await security.execute("switch-before", { query: "facts" }); assert.equal((await result("switch-before")).isError, true); assert.equal(calls, count);
  selected.provider = "deepseek"; await call("switch-during"); const switched = security.execute("switch-during", { query: "facts" }); await new Promise(done => setTimeout(done, 0));
  selected.provider = "tavily"; resolve!({ status: 200, json: { results: [{ title: "should not escape", url: "https://example.com", summary: "should not escape" }] } }); await switched;
  const rejected = await result("switch-during"); assert.equal(rejected.isError, true); assert.equal(rejected.details.provider, "DeepSeek"); assert.doesNotMatch(rejected.content[0].text, /should not escape/);
  allow = false; assert.ok((await call("denied"))?.block); allow = true; selected.enabled = false; assert.ok((await call("disabled"))?.block);
} finally { restore(); }
console.log("PASS web search: DeepSeek official request, Unicode/query bounds, mapping/redaction, errors, timeout/cancel, model/legacy/missing key selection and custom exclusion, enabled persistence, desktop/mobile actual search credentials, Pi safety/replay/configuration and model-key changes (controlled responses).");
