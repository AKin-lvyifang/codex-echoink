import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { JSDOM } from "jsdom";
import { MEMORY_MAP_DESIGN, memoryMapGeometry, memoryMapLabelFrame } from "../home/memory/memory-map-geometry";
import { MemoryMapRenderer } from "../home/memory/memory-map-renderer";
import { MEMORY_CATEGORIES, type MemoryPageSnapshot, type MemoryStar } from "../home/memory/memory-page-types";
import type { SecondaryMemoryRecord } from "../harness/memory/personal-memory-contracts";
import { installObsidianDom } from "./obsidian-dom";

function star(id: string, values: Partial<MemoryStar> = {}): MemoryStar {
  return { schema: "echoink.memory.v1", id, kind: "fact", status: "current", date: "2026-11-03", source: "user",
    basis: "explicit", title: `标题 ${id}`, recallWhen: "", content: "真实记忆内容", revision: 1, file: `${id}.md`,
    category: "facts", layer: "frequent", activity: 0.8, recallCount: 0, sourceView: { text: "用户记下" },
    history: [], profiles: [], clues: [], ...values };
}
function clue(id: string, parentId: string, status: "current" | "disabled" = "current"): SecondaryMemoryRecord {
  return { schema: "echoink.memory-secondary.v1", id, parentId, status, disabledReason: status === "disabled" ? "parent_lifecycle" : null,
    title: id, content: "真实联想", recallWhen: "", matchTerms: [], relation: "associated", reason: "", supportLevel: "strong_inference",
    evidence: "记忆内容", basis: "llm_inferred", sourceMemoryRevision: 1, confidence: 1, hitCount: 0,
    lastHitAt: null, lastDecayAt: null, createdAt: 0, updatedAt: 0, revision: 1, file: `${id}.md` };
}
function snapshot(stars: readonly MemoryStar[]): MemoryPageSnapshot {
  return { revision: 1, now: 1, enabled: true, stars, profile: [],
    activityState: { version: 1, vaultId: "fixture", initializedAt: "2026-11-03", records: {} } };
}

