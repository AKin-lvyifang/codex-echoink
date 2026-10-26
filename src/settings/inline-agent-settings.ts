import { Notice } from "obsidian";
import type CodexForObsidianPlugin from "../main";
import { validInlineTrigger } from "../inline-agent/settings";
import { createOriginInput } from "./origin-controls";
import { createSettingsGroup, createSettingsSection } from "./settings-v2";

export function renderInlineAgentSettings(parent: HTMLElement, plugin: CodexForObsidianPlugin): void {
  const zh = plugin.settings.settingsLanguage !== "en";
  const section = createSettingsSection(parent, { title: zh ? "正文管家" : "Agent in notes", surface: "flat" });
  const group = createSettingsGroup(section), row = group.createDiv({ cls: "echoink-inline-trigger-setting" });
  const label = row.createEl("label", { text: zh ? "唤起符号" : "Trigger character" });
  const input = createOriginInput(row, { value: plugin.settings.inlineAgent.trigger, attr: { type: "text", maxlength: "2", "aria-label": label.textContent ?? "", "data-echoink-focus-key": "inline-agent:trigger" } });
  label.htmlFor = input.id = "echoink-inline-trigger";
  input.onchange = () => {
    const next = input.value;
    if (!validInlineTrigger(next)) { input.value = plugin.settings.inlineAgent.trigger; new Notice(zh ? "请输入一个符号，例如 @ 或 !。" : "Enter one symbol, such as @ or !."); return; }
    const previous = plugin.settings.inlineAgent.trigger;
    plugin.settings.inlineAgent.trigger = next; input.disabled = true;
    void plugin.saveSettings(true).then(() => plugin.inlineAgent?.checkDateConflict()).catch(error => {
      plugin.settings.inlineAgent.trigger = previous; input.value = previous; new Notice(error instanceof Error ? error.message : "设置未保存。");
    }).finally(() => { input.disabled = false; });
  };
}
