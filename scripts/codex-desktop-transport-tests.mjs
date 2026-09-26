import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { createRequire, isBuiltin } from "node:module";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { webcrypto } from "node:crypto";
import esbuild from "esbuild";
import ts from "typescript";
import { piCodexDesktopTransportPlugin } from "./pi-codex-desktop-transport.mjs";

// Exercise the production build rewrite and Pi codec without contacting OpenAI.
// Electron events are simulated; actual Obsidian/proxy acceptance is separate.
const root = fileURLToPath(new URL("../", import.meta.url));
// Use the actual production adapter verbatim, while leaving unrelated Provider
// catalogs and the coding-agent CLI out of this focused runtime fixture.
const adapterSource = await readFile(new URL("../src/harness/pi/pi-provider-protocol-adapter.ts", import.meta.url), "utf8");
const adapterAst = ts.createSourceFile("pi-provider-protocol-adapter.ts", adapterSource, ts.ScriptTarget.Latest, true);
const adapter = adapterAst.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "createOpenAICodexSseAdapter");
assert.ok(adapter, "production Codex SSE adapter must exist");
const build = await esbuild.build({
  stdin: {
    contents: `export {createCodexDesktopFetch} from "./src/plugin/codex-desktop-fetch";
      import {openAICodexResponsesApi} from "@earendil-works/pi-ai/api/openai-codex-responses.lazy";
      ${adapter.getText(adapterAst)}`,
    resolveDir: root,
    loader: "ts"
  },
  bundle: true,
  write: false,
  platform: "node",
  target: "node20",
  format: "cjs",
  external: ["electron", "obsidian"],
  plugins: [piCodexDesktopTransportPlugin],
  logLevel: "silent"
});
const localRequire = createRequire(import.meta.url);
let nativeRequestFactory;
let browserFetchCalls = 0;
const browserFetch = () => {
  browserFetchCalls++;
  throw new Error("Browser fetch is CORS-blocked in this fixture");
};
const requireHost = name => {
  if (name === "electron") return { remote: { net: { request: options => nativeRequestFactory(options) } } };
  if (name === "obsidian") return { Platform: { isDesktopApp: true } };
  assert.ok(isBuiltin(name), `unexpected external dependency: ${name}`);
  return localRequire(name);
};
const module = { exports: {} };
const context = vm.createContext({
  module, exports: module.exports, require: requireHost,
  window: { require: requireHost },
  // Obsidian's supported Node 20 host does not have getBuiltinModule/zstd.
  process: new Proxy(process, { get(target, name) { return name === "getBuiltinModule" ? undefined : Reflect.get(target, name); } }),
  Buffer, Headers, Response, Request, ReadableStream,
  AbortController, AbortSignal, DOMException, Error, TypeError, RangeError, URL, TextEncoder, TextDecoder,
  atob, btoa, crypto: webcrypto, performance, fetch: browserFetch,
  setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask, console
});
vm.runInContext(build.outputFiles[0].text, context, { filename: "codex-desktop-transport-fixture.cjs" });
const { createCodexDesktopFetch, createOpenAICodexSseAdapter } = module.exports;

class NativeRequest extends EventEmitter {
  headers = new Map();
  writes = [];
  aborts = 0;
  ended = false;
  constructor(options) { super(); this.options = options; }
  setHeader(name, value) { this.headers.set(name.toLowerCase(), value); }
  write(value) { this.writes.push(Buffer.from(value)); }
  end() {
    this.ended = true;
    // Observed in Obsidian 1.13.7 / Electron 30: the request's writable side
    // closes before response headers/data arrive. Only response completion is
    // terminal for the response body.
    this.emit("finish");
    this.emit("close");
  }
  abort() { this.aborts++; this.emit("abort"); this.emit("close"); }
  respond(status = 200, headers = { "content-type": "text/event-stream" }) {
    const response = new EventEmitter();
    Object.assign(response, { statusCode: status, statusMessage: status === 200 ? "OK" : "Fixture error", headers });
    this.emit("response", response);
    return response;
  }
}
function host() {
  const requests = [];
  const factory = options => { const request = new NativeRequest(options); requests.push(request); return request; };
  return { requests, factory, fetch: createCodexDesktopFetch(factory) };
}
async function bounded(value, label) {
  let timer;
  try {
    return await Promise.race([value, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), 2000);
    })]);
  } finally { clearTimeout(timer); }
}
async function until(predicate, label) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 1));
  }
}
const abortError = error => error?.name === "AbortError" || /abort/i.test(error?.message ?? "");
let passed = 0;
async function test(name, run) { await run(); passed++; console.log(`OK ${name}`); }

