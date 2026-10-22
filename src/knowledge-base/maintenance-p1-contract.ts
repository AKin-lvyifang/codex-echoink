/** P1 contracts shared by pure source/section helpers and the existing maintain port. */
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
  status: MaintenanceRefinementStatus;
  targetPaths: readonly string[];
  needsReview: boolean;
  shouldWrite: boolean;
}
export interface MaintenanceSectionRegion {
  id: string;
  title: string;
  kind: "introduction" | "section" | "sources" | "related";
  /** UTF-16 offsets into the original snapshot; boundary includes section heading. */
  start: number;
  end: number;
  /** First content byte after heading; heading is preserved by patches. */
  contentStart: number;
}
export interface MaintenanceSectionSnapshot {
  revision: string;
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
  /** P1 only needs simple source-grounded units, not the P2 seven templates. */
  units: readonly string[];
}
export interface MaintenanceWritingItem {
  id: string;
  targetPath: string;
  sourcePaths: readonly string[];
  expectedTarget: { kind: "missing" } | { kind: "file"; contentRevision: string };
}
export interface MaintenanceP1Action {
  stage: "decompose" | "plan" | "write" | "resume" | "sections";
  decompositions?: readonly MaintenanceDecomposition[];
  writingPlan?: readonly MaintenanceWritingItem[];
  pageId?: string;
  content?: string;
  sectionPatches?: readonly MaintenanceSectionPatch[];
  targetPath?: string;
}
export interface MaintenanceP1State {
  version: 1;
  phase: "decompose" | "plan" | "write" | "finalize" | "completed";
  sourceFingerprints: Record<string, string>;
  decompositions: readonly MaintenanceDecomposition[];
  writingPlan: readonly MaintenanceWritingItem[];
  /** Exact final bytes locked before WAL submission; recover never asks the model to redraft. */
  sectionSnapshots?: Record<string, MaintenanceSectionSnapshot>;
  folderBindingsRevision?: number;
  drafts: Record<string, { content: string; toolCallId: string }>;
  committedPages: Record<string, { path: string; contentRevision: string }>;
  finalizedSources: string[];
}
