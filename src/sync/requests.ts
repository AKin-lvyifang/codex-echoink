import type { CompanyService } from "../company/service";
import type { SyncDeviceStore } from "./device-store";
import { parseEnvelope } from "./envelope";
import { isConflictCopy, listFileNames, listFolderNames, readJsonIfPresent, type SyncFs } from "./fs";
import { SYNC_DEVICES_DIR, SYNC_SCHEMA, deviceDir, isSyncDeviceId, windowTimers, type SyncEnvelope, type SyncTimers } from "./types";

/**
 * Cross-device actions travel as a request file in the requester's folder; the owning device acts and writes an
 * ack in its own folder. Neither side ever writes into the other's folder, so two devices can never collide.
 */
export type SyncRequestKind = "answer_decision" | "stop_dispatch" | "message_dispatch";
export interface SyncRequestPayload {
  readonly kind: SyncRequestKind;
  readonly targetDeviceId: string;
  readonly dispatchId: string;
  readonly projectId?: string;
  /** The report this answer belongs to; a later round rejects an old answer. */
  readonly reportAt?: number;
  readonly answer?: string;
  readonly text?: string;
  readonly createdAt: number;
}
export type SyncAckStatus = "adopted" | "superseded" | "rejected";
export interface SyncAckPayload {
  readonly requestId: string;
  readonly requesterDeviceId: string;
  readonly dispatchId: string;
  readonly reportAt?: number;
  readonly status: SyncAckStatus;
  readonly reason: string;
  /** For superseded: the request that was adopted instead. */
  readonly adoptedRequestId?: string;
  readonly adoptedDeviceId?: string;
  readonly at: number;
}

const rec = (v: unknown): Record<string, unknown> | null => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null;
const str = (v: unknown, max: number): string => typeof v === "string" ? v.trim().slice(0, max) : "";
const num = (v: unknown): number | undefined => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : undefined;
const KINDS: readonly SyncRequestKind[] = ["answer_decision", "stop_dispatch", "message_dispatch"];

export function parseRequestPayload(raw: unknown): SyncRequestPayload | null {
  const r = rec(raw); if (!r || !KINDS.includes(r.kind as SyncRequestKind) || !isSyncDeviceId(r.targetDeviceId)) return null;
  const dispatchId = str(r.dispatchId, 256), createdAt = num(r.createdAt);
  if (!dispatchId || createdAt === undefined) return null;
  const projectId = str(r.projectId, 128), answer = str(r.answer, 2000), text = str(r.text, 2000), reportAt = num(r.reportAt);
  return { kind: r.kind as SyncRequestKind, targetDeviceId: r.targetDeviceId, dispatchId, createdAt,
    ...(projectId ? { projectId } : {}), ...(reportAt !== undefined ? { reportAt } : {}), ...(answer ? { answer } : {}), ...(text ? { text } : {}) };
}
export function parseAckPayload(raw: unknown): SyncAckPayload | null {
  const r = rec(raw); if (!r || !["adopted", "superseded", "rejected"].includes(r.status as string) || !isSyncDeviceId(r.requesterDeviceId)) return null;
  const requestId = str(r.requestId, 128), dispatchId = str(r.dispatchId, 256), at = num(r.at);
  if (!requestId || !dispatchId || at === undefined) return null;
  const reportAt = num(r.reportAt), adoptedRequestId = str(r.adoptedRequestId, 128), adoptedDeviceId = str(r.adoptedDeviceId, 128);
  return { requestId, requesterDeviceId: r.requesterDeviceId, dispatchId, status: r.status as SyncAckStatus, reason: str(r.reason, 400), at,
    ...(reportAt !== undefined ? { reportAt } : {}), ...(adoptedRequestId ? { adoptedRequestId } : {}), ...(adoptedDeviceId ? { adoptedDeviceId } : {}) };
}

export interface SyncRequestRecord { readonly id: string; readonly deviceId: string; readonly payload: SyncRequestPayload }
export interface SyncAckRecord { readonly id: string; readonly deviceId: string; readonly payload: SyncAckPayload }
const requestId = (fileName: string) => fileName.replace(/\.json$/u, "");

