/** Disposable in-memory Obsidian API surface. Never reads a user's Vault. */
export class FixtureTFile {
  constructor(path) { this.path = path; this.name = path.split("/").pop(); this.basename = this.name.replace(/\.[^.]+$/u, ""); this.extension = this.name.split(".").pop(); this.stat = { ctime: Date.now(), mtime: Date.now(), size: 1 }; const parent = path.split("/").slice(0, -1).join("/"); this.parent = { path: parent, name: parent.split("/").pop() ?? "", children: [] }; }
}
export function createHost(seed = { "笔记/来源.md": "项目决定：先完成手机本地问答。" }) {
  const files = new Map(Object.entries(seed)); const folders = new Set(["plugin", "plugin/mobile", "笔记"]); const writes = []; const opened = []; const fileObjects = new Map();
  const file = path => { if (!fileObjects.has(path)) fileObjects.set(path, new FixtureTFile(path)); return fileObjects.get(path); };
  const events = () => { const subscriptions = new Map(); return { on(name, cb) { const list = subscriptions.get(name) ?? []; list.push(cb); subscriptions.set(name, list); return { name, cb }; }, offref(ref) { subscriptions.set(ref.name, (subscriptions.get(ref.name) ?? []).filter(cb => cb !== ref.cb)); }, trigger(name, ...args) { for (const cb of subscriptions.get(name) ?? []) cb(...args); } }; };
  const vaultEvents = events(), workspaceEvents = events();
  const adapter = {
    async exists(path) { return files.has(path) || folders.has(path) || [...files.keys()].some(key => key.startsWith(path + "/")); },
    async read(path) { if (!files.has(path)) throw new Error(`Missing ${path}`); return files.get(path); },
    async write(path, content) { writes.push(path); files.set(path, content); },
    async rename(from, to) { if (!files.has(from)) throw new Error("Missing temporary file"); files.set(to, files.get(from)); files.delete(from); },
    async mkdir(path) { folders.add(path); }, async remove(path) { files.delete(path); },
    async stat(path) { return files.has(path) ? { type: "file", size: files.get(path).length } : await this.exists(path) ? { type: "folder", size: 0 } : null; },
    async list(path) { const prefix = path + "/"; const childFolders = new Set(); const childFiles = []; for (const key of files.keys()) { if (!key.startsWith(prefix)) continue; const rest = key.slice(prefix.length); if (rest.includes("/")) childFolders.add(prefix + rest.split("/")[0]); else childFiles.push(key); } return { files: childFiles, folders: [...childFolders] }; }
  };
  const app = {
    scope: {}, keymap: { pushScope() {}, popScope() {} },
    metadataCache: { ...events(), getFileCache() { return {}; }, resolvedLinks: {} },
    vault: {
      ...vaultEvents, configDir: ".obsidian", adapter,
      getName() { return "Disposable mobile fixture"; },
      getRoot() { return { path: "", name: "", children: [...new Set([...files.keys()].map(path => path.split("/")[0]))].map(name => ({ name, path: name })) }; },
      getMarkdownFiles() { return [...files.keys()].filter(p => p.endsWith(".md") && !p.startsWith("plugin/") && !p.startsWith(".obsidian/")).map(file); },
      getFiles() { return [...files.keys()].map(file); },
      getAllLoadedFiles() { return this.getFiles(); },
      getAbstractFileByPath(path) { return files.has(path) ? file(path) : folders.has(path) ? { path, name: path.split("/").pop(), children: [] } : null; },
      async read(f) { return adapter.read(f.path); }, async cachedRead(f) { return adapter.read(f.path); },
      async modify(f, text) { await adapter.write(f.path, text); f.stat.mtime = Date.now(); vaultEvents.trigger("modify", f); },
      async process(f, fn) { await this.modify(f, fn(await adapter.read(f.path))); },
      async createFolder(path) { folders.add(path); },
      async create(path, content) { if (files.has(path)) throw new Error("File already exists"); files.set(path, content); writes.push(path); const f = file(path); vaultEvents.trigger("create", f); return f; }
    },
    workspace: {
      ...workspaceEvents, containerEl: { ownerDocument: { defaultView: globalThis } },
      layoutReady: true, getLeavesOfType() { return []; }, onLayoutReady(callback) { callback(); },
      getActiveFile() { return file("笔记/来源.md"); },
      getLeaf() { return { async openFile(f) { opened.push(f.path); workspaceEvents.trigger("file-open", f); } }; }, setActiveLeaf() {}
    }
  }; return { files, folders, adapter, writes, opened, app };
}
export function answer(protocol, content, calls = [], extra = {}) {
  if (protocol === "openai-responses") return {
    status: 200, json: { id: "resp_fixture", status: "completed", model: "fixture-model", output: [
      ...(content ? [{ type: "message", role: "assistant", content: [{ type: "output_text", text: content }] }] : []),
      ...calls.map(([id, name, args]) => ({ type: "function_call", call_id: id, name, arguments: JSON.stringify(args) }))
    ], usage: { input_tokens: 19, output_tokens: 7, total_tokens: 26 }, ...extra }
  };
  return { status: 200, json: { id: "chat_fixture", model: "fixture-model", choices: [{ finish_reason: calls.length ? "tool_calls" : "stop", message: { role: "assistant", content: content || null, tool_calls: calls.map(([id, name, args]) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } })) } }], usage: { prompt_tokens: 19, completion_tokens: 7, total_tokens: 26 }, ...extra } };
}
