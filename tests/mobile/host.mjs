/** Disposable in-memory Obsidian API surface. Never reads a user's Vault. */
export function createHost(seed = { "笔记/来源.md": "项目决定：先完成手机本地问答。" }) {
  const files = new Map(Object.entries(seed));
  const folders = new Set(["plugin", "plugin/mobile", "笔记"]);
  const writes = [];
  const opened = [];
  const adapter = {
    async exists(path) { return files.has(path) || folders.has(path); },
    async read(path) { if (!files.has(path)) throw new Error(`Missing ${path}`); return files.get(path); },
    async write(path, content) { writes.push(path); files.set(path, content); },
    async mkdir(path) { folders.add(path); }
  };
  const file = path => ({ path, basename: path.split("/").pop().replace(/\.md$/u, ""), extension: "md" });
  const app = {
    vault: {
      configDir: ".obsidian", adapter,
      getMarkdownFiles() { return [...files.keys()].filter(p => p.endsWith(".md")).map(file); },
      getAbstractFileByPath(path) { return files.has(path) ? file(path) : folders.has(path) ? { path, children: [] } : null; },
      async read(file) { return adapter.read(file.path); },
      async createFolder(path) { folders.add(path); },
      async create(path, content) { if (files.has(path)) throw new Error("File already exists"); files.set(path, content); writes.push(path); return file(path); }
    },
    workspace: {
      getActiveFile() { return file("笔记/来源.md"); },
      getLeaf() { return { async openFile(f) { opened.push(f.path); } }; }
    }
  };
  return { files, folders, adapter, writes, opened, app };
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
