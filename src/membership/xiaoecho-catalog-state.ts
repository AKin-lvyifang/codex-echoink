import {
  createDiscoveredApiProviderModelConfig,
  type ApiProviderConfig,
  type ApiProviderModelConfig,
  type CodexForObsidianSettings
} from "../settings/settings";
import { latestXiaoechoCatalog, xiaoechoCatalogBaseUrl, xiaoechoDiscoveredModels } from "./xiaoecho-catalog";

const rejectedModels = new Map<string, Set<string>>();
const listeners = new Set<() => void>();
export function subscribeXiaoechoCatalogChanges(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function publishXiaoechoCatalogChanges(): void {
  for (const listener of listeners) {
    try { listener(); } catch (error) { console.error("EchoInk model selector could not refresh", error); }
  }
}
export function rejectXiaoechoModel(baseUrl: string, modelId: string): void {
  if (modelId === "auto") return;
  const key = xiaoechoCatalogBaseUrl(baseUrl);
  const rejected = rejectedModels.get(key) ?? new Set<string>();
  rejected.add(modelId); rejectedModels.set(key, rejected);
}
export function xiaoechoSelectableModels(provider: ApiProviderConfig): readonly ApiProviderModelConfig[] {
  if (provider.providerId !== "xiaoecho") return provider.models;
  const catalog = latestXiaoechoCatalog(provider.baseUrl)?.catalog;
  const enabled = catalog ? new Set(xiaoechoDiscoveredModels(catalog).map(model => model.id)) : null;
  const rejected = rejectedModels.get(xiaoechoCatalogBaseUrl(provider.baseUrl));
  return provider.models.filter(model => model.id === "auto" || (!rejected?.has(model.id) && (!enabled || enabled.has(model.id))));
}
export function filterXiaoechoProviderDraft(provider: ApiProviderConfig): void {
  if (provider.providerId !== "xiaoecho") return;
  const latest = latestXiaoechoCatalog(provider.baseUrl);
  // A new Provider or an editor opened before refresh must use the accepted catalog.
  if (latest) provider.models = xiaoechoDiscoveredModels(latest.catalog).map(discovered => createDiscoveredApiProviderModelConfig(
    "xiaoecho", discovered.id, provider.runtimeProviderId, discovered, provider.models.find(model => model.id === discovered.id)));
  provider.models = [...xiaoechoSelectableModels(provider)];
  if (!provider.models.some(model => model.id === "auto")) {
    provider.models.unshift(createDiscoveredApiProviderModelConfig("xiaoecho", "auto", provider.runtimeProviderId,
      { id: "auto", displayName: "auto", input: ["text", "image"], toolCalling: true, reasoning: false, contextWindow: 1_000_000, modelMaxTokens: 16_384 }));
  }
  if (!provider.models.some(model => model.id === provider.defaultModelId)) provider.defaultModelId = "auto";
}
export function repairXiaoechoModelSelection(
  settings: Pick<CodexForObsidianSettings, "apiProviders" | "activeApiProviderId" | "defaultModel">,
  selection: { providerSettingsId?: string; modelId?: string }
): { providerSettingsId?: string; modelId?: string } {
  const provider = settings.apiProviders?.find(candidate => candidate.id === (selection.providerSettingsId ?? settings.activeApiProviderId));
  if (provider?.providerId !== "xiaoecho") return selection;
  const modelId = selection.modelId ?? (selection.providerSettingsId === undefined ? settings.defaultModel : provider.defaultModelId);
  if (modelId === "auto" || xiaoechoSelectableModels(provider).some(model => model.id === modelId)) return selection;
  return { ...selection, providerSettingsId: provider.id, modelId: "auto" };
}

export function repairSavedXiaoechoSelections(settings: CodexForObsidianSettings): boolean {
  let changed = false;
  const current = repairXiaoechoModelSelection(settings, { providerSettingsId: settings.activeApiProviderId, modelId: settings.defaultModel });
  if (current.modelId !== settings.defaultModel) { settings.defaultModel = current.modelId!; changed = true; }
  for (const drafts of [settings.taskWorkspace?.newTaskDrafts, settings.taskWorkspace?.replyDrafts]) {
    for (const draft of Object.values(drafts ?? {})) {
      const repaired = repairXiaoechoModelSelection(settings, { providerSettingsId: draft.selectedProviderSettingsId, modelId: draft.selectedModel });
      if (repaired.modelId !== draft.selectedModel || repaired.providerSettingsId !== draft.selectedProviderSettingsId) {
        draft.selectedProviderSettingsId = repaired.providerSettingsId;
        draft.selectedModel = repaired.modelId;
        changed = true;
      }
    }
  }
  return changed;
}
