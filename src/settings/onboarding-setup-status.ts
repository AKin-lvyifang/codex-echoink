import { getActiveApiProviderModel, validateApiProvider, type CodexForObsidianSettings } from "./settings";
import { knowledgeFolderIssues } from "../knowledge-base/folder-bindings";
import { DESKTOP_KNOWLEDGE_ROOT_ROLES } from "../knowledge-base/root-paths-core";

export function onboardingDirectoriesReady(settings: Pick<CodexForObsidianSettings, "knowledgeBase">): boolean {
  const bindings = settings.knowledgeBase.folderBindings;
  return Boolean(bindings && bindings.roles.raw.enabled && bindings.roles.raw.readPaths.length
    && [bindings.roles.wiki, bindings.roles.projects].some(role => role.enabled && role.readPaths.length)
    && !knowledgeFolderIssues(bindings, DESKTOP_KNOWLEDGE_ROOT_ROLES).length);
}
export function onboardingSetupComplete(settings: CodexForObsidianSettings): boolean {
  if (!onboardingDirectoriesReady(settings) || !settings.apiProviders?.length) return false;
  const active = getActiveApiProviderModel(settings);
  return Boolean(active && !validateApiProvider(active.provider).length);
}
