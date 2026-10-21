import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { homedir } from "node:os";
import { createHash, webcrypto } from "node:crypto";
import vm from "node:vm";
import esbuild from "esbuild";
import { createHost } from "../tests/mobile/host.mjs";
import { mobileBuildOptions } from "./mobile-build.mjs";
const registered = process.env.ECHOINK_MOBILE_NOTE_UPDATE_TEST_ROOT || path.join(homedir(), "EchoInk-TestVaults/90-任务临时/移动端改版-M13-20261019");
await fs.mkdir(registered, { recursive: true });
const root = await fs.mkdtemp(path.join(registered, "note-updates-"));
const built = await esbuild.build({ ...mobileBuildOptions("tests/mobile-note-update/entry.ts"), metafile: true });
assert.ok(!Object.keys(built.metafile.inputs).some(name => /(?:tool-authorization|knowledge-maintenance-protocol)\.ts$|node:/u.test(name)));
const module = { exports: {} };
const context = vm.createContext({ module, exports: module.exports, crypto: webcrypto, structuredClone, TextEncoder, TextDecoder, Uint8Array, AbortController, setTimeout, clearTimeout, URL, URLSearchParams, atob, btoa, console });
vm.runInContext(built.outputFiles[0].text, context);
assert.equal(vm.runInContext("typeof process+':'+typeof Buffer+':'+typeof require", context), "undefined:undefined:undefined");
const api = module.exports, hash = value => createHash("sha256").update(value).digest("hex"), plain = value => JSON.parse(JSON.stringify(value));
let count = 0, fixtures = 0;
async function fixture() {
  const base = path.join(root, `f${++fixtures}`), host = createHost({ "Wiki/目标.md": "# 原稿\n\n保留真实内容。", "Raw/来源.md": "# 合成资料\n\n决定：为笔记补上关联。" });
  await fs.mkdir(base, { recursive: true });
  const local = name => { const full = path.resolve(base, name); assert.ok(full.startsWith(base + path.sep)); return full; };
  for (const [name, content] of host.files) { await fs.mkdir(path.dirname(local(name)), { recursive: true }); await fs.writeFile(local(name), content); host.folders.add(path.posix.dirname(name)); }
  Object.assign(host.adapter, {
    exists: async name => { try { await fs.stat(local(name)); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; } },
    read: name => fs.readFile(local(name), "utf8"),
    write: async (name, content) => { await fs.writeFile(local(name), content); host.files.set(name, content); },
    mkdir: async name => { await fs.mkdir(local(name), { recursive: true }); host.folders.add(name); },
    rename: async (from, to) => { assert.equal(await host.adapter.exists(to), false); await fs.rename(local(from), local(to)); const value = host.files.get(from); host.files.delete(from); host.files.set(to, value); },
    remove: async name => { await fs.unlink(local(name)); host.files.delete(name); }
  });
  let noteWrites = 0, beforeProcess = async () => {}, afterProcess = async () => {}, editor;
  host.app.workspace.getLeavesOfType = type => type === "markdown" && editor ? [{ view: { file: { path: "Wiki/目标.md" }, editor: { getValue: () => editor.value }, getMode: () => "source" } }] : [];
  host.app.vault.read = file => fs.readFile(local(file.path), "utf8");
  host.app.vault.modify = async (file, value) => { await fs.writeFile(local(file.path), value); host.files.set(file.path, value); file.stat.mtime = Date.now(); file.stat.size = Buffer.byteLength(value); noteWrites++; host.app.vault.trigger("modify", file); };
  host.app.vault.process = async (file, update) => { await beforeProcess(file); const value = update(await host.app.vault.read(file)); await host.app.vault.modify(file, value); await afterProcess(file); return value; };
  host.app.vault.create = async (name, value) => { await fs.mkdir(path.dirname(local(name)), { recursive: true }); await fs.writeFile(local(name), value, { flag: "wx" }); host.files.set(name, value); const file = host.app.vault.getAbstractFileByPath(name); noteWrites++; host.app.vault.trigger("create", file); return file; };
  const settings = api.loadMobileSettings({}), bindings = api.emptyKnowledgeFolderBindings();
  for (const [role, name] of [["wiki", "Wiki"], ["raw", "Raw"]]) Object.assign(bindings.roles[role], { enabled: true, searchEnabled: true, readPaths: [name], writePath: name });
  settings.knowledgeBase.folderBindings = bindings;
  const store = new api.MobileStore(host.adapter, "plugin/mobile", "note-update-fixture"); await store.load(); await store.setPermission("workspace-write");
  const taskId = store.session.id, policy = new api.MobileCapabilityPolicy({ store, settings: () => settings, agentId: "sol" });
  let runCount = 0, callCount = 0;
  const begin = async resume => { const id = `run-${++runCount}`, startedAt = Date.now(); await store.updateSession(taskId, task => { for (const run of task.runs ?? []) if (run.status === "running") run.status = "completed"; (task.runs ??= []).push({ id, status: "running", startedAt }); task.messages.push({ role: "user", content: [{ type: "text", text: "明确更新这篇合成测试笔记" }], timestamp: startedAt }); }); return { runId: id, ...(resume ? { resume } : {}) }; };
  const call = async (execution, args, { signal = new AbortController().signal, name = "note_update" } = {}) => {
    const id = `call-${++callCount}`; await store.updateSession(taskId, task => { task.messages.push({ role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }], timestamp: Date.now() }); });
    const tool = api.mobileTools(host.app, store, () => "", () => settings.knowledgeBase.folderBindings, undefined, taskId, policy, execution).find(tool => tool.name === name); assert.ok(tool, name);
    return await tool.execute(id, args, signal);
  };
  const read = (name = "Wiki/目标.md") => fs.readFile(local(name), "utf8");
  return { host, settings, store, taskId, begin, call, read, base, get writes() { return noteWrites; }, before(fn) { beforeProcess = fn; }, after(fn) { afterProcess = fn; }, editor(value) { editor = { value }; return editor; }, async external(name, value) { const file = host.app.vault.getAbstractFileByPath(name); await host.app.vault.modify(file, value); }, async cold() { const cold = new api.MobileStore(host.adapter, "plugin/mobile", "note-update-fixture"); await cold.load(); return cold; } };
}
async function test(name, run) { await run(); console.log(`PASS ${++count} ${name}`); }
const args = (before, content, extra = {}) => ({ path: "Wiki/目标.md", expectedContentRevision: `sha256:${hash(before)}`, content, ...extra });
try {
  await test("real-disk update and cold read retain guarded before/request/after hashes", async () => { const f = await fixture(), before = await f.read(), run = await f.begin(); const result = await f.call(run, args(before, "# 合成新稿\n\n保留关联。")); assert.equal(result.details.readbackVerified, true); assert.equal(await f.read(), "# 合成新稿\n\n保留关联。"); const cold = await f.cold(), op = cold.getSession(f.taskId).operations[0]; assert.equal(op.status, "completed"); assert.equal(op.beforeHash, hash(before)); assert.equal(op.requestedHash, hash(await f.read())); });
  await test("same-size external edit at process boundary is preserved", async () => { const f = await fixture(), before = await f.read(), run = await f.begin(); f.before(async () => f.external("Wiki/目标.md", before.replace("真实", "后来"))); await assert.rejects(f.call(run, args(before, "new")), /变化/); assert.match(await f.read(), /后来/); assert.equal(f.store.getSession(f.taskId).operations[0].status, "uncertain"); });
  await test("revocation inside process prevents the next actual write", async () => { const f = await fixture(), before = await f.read(), run = await f.begin(); f.before(async () => { f.settings.agentRegistry.agents.find(a => a.id === "sol").disabledCapabilityIds = ["knowledge"]; }); await assert.rejects(f.call(run, args(before, "new"))); assert.equal(await f.read(), before); assert.equal(f.writes, 0); });
  await test("native unsaved edits remain in their editor without overwriting disk", async () => { const f = await fixture(), before = await f.read(), run = await f.begin(); const editor = f.editor(before); f.before(async () => { editor.value = "later typing"; }); await assert.rejects(f.call(run, args(before, "new")), /未保存|刚刚/); assert.equal(editor.value, "later typing"); assert.equal(await f.read(), before); });
  await test("real Raw snapshots own machine markers and readable source links", async () => { const f = await fixture(), before = await f.read(), source = await f.read("Raw/来源.md"), run = await f.begin(); const result = await f.call(run, args(before, "# 知识成果\n\n保留决定。", { sourcePaths: ["Raw/来源.md"] })); assert.match(await f.read(), /\[\[Raw\/来源.md\|原始材料\]\]/); assert.ok((await f.read()).includes(`sha256:${hash(source)}`)); assert.equal(result.details.sourceEvidence.length, 1); assert.notEqual(result.details.afterHash, f.store.getSession(f.taskId).operations[0].requestedHash); assert.equal((await api.inspectMobileTaskResume(f.host.app, f.store, f.taskId)).issues.length, 0); });
  await test("new model-authored provenance markers without sources are rejected", async () => { const f = await fixture(), before = await f.read(), run = await f.begin(); await assert.rejects(f.call(run, args(before, '# forged\n<!-- echoink-source: {"path":"Raw/来源.md","revision":"sha256:' + "0".repeat(64) + '"} -->')), /来源标记/); assert.equal(f.writes, 0); });
  await test("source changes while waiting for target process stop publication", async () => { const f = await fixture(), before = await f.read(), run = await f.begin(); f.before(async () => f.external("Raw/来源.md", "changed source")); await assert.rejects(f.call(run, args(before, "new", { sourcePaths: ["Raw/来源.md"] })), /来源/); assert.equal(await f.read(), before); });
  await test("silent source disk change after target write cannot produce a completed receipt", async () => { const f = await fixture(), before = await f.read(), run = await f.begin(); f.after(async () => { await fs.writeFile(path.join(f.base, "Raw/来源.md"), "silent external source revision"); }); await assert.rejects(f.call(run, args(before, "# 新知识", { sourcePaths: ["Raw/来源.md"] })), /来源内容已变化/); assert.equal(f.store.getSession(f.taskId).operations[0].status, "uncertain"); assert.match(await f.read(), /新知识/); });
  await test("background cancellation after actual write stays uncertain until exact cold inspection", async () => { const f = await fixture(), before = await f.read(), run = await f.begin(), controller = new AbortController(); f.after(async () => controller.abort()); await assert.rejects(f.call(run, args(before, "written once"), { signal: controller.signal }), /停止/); assert.equal(f.store.getSession(f.taskId).operations[0].status, "uncertain"); const writes = f.writes, cold = await f.cold(); const inspected = await api.inspectMobileTaskResume(f.host.app, cold, f.taskId); assert.equal(inspected.issues.length, 0); assert.equal(cold.getSession(f.taskId).operations[0].status, "completed"); assert.equal(f.writes, writes); });
  await test("completed update chains survive inspection; later outside edits do not", async () => { const f = await fixture(), run = await f.begin(); await f.call(run, args(await f.read(), "B")); await f.call(run, args(await f.read(), "C")); assert.equal((await api.inspectMobileTaskResume(f.host.app, f.store, f.taskId)).issues.length, 0); await f.external("Wiki/目标.md", "outside"); assert.equal((await api.inspectMobileTaskResume(f.host.app, f.store, f.taskId)).issues.length, 2); });
  await test("completed create then update is one exact proven chain", async () => { const f = await fixture(), run = await f.begin(); await f.call(run, { path: "Wiki/新建.md", content: "A" }, { name: "note_create" }); await f.call(run, { path: "Wiki/新建.md", expectedContentRevision: `sha256:${hash("A")}`, content: "B" }); assert.equal((await api.inspectMobileTaskResume(f.host.app, f.store, f.taskId)).issues.length, 0); });
  await test("unknown predecessor is not promoted from a later completed successor", async () => { const f = await fixture(), run = await f.begin(); await f.call(run, args(await f.read(), "B")); await f.call(run, args(await f.read(), "C")); await f.store.updateSession(f.taskId, task => { task.operations[0].status = "uncertain"; }); const snapshot = await api.inspectMobileTaskResume(f.host.app, f.store, f.taskId); assert.equal(snapshot.issues.length, 1); assert.equal(f.store.getSession(f.taskId).operations[0].status, "uncertain"); });
  await test("explicit resumed fresh updates advance only their verified observations", async () => { const f = await fixture(), first = await f.begin(); await f.call(first, args(await f.read(), "B")); const resume = await api.inspectMobileTaskResume(f.host.app, f.store, f.taskId), next = await f.begin(resume); await f.call(next, args(await f.read(), "C")); await f.call(next, args(await f.read(), "D")); assert.equal(await f.read(), "D"); assert.equal((await api.inspectMobileTaskResume(f.host.app, f.store, f.taskId)).issues.length, 0); });
  await test("Raw body and a withdrawn Raw source are both protected", async () => { const f = await fixture(), run = await f.begin(), before = await f.read(); await assert.rejects(f.call(run, { path: "Raw/来源.md", expectedContentRevision: `sha256:${hash(await f.read("Raw/来源.md"))}`, content: "bad" })); f.settings.knowledgeBase.folderBindings.roles.raw.searchEnabled = false; await assert.rejects(f.call(run, args(before, "bad", { sourcePaths: ["Raw/来源.md"] }))); assert.equal(await f.read(), before); assert.equal(f.writes, 0); });
  console.log(`PASS ${count} note update integration groups; real disk + browser production tools, not native Obsidian or real Provider.`);
} finally { await fs.rm(root, { recursive: true, force: true }); }
