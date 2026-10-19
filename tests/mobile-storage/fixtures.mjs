/** In-memory DataAdapter with real rename-refuses-overwrite semantics. */
export class StrictAdapter {
  files = new Map();
  directories = new Set();
  calls = [];
  hook;
  constructor(files = {}) { for (const [file, content] of Object.entries(files)) this.files.set(file, content); }
  async hit(op, path, extra) {
    const event = { op, path, ...extra }; this.calls.push(event);
    return this.hook?.(event);
  }
  async exists(path) { await this.hit("exists", path); return this.files.has(path) || this.directories.has(path); }
  async read(path) {
    const replacement = await this.hit("read", path);
    if (replacement !== undefined) return replacement;
    if (!this.files.has(path)) throw new Error(`Missing file: ${path}`);
    return this.files.get(path);
  }
  async write(path, content) { await this.hit("write", path, { content }); this.files.set(path, content); }
  async mkdir(path) { await this.hit("mkdir", path); this.directories.add(path); }
  async remove(path) { await this.hit("remove", path); this.files.delete(path); }
  async rename(from, to) {
    await this.hit("rename", from, { to });
    if (!this.files.has(from)) throw new Error(`Missing source: ${from}`);
    if (this.files.has(to) || this.directories.has(to)) throw new Error(`Rename refuses overwrite: ${to}`);
    this.files.set(to, this.files.get(from)); this.files.delete(from);
  }
}
export function legacyState() {
  return {
    version: 1, activeSessionId: "old-b", permission: "full-access", memoryEnabled: false,
    sessions: [
      { id: "old-a", title: "原任务甲", updatedAt: 10, draft: "甲草稿\n原文", notePath: "测试/甲.md", skillId: "sample", archivedAt: 9,
        messages: [{ role: "user", content: "原问题", timestamp: 1, references: [{ path: "测试/原文.md", line: 4 }] },
          { role: "assistant", content: [{ type: "text", text: "原回答" }], timestamp: 2, custom: { evidence: [1, 2] } }],
        tools: { t1: { startedAt: 3, elapsedMs: 6, extension: "保留" } }, futureField: { untouched: true } },
      { id: "old-b", title: "原任务乙", updatedAt: 12, draft: "乙草稿", notePath: "", messages: [], tools: {} }
    ],
    memories: [memory("memory-old")], topLevelExtension: { source: "v1原文" }
  };
}
export function memory(id, revision = 1) {
  return { schema: "echoink.memory.v1", id, kind: "fact", status: "current", date: "2026-10-19", source: "fixture", basis: "explicit",
    title: `记忆 ${id}`, recallWhen: "测试", content: "合成内容", revision, file: `fixture/${id}.md` };
}
export class SecretFixture {
  values = new Map();
  writes = 0;
  getSecret(key) { return this.values.get(key) ?? null; }
  setSecret(key, value) { this.writes++; this.values.set(key, value); }
}
