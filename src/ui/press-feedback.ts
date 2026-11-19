/** Press feedback only. Native click/keyboard activation keeps owning actions. */
export function bindPressFeedback(root: HTMLElement): () => void {
  if (root.ownerDocument.body.classList.contains("is-mobile") || root.closest(".echoink-mobile,.echoink-mobile-modal")) return () => {};
  const previousScope = root.getAttribute("data-echoink-press-scope");
  root.setAttribute("data-echoink-press-scope", "true");
  let current: { element: HTMLElement; previous: string | null; pointer?: number; key?: string } | null = null;
  let releaseListeners: (() => void)[] = [];
  const show = (visible: boolean) => {
    if (!current) return;
    if (visible) current.element.setAttribute("data-echoink-pressed", "true");
    else if (current.previous === null) current.element.removeAttribute("data-echoink-pressed");
    else current.element.setAttribute("data-echoink-pressed", current.previous);
  };
  const finish = () => { show(false); current = null; for (const release of releaseListeners) release(); releaseListeners = []; };
  const inside = (element: HTMLElement, target: EventTarget | null) => !!target && typeof (target as Node).nodeType === "number" && element.contains(target as Node);
  const targetFor = (event: Event) => {
    const node = event.target as Node | null;
    const element = node?.nodeType === 1 ? node as Element : node?.parentElement;
    const target = element?.closest<HTMLElement>("button,[role=button],summary,a[href],[role=option],[role=menuitem]");
    // Existing Amicro press motion and the drag stage retain their own feedback.
    return target && root.contains(target) && target.dataset.echoinkPressed !== "true"
      && !target.matches(":disabled,[aria-disabled=true],.echoink-amicro-button,.wb-weather-stage") ? target : null;
  };
  const pointerDown = (event: PointerEvent) => {
    if (event.button !== 0 || event.isPrimary === false) return;
    const element = targetFor(event); if (!element) return;
    finish(); current = { element, previous: element.getAttribute("data-echoink-pressed"), pointer: event.pointerId }; show(true);
    const document = element.ownerDocument, win = document.defaultView;
    const end = (next: PointerEvent) => { if (next.pointerId === current?.pointer) finish(); };
    const over = (next: PointerEvent) => { if (current?.pointer === next.pointerId) show(inside(current.element, next.target)); };
    const out = (next: PointerEvent) => { if (current?.pointer === next.pointerId) show(inside(current.element, next.relatedTarget)); };
    document.addEventListener("pointerup", end, true); document.addEventListener("pointercancel", end, true);
    document.addEventListener("lostpointercapture", end, true); document.addEventListener("pointerover", over, true); document.addEventListener("pointerout", out, true);
    win?.addEventListener("blur", finish);
    releaseListeners = [() => {
      document.removeEventListener("pointerup", end, true); document.removeEventListener("pointercancel", end, true);
      document.removeEventListener("lostpointercapture", end, true); document.removeEventListener("pointerover", over, true); document.removeEventListener("pointerout", out, true);
      win?.removeEventListener("blur", finish);
    }];
  };
  const keyDown = (event: KeyboardEvent) => {
    if (event.repeat || event.isComposing || ![" ", "Enter"].includes(event.key)) return;
    const element = targetFor(event); if (!element) return;
    finish(); current = { element, previous: element.getAttribute("data-echoink-pressed"), key: event.key }; show(true);
    const document = element.ownerDocument, win = document.defaultView;
    const up = (next: KeyboardEvent) => { if (next.key === current?.key) finish(); };
    document.addEventListener("keyup", up, true); win?.addEventListener("blur", finish);
    releaseListeners = [() => { document.removeEventListener("keyup", up, true); win?.removeEventListener("blur", finish); }];
  };
  root.addEventListener("pointerdown", pointerDown, true); root.addEventListener("keydown", keyDown, true);
  return () => { if (previousScope === null) root.removeAttribute("data-echoink-press-scope"); else root.setAttribute("data-echoink-press-scope", previousScope); finish(); root.removeEventListener("pointerdown", pointerDown, true); root.removeEventListener("keydown", keyDown, true); };
}
