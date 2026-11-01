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

/** Disabled modules participate only when explicitly selected; custom choices never depend on Outputs. */
export function prepareKnowledgeModuleDirectories(settings: KnowledgeModuleSettings, bindings: KnowledgeFolderBindings | null | undefined,
  roots: readonly string[], choices: KnowledgeModuleDirectories = {}, _savedBindings = bindings) {
  const directories: KnowledgeModuleDirectories = {}, modes: KnowledgeEnglishDirectoryModes = {}, issues: string[] = [];
  if (choices.journal !== undefined) directories.journal = choices.journal;
  if (choices.review !== undefined || settings.review.enabled) directories.review = choices.review ?? settings.review.outputDir;
  if (choices.pdfOriginal !== undefined || settings.pdfReading?.enabled) directories.pdfOriginal = choices.pdfOriginal ?? settings.pdfReading?.originalDirectory;
  if (settings.englishDiary.enabled || choices.english !== undefined || choices.expressions !== undefined) {
    const paths = resolveEnglishStoragePaths(settings.englishDiary, bindings, roots);
    for (const [key, pathKey, roleKey] of [["english", "englishDirectory", "roleEnglish"], ["expressions", "expressionDirectory", "roleExpressions"]] as const) {
      const choice = choices[key];
      if (!settings.englishDiary.enabled && choice === undefined) continue;
      const role = choice === undefined && settings.englishDiary.enabled && paths[roleKey];
      modes[key] = role ? "role" : "custom";
      if (choice === "") {
        // Optional locations can be skipped without changing the module's saved settings.
        modes[key] = "custom";
        directories[key] = ""; continue;
      }
      directories[key] = role ? paths[pathKey] : choice ?? paths[pathKey];
    }
  }
  return { directories, modes, issues };
}
