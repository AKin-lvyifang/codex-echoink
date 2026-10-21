import type { KnowledgePageSnapshot } from "../home/knowledge-page-data";
import type { KnowledgeMaintenanceRecord } from "../knowledge-base/maintenance-record";

export interface MobileKnowledgePagePort {
  read(signal?: AbortSignal): Promise<KnowledgePageSnapshot>;
  readFolder(path: string, signal?: AbortSignal): Promise<{ path: string; files: { path: string; title: string; mtime: number }[] }>;
  readRecord(recordId: string): Promise<KnowledgeMaintenanceRecord>;
  openGraph(): Promise<void>;
  subscribe(listener: () => void): () => void;
}
