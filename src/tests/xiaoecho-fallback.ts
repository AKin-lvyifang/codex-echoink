import * as assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type ProviderResponse,
  type ProviderStreams,
  type StreamOptions
} from "@earendil-works/pi-ai";
import {
  PiProviderProtocolDispatcher,
  PiProviderProtocolTransport
} from "../harness/pi/pi-provider-protocol-adapter";
import {
  subscribeXiaoechoModelSignals,
  type XiaoechoModelSignal
} from "../membership/xiaoecho-model-signal";
import {
  PiProviderConfigurationService,
  type PiProviderConfigurationDraft
} from "../plugin/pi-provider-configuration-service";
import { PiChatUiProjector } from "../harness/pi-native/pi-chat-ui-projector";
import { shortSocialOutputLimit } from "../harness/short-social-turn";

const context: Context = { messages: [{ role: "user", content: "fixture", timestamp: 1 }] };
const headers = {
  "X-Xiaoecho-Fallback": "auto",
  "x-XIAOECHO-requested-model": "retired-model"
};

function model(provider = "xiaoecho"): Model<Api> {
  return {
    id: "retired-model", name: "Retired model", provider,
    api: "openai-completions", baseUrl: "https://xiaoecho.invalid/v1",
    reasoning: false, input: ["text"], contextWindow: 64_000, maxTokens: 8_192,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  };
}

function message(requestModel: Model<Api>, errorMessage?: string): AssistantMessage {
  return {
    role: "assistant", api: requestModel.api, provider: requestModel.provider,
    model: requestModel.id, content: errorMessage ? [] : [{ type: "text", text: "answer" }],
    stopReason: errorMessage ? "error" : "stop", ...(errorMessage ? { errorMessage } : {}),
    timestamp: 2,
    usage: {
      input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
    }
  };
}

function adapter(input: {
  response?: ProviderResponse;
  failure?: string;
  tools?: boolean;
  repeatResponse?: boolean;
} = {}) {
  const calls: Array<{ model: Model<Api>; options: StreamOptions }> = [];
  const sourceMessages: AssistantMessage[] = [];
  const run: ProviderStreams["stream"] = (requestModel, _context, options = {}) => {
    calls.push({ model: requestModel, options });
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      void (async () => {
        const response = input.response ?? { status: 200, headers };
        await options.onResponse?.(response, requestModel);
        if (input.repeatResponse) await options.onResponse?.(response, requestModel);
        const output = message(requestModel, input.failure);
        sourceMessages.push(output);
        if (input.failure) {
          stream.push({ type: "error", reason: "error", error: output });
          return;
        }
        stream.push({ type: "start", partial: output });
        stream.push({ type: "text_start", contentIndex: 0, partial: output });
        stream.push({ type: "text_delta", contentIndex: 0, delta: "answer", partial: output });
        stream.push({ type: "text_end", contentIndex: 0, content: "answer", partial: output });
        if (input.tools) {
          const toolCall = { type: "toolCall" as const, id: "call-1", name: "fixture_read", arguments: { path: "fixture.md" } };
          output.content.push(toolCall);
          output.stopReason = "toolUse";
          stream.push({ type: "toolcall_start", contentIndex: 1, partial: output });
          stream.push({ type: "toolcall_delta", contentIndex: 1, delta: '{"path":"fixture.md"}', partial: output });
          stream.push({ type: "toolcall_end", contentIndex: 1, toolCall, partial: output });
        }
        stream.push({ type: "done", reason: input.tools ? "toolUse" : "stop", message: output });
      })().catch((error) => {
        stream.push({ type: "error", reason: "error", error: message(requestModel, String(error)) });
      });
    });
    return stream;
  };
  return { streams: { stream: run, streamSimple: run } satisfies ProviderStreams, calls, sourceMessages };
}

function dispatch(
  dispatcher: PiProviderProtocolDispatcher,
  method: "stream" | "streamSimple",
  requestModel = model(),
  options: StreamOptions = {}
): AssistantMessageEventStream {
  return dispatcher[method]({ model: requestModel, context, apiKey: "fixture-token", options });
}

async function collect(stream: AssistantMessageEventStream) {
  const events: AssistantMessageEvent[] = [];
  for await (const event of stream) events.push(event);
  return { events, result: await stream.result() };
}

