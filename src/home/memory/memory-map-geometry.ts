import type { MemoryLayer } from "../../harness/memory/memory-relevance";
import { MEMORY_CATEGORIES, type MemoryStar } from "./memory-page-types";

export const MEMORY_MAP_DESIGN = { size: 820, center: 410, core: 112, frequent: 224, peripheral: 318, faded: 356, labels: 388 } as const;
export interface MemoryPoint { id: string; x: number; y: number; radius: number; opacity: number; layer: MemoryLayer }
const BANDS = { core: [43, 101], frequent: [132, 212], peripheral: [242, 307], faded: [333, 352] } as const;
export function memoryMapHash(value: string): number {
  let result = 2166136261;
  for (const char of value) result = Math.imul(result ^ char.charCodeAt(0), 16777619);
  return (result >>> 0) / 4294967296;
}
export function memoryPolar(radius: number, angle: number, size: number): { x: number; y: number } {
  return { x: size / 2 + Math.cos(angle) * radius * size / MEMORY_MAP_DESIGN.size, y: size / 2 + Math.sin(angle) * radius * size / MEMORY_MAP_DESIGN.size };
}
/** Stable IDs keep angular identity; activity moves a point within its real ring. */
export function memoryMapGeometry(stars: readonly Pick<MemoryStar, "id" | "category" | "layer" | "activity" | "pinned">[], size: number): MemoryPoint[] {
  const extent = Number.isFinite(size) ? Math.max(0, size) : MEMORY_MAP_DESIGN.size;
  const placed: MemoryPoint[] = [];
  for (const star of [...stars].sort((a, b) => a.id.localeCompare(b.id))) {
    const activity = Number.isFinite(star.activity) ? Math.max(0, Math.min(1, star.activity)) : 0;
    const sector = Math.max(0, MEMORY_CATEGORIES.findIndex(category => category.id === star.category));
    const [near, far] = BANDS[star.layer];
    const normalized = star.layer === "frequent" ? (activity - 0.7) / 0.3 : star.layer === "peripheral" ? (activity - 0.2) / 0.5 : star.layer === "faded" ? activity / 0.2 : activity;
    const dotRadius = star.pinned ? 5.5 : star.layer === "faded" ? 3.2 : 3 + activity * 1.8;
    const scale = extent / MEMORY_MAP_DESIGN.size;
    // The center stays 54px wide, so keep core stars reachable as the rings shrink.
    const inner = star.layer === "core" ? Math.min(far * scale, Math.max(near * scale, 27 + dotRadius + 1)) : near * scale;
    let radius = inner + (far * scale - inner) * (0.25 * memoryMapHash(`${star.id}:r`) + 0.75 * (1 - Math.max(0, Math.min(1, normalized))));
    let point!: MemoryPoint;
    // Collision retries sample different radial steps within the same ring.
    for (let attempt = 0; attempt < 8; attempt++) {
      const angle = -Math.PI / 2 + (sector + 0.12 + ((memoryMapHash(star.id) + attempt * 0.61803398875) % 1) * 0.76) * Math.PI * 2 / MEMORY_CATEGORIES.length;
      point = { id: star.id, x: extent / 2 + Math.cos(angle) * radius, y: extent / 2 + Math.sin(angle) * radius, layer: star.layer,
      radius: dotRadius,
      opacity: star.layer === "core" ? 1 : 0.3 + activity * 0.7 };
      if (placed.every(other => Math.hypot(other.x - point.x, other.y - point.y) >= other.radius + point.radius + 4)) break;
      radius = inner + (far * scale - inner) * ((memoryMapHash(`${star.id}:r`) + (attempt + 1) / 8) % 1);
    }
    placed.push(point);
  }
  const byId = new Map(placed.map(point => [point.id, point]));
  return stars.map(star => byId.get(star.id)!);
}

/** Reserve only the space outward-facing category labels need inside the canvas. */
export function memoryMapLabelFrame(size: number, widths: readonly number[]): { inset: number; plotSize: number } {
  let inset = 0;
  for (const [index, width] of widths.entries()) {
    const angle = -Math.PI / 2 + (index + 0.5) * Math.PI * 2 / widths.length;
    const horizontal = Math.abs(Math.cos(angle));
    if (horizontal < 0.01) continue;
    const edge = 0.5 - MEMORY_MAP_DESIGN.labels / MEMORY_MAP_DESIGN.size * horizontal;
    inset = Math.max(inset, (width + 6 - size * edge) / (1 - 2 * edge));
  }
  return { inset, plotSize: size - inset * 2 };
}
