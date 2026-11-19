import type { CloudSyncHistory } from "./history";
import type { CloudSyncSettings } from "./settings";
import type { SyncFs } from "../fs";
import type { SyncDeviceKind, SyncTimers } from "../types";
import { CloudSyncClient, cloudRetryDelay, isCloudRateLimited, type CloudSyncClientPort, type CloudTransport } from "./client";
import { deriveMasterKey, importMasterKey, type SyncMasterKey } from "./crypto";
import { CloudSyncEngine, type CloudBasePort, type CloudFs, type CloudStatePort, type CloudSyncStatus } from "./engine";
import { cloudFolderChoices, cloudFolderChildren, cloudFolderSelectable } from "./scope";

/**
 * Lifecycle around the engine, the same on desktop and mobile: turn on with the account password (the key is
 * derived here and cached device-locally), turn off, report status. The host hands in storage and transport.
 */
/** `deviceId` is the PRO device registered through /api/devices/activate; the sync service only knows that table. */
export interface CloudSyncSession { readonly apiUrl: string; readonly token: string; readonly accountId: string; readonly passwordSet: boolean; readonly deviceId: string | null }
export interface CloudSyncHostPorts {
  readonly fs: CloudFs;
  readonly transport: CloudTransport;
  /** This device's folder id in EchoInk/同步数据 (甲); the cloud identity comes from the session's PRO device id. */
  readonly deviceId: string;
  readonly deviceKind: SyncDeviceKind;
  readonly defaultDeviceName: string;
  readonly session: () => CloudSyncSession | null;
  readonly settings: () => CloudSyncSettings;
  readonly saveSettings: () => Promise<void>;
  /** Device-local, never in the Vault: the derived key material and the engine cursor/state. */
  readonly local: { load(key: string): unknown; save(key: string, value: unknown): void | Promise<void> };
  /** Prefers the OS keychain when the host has one. */
  readonly secret?: { get(id: string): Promise<string | null>; set(id: string, value: string): Promise<void> };
  readonly base: CloudBasePort;
  readonly ignoredRoots?: readonly string[];
  /** Every folder path the host already holds in memory; avoids disk listing for the scope tree and its search. */
  readonly folderIndex?: () => readonly string[];
  readonly caseInsensitivePaths?: boolean;
  readonly timers?: SyncTimers;
  readonly now?: () => number;
  readonly onLocalWrite?: (path: string) => void;
  readonly onError?: (error: unknown, retryDelayMs?: number) => void;
  /** Local version records for conflicts; without it conflicts fall back to copies beside the note. */
  readonly history?: CloudSyncHistory;
  /** Reuse account removal so its rights/device cache and subscribers refresh together. */
  readonly removeDevice?: (deviceId: string) => Promise<void>;
  readonly clientFactory?: (session: CloudSyncSession) => CloudSyncClientPort;
}
export interface CloudSyncView {
  readonly enabled: boolean;
  readonly signedIn: boolean;
  readonly passwordSet: boolean;
  /** The PRO device is enabled on this machine (账号与会员 → 在此设备启用). */
  readonly deviceReady: boolean;
  readonly keyReady: boolean;
  readonly enableRateLimited: boolean;
  readonly status: CloudSyncStatus | null;
  readonly devices: readonly { deviceId: string; name: string; kind: string; lastSeenAt: number }[];
}
const KEY_ID = "echoink-cloud-sync-key-v1";
const STATE_ID = "echoink-cloud-sync-state-v1";

