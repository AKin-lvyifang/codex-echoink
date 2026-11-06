import { EchoInkKnowledgeSurfaceService } from "../plugin/knowledge-surface-service";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { MaintenanceP1Workflow, type MaintenanceP1Host } from "../knowledge-base/maintenance-p1-workflow";
import { isP1Open, hasP1PartialSettlement, SOURCE_FRONTMATTER_UNSAFE, type KnowledgeMaintenanceRecord } from "../knowledge-base/maintenance-record";
import { patchMaintenanceSourceFrontmatter, SourceFrontmatterUnsafeError } from "../knowledge-base/maintenance-source-frontmatter";
import { createKnowledgeMaintenanceResultEnvelope } from "../knowledge-base/knowledge-maintenance-result";
import { maintenanceReceiptForRecord, projectMaintenanceActivity } from "../knowledge-base/maintenance-activity";
import { rawDigestFingerprint } from "../knowledge-base/raw-digest";
import { emptyKnowledgeFolderBindings, registerKnowledgeFolderBindings, registerKnowledgePrivateRoot } from "../knowledge-base/root-paths";
import { FilePhase3MaintenanceStateStore, privateMaintenanceSourceScope, readPrivateMaintenanceRecords, readOpenMaintenanceSelection, assertMaintenanceRetrySelection } from "../plugin/pi-knowledge-maintenance-production";
import type { PiKnowledgeMaintenanceToolInput } from "../harness/pi-native/contracts";

const revision = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`;
const body = (index: number) => `# Synthetic source ${index}\nSynthetic evidence ${index} stays unchanged.\n`;
const unsafe = (index: number) => `---\n<% synthetic_template_${index} %>\n---\n${body(index)}`;

