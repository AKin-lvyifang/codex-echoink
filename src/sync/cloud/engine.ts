import type { SyncFs } from "../fs";
import { SYNC_DEVICES_DIR, SYNC_ROOT, windowTimers, type SyncTimers } from "../types";
import { CloudApiError, CloudNetworkError, cloudRetryDelay, isCloudRateLimited, type CloudChange, type CloudLivePage, type CloudSyncClientPort, type CloudUsage } from "./client";
import { KEY_CHECK_PATH, SyncDecryptError, base64ToBytes, decryptEntry, encryptEntry, openMeta, pathToken, sealMeta, sha256Hex, sealKeyCheck, verifyKeyCheck, type SyncMasterKey } from "./crypto";
import type { CloudHistoryPort } from "./history";
import { conflictCopyPath, mergeCloudText } from "./merge";
import { cloudFolderExcludedBy, cloudPathAllowed, cloudPathInScope, cloudPathReceivable, isCloudText, isMergeableCloudText, type CloudSyncScope } from "./scope";
export type { CloudSyncScope } from "./scope";

export interface CloudFs extends SyncFs { readBinary(path: string): Promise<ArrayBuffer>; writeBinary(path: string, data: ArrayBuffer): Promise<void>; rmdir(path: string, recursive: boolean): Promise<void> }
export interface CloudStatePort { load(): unknown; save(value: unknown): void | Promise<void> }
/** Local merge bases, under the excluded plugin/configuration directory. */
export interface CloudBasePort { read(path: string): Promise<string | null>; write(path: string, text: string): Promise<void>; remove(path: string): Promise<void> }
export interface CloudSyncEngineOptions {
  readonly fs: CloudFs;
  readonly client: CloudSyncClientPort;
  readonly key: SyncMasterKey;
  readonly deviceId: string;
  readonly mirrorDeviceId?: string;
  readonly deviceName: string;
  readonly deviceKind: "desktop" | "phone" | "tablet";
  readonly scope: () => CloudSyncScope;
  readonly ignoredRoots?: readonly string[];
  readonly caseInsensitivePaths?: boolean;
  readonly state: CloudStatePort;
  readonly base: CloudBasePort;
  readonly timers?: SyncTimers;
  readonly now?: () => number;
  readonly debounceMs?: number;
  readonly smallFileLimit?: number;
  readonly onError?: (error: unknown, retryDelayMs?: number) => void;
  readonly onDevices?: (devices: CloudUsage["devices"]) => void;
  /** Key verified, before the first local scan or upload; persist the startup choice here. */
  readonly onReady?: () => void | Promise<void>;
  readonly onLocalWrite?: (path: string) => void;
  /** Conflict records. Without it, conflicts fall back to copies beside the note. */
  readonly history?: CloudHistoryPort;
  /** A conflict replaced one version of this path (the other went to history). */
  readonly onConflict?: (path: string) => void;
}
/** Paths the user changed this recently go first, one by one, ahead of any backlog. */
const HOT_WINDOW_MS = 30_000, HOT_MAX = 8;
/** put-batch limits: the service accepts 64 files and a 2 MB body (base64 inflates by a third). */
const BATCH_FILES = 64, BATCH_BYTES = 1_200_000;
/** Stored hash of a synced folder marker (folders have no content). */
const FOLDER_HASH = "folder";
const parentOf = (path: string) => path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
interface Prepared { path: string; entry: Entry; rev: number; hash: string; bytes: Uint8Array | null; blob: Uint8Array | null; generation: number; editedAt: number; meta?: string; folder?: boolean }
export interface CloudSyncStatus {
  readonly phase: "idle" | "syncing" | "offline" | "rate-limited" | "error" | "read-only" | "stopped";
  readonly lastError: string | null;
  readonly retryAt: number | null;
  readonly usedBytes: number;
  readonly quotaBytes: number;
  readonly pending: number;
  readonly lastSyncAt: number | null;
  readonly cursor: number;
  readonly live: boolean;
  readonly conflicts: number;
  readonly nearQuota: boolean;
  /** The note currently being transferred, so editors can show their own progress. */
  readonly activePath: string | null;
  readonly activeDirection: "up" | "down" | null;
}
interface Entry {
  token: string;
  /** This device's upload revision; remote writers have independent revision clocks. */
  rev: number;
  sha256: string;
  remote?: { deviceId: string; rev: number };
  applied?: Record<string, number>;
  attempt?: { rev: number; sha256: string };
  conflictOnly?: boolean;
  /** When the version on disk was last edited, on the device that edited it (ms). */
  editedAt?: number;
  /** A folder marker: the folder exists on its devices, possibly empty. */
  folder?: boolean;
  /** Service cursor of this device's latest upload; remote changes below it were written concurrently. */
  uploadCursor?: number;
  /** The version on disk is this device's own upload (not yet superseded by a remote version). */
  localEdit?: boolean;
  /** Re-publishing a conflict winner from another device: keep its original edit time. */
  republish?: boolean;
}
interface Deferred { path: string; change: CloudChange }
interface EngineState { version: 2; cursor: number; keyEpoch: number; entries: Record<string, Entry>; pending: string[]; deferred: Record<string, Deferred>; replayCursor?: number }
const emptyState = (keyEpoch = 0): EngineState => ({ version: 2, cursor: 0, keyEpoch, entries: {}, pending: [], deferred: {} });
const encoder = new TextEncoder(), decoder = new TextDecoder();
const refKey = (change: CloudChange) => `${change.deviceId}\0${change.path}`;
const durableChange = (change: CloudChange): CloudChange => ({ deviceId: change.deviceId, path: change.path, rev: change.rev, size: change.size, sha256: change.sha256, deleted: change.deleted, cursor: change.cursor, ...(change.meta ? { meta: change.meta } : {}) });

