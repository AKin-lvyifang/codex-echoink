import type { WorkbenchSnapshot, WorkbenchSignal } from "../home/workbench-types";

/** Device-neutral facts and prefill; no page renderer or runtime admission. */
export interface MobileWorkbenchPort {
  load(now?: number): Promise<WorkbenchSnapshot>;
  subscribe(listener: () => void): () => void;
  refreshTasks?(): void;
  handoff(signal: WorkbenchSignal, replaceDraft?: boolean): Promise<{ agentId: string; conflict: boolean }>;
  dispose(): void;
}
