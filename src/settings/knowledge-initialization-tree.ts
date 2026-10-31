import { setIcon } from "obsidian";
import type { KnowledgeDirectoryPlan } from "../knowledge-base/folder-plan";
import { attachSettingsTooltip } from "./settings-v2";

export interface InitializationTreeFolder {
  path: string;
  name: string;
  created: boolean;
  moved: number;
  purposes: string[];
  children: InitializationTreeFolder[];
}

/** The post-confirmation folder tree, including unchanged folders and selected new parents. */
export function initializationFolderTree(folders: readonly string[], plan: KnowledgeDirectoryPlan,
  nativePurposes: readonly { path: string; purpose: string }[] = []): InitializationTreeFolder[] {
  const nodes = new Map<string, InitializationTreeFolder>();
  const created = new Set(plan.create);
  const roots: InitializationTreeFolder[] = [];
  const ensure = (path: string): InitializationTreeFolder => {
    let node = nodes.get(path);
    if (node) return node;
    const parts = path.split("/");
    node = { path, name: parts.at(-1)!, created: created.has(path), moved: 0, purposes: [], children: [] };
    nodes.set(path, node);
    (parts.length > 1 ? ensure(parts.slice(0, -1).join("/")).children : roots).push(node);
    return node;
  };
  for (const path of [...folders, ...plan.create]) if (path) ensure(path);
  const bind = (path: string, purpose: string) => {
    // A missing saved location is an error in the form, never a fictitious folder here.
    const node = nodes.get(path);
    if (node && !node.purposes.includes(purpose)) node.purposes.push(purpose);
  };
  const labels = { raw: "资料来源", wiki: "知识成果", projects: "项目", inbox: "收件箱", outputs: "输出", journal: "日记", work: "工作", archive: "归档", templates: "模板", assets: "附件" };
  for (const [role, binding] of Object.entries(plan.bindings.roles)) {
    if (binding.enabled) for (const path of binding.readPaths) bind(path, labels[role as keyof typeof labels]);
  }
  const moduleLabels = { journal: "日记", review: "复盘输出", english: "英文稿", expressions: "表达库", pdfOriginal: "原 PDF" };
  for (const [key, path] of Object.entries(plan.moduleDirectories ?? {})) if (typeof path === "string" && path) bind(path, moduleLabels[key as keyof typeof moduleLabels]);
  for (const item of nativePurposes) bind(item.path, item.purpose);
  for (const move of plan.moves) {
    const parent = move.to.slice(0, move.to.lastIndexOf("/"));
    if (parent) ensure(parent).moved++;
  }
  const sort = (items: InitializationTreeFolder[]) => {
    items.sort((a, b) => a.name.localeCompare(b.name, "zh-CN", { numeric: true }));
    for (const node of items) sort(node.children);
  };
  sort(roots);
  return roots;
}

export function renderInitializationFolderTree(container: HTMLElement, folders: InitializationTreeFolder[]): void {
  const render = (parent: HTMLElement, nodes: InitializationTreeFolder[], depth: number) => {
    for (const node of nodes) {
      const branch = node.children.length ? parent.createEl("details", { cls: "echoink-init-tree-branch" }) : null;
      if (branch) branch.open = depth < 2;
      const row = branch ? branch.createEl("summary", { cls: "echoink-init-tree-row" })
        : parent.createDiv({ cls: "echoink-init-tree-row is-leaf", attr: { tabindex: "0" } });
      row.setAttr("data-folder-path", node.path);
      row.setAttr("aria-label", `${node.path}${node.purposes.length ? `，${node.purposes.join("、")}` : ""}${node.created ? "，新建" : ""}${node.moved ? `，移入 ${node.moved} 个文件` : ""}`);
      attachSettingsTooltip(row, node.path);
      const disclosure = row.createSpan({ cls: "echoink-init-tree-disclosure", attr: { "aria-hidden": "true" } });
      if (branch) setIcon(disclosure, "chevron-right");
      const name = row.createSpan({ cls: "echoink-init-tree-name" });
      setIcon(name.createSpan({ cls: "echoink-init-tree-icon", attr: { "aria-hidden": "true" } }), "folder");
      name.createSpan({ text: node.name });
      if (node.created) row.createSpan({ cls: "echoink-folder-picker-new", text: "新建" });
      if (node.moved) row.createSpan({ cls: "echoink-init-tree-moved", text: `移入 ${node.moved} 个文件` });
      if (node.purposes.length) row.createSpan({ cls: "echoink-init-tree-purpose", text: node.purposes.join(" · ") });
      if (branch) render(branch.createDiv({ cls: "echoink-init-tree-children" }), node.children, depth + 1);
    }
  };
  container.addClass("echoink-init-tree");
  if (!folders.length) container.createDiv({ cls: "setting-item-description", text: "还没有文件夹" });
  else render(container, folders, 0);
}
