/**
 * Native-DOM ports of the matching Animate Icons Lucide components.
 *
 * Source: https://animateicons.in/icons/lucide
 * Local reference commit: e19861bd8e1e214105221040aefb27644fd1362f
 * License: MIT
 *
 * EchoInk does not ship React or Motion. These renderers preserve the source
 * SVG layers and expose the same independently animated parts to styles.css.
 */

const SVG_NS = "http://www.w3.org/2000/svg";

export const ANIMATED_SETTINGS_TAB_ICON_NAMES = [
  "settings",
  "key-round",
  "layout-list",
  "book-open-check",
  "clipboard-check",
  "list-todo",
  "package",
  "blocks",
  "sparkles"
] as const;

export type AnimatedSettingsTabIconName =
  typeof ANIMATED_SETTINGS_TAB_ICON_NAMES[number];

export function renderAnimatedSettingsTabIcon(
  container: HTMLElement,
  iconName: AnimatedSettingsTabIconName,
  animationElapsedMs: number | null
): void {
  container.replaceChildren();
  container.setAttr("data-animated-icon", iconName);
  container.toggleClass("is-animating", animationElapsedMs !== null);
  if (animationElapsedMs === null) {
    container.style.removeProperty("--echoink-tab-icon-delay");
  } else {
    container.style.setProperty(
      "--echoink-tab-icon-delay",
      `${-Math.max(0, Math.round(animationElapsedMs))}ms`
    );
  }

  container.appendChild(ICON_RENDERERS[iconName](container.ownerDocument));
}

const ICON_RENDERERS: Record<
  AnimatedSettingsTabIconName,
  (doc: Document) => SVGSVGElement
> = {
  settings: renderSettingsIcon,
  "key-round": renderKeyRoundIcon,
  "layout-list": renderLayoutListIcon,
  "book-open-check": renderBookOpenCheckIcon,
  "clipboard-check": renderClipboardCheckIcon,
  "list-todo": renderListTodoIcon,
  package: renderPackageIcon,
  blocks: renderBlocksIcon,
  sparkles: renderSparklesIcon
};

function renderSettingsIcon(doc: Document): SVGSVGElement {
  const svg = createIconSvg("settings", doc);
  const motion = appendSvg(svg, "g", {}, "settings-motion");
  const base = appendSvg(motion, "g", {}, "settings-base");
  appendSvg(base, "path", { d: SETTINGS_GEAR_PATH });
  appendSvg(base, "circle", { cx: 12, cy: 12, r: 3 });
  appendSvg(motion, "path", {
    d: SETTINGS_GEAR_PATH,
    pathLength: 1
  }, "settings-gear-draw");
  appendSvg(motion, "circle", {
    cx: 12,
    cy: 12,
    r: 3,
    pathLength: 1
  }, "settings-core-draw");

  [
    [12, 4.6, 0.8],
    [19, 8, 0.7],
    [18.5, 16.5, 0.7],
    [8, 18, 0.7],
    [5.5, 9, 0.7]
  ].forEach(([cx, cy, r], index) => {
    appendSvg(motion, "circle", {
      cx,
      cy,
      r,
      fill: "currentColor"
    }, "settings-spark", index);
  });
  return svg;
}

function renderKeyRoundIcon(doc: Document): SVGSVGElement {
  const svg = createIconSvg("key-round", doc);
  const motion = appendSvg(svg, "g", {}, "key-motion");
  appendSvg(motion, "path", {
    d: KEY_ROUND_PATH,
    "stroke-dasharray": 140,
    "stroke-dashoffset": 0
  }, "key-path");
  const bite = appendSvg(motion, "g", {}, "key-bite");
  appendSvg(bite, "path", { d: KEY_ROUND_BITE_PATH });
  appendSvg(motion, "circle", {
    cx: 16.5,
    cy: 7.5,
    r: 0.5,
    fill: "currentColor"
  }, "key-head");
  return svg;
}

function renderListTodoIcon(doc: Document): SVGSVGElement {
  const svg = createIconSvg("list-todo", doc);
  [6, 12, 18].forEach((y, index) => {
    appendSvg(svg, "path", { d: `M10 ${y}h11` }, "layout-line", index);
  });
  [5, 11, 17].forEach((y, index) => {
    appendSvg(svg, "path", { d: `m3 ${y + 1} 1.5 1.5L7 ${y - 1}` }, "layout-box", index);
  });
  return svg;
}

function renderLayoutListIcon(doc: Document): SVGSVGElement {
  const svg = createIconSvg("layout-list", doc);
  [3, 14].forEach((y, index) => {
    appendSvg(svg, "rect", {
      width: 7,
      height: 7,
      x: 3,
      y,
      rx: 1
    }, "layout-box", index);
  });
  [4, 9, 15, 20].forEach((y, index) => {
    appendSvg(svg, "path", { d: `M14 ${y}h7` }, "layout-line", index);
  });
  return svg;
}

