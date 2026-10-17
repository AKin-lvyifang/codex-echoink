/** Source-free linking contracts. Offsets use JavaScript UTF-16 indices into the exact original. */
export interface KnowledgeLinkingDocument {
  path: string;
  content: string;
  version: string;
  title: string;
  aliases: string[];
}

export interface KnowledgeLinkingTarget {
  path: string;
  title: string;
  aliases: string[];
}

export interface KnowledgeLinkingMention {
  start: number;
  end: number;
  text: string;
  targetPath: string;
}

export interface KnowledgeLinkingProposal {
  path: string;
  version: string;
  mentions: KnowledgeLinkingMention[];
  /** Manual tasks only. Existing aliases are always retained. */
  aliases?: string[];
}

export interface KnowledgeLinkingPatch {
  path: string;
  before: string;
  after: string;
  mentions: KnowledgeLinkingMention[];
  addedAliases: string[];
}

export interface KnowledgeLinkingRejection {
  path: string;
  reason: string;
  mention?: KnowledgeLinkingMention;
}

export interface KnowledgeLinkingPatchResult {
  patch: KnowledgeLinkingPatch | null;
  rejected: KnowledgeLinkingRejection[];
}

export type KnowledgeLinkingPhase = "queued" | "scanning" | "judging" | "awaiting-confirmation" | "writing" | "completed" | "partial" | "failed" | "interrupted" | "cancelled";
export interface KnowledgeLinkingFileResult {
  path: string;
  status: "written" | "skipped" | "failed";
  links: number;
  aliases: number;
  message?: string;
}
/** A Catalog reference survives handoff; mutable Agent identity is never copied here. */
export interface KnowledgeLinkingOrigin {
  originConversationId?: string;
  authorizationSource?: "conversation" | "manual-user" | "unknown";
}

export interface KnowledgeLinkingTask extends KnowledgeLinkingOrigin {
  schemaVersion: 1;
  id: string;
  mode: "manual" | "automatic";
  phase: KnowledgeLinkingPhase;
  bindingSignature: string;
  createdAt: number;
  updatedAt: number;
  judgment?: "aliases" | "mentions";
  processed: number;
  total: number | null;
  proposals: KnowledgeLinkingProposal[];
  patches: KnowledgeLinkingPatch[];
  results: KnowledgeLinkingFileResult[];
  /** Other notes can only link back to these newly committed pages/aliases. */
  targetPaths?: string[];
  /** Committed drafts may link out to every valid knowledge target. */
  sourcePaths?: string[];
  queuedAutomatic?: Array<KnowledgeLinkingOrigin & { id: string; paths: string[]; sourcePaths?: string[]; at: number; pausedForHandoff?: boolean }>;
  pausedForHandoff?: boolean;
  targetVersions?: Record<string, string>;
  dismissed?: boolean;
  writeConfirmed?: boolean;
  error?: string;
}
