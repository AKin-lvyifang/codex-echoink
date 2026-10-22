import { canonicalRawMarkdownForDigest, rawDigestFingerprint, writeRawDigestRegistry } from "../knowledge-base/raw-digest";
import { createPiKnowledgeMaintenanceToolSecurity } from "../harness/pi-native/pi-knowledge-maintenance-tool";
import { EchoInkVaultToolEgressPolicy } from "../harness/pi-native/vault-tool-result-safety";
import type { PiKnowledgeMaintenanceToolResult } from "../harness/pi-native/contracts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { nativeJournalFixture } from "./native-journal-fixture";
import { ObsidianVaultDomainAdapter } from "../plugin/obsidian-vault-domain-adapter";
import { VaultDomainService } from "../harness/pi-native/vault-domain-service";
import { FilePhase3MaintenanceStateStore, ProductionPiKnowledgeMaintenanceToolPort, readPrivateMaintenanceRecords } from "../plugin/pi-knowledge-maintenance-production";
import { emptyKnowledgeFolderBindings, registerKnowledgeFolderBindings } from "../knowledge-base/root-paths";
import { createMaintenanceSectionSnapshot } from "../knowledge-base/maintenance-section-patch";
import { MAINTENANCE_KNOWLEDGE_TYPES } from "../knowledge-base/maintenance-knowledge-types";
import { applyMaintenanceRelatedEntries } from "../knowledge-base/maintenance-p2-planning";
import { isMaintenanceSourceProcessed } from "../knowledge-base/maintenance-source-state";
import { releaseMaintenancePages } from "../knowledge-base/maintenance-page-lock";
import { createKnowledgeMaintenanceResultEnvelope } from "../knowledge-base/knowledge-maintenance-result";
import { appendMaintenanceAliases } from "../knowledge-base/maintenance-page-metadata";
import { parseDocument } from "yaml";
import { assertMaintenanceShortTitle, MAINTENANCE_SHORT_TITLE_POLICY } from "../knowledge-base/maintenance-title";
import { maintenanceVisibleCopyIsSafe } from "../knowledge-base/maintenance-user-copy";
import type { MaintenanceKnowledgeType, MaintenanceKnowledgeUnit } from "../knowledge-base/maintenance-p2-contract";
import type { MaintenanceP1Action, MaintenanceWritingItem } from "../knowledge-base/maintenance-p1-contract";
const revision = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`;
const page = (title: string, type: MaintenanceKnowledgeType = "概念", aliases: string[] = []) => `---\n类型: ${type}\naliases: ${JSON.stringify(aliases)}\n---\n# ${title}\n${title}的独立定义与适用范围。\n\n## 自定义知识正文\n这里说明${title}的证据、边界及可复用要点。\n\n## 相关条目\n\n`;

