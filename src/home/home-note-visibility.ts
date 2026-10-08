import { DEFAULT_ENGLISH_DIARY_SETTINGS, LEGACY_ENGLISH_DIRECTORY, LEGACY_EXPRESSION_DIRECTORY, LEGACY_HIDDEN_EXPRESSION_DIRECTORY, type EnglishDiarySettings } from "../english-diary/types";
import { knowledgeRootRole } from "../knowledge-base/root-paths";

export type HomeNoteVisibility = (path: string) => boolean;
type DiaryDirectories = Pick<EnglishDiarySettings, "englishDirectory" | "expressionDirectory" | "legacyEnglishDirectories" | "legacyExpressionDirectories">;

/** Generated diary resources stay in their own product surfaces, even when disabled. */
export function isHomeNotePath(path: string, directories: DiaryDirectories = DEFAULT_ENGLISH_DIARY_SETTINGS): boolean {
  const normalizedPath = path.replace(/\\/gu, "/");
  if (knowledgeRootRole(normalizedPath) === "outputs" && normalizedPath.split("/")[1] === ".english-diary") return false;
  return ![directories.englishDirectory, directories.expressionDirectory, LEGACY_ENGLISH_DIRECTORY,
    LEGACY_EXPRESSION_DIRECTORY, LEGACY_HIDDEN_EXPRESSION_DIRECTORY,
    ...(directories.legacyEnglishDirectories ?? []), ...(directories.legacyExpressionDirectories ?? [])].some((directory) => {
    const normalizedDirectory = directory.trim().replace(/\\/gu, "/").replace(/\/+$/u, "");
    if (!normalizedDirectory || normalizedDirectory.split("/").some((part) => !part || part === "." || part === "..")) return false;
    return normalizedPath.startsWith(`${normalizedDirectory}/`);
  });
}
