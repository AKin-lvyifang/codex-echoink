import assert from "node:assert/strict";
import { mkdir, readFile, readdir, writeFile, rm, access } from "node:fs/promises";
import path from "node:path";
import { SessionManager, CURRENT_SESSION_VERSION, VERSION } from "@earendil-works/pi-coding-agent";
import { defaultAgentRegistry, normalizeAgentRegistry, removeAgentDefinition, setModuleOwner } from "../agents/registry";
import { AGENT_PRESETS } from "../agents/presets";
import { migrateLegacyAgentRegistry } from "../agents/migration";
import { AGENT_MODULE_IDS } from "../agents/types";
import { normalizeConversationTaskMetadata, taskMetadataProjectionIsCurrent, handoffConversationTask } from "../agents/task-metadata";
import { defaultTaskWorkspace, prefillNewTask } from "../agents/task-workspace";
import { AGENT_TEMPLATES } from "../harness/memory/agent-templates";
import { defaultAgentIdentityState } from "../harness/memory/agent-identity-model";
import { DEFAULT_SETTINGS, normalizeSettingsData, type StoredSession } from "../settings/settings";
import { EchoInkSettingsStore, settingsForDataSave } from "../plugin/settings-store";
import { FileConversationCatalog } from "../harness/pi-native/file-conversation-catalog";
import { FileProductRunStore } from "../harness/pi-native/file-product-run-store";
import { createPiLocalConversation } from "../harness/pi-native/pi-local-data-service";
import { createPiConversation, PiNativeConversationRuntime } from "../harness/pi-native/pi-native-conversation-runtime";
import { assertPiSessionPreAssistantDurable, openDurablePiSession } from "../harness/pi-native/pi-session-durability";
import { archiveSession, refreshPiConversationShells, restoreArchivedConversation } from "../ui/codex-view/session-controller";
import { ConversationAutoArchive } from "../plugin/conversation-auto-archive";
import { pluginDataDir } from "../plugin/plugin-data-paths";
import { FileConversationCatalog as LegacyFileConversationCatalog } from "legacy-catalog-v1";
import { openTestNoticeMessages } from "./obsidian-shim";

interface MetadataSyncHost {
  syncPiConversationTaskMetadata(): Promise<void>;
  setPiConversationTaskMetadata(id: string, metadata: unknown, expectedRevision: number | undefined, updatedAt?: number): Promise<unknown>;
  listPiConversations(statuses?: readonly string[]): Promise<readonly unknown[]>;
  setPiConversationStatus(id: string, status: string): Promise<unknown>;
}
type CreateMetadataSyncHost = (catalog: FileConversationCatalog, sessions: StoredSession[]) => MetadataSyncHost;

const API = { codingAgentVersion: VERSION, currentSessionVersion: CURRENT_SESSION_VERSION,
  open: (file: string, root: string, cwd: string) => SessionManager.open(file, root, cwd) };

export async function runAgentsStorageTests(root: string, createSyncHost: CreateMetadataSyncHost): Promise<void> {
  await hardeningRegressions(root, createSyncHost);
  if (process.env.ECHOINK_AGENTS_TEST_CASE === "hardening") return;
  await reviewRegressions(root, createSyncHost);
  await migrationCases(root);
  await storageRoundtrip(root);
  draftAndRegistryCases();
  console.log("Agents storage A1-A4: PASS (synthetic local data; no Provider or Obsidian)");
}

async function hardeningRegressions(root: string, createHost: CreateMetadataSyncHost): Promise<void> {
  const failures: string[] = [];
  const cases: Array<[string, () => Promise<void>]> = [
    ["raw Catalog backup/old reader", () => catalogBackupRoundtrip(root)],
    ["Catalog backup failure blocks writes", () => catalogBackupFailure(root)],
    ["missing/empty/already-upgraded Catalog", () => catalogBackupBoundaries(root)],
    ["migration IO failure and retry", () => migrationFailureRetry(root)],
    ["sync failure still saves settings", () => settingsSaveAfterSyncFailure(root)],
    ["sync failure still lists conversations", () => listAfterSyncFailure(root, createHost)],
    ["sync failure rejects real archive", () => archiveAfterSyncFailure(root, createHost)],
    ["assistant exclusions and Agent opt-ins persist", () => capabilityStorageRoundtrip(root)],
    ["prefill draft canonical key order", async () => draftCanonicalOrder()]
  ];
  for (const [name, run] of cases) {
    try { await run(); console.log(`P1 hardening ${name}: PASS`); }
    catch (error) { const message = `${name}: ${(error as Error).message}`; failures.push(message); console.log(`P1 hardening FAIL ${message}`); }
  }
  assert.equal(failures.length, 0, failures.join("\n"));
}

async function oldCatalogFixture(root: string, name: string): Promise<{ catalog: FileConversationCatalog; original: Buffer; backupPath: string }> {
  const options = { storageRootPath: path.join(root, name), vaultId: name };
  const legacy = new LegacyFileConversationCatalog(options);
  await legacy.initialize();
  await legacy.upsert({ conversationId: name, piSessionId: `pi-${name}`, vaultId: name, title: "旧任务", status: "active", defaultMemoryMode: "normal", createdAt: 1, updatedAt: 100 });
  const value = JSON.parse(await readFile(legacy.filePath, "utf8"));
  const original = Buffer.from(`${JSON.stringify(value, null, "\t").replaceAll("\n", "\r\n")}\r\n\t`);
  await writeFile(legacy.filePath, original);
  const catalog = new FileConversationCatalog(options);
  return { catalog, original, backupPath: catalog.filePath.replace(/\.json$/u, ".pre-agent-metadata-v1.json") };
}

