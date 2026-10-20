import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { emptyKnowledgeFolderBindings, migrateKnowledgeFolderBindings, classifyKnowledgePath, knowledgeFolderIssues, normalizeKnowledgeFolderBindings } from "../knowledge-base/folder-bindings";
import { DESKTOP_KNOWLEDGE_ROOT_ROLES, getKnowledgeFolderBindings, knowledgePathPolicy, registerKnowledgeFolderBindings, registerKnowledgePrivateRoot, knowledgeRoleRoots, resolveKnowledgeRoleTarget, resolveKnowledgePath, knowledgePathRole } from "../knowledge-base/root-paths";
import { KnowledgeAgentIndex } from "../knowledge-base/knowledge-agent-index";
import { buildKnowledgeBaseDashboardSnapshot } from "../knowledge-base/dashboard";
import { DEFAULT_SETTINGS, normalizeSettingsData } from "../settings/settings";
import { isHomeRecentNotePath } from "../home/home-workbench-model";
import CodexForObsidianPlugin from "../main";
import { privateMaintenanceSourceScope, FilePhase3MaintenanceStateStore, rebasePrivateMaintenanceRecords, readPrivateMaintenanceRecords } from "../plugin/pi-knowledge-maintenance-production";
import { readRawDigestRegistry, writeRawDigestRegistry, rawDigestFingerprint } from "../knowledge-base/raw-digest";
import { EchoInkKnowledgeSurfaceService } from "../plugin/knowledge-surface-service";
import { KnowledgeRetriever } from "../knowledge-base/query";
import { KnowledgeBaseCaptureService } from "../knowledge-base/capture";
import { TFolder, TFile } from "obsidian";

async function runCaptureSourceBindingTests(): Promise<void> {
  for (const allowAttachments of [false, true]) {
    const temporaryRoot = await mkdtemp(path.join(tmpdir(), "echoink-capture-bindings-"));
    const vault = path.join(temporaryRoot, "vault");
    const rawDirectory = "资料/来源";
    const assetsDirectory = "资源/附件";
    const config = emptyKnowledgeFolderBindings();
    Object.assign(config.roles.raw, { enabled: true, readPaths: [rawDirectory], writePath: rawDirectory, allowedSubdirectories: allowAttachments ? ["attachments"] : [] });
    Object.assign(config.roles.assets, { enabled: true, readPaths: [assetsDirectory], writePath: assetsDirectory });
    await mkdir(vault);
    const release = registerKnowledgeFolderBindings(vault, () => config);
    try {
      for (const directory of [rawDirectory, assetsDirectory, "工作"]) await mkdir(path.join(vault, directory), { recursive: true });
      const fixtures = [
        { name: "external.pdf", source: path.join(temporaryRoot, "external.pdf"), body: "external PDF source" },
        { name: "external.docx", source: path.join(temporaryRoot, "external.docx"), body: "external DOCX source" },
        { name: "chat.pdf", source: path.join(temporaryRoot, "chat.pdf"), body: "chat attachment source" },
        { name: "active.pdf", source: path.join(vault, "工作/active.pdf"), body: "active attachment source" }
      ];
      for (const fixture of fixtures) await writeFile(fixture.source, fixture.body);
      const plugin = {
        getVaultPath: () => vault,
        app: { workspace: { getActiveFile: () => Object.assign(new TFile(), { path: "工作/active.pdf" }) } }
      } as unknown as CodexForObsidianPlugin;
      const capture = new KnowledgeBaseCaptureService(plugin);
      const attachment = (fixture: typeof fixtures[number]) => ({ type: "file" as const, name: fixture.name, path: fixture.source });
      const externalPaths = await capture.captureExternalFiles(fixtures.slice(0, 2).map(attachment));
      assert.equal(externalPaths.length, 2, "external PDF and DOCX are both collected");
      const chatPaths = await capture.copyAttachmentsToRaw([attachment(fixtures[2])]);
      assert.equal(chatPaths.length, 1, "chat attachments are collected");
      await capture.captureActiveAttachment();
      const targetDirectory = path.posix.join(rawDirectory, allowAttachments ? "attachments" : "");
      const collectedNames = await readdir(path.join(vault, targetDirectory));
      assert.equal(collectedNames.length, 4, "all collection entry points write to the source default or its approved attachments child");
      const collectedPaths = collectedNames.map(name => path.posix.join(targetDirectory, name));
      for (const relative of [...externalPaths, ...chatPaths, ...collectedPaths]) {
        assert.equal(path.posix.dirname(relative), targetDirectory);
        assert.equal(knowledgePathRole(vault, relative), "raw", "collected documents remain Raw sources while Assets is enabled");
      }
      for (const fixture of fixtures) {
        const relative = collectedPaths.find(item => item.endsWith(`-${fixture.name}`));
        assert(relative, `${fixture.name} was copied`);
        assert.equal(await readFile(path.join(vault, relative), "utf8"), fixture.body);
      }
      assert.deepEqual(await readdir(path.join(vault, assetsDirectory)), [], "source capture does not write to the Assets destination");
    } finally { release(); await rm(temporaryRoot, { recursive: true, force: true }); }
  }
  console.log("Knowledge capture source bindings: PASS");
}

