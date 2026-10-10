import * as assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { createAssistantMessageEventStream, type AssistantMessage, type Context } from "@earendil-works/pi-ai";
import { countTextTokens, estimateTokenValue, estimateUsageInputTokens, estimateUsageOutputTokens, USAGE_TOKEN_STANDARD } from "../harness/usage/token-estimator";
import { observeUsageStream, type UsageRequestEvent } from "../harness/usage/usage-stream";
import { UsageStore } from "../harness/usage/usage-store";
import { buildPiContextLedger, calculatePiEffectiveInputBudget, parsePiContextLedger } from "../harness/pi-native/pi-context-budget";

const now = new Date(2026, 9, 10, 12).getTime();
function assistant(text: string): AssistantMessage {
  return { role: "assistant", content: text ? [{ type: "text", text }] : [], api: "openai-completions",
    provider: "fixture", model: "fixture", timestamp: now, stopReason: "stop",
    usage: { input: 1_000_000, output: 500_000, cacheRead: 500_000, cacheWrite: 0, totalTokens: 2_000_000,
      cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 0, total: 6 } } };
}
const context: Context = { systemPrompt: "你是 EchoInk，按用户要求整理知识。", messages: [{ role: "user", content: "请检查目录。", timestamp: now }],
  tools: [{ name: "read_file", description: "读取笔记正文", parameters: { type: "object", properties: { path: { type: "string" } } } }] };
function request(id: string, time = now): UsageRequestEvent {
  return { requestId: id, recordedAt: time, provider: "fixture", model: "fixture", source: "conversation",
    inputTokens: 100, outputTokens: 10, status: "completed", standard: USAGE_TOKEN_STANDARD };
}

function testEstimator() {
  const start = performance.now();
  assert.equal(countTextTokens("hello world"), 2);
  const coldMs = performance.now() - start;
  // Published o200k_base reference example, including Japanese characters.
  assert.equal(countTextTokens("お誕生日おめでとう"), 8);
  assert.equal(countTextTokens("2 + 2 = 4"), 7);
  assert.doesNotThrow(() => countTextTokens("<|endoftext|> literal user input"));
  const reply = assistant("已完成。");
  const plain = { role: reply.role, content: reply.content };
  assert.equal(estimateTokenValue(reply), estimateTokenValue(plain), "Provider accounting and runtime fields are not inference content");
  const signature = { ...reply, content: [{ type: "thinking", thinking: "检查完成。", thinkingSignature: "s".repeat(100_000) }, ...reply.content] };
  const noSignature = { ...signature, content: [{ type: "thinking", thinking: "检查完成。" }, ...reply.content] };
  assert.equal(estimateTokenValue(signature), estimateTokenValue(noSignature), "opaque signatures are excluded");
  assert.equal(estimateTokenValue([[signature]]), estimateTokenValue([[noSignature]]), "nested message arrays also exclude signatures");
  assert.equal(estimateTokenValue([reply]), estimateTokenValue([plain]), "message arrays exclude Provider metadata");
  const image = (bytes: string) => ({ role: "user", content: [{ type: "image", data: bytes, mimeType: "image/png" }], timestamp: now });
  assert.equal(estimateTokenValue(image("x")), estimateTokenValue(image("x".repeat(100_000))), "base64 is not text tokens");
  assert.ok(estimateTokenValue(image("x")) >= 1_200);
  assert.equal(estimateTokenValue({ usage: "real user field" }), countTextTokens('{"usage":"real user field"}'), "tool JSON fields are preserved");
  assert.ok(estimateUsageInputTokens(context) > estimateUsageInputTokens({ ...context, tools: [] }), "tool schemas are counted");
  assert.equal(estimateTokenValue(context), estimateUsageInputTokens(context), "budget admission and cumulative usage share one input count");
  const toolCall: AssistantMessage = { ...reply, content: [{ type: "toolCall", id: "call-1", name: "read_file", arguments: { path: "wiki/内容.md" } }] };
  const toolContext: Context = { ...context, messages: [...context.messages, toolCall, { role: "toolResult", toolCallId: "call-1", toolName: "read_file", content: [{ type: "text", text: "这是实际工具返回的正文。" }], isError: false, timestamp: now }] };
  assert.ok(estimateUsageInputTokens(toolContext) > estimateUsageInputTokens(context));
  assert.ok(estimateUsageOutputTokens(toolCall) > 0);
  assert.equal(estimateUsageOutputTokens(reply), countTextTokens("已完成。"));
  const texts = ["Hello world", "请按照当前知识库目录整理这些资料，并保留有效引用。", "const value = items.map(x => ({ id: x.id, done: true }));", "お誕生日おめでとう", "안녕하세요, 오늘 기록을 정리해 주세요.", "🧑🏽‍💻".repeat(20)];
  const sample = texts.join("\n").repeat(80);
  const warmStart = performance.now();
  const tokens = countTextTokens(sample);
  const warmMs = performance.now() - warmStart;
  const repeatedStart = performance.now();
  assert.equal(countTextTokens(sample), tokens);
  const cachedMs = performance.now() - repeatedStart;
  console.log(JSON.stringify({ estimator: USAGE_TOKEN_STANDARD, coldMs: Math.round(coldMs),
    warm: { characters: sample.length, tokens, ms: Math.round(warmMs), cachedMs: Math.round(cachedMs * 100) / 100 },
    samples: texts.map(text => ({ characters: text.length, tokens: countTextTokens(text) })) }));
  return toolContext;
}

