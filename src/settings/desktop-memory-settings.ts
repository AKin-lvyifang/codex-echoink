import { Notice, setIcon } from "obsidian";
import type CodexForObsidianPlugin from "../main";
import { createOriginButton, createOriginCheck, createOriginSlider, createOriginSwitch, disposeOriginControls } from "./origin-controls";
import { OriginSetting } from "./origin-setting";
import { attachSettingsTooltip, applySettingsRow, createSettingsGroup, createSettingsNavigationRow, createSettingsSection } from "./settings-v2";
import { renderManualDreamAction } from "./manual-dream-action";

/** Desktop presentation only; existing memory/Dream settings remain authoritative. */
export class DesktopMemorySettings {
  private expanded: boolean | undefined;
  private pending = false;
  private root: HTMLElement | null = null;
  constructor(private readonly plugin: CodexForObsidianPlugin, private readonly actions: {
    redraw(): void; openCorrection(): void; openProfile(): void;
  }) {}
  get submitting(): boolean { return this.pending; }
  suspend(): void { if (this.root) disposeOriginControls(this.root); this.root = null; }
  render(parent: HTMLElement): void {
    this.suspend();
    const p = this.plugin, zh = p.settings.settingsLanguage !== "en", m = p.settings.memory;
    const section = createSettingsSection(parent, { title: zh ? "记忆" : "Memory", surface: "flat" });
    section.addClass("echoink-memory-settings");
    const card = createSettingsSection(section, { surface: "group" }); this.root = section;
    card.addClass("echoink-module-drawer"); card.dataset.module = "memory";
    const header = card.createDiv({ cls: "echoink-module-drawer-header" });
    const trigger = createOriginButton(header, { cls: "echoink-module-drawer-trigger", attr: { "aria-label": zh ? "长期记忆" : "Long-term memory", "data-echoink-focus-key": "general:memory:drawer" } });
    setIcon(trigger.createSpan({ cls: "echoink-module-drawer-icon", attr: { "aria-hidden": "true" } }), "brain");
    const copy = trigger.createSpan({ cls: "echoink-module-drawer-copy" });
    copy.createSpan({ cls: "echoink-module-drawer-title", text: zh ? "长期记忆" : "Long-term memory" });
    copy.createSpan({ cls: "echoink-module-drawer-summary", text: m.useLongTermMemory ? (zh ? "所有 Agent 共用" : "Shared by all Agents") : (zh ? "已停用" : "Disabled") });
    setIcon(trigger.createSpan({ cls: "echoink-module-drawer-chevron", attr: { "aria-hidden": "true" } }), "chevron-right");
    const toggle = createOriginSwitch(header, { attr: { "aria-label": zh ? "使用长期记忆" : "Use long-term memory", "data-echoink-focus-key": "general:memory:enabled" } });
    toggle.checked = m.useLongTermMemory; toggle.disabled = this.pending;
    const content = card.createDiv({ cls: "echoink-module-drawer-content" });
    const open = m.useLongTermMemory && (this.expanded ?? true);
    content.hidden = !open; content.inert = !open; trigger.disabled = !m.useLongTermMemory || this.pending;
    trigger.setAttr("aria-expanded", String(open)); card.toggleClass("is-expanded", open);
    trigger.onclick = () => { this.expanded = !open; this.actions.redraw(); };
    toggle.onchange = () => {
      const value = toggle.checked, previous = m.useLongTermMemory;
      const modes = new Map(p.settings.sessions.map(s => [s.id, s.defaultMemoryMode]));
      void this.save(() => {
        m.useLongTermMemory = value;
        for (const session of p.settings.sessions) session.defaultMemoryMode = value ? "normal" : "no_memory";
      }, () => {
        m.useLongTermMemory = previous;
        for (const session of p.settings.sessions) if (modes.has(session.id)) session.defaultMemoryMode = modes.get(session.id)!;
      }, () => { this.expanded = value; p.getCodexView()?.refreshPersonalizationUi(); });
    };
    if (open) {
      const dream = applySettingsRow(new OriginSetting(content).setName(zh ? "空闲时整理记忆（做梦）" : "Consolidate memory while idle (Dream)"));
      const check = createOriginCheck(dream.controlEl, { attr: { "aria-label": zh ? "空闲时整理记忆（做梦）" : "Consolidate memory while idle (Dream)", "data-echoink-focus-key": "general:memory:dream" } });
      check.checked = m.dreamEnabled; check.disabled = this.pending;
      const help = createOriginButton(dream.nameEl, { cls: "echoink-settings-help-trigger", attr: { "aria-label": zh ? "做梦说明" : "Dream information" } });
      setIcon(help, "info");
      attachSettingsTooltip(help, zh ? "Obsidian 打开且空闲时整理已有记忆；关闭后保留原内容。" : "Consolidate memories while Obsidian is open and idle. Turning this off preserves existing content.");
      check.onchange = () => { const value = check.checked, old = m.dreamEnabled; void this.save(() => { m.dreamEnabled = value; }, () => { m.dreamEnabled = old; }); };
      if (m.dreamEnabled) {
        const options = content.createDiv({ cls: "echoink-dream-options" });
        const row = applySettingsRow(new OriginSetting(options).setName(zh ? "每日整理次数" : "Runs per day"));
        row.controlEl.addClass("general-range");
        const output = row.controlEl.createEl("output", { text: zh ? `${m.dreamRunsPerDay} 次/天` : `${m.dreamRunsPerDay}/day` });
        const slider = createOriginSlider(row.controlEl, { value: m.dreamRunsPerDay, min: 1, max: 6, step: 1, label: zh ? "每日整理次数" : "Runs per day", onValueChange: value => output.setText(zh ? `${value} 次/天` : `${value}/day`), onValueCommit: value => {
          const old = m.dreamRunsPerDay; void this.save(() => { m.dreamRunsPerDay = value; }, () => { m.dreamRunsPerDay = old; });
        } });
        row.controlEl.insertBefore(slider, output);
        if (this.pending) row.controlEl.inert = true;
        renderManualDreamAction(options, p, p.settings.settingsLanguage, this.actions.redraw);
      }
    }
    const links = open ? content : createSettingsGroup(section);
    createSettingsNavigationRow(links, { title: zh ? "记忆修正" : "Memory correction", focusKey: "review:memory", onActivate: this.actions.openCorrection });
    createSettingsNavigationRow(links, { title: zh ? "你的画像" : "Your profile", focusKey: "agent:profile", onActivate: this.actions.openProfile });
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