/** One serialized loop owns scans, cursor reads, deferred applies and acknowledged uploads. */
export class CloudSyncEngine {
  private state = emptyState();
  private status: CloudSyncStatus = { phase: "stopped", lastError: null, retryAt: null, usedBytes: 0, quotaBytes: 0, pending: 0, lastSyncAt: null, cursor: 0, live: false, conflicts: 0, nearQuota: false, activePath: null, activeDirection: null };
  private readonly listeners = new Set<() => void>();
  private readonly dirty = new Set<string>();
  private readonly generations = new Map<string, number>();
  private readonly tokenPaths = new Map<string, string>();
  private readonly casePaths = new Map<string, string>();
  private readonly names = new Map<string, string>();
  private readonly timers: SyncTimers;
  private readonly now: () => number;
  private timer: number | null = null;
  private retryTimer: number | null = null;
  private retryBackoff = 1_000;
  private rateLimitUntil: number | null = null;
  private flight: Promise<void> | null = null;
  private again = false;
  private usageRequested = false;
  private live: { close(): void } | null = null;
  private liveTimer: number | null = null;
  private liveBackoff = 1_000;
  private livePages: CloudLivePage[] = [];
  private started = false;
  private initialized = false;
  private scanRequested = true;
  private replayRequested = false;
  private smallLimit: number;
  private readOnly = false;
  private readonly hot = new Map<string, number>();
  private batchUnsupported = false;
  constructor(private readonly options: CloudSyncEngineOptions) {
    this.timers = options.timers ?? windowTimers(); this.now = options.now ?? (() => Date.now()); this.smallLimit = options.smallFileLimit ?? 65_536;
  }
  get deviceId(): string { return this.options.deviceId; }
  snapshot(): CloudSyncStatus { return this.status; }
  /** Whether this path is synchronized at all under the current folder choices. */
  tracks(path: string): boolean { return this.inScope(path); }
  /** Edit time of the version this device last exchanged with the cloud for this path; null when unknown. */
  cloudVersionAt(path: string): number | null { const entry = this.state.entries[path]; return entry?.sha256 ? entry.editedAt ?? null : null; }
  /** A local change to this path still waits for its upload. */
  hasPending(path: string): boolean { return this.dirty.has(path); }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private set(patch: Partial<CloudSyncStatus>): void {
    const next = { ...this.status, ...patch };
    this.status = { ...next, nearQuota: next.quotaBytes > 0 && next.usedBytes >= next.quotaBytes * .9 };
    for (const listener of [...this.listeners]) listener();
  }
  private get ownMirror(): string { return `${SYNC_DEVICES_DIR}/${this.options.mirrorDeviceId ?? this.options.deviceId}`; }
  private inScope(path: string): boolean { return cloudPathInScope(path, this.options.scope(), this.ownMirror, this.options.ignoredRoots) && cloudPathInScope(this.casePath(path), this.options.scope(), this.ownMirror, this.options.ignoredRoots); }
  /** Folders follow the folder choices only; the attachment switch is about files. */
  private folderInScope(path: string): boolean {
    return cloudPathAllowed(path, this.options.ignoredRoots) && path !== SYNC_ROOT && !path.startsWith(`${SYNC_ROOT}/`) && !cloudFolderExcludedBy(path, this.options.scope().excludedFolders);
  }
  private receives(path: string): boolean { return cloudPathReceivable(path, this.options.scope(), this.ownMirror, this.options.ignoredRoots) && cloudPathReceivable(this.casePath(path), this.options.scope(), this.ownMirror, this.options.ignoredRoots); }
  async start(retryAt = 0): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.loadState();
    if (retryAt > this.now()) { this.pauseUntil(retryAt); return; }
    await this.sync(); this.openLive(); await this.flight;
  }
  stop(): void {
    this.started = false; this.livePages = []; this.hot.clear();
    for (const id of [this.timer, this.liveTimer, this.retryTimer]) if (id !== null) this.timers.clearTimeout(id);
    this.timer = this.liveTimer = this.retryTimer = null;
    this.rateLimitUntil = null; this.usageRequested = false;
    this.live?.close(); this.live = null; this.set({ phase: "stopped", retryAt: null, live: false, activePath: null, activeDirection: null });
  }
  scopeChanged(): void { if (!this.started) return; this.scanRequested = true; this.wake(); }
  noteVaultChange(path: string, kind: "create" | "modify" | "delete" | "rename", oldPath?: string): void {
    if (!this.started) return;
    if (kind === "delete" || kind === "rename") {
      const removed = kind === "rename" ? oldPath : path;
      if (removed) for (const [key, actual] of this.casePaths) if (actual === removed || actual.startsWith(`${removed}/`)) this.casePaths.delete(key);
    }
    if (kind !== "delete") {
      let current = ""; for (const part of path.split("/")) { current = current ? `${current}/${part}` : part; this.indexPath(current); }
    }
    if (kind === "rename" || kind === "delete") this.scanRequested = true;
    for (const candidate of [path, ...(kind === "rename" && oldPath ? [oldPath] : [])]) if (this.inScope(candidate)) {
      this.generations.set(candidate, (this.generations.get(candidate) ?? 0) + 1); this.dirty.add(candidate);
      if (kind !== "delete" && candidate === path) this.hot.set(path, this.now());
    }
    if (this.dirty.size || this.scanRequested) this.schedule();
  }
  async flush(): Promise<void> {
    if (this.timer !== null) { this.timers.clearTimeout(this.timer); this.timer = null; }
    await this.sync();
  }
  refreshUsage(): Promise<void> {
    this.usageRequested = true;
    return this.sync(true);
  }
  private updateUsage(usage: Pick<CloudUsage, "usedBytes" | "quotaBytes" | "readOnly" | "devices">): void {
    if (!this.started) return;
    this.readOnly = usage.readOnly; this.rememberDeviceNames(usage.devices);
    this.options.onDevices?.(usage.devices);
    this.set({ usedBytes: usage.usedBytes, quotaBytes: usage.quotaBytes });
  }
  rememberDeviceNames(devices: readonly { deviceId: string; name: string }[]): void { for (const d of devices) this.names.set(d.deviceId, d.name); }
  private async initialize(): Promise<void> {
    const registration = await this.options.client.register({ deviceId: this.options.deviceId, name: this.options.deviceName, kind: this.options.deviceKind });
    this.smallLimit = registration.smallFileLimit || this.smallLimit; this.updateUsage(registration);
    if (registration.keyEpoch !== this.state.keyEpoch) await this.resetState(registration.keyEpoch);
    await this.ensureKeyCheck(); await this.options.onReady?.(); this.initialized = true;
  }
  private async resetState(epoch: number): Promise<void> {
    this.state = emptyState(epoch); this.dirty.clear(); this.tokenPaths.clear(); this.scanRequested = true; this.replayRequested = false; await this.saveState();
  }
  private indexPath(path: string): void { this.casePaths.set(path.normalize("NFC").toLowerCase(), path); }
  private async scanLocal(): Promise<void> {
    this.casePaths.clear(); const present = new Set<string>(), folders = new Set<string>();
    const walk = async (folder: string): Promise<void> => {
      const listed = await this.options.fs.list(folder);
      if (folder && !listed.files.length && !listed.folders.length && this.folderInScope(folder)) folders.add(folder);
      for (const path of listed.files) { this.indexPath(path); if (this.inScope(path)) present.add(path); }
      for (const sub of listed.folders) {
        this.indexPath(sub);
        if (!cloudPathAllowed(sub, this.options.ignoredRoots)) continue;
        // Device mailboxes have their own single-writer scope, even when EchoInk is unchecked.
        if (sub === "EchoInk" || sub === "EchoInk/同步数据" || sub === SYNC_DEVICES_DIR || cloudPathInScope(sub, { ...this.options.scope(), includeAttachments: true }, this.ownMirror, this.options.ignoredRoots)) await walk(sub);
      }
    };
    await walk("");
    for (const path of present) this.dirty.add(path);
    // Empty folders travel as markers (folders with files are created by their files); a marker is withdrawn when its folder is gone.
    for (const folder of folders) if (this.state.entries[folder]?.sha256 !== FOLDER_HASH) this.dirty.add(folder);
    for (const [path, entry] of Object.entries(this.state.entries)) {
      if (entry.folder) { if (entry.sha256 && !folders.has(path) && this.folderInScope(path) && !await this.options.fs.exists(path)) this.dirty.add(path); continue; }
      if (entry.sha256 && !entry.conflictOnly && this.inScope(path) && !present.has(path) && !await this.options.fs.exists(path)) this.dirty.add(path);
    }
    for (const path of [...this.dirty]) if (!this.inScope(path) && !(this.folderInScope(path) && (folders.has(path) || this.state.entries[path]?.folder))) this.dirty.delete(path);
  }
  private schedule(): void {
    if (this.timer !== null || this.rateLimitUntil !== null) return;
    this.timer = this.timers.setTimeout(() => { this.timer = null; void this.sync(); }, this.options.debounceMs ?? 250);
  }
  private sync(usageOnly = false): Promise<void> {
    if (!this.started || this.rateLimitUntil !== null) return Promise.resolve();
    if (!usageOnly) this.again = true;
    if (this.flight) return this.flight;
    this.flight = Promise.resolve().then(async () => {
      do {
        const runSync = this.again;
        this.again = false;
        try {
          if (runSync) await this.syncChanges();
          if (this.usageRequested && this.started) await this.refreshRequestedUsage();
          if (runSync && this.started) {
            this.retryBackoff = 1_000;
            if (this.retryTimer !== null) { this.timers.clearTimeout(this.retryTimer); this.retryTimer = null; }
            this.set({ phase: this.readOnly ? "read-only" : "idle", lastError: null, lastSyncAt: this.now(), pending: this.dirty.size, cursor: this.state.cursor, activePath: null, activeDirection: null });
          }
        } catch (error) {
          this.again = false;
          const rateLimited = isCloudRateLimited(error);
          // Close the gate before persisting pending files. Wakes can arrive while storage is writing.
          if (rateLimited) this.rateLimit(error);
          await this.saveState();
          if (!rateLimited) this.fail(error);
        }
      } while (this.started && this.rateLimitUntil === null && (this.again || this.usageRequested));
    }).finally(() => { this.flight = null; });
    return this.flight;
  }
  private async syncChanges(): Promise<void> {
    if (!this.started) return;
    this.set({ phase: this.readOnly ? "read-only" : "syncing", retryAt: null, pending: this.dirty.size });
    if (!this.initialized) await this.initialize();
    if (!this.started) return;
    if (this.scanRequested) { this.scanRequested = false; await this.scanLocal(); }
    if (!this.readOnly && this.hotDirty().length) await this.push(true);
    await this.pull();
    if (this.replayRequested || this.state.replayCursor !== undefined) { this.state.replayCursor ??= 0; this.replayRequested = false; await this.replay(); }
    for (const item of Object.values(this.state.deferred).sort((a, b) => a.change.cursor - b.change.cursor)) if (this.receives(item.path)) await this.apply(item.change);
    if (!this.readOnly) await this.push();
    await this.saveState();
  }
  private async refreshRequestedUsage(): Promise<void> {
    this.usageRequested = false;
    try { this.updateUsage(await this.options.client.usage()); }
    catch (error) {
      if (isCloudRateLimited(error)) { this.usageRequested = true; throw error; }
    }
  }
  private rateLimit(error: CloudApiError): void {
    const delay = cloudRetryDelay(error, this.retryBackoff);
    if (this.started) {
      this.retryBackoff = Math.min(this.retryBackoff * 2, 60_000);
      this.pauseUntil(Math.min(Number.MAX_SAFE_INTEGER, this.now() + delay));
    }
    this.options.onError?.(error, delay);
  }
  private pauseUntil(retryAt: number): void {
    this.rateLimitUntil = retryAt;
    for (const id of [this.timer, this.liveTimer, this.retryTimer]) if (id !== null) this.timers.clearTimeout(id);
    this.timer = this.liveTimer = this.retryTimer = null;
    this.scheduleRateLimitRetry(retryAt);
    this.set({ phase: "rate-limited", lastError: "RATE_LIMITED", retryAt, pending: this.dirty.size, activePath: null, activeDirection: null });
  }
  private scheduleRateLimitRetry(retryAt: number): void {
    const remaining = retryAt - this.now();
    this.retryTimer = this.timers.setTimeout(() => {
      this.retryTimer = null;
      void this.resumeAfterRateLimit(retryAt);
    }, Math.min(Math.max(0, remaining), 2_147_483_647));
  }
  private async resumeAfterRateLimit(retryAt: number): Promise<void> {
    await this.flight?.catch(() => {});
    if (!this.started || this.rateLimitUntil !== retryAt) return;
    if (this.now() < retryAt) { this.scheduleRateLimitRetry(retryAt); return; }
    this.rateLimitUntil = null;
    this.wake();
  }
  private fail(error: unknown): void {
    if (!this.started) return;
    this.options.onError?.(error);
    const patch: { -readonly [K in keyof CloudSyncStatus]?: CloudSyncStatus[K] } = { pending: this.dirty.size, lastError: error instanceof Error ? error.message : String(error), phase: "error", activePath: null, activeDirection: null };
    if (error instanceof CloudNetworkError) patch.phase = "offline";
    if (error instanceof CloudApiError) {
      if (error.code === "SYNC_READ_ONLY") { this.readOnly = true; patch.phase = "read-only"; patch.lastError = null; }
      else if (error.code === "QUOTA_EXCEEDED") { patch.lastError = "QUOTA_EXCEEDED"; patch.usedBytes = typeof error.extra.usedBytes === "number" ? error.extra.usedBytes : this.status.usedBytes; patch.quotaBytes = typeof error.extra.quotaBytes === "number" ? error.extra.quotaBytes : this.status.quotaBytes; }
    }
    this.set(patch);
    const retryable = !(error instanceof SyncDecryptError) && (!(error instanceof CloudApiError) || error.status >= 500 || error.code.startsWith("OBJECT_"));
    if (retryable && this.retryTimer === null) {
      const after = error instanceof CloudApiError ? cloudRetryDelay(error, this.retryBackoff) : this.retryBackoff;
      this.retryTimer = this.timers.setTimeout(() => { this.retryTimer = null; this.wake(); }, after);
      this.retryBackoff = Math.min(this.retryBackoff * 2, 60_000);
    }
  }
  private async ensureKeyCheck(): Promise<void> {
    let cursor = 0;
    for (;;) {
      const page = await this.options.client.changes(cursor);
      const existing = page.changes.find(c => c.path === KEY_CHECK_PATH && !c.deleted);
      if (existing) { const blob = await this.download(existing); if (!blob || !await verifyKeyCheck(this.options.key, blob)) throw new SyncDecryptError("DECRYPT"); return; }
      if (!page.more) break; cursor = page.next;
    }
    if (!this.readOnly) await this.uploadBlob(KEY_CHECK_PATH, 1, await sealKeyCheck(this.options.key));
  }
  private async uploadBlob(token: string, rev: number, blob: Uint8Array, meta?: string): Promise<{ status: "committed" | "already" | "stale"; cursor?: number }> {
    const blobHash = await sha256Hex(blob);
    if (blob.length <= this.smallLimit) {
      const result = await this.options.client.putSmall({ path: token, rev, size: blob.length, sha256: blobHash, content: blob, ...(meta ? { meta } : {}) });
      if (result.usedBytes !== undefined) this.set({ usedBytes: result.usedBytes }); return { status: result.status, cursor: result.cursor };
    }
    const [link] = await this.options.client.uploadUrls([{ path: token, rev, size: blob.length, sha256: blobHash }]);
    if (!link || link.status === "stale" || !link.url) return { status: "stale" };
    await this.options.client.putObject(link.url, blob);
    const result = await this.options.client.commit([{ path: token, rev, size: blob.length, ...(meta ? { meta } : {}) }]);
    if (result.usedBytes !== undefined) this.set({ usedBytes: result.usedBytes }); return { status: result.results[0]?.status ?? "stale", cursor: result.cursor };
  }
  private async pull(): Promise<void> {
    let changed = false;
    for (;;) {
      if (!this.started) return;
      const pushed = this.livePages.shift();
      let usePush = !!pushed && pushed.fromCursor <= this.state.cursor && pushed.keyEpoch === this.state.keyEpoch;
      if (usePush) for (const change of pushed!.changes) if (!change.deleted && (change.content !== undefined
        ? await sha256Hex(base64ToBytes(change.content)) !== change.sha256 : !change.url || !change.expiresAt || change.expiresAt <= this.now())) { usePush = false; break; }
      const page = usePush ? { ...pushed!, more: false, next: pushed!.cursor } : await this.options.client.changes(this.state.cursor);
      if (page.keyEpoch !== this.state.keyEpoch) { await this.resetState(page.keyEpoch); await this.scanLocal(); continue; }
      for (const change of page.changes) {
        if (change.deviceId === this.options.deviceId) await this.observeOwn(change);
        else { await this.apply(change); changed = true; }
        // Only manifests actually processed here advance the download cursor. Never upload receipts.
        this.state.cursor = Math.max(this.state.cursor, change.cursor);
      }
      this.state.cursor = Math.max(this.state.cursor, page.next); await this.saveState();
      if (!page.more && this.livePages.length === 0) break;
    }
    if (changed) this.updateUsage(await this.options.client.usage());
  }
  /** An independent compensation pass; applied versions are skipped before fetching bodies. */
  private async replay(): Promise<void> {
    let cursor = this.state.replayCursor ?? 0;
    for (;;) {
      const page = await this.options.client.changes(cursor);
      for (const change of page.changes) { if (change.deviceId === this.options.deviceId) await this.observeOwn(change); else await this.apply(change, true); }
      if (!page.more) { delete this.state.replayCursor; break; }
      cursor = page.next; this.state.replayCursor = cursor; await this.saveState();
    }
  }
  private async download(change: CloudChange): Promise<Uint8Array | null> {
    let bytes: Uint8Array | null = null;
    if (change.content !== undefined) bytes = base64ToBytes(change.content);
    else if (change.url && change.expiresAt && change.expiresAt > this.now()) bytes = await this.options.client.getObject(change.url);
    else {
      const [item] = await this.options.client.downloadUrls([{ deviceId: change.deviceId, path: change.path, rev: change.rev }]);
      if (!item || item.status === "missing") return null;
      bytes = item.status === "inline" && item.content ? base64ToBytes(item.content) : item.url ? await this.options.client.getObject(item.url) : null;
    }
    if (bytes && await sha256Hex(bytes) !== change.sha256) throw new CloudApiError("HASH_MISMATCH", 409);
    return bytes;
  }
  private entry(path: string, token: string): Entry {
    this.tokenPaths.set(token, path);
    return this.state.entries[path] ??= { token, rev: 0, sha256: "", applied: {} };
  }
  private applied(path: string, entry: Entry, change: CloudChange): void {
    (entry.applied ??= {})[change.deviceId] = change.rev; entry.remote = { deviceId: change.deviceId, rev: change.rev };
    this.state.entries[path] = entry; delete this.state.deferred[refKey(change)];
  }
  private defer(path: string, change: CloudChange): void {
    this.entry(path, change.path); this.state.deferred[refKey(change)] = { path, change: durableChange(change) };
  }
  private casePath(path: string): string {
    if (!this.options.caseInsensitivePaths) return path;
    let resolved = "";
    for (const part of path.split("/")) { const candidate = resolved ? `${resolved}/${part}` : part; resolved = this.casePaths.get(candidate.normalize("NFC").toLowerCase()) ?? candidate; }
    return resolved;
  }
  private async apply(change: CloudChange, replaying = false): Promise<void> {
    if (change.path === KEY_CHECK_PATH) return;
    const knownPath = this.tokenPaths.get(change.path), known = knownPath ? this.state.entries[knownPath] : undefined;
    if (known?.applied && (known.applied[change.deviceId] ?? 0) >= change.rev) return;
    if (knownPath && !this.receives(knownPath)) { this.defer(knownPath, change); return; }
    if (change.deleted) {
      if (!knownPath || !known) return;
      if (known.conflictOnly) { this.applied(knownPath, known, change); return; }
      if (known.folder) {
        // Only an empty folder goes; files still inside are removed by their own deletions, then the folder follows.
        known.sha256 = ""; this.dirty.delete(knownPath); this.applied(knownPath, known, change);
        if (await this.removeEmptyFolder(knownPath)) await this.removeEmptyParents(knownPath);
        return;
      }
      const bytes = await this.readBytes(knownPath), hash = bytes === null ? null : await sha256Hex(bytes);
      // A deletion written before this device's latest upload never saw that upload: keep the file; the upload restores it there.
      const concurrent = known.uploadCursor !== undefined && change.cursor < known.uploadCursor;
      if (bytes === null || (hash === known.sha256 && !concurrent) || knownPath.startsWith(`${SYNC_DEVICES_DIR}/`)) {
        if (bytes !== null) { await this.options.fs.remove(knownPath); this.options.onLocalWrite?.(knownPath); }
        known.sha256 = ""; this.dirty.delete(knownPath); await this.options.base.remove(knownPath);
        if (bytes !== null) await this.removeEmptyParents(knownPath);
      } else this.dirty.add(knownPath);
      this.applied(knownPath, known, change); return;
    }
    const blob = await this.download(change);
    if (!blob) {
      if (replaying) throw new CloudApiError("OBJECT_MISSING", 409);
      delete this.state.deferred[refKey(change)]; this.replayRequested = true; this.again = true; return;
    }
    const { path, body } = await decryptEntry(this.options.key, blob);
    if (!cloudPathAllowed(path, this.options.ignoredRoots)) return;
    if ((await openMeta(this.options.key, change.meta))?.folder) { await this.applyFolder(path, change); return; }
    if (!this.receives(path)) { this.defer(path, change); return; }
    if (!path.startsWith(`${SYNC_DEVICES_DIR}/`)) this.set({ activePath: path, activeDirection: "down" });
    const entry = this.entry(path, change.path), hash = await sha256Hex(body);
    const resolved = this.casePath(path);
    if (resolved !== path && !path.startsWith(`${SYNC_DEVICES_DIR}/`)) {
      await this.writeConflict(resolved, body, change.deviceId); entry.conflictOnly = true; this.applied(path, entry, change); return;
    }
    const localBytes = await this.readBytes(path), localHash = localBytes === null ? null : await sha256Hex(localBytes);
    if (path.startsWith(`${SYNC_DEVICES_DIR}/`)) {
      if (localHash !== hash) await this.writeBytes(path, body);
      entry.sha256 = hash; this.applied(path, entry, change); return;
    }
    if (!isCloudText(path)) {
      const changedHere = localHash !== entry.sha256 || (!!this.options.history && !!entry.localEdit);
      if (localHash !== null && localHash !== hash && changedHere) {
        if (this.options.history) await this.resolveConflict(path, entry, change, localBytes!, body, hash);
        else await this.writeConflict(path, body, change.deviceId);
      }
      else { if (localHash !== hash) await this.writeBytes(path, body); entry.sha256 = hash; entry.localEdit = false; this.dirty.delete(path); }
      this.applied(path, entry, change); return;
    }
    const theirs = decoder.decode(body), local = localBytes === null ? null : decoder.decode(localBytes), base = await this.options.base.read(path);
    if (local === null || local === theirs || local === base) {
      if (local !== theirs) await this.writeBytes(path, body);
      entry.sha256 = hash; entry.localEdit = false; entry.editedAt = (await openMeta(this.options.key, change.meta))?.editedAt;
      await this.options.base.write(path, theirs); this.applied(path, entry, change); this.dirty.delete(path); return;
    }
    let nextBase = theirs;
    const merged = isMergeableCloudText(path) ? mergeCloudText(base, local, theirs) : { ok: false as const, conflicts: 1 };
    if (merged.ok) {
      if (merged.text !== local) await this.writeBytes(path, merged.text === theirs ? body : encoder.encode(merged.text));
      if (merged.text === theirs) {
        entry.sha256 = hash; entry.localEdit = false; entry.editedAt = (await openMeta(this.options.key, change.meta))?.editedAt;
        this.dirty.delete(path);
      } else this.dirty.add(path);
    } else if (this.options.history) {
      const remoteWins = await this.resolveConflict(path, entry, change, localBytes!, body, hash);
      // A later restore of the losing text must compare against the winner of this conflict.
      if (!remoteWins) nextBase = local;
    } else { await this.writeConflict(path, body, change.deviceId); this.dirty.add(path); }
    await this.options.base.write(path, nextBase); this.applied(path, entry, change);
  }
  /** Recover this writer's revision clock after an interrupted acknowledgement or a fresh state cache. */
  private async observeOwn(change: CloudChange): Promise<void> {
    if (change.path === KEY_CHECK_PATH) return;
    const knownPath = this.tokenPaths.get(change.path), known = knownPath ? this.state.entries[knownPath] : undefined;
    if (known && change.rev <= known.rev && !known.attempt) return;
    if (change.deleted) { if (known) known.rev = Math.max(known.rev, change.rev); return; }
    const blob = await this.download(change); if (!blob) return;
    const { path, body } = await decryptEntry(this.options.key, blob);
    if ((await openMeta(this.options.key, change.meta))?.folder) {
      if (!this.folderInScope(path) || !await this.options.fs.exists(path)) return;
      const entry = this.entry(path, change.path); entry.folder = true; entry.rev = Math.max(entry.rev, change.rev); entry.sha256 = FOLDER_HASH; delete entry.attempt; return;
    }
    if (!this.inScope(path) || !await this.options.fs.exists(path)) return;
    const entry = this.entry(path, change.path); entry.rev = Math.max(entry.rev, change.rev); entry.sha256 = await sha256Hex(body); delete entry.attempt;
    if (isCloudText(path) && await this.options.base.read(path) === null) await this.options.base.write(path, decoder.decode(body));
  }
  private hotDirty(): string[] {
    const cutoff = this.now() - HOT_WINDOW_MS;
    for (const [path, at] of this.hot) if (at < cutoff) this.hot.delete(path);
    // A bulk import touches many files at once; only the most recent few count as "being edited", the rest go in batches.
    const hot = [...this.dirty].filter(path => this.hot.has(path)).sort((a, b) => this.hot.get(b)! - this.hot.get(a)!);
    for (const path of hot.slice(HOT_MAX)) this.hot.delete(path);
    return hot.slice(0, HOT_MAX);
  }
  private canBatch(): boolean { return !!this.options.client.putBatch && !this.batchUnsupported; }
  /** Hot paths one by one first; the backlog in batches, yielding whenever the user edits again or another device pushes. */
  private async push(hotOnly = false): Promise<void> {
    const hot = this.hotDirty(), hotSet = new Set(hot);
    const order = hotOnly ? hot : [...hot, ...[...this.dirty].filter(path => !hotSet.has(path))];
    const yieldNow = () => this.livePages.length > 0 || this.hotDirty().some(path => !hotSet.has(path));
    let batch: Prepared[] = [], batchBytes = 0;
    const flush = async () => { if (!batch.length) return; const items = batch; batch = []; batchBytes = 0; await this.uploadBatch(items); };
    for (const path of order) {
      if (!this.started) return;
      if (!this.dirty.has(path)) continue;
      const prepared = await this.prepare(path); if (!prepared) continue;
      const isHot = hotSet.has(path);
      if (!isHot && prepared.blob && prepared.blob.length <= this.smallLimit && this.canBatch()) {
        batch.push(prepared); batchBytes += prepared.blob.length;
        if (batch.length >= BATCH_FILES || batchBytes >= BATCH_BYTES) { await flush(); if (yieldNow()) { this.again = true; return; } }
        continue;
      }
      await flush();
      await this.uploadOne(prepared);
      if (!isHot && yieldNow()) { this.again = true; return; }
    }
    await flush();
  }
  /** Reads, hashes and encrypts one dirty path; null when nothing needs to go up. */
  private async prepare(path: string): Promise<Prepared | null> {
    const stat = await this.options.fs.stat(path), known = this.state.entries[path];
    if (stat?.type === "folder" || (!stat && known?.folder)) return this.prepareFolder(path, stat?.type === "folder");
    if (!this.inScope(path)) { this.dirty.delete(path); return null; }
    const generation = this.generations.get(path) ?? 0, bytes = await this.readBytes(path);
    const previous = this.state.entries[path];
    if (bytes === null && !previous?.sha256) { this.dirty.delete(path); return null; }
    const hash = bytes === null ? "" : await sha256Hex(bytes);
    if (bytes !== null && previous?.sha256 === hash && !previous.attempt) { this.dirty.delete(path); return null; }
    const entry = this.entry(path, previous?.token ?? await pathToken(this.options.key, path));
    const rev = entry.attempt?.sha256 === hash ? entry.attempt.rev : Math.max(entry.rev, entry.attempt?.rev ?? 0) + 1;
    entry.attempt = { rev, sha256: hash };
    const editedAt = entry.republish && entry.editedAt ? entry.editedAt : stat?.mtime || this.now();
    // Scope may have changed while reading/encrypting. Recheck before starting a new transfer.
    const blob = bytes === null ? null : await encryptEntry(this.options.key, path, bytes);
    if (!this.started || !this.inScope(path)) { this.dirty.delete(path); return null; }
    const meta = bytes === null ? undefined : await sealMeta(this.options.key, { editedAt });
    return { path, entry, rev, hash, bytes, blob, generation, editedAt, meta };
  }
  /** A folder marker: published while the folder exists, withdrawn when it is gone. */
  private async prepareFolder(path: string, present: boolean): Promise<Prepared | null> {
    const previous = this.state.entries[path];
    if (!this.folderInScope(path)) { this.dirty.delete(path); return null; }
    if (present && previous?.sha256 === FOLDER_HASH && !previous.attempt) { this.dirty.delete(path); return null; }
    if (!present && !previous?.sha256) { this.dirty.delete(path); return null; }
    if (present && !previous?.attempt) {
      // Only an empty folder needs a marker. A folder with content (moved in, unzipped) is scanned for its files instead.
      const listed = await this.options.fs.list(path);
      if (listed.files.length || listed.folders.length) { this.dirty.delete(path); this.scanRequested = true; this.again = true; return null; }
    }
    const entry = this.entry(path, previous?.token ?? await pathToken(this.options.key, path)); entry.folder = true;
    const hash = present ? FOLDER_HASH : "", rev = entry.attempt?.sha256 === hash ? entry.attempt.rev : Math.max(entry.rev, entry.attempt?.rev ?? 0) + 1;
    entry.attempt = { rev, sha256: hash };
    const editedAt = this.now(), empty = new Uint8Array();
    const blob = present ? await encryptEntry(this.options.key, path, empty) : null;
    const meta = present ? await sealMeta(this.options.key, { editedAt, folder: true }) : undefined;
    return { path, entry, rev, hash, bytes: present ? empty : null, blob, generation: this.generations.get(path) ?? 0, editedAt, meta, folder: true };
  }
  private async uploadOne(item: Prepared): Promise<void> {
    await this.saveState();
    if (!item.path.startsWith(`${SYNC_DEVICES_DIR}/`)) this.set({ activePath: item.path, activeDirection: "up" });
    const result = item.blob ? await this.uploadBlob(item.entry.token, item.rev, item.blob, item.meta)
      : await this.options.client.commit([{ path: item.entry.token, rev: item.rev, deleted: true }]).then(value => { if (value.usedBytes !== undefined) this.set({ usedBytes: value.usedBytes }); return { status: value.results[0]?.status ?? "stale", cursor: value.cursor }; });
    await this.finish(item, result.status, result.cursor);
    await this.saveState(); this.set({ pending: this.dirty.size });
  }
  private async uploadBatch(items: Prepared[]): Promise<void> {
    if (items.length === 1 || !this.canBatch()) { for (const item of items) await this.uploadOne(item); return; }
    await this.saveState();
    const first = items.find(item => !item.path.startsWith(`${SYNC_DEVICES_DIR}/`)); if (first) this.set({ activePath: first.path, activeDirection: "up" });
    let reply: Awaited<ReturnType<NonNullable<CloudSyncClientPort["putBatch"]>>>;
    try {
      reply = await this.options.client.putBatch!(await Promise.all(items.map(async item => ({ path: item.entry.token, rev: item.rev, size: item.blob!.length, sha256: await sha256Hex(item.blob!), content: item.blob!, ...(item.meta ? { meta: item.meta } : {}) }))));
    } catch (error) {
      // An older service without put-batch: remember, and send these one by one.
      if (error instanceof CloudApiError && (error.status === 404 || error.status === 405)) { this.batchUnsupported = true; for (const item of items) await this.uploadOne(item); return; }
      throw error;
    }
    if (reply.usedBytes !== undefined) this.set({ usedBytes: reply.usedBytes });
    const status = new Map<string, "committed" | "already" | "stale">(reply.results.map(r => [`${r.path}@${r.rev}`, r.status]));
    for (const item of items) await this.finish(item, status.get(`${item.entry.token}@${item.rev}`) ?? "stale", reply.cursor);
    await this.saveState(); this.set({ pending: this.dirty.size });
  }
  private async finish(item: Prepared, result: "committed" | "already" | "stale", cursor?: number): Promise<void> {
    const { path, entry, rev, hash, bytes, generation } = item;
    if (item.folder) {
      if (result === "stale") { this.replayRequested = true; this.again = true; entry.rev = rev; delete entry.attempt; return; }
      entry.rev = rev; entry.sha256 = hash; entry.localEdit = true; delete entry.attempt;
      if (cursor !== undefined) entry.uploadCursor = Math.max(entry.uploadCursor ?? 0, cursor);
      if ((this.generations.get(path) ?? 0) === generation) this.dirty.delete(path); else this.again = true;
      return;
    }
    if (result === "stale") { this.replayRequested = true; this.again = true; entry.rev = rev; delete entry.attempt; return; }
    entry.rev = rev; entry.sha256 = hash; entry.editedAt = item.editedAt; entry.localEdit = true; delete entry.attempt; delete entry.republish;
    if (cursor !== undefined) entry.uploadCursor = Math.max(entry.uploadCursor ?? 0, cursor);
    if (bytes !== null && isCloudText(path) && !path.startsWith(`${SYNC_DEVICES_DIR}/`) && await this.options.base.read(path) === null) await this.options.base.write(path, decoder.decode(bytes));
    if (bytes === null) await this.options.base.remove(path);
    if ((this.generations.get(path) ?? 0) === generation) { this.dirty.delete(path); this.hot.delete(path); } else this.again = true;
  }
  /**
   * Both sides changed the same passage (or a file that cannot be merged): the later edit wins everywhere, and the
   * replaced version goes to local history. Every device compares the same two edit times, so all of them agree.
   */
  private async resolveConflict(path: string, entry: Entry, change: CloudChange, local: Uint8Array, theirs: Uint8Array, theirsHash: string): Promise<boolean> {
    const remoteAt = (await openMeta(this.options.key, change.meta))?.editedAt ?? this.now();
    const localAt = (await this.options.fs.stat(path))?.mtime || this.now();
    const remoteWins = remoteAt > localAt || (remoteAt === localAt && change.deviceId > this.options.deviceId);
    if (remoteWins) {
      await this.options.history!.add(path, local, { editedAt: localAt, deviceName: this.options.deviceName });
      await this.writeBytes(path, theirs); entry.editedAt = remoteAt; this.hot.delete(path);
      // If our version already reached the cloud after theirs, publish theirs again so every device ends on the winner.
      if (entry.localEdit && entry.uploadCursor !== undefined && change.cursor < entry.uploadCursor) { entry.republish = true; this.dirty.add(path); }
      else { entry.sha256 = theirsHash; entry.localEdit = false; this.dirty.delete(path); }
    } else {
      await this.options.history!.add(path, theirs, { editedAt: remoteAt, deviceName: this.names.get(change.deviceId) ?? change.deviceId.slice(0, 8) });
      this.dirty.add(path);
    }
    this.set({ conflicts: this.status.conflicts + 1 }); this.options.onConflict?.(path);
    return remoteWins;
  }
  private openLive(): void {
    if (!this.started || !this.initialized || this.live || this.rateLimitUntil !== null) return;
    this.live = this.options.client.live(this.options.deviceId, {
      onOpen: (cursor, epoch) => { this.liveBackoff = 1_000; this.set({ live: true }); if (this.retryTimer === null && (cursor > this.state.cursor || epoch !== this.state.keyEpoch)) void this.sync(); },
      onCursor: cursor => { if (this.retryTimer === null && cursor > this.state.cursor) void this.sync(); },
      onChanges: page => { if (!this.started) return; if (this.livePages.length >= 64) this.livePages = []; this.livePages.push(page); if (this.retryTimer === null) void this.sync(); },
      onClose: () => { this.live = null; this.set({ live: false }); if (!this.started || this.rateLimitUntil !== null) return; this.liveTimer = this.timers.setTimeout(() => { this.liveTimer = null; this.wake(); }, this.liveBackoff); this.liveBackoff = Math.min(this.liveBackoff * 2, 60_000); }
    });
  }
  wake(): void { if (!this.started || this.rateLimitUntil !== null) return; void this.sync().then(() => this.openLive()); }
  private async applyFolder(path: string, change: CloudChange): Promise<void> {
    if (!this.folderInScope(path)) { this.entry(path, change.path).folder = true; this.applied(path, this.state.entries[path], change); return; }
    let current = ""; for (const part of path.split("/")) { current = current ? `${current}/${part}` : part; if (!await this.options.fs.exists(current)) { await this.options.fs.mkdir(current); this.options.onLocalWrite?.(current); } this.indexPath(current); }
    const entry = this.entry(path, change.path); entry.folder = true; entry.sha256 = FOLDER_HASH; entry.localEdit = false; this.applied(path, entry, change);
  }
  /** Removes the folder only when nothing is left in it; true when it is gone. */
  private async removeEmptyFolder(path: string): Promise<boolean> {
    if (!path || !await this.options.fs.exists(path)) return true;
    const listed = await this.options.fs.list(path);
    if (listed.files.length || listed.folders.length) return false;
    await this.options.fs.rmdir(path, false); this.options.onLocalWrite?.(path); return true;
  }
  /**
   * After a synced deletion, folders it left empty go too, upward, unless another device still publishes them as
   * folders (someone emptied a folder but kept it). Only folders the deletion emptied are checked.
   */
  private async removeEmptyParents(path: string): Promise<void> {
    for (let folder = parentOf(path); folder; folder = parentOf(folder)) {
      if (!this.folderInScope(folder)) return;
      const entry = this.state.entries[folder];
      if (entry?.folder && entry.sha256) return;
      if (!await this.removeEmptyFolder(folder)) return;
    }
  }
  private async readBytes(path: string): Promise<Uint8Array | null> {
    if (!await this.options.fs.exists(path)) return null;
    return new Uint8Array(await this.options.fs.readBinary(path));
  }
  private async writeBytes(path: string, bytes: Uint8Array): Promise<void> {
    const slash = path.lastIndexOf("/"), parent = slash < 0 ? "" : path.slice(0, slash); let current = "";
    for (const part of parent.split("/").filter(Boolean)) { current = current ? `${current}/${part}` : part; if (!await this.options.fs.exists(current)) await this.options.fs.mkdir(current); this.indexPath(current); }
    await this.options.fs.writeBinary(path, new Uint8Array(bytes).buffer); this.indexPath(path); this.options.onLocalWrite?.(path);
  }
  private async writeConflict(path: string, body: Uint8Array, deviceId: string): Promise<void> {
    const at = this.now(), label = this.names.get(deviceId) ?? deviceId.slice(0, 8); let sequence = 0, target: string;
    do { target = conflictCopyPath(path, label, at, sequence++); } while (await this.options.fs.exists(target));
    await this.writeBytes(target, body); this.set({ conflicts: this.status.conflicts + 1 });
  }
  private loadState(): void {
    const raw = this.options.state.load() as Partial<EngineState> | null;
    if (raw && typeof raw.cursor === "number" && raw.entries && typeof raw.entries === "object") {
      this.state = { ...emptyState(), ...raw, version: 2, entries: structuredClone(raw.entries), deferred: raw.deferred ?? {}, pending: raw.pending ?? [] };
      this.replayRequested = raw.version !== 2 || raw.replayCursor !== undefined;
      if (raw.version !== 2) this.state.replayCursor = 0;
      for (const [path, entry] of Object.entries(this.state.entries)) {
        this.tokenPaths.set(entry.token, path);
        if (!entry.applied) entry.applied = entry.sha256 && entry.remote ? { [entry.remote.deviceId]: entry.remote.rev } : {};
      }
      for (const path of this.state.pending) if (this.inScope(path)) this.dirty.add(path);
    }
    this.set({ cursor: this.state.cursor });
  }
  private async saveState(): Promise<void> {
    this.state.pending = [...this.dirty]; await this.options.state.save(JSON.parse(JSON.stringify(this.state))); this.set({ cursor: this.state.cursor });
  }
}
