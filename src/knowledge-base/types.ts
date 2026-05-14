import type { AgentInputModality } from "../agent/types";

export type KnowledgeBaseRunMode = "maintain" | "lint" | "reingest" | "outputs" | "inbox";

export interface KnowledgeBaseSource {
  relativePath: string;
  absolutePath: string;
  size: number;
  mtime: number;
  mime: string;
  modality: AgentInputModality;
  changed: boolean;
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
