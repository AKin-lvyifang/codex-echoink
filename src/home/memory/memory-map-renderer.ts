import { setTooltip } from "obsidian";
import type { MemoryLayer } from "../../harness/memory/memory-relevance";
import { ownedSvg } from "../../ui/owned-dom";
import { MEMORY_MAP_DESIGN, memoryMapGeometry, memoryMapHash, memoryMapLabelFrame, memoryPolar, type MemoryPoint } from "./memory-map-geometry";
import { MEMORY_CATEGORIES, MEMORY_LAYERS, type MemoryCategory, type MemoryPageSnapshot } from "./memory-page-types";
export interface MemoryMapCallbacks {
  select(id: string): void;
  profile(): void;
  layer(layer: MemoryLayer): void;
  category(category: MemoryCategory): void;
}
export interface MemoryMapOptions {
  selectedId?: string;
  /** Omit to show all stars normally; an empty array dims every star. */
  highlightIds?: readonly string[];
  connectionIds?: readonly string[];
  showClues?: boolean;
  language?: string;
}
interface StarNode {
  group: SVGGElement;
  dot: SVGCircleElement;
  label: string;
}
/** A document-owned, repository-free projection of the current memory snapshot. */
export class MemoryMapRenderer {
  private readonly svg: SVGSVGElement;
  private readonly rings: SVGGElement;
  private readonly separators: SVGGElement;
  private readonly connections: SVGGElement;
  private readonly clues: SVGGElement;
  private readonly dots: SVGGElement;
  private readonly labels: SVGGElement;
  private readonly center: SVGGElement;
  private readonly empty: SVGTextElement;
  private readonly starNodes = new Map<string, StarNode>();
  private readonly observer?: ResizeObserver;
  private readonly addedHostClass: boolean;
  private snapshot?: MemoryPageSnapshot;
  private options: MemoryMapOptions = {};
  private size = 632;
  private plotSize = 632;
  private inset = 0;
  private disposed = false;
  constructor(private readonly host: HTMLElement, private readonly callbacks: MemoryMapCallbacks) {
    this.addedHostClass = !host.classList.contains("echoink-memory-map-host");
    host.classList.add("echoink-memory-map-host");
    this.svg = ownedSvg(host.ownerDocument, "svg");
    this.svg.setAttribute("class", "echoink-memory-map");
    this.svg.setAttribute("role", "group");
    this.rings = this.group("echoink-memory-map-rings");
    this.separators = this.group("echoink-memory-map-separators");
    this.connections = this.group("echoink-memory-map-connections");
    this.clues = this.group("echoink-memory-map-clues");
    this.dots = this.group("echoink-memory-map-stars");
    this.labels = this.group("echoink-memory-map-labels");
    this.center = this.group("echoink-memory-map-center");
    this.center.setAttribute("data-memory-action", "profile");
    this.button(this.center);
    this.circle(this.center, 27, "echoink-memory-map-center-disc");
    this.text(this.center, "", "echoink-memory-map-center-text");
    this.empty = this.text(this.svg, "", "echoink-memory-map-empty");
    this.empty.setAttribute("role", "status");
    this.svg.addEventListener("click", this.onClick);
    this.svg.addEventListener("keydown", this.onKeyDown);
    host.append(this.svg);
    const ownerWindow = host.ownerDocument.defaultView as (Window & {
      ResizeObserver?: typeof ResizeObserver;
    }) | null;
    if (ownerWindow?.ResizeObserver) {
      this.observer = new ownerWindow.ResizeObserver(entries => {
        const width = entries.find(entry => entry.target === host)?.contentRect.width;
        this.resize(width);
      });
      this.observer.observe(host);
    }
    this.resize();
  }
  update(snapshot: MemoryPageSnapshot, options: MemoryMapOptions = {}): void {
    if (this.disposed)
      return;
    this.snapshot = snapshot;
    this.options = { ...options, highlightIds: options.highlightIds?.slice(), connectionIds: options.connectionIds?.slice() };
    this.render();
  }
  dispose(): void {
    if (this.disposed)
      return;
    this.disposed = true;
    this.observer?.disconnect();
    this.svg.removeEventListener("click", this.onClick);
    this.svg.removeEventListener("keydown", this.onKeyDown);
    this.svg.remove();
    this.starNodes.clear();
    this.snapshot = undefined;
    if (this.addedHostClass)
      this.host.classList.remove("echoink-memory-map-host");
  }
  private resize(width = this.host.clientWidth): void {
    if (this.disposed)
      return;
    if (Number.isFinite(width) && width > 0)
      this.size = width;
    this.svg.setAttribute("viewBox", `0 0 ${this.size} ${this.size}`);
    this.render();
  }
  private render(): void {
    const snapshot = this.snapshot;
    if (!snapshot)
      return;
    const english = this.options.language?.startsWith("en") === true;
    const hasStars = snapshot.stars.length > 0;
    const center = this.size / 2;
    this.svg.setAttribute("aria-label", english ? "Memory map" : "记忆星图");
    this.renderLabels(english, hasStars);
    this.renderRings();
    this.center.style.display = hasStars ? "" : "none";
    this.center.style.transform = `translate(${center}px, ${center}px)`;
    const centerLabel = english ? "You" : "你";
    this.center.querySelector("text")!.textContent = centerLabel;
    this.center.setAttribute("aria-label", english ? "Your profile" : "你的画像");
    this.empty.style.display = hasStars ? "none" : "";
    this.empty.setAttribute("x", String(center));
    this.empty.setAttribute("y", String(center));
    this.empty.textContent = english ? "No memories yet" : "还没有记忆";
    const points = memoryMapGeometry(snapshot.stars, this.plotSize).map(point => ({ ...point, x: point.x + this.inset, y: point.y + this.inset }));
    const pointMap = new Map(points.map(point => [point.id, point]));
    const activeIds = new Set(points.map(point => point.id));
    for (const [id, node] of this.starNodes)
      if (!activeIds.has(id)) {
        node.group.remove();
        this.starNodes.delete(id);
      }
    const highlights = this.options.highlightIds === undefined ? undefined : new Set(this.options.highlightIds);
    for (const star of snapshot.stars) {
      const point = pointMap.get(star.id)!;
      let node = this.starNodes.get(star.id);
      if (!node) {
        const group = this.group("echoink-memory-map-star", this.dots);
        group.setAttribute("data-memory-action", "select");
        group.setAttribute("data-memory-id", star.id);
        this.button(group);
        this.circle(group, 12, "echoink-memory-map-star-hit");
        const dot = this.circle(group, point.radius, "echoink-memory-map-star-dot");
        node = { group, dot, label: "" };
        this.starNodes.set(star.id, node);
      }
      node.group.style.transform = `translate(${point.x}px, ${point.y}px)`;
      node.group.classList.toggle("is-selected", this.options.selectedId === star.id);
      node.group.classList.toggle("is-faded", star.layer === "faded");
      node.group.classList.toggle("is-dimmed", highlights !== undefined && !highlights.has(star.id));
      node.group.setAttribute("aria-pressed", String(this.options.selectedId === star.id));
      node.dot.setAttribute("r", String(point.radius));
      node.dot.style.setProperty("--memory-star-opacity", String(point.opacity));
      const category = MEMORY_CATEGORIES.find(item => item.id === star.category)!;
      const layer = MEMORY_LAYERS.find(item => item.id === star.layer)!;
      const label = `${star.title} · ${english ? category.en : category.zh} · ${english ? layer.en : layer.zh}`;
      if (label !== node.label) {
        // Obsidian's tooltip API uses the shared Element event/attribute surface.
        setTooltip(node.group as unknown as HTMLElement, label);
        node.label = label;
      }
    }
    this.renderConnections(pointMap);
    this.renderClues(pointMap);
  }
  private renderRings(): void {
    this.rings.replaceChildren();
    for (const layer of [...MEMORY_LAYERS].reverse()) {
      const circle = this.circle(this.rings, MEMORY_MAP_DESIGN[layer.id] * this.plotSize / MEMORY_MAP_DESIGN.size, `echoink-memory-map-ring is-${layer.id}`);
      circle.setAttribute("cx", String(this.size / 2));
      circle.setAttribute("cy", String(this.size / 2));
    }
  }
  private renderLabels(english: boolean, hasStars: boolean): void {
    this.labels.replaceChildren();
    this.separators.replaceChildren();
    this.plotSize = this.size;
    this.inset = 0;
    if (!hasStars)
      return;
    const categoryNodes: {
      group: SVGGElement;
      width: number;
      angle: number;
    }[] = [];
    for (const [index, category] of MEMORY_CATEGORIES.entries()) {
      const angle = -Math.PI / 2 + index * Math.PI * 2 / MEMORY_CATEGORIES.length;
      const middle = angle + Math.PI / MEMORY_CATEGORIES.length;
      const group = this.group("echoink-memory-map-label is-category", this.labels);
      group.setAttribute("data-memory-action", "category");
      group.setAttribute("data-memory-category", category.id);
      this.button(group);
      const count = this.snapshot!.stars.filter(star => star.category === category.id).length;
      const label = `${english ? category.en : category.zh} ${count}`;
      group.setAttribute("aria-label", label);
      const hit = ownedSvg(this.host.ownerDocument, "rect");
      hit.setAttribute("y", "-13");
      hit.setAttribute("height", "26");
      hit.setAttribute("rx", "6");
      group.append(hit);
      const text = this.text(group, "");
      const horizontal = Math.cos(middle);
      const anchor = Math.abs(horizontal) < 0.01 ? "middle" : horizontal < 0 ? "end" : "start";
      text.style.textAnchor = anchor;
      const name = ownedSvg(this.host.ownerDocument, "tspan");
      name.setAttribute("class", "echoink-memory-map-category-name");
      name.textContent = english ? category.en : category.zh;
      const total = ownedSvg(this.host.ownerDocument, "tspan");
      total.setAttribute("dx", "4");
      total.textContent = String(count);
      text.append(name, total);
      const width = text.getComputedTextLength();
      const left = anchor === "end" ? -width : anchor === "middle" ? -width / 2 : 0;
      hit.setAttribute("x", String(left - 6));
      hit.setAttribute("width", String(width + 12));
      categoryNodes.push({ group, width, angle: middle });
    }
    const frame = memoryMapLabelFrame(this.size, categoryNodes.map(node => node.width));
    this.plotSize = frame.plotSize;
    this.inset = frame.inset;
    for (const node of categoryNodes) {
      const position = memoryPolar(MEMORY_MAP_DESIGN.labels, node.angle, this.plotSize);
      node.group.style.transform = `translate(${position.x + this.inset}px, ${position.y + this.inset}px)`;
      const edge = memoryPolar(MEMORY_MAP_DESIGN.peripheral, node.angle - Math.PI / MEMORY_CATEGORIES.length, this.plotSize);
      this.line(this.separators, { x: this.size / 2, y: this.size / 2 }, { x: edge.x + this.inset, y: edge.y + this.inset });
    }
    const scale = this.plotSize / MEMORY_MAP_DESIGN.size;
    for (const layer of MEMORY_LAYERS) {
      const group = this.group("echoink-memory-map-label is-layer", this.labels);
      group.style.transform = `translate(${this.size / 2}px, ${this.size / 2 + MEMORY_MAP_DESIGN[layer.id] * scale - 10}px)`;
      group.setAttribute("data-memory-action", "layer");
      group.setAttribute("data-memory-layer", layer.id);
      this.button(group);
      const label = english ? layer.en : layer.zh;
      group.setAttribute("aria-label", label);
      const hit = ownedSvg(this.host.ownerDocument, "rect");
      hit.setAttribute("x", "-30");
      hit.setAttribute("y", "-11");
      hit.setAttribute("width", "60");
      hit.setAttribute("height", "22");
      hit.setAttribute("rx", "6");
      group.append(hit);
      this.text(group, label);
    }
  }
  private renderConnections(points: ReadonlyMap<string, MemoryPoint>): void {
    this.connections.replaceChildren();
    const center = { x: this.size / 2, y: this.size / 2 };
    for (const id of new Set(this.options.connectionIds)) {
      const point = points.get(id);
      if (point)
        this.line(this.connections, center, point);
    }
  }
  private renderClues(points: ReadonlyMap<string, MemoryPoint>): void {
    this.clues.replaceChildren();
    if (!this.options.showClues || !this.options.selectedId)
      return;
    const star = this.snapshot!.stars.find(item => item.id === this.options.selectedId);
    const point = star && points.get(star.id);
    if (!star || !point)
      return;
    for (const clue of star.clues) {
      if (clue.status !== "current" || clue.parentId !== star.id)
        continue;
      const angle = memoryMapHash(clue.id) * Math.PI * 2;
      const end = { x: point.x + Math.cos(angle) * 22, y: point.y + Math.sin(angle) * 22 };
      this.line(this.clues, point, end);
      const dot = this.circle(this.clues, 2, "echoink-memory-map-clue-dot");
      dot.setAttribute("cx", String(end.x));
      dot.setAttribute("cy", String(end.y));
    }
  }
  private group(className: string, parent: SVGElement = this.svg): SVGGElement {
    const group = ownedSvg(this.host.ownerDocument, "g");
    group.setAttribute("class", className);
    parent.append(group);
    return group;
  }
  private circle(parent: SVGElement, radius: number, className: string): SVGCircleElement {
    const circle = ownedSvg(this.host.ownerDocument, "circle");
    circle.setAttribute("r", String(radius));
    circle.setAttribute("class", className);
    parent.append(circle);
    return circle;
  }
  private text(parent: SVGElement, label: string, className?: string): SVGTextElement {
    const text = ownedSvg(this.host.ownerDocument, "text");
    text.textContent = label;
    if (className)
      text.setAttribute("class", className);
    parent.append(text);
    return text;
  }
  private line(parent: SVGElement, start: {
    x: number;
    y: number;
  }, end: {
    x: number;
    y: number;
  }): void {
    const line = ownedSvg(this.host.ownerDocument, "line");
    line.setAttribute("x1", String(start.x));
    line.setAttribute("y1", String(start.y));
    line.setAttribute("x2", String(end.x));
    line.setAttribute("y2", String(end.y));
    parent.append(line);
  }
  private button(element: SVGElement): void {
    element.setAttribute("role", "button");
    element.setAttribute("tabindex", "0");
  }
  private activate(event: Event): boolean {
    if (this.disposed)
      return false;
    const target = event.target as Element | null;
    const button = target?.closest<SVGElement>("[data-memory-action]");
    if (!button || !this.svg.contains(button))
      return false;
    const action = button.getAttribute("data-memory-action");
    if (action === "select")
      this.callbacks.select(button.getAttribute("data-memory-id")!);
    else if (action === "profile")
      this.callbacks.profile();
    else if (action === "layer")
      this.callbacks.layer(button.getAttribute("data-memory-layer") as MemoryLayer);
    else if (action === "category")
      this.callbacks.category(button.getAttribute("data-memory-category") as MemoryCategory);
    return true;
  }
  private readonly onClick = (event: MouseEvent): void => {
    this.activate(event);
  };
  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if ((event.key === "Enter" || event.key === " ") && !event.repeat && this.activate(event))
      event.preventDefault();
  };
}