/** Synthetic old checkpoints only; no customer note text is used here. */
export async function runRDa4ae1MaintenanceTests(root: string): Promise<void> {
  await fs.mkdir(root, { recursive: true });
  const f = await oldCheckpoint(path.join(root, "old-20"));
  try {
    const originals = await Promise.all(f.paths.map(file => f.read(file)));
    const pages = await Promise.all(f.record().p1!.writingPlan.map(item => f.read(item.targetPath)));
    assert.equal(isP1Open(f.record()), true, "legacy unfinished checkpoints remain open");
    let result = await f.resume();
    assert.equal(result.status, "completed", result.message);
    assert.equal(result.maintenanceResult?.status, "partial");
    let record = f.record();
    assert.equal(record.p1!.phase, "finalize", "partial must never become legacy completed");
    assert.equal(hasP1PartialSettlement(record), true);
    assert.equal(isP1Open(record), false);
    assert.equal(record.result.issues.filter(issue => issue.code === SOURCE_FRONTMATTER_UNSAFE).length, 6);
    assert.equal(result.processedSourcePaths?.length, 14);
    assert.equal(record.p1!.decompositions.find(item => item.sourcePath === f.paths[6])!.units.length, 0);
    assert.equal(record.p1!.decompositions.find(item => item.sourcePath === f.paths[1])!.units.length, 1);
    for (let index = 1; index <= 6; index++) {
      assert.equal(await f.read(f.paths[index]), originals[index], "unsafe source bytes remain exact");
      assert.equal(record.sources[index].status, "failed");
      assert.equal(record.p1!.sourceFrontmatterFailures![f.paths[index]].contentRevision, revision(originals[index]));
    }
    assert.equal(f.writes.includes(f.paths[0]), false, "the already-finalized first source is preserved");
    for (const [index, item] of record.p1!.writingPlan.entries()) assert.equal(await f.read(item.targetPath), pages[index]);
    assert.equal(f.writes.some(file => file.startsWith("wiki/")), false, "14 confirmed pages are never rewritten");
    assert.match(maintenanceReceiptForRecord(record).text, /6 篇来源的属性回写失败/u);
    const activity = projectMaintenanceActivity(record)!;
    assert.equal(activity.status, "partial");
    assert.equal(activity.steps.some(step => step.state === "running"), false);
    assert.equal(activity.failures.length, 6);
    assert.deepEqual((await privateMaintenanceSourceScope(f.vault)).sourcePaths, []);
    assert.equal((await privateMaintenanceSourceScope(f.vault)).deferredSourcePaths.length, 6);
    assert.equal((await privateMaintenanceSourceScope(f.vault, { includeDeferredFailures: true })).sourcePaths.length, 6, "manual eligibility retains failures");
    await f.write("raw/fresh.md", body(21));
    assert.deepEqual((await privateMaintenanceSourceScope(f.vault)).sourcePaths, ["raw/fresh.md"]);
    const beforeRetry = [...f.writes];
    result = await f.resume([f.paths[1]]);
    assert.equal(result.recordId, record.recordId);
    assert.equal(result.maintenanceResult?.status, "partial");
    assert.deepEqual(f.writes, beforeRetry, "unchanged manual retry reports the original failure without writing Wiki");
    await f.write(f.paths[1], `---\nfixed: true\n---\n${body(1)}`);
    await f.write(f.paths[2], `---\nfixed: true\n---\n${body(2)}`);
    const auto = await privateMaintenanceSourceScope(f.vault);
    assert.ok(auto.sourcePaths.includes(f.paths[1]) && auto.sourcePaths.includes(f.paths[2]), "frontmatter-only changes invalidate full-file deferral");
    assert.deepEqual(auto.retryGroups.map(group => group.sourcePaths), [[f.paths[1], f.paths[2]]]);
    for (let index = 0; index < 24; index++) await f.write(`raw/new-${index}.md`, body(index + 30));
    const selected = (await privateMaintenanceSourceScope(f.vault, { limit: Infinity })).sourcePaths;
    const service = Object.assign(Object.create(EchoInkKnowledgeSurfaceService.prototype), { plugin: { getVaultPath: () => f.vault, settings: { knowledgeBase: { processedSources: {} } } } });
    const batches = await service.prepareWorkbenchMaintenance({ version: 1, signalId: 7, moduleId: "knowledge-base", businessKey: "synthetic-retry", objects: selected, capturedAt: 1, prompt: "Synthetic" });
    assert.deepEqual(batches.map((batch: any) => batch.maintenanceScope.sourcePaths.length), [2, 20, 5], "retry group and every fresh source remain queued separately");
    assert.deepEqual(batches[0].maintenanceScope.sourcePaths, [f.paths[1], f.paths[2]]);
    assert.deepEqual([...batches.flatMap((batch: any) => batch.maintenanceScope.sourcePaths)].sort(), [...selected].sort(), "Infinity scanning never drops the remaining new-source batches");
    await assert.rejects(assertMaintenanceRetrySelection(f.vault, { conversationId: "new-conversation", sourcePaths: [f.paths[1]] }), /回到原整理任务/u);
    await assert.rejects(assertMaintenanceRetrySelection(f.vault, { conversationId: "synthetic-conversation", sourcePaths: [f.paths[1], "raw/fresh.md"] }), /单独重试/u);
    const crossConversation = await f.resume([f.paths[1]], "new-conversation");
    assert.equal(crossConversation.status, "failed"); assert.match(crossConversation.message, /回到原整理任务/u);
    assert.equal(f.writes.includes(f.paths[1]), false);
    result = await f.resume([f.paths[1]]);
    assert.equal(result.status, "completed", result.message);
    record = f.record();
    assert.equal(record.sources[1].status, "processed");
    assert.equal(record.sources[2].status, "failed", "a one-source retry cannot write other repaired sources");
    assert.equal(f.writes.includes(f.paths[2]), false);
    assert.equal(record.result.issues.length, 5);
    assert.equal(isP1Open(record), false);
    await f.write(f.paths[2], `---\nfixed: true\n---\n${body(2)}Changed body.\n`);
    result = await f.resume([f.paths[2]]);
    assert.equal(result.status, "failed"); assert.match(result.message, /来源已变化/u);
    assert.equal(f.writes.includes(f.paths[2]), false);
    const legacyRoundtrip = JSON.parse(JSON.stringify(record)) as KnowledgeMaintenanceRecord;
    delete legacyRoundtrip.p1!.settlement;
    assert.equal(isP1Open(legacyRoundtrip), true, "dropped optional fields fail closed");
    const inconsistent = structuredClone(record); delete inconsistent.p1!.committedPages[inconsistent.p1!.writingPlan[0].id];
    assert.equal(isP1Open(inconsistent), true, "a marker cannot override missing durable receipts");
    const completed = structuredClone(record); completed.p1!.phase = "completed"; delete completed.p1!.settlement; delete completed.p1!.sourceFrontmatterFailures;
    assert.equal(isP1Open(completed), false, "legacy full success remains settled");
    // Existing parser/save retains the optional P1 payload; old runtimes can
    // still treat phase=finalize conservatively without inventing success.
    const store = new FilePhase3MaintenanceStateStore({ storageRootPath: f.privateRoot, vaultId: "r-da4ae1" });
    await store.saveP1Record(record);
    const roundtrip = (await readPrivateMaintenanceRecords(f.privateRoot))[0];
    assert.deepEqual(roundtrip.p1, record.p1);
    assert.equal(hasP1PartialSettlement(roundtrip), true);
    assert.equal(await readOpenMaintenanceSelection(f.vault, { conversationId: "synthetic-conversation", branchProductRunIds: ["original-run"] }), null);
  } finally { f.release(); }

  const metadata = await oldCheckpoint(path.join(root, "retained-metadata"));
  try {
    await metadata.resume();
    const previous = createKnowledgeMaintenanceResultEnvelope({ ...metadata.record().result, linkingTaskId: "existing-linking-task",
      systemPaths: ["outputs/synthetic-receipt.md"], assessments: [{ claim: "Synthetic retained assessment", status: "valid", evidence: ["Synthetic evidence"], asOf: "2026-11-01", verification: "local_verified" }],
      issues: [...metadata.record().result.issues, { code: "link_target_skipped", path: "wiki/existing.md", message: "Synthetic existing linking issue" }] });
    await metadata.updateResult(previous);
    for (let index = 1; index <= 6; index++) await metadata.write(metadata.paths[index], `---\nfixed: true\n---\n${body(index)}`);
    const result = await metadata.resume();
    const record = metadata.record();
    assert.equal(result.status, "completed", result.message);
    assert.equal(record.p1!.phase, "completed", "all source bookkeeping can finish independently of another issue");
    assert.equal(record.result.status, "partial", "an unresolved linking issue must not become full success");
    assert.match(result.message, /仍有未完成项/u);
    assert.equal(record.result.linkingTaskId, previous.linkingTaskId);
    assert.deepEqual(record.result.assessments, previous.assessments);
    assert.deepEqual(record.result.systemPaths, previous.systemPaths);
    assert.deepEqual(record.result.issues.map(issue => issue.code), ["link_target_skipped"]);
    assert.match(maintenanceReceiptForRecord(record).text, /仍有 1 项未完成/u);
    record.progress = { version: 1, stage: "finalize", status: "partial", elapsedMs: {}, waitingReasons: [], updatedAt: 1, completedAt: 1, failures: [], notified: [] };
    assert.equal(projectMaintenanceActivity(record)?.status, "partial");
    assert.equal(metadata.writes.some(file => file.startsWith("wiki/")), false);
  } finally { metadata.release(); }

  for (const failure of ["save", "io", "same-message", "invalid-fields", "readback", "changed", "cancelled"] as const) {
    const item = await oldCheckpoint(path.join(root, `fatal-${failure}`));
    try {
      item.setFault(failure);
      const result = await item.resume();
      assert.equal(result.status, "failed", failure);
      assert.equal(isP1Open(item.record()), true, `${failure} cannot release the original batch`);
      assert.equal(hasP1PartialSettlement(item.record()), false);
      const open = await readOpenMaintenanceSelection(item.vault, { conversationId: "synthetic-conversation", branchProductRunIds: ["original-run"] });
      assert.equal(open?.recordId, item.record().recordId);
      assert.equal(await readOpenMaintenanceSelection(item.vault, { conversationId: "other", branchProductRunIds: ["original-run"] }), null);
      assert.equal(await readOpenMaintenanceSelection(item.vault, { conversationId: "synthetic-conversation", branchProductRunIds: ["original"] }), null);
    } finally { item.release(); }
  }
  for (const markdown of ["---\nx: 1\nx: 2\n---\nbody", "---\n- one\n---\nbody", "---\nx: !custom value\n---\nbody", "---\nmissing end"]) {
    assert.throws(() => patchMaintenanceSourceFrontmatter(markdown, { status: "已提炼", summary: "Synthetic", targetPaths: [] }), SourceFrontmatterUnsafeError);
  }
  assert.throws(() => patchMaintenanceSourceFrontmatter("body", { status: "wrong", summary: "Synthetic", targetPaths: [] } as never), error => error instanceof Error && !(error instanceof SourceFrontmatterUnsafeError));
  console.log("R-DA4AE1 maintenance: PASS (old 20/14/1 recovery, six failures, narrow manual retry, full-file auto deferral, fatal isolation, durable ownership)");
}

