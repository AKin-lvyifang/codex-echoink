import type { AgentInputModality } from "../agent/types";

export type KnowledgeBaseRunMode = "maintain" | "lint" | "reingest" | "outputs" | "inbox";
export type KnowledgeBaseCitationBucket = "wiki" | "journal" | "outputs";
export type KnowledgeBaseEvidenceStatus = "strong" | "weak" | "none";

export interface KnowledgeBaseSource {
  relativePath: string;
  absolutePath: string;
  size: number;
  mtime: number;
  mime: string;
  modality: AgentInputModality;
  changed: boolean;
}

export interface KnowledgeBaseCitation {
  bucket: KnowledgeBaseCitationBucket;
  title: string;
  path: string;
  excerptLines: string[];
  relevance: Exclude<KnowledgeBaseEvidenceStatus, "none">;
  reason: string;
  score: number;
}

export interface KnowledgeBaseCitationSummary {
  status: KnowledgeBaseEvidenceStatus;
  counts: Record<KnowledgeBaseCitationBucket, number>;
  citations: KnowledgeBaseCitation[];
}

export interface KnowledgeBaseDiscovery {
  vaultPath: string;
  sources: KnowledgeBaseSource[];
  changedSources: KnowledgeBaseSource[];
  reportPath: string;
  trackerPath: string;
}

export interface KnowledgeBaseRunResult {
  status: "success" | "failed" | "canceled";
  reportPath: string;
  summary: string;
  processedSources: KnowledgeBaseSource[];
  error?: string;
}
