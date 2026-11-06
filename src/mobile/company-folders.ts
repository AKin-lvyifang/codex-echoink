import { FuzzySuggestModal, TFolder, normalizePath, type App } from "obsidian";
import { emptyKnowledgeFolderBindings, normalizeKnowledgeFolderBindings } from "../knowledge-base/folder-bindings";
import type { MobileCompanyFolderPort } from "./company-host";
import type { MobileSettings } from "./settings";

/** Asks once for the project root with the platform folder suggester; cancelling resolves null. */
function chooseFolder(app: App): Promise<string | null> {
  return new Promise(resolve => {
    let chosen: string | null = null;
    class ProjectRootModal extends FuzzySuggestModal<TFolder> {
      getItems(): TFolder[] { return app.vault.getAllFolders(false); }
      getItemText(folder: TFolder): string { return folder.path; }
      onChooseItem(folder: TFolder): void { chosen = folder.path; }
      onClose(): void { super.onClose(); window.setTimeout(() => resolve(chosen), 0); }
    }
    const modal = new ProjectRootModal(app);
    modal.setPlaceholder("项目保存到哪个文件夹");
    modal.open();
  });
}

/** The enabled "projects" binding wins; without one, the chosen root becomes that binding. */
export function createMobileCompanyFolders(app: App, settings: () => MobileSettings, save: () => Promise<void>): MobileCompanyFolderPort {
  return {
    async projectRoot() {
      const binding = settings().knowledgeBase.folderBindings?.roles.projects;
      const bound = binding?.enabled ? binding.writePath?.trim() : undefined;
      const root = bound || await chooseFolder(app);
      if (root === null) return null;
      if (!(app.vault.getAbstractFileByPath(root) instanceof TFolder)) throw new Error("项目保存目录已失效，请重新选择。");
      if (!bound) {
        const next = normalizeKnowledgeFolderBindings(settings().knowledgeBase.folderBindings) ?? emptyKnowledgeFolderBindings();
        next.roles.projects = { ...next.roles.projects, enabled: true, readPaths: [root], writePath: root, allowedSubdirectories: [], allowedSubdirectoryRoots: [] };
        settings().knowledgeBase.folderBindings = next;
        await save();
      }
      return root;
    },
    async ensureFolder(path) {
      const folder = normalizePath(path);
      const existing = app.vault.getAbstractFileByPath(folder);
      if (existing && !(existing instanceof TFolder)) throw new Error(`项目保存位置被文件占用：${folder}`);
      if (!existing) await app.vault.createFolder(folder).catch(error => { if (!(app.vault.getAbstractFileByPath(folder) instanceof TFolder)) throw error; });
    }
  };
}
