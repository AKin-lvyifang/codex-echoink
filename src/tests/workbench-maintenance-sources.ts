import { patchMaintenanceSourceFrontmatter } from "../knowledge-base/maintenance-source-frontmatter";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import { diskApp } from "./workbench-maintenance-chain";
import { DEFAULT_SETTINGS } from "../settings/settings";
import { emptyKnowledgeFolderBindings, preferExistingBilingualKnowledgeDefaults, registerKnowledgeFolderBindings, registerKnowledgePrivateRoot, KNOWLEDGE_ROOT_NAMES, classifyKnowledgePath } from "../knowledge-base/root-paths";
import { isKnowledgeMaintenanceSourcePath, rawDigestFingerprint, writeRawDigestRegistry } from "../knowledge-base/raw-digest";
import { privateMaintenanceSourceScope, readPrivateMaintenanceRecords, FilePhase3MaintenanceStateStore } from "../plugin/pi-knowledge-maintenance-production";
import { createKnowledgeMaintenanceResultEnvelope } from "../knowledge-base/knowledge-maintenance-result";
import { buildKnowledgeBaseDashboardSnapshot } from "../knowledge-base/dashboard";
import { WorkbenchDataService } from "../home/workbench-data";
import { EchoInkKnowledgeSurfaceService } from "../plugin/knowledge-surface-service";
import { splitKnowledgeMaintenanceSources } from "../knowledge-base/initializer";
import { knowledgeMayCreateCategoryDirectory, knowledgeMayOrganizeMove } from "../knowledge-base/folder-organization";

