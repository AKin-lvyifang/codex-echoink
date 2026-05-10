import type { EditorPosition } from "obsidian";

export type BuiltInEditorActionId = "rewrite" | "expand" | "continue";
export type EditorActionQualityMode = "fast" | "quality" | "strict";
export type EditorActionStatus = "idle" | "preparing" | "connecting" | "generating" | "awaiting-confirm" | "confirmed" | "canceled" | "failed";
export const DEFAULT_EDITOR_ACTION_MODEL = "gpt-5.4-mini";

export interface EditorActionSummaryCacheEntry {
  filePath: string;
  mtime: number;
  size: number;
  contentHash: string;
  summary: string;
  updatedAt: number;
  lastUsedAt: number;
}

export type EditorActionSummaryCache = Record<string, EditorActionSummaryCacheEntry>;

export interface ArticleUnderstandingEntry {
  filePath: string;
  mtime: number;
  size: number;
  contentHash: string;
  model: string;
  mode: EditorActionQualityMode;
  understanding: string;
  updatedAt: number;
  lastUsedAt: number;
}

export type ArticleUnderstandingCache = Record<string, ArticleUnderstandingEntry>;

export type ArticleUnderstandingStatus = "idle" | "missing" | "running" | "fresh" | "stale" | "failed";

export interface EditorActionModeConfig {
  mode: EditorActionQualityMode;
  label: string;
  model: string;
  contextCharsBefore: number;
  contextCharsAfter: number;
}

export interface EditorAiActionConfig {
  id: BuiltInEditorActionId | string;
  label: string;
  enabled: boolean;
  promptTemplate: string;
}

export interface EditorAiStyleConfig {
  id: string;
  label: string;
  instruction: string;
}

export interface EditorAiActionSettings {
  enabled: boolean;
  statusSlotEnabled: boolean;
  qualityMode: EditorActionQualityMode;
  showContextPanel: boolean;
  model: string;
  defaultStyleId: string;
  maxSelectedChars: number;
  contextCharsBefore: number;
  contextCharsAfter: number;
  timeoutMs: number;
  modeConfigs: Record<EditorActionQualityMode, EditorActionModeConfig>;
  articleUnderstandingCache: ArticleUnderstandingCache;
  /** @deprecated migrated to articleUnderstandingCache */
  summaryCacheEnabled: boolean;
  /** @deprecated migrated to articleUnderstandingCache */
  summaryCache: EditorActionSummaryCache;
  actions: EditorAiActionConfig[];
  styles: EditorAiStyleConfig[];
}

export interface EditorActionSelectionSnapshot {
  filePath: string;
  fileName: string;
  fromOffset: number;
  toOffset: number;
  from: EditorPosition;
  to: EditorPosition;
  selectedText: string;
  beforeContext: string;
  afterContext: string;
  articleUnderstanding?: string;
  /** @deprecated use articleUnderstanding */
  noteSummary?: string;
}

export interface EditorActionPromptInput {
  action: EditorAiActionConfig;
  style: EditorAiStyleConfig;
  snapshot: EditorActionSelectionSnapshot;
  qualityMode?: EditorActionQualityMode;
  modeLabel?: string;
}

export interface EditorActionRequest {
  id: string;
  action: EditorAiActionConfig;
  style: EditorAiStyleConfig;
  snapshot: EditorActionSelectionSnapshot;
  source: {
    filePath: string;
    fileName: string;
    text: string;
    mtime: number;
    size: number;
  };
  qualityMode: EditorActionQualityMode;
  modeConfig: EditorActionModeConfig;
  prompt: string;
  createdAt: number;
}

export interface EditorActionCandidate {
  id: string;
  actionId: string;
  filePath: string;
  fromOffset: number;
  toOffset: number;
  originalText: string;
  candidateText: string;
  documentLength: number;
  createdAt: number;
}

export interface EditorActionStatusView {
  status: EditorActionStatus;
  actionLabel?: string;
  phase?: "understanding" | "generating" | "reviewing";
  qualityMode?: EditorActionQualityMode;
  modeLabel?: string;
  filePath?: string;
  model?: string;
  understandingStatus?: ArticleUnderstandingStatus;
  usedArticleUnderstanding?: boolean;
  message?: string;
  startedAt?: number;
  error?: string;
}
