const MOBILE_ROOT = ".echoink-mobile,.echoink-iphone,.echoink-ipad,.echoink-mobile-modal";
const TARGET = "button,summary,a[href],[role=button],[role=link],input:not([type=range]),textarea";

/** Touch feedback only; native click, focus and scrolling continue to own actions. */
export function bindMobilePressFeedback(root: HTMLElement): () => void {
  if (!root.matches(MOBILE_ROOT)) return () => {};
  const document = root.ownerDocument, win = document.defaultView!;
  const previous = root.getAttribute("data-mobile-press-root");
  root.setAttribute("data-mobile-press-root", "true");
  let current: { element: HTMLElement; pointer: number; x: number; y: number; bounds: DOMRect } | undefined;
  const finish = () => { current?.element.removeAttribute("data-mobile-pressed"); current = undefined; };
  const down = (event: PointerEvent) => {
    if (event.pointerType !== "touch" && event.pointerType !== "pen") return;
    if (event.isPrimary === false) { finish(); return; }
    const node = event.target as Element | null;
    if (!node?.closest || node.closest("[data-mobile-press-root]") !== root) return;
    if (node.closest("input,textarea")) { finish(); return; }
    const element = node.closest<HTMLElement>(TARGET);
    if (!element || !root.contains(element) || element.matches(":disabled,[aria-disabled=true]") || element.closest("[hidden],[inert]")) return;
    finish();
    current = { element, pointer: event.pointerId, x: event.clientX, y: event.clientY, bounds: element.getBoundingClientRect() };
    element.setAttribute("data-mobile-pressed", "true");
  };
  const move = (event: PointerEvent) => {
    if (!current || event.pointerId !== current.pointer) return;
    const { bounds, x, y } = current;
    if (Math.hypot(event.clientX - x, event.clientY - y) > 6 || event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) finish();
  };
  const end = (event: PointerEvent) => { if (event.pointerId === current?.pointer) finish(); };
  root.addEventListener("pointerdown", down, true);
  document.addEventListener("pointermove", move, { capture: true, passive: true });
  document.addEventListener("pointerup", end, true);
  document.addEventListener("pointercancel", end, true);
  document.addEventListener("lostpointercapture", end, true);
  document.addEventListener("scroll", finish, true);
  document.addEventListener("visibilitychange", finish);
  win.addEventListener("blur", finish);
  return () => {
    finish();
    if (previous === null) root.removeAttribute("data-mobile-press-root"); else root.setAttribute("data-mobile-press-root", previous);
    root.removeEventListener("pointerdown", down, true);
    document.removeEventListener("pointermove", move, true);
    document.removeEventListener("pointerup", end, true);
    document.removeEventListener("pointercancel", end, true);
    document.removeEventListener("lostpointercapture", end, true);
    document.removeEventListener("scroll", finish, true);
    document.removeEventListener("visibilitychange", finish);
    win.removeEventListener("blur", finish);
  };
}
