export interface SettingsScrollSnapshotEntry {
  element: HTMLElement;
  top: number;
  left: number;
}

export function captureSettingsScrollSnapshot(container: HTMLElement): SettingsScrollSnapshotEntry[] {
  const entries: SettingsScrollSnapshotEntry[] = [];
  const seen = new Set<HTMLElement>();

  for (let element: HTMLElement | null = container; element; element = element.parentElement) {
    if (seen.has(element)) break;
    seen.add(element);
    if (hasScrollableState(element)) entries.push({ element, top: element.scrollTop, left: element.scrollLeft });
  }

  const scrollingElement = container.ownerDocument?.scrollingElement;
  if (isHtmlElement(scrollingElement) && !seen.has(scrollingElement) && hasScrollableState(scrollingElement)) {
    entries.push({ element: scrollingElement, top: scrollingElement.scrollTop, left: scrollingElement.scrollLeft });
  }

  return entries;
}

export function restoreSettingsScrollSnapshot(snapshot: SettingsScrollSnapshotEntry[]): void {
  if (!snapshot.length) return;
  const restore = () => {
    for (const entry of snapshot) {
      entry.element.scrollTop = clampScrollOffset(entry.top, entry.element.scrollHeight - entry.element.clientHeight);
      entry.element.scrollLeft = clampScrollOffset(entry.left, entry.element.scrollWidth - entry.element.clientWidth);
    }
  };
  restore();
  if (typeof window !== "undefined") window.requestAnimationFrame?.(restore);
}

function hasScrollableState(element: HTMLElement): boolean {
  return element.scrollTop > 0
    || element.scrollLeft > 0
    || element.scrollHeight > element.clientHeight
    || element.scrollWidth > element.clientWidth;
}

function clampScrollOffset(value: number, max: number): number {
  if (!Number.isFinite(value)) return 0;
  if (!Number.isFinite(max) || max < 0) return Math.max(0, value);
  return Math.max(0, Math.min(value, max));
}

function isHtmlElement(value: Element | null | undefined): value is HTMLElement {
  return typeof HTMLElement !== "undefined" && value instanceof HTMLElement;
}
