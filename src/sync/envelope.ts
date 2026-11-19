import { isSyncDeviceId, type SyncEnvelope } from "./types";

const rec = (v: unknown): Record<string, unknown> | null => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null;

/** Returns null for anything that is not a complete envelope of the expected schema; callers treat null as "not there". */
export function parseEnvelope<T>(value: unknown, schema: string, payload: (raw: unknown) => T | null): SyncEnvelope<T> | null {
  const raw = rec(value);
  if (!raw || raw.schema !== schema || !isSyncDeviceId(raw.deviceId)) return null;
  if (typeof raw.rev !== "number" || !Number.isSafeInteger(raw.rev) || raw.rev < 0) return null;
  if (typeof raw.updatedAt !== "number" || !Number.isSafeInteger(raw.updatedAt) || raw.updatedAt < 0) return null;
  const parsed = payload(raw.payload);
  if (parsed === null) return null;
  return { schema, deviceId: raw.deviceId, rev: raw.rev, updatedAt: raw.updatedAt, payload: parsed };
}

export function envelope<T>(schema: string, deviceId: string, rev: number, updatedAt: number, payload: T): SyncEnvelope<T> {
  return { schema, deviceId, rev, updatedAt, payload };
}
