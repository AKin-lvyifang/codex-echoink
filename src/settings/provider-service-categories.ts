import { API_PROVIDER_PRESETS, type ApiProviderPreset } from "./provider-presets";

export type ProviderServiceCategoryId = "account" | "api-key" | "plan" | "local" | "other";

export interface ProviderServiceCategory {
  readonly id: ProviderServiceCategoryId;
  readonly label: string;
  readonly presets: readonly ApiProviderPreset[];
}

/** Categories only organize supported presets; they never create a connection. */
export function providerServiceCategories(language: "zh-CN" | "en"): readonly ProviderServiceCategory[] {
  const zh = language !== "en";
  const groups: readonly [ProviderServiceCategoryId, string][] = [
    ["account", zh ? "账号登录" : "Account sign-in"],
    ["api-key", "API Key"],
    ["plan", zh ? "套餐" : "Plans"],
    ["local", zh ? "本地" : "Local"],
    ["other", zh ? "其他" : "Other"]
  ];
  return groups.map(([id, label]) => ({
    id,
    label,
    presets: API_PROVIDER_PRESETS.filter((preset) => providerServiceCategoryId(preset) === id)
  }));
}

function providerServiceCategoryId(preset: ApiProviderPreset): ProviderServiceCategoryId {
  if (preset.id === "ollama") return "local";
  if (preset.authMode === "oauth" || preset.group === "account") return "account";
  if (preset.group === "token-plan") return "plan";
  if (preset.group === "other") return "other";
  return "api-key";
}
