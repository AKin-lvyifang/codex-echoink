import type { EnglishDiarySettings } from "./types";
import type { KnowledgeFolderBindings } from "../knowledge-base/folder-bindings";
import { knowledgeRolePath, resolveKnowledgePathFromRoots } from "../knowledge-base/root-paths-core";
import { DEFAULT_ENGLISH_DIRECTORY, DEFAULT_EXPRESSION_DIRECTORY, LEGACY_ENGLISH_DIRECTORY, LEGACY_EXPRESSION_DIRECTORY, LEGACY_HIDDEN_ENGLISH_DIRECTORY, HIDDEN_EXPRESSION_DIRECTORY, LEGACY_HIDDEN_EXPRESSION_DIRECTORY } from "./types";

/** Pure role resolution shared by storage and directory setup; callers validate operation paths. */
export function resolveEnglishStoragePaths(settings: EnglishDiarySettings, bindings: KnowledgeFolderBindings | null | undefined, rootNames: readonly string[]) {
  const output = bindings?.roles.outputs;
  const roots = [...new Set(["outputs", ...rootNames.filter(root => knowledgeRolePath(root) === "outputs"), ...(output?.readPaths ?? []), ...(output?.writePath ? [output.writePath] : [])])];
  const oldEnglish = [DEFAULT_ENGLISH_DIRECTORY, LEGACY_ENGLISH_DIRECTORY, LEGACY_HIDDEN_ENGLISH_DIRECTORY, ...roots.flatMap(root => [`${root}/.english-diary/diaries`, `${root}/英文日记`])];
  const oldExpressions = [DEFAULT_EXPRESSION_DIRECTORY, LEGACY_EXPRESSION_DIRECTORY, LEGACY_HIDDEN_EXPRESSION_DIRECTORY, HIDDEN_EXPRESSION_DIRECTORY, ...roots.flatMap(root => [`${root}/.english-diary/expressions`, `${root}/表达库`, `${root}/英文日记/表达库`])];
  const roleEnglish = settings.englishDirectoryMode === "role" || !settings.englishDirectoryMode && (oldEnglish.includes(settings.englishDirectory) || knowledgeRolePath(settings.englishDirectory) === DEFAULT_ENGLISH_DIRECTORY);
  const roleExpressions = settings.expressionDirectoryMode === "role" || !settings.expressionDirectoryMode && (oldExpressions.includes(settings.expressionDirectory) || knowledgeRolePath(settings.expressionDirectory) === DEFAULT_EXPRESSION_DIRECTORY);
  const englishDirectory = (roleEnglish && output?.enabled && output.writePath ? `${output.writePath}/英文日记` : !bindings && roleEnglish ? resolveKnowledgePathFromRoots(DEFAULT_ENGLISH_DIRECTORY, rootNames) : settings.englishDirectory);
  const expressionDirectory = (roleExpressions && output?.enabled && output.writePath ? `${output.writePath}/英文日记/表达库` : !bindings && roleExpressions ? resolveKnowledgePathFromRoots(DEFAULT_EXPRESSION_DIRECTORY, rootNames) : settings.expressionDirectory);
  return { englishDirectory, expressionDirectory, roleEnglish, roleExpressions,
    legacyEnglishDirectories: [...new Set([...(settings.legacyEnglishDirectories ?? []), settings.englishDirectory, ...oldEnglish])].filter(path => path !== englishDirectory),
    legacyExpressionDirectories: [...new Set([...(settings.legacyExpressionDirectories ?? []), settings.expressionDirectory, ...oldExpressions])].filter(path => path !== expressionDirectory) };
}
