import type { ChatMessage, InjectedPersonalMemorySourceReference } from "../../settings/settings";
import type { PiSessionBranchEntryView } from "./pi-chat-ui-projector";

export const PI_MEMORY_SOURCES_ENTRY_TYPE = "echoink.memory-sources.v1";

export function normalizeInjectedMemorySources(value: unknown): InjectedPersonalMemorySourceReference[] {
  if (!Array.isArray(value)) return [];
  const items: readonly unknown[] = value;
  const sources = new Map<string, InjectedPersonalMemorySourceReference>();
  for (const candidate of items) {
    if (!candidate || typeof candidate !== "object") continue;
    const item = candidate as Record<string, unknown>;
    if (typeof item.id !== "string" || typeof item.title !== "string") continue;
    const id = item.id.trim(), title = item.title.trim();
    if (!id || !title || sources.has(id)) continue;
    const revision = item.revision;
    sources.set(id, { id, title,
      ...(typeof revision === "number" && Number.isSafeInteger(revision) && revision > 0 ? { revision } : {}) });
  }
  return [...sources.values()];
}

/** Restore only references from this Session and ProductRun; never copy Memory bodies. */
export function projectInjectedMemorySources(messages: ChatMessage[], entries: readonly PiSessionBranchEntryView[], piSessionId: string): void {
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== PI_MEMORY_SOURCES_ENTRY_TYPE) continue;
    const data = entry.data as Record<string, unknown> | null;
    if (!data || data.schemaVersion !== 1 || data.piSessionId !== piSessionId || typeof data.productRunId !== "string") continue;
    const sources = normalizeInjectedMemorySources(data.sources);
    const target = messages.find(message => message.reasoningSummary?.productRunId === data.productRunId)
      ?? messages.find(message => message.runId === data.productRunId);
    if (target && sources.length) target.injectedMemorySources = sources;
  }
}
