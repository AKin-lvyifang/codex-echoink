import type { ChatMessage } from "../settings/settings";
import type { SyncDeviceStore } from "./device-store";
import { parseEnvelope } from "./envelope";
import { isConflictCopy, listFileNames, listFolderNames, readJsonIfPresent, type SyncFs } from "./fs";
import { SYNC_DEVICES_DIR, SYNC_SCHEMA, deviceDir, isSyncDeviceId } from "./types";

/**
 * Conversations are mirrored in a neutral form both runtimes can read: who said what, when, plus one-line tool
 * summaries. The device that runs a conversation appends to its own `conversations/<id>/part-NNNN.jsonl`; a part
 * rolls over near 1 MB so Obsidian Sync's file limit is never reached. Nobody edits another device's parts.
 */
export const SYNC_CONVERSATION_PART_BYTES = 1_000_000;
export const SYNC_CONVERSATION_MIGRATION_KEY = "conversations";
export const SYNC_CONVERSATION_MIGRATION_WINDOW_MS = 30 * 86_400_000;
export const SYNC_FORK_SOURCE_PREFIX = "sync-fork:";
const TEXT_LIMIT = 200_000, TOOL_LIMIT = 200;

export interface SyncConversationMessage {
  readonly id: string;
  readonly role: "user" | "assistant" | "tool";
  readonly text: string;
  readonly at: number;
  /** For role "tool": the tool name; for assistant: tool calls made in this message. */
  readonly tools?: readonly string[];
}
export interface SyncConversationMetaPayload {
  readonly title: string;
  readonly agentId: string;
  readonly status: "active" | "archived";
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly messageCount: number;
  readonly lastMessageId?: string;
  readonly parts: readonly { readonly name: string; readonly bytes: number; readonly count: number }[];
  /** Set on a conversation that continues one from another device. */
  readonly forkOf?: { readonly deviceId: string; readonly conversationId: string };
  readonly preview?: string;
}

const rec = (v: unknown): Record<string, unknown> | null => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null;
const str = (v: unknown, max: number): string => typeof v === "string" ? v.slice(0, max) : "";
const num = (v: unknown): number | undefined => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : undefined;

export function parseConversationMeta(raw: unknown): SyncConversationMetaPayload | null {
  const r = rec(raw); if (!r) return null;
  const title = str(r.title, 200), agentId = str(r.agentId, 128), createdAt = num(r.createdAt), updatedAt = num(r.updatedAt), messageCount = num(r.messageCount);
  if (!agentId || createdAt === undefined || updatedAt === undefined || messageCount === undefined || !["active", "archived"].includes(r.status as string)) return null;
  const parts = (Array.isArray(r.parts) ? r.parts : []).flatMap(item => { const p = rec(item); const name = str(p?.name, 64), bytes = num(p?.bytes), count = num(p?.count);
    return p && /^part-\d{4}\.jsonl$/u.test(name) && bytes !== undefined && count !== undefined ? [{ name, bytes, count }] : []; });
  const fork = rec(r.forkOf), forkOf = fork && isSyncDeviceId(fork.deviceId) && str(fork.conversationId, 256) ? { deviceId: fork.deviceId, conversationId: str(fork.conversationId, 256) } : undefined;
  return { title: title || "对话", agentId, status: r.status as "active" | "archived", createdAt, updatedAt, messageCount, parts,
    ...(str(r.lastMessageId, 256) ? { lastMessageId: str(r.lastMessageId, 256) } : {}), ...(forkOf ? { forkOf } : {}), ...(str(r.preview, 200) ? { preview: plainPreview(str(r.preview, 200) ?? "") } : {}) };
}
export function parseConversationLine(line: string): SyncConversationMessage | null {
  let raw: unknown;
  try { raw = JSON.parse(line); } catch { return null; }
  const r = rec(raw); if (!r) return null;
  const id = str(r.id, 256), text = str(r.text, TEXT_LIMIT), at = num(r.at);
  if (!id || at === undefined || !["user", "assistant", "tool"].includes(r.role as string)) return null;
  const tools = Array.isArray(r.tools) ? r.tools.flatMap(item => typeof item === "string" ? [item.slice(0, TOOL_LIMIT)] : []) : [];
  return { id, role: r.role as SyncConversationMessage["role"], text, at, ...(tools.length ? { tools } : {}) };
}

