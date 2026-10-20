import fs from "node:fs/promises";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { answer } from "../mobile/host.mjs";

export async function folderFixture(api, root, seed = {}) {
  await fs.mkdir(root, { recursive: true });
  const full = relative => { const target = path.resolve(root, relative); assert.ok(target === root || target.startsWith(root + path.sep)); return target; };
  const calls = { writes: [], removes: [], binary: [], renames: [], model: 0, usage: 0 };
  let hooks = {};
  const adapter = {
    async exists(relative) { return existsSync(full(relative)); },
    async stat(relative) { try { const info = await fs.stat(full(relative)); return { type: info.isDirectory() ? "folder" : "file", size: info.size, mtime: info.mtimeMs, ctime: info.ctimeMs }; } catch (error) { if (error.code === "ENOENT") return null; throw error; } },
    async list(relative) { const entries = await fs.readdir(full(relative), { withFileTypes: true }); return {
      files: entries.filter(entry => entry.isFile()).map(entry => [relative, entry.name].filter(Boolean).join("/")),
      folders: entries.filter(entry => entry.isDirectory()).map(entry => [relative, entry.name].filter(Boolean).join("/")) }; },
    async read(relative) { return fs.readFile(full(relative), "utf8"); },
    async readBinary(relative) { calls.binary.push(relative); const bytes = await fs.readFile(full(relative)); return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); },
    async write(relative, content) { calls.writes.push(relative); await hooks.write?.(relative, content); await fs.writeFile(full(relative), content); },
    async mkdir(relative) { calls.writes.push(relative + "/"); await hooks.mkdir?.(relative); await fs.mkdir(full(relative)); },
    async rename(from, to) { calls.writes.push(`${from}→${to}`); await hooks.privateRename?.(from, to); if (existsSync(full(to))) throw Error("Target occupied"); await fs.rename(full(from), full(to)); },
    async remove(relative) { calls.removes.push(relative); assert.ok(relative.startsWith(".obsidian/plugins/echoink/mobile/knowledge-folders-v1/"), "only owned private journal temporary files may be removed"); await fs.unlink(full(relative)); },
    async rmdir() { throw Error("User directories may never be deleted"); }
  };
  const write = async (relative, content) => { await fs.mkdir(path.dirname(full(relative)), { recursive: true }); await fs.writeFile(full(relative), content); };
  for (const [relative, content] of Object.entries(seed)) await write(relative, content);
  const all = () => {
    const files = [], folders = [];
    const visit = relative => { for (const entry of readdirSync(full(relative), { withFileTypes: true })) {
      const item = [relative, entry.name].filter(Boolean).join("/");
      if (entry.isDirectory()) { folders.push(item); visit(item); } else files.push(item);
    } }; visit(""); return { files, folders };
  };
  const file = relative => { if (!existsSync(full(relative))) return null; const info = statSync(full(relative)); return { path: relative, name: path.posix.basename(relative), basename: path.posix.basename(relative).replace(/\.md$/u, ""),
    extension: path.posix.extname(relative).slice(1), stat: { size: info.size, mtime: info.mtimeMs, ctime: info.ctimeMs } }; };
  const references = relative => {
    const text = readFileSync(full(relative), "utf8"), links = [], embeds = [];
    const pattern = /!?\[\[([^\]\n|]+)(?:\|[^\]\n]*)?\]\]|!?\[[^\]\n]*\]\((?:<[^>]+>|[^\s)]+)(?:\s+"[^"]*")?\)/gu;
    for (const match of text.matchAll(pattern)) {
      const target = match[1] ?? /\]\(<?([^)>\s]+)/u.exec(match[0])[1];
      const ref = { original: match[0], link: target.split("#")[0], position: { start: { offset: match.index }, end: { offset: match.index + match[0].length } } };
      (match[0].startsWith("!") ? embeds : links).push(ref);
    }
    return { links, embeds };
  };
  const app = { vault: {
    adapter, configDir: ".obsidian", getConfig: () => true,
    getAbstractFileByPath: file, getFileByPath: file,
    getFiles: () => all().files.map(file), getMarkdownFiles: () => all().files.filter(relative => relative.endsWith(".md") && !relative.startsWith(".obsidian/")).map(file),
    getAllLoadedFiles: () => [...all().files, ...all().folders].map(file),
    getRoot: () => ({ children: [...new Set([...all().files, ...all().folders].map(relative => relative.split("/")[0]))].map(file) }),
    read: entry => adapter.read(entry.path), readBinary: entry => adapter.readBinary(entry.path),
    createFolder: relative => adapter.mkdir(relative),
    async process(entry, change) { const previous = await adapter.read(entry.path); const next = change(previous); await hooks.process?.(entry.path); await adapter.write(entry.path, next); return next; }
  }, metadataCache: {
    getFileCache: entry => references(entry.path),
    getFirstLinkpathDest(link, source) {
      const decoded = decodeURIComponent(link), files = all().files;
      const options = decoded.startsWith(".") ? [path.posix.normalize(path.posix.join(path.posix.dirname(source), decoded))] : [decoded.replace(/^\//u, "")];
      const found = files.filter(relative => options.some(option => relative === option || relative === option + ".md"));
      return found.length === 1 ? file(found[0]) : null;
    }, resolvedLinks: {}
  }, fileManager: {
    async renameFile(entry, target) {
      await hooks.rename?.(entry.path, target); calls.renames.push({ from: entry.path, to: target });
      assert.equal(existsSync(full(target)), false, "host rename refuses overwrite"); await fs.rename(full(entry.path), full(target)); await hooks.afterRename?.(entry.path, target);
    }
  } };
  const native = { folder: "journal", format: "YYYY-MM-DD", template: "templates/daily.md" };
  const core = { enabled: true, instance: { options: native }, async loadData() { await hooks.nativeLoad?.(); return { ...core.instance.options }; },
    async saveData(value) { await adapter.write(".obsidian/daily-notes.json", JSON.stringify(value)); core.instance.options = value; } };
  app.internalPlugins = { plugins: { "daily-notes": core, templates: { enabled: true, instance: { options: { folder: "templates" } }, async loadData() { return this.instance.options; } } } };
  const settings = api.loadMobileSettings({ defaultPermission: "workspace-write" });
  const provider = api.mobileProvider("custom"); Object.assign(provider, { apiKey: "synthetic", baseUrl: "https://fixture.invalid/v1", models: [api.mobileModel("fixture")], defaultModelId: "fixture" });
  settings.apiProviders = [provider]; settings.activeApiProviderId = provider.id; settings.defaultModel = "fixture";
  let modelText = '{"0":"研究资料"}';
  const services = { app, directory: ".obsidian/plugins/echoink/mobile", settings,
    getTodoStore: () => ({ sourcePath: "EchoInk/待办.md", initialize() { throw Error("read must not initialize TodoStore"); } }),
    notifyHomeSurfacesChanged() {},
    async saveSettings() { await hooks.save?.(); await adapter.write(".obsidian/plugins/echoink/data.json", JSON.stringify(settings)); },
    async generateLifestyleText(system, user, maxTokens, signal) {
      return api.mobileGenerateText(provider, provider.models[0], async () => { calls.model++; return answer("openai-completions", modelText); }, system, user, maxTokens, signal,
        { recordUsage: async () => { calls.usage++; }, onRecordError(error) { throw error; } });
    }
  };
  await fs.mkdir(full(".obsidian/plugins/echoink"), { recursive: true });
  const service = new api.MobileKnowledgeFoldersService(services);
  const reset = () => { calls.writes.length = 0; calls.removes.length = 0; calls.binary.length = 0; calls.renames.length = 0; };
  return { app, settings, services, service, adapter, calls, root, full, write, reset,
    hooks(next) { hooks = next; }, model(value) { modelText = value; },
    cold() { return new api.MobileKnowledgeFoldersService(services); }, read: relative => fs.readFile(full(relative), "utf8") };
}
