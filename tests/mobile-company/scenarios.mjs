import { mainFlows } from "./main-flows.mjs";
import assert from "node:assert/strict";
import { createHost, answer } from "../mobile/host.mjs";

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const waitFor = async (check, label = "condition") => { const end = Date.now() + 6_000; while (!check()) { if (Date.now() > end) throw new Error(`${label} timed out`); await tick(); } };
const textOf = item => typeof item.content === "string" ? item.content : (item.content ?? []).filter(part => part.type === "text").map(part => part.text).join("\n");

/** A scripted model: the system prompt says which card is asking, the transcript says which step it is on. */
function scriptedModel(steps) {
  const calls = [];
  const request = async raw => {
    const body = JSON.parse(raw.body); const system = textOf(body.messages[0]);
    const role = system.includes("<echoink_company_router") ? "router" : system.includes("<echoink_company_worker") ? "worker" : "plain";
    const last = body.messages.at(-1); const lastUser = [...body.messages].reverse().find(item => item.role === "user");
    calls.push({ role, last: last.role, user: textOf(lastUser), system, tools: (body.tools ?? []).map(tool => tool.function?.name ?? tool.name) });
    if (last.role === "tool") return answer("openai-completions", steps.after?.(role, textOf(lastUser)) ?? "好的。");
    const step = steps.on(role, textOf(lastUser), calls.length);
    if (step?.[0] === "task_dispatch") step[1].moduleId ??= "none";
    if (step?.[0] === "project_propose") step[1].plan.forEach(task => task.moduleId ??= "none");
    return step ? answer("openai-completions", "", [[`call-${calls.length}`, step[0], step[1]]]) : answer("openai-completions", steps.reply?.(role, textOf(lastUser)) ?? "好的。");
  };
  return { request, calls };
}

