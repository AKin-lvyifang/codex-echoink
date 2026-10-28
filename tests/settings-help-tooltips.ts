import * as assert from "node:assert/strict";
import { Platform } from "obsidian";
import { attachSettingsHelpTooltip, attachSettingsTooltip, createSettingsNavigationRow } from "../src/settings/settings-v2";
import { disposeOriginControls } from "../src/settings/origin-controls";
import { displayTooltip, displayedTooltipsForTests, setTooltipDisplayForTests } from "../src/tests/obsidian-shim";

/** Exercises the production routing and activation; host tooltip lifecycle is checked in Obsidian. */
export async function runSettingsHelpTooltipTests(win: Window & typeof globalThis): Promise<void> {
  const desktop = Platform.isDesktopApp;
  const surface = win.document.body.createDiv({ cls: "echoink-settings-demo" });
  const explanation = "完整说明：资料会保存到所选目录，已有内容保持原样。";
  const unrelated = win.document.body.createDiv({ cls: "tooltip unrelated-host-tooltip", text: "宿主其他说明" });
  const nativeNodes = new Set<HTMLElement>();
  let shown: HTMLElement | undefined;
  let hostHoverTimer: number | undefined, hostHideTimer: number | undefined;
  const restoreDisplay = setTooltipDisplayForTests((element, content, options) => {
    // The public native display API cancels both delegated hover timers.
    if (hostHoverTimer !== undefined) win.clearTimeout(hostHoverTimer);
    if (hostHideTimer !== undefined) win.clearTimeout(hostHideTimer);
    hostHoverTimer = undefined; hostHideTimer = undefined;
    const marker = element.getAttribute("data-tooltip-class");
    assert.ok(marker && options?.classes?.includes(marker), "hover and focus use the same per-trigger native marker");
    shown = element.ownerDocument.body.createDiv({ cls: `tooltip ${options.classes.join(" ")}`, text: String(content) });
    shown.createDiv({ cls: "tooltip-arrow" }); nativeNodes.add(shown);
  });
  const Observer = win.MutationObserver;
  let watchers = 0;
  win.MutationObserver = class extends Observer {
    private watching = false;
    observe(target: Node, options?: MutationObserverInit): void { super.observe(target, options); if (!this.watching) { this.watching = true; watchers++; } }
    disconnect(): void { super.disconnect(); if (this.watching) { this.watching = false; watchers--; } }
  };
  const escape = (target: EventTarget = win) => {
    const event = new win.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    target.dispatchEvent(event); return event;
  };
  const released = () => {
    assert.equal(watchers, 0, "inactive help has no document observer");
    assert.equal(escape().defaultPrevented, false, "inactive help releases its global Escape listener");
    assert.equal(unrelated.isConnected, true, "cleanup never removes an unrelated host tooltip");
  };
  try {
    Platform.isDesktopApp = true;
    const wrapper = surface.createSpan({ cls: "echoink-settings-help" });
    const help = wrapper.createEl("button", { attr: { "aria-label": "资料说明" } });
    attachSettingsHelpTooltip(help, explanation, wrapper);
    assert.equal(help.getAttribute("aria-label"), explanation, "the host tooltip also gives screen readers the full explanation");
    assert.equal(help.getAttribute("data-tooltip-position"), "top");
    assert.equal(wrapper.querySelector(".echoink-settings-help-panel"), null, "desktop help creates no custom tooltip panel");
    released();
    help.focus();
    assert.equal(displayedTooltipsForTests.get(help), explanation, "keyboard focus calls the public native display API");
    assert.equal(watchers, 1, "the detach observer starts only while help is active");
    help.blur(); assert.equal(shown!.isConnected, false, "blur removes the marked native tooltip"); released();
    for (const reason of ["scroll", "resize", "Escape"]) {
      help.focus();
      assert.ok(shown!.isConnected);
      if (reason === "Escape") assert.equal(escape(help).defaultPrevented, true, "Escape closes help before the settings container");
      else surface.dispatchEvent(new win.Event(reason, { bubbles: reason === "resize" }));
      assert.equal(shown!.isConnected, false, `${reason} dismisses the native tooltip`);
      released(); help.blur();
    }
    help.focus();
    const detachedTooltip = shown!; wrapper.remove(); await Promise.resolve();
    assert.equal(detachedTooltip.isConnected, false, "removing the trigger removes its escaped native tooltip"); released();

    const hoverHelp = surface.createEl("button");
    attachSettingsHelpTooltip(hoverHelp, explanation);
    assert.notEqual(hoverHelp.getAttribute("data-tooltip-class"), help.getAttribute("data-tooltip-class"), "each help owns a unique native marker");
    const enter = () => {
      hoverHelp.dispatchEvent(new win.MouseEvent("mouseenter"));
      // Simulate Obsidian's delegated hover display using setTooltip metadata.
      displayTooltip(hoverHelp, explanation, { classes: [hoverHelp.getAttribute("data-tooltip-class")!] });
    };
    const leave = () => hoverHelp.dispatchEvent(new win.MouseEvent("mouseleave"));
    const hoverMarker = hoverHelp.getAttribute("data-tooltip-class")!;
    // The host delegates pointerout to a delayed hide; shorter fixture delays retain the ordering.
    hoverHelp.addEventListener("mouseleave", () => {
      hostHideTimer = win.setTimeout(() => {
        hostHideTimer = undefined;
        win.document.querySelectorAll(`.tooltip.${hoverMarker}`).forEach(node => node.remove());
      }, 15);
    });
    const nextTask = () => new Promise(resolve => win.setTimeout(resolve, 0));
    enter(); leave(); assert.equal(shown!.isConnected, false, "pointer leave clears the native hover tooltip"); released();
    enter(); hoverHelp.focus(); hoverHelp.blur();
    assert.equal(shown!.isConnected, true, "hover keeps help visible after keyboard blur");
    leave(); released();
    hoverHelp.focus(); enter(); leave();
    await nextTask();
    await new Promise(resolve => win.setTimeout(resolve, 20));
    assert.equal(shown!.isConnected, true, "native keyboard refresh cancels the host's delayed hover hide");
    hoverHelp.blur(); released();
    for (const reason of ["blur", "Escape", "scroll"]) {
      hoverHelp.focus(); enter(); leave();
      if (reason === "blur") hoverHelp.blur();
      else if (reason === "Escape") escape(hoverHelp);
      else surface.dispatchEvent(new win.Event("scroll"));
      await nextTask();
      assert.equal(win.document.querySelector(`.tooltip.${hoverMarker}`), null, `${reason} cancels a pending keyboard restoration`);
      released(); hoverHelp.blur();
    }

    const delayedHelp = surface.createEl("button");
    attachSettingsHelpTooltip(delayedHelp, explanation);
    const delayedMarker = delayedHelp.getAttribute("data-tooltip-class")!;
    hostHoverTimer = win.setTimeout(() => {
      hostHoverTimer = undefined;
      displayTooltip(delayedHelp, explanation, { classes: [delayedMarker] });
    }, 30);
    delayedHelp.dispatchEvent(new win.MouseEvent("mouseenter"));
    assert.equal(win.document.querySelector(`.tooltip.${delayedMarker}`), null, "the host initially leaves hover display pending");
    await nextTask();
    assert.equal(hostHoverTimer, undefined, "the helper's native display cancels the host's pending first-hover timer");
    escape(delayedHelp);
    await new Promise(resolve => win.setTimeout(resolve, 35));
    assert.equal(win.document.querySelector(`.tooltip.${delayedMarker}`), null, "dismissal before the original hover delay cannot reopen help");
    released();

    let activations = 0;
    const row = createSettingsNavigationRow(surface, { title: "已归档会话", value: "23", explanation, onActivate: () => { activations++; } });
    assert.equal(row.getAttribute("aria-label"), "已归档会话，23，进入", "binding native help never replaces the navigation name");
    const navigationHelp = row.querySelector<HTMLElement>(".echoink-settings-navigation-help")!;
    assert.equal(navigationHelp.getAttribute("role"), "button");
    assert.equal(navigationHelp.tabIndex, 0);
    assert.equal(navigationHelp.getAttribute("aria-label"), explanation);
    assert.equal(row.querySelector("button"), null, "navigation help remains a focusable span, without nested buttons");
    navigationHelp.focus();
    assert.equal(displayedTooltipsForTests.get(navigationHelp), explanation);
    navigationHelp.click();
    for (const key of ["Enter", " "]) navigationHelp.dispatchEvent(new win.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    assert.equal(activations, 0, "pointer and keyboard help never navigate");
    row.click();
    assert.equal(activations, 1, "the surrounding navigation still activates once");
    navigationHelp.blur(); released();

    const directory = surface.createEl("button");
    attachSettingsTooltip(directory, "完整目录摘要", directory, { interactive: false });
    directory.dispatchEvent(new win.MouseEvent("mouseenter"));
    assert.equal(surface.querySelector('[role="tooltip"]:not([hidden])')?.textContent, "完整目录摘要", "ordinary summary tooltips retain their existing implementation");
    directory.dispatchEvent(new win.MouseEvent("mouseleave"));

    for (const mobileClass of [false, true]) {
      Platform.isDesktopApp = mobileClass;
      win.document.body.classList.toggle("is-mobile", mobileClass);
      const mobile = surface.createEl("button", { attr: { "aria-label": "移动说明" } });
      attachSettingsHelpTooltip(mobile, explanation, mobile, { interactive: false });
      mobile.click();
      const panel = surface.querySelector<HTMLElement>('[role="tooltip"]:not([hidden])')!;
      assert.equal(panel.textContent, explanation, "mobile help still opens on tap");
      assert.equal(displayedTooltipsForTests.has(mobile), false, "mobile never calls the desktop host display API");
      mobile.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      assert.equal(panel.hidden, true);
      mobile.remove();
    }
  } finally {
    Platform.isDesktopApp = desktop;
    win.document.body.classList.remove("is-mobile");
    disposeOriginControls(surface);
    surface.remove();
    await Promise.resolve();
    if (hostHoverTimer !== undefined) win.clearTimeout(hostHoverTimer);
    if (hostHideTimer !== undefined) win.clearTimeout(hostHideTimer);
    restoreDisplay(); win.MutationObserver = Observer;
    nativeNodes.forEach(node => node.remove()); unrelated.remove();
  }
  console.log("PASS settings help: native desktop hover/focus/full explanation, scoped blur/Escape/scroll/resize/detach cleanup, lazy observers/listeners, independent navigation, retained directory summaries and mobile tap");
}
