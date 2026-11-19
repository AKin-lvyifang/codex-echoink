/** Shared by desktop and mobile; the choices belong to this device, never the cloud space. */
export interface CloudSyncSettings {
  enabled: boolean;
  excludedFolders: string[];
  includeAttachments: boolean;
  /** Shown to other devices; empty = platform default. */
  deviceName: string;
}
export function normalizeCloudSyncSettings(value: unknown): CloudSyncSettings {
  const raw = value && typeof value === "object" ? value as Record<string, unknown> : {};
  // Vault-relative folder paths; an entry covers everything below it, so covered descendants are dropped.
  const valid = Array.isArray(raw.excludedFolders) ? [...new Set(raw.excludedFolders.flatMap(item => {
    const path = typeof item === "string" ? item : "";
    return path && !/[\\\p{Cc}]/u.test(path) && path.split("/").every(part => !!part && !part.startsWith(".")) ? [path] : [];
  }))] : [];
  const excludedFolders = valid.filter(path => !valid.some(root => root !== path && path.startsWith(`${root}/`)));
  return { enabled: raw.enabled === true, excludedFolders, includeAttachments: raw.includeAttachments !== false, deviceName: typeof raw.deviceName === "string" ? raw.deviceName.trim().slice(0, 40) : "" };
}