export async function runKnowledgeMaintainP2Tests(root: string): Promise<void> {
  const report: unknown[] = [];
  assert.doesNotMatch(applyMaintenanceRelatedEntries(page("占位关系") + "暂无\n", []), /相关条目|暂无/u);
  assert.match(applyMaintenanceRelatedEntries("# 旧页\n\n## 相关条目\n用户手写。\n", [], "existing"), /用户手写/u);
  async function scenario(name: string, run: (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>) {
    const f = await fixture(path.join(root, name));
    try { await run(f); report.push({ name, passed: true, vault: f.vault }); }
    finally { for (const record of await readPrivateMaintenanceRecords(f.privateRoot)) releaseMaintenancePages(record.recordId); f.release(); }
  }
  for (const aliases of ["aliases: ['First', Old] # keep comment\n", "aliases: [First, ] # trailing comma\n", "aliases:\n  - 'First' # first comment\n  - Old # old comment\n", "aliases: [\n  'First', # first comment\n  Old # old comment\n] # outer comment\n"]) {
    const before = `\uFEFF---\r\n${aliases.replace(/\n/gu,"\r\n")}custom: 0021 # keep\r\n---\r\n# 用户标题\r\n\r\n正文。  \r\n\r\n\r\n手写段落。\r\n`;
    const result = appendMaintenanceAliases(before,["First","Old","NEW","新别名"]);
    const yaml = result.slice(6,result.indexOf("---",6));
    const current = parseDocument(yaml).toJS().aliases as string[];
    assert.deepEqual(current,["First","Old","NEW","新别名"]);
    assert.ok(result.includes("# keep comment") === before.includes("# keep comment"));
    for (const comment of ["# first comment","# old comment","# outer comment","# trailing comma"]) if (before.includes(comment)) assert.ok(result.includes(comment));
    assert.equal(result.slice(result.indexOf("custom:")),before.slice(before.indexOf("custom:")),"other properties and handwritten body stay verbatim");
    assert.equal(appendMaintenanceAliases(result,["First","Old","NEW","新别名"]),result);
  }
  assert.throws(()=>appendMaintenanceAliases("---\naliases:\n  - >-\n    complex\ncustom: keep\n---\n# 标题\n",["new"]),/复杂标量/u);
  for (const title of ["SQLite", "阿波罗13号", "SQLite事务边界", "适用场景", "有限理性与决策"]) assert.doesNotThrow(() => assertMaintenanceShortTitle(title, "fixture"));
  for (const [index, title] of ["SQLite 的适用场景与限制", "阿波罗13号：成功的失败", "Apollo 13: A successful failure"].entries()) await scenario(`short-name-decomposition-before-checkpoint-${index}`, async f => {
    const source = "raw/name.md"; await f.write(source, "# 原文\n程序只限制明确的文章式标题。\n");
    const unit = await f.unit("same-id", source, title), raw = await f.read(source);
    const rejected = await f.decompose([source], [unit]); assert.equal(rejected.status, "failed"); assert.match(rejected.message, /改短名.*导语.*ID可沿用/u);
    assert.equal((await readPrivateMaintenanceRecords(f.privateRoot)).length, 0, "invalid new units never enter the immutable decomposition checkpoint");
    assert.equal(await f.read(source), raw); assert.ok(rejected.userReceipt); assert.ok(maintenanceVisibleCopyIsSafe(rejected.userReceipt!.text));
    f.ok(await f.decompose([source], [{ ...unit, title: index === 0 ? "SQLite" : "阿波罗13号" }]));
    assert.equal((await readPrivateMaintenanceRecords(f.privateRoot))[0].p1!.decompositions[0].units.length, 1, "same unit ID can be corrected before its first checkpoint");
  });
  await scenario("short-name-plan-before-lock-and-frozen-history", async f => {
    const source = "raw/name.md"; await f.write(source, "# 原文\n保留原有历史页面名，不迁移重命名。\n");
    const unit = await f.unit("apollo", source, "阿波罗13号"); f.ok(await f.decompose([source], [unit]));
    for (const title of ["SQLite 的适用场景与限制", "阿波罗13号：成功的失败"]) {
      const rejected = await f.call({ stage: "plan", writingPlan: [f.item("one", `wiki/${title}.md`, [source], [unit.id])] }, [source]);
      assert.equal(rejected.status, "failed"); assert.equal((await readPrivateMaintenanceRecords(f.privateRoot))[0].p1!.phase, "plan");
    }
    f.ok(await f.call({ stage: "plan", writingPlan: [f.item("one", "wiki/阿波罗13号.md", [source], [unit.id])] }, [source]));
    const state = new FilePhase3MaintenanceStateStore({ storageRootPath: f.privateRoot, vaultId: "p2-vault" });
    const frozen = (await readPrivateMaintenanceRecords(f.privateRoot))[0]; assert.equal(frozen.p1!.p2!.titlePolicy, MAINTENANCE_SHORT_TITLE_POLICY);
    frozen.p1!.writingPlan[0].targetPath = "wiki/阿波罗13号：成功的失败.md";
    await state.saveP1Record(frozen);
    const writeRejected = await f.call({ stage: "write", pageId: "one", content: page("阿波罗13号：成功的失败") }, [source]); assert.equal(writeRejected.status, "failed"); assert.match(writeRejected.message, /改短名/u);
    assert.equal(await fs.stat(path.join(f.vault, frozen.p1!.writingPlan[0].targetPath)).catch(() => null), null, "new-policy write gate also rejects before producing a draft/WAL");
    // Represent a plan frozen by the older version, without retroactively migrating it.
    delete frozen.p1!.p2!.titlePolicy; frozen.p1!.p2!.finalization = [];
    frozen.p1!.writingPlan[0].targetPath = "wiki/阿波罗13号：成功的失败.md";
    (frozen.p1!.decompositions[0].units[0] as MaintenanceKnowledgeUnit).title = "阿波罗13号：成功的失败";
    await state.saveP1Record(frozen); await f.restart();
    f.ok(await f.call({ stage: "write", pageId: "one", content: page("阿波罗13号：成功的失败") }, [source]));
    assert.match(await f.read("wiki/阿波罗13号：成功的失败.md"), /# 阿波罗13号：成功的失败/u);
    assert.equal(await fs.stat(path.join(f.vault, "wiki/阿波罗13号.md")).catch(() => null), null);
  });
  await scenario("old-decomposition-not-retroactively-shortened-by-new-source", async f => {
    const old = "raw/old.md", added = "raw/added.md"; await f.write(old, "# 原有来源\n旧检查点须保持。\n"); await f.write(added, "# 新来源\n新增知识使用短名。\n");
    const first = await f.unit("old-id", old, "SQLite"), next = await f.unit("new-id", added, "阿波罗13号");
    f.ok(await f.call({ stage: "decompose", decompositions: [{ sourcePath: old, summary: "原有摘要", units: [first] }] }, [old, added]));
    const stored = (await readPrivateMaintenanceRecords(f.privateRoot))[0]; (stored.p1!.decompositions[0].units[0] as MaintenanceKnowledgeUnit).title = "SQLite 的适用场景与限制";
    const state = new FilePhase3MaintenanceStateStore({ storageRootPath: f.privateRoot, vaultId: "p2-vault" }); await state.saveP1Record(stored); await f.restart();
    f.ok(await f.call({ stage: "decompose", decompositions: [{ sourcePath: added, summary: "新增摘要", units: [next] }] }, [old, added]));
    const after = (await readPrivateMaintenanceRecords(f.privateRoot))[0]; assert.equal(after.p1!.phase, "plan"); assert.equal((after.p1!.decompositions[0].units[0] as MaintenanceKnowledgeUnit).title, "SQLite 的适用场景与限制");
  });
  await scenario("changed-target-fresh-read-new-sections-new-draft-cold-resume", async f => {
    const source = "raw/change.md", done = "wiki/已保存知识.md", target = "wiki/间隔复习.md";
    const protectedTail = "## 关键原句\r\n用户自己收藏的关键原句。  \r\n\r\n";
    const before = "---\r\naliases: []\r\ncustom: 0021 # keep\r\n---\r\n# 间隔复习\r\n\r\n原有导语。\r\n\r\n## 方法\r\n原方法。\r\n\r\n## 用户区域\r\n手写不动。  \r\n\r\n" + protectedTail;
    await f.write(source, "# 复习来源\n根据掌握情况安排下一次复习。\n"); await f.write(target, before);
    const units = [await f.unit("done", source, "已保存知识"), await f.unit("spaced", source, "间隔复习")];
    f.ok(await f.decompose([source], units)); const observed = await f.observe(target);
    f.ok(await f.call({ stage: "plan", writingPlan: [f.item("done", done, [source], ["done"]), f.item("spaced", target, [source], ["spaced"], observed)] }, [source]));
    f.ok(await f.call({ stage: "write", pageId: "done", content: page("已保存知识") }, [source]));
    const doneBytes = await f.read(done), doneStat = await fs.stat(path.join(f.vault, done));
    const listed = await f.call({ stage: "sections", targetPath: target }, [source]); f.ok(listed);
    const oldRegion = JSON.parse(listed.message).snapshot.regions.find((region: { title: string }) => region.title === "方法");
    f.fail(target);
    const initial = await f.call({ stage: "write", pageId: "spaced", sectionPatches: [{ regionId: oldRegion.id, operation: "append", content: "旧稿补充。" }] }, [source]); assert.equal(initial.status, "failed");
    f.fail(null);
    const oldDraft = (await readPrivateMaintenanceRecords(f.privateRoot))[0].p1!.drafts.spaced;
    const edited = before.replace("手写不动。", "用户在并发期间新增的手写决定。手写不动。"); await f.write(target, edited);
    const conflict = await f.call({ stage: "resume" }, [source]); assert.equal(conflict.status, "failed"); assert.match(conflict.message, /并发编辑冲突/u); assert.equal(await f.read(target), edited);
    assert.ok(conflict.userReceipt); assert.match(conflict.userReceipt!.text, /修改|改过/u); assert.ok(maintenanceVisibleCopyIsSafe(conflict.userReceipt!.text));
    assert.deepEqual(JSON.parse(conflict.message.split("\n").find(line => line.startsWith("{"))!).userReceipt, conflict.userReceipt, "model failures receive the same trusted counts as the UI");
    await f.restart();
    const unread = await f.call({ stage: "sections", targetPath: target }, [source]); assert.equal(unread.status, "failed"); assert.match(unread.message, /先完整note_read/u);
    assert.equal((await readPrivateMaintenanceRecords(f.privateRoot))[0].p1!.drafts.spaced.content, oldDraft.content);
    await f.observe(target);
    const refreshed = await f.call({ stage: "sections", targetPath: target }, [source]); f.ok(refreshed); assert.ok(refreshed.userReceipt);
    const fresh = JSON.parse(refreshed.message); assert.equal(fresh.draftDiscarded, true); assert.notEqual(fresh.snapshot.revision, oldRegion.id.split(":").slice(0, 2).join(":"));
    const saved = (await readPrivateMaintenanceRecords(f.privateRoot))[0]; assert.equal(saved.p1!.drafts.spaced, undefined); assert.equal(saved.p1!.draftGenerations!.spaced, 1);
    assert.deepEqual(saved.p1!.writingPlan[1].expectedTarget, { kind: "file", contentRevision: revision(edited) });
    const stale = await f.call({ stage: "write", pageId: "spaced", sectionPatches: [{ regionId: oldRegion.id, operation: "append", content: "不能复用旧编号。" }] }, [source]); assert.equal(stale.status, "failed"); assert.equal(await f.read(target), edited);
    await f.restart();
    const newRegion = fresh.snapshot.regions.find((region: { title: string }) => region.title === "方法");
    const completed = await f.call({ stage: "write", pageId: "spaced", sectionPatches: [{ regionId: newRegion.id, operation: "append", content: "按最新手写决定补充的新知识。" }] }, [source]); f.ok(completed);
    const final = await f.read(target); assert.ok(final.includes("用户在并发期间新增的手写决定。手写不动。")); assert.ok(final.includes(protectedTail)); assert.ok(final.includes("custom: 0021 # keep\r\n")); assert.ok(final.includes("按最新手写决定补充的新知识。")); assert.ok(!final.includes("旧稿补充。"));
    const finalRecord = (await readPrivateMaintenanceRecords(f.privateRoot))[0]; assert.notEqual(finalRecord.p1!.drafts.spaced.toolCallId, oldDraft.toolCallId); assert.match(finalRecord.p1!.drafts.spaced.toolCallId, /:r1$/u);
    assert.equal(await f.read(done), doneBytes); assert.equal((await fs.stat(path.join(f.vault, done))).mtimeMs, doneStat.mtimeMs); assert.equal(f.writes.filter(item => item === done).length, 1);
    assert.deepEqual(completed.userReceipt?.pageCounts, { written: 2, created: 1, updated: 1 }); assert.ok(maintenanceVisibleCopyIsSafe(completed.userReceipt!.text));
    assert.deepEqual(JSON.parse(completed.message.split("\n").find(line => line.startsWith("{"))!).userReceipt, completed.userReceipt, "model completion JSON carries the exact trusted page breakdown and wording");
  });
  for (const recovery of ["sections", "resume"] as const) await scenario(`completed-wal-parent-checkpoint-lost-user-edit-${recovery}`, async f => {
    const source = "raw/checkpoint.md", target = "wiki/间隔复习.md";
    await f.write(source, "# 复习来源\n来源原句保持可复核。\n");
    if (recovery === "sections") await f.write(target, page("间隔复习"));
    const unit = await f.unit("spaced", source, "间隔复习"); f.ok(await f.decompose([source], [unit]));
    const baseline = recovery === "sections" ? await f.observe(target) : undefined;
    f.ok(await f.call({ stage: "plan", writingPlan: [f.item("one", target, [source], [unit.id], baseline)] }, [source]));
    const initialParent = (await readPrivateMaintenanceRecords(f.privateRoot))[0];
    const activity = (f.port as unknown as { activity: { save(record: typeof initialParent): Promise<void> } }).activity;
    const save = activity.save.bind(activity); let crashed = false;
    activity.save = async record => {
      if (!crashed && record.p1?.committedPages.one) { crashed = true; throw new Error("Synthetic crash after completed WAL before parent page checkpoint"); }
      await save(record);
    };
    let write: MaintenanceP1Action;
    if (baseline !== undefined) {
      const listed = await f.call({ stage: "sections", targetPath: target }, [source]); f.ok(listed);
      const region = JSON.parse(listed.message).snapshot.regions.find((item: { title: string }) => item.title === "自定义知识正文");
      write = { stage: "write", pageId: "one", sectionPatches: [{ regionId: region.id, operation: "append", content: "已确认写入的知识。" }] };
    } else write = { stage: "write", pageId: "one", content: page("间隔复习") };
    const failed = await f.call(write, [source]); assert.equal(failed.status, "failed"); assert.match(failed.message, /Synthetic crash after completed WAL/u); assert.equal(crashed, true);
    const persisted = (await readPrivateMaintenanceRecords(f.privateRoot))[0];
    assert.equal(persisted.p1!.committedPages.one, undefined, "the parent checkpoint was genuinely never persisted");
    const draft = structuredClone(persisted.p1!.drafts.one), written = await f.read(target);
    const store = new FilePhase3MaintenanceStateStore({ storageRootPath: f.privateRoot, vaultId: "p2-vault" });
    const wal = (await store.listRecoverableWals("p2-vault")).find(item => item.authorization.contract.toolCallId === draft.toolCallId)!;
    assert.equal(wal.status, "completed"); assert.equal(wal.preview.bookkeeping?.p1RecordId, persisted.recordId);
    assert.equal(wal.actions[0].status, "completed"); assert.equal(wal.actions[0].domainStatus, "completed"); assert.equal(wal.actions[0].action.content, written);
    assert.equal(f.writes.filter(item => item === target).length, 1);
    await f.restart();
    const edited = written + "\n## 用户后续修改\n这段是在成功回读后手写的，恢复时不能重写。  \n";
    await f.write(target, edited); const stat = await fs.stat(path.join(f.vault, target)); await f.observe(target);
    const recovered = await f.call(recovery === "sections" ? { stage: "sections", targetPath: target } : { stage: "resume" }, [source]); f.ok(recovered);
    const checkpoint = (await readPrivateMaintenanceRecords(f.privateRoot))[0];
    assert.deepEqual(checkpoint.p1!.drafts.one, draft, "old draft and original WAL identity remain immutable after successful historical readback");
    assert.equal(checkpoint.p1!.draftGenerations?.one, undefined, "a completed page must not receive a replacement identity");
    assert.deepEqual(checkpoint.p1!.committedPages.one, { path: target, contentRevision: revision(written) }, "parent completion binds the durable historical readback, not later user bytes");
    f.ok(await f.call({ stage: "resume" }, [source]));
    assert.equal(await f.read(target), edited); assert.equal((await fs.stat(path.join(f.vault, target))).mtimeMs, stat.mtimeMs);
    assert.equal(f.writes.filter(item => item === target).length, 1, "completed WAL recovery only checkpoints/finalizes, never writes the target again");
    assert.equal(isMaintenanceSourceProcessed(await f.read(source)), true);
  });
  await scenario("missing-target-user-created-rebases-as-update", async f => {
    const source = "raw/new.md", target = "wiki/SQLite.md"; await f.write(source, "# SQLite原文\nSQLite把引擎嵌入进程。\n");
    const unit = await f.unit("sqlite", source, "SQLite"); f.ok(await f.decompose([source], [unit])); f.ok(await f.call({ stage: "plan", writingPlan: [f.item("sqlite", target, [source], [unit.id])] }, [source]));
    const handmade = "# SQLite\n\n用户先创建这页。\n\n## 用户区域\n并发创建的手写内容。\n"; await f.write(target, handmade);
    const conflict = await f.call({ stage: "write", pageId: "sqlite", content: page("SQLite") }, [source]); assert.equal(conflict.status, "failed"); assert.equal(await f.read(target), handmade);
    await f.observe(target); const listed = await f.call({ stage: "sections", targetPath: target }, [source]); f.ok(listed);
    const intro = JSON.parse(listed.message).snapshot.regions.find((region: { kind: string }) => region.kind === "introduction");
    const result = await f.call({ stage: "write", pageId: "sqlite", sectionPatches: [{ regionId: intro.id, operation: "append", content: "依据来源补充SQLite定义。" }] }, [source]); f.ok(result);
    assert.ok((await f.read(target)).includes("并发创建的手写内容。")); assert.deepEqual(result.userReceipt?.pageCounts, { written: 1, created: 0, updated: 1 });
  });
  await scenario("rebase-new-section-created-by-user-uses-real-region", async f => {
    const source = "raw/section.md", target = "wiki/间隔复习.md", before = page("间隔复习");
    await f.write(source, "# 复习来源\n根据掌握情况安排复习。\n"); await f.write(target, before);
    const unit = await f.unit("spaced", source, "间隔复习"); f.ok(await f.decompose([source], [unit])); const seen = await f.observe(target);
    f.ok(await f.call({ stage: "plan", writingPlan: [{ ...f.item("spaced", target, [source], [unit.id], seen), newSections: ["应用步骤"] }] }, [source]));
    const initial = await f.call({ stage: "sections", targetPath: target }, [source]); f.ok(initial);
    const oldRegion = JSON.parse(initial.message).snapshot.regions.find((region: { kind: string }) => region.kind === "new-section");
    f.fail(target); assert.equal((await f.call({ stage: "write", pageId: "spaced", sectionPatches: [{ regionId: oldRegion.id, operation: "append", content: "旧稿不能重放。" }] }, [source])).status, "failed"); f.fail(null);
    const handwritten = "## 应用步骤\n用户并发新增同名小节，保留本段。  \n\n";
    await f.write(target, before.replace("## 相关条目", `${handwritten}## 相关条目`)); await f.observe(target);
    const refreshed = await f.call({ stage: "sections", targetPath: target }, [source]); f.ok(refreshed);
    const snapshot = JSON.parse(refreshed.message).snapshot, real = snapshot.regions.find((region: { title: string }) => region.title === "应用步骤");
    assert.equal(real.kind, "section"); assert.equal(snapshot.regions.some((region: { kind: string }) => region.kind === "new-section"), false);
    assert.deepEqual((await readPrivateMaintenanceRecords(f.privateRoot))[0].p1!.writingPlan[0].newSections, []);
    await f.restart(); f.ok(await f.call({ stage: "write", pageId: "spaced", sectionPatches: [{ regionId: real.id, operation: "append", content: "程序依据新原文补充。" }] }, [source]));
    const after = await f.read(target); assert.equal(after.split("## 应用步骤").length, 2); assert.ok(after.includes("用户并发新增同名小节，保留本段。  \n")); assert.ok(after.includes("程序依据新原文补充。")); assert.ok(!after.includes("旧稿不能重放。"));
  });
  await scenario("unresolved-wal-blocks-rebase-and-cold-recovery", async f => {
    const source = "raw/uncertain.md", target = "wiki/间隔复习.md", before = page("间隔复习");
    await f.write(source, "# 原文\n写入结果不确定时不能直接换稿。\n"); await f.write(target, before);
    const unit = await f.unit("uncertain", source, "间隔复习"); f.ok(await f.decompose([source], [unit])); const seen = await f.observe(target);
    f.ok(await f.call({ stage: "plan", writingPlan: [f.item("one", target, [source], [unit.id], seen)] }, [source]));
    const listed = await f.call({ stage: "sections", targetPath: target }, [source]); f.ok(listed);
    const region = JSON.parse(listed.message).snapshot.regions.find((item: { title: string }) => item.title === "自定义知识正文");
    f.fail(target); const failed = await f.call({ stage: "write", pageId: "one", sectionPatches: [{ regionId: region.id, operation: "append", content: "旧稿正文。" }] }, [source]); assert.equal(failed.status, "failed"); f.fail(null);
    const store = new FilePhase3MaintenanceStateStore({ storageRootPath: f.privateRoot, vaultId: "p2-vault" });
    const wal = (await store.listRecoverableWals("p2-vault")).find(item => item.actions.some(action => action.action.targetPath === target))!;
    // Fault fixture: an unresolved write is durable, rather than silently assumed failed.
    await store.saveWal({ ...wal, status: "blocked", sequence: wal.sequence + 1, error: "Synthetic uncertain write awaiting verification", actions: wal.actions.map(action => ({ ...action, status: "uncertain", error: "Synthetic uncertain write" })) }, wal.sequence);
    const edited = before + "\n用户在未知写入后编辑。\n"; await f.write(target, edited); await f.observe(target);
    const oldDraft = (await readPrivateMaintenanceRecords(f.privateRoot))[0].p1!.drafts.one;
    const blocked = await f.call({ stage: "sections", targetPath: target }, [source]); assert.equal(blocked.status, "failed"); assert.equal(blocked.errorCode, "recovery_blocked");
    assert.equal(await f.read(target), edited); assert.deepEqual((await readPrivateMaintenanceRecords(f.privateRoot))[0].p1!.drafts.one, oldDraft);
    await assert.rejects(f.restart(), /Synthetic uncertain write/u); assert.equal(await f.read(target), edited);
  });
  await scenario("controlled-new-h2-aliases-cold-resume-and-real-map-title",async f=>{
    const target="wiki/旧存储名.md", source="raw/spaced.md";
    const before="\uFEFF---\r\naliases: ['Spaced repetition'] # keep comment\r\n类型: 概念\r\n领域: 学习方法\r\ncustom: 0021 # preserve\r\n---\r\n# 间隔复习\r\n\r\n旧导语。\r\n\r\n## 用户手写\r\n保留这行。  \r\n\r\n\r\n用户多空行。\r\n\r\n## 来源\r\n用户手写来源说明。\r\n";
    await f.write(target,before);await f.write(source,"# 复习原文\n先按学习表现调整下一次复习间隔。\n");
    const unit=await f.unit("spaced",source,"间隔复习");unit.domain="学习方法";unit.aliases=["复习间隔","Spaced repetition"];
    f.ok(await f.decompose([source],[unit]));const observed=await f.observe(target);
    const item={...f.item("spaced",target,[source],[unit.id],observed),newSections:["应用步骤"]};
    f.ok(await f.call({stage:"plan",writingPlan:[item]},[source]));
    const listed=await f.call({stage:"sections",targetPath:target},[source]);f.ok(listed);
    const snapshot=JSON.parse(listed.message).snapshot;const region=snapshot.regions.find((region:{kind:string})=>region.kind==="new-section");assert.ok(region);
    f.fail(target);const failed=await f.call({stage:"write",pageId:"spaced",sectionPatches:[{regionId:region.id,operation:"append",content:"\n\n先判断掌握情况。\n\n\n再调整间隔。\n"}]},[source]);assert.equal(failed.status,"failed");assert.equal(await f.read(target),before);
    f.fail(null);await f.restart();f.ok(await f.call({stage:"resume"},[source]));
    const after=await f.read(target);assert.match(after,/## 应用步骤\r\n\r\n先判断掌握情况。\r\n\r\n再调整间隔。\r\n\r\n## 来源/u);
    assert.ok(after.includes("## 用户手写\r\n保留这行。  \r\n\r\n\r\n用户多空行。\r\n\r\n"));assert.ok(after.includes("# 间隔复习\r\n"));assert.ok(after.includes("custom: 0021 # preserve\r\n"));assert.ok(after.includes("aliases: ['Spaced repetition', '复习间隔'] # keep comment"));
    const map=await f.read("wiki/学习方法索引.md");assert.ok(map.includes(`[间隔复习](<${encodeURIComponent("旧存储名.md")}>)`));assert.ok(!map.includes("[旧存储名]("));
    const beforeRepeat=after;f.ok(await f.call({stage:"resume"},[source]));assert.equal(await f.read(target),beforeRepeat);assert.equal(f.writes.filter(path=>path===target).length,1);
  });
  await scenario("new-page-final-basename-h1-and-verified-aliases",async f=>{
    const source="raw/sqlite.md",target="wiki/SQLite.md",title="SQLite：理解嵌入式数据库的事务边界";
    await f.write(source,"# SQLite原文\nSQLite把数据库引擎嵌入应用进程。\n");const unit=await f.unit("sqlite",source,"SQLite","工具 / 产品");unit.aliases=["SQLite3"];unit.typePendingConfirmation=true;
    f.ok(await f.decompose([source],[unit]));f.ok(await f.call({stage:"plan",writingPlan:[f.item("sqlite",target,[source],[unit.id])]},[source]));
    f.ok(await f.call({stage:"write",pageId:"sqlite",content:page(title,"工具 / 产品").replace("aliases: []\n","")},[source]));
    const after=await f.read(target);assert.match(after,/# SQLite\n/u);assert.ok(after.includes(title),"descriptive article title remains in the lead");assert.ok(after.includes("SQLite3"));assert.ok(after.includes("类型待确认: true"),"a missing field is supplied from the verified pending unit in the production write chain");const map=await f.read("wiki/工程工具索引.md");assert.ok(map.includes("[SQLite](<SQLite.md>)"));assert.ok(!map.includes(`[${title}](`));
  });
  await scenario("unselected-handwritten-eof-survives-new-managed-sections",async f=>{
    const source="raw/eof.md",target="wiki/保留留白.md",related="wiki/关联页.md";
    const suffix="## 手写末尾\r\n用户行尾空格。  \r\n\r\n\r\n\r\n";
    const before="---\r\naliases: [Old] # preserve\r\ncustom: keep\r\n---\r\n# 保留留白\r\n\r\n导语。\r\n\r\n## 可补充\r\n旧事实。\r\n\r\n"+suffix;
    await f.write(source,"# 留白原文\n新增事实应放到对应小节。\n");await f.write(target,before);await f.write(related,"# 关联页\n明确相关的已有条目。\n");
    const unit=await f.unit("eof",source,"保留留白");unit.aliases=["New"];
    f.ok(await f.decompose([source],[unit]));const current=await f.observe(target);await f.observe(related);
    const item=f.item("eof",target,[source],[unit.id],current);item.knowledge!.related=[{targetPath:related,reason:"已有条目提供事实的使用场景"}];
    f.ok(await f.call({stage:"plan",writingPlan:[item]},[source]));
    const listed=await f.call({stage:"sections",targetPath:target},[source]);const snapshot=JSON.parse(listed.message).snapshot;
    const region=snapshot.regions.find((region:{title:string})=>region.title==="可补充");
    f.ok(await f.call({stage:"write",pageId:"eof",sectionPatches:[{regionId:region.id,operation:"append",content:"新事实。"}]},[source]));
    const after=await f.read(target);assert.ok(after.includes(suffix+"## 相关条目"),"adding related/sources never trims the unselected handwritten EOF suffix");assert.ok(after.includes("## 来源\r\n\r\n"));assert.ok(after.includes("aliases: [Old, New] # preserve"));assert.ok(after.includes("custom: keep\r\n"));
    const once=after;f.ok(await f.call({stage:"resume"},[source]));assert.equal(await f.read(target),once);
  });
  await scenario("readonly-noop-uses-shared-source-state-precedence", async f => {
    const cases: { id: string; property?: string; registry?: boolean; privateStatus?: "processed" | "failed"; stale?: boolean; setting?: boolean; complete: boolean }[] = [
      { id: "new-complete", property: "已提炼", privateStatus: "failed", stale: true, complete: true },
      { id: "registry-current", registry: true, complete: true },
      { id: "private-current", privateStatus: "processed", complete: true },
      { id: "setting-current", setting: true, complete: true },
      { id: "new-pending", property: "未提炼", registry: true, complete: false },
      { id: "new-null", property: "null", registry: true, complete: false },
      { id: "new-invalid", property: "unknown", registry: true, complete: false },
      { id: "private-stale-over-registry", registry: true, privateStatus: "processed", stale: true, complete: false },
      { id: "private-failed-over-registry", registry: true, privateStatus: "failed", complete: false },
      { id: "no-evidence", complete: false }
    ];
    const state = new FilePhase3MaintenanceStateStore({ storageRootPath: f.privateRoot, vaultId: "p2-vault" });
    const recordsSnapshot = async () => Object.fromEntries(await Promise.all((await fs.readdir(path.join(f.privateRoot, "records")).catch(error => { if (error.code === "ENOENT") return []; throw error; })).sort().map(async name => [name, (await fs.readFile(path.join(f.privateRoot, "records", name))).toString("base64")])));
    for (const [index, test] of cases.entries()) {
      const source = `raw/${test.id}.md`, content = `${test.property === undefined ? "" : `---\n提炼状态: ${test.property}\n---\n`}# 状态证据\n只读核对当前来源。\n`;
      await f.write(source, content);
      const fingerprint = rawDigestFingerprint(source, Buffer.from(content));
      if (test.registry) await writeRawDigestRegistry(f.vault, { schemaVersion: 1, updatedAt: "2026-10-22", entries: { [source]: { rawPath: source, fingerprint, size: Buffer.byteLength(content), mtime: 1, digestedAt: 1, runId: "legacy", reportPath: "", evidencePaths: [], confidence: "verified" } } });
      if (test.setting) f.previous[source] = { fingerprint };
      if (test.privateStatus) {
        await state.saveRecord({ schemaVersion: 1, recordId: `maintenance-${index.toString(16).padStart(32, "0")}`, runId: test.id, originConversationId: "historical-completed-receipt", at: index + 1, date: "2026-10-22", result: createKnowledgeMaintenanceResultEnvelope({ status: test.privateStatus === "processed" ? "noop" : "failed" }), sources: [{ path: source, fingerprint: test.stale ? "outdated" : fingerprint, status: test.privateStatus, evidencePaths: [] }], summary: "旧版本证据" });
        assert.ok((await readPrivateMaintenanceRecords(f.privateRoot)).some(record => record.runId === test.id), "the production reader accepts this private receipt");
      }
      const before = await recordsSnapshot();
      f.conversation(test.id);
      const result = await f.call({ stage: "inspect", view: "pages" }, [source]);
      assert.equal(result.status, test.complete ? "completed" : "failed", `${test.id}: ${result.message}`);
      assert.deepEqual(result.processedSourcePaths, test.complete ? [source] : []);
      if (test.complete) { assert.equal(result.maintenanceResult?.status, "noop"); assert.deepEqual(result.maintenanceResult?.notes, []); assert.deepEqual(result.producedPaths, []); assert.equal(result.recordId, undefined); }
      else assert.match(result.message, /先stage=decompose/u);
      assert.equal(await f.read(source), content);
      assert.deepEqual(await recordsSnapshot(), before, test.id);
    }
    const before = await recordsSnapshot();
    await fs.writeFile(path.join(f.vault, "raw/unreadable.md"), Buffer.from([0xff]));
    for (const source of ["raw/missing.md", "raw/unreadable.md"]) assert.equal((await f.call({ stage: "inspect" }, [source], false)).status, "failed", source);
    assert.equal((await f.call({ stage: "invalid" } as unknown as MaintenanceP1Action, ["raw/new-complete.md"])).status, "failed");
    assert.equal((await f.call({ stage: "inspect" }, [])).status, "failed", "empty scope cannot be a completed batch");
    assert.equal(f.writes.length, 0);
    assert.deepEqual(await recordsSnapshot(), before);
  });
  await scenario("structured-evidence-and-seven-types", async f => {
    const paths: string[] = [], units: MaintenanceKnowledgeUnit[] = [];
    for (const [index, type] of MAINTENANCE_KNOWLEDGE_TYPES.entries()) {
      const source = `${index === 6 ? "inbox" : "raw"}/${index}.md`;
      await f.write(source, `---\n# This is not a source title\ncustom: 0021\n---\n# 真实全文标题${index}\n这是第${index}类原文的完整原句。\n`);
      paths.push(source); units.push(await f.unit(`u${index}`, source, `独立知识${index}`, type));
    }
    let result = await f.call({ stage: "decompose", decompositions: paths.map(sourcePath => ({ sourcePath, summary: "摘要", units: ["旧字符串不能开始新任务"] })) }, paths);
    assert.equal(result.status, "failed"); assert.match(result.message, /结构化/u);
    const forged = structuredClone(units); forged[0].evidence[0].quote = "原文中不存在的引句";
    result = await f.decompose(paths, forged); assert.equal(result.status, "failed"); assert.match(result.message, /quote/u);
    result = await f.decompose(paths, units); f.ok(result);
    f.ok(await f.call({ stage: "plan", writingPlan: units.map((unit,index) => f.item(`p${index}`, `wiki/${unit.title}.md`, [paths[index]], [unit.id])) }, paths));
    for (const [index, unit] of units.entries()) f.ok(await f.call({ stage: "write", pageId: `p${index}`, content: page(unit.title, unit.type) + "暂无\n" }, paths));
    for (const [index, source] of paths.entries()) {
      const content = await f.read(`wiki/独立知识${index}.md`);
      assert.ok(content.includes(`[[${source}|真实全文标题${index}]]`), "source labels come from the real H1, not a frontmatter comment");
      assert.doesNotMatch(content, /## 相关条目/u, "empty related section is omitted");
      assert.equal(isMaintenanceSourceProcessed(await f.read(source)), true);
    }
    const map = await f.read("wiki/工程工具索引.md");
    for (const type of MAINTENANCE_KNOWLEDGE_TYPES) assert.ok(map.includes(type));
    assert.match(map, /独立知识0/u);
    await fs.writeFile(path.join(root,"new-page-sample.md"), await f.read("wiki/独立知识0.md"));
  });
  await scenario("same-point-aggregation-and-final-classification", async f => {
    await f.write("raw/a.md", "# 文章A\n工具调用允许模型按协议发出操作请求。\n");
    await f.write("raw/b.md", "# 文章B\n工具调用把操作结果交回模型进行下一步判断。\n");
    const a = await f.unit("a", "raw/a.md", "工具调用", "概念"), b = await f.unit("b", "raw/b.md", "工具调用", "方法 / 流程");
    b.domain = "软件方法";
    f.ok(await f.decompose(["raw/a.md","raw/b.md"],[a,b]));
    const item = f.item("shared", "wiki/工具调用.md", ["raw/a.md","raw/b.md"], ["a","b"]);
    f.ok(await f.call({ stage: "plan", writingPlan: [{ ...item, knowledge: { ...item.knowledge!, type: "概念", domain: "工程工具" } }] }, ["raw/a.md","raw/b.md"]));
    f.ok(await f.call({ stage: "write", pageId: "shared", content: page("工具调用") }, ["raw/a.md","raw/b.md"]));
    assert.equal((await fs.readdir(path.join(f.vault,"wiki"))).filter(name => name === "工具调用.md").length,1);
    const content = await f.read("wiki/工具调用.md"); assert.ok(content.includes("文章A") && content.includes("文章B"));
    await fs.writeFile(path.join(root,"merged-page-sample.md"), content);
  });
  await scenario("new-first-and-21-reuse-rerun-and-history-classification", async f => {
    await fs.mkdir(f.privateRoot,{recursive:true});
    await fs.writeFile(path.join(f.privateRoot,"preferences.md"),"# 我自己的提炼偏好\n保留此内容与自定义小节名。\n");
    const sources = Array.from({length:21},(_,index)=>`raw/new-${index+1}.md`), title = "跨批页面身份", target = `wiki/${title}.md`;
    for (const source of sources) await f.write(source,`# ${source}完整标题\n相同知识点采用同一页面身份，${source}提供补充证据。\n`);
    const firstUnits = await Promise.all(sources.slice(0,20).map((source,index)=>f.unit(`u${index}`,source,title)));
    const decomposed = await f.decompose(sources.slice(0,20),firstUnits); f.ok(decomposed); assert.match(decomposed.message,/七类新模板可用/u,"custom preferences surface the new templates in the actual tool receipt");
    const item = f.item("first",target,sources.slice(0,20),firstUnits.map(unit=>unit.id)); item.knowledge!.domain = "最终领域";
    f.ok(await f.call({stage:"plan",writingPlan:[item]},sources.slice(0,20))); f.ok(await f.call({stage:"write",pageId:"first",content:page(title)},sources.slice(0,20)));
    const update = async(conversation:string, source:string) => {
      f.conversation(conversation); const unit = await f.unit("later",source,title); unit.domain = "最终领域"; unit.aliases = ["Cross batch identity"];
      const result = await f.decompose([source],[unit]); f.ok(result); assert.ok(result.message.includes(target));
      const current = await f.observe(target), snapshot = createMaintenanceSectionSnapshot(current), body = snapshot.regions.find(region=>region.title === "自定义知识正文")!;
      const proposed = f.item("later",target,[source],[unit.id],current); proposed.knowledge!.domain = "最终领域";
      f.ok(await f.call({stage:"plan",writingPlan:[proposed]},[source])); f.ok(await f.call({stage:"sections",targetPath:target},[source]));
      f.ok(await f.call({stage:"write",pageId:"later",sectionPatches:[{regionId:body.id,operation:"append",content:`${source}补充的同点证据。`}]},[source]));
    };
    await update("source-21",sources[20]); await update("rerun-same-batch",sources[20]);
    assert.equal((await f.read(target)).split('"Cross batch identity"').length-1,1,"the 21st source contributes its synonym once to existing aliases");
    assert.equal((await f.read(target)).split(`[[${sources[20]}|`).length-1,1,"rerun refreshes the selected source link instead of duplicating it");
    assert.equal((await fs.readdir(path.join(f.vault,"wiki"))).filter(name=>name === `${title}.md`).length,1);
    await f.write(target,(await f.read(target)).replace("类型: 概念","类型: 方法 / 流程"));
    f.conversation("new-point-final-domain"); await f.write("raw/final-domain.md","# 同域新条目原文\n这个不同知识点也属于最终领域。\n");
    const other = await f.unit("other","raw/final-domain.md","最终领域的不同知识点"); other.domain="最终领域";
    f.ok(await f.decompose(["raw/final-domain.md"],[other])); f.ok(await f.call({stage:"plan",writingPlan:[f.item("other","wiki/最终领域的不同知识点.md",["raw/final-domain.md"],[other.id])]},["raw/final-domain.md"]));
    f.ok(await f.call({stage:"write",pageId:"other",content:page(other.title)},["raw/final-domain.md"]));
    const map=await f.read("wiki/最终领域索引.md"); assert.ok(map.includes(title),"historical final domain survives when the source unit domain and unchanged page properties differ"); assert.ok(map.includes(other.title));
    const method = map.split("### 方法 / 流程")[1]?.split("### ")[0]; assert.ok(method?.includes(title),"user-edited visible type overrides the earlier private classification");
  });
  await scenario("existing-same-point-regions-and-cross-batch-21", async f => {
    const title = "可靠工具调用", target = `wiki/${title}.md`;
    const before = "---\n类型: 方法 / 流程\n领域: 用户领域\naliases: [Tool call]\ncustom: 0021 # preserve\n---\n# 可靠工具调用\n旧导语。\n\n## 证据\n原有事实。\n\n## 手写\n  用户段落和末尾空格。  \n\n";
    await f.write(target,before);
    const sourcePaths = Array.from({length:21},(_,i)=>`raw/s${i+1}.md`);
    for (const source of sourcePaths) await f.write(source, `# 资料${source}\n工具调用须校验结果，${source}保留独立证据。\n`);
    const batch = async (sources: string[], conversation: string) => {
      f.conversation(conversation);
      const units = await Promise.all(sources.map((source,index)=>f.unit(`u${index}`,source,title)));
      const decomposition = await f.decompose(sources,units); f.ok(decomposition); assert.ok(decomposition.message.includes(target), "next batch recalls the written target through the refreshed existing index");
      const current = await f.observe(target), snapshot = createMaintenanceSectionSnapshot(current);
      const region = snapshot.regions.find(region=>region.title === "证据")!;
      const item = f.item("existing",target,sources,units.map(unit=>unit.id),current);
      if(item.expectedTarget.kind==="file")item.expectedTarget.contentRevision=item.expectedTarget.contentRevision.slice("sha256:".length);
      f.ok(await f.call({stage:"plan",writingPlan:[item]},sources));
      f.ok(await f.call({stage:"sections",targetPath:target},sources));
      f.ok(await f.call({stage:"write",pageId:"existing",sectionPatches:[{regionId:region.id,operation:"append",content:sources.map(source=>`${source}的新证据。`).join("\n")}]},sources));
    };
    await batch(sourcePaths.slice(0,20),"first-20"); const first = await f.read(target);
    await batch(sourcePaths.slice(20),"next-1"); const second = await f.read(target);
    assert.ok(second.includes("s21.md的新证据"));
    const preserved = before.slice(0,before.indexOf("## 证据")), handwritten = before.slice(before.indexOf("## 手写"));
    assert.ok(second.startsWith(preserved)); assert.ok(second.includes(handwritten));
    assert.equal((await fs.readdir(path.join(f.vault,"wiki"))).filter(name=>name === `${title}.md`).length,1);
    assert.ok(first.includes("s1.md的新证据"));
    assert.match(await f.read("wiki/用户领域索引.md"),/方法 \/ 流程/u,"existing visible attributes also override a current plan provisional classification");
    const writes = [...f.writes], stat = await fs.stat(path.join(f.vault,target));
    f.ok(await f.call({stage:"resume"},sourcePaths.slice(20)));
    assert.deepEqual(f.writes,writes); assert.equal((await fs.stat(path.join(f.vault,target))).mtimeMs,stat.mtimeMs);
    await fs.writeFile(path.join(root,"updated-page-sample.md"),second);
  });
  await scenario("uncertain-mutual-related-preserved-after-defer", async f => {
    const old = "wiki/协议.md", oldBody = "# 协议\n协议是参与者共同遵循的交互约定。\n\n## 相关条目\n手写关系：仍应保留。\n";
    await f.write(old, applyMaintenanceRelatedEntries(oldBody,[{targetPath:"wiki/旧关系.md",reason:"先前的历史关系"}],oldBody));
    await f.write("wiki/旧关系.md", "# 旧关系\n历史条目。\n");
    const original = await f.read(old);
    await f.write("raw/uncertain.md","# 不确定原文\n工具协议约束模型与工具之间的请求格式。\n");
    const unit = await f.unit("uncertain","raw/uncertain.md","工具协议"); unit.aliases = ["协议"];
    f.ok(await f.decompose(["raw/uncertain.md"],[unit])); await f.observe(old);
    const item = f.item("uncertain","wiki/工具协议.md",["raw/uncertain.md"],[unit.id]);
    item.knowledge = {...item.knowledge!,decision:{kind:"uncertain",reason:"概念粒度可能不同，保留独立条目待确认",candidatePath:old},related:[{targetPath:old,reason:"协议是工具协议的上位概念",reverseReason:"工具协议是协议在模型工具场景中的专门形式"}]};
    f.ok(await f.call({stage:"plan",writingPlan:[item]},["raw/uncertain.md"]));
    f.ok(await f.call({stage:"write",pageId:item.id,content:page(unit.title,"概念",["协议"])},["raw/uncertain.md"]));
    assert.match(await f.read(item.targetPath), /\[\[wiki\/协议.md\|协议\]\] — 协议是工具协议的上位概念/u, "controlled related links survive the old body-link defer");
    const after = await f.read(old); assert.match(after,/旧关系.md/u); assert.match(after,/专门形式/u); assert.ok(after.startsWith(oldBody));
    assert.notEqual(after,original);
    // Same broad subject is a related candidate, not proof of identity.
    f.conversation("same-theme-new-point"); await f.write("raw/latency.md","# 延迟原文\n工具调用的等待时间会影响交互节奏。\n");
    const latency = await f.unit("latency","raw/latency.md","工具调用等待时间");
    f.ok(await f.decompose(["raw/latency.md"],[latency]));
    f.ok(await f.call({stage:"plan",writingPlan:[f.item("latency","wiki/工具调用等待时间.md",["raw/latency.md"],[latency.id])]},["raw/latency.md"]));
    f.ok(await f.call({stage:"write",pageId:"latency",content:page(latency.title)},["raw/latency.md"]));
    assert.ok(await f.read("wiki/工具调用等待时间.md"));
  });
  await scenario("relationship-source-backlinks-and-dependencies", async f => {
    const old="wiki/协议.md", a="raw/relation-a.md", b="raw/relation-b.md", primaryA="wiki/工具协议.md", primaryB="wiki/排队延迟.md";
    const originalA="# 关系原文A\n工具协议约束模型与工具之间的请求格式。\n",originalB="# 独立原文B\n排队延迟取决于请求到达与处理速度。\n";
    await f.write(old,"# 协议\n参与者共同遵循的交互约定。\n\n## 手写\n用户原有内容。  \n");await f.write(a,originalA);await f.write(b,originalB);
    const ua=await f.unit("relation-a",a,"工具协议"),ub=await f.unit("relation-b",b,"排队延迟");ua.aliases=["协议"];
    f.ok(await f.decompose([a,b],[ua,ub]));await f.observe(old);
    const ia=f.item("relation-a",primaryA,[a],[ua.id]);ia.knowledge={...ia.knowledge!,decision:{kind:"uncertain",reason:"保留专门工具场景，待确认概念粒度",candidatePath:old},related:[{targetPath:old,reason:"协议是工具协议的上位概念",reverseReason:"工具协议是协议在模型工具场景中的专门形式"}]};
    f.ok(await f.call({stage:"plan",writingPlan:[ia,f.item("relation-b",primaryB,[b],[ub.id])]},[a,b]));
    f.ok(await f.call({stage:"write",pageId:ia.id,content:page(ua.title,"概念",["协议"])},[a,b]));
    assert.equal(await f.read(a),originalA,"a primary page alone cannot finalize Raw while its relation dependency is pending");
    f.fail(old);const failed=await f.call({stage:"write",pageId:"relation-b",content:page(ub.title)},[a,b]);assert.equal(failed.status,"failed");
    assert.equal(await f.read(a),originalA);assert.equal(await f.read(b),originalB);const counts=[f.writes.filter(p=>p===primaryA).length,f.writes.filter(p=>p===primaryB).length];
    const pending=(await readPrivateMaintenanceRecords(f.privateRoot))[0];assert.ok(pending.p1!.p2!.finalization.some(item=>item.kind==="relationship"&&item.sourcePaths.includes(a)));assert.equal(pending.p1!.finalizedSources.includes(a),false);
    f.fail(null);await f.restart();f.ok(await f.call({stage:"resume"},[a,b]));
    assert.deepEqual([f.writes.filter(p=>p===primaryA).length,f.writes.filter(p=>p===primaryB).length],counts,"relationship recovery does not rewrite successful primary pages");
    const record=(await readPrivateMaintenanceRecords(f.privateRoot))[0],maps=record.p1!.p2!.finalization.filter(item=>item.kind==="map").map(item=>item.targetPath);
    assert.deepEqual(record.sources.find(source=>source.path===a)!.evidencePaths,[primaryA,old]);assert.deepEqual(record.sources.find(source=>source.path===b)!.evidencePaths,[primaryB]);
    for(const target of [primaryA,old])assert.ok((await f.read(a)).includes(`[[${target}]]`));assert.ok(!(await f.read(b)).includes(`[[${old}]]`));
    for(const map of maps){assert.ok(!(await f.read(a)).includes(`[[${map}]]`));assert.ok(!(await f.read(b)).includes(`[[${map}]]`));}
    assert.ok((await f.read(old)).includes(`[[${a}|关系原文A]]`));assert.equal(canonicalRawMarkdownForDigest(await f.read(a)),canonicalRawMarkdownForDigest(originalA));assert.equal(canonicalRawMarkdownForDigest(await f.read(b)),canonicalRawMarkdownForDigest(originalB));
  });
  await scenario("new-explicit-reverse-reason-and-one-way-preservation", async f => {
    const source="raw/learning-ledger.md",target="wiki/学习账本.md",archive="wiki/学习档案.md",oneWay="wiki/学习记录.md";
    const before="\uFEFF---\r\n类型: 概念\r\n领域: 学习方法\r\naliases: [User archive]\r\ncustom: 0021 # preserve\r\n---\r\n# 学习档案\r\n用户写的完整导语。  \r\n\r\n## 手写正文\r\n保留这些段落与空白。  \r\n\r\n## 相关条目\r\n用户手写的关系说明。\r\n";
    const oneWayBefore="# 学习记录\n用户的现有示例，只作正向参照。\n",rawBefore="# 学习账本原始材料\n学习账本与学习档案的边界尚未厘清，学习记录只作为字段示例。\n";
    await f.write(archive,before);await f.write(oneWay,oneWayBefore);await f.write(source,rawBefore);
    const unit=await f.unit("ledger",source,"学习账本","工具 / 产品");unit.domain="学习方法";unit.typePendingConfirmation=true;
    f.ok(await f.decompose([source],[unit]));await f.observe(archive);
    const item=f.item("ledger",target,[source],[unit.id]);item.knowledge={...item.knowledge!,decision:{kind:"new",reason:"现有学习档案不是同一对象，依据不足不能判同一点，因此新建并明确保留关系。"},related:[{targetPath:archive,reason:"两者边界尚未厘清，只保留参照关系。",reverseReason:"学习账本可能是学习档案的一种记录，也可能独立，关系待确认。"},{targetPath:oneWay,reason:"可相互参照的自然语言说明仍不构成反向写入指令。"}]};
    for(const reverseReason of ["","  ","一行\n另一行","[非法]","<非法>"]){const invalid=structuredClone(item);invalid.knowledge!.related![0].reverseReason=reverseReason;const result=await f.call({stage:"plan",writingPlan:[invalid]},[source]);assert.equal(result.status,"failed");assert.match(result.message,/reverseReason/u);}
    const missing=structuredClone(item);missing.knowledge!.decision={kind:"uncertain",candidatePath:archive,reason:"不确定时仍强制完整双向说明"};delete missing.knowledge!.related![0].reverseReason;const rejected=await f.call({stage:"plan",writingPlan:[missing]},[source]);assert.equal(rejected.status,"failed");assert.match(rejected.message,/reverseReason/u);assert.deepEqual(f.writes,[]);
    f.ok(await f.call({stage:"plan",writingPlan:[item]},[source]));
    const planned=(await readPrivateMaintenanceRecords(f.privateRoot))[0].p1!.p2!.finalization;
    assert.deepEqual(planned.filter(draft=>draft.kind==="relationship").map(draft=>draft.targetPath),[archive],"new + explicit reverseReason schedules a reverse write; ordinary related stays one-way");
    f.fail(archive);const first=await f.call({stage:"write",pageId:item.id,content:page(unit.title,unit.type).replace("aliases:","类型待确认: true\naliases:")},[source]);
    assert.equal(first.status,"failed");assert.equal(await f.read(source),rawBefore);assert.equal(await f.read(archive),before);assert.equal(await f.read(oneWay),oneWayBefore);
    const primary=await f.read(target),primaryWrites=f.writes.filter(path=>path===target).length;
    assert.ok(primary.includes(`[[${archive}|学习档案]]`));assert.ok(primary.includes(`[[${oneWay}|学习记录]]`));
    f.fail(null);await f.restart();f.ok(await f.call({stage:"resume"},[source]));
    assert.equal(await f.read(target),primary);assert.equal(f.writes.filter(path=>path===target).length,primaryWrites);
    const after=await f.read(archive);assert.ok(after.startsWith(before),"existing attributes and all handwritten content remain byte exact");assert.ok(after.includes(`[[${target}|学习账本]]`));assert.ok(after.includes(item.knowledge.related![0].reverseReason!));assert.equal(after.split(`[[${target}|`).length-1,1);
    assert.equal(await f.read(oneWay),oneWayBefore);assert.equal(f.writes.includes(oneWay),false,"missing reverseReason never writes a reverse link");
    const record=(await readPrivateMaintenanceRecords(f.privateRoot))[0],maps=record.p1!.p2!.finalization.filter(draft=>draft.kind==="map").map(draft=>draft.targetPath);
    assert.deepEqual(record.sources[0].evidencePaths,[target,archive]);for(const path of [target,archive])assert.ok((await f.read(source)).includes(`[[${path}]]`));
    assert.ok(!(await f.read(source)).includes(`[[${oneWay}]]`));for(const map of maps)assert.ok(!(await f.read(source)).includes(`[[${map}]]`));
    const writes=[...f.writes],contents=await Promise.all([source,target,archive,oneWay,...maps].map(path=>f.read(path)));f.ok(await f.call({stage:"resume"},[source]));assert.deepEqual(f.writes,writes);assert.deepEqual(await Promise.all([source,target,archive,oneWay,...maps].map(path=>f.read(path))),contents,"completed resume adds no duplicate relation or source links");
  });
  await scenario("managed-map-failure-cold-resume-and-cas", async f => {
    const mapPath = "wiki/工程工具索引.md", handwritten = "---\ncustom: keep # exact\n---\n# 工程工具索引\n手写导语。  \n\n## 手写清单\n保留这一行。  \n\n";
    await f.write(mapPath,handwritten); await f.write("raw/map.md","# 地图原文\n同一知识点应维护一张页面。\n");
    const unit = await f.unit("map","raw/map.md","页面身份");
    f.ok(await f.decompose(["raw/map.md"],[unit])); f.ok(await f.call({stage:"plan",writingPlan:[f.item("map","wiki/页面身份.md",["raw/map.md"],[unit.id])]},["raw/map.md"]));
    f.fail(mapPath); const result = await f.call({stage:"write",pageId:"map",content:page(unit.title)},["raw/map.md"]); assert.equal(result.status,"failed");
    const content = await f.read("wiki/页面身份.md"), count = f.writes.filter(name=>name === "wiki/页面身份.md").length;
    assert.equal(isMaintenanceSourceProcessed(await f.read("raw/map.md")),false);
    f.fail(null); await f.restart(); f.ok(await f.call({stage:"resume"},["raw/map.md"]));
    assert.equal(await f.read("wiki/页面身份.md"),content); assert.equal(f.writes.filter(name=>name === "wiki/页面身份.md").length,count);
    assert.ok((await f.read(mapPath)).startsWith(handwritten)); assert.match(await f.read(mapPath),/页面身份/u);
    // New batch locks current map version; a handwritten edit wins over a stale generated draft.
    f.conversation("map-concurrent"); await f.write("raw/concurrent.md","# 并发原文\n修改地图前须校验版本。\n");
    const other = await f.unit("concurrent","raw/concurrent.md","并发校验"); f.ok(await f.decompose(["raw/concurrent.md"],[other]));
    f.ok(await f.call({stage:"plan",writingPlan:[f.item("concurrent","wiki/并发校验.md",["raw/concurrent.md"],[other.id])]},["raw/concurrent.md"]));
    const edited = (await f.read(mapPath)) + "用户在规划后新增的手写内容。\n"; await f.write(mapPath,edited);
    const conflict = await f.call({stage:"write",pageId:"concurrent",content:page(other.title)},["raw/concurrent.md"]);
    assert.equal(conflict.status,"failed"); assert.match(conflict.message,/并发冲突/u); assert.equal(await f.read(mapPath),edited);
    assert.equal(isMaintenanceSourceProcessed(await f.read("raw/concurrent.md")),false);
  });
  await fs.writeFile(path.join(root,"p2-report.json"),JSON.stringify(report,null,2));
  console.log(`P2 production maintenance: PASS (${report.length} scenarios; seven types, quotes, aggregation, real note_read, 20+1, mutual relations, maps/CAS/cold resume)`);
}

export async function runMaintenanceReceiptBudgetTests(root: string, replay?: { action: MaintenanceP1Action; contents: Record<string,string>; quoteRepairs: readonly { unitId: string; evidenceIndex: number; quote: string }[]; expectedQuoteFailures?: readonly string[]; minimumWhitespaceMatches?: number }): Promise<void> {
  const results: unknown[] = [];
  async function budget(name: string, real?: typeof replay) {
    const f = await fixture(path.join(root,name));
    let action: MaintenanceP1Action, paths: string[], initialQuoteDiagnostic: string | undefined;
    if (real) {
      action = structuredClone(real.action); paths = action.decompositions!.map(d=>d.sourcePath);
      for (const source of paths) await f.write(source,real.contents[source]);
      for (const [relative,content] of Object.entries(real.contents)) if (relative.startsWith("wiki/")) await f.write(relative,content);
      const unchangedInput = JSON.stringify(action);
      const checked = await f.call(action,paths); if(checked.status==="failed")initialQuoteDiagnostic=checked.message; assert.equal(JSON.stringify(action),unchangedInput,"grounding must not rewrite the model input object");
      if(real.expectedQuoteFailures?.length){assert.equal(checked.status,"failed");for(const unitId of real.expectedQuoteFailures)assert.ok(checked.message.includes(unitId));assert.match(checked.message,/quote|原句/u);}
      else f.ok(checked);
      // Apply explicit diagnosed quote repairs only to this test copy. Native evidence remains untouched.
      for (const repair of real.quoteRepairs) {
        const unit = action.decompositions!.flatMap(d=>d.units).find(unit=>typeof unit!=="string"&&unit.id===repair.unitId) as MaintenanceKnowledgeUnit;
        const evidence = unit.evidence[repair.evidenceIndex]; assert.ok(real.contents[evidence.sourcePath].includes(repair.quote));
        evidence.quote=repair.quote;
      }
    } else {
      paths=Array.from({length:20},(_,i)=>`raw/budget-${i}.md`);const units:MaintenanceKnowledgeUnit[]=[];
      for(const [i,source]of paths.entries()) {
        const body=`这是预算${i}的原文。\n`+"完整原句保留换行与证据。".repeat(60);
        await f.write(source,`# 二十篇规模原文${i}\n${body}\n`);await f.write(`wiki/预算候选${i}.md`,`# 预算候选${i}\n${body}\n`);
        units.push(await f.unit(`budget-${i}`,source,`预算候选${i}`));
      }
      action={stage:"decompose",decompositions:paths.map((sourcePath,i)=>({sourcePath,summary:"二十篇规模预算夹具",units:[units[i]]}))};
    }
    const sourceSnapshots=new Map(await Promise.all(paths.map(async source=>[source,await f.read(source)] as const)));
    const rowCounts: Record<string,number>={}, bytes:number[]=[];
    async function visible(result:PiKnowledgeMaintenanceToolResult,args:MaintenanceP1Action) {
      f.ok(result);const id=`budget-${bytes.length}`;
      const identity={vaultId:"p2-vault",conversationId:"budget",productRunId:"budget",piSessionId:"budget"};
      const security=createPiKnowledgeMaintenanceToolSecurity({currentRunIdentity:()=>identity,currentCommand:()=>({mode:"maintain",request:"",scope:{mode:"batch",sourcePaths:paths},preference:{profileVersion:"fixture",state:"default",revision:`sha256:${"a".repeat(64)}`,providerResourceText:"fixture"}}),egress:new EchoInkVaultToolEgressPolicy()});
      const argumentsWithPaths={...args,sourcePaths:paths};assert.equal(await security.handleToolCall({type:"tool_call",toolName:"knowledge_maintain",toolCallId:id,input:argumentsWithPaths} as never,undefined),undefined);
      security.consume(id,argumentsWithPaths);security.complete(id,result);
      const secured=await security.handleToolResult({toolName:"knowledge_maintain",toolCallId:id,isError:false} as never),text=secured.content[0].text;
      assert.equal(secured.isError,false);assert.doesNotMatch(text,/\[TRUNCATED\]/u);assert.ok(Buffer.byteLength(text)<=8000);bytes.push(Buffer.byteLength(text));
      const line=text.split("\n").find(line=>line.startsWith("{"))!;const parsed=JSON.parse(line);assert.ok(parsed.inspection);return parsed.inspection;
    }
    let result=await f.call(action,paths);let inspect=await visible(result,action);
    const saved=(await readPrivateMaintenanceRecords(f.privateRoot))[0],evidence=saved.p1!.decompositions.flatMap(d=>d.units).flatMap(unit=>typeof unit==="string"?[]:unit.evidence);
    let whitespaceMatches=0;
    for(const item of evidence){const source=await f.read(item.sourcePath),location=item.quoteLocation;assert.ok(location,"each grounded quote keeps its original snapshot position");assert.equal(source.slice(location.start,location.end),item.quote);assert.equal(location.unit,"utf16");if(location.match==="whitespace")whitespaceMatches++;}
    if(real?.minimumWhitespaceMatches)assert.ok(whitespaceMatches>=real.minimumWhitespaceMatches,"real line-wrap-only differences are accepted without changing source words");
    for(const view of ["candidates","units"] as const) {
      let page = view==="candidates" ? inspect : await visible(await f.call({stage:"inspect",view,offset:0},paths),{stage:"inspect",view,offset:0});let count=0;
      while(true){count+=page.items.length;if(page.nextOffset===null)break;const next=page.nextOffset;page=await visible(await f.call({stage:"inspect",view,offset:next},paths),{stage:"inspect",view,offset:next});}
      rowCounts[view]=count;assert.equal(count,page.total,"every stored candidate/unit row remains available through explicit continuation");
    }
    if(!real) {
      const plan:MaintenanceWritingItem[]=[];
      for(const [i,source]of paths.entries()){const target=`wiki/预算候选${i}.md`,before=await f.observe(target),item=f.item(`budget-${i}`,target,[source],[`budget-${i}`],before);if(i===0&&item.expectedTarget.kind==="file")item.expectedTarget.contentRevision=item.expectedTarget.contentRevision.slice("sha256:".length);plan.push(item);}
      inspect=await visible(await f.call({stage:"plan",writingPlan:plan},paths),{stage:"plan",writingPlan:plan});let count=0;
      while(true){count+=inspect.items.length;if(inspect.nextOffset===null)break;const offset=inspect.nextOffset;inspect=await visible(await f.call({stage:"inspect",view:"pages",offset},paths),{stage:"inspect",view:"pages",offset});}
      assert.equal(count,20);rowCounts.pages=count;
    }
    for(const [source,content]of sourceSnapshots)assert.equal(await f.read(source),content,"decomposition/inspection keeps every Raw byte unchanged");
    results.push({name,sources:paths.length,inputBytes:Buffer.byteLength(JSON.stringify(action)),responses:bytes.length,maxResponseBytes:Math.max(...bytes),rowCounts,initialQuoteDiagnostic,groundedQuotes:evidence.length,whitespaceMatches,sourceOrWikiWrites:f.writes.length});assert.equal(f.writes.length,0,"inspection never writes sources or Wiki");f.release();
  }
  await budget("twenty-source-budget");if(replay)await budget("real-twelve-source-budget",replay);
  await fs.writeFile(path.join(root,"receipt-budget-report.json"),JSON.stringify(results,null,2));console.log("Maintenance receipt budget: PASS (real Tool security/egress, valid JSON, explicit complete pagination, <=8000 bytes)",JSON.stringify(results));
}

export async function fixture(vault: string, options: Partial<import("../plugin/pi-knowledge-maintenance-production").CreateProductionPiKnowledgeMaintenanceOptions> = {}) {
  const f = await nativeJournalFixture(vault), privateRoot = path.join(vault,".obsidian/plugins/echoink/knowledge");
  const config = emptyKnowledgeFolderBindings();
  for (const role of ["raw","inbox","wiki"] as const) { Object.assign(config.roles[role],{enabled:true,readPaths:[role],writePath:role}); await fs.mkdir(path.join(vault,role),{recursive:true}); }
  const release = registerKnowledgeFolderBindings(vault,()=>config), observed: Record<string,string> = {}, writes: string[] = [];
  const previous: Record<string, { fingerprint?: string }> = {};
  let port: ProductionPiKnowledgeMaintenanceToolPort, domain: VaultDomainService, failed: string | null = null, sequence = 0, conversation = "p2-fixture";
  async function restart() {
    const adapter = new ObsidianVaultDomainAdapter(f.app,"p2-vault",vault);
    for (const method of ["createFile","updateFile"] as const) { const original = adapter[method].bind(adapter); (adapter as any)[method] = async (target: any,...args: any[]) => { if (target.relativePath === failed) throw new Error("Synthetic map failure"); const result = await (original as any)(target,...args); writes.push(target.relativePath); return result; }; }
    domain = new VaultDomainService(adapter,{allowMissingParentDirectories:true});
    port = new ProductionPiKnowledgeMaintenanceToolPort({vaultRootPath:vault,privateKnowledgeRootPath:privateRoot,vaultId:"p2-vault",userId:"fixture",deviceId:"fixture",domainService:domain,processedSources:()=>previous,automaticLinkingEnabled:()=>false,linkingOwnsDraftLinks:true,onCommitted:async()=>"test-background",dateKey:()=>"2026-10-22", ...options}); await port.initialize();
  }
  await restart();
  async function call(p1:MaintenanceP1Action,sourcePaths:string[],readSources=true) {
    const sourceBodyFingerprints: Record<string,string> = {};
    if (readSources) for (const relativePath of sourcePaths) sourceBodyFingerprints[relativePath] = (await domain.noteRead({vaultId:"p2-vault",relativePath})).snapshot.bodyFingerprint!;
    return port.execute({vaultId:"p2-vault",conversationId:conversation,piSessionId:"fixture",productRunId:`turn-${++sequence}`,toolCallId:`call-${sequence}`,mode:"maintain",request:"",sourcePaths,sourceBodyFingerprints,observedTargetRevisions:observed,folderBindingsRevision:config.revision,preferenceSnapshot:{profileVersion:"fixture",state:"default",revision:`sha256:${"a".repeat(64)}`},p1});
  }
  async function unit(id:string,sourcePath:string,title:string,type:MaintenanceKnowledgeType="概念"):Promise<MaintenanceKnowledgeUnit> {
    const content = await fs.readFile(path.join(vault,sourcePath),"utf8"), quote = content.trim().split(/\r?\n/u).at(-1)!;
    return {id,type,domain:"工程工具",title,aliases:[],points:[quote],evidence:[{sourcePath,sourceRevision:revision(content),quote}]};
  }
  return {vault,privateRoot,release,restart,call,unit,writes,previous,get port(){return port;},get productRunId(){return `turn-${sequence}`;},write:f.write,read:(relative:string)=>fs.readFile(path.join(vault,relative),"utf8"),fail:(relative:string|null)=>{failed=relative;},conversation:(id:string)=>{conversation=id;},ok:(result:{status:string;message:string})=>assert.equal(result.status,"completed",result.message),
    observe:async(relativePath:string)=>{const read=await domain.noteRead({vaultId:"p2-vault",relativePath});observed[relativePath]=`sha256:${read.snapshot.contentSha256}`;return read.snapshot.content;},
    item:(id:string,targetPath:string,sourcePaths:string[],unitIds:string[],before?:string):MaintenanceWritingItem=>({id,targetPath,sourcePaths,expectedTarget:before===undefined?{kind:"missing"}:{kind:"file",contentRevision:revision(before)},knowledge:{unitIds,decision:before===undefined?{kind:"new",reason:"独立知识点，未确认现有同点"}:{kind:"same_point",reason:"已读现有正文，确认是同一知识点的新证据",candidatePath:targetPath}}}),
    decompose:(sources:string[],units:MaintenanceKnowledgeUnit[])=>call({stage:"decompose",decompositions:sources.map(sourcePath=>({sourcePath,summary:"原文摘要",units:units.filter(unit=>unit.evidence.some(evidence=>evidence.sourcePath===sourcePath))}))},sources)
  };
}
