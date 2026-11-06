import { runModuleOwnerTests } from "./module-owners";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { CompanyStore } from "../company/store";
import { CompanyService, type CompanyHost } from "../company/service";
import { normalizeCompanyDocument, projectCounts, projectMilestones, staffActivitySourceKey } from "../company/logic";
import { checkAgentTool, type AgentCapabilityContext } from "../agents/capability-core";
import { defaultAgentRegistry, normalizeAgentRegistry, removeAgentDefinition } from "../agents/registry";
import { normalizeConversationTaskMetadata } from "../agents/task-metadata";

/** A fake plugin: records turns instead of calling a model. */
function fakeHost() {
  let clock = 1000, seq = 0;
  const running = new Set<string>(), turns: { id: string; text: string; permission: string }[] = [], steered: { id: string; text: string }[] = [];
  const metadata = new Map<string, Record<string, unknown>>(), workers: string[] = [], last = new Map<string, string>();
  const decisions: { routerId: string; projectId?: string }[] = [];
  const host: CompanyHost = {
    now: () => ++clock, newId: prefix => `${prefix}-${++seq}`,
    agents: () => [{ id: "sol", name: "总助", position: "", hired: true }, { id: "generalist", name: "通才", position: "没有专人负责的活", hired: true },
      { id: "lin", name: "研究员", position: "查资料", hired: true }, { id: "june", name: "文案", position: "写稿", hired: true }, { id: "han", name: "审稿员", position: "挑错", hired: true }],
    routerPermission: () => "workspace-write",
    createWorker: input => { workers.push(input.id); return Promise.resolve(); },
    startTurn: (id, text, permission) => { running.add(id); turns.push({ id, text, permission }); return Promise.resolve(); },
    isRunning: id => running.has(id),
    steer: (id, text) => { if (!running.has(id)) return Promise.resolve(false); steered.push({ id, text }); return Promise.resolve(true); },
    stop: id => { running.delete(id); return Promise.resolve(); },
    lastAssistantText: id => Promise.resolve(last.get(id)),
    setRouterMetadata: (id, patch) => { metadata.set(id, { ...metadata.get(id), ...patch }); return Promise.resolve(); },
    ensureFolder: name => Promise.resolve(`项目/${name}`),
    notifyDecision: (routerId, projectId) => { decisions.push({ routerId, projectId }); return Promise.resolve(); },
    latestUserText: () => Promise.resolve("做一期视频")
  };
  return { host, running, turns, steered, metadata, workers, last, decisions, settle: (id: string) => running.delete(id) };
}

