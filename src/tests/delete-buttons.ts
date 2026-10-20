import assert from "node:assert/strict";
import { App } from "obsidian";
import { openTestModals } from "./obsidian-shim";
import { installProviderBrowserHost } from "./provider-discovery-dom-host";
import { applyDeleteButton } from "../settings/amicro-buttons";
import { createOriginButton, disposeOriginControls } from "../settings/origin-controls";
import { showSettingsInlineConfirmation } from "../settings/settings-v2";
import { confirmModal } from "../ui/modals";

export async function runDeleteButtonTests(): Promise<void> {
  installProviderBrowserHost();
  const root = document.body.createDiv();
  const tick = async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); };
  try {
    const text = createOriginButton(root, { text: "删除配置", cls: "mod-cta is-primary" });
    let clicks = 0; text.onclick = () => { clicks++; };
    applyDeleteButton(text); applyDeleteButton(text);
    assert.equal(text.textContent, "删除配置");
    assert.equal(text.querySelectorAll('.echoink-delete-button-icon [data-icon="trash-2"]').length, 1);
    assert.equal(text.firstElementChild?.className, "echoink-delete-button-icon");
    assert.equal(text.classList.contains("mod-cta"), false);
    text.disabled = true; text.click(); assert.equal(clicks, 0);
    text.disabled = false; text.click(); assert.equal(clicks, 1);
    const icon = createOriginButton(root, { attr: { "aria-label": "删除草稿" } });
    applyDeleteButton(icon, { iconOnly: true });
    assert.equal(icon.textContent, ""); assert.equal(icon.querySelector("svg")?.getAttribute("data-icon"), "trash-2");
    assert.equal(icon.getAttribute("aria-label"), "删除草稿");
    console.log("PASS real Origin delete presentation retains label, handler, disabled state and icon-only accessible name; repeated decoration stays single");

    const trigger = createOriginButton(root, { text: "移除" });
    let confirmed = 0, release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    showSettingsInlineConfirmation(root, trigger, { message: "移除测试配置", confirmLabel: "删除", cancelLabel: "取消", deleteAction: true, onConfirm: async () => { confirmed++; await pending; } });
    let panel = root.querySelector<HTMLElement>(".echoink-settings-inline-confirm")!;
    let buttons = [...panel.querySelectorAll<HTMLButtonElement>("button")];
    assert.equal(buttons[0].classList.contains("echoink-delete-button"), false);
    assert.equal(buttons[1].classList.contains("echoink-delete-button"), true);
    buttons[0].click(); assert.equal(confirmed, 0); assert.equal(document.activeElement, trigger);
    showSettingsInlineConfirmation(root, trigger, { message: "移除测试配置", confirmLabel: "删除", cancelLabel: "取消", deleteAction: true, onConfirm: async () => { confirmed++; await pending; } });
    panel = root.querySelector<HTMLElement>(".echoink-settings-inline-confirm")!;
    buttons = [...panel.querySelectorAll<HTMLButtonElement>("button")];
    buttons[1].click(); buttons[1].click(); assert.equal(confirmed, 1); assert.equal(trigger.disabled, true);
    release(); await tick(); assert.equal(root.querySelector(".echoink-settings-inline-confirm"), null); assert.equal(trigger.disabled, false);
    showSettingsInlineConfirmation(root, trigger, { message: "普通确认", confirmLabel: "删除", cancelLabel: "取消", onConfirm: async () => {} });
    panel = root.querySelector<HTMLElement>(".echoink-settings-inline-confirm")!;
    assert.equal(panel.querySelector(".echoink-delete-button"), null, "the label itself does not opt into deletion");
    panel.querySelector<HTMLButtonElement>("button")!.click();
    console.log("PASS real inline confirmation preserves cancellation/focus, single pending acceptance and explicit delete-only selection");

    for (const originControls of [false, true]) {
      for (const accept of [false, true]) {
        const result = confirmModal(new App(), "测试删除", "仅测试配置", "删除", "取消", { originControls, deleteAction: true });
        const modal = openTestModals.at(-1)!;
        const actions = [...modal.contentEl.querySelectorAll<HTMLButtonElement>("button")];
        assert.equal(actions[0].classList.contains("echoink-delete-button"), false);
        assert.equal(actions[1].classList.contains("echoink-delete-button"), true);
        actions[accept ? 1 : 0].click(); assert.equal(await result, accept);
      }
    }
    const aborted = new AbortController(); aborted.abort();
    assert.equal(await confirmModal(new App(), "删除", "", "删除", "取消", { signal: aborted.signal, deleteAction: true }), false);
    assert.equal(openTestModals.length, 0);
    console.log("PASS both real Modal control branches keep approve/reject and abort behavior; only the deletion acceptance is decorated");

    document.body.classList.add("is-mobile");
    const mobile = createOriginButton(root, { text: "删除", cls: "mod-cta" });
    const old = mobile.outerHTML; applyDeleteButton(mobile); assert.equal(mobile.outerHTML, old);
    const mobileResult = confirmModal(new App(), "删除", "", "删除", "取消", { deleteAction: true });
    const mobileModal = openTestModals.at(-1)!;
    assert.equal(mobileModal.contentEl.querySelector(".echoink-delete-button"), null);
    mobileModal.contentEl.querySelector<HTMLButtonElement>("button")!.click(); assert.equal(await mobileResult, false);
    document.body.classList.remove("is-mobile");
    const mobileSurface = root.createDiv({ cls: "echoink-mobile" });
    const nested = createOriginButton(mobileSurface, { text: "删除" });
    applyDeleteButton(nested); assert.equal(nested.classList.contains("echoink-delete-button"), false);
    console.log("PASS mobile body and shared mobile surface retain the old buttons, including the shared confirmation modal");
  } finally {
    document.body.classList.remove("is-mobile");
    for (const modal of [...openTestModals]) modal.close();
    disposeOriginControls(root); root.remove();
  }
}
