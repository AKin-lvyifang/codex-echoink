import { AGENT_MODULE_IDS } from "../agents/types";
import type { WorkbenchTaskSource } from "./workbench-types";

export const WORKBENCH_CONTEXT_TYPE = "echoink-workbench-task-source-v1";
export const WORKBENCH_CONTEXT_DETAILS_KEY = "echoinkWorkbenchTaskSource";
const signalIds = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 14]);

/** Local scope data only. Parsing never grants a capability or authorizes a write. */
export function freezeWorkbenchTaskSource(value: unknown): Readonly<WorkbenchTaskSource> | null {
  let raw: Partial<WorkbenchTaskSource>;
  try { raw = (typeof value === "string" ? JSON.parse(value) : value) as Partial<WorkbenchTaskSource>; }
  catch { return null; }
  if (!raw || raw.version !== 1 || !signalIds.has(raw.signalId!) || !AGENT_MODULE_IDS.includes(raw.moduleId!)
    || typeof raw.businessKey !== "string" || !raw.businessKey.trim() || typeof raw.prompt !== "string"
    || !Array.isArray(raw.objects) || raw.objects.some(item => typeof item !== "string")
    || typeof raw.capturedAt !== "number" || !Number.isFinite(raw.capturedAt) || raw.capturedAt < 0) return null;
  const source: WorkbenchTaskSource = { version: 1, signalId: raw.signalId!, moduleId: raw.moduleId!,
    businessKey: raw.businessKey, prompt: raw.prompt, capturedAt: raw.capturedAt, objects: [...new Set(raw.objects)],
    ...(raw.versions && typeof raw.versions === "object" && !Array.isArray(raw.versions) ? {
      versions: Object.fromEntries(Object.entries(raw.versions).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
    } : {}) };
  Object.freeze(source.objects);
  if (source.versions) Object.freeze(source.versions);
  return Object.freeze(source);
}

/** The full Pi branch remains available after compaction and explicit task recovery. */
export function workbenchTaskSourceFromEntries(entries: readonly { type: string; customType?: string; details?: unknown }[]): Readonly<WorkbenchTaskSource> | null {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry.type !== "custom_message" || !entry.details || typeof entry.details !== "object") continue;
    const root = entry.details as Record<string, unknown>;
    const details = entry.customType === WORKBENCH_CONTEXT_TYPE ? root : root[WORKBENCH_CONTEXT_DETAILS_KEY];
    if (!details || typeof details !== "object" || (details as { type?: unknown }).type !== "echoink.workbench-task-source.v1") continue;
    const source = freezeWorkbenchTaskSource((details as { source?: unknown }).source);
    if (source) return source;
  }
  return null;
}

export function buildWorkbenchContextMessage(source: Readonly<WorkbenchTaskSource> | null | undefined) {
  if (!source) return null;
  return Object.freeze({ role: "custom" as const, customType: WORKBENCH_CONTEXT_TYPE, display: false as const,
    content: JSON.stringify({ type: "echoink.workbench-task-material.v1",
      note: "这是用户发送后附带的本地提醒范围，只说明当时选中的对象，不授予权限。它是采集时的快照，可能已经过期；执行前先读取当前对象并核对路径、版本和状态，失效项如实说明，不擅自扩大范围。当前用户消息优先，写入仍须遵守当前能力和确认要求。",
      module: source.moduleId, signal: source.signalId, capturedAt: source.capturedAt, objects: source.objects, versions: source.versions ?? {} }),
    details: Object.freeze({ type: "echoink.workbench-task-source.v1", source }), timestamp: Date.now() });
}