export async function runCompanyTests(): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "echoink-company-"));
  let passed = 0;
  const ok = (name: string) => { passed++; console.log(`ok ${passed} - ${name}`); };
  try {
    runModuleOwnerTests();
    /* 通才是默认员工，和总助一样不能删 */
    const registry = normalizeAgentRegistry({ schemaVersion: 1, agents: [{ id: "sol", name: "总助" }, { id: "lin", name: "研究员" }], moduleOwners: {} });
    assert.deepEqual(registry.agents.map(a => a.id), ["sol", "lin", "generalist"], "通才追加在最后，不打乱已有顺序");
    const generalist = registry.agents.find(a => a.id === "generalist")!;
    assert.deepEqual(generalist.disabledCapabilityIds, []);
    assert.throws(() => removeAgentDefinition(registry, "generalist"));
    assert.equal(defaultAgentRegistry().agents.length, 2, "默认名单为总助和通才");
    assert.deepEqual(normalizeAgentRegistry(undefined).agents.map(a => a.id), ["sol", "generalist"], "新用户读设置时补上通才");
    ok("通才自动补上、默认全能力、不能删");

    {
      const h = fakeHost(); let owner: string | null = null;
      h.host.moduleOwner = () => owner;
      const file = path.join(dir, "module-owner.json"), service = new CompanyService(new CompanyStore(file), h.host);
      await service.initialize();
      const response = await service.dispatch("owner-router", { agentId: "generalist", moduleId: "finance", brief: "记一笔午饭 38 元" });
      assert.match(response, /还没有负责人/);
      assert.equal(h.workers.length, 0); assert.equal(h.turns.length, 0);
      assert.equal(service.doc.dispatches.length, 0);
      const reopened = new CompanyService(new CompanyStore(file), h.host); await reopened.initialize();
      const pending = reopened.pendingModuleAssignments("owner-router"); assert.equal(pending.length, 1);
      owner = "generalist";
      await Promise.all([reopened.retryModuleAssignment(pending[0].id), reopened.retryModuleAssignment(pending[0].id)]);
      assert.equal(h.workers.length, 1); assert.equal(h.turns.length, 1);
      assert.equal(reopened.pendingModuleAssignments("owner-router").length, 0);
      owner = null;
      await reopened.propose("project-owner", { name: "财务复盘", background: "", goal: "核对账本", criteria: ["完成核对"], roles: {},
        plan: [{ id: "finance", agentId: "generalist", moduleId: "finance", label: "核对", brief: "核对账本", dependsOn: [] }] });
      assert.equal(reopened.doc.projects.length, 0); assert.equal(h.workers.length, 1);
      owner = "generalist";
      await reopened.retryModuleAssignment(reopened.pendingModuleAssignments("project-owner")[0].id);
      assert.equal(reopened.doc.projects[0].status, "proposed"); assert.equal(h.workers.length, 1, "proposal still waits for explicit start");
      ok("unassigned modules create no worker or model turn; persisted assignment starts once; project still waits for start");
    }

    {
      const h = fakeHost(); let owner: string | null = "generalist";
      h.host.moduleOwner = () => owner;
      const service = new CompanyService(new CompanyStore(path.join(dir, "queued-owner.json")), h.host, 1);
      await service.initialize();
      await service.dispatch("queue-router", { agentId: "lin", moduleId: "none", brief: "先做杂活" });
      await service.dispatch("queue-router", { moduleId: "journal", brief: "整理日记" });
      const [running, queued] = service.doc.dispatches;
      assert.equal(queued.status, "queued");
      owner = null;
      await service.stop("queue-router", running.id);
      assert.equal(service.dispatchOf(queued.id)?.status, "stopped");
      assert.equal(h.turns.length, 1, "clearing a queued module owner cannot start a worker model");
      const pending = service.pendingModuleAssignments("queue-router")[0];
      assert.equal(pending.dispatchId, queued.id);
      owner = "june";
      await service.retryModuleAssignment(pending.id);
      assert.equal(service.doc.dispatches.at(-1)?.agentId, "june");
      assert.equal(h.turns.length, 2);
      ok("queued module tasks recheck ownership before starting and require explicit reassignment");
    }

    {
      const h = fakeHost(); let owner: string | null = "generalist";
      h.host.moduleOwner = () => owner;
      const service = new CompanyService(new CompanyStore(path.join(dir, "project-next-owner.json")), h.host);
      await service.initialize();
      await service.propose("next-owner", { name: "整理项目", background: "", goal: "整理并复盘", criteria: ["完成"], roles: {}, plan: [
        { id: "first", agentId: "lin", moduleId: "none", label: "准备", brief: "准备", dependsOn: [] },
        { id: "second", agentId: "generalist", moduleId: "journal", label: "日记", brief: "整理日记", dependsOn: ["first"] }
      ] });
      const project = service.doc.projects[0]; await service.start("next-owner", project.id);
      const first = service.doc.dispatches[0]; owner = null; h.settle(first.id);
      await service.onWorkerSettled(first.id, "completed", first.startedAt!);
      assert.equal(service.doc.dispatches.length, 1, "the unassigned dependent task creates no worker");
      const pending = service.pendingModuleAssignments("next-owner")[0]; assert.equal(pending.planTaskId, "second");
      owner = "june"; await service.retryModuleAssignment(pending.id);
      const second = service.doc.dispatches.at(-1)!;
      assert.equal(second.projectId, project.id); assert.equal(second.planTaskId, "second"); assert.equal(second.agentId, "june");
      assert.equal(service.projectOf(project.id)!.plan[1].agentId, "june");
      ok("unassigned dependent work retains the original project task when assigned later");
    }

    /* 结构保证分工：总助卡片只有调度工具，写和联网一律拒绝 */
    const base = { settings: { agentRegistry: registry, memory: {}, lifestyle: { finance: { enabled: true } }, pdfReading: { enabled: true }, englishDiary: { enabled: true },
      tavily: { enabled: false } as never, knowledgeBase: { folderBindings: null } }, resources: [], access: { permission: "workspace-write", mode: "agent", memoryMode: "normal" },
      relativeTarget: (v: string) => v, resolvePath: (v: string) => v, knowledgeRoles: [], toolAdapters: { isTodoTool: () => false, normalizeTodoToolRequest: () => undefined, isFinanceTool: () => false,
        financeEffect: () => "read", obsidianCli: () => ({ request: {}, scope: { capability: "knowledge", write: false } }) } } as unknown as AgentCapabilityContext;
    const router = { ...base, agentId: "sol", companyRole: "router" as const };
    assert.equal(checkAgentTool(router, "task_dispatch").allowed, true);
    assert.equal(checkAgentTool(router, "note_read").allowed, true);
    for (const tool of ["note_create", "note_update", "web_search", "knowledge_maintain", "pdf_reading_process", "workspace_create", "vault_search"]) assert.equal(checkAgentTool(router, tool).reason, "router_only", tool);
    assert.equal(checkAgentTool(router, "report_to_router").allowed, false);
    assert.equal(checkAgentTool({ ...base, agentId: "sol" }, "task_dispatch").allowed, false, "旧会话不带角色，拿不到调度工具");
    assert.equal(checkAgentTool({ ...base, agentId: "generalist", companyRole: "worker" }, "report_to_router").allowed, true);
    ok("总助只拿到调度工具；旧会话不受影响；员工才能汇报");

    assert.equal(normalizeConversationTaskMetadata({ companyRole: "router", projectId: " p1 " }).projectId, "p1");
    assert.equal(normalizeConversationTaskMetadata({ companyRole: "boss" }).companyRole, undefined);
    ok("会话元数据只认 router / worker");

    /* 直接交给员工的完成记录：旧盘兼容、有界、去重，不启动任何工作。 */
    {
      assert.deepEqual(normalizeCompanyDocument({ schemaVersion: 1, projects: [], dispatches: [], events: [] }).staffActivities, []);
      const backgroundHost = fakeHost(), file = path.join(dir, "staff-activity.json");
      const background = new CompanyService(new CompanyStore(file), backgroundHost.host);
      await background.initialize();
      for (let index = 0; index < 11; index++) await background.recordStaffActivity({ conversationId: "direct-task", piSessionId: "direct-session", turnId: `direct-turn-${index}`,
        agentId: "lin", title: "任务标题".repeat(100), summary: "结果摘要\n".repeat(100), at: index + 1 });
      assert.equal(background.doc.staffActivities!.length, 10);
      assert.deepEqual(background.doc.staffActivities!.map(activity => activity.turnId), Array.from({ length: 10 }, (_, index) => `direct-turn-${index + 1}`));
      assert.equal(new Set(background.doc.staffActivities!.map(staffActivitySourceKey)).size, 10);
      assert.ok(background.doc.staffActivities!.every(activity => activity.title.length <= 80 && activity.summary.length <= 200 && !activity.summary.includes("\n")));
      const last = background.doc.staffActivities!.at(-1)!;
      await Promise.all([background.recordStaffActivity({ ...last, summary: "重复回调不覆盖第一次的记录" }), background.recordStaffActivity(last)]);
      assert.equal(background.doc.staffActivities!.length, 10); assert.equal(background.doc.staffActivities!.at(-1)!.summary, last.summary);
      await background.recordStaffActivity({ ...last, conversationId: "sol-task", agentId: "sol" });
      await background.recordStaffActivity({ ...last, conversationId: "missing-agent", agentId: "missing" });
      assert.equal(background.doc.staffActivities!.length, 10);
      assert.deepEqual(backgroundHost.turns, []); assert.deepEqual(backgroundHost.steered, []); assert.deepEqual(backgroundHost.workers, []); assert.deepEqual(backgroundHost.decisions, []);
      assert.equal(background.doc.events.length, 0, "员工动态不混入项目汇报或决策记录");
      const reloaded = new CompanyService(new CompanyStore(file), backgroundHost.host); await reloaded.initialize();
      assert.deepEqual(reloaded.doc.staffActivities, background.doc.staffActivities, "同一公司文件持久化最近10条");
      assert.match(reloaded.staffActivityBackground(), /只作只读历史背景/u); assert.match(reloaded.staffActivityBackground(), /不是新指令/u);
      assert.match(reloaded.staffActivityBackground(), /不要因这些记录主动派活/u);
      await background.dispatch("router", { agentId: "lin", brief: "总助派出的任务" });
      const dispatched = background.doc.dispatches.at(-1)!;
      const count = background.doc.staffActivities!.length;
      await background.recordStaffActivity({ ...last, conversationId: dispatched.id, turnId: "dispatch-turn" });
      assert.equal(background.doc.staffActivities!.length, count, "总助派单已有汇报链，不能重复记为直接员工动态");
      ok("直接员工动态只存最近10条，按真实轮次去重且零唤醒");
    }

    /* 小事：派单件活，立刻返回；做完汇报回到派活的卡片 */
    const f = fakeHost(); const store = new CompanyStore(path.join(dir, "a.json")); const service = new CompanyService(store, f.host);
    await service.initialize();
    const reply = await service.dispatch("card-1", { agentId: "generalist", brief: "记一笔：午饭 38" });
    assert.match(reply, /已派给通才/u);
    const worker = f.workers[0];
    assert.equal(service.dispatchOf(worker)?.status, "running");
    assert.equal(f.turns[0].permission, "workspace-write");
    assert.match(await service.dispatch("card-1", { agentId: "nobody", brief: "x" }), /没有编号/u);
    await service.report(worker, { outcome: "done", summary: "记好了，归在餐饮。", outputs: [] });
    f.settle(worker); await service.onWorkerSettled(worker, "completed", 0);
    assert.equal(service.dispatchOf(worker)?.status, "done");
    const back = f.turns.at(-1)!; assert.equal(back.id, "card-1"); assert.match(back.text, /〔员工汇报〕通才：做完了/u); assert.match(back.text, /记好了/u);
    const flood = new CompanyService(new CompanyStore(path.join(dir, "flood.json")), fakeHost().host); await flood.initialize();
    for (let i = 0; i < 8; i++) await flood.dispatch("card-flood", { agentId: "generalist", brief: `第 ${i} 件` });
    assert.match(await flood.dispatch("card-flood", { agentId: "generalist", brief: "第 9 件" }), /没做完/u, "一张卡片最多 8 件未完成的活");
    ok("单件活：派出即返回，汇报回到原卡片");

    /* 员工忘了汇报：用最后一条回复兜底；卡片正忙就插话，不另开一轮 */
    const w2 = (await service.dispatch("card-1", { agentId: "lin", brief: "查一下 X" }), f.workers[1]);
    f.last.set(w2, "X 是 Y。"); f.running.add("card-1"); f.settle(w2);
    await service.onWorkerSettled(w2, "completed", Number.MAX_SAFE_INTEGER);
    assert.equal(service.dispatchOf(w2)?.report?.fallback, true);
    assert.match(f.steered.at(-1)!.text, /X 是 Y/u);
    f.running.delete("card-1");
    ok("忘了汇报用最后回复兜底；卡片在忙时作为插话送到");

    /* 叫停：只能停自己卡片派的活；停下后迟到的收尾不改状态、不再回卡片；空位让给排队的活 */
    // 真实插件里，中断员工会立刻触发一轮结束的收尾；在停的过程中就收尾，复现竞态
    const s = fakeHost(); let ss!: CompanyService;
    const stopHost: CompanyHost = { ...s.host, stop: async id => { s.running.delete(id); await ss.onWorkerSettled(id, "cancelled", 0); } };
    ss = new CompanyService(new CompanyStore(path.join(dir, "stop.json")), stopHost, 1); await ss.initialize();
    await ss.dispatch("card-s", { agentId: "lin", brief: "慢活" }); await ss.dispatch("card-s", { agentId: "june", brief: "排队的活" });
    const [slow, queued] = s.workers;
    assert.equal(ss.dispatchOf(queued)?.status, "queued");
    assert.match(await ss.stop("card-other", slow), /没有派过/u);
    assert.match(await ss.stop("card-s", slow), /已停下研究员/u);
    assert.equal(s.turns.some(t => t.id === "card-s"), false, "叫停不会在卡片里多出一条“没做成”");
    assert.equal(s.running.has(slow), false);
    assert.equal(ss.dispatchOf(slow)?.status, "stopped");
    assert.equal(ss.dispatchOf(queued)?.status, "running", "空位让给排队的活");
    const stopTurns = s.turns.length;
    await ss.onWorkerSettled(slow, "cancelled", 0);
    assert.equal(ss.dispatchOf(slow)?.status, "stopped");
    assert.equal(s.turns.length, stopTurns, "停下的活不再回卡片汇报");
    ok("叫停：只停自己派的、迟到收尾不覆盖、空位让给排队");

    /* 满员时用户的答案插队并多占一个位置；新活照常排队 */
    const q = fakeHost(); const qs = new CompanyService(new CompanyStore(path.join(dir, "wake.json")), q.host, 1); await qs.initialize();
    await qs.dispatch("card-q", { agentId: "lin", brief: "查原文" });
    const asker = q.workers[0];
    await qs.report(asker, { outcome: "need_decision", summary: "两组实验", outputs: [], question: "讲几组？" });
    q.settle(asker); await qs.onWorkerSettled(asker, "completed", 0);
    await qs.dispatch("card-q", { agentId: "june", brief: "写稿" });
    assert.equal(qs.dispatchOf(q.workers[1])?.status, "running", "问的人在等，位置给了下一件");
    await qs.answerDecision(asker, "只讲第一组");
    assert.equal(qs.dispatchOf(asker)?.status, "running", "满员也立刻接着做");
    assert.equal(q.turns.at(-1)!.text, "用户答：只讲第一组");
    await qs.dispatch("card-q", { agentId: "han", brief: "审稿" });
    assert.equal(qs.dispatchOf(q.workers[2])?.status, "queued", "多出的位置只给人的回复，新活照常排队");
    ok("满员时用户的答案插队，新活照常排队");

    /* 重启：被打断的活带着恢复提示接着做，不从头重来 */
    const r = fakeHost(); const rs = new CompanyService(new CompanyStore(path.join(dir, "wake.json")), r.host, 3); await rs.initialize();
    const resumed = r.turns.find(t => t.id === asker)!;
    assert.match(resumed.text, /插件重启/u); assert.match(resumed.text, /原任务：查原文/u);
    assert.equal(rs.dispatchOf(q.workers[2])?.status, "running", "排队的新活也开工");
    ok("重启后被打断的活带恢复提示接着做");

    /* 项目：开工卡校验 → 开工 → 并行 → 依赖自动接力 → 等你定 → 结项 */
    const g = fakeHost(); const ps = new CompanyService(new CompanyStore(path.join(dir, "b.json")), g.host, 2); await ps.initialize();
    const plan = [{ id: "t1", agentId: "lin", label: "查资料", brief: "整理原文", dependsOn: [], milestone: "资料" },
      { id: "t2", agentId: "generalist", label: "找参考", brief: "找画面参考", dependsOn: [], milestone: "资料" },
      { id: "t3", agentId: "june", label: "写稿", brief: "写口播稿", dependsOn: ["t1"] },
      { id: "t4", agentId: "han", label: "审稿", brief: "核对数字", dependsOn: ["t3"] }];
    const card = { name: "视频", background: "转来一篇文章", goal: "讲清双层架构", criteria: ["5 分钟左右", "数字和原文一致"], roles: {}, plan };
    assert.match(await ps.propose("card-2", { ...card, plan: [{ ...plan[0], dependsOn: ["t9"] }] }), /不存在的活/u);
    assert.match(await ps.propose("card-2", { ...card, plan: [{ ...plan[0], dependsOn: ["t2"] }, { ...plan[1], dependsOn: ["t1"] }] }), /绕成了圈/u);
    const proposed = await ps.propose("card-2", card); const projectId = /项目编号 (\S+)）/u.exec(proposed)![1];
    assert.equal(g.turns.length, 0, "开工卡不直接开工");
    assert.match(await ps.start("card-2", projectId), /已开工/u);
    assert.deepEqual(g.metadata.get("card-2"), { companyRole: "router", projectId });
    const live = () => ps.doc.dispatches.filter(d => d.status === "running").map(d => d.planTaskId).sort();
    assert.deepEqual(live(), ["t1", "t2"]);
    const byTask = (t: string) => ps.doc.dispatches.find(d => d.planTaskId === t)!.id;
    assert.match(ps.doc.events.map(e => e.text).join("\n"), /@研究员 整理原文/u);

    await ps.report(byTask("t1"), { outcome: "need_decision", summary: "实验有两组", outputs: [], question: "讲两组还是一组？", options: ["两组", "一组"] });
    g.settle(byTask("t1")); await ps.onWorkerSettled(byTask("t1"), "completed", 0);
    assert.equal(ps.decisions(projectId).length, 1);
    assert.deepEqual(g.decisions, [{ routerId: "card-2", projectId }], "项目决策由程序提示，不唤醒总助模型");
    assert.equal(g.turns.filter(t => t.id === "card-2").length, 0);
    g.settle("card-2");
    assert.equal(projectMilestones(ps.doc, ps.projectOf(projectId)!).find(m => m.title === "资料")?.state, "waiting");
    await ps.answerDecision(byTask("t1"), "一组");
    assert.equal(ps.decisions(projectId).length, 0);
    assert.equal(g.turns.at(-1)!.text, "用户答：一组", "答案直接送回员工");

    const turnsBefore = g.turns.length;
    await ps.report(byTask("t2"), { outcome: "done", summary: "参考找好了", outputs: ["项目/视频/画面参考.md"] });
    g.settle(byTask("t2")); await ps.onWorkerSettled(byTask("t2"), "completed", 0);
    assert.equal(g.turns.length, turnsBefore, "中间结果不打扰卡片");
    await ps.report(byTask("t1"), { outcome: "done", summary: "资料好了", outputs: ["项目/视频/资料摘要.md"] });
    g.settle(byTask("t1")); await ps.onWorkerSettled(byTask("t1"), "completed", 0);
    assert.deepEqual(live(), ["t3"], "依赖满足，程序自动派下一棒");
    const ms = projectMilestones(ps.doc, ps.projectOf(projectId)!, id => ({ june: "文案" })[id] ?? id);
    assert.equal(ms.find(m => m.title === "资料")?.state, "done");
    assert.match(ms.find(m => m.title === "资料")?.handoff ?? "", /《资料摘要》.*→ 文案/u);
    for (const t of ["t3", "t4"]) {
      await ps.report(byTask(t), { outcome: "done", summary: `${t} 好了`, outputs: [] });
      g.settle(byTask(t)); await ps.onWorkerSettled(byTask(t), "completed", 0);
    }
    assert.match(g.turns.at(-1)!.text, /project_accept/u, "全部做完提醒总助验收");
    assert.match(await ps.accept("card-2", projectId, [{ criterion: "5 分钟左右", passed: true, evidence: "5 分 10 秒" }, { criterion: "数字和原文一致", passed: true, evidence: "复审通过" }], "做完了"), /2\/2 通过/u);
    const c = projectCounts(ps.doc, ps.projectOf(projectId)!);
    assert.deepEqual([c.milestonesDone, c.milestonesTotal, c.tasksDone, c.tasksTotal], [5, 5, 4, 4]);
    assert.equal(ps.projectOf(projectId)?.status, "done");
    ok("项目：开工卡校验、并行上限、等你定直送员工、依赖自动接力、结项");

    /* 重启：没在跑的“进行中”重新排队；文件损坏的条目被丢弃而不是整份报错 */
    const saved = JSON.parse(await readFile(path.join(dir, "a.json"), "utf8")) as { dispatches: unknown[] };
    assert.ok(saved.dispatches.length >= 2);
    const h = fakeHost(); const fresh = new CompanyService(new CompanyStore(path.join(dir, "b.json")), h.host); await fresh.initialize();
    assert.equal(fresh.doc.projects[0].status, "done");
    assert.equal(normalizeCompanyDocument({ schemaVersion: 1, projects: [{ id: "x" }], dispatches: [{}], events: [null] }).projects.length, 0);
    ok("持久化与损坏数据容错");
    console.log(`company tests: ${passed} passed`);
  } finally { await rm(dir, { recursive: true, force: true }); }
}
