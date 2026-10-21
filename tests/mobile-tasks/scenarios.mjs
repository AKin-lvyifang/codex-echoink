import assert from "node:assert/strict";
import { createHost, answer } from "../mobile/host.mjs";

const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const waitFor = async check => { const end = Date.now() + 4_000; while (!check()) { if (Date.now() > end) throw new Error("condition timed out"); await tick(); } };
const userTexts = payload => (payload.messages ?? payload.input).filter(item => item.role === "user").map(item => typeof item.content === "string" ? item.content : item.content.filter(part => part.type === "text").map(part => part.text).join("\n"));

export async function taskScenarios({ MobileRuntime, MobileStore, loadMobileSettings, mobileProvider, mobileModel, taskMessageDigest }) {
  let passed = 0;
  const test = async (name, run) => { await run(); console.log(`ok ${++passed} - ${name}`); };
  const config = (options = {}) => {
    const provider = mobileProvider("custom"); Object.assign(provider, { apiKey: "fake-key", baseUrl: "https://fixture.example/v1", models: [mobileModel("fixture-model", options)], defaultModelId: "fixture-model" });
    return loadMobileSettings({ apiProviders: [provider], activeApiProviderId: provider.id, defaultModel: "fixture-model" });
  };
  const fixture = async (request = async () => answer("openai-completions", "ok"), settings = config(), context, initialize = true) => {
    const host = createHost(); const store = new MobileStore(host.adapter, "plugin/mobile", "task-fixture"); await store.load();
    const runtime = new MobileRuntime(host.app, store, () => settings, request, context); if (initialize) await runtime.initialize();
    return { ...host, store, runtime, settings };
  };

  await test("throwing subscribers cannot strand a task or block other subscribers", async () => {
    const state = await fixture(); const seen = [];
    state.runtime.onChange = () => { throw new Error("legacy view failed"); };
    const bad = state.runtime.subscribe(() => { throw new Error("view failed"); });
    const good = state.runtime.subscribe(id => seen.push(id));
    await state.runtime.send("still completes");
    assert.equal(state.runtime.busy, false); assert.ok(seen.length > 1); assert.ok(seen.every(id => id === state.store.session.id));
    assert.equal(state.store.session.messages.at(-1).content[0].text, "ok"); bad(); good(); state.runtime.dispose();
  });

  await test("sendNew rejects invalid input/model/Skill/context without publishing a task or changing selection", async () => {
    for (const scenario of ["empty", "unknown", "offline", "no-model", "stale-model", "stale-provider", "budget", "skill", "context", "attachments", "annotations", "multi-notes"]) {
      let calls = 0;
      const settings = scenario === "offline" ? loadMobileSettings({}) : config(scenario === "budget" ? { contextWindow: 64, maxOutputTokens: 63 } : {});
      if (scenario === "no-model") settings.apiProviders[0].models = [];
      const state = await fixture(async () => { calls++; return answer("openai-completions", "bad"); }, settings,
        async () => { if (scenario === "context") throw new Error("CONTEXT_FAILED"); return ""; });
      const selected = state.store.session.id, ids = state.store.state.sessions.map(task => task.id), page = state.store.state.page;
      const metadata = { attachments: [], ...(scenario === "skill" ? { selectedSkill: { id: "missing-skill", kind: "skill", metadata: { resourceId: "missing-skill" } } } : {}),
        ...(scenario === "stale-model" ? { selectedModel: "removed-model" } : {}), ...(scenario === "stale-provider" ? { selectedProviderSettingsId: "removed-provider" } : {}),
        ...(scenario === "attachments" ? { attachments: [{ path: "unavailable.png" }] } : {}), ...(scenario === "annotations" ? { annotations: [{ text: "unsupported" }] } : {}),
        ...(scenario === "multi-notes" ? { noteMentions: [{ vaultRelativePath: "笔记/来源.md", fileName: "来源" }, { vaultRelativePath: "笔记/第二篇.md", fileName: "第二篇" }] } : {}) };
      await state.store.update(latest => { latest.newTaskDrafts.sol = { ...metadata, text: "existing draft" }; });
      const text = scenario === "empty" ? "   " : `${scenario} input`, agent = scenario === "unknown" ? "missing" : "sol";
      await assert.rejects(state.runtime.sendNew(agent, text));
      assert.equal(calls, 0); assert.deepEqual(state.store.state.sessions.map(task => task.id), ids); assert.equal(state.store.session.id, selected); assert.deepEqual(state.store.state.page, page);
      if (scenario === "empty") assert.equal(state.store.state.newTaskDrafts.sol.text, "existing draft");
      else assert.equal(state.store.state.newTaskDrafts[agent].text, text);
      if (["attachments", "annotations", "multi-notes", "skill"].includes(scenario)) assert.deepEqual({ ...state.store.state.newTaskDrafts.sol, text: "existing draft" }, { ...metadata, text: "existing draft" });
      const reopened = new MobileStore(state.adapter, "plugin/mobile", "task-fixture"); await reopened.load(); assert.deepEqual(reopened.state.sessions.map(task => task.id), ids); state.runtime.dispose();
    }
  });

  await test("sendNew publishes one candidate with one identity only after durable admission and coalesces concurrent clicks", async () => {
    const contextGate = gate(), admissionGate = gate(), providerGate = gate(); let candidate, calls = 0, admissionStarted = false;
    const state = await fixture(async () => { calls++; return providerGate.promise; }, config(), async (id, turn) => {
      candidate = { id, turn }; assert.equal(state.store.getSession(id), undefined); await contextGate.promise; return `candidate ${id}`;
    });
    const before = state.store.state.sessions.length, selected = state.store.session.id, write = state.adapter.write.bind(state.adapter);
    state.adapter.write = async (path, bytes) => {
      if (path.endsWith(".tmp") && JSON.parse(bytes).sessions.length > before && !admissionStarted) { admissionStarted = true; await admissionGate.promise; }
      await write(path, bytes);
    };
    const first = state.runtime.sendNew("sol", "new once"), second = state.runtime.sendNew("sol", "new once"); assert.equal(first, second);
    await waitFor(() => !!candidate); assert.equal(state.store.session.id, selected); assert.equal(state.store.state.sessions.length, before);
    contextGate.resolve(); await waitFor(() => admissionStarted); assert.equal(state.store.getSession(candidate.id), undefined); assert.equal(calls, 0); assert.equal(state.store.session.id, selected);
    admissionGate.resolve(); const [a, b] = await Promise.all([first, second]); await waitFor(() => calls === 1);
    assert.equal(a.taskId, candidate.id); assert.equal(b.taskId, candidate.id); assert.equal(a.completion, b.completion); assert.equal(state.store.state.sessions.length, before + 1);
    assert.equal(state.store.session.id, candidate.id); assert.deepEqual(state.store.state.page, { kind: "detail", taskId: candidate.id });
    assert.equal(state.store.session.runs[0].id, candidate.turn.id); assert.equal(state.store.session.messages[0].content[0].text, "new once"); assert.equal(state.store.session.draft, ""); assert.equal(state.store.state.newTaskDrafts.sol, undefined);
    providerGate.resolve(answer("openai-completions", "done")); await a.completion; assert.equal(calls, 1); state.adapter.write = write; state.runtime.dispose();
  });

  await test("sendNew admission write failure retains the new draft and selection; retry publishes only one user turn", async () => {
    let calls = 0, candidateId;
    const state = await fixture(async request => { calls++; assert.deepEqual(userTexts(JSON.parse(request.body)), ["retry new"]); return answer("openai-completions", "done"); }, config(), async id => { candidateId = id; return ""; });
    const before = state.store.state.sessions.map(task => task.id), selected = state.store.session.id, page = state.store.state.page, write = state.adapter.write.bind(state.adapter); let failed = false;
    state.adapter.write = async (path, bytes) => {
      if (!failed && path.endsWith(".tmp") && JSON.parse(bytes).sessions.length > before.length) { failed = true; throw new Error("NEW_ADMISSION_FAILED"); }
      await write(path, bytes);
    };
    await assert.rejects(state.runtime.sendNew("sol", "retry new"), /NEW_ADMISSION_FAILED/u);
    assert.equal(calls, 0); assert.deepEqual(state.store.state.sessions.map(task => task.id), before); assert.equal(state.store.session.id, selected); assert.deepEqual(state.store.state.page, page);
    assert.equal(state.store.getSession(candidateId), undefined); assert.equal(state.store.state.newTaskDrafts.sol.text, "retry new");
    const retried = await state.runtime.sendNew("sol", "retry new"); await retried.completion;
    assert.equal(retried.taskId, candidateId); assert.equal(calls, 1); assert.equal(state.store.state.sessions.length, before.length + 1); assert.equal(state.store.session.messages.filter(message => message.role === "user").length, 1);
    state.adapter.write = write; state.runtime.dispose();
  });

  await test("sendNew captures prior queued draft selections in the writer and preserves metadata written after capture", async () => {
    const contextGate = gate(); let captured, payload;
    const state = await fixture(async request => { payload = JSON.parse(request.body); return answer("openai-completions", "done"); }, config(), async (_id, turn) => { captured = turn; await contextGate.promise; return ""; });
    const provider = state.settings.apiProviders[0]; provider.models.push(mobileModel("writer-model"));
    await state.store.update(latest => { latest.newTaskDrafts.sol = { text: "old draft", attachments: [], selectedProviderSettingsId: provider.id, selectedModel: "fixture-model" }; });
    const earlier = state.store.update(latest => { latest.newTaskDrafts.sol.selectedModel = "writer-model"; latest.newTaskDrafts.sol.selectedPermission = "read-only"; });
    const submission = state.runtime.sendNew("sol", "ready"); void submission.catch(() => {});
    try {
      await earlier; await waitFor(() => !!captured);
      assert.equal(captured.modelId, "writer-model"); assert.equal(captured.permission, "read-only");
      assert.equal(state.store.state.newTaskDrafts.sol.selectedModel, "writer-model"); assert.equal(state.store.state.newTaskDrafts.sol.text, "ready");
      await state.store.update(latest => { latest.newTaskDrafts.sol.selectedModel = "fixture-model"; latest.newTaskDrafts.sol.selectedPermission = "workspace-write"; });
      contextGate.resolve(); const accepted = await submission; await accepted.completion;
      assert.equal(payload.model, "writer-model"); assert.equal(state.store.getSession(accepted.taskId).runs[0].modelId, "writer-model");
      const remaining = state.store.state.newTaskDrafts.sol;
      assert.equal(remaining.text, "ready"); assert.equal(remaining.selectedModel, "fixture-model"); assert.equal(remaining.selectedPermission, "workspace-write");
    } finally { contextGate.resolve(); state.runtime.dispose(); }
  });

  await test("draft model/permission/Skill/reference is frozen for new and existing tasks; later draft metadata is retained", async () => {
    const waiting = gate(); let turn, payload;
    const state = await fixture(async request => { payload = JSON.parse(request.body); return answer("openai-completions", "done"); }, config(), async (_id, submitted) => { turn = submitted; await waiting.promise; return ""; });
    const other = mobileProvider("custom"); Object.assign(other, { apiKey: "other-fake", baseUrl: "https://other.example/v1", models: [mobileModel("chosen-model")], defaultModelId: "chosen-model" }); state.settings.apiProviders.push(other);
    const metadata = { attachments: [], selectedProviderSettingsId: other.id, selectedModel: "chosen-model", selectedPermission: "danger-full-access", selectedMode: "plan",
      selectedSkill: { id: "echoink-local:skill:two-layer-explanation", kind: "skill", metadata: { resourceId: "two-layer-explanation" } }, noteMentions: [{ vaultRelativePath: "笔记/来源.md", fileName: "来源" }] };
    await state.store.update(latest => { latest.newTaskDrafts.sol = { ...metadata, text: "chosen draft" }; });
    const submission = state.runtime.sendNew("sol", "chosen draft"); await waitFor(() => !!turn);
    await state.store.update(latest => { latest.newTaskDrafts.sol.selectedMode = "agent"; }); waiting.resolve(); const created = await submission; await created.completion;
    assert.equal(payload.model, "chosen-model"); assert.equal(turn.providerId, other.id); assert.equal(turn.permission, "read-only"); assert.equal(turn.skillId, "two-layer-explanation"); assert.equal(turn.notePath, "笔记/来源.md");
    assert.equal(state.store.session.id, created.taskId); assert.equal(state.store.session.draftContext.selectedMode, "plan"); assert.equal(state.store.state.newTaskDrafts.sol.selectedMode, "agent"); assert.equal(state.store.state.newTaskDrafts.sol.text, "chosen draft");
    await state.store.setPermission("read-only"); await state.store.patchSession(created.taskId, { draft: "existing task", draftContext: { ...metadata, selectedMode: "agent", selectedSkill: null } });
    await state.runtime.send("existing task", created.taskId); assert.equal(payload.model, "chosen-model"); assert.equal(turn.permission, "read-only"); assert.equal(turn.skillId, undefined); assert.equal(turn.notePath, "笔记/来源.md");
    for (const invalid of [{ ...metadata, selectedModel: "removed-model" }, { ...metadata, selectedProviderSettingsId: "removed-provider" }]) {
      await state.store.patchSession(created.taskId, { draft: "keep invalid selection", draftContext: invalid }); const count = state.store.session.messages.length;
      await assert.rejects(state.runtime.send("keep invalid selection", created.taskId), /失效/u); assert.equal(state.store.session.messages.length, count); assert.equal(state.store.session.draft, "keep invalid selection");
    }
    state.runtime.dispose();
  });

  await test("same Agent tasks and different Agent tasks execute concurrently with isolated completion and subscribers", async () => {
    const requests = [], pending = new Map();
    const state = await fixture(async request => { const payload = JSON.parse(request.body), text = userTexts(payload).at(-1); const wait = gate(); pending.set(text, wait); requests.push(text); return wait.promise; });
    state.settings.agentRegistry.agents.push({ id: "other", name: "同事", avatar: { kind: "default" }, position: "", styleId: "analysis", capabilityIds: [] });
    const a = state.store.session.id, b = (await state.store.createSession("sol")).id, c = (await state.store.createSession("other")).id;
    const events = []; const unsubscribe = state.runtime.subscribe(id => events.push(id));
    try {
      const [sa, sb, sc] = await Promise.all([state.runtime.submit("A", a), state.runtime.submit("B", b), state.runtime.submit("C", c)]);
      await waitFor(() => requests.length === 3); assert.equal(state.runtime.isBusy(a), true); assert.equal(state.runtime.isBusy(b), true);
      pending.get("B").resolve(answer("openai-completions", "B answer")); await sb.completion;
      assert.equal(state.runtime.isBusy(a), true); assert.equal(state.store.getSession(b).messages.at(-1).content[0].text, "B answer");
      await state.runtime.stopTask(a); await sa.completion; assert.equal(state.runtime.isBusy(c), true);
      pending.get("A").resolve(answer("openai-completions", "", [["late-a", "note_create", { path: "late.md", content: "bad" }]]));
      pending.get("C").resolve(answer("openai-completions", "C answer")); await sc.completion; await tick();
      assert.equal(state.files.has("late.md"), false); assert.ok(events.includes(a) && events.includes(b) && events.includes(c));
      assert.equal(state.store.getSession(c).runs[0].agentSnapshot.agentId, "other");
      const reopened = new MobileStore(state.adapter, "plugin/mobile", "task-fixture"); await reopened.load(); assert.deepEqual(reopened.state, state.store.state);
    } finally { unsubscribe(); state.runtime.dispose(); }
  });

  await test("one task accepts a durable ordered queue and suppresses repeated clicks", async () => {
    const first = gate(); const calls = [];
    const state = await fixture(async request => { const text = userTexts(JSON.parse(request.body)).at(-1); calls.push(text); return calls.length === 1 ? first.promise : answer("openai-completions", `${text} answer`); });
    const id = state.store.session.id;
    try {
      await state.store.patchSession(id, { draft: "one" });
      const [a, duplicate] = await Promise.all([state.runtime.submit("one", id), state.runtime.submit("one", id)]);
      assert.equal(a.completion, duplicate.completion); await waitFor(() => calls.length === 1);
      await state.store.patchSession(id, { draft: "two" }); const b = await state.runtime.submit("two", id);
      assert.equal(b.queued, true); assert.equal(state.store.getSession(id).queue.length, 1); assert.equal(state.store.getSession(id).draft, ""); assert.deepEqual(calls, ["one"]);
      first.resolve(answer("openai-completions", "one answer")); await Promise.all([a.completion, b.completion]);
      assert.deepEqual(calls, ["one", "two"]); assert.equal(state.store.getSession(id).queue.length, 0);
      assert.deepEqual(state.store.getSession(id).messages.filter(message => message.role === "user").map(message => message.content[0].text), ["one", "two"]);
    } finally { state.runtime.dispose(); }
  });

  await test("each task retains its own warm search through sends/stop and invalidates real host events", async () => {
    const state = await fixture(); const a = state.store.session.id, b = (await state.store.createSession()).id;
    let reads = 0, released = 0; const read = state.app.vault.read.bind(state.app.vault);
    state.app.vault.read = async file => { reads++; return read(file); };
    const off = state.app.vault.offref.bind(state.app.vault); state.app.vault.offref = event => { released++; off(event); };
    await state.runtime.send("手机", a); await state.runtime.send("先完成", a); assert.equal(reads, 1);
    await state.runtime.stopTask(a); await state.runtime.send("本地问答", a); assert.equal(reads, 1);
    await state.runtime.send("手机", b); assert.equal(reads, 2, "Another task owns a separate index");
    const file = state.app.vault.getAbstractFileByPath("笔记/来源.md"); state.files.set(file.path, "修改后的平板决定"); state.app.vault.trigger("modify", file);
    await state.runtime.send("平板", a); await state.runtime.send("平板", b); assert.equal(reads, 4);
    state.runtime.dispose(); assert.equal(released, 8); state.runtime.dispose(); assert.equal(released, 8);
  });

  await test("stopping pauses old queue; new explicit input runs alone and cold reopening never replays", async () => {
    const pending = gate(); let calls = 0;
    const state = await fixture(async () => ++calls === 1 ? pending.promise : answer("openai-completions", "new answer")); const id = state.store.session.id;
    try {
      const active = await state.runtime.submit("active", id); await waitFor(() => calls === 1);
      const queued = await state.runtime.submit("old queued", id); const rejection = assert.rejects(queued.completion, /暂停/u);
      await state.runtime.stopTask(id); await Promise.all([active.completion, rejection]);
      assert.equal(state.runtime.stateFor(id).paused, true); assert.equal(state.runtime.stateFor(id).queuedCount, 1);
      await state.runtime.send("new explicit", id); assert.equal(calls, 2); assert.equal(state.store.getSession(id).queue[0].text, "old queued");
      const coldHost = createHost(Object.fromEntries(state.files)); const reopened = new MobileStore(coldHost.adapter, "plugin/mobile", "task-fixture"); await reopened.load();
      const fresh = new MobileRuntime(coldHost.app, reopened, () => state.settings, async () => { throw new Error("must not replay"); }); await fresh.initialize();
      assert.equal(fresh.stateFor(id).busy, false); assert.equal(fresh.stateFor(id).queuedCount, 1); await fresh.shutdown("plugin_disabled"); fresh.dispose();
      pending.resolve(answer("openai-completions", "late"));
    } finally { state.runtime.dispose(); }
  });

  await test("first admission and queue save faults preserve input and retry emits one user message", async () => {
    let calls = 0; const payloads = []; const first = gate();
    const state = await fixture(async request => { calls++; payloads.push(JSON.parse(request.body)); return calls === 1 ? first.promise : answer("openai-completions", "ok"); }); const id = state.store.session.id;
    const write = state.adapter.write.bind(state.adapter); let fail = false;
    state.adapter.write = async (path, bytes) => { if (fail && path.endsWith(".tmp")) { fail = false; throw new Error("ADMISSION_FAILED"); } await write(path, bytes); };
    try {
      await state.store.patchSession(id, { draft: "first" }); fail = true;
      await assert.rejects(state.runtime.send("first", id), /ADMISSION_FAILED/u);
      assert.equal(calls, 0); assert.equal(state.store.getSession(id).messages.length, 0); assert.equal(state.store.getSession(id).draft, "first");
      assert.equal(state.files.get(state.store.m2BackupPath) !== undefined, true);
      const accepted = await state.runtime.submit("first", id); await waitFor(() => calls === 1);
      await state.store.patchSession(id, { draft: "queue input" }); fail = true;
      await assert.rejects(state.runtime.submit("queue input", id), /ADMISSION_FAILED/u);
      assert.equal(state.store.getSession(id).draft, "queue input"); assert.equal(state.store.getSession(id).queue?.length ?? 0, 0);
      first.resolve(answer("openai-completions", "ok")); await accepted.completion;
      assert.deepEqual(userTexts(payloads[0]), ["first"]);
    } finally { state.adapter.write = write; state.runtime.dispose(); }
  });

  await test("tool receipt save failure retains the accepted turn and real side effect, pauses later inputs", async () => {
    const response = gate(); let requests = 0;
    const state = await fixture(async () => { requests++; return response.promise; }); const id = state.store.session.id;
    const accepted = await state.runtime.submit("save note", id); await waitFor(() => requests === 1);
    const queued = await state.runtime.submit("must wait", id); const queuedRejected = assert.rejects(queued.completion, /暂停/u);
    const write = state.adapter.write.bind(state.adapter); let failed = false;
    state.adapter.write = async (path, bytes) => {
      if (!failed && path.endsWith(".tmp") && bytes.includes('"role":"toolResult"')) { failed = true; throw new Error("RECEIPT_FAILED"); }
      await write(path, bytes);
    };
    response.resolve(answer("openai-completions", "", [["create-once", "note_create", { path: "输出/回执.md", content: "only once" }]]));
    await assert.rejects(accepted.completion, /RECEIPT_FAILED/u); await queuedRejected;
    assert.equal(requests, 1); assert.equal(state.files.get("输出/回执.md"), "only once"); assert.equal(state.writes.filter(path => path === "输出/回执.md").length, 1);
    const saved = state.store.getSession(id); assert.equal(saved.messages.filter(message => message.role === "user").length, 1);
    assert.equal(saved.messages.find(message => message.role === "toolResult").details.saved, true); assert.equal(saved.draft, ""); assert.equal(saved.queuePaused, true);
    state.adapter.write = write; state.runtime.dispose();
  });

  await test("frozen context/identity/model/reference survives active switches; stop during preparation settles without provider", async () => {
    const contextGate = gate(); let snapshot, payload; let calls = 0;
    const state = await fixture(async request => { calls++; payload = JSON.parse(request.body); return answer("openai-completions", "done"); }, config(), async (id, turn) => { snapshot = { id, turn }; await contextGate.promise; return turn.agentSnapshot.name; });
    const a = state.store.session.id; await state.store.patchSession(a, { draft: "pending", notePath: "笔记/来源.md" });
    const submission = state.runtime.submit("pending", a); await waitFor(() => !!snapshot);
    const b = await state.store.createSession(); await state.store.patchSession(b.id, { draft: "B draft" });
    state.settings.agentRegistry.agents[0].name = "after rename";
    const replacement = mobileProvider("custom"); replacement.models = [mobileModel("replacement-model")]; replacement.defaultModelId = "replacement-model";
    state.settings.apiProviders.push(replacement); state.settings.activeApiProviderId = replacement.id; state.settings.defaultModel = "replacement-model";
    await state.store.patchSession(a, { notePath: "另一个引用.md", skillId: "not-the-admitted-skill" });
    contextGate.resolve(); const accepted = await submission; await accepted.completion;
    assert.equal(snapshot.id, a); assert.equal(snapshot.turn.agentSnapshot.name, "总助"); assert.equal(snapshot.turn.notePath, "笔记/来源.md");
    assert.equal(payload.model, "fixture-model"); assert.ok(payload.messages[0].content.includes("引用笔记：笔记/来源.md")); assert.ok(!payload.messages[0].content.includes("另一个引用.md"));
    assert.equal(state.store.session.id, b.id); assert.equal(state.store.session.draft, "B draft"); assert.equal(state.store.getSession(a).runs[0].agentSnapshot.name, "总助"); assert.equal(calls, 1);
    state.runtime.dispose();
    const never = gate(); const second = await fixture(async () => { throw new Error("must not request"); }, config(), () => never.promise);
    await second.store.patchSession(second.store.session.id, { draft: "stop me" }); const pending = second.runtime.send("stop me"); const stopped = assert.rejects(pending, /已停止/u);
    await tick(); await second.runtime.stopTask(second.store.session.id); await stopped;
    assert.equal(second.store.session.draft, "stop me"); assert.equal(second.store.session.messages.length, 0); never.resolve(""); second.runtime.dispose();
  });

  const questions = [{ questionId: "choice", prompt: "选择下一步", selection: "single", options: [{ optionId: "yes", label: "继续" }, { optionId: "no", label: "不继续" }], allowSupplement: false }];
  await test("questions persist full options, reject wrong/duplicate IDs and wait for a durable matching answer", async () => {
    let calls = 0;
    const state = await fixture(async () => ++calls === 1 ? answer("openai-completions", "", [["question-tool", "user_question", { questions }]]) : answer("openai-completions", "answered")); const id = state.store.session.id;
    const submission = await state.runtime.submit("ask", id); await waitFor(() => state.runtime.stateFor(id).interaction?.status === "pending");
    const waiting = state.runtime.stateFor(id).interaction; assert.deepEqual(waiting.questions, questions); assert.equal(state.store.session.taskStatus, "waiting");
    const replies = [{ questionId: "choice", selectedOptionIds: ["yes"] }];
    for (const [task, run, question] of [["wrong", waiting.runId, waiting.questionId], [id, "wrong", waiting.questionId], [id, waiting.runId, "wrong"]]) await assert.rejects(state.runtime.answerQuestion(task, run, question, replies), /过期|属于/u);
    const write = state.adapter.write.bind(state.adapter); let fail = true;
    state.adapter.write = async (path, bytes) => { if (fail && bytes.includes('"status":"answered"')) { fail = false; throw new Error("ANSWER_FAILED"); } await write(path, bytes); };
    await assert.rejects(state.runtime.answerQuestion(id, waiting.runId, waiting.questionId, replies), /ANSWER_FAILED/u);
    assert.equal(state.runtime.stateFor(id).interaction.status, "pending"); assert.equal(calls, 1);
    await state.runtime.answerQuestion(id, waiting.runId, waiting.questionId, replies);
    await assert.rejects(state.runtime.answerQuestion(id, waiting.runId, waiting.questionId, replies), /过期|回答/u);
    await submission.completion; assert.equal(calls, 2); assert.equal(state.runtime.stateFor(id).interaction.status, "answered");
    const fresh = new MobileRuntime(state.app, state.store, () => state.settings, async () => { throw new Error("no replay"); });
    await assert.rejects(fresh.answerQuestion(id, waiting.runId, waiting.questionId, replies), /过期/u); fresh.dispose(); state.runtime.dispose();
  });

  await test("confirmation wait is task-bound, cold reads do not resume it, and stopping cancels without a next request", async () => {
    let requests = 0;
    const state = await fixture(async () => { requests++; return answer("openai-completions", "", [["confirm-tool", "user_question", { kind: "confirmation", questions }]]); });
    const id = state.store.session.id, accepted = await state.runtime.submit("confirm", id);
    await waitFor(() => state.runtime.stateFor(id).interaction?.status === "pending");
    const interaction = state.runtime.stateFor(id).interaction; assert.equal(interaction.kind, "confirmation");
    const coldHost = createHost(Object.fromEntries(state.files)); const reopened = new MobileStore(coldHost.adapter, "plugin/mobile", "task-fixture"); await reopened.load();
    const cold = new MobileRuntime(coldHost.app, reopened, () => state.settings, async () => { throw new Error("must not resume"); }); await cold.initialize();
    assert.equal(cold.stateFor(id).busy, false); assert.deepEqual(cold.stateFor(id).interaction.questions, questions); assert.equal(cold.stateFor(id).interaction.status, "cancelled");
    await assert.rejects(cold.answerQuestion(id, interaction.runId, interaction.questionId, [{ questionId: "choice", selectedOptionIds: ["yes"] }]), /过期/u);
    await cold.shutdown("plugin_disabled"); cold.dispose(); await state.runtime.stopTask(id); await accepted.completion;
    assert.equal(requests, 1); assert.equal(state.store.getSession(id).interaction.status, "cancelled"); assert.equal(state.store.getSession(id).pendingResponse, undefined); state.runtime.dispose();
  });

  await test("revocation while preparing rejects the old context and never contacts Provider", async () => {
    const contextGate = gate(); let started = false, calls = 0;
    const state = await fixture(async () => { calls++; return answer("openai-completions", "bad"); }, config(), async () => { started = true; await contextGate.promise; return "old memory"; });
    const pending = state.runtime.send("request"); await waitFor(() => started); await state.store.setMemoryEnabled(false); contextGate.resolve();
    await assert.rejects(pending, /权限|资源/u); assert.equal(calls, 0); assert.equal(state.store.session.queuePaused, true); state.runtime.dispose();
  });

  await test("long task history uses task-local budgeted summary, retains full source and never truncates tool pairs", async () => {
    const settings = config({ toolCalling: false, contextWindow: 4_096, maxOutputTokens: 512 }); let summaries = 0, requests = 0; const sent = [];
    const state = await fixture(async request => {
      const payload = JSON.parse(request.body); sent.push(payload);
      if (payload.messages[0].content.startsWith("忠实压缩")) { summaries++; return answer("openai-completions", userTexts(payload).join("\n").includes("任务B") ? "准确的任务B摘要" : "准确的任务A摘要"); }
      requests++;
      if (userTexts(payload).at(-1) === "task B") { assert.ok(!JSON.stringify(payload).includes("任务A")); assert.ok(JSON.stringify(payload).includes("准确的任务B摘要")); }
      else assert.ok(JSON.stringify(payload).includes("准确的任务A摘要"));
      return answer("openai-completions", "answer");
    }, settings); const id = state.store.session.id;
    const history = Array.from({ length: 16 }, (_, index) => ({ role: "user", content: `任务A历史${index}：` + "完整的既有背景资料。".repeat(100), timestamp: index }));
    const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
    history.splice(15, 0,
      { role: "assistant", content: [{ type: "toolCall", id: "historic-read", name: "note_read", arguments: { path: "笔记/来源.md" } }], api: "openai-completions", provider: "custom", model: "fixture-model", stopReason: "toolUse", usage, timestamp: 14 },
      { role: "toolResult", toolCallId: "historic-read", toolName: "note_read", content: [{ type: "text", text: "paired historical evidence" }], details: { path: "笔记/来源.md" }, isError: false, timestamp: 14 });
    await state.store.patchSession(id, { messages: history, draft: "next" });
    const began = Date.now(); await state.runtime.send("next", id);
    assert.ok(summaries > 0); assert.equal(requests, 1); assert.equal(state.store.getSession(id).messages.length, history.length + 2);
    const summary = state.store.getSession(id).contextSummary; assert.ok(summary.throughMessageCount > 0); assert.equal(summary.sourceDigest, taskMessageDigest(history.slice(0, summary.throughMessageCount)));
    assert.deepEqual(state.store.getSession(id).messages.slice(0, history.length), history);
    const requested = sent.find(payload => !payload.messages[0].content.startsWith("忠实压缩"));
    assert.ok(requested.messages.some(message => message.tool_calls?.some(call => call.id === "historic-read")));
    assert.ok(requested.messages.some(message => message.role === "tool" && message.tool_call_id === "historic-read"));
    console.log(`summary evidence: ${Date.now() - began}ms, ${state.files.get(state.store.statePath).length} state characters, ${summaries} summary requests`);
    const b = await state.store.createSession(); const historyB = history.map(message => message.role === "user" ? { ...message, content: message.content.replaceAll("任务A", "任务B") } : message);
    await state.store.patchSession(b.id, { messages: historyB, draft: "task B" }); await state.runtime.send("task B", b.id);
    const summaryB = state.store.getSession(b.id).contextSummary; assert.equal(requests, 2); assert.ok(summaryB.text.includes("任务B"));
    assert.equal(summaryB.sourceDigest, taskMessageDigest(historyB.slice(0, summaryB.throughMessageCount))); assert.deepEqual(state.store.getSession(id).contextSummary, summary); state.runtime.dispose();
  });

  await test("summary failure and cancellation preserve old summary/full history and do not admit the prompt", async () => {
    const settings = config({ toolCalling: false, contextWindow: 4_096, maxOutputTokens: 512 });
    const state = await fixture(async () => ({ status: 503, json: { error: { message: "SUMMARY_FAILED" } } }), settings);
    const history = Array.from({ length: 10 }, (_, index) => ({ role: "user", content: `history ${index} ` + "背景资料。".repeat(200), timestamp: index }));
    const old = { text: "old summary", throughMessageCount: 1, sourceDigest: taskMessageDigest(history.slice(0, 1)), createdAt: 1 };
    await state.store.patchSession(state.store.session.id, { messages: history, contextSummary: old, draft: "new" });
    await assert.rejects(state.runtime.send("new"), /SUMMARY_FAILED/u);
    assert.deepEqual(state.store.session.messages, history); assert.deepEqual(state.store.session.contextSummary, old); assert.equal(state.store.session.draft, "new"); state.runtime.dispose();
    const blocked = gate(); let requested = false;
    const cancel = await fixture(async () => { requested = true; return blocked.promise; }, settings);
    await cancel.store.patchSession(cancel.store.session.id, { messages: history, contextSummary: old, draft: "cancel" });
    const pending = cancel.runtime.send("cancel"); const stopped = assert.rejects(pending, /已停止/u); await waitFor(() => requested); await cancel.runtime.stopTask(cancel.store.session.id); await stopped;
    assert.deepEqual(cancel.store.session.contextSummary, old); assert.deepEqual(cancel.store.session.messages, history); blocked.resolve(answer("openai-completions", "late summary")); cancel.runtime.dispose();
  });

  await test("summary commit failure keeps the previous valid summary and full source without admitting input", async () => {
    const settings = config({ toolCalling: false, contextWindow: 4_096, maxOutputTokens: 512 }); let calls = 0;
    const state = await fixture(async () => { calls++; return answer("openai-completions", "candidate summary"); }, settings);
    const history = Array.from({ length: 10 }, (_, index) => ({ role: "user", content: `history ${index} ` + "背景资料。".repeat(200), timestamp: index }));
    const old = { text: "previous valid summary", throughMessageCount: 1, sourceDigest: taskMessageDigest(history.slice(0, 1)), createdAt: 1 };
    await state.store.patchSession(state.store.session.id, { messages: history, contextSummary: old, draft: "unsent" });
    const write = state.adapter.write.bind(state.adapter); let failed = false;
    state.adapter.write = async (path, bytes) => {
      if (!failed && path.endsWith(".tmp") && bytes.includes('"text":"candidate summary"')) { failed = true; throw new Error("SUMMARY_COMMIT_FAILED"); }
      await write(path, bytes);
    };
    await assert.rejects(state.runtime.send("unsent"), /SUMMARY_COMMIT_FAILED/u);
    assert.equal(failed, true); assert.ok(calls > 0); assert.deepEqual(state.store.session.contextSummary, old); assert.deepEqual(state.store.session.messages, history); assert.equal(state.store.session.draft, "unsent");
    state.adapter.write = write; state.runtime.dispose();
  });

  await test("Agent stop blocks admission until explicit unblock, preserves historical attribution through handoff", async () => {
    const blocked = gate(); const state = await fixture(async () => blocked.promise);
    const beforeCount = state.store.state.sessions.length;
    await assert.rejects(state.runtime.sendNew("missing", "new"), /无效/u); assert.equal(state.store.state.sessions.length, beforeCount);
    state.settings.agentRegistry.agents.push({ id: "other", name: "原Agent", avatar: { kind: "default" }, position: "", styleId: "execution", capabilityIds: [] });
    const task = await state.store.createSession("other"), submission = await state.runtime.submit("work", task.id);
    await state.runtime.stopAgent("other"); await submission.completion;
    await assert.rejects(state.runtime.submit("again", task.id), /停止接收/u); await state.store.handoffAgentTasks("other");
    assert.equal(state.store.getSession(task.id).agentId, "sol"); assert.equal(state.store.getSession(task.id).runs[0].agentSnapshot.agentId, "other");
    state.runtime.unblockAgent("other"); blocked.resolve(answer("openai-completions", "late")); state.runtime.dispose();
  });

  await test("v2 validates new queue/summary/question fields, backs up original M2 bytes and offline history remains readable", async () => {
    const state = await fixture(undefined, config(), undefined, false); const original = state.files.get(state.store.statePath), id = state.store.session.id;
    await state.runtime.send("upgrade", id); assert.equal(state.files.get(state.store.m2BackupPath), original); assert.equal(state.store.state.taskRuntimeVersion, 2);
    const before = state.files.get(state.store.statePath);
    for (const patch of [{ queue: [{ id: "bad", text: "bad", apiKey: "never persist" }] }, { queuePaused: "yes" }, { contextSummary: { text: "bad", throughMessageCount: 99, sourceDigest: "0".repeat(64), createdAt: 1 } }, { interaction: { taskId: "wrong" } }]) {
      await assert.rejects(state.store.patchSession(id, patch)); assert.equal(state.files.get(state.store.statePath), before);
    }
    const offlineSettings = loadMobileSettings({}); const offline = new MobileRuntime(state.app, state.store, () => offlineSettings, async () => { throw new Error("no provider"); });
    assert.equal(offline.stateFor(id).busy, false); assert.ok(state.store.getSession(id).messages.length); await assert.rejects(offline.send("offline", id), /模型|提供商/u);
    assert.equal(state.files.get(state.store.m2BackupPath), original); offline.dispose(); state.runtime.dispose();
    let calls = 0; const tiny = await fixture(async () => { calls++; return answer("openai-completions", "bad"); }, config({ contextWindow: 64, maxOutputTokens: 63 }));
    await tiny.store.patchSession(tiny.store.session.id, { draft: "budget draft" });
    await assert.rejects(tiny.runtime.send("budget draft"), /预算/u); assert.equal(calls, 0); assert.equal(tiny.store.session.messages.length, 0); assert.equal(tiny.store.session.draft, "budget draft"); tiny.runtime.dispose();
  });
  console.log(`${passed} mobile task scenarios passed (real Agent, synthetic Provider, in-memory Vault).`);
}
