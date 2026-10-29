interface ParentState {
  readonly className: string;
  readonly targets: string;
  readonly relation: string;
}

// These are the plugin's parent states, rather than a general CSS selector
// polyfill. Owners can add/remove their children and native/Radix controls;
// this document binding keeps the corresponding parent class in sync.
export const CSS_PARENT_STATES: readonly ParentState[] = [
  { className: "has-echoink-checked-control", targets: ".echoink-agent-editor-preset,.echoink-agent-editor-avatar-option,.echoink-agent-editor-style-card,.echoink-generation-output-segment", relation: "[data-state=checked]" },
  { className: "has-echoink-visible-focus", targets: ".echoink-agent-editor-preset,.echoink-agent-editor-avatar-option,.echoink-agent-editor-style-card,.echoink-module-drawer-header,.echoink-generation-output-segment", relation: ":focus-visible" },
  { className: "has-echoink-host-status-bar", targets: "body", relation: ".status-bar" },
  { className: "has-echoink-dream-action", targets: ".setting-item", relation: '[data-echoink-focus-key="general:memory:dream-now"]' },
  { className: "has-echoink-message-tail", targets: ".codex-messages", relation: "> [data-message-tail]:not([hidden])" },
  { className: "has-echoink-form", targets: ".echoink-life-setting-row", relation: "form" },
  { className: "has-echoink-selected-radio", targets: ".echoink-generation-template-card", relation: '[role="radio"][data-state="checked"]' },
  { className: "has-echoink-template-edit", targets: ".echoink-generation-template-card", relation: ".echoink-generation-template-edit" },
  { className: "has-echoink-annotation", targets: ".codex-attachments", relation: ".echoink-composer-annotation-slot" },
  { className: "has-echoink-help-trigger", targets: ".setting-item-name", relation: "> .echoink-settings-help-trigger" },
  { className: "has-echoink-navigation-help", targets: ".echoink-settings-navigation-title", relation: "> .echoink-settings-help" },
  { className: "has-echoink-provider-delete", targets: ".codex-provider-modal-footer", relation: ".codex-provider-detail-delete" },
  { className: "has-echoink-search-results", targets: "[data-resource-group]", relation: ".codex-resource-row:not(.is-search-hidden)" },
  { className: "has-echoink-active-resource", targets: ".codex-resource-row", relation: ".codex-resource-row-open:is(:hover, :focus-visible)" },
  { className: "has-echoink-active-provider", targets: ".codex-provider-saved-row", relation: ".codex-provider-saved-identity:is(:hover, :focus-visible)" },
  { className: "has-echoink-checked-input", targets: ".echoink-theme-choice", relation: "> input:checked" },
  { className: "has-echoink-enabled-input", targets: ".echoink-theme-choice", relation: "> input:not(:disabled)" },
  { className: "has-echoink-focused-input", targets: ".echoink-theme-choice", relation: "> input:focus-visible" },
  { className: "has-echoink-provider-help", targets: ".codex-provider-modal-label", relation: "> .echoink-provider-form-help" },
  { className: "has-echoink-mcp-help", targets: ".codex-mcp-server-label", relation: "> .echoink-mcp-form-help" },
  { className: "has-echoink-dream-control", targets: ".setting-item", relation: '[data-echoink-focus-key="general:memory:dream"]' },
  { className: "has-echoink-profile-editor", targets: ".echoink-profile-row", relation: "> .echoink-profile-edit" },
  { className: "has-echoink-settings-switch", targets: ".setting-row", relation: "> .setting-controls > .settings-switch" },
  { className: "has-echoink-inline-confirm", targets: ".echoink-settings-compact-row", relation: "> .echoink-settings-inline-confirm" },
  { className: "has-echoink-textarea", targets: ".codex-mcp-server-field", relation: "textarea" },
  { className: "has-echoink-agent-page", targets: ".echoink-ipad-page", relation: ".pd-agent-page" },
  { className: "has-echoink-hovered-ipad-skill", targets: ".pd-cap-skill-row", relation: ".pd-cap-skill-main:hover" },
  { className: "has-echoink-hidden-ipad-back", targets: ".echoink-ipad-header", relation: "> .echoink-ipad-back[hidden]" },
  { className: "has-echoink-focused-ipad-switch", targets: ".pd-settings-row", relation: "> .pd-settings-switch:focus-visible" },
  { className: "has-echoink-ipad-legacy", targets: ".echoink-ipad-content", relation: "> .pd-settings-legacy" },
  { className: "has-echoink-root-ipad-header", targets: ".echoink-ipad-page", relation: "> .echoink-ipad-header > .echoink-ipad-back[hidden]" },
  { className: "has-echoink-ipad-agent-form", targets: ".echoink-ipad-page", relation: "> .echoink-ipad-content > .pd-agent-form" },
  { className: "has-echoink-later-iphone-skill", targets: ".ip-cap-skill-row", relation: "~ .ip-cap-skill-row" },
  { className: "has-echoink-hovered-iphone-skill", targets: ".ip-cap-skill-row", relation: ".ip-cap-skill-main:hover" },
  { className: "has-echoink-focused-iphone-skill", targets: ".ip-cap-skill-row", relation: ".ip-cap-skill-main:focus-visible" },
  { className: "has-echoink-iphone-legacy-page", targets: ".eis-page", relation: "> .eis-scroll > .eis-content > .ip-legacy" },
  { className: "has-echoink-iphone-legacy", targets: ".eis-content", relation: "> .ip-legacy" },
  { className: "has-echoink-iphone-task", targets: ".eis-page", relation: ".ip-task-detail" },
  { className: "has-echoink-later-iphone-row", targets: ".ip-settings-row", relation: "~ .ip-settings-row" },
  { className: "has-echoink-iphone-setting-name", targets: ".ip-settings-label", relation: ".ip-settings-name" },
  { className: "has-echoink-iphone-agent-form", targets: ".eis-page", relation: "> .eis-scroll > .eis-content > .ip-agent-form" },
  { className: "has-echoink-empty-running-message", targets: ".codex-virtual-row", relation: "> .codex-message-empty-running:not(.has-agent-header)" },
  { className: "has-echoink-open-combobox", targets: ".codex-provider-modal-content,.codex-provider-modal-form", relation: ".codex-provider-combobox.is-open" },
  { className: "has-echoink-direct-svg", targets: '[data-slot="button"]', relation: "> svg" },
  { className: "has-echoink-delete-button", targets: ".echoink-settings-inline-confirm,.modal.echoink-theme-boundary", relation: ".echoink-delete-button" },
  { className: "has-echoink-turn-navigation", targets: ".codex-messages-shell", relation: "> .codex-turn-nav-mount:not([hidden])" },
  { className: "has-echoink-focused-interaction", targets: ".codex-interaction-option", relation: ".codex-interaction-option-control:focus-visible" },
  { className: "has-echoink-settings-modal", targets: "body", relation: ".modal.mod-settings" },
  { className: "has-echoink-disabled-input", targets: ".echoink-theme-choice", relation: "> input:disabled" },
  { className: "has-echoink-segments", targets: ".section-heading", relation: "> .segments" },
  { className: "has-echoink-second-segment", targets: ".echoink-finance-segment", relation: "> button:nth-child(2)[aria-pressed=true]" },
];

