import assert from "node:assert/strict";
import type CodexForObsidianPlugin from "../main";
import { renderDesktopModuleSettings, type DesktopModuleId } from "../settings/desktop-module-settings";
import type { OriginCheckElement } from "../settings/origin-controls";

export async function runDesktopModuleSettingsTests(): Promise<void> {
  let pro = false, benefits = 0, writes = 0;
  const listeners = new Set<() => void>(), rendered: DesktopModuleId[] = [];
  const settings = { inlineAgent: { enabled: true }, settingsLanguage: "zh-CN", selectionAsk: { enabled: true }, lifestyle: { finance: { enabled: true } }, englishDiary: { enabled: false }, pdfReading: { enabled: true } };
  const plugin = {
    settings,
    accountService: { checkCapability: () => pro, subscribe(listener: () => void) { listeners.add(listener); return () => listeners.delete(listener); } },
    lifestyle: { async setEnabled(_kind: string, enabled: boolean) { writes++; settings.lifestyle.finance.enabled = enabled; } },
    englishDiary: { async setEnabled(enabled: boolean) { writes++; settings.englishDiary.enabled = enabled; } },
    pdfReading: { async setEnabled(enabled: boolean) { writes++; settings.pdfReading.enabled = enabled; } },
    async saveSettings() { writes++; }
  } as unknown as CodexForObsidianPlugin;
  const host = document.body.createDiv();
  const expanded = new Set<DesktopModuleId>(["finance", "english", "pdf", "inline-agent"]);
  const before = JSON.stringify(settings);
  const dispose = renderDesktopModuleSettings(host, { plugin, expanded, renderContent(id) { rendered.push(id); }, onProBenefits() { benefits++; } });
  const drawer = (id: string) => host.querySelector<HTMLElement>(`[data-module="${id}"]`)!;
  const trigger = (id: string) => drawer(id).querySelector<HTMLButtonElement>(".echoink-module-drawer-trigger")!;
  const toggle = (id: string) => drawer(id).querySelector<OriginCheckElement>('[role="switch"]');
  const publish = () => { for (const listener of listeners) listener(); };
  try {
    for (const id of ["finance", "english", "pdf", "inline-agent"]) {
      assert.equal(toggle(id), null, "locked modules do not show a disabled checked switch");
      assert.equal(trigger(id).disabled, false);
      assert.match(trigger(id).textContent ?? "", /需要 PRO/);
      assert.equal(drawer(id).querySelector<HTMLElement>(".echoink-module-drawer-content")!.hidden, true);
      trigger(id).click();
    }
    assert.equal(benefits, 4); assert.equal(writes, 0); assert.deepEqual(rendered, []);
    assert.equal(JSON.stringify(settings), before, "discovery preserves every saved enable flag");
    pro = true; publish();
    assert.equal(toggle("finance")!.checked, true); assert.equal(toggle("english")!.checked, false); assert.equal(toggle("pdf")!.checked, true);
    assert.equal(toggle("finance")!.disabled, false);
    assert.ok(rendered.includes("finance") && rendered.includes("pdf") && !rendered.includes("english"));
    const financeToggle = toggle("finance")!;
    financeToggle.checked = false; financeToggle.dispatchEvent(new Event("change"));
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(writes, 1); assert.equal(settings.lifestyle.finance.enabled, false);
    assert.equal(expanded.has("finance"), false);
    pro = false; publish();
    assert.equal(toggle("finance"), null); assert.equal(toggle("pdf"), null);
    assert.equal(settings.pdfReading.enabled, true); assert.equal(settings.englishDiary.enabled, false);
    financeToggle.checked = true; financeToggle.dispatchEvent(new Event("change"));
    assert.equal(writes, 1, "a detached switch cannot change settings after entitlement revocation");
    pro = true; publish();
    assert.equal(toggle("finance")!.checked, false); assert.equal(toggle("english")!.checked, false); assert.equal(toggle("pdf")!.checked, true);
    console.log("Desktop module settings passed: locked navigation, no locked switches/content/writes, enable flags preserved, live PRO recovery and revocation.");
  } finally { dispose(); host.remove(); assert.equal(listeners.size, 0); }
}
