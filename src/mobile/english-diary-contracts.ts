import type { DiaryBlock, DiaryPrivacy, DiaryRecord, DiarySource, EnglishDiaryApi, EnglishDiarySettings, ExpressionEntry } from "../english-diary/types";
import type { EnglishDiaryPageData } from "../home/english-diary-page-data";

export interface MobileEnglishDiaryPort {
  readonly api: EnglishDiaryApi;
  readPage(): Promise<EnglishDiaryPageData & { expressionVersions: Record<string, string> }>;
  listSources(): Promise<Pick<DiarySource, "path" | "title" | "date">[]>;
  inspectSource(path: string): Promise<{ source: DiarySource; blocks: DiaryBlock[]; privacy: DiaryPrivacy; record: DiaryRecord; privacyReviewRequired: boolean }>;
  readSaved(id: string): Promise<{ record: DiaryRecord; source: DiarySource | null; englishMarkdown: string | null; canAlign: boolean; errors: string[] }>;
  saveExpression(id: string, changes: { category: string; note: string }, expectedVersion: string): Promise<ExpressionEntry>;
  readSettings(): Promise<{ settings: EnglishDiarySettings; version: string }>;
  saveSettings(patch: Partial<EnglishDiarySettings>, expectedVersion: string): Promise<void>;
  readProvider(): Promise<{ version: string; label: string; recipient: string; approved: boolean }>;
  approveProvider(expectedVersion: string): Promise<void>;
  subscribe(listener: () => void): () => void;
}