async function withSignals(run: (signals: XiaoechoModelSignal[]) => Promise<void>): Promise<void> {
  const signals: XiaoechoModelSignal[] = [];
  const unsubscribe = subscribeXiaoechoModelSignals((signal) => { signals.push(signal); });
  try { await run(signals); } finally { unsubscribe(); }
}

async function assertFallbackAttribution(): Promise<void> {
  for (const method of ["stream", "streamSimple"] as const) {
    await withSignals(async (signals) => {
      const fixture = adapter({ tools: true, repeatResponse: true });
      const dispatcher = new PiProviderProtocolDispatcher({ "openai-completions": fixture.streams });
      const requestModel = Object.freeze(model());
      const controller = new AbortController();
      const responses: ProviderResponse[] = [];
      const { events, result } = await collect(dispatch(dispatcher, method, requestModel, {
        signal: controller.signal, maxRetries: 0, maxTokens: 64,
        onResponse: (response, responseModel) => {
          responses.push(response);
          assert.equal(responseModel, requestModel);
        }
      }));
      assert.equal(fixture.calls.length, 1, `${method}: fallback never reissues the request`);
      assert.equal(fixture.calls[0]!.model, requestModel);
      assert.equal(fixture.calls[0]!.options.signal, controller.signal);
      assert.equal(fixture.calls[0]!.options.maxRetries, 0);
      assert.equal(requestModel.id, "retired-model");
      assert.equal(fixture.sourceMessages[0]!.model, "retired-model", "adapter messages are not mutated");
      assert.equal(responses.length, 2, "the caller's response callback remains composed");
      for (const event of events) {
        const output = "partial" in event ? event.partial : event.type === "done" ? event.message : event.error;
        assert.equal(output.model, "auto", `${method}: ${event.type} has the effective model`);
      }
      assert.equal(result.model, "auto");
      assert.equal(result.stopReason, "toolUse");
      assert.deepEqual(result.content, fixture.sourceMessages[0]!.content);
      assert.deepEqual(events.map((event) => event.type), [
        "start", "text_start", "text_delta", "text_end", "toolcall_start", "toolcall_delta", "toolcall_end", "done"
      ]);
      const toolEnd = events.find((event) => event.type === "toolcall_end");
      assert.equal(toolEnd?.type === "toolcall_end" && toolEnd.toolCall.id, "call-1");
      assert.deepEqual(signals.map(({ kind, requestedModelId, baseUrl }) => ({ kind, requestedModelId, baseUrl })),
        [{ kind: "fallback", requestedModelId: requestModel.id, baseUrl: requestModel.baseUrl }]);
      assert.ok(signals[0]!.requestId);
    });
  }
}

async function assertUnrelatedResponsesUnchanged(): Promise<void> {
  const responses = [
    { status: 200, headers: { "X-Xiaoecho-Fallback": "auto" } },
    { status: 200, headers: { ...headers, "x-XIAOECHO-requested-model": "another-model" } },
    { status: 200, headers: { ...headers, "X-Xiaoecho-Fallback": "other" } },
    { status: 400, headers },
    { status: 200, headers: {} }
  ];
  for (const method of ["stream", "streamSimple"] as const) {
    for (const response of responses) {
      await withSignals(async (signals) => {
        const fixture = adapter({ response });
        const dispatcher = new PiProviderProtocolDispatcher({ "openai-completions": fixture.streams });
        const { events, result } = await collect(dispatch(dispatcher, method));
        assert.equal(result.model, "retired-model");
        assert.equal(result, fixture.sourceMessages[0]);
        assert.equal(signals.length, 0);
        assert.ok(events.every((event) => !("partial" in event) || event.partial.model === "retired-model"));
      });
    }
    await withSignals(async (signals) => {
      const fixture = adapter();
      const dispatcher = new PiProviderProtocolDispatcher({ "openai-completions": fixture.streams });
      const { result } = await collect(dispatch(dispatcher, method, model("custom")));
      assert.equal(result, fixture.sourceMessages[0]);
      assert.equal(result.model, "retired-model");
      assert.equal(signals.length, 0, "matching headers from other providers are ignored");
    });
  }
}

