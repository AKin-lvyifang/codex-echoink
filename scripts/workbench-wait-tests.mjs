import { disposableTestRoot } from "./disposable-test-root.mjs";
import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
// This suite never opens Obsidian or reads a Provider configuration.
const fixtureParent = disposableTestRoot(path.join(homedir(), "EchoInk-TestVaults/90-任务临时/工作台可靠性-20261021"), ["ECHOINK_WORKBENCH_TEST_ROOT"]);
const bundle = await esbuild.build({
  stdin: { contents: `
    export * from "./src/ui/turn-watchdog";
    export { armTurnWatchdog, clearTurnWatchdog } from "./src/ui/codex-view/turn-lifecycle";
    export { runErrors } from "./src/run-reports/recent-errors";
    export { ConversationRunService } from "./src/plugin/conversation-run-service";
    export { normalizeEchoInkQuestionPrompts } from "./src/types/conversation-turn";
    export { PiTurnInteractionBroker } from "./src/plugin/pi-turn-interaction-broker";
    export { PiAgentApprovalBroker } from "./src/plugin/pi-agent-approval-broker";
    export * from "./src/harness/pi-native/pi-user-question-tool";
    export { FileApprovalTicketStore, confirmAndConsumeApprovalTicket } from "./src/harness/pi-native/tool-authorization";
    export { FileDomainReceiptStore } from "./src/harness/pi-native/domain-receipt-store";
    export { PiObsidianToolSecurity } from "./src/harness/pi-native/pi-obsidian-tools";
    export { createPiVaultProductionAuthorizationPort } from "./src/plugin/pi-vault-tool-production";
    export { PI_VAULT_TOOL_POLICIES, PI_VAULT_TOOL_VERSION, PI_VAULT_TOOL_POLICY_VERSION } from "./src/harness/pi-native/pi-vault-tool-contracts";
    export { openTestNoticeMessages } from "./src/tests/obsidian-shim";
  `, resolveDir: root, loader: "ts" },
  bundle: true, write: false, platform: "node", target: "node22", format: "esm",
  loader: { ".md": "text", ".svg": "dataurl" },
  plugins: [{ name: "wait-test-hosts", setup(build) {
    // Keep the actual service/timer code, but do not start an unrelated runner.
    build.onResolve({ filter: /ui\/codex-view\/turn-runner$/ }, () => ({ path: "runner", namespace: "wait-test" }));
    build.onLoad({ filter: /^runner$/, namespace: "wait-test" }, () => ({ contents: `
      export const startQueuedTurnItemSafely = () => { throw new Error("unused runner"); };
      export const startQueuedTurnItem = startQueuedTurnItemSafely;
      export const startChatTurn = startQueuedTurnItemSafely;
    ` }));
    build.onResolve({ filter: /^obsidian$/ }, () => ({ path: path.join(root, "src/tests/obsidian-shim.ts") }));
    build.onResolve({ filter: /^(?:@[^/]+\/|[A-Za-z][^:]*$|node:)/ }, args => {
      if (args.path.startsWith(".") || path.isAbsolute(args.path)) return;
      return { path: import.meta.resolve(args.path), external: true };
    });
  } }], logLevel: "silent"
});
const api = await import(`data:text/javascript;base64,${Buffer.from(`${bundle.outputFiles[0].text}\n//# sourceURL=workbench-wait-test-bundle.mjs`).toString("base64")}`);
const prompt = { questionId: "q1", prompt: "继续使用推荐方案？", selection: "single",
  options: [{ optionId: "yes", label: "继续" }, { optionId: "no", label: "调整" }] };
assert.equal(api.normalizeEchoInkQuestionPrompts([prompt])[0].allowSupplement, true);
assert.equal(api.normalizeEchoInkQuestionPrompts([{ ...prompt, allowSupplement: false }])[0].allowSupplement, false);
assert.throws(() => api.normalizeEchoInkQuestionPrompts([{ ...prompt, allowSupplement: "false" }]));

await withFakeClock(async clock => {
  let cancelled = 0;
  const host = { running: true, activeRunId: "run-lifecycle", turnWatchdog: null,
    activeRunSession: () => ({ id: "task-lifecycle" }),
    plugin: { recordTaskInterruption: async (id, reason) => { assert.equal(id, "task-lifecycle"); assert.equal(reason, "watchdog"); }, settings: { settingsLanguage: "zh" }, isPiProductionRun: () => true, cancelHarnessRun: async () => { cancelled++; } },
    pauseQueueForSession() {}, applyStatus() {} };
  host.clearTurnWatchdog = () => api.clearTurnWatchdog(host);
  api.armTurnWatchdog(host);
  clock.advance(120_000);
  api.setTurnWatchdogWaiting(host, true);
  assert.equal(clock.timerCount(), 0, "waiting clears the lifecycle timer instead of polling");
  clock.advance(360_000);
  api.setTurnWatchdogWaiting(host, true);
  assert.equal(cancelled, 0);
  api.setTurnWatchdogWaiting(host, false);
  clock.advance(179_999);
  assert.equal(cancelled, 0);
  api.setTurnWatchdogWaiting(host, false);
  clock.advance(1);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(cancelled, 1, "resuming retains the remaining execution budget");
  const timeoutError = api.runErrors.snapshot().find(error => error.code === "turn_no_progress_timeout");
  assert.equal(timeoutError?.conversationId, "task-lifecycle");
  assert.equal(timeoutError?.runId, "run-lifecycle");
  assert.match(timeoutError?.message ?? "", /5 分钟没有任何进展/u);
  api.armTurnWatchdog(host, 10);
  api.setTurnWatchdogWaiting(host, true);
  api.clearTurnWatchdog(host);
  api.setTurnWatchdogWaiting(host, false);
  clock.advance(20);
  assert.equal(cancelled, 1, "a settled timer cannot be resurrected by a late interaction");
  const stableOwner = { turnWatchdog: null };
  const lifecycleAdapter = () => ({ ...host, turnWatchdogOwner: stableOwner });
  api.armTurnWatchdog(lifecycleAdapter(), 10_000);
  api.setTurnWatchdogWaiting(stableOwner, true);
  clock.advance(360_000);
  assert.equal(cancelled, 1, "recreated lifecycle adapters share the stable service timer owner");
  api.setTurnWatchdogWaiting(stableOwner, false);
  api.clearTurnWatchdog(lifecycleAdapter());
  clock.advance(10_000);
  assert.equal(cancelled, 1);

  const session = { id: "task-question", taskStatus: "running", messages: [] };
  const plugin = { settings: { sessions: [session] }, getVaultPath: () => "synthetic-only",
    saveSettings: async () => {}, externalizeMessageText: async () => {},
    setPiConversationTaskMetadata: async (_id, patch) => Object.assign(session, patch) };
  const service = new api.ConversationRunService(plugin);
  const state = service.stateFor(session.id);
  Object.assign(state, { running: true, activeTurnId: "run-question", activeRunId: "run-question" });
  const context = service.createHost(state, { sessionId: session.id, attachments: [], skill: null, turnOptions: {} });
  let stops = 0;
  service.stopTask = async (_id, reason) => { assert.equal(reason, "watchdog"); stops++; };
  const broker = new api.PiTurnInteractionBroker();
  const security = new api.PiUserQuestionToolSecurity();
  const records = [];
  let interaction;
  const tool = api.createPiUserQuestionToolDefinition({
    security, broker, currentRun: () => ({ conversationId: session.id, piSessionId: "pi-question", productRunId: state.activeTurnId }),
    sessionManager: { getSessionId: () => "pi-question", appendCustomEntry: (_kind, value) => { records.push(value); return "record-1"; } },
    reportRequested: async value => { interaction = value; context.setPendingInteraction(session.id, value, state.activeTurnId); },
    reportResolved: async () => context.setPendingInteraction(session.id, null, state.activeTurnId), now: () => clock.now()
  });
  assert.ok(!tool.parameters.properties.questions.items.required.includes("allowSupplement"));
  const input = { questions: [prompt] };
  assert.equal(await security.handleToolCall({ toolName: "user_question", toolCallId: "call-question", input }), undefined);
  context.armTurnWatchdog();
  clock.advance(60_000);
  const questionResult = tool.execute("call-question", input);
  await Promise.resolve();
  assert.equal(state.turnWatchdog, null);
  assert.equal(clock.timerCount(), 0, "service owner also stops its timer while waiting");
  clock.advance(360_000);
  assert.equal(stops, 0);
  const binding = broker.bindingFor({ conversationId: session.id, piSessionId: "pi-question", productRunId: "run-question", interactionId: interaction.interactionId });
  assert.ok(binding);
  assert.equal(binding.submit([{ questionId: "q1", selectedOptionIds: ["yes"], supplement: "都按推荐执行" }]), true);
  assert.equal(binding.submit([{ questionId: "q1", selectedOptionIds: ["yes"] }]), false);
  await questionResult;
  assert.equal(records.length, 1);
  assert.equal(state.activeTurnId, "run-question", "answer continues the same task and run");
  assert.equal(session.taskStatus, "running");
  clock.advance(239_999);
  assert.equal(stops, 0);
  clock.advance(1);
  assert.equal(stops, 1);
  context.clearTurnWatchdog();
  for (const resolution of ["approved", "denied", "cancelled"]) {
    const confirmation = { conversationId: session.id, piSessionId: "pi-question", turnId: state.activeTurnId,
      interactionId: `approval-${resolution}`, toolCallId: `approval-call-${resolution}`, kind: "confirmation", status: "pending", createdAt: clock.now(), updatedAt: clock.now() };
    context.armTurnWatchdog(30_000);
    clock.advance(10_000);
    context.setPendingInteraction(session.id, confirmation, state.activeTurnId);
    clock.advance(360_000);
    context.setPendingInteraction(session.id, { ...confirmation, status: "submitting" }, state.activeTurnId);
    assert.equal(state.turnWatchdog, null);
    context.setPendingInteraction(session.id, { ...confirmation, status: resolution }, state.activeTurnId);
    clock.advance(19_999);
    assert.equal(stops, 1);
    context.clearTurnWatchdog();
    context.setPendingInteraction(session.id, null, state.activeTurnId);
  }
  await service.flushSave();
  broker.dispose();
});
console.log("OK watchdogs + question: fake-clock wait >5 minutes, same task resumes, remaining execution limit retained");

await mkdir(fixtureParent, { recursive: true });
const fixtureRoot = await mkdtemp(path.join(fixtureParent, "wait-automation-"));
try {
  const clock = { value: 1_800_000_000_000 };
  const approvals = new api.FileApprovalTicketStore({ storageRootPath: path.join(fixtureRoot, "store"), vaultId: "wait-test-vault", now: () => clock.value });
  const receipts = new api.FileDomainReceiptStore({ storageRootPath: path.join(fixtureRoot, "store"), vaultId: "wait-test-vault", now: () => clock.value });
  await approvals.initialize();
  await receipts.initialize();
  const broker = new api.PiAgentApprovalBroker();
  const identity = { vaultId: "wait-test-vault", conversationId: "task-approval", piSessionId: "pi-approval", productRunId: "run-approval" };
  const contractFor = toolCallId => ({ ...identity, toolCallId, toolId: "note_create", userId: "test-user", deviceId: "test-device",
    toolVersion: "v1", policyVersion: "v1", normalizedArguments: { content: "synthetic" }, resolvedTarget: { relativePath: "Target.md" }, targetVersion: null, preview: { content: "synthetic" } });
  const requests = [];
  const confirm = async ticket => {
    requests.push(ticket);
    return await broker.waitForDecision({ ...identity, toolCallId: ticket.toolCallId, requestId: ticket.ticketId, target: "Target.md", preview: "synthetic" });
  };
  let expiryNotices = 0;
  const contract = contractFor("call-renew");
  const renewing = api.confirmAndConsumeApprovalTicket({ approvals, contract, confirm, now: () => clock.value, onExpired: () => { expiryNotices++; } });
  const first = await waitFor(() => broker.bindingFor(contract));
  const oldTicket = requests.at(-1);
  clock.value += 360_000;
  assert.equal(first.decide("approve"), true);
  const second = await waitFor(() => requests.length === 2 && broker.bindingFor(contract));
  assert.equal(expiryNotices, 1);
  assert.notEqual(requests[0].ticketId, requests[1].ticketId);
  assert.equal(requests[1].productRunId, oldTicket.productRunId);
  assert.equal(first.decide("approve"), false, "an expired binding cannot decide a replacement request");
  assert.equal((await approvals.get(contract.productRunId, contract.toolCallId)).status, "pending");
  assert.equal(second.decide("approve"), true);
  const authorization = await renewing;
  assert.equal(authorization.productRunId, identity.productRunId);
  assert.equal((await approvals.get(contract.productRunId, contract.toolCallId)).status, "approved");
  await assert.rejects(approvals.consume({ ticketId: oldTicket.ticketId, operationIdentity: oldTicket.operationIdentity, contract }));
  await assert.rejects(approvals.issue({ ...contract, issuedAt: clock.value, expiresAt: clock.value + 300_000 }), /不能替换/);
  for (const resolution of ["denied", "cancelled"]) {
    const terminal = contractFor(`call-${resolution}`);
    const ticket = await approvals.issue({ ...terminal, issuedAt: clock.value, expiresAt: clock.value + 300_000 });
    await approvals.resolve({ productRunId: terminal.productRunId, toolCallId: terminal.toolCallId, ticketId: ticket.ticketId, resolution });
    await assert.rejects(approvals.issue({ ...terminal, issuedAt: clock.value, expiresAt: clock.value + 300_001 }), /不能替换/);
  }
  const refused = contractFor("call-expired-refused");
  const refusedResult = api.confirmAndConsumeApprovalTicket({ approvals, contract: refused, now: () => clock.value,
    confirm: async () => { clock.value += 360_000; return false; } });
  await assert.rejects(refusedResult, /approval_denied/);
  assert.equal((await approvals.get(refused.productRunId, refused.toolCallId)).status, "denied");
  await assert.rejects(approvals.issue({ ...refused, issuedAt: clock.value, expiresAt: clock.value + 300_000 }), /不能替换/);
  const abort = new AbortController();
  const aborted = contractFor("call-expired-abort");
  await assert.rejects(api.confirmAndConsumeApprovalTicket({ approvals, contract: aborted, signal: abort.signal, now: () => clock.value,
    confirm: async () => { clock.value += 360_000; abort.abort(); throw new Error("cancel"); } }), /approval_cancelled/);
  assert.equal((await approvals.get(aborted.productRunId, aborted.toolCallId)).status, "cancelled");
  await assert.rejects(approvals.issue({ ...aborted, issuedAt: clock.value, expiresAt: clock.value + 300_000 }), /不能替换/);

  const vaultRootPath = path.join(fixtureRoot, "synthetic-vault");
  await mkdir(vaultRootPath);
  const adapter = { vaultId: identity.vaultId, vaultRootPath,
    async lstat(target) { try { const stat = await lstat(target); return { kind: stat.isDirectory() ? "directory" : "file" }; } catch (error) { if (error.code === "ENOENT") return null; throw error; } },
    realpath, readFile: async () => null };
  let productionConfirmations = 0;
  const port = api.createPiVaultProductionAuthorizationPort({ approvals, adapter, currentRunIdentity: () => identity, userId: "test-user", deviceId: "test-device", now: () => clock.value,
    confirmation: { confirm: async () => { if (++productionConfirmations === 1) clock.value += 360_000; return true; } } });
  const nativeAuthorization = await port.authorize({ toolCallId: "call-production", toolId: "note_create", arguments: { relativePath: "Target.md", content: "synthetic" },
    policy: api.PI_VAULT_TOOL_POLICIES.note_create, toolVersion: api.PI_VAULT_TOOL_VERSION, policyVersion: api.PI_VAULT_TOOL_POLICY_VERSION });
  assert.equal(nativeAuthorization.productRunId, identity.productRunId);
  assert.equal(productionConfirmations, 2);
  assert.ok(api.openTestNoticeMessages.some(message => message.includes("审批已过期") && message.includes("尚未执行")));

  let executions = 0;
  let nativeConfirmations = 0;
  let nativeExpiryNotices = 0;
  const realNow = Date.now;
  Date.now = () => clock.value;
  try {
    const security = new api.PiObsidianToolSecurity({ approvals, receipts, userId: "test-user", deviceId: "test-device", currentRunIdentity: () => identity,
      currentAccess: () => ({ mode: "agent", permission: "full-access" }), onApprovalExpired: () => { nativeExpiryNotices++; },
      confirmation: { confirm: async () => { if (++nativeConfirmations === 1) clock.value += 360_000; return true; } } });
    security.bindPort({ prepare: async () => ({ effect: "note_write", target: { relativePath: "Target.md" }, targetVersion: null, preview: { content: "synthetic" },
      execute: async (_signal, onStarted) => { await onStarted(); executions++; return { status: "completed", readbackVerified: true, available: true, engine: "obsidian-official-cli", command: "daily:append" }; } }) });
    const event = { toolCallId: "call-native", toolName: "obsidian_cli", input: { command: "daily:append", content: "synthetic" } };
    assert.equal(await security.handleToolCall(event), undefined);
    assert.equal(nativeConfirmations, 2);
    assert.equal(nativeExpiryNotices, 1);
    assert.equal(executions, 0, "expired approval and renewal perform no write");
    await security.execute(event.toolCallId, event.toolName, event.input);
    assert.equal(executions, 1);
    await assert.rejects(security.execute(event.toolCallId, event.toolName, event.input));
    assert.equal((await security.handleToolCall(event)).block, true);
    assert.equal(executions, 1, "the renewed operation still executes at most once");
  } finally { Date.now = realNow; }
  broker.dispose();
  console.log("OK approvals: fake-clock expiry renews explicit approval in the same run; rejection/cancel stay terminal; native write runs once");
} finally {
  await rm(fixtureRoot, { recursive: true, force: true });
}

async function waitFor(read) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const result = read();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  throw new Error("Timed out waiting for the synthetic approval binding");
}

async function withFakeClock(run) {
  let now = 1_800_000_000_000;
  let sequence = 0;
  const timers = new Map();
  const originalWindow = globalThis.window;
  const originalNow = Date.now;
  globalThis.window = { setTimeout(callback, delay) { const id = ++sequence; timers.set(id, { callback, at: now + delay }); return id; }, clearTimeout(id) { timers.delete(id); } };
  Date.now = () => now;
  try {
    await run({ now: () => now, timerCount: () => timers.size, advance(ms) {
      const target = now + ms;
      for (;;) {
        const next = [...timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        timers.delete(next[0]); now = next[1].at; next[1].callback();
      }
      now = target;
    } });
  } finally { globalThis.window = originalWindow; Date.now = originalNow; }
}
