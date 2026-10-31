import { assertKnowledgeModulePath } from "./module-directories";
import { normalizeKnowledgeDirectory } from "./folder-bindings";

export interface InitializationFolderChoice { path: string; create: boolean }
export interface InitializationFolderField { key: string; title: string; values: readonly InitializationFolderChoice[] }

/** Validate the complete form without writing any folders or normalizing away conflicts. */
export function initializationFolderIssues(fields: readonly InitializationFolderField[], folders: readonly string[]): Map<string, string[]> {
  const issues = new Map<string, string[]>();
  const add = (key: string, message: string) => { issues.set(key, [...new Set([...(issues.get(key) ?? []), message])]); };
  const existing = new Set(folders.map(path => path.toLocaleLowerCase()));
  const owners = new Map<string, { key: string; path: string }[]>();
  for (const field of fields) for (const choice of field.values) {
    let path: string;
    try {
      if (choice.create && /[\\:*?"<>|]/u.test(choice.path)) throw new Error("invalid folder name");
      path = normalizeKnowledgeDirectory(choice.path);
      if (path !== choice.path.trim()) throw new Error("invalid folder path");
      assertKnowledgeModulePath(path, field.title);
    } catch { add(field.key, choice.path.trim() ? "请选择合法的库内文件夹" : "请输入新文件夹名称"); continue; }
    const name = path.toLocaleLowerCase();
    if (choice.create && existing.has(name)) add(field.key, `${path} 文件夹重名，请修改`);
    if (!choice.create && !existing.has(name)) add(field.key, "文件夹不存在");
    const selected = owners.get(name) ?? [];
    selected.push({ key: field.key, path }); owners.set(name, selected);
  }
  for (const selected of owners.values()) if (selected.length > 1) for (const item of selected) add(item.key, `${item.path} 文件夹重名，请修改`);
  return issues;
}
