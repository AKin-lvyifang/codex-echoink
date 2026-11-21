import type { ApiProviderConfig, ApiProviderModelConfig } from "../settings/settings";

/** Reuse an enabled model on the same authorized account/connection. */
export function lowCostRecallModel(provider: ApiProviderConfig, answerModelId: string): ApiProviderModelConfig | undefined {
  const ids = provider.providerId === "xiaoecho"
    ? ["auto", "gpt-6.1-sol", "gpt-6-sol"]
    : provider.providerId === "deepseek" ? ["deepseek-v4-flash", "deepseek-chat"] : [];
  for (const id of ids) {
    const model = provider.models.find(candidate => candidate.id === id);
    if (model && model.id !== answerModelId) return model;
  }
}
