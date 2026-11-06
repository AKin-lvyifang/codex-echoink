import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { CompanyService, type CompanyHost, type CompanyPermission } from "../company/service";
import { CompanyStore } from "../company/store";
import { projectCounts } from "../company/logic";
import { createCompanyRouterTools } from "../company/tools";
import { companyRouterPrompt, companyWorkerPrompt } from "../company/prompts";
import type { CompanyDispatch, CompanyPlanTask } from "../company/types";

let sequence = 0;
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}
function task(id: string, dependsOn: string[] = []): CompanyPlanTask { return { id, agentId: "generalist", label: id, brief: `完成 ${id}`, dependsOn }; }
function fixture(file: string, limit = 3) {
  let clock = 1000;
  let permission: CompanyPermission = "workspace-write";
  const running = new Set<string>(), created: string[] = [], duplicates: string[] = [];
  const workerProjects = new Map<string, string | undefined>();
  const turns: { id: string; text: string; permission: CompanyPermission }[] = [], steers: { id: string; text: string }[] = [];
  const decisions: { routerId: string; projectId?: string }[] = [];
  const folders: string[] = [], stopped: string[] = [], metadata: string[] = [];
  const host: CompanyHost = {
    now: () => ++clock, newId: prefix => `${prefix}-${++sequence}`,
    agents: () => [{ id: "generalist", name: "通才", position: "", hired: true }], routerPermission: () => permission,
    createWorker: async input => { created.push(input.id); workerProjects.set(input.id, input.projectId); },
    startTurn: async (id, text, turnPermission) => {
      if (running.has(id)) { duplicates.push(id); throw new Error("conversation_already_running"); }
      turns.push({ id, text, permission: turnPermission }); running.add(id);
    },
    isRunning: id => running.has(id),
    steer: async (id, text) => { if (!running.has(id)) return false; steers.push({ id, text }); return true; },
    stop: async id => { running.delete(id); stopped.push(id); },
    lastAssistantText: async () => "做完了", latestUserText: async () => "做项目",
    setRouterMetadata: async id => { metadata.push(id); },
    ensureFolder: async (name, routerId) => { assert.equal(routerId, "router"); folders.push(name); return `项目/${name}`; },
    notifyDecision: async (routerId, projectId) => { decisions.push({ routerId, projectId }); }
  };
  const store = new CompanyStore(file), service = new CompanyService(store, host, limit);
  return { service, store, host, running, created, workerProjects, duplicates, turns, steers, decisions, folders, stopped, metadata,
    setPermission: (next: CompanyPermission) => { permission = next; } };
}
type Fixture = ReturnType<typeof fixture>;
async function dispatch(f: Fixture, brief = "原始任务"): Promise<CompanyDispatch> {
  const before = new Set(f.service.doc.dispatches.map(d => d.id));
  await f.service.dispatch("router", { agentId: "generalist", brief });
  return f.service.doc.dispatches.find(d => !before.has(d.id))!;
}
async function propose(f: Fixture, plan: CompanyPlanTask[] = [task("a")], criteria = ["标准 A", "标准 B"]): Promise<string> {
  await f.service.propose("router", { name: "测试项目", background: "背景", goal: "目标", criteria, roles: {}, plan });
  return f.service.doc.projects.at(-1)!.id;
}
async function complete(f: Fixture, id: string, outcome: "done" | "failed" = "done"): Promise<void> {
  await f.service.report(id, { outcome, summary: outcome === "done" ? "已完成" : "执行失败", outputs: [] });
  f.running.delete(id);
  await f.service.onWorkerSettled(id, "completed", 0);
}

