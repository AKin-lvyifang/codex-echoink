import { Modal, Notice } from "obsidian";
import type { EchoInkKnowledgeSurfaceService } from "../plugin/knowledge-surface-service";
import { createOriginButton, createOriginCheck, disposeOriginControls } from "./origin-controls";
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
    .setDesc(zh ? "选择用途目录，预览实际名称变化后应用。" : "Choose bound folders and preview their exact name changes."));
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
    const modal = new Modal(service.app);
    modal.setTitle(zh ? "文件夹名称优化" : "Folder names");
    const selected = new Set<string>();
    const body = modal.contentEl;
    const scopes = service.folderNameScopes();
    const fields = body.createDiv();
    if (!scopes.length) fields.createDiv({ cls: "setting-item-description", text: zh ? "尚未绑定可优化的目录。" : "No bound folders are available." });
    const checks = scopes.map(scope => {
      const row = new OriginSetting(fields).setName(scope);
      const check = createOriginCheck(row.controlEl, { attr: { "aria-label": scope } });
      check.onchange = () => { check.checked ? selected.add(scope) : selected.delete(scope); preview.disabled = !selected.size; };
      return check;
    });
    const error = body.createDiv({ cls: "settings-error", attr: { role: "alert" } });
    const resultEl = body.createDiv();
    const actions = body.createDiv({ cls: "echoink-knowledge-init-actions" });
    const cancel = createOriginButton(actions, { text: zh ? "取消" : "Cancel" }); cancel.onclick = () => modal.close();
    const preview = createOriginButton(actions, { cls: "mod-cta", text: zh ? "预览改名" : "Preview names" }); preview.disabled = true;
    let pending = false;
    preview.onclick = async () => {
      if (pending) return;
      pending = true; error.empty(); preview.disabled = true; preview.setText(zh ? "生成中…" : "Generating…"); body.setAttr("aria-busy", "true"); checks.forEach(check => { check.disabled = true; });
      try {
        const plan = await service.previewFolderNames([...selected]);
        if (!body.isConnected) return;
        resultEl.empty();
        for (const change of plan.result.renamed) resultEl.createDiv({ cls: "setting-item-description", text: `${change.from} → ${change.to}` });
        for (const skipped of plan.result.skipped) resultEl.createDiv({ cls: "settings-error", text: `${skipped.path}：${skipped.reason}` });
        if (!plan.result.renamed.length) resultEl.createDiv({ cls: "setting-item-description", text: zh ? "没有可应用的名称变化。" : "No name changes to apply." });
        const apply = createOriginButton(actions, { cls: "mod-cta", text: zh ? "应用改名" : "Apply names" });
        apply.disabled = !plan.result.renamed.length || !service.directoryWritable;
        apply.onclick = () => { if (pending || state.running) return; apply.disabled = true; void run("optimize", async () => { const result = await service.applyFolderNamePreview(plan); modal.close(); return zh ? `已改名 ${result.renamed.length} 个目录，${result.skipped.length} 项未改动。` : `Renamed ${result.renamed.length} folders; ${result.skipped.length} unchanged.`; }).finally(() => { apply.disabled = !service.directoryWritable; }); };
        preview.hidden = true;
      } catch (failure) { error.setText(failure instanceof Error ? failure.message : String(failure)); preview.disabled = !selected.size; }
      finally { pending = false; body.removeAttribute("aria-busy"); preview.setText(zh ? "预览改名" : "Preview names"); checks.forEach(check => { check.disabled = preview.hidden; }); }
    };
    modal.onClose = () => disposeOriginControls(body);
    modal.open();
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
