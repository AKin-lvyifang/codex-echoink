import assert from "node:assert/strict";

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const agents = [{ id: "sol", name: "总助", avatar: "" }, { id: "researcher", name: "研究员", avatar: "" }, { id: "writer", name: "文案", avatar: "" }];

export async function runMobileCompanyUIScenarios({ CompanyService, MobileCompanyStore, companyDecisionGroup, companyProjectCard, companyProjectPage, companyReminder, companyStartCard, mobileCompanyDecisions }, window) {
  const document = window.document;
  let passed = 0;
  const test = async (name, run) => { await run(); console.log(`ok ${++passed} - ${name}`); };
  const files = new Map();
  const adapter = { async exists(path) { return files.has(path); }, async read(path) { return files.get(path); }, async write(path, text) { files.set(path, text); }, async mkdir() {}, async rename() {}, async remove() {} };
  const started = [], cancelled = [];
  const host = { now: () => Date.now(), newId: prefix => `${prefix}-${Math.random().toString(36).slice(2)}`, agents: () => agents.map(agent => ({ id: agent.id, name: agent.name, position: "", hired: true })),
    routerPermission: () => "workspace-write", createWorker: async () => {}, startTurn: async id => { started.push(id); }, isRunning: () => false, steer: async () => false, stop: async () => {},
    lastAssistantText: async () => undefined, latestUserText: async () => "做一期视频", setRouterMetadata: async () => {}, ensureFolder: async name => `项目/${name}`, notifyDecision: async () => {} };
  const service = new CompanyService(new MobileCompanyStore(adapter, "company.json"), host); await service.initialize();
  const sessions = new Map();
  const store = { getSession: id => structuredClone(sessions.get(id)), state: { sessions: [] } };
  const answered = [];
  const runtime = { answerQuestion: async (...args) => { answered.push(args); }, subscribe: () => () => {} };
  const errors = [];
  const opened = [];
  const ctx = { openWorkbench: () => opened.push(["home"]), document, service, store, runtime, agents: () => agents, error: error => errors.push(error), openTask: id => opened.push(["task", id]), openProject: id => opened.push(["project", id]) };

  await test("start card renders the plan and only its buttons start or cancel", async () => {
    await service.propose("router-1", { name: "视频", background: "测试", goal: "做出视频稿", criteria: ["稿子写好"], roles: {},
      plan: [{ id: "t1", agentId: "researcher", label: "查资料", brief: "读原文", dependsOn: [] }, { id: "t2", agentId: "writer", label: "写稿", brief: "写口播稿", dependsOn: ["t1"] }] });
    const project = service.projectForRouter("router-1");
    const card = companyStartCard(ctx, project);
    assert.equal(card.querySelectorAll(".emc-start-row").length, 2);
    assert.match(card.textContent, /等「查资料」/u); assert.match(card.textContent, /马上开工/u);
    const [later, start] = card.querySelectorAll("button");
    assert.equal(later.textContent, "先不开"); assert.equal(start.textContent, "开工"); assert.ok(start.classList.contains("is-primary"));
    start.click(); await tick(); await tick(); await tick();
    assert.equal(service.projectOf(project.id).status, "running");
    assert.equal(errors.length, 0);
    const after = companyStartCard(ctx, service.projectOf(project.id));
    assert.equal(after.querySelectorAll("button").length, 0, "开工后卡片收起按钮"); assert.match(after.textContent, /已开工/u);
  });

  await test("need_decision and a waiting worker question share one compact list; answers go to the right place", async () => {
    const project = service.projectForRouter("router-1");
    const [first] = service.doc.dispatches;
    await service["store"].mutate(doc => ({ ...doc, dispatches: doc.dispatches.map(d => d.id === first.id ? { ...d, status: "waiting", report: { outcome: "need_decision", summary: "两组实验", question: "讲两组还是只讲第一组？", options: ["两组都讲", "只讲第一组"], outputs: [], at: Date.now() } } : d) }));
    await service["store"].mutate(doc => ({ ...doc, dispatches: [...doc.dispatches, { id: "worker-2", routerConversationId: "router-1", agentId: "writer", brief: "清理旧稿", status: "running", permission: "workspace-write", createdAt: Date.now(), turns: 1, projectId: project.id }] }));
    sessions.set("worker-2", { id: "worker-2", interaction: { taskId: "worker-2", runId: "run-2", questionId: "q-2", kind: "confirmation", status: "pending", createdAt: Date.now(),
      questions: [{ questionId: "confirm", prompt: "允许删除 旧版大纲.md 吗？", selection: "single", allowSupplement: false, options: [{ optionId: "approve", label: "允许这一次" }, { optionId: "deny", label: "取消" }] }] } });
    const items = mobileCompanyDecisions(service, store, { projectId: project.id });
    assert.equal(items.map(item => item.kind).sort().join(), "interaction,question");
    const group = companyDecisionGroup(ctx, items);
    const approval = group.querySelector(".emc-decision.is-approval");
    assert.match(approval.querySelector(".emc-decision-title").textContent, /^删除 旧版大纲\.md$/u);
    const approve = [...approval.querySelectorAll("button")].find(button => button.textContent === "批准");
    assert.ok(approve.classList.contains("is-danger"), "删除批准是实心危险色");
    approve.click(); await tick();
    assert.equal(JSON.stringify(answered[0]), JSON.stringify(["worker-2", "run-2", "q-2", [{ questionId: "confirm", selectedOptionIds: ["approve"] }]]));
    const question = group.querySelector(".emc-decision.is-question");
    assert.match(question.textContent, /研究员/u);
    [...question.querySelectorAll("button")].find(button => button.textContent === "只讲第一组").click(); await tick(); await tick(); await tick();
    assert.equal(service.dispatchOf(first.id).answer, "只讲第一组");
  });

  await test("project card, reminder and read-only project page follow the PRD order", async () => {
    const project = service.projectForRouter("router-1");
    const card = companyProjectCard(ctx, project);
    assert.match(card.querySelector(".emc-project-name").textContent, /视频/u);
    assert.match(card.textContent, /1 件等你定/u, "还剩员工确认的那一件");
    card.click(); assert.equal(opened.at(-1).join(), `project,${project.id}`);
    const reminder = companyReminder(ctx, "router-1");
    assert.match(reminder.textContent, /这个项目有 1 件等你定/u);
    reminder.click(); assert.equal(opened.at(-1).join(), `project,${project.id}`);
    assert.equal(companyReminder(ctx, "router-none"), null, "没有等你定时不出提醒");
    const page = companyProjectPage(ctx, project.id, { openConversation: () => opened.push(["conversation"]) });
    const headings = [...page.querySelectorAll(".emc-section-heading h2")].map(item => item.textContent);
    assert.equal(headings.join(), "成员,概况,等你定");
    assert.equal([...page.querySelectorAll(".emc-tab")].map(tab => tab.firstChild.textContent).join(), "记录,任务,里程碑,产出");
    assert.ok(page.querySelectorAll(".emc-event").length >= 3, "记录里有交代、目标和派活");
    [...page.querySelectorAll(".emc-tab")][1].click();
    assert.equal(page.querySelectorAll(".emc-task-row").length, 2);
    assert.equal(page.querySelector("textarea"), null, "项目页没有输入框");
    page.disposeCompany();
  });
  await test("single-task reminder opens the workbench waiting group instead of the router or employee", async () => {
    await service.dispatch("router-solo", { agentId: "researcher", moduleId: "none", brief: "写问候" });
    const dispatch = service.doc.dispatches.find(item => item.routerConversationId === "router-solo");
    await service.report(dispatch.id, { outcome: "need_decision", summary: "等用户选语气", question: "选哪种语气？", options: ["轻松", "正式"], outputs: [] });
    await service.onWorkerSettled(dispatch.id, "completed", 0);
    companyReminder(ctx, "router-solo").click();
    assert.equal(opened.at(-1).join(), "home");
  });

}
