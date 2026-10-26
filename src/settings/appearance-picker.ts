import { Notice, setIcon, setTooltip } from "obsidian";
import { displayedEchoInkPalette, ECHOINK_COLOR_THEMES, type EchoInkColorTheme } from "../ui/appearance-theme";

interface AppearanceHost {
  settings: { colorTheme: EchoInkColorTheme };
  applyAppearanceTheme(ownerDocument?: Document): void;
  saveSettings(force: boolean, options: { flushConversationStore: boolean }): Promise<void>;
}

let pickerSequence = 0;

export function renderAppearancePicker(container: HTMLElement, host: AppearanceHost, zh: boolean): void {
  const doc = container.ownerDocument;
  host.applyAppearanceTheme(doc);
  const picker = doc.createElement("div");
  picker.className = "echoink-theme-picker";
  const textSegments = container.closest(".echoink-settings-aligned") !== null;
  picker.classList.toggle("is-text-segments", textSegments);
  const options = doc.createElement("fieldset");
  options.className = "echoink-theme-options";
  const legend = doc.createElement("legend");
  legend.className = "sr-only";
  legend.textContent = zh ? "主题颜色" : "Color theme";
  options.appendChild(legend);
  picker.appendChild(options);
  container.appendChild(picker);
  const name = `echoink-color-theme-${++pickerSequence}`;
  const inputs: HTMLInputElement[] = [];
  const themes = ECHOINK_COLOR_THEMES.map(theme => ({ id: theme.id, title: zh ? theme.zh : theme.en }));
  for (const theme of themes) {
    const label = doc.createElement("label");
    label.className = "echoink-theme-choice";
    label.dataset.theme = theme.id;
    const input = doc.createElement("input");
    input.type = "radio";
    input.name = name;
    input.value = theme.id;
    input.checked = theme.id === displayedEchoInkPalette(host.settings.colorTheme);
    input.setAttribute("aria-label", theme.title);
    setTooltip(label, theme.title, { placement: "top" });
    const swatch = doc.createElement("span");
    swatch.className = "echoink-theme-swatch";
    swatch.setAttribute("aria-hidden", "true");
    setIcon(swatch, "check");
    label.append(input, swatch);
    if (textSegments) {
      const title = doc.createElement("span");
      title.className = "echoink-theme-choice-title";
      title.textContent = theme.title;
      label.appendChild(title);
    }
    options.appendChild(label);
    inputs.push(input);
    input.addEventListener("change", () => {
      if (input.checked && host.settings.colorTheme !== theme.id) void select(theme.id, input);
    });
  }

  async function select(theme: EchoInkColorTheme, selected: HTMLInputElement): Promise<void> {
    const previous = host.settings.colorTheme;
    inputs.forEach(input => { input.disabled = true; });
    host.settings.colorTheme = theme;
    host.applyAppearanceTheme();
    try {
      await host.saveSettings(true, { flushConversationStore: false });
    } catch {
      host.settings.colorTheme = previous;
      host.applyAppearanceTheme();
      new Notice(zh ? "主题未保存，已恢复原主题。请重试。" : "Theme could not be saved. The previous theme was restored. Please try again.");
    } finally {
      inputs.forEach(input => {
        input.checked = input.value === displayedEchoInkPalette(host.settings.colorTheme);
        input.disabled = false;
      });
      if (selected.isConnected && (doc.activeElement === doc.body || picker.contains(doc.activeElement))) {
        inputs.find(input => input.checked)?.focus({ preventScroll: true });
      }
    }
  }
}
