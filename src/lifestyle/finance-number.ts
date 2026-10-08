import type { NumberFlowLite } from "number-flow";
import { money } from "./finance-domain";

type NumberModule = typeof import("number-flow");
const moduleKey = Symbol.for("echoink.finance.number-flow.0.2.3.module");
const tag = "echoink-finance-number-flow-v023";
const formatter = new Intl.NumberFormat("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: true });
type Watched = { observer: IntersectionObserver; callbacks: Map<Element, (visible: boolean) => void> };
const watchers = new WeakMap<Document, Watched>();
function watch(element: HTMLElement, update: (visible: boolean) => void): () => void {
  const document = element.ownerDocument; const Observer = document.defaultView?.IntersectionObserver;
  if (!Observer) { update(false); return () => {}; }
  let shared = watchers.get(document);
  if (!shared) {
    const callbacks = new Map<Element, (visible: boolean) => void>();
    shared = { callbacks, observer: new Observer(entries => entries.forEach(entry => callbacks.get(entry.target)?.(entry.isIntersecting))) };
    watchers.set(document, shared);
  }
  const current = shared; current.callbacks.set(element, update); current.observer.observe(element);
  return () => { current.observer.unobserve(element); current.callbacks.delete(element); if (!current.callbacks.size) { current.observer.disconnect(); watchers.delete(document); } };
}
function loadNumberFlow(owner: Window): Promise<NumberModule> {
  const realm = (typeof window === "undefined" ? owner : window) as unknown as Record<symbol, Promise<NumberModule>>;
  return realm[moduleKey] ??= import("number-flow").then(module => {
    const registry = (typeof window === "undefined" ? owner : window).customElements;
    if (!registry.get(tag)) registry.define(tag, module.NumberFlowLite);
    return module;
  });
}
type Mounted = { parent: HTMLElement; fallback: HTMLElement; wrapper?: HTMLElement; sign?: HTMLElement; flow?: NumberFlowLite; frame: number; stop: () => void; target: number; value: number; entrance: boolean; used: boolean; generation: number };
/** One instance per same-page metric; entering a page deliberately replays from zero. */
export class FinanceNumbers {
  private mounted = new Map<string, Mounted>();
  begin(enter = false): void {
    for (const record of this.mounted.values()) { record.used = false; this.stop(record); if (enter) { this.dropFlow(record); record.entrance = true; record.value = 0; } }
  }
  mount(parent: HTMLElement, key: string, cents: number): void {
    const final = `¥ ${money(cents)}`; parent.setAttribute("aria-label", final); parent.setAttribute("role", "img");
    const fallback = parent.createSpan({ cls: "echoink-finance-amount-static", text: final, attr: { "aria-hidden": "true" } });
    const win = parent.ownerDocument.defaultView;
    if (typeof parent.ownerDocument.createElement !== "function" || !win?.customElements) return;
    const record = this.mounted.get(key) ?? { parent, fallback, frame: 0, stop: () => {}, target: cents, value: 0, entrance: true, used: true, generation: 0 };
    this.stop(record); record.parent = parent; record.fallback = fallback; record.target = cents; record.used = true;
    const generation = ++record.generation; this.mounted.set(key, record);
    if (record.wrapper) { parent.appendChild(record.wrapper); fallback.hidden = true; }
    void loadNumberFlow(win).then(module => {
      if (!record.used || record.generation !== generation || !parent.isConnected || this.mounted.get(key) !== record) return;
      const motion = win.matchMedia("(prefers-reduced-motion: reduce)");
      let inView = false;
      const update = (visible: boolean) => {
        inView = visible;
        try {
          if (!record.used || record.generation !== generation || this.mounted.get(key) !== record) return;
          if (record.frame) win.cancelAnimationFrame(record.frame); record.frame = 0;
          if (!visible || motion.matches || typeof (win).Element.prototype.animate !== "function") {
            this.dropFlow(record); fallback.hidden = false; record.value = record.target; return;
          }
          if (!record.flow) {
            const registry = (typeof window === "undefined" ? win : window).customElements;
            const Constructor = registry.get(tag)!; const flow = new Constructor() as NumberFlowLite;
            flow.xTiming = flow.yTiming = { duration: 550, easing: "cubic-bezier(.2,.8,.2,1)" }; flow.fadeTiming = { duration: 180, easing: "ease-out" }; flow.root = true;
            const initial = record.entrance ? 0 : record.value;
            const parts = module.partitionParts(initial / 100, formatter); parts.pre = []; flow.parts = parts;
            // Copy constructed sheets once so the same metric remains styled when
            // Obsidian moves its existing leaf into a different Document.
            if (flow.shadowRoot?.adoptedStyleSheets?.length) {
              const style = flow.ownerDocument.createElement("style"); style.textContent = flow.shadowRoot.adoptedStyleSheets.flatMap(sheet => Array.from(sheet.cssRules).map(rule => rule.cssText)).join("\n");
              flow.shadowRoot.adoptedStyleSheets = []; flow.shadowRoot.appendChild(style);
            }
            const wrapper = parent.createSpan({ cls: "echoink-finance-amount", attr: { "aria-hidden": "true" } });
            wrapper.createSpan({ cls: "echoink-finance-currency", text: "¥ " }); record.sign = wrapper.createSpan({ cls: "echoink-finance-sign", text: initial < 0 ? "-" : "" }); record.sign.hidden = initial >= 0;
            wrapper.appendChild(flow); record.wrapper = wrapper; record.flow = flow; record.value = initial;
            try { (win).CSS?.registerProperty?.({ name: "--_number-flow-scale-x", syntax: "<number>", inherits: false, initialValue: "1" }); } catch { /* Already registered in this Document. */ }
          }
          fallback.hidden = true;
          const apply = () => {
            record.frame = 0; if (!record.used || record.generation !== generation || !record.flow) return;
            try {
              const parts = module.partitionParts(record.target / 100, formatter);
              record.sign!.setText(parts.pre.filter(part => part.type === "sign").map(part => part.value).join("")); parts.pre = [];
              record.sign!.hidden = !record.sign!.textContent;
              if (record.value !== record.target) { record.flow.parts = parts; record.value = record.target; }
              record.entrance = false;
            } catch { this.fallback(record); }
          };
          if (record.value === record.target && !record.entrance) return;
          // Two finite frames give the zero state one actual paint on page entry.
          record.frame = win.requestAnimationFrame(() => { record.frame = 0; if (record.entrance) record.frame = win.requestAnimationFrame(apply); else apply(); });
        } catch { this.fallback(record); }
      };
      const stopWatch = watch(parent, update);
      const reduce = () => update(inView);
      motion.addEventListener("change", reduce); record.stop = () => { stopWatch(); motion.removeEventListener("change", reduce); };
      if (motion.matches) update(false);
    }).catch(() => { if (record.generation === generation) { this.dropFlow(record); fallback.hidden = false; this.stop(record); this.mounted.delete(key); } });
  }
  private stop(record: Mounted): void {
    record.stop(); record.stop = () => {}; if (record.frame) record.parent.ownerDocument.defaultView?.cancelAnimationFrame(record.frame); record.frame = 0;
  }
  private fallback(record: Mounted): void {
    this.stop(record); this.dropFlow(record); record.fallback.hidden = false;
    record.value = record.target; record.entrance = false; record.generation++;
  }
  private dropFlow(record: Mounted): void {
    try { record.flow?.shadowRoot?.getAnimations?.().forEach(animation => { try { animation.finish(); animation.cancel(); } catch { /* Continue releasing the other animations. */ } }); } catch { /* Missing/unsupported animation inspection must preserve the amount. */ }
    record.wrapper?.remove(); record.flow = undefined; record.wrapper = undefined; record.sign = undefined;
  }
  end(): void { for (const [key, record] of this.mounted) if (!record.used) { this.stop(record); this.dropFlow(record); this.mounted.delete(key); } }
  release(): void { for (const record of this.mounted.values()) { record.used = false; this.stop(record); this.dropFlow(record); } this.mounted.clear(); }
  get activeNodes(): number { return [...this.mounted.values()].filter(record => record.used).length; }
}
