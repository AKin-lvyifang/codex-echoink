import { Modal, TFolder, normalizePath } from "obsidian";
import type CodexForObsidianPlugin from "../main";
import { createKnowledgeFolderPicker, type KnowledgeFolderPicker } from "../settings/knowledge-folder-picker";
import { applyAmicroButton } from "../settings/amicro-buttons";
import { createOriginButton, disposeOriginControls } from "../settings/origin-controls";
import { emptyKnowledgeFolderBindings, normalizeKnowledgeFolderBindings } from "../knowledge-base/folder-bindings";
import type { CompanyPermission } from "./service";

/** Current visible Composer wins, then its saved draft, then the previous turn. */
export function companyRouterPermission(plugin: CodexForObsidianPlugin, routerId: string): CompanyPermission {
  const permission = plugin.getCodexView()?.companyCardAccess(routerId).permission
    ?? plugin.settings.taskWorkspace?.replyDrafts[routerId]?.selectedPermission
    ?? plugin.getConversationRunService().lastTurnOptions.get(routerId)?.permission ?? plugin.settings.defaultPermission;
  return permission === "workspace-write" || permission === "danger-full-access" ? permission : "read-only";
}

/** Same directory control used by knowledge settings, inside the existing short-task Modal surface. */
export function chooseCompanyProjectRoot(plugin: CodexForObsidianPlugin): Promise<string | null> {
  return new Promise(resolve => {
    class ProjectRootModal extends Modal {
      private picker?: KnowledgeFolderPicker;
      private selection: string | null = null;
      private result: string | null = null;
      onOpen(): void {
        this.contentEl.addClass("echoink-company-folder-dialog");
        this.titleEl.setText("项目保存到");
        const actions = this.contentEl.createDiv({ cls: "echoink-company-actions" });
        const cancel = createOriginButton(actions, { text: "取消" });
        applyAmicroButton(cancel, { variant: "secondary" }); cancel.onclick = () => this.close();
        const confirm = createOriginButton(actions, { text: "选择并开工", cls: "is-primary" });
        applyAmicroButton(confirm, { variant: "primary" }); confirm.disabled = true;
        const field = this.contentEl.createDiv(); this.contentEl.prepend(field);
        this.picker = createKnowledgeFolderPicker(field, { app: plugin.app, language: plugin.settings.settingsLanguage,
          label: "项目保存到", folders: () => plugin.app.vault.getAllFolders(false).map(folder => folder.path),
          values: [], multiple: false, allowCreate: false, required: true,
          onChange: values => { this.selection = values[0]?.path ?? null; confirm.disabled = this.selection === null; } });
        confirm.onclick = () => { if (this.selection !== null) { this.result = this.selection; this.close(); } };
      }
      onClose(): void { this.picker?.dispose(); disposeOriginControls(this.contentEl); this.contentEl.empty(); resolve(this.result); }
    }
    new ProjectRootModal(plugin.app).open();
  });
}

export async function ensureCompanyProjectFolder(plugin: CodexForObsidianPlugin, name: string, routerId: string,
  choose: () => Promise<string | null> = () => chooseCompanyProjectRoot(plugin)): Promise<string | null> {
  const assertWritable = () => {
    const permission = companyRouterPermission(plugin, routerId);
    if (permission === "read-only") throw new Error("这张卡片是只读权限，切换为可写后再开工。");
  };
  assertWritable();
  const binding = plugin.settings.knowledgeBase.folderBindings?.roles.projects;
  const bound = binding?.enabled ? binding.writePath?.trim() : undefined;
  const root = bound || await choose();
  if (root === null) return null;
  assertWritable();
  if (!(plugin.app.vault.getAbstractFileByPath(root) instanceof TFolder)) throw new Error("项目保存目录已失效，请重新选择。");
  if (!bound) {
    const directories = plugin.getKnowledgeSurfaceService();
    if (!directories) throw new Error("目录服务尚未就绪，请稍后重试。");
    const next = normalizeKnowledgeFolderBindings(plugin.settings.knowledgeBase.folderBindings) ?? emptyKnowledgeFolderBindings();
    next.roles.projects = { ...next.roles.projects, enabled: true, readPaths: [root], writePath: root, allowedSubdirectories: [], allowedSubdirectoryRoots: [] };
    await directories.saveDirectoryBindings(next);
    assertWritable();
  }
  const folder = normalizePath(`${root}/${name}`);
  const existing = plugin.app.vault.getAbstractFileByPath(folder);
  if (existing && !(existing instanceof TFolder)) throw new Error(`项目保存位置被文件占用：${folder}`);
  if (!existing) await plugin.app.vault.createFolder(folder).catch(error => {
    if (!(plugin.app.vault.getAbstractFileByPath(folder) instanceof TFolder)) throw error;
  });
  return folder;
}
