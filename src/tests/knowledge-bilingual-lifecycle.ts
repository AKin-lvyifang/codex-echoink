import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { nativeJournalFixture } from "./native-journal-fixture";
import { EchoInkKnowledgeSurfaceService, createKnowledgeInitializationHost } from "../plugin/knowledge-surface-service";
import { KNOWLEDGE_ROOT_NAMES, knowledgeRolePath, resolveKnowledgePath, resolveKnowledgePathFromRoots, rebaseKnowledgePathRecords } from "../knowledge-base/root-paths";
import { KnowledgeBaseInitializer } from "../knowledge-base/initializer";
import { KnowledgeBaseCaptureService } from "../knowledge-base/capture";
import { KnowledgeAgentIndex } from "../knowledge-base/knowledge-agent-index";
import { KnowledgeReferenceBuilder } from "../knowledge-base/query";
import { refreshKnowledgeBaseIndex } from "../knowledge-base/incremental-index";
import { readNativeJournalSettings } from "../home/native-journal";
import { readRawDigestRegistry, writeRawDigestRegistry } from "../knowledge-base/raw-digest";
import { readKnowledgeBaseTrackerHints } from "../knowledge-base/tracker";
import { ProductionPiKnowledgeMaintenanceToolPort } from "../plugin/pi-knowledge-maintenance-production";
import { ObsidianVaultDomainAdapter, createPhase3MaintenanceVaultDomainAdapter } from "../plugin/obsidian-vault-domain-adapter";
import { VaultDomainService } from "../harness/pi-native/vault-domain-service";
import { createApiProviderConfig } from "../settings/settings";
import { maintenanceRequestsAdviceOnly } from "../knowledge-base/wiki-folder-names";
import type { PiTurnInteractionIdentity } from "../plugin/pi-turn-interaction-broker";

