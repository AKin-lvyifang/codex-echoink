import type { KnowledgeFolderBindings } from "../knowledge-base/folder-bindings";
import type { KnowledgeDirectoryMode, KnowledgeDirectoryPlan, KnowledgeModuleDirectories } from "../knowledge-base/folder-plan";

export type MobileKnowledgeFolderRequest =
  | { kind: "initialize"; bindings: KnowledgeFolderBindings; createPaths: string[]; mode: KnowledgeDirectoryMode; moduleDirectories?: KnowledgeModuleDirectories }
  | { kind: "names"; scopes: string[] }
  | { kind: "restore"; recordId: string };
export interface MobileKnowledgeFoldersSnapshot {
  bindings: KnowledgeFolderBindings | null; token: string; directories: string[]; writable: boolean;
  moduleDirectories: KnowledgeModuleDirectories; todoSourcePath: string; todoSourceExists: boolean;
  restoreRecords: { id: string; createdAt: number; files: number; status: "completed" | "partial" | "uncertain" }[];
}
export interface MobileKnowledgeFolderPreview {
  token: string; request: MobileKnowledgeFolderRequest; reuse: string[]; create: string[];
  moves: { from: string; to: string }[]; excluded: { path: string; reason: string }[];
  issues: string[]; changes: KnowledgeDirectoryPlan["changes"];
}
export type MobileKnowledgeFolderApplyResult =
  | { status: "reconfirm"; preview: MobileKnowledgeFolderPreview }
  | { status: "completed" | "partial" | "uncertain"; recordId: string; created: string[]; moved: { from: string; to: string }[]; issues: { path: string; reason: string }[] };
export interface MobileKnowledgeFoldersPort {
  read(): Promise<MobileKnowledgeFoldersSnapshot>;
  saveBindings(next: KnowledgeFolderBindings, expectedToken: string): Promise<MobileKnowledgeFoldersSnapshot>;
  preview(request: MobileKnowledgeFolderRequest, signal?: AbortSignal): Promise<MobileKnowledgeFolderPreview>;
  apply(previewToken: string, signal?: AbortSignal): Promise<MobileKnowledgeFolderApplyResult>;
}
