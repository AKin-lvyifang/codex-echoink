import { installObsidianDom } from "./obsidian-dom";
import { runTaskCardDenialTests } from "./task-card-denial";
import { PiTurnInteractionBroker } from "../plugin/pi-turn-interaction-broker";
import { PiAgentApprovalBroker } from "../plugin/pi-agent-approval-broker";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { JSDOM } from "jsdom";
import CodexForObsidianPlugin from "../main";
import { CodexView } from "../ui/codex-view";
import { defaultTaskWorkspace, normalizeTaskWorkspace } from "../agents/task-workspace";
import { normalizeAgentRegistry, defaultAgentRegistry } from "../agents/registry";
import { synchronizeLegacyAgentIdentity } from "../agents/migration";
import { TaskNavigationState, consumeAcceptedTaskDraft } from "../ui/codex-view/task-navigation-state";
import { agentTaskCounts, groupAgentTasks, localDateLabel, taskActivityAt, taskCardHintSummary, taskSummary, taskStateLabel } from "../agents/task-presentation";
import { animateTaskDetailEntry, renderTaskDetailHeader } from "../ui/codex-view/task-detail";
import { renderAgentTaskList } from "../ui/codex-view/task-list";
import { InteractionDockController } from "../ui/codex-view/interaction-dock";
import { CodexMessageListRenderer } from "../ui/codex-view/message-list";
import { disposeOriginControls } from "../settings/origin-controls";
import { prepareDocument } from "./settings-search-dom";
import { createAgentRunFixture } from "./agent-runs";
import { addComposerNoteMentionSelection, composerNoteMentionSelections } from "../ui/codex-view/note-mentions";
import { AGENT_IDENTITY_RELATIVE_PATH } from "../harness/memory/agent-identity-model";
import { piEntryIdFromProjectedMessageId, piProjectedEntryMessageId } from "../harness/pi-native/pi-chat-ui-projector";
import type { PiConversationCatalogEntry } from "../harness/pi-native/contracts";
import { FileConversationCatalog } from "../harness/pi-native/file-conversation-catalog";
import { FileDomainReceiptStore } from "../harness/pi-native/domain-receipt-store";
import { FileApprovalTicketStore } from "../harness/pi-native/tool-authorization";
import { PiObsidianToolSecurity } from "../harness/pi-native/pi-obsidian-tools";
import { MAINTENANCE_ACTIVITY_STAGES, maintenanceCompletionText, maintenanceTaskTitle, type KnowledgeActivitySnapshot, type MaintenanceActivity } from "../knowledge-base/maintenance-activity";
import { maintenanceVisibleCopyIsSafe } from "../knowledge-base/maintenance-user-copy";
import { mountKnowledgeActivityProgress } from "../ui/codex-view/knowledge-linking-progress";

function createHost(catalog: any, runtime: any, settings: any): any {
  const local = { catalog, productRuns: runtime.productRuns,
    receipts: new FileDomainReceiptStore({ storageRootPath: catalog.storageRootPath, vaultId: catalog.vaultId }),
    approvals: new FileApprovalTicketStore({ storageRootPath: catalog.storageRootPath, vaultId: catalog.vaultId }),
    readConversationProjection: (id: string) => runtime.readProjection(id), listConversations: (statuses?: string[]) => catalog.list({ statuses }) };
  const host = Object.assign(Object.create(CodexForObsidianPlugin.prototype), {
    settings, piRuntimeBundle: { runtime }, piTaskMetadataWriteTails: new Map(), piTaskMetadataSyncTail: Promise.resolve(), conversationCatalogListeners: new Set(),
    piSubmittingConversations: new Set(), piRunConversations: new Map(), piConversationActivationTasks: new Map(),
    getCodexView: () => null, createPiConversation: (input: any) => runtime.createConversation(input),
    ensurePiLocalData: async () => local,
    buildRuntimeEchoInkResourceCatalog: async () => []
  });
  return host;
}
export async function runAgentTaskTests(root: string): Promise<void> {
  await identityCutover(root);
  await ignoredLegacyTransferMetadata(root);
  draftsAndDates();
  const dom = new JSDOM("<!doctype html><body></body>", { url: "https://local.test/", pretendToBeVisual: true });
  installObsidianDom(dom.window);
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  for (const key of ["window", "document", "HTMLElement", "HTMLButtonElement", "Element", "Node", "MutationObserver", "navigator", "Event", "CustomEvent", "KeyboardEvent"]) {
    descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value: (dom.window as any)[key], configurable: true });
  }
  prepareDocument(dom.window as any);
  const f = await createAgentRunFixture(path.join(root, "runtime"), createHost);
  f.plugin.app.vault = { getRoot: () => ({ children: [] }), getAbstractFileByPath: () => null };
  try {
    await runTaskCardDenialTests(f, dom.window.document);
    await maintenanceDisplayProjection(f, dom.window.document);
    await pluginRemovalApprovalPresentation(path.join(root, "delete-approval-source"));
    await deleteApprovalPresentation(dom.window.document);
    await coldNavigationReadiness(f, dom.window.document);
    await navigationAndSubmission(f, dom.window.document);
    await legacyAndUnread(f);
    await approvalStateTracksBroker(f);
    await handoffBoundary(f, dom.window.document);
    console.log("Agent tasks: production navigation/draft isolation/date/unread/legacy/handoff boundaries PASS");
  } finally {
    await f.service.dispose(); await f.runtime.shutdown(); f.approvalBroker.dispose();
    disposeOriginControls(dom.window.document.body); dom.window.close();
    for (const [key, descriptor] of descriptors) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
  }
}

