import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { parse } from "postcss";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { Platform, TFolder, displayedTooltipsForTests, openTestModals, openTestNoticeMessages, setTooltipDisplayForTests } from "obsidian";
import { CompanyStore } from "../company/store";
import { CompanyService, type CompanyHost } from "../company/service";
import { companyApprovals, companyDecisionBinding, CompanyInteractionController, observeCompanyInteractions } from "../company/interaction-bridge";
import { chooseCompanyProjectRoot, companyRouterPermission, ensureCompanyProjectFolder } from "../company/folder-bridge";
import { createCompanyHost, startCompanyService } from "../company/plugin-host";
import { CompanyConversationCard } from "../ui/codex-view/company-card";
import { CodexMessageListRenderer } from "../ui/codex-view/message-list";
import { CodexView } from "../ui/codex-view";
import { InteractionDockController } from "../ui/codex-view/interaction-dock";
import { PiAgentApprovalBroker } from "../plugin/pi-agent-approval-broker";
import { ProjectPageView } from "../home/project-page";
import { EchoInkWorkbenchView } from "../home/workbench-view";
import { normalizeAgentRegistry } from "../agents/registry";
import { emptyKnowledgeFolderBindings } from "../knowledge-base/folder-bindings";
import { installCompanyTestDom } from "./company-ui";
import type CodexForObsidianPlugin from "../main";

const agents = [{ id: "sol", name: "总助" }, { id: "lin", name: "研究员" }, { id: "june", name: "文案" }];
const waitUntil = async (condition: () => boolean) => {
  for (let i = 0; i < 100 && !condition(); i++) await new Promise(r => setTimeout(r, 10));
  assert.ok(condition(), "异步任务状态应已落盘");
};

/** Real brokers, store transitions and the actual page/group renderers; no Provider or Vault is used. */
export async function runCompanyInteractionTests(document: Document): Promise<void> {
  installCompanyTestDom(document);
  const root = await mkdtemp(path.join(tmpdir(), "echoink-company-interactions-"));
  try {
    await sharedSurfaces(document, path.join(root, "shared.json"));
    await questionDraftSurvivesProjectRefresh(document, path.join(root, "question-draft.json"));
    await approvalFocusContrast(document);
    await compactTooltipLifecycle(document);
    await proposalAndAcceptance(document, path.join(root, "proposal.json"));
    await folderAndHost(document);
    await startupRestoration(path.join(root, "restore"));
    await reportDeliveryAfterApproval(path.join(root, "approved-report"), true);
    await reportDeliveryAfterApproval(path.join(root, "uncertain-report"), false);
    console.log("PASS company interactions: H3/H4 shared broker and Question surfaces, M1 proposal, M5 directory/access, M6 truthful acceptance, final-report outbox drains once after approval turns");
  } finally { await rm(root, { recursive: true, force: true }); }
}

async function compactTooltipLifecycle(document: Document): Promise<void> {
  const previousDesktop = Platform.isDesktopApp; Platform.isDesktopApp = true;
  const container = document.body.createDiv(), dock = new InteractionDockController();
  let shown = 0;
  const restore = setTooltipDisplayForTests((element, value, options) => {
    shown++;
    const bubble = document.body.createDiv({ cls: ["tooltip", ...(options?.classes ?? [])], text: String(value) });
    bubble.setAttribute("data-compact-tooltip-test", "");
  });
  const input = { sessionId: "tooltip-approval", companyCompact: { name: "研究员", context: "完整项目名" }, confirmation: {
    binding: { target: "目录/完整保存文件夹/文章.md", preview: "待写内容", decide: () => false }, onResolved() {} }, onStale() {}, onScheduleMeasure() {} };
  const tick = () => new Promise(resolve => setTimeout(resolve, 5));
  const bubbles = () => document.querySelectorAll(".tooltip[data-compact-tooltip-test]").length;
  try {
    dock.render(container, input);
    const heading = container.querySelector<HTMLElement>("h2")!, oldSummary = container.querySelector<HTMLElement>(".echoink-company-compact-summary")!;
    assert.ok(heading.hasAttribute("data-echoink-native-tooltip")); assert.ok(oldSummary.hasAttribute("data-echoink-native-tooltip"));
    assert.equal(heading.hasAttribute("aria-label"), false, "原生封装移除宿主重复hover fallback");
    const metaName = oldSummary.getAttribute("aria-labelledby")!.split(/\s+/u).map(id => document.getElementById(id)?.textContent).join(" ");
    assert.equal(metaName, "研究员 · 完整项目名 · 目录/完整保存文件夹 · 详情", "metadata无障碍名称保留完整值与详情动作");
    heading.dispatchEvent(new document.defaultView!.Event("focus"));
    assert.equal(displayedTooltipsForTests.get(heading), "执行本次操作 文章.md"); assert.equal(shown, 1);
    heading.dispatchEvent(new document.defaultView!.Event("blur")); assert.equal(bubbles(), 0);
    oldSummary.dispatchEvent(new document.defaultView!.Event("mouseenter"));
    await waitUntil(() => shown === 2);
    assert.equal(displayedTooltipsForTests.get(oldSummary), "研究员 · 完整项目名 · 目录/完整保存文件夹"); assert.equal(bubbles(), 1);
    dock.render(container, input);
    assert.equal(bubbles(), 0, "重绘释放已显示的原生提示");
    oldSummary.dispatchEvent(new document.defaultView!.Event("mouseenter")); await tick(); assert.equal(shown, 2, "旧挂载的监听已移除");
    const summary = container.querySelector<HTMLElement>(".echoink-company-compact-summary")!;
    summary.dispatchEvent(new document.defaultView!.Event("mouseenter")); await waitUntil(() => shown === 3); assert.equal(bubbles(), 1, "重绘后只有一个提示");
    dock.render(container, { sessionId: input.sessionId, companyCompact: input.companyCompact, onStale() {}, onScheduleMeasure() {} });
    assert.equal(bubbles(), 0, "隐藏交互释放提示");
    summary.dispatchEvent(new document.defaultView!.Event("mouseenter")); await tick(); assert.equal(shown, 3);
    dock.render(container, { sessionId: "tooltip-question", companyCompact: input.companyCompact,
      question: { binding: { interaction: { kind: "question", status: "pending", conversationId: "tooltip-question", piSessionId: "pi", turnId: "run", interactionId: "tooltip-q", createdAt: 1, updatedAt: 1,
        questions: [{ questionId: "q", prompt: "超过两行后仍能查看的完整问题原文", selection: "single", options: [{ optionId: "a", label: "选项" }], allowSupplement: true }] }, submit: () => false }, onResolved() {} }, onStale() {}, onScheduleMeasure() {} });
    const prompt = container.querySelector<HTMLElement>("h2")!;
    prompt.dispatchEvent(new document.defaultView!.Event("focus"));
    assert.equal(displayedTooltipsForTests.get(prompt), "超过两行后仍能查看的完整问题原文"); assert.equal(shown, 4);
    dock.dispose(); assert.equal(bubbles(), 0, "销毁Dock释放所有提示与监听");
    prompt.dispatchEvent(new document.defaultView!.Event("focus")); assert.equal(shown, 4);
  } finally { dock.dispose(); restore(); container.remove(); Platform.isDesktopApp = previousDesktop; }
}

