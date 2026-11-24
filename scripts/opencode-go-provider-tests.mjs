import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import esbuild from "esbuild";
import { desktopNodeTestBanner, desktopNodeTestAliases } from "./desktop-node-test-host.mjs";

// OpenCode Go：预设、请求头（会话号/客户端名）、套餐类报错。只用本机假服务，不连真实接口。
const root = fileURLToPath(new URL("../", import.meta.url));
const directory = await mkdtemp(path.join(tmpdir(), "echoink-opencode-go-test-"));
const requests = [];
const originalFetch = globalThis.fetch;
const originalWindow = globalThis.window;
let reply = () => ({ status: 200 });
const server = createServer((request, response) => {
  let body = "";
  request.on("data", chunk => { body += chunk; });
  request.on("end", () => {
    requests.push({ url: request.url, headers: request.headers, body });
    const { status, json } = reply();
    if (status !== 200) {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(json));
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    const chunk = (delta, finish = null) => `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "glm-5.3", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    response.end(chunk({ role: "assistant", content: "好" }) + chunk({}, "stop") + "data: [DONE]\n\n");
  });
});
try {
  const outfile = path.join(directory, "entry.mjs");
  await esbuild.build({
    stdin: { contents: `export {API_PROVIDER_PRESETS,getApiProviderPreset,normalizeApiProviderId,isOpenCodeGoApiProviderUrl,OPENCODE_GO_API_BASE_URL} from "./src/settings/provider-presets";
      export {createApiProviderConfig,normalizeSettingsData} from "./src/settings/settings";
      export {createPiProviderModelDefinition} from "./src/harness/pi/production-pi-model-resolver";
      export {resolveConfiguredPiProviderTransportKind} from "./src/plugin/configured-pi-provider-dispatcher";
      export {PiProviderProtocolDispatcher} from "./src/harness/pi/pi-provider-protocol-adapter";
      export {testProviderConnection} from "./src/plugin/pi-provider-configuration-service";
      export {providerFailureText,providerPlanFailureCode} from "./src/harness/pi/provider-failure";
      export {buildMobileRequest,mobileStream} from "./src/mobile/transport";
      export {mobilePresets} from "./src/mobile/settings";
      export {MOBILE_MODEL_GROUPS} from "./src/mobile/model-configuration";
      export {openCodeSessionHeaders,withOpenCodeRequestHeaders,isOpenCodeModel} from "./src/harness/pi/opencode-go-headers";
      export {providerServiceCategories} from "./src/settings/provider-service-categories";`, resolveDir: root, loader: "ts" },
    bundle: true, platform: "node", format: "esm", target: "node22", outfile,
    alias: desktopNodeTestAliases, banner: desktopNodeTestBanner, logLevel: "silent",
    loader: { ".md": "text", ".svg": "dataurl", ".webp": "dataurl" },
    plugins: [{ name: "pi-externals", setup(build) {
      build.onResolve({ filter: /^@earendil-works\/pi-(agent-core|ai|coding-agent)(\/|$)/ }, args => ({ path: fileURLToPath(import.meta.resolve(args.path)), external: true }));
    } }]
  });
  const api = await import(pathToFileURL(outfile).href);

  // 1. 预设：放在“套餐”分组，需要 API Key，默认 OpenAI 兼容协议。
  const preset = api.getApiProviderPreset("opencode-go");
  assert.equal(preset.id, "opencode-go");
  assert.equal(preset.baseUrl, "https://opencode.ai/inference/go/v1");
  assert.equal(preset.apiProtocol, "openai-completions");
  assert.equal(preset.apiKeyRequired, true);
  const plan = api.providerServiceCategories("zh-CN").find(category => category.id === "plan");
  assert.ok(plan.presets.some(item => item.id === "opencode-go"), "OpenCode Go 应出现在套餐分组");
  assert.equal(api.normalizeApiProviderId(undefined, "https://opencode.ai/zen/go/v1"), "opencode-go");
  assert.equal(api.normalizeApiProviderId(undefined, "https://opencode.ai/inference/go/v1"), "opencode-go");
  assert.equal(api.isOpenCodeGoApiProviderUrl("https://opencode.ai/zen/v1"), false);
  const config = api.createApiProviderConfig("opencode-go", "opencode-go-test");
  const saved = api.normalizeSettingsData({ apiProviders: [config], activeApiProviderId: config.id }).settings.apiProviders[0];
  assert.equal(saved.providerId, "opencode-go");
  assert.equal(saved.runtimeProviderId, "opencode-go");

  // 2. 请求头：只对 OpenCode 生效；已有会话号不被覆盖；没有时按请求补一个。
  const other = { provider: "deepseek", baseUrl: "https://api.deepseek.com" };
  assert.equal(api.openCodeSessionHeaders(other, "s"), undefined);
  assert.deepEqual(api.withOpenCodeRequestHeaders(other, { maxTokens: 1 }), { maxTokens: 1 });
  const goModel = { provider: "opencode-go", baseUrl: "http://127.0.0.1:1/v1" };
  assert.equal(api.withOpenCodeRequestHeaders(goModel, { headers: { "X-OpenCode-Session": "keep" } }).headers["X-OpenCode-Session"], "keep");
  const filled = api.withOpenCodeRequestHeaders(goModel, {}).headers;
  assert.match(filled["x-opencode-session"], /^[0-9a-f-]{36}$/u);
  assert.equal(filled["x-opencode-client"], "echoink");
  assert.equal(api.isOpenCodeModel({ provider: "echoink-custom", baseUrl: "https://opencode.ai/inference/go/v1" }), true, "自定义服务填 opencode.ai 地址也要带头");

  // 3. 真实 Pi 适配器发出的 HTTP 请求里能看到这两个头，且同一会话号保持不变。
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  globalThis.fetch = (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.href, `${preset.baseUrl}/chat/completions`, "route the official Go URL to the fixture only");
    return originalFetch(`${baseUrl}/chat/completions`, init);
  };
  const model = api.createPiProviderModelDefinition({ providerId: "opencode-go", runtimeProviderId: "opencode-go", apiProtocol: "openai-completions", baseUrl: preset.baseUrl, modelRef: "glm-5.3", reasoning: false });
  assert.equal(model.provider, "opencode-go");
  // 真实地址走默认分发器；上面的 fetch 拦截将请求送到本机假服务。
  assert.equal(api.resolveConfiguredPiProviderTransportKind({ providerId: "opencode-go", runtimeProviderId: "opencode-go", apiProtocol: "openai-completions", baseUrl: preset.baseUrl }), "default");
  const dispatcher = new api.PiProviderProtocolDispatcher({});
  const context = { systemPrompt: "你是日记陪伴。", messages: [{ role: "user", content: "你好", timestamp: 1 }] };
  const send = headers => dispatcher.streamSimple({ model, context, apiKey: "test-key", options: { maxTokens: 32, maxRetries: 0, ...(headers ? { headers } : {}) } }).result();
  const ok = await send({ "x-opencode-session": "conversation-1" });
  assert.equal(ok.stopReason, "stop");
  assert.equal(requests.at(-1).headers["x-opencode-session"], "conversation-1");
  assert.equal(requests.at(-1).headers["x-opencode-client"], "echoink");
  await send();
  assert.match(requests.at(-1).headers["x-opencode-session"], /^[0-9a-f-]{36}$/u, "连接测试等无对话请求也带会话号");

  // 4. 套餐类报错：未订阅、额度用完给出正式文案，其它报错不受影响。
  reply = () => ({ status: 403, json: { type: "error", error: { type: "EntitlementError", message: "OpenCode Go subscription required." } } });
  globalThis.window = { setTimeout, clearTimeout };
  const testConnection = () => api.testProviderConnection({
    draft: {
      providerSettingsId: config.id, providerId: "opencode-go", runtimeProviderId: "opencode-go", baseUrl: preset.baseUrl,
      authMode: "api-key", apiProtocol: "openai-completions", apiKey: "test-key", modelId: "glm-5.3",
      contextWindow: 1_000_000, modelMaxTokens: 131_072, maxOutputTokens: 32, reasoning: false, toolCalling: false, imageInput: false
    },
    apiKey: "test-key", dispatcher
  });
  assert.equal((await testConnection()).failure, "provider_plan_subscription_required");
  reply = () => ({ status: 429, json: { type: "error", error: { type: "GoUsageLimitError", message: "The allowance has been used up." } } });
  assert.equal((await testConnection()).failure, "provider_plan_usage_limited");
  assert.equal(api.providerPlanFailureCode('429 {"type":"error","error":{"type":"GoUsageLimitError","message":"limit"}}'), "provider_plan_usage_limited");
  assert.equal(api.providerPlanFailureCode("401 invalid api key"), null);
  assert.match(api.providerFailureText("provider_plan_subscription_required"), /套餐/u);
  assert.match(api.providerFailureText("provider_plan_usage_limited"), /额度已用完/u);
  // 5. 手机端：出现在“套餐”分组；请求带同样的头；未订阅给出套餐文案而不是“API Key 无效”。
  assert.ok(api.mobilePresets.some(item => item.id === "opencode-go"));
  assert.ok(api.MOBILE_MODEL_GROUPS.find(group => group.title === "套餐").ids.includes("opencode-go"));
  const mobileProvider = { ...api.createApiProviderConfig("opencode-go", "opencode-go-mobile"), apiKey: "test-key" };
  const mobileModel = api.createPiProviderModelDefinition({ providerId: "opencode-go", apiProtocol: "openai-completions", baseUrl: preset.baseUrl, modelRef: "glm-5.3" });
  const turn = { conversationId: "conv-1", turnId: "t1" };
  const built = api.buildMobileRequest(mobileProvider, mobileModel, context, undefined, false, turn);
  assert.equal(built.headers.Authorization, "Bearer test-key");
  assert.equal(built.headers["x-opencode-client"], "echoink");
  const session = built.headers["x-opencode-session"];
  assert.match(session, /^[0-9a-f]{64}$/u);
  assert.equal(api.buildMobileRequest(mobileProvider, mobileModel, context, undefined, false, turn).headers["x-opencode-session"], session, "同一对话会话号不变");
  assert.match(api.buildMobileRequest(mobileProvider, mobileModel, context).headers["x-opencode-session"], /^[0-9a-f-]{36}$/u);
  const deepseekProvider = { ...api.createApiProviderConfig("deepseek", "deepseek-mobile"), apiKey: "k" };
  const deepseekModel = api.createPiProviderModelDefinition({ providerId: "deepseek", apiProtocol: "openai-completions", baseUrl: "https://api.deepseek.com", modelRef: "deepseek-v4-flash" });
  assert.equal(api.buildMobileRequest(deepseekProvider, deepseekModel, context).headers["x-opencode-session"], undefined, "其他服务商不带");
  const fakeRequest = async () => ({ status: 403, json: { type: "error", error: { type: "EntitlementError", message: "OpenCode Go subscription required." } } });
  const failed = await api.mobileStream(mobileProvider, fakeRequest)(mobileModel, context, {}).result();
  assert.equal(failed.stopReason, "error");
  assert.match(failed.errorMessage, /套餐/u, failed.errorMessage);
  console.log("PASS OpenCode Go preset, session/client headers on the wire, plan failure copy, mobile");
} finally {
  globalThis.fetch = originalFetch;
  globalThis.window = originalWindow;
  server.close();
  await rm(directory, { recursive: true, force: true });
}
