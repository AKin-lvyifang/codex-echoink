import * as assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  createAssistantMessageEventStream, isRetryableAssistantError, isContextOverflow,
  type Api, type AssistantMessage, type AssistantMessageEvent, type Context,
  type Model, type ProviderStreams, type SimpleStreamOptions
} from "@earendil-works/pi-ai";
import { PiProviderProtocolDispatcher, PiProviderProtocolTransport } from "../harness/pi/pi-provider-protocol-adapter";
import { type PiAutoOutputLimitPolicy, type PiAutoOutputLimitRequestState } from "../harness/pi/auto-output-limit";
import { providerFailureText, safeProviderFailureCode, type AssistantProviderFailure } from "../harness/pi/provider-failure";
import { estimatePiContextTokens } from "../harness/pi-native/pi-context-budget";
import { PI_ANTHROPIC_PDF_DOCUMENT_ADAPTER } from "../harness/pi-native/pi-document-context";
import { createQwenTokenPlanOpenAICompletionsAdapter } from "../plugin/qwen-token-plan-provider-adapter";
import { QWEN_TOKEN_PLAN_API_BASE_URL } from "../settings/provider-presets";

const key = "sk-fixture-output-limits-never-real";
const context: Context = {
  systemPrompt: "Fixture system",
  messages: [{ role: "user", content: "Fixture question", timestamp: 1 }],
  tools: [{ name: "fixture_read", description: "Read fixture", parameters: { type: "object", properties: {} } }]
};
function model(api: Api = "openai-completions"): Model<Api> {
  return { api, provider: api === "anthropic-messages" ? "anthropic" : "openai", id: "fixture-model", name: "Fixture",
    baseUrl: "https://fixture.invalid/v1", reasoning: true, input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 64000, maxTokens: 8192 };
}
function assistant(m = model(), errorMessage?: string): AssistantMessage {
  return { role: "assistant", api: m.api, provider: m.provider, model: m.id, content: [],
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, timestamp: 2,
    stopReason: errorMessage ? "error" : "stop", ...(errorMessage ? { errorMessage } : {}) };
}
function policy(limits: ReturnType<PiAutoOutputLimitPolicy["read"]> = {}) {
  const writes: { maxOutputTokens?: number; contextWindow?: number }[] = [];
  const value: PiAutoOutputLimitPolicy = { read: () => limits, remember: (_model, learned) => { writes.push(learned); } };
  return { value, writes };
}
async function collect(stream: ReturnType<PiProviderProtocolDispatcher["stream"]>) {
  const events: AssistantMessageEvent[] = [];
  for await (const event of stream) events.push(event);
  return { result: await stream.result(), events };
}
type Attempt = { status?: number; error?: string; content?: AssistantMessage["content"]; start?: boolean;
  onAttempt?: () => void | Promise<void>; detail?: AssistantProviderFailure["echoInkProviderFailure"] };
function fixture(attempts: Attempt[]) {
  const calls: { model: Model<Api>; options: SimpleStreamOptions; payload: Record<string, unknown> }[] = [];
  const run: ProviderStreams["streamSimple"] = (m, ctx, opts = {}) => {
    const stream = createAssistantMessageEventStream();
    const attempt = attempts[calls.length] ?? {};
    const call = { model: m, options: opts, payload: {} as Record<string, unknown> };
    calls.push(call);
    void (async () => {
      const raw = { messages: ctx.messages, max_completion_tokens: opts.maxTokens ?? m.maxTokens };
      call.payload = (await opts.onPayload?.(raw, m) ?? raw) as Record<string, unknown>;
      await attempt.onAttempt?.();
      if (attempt.status !== undefined) await opts.onResponse?.({ status: attempt.status, headers: {} }, m);
      const message = assistant(m, attempt.error);
      if (attempt.content) message.content = attempt.content;
      if (attempt.start) stream.push({ type: "start", partial: assistant(m) });
      if (attempt.error) stream.push({ type: "error", reason: opts.signal?.aborted ? "aborted" : "error",
        error: Object.assign(message, attempt.detail ? { echoInkProviderFailure: attempt.detail } : {}) });
      else stream.push({ type: "done", reason: "stop", message });
    })().catch(error => stream.push({ type: "error", reason: "error", error: assistant(m, String(error)) }));
    return stream;
  };
  return { calls, adapter: { stream: run, streamSimple: run } as ProviderStreams };
}
function dispatcher(f: ReturnType<typeof fixture>, p: ReturnType<typeof policy>) {
  return new PiProviderProtocolDispatcher({ "openai-completions": f.adapter }, p.value);
}
function send(d: PiProviderProtocolDispatcher, options: SimpleStreamOptions = {}, state?: PiAutoOutputLimitRequestState) {
  return d.streamSimple({ model: model(), context, apiKey: key, options, autoOutputLimitState: state });
}
const explicitErrors = [
  ["400 {\"error\":{\"message\":\"max_tokens must be in the range [1, 8192]\"}}", 8192],
  ["422 {\"error\":{\"message\":\"Range of max_tokens should be [1, 32768]\"}}", 32768],
  ["400 This model supports at most 16384 completion tokens", 16384],
  ["400 max_tokens: 262144 > 8192, which is the maximum allowed number of output tokens", 8192],
  ["400 MiniMax does not support max tokens > 65536", 65536]
] as const;

