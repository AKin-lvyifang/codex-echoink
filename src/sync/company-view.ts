import { normalizeCompanyDocument } from "../company/logic";
import type { CompanyDispatch, CompanyDocument, CompanyEvent, CompanyProject } from "../company/types";
import { readSyncConversations, type RemoteConversationSummary } from "./conversations";
import { parseDevicePayload } from "./device-store";
import { parseEnvelope } from "./envelope";
import { listFileNames, listFolderNames, readJsonIfPresent, type SyncFs } from "./fs";
import { SYNC_DEVICES_DIR, SYNC_ONLINE_WINDOW_MS, SYNC_SCHEMA, deviceDir, isSyncDeviceId, type SyncCompanyArchivePayload, type SyncCompanyPayload, type SyncDeviceSummary } from "./types";

const rec = (v: unknown): Record<string, unknown> | null => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null;

/** Reuses the company normalizer so a damaged entry from another device is dropped, never executed. */
export function parseCompanyPayload(raw: unknown): SyncCompanyPayload | null {
  const r = rec(raw); if (!r) return null;
  const doc = normalizeCompanyDocument({ schemaVersion: 1, projects: r.projects, dispatches: r.dispatches, events: r.events });
  return { projects: doc.projects, dispatches: doc.dispatches, events: doc.events };
}
export function parseCompanyArchivePayload(raw: unknown): SyncCompanyArchivePayload | null {
  const r = rec(raw); if (!r) return null;
  const doc = normalizeCompanyDocument({ schemaVersion: 1, projects: [r.project], dispatches: r.dispatches, events: r.events });
  const project = doc.projects[0]; if (!project) return null;
  return { project, dispatches: doc.dispatches, events: doc.events };
}

export interface RemoteCompanyProject extends CompanyProject { readonly deviceId: string; readonly deviceName: string }
export interface RemoteCompanyDispatch extends CompanyDispatch { readonly deviceId: string; readonly deviceName: string }

/** Everything the other devices have published, read-only. Nothing in it is ever executed on this device. */
export interface SyncCompanyOverview {
  readonly devices: readonly SyncDeviceSummary[];
  /** Other devices' unfinished projects; this device's own projects come from the runtime store, not from here. */
  readonly projects: readonly RemoteCompanyProject[];
  readonly dispatches: readonly RemoteCompanyDispatch[];
  readonly events: readonly CompanyEvent[];
  /** Per device, a CompanyDocument-shaped view so project pages can reuse the same renderers. */
  readonly docs: Readonly<Record<string, CompanyDocument>>;
  /** Other devices' conversations, newest first; read-only mirrors. */
  readonly conversations: readonly RemoteConversationSummary[];
}

export const EMPTY_SYNC_OVERVIEW: SyncCompanyOverview = { devices: [], projects: [], dispatches: [], events: [], docs: {}, conversations: [] };

export async function readSyncCompanyOverview(fs: SyncFs, selfDeviceId: string, now = Date.now()): Promise<SyncCompanyOverview> {
  const devices: SyncDeviceSummary[] = [], projects: RemoteCompanyProject[] = [], dispatches: RemoteCompanyDispatch[] = [], events: CompanyEvent[] = [];
  const docs: Record<string, CompanyDocument> = {};
  for (const id of await listFolderNames(fs, SYNC_DEVICES_DIR)) {
    if (!isSyncDeviceId(id)) continue;
    const dir = deviceDir(id);
    const device = parseEnvelope(await readJsonIfPresent(fs, `${dir}/device.json`), SYNC_SCHEMA.device, parseDevicePayload);
    if (!device || device.deviceId !== id) continue;
    const name = device.payload.name || id;
    devices.push({ id, name, kind: device.payload.kind, lastSeenAt: device.payload.lastSeenAt, online: now - device.payload.lastSeenAt < SYNC_ONLINE_WINDOW_MS, isSelf: id === selfDeviceId });
    if (id === selfDeviceId) continue;
    const company = parseEnvelope(await readJsonIfPresent(fs, `${dir}/company.json`), SYNC_SCHEMA.company, parseCompanyPayload);
    if (!company || company.deviceId !== id) continue;
    // A project published by a device belongs to that device, whatever an older record says.
    const owned = company.payload.projects.map(p => ({ ...p, ownerDeviceId: id }));
    docs[id] = { schemaVersion: 1, projects: owned, dispatches: company.payload.dispatches.map(d => ({ ...d, ownerDeviceId: id })), events: company.payload.events };
    projects.push(...owned.map(p => ({ ...p, deviceId: id, deviceName: name })));
    dispatches.push(...docs[id].dispatches.map(d => ({ ...d, deviceId: id, deviceName: name })));
    events.push(...company.payload.events);
  }
  const conversations = await readSyncConversations(fs, selfDeviceId, id => devices.find(d => d.id === id)?.name ?? id);
  return { devices, projects, dispatches, events, docs, conversations };
}

/** Finished projects are read on demand; they are not part of the overview. */
export async function readSyncCompanyArchive(fs: SyncFs, deviceId: string): Promise<SyncCompanyArchivePayload[]> {
  if (!isSyncDeviceId(deviceId)) return [];
  const folder = `${deviceDir(deviceId)}/company-archive`;
  const out: SyncCompanyArchivePayload[] = [];
  for (const name of await listFileNames(fs, folder)) {
    if (!name.endsWith(".json")) continue;
    const parsed = parseEnvelope(await readJsonIfPresent(fs, `${folder}/${name}`), SYNC_SCHEMA.companyArchive, parseCompanyArchivePayload);
    if (parsed && parsed.deviceId === deviceId) out.push(parsed.payload);
  }
  return out;
}