export function runMemoryMapTests(): void {
  const inputs = [star("a", { layer: "core", pinned: true }), star("b"),
    star("c", { category: "decisions", layer: "peripheral", activity: 0.4 }), star("d", { category: "episodes", layer: "faded", activity: 0.1 })];
  const full = memoryMapGeometry(inputs, 820);
  const reordered = memoryMapGeometry([...inputs].reverse(), 820);
  for (const point of full) assert.deepEqual(point, reordered.find(item => item.id === point.id), "ordering cannot move an existing memory");
  assert.deepEqual(memoryMapGeometry([...inputs, star("new")], 820).slice(0, 4), full, "adding a memory preserves existing positions");
  const ranges = { core: [0, 112], frequent: [112, 224], peripheral: [224, 318], faded: [318, 356] } as const;
  for (const point of full) {
    const radius = Math.hypot(point.x - 410, point.y - 410);
    assert.ok(radius > ranges[point.layer][0] && radius < ranges[point.layer][1], "each star stays inside its actual lifecycle layer");
    assert.ok(point.radius >= 3 && point.radius <= 5.5);
  }
  assert.equal(full[0].radius, 5.5);
  assert.equal(full[3].radius, 3.2);
  const neighbors = memoryMapGeometry([star("mem_24e0165421be4abbb6de8e9d1f312d36", { layer: "core", pinned: true }), star("mem_67b3f30cb86d43468dba9b5a7b116a69", { layer: "core", pinned: true })], 632);
  assert.ok(Math.hypot(neighbors[0].x - neighbors[1].x, neighbors[0].y - neighbors[1].y) >= 15, "neighboring fixed memories remain distinguishable");
  for (const [index, category] of MEMORY_CATEGORIES.entries()) {
    const point = memoryMapGeometry([star(`sector-${index}`, { category: category.id })], 820)[0];
    const angle = (Math.atan2(point.y - 410, point.x - 410) + Math.PI / 2 + Math.PI * 2) % (Math.PI * 2);
    assert.ok(angle > index * Math.PI * 2 / 5 && angle < (index + 1) * Math.PI * 2 / 5);
  }
  const narrow = memoryMapGeometry(inputs, 300);
  assert.deepEqual(narrow.map(point => point.radius), full.map(point => point.radius), "resizing cannot shrink star dots");
  assert.ok(Math.hypot(narrow[0].x - 150, narrow[0].y - 150) > 27 + narrow[0].radius, "core stars remain outside the fixed center at narrow widths");
  for (const activity of [-4, 4, NaN]) assert.ok(memoryMapGeometry([star("bounded", { activity })], 820).every(point => Number.isFinite(point.x) && point.radius <= 4.8));
  const old = memoryMapGeometry([star("moves", { activity: 0.7 })], 820)[0];
  const fresh = memoryMapGeometry([star("moves", { activity: 1 })], 820)[0];
  assert.ok(Math.hypot(fresh.x - 410, fresh.y - 410) < Math.hypot(old.x - 410, old.y - 410), "activity moves a memory inward");

  const upgraded = Array.from({ length: 120 }, (_, index) => star(
    `mem_${createHash("sha256").update(`upgrade-memory-${index}`).digest("hex").slice(0, 32)}`,
    { category: MEMORY_CATEGORIES[index % MEMORY_CATEGORIES.length].id, layer: "frequent", activity: 2 ** (-30 / 60) }
  ));
  const upgradedPoints = memoryMapGeometry(upgraded, 632);
  const overlapping = new Set<string>();
  for (const [index, point] of upgradedPoints.entries()) {
    const radial = Math.hypot(point.x - 316, point.y - 316);
    assert.ok(radial > 112 * 632 / 820 && radial < 224 * 632 / 820, "collision retries stay inside the real ring");
    for (const other of upgradedPoints.slice(index + 1)) {
      if (Math.hypot(point.x - other.x, point.y - other.y) < point.radius + other.radius) {
        overlapping.add(point.id);
        overlapping.add(other.id);
      }
    }
  }
  assert.ok(overlapping.size / upgraded.length < 0.1, `120 upgraded memories with equal activity: ${overlapping.size} overlapping dots`);

  for (const size of [300, 632, 672]) {
    const widths = [70, 70, 90, 100, 100];
    const { inset, plotSize } = memoryMapLabelFrame(size, widths);
    for (const [index, width] of widths.entries()) {
      const angle = -Math.PI / 2 + (index + 0.5) * Math.PI * 2 / widths.length;
      const x = size / 2 + MEMORY_MAP_DESIGN.labels / 820 * plotSize * Math.cos(angle);
      if (Math.abs(Math.cos(angle)) > 0.01) assert.ok(Math.cos(angle) < 0 ? x - width >= 5.9 : x + width <= size - 5.9, "long labels stay inside the canvas");
    }
    assert.ok(plotSize > 0 && inset >= 0);
  }
  const dom = new JSDOM("<!doctype html><html><body><div id='host'></div></body></html>");
  const win = dom.window as unknown as Window & typeof globalThis;
  installObsidianDom(win);
  Object.defineProperty(win.SVGElement.prototype, "getComputedTextLength", { value() { return (this.textContent ?? "").length * 7; } });
  let resize: ResizeObserverCallback | undefined;
  let disconnected = false;
  let observed: Element | undefined;
  win.ResizeObserver = class {
    constructor(callback: ResizeObserverCallback) { resize = callback; }
    observe(element: Element) { observed = element; }
    unobserve() {}
    disconnect() { disconnected = true; }
  } as unknown as typeof ResizeObserver;
  const host = win.document.getElementById("host")!;
  Object.defineProperty(host, "clientWidth", { value: 632 });
  const actions: string[] = [];
  const renderer = new MemoryMapRenderer(host, { select: id => actions.push(`select:${id}`), profile: () => actions.push("profile"),
    layer: id => actions.push(`layer:${id}`), category: id => actions.push(`category:${id}`) });
  const a = star("a", { layer: "core", pinned: true, clues: [clue("real", "a"), clue("wrong", "other"), clue("disabled", "a", "disabled")] });
  const b = star("b", { layer: "faded", activity: 0.1 });
  try {
    renderer.update(snapshot([a, b]), { selectedId: "a", highlightIds: ["a"], connectionIds: ["a", "a", "missing"], showClues: true });
    const svg = host.querySelector("svg")!;
    assert.equal(observed, host, "the observer comes from the host window");
    assert.equal(svg.ownerDocument, host.ownerDocument);
    assert.equal(svg.getAttribute("viewBox"), "0 0 632 632");
    const aDot = host.querySelector<SVGGElement>('[data-memory-id="a"]')!;
    const bDot = host.querySelector<SVGGElement>('[data-memory-id="b"]')!;
    assert.match(aDot.getAttribute("aria-label")!, /标题 a.*核心/u);
    assert.equal(aDot.getAttribute("tabindex"), "0");
    assert.equal(aDot.getAttribute("aria-pressed"), "true");
    assert.equal(bDot.classList.contains("is-faded"), true);
    assert.equal(bDot.classList.contains("is-dimmed"), true);
    assert.equal(host.querySelectorAll(".echoink-memory-map-connections line").length, 1, "connections only use live real ids and deduplicate");
    assert.equal(host.querySelectorAll(".echoink-memory-map-clues line").length, 1, "only current clues owned by the selected memory are drawn");
    aDot.querySelector("circle")!.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
    bDot.dispatchEvent(new win.KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
    host.querySelector('[data-memory-action="profile"]')!.dispatchEvent(new win.KeyboardEvent("keydown", { bubbles: true, key: " " }));
    host.querySelector('[data-memory-layer="core"]')!.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
    host.querySelector('[data-memory-category="facts"]')!.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
    assert.deepEqual(actions, ["select:a", "select:b", "profile", "layer:core", "category:facts"]);
    const transform = aDot.style.transform;
    renderer.update(snapshot([{ ...a, activity: 0.2 }, b]), { language: "en", connectionIds: ["b"] });
    assert.equal(host.querySelector('[data-memory-id="a"]'), aDot, "updates preserve the keyed star node and focus target");
    assert.notEqual(aDot.style.transform, transform);
    assert.match(aDot.getAttribute("aria-label")!, /Core/u);
    assert.equal(bDot.classList.contains("is-dimmed"), false, "omitting highlights clears prior dimming");
    assert.equal(host.querySelectorAll(".echoink-memory-map-clues line").length, 0);
    resize!([{ target: host, contentRect: new win.DOMRect(0, 0, 300, 300),
      borderBoxSize: [], contentBoxSize: [], devicePixelContentBoxSize: [] }], {} as ResizeObserver);
    assert.equal(svg.getAttribute("viewBox"), "0 0 300 300");
    assert.equal(aDot.querySelector(".echoink-memory-map-star-dot")!.getAttribute("r"), "5.5");
    const coreRing = host.querySelector(".echoink-memory-map-ring.is-core")!;
    assert.ok(Number(coreRing.getAttribute("r")) <= MEMORY_MAP_DESIGN.core * 300 / 820, "outward labels reserve room inside the canvas");
    renderer.update(snapshot([]));
    assert.equal(host.querySelectorAll(".echoink-memory-map-star").length, 0);
    assert.equal(host.querySelectorAll(".echoink-memory-map-ring").length, 4);
    assert.equal(host.querySelectorAll(".echoink-memory-map-label").length, 0);
    assert.equal(host.querySelector<SVGGElement>(".echoink-memory-map-center")!.style.display, "none");
    assert.equal(host.querySelector(".echoink-memory-map-empty")!.textContent, "还没有记忆");
    renderer.dispose();
    assert.equal(disconnected, true);
    assert.equal(host.querySelector("svg"), null);
    aDot.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
    renderer.update(snapshot([a]));
    assert.equal(actions.length, 5, "disposed renderers cannot trigger actions");
    assert.equal(host.childElementCount, 0);
  } finally {
    renderer.dispose();
    dom.window.close();
  }
  console.log("PASS Memory map: stable layer/sector geometry, fixed-size dots, real relationship filtering, keyed interaction updates, owner-window resize and cleanup");
}
