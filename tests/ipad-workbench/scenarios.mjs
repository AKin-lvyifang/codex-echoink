import assert from "node:assert/strict";
import { createHost, answer } from "../mobile/host.mjs";

const settle = () => new Promise(resolve => setTimeout(resolve, 0));
async function until(check, label) {
  const deadline = Date.now() + 5000;
  while (!check() && Date.now() < deadline) await settle();
  assert.ok(check(), label);
}
const visible = element => !element.closest("[hidden], [inert]");
function button(root, label) {
  const found = [...root.querySelectorAll("button")].find(item => visible(item) && (item.getAttribute("aria-label") === label || item.textContent.trim() === label));
  assert.ok(found, `visible button ${label}`); return found;
}
const click = (root, label) => button(root, label).click();
function input(win, element, text) { assert.ok(element, "input exists"); element.value = text; element.dispatchEvent(new win.Event("input", { bubbles: true })); return element; }
const composerInput = root => [...root.querySelectorAll(".pd-composer-input")].find(visible);
const pageId = root => [...root.querySelectorAll(".echoink-ipad-page")].find(visible)?.dataset.pageId;
const userTexts = request => request.messages.filter(item => item.role === "user").map(item => typeof item.content === "string" ? item.content : item.content.map(part => part.text ?? "").join(""));
const assistant = (calls = []) => ({ role: "assistant", api: "openai-completions", provider: "custom", model: "fixture-model", timestamp: 1,
  content: calls.map(([id, name, args]) => ({ type: "toolCall", id, name, arguments: args })),
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse" });

export async function runIPadWorkbenchScenarios(api, win) {
  let passed = 0;
  const failures = [];
  const test = async (name, run) => {
    try { await run(); console.log(`ok ${++passed} - ${name}`); }
    catch (error) { failures.push(new Error(name, { cause: error })); console.error(`FAIL ${name}\n${error.stack}`); }
  };
  async function fixture({ signals = [] } = {}) {
    const memory = createHost({ "source.md": "fixture note", "输出/旧笔记.md": "当前真实内容" });
    memory.app.workspace.containerEl = win.document.createElement("div");
    const store = new api.MobileStore(memory.adapter, "plugin/mobile", "ipad-workbench-fixture"); await store.load();
    const provider = api.mobileProvider("custom");
    Object.assign(provider, { apiProtocol: "openai-completions", baseUrl: "https://fixture.example/v1", apiKey: "synthetic-not-a-real-key", models: [api.mobileModel("fixture-model")], defaultModelId: "fixture-model" });
    const settings = api.loadMobileSettings({ apiProviders: [provider], activeApiProviderId: provider.id, defaultModel: "fixture-model" });
    settings.agentRegistry.legacyMigrationVersion = 1;
    Object.assign(settings.agentRegistry.agents[0], { name: "甲助", disabledCapabilityIds: ["hidden-desktop-capability"] });
    settings.agentRegistry.agents.push({ id: "agent-b", name: "乙助", position: "整理资料", styleId: "analysis", avatar: { kind: "custom", mimeType: "image/webp", width: 256, height: 256, dataUrl: "data:image/webp;base64,AA==" }, capabilityIds: ["knowledge", "hidden-desktop-capability"] });
    settings.agentRegistry.moduleOwners["knowledge-base"] = "agent-b";
    settings.agentRegistry.moduleOwners.review = "agent-b";
    const calls = [], errors = [], navigations = [], handoffs = [], listeners = new Set(), surfaces = [];
    let registryWrites = 0, registryFailure, saveGate, refreshes = 0, pane, center;
    const agents = new api.MobileAgentRegistryService(memory.adapter, settings, async () => { registryWrites++; if (saveGate) await saveGate; if (registryFailure) throw registryFailure; });
    const runtime = new api.MobileRuntime(memory.app, store, () => settings, request => new Promise((resolve, reject) => calls.push({ resolve, reject, body: JSON.parse(request.body) })));
    await runtime.initialize();
    const makeRoot = () => { const root = win.document.createElement("main"); root.className = "echoink-ipad"; Object.defineProperty(root, "clientWidth", { value: 900 }); win.document.body.append(root); return root; };
    const right = makeRoot(), central = makeRoot(), auxiliary = makeRoot();
    const shell = new api.IPadShell(auxiliary, { onError: error => errors.push(error) });
    shell.mount({ id: "fixture", title: "Fixture", content: win.document.createElement("div") });
    const workbench = {
      async load() { return { generatedAt: Date.now(), signals, todayTodos: [], modules: ["journal", "todos", "finance", "knowledge-base", "english-diary"], issues: [] }; },
      subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
      refreshTasks() { refreshes++; [...listeners].forEach(fn => fn()); },
      async handoff(signal) {
        handoffs.push(signal);
        // This fixture implements only the host's data port. Admission and task
        // updates below always use the production MobileRuntime/MobileStore.
        const agentId = settings.agentRegistry.moduleOwners[signal.moduleId];
        await store.update(state => { state.newTaskDrafts[agentId] = { text: signal.prompt, attachments: [], prefillSource: JSON.stringify(signal.source) }; });
        return { agentId, conflict: false };
      }, dispose() {}
    };
    const host = { app: memory.app, store, runtime, agents, workbench, settings: () => settings,
      services: { subscribeIdentity() { return () => {}; }, safePath(path) { return path; }, async refreshAgentIdentity() {}, async removeAgent() {} },
      async saveSettings() {}, async openLegacy(route) { navigations.push({ legacy: route }); }, async openNote(path) { memory.opened.push(path); },
      async openHome() { navigations.push({ kind: "home" }); }, async openModule(module) { navigations.push({ module }); },
      async openAgent(route) { navigations.push(route); if (pane) await pane.navigate(route); }, async openSearch() { navigations.push({ search: true }); },
      async resumeTask(taskId) { assert.ok(pane, "resume requires the real right-pane controller"); await pane.resumeTask(taskId); },
      renderMarkdown(text, element) { element.textContent = text; } };
    const ctx = { root: auxiliary, document: win.document, shell, host, navigate: async route => navigations.push(route), error: error => errors.push(error) };
    const compose = target => { const surface = api.createIPadComposer(ctx, target); surfaces.push(surface); auxiliary.append(surface.element); return surface; };
    return { ...memory, host, ctx, store, runtime, settings, agents, calls, errors, navigations, handoffs, right, central, auxiliary, shell, compose,
      get registryWrites() { return registryWrites; }, get refreshes() { return refreshes; }, get listeners() { return listeners; },
      failRegistry(error) { registryFailure = error; }, gateSave(promise) { saveGate = promise; },
      async panes() { await store.update(state => { state.page = { kind: "list", agentId: "sol" }; }); pane = new api.IPadAgentPane(right, host); center = new api.IPadWorkbench(central, host); await pane.mount(); await center.mount(); return { pane, center }; },
      async form(id) { const page = api.createAgentFormPage(ctx, id); await shell.push(page); await until(() => !!page.content.querySelector("input[type=text]"), "form loaded"); return page; },
      async close() { center?.dispose(); pane?.dispose(); surfaces.forEach(surface => surface.dispose()); shell.dispose(); await runtime.shutdown("plugin_disabled"); runtime.dispose(); right.remove(); central.remove(); auxiliary.remove(); }
    };
  }

  await test("date uses the actual calendar weekday and plain localized spacing", async () => {
    assert.equal(api.formatMobileWorkbenchDate(new Date(2026, 9, 17, 12)), "10 月 17 日 星期六");
  });

  await test("central module navigation and right-pane return preserve their independent routes and exact drafts", async () => {
    const f = await fixture();
    try {
      const { pane, center } = await f.panes(); await pane.navigate({ kind: "agent", agentId: "sol" });
      const original = input(win, composerInput(f.right), "甲的未发送中文草稿"); original.focus(); original.setSelectionRange(2, 5);
      await until(() => f.store.state.newTaskDrafts.sol?.text === original.value, "Agent draft durable");
      f.settings.englishDiary.enabled = true;
      const rightRoute = pageId(f.right); await center.openModule("english-diary");
      assert.equal(pageId(f.right), rightRoute); assert.equal(composerInput(f.right), original); assert.equal(original.value, "甲的未发送中文草稿");
      const centralRoute = pageId(f.central);
      f.settings.englishDiary.enabled = false;
      await assert.rejects(center.openModule("english-diary"), /此模块已停用/u);
      assert.equal(pageId(f.central), centralRoute); assert.equal(composerInput(f.right), original);
      await f.store.patchSession(f.store.session.id, { title: "右栏任务", taskStatus: "completed", messages: [{ role: "user", content: "真实任务", timestamp: 1 }] });
      await pane.navigate({ kind: "task", taskId: f.store.session.id });
      input(win, composerInput(f.right), "原任务的回复草稿");
      click(f.right, "返回"); await until(() => pageId(f.right) === rightRoute, "task returns to originating Agent list");
      assert.equal(composerInput(f.right), original); assert.equal(original.selectionStart, 2); assert.equal(original.selectionEnd, 5);
      assert.equal(pageId(f.central), centralRoute); assert.equal(f.calls.length, 0);
    } finally { await f.close(); }
  });

  await test("switching Agents and returning never mixes their new-task drafts", async () => {
    const f = await fixture();
    try {
      const { pane } = await f.panes(); await pane.navigate({ kind: "agent", agentId: "sol" }); input(win, composerInput(f.right), "甲的草稿");
      await pane.navigate({ kind: "agent", agentId: "agent-b" }); assert.equal(composerInput(f.right).value, ""); input(win, composerInput(f.right), "乙的草稿");
      await pane.navigate({ kind: "agent", agentId: "sol" }); assert.equal(composerInput(f.right).value, "甲的草稿");
      await pane.navigate({ kind: "agent", agentId: "agent-b" }); assert.equal(composerInput(f.right).value, "乙的草稿");
      assert.equal(f.store.state.newTaskDrafts.sol.text, "甲的草稿"); assert.equal(f.store.state.newTaskDrafts["agent-b"].text, "乙的草稿"); assert.equal(f.calls.length, 0);
    } finally { await f.close(); }
  });

  await test("list/avatar changes mark no results read; opening one task marks only it and hidden detail consumes no later unread result", async () => {
    const f = await fixture();
    try {
      const first = f.store.session.id, second = (await f.store.createSession("sol")).id;
      for (const id of [first, second]) await f.store.patchSession(id, { title: id === first ? "第一件事" : "第二件事", taskStatus: "completed", unreadAnswerAt: 2000, messages: [{ role: "user", content: "已有记录", timestamp: 1 }] });
      const { pane } = await f.panes(); await pane.navigate({ kind: "agent", agentId: "sol" });
      await pane.navigate({ kind: "agent", agentId: "agent-b" }); await pane.navigate({ kind: "agent", agentId: "sol" });
      assert.equal(f.store.getSession(first).lastReadAt ?? 0, 0); assert.equal(f.store.getSession(second).lastReadAt ?? 0, 0);
      await pane.navigate({ kind: "task", taskId: first }); await until(() => f.store.getSession(first).lastReadAt === 2000, "opened task read");
      assert.equal(f.store.getSession(second).lastReadAt ?? 0, 0);
      await pane.navigate({ kind: "agent-form" });
      assert.ok(f.right.querySelector(`.echoink-ipad-page[hidden] .pd-task-detail[data-task-id="${first}"]`), "detail remains attached behind the form");
      await f.store.patchSession(first, { unreadAnswerAt: 3000 }); f.runtime.onChange(); await settle();
      assert.equal(f.store.getSession(first).lastReadAt, 2000, "hidden retained detail cannot clear new results");
    } finally { await f.close(); }
  });

  await test("new-task send is admitted once and failed admission retains the exact original input", async () => {
    const f = await fixture();
    try {
      const original = f.store.session.id, surface = f.compose({ agentId: "agent-b" }); const field = input(win, composerInput(surface.element), "只创建一次的新任务");
      click(surface.element, "发送"); click(surface.element, "发送"); await until(() => f.calls.length === 1 && f.navigations.length === 1, "one accepted task");
      const id = f.navigations[0].taskId; assert.notEqual(id, original); assert.equal(f.store.state.sessions.length, 2); assert.equal(field.value, "");
      f.calls[0].resolve(answer("openai-completions", "完成")); await until(() => !f.runtime.isBusy(id), "task complete");
      f.settings.apiProviders[0].apiKey = ""; input(win, field, "失败时逐字保留\n第二行"); click(surface.element, "发送");
      await until(() => !surface.element.querySelector(".pd-composer-error").hidden, "admission error visible");
      assert.equal(field.value, "失败时逐字保留\n第二行"); assert.equal(f.store.state.newTaskDrafts["agent-b"].text, field.value); assert.equal(f.store.state.sessions.length, 2); assert.equal(f.calls.length, 1);
    } finally { await f.close(); }
  });

  await test("different runs reusing call-1 render each note_read receipt beside its own original call", async () => {
    const f = await fixture();
    try {
      const id = f.store.session.id;
      // Use two real runs and real note_read executors so the displayed receipts
      // come from runtime history rather than a renderer-shaped message mock.
      for (const [index, path] of ["source.md", "输出/旧笔记.md"].entries()) {
        const submission = await f.runtime.submit(`读取第${index + 1}份笔记`, id); void submission.completion.catch(() => {});
        await until(() => f.calls.length === index * 2 + 1, "run reaches model");
        f.calls[index * 2].resolve(answer("openai-completions", "", [["call-1", "note_read", { path }]]));
        await until(() => f.calls.length === index * 2 + 2, "real note read returns");
        f.calls[index * 2 + 1].resolve(answer("openai-completions", `第${index + 1}轮完成`)); await submission.completion;
      }
      assert.equal(f.store.getSession(id).runs.filter(run => run.status === "completed").length, 2);
      const page = api.createTaskPage(f.ctx, id); await f.shell.push(page);
      const tools = [...page.content.querySelectorAll(".pd-task-tool")]; assert.equal(tools.length, 2);
      assert.match(tools[0].querySelector(".pd-tool-input").textContent, /source\.md/u);
      assert.match(tools[0].querySelector(".pd-tool-result").textContent, /fixture note/u);
      assert.doesNotMatch(tools[0].querySelector(".pd-tool-result").textContent, /当前真实内容/u);
      assert.match(tools[1].querySelector(".pd-tool-input").textContent, /输出\/旧笔记\.md/u);
      assert.match(tools[1].querySelector(".pd-tool-result").textContent, /当前真实内容/u);
      assert.doesNotMatch(tools[1].querySelector(".pd-tool-result").textContent, /fixture note/u);
    } finally { await f.close(); }
  });

  await test("returning from an untouched new-Agent form immediately reads the newly visible task result", async () => {
    const f = await fixture();
    try {
      const id = f.store.session.id;
      await f.store.patchSession(id, { title: "返回后读新结果", taskStatus: "completed", unreadAnswerAt: 2000, messages: [{ role: "user", content: "原任务", timestamp: 1 }] });
      const { pane } = await f.panes(); await pane.navigate({ kind: "task", taskId: id });
      await until(() => f.store.getSession(id).lastReadAt === 2000, "first visible result read");
      await pane.navigate({ kind: "agent-form" });
      await until(() => !!f.right.querySelector(".pd-agent-form input[type=text]"), "untouched new-Agent form ready");
      const detail = f.right.querySelector(`.pd-task-detail[data-task-id="${id}"]`); assert.equal(visible(detail), false);
      await f.store.patchSession(id, { unreadAnswerAt: 3000 }); f.runtime.onChange(); await settle();
      assert.equal(f.store.getSession(id).lastReadAt, 2000, "background result stays unread under the form");
      assert.equal(await pane.shell.back(), true); assert.equal(pageId(f.right), `task:${id}`);
      // No runtime notification after back: becoming visible must itself mark
      // the current result read, even when the task already existed in the stack.
      await until(() => f.store.getSession(id).lastReadAt === 3000, "return itself reads the newly visible result");
      assert.equal(f.store.state.page.kind, "detail"); assert.equal(f.store.state.page.taskId, id);
      assert.equal(visible(detail), true); assert.equal(f.calls.length, 0);
    } finally { await f.close(); }
  });

  await test("central interrupted-card resume reveals its task and opens S5 review only inside the real right pane", async () => {
    const f = await fixture();
    try {
      const id = f.store.session.id, target = "输出/旧笔记.md";
      await f.store.patchSession(id, { title: "中央继续须到右栏核对", taskStatus: "interrupted", taskInterruptedAt: 10,
        interruption: { at: 10, reason: "user_stopped", stage: "保存结果" }, queuePaused: true, draft: "核对前保留草稿",
        messages: [{ role: "user", content: "旧任务", timestamp: 0 }, assistant([["legacy-write", "note_create", { path: target, content: "旧写入意图" }]])] });
      await f.panes();
      const card = f.central.querySelector(`.pd-task-card[data-task-id="${id}"]`); assert.ok(card, "real central interruption card");
      click(card, "继续");
      await until(() => !!f.right.querySelector(".pd-resume-review"), "real pane owns the S5 review sheet");
      assert.equal(pageId(f.right), `task:${id}`); assert.ok(f.right.querySelector('[role="dialog"]'));
      assert.equal(f.central.querySelector('[role="dialog"], .pd-resume-review'), null, "central workspace never owns the recovery sheet");
      assert.equal(f.auxiliary.querySelector(".pd-resume-review"), null); assert.equal(f.calls.length, 0);
      assert.equal(f.store.getSession(id).draft, "核对前保留草稿");
      click(f.right, "暂不继续"); await until(() => !f.runtime.stateFor(id).resumeReview, "right-pane review cancelled");
      assert.equal(f.store.getSession(id).taskStatus, "interrupted"); assert.equal(f.files.get(target), "当前真实内容"); assert.equal(f.calls.length, 0);
    } finally { await f.close(); }
  });

  await test("running-task input queues once on the same task and runs in order after its current turn", async () => {
    const f = await fixture();
    try {
      const id = f.store.session.id, surface = f.compose({ taskId: id }); input(win, composerInput(surface.element), "第一轮"); click(surface.element, "发送"); await until(() => f.calls.length === 1, "first run starts");
      await until(() => button(surface.element, "发送").getAttribute("aria-busy") === "false", "first admission completed");
      input(win, composerInput(surface.element), "第二轮排队"); click(surface.element, "发送"); click(surface.element, "发送");
      await until(() => f.store.getSession(id).queue?.length === 1, "one durable queued turn");
      assert.equal(f.calls.length, 1); assert.equal(f.store.state.sessions.length, 1); assert.match(surface.element.textContent, /排队 1 条/u);
      f.calls[0].resolve(answer("openai-completions", "第一轮完成")); await until(() => f.calls.length === 2, "queued turn starts after first finishes");
      assert.deepEqual(userTexts(f.calls[1].body), ["第一轮", "第二轮排队"]);
      f.calls[1].resolve(answer("openai-completions", "第二轮完成")); await until(() => !f.runtime.isBusy(id), "queue completes");
      assert.equal(f.store.getSession(id).queue.length, 0);
    } finally { await f.close(); }
  });

  await test("stop belongs to the displayed task and leaves a concurrent Agent task running", async () => {
    const f = await fixture();
    try {
      const first = f.store.session.id, second = (await f.store.createSession("agent-b")).id;
      const a = f.compose({ taskId: first }), b = f.compose({ taskId: second });
      input(win, composerInput(a.element), "A运行"); click(a.element, "发送"); await until(() => f.calls.length === 1, "A starts");
      input(win, composerInput(b.element), "B运行"); click(b.element, "发送"); await until(() => f.calls.length === 2, "B starts");
      click(a.element, "停止当前任务"); await until(() => !f.runtime.isBusy(first), "A stops");
      assert.equal(f.store.getSession(first).taskStatus, "interrupted"); assert.equal(f.runtime.isBusy(second), true);
      a.dispose(); assert.equal(f.runtime.isBusy(second), true); f.calls[1].resolve(answer("openai-completions", "B完成")); await until(() => !f.runtime.isBusy(second), "B completes");
    } finally { await f.close(); }
  });

  for (const selection of ["single", "multiple"]) await test(`${selection} inline questions use real task/run/question identity and ${selection === "single" ? "answer on click" : "wait for confirmation"}`, async () => {
    const f = await fixture();
    try {
      const id = f.store.session.id, submission = await f.runtime.submit("请询问", id); void submission.completion.catch(() => {});
      await until(() => f.calls.length === 1, "model call");
      f.calls[0].resolve(answer("openai-completions", "", [["ask-options", "user_question", { questions: [{ questionId: "choice", prompt: "如何继续？", selection, allowSupplement: false, options: [{ optionId: "a", label: "选项甲" }, { optionId: "b", label: "选项乙" }] }] }]]));
      await until(() => f.runtime.stateFor(id).interaction?.status === "pending", "real tool waits for answer");
      const waiting = structuredClone(f.runtime.stateFor(id).interaction), page = api.createTaskPage(f.ctx, id); await f.shell.push(page);
      const stale = button(page.content, "选项甲"); stale.click();
      if (selection === "multiple") { click(page.content, "选项乙"); assert.equal(f.calls.length, 1); assert.equal(f.runtime.stateFor(id).interaction.status, "pending"); click(page.content, "确认选择"); }
      else { assert.equal([...page.content.querySelectorAll("button")].some(item => item.textContent.trim() === "确认选择"), false); stale.click(); }
      await until(() => f.calls.length === 2, "answer resumes exactly one run");
      const saved = f.runtime.stateFor(id).interaction;
      assert.equal(saved.taskId, id); assert.equal(saved.runId, waiting.runId); assert.equal(saved.questionId, waiting.questionId);
      assert.deepEqual([...saved.answers[0].selectedOptionIds], selection === "single" ? ["a"] : ["a", "b"]);
      stale.click(); await settle(); assert.equal(f.calls.length, 2); assert.equal(f.store.state.sessions.length, 1);
      f.calls[1].resolve(answer("openai-completions", "收到")); await submission.completion;
    } finally { await f.close(); }
  });

  await test("safe resume cancellation sends nothing; explicit confirmation keeps the original task and never replays an old write", async () => {
    const f = await fixture();
    try {
      const id = f.store.session.id, target = "输出/旧笔记.md";
      await f.store.patchSession(id, { taskStatus: "interrupted", taskInterruptedAt: 10, interruption: { at: 10, reason: "user_stopped", stage: "保存结果" }, queuePaused: true,
        messages: [{ role: "user", content: "旧任务", timestamp: 0 }, assistant([["legacy-write", "note_create", { path: target, content: "旧写入意图" }]])] });
      await api.requestIPadTaskResume(f.ctx, id, "继续时保留的草稿"); assert.ok(f.auxiliary.querySelector(".pd-resume-review")); assert.equal(f.calls.length, 0);
      click(f.auxiliary, "暂不继续"); await until(() => !f.runtime.stateFor(id).resumeReview, "inspection cancelled");
      assert.equal(f.store.getSession(id).draft, "继续时保留的草稿"); assert.equal(f.store.getSession(id).taskStatus, "interrupted"); assert.equal(f.calls.length, 0);
      await api.requestIPadTaskResume(f.ctx, id); click(f.auxiliary, "我已核对，请基于现状继续"); await until(() => f.calls.length === 1, "explicit continuation admitted");
      f.calls[0].resolve(answer("openai-completions", "", [["retry-old-write", "note_create", { path: target, content: "旧写入意图" }]]));
      await until(() => f.calls.length === 2, "blocked old write returns a tool result"); f.calls[1].resolve(answer("openai-completions", "根据现状继续"));
      await until(() => !f.runtime.isBusy(id), "continued task complete");
      assert.equal(f.files.get(target), "当前真实内容"); assert.equal(f.writes.filter(path => path === target).length, 0); assert.equal(f.store.state.sessions.length, 1);
      assert.match(f.calls[0].body.messages[0].content, /禁止重放/u);
    } finally { await f.close(); }
  });

  await test("new Agent preset stays local until one atomic save includes identity and module ownership", async () => {
    const f = await fixture();
    try {
      const page = await f.form(); page.content.querySelector(".pd-preset").click(); assert.equal(f.registryWrites, 0); assert.equal(f.settings.agentRegistry.agents.length, 2);
      input(win, page.content.querySelector("input[type=text]"), "新整理员");
      let release; f.gateSave(new Promise(resolve => { release = resolve; })); click(page.footer, "创建");
      await until(() => f.registryWrites === 1, "one atomic settings save starts");
      assert.equal(f.settings.agentRegistry.agents.length, 2); assert.equal(f.settings.agentRegistry.moduleOwners["knowledge-base"], "agent-b");
      assert.equal(button(page.footer, "正在保存…").disabled, true); assert.equal(await f.shell.back(), false);
      release(); await until(() => f.settings.agentRegistry.agents.length === 3, "atomic candidate published");
      const created = f.settings.agentRegistry.agents.find(agent => agent.name === "新整理员"); assert.ok(created); assert.equal(f.settings.agentRegistry.moduleOwners["knowledge-base"], created.id);
      assert.equal(f.settings.agentRegistry.moduleOwners.review, "agent-b"); assert.equal(f.registryWrites, 1);
    } finally { await f.close(); }
  });

  await test("real registry conflict preserves the exact form; cancelling and discarding adds zero writes", async () => {
    const f = await fixture();
    try {
      const page = await f.form("agent-b"); const field = input(win, page.content.querySelector("input[type=text]"), "冲突也要保留原稿");
      const fresh = await f.agents.snapshot(); await f.agents.update(registry => { registry.agents[0].position = "其他窗口已修改"; }, fresh.version);
      const writesBeforeSave = f.registryWrites; click(page.footer, "保存"); await until(() => !page.content.querySelector(".pd-error").hidden, "real version conflict shown");
      assert.match(page.content.querySelector(".pd-error").textContent, /配置已变化/u); assert.equal(field.value, "冲突也要保留原稿");
      assert.equal(f.settings.agentRegistry.agents[1].name, "乙助"); assert.equal(f.registryWrites, writesBeforeSave); assert.equal(f.shell.activePageId, page.id);
      click(page.footer, "取消"); await until(() => !!page.footer.querySelector(".pd-confirm"), "dirty cancel asks inline"); click(page.footer, "继续编辑"); await settle(); assert.equal(f.shell.activePageId, page.id); assert.equal(field.value, "冲突也要保留原稿");
      click(page.footer, "取消"); await until(() => !!page.footer.querySelector(".pd-confirm"), "second cancel"); click(page.footer, "放弃修改"); await until(() => f.shell.activePageId === "fixture", "discard returns"); assert.equal(f.registryWrites, writesBeforeSave);
    } finally { await f.close(); }
  });

  await test("editing preserves custom avatar, hidden capabilities and unshown ownership in one save", async () => {
    const f = await fixture();
    try {
      const page = await f.form("agent-b"); assert.equal(page.content.querySelector(".pd-avatar-option.is-selected").getAttribute("aria-label"), "头像 自定义头像");
      input(win, page.content.querySelector("input[type=text]"), "资料整理"); click(page.footer, "保存"); await until(() => f.shell.activePageId === "fixture", "saved form exits");
      const saved = f.settings.agentRegistry.agents.find(agent => agent.id === "agent-b"); assert.equal(saved.name, "资料整理"); assert.equal(saved.avatar.kind, "custom"); assert.ok(saved.capabilityIds.includes("hidden-desktop-capability")); assert.equal(f.settings.agentRegistry.moduleOwners.review, "agent-b"); assert.equal(f.registryWrites, 1);
    } finally { await f.close(); }
  });

  await test("central signals default to five; expand/collapse and handoff reveal an unsent Agent draft without task admission", async () => {
    const signals = Array.from({ length: 7 }, (_, index) => ({ id: index + 1, key: `fixture-${index}`, moduleId: "knowledge-base", icon: "library", description: `待整理信号${index}`, prompt: `请整理第${index}项`, source: { version: 1, signalId: index + 1, businessKey: `fixture-${index}`, moduleId: "knowledge-base", objects: [`source-${index}.md`], prompt: `请整理第${index}项`, capturedAt: 1 } }));
    const f = await fixture({ signals });
    try {
      await f.panes(); await until(() => f.central.querySelectorAll(".pd-signal-row").length === 5, "five initial signals load"); assert.equal(f.central.querySelectorAll(".pd-agent-strip").length, 0);
      click(f.central, "还有 2 条"); assert.equal(f.central.querySelectorAll(".pd-signal-row").length, 7); assert.equal(f.central.querySelector(".pd-section-more").getAttribute("aria-expanded"), "true");
      click(f.central, "收起"); assert.equal(f.central.querySelectorAll(".pd-signal-row").length, 5);
      const count = f.store.state.sessions.length; f.central.querySelector(".pd-signal-row button").click();
      await until(() => f.handoffs.length === 1 && composerInput(f.right)?.value === signals[0].prompt, "handoff reveals prefilled responsible Agent");
      assert.equal(f.store.state.sessions.length, count); assert.equal(f.calls.length, 0); assert.equal(f.central.querySelectorAll(".pd-signal-row").length, 5);
      assert.equal(f.store.state.newTaskDrafts["agent-b"].text, signals[0].prompt); assert.equal(pageId(f.right), "ipad-agent-agent-b");
    } finally { await f.close(); }
  });

  console.log(`iPad workbench scenarios: ${passed} passed, ${failures.length} failed (memory-only host; no native/device acceptance)`);
  if (failures.length) throw new AggregateError(failures, "iPad workbench scenario failures");
}
