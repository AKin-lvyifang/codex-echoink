import { readdirSync, lstatSync, realpathSync } from "node:fs";
import * as path from "node:path";

import { KNOWLEDGE_ROOT_NAMES, KNOWLEDGE_ROOT_ROLES, knowledgeRootRole, resolveKnowledgePathFromRoots, type KnowledgeRootRole } from "./root-paths-core";
import { knowledgeRolePath } from "./root-paths-core";
import type { KnowledgeFolderBindings, KnowledgeFolderStatus } from "./folder-bindings";
export * from "./root-paths-core";
export * from "./folder-bindings";

function vaultBindingKey(vaultRoot: string): string {
  try { return realpathSync(vaultRoot); } catch { return path.resolve(vaultRoot); }
}
const bindingsByVault = new Map<string, { getBindings: () => KnowledgeFolderBindings | null | undefined; roleScope: readonly KnowledgeRootRole[] }>();
const privateRootsByVault = new Map<string, string>();
export function registerKnowledgePrivateRoot(vaultRoot: string, privateRoot: string): void {
  privateRootsByVault.set(vaultBindingKey(vaultRoot), privateRoot);
}
export function knowledgePrivateRoot(vaultRoot: string): string | null {
  return privateRootsByVault.get(vaultBindingKey(vaultRoot)) ?? null;
}
export function registerKnowledgeFolderBindings(vaultRoot: string, getBindings: () => KnowledgeFolderBindings | null | undefined, roleScope: readonly KnowledgeRootRole[] = KNOWLEDGE_ROOT_ROLES): () => void {
  const key = vaultBindingKey(vaultRoot);
  const registration = { getBindings, roleScope: [...roleScope] };
  bindingsByVault.set(key, registration);
  return () => { if (bindingsByVault.get(key) === registration) bindingsByVault.delete(key); };
}
export function getKnowledgeFolderBindings(vaultRoot: string): KnowledgeFolderBindings | null {
  return bindingsByVault.get(vaultBindingKey(vaultRoot))?.getBindings() ?? null;
}
function knowledgeRoleScope(vaultRoot: string): readonly KnowledgeRootRole[] { return bindingsByVault.get(vaultBindingKey(vaultRoot))?.roleScope ?? KNOWLEDGE_ROOT_ROLES; }
export function knowledgePathRole(vaultRoot: string, relativePath: string): KnowledgeRootRole | null {
  const registration = bindingsByVault.get(vaultBindingKey(vaultRoot));
  return knowledgeRootRole(relativePath, registration?.getBindings(), registration?.roleScope);
}
export function knowledgePathPolicy(vaultRoot: string, relativePath: string): string {
  const registration = bindingsByVault.get(vaultBindingKey(vaultRoot));
  return knowledgeRolePath(relativePath, registration?.getBindings(), registration?.roleScope);
}
export function knowledgeRoleStatus(vaultRoot: string, role: KnowledgeRootRole): KnowledgeFolderStatus {
  if (!knowledgeRoleScope(vaultRoot).includes(role)) return "disabled";
  const bindings = getKnowledgeFolderBindings(vaultRoot);
  if (!bindings) return "ready"; // Legacy isolated hosts, not the production startup.
  const binding = bindings.roles[role];
  if (bindings.migrationIssues.some((issue) => issue.startsWith(`${role}：`))) return "invalid";
  if (!binding.enabled) return "disabled";
  if (binding.native && (role === "journal" || role === "templates") && !binding.writePath) return "ready";
  if (!binding.writePath || !binding.readPaths.includes(binding.writePath)) return "unbound";
  try {
    let cursor = vaultRoot;
    for (const segment of binding.writePath.split("/")) { cursor = path.join(cursor, segment); const stat = lstatSync(cursor); if (!stat.isDirectory() || stat.isSymbolicLink()) return "invalid"; }
    return "ready";
  }
  catch { return "invalid"; }
}
export function resolveKnowledgeRoleTarget(vaultRoot: string, role: KnowledgeRootRole, child = ""): string {
  const bindings = getKnowledgeFolderBindings(vaultRoot);
  const status = knowledgeRoleStatus(vaultRoot, role);
  if (status !== "ready") throw new Error(`${role} 位置${{ disabled: "未启用", unbound: "尚未绑定", invalid: "已失效", ready: "" }[status]}，请在知识库目录中选择位置。`);
  if (!bindings) return resolveKnowledgePathFromRoots(role + (child ? `/${child}` : ""), knowledgeRootEntries(vaultRoot), true, knowledgeRoleScope(vaultRoot));
  child = child.replace(/\\/gu, "/");
  if (child && (child.startsWith("/") || /^[a-z]:/iu.test(child) || child.split("/").some((part) => !part || part === "." || part === ".."))) throw new Error("用途子路径无效。");
  const directory = bindings.roles[role].writePath ?? "";
  return directory ? directory + (child ? `/${child}` : "") : child;
}

export function knowledgeRootEntries(vaultRoot: string): string[] {
  try { return readdirSync(vaultRoot); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}

export function resolveKnowledgePath(vaultRoot: string, relativePath: string, preferBilingual = true): string {
  if (getKnowledgeFolderBindings(vaultRoot)) {
    // Explicit real paths always stay literal. Logical role callers use resolveKnowledgeRoleTarget.
    return relativePath.replace(/\\/gu, "/");
  }
  return resolveKnowledgePathFromRoots(relativePath, knowledgeRootEntries(vaultRoot), preferBilingual, knowledgeRoleScope(vaultRoot));
}

export function knowledgeRoleRoots(vaultRoot: string, role: KnowledgeRootRole): string[] {
  if (!knowledgeRoleScope(vaultRoot).includes(role)) return [];
  const bindings = getKnowledgeFolderBindings(vaultRoot);
  if (bindings) return bindings.roles[role].enabled ? [...bindings.roles[role].readPaths] : [];
  const matches = knowledgeRootEntries(vaultRoot).filter((root) => {
    if (knowledgeRootRole(root) !== role) return false;
    try {
      const stat = lstatSync(path.join(vaultRoot, root));
      // Keep symlinks visible to each caller's existing safety checks.
      return stat.isDirectory() || stat.isSymbolicLink();
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  });
  return matches.length ? matches : [KNOWLEDGE_ROOT_NAMES[role]];
}
