import assert from "node:assert/strict";
import vm from "node:vm";
import { webcrypto } from "node:crypto";
import esbuild from "esbuild";
import { mobileBuildOptions } from "../../scripts/mobile-build.mjs";
import { createHost, FixtureTFile, answer } from "../mobile/host.mjs";
const build = await esbuild.build({ ...mobileBuildOptions("tests/mobile-tasks/entry.ts") });
const module = { exports: {} };
const sandbox = vm.createContext({ module, exports: module.exports, crypto: webcrypto, structuredClone, TextEncoder, TextDecoder, AbortController, URL,
  setTimeout, clearTimeout, console, require(id) { assert.equal(id, "obsidian"); return { TFile: FixtureTFile, TFolder: class {}, Notice: class {} }; } });
sandbox.self = sandbox; sandbox.window = sandbox;
vm.runInContext(build.outputFiles[0].text, sandbox);
const { MobileRuntime, MobileStore, loadMobileSettings, mobileProvider, mobileModel } = module.exports;
const STOP = "模型一直在调用工具，已自动停止，可以发‘继续’接着做";
for (const scenario of ["repeat", "changing", "invalid", "unknown", "multiple", "finish", "extended", "queue", "compaction"]) {
  if (process.env.TOOL_ROUND_CASE && process.env.TOOL_ROUND_CASE !== scenario) continue;
  const host = createHost(); const store = new MobileStore(host.adapter, "plugin/mobile", "tool-round-mobile"); await store.load();
  const provider = mobileProvider("custom"); Object.assign(provider, { apiKey: "fixture-key", baseUrl: "https://fixture.invalid/v1", models: [mobileModel("fixture", { toolCalling: true, contextWindow: scenario === "compaction" ? 56_000 : 500_000, maxOutputTokens: 1024 })], defaultModelId: "fixture" });
  const settings = loadMobileSettings({ apiProviders: [provider], activeApiProviderId: provider.id, defaultModel: "fixture" });
  let requests = 0, continuing = false, queued, summaries = 0, firstSummaryAt;
  const runtime = new MobileRuntime(host.app, store, () => settings, async request => {
    const body = JSON.parse(request.body);
    if (scenario === "compaction" && !body.tools && JSON.stringify(body).includes("忠实压缩")) { summaries++; firstSummaryAt ??= requests; return answer("openai-completions", "旧轮次摘要：读取验收资料，无写入。"); }
    requests++;
    if (continuing) return answer("openai-completions", "继续后的回答");
    if (scenario === "finish" && body.messages.some(message => typeof message.content === "string" && message.content.includes("本次工具调用已达上限"))) return answer("openai-completions", "查不到，只能根据已有信息回答。");
    if (scenario === "queue" && requests === 50) queued = await runtime.submit("排队的新消息");
    return answer("openai-completions", "", Array.from({ length: scenario === "multiple" ? 3 : 1 }, (_, index) =>
      [`tool-${requests}-${index}`, scenario === "unknown" ? "missing_tool" : "note_read", scenario === "invalid" ? { lineCount: 0 } : { path: scenario === "changing" ? `笔记/${requests}.md` : "笔记/来源.md" }]));
  });
  if (scenario === "extended") runtime.setCapabilities(() => ({ initializeSkills: async () => {}, assertRunSkills() {}, releaseRunSkills() {}, hasRunSkills: () => true, runtimeTools: () => [] }));
  try {
    await runtime.initialize();
    if (scenario === "compaction") await store.updateSession(store.session.id, task => { task.messages = [{ role: "user", content: "旧资料一条 ".repeat(9000), timestamp: 1 }, { role: "assistant", content: [{type:"text",text:"已记录旧资料。"}], api:"openai-completions", provider:"fixture", model:"fixture", stopReason:"stop", timestamp:2, usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}} }, {role:"user",content:"上一轮第二问",timestamp:3}, {role:"assistant",content:[{type:"text",text:"上一轮第二答"}],api:"openai-completions",provider:"fixture",model:"fixture",stopReason:"stop",timestamp:4,usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}}]; });
    const submission = await runtime.submit("逐篇读取资料");
    await submission.completion;
    const task = store.getSession(submission.taskId), limit = scenario === "extended" ? 150 : 60;
    const calls = task.messages.filter(message => message.role === "assistant" && message.content.some(block => block.type === "toolCall"));
    const results = task.messages.filter(message => message.role === "toolResult");
    assert.equal(calls.length, scenario === "finish" ? 61 : limit + 3, scenario);
    assert.equal(results.length, calls.length * (scenario === "multiple" ? 3 : 1), "every attempted call has a durable result");
    const blocked = results.filter(message => message.content.some(block => block.type === "text" && block.text.includes("本次工具调用已达上限")));
    if (["invalid", "unknown"].includes(scenario)) assert.equal(blocked.length, 0);
    if (!["invalid", "unknown"].includes(scenario)) assert.equal(blocked.length, (scenario === "finish" ? 1 : 3) * (scenario === "multiple" ? 3 : 1));
    if (scenario === "compaction") { assert.ok(summaries > 0, "real mobile history compaction happened"); assert.ok(firstSummaryAt > 0, "compaction happened after tool rounds began"); }
    if (scenario === "finish") assert.equal(task.taskStatus, "completed");
    else {
      assert.equal(task.taskStatus, "interrupted"); assert.equal(task.interruption.reason, "tool_loop_limit");
      if (scenario === "queue") { void queued.completion.catch(() => {}); assert.equal(requests, 63); assert.equal(task.queue.length, 1); }
      const reopened = new MobileStore(host.adapter, "plugin/mobile", "tool-round-mobile"); await reopened.load();
      assert.equal(reopened.getSession(task.id).interruption.reason, "tool_loop_limit");
      continuing = true;
      const before = requests;
      const continuation = await runtime.submit("继续", task.id); await continuation.completion;
      assert.equal(requests, before + 1); assert.equal(store.getSession(task.id).taskStatus, "completed");
    }
    console.log(JSON.stringify({ platform: "mobile", scenario, toolRounds: calls.length, results: results.length, blocked: blocked.length, requests, summaries, firstSummaryAt, status: "PASS" }));
  } finally { await runtime.dispose(); }
}
console.log(`Mobile stop copy: ${STOP}`);
