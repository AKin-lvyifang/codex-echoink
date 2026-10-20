import { TFolder } from "obsidian";
import type { MobileServices } from "./services";
import { knowledgeRolePath, resolveKnowledgePathFromRoots } from "../knowledge-base/root-paths-core";
import { normalizeDiaryPath } from "../english-diary/repository";
import { DEFAULT_ENGLISH_DIRECTORY, DEFAULT_EXPRESSION_DIRECTORY, LEGACY_ENGLISH_DIRECTORY, LEGACY_EXPRESSION_DIRECTORY, LEGACY_HIDDEN_ENGLISH_DIRECTORY, HIDDEN_EXPRESSION_DIRECTORY, LEGACY_HIDDEN_EXPRESSION_DIRECTORY } from "../english-diary/types";

/** Resolve a local view of the already-confirmed setup; construction never saves settings. */
export function mobileEnglishStorage(services: MobileServices) {
  const settings = services.settings.englishDiary, bindings = services.settings.knowledgeBase.folderBindings, output = bindings?.roles.outputs;
  const rootNames = (services.app.vault.getRoot?.().children ?? []).map(file => file.path);
  const roots = [...new Set(["outputs", ...rootNames.filter(root => knowledgeRolePath(root) === "outputs"), ...(output?.readPaths ?? []), ...(output?.writePath ? [output.writePath] : [])])];
  const oldEnglish = [DEFAULT_ENGLISH_DIRECTORY, LEGACY_ENGLISH_DIRECTORY, LEGACY_HIDDEN_ENGLISH_DIRECTORY, ...roots.flatMap(root => [`${root}/.english-diary/diaries`, `${root}/英文日记`])];
  const oldExpressions = [DEFAULT_EXPRESSION_DIRECTORY, LEGACY_EXPRESSION_DIRECTORY, LEGACY_HIDDEN_EXPRESSION_DIRECTORY, HIDDEN_EXPRESSION_DIRECTORY, ...roots.flatMap(root => [`${root}/.english-diary/expressions`, `${root}/表达库`, `${root}/英文日记/表达库`])];
  const roleEnglish = settings.englishDirectoryMode === "role" || !settings.englishDirectoryMode && (oldEnglish.includes(settings.englishDirectory) || knowledgeRolePath(settings.englishDirectory) === DEFAULT_ENGLISH_DIRECTORY);
  const roleExpressions = settings.expressionDirectoryMode === "role" || !settings.expressionDirectoryMode && (oldExpressions.includes(settings.expressionDirectory) || knowledgeRolePath(settings.expressionDirectory) === DEFAULT_EXPRESSION_DIRECTORY);
  const englishDirectory = normalizeDiaryPath(roleEnglish && output?.enabled && output.writePath ? `${output.writePath}/英文日记` : !bindings && roleEnglish ? resolveKnowledgePathFromRoots(DEFAULT_ENGLISH_DIRECTORY, rootNames) : settings.englishDirectory);
  const expressionDirectory = normalizeDiaryPath(roleExpressions && output?.enabled && output.writePath ? `${output.writePath}/英文日记/表达库` : !bindings && roleExpressions ? resolveKnowledgePathFromRoots(DEFAULT_EXPRESSION_DIRECTORY, rootNames) : settings.expressionDirectory);
  return { englishDirectory, expressionDirectory, roleEnglish, roleExpressions,
    legacyEnglishDirectories: [...new Set([...(settings.legacyEnglishDirectories ?? []), settings.englishDirectory, ...oldEnglish])].filter(path => path !== englishDirectory),
    legacyExpressionDirectories: [...new Set([...(settings.legacyExpressionDirectories ?? []), settings.expressionDirectory, ...oldExpressions])].filter(path => path !== expressionDirectory) };
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
