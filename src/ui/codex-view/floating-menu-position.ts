export interface FloatingRect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface FloatingSize {
  width: number;
  height: number;
}

export interface FloatingViewport {
  width: number;
  height: number;
}

export interface AnchoredMenuPosition {
  left: number;
  top: number;
  verticalSide: "above" | "below";
}

export interface SubmenuPosition {
  left: number;
  top: number;
  horizontalSide: "left" | "right";
}

const DEFAULT_GAP = 8;
const DEFAULT_PADDING = 8;

export function positionAnchoredMenu(
  anchor: FloatingRect,
  panel: FloatingSize,
  viewport: FloatingViewport,
  gap = DEFAULT_GAP,
  padding = DEFAULT_PADDING
): AnchoredMenuPosition {
  const left = clamp(anchor.right - panel.width, padding, maxPanelOrigin(viewport.width, panel.width, padding));
  const above = anchor.top - panel.height - gap;
  const below = anchor.bottom + gap;
  const canFitAbove = above >= padding;
  const canFitBelow = below + panel.height <= viewport.height - padding;
  const verticalSide = canFitAbove || !canFitBelow ? "above" : "below";
  const preferredTop = verticalSide === "above" ? above : below;
  const top = clamp(preferredTop, padding, maxPanelOrigin(viewport.height, panel.height, padding));
  return { left, top, verticalSide };
}

export function positionSubmenu(
  trigger: FloatingRect,
  parent: FloatingRect,
  panel: FloatingSize,
  viewport: FloatingViewport,
  gap = DEFAULT_GAP,
  padding = DEFAULT_PADDING
): SubmenuPosition {
  const rightOrigin = parent.right + gap;
  const leftOrigin = parent.left - panel.width - gap;
  const canFitRight = rightOrigin + panel.width <= viewport.width - padding;
  const canFitLeft = leftOrigin >= padding;
  const rightSpace = viewport.width - parent.right;
  const leftSpace = parent.left;
  const horizontalSide = canFitRight || (!canFitLeft && rightSpace >= leftSpace) ? "right" : "left";
  const preferredLeft = horizontalSide === "right" ? rightOrigin : leftOrigin;
  const left = clamp(preferredLeft, padding, maxPanelOrigin(viewport.width, panel.width, padding));
  const top = clamp(trigger.top, padding, maxPanelOrigin(viewport.height, panel.height, padding));
  return { left, top, horizontalSide };
}

function maxPanelOrigin(viewportSize: number, panelSize: number, padding: number): number {
  return Math.max(padding, viewportSize - panelSize - padding);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