export class CloudSyncController {
  private engine: CloudSyncEngine | null = null;
  private key: SyncMasterKey | null = null;
  private keyAccount = "";
  private devices: CloudSyncView["devices"] = [];
  private readonly listeners = new Set<() => void>();
  private starting: Promise<void> | null = null;
  private deviceRefresh: Promise<void> | null = null;
  private inactiveRetryAt = 0;
  private enableRateLimited = false;
  private cachedClient: { identity: string; client: CloudSyncClientPort } | null = null;
  private folderNames: string[] = [];
  private folderRevision = 0;
  private foldersDirty = true;
  private folderFlight: Promise<string[]> | null = null;
  private readonly now: () => number;
  constructor(private readonly ports: CloudSyncHostPorts) { this.now = ports.now ?? Date.now; }
  /** The id other devices see in the device list: the PRO device id when enabled. */
  get deviceId(): string { return this.ports.session()?.deviceId ?? this.ports.deviceId; }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private notify(): void { for (const listener of [...this.listeners]) listener(); }
  view(): CloudSyncView {
    const session = this.ports.session();
    return { enabled: this.ports.settings().enabled, signedIn: !!session, passwordSet: session?.passwordSet ?? false, deviceReady: !!session?.deviceId, keyReady: !!this.key && this.keyAccount === (session?.accountId ?? ""), enableRateLimited: this.enableRateLimited, status: this.engine?.snapshot() ?? null, devices: this.devices };
  }
  private deviceName(): string { return this.ports.settings().deviceName || this.ports.defaultDeviceName; }

  /** On plugin load: if enabled and the key is cached for this account, start quietly. */
  async start(): Promise<void> {
    if (this.starting) return this.starting;
    this.starting = (async () => {
      const session = this.ports.session();
      if (!this.ports.settings().enabled || !session?.deviceId) return;
      const cached = await this.loadKey(session.accountId);
      if (!cached) return;
      await this.run(session, cached);
    })().finally(() => { this.starting = null; });
    return this.starting;
  }
  /** User action: derive the key from the account password, prove it against the cloud, remember it on this device. */
  async enable(password: string): Promise<void> {
    const session = this.ports.session();
    if (!session) throw new Error("AUTH_REQUIRED");
    if (!session.passwordSet) throw new Error("PASSWORD_REQUIRED");
    if (!session.deviceId) throw new Error("DEVICE_REQUIRED");
    await this.deviceRefresh;
    if (this.inactiveRetryAt > this.now()) {
      this.enableRateLimited = true; this.notify(); throw new Error("SYNC_ENABLE_RATE_LIMITED");
    }
    this.enableRateLimited = false;
    const key = await deriveMasterKey(password, session.accountId);
    const previous = this.ports.settings().enabled;
    this.ports.settings().enabled = true;
    let ready = false;
    try {
      await this.run(session, key, true, async () => {
        await this.saveKey(session.accountId, key);
        await this.ports.saveSettings();
        ready = true;
      });
      if (!ready) {
        const status = this.engine?.snapshot();
        if (status?.phase === "rate-limited") {
          this.inactiveRetryAt = status.retryAt ?? 0;
          this.enableRateLimited = true;
          throw new Error("SYNC_ENABLE_RATE_LIMITED");
        }
        throw new Error(status?.lastError || "NETWORK");
      }
      // Once verified, an upload failure keeps the enabled engine and its persisted retry queue alive.
      this.notify();
    } catch (error) {
      this.stopEngine(); this.ports.settings().enabled = previous;
      await this.ports.saveSettings().catch(() => {});
      this.notify(); throw error;
    }
  }

