import type { EditorPosition } from "obsidian";

export type BuiltInEditorActionId = "rewrite" | "expand" | "continue";
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
  model: string;
  defaultStyleId: string;
  maxSelectedChars: number;
  contextCharsBefore: number;
  contextCharsAfter: number;
  timeoutMs: number;
  summaryCacheEnabled: boolean;
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
  noteSummary?: string;
}

export interface EditorActionPromptInput {
  action: EditorAiActionConfig;
  style: EditorAiStyleConfig;
  snapshot: EditorActionSelectionSnapshot;
}

export interface EditorActionRequest {
  id: string;
  action: EditorAiActionConfig;
  style: EditorAiStyleConfig;
  snapshot: EditorActionSelectionSnapshot;
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
  message?: string;
  startedAt?: number;
  error?: string;
}