async function sdkRequests(): Promise<void> {
  const previous = globalThis.fetch;
  try {
    for (const api of ["openai-completions", "openai-responses", "anthropic-messages"] as const) {
      for (const method of ["stream", "streamSimple"] as const) {
        const bodies: Record<string, any>[] = [];
        globalThis.fetch = async (_url, init) => {
          bodies.push(JSON.parse(String(init?.body)));
          return bodies.length === 1
            ? new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message:
              api === "anthropic-messages" ? "max_tokens: 262144 > 8192, which is the maximum allowed number of output tokens"
                : "This model supports at most 8192 completion tokens" } }), { status: 400, headers: { "content-type": "application/json" } })
            : sdkSuccess(api);
        };
        const p = policy();
        const d = new PiProviderProtocolDispatcher({}, p.value);
        const m = model(api), before = structuredClone(m);
        const stream = d[method]({ model: m, context, apiKey: key, options: {
          maxRetries: 0, timeoutMs: 5000, reasoning: "high",
          onPayload: payload => ({ ...payload as object, fixture_transform: true })
        } });
        const r = await collect(stream);
        assert.equal(r.result.stopReason, "stop", `${api}/${method}: ${r.result.errorMessage}`);
        assert.equal(bodies.length, 2);
        const field = api === "anthropic-messages" ? "max_tokens"
          : api === "openai-responses" ? "max_output_tokens" : "max_completion_tokens";
        assert.equal(bodies[0]![field], 262144, `${api}/${method} initial wire field`);
        assert.equal(bodies[1]![field], 8192, `${api}/${method} retry wire field`);
        assert.equal(bodies[1]!.fixture_transform, true);
        assert.ok(bodies[1]!.tools?.length, "existing tool/schema transforms survive");
        if (api === "anthropic-messages" && method === "streamSimple") {
          assert.ok(bodies[1]!.thinking.budget_tokens < 8192, "thinking must fit inside the retry cap");
        }
        assert.deepEqual(p.writes, [{ maxOutputTokens: 8192 }]);
        assert.deepEqual(m, before, "session model is never changed");
        assert.equal(r.events.filter(e => e.type === "error").length, 0, "first rejection remains private");
      }
    }
    for (const api of ["openai-completions", "openai-responses", "anthropic-messages"] as const) {
      const bodies: Record<string, any>[] = [];
      globalThis.fetch = async (_url, init) => { bodies.push(JSON.parse(String(init?.body))); return sdkSuccess(api); };
      await new PiProviderProtocolDispatcher({}, policy().value).streamSimple({ model: model(api), context, apiKey: key,
        options: { maxTokens: 32, maxRetries: 0 } }).result();
      const field = api === "anthropic-messages" ? "max_tokens" : api === "openai-responses" ? "max_output_tokens" : "max_completion_tokens";
      // Responses SDK has its own pre-existing minimum (16); 32 stays explicit.
      assert.equal(bodies[0]![field], 32);
    }
  } finally { globalThis.fetch = previous; }
}