/** Synthetic hosts, real scheduler/store and atomic files; never opens a Vault or a model. */
export async function runCompanySchedulerTests(): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "echoink-company-scheduler-"));
  let passed = 0, fileNo = 0;
  const file = () => path.join(dir, `${++fileNo}.json`);
  const ok = (name: string) => { passed++; console.log(`ok scheduler ${passed} - ${name}`); };
  try {
    {
      const f = fixture(file()); await f.service.initialize();
      for (let i = 0; i < 5; i++) await dispatch(f);
      const [a, b] = f.service.doc.dispatches;
      for (const d of [a, b]) { await f.service.report(d.id, { outcome: "done", summary: "done", outputs: [] }); f.running.delete(d.id); }
      await Promise.all([f.service.onWorkerSettled(a.id, "completed", 0), f.service.onWorkerSettled(b.id, "completed", 0)]);
      assert.deepEqual(f.duplicates, [], "concurrent settlements must never start a conversation twice");
      assert.equal(f.service.doc.dispatches.filter(d => d.status === "running").length, 3);
      for (const d of f.service.doc.dispatches) assert.equal(f.turns.filter(t => t.id === d.id).length, 1);
      ok("并发补位不重复领取、状态和真实运行一致");
    }
    {
      const f = fixture(file()); await f.service.initialize();
      const claimed = deferred(), stopped = deferred(), releaseClaim = deferred(), mutate = f.store.mutate.bind(f.store);
      let id = "";
      f.store.mutate = async change => {
        const next = await mutate(change), d = next.dispatches.at(-1);
        if (d?.status === "running") { id = d.id; claimed.resolve(); await releaseClaim.promise; }
        if (d?.status === "stopped") stopped.resolve();
        return next;
      };
      const dispatching = f.service.dispatch("router", { agentId: "generalist", brief: "领取落盘时被叫停" });
      await claimed.promise;
      const stopping = f.service.stop("router", id);
      await stopped.promise; releaseClaim.resolve();
      await Promise.all([dispatching, stopping]);
      assert.equal(f.service.dispatchOf(id)?.status, "stopped");
      assert.equal(f.turns.filter(t => t.id === id).length, 0); assert.equal(f.running.has(id), false);
      assert.equal(f.stopped.length, 0, "the host turn never started, so stop needs no abort");
      ok("领取落盘后被叫停会复查 stopped，不再启动员工轮次");
    }
    {
      const f = fixture(file()); await f.service.initialize();
      const pid = await propose(f, [task("a"), task("b"), task("c", ["a", "b"])]);
      await f.service.start("router", pid);
      const [a, b] = f.service.doc.dispatches;
      for (const d of [a, b]) { await f.service.report(d.id, { outcome: "done", summary: "done", outputs: [] }); f.running.delete(d.id); }
      const original = f.host.createWorker;
      f.host.createWorker = async input => {
        const onDisk = JSON.parse(await readFile((f.store as unknown as { file: string }).file, "utf8")) as { dispatches: CompanyDispatch[] };
        assert.equal(onDisk.dispatches.filter(d => d.id === input.id && d.workerPending).length, 1, "claim must be durable before worker creation");
        await new Promise<void>(resolve => setImmediate(resolve));
        await original(input);
      };
      await Promise.all([f.service.onWorkerSettled(a.id, "completed", 0), f.service.onWorkerSettled(b.id, "completed", 0)]);
      const copies = f.service.doc.dispatches.filter(d => d.planTaskId === "c");
      assert.equal(copies.length, 1); assert.equal(copies[0].status, "running");
      assert.equal(f.created.filter(id => id === copies[0].id).length, 1);
      const eventsBefore = f.service.doc.events.length;
      await f.service.onWorkerSettled(a.id, "completed", 0);
      assert.equal(f.service.doc.events.length, eventsBefore, "duplicate settlement produces no second project event");
      ok("并发依赖接力只派一次，建员工前已持久占位");
    }
    {
      const f = fixture(file(), 1); await f.service.initialize();
      const a = await dispatch(f), b = await dispatch(f), c = await dispatch(f);
      const original = f.host.startTurn;
      f.host.startTurn = async (id, ...rest) => { if (id === b.id) throw new Error("request rejected"); await original(id, ...rest); };
      await complete(f, a.id);
      assert.equal(f.service.dispatchOf(b.id)?.status, "failed");
      assert.ok(f.service.dispatchOf(b.id)?.endedAt);
      assert.equal(f.service.dispatchOf(c.id)?.status, "running");
      assert.ok(f.steers.some(s => /request rejected/u.test(s.text)), "failed start is reported through the same settlement path");
      assert.equal(f.service.dispatchOf(b.id)?.reportPending, undefined);
      ok("启动失败落终态并汇报，空位继续交给下一件");
    }
    {
      const f = fixture(file(), 1); await f.service.initialize();
      f.host.createWorker = async () => { throw new Error("create failed"); };
      assert.match(await f.service.dispatch("router", { agentId: "generalist", brief: "创建失败" }), /create failed/u);
      const failed = f.service.doc.dispatches[0];
      assert.equal(failed.status, "failed"); assert.equal(failed.turns, 0);
      assert.match(f.turns.find(t => t.id === "router")!.text, /create failed/u);
      ok("建员工失败也会持久收尾并交付失败汇报");
    }
    {
      const savedFile = file(), f = fixture(savedFile); await f.service.initialize();
      const d = await dispatch(f);
      const original = f.host.startTurn;
      f.host.startTurn = async (id, ...rest) => { if (id === "router") throw new Error("router unavailable"); await original(id, ...rest); };
      await complete(f, d.id);
      assert.equal(f.service.dispatchOf(d.id)?.status, "done");
      assert.ok(f.service.dispatchOf(d.id)?.reportPending);
      const g = fixture(savedFile); await g.service.initialize();
      assert.equal(g.turns.filter(t => t.id === "router").length, 1);
      assert.equal(g.service.dispatchOf(d.id)?.reportPending, undefined);
      await g.service.initialize();
      assert.equal(g.turns.filter(t => t.id === "router").length, 1, "delivered outbox is not replayed on a later initialize");
      ok("路由暂时失败后重启补投，成功交付清除 outbox");
    }
    {
      const savedFile = file(), f = fixture(savedFile); await f.service.initialize();
      const pid = await propose(f); await f.service.start("router", pid); const d = f.service.doc.dispatches[0];
      let canReceive = false;
      f.host.canReceiveReports = routerId => { assert.equal(routerId, "router"); return canReceive; };
      f.running.add("router"); // The coordinator is waiting for a deferred approval-only turn to settle.
      await complete(f, d.id);
      const pending = f.service.dispatchOf(d.id)?.reportPending;
      assert.ok(pending); assert.match(pending.tail!, /project_accept/u);
      await Promise.all([f.service.flushPendingReports(), f.service.flushPendingReports()]);
      assert.equal(f.service.dispatchOf(d.id)?.reportPending?.id, pending.id);
      assert.equal(f.steers.length, 0, "ordinary reports must not steer into the approval-only turn");
      assert.equal(f.turns.filter(t => t.id === "router").length, 0);
      const saved = JSON.parse(await readFile(savedFile, "utf8")) as { dispatches: CompanyDispatch[] };
      assert.equal(saved.dispatches.find(item => item.id === d.id)?.reportPending?.id, pending.id);
      f.running.delete("router"); canReceive = true;
      await Promise.all([f.service.flushPendingReports(), f.service.flushPendingReports()]);
      const deliveries = f.turns.filter(t => t.id === "router");
      assert.equal(deliveries.length, 1); assert.match(deliveries[0].text, /〔员工汇报〕.*测试项目/su);
      assert.match(deliveries[0].text, /project_accept/u);
      assert.equal(f.service.dispatchOf(d.id)?.reportPending, undefined); assert.equal(f.steers.length, 0);
      await f.service.flushPendingReports();
      assert.equal(f.turns.filter(t => t.id === "router").length, 1);
      ok("审批 defer 期间保留最终汇报，settled 后唯一补投并保留验收通知");
    }
    {
      const f = fixture(file()); await f.service.initialize(); const d = await dispatch(f);
      f.host.canReceiveReports = () => false; f.running.add("router");
      await f.service.report(d.id, { outcome: "need_decision", summary: "需要选择", question: "选哪个？", outputs: [] });
      f.running.delete(d.id); await f.service.onWorkerSettled(d.id, "completed", 0);
      assert.equal(f.decisions.length, 1); assert.equal(f.service.decisions().length, 1);
      assert.equal(f.service.dispatchOf(d.id)?.reportPending, undefined);
      assert.equal(f.steers.length, 0); assert.equal(f.turns.filter(t => t.id === "router").length, 0);
      ok("审批专用轮次仍允许纯程序 need_decision 卡片通知");
    }
    {
      const savedFile = file(), f = fixture(savedFile); await f.service.initialize();
      const pid = await propose(f, [task("a"), task("b", ["a"])]); await f.service.start("router", pid);
      await f.store.mutate(doc => ({ ...doc, dispatches: doc.dispatches.map(d => ({ ...d, status: "done" as const })) }));
      const g = fixture(savedFile); await g.service.initialize();
      const next = g.service.doc.dispatches.filter(d => d.planTaskId === "b");
      assert.equal(next.length, 1); assert.equal(next[0].status, "running");
      assert.equal(g.turns.filter(t => t.id === next[0].id).length, 1);
      ok("重启会推进依赖已满足的运行项目");
    }
    {
      const f = fixture(file()); await f.service.initialize();
      const pid = await propose(f);
      f.setPermission("read-only");
      assert.match(await f.service.start("router", pid), /只读/u);
      assert.equal(f.folders.length, 0); assert.equal(f.created.length, 0); assert.equal(f.metadata.length, 0);
      assert.equal(f.service.projectOf(pid)?.status, "proposed");
      f.setPermission("workspace-write");
      f.host.ensureFolder = async () => { f.setPermission("read-only"); return "项目/已创建"; };
      assert.match(await f.service.start("router", pid), /只读/u);
      assert.equal(f.created.length, 0); assert.equal(f.metadata.length, 0);
      assert.equal(f.service.projectOf(pid)?.status, "proposed");
      f.setPermission("workspace-write"); f.host.ensureFolder = async () => null;
      assert.match(await f.service.start("router", pid), /取消/u);
      assert.equal(f.service.projectOf(pid)?.status, "proposed"); assert.equal(f.created.length, 0);
      ok("只读开工前拦截、选目录后复查，取消选目录不启动");
    }
    {
      const f = fixture(file()); await f.service.initialize();
      const d = await dispatch(f);
      f.setPermission("read-only");
      f.host.stop = async id => { f.running.delete(id); f.stopped.push(id); await f.service.onWorkerSettled(id, "cancelled", 0); };
      await f.service.message("router", d.id, "继续核对");
      assert.deepEqual(f.stopped, [d.id]); assert.equal(f.steers.length, 0, "must not steer an old writable turn after downgrade");
      assert.equal(f.turns.at(-1)?.permission, "read-only");
      assert.equal(f.service.dispatchOf(d.id)?.permission, "workspace-write", "original dispatch ceiling remains stable");
      assert.equal(f.service.dispatchOf(d.id)?.turnPermission, "read-only");
      f.running.delete(d.id); f.setPermission("danger-full-access");
      await f.service.message("router", d.id, "继续");
      assert.equal(f.turns.at(-1)?.permission, "workspace-write", "restoring the router cannot exceed the original dispatch permission");
      ok("运行中降权先停旧轮次，每次恢复取派活权限与当前权限较窄值");
    }
    {
      const f = fixture(file(), 1); await f.service.initialize();
      await dispatch(f, "占位"); const queued = await dispatch(f, "原始交付：写总结");
      f.setPermission("read-only");
      await f.service.message("router", queued.id, "再加英文版");
      const started = f.turns.find(t => t.id === queued.id)!;
      assert.match(started.text, /原始交付：写总结/u); assert.match(started.text, /再加英文版/u);
      assert.equal(started.permission, "read-only");
      ok("未开首轮的排队补充保留原 brief，并复查当前权限");
    }
    {
      const f = fixture(file()); await f.service.initialize();
      const pid = await propose(f); await f.service.start("router", pid);
      const d = f.service.doc.dispatches[0];
      await f.service.report(d.id, { outcome: "need_decision", summary: "需要确认", question: "选哪一个？", options: ["甲", "乙"], outputs: [] });
      f.running.delete(d.id); await f.service.onWorkerSettled(d.id, "completed", 0);
      assert.equal(f.service.decisions(pid).length, 1); assert.equal(f.decisions.length, 1);
      assert.equal(f.turns.filter(t => t.id === "router").length, 0); assert.equal(f.steers.length, 0);
      await f.service.message("router", d.id, "选甲");
      assert.equal(f.service.decisions(pid).length, 0); assert.equal(f.turns.at(-1)?.text, "用户答：选甲");
      const before = f.turns.length; await f.service.answerDecision(d.id, "选乙");
      assert.equal(f.turns.length, before); assert.equal(f.service.doc.events.filter(e => e.kind === "answer").length, 1);
      await f.service.report(d.id, { outcome: "need_decision", summary: "再确认", question: "继续吗？", outputs: [] });
      f.running.delete(d.id); await f.service.onWorkerSettled(d.id, "completed", 0);
      await f.service.answerDecision(d.id, "继续");
      assert.equal(f.service.decisions(pid).length, 0); assert.equal(f.turns.at(-1)?.text, "用户答：继续");
      assert.equal(f.service.doc.events.filter(e => e.kind === "answer").length, 2);
      ok("项目决策只通知界面，task_message 与按钮回答关闭同一状态");
    }
    {
      const f = fixture(file()); await f.service.initialize(); const d = await dispatch(f);
      await f.service.report(d.id, { outcome: "need_decision", summary: "请确认", question: "用哪个？", outputs: [] });
      f.running.delete(d.id);
      await Promise.all([f.service.onWorkerSettled(d.id, "completed", 0), f.service.onWorkerSettled(d.id, "completed", 0)]);
      assert.equal(f.turns.filter(t => t.id === "router").length, 0); assert.equal(f.steers.length, 0);
      assert.deepEqual(f.decisions, [{ routerId: "router", projectId: undefined }]);
      await f.service.message("router", d.id, "用第一个");
      assert.equal(f.service.decisions().length, 0); assert.equal(f.turns.at(-1)?.text, "用户答：用第一个");
      ok("非项目决策也只提示卡片，重复收尾不重复通知或唤醒模型");
    }
    for (const inProject of [false, true]) {
      const savedFile = file(), f = fixture(savedFile); await f.service.initialize();
      const pid = inProject ? await propose(f) : undefined;
      if (pid) await f.service.start("router", pid); else await dispatch(f);
      const d = f.service.doc.dispatches[0];
      f.host.notifyDecision = async () => { throw new Error("UI unavailable"); };
      await f.service.report(d.id, { outcome: "need_decision", summary: "确认", question: "选哪个？", outputs: [] });
      f.running.delete(d.id); await f.service.onWorkerSettled(d.id, "completed", 0);
      assert.ok(f.service.dispatchOf(d.id)?.reportPending);
      const g = fixture(savedFile); await g.service.initialize();
      assert.deepEqual(g.decisions, [{ routerId: "router", projectId: pid }]);
      assert.equal(g.turns.length, 0); assert.equal(g.service.dispatchOf(d.id)?.reportPending, undefined);
      assert.equal(g.service.decisions(pid).length, 1, "delivering a notification keeps the question waiting for its answer");
      ok(`${inProject ? "项目" : "非项目"}决策通知失败可重启补投，补投也不唤醒模型`);
    }
    {
      const f = fixture(file()); await f.service.initialize(); const d = await dispatch(f);
      f.running.delete(d.id); const entered = deferred(), gate = deferred();
      f.host.lastAssistantText = async () => { entered.resolve(); await gate.promise; return "迟到的完成回复"; };
      const pending = f.service.onWorkerSettled(d.id, "completed", Number.MAX_SAFE_INTEGER);
      await entered.promise; await f.service.stop("router", d.id); gate.resolve(); await pending;
      assert.equal(f.service.dispatchOf(d.id)?.status, "stopped"); assert.equal(f.service.dispatchOf(d.id)?.report, undefined);
      assert.equal(f.turns.filter(t => t.id === "router").length, 0);
      ok("读取最后回复期间被叫停，实际写状态时不覆盖 stopped");
    }
    {
      const f = fixture(file()); await f.service.initialize(); const d = await dispatch(f);
      const entered = deferred(), gate = deferred(), original = f.host.startTurn;
      f.host.startTurn = async (id, ...rest) => { if (id === "router") { entered.resolve(); await gate.promise; } await original(id, ...rest); };
      const completing = complete(f, d.id); await entered.promise;
      await f.store.mutate(doc => ({ ...doc, dispatches: doc.dispatches.map(x => x.id === d.id ? { ...x,
        report: { outcome: "done" as const, summary: "更新的汇报", outputs: [], at: 9999 }, reportPending: { id: "new-delivery" } } : x) }));
      gate.resolve(); await completing;
      assert.equal(f.service.dispatchOf(d.id)?.reportPending?.id, "new-delivery", "acknowledging old delivery must not clear a new outbox entry");
      await f.service.initialize();
      assert.ok(f.steers.some(s => /更新的汇报/u.test(s.text))); assert.equal(f.service.dispatchOf(d.id)?.reportPending, undefined);
      ok("异步投递成功只清自身标识，不吞掉期间写入的新汇报");
    }
    {
      const f = fixture(file()); await f.service.initialize(); const pid = await propose(f, [task("a"), task("b")]);
      await f.service.start("router", pid);
      const valid = [{ criterion: "标准 A", passed: true, evidence: "已核对" }, { criterion: "标准 B", passed: false, evidence: "仍缺一项" }];
      assert.match(await f.service.accept("router", pid, valid, "检查完成"), /任务未结束/u);
      const [a, b] = f.service.doc.dispatches;
      await complete(f, a.id); await f.service.stop("router", b.id);
      await f.store.mutate(doc => ({ ...doc, dispatches: [{ ...a, id: "older-attempt", status: "running" as const }, ...doc.dispatches] }));
      assert.match(await f.service.accept("router", pid, valid, "旧轮次未结束"), /任务未结束/u);
      await f.service.stop("router", "older-attempt");
      assert.match(await f.service.accept("router", pid, valid.slice(0, 1), "漏项"), /缺少：标准 B/u);
      assert.match(await f.service.accept("router", pid, [valid[0], valid[0]], "重复"), /多出或重复：标准 A/u);
      assert.match(await f.service.accept("router", pid, [{ ...valid[0], criterion: "改写标准" }, valid[1]], "换标准"), /缺少：标准 A/u);
      assert.equal(f.service.projectOf(pid)?.status, "running");
      assert.match(await f.service.accept("router", pid, valid, "一项未通过"), /1\/2 通过/u);
      assert.equal(f.service.projectOf(pid)?.status, "done"); assert.equal(f.service.projectOf(pid)?.acceptance?.[1].passed, false);
      ok("验收要求全部任务终态、原标准无漏无重，未通过结果照实保存");
    }
    {
      const f = fixture(file()); await f.service.initialize(); const pid = await propose(f);
      await f.service.start("router", pid); const planned = f.service.doc.dispatches[0];
      const extra = await dispatch(f, "补写一份交付说明");
      assert.equal(extra.projectId, pid); assert.equal(extra.planTaskId, undefined);
      assert.equal(f.workerProjects.get(extra.id), pid, "the worker conversation receives the same project metadata");
      assert.ok(f.turns.find(t => t.id === extra.id)?.text.includes(f.service.projectOf(pid)!.folder + "/"));
      assert.equal(projectCounts(f.service.doc, f.service.projectOf(pid)!).reworks, 1);
      await complete(f, planned.id);
      assert.equal(f.turns.filter(t => t.id === "router").length, 0, "supplemental work must settle before the all-done notification");
      const results = [{ criterion: "标准 A", passed: true, evidence: "已核对" }, { criterion: "标准 B", passed: true, evidence: "已核对" }];
      assert.match(await f.service.accept("router", pid, results, "准备结项"), /任务未结束：补写一份交付说明/u);
      assert.equal(f.service.projectOf(pid)?.status, "running");
      await complete(f, extra.id);
      assert.match(f.turns.find(t => t.id === "router")!.text, /project_accept/u);
      assert.match(await f.service.accept("router", pid, results, "补活也已结束"), /2\/2 通过/u);
      assert.equal(f.service.doc.events.filter(e => e.projectId === pid && e.kind === "report").length, 2);
      const afterClose = await dispatch(f, "项目结项后另派单件任务");
      assert.equal(afterClose.projectId, undefined, "only a currently running project is inherited");
      ok("task_dispatch 补活继承运行项目、交付目录和返工计数，结项等补活终态");
    }
    {
      const savedFile = file(), f = fixture(savedFile); await f.service.initialize();
      const pid = await propose(f); await f.service.start("router", pid);
      const d = f.service.doc.dispatches[0], turnsBefore = f.turns.length;
      for (const [decision, reason] of [["approve", "用户已明确授权写入项目交付物"], ["reject", "申请与本次任务无关"], ["defer", "需要用户选择发布渠道"]] as const) {
        await f.service.recordApprovalDecision(d.id, decision, reason);
        const event = f.service.doc.events.at(-1)!;
        assert.equal(event.projectId, pid); assert.equal(event.kind, "system"); assert.equal(event.who, "sol");
        assert.ok(event.text.includes(reason)); assert.ok(event.text.includes(d.id));
      }
      await f.service.dispatch("single-router", { agentId: "generalist", brief: "单件任务" });
      const single = f.service.doc.dispatches.at(-1)!, eventsBefore = f.service.doc.events.length;
      await f.service.recordApprovalDecision(single.id, "defer", "单件任务保留工具对话理由");
      await f.service.recordApprovalDecision("unknown-task", "reject", "不存在");
      assert.equal(f.service.doc.events.length, eventsBefore);
      assert.equal(f.turns.length, turnsBefore + 1, "recording approvals must not start model turns");
      const g = fixture(savedFile); await g.store.load();
      const records = g.service.doc.events.filter(e => e.kind === "system");
      assert.equal(records.length, 3); assert.match(records.map(e => e.text).join("\n"), /批准.*拒绝.*交由用户决定/su);
      ok("总助审批复用项目记录，理由持久保存；非项目不另建日志");
    }
    {
      const f = fixture(file()); await f.service.initialize(); const pid = await propose(f);
      assert.ok(!createCompanyRouterTools(f.service, "router").some(t => t.name === "project_start"));
      assert.doesNotMatch(companyRouterPrompt(), /project_start/u);
      assert.match(companyRouterPrompt(), /用户/u); assert.match(companyWorkerPrompt(), /用户/u);
      await f.service.cancelProposal("router", pid);
      assert.equal(f.service.projectOf(pid)?.status, "cancelled"); assert.equal(f.created.length, 0); assert.equal(f.folders.length, 0);
      assert.match(f.turns.at(-1)!.text, /项目已取消.*|用户选择先不开/u);
      assert.match(f.turns.at(-1)!.text, /等待用户的下一步要求/u);
      assert.match(await f.service.start("router", pid), /已取消/u);
      const newPid = await propose(f); assert.notEqual(newPid, pid);
      ok("模型没有开工工具，先不开会取消提案并通知总助等下一步");
    }
    console.log(`company scheduler tests: ${passed} passed`);
  } finally { await rm(dir, { recursive: true, force: true }); }
}
