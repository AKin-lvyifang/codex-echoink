/** Shared, Node-free contracts for desktop and mobile body retrieval. */
export const KNOWLEDGE_SEARCH_KINDS = ["wiki", "projects", "raw", "journal", "work", "inbox", "outputs", "archive", "notes"] as const;
export type KnowledgeSearchKind = typeof KNOWLEDGE_SEARCH_KINDS[number];
export type BodySearchMatchSource = "title" | "alias" | "tag" | "body";
export type BodySearchInclusionReason = "按指代带入";

/** Shared links are unread navigation, never agreement or another body hit. */
export interface KnowledgeLinkCue {
  readonly schemaVersion: 1;
  readonly readStatus: "unread";
  readonly label: "可能相关";
  readonly vaultRelativePath: string;
  readonly title: string;
  readonly via: readonly Readonly<{ vaultRelativePath: string; contentRevision: string }>[];
}

/** Navigation over the current source revision; these ranges are not read evidence. */
export interface KnowledgeOutlineEntry {
  readonly heading: string;
  readonly level: number;
  readonly lineStart: number;
  readonly lineEnd: number;
}

export interface KnowledgeDocumentOutline {
  readonly schemaVersion: 1;
  readonly readStatus: "unread";
  readonly contentRevision: string;
  readonly entries: readonly Readonly<KnowledgeOutlineEntry>[];
  readonly totalHeadings: number;
  readonly truncated: boolean;
}

/** Program-resolved navigation over one target revision; it adds no read evidence. */
export type KnowledgeAnchorLocation = Readonly<{
  schemaVersion: 1;
  readStatus: "unread";
  vaultRelativePath: string;
  anchor: string;
  kind: "heading" | "block";
} & (
  | { status: "located"; contentRevision: string; lineStart: number; lineEnd: number }
  | { status: "not_located"; contentRevision?: string; reason: "missing" | "ambiguous" | "unavailable" | "invalid" }
)>;

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
  readonly linkCues?: readonly KnowledgeLinkCue[];
  readonly related?: import("../knowledge-relations").KnowledgeRelationPage;
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
  /** Fields that matched the selected query; the excerpt may instead be the first body paragraph. */
  readonly matchSources?: readonly BodySearchMatchSource[];
  readonly inclusionReason?: BodySearchInclusionReason;
  readonly outline?: Readonly<KnowledgeDocumentOutline>;
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
