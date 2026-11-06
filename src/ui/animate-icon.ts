import { getIcon } from "obsidian";
import { ownedSvg } from "./owned-dom";
export const NAV_ANIMATE_ICON_NAMES = ["book-open", "list-todo", "wallet", "library", "languages", "file-text", "sparkles", "ellipsis"] as const;
type NavAnimateIconName = typeof NAV_ANIMATE_ICON_NAMES[number];
export type EchoInkAnimateIconName =
  | NavAnimateIconName
  | "upload"
  | "send-horizontal"
  | "circle-stop"
  | "mic"
  | "brain"
  | "users"
  | "user-round-pen";

export function isAnimateIconName(name: string): name is EchoInkAnimateIconName {
  return [...NAV_ANIMATE_ICON_NAMES, "upload", "send-horizontal", "circle-stop", "mic", "brain", "users", "user-round-pen"].includes(name);
}

/**
 * Dependency-free DOM rendering of the pinned Animate Icons lucide sources.
 * Motion is supplied by styles.css so hover, keyboard focus, and reduced-motion
 * behavior stay consistent in Obsidian's plain DOM UI.
 */
export function renderAnimateIcon(
  container: HTMLElement,
  name: EchoInkAnimateIconName
): SVGSVGElement {
  const document = container.ownerDocument;
  if ((NAV_ANIMATE_ICON_NAMES as readonly string[]).includes(name)) {
    // Keep the host's exact Lucide vector, including version-specific paths.
    // AnimateIcons variants: book-open, wallet, file-text, sparkles, ellipsis,
    // list-checks; lucide-animated: languages. library uses a custom book stagger.
    const source = getIcon(name);
    const svg = source ? document.importNode(source, true) : ownedSvg(document, "svg");
    container.classList.add("echoink-animate-icon-host", `is-${name}-icon`);
    setAttributes(svg, { "aria-hidden": "true", focusable: "false", "data-nav-icon": name });
    Array.from(svg.children).forEach((layer, index) => {
      setAttributes(layer, { "data-nav-layer": String(index), pathLength: "1" });
      // Same line/mark layers as the settings list-todo renderer, on the
      // current Lucide paths so the navigation's resting shape stays intact.
      if (name === "list-todo") layer.setAttribute("data-part", index < 3 ? "layout-line" : "layout-box");
    });
    container.append(svg);
    return svg;
  }

  container.classList.add("echoink-animate-icon-host", `is-${name}-icon`);
  const svg = ownedSvg(document, "svg");
  setAttributes(svg, {
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "2",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "aria-hidden": "true",
    focusable: "false",
    "data-animateicons-source": "lucide",
    "data-animateicons-icon": name,
    class: `echoink-animate-icon echoink-animate-icon-${name}`
  });

  if (name === "upload") {
    const group = ownedSvg(document, "g");
    group.setAttribute("class", "echoink-animate-upload-group");
    group.append(
      path(document,"M12 3v12", "echoink-animate-upload-shaft"),
      path(document,"m17 8-5-5-5 5", "echoink-animate-upload-head"),
      path(document,"M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4", "echoink-animate-upload-tray")
    );
    svg.append(group);
  } else if (name === "send-horizontal") {
    svg.append(
      path(document,
        "M3.714 3.048a.498.498 0 0 0-.683.627l2.843 7.627a2 2 0 0 1 0 1.396l-2.842 7.627a.498.498 0 0 0 .682.627l18-8.5a.5.5 0 0 0 0-.904z",
        "echoink-animate-send-horizontal-shell"
      ),
      path(document,"M6 12h16", "echoink-animate-send-horizontal-line")
    );
  } else if (name === "circle-stop") {
    svg.append(
      circle(document,"12", "12", "10", "echoink-animate-circle-stop-ring"),
      rect(document,"9", "9", "6", "6", "1", "echoink-animate-circle-stop-symbol")
    );
  } else if (name === "mic") {
    svg.append(
      path(document,"M12 19v3"),
      path(document,"M19 10v2a7 7 0 0 1-14 0v-2"),
      rect(document,"9", "2", "6", "13", "3")
    );
  } else if (name === "brain") {
    // AnimateIcons lucide/brain-icon.tsx: keep the original paths and variant groups.
    const group = ownedSvg(document, "g");
    group.setAttribute("class", "echoink-animate-brain-group");
    const brainPath = (data: string, variant: string) => {
      const element = path(document, data, `echoink-animate-brain-${variant}`);
      setAttributes(element, { pathLength: "1", "stroke-dasharray": "1", "stroke-dashoffset": "0" });
      return element;
    };
    group.append(
      brainPath("M12 18V5", "spine"),
      brainPath("M15 13a4.17 4.17 0 0 1-3-4 4.17 4.17 0 0 1-3 4", "lobe-a"),
      brainPath("M17.598 6.5A3 3 0 1 0 12 5a3 3 0 1 0-5.598 1.5", "lobe-b"),
      brainPath("M17.997 5.125a4 4 0 0 1 2.526 5.77", "lobe-a"),
      brainPath("M18 18a4 4 0 0 0 2-7.464", "lobe-b"),
      brainPath("M19.967 17.483A4 4 0 1 1 12 18a4 4 0 1 1-7.967-.517", "lobe-a"),
      brainPath("M6 18a4 4 0 0 1-2-7.464", "lobe-b"),
      brainPath("M6.003 5.125a4 4 0 0 0-2.526 5.77", "lobe-a")
    );
    for (const [data, side] of [["M8.5 11.6 10.2 10.4", "left"], ["M13.8 9.4 15.6 10.7", "right"]] as const) {
      const spark = brainPath(data, `spark-${side}`);
      setAttributes(spark, { "stroke-width": "1.4", "stroke-dashoffset": "1", opacity: "0" });
      group.append(spark);
    }
    svg.append(group);
  } else if (name === "users") {
    const primary = ownedSvg(document, "g");
    primary.setAttribute("class", "echoink-animate-users-primary");
    const primaryArc = path(document,
      "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2",
      "echoink-animate-users-primary-arc"
    );
    setAttributes(primaryArc, { "stroke-dasharray": "50", "stroke-dashoffset": "50" });
    const primaryHead = circle(document,"9", "7", "4", "echoink-animate-users-primary-head");
    primary.append(primaryArc, primaryHead);
    const secondary = ownedSvg(document, "g");
    secondary.setAttribute("class", "echoink-animate-users-secondary");
    const secondaryHead = path(document,
      "M16 3.128a4 4 0 0 1 0 7.744",
      "echoink-animate-users-secondary-head"
    );
    const secondaryArc = path(document,
      "M22 21v-2a4 4 0 0 0-3-3.87",
      "echoink-animate-users-secondary-arc"
    );
    setAttributes(secondaryHead, { "stroke-dasharray": "40", "stroke-dashoffset": "40" });
    setAttributes(secondaryArc, { "stroke-dasharray": "40", "stroke-dashoffset": "40" });
    secondary.append(secondaryHead, secondaryArc);
    svg.append(primary, secondary);
  } else {
    const person = ownedSvg(document, "g");
    person.setAttribute("class", "echoink-animate-user-round-pen-person");
    const body = path(document,"M2 21a8 8 0 0 1 10.821-7.487", "echoink-animate-user-round-pen-body");
    setAttributes(body, { "stroke-dasharray": "60", "stroke-dashoffset": "60" });
    person.append(body, circle(document,"10", "8", "5", "echoink-animate-user-round-pen-head"));
    const pen = path(document,
      "M21.378 16.626a1 1 0 0 0-3.004-3.004l-4.01 4.012a2 2 0 0 0-.506.854l-.837 2.87a.5.5 0 0 0 .62.62l2.87-.837a2 2 0 0 0 .854-.506z",
      "echoink-animate-user-round-pen-tool"
    );
    svg.append(person, pen);
  }

  container.append(svg);
  return svg;
}

function path(document: Document,data: string, className?: string): SVGPathElement {
  const element = ownedSvg(document, "path");
  element.setAttribute("d", data);
  if (className) element.setAttribute("class", className);
  return element;
}

function circle(document: Document,
  cx: string,
  cy: string,
  r: string,
  className?: string
): SVGCircleElement {
  const element = ownedSvg(document, "circle");
  setAttributes(element, { cx, cy, r });
  if (className) element.setAttribute("class", className);
  return element;
}

function rect(document: Document,
  x: string,
  y: string,
  width: string,
  height: string,
  rx: string,
  className?: string
): SVGRectElement {
  const element = ownedSvg(document, "rect");
  setAttributes(element, { x, y, width, height, rx });
  if (className) element.setAttribute("class", className);
  return element;
}

function setAttributes(element: Element, attributes: Readonly<Record<string, string>>): void {
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
}
