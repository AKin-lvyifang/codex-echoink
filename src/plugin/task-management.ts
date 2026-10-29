import type CodexForObsidianPlugin from "../main";
import { maintenanceActivityForTask, taskEntryWithMaintenance, taskState } from "../agents/task-presentation";
import { inlineTaskHost, inlineTaskState } from "../ui/codex-view/inline-task";

/** Local catalog and live workers only: management never activates a model. */
export async function readManagedTask(plugin: CodexForObsidianPlugin, id: string) {
  const { catalog } = await plugin.readPiConversationSupportState(id);
  if (catalog.status !== "active") throw new Error("这件任务已不在任务列表中。");
  const inline = inlineTaskHost(plugin)?.service.latestForTask(id);
  const activities = plugin.getKnowledgeActivitySource?.()?.snapshot().maintenance ?? [];
  const activity = maintenanceActivityForTask(catalog, activities);
  const knowledge = plugin.getKnowledgeSurfaceService?.();
  const linked = knowledge?.linking.snapshot();
  const linking = linked?.originConversationId === id ? linked : undefined;
  const run = plugin.getConversationRunService().runs.get(id);
  const upgradeRunning = !!knowledge?.upgrade?.ownsTask(id) && knowledge.upgrade.running;
  const live = upgradeRunning || !!(run?.running || run?.flight || run?.queueStartInProgress) || plugin.isTaskResuming(id);
  const linkingBusy = !!linking && ["queued", "scanning", "judging", "writing", "awaiting-confirmation"].includes(linking.phase);
  const state = inline ? inlineTaskState(inline) : live || linkingBusy
    ? catalog.pendingResponse || linking?.phase === "awaiting-confirmation" ? "waiting" : "running"
    : linking?.phase === "interrupted" ? "interrupted" : taskState(taskEntryWithMaintenance(catalog, activities));
  return { catalog, inline, activity, linking, state, busy: live || linkingBusy || state === "running" || state === "waiting" };
}

export type ManagedTask = Awaited<ReturnType<typeof readManagedTask>>;

/** Wait for actual writers, not just the visible progress, before returning. */
export async function stopManagedTask(plugin: CodexForObsidianPlugin, id: string): Promise<void> {
  const inline = inlineTaskHost(plugin);
  if (inline?.service.latestForTask(id)) { await inline.runtime.stop(id); return; }
  await stopTaskSideWork(plugin, id);
  await plugin.getConversationRunService().stopTask(id);
}

export async function stopTaskSideWork(plugin: CodexForObsidianPlugin, id: string): Promise<void> {
  // Linking releases its own hidden model conversation while stopping.
  if (id.startsWith("knowledge-linking-")) return;
  const knowledge = plugin.getKnowledgeSurfaceService?.();
  // Pause follow-up linking first so settling the model cannot start another batch.
  await knowledge?.linking.stopForOrigins([id]);
  if (knowledge?.upgrade?.ownsTask(id)) await knowledge.stopUpgrade();
}

export async function resumeManagedTask(plugin: CodexForObsidianPlugin, id: string): Promise<void> {
  const task = await readManagedTask(plugin, id);
  if (task.inline) { await inlineTaskHost(plugin)!.runtime.retry(id); return; }
  if (task.linking?.phase === "interrupted" && task.activity?.status === "completed") {
    await plugin.getKnowledgeSurfaceService()!.linking.resume(task.linking.id);
    return;
  }
  await plugin.resumeTask(id);
}

function assertManageable(task: ManagedTask): void {
  if (task.busy) throw new Error("请先停止任务，等待处理结束后再操作。");
  if (task.inline && !["confirmed", "revoked", "withdrawn", "modified"].includes(task.inline.status)) {
    throw new Error("请先在正文任务中撤销未确认的建议。");
  }
}

export async function changeManagedTaskStatus(plugin: CodexForObsidianPlugin, id: string, status: "archived" | "deleted"): Promise<void> {
  assertManageable(await readManagedTask(plugin, id));
  await plugin.setPiConversationStatus(id, status);
  plugin.getConversationRunService().turnQueue.clearSessionQueue(id);
  plugin.settings.sessions = plugin.settings.sessions.filter(session => session.id !== id);
  if (plugin.settings.activeSessionId === id) plugin.settings.activeSessionId = "";
  await plugin.saveSettings(true, { flushConversationStore: false });
}

export async function resetManagedTaskCache(plugin: CodexForObsidianPlugin, id: string): Promise<void> {
  assertManageable(await readManagedTask(plugin, id));
  await plugin.releasePiConversation(id);
  const session = plugin.settings.sessions.find(candidate => candidate.id === id);
  if (session) delete session.tokenUsage;
  await plugin.saveSettings(true, { flushConversationStore: false });
}
