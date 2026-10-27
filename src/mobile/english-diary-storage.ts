import { TFolder } from "obsidian";
import type { MobileServices } from "./services";
import { normalizeDiaryPath } from "../english-diary/repository";
import { resolveEnglishStoragePaths } from "../english-diary/storage-paths";

/** Resolve a local view of the already-confirmed setup; construction never saves settings. */
export function mobileEnglishStorage(services: MobileServices) {
  const paths = resolveEnglishStoragePaths(services.settings.englishDiary, services.settings.knowledgeBase.folderBindings,
    (services.app.vault.getRoot?.().children ?? []).map(file => file.path));
  return { ...paths, englishDirectory: normalizeDiaryPath(paths.englishDirectory), expressionDirectory: normalizeDiaryPath(paths.expressionDirectory) };
}
export function assertMobileEnglishStorage(services: MobileServices): void {
  const paths = mobileEnglishStorage(services), output = services.settings.knowledgeBase.folderBindings?.roles.outputs;
  for (const [directory, role] of [[paths.englishDirectory, paths.roleEnglish], [paths.expressionDirectory, paths.roleExpressions]] as const) {
    const existing = services.app.vault.getAbstractFileByPath(directory);
    if (!role) {
      if (!(existing instanceof TFolder)) throw new Error("请在目录方案中确认可用的英文日记和表达库位置；已有资料仍可查看。");
      continue;
    }
    if (!output?.enabled || !output.writePath || !output.readPaths.includes(output.writePath) || !directory.startsWith(output.writePath + "/") || !(services.app.vault.getAbstractFileByPath(output.writePath) instanceof TFolder)) throw new Error("请先选择可用的输出位置；已有英文日记仍可查看。");
    if (existing instanceof TFolder) continue;
    const child = directory.slice(output.writePath.length + 1);
    if (existing || !output.allowedSubdirectories.includes(child) || !(output.allowedSubdirectoryRoots ?? output.readPaths).includes(output.writePath)) throw new Error(`请在目录方案中确认子目录：${child}`);
  }
}
