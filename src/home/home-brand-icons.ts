import { ownedSvg } from "../ui/owned-dom";
import type { HomeEntryId } from "./home-workbench-model";

export interface HomeBrandIconShape {
  tag: "circle" | "path" | "rect";
  attrs: Record<string, string>;
}

export const HOME_ENTRY_ICON_SHAPES: Record<HomeEntryId, readonly HomeBrandIconShape[]> = {
  wiki: [
    { tag: "path", attrs: { d: "M4 8.2 12 4.4l8 3.8-8 3.8z" } },
    { tag: "path", attrs: { d: "M4 12.4l8 3.8 8-3.8" } },
    { tag: "path", attrs: { d: "M4 16.6l8 3.8 8-3.8" } }
  ],
  outputs: [
    { tag: "path", attrs: { d: "M6.4 3.6h7l4.6 4.6v12.2H6.4z" } },
    { tag: "path", attrs: { d: "M13.4 3.6v4.6H18" } },
    { tag: "path", attrs: { d: "M9.4 13h6M9.4 16.6h4" } }
  ],
  projects: [
    { tag: "path", attrs: { d: "M4 6.4h2.2M4 12h2.2M4 17.6h2.2" } },
    { tag: "path", attrs: { d: "M10 6.4h10M10 12h10M10 17.6h6" } }
  ],
  inbox: [
    { tag: "rect", attrs: { x: "3.4", y: "4.2", width: "17.2", height: "4.8", rx: "1.2" } },
    { tag: "path", attrs: { d: "M5 9v9.8a1.2 1.2 0 0 0 1.2 1.2h11.6a1.2 1.2 0 0 0 1.2-1.2V9" } },
    { tag: "path", attrs: { d: "M9.8 13.4h4.4" } }
  ],
  journal: [
    { tag: "circle", attrs: { cx: "12", cy: "12", r: "8.6" } },
    { tag: "path", attrs: { d: "M12 6.8V12l3.4 2" } }
  ],
  review: [
    { tag: "path", attrs: { d: "M6 3.6h7.4l4.6 4.6v12.2H6z" } },
    { tag: "path", attrs: { d: "M13.4 3.6v4.6H18" } },
    { tag: "path", attrs: { d: "M9.4 17v-3M12 17v-6.2M14.6 17v-4.4" } }
  ]
};

/** Render the brand-manual 24px icon paths as self-contained SVG nodes. */
export function renderHomeEntryIcon(container: HTMLElement, id: HomeEntryId): SVGSVGElement {
  const svg = ownedSvg(container.ownerDocument, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.5");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  for (const shape of HOME_ENTRY_ICON_SHAPES[id]) {
    const element = ownedSvg(container.ownerDocument, shape.tag);
    for (const [name, value] of Object.entries(shape.attrs)) element.setAttribute(name, value);
    svg.appendChild(element);
  }
  container.appendChild(svg);
  return svg;
}
