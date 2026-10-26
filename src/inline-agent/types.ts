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
}
export interface InlineChange extends TextSpan { insert: string }
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
  commit?: InlineCommit;
  error?: string;
  createdAt: number;
  updatedAt: number;
}
export interface InlineProposalInput {
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
