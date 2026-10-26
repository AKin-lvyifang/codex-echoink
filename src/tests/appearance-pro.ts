import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { EchoInkAppearance, effectiveEchoInkColorTheme, renderCompanionThemeRecommendation, type EchoInkColorTheme } from "../ui/appearance-theme";
import { renderAppearancePicker } from "../settings/appearance-picker";
import type { CapabilityAccess } from "../membership/types";

const first = new JSDOM('<body class="theme-light"><main class="echoink-settings-demo echoink-settings-aligned"></main></body>');
const second = new JSDOM('<body class="theme-dark"></body>');
for (const owner of [first.window, second.window]) {
  owner.HTMLElement.prototype.createSpan = function (options: { cls?: string; text?: string; attr?: Record<string,string> } = {}) {
    const span = this.ownerDocument.createElement("span"); if (options.cls) span.className = options.cls;
    if (options.text) span.textContent = options.text; for (const [key,value] of Object.entries(options.attr ?? {})) span.setAttribute(key,value);
    this.appendChild(span); return span;
  };
}
const doc = first.window.document;
Object.assign(globalThis, { document: doc, window: first.window });
let pro = false, saves = 0, upgrades = 0, fail = false;
const access: CapabilityAccess = { checkCapability: () => pro, requireCapability: () => { if (!pro) throw new Error("PRO required"); }, subscribe: () => () => {} };
const host = { settings: { colorTheme: "manifesto" as EchoInkColorTheme }, accountService: access as CapabilityAccess | null,
  applyAppearanceTheme(owner?: Document) { if (owner) appearance.applyToDocument(owner); appearance.refresh(); },
  async saveSettings() { saves++; if (fail) throw new Error("Injected save failure"); },
  async openEchoInkAccountSettings(target: "benefits") { assert.equal(target,"benefits"); upgrades++; }
};
const app = { workspace: { containerEl: doc.body, iterateAllLeaves(callback: (leaf: unknown) => void) { callback({view:{containerEl:second.window.document.body}}); } } };
const appearance = new EchoInkAppearance(app as never, () => host.settings.colorTheme, () => host.accountService);
const settle = () => new Promise(resolve => setTimeout(resolve,0));
appearance.refresh(); renderAppearancePicker(doc.querySelector("main")!,host,true);
const input = (value: string) => doc.querySelector<HTMLInputElement>(`input[value="${value}"]`)!;
assert.equal(doc.body.dataset.echoinkTheme,"minimal"); assert.equal(host.settings.colorTheme,"manifesto"); assert.ok(input("minimal").checked);
assert.equal(doc.querySelectorAll('[data-plugin-edition="pro"]').length,2);
input("manifesto").checked = true; input("manifesto").dispatchEvent(new first.window.Event("change",{bubbles:true}));
assert.ok(input("minimal").checked,"Keyboard/native change cannot select the retained paid preference without PRO"); assert.equal(saves,0);
input("highlighter").click(); await settle(); assert.equal(saves,0); assert.equal(host.settings.colorTheme,"manifesto"); assert.ok(input("minimal").checked);
const panel = [...doc.querySelectorAll<HTMLElement>(".echoink-appearance-pro-popover")].find(p => !p.hidden)!;
assert.ok(panel.textContent?.includes("PRO 专属，开通后可用")); panel.querySelector<HTMLAnchorElement>("a")!.click(); assert.equal(upgrades,1);
pro = true; appearance.refresh(); assert.equal(doc.body.dataset.echoinkTheme,"manifesto"); assert.equal(second.window.document.body.dataset.echoinkTheme,"manifesto"); assert.ok(input("manifesto").checked); assert.equal(saves,0);
input("highlighter").click(); await settle(); assert.equal(host.settings.colorTheme,"highlighter"); assert.equal(saves,1);
for (const state of ["free","expired","signed-out","unavailable"]) {
  pro = false; if (state === "unavailable") host.accountService = null; appearance.refresh();
  assert.equal(doc.body.dataset.echoinkTheme,"minimal",state); assert.equal(second.window.document.body.dataset.echoinkTheme,"minimal",state); assert.equal(host.settings.colorTheme,"highlighter",state); assert.equal(saves,1);
  host.accountService = access; pro = true; appearance.refresh(); assert.equal(doc.body.dataset.echoinkTheme,"highlighter");
}
fail = true; input("minimal").click(); await settle(); assert.equal(host.settings.colorTheme,"highlighter"); assert.ok(input("highlighter").checked); assert.equal(input("minimal").disabled,false);
assert.equal(effectiveEchoInkColorTheme("unknown",access),"minimal"); assert.equal(effectiveEchoInkColorTheme("manifesto",null),"minimal");
renderCompanionThemeRecommendation(doc.body,true); assert.equal(doc.querySelector<HTMLAnchorElement>('[data-echoink-theme-recommendation] > a')!.href,"https://echoink.cn/theme");
doc.documentElement.style.setProperty("--echoink-companion-theme","1"); pro = false; appearance.refresh(); assert.equal(doc.body.dataset.echoinkTheme,"minimal","Installing the companion never grants PRO"); assert.equal(doc.querySelector<HTMLElement>('[data-echoink-theme-recommendation]')!.hidden,true);
appearance.dispose(); assert.equal(doc.body.hasAttribute("data-echoink-theme"),false); assert.equal(second.window.document.body.hasAttribute("data-echoink-theme"),false);
first.window.close(); second.window.close();
console.log("Appearance PRO: free/expired/logout/missing access fail closed, retained preference and automatic restoration, blocked selection, shared badges/upgrade route, save rollback, two windows, theme detection/link and unload passed.");