  async disable(): Promise<void> {
    this.inactiveRetryAt = this.engine?.snapshot().retryAt ?? this.inactiveRetryAt;
    this.enableRateLimited = false;
    this.stopEngine();
    this.ports.settings().enabled = false;
    await this.ports.saveSettings();
    this.notify();
  }
  /** The account changed or logged out: stop; a new login starts again from the cached key of that account. */
  async accountChanged(): Promise<void> {
    const session = this.ports.session();
    if (!session || (this.cachedClient && this.cachedClient.identity !== this.clientIdentity(session))) {
      this.inactiveRetryAt = 0; this.enableRateLimited = false;
    }
    if (!session || (this.keyAccount && session.accountId !== this.keyAccount)) { this.stopEngine(); this.key = null; this.keyAccount = ""; }
    if (session && this.ports.settings().enabled && !this.engine) await this.start();
    this.notify();
  }
  /** Per-note sync state for editor indicators; false while no engine runs. */
  tracks(path: string): boolean { return this.engine?.tracks(path) ?? false; }
  pathPending(path: string): boolean { return this.engine?.hasPending(path) ?? false; }
  cloudVersionAt(path: string): number | null { return this.engine?.cloudVersionAt(path) ?? null; }
  /** Folder choices changed: a running engine rescans on its next pass. */
  scopeChanged(): void { this.engine?.scopeChanged(); }
  /** Version records kept when a conflict replaced one side; null on hosts without local storage for them. */
  get history(): CloudSyncHistory | null { return this.ports.history ?? null; }
  noteVaultChange(path: string, kind: "create" | "modify" | "delete" | "rename", oldPath?: string): void {
    this.engine?.noteVaultChange(path, kind, oldPath);
    if (kind === "rename" && oldPath) void this.ports.history?.rename(oldPath, path);
    if (kind !== "modify") this.folderRevision++;
    if (kind !== "modify" && (!path.includes("/") || !this.folderNames.includes(path.split("/")[0]))) { this.foldersDirty = true; this.notify(); }
  }
  async folderChoices(): Promise<string[]> {
    if (this.foldersDirty && !this.folderFlight) {
      this.foldersDirty = false;
      this.folderFlight = this.ports.fs.list("").then(list => { this.folderNames = list.folders; return this.folderNames; }).catch(error => { this.foldersDirty = true; throw error; }).finally(() => { this.folderFlight = null; });
    }
    if (this.folderFlight) await this.folderFlight;
    if (this.foldersDirty) return this.folderChoices();
    return cloudFolderChoices(this.folderNames, this.ports.settings().excludedFolders, this.ports.ignoredRoots);
  }
  /** Direct child folders of `parent` ("" = vault root) that may be chosen for sync. */
  /** Changes whenever folders may have been added, removed or renamed; views re-list only when it moves. */
  get foldersRevision(): number { return this.folderRevision; }
  async folderChildren(parent: string): Promise<string[]> {
    const index = this.ports.folderIndex?.();
    if (index) return cloudFolderChildren(parent, index, this.ports.settings().excludedFolders, this.ports.ignoredRoots);
    if (!parent) await this.folderChoices();
    const listed = parent ? (await this.ports.fs.list(parent).catch(() => ({ folders: [] as string[] }))).folders : this.folderNames;
    return cloudFolderChildren(parent, listed, this.ports.settings().excludedFolders, this.ports.ignoredRoots);
  }
  /** Every selectable folder, for search. Bounded so a huge vault cannot stall the settings page. */
  async allFolders(limit = 4000): Promise<string[]> {
    const index = this.ports.folderIndex?.();
    if (index) return index.filter(path => cloudFolderSelectable(path, this.ports.ignoredRoots)).sort((a, b) => a.localeCompare(b)).slice(0, limit);
    const found: string[] = [], queue = [""];
    while (queue.length && found.length < limit) {
      for (const child of await this.folderChildren(queue.shift()!)) { found.push(child); queue.push(child); }
    }
    return found.slice(0, limit);
  }
  wake(): void { this.engine?.wake(); }
  async revokeDevice(deviceId: string): Promise<void> {
    const session = this.ports.session(); if (!session) return;
    if (this.ports.removeDevice) await this.ports.removeDevice(deviceId);
    else await this.client(session).revokeDevice(deviceId);
    this.devices = this.devices.filter(d => d.deviceId !== deviceId); this.notify();
  }
  async refreshDevices(): Promise<void> {
    if (!this.engine && this.starting) await this.starting;
    if (this.engine) return this.engine.refreshUsage();
    const session = this.ports.session(); if (!session) return;
    if (this.inactiveRetryAt > this.now()) return;
    this.deviceRefresh ??= this.refreshInactiveDevices(session).finally(() => { this.deviceRefresh = null; });
    return this.deviceRefresh;
  }
  private async refreshInactiveDevices(session: CloudSyncSession): Promise<void> {
    const stillCurrent = () => {
      const current = this.ports.session();
      return current && this.clientIdentity(current) === this.clientIdentity(session);
    };
    try {
      const usage = await this.client(session).usage();
      if (stillCurrent()) { this.devices = usage.devices; this.notify(); }
    } catch (error) {
      if (isCloudRateLimited(error)) {
        const delay = cloudRetryDelay(error, 1_000);
        if (stillCurrent()) this.inactiveRetryAt = Math.min(Number.MAX_SAFE_INTEGER, this.now() + delay);
        this.ports.onError?.(error, delay);
      }
    }
  }
  dispose(): void { this.stopEngine(); this.listeners.clear(); }

