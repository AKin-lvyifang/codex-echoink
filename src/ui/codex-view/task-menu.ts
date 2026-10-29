import { Notice } from "obsidian";
import type CodexForObsidianPlugin from "../../main";
import { changeManagedTaskStatus, readManagedTask, resetManagedTaskCache, resumeManagedTask, stopManagedTask } from "../../plugin/task-management";
import { confirmModal, textInputModal } from "../modals";
import { inlineTaskHost } from "./inline-task";
import { openSessionMenu, type SessionMenuCallbacks } from "./menus";

const pending = new WeakMap<object, Set<string>>();

export async function openTaskMenu(plugin: CodexForObsidianPlugin, event: MouseEvent, taskId: string, changed: () => void = () => {}): Promise<void> {
  event.preventDefault(); event.stopPropagation();
  const document = (event.currentTarget as HTMLElement | null)?.ownerDocument;
  const en = plugin.settings.settingsLanguage === "en", t = (zh: string, english: string) => en ? english : zh;
  try {
    const task = await readManagedTask(plugin, taskId);
    const perform = (action: () => Promise<unknown>) => () => {
      const busy = pending.get(plugin) ?? new Set<string>(); pending.set(plugin, busy);
      if (busy.has(taskId)) return;
      busy.add(taskId);
      void action().catch(error => new Notice(error instanceof Error ? error.message : String(error))).finally(() => {
        busy.delete(taskId); plugin.getConversationRunService().refreshTask(taskId);
        plugin.notifyHomeSurfacesChanged(); changed();
      });
    };
    const callbacks: SessionMenuCallbacks = {};
    const inline = task.inline, host = inlineTaskHost(plugin);
    if (inline && host) {
      callbacks.onOpenSource = perform(() => host.openSource(inline.id));
      if (["preparing", "thinking"].includes(inline.status)) callbacks.onStop = perform(() => stopManagedTask(plugin, taskId));
      else if (inline.status === "save_failed" && inline.commit) {
        const commit = inline.commit;
        callbacks.onRetrySave = perform(() => host.service[commit.action](inline.id, commit.versionId));
      } else if (["pending", "clarifying", "queued", "conflict", "failed", "interrupted", "missing"].includes(inline.status)) {
        callbacks.onRevoke = perform(() => host.service.revoke(inline.id, inline.currentVersionId));
        if (["conflict", "failed", "interrupted"].includes(inline.status)) callbacks.onResume = perform(() => resumeManagedTask(plugin, taskId));
      }
    } else if (task.busy) callbacks.onStop = perform(() => stopManagedTask(plugin, taskId));
    else if (task.state === "interrupted") callbacks.onResume = perform(() => resumeManagedTask(plugin, taskId));
    const manageable = !task.busy && (!inline || ["confirmed", "revoked", "withdrawn", "modified"].includes(inline.status));
    if (manageable) {
      callbacks.onRename = perform(async () => {
        const name = await textInputModal(plugin.app, t("重命名任务", "Rename task"), t("名称", "Name"), task.catalog.title);
        if (!name?.trim()) return;
        await readManagedTask(plugin, taskId);
        await plugin.renamePiConversation(taskId, name.trim());
        const session = plugin.settings.sessions.find(item => item.id === taskId);
        if (session) session.title = name.trim();
      });
      callbacks.onArchive = perform(() => changeManagedTaskStatus(plugin, taskId, "archived"));
      callbacks.onResetCache = perform(() => resetManagedTaskCache(plugin, taskId));
      callbacks.onDelete = perform(async () => {
        if (await confirmModal(plugin.app, t(`删除任务“${task.catalog.title}”？`, `Delete task “${task.catalog.title}”?`),
          t("删除后无法在设置中恢复。", "You cannot restore this task in Settings after deletion."), t("删除", "Delete"), t("取消", "Cancel"), { originControls: true, deleteAction: true })) {
          await changeManagedTaskStatus(plugin, taskId, "deleted");
        }
      });
    }
    openSessionMenu(event, callbacks, plugin.settings.settingsLanguage, { task: true, document });
  } catch (error) { new Notice(error instanceof Error ? error.message : String(error)); changed(); }
}
