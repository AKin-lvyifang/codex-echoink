import { setIcon } from "obsidian";
import { createOriginButton } from "./origin-controls";
import { apiProviderPresetDisplayName, type ApiProviderPreset } from "./provider-presets";
import { renderProviderBrandIcon } from "./provider-brand-icons";
import { providerServiceCategories } from "./provider-service-categories";
export { providerServiceCategories, type ProviderServiceCategoryId } from "./provider-service-categories";

export interface ProviderServicePickerOptions {
  readonly language: "zh-CN" | "en";
  readonly addedProviderIds?: readonly string[];
  readonly onSelect: (preset: ApiProviderPreset) => void;
}

/** A navigation-only entry into the existing, complete provider editor. */
export function renderProviderServicePicker(host: HTMLElement, options: ProviderServicePickerOptions): void {
  const picker = host.createDiv({ cls: "echoink-provider-service-picker" });
  for (const category of providerServiceCategories(options.language)) {
    const section = picker.createEl("section", {
      cls: "echoink-provider-service-category",
      attr: { "data-provider-category": category.id }
    });
    section.createEl("h3", { text: category.label });
    const cards = section.createDiv({ cls: "echoink-provider-service-cards" });
    for (const preset of category.presets) {
      const card = createOriginButton(cards, {
        cls: "echoink-provider-service-card",
        attr: { type: "button", "data-provider-service": preset.id }
      });
      const icon = card.createSpan({ cls: "echoink-provider-service-icon", attr: { "aria-hidden": "true" } });
      renderProviderBrandIcon(icon, preset.id);
      const copy = card.createSpan({ cls: "echoink-provider-service-copy" });
      copy.createSpan({ cls: "echoink-provider-service-name", text: apiProviderPresetDisplayName(preset.id, options.language) });
      copy.createSpan({ cls: "echoink-provider-service-description", text: providerDescription(preset, options.language) });
      if (options.addedProviderIds?.includes(preset.id)) {
        const status = card.createSpan({ cls: "echoink-provider-service-status" });
        setIcon(status.createSpan({ attr: { "aria-hidden": "true" } }), "circle-check");
        status.createSpan({ text: options.language === "en" ? "Added" : "已添加" });
      }
      card.onclick = () => options.onSelect(preset);
    }
  }
}

function providerDescription(preset: ApiProviderPreset, language: "zh-CN" | "en"): string {
  const descriptions: Record<string, readonly [string, string]> = {
    "openai-codex": ["使用 ChatGPT 账号登录", "Sign in with a ChatGPT account"],
    anthropic: ["Claude 模型", "Claude models"],
    glm: ["智谱 GLM 模型", "Zhipu GLM models"],
    kimi: ["月之暗面 Kimi 模型", "Moonshot Kimi models"],
    minimax: ["MiniMax 模型", "MiniMax models"],
    deepseek: ["DeepSeek 模型", "DeepSeek models"],
    qwen: ["阿里云百炼 · 通义千问", "Alibaba Cloud Model Studio · Qwen"],
    "qwen-token-plan": ["通义千问 Token Plan 专用接口", "Dedicated Qwen Token Plan endpoint"],
    ollama: ["运行在本机的模型", "Models running on your computer"],
    custom: ["接入兼容的模型服务", "Connect a compatible model service"]
  };
  return descriptions[preset.id]?.[language === "en" ? 1 : 0] ?? (language === "en" ? "Connect with an API key" : "使用 API Key 接入");
}