export async function runKnowledgeBilingualLifecycleTests(): Promise<void> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "echoink-bilingual-lifecycle-")));
  try {
    const vault = path.join(root, "existing");
    const fixture = await nativeJournalFixture(vault);
    fixture.plugin.settings.defaultPermission = "workspace-write";
    for (const role of Object.keys(KNOWLEDGE_ROOT_NAMES)) await fs.mkdir(path.join(vault, role));
    await fixture.write("raw/source.md", "# Original\nBILINGUAL_SOURCE_TOKEN\n");
    await fixture.write("wiki/old.md", '# Prior\n<!-- echoink-source: {"path":"raw/source.md","revision":"sha256:prior"} -->\n');
    await fixture.write("outputs/.ingest-tracker.md", "# Knowledge Maintenance Tracker\n## Processed\n- `raw/source.md`\n");
    await fixture.write("notes/local.txt", "untouched custom content");
    fixture.records["daily-notes"].instance.options = { folder: "journal", template: "templates/此刻速记.md" };
    fixture.records.templates.instance.options = { folder: "templates" };
    (fixture.app.vault as any).setConfig("attachmentFolderPath", "assets");
    fixture.plugin.settings.knowledgeBase.processedSources = { "raw/source.md": { size: 1, mtime: 1 } };
    await writeRawDigestRegistry(vault, { schemaVersion: 1, updatedAt: "now", entries: { "raw/source.md": {
      rawPath: "raw/source.md", fingerprint: "fixture", size: 1, mtime: 1, digestedAt: 1, runId: "prior",
      reportPath: "outputs/prior.md", evidencePaths: ["wiki/prior.md"], confidence: "verified"
    } } });
    let modelCalls = 0;
    fixture.plugin.generateWikiFolderNames = async (_system: string, input: string) => {
      modelCalls++;
      if (modelCalls === 1) throw new Error("fixture model unavailable");
      return JSON.stringify(Object.fromEntries(JSON.parse(input).map((entry: { id: string }) => [entry.id, "笔记"])));
    };
    const service = new EchoInkKnowledgeSurfaceService(fixture.plugin);
    await service.getInitializationState();
    const renamed = await service.optimizeFolderNames();
    assert.equal(renamed.renamed.length, 10, JSON.stringify(renamed));
    assert.equal(renamed.skipped.length, 1, "model failure must not block fixed roots");
    assert.equal(modelCalls, 1);
    const custom = await service.optimizeFolderNames();
    assert.equal(custom.renamed.length, 1);
    assert.equal(custom.skipped.length, 0);
    for (const [role, name] of Object.entries(KNOWLEDGE_ROOT_NAMES)) {
      assert.equal(await fs.stat(path.join(vault, role)).catch(() => null), null);
      assert.ok((await fs.stat(path.join(vault, name))).isDirectory());
    }
    assert.equal(await fs.readFile(path.join(vault, "笔记（notes）/local.txt"), "utf8"), "untouched custom content");
    const repeated = await service.optimizeFolderNames();
    assert.equal(repeated.renamed.length, 0);
    assert.match(repeated.message!, /无需优化/u);
    assert.equal(modelCalls, 2);
    const source = `${KNOWLEDGE_ROOT_NAMES.raw}/source.md`;
    assert.ok((await fs.readFile(path.join(vault, `${KNOWLEDGE_ROOT_NAMES.wiki}/old.md`), "utf8")).includes(source));
    assert.ok((await fs.readFile(path.join(vault, `${KNOWLEDGE_ROOT_NAMES.outputs}/.ingest-tracker.md`), "utf8")).includes(source));
    assert.ok(fixture.plugin.settings.knowledgeBase.processedSources[source]);
    assert.equal((await readRawDigestRegistry(vault)).entries[source].rawPath, source);
    assert.equal(readNativeJournalSettings(fixture.app).folder, KNOWLEDGE_ROOT_NAMES.journal);
    assert.equal((fixture.app.vault as any).getConfig("attachmentFolderPath"), KNOWLEDGE_ROOT_NAMES.assets);

    const adapter = new ObsidianVaultDomainAdapter(fixture.app, "bilingual-vault", vault);
    const domain = new VaultDomainService(createPhase3MaintenanceVaultDomainAdapter({ base: adapter, trackerRelativePath: "outputs/.ingest-tracker.md" }), { allowMissingParentDirectories: true });
    const port = new ProductionPiKnowledgeMaintenanceToolPort({ vaultRootPath: vault,
      privateKnowledgeRootPath: path.join(root, "maintenance"), vaultId: "bilingual-vault", userId: "fixture", deviceId: "fixture", domainService: domain, dateKey: () => "2026-09-19" });
    await port.initialize();
    const maintained = await port.execute({ vaultId: "bilingual-vault", conversationId: "conversation", piSessionId: "pi", productRunId: "run", toolCallId: "tool", mode: "maintain", request: "",
      sourcePaths: ["raw/source.md"], preferenceSnapshot: { profileVersion: "echoink-knowledge-preference-profile-v1", state: "default", revision: `sha256:${"a".repeat(64)}` },
      candidateActions: [{ targetPath: "wiki/summary.md", content: "# BILINGUAL_RESULT_TOKEN\n来源：[原文](raw/source.md)", expectedTarget: { kind: "missing" } }] });
    assert.equal(maintained.status, "completed", JSON.stringify(maintained));
    assert.deepEqual(maintained.processedSourcePaths, [source]);
    assert.equal(maintained.producedPaths.some((value) => value.startsWith("wiki/")), false);
    const knowledge = `${KNOWLEDGE_ROOT_NAMES.wiki}/summary.md`;
    const body = await fs.readFile(path.join(vault, knowledge), "utf8");
    assert.ok(body.includes(source));
    assert.equal(body.includes("(raw/source.md)"), false);
    const hints = await readKnowledgeBaseTrackerHints(vault, "outputs/.ingest-tracker.md", [{ path: source, size: 1, mtime: 1 }], true);
    assert.ok(hints.paths.has(source));
    const index = new KnowledgeAgentIndex({ vaultPath: vault, storageRootPath: path.join(root, "index") });
    assert.equal((await index.read({ vaultRelativePath: "wiki/summary.md" })).vaultRelativePath, knowledge);
    const reference = await new KnowledgeReferenceBuilder(vault).buildReference({ vaultRelativePath: "wiki/summary.md", question: "BILINGUAL_RESULT_TOKEN" });
    assert.equal(reference.vaultRelativePath, knowledge, "exact references return the actual path");
    assert.ok((await index.readReliableKnowledgeForRaw("raw/source.md"))?.entries.length);
    const collected = await new KnowledgeBaseCaptureService(fixture.plugin).captureChatInput("inbox", "COLLECTED_TOKEN", []);
    assert.ok(collected[0].startsWith(`${KNOWLEDGE_ROOT_NAMES.inbox}/`));
    assert.ok((await service.getDashboardSnapshot()).wiki.fileCount > 0);
    assert.equal(await fs.stat(path.join(vault, "outputs")).catch(() => null), null);

    // Both roots are preserved and explicit existing names must never cross-read.
    await fixture.write("raw/source.md", "SECOND_ROOT_TOKEN");
    await fixture.write("wiki/other.md", "SECOND_ROOT_TOKEN");
    const conflict = await service.optimizeFolderNames();
    assert.ok(conflict.skipped.some((item) => item.path === "raw"));
    assert.equal(resolveKnowledgePath(vault, "raw/source.md"), "raw/source.md");
    assert.equal(resolveKnowledgePath(vault, source), source);
    const reloaded = new KnowledgeAgentIndex({ vaultPath: vault, storageRootPath: path.join(root, "index") });
    assert.ok((await reloaded.read({ vaultRelativePath: "raw/source.md" })).content.includes("SECOND_ROOT_TOKEN"));
    assert.ok((await reloaded.read({ vaultRelativePath: source })).content.includes("BILINGUAL_SOURCE_TOKEN"));
    const incremental = await refreshKnowledgeBaseIndex(vault, { roots: ["raw", "wiki"] });
    assert.ok(incremental.entries.some((entry) => entry.path === source));
    assert.ok(incremental.entries.some((entry) => entry.path === "raw/source.md"));
    assert.equal((await service.getDashboardSnapshot()).raw.fileCount, 2);
    const restoredConflict = await service.restoreOriginalDirectories();
    assert.ok(restoredConflict.skipped.length > 0);
    assert.equal(await fs.readFile(path.join(vault, "raw/source.md"), "utf8"), "SECOND_ROOT_TOKEN");
    await fs.rm(path.join(vault, "raw/source.md"));
    const restored = await service.restoreOriginalDirectories();
    assert.ok(restored.restored > 0);
    assert.equal(await fs.readFile(path.join(vault, "raw/source.md"), "utf8"), "# Original\nBILINGUAL_SOURCE_TOKEN\n");
    assert.equal(await fs.readFile(path.join(vault, "notes/local.txt"), "utf8"), "untouched custom content");

    const emptyVault = path.join(root, "empty");
    const empty = await nativeJournalFixture(emptyVault);
    const emptyService = new EchoInkKnowledgeSurfaceService(empty.plugin);
    await emptyService.startInitialization("recommended");
    await emptyService.confirmInitialization();
    for (let count = 0; count < 300 && (await emptyService.getInitializationState())?.status === "active"; count++) await new Promise((resolve) => setTimeout(resolve, 5));
    const job = (await emptyService.getInitializationState())!;
    assert.equal(job.status, "initialized", JSON.stringify(job));
    assert.ok(job.guidePath.startsWith(`${KNOWLEDGE_ROOT_NAMES.wiki}/`));
    assert.ok((await fs.readFile(path.join(emptyVault, job.guidePath), "utf8")).includes(`${KNOWLEDGE_ROOT_NAMES.assets}/`));
    const host = createKnowledgeInitializationHost(empty.plugin);
    const initializer = new KnowledgeBaseInitializer(host);
    await initializer.initialize();
    assert.equal(await initializer.refreshManagedGuide(), true, "unchanged bilingual guide remains managed after reload");
    await fs.appendFile(path.join(emptyVault, job.guidePath), "\nUser edit\n");
    assert.equal(await initializer.refreshManagedGuide(), false, "user edits are preserved");
    assert.equal(readNativeJournalSettings(empty.app).folder, KNOWLEDGE_ROOT_NAMES.journal);
    assert.equal(empty.records["daily-notes"].instance.options.folder, KNOWLEDGE_ROOT_NAMES.journal, "native configuration persists the actual folder");
    for (const role of Object.keys(KNOWLEDGE_ROOT_NAMES)) assert.equal(await fs.stat(path.join(emptyVault, role)).catch(() => null), null);
    await empty.write("raw", "occupied by an ordinary file");
    const occupiedIndex = new KnowledgeAgentIndex({ vaultPath: emptyVault, storageRootPath: path.join(root, "occupied-index") });
    assert.ok((await occupiedIndex.refresh()).entries > 0, "a root name occupied by a file cannot block other directories");
    assert.ok((await emptyService.getDashboardSnapshot()).wiki.fileCount > 0);
    await assertInitializationSubmitAndQuestion(empty.plugin);

    for (const flavor of [path.posix, path.win32]) {
      const rootPath = flavor === path.win32 ? "C:\\Vault" : "/vault";
      const relative = flavor.relative(rootPath, flavor.join(rootPath, KNOWLEDGE_ROOT_NAMES.raw, "source.md")).split(flavor.sep).join("/");
      assert.equal(knowledgeRolePath(relative), "raw/source.md");
      assert.equal(resolveKnowledgePathFromRoots("raw/source.md", [KNOWLEDGE_ROOT_NAMES.raw]), relative);
    }
    const rebased = rebaseKnowledgePathRecords({ role: "raw", createdDirectories: ["raw"], original: "raw/source.md", current: "raw/source.md", rawPath: "raw/source.md" }, "raw", KNOWLEDGE_ROOT_NAMES.raw);
    assert.deepEqual(rebased.createdDirectories, ["raw"]);
    assert.equal(rebased.original, "raw/source.md");
    assert.equal(rebased.rawPath, source);
    console.log("PASS real filesystem bilingual roots: rename, conflicts, maintenance, tracker, capture, reload/index, journal, initialization and restore; Windows/Linux path simulation");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}

