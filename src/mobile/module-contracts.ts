import type { AgentDefinition } from "../agents/types";
import type { HomeVaultFileRecord, ImportedJournalTemplate } from "../home/home-workbench-model";
import type { HomeCustomTemplateSummary, HomeJournalTemplateChoice, HomeTemplateSaveResult } from "../home/home-workbench-data";
import type { JournalStats } from "../home/journal-stats";
import type { readNativeJournalSettings } from "../home/native-journal";
import type { TodoInput, TodoReadSnapshot, EchoInkTodoStore } from "../home/todo-store";
import type { ParsedTodoRecord } from "../home/todo-markdown";
import type { TodoProject } from "../home/todo-projects";
import type { CodexForObsidianSettings } from "../settings/settings";
import type { LifestyleFinanceService } from "../lifestyle/finance-service";
import type { LifestyleData } from "../lifestyle/store-core";
import type { readFinanceBill } from "../lifestyle/finance-domain";

export type MobileModuleId = "journal" | "todos" | "finance" | "knowledge-base";
export interface MobileJournalSnapshot {
  settings: ReturnType<typeof readNativeJournalSettings>; records: HomeVaultFileRecord[];
  stats: JournalStats; templates: HomeCustomTemplateSummary[];
}
export interface MobileJournalPort {
  openSettings(): void;
  readTemplate(choice: HomeJournalTemplateChoice): Promise<string>;
  previewImportedTemplate(fileName: string, content: string): ImportedJournalTemplate;
  saveImportedTemplate(template: ImportedJournalTemplate, conflictResolution?: "cancel" | "safe-copy"): Promise<HomeTemplateSaveResult>;
  read(): Promise<MobileJournalSnapshot>; readSummary(path: string): Promise<string>;
  create(date: Date, choice: HomeJournalTemplateChoice): Promise<{ path: string; created: boolean }>;
  subscribe(listener: () => void): () => void;
}
export interface MobileTodoSnapshot extends TodoReadSnapshot {
  projects: TodoProject[]; categories: CodexForObsidianSettings["todoCategories"];
  completion: ReturnType<EchoInkTodoStore["completionStatistics"]>;
}
export interface MobileTodoPort {
  read(): Promise<MobileTodoSnapshot>;
  addCategory(name: string): Promise<void>;
  renameCategory(oldName: string, newName: string, expectedVersion: string | null): Promise<void>;
  add(input: TodoInput, expectedVersion: string | null): Promise<void>;
  update(target: ParsedTodoRecord, patch: Partial<TodoInput>, expectedVersion: string | null): Promise<void>;
  toggle(target: ParsedTodoRecord, done: boolean, expectedVersion: string | null): Promise<void>;
  remove(target: ParsedTodoRecord, expectedVersion: string | null): Promise<void>;
  subscribe(listener: () => void): () => void;
}
export interface MobileFinancePort {
  service: LifestyleFinanceService; readData(): Promise<Readonly<LifestyleData>>;
  readBill: typeof readFinanceBill; saveCsv(name: string, content: string): Promise<string>;
}
export interface MobileModulePort {
  journal: MobileJournalPort; todos: MobileTodoPort; finance: MobileFinancePort;
  owner(module: MobileModuleId): AgentDefinition;
  handoff(module: MobileModuleId, prompt: string, replaceDraft?: boolean): Promise<{ agentId: string; conflict: boolean }>;
}
