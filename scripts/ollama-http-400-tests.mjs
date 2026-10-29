import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import esbuild from "esbuild";
import { createOllamaHttpFixture, OLLAMA_FIXTURE_MODEL } from "./fixtures/ollama-http-fixture.mjs";
import { desktopNodeTestBanner, desktopNodeTestAliases } from "./desktop-node-test-host.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const directory = await mkdtemp(path.join(tmpdir(), "echoink-ollama-test-"));
const records = [];
let forcedError = "";
const server = createOllamaHttpFixture({ capture: record => records.push(record), errorOverride: () => forcedError });
try {
  const outfile = path.join(directory, "entry.mjs");
  await esbuild.build({
    stdin: { contents: `export {createApiProviderModelConfig,createDiscoveredApiProviderModelConfig,createApiProviderConfig,normalizeSettingsData} from "./src/settings/settings";
      export {createPiProviderModelDefinition} from "./src/harness/pi/production-pi-model-resolver";
      export {createConfiguredPiProviderProtocolDispatcher} from "./src/plugin/configured-pi-provider-dispatcher";
      export {PiProviderProtocolTransport} from "./src/harness/pi/pi-provider-protocol-adapter";
      export {assistantProviderFailureText,sanitizeProviderFailureDetail} from "./src/harness/pi/provider-failure";
      export {testProviderConnection} from "./src/plugin/pi-provider-configuration-service";`, resolveDir: root, loader: "ts" },
    bundle: true, platform: "node", format: "esm", target: "node22", outfile,
    alias: desktopNodeTestAliases, banner: desktopNodeTestBanner, logLevel: "silent",
    loader: { ".md": "text", ".svg": "dataurl", ".webp": "dataurl" },
    plugins: [{ name: "pi-externals", setup(build) {
      build.onResolve({ filter: /^@earendil-works\/pi-(agent-core|ai|coding-agent)(\/|$)/ }, args => ({ path: fileURLToPath(import.meta.resolve(args.path)), external: true }));
    } }]
  });
  const api = await import(pathToFileURL(outfile).href);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  const provider = api.createApiProviderConfig("ollama", "ollama-fixture");
  provider.baseUrl = baseUrl;
  // /v1/models only declares the ID. Reopening old saved configuration must
  // discard the historical assumed reasoning=true without a manual override.
  const discovered = api.createDiscoveredApiProviderModelConfig("ollama", OLLAMA_FIXTURE_MODEL, "ollama", { id: OLLAMA_FIXTURE_MODEL });
  provider.models = [{ ...discovered, reasoning: true, reasoningEnabled: true }];
  provider.defaultModelId = OLLAMA_FIXTURE_MODEL;
  const reopened = api.normalizeSettingsData({ apiProviders: [provider], activeApiProviderId: provider.id }).settings.apiProviders[0].models[0];
  const runtime = config => api.createPiProviderModelDefinition({ providerId: "ollama", apiProtocol: "openai-completions", baseUrl, modelRef: config.id, reasoning: config.reasoning });
  const dispatcher = api.createConfiguredPiProviderProtocolDispatcher({ ...provider });
  const context = { systemPrompt: "你是日记陪伴。", messages: [{ role: "user", content: "你好", timestamp: 1 }],
    tools: [{ name: "diary_read", description: "Read diary", parameters: { type: "object", properties: { date: { type: "string" } } } }] };
  const send = (model, reasoning = "medium") => dispatcher.streamSimple({ model, context, apiKey: "", options: { reasoning, maxTokens: 64, maxRetries: 0 } }).result();
  const legacy = await send(runtime({ id: OLLAMA_FIXTURE_MODEL, reasoning: true }));
  assert.equal(legacy.stopReason, "error");
  assert.equal(records.at(-1).status, 400);
  assert.equal(records.at(-1).body.reasoning_effort, "medium");
  const preflight = await dispatcher.stream({ model: runtime({ id: OLLAMA_FIXTURE_MODEL, reasoning: true }), context: { ...context, tools: [] }, apiKey: "", options: { reasoning: "medium", maxTokens: 32 } }).result();
  assert.equal(preflight.stopReason, "stop", "old connection check can succeed while chat sends reasoning_effort");
  assert.equal(records.at(-1).body.reasoning_effort, undefined);
  const fixed = await send(runtime(reopened));
  assert.equal(fixed.stopReason, "stop", "ID-only Ollama discovery must not assume thinking support");
  assert.equal(records.at(-1).body.reasoning_effort, undefined);
  assert.equal(records.at(-1).body.thinking, undefined);
  assert.equal(records.at(-1).body.enable_thinking, undefined);
  assert.equal(records.at(-1).body.tools.length, 1);
  assert.equal(reopened.reasoningEnabled, false);
  assert.equal(api.createApiProviderModelConfig("custom", "unknown-cloud").reasoning, true);
  const thinking = api.createDiscoveredApiProviderModelConfig("ollama", "thinking-fixture", "ollama", { id: "thinking-fixture", reasoning: true });
  assert.equal((await send(runtime(thinking), "high")).stopReason, "stop");
  assert.equal(records.at(-1).body.reasoning_effort, "high", "declared thinking models retain reasoning");
  const manual = api.normalizeSettingsData({ apiProviders: [{ ...provider, models: [{ ...discovered, capabilityOverrides: { reasoning: true }, reasoningEnabled: true }] }] }).settings.apiProviders[0].models[0];
  assert.equal(manual.reasoning, true, "explicit user capability declarations survive reopening");
  forcedError = "Unsupported parameter max_tokens; Bearer sk-fixture-secret-12345";
  const key = "sk-fixture-secret-12345";
  const transport = new api.PiProviderProtocolTransport({ authorityId: "fixture", storeSetId: "fixture", resolveAuthToken: () => key, dispatcher });
  const model = runtime(reopened);
  const error = await (await transport.stream({ runId: "r", turnId: "t", conversationId: "c", correlationId: "x",
    model, context, provider: { providerId: "ollama", apiProtocol: "openai-completions", authMode: "api-key", baseUrl, modelRef: model.id },
    options: { temperature: 0, cacheRetention: "none", maxRetries: 0, timeoutMs: 1000 } })).result();
  assert.match(api.assistantProviderFailureText(error), /HTTP 400.*Unsupported parameter max_tokens/su);
  assert.doesNotMatch(JSON.stringify(error), /sk-fixture-secret|Bearer/u);
  assert.equal(error.errorMessage, "provider_http_failed", "safe retry classification remains stable");
  assert.equal(api.sanitizeProviderFailureDetail(400, { error: "model does not support thinking" }).message, "model does not support thinking", "Ollama native string errors retain the message too");
  const previousWindow = globalThis.window;
  globalThis.window = { setTimeout, clearTimeout };
  try {
    const result = await api.testProviderConnection({ draft: { ...provider, modelId: model.id, toolCalling: true, imageInput: false,
      reasoning: false, contextWindow: 64000, modelMaxTokens: 8192, maxOutputTokens: 8192 }, apiKey: key, dispatcher });
    assert.equal(result.status, "failed");
    assert.match(result.detail.message, /Unsupported parameter max_tokens/u);
    assert.doesNotMatch(JSON.stringify(result), /sk-fixture-secret|Bearer/u);
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
  console.log("PASS Ollama: legacy 400 reproduced over real loopback HTTP; ID-only discovery/reopen fixed; tools retained; explicit thinking preserved; 400 detail survives production transport with redaction");
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