export async function runKnowledgeFolderBindingsTests(): Promise<void> {
  await assertDesktopRoleProjection();
  await runCaptureSourceBindingTests();
  const vault = await mkdtemp(path.join(tmpdir(), "echoink-bindings-"));
  const config = emptyKnowledgeFolderBindings();
  registerKnowledgePrivateRoot(vault, path.join(vault, "private"));
  const release = registerKnowledgeFolderBindings(vault, () => config);
  try {
    for (const directory of ["阅读/文献", "工作/调研", "阅读/文献/卡片", "raw", "资料备选", "private"]) await mkdir(path.join(vault, directory), { recursive: true });
    Object.assign(config.roles.raw, { enabled: true, readPaths: ["阅读/文献", "工作/调研"], writePath: "阅读/文献" });
    Object.assign(config.roles.wiki, { enabled: true, readPaths: ["阅读/文献/卡片"], writePath: "阅读/文献/卡片" });
    assert.deepEqual(knowledgeFolderIssues(config), []);
    assert.equal(classifyKnowledgePath(config, "阅读/文献/卡片/a.md"), "wiki");
    assert.equal(classifyKnowledgePath(config, "阅读/文献-other/a.md"), null);
    assert.deepEqual(knowledgeRoleRoots(vault, "raw"), ["阅读/文献", "工作/调研"]);
    assert.equal(resolveKnowledgeRoleTarget(vault, "raw", "new.md"), "阅读/文献/new.md");
    assert.equal(resolveKnowledgePath(vault, "raw/literal.md"), "raw/literal.md");
    assert.throws(() => resolveKnowledgeRoleTarget(vault, "outputs"), /未启用/u);
    const alias = `${vault}-alias`;
    await symlink(vault, alias);
    try { assert.equal(knowledgePathRole(alias, "工作/调研/b.md"), "raw"); } finally { await rm(alias); }
    await writeFile(path.join(vault, "阅读/文献/a.md"), "# A\nBINDING_TOKEN\n");
    await writeFile(path.join(vault, "工作/调研/b.md"), "# B\nBINDING_TOKEN\n");
    await writeFile(path.join(vault, "资料备选/c.md"), "# C\nBINDING_TOKEN\n");
    await writeFile(path.join(vault, "阅读/文献/卡片/card.md"), "# Card\nBINDING_TOKEN\n[[资料备选/c.md]]\n");
    const index = new KnowledgeAgentIndex({ vaultPath: vault, storageRootPath: path.join(vault, "private") });
    const first = await index.search({ query: "BINDING_TOKEN", limit: 1 });
    assert.equal(first.total, 3);
    assert(first.continuationCursor);
    const raws = await index.search({ query: "BINDING_TOKEN", kinds: ["raw"], limit: 20 });
    assert.equal(raws.total, 2);
    assert(!raws.hits.some((item) => item.vaultRelativePath.includes("card.md")));
    config.roles.raw.readPaths.push("资料备选");
    config.revision += 1;
    await assert.rejects(() => index.search({ query: "BINDING_TOKEN", limit: 1, cursor: first.continuationCursor }), /changed|stale/iu);
    const knowledge = await index.readReliableKnowledgeForRaw("资料备选/c.md");
    assert.equal(knowledge.entries.length, 1, "unchanged knowledge text reparses source links after a binding change");
    const settings = structuredClone(DEFAULT_SETTINGS.knowledgeBase);
    settings.folderBindings = config;
    let dashboard = await buildKnowledgeBaseDashboardSnapshot(vault, settings);
    assert.equal(dashboard.health.score, 100);
    assert.equal(dashboard.health.status, "healthy");
    assert.equal(dashboard.raw.path, "阅读/文献");
    assert.equal(dashboard.raw.fileCount, 3, "overlapping source roots count each source once and exclude nested knowledge");
    assert.equal(dashboard.wiki.fileCount, 1);
    assert(dashboard.wiki.groups.some(group => group.path === "阅读/文献/卡片"));
    const plugin = Object.create(CodexForObsidianPlugin.prototype) as any;
    plugin.getVaultPath = () => vault;
    plugin.ensurePiProductionRuntime = async () => ({ knowledgeAgentIndex: index, resolveMaintenanceScope: async (request: string) => request ? { mode: "query", candidatePaths: (await index.search({ query: request, kinds: ["raw"], limit: 50 })).hits.map(hit => hit.vaultRelativePath) } : { mode: "global", ...await privateMaintenanceSourceScope(vault) } });
    const global = await plugin.prepareEchoInkKnowledgeMaintenanceScope({ request: "", attachmentPaths: [] });
    assert.equal(global.folderBindingsRevision, config.revision);
    assert.deepEqual(global.sourcePaths, ["工作/调研/b.md", "资料备选/c.md", "阅读/文献/a.md"].sort());
    const exact = await plugin.prepareEchoInkKnowledgeMaintenanceScope({ request: "", attachmentPaths: [path.join(vault, "阅读/文献/a.md")] });
    assert.deepEqual(exact, { mode: "exact", sourcePaths: ["阅读/文献/a.md"] });
    const query = await plugin.prepareEchoInkKnowledgeMaintenanceScope({ request: "BINDING_TOKEN", attachmentPaths: [] });
    assert(query.candidatePaths.every((relative: string) => classifyKnowledgePath(config, relative) === "raw"));
    await assert.rejects(plugin.prepareEchoInkKnowledgeMaintenanceScope({ request: "", attachmentPaths: [path.join(vault, "阅读/文献/卡片/card.md")] }), /资料来源/u);
    const addedPaths: string[] = [];
    for (let number = 0; number < 25; number++) { const relative = `阅读/文献/new-${String(number).padStart(2, "0")}.md`; addedPaths.push(relative); await writeFile(path.join(vault, relative), "# Additional source\n"); }
    const processedPath = addedPaths[14];
    const registry = await readRawDigestRegistry(vault, true);
    registry.entries[processedPath] = { rawPath: processedPath, fingerprint: rawDigestFingerprint(processedPath, Buffer.from("# Additional source\n")), size: 0, mtime: 0, digestedAt: 1, runId: "fixture", reportPath: "", evidencePaths: [], confidence: "verified" };
    await writeRawDigestRegistry(vault, registry);
    const boundedGlobal = await plugin.prepareEchoInkKnowledgeMaintenanceScope({ request: "", attachmentPaths: [] });
    assert.deepEqual(boundedGlobal.sourcePaths, [...global.sourcePaths, ...addedPaths].filter(relative => relative !== processedPath).sort().slice(0, 20));
    assert.equal(boundedGlobal.sourcePaths.length, 20);
    assert(!boundedGlobal.sourcePaths.includes(processedPath));
    const folderObjects = new Map(Object.values(config.roles).flatMap(binding => binding.readPaths).map(relative => [relative, Object.assign(new TFolder(), { path: relative })]));
    let saves = 0, creates = 0, optimizations = 0;
    plugin.settings = structuredClone(DEFAULT_SETTINGS); plugin.settings.defaultPermission = "read-only"; plugin.settings.knowledgeBase.folderBindings = config;
    plugin.app = { vault: { getMarkdownFiles: () => [...global.sourcePaths, ...addedPaths].map(relative => new TFile(relative)), getAbstractFileByPath: (relative: string) => folderObjects.get(relative) ?? null, createFolder: async () => { creates++; throw new Error("must not create"); } } };
    plugin.saveSettings = async () => { saves++; Object.assign(config, plugin.settings.knowledgeBase.folderBindings); };
    plugin.refreshKnowledgeBaseSurfaces = () => {};
    const surface = Object.create(EchoInkKnowledgeSurfaceService.prototype) as any;
    Object.assign(surface, { plugin, directoryHistory: { capture: async () => [], createdFolder: async () => {}, appliedBindings: async () => {} }, initializer: { isRunning: false, startBoundOptimization: async () => { optimizations++; } }, restoring: false, namingFlight: null, folderNamingBusy: false, structureQueue: Promise.resolve(), structureRevision: 0 });
    const readOnlyPlan = await surface.previewDirectoryPlan(config, []);
    assert.equal(readOnlyPlan.create.length, 0);
    await surface.applyDirectoryPlan(readOnlyPlan);
    assert.equal(saves, 1); assert.equal(creates, 0); assert.equal(optimizations, 0);
    await assert.rejects(surface.applyDirectoryPlan({ ...readOnlyPlan, create: ["Not selected"] }), /只读/u);
    await assert.rejects(surface.applyDirectoryPlan(readOnlyPlan, true), /只读/u);
    const buildConfig = structuredClone(config);
    Object.assign(buildConfig.roles.inbox, { enabled: true, readPaths: ["资料备选/验收收件箱"], writePath: "资料备选/验收收件箱", allowedSubdirectories: ["附件"] });
    const unapprovedPlan = await surface.previewDirectoryPlan(buildConfig, []);
    assert(unapprovedPlan.issues.some((issue: string) => issue.includes("原位置已失效")), "missing existing bindings remain invalid");
    const buildPlan = await surface.previewDirectoryPlan(buildConfig, ["资料备选/验收收件箱"]);
    assert.deepEqual(buildPlan.issues, [], "a confirmed new directory is not mistaken for an unsafe existing path");
    assert.deepEqual(new Set(buildPlan.create), new Set(["资料备选/验收收件箱", "资料备选/验收收件箱/附件"]));
    const linkedConfig = structuredClone(buildConfig);
    linkedConfig.roles.inbox.readPaths = ["链接父目录/收件箱"]; linkedConfig.roles.inbox.writePath = "链接父目录/收件箱";
    await symlink(path.join(vault, "资料备选"), path.join(vault, "链接父目录"));
    try {
      const linkedPlan = await surface.previewDirectoryPlan(linkedConfig, ["链接父目录/收件箱"]);
      assert(linkedPlan.issues.length > 0, "a symlink ancestor still blocks confirmed creation");
    } finally { await rm(path.join(vault, "链接父目录")); }
    await writeFile(path.join(vault, "文件父路径"), "This is a file, not a folder.");
    const blockedConfig = structuredClone(buildConfig);
    blockedConfig.roles.inbox.readPaths = ["文件父路径/收件箱"]; blockedConfig.roles.inbox.writePath = "文件父路径/收件箱";
    const blockedPlan = await surface.previewDirectoryPlan(blockedConfig, ["文件父路径/收件箱"]);
    assert(blockedPlan.issues.length > 0, "a file occupying the parent path still blocks confirmed creation");
    plugin.settings.defaultPermission = "workspace-write";
    const createdDirectories: string[] = [];
    plugin.app.vault.createFolder = async (relative: string) => {
      await mkdir(path.join(vault, relative));
      folderObjects.set(relative, Object.assign(new TFolder(), { path: relative }));
      createdDirectories.push(relative);
    };
    await assert.rejects(surface.applyDirectoryPlan(buildPlan), /重新预览/u, "changing write permission invalidates the earlier read-only preview");
    const reviewedBuildPlan = await surface.previewDirectoryPlan(buildConfig, ["资料备选/验收收件箱"]);
    await surface.applyDirectoryPlan(reviewedBuildPlan);
    assert.deepEqual(createdDirectories, reviewedBuildPlan.create, "application creates exactly the reviewed directories");
    assert.equal(config.roles.inbox.writePath, "资料备选/验收收件箱");
    assert.equal(optimizations, 0, "directory creation does not call the model");
    const ask = await new KnowledgeRetriever(vault, { agentIndex: index }).retrieve({ question: "BINDING_TOKEN", explicitPaths: ["阅读/文献/a.md"], includeUnrefined: true });
    assert.equal(ask.status, "ready", "read-only binding of existing sources permits local Ask retrieval");
    assert.equal(await import("node:fs/promises").then(fs => fs.readFile(path.join(vault, "阅读/文献/a.md"), "utf8")), "# A\nBINDING_TOKEN\n", "source text remains unchanged");
    const privateRoot = await realpath(path.join(vault, "private"));
    const recordStore = new FilePhase3MaintenanceStateStore({ storageRootPath: privateRoot, vaultId: "folder-binding-tests" });
    const recordId = `maintenance-${"e".repeat(32)}`;
    await recordStore.saveRecord({ schemaVersion: 1, recordId, runId: "rename-assessment", date: "2026-10-14", at: 1,
      summary: "阅读/文献/a.md is unchanged free text", sources: [{ path: "阅读/文献/a.md", fingerprint: "fixture", status: "processed", evidencePaths: ["阅读/文献/卡片/card.md"] }],
      result: { schema: "echoink.knowledge-maintenance-result.v1", status: "noop", notes: [], issues: [], systemPaths: [], assessments: [{ claim: "阅读/文献/a.md is unchanged free text", status: "valid", asOf: "2026-10-14", verification: "local_verified", evidence: ["阅读/文献/a.md", "https://example.com/阅读/文献/a.md"] }] } });
    await rebasePrivateMaintenanceRecords(privateRoot, "阅读/文献", "深读 材料");
    const renamedRecord = (await readPrivateMaintenanceRecords(privateRoot)).find(item => item.recordId === recordId)!;
    assert.equal(renamedRecord.sources[0].path, "深读 材料/a.md");
    assert.deepEqual(renamedRecord.sources[0].evidencePaths, ["深读 材料/卡片/card.md"]);
    assert.deepEqual(renamedRecord.result.assessments[0].evidence, ["深读 材料/a.md", "https://example.com/阅读/文献/a.md"]);
    assert.equal(renamedRecord.summary, "阅读/文献/a.md is unchanged free text");
    assert.equal(renamedRecord.result.assessments[0].claim, "阅读/文献/a.md is unchanged free text");
    config.roles.wiki.enabled = false; config.revision++;
    dashboard = await buildKnowledgeBaseDashboardSnapshot(vault, settings);
    assert.equal(dashboard.health.score, 100, "a disabled knowledge destination requires no index page or legacy tracker");
    config.roles.raw.enabled = false;
    config.roles.inbox = { enabled: true, readPaths: ["资料备选"], writePath: "资料备选", allowedSubdirectories: [] };
    config.revision++;
    dashboard = await buildKnowledgeBaseDashboardSnapshot(vault, settings);
    assert.equal(dashboard.health.assessment, "local-structure");
    assert.equal(dashboard.health.score, 100, "an Inbox-only setup is ready on its own terms");
    assert.equal(isHomeRecentNotePath("templates/ordinary.md", "", { folderBindings: config, templatesDirectory: "" }), true, "unbound literal templates notes remain ordinary content");
    const normalized = normalizeSettingsData({ ...DEFAULT_SETTINGS, englishDiary: { ...DEFAULT_SETTINGS.englishDiary, englishDirectoryMode: undefined, englishDirectory: "输出（outputs）/.english-diary/diaries", expressionDirectoryMode: undefined, expressionDirectory: "输出（outputs）/.english-diary/expressions" } });
    assert.equal(normalized.settings.englishDiary.englishDirectoryMode, "role");
    assert.equal(normalized.settings.englishDiary.expressionDirectoryMode, "role");
    config.roles.raw.enabled = false;
    config.revision += 1;
    assert.equal((await index.search({ query: "BINDING_TOKEN", kinds: ["raw"] })).total, 0);
    assert.throws(() => resolveKnowledgeRoleTarget(vault, "raw"), /未启用/u);
    const migrated = migrateKnowledgeFolderBindings(["raw", "知识库（wiki）"], { raw: "阅读/文献" });
    assert(migrated.migrationIssues.length);
    assert.equal(migrated.roles.raw.writePath, null);
    const conflicting = migrateKnowledgeFolderBindings([], { raw: "混合", wiki: "混合" });
    assert.equal(classifyKnowledgePath(conflicting, "混合/a.md"), "raw", "ambiguous legacy source remains protected");
    assert.equal(conflicting.roles.wiki.writePath, null);
    assert.deepEqual(migrateKnowledgeFolderBindings([]).roles.raw.readPaths, []);
  } finally { release(); await rm(vault, { recursive: true, force: true }); }
  console.log("Knowledge folder bindings: PASS");
}

