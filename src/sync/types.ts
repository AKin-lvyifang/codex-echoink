import type { CompanyDispatch, CompanyEvent, CompanyProject } from "../company/types";

/** Visible Vault folder every sync tool carries. Each device writes only its own `devices/<id>/`. */
export const SYNC_ROOT = "EchoInk/同步数据";
export const SYNC_DEVICES_DIR = `${SYNC_ROOT}/devices`;
export const SYNC_README = `${SYNC_ROOT}/README.md`;
export const SYNC_FORMAT_VERSION = 1;
/** A device counts as online when its heartbeat is younger than this. */
export const SYNC_ONLINE_WINDOW_MS = 5 * 60_000;
export const SYNC_HEARTBEAT_MS = 5 * 60_000;

export const SYNC_SCHEMA = {
  device: "echoink.sync.device.v1",
  company: "echoink.sync.company.v1",
  companyArchive: "echoink.sync.company-archive.v1",
  request: "echoink.sync.request.v1",
  ack: "echoink.sync.ack.v1",
  conversationMeta: "echoink.sync.conversation-meta.v1",
  conversationPart: "echoink.sync.conversation-part.v1"
} as const;

export type SyncDeviceKind = "desktop" | "phone" | "tablet";

/** Every file carries this header; `rev` is the writing device's own counter, never a clock comparison. */
export interface SyncEnvelope<T> {
  readonly schema: string;
  readonly deviceId: string;
  readonly rev: number;
  readonly updatedAt: number;
  readonly payload: T;
}

export interface SyncMigrationRecord {
  /** Fingerprint of the source the migration copied from; a different source migrates again. */
  readonly fingerprint: string;
  readonly completedAt: number;
}

export interface SyncDevicePayload {
  readonly name: string;
  readonly kind: SyncDeviceKind;
  readonly formatVersion: typeof SYNC_FORMAT_VERSION;
  /** Heartbeat. Other devices show "last seen" from it. */
  readonly lastSeenAt: number;
  /** Highest rev this device has written; restores the counter after restart. */
  readonly rev: number;
  readonly migration?: Readonly<Record<string, SyncMigrationRecord>>;
}

/** Unfinished company work on one device: proposed/running/paused projects and their dispatches and events. */
export interface SyncCompanyPayload {
  readonly projects: readonly CompanyProject[];
  readonly dispatches: readonly CompanyDispatch[];
  readonly events: readonly CompanyEvent[];
}

/** One finished project, moved out of company.json to keep it small. */
export interface SyncCompanyArchivePayload {
  readonly project: CompanyProject;
  readonly dispatches: readonly CompanyDispatch[];
  readonly events: readonly CompanyEvent[];
}

export interface SyncDeviceSummary {
  readonly id: string;
  readonly name: string;
  readonly kind: SyncDeviceKind;
  readonly lastSeenAt: number;
  readonly online: boolean;
  readonly isSelf: boolean;
}

/** Obsidian wants window timers for popout windows; node tests hand in their own. */
export interface SyncTimers {
  setTimeout(handler: () => void, ms: number): number;
  clearTimeout(id: number): void;
  setInterval(handler: () => void, ms: number): number;
  clearInterval(id: number): void;
}
export const windowTimers = (): SyncTimers => window;

export const SYNC_DEVICE_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/u;
export function isSyncDeviceId(value: unknown): value is string { return typeof value === "string" && SYNC_DEVICE_ID_PATTERN.test(value); }
export function deviceDir(deviceId: string): string { return `${SYNC_DEVICES_DIR}/${deviceId}`; }
