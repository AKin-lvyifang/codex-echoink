import type { MobileSettings } from "./settings";
import { validateMobileProvider } from "./settings";
import { normalizeApiProviderId } from "../settings/provider-presets";
import { fingerprint } from "../english-diary/model";

/** The desktop's exact dedicated-model choice: only two empty ids follow the global default. */
export function mobileEnglishProvider(settings: MobileSettings) {
  const diary = settings.englishDiary;
  if (!!diary.providerSettingsId !== !!diary.modelId) throw new Error("英文日记模型配置不完整，请重新选择 Provider 和模型。");
  const providerId = diary.providerSettingsId || settings.activeApiProviderId, modelId = diary.modelId || settings.defaultModel;
  const provider = settings.apiProviders.find(candidate => candidate.id === providerId);
  if (!provider) throw new Error("英文日记所选 Provider 不存在，请重新选择。");
  const model = provider.models.find(candidate => candidate.id === modelId);
  if (!model) throw new Error("英文日记所选模型不存在，请重新选择；没有改用其他模型。");
  const normalizedId = normalizeApiProviderId(provider.providerId, provider.baseUrl, provider.name);
  const identity = JSON.stringify([provider.id, normalizedId, provider.baseUrl, model.id]);
  let recipient: string = normalizedId;
  try { if (provider.baseUrl) recipient = new URL(provider.baseUrl).origin; } catch { /* Real transport validation reports an invalid address. */ }
  return { provider, model, identity, recipient, label: `${provider.name} · ${model.id}`,
    version: fingerprint(JSON.stringify([identity, provider, model])) };
}
export function assertMobileEnglishProvider(settings: MobileSettings) {
  const current = mobileEnglishProvider(settings);
  validateMobileProvider(current.provider);
  if (settings.englishDiary.approvedProvider !== current.identity) throw new Error("请先确认本次英文日记使用的模型和接收方。");
  return current;
}