/** Every other device's requests aimed at `targetDeviceId`, oldest first. Order is by the requester's clock, then id; the first one wins. */
export async function readRequestsFor(fs: SyncFs, targetDeviceId: string): Promise<SyncRequestRecord[]> {
  const out: SyncRequestRecord[] = [];
  for (const deviceId of await listFolderNames(fs, SYNC_DEVICES_DIR)) {
    if (deviceId === targetDeviceId || !isSyncDeviceId(deviceId)) continue;
    const folder = `${deviceDir(deviceId)}/requests`;
    for (const name of await listFileNames(fs, folder)) {
      if (!name.endsWith(".json") || isConflictCopy(name)) continue;
      const parsed = parseEnvelope(await readJsonIfPresent(fs, `${folder}/${name}`), SYNC_SCHEMA.request, parseRequestPayload);
      if (parsed && parsed.deviceId === deviceId && parsed.payload.targetDeviceId === targetDeviceId) out.push({ id: requestId(name), deviceId, payload: parsed.payload });
    }
  }
  return out.sort((a, b) => a.payload.createdAt - b.payload.createdAt || a.id.localeCompare(b.id));
}
export async function readAck(fs: SyncFs, executorDeviceId: string, id: string): Promise<SyncAckRecord | null> {
  if (!isSyncDeviceId(executorDeviceId)) return null;
  const parsed = parseEnvelope(await readJsonIfPresent(fs, `${deviceDir(executorDeviceId)}/acks/${id}.json`), SYNC_SCHEMA.ack, parseAckPayload);
  return parsed && parsed.deviceId === executorDeviceId ? { id, deviceId: executorDeviceId, payload: parsed.payload } : null;
}
export async function readOwnAcks(fs: SyncFs, deviceId: string): Promise<SyncAckRecord[]> {
  const folder = `${deviceDir(deviceId)}/acks`, out: SyncAckRecord[] = [];
  for (const name of await listFileNames(fs, folder)) {
    if (!name.endsWith(".json") || isConflictCopy(name)) continue;
    const parsed = parseEnvelope(await readJsonIfPresent(fs, `${folder}/${name}`), SYNC_SCHEMA.ack, parseAckPayload);
    if (parsed && parsed.deviceId === deviceId) out.push({ id: requestId(name), deviceId, payload: parsed.payload });
  }
  return out;
}
export async function readOwnRequests(fs: SyncFs, deviceId: string): Promise<SyncRequestRecord[]> {
  const folder = `${deviceDir(deviceId)}/requests`, out: SyncRequestRecord[] = [];
  for (const name of await listFileNames(fs, folder)) {
    if (!name.endsWith(".json") || isConflictCopy(name)) continue;
    const parsed = parseEnvelope(await readJsonIfPresent(fs, `${folder}/${name}`), SYNC_SCHEMA.request, parseRequestPayload);
    if (parsed && parsed.deviceId === deviceId) out.push({ id: requestId(name), deviceId, payload: parsed.payload });
  }
  return out;
}

/** What the requester shows under its card. */
export type SyncRequestState =
  | { readonly status: "sent"; readonly request: SyncRequestRecord }
  | { readonly status: "adopted" | "superseded" | "rejected"; readonly request: SyncRequestRecord; readonly ack: SyncAckPayload };

export interface SyncRequestServiceOptions {
  readonly fs: SyncFs;
  readonly device: SyncDeviceStore;
  readonly service: CompanyService;
  readonly deviceName: (deviceId: string) => string;
  readonly now?: () => number;
  readonly newId?: () => string;
  readonly timers?: SyncTimers;
  readonly refreshMs?: number;
  readonly debounceMs?: number;
  readonly onError?: (error: unknown) => void;
  /** Called after a request is adopted or acked, so surfaces refresh. */
  readonly changed?: () => void;
}

/**
 * Both roles on one device: send requests to other devices, and act on requests aimed at this device.
 * Acting is idempotent: an ack file is the durable "already handled" mark, and the in-memory set shadows it.
 */
export class SyncRequestService {
  private readonly acked = new Set<string>();
  /** dispatchId:reportAt → the adopted request, so a second answer gets "superseded". */
  private readonly adopted = new Map<string, { requestId: string; deviceId: string; answer: string }>();
  private readonly states = new Map<string, SyncRequestState>();
  private readonly listeners = new Set<() => void>();
  private loaded: Promise<void> | null = null;
  private flight: Promise<void> | null = null;
  private again = false;
  private timer: number | null = null;
  private interval: number | null = null;
  private readonly timers: SyncTimers;
  private readonly now: () => number;
  constructor(private readonly options: SyncRequestServiceOptions) { this.timers = options.timers ?? windowTimers(); this.now = options.now ?? (() => Date.now()); }
  get deviceId(): string { return this.options.device.deviceId; }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private notify(): void { for (const listener of [...this.listeners]) listener(); this.options.changed?.(); }

