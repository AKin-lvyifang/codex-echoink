import type { AgentModuleId } from "../agents/types";
import type { ParsedTodoRecord } from "./todo-markdown";

export type WorkbenchSignalId = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 13 | 14;

/** Local intent carried with an unsent draft; never a task or model-generated guess. */
export interface WorkbenchTaskSource {
  version: 1;
  signalId: WorkbenchSignalId;
  businessKey: string;
  moduleId: AgentModuleId;
  objects: string[];
  versions?: Record<string, string>;
  prompt: string;
  capturedAt: number;
}

export interface WorkbenchSignal {
  id: WorkbenchSignalId;
  key: string;
  moduleId: AgentModuleId;
  icon: string;
  description: string;
  prompt: string;
  source: WorkbenchTaskSource;
}

export interface WorkbenchSnapshot {
  generatedAt: number;
  signals: WorkbenchSignal[];
  todayTodos: readonly ParsedTodoRecord[];
  modules: AgentModuleId[];
  issues: string[];
  nextRefreshAt?: number;
}

export interface WorkbenchDataPort {
  load(now?: number): Promise<WorkbenchSnapshot>;
  subscribe(listener: () => void): () => void;
  recordTaskAccepted(taskId: string, source: WorkbenchTaskSource): Promise<void>;
  recordTaskCompleted(taskId: string): Promise<void>;
  dispose(): void;
}
