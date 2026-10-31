import { KNOWLEDGE_ROOT_NAMES, resolveKnowledgePath } from "../knowledge-base/root-paths";
import assert from "node:assert/strict";
import { mkdtemp, realpath, readFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import { TFile, TFolder, type App } from "obsidian";
import { nativeJournalFixture } from "./native-journal-fixture";
import { EchoInkKnowledgeSurfaceService } from "../plugin/knowledge-surface-service";
import { readNativeJournalContext, readNativeJournalSettings, rebaseNativeJournalPaths, QUICK_JOURNAL_TEMPLATE } from "../home/native-journal";
import { HomeWorkbenchDataService, defaultJournalTemplateChoice } from "../home/home-workbench-data";
import { createObsidianNativePort } from "../plugin/obsidian-native-tools";
import { ObsidianVaultDomainAdapter } from "../plugin/obsidian-vault-domain-adapter";
import { VaultDomainService } from "../harness/pi-native/vault-domain-service";
import { createPiObsidianToolDefinitions, PiObsidianToolSecurity, PI_OBSIDIAN_TOOL_IDS } from "../harness/pi-native/pi-obsidian-tools";
import { createPiVaultToolSecurityAdapter, createSecurePiVaultToolResultCorrectionPort } from "../harness/pi-native/pi-vault-tool-security-extension";
import { EchoInkVaultToolEgressPolicy } from "../harness/pi-native/vault-tool-result-safety";
import { piWorkspaceAllowsTool, type PiWorkspaceAccess } from "../harness/pi-native/pi-workspace-access";
import { createPiVaultToolDefinitions } from "../harness/pi-native/pi-vault-tool-contracts";
import { FileApprovalTicketStore } from "../harness/pi-native/tool-authorization";
import { FileDomainReceiptStore } from "../harness/pi-native/domain-receipt-store";
import { createPiVaultProductionAuthorizationPort, createPiVaultProductionWriteExecutionPort } from "../plugin/pi-vault-tool-production";
import { officialCliFixture, runOfficialCliTests } from "./obsidian-cli";
import { emptyKnowledgeFolderBindings } from "../knowledge-base/folder-bindings";
import { rebaseFolderSettingsPaths } from "../knowledge-base/folder-settings-paths";
import { EnglishDiaryController } from "../english-diary/controller";
import { DEFAULT_ENGLISH_DIARY_SETTINGS } from "../english-diary/types";

function assertEnglishStorageRenameRefresh(): void {
  const english = "库/输出/英文日记", expressions = `${english}/表达库`;
  const scenarios = [
    { from: english, to: "库/输出/英语", english: "库/输出/英语", expressions: "库/输出/英语/表达库", englishMode: "custom", expressionMode: "custom" },
    { from: expressions, to: "库/输出/Expressions", english, expressions: "库/输出/Expressions", englishMode: "role", expressionMode: "custom" },
    { from: "库", to: "归档/资料", english: "归档/资料/输出/英文日记", expressions: "归档/资料/输出/英文日记/表达库", englishMode: "custom", expressionMode: "custom" }
  ];
  for (const enabled of [true, false]) for (const scenario of scenarios) {
    const folderBindings = emptyKnowledgeFolderBindings();
    Object.assign(folderBindings.roles.outputs, { enabled: true, readPaths: ["库/输出"], writePath: "库/输出" });
    const plugin = {
      manifest: { id: "folder-rename-fixture" },
      settings: { knowledgeBase: { folderBindings }, englishDiary: { ...structuredClone(DEFAULT_ENGLISH_DIARY_SETTINGS),
        enabled, englishDirectory: english, expressionDirectory: expressions, englishDirectoryMode: "role" as const, expressionDirectoryMode: "role" as const } },
      app: { vault: { configDir: ".obsidian", getRoot: () => ({ children: ["库", "归档"].map(directory => Object.assign(new TFolder(), { path: directory })) }) } }
    };
    const controller = new EnglishDiaryController(plugin as unknown as ConstructorParameters<typeof EnglishDiaryController>[0]);
    Object.assign(plugin.settings, rebaseFolderSettingsPaths(plugin.settings, { type: "rename", kind: "folder", from: scenario.from, to: scenario.to }));
    controller.refreshStoragePaths();
    const settings = plugin.settings.englishDiary;
    assert.equal(settings.englishDirectory, scenario.english, `controller refresh retains the renamed diary directory (enabled=${enabled})`);
    assert.equal(settings.expressionDirectory, scenario.expressions, `controller refresh retains the renamed expression directory (enabled=${enabled})`);
    assert.equal(settings.englishDirectoryMode, scenario.englishMode);
    assert.equal(settings.expressionDirectoryMode, scenario.expressionMode);
    assert.equal(settings.enabled, enabled);
    const repository = controller.api.repository as unknown as { options: { englishDirectory: string; expressionDirectory: string } };
    assert.equal(repository.options.englishDirectory, scenario.english);
    assert.equal(repository.options.expressionDirectory, scenario.expressions, "the actual repository also uses the renamed destination");
  }
}

export async function runNativeFolderRenameTests(): Promise<void> {
  assertEnglishStorageRenameRefresh();
  const saved: Record<string, Record<string, unknown>> = {
    "daily-notes": { folder: "库/日记", template: "库/模板/每日", format: "YYYY/MM/DD", userOption: { retained: true } },
    templates: { folder: "库/模板", dateFormat: "DD/MM/YYYY", timeFormat: "HH:mm:ss", userOption: "keep" }
  };
  let writes = 0, enables = 0, attachmentWrites = 0, attachmentFolder = "库/附件";
  const records = Object.fromEntries(Object.keys(saved).map(id => {
    const instance = {
      options: id === "daily-notes" ? { folder: "旧缓存/日记", format: "stale", staleOption: true } as Record<string, unknown> : {},
      async onExternalSettingsChange() { instance.options = structuredClone(saved[id]); }
    };
    const record = { enabled: false, instance,
      async enable() { enables++; throw new Error("path updates must never enable native plugins"); },
      async loadData() { return structuredClone(saved[id]); },
      async saveData(options: Record<string, unknown>) { saved[id] = structuredClone(options); writes++; }
    };
    return [id, record];
  }));
  const app = { internalPlugins: { plugins: records, getPluginById: (id: string) => records[id] }, vault: {
    getConfig: (key: string) => key === "attachmentFolderPath" ? attachmentFolder : undefined,
    setConfig: (key: string, value: string) => { assert.equal(key, "attachmentFolderPath"); attachmentFolder = value; attachmentWrites++; }
  } } as unknown as App;

  await rebaseNativeJournalPaths(app, "库", "笔记/知识");
  assert.deepEqual(saved["daily-notes"], { folder: "笔记/知识/日记", template: "笔记/知识/模板/每日", format: "YYYY/MM/DD", userOption: { retained: true } });
  assert.deepEqual(saved.templates, { folder: "笔记/知识/模板", dateFormat: "DD/MM/YYYY", timeFormat: "HH:mm:ss", userOption: "keep" });
  for (const [id, record] of Object.entries(records)) {
    assert.equal(record.enabled, false);
    assert.deepEqual(record.instance.options, saved[id], "native live options match the persisted settings after a rename");
  }
  assert.equal(enables, 0);
  assert.equal(writes, 2, "each disabled native plugin saves its affected settings once");
  assert.equal(attachmentFolder, "笔记/知识/附件");
  assert.equal(attachmentWrites, 1);

  records["daily-notes"].enabled = true;
  records["daily-notes"].instance.options = { ...saved["daily-notes"], folder: "笔记/知识/实时日记", liveOption: "keep too" };
  await rebaseNativeJournalPaths(app, "笔记/知识", "移动/知识");
  assert.equal(saved["daily-notes"].folder, "移动/知识/实时日记", "enabled plugins retain their current live choices");
  assert.deepEqual(saved["daily-notes"].userOption, { retained: true });
  assert.equal(saved["daily-notes"].liveOption, "keep too");
  assert.deepEqual(records["daily-notes"].instance.options, saved["daily-notes"]);

  const savedWrites = writes;
  for (const location of ["/", ".", "./", "./库/附件", "库-old/附件"]) {
    attachmentFolder = location;
    const before = attachmentWrites;
    await rebaseNativeJournalPaths(app, "库", "新库");
    assert.equal(attachmentFolder, location, "native special and note-relative attachment locations keep their meaning");
    assert.equal(attachmentWrites, before);
  }
  attachmentFolder = "库/附件";
  await rebaseNativeJournalPaths(app, "库", "新分组/新库");
  assert.equal(attachmentFolder, "新分组/新库/附件");
  attachmentFolder = "库";
  await rebaseNativeJournalPaths(app, "库", "新附件目录");
  assert.equal(attachmentFolder, "新附件目录", "an exact native attachment directory follows its rename");
  assert.equal(writes, savedWrites, "unaffected native settings are not rewritten");
  assert.equal(enables, 0);
  console.log("Native folder rename tests passed: disabled daily/templates, persisted and live options, attachment locations.");
}

export async function runNativeJournalTests(): Promise<void> {
  await runNativeFolderRenameTests();
  assertJournalRootSnapshots();
  await assertHomeJournalBuildSnapshots();
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "echoink-native-journal-")));
  try {
    const fixture = await nativeJournalFixture(root);
    const service = new EchoInkKnowledgeSurfaceService(fixture.plugin);
    await service.getInitializationState();
    assert.equal(fixture.enableCalls(), 0, "startup does not configure native plugins");
    await service.startInitialization("recommended");
    await service.confirmInitialization();
    // The terminal job status is visible before its last disk write/finally.
    for (let i = 0; i < 400 && ((await service.getInitializationState())?.status === "active" || service.isRunning); i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal((await service.getInitializationState())?.status, "initialized");
    assert.equal(service.isRunning, false, "initialization flight must finish before structure repair");
    assert.equal(fixture.providerCalls(), 0);
    assert.equal(fixture.enableCalls(), 2);
    assert.deepEqual(JSON.parse(await readFile(path.join(root, ".obsidian/core-plugins.json"), "utf8")), ["daily-notes", "templates"]);
    assert.equal(readNativeJournalSettings(fixture.app).format, "YYYY-MM/YYYY-MM-DD");
    assert.equal(await readFile(path.join(root, KNOWLEDGE_ROOT_NAMES.templates, "此刻速记.md"), "utf8"), QUICK_JOURNAL_TEMPLATE);
    const date = new Date(2026, 8, 6, 9, 8);
    const context = await readNativeJournalContext(fixture.app, { now: date });
    assert.equal(context.targetPath, `${KNOWLEDGE_ROOT_NAMES.journal}/2026-09/2026-09-06.md`);
    assert.equal(context.time, "09:08");
    assert.equal(parseYaml(context.templateContent.split("---")[1]!).date, "2026-09-06");
    assert.doesNotMatch(context.templateContent, /\{\{/u);

    // The retired ready panel used this same production recovery transaction.
    // Repeating it must preserve the existing native settings and plugin state.
    const savesBefore = fixture.settingsSaves();
    await service.restoreKnowledgeBaseStructure();
    assert.equal(fixture.settingsSaves(), savesBefore, "repeat repair does not rewrite native settings");
    assert.equal(fixture.enableCalls(), 2);

    const home = new HomeWorkbenchDataService(fixture.app);
    const legacy = await fixture.write(`${KNOWLEDGE_ROOT_NAMES.journal}/2026-09-05.md`, "legacy original");
    assert.equal(home.existingJournalForDate(new Date(2026, 8, 5))?.path, legacy.path);
    const created = await home.createOrOpenJournal(defaultJournalTemplateChoice(), date);
    assert.equal(created.file.path, context.targetPath);
    assert.equal(await readFile(path.join(root, context.targetPath), "utf8"), context.templateContent);
    const days = (await home.build(date)).journalDays;
    assert.equal(days.find((day) => day.date === "2026-09-05")?.path, legacy.path);
    assert.equal(days.find((day) => day.date === "2026-09-06")?.path, context.targetPath);

    await fixture.records.templates.saveData({ folder: "My templates", dateFormat: "DD/MM/YYYY", timeFormat: "HH:mm:ss" });
    await fixture.records.templates.instance.onExternalSettingsChange();
    await fixture.records["daily-notes"].saveData({ folder: "My journal", format: "YYYY/[month]MM/DD", template: "My templates/Personal" });
    await fixture.records["daily-notes"].instance.onExternalSettingsChange();
    const customized = '# {{title}}\n{{date:YYYY-MM-DD}} {{time:HH:mm}}\nUser template';
    await fixture.write("My templates/Personal.md", customized);
    await fixture.write("templates/此刻速记.md", "user edited quick template");
    await service.restoreKnowledgeBaseStructure();
    assert.equal(await readFile(path.join(root, "templates/此刻速记.md"), "utf8"), "user edited quick template");
    assert.equal(await readFile(path.join(root, "My templates/此刻速记.md"), "utf8"), QUICK_JOURNAL_TEMPLATE);
    assert.equal(await readFile(path.join(root, "My templates/Personal.md"), "utf8"), customized);
    const custom = await readNativeJournalContext(fixture.app, { now: date, legacyDirectory: "OLD-SESSION-DIRECTORY" });
    assert.equal(custom.targetPath, "My journal/2026/month09/06.md");
    assert.equal(custom.templateContent, "# 06\n2026-09-06 09:08\nUser template");
    assert.equal(home.journalPathForDate(date), custom.targetPath);
    assert.equal(JSON.parse(await readFile(path.join(root, ".obsidian/daily-notes.json"), "utf8")).format, "YYYY/[month]MM/DD");
    assert.equal(fixture.providerCalls(), 0);
    await assertNativeToolsAndManagedWrites(fixture, root);
    const cliRoot = path.join(root, "cli-fixture");
    await mkdir(cliRoot, { recursive: true });
    await runOfficialCliTests(cliRoot);
    console.log("PASS native initialization/ready repair, current journal settings, calendar/template parity, CLI and managed formats");
  } finally { await rm(root, { recursive: true, force: true }); }
}

function assertJournalRootSnapshots(): void {
  const daily = { folder: "journal", format: "YYYY-MM-DD", template: "templates/Explicit" };
  const templates = { folder: "templates" };
  let roots = ["journal", "templates", KNOWLEDGE_ROOT_NAMES.journal, KNOWLEDGE_ROOT_NAMES.templates];
  let allFileReads = 0;
  let rootReads = 0;
  const vault = {
    getAbstractFileByPath: (name: string) => roots.includes(name) ? Object.assign(new TFolder(), { path: name }) : null,
    getRoot: undefined as undefined | (() => { children: { path: string }[] }),
    getAllLoadedFiles: () => {
      allFileReads++;
      return roots.flatMap((root) => [{ path: root }, { path: `${root}/nested/example.md` }]);
    }
  };
  const app = {
    vault,
    internalPlugins: { plugins: {
      "daily-notes": { instance: { options: daily } },
      templates: { instance: { options: templates } }
    } }
  } as unknown as App;

  const legacy = readNativeJournalSettings(app);
  assert.equal(legacy.folder, "journal", "explicit existing English roots win when bilingual roots coexist");
  assert.equal(legacy.template, "templates/Explicit.md");
  assert.equal(allFileReads, 1, "hosts without getRoot enumerate loaded files once per settings read");

  vault.getRoot = () => {
    rootReads++;
    return { children: roots.map((root) => ({ path: root })) };
  };
  roots = [KNOWLEDGE_ROOT_NAMES.journal, KNOWLEDGE_ROOT_NAMES.templates];
  const bilingual = readNativeJournalSettings(app);
  assert.equal(bilingual.folder, KNOWLEDGE_ROOT_NAMES.journal);
  assert.equal(bilingual.template, `${KNOWLEDGE_ROOT_NAMES.templates}/Explicit.md`);
  assert.equal(rootReads, 1);
  assert.equal(allFileReads, 1, "native root children avoid full-Vault enumeration");

  roots.push("journal", "templates");
  assert.equal(readNativeJournalSettings(app).folder, "journal", "root changes take effect on the next read");
  daily.folder = KNOWLEDGE_ROOT_NAMES.journal;
  daily.format = "YYYY/[month]MM/DD";
  templates.folder = KNOWLEDGE_ROOT_NAMES.templates;
  const changed = readNativeJournalSettings(app);
  assert.equal(changed.folder, KNOWLEDGE_ROOT_NAMES.journal, "explicit bilingual roots also win when roots coexist");
  assert.equal(changed.templatesFolder, KNOWLEDGE_ROOT_NAMES.templates);
  assert.equal(changed.template, "templates/Explicit.md", "explicit template roots are preserved independently");
  assert.equal(changed.format, "YYYY/[month]MM/DD", "native settings changes are not hidden by a cache");
  assert.equal(rootReads, 3, "each settings read uses one fresh root snapshot");
  assert.equal(allFileReads, 1);
}

async function assertHomeJournalBuildSnapshots(): Promise<void> {
  const daily = { folder: "journal", format: "YYYY-MM-DD" };
  const makeFile = (filePath: string) => Object.assign(new TFile(filePath), {
    basename: path.posix.basename(filePath, ".md"),
    parent: { path: path.posix.dirname(filePath) },
    stat: { mtime: 1, ctime: 1 }
  });
  const journal = makeFile("journal/2026-09-06.md");
  const customJournal = makeFile("Custom daily/2026/month09/06.md");
  const template = makeFile("templates/journal/Personal.md");
  let files = [journal, customJournal, template];
  let rootReads = 0;
  let markdownReads = 0;
  const app = {
    vault: {
      getAbstractFileByPath: (name: string) => ["journal", "templates", "Custom daily", "raw"].includes(name) ? Object.assign(new TFolder(), { path: name }) : files.find(file => file.path === name),
      getRoot: () => {
        rootReads++;
        return { children: ["journal", "templates", "Custom daily", "raw"].map((root) => ({ path: root })) };
      },
      getAllLoadedFiles: () => { throw new Error("Home build must not scan all loaded files when root children are available"); },
      getMarkdownFiles: () => { markdownReads++; return files; }
    },
    metadataCache: { getFileCache: () => null },
    internalPlugins: { plugins: { "daily-notes": { instance: { options: daily } } } }
  } as unknown as App;
  const home = new HomeWorkbenchDataService(app);
  const first = await home.build(new Date(2026, 8, 6));
  assert.equal(first.journalDays.find((day) => day.date === "2026-09-06")?.path, journal.path);
  assert.equal(first.customTemplates[0]?.path, template.path);
  assert.equal(rootReads, 1);
  assert.equal(markdownReads, 1, "notes and custom templates share one file snapshot");

  files = [...files, ...Array.from({ length: 2000 }, (_, index) => makeFile(`raw/note-${index}.md`))];
  daily.folder = "Custom daily";
  daily.format = "YYYY/[month]MM/DD";
  const next = await home.build(new Date(2026, 8, 6));
  assert.equal(next.records.length, files.length);
  assert.equal(next.journalDays.find((day) => day.date === "2026-09-06")?.path, customJournal.path);
  assert.deepEqual(next.customTemplates, first.customTemplates);
  assert.equal(rootReads, 2, "settings enumeration stays constant as note count grows");
  assert.equal(markdownReads, 2, "each rebuild gets fresh files without redundant enumeration");
  console.log("PASS native journal root snapshots and home build enumeration stay bounded with 2,000 extra notes");
}

async function assertNativeToolsAndManagedWrites(fixture: Awaited<ReturnType<typeof nativeJournalFixture>>, root: string) {
  const adapter = new ObsidianVaultDomainAdapter(fixture.app, "native-vault", root);
  const service = new VaultDomainService(adapter);
  const publicCli = officialCliFixture(fixture, root);
  const port = createObsidianNativePort(fixture.app, adapter, () => "old-directory", { transport: publicCli.transport });
  const nativeSecurity = new PiObsidianToolSecurity();
  const identity = { vaultId: adapter.vaultId, conversationId: "native-conversation", piSessionId: "native-session", productRunId: "native-run" };
  const approvals = new FileApprovalTicketStore({ storageRootPath: path.join(root, ".test-approvals"), vaultId: adapter.vaultId });
  const receipts = new FileDomainReceiptStore({ storageRootPath: path.join(root, ".test-receipts"), vaultId: adapter.vaultId });
  await approvals.initialize(); await receipts.initialize();
  let access: PiWorkspaceAccess = { permission: "read-only", mode: "agent", memoryMode: "normal" };
  let confirmations = 0;
  const security = createPiVaultToolSecurityAdapter({
    isToolAllowed: (toolName) => piWorkspaceAllowsTool({ ...access, toolName, planToolNames: ["note_read", ...PI_OBSIDIAN_TOOL_IDS], memoryToolNames: [], externalReadToolNames: [] }),
    authorization: createPiVaultProductionAuthorizationPort({ approvals, adapter, currentRunIdentity: () => identity, userId: "fixture-user", deviceId: "fixture-device", confirmation: { async confirm() { confirmations += 1; return true; } } }),
    resultCorrection: createSecurePiVaultToolResultCorrectionPort(new EchoInkVaultToolEgressPolicy()),
    additionalToolSecurities: [nativeSecurity]
  });
  const handlers = new Map<string, (...args: any[]) => any>();
  await security.inlineExtension.factory({ on: (name: string, handler: any) => handlers.set(name, handler) } as never);
  const tools = [...createPiObsidianToolDefinitions(port, nativeSecurity), ...createPiVaultToolDefinitions({ domainService: service, security, writeExecution: createPiVaultProductionWriteExecutionPort({ receipts, domainService: service }) })];
  let id = 0;
  const call = async (toolName: string, input: any): Promise<any> => {
    const toolCallId = `native-tool-${++id}`;
    const blocked = await handlers.get("tool_call")!({ toolName, toolCallId, input }, { signal: undefined });
    if (blocked) return blocked;
    const result = await tools.find((tool) => tool.name === toolName)!.execute(toolCallId, input, undefined, undefined);
    return await handlers.get("tool_result")!({ toolName, toolCallId, ...result, isError: false });
  };
  const value = (result: any) => JSON.parse(result.content[0].text);
  assert.equal(value(await call("obsidian_context", {})).folder, "My journal");
  assert.equal(value(await call("obsidian_cli", { command: "version" })).engine, "obsidian-official-cli");
  assert.deepEqual(publicCli.calls.at(-1), ["version"]);
  assert.equal(value(await call("obsidian_cli", { command: "search", query: "diary", path: "My journal", limit: 3 })).available, true);
  assert.deepEqual(publicCli.calls.at(-1), ["search", "query=diary", "path=My journal", "limit=3"]);
  const beforeRejected = publicCli.calls.length;
  for (const input of [{ command: "eval", code: "1+1" }, { command: "read" }, { command: "read", path: "../outside.md" }, { command: "version", vault: "other" }, { command: "daily:append", content: "text" }]) {
    const rejected = await call("obsidian_cli", input);
    assert.ok(rejected.block || rejected.isError);
  }
  assert.equal(publicCli.calls.length, beforeRejected);
  publicCli.state.available = false;
  assert.equal(value(await call("obsidian_cli", { command: "version" })).available, false);
  assert.equal(fixture.nativeCalls.length, 0, "internal handlers never substitute for public CLI");
  const originalBasePath = fixture.app.vault.adapter.getBasePath;
  fixture.app.vault.adapter.getBasePath = () => path.join(root, "other-vault");
  const mismatched = await call("obsidian_cli", { command: "files" });
  assert.ok(mismatched.block || mismatched.isError);
  fixture.app.vault.adapter.getBasePath = originalBasePath;
  assert.deepEqual(await call("note_create", { relativePath: "journal/2099-01/2099-01-01.md", content: "blocked" }), { block: true, reason: "tool_policy_blocked" });
  assert.equal(confirmations, 0);
  access = { ...access, permission: "workspace-write" };
  for (const [relativePath, content] of [
    ["journal/2099-01/2099-01-01.md", "# Future month\nOriginal body\n"],
    ["views/tasks.base", 'filters:\n  and:\n    - file.inFolder("projects")\nviews:\n  - type: table\n    name: Tasks\n'],
    ["maps/notes.canvas", JSON.stringify({ nodes: [{ id: "test-node", type: "text", x: 0, y: 0, width: 200, height: 100, text: "Hello" }], edges: [] })]
  ]) {
    const created = await call("note_create", { relativePath, content });
    assert.equal(created.isError, false, `managed create must create missing parents: ${relativePath}; ${JSON.stringify(created)}`);
    assert.equal(created.details.readbackVerified, true);
    const read = value(await call("note_read", { relativePath }));
    const snapshot = read.snapshot;
    assert.equal(snapshot.content, content);
    const appended = relativePath.endsWith(".md") ? content + "\n## 补记 · 12:01\nMore text\n" : content + "\n";
    const updated = await call("note_update", { relativePath, expectedVersion: snapshot.version, content: appended });
    assert.equal(updated.isError, false);
    assert.equal(updated.details.readbackVerified, true);
    assert.equal((await call("note_update", { relativePath, expectedVersion: snapshot.version, content: "stale" })).isError, true);
    assert.equal(await readFile(path.join(root, resolveKnowledgePath(root, relativePath)), "utf8"), appended);
  }
  const search = value(await call("vault_search", { query: "Hello" }));
  assert.ok(JSON.stringify(search).includes("maps/notes.canvas"));
  assert.ok(JSON.stringify(value(await call("vault_search", { query: "Tasks" }))).includes("views/tasks.base"));
}