function testNativeAttachmentLedger() {
  const input = { conversationId: "fixture-conversation", piSessionId: "fixture-session", productRunId: "fixture-run",
    requestSequence: 1, requestLeafId: null, recordedAt: now, model: { provider: "fixture", id: "fixture" },
    budget: calculatePiEffectiveInputBudget({ contextWindow: 64_000, maxOutputReserve: 4_000 }),
    context, contextEntries: [], vaultToolNames: new Set(["read_file"]), mcpToolNames: new Set<string>() };
  const plain = buildPiContextLedger(input);
  const native = buildPiContextLedger({ ...input, additionalInputTokens: 2_400 });
  assert.equal(native.totalInputTokens, plain.totalInputTokens + 2_400);
  assert.equal(native.totalInputTokens, estimateUsageInputTokens(context) + 2_400, "sidebar and cumulative request use identical native attachment estimates");
  assert.equal(native.categories.find(category => category.category === "temporary_materials")?.tokens, 2_400);
  assert.equal(native.categories.reduce((sum, category) => sum + category.tokens, 0), native.totalInputTokens);
  assert.equal(native.remainingInputTokens, plain.remainingInputTokens - 2_400);
  assert.deepEqual(parsePiContextLedger(native), native, "persisted native attachment estimate remains a valid ledger");
}

async function testStreams(toolContext: Context) {
  const captured: UsageRequestEvent[] = [];
  const wrap = (id: string, ctx = context) => {
    const upstream = createAssistantMessageEventStream();
    return { upstream, stream: observeUsageStream(upstream, { context: ctx, provider: "fixture", model: "fixture",
      source: "conversation", recordUsage: event => { captured.push(event); }, requestId: id, now: () => now }) };
  };
  const first = wrap("request-1");
  const final = assistant("hello world");
  first.upstream.push({ type: "start", partial: assistant("") });
  first.upstream.push({ type: "text_delta", contentIndex: 0, delta: "hello", partial: assistant("hello") });
  first.upstream.push({ type: "text_delta", contentIndex: 0, delta: " world", partial: final });
  first.upstream.push({ type: "done", reason: "stop", message: final });
  assert.equal(await first.stream.result(), final, "forward original Provider result unchanged");
  assert.equal(captured.length, 1);
  assert.equal(captured[0].outputTokens, 2, "partial snapshots do not double count");
  assert.equal(captured[0].inputTokens, estimateUsageInputTokens(context));
  const second = wrap("request-2", toolContext);
  second.upstream.push({ type: "done", reason: "stop", message: assistant("已完成。") });
  await second.stream.result();
  assert.equal(captured.length, 2, "tool continuation is a new request with repeated context counted again");
  assert.ok(captured[1].inputTokens > captured[0].inputTokens);
  const rejected = wrap("rejected");
  rejected.upstream.push({ type: "error", reason: "error", error: { ...assistant(""), stopReason: "error", errorMessage: "auth_failed" } });
  await rejected.stream.result();
  assert.equal(captured.length, 2, "empty rejection is not fabricated inference");
  const aborted = wrap("partial-aborted");
  aborted.upstream.push({ type: "text_delta", contentIndex: 0, delta: "hello", partial: assistant("hello") });
  aborted.upstream.push({ type: "error", reason: "aborted", error: { ...assistant(""), stopReason: "aborted" } });
  await aborted.stream.result();
  assert.equal(captured.length, 3);
  assert.equal(captured[2].status, "cancelled");
  assert.equal(captured[2].outputTokens, countTextTokens("hello"));
  const unfinished = wrap("unfinished");
  unfinished.upstream.push({ type: "text_delta", contentIndex: 0, delta: "hello", partial: assistant("hello") });
  unfinished.upstream.end();
  assert.equal((await unfinished.stream.result()).stopReason, "error", "unterminated stream still settles");
  assert.equal(captured.length, 4);
  const emptyCompleted = wrap("empty-completed");
  emptyCompleted.upstream.push({ type: "done", reason: "stop", message: assistant("") });
  await emptyCompleted.stream.result();
  assert.equal(captured.length, 5, "completed inference consumed input even if output is empty");
  assert.equal(captured[4].inputTokens, estimateUsageInputTokens(context));
  assert.equal(captured[4].outputTokens, 0);
  const errorStream = createAssistantMessageEventStream();
  const observed = observeUsageStream(errorStream, { context, provider: "fixture", model: "fixture", source: "background",
    recordUsage: async () => { throw new Error("disk unavailable"); }, onRecordError: () => { throw new Error("view failed"); } });
  errorStream.push({ type: "done", reason: "stop", message: final });
  assert.equal(await observed.result(), final, "statistics failure does not fail successful inference");
}

