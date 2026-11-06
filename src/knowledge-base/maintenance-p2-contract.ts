/** Shared P2 contracts. Pure planners never read or write a Vault themselves. */
export type MaintenanceKnowledgeType = "概念" | "方法 / 流程" | "观点 / 论断" | "工具 / 产品" | "案例 / 事件" | "人物 / 组织" | "趋势 / 主题";
export interface MaintenanceKnowledgeEvidence {
  sourcePath: string;
  /** Exact full-file sha256 returned by the real note_read at decomposition time. */
  sourceRevision: string;
  quote: string;
  /** Program-derived full-file offsets; never trusted from model arguments. */
  quoteLocation?: {
    start: number;
    end: number;
    unit: "utf16";
    match: "literal" | "whitespace" | "typography";
    submittedQuote: string;
  };
}
export interface MaintenanceKnowledgeUnit {
  id: string;
  type: MaintenanceKnowledgeType;
  typePendingConfirmation?: boolean;
  domain: string;
  title: string;
  aliases: readonly string[];
  points: readonly string[];
  evidence: readonly MaintenanceKnowledgeEvidence[];
}
export interface MaintenanceKnowledgeSource {
  path: string;
  content: string;
  contentRevision: string;
}
export interface MaintenanceWikiDocument {
  path: string;
  title: string;
  aliases: readonly string[];
  contentRevision: string;
  content: string;
}
export interface MaintenanceDedupCandidate {
  path: string;
  title: string;
  aliases: readonly string[];
  contentRevision: string;
  matches: readonly ("title" | "alias" | "body")[];
}
export interface MaintenanceUnitCandidates {
  unitId: string;
  candidates: readonly MaintenanceDedupCandidate[];
  /** Exact title/alias overlaps inside this batch; semantic identity still needs model judgment. */
  batchUnitIds: readonly string[];
}
export interface MaintenanceDedupPort {
  /** Metadata/title pass is evaluated before point-based body search. */
  listWiki(): Promise<readonly MaintenanceWikiDocument[]>;
  searchWiki(query: string): Promise<readonly MaintenanceWikiDocument[]>;
}
export type MaintenanceRelationType = "上位" | "下位" | "原因" | "结果" | "对比" | "应用" | "方法";
export interface MaintenanceRelatedEntry { type?: MaintenanceRelationType; targetPath: string; reason: string; reverseReason?: string }
export interface MaintenanceSemanticDecision {
  kind: "new" | "same_point" | "uncertain";
  reason: string;
  candidatePath?: string;
}
export interface MaintenanceP2PageFields {
  unitIds: readonly string[];
  decision: MaintenanceSemanticDecision;
  related?: readonly MaintenanceRelatedEntry[];
  /** Final page classification resolves differing provisional source decompositions. */
  type?: MaintenanceKnowledgeType;
  domain?: string;
}
export interface MaintenanceDomainMapEntry {
  path: string;
  title: string;
  domain: string;
  type: MaintenanceKnowledgeType;
}
export interface MaintenanceMapBlockPatch { domain: string; before: string | null; after: string }
export interface MaintenanceTreePlacement {
  path: string;
  branch: string;
  parentPath?: string;
  suggestedBranch?: string;
  reason: string;
}
export interface MaintenanceTreePlan {
  placements: MaintenanceTreePlacement[];
  gaps: { title: string; reason: string; evidencePaths: string[] }[];
  resolvedGaps?: { title: string; reason: string; evidencePaths: string[] }[];
}
export interface MaintenanceTreeJob {
  targetPath: string; domain: string; block: string; entries: MaintenanceDomainMapEntry[]; sourcePaths: string[];
  declined?: string[];
  plan?: MaintenanceTreePlan;
  coverage?: { path: string; revision: string; characters: number }[];
}
export interface MaintenanceDomainMapDraft {
  targetPath: string;
  content: string;
  expectedTarget: { kind: "missing" } | { kind: "file"; contentRevision: string };
  domain: string;
  domains?: readonly string[];
  treeDomains?: readonly string[];
  domainCounts?: Readonly<Record<string, number>>;
  blockPatches?: readonly MaintenanceMapBlockPatch[];
}
export interface MaintenanceDomainMapInput {
  wikiRoot: string;
  entries: readonly MaintenanceDomainMapEntry[];
  existing: readonly MaintenanceWikiDocument[];
}
export interface MaintenanceP2State {
  version: 2;
  /** Absent only on plans frozen before the short-name policy; never rename history. */
  titlePolicy?: import("./maintenance-title").MaintenanceTitlePolicy;
  candidates: readonly MaintenanceUnitCandidates[];
  /** Program-generated maps use the same per-page WAL/CAS/readback and durable parent record. */
  finalization: readonly MaintenanceP2Finalization[];
  committedFinalization: Record<string, { path: string; contentRevision: string }>;
  templateNotice?: string;
  treeJobs?: MaintenanceTreeJob[];
}
export interface MaintenanceP2Finalization extends Omit<MaintenanceDomainMapDraft, "domain"> {
  id: string;
  kind: "map" | "relationship";
  sourcePaths: readonly string[];
  propertyExpected?: Record<string, { present: boolean; value?: unknown; error?: string }>;
  propertyUpdates?: Readonly<Record<string, import("./maintenance-source-frontmatter").KnowledgePropertyValue>>;
  reminders?: import("./knowledge-system-reminders").KnowledgeSystemReminder[];
}
