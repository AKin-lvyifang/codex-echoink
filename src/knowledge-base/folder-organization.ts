import { normalizeKnowledgeDirectory, pathInKnowledgeDirectory, type KnowledgeFolderBinding, type KnowledgeFolderBindings } from "./folder-bindings";
import { KNOWLEDGE_ROOT_ROLES, type KnowledgeRootRole } from "./root-paths-core";

export interface KnowledgeOrganizationBinding {
  readonly role: KnowledgeRootRole;
  readonly root: string;
  readonly binding: KnowledgeFolderBinding;
}

/** The most specific actual binding owns a path, including nested bindings. */
export function knowledgeOrganizationBinding(
  config: KnowledgeFolderBindings,
  relativePath: string
): KnowledgeOrganizationBinding | null {
  const target = normalizeKnowledgeDirectory(relativePath);
  const matches = KNOWLEDGE_ROOT_ROLES.flatMap(role => {
    const binding = config.roles[role];
    if (!binding.enabled || config.migrationIssues.some(issue => issue.startsWith(`${role}：`))) return [];
    return binding.readPaths.filter(root => pathInKnowledgeDirectory(target, root)).map(root => ({ role, root, binding }));
  }).sort((left, right) => right.root.length - left.root.length);
  // Ambiguous shared roots never gain organization permission by role order.
  if (!matches.length || matches.filter(match => match.root.length === matches[0].root.length).length !== 1) return null;
  return matches[0];
}

/** Legacy approvals cover exactly their declared children and required ancestors. */
export function knowledgeMayCreateCategoryDirectory(config: KnowledgeFolderBindings, directory: string): boolean {
  const target = normalizeKnowledgeDirectory(directory);
  const owner = knowledgeOrganizationBinding(config, target);
  if (!owner || target === owner.root) return false;
  if (owner.binding.autoOrganizePaths?.includes(owner.root)) return true;
  if (!(owner.binding.allowedSubdirectoryRoots ?? owner.binding.readPaths).includes(owner.root)) return false;
  const child = target.slice(owner.root.length + 1);
  return owner.binding.allowedSubdirectories.some(allowed => allowed === child || allowed.startsWith(`${child}/`));
}

/** Consent never crosses an actual root, even between two roots of one role. */
export function knowledgeMayOrganizeMove(config: KnowledgeFolderBindings, sourcePath: string, targetPath: string): boolean {
  const source = knowledgeOrganizationBinding(config, sourcePath);
  const target = knowledgeOrganizationBinding(config, targetPath);
  return !!source && !!target && source.role === target.role && source.root === target.root
    && source.binding.autoOrganizePaths?.includes(source.root) === true;
}