async function assertRetiredErrorsAndThrows(): Promise<void> {
  for (const failure of ["MODEL_UNKNOWN", '404 {"error":"MODEL_UNAVAILABLE"}']) {
    for (const method of ["stream", "streamSimple"] as const) {
      await withSignals(async (signals) => {
        const fixture = adapter({ failure, response: { status: 404, headers: {} } });
        const dispatcher = new PiProviderProtocolDispatcher({ "openai-completions": fixture.streams });
        const { result } = await collect(dispatch(dispatcher, method));
        assert.equal(result.errorMessage, failure);
        assert.equal(result.model, "retired-model");
        assert.equal(fixture.calls.length, 1);
        assert.equal(signals.length, 1, "iterator and result report the same failed request once");
        assert.equal(signals[0]!.kind, "retired");
      });
    }
  }
  for (const failure of ["SERVER_BUSY", "XIAOECHO_BUSY", "POINTS_INSUFFICIENT", "provider_model_unavailable"]) {
    await withSignals(async (signals) => {
      const fixture = adapter({ failure, response: { status: 503, headers: {} } });
      const dispatcher = new PiProviderProtocolDispatcher({ "openai-completions": fixture.streams });
      assert.equal((await dispatch(dispatcher, "stream").result()).errorMessage, failure);
      assert.equal(fixture.calls.length, 1);
      assert.equal(signals.length, 0, "other failure and retry categories remain untouched");
    });
  }
  await withSignals(async (signals) => {
    const fixture = adapter({ failure: "MODEL_UNKNOWN", response: { status: 404, headers: {} } });
    const dispatcher = new PiProviderProtocolDispatcher({ "openai-completions": fixture.streams });
    await dispatch(dispatcher, "stream", model("custom")).result();
    assert.equal(signals.length, 0, "legacy errors from other providers are ignored");
  });
  for (const method of ["stream", "streamSimple"] as const) {
    await withSignals(async (signals) => {
      const failure = new Error("MODEL_UNKNOWN");
      let calls = 0;
      const run = () => { calls += 1; throw failure; };
      const dispatcher = new PiProviderProtocolDispatcher({ "openai-completions": { stream: run, streamSimple: run } });
      assert.throws(() => dispatch(dispatcher, method), (error) => error === failure);
      assert.equal(calls, 1);
      assert.equal(signals.length, 1);
      assert.equal(signals[0]!.kind, "retired");
    });
    await withSignals(async (signals) => {
      const failure = new Error("MODEL_UNAVAILABLE");
      let calls = 0;
      const run = () => {
        calls += 1;
        const stream = createAssistantMessageEventStream();
        stream[Symbol.asyncIterator] = async function* (): AsyncGenerator<AssistantMessageEvent> { throw failure; };
        stream.result = async () => { throw failure; };
        return stream;
      };
      const dispatcher = new PiProviderProtocolDispatcher({ "openai-completions": { stream: run, streamSimple: run } });
      const stream = dispatch(dispatcher, method);
      await assert.rejects(async () => { for await (const _event of stream) { /* no events */ } }, (error) => error === failure);
      await assert.rejects(stream.result(), (error) => error === failure);
      assert.equal(calls, 1);
      assert.equal(signals.length, 1);
    });
  }
}

async function assertObserverFailureDoesNotBreakAnswer(): Promise<void> {
  const sync = subscribeXiaoechoModelSignals(() => { throw new Error("catalog refresh failed"); });
  const async = subscribeXiaoechoModelSignals(async () => { throw new Error("settings save failed"); });
  let observed = 0;
  const healthy = subscribeXiaoechoModelSignals(() => { observed += 1; });
  try {
    const fixture = adapter();
    const dispatcher = new PiProviderProtocolDispatcher({ "openai-completions": fixture.streams });
    assert.equal((await dispatch(dispatcher, "stream").result()).model, "auto");
    assert.equal(observed, 1, "a failed listener does not prevent other observers");
  } finally { sync(); async(); healthy(); }
  const fixture = adapter();
  const dispatcher = new PiProviderProtocolDispatcher({ "openai-completions": fixture.streams });
  await dispatch(dispatcher, "stream").result();
  assert.equal(observed, 1, "unsubscribe detaches the listener");
}

async function assertConcurrentRequestIsolation(): Promise<void> {
  await withSignals(async (signals) => {
    const fixture = adapter();
    const dispatcher = new PiProviderProtocolDispatcher({ "openai-completions": fixture.streams });
    const [fallback, unaffected] = await Promise.all([
      dispatch(dispatcher, "stream").result(),
      dispatch(dispatcher, "streamSimple", { ...model(), id: "other-model" }).result()
    ]);
    assert.equal(fallback.model, "auto");
    assert.equal(unaffected.model, "other-model");
    assert.equal(signals.length, 1);
    await dispatch(dispatcher, "stream").result();
    assert.equal(signals.length, 2);
    assert.notEqual(signals[0]!.requestId, signals[1]!.requestId);
  });
}

