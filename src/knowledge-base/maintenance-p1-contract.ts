import type { MaintenanceKnowledgeUnit, MaintenanceP2PageFields, MaintenanceP2State } from "./maintenance-p2-contract";
/** Durable P1 contracts remain readable; new decompositions use P2 structured units. */
export type MaintenanceRefinementStatus = "未提炼" | "已提炼";
export interface MaintenanceSourceFields {
  status: MaintenanceRefinementStatus;
  summary: string;
  targetPaths: readonly string[];
}
export interface MaintenanceMigrationEvidence {
  /** Current property wins even when legacy evidence disagrees. */
  status?: unknown;
  legacyProcessed?: unknown;
  legacyDigest?: unknown;
  privateProcessed?: boolean;
  registryProcessed?: boolean;
  targetPaths?: readonly string[];
  reverseSourceTargets?: readonly string[];
}
export interface MaintenanceSourceMigrationPlan {
  status: import("./maintenance-upgrade-contract").MaintenanceCanonicalSourceStatus;
  targetPaths: readonly string[];
  needsReview: boolean;
  shouldWrite: boolean;
}
export interface MaintenanceSectionRegion {
  id: string;
  title: string;
  kind: "introduction" | "section" | "sources" | "related" | "new-section";
  /** UTF-16 offsets into the original snapshot; boundary includes section heading. */
  start: number;
  end: number;
  /** First content byte after heading; heading is preserved by patches. */
  contentStart: number;
}
export interface MaintenanceSectionSnapshot {
  revision: string;
  /** Declared in the durable writing plan; IDs are bound to this exact revision. */
  newSections?: readonly string[];
  regions: readonly MaintenanceSectionRegion[];
}
export interface MaintenanceSectionPatch {
  regionId: string;
  operation: "append" | "replace";
  content: string;
}
export interface MaintenanceDecomposition {
  sourcePath: string;
  summary: string;
  /** Strings are retained only for already persisted P1 records. */
  units: readonly (string | MaintenanceKnowledgeUnit)[];
}
export interface MaintenanceWritingItem {
  id: string;
  targetPath: string;
  sourcePaths: readonly string[];
  expectedTarget: { kind: "missing" } | { kind: "file"; contentRevision: string };
  knowledge?: MaintenanceP2PageFields;
  /** Missing semantic H2s only; existing corresponding sections use their real IDs. */
  newSections?: readonly string[];
}
export interface MaintenanceP1Action {
  stage: "decompose" | "plan" | "write" | "resume" | "sections" | "inspect";
  decompositions?: readonly MaintenanceDecomposition[];
  writingPlan?: readonly MaintenanceWritingItem[];
  pageId?: string;
  content?: string;
  sectionPatches?: readonly MaintenanceSectionPatch[];
  targetPath?: string;
  view?: import("./maintenance-p2-receipt").MaintenanceInspectionView;
  offset?: number;
}
export interface MaintenanceP1State {
  version: 1;
  p2?: MaintenanceP2State;
  phase: "decompose" | "plan" | "write" | "finalize" | "completed";
  sourceFingerprints: Record<string, string>;
  decompositions: readonly MaintenanceDecomposition[];
  writingPlan: readonly MaintenanceWritingItem[];
  /** Version-bound regions. A changed, re-read uncommitted page may acquire a fresh snapshot. */
  sectionSnapshots?: Record<string, MaintenanceSectionSnapshot>;
  /** Host-owned generation increases only when fresh sections discard a stale uncommitted draft. */
  draftGenerations?: Record<string, number>;
  folderBindingsRevision?: number;
  drafts: Record<string, { content: string; toolCallId: string }>;
  committedPages: Record<string, { path: string; contentRevision: string }>;
  finalizedSources: string[];
}
