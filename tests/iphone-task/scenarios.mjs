import assert from "node:assert/strict";
import { createHost, answer } from "../mobile/host.mjs";
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
async function until(condition, label) { const deadline = Date.now() + 4000; while (!condition() && Date.now() < deadline) await settle(); assert.ok(condition(), label); }
const click = (root, label) => { const button = [...root.querySelectorAll("button")].find(item => item.getAttribute("aria-label") === label || item.textContent.trim() === label); assert.ok(button, `button ${label}`); button.click(); return button; };

export async function runIPhoneTaskScenarios(api, win) {
  let passed = 0;
  const test = async (name, action) => { await action(); console.log(`ok ${++passed} - ${name}`); };
  async function fixture() {
    const host = createHost({ "source.md": "fixture note" });
    const store = new api.MobileStore(host.adapter, "plugin/mobile", "iphone-task-fixture"); await store.load();
    const provider = api.mobileProvider("custom"); Object.assign(provider, { apiProtocol: "openai-completions", name: "Fixture", baseUrl: "https://provider.example/v1", apiKey: "synthetic-not-a-real-key", models: [api.mobileModel("fixture-model")], defaultModelId: "fixture-model" });
    const settings = api.loadMobileSettings({ apiProviders: [provider], activeApiProviderId: provider.id, defaultModel: "fixture-model" });
    settings.agentRegistry.agents[0].name = "甲助";
    settings.agentRegistry.agents.push({ ...structuredClone(settings.agentRegistry.agents[0]), id: "agent-b", name: "乙助" });
    const calls = [], errors = [], navigations = [], markdown = [], workbenchListeners = new Set(), refreshes = { tasks: 0 };
    const runtime = new api.MobileRuntime(host.app, store, () => settings, request => new Promise((resolve, reject) => calls.push({ resolve, reject, body: JSON.parse(request.body) })));
    const root = win.document.body.appendChild(win.document.createElement("div")); root.className = "echoink-iphone";
    const shell = new api.IPhoneShell(root, { onError: error => errors.push(error) }); shell.mount({ id: "fixture", title: "Fixture", content: win.document.createElement("div") });
    const ctx = { document: win.document, shell, navigate: async route => { navigations.push(route); }, error: error => errors.push(error), host: { app: host.app, store, runtime, settings: () => settings, workbench: { subscribe(listener) { workbenchListeners.add(listener); return () => workbenchListeners.delete(listener); }, refreshTasks() { refreshes.tasks++; workbenchListeners.forEach(listener => listener()); } }, async saveSettings() {}, async openLegacy() {}, async openNote() {}, renderMarkdown(text, element) { markdown.push(text); element.textContent = text; } } };
    const surfaces = [];
    const compose = target => { const surface = api.createIPhoneComposer(ctx, target); surfaces.push(surface); root.append(surface.element); return surface; };
    const input = (surface, text) => { const input = surface.element.querySelector("textarea"); input.value = text; input.dispatchEvent(new win.Event("input")); return input; };
    const close = async () => { surfaces.forEach(surface => surface.dispose()); shell.dispose(); runtime.dispose(); await until(() => store.state.sessions.every(task => !runtime.isBusy(task.id)), "fixture runtime stops"); root.remove(); };
    return { ...host, store, settings, runtime, ctx, root, calls, errors, navigations, markdown, workbenchListeners, refreshes, compose, input, close };
  }
  for (const mode of ["disabled", "enabled", "legacy"]) await test("iPhone tool-call guide " + mode + " keeps two buttons and one persisted failure prompt", async () => {
    const f = await fixture();
    try {
      const id = f.store.session.id, provider = f.settings.apiProviders[0], model = provider.models[0];
      model.toolCalling = mode === "enabled";
      const other = structuredClone(provider); other.id = "guide-default-other"; other.models[0].id = "global-only"; other.defaultModelId = "global-only";
      f.settings.apiProviders.push(other); f.settings.activeApiProviderId = other.id; f.settings.defaultModel = "global-only";
      const code = mode === "enabled" ? "model_tool_call_text_incompatible" : "model_tool_call_text_disabled";
      await f.store.patchSession(id, { taskStatus: "interrupted", taskInterruptedAt: 1000,
        interruption: { at: 1000, reason: "run_failed", stage: "saving", toolCallTextFailure: code,
          ...(mode === "legacy" ? {} : { providerSettingsId: provider.id, modelId: model.id }) },
        messages: [{ role: "user", content: "原任务", timestamp: 1 }] });
      const page = api.createTaskPage(f.ctx, id); f.ctx.shell.mount(page);
      const box = page.content.querySelector(".ip-task-stopbox"), buttons = [...box.querySelectorAll("button")];
      assert.deepEqual(buttons.map(button => button.textContent.trim()), ["上报问题", mode === "disabled" ? "开启工具调用并继续" : "继续"]);
      assert.equal(page.content.textContent.split("本轮没有执行工具").length - 1, 1);
      assert.equal(page.content.querySelector('[role="alert"]').hidden, true, "the old error area does not repeat the prompt");
      assert.equal(page.content.textContent.includes("模型设置"), false);
      if (mode === "enabled") assert.match(box.textContent, /或在 设置 → 模型服务 中更换模型/u);
      if (mode === "legacy") assert.match(box.textContent, /模型服务 → 对应服务 → 参数 → 对应模型/u);
      if (mode === "disabled") {
        const selected = [f.settings.activeApiProviderId, f.settings.defaultModel]; let sawBothDisabled = false;
        const unsubscribe = f.runtime.subscribe(taskId => { const box = page.content.querySelector(".ip-task-stopbox"); if (taskId === id && f.runtime.stateFor(id).resuming && box) sawBothDisabled ||= [...box.querySelectorAll("button")].every(button => button.disabled); });
        buttons[1].click();
        await until(() => f.calls.length === 1, "the shared continuation starts after enabling");
        unsubscribe(); assert.equal(sawBothDisabled, true, "saving disables both actions before any continuation request");
        const saved = f.settings.apiProviders[0].models[0]; assert.equal(saved.toolCalling, true); assert.equal(saved.capabilityOverrides.toolCalling, true);
        assert.deepEqual([f.settings.activeApiProviderId, f.settings.defaultModel], selected);
        assert.ok(f.calls[0].body.tools.length); assert.equal(f.calls[0].body.model, "fixture-model"); f.calls[0].resolve(answer("openai-completions", "恢复完成"));
        await until(() => !f.runtime.isBusy(id), "resumed task settles");
      }
    } finally { await f.close(); }
  });

  await test("immediate stop after durable admission retains its user message and complete existing history across reopen", async () => {
    const observations = [];
    for (const kind of ["new", "existing"]) {
      const f = await fixture();
      try {
        const text = "重复输入";
        const original = kind === "existing" ? [
          { role: "user", content: [{ type: "text", text }], timestamp: 1 },
          { role: "assistant", content: [{ type: "text", text: "上一轮回答" }], timestamp: 2 }
        ] : [];
        if (kind === "existing") await f.store.patchSession(f.store.session.id, { messages: original, taskStatus: "completed" });
        const admission = kind === "new" ? await f.runtime.sendNew("agent-b", text) : await f.runtime.submit(text, f.store.session.id);
        const beforeStop = f.store.getSession(admission.taskId);
        await f.runtime.stopTask(admission.taskId); await admission.completion.catch(() => {});
        const stopped = f.store.getSession(admission.taskId), reopened = new api.MobileStore(f.adapter, "plugin/mobile", "iphone-task-fixture"); await reopened.load();
        observations.push({ kind, originalCount: original.length, before: JSON.stringify(beforeStop.messages), after: JSON.stringify(stopped.messages), reopened: JSON.stringify(reopened.getSession(admission.taskId).messages), status: stopped.taskStatus });
      } finally { await f.close(); }
    }
    for (const observation of observations) {
      assert.equal(JSON.parse(observation.before).length, observation.originalCount + 1, `${observation.kind}: admission durably records its user message`);
      assert.equal(observation.after, observation.before, `${observation.kind}: immediate stop must not replace accepted transcript with a pre-prompt SDK snapshot`);
      assert.equal(observation.reopened, observation.before, `${observation.kind}: stopped transcript survives reopening`);
      assert.equal(observation.status, "interrupted");
    }
  });
  await test("new-task drafts stay independent from task replies and other Agents; one send creates one real task", async () => {
    const f = await fixture();
    try {
      const originalId = f.store.session.id;
      const reply = f.compose({ taskId: originalId }), a = f.compose({ agentId: "sol" }), b = f.compose({ agentId: "agent-b" });
      f.input(reply, "原任务回复"); f.input(a, "给甲的新任务"); f.input(b, "给乙的新任务");
      await until(() => f.store.state.newTaskDrafts["agent-b"]?.text === "给乙的新任务", "draft commands persist");
      assert.equal(f.store.getSession(originalId).draft, "原任务回复"); assert.equal(f.store.state.newTaskDrafts.sol.text, "给甲的新任务");
      click(a.element, "发送"); click(a.element, "发送"); await until(() => f.calls.length === 1 && f.navigations.length === 1, "new task admitted and navigated");
      assert.notEqual(f.navigations[0].taskId, originalId); assert.equal(f.store.state.sessions.length, 2);
      assert.equal(f.store.getSession(originalId).messages.length, 0); assert.equal(f.store.state.newTaskDrafts["agent-b"].text, "给乙的新任务");
      assert.equal(f.store.getSession(originalId).draft, "原任务回复"); assert.equal(a.element.querySelector("textarea").value, "");
      f.calls[0].resolve(answer("openai-completions", "完成")); await until(() => !f.runtime.isBusy(f.navigations[0].taskId), "new task completes");
    } finally { await f.close(); }
  });
  await test("failed admission retains exact draft and creates no empty task", async () => {
    const f = await fixture();
    try {
      f.settings.apiProviders[0].apiKey = "";
      const surface = f.compose({ agentId: "sol" }); const input = f.input(surface, "必须保留的原稿"); click(surface.element, "发送");
      await until(() => !surface.element.querySelector(".ip-composer-error").hidden, "failure visible");
      assert.equal(input.value, "必须保留的原稿"); assert.equal(f.store.state.newTaskDrafts.sol.text, input.value); assert.equal(f.store.state.sessions.length, 1); assert.equal(f.calls.length, 0);
    } finally { await f.close(); }
  });
  await test("typing during delayed admission preserves the newer draft after the submitted snapshot is consumed", async () => {
    const f = await fixture();
    try {
      let release; const gate = new Promise(resolve => { release = resolve; });
      const sendNew = f.runtime.sendNew.bind(f.runtime);
      f.runtime.sendNew = async (...args) => { await gate; return sendNew(...args); };
      const surface = f.compose({ agentId: "sol" }); f.input(surface, "先发这一条"); click(surface.element, "发送");
      await until(() => surface.element.querySelector(".ip-composer-send").disabled, "admission pending");
      f.input(surface, "受理时继续写的新稿"); await until(() => f.store.state.newTaskDrafts.sol?.text === "受理时继续写的新稿", "new draft persisted before admission");
      release(); await until(() => f.navigations.length === 1 && f.store.state.newTaskDrafts.sol.text === "受理时继续写的新稿", "newer draft restored after consumption");
      assert.equal(surface.element.querySelector("textarea").value, "受理时继续写的新稿");
      f.calls[0].resolve(answer("openai-completions", "受理完成")); await until(() => !f.runtime.isBusy(f.navigations[0].taskId), "completion");
    } finally { await f.close(); }
  });
  await test("an old disposed Agent composer cannot restore Y over a remounted Agent's newer Z after delayed X admission", async () => {
    const f = await fixture();
    try {
      let release, returned = false; const gate = new Promise(resolve => { release = resolve; });
      const sendNew = f.runtime.sendNew.bind(f.runtime);
      f.runtime.sendNew = async (...args) => { const submission = await sendNew(...args); await gate; returned = true; return submission; };
      const old = f.compose({ agentId: "sol" }); f.input(old, "X已发送"); click(old.element, "发送");
      await until(() => f.calls.length === 1, "X admitted while UI awaits completion of admission");
      f.input(old, "Y旧页面草稿"); await old.flush(); assert.equal(f.store.state.newTaskDrafts.sol.text, "Y旧页面草稿");
      assert.equal(await old.canLeave(), true); old.dispose();
      const b = f.compose({ agentId: "agent-b" }); f.input(b, "B独立草稿"); await b.flush(); b.dispose();
      const current = f.compose({ agentId: "sol" }); f.input(current, "Z新页面草稿"); await current.flush();
      release(); await until(() => returned, "old admission callback returns"); await settle();
      assert.equal(f.store.state.newTaskDrafts.sol.text, "Z新页面草稿"); assert.equal(current.element.querySelector("textarea").value, "Z新页面草稿");
      assert.equal(f.navigations.length, 0); assert.equal(f.store.state.newTaskDrafts["agent-b"].text, "B独立草稿");
      f.calls[0].resolve(answer("openai-completions", "X完成")); await until(() => f.store.state.sessions.every(task => !f.runtime.isBusy(task.id)), "X finishes");
    } finally { await f.close(); }
  });
  await test("failed draft writes block back and replacement, retain DOM, and retry successfully on the next leave", async () => {
    for (const kind of ["agent", "task"]) {
      const f = await fixture();
      try {
        const taskId = f.store.session.id;
        const surface = kind === "agent" ? f.compose({ agentId: "sol" }) : undefined;
        const page = surface ? { id: "agent-page", title: "Agent", content: win.document.createElement("div"), footer: surface.element, canLeave: surface.canLeave, dispose: surface.dispose } : api.createTaskPage(f.ctx, taskId);
        await f.ctx.shell.push(page);
        const input = page.footer.querySelector("textarea"), write = f.adapter.write;
        f.adapter.write = async () => { throw new Error("合成磁盘写入失败"); };
        input.value = `${kind}保存失败原稿`; input.dispatchEvent(new win.Event("input"));
        await until(() => !page.footer.querySelector(".ip-composer-error").hidden, "save failure stays visible");
        assert.equal(await f.ctx.shell.back(), false, "back cannot destroy failed draft");
        assert.equal(await f.ctx.shell.replace({ id: "replacement", title: "Replace", content: win.document.createElement("div") }), false, "replace cannot destroy failed draft");
        assert.equal(f.ctx.shell.activePageId, page.id); assert.equal(page.footer.querySelector("textarea"), input); assert.equal(input.value, `${kind}保存失败原稿`);
        f.adapter.write = write; assert.equal(await f.ctx.shell.back(), true, "retry succeeds after storage recovers");
        assert.equal(kind === "agent" ? f.store.state.newTaskDrafts.sol.text : f.store.getSession(taskId).draft, `${kind}保存失败原稿`);
      } finally { await f.close(); }
    }
  });
  await test("detail reply starts a run on its task and stop leaves the concurrent task running", async () => {
    const f = await fixture();
    try {
      const id = f.store.session.id, second = await f.store.createSession("agent-b");
      const a = f.compose({ taskId: id }), b = f.compose({ taskId: second.id });
      f.input(a, "A运行"); click(a.element, "发送"); await until(() => f.calls.length === 1, "A starts");
      f.input(b, "B运行"); click(b.element, "发送"); await until(() => f.calls.length === 2, "B starts");
      assert.equal(f.store.state.sessions.length, 2);
      click(a.element, "停止当前任务"); await until(() => !f.runtime.isBusy(id), "A stops"); assert.equal(f.runtime.isBusy(second.id), true);
      a.dispose(); assert.equal(f.runtime.isBusy(second.id), true);
      f.calls[1].resolve(answer("openai-completions", "B完成")); await until(() => !f.runtime.isBusy(second.id), "B finishes");
    } finally { await f.close(); }
  });
  await test("brand model, permission choice and note reference select actual new-run context without replacing input DOM", async () => {
    const f = await fixture();
    try {
      f.settings.apiProviders[0].models.push(api.mobileModel("selected-model")); f.settings.defaultModel = "selected-model";
      const surface = f.compose({ agentId: "sol" }), input = f.input(surface, "带选择的新任务");
      assert.equal(surface.element.querySelector(".ip-model-label").textContent, "selected-model");
      assert.ok(surface.element.querySelector(".ip-composer-model .ip-brand svg"));
      click(surface.element, "选择模型：selected-model");
      await until(() => !!f.root.querySelector(".ip-model-picker"), "model sheet opens");
      const selected = [...f.root.querySelectorAll(".ip-model-picker .ip-picker-row")].find(button => button.textContent.includes("selected-model"));
      assert.equal(selected.getAttribute("aria-pressed"), "true"); f.ctx.shell.closeSheet();
      assert.equal(surface.element.querySelector("textarea"), input);
      click(surface.element, "工作区权限：工作区可写");
      await until(() => !!f.root.querySelector(".ip-permission-picker"), "permission sheet opens");
      const full = [...f.root.querySelectorAll(".ip-permission-picker button")].find(button => button.textContent === "完全访问权限"); assert.equal(full.disabled, false);
      full.click(); await until(() => f.store.permission === "full-access" && f.store.state.newTaskDrafts.sol?.selectedPermission === "danger-full-access", "full access and draft persisted atomically");
      assert.equal(surface.element.querySelector("textarea"), input);
      click(surface.element, "工作区权限：完全访问权限");
      await until(() => !!f.root.querySelector(".ip-permission-picker"), "permission picker reopens after full access");
      click(f.root, "只读"); await until(() => f.store.state.newTaskDrafts.sol?.selectedPermission === "read-only", "permission draft persisted");
      assert.equal(f.store.permission, "read-only");
      click(surface.element, "引用笔记"); await until(() => !!f.root.querySelector(".ip-note-picker"), "note sheet opens");
      click(f.root, "source.md"); await until(() => f.store.state.newTaskDrafts.sol?.noteMentions?.[0]?.vaultRelativePath === "source.md", "note reference persisted");
      assert.equal(surface.element.querySelector("textarea"), input); assert.equal(input.value, "带选择的新任务");
      click(surface.element, "发送"); await until(() => f.navigations.length === 1, "context admitted");
      const run = f.store.getSession(f.navigations[0].taskId).runs[0]; assert.equal(run.modelId, "selected-model"); assert.equal(run.permission, "read-only"); assert.equal(run.notePath, "source.md");
      f.calls[0].resolve(answer("openai-completions", "上下文完成")); await until(() => !f.runtime.isBusy(f.navigations[0].taskId), "context run finishes");
    } finally { await f.close(); }
  });
  await test("single choice answers inline once, scopes task/run/question and preserves failed choices", async () => {
    const f = await fixture();
    try {
      const id = f.store.session.id, subscribers = new Set(), answered = [];
      let interaction = { taskId: id, runId: "run-a", questionId: "interaction-a", createdAt: 1, kind: "question", status: "pending", questions: [{ questionId: "q", prompt: "交给谁？", selection: "single", allowSupplement: false, options: [{ optionId: "a", label: "团队" }, { optionId: "b", label: "自己" }] }] };
      let reject;
      const runtime = { stateFor: () => ({ busy: true, interaction }), subscribe(cb) { subscribers.add(cb); return () => subscribers.delete(cb); }, answerQuestion(...args) { answered.push(args); return new Promise((_, no) => { reject = no; }); } };
      const ctx = { ...f.ctx, host: { ...f.ctx.host, runtime } };
      const surface = api.createInlineQuestion(ctx, id); f.root.append(surface.element);
      assert.equal(surface.element.textContent.includes("确认选择"), false);
      click(surface.element, "团队"); click(surface.element, "自己"); assert.equal(answered.length, 1);
      assert.equal(answered[0][0], id); assert.equal(answered[0][1], "run-a"); assert.equal(answered[0][2], "interaction-a");
      reject(new Error("合成保存失败")); await until(() => surface.element.textContent.includes("合成保存失败"), "failure visible");
      assert.equal(surface.element.querySelector('[data-option-id="a"]').getAttribute("aria-pressed"), "true");
      interaction = { ...interaction, runId: "run-b", questionId: "interaction-b" }; subscribers.forEach(cb => cb(id));
      const stale = surface.element.querySelector('[data-option-id="a"]'); interaction = { ...interaction, status: "cancelled" }; stale.click(); assert.equal(answered.length, 1, "stale run never answered");
      surface.dispose(); assert.equal(subscribers.size, 0);
    } finally { await f.close(); }
  });
  await test("multi-select and multiple questions confirm together in the inline card", async () => {
    const f = await fixture();
    try {
      const id = f.store.session.id, answered = [];
      const question = (questionId, selection) => ({ questionId, prompt: questionId, selection, allowSupplement: false, options: [{ optionId: "a", label: `${questionId}A` }, { optionId: "b", label: `${questionId}B` }] });
      const interaction = { taskId: id, runId: "run", questionId: "question-set", createdAt: 1, status: "pending", kind: "question", questions: [question("一", "multiple"), question("二", "single")] };
      const runtime = { stateFor: () => ({ busy: true, interaction }), subscribe: () => () => {}, async answerQuestion(...args) { answered.push(args); interaction.status = "answered"; } };
      const surface = api.createInlineQuestion({ ...f.ctx, host: { ...f.ctx.host, runtime } }, id); f.root.append(surface.element);
      click(surface.element, "一A"); click(surface.element, "一B"); click(surface.element, "二B"); assert.equal(answered.length, 0);
      click(surface.element, "确认选择"); await until(() => answered.length === 1, "single atomic answer");
      assert.deepEqual([...answered[0][3][0].selectedOptionIds], ["a", "b"]); assert.deepEqual([...answered[0][3][1].selectedOptionIds], ["b"]); surface.dispose();
    } finally { await f.close(); }
  });
  await test("accepted inline answer calls its owner once even when runtime notification disposes the waiting card first", async () => {
    const f = await fixture();
    try {
      const id = f.store.session.id; let resolved, called = 0, surface;
      const interaction = { taskId: id, runId: "run", questionId: "question", createdAt: 1, status: "pending", kind: "question", questions: [{ questionId: "q", prompt: "继续？", selection: "single", allowSupplement: true, options: [{ optionId: "yes", label: "继续" }] }] };
      const runtime = { stateFor: () => ({ busy: true, interaction }), subscribe: () => () => {}, answerQuestion() { interaction.status = "answered"; surface.dispose(); return new Promise(resolve => { resolved = resolve; }); } };
      surface = api.createInlineQuestion({ ...f.ctx, host: { ...f.ctx.host, runtime } }, id, () => { called++; }); f.root.append(surface.element);
      click(surface.element, "继续"); assert.equal(called, 0); resolved(); await until(() => called === 1, "parent answer callback survives card removal");
    } finally { await f.close(); }
  });
  await test("continue review confirms the inspected fingerprint; cancel starts no run", async () => {
    const f = await fixture();
    try {
      const id = f.store.session.id, calls = []; let review, cancelled = 0, accepted = 0;
      const runtime = { stateFor: () => ({ resuming: false, resumeReview: review }), async resumeTask(taskId, text, fingerprint) {
        calls.push([taskId, text, fingerprint]);
        if (!fingerprint) { review = { taskId, fingerprint: "current-fact-version", issues: [{ operationId: "write", target: "output.md", status: "unknown", label: "保存结果未确认" }], operations: [] }; throw new Error("review"); }
        return { completion: Promise.resolve() };
      }, async cancelResume() { cancelled++; review = undefined; } };
      const ctx = { ...f.ctx, host: { ...f.ctx.host, runtime } };
      await api.requestIPhoneTaskResume(ctx, id, "继续草稿", () => accepted++);
      assert.equal(calls.length, 1); click(f.root, "我已核对，请基于现状继续"); await until(() => accepted === 1, "confirmed admission");
      assert.deepEqual(calls[1], [id, "继续草稿", "current-fact-version"]); assert.equal(cancelled, 0);
      await api.requestIPhoneTaskResume(ctx, id); click(f.root, "暂不继续"); await until(() => cancelled === 1, "cancel resumes nothing"); assert.equal(accepted, 1); assert.equal(calls.length, 3);
    } finally { await f.close(); }
  });
  await test("message stream renders host Markdown, collapsed complete tool output, real interruption and cleans subscriptions", async () => {
    const f = await fixture();
    try {
      const id = f.store.session.id;
      await f.store.patchSession(id, { title: "真实任务", taskStatus: "interrupted", taskInterruptedAt: 1000, interruption: { at: 1000, stage: "saving", reason: "app_backgrounded" }, messages: [
        { role: "user", content: "用户原文", timestamp: 1 },
        { role: "assistant", content: [{ type: "text", text: "**回答正文**" }, { type: "toolCall", id: "call-1", name: "note_read", arguments: { path: "source.md" } }], timestamp: 2 },
        { role: "toolResult", toolCallId: "call-1", toolName: "note_read", content: [{ type: "text", text: "完整工具结果" }], timestamp: 3, isError: false }
      ] });
      const page = api.createTaskPage(f.ctx, id); f.ctx.shell.mount(page);
      assert.equal(page.content.querySelector("details").open, false); assert.ok(page.content.textContent.includes("完整工具结果"));
      assert.ok(f.markdown.includes("**回答正文**")); assert.equal(page.content.querySelector("time").dateTime, "1970-01-01T00:00:01.000Z"); assert.ok(page.content.textContent.includes("停在：保存结果"));
      await f.store.patchSession(id, { unreadAnswerAt: 2000 }); f.runtime.onChange();
      await until(() => f.store.getSession(id).lastReadAt === 2000 && f.refreshes.tasks === 1, "active result read refreshes retained task badges");
      await f.ctx.shell.push({ id: "other", title: "Other", content: win.document.createElement("div") });
      await f.store.patchSession(id, { unreadAnswerAt: 3000 }); f.runtime.onChange(); await settle();
      assert.equal(f.store.getSession(id).lastReadAt, 2000, "hidden retained task cannot consume unread result"); assert.equal(f.refreshes.tasks, 1);
      assert.ok(f.workbenchListeners.size > 0); page.dispose(); assert.equal(f.workbenchListeners.size, 0);
      f.runtime.onChange(); assert.equal(f.runtime.isBusy(id), false);
    } finally { await f.close(); }
  });
}
