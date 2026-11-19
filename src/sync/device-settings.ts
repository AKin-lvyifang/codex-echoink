/**
 * `data.json` travels with Obsidian Sync and the like, so a few settings must stay with the device: proxy, local
 * MCP server, startup choices, the mobile look. This device keeps its own copy in Obsidian's local storage and
 * lays it over whatever `data.json` says, both at load and when a sync tool changes the file underneath us.
 */
export const DESKTOP_DEVICE_SETTING_KEYS = ["proxyEnabled", "proxyUrl", "proxyEndpoint", "proxyCredentialRef", "mcpServer", "autoOpen", "autoOpenHome", "syncMirrorEnabled", "cloudSync"] as const;
export const MOBILE_DEVICE_SETTING_KEYS = ["mobileUi", "autoOpenHome", "syncMirrorEnabled", "cloudSync"] as const;
/** Live desktop state an external file never replaces: the open conversations belong to this process. */
export const DESKTOP_LOCAL_STATE_KEYS = ["sessions", "activeSessionId", "taskWorkspace"] as const;
export const DEVICE_SETTINGS_STORAGE_KEY = "echoink-device-settings-v1";

export interface DeviceSettingsPort {
  loadLocalStorage(key: string): unknown;
  saveLocalStorage(key: string, value: unknown): void;
}

type Record_ = Record<string, unknown>;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export function deviceSettingsSnapshot(settings: Record_, keys: readonly string[]): Record_ {
  const out: Record_ = {};
  for (const key of keys) if (settings[key] !== undefined) out[key] = clone(settings[key]);
  return out;
}
/** Null when storage is unavailable or holds something that is not an object; never throws. */
export function readDeviceSettings(port: Partial<DeviceSettingsPort> | undefined, key = DEVICE_SETTINGS_STORAGE_KEY): Record_ | null {
  try {
    const value = port?.loadLocalStorage?.(key);
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record_ : null;
  } catch { return null; }
}
export function writeDeviceSettings(port: Partial<DeviceSettingsPort> | undefined, snapshot: Record_, key = DEVICE_SETTINGS_STORAGE_KEY): boolean {
  if (!port?.saveLocalStorage) return false;
  try { port.saveLocalStorage(key, snapshot); return true; } catch { return false; }
}
/** Applies the device's saved values in place; returns whether anything changed. */
export function overlayDeviceSettings(settings: Record_, saved: Record_ | null, keys: readonly string[]): boolean {
  if (!saved) return false;
  let changed = false;
  for (const key of keys) {
    if (!Object.hasOwn(saved, key) || saved[key] === undefined) continue;
    if (JSON.stringify(settings[key]) === JSON.stringify(saved[key])) continue;
    settings[key] = clone(saved[key]); changed = true;
  }
  return changed;
}
/**
 * Takes an externally changed file into the live settings object, in place so every holder of the reference sees it,
 * except the keys this device owns. Returns whether anything changed.
 */
export function mergeExternalSettings(current: Record_, incoming: Record_, keep: readonly string[]): boolean {
  let changed = false;
  const kept = new Set(keep);
  for (const key of Object.keys(incoming)) {
    if (kept.has(key)) continue;
    if (JSON.stringify(current[key]) === JSON.stringify(incoming[key])) continue;
    current[key] = incoming[key]; changed = true;
  }
  return changed;
}
