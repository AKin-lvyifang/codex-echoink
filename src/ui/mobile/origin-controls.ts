/** Native buttons for the mobile build of Home dialogs. Desktop keeps React. */
const cleanups = new Map<HTMLElement, () => void>();
export function createOriginButton(parent: HTMLElement, options: { text?: string; cls?: string; attr?: Record<string, unknown> } = {}, onDispose?: () => void): HTMLButtonElement {
  const button = parent.ownerDocument.createElement("button");
  button.type = "button";
  button.dataset.slot = "button";
  button.className = `echoink-origin-control ${options.cls ?? "echoink-origin-button"}`;
  button.textContent = options.text ?? "";
  for (const [key, value] of Object.entries(options.attr ?? {})) button.setAttribute(key, String(value));
  parent.append(button);
  if (onDispose) cleanups.set(button, onDispose);
  return button;
}
export function disposeOriginControls(container: HTMLElement): void {
  for (const [button, cleanup] of cleanups) if (container.contains(button)) { cleanup(); cleanups.delete(button); }
}
