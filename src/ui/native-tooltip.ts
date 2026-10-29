import { ownedSvg, ownedSpan, ownedDiv } from "./owned-dom";
import { Notice, Platform, displayTooltip } from "obsidian";

export interface NativeTooltipOptions {
  readonly placement?: "top" | "bottom" | "left" | "right";
  readonly preserveLabel?: boolean;
  readonly shouldShow?: () => boolean;
  readonly touch?: "notice" | "none";
}

export interface NativeTooltipHandle {
  readonly show: () => void;
  readonly hide: () => void;
  readonly dispose: () => void;
}

const bindings = new WeakMap<Element, NativeTooltipHandle>();
const touchNotices = new WeakMap<Document, NativeTooltipHandle>();
let sequence = 0;

/** One host-rendered tooltip per element, with business names and clicks preserved. */
export function attachNativeTooltip(
  trigger: HTMLElement | SVGElement,
  content: string | (() => string),
  options: NativeTooltipOptions = {}
): NativeTooltipHandle {
  bindings.get(trigger)?.dispose();
  const doc = trigger.ownerDocument, view = doc.defaultView;
  const marker = `echoink-native-tooltip-${++sequence}`;
  const nativeOptions = { placement: options.placement ?? "top", classes: [marker] };
  const attributes = ["aria-label", "title", "aria-labelledby", "aria-describedby", "data-tooltip-class", "data-tooltip-position", "data-echoink-native-tooltip"];
  const original = new Map(attributes.map(name => [name, trigger.getAttribute(name)]));
  const ownedAttributes = new Map<string, string | null>();
  const setOwnedAttribute = (name: string, value: string | null) => {
    if (value === null) trigger.removeAttribute(name); else trigger.setAttribute(name, value);
    ownedAttributes.set(name, value);
  };
  const preserveLabel = options.preserveLabel !== false;
  const text = () => typeof content === "function" ? content() : content;
  const mobile = () => !Platform.isDesktopApp || doc.body.classList.contains("is-mobile");
  const svg = trigger.namespaceURI === "http://www.w3.org/2000/svg";
  const accessibleNode = (suffix: string) => {
    const node = svg ? ownedSvg(doc, "desc") : ownedSpan(doc);
    node.id = `${marker}-${suffix}`;
    node.setAttribute("hidden", "");
    node.setAttribute("data-echoink-tooltip-accessibility", "");
    return node;
  };
  const description = accessibleNode("description");
  const originalLabel = original.get("aria-label") || (!trigger.textContent?.trim() ? original.get("title") : null);
  const label = !preserveLabel || originalLabel && !original.get("aria-labelledby") ? accessibleNode("label") : null;
  const mount = (node: Element) => {
    if (node.parentNode) return;
    // Siblings leave with the owning UI without changing a business button's text content.
    if (trigger.parentNode) trigger.parentNode.insertBefore(node, trigger.nextSibling);
    else trigger.appendChild(node);
  };
  const updateAccessibility = (value: string) => {
    if (label) {
      label.textContent = preserveLabel ? originalLabel ?? "" : value; mount(label);
      setOwnedAttribute("aria-labelledby", label.id);
    }
    const previousDescription = original.get("aria-describedby");
    const labelText = label?.textContent ?? (original.get("aria-labelledby")?.split(/\s+/u).map(id => doc.getElementById(id)?.textContent ?? "").join(" ") || trigger.textContent || "");
    const needsDescription = preserveLabel && value && !labelText.includes(value);
    description.textContent = value;
    if (needsDescription) mount(description); else description.remove();
    const descriptionIds = [previousDescription, needsDescription ? description.id : undefined].filter(Boolean).join(" ");
    setOwnedAttribute("aria-describedby", descriptionIds || null);
    // The host delegates aria-label/title hover independently. Remove that fallback so
    // shouldShow, keyboard dismissal and our sole displayTooltip call stay authoritative.
    setOwnedAttribute("aria-label", null); setOwnedAttribute("title", null);
  };
  setOwnedAttribute("data-tooltip-class", null); setOwnedAttribute("data-tooltip-position", null);
  setOwnedAttribute("data-echoink-native-tooltip", marker);
  updateAccessibility(text());

  let active = false, focused = false, hovered = false, disposed = false;
  let observer: MutationObserver | undefined, refresh: number | undefined, notice: Notice | undefined;
  let anchor: HTMLDivElement | undefined;
  const cancelRefresh = () => { if (refresh !== undefined) view?.clearTimeout(refresh); refresh = undefined; };
  const hide = () => {
    cancelRefresh(); focused = false; hovered = false;
    doc.querySelectorAll(`.tooltip.${marker}`).forEach(node => node.remove());
    anchor?.remove(); anchor = undefined;
    const closingNotice = notice; notice = undefined;
    closingNotice?.hide();
    if (touchNotices.get(doc) === handle) touchNotices.delete(doc);
    if (!active) return;
    active = false;
    view?.removeEventListener("scroll", hide, true);
    view?.removeEventListener("resize", hide);
    view?.removeEventListener("keydown", onEscape, true);
    observer?.disconnect(); observer = undefined;
  };
  const onEscape = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    hide();
  };
  const watch = () => {
    if (active) return;
    active = true;
    view?.addEventListener("scroll", hide, true);
    view?.addEventListener("resize", hide);
    view?.addEventListener("keydown", onEscape, true);
    if (view?.MutationObserver) {
      observer = new view.MutationObserver(() => { if (!trigger.isConnected) hide(); });
      observer.observe(doc.body, { childList: true, subtree: true });
    }
  };
  const show = () => {
    if (disposed || !trigger.isConnected || options.shouldShow?.() === false) { hide(); return; }
    const value = text(); updateAccessibility(value);
    if (!value) { hide(); return; }
    if (mobile()) {
      if (options.touch !== "notice") return;
      touchNotices.get(doc)?.hide();
      const created = new Notice(value, 0);
      const nativeHide = created.hide.bind(created) as () => void;
      created.hide = () => {
        // Native notice clicks/gestures call this instance method before their fade ends.
        if (notice === created) { notice = undefined; hide(); }
        nativeHide();
      };
      notice = created; touchNotices.set(doc, handle);
    } else {
      let target: HTMLElement;
      if (svg) {
        if (!anchor) {
          anchor = ownedDiv(doc);
          anchor.setAttribute("aria-hidden", "true");
          anchor.setAttribute("data-echoink-tooltip-anchor", marker);
          // Empty and transparent, but laid out: the host requires HTMLElement.isShown().
          Object.assign(anchor.style, { position: "fixed", pointerEvents: "none", background: "transparent", border: "0", padding: "0", margin: "0", boxShadow: "none" });
          doc.body.appendChild(anchor);
        }
        const bounds = trigger.getBoundingClientRect();
        Object.assign(anchor.style, { left: `${bounds.left}px`, top: `${bounds.top}px`, width: `${Math.max(1, bounds.width)}px`, height: `${Math.max(1, bounds.height)}px` });
        target = anchor;
      } else target = trigger as HTMLElement;
      displayTooltip(target, value, nativeOptions);
    }
    watch();
  };
  const schedule = () => {
    cancelRefresh();
    refresh = view?.setTimeout(() => {
      refresh = undefined;
      if (focused || hovered) show();
    }, 0);
  };
  const enter = () => { if (!mobile()) { hovered = true; schedule(); } };
  const leave = () => { hovered = false; if (focused) schedule(); else hide(); };
  const focus = () => { if (!mobile()) { focused = true; show(); } };
  const blur = () => { focused = false; if (!hovered) hide(); };
  const click = (event: Event) => {
    if (!mobile() || options.touch !== "notice") return;
    event.preventDefault(); event.stopPropagation();
    if (notice) hide(); else show();
  };
  trigger.addEventListener("mouseenter", enter);
  trigger.addEventListener("mouseleave", leave);
  trigger.addEventListener("focus", focus);
  trigger.addEventListener("blur", blur);
  trigger.addEventListener("click", click);
  const handle: NativeTooltipHandle = {
    show, hide,
    dispose() {
      if (disposed) return;
      hide(); disposed = true;
      trigger.removeEventListener("mouseenter", enter);
      trigger.removeEventListener("mouseleave", leave);
      trigger.removeEventListener("focus", focus);
      trigger.removeEventListener("blur", blur);
      trigger.removeEventListener("click", click);
      label?.remove(); description.remove();
      for (const [name, value] of original) {
        // A caller may have updated its state/name before rebinding or disposal.
        if (!ownedAttributes.has(name) || trigger.getAttribute(name) !== ownedAttributes.get(name)) continue;
        if (value === null) trigger.removeAttribute(name); else trigger.setAttribute(name, value);
      }
      if (bindings.get(trigger) === handle) bindings.delete(trigger);
    }
  };
  bindings.set(trigger, handle);
  return handle;
}
