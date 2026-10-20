import { Modal, Notice } from "obsidian";
import type { EchoInkKnowledgeSurfaceService } from "../plugin/knowledge-surface-service";
import { createOriginButton, createOriginCheck, disposeOriginControls } from "./origin-controls";
import { OriginSetting } from "./origin-setting";
import { createSettingsGroup, createSettingsNavigationRow, createSettingsSection, showSettingsInlineConfirmation } from "./settings-v2";

type Operation = "optimize" | "restore";
type OperationState = { running: Operation | null };
// Keep actions disabled across settings rerenders while an operation is running.
const operationStates = new WeakMap<EchoInkKnowledgeSurfaceService, OperationState>();

export function renderKnowledgeFolderActions(
  container: HTMLElement,
  service: EchoInkKnowledgeSurfaceService,
  language: string,
  refresh: () => Promise<void>,
  renderPlan?: (group: HTMLElement) => void,
  openEditor?: (editor: Modal) => void
): void {
  const zh = language !== "en";
  const state = operationStates.get(service) ?? { running: null };
  operationStates.set(service, state);
  const section = createSettingsSection(container, { title: zh ? "目录管理" : "Folder management", surface: "flat" });
  section.addClass("standard-section", "echoink-knowledge-folder-actions");
  const group = createSettingsGroup(section);
  renderPlan?.(group);
  const scopes = service.folderNameScopes();
  const optimizeSummary = scopes.length ? (zh ? `${scopes.length} 个可选目录` : `${scopes.length} available folders`) : (zh ? "尚未绑定可优化的目录" : "No bound folders are available");
  const button = createSettingsNavigationRow(group, {
    title: zh ? "文件夹名称优化" : "Folder names",
    description: optimizeSummary,
    onActivate: () => openOptimize()
  });
  let record: Awaited<ReturnType<EchoInkKnowledgeSurfaceService["getOriginalDirectoryStatus"]>> = null;
  let recordError = "";
  let recordLoading = true;
  const restoreSummary = () => recordLoading ? (zh ? "正在读取复原记录…" : "Reading restore record…") : recordError || (record
    ? (zh ? `${new Date(record.createdAt).toLocaleString()} · ${record.files} 个文件` : `${new Date(record.createdAt).toLocaleString()} · ${record.files} files`)
    : (zh ? "暂无可复原记录" : "No restore record available"));
  const restore = createSettingsNavigationRow(group, {
    title: zh ? "复原仓库" : "Restore vault", description: restoreSummary(), onActivate: () => openRestore()
  });
  const original = restore.querySelector<HTMLElement>(".echoink-settings-navigation-description")!;
  const syncControls = () => {
    const busy = state.running !== null || service.folderOperationBusy;
    button.disabled = busy;
    restore.disabled = busy || recordLoading;
    button.setAttr("aria-busy", String(state.running === "optimize"));
    restore.setAttr("aria-busy", String(state.running === "restore"));
    button.querySelector<HTMLElement>(".echoink-settings-navigation-description")!.setText(state.running === "optimize" ? (zh ? "正在优化名称…" : "Optimizing folder names…") : optimizeSummary);
    original.setText(state.running === "restore" ? (zh ? "正在复原目录…" : "Restoring folders…") : restoreSummary());
  };
  syncControls();
  void service.getOriginalDirectoryStatus().then(result => { record = result; })
    .catch(() => { recordError = zh ? "复原记录读取失败，请重新打开设置重试" : "Could not read the restore record. Reopen settings to retry."; })
    .finally(() => { recordLoading = false; original.setText(restoreSummary()); syncControls(); });

  const run = async (operation: Operation, action: () => Promise<string>) => {
    if (state.running || service.folderOperationBusy || !service.directoryWritable) return;
    state.running = operation;
    syncControls();
    try {
      new Notice(await action());
    } catch (error: unknown) {
      const detail = (error instanceof Error ? error.message : typeof error === "string" ? error : "").replace(/\s+/gu, " ").trim();
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
  const openOptimize = () => {
    if (state.running || service.folderOperationBusy) return;
    const modal = new Modal(service.app);
    modal.onOpen = () => {
      modal.modalEl.addClass("echoink-settings-modal", "echoink-theme-boundary");
      modal.setTitle(zh ? "文件夹名称优化" : "Folder names");
      const selected = new Set<string>();
      const body = modal.contentEl;
      body.addClass("echoink-knowledge-folder-editor");
      const scopes = service.folderNameScopes();
      if (openEditor) {
        const heading = body.createDiv({ cls: "echoink-knowledge-folder-heading" });
        heading.createEl("h3", { text: zh ? "可优化的目录" : "Available folders" });
        heading.createSpan({ cls: "echoink-knowledge-folder-count", text: zh ? `${scopes.length} 个` : `${scopes.length} folder${scopes.length === 1 ? "" : "s"}` });
      }
      const fields = body.createDiv({ cls: "echoink-knowledge-folder-list" });
      if (!scopes.length) fields.createDiv({ cls: "setting-item-description", text: zh ? "尚未绑定可优化的目录。" : "No bound folders are available." });
      const checks = scopes.map(scope => {
        const row = new OriginSetting(fields).setName(scope);
        const check = createOriginCheck(row.controlEl, { attr: { "aria-label": scope } });
        check.onchange = () => { check.checked ? selected.add(scope) : selected.delete(scope); preview.disabled = !selected.size || !service.directoryWritable; };
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
        } catch (failure) { error.setText(failure instanceof Error ? failure.message : String(failure)); preview.disabled = !selected.size || !service.directoryWritable; }
        finally { pending = false; body.removeAttribute("aria-busy"); preview.setText(zh ? "预览改名" : "Preview names"); checks.forEach(check => { check.disabled = preview.hidden; }); }
      };
      modal.onClose = () => disposeOriginControls(body);
    };
    if (openEditor) openEditor(modal); else modal.open();
  };
  const openRestore = () => {
    if (state.running || service.folderOperationBusy || recordLoading) return;
    const modal = new Modal(service.app);
    modal.onOpen = () => {
      modal.modalEl.addClass("echoink-settings-modal", "echoink-theme-boundary");
      modal.setTitle(zh ? "复原仓库" : "Restore vault");
      const body = modal.contentEl;
      body.addClass("echoink-knowledge-folder-editor");
      body.createDiv({ cls: "setting-item-description echoink-knowledge-folder-record", text: restoreSummary() });
      const actions = body.createDiv({ cls: "echoink-knowledge-init-actions" });
      createOriginButton(actions, { cls: "text-button", text: zh ? "返回" : "Back" }).onclick = () => modal.close();
      if (record) {
        const confirm = createOriginButton(actions, { text: zh ? "复原目录" : "Restore folders" });
        confirm.disabled = !service.directoryWritable;
        confirm.onclick = () => showSettingsInlineConfirmation(body, confirm, {
          message: zh ? "恢复初始化前的目录结构，保留最新内容和新增文件。确认后开始移动文件。" : "Restore the pre-initialization folder structure, keeping current content and new files. Confirmation starts moving files.",
          confirmLabel: zh ? "确认复原" : "Confirm restore", cancelLabel: zh ? "取消" : "Cancel",
          onConfirm: async () => {
            await run("restore", async () => {
              const result = await service.restoreOriginalDirectories();
              modal.close();
              return zh
                ? `已恢复 ${result.restored} 个文件${result.skipped.length ? `，${result.skipped.length} 项需处理` : ""}。`
                : `Restored ${result.restored} file${result.restored === 1 ? "" : "s"}${result.skipped.length ? `; ${result.skipped.length} item${result.skipped.length === 1 ? " needs" : "s need"} attention` : ""}.`;
            });
          }
        });
      }
      modal.onClose = () => disposeOriginControls(body);
    };
    if (openEditor) openEditor(modal); else modal.open();
  };
}