/* ===== converters from each runtime's own message shape ===== */
export function neutralFromChatMessages(messages: readonly ChatMessage[], fallbackAt: number): SyncConversationMessage[] {
  const out: SyncConversationMessage[] = [];
  for (const [index, message] of messages.entries()) {
    const at = (message as { createdAt?: number }).createdAt ?? fallbackAt;
    const id = message.id || `m-${index}`;
    if (message.role === "user" || message.role === "assistant") {
      // The thinking/reasoning summaries are process cards ("读取笔记完成"), not part of the answer.
      if (message.role === "assistant" && (message.processKind || message.itemType === "reasoning" || message.itemType === "thinking")) continue;
      const text = message.text.trim();
      if (text) out.push({ id, role: message.role, text: text.slice(0, TEXT_LIMIT), at });
    } else if (message.role === "tool") {
      const title = (message.title || message.itemType || message.text || "").replace(/\s+/gu, " ").trim().slice(0, TOOL_LIMIT);
      if (title) out.push({ id, role: "tool", text: title, at, tools: [title] });
    }
  }
  return out;
}
/** Mobile keeps Pi AI messages: user/assistant with content parts, toolResult rows. */
export function neutralFromAgentMessages(messages: readonly unknown[], fallbackAt: number): SyncConversationMessage[] {
  const out: SyncConversationMessage[] = [];
  for (const [index, raw] of messages.entries()) {
    const m = rec(raw); if (!m) continue;
    const at = num(m.timestamp) ?? fallbackAt, id = `m-${index}-${at}`;
    const parts = Array.isArray(m.content) ? m.content : typeof m.content === "string" ? [{ type: "text", text: m.content }] : [];
    const text = parts.flatMap(part => { const p = rec(part); return p?.type === "text" && typeof p.text === "string" ? [p.text] : []; }).join("\n").trim();
    const calls = parts.flatMap(part => { const p = rec(part); return p?.type === "toolCall" && typeof p.name === "string" ? [p.name] : []; });
    if (m.role === "user" && text) out.push({ id, role: "user", text: text.slice(0, TEXT_LIMIT), at });
    else if (m.role === "assistant" && (text || calls.length)) out.push({ id, role: "assistant", text: text.slice(0, TEXT_LIMIT), at, ...(calls.length ? { tools: calls } : {}) });
    else if (m.role === "toolResult" && typeof m.toolName === "string") out.push({ id, role: "tool", text: m.toolName.slice(0, TOOL_LIMIT), at, tools: [m.toolName.slice(0, TOOL_LIMIT)] });
  }
  return out;
}

export interface SyncConversationSource {
  readonly id: string;
  readonly title: string;
  readonly agentId: string;
  readonly status: "active" | "archived";
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly messages: readonly SyncConversationMessage[];
  readonly forkOf?: { readonly deviceId: string; readonly conversationId: string };
}

export interface SyncConversationWriterOptions {
  readonly fs: SyncFs;
  readonly device: SyncDeviceStore;
  readonly maxPartBytes?: number;
  readonly now?: () => number;
}

/** Appends new messages to this device's own conversation parts; rewrites from scratch only when history diverged. */
export class SyncConversationWriter {
  private readonly metas = new Map<string, SyncConversationMetaPayload>();
  private readonly flights = new Map<string, Promise<void>>();
  private readonly maxPartBytes: number;
  private readonly now: () => number;
  constructor(private readonly options: SyncConversationWriterOptions) { this.maxPartBytes = options.maxPartBytes ?? SYNC_CONVERSATION_PART_BYTES; this.now = options.now ?? (() => Date.now()); }
  get deviceId(): string { return this.options.device.deviceId; }
  private dir(id: string): string { return `${this.options.device.dir}/conversations/${id}`; }

