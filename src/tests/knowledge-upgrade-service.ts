import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { KnowledgeUpgradeService, createProductionKnowledgeUpgradeService, type KnowledgeUpgradeHost } from "../plugin/knowledge-upgrade-service";
import { emptyKnowledgeFolderBindings, registerKnowledgeFolderBindings, registerKnowledgePrivateRoot, knowledgePathRole } from "../knowledge-base/root-paths";
import { projectMaintenanceActivity, maintenanceCompletionText } from "../knowledge-base/maintenance-activity";
import { FileApprovalTicketStore } from "../harness/pi-native/tool-authorization";
import { FileDomainReceiptStore } from "../harness/pi-native/domain-receipt-store";
import { readPrivateMaintenanceRecords } from "../plugin/pi-knowledge-maintenance-production";
import type { KnowledgeMaintenanceRecord } from "../knowledge-base/maintenance-record";
import { nativeJournalFixture } from "./native-journal-fixture";
import { KnowledgeUpgradeClassificationError } from "../plugin/pi-production-runtime-composition";
import { backgroundMaintenancePageWrite, maintenancePageIsHeld, releaseMaintenancePages } from "../knowledge-base/maintenance-page-lock";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
async function settle(service: KnowledgeUpgradeService) {
  for (let i = 0; i < 2000 && service.running; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(service.running, false, "upgrade must settle");
  return service.getUpgradeSnapshot();
}
async function put(root: string, file: string, content: string) { await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true }); await fs.writeFile(path.join(root, file), content); }