export async function runWorkbenchMaintenanceSourceTests(root: string): Promise<void> {
  const vault = await fs.mkdtemp(path.join(root, "maintenance-sources-"));
  const bindings = emptyKnowledgeFolderBindings(); bindings.configured = true;
  for (const role of ["raw", "wiki", "inbox"] as const) bindings.roles[role] = { enabled: true, readPaths: [role], writePath: role, allowedSubdirectories: [] };
  bindings.collectionTargets = { web: "raw", wechat: "raw/articles" };
  const corrected = preferExistingBilingualKnowledgeDefaults(bindings, ["raw", "wiki", "inbox", ...Object.values(KNOWLEDGE_ROOT_NAMES)]);
  assert.equal(corrected.roles.raw.writePath, KNOWLEDGE_ROOT_NAMES.raw);
  assert.deepEqual(corrected.roles.raw.readPaths, ["raw", KNOWLEDGE_ROOT_NAMES.raw]);
  assert.equal(corrected.collectionTargets?.web, KNOWLEDGE_ROOT_NAMES.raw);
  assert.equal(corrected.collectionTargets?.wechat, "raw/articles", "a custom collection destination remains literal");
  assert.equal(corrected.configured, true);
  const custom = structuredClone(bindings); custom.roles.raw.readPaths = ["MySources"]; custom.roles.raw.writePath = "MySources";
  assert.equal(preferExistingBilingualKnowledgeDefaults(custom, [KNOWLEDGE_ROOT_NAMES.raw]).roles.raw.writePath, "MySources");
  for (const consent of [{ autoOrganizePaths: ["raw"] }, { allowedSubdirectories: ["approved"], allowedSubdirectoryRoots: ["raw"] }]) {
    const organized = structuredClone(bindings); Object.assign(organized.roles.raw, consent);
    assert.equal(preferExistingBilingualKnowledgeDefaults(organized, [KNOWLEDGE_ROOT_NAMES.raw]).roles.raw.writePath, "raw", "root-specific organization consent is a custom setup");
  }
  const subfolders = structuredClone(bindings); subfolders.allowAgentSubfolders = true;
  assert.equal(preferExistingBilingualKnowledgeDefaults(subfolders, [KNOWLEDGE_ROOT_NAMES.wiki]).roles.wiki.writePath, "wiki");
  assert.equal(knowledgeMayCreateCategoryDirectory(corrected, "raw/new-child"), false);
  assert.equal(knowledgeMayCreateCategoryDirectory(corrected, `${KNOWLEDGE_ROOT_NAMES.raw}/new-child`), false);
  assert.equal(knowledgeMayOrganizeMove(corrected, "raw/a.md", "raw/nested/a.md"), false);
  for (const directory of [KNOWLEDGE_ROOT_NAMES.raw, `${KNOWLEDGE_ROOT_NAMES.raw}/Inbox`]) {
    const collision = structuredClone(bindings);
    collision.roles.inbox = { enabled: true, readPaths: [directory], writePath: directory, allowedSubdirectories: [], autoOrganizePaths: [directory] };
    // The exact canonical target can be owned by another purpose or contain a nested custom purpose.
    const result = preferExistingBilingualKnowledgeDefaults(collision, [KNOWLEDGE_ROOT_NAMES.raw]);
    assert.equal(result.roles.raw.writePath, "raw");
    assert.equal(classifyKnowledgePath(result, `${directory}/inbox.md`), "inbox");
  }
  for (const file of ["raw/index.md", "raw/data.base.md", "raw/a.assets/excerpt.md", "raw/.hidden.md", "raw/.assets/excerpt.md", "raw/report.pdf", "raw/image.png", "raw/text.txt"]) assert.equal(isKnowledgeMaintenanceSourcePath(file), false, file);
  const write = async (relative: string, body = "# 合成资料\n可以正式维护的Markdown内容。\n") => { await fs.mkdir(path.dirname(path.join(vault, relative)), { recursive: true }); await fs.writeFile(path.join(vault, relative), body); };
  for (let i = 0; i < 23; i++) await write(`raw/articles/来源${String(i).padStart(2, "0")}.md`);
  await write(`${KNOWLEDGE_ROOT_NAMES.raw}/中文新增.md`);
  await write("raw/index.md"); await write("raw/article.assets/caption.md"); await write("raw/article.assets/image.png"); await write("raw/report.pdf"); await write("raw/attachment.docx");
  for (const role of ["wiki", "inbox"] as const) await fs.mkdir(path.join(vault, KNOWLEDGE_ROOT_NAMES[role]), { recursive: true });
  await write(`${KNOWLEDGE_ROOT_NAMES.inbox}/独立条目.md`);
  const unbind = registerKnowledgeFolderBindings(vault, () => corrected);
  const privateRoot = path.join(vault, ".obsidian/plugins/fixture/private/knowledge");
  registerKnowledgePrivateRoot(vault, privateRoot);
  const completed = "raw/articles/来源00.md", bytes = await fs.readFile(path.join(vault, completed));
  await writeRawDigestRegistry(vault, { schemaVersion: 1, updatedAt: new Date().toISOString(), entries: { [completed]: { rawPath: completed, fingerprint: rawDigestFingerprint(completed, bytes), size: bytes.length, mtime: 1, digestedAt: 1, runId: "completed-fixture", reportPath: "", evidencePaths: [], confidence: "verified" } } });
  await write(completed, patchMaintenanceSourceFrontmatter(bytes.toString("utf8"), { status: "已提炼", summary: "合成已完成来源", targetPaths: [] }));
  const settings = structuredClone(DEFAULT_SETTINGS); settings.knowledgeBase.folderBindings = corrected;
  try {
    const read = async () => {
      const plugin = { settings, app: diskApp(vault), getVaultPath: () => vault, getKnowledgeSurfaceService: () => ({ getMaintenanceRecords: () => readPrivateMaintenanceRecords(privateRoot) }) };
      const service = Object.assign(Object.create(WorkbenchDataService.prototype), { plugin, sourceContent: new Map() });
      const issues: string[] = [];
      const workbench = await service.readPendingRaw(issues);
      assert.deepEqual(issues, []);
      const formal = await privateMaintenanceSourceScope(vault, { limit: Infinity, processedSources: settings.knowledgeBase.processedSources });
      const dashboard = await buildKnowledgeBaseDashboardSnapshot(vault, settings.knowledgeBase);
      assert.deepEqual(workbench.map((entry: { path: string }) => entry.path).sort(), [...formal.sourcePaths].sort());
      assert.equal(dashboard.raw.changedCount, formal.sourcePaths.length);
      return { plugin, formal, dashboard };
    };
    const before = await read(); assert.equal(before.formal.sourcePaths.length, 24);
    assert.equal(before.dashboard.raw.fileCount, 25);
    assert.deepEqual(splitKnowledgeMaintenanceSources(before.formal.sourcePaths).map(batch => batch.length), [20, 4]);
    await write("raw/articles/旧目录新采集.md");
    const after = await read(); assert.equal(after.formal.sourcePaths.length, 25); assert.ok(after.formal.sourcePaths.includes("raw/articles/旧目录新采集.md"));
    const service = Object.assign(Object.create(EchoInkKnowledgeSurfaceService.prototype), { plugin: after.plugin });
    const source = { version: 1, signalId: 7, moduleId: "knowledge-base", businessKey: "workbench:knowledge-base:raw:fixture", objects: after.formal.sourcePaths, capturedAt: 1, prompt: "整理这些" };
    const batches = await service.prepareWorkbenchMaintenance(source, "都按你推荐的去做");
    assert.deepEqual(batches.map((batch: any) => batch.maintenanceScope.sourcePaths.length), [20, 5]);
    assert.ok(batches.every((batch: any) => batch.text.startsWith("/maintain ") && batch.maintenanceScope.folderBindingsRevision === corrected.revision));
    assert.ok(batches.some((batch: any) => batch.maintenanceScope.sourcePaths.some((relative: string) => relative.includes("inbox") || relative.includes("收件箱"))), "Inbox joins the same maintenance pipeline");
    await assert.rejects(service.prepareWorkbenchMaintenance({ ...source, signalId: 6 }), /不属于资料维护/u);
    const state = new FilePhase3MaintenanceStateStore({ storageRootPath: privateRoot, vaultId: "source-fixture" });
    await state.saveRecord({ schemaVersion: 1, recordId: `maintenance-${"f".repeat(32)}`, runId: "failed-current-version", at: 2, date: "2026-10-21", summary: "Current version failed", result: createKnowledgeMaintenanceResultEnvelope({ status: "failed" }),
      sources: [{ path: completed, fingerprint: rawDigestFingerprint(completed, bytes), status: "failed", evidencePaths: [] }] });
    const failed = await read(); assert.equal(failed.formal.sourcePaths.length, 25); assert.equal(failed.dashboard.raw.digestStatus.failed, 0);
    const report = { eligible: after.formal.sourcePaths, count: after.dashboard.raw.changedCount, batches: batches.map((batch: any) => batch.maintenanceScope), bindingsBefore: bindings, bindingsAfter: corrected, filesMoved: 0 };
    await fs.writeFile(path.join(root, "maintenance-sources.json"), JSON.stringify(report, null, 2));
    console.log("Workbench maintenance sources: PASS (configured defaults, custom preservation, legacy new source, dashboard equality, <=20 batches, Raw+Inbox scheme A)");
  } finally { unbind(); }
}