async function catalogBackupRoundtrip(root: string): Promise<void> {
  for (const operation of ["rename", "status", "task", "draft"] as const) {
    const name = `backup-${operation}`;
    const { catalog, original, backupPath } = await oldCatalogFixture(root, name);
    if (operation === "rename") await catalog.rename(name, "改名", 101);
    else if (operation === "status") await catalog.status(name, "archived", 101);
    else if (operation === "task") await catalog.updateTaskMetadata(name, { agentId: "sol", businessKey: "real-task" }, undefined, 101);
    else await catalog.upsertDraft({ draftId: "draft-1", conversationId: name, piSessionId: `pi-${name}`, source: "restart", text: "待发送", createdAt: 101 });
    assert.deepEqual(await readFile(backupPath), original, "Backup must preserve the exact pre-migration bytes");
    const reader = new LegacyFileConversationCatalog({ storageRootPath: catalog.storageRootPath, vaultId: name });
    Object.defineProperty(reader, "filePath", { value: backupPath });
    assert.equal((await reader.list())[0].title, "旧任务", "Actual a1bdd5cb strict Catalog must read the backup");
    const markedBackup = Buffer.concat([original, Buffer.from("\n\t")]);
    await writeFile(backupPath, markedBackup);
    await catalog.rename(name, "再次改名", 102);
    assert.deepEqual(await readFile(backupPath), markedBackup, "A later write must not replace an existing backup");
    assert.equal(JSON.parse(await readFile(catalog.filePath, "utf8")).entries[0].agentId, "sol");
  }
}

async function catalogBackupFailure(root: string): Promise<void> {
  const { catalog, original, backupPath } = await oldCatalogFixture(root, "backup-failure");
  await mkdir(backupPath);
  await assert.rejects(catalog.rename("backup-failure", "不应写入", 101), /backup|备份/iu);
  assert.deepEqual(await readFile(catalog.filePath), original);
  assert.equal(Object.hasOwn(JSON.parse(original.toString("utf8")).entries[0], "agentId"), false);
  await rm(backupPath, { recursive: true });
  await catalog.rename("backup-failure", "修好后可重试", 102);
  assert.deepEqual(await readFile(backupPath), original);
}

async function catalogBackupBoundaries(root: string): Promise<void> {
  const absent = new FileConversationCatalog({ storageRootPath: path.join(root, "absent-catalog"), vaultId: "absent" });
  await absent.upsert({ conversationId: "absent", piSessionId: "pi-absent", vaultId: "absent", title: "新建", status: "active", defaultMemoryMode: "normal", createdAt: 1, updatedAt: 1 });
  const backupPath = absent.filePath.replace(/\.json$/u, ".pre-agent-metadata-v1.json");
  await assert.rejects(access(backupPath), { code: "ENOENT" }, "A missing original cannot become a fabricated backup");
  await absent.rename("absent", "已升级", 2);
  await assert.rejects(access(backupPath), { code: "ENOENT" }, "An already-upgraded Catalog cannot become an old-version backup");
  const empty = new FileConversationCatalog({ storageRootPath: path.join(root, "empty-catalog"), vaultId: "empty" });
  await empty.initialize();
  const original = await readFile(empty.filePath);
  const emptyBackup = empty.filePath.replace(/\.json$/u, ".pre-agent-metadata-v1.json");
  await assert.rejects(access(emptyBackup), { code: "ENOENT" });
  await empty.upsert({ conversationId: "first", piSessionId: "pi-first", vaultId: "empty", title: "第一条", status: "active", defaultMemoryMode: "normal", createdAt: 1, updatedAt: 1 });
  assert.deepEqual(await readFile(emptyBackup), original, "An existing empty Catalog can only be backed up as its actual empty bytes");
}

async function migrationFailureRetry(root: string): Promise<void> {
  const vaultRoot = path.join(root, "unreadable-identity");
  const memoryRoot = path.join(pluginDataDir(vaultRoot, "codex-echoink"), "pi-agent-product-v1", ".echoink");
  const metadataPath = path.join(memoryRoot, "agents/echoink/agent-self-meta.json");
  await legacyFile(memoryRoot, "agent-identity.json", { ...defaultAgentIdentityState(), displayName: "恢复后身份", avatar: { kind: "preset", presetId: "aya" } });
  await mkdir(metadataPath);
  let persisted: unknown = { ...structuredClone(DEFAULT_SETTINGS), agentRegistry: undefined };
  const plugin = { settings: structuredClone(DEFAULT_SETTINGS), getVaultPath: () => vaultRoot, getPluginDataDirName: () => "codex-echoink",
    loadData: async () => structuredClone(persisted), saveData: async (value: unknown) => { persisted = structuredClone(value); } };
  const store = new EchoInkSettingsStore(plugin as any);
  const before = await snapshot(memoryRoot);
  const notices = openTestNoticeMessages.length;
  await store.loadSettings();
  assert.equal(plugin.settings.agentRegistry.agents[0].name, "总助");
  assert.equal(plugin.settings.agentRegistry.legacyMigrationVersion, 0);
  assert.equal(openTestNoticeMessages.length, notices, "Optional migration failure must not display a Notice");
  assert.deepEqual(await snapshot(memoryRoot), before);
  await rm(metadataPath, { recursive: true });
  await legacyFile(memoryRoot, "agent-self-meta.json", { schema: "echoink.agent-self-meta.v1", templateId: "creative" });
  const repairedBefore = await snapshot(memoryRoot);
  await store.loadSettings();
  assert.equal(plugin.settings.agentRegistry.agents[0].name, "恢复后身份");
  assert.equal(plugin.settings.agentRegistry.agents[0].styleId, "creative");
  assert.equal(plugin.settings.agentRegistry.legacyMigrationVersion, 1);
  assert.deepEqual(await snapshot(memoryRoot), repairedBefore);
}

