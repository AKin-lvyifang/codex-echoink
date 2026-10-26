import type { SelectionAnnotation } from "../types/selection-annotations";
export type InlineRequestStatus = "preparing" | "thinking" | "clarifying" | "queued" | "pending" | "conflict" | "interrupted" | "missing" | "failed" | "saving" | "save_failed" | "confirmed" | "revoked" | "withdrawn" | "modified";
export interface TextSpan { from: number; to: number }
export interface SourceAnchor extends TextSpan { text: string; before: string; after: string }
export interface InlineTarget extends SourceAnchor { kind: "replace" | "insert" }
export interface InstructionAnchor extends SourceAnchor { trigger: string; marker: string }
export interface ContextSegment { cleanFrom: number; cleanTo: number; sourceFrom: number; sourceTo: number }
export interface InlineContext { text: string; segments: ContextSegment[] }
export interface InlineVersion {
  id: string;
  number: number;
  text: string;
  requirement: string;
  sourceDocument: string;
  context: InlineContext;
  target: InlineTarget;
  createdAt: number;
  model?: InlineModelSelection;
}
export interface InlineModelSelection { providerSettingsId: string; runtimeProviderId: string; modelId: string; reasoning: import("../types/app-server").ReasoningEffort; memoryMode: "normal" | "no_memory" }
export interface InlineThreadMessage { id: string; role: "user" | "assistant"; text: string; at: number; selectionAnnotations?: SelectionAnnotation[]; versionId?: string; question?: { question: string; options: { id: string; label: string }[] } }
export interface InlineTiming { submittedAt: number; contextReadyAt?: number; modelStartedAt?: number; firstOutputAt?: number; proposalReadyAt?: number; userWaitMs?: number; questionAt?: number; toolCalls?: number; memoryRecall?: unknown; productRunId?: string }
export interface InlineChange extends TextSpan { insert: string }
export interface InlinePreparedProposal {
  text: string;
  original: string;
  requirement: string;
  section: string;
  sourceDocument: string;
  sourceTarget: InlineTarget;
  context: InlineContext;
  createdAt: number;
  timing: Partial<InlineTiming>;
  versionId?: string;
}
export interface InlineQueue { blockedBy: string[]; reason: "unresolved" | "overlap"; regenerate: boolean }
export interface InlineCommit {
  action: "confirm" | "revoke";
  versionId: string;
  beforeDocument: string;
  afterDocument: string;
  changes: InlineChange[];
  originalTarget: SourceAnchor;
  originalResult: SourceAnchor;
  result: SourceAnchor;
  preparedAt: number;
  savedAt?: number;
}
/** Task identity belongs to the existing Conversation catalog. These are request facts only. */
export interface InlineRequest {
  id: string;
  order?: number;
  vaultId: string;
  path: string;
  taskId: string;
  agentId: string;
  agentName: string;
  status: InlineRequestStatus;
  instruction: InstructionAnchor;
  target: InlineTarget;
  observedDocument: string;
  versions: InlineVersion[];
  currentVersionId: string;
  followups: string[];
  selectionAnnotations?: SelectionAnnotation[];
  commit?: InlineCommit;
  error?: string;
  createdAt: number;
  updatedAt: number;
  targetResolved?: boolean;
  section?: string;
  thread?: InlineThreadMessage[];
  question?: { question: string; options: { id: string; label: string }[] };
  model?: InlineModelSelection;
  runToken?: string;
  timing?: InlineTiming;
  readContext?: InlineContext;
  preparedProposal?: InlinePreparedProposal;
  queue?: InlineQueue;
}
export interface InlineProposalInput {
  selectionAnnotations?: SelectionAnnotation[];
  path: string;
  taskId: string;
  agentId: string;
  agentName: string;
  instruction: TextSpan;
  trigger: string;
  target: TextSpan & { kind: "replace" | "insert" };
  text: string;
}
export const INLINE_STATUSES: readonly InlineRequestStatus[] = ["preparing", "thinking", "clarifying", "queued", "pending", "conflict", "interrupted", "missing", "failed", "saving", "save_failed", "confirmed", "revoked", "withdrawn", "modified"];