/** Scoped CSS/contrast regression only; the controller owns the separate native rendering acceptance. */
async function approvalFocusContrast(document: Document): Promise<void> {
  const sheet = parse(await readFile("src/styles/agent-tasks.css", "utf8"));
  let selector = ""; const declarations = new Map<string, string>();
  sheet.walkRules(rule => {
    if (!rule.selector.includes(".echoink-company-interaction-dock") || !rule.selector.includes(":focus-visible")) return;
    const values = new Map<string, string>(); rule.walkDecls(declaration => { values.set(declaration.prop, declaration.value); });
    if (!values.has("color")) return;
    selector = rule.selector; for (const [name, value] of values) declarations.set(name, value);
  });
  assert.ok(selector, "公司批准焦点态必须同时声明前景，不能仅换背景");
  const host = document.body.createDiv();
  const dock = new InteractionDockController();
  const surface = host.createDiv({ cls: "codex-interaction-dock echoink-company-interaction-dock" });
  dock.render(surface, { sessionId: "focus-fixture", confirmation: { binding: { target: "新增.md", preview: "完整正文", decide: () => false }, onResolved() {} }, onStale() {}, onScheduleMeasure() {} });
  const approve = surface.querySelector<HTMLButtonElement>(".is-approve")!;
  try {
    approve.focus(); assert.equal(approve.disabled, false); assert.ok(approve.matches(":focus-visible"));
    assert.ok(approve.matches(selector), "规则覆盖实际InteractionDock默认聚焦的普通批准按钮");
    approve.blur(); assert.equal(approve.matches(selector), false, "未聚焦主按钮不受影响");
    approve.focus(); approve.classList.add("echoink-delete-button"); assert.equal(approve.matches(selector), false, "删除批准沿原危险按钮规则"); approve.classList.remove("echoink-delete-button");
    surface.classList.remove("echoink-company-interaction-dock"); assert.equal(approve.matches(selector), false, "公司以外主按钮不受影响"); surface.classList.add("echoink-company-interaction-dock");
    assert.equal(declarations.get("outline"), "none"); assert.equal(declarations.get("box-shadow"), "none");
    const rgba = (value: string): number[] => value.startsWith("#")
      ? [1, 3, 5].map(offset => parseInt(value.slice(offset, offset + 2), 16)).concat(1)
      : value.match(/[\d.]+/gu)!.map(Number);
    const composite = (color: number[], base: number[]) => color.slice(0, 3).map((channel, index) => channel * (color[3] ?? 1) + base[index] * (1 - (color[3] ?? 1)));
    const luminance = (color: number[]) => color.map(channel => channel / 255).map(channel => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
      .reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
    for (const dark of [false, true]) {
      const base = dark ? [30, 30, 30] : [255, 255, 255];
      const variables: Record<string, string> = { "--background-modifier-hover": dark ? "rgba(255,255,255,0.067)" : "rgba(0,0,0,0.067)",
        "--text-normal": dark ? "#dddddd" : "#222222", "--echoink-control-fill": "#7c3aed", "--echoink-control-on-fill": "#ffffff" };
      const resolve = (value: string) => value.replace(/var\((--[\w-]+)\)/gu, (_, name: string) => { assert.ok(variables[name], `Missing fixture color ${name}`); return variables[name]; });
      const background = composite(rgba(resolve(declarations.get("background")!)), base);
      const foreground = composite(rgba(resolve(declarations.get("color")!)), background);
      const levels = [luminance(background), luminance(foreground)].sort((a, b) => b - a);
      assert.ok((levels[0] + 0.05) / (levels[1] + 0.05) >= 4.5, `${dark ? "dark" : "light"}: 聚焦批准前景/背景对比至少4.5`);
    }
  } finally { dock.dispose(); host.remove(); }
}

async function questionDraftSurvivesProjectRefresh(document: Document, file: string): Promise<void> {
  const f = await fixture(file), routerId = "draft-router";
  await f.service.propose(routerId, { name: "并行项目", goal: "保留问题草稿", criteria: ["草稿不丢"], roles: {},
    plan: ["ask", "write-a", "write-b"].map((id, index) => ({ id, agentId: index === 1 ? "june" : "lin", label: id, brief: id, dependsOn: [] })) });
  const project = f.service.projectForRouter(routerId)!; await f.service.start(routerId, project.id);
  const [question, ...siblings] = f.service.doc.dispatches.filter(dispatch => dispatch.projectId === project.id);
  await f.service.report(question.id, { outcome: "need_decision", summary: "需要决定", question: "选哪个？", outputs: [] });
  f.running.delete(question.id); await f.service.onWorkerSettled(question.id, "completed", 0);
  const waits: Promise<boolean>[] = [];
  for (const dispatch of siblings) {
    const identity = { conversationId: dispatch.id, piSessionId: `pi-${dispatch.id}`, productRunId: `turn-${dispatch.id}`, toolCallId: "write" };
    waits.push(f.broker.waitForDecision({ ...identity, requestId: `req-${dispatch.id}`, target: "稿件.md", preview: "本次写入" }));
    f.pending.set(dispatch.id, { kind: "confirmation", status: "pending", ...identity, turnId: identity.productRunId });
  }
  const base = Object.getPrototypeOf(ProjectPageView.prototype) as { setState?: () => Promise<void> }; base.setState ??= async () => {};
  const page = new ProjectPageView({} as never, f.typedPlugin), content = document.body.createDiv();
  Object.assign(page, { contentEl: content, app: { workspace: { on: () => ({}) }, vault: { getAbstractFileByPath: () => null } } });
  await page.setState({ projectId: project.id }, {} as never); await page.onOpen();
  const selected = () => content.querySelector<HTMLTextAreaElement>('.codex-interaction-question-card textarea')!;
  const firstInput = selected(); firstInput.value = "第二项"; firstInput.dispatchEvent(new document.defaultView!.Event("input"));
  try {
    assert.equal(content.querySelectorAll(".codex-interaction-confirmation-card").length, 2);
    assert.match(content.querySelector('[data-pp-focus="tile-task"]')?.textContent ?? "", /3 等你定/u, "任务tile合并两张审批与一个问题计数");
    content.querySelector<HTMLButtonElement>(".is-approve")!.click(); await waits[0];
    assert.notEqual(selected(), firstInput, "兄弟审批移除确实重建了项目DOM");
    assert.equal(selected().value, "第二项", "第一张审批移除后保留自由回答草稿");
    content.querySelector<HTMLButtonElement>(".is-approve")!.click(); await waits[1];
    assert.equal(selected().value, "第二项", "第二张审批移除后保留自由回答草稿");
    for (const dispatch of siblings) {
      await f.service.report(dispatch.id, { outcome: "done", summary: "同事已交稿", outputs: [] });
      f.running.delete(dispatch.id); await f.service.onWorkerSettled(dispatch.id, "completed", 0);
      assert.equal(selected().value, "第二项", "其它员工汇报并刷新记录后保留自由回答草稿");
    }
    content.querySelector<HTMLButtonElement>(".codex-interaction-action.is-primary")!.click();
    await waitUntil(() => f.service.dispatchOf(question.id)?.status === "running");
    assert.equal(f.service.dispatchOf(question.id)?.answer, "第二项", "重绘后可直接提交原选项，无需重新选择");
  } finally { await page.onClose(); content.remove(); f.broker.dispose(); }
}

async function reportDeliveryAfterApproval(root: string, approve: boolean): Promise<void> {
  const routerId = "report-router", workerId = "final-worker", approvalWorker = "approval-worker";
  const seed = new CompanyStore(path.join(root, ".obsidian/plugins/company-fixture/pi-agent-product-v1/company.v1.json"));
  await seed.mutate(doc => ({ ...doc, dispatches: [workerId, approvalWorker].map(id => ({ id, routerConversationId: routerId,
    agentId: "lin", brief: id === workerId ? "交付最终稿" : "写项目文件", status: "running", permission: "workspace-write",
    createdAt: 1, startedAt: 1, turns: 1 })) }));
  const active = new Set([routerId, workerId, approvalWorker]);
  const callbacks = new Set<(id: string, outcome: string, at: number) => void>(), subscriptions = new Set<() => void>(), releases: (() => void)[] = [];
  const settlements: Promise<void>[] = [], flushes: Promise<void>[] = [], ordinaryTurns: any[] = [], approvalTurns: any[] = [];
  let steerCount = 0, resolveApproval!: (outcome: string) => void;
  const approvalCompletion = new Promise<string>(resolve => { resolveApproval = resolve; });
  const settings: any = { sessions: [{ id: workerId, agentId: "lin", companyRole: "worker", taskStatus: "running" },
    { id: approvalWorker, agentId: "lin", companyRole: "worker", taskStatus: "running" },
    { id: routerId, agentId: "sol", companyRole: "router", taskStatus: "running" }], defaultPermission: "workspace-write", defaultMode: "agent", memory: {},
    taskWorkspace: { replyDrafts: {} }, knowledgeBase: { folderBindings: emptyKnowledgeFolderBindings() },
    agentRegistry: normalizeAgentRegistry({ schemaVersion: 1, agents: agents.map(agent => ({ ...agent,
      ...(agent.id === "sol" ? { companyApprovalMode: "assistant" } : {}) })), moduleOwners: {} }) };
  const options = { permission: "workspace-write", mode: "agent", model: "offline", providerSettingsId: "offline" };
  const broker = new PiAgentApprovalBroker(), pending = new Map();
  const changed = () => { for (const listener of [...subscriptions]) listener(); };
  const runs = { pendingInteractions: pending, lastTurnOptions: new Map<string, any>([[routerId, options], [approvalWorker, options]]),
    isTurnActive: (id: string) => active.has(id), refreshTask: changed,
    subscribe: (subscriber: { refresh(): void }) => { const listener = () => subscriber.refresh(); subscriptions.add(listener); return () => subscriptions.delete(listener); },
    onTurnSettled: (callback: (id: string, outcome: string, at: number) => void) => { callbacks.add(callback); return () => callbacks.delete(callback); },
    start: async (item: any) => { ordinaryTurns.push(item); runs.lastTurnOptions.set(item.sessionId, item.turnOptions); active.add(item.sessionId); return "running"; },
    run: async (item: any) => { approvalTurns.push(item); runs.lastTurnOptions.set(item.sessionId, item.turnOptions); active.add(item.sessionId); return await approvalCompletion; } };
  const plugin: any = { settings, companyService: null, companyApprovalCoordinator: null, getVaultPath: () => root,
    getPluginDataDirName: () => ".obsidian/plugins/company-fixture", getConversationRunService: () => runs, getCodexView: () => null,
    readPiConversationCatalogEntry: async (id: string) => ({ conversationId: id, agentId: id === routerId ? "sol" : "lin", companyRole: id === routerId ? "router" : "worker" }),
    readPiConversationProjection: async () => ({ messages: [{ role: "assistant", text: "最终稿已完成" }] }),
    piAgentApprovalBinding: (identity: Parameters<PiAgentApprovalBroker["bindingFor"]>[0]) => broker.bindingFor(identity),
    steerPiConversation: async () => { steerCount++; }, setPiConversationTaskMetadata: async () => {},
    notifyHomeSurfacesChanged() {}, register: (release: () => void) => releases.push(release) };
  try {
    const service = await startCompanyService(plugin); assert.ok(service);
    const settle = service.onWorkerSettled.bind(service), flush = service.flushPendingReports.bind(service);
    service.onWorkerSettled = (...args) => { const flight = settle(...args); settlements.push(flight); return flight; };
    service.flushPendingReports = () => { const flight = flush(); flushes.push(flight); return flight; };
    const emit = (id: string) => { for (const callback of [...callbacks]) callback(id, "completed", 0); };
    const drainFlushes = async () => { let done = 0; while (done < flushes.length) { const batch = flushes.slice(done); done = flushes.length; await Promise.all(batch); } };
    const identity = { conversationId: approvalWorker, piSessionId: "approval-session", productRunId: "approval-run", toolCallId: "write" };
    const waiting = broker.waitForDecision({ ...identity, requestId: "approval-report-ticket", target: "最终稿.md", preview: '{"action":"write","path":"最终稿.md"}' });
    // Uncertain judgments deliberately leave this ticket for the human; disposal rejects that live wait.
    void waiting.catch(() => {});
    pending.set(approvalWorker, { kind: "confirmation", status: "pending", ...identity, turnId: identity.productRunId }); changed();
    assert.equal(plugin.companyApprovalCoordinator.hasPendingJudgment(routerId), true, "router仍在普通轮次时审批排队");
    await service.report(workerId, { outcome: "done", summary: "最终稿已完成", outputs: [] });
    settings.sessions[0].taskStatus = "completed"; active.delete(workerId); emit(workerId); await Promise.all(settlements);
    assert.ok(service.dispatchOf(workerId)?.reportPending, "排队审批期间最终汇报保留outbox");
    assert.equal(steerCount, 0); assert.equal(ordinaryTurns.length, 0);
    active.delete(routerId); emit(routerId);
    await waitUntil(() => approvalTurns.length === 1); await drainFlushes();
    assert.ok(service.dispatchOf(workerId)?.reportPending, "审批专用轮次不能接收最终汇报");
    assert.equal(steerCount, 0); assert.equal(ordinaryTurns.length, 0);
    if (approve) {
      const key = approvalTurns[0].turnOptions.companyApprovalKey;
      const tool = plugin.companyApprovalCoordinator.decisionTool(routerId, key); assert.ok(tool);
      await tool.execute("approve-report", { decision: "approve", reason: "项目需要的普通写入" });
      assert.equal(await waiting, true); await drainFlushes();
      assert.equal(plugin.companyApprovalCoordinator.hasPendingJudgment(routerId), false);
      assert.ok(active.has(routerId)); assert.ok(runs.lastTurnOptions.get(routerId).companyApprovalKey);
      assert.ok(service.dispatchOf(workerId)?.reportPending, "即使已决定，仍在运行的审批专用轮次也不能吞汇报");
      assert.equal(ordinaryTurns.length, 0);
    }
    // Match ConversationRunService: listeners run before its awaited run() Promise returns.
    active.delete(routerId); emit(routerId); await drainFlushes(); resolveApproval("completed");
    await waitUntil(() => ordinaryTurns.length === 1 && !service.dispatchOf(workerId)?.reportPending); await drainFlushes();
    assert.match(ordinaryTurns[0].text, /最终稿已完成/u);
    assert.equal(ordinaryTurns[0].turnOptions.companyApprovalKey, undefined, "最终汇报启动普通轮次");
    assert.equal(ordinaryTurns[0].turnOptions.companyProgrammatic, true);
    assert.equal(steerCount, 0);
    active.delete(routerId); emit(routerId); await drainFlushes(); assert.equal(ordinaryTurns.length, 1, "重复settled不重送同一份汇报");
  } finally { for (const release of releases.reverse()) release(); resolveApproval("cancelled"); broker.dispose(); }
}

async function startupRestoration(root: string): Promise<void> {
  const file = path.join(root, ".obsidian/plugins/company-fixture/pi-agent-product-v1/company.v1.json");
  const seed = new CompanyStore(file);
  await seed.mutate(doc => ({ ...doc, dispatches: [{ id: "restored-worker", routerConversationId: "restored-router", agentId: "lin",
    brief: "继续研究", status: "running", permission: "workspace-write", createdAt: 1, startedAt: 1, turns: 1 }] }));
  const callbacks = new Set<(id: string, outcome: string, at: number) => void>(), subscriptions = new Set<() => void>(), releases: (() => void)[] = [];
  const settlements: Promise<void>[] = [];
  let observed = false;
  const settings: any = { sessions: [{ id: "restored-worker", agentId: "lin", companyRole: "worker", taskStatus: "running" },
    { id: "restored-router", agentId: "sol", companyRole: "router" }], defaultPermission: "workspace-write", memory: {},
    taskWorkspace: { replyDrafts: {} }, knowledgeBase: { folderBindings: emptyKnowledgeFolderBindings() },
    agentRegistry: normalizeAgentRegistry({ schemaVersion: 1, agents, moduleOwners: {} }) };
  const options = { permission: "workspace-write", mode: "agent", model: "offline", providerSettingsId: "offline" };
  const runs = { pendingInteractions: new Map(), lastTurnOptions: new Map([["restored-router", options]]), isTurnActive: () => false,
    refreshTask: () => { for (const listener of [...subscriptions]) listener(); },
    subscribe: (subscriber: { refresh(): void }) => { const listener = () => subscriber.refresh(); subscriptions.add(listener); return () => subscriptions.delete(listener); },
    onTurnSettled: (callback: (id: string, outcome: string, at: number) => void) => { callbacks.add(callback); return () => callbacks.delete(callback); },
    start: async (item: { sessionId: string }) => {
      if (item.sessionId === "restored-worker") {
        assert.ok(plugin.companyService?.dispatchOf(item.sessionId), "恢复开工前service已挂到plugin");
        assert.ok(callbacks.size >= 2, "恢复开工前coordinator和worker settled listener已挂好");
        const original = plugin.companyService.onWorkerSettled.bind(plugin.companyService);
        plugin.companyService.onWorkerSettled = (...args: Parameters<CompanyService["onWorkerSettled"]>) => {
          const flight = original(...args); settlements.push(flight); return flight;
        };
        settings.sessions[0].taskStatus = "completed"; observed = true;
        for (const callback of [...callbacks]) callback(item.sessionId, "completed", 0);
      }
      return "completed";
    } };
  const plugin: any = { settings, companyService: null, companyApprovalCoordinator: null, getVaultPath: () => root,
    getPluginDataDirName: () => ".obsidian/plugins/company-fixture", getConversationRunService: () => runs, getCodexView: () => null,
    readPiConversationProjection: async () => ({ messages: [{ role: "assistant", text: "恢复完成" }] }),
    setPiConversationTaskMetadata: async () => {}, notifyHomeSurfacesChanged() {}, register: (release: () => void) => releases.push(release) };
  try {
    const service = await startCompanyService(plugin);
    assert.ok(service, "真实host恢复链成功初始化");
    await Promise.all(settlements);
    assert.equal(service.dispatchOf("restored-worker")?.status, "done");
    assert.ok(observed); assert.equal(service.dispatchOf("restored-worker")?.report?.summary, "恢复完成", "恢复过程中同步settle也不会丢汇报");
  } finally { for (const release of releases.reverse()) release(); }
}

async function fixture(file: string) {
  let clock = 1000, seq = 0;
  const running = new Set<string>(), turns: string[] = [], notifications: string[] = [];
  const listeners = new Set<() => void>();
  const changed = () => { for (const listener of [...listeners]) listener(); };
  const pending = new Map();
  const host: CompanyHost = { now: () => ++clock, newId: prefix => `${prefix}-${++seq}`,
    agents: () => agents.map(agent => ({ ...agent, position: "", hired: true })), routerPermission: () => "workspace-write",
    createWorker: async () => {}, startTurn: async id => { running.add(id); turns.push(id); },
    isRunning: id => running.has(id), steer: async () => false, stop: async id => { running.delete(id); },
    lastAssistantText: async () => undefined, latestUserText: async () => "做一期视频", setRouterMetadata: async () => {},
    ensureFolder: async name => `项目/${name}`, notifyDecision: async id => { notifications.push(id); changed(); } };
  const service = new CompanyService(new CompanyStore(file), host); await service.initialize();
  const broker = new PiAgentApprovalBroker();
  const plugin = { companyService: service, companyApprovalCoordinator: null, settings: { sessions: [], settingsLanguage: "zh-CN",
    agentRegistry: normalizeAgentRegistry({ schemaVersion: 1, agents, moduleOwners: {} }) },
    getConversationRunService: () => ({ pendingInteractions: pending, refreshTask: changed, subscribe: (subscriber: { refresh(): void }) => {
      const listener = () => subscriber.refresh(); listeners.add(listener); return () => listeners.delete(listener);
    } }),
    piAgentApprovalBinding: (identity: Parameters<PiAgentApprovalBroker["bindingFor"]>[0]) => broker.bindingFor(identity),
    setPiConversationTaskMetadata: async (id: string) => { notifications.push(id); }, notifyHomeSurfacesChanged() {},
    activateProjectPage: async () => {}, activateHomeView: async () => {}, openTaskDetail: async () => {} };
  const typedPlugin = plugin as unknown as CodexForObsidianPlugin;
  const makeProject = async (router = "router") => {
    await service.propose(router, { name: "视频", goal: "讲清架构", criteria: ["五分钟"], roles: { lin: "研究", june: "写作" },
      plan: [{ id: "research", agentId: "lin", label: "研究", brief: "查资料", dependsOn: [], milestone: "资料" },
        { id: "copy", agentId: "june", label: "写作", brief: "写稿", dependsOn: ["research"], milestone: "成片" }] });
    return service.projectForRouter(router)!;
  };
  return { plugin, typedPlugin, service, host, running, turns, notifications, changed, listeners, pending, broker, makeProject };
}

async function sharedSurfaces(document: Document, file: string): Promise<void> {
  const f = await fixture(file), { service, typedPlugin, broker } = f;
  const project = await f.makeProject(); await service.start("router", project.id);
  const task = service.doc.dispatches.find(d => d.projectId === project.id)!;
  await service.dispatch("quick-router", { agentId: "june", brief: "查一个标题" });
  const quick = service.doc.dispatches.find(d => !d.projectId)!;
  const waits = new Map<string, Promise<boolean>>();
  const preview = JSON.stringify({ operation: "note_create", relativePath: "稿件.md", change: { kind: "add", relativePath: "稿件.md",
    added: 2, removed: 0, diff: "--- a/稿件.md\n+++ b/稿件.md\n@@ -1,0 +1,2 @@\n+一人公司小活验证\n+保留完整正文", truncated: false },
    byteLength: 45, contentSha256: "fixture-sha256" });
  for (const dispatch of [task, quick]) {
    const identity = { conversationId: dispatch.id, piSessionId: `pi-${dispatch.id}`, productRunId: `turn-${dispatch.id}`, toolCallId: "write" };
    waits.set(dispatch.id, broker.waitForDecision({ ...identity, requestId: `req-${dispatch.id}`, target: "稿件.md", preview }));
    f.pending.set(dispatch.id, { kind: "confirmation", status: "pending", ...identity, turnId: identity.productRunId });
  }
  assert.equal(companyApprovals(typedPlugin, service.doc).length, 2);
  const key = companyApprovals(typedPlugin, service.doc)[0].key;
  Object.assign(f.plugin, { companyApprovalCoordinator: { isJudging: (candidate: string) => candidate === key, subscribe: () => () => {} } });
  assert.equal(companyApprovals(typedPlugin, service.doc, { projectId: project.id }).length, 0, "自动判断中不出人工卡");
  assert.equal(companyApprovals(typedPlugin, service.doc, { includeJudging: true }).length, 2, "coordinator仍可读取原票据");
  Object.assign(f.plugin, { companyApprovalCoordinator: null });

  const base = Object.getPrototypeOf(ProjectPageView.prototype) as { setState?: () => Promise<void> };
  base.setState ??= async () => {};
  const page = new ProjectPageView({} as never, typedPlugin), content = document.body.createDiv();
  Object.assign(page, { contentEl: content, app: { workspace: { on: () => ({}) }, vault: { getAbstractFileByPath: () => null } } });
  await page.setState({ projectId: project.id }, {} as never); await page.onOpen();
  const groupHost = document.body.createDiv();
  groupHost.createDiv({ attr: { "data-wb-group": "projects" } });
  const workbench = Object.create(EchoInkWorkbenchView.prototype) as any;
  Object.assign(workbench, { plugin: typedPlugin, companyService: service, companyInteractions: new CompanyInteractionController(typedPlugin),
    entries: [task, quick].map(dispatch => ({ conversationId: dispatch.id, status: "active", taskStatus: "waiting", updatedAt: 1 })),
    maintenance: new Map(), field: () => groupHost, disposeControls() {}, render: () => workbench.renderCompanyDecisions() });
  workbench.render();
  const off = f.plugin.getConversationRunService().subscribe({ refresh: workbench.render });
  const offCompany = service.subscribe(workbench.render);
  assert.equal(groupHost.firstElementChild?.getAttribute("data-wb-group"), "company-decisions", "工作台等你定复用顶层分组且排最前");
  assert.equal(groupHost.querySelector(".wb-count")?.textContent, "2");
  assert.equal(content.querySelectorAll(".echoink-company-interaction").length, 1, "项目页只显示本项目审批");
  const taskTile = content.querySelector('[data-pp-focus="tile-task"]')!;
  assert.match(taskTile.textContent ?? "", /1 等你定/u, "任务tile显示live审批等待");
  assert.ok(!taskTile.textContent?.includes("排队中"), "等待批准不能显示排队中");
  assert.equal(groupHost.querySelectorAll(".echoink-company-interaction").length, 2, "小活审批仅工作台可处理");
  workbench.group("waiting", "等你回应", 2, false);
  assert.equal(workbench.taskGroups(Date.now()).waiting.length, 0, "顶层审批卡已有的员工不再重复进普通等你回应组");
  workbench.taskGroup("waiting", "等你回应", workbench.taskGroups(Date.now()).waiting, Date.now());
  assert.equal(groupHost.querySelector('[data-wb-group="waiting"]'), null, "真实普通组渲染移除旧查看并确认行");
  const ordinary = { conversationId: "ordinary-task", status: "active", taskStatus: "waiting", updatedAt: 1 };
  workbench.entries.push(ordinary);
  assert.deepEqual(workbench.taskGroups(Date.now()).waiting.map((entry: { conversationId: string }) => entry.conversationId), ["ordinary-task"], "非公司任务的普通待回应行保留");
  workbench.entries.pop();
  assert.equal(content.querySelector(".echoink-company-interaction-owner"), null, "员工名不再外置成第三行");
  assert.equal(content.querySelector(".echoink-company-compact-title")?.textContent, "新建 稿件.md");
  assert.equal(content.querySelector(".echoink-company-compact-meta")?.textContent, "研究员", "项目页省略重复项目名");
  assert.ok(groupHost.querySelector(".echoink-company-compact-meta")?.textContent?.includes("视频"), "工作台保留项目上下文");
  assert.equal(content.querySelector<HTMLDetailsElement>(".echoink-company-compact-details")?.open, false);
  assert.equal(content.querySelector(".codex-smooth-ai-approval-header"), null, "紧凑卡不显示等待批准的冗余标题");
  const compactSheet = parse(await readFile("src/styles/agent-tasks.css", "utf8"));
  const compactStyle = (element: Element) => {
    const values = new Map<string, string>();
    compactSheet.walkRules(rule => {
      let matches = false; try { matches = element.matches(rule.selector); } catch { /* Pseudo-element rules do not style this element. */ }
      if (matches) rule.walkDecls(declaration => { values.set(declaration.prop, declaration.value); });
    });
    return values;
  };
  const compactCard = content.querySelector(".echoink-company-compact-card")!;
  const cardStyle = compactStyle(compactCard), headStyle = compactStyle(compactCard.querySelector(".echoink-company-compact-head")!);
  assert.equal(cardStyle.get("padding"), "10px 12px"); assert.equal(cardStyle.get("border-radius"), "8px"); assert.equal(cardStyle.get("gap"), "4px");
  assert.equal(headStyle.get("min-height"), "28px"); assert.equal(headStyle.get("gap"), "8px");
  assert.equal(compactStyle(compactCard.querySelector(".echoink-company-compact-avatar")!).get("width"), "20px");
  const titleStyle = compactStyle(compactCard.querySelector("h2")!), metaStyle = compactStyle(compactCard.querySelector(".echoink-company-compact-meta")!);
  assert.equal(titleStyle.get("font-size"), "13px"); assert.equal(titleStyle.get("font-weight"), "600"); assert.equal(titleStyle.get("line-height"), "18px");
  assert.equal(titleStyle.get("white-space"), "nowrap"); assert.equal(titleStyle.get("text-overflow"), "ellipsis");
  const titleName = compactCard.querySelector("h2")!.getAttribute("aria-labelledby")!;
  assert.equal(document.getElementById(titleName)?.textContent, "新建 稿件.md", "标题保持完整无障碍名称");
  assert.equal(metaStyle.get("font-size"), "12px"); assert.equal(metaStyle.get("line-height"), "18px");
  assert.equal(compactStyle(compactCard.querySelector(".is-reject")!).get("min-width"), "48px");
  assert.equal(compactStyle(compactCard.querySelector(".is-approve")!).get("min-width"), "56px");
  assert.equal(compactStyle(compactCard.querySelector(".is-approve")!).get("height"), "28px");
  const approvalBody = content.querySelector(".codex-approval-presentation")!;
  const visibleFields = [...approvalBody.querySelectorAll(".codex-approval-field")].filter(field => !field.closest(".codex-approval-technical-details"));
  assert.deepEqual(visibleFields.map(field => field.querySelector(".codex-approval-field-value")?.textContent), ["稿件.md", "一人公司小活验证\n保留完整正文"]);
  assert.equal(approvalBody.querySelector(".codex-approval-action"), null, "详情不重复外层动作标题");
  const details = content.querySelector<HTMLDetailsElement>(".echoink-company-compact-details")!;
  assert.equal(details.open, false);
  assert.equal(details.querySelector("details"), null, "正文和技术内容共用一个详情");
  for (const field of ["kind", "byteLength", "contentSha256"]) assert.ok(details.textContent?.includes(field), `${field}保留在技术详情`);
  assert.ok(!visibleFields.some(field => /change\.kind|byteLength|contentSha256/u.test(field.textContent ?? "")), "原生审批预览只露操作、路径和完整正文");

  const reminder = new CompanyConversationCard(typedPlugin), chat = document.body.createDiv();
  reminder.render(chat, "quick-router");
  assert.match(chat.textContent ?? "", /去工作台/u);
  assert.equal(chat.querySelectorAll(".codex-interaction-card,.codex-smooth-ai-approval-card,textarea").length, 0, "对话提醒没有员工审批或问题控件");
  const routerChat = document.body.createDiv(); reminder.render(routerChat, "router");
  assert.match(routerChat.textContent ?? "", /去项目页/u);

  const stopObserve = observeCompanyInteractions(typedPlugin);
  await Promise.resolve();
  assert.ok(f.notifications.includes("router") && f.notifications.includes("quick-router"), "两个路由卡片均亮未读");
  const beforeApproval = f.turns.length;
  content.querySelector<HTMLButtonElement>(".is-approve")!.click();
  assert.equal(await waits.get(task.id), true, "项目页批准走原 broker");
  assert.equal(groupHost.querySelectorAll(".echoink-company-interaction").length, 1, "一处批准后另一处同步消失");
  groupHost.querySelector<HTMLButtonElement>(".is-reject")!.click();
  assert.equal(await waits.get(quick.id), false);
  assert.equal(groupHost.querySelector('[data-wb-group="company-decisions"]'), null, "空分组隐藏");
  assert.equal(f.turns.length, beforeApproval, "程序通知与批准不唤醒总助模型");

  for (const dispatch of [task, quick]) {
    await service.report(dispatch.id, { outcome: "need_decision", summary: "需要选题", outputs: [], question: "讲哪组？",
      ...(dispatch.projectId ? { options: ["一组", "两组"] } : {}) });
    f.running.delete(dispatch.id); await service.onWorkerSettled(dispatch.id, "completed", 0);
  }
  assert.equal(content.querySelectorAll(".codex-interaction-question-card").length, 1);
  assert.equal(groupHost.querySelectorAll(".codex-interaction-question-card").length, 2);
  const questionCard = content.querySelector(".codex-interaction-question-card")!;
  assert.equal(compactStyle(questionCard.querySelector("h2")!).get("-webkit-line-clamp"), "2");
  assert.equal(document.getElementById(questionCard.querySelector("h2")!.getAttribute("aria-labelledby")!)?.textContent, "讲哪组？");
  assert.equal(groupHost.querySelector(".codex-interaction-question-card .echoink-company-compact-meta")?.textContent, "研究员", "问题次行只显示员工名");
  assert.equal(workbench.taskGroups(Date.now()).waiting.length, 0, "公司need_decision同样不重复渲染普通待回应行");
  const allIds = [...document.querySelectorAll<HTMLInputElement>('.echoink-company-interaction input')].map(el => el.id);
  assert.equal(allIds.length, new Set(allIds).size, "两个挂载点的控件DOM id不重复");
  const stale = companyDecisionBinding(typedPlugin, service.dispatchOf(task.id)!);
  assert.equal(content.querySelector(".codex-interaction-action.is-primary"), null, "有选项的问题没有第二个提交按钮");
  content.querySelector<HTMLButtonElement>('.echoink-company-compact-choice[data-option-id="1"]')!.click();
  await waitUntil(() => service.dispatchOf(task.id)?.status === "running");
  assert.equal(service.dispatchOf(task.id)?.answer, "两组");
  assert.equal(stale.submit([{ questionId: task.id, selectedOptionIds: ["0"] }]), false, "旧问题不能重复回答");
  assert.equal(groupHost.querySelectorAll(".codex-interaction-question-card").length, 1, "一处答完两个挂载点都消失");
  assert.equal(content.querySelectorAll(".codex-interaction-question-card").length, 0);
  assert.equal(groupHost.querySelector("textarea")?.getAttribute("aria-label"), "你的回答");
  assert.equal(groupHost.querySelector(".codex-interaction-instruction"), null, "无选项问题不提示选择");
  groupHost.querySelector<HTMLButtonElement>(".codex-interaction-action.is-primary")!.click();
  assert.match(groupHost.querySelector(".codex-interaction-error")?.textContent ?? "", /填写回答后继续/u);
  const quickInput = groupHost.querySelector<HTMLTextAreaElement>("textarea")!; quickInput.value = "直接讲结论"; quickInput.dispatchEvent(new document.defaultView!.Event("input"));
  groupHost.querySelector<HTMLButtonElement>(".codex-interaction-action.is-primary")!.click();
  await waitUntil(() => service.dispatchOf(quick.id)?.status === "running");
  assert.equal(service.dispatchOf(quick.id)?.answer, "直接讲结论");
  assert.equal(groupHost.querySelector('[data-wb-group="company-decisions"]'), null);

  // Exercise the actual transcript renderer boundary, with the real broker binding.
  const renderer: any = new CodexMessageListRenderer(), transcript = document.body.createDiv();
  const message = { id: "approval", role: "tool", text: "", createdAt: 1, approval: { status: "pending" } };
  renderer.env = { hideApprovalCards: true, virtualListEl: transcript, settingsLanguage: "zh-CN", resolveApprovalDecision: () => assert.fail("worker transcript must not claim a ticket") };
  renderer.renderApprovalCard(transcript, message);
  assert.equal(transcript.children.length, 0, "员工会话根本不渲染审批卡");
  renderer.env.hideApprovalCards = false; renderer.env.resolveApprovalDecision = () => null;
  renderer.renderApprovalCard(transcript, message);
  assert.ok(transcript.querySelector(".codex-smooth-ai-approval-card"), "普通历史会话的审批展示保留");
  const dock = document.body.createDiv(); dock.createDiv({ text: "stale card" });
  (CodexView.prototype as any).renderInteractionDock.call({ isDispatchedTask: () => true, interactionDockEl: dock,
    interactionDock: { render: (container: HTMLElement) => container.empty() } }, { id: task.id });
  assert.equal(dock.hidden, true); assert.equal(dock.children.length, 0, "员工会话Question/Approval dock均隐藏并清空");
  stopObserve(); off(); offCompany(); workbench.companyInteractions.dispose(); reminder.dispose(); await page.onClose(); broker.dispose();
  content.remove(); groupHost.remove(); chat.remove(); routerChat.remove(); transcript.remove(); dock.remove();
}

async function proposalAndAcceptance(document: Document, file: string): Promise<void> {
  const f = await fixture(file), project = await f.makeProject(), mount = document.body.createDiv();
  const card = new CompanyConversationCard(f.typedPlugin); card.render(mount, "router");
  for (const text of ["成员", "里程碑", "预计轮次", "2 轮", "验收标准", "研究", "写作", "开工", "先不开"]) assert.ok(mount.textContent?.includes(text), text);
  assert.equal(f.turns.length, 0, "展示开工卡不发起模型调用");
  const noticeCount = openTestNoticeMessages.length;
  f.host.routerPermission = () => "read-only";
  mount.querySelector<HTMLButtonElement>(".is-primary")!.click();
  await waitUntil(() => openTestNoticeMessages.length > noticeCount);
  assert.match(openTestNoticeMessages.at(-1) ?? "", /只读/u, "只读开工展示服务返回的拒绝原因");
  assert.equal(f.service.projectOf(project.id)?.status, "proposed");
  assert.ok(mount.querySelector(".echoink-company-proposal"), "拒绝后保留开工卡");
  assert.equal(f.service.doc.dispatches.length, 0); assert.equal(f.turns.length, 0);
  f.host.routerPermission = () => "workspace-write";
  mount.querySelector<HTMLButtonElement>(".is-primary")!.click();
  await waitUntil(() => f.service.doc.dispatches.some(d => d.projectId === project.id && d.status === "running"));
  await f.service.start("router", project.id); // Wait for the first programmatic click's scheduled work to settle.
  assert.equal(openTestNoticeMessages.length, noticeCount + 1, "成功开工不额外弹提示");
  assert.equal(f.turns.filter(id => id === "router").length, 0, "开工由程序执行而非总助模型工具");
  const first = f.service.doc.dispatches.find(d => d.planTaskId === "research")!;
  await f.service.report(first.id, { outcome: "done", summary: "完成", outputs: [] }); f.running.delete(first.id); await f.service.onWorkerSettled(first.id, "completed", 0);
  const second = f.service.doc.dispatches.find(d => d.planTaskId === "copy")!;
  await f.service.report(second.id, { outcome: "done", summary: "完成", outputs: [] }); f.running.delete(second.id); await f.service.onWorkerSettled(second.id, "completed", 0);
  await f.service.accept("router", project.id, [{ criterion: "五分钟", passed: false, evidence: "还差一分钟" }], "结束");
  const banner = document.body.createDiv();
  (ProjectPageView.prototype as any).renderBanner.call({}, banner, f.service.doc, f.service.projectOf(project.id), () => undefined);
  assert.ok(banner.textContent?.includes("验收未全部通过")); assert.ok(!banner.textContent?.includes("目标已达成"), "验收未通过不宣称目标达成");
  const cancelled = await f.makeProject("cancel-router"); card.render(mount, "cancel-router");
  [...mount.querySelectorAll("button")].find(button => button.textContent === "先不开")!.click();
  await waitUntil(() => f.service.projectOf(cancelled.id)?.status === "cancelled");
  assert.equal(f.service.doc.dispatches.filter(d => d.projectId === cancelled.id).length, 0);
  card.dispose(); mount.remove(); banner.remove(); f.broker.dispose();
}

async function folderAndHost(document: Document): Promise<void> {
  let permission = "workspace-write", writes = 0, saves = 0, choices = 0;
  const folders = new Map<string, TFolder>(); const folder = new TFolder(); folder.path = "项目"; folders.set("项目", folder);
  const bindings = emptyKnowledgeFolderBindings(); bindings.roles.projects = { ...bindings.roles.projects, enabled: false, writePath: "停用目录" };
  const plugin: any = { settings: { knowledgeBase: { folderBindings: bindings }, sessions: [], taskWorkspace: { replyDrafts: {} }, memory: {},
    defaultPermission: "danger-full-access", agentRegistry: normalizeAgentRegistry({ schemaVersion: 1, agents, moduleOwners: {} }), settingsLanguage: "zh-CN" },
    app: { vault: { getAbstractFileByPath: (value: string) => folders.get(value), getAllFolders: () => [...folders.values()],
      createFolder: async (value: string) => { writes++; const f = new TFolder(); f.path = value; folders.set(value, f); } } },
    getCodexView: () => ({ companyCardAccess: () => ({ permission }) }),
    getConversationRunService: () => ({ lastTurnOptions: new Map([["router", { permission: "danger-full-access" }]]) }),
    getKnowledgeSurfaceService: () => ({ saveDirectoryBindings: async (next: typeof bindings) => { saves++; plugin.settings.knowledgeBase.folderBindings = next; } }) };
  const typed = plugin as CodexForObsidianPlugin;
  assert.equal(await ensureCompanyProjectFolder(typed, "视频", "router", async () => { choices++; return null; }), null);
  assert.equal(writes + saves, 0, "取消目录选择不保存绑定、不建目录");
  assert.equal(await ensureCompanyProjectFolder(typed, "视频", "router", async () => { choices++; return "项目"; }), "项目/视频");
  assert.equal(choices, 2, "停用的旧writePath不当成绑定"); assert.equal(saves, 1); assert.equal(writes, 1);
  assert.equal(plugin.settings.knowledgeBase.folderBindings.roles.projects.enabled, true);
  await ensureCompanyProjectFolder(typed, "视频", "router", async () => assert.fail("已有有效绑定不再选择")); assert.equal(writes, 1);
  permission = "read-only";
  assert.equal(companyRouterPermission(typed, "router"), "read-only", "当前可见权限优先于旧轮次");
  await assert.rejects(ensureCompanyProjectFolder(typed, "不创建", "router", async () => assert.fail("只读不弹选择")), /只读/u);
  assert.equal(writes, 1);
  permission = "workspace-write";
  const picker = chooseCompanyProjectRoot(typed); const modal = openTestModals.at(-1)!;
  assert.match(modal.titleEl.textContent ?? "", /项目保存到/u); modal.close(); assert.equal(await picker, null, "目录短Modal取消返回null");
  let created = 0, acceptedOptions: any; const entries = new Map<string, any>();
  const runs = { lastTurnOptions: new Map([["router", { permission: "workspace-write", mode: "agent", companyApprovalKey: "old-ticket" }]]),
    start: async (item: any) => { acceptedOptions = item.turnOptions; return "cancelled"; }, isTurnActive: () => false };
  Object.assign(plugin, { getVaultPath: () => "/offline-fixture", getConversationRunService: () => runs,
    readPiConversationCatalogEntry: async (id: string) => entries.get(id),
    createPiConversation: async (input: any) => { created++; const entry = { ...input, piSessionId: `pi-${input.conversationId}`, createdAt: 1, updatedAt: 1, status: "active" }; entries.set(input.conversationId, entry); return entry; },
    setPiConversationTaskMetadata: async () => {} });
  const host = createCompanyHost(typed);
  await Promise.all([host.createWorker({ id: "worker", agentId: "lin", title: "研究" }), host.createWorker({ id: "worker", agentId: "lin", title: "研究" })]);
  await host.createWorker({ id: "worker", agentId: "lin", title: "研究" });
  assert.equal(created, 1); assert.equal(plugin.settings.sessions.length, 1, "恢复与并发创建幂等");
  await assert.rejects(host.startTurn("worker", "继续", "workspace-write", "router"), /没能开工/u);
  assert.equal(acceptedOptions.companyProgrammatic, true); assert.equal(acceptedOptions.companyApprovalKey, undefined, "普通公司轮次不继承审批工具权限");
}