async function settingsSaveAfterSyncFailure(root: string): Promise<void> {
  const filePath = path.join(root, "settings-after-sync-failure.json");
  const settings = normalizeSettingsData(structuredClone(DEFAULT_SETTINGS)).settings;
  settings.agentRegistry.legacyMigrationVersion = 1;
  await writeFile(filePath, JSON.stringify(settings));
  settings.customWelcomeTitle = "本次设置必须保存";
  const plugin = { settings, getVaultPath: () => root, getPluginDataDirName: () => "codex-echoink",
    syncPiConversationTaskMetadata: async () => { throw new Error("injected-sync-failure"); },
    loadData: async () => JSON.parse(await readFile(filePath, "utf8")), saveData: async (value: unknown) => { await writeFile(filePath, JSON.stringify(value)); } };
  await new EchoInkSettingsStore(plugin as any).saveSettings(true);
  assert.equal(JSON.parse(await readFile(filePath, "utf8")).customWelcomeTitle, "本次设置必须保存");
}

async function listAfterSyncFailure(root: string, createHost: CreateMetadataSyncHost): Promise<void> {
  const { catalog, shell } = await metadataFixture(root, "list-sync-failure");
  const plugin = createHost(catalog, [shell]);
  plugin.syncPiConversationTaskMetadata = async () => { throw new Error("injected-sync-failure"); };
  const entries = await plugin.listPiConversations(["active"]);
  assert.deepEqual(entries.map((entry: any) => entry.conversationId), [shell.id]);
}

async function archiveAfterSyncFailure(root: string, createHost: CreateMetadataSyncHost): Promise<void> {
  const { catalog, shell } = await metadataFixture(root, "archive-sync-failure");
  const plugin: any = createHost(catalog, [shell]);
  plugin.settings.activeSessionId = shell.id;
  plugin.syncPiConversationTaskMetadata = async () => { throw new Error("injected-sync-failure"); };
  const host: any = { plugin, runningSessionIds: new Set() };
  await assert.rejects(archiveSession(host, shell.id), /injected-sync-failure/u);
  assert.equal(plugin.settings.sessions[0], shell);
  assert.equal((await catalog.get(shell.id))!.status, "active");
}

function draftCanonicalOrder(): void {
  for (const draft of [
    { prefillSource: "knowledge:inbox", attachments: [{ path: "Inbox/a.md", name: "a.md", type: "file" as const }], text: "整理这篇" },
    { attachments: [{ name: "a.md", type: "file" as const, path: "Inbox/a.md" }], text: "整理这篇", prefillSource: "knowledge:inbox" }
  ]) {
    const settings = normalizeSettingsData(structuredClone(DEFAULT_SETTINGS)).settings;
    settings.agentRegistry.legacyMigrationVersion = 1;
    settings.taskWorkspace = prefillNewTask(defaultTaskWorkspace(), "sol", draft).workspace;
    assert.equal(normalizeSettingsData(settingsForDataSave(settings)).changed, false, "Key order must already be canonical before saving the prefill");
  }
}

