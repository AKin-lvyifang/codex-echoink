import { KNOWLEDGE_ROOT_ROLES } from "./root-paths-core";
import { classifyKnowledgePath, knowledgeFolderIssues, normalizeKnowledgeDirectory, type KnowledgeFolderBindings } from "./folder-bindings";

export interface KnowledgeDirectoryPlan {
  baseRevision: number;
  bindings: KnowledgeFolderBindings;
  reuse: string[];
  create: string[];
  sources: string[];
  issues: string[];
}
export async function previewKnowledgeDirectoryPlan(input: {
  baseRevision: number;
  bindings: KnowledgeFolderBindings;
  createPaths: readonly string[];
  kind(path: string): Promise<"folder" | "missing" | "other">;
  sourcePaths: readonly string[];
}): Promise<KnowledgeDirectoryPlan> {
  const bindings = structuredClone(input.bindings);
  bindings.migrationIssues = [];
  const issues = knowledgeFolderIssues(bindings);
  const approved = new Set(input.createPaths.map(normalizeKnowledgeDirectory));
  const reuse = new Set<string>();
  const create = new Set<string>();
  for (const role of KNOWLEDGE_ROOT_ROLES) {
    const binding = bindings.roles[role];
    if (!binding.enabled) continue;
    if (binding.native && (role === "journal" || role === "templates")) { for (const directory of binding.readPaths) if (await input.kind(directory) === "folder") reuse.add(directory); continue; }
    for (const directory of binding.readPaths) {
      const kind = await input.kind(directory);
      if (kind === "folder") reuse.add(directory);
      else if (kind !== "missing" || !approved.has(directory)) issues.push(`${directory}：原位置已失效或不是目录`);
      else {
        const parts = directory.split("/");
        for (let index = 1; index <= parts.length; index++) {
          const parent = parts.slice(0, index).join("/");
          const parentKind = await input.kind(parent);
          if (parentKind === "missing") create.add(parent);
          else if (parentKind !== "folder") issues.push(`${parent}：父路径不是目录`);
        }
      }
      for (const child of binding.allowedSubdirectories) {
        const target = `${directory}/${normalizeKnowledgeDirectory(child)}`;
        if (await input.kind(target) === "missing") {
          const parts = target.split("/");
          for (let index = 1; index <= parts.length; index++) {
            const parent = parts.slice(0, index).join("/");
            const parentKind = await input.kind(parent);
            if (parentKind === "missing") create.add(parent);
            else if (parentKind !== "folder") issues.push(`${parent}：父路径不是目录`);
          }
        }
      }
    }
  }
  return { baseRevision: input.baseRevision, bindings, reuse: [...reuse], create: [...create].sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b)),
    sources: [...new Set(input.sourcePaths.filter((relative) => classifyKnowledgePath(bindings, relative) === "raw"))].sort(), issues: [...new Set(issues)] };
}
