import { knowledgeRolePath } from "../knowledge-base/root-paths-core";
import type { KnowledgeFolderBindings } from "../knowledge-base/folder-bindings";
import type { KnowledgeMaintenanceSourcesHost } from "../knowledge-base/knowledge-maintenance-sources-core";

export function strictKnowledgePagePath(value: string): string {
  if (!value || value.startsWith("/") || /^[a-z]:/iu.test(value) || ([...value].some(character => character.charCodeAt(0) < 32) || value.includes("\\"))
    || value.split("/").some(part => !part || part === "." || part === ".." || part.startsWith("."))) throw new Error("请选择当前笔记库内的有效相对路径。");
  return value;
}
function normalize(value: string): string {
  const absolute = value.startsWith("/"), stack: string[] = [];
  for (const part of value.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") { if (stack.length && stack.at(-1) !== "..") stack.pop(); else if (!absolute) stack.push(part); }
    else stack.push(part);
  }
  const result = (absolute ? "/" : "") + stack.join("/");
  return (result || (absolute ? "/" : ".")) + (value.endsWith("/") && stack.length ? "/" : "");
}
export const knowledgePagePosix = {
  normalize,
  join: (...values: string[]): string => normalize(values.filter(Boolean).join("/")),
  dirname: (value: string): string => {
    const stripped = value.replace(/\/+$/u, ""), slash = stripped.lastIndexOf("/");
    return slash < 0 ? "." : slash === 0 ? "/" : stripped.slice(0, slash);
  }
};
export function mobileKnowledgeSourcesHost(bindings: KnowledgeFolderBindings): KnowledgeMaintenanceSourcesHost {
  return { normalizePath: strictKnowledgePagePath, rolePath: value => knowledgeRolePath(value, bindings), path: knowledgePagePosix };
}
