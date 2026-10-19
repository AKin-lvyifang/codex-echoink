import assert from "node:assert/strict";
import { createHost, answer } from "../mobile/host.mjs";
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const waitFor = async check => { const end = Date.now() + 5000; while (!check()) { if (Date.now() > end) throw new Error("condition timed out"); await tick(); } };
const questions = [{ questionId: "choice", prompt: "下一步", selection: "single", options: [{ optionId: "yes", label: "继续" }, { optionId: "no", label: "停止" }], allowSupplement: false }];
const assistant = (calls = [], text = "") => ({ role: "assistant", api: "openai-completions", provider: "custom", model: "fixture-model", timestamp: 1,
  content: [...(text ? [{ type: "text", text }] : []), ...calls.map(([id, name, args]) => ({ type: "toolCall", id, name, arguments: args }))],
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: calls.length ? "toolUse" : "stop" });
const users = payload => payload.messages.filter(item => item.role === "user").map(item => typeof item.content === "string" ? item.content : item.content.map(part => part.text).join(""));
export async function resumeScenarios({ MobileRuntime, MobileStore, loadMobileSettings, mobileProvider, mobileModel, interruptedMobileRequestMessages }) {
  let passed = 0;
  const test = async (name, run) => { await run(); console.log(`ok ${++passed} - ${name}`); };
  const config = (modelOptions = {}) => {
    const provider = mobileProvider("custom"); Object.assign(provider, { apiKey: "fake-key", baseUrl: "https://fixture.example/v1", models: [mobileModel("fixture-model", modelOptions)], defaultModelId: "fixture-model" });
    return loadMobileSettings({ apiProviders: [provider], activeApiProviderId: provider.id, defaultModel: "fixture-model" });
  };
  const fixture = async (request = async () => answer("openai-completions", "ok"), options = {}) => {
    const host = createHost(), settings = options.settings ?? config();
    const store = new MobileStore(host.adapter, "plugin/mobile", "resume-fixture"); await store.load();
    const runtime = new MobileRuntime(host.app, store, () => settings, request, options.context);
    if (options.initialize !== false) await runtime.initialize();
    return { ...host, store, settings, runtime };
  };
  const interrupted = async state => {
    await state.store.patchSession(state.store.session.id, { taskStatus: "interrupted", taskInterruptedAt: 10, interruption: { at: 10, reason: "user_stopped", stage: "等待模型" }, queuePaused: true });
    return state.store.session.id;
  };
  const legacy = async state => {
    const id = await interrupted(state);
    state.files.set("输出/旧笔记.md", "current");
    const messages = [{ role: "user", content: "旧任务", timestamp: 0 }, assistant([["legacy-write", "note_create", { path: "输出/旧笔记.md", content: "old intent" }]])];
    await state.store.patchSession(id, { messages }); return id;
  };

  await test("background shutdown is task-bound, idempotent, blocks late tools and leaves old queues paused", async () => {
    const pending = [], calls = [];
    const state = await fixture(async request => { const wait = gate(); pending.push(wait); calls.push(JSON.parse(request.body)); return wait.promise; });
    const a = state.store.session.id, b = (await state.store.createSession()).id;
    const [sa, sb] = await Promise.all([state.runtime.submit("A", a), state.runtime.submit("B", b)]); await waitFor(() => calls.length === 2);
    const queued = await state.runtime.submit("old queue", a); const queueRejected = assert.rejects(queued.completion, /暂停/u);
    const first = state.runtime.shutdown("app_backgrounded"), second = state.runtime.shutdown("app_closed"); assert.equal(first, second);
    await Promise.all([first, sa.completion, sb.completion, queueRejected]);
    const before = state.store.getSession(a); assert.equal(before.interruption.reason, "app_backgrounded"); assert.equal(before.interruption.stage, "等待模型");
    for (const id of [a, b]) assert.equal(state.store.getSession(id).taskStatus, "interrupted");
    await assert.rejects(state.runtime.submit("blocked", a), /暂停/u);
    await state.runtime.foreground(); await tick(); assert.equal(calls.length, 2);
    pending[0].resolve(answer("openai-completions", "", [["late", "note_create", { path: "late.md", content: "bad" }]])); pending[1].resolve(answer("openai-completions", "late"));
    await tick(); await state.store.flush(); assert.equal(state.files.has("late.md"), false); assert.deepEqual(state.store.getSession(a), before);
    assert.equal(state.store.getSession(a).queue.length, 1); await state.runtime.shutdown("plugin_disabled"); state.runtime.dispose();
  });

  await test("context, search and summary cancellation preserve unsent drafts and settle without another Provider call", async () => {
    for (const stage of ["context", "search", "summary"]) {
      const blocked = gate(); let began = false, calls = 0;
      const state = await fixture(async () => { began = true; calls++; return blocked.promise; }, { settings: config(stage === "summary" ? { toolCalling: false, contextWindow: 4096, maxOutputTokens: 512 } : {}),
        context: stage === "context" ? async () => { began = true; return blocked.promise; } : undefined });
      if (stage === "search") state.app.vault.read = async () => { began = true; return blocked.promise; };
      const id = state.store.session.id;
      if (stage === "summary") await state.store.patchSession(id, { messages: Array.from({ length: 10 }, (_, i) => ({ role: "user", content: `${i}` + "背景资料。".repeat(200), timestamp: i })) });
      await state.store.patchSession(id, { draft: "unsent" });
      const pending = state.runtime.send("unsent", id), rejected = assert.rejects(pending, /停止/u); await waitFor(() => began);
      await state.runtime.shutdown("app_backgrounded"); await rejected;
      assert.equal(state.store.getSession(id).draft, "unsent"); assert.equal(state.store.getSession(id).taskStatus, "interrupted");
      assert.equal(state.store.getSession(id).interruption.stage, { context: "准备上下文", search: "检索笔记", summary: "整理长历史" }[stage]);
      await state.runtime.foreground(); assert.equal(calls, stage === "summary" ? 1 : 0);
      blocked.resolve(stage === "summary" ? answer("openai-completions", "late summary") : "late"); await tick(); state.runtime.dispose();
    }
  });

  await test("cold scan marks unfinished runs unknown, cancels old questions, and preserves completed tasks and source", async () => {
    const state = await fixture(async () => answer("openai-completions", "", [["old-question", "user_question", { questions }]]));
    const completed = state.store.session.id; await state.store.patchSession(completed, { taskStatus: "completed", taskCompletedAt: 1, messages: [{ role: "user", content: "complete", timestamp: 1 }] });
    const id = (await state.store.createSession()).id; await state.runtime.submit("ask", id); await waitFor(() => state.store.getSession(id).interaction?.status === "pending");
    const old = state.store.getSession(id), oldCompleted = state.store.getSession(completed);
    const coldHost = createHost(Object.fromEntries(state.files)); const coldStore = new MobileStore(coldHost.adapter, "plugin/mobile", "resume-fixture"); await coldStore.load();
    let calls = 0; const cold = new MobileRuntime(coldHost.app, coldStore, () => state.settings, async () => { calls++; return answer("openai-completions", "bad"); });
    await cold.initialize(); await cold.initialize(); await cold.foreground();
    const loaded = coldStore.getSession(id); assert.equal(loaded.interruption.reason, "process_unknown"); assert.match(loaded.interruption.stage, /启动检查/u);
    assert.equal(loaded.interaction.status, "cancelled"); assert.equal(loaded.pendingResponse, undefined); assert.equal(loaded.runs[0].status, "interrupted");
    assert.deepEqual(loaded.messages, old.messages); assert.deepEqual(coldStore.getSession(completed), oldCompleted); assert.equal(calls, 0);
    await assert.rejects(cold.answerQuestion(id, old.interaction.runId, old.interaction.questionId, [{ questionId: "choice", selectedOptionIds: ["yes"] }]), /过期/u);
    await cold.shutdown("plugin_disabled"); cold.dispose(); await state.runtime.shutdown("plugin_disabled"); state.runtime.dispose();
  });

  await test("three explicit entries share one flight and create one new run in the original task without draining", async () => {
    const first = gate(), prepare = gate(); let calls = 0, preparing = false; const payloads = [];
    const state = await fixture(async request => { payloads.push(JSON.parse(request.body)); return ++calls === 1 ? first.promise : answer("openai-completions", "continued"); }, { context: async () => { if (calls) { preparing = true; await prepare.promise; } return ""; } });
    const id = state.store.session.id, original = await state.runtime.submit("initial", id); await waitFor(() => calls === 1);
    const queued = await state.runtime.submit("old", id); const queueRejected = assert.rejects(queued.completion, /暂停/u); await state.runtime.stopTask(id); await Promise.all([original.completion, queueRejected]);
    const oldRun = state.store.getSession(id).runs[0]; await state.store.patchSession(id, { draft: "continue once" });
    const a = state.runtime.resumeTask(id), b = state.runtime.resumeTask(id), c = state.runtime.submit("continue once", id); assert.equal(a, b); assert.equal(b, c);
    await waitFor(() => preparing); assert.equal(state.runtime.stateFor(id).resuming, true); prepare.resolve(); const accepted = await a; await accepted.completion;
    const task = state.store.getSession(id); assert.equal(accepted.taskId, id); assert.equal(task.runs.length, 3); assert.deepEqual(task.runs[0], oldRun);
    assert.equal(task.queue.length, 1); assert.equal(task.queuePaused, true); assert.equal(task.interruption, undefined); assert.equal(task.draft, ""); assert.equal(calls, 2);
    assert.deepEqual(users(payloads[1]), ["initial", "continue once"]); first.resolve(answer("openai-completions", "late")); state.runtime.dispose();
  });

  await test("canceling recovery inspection or context keeps drafts and interruption; switching active tasks cannot redirect", async () => {
    const state = await fixture(); const id = await legacy(state), wait = gate(); let began = false, calls = 0;
    const read = state.adapter.read.bind(state.adapter); state.adapter.read = async path => { if (path === "输出/旧笔记.md") { began = true; await wait.promise; } return read(path); };
    const pending = state.runtime.resumeTask(id, "keep this draft"), rejected = assert.rejects(pending, /停止|取消/u); await waitFor(() => began);
    const other = await state.store.createSession(); await state.runtime.cancelResume(id); await rejected;
    assert.equal(state.store.session.id, other.id); assert.equal(state.store.getSession(id).draft, "keep this draft"); assert.equal(state.store.getSession(id).interruption.at, 10);
    wait.resolve(); await tick(); assert.equal(state.runtime.stateFor(id).resumeReview, undefined); assert.equal(calls, 0); state.runtime.dispose();
    const context = gate(); let started = false;
    const next = await fixture(async () => { calls++; return answer("openai-completions", "bad"); }, { context: async () => { started = true; return context.promise; } });
    const taskId = await interrupted(next), input = next.runtime.resumeTask(taskId, "context draft"), stopped = assert.rejects(input, /停止/u); await waitFor(() => started);
    await next.runtime.cancelResume(taskId); await stopped; assert.equal(next.store.session.draft, "context draft"); assert.equal(next.store.session.interruption.at, 10); assert.equal(calls, 0); context.resolve(""); next.runtime.dispose();
  });

  await test("S5 requires the exact current fingerprint; confirmation rereads facts and never permits old writes", async () => {
    const payloads = []; let calls = 0;
    const state = await fixture(async request => { payloads.push(JSON.parse(request.body)); calls++; return calls === 1 ? answer("openai-completions", "", [["new-attempt", "note_create", { path: "输出/旧笔记.md", content: "old intent" }]]) : answer("openai-completions", "based on current facts"); });
    const id = await legacy(state), original = state.store.session.messages;
    await assert.rejects(state.runtime.submit("use current", id), error => error.code === "mobile_resume_review_required"); assert.equal(calls, 0);
    const first = state.runtime.stateFor(id).resumeReview; assert.equal(first.issues[0].target, "输出/旧笔记.md"); assert.equal(state.store.session.draft, "use current");
    state.files.set("输出/旧笔记.md", "changed by user");
    await assert.rejects(state.runtime.resumeTask(id, undefined, first.fingerprint), error => error.code === "mobile_resume_review_required");
    const second = state.runtime.stateFor(id).resumeReview; assert.notEqual(first.fingerprint, second.fingerprint); assert.equal(calls, 0);
    const accepted = await state.runtime.resumeTask(id, undefined, second.fingerprint); await accepted.completion;
    assert.equal(state.files.get("输出/旧笔记.md"), "changed by user"); assert.equal(state.writes.filter(path => path === "输出/旧笔记.md").length, 0);
    assert.deepEqual(state.store.session.messages.slice(0, original.length), original);
    assert.equal(state.store.session.messages.filter(message => message.role === "toolResult" && message.toolCallId === "legacy-write").length, 0);
    assert.ok(payloads[0].messages.some(message => message.role === "tool" && message.tool_call_id === "legacy-write"));
    assert.match(payloads[0].messages[0].content, /禁止重放/u); assert.equal(state.runtime.stateFor(id).resumeReview, undefined); state.runtime.dispose();
  });

  await test("permission revocation or removed model during resume prevents admission and retains original run and draft", async () => {
    for (const kind of ["permission", "model"]) {
      const wait = gate(); let started = false, calls = 0;
      const state = await fixture(async () => { calls++; return answer("openai-completions", "bad"); }, { context: async () => { started = true; return wait.promise; } });
      const id = await interrupted(state), pending = state.runtime.resumeTask(id, "retain on rejection"), rejected = assert.rejects(pending, /权限|资源|失效/u);
      await waitFor(() => started); if (kind === "permission") await state.store.setPermission("read-only"); else state.settings.apiProviders[0].models = [];
      wait.resolve(""); await rejected; assert.equal(calls, 0); assert.equal(state.store.session.draft, "retain on rejection"); assert.equal(state.store.session.interruption.at, 10); assert.equal(state.store.session.runs?.length ?? 0, 0); state.runtime.dispose();
    }
  });

  await test("shutdown waits for durable interruption, foreground waits too, and persistence failure remains observable", async () => {
    const wait = gate(); let calls = 0, saving = false;
    const state = await fixture(async () => { calls++; return new Promise(() => {}); }); const id = state.store.session.id, accepted = await state.runtime.submit("wait", id); await waitFor(() => calls === 1);
    const write = state.adapter.write.bind(state.adapter);
    state.adapter.write = async (path, bytes) => { if (path.endsWith(".tmp") && bytes.includes('"reason":"app_backgrounded"')) { saving = true; await wait.promise; } return write(path, bytes); };
    const shutdown = state.runtime.shutdown("app_backgrounded"); await waitFor(() => saving); const foreground = state.runtime.foreground(); let finished = false; void foreground.then(() => { finished = true; }); await tick(); assert.equal(finished, false); assert.equal(calls, 1);
    wait.resolve(); await Promise.all([shutdown, foreground, accepted.completion]); assert.equal(calls, 1); state.runtime.dispose();
    const failure = await fixture(async () => new Promise(() => {})); const sub = await failure.runtime.submit("failure"); await tick();
    failure.adapter.write = async () => { throw new Error("INTERRUPTION_DISK_FAILED"); };
    await assert.rejects(failure.runtime.shutdown("app_backgrounded"), /INTERRUPTION_DISK_FAILED/u); await assert.rejects(sub.completion, /INTERRUPTION_DISK_FAILED/u);
    await assert.rejects(failure.runtime.foreground(), /INTERRUPTION_DISK_FAILED/u);
  });

  await test("M3 upgrade backs up exact bytes once; unknown versions and damaged operation/run relationships reject without replacement", async () => {
    const state = await fixture(undefined, { initialize: false }); await state.store.update(latest => { latest.taskRuntimeVersion = 1; });
    const m3 = state.files.get(state.store.statePath), m2 = state.files.get(state.store.m2BackupPath);
    await state.runtime.initialize(); assert.equal(state.files.get(state.store.m3BackupPath), m3); assert.equal(state.files.get(state.store.m2BackupPath), m2);
    await state.runtime.shutdown("plugin_disabled"); assert.equal(state.files.get(state.store.m3BackupPath), m3);
    for (const damage of [value => { value.taskRuntimeVersion = 99; }, value => { value.sessions[0].operations = [{ id: "bad", taskId: value.sessions[0].id, runId: "missing", toolCallId: "call", toolName: "note_create", semanticKey: "note_create:a.md", status: "started", createdAt: 1, updatedAt: 1, target: "a.md", expectedHash: "0".repeat(64), targetWasMissing: true }]; }]) {
      const host = createHost(Object.fromEntries(state.files)), changed = JSON.parse(host.files.get(state.store.statePath)); damage(changed); const bytes = JSON.stringify(changed); host.files.set(state.store.statePath, bytes);
      const invalid = new MobileStore(host.adapter, "plugin/mobile", "resume-fixture"); await assert.rejects(invalid.load(), /格式/u); assert.equal(host.files.get(state.store.statePath), bytes);
    }
    const before = state.files.get(state.store.statePath);
    await assert.rejects(state.store.update(value => { value.taskRuntimeVersion = 99; }), /格式/u);
    assert.equal(state.files.get(state.store.statePath), before); state.runtime.dispose();
  });

  await test("new-run questions replace expired waiters and receive only a newly persisted answer", async () => {
    let calls = 0;
    const state = await fixture(async () => { calls++; return calls <= 2 ? answer("openai-completions", "", [[calls === 1 ? "old-waiter" : "new-waiter", "user_question", { questions }]]) : answer("openai-completions", "new answer"); });
    const id = state.store.session.id, original = await state.runtime.submit("ask", id); await waitFor(() => state.store.session.interaction?.status === "pending");
    const old = state.store.session.interaction; await state.runtime.shutdown("app_backgrounded"); await original.completion; await state.runtime.foreground(); assert.equal(calls, 1);
    const next = await state.runtime.resumeTask(id); await waitFor(() => state.store.session.interaction?.questionId === "new-waiter");
    const current = state.store.session.interaction; assert.notEqual(current.runId, old.runId);
    const replies = [{ questionId: "choice", selectedOptionIds: ["yes"] }];
    await assert.rejects(state.runtime.answerQuestion(id, old.runId, old.questionId, replies), /过期/u);
    await state.runtime.answerQuestion(id, current.runId, current.questionId, replies); await next.completion;
    assert.equal(calls, 3); assert.equal(state.store.session.interaction.status, "answered");
    assert.equal(state.store.session.messages.some(message => message.role === "toolResult" && message.toolCallId === old.questionId), false); state.runtime.dispose();
  });

  await test("product tools persist the real run journal and a resumed model cannot duplicate a verified old write", async () => {
    const wait = gate(); let calls = 0;
    const state = await fixture(async () => { calls++; if (calls === 2) return wait.promise; return calls === 1 || calls === 3 ? answer("openai-completions", "", [[`write-${calls}`, "note_create", { path: "输出/真实回执.md", content: "exact" }]]) : answer("openai-completions", "done"); });
    const id = state.store.session.id, original = await state.runtime.submit("write once", id); await waitFor(() => calls === 2);
    const operation = state.store.session.operations[0]; assert.equal(operation.runId, state.store.session.runs[0].id); assert.equal(operation.status, "completed");
    await state.runtime.stopTask(id); await original.completion; const next = await state.runtime.resumeTask(id); await next.completion;
    assert.equal(state.store.session.operations.length, 1); assert.deepEqual(state.store.session.operations[0], operation);
    assert.equal(state.writes.filter(path => path === "输出/真实回执.md").length, 1); assert.equal(state.store.session.runs.length, 2); assert.equal(calls, 4);
    wait.resolve(answer("openai-completions", "late")); state.runtime.dispose();
  });

  await test("changed facts during context preparation invalidate the reviewed snapshot before admission", async () => {
    const wait = gate(); let began = false, calls = 0;
    const state = await fixture(async () => { calls++; return answer("openai-completions", "bad"); }, { context: async () => { began = true; return wait.promise; } });
    const id = await legacy(state);
    await assert.rejects(state.runtime.resumeTask(id, "keep latest facts"), error => error.code === "mobile_resume_review_required");
    const snapshot = state.runtime.stateFor(id).resumeReview;
    const pending = state.runtime.resumeTask(id, undefined, snapshot.fingerprint), rejected = assert.rejects(pending, /变化|核对/u); await waitFor(() => began);
    state.files.set("输出/旧笔记.md", "newer than review"); wait.resolve(""); await rejected;
    assert.equal(calls, 0); assert.equal(state.store.session.draft, "keep latest facts"); assert.equal(state.store.session.interruption.at, 10); assert.equal(state.store.session.runs?.length ?? 0, 0); state.runtime.dispose();
  });

  await test("ordinary submit during stop waits for interruption instead of joining the paused old queue", async () => {
    let calls = 0; const wait = gate();
    const state = await fixture(async () => ++calls === 1 ? wait.promise : answer("openai-completions", "continued"));
    const id = state.store.session.id, original = await state.runtime.submit("initial", id); await waitFor(() => calls === 1);
    const stop = state.runtime.stopTask(id), next = state.runtime.submit("new during stop", id);
    await stop; await original.completion; const accepted = await next; await accepted.completion;
    assert.equal(accepted.queued, false); assert.equal(state.store.session.queue?.length ?? 0, 0); assert.equal(state.store.session.runs.length, 2); assert.equal(calls, 2);
    wait.resolve(answer("openai-completions", "late")); state.runtime.dispose();
  });

  await test("same-tick resume, shutdown and foreground cancel preparation without a lifecycle wait cycle", async () => {
    let calls = 0; const state = await fixture(async () => { calls++; return answer("openai-completions", "bad"); }); const id = await interrupted(state);
    await state.store.patchSession(id, { draft: "keep immediate resume" });
    const pending = state.runtime.resumeTask(id), rejected = assert.rejects(pending, /停止|暂停/u);
    const shutdown = state.runtime.shutdown("app_backgrounded"), foreground = state.runtime.foreground();
    let settled = false; const all = Promise.all([rejected, shutdown, foreground]).then(() => { settled = true; }); await waitFor(() => settled); await all;
    assert.equal(calls, 0); assert.equal(state.runtime.stateFor(id).resuming, false); assert.equal(state.store.session.draft, "keep immediate resume"); assert.equal(state.store.session.interruption.at, 10); state.runtime.dispose();
  });

  await test("ordinary same-tick admission cannot survive a background/foreground boundary", async () => {
    for (const kind of ["existing", "new"]) {
      let calls = 0; const state = await fixture(async () => { calls++; return answer("openai-completions", "bad"); });
      const pending = kind === "new" ? state.runtime.sendNew("sol", "before background") : state.runtime.submit("before background"); const rejected = assert.rejects(pending, /暂停|停止/u);
      const shutdown = state.runtime.shutdown("app_backgrounded"), foreground = state.runtime.foreground(); await Promise.all([rejected, shutdown, foreground]);
      assert.equal(calls, 0); assert.equal(state.store.session.runs?.length ?? 0, 0); state.runtime.dispose();
    }
  });

  await test("request repair adds explicit failed facts only in a copy and preserves genuine tool results", async () => {
    const source = [assistant([["missing-question", "user_question", { questions }], ["missing-tool", "note_create", { path: "a.md", content: "a" }], ["real", "note_read", {}]]), { role: "toolResult", toolCallId: "real", toolName: "note_read", content: [{ type: "text", text: "actual" }], isError: false, timestamp: 2 }];
    const before = structuredClone(source), copy = interruptedMobileRequestMessages(source);
    assert.deepEqual(source, before); assert.equal(copy.length, 4); assert.equal(copy.filter(message => message.role === "toolResult" && message.toolCallId === "real").length, 1);
    assert.equal(copy.find(message => message.toolCallId === "missing-question").isError, true); assert.match(copy.find(message => message.toolCallId === "missing-question").content[0].text, /过期/u);
    assert.match(copy.find(message => message.toolCallId === "missing-tool").content[0].text, /禁止重放/u);
    const first = assistant([["repeated", "note_read", {}]]), last = { ...assistant([["repeated", "note_read", {}]]), stopReason: "aborted" };
    const repaired = interruptedMobileRequestMessages([first, { role: "toolResult", toolCallId: "repeated", toolName: "note_read", content: [], isError: false, timestamp: 2 }, { role: "user", content: "new turn", timestamp: 3 }, last]);
    assert.equal(repaired.filter(message => message.role === "toolResult").length, 2); assert.equal(repaired.findLast(message => message.role === "assistant").stopReason, "toolUse"); assert.equal(last.stopReason, "aborted");
  });
  console.log(`${passed} mobile resume scenarios passed (real Agent, synthetic Provider, in-memory Vault).`);
}
