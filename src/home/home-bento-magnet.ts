/** Subtle pointer attraction for the native home cards, independent of their inner motion. */
export function bindHomeBentoMagnet(root: HTMLElement): () => void {
  const win = root.ownerDocument.defaultView;
  if (!win) return () => {};
  const media = win.matchMedia("(hover: hover) and (pointer: fine) and (prefers-reduced-motion: no-preference)");
  let active: HTMLElement | null = null;
  let frame: number | null = null;
  let pointerX = 0;
  let pointerY = 0;

  const reset = () => {
    if (frame !== null) win.cancelAnimationFrame(frame);
    frame = null;
    active?.classList.remove("is-magnetized");
    active?.style.removeProperty("--bento-magnet-x");
    active?.style.removeProperty("--bento-magnet-y");
    active = null;
  };
  const update = () => {
    frame = null;
    if (!active?.isConnected || !media.matches) { reset(); return; }
    const rect = active.getBoundingClientRect();
    if (!rect.width || !rect.height) { reset(); return; }
    // Subtract the interpolated translation so the card never chases its own moving center.
    const translation = win.getComputedStyle(active).translate.split(/\s+/u);
    const centerX = rect.left - (parseFloat(translation[0]) || 0) + rect.width / 2;
    const centerY = rect.top - (parseFloat(translation[1]) || 0) + rect.height / 2;
    const clamp = (value: number) => Math.max(-1, Math.min(1, value));
    active.style.setProperty("--bento-magnet-x", `${(clamp((pointerX - centerX) / (rect.width / 2)) * 6).toFixed(2)}px`);
    active.style.setProperty("--bento-magnet-y", `${(clamp((pointerY - centerY) / (rect.height / 2)) * 4).toFixed(2)}px`);
    active.classList.add("is-magnetized");
  };
  const move = (event: PointerEvent) => {
    if (!media.matches || event.pointerType !== "mouse" || event.buttons !== 0) { reset(); return; }
    const card = (event.target as Element | null)?.closest<HTMLElement>("button.bento");
    if (!card || !root.contains(card) || card.matches(":disabled, .echoink-module-hidden")) { reset(); return; }
    if (card !== active) { reset(); active = card; }
    pointerX = event.clientX;
    pointerY = event.clientY;
    if (frame === null) frame = win.requestAnimationFrame(update);
  };

  root.addEventListener("pointermove", move);
  root.addEventListener("pointerleave", reset);
  root.addEventListener("pointercancel", reset);
  root.addEventListener("keydown", reset);
  // The owner window also covers Obsidian pop-out windows and scrolling ancestors.
  win.addEventListener("scroll", reset, true);
  win.addEventListener("resize", reset);
  win.addEventListener("blur", reset);
  media.addEventListener("change", reset);
  return () => {
    reset();
    root.removeEventListener("pointermove", move);
    root.removeEventListener("pointerleave", reset);
    root.removeEventListener("pointercancel", reset);
    root.removeEventListener("keydown", reset);
    win.removeEventListener("scroll", reset, true);
    win.removeEventListener("resize", reset);
    win.removeEventListener("blur", reset);
    media.removeEventListener("change", reset);
  };
}
