import assert from "node:assert/strict";
import { CompanyApprovalCoordinator, createCompanyApprovalCoordinator, type CompanyApprovalDecision, type CompanyApprovalHost, type CompanyApprovalTicket } from "../company/approval-coordinator";
import { PiAgentApprovalBroker } from "../plugin/pi-agent-approval-broker";
import type { CompanyDispatch } from "../company/types";

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const gate = () => { let resolve!: () => void, reject!: (error: Error) => void; const promise = new Promise<void>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
function harness() {
  const broker = new PiAgentApprovalBroker();
  const tickets = new Map<string, { dispatch: CompanyDispatch; identity: { conversationId: string; piSessionId: string; productRunId: string; toolCallId: string } }>();
  const results = new Map<string, Promise<boolean>>();
  const runs: Array<{ routerId: string; key: string; text: string; gate: ReturnType<typeof gate> }> = [];
  const records: Array<{ taskId: string; decision: CompanyApprovalDecision; reason: string }> = [];
  let changed = () => {}, allowed = true, busy = false;
  const host: CompanyApprovalHost = {
    tickets: () => [...tickets].flatMap(([key, item]): CompanyApprovalTicket[] => {
      const binding = broker.bindingFor(item.identity); return binding ? [{ key, dispatch: item.dispatch, binding }] : [];
    }),
    canJudge: () => allowed,
    isRunning: () => busy,
    run: async (routerId, key, text) => { const pending = gate(); runs.push({ routerId, key, text, gate: pending }); await pending.promise; },
    record: async (taskId, decision, reason) => { records.push({ taskId, decision, reason }); },
    subscribe: listener => { changed = listener; return () => { changed = () => {}; }; },
    changed() {}
  };
  const coordinator = new CompanyApprovalCoordinator(host);
  const add = (key: string, options: { deletion?: boolean; permission?: CompanyDispatch["permission"]; turnPermission?: CompanyDispatch["permission"] } = {}) => {
    const identity = { conversationId: key, piSessionId: `session-${key}`, productRunId: `run-${key}`, toolCallId: `call-${key}` };
    const dispatch: CompanyDispatch = { id: key, routerConversationId: "router", agentId: "generalist", brief: "把用户指定的说明保存到项目目录", status: "running",
      permission: options.permission ?? "workspace-write", turnPermission: options.turnPermission, createdAt: 1, turns: 1 };
    tickets.set(key, { dispatch, identity });
    const result = broker.waitForDecision({ ...identity, requestId: `ticket-${key}`, target: "projects/说明.md", preview: "新增一份项目说明", deleteAction: options.deletion });
    void result.catch(() => undefined); results.set(key, result); changed();
  };
  const decide = async (key: string, decision: CompanyApprovalDecision) => {
    const tool = coordinator.decisionTool("router", key); assert.ok(tool);
    return await tool.execute(`approval-${key}`, { decision, reason: "符合用户交代的范围。" }, undefined, undefined, {} as never);
  };
  return { broker, coordinator, runs, records, results, add, decide, refresh: () => changed(),
    allowed: (value: boolean) => { allowed = value; changed(); }, busy: (value: boolean) => { busy = value; changed(); },
    dispose: () => { coordinator.dispose(); broker.dispose(); } };
}

export async function runCompanyApprovalTests(): Promise<void> {
  for (const decision of ["approve", "reject"] as const) {
    const h = harness();
    try {
      assert.equal(h.coordinator.decisionTool("router", "ordinary"), undefined, "ordinary turns have no approval tool");
      assert.equal(h.coordinator.hasPendingJudgment("router"), false);
      h.add("ticket"); h.coordinator.start();
      assert.equal(h.coordinator.isJudging("ticket"), true);
      assert.equal(h.coordinator.hasPendingJudgment("router"), true, "judging approvals defer ordinary reports");
      assert.equal(h.coordinator.hasPendingJudgment("other-router"), false, "judgments only defer their own router's reports");
      assert.equal(h.runs.length, 1);
      assert.match(h.runs[0].text, /^请判断「[^\n]+」的员工操作。$/u);
      assert.doesNotMatch(h.runs[0].text, /approval_decide|permission|preview|target|\{|projects\//u, "the persisted user prompt contains no internal approval details");
      assert.match(h.coordinator.judgmentPrompt("router", "ticket")!, /approval_decide/u);
      assert.match(h.coordinator.judgmentPrompt("router", "ticket")!, /projects\/说明.md/u);
      assert.equal(h.coordinator.judgmentPrompt("router", "other-ticket"), undefined);
      assert.equal(h.coordinator.judgmentPrompt("other-router", "ticket"), undefined);
      assert.equal(h.coordinator.decisionTool("other-router", "ticket"), undefined);
      assert.equal(h.coordinator.decisionTool("router", "other-ticket"), undefined);
      const tool = h.coordinator.decisionTool("router", "ticket")!;
      await h.decide("ticket", decision);
      assert.equal(h.coordinator.judgmentPrompt("router", "ticket"), undefined, "resolved approval details cannot enter a daily turn");
      assert.equal(h.coordinator.hasPendingJudgment("router"), false, "decided tickets leave the coordinator gate; the active approval turn gate still waits for settlement");
      assert.equal(await h.results.get("ticket"), decision === "approve", "the original broker receives the judgment");
      await assert.rejects(tool.execute("again", { decision, reason: "重复" }, undefined, undefined, {} as never), /ticket_unavailable/u);
      assert.deepEqual(h.records, [{ taskId: "ticket", decision, reason: "符合用户交代的范围。" }]);
      h.runs[0].gate.resolve(); await tick(); h.refresh();
      assert.equal(h.runs.length, 1, "one ticket is never judged twice");
    } finally { h.dispose(); }
  }
  for (const failure of ["defer", "provider-failed", "cancelled", "no-tool"] as const) {
    const h = harness();
    try {
      h.add("fallback"); h.coordinator.start();
      if (failure === "defer") await h.decide("fallback", "defer");
      if (failure === "provider-failed") h.runs[0].gate.reject(new Error("offline provider failed"));
      else h.runs[0].gate.resolve();
      await tick();
      assert.equal(h.coordinator.isJudging("fallback"), false, `${failure} returns the real ticket to the human card`);
      assert.equal(h.coordinator.hasPendingJudgment("router"), false, `${failure} in human state does not hold ordinary reports`);
      h.refresh(); h.refresh();
      assert.equal(h.runs.length, 1, `${failure} does not retry in a loop`);
      assert.equal(h.coordinator.decisionTool("router", "fallback"), undefined);
      assert.equal(h.broker.bindingFor({ conversationId: "fallback", piSessionId: "session-fallback", productRunId: "run-fallback", toolCallId: "call-fallback" })!.decide("approve"), true);
      assert.equal(await h.results.get("fallback"), true, "human decision remains on the same live binding");
    } finally { h.dispose(); }
  }
  const excluded = harness();
  try {
    excluded.add("delete", { deletion: true }); excluded.add("readonly", { permission: "read-only" }); excluded.add("downgraded", { turnPermission: "read-only" });
    excluded.coordinator.start();
    assert.equal(excluded.runs.length, 0, "deletion and read-only work never reach a model");
    for (const key of ["delete", "readonly", "downgraded"]) assert.equal(excluded.coordinator.isJudging(key), false);
    excluded.allowed(false); excluded.add("manual");
    assert.equal(excluded.runs.length, 0, "manual approval mode does not start the model");
  } finally { excluded.dispose(); }
  const queued = harness();
  try {
    queued.busy(true); queued.add("first"); queued.coordinator.start();
    assert.equal(queued.coordinator.isJudging("first"), true, "queued ticket is hidden synchronously");
    assert.equal(queued.coordinator.hasPendingJudgment("router"), true, "queued approval gates reports before a model turn starts");
    assert.equal(queued.runs.length, 0, "never steer or overlap an existing daily router turn");
    queued.busy(false); assert.equal(queued.runs.length, 1);
    queued.add("second"); assert.equal(queued.runs.length, 1);
    await queued.decide("first", "defer");
    assert.equal(queued.coordinator.hasPendingJudgment("router"), true, "another queued ticket keeps reports deferred after the first returns to its human card");
    queued.runs[0].gate.resolve(); await tick();
    assert.equal(queued.runs.length, 2, "next ticket starts after the first approval turn settles");
    assert.equal(queued.runs[1].key, "second");
    queued.allowed(false);
    assert.equal(queued.coordinator.isJudging("second"), false, "revoked approval mode exposes the card");
    assert.equal(queued.coordinator.hasPendingJudgment("router"), false, "human-only tickets release the coordinator report gate");
    queued.runs[1].gate.resolve(); await tick();
  } finally { queued.dispose(); }
  const interrupted = harness();
  try {
    interrupted.add("interrupted"); interrupted.coordinator.start();
    const tool = interrupted.coordinator.decisionTool("router", "interrupted")!;
    interrupted.coordinator.dispose();
    assert.equal(interrupted.coordinator.isJudging("interrupted"), false);
    assert.equal(interrupted.coordinator.hasPendingJudgment("router"), false);
    await assert.rejects(tool.execute("late", { decision: "approve", reason: "late" }, undefined, undefined, {} as never), /ticket_unavailable/u);
    interrupted.runs[0].gate.resolve(); await tick();
  } finally { interrupted.dispose(); }
  await liveRouterDowngrade();
  console.log("PASS company approval: native binding approve/reject/defer, no daily tool, live router downgrade, delete/read-only exclusion, settled queue and one-shot fallback");
}

/** Exercise the real plugin adapter: old writable worker options cannot override a new Composer/draft restriction. */
async function liveRouterDowngrade(): Promise<void> {
  for (const phase of ["queued", "judging"] as const) for (const source of ["composer", "draft"] as const) {
    const broker = new PiAgentApprovalBroker();
    const identity = { conversationId: "worker", piSessionId: "session-worker", productRunId: "run-worker", toolCallId: "call-worker" };
    const key = "worker:session-worker:run-worker:call-worker";
    const pending = broker.waitForDecision({ ...identity, requestId: "live-router-ticket", target: "projects/说明.md", preview: "保存说明" });
    void pending.catch(() => undefined);
    const dispatch: CompanyDispatch = { id: "worker", routerConversationId: "router", agentId: "generalist", brief: "保存说明", status: "running",
      permission: "workspace-write", turnPermission: "workspace-write", createdAt: 1, turns: 1 };
    const pendingRun = gate(), subscribers = new Set<() => void>();
    let permission = "danger-full-access", mode = "agent", busy = phase === "queued", started = 0, approvalPermission: string | undefined;
    const oldOptions = { permission: "workspace-write", mode: "agent", providerSettingsId: "offline", runtimeProviderId: "offline", model: "offline", reasoning: "none", mcpEnabled: false };
    const runs = { pendingInteractions: new Map([["worker", { kind: "confirmation", status: "pending", ...identity, turnId: identity.productRunId }]]),
      lastTurnOptions: new Map([["router", { ...oldOptions, permission: "danger-full-access" }], ["worker", { ...oldOptions }]]), isTurnActive: () => busy,
      subscribe: (subscriber: { refresh(): void }) => { subscribers.add(subscriber.refresh); return () => { subscribers.delete(subscriber.refresh); }; },
      onTurnSettled: (listener: () => void) => { subscribers.add(listener); return () => { subscribers.delete(listener); }; },
      run: async (item: { turnOptions: { permission: string } }) => { started++; approvalPermission = item.turnOptions.permission; await pendingRun.promise; }, refreshTask() {} };
    const plugin: any = { settings: { sessions: [{ id: "router", agentId: "sol", companyRole: "router" }],
      agentRegistry: { agents: [{ id: "sol", companyApprovalMode: "assistant" }] }, defaultPermission: "workspace-write", defaultMode: "agent",
      taskWorkspace: { replyDrafts: {} } },
      getConversationRunService: () => runs,
      getCodexView: () => source === "composer" ? { companyCardAccess: () => ({ permission, mode }) } : null,
      companyService: { doc: { dispatches: [dispatch] }, subscribe: (listener: () => void) => { subscribers.add(listener); return () => { subscribers.delete(listener); }; },
        recordApprovalDecision: async () => assert.fail("downgraded ticket must not record a model approval") },
      piAgentApprovalBinding: (input: typeof identity) => broker.bindingFor(input),
      readPiConversationCatalogEntry: async () => ({ agentId: "sol", companyRole: "router" }), notifyHomeSurfacesChanged() {} };
    const coordinator = createCompanyApprovalCoordinator(plugin); plugin.companyApprovalCoordinator = coordinator;
    try {
      coordinator.start(); await tick();
      assert.equal(coordinator.isJudging(key), true);
      assert.equal(started, phase === "queued" ? 0 : 1);
      if (phase === "judging") assert.equal(approvalPermission, "workspace-write", "approval run respects the original dispatch and worker ceiling");
      const tool = phase === "judging" ? coordinator.decisionTool("router", key)! : undefined;
      // Cover both authority sources and both kinds of write revocation.
      if (source === "composer") permission = "read-only";
      else plugin.settings.taskWorkspace.replyDrafts.router = { selectedPermission: "workspace-write", selectedMode: "plan" };
      if (tool) await assert.rejects(tool.execute("after-downgrade", { decision: "approve", reason: "旧写入权限" }, undefined, undefined, {} as never), /ticket_unavailable/u);
      assert.equal(coordinator.isJudging(key), false, `${phase}/${source} immediately exposes the original human card`);
      assert.ok(broker.bindingFor(identity), "downgrade never consumes or approves the underlying worker ticket");
      assert.equal(coordinator.decisionTool("router", key), undefined);
      permission = "workspace-write"; mode = "agent"; plugin.settings.taskWorkspace.replyDrafts.router = {}; busy = false;
      for (const listener of [...subscribers]) listener();
      assert.equal(started, phase === "queued" ? 0 : 1, "restoring write permission does not retry this ticket");
      assert.equal(broker.bindingFor(identity)!.decide("reject"), true, "the same live ticket remains available to its human card");
      assert.equal(await pending, false);
      pendingRun.resolve(); await tick();
    } finally { coordinator.dispose(); broker.dispose(); pendingRun.resolve(); }
  }
}
