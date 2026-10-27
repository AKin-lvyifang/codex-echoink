import type { EnglishDiarySettings } from "../english-diary/types";
import { resolveEnglishStoragePaths } from "../english-diary/storage-paths";
import { normalizeKnowledgeDirectory, type KnowledgeFolderBindings } from "./folder-bindings";
import type { KnowledgeModuleDirectories } from "./folder-plan";

export const knowledgeModuleLabels = { journal: "日记目录", review: "复盘输出目录", english: "英文日记目录", expressions: "表达库目录", pdfOriginal: "原 PDF 目录" } as const;
export interface KnowledgeModuleSettings {
  review: { enabled: boolean; outputDir: string };
  englishDiary: EnglishDiarySettings;
  pdfReading?: { enabled?: boolean; originalDirectory?: string };
}
export type KnowledgeEnglishDirectoryModes = Partial<Record<"english" | "expressions", "role" | "custom">>;

/** Add context without changing the strict operation-path rules. Empty is only a journal root. */
export function assertKnowledgeModulePath(value: string, label: string, allowRoot = false): void {
  if (allowRoot && value === "") return;
  try {
    if (normalizeKnowledgeDirectory(value) !== value || value.split("/").some(part => part.toLowerCase() === "node_modules")) throw new Error("目录操作包含不安全路径。");
  } catch { throw new Error(`${label}：请选择合法的 Vault 相对目录（${JSON.stringify(value)}）。`); }
}

/** Disabled settings stay untouched; explicit custom choices never depend on Outputs. */
export function prepareKnowledgeModuleDirectories(settings: KnowledgeModuleSettings, bindings: KnowledgeFolderBindings | null | undefined,
  roots: readonly string[], choices: KnowledgeModuleDirectories = {}, savedBindings = bindings) {
  const directories: KnowledgeModuleDirectories = {}, modes: KnowledgeEnglishDirectoryModes = {}, issues: string[] = [];
  if (choices.journal !== undefined) directories.journal = choices.journal;
  if (settings.review.enabled) directories.review = choices.review ?? settings.review.outputDir;
  if (settings.pdfReading?.enabled && (choices.pdfOriginal ?? settings.pdfReading.originalDirectory) !== undefined) directories.pdfOriginal = choices.pdfOriginal ?? settings.pdfReading.originalDirectory;
  if (settings.englishDiary.enabled) {
    const paths = resolveEnglishStoragePaths(settings.englishDiary, bindings, roots), previous = resolveEnglishStoragePaths(settings.englishDiary, savedBindings, roots);
    for (const [key, pathKey, roleKey, storedKey] of [["english", "englishDirectory", "roleEnglish", "englishDirectory"], ["expressions", "expressionDirectory", "roleExpressions", "expressionDirectory"]] as const) {
      const choice = choices[key];
      const role = paths[roleKey] && (choice === undefined || choice === paths[pathKey] || choice === previous[pathKey] || choice === settings.englishDiary[storedKey]);
      modes[key] = role ? "role" : "custom";
      if (role && (!bindings?.roles.outputs.enabled || !bindings.roles.outputs.writePath || !bindings.roles.outputs.readPaths.includes(bindings.roles.outputs.writePath))) {
        issues.push(`${knowledgeModuleLabels[key]}：请先绑定输出目录。`); continue;
      }
      directories[key] = role ? paths[pathKey] : choice ?? paths[pathKey];
    }
  }
  return { directories, modes, issues };
}