async function capabilityStorageRoundtrip(root: string): Promise<void> {
  const fresh = defaultAgentRegistry().agents[0];
  assert.deepEqual(fresh.disabledCapabilityIds, []);
  assert.equal(Object.hasOwn(fresh, "capabilityIds"), false, "The default assistant must not freeze a capability allowlist");
  const legacyAssistant = { ...fresh, capabilityIds: ["journal", "knowledge", "legacy-only-capability"] };
  delete legacyAssistant.disabledCapabilityIds;
  const colleague = { ...structuredClone(AGENT_PRESETS[0].agent), id: "user-colleague", capabilityIds: ["knowledge", "vault-skill:existing"] };
  const dataPath = path.join(root, "capability-settings-data.json");
  const settings = normalizeSettingsData(structuredClone(DEFAULT_SETTINGS)).settings;
  const legacyRegistry = { ...defaultAgentRegistry(), legacyMigrationVersion: 1, agents: [legacyAssistant, colleague] };
  await writeFile(dataPath, JSON.stringify({ ...settings, agentRegistry: legacyRegistry }));
  const plugin = { settings, getVaultPath: () => root, getPluginDataDirName: () => "codex-echoink",
    loadData: async () => JSON.parse(await readFile(dataPath, "utf8")), saveData: async (value: unknown) => { await writeFile(dataPath, JSON.stringify(value)); } };
  const store = new EchoInkSettingsStore(plugin as any);
  await store.loadSettings();
  const upgraded = plugin.settings.agentRegistry.agents[0];
  assert.deepEqual(upgraded.disabledCapabilityIds, [], "Old assistant allowlists become unrestricted at Agent scope");
  assert.equal(Object.hasOwn(upgraded, "capabilityIds"), false);
  upgraded.disabledCapabilityIds = ["mcp:disabled-server", " vault-skill:disabled ", "mcp:disabled-server", ""];
  await store.saveSettings(true);
  await store.loadSettings();
  const restored = plugin.settings.agentRegistry;
  assert.deepEqual(restored.agents[0].disabledCapabilityIds, ["mcp:disabled-server", "vault-skill:disabled"]);
  assert.deepEqual(restored.agents[1].capabilityIds, colleague.capabilityIds);
  assert.equal(restored.agents[1].capabilityIds!.includes("mcp:future-server"), false);
  assert.equal(Object.hasOwn(restored.agents[1], "disabledCapabilityIds"), false);
}

async function reviewRegressions(root: string, createHost: CreateMetadataSyncHost): Promise<void> {
  const failures: string[] = [];
  const cases: Array<[string, () => Promise<void>]> = [
    ["production identity root", () => productionMigrationRoot(root)],
    ["concurrent metadata sync", () => concurrentMetadataSync(root, createHost)],
    ["metadata preserves inactivity/archive", () => metadataPreservesInactivity(root, createHost)],
    ["unread edits during awaited write", () => unreadEditsDuringWrite(root, createHost)]
  ];
  for (const [name, run] of cases) {
    try { await run(); console.log(`P1 review regression ${name}: PASS`); }
    catch (error) { const message = `${name}: ${(error as Error).message}`; failures.push(message); console.log(`P1 review regression FAIL ${message}`); }
  }
  assert.equal(failures.length, 0, failures.join("\n"));
}

async function productionMigrationRoot(root: string): Promise<void> {
  for (const pluginDirectory of ["custom-echoink", ".custom-config/plugins/custom-echoink"]) {
    const vaultRoot = path.join(root, "production-migration", pluginDirectory.includes("/") ? "nested-config" : "plugin-name");
    const activeRoot = path.join(pluginDataDir(vaultRoot, pluginDirectory), "pi-agent-product-v1", ".echoink");
    await legacyFile(activeRoot, "agent-self-meta.json", { schema: "echoink.agent-self-meta.v1", templateId: "creative" });
    await legacyFile(activeRoot, "agent-identity.json", { ...defaultAgentIdentityState(), revision: 2, displayName: "正式身份", avatar: { kind: "preset", presetId: "lin" } });
    await legacyFile(path.join(vaultRoot, ".echoink"), "agent-self-meta.json", { schema: "echoink.agent-self-meta.v1", templateId: "steward" });
    await legacyFile(path.join(vaultRoot, ".echoink"), "agent-identity.json", { ...defaultAgentIdentityState(), revision: 1, displayName: "陈旧身份", avatar: { kind: "preset", presetId: "rio" } });
    const before = await snapshot(vaultRoot);
    let persisted: unknown = { ...structuredClone(DEFAULT_SETTINGS), agentRegistry: undefined };
    const plugin = { settings: structuredClone(DEFAULT_SETTINGS), getVaultPath: () => vaultRoot, getPluginDataDirName: () => pluginDirectory,
      loadData: async () => structuredClone(persisted), saveData: async (value: unknown) => { persisted = structuredClone(value); } };
    await new EchoInkSettingsStore(plugin as any).loadSettings();
    assert.equal(plugin.settings.agentRegistry.agents[0].name, "正式身份");
    assert.equal(plugin.settings.agentRegistry.agents[0].styleId, "creative");
    assert.deepEqual(plugin.settings.agentRegistry.agents[0].avatar, { kind: "preset", presetId: "lin" });
    assert.deepEqual(await snapshot(vaultRoot), before, "Neither the active root nor the stale root can be rewritten");
  }
}

async function metadataFixture(root: string, name: string): Promise<{ catalog: FileConversationCatalog; shell: StoredSession }> {
  const catalog = new FileConversationCatalog({ storageRootPath: path.join(root, name), vaultId: name });
  await catalog.initialize();
  const entry = await catalog.upsert({ conversationId: name, piSessionId: `pi-${name}`, vaultId: name, title: name, status: "active", defaultMemoryMode: "normal", createdAt: 1, updatedAt: 100 });
  return { catalog, shell: { id: name, title: name, piSessionId: entry.piSessionId, cwd: root, messages: [], createdAt: 1, updatedAt: 100 } };
}

