import type { ApiProviderConfig, CodexForObsidianSettings } from "../settings/settings";

/** An already admitted turn retains its model parameters across catalog refreshes.
 * Connection identity and account credentials still come from current settings. */
export function settingsForRunningXiaoechoModel(
  settings: CodexForObsidianSettings,
  admittedProvider: ApiProviderConfig | null,
  modelId: string
): CodexForObsidianSettings {
  if (!admittedProvider) return settings;
  const current = settings.apiProviders.find(provider => provider.id === admittedProvider.id);
  const model = admittedProvider.models.find(model => model.id === modelId);
  if (!current || !model || current.providerId !== "xiaoecho" || current.authMode !== admittedProvider.authMode
    || current.runtimeProviderId !== admittedProvider.runtimeProviderId || current.apiProtocol !== admittedProvider.apiProtocol
    || current.baseUrl !== admittedProvider.baseUrl) return settings;
  return { ...settings, apiProviders: settings.apiProviders.map(provider => provider !== current ? provider
    : { ...provider, models: [...provider.models.filter(item => item.id !== modelId), model] }) };
}
