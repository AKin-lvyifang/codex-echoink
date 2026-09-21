import { existsSync, readdirSync, statSync } from "node:fs";
import { mkdir, readFile, writeFile, rename, rmdir } from "node:fs/promises";
import * as path from "node:path";
import { TFile, TFolder, type App } from "obsidian";
import { DEFAULT_SETTINGS } from "../settings/settings";

/** Only host I/O is simulated. Core method signatures follow Obsidian 1.13.7. */
export async function nativeJournalFixture(root: string) {
  await mkdir(root, { recursive: true });
  const files = new Map<string, TFile>();
  const nativeCalls: Array<{ command: string; args: Record<string, string> }> = [];
  let enableCalls = 0;
  let settingsSaves = 0;
  let providerCalls = 0;
  function file(relative: string): TFile | null {
    const absolute = path.join(root, relative);
    if (!existsSync(absolute) || !statSync(absolute).isFile()) return null;
    const value = files.get(relative) ?? new TFile(relative);
    const stats = statSync(absolute);
    Object.assign(value, {
      basename: path.basename(relative, path.extname(relative)),
      extension: path.extname(relative).slice(1),
      parent: { path: path.posix.dirname(relative) },
      stat: { size: stats.size, mtime: stats.mtimeMs, ctime: stats.ctimeMs }
    });
    files.set(relative, value);
    return value;
  }
  const list = (dir = ""): TFile[] => readdirSync(path.join(root, dir), { withFileTypes: true })
    .filter((entry) => !entry.name.startsWith("."))
    .flatMap((entry) => {
      const name = dir ? `${dir}/${entry.name}` : entry.name;
      return entry.isDirectory() ? list(name) : [file(name)!];
    });
  const records: Record<string, any> = {};
  const loaded = (dir = ""): (TFile | TFolder)[] => readdirSync(path.join(root, dir), { withFileTypes: true })
    .filter((entry) => !entry.name.startsWith("."))
    .flatMap((entry): (TFile | TFolder)[] => {
      const name = dir ? `${dir}/${entry.name}` : entry.name;
      if (!entry.isDirectory()) return [file(name)!];
      const descendants = loaded(name);
      const folder = Object.assign(new TFolder(), { path: name, name: entry.name, children: descendants.filter((item) => path.posix.dirname(item.path) === name) });
      return [folder, ...descendants];
    });
  const vaultConfig: Record<string, unknown> = { alwaysUpdateLinks: true };
  for (const id of ["daily-notes", "templates"]) {
    const configPath = path.join(root, ".obsidian", `${id}.json`);
    const record: any = {
      enabled: false,
      async loadData() { return JSON.parse(await readFile(configPath, "utf8").catch(() => "{}")); },
      async saveData(options: unknown) { await mkdir(path.dirname(configPath), { recursive: true }); await writeFile(configPath, JSON.stringify(options)); settingsSaves += 1; },
      async enable(userInitiated: boolean) {
        if (!userInitiated) throw new Error("fixture expects the user's initialization action");
        if (record.enabled) return;
        record.enabled = true;
        record.instance.options = await record.loadData();
        enableCalls += 1;
      },
      instance: { options: {}, async onExternalSettingsChange() { record.instance.options = await record.loadData(); } }
    };
    record.instance.plugin = record;
    records[id] = record;
  }
  const handlers = new Map<string, any>();
  for (const command of ["version", "files", "search", "read", "daily:path", "templates"]) {
    handlers.set(command, { async handler(args: Record<string, string>) {
      nativeCalls.push({ command, args });
      if (command === "version") return "1.13.7 (installer 1.6.5)";
      if (command === "read") return await readFile(path.join(root, args.path!), "utf8");
      return list().filter((file) => !args.folder || file.path.startsWith(`${args.folder}/`)).map((file) => file.path).join("\n");
    } });
  }
  const app: any = {
    internalPlugins: {
      plugins: records,
      getPluginById: (id: string) => records[id],
      async saveConfig() { await writeFile(path.join(root, ".obsidian", "core-plugins.json"), JSON.stringify(Object.keys(records).filter((id) => records[id].enabled))); }
    },
    cli: { handlers },
    vault: {
      adapter: { getBasePath: () => root },
      getName: () => "offline-journal-fixture",
      getFiles: () => list(),
      getAllLoadedFiles: () => loaded(),
      getConfig: (key: string) => vaultConfig[key],
      setConfig: (key: string, value: unknown) => { vaultConfig[key] = value; },
      getMarkdownFiles: () => list().filter((file) => file.extension === "md"),
      getFileByPath: file,
      getAbstractFileByPath: (name: string) => file(name) ?? loaded().find((item) => item.path === name) ?? null,
      delete: (folder: TFolder) => rmdir(path.join(root, folder.path)),
      createFolder: async (name: string) => await mkdir(path.join(root, name)),
      async create(name: string, content: string) { await writeFile(path.join(root, name), content, { flag: "wx" }); return file(name)!; },
      async createBinary(name: string, content: ArrayBuffer) { await writeFile(path.join(root, name), Buffer.from(content), { flag: "wx" }); return file(name)!; },
      read: (value: TFile) => readFile(path.join(root, value.path), "utf8"),
      cachedRead: (value: TFile) => readFile(path.join(root, value.path), "utf8"),
      async readBinary(value: TFile) { const bytes = await readFile(path.join(root, value.path)); return Uint8Array.from(bytes).buffer; },
      async process(value: TFile, callback: (text: string) => string) {
        const next = callback(await readFile(path.join(root, value.path), "utf8"));
        await writeFile(path.join(root, value.path), next); return next;
      }
    },
    workspace: { onLayoutReady() {}, getLeaf: () => ({ async openFile() {} }) },
    fileManager: { async renameFile(value: TFile | TFolder, target: string) { await rename(path.join(root, value.path), path.join(root, target)); files.clear(); } },
    metadataCache: { resolvedLinks: {}, unresolvedLinks: {}, getFileCache: () => null, getFirstLinkpathDest: () => null }
  };
  const plugin: any = {
    app: app as App,
    settings: structuredClone(DEFAULT_SETTINGS),
    getVaultPath: () => root,
    getPluginDataDirName: () => "codex-echoink",
    async saveSettings() {}, refreshKnowledgeBaseSurfaces() {},
    async submitPiChat() { providerCalls += 1; throw new Error("No Provider expected"); }
  };
  return { app: app as App, plugin, records, handlers, nativeCalls,
    enableCalls: () => enableCalls, settingsSaves: () => settingsSaves, providerCalls: () => providerCalls,
    async write(name: string, content: string) { await mkdir(path.dirname(path.join(root, name)), { recursive: true }); await writeFile(path.join(root, name), content); return file(name)!; }
  };
}