async function assertDesktopRoleProjection(): Promise<void> {
  const vault = await mkdtemp(path.join(tmpdir(), "echoink-desktop-roles-"));
  const saved = emptyKnowledgeFolderBindings();
  for (const [role, directory] of [["raw", "来源"], ["wiki", "成果"], ["inbox", "随手记"], ["projects", "项目/研究"], ["work", "来源/旧工作"], ["archive", "历史存档"]] as const) {
    Object.assign(saved.roles[role], { enabled: true, readPaths: [directory], writePath: directory, autoOrganizePaths: [directory], allowedSubdirectories: ["旧分类"] });
    await mkdir(path.join(vault, directory), { recursive: true });
    await writeFile(path.join(vault, directory, "keep.md"), `${role}\nROLE_PROJECTION_TOKEN`);
  }
  const normalized = normalizeKnowledgeFolderBindings(saved)!;
  const settings = normalizeSettingsData({ ...structuredClone(DEFAULT_SETTINGS), knowledgeBase: { ...DEFAULT_SETTINGS.knowledgeBase, folderBindings: normalized } }).settings;
  const roundtrip = normalizeSettingsData(JSON.parse(JSON.stringify(settings))).settings;
  assert.deepEqual(roundtrip.knowledgeBase.folderBindings?.roles, normalized.roles, "all ten roles survive shared settings normalization and JSON save/load");
  const index = new KnowledgeAgentIndex({ vaultPath: vault, storageRootPath: path.join(vault, ".projection-index") });
  const search = () => index.search({ query: "ROLE_PROJECTION_TOKEN", kinds: ["raw", "wiki", "projects"], limit: 50 });
  const shared = registerKnowledgeFolderBindings(vault, () => normalized);
  let originalCandidates: string[];
  try { originalCandidates = (await search()).hits.map(hit => hit.vaultRelativePath).sort(); }
  finally { shared(); }
  assert.equal(originalCandidates.length, 3);
  const desktop = registerKnowledgeFolderBindings(vault, () => normalized, DESKTOP_KNOWLEDGE_ROOT_ROLES);
  try {
    assert.deepEqual((await search()).hits.map(hit => hit.vaultRelativePath).sort(), originalCandidates, "desktop role retirement preserves actual Raw/Wiki/Projects search candidates");
    assert.equal(getKnowledgeFolderBindings(vault), normalized, "consumption scope never replaces the saved object");
    for (const role of ["raw", "wiki", "inbox", "projects"] as const) {
      assert.deepEqual(knowledgeRoleRoots(vault, role), normalized.roles[role].readPaths);
      assert.equal(knowledgePathRole(vault, `${normalized.roles[role].writePath}/keep.md`), role);
    }
    for (const role of ["work", "archive"] as const) {
      const directory = normalized.roles[role].writePath!;
      assert.equal(knowledgePathRole(vault, `${directory}/keep.md`), null);
      assert.equal(knowledgePathPolicy(vault, `${directory}/keep.md`), `unbound:${directory}/keep.md`);
      assert.deepEqual(knowledgeRoleRoots(vault, role), []);
      assert.throws(() => resolveKnowledgeRoleTarget(vault, role), /未启用/u);
      assert.equal(await readFile(path.join(vault, directory, "keep.md"), "utf8"), `${role}\nROLE_PROJECTION_TOKEN`);
    }
    assert.equal(classifyKnowledgePath(normalized, "来源/旧工作/keep.md"), "work", "shared/mobile classification retains its original owner");
    assert.equal(classifyKnowledgePath(normalized, "来源/旧工作/keep.md", DESKTOP_KNOWLEDGE_ROOT_ROLES), null, "retired nested roots do not expand existing Raw scope");
  } finally { desktop(); }
  const mobile = registerKnowledgeFolderBindings(vault, () => normalized);
  try { assert.equal(knowledgePathRole(vault, "来源/旧工作/keep.md"), "work"); }
  finally { mobile(); await rm(vault, { recursive: true, force: true }); }
}