function sdkSuccess(api: Api): Response {
  let events: Record<string, unknown>[];
  if (api === "openai-completions") events = [
    { id: "fixture", choices: [{ index: 0, delta: { role: "assistant", content: "OK" }, finish_reason: null }] },
    { id: "fixture", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }
  ];
  else if (api === "anthropic-messages") events = [
    { type: "message_start", message: { id: "fixture", role: "assistant", content: [], usage: { input_tokens: 1, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "OK" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }, { type: "message_stop" }
  ];
  else events = [
    { type: "response.created", response: { id: "fixture" } },
    { type: "response.output_item.added", output_index: 0, item: { id: "msg", type: "message", role: "assistant", content: [] } },
    { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "OK" },
    { type: "response.output_item.done", output_index: 0, item: { id: "msg", type: "message", role: "assistant", content: [{ type: "output_text", text: "OK" }] } },
    { type: "response.completed", response: { id: "fixture", status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }
  ];
  return new Response(events.map(e => `${e.type ? `event: ${e.type}\n` : ""}data: ${JSON.stringify(e)}\n\n`).join(""),
    { status: 200, headers: { "content-type": "text/event-stream" } });
}

export async function runAutoOutputLimitTests(): Promise<void> {
  await sdkRequests();
  console.log("PASS auto output: actual SDK stream/streamSimple wire fields for all three protocols, Anthropic thinking, explicit preflight cap");
  for (const [error, cap] of explicitErrors) {
    const f = fixture([{ error }, {}]), p = policy();
    const result = await collect(send(dispatcher(f, p)));
    assert.equal(result.result.stopReason, "stop", error);
    assert.deepEqual(f.calls.map(c => c.options.maxTokens), [262144, cap], error);
    assert.deepEqual(p.writes, [{ maxOutputTokens: cap }], error);
    assert.deepEqual(result.events.map(e => e.type), ["done"]);
  }
  for (const error of ["400 invalid_request_error", '422 {"error":{"code":"1214","message":"参数错误"}}',
    '400 {"base_resp":{"status_code":2013,"status_msg":"invalid params"}}']) {
    const f = fixture([{ error }, {}]), p = policy();
    await collect(send(dispatcher(f, p)));
    assert.deepEqual(f.calls.map(c => c.options.maxTokens), [262144, 8192]);
    assert.deepEqual(p.writes, [{ maxOutputTokens: 8192 }]);
  }
  console.log("PASS auto output: explicit DeepSeek/Qwen/OpenAI/Anthropic/MiniMax limits and unnumbered 400/422 fallback");

  for (const attempt of [
    { error: "401 invalid request", status: 401 }, { error: "403 forbidden", status: 403 },
    { error: "429 too many requests", status: 429 }, { error: "500 invalid_request_error", status: 500 },
    { error: "502 invalid_request_error", status: 502 }, { error: "provider_network_error" },
    { error: "400 insufficient_quota" }, { error: "400 balance is insufficient, available balance 0" },
    { error: "400 content_filter" }, { error: "400 request timeout" }, { error: "400 request cancelled" },
    { error: "400 Unsupported parameter: max_tokens" }, { error: "400 max_tokens parameter is not supported" },
    { error: "400 budget_tokens must be less than max_tokens" }, { error: "400 thinking budget conflicts with max_tokens" },
    { error: "400 prompt is too long: 300000 tokens > 200000 maximum" },
    { error: "400 maximum input length is 32768 tokens; got 40000" },
    { error: "400 input tokens 40000 exceeds input limit 32768" },
    { error: "400 input length exceeds limit" },
    { error: "400 Range of input length should be [1, 8192]" },
    { error: "400 This model's maximum context length is 64000 tokens. However, you requested 300000 tokens (65000 in the messages, 235000 in the completion)." },
    { error: "400 context_length_exceeded" }, { error: "400 document input is not supported" }
  ] satisfies Attempt[]) {
    const f = fixture([attempt]), p = policy();
    await collect(send(dispatcher(f, p)));
    assert.equal(f.calls.length, 1, attempt.error);
    assert.equal(p.writes.length, 0);
  }
  for (const partial of [
    { start: true }, { content: [{ type: "thinking", thinking: "reason" }] },
    { content: [{ type: "text", text: "partial" }] },
    { content: [{ type: "toolCall", id: "call", name: "fixture_read", arguments: {} }] }
  ] satisfies Attempt[]) {
    const f = fixture([{ error: "400 invalid_request_error", ...partial }]), p = policy();
    await collect(send(dispatcher(f, p)));
    assert.equal(f.calls.length, 1);
    assert.equal(p.writes.length, 0);
  }
  console.log("PASS auto output: auth/quota/rate/network/deadline/filter/unsupported/thinking/input overflow exclusions; start/text/thinking/tool output closes retry");

  for (const explicit of [32, 4096, 10000]) {
    const f = fixture([{ error: "400 invalid_request_error" }]), p = policy();
    await collect(send(dispatcher(f, p), { maxTokens: explicit }));
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0]!.options.maxTokens, explicit);
    assert.equal(f.calls[0]!.model.contextWindow, 64000);
  }
  for (const p of [policy(null), policy({ maxOutputTokens: 100000 })]) {
    const f = fixture([{}]);
    await collect(send(dispatcher(f, p)));
    assert.equal(f.calls[0]!.options.maxTokens, p.value.read(model()) === null ? undefined : 100000);
    assert.equal(p.writes.length, 0, "a normal first-attempt success must never teach a cap");
  }
  const windowPolicy = policy({ contextWindow: 128000 }), wf = fixture([{}]);
  await collect(send(dispatcher(wf, windowPolicy)));
  assert.equal(wf.calls[0]!.options.maxTokens, 128000 - estimatePiContextTokens(context).tokens - 4096);
  for (const limits of [{ maxOutputTokens: 8192 }, { contextWindow: 10000 }]) {
    const f = fixture([{ error: "400 invalid_request_error" }]);
    await collect(send(dispatcher(f, policy(limits))));
    assert.equal(f.calls.length, 1, "a request already at/below the session cap is never downgraded");
  }
  for (const error of ["400 max_tokens must be in the range [1, 262144]", "400 max_tokens must be in the range [1, 524288]"]) {
    const f = fixture([{ error }]);
    await collect(send(dispatcher(f, policy())));
    assert.equal(f.calls.length, 1, "never resend an unchanged or larger wire limit");
  }
  for (const error of [
    "400 This model's maximum context length is 128000 tokens. However, you requested 282144 tokens (20000 in the messages, 262144 in the completion).",
    "400 input length and max_tokens exceed context limit: 20000 + 262144 > 128000"
  ]) {
    const f = fixture([{ error }, {}]), p = policy();
    await collect(send(dispatcher(f, p)));
    assert.deepEqual(f.calls.map(c => c.options.maxTokens), [262144, 103904]);
    assert.deepEqual(p.writes, [{ contextWindow: 128000 }], "remaining space is not an output capability");
  }
  for (const [error, expected, window] of [
    ["400 This endpoint's maximum context length is 131072 tokens. However, you requested about 254425 tokens (112955 of text input, 10398 of tool input, 131072 in the output).", 3623, 131072],
    ["400 This model's maximum context length is 131072 tokens; prompt contains at least 62466 input tokens", 64510, 131072],
    ["400 This model's maximum context length is 131072 tokens; request has 22554 input tokens", 104422, 131072]
  ] as const) {
    const f = fixture([{ error }, {}]), p = policy();
    await collect(send(dispatcher(f, p)));
    assert.deepEqual(f.calls.map(c => c.options.maxTokens), [262144, expected], error);
    assert.deepEqual(p.writes, [{ contextWindow: window }]);
  }

  const failure = fixture([{ error: "400 invalid_request_error" }, { error: "400 context_length_exceeded" }]), fp = policy();
  const d = dispatcher(failure, fp);
  const transport = new PiProviderProtocolTransport({ authorityId: "fixture", storeSetId: "fixture", resolveAuthToken: () => key, dispatcher: d });
  const result = await (await transport.stream({ runId: "r", turnId: "t", conversationId: "c", correlationId: "x", model: model(), context,
    provider: { providerId: "openai", apiProtocol: "openai-completions", authMode: "api-key", baseUrl: model().baseUrl, modelRef: model().id },
    options: { temperature: 0, cacheRetention: "none", maxRetries: 0, timeoutMs: 5000 } })).result();
  assert.equal(result.errorMessage, "provider_output_limit_rejected");
  assert.equal(safeProviderFailureCode(result.errorMessage), result.errorMessage);
  assert.equal(providerFailureText(result.errorMessage), "服务商拒绝了输出上限，请到模型设置手动填写。");
  assert.equal(isRetryableAssistantError(result), false);
  assert.equal(isContextOverflow(result, 64000), false);
  assert.equal(fp.writes.length, 0);
  assert.equal(failure.calls.length, 2);

  const controller = new AbortController();
  const cancel = fixture([{ error: "400 invalid_request_error", onAttempt: () => controller.abort() }]), cp = policy();
  const cancelled = await collect(send(dispatcher(cancel, cp), { signal: controller.signal }));
  assert.equal(cancelled.result.stopReason, "aborted"); assert.equal(cancel.calls.length, 1);
  const timed = fixture([{ error: "400 invalid_request_error", onAttempt: () => new Promise(r => setTimeout(r, 20)) }, {}]);
  await collect(send(dispatcher(timed, policy()), { timeoutMs: 5 }));
  assert.equal(timed.calls.length, 1, "no retry after the total deadline");
  const signals = new AbortController();
  const elapsed = fixture([{ error: "400 invalid_request_error", onAttempt: () => new Promise(r => setTimeout(r, 15)) }, {}]);
  await collect(send(dispatcher(elapsed, policy()), { timeoutMs: 500, signal: signals.signal }));
  assert.equal(elapsed.calls[0]!.options.signal, elapsed.calls[1]!.options.signal);
  assert.ok(elapsed.calls[1]!.options.timeoutMs! < elapsed.calls[0]!.options.timeoutMs!);
  const shared = fixture([{ error: "400 document input is not supported" }, { error: "400 invalid_request_error" }, {}, { error: "400 invalid_request_error" }]);
  const sd = dispatcher(shared, policy()), state = { retried: false };
  await collect(send(sd, {}, state)); await collect(send(sd, {}, state)); await collect(send(sd, {}, state));
  assert.equal(shared.calls.length, 4, "document fallback shares one automatic downgrade allowance");
  const docs = fixture([{ error: "400 document input is not supported" }, { error: "400 invalid_request_error" }, {}]);
  const dm = { ...model("anthropic-messages"), id: "claude-sonnet-5", baseUrl: "https://api.anthropic.com" };
  const bytes = new TextEncoder().encode("fixture PDF");
  const docTransport = new PiProviderProtocolTransport({ authorityId: "fixture", storeSetId: "fixture", resolveAuthToken: () => key,
    dispatcher: new PiProviderProtocolDispatcher({ "anthropic-messages": docs.adapter }, policy().value),
    documentInput: {
      currentDocuments: () => [{ attachment: { type: "file", name: "fixture.pdf", path: "fixture.pdf", mimeType: "application/pdf", sizeBytes: bytes.length, availability: "available" },
        kind: "pdf", transport: "native", bytes, sha256: createHash("sha256").update(bytes).digest("hex"), text: "FROZEN_DOCUMENT_TEXT" }],
      capabilityTarget: { providerId: "anthropic", apiProtocol: "anthropic-messages", baseUrl: dm.baseUrl, modelId: dm.id, adapter: PI_ANTHROPIC_PDF_DOCUMENT_ADAPTER }
    }
  });
  const docResult = await (await docTransport.stream({ runId: "rd", turnId: "td", conversationId: "cd", correlationId: "xd", model: dm, context,
    provider: { providerId: "anthropic", apiProtocol: "anthropic-messages", authMode: "api-key", baseUrl: dm.baseUrl, modelRef: dm.id },
    options: { temperature: 0, cacheRetention: "none", maxRetries: 0, timeoutMs: 5000 } })).result();
  assert.equal(docResult.stopReason, "stop", docResult.errorMessage);
  assert.deepEqual(docs.calls.map(c => c.options.maxTokens), [262144, 262144, 8192]);
  assert.match(JSON.stringify(docs.calls[0]!.payload), /"type":"document"/u);
  for (const call of docs.calls.slice(1)) {
    assert.match(JSON.stringify(call.payload), /FROZEN_DOCUMENT_TEXT/u);
    assert.doesNotMatch(JSON.stringify(call.payload), /"type":"document"/u);
  }
  console.log("PASS auto output: reliable/explicit bypass, cached total window, retry-only learning, terminal rejection code, shared cancellation/deadline/document budget");

  const qwenBodies: Record<string, any>[] = [], qp = policy();
  const qwen = createQwenTokenPlanOpenAICompletionsAdapter(async request => {
    qwenBodies.push(JSON.parse(request.body));
    if (qwenBodies.length === 1) return { status: 400, headers: {}, body: JSON.stringify({ error: { code: "invalid_request_error",
      message: `Range of max_tokens should be [1, 16384]; ${key}` } }) };
    return { status: 200, headers: { "content-type": "text/event-stream" }, body: await sdkSuccess("openai-completions").text() };
  });
  const qm = { ...model(), provider: "qwen-token-plan-cn", baseUrl: QWEN_TOKEN_PLAN_API_BASE_URL };
  const qr = await collect(new PiProviderProtocolDispatcher({ "openai-completions": qwen }, qp.value).streamSimple({ model: qm, context, apiKey: key, options: {} }));
  assert.equal(qr.result.stopReason, "stop", qr.result.errorMessage);
  assert.deepEqual(qwenBodies.map(body => body.max_tokens), [262144, 16384]);
  assert.deepEqual(qp.writes, [{ maxOutputTokens: 16384 }]);
  const rejectedQwen = await createQwenTokenPlanOpenAICompletionsAdapter(async () => ({ status: 400, headers: {},
    body: JSON.stringify({ error: { message: `invalid request ${key}` } }) })).streamSimple(qm, context, { apiKey: key }).result() as AssistantProviderFailure;
  assert.equal(rejectedQwen.echoInkProviderFailure?.status, 400);
  assert.doesNotMatch(JSON.stringify(rejectedQwen), new RegExp(key));
  console.log("PASS auto output: Qwen actual request body, bounded redacted error evidence, one successful downgrade");
}
