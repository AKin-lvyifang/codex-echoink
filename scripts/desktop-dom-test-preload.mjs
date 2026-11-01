// Native desktop controls load with a DOM present. Match that order before
// bundled Radix modules compute their layout-effect and portal capabilities.
import { JSDOM } from "jsdom";
const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
const win = dom.window;
for (const name of ["window", "document", "navigator", "Element", "HTMLElement", "HTMLInputElement", "HTMLButtonElement", "HTMLFormElement", "Node", "NodeFilter", "Document", "DocumentFragment", "MutationObserver", "Event", "CustomEvent", "MouseEvent", "KeyboardEvent", "FocusEvent", "CompositionEvent", "SVGElement", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"]) {
  const value = name === "window" ? win : ["getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"].includes(name) ? win[name].bind(win) : win[name];
  Object.defineProperty(globalThis, name, { configurable: true, value });
}
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
process.once("beforeExit", () => win.close());
