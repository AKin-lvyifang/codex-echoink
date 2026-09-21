import type { App } from "obsidian";

/** Obsidian row shell only; Origin controls and browser DOM stay real. */
export class Setting {
  readonly settingEl: HTMLElement;
  readonly controlEl: HTMLElement;
  private readonly nameEl: HTMLElement;
  constructor(parent: HTMLElement) {
    const owner = parent.ownerDocument;
    this.settingEl = owner.createElement("div"); this.settingEl.className = "setting-item";
    this.nameEl = owner.createElement("span"); this.nameEl.className = "setting-item-info";
    this.controlEl = owner.createElement("div"); this.controlEl.className = "setting-item-control";
    this.settingEl.append(this.nameEl, this.controlEl); parent.append(this.settingEl);
  }
  setName(name: string): this { this.nameEl.textContent = name; return this; }
}

/** Browser-only host fixture. Native Obsidian acceptance remains separate. */
export class Scope {
  private readonly handlers = new Map<string, (event: KeyboardEvent) => unknown>();
  constructor(private readonly parent?: Scope) {}
  register(_modifiers: unknown, key: string, callback: (event: KeyboardEvent) => unknown) {
    this.handlers.set(key, callback);
  }
  dispatch(event: KeyboardEvent): unknown {
    const handler = this.handlers.get(event.key);
    return handler ? handler(event) : this.parent?.dispatch(event);
  }
}

/** Model the verified host order: early window capture dispatches active Scope. */
export function createOriginSelectHostFixture(ownerWindow: Window) {
  const base = new Scope();
  let current = base;
  const stack: Scope[] = [];
  let escapes = 0;
  base.register(null, "Escape", () => { escapes++; return false; });
  const keymap = {
    pushScope(scope: Scope) { stack.push(current); current = scope; },
    popScope(scope: Scope) {
      if (current === scope) current = stack.pop() ?? base;
      else { const index = stack.indexOf(scope); if (index >= 0) stack.splice(index, 1); }
    }
  };
  const onKey = (event: KeyboardEvent) => {
    if (current.dispatch(event) === false) { event.preventDefault(); event.stopPropagation(); }
  };
  ownerWindow.addEventListener("keydown", onKey, true);
  return {
    app: { keymap, scope: base } as unknown as Pick<App, "keymap" | "scope">,
    dispatch(event: KeyboardEvent) { onKey(event); },
    get depth() { return stack.length; },
    get escapes() { return escapes; },
    dispose() { ownerWindow.removeEventListener("keydown", onKey, true); }
  };
}
