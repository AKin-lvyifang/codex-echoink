import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DEFAULT_SETTINGS, type CodexForObsidianSettings } from "../settings/settings";
import { EchoInkSettingsStore, settingsForDataSave } from "../plugin/settings-store";
import { loadMobileSettings } from "../mobile/settings";
import { DESKTOP_DEVICE_SETTING_KEYS, DESKTOP_LOCAL_STATE_KEYS, MOBILE_DEVICE_SETTING_KEYS, deviceSettingsSnapshot, mergeExternalSettings, overlayDeviceSettings, readDeviceSettings, writeDeviceSettings } from "../sync/device-settings";

function fixture(root: string) {
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.sessions = [{ id: "live", title: "进行中的对话", cwd: root, bodyAuthority: "pi_session_only", createdAt: 1, updatedAt: 1, messages: [] } as never];
  settings.activeSessionId = "live";
  settings.proxyEnabled = true; settings.proxyUrl = "http://127.0.0.1:7890"; settings.customWelcomeTitle = "本机标题";
  const local = new Map<string, unknown>();
  const state = {
    settings, disk: settingsForDataSave(settings) as unknown, writes: 0, local,
    plugin: {
      settings, getVaultPath: () => root, getPluginDataDirName: () => ".obsidian/plugins/codex-echoink",
      app: { vault: { adapter: { write: async () => undefined } }, loadLocalStorage: (key: string) => structuredClone(local.get(key) ?? null), saveLocalStorage: (key: string, value: unknown) => { local.set(key, structuredClone(value)); } },
      loadData: async (): Promise<unknown> => structuredClone(state.disk),
      saveData: async (value: CodexForObsidianSettings): Promise<void> => { state.disk = structuredClone(value); state.writes++; }
    },
    store: null as unknown as EchoInkSettingsStore
  };
  state.store = new EchoInkSettingsStore(state.plugin as never);
  return state;
}

