import { rebaseKnowledgeFolderBindings, type KnowledgeFolderBindings } from "./folder-bindings";
import { rebaseKnowledgePath } from "./root-paths-core";

/** The saved directory fields only; histories and native Obsidian options have separate owners. */
export interface FolderPathSettings {
  knowledgeBase?: { folderBindings?: KnowledgeFolderBindings | null };
  journalDirectory?: string;
  sessions?: Array<{ journalDirectory?: string }>;
  review?: { outputDir?: string };
  englishDiary?: {
    englishDirectory?: string;
    expressionDirectory?: string;
    englishDirectoryMode?: "role" | "custom";
    expressionDirectoryMode?: "role" | "custom";
    legacyEnglishDirectories?: string[];
    legacyExpressionDirectories?: string[];
  };
  pdfReading?: { originalDirectory?: string };
  lifestyle?: { finance?: { analysisDirectory?: string } };
  mobileUi?: { knowledgePaths?: Partial<Record<"raw" | "wiki" | "inbox", string>> };
}

export type FolderSettingsPathEvent =
  | { type: "rename"; kind: "folder" | "file"; from: string; to: string }
  | { type: "delete"; kind: "folder" | "file"; path: string };

function rebaseDirectoryFields<T extends object>(value: T, from: string, to: string,
  fields: readonly (keyof T)[], arrays: readonly (keyof T)[] = []): T {
  let next = value;
  for (const key of fields) {
    const current: unknown = value[key];
    if (typeof current !== "string") continue;
    const rebased = rebaseKnowledgePath(current, from, to);
    if (rebased !== current) next = { ...next, [key]: rebased };
  }
  for (const key of arrays) {
    const current: unknown = value[key];
    if (!Array.isArray(current)) continue;
    const rebased = current.map((item: unknown) => typeof item === "string" ? rebaseKnowledgePath(item, from, to) : item);
    if (rebased.some((item, index) => item !== current[index])) next = { ...next, [key]: rebased };
  }
  return next;
}

/**
 * Follow a real folder rename/move using complete Vault-relative paths.
 * Disabled modules keep their locations too. A deletion leaves the saved choice
 * intact, so a missing folder can be shown and explicitly replaced by the user.
 * No recursive field/key guessing or note-body rewriting belongs here.
 */
export function rebaseFolderSettingsPaths<T extends FolderPathSettings>(settings: T, event: FolderSettingsPathEvent): T {
  if (event.type !== "rename" || event.kind !== "folder" || !event.from || !event.to || event.from === event.to) return settings;
  const { from, to } = event;
  let next = rebaseDirectoryFields(settings, from, to, ["journalDirectory"]);
  const replace = <K extends keyof FolderPathSettings>(key: K, value: FolderPathSettings[K]): void => {
    if (value !== settings[key]) next = { ...next, [key]: value };
  };
  if (settings.knowledgeBase?.folderBindings) {
    const bindings = rebaseKnowledgeFolderBindings(settings.knowledgeBase.folderBindings, from, to);
    if (JSON.stringify(bindings) !== JSON.stringify(settings.knowledgeBase.folderBindings)) {
      replace("knowledgeBase", { ...settings.knowledgeBase, folderBindings: bindings });
    }
  }
  if (settings.sessions) {
    const sessions = settings.sessions.map(session => rebaseDirectoryFields(session, from, to, ["journalDirectory"]));
    if (sessions.some((session, index) => session !== settings.sessions![index])) replace("sessions", sessions);
  }
  if (settings.review) replace("review", rebaseDirectoryFields(settings.review, from, to, ["outputDir"]));
  if (settings.englishDiary) {
    let englishDiary = rebaseDirectoryFields(settings.englishDiary, from, to,
      ["englishDirectory", "expressionDirectory"], ["legacyEnglishDirectories", "legacyExpressionDirectories"]);
    // A real rename chooses this exact folder. Keep role resolution from
    // restoring a conventional child name when the controller refreshes.
    if (englishDiary.englishDirectory !== settings.englishDiary.englishDirectory) englishDiary = { ...englishDiary, englishDirectoryMode: "custom" };
    if (englishDiary.expressionDirectory !== settings.englishDiary.expressionDirectory) englishDiary = { ...englishDiary, expressionDirectoryMode: "custom" };
    replace("englishDiary", englishDiary);
  }
  if (settings.pdfReading) replace("pdfReading", rebaseDirectoryFields(settings.pdfReading, from, to, ["originalDirectory"]));
  if (settings.lifestyle?.finance) {
    const finance = rebaseDirectoryFields(settings.lifestyle.finance, from, to, ["analysisDirectory"]);
    if (finance !== settings.lifestyle.finance) replace("lifestyle", { ...settings.lifestyle, finance });
  }
  if (settings.mobileUi?.knowledgePaths) {
    const knowledgePaths = rebaseDirectoryFields(settings.mobileUi.knowledgePaths, from, to, ["raw", "wiki", "inbox"]);
    if (knowledgePaths !== settings.mobileUi.knowledgePaths) replace("mobileUi", { ...settings.mobileUi, knowledgePaths });
  }
  return next;
}