  /** Serialized per conversation: a settled turn and a migration pass never interleave on the same files. */
  export(source: SyncConversationSource): Promise<void> {
    const previous = this.flights.get(source.id) ?? Promise.resolve();
    const run = previous.then(() => this.exportNow(source), () => this.exportNow(source)).finally(() => { if (this.flights.get(source.id) === run) this.flights.delete(source.id); });
    this.flights.set(source.id, run);
    return run;
  }
  private async exportNow(source: SyncConversationSource): Promise<void> {
    const { fs, device } = this.options;
    await device.open();
    const dir = this.dir(source.id);
    let meta = this.metas.get(source.id) ?? parseEnvelope(await readJsonIfPresent(fs, `${dir}/meta.json`), SYNC_SCHEMA.conversationMeta, parseConversationMeta)?.payload;
    const messages = source.messages;
    const exported = meta?.messageCount ?? 0;
    const sameHistory = !!meta && exported <= messages.length && (exported === 0 || messages[exported - 1]?.id === meta.lastMessageId);
    const parts = meta && sameHistory ? [...meta.parts] : [];
    const start = sameHistory ? exported : 0;
    if (!sameHistory && meta) for (const part of meta.parts) { try { await fs.remove(`${dir}/${part.name}`); } catch { /* a stale part is harmless: the reader stops at messageCount */ } }
    for (let index = start; index < messages.length; index++) {
      const line = `${JSON.stringify(messages[index])}\n`, bytes = new TextEncoder().encode(line).length;
      let current = parts[parts.length - 1];
      if (!current || current.bytes + bytes > this.maxPartBytes) { current = { name: `part-${String(parts.length + 1).padStart(4, "0")}.jsonl`, bytes: 0, count: 0 }; parts.push(current); await writeText(fs, `${dir}/${current.name}`, ""); }
      await fs.append(`${dir}/${current.name}`, line);
      parts[parts.length - 1] = { ...current, bytes: current.bytes + bytes, count: current.count + 1 };
    }
    const last = messages[messages.length - 1];
    const next: SyncConversationMetaPayload = { title: source.title.trim().slice(0, 200) || "对话", agentId: source.agentId, status: source.status, createdAt: source.createdAt, updatedAt: source.updatedAt,
      messageCount: messages.length, ...(last ? { lastMessageId: last.id } : {}), parts, ...(source.forkOf ? { forkOf: source.forkOf } : {}),
      ...(preview(messages) ? { preview: preview(messages) } : {}) };
    if (meta && sameHistory && start === messages.length && JSON.stringify({ ...meta, updatedAt: 0 }) === JSON.stringify({ ...next, updatedAt: 0 })) { this.metas.set(source.id, meta); return; }
    await device.write(`conversations/${source.id}/meta.json`, SYNC_SCHEMA.conversationMeta, next);
    this.metas.set(source.id, next);
  }
}
async function writeText(fs: SyncFs, path: string, text: string): Promise<void> {
  const parent = path.slice(0, path.lastIndexOf("/"));
  const parts = parent.split("/").filter(Boolean); let current = "";
  for (const part of parts) { current = current ? `${current}/${part}` : part; if (!await fs.exists(current)) await fs.mkdir(current); }
  await fs.write(path, text);
}
function preview(messages: readonly SyncConversationMessage[]): string {
  const last = [...messages].reverse().find(m => m.role !== "tool" && m.text.trim());
  return last ? plainPreview(last.text).slice(0, 120) : "";
}
/** "MacBook-Pro.local" → "MacBook Pro": hostnames are for networks, people read names. */
export function friendlyDeviceName(name: string): string {
  const clean = name.trim().replace(/\.(local|lan|home|localdomain)$/iu, "").replace(/[-_]+/gu, " ").replace(/\s+/gu, " ").trim();
  return clean || name.trim();
}
/** One readable line for lists: Markdown marks are layout, not words. */
export function plainPreview(text: string): string {
  return text.replace(/```[\s\S]*?```/gu, " ").replace(/!?\[([^\]]*)\]\([^)]*\)/gu, "$1").replace(/\[\[([^\]|]+\|)?([^\]]+)\]\]/gu, "$2")
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+\.\s+)/gmu, "").replace(/(\*\*|__|\*|`|~~)/gu, "").replace(/\s+/gu, " ").trim();
}

/* ===== reader ===== */
export interface RemoteConversationSummary extends SyncConversationMetaPayload {
  readonly id: string;
  readonly deviceId: string;
  readonly deviceName: string;
  /** Devices that already continued this conversation. */
  readonly continuedOn: readonly { readonly deviceId: string; readonly deviceName: string; readonly conversationId: string }[];
}

/** Every device's conversation metas (self included, for fork links); only others' are listed as remote. */
export async function readSyncConversations(fs: SyncFs, selfDeviceId: string, deviceName: (id: string) => string): Promise<RemoteConversationSummary[]> {
  const all: { id: string; deviceId: string; meta: SyncConversationMetaPayload }[] = [];
  for (const deviceId of await listFolderNames(fs, SYNC_DEVICES_DIR)) {
    if (!isSyncDeviceId(deviceId)) continue;
    const root = `${deviceDir(deviceId)}/conversations`;
    for (const id of await listFolderNames(fs, root)) {
      const parsed = parseEnvelope(await readJsonIfPresent(fs, `${root}/${id}/meta.json`), SYNC_SCHEMA.conversationMeta, parseConversationMeta);
      if (parsed && parsed.deviceId === deviceId) all.push({ id, deviceId, meta: parsed.payload });
    }
  }
  return all.filter(item => item.deviceId !== selfDeviceId).map(item => ({ ...item.meta, id: item.id, deviceId: item.deviceId, deviceName: deviceName(item.deviceId),
    continuedOn: all.filter(other => other.meta.forkOf?.deviceId === item.deviceId && other.meta.forkOf.conversationId === item.id)
      .map(other => ({ deviceId: other.deviceId, deviceName: deviceName(other.deviceId), conversationId: other.id })) }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}
/** Parts in order; callers can require the number of complete messages advertised by the metadata. */
export async function readSyncConversationMessages(fs: SyncFs, deviceId: string, conversationId: string, minimumMessageCount = 0): Promise<SyncConversationMessage[]> {
  if (!isSyncDeviceId(deviceId)) return [];
  const dir = `${deviceDir(deviceId)}/conversations/${conversationId}`;
  const names = (await listFileNames(fs, dir)).filter(name => /^part-\d{4}\.jsonl$/u.test(name) && !isConflictCopy(name)).sort();
  const out: SyncConversationMessage[] = [];
  for (const name of names) {
    let text = "";
    try { text = await fs.read(`${dir}/${name}`); } catch { continue; }
    const lines = text.split("\n");
    if (!text.endsWith("\n")) lines.pop();
    for (const line of lines) { if (!line.trim()) continue; const message = parseConversationLine(line); if (message) out.push(message); }
  }
  if (out.length < minimumMessageCount) throw new Error("The synced conversation transcript is incomplete");
  return out;
}

/* ===== fork ===== */
export function syncForkSource(deviceId: string, conversationId: string): string { return `${SYNC_FORK_SOURCE_PREFIX}${deviceId}:${conversationId}`; }
export function parseSyncForkSource(value: unknown): { deviceId: string; conversationId: string } | null {
  if (typeof value !== "string" || !value.startsWith(SYNC_FORK_SOURCE_PREFIX)) return null;
  const rest = value.slice(SYNC_FORK_SOURCE_PREFIX.length), split = rest.indexOf(":");
  if (split <= 0) return null;
  const deviceId = rest.slice(0, split), conversationId = rest.slice(split + 1).trim();
  return isSyncDeviceId(deviceId) && conversationId ? { deviceId, conversationId } : null;
}
/** The text a forked conversation starts with: the other device's transcript as background, bounded. */
export function forkPrefillText(summary: Pick<RemoteConversationSummary, "title" | "deviceName">, messages: readonly SyncConversationMessage[], limit = 6000): string {
  const lines: string[] = [];
  for (const message of [...messages].reverse()) {
    if (message.role === "tool") continue;
    const line = `${message.role === "user" ? "我" : "助手"}：${message.text.trim()}`;
    if (lines.join("\n\n").length + line.length > limit) break;
    lines.unshift(line);
  }
  const omitted = messages.filter(m => m.role !== "tool").length - lines.length;
  return [`接着我在${summary.deviceName}上的对话《${summary.title}》聊。下面是之前的对话${omitted > 0 ? `（更早的 ${omitted} 条略去）` : ""}：`, "", ...lines, "", "请接着上面的对话继续，我的下一句是："].join("\n");
}

/* ===== reading view ===== */
export type TranscriptItem = { kind: "message"; message: SyncConversationMessage } | { kind: "steps"; names: string[] };

/** Consecutive tool rows read as one step group; assistant rows that only called tools carry no words of their own. */
export function transcriptItems(messages: readonly SyncConversationMessage[]): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  for (const message of messages) {
    if (message.role === "assistant" && !message.text.trim()) continue;
    if (message.role !== "tool") { items.push({ kind: "message", message }); continue; }
    const last = items[items.length - 1];
    if (last?.kind === "steps") last.names.push(message.text); else items.push({ kind: "steps", names: [message.text] });
  }
  return items;
}
