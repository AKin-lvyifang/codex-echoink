import type { KnowledgeBaseRawDigestState } from "./types";
import type { MaintenanceKnowledgeType } from "./maintenance-p2-contract";

export type MaintenanceCanonicalSourceStatus = "已提炼" | "未提炼" | "待重新提炼" | "提炼失败" | "待校准";
export type MaintenanceUpgradeRole = "raw" | "inbox" | "wiki";
export interface MaintenanceUpgradeFile {
  path: string;
  role: MaintenanceUpgradeRole;
  content: string;
  /** Full original file version, including the exact frontmatter. */
  revision: string;
  /** Historical body-only digest; never used to decide that a completed source is unread. */
  fingerprint?: string;
}
export interface MaintenanceUpgradeRootAddition {
  role: "raw" | "inbox" | "wiki" | "outputs";
  path: string;
}
export interface MaintenanceUpgradeIssue {
  path?: string;
  title?: string;
  message: string;
  kind: "review" | "optional-reingest" | "unavailable";
  /** Execution failures stay distinct from issues already present in the preview. */
  executionFailure?: true;
}
export interface MaintenanceUpgradeSourceItem {
  path: string;
  title: string;
  revision: string;
  content: string;
  state: KnowledgeBaseRawDigestState;
  /** Only absent properties are proposed; existing values are never replaced. */
  addStatus?: MaintenanceCanonicalSourceStatus;
  addTargetPaths?: string[];
}
export interface MaintenanceUpgradeWikiItem {
  path: string;
  title: string;
  revision: string;
  content: string;
}
export interface MaintenanceUpgradeCounts {
  sourceCount: number;
  sourceStatusCount: number;
  sourceLinkCount: number;
  backlinkCount: number;
  wikiCount: number;
}
export interface MaintenanceUpgradePlan {
  version: 1;
  id: string;
  createdAt: number;
  bindingRevision: number;
  sourceItems: MaintenanceUpgradeSourceItem[];
  wikiItems: MaintenanceUpgradeWikiItem[];
  rootAdditions: MaintenanceUpgradeRootAddition[];
  issues: MaintenanceUpgradeIssue[];
  counts: MaintenanceUpgradeCounts;
}
export interface MaintenanceUpgradePlanInput {
  files: readonly MaintenanceUpgradeFile[];
  evidence?: Readonly<Record<string, import("./maintenance-source-state").MaintenanceSourceLegacyEvidence>>;
  rootAdditions?: readonly MaintenanceUpgradeRootAddition[];
  bindingRevision: number;
  now?: number;
  id?: string;
}
export interface MaintenanceUpgradeClassification {
  type: MaintenanceKnowledgeType;
  uncertain: boolean;
  reason?: string;
}
export interface MaintenanceUpgradeWrite {
  operationId: string;
  /** Persisted before a deliberate retry; successful attempts keep their identity. */
  attempt?: number;
  path: string;
  role: "source" | "wiki";
  expectedVersion: string;
  content: string;
  done?: boolean;
  readbackRevision?: string;
}
/** Stored only within the existing KnowledgeMaintenanceRecord. */
export interface MaintenanceUpgradeState {
  version: 1;
  plan: MaintenanceUpgradePlan;
  phase: "classify" | "write" | "completed";
  classifications: Record<string, MaintenanceUpgradeClassification>;
  /** Private, bounded diagnostics; never store Provider output or credentials. */
  classificationFailures?: Record<string, { reason: string; stopReason?: string }>;
  writes: Record<string, MaintenanceUpgradeWrite>;
  skipped: Record<string, string>;
  /** Existing/new user properties already satisfy the confirmed action without a write. */
  preserved?: string[];
  rootsRegistered: boolean;
  confirmedBindingRevision?: number;
}
export interface MaintenanceUpgradePreviewRow {
  path?: string;
  title: string;
  properties: string[];
  description?: string;
}
export interface MaintenanceUpgradePreview {
  id: string;
  createdAt: number;
  automatic: MaintenanceUpgradePreviewRow[];
  issues: MaintenanceUpgradeIssue[];
  counts: MaintenanceUpgradeCounts;
  rootAdditions: MaintenanceUpgradeRootAddition[];
}
export interface MaintenanceUpgradeSnapshot {
  status: "scanning" | "ready" | "running" | "interrupted" | "completed" | "failed";
  counts: MaintenanceUpgradeCounts;
  preview?: MaintenanceUpgradePreview;
  recordId?: string;
  taskId?: string;
  message?: string;
  completed?: { sources: number; links: number; wiki: number };
}
/** UI calls these actions; no caller can submit model-authored write contents. */
export interface MaintenanceUpgradeSurface {
  getUpgradeSnapshot(): Promise<MaintenanceUpgradeSnapshot>;
  previewUpgrade(): Promise<MaintenanceUpgradePreview>;
  confirmUpgrade(previewId: string): Promise<MaintenanceUpgradeSnapshot>;
  stopUpgrade(): Promise<void>;
  resumeUpgrade(): Promise<MaintenanceUpgradeSnapshot>;
}
export interface MaintenanceUpgradeActivityCounts {
  sourceTotal: number;
  sourceCompleted: number;
  linkTotal: number;
  linksCompleted: number;
  wikiTotal: number;
  wikiCompleted: number;
}