async function concurrentMetadataSync(root: string, createHost: CreateMetadataSyncHost): Promise<void> {
  const { catalog, shell } = await metadataFixture(root, "concurrent-sync");
  let snapshotEntries = await catalog.list();
  const actualList = catalog.list.bind(catalog);
  const actualUpdate = catalog.updateTaskMetadata.bind(catalog);
  // Hold the first real file write. Both unsynchronized readers then see the same snapshot.
  const started = deferred(); const release = deferred();
  let writes = 0;
  catalog.list = async () => structuredClone(snapshotEntries);
  catalog.updateTaskMetadata = async (...args) => {
    if (++writes === 1) { started.resolve(); await release.promise; }
    const result = await actualUpdate(...args);
    snapshotEntries = await actualList();
    return result;
  };
  const host = createHost(catalog, [shell]);
  const first = host.syncPiConversationTaskMetadata();
  await started.promise;
  const second = host.syncPiConversationTaskMetadata();
  await Promise.resolve(); await Promise.resolve();
  release.resolve();
  const results = await Promise.allSettled([first, second]);
  assert.equal(results.filter(result => result.status === "rejected").length, 0, "List/save synchronization must not conflict with itself");
  assert.equal(writes, 1, "The second sync must read the first committed revision");
  assert.equal((await catalog.get(shell.id))!.agentId, "sol");
}

async function metadataPreservesInactivity(root: string, createHost: CreateMetadataSyncHost): Promise<void> {
  const { catalog, shell } = await metadataFixture(root, "inactivity-sync");
  const host = createHost(catalog, [shell]);
  await host.syncPiConversationTaskMetadata();
  assert.equal((await catalog.get(shell.id))!.updatedAt, 100, "Opening a historical task must not create real activity");
  shell.unreadAnswerAt = 123;
  await host.syncPiConversationTaskMetadata();
  assert.equal((await catalog.get(shell.id))!.updatedAt, 100, "Read/unread persistence must not reset the idle clock");
  const archived: string[] = [];
  const autoArchive = new ConversationAutoArchive({
    days: () => 7, list: () => catalog.list(),
    activity: async id => ({ updatedAt: (await catalog.get(id))!.updatedAt, hasDrafts: false }),
    isProtected: () => false, archive: async id => { archived.push(id); await catalog.status(id, "archived", 900_000_000); },
    changed: async () => undefined, onError: () => { throw new Error("auto_archive_failed"); }
  }, () => 900_000_000);
  await autoArchive.scan();
  await autoArchive.dispose();
  assert.deepEqual(archived, [shell.id], "An idle historical conversation must still be archived after metadata import/read changes");
}

async function unreadEditsDuringWrite(root: string, createHost: CreateMetadataSyncHost): Promise<void> {
  const failures: string[] = [];
  for (const operation of ["new-answer", "mark-read"] as const) {
    const { catalog, shell } = await metadataFixture(root, operation);
    const host = createHost(catalog, [shell]);
    shell.unreadAnswerAt = 123;
    await host.syncPiConversationTaskMetadata();
    shell.taskStage = "开始保存这一步";
    const actualUpdate = catalog.updateTaskMetadata.bind(catalog);
    const started = deferred(); const release = deferred();
    let first = true;
    catalog.updateTaskMetadata = async (...args) => {
      if (first) { first = false; started.resolve(); await release.promise; }
      return await actualUpdate(...args);
    };
    const saving = host.syncPiConversationTaskMetadata();
    await started.promise;
    if (operation === "new-answer") shell.unreadAnswerAt = 456;
    else delete shell.unreadAnswerAt;
    release.resolve();
    await saving;
    const expected = operation === "new-answer" ? 456 : undefined;
    if (shell.unreadAnswerAt !== expected) failures.push(`${operation} overwritten with ${String(shell.unreadAnswerAt)}`);
    // A list refresh immediately after the IO must not apply the older saved
    // values over edits retained on the same Catalog revision.
    const projectionHost: any = {
      plugin: { settings: { sessions: [shell], activeSessionId: shell.id }, getVaultPath: () => root,
        listPiConversations: () => catalog.list(), saveSettings: async () => undefined },
      runningSessionIds: new Set()
    };
    await refreshPiConversationShells(projectionHost);
    if (shell.unreadAnswerAt !== expected) failures.push(`${operation} overwritten by immediate list refresh`);
    await host.syncPiConversationTaskMetadata();
    if ((await catalog.get(shell.id))!.unreadAnswerAt !== expected) failures.push(`${operation} was not saved by the next sync`);
  }
  assert.deepEqual(failures, [], "New unread edits and mark-read deletions during file IO must survive the writeback");
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  return { promise: new Promise<void>(done => { resolve = done; }), resolve: () => resolve() };
}