async function oldCheckpoint(vault: string) {
  await fs.mkdir(vault, { recursive: true });
  const privateRoot = path.join(vault, ".obsidian/plugins/echoink/knowledge");
  const bindings = emptyKnowledgeFolderBindings();
  for (const role of ["raw", "inbox", "wiki"] as const) { Object.assign(bindings.roles[role], { enabled: true, readPaths: [role], writePath: role }); await fs.mkdir(path.join(vault, role), { recursive: true }); }
  const release = registerKnowledgeFolderBindings(vault, () => bindings);
  registerKnowledgePrivateRoot(vault, privateRoot);
  const paths = Array.from({ length: 20 }, (_, index) => `raw/source-${String(index).padStart(2, "0")}.md`);
  const write = async (file: string, text: string) => { await fs.mkdir(path.dirname(path.join(vault, file)), { recursive: true }); await fs.writeFile(path.join(vault, file), text); };
  const read = (file: string) => fs.readFile(path.join(vault, file), "utf8");
  for (const [index, file] of paths.entries()) await write(file, index >= 1 && index <= 6 ? unsafe(index) : body(index));
  const pageSources = paths.filter((_, index) => index !== 6).slice(0, 14);
  const writingPlan = pageSources.map((sourcePath, index) => ({ id: `page-${index}`, targetPath: `wiki/page-${index}.md`, sourcePaths: [sourcePath], expectedTarget: { kind: "missing" as const } }));
  const drafts: NonNullable<KnowledgeMaintenanceRecord["p1"]>["drafts"] = {};
  const committedPages: NonNullable<KnowledgeMaintenanceRecord["p1"]>["committedPages"] = {};
  for (const item of writingPlan) { const content = `# Synthetic page ${item.id}\nThis already verified page stays intact.\n`; await write(item.targetPath, content); drafts[item.id] = { content, toolCallId: item.id }; committedPages[item.id] = { path: item.targetPath, contentRevision: revision(content) }; }
  const sourceFingerprints = Object.fromEntries(await Promise.all(paths.map(async file => [file, rawDigestFingerprint(file, Buffer.from(await read(file)))])));
  await write(paths[0], patchMaintenanceSourceFrontmatter(await read(paths[0]), { status: "已提炼", summary: "Synthetic", targetPaths: [writingPlan[0].targetPath] }));
  let saved: KnowledgeMaintenanceRecord = { schemaVersion: 1, recordId: `maintenance-${"d".repeat(32)}`, runId: "original-run:original-tool", originConversationId: "synthetic-conversation", at: 1, date: "2026-11-01", summary: "Synthetic interrupted old batch", result: createKnowledgeMaintenanceResultEnvelope({ status: "partial", issues: [{ code: "p1_pending", message: "Synthetic pending" }] }),
    sources: paths.map((file, index) => ({ path: file, fingerprint: sourceFingerprints[file], status: index === 0 ? "processed" : "failed", evidencePaths: [] })),
    p1: { version: 1, phase: "finalize", folderBindingsRevision: bindings.revision, sourceFingerprints, decompositions: paths.map(file => ({ sourcePath: file, summary: "Synthetic summary", units: pageSources.includes(file) ? ["Legacy synthetic unit"] : [] })), writingPlan, drafts, committedPages, finalizedSources: [paths[0]] } };
  const store = new FilePhase3MaintenanceStateStore({ storageRootPath: privateRoot, vaultId: "r-da4ae1" });
  await store.saveP1Record(saved);
  const writes: string[] = [];
  let fault: string | undefined;
  const controller = new AbortController();
  const host: MaintenanceP1Host = { vaultRootPath: vault, records: async () => [structuredClone(saved)], processedSources: async () => [],
    save: async record => { if (fault === "save") throw new Error("Synthetic state save failure"); await store.saveP1Record(record); saved = structuredClone(record); },
    read, recoverBeforeRebase: async () => {}, committedPageReceipt: async () => null, sourcePath: file => file, targetPath: async file => file,
    candidates: async () => [], planMaps: async () => [], now: () => 1, date: () => "2026-11-01",
    commit: async (_input, item, content) => {
      if (fault === "io") throw new SourceFrontmatterUnsafeError("Synthetic I/O error with a format-error type must still abort outside patching");
      if (fault === "same-message") throw new Error("Source frontmatter must be an unambiguous YAML mapping.");
      writes.push(item.targetPath); await write(item.targetPath, fault === "readback" ? content + "Unexpected edit" : content); return true;
    }
  };
  const workflow = new MaintenanceP1Workflow(host);
  return { vault, privateRoot, paths, read, write, release, writes, record: () => structuredClone(saved),
    setFault: (value: string) => { fault = value; },
    updateResult: async (result: KnowledgeMaintenanceRecord["result"]) => { saved.result = result; await store.saveP1Record(saved); },
    resume: async (selected = paths, conversationId = "synthetic-conversation") => {
      if (fault === "invalid-fields") { saved.p1!.decompositions[1] = { ...saved.p1!.decompositions[1], summary: 123 as never }; await store.saveP1Record(saved); }
      if (fault === "changed") await write(paths[19], body(19) + "Changed source");
      if (fault === "cancelled") host.current = async () => { controller.abort(); };
      return workflow.execute({ vaultId: "r-da4ae1", conversationId, piSessionId: "session", productRunId: "retry-run", toolCallId: "retry-tool", mode: "maintain", request: "continue", sourcePaths: selected, folderBindingsRevision: bindings.revision, signal: controller.signal, p1: { stage: "resume" } } as PiKnowledgeMaintenanceToolInput);
    }
  };
}