export async function runKnowledgeUpgradeServiceTests(root: string): Promise<void> {
  await fs.mkdir(root, { recursive: true });
  const report: string[] = [];
  {
    const vault = path.join(root, "generic");
    await put(vault, "Raw/source.md", "---\n已处理: true\n---\n# 来源\n正文  \n");
    await put(vault, "Raw/linked.md", "---\n提炼状态: 已提炼\n---\n# 已有状态\n");
    await put(vault, "Wiki/map.md", "# 地图\n[[Raw/source.md|来源]] [[Raw/linked.md]]\n");
    let bindings = emptyKnowledgeFolderBindings(), stored: KnowledgeMaintenanceRecord[] = [], classified = 0, tasks = 0;
    let blocked = true, failWiki = true, failClassification = false;
    const changed: KnowledgeMaintenanceRecord[] = [], writes: string[] = [], notices: string[] = [], statuses: string[] = [];
    const host: KnowledgeUpgradeHost = {
      vaultRoot: vault, bindings: () => bindings, records: async () => structuredClone(stored),
      save: async record => { stored = [structuredClone(record)]; }, createTask: async () => { tasks++; return "upgrade-task"; },
      taskStatus: async (_id, status) => { statuses.push(status); },
      registerRoots: async (roots, expected) => {
        const missing = roots.filter(item => !bindings.roles[item.role].readPaths.includes(item.path));
        if (!missing.length) return bindings.revision;
        assert.equal(bindings.revision, expected);
        for (const item of missing) bindings.roles[item.role].readPaths.push(item.path);
        return ++bindings.revision;
      },
      classify: async (_item, _record, signal) => {
        classified++;
        if (blocked) await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
        if (signal.aborted) throw new Error("aborted");
        if (failClassification) throw new KnowledgeUpgradeClassificationError("这页的类型判断没有返回完整结果，原文件会保留，点继续重试。", "invalid-json", "length");
        return { type: "趋势 / 主题", uncertain: true };
      },
      write: async write => {
        if (failWiki && write.role === "wiki") return { done: false, reason: "这页暂时没写成，请继续重试。" };
        assert.equal(sha(await fs.readFile(path.join(vault, write.path), "utf8")), write.expectedVersion);
        writes.push(write.path); await fs.writeFile(path.join(vault, write.path), write.content); return { done: true, revision: sha(write.content) };
      },
      changed: record => changed.push(structuredClone(record)), notice: message => notices.push(message)
    };
    const service = new KnowledgeUpgradeService(host); await service.ready;
    const preview = await service.previewUpgrade();
    assert.equal(classified, 0); assert.equal(tasks, 0); assert.equal(writes.length, 0); assert.equal(stored.length, 0);
    assert.equal(preview.counts.sourceStatusCount, 1); assert.equal(preview.counts.wikiCount, 1, "maps are classified too");
    assert.ok(preview.rootAdditions.some(item => item.path === "Raw"));
    await assert.rejects(service.confirmUpgrade("stale"), /预览/);
    const live = await service.confirmUpgrade(preview.id); assert.equal(live.status, "running");
    let backgroundWrites = 0;
    const backgroundController = new AbortController();
    const background = backgroundMaintenancePageWrite(vault, "Wiki/map.md", async () => { backgroundWrites++; await fs.appendFile(path.join(vault, "Wiki/map.md"), "后台关联。\n"); }, backgroundController.signal);
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(maintenancePageIsHeld(vault, "Wiki/map.md"), true);
    assert.equal(backgroundWrites, 0, "confirmed upgrade defers the actual shared background write gate");
    await service.stopUpgrade(); assert.equal((await service.getUpgradeSnapshot()).status, "interrupted");
    assert.equal(writes.length, 0, "stop during classify never writes");
    assert.equal(maintenancePageIsHeld(vault, "Wiki/map.md"), true, "stop retains the P1 page hold");
    blocked = false; failClassification = true; await service.resumeUpgrade();
    const partial = await settle(service);
    assert.equal(stored[0].upgrade?.classificationFailures?.["Wiki/map.md"].stopReason, "length");
    assert.ok(partial.preview?.issues.some(item => item.message.includes("没有返回完整结果")));
    assert.equal(partial.status, "interrupted"); assert.equal(partial.completed?.sources, 1, "link-only sources are excluded from status count");
    assert.equal(partial.completed?.links, 2); assert.equal(partial.completed?.wiki, 0);
    assert.equal(stored[0].progress?.completedAt, undefined); assert.equal(stored[0].result.status, "partial");
    assert.equal(statuses.at(-1), "interrupted"); assert.equal(notices.length, 0);
    const date = new Date(stored[0].at); assert.equal(stored[0].date, `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,"0")}-${String(date.getDate()).padStart(2,"0")}`, "task date is local calendar day");
    assert.ok(partial.preview?.issues.some(item => item.path === "Wiki/map.md" && item.executionFailure === true), "confirmed failures remain distinct from static preview reviews");
    assert.equal(backgroundWrites, 0, "partial upgrade keeps background linking deferred");
    backgroundController.abort(); await background;
    const originalWrites = [...writes];
    // Simulate losing this process's in-memory gate while preserving its record.
    releaseMaintenancePages(stored[0].recordId);
    assert.equal(maintenancePageIsHeld(vault, "Wiki/map.md"), false);
    stored[0].progress!.status = "running"; stored[0].progress!.elapsedMs.scan = 900; stored[0].progress!.updatedAt -= 86_400_000;
    const cold = new KnowledgeUpgradeService(host); await cold.ready;
    assert.equal(maintenancePageIsHeld(vault, "Wiki/map.md"), true, "cold scan restores the same persisted P1 hold");
    const afterRestart = backgroundMaintenancePageWrite(vault, "Wiki/map.md", async () => { backgroundWrites++; await fs.appendFile(path.join(vault, "Wiki/map.md"), "后台关联。\n"); }, new AbortController().signal);
    await new Promise(resolve => setTimeout(resolve, 0)); assert.equal(backgroundWrites, 0);
    assert.equal((await cold.getUpgradeSnapshot()).status, "interrupted");
    assert.equal(changed.at(-1)?.progress?.status, "interrupted");
    assert.equal(changed.at(-1)?.progress?.elapsedMs.scan, 900, "cold recovery never counts offline time");
    failWiki = false; failClassification = false; await cold.resumeUpgrade(); const finished = await settle(cold);
    assert.equal(stored[0].upgrade?.classificationFailures?.["Wiki/map.md"], undefined, "successful retry clears stale failure diagnostics");
    assert.equal(finished.status, "completed"); assert.equal(tasks, 1, "resume keeps one real task");
    for (const file of originalWrites) assert.equal(writes.filter(item => item === file).length, 1, "successful notes never rewrite");
    assert.equal(finished.completed?.wiki, 1); assert.match(await fs.readFile(path.join(vault, "Wiki/map.md"), "utf8"), /类型待确认: true/);
    await afterRestart;
    assert.equal(backgroundWrites, 1, "completion releases the shared gate and the deferred filesystem write runs once");
    assert.equal(maintenancePageIsHeld(vault, "Wiki/map.md"), false);
    const activity = projectMaintenanceActivity(stored[0])!;
    assert.match(maintenanceCompletionText(activity), /1 篇资料状态、2 条链接.*1 页/);
    const recheck = await cold.previewUpgrade(); assert.equal(recheck.automatic.length, 0); assert.equal(writes.length, 3);
    report.push("read-only-confirm-stop-partial-cold-resume-counts-recheck", "shared-background-hold-stop-cold-restore-release");
  }
  {
    const vault = path.join(root, "new-user-type"); await put(vault, "Wiki/user.md", "# 用户页\n正文\n");
    let stored: KnowledgeMaintenanceRecord[] = [], release!: () => void, entered!: () => void;
    const active = new Promise<void>(resolve => { entered = resolve; });
    const service = new KnowledgeUpgradeService({ vaultRoot: vault, bindings: () => emptyKnowledgeFolderBindings(), records: async () => stored,
      save: async record => { stored = [structuredClone(record)]; }, createTask: async () => "new-type-task", taskStatus: async () => {}, registerRoots: async () => 0,
      classify: async () => { entered(); await new Promise<void>(resolve => { release = resolve; }); return { type: "概念", uncertain: false }; },
      write: async () => { throw new Error("must not overwrite new type"); }, changed: () => {}, notice: () => {} });
    await service.ready; const preview = await service.previewUpgrade(); await service.confirmUpgrade(preview.id); await active;
    const user = "---\n类型: 工具 / 产品\n---\n# 用户页\n正文\n手写保留\n";
    await put(vault, "Wiki/user.md", user); release(); assert.equal((await settle(service)).status, "completed");
    assert.equal(await fs.readFile(path.join(vault, "Wiki/user.md"), "utf8"), user);
    assert.equal((await service.getUpgradeSnapshot()).completed?.wiki, 0);
    report.push("new-user-type-preserved-without-write");
  }
  await productionDurability(path.join(root, "production"), report);
  await fs.writeFile(path.join(root, "service-result.json"), JSON.stringify({ passed: true, scenarios: report }, null, 2));
}

