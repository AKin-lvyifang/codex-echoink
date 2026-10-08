import type { CapabilityAccess } from "../membership/types";
/** Shared contracts for the optional English Diary product. */
export const ENGLISH_DIARY_VIEW = "echoink-english-diary";
export const ENGLISH_EXPRESSION_VIEW = "echoink-english-expressions";
export const ENGLISH_DIARY_SKILL = "english-diary" as const;
export const DEFAULT_ENGLISH_DIRECTORY = "outputs/.english-diary/diaries";
export const DEFAULT_EXPRESSION_DIRECTORY = "outputs/.english-diary/expressions";
export const HIDDEN_EXPRESSION_DIRECTORY = DEFAULT_EXPRESSION_DIRECTORY;
export const LEGACY_ENGLISH_DIRECTORY = "EchoInk/英文日记";
export const LEGACY_HIDDEN_EXPRESSION_DIRECTORY = ".echoink/english-diary/expressions";
export const LEGACY_EXPRESSION_DIRECTORY = "EchoInk/表达库";

export interface EnglishDiarySettings {
  enabled: boolean;
  /** Ask once before changing the existing Home quick-record entry. */
  homeShortcut: "ask" | "quick-record" | "english-diary";
  englishDirectory: string;
  expressionDirectory: string;
  legacyEnglishDirectories?: string[];
  legacyExpressionDirectories?: string[];
  /** Both ids empty means follow the global default Provider and model. */
  providerSettingsId: string;
  modelId: string;
  approvedProvider: string;
}
export const DEFAULT_ENGLISH_DIARY_SETTINGS: EnglishDiarySettings = {
  enabled: false,
  homeShortcut: "ask",
  englishDirectory: DEFAULT_ENGLISH_DIRECTORY,
  expressionDirectory: DEFAULT_EXPRESSION_DIRECTORY,
  legacyEnglishDirectories: [],
  legacyExpressionDirectories: [],
  providerSettingsId: "",
  modelId: "",
  approvedProvider: ""
};

export interface DiarySource {
  path: string;
  title: string;
  date: string;
  content: string;
}
export type ProcessingMode = "translate" | "preserve" | "exclude";
export interface DiaryBlock {
  id: string;
  text: string;
  start: number;
  end: number;
  protected: boolean;
}
export interface DiaryPrivacy {
  sourceFingerprint: string;
  rules: Array<{ blockId: string; mode: ProcessingMode }>;
}
export interface DiaryRange { start: number; end: number; text: string }
export interface DiaryAlignment {
  id: string;
  kind: "translation" | "correction" | "connection";
  source: DiaryRange[];
  target: DiaryRange[];
  reason: string;
  status: "verified" | "needs-review";
}
export interface DiaryExpression {
  id: string;
  term: string;
  type: "phrase" | "sentence";
  meaning: string;
  category: string;
  scene: string;
  example: string;
  reason: string;
  usage: string;
  sourceExcerpt: string;
  targetExcerpt: string;
  alignmentId?: string;
  status: "verified" | "needs-review";
}
export interface DiaryResult {
  schema: 1;
  operationId: string;
  journalId: string;
  sourcePath: string;
  sourceTitle: string;
  date: string;
  sourceFingerprint: string;
  english: string;
  englishFingerprint: string;
  alignments: DiaryAlignment[];
  expressions: DiaryExpression[];
  generatedAt: string;
  provider: string;
  warnings: string[];
}
export interface DiaryRecord {
  schema: 1;
  id: string;
  sourcePath: string;
  englishPath: string;
  result: DiaryResult | null;
  /** Last successfully published full Markdown hash, for manual-edit protection. */
  savedFileFingerprint: string | null;
  observedFileFingerprint?: string | null;
  privacy: DiaryPrivacy | null;
  pending: DiaryResult | null;
  missingEnglish: boolean;
  englishModified: boolean;
}
export interface ExpressionOccurrence {
  id: string;
  journalId: string;
  sourcePath: string;
  englishPath: string;
  sourceTitle: string;
  date: string;
  sourceFingerprint: string;
  scene: string;
  example: string;
  reason: string;
  usage: string;
  sourceExcerpt: string;
  targetExcerpt: string;
  status: "verified" | "needs-review";
}
export interface ExpressionEntry {
  schema: 1;
  id: string;
  path: string;
  term: string;
  type: "phrase" | "sentence";
  meaning: string;
  category: string;
  userCategory: boolean;
  note: string;
  occurrences: ExpressionOccurrence[];
}
/** Relative Vault paths only. Implementations compare expected content before mutation. */
export interface DiaryFilePort {
  read(path: string): Promise<string | null>;
  write(path: string, content: string, expected: string | null): Promise<void>;
  list(directory: string): Promise<string[]>;
  move(from: string, to: string, expected?: string): Promise<void>;
  remove(path: string, expected: string): Promise<void>;
}
export interface DiaryGenerationDay { date: string; expressionCount: number; generationCount: number }
export interface DiaryRepository {
  subscribe?(listener: () => void): () => void;
  listGenerationActivity(): Promise<DiaryGenerationDay[]>;
  get(source: DiarySource): Promise<DiaryRecord>;
  acquireExpressionPermit?(operationId: string): object;
  publish(record: DiaryRecord, result: DiaryResult, options: { expressionPermit?: object; overwriteModified?: boolean; signal?: AbortSignal; sourceUnchanged: () => Promise<boolean> }): Promise<DiaryRecord>;
  savePrivacy(record: DiaryRecord, privacy: DiaryPrivacy): Promise<void>;
  restore(record: DiaryRecord): Promise<DiaryRecord>;
  listExpressions(query?: string, category?: string): Promise<ExpressionEntry[]>;
  updateExpression(id: string, changes: { category: string; note: string }): Promise<ExpressionEntry>;
  removeOccurrence(entryId: string, occurrenceId: string): Promise<void>;
  markExpression(record: DiaryRecord, expressionId: string, status: "verified" | "needs-review", reason?: string): Promise<DiaryRecord>;
  renameSource(oldPath: string, newPath: string): Promise<void>;
}
export interface DiaryGenerator {
  generate(input: { systemPrompt: string; userPrompt: string; signal: AbortSignal }): Promise<string>;
  skill(): Promise<string>;
  providerLabel(): string;
}
export interface GenerateDiaryOptions {
  privacy?: DiaryPrivacy;
  overwriteModified?: boolean;
  expectedEnglishFingerprint?: string | null;
  signal?: AbortSignal;
  onStage?: (stage: "generating" | "saving" | "restoring") => void;
}
export interface EnglishDiaryApi {
  readonly access?: CapabilityAccess;
  readSource(path: string): Promise<DiarySource>;
  load(path: string): Promise<DiaryRecord>;
  generate(path: string, options?: GenerateDiaryOptions): Promise<DiaryRecord>;
  cancel(path: string): void;
  cancelAll(): void;
  isGenerating(path: string): boolean;
  savePrivacy(path: string, privacy: DiaryPrivacy): Promise<void>;
  restore(path: string): Promise<DiaryRecord>;
  repository: DiaryRepository;
}
