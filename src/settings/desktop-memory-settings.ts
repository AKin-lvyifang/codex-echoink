import { Notice, setIcon } from "obsidian";
import type CodexForObsidianPlugin from "../main";
import { createOriginButton, createOriginSlider, createOriginSwitch, disposeOriginControls } from "./origin-controls";
import { OriginSetting } from "./origin-setting";
import { attachSettingsHelpTooltip, applySettingsRow, createSettingsGroup, createSettingsNavigationRow, createSettingsSection } from "./settings-v2";
import { renderManualDreamAction } from "./manual-dream-action";

/** Desktop presentation only; existing memory/Dream settings remain authoritative. */
export class DesktopMemorySettings {
  private pending = false;
  private root: HTMLElement | null = null;
  constructor(private readonly plugin: CodexForObsidianPlugin, private readonly actions: {
    redraw(): void; openMemoryPage(): void;
  }) {}
  get submitting(): boolean { return this.pending; }
  suspend(): void { if (this.root) disposeOriginControls(this.root); this.root = null; }
  render(parent: HTMLElement): void {
    this.suspend();
    const p = this.plugin, zh = p.settings.settingsLanguage !== "en", m = p.settings.memory;
    const section = createSettingsSection(parent, { surface: "flat" }); this.root = section;
    section.addClass("echoink-memory-settings");
    const group = createSettingsGroup(section);
    const memory = applySettingsRow(new OriginSetting(group).setName(zh ? "长期记忆" : "Long-term memory"));
    const toggle = createOriginSwitch(memory.controlEl, { attr: { "aria-label": zh ? "使用长期记忆" : "Use long-term memory", "data-echoink-focus-key": "general:memory:enabled" } });
    toggle.checked = m.useLongTermMemory; toggle.disabled = this.pending;
    toggle.onchange = () => {
      const value = toggle.checked, previous = m.useLongTermMemory;
      const modes = new Map(p.settings.sessions.map(s => [s.id, s.defaultMemoryMode]));
      void this.save(() => {
        m.useLongTermMemory = value;
        for (const session of p.settings.sessions) session.defaultMemoryMode = value ? "normal" : "no_memory";
      }, () => {
        m.useLongTermMemory = previous;
        for (const session of p.settings.sessions) if (modes.has(session.id)) session.defaultMemoryMode = modes.get(session.id)!;
      }, () => { p.getCodexView()?.refreshPersonalizationUi(); });
    };
    const dream = applySettingsRow(new OriginSetting(group).setName(zh ? "空闲时整理记忆（做梦）" : "Consolidate memory while idle (Dream)"));
    const dreamToggle = createOriginSwitch(dream.controlEl, { attr: { "aria-label": zh ? "空闲时整理记忆（做梦）" : "Consolidate memory while idle (Dream)", "data-echoink-focus-key": "general:memory:dream" } });
    dreamToggle.checked = m.dreamEnabled;
    const help = createOriginButton(dream.nameEl, { cls: "echoink-settings-help-trigger", attr: { "aria-label": zh ? "做梦说明" : "Dream information" } });
    setIcon(help, "info");
    attachSettingsHelpTooltip(help, zh ? "Obsidian 打开且空闲时整理已有记忆；关闭后保留原内容。" : "Consolidate memories while Obsidian is open and idle. Turning this off preserves existing content.");
    dreamToggle.onchange = () => {
      if (!m.useLongTermMemory) return;
      const value = dreamToggle.checked, old = m.dreamEnabled;
      void this.save(() => { m.dreamEnabled = value; }, () => { m.dreamEnabled = old; });
    };
    this.disableRow(dream.settingEl, this.pending || !m.useLongTermMemory);
    const runs = applySettingsRow(new OriginSetting(group).setName(zh ? "每日整理次数" : "Runs per day"));
    runs.controlEl.addClass("general-range");
    const output = runs.controlEl.createEl("output", { text: zh ? `${m.dreamRunsPerDay} 次/天` : `${m.dreamRunsPerDay}/day` });
    const slider = createOriginSlider(runs.controlEl, { value: m.dreamRunsPerDay, min: 1, max: 6, step: 1, label: zh ? "每日整理次数" : "Runs per day", onValueChange: value => output.setText(zh ? `${value} 次/天` : `${value}/day`), onValueCommit: value => {
      if (!m.useLongTermMemory || !m.dreamEnabled) return;
      const old = m.dreamRunsPerDay; void this.save(() => { m.dreamRunsPerDay = value; }, () => { m.dreamRunsPerDay = old; });
    } });
    runs.controlEl.insertBefore(slider, output);
    this.disableRow(runs.settingEl, this.pending || !m.useLongTermMemory || !m.dreamEnabled);
    const manual = renderManualDreamAction(group, p, p.settings.settingsLanguage, () => this.actions.redraw());
    this.disableRow(manual.settingEl, this.pending || !m.useLongTermMemory || !m.dreamEnabled);
    const links = createSettingsGroup(section);
    createSettingsNavigationRow(links, { title: zh ? "打开记忆页" : "Open memory page", focusKey: "agent:memory-page", onActivate: () => this.actions.openMemoryPage() });
  }
  private disableRow(row: HTMLElement, disabled: boolean): void {
    row.inert = disabled; row.toggleClass("is-disabled", disabled);
    row.setAttr("aria-disabled", String(disabled));
    if (disabled) row.querySelectorAll<HTMLButtonElement>("button").forEach(button => { button.disabled = true; });
  }
  private async save(change: () => void, rollback: () => void, success?: () => void): Promise<void> {
    if (this.pending) return;
    this.pending = true; change(); this.actions.redraw();
    try { await this.plugin.saveSettings(true); success?.(); }
    catch (error) {
      rollback(); console.warn("[EchoInk] Memory setting was not saved", error);
      new Notice(this.plugin.settings.settingsLanguage === "en" ? "Not saved. Try again." : "设置未保存，请重试");
    } finally { this.pending = false; this.actions.redraw(); }
  }
}