async function assertInitializationSubmitAndQuestion(plugin: any): Promise<void> {
  const provider = createApiProviderConfig("deepseek", "fixture"); provider.apiKey = "fixture-only";
  plugin.settings.apiProviders = [provider]; plugin.settings.activeApiProviderId = provider.id; plugin.settings.defaultModel = provider.defaultModelId;
  let pending: Readonly<PiTurnInteractionIdentity> | null = null;
  let submitted: any;
  let finish!: (value: any) => void;
  let unsubscribed = false;
  let released = false;
  plugin.submitPiChat = async (request: any) => { submitted = request; return { productRunId: "run", result: new Promise((resolve) => { finish = resolve; }) }; };
  plugin.subscribePiRun = (_run: string, listener: any) => {
    listener({ type: "interaction_requested", interaction: { kind: "question", piSessionId: "pi", interactionId: "question" } });
    return { unsubscribe() { unsubscribed = true; } };
  };
  plugin.releasePiProductionRun = () => { released = true; };
  const host = createKnowledgeInitializationHost(plugin, (identity) => { pending = identity; });
  for (const permission of ["workspace-write", "read-only"]) {
    plugin.settings.defaultPermission = permission;
    const running = host.runMaintenanceBatch({ conversationId: "conversation", sourcePaths: [`${KNOWLEDGE_ROOT_NAMES.raw}/source.md`], batchIndex: 0, expectedBatches: 2, signal: new AbortController().signal });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(submitted.permission, permission);
    assert.ok(submitted.text.includes(`${KNOWLEDGE_ROOT_NAMES.raw}/source.md`));
    assert.ok(submitted.text.includes("1/2"));
    assert.equal(maintenanceRequestsAdviceOnly(submitted.text), false, "input must not accidentally force writable runs into advice mode");
    assert.ok(pending, "early questions are retained by the initialization host");
    finish({ terminalState: "completed", permission, maintenance: { processedSourcePaths: [], pendingSourcePaths: [], warnings: [] } });
    await running;
    assert.equal(pending, null);
    assert.ok(unsubscribed && released);
  }
}