  private clientIdentity(session: CloudSyncSession): string {
    return `${session.accountId}:${session.apiUrl}:${session.deviceId ?? this.ports.deviceId}`;
  }
  private client(session: CloudSyncSession): CloudSyncClientPort {
    const identity = this.clientIdentity(session);
    if (this.cachedClient?.identity === identity) return this.cachedClient.client;
    const client = this.ports.clientFactory?.(session) ?? new CloudSyncClient({ apiUrl: session.apiUrl, token: () => this.ports.session()?.token ?? null, deviceId: session.deviceId ?? this.ports.deviceId, transport: this.ports.transport });
    this.cachedClient = { identity, client }; return client;
  }
  private async run(session: CloudSyncSession, key: SyncMasterKey, fresh = false, onReady?: () => Promise<void>): Promise<void> {
    if (this.deviceRefresh) await this.deviceRefresh;
    this.stopEngine();
    this.key = key; this.keyAccount = session.accountId;
    const stateKey = `${STATE_ID}:${session.accountId}`;
    const state: CloudStatePort = { load: () => this.ports.local.load(stateKey), save: value => this.ports.local.save(stateKey, value) };
    if (fresh) await this.ports.local.save(stateKey, null);
    const engine = new CloudSyncEngine({ fs: this.ports.fs, client: this.client(session), key, deviceId: session.deviceId ?? this.ports.deviceId, mirrorDeviceId: this.ports.deviceId, deviceName: this.deviceName(), deviceKind: this.ports.deviceKind,
      scope: () => ({ excludedFolders: this.ports.settings().excludedFolders, includeAttachments: this.ports.settings().includeAttachments }), state, base: this.ports.base, timers: this.ports.timers, now: this.now,
      ignoredRoots: this.ports.ignoredRoots, caseInsensitivePaths: this.ports.caseInsensitivePaths, onReady,
      onError: this.ports.onError, history: this.ports.history, onConflict: () => this.notify(), onDevices: devices => { this.devices = devices; },
      onLocalWrite: path => { if (!this.folderNames.includes(path.split("/")[0])) this.foldersDirty = true; this.ports.onLocalWrite?.(path); } });
    this.engine = engine;
    engine.subscribe(() => this.notify());
    await engine.start(this.inactiveRetryAt);
  }
  private stopEngine(): void { this.engine?.stop(); this.engine = null; this.notify(); }
  private async loadKey(accountId: string): Promise<SyncMasterKey | null> {
    try {
      const id = `${KEY_ID}:${accountId}`;
      const raw = (await this.ports.secret?.get(id)) ?? (this.ports.local.load(id) as string | null);
      if (typeof raw !== "string" || !raw) return null;
      const key = await importMasterKey(raw);
      this.key = key; this.keyAccount = accountId;
      return key;
    } catch { return null; }
  }
  private async saveKey(accountId: string, key: SyncMasterKey): Promise<void> {
    const id = `${KEY_ID}:${accountId}`;
    if (this.ports.secret) { try { await this.ports.secret.set(id, key.raw); return; } catch { /* fall back to local storage */ } }
    await this.ports.local.save(id, key.raw);
  }
}

export type { SyncFs };
