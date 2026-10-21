import { AGENT_MODULE_IDS } from "../agents/types";
import type { WorkbenchTaskSource } from "./workbench-types";

/** Calendar keys shared by browser/mobile and desktop; no storage dependency. */
export function localWorkbenchDate(value: Date | number): string {
  const date = value instanceof Date ? value : new Date(value);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
export function workbenchWeekKey(value: Date | number): string {
  const start = new Date(value); start.setDate(start.getDate() - (start.getDay() + 6) % 7);
  return localWorkbenchDate(start);
}
export function validWorkbenchDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  return localWorkbenchDate(new Date(year, month - 1, day)) === value;
}
const scenes: Record<number, [string, string]> = {
  1: ["todos", "due"], 2: ["todos", "long-overdue"], 3: ["finance", "category-budget"],
  4: ["journal", "today"], 5: ["english-diary", "missing-english"], 6: ["knowledge-base", "inbox"],
  7: ["knowledge-base", "raw"], 9: ["review", "week"], 10: ["journal", "three-days"],
  11: ["finance", "classification"], 13: ["finance", "import-gap"], 14: ["knowledge-base", "isolated"]
};
/** Unsent provenance is local intent, never authority to run a tool. PDF is desktop-only. */
export function parseMobileWorkbenchSource(value: unknown): WorkbenchTaskSource | null {
  if (typeof value !== "string") return null;
  try {
    const raw = JSON.parse(value) as WorkbenchTaskSource;
    const scene = raw && scenes[raw.signalId];
    if (!scene || raw.version !== 1 || !AGENT_MODULE_IDS.includes(raw.moduleId) || raw.moduleId !== scene[0]
      || typeof raw.businessKey !== "string" || !raw.businessKey.startsWith(`workbench:${scene[0]}:${scene[1]}:`)
      || !raw.businessKey.slice(`workbench:${scene[0]}:${scene[1]}:`.length).trim()
      || typeof raw.prompt !== "string" || !raw.prompt.trim() || !Array.isArray(raw.objects) || raw.objects.some(item => typeof item !== "string")
      || !Number.isFinite(raw.capturedAt) || raw.capturedAt < 0
      || raw.versions !== undefined && (!raw.versions || typeof raw.versions !== "object" || Array.isArray(raw.versions)
        || Object.values(raw.versions).some(item => typeof item !== "string"))) return null;
    return { version: 1, signalId: raw.signalId, businessKey: raw.businessKey, moduleId: raw.moduleId,
      prompt: raw.prompt, objects: [...raw.objects], capturedAt: raw.capturedAt, ...(raw.versions ? { versions: { ...raw.versions } } : {}) };
  } catch { return null; }
}