async function migrationCases(root: string): Promise<void> {
  const mapping = { executor: "execution", pragmatist: "execution", advisor: "analysis", butler: "analysis", companion: "companion", steward: "companion", creative: "creative", enthusiast: "creative" };
  for (const [templateId, styleId] of Object.entries(mapping)) {
    const storage = path.join(root, `migration-${templateId}`, ".echoink");
    await legacyFile(storage, "agent-self-meta.json", { schema: "echoink.agent-self-meta.v1", templateId });
    await legacyFile(storage, "agent-identity.json", { ...defaultAgentIdentityState(), revision: 3, displayName: "自定义助手", avatar: { kind: "preset", presetId: "aya" } });
    const before = await snapshot(storage);
    const migrated = await migrateLegacyAgentRegistry(defaultAgentRegistry(), storage);
    assert.equal(migrated.agents.length, 1);
    assert.equal(migrated.agents[0].id, "sol");
    assert.equal(migrated.agents[0].styleId, styleId);
    assert.equal(migrated.agents[0].name, "自定义助手");
    assert.deepEqual(migrated.agents[0].avatar, { kind: "preset", presetId: "aya" });
    assert.deepEqual(await snapshot(storage), before, "Migration is read-only for every legacy file");
    migrated.agents[0].name = "用户后来改的名字";
    migrated.agents[0].styleId = "creative";
    assert.equal(await migrateLegacyAgentRegistry(migrated, path.join(storage, "does-not-exist")), migrated);
    assert.equal(normalizeAgentRegistry(migrated).agents[0].name, "用户后来改的名字");
  }
  for (const templateId of [null, "", "future-template"]) {
    const storage = path.join(root, `default-${String(templateId)}`, ".echoink");
    await legacyFile(storage, "agent-self-meta.json", { schema: "echoink.agent-self-meta.v1", templateId });
    await legacyFile(storage, "agent-identity.json", defaultAgentIdentityState());
    const before = await snapshot(storage);
    const result = await migrateLegacyAgentRegistry(defaultAgentRegistry(), storage);
    assert.equal(result.agents[0].name, "总助");
    assert.deepEqual(result.agents[0].avatar, { kind: "preset", presetId: "sol" });
    assert.equal(result.agents[0].styleId, "execution");
    assert.deepEqual(await snapshot(storage), before);
  }
  for (const schema of ["echoink.personality.v1", "echoink.personality.v2"]) {
    const storage = path.join(root, schema, ".echoink");
    await legacyFile(storage, "personality-state.json", { schema, templateId: "steward", revision: 2, learnedRequirements: [] });
    assert.equal((await migrateLegacyAgentRegistry(defaultAgentRegistry(), storage)).agents[0].styleId, "companion");
    await legacyFile(storage, "agent-self-meta.json", "{broken JSON", true);
    const before = await snapshot(storage);
    assert.equal((await migrateLegacyAgentRegistry(defaultAgentRegistry(), storage)).agents[0].styleId, "execution", "Damaged current metadata must not resurrect retired personality data");
    assert.deepEqual(await snapshot(storage), before);
  }
  const markdownRoot = path.join(root, "markdown-only", ".echoink");
  await legacyFile(markdownRoot, "AGENT.md", legacyMarkdown("advisor"), true);
  const markdownBefore = await snapshot(markdownRoot);
  const markdownAgent = (await migrateLegacyAgentRegistry(defaultAgentRegistry(), markdownRoot)).agents[0];
  assert.equal(markdownAgent.styleId, "analysis");
  assert.equal(markdownAgent.name, "总助", "Markdown identity text is never used as a custom name");
  assert.deepEqual(await snapshot(markdownRoot), markdownBefore);
  const empty = await migrateLegacyAgentRegistry(defaultAgentRegistry(), path.join(root, "new-install", ".echoink"));
  assert.equal(empty.agents.length, 1);
  assert.equal(empty.agents[0].name, "总助");

  // Exercise the real settings load/save entry, including its once-only marker.
  const vaultRoot = path.join(root, "settings-startup");
  await mkdir(vaultRoot, { recursive: true });
  const activeMemoryRoot = path.join(pluginDataDir(vaultRoot, "codex-echoink"), "pi-agent-product-v1", ".echoink");
  await legacyFile(activeMemoryRoot, "agent-self-meta.json", { schema: "echoink.agent-self-meta.v1", templateId: "creative" });
  let persisted: unknown = { ...structuredClone(DEFAULT_SETTINGS), agentRegistry: undefined };
  const plugin = { settings: structuredClone(DEFAULT_SETTINGS), getVaultPath: () => vaultRoot, getPluginDataDirName: () => "codex-echoink",
    loadData: async () => structuredClone(persisted), saveData: async (value: unknown) => { persisted = structuredClone(value); } };
  const store = new EchoInkSettingsStore(plugin as any);
  await store.loadSettings();
  assert.equal(plugin.settings.agentRegistry.agents[0].styleId, "creative");
  plugin.settings.agentRegistry.agents[0].name = "已编辑总助";
  await store.saveSettings(true);
  await legacyFile(activeMemoryRoot, "agent-self-meta.json", { schema: "echoink.agent-self-meta.v1", templateId: "executor" });
  await store.loadSettings();
  assert.equal(plugin.settings.agentRegistry.agents[0].name, "已编辑总助");
  assert.equal(plugin.settings.agentRegistry.agents[0].styleId, "creative");
}

