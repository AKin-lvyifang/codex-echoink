import { FileView, type TFile, type ViewStateResult, type WorkspaceLeaf } from "obsidian";
import { WORKSPACE_ROOT, workspacePath, type WorkspaceService } from "./service";
import { renderWorkspacePreview, type WorkspacePreviewController, type WorkspacePreviewRenderOptions } from "./preview";
import { ownedDiv } from "../ui/owned-dom";

export const WORKSPACE_PREVIEW_VIEW_TYPE = "echoink-workspace-preview";
export interface WorkspacePreviewViewHost extends WorkspacePreviewRenderOptions {
  service: WorkspaceService;
  /** Supply only on desktop. The host owns external browser integration. */
  openExternal?(path: string): void | Promise<void>;
}
export class WorkspacePreviewView extends FileView {
  private path = "";
  private preview?: WorkspacePreviewController;
  constructor(leaf: WorkspaceLeaf, private readonly host: WorkspacePreviewViewHost) { super(leaf); }
  getViewType(): string { return WORKSPACE_PREVIEW_VIEW_TYPE; }
  getDisplayText(): string { return this.path.split("/").pop() || "HTML 预览"; }
  getIcon(): string { return "file-code"; }
  getState(): { path: string; file: string } { return { ...super.getState(), path: this.path, file: this.file?.path ?? this.path }; }
  async setState(state: { path?: string; file?: string }, result: ViewStateResult): Promise<void> {
    const file = typeof state.file === "string" && state.file ? state.file : state.path;
    await super.setState({ ...state, ...(typeof file === "string" && file ? { file } : {}) }, result);
  }
  canAcceptExtension(extension: string): boolean { return extension.toLocaleLowerCase() === "html"; }
  async onLoadFile(file: TFile): Promise<void> {
    this.clearPreview();
    try {
      if (!file.path.startsWith(`${WORKSPACE_ROOT}/`)) throw new Error("只能预览 EchoInk/工作区内的 HTML 文件。");
      const checked = workspacePath(file.path);
      if (!/\.html$/iu.test(checked)) throw new Error("请选择工作区内的 HTML 文件进行预览。");
      this.path = checked;
      this.render();
    } catch (error) {
      const message = ownedDiv(this.contentEl.ownerDocument);
      message.className = "echoink-workspace-preview__error"; message.setAttribute("role", "alert");
      message.textContent = error instanceof Error ? error.message : String(error);
      this.contentEl.append(message);
    }
  }
  async onUnloadFile(_file: TFile): Promise<void> { this.clearPreview(); }
  async onClose(): Promise<void> { this.clearPreview(); await super.onClose(); }
  private clearPreview(): void { this.preview?.destroy(); this.preview = undefined; this.path = ""; this.contentEl.replaceChildren(); }
  private render(): void {
    this.preview?.destroy(); this.contentEl.replaceChildren();
    const openExternal = this.host.openExternal ? (path: string) => this.host.openExternal?.(path) : undefined;
    this.preview = renderWorkspacePreview(this.contentEl.ownerDocument, this.contentEl, this.host.service, this.path,
      openExternal, this.host);
  }
}
