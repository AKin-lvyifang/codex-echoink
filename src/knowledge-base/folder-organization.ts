import { normalizeKnowledgeDirectory, pathInKnowledgeDirectory, knowledgeOrganizationSettings, type KnowledgeFolderBinding, type KnowledgeFolderBindings } from "./folder-bindings";
import { KNOWLEDGE_ROOT_ROLES, type KnowledgeRootRole } from "./root-paths-core";

export interface KnowledgeOrganizationBinding {
  readonly role: KnowledgeRootRole;
  readonly root: string;
  readonly binding: KnowledgeFolderBinding;
}

/** Recall withdrawal affects discovered candidates, never an explicit file read. */
export function knowledgeRecallCandidateAllowed(config: KnowledgeFolderBindings | null | undefined, relativePath: string): boolean {
  if (!config) return true;
  const within = (root: string) => relativePath === root || relativePath.startsWith(`${root}/`);
  const inbox = config.roles.inbox;
  const active = inbox.enabled && inbox.searchEnabled !== false && !config.migrationIssues.some(issue => issue.startsWith("inbox："));
  const withdrawn = [...(config.inboxRecallExclusions ?? []), ...(!active ? inbox.readPaths : [])];
  if (!withdrawn.some(within)) return true;
  return Object.entries(config.roles).some(([role, binding]) => role !== "inbox" && role !== "templates" && role !== "assets"
    && binding.enabled && binding.searchEnabled !== false
    && !config.migrationIssues.some(issue => issue.startsWith(`${role}：`)) && binding.readPaths.some(within));
}

/** The most specific actual binding owns a path, including nested bindings. */
export function knowledgeOrganizationBinding(
  config: KnowledgeFolderBindings,
  relativePath: string
): KnowledgeOrganizationBinding | null {
  const target = normalizeKnowledgeDirectory(relativePath);
  const matches = KNOWLEDGE_ROOT_ROLES.flatMap(role => {
    const binding = config.roles[role];
    if (!binding.enabled) return [];
    return binding.readPaths.filter(root => pathInKnowledgeDirectory(target, root)).map(root => ({ role, root, binding }));
  }).sort((left, right) => right.root.length - left.root.length);
  // Ambiguous shared roots never gain organization permission by role order.
  if (!matches.length || matches.filter(match => match.root.length === matches[0].root.length).length !== 1) return null;
  const owner = matches[0];
  // Retired or invalid owners keep their boundary; they cannot inherit an ancestor's grant.
  return ["raw", "wiki", "projects", "inbox"].includes(owner.role) && !config.migrationIssues.some(issue => issue.startsWith(`${owner.role}：`)) ? owner : null;
}

/** Only live, unambiguous bindings of the four Knowledge purposes are selectable. */
export function knowledgeOrganizationSelectable(config: KnowledgeFolderBindings, directory: string): boolean {
  try { return knowledgeOrganizationBinding(config, directory) !== null; } catch { return false; }
}
function selectedScopeAllows(config: KnowledgeFolderBindings, target: string): boolean {
  const policy = knowledgeOrganizationSettings(config);
  return policy.enabled && (policy.scope === "all" || policy.paths.some(selected => knowledgeOrganizationSelectable(config, selected) && pathInKnowledgeDirectory(target, selected)));
}

/** Creating a category never creates the binding root itself or expands selected scope. */
export function knowledgeMayCreateCategoryDirectory(config: KnowledgeFolderBindings, directory: string): boolean {
  const target = normalizeKnowledgeDirectory(directory);
  const owner = knowledgeOrganizationBinding(config, target);
  return !!owner && target !== owner.root && selectedScopeAllows(config, target);
}

/** Both endpoints must be permitted, within the same actual root, including nested owners. */
export function knowledgeMayOrganizeMove(config: KnowledgeFolderBindings, sourcePath: string, targetPath: string): boolean {
  const source = knowledgeOrganizationBinding(config, sourcePath);
  const target = knowledgeOrganizationBinding(config, targetPath);
  return !!source && !!target && source.role === target.role && source.root === target.root
    && selectedScopeAllows(config, sourcePath) && selectedScopeAllows(config, targetPath);
}
