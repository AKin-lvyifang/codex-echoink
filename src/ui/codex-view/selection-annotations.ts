import { Scope, setIcon, type App } from "obsidian";
import type { SelectionAnnotation } from "../../types/selection-annotations";
import type { SettingsLanguage } from "../../settings/settings";
import { conversationUiText } from "./ui-i18n";
const cleanups = new WeakMap<HTMLElement, () => void>();
const activePopovers = new WeakMap<Document, () => void>();
export interface AnnotationSummaryActions {
  onSource(annotation: SelectionAnnotation): void;
  onEdit?(id: string): void;
  onRemove?(id: string): void;
  onRemoveAll?(): void;
}
export function renderSelectionAnnotationSummary(host: HTMLElement, annotations: readonly SelectionAnnotation[], language: SettingsLanguage, actions: AnnotationSummaryActions, app?: Pick<App, "keymap" | "scope">): void {
  cleanups.get(host)?.();
  if (!annotations.length) return;
  let doc = host.ownerDocument, win = doc.defaultView!;
  const wrapper = doc.createElement("div"); wrapper.className = "echoink-annotation-summary"; host.append(wrapper);
  const trigger = doc.createElement("button"); trigger.type = "button"; trigger.className = "echoink-annotation-trigger";
  trigger.textContent = conversationUiText(language, `${annotations.length}条注释`, `${annotations.length} annotation${annotations.length === 1 ? "" : "s"}`);
  trigger.setAttribute("aria-expanded", "false"); trigger.setAttribute("aria-haspopup", "dialog"); wrapper.append(trigger);
  const panel = doc.createElement("div"); panel.className = "echoink-annotation-popover"; panel.hidden = true;
  panel.setAttribute("role", "dialog"); panel.setAttribute("aria-label", conversationUiText(language, "引用片段", "Selected passages"));
  for (const annotation of annotations) {
    const card = doc.createElement("div"); card.className = "echoink-annotation-card"; panel.append(card);
    const header = doc.createElement("div"); header.className = "echoink-annotation-card-header"; card.append(header);
    const number = doc.createElement("span"); number.className = "echoink-annotation-number"; number.textContent = String(annotation.number); header.append(number);
    const source = doc.createElement("button"); source.type = "button"; source.className = "echoink-annotation-source"; source.textContent = annotation.fileName;
    source.title = annotation.vaultRelativePath; source.onclick = () => actions.onSource(annotation); header.append(source);
    const controls = doc.createElement("span"); controls.className = "echoink-annotation-actions"; header.append(controls);
    const button = (icon: string, zh: string, en: string, run: () => void) => {
      const element = doc.createElement("button"); element.type = "button"; element.setAttribute("aria-label", conversationUiText(language, zh, en));
      setIcon(element, icon); element.onclick = run; controls.append(element);
    };
    if (actions.onEdit) button("pencil", "编辑问题", "Edit question", () => actions.onEdit!(annotation.id));
    if (actions.onRemove) button("x", "移除注释", "Remove annotation", () => actions.onRemove!(annotation.id));
    if (annotation.anchor.invalid || annotation.anchor.unresolved) { const hint = doc.createElement("div"); hint.className = "echoink-annotation-invalid"; hint.textContent = conversationUiText(language, "原文位置已变化", "The source position has changed"); card.append(hint); }
    const text = doc.createElement("div"); text.className = "echoink-annotation-text"; text.textContent = annotation.selectedText; card.append(text);
  }
  if (actions.onRemoveAll) {
    const remove = doc.createElement("button"); remove.type = "button"; remove.className = "echoink-annotation-remove-all";
    remove.textContent = conversationUiText(language, "移除全部", "Remove all"); remove.onclick = () => actions.onRemoveAll?.(); panel.append(remove);
  }
  let timer: number | undefined, timerWindow: typeof win | undefined, observer: MutationObserver | undefined, suppressed = false;
  let openDocument: Document | null = null, openWindow: typeof win | null = null, escapeScope: Scope | null = null;
  const activateEscapeScope = () => {
    if (escapeScope || !app?.keymap || !openDocument?.hasFocus() || panel.hidden) return;
    escapeScope = new Scope(app.scope);
    escapeScope.register(null, "Escape", (event) => {
      if (event.isComposing || panel.hidden || (event.target as Node | null)?.ownerDocument !== openDocument) return;
      closeOnEscape(event);
      return false;
    });
    app.keymap.pushScope(escapeScope);
  };
  const cancel = () => { if (timer !== undefined) timerWindow?.clearTimeout(timer); timer = undefined; timerWindow = undefined; };
  const position = () => {
    if (openDocument && trigger.ownerDocument !== openDocument) { close(); return; }
    const rect = trigger.getBoundingClientRect();
    const width = Math.max(0, Math.min(360, win.innerWidth - 16));
    const above = Math.max(0, rect.top - 16), below = Math.max(0, win.innerHeight - rect.bottom - 16);
    const useAbove = above >= Math.min(240, below);
    const available = Math.max(0, useAbove ? above : below);
    panel.style.width = `${width}px`; panel.style.maxHeight = `${available}px`;
    panel.style.setProperty("--echoink-annotation-available-height", `${Math.max(0, available - 12)}px`);
    panel.style.left = `${Math.max(8, Math.min(rect.left, win.innerWidth - width - 8))}px`;
    panel.style.top = `${useAbove ? Math.max(8, rect.top - panel.getBoundingClientRect().height - 6) : rect.bottom + 6}px`;
  };
  const within = (node: Node | null) => Boolean(node && (wrapper.contains(node) || panel.contains(node)));
  const close = () => {
    cancel();
    if (!openDocument) return;
    panel.hidden = true; trigger.setAttribute("aria-expanded", "false");
    openWindow?.removeEventListener("resize", position); openDocument?.removeEventListener("scroll", position, true); openDocument?.removeEventListener("keydown", closeOnEscape, true);
    openWindow?.removeEventListener("focus", activateEscapeScope);
    // popScope uses the window recorded by pushScope, even if focus moved.
    if (escapeScope) app?.keymap.popScope(escapeScope); escapeScope = null;
    if (openDocument && activePopovers.get(openDocument) === close) activePopovers.delete(openDocument);
    observer?.disconnect(); observer = undefined; openDocument = null; openWindow = null; panel.remove();
  };
  const open = () => {
    const owner = trigger.ownerDocument;
    if (owner !== doc) { close(); doc = owner; win = doc.defaultView!; suppressed = false; }
    cancel(); if (suppressed) return;
    if (!panel.hidden) { activateEscapeScope(); return; }
    const previous = activePopovers.get(doc); if (previous && previous !== close) previous();
    const style = win.getComputedStyle(trigger);
    for (const name of ["--background-primary", "--background-modifier-border", "--background-modifier-hover", "--text-normal", "--text-muted", "--text-accent", "--font-ui-smaller", "--echoink-conversation-radius-sm", "--echoink-conversation-radius-md"]) { const value = style.getPropertyValue(name); if (value) panel.style.setProperty(name, value); }
    panel.style.fontFamily = style.fontFamily; panel.style.fontSize = style.fontSize;
    openDocument = doc; openWindow = win;
    activePopovers.set(doc, close);
    doc.body.append(panel); panel.hidden = false; trigger.setAttribute("aria-expanded", "true"); position();
    win.addEventListener("resize", position); doc.addEventListener("scroll", position, true);
    doc.addEventListener("keydown", closeOnEscape, true);
    // Relayed keys target main window directly; later capture listeners cannot
    // precede its Workspace listener. Consume Escape in the first keymap Scope.
    win.addEventListener("focus", activateEscapeScope); activateEscapeScope();
    const observedDocument = doc;
    observer = new win.MutationObserver(() => { if (openDocument === observedDocument && (!wrapper.isConnected || trigger.ownerDocument !== observedDocument)) close(); }); observer.observe(doc.body, { childList: true, subtree: true });
  };
  const deferClose = () => { cancel(); timerWindow = win; const scheduledDocument = doc; timer = win.setTimeout(() => { if (openDocument === scheduledDocument && (!within(doc.activeElement) || !(doc.activeElement as Element)?.matches(":focus-visible"))) close(); }, 120); };
  wrapper.addEventListener("mouseenter", () => { suppressed = false; open(); });
  wrapper.addEventListener("mouseleave", deferClose);
  wrapper.addEventListener("focusin", open);
  panel.addEventListener("mouseenter", () => { cancel(); open(); }); panel.addEventListener("mouseleave", deferClose); panel.addEventListener("focusin", open);
  const focusout = (event: FocusEvent) => { if (!within(event.relatedTarget as Node | null)) { suppressed = false; close(); } };
  wrapper.addEventListener("focusout", focusout); panel.addEventListener("focusout", focusout);
  const closeOnEscape = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || event.isComposing || panel.hidden || event.defaultPrevented) return;
    event.preventDefault(); event.stopPropagation(); suppressed = true; trigger.focus({ preventScroll: true }); close();
  };
  const navigate = (event: KeyboardEvent) => {
    if (event.key === "Tab" && !panel.hidden) {
      const buttons = Array.from(panel.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
      if (event.target === trigger && !event.shiftKey) { event.preventDefault(); buttons[0]?.focus(); }
      else if (event.target === buttons[0] && event.shiftKey) { event.preventDefault(); trigger.focus(); }
      else if (event.target === buttons.at(-1) && !event.shiftKey) { event.preventDefault(); suppressed = true; trigger.focus({ preventScroll: true }); close(); }
    }
  };
  wrapper.addEventListener("keydown", navigate); panel.addEventListener("keydown", navigate);
  cleanups.set(host, close);
}