async function productionDurability(root: string, report: string[]) {
  for (const mode of ["failed-retry", "receipt-gap"] as const) {
    const vault = path.join(root, mode), f = await nativeJournalFixture(vault), privateRoot = path.join(vault, ".obsidian/plugins/codex-echoink/pi-agent-product-v1/knowledge"), storage = path.dirname(privateRoot);
    await put(vault, "raw/articles/old.md", "# 普通旧来源\n保留正文  \n");
    const bindings = emptyKnowledgeFolderBindings();
    bindings.roles.raw = { ...bindings.roles.raw, enabled: true, writePath: "原始资料", readPaths: ["原始资料"] };
    await fs.mkdir(path.join(vault, "原始资料"), { recursive: true });
    const releaseBindings = registerKnowledgeFolderBindings(vault, () => bindings); registerKnowledgePrivateRoot(vault, privateRoot);
    const receipts = new FileDomainReceiptStore({ storageRootPath: storage, vaultId: "upgrade-vault" });
    const approvals = new FileApprovalTicketStore({ storageRootPath: storage, vaultId: "upgrade-vault" });
    await receipts.initialize(); await approvals.initialize();
    let calls = 0, fail = true, tasks = 0, savedSettings = 0, taskRefreshes = 0;
    const process = f.app.vault.process.bind(f.app.vault);
    f.app.vault.process = async (file: any, callback: any) => { calls++; if (mode === "failed-retry" && fail) throw new Error("synthetic write error"); return process(file, callback); };
    if (mode === "receipt-gap") {
      const persist = receipts.persistReceipt.bind(receipts);
      receipts.persistReceipt = async input => { if (fail) { fail = false; throw new Error("crash before receipt"); } return persist(input); };
    }
    const local: any = { deviceScope: { vaultIdDigest: "upgrade-vault", deviceIdDigest: "upgrade-device" }, receipts, approvals,
      catalog: { get: async () => ({ conversationId: "production-upgrade", piSessionId: "upgrade-session" }) } };
    const plugin: any = { app: f.app, settings: { ...f.plugin.settings, knowledgeBase: { ...f.plugin.settings.knowledgeBase, folderBindings: bindings } },
      getVaultPath: () => vault, getPluginDataDirName: () => ".obsidian/plugins/codex-echoink", getKnowledgeUpgradeLocalData: async () => local,
      createPiConversation: async () => { tasks++; }, setPiConversationTaskMetadata: async () => {},
      saveSettings: async () => { savedSettings++; Object.assign(bindings, structuredClone(plugin.settings.knowledgeBase.folderBindings)); },
      getKnowledgeSurfaceService: () => null, getCodexView: () => ({ refreshAgentTasks() { taskRefreshes++; } }), refreshKnowledgeBaseSurfaces: () => {} };
    try {
      let service = createProductionKnowledgeUpgradeService(plugin); await service.ready;
      const preview = await service.previewUpgrade(); assert.ok(preview.rootAdditions.some(item => item.path === "raw"));
      await service.confirmUpgrade(preview.id); const first = await settle(service);
      assert.equal(savedSettings, 1); assert.equal(knowledgePathRole(vault, "raw/articles/old.md"), "raw", "existing ordinary binding resolves added root");
      assert.equal(first.status, "interrupted", "failed write or missing receipt remains unfinished until verified");
      if (mode === "failed-retry") {
        const records = await readPrivateMaintenanceRecords(privateRoot);
        // Simulate a settings commit followed by process loss before its checkpoint.
        records[0].upgrade!.rootsRegistered = false; delete records[0].upgrade!.confirmedBindingRevision;
        const { FilePhase3MaintenanceStateStore } = await import("../plugin/pi-knowledge-maintenance-production");
        await new FilePhase3MaintenanceStateStore({ storageRootPath: privateRoot, vaultRootPath: vault, vaultId: "upgrade-vault" }).saveUpgradeRecord(records[0]);
      }
      fail = false; service = createProductionKnowledgeUpgradeService(plugin); await service.ready; await service.resumeUpgrade();
      assert.equal((await settle(service)).status, "completed");
      assert.equal(calls, mode === "failed-retry" ? 2 : 1, "failed receipt retries once; a receipt gap only reads back");
      assert.equal(tasks, 1); assert.equal(savedSettings, 1); assert.ok(taskRefreshes >= 2, "task roster refreshes on start and settled state");
      const records = await readPrivateMaintenanceRecords(privateRoot); assert.equal(records.length, 1); assert.equal(records[0].upgrade?.phase, "completed");
      const write = Object.values(records[0].upgrade!.writes)[0]; assert.equal(write.done, true);
      if (mode === "failed-retry") assert.equal(write.attempt, 1, "retry identity is durable in the same record");
      report.push(`production-${mode}`);
    } finally { releaseBindings(); }
  }
}