async function storageRoundtrip(root: string): Promise<void> {
  const options = { storageRootPath: path.join(root, "catalog"), vaultId: "p1-fixture", now: () => 100 };
  const catalog = new FileConversationCatalog(options);
  await catalog.initialize();
  const metadata = { agentId: "nova-user", businessKey: "knowledge:inbox:2026-10-16", taskStatus: "waiting" as const, taskStage: "核对整理范围", taskStartedAt: 20, taskCompletedAt: 40, taskInterruptedAt: 60,
    pendingResponse: { kind: "confirmation" as const, questionId: "question-1", runId: "run-1" }, unreadAnswerAt: 80, lastReadAt: 50 };
  const input = { conversationId: "task-1", title: "整理资料", cwd: root, createdAt: 100, ...metadata };
  const entry = await createPiLocalConversation({ catalog, sessionApi: API }, input);
  assert.equal(entry.conversationId, "task-1");
  assert.equal("taskId" in entry, false, "taskId is Conversation identity, never a second stored ID");
  const second = await createPiConversation({ catalog, sessionApi: API, conversation: { ...input, conversationId: "task-2", createdAt: 101 } });
  assert.deepEqual(normalizeConversationTaskMetadata(second), { ...metadata, taskMetadataUpdatedAt: 101 });
  const opened = openDurablePiSession({ api: API, sessionRoot: catalog.sessionRootPath, sessionFile: entry.sessionFile!, cwd: root });
  const userEntryId = opened.sessionManager.appendMessage({ role: "user", content: "保留这条旧消息", timestamp: 110 });
  assertPiSessionPreAssistantDurable({ sessionRoot: catalog.sessionRootPath, sessionManager: opened.sessionManager, expectedEntryIds: [userEntryId] });
  const sessionBefore = await readFile(entry.sessionFile!, "utf8");
  const runs = new FileProductRunStore({ ...options, catalog });
  await runs.initialize();
  await runs.create({ productRunId: "run-1", conversationId: entry.conversationId, piSessionId: entry.piSessionId, userEntryId, toolCallIds: [], memoryMode: "normal", state: "product_run_settled", terminalState: "completed", activeLeafId: userEntryId, createdAt: 110, updatedAt: 120, agentSettledAt: 119, settledAt: 120 });
  const runBefore = await runs.read("run-1");
  const shell: StoredSession = { id: entry.conversationId, title: entry.title, piSessionId: entry.piSessionId, ...normalizeConversationTaskMetadata(entry), cwd: root, messages: [{ id: "old-ui", role: "user", text: "旧显示消息", createdAt: 110 }], bodyAuthority: "pi_session_only", createdAt: 100, updatedAt: 100 };
  const settings = normalizeSettingsData({ ...structuredClone(DEFAULT_SETTINGS), sessions: [shell], activeSessionId: shell.id }).settings;
  const saved = settingsForDataSave(settings);
  assert.deepEqual(saved.sessions[0].messages, [], "Messages remain owned by Pi JSONL");
  assert.deepEqual(normalizeConversationTaskMetadata(normalizeSettingsData(saved).settings.sessions[0]), normalizeConversationTaskMetadata(entry));
  const localCatalog = new FileConversationCatalog(options);
  assert.deepEqual(await localCatalog.get(entry.conversationId), entry, "Catalog reload keeps every task field");
  assert.equal((await localCatalog.list({ agentId: "nova-user" })).length, 2);
  assert.equal((await localCatalog.list({ agentId: "sol" })).length, 0);
  const clone = (await catalog.get("task-1"))!;
  clone.pendingResponse!.questionId = "mutated-local-copy";
  assert.equal((await catalog.get("task-1"))!.pendingResponse!.questionId, "question-1");

  const plugin = {
    settings, getVaultPath: () => root, listPiConversations: (statuses: any) => catalog.list({ statuses }),
    setPiConversationStatus: (id: string, status: any) => catalog.status(id, status, 150), saveSettings: async () => undefined
  };
  const host: any = { plugin, runningSessionIds: new Set(), turnQueue: { clearSessionQueue() {} }, resetVirtualWindow() {}, renderTabs() {}, renderMessages() {}, renderToolbar() {}, updateInputPlaceholder() {} };
  const otherShell = { ...structuredClone(shell), id: second.conversationId, piSessionId: second.piSessionId, ...normalizeConversationTaskMetadata(second) };
  settings.sessions.push(otherShell);
  settings.activeSessionId = otherShell.id;
  await archiveSession(host, shell.id);
  assert.equal(settings.sessions.some(value => value.id === shell.id), false);
  const archived = (await catalog.get(shell.id))!;
  assert.deepEqual(normalizeConversationTaskMetadata(archived), normalizeConversationTaskMetadata(entry));
  await restoreArchivedConversation(host, archived);
  assert.deepEqual(normalizeConversationTaskMetadata(settings.sessions.find(value => value.id === shell.id)), normalizeConversationTaskMetadata(entry));
  await refreshPiConversationShells(host);
  assert.deepEqual(normalizeConversationTaskMetadata(settings.sessions.find(value => value.id === shell.id)), normalizeConversationTaskMetadata(entry));

  const runtime = new PiNativeConversationRuntime({ catalog, productRuns: runs, sessionApi: API, now: () => 200 } as any);
  await runtime.initialize();
  const continued = await runtime.setConversationTaskMetadata(shell.id, { ...metadata, taskStatus: "running", taskStartedAt: 200, pendingResponse: undefined, taskCompletedAt: undefined, unreadAnswerAt: undefined, lastReadAt: 200 }, entry.taskMetadataUpdatedAt, 200);
  assert.equal(continued.taskStatus, "running");
  assert.equal(continued.taskCompletedAt, undefined);
  assert.equal(continued.piSessionId, entry.piSessionId);
  assert.equal(taskMetadataProjectionIsCurrent(shell, continued), false);
  await assert.rejects(catalog.updateTaskMetadata(shell.id, metadata, entry.taskMetadataUpdatedAt, 210), /metadata changed/);
  const afterConflict = (await catalog.get(shell.id))!;
  assert.deepEqual(afterConflict, continued, "A stale shell cannot overwrite newer metadata");
  await catalog.rename(shell.id, "新的任务标题", 220);
  assert.equal((await catalog.get(shell.id))!.title, "新的任务标题");
  assert.deepEqual(await runs.read("run-1"), runBefore, "Continuation never rewrites historical run finish times");
  assert.equal(await readFile(entry.sessionFile!, "utf8"), sessionBefore, "Catalog operations never rewrite Pi history");

  const oldEntry = await catalog.upsert({ conversationId: "old-task", piSessionId: "old-pi", vaultId: options.vaultId, title: "历史任务", status: "active", defaultMemoryMode: "normal", createdAt: 1, updatedAt: 1 });
  assert.equal(oldEntry.agentId, "sol");
  assert.equal(oldEntry.taskStatus, undefined, "Old run outcomes are not guessed during data migration");
  assert.equal(oldEntry.taskMetadataUpdatedAt, undefined);
  const imported = await catalog.updateTaskMetadata(oldEntry.conversationId, { agentId: "sol", businessKey: "old-business", taskStatus: "interrupted" }, undefined, 230);
  assert.equal(imported.businessKey, "old-business");
  assert.equal(taskMetadataProjectionIsCurrent(oldEntry, imported), false);
}