export async function runSyncSettingsTests(): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "echoink-sync-settings-"));
  let passed = 0;
  const ok = (name: string) => { passed++; console.log(`ok ${passed} - ${name}`); };
  try {
    {
      const current: Record<string, unknown> = { a: 1, proxyUrl: "mine", sessions: [{ id: "x" }], nested: { k: 1 } };
      const sessions = current.sessions;
      const changed = mergeExternalSettings(current, { a: 2, proxyUrl: "theirs", sessions: [], nested: { k: 2 } }, ["proxyUrl", "sessions"]);
      assert.equal(changed, true);
      assert.deepEqual(current, { a: 2, proxyUrl: "mine", sessions: [{ id: "x" }], nested: { k: 2 } });
      assert.equal(current.sessions, sessions, "kept keys keep their identity");
      assert.equal(mergeExternalSettings(current, { a: 2, nested: { k: 2 } }, []), false, "equal content → no change");
      const target: Record<string, unknown> = { proxyUrl: "disk", other: 1 };
      assert.equal(overlayDeviceSettings(target, { proxyUrl: "local", ignored: 9 }, ["proxyUrl", "missing"]), true);
      assert.deepEqual(target, { proxyUrl: "local", other: 1 });
      assert.equal(overlayDeviceSettings(target, null, ["proxyUrl"]), false);
      assert.deepEqual(deviceSettingsSnapshot({ proxyUrl: "x", proxyEnabled: true, other: 1 }, ["proxyUrl", "proxyEnabled", "absent"]), { proxyUrl: "x", proxyEnabled: true });
      assert.equal(readDeviceSettings({ loadLocalStorage: () => { throw new Error("no storage"); } }), null, "unreadable storage reads as nothing");
      assert.equal(readDeviceSettings({ loadLocalStorage: () => "junk" }), null);
      assert.equal(writeDeviceSettings(undefined, {}), false);
      ok("device settings helpers: overlay, merge-in-place keeping device keys, tolerant storage");
    }

    {
      const f = fixture(root);
      await f.store.saveSettings(true);
      assert.equal(f.writes, 1);
      const saved = readDeviceSettings(f.plugin.app)!;
      assert.equal(saved.proxyUrl, "http://127.0.0.1:7890"); assert.equal(saved.proxyEnabled, true);
      assert.deepEqual(Object.keys(saved).sort(), [...DESKTOP_DEVICE_SETTING_KEYS].sort(), "every device key is mirrored to local storage on save");
      // Another device's data.json arrives through a sync tool: shared settings change, device settings and live state do not.
      const foreign = structuredClone(f.disk) as Record<string, unknown>;
      foreign.cloudSync = { enabled: true, excludedFolders: ["Foreign"], includeAttachments: false, deviceName: "foreign" };
      foreign.customWelcomeTitle = "别的设备改的标题"; foreign.proxyUrl = "http://10.0.0.9:1"; foreign.proxyEnabled = false; foreign.autoOpenHome = true;
      foreign.sessions = [{ id: "foreign", title: "别的设备的对话", cwd: "/x", bodyAuthority: "pi_session_only", createdAt: 2, updatedAt: 2, messages: [] }];
      foreign.activeSessionId = "foreign";
      f.disk = foreign;
      const sessions = f.settings.sessions;
      assert.equal(await f.store.reloadFromExternalChange(), true);
      assert.equal(f.settings.customWelcomeTitle, "别的设备改的标题", "shared settings follow the file");
      assert.equal(f.settings.proxyUrl, "http://127.0.0.1:7890"); assert.equal(f.settings.proxyEnabled, true); assert.equal(f.settings.autoOpenHome, false);
      assert.deepEqual(f.settings.cloudSync.excludedFolders, []);
      assert.equal(f.settings.cloudSync.enabled, false);
      assert.equal(f.settings.sessions, sessions); assert.equal(f.settings.sessions[0].id, "live"); assert.equal(f.settings.activeSessionId, "live");
      assert.equal(await f.store.reloadFromExternalChange(), false, "the same file again changes nothing");
      // The next save writes this device's values back; the foreign proxy never reaches disk here.
      await f.store.saveSettings(true);
      assert.equal((f.disk as Record<string, unknown>).proxyUrl, "http://127.0.0.1:7890");
      assert.equal((f.disk as Record<string, unknown>).customWelcomeTitle, "别的设备改的标题");
      // A device without saved local values still takes the file's device keys at load time (first run).
      const fresh = fixture(root); fresh.local.clear();
      const loaded = structuredClone(DEFAULT_SETTINGS) as unknown as Record<string, unknown>; loaded.proxyUrl = "from-file";
      assert.equal(overlayDeviceSettings(loaded, readDeviceSettings(fresh.plugin.app), DESKTOP_DEVICE_SETTING_KEYS), false);
      assert.equal(loaded.proxyUrl, "from-file");
      assert.ok(DESKTOP_LOCAL_STATE_KEYS.includes("sessions"));
      ok("desktop: an external data.json change updates shared settings in place and keeps proxy, startup switches and open conversations");
    }

    {
      const current = loadMobileSettings({ mobileUi: { appearance: "dark", largeText: true }, autoOpenHome: true, syncMirrorEnabled: false, customWelcomeTitle: "本机" });
      const local = new Map<string, unknown>();
      const port = { loadLocalStorage: (key: string) => local.get(key) ?? null, saveLocalStorage: (key: string, value: unknown) => { local.set(key, value); } };
      writeDeviceSettings(port, deviceSettingsSnapshot(current, MOBILE_DEVICE_SETTING_KEYS));
      const incoming = loadMobileSettings({ mobileUi: { appearance: "light", largeText: false }, autoOpenHome: false, syncMirrorEnabled: true, customWelcomeTitle: "别的设备" });
      assert.equal(mergeExternalSettings(current, incoming, MOBILE_DEVICE_SETTING_KEYS), true);
      overlayDeviceSettings(current, readDeviceSettings(port), MOBILE_DEVICE_SETTING_KEYS);
      assert.equal(current.customWelcomeTitle, "别的设备");
      assert.equal(current.mobileUi.appearance, "dark"); assert.equal(current.mobileUi.largeText, true);
      assert.equal(current.autoOpenHome, true); assert.equal(current.syncMirrorEnabled, false);
      assert.equal(loadMobileSettings({}).syncMirrorEnabled, true, "sync mirror defaults on");
      assert.equal(DEFAULT_SETTINGS.syncMirrorEnabled, true);
      ok("mobile: the look, startup and sync switches stay with the device when data.json changes under it");
    }
  } finally { await rm(root, { recursive: true, force: true }); }
}
