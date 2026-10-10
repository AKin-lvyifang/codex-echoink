import { Notice } from "obsidian";
import type { EchoInkKnowledgeSurfaceService } from "../plugin/knowledge-surface-service";
import { createOriginButton } from "./origin-controls";
import { OriginSetting } from "./origin-setting";
import { applySettingsRow, createSettingsGroup, createSettingsSection } from "./settings-v2";

type Operation = "optimize" | "restore";
type OperationState = { running: Operation | null };
// Keep actions disabled across settings rerenders while an operation is running.
const operationStates = new WeakMap<EchoInkKnowledgeSurfaceService, OperationState>();

export function renderKnowledgeFolderActions(
  container: HTMLElement,
  service: EchoInkKnowledgeSurfaceService,
  language: string,
  refresh: () => Promise<void>
): void {
  const zh = language !== "en";
  const state = operationStates.get(service) ?? { running: null };
  operationStates.set(service, state);
  const section = createSettingsSection(container, { title: zh ? "目录管理" : "Folder management", surface: "flat" });
  section.addClass("standard-section", "echoink-knowledge-folder-actions");
  const optimizeCard = createSettingsGroup(section);
  optimizeCard.addClass("settings-card");
  const optimizeRow = applySettingsRow(new OriginSetting(optimizeCard)
    .setName(zh ? "文件夹名称优化" : "Folder names")
    .setDesc(zh ? "将知识库英文文件夹改为中英文名称。" : "Rename English knowledge folders with Chinese and English names."));
  const button = createOriginButton(optimizeRow.controlEl, { text: zh ? "优化名称" : "Optimize names" });
  const restoreCard = createSettingsGroup(section);
  restoreCard.addClass("settings-card");
  const restoreRow = applySettingsRow(new OriginSetting(restoreCard)
    .setName(zh ? "复原仓库" : "Restore vault")
    .setDesc(zh ? "恢复初始化前的目录结构，保留最新内容和新增文件。" : "Restore the original folder structure, keeping current content and new files."));
  const restore = createOriginButton(restoreRow.controlEl, { text: zh ? "复原" : "Restore" });
  const original = restoreRow.infoEl.createDiv({ cls: "setting-item-description" });
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
    syncControls();
    try {
      new Notice(await action());
    } catch (error: unknown) {
      const detail = (error instanceof Error ? error.message : String(error)).replace(/\s+/gu, " ").trim();
      const summary = operation === "optimize"
        ? (zh ? "名称优化未完成" : "Folder name optimization did not complete")
        : (zh ? "仓库复原未完成" : "Vault restoration did not complete");
      new Notice(detail ? `${summary}${zh ? "：" : ": "}${detail.length > 160 ? `${detail.slice(0, 160)}…` : detail}` : summary);
    } finally {
      state.running = null;
      syncControls();
      void refresh();
    }
  };
  button.onclick = () => {
    void run("optimize", async () => {
      const result = await service.optimizeFolderNames();
      if (!result.renamed.length && !result.skipped.length) return zh
        ? "目录已采用可读名称，无需优化。"
        : "Folder names are already readable; no optimization needed.";
      return zh
        ? `已改名 ${result.renamed.length} 个目录${result.skipped.length ? `，${result.skipped.length} 项需处理` : ""}。`
        : `Renamed ${result.renamed.length} folder${result.renamed.length === 1 ? "" : "s"}${result.skipped.length ? `; ${result.skipped.length} item${result.skipped.length === 1 ? " needs" : "s need"} attention` : ""}.`;
    });
  };
  restore.onclick = () => {
    if (!hasRecord) return;
    void run("restore", async () => {
      const result = await service.restoreOriginalDirectories();
      return zh
        ? `已恢复 ${result.restored} 个文件${result.skipped.length ? `，${result.skipped.length} 项需处理` : ""}。`
        : `Restored ${result.restored} file${result.restored === 1 ? "" : "s"}${result.skipped.length ? `; ${result.skipped.length} item${result.skipped.length === 1 ? " needs" : "s need"} attention` : ""}.`;
    });
  };
}
