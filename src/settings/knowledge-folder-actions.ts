import type { EchoInkKnowledgeSurfaceService } from "../plugin/knowledge-surface-service";
import { createOriginButton } from "./origin-controls";
import { OriginSetting } from "./origin-setting";
import { applySettingsRow, createSettingsGroup } from "./settings-v2";

type Operation = "optimize" | "restore";
type OperationState = { optimize: string; restore: string; running: Operation | null };
// Keep each action's feedback with its row across settings rerenders.
const operationStates = new WeakMap<EchoInkKnowledgeSurfaceService, OperationState>();

export function renderKnowledgeFolderActions(
  container: HTMLElement,
  service: EchoInkKnowledgeSurfaceService,
  language: string,
  refresh: () => Promise<void>
): void {
  const zh = language !== "en";
  const state = operationStates.get(service) ?? { optimize: "", restore: "", running: null };
  operationStates.set(service, state);
  const panel = createSettingsGroup(container);
  panel.addClass("echoink-knowledge-folder-actions");
  const optimizeRow = applySettingsRow(new OriginSetting(panel)
    .setName(zh ? "文件夹名称优化" : "Folder names")
    .setDesc(zh ? "将知识库英文文件夹改为中英文名称。" : "Rename English knowledge folders with Chinese and English names."));
  const button = createOriginButton(optimizeRow.controlEl, { text: zh ? "优化名称" : "Optimize names" });
  const optimizeStatus = optimizeRow.infoEl.createDiv({ cls: "settings-note", attr: { role: "status", "aria-live": "polite" } });
  const restoreRow = applySettingsRow(new OriginSetting(panel)
    .setName(zh ? "复原仓库" : "Restore vault")
    .setDesc(zh ? "恢复初始化前的目录结构，保留最新内容和新增文件。" : "Restore the original folder structure, keeping current content and new files."));
  const restore = createOriginButton(restoreRow.controlEl, { text: zh ? "复原" : "Restore" });
  const original = restoreRow.infoEl.createDiv({ cls: "settings-note" });
  const restoreStatus = restoreRow.infoEl.createDiv({ cls: "settings-note", attr: { role: "status", "aria-live": "polite" } });
  const statuses = { optimize: optimizeStatus, restore: restoreStatus };
  const setStatus = (operation: Operation, message: string) => {
    state[operation] = message;
    statuses[operation].setText(message);
    statuses[operation].hidden = !message;
  };
  setStatus("optimize", state.optimize);
  setStatus("restore", state.restore);
  let hasRecord = false;
  const syncControls = () => {
    const busy = state.running !== null || service.folderOperationBusy;
    button.disabled = busy || !service.directoryWritable;
    restore.disabled = busy || !hasRecord || !service.directoryWritable;
    button.setText(state.running === "optimize" ? (zh ? "优化中…" : "Optimizing…") : (zh ? "优化名称" : "Optimize names"));
    restore.setText(state.running === "restore" ? (zh ? "复原中…" : "Restoring…") : (zh ? "复原" : "Restore"));
  };
  syncControls();
  void service.getOriginalDirectoryStatus().then((record) => {
    hasRecord = !!record;
    original.setText(record
      ? (zh ? `原始目录记录：${new Date(record.createdAt).toLocaleString()}，${record.files} 个文件。`
        : `Original layout: ${new Date(record.createdAt).toLocaleString()}, ${record.files} files.`)
      : (zh ? "暂无初始化前目录记录" : "No pre-initialization directory record"));
    syncControls();
  }).catch((error: unknown) => { original.setText(String(error)); });

  const run = async (operation: Operation, action: () => Promise<string>) => {
    if (state.running || service.folderOperationBusy || !service.directoryWritable) return;
    state.running = operation;
    setStatus(operation, operation === "optimize"
      ? (zh ? "正在检查知识库文件夹…" : "Checking knowledge folders…")
      : (zh ? "正在复原仓库…" : "Restoring vault…"));
    syncControls();
    try {
      setStatus(operation, await action());
    } catch (error: unknown) {
      setStatus(operation, error instanceof Error ? error.message : String(error));
    } finally {
      state.running = null;
      syncControls();
      void refresh();
    }
  };
  button.onclick = () => {
    void run("optimize", async () => {
      const result = await service.optimizeFolderNames((message) => setStatus("optimize", message));
      return zh
        ? `已改名 ${result.renamed.length} 个目录；跳过 ${result.skipped.length}。${result.skipped.map((item) => `${item.path}：${item.reason}`).join("；")}`
        : `Renamed ${result.renamed.length}; skipped ${result.skipped.length}. ${result.skipped.map((item) => `${item.path}: ${item.reason}`).join("; ")}`;
    });
  };
  restore.onclick = () => {
    if (!hasRecord) return;
    void run("restore", async () => {
      const result = await service.restoreOriginalDirectories((message) => setStatus("restore", message));
      return zh
        ? `已恢复 ${result.restored} 个文件；未恢复 ${result.skipped.length}。${result.skipped.map((item) => `${item.path}：${item.reason}`).join("；")}`
        : `Restored ${result.restored}; unresolved ${result.skipped.length}. ${result.skipped.map((item) => `${item.path}: ${item.reason}`).join("; ")}`;
    });
  };
}
