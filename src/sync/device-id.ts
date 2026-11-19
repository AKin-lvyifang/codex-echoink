import { isSyncDeviceId } from "./types";

/** Obsidian's per-Vault local storage: on the device, never inside Vault files a sync tool would carry. */
export interface SyncDeviceIdPort {
  loadLocalStorage(key: string): unknown;
  saveLocalStorage(key: string, value: string): void | Promise<void>;
}

export const SYNC_DEVICE_ID_KEY = "echoink-sync-device-id";

/**
 * Desktop device identity for the sync folder. Mobile reuses its existing task instance id.
 * Creating a new id when storage cannot be read would split one device into two, so that fails instead.
 */
export async function resolveDesktopSyncDeviceId(port: SyncDeviceIdPort, key = SYNC_DEVICE_ID_KEY): Promise<string> {
  let stored: unknown;
  try { stored = port.loadLocalStorage(key); } catch { throw new Error("暂时无法读取本机存储，同步设备未能识别。请重试；如问题持续，请重新打开 EchoInk。"); }
  if (isSyncDeviceId(stored)) return stored;
  if (stored !== null && stored !== undefined) throw new Error("本机同步设备信息已损坏，未作改动。请点击“上报问题”。");
  const created = crypto.randomUUID();
  try { await port.saveLocalStorage(key, created); } catch { throw new Error("本机存储无法写入，同步设备信息未能保存。请重试；如问题持续，请重新打开 EchoInk。"); }
  if (port.loadLocalStorage(key) !== created) throw new Error("同步设备信息未能保存。请重试；如问题持续，请重新打开 EchoInk。");
  return created;
}
