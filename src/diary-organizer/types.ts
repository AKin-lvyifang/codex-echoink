/** The organizer owns no Vault discovery, provider, TodoStore or FinanceService. */
export type DiaryItemStatus = "pending" | "review" | "written" | "ignored" | "undone";
export type DiaryFinanceKind = "expense" | "income" | "refund" | "transfer";
export type DiaryConfidence = "high" | "medium" | "low";

export interface DiarySource {
  path: string;
  /** YYYY-MM-DD, supplied by the existing native-journal date recognizer. */
  date: string;
  mtime: number;
  /** Optional stable file identity. Call renameDiary when only paths are available. */
  identity?: string;
}

export interface DiaryCandidateBase {
  type: "todo" | "finance";
  quote: string;
  confidence: DiaryConfidence;
  /** False/uncertain prevents automatic writing. */
  occurred: boolean;
  ownership: "self" | "other" | "uncertain";
  concerns?: string[];
}
export interface DiaryTodoCandidate extends DiaryCandidateBase {
  type: "todo";
  text: string;
  dueDate?: string | null;
  category?: string;
}
export interface DiaryFinanceCandidate extends DiaryCandidateBase {
  type: "finance";
  kind: DiaryFinanceKind;
  amountCents: number;
  currency: string;
  date: string;
  merchant: string;
  category: string;
  description?: string;
}
export type DiaryCandidate = DiaryTodoCandidate | DiaryFinanceCandidate;

export interface DiaryWrittenRecord {
  id: string;
  /** Canonical revision of all meaningful fields, including completion/import links. */
  version: string;
  /** Human-readable fields to show when undo requires a second confirmation. */
  summary: string;
}
export interface DiaryFinanceSnapshotEntry {
  id: string;
  version: string;
  kind: DiaryFinanceKind;
  amountCents: number;
  currency: string;
  date: string;
  merchant: string;
  description?: string;
  status: string;
  source?: string;
}
export interface DiaryFinanceSnapshot {
  entries: DiaryFinanceSnapshotEntry[];
  /** Enabled existing categories only. Omit kind for a category valid for all kinds. */
  categories: Array<{ name: string; kind?: DiaryFinanceKind }>;
}
export interface DiaryTodoSnapshotEntry {
  id: string;
  text: string;
  completed: boolean;
  completedAt?: string | null;
}
export interface DiaryWriteInput<T extends DiaryCandidate> {
  extractionId: string;
  diaryPath: string;
  diaryDate: string;
  /** Host rechecks this just before the store mutation, alongside its modify generation. */
  sourceFingerprint: string;
  candidate: T;
  /** Model/user explicitly judged these version-bound same-amount records distinct. */
  reviewedDistinct?: Array<{ id: string; version: string }>;
}
export interface DiaryUndoResult {
  deleted: boolean;
  /** Present if the optimistic revision check failed. */
  current?: DiaryWrittenRecord;
}
export interface DiaryOrganizerPorts {
  loadState(): Promise<unknown>;
  /** Must durably save before resolving. Receives a detached JSON object. */
  saveState(state: DiaryOrganizerState): Promise<void>;
  listDiaries(): Promise<DiarySource[]>;
  readDiary(path: string): Promise<string | null>;
  isEnabled(): boolean;
  hasFinanceAccess(): boolean;
  /** Foreground inference or Dream running. The host must also check engine.running. */
  isBusy(): boolean;
  /** Host must pass signal to the provider so a timed-out call actually aborts. */
  generateText(request: { purpose: "extract" | "dedupe"; system: string; prompt: string; signal: AbortSignal }): Promise<string>;
  readFinanceSnapshot(): Promise<DiaryFinanceSnapshot>;
  /** Full snapshot, filtered to unfinished, unknown completion date, or last seven days. */
  readTodoSnapshot(): Promise<DiaryTodoSnapshotEntry[]>;
  writeFinance(input: DiaryWriteInput<DiaryFinanceCandidate>): Promise<DiaryWrittenRecord>;
  writeTodo(input: DiaryWriteInput<DiaryTodoCandidate>): Promise<DiaryWrittenRecord>;
  /** Used only after explicit confirmation of a changed, previously written item. */
  updateFinance?(recordId: string, expectedVersion: string, input: DiaryWriteInput<DiaryFinanceCandidate>): Promise<DiaryWrittenRecord>;
  updateTodo?(recordId: string, expectedVersion: string, input: DiaryWriteInput<DiaryTodoCandidate>): Promise<DiaryWrittenRecord>;
  /** Find by extraction marker, including after an uncertain/crashed write. */
  findFinance(extractionId: string, recordId?: string): Promise<DiaryWrittenRecord | null>;
  findTodo(extractionId: string, recordId?: string): Promise<DiaryWrittenRecord | null>;
  /** Delete only if current version equals expectedVersion; verify deletion before true. */
  undoFinance(recordId: string, expectedVersion: string): Promise<DiaryUndoResult>;
  undoTodo(recordId: string, expectedVersion: string): Promise<DiaryUndoResult>;
  now?(): number;
  createId?(): string;
  onChange?(): void;
  log?(message: string, error?: unknown): void;
}

export interface DiaryItem {
  id: string;
  documentId: string;
  candidate: DiaryCandidate;
  status: DiaryItemStatus;
  reasons: string[];
  revision: number;
  createdAt: number;
  updatedAt: number;
  sourceFingerprint: string;
  /** Preserved AI receipt; do not replace it when a user changes the target. */
  written?: DiaryWrittenRecord;
  /** Persisted before external mutation; restart checks the extraction marker first. */
  writeIntent?: boolean;
  undoIntent?: boolean;
  previousCandidate?: DiaryCandidate;
  duplicateRecordIds?: string[];
  reviewedDistinct?: Array<{ id: string; version: string }>;
  confirmation?: {
    action: "confirm" | "undo";
    revision: number;
    recordVersion?: string;
    financeVersions?: Array<{ id: string; version: string }>;
  };
}
export interface DiaryDocumentState {
  id: string;
  path: string;
  identity?: string;
  date: string;
  fingerprint: string;
  stableSince: number;
  firstSeenAt: number;
  observations: number;
  processedFingerprint?: string;
  /** Free users retain this flag even when the diary did not change. */
  financePending: boolean;
  lastAttemptAt?: number;
  lastFailureAt?: number;
  truncated?: boolean;
}
export interface DiaryOrganizerState {
  version: 1;
  enabledAt: number | null;
  startDate: string | null;
  documents: DiaryDocumentState[];
  items: DiaryItem[];
}
export interface DiaryOrganizerOptions {
  stableMs?: number;
  retryMs?: number;
  timeoutMs?: number;
  maxPerRun?: number;
  maxDiaryChars?: number;
}
export interface DiaryActionOptions {
  expectedRevision?: number;
  /** Use the revision returned with needs_confirmation to acknowledge new information. */
  acknowledgedRevision?: number;
  candidate?: DiaryCandidate;
}
export type DiaryActionResult =
  | { status: "done"; item: DiaryItem }
  | { status: "needs_confirmation"; item: DiaryItem; changes: string[]; current?: DiaryWrittenRecord }
  | { status: "blocked"; reason: string; item?: DiaryItem };

export interface DiaryOrganizerSummary {
  writtenTodos: number;
  writtenFinance: number;
  review: number;
  pendingFinance: number;
  items: DiaryItem[];
}
