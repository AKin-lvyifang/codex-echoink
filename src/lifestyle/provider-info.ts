import type { CodexForObsidianSettings } from "../settings/settings";

export function lifestyleProviderModel(settings: CodexForObsidianSettings) {
  const provider = settings.apiProviders.find((item) => item.id === settings.activeApiProviderId);
  const model = provider?.models.find((item) => item.id === settings.defaultModel);
  return provider && model ? { provider, model } : null;
}
