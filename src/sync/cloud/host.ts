import { CloudSyncHistory } from "./history";
import { cloudFailureText } from "./messages";
import { Platform, requestUrl, type App } from "obsidian";
import type { AccountService } from "../../membership/account-service";
import type { CloudSyncSettings } from "./settings";
import type { SyncDeviceKind } from "../types";
import { isCloudRateLimited, type CloudTransport } from "./client";
import { CloudSyncController, type CloudSyncHostPorts } from "./controller";
import type { CloudBasePort } from "./engine";
import { sha256Hex } from "./crypto";

/** Obsidian's requestUrl for JSON and bytes; the platform WebSocket for the long connection. */
export function createCloudTransport(request = requestUrl): CloudTransport {
  return {
    async json(url, method, body, headers) {
      const response = await request({ url, method, headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), throw: false });
      let parsed: unknown = null; try { parsed = response.json; } catch { parsed = null; }
      return { status: response.status, body: parsed, headers: response.headers ?? {} };
    },
    async putBytes(url, bytes) {
      const copy = new Uint8Array(bytes);
      const response = await request({ url, method: "PUT", body: copy.buffer, headers: { "Content-Type": "application/octet-stream" }, throw: false });
      return { status: response.status, headers: response.headers ?? {} };
    },
    async getBytes(url) {
      const response = await request({ url, method: "GET", throw: false });
      return { status: response.status, headers: response.headers ?? {}, bytes: response.status < 400 ? new Uint8Array(response.arrayBuffer) : new Uint8Array() };
    },
    websocket: typeof WebSocket === "undefined" ? undefined : url => new WebSocket(url)
  };
}

/** Merge bases live under the plugin folder (never in a synced Vault folder), one file per note, named by the path's hash. */
export function createCloudBaseStore(app: App, pluginDir: string): CloudBasePort {
  const root = `${pluginDir}/cloud-sync-base`, adapter = app.vault.adapter;
  const file = async (path: string) => `${root}/${await sha256Hex(new TextEncoder().encode(path))}.txt`;
  return {
    async read(path) { const target = await file(path); try { return await adapter.exists(target) ? await adapter.read(target) : null; } catch { return null; } },
    async write(path, text) { if (!await adapter.exists(root)) await adapter.mkdir(root); await adapter.write(await file(path), text); },
    async remove(path) { const target = await file(path); try { if (await adapter.exists(target)) await adapter.remove(target); } catch { /* nothing to remove */ } }
  };
}

export interface CloudSyncHostInput {
  readonly app: App;
  readonly pluginDir: string;
  readonly deviceId: string;
  readonly deviceKind: SyncDeviceKind;
  readonly defaultDeviceName: string;
  readonly account: () => AccountService | null;
  readonly settings: () => CloudSyncSettings;
  readonly saveSettings: () => Promise<void>;
  readonly onLocalWrite?: (path: string) => void;
}

export function createCloudSyncController(input: CloudSyncHostInput): CloudSyncController {
  const { app } = input;
  let secretStorage: App["secretStorage"] | undefined;
  try { secretStorage = app.secretStorage; } catch { secretStorage = undefined; }
  const secrets = secretStorage;
  const ports: CloudSyncHostPorts = {
    fs: app.vault.adapter,
    transport: createCloudTransport(),
    deviceId: input.deviceId, deviceKind: input.deviceKind, defaultDeviceName: input.defaultDeviceName,
    session: () => input.account()?.cloudSyncSession() ?? null,
    settings: input.settings, saveSettings: input.saveSettings,
    removeDevice: async id => {
      const account = input.account();
      if (!account) throw new Error("AUTH_REQUIRED");
      await account.actions.removeDevice!(id);
    },
    local: { load: key => app.loadLocalStorage(key) as unknown, save: (key, value) => { app.saveLocalStorage(key, value ?? null); } },
    ...(secrets ? { secret: {
      get: id => { try { return Promise.resolve(secrets.getSecret(secretId(id)) ?? null); } catch { return Promise.resolve(null); } },
      set: (id, value) => { secrets.setSecret(secretId(id), value); return Promise.resolve(); }
    } } : {}),
    base: createCloudBaseStore(app, input.pluginDir),
    ignoredRoots: [app.vault.configDir, input.pluginDir],
    folderIndex: () => app.vault.getAllFolders(false).map(folder => folder.path),
    caseInsensitivePaths: Platform.isMacOS || Platform.isWin || Platform.isIosApp,
    onLocalWrite: input.onLocalWrite,
    history: new CloudSyncHistory(app.vault.adapter, `${input.pluginDir}/sync-history`),
    onError: (error, retryDelayMs) => {
      if (isCloudRateLimited(error)) {
        const code = /^[A-Z][A-Z0-9_]{0,63}$/u.test(error.code) ? error.code : "REQUEST_FAILED";
        console.warn("EchoInk cloud sync", { status: error.status, code, retryDelayMs });
      } else console.warn("EchoInk cloud sync", cloudFailureText(error));
    }
  };
  return new CloudSyncController(ports);
}
/** SecretStorage ids: lowercase, digits and dashes, at most 64 characters. */
function secretId(id: string): string {
  let hash = 0; for (const ch of id) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return `echoink-cloud-sync-${hash.toString(16)}`.slice(0, 64);
}