async function assertColdSessionAttribution(result: AssistantMessage): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), "echoink-xiaoecho-session-"));
  try {
    const manager = SessionManager.create(directory, directory);
    manager.appendMessage({ role: "user", content: "fixture", timestamp: 1 });
    const assistantEntryId = manager.appendMessage(result);
    const sessionFile = manager.getSessionFile();
    assert.ok(sessionFile);
    assert.match(await readFile(sessionFile, "utf8"), /"model"\s*:\s*"auto"/u, "the fallback model is actually written to the session file");

    const reopened = SessionManager.open(sessionFile, directory, directory);
    const restored = reopened.getEntry(assistantEntryId);
    assert.ok(restored?.type === "message" && restored.message.role === "assistant");
    assert.equal(restored.message.model, "auto", "a fresh SessionManager restores the raw assistant model from disk");
    assert.deepEqual(restored.message, result);
    const projected = new PiChatUiProjector().projectSessionBranch({
      piSessionId: reopened.getSessionId(), activeLeafId: reopened.getLeafId(),
      entries: reopened.getBranch()
    });
    const assistant = projected.messages.filter((value) => value.role === "assistant");
    assert.equal(assistant.length, 1);
    assert.equal(assistant[0]!.modelId, "auto", "the cold-open UI projector preserves the auto signature");
    assert.equal(assistant[0]!.providerId, "xiaoecho");
    assert.equal(assistant[0]!.text, "answer");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function assertNormalGenerationAndTransport(): Promise<void> {
  await withSignals(async (signals) => {
    const fixture = adapter();
    const dispatcher = new PiProviderProtocolDispatcher({ "openai-completions": fixture.streams });
    const service = new PiProviderConfigurationService({} as never, {
      textGenerationDispatcher: dispatcher, resolveAccountToken: async () => "fixture-token"
    });
    const draft: PiProviderConfigurationDraft = {
      providerSettingsId: "fixture", providerId: "xiaoecho", runtimeProviderId: "xiaoecho",
      apiProtocol: "openai-completions", authMode: "account", baseUrl: model().baseUrl,
      modelId: "retired-model", apiKey: "", toolCalling: true, imageInput: false,
      reasoning: false, contextWindow: 64_000, modelMaxTokens: 8_192, maxOutputTokens: 8_192
    };
    assert.equal(await service.generateText({ draft, systemPrompt: "fixture", userPrompt: "fixture", timeoutMs: 1_000 }), "answer");
    assert.equal(signals.length, 1, "ordinary generateText uses the same request observer");
    const transport = new PiProviderProtocolTransport({ authorityId: "fixture", storeSetId: "fixture", resolveAuthToken: () => "fixture-token", dispatcher });
    const output = await transport.stream({
      runId: "r", turnId: "t", conversationId: "c", correlationId: "x", purpose: "conversation", shortReply: true, model: model(), context,
      provider: { providerId: "xiaoecho", baseUrl: model().baseUrl, apiProtocol: "openai-completions", modelRef: "retired-model", authMode: "account" },
      options: { maxRetries: 0, maxTokens: shortSocialOutputLimit(undefined, context.messages), cacheRetention: "none", temperature: 0 }
    });
    const { result } = await collect(output);
    assert.equal(result.model, "auto", "the normal conversation transport preserves the message attribution for persistence");
    await assertColdSessionAttribution(result);
    assert.equal(signals.length, 2);
    assert.equal(fixture.calls.length, 2);
    const wire = fixture.calls[1]!.options;
    assert.equal(wire.maxTokens, 64);
    assert.deepEqual(await wire.onPayload?.({ max_tokens: wire.maxTokens }, model()), {
      max_tokens: 64, echoink_turn: { conversationId: "c", turnId: "t", purpose: "conversation", shortReply: true }
    });
  });
}

export async function runXiaoechoFallbackTests(): Promise<void> {
  await assertFallbackAttribution();
  await assertUnrelatedResponsesUnchanged();
  await assertRetiredErrorsAndThrows();
  await assertObserverFailureDoesNotBreakAnswer();
  await assertConcurrentRequestIsolation();
  await assertNormalGenerationAndTransport();
  console.log("PASS xiaoecho fallback: dispatcher headers, partial/final/result attribution, tools, legacy errors, request isolation, observer failures, generateText, conversation transport and real SessionManager cold-open UI attribution");
}