await test("native POST preserves headers/body and yields bytes before response end", async () => {
  const fixture = host();
  const pending = fixture.fetch("https://chatgpt.com/backend-api/codex/responses", {
    method: "POST", headers: { Authorization: "Bearer fixture", "Content-Type": "application/json" }, body: '{"input":"你好"}'
  });
  await until(() => fixture.requests.length, "native request creation");
  const request = fixture.requests[0];
  assert.equal(request.options.url, "https://chatgpt.com/backend-api/codex/responses");
  assert.equal(request.options.method, "POST");
  assert.equal(request.options.redirect, "error");
  assert.equal(request.headers.get("authorization"), "Bearer fixture");
  assert.equal(request.headers.get("content-type"), "application/json");
  assert.equal(Buffer.concat(request.writes).toString(), '{"input":"你好"}');
  assert.equal(request.ended, true);
  const incoming = request.respond();
  const response = await bounded(pending, "headers resolve fetch");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("access-control-allow-origin"), null);
  const reader = response.body.getReader();
  const bytes = Buffer.from("你好");
  const decoder = new TextDecoder();
  const first = reader.read();
  incoming.emit("data", bytes.subarray(0, 2));
  const firstChunk = await bounded(first, "incremental first bytes");
  assert.equal(firstChunk.done, false);
  let text = decoder.decode(firstChunk.value, { stream: true });
  incoming.emit("data", bytes.subarray(2));
  text += decoder.decode((await bounded(reader.read(), "incremental second bytes")).value, { stream: true });
  incoming.emit("end"); incoming.emit("close");
  assert.equal((await bounded(reader.read(), "normal completion")).done, true);
  assert.equal(text + decoder.decode(), "你好");

  // Newer Electron/Node hosts may let Pi send zstd bytes instead of JSON text.
  const binary = host(); const buffer = new Uint8Array([0, 1, 2, 3]);
  const binaryPending = binary.fetch("https://chatgpt.com/backend-api/codex/responses", { method: "POST", body: buffer.subarray(1, 3) });
  await until(() => binary.requests.length, "binary request creation");
  const binaryIncoming = binary.requests[0].respond();
  assert.deepEqual([...Buffer.concat(binary.requests[0].writes)], [1, 2]);
  binaryIncoming.emit("end");
  await bounded(binaryPending, "binary response");
});

await test("HTTP auth/rate-limit failures preserve response metadata and body", async () => {
  for (const status of [401, 429]) {
    const fixture = host();
    const pending = fixture.fetch("https://chatgpt.com/backend-api/codex/responses", { method: "POST", body: "{}" });
    await until(() => fixture.requests.length, "error request creation");
    const incoming = fixture.requests[0].respond(status, { "content-type": "application/json", "retry-after": "2", "x-request-id": "fixture-id" });
    const response = await bounded(pending, "error response headers");
    assert.equal(response.status, status); assert.equal(response.ok, false);
    assert.equal(response.headers.get("retry-after"), "2");
    assert.equal(response.headers.get("x-request-id"), "fixture-id");
    incoming.emit("data", Buffer.from('{"error":{"message":"fixture rejection"}}')); incoming.emit("end");
    assert.equal(await bounded(response.text(), "error response body"), '{"error":{"message":"fixture rejection"}}');
  }
});

await test("short responses finish when native data registration immediately flushes the entire body", async () => {
  for (const status of [200, 401]) {
    const fixture = host();
    const body = status === 200 ? '{"result":"完整短响应"}' : '{"error":{"message":"fixture rejection"}}';
    const pending = fixture.fetch("https://chatgpt.com/backend-api/codex/responses", { method: "POST", body: "{}" });
    await until(() => fixture.requests.length, "short response request creation");
    // Starting flow through Electron remote can deliver a buffered short body
    // and its terminal events while the data listener is being registered.
    class ShortResponse extends EventEmitter {
      statusCode = status;
      statusMessage = status === 200 ? "OK" : "Unauthorized";
      headers = { "content-type": "application/json" };
      on(event, listener) {
        const result = super.on(event, listener);
        if (event === "data") {
          this.emit("data", Buffer.from(body));
          this.emit("end");
          this.emit("close");
        }
        return result;
      }
    }
    fixture.requests[0].emit("response", new ShortResponse());
    const response = await bounded(pending, "short response headers");
    assert.equal(response.status, status);
    assert.equal(await bounded(response.text(), "short response complete body"), body);
    assert.equal(fixture.requests[0].aborts, 0, "a complete short response must not be treated as interrupted");
  }
});

