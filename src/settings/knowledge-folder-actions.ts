import type { EchoInkKnowledgeSurfaceService } from "../plugin/knowledge-surface-service";

export function renderKnowledgeFolderActions(
  container: HTMLElement,
  service: EchoInkKnowledgeSurfaceService,
  language: string,
  refresh: () => Promise<void>
): void {
  const zh = language !== "en";
  const panel = container.createDiv({ cls: "echoink-knowledge-folder-actions" });
  const controls = panel.createDiv({ cls: "dashboard-actions" });
  const status = panel.createDiv({ attr: { role: "status", "aria-live": "polite" } });
  status.setText(service.folderOperationMessage);
  const button = controls.createEl("button", { cls: "text-button", text: zh ? "优化文件夹名称" : "Optimize folder names", attr: { type: "button" } });
  button.disabled = service.folderOperationBusy || !service.directoryWritable;
  button.onclick = () => {
    button.disabled = true;
    status.setText(zh ? "正在检查 Wiki 目录…" : "Checking Wiki folders…");
    void service.optimizeFolderNames((message) => status.setText(message)).then((result) => {
      service.folderOperationMessage = zh
        ? `已改名 ${result.renamed.length} 个目录；跳过 ${result.skipped.length}。${result.skipped.map((item) => `${item.path}：${item.reason}`).join("；")}`
        : `Renamed ${result.renamed.length}; skipped ${result.skipped.length}. ${result.skipped.map((item) => `${item.path}: ${item.reason}`).join("; ")}`;
    }).catch((error: unknown) => {
      service.folderOperationMessage = error instanceof Error ? error.message : String(error);
    }).finally(() => {
      status.setText(service.folderOperationMessage);
      button.disabled = !service.directoryWritable;
      void refresh();
    });
  };
  const restore = controls.createEl("button", { cls: "text-button", text: zh ? "恢复初始化前目录" : "Restore pre-initialization folders", attr: { type: "button" } });
  restore.disabled = true;
  const original = panel.createDiv({ cls: "settings-note" });
  void service.getOriginalDirectoryStatus().then((record) => {
    original.setText(record
      ? (zh ? `原始目录记录：${new Date(record.createdAt).toLocaleString()}，${record.files} 个文件。保留最新内容与后来新增文件。`
        : `Original layout: ${new Date(record.createdAt).toLocaleString()}, ${record.files} files. Latest content and newer files are kept.`)
      : (zh ? "暂无初始化前目录记录" : "No pre-initialization directory record"));
    restore.disabled = !record || service.folderOperationBusy || !service.directoryWritable;
  }).catch((error: unknown) => { original.setText(String(error)); });
  restore.onclick = () => {
    restore.disabled = true; button.disabled = true;
    void service.restoreOriginalDirectories((message) => status.setText(message)).then((result) => {
      service.folderOperationMessage = zh
        ? `已恢复 ${result.restored} 个文件；未恢复 ${result.skipped.length}。${result.skipped.map((item) => `${item.path}：${item.reason}`).join("；")}`
        : `Restored ${result.restored}; unresolved ${result.skipped.length}. ${result.skipped.map((item) => `${item.path}: ${item.reason}`).join("; ")}`;
    }).catch((error: unknown) => { service.folderOperationMessage = error instanceof Error ? error.message : String(error); })
      .finally(() => { status.setText(service.folderOperationMessage); restore.disabled = false; button.disabled = !service.directoryWritable; void refresh(); });
  };
}
