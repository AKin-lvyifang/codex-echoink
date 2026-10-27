import type { KnowledgeFolderBindings } from "../knowledge-base/folder-bindings";
import { digest } from "./knowledge-folders-io";

/** Schema 2 records only changed fields. Null explicitly restores an absent option. */
export interface FolderConfiguration {
  bindings?: KnowledgeFolderBindings | null;
  journal?: string; review?: string; english?: string; expressions?: string;
  englishMode?: "role" | "custom" | null; expressionMode?: "role" | "custom" | null;
  legacyEnglish?: string[] | null; legacyExpressions?: string[] | null;
  pdfOriginal?: string | null; nativeJournal?: string | null;
}
export interface CurrentFolderConfiguration extends FolderConfiguration {
  bindings: KnowledgeFolderBindings | null;
  journal: string; review: string; english: string; expressions: string;
  englishMode?: "role" | "custom"; expressionMode?: "role" | "custom";
  legacyEnglish?: string[]; legacyExpressions?: string[]; pdfOriginal?: string; nativeJournal?: string;
}
export const folderConfigurationKeys = ["bindings", "journal", "nativeJournal", "review", "english", "expressions", "englishMode", "expressionMode", "pdfOriginal", "legacyEnglish", "legacyExpressions"] as const;
export const legacyConfigurationKeys = ["legacyEnglish", "legacyExpressions"] as const;
export const folderConfigurationLabels: Record<keyof FolderConfiguration, string> = {
  bindings: "用途目录", journal: "EchoInk 日记目录", nativeJournal: "Obsidian 日记文件夹", review: "复盘输出目录",
  english: "英文日记目录", expressions: "表达库目录", englishMode: "英文日记保存方式", expressionMode: "表达库保存方式",
  pdfOriginal: "原 PDF 目录", legacyEnglish: "英文日记历史位置", legacyExpressions: "表达库历史位置"
};

export function folderConfigurationDelta(before: CurrentFolderConfiguration, after: CurrentFolderConfiguration) {
  const original: FolderConfiguration = {}, applied: FolderConfiguration = {};
  for (const key of folderConfigurationKeys) {
    if (digest(before[key]) === digest(after[key])) continue;
    if (key === "legacyEnglish" || key === "legacyExpressions") {
      original[key] = before[key] === undefined ? null : before[key].filter(path => !after[key]?.includes(path));
      applied[key] = after[key] === undefined ? null : after[key].filter(path => !before[key]?.includes(path));
    } else {
      Object.assign(original, { [key]: before[key] ?? null }); Object.assign(applied, { [key]: after[key] ?? null });
    }
  }
  return { before: original, after: applied };
}

/** History lists are set deltas, so newer unrelated entries survive restore. */
export function applyFolderConfigurationDelta(current: CurrentFolderConfiguration, before: FolderConfiguration, after: FolderConfiguration): CurrentFolderConfiguration {
  const next = structuredClone(current);
  for (const key of folderConfigurationKeys) {
    if (!Object.hasOwn(after, key)) continue;
    if (key === "legacyEnglish" || key === "legacyExpressions") {
      const paths = [...new Set([...(current[key] ?? []).filter(path => !before[key]?.includes(path)), ...(after[key] ?? [])])];
      if (after[key] === null && !paths.length) delete next[key]; else next[key] = paths;
    } else if (after[key] === null && key !== "bindings") delete next[key];
    else Object.assign(next, { [key]: structuredClone(after[key]) });
  }
  return next;
}
