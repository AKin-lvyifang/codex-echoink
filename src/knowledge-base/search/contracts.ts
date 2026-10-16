/** Shared, Node-free contracts for desktop and mobile body retrieval. */
export const KNOWLEDGE_SEARCH_KINDS = ["wiki", "projects", "raw", "journal", "work", "inbox", "outputs", "archive", "notes"] as const;
export type KnowledgeSearchKind = typeof KNOWLEDGE_SEARCH_KINDS[number];

export interface BodySearchDocument {
  readonly vaultRelativePath: string;
  readonly title: string;
  readonly kind: KnowledgeSearchKind;
  readonly recordedAt: number;
  readonly aliases?: readonly string[];
  readonly tags?: readonly string[];
  /** One-based heading lines from the host cache, checked against the body. */
  readonly headings?: readonly { heading: string; line: number; level: number }[];
  readonly read: () => Promise<{ content: string; contentRevision: string }>;
}

export interface BodySearchRequest {
  readonly query?: string;
  readonly queries?: readonly string[];
  readonly kinds?: readonly KnowledgeSearchKind[];
  /** Inclusive ISO calendar dates, applied to journal filenames only. */
  readonly dateFrom?: string;
  readonly dateTo?: string;
  readonly excludePaths?: readonly string[];
  readonly limit?: number;
  readonly offset?: number;
  readonly signal?: AbortSignal;
}

export interface BodySearchHit {
  readonly vaultRelativePath: string;
  readonly title: string;
  readonly kind: KnowledgeSearchKind;
  readonly recordedAt: number;
  readonly contentRevision: string;
  readonly sectionTitle: string;
  readonly lineStart: number;
  readonly lineEnd: number;
  /** Zero-based UTF-16 columns: start inclusive on lineStart, end exclusive on lineEnd. */
  readonly columnStart?: number;
  readonly columnEnd?: number;
  readonly totalLines: number;
  readonly excerpt: string;
  readonly score: number;
  readonly journalDate?: string;
}

export interface BodySearchResult {
  readonly hits: readonly BodySearchHit[];
  readonly total: number;
  readonly coverage: Readonly<{ totalFiles: number; scannedFiles: number; failedFiles: number; complete: boolean; unknownJournalDates: number }>;
}
