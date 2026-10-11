/** Mark only the DOM menu created by this synchronous public Menu.show call.
 * Native OS menus have no DOM/CSS to isolate. Existing host/plugin menus are
 * left untouched; no global observer or private Menu fields are needed. */
export function showEchoInkMenu(owner: Document, show: () => unknown): void {
  const existing = new Set(Array.from(owner.querySelectorAll(".menu")));
  show();
  for (const element of Array.from(owner.querySelectorAll(".menu"))) {
    if (!existing.has(element)) element.classList.add("echoink-theme-boundary");
  }
}
