import * as assert from "node:assert/strict";
import { Platform } from "obsidian";
import { attachNativeTooltip } from "../src/ui/native-tooltip";
import { attachSettingsHelpTooltip, attachSettingsTooltip, createSettingsNavigationRow } from "../src/settings/settings-v2";
import { disposeOriginControls } from "../src/settings/origin-controls";
import { displayedTooltipsForTests, openTestNotices, setTooltipDisplayForTests } from "../src/tests/obsidian-shim";

function name(element: Element): string {
  const references = element.getAttribute("aria-labelledby");
  return references ? references.split(/\s+/u).map(id => element.ownerDocument.getElementById(id)?.textContent ?? "").join(" ")
    : element.getAttribute("aria-label") ?? element.textContent ?? "";
}

/** Public native API calls are injected; real host appearance remains a separate acceptance step. */
export async function runSettingsHelpTooltipTests(win: Window & typeof globalThis): Promise<void> {
  const desktop = Platform.isDesktopApp, wasMobile = win.document.body.classList.contains("is-mobile");
  const surface = win.document.body.createDiv({ cls: "echoink-settings-demo" });
  const explanation = "完整说明：资料会保存到所选目录，已有内容保持原样。";
  const unrelated = win.document.body.createDiv({ cls: "tooltip unrelated-host-tooltip", text: "宿主其他说明" });
  const prepareNativeHtml = (owner: Window & typeof globalThis) => {
    if (!owner.HTMLElement.prototype.isShown) owner.HTMLElement.prototype.isShown = function () { return this.isConnected; };
  };
  prepareNativeHtml(win);
  let shown: HTMLElement | undefined, calls = 0, hostHide: number | undefined;
  let nativeTarget: HTMLElement | undefined;
  const nativeNodes = new Set<HTMLElement>();
  const restoreDisplay = setTooltipDisplayForTests((element, content, options) => {
    assert.equal(typeof element.isShown, "function", "the native host requires an HTML target with isShown()");
    assert.equal(element.isShown(), true);
    nativeTarget = element;
    if (hostHide !== undefined) win.clearTimeout(hostHide); hostHide = undefined;
    assert.ok(options?.classes?.[0]?.startsWith("echoink-native-tooltip-"));
    for (const node of nativeNodes) if (node.ownerDocument === element.ownerDocument) node.remove();
    shown = element.ownerDocument.createElement("div"); shown.className = `tooltip ${options.classes.join(" ")}`;
    shown.textContent = String(content); element.ownerDocument.body.appendChild(shown);
    const arrow = element.ownerDocument.createElement("div"); arrow.className = "tooltip-arrow"; shown.appendChild(arrow);
    nativeNodes.add(shown); calls++;
  });
  const Observer = win.MutationObserver; let watchers = 0;
  win.MutationObserver = class extends Observer {
    private watching = false;
    observe(target: Node, options?: MutationObserverInit): void { super.observe(target, options); if (!this.watching) { this.watching = true; watchers++; } }
    disconnect(): void { super.disconnect(); if (this.watching) { this.watching = false; watchers--; } }
  };
  const tick = () => new Promise(resolve => win.setTimeout(resolve, 0));
  const enter = (element: Element) => element.dispatchEvent(new win.MouseEvent("mouseenter"));
  const leave = (element: Element) => element.dispatchEvent(new win.MouseEvent("mouseleave"));
  const escape = (target: EventTarget = win) => {
    const event = new win.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    target.dispatchEvent(event); return event;
  };
  const released = () => {
    assert.equal(watchers, 0, "inactive tooltips keep no document observers");
    assert.equal(escape().defaultPrevented, false, "inactive tooltips release global keyboard handling");
    assert.ok(unrelated.isConnected, "cleanup preserves unrelated host tooltips");
  };
  try {
    Platform.isDesktopApp = true; win.document.body.classList.remove("is-mobile");
    const help = surface.createEl("button", { attr: { "aria-label": "资料说明" } });
    attachSettingsHelpTooltip(help, explanation);
    assert.equal(name(help), explanation, "pure help exposes the full explanation to screen readers");
    assert.equal(help.hasAttribute("aria-label"), false, "the host has no delegated aria-label fallback");
    assert.equal(surface.querySelector(".echoink-settings-help-panel"), null, "no custom tooltip panel exists");
    released(); help.focus();
    assert.equal(displayedTooltipsForTests.get(help), explanation);
    assert.equal(watchers, 1); help.blur(); assert.equal(shown!.isConnected, false); released();
    for (const reason of ["scroll", "resize", "Escape"]) {
      help.focus();
      if (reason === "Escape") assert.equal(escape(help).defaultPrevented, false, "Escape remains available to the business control and host");
      else surface.dispatchEvent(new win.Event(reason, { bubbles: reason === "resize" }));
      assert.equal(shown!.isConnected, false, `${reason} removes only the owned native node`);
      released(); help.blur();
    }
    help.focus(); const detached = shown!; help.remove(); await Promise.resolve();
    assert.equal(detached.isConnected, false); released();

    const hover = surface.createEl("button"); const hoverHandle = attachNativeTooltip(hover, explanation);
    enter(hover); leave(hover); await tick();
    assert.equal(displayedTooltipsForTests.has(hover), false, "leaving before the deferred show cancels it"); released();
    enter(hover); await tick(); hover.focus(); hover.blur();
    assert.ok(shown!.isConnected, "hover retains help after focus leaves"); leave(hover); released();
    hover.focus(); enter(hover); leave(hover); const hoverNode = shown!;
    hostHide = win.setTimeout(() => hoverNode.remove(), 15);
    await tick(); await new Promise(resolve => win.setTimeout(resolve, 20));
    assert.ok(shown!.isConnected, "keyboard refresh cancels the host's delayed pointerout hide");
    hover.blur(); released();
    enter(hover); await tick(); escape(hover); await new Promise(resolve => win.setTimeout(resolve, 20));
    assert.equal(shown!.isConnected, false, "dismissed hover cannot reopen from a host aria-label timer");
    assert.equal(hover.hasAttribute("aria-label"), false); released(); hoverHandle.dispose();

    const business = surface.createEl("button", { text: "打开目录", attr: { "aria-label": "打开资料目录", title: "原生备用说明" } });
    let activations = 0, enabled = false; business.onclick = () => { activations++; };
    const businessHandle = attachNativeTooltip(business, "完整目录摘要", { shouldShow: () => enabled });
    assert.equal(name(business), "打开资料目录", "a business control keeps its original accessible name");
    assert.equal(business.hasAttribute("aria-label"), false); assert.equal(business.hasAttribute("title"), false);
    const beforeFalse = calls; business.focus(); enter(business); await tick();
    assert.equal(calls, beforeFalse, "shouldShow=false prevents every native display path");
    business.click(); assert.equal(activations, 1, "reading help never replaces a business click");
    enabled = true; businessHandle.show(); assert.equal(shown!.textContent, "完整目录摘要");
    let businessEscapes = 0;
    business.onkeydown = event => { if (event.key === "Escape") businessEscapes++; };
    escape(business);
    assert.equal(businessEscapes, 1, "a visible tooltip cannot intercept a control's existing Escape action");
    assert.equal(shown!.isConnected, false);
    businessHandle.hide(); business.blur(); released();
    const oldDescription = business.getAttribute("aria-describedby")!;
    const replacement = attachNativeTooltip(business, "新的摘要"); const beforeReplacement = calls;
    assert.equal(win.document.getElementById(oldDescription), null, "rebinding removes old accessibility nodes");
    business.focus(); assert.equal(calls, beforeReplacement + 1, "rebinding leaves only one focus handler");
    businessHandle.show(); assert.equal(calls, beforeReplacement + 1, "disposed handles cannot reopen old content");
    replacement.dispose(); assert.equal(business.getAttribute("aria-label"), "打开资料目录");
    assert.equal(business.getAttribute("title"), "原生备用说明"); business.blur(); released();
    const firstState = attachNativeTooltip(business, "当前状态说明");
    business.setAttribute("aria-label", "打开新的资料目录");
    const nextState = attachNativeTooltip(business, "新状态说明");
    assert.equal(name(business), "打开新的资料目录", "rebinding retains a caller's freshly updated business name");
    firstState.dispose();
    business.setAttribute("aria-label", "再一次更新的目录名");
    nextState.dispose();
    assert.equal(business.getAttribute("aria-label"), "再一次更新的目录名", "disposal cannot overwrite a later caller attribute change");

    const svg = win.document.createElementNS("http://www.w3.org/2000/svg", "svg");
    const point = win.document.createElementNS("http://www.w3.org/2000/svg", "circle");
    svg.appendChild(point); surface.appendChild(svg); point.setAttribute("aria-label", "账目数据点");
    Object.defineProperty(point, "getBoundingClientRect", { configurable: true, value: () => ({ left: 35, top: 48, width: 62, height: 74 }) });
    let value = "收入 10"; const chart = attachNativeTooltip(point, () => value);
    chart.show(); value = "收入 20"; chart.show();
    assert.equal(shown!.textContent, "收入 20", "SVG chart content is evaluated when shown");
    const svgAnchor = nativeTarget!;
    assert.equal(svgAnchor instanceof win.HTMLElement, true, "SVG uses a host-compatible HTML positioning anchor");
    assert.notEqual(svgAnchor, point); assert.equal(svgAnchor.ownerDocument, point.ownerDocument);
    assert.equal(svgAnchor.style.left, "35px"); assert.equal(svgAnchor.style.top, "48px");
    assert.equal(svgAnchor.style.width, "62px"); assert.equal(svgAnchor.style.height, "74px");
    assert.equal(svgAnchor.getAttribute("aria-hidden"), "true"); assert.equal(svgAnchor.style.pointerEvents, "none");
    assert.equal(svgAnchor.textContent, ""); assert.notEqual(svgAnchor.style.opacity, "0");
    assert.equal(name(point), "账目数据点"); chart.hide(); assert.equal(svgAnchor.isConnected, false);
    chart.show(); const secondAnchor = nativeTarget!; chart.dispose(); assert.equal(secondAnchor.isConnected, false); released();

    const frame = surface.createEl("iframe"); const other = frame.contentDocument!;
    prepareNativeHtml(other.defaultView as Window & typeof globalThis);
    const otherTrigger = other.createElement("button"); otherTrigger.setAttribute("aria-label", "独立窗口动作"); other.body.appendChild(otherTrigger);
    const otherHandle = attachNativeTooltip(otherTrigger, "独立窗口说明"); otherHandle.show();
    assert.equal(shown!.ownerDocument, other, "native display belongs to the trigger's document");
    otherHandle.dispose(); assert.equal(shown!.isConnected, false); released();

    const row = createSettingsNavigationRow(surface, { title: "已归档会话", value: "长摘要", valueDescription: "完整长摘要", explanation, onActivate: () => { activations++; } });
    assert.equal(name(row), "已归档会话，完整长摘要，进入");
    enter(row); await tick(); assert.equal(shown!.textContent, "完整长摘要");
    const navigationHelp = row.querySelector<HTMLElement>(".echoink-settings-navigation-help")!;
    assert.equal(navigationHelp.tabIndex, 0); assert.equal(row.querySelector("button"), null);
    enter(navigationHelp); await tick(); navigationHelp.focus();
    assert.equal(shown!.textContent, explanation, "help takes priority over the surrounding summary");
    const beforeHelp = activations; navigationHelp.click();
    for (const key of ["Enter", " "]) navigationHelp.dispatchEvent(new win.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    assert.equal(activations, beforeHelp); row.click(); assert.equal(activations, beforeHelp + 1);
    navigationHelp.blur(); leave(navigationHelp); leave(row); released();

    const directory = surface.createEl("button", { attr: { "aria-label": "目录导航" } });
    attachSettingsTooltip(directory, "完整目录摘要", directory, { interactive: false }); directory.focus();
    assert.equal(shown!.textContent, "完整目录摘要"); assert.equal(name(directory), "目录导航");
    directory.blur(); released();

    for (const mobileClass of [false, true]) {
      Platform.isDesktopApp = mobileClass; win.document.body.classList.toggle("is-mobile", mobileClass);
      const mobileHelp = surface.createEl("button"); attachSettingsHelpTooltip(mobileHelp, explanation);
      const beforeNotice = openTestNotices.length; mobileHelp.click(); const first = openTestNotices.at(-1)!;
      assert.equal(openTestNotices.length, beforeNotice + 1); assert.equal(first.message, explanation); assert.equal(first.timeout, 0);
      assert.equal(name(mobileHelp), explanation); assert.equal(first.hidden, false);
      mobileHelp.click(); assert.equal(first.hidden, true, "tapping pure help again closes its persistent native Notice"); released();
      mobileHelp.click(); const manuallyClosed = openTestNotices.at(-1)!;
      manuallyClosed.noticeEl!.click();
      assert.equal(manuallyClosed.hidden, true);
      assert.equal(manuallyClosed.noticeEl!.isConnected, true, "native Notice can remain connected during its closing animation");
      const beforeReopen = openTestNotices.length; mobileHelp.click();
      assert.equal(openTestNotices.length, beforeReopen + 1, "the first help tap after native dismissal immediately reopens a Notice");
      assert.equal(openTestNotices.at(-1)!.hidden, false); mobileHelp.click(); released();
      mobileHelp.click(); const previous = openTestNotices.at(-1)!;
      const secondHelp = surface.createEl("button"); attachSettingsHelpTooltip(secondHelp, "另一段说明"); secondHelp.click();
      assert.equal(previous.hidden, true, "new touch help closes the prior helper Notice"); secondHelp.click(); released();
      const noticesBeforeBusiness = openTestNotices.length;
      const touchBusiness = surface.createEl("button"); touchBusiness.onclick = () => { activations++; };
      const touchHandle = attachNativeTooltip(touchBusiness, "业务说明"); const beforeTouch = activations;
      touchBusiness.click(); assert.equal(activations, beforeTouch + 1); assert.equal(openTestNotices.length, noticesBeforeBusiness);
      touchHandle.dispose(); mobileHelp.remove(); secondHelp.remove();
    }
  } finally {
    Platform.isDesktopApp = desktop; win.document.body.classList.toggle("is-mobile", wasMobile);
    disposeOriginControls(surface); surface.remove(); await Promise.resolve();
    if (hostHide !== undefined) win.clearTimeout(hostHide);
    restoreDisplay(); win.MutationObserver = Observer;
    nativeNodes.forEach(node => node.remove()); unrelated.remove();
  }
  console.log("PASS native tooltips: business names/clicks, conditional display, scoped lifecycle, hover/focus timing, rebinding/disposal, SVG/dynamic content, owner document, settings help priority and native touch Notice");
}
