import { Notice, setIcon, setTooltip } from "obsidian";
import { ECHOINK_COLOR_THEMES, ECHOINK_APPEARANCE_REFRESH, effectiveEchoInkColorTheme, type EchoInkColorTheme } from "../ui/appearance-theme";
import { decorateProAppearanceChoice } from "../ui/appearance-pro";
import { hasProPluginAccess, unavailableCapabilityAccess } from "../membership/access";
import type { CapabilityAccess } from "../membership/types";

interface AppearanceHost {
  settings: { colorTheme: EchoInkColorTheme };
  accountService?: CapabilityAccess | null;
  openEchoInkAccountSettings?(target: "benefits"): Promise<void>;
  applyAppearanceTheme(ownerDocument?: Document): void;
  saveSettings(force: boolean, options: { flushConversationStore: boolean }): Promise<void>;
}

let pickerSequence = 0;

export function renderAppearancePicker(container: HTMLElement, host: AppearanceHost, zh: boolean): void {
  const doc = container.ownerDocument;
  host.applyAppearanceTheme(doc);
  const picker = doc.createElement("div");
  picker.className = "echoink-theme-picker";
  picker.classList.add("echoink-appearance-pro-surface"); picker.dataset.echoinkAppearancePicker = "";
  const textSegments = container.closest(".echoink-settings-aligned") !== null;
  picker.classList.toggle("is-text-segments", textSegments);
  const options = picker.createEl("fieldset");
  options.className = "echoink-theme-options";
  const legend = options.createEl("legend");
  legend.className = "sr-only";
  legend.textContent = zh ? "主题颜色" : "Color theme";
  container.appendChild(picker);
  const name = `echoink-color-theme-${++pickerSequence}`;
  const inputs: HTMLInputElement[] = [];
  const locks: (() => void)[] = [];
  const hasPro = () => hasProPluginAccess(host.accountService ?? unavailableCapabilityAccess);
  let busy = false;
  const themes = ECHOINK_COLOR_THEMES.map(theme => ({ id: theme.id, title: zh ? theme.zh : theme.en }));
  for (const theme of themes) {
    const label = doc.createElement("label");
    label.className = "echoink-theme-choice";
    label.dataset.theme = theme.id;
    const input = label.createEl("input");
    input.type = "radio";
    input.name = name;
    input.value = theme.id;
    input.checked = theme.id === effectiveEchoInkColorTheme(host.settings.colorTheme, host.accountService);
    input.setAttribute("aria-label", theme.title);
    if (theme.id === "minimal") setTooltip(label, theme.title, { placement: "top" });
    const swatch = label.createSpan();
    swatch.className = "echoink-theme-swatch";
    swatch.setAttribute("aria-hidden", "true");
    setIcon(swatch, "check");
    if (textSegments) {
      const title = label.createSpan();
      title.className = "echoink-theme-choice-title";
      title.textContent = theme.title;
    }
    options.appendChild(label);
    inputs.push(input);
    if (theme.id !== "minimal") locks.push(decorateProAppearanceChoice(label, options, {
      zh, allowed: hasPro, blocked: () => sync(), upgrade: () => { void host.openEchoInkAccountSettings?.("benefits"); }
    }));
    input.addEventListener("change", () => {
      if (input.checked) void select(theme.id, input);
    });
  }
  const sync = () => {
    const effective = effectiveEchoInkColorTheme(host.settings.colorTheme, host.accountService);
    for (const input of inputs) { input.checked = input.value === effective; input.disabled = busy; input.setAttribute("aria-disabled", String(input.value !== "minimal" && !hasPro())); }
    locks.forEach(update => update());
  };
  picker.addEventListener(ECHOINK_APPEARANCE_REFRESH, sync); sync();

  async function select(theme: EchoInkColorTheme, selected: HTMLInputElement): Promise<void> {
    if (busy || theme !== "minimal" && !hasPro()) { sync(); return; }
    if (host.settings.colorTheme === theme) { sync(); return; }
    const previous = host.settings.colorTheme;
    busy = true; sync();
    host.settings.colorTheme = theme;
    host.applyAppearanceTheme();
    try {
      await host.saveSettings(true, { flushConversationStore: false });
    } catch {
      host.settings.colorTheme = previous;
      host.applyAppearanceTheme();
      new Notice(zh ? "主题未保存，已恢复原主题。请重试。" : "Theme could not be saved. The previous theme was restored. Please try again.");
    } finally {
      busy = false; sync();
      if (selected.isConnected && (doc.activeElement === doc.body || picker.contains(doc.activeElement))) {
        inputs.find(input => input.checked)?.focus({ preventScroll: true });
      }
    }
  }
}
