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
  const paths = mobileEnglishStorage(services);
  for (const [directory, role] of [[paths.englishDirectory, paths.roleEnglish], [paths.expressionDirectory, paths.roleExpressions]] as const) {
    const existing = services.app.vault.getAbstractFileByPath(directory);
    if (!role) {
      if (!(existing instanceof TFolder)) throw new Error("请在目录方案中确认可用的英文日记和表达库位置；已有资料仍可查看。");
      continue;
    }
    if (existing && !(existing instanceof TFolder)) throw new Error("英文日记或表达库的保存位置被文件占用，请重新选择文件夹；已有资料仍可查看。");
  }
}
