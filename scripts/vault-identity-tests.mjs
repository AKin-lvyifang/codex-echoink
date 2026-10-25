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
  'export { prepareEchoInkCredentialDeviceScope } from "./src/plugin/credential-device-scope";'
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
const device = "/fixture-device";
const prepare = (vault, stateRoot = device) => api.prepareVaultIdentity({ pluginDataRoot: plugin(vault), vaultRoot: vault, deviceStateRoot: stateRoot });
const writeJson = async (file, value) => { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, JSON.stringify(value)); };
const readJson = async file => JSON.parse(await fs.readFile(file, "utf8"));
const cloneTree = async (source, target) => {
  await fs.mkdir(target, { recursive: true });
  for (const item of await fs.readdir(source, { withFileTypes: true })) {
    const from = `${source}/${item.name}`, to = `${target}/${item.name}`;
    if (item.isDirectory()) await cloneTree(from, to); else await fs.copyFile(from, to);
  }
};
const memory = async (vault, id) => {
  const repository = new api.PersonalMemoryRepository({ vaultPath: root(vault), vaultId: id, watchExternalChanges: false });
  await repository.initialize(); return repository;
};
const catalog = async (vault, id) => {
  const catalog = new api.FileConversationCatalog({ storageRootPath: root(vault), vaultId: id });
  await catalog.initialize(); return catalog;
};
const manifest = vault => `${root(vault)}/${api.MEMORY_MANIFEST_FILE}`;
let count = 0;
async function test(name, run) { await run(); console.log(`OK ${++count} ${name}`); }
const initial = "/fixture-vault/original";
const oldId = `sha256:${token(`echoink-vault-identity-v1\0${initial}`)}`;
await test("main-format memory and conversation migration keeps the old identity and credential digest", async () => {
  await fs.mkdir(root(initial), { recursive: true });
  const beforeScope = await api.prepareEchoInkCredentialDeviceScope({ stateRootPath: device, vaultPath: initial });
  const repository = await memory(initial, oldId);
  await repository.write({ operation: "create", kind: "fact", title: "合成偏好", content: "保留迁移前的记忆", recallWhen: "测试迁移", basis: "explicit" }, {
    vaultId: oldId, conversationId: "conversation-fixture", piSessionId: "session-fixture", productRunId: "run-fixture", userEntryId: "user-fixture", memoryMode: "normal"
  });
  await repository.dispose();
  const conversations = await catalog(initial, oldId);
  await conversations.upsert({ vaultId: oldId, conversationId: "conversation-fixture", piSessionId: "session-fixture", status: "active", defaultMemoryMode: "normal", title: "迁移前的对话", createdAt: 1, updatedAt: 1 });
  const identity = await prepare(initial);
  assert.equal(identity.vaultId, oldId); assert.equal(api.vaultIdDigest(oldId), oldId);
  const afterScope = await api.prepareEchoInkCredentialDeviceScope({ stateRootPath: device, vaultPath: initial, vaultId: identity.vaultId });
  assert.deepEqual(afterScope, beforeScope);
  assert.equal((await readJson(manifest(initial))).records.length, 1);
  assert.equal((await conversations.list()).length, 1);
  assert.ok([...fs.nodes.keys()].some(file => file.startsWith(`${plugin(initial)}/vault-identity-backups/`) && file.endsWith("before/vaults/" + token(oldId) + "/conversation-catalog.v1.json")));
});
let moved = "/fixture-vault/moved/renamed";
await test("rename/move rebases persisted absolute session paths and keeps memory/conversations without a notice", async () => {
  const conversations = await catalog(initial, oldId);
  const file = `${root(initial)}/vaults/${token(oldId)}/sessions/session-fixture.jsonl`;
  await fs.writeFile(file, '{"type":"session","id":"session-fixture"}\n');
  await conversations.sessionFile("conversation-fixture", file, 2);
  await fs.mkdir(path.dirname(moved), { recursive: true }); await fs.rename(initial, moved);
  const identity = await prepare(moved); assert.equal(identity.vaultId, oldId); assert.equal(identity.copiedFrom, undefined);
  const rows = await (await catalog(moved, identity.vaultId)).list(); assert.equal(rows.length, 1);
  assert.equal(rows[0].sessionFile, `${root(moved)}/vaults/${token(oldId)}/sessions/session-fixture.jsonl`);
  const repository = await memory(moved, oldId); await repository.dispose();
});
await test("a second device opens the moved vault without a copy notice", async () => {
  const identity = await prepare(moved, "/second-device"); assert.equal(identity.vaultId, oldId); assert.equal(identity.copiedFrom, undefined);
  assert.equal((await (await catalog(moved, oldId)).list()).length, 1);
});
const copied = "/fixture-vault/copy";
let copyIdentity;
await test("copy gets independent ownership, paths, bindings and checksummed maintenance data", async () => {
  const approvals = new api.FileApprovalTicketStore({ storageRootPath: root(moved), vaultId: oldId, now: () => 10 });
  const receipts = new api.FileDomainReceiptStore({ storageRootPath: root(moved), vaultId: oldId, now: () => 10 });
  await approvals.initialize(); await receipts.initialize();
  for (const toolCallId of ["completed-write", "pending-write"]) {
    const contract = { productRunId: "run-fixture", toolCallId, conversationId: "conversation-fixture", piSessionId: "session-fixture", userId: "user-fixture", vaultId: oldId, deviceId: "device-fixture", toolId: "note_create", toolVersion: "v1", policyVersion: "v1", normalizedArguments: { content: "合成内容", metadata: { vaultId: oldId } }, resolvedTarget: { relativePath: "fixture.md" }, targetVersion: {}, preview: { text: "合成预览" } };
    const ticket = await approvals.issue({ ...contract, issuedAt: 1, expiresAt: 100 });
    if (toolCallId === "completed-write") {
      const authorization = await approvals.consume({ ticketId: ticket.ticketId, operationIdentity: ticket.operationIdentity, contract });
      await receipts.beginAuthorizedOperation(authorization); await receipts.markEffectStarted(ticket.operationIdentity); await receipts.markEffectCompleted(ticket.operationIdentity);
      await receipts.persistReceipt({ operationIdentity: ticket.operationIdentity, status: "completed", safeSummary: { operation: "note_create" }, readback: { checkedAt: 10, readbackVerified: true, observedTargetVersion: {}, safeSummary: {} } });
    }
  }
  const payload = { vaultId: oldId, note: oldId };
  await writeJson(`${root(moved)}/knowledge/records/synthetic.json`, { schemaVersion: 1, vaultId: oldId, kind: "record", payload, payloadDigest: token(api.stableIdentityJson(payload)) });
  await cloneTree(moved, copied);
  const sourceBefore = await fs.readFile(manifest(moved), "utf8");
  copyIdentity = await prepare(copied); assert.notEqual(copyIdentity.vaultId, oldId); assert.equal(copyIdentity.copiedFrom, "renamed");
  assert.equal((await readJson(manifest(copied))).vaultId, copyIdentity.vaultId);
  assert.equal((await readJson(manifest(copied))).records.length, 1);
  assert.equal(await fs.readFile(manifest(moved), "utf8"), sourceBefore);
  const rows = await (await catalog(copied, copyIdentity.vaultId)).list(); assert.equal(rows.length, 1);
  assert.ok(rows[0].sessionFile.startsWith(root(copied)));
  const record = await readJson(`${root(copied)}/knowledge/records/synthetic.json`);
  assert.equal(record.vaultId, copyIdentity.vaultId); assert.equal(record.payload.vaultId, copyIdentity.vaultId); assert.equal(record.payload.note, oldId);
  assert.equal(record.payloadDigest, token(api.stableIdentityJson(record.payload)));
  const copyApprovals = new api.FileApprovalTicketStore({ storageRootPath: root(copied), vaultId: copyIdentity.vaultId, now: () => 10 });
  const copyReceipts = new api.FileDomainReceiptStore({ storageRootPath: root(copied), vaultId: copyIdentity.vaultId, now: () => 10 });
  const approved = await copyApprovals.get("run-fixture", "completed-write");
  assert.equal(approved.status, "approved");
  assert.equal((await copyApprovals.get("run-fixture", "pending-write")).status, "pending");
  assert.equal(approved.ticket.normalizedArguments.metadata.vaultId, oldId, "user payload is not rewritten as storage ownership");
  const receipt = await copyReceipts.readReceipt(approved.ticket.operationIdentity);
  assert.equal(receipt.status, "completed"); assert.equal(receipt.approvalTicketId, approved.ticket.ticketId);
  assert.equal((await copyReceipts.readOperation(approved.ticket.operationIdentity)).vaultId, copyIdentity.vaultId);
  assert.equal((await prepare(moved)).vaultId, oldId);
});
await test("copy notice dismissal persists and does not change the identity", async () => {
  await api.dismissVaultCopyNotice(plugin(copied), copyIdentity);
  const reopened = await prepare(copied); assert.equal(reopened.vaultId, copyIdentity.vaultId); assert.equal(reopened.copiedFrom, undefined);
});
await test("start fresh keeps conversations, archives the old memory, and opens the new repository immediately", async () => {
  const original = await fs.readFile(manifest(copied), "utf8");
  const backup = await api.repairVaultMemory({ pluginDataRoot: plugin(copied), identity: copyIdentity, action: "reset", validate: async () => { const repository = await memory(copied, copyIdentity.vaultId); await repository.dispose(); } });
  assert.equal(await fs.readFile(`${backup}/previous-memory/.runtime/manifest.json`, "utf8"), original);
  assert.equal((await readJson(manifest(copied))).records.length, 0);
  assert.equal((await readJson(manifest(moved))).records.length, 1);
  assert.equal((await (await catalog(copied, copyIdentity.vaultId)).list()).length, 1);
});
await test("foreign memory is left unread until adoption, then opens without restarting or changing conversations", async () => {
  await cloneTree(`${root(moved)}/.echoink/shared-user`, `${root(copied)}/.echoink/shared-user`);
  const foreign = await readJson(manifest(copied)); foreign.vaultId = "vault_foreign_mobile"; await writeJson(manifest(copied), foreign);
  await prepare(copied); assert.equal((await readJson(manifest(copied))).vaultId, foreign.vaultId);
  await assert.rejects(memory(copied, copyIdentity.vaultId), /belongs to another Vault/u);
  await api.repairVaultMemory({ pluginDataRoot: plugin(copied), identity: copyIdentity, action: "adopt", validate: async () => { const repository = await memory(copied, copyIdentity.vaultId); await repository.dispose(); } });
  assert.equal((await readJson(manifest(copied))).vaultId, copyIdentity.vaultId);
  assert.equal((await readJson(manifest(copied))).records.length, 1);
  assert.equal((await (await catalog(copied, copyIdentity.vaultId)).list()).length, 1);
});
await test("failed recovery restores exact original memory bytes and preserves the backup", async () => {
  const bytes = await fs.readFile(manifest(copied), "utf8");
  await assert.rejects(api.repairVaultMemory({ pluginDataRoot: plugin(copied), identity: copyIdentity, action: "reset", validate: async () => { throw new Error("injected validation failure"); } }), /injected validation failure/u);
  assert.equal(await fs.readFile(manifest(copied), "utf8"), bytes);
  assert.ok([...fs.nodes.keys()].some(file => file.startsWith(`${plugin(copied)}/vault-identity-backups/`) && file.includes("interrupted-")));
});
await test("an already broken main-format renamed vault adopts the manifest identity and restores old conversations", async () => {
  const broken = "/fixture-vault/already-broken"; await cloneTree(moved, broken);
  await fs.unlink(`${root(broken)}/${api.VAULT_IDENTITY_FILE}`);
  const identity = await prepare(broken, "/upgrade-device"); assert.equal(identity.vaultId, oldId);
  assert.equal((await (await catalog(broken, oldId)).list()).length, 1);
  const repository = await memory(broken, oldId); await repository.dispose();
});
await test("without a manifest, a populated conversation identity wins over empty path-era directories", async () => {
  const vault = "/fixture-vault/conversations-only"; await fs.mkdir(root(vault), { recursive: true });
  await cloneTree(`${root(moved)}/vaults`, `${root(vault)}/vaults`);
  await catalog(vault, "empty-path-era-id");
  assert.equal((await prepare(vault, "/conversations-device")).vaultId, oldId);
});
await test("phone-first memory uses the shared identity/file root and desktop reads it", async () => {
  const vault = "/fixture-vault/phone-first"; await fs.mkdir(vault, { recursive: true });
  const repository = new api.MobileMemoryRepository(memoryAdapter(fs, vault), "phone-fixture", Date.now, undefined, `${pluginDirectory}/pi-agent-product-v1`);
  await repository.mutate(undefined, "identity-fixture", (draft, files) => {
    const record = { schema: "echoink.memory.v1", id: "mem_phone", kind: "fact", status: "current", date: "2026-10-25", source: "mobile-fixture", basis: "explicit", title: "手机记忆", recallWhen: "跨端恢复", content: "手机先写，桌面接上", revision: draft.manifest.revision + 1, file: "shared-user/memory/facts/mem_phone.md" };
    draft.records.push(record); files.set(record.file, api.serializeCanonicalMemoryRecord(record));
  });
  const snapshot = await repository.snapshot(); assert.equal(snapshot.records.length, 1);
  const identity = await prepare(vault);
  assert.equal(snapshot.manifest.vaultId, identity.vaultId);
  const desktop = await memory(vault, identity.vaultId); await desktop.dispose();
  assert.equal((await readJson(manifest(vault))).vaultId, identity.vaultId);
  assert.equal((await readJson(manifest(vault))).records.length, 1);
});
await test("old phone memory in the vault root is imported with its identity and its old files retained", async () => {
  const vault = "/fixture-vault/old-phone"; await fs.mkdir(vault, { recursive: true });
  const phone = new api.MobileMemoryRepository(memoryAdapter(fs, vault), "legacy-phone");
  const snapshot = await phone.snapshot();
  const oldPath = `${vault}/.echoink/shared-user/.runtime/manifest.json`;
  const bytes = await fs.readFile(oldPath, "utf8"), legacy = JSON.parse(bytes); legacy.vaultId = "vault_old_mobile_uuid";
  await writeJson(oldPath, legacy);
  const identity = await prepare(vault); assert.equal(identity.vaultId, legacy.vaultId);
  assert.equal((await readJson(oldPath)).vaultId, legacy.vaultId);
  assert.match(api.vaultIdDigest(identity.vaultId), /^sha256:[a-f0-9]{64}$/u);
  const desktop = await memory(vault, identity.vaultId); await desktop.dispose();
  assert.notEqual(snapshot.manifest.vaultId, identity.vaultId);
});
await test("new phone version imports old phone data to the same desktop root", async () => {
  const vault = "/fixture-vault/phone-upgrade"; await fs.mkdir(vault, { recursive: true });
  const adapter = memoryAdapter(fs, vault), old = new api.MobileMemoryRepository(adapter, "old");
  const before = await old.snapshot();
  const upgraded = new api.MobileMemoryRepository(adapter, "new", Date.now, undefined, `${pluginDirectory}/pi-agent-product-v1`);
  assert.equal((await upgraded.snapshot()).manifest.vaultId, before.manifest.vaultId);
  assert.equal((await prepare(vault)).vaultId, before.manifest.vaultId);
  assert.ok(await adapter.exists(".echoink/shared-user/.runtime/manifest.json"));
});
await test("copy decision and document rebasing support missing/replaced originals and Windows paths", async () => {
  assert.equal(api.vaultWasCopied("new", "old", null, oldId), false);
  assert.equal(api.vaultWasCopied("new", "old", "replaced-identity", oldId), false);
  const file = `C:\\Notes\\.obsidian\\plugins\\codex-echoink\\pi-agent-product-v1\\vaults\\${token(oldId)}\\sessions\\session.jsonl`;
  const rebound = api.rebindVaultDocument({ vaultId: oldId, sessionFile: file, text: file }, oldId, "next", "D:\\Copy\\sessions");
  assert.equal(rebound.sessionFile, "D:\\Copy\\sessions/session.jsonl"); assert.equal(rebound.text, file);
});
await test("the actual local-data service keeps conversations available during memory mismatch and recovers immediately", async () => {
  const foreign = await readJson(manifest(copied)); foreign.vaultId = "foreign-import"; await writeJson(manifest(copied), foreign);
  const service = await api.PiLocalDataService.create({ getVaultPath: () => copied, getPluginDataDirName: () => pluginDirectory });
  try {
    assert.equal(service.memoryNotice.kind, "mismatch");
    assert.equal((await service.listConversations()).length, 1);
    assert.throws(() => service.assertMemoryAvailable(), /paused/u);
    await service.resolveMemory("adopt");
    assert.equal(service.memoryNotice, null); service.assertMemoryAvailable();
    assert.equal((await service.personalMemory.inspect()).records.length, 1);
    assert.equal((await service.listConversations()).length, 1);
  } finally { await service.dispose(); }
});
await test("a damaged manifest produces one recoverable memory issue; reset preserves bytes and keeps the service alive", async () => {
  const broken = "{damaged fixture manifest"; await fs.writeFile(manifest(copied), broken);
  const service = await api.PiLocalDataService.create({ getVaultPath: () => copied, getPluginDataDirName: () => pluginDirectory });
  try {
    assert.equal(service.memoryNotice.kind, "mismatch"); assert.equal((await service.listConversations()).length, 1);
    const backup = await service.resolveMemory("reset"); assert.equal(service.memoryNotice, null);
    assert.equal(await fs.readFile(`${backup}/previous-memory/.runtime/manifest.json`, "utf8"), broken);
    assert.equal((await service.personalMemory.inspect()).records.length, 0);
  } finally { await service.dispose(); }
});
await test("interrupted rollback is completed from its journal on the next open", async () => {
  const before = await fs.readFile(manifest(copied), "utf8"), copyFile = fs.copyFile;
  try {
    await assert.rejects(api.repairVaultMemory({ pluginDataRoot: plugin(copied), identity: copyIdentity, action: "reset", validate: async () => {
      fs.copyFile = async () => { throw new Error("fixture process stopped during rollback"); };
      throw new Error("fixture process stopped during validation");
    } }), /process stopped during rollback/u);
  } finally { fs.copyFile = copyFile; }
  await prepare(copied);
  assert.equal(await fs.readFile(manifest(copied), "utf8"), before);
  assert.equal(fs.nodes.has(`${plugin(copied)}/vault-identity-backups/active-change.json`), false);
});
await test("an old path with a replaced or unreadable identity is not treated as a copy", async () => {
  const source = "/fixture-vault/replaced-source", destination = "/fixture-vault/replaced-destination", state = "/replaced-device";
  await cloneTree(moved, source); await prepare(source, state); await cloneTree(source, destination);
  await writeJson(`${root(source)}/${api.VAULT_IDENTITY_FILE}`, { schemaVersion: 1, vaultId: api.newVaultId() });
  assert.equal((await prepare(destination, state)).copiedFrom, undefined);
  await fs.writeFile(`${root(destination)}/${api.VAULT_IDENTITY_FILE}`, "invalid identity fixture");
  const third = "/fixture-vault/replaced-third"; await cloneTree(moved, third);
  assert.equal((await prepare(third, state)).copiedFrom, undefined);
});
await test("copying does not legitimize an already corrupted checksummed envelope", async () => {
  assert.throws(() => api.rebindVaultDocument({ payloadDigest: "invalid", payload: { vaultId: oldId } }, oldId, "new", "/sessions"), /checksum/u);
});
console.log(`PASS ${count} vault identity scenarios (production modules, in-memory filesystem; no native Obsidian claim)`);