function hasRelation(element: Element, relation: string): boolean {
  const selector = relation.trim();
  if (selector.startsWith("~") || selector.startsWith("+")) {
    for (let sibling = element.nextElementSibling; sibling; sibling = sibling.nextElementSibling) {
      if (sibling.matches(selector.slice(1).trim())) return true;
      if (selector.startsWith("+")) break;
    }
    return false;
  }
  return element.querySelector(selector.startsWith(">") ? `:scope ${selector}` : selector) !== null;
}

/** One binding per owning document; released with the plugin or its window. */
export function bindCssParentStates(doc: Document): () => void {
  const win = doc.defaultView;
  if (!win) return () => {};
  const selector = CSS_PARENT_STATES.map(state => state.targets).join(",");
  const classes = new Set(CSS_PARENT_STATES.map(state => state.className));
  const candidates = new Set<Element>();
  let frame: number | null = null, disposed = false;
  const request = (callback: () => void) => typeof win.requestAnimationFrame === "function"
    ? win.requestAnimationFrame(callback) : win.setTimeout(callback, 0);
  const cancel = (handle: number) => { if (typeof win.cancelAnimationFrame === "function") win.cancelAnimationFrame(handle); else win.clearTimeout(handle); };
  const collect = (root: Element) => {
    if (root.matches(selector)) candidates.add(root);
    root.querySelectorAll(selector).forEach(element => candidates.add(element));
  };
  const refresh = () => {
    frame = null;
    if (disposed) return;
    for (const element of candidates) {
      if (!element.isConnected) { classes.forEach(name => element.classList.remove(name)); candidates.delete(element); continue; }
      for (const state of CSS_PARENT_STATES) {
        const enabled = element.matches(state.targets) && hasRelation(element, state.relation);
        if (element.classList.contains(state.className) !== enabled) element.classList.toggle(state.className, enabled);
      }
    }
  };
  const schedule = () => { if (!disposed && frame === null) frame = request(refresh); };
  const observer = new win.MutationObserver(records => {
    let changed = false;
    for (const record of records) {
      changed = true;
      if (record.type === "childList") record.addedNodes.forEach(node => { if (node.nodeType === 1) collect(node as Element); });
      else if (record.target.nodeType === 1) collect(record.target as Element);
    }
    if (changed) schedule();
  });
  collect(doc.documentElement);
  refresh();
  observer.observe(doc.documentElement, { subtree: true, childList: true, attributes: true, attributeOldValue: true,
    attributeFilter: ["class", "hidden", "disabled", "checked", "data-state", "aria-pressed", "aria-disabled", "data-echoink-focus-key", "data-resource-group", "data-slot", "data-message-tail", "role"] });
  const events = ["focusin", "focusout", "pointerover", "pointerout", "input", "change"] as const;
  events.forEach(event => doc.addEventListener(event, schedule, true));
  const dispose = () => {
    if (disposed) return;
    disposed = true; observer.disconnect();
    if (frame !== null) cancel(frame);
    events.forEach(event => doc.removeEventListener(event, schedule, true));
    win.removeEventListener("pagehide", dispose);
    for (const element of candidates) classes.forEach(name => element.classList.remove(name));
    candidates.clear();
  };
  win.addEventListener("pagehide", dispose, { once: true });
  return dispose;
}
