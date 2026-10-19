import { setIcon } from "obsidian";
import { createOriginButton } from "./origin-controls";
import { apiProviderPresetDisplayName, type ApiProviderPreset } from "./provider-presets";
import { renderProviderBrandIcon } from "./provider-brand-icons";
import { providerServiceCategories } from "./provider-service-categories";
export { providerServiceCategories, type ProviderServiceCategoryId } from "./provider-service-categories";

export interface ProviderServicePickerOptions {
  readonly language: "zh-CN" | "en";
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
      card.createSpan({ cls: "echoink-provider-service-name", text: apiProviderPresetDisplayName(preset.id, options.language) });
      setIcon(card.createSpan({ cls: "echoink-provider-service-arrow", attr: { "aria-hidden": "true" } }), "chevron-right");
      card.onclick = () => options.onSelect(preset);
    }
  }
}
