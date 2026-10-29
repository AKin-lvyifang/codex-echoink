import assert from "node:assert/strict";
import { Menu } from "obsidian";
import { openTaskMenu } from "../ui/codex-view/task-menu";
import { changeManagedTaskStatus, readManagedTask, resetManagedTaskCache, resumeManagedTask, stopManagedTask } from "../plugin/task-management";
import { KnowledgeActivityService } from "../plugin/knowledge-activity-service";
import { newMaintenanceProgress } from "../knowledge-base/maintenance-activity";
import { workbenchModuleSetupReason } from "../home/workbench-module-setup";
import { emptyKnowledgeFolderBindings } from "../knowledge-base/folder-bindings";

export async function runTaskManagementTests(): Promise<void> {
  const catalog: any = { conversationId: "unopened", title: "Never opened", status: "active", taskStatus: "interrupted" };
  const calls: string[] = [];
  let linked: any = null, upgradeRunning = false;
  const runs = new Map<string, any>();
  const runService = { runs, turnQueue: { clearSessionQueue: () => calls.push("clear-queue") }, stopTask: async () => { calls.push("stop-pi"); runs.clear(); } };
  const knowledge: any = { linking: { snapshot: () => linked, stopForOrigins: async (ids: string[]) => {
    assert.deepEqual(ids, [catalog.conversationId]); calls.push("stop-links"); if (linked) linked.phase = "interrupted";
  }, resume: async () => { calls.push("resume-links"); linked.phase = "judging"; } },
    upgrade: { ownsTask: () => upgradeRunning, get running() { return upgradeRunning; } },
    stopUpgrade: async () => { calls.push("stop-upgrade"); upgradeRunning = false; } };
  const plugin: any = { settings: { sessions: [], activeSessionId: catalog.conversationId, knowledgeBase: { folderBindings: emptyKnowledgeFolderBindings() },
    lifestyle: { finance: { enabled: false } }, englishDiary: { enabled: false }, pdfReading: { enabled: false } },
    readPiConversationSupportState: async () => ({ catalog: { ...catalog } }), getKnowledgeActivitySource: () => ({ snapshot: () => ({ maintenance: [] }) }),
    getConversationRunService: () => runService, getKnowledgeSurfaceService: () => knowledge, isTaskResuming: () => false,
    setPiConversationStatus: async (_id: string, status: string) => { catalog.status = status; calls.push(status); }, saveSettings: async () => { calls.push("save"); },
    releasePiConversation: async () => { calls.push("release"); }, resumeTask: async () => { calls.push("resume-pi"); },
    createPiConversation: () => { throw new Error("Management cannot create a conversation"); },
    activatePiConversation: () => { throw new Error("Management cannot activate a Provider"); } };
  for (const status of ["archived", "deleted"] as const) {
    catalog.status = "active"; plugin.settings.activeSessionId = catalog.conversationId;
    await changeManagedTaskStatus(plugin, catalog.conversationId, status);
    assert.equal(catalog.status, status); assert.equal(plugin.settings.activeSessionId, ""); assert.deepEqual(plugin.settings.sessions, []);
  }
  catalog.status = "active";
  await resetManagedTaskCache(plugin, catalog.conversationId); assert.ok(calls.includes("release"));
  runs.set(catalog.conversationId, { running: true });
  await assert.rejects(() => changeManagedTaskStatus(plugin, catalog.conversationId, "deleted"), /先停止/);
  calls.length = 0; await stopManagedTask(plugin, catalog.conversationId);
  assert.deepEqual(calls, ["stop-links", "stop-pi"]);
  upgradeRunning = true;
  assert.equal((await readManagedTask(plugin, catalog.conversationId)).busy, true, "Independent upgrade writer is running even without a Pi run");
  await assert.rejects(() => resetManagedTaskCache(plugin, catalog.conversationId), /先停止/);
  calls.length = 0; await stopManagedTask(plugin, catalog.conversationId);
  assert.deepEqual(calls, ["stop-links", "stop-upgrade", "stop-pi"]);
  linked = { originConversationId: catalog.conversationId, id: "link", phase: "awaiting-confirmation" };
  assert.equal((await readManagedTask(plugin, catalog.conversationId)).state, "waiting");
  await stopManagedTask(plugin, catalog.conversationId);
  assert.equal((await readManagedTask(plugin, catalog.conversationId)).state, "interrupted");
  linked = null;
  plugin.inlineAgent = { service: { latestForTask: () => ({ status: "thinking" }) }, runtime: { stop: async () => { calls.push("stop-inline"); }, retry: async () => { calls.push("retry-inline"); } } };
  calls.length = 0; await stopManagedTask(plugin, catalog.conversationId); await resumeManagedTask(plugin, catalog.conversationId);
  assert.deepEqual(calls, ["stop-inline", "retry-inline"]);
  delete plugin.inlineAgent;
  // Exercise the shared menu's actual callbacks, including the non-generating
  // retry-save path. An unconfirmed inline draft must never receive a fake Stop.
  const addItem = Menu.prototype.addItem;
  const items: Array<{ title: string; click: () => void }> = [];
  Menu.prototype.addItem = function(callback: (item: any) => void) {
    const item = { title: "", click: () => {}, setTitle(value: string) { this.title = value; return this; }, setIcon() { return this; }, setWarning() { return this; }, onClick(run: () => void) { this.click = run; return this; } };
    callback(item); items.push(item); return this;
  };
  plugin.notifyHomeSurfacesChanged = () => {};
  Object.assign(runService, { refreshTask() {} });
  const request: any = { id: "request", taskId: catalog.conversationId, status: "pending", currentVersionId: "version" };
  plugin.inlineAgent = { service: { latestForTask: () => request, revoke: async () => { calls.push("revoke-inline"); }, confirm: async (_id: string, version: string) => { calls.push(`save:${version}`); } },
    runtime: { stop: async () => { calls.push("stop-inline"); }, retry: async () => { calls.push("retry-inline"); } }, openSource: async () => {} };
  const event = { preventDefault() {}, stopPropagation() {}, currentTarget: { ownerDocument: { querySelectorAll: () => [] } } } as unknown as MouseEvent;
  try {
    await openTaskMenu(plugin, event, catalog.conversationId);
    assert.ok(items.some(item => item.title === "撤销建议")); assert.ok(!items.some(item => item.title === "停止"));
    items.find(item => item.title === "撤销建议")!.click(); await new Promise(resolve => setTimeout(resolve, 0)); assert.ok(calls.includes("revoke-inline"));
    items.length = 0; request.status = "saving"; await openTaskMenu(plugin, event, catalog.conversationId);
    assert.deepEqual(items.map(item => item.title), ["查看正文"]);
    items.length = 0; request.status = "save_failed"; request.commit = { action: "confirm", versionId: "saved-version" };
    await openTaskMenu(plugin, event, catalog.conversationId); items.find(item => item.title === "重试保存")!.click();
    await new Promise(resolve => setTimeout(resolve, 0)); assert.ok(calls.includes("save:saved-version"));
  } finally { Menu.prototype.addItem = addItem; delete plugin.inlineAgent; }
  assert.equal(workbenchModuleSetupReason(plugin, "journal"), null);
  assert.equal(workbenchModuleSetupReason(plugin, "knowledge-base"), null);
  for (const module of ["finance", "english-diary", "pdf-reading"] as const) assert.ok(workbenchModuleSetupReason(plugin, module), "Manual feature switches remain effective");

  let listener: (task: any) => void = () => {};
  const linking = { ready: Promise.resolve(), subscribe(fn: typeof listener) { listener = fn; fn(null); return () => {}; } };
  const record: any = { schemaVersion: 1, recordId: "legacy", originConversationId: "already-deleted", runId: "old-run", at: 1, date: "2026-10-28", sources: [],
    progress: newMaintenanceProgress(10, "plan"), p1: { version: 1, phase: "plan", decompositions: [], committedPages: {}, finalizedSources: [], writingPlan: [] } };
  const service = new KnowledgeActivityService(linking, async () => [record]); await service.ready;
  assert.equal(service.snapshot().primary, null); assert.equal(service.snapshot().maintenance.length, 1, "Restart hides stale progress while retaining history");
  for (const status of ["running", "waiting", "interrupted", "failed", "partial"] as const) {
    service.update({ ...record, progress: { ...record.progress, status } });
    assert.equal(!!service.snapshot().primary, status === "running" || status === "waiting");
    assert.equal(service.snapshot().maintenance.length, 1);
  }
  for (const phase of ["judging", "awaiting-confirmation", "interrupted", "failed", "partial", "cancelled"] as const) {
    listener({ id: "link", phase, updatedAt: 11 });
    assert.equal(!!service.snapshot().primary, phase === "judging" || phase === "awaiting-confirmation");
  }
  service.update({ ...record, p1: { ...record.p1, phase: "completed" }, progress: { ...record.progress, status: "completed", completedAt: 20 } }, true);
  assert.equal(service.snapshot().primary?.status, "completed"); service.settle(record.recordId); assert.equal(service.snapshot().primary, null);
  service.dispose();
  console.log("Task management PASS: unloaded/local-only archive/delete, no model/session creation, writer-aware stop, inline routing, navigation switches, persistent progress restore/handoff");
}