async function maintenanceDisplayProjection(f: any, doc: Document): Promise<void> {
  const now = Date.now(), originalSource = f.plugin.getKnowledgeActivitySource, originalSurface = f.plugin.getKnowledgeSurfaceService;
  const original = Object.freeze(task("maintenance-ui", { taskStatus: "running", taskStartedAt: now }));
  const activity: MaintenanceActivity = { kind: "maintenance", id: "maintenance-ui-record", originConversationId: original.conversationId,
    status: "running", stage: "write", sourceCount: 20, sourcePaths: ["Raw/资料.md"], batch: { index: 1, total: 1 },
    activeElapsedMs: 1000, etaMs: null, failures: [], currentPath: "Wiki/知识条目.md", updatedAt: now,
    pageCounts: { written: 14, created: 10, updated: 4 },
    steps: MAINTENANCE_ACTIVITY_STAGES.map((stage, index) => ({ stage, completed: stage === "write" ? 7 : 0, total: stage === "write" ? 12 : null, state: index < 3 ? "completed" : index === 3 ? "running" : "pending" })) };
  const foreign = { ...activity, id: "foreign", originConversationId: "another-task", status: "waiting" as const };
  let snapshot: KnowledgeActivitySnapshot = { primary: foreign, other: activity, maintenance: [foreign, activity] };
  const listeners = new Set<(snapshot: KnowledgeActivitySnapshot) => void>();
  f.plugin.getKnowledgeActivitySource = () => ({ ready: Promise.resolve(), snapshot: () => snapshot,
    subscribe(listener: (snapshot: KnowledgeActivitySnapshot) => void) { listeners.add(listener); listener(snapshot); return () => { listeners.delete(listener); }; } });
  const view: any = new CodexView({} as never, f.plugin);
  view.rootEl = doc.body.createDiv({ cls: "codex-container echoink-agent-tasks" });
  view.tabBarEl = view.rootEl.createDiv(); view.taskListEl = view.rootEl.createDiv(); view.taskDetailEl = view.rootEl.createDiv();
  view.taskDetailHeaderEl = view.taskDetailEl.createDiv(); view.taskEditorEl = view.rootEl.createDiv(); view.taskErrorEl = view.rootEl.createDiv();
  const shell = view.taskDetailEl.createDiv(); view.messagesEl = shell.createDiv(); view.taskInterruptionEl = view.messagesEl.createDiv();
  view.taskPlanDockEl = view.taskDetailEl.createDiv(); view.interactionDockEl = view.taskDetailEl.createDiv(); view.queueEl = view.rootEl.createDiv();
  view.inputEl = view.rootEl.createDiv().createEl("textarea"); view.taskUiMounted = view.taskDetailLoaded = true;
  view.taskEntries = [original]; view.updateInputPlaceholder = view.renderComposerTransfers = () => {};
  const navigation = { page: { kind: "detail", taskId: original.conversationId } as any, token: 1 };
  Object.defineProperty(view, "taskNavigation", { value: navigation });
  const publish = (current: MaintenanceActivity) => {
    snapshot = { primary: foreign, other: current, maintenance: [foreign, current] };
    for (const listener of listeners) listener(snapshot);
  };
  try {
    view.observeTaskMaintenance();
    assert.equal(view.taskDetailHeaderEl.querySelector(".echoink-task-card-status")?.textContent, "进行中", "global primary cannot override the current task");
    assert.equal(view.taskDetailHeaderEl.querySelector(".echoink-task-detail-title")?.textContent, maintenanceTaskTitle(activity));
    assert.doesNotMatch(view.taskSummaryText(original), /第 1 批|Batch/u, "One batch keeps the step and stage without a batch label");
    assert.match(view.taskSummaryText(original), /第 4 步.*写Wiki/u);
    const partial: MaintenanceActivity = { ...activity, status: "partial", updatedAt: now + 1,
      failures: [{ key: "write:internal", message: "CAS revision stage resume targetPath Wiki/知识条目.md 冲突", at: now }] };
    publish(partial);
    const progress = doc.body.createDiv();
    const unmountProgress = mountKnowledgeActivityProgress(progress, { ready: Promise.resolve(), snapshot: () => ({ primary: partial, other: null, maintenance: [partial] }), subscribe: () => () => {} }, () => {});
    assert.equal(progress.querySelector(":scope > .echoink-knowledge-activity-failures"), null, "The outer duplicate failure list is removed");
    assert.match(progress.querySelector(".echoink-knowledge-linking-progress-status")?.textContent ?? "", /不覆盖你的修改/u);
    assert.equal((progress.querySelector(".echoink-knowledge-activity-details") as HTMLElement).hidden, true);
    assert.equal(progress.querySelectorAll(".echoink-knowledge-activity-details .echoink-knowledge-activity-failures li").length, 1);
    (progress.querySelector(".echoink-knowledge-linking-progress-button") as HTMLButtonElement).click();
    assert.equal((progress.querySelector(".echoink-knowledge-activity-details") as HTMLElement).hidden, false);
    assert.equal(partial.failures.length, 1, "Failure facts remain intact");
    unmountProgress(); progress.remove();
    assert.equal(view.taskDetailHeaderEl.querySelector(".echoink-task-card-status")?.textContent, "没做完", "shared-source change refreshes the real header without catalog writes");
    assert.equal(maintenanceVisibleCopyIsSafe(view.taskInterruptionEl.textContent), true);
    assert.match(view.taskInterruptionEl.textContent, /《知识条目》.*不覆盖你的修改.*继续/u);
    assert.equal(view.taskInterruptionEl.querySelector("button")?.disabled, false);
    assert.equal(original.taskStatus, "running");
    navigation.page = { kind: "list", agentId: "sol" }; view.renderTaskPages();
    const card = view.taskListEl.querySelector('[data-task-id="maintenance-ui"]');
    assert.equal(card.querySelector(".echoink-task-card-status")?.textContent, "没做完");
    assert.equal(maintenanceVisibleCopyIsSafe(card.textContent), true);
    assert.equal(maintenanceVisibleCopyIsSafe(card.getAttribute("aria-label")), true);
    assert.match(card.textContent, /整理知识库（20 篇资料）/u);
    publish({ ...partial, sourceCount: null });
    assert.equal(view.taskListEl.querySelector(".echoink-task-card-title")?.textContent, "整理知识库", "An unknown source count never becomes zero");
    navigation.page = { kind: "detail", taskId: original.conversationId };
    publish({ ...activity, status: "waiting", updatedAt: now + 2 });
    assert.equal(view.taskDetailHeaderEl.querySelector(".echoink-task-card-status")?.textContent, "等你回应");
    publish({ ...activity, status: "completed", completedAt: now + 3, updatedAt: now + 3 });
    assert.equal(view.taskDetailHeaderEl.querySelector(".echoink-task-card-status")?.textContent, "已完成");
    assert.equal(view.taskSummaryText(original), maintenanceCompletionText(activity));
    const upgrade = { ...activity, taskKind: "upgrade" as const, upgradeCounts: { sourceTotal: 20, sourceCompleted: 20, linkTotal: 4, linksCompleted: 4, wikiTotal: 3, wikiCompleted: 3 } };
    publish(upgrade);
    assert.equal(view.taskDetailHeaderEl.querySelector(".echoink-task-detail-title")?.textContent, "升级旧知识");
    assert.ok(view.taskDetailHeaderEl.querySelector('[aria-label="停止升级"]'), "Upgrade stop stays available without a Pi agent run");
    let stops = 0, upgradeTaskId = original.conversationId;
    f.plugin.getKnowledgeSurfaceService = () => ({ getUpgradeSnapshot: async () => ({ status: "running", taskId: upgradeTaskId }), stopUpgrade: async () => { stops++; } });
    await view.stopTurn(); assert.equal(stops, 1);
    upgradeTaskId = "another-upgrade";
    await assert.rejects(view.stopTurn(), /升级任务已更新/u); assert.equal(stops, 1, "A foreign upgrade cannot be stopped by this task");
    const upgradeReason = "《旧资料》已有同名属性，原值保留，请核对后继续。";
    const interruptedUpgrade = { ...upgrade, status: "interrupted" as const, failures: [{ key: "upgrade:review", message: upgradeReason, at: now + 3 }] };
    publish(interruptedUpgrade);
    assert.ok(view.taskInterruptionEl.textContent.includes(upgradeReason), "Controlled upgrade reasons keep the actual unresolved property");
    const upgradeProgress = doc.body.createDiv();
    const unmountUpgrade = mountKnowledgeActivityProgress(upgradeProgress, { ready: Promise.resolve(), snapshot: () => ({ primary: interruptedUpgrade, other: null, maintenance: [interruptedUpgrade] }), subscribe: () => () => {} }, () => {});
    assert.ok(upgradeProgress.querySelector(".echoink-knowledge-activity-failures")?.textContent?.includes(upgradeReason));
    assert.match(upgradeProgress.querySelector(".echoink-knowledge-activity-details")?.textContent ?? "", /判断类型.*核对变更.*补属性和链接/u);
    assert.doesNotMatch(upgradeProgress.querySelector(".echoink-knowledge-activity-details")?.textContent ?? "", /写Wiki|已写好.*页/u);
    unmountUpgrade(); upgradeProgress.remove();
    publish({ ...upgrade, status: "completed", completedAt: now + 3, updatedAt: now + 3 });
    assert.doesNotMatch(view.taskSummaryText(original), /生成.*Wiki/u);
    assert.match(view.taskSummaryText(original), /20.*篇.*4.*条.*3.*页/u);
    view.taskEntries = [{ ...original, taskStartedAt: now + 4 }]; view.renderTaskPages();
    assert.equal(view.taskDetailHeaderEl.querySelector(".echoink-task-card-status")?.textContent, "进行中", "later ordinary follow-up ignores completed maintenance");
    assert.equal(view.taskDetailHeaderEl.querySelector(".echoink-task-detail-title")?.textContent, original.title);
    assert.equal(original.title, "maintenance-ui", "Display titles never rewrite the user's catalog title");
  } finally {
    view.taskMaintenanceDispose?.(); assert.equal(listeners.size, 0);
    disposeOriginControls(view.rootEl); view.rootEl.remove(); f.plugin.getKnowledgeActivitySource = originalSource; f.plugin.getKnowledgeSurfaceService = originalSurface;
  }
}

async function pluginRemovalApprovalPresentation(root: string): Promise<void> {
  const identity = { vaultId: "delete-approval-source", conversationId: "delete-source", piSessionId: "delete-source-session", productRunId: "delete-source-run" };
  const approvals = new FileApprovalTicketStore({ storageRootPath: root, vaultId: identity.vaultId });
  const receipts = new FileDomainReceiptStore({ storageRootPath: root, vaultId: identity.vaultId });
  await Promise.all([approvals.initialize(), receipts.initialize()]);
  const confirmed: string[] = [];
  let executions = 0;
  const security = new PiObsidianToolSecurity({ currentRunIdentity: () => identity,
    currentAccess: () => ({ permission: "workspace-write", mode: "agent", memoryMode: "normal" }),
    approvals, receipts, userId: "fixture", deviceId: "fixture", confirmation: { async confirm(input) {
      const command = (input.target as { command: string }).command;
      confirmed.push(command);
      assert.equal(input.toolId, "obsidian_cli");
      assert.equal(Object.hasOwn(input, "deleteAction"), command === "plugin:uninstall", "only explicit plugin removal carries delete presentation");
      if (command === "plugin:uninstall") assert.equal(input.deleteAction, true);
      return false;
    } } });
  security.bindPort({ context: async () => ({}), cli: async () => { throw new Error("no real CLI in this fixture"); }, pluginSearch: async () => [],
    prepare: async request => ({ effect: "plugin_write", target: { command: request.command }, targetVersion: null, preview: { command: request.command },
      execute: async () => { executions++; throw new Error("confirmation was denied; no operation may execute"); } }) });
  const commands = ["plugin:install", "plugin:enable", "plugin:disable", "plugin:reload", "plugin:uninstall"] as const;
  for (const command of commands) {
    const toolCallId = `source-${command}`;
    const result = await security.handleToolCall({ toolName: "obsidian_cli", toolCallId, input: { command, id: "synthetic-plugin" } } as any);
    assert.equal(result?.reason, "approval_denied", `${command} retains the existing confirmation decision`);
    const state = await approvals.get(identity.productRunId, toolCallId);
    assert.equal(state?.status, "denied"); assert.equal(Object.hasOwn(state!.ticket, "deleteAction"), false, "presentation stays outside durable Tickets");
  }
  assert.deepEqual(confirmed, commands); assert.equal(executions, 0);
  console.log("Delete source presentation: actual PiObsidian security confirmation marks only plugin:uninstall; install/enable/disable/reload remain generic; no execution PASS");
}