  start(): void {
    if (this.interval !== null) return;
    this.interval = this.timers.setInterval(() => { void this.scan(); }, this.options.refreshMs ?? 60_000);
    void this.scan();
  }
  stop(): void {
    if (this.interval !== null) { this.timers.clearInterval(this.interval); this.interval = null; }
    if (this.timer !== null) { this.timers.clearTimeout(this.timer); this.timer = null; }
    this.listeners.clear();
  }
  noteVaultChange(path: string): void {
    if (!path.startsWith(`${SYNC_DEVICES_DIR}/`) || !/\/(?:requests|acks)\//u.test(path)) return;
    if (this.timer !== null) return;
    this.timer = this.timers.setTimeout(() => { this.timer = null; void this.scan(); }, this.options.debounceMs ?? 500);
  }

  /* ===== requester side ===== */
  /** Pending and recently answered requests this device sent, newest first. */
  sent(): SyncRequestState[] { return [...this.states.values()].sort((a, b) => b.request.payload.createdAt - a.request.payload.createdAt); }
  stateFor(dispatchId: string, reportAt?: number): SyncRequestState | undefined {
    return this.sent().find(state => state.request.payload.dispatchId === dispatchId && (reportAt === undefined || state.request.payload.reportAt === reportAt));
  }
  async send(payload: Omit<SyncRequestPayload, "createdAt">): Promise<SyncRequestRecord> {
    await this.ensureLoaded();
    const id = this.options.newId?.() ?? `req-${crypto.randomUUID()}`;
    const full: SyncRequestPayload = { ...payload, createdAt: this.now() };
    await this.options.device.write(`requests/${id}.json`, SYNC_SCHEMA.request, full);
    const record = { id, deviceId: this.deviceId, payload: full };
    this.states.set(id, { status: "sent", request: record });
    this.notify();
    return record;
  }

  /* ===== executor side ===== */
  private ensureLoaded(): Promise<void> {
    return this.loaded ??= (async () => {
      await this.options.device.open();
      for (const ack of await readOwnAcks(this.options.fs, this.deviceId)) {
        this.acked.add(ack.id);
        if (ack.payload.status === "adopted" && ack.payload.reportAt !== undefined) this.adopted.set(`${ack.payload.dispatchId}:${ack.payload.reportAt}`, { requestId: ack.id, deviceId: ack.payload.requesterDeviceId, answer: "" });
      }
      for (const request of await readOwnRequests(this.options.fs, this.deviceId)) if (!this.states.has(request.id)) this.states.set(request.id, { status: "sent", request });
    })();
  }
  /** One pass: act on requests for this device, then refresh acks for requests this device sent. */
  scan(): Promise<void> {
    if (this.flight) { this.again = true; return this.flight; }
    this.flight = (async () => {
      do {
        this.again = false;
        try { await this.ensureLoaded(); await this.processIncoming(); await this.refreshOutgoing(); }
        catch (error) { this.options.onError?.(error); }
      } while (this.again);
    })().finally(() => { this.flight = null; });
    return this.flight;
  }
  private async processIncoming(): Promise<void> {
    let changed = false;
    for (const request of await readRequestsFor(this.options.fs, this.deviceId)) {
      if (this.acked.has(request.id)) continue;
      const ack = await this.act(request);
      await this.options.device.write(`acks/${request.id}.json`, SYNC_SCHEMA.ack, ack);
      this.acked.add(request.id);
      changed = true;
    }
    if (changed) this.notify();
  }
  private async act(request: SyncRequestRecord): Promise<SyncAckPayload> {
    const { service } = this.options, p = request.payload;
    const base = { requestId: request.id, requesterDeviceId: request.deviceId, dispatchId: p.dispatchId, at: this.now(), ...(p.reportAt !== undefined ? { reportAt: p.reportAt } : {}) };
    const d = service.dispatchOf(p.dispatchId);
    if (!d || !service.owns(d)) return { ...base, status: "rejected", reason: "该任务不在本设备上。" };
    if (p.kind === "answer_decision") {
      const key = `${p.dispatchId}:${p.reportAt ?? 0}`;
      const previous = this.adopted.get(key);
      const open = d.status === "waiting" && d.report?.outcome === "need_decision" && !d.answer && (p.reportAt === undefined || d.report.at === p.reportAt);
      if (!open) {
        if (previous) return { ...base, status: "superseded", reason: `已被${this.options.deviceName(previous.deviceId)}回答：${previous.answer || "（见项目记录）"}`, adoptedRequestId: previous.requestId, adoptedDeviceId: previous.deviceId };
        return { ...base, status: "rejected", reason: d.status === "waiting" ? "问题已更新。请重新查看后再回答。" : "该任务已不再等待回答。" };
      }
      if (!p.answer) return { ...base, status: "rejected", reason: "请求中没有回答内容。" };
      await service.answerDecision(p.dispatchId, p.answer);
      if (service.dispatchOf(p.dispatchId)?.answer !== p.answer) return { ...base, status: "rejected", reason: "该任务未能采纳此回答。请重新查看后再回答。" };
      this.adopted.set(key, { requestId: request.id, deviceId: request.deviceId, answer: p.answer });
      return { ...base, status: "adopted", reason: "已采纳。" };
    }
    if (p.kind === "stop_dispatch") {
      if (d.status === "done" || d.status === "failed" || d.status === "stopped") return { ...base, status: "rejected", reason: "该任务已结束。" };
      await service.stop(d.routerConversationId, d.id);
      return { ...base, status: "adopted", reason: "已停止。" };
    }
    if (!p.text) return { ...base, status: "rejected", reason: "请求中没有内容。" };
    if (d.status === "done" || d.status === "failed" || d.status === "stopped") return { ...base, status: "rejected", reason: "该任务已结束。" };
    await service.message(d.routerConversationId, d.id, p.text);
    return { ...base, status: "adopted", reason: "已转给员工。" };
  }
  private async refreshOutgoing(): Promise<void> {
    let changed = false;
    for (const [id, state] of this.states) {
      if (state.status !== "sent") continue;
      const ack = await readAck(this.options.fs, state.request.payload.targetDeviceId, id);
      if (!ack) continue;
      this.states.set(id, { status: ack.payload.status, request: state.request, ack: ack.payload });
      changed = true;
    }
    if (changed) this.notify();
  }
}

export type { SyncEnvelope };
