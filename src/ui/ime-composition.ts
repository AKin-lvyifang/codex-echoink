type ImeKeyboardEvent = Pick<KeyboardEvent, "key" | "isComposing"> & Partial<Pick<Event, "target" | "composedPath">>;
type Ending = { window: Window; timer: number };
type Tracker = { references: number; active: WeakSet<EventTarget>; ending: Map<EventTarget, Ending>; dispose(): void };
const trackers = new WeakMap<EventTarget, Tracker>();

/** Observe the owning subtree, so moving a field to another window keeps its IME state. */
export function watchImeComposition(root: HTMLElement): () => void {
  let tracker = trackers.get(root);
  if (!tracker) {
    const active = new WeakSet<EventTarget>(), ending = new Map<EventTarget, Ending>();
    const clearEnding = (target: EventTarget) => { const pending = ending.get(target); if (pending) pending.window.clearTimeout(pending.timer); ending.delete(target); };
    const start = (event: Event) => { if (event.target) { clearEnding(event.target); active.add(event.target); } };
    const end = (event: Event) => {
      const target = event.target; if (!target) return;
      active.delete(target); clearEnding(target);
      const window = root.ownerDocument.defaultView;
      if (window) ending.set(target, { window, timer: window.setTimeout(() => ending.delete(target), 0) });
    };
    const keyup = (event: Event) => { if (event.target) clearEnding(event.target); };
    const release = (event: Event) => { if (event.target) { active.delete(event.target); clearEnding(event.target); } };
    root.addEventListener("compositionstart", start, true); root.addEventListener("compositionend", end, true);
    root.addEventListener("keyup", keyup, true); root.addEventListener("blur", release, true);
    tracker = { references: 0, active, ending, dispose() {
      root.removeEventListener("compositionstart", start, true); root.removeEventListener("compositionend", end, true);
      root.removeEventListener("keyup", keyup, true); root.removeEventListener("blur", release, true);
      for (const target of ending.keys()) clearEnding(target);
    } };
    trackers.set(root, tracker);
  }
  const current = tracker; current.references++; let released = false;
  return () => { if (released) return; released = true; if (--current.references === 0) { current.dispose(); trackers.delete(root); } };
}

/** Input events are typed as Event or InputEvent depending on the DOM lib; read the flag either way. */
export function isComposingInput(event: Event): boolean {
  return "isComposing" in event && event.isComposing === true;
}

/** A composing Enter/Escape must not submit or close; composition-end's key stays in that event turn. */
export function isImeKeyEvent(event: ImeKeyboardEvent): boolean {
  if (event.isComposing || event.key === "Process" || event.key === "Unidentified") return true;
  if (!event.target) return false;
  const target = event.target;
  return (event.composedPath?.() ?? []).some(root => {
    const state = trackers.get(root);
    return state?.active.has(target) || state?.ending.has(target);
  });
}
