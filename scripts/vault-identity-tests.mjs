import assert from "node:assert/strict";
import path from "node:path";
import { builtinModules, createRequire } from "node:module";
import { createHash } from "node:crypto";
import esbuild from "esbuild";
import { memoryFs, memoryAdapter } from "../tests/vault-identity/memory-fs.mjs";

const fs = memoryFs(), require = createRequire(import.meta.url);
const build = await esbuild.build({ stdin: { contents: [
  'export * from "./src/plugin/vault-identity";',
  'export * from "./src/storage/vault-identity";',
  'export { PersonalMemoryRepository } from "./src/harness/memory/personal-memory-repository";',
  'export { FileConversationCatalog } from "./src/harness/pi-native/file-conversation-catalog";',
  'export { MobileMemoryRepository } from "./src/mobile/memory-repository";',
  'export { serializeCanonicalMemoryRecord } from "./src/harness/memory/personal-memory-core";',
  'export { PiLocalDataService } from "./src/plugin/pi-local-data-service";',
  'export { FileApprovalTicketStore } from "./src/harness/pi-native/tool-authorization";',
  'export { FileDomainReceiptStore } from "./src/harness/pi-native/domain-receipt-store";',
  'export { prepareEchoInkCredentialDeviceScope } from "./src/plugin/credential-device-scope";',
  'export * from "./src/storage/vault-data-migration";',
  'export { parseCanonicalMemoryManifest, PersonalMemoryIdentityMismatchError } from "./src/harness/memory/personal-memory-core";',
  'export { MobileProfileProtocol } from "./src/harness/memory/mobile-profile-protocol";'
].join("\n"), resolveDir: process.cwd(), loader: "ts" }, bundle: true, write: false, platform: "node", target: "node22", format: "cjs",
  alias: { obsidian: path.resolve("src/tests/obsidian-shim.ts") }, loader: { ".md": "text", ".svg": "dataurl", ".webp": "dataurl" },
  plugins: [{ name: "offline-session-opening", setup(build) {
    build.onResolve({ filter: /^@earendil-works\/pi-coding-agent$/ }, () => ({ path: "session", namespace: "fixture" }));
    build.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: 'const unavailable = () => { throw new Error("Native Pi runtime is outside this filesystem test"); }; export const CURRENT_SESSION_VERSION = 3; export const SessionManager = { open: unavailable }; export const convertToLlm = unavailable, formatSkillsForPrompt = unavailable, sessionEntryToContextMessages = unavailable, defineTool = unavailable;', loader: "js" }));
  } }]
});
const module = { exports: {} };
new Function("module", "exports", "require", build.outputFiles[0].text)(module, module.exports, name => {
    if (name === "node:fs/promises" || name === "fs/promises") return fs;
    if (name === "node:fs" || name === "fs") return { constants: require(name).constants, watch: () => ({ close() {}, on() {}, unref() {} }) };
    if (name.startsWith("node:") || builtinModules.includes(name)) return require(name);
    throw new Error(`Unexpected filesystem-test dependency: ${name}`);
});
const api = module.exports;
const token = value => createHash("sha256").update(value).digest("hex");
const pluginDirectory = ".obsidian/plugins/codex-echoink";
const plugin = vault => `${vault}/${pluginDirectory}`;
const root = vault => `${plugin(vault)}/pi-agent-product-v1`;
const relativeRoot = `${pluginDirectory}/pi-agent-product-v1`;
const prepare = vault => api.prepareVaultIdentity({ pluginDataRoot: plugin(vault), vaultRoot: vault });
const writeJson = async (file, value) => { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, JSON.stringify(value)); };
const readJson = async file => JSON.parse(await fs.readFile(file, "utf8"));
const cloneTree = async (source, target) => {
  await fs.mkdir(target, { recursive: true });
  for (const item of await fs.readdir(source, { withFileTypes: true })) {
    const from = `${source}/${item.name}`, to = `${target}/${item.name}`;
    if (item.isDirectory()) await cloneTree(from, to); else await fs.copyFile(from, to);
  }
};
const manifest = vault => `${root(vault)}/${api.MEMORY_MANIFEST_FILE}`;
const scope = vault => ({ getVaultPath: () => vault, getPluginDataDirName: () => pluginDirectory });
const memory = async (vault, id, name) => {
  const repository = new api.PersonalMemoryRepository({ vaultPath: root(vault), vaultId: id, watchExternalChanges: false, ...(name ? { idFactory: () => name } : {}) });
  await repository.initialize(); return repository;
};
const runtime = id => ({ vaultId: id, conversationId: "conversation-fixture", piSessionId: "session-fixture", productRunId: "run-fixture", userEntryId: "user-fixture", memoryMode: "normal" });
const remember = async (repository, id, content) => (await repository.write({ operation: "create", kind: "fact", title: `合成偏好 ${content}`, content, recallWhen: content, basis: "explicit" }, runtime(id))).record;
const catalog = async (vault, id) => {
  const value = new api.FileConversationCatalog({ storageRootPath: root(vault), vaultId: id });
  await value.initialize(); return value;
};
async function seed(vault, { id = api.legacyPathVaultId(vault), name = "mem_desktop", content = "保留桌面记忆", legacyAbsolute = false } = {}) {
  await fs.mkdir(root(vault), { recursive: true });
  const repository = await memory(vault, id, name), record = await remember(repository, id, content); await repository.dispose();
  const conversations = await catalog(vault, id);
  await conversations.upsert({ vaultId: id, conversationId: "conversation-fixture", piSessionId: "session-fixture", status: "active", defaultMemoryMode: "normal", title: "迁移前的对话", createdAt: 1, updatedAt: 1 });
  const session = `${root(vault)}/vaults/${token(id)}/sessions/session-fixture.jsonl`;
  await fs.writeFile(session, '{"type":"session","id":"session-fixture"}\n');
  await conversations.sessionFile("conversation-fixture", session, 2);
  if (legacyAbsolute) { const doc = await readJson(conversations.filePath); doc.entries[0].sessionFile = session; await writeJson(conversations.filePath, doc); }
  return { id, record, session };
}
const phone = (vault, unified = true) => new api.MobileMemoryRepository(memoryAdapter(fs, vault), "phone-fixture", Date.now, undefined, unified ? relativeRoot : "");
async function mobileRemember(repository, id, content, base) {
  await repository.mutate(undefined, "identity-fixture", (draft, files) => {
    const record = { schema: "echoink.memory.v1", id, kind: "fact", status: "current", date: "2026-10-25", source: "mobile-fixture", basis: "explicit", title: "手机记忆", recallWhen: "跨端恢复", content, revision: draft.manifest.revision + 1, file: `shared-user/memory/facts/${id}.md`, ...base };
    draft.records.push(record); files.set(record.file, api.serializeCanonicalMemoryRecord(record));
  });
}
let count = 0;
async function test(name, run) { await run(); console.log(`OK ${++count} ${name}`); }
const initial = "/fixture-vault/original";
const old = await seed(initial, { legacyAbsolute: true });
let moved = "/fixture-vault/renamed";
await test("an already broken renamed main vault adopts its desktop identity and converts existing local session files", async () => {
  await fs.rename(initial, moved);
  const identity = await prepare(moved); assert.equal(identity.vaultId, old.id);
  const rows = await (await catalog(moved, old.id)).list(); assert.equal(rows.length, 1);
  assert.equal(rows[0].sessionFile, `${root(moved)}/vaults/${token(old.id)}/sessions/session-fixture.jsonl`);
  const stored = await readJson(`${root(moved)}/vaults/${token(old.id)}/conversation-catalog.v1.json`);
  assert.equal(stored.entries[0].sessionFile, "session-fixture.jsonl");
  const repository = await memory(moved, old.id); assert.equal((await repository.inspect()).records[0].content, old.record.content); await repository.dispose();
});
await test("a further move and another device use the relative session path without reading the old location", async () => {
  const next = "/fixture-vault/another-device/new-location"; await fs.mkdir(path.dirname(next), { recursive: true }); await fs.rename(moved, next); moved = next;
  assert.equal((await prepare(moved)).vaultId, old.id);
  assert.ok((await (await catalog(moved, old.id)).list())[0].sessionFile.startsWith(root(moved)));
});
const copied = "/fixture-vault/copy";
await test("copied vault keeps its identity, has no notice, and all reads/writes stay in its own folder", async () => {
  await cloneTree(moved, copied);
  const before = await fs.readFile(manifest(moved), "utf8"), identity = await prepare(copied); assert.equal(identity.vaultId, old.id);
  const service = await api.PiLocalDataService.create(scope(copied));
  try { assert.equal(service.memoryNotice, null); assert.equal((await service.listConversations()).length, 1); await remember(service.personalMemory, old.id, "只在副本写入"); }
  finally { await service.dispose(); }
  assert.equal(await fs.readFile(manifest(moved), "utf8"), before);
  assert.equal((await readJson(manifest(copied))).records.length, 2);
});
await test("no-data upgrade keeps the legacy path credential scope and every identity uses sha256 format", async () => {
  const vault = "/fixture-vault/no-data"; await fs.mkdir(vault, { recursive: true });
  const before = await api.prepareEchoInkCredentialDeviceScope({ stateRootPath: "/device-state", vaultPath: vault });
  const identity = await prepare(vault);
  const after = await api.prepareEchoInkCredentialDeviceScope({ stateRootPath: "/device-state", vaultPath: vault, vaultId: identity.vaultId });
  assert.deepEqual(before, after); assert.match(identity.vaultId, /^sha256:[a-f0-9]{64}$/u);
  await assert.rejects(api.prepareEchoInkCredentialDeviceScope({ stateRootPath: "/device-state", vaultPath: vault, vaultId: "vault_legacy" }), /device_state_unavailable/u);
});
await test("multiple historical populated catalogs and bindings are inventoried; a valid manifest wins and other stores remain", async () => {
  const vault = "/fixture-vault/history"; await cloneTree(moved, vault); await fs.unlink(`${root(vault)}/vault-identity.json`);
  const otherId = api.newVaultId(), other = await catalog(vault, otherId);
  await other.upsert({ vaultId: otherId, conversationId: "other", piSessionId: "other-session", status: "active", defaultMemoryMode: "normal", title: "另一份历史", createdAt: 1, updatedAt: 1 });
  const otherBytes = await fs.readFile(other.filePath, "utf8");
  assert.equal((await prepare(vault)).vaultId, old.id);
  assert.equal(await fs.readFile(other.filePath, "utf8"), otherBytes);
  assert.ok((await readJson(`${root(vault)}/identity-migration-report.json`)).retainedHistoricalIds.includes(otherId));
});
await test("conflicting populated histories without a valid manifest are preserved instead of creating an empty store", async () => {
  const vault = "/fixture-vault/ambiguous"; await fs.mkdir(root(vault), { recursive: true });
  for (const id of [api.newVaultId(), api.newVaultId()]) {
    const store = await catalog(vault, id); await store.upsert({ vaultId: id, conversationId: `conversation-${id.slice(-8)}`, piSessionId: `session-${id.slice(-8)}`, status: "active", defaultMemoryMode: "normal", title: "保留", createdAt: 1, updatedAt: 1 });
  }
  await assert.rejects(prepare(vault), /disagree/u); assert.equal(fs.nodes.has(`${root(vault)}/vault-identity.json`), false);
});
await test("old absolute session paths require a file in the current root and never escape the session boundary", async () => {
  const vault = "/fixture-vault/missing-session", fixture = await seed(vault, { legacyAbsolute: true });
  await fs.unlink(fixture.session);
  await assert.rejects(prepare(vault), /missing from the current vault/u);
  assert.equal(fs.nodes.has(`${root(vault)}/vault-identity.json`), false);
  assert.throws(() => api.relativeLegacySessionPath("/outside/secret.jsonl", fixture.id), /outside/u);
  assert.throws(() => api.relativeLegacySessionPath("../outside.jsonl", fixture.id), /outside/u);
});
await test("identity-only mismatch leaves tasks readable and adopt restores the existing memory immediately", async () => {
  const value = await readJson(manifest(copied)); value.vaultId = api.newVaultId(); await writeJson(manifest(copied), value);
  const service = await api.PiLocalDataService.create(scope(copied));
  try {
    assert.equal(service.memoryNotice.kind, "mismatch"); assert.equal(service.memoryError, null); assert.equal((await service.listConversations()).length, 1);
    assert.throws(() => service.assertMemoryAvailable(), /paused/u);
    await service.resolveMemory("adopt"); assert.equal(service.memoryNotice, null); assert.equal((await service.personalMemory.inspect()).records.length, 2);
  } finally { await service.dispose(); }
});
await test("reset from an identity-only mismatch archives all previous memory while keeping conversations", async () => {
  const value = await readJson(manifest(copied)); value.vaultId = api.newVaultId(); await writeJson(manifest(copied), value);
  const before = await fs.readFile(manifest(copied), "utf8"), service = await api.PiLocalDataService.create(scope(copied));
  try {
    const backup = await service.resolveMemory("reset");
    assert.equal(await fs.readFile(`${backup}/previous-memory/.runtime/manifest.json`, "utf8"), before);
    assert.equal((await service.personalMemory.inspect()).records.length, 0); assert.equal((await service.listConversations()).length, 1);
  } finally { await service.dispose(); }
});
await test("hand-importing a mobile manifest into an established vault requires explicit adoption", async () => {
  const value = await readJson(manifest(copied)); value.vaultId = "vault_hand_imported"; await writeJson(manifest(copied), value);
  const service = await api.PiLocalDataService.create(scope(copied));
  try { assert.equal(service.memoryNotice.kind, "mismatch"); assert.equal((await readJson(manifest(copied))).vaultId, value.vaultId); await service.resolveMemory("adopt"); assert.equal(service.memoryNotice, null); }
  finally { await service.dispose(); }
});
await test("damage, unsupported schemas and invalid structures are generic memory errors and cannot be adopted/reset", async () => {
  const saved = await fs.readFile(manifest(copied), "utf8");
  for (const raw of ["{broken", JSON.stringify({ ...JSON.parse(saved), schemaVersion: 99 }), JSON.stringify({ ...JSON.parse(saved), vaultId: api.newVaultId(), records: [{ id: "invalid" }] })]) {
    await fs.writeFile(manifest(copied), raw);
    const service = await api.PiLocalDataService.create(scope(copied));
    try { assert.equal(service.memoryNotice, null); assert.ok(service.memoryError); assert.equal((await service.listConversations()).length, 1); await assert.rejects(service.resolveMemory("adopt"), /unavailable for this error/u); await assert.rejects(service.resolveMemory("reset"), /unavailable for this error/u); }
    finally { await service.dispose(); }
    assert.equal(await fs.readFile(manifest(copied), "utf8"), raw);
  }
  await fs.writeFile(manifest(copied), saved);
});
await test("a memory permission failure does not become an identity mismatch or hide conversations", async () => {
  const readFile = fs.readFile;
  fs.readFile = async (file, encoding) => { if (file === manifest(copied)) throw Object.assign(new Error("fixture EACCES"), { code: "EACCES" }); return readFile(file, encoding); };
  try { const service = await api.PiLocalDataService.create(scope(copied)); try { assert.equal(service.memoryNotice, null); assert.match(service.memoryError, /EACCES/u); assert.equal((await service.listConversations()).length, 1); } finally { await service.dispose(); } }
  finally { fs.readFile = readFile; }
});
await test("phone-only legacy memory is backed up, moved to the shared root and given a sha256 identity", async () => {
  const vault = "/fixture-vault/phone-only"; await fs.mkdir(vault, { recursive: true });
  const mobile = phone(vault, false); await mobileRemember(mobile, "mem_phone", "旧手机记忆");
  const legacyFile = `${vault}/.echoink/shared-user/.runtime/manifest.json`, value = await readJson(legacyFile); value.vaultId = "vault_legacy_uuid"; await writeJson(legacyFile, value);
  const before = await fs.readFile(legacyFile, "utf8"), identity = await prepare(vault);
  assert.match(identity.vaultId, /^sha256:/u); assert.notEqual(identity.vaultId, value.vaultId); assert.equal(await fs.readFile(legacyFile, "utf8"), before);
  const repository = await memory(vault, identity.vaultId); assert.equal((await repository.inspect()).records[0].content, "旧手机记忆"); await repository.dispose();
  const report = await readJson(`${root(vault)}/mobile-memory-migration.json`);
  assert.equal(await fs.readFile(`${vault}/${report.backup}/legacy-mobile/shared-user/.runtime/manifest.json`, "utf8"), before);
});
await test("both memory trees merge by record id with desktop conflicts retained and full mobile backup", async () => {
  const vault = "/fixture-vault/both"; const { id, record } = await seed(vault, { name: "mem_same", content: "桌面版本" });
  const mobile = phone(vault, false); await mobileRemember(mobile, "mem_same", "手机版本", { ...record, content: "手机版本" }); await mobileRemember(mobile, "mem_mobile_only", "手机独有");
  const identity = await prepare(vault); assert.equal(identity.vaultId, id);
  const repository = await memory(vault, id), records = (await repository.inspect()).records; await repository.dispose();
  assert.equal(records.length, 2); assert.equal(records.find(item => item.id === "mem_same").content, "桌面版本"); assert.equal(records.find(item => item.id === "mem_mobile_only").content, "手机独有");
  const report = await readJson(`${root(vault)}/mobile-memory-migration.json`);
  assert.deepEqual(report.conflictingRecordIds, ["mem_same"]); assert.deepEqual(report.importedRecordIds, ["mem_mobile_only"]);
  assert.match(await fs.readFile(`${vault}/${report.backup}/legacy-mobile/shared-user/memory/facts/mem_same.md`, "utf8"), /手机版本/u);
  await prepare(vault); assert.equal((await readJson(manifest(vault))).records.length, 2);
});
await test("mobile upgrade itself merges both trees before writing and reads the same desktop memory", async () => {
  const vault = "/fixture-vault/mobile-upgrade"; await seed(vault);
  const legacy = phone(vault, false); await mobileRemember(legacy, "mem_phone_old", "旧手机写入");
  const current = phone(vault), snapshot = await current.snapshot(); assert.equal(snapshot.records.length, 2);
  assert.match(snapshot.manifest.vaultId, /^sha256:/u); assert.equal((await prepare(vault)).vaultId, snapshot.manifest.vaultId);
});
await test("phone and desktop writes are visible in both directions in the same canonical memory", async () => {
  const vault = "/fixture-vault/bidirectional"; await fs.mkdir(vault, { recursive: true });
  const mobile = phone(vault); await mobileRemember(mobile, "mem_phone_new", "手机新写入");
  const identity = await prepare(vault), desktop = await memory(vault, identity.vaultId);
  assert.equal((await desktop.inspect()).records[0].content, "手机新写入");
  await remember(desktop, identity.vaultId, "桌面新写入"); await desktop.dispose();
  assert.ok((await mobile.snapshot()).records.some(record => record.content === "桌面新写入"));
  const profile = new api.MobileProfileProtocol(memoryAdapter(fs, vault), Date.now, { read: () => "fixture", create: () => "fixture" }, `${relativeRoot}/.echoink/`);
  assert.match(await profile.context(true), /桌面|手机/u);
});
await test("a custom shared config directory hosts both identity and memory", async () => {
  const vault = "/fixture-vault/custom-config"; await fs.mkdir(vault, { recursive: true });
  const custom = ".custom/plugins/codex-echoink/pi-agent-product-v1", mobile = new api.MobileMemoryRepository(memoryAdapter(fs, vault), "phone-custom", Date.now, undefined, custom);
  await mobileRemember(mobile, "mem_custom", "自定义配置");
  const identity = await api.prepareVaultIdentity({ pluginDataRoot: `${vault}/.custom/plugins/codex-echoink`, vaultRoot: vault });
  const desktop = new api.PersonalMemoryRepository({ vaultPath: `${vault}/${custom}`, vaultId: identity.vaultId, watchExternalChanges: false });
  try { assert.equal((await desktop.inspect()).records[0].content, "自定义配置"); } finally { await desktop.dispose(); }
  assert.equal(fs.nodes.has(`${vault}/.obsidian/plugins/codex-echoink/pi-agent-product-v1/vault-identity.json`), false);
});
await test("an interrupted migration is rolled back and safely rerun without losing or duplicating data", async () => {
  const vault = "/fixture-vault/interrupted", fixture = await seed(vault, { legacyAbsolute: true });
  const io = api.nodeVaultMigrationIO(vault), normalWrite = io.write;
  let crashed = false;
  io.write = async (file, bytes) => {
    if (crashed) throw new Error("fixture process stopped");
    await normalWrite(file, bytes);
    if (file.endsWith("conversation-catalog.v1.json")) { crashed = true; throw new Error("fixture process stopped"); }
  };
  await assert.rejects(api.preparePortableVaultData({ io, root: relativeRoot, fallbackVaultId: api.legacyPathVaultId(vault) }), /process stopped/u);
  assert.equal(fs.nodes.has(`${root(vault)}/vault-identity.json`), false);
  assert.equal((await prepare(vault)).vaultId, fixture.id);
  assert.equal((await readJson(`${root(vault)}/vaults/${token(fixture.id)}/conversation-catalog.v1.json`)).entries[0].sessionFile, "session-fixture.jsonl");
  assert.equal((await readJson(manifest(vault))).records.length, 1);
});
await test("catalog writes persist relative paths while returning absolute paths bound to their current storage root", async () => {
  const conversations = await catalog(moved, old.id), rows = await conversations.list();
  await conversations.rename(rows[0].conversationId, "相对路径写回");
  const raw = await readJson(conversations.filePath); assert.equal(raw.entries[0].sessionFile, "session-fixture.jsonl");
  assert.ok((await conversations.list())[0].sessionFile.startsWith(root(moved)));
});
await test("legacy path conversion checks file existence without reading session bodies", async () => {
  const vault = "/fixture-vault/no-session-body-read"; await seed(vault, { legacyAbsolute: true });
  const io = api.nodeVaultMigrationIO(vault), read = io.read;
  io.read = file => { if (file.endsWith(".jsonl")) throw new Error("Session bodies must stay lazy"); return read(file); };
  await api.preparePortableVaultData({ io, root: relativeRoot, fallbackVaultId: api.legacyPathVaultId(vault) });
});
console.log(`PASS ${count} vault identity / shared-memory scenarios (production modules, in-memory filesystem; native acceptance is separate)`);
