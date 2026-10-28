import * as assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openTestNoticeMessages } from "obsidian";
import { DEFAULT_SETTINGS, type CodexForObsidianSettings } from "../settings/settings";
import { EchoInkSettingsStore, settingsForDataSave } from "../plugin/settings-store";

const retryDelays = new Set([200, 1_000, 3_000]);

export async function runSettingsSaveResilienceTests(): Promise<void> {
  const cases: Array<[string, () => Promise<void>]> = [
    ["streaming bodies do not conflict", async () => {
      const f = fixture();
      f.plugin.loadData = async () => {
        f.settings.sessions[0].messages[0].text += " token";
        return structuredClone(f.disk);
      };
      await f.store.saveSettings(true);
      assert.equal(f.writes, 1);
      assert.deepEqual(f.disk.sessions[0].messages, []);
      assert.equal(openTestNoticeMessages.length, 0);
    }],
    ["changing persisted settings save the latest snapshot", async () => {
      const f = fixture(); let revision = 0;
      f.plugin.loadData = async () => {
        if (++revision <= 6) {
          f.settings.customWelcomeTitle = `revision-${revision}`;
          f.settings.sessions[0].messages[0].text += " token";
        }
        return structuredClone(f.disk);
      };
      await f.store.saveSettings(true);
      await f.store.saveSettings(true);
      assert.equal(f.disk.customWelcomeTitle, f.settings.customWelcomeTitle);
      assert.equal(openTestNoticeMessages.length, 0);
    }],
    ["changes during the write receive a follow-up save", async () => {
      const f = fixture();
      f.plugin.saveData = async value => {
        f.disk = structuredClone(value);
        if (++f.writes === 1) f.settings.customWelcomeTitle = "latest-during-write";
      };
      await f.store.saveSettings(true);
      // Exercise the real deferred save without waiting 750ms in this test.
      await new Promise<void>(resolve => setTimeout(resolve, 800));
      assert.equal(f.disk.customWelcomeTitle, "latest-during-write");
      assert.equal(openTestNoticeMessages.length, 0);
    }],
    ["two busy writes recover without a Notice", async () => {
      const f = fixture();
      f.plugin.saveData = async value => {
        if (++f.writes <= 2) throw busy();
        f.disk = structuredClone(value);
      };
      await f.store.saveSettings(true);
      assert.equal(f.writes, 3);
      assert.deepEqual(f.disk, settingsForDataSave(f.settings));
      assert.equal(openTestNoticeMessages.length, 0);
    }],
    ["read failures retry without losing changes", async () => {
      const f = fixture(); let reads = 0;
      f.plugin.loadData = async () => {
        if (++reads <= 2) throw Object.assign(new Error("fixture read denied"), { code: "EPERM" });
        return structuredClone(f.disk);
      };
      await f.store.saveSettings(true);
      assert.equal(reads, 3);
      assert.equal(f.disk.customWelcomeTitle, "unsaved-local-change");
      assert.equal(openTestNoticeMessages.length, 0);
    }],
    ["persistent failure is deduplicated and resets after success", async () => {
      const f = fixture(); let failing = true;
      f.plugin.saveData = async value => {
        f.writes++;
        if (failing) throw busy();
        f.disk = structuredClone(value);
      };
      const diagnostics: unknown[][] = []; const original = console.error;
      console.error = (...args) => { diagnostics.push(args); };
      try {
        await assert.rejects(f.store.saveSettings(true));
        assert.equal(f.writes, 4, "one attempt plus three bounded backoffs");
        f.settings.customWelcomeTitle = "still-in-memory";
        await assert.rejects(f.store.saveSettings(true));
        assert.equal(openTestNoticeMessages.length, 1);
        assert.match(JSON.stringify(diagnostics), /EBUSY.*fixture file busy|fixture file busy.*EBUSY/u);
        assert.equal(f.settings.customWelcomeTitle, "still-in-memory");
        failing = false; await f.store.saveSettings(true);
        assert.equal(f.disk.customWelcomeTitle, "still-in-memory");
        failing = true; f.settings.customWelcomeTitle = "another-local-change";
        await assert.rejects(f.store.saveSettings(true));
        assert.equal(openTestNoticeMessages.length, 2);
      } finally { console.error = original; }
    }],
    ["uncertain writes back up disk data and recover", async () => {
      const root = await mkdtemp(path.join(tmpdir(), "echoink-settings-conflict-"));
      try {
        const f = fixture(root); let failing = true;
        f.plugin.saveData = async value => {
          f.writes++;
          if (failing) {
            f.disk = { ...structuredClone(value), customWelcomeTitle: "external-copy" };
            throw busy();
          }
          f.disk = structuredClone(value);
        };
        await assert.rejects(f.store.saveSettings(true));
        failing = false; await f.store.saveSettings(true);
        assert.equal(f.disk.customWelcomeTitle, "unsaved-local-change");
        const backup = JSON.parse(await readFile(path.join(root, ".obsidian/plugins/codex-echoink/settings-save-conflict-backup.json"), "utf8"));
        assert.equal(backup.customWelcomeTitle, "external-copy");
      } finally { await rm(root, { recursive: true, force: true }); }
    }],
    ["failed readback does not permanently block later saves", async () => {
      const root = await mkdtemp(path.join(tmpdir(), "echoink-settings-readback-"));
      try {
        const f = fixture(root); let failing = true; let writeAttempted = false;
        f.plugin.loadData = async () => {
          if (failing && writeAttempted) throw new Error("fixture readback unavailable");
          return structuredClone(f.disk);
        };
        f.plugin.saveData = async value => {
          writeAttempted = true;
          if (failing) throw busy();
          f.disk = structuredClone(value);
        };
        await assert.rejects(f.store.saveSettings(true));
        failing = false; await f.store.saveSettings(true);
        assert.equal(f.disk.customWelcomeTitle, "unsaved-local-change");
      } finally { await rm(root, { recursive: true, force: true }); }
    }],
    ["backup failure preserves the conflicting disk copy", async () => {
      const f = fixture(); let backupFailing = true; let writeFailing = true; let backup = "";
      f.plugin.app.vault.adapter.write = async (_file, data) => {
        if (backupFailing) throw new Error("fixture backup denied");
        backup = data;
      };
      f.plugin.saveData = async value => {
        f.writes++;
        if (writeFailing) { f.disk.customWelcomeTitle = "external-copy"; throw busy(); }
        f.disk = structuredClone(value);
      };
      await assert.rejects(f.store.saveSettings(true));
      assert.equal(f.writes, 1, "no more writes are allowed until the conflicting copy has been backed up");
      assert.equal(f.disk.customWelcomeTitle, "external-copy");
      backupFailing = false; writeFailing = false;
      await f.store.saveSettings(true);
      assert.equal(JSON.parse(backup).customWelcomeTitle, "external-copy");
      assert.equal(f.disk.customWelcomeTitle, "unsaved-local-change");
    }],
    ["English failure Notice uses the approved actionable copy", async () => {
      const f = fixture(); f.settings.settingsLanguage = "en";
      f.plugin.saveData = async () => { throw busy(); };
      await assert.rejects(f.store.saveSettings(true));
      assert.deepEqual(openTestNoticeMessages, ["EchoInk couldn't save settings. Check whether a sync or antivirus app is locking the plugin folder."]);
    }],
    ["a committed write which throws is still successful", async () => {
      const f = fixture();
      f.plugin.saveData = async value => { f.disk = structuredClone(value); f.writes++; throw busy(); };
      await f.store.saveSettings(true);
      assert.equal(f.writes, 1);
      assert.equal(openTestNoticeMessages.length, 0);
    }]
  ];
  const failures: Error[] = [];
  const originalTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) =>
    originalTimeout(callback, retryDelays.has(delay ?? 0) ? 0 : delay, ...args)) as typeof setTimeout;
  try {
    for (const [name, run] of cases) {
      openTestNoticeMessages.length = 0;
      try { await run(); console.log(`PASS settings resilience: ${name}`); }
      catch (error) { failures.push(new Error(name, { cause: error })); console.error(`FAIL settings resilience: ${name}`, error); }
    }
  } finally { globalThis.setTimeout = originalTimeout; }
  if (failures.length) throw new AggregateError(failures, `${failures.length}/${cases.length} settings resilience cases failed`);
}

function busy(): Error { return Object.assign(new Error("fixture file busy"), { code: "EBUSY" }); }

function fixture(root = "/fixture") {
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.sessions = [{ id: "streaming", title: "Streaming", cwd: root, bodyAuthority: "pi_session_only", createdAt: 1, updatedAt: 1,
    messages: [{ id: "answer", role: "assistant", text: "start", createdAt: 1 }] }];
  const state = {
    settings, disk: settingsForDataSave(settings), writes: 0,
    plugin: {
      settings, getVaultPath: () => root, getPluginDataDirName: () => ".obsidian/plugins/codex-echoink",
      app: { vault: { adapter: { write: async (relativePath: string, data: string) => {
        const file = path.join(root, relativePath); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, data);
      } } } },
      loadData: async (): Promise<unknown> => structuredClone(state.disk),
      saveData: async (value: CodexForObsidianSettings): Promise<void> => { state.disk = structuredClone(value); state.writes++; }
    },
    store: null as unknown as EchoInkSettingsStore
  };
  settings.customWelcomeTitle = "unsaved-local-change";
  state.store = new EchoInkSettingsStore(state.plugin as never);
  return state;
}