async function deleteApprovalPresentation(doc: Document): Promise<void> {
  const broker = new PiAgentApprovalBroker();
  try {
    for (const [operation, deleteAction] of [["note_delete", true], ["finance_record.delete", true], ["note_update", false], ["mcp.destructive", false]] as const) {
      for (const surface of ["dock", "message"] as const) for (const decision of ["approve", "reject"] as const) {
        const toolCallId = `${operation}-${surface}-${decision}`;
        const identity = { conversationId: "delete-presentation", piSessionId: "delete-session", productRunId: "delete-run", toolCallId };
        const waiting = broker.waitForDecision({ ...identity, requestId: toolCallId,
          target: "Delete-target.md", preview: '{"action":"delete","destructive":true}',
          ...(deleteAction ? { deleteAction: true } : {}) });
        const binding = broker.bindingFor(identity)!;
        assert.equal(binding.deleteAction === true, deleteAction);
        assert.equal(Object.hasOwn(binding, "deleteAction"), deleteAction, "ordinary and destructive MCP approvals have no delete marker");
        const mount = doc.body.createDiv();
        let resolved = 0;
        const renderer: any = surface === "message" ? new CodexMessageListRenderer() : null;
        if (renderer) {
          renderer.env = { settingsLanguage: "zh-CN", resolveApprovalDecision: () => binding, onScheduleMeasure: () => { resolved++; } };
          renderer.renderApprovalCard(mount, { id: toolCallId, role: "tool", text: "", createdAt: Date.now(), approval: { status: "pending" } });
        } else {
          new InteractionDockController().render(mount, { sessionId: identity.conversationId,
            confirmation: { binding, onResolved: () => { resolved++; } }, onStale: () => assert.fail("live broker decision became stale"), onScheduleMeasure() {} });
        }
        const approve = mount.querySelector<HTMLButtonElement>(".is-approve")!;
        const reject = mount.querySelector<HTMLButtonElement>(".is-reject")!;
        assert.equal(approve.classList.contains("echoink-delete-button"), deleteAction, `${operation}: ${surface} approval follows only the explicit marker`);
        assert.equal(reject.classList.contains("echoink-delete-button"), false, "Reject keeps its original presentation");
        assert.equal(approve.textContent, "批准"); assert.equal(reject.textContent, "拒绝");
        (decision === "approve" ? approve : reject).click();
        assert.equal(await waiting, decision === "approve", "the existing button still resolves the real broker decision");
        assert.equal(resolved, 1); assert.equal(broker.bindingFor(identity), null);
        assert.equal(binding.decide(decision), false, "presentation does not bypass one-shot approval identity");
        renderer?.dispose(); mount.remove();
      }
    }
    console.log("Delete approval presentation: real broker + dock/message approve/reject; ordinary/destructive MCP remain generic PASS");
  } finally { broker.dispose(); }
}
async function identityCutover(root: string): Promise<void> {
  const storage = path.join(root, "identity"), file = path.join(storage, AGENT_IDENTITY_RELATIVE_PATH);
  await mkdir(path.dirname(file), { recursive: true });
  const raw = JSON.stringify({ schema: "echoink.agent-identity.v1", revision: 4, displayName: "正式旧名字", avatar: { kind: "preset", presetId: "rio" }, updatedAt: 42 });
  await writeFile(file, raw);
  const registry = defaultAgentRegistry(); registry.legacyMigrationVersion = 1;
  const synced = await synchronizeLegacyAgentIdentity(registry, storage);
  assert.equal(synced.agents[0].name, "正式旧名字"); assert.deepEqual(synced.agents[0].avatar, { kind: "preset", presetId: "rio" });
  assert.equal(synced.agents[0].styleId, registry.agents[0].styleId);
  const edited = normalizeAgentRegistry({ ...registry, agents: [{ ...registry.agents[0], name: "新名字", identityEdited: true }] });
  assert.equal((await synchronizeLegacyAgentIdentity(edited, storage)).agents[0].name, "新名字");
  await writeFile(file, "malformed");
  assert.equal(await synchronizeLegacyAgentIdentity(synced, storage), synced, "cutover is one-time");
  await assert.rejects(synchronizeLegacyAgentIdentity(registry, storage), /invalid/);
  assert.equal(registry.legacyIdentitySyncVersion, undefined, "failed reads remain retryable");
  await writeFile(file, raw); await synchronizeLegacyAgentIdentity(registry, storage);
  assert.equal(await readFile(file, "utf8"), raw, "legacy source is never rewritten");
}
function draftsAndDates(): void {
  const workspace = defaultTaskWorkspace(), key = {};
  const nav = new TaskNavigationState(() => workspace, key);
  nav.save({ text: "新事", attachments: [], noteMentions: [{ vaultRelativePath: "a.md", fileName: "a.md" }] });
  nav.navigate({ kind: "detail", taskId: "original" }); nav.save({ text: "回复", attachments: [{ type: "image", name: "a.png", path: "a.png" }] });
  assert.equal(nav.prefill("sol", "不能覆盖"), false);
  nav.navigate({ kind: "list", agentId: "colleague" }); nav.save({ text: "另一位", attachments: [] });
  const restored = new TaskNavigationState(() => normalizeTaskWorkspace(workspace), key);
  assert.equal(restored.draft({ kind: "list", agentId: "sol" }).text, "新事");
  assert.equal(restored.draft({ kind: "detail", taskId: "original" }).attachments[0].name, "a.png");
  const item: any = { text: "新事", attachments: [], noteMentions: [{ vaultRelativePath: "a.md" }], skill: null };
  assert.equal(consumeAcceptedTaskDraft(workspace, "agent:sol", item), true);
  assert.equal(workspace.replyDrafts.original.text, "回复");
  workspace.newTaskDrafts.sol = { text: "后写的内容", attachments: [] };
  assert.equal(consumeAcceptedTaskDraft(workspace, "agent:sol", item), false, "late acceptance cannot clear a changed draft");
  const now = new Date(2026, 0, 1, 0, 1).getTime();
  assert.equal(localDateLabel(new Date(2025, 11, 31, 23).getTime(), now), "昨天");
  assert.equal(localDateLabel(new Date(2025, 10, 3).getTime(), now), "2025年11月3日");
  const entry = task("done", { taskStatus: "completed", taskCompletedAt: now - 3600_000 });
  assert.equal(taskActivityAt({ ...entry, lastReadAt: now + 9e7, taskMetadataUpdatedAt: now + 9e7 }), taskActivityAt(entry));
  const groups = groupAgentTasks([entry, task("wait", { taskStatus: "waiting" }), task("running", { taskStatus: "running" }), task("stopped", { taskStatus: "interrupted" })], "sol", now);
  assert.equal(groups[0].label, "进行中"); assert.equal(groups[0].tasks.length, 3); assert.equal(groups[1].label, "昨天");
  assert.equal(agentTaskCounts([...groups.flatMap(group => group.tasks), task("knowledge-linking-hidden")], "sol").total, 4);
  assert.equal(taskStateLabel(entry, "en"), "Completed");
  assert.equal(localDateLabel(now, now, "en"), "Today");
  const waiting = task("waiting", { taskStatus: "waiting", taskStage: "outdated stage", pendingResponse: { kind: "question", runId: "run-wait", questionId: "q" } });
  const pending: any = { kind: "question", conversationId: "waiting", turnId: "run-wait", questions: [{ prompt: "真正要问的范围？" }] };
  assert.equal(taskSummary(waiting, { messages: [{ role: "assistant", text: "old answer" } as any] }, "zh-CN", pending), "真正要问的范围？");
  assert.equal(taskSummary(waiting, undefined, "en"), "Waiting for you", "waiting never falls back to an unrelated answer or stale stage");
  const internal: any = { messages: [{ role: "assistant", status: "cancelled", text: "网络连接中断", details: '{"arguments":{"content":"internal tool payload"}}' }] };
  assert.equal(taskSummary(task("stopped-summary", { taskStatus: "interrupted", taskStage: "等待工具确认" }), internal), "等待工具确认", "interruption summary describes the actual stage, never raw tool arguments");
  assert.equal(taskSummary(task("stopped-node", { taskStatus: "interrupted" }), { messages: [{ ...internal.messages[0], assistantTurn: { processNodes: [{ title: "核对文件版本", summary: "internal tool payload" }] } }] } as any), "核对文件版本", "legacy interruptions fall back to the recorded step title");
  assert.equal(taskSummary(task("result-summary", { taskStatus: "completed" }), { messages: [{ role: "assistant", text: "已经整理好三条待办", details: '{"arguments":{}}' } as any] }), "已经整理好三条待办", "completed summaries use the human result text");
  const markdown = { messages: [{ role: "assistant", text: "# **结论**\n已写入 `my_note.md`，见[结果](outputs/result.md)。\n- ~~旧项~~和*重点*" } as any] };
  assert.equal(taskSummary(task("markdown", { taskStatus: "completed" }), markdown), "结论 已写入 my_note.md，见结果。 旧项和重点");
  assert.ok(markdown.messages[0].text.includes("**结论**"), "summary formatting never changes the full record");
  assert.equal(taskCardHintSummary("短摘要 **重点**"), "短摘要 重点");
  assert.equal(taskCardHintSummary("字".repeat(100)), "字".repeat(100), "exactly 100 characters need no ellipsis");
  assert.equal(taskCardHintSummary("字".repeat(101)), `${"字".repeat(99)}…`);
  assert.equal(taskCardHintSummary("😀".repeat(101)), `${"😀".repeat(99)}…`, "Unicode code points must not be cut between surrogate pairs");
  const multilineHint = taskCardHintSummary("# 第一行\r\n\r\n- 第二行\n> 第三行\n第四行");
  assert.equal(multilineHint, "第一行 第二行 第三行 第四行");
  assert.ok(multilineHint.split(/\r?\n/u).length <= 3, "existing text-only projection keeps multiline hints compact");
}
async function ignoredLegacyTransferMetadata(root: string): Promise<void> {
  const options = { storageRootPath: path.join(root, "legacy-transfer"), vaultId: "legacy-transfer" };
  const catalog = new FileConversationCatalog(options); await catalog.initialize();
  await catalog.upsert({ conversationId: "old", piSessionId: "pi-old", vaultId: options.vaultId, title: "Old task", status: "active", defaultMemoryMode: "normal", createdAt: 1, updatedAt: 2 });
  const raw = JSON.parse(await readFile(catalog.filePath, "utf8"));
  // Even obsolete malformed display data must not prevent reading the user's tasks.
  raw.entries[0].taskTransfers = { obsolete: "ignored" }; await writeFile(catalog.filePath, JSON.stringify(raw));
  const reader = new FileConversationCatalog(options);
  assert.equal(Object.hasOwn((await reader.get("old"))!, "taskTransfers"), false);
  await reader.updateTaskMetadata("old", { agentId: "sol", taskStatus: "completed" }, undefined);
  assert.equal(Object.hasOwn(JSON.parse(await readFile(reader.filePath, "utf8")).entries[0], "taskTransfers"), false);
  console.log("Agent metadata: obsolete transfer field ignored on read and omitted on next write PASS");
}
function task(id: string, metadata: Partial<PiConversationCatalogEntry> = {}): PiConversationCatalogEntry {
  return { conversationId: id, piSessionId: `pi-${id}`, vaultId: "task-tests", agentId: "sol", title: id, status: "active", defaultMemoryMode: "normal", createdAt: 1, updatedAt: 2, ...metadata };
}
async function coldNavigationReadiness(f: any, doc: Document): Promise<void> {
  const originals = { activate: f.plugin.activateView, getView: f.plugin.getCodexView, list: f.plugin.listPiConversations,
    tasks: f.plugin.listAgentTaskEntries, knowledge: f.plugin.getKnowledgeSurfaceService,
    workspace: f.settings.taskWorkspace, sessions: f.settings.sessions, active: f.settings.activeSessionId };
  const taskCount = (await f.catalog.list()).length, runCount = (await f.productRuns.list()).length;
  f.plugin.getKnowledgeSurfaceService = () => null;
  try {
    for (const scenario of ["list-prefill", "list-conflict", "detail", "close-list", "close-detail", "failure"] as const) {
      f.settings.taskWorkspace = { ...defaultTaskWorkspace(), page: { kind: "detail", taskId: "A" },
        replyDrafts: { A: { text: "A-REPLY-KEPT", attachments: [] }, B: { text: "B-REPLY-KEPT", attachments: [] } } };
      if (scenario === "list-conflict") f.settings.taskWorkspace.newTaskDrafts.sol = { text: "EXISTING-LIST-DRAFT", attachments: [] };
      f.settings.sessions = structuredClone(originals.sessions); f.settings.activeSessionId = "A";
      const view: any = new CodexView({} as never, f.plugin);
      view.register = () => undefined; // The minimal Obsidian shim omits Component.register.
      view.contentEl = doc.body.createDiv(); view.inputEl = doc.createElement("textarea"); view.attachments = []; view.selectedSkill = null;
      for (const name of ["renderAttachments", "renderToolbar", "resetVirtualWindow", "renderMessages", "closeComposerMenus"]) view[name] = () => undefined;
      const initialReached = latch(), initialRelease = latch(), catalogReached = latch(), catalogRelease = latch(), navigationReached = latch();
      let firstList = true, opening: Promise<unknown> | undefined, navigations = 0, finished = false;
      f.plugin.listPiConversations = async (...args: any[]) => {
        if (firstList) { firstList = false; initialReached.resolve(); await initialRelease.promise; }
        return await originals.list.apply(f.plugin, args);
      };
      f.plugin.listAgentTaskEntries = async (...args: any[]) => {
        catalogReached.resolve(); await catalogRelease.promise;
        return await originals.tasks.apply(f.plugin, args);
      };
      f.plugin.getCodexView = () => view;
      f.plugin.activateView = async () => {
        opening ??= view.onOpen().then(() => undefined, (error: unknown) => error);
        return view;
      };
      for (const method of ["openAgentTaskList", "openTaskDetail"]) {
        const navigate = view[method].bind(view);
        view[method] = (...args: any[]) => { navigations++; navigationReached.resolve(); return navigate(...args); };
      }
      if (scenario === "failure") view.render = () => { throw new Error("injected task shell startup failure"); };
      const detail = scenario === "detail" || scenario === "close-detail";
      const navigating = detail ? f.plugin.openTaskDetail("B") : f.plugin.openAgentTaskList("sol", "COLD-PREFILL");
      void navigating.then(() => { finished = true; });
      try {
        await initialReached.promise; await Promise.resolve(); await Promise.resolve();
        assert.equal(view.taskUiMounted, false, "activation can return the real View before its shell mounts");
        assert.equal(finished, false, "the production navigation entry waits for the cold View");
        assert.equal(navigations, 0); assert.deepEqual(f.settings.taskWorkspace.page, { kind: "detail", taskId: "A" });
        if (scenario === "close-list" || scenario === "close-detail") {
          await view.onClose();
          assert.equal(await navigating, detail ? undefined : false, "closing resolves readiness without waiting for Catalog I/O");
          assert.equal(navigations, 0); assert.deepEqual(f.settings.taskWorkspace.page, { kind: "detail", taskId: "A" });
          initialRelease.resolve(); await opening;
          assert.equal(view.taskUiMounted, false, "a late Catalog result cannot mount a closed View");
        } else if (scenario === "failure") {
          initialRelease.resolve();
          assert.equal(await navigating, false, "startup failure releases the public navigation wait");
          assert.match(String(await opening), /injected task shell startup failure/);
          assert.equal(navigations, 0); assert.deepEqual(f.settings.taskWorkspace.page, { kind: "detail", taskId: "A" });
        } else {
          initialRelease.resolve();
          await Promise.race([catalogReached.promise, opening!.then(result => { throw result instanceof Error ? result : new Error("Task shell startup ended before the Catalog gate"); })]);
          await navigationReached.promise;
          assert.equal(view.taskUiMounted, true); assert.ok(view.runSubscriptionDispose, "navigation starts only after the run subscription is installed");
          assert.deepEqual(f.settings.taskWorkspace.page, detail ? { kind: "detail", taskId: "B" } : { kind: "list", agentId: "sol" });
          const token = view.taskNavigation.token;
          catalogRelease.resolve();
          assert.equal(await navigating, detail ? undefined : scenario !== "list-conflict");
          await opening;
          assert.equal(view.taskNavigation.token, token, "initial restore cannot repeat or replace an external navigation after mount");
          assert.equal(navigations, 1);
          assert.equal(view.inputEl.value, detail ? "B-REPLY-KEPT" : scenario === "list-conflict" ? "EXISTING-LIST-DRAFT" : "COLD-PREFILL");
          assert.equal(f.settings.taskWorkspace.replyDrafts.A.text, "A-REPLY-KEPT");
          if (detail) { assert.equal(view.taskDetailLoaded, true); assert.equal(f.settings.activeSessionId, "B"); }
        }
        assert.equal((await f.catalog.list()).length, taskCount, "cold navigation creates zero Conversations");
        assert.equal((await f.productRuns.list()).length, runCount, "cold navigation starts zero ProductRuns");
      } finally {
        initialRelease.resolve(); catalogRelease.resolve(); await opening;
        if (!view.viewLifecycleAbortController.signal.aborted) await view.onClose();
        view.contentEl.remove();
        f.plugin.listPiConversations = originals.list; f.plugin.listAgentTaskEntries = originals.tasks;
      }
    }
  } finally {
    f.plugin.activateView = originals.activate; f.plugin.getCodexView = originals.getView;
    f.plugin.listPiConversations = originals.list; f.plugin.listAgentTaskEntries = originals.tasks;
    f.plugin.getKnowledgeSurfaceService = originals.knowledge;
    f.settings.taskWorkspace = originals.workspace; f.settings.sessions = originals.sessions; f.settings.activeSessionId = originals.active;
  }
  console.log("Agent navigation: production main cold View readiness/prefill/detail/close/startup failure PASS");
}
async function navigationAndSubmission(f: any, doc: Document): Promise<void> {
  const cold: any = new CodexView({} as never, f.plugin);
  assert.doesNotThrow(() => cold.refreshPersonalizationUi(), "identity initialization can finish before the View shell is mounted");
  const view: any = new CodexView({} as never, f.plugin);
  view.register = () => undefined; // Real Obsidian provides the component cleanup registry.
  view.contentEl = doc.body.createDiv();
  view.inputEl = doc.createElement("textarea"); view.attachments = []; view.selectedSkill = null;
  for (const name of ["renderAttachments", "renderToolbar", "resetVirtualWindow", "renderMessages", "closeComposerMenus"]) view[name] = () => undefined;
  view.ensureChatWorkspaceSelected = async () => true; view.currentTurnOptions = () => f.item("A").turnOptions;
  f.plugin.getKnowledgeSurfaceService = () => null;
  const before = (await f.catalog.list()).length;
  const listConversations = f.plugin.listPiConversations;
  f.plugin.listPiConversations = async () => [];
  const sessionsBefore = f.settings.sessions;
  await view.onOpen();
  assert.equal((await f.catalog.list()).length, before, "opening with an empty Catalog listing never creates a placeholder task");
  f.plugin.listPiConversations = listConversations; f.settings.sessions = sessionsBefore;
  await view.reloadTaskCatalog();
  await view.openAgentTaskList("sol"); view.clearComposerDraft(); view.saveTaskComposerDraft();
  const oldSource = JSON.stringify({ capturedAt: 1 }), newSource = JSON.stringify({ capturedAt: 2 });
  await view.openAgentTaskList("sol", "同一条提醒", oldSource);
  const accepted = { ...f.item("A", "同一条提醒"), composerTextSnapshot: "同一条提醒", prefillSource: oldSource };
  view.taskDraftOrigins.set(accepted.id, "agent:sol");
  view.clearAcceptedComposerDraft(accepted);
  assert.equal(view.inputEl.value, "", "the accepted source snapshot is consumed once");
  await view.openAgentTaskList("sol", "同一条提醒", newSource);
  view.clearAcceptedComposerDraft(accepted);
  assert.equal(view.inputEl.value, "同一条提醒", "a second late UI acceptance keeps a newly prefilled identical sentence");
  assert.equal(f.settings.taskWorkspace.newTaskDrafts.sol.prefillSource, newSource);
  await view.openAgentTaskList("colleague");
  view.clearAcceptedComposerDraft(accepted);
  assert.equal(f.settings.taskWorkspace.newTaskDrafts.sol.prefillSource, newSource, "hidden Agent draft has the same source guard");
  await view.openAgentTaskList("sol"); view.clearComposerDraft(); view.saveTaskComposerDraft();
  await view.openAgentTaskList("sol", "list task");
  assert.equal((await f.catalog.list()).length, before, "navigation/prefill cannot create an empty Conversation");
  addComposerNoteMentionSelection(view.inputEl, { vaultRelativePath: "a.md", fileName: "a.md" });
  await view.openAgentTaskList("colleague"); view.inputEl.value = "colleague draft";
  await view.openAgentTaskList("sol");
  assert.equal(view.inputEl.value, "list task"); assert.equal(composerNoteMentionSelections(view.inputEl)[0].vaultRelativePath, "a.md");
  // Remove the reference for the real Provider request; note snapshotting is independently covered by the existing runner suite.
  await view.openAgentTaskList("colleague");
  const detach = () => undefined; // onOpen mounted the real View subscription.
  try {
    await Promise.all([view.sendNewAgentTask(), view.sendNewAgentTask()]);
    assert.equal((await f.catalog.list()).length, before + 1, `double submit creates only one task: ${view.taskLoadError}`);
    const page = f.settings.taskWorkspace.page; assert.equal(page.kind, "detail", view.taskLoadError);
    const created = (await f.catalog.get(page.taskId))!; assert.equal(created.agentId, "colleague");
    await f.service.runs.get(page.taskId)?.flight;
    const originalId = page.taskId;
    view.inputEl.value = "continue this exact task";
    await view.sendMessage(); await f.service.runs.get(originalId)?.flight;
    assert.equal((await f.catalog.list()).length, before + 1, "detail send continues the original Conversation");
    assert.equal((await f.productRuns.list(originalId)).length, 2);
    await f.plugin.setPiConversationTaskMetadata(originalId, { taskStatus: "interrupted", taskInterruptedAt: Date.now() });
    await view.reloadTaskCatalog(); await view.openTaskDetail(originalId);
    assert.equal(view.inputEl.parentElement.hidden, false, "interrupted detail keeps its reply Composer available");
    assert.equal((await f.productRuns.list(originalId)).length, 2, "opening an interrupted task never resumes it");
    view.inputEl.value = "P4-REPLY-KEPT-ON-FAILURE"; view.saveTaskComposerDraft();
    const provider = f.settings.apiProviders[0], credential = provider.apiKey; provider.apiKey = "";
    await view.sendMessage();
    assert.equal((await f.catalog.get(originalId)).taskStatus, "interrupted");
    assert.equal(view.inputEl.value, "P4-REPLY-KEPT-ON-FAILURE");
    assert.match(view.taskInterruptionEl.textContent, /没有可用模型|模型/);
    const queuedResume = f.item(originalId, "P4-QUEUED-FAILURE");
    f.service.turnQueue.enqueue(queuedResume);
    await assert.doesNotReject(view.resumeQueuedTurns(originalId), "queue UI presents a failed preflight instead of rejecting an unobserved event handler");
    assert.equal(f.service.turnQueue.itemsForSession(originalId).length, 1);
    assert.equal(f.service.turnQueue.isSessionQueuePaused(originalId), true);
    assert.equal(view.inputEl.value, "P4-REPLY-KEPT-ON-FAILURE");
    assert.match(view.taskInterruptionEl.textContent, /API Key|模型/);
    f.service.turnQueue.removeQueuedItem(originalId, queuedResume.id);
    provider.apiKey = credential;
    await view.sendMessage(); await f.service.runs.get(originalId)?.flight;
    assert.equal((await f.productRuns.list(originalId)).length, 3, `interrupted detail sends through resumeTask into the same Conversation: ${view.taskInterruptionEl.textContent}`);
    assert.equal((await f.catalog.get(originalId)).piSessionId, created.piSessionId);
    assert.ok(f.requests.get(originalId).at(-1).includes("P4-REPLY-KEPT-ON-FAILURE"));
    assert.equal(view.inputEl.value, "", "only durable resume acceptance clears the reply");
    await view.openAgentTaskList("sol"); assert.equal(view.inputEl.value, "list task");
    await view.openTaskDetail(originalId); assert.equal(view.inputEl.value, "");
    // Closing preserves the list draft; reopening is a new View with the same pure data workspace.
    view.saveTaskComposerDraft();
    assert.equal(f.settings.taskWorkspace.newTaskDrafts.sol.text, "list task");
    f.plugin.switchPiConversation = async (_previous: string, id: string) => f.runtime.readProjection(id);
    const home = await view.startHomeConversation({ title: "Home bound task", message: "HOME-ENTRY-CONTENT" });
    await f.service.runs.get(home.id)?.flight;
    assert.equal((await f.productRuns.list(home.id)).length, 1, "the existing Home automatic start retains its created Conversation");
    assert.equal(f.settings.taskWorkspace.page.taskId, home.id);
    assert.equal((await f.catalog.list()).length, before + 2, "Home starts exactly its own single task");
    await derivationRouting(f, view, home.id);
    await asyncDraftAndSurfaceIsolation(f, view);
  } finally { detach(); if (!view.viewLifecycleAbortController.signal.aborted) await view.onClose(); view.contentEl.remove(); }
}
function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve: () => resolve() };
}
async function deriveWhilePaused(f: any, view: any, sourceId: string, anchorId: string, phase: "derive" | "metadata", outcome: "success" | "failure" | "navigate" = "success"): Promise<string> {
  await view.openTaskDetail(sourceId);
  view.inputEl.value = "SOURCE-DRAFT-BEFORE-DERIVATION"; view.saveTaskComposerDraft();
  const originalPage = structuredClone(f.settings.taskWorkspace.page);
  const sourceSnapshot = view.sessionById(sourceId).messages.slice().reverse().find((message: any) => message.role === "assistant" && message.status === "completed");
  const originalDerive = f.plugin.derivePiConversation, originalMetadata = f.plugin.setPiConversationTaskMetadata;
  const reached = latch(), release = latch();
  let targetId = "", paused = false;
  f.plugin.derivePiConversation = async (input: any) => {
    const result = await originalDerive.call(f.plugin, input); targetId = result.projection.catalog.conversationId;
    if (phase === "derive") {
      paused = true; reached.resolve(); await release.promise;
      if (outcome === "failure") throw new Error("injected derived API failure");
    }
    return result;
  };
  f.plugin.setPiConversationTaskMetadata = async (...args: any[]) => {
    if (phase === "metadata" && !paused && args[0] === targetId && args[1].taskStatus === "completed") {
      paused = true; reached.resolve(); await release.promise;
      if (outcome === "failure") throw new Error("injected derived metadata failure");
    }
    return await originalMetadata.call(f.plugin, ...args);
  };
  const deriving = view.derivePiConversationFromMessage(view.sessionById(sourceId), anchorId);
  try {
    await reached.promise;
    assert.equal(view.taskDerivationInProgress, true);
    assert.deepEqual(f.settings.taskWorkspace.page, originalPage, "page binding stays on A until B has durably saved metadata");
    assert.equal(f.settings.activeSessionId, sourceId, "deriving data never activates B before the atomic page takeover");
    assert.equal(view.messagesEl.parentElement.hidden, true);
    assert.equal(view.taskPlanDockEl.hidden, true); assert.equal(view.interactionDockEl.hidden, true);
    assert.equal(view.inputEl.parentElement.hidden, true, "the source Composer is unavailable while derivation or metadata is pending");
    const before = (await f.productRuns.list()).length;
    const queuedBefore = f.settings.sessions.reduce((sum: number, session: any) => sum + f.service.turnQueue.itemsForSession(session.id).length, 0);
    view.inputEl.value = "MUST-NOT-SEND-DURING-DERIVATION";
    await view.sendMessage(); await view.enqueueComposerDraft(); await view.steerPiChatFromComposer();
    assert.equal((await f.productRuns.list()).length, before, "send/queue/steer perform zero execution while derivation or metadata is paused");
    assert.equal(f.settings.sessions.reduce((sum: number, session: any) => sum + f.service.turnQueue.itemsForSession(session.id).length, 0), queuedBefore);
    if (outcome === "navigate") {
      await view.openAgentTaskList("colleague");
      view.inputEl.value = "DESTINATION-DRAFT-KEPT";
      view.attachments = [{ type: "file", name: "destination.txt", path: path.join(f.root, "destination.txt") }]; view.saveTaskComposerDraft();
    }
    release.resolve(); await deriving;
    assert.equal(view.taskDerivationInProgress, false);
    if (outcome === "success") {
      assert.deepEqual(f.settings.taskWorkspace.page, { kind: "detail", taskId: targetId }, `${phase}: ${view.taskLoadError}`);
      assert.equal((await f.catalog.get(targetId)).taskCompletedAt, sourceSnapshot.completedAt ?? sourceSnapshot.createdAt, "the transition binds the actual retained completion time before continuation");
      assert.equal(f.settings.activeSessionId, targetId); assert.equal(view.inputEl.parentElement.hidden, false);
    } else if (outcome === "failure") {
      assert.deepEqual(f.settings.taskWorkspace.page, originalPage);
      assert.equal(f.settings.activeSessionId, sourceId);
      assert.equal(view.inputEl.value, "SOURCE-DRAFT-BEFORE-DERIVATION");
      assert.equal(view.inputEl.parentElement.hidden, false); assert.match(view.taskLoadError, /injected derived (?:API|metadata) failure/);
    } else {
      assert.deepEqual(f.settings.taskWorkspace.page, { kind: "list", agentId: "colleague" });
      assert.equal(view.inputEl.value, "DESTINATION-DRAFT-KEPT"); assert.equal(view.attachments[0].name, "destination.txt");
      assert.equal(view.inputEl.parentElement.hidden, false); assert.equal(view.taskLoadError, "");
    }
    return targetId;
  } finally {
    release.resolve(); await deriving;
    f.plugin.derivePiConversation = originalDerive; f.plugin.setPiConversationTaskMetadata = originalMetadata;
  }
}
async function deriveDuringDetailNavigation(f: any, view: any, sourceId: string, anchorId: string, destinationId: string): Promise<void> {
  for (const fail of [false, true]) {
    await view.openTaskDetail(sourceId);
    view.inputEl.value = "SOURCE-DRAFT-BEFORE-LATE-DERIVATION"; view.saveTaskComposerDraft();
    const originalDerive = f.plugin.derivePiConversation, originalReset = view.resetVirtualWindow;
    const reached = latch(), release = latch();
    let derivedId = "", resets = 0;
    f.plugin.derivePiConversation = async (input: any) => {
      const result = await originalDerive.call(f.plugin, input);
      derivedId = result.projection.catalog.conversationId;
      reached.resolve(); await release.promise;
      if (fail) throw new Error("injected late derive failure");
      return result;
    };
    const deriving = view.derivePiConversationFromMessage(view.sessionById(sourceId), anchorId);
    try {
      await reached.promise;
      await view.openTaskDetail(destinationId);
      assert.equal(view.taskDetailLoaded, true, "C finishes its real projection load before the derive API returns");
      assert.equal(view.taskDerivationInProgress, false, "A's pending derivation cannot hide or disable C");
      assert.equal(view.messagesEl.parentElement.hidden, false); assert.equal(view.inputEl.parentElement.hidden, false);
      const destination = view.sessionById(destinationId), messages = destination.messages;
      assert.ok(messages.some((message: any) => message.role === "assistant" && message.text), "C has real retained assistant history");
      const messageSnapshot = structuredClone(messages);
      view.inputEl.value = "C-DRAFT-KEPT-AFTER-LATE-DERIVATION";
      view.attachments = [{ type: "file", name: "C-attachment.txt", path: path.join(f.root, "C-attachment.txt") }];
      addComposerNoteMentionSelection(view.inputEl, { vaultRelativePath: "C-note.md", fileName: "C-note.md" });
      view.saveTaskComposerDraft();
      const draft = structuredClone(f.settings.taskWorkspace.replyDrafts[destinationId]);
      const navigationToken = view.taskNavigation.token;
      view.resetVirtualWindow = () => { resets++; originalReset.call(view); };
      release.resolve(); await deriving;
      assert.notEqual(derivedId, destinationId);
      assert.equal(f.settings.activeSessionId, destinationId, "a late derived result never changes C's active conversation");
      assert.deepEqual(f.settings.taskWorkspace.page, { kind: "detail", taskId: destinationId });
      assert.equal(view.taskNavigation.token, navigationToken, "a late result does not navigate or rebind C");
      assert.equal(view.sessionById(destinationId).messages, messages, "a late result never releases or replaces C's loaded message body");
      assert.deepEqual(messages, messageSnapshot);
      assert.equal(view.inputEl.value, draft.text); assert.deepEqual(view.attachments, draft.attachments);
      assert.deepEqual(composerNoteMentionSelections(view.inputEl), draft.noteMentions);
      assert.deepEqual(f.settings.taskWorkspace.replyDrafts[destinationId], draft, "C's persistent reply draft is unchanged");
      assert.equal(view.composerDraftOwner, destinationId); assert.equal(view.taskDetailLoaded, true);
      assert.equal(view.messagesEl.parentElement.hidden, false); assert.equal(view.inputEl.parentElement.hidden, false);
      assert.equal(view.taskLoadError, "", "a late failure cannot put its error on C");
      assert.equal(resets, 0, "a late result does not reset C's message viewport");
    } finally {
      release.resolve(); await deriving;
      f.plugin.derivePiConversation = originalDerive; view.resetVirtualWindow = originalReset;
    }
  }
  console.log("Agent derivation: direct data + atomic takeover + loaded C isolation after late success/failure PASS");
}
async function derivationRouting(f: any, view: any, sourceId: string): Promise<void> {
  await view.openTaskDetail(sourceId);
  const source = view.sessionById(sourceId);
  const assistant = [...source.messages].reverse().find((message: any) => message.role === "assistant" && piEntryIdFromProjectedMessageId(message.id));
  assert.ok(assistant, "a real completed Pi assistant Entry anchors the derived snapshot");
  const sourceRuns = (await f.productRuns.list(sourceId)).length;
  let derivedId = "";
  for (const phase of ["derive", "metadata"] as const) {
    derivedId = await deriveWhilePaused(f, view, sourceId, piEntryIdFromProjectedMessageId(assistant.id)!, phase);
    view.inputEl.value = `AFTER-${phase}-DERIVED-CONTINUATION`;
    await view.sendMessage(); await f.service.runs.get(derivedId)?.flight;
    assert.equal((await f.productRuns.list(sourceId)).length, sourceRuns, "transition sends never execute on the source task");
    assert.equal((await f.productRuns.list(derivedId)).length, 1);
  }
  await deriveWhilePaused(f, view, sourceId, piEntryIdFromProjectedMessageId(assistant.id)!, "derive", "failure");
  await deriveWhilePaused(f, view, sourceId, piEntryIdFromProjectedMessageId(assistant.id)!, "metadata", "failure");
  await deriveWhilePaused(f, view, sourceId, piEntryIdFromProjectedMessageId(assistant.id)!, "metadata", "navigate");
  await view.openTaskDetail(derivedId);
  assert.notEqual(derivedId, sourceId); assert.equal(f.settings.activeSessionId, derivedId);
  const derivedEntry = await f.catalog.get(derivedId);
  assert.equal(derivedEntry.taskStatus, "completed");
  assert.ok(derivedEntry.taskCompletedAt >= (assistant.completedAt ?? assistant.createdAt), "continuation advances completion beyond the historical snapshot");
  view.inputEl.value = "DERIVED-ONLY-CONTINUATION";
  await view.sendMessage(); await f.service.runs.get(derivedId)?.flight;
  assert.equal((await f.productRuns.list(sourceId)).length, sourceRuns, "continuation cannot return to the source task");
  assert.equal((await f.productRuns.list(derivedId)).length, 2);
  const pageBeforeFailure = structuredClone(f.settings.taskWorkspace.page);
  view.inputEl.value = "draft before invalid anchor";
  await view.derivePiConversationFromMessage(view.sessionById(derivedId), "not-a-real-entry");
  assert.deepEqual(f.settings.taskWorkspace.page, pageBeforeFailure);
  assert.equal(view.inputEl.value, "draft before invalid anchor");
  await deriveDuringDetailNavigation(f, view, sourceId, piEntryIdFromProjectedMessageId(assistant.id)!, derivedId);

  await view.openTaskDetail(sourceId);
  const firstUser = view.sessionById(sourceId).messages.find((message: any) => message.role === "user");
  firstUser.attachments = [{ type: "file", name: "original.txt", path: path.join(f.root, "original.txt") }];
  firstUser.selectionAnnotations = [{ id: "original-annotation", number: 1, selectedText: "source quote", vaultRelativePath: "note.md", fileName: "note.md", appliedActions: ["ask"], anchor: { mode: "reading", from: 0, to: 12, before: "", after: "" } }];
  const catalogCount = (await f.catalog.list()).length;
  const sourcePage = structuredClone(f.settings.taskWorkspace.page);
  // Sol already has a list draft: deriving the first user Entry must not overwrite it or leave the source page.
  await view.derivePiConversationFromMessage(view.sessionById(sourceId), piEntryIdFromProjectedMessageId(firstUser.id));
  assert.deepEqual(f.settings.taskWorkspace.page, sourcePage);
  assert.equal(f.settings.taskWorkspace.newTaskDrafts.sol.text, "list task");
  assert.equal((await f.catalog.list()).length, catalogCount);
  f.settings.taskWorkspace.newTaskDrafts.sol = { text: "", attachments: [] };
  await view.derivePiConversationFromMessage(view.sessionById(sourceId), piEntryIdFromProjectedMessageId(firstUser.id));
  assert.deepEqual(f.settings.taskWorkspace.page, { kind: "list", agentId: "sol" });
  assert.equal(view.inputEl.value, firstUser.text);
  assert.equal(view.attachments[0].name, "original.txt");
  assert.equal(f.settings.taskWorkspace.newTaskDrafts.sol.annotations[0].id, "original-annotation");
  assert.equal((await f.catalog.list()).length, catalogCount, "first-user derivation is only a list draft, with zero new durable task");
}
async function asyncDraftAndSurfaceIsolation(f: any, view: any): Promise<void> {
  const modelGate = latch(), started = latch();
  f.gates.set("A", modelGate); f.started.set("A", started);
  assert.equal(await f.service.start(f.item("A", "RUNNING-A-PRIVATE"), "composer"), "running");
  const flight = f.service.runs.get("A").flight;
  await started.promise;
  const originalCreateContext = view.createTurnRunnerContext, originalSteer = f.plugin.steerPiConversation;
  try {
    for (const method of ["enqueue", "steer"]) for (const switchPage of [true, false]) {
      await view.openTaskDetail("A"); view.clearComposerDraft();
      const submitted = `${method}-accepted-${switchPage}`;
      view.inputEl.value = submitted; view.saveTaskComposerDraft();
      const accepted = latch(), waiting = latch();
      let queuedSnapshot: any = null;
      if (method === "enqueue") view.createTurnRunnerContext = (sessionId: string) => {
        const context = originalCreateContext.call(view, sessionId), createQueued = context.createQueuedTurnFromComposer;
        context.createQueuedTurnFromComposer = async (options: any) => {
          const item = await createQueued(options);
          assert.equal(item.sessionId, "A"); assert.equal(item.text, submitted);
          queuedSnapshot = item; waiting.resolve(); await accepted.promise;
          return item;
        };
        return context;
      };
      else f.plugin.steerPiConversation = async (id: string, text: string) => {
        assert.equal(id, "A"); assert.equal(text, submitted); waiting.resolve(); await accepted.promise;
      };
      const sending = method === "enqueue" ? view.enqueueComposerDraft() : view.steerPiChatFromComposer();
      try {
        await Promise.race([waiting.promise, sending.then(() => assert.fail(`${method} returned before reaching its actual acceptance boundary`))]);
        if (switchPage) await view.openAgentTaskList("colleague");
        view.inputEl.value = "NEWER-DRAFT-MUST-SURVIVE";
        view.attachments = [{ type: "file", path: path.join(f.root, "newer.txt"), name: "newer.txt" }];
        accepted.resolve(); await sending;
        assert.equal(view.inputEl.value, "NEWER-DRAFT-MUST-SURVIVE", `${method}: later text survives ${switchPage ? "another Agent list" : "the same task"}`);
        assert.equal(view.attachments[0].name, "newer.txt");
        if (switchPage) assert.equal(f.settings.taskWorkspace.replyDrafts.A.text, "", "only the accepted source snapshot is consumed");
        if (queuedSnapshot) {
          const queued = f.service.turnQueue.itemsForSession("A").find((item: any) => item.id === queuedSnapshot.id);
          assert.equal(queued?.text, submitted, "the next turn retains the frozen source snapshot after later edits or navigation");
          assert.deepEqual(queued.attachments, [], "a later attachment never enters the accepted next turn");
        }
      } finally {
        accepted.resolve(); await sending;
        view.createTurnRunnerContext = originalCreateContext; f.plugin.steerPiConversation = originalSteer;
        if (queuedSnapshot) f.service.turnQueue.removeQueuedItem("A", queuedSnapshot.id);
      }
    }
    await hiddenSurfaceDuringRead(f, view);
    f.service.runs.get("A")?.context?.setPendingInteraction("A", null);
    await view.openTaskDetail("A"); view.clearComposerDraft();
    view.inputEl.value = "CLOSED-QUEUED-SNAPSHOT"; view.saveTaskComposerDraft();
    await view.enqueueComposerDraft();
    assert.equal(f.settings.taskWorkspace.replyDrafts.A.text, "", "freezing the next turn consumes only the source Composer snapshot");
    assert.equal(f.service.turnQueue.itemsForSession("A").at(-1)?.text, "CLOSED-QUEUED-SNAPSHOT");
    view.inputEl.value = "CLOSED-LATER-DRAFT"; view.saveTaskComposerDraft();
    await view.onClose();
    assert.equal(f.settings.taskWorkspace.replyDrafts.A.text, "CLOSED-LATER-DRAFT");
    modelGate.resolve(); await flight;
    const deadline = Date.now() + 5000;
    while (f.service.turnQueue.hasQueuedItems("A")) {
      if (Date.now() > deadline) assert.fail("a closed View's frozen next turn was not consumed by its plugin owner");
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    await f.service.runs.get("A")?.flight;
    assert.ok(f.requests.get("A").at(-1).includes("CLOSED-QUEUED-SNAPSHOT"), "the plugin owner automatically sends the frozen next turn after the View closes");
    assert.equal(f.settings.taskWorkspace.replyDrafts.A.text, "CLOSED-LATER-DRAFT", "automatic queue execution preserves a later draft with no View subscriber");
  } finally {
    view.createTurnRunnerContext = originalCreateContext; f.plugin.steerPiConversation = originalSteer;
    f.service.runs.get("A")?.context?.setPendingInteraction("A", null);
    modelGate.resolve(); await flight; f.gates.delete("A");
  }
}
async function hiddenSurfaceDuringRead(f: any, view: any): Promise<void> {
  await f.service.run(f.item("B", "TASK-B-CONTENT")); await view.reloadTaskCatalog();
  await view.openTaskDetail("A");
  const source = view.sessionById("A"), state = f.service.runs.get("A");
  const id = piProjectedEntryMessageId(source.piSessionId, null, "tool-A").replace(":entry:", ":tool:");
  source.messages.push({ id, role: "tool", runId: state.activeRunId, text: "A-private-tool", createdAt: Date.now() });
  const originalBinding = f.plugin.piAgentApprovalBinding;
  f.plugin.piAgentApprovalBinding = (identity: any) => identity.conversationId === "A" ? { target: "A-only.txt", preview: "A-SENSITIVE-APPROVAL", decide: () => true } : null;
  state.context.setPendingInteraction("A", { kind: "confirmation", interactionId: "approval-A", conversationId: "A", piSessionId: source.piSessionId, turnId: state.activeRunId,
    status: "pending", toolCallId: "tool-A", target: "A-only.txt", preview: "A-SENSITIVE-APPROVAL", createdAt: Date.now(), updatedAt: Date.now() });
  view.renderInteractionDock(source);
  const approve = view.interactionDockEl.querySelector("button");
  assert.ok(approve, "A has a real mounted confirmation action before navigation");
  view.virtualListEl.textContent = "A-PRIVATE-RECORD";
  const read = f.plugin.readPiConversationProjection;
  let reject!: (error: Error) => void;
  f.plugin.readPiConversationProjection = (taskId: string) => taskId === "B" ? new Promise((_resolve, fail) => { reject = fail; }) : read(taskId);
  try {
    const opening = view.openTaskDetail("B");
    assert.equal(view.taskNavigation.page.taskId, "B");
    assert.equal(view.messagesEl.parentElement.hidden, true, "A's complete record surface is hidden while B is loading");
    assert.equal(view.taskPlanDockEl.hidden, true); assert.equal(view.interactionDockEl.hidden, true);
    assert.ok(approve.closest("[hidden]"), "A's confirmation cannot be exposed or reached from B's loading page");
    reject(new Error("broken B Session")); await opening;
    assert.match(view.taskLoadError, /broken B Session/);
    assert.equal(view.messagesEl.parentElement.hidden, true); assert.equal(view.interactionDockEl.hidden, true);
    f.plugin.readPiConversationProjection = read;
    await view.openTaskDetail("B");
    assert.equal(f.settings.activeSessionId, "B");
    assert.equal(view.messagesEl.parentElement.hidden, false);
    assert.equal(view.virtualListEl.textContent.includes("A-PRIVATE-RECORD"), false);
    assert.equal(view.rootEl.contains(approve), false, "B is bound atomically with no surviving A confirmation action");
  } finally { f.plugin.readPiConversationProjection = read; f.plugin.piAgentApprovalBinding = originalBinding; }
}

async function legacyAndUnread(f: any): Promise<void> {
  await f.service.run(f.item("A", "legacy successful task"));
  await f.plugin.setPiConversationTaskMetadata("A", { taskStatus: undefined, taskCompletedAt: undefined, unreadAnswerAt: 100 });
  const listed = await f.plugin.listAgentTaskEntries();
  assert.equal(listed.find((entry: any) => entry.conversationId === "A")?.taskStatus, "completed");
  assert.equal(listed.some((entry: any) => entry.conversationId === "unload-task"), false, "an empty old Conversation is not a task");
  await f.plugin.setPiConversationTaskMetadata("A", { unreadAnswerAt: 200 });
  await f.plugin.setPiConversationTaskMetadata("A", { unreadAnswerAt: undefined, lastReadAt: 150 }, { markReadThrough: 100 });
  assert.equal((await f.catalog.get("A"))!.unreadAnswerAt, 200, "older rendered answers cannot clear newer unread results");
  await f.runtime.createConversation({ conversationId: "broken-old", title: "Broken old task", agentId: "sol", cwd: f.root });
  const ensureLocalData = f.plugin.ensurePiLocalData;
  f.plugin.ensurePiLocalData = async () => {
    const local = await ensureLocalData();
    return { ...local, readConversationProjection: async (id: string) => { if (id === "broken-old") throw new Error("broken old Session"); return await local.readConversationProjection(id); } };
  };
  try {
    const entries = await f.plugin.listAgentTaskEntries();
    assert.equal(entries.find((entry: any) => entry.conversationId === "broken-old").taskStatus, "interrupted");
    assert.ok(entries.some((entry: any) => entry.conversationId === "A" && entry.taskStatus === "completed"), "one broken old Session cannot hide healthy tasks");
  } finally { f.plugin.ensurePiLocalData = ensureLocalData; }
}
async function handoffBoundary(f: any, doc: Document): Promise<void> {
  await f.service.run(f.item("C", "archived user task")); await f.catalog.status("C", "archived");
  const counts = await f.plugin.getAgentDeleteCounts("colleague"); assert.ok(counts.total >= 2, "archived user tasks are counted for handoff");
  const before = structuredClone((await f.runtime.readProjection("C")).messages);
  await f.plugin.deleteAgent("colleague");
  const entry = (await f.catalog.get("C"))!;
  assert.equal(entry.agentId, "sol"); assert.equal(Object.hasOwn(entry, "taskTransfers"), false);
  assert.deepEqual((await f.runtime.readProjection("C")).messages, before);
  const mount = doc.body.createDiv(); renderTaskDetailHeader(mount, f.settings.agentRegistry.agents[0], entry, () => undefined);
  assert.doesNotMatch(mount.textContent!, /转交给总助/);
  renderTaskDetailHeader(mount, f.settings.agentRegistry.agents[0], { ...entry, taskTransfers: [{ fromAgentId: "old", fromName: "旧同事", at: 1 }] } as any, () => undefined);
  assert.doesNotMatch(mount.textContent!, /转交给总助/, "old data cannot restore the removed display row");
  let animations = 0; mount.animate = (() => { animations++; return {} as Animation; }) as any;
  animateTaskDetailEntry(mount, 1); animateTaskDetailEntry(mount, 1); assert.equal(animations, 1);
  const match = doc.defaultView!.matchMedia; doc.defaultView!.matchMedia = (() => ({ matches: true })) as any;
  animateTaskDetailEntry(mount, 2); assert.equal(animations, 1); doc.defaultView!.matchMedia = match;
  const title = `完整标题 ${"长".repeat(110)}`, summary = `${"😀".repeat(110)} 结尾全文`;
  const hintedEntry = { ...entry, title, unreadAnswerAt: 1 };
  let opened = "";
  renderAgentTaskList(mount, f.settings.agentRegistry.agents[0], [hintedEntry], [], { onTask(id) { opened = id; }, onEdit() {}, summary: () => summary });
  assert.equal(mount.querySelectorAll("[data-task-id]").length, 1);
  const card = mount.querySelector<HTMLButtonElement>("[data-task-id]")!;
  const hint = `${"😀".repeat(99)}…`;
  assert.equal(card.getAttribute("aria-label"), `${title}\n${hint}`, "host tooltip keeps the full title and only the short summary");
  assert.equal(card.getAttribute("data-tooltip-class"), "echoink-task-card-tooltip");
  assert.equal(card.hasAttribute("title"), false, "native browser title must not duplicate the host tooltip");
  assert.ok(card.getAttribute("aria-description")!.endsWith("，有新结果"));
  assert.equal(card.querySelector(".echoink-task-card-title")?.textContent, title);
  assert.equal(card.querySelector(".echoink-task-card-summary")?.textContent, summary, "only hints are truncated");
  card.click(); assert.equal(opened, entry.conversationId, "click still opens the original task detail");
  assert.ok(!JSON.stringify(before).includes("taskTransfers"));
  disposeOriginControls(mount); mount.remove();
}

async function approvalStateTracksBroker(f: any): Promise<void> {
  const ids = ["approval-one", "approval-two", "approval-abort"];
  for (const id of ids) {
    const entry = await f.runtime.createConversation({ conversationId: id, title: id, agentId: "sol", cwd: f.root });
    f.settings.sessions.push({ id, title: entry.title, piSessionId: entry.piSessionId, agentId: "sol", cwd: f.root, bodyAuthority: "pi_session_only", messages: [], createdAt: entry.createdAt, updatedAt: entry.updatedAt });
  }
  const approvalItem = (id: string) => { const item = f.item(id); return { ...item, turnOptions: { ...item.turnOptions, permission: "workspace-write" } }; };
  const oneGate = latch(), twoGate = latch();
  f.approvalAfterDecision.set(ids[0], oneGate); f.approvalAfterDecision.set(ids[1], twoGate);
  let refreshes = 0;
  const view: any = new CodexView({} as never, f.plugin);
  view.runSubscriptionDispose = f.service.subscribe({ refresh: () => { refreshes++; }, clearAcceptedDraft() {}, isTaskVisible: () => false });
  const questionBroker = new PiTurnInteractionBroker();
  const previousQuestionBinding = f.plugin.piTurnInteractionBinding;
  const readProjection = f.plugin.readPiConversationProjection;
  let approvalProjectionReads = 0;
  f.plugin.readPiConversationProjection = async (...args: any[]) => {
    const projection = await readProjection.call(f.plugin, ...args);
    if (args[0] === ids[0]) approvalProjectionReads++;
    return projection;
  };
  f.plugin.piTurnInteractionBinding = (identity: any) => questionBroker.bindingFor(identity);
  const until = async (predicate: () => Promise<boolean>, message: string) => {
    const deadline = Date.now() + 10000;
    while (!await predicate()) {
      if (Date.now() > deadline) assert.fail(message + ": " + JSON.stringify(await Promise.all(ids.map(id => f.catalog.get(id)))));
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  };
  try {
    assert.deepEqual(await Promise.all(ids.slice(0, 2).map(id => f.service.start(approvalItem(id), "composer"))), ["running", "running"]);
    const flights = ids.slice(0, 2).map(id => f.service.runs.get(id).flight);
    await until(async () => (await Promise.all(ids.slice(0, 2).map(id => f.catalog.get(id)))).every(entry => entry.taskStatus === "waiting" && entry.pendingResponse?.kind === "confirmation"),
      "real approval broker waiters must project Catalog waiting state for both concurrent tasks");
    for (const id of ids.slice(0, 2)) {
      const entry = await f.catalog.get(id), request = f.approvalRequests.get(id), pending = f.service.pendingInteractions.get(id);
      assert.equal(entry.pendingResponse.runId, request.productRunId);
      assert.equal(entry.pendingResponse.questionId, pending.interactionId);
      assert.equal(pending.preview, "是否批准本次操作？");
      assert.equal(pending.target, undefined); assert.equal(pending.preview.includes("RAW-APPROVAL-ARGUMENTS"), false);
      assert.equal(f.approvalBroker.bindingFor(request).preview, JSON.stringify({ content: "RAW-APPROVAL-ARGUMENTS" }), "the real approval binding remains unchanged");
      assert.equal(Object.hasOwn(f.approvalBroker.bindingFor(request), "deleteAction"), false, "generic Pi tool approvals remain unmarked");
    }
    assert.equal(agentTaskCounts(await f.plugin.listAgentTaskEntries(), "sol").waiting, 2, "the Agent badge counts actual waiting tasks");
    await view.onClose(); const closedRefreshes = refreshes;

    // A real structured Question remains higher priority while an approval readback is rebuilt.
    const state = f.service.runs.get(ids[0]), request = f.approvalRequests.get(ids[0]);
    const question: any = { kind: "question", interactionId: "priority-question", conversationId: ids[0], piSessionId: request.piSessionId,
      turnId: request.productRunId, status: "pending", createdAt: Date.now(), updatedAt: Date.now(),
      questions: [{ questionId: "q-priority", prompt: "先确认哪一项？", selection: "single", allowSupplement: true, options: [{ optionId: "yes", label: "第一项" }] }] };
    const questionIdentity = { conversationId: ids[0], piSessionId: request.piSessionId, productRunId: request.productRunId, interactionId: question.interactionId };
    const answering = questionBroker.waitForAnswers({ ...questionIdentity, interaction: question, signal: state.controller.signal }).catch(error => error);
    state.context.setPendingInteraction(ids[0], question);
    await until(async () => (await f.catalog.get(ids[0])).pendingResponse?.kind === "question", "structured Question is visible before deciding approval");
    const approve = f.approvalBroker.bindingFor(request);
    const beforeDecisionProjectionReads = approvalProjectionReads;
    assert.equal(approve.decide("approve"), true); assert.equal(approve.decide("approve"), false, "the existing broker still rejects repeated decisions");
    await until(async () => approvalProjectionReads > beforeDecisionProjectionReads && f.approvalBroker.bindingFor(request) === null && (await f.catalog.get(ids[0])).pendingResponse?.kind === "question", "approval changes cannot replace a live Question after the actual broker readback");
    assert.equal(questionBroker.bindingFor(questionIdentity)!.submit([{ questionId: "q-priority", selectedOptionIds: ["yes"] }]), true);
    await answering; state.context.setPendingInteraction(ids[0], null, request.productRunId);
    await until(async () => { const entry = await f.catalog.get(ids[0]); return entry.taskStatus === "running" && !entry.pendingResponse; }, "approval/question resolution clears waiting while execution is still active");

    const rejected = f.approvalBroker.bindingFor(f.approvalRequests.get(ids[1]));
    assert.equal(rejected.decide("reject"), true);
    await until(async () => { const entry = await f.catalog.get(ids[1]); return entry.taskStatus === "running" && !entry.pendingResponse; }, "rejecting the other task clears its pending response independently");
    assert.equal(agentTaskCounts(await f.plugin.listAgentTaskEntries(), "sol").waiting, 0);
    assert.equal(refreshes, closedRefreshes, "Catalog updates do not require or retain a closed View");
    oneGate.resolve(); twoGate.resolve();
    assert.deepEqual(await Promise.all(flights), ["completed", "completed"]);
    assert.equal(f.approvalEffects.get(ids[0]), 1); assert.equal(f.approvalEffects.get(ids[1]) ?? 0, 0);
    for (const id of ids.slice(0, 2)) { const entry = await f.catalog.get(id); assert.equal(entry.taskStatus, "completed"); assert.equal(entry.pendingResponse, undefined); }

    assert.equal(await f.service.start(approvalItem(ids[2]), "composer"), "running");
    await until(async () => (await f.catalog.get(ids[2])).taskStatus === "waiting", "an approval can become waiting with no open View");
    const cancelledIdentity = f.approvalRequests.get(ids[2]);
    await f.service.stopTask(ids[2]);
    const interrupted = await f.catalog.get(ids[2]);
    assert.equal(interrupted.taskStatus, "interrupted"); assert.equal(interrupted.pendingResponse, undefined);
    assert.equal(f.approvalBroker.bindingFor(cancelledIdentity), null); assert.equal(f.service.pendingInteractions.has(ids[2]), false);
    assert.equal(f.approvalEffects.get(ids[2]) ?? 0, 0); assert.equal(refreshes, closedRefreshes);
    console.log("Agent approval state: real broker + Pi tool + plugin run service waiting/approve/reject/cancel/closed View PASS");
  } finally {
    oneGate.resolve(); twoGate.resolve(); questionBroker.dispose(); f.approvalBroker.dispose();
    f.plugin.piTurnInteractionBinding = previousQuestionBinding; f.plugin.readPiConversationProjection = readProjection;
    if (!view.viewLifecycleAbortController.signal.aborted) await view.onClose();
  }
}