function renderBookOpenCheckIcon(doc: Document): SVGSVGElement {
  const svg = createIconSvg("book-open-check", doc);
  appendSvg(svg, "path", {
    d: "M12 21V7",
    pathLength: 1
  }, "book-spine");
  appendSvg(svg, "path", {
    d: "m16 12 2 2 4-4",
    pathLength: 1
  }, "book-check");
  appendSvg(svg, "path", {
    d: "M22 6V4a1 1 0 0 0-1-1h-5a4 4 0 0 0-4 4 4 4 0 0 0-4-4H3a1 1 0 0 0-1 1v13a1 1 0 0 0 1 1h6a3 3 0 0 1 3 3 3 3 0 0 1 3-3h6a1 1 0 0 0 1-1v-1.3"
  }, "book-body");
  return svg;
}

function renderClipboardCheckIcon(doc: Document): SVGSVGElement {
  const svg = createIconSvg("clipboard-check", doc);
  appendSvg(svg, "rect", {
    width: 8,
    height: 4,
    x: 8,
    y: 2,
    rx: 1,
    ry: 1,
    "stroke-dasharray": 60,
    "stroke-dashoffset": 0
  }, "clipboard-clip");
  appendSvg(svg, "path", {
    d: "M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2",
    "stroke-dasharray": 240,
    "stroke-dashoffset": 0
  }, "clipboard-body");
  appendSvg(svg, "path", {
    d: "m9 14 2 2 4-4",
    pathLength: 1
  }, "clipboard-check");
  return svg;
}


function renderPackageIcon(doc: Document): SVGSVGElement {
  const svg = createIconSvg("package", doc);
  appendSvg(svg, "path", { d: "M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73z", pathLength: 1 }, "package-line", 0);
  appendSvg(svg, "polyline", { points: "3.29 7 12 12 20.71 7", pathLength: 1 }, "package-line", 1);
  appendSvg(svg, "path", { d: "M12 22V12", pathLength: 1 }, "package-line", 2);
  appendSvg(svg, "path", { d: "m7.5 4.27 9 5.15", pathLength: 1 }, "package-line", 2);
  return svg;
}

function renderBlocksIcon(doc: Document): SVGSVGElement {
  const svg = createIconSvg("blocks", doc);
  appendSvg(svg, "path", { d: "M10 22V7a1 1 0 0 0-1-1H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5a1 1 0 0 0-1-1H2", pathLength: 1 }, "blocks-body");
  appendSvg(svg, "rect", { x: 14, y: 2, width: 8, height: 8, rx: 1 }, "blocks-square");
  return svg;
}

function renderSparklesIcon(doc: Document): SVGSVGElement {
  const svg = createIconSvg("sparkles", doc);
  appendSvg(svg, "path", { d: "M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z" }, "sparkles-star");
  const cross = appendSvg(svg, "g", {}, "sparkles-cross");
  appendSvg(cross, "path", { d: "M20 2v4" }); appendSvg(cross, "path", { d: "M22 4h-4" });
  appendSvg(svg, "circle", { cx: 4, cy: 20, r: 2 }, "sparkles-dot");
  return svg;
}

function createIconSvg(iconName: AnimatedSettingsTabIconName, doc: Document): SVGSVGElement {
  const svg = doc.createElementNS(SVG_NS, "svg");
  setSvgAttributes(svg, {
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": 2,
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "aria-hidden": "true",
    focusable: "false",
    "data-animateicons-source": "lucide",
    "data-animateicons-icon": iconName
  });
  return svg;
}

function appendSvg<K extends keyof SVGElementTagNameMap>(
  parent: SVGElement,
  tagName: K,
  attributes: Readonly<Record<string, string | number>>,
  part?: string,
  index?: number
): SVGElementTagNameMap[K] {
  const element = parent.ownerDocument.createElementNS(SVG_NS, tagName);
  setSvgAttributes(element, attributes);
  if (part) element.setAttribute("data-part", part);
  if (index !== undefined) element.setAttribute("data-index", String(index));
  parent.appendChild(element);
  return element;
}

function setSvgAttributes(
  element: SVGElement,
  attributes: Readonly<Record<string, string | number>>
): void {
  for (const [name, value] of Object.entries(attributes)) {
    element.setAttribute(name, String(value));
  }
}

const SETTINGS_GEAR_PATH =
  "M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915";

const KEY_ROUND_PATH =
  "M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z";

const KEY_ROUND_BITE_PATH =
  "M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172";
