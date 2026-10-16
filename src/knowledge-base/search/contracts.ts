/** Shared, Node-free contracts for desktop and mobile body retrieval. */
export const KNOWLEDGE_SEARCH_KINDS = ["wiki", "projects", "raw", "journal", "work", "inbox", "outputs", "archive", "notes"] as const;
export type KnowledgeSearchKind = typeof KNOWLEDGE_SEARCH_KINDS[number];

export interface BodySearchDocument {
  /** Host-observed body/metadata/event version; omitted documents are never reused. */
  readonly revisionKey?: string;
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
  readonly coverage: Readonly<BodySearchCoverage>;
}

/** Counts describe search preparation, excluding later source reads/verification.
 * Recent browsing counts its successful page reads as indexedFiles, with no reuse.
 */
export interface BodySearchCoverage {
  /** Unique eligible files after scope/kind/date filters. */
  readonly totalFiles: number;
  /** Successful body reads used to prepare statistics in this search (legacy field). */
  readonly scannedFiles: number;
  /** Attempted document.read calls in this search, including failures. */
  readonly readFiles: number;
  /** Eligible complete file-statistic records reused without reading/tokenizing. */
  readonly cachedFiles: number;
  /** Files whose complete statistics participated, fresh plus cached. */
  readonly indexedFiles: number;
  readonly failedFiles: number;
  readonly complete: boolean;
  readonly unknownJournalDates: number;
}

export interface BodySearchOptions {
  readonly documents: readonly BodySearchDocument[];
  readonly request: BodySearchRequest;
  readonly activePath?: string;
  readonly recentPaths?: readonly string[];
}

export interface BodySearchMemoryOptions {
  /** Retained source characters and token-map entries have independent hard limits. */
  readonly maxCachedCharacters?: number;
  readonly maxCachedTokenEntries?: number;
  readonly maxCachedDocuments?: number;
}

/** Implemented by BodySearchMemoryIndex; all data is ephemeral and Vault-local. */
export interface BodySearchMemoryPort {
  search(options: BodySearchOptions): Promise<BodySearchResult>;
  invalidate(path?: string): void;
  clear(): void;
  dispose(): void;
}
