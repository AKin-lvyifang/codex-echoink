import assert from "node:assert/strict";
import { createHost, answer } from "../mobile/host.mjs";
import { runMobileTaskResumeUIScenarios } from "./resume-scenarios.mjs";

const settle = () => new Promise(resolve => setTimeout(resolve, 0));
async function until(condition, label) {
  const deadline = Date.now() + 4_000;
  while (!condition() && Date.now() < deadline) await settle();
  assert.ok(condition(), label);
}
function text(message) { return typeof message.content === "string" ? message.content : message.content.filter(block => block.type === "text").map(block => block.text).join("\n"); }
function providerQueue() {
  const calls = [];
  return { calls, request(request) { return new Promise((resolve, reject) => calls.push({ body: JSON.parse(request.body), resolve, reject })); } };
}
const prompts = [
  { questionId: "destination", prompt: "把这份虚构计划交给谁？", selection: "single", options: [{ optionId: "team", label: "团队", description: "合成选项说明" }, { optionId: "self", label: "我自己" }], allowSupplement: true },
  { questionId: "channels", prompt: "选择通知方式", selection: "multiple", options: [{ optionId: "note", label: "笔记" }, { optionId: "chat", label: "对话" }], allowSupplement: false }
];

export async function runMobileTaskUIScenarios(api, win) {
  const { MobileUI, MobileStore, MobileRuntime, loadMobileSettings, mobileProvider, mobileModel } = api;
  let passed = 0;
  const test = async (name, work) => { await work(); passed++; console.log(`ok ${passed} - ${name}`); };
  async function fixture(request, isTablet = false, services = undefined, context = undefined) {
    const host = createHost({}); host.app.workspace.containerEl = win.document.body;
    const store = new MobileStore(host.adapter, "plugin/mobile", "task-ui-fixture"); await store.load();
    const provider = mobileProvider("custom"); Object.assign(provider, { apiProtocol: "openai-completions", name: "Synthetic", baseUrl: "https://provider.example/v1", apiKey: "synthetic-not-a-real-key",
      models: [mobileModel("synthetic-model")], defaultModelId: "synthetic-model" });
    const config = loadMobileSettings({ apiProviders: [provider], activeApiProviderId: provider.id, defaultModel: "synthetic-model", providerMode: "api" });
    config.agentRegistry.agents[0].name = "甲助";
    config.agentRegistry.agents.push({ ...structuredClone(config.agentRegistry.agents[0]), id: "agent-b", name: "乙助", capabilityIds: ["knowledge"] });
    const runtime = new MobileRuntime(host.app, store, () => config, request, context);
    const roots = [], views = [], openedNotes = [];
    const mount = (settingsOnly = false) => {
      const root = win.document.body.appendChild(win.document.createElement("div")); roots.push(root);
      const ui = new MobileUI(root, { app: host.app, store, runtime, isTablet, settingsOnly, services, settings: () => config, async saveSettings() {}, async openNote(path) { openedNotes.push(path); }, beginRender() {}, renderMarkdown(value, element) { element.textContent = value; } });
      ui.mount(); views.push(ui); return { root, ui };
    };
    const main = mount();
    const click = (label, root = main.root) => {
      const button = [...root.querySelectorAll("button")].find(item => item.getAttribute("aria-label") === label || item.textContent.trim() === label);
      assert.ok(button, `button ${label}`); button.click(); return button;
    };
    const send = async value => {
      const input = main.root.querySelector(".em-input"); input.value = value;
      input.dispatchEvent(new win.Event("input")); await store.flush(); click("发送消息");
      await until(() => !main.root.querySelector(".em-send").disabled, "admission must release sending guard");
      return input;
    };
    const select = async id => { await store.selectSession(id); runtime.onChange(); };
    const close = async () => { views.forEach(ui => ui.destroy()); runtime.dispose(); await until(() => store.state.sessions.every(task => !runtime.isBusy(task.id)), "fixture runs stop during teardown"); roots.forEach(root => root.remove()); };
    return { ...host, store, config, runtime, ...main, mount, click, send, select, close, openedNotes };
  }

  for (const tablet of [false, true]) await test(`${tablet ? "iPad" : "iPhone"} accepted knowledge results keep zero notes noninteractive and unique note links expandable`, async () => {
    const f = await fixture(async () => answer("openai-completions", "检索结束"), tablet);
    try {
      const id = f.store.session.id; await f.send("查找相关笔记");
      await until(() => !f.runtime.isBusy(id) && f.store.session.runs.length === 1, "accepted search completes");
      const zero = f.root.querySelector(".echoink-preparation-result");
      assert.ok(zero); assert.equal(zero.textContent, "没有找到相关笔记"); assert.equal(zero.tagName, "DIV");
      assert.equal(zero.querySelector("summary, button, [role=button], [tabindex]"), null); assert.equal(zero.tabIndex, -1);
      zero.click(); assert.equal(zero.hasAttribute("open"), false);

      const setPreparation = async preparation => {
        await f.store.updateSession(id, session => { session.runs[0].preparation = preparation; }); f.runtime.onChange();
      };
      await setPreparation(undefined); assert.equal(f.root.querySelector(".echoink-preparation-result"), null);
      await setPreparation([{ stage: "knowledge", status: "active" }, { stage: "memory", status: "completed" }]);
      assert.equal(f.root.querySelector(".echoink-preparation-result"), null);
      await setPreparation([{ stage: "knowledge", status: "completed", notePaths: [" ", ""] }]);
      assert.equal(f.root.querySelector(".echoink-preparation-result").tagName, "DIV");
      f.config.settingsLanguage = "en"; f.runtime.onChange();
      assert.equal(f.root.querySelector(".echoink-preparation-result").textContent, "No related notes found");

      await setPreparation([{ stage: "knowledge", status: "completed", notePaths: [" 笔记/甲.md ", "笔记\\甲.md", "笔记/乙.md"] }]);
      const result = f.root.querySelector("details.echoink-preparation-result"); assert.ok(result); assert.equal(result.open, false);
      assert.equal(result.querySelector("summary").textContent, "Read 2 relevant notes");
      result.querySelector("summary").click(); assert.equal(result.open, true);
      const links = [...result.querySelectorAll(".echoink-preparation-note")]; assert.deepEqual(links.map(link => link.textContent), ["甲", "乙"]);
      links.forEach(link => link.click()); assert.deepEqual(f.openedNotes, ["笔记/甲.md", "笔记/乙.md"]);
    } finally { await f.close(); }
  });

  for (const tablet of [false, true]) await test(`${tablet ? "iPad" : "iPhone"} task switch retains composer DOM, independent identity and late-result scope`, async () => {
    const provider = providerQueue(); const f = await fixture(provider.request, tablet);
    try {
      const a = f.store.session.id;
      const input = await f.send("任务A问题"); await until(() => provider.calls.length === 1, "A provider request");
      const b = await f.store.createSession("agent-b"); f.runtime.onChange();
      assert.equal(f.root.querySelector(".em-input"), input); assert.equal(f.root.querySelector(".em-title").textContent, "乙助"); assert.ok(input.placeholder.includes("乙助"));
      await f.send("任务B问题"); await until(() => provider.calls.length === 2, "B runs while A waits");
      assert.equal(f.runtime.isBusy(a), true); assert.equal(f.runtime.isBusy(b.id), true);
      input.value = "B还没发送的草稿"; input.dispatchEvent(new win.Event("input")); await f.store.flush();
      provider.calls[0].resolve(answer("openai-completions", "A独立回答")); await until(() => !f.runtime.isBusy(a), "A completes in background");
      assert.equal(f.root.querySelector(".em-input"), input); assert.equal(input.value, "B还没发送的草稿"); assert.equal(f.root.querySelector(".em-messages").textContent.includes("A独立回答"), false);
      provider.calls[1].resolve(answer("openai-completions", "B独立回答")); await until(() => !f.runtime.isBusy(b.id), "B completes");
      assert.ok(f.root.querySelector(".em-messages").textContent.includes("B独立回答"));
      await f.select(a); assert.equal(f.root.querySelector(".em-input"), input); assert.equal(f.root.querySelector(".em-title").textContent, "甲助"); assert.ok(f.root.querySelector(".em-messages").textContent.includes("A独立回答"));
    } finally { await f.close(); }
  });

  for (const tablet of [false, true]) await test(`${tablet ? "iPad" : "iPhone"} new-chat and history clicks clear the departed task's scrolling before its first animation frame`, async () => {
    const requestFrame = win.requestAnimationFrame, cancelFrame = win.cancelAnimationFrame;
    const frames = new Map(); let frameId = 0;
    // Keep every frame pending: leaving must work before the scroller adopts a sequence or measures layout.
    win.requestAnimationFrame = callback => { frames.set(++frameId, callback); return frameId; };
    win.cancelAnimationFrame = id => { frames.delete(id); };
    const provider = providerQueue(); let f;
    try {
      f = await fixture(provider.request, tablet);
      const historySelect = async id => {
        f.click("历史对话");
        const row = [...f.root.querySelectorAll(".em-sheet .em-session-row")].find(item => item.dataset.sessionId === id);
        assert.ok(row, "history contains the requested task"); row.click();
        await until(() => f.store.session.id === id && !f.root.querySelector('[role="dialog"]'), "history selection renders the requested task");
      };
      const a = f.store.session.id; await f.send("保持运行的历史任务A"); await until(() => provider.calls.length === 1, "A Provider is pending");
      const firstTarget = f.runtime.composerScrollTarget(a); assert.ok(firstTarget); assert.ok(frames.size > 0);
      f.click("新对话"); await until(() => f.store.session.id !== a && !f.root.querySelector(".em-user-message"), "new-chat click renders an empty task B");
      const b = f.store.session.id;
      assert.equal(f.runtime.isBusy(a), true); assert.equal(f.runtime.composerScrollTarget(a), undefined, "new-chat click clears A's unused scroll target");
      await historySelect(a); f.runtime.onChange();
      assert.equal(f.runtime.isBusy(a), true); assert.equal(f.runtime.composerScrollTarget(a), undefined, "returning to running A cannot re-arm auto positioning");
      assert.ok(f.root.querySelector(".em-messages").textContent.includes("保持运行的历史任务A"));

      await historySelect(b); await f.send("保持运行的历史任务B"); await until(() => provider.calls.length === 2, "B Provider is pending");
      assert.ok(f.runtime.composerScrollTarget(b));
      await historySelect(a);
      assert.equal(f.runtime.isBusy(b), true); assert.equal(f.runtime.composerScrollTarget(b), undefined, "history click clears B's unused scroll target");
      await historySelect(b); f.runtime.onChange();
      assert.equal(f.runtime.composerScrollTarget(b), undefined, "returning to running B does not recreate scrolling");

      provider.calls[0].resolve(answer("openai-completions", "A第一轮结束")); await until(() => !f.runtime.isBusy(a), "A completes in the background");
      await historySelect(a); await f.send("A新的主动发送"); await until(() => provider.calls.length === 3, "A's fresh turn reaches Provider");
      assert.ok(f.runtime.composerScrollTarget(a).sequence > firstTarget.sequence, "a fresh explicit send can start its own scrolling");
      await historySelect(b); assert.equal(f.runtime.composerScrollTarget(a), undefined, "history A-to-B also clears A's fresh target");
      await historySelect(a); f.runtime.onChange();
      assert.equal(f.runtime.isBusy(a), true); assert.equal(f.runtime.composerScrollTarget(a), undefined); assert.equal(provider.calls.length, 3);
    } finally {
      provider.calls.forEach(call => call.resolve(answer("openai-completions", "teardown")));
      if (f) await f.close(); win.requestAnimationFrame = requestFrame; win.cancelAnimationFrame = cancelFrame;
    }
  });

  for (const tablet of [false, true]) await test(`${tablet ? "iPad" : "iPhone"} returning to a preparing task retains its pending message and active steps without restoring auto scrolling`, async () => {
    let release, preparing = false;
    const preparation = new Promise(resolve => { release = resolve; });
    const provider = providerQueue();
    const f = await fixture(provider.request, tablet, undefined, async (_taskId, _turn, report) => {
      report({ stage: "judgment", status: "active" }); preparing = true; await preparation; return "";
    });
    try {
      const a = f.store.session.id, question = "准备中离开后仍应保留的消息";
      const input = f.root.querySelector(".em-input"); input.value = question; input.dispatchEvent(new win.Event("input"));
      await f.store.flush(); f.click("发送消息"); await until(() => preparing, "A is held in real context preparation");
      const target = f.runtime.composerScrollTarget(a); assert.ok(target); assert.equal(provider.calls.length, 0);
      assert.equal(f.root.querySelector(".echoink-submission-text").textContent, question);
      assert.equal(f.runtime.composerSubmissions.records.get(target.turnId).phase, "preparing");

      f.click("新对话"); await until(() => f.store.session.id !== a && !f.root.querySelector(".echoink-submission-text"), "new chat leaves the preparing task");
      assert.equal(f.runtime.composerScrollTarget(a), undefined); assert.equal(f.runtime.isBusy(a), true);
      f.click("历史对话");
      const row = [...f.root.querySelectorAll(".em-sheet .em-session-row")].find(item => item.dataset.sessionId === a);
      assert.ok(row); row.click(); await until(() => f.store.session.id === a && !f.root.querySelector('[role="dialog"]'), "history returns to preparing A");
      f.runtime.onChange();
      assert.equal(f.runtime.composerScrollTarget(a), undefined, "rendering preparation cannot re-arm scrolling");
      assert.equal(f.root.querySelector(".echoink-submission-text")?.textContent, question, "the running submission remains visible after its scroll target is cleared");
      const active = f.root.querySelector('.echoink-submission-step.is-running[data-preparation-stage="judgment"]');
      assert.ok(active); assert.ok(active.textContent.includes("智能判断中"));
      assert.equal(f.store.getSession(a).messages.length, 0); assert.equal(provider.calls.length, 0);

      release(); await until(() => provider.calls.length === 1, "A is admitted after preparation is released");
      assert.equal(f.root.querySelectorAll(".echoink-submission-text").length, 0);
      assert.equal(f.store.getSession(a).messages.filter(message => message.role === "user").length, 1);
      assert.equal(f.root.querySelectorAll(".em-user-message").length, 1); assert.equal(f.root.querySelector(".em-user-message").textContent, question);
      assert.equal(f.runtime.composerScrollTarget(a), undefined, "formal admission does not restore a cleared target");
      provider.calls[0].resolve(answer("openai-completions", "离开后继续完成")); await until(() => !f.runtime.isBusy(a), "A completes normally");
      assert.ok(f.root.querySelector(".em-messages").textContent.includes("离开后继续完成"));
      assert.equal(f.store.getSession(a).messages.filter(message => message.role === "user").length, 1);
    } finally { release(); provider.calls.forEach(call => call.resolve(answer("openai-completions", "teardown"))); await f.close(); }
  });

  await test("unmount/remount and a second subscriber do not own or stop execution", async () => {
    const provider = providerQueue(); const f = await fixture(provider.request, true);
    try {
      const task = f.store.session.id; await f.send("关闭页面仍运行"); await until(() => provider.calls.length === 1, "provider started");
      const other = f.mount(); other.ui.destroy();
      f.ui.destroy(); assert.equal(f.runtime.isBusy(task), true);
      const reopened = f.mount(); assert.ok(reopened.root.querySelector(".em-task-stop"));
      provider.calls[0].resolve(answer("openai-completions", "关闭后完成")); await until(() => !f.runtime.isBusy(task), "run completes without first UI");
      assert.ok(reopened.root.querySelector(".em-messages").textContent.includes("关闭后完成"));
      assert.equal(provider.calls.length, 1);
    } finally { await f.close(); }
  });

  await test("same-task supplementation queues, stopping A keeps B running and pauses only A queue", async () => {
    const provider = providerQueue(); const f = await fixture(provider.request);
    try {
      const a = f.store.session.id; await f.send("A第一条"); await until(() => provider.calls.length === 1, "A starts");
      const input = await f.send("A补充队列"); await until(() => f.runtime.stateFor(a).queuedCount === 1, "A queue saved");
      assert.equal(f.store.getSession(a).draft, ""); assert.equal(input.value, ""); assert.ok(f.root.querySelector(".em-status").textContent.includes("排队1条"));
      assert.equal(f.root.querySelector(".em-task-stop").hidden, false); assert.equal(provider.calls.length, 1);
      const b = await f.store.createSession("agent-b"); f.runtime.onChange(); await f.send("B第一条"); await until(() => provider.calls.length === 2, "B starts separately");
      await f.select(a); input.value = "停止时仍有输入"; input.dispatchEvent(new win.Event("input")); await f.store.flush();
      f.click("停止回答"); await until(() => !f.runtime.isBusy(a), "A stopped");
      assert.equal(f.runtime.isBusy(b.id), true); assert.equal(f.runtime.stateFor(a).paused, true); assert.equal(f.runtime.stateFor(a).queuedCount, 1);
      assert.ok(f.root.querySelector(".em-status").textContent.includes("已暂停1条")); assert.equal(input.value, "停止时仍有输入"); assert.equal(f.root.querySelector(".em-task-stop").hidden, true);
      provider.calls[1].resolve(answer("openai-completions", "B照常完成")); await until(() => !f.runtime.isBusy(b.id), "B unaffected by A stop"); assert.equal(provider.calls.length, 2);
    } finally { await f.close(); }
  });

  await test("background completion failure remains scoped to its task and never restores accepted input", async () => {
    const provider = providerQueue(); const f = await fixture(provider.request);
    try {
      const a = f.store.session.id; await f.send("A已受理问题"); await until(() => provider.calls.length === 1, "A request");
      const b = await f.store.createSession("agent-b"); f.runtime.onChange();
      provider.calls[0].reject(new Error("A_PROVIDER_FAILED")); await until(() => !f.runtime.isBusy(a), "A failure settles");
      assert.equal(f.store.getSession(a).draft, ""); assert.equal(f.root.querySelector(".em-input").value, ""); assert.equal(f.root.querySelector(".em-error").textContent.includes("模型服务未正常响应"), false);
      assert.equal(f.store.session.id, b.id); await f.select(a); assert.ok(f.root.querySelector(".em-error").textContent.includes("模型服务未正常响应")); assert.equal(f.root.querySelector(".em-input").value, "");
    } finally { await f.close(); }
  });

  await test("draft-save failure keeps one failed bubble and edit restores it only after saving recovers", async () => {
    let calls = 0; const f = await fixture(async () => { calls++; return answer("openai-completions", "retry accepted"); });
    const write = f.adapter.write.bind(f.adapter); let fail = true;
    f.adapter.write = async (path, value) => { if (fail) throw new Error("DRAFT_FAILED"); return write(path, value); };
    try {
      const input = f.root.querySelector(".em-input"); input.value = "保存失败的未受理输入"; f.click("发送消息");
      await until(() => f.root.querySelector(".echoink-submission-error"), "failed bubble visible");
      assert.equal(calls, 0); assert.equal(f.root.querySelector(".echoink-submission-text").textContent, "保存失败的未受理输入");
      assert.equal(input.value, ""); assert.equal(f.runtime.composerSubmissions.records.size, 1);
      fail = false; f.click("编辑"); await until(() => input.value === "保存失败的未受理输入", "edit restores the snapshot");
      assert.equal(f.root.querySelectorAll(".echoink-submission").length, 0);
      f.click("发送消息"); await until(() => calls === 1 && !f.runtime.busy, "explicit resend reaches provider once");
      assert.equal(input.value, ""); assert.equal(f.store.session.messages.filter(message => message.role === "user").length, 1);
    } finally { f.adapter.write = write; await f.close(); }
  });

  await test("accepted result-save failure shows the task error without returning its question to the composer", async () => {
    let calls = 0; const f = await fixture(async () => { calls++; return answer("openai-completions", "已受理的回答"); });
    const write = f.adapter.write.bind(f.adapter); let failed = false;
    f.adapter.write = async (path, value) => {
      if (!failed && JSON.parse(value).sessions.some(task => task.messages.some(message => message.role === "assistant"))) { failed = true; throw new Error("RESULT_SAVE_FAILED"); }
      return write(path, value);
    };
    try {
      const input = f.root.querySelector(".em-input"); input.value = "已受理的问题"; f.click("发送消息");
      await until(() => calls === 1 && !f.runtime.busy && f.root.querySelector(".em-error").textContent.includes("内容已保留") && !f.root.querySelector(".em-error").textContent.includes("RESULT_SAVE_FAILED"), "accepted persistence error visible in plain words");
      assert.equal(failed, true); assert.equal(f.root.querySelector(".em-input"), input); assert.equal(input.value, ""); assert.equal(f.store.session.draft, "");
      assert.equal(f.store.session.messages.filter(message => message.role === "user").length, 1);
    } finally { f.adapter.write = write; await f.close(); }
  });

  for (const tablet of [false, true]) await test(`${tablet ? "iPad" : "iPhone"} live revocation shows a handled task error and the same task resumes`, async () => {
    const provider = providerQueue(); const f = await fixture(provider.request, tablet);
    try {
      const id = f.store.session.id; await f.send("撤权前受理的问题"); await until(() => provider.calls.length === 1, "request admitted");
      await f.store.setMemoryEnabled(false); provider.calls[0].resolve(answer("openai-completions", "late answer"));
      await until(() => !f.runtime.isBusy(id) && /权限|资源/u.test(f.root.querySelector(".em-error").textContent), "real task interruption is visible");
      assert.equal(f.store.getSession(id).taskStatus, "interrupted"); assert.equal(f.store.getSession(id).queuePaused, true);
      assert.equal(f.store.getSession(id).messages.filter(message => message.role === "user").length, 1);
      assert.equal(f.root.querySelector(".em-input").value, "");
      await f.store.setMemoryEnabled(true); await f.send("核对后继续"); await until(() => provider.calls.length === 2, "same task resumed");
      provider.calls[1].resolve(answer("openai-completions", "恢复完成"));
      await until(() => !f.runtime.isBusy(id) && f.store.getSession(id).taskStatus === "completed", "resumed task completes");
      assert.equal(f.store.session.id, id); assert.equal(f.root.querySelector(".em-error").textContent, "");
    } finally { for (const call of provider.calls) call.resolve(answer("openai-completions", "teardown")); await f.close(); }
  });

  const questionProvider = async request => {
    const body = JSON.parse(request.body);
    if (body.messages.at(-1)?.role === "tool") return answer("openai-completions", "收到真实选择");
    return answer("openai-completions", "", [["synthetic-question-call", "user_question", { questions: prompts }]]);
  };
  for (const tablet of [false, true]) await test(`${tablet ? "iPad" : "iPhone"} question sheet closes without answering, retains selection and submits real answers once`, async () => {
    const f = await fixture(questionProvider, tablet);
    try {
      const id = f.store.session.id; await f.send("请给我问题");
      await until(() => f.runtime.stateFor(id).interaction?.status === "pending", "question persisted");
      assert.equal(f.root.querySelector('[role="dialog"]'), null); f.click("等你回应");
      const option = f.root.querySelector('[data-option-id="team"]'); option.click(); f.root.querySelector('[data-option-id="note"]').click();
      const supplement = f.root.querySelector(".em-task-supplement"); supplement.value = "补充原文"; supplement.dispatchEvent(new win.Event("input"));
      f.click("关闭弹层"); assert.equal(f.runtime.stateFor(id).interaction.status, "pending"); assert.equal(f.runtime.isBusy(id), true);
      f.click("等你回应"); assert.equal(f.root.querySelector('[data-option-id="team"]').getAttribute("aria-pressed"), "true"); assert.equal(f.root.querySelector('[data-option-id="note"]').getAttribute("aria-checked"), "true"); assert.equal(f.root.querySelector(".em-task-supplement").value, "补充原文");
      const actions = f.root.querySelector(".em-task-question-actions"); assert.equal(actions.parentElement.className, "em-sheet"); assert.equal(actions.lastElementChild.textContent, "提交回答");
      const write = f.adapter.write.bind(f.adapter); let release; let entered; const began = new Promise(resolve => { entered = resolve; }); let held = false;
      f.adapter.write = async (path, value) => {
        if (!held && JSON.parse(value).sessions.some(task => task.interaction?.status === "answered")) { held = true; entered(); await new Promise(resolve => { release = resolve; }); }
        return write(path, value);
      };
      const submit = f.click("提交回答"); await began; submit.click(); assert.equal(submit.disabled, true); assert.equal(f.root.querySelector(".em-task-supplement").disabled, true);
      f.click("关闭弹层"); f.click("等你回应"); assert.equal(f.root.querySelector(".em-task-question-submit").disabled, true); release();
      await until(() => !f.runtime.isBusy(id), "answered run completes");
      const interaction = f.store.getSession(id).interaction; assert.equal(interaction.status, "answered");
      assert.deepEqual(structuredClone(interaction.answers), [{ questionId: "destination", selectedOptionIds: ["team"], supplement: "补充原文" }, { questionId: "channels", selectedOptionIds: ["note"] }]);
      assert.equal(f.root.querySelector('[role="dialog"]'), null); assert.ok(f.store.getSession(id).messages.some(message => message.role === "assistant" && text(message).includes("收到真实选择")));
    } finally { await f.close(); }
  });

  await test("switching away from a pending question closes only its sheet and never opens it in another task", async () => {
    const f = await fixture(questionProvider, true);
    try {
      const a = f.store.session.id; await f.send("A待选择"); await until(() => f.runtime.stateFor(a).interaction?.status === "pending", "A waiting");
      f.click("等你回应"); f.root.querySelector('[data-option-id="team"]').click();
      const b = await f.store.createSession("agent-b"); f.runtime.onChange();
      assert.equal(f.root.querySelector('[role="dialog"]'), null); assert.equal(f.root.querySelector(".em-task-question-entry"), null);
      assert.equal(f.runtime.stateFor(a).interaction.status, "pending"); assert.equal(f.runtime.isBusy(a), true); assert.equal(f.runtime.isBusy(b.id), false);
      await f.select(a); assert.equal(f.root.querySelector('[role="dialog"]'), null); f.click("等你回应");
      assert.equal(f.root.querySelector('[data-option-id="team"]').getAttribute("aria-pressed"), "true");
    } finally { await f.close(); }
  });

  await test("question save failure retains answers and stale task/run/question refuses late submission", async () => {
    const f = await fixture(questionProvider);
    const write = f.adapter.write.bind(f.adapter);
    try {
      const a = f.store.session.id; await f.send("保存失败问题"); await until(() => f.runtime.stateFor(a).interaction?.status === "pending", "pending question");
      f.click("等你回应"); f.root.querySelector('[data-option-id="self"]').click(); f.root.querySelector('[data-option-id="chat"]').click();
      let failed = false;
      f.adapter.write = async (path, value) => { if (!failed && JSON.parse(value).sessions.some(task => task.interaction?.status === "answered")) { failed = true; throw new Error("ANSWER_SAVE_FAILED"); } return write(path, value); };
      f.click("提交回答"); await until(() => f.root.querySelector(".em-sheet-error").textContent.includes("本次操作未完成"), "answer persistence error");
      assert.equal(f.root.querySelector('[data-option-id="self"]').getAttribute("aria-pressed"), "true"); assert.equal(f.runtime.stateFor(a).interaction.status, "pending");
      f.adapter.write = write;
      await f.runtime.stopTask(a); f.click("提交回答"); await until(() => f.root.querySelector(".em-sheet-error").textContent.includes("过期"), "stale IDs rejected");
      assert.equal(f.root.querySelector('[data-option-id="self"]').getAttribute("aria-pressed"), "true"); assert.equal(f.store.getSession(a).interaction.status, "cancelled");
      const b = await f.store.createSession("agent-b"); f.runtime.onChange(); assert.equal(f.root.querySelector('[role="dialog"]'), null); assert.equal(f.store.session.id, b.id); assert.equal(f.root.querySelector(".em-task-question-entry"), null);
    } finally { f.adapter.write = write; await f.close(); }
  });

  await test("archive stops its captured task before mutation while another task keeps running; restore does not resume", async () => {
    const provider = providerQueue(); const f = await fixture(provider.request);
    try {
      const a = f.store.session.id; await f.send("待归档A"); await until(() => provider.calls.length === 1, "A running");
      const b = await f.store.createSession("agent-b"); f.runtime.onChange(); await f.send("B保持运行"); await until(() => provider.calls.length === 2, "B running");
      await f.select(a); f.ui.showPage("review"); f.click("归档当前会话"); await until(() => !!f.store.getSession(a).archivedAt, "A archive committed after stop");
      assert.equal(f.runtime.isBusy(a), false); assert.equal(f.runtime.isBusy(b.id), true);
      f.root.querySelector(".em-archive").open = true; f.root.querySelector(".em-archive").dispatchEvent(new win.Event("toggle")); f.click("恢复会话"); await until(() => f.store.session.id === a && !f.store.getSession(a).archivedAt, "restored A history");
      assert.equal(f.runtime.isBusy(a), false); assert.equal(f.runtime.isBusy(b.id), true); assert.equal(provider.calls.length, 2);
    } finally { await f.close(); }
  });

  await test("task model selection replaces old draft context, stays bound to the opened task and leaves the global default intact", async () => {
    const calls = []; const f = await fixture(async request => { calls.push(JSON.parse(request.body)); return answer("openai-completions", "任务模型已使用"); });
    try {
      const a = f.store.session.id; const settingsBefore = { provider: f.config.activeApiProviderId, model: f.config.defaultModel };
      const alternate = mobileProvider("deepseek"); Object.assign(alternate, { name: "Alternate", apiKey: "synthetic-alternate", baseUrl: "https://alternate.example/v1",
        models: [mobileModel("task-model-old"), mobileModel("task-model-new")], defaultModelId: "task-model-old" });
      f.config.apiProviders.push(alternate);
      await f.store.patchSession(a, { draftContext: { attachments: [], selectedProviderSettingsId: alternate.id, selectedModel: "task-model-old" } }); f.ui.refreshSettings();
      assert.equal(f.root.querySelector(".em-model-label").textContent, "task-model-old"); assert.ok(f.root.querySelector(".em-brand svg"));
      f.click("选择模型"); assert.equal([...f.root.querySelectorAll(".em-sheet .em-row")].find(row => row.querySelector("strong")?.textContent === "task-model-old").getAttribute("aria-pressed"), "true");
      const b = await f.store.createSession("agent-b"); await f.store.patchSession(b.id, { draftContext: { attachments: [], selectedModel: "synthetic-model" } }); const bBefore = f.store.getSession(b.id).draftContext; f.runtime.onChange();
      [...f.root.querySelectorAll(".em-sheet .em-row")].find(row => row.querySelector("strong")?.textContent === "task-model-new").click(); await f.store.flush(); await settle();
      assert.equal(f.store.getSession(a).draftContext.selectedModel, "task-model-new"); assert.equal(f.store.getSession(a).draftContext.selectedProviderSettingsId, alternate.id);
      assert.deepEqual(f.store.getSession(b.id).draftContext, bBefore); assert.equal(f.config.activeApiProviderId, settingsBefore.provider); assert.equal(f.config.defaultModel, settingsBefore.model);
      assert.equal(f.root.querySelector(".em-model-label").textContent, "synthetic-model"); await f.select(a); assert.equal(f.root.querySelector(".em-model-label").textContent, "task-model-new");
      await f.send("使用任务自己的新模型"); await until(() => calls.length === 1 && !f.runtime.isBusy(a), "task-selected model request completes");
      assert.equal(calls[0].model, "task-model-new"); assert.equal(f.store.getSession(a).runs.at(-1).providerId, alternate.id);
    } finally { await f.close(); }
  });

  await test("an explicit missing task provider or model shows no global fallback and keeps input until corrected", async () => {
    let calls = 0; const f = await fixture(async () => { calls++; return answer("openai-completions", "corrected"); });
    try {
      const a = f.store.session.id;
      for (const draftContext of [{ attachments: [], selectedProviderSettingsId: "missing-provider" }, { attachments: [], selectedModel: "missing-model" }]) {
        await f.store.patchSession(a, { draftContext }); f.ui.refreshSettings();
        assert.equal(f.root.querySelector(".em-model-label").textContent, "配置模型"); assert.equal(f.root.querySelector(".em-model .em-brand"), null);
        await f.send("无效选择保留输入"); await until(() => f.root.querySelector(".echoink-submission-error")?.textContent.includes("已被删除"), "explicit invalid selection rejected");
        assert.equal(calls, 0); assert.equal(f.root.querySelector(".em-input").value, "");
        f.click("编辑"); await until(() => f.root.querySelector(".em-input").value === "无效选择保留输入", "edit retains the original selection");
      }
      f.click("选择模型"); const globalModelRow = [...f.root.querySelectorAll(".em-sheet .em-row")].find(row => row.querySelector("strong")?.textContent === "synthetic-model");
      assert.equal(globalModelRow.getAttribute("aria-pressed"), "false"); globalModelRow.click(); await f.store.flush(); await settle();
      assert.equal(f.root.querySelector(".em-model-label").textContent, "synthetic-model"); assert.deepEqual(f.store.getSession(a).draftContext.attachments, []);
      f.click("发送消息"); await until(() => calls === 1 && !f.runtime.isBusy(a), "corrected selection can be sent");
    } finally { await f.close(); }
  });

  await test("note selection and removal atomically replace legacy mention metadata on the captured task only", async () => {
    const calls = []; const f = await fixture(async request => { calls.push(JSON.parse(request.body)); return answer("openai-completions", "引用已使用"); });
    try {
      const a = f.store.session.id; await f.adapter.write("笔记/来源.md", "完全虚构的新引用原文");
      await f.store.patchSession(a, { notePath: "旧字段.md", draftContext: { attachments: [], noteMentions: [{ vaultRelativePath: "旧元数据.md", fileName: "旧元数据" }] } }); f.ui.refreshSettings();
      assert.ok(f.root.querySelector(".em-context").textContent.includes("旧元数据.md")); f.click("引用笔记");
      const b = await f.store.createSession("agent-b"); await f.store.patchSession(b.id, { notePath: "乙.md", draftContext: { attachments: [], noteMentions: [] } }); const bBefore = f.store.getSession(b.id); f.runtime.onChange();
      [...f.root.querySelectorAll(".em-sheet .em-row")].find(row => row.querySelector("strong")?.textContent === "当前笔记").click(); await f.store.flush(); await settle();
      assert.equal(f.store.getSession(a).notePath, "笔记/来源.md"); assert.equal(f.store.getSession(a).draftContext.noteMentions, undefined); assert.deepEqual(f.store.getSession(b.id), bBefore);
      await f.select(a); await f.send("使用刚选的新引用"); await until(() => calls.length === 1 && !f.runtime.isBusy(a), "new reference reaches run"); assert.equal(f.store.getSession(a).runs.at(-1).notePath, "笔记/来源.md");
      await f.store.updateSession(a, session => { session.draftContext.noteMentions = [{ vaultRelativePath: "又一旧引用.md", fileName: "又一旧引用" }]; });
      // Re-enter the view through the real settings refresh to display the effective reference.
      f.ui.showPage("review"); f.ui.showChat(); assert.ok(f.root.querySelector(".em-context").textContent.includes("又一旧引用.md"));
      f.click("移除笔记引用"); await f.store.flush(); await settle(); assert.equal(f.store.getSession(a).notePath, ""); assert.equal(f.store.getSession(a).draftContext.noteMentions, undefined);
      await f.send("不带旧引用发送"); await until(() => calls.length === 2 && !f.runtime.isBusy(a), "removed reference stays removed in run"); assert.equal(f.store.getSession(a).runs.at(-1).notePath, ""); assert.deepEqual(f.store.getSession(b.id), bBefore);
    } finally { await f.close(); }
  });

  await test("Skill use clears the old selectedSkill override and affects only the task captured by its sheet", async () => {
    const chosen = { id: "synthetic-new-skill", kind: "skill", source: "echoink-local", name: "新的虚构 Skill", description: "合成说明", enabled: true, bridgeMode: "prompt-only" };
    const previous = { ...chosen, id: "synthetic-old-skill", name: "旧的虚构 Skill" };
    const services = { subscribeIdentity() { return () => {}; }, plugins() { return []; }, skills() { return [chosen]; }, async requireAvailableEchoInkSkill(id) { assert.equal(id, chosen.id); return "虚构 Skill 正文"; } };
    const calls = []; const f = await fixture(async request => { calls.push(JSON.parse(request.body)); return answer("openai-completions", "Skill已使用"); }, false, services);
    try {
      f.config.resources.catalog.push(chosen, previous);
      const a = f.store.session.id; await f.store.patchSession(a, { skillId: previous.id, draftContext: { attachments: [], selectedSkill: previous } });
      f.ui.showPage("resources"); f.click("Skills"); [...f.root.querySelectorAll(".em-row")].find(row => row.querySelector("strong")?.textContent === chosen.name).click();
      const b = await f.store.createSession("agent-b"); await f.store.patchSession(b.id, { skillId: previous.id, draftContext: { attachments: [], selectedSkill: previous } }); const bBefore = f.store.getSession(b.id); f.runtime.onChange();
      f.click("在对话中使用"); await f.store.flush(); await settle();
      assert.equal(f.store.getSession(a).skillId, chosen.id); assert.equal(f.store.getSession(a).draftContext.selectedSkill, undefined); assert.deepEqual(f.store.getSession(b.id), bBefore);
      await f.select(a); await f.send("用新Skill发送"); await until(() => calls.length === 1 && !f.runtime.isBusy(a), "new Skill reaches run"); assert.equal(f.store.getSession(a).runs.at(-1).skillId, chosen.id);
    } finally { await f.close(); }
  });

  await test("global permission changes update only the captured task override and never remove plan read-only mode", async () => {
    const calls = []; const f = await fixture(async request => { calls.push(JSON.parse(request.body)); return answer("openai-completions", "计划模式请求"); });
    try {
      const a = f.store.session.id; await f.store.patchSession(a, { draftContext: { attachments: [], selectedMode: "plan", selectedPermission: "danger-full-access" } }); f.ui.refreshSettings();
      assert.ok(f.root.querySelector('[aria-label="工作区权限：只读"]'));
      f.click("工作区权限：只读"); const b = await f.store.createSession("agent-b"); await f.store.patchSession(b.id, { draftContext: { attachments: [], selectedPermission: "workspace-write" } }); const bBefore = f.store.getSession(b.id).draftContext; f.runtime.onChange();
      [...f.root.querySelectorAll(".em-sheet .em-row")].find(row => row.querySelector("strong")?.textContent === "完全访问权限").click(); await f.store.flush(); await settle();
      assert.equal(f.store.state.permission, "full-access"); assert.equal(f.store.getSession(a).draftContext.selectedPermission, "danger-full-access"); assert.equal(f.store.getSession(a).draftContext.selectedMode, "plan"); assert.deepEqual(f.store.getSession(b.id).draftContext, bBefore);
      await f.select(a); assert.ok(f.root.querySelector('[aria-label="工作区权限：只读"]'));
      await f.send("按plan只读发送"); await until(() => calls.length === 1 && !f.runtime.isBusy(a), "plan request completes"); assert.equal(f.store.getSession(a).runs.at(-1).permission, "read-only");
      f.click("工作区权限：只读"); [...f.root.querySelectorAll(".em-sheet .em-row")].find(row => row.querySelector("strong")?.textContent === "只读").click(); await f.store.flush(); await settle();
      assert.equal(f.store.state.permission, "read-only"); await f.select(b.id); assert.ok(f.root.querySelector('[aria-label="工作区权限：只读"]')); assert.deepEqual(f.store.getSession(b.id).draftContext, bBefore);
    } finally { await f.close(); }
  });

  for (const tablet of [false, true]) await test(`${tablet ? "iPad" : "iPhone"} actual Runtime continues the original interrupted task once and clears only accepted input`, async () => {
    let requests = 0; const f = await fixture(async () => { requests++; return answer("openai-completions", "原任务继续完成"); }, tablet);
    try {
      await f.runtime.initialize(); const id = f.store.session.id;
      const interruption = { at: 1792454400123, reason: "app_backgrounded", stage: "等待模型" };
      await f.store.patchSession(id, { messages: [{ role: "user", content: "原任务正文", timestamp: 1 }], taskStatus: "interrupted", interruption, taskInterruptedAt: interruption.at, draft: "用户保留的补充" }); f.runtime.onChange();
      const input = f.root.querySelector(".em-input"); const continueButton = f.click("从这里继续"); continueButton.click();
      await until(() => requests === 1 && !f.runtime.isBusy(id) && !f.runtime.stateFor(id).resuming, "one resumed run completes");
      assert.equal(f.store.session.id, id); assert.equal(f.store.getSession(id).runs.length, 1); assert.equal(f.store.getSession(id).taskStatus, "completed");
      assert.equal(f.root.querySelector(".em-input"), input); assert.equal(input.value, ""); assert.equal(f.store.getSession(id).draft, "");
      assert.ok(f.store.getSession(id).messages.some(message => message.role === "user" && text(message) === "用户保留的补充"));
    } finally { await f.close(); }
  });

  for (const tablet of [false, true]) await test(`${tablet ? "iPad" : "iPhone"} actual Runtime requires S5 facts, rejects a changed target fingerprint and keeps the original input`, async () => {
    let requests = 0; const f = await fixture(async () => { requests++; return answer("openai-completions", "基于现状完成"); }, tablet);
    try {
      await f.runtime.initialize(); const id = f.store.session.id; const target = "测试/核对原目标.md"; await f.adapter.write(target, "首次核对的既有内容");
      const interruption = { at: 1792454400123, reason: "process_unknown", stage: "执行工具" };
      const oldAssistant = { role: "assistant", content: [{ type: "toolCall", id: "old-private-tool-id", name: "note_create", arguments: { path: target, content: "旧拟写入正文" } }],
        api: "openai-completions", provider: "synthetic", model: "synthetic-model", stopReason: "toolUse", timestamp: 2,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      await f.store.patchSession(id, { messages: [{ role: "user", content: "旧任务原文", timestamp: 1 }, oldAssistant], taskStatus: "interrupted", interruption, taskInterruptedAt: interruption.at, draft: "核对前保留的输入" }); f.runtime.onChange();
      const input = f.root.querySelector(".em-input");
      if (tablet) await f.send("核对前保留的输入"); else f.click("从这里继续");
      await until(() => !!f.root.querySelector(".em-task-resume-review"), "actual S5 review from continue or interrupted submit");
      assert.equal(requests, 0); assert.ok(f.root.querySelector(".em-task-resume-review").textContent.includes(target)); assert.equal(f.root.querySelector('[role="dialog"]').textContent.includes("old-private-tool-id"), false);
      f.click("关闭弹层"); await until(() => !f.runtime.stateFor(id).resumeReview && input.value === "核对前保留的输入", "close clears review and restores the unaccepted snapshot"); assert.equal(requests, 0);
      f.click("从这里继续"); await until(() => !!f.runtime.stateFor(id).resumeReview && !!f.root.querySelector(".em-task-resume-review"), "review can be reopened after cancel");
      const firstFingerprint = f.runtime.stateFor(id).resumeReview.fingerprint; f.files.set(target, "核对期间外部变更后的内容");
      f.click("我已核对，请基于现状继续"); await until(() => f.runtime.stateFor(id).resumeReview?.fingerprint !== firstFingerprint && !!f.root.querySelector(".em-task-resume-review"), "changed target requires a fresh fingerprint");
      assert.equal(requests, 0); assert.equal(input.value, "核对前保留的输入"); assert.equal(f.store.getSession(id).draft, "核对前保留的输入");
      f.click("我已核对，请基于现状继续"); await until(() => requests === 1 && !f.runtime.isBusy(id) && !f.runtime.stateFor(id).resuming, "matching rechecked facts admit once");
      assert.equal(f.files.get(target), "核对期间外部变更后的内容"); assert.equal(f.root.querySelector('[role="dialog"]'), null); assert.equal(f.store.getSession(id).runs.length, 1); assert.equal(input.value, "");
    } finally { await f.close(); }
  });

  await test("actual Runtime cancellation during resume target read preserves A draft and never stops the running B task", async () => {
    const provider = providerQueue(); const f = await fixture(provider.request, true);
    const read = f.adapter.read.bind(f.adapter); let releaseRead;
    const blocked = new Promise(resolve => { releaseRead = resolve; }); let held = false;
    try {
      await f.runtime.initialize(); const a = f.store.session.id; const target = "测试/准备期间核对.md"; await f.adapter.write(target, "现有目标");
      const interruption = { at: 1792454400123, reason: "app_backgrounded", stage: "执行工具" };
      await f.store.patchSession(a, { messages: [{ role: "user", content: "原任务", timestamp: 1 }, { role: "assistant", content: [{ type: "toolCall", id: "old-create", name: "note_create", arguments: { path: target, content: "原写入" } }], timestamp: 2 }],
        taskStatus: "interrupted", interruption, taskInterruptedAt: interruption.at, draft: "A准备取消仍保留" }); f.runtime.onChange();
      f.adapter.read = async path => { if (path === target && !held) { held = true; await blocked; } return read(path); };
      f.click("从这里继续"); await until(() => held, "A reads its target during preparation");
      assert.equal(f.runtime.stateFor(a).resuming, true);
      const b = await f.store.createSession("agent-b"); f.runtime.onChange(); await f.send("B独立保持运行"); await until(() => provider.calls.length === 1, "B starts while A prepares");
      assert.equal(f.runtime.stateFor(a).resuming, true); assert.equal(f.root.querySelector(".em-task-interruption"), null);
      await f.select(a); f.click("取消继续"); releaseRead();
      await until(() => !f.runtime.stateFor(a).resuming && !f.root.querySelector(".em-task-resume-button").disabled, "A cancellation finishes after its read settles");
      assert.equal(f.store.getSession(a).draft, "A准备取消仍保留"); assert.equal(f.store.getSession(a).taskStatus, "interrupted"); assert.equal(f.runtime.isBusy(b.id), true); assert.equal(provider.calls.length, 1); assert.equal(f.root.querySelector('[role="dialog"]'), null);
    } finally { releaseRead(); f.adapter.read = read; await f.close(); }
  });

  const realRuntimeScenarios = passed;
  await runMobileTaskResumeUIScenarios(test, fixture, until);
  console.log(`Mobile task UI: ${realRuntimeScenarios} real-Runtime/synthetic-Provider and ${passed - realRuntimeScenarios} isolated resume-UI contract scenarios passed; browser and native visuals remain separate.`);
}
