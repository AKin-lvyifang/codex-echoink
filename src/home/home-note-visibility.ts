import { DEFAULT_ENGLISH_DIARY_SETTINGS, LEGACY_ENGLISH_DIRECTORY, LEGACY_EXPRESSION_DIRECTORY, LEGACY_HIDDEN_EXPRESSION_DIRECTORY, type EnglishDiarySettings } from "../english-diary/types";
import { FINANCE_DEFAULT_ROOT, FINANCE_BILINGUAL_ROOT, FINANCE_LEGACY_ROOT } from "../lifestyle/finance-paths";
import { knowledgeRootRole } from "../knowledge-base/root-paths-core";

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

export interface HomeRecentNoteContext {
  analysisDirectory?: string;
  reportPaths?: ReadonlySet<string>;
  reportType?: string;
  configDirectory?: string;
  templatesDirectory?: string;
}
const relative = (value: string) => value.trim().replace(/\\/gu, "/").replace(/\/+$/u, "");
const inDirectory = (path: string, directory: string) => !!directory && (path === directory || path.startsWith(`${directory}/`));

/** Only recent-note candidates use these system exclusions; search and activity keep their own scope. */
export function isHomeRecentSystemPath(path: string, journalDirectory: string, context: HomeRecentNoteContext): boolean {
  path=relative(path);
  if (context.reportPaths?.has(path) || context.reportType === "finance-analysis") return true;
  if ([FINANCE_DEFAULT_ROOT, FINANCE_BILINGUAL_ROOT, FINANCE_LEGACY_ROOT,
    context.configDirectory ?? ".obsidian", ".echoink"].some(root=>inDirectory(path,relative(root)))) return true;
  // The configured native diary remains content even when it overlaps a template root.
  if (inDirectory(path,relative(journalDirectory))) return false;
  if (knowledgeRootRole(path) === "templates" || inDirectory(path,relative(context.templatesDirectory ?? "templates"))) return true;
  const directory=relative(context.analysisDirectory ?? "");
  // A content root can hold ordinary results alongside reports. Identify reports there by index/type.
  const contentRoot=directory && !directory.includes("/") && ["raw","wiki","outputs","projects","inbox","journal","index"].includes(knowledgeRootRole(directory) ?? directory);
  const diaryRoot=directory && inDirectory(relative(journalDirectory),directory);
  return !contentRoot && !diaryRoot && inDirectory(path,directory);
}