await test("pre-abort, header wait abort, streaming abort and reader cancel stop native requests", async () => {
  const pre = host(); const already = new AbortController(); already.abort();
  await assert.rejects(bounded(pre.fetch("https://chatgpt.com/backend-api/codex/responses", { signal: already.signal }), "pre-abort"), abortError);
  assert.equal(pre.requests.length, 0);
  for (const phase of ["headers", "stream", "reader"]) {
    const fixture = host(); const controller = new AbortController();
    const pending = fixture.fetch("https://chatgpt.com/backend-api/codex/responses", { signal: controller.signal });
    await until(() => fixture.requests.length, `${phase} request creation`);
    const request = fixture.requests[0];
    if (phase === "headers") {
      controller.abort();
      await assert.rejects(bounded(pending, "abort waiting for headers"), abortError);
    } else {
      request.respond();
      const response = await pending; const reader = response.body.getReader();
      const read = reader.read();
      if (phase === "reader") {
        await bounded(reader.cancel(), "reader cancellation");
        assert.equal((await bounded(read, "cancelled reader completion")).done, true);
      } else {
        controller.abort();
        await assert.rejects(bounded(read, "abort streaming response"), abortError);
      }
    }
    assert.equal(request.aborts, 1, `${phase} must abort the underlying native request once`);
  }
});

await test("request errors and interrupted response bodies reject without hanging", async () => {
  const initial = host(); const pending = initial.fetch("https://chatgpt.com/backend-api/codex/responses", {});
  await until(() => initial.requests.length, "failed request creation");
  initial.requests[0].emit("error", new Error("fixture connection failed"));
  await assert.rejects(bounded(pending, "request failure"), /fixture connection failed/);
  for (const event of ["error", "aborted", "close"]) {
    const fixture = host(); const pendingResponse = fixture.fetch("https://chatgpt.com/backend-api/codex/responses", {});
    await until(() => fixture.requests.length, "interrupted request creation");
    const incoming = fixture.requests[0].respond(); const response = await pendingResponse;
    const read = response.body.getReader().read();
    incoming.emit(event, new Error("fixture interrupted body"));
    await assert.rejects(bounded(read, `body ${event}`));
  }
});

const model = {
  id: "fixture-codex", name: "Fixture Codex", api: "openai-codex-responses", provider: "openai-codex",
  baseUrl: "https://chatgpt.com/backend-api", reasoning: true, input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096
};
const token = `fixture.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account" } })).toString("base64url")}.fixture`;
const sse = value => Buffer.from(`data: ${JSON.stringify(value)}\n\n`);
function startPi(fixture, signal) {
  nativeRequestFactory = fixture.factory;
  return createOpenAICodexSseAdapter().streamSimple(model, { messages: [{ role: "user", content: "fixture", timestamp: 1 }] }, {
    apiKey: token, signal, timeoutMs: 1000, maxRetries: 0
  });
}
function textStart(incoming) {
  incoming.emit("data", sse({ type: "response.created", response: { id: "fixture-response" } }));
  incoming.emit("data", sse({ type: "response.output_item.added", output_index: 0, item: { id: "fixture-message", type: "message", role: "assistant", content: [] } }));
}
await test("production Pi build rewrite streams Codex text without browser fetch", async () => {
  const fixture = host(); const stream = startPi(fixture); const events = [];
  const consume = (async () => { for await (const event of stream) events.push(event); })();
  await until(() => fixture.requests.length, "Pi native request");
  const request = fixture.requests[0];
  assert.equal(request.options.url, "https://chatgpt.com/backend-api/codex/responses");
  assert.equal(request.headers.get("chatgpt-account-id"), "fixture-account");
  assert.equal(JSON.parse(Buffer.concat(request.writes).toString()).stream, true);
  const incoming = request.respond(); textStart(incoming);
  const delta = sse({ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "你好" });
  const split = delta.indexOf(Buffer.from("你")) + 1;
  incoming.emit("data", delta.subarray(0, split)); incoming.emit("data", delta.subarray(split));
  await until(() => events.some(event => event.type === "text_delta"), "Pi incremental text before end");
  incoming.emit("data", sse({ type: "response.completed", response: { id: "fixture-response", status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }));
  incoming.emit("end");
  await bounded(consume, "Pi normal terminal event");
  const result = await stream.result();
  assert.equal(result.stopReason, "stop"); assert.equal(result.content[0].text, "你好");
  assert.equal(events.at(-1).type, "done");
});

await test("Pi user stop after headers cancels its reader and native request", async () => {
  const fixture = host(); const controller = new AbortController(); const stream = startPi(fixture, controller.signal);
  const events = []; const consume = (async () => { for await (const event of stream) events.push(event); })();
  await until(() => fixture.requests.length, "Pi cancellable request");
  const request = fixture.requests[0]; const incoming = request.respond(); textStart(incoming);
  incoming.emit("data", sse({ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "partial" }));
  await until(() => events.some(event => event.type === "text_delta"), "Pi partial output");
  controller.abort();
  await bounded(consume, "Pi user stop");
  assert.equal((await stream.result()).stopReason, "aborted");
  assert.equal(request.aborts, 1);
});

assert.equal(browserFetchCalls, 0, "Codex must never invoke the CORS-blocked renderer fetch");
assert.equal(context.fetch, browserFetch, "the transport must not replace global fetch");
console.log(`Codex desktop transport: ${passed} cases passed (${process.platform}; simulated Electron, real Pi codec/build rewrite).`);