function draftAndRegistryCases(): void {
  const registry = defaultAgentRegistry();
  assert.equal(registry.agents.length, 1);
  assert.equal(AGENT_PRESETS.length, 5);
  assert.ok(AGENT_MODULE_IDS.every(id => registry.moduleOwners[id] === "sol"));
  assert.throws(() => removeAgentDefinition(registry, "sol"), /cannot_be_deleted/);
  const agent = { ...structuredClone(AGENT_PRESETS[0].agent), id: "my-organizer" };
  const withAgent = normalizeAgentRegistry({ ...registry, agents: [...registry.agents, agent] });
  const assigned = setModuleOwner(withAgent, "knowledge-base", agent.id);
  assert.equal(assigned.moduleOwners["knowledge-base"], agent.id);
  assert.equal(registry.moduleOwners["knowledge-base"], "sol");
  const removed = removeAgentDefinition(assigned, agent.id);
  assert.equal(removed.agents.length, 1);
  assert.equal(removed.moduleOwners["knowledge-base"], "sol");
  const task = { id: "same-task", piSessionId: "same-session", agentId: agent.id, businessKey: "same-business" };
  assert.deepEqual(handoffConversationTask(task, agent.id), { ...task, agentId: "sol" });
  assert.equal(normalizeAgentRegistry({ ...registry, moduleOwners: { finance: "missing-agent" } }).moduleOwners.finance, "sol");
  const workspace = defaultTaskWorkspace();
  const draft = { text: "整理我的资料", attachments: [{ type: "file" as const, name: "note.md", path: "Inbox/note.md" }], prefillSource: "knowledge:inbox" };
  const first = prefillNewTask(workspace, agent.id, draft);
  assert.equal(first.accepted, true);
  assert.deepEqual(first.workspace.page, { kind: "list", agentId: agent.id });
  first.workspace.replyDrafts["same-task"] = { text: "只继续这件事", attachments: [] };
  const conflict = prefillNewTask(first.workspace, agent.id, { text: "另一条预填", attachments: [] });
  assert.equal(conflict.accepted, false);
  assert.deepEqual(conflict.workspace.newTaskDrafts[agent.id], draft);
  const state = normalizeSettingsData({ ...structuredClone(DEFAULT_SETTINGS), taskWorkspace: { ...conflict.workspace, page: { kind: "detail", taskId: "same-task" } } }).settings;
  const reloaded = normalizeSettingsData(settingsForDataSave(state)).settings;
  assert.deepEqual(reloaded.taskWorkspace, state.taskWorkspace);
  assert.equal(reloaded.sessions.length, 0, "Prefill, page changes, draft attachments and reload create no task");
  assert.equal(reloaded.taskWorkspace.replyDrafts["same-task"].text, "只继续这件事");
}

async function legacyFile(root: string, name: string, value: unknown, raw = false): Promise<void> {
  const directory = path.join(root, "agents/echoink");
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, name), raw ? value as string : JSON.stringify(value), "utf8");
}
async function snapshot(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const name of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (name.isFile()) {
      const filePath = path.join(name.parentPath, name.name);
      result[path.relative(root, filePath)] = await readFile(filePath, "utf8");
    }
  }
  return result;
}
function legacyMarkdown(id: string): string {
  const label = AGENT_TEMPLATES.find(value => value.id === id)!.labelZh;
  return ["# EchoInk Agent", "", `> 初始模板：${label}。人格由 EchoInk 依据模板与有效长期 Memory 自动生成，不由用户直接编辑。`, "", "## 当前人格", "", "- 节奏：快", "", "## 表达方式", "", "- 语言自然、具体、克制。", "- 详略服从当前任务，不固定成长短模板。", "- 二级事实（llm-inferred-reference）只能作为系统推理参考，不得表述为用户亲口确认。", ""].join("\n");
}