export async function companyScenarios({ MobileRuntime, MobileStore, loadMobileSettings, mobileProvider, mobileModel, startMobileCompany }) {
  let passed = 0;
  const test = async (name, run) => { await run(); console.log(`ok ${++passed} - ${name}`); };
  const fixture = async model => {
    const provider = mobileProvider("custom"); Object.assign(provider, { apiKey: "fake-key", baseUrl: "https://fixture.example/v1", models: [mobileModel("fixture-model", { toolCalling: true })], defaultModelId: "fixture-model" });
    const settings = loadMobileSettings({ apiProviders: [provider], activeApiProviderId: provider.id, defaultModel: "fixture-model" });
    const host = createHost(); const store = new MobileStore(host.adapter, "plugin/mobile", "company-fixture"); await store.load();
    await store.update(state => { state.permission = "workspace-write"; });
    const runtime = new MobileRuntime(host.app, store, () => settings, model.request); await runtime.initialize();
    const folders = []; let changes = 0;
    const company = await startMobileCompany({ runtime, store, settings: () => settings, adapter: host.adapter, file: "plugin/mobile/devices/company-fixture/company.v1.json",
      folders: { projectRoot: async () => "项目", ensureFolder: async folder => { folders.push(folder); } }, changed: () => { changes++; } });
    assert.ok(company, "company service starts on mobile");
    return { ...host, store, runtime, settings, company, service: company.service, folders, changes: () => changes };
  };

  await test("a plain assistant card becomes a router, dispatches to a worker task, and the report returns to the same card", async () => {
    const model = scriptedModel({
      on: (role, user) => role === "router" && user === "帮我写一句问候" ? ["task_dispatch", { agentId: "generalist", brief: "写一句问候" }]
        : role === "worker" ? ["report_to_router", { outcome: "done", summary: "问候写好了：你好，周一。" }] : null,
      reply: (role, user) => role === "router" && user.startsWith("〔员工汇报〕") ? "通才写好了：你好，周一。" : "好的。",
      after: role => role === "router" ? "已派给通才。" : "已汇报。"
    });
    const state = await fixture(model);
    try {
      const routerId = state.store.session.id;
      await state.runtime.send("帮我写一句问候", routerId);
      assert.equal(state.store.getSession(routerId).companyRole, "router");
      const routerCall = model.calls.find(call => call.role === "router");
      assert.ok(routerCall.tools.includes("task_dispatch") && !routerCall.tools.includes("note_create") && !routerCall.tools.includes("report_to_router"), "总助只拿到调度和只读工具");
      await waitFor(() => state.service.doc.dispatches[0]?.status === "done", "worker report");
      const dispatch = state.service.doc.dispatches[0];
      const worker = state.store.getSession(dispatch.id);
      assert.equal(worker.companyRole, "worker"); assert.equal(worker.agentId, "generalist");
      assert.equal(state.store.session.id, routerId, "派活不会把用户切到员工任务");
      const workerCall = model.calls.find(call => call.role === "worker");
      assert.ok(workerCall.tools.includes("report_to_router") && !workerCall.tools.includes("task_dispatch"));
      await waitFor(() => state.store.getSession(routerId).messages.some(message => message.role === "assistant" && textOf(message).includes("通才写好了")), "router relay");
      assert.ok(state.store.getSession(routerId).messages.some(message => message.role === "user" && textOf(message).startsWith("〔员工汇报〕")));
      assert.ok(await state.adapter.exists("plugin/mobile/devices/company-fixture/company.v1.json"), "公司记录按设备保存");
    } finally { state.company.dispose(); state.runtime.dispose(); }
  });

  await test("a project starts only from the start card, runs dependencies in order and closes against its criteria", async () => {
    let projectId;
    const model = scriptedModel({
      on: (role, user) => {
        if (role === "router" && user === "做一期视频") return ["project_propose", { name: "视频", background: "测试", goal: "做出视频稿", criteria: ["稿子写好", "分镜写好"], roles: { generalist: "执行" },
          plan: [{ id: "t1", agentId: "generalist", label: "写稿", brief: "写稿", dependsOn: [] }, { id: "t2", agentId: "generalist", label: "分镜", brief: "拆分镜", dependsOn: ["t1"] }] }];
        if (role === "worker") return ["report_to_router", { outcome: "done", summary: user.includes("拆分镜") ? "分镜写好了" : "稿子写好了", outputs: [] }];
        if (role === "router" && user.includes("project_accept")) return ["project_accept", { projectId, summary: "视频稿和分镜都好了。",
          results: [{ criterion: "稿子写好", passed: true, evidence: "稿子写好了" }, { criterion: "分镜写好", passed: true, evidence: "分镜写好了" }] }];
        return null;
      }
    });
    const state = await fixture(model);
    try {
      const routerId = state.store.session.id;
      await state.runtime.send("做一期视频", routerId);
      const project = state.service.projectForRouter(routerId);
      assert.equal(project.status, "proposed"); assert.equal(state.service.doc.dispatches.length, 0, "开工卡不会自动开工");
      projectId = project.id;
      const started = await state.service.start(routerId, projectId);
      assert.match(started, /已开工/u);
      assert.deepEqual(state.folders, [state.service.projectOf(projectId).folder]);
      assert.equal(state.store.getSession(routerId).projectId, projectId);
      await waitFor(() => state.service.projectOf(projectId).status === "done", "project close");
      const [first, second] = state.service.doc.dispatches;
      assert.equal(first.planTaskId, "t1"); assert.equal(second.planTaskId, "t2");
      assert.ok(second.startedAt >= first.endedAt, "依赖的活在前一件交了之后才开工");
      assert.equal(state.service.projectOf(projectId).acceptance.length, 2);
    } finally { state.company.dispose(); state.runtime.dispose(); }
  });

  await test("need_decision becomes a waiting decision; answering resumes the same worker", async () => {
    const model = scriptedModel({
      on: (role, user) => role === "router" && user === "整理一下标题" ? ["task_dispatch", { agentId: "generalist", brief: "给笔记起标题" }]
        : role === "worker" && !user.startsWith("用户答") ? ["report_to_router", { outcome: "need_decision", summary: "有两种风格", question: "标题要正式还是轻松？", options: ["正式", "轻松"] }]
        : role === "worker" ? ["report_to_router", { outcome: "done", summary: "按轻松风格起好了" }] : null
    });
    const state = await fixture(model);
    try {
      const routerId = state.store.session.id;
      await state.runtime.send("整理一下标题", routerId);
      await waitFor(() => state.service.decisions().length === 1, "decision");
      await waitFor(() => !!state.store.getSession(routerId).unreadAnswerAt, "router unread mark");
      const routerTurns = model.calls.filter(call => call.role === "router").length;
      const [decision] = state.service.decisions();
      await state.service.answerDecision(decision.id, "轻松");
      await waitFor(() => state.service.dispatchOf(decision.id).status === "done", "resumed worker");
      assert.equal(state.service.decisions().length, 0);
      assert.ok(model.calls.some(call => call.role === "worker" && call.user.includes("用户答：轻松")));
      assert.ok(model.calls.filter(call => call.role === "router").length > routerTurns, "完成后汇报回总助");
    } finally { state.company.dispose(); state.runtime.dispose(); }
  });

  await test("leaving the foreground keeps the dispatch running and the next foreground resumes it", async () => {
    let release; const hold = new Promise(resolve => { release = resolve; });
    let held = false;
    const model = scriptedModel({
      on: (role, user) => role === "router" && user === "查一下资料" ? ["task_dispatch", { agentId: "generalist", brief: "查资料" }]
        : role === "worker" ? ["report_to_router", { outcome: "done", summary: "查好了" }] : null
    });
    const request = model.request;
    model.request = async raw => { const body = JSON.parse(raw.body); if (!held && textOf(body.messages[0]).includes("<echoink_company_worker")) { held = true; await hold; } return request(raw); };
    const state = await fixture(model);
    try {
      const routerId = state.store.session.id;
      await state.runtime.send("查一下资料", routerId);
      await waitFor(() => held, "worker in flight");
      await state.runtime.shutdown("app_backgrounded"); release();
      await tick(); await tick();
      const dispatch = state.service.doc.dispatches[0];
      assert.equal(dispatch.status, "running", "切到后台不算没做成");
      await state.runtime.foreground(); await state.service.initialize();
      await waitFor(() => state.service.dispatchOf(dispatch.id).status === "done", "resume after foreground");
    } finally { state.company.dispose(); state.runtime.dispose(); }
  });
  await mainFlows({ fixture, scriptedModel, test, waitFor, tick, answer, textOf });

}