async function testStore() {
  const root = await mkdtemp(join(tmpdir(), "echoink-usage-test-"));
  const file = join(root, "usage.json");
  try {
    const store = new UsageStore(file, () => now);
    await store.initialize();
    assert.equal(store.readStatistics().totalTokens, 0);
    let notifications = 0;
    const unsubscribe = store.subscribe(() => { notifications += 1; });
    const yesterday = new Date(2026, 9, 9, 12).getTime();
    await Promise.all([store.recordUsage(request("one", yesterday)), store.recordUsage(request("one", yesterday)),
      store.recordUsage(request("two")), store.recordCompletedTurn("turn-one", yesterday),
      store.recordCompletedTurn("turn-one", yesterday), store.recordCompletedTurn("turn-two", now)]);
    await store.flush();
    const stats = store.readStatistics();
    assert.equal(stats.totalTokens, 220);
    assert.equal(stats.totalTurns, 2);
    assert.equal(stats.currentStreak, 2);
    assert.equal(stats.bestStreak, 2);
    assert.equal(stats.days.reduce((sum, day) => sum + day.tokens!, 0), stats.totalTokens);
    assert.equal(stats.days.reduce((sum, day) => sum + day.input! + day.output!, 0), stats.totalTokens);
    assert.equal(stats.rankings.all?.models[0].count, 2);
    assert.equal(notifications, 4);
    unsubscribe();
    const restored = new UsageStore(file, () => now);
    await restored.initialize();
    assert.deepEqual(restored.readStatistics(), stats, "restart preserves numeric evidence");
    await restored.recordUsage(request("one", yesterday));
    assert.equal(restored.readStatistics().totalTokens, 220, "restart preserves deduplication");
    const json = JSON.parse(await readFile(file, "utf8"));
    assert.deepEqual(Object.keys(json.requests[0]).sort(), ["requestId", "recordedAt", "provider", "model", "source", "inputTokens", "outputTokens", "status", "standard"].sort());
    assert.equal(store.readStatistics(new Date(2026, 9, 13, 12).getTime()).currentStreak, 0);
    await writeFile(file, "not valid JSON");
    await assert.rejects(() => new UsageStore(file).initialize());
    assert.equal(await readFile(file, "utf8"), "not valid JSON", "corrupt evidence is preserved, never silently reset");
  } finally { await rm(root, { recursive: true, force: true }); }
}

const toolContext = testEstimator();
testNativeAttachmentLedger();
await testStreams(toolContext);
await testStore();
console.log("Usage accounting tests passed: local tokenizer, metadata exclusion, tool rounds, aborts, deduplication, persistence, daily totals and streaks.");
