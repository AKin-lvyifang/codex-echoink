import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Notice } from "obsidian";
import type CodexForObsidianPlugin from "../main";
import type { KnowledgeFolderBindings } from "../knowledge-base/folder-bindings";
import { emptyKnowledgeFolderBindings } from "../knowledge-base/folder-bindings";
import { knowledgePrivateRoot, knowledgeRootRole } from "../knowledge-base/root-paths";
import { isKnowledgeMaintenanceSourcePath, rawDigestFingerprint, readRawDigestRegistry } from "../knowledge-base/raw-digest";
import { latestMaintenanceSourceStates, type KnowledgeMaintenanceRecord } from "../knowledge-base/maintenance-record";
import { createKnowledgeMaintenanceResultEnvelope } from "../knowledge-base/knowledge-maintenance-result";
import { newMaintenanceProgress } from "../knowledge-base/maintenance-activity";
import { buildMaintenanceUpgradePlan, previewMaintenanceUpgradePlan } from "../knowledge-base/maintenance-upgrade-plan";
import { patchMaintenanceUpgradeSourceFrontmatter, readMaintenanceFrontmatterProperty } from "../knowledge-base/maintenance-source-frontmatter";
import { appendMaintenancePageType } from "../knowledge-base/maintenance-page-metadata";
import { holdMaintenancePages, releaseMaintenancePages, serializeMaintenancePage } from "../knowledge-base/maintenance-page-lock";
import type { MaintenanceUpgradeClassification, MaintenanceUpgradeFile, MaintenanceUpgradePlan, MaintenanceUpgradePreview, MaintenanceUpgradeRootAddition, MaintenanceUpgradeSnapshot, MaintenanceUpgradeWrite } from "../knowledge-base/maintenance-upgrade-contract";
import { FilePhase3MaintenanceStateStore, readPrivateMaintenanceRecords } from "./pi-knowledge-maintenance-production";
import { pluginDataDir } from "./plugin-data-paths";
import { VaultDomainService } from "../harness/pi-native/vault-domain-service";
import { ObsidianVaultDomainAdapter } from "./obsidian-vault-domain-adapter";
import { confirmAndConsumeApprovalTicket, createOperationIdentity, type ApprovalOperationContract } from "../harness/pi-native/tool-authorization";
import { classifyKnowledgeUpgradePage, KnowledgeUpgradeClassificationError } from "./pi-production-runtime-composition";

const version = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const localDateKey = (now: number) => {
  const date = new Date(now);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
};
const countEmpty = () => ({ sourceCount: 0, sourceStatusCount: 0, sourceLinkCount: 0, backlinkCount: 0, wikiCount: 0 });
export interface KnowledgeUpgradeHost {
  vaultRoot: string;
  bindings(): KnowledgeFolderBindings | null | undefined;
  records(): Promise<KnowledgeMaintenanceRecord[]>;
  save(record: KnowledgeMaintenanceRecord): Promise<void>;
  createTask(): Promise<string>;
  taskStatus(taskId: string, status: "running" | "interrupted" | "completed"): Promise<void>;
  registerRoots(roots: readonly MaintenanceUpgradeRootAddition[], expectedRevision: number): Promise<number>;
  classify(item: MaintenanceUpgradePlan["wikiItems"][number], record: KnowledgeMaintenanceRecord, signal: AbortSignal): Promise<MaintenanceUpgradeClassification>;
  write(write: MaintenanceUpgradeWrite, record: KnowledgeMaintenanceRecord, signal: AbortSignal, retry: boolean): Promise<{ done: boolean; revision?: string; reason?: string }>;
  changed(record: KnowledgeMaintenanceRecord): void;
  notice(message: string): void;
  historyRoots?(): Promise<readonly MaintenanceUpgradeRootAddition[]>;
}

/** One upgrade task in the existing maintenance record. Scan and preview never write notes. */
export class KnowledgeUpgradeService {
  readonly ready: Promise<void>;
  private plan: MaintenanceUpgradePlan | null = null;
  private record: KnowledgeMaintenanceRecord | null = null;
  private error = "";
  private scanFlight: Promise<void> | null = null;
  private runFlight: Promise<void> | null = null;
  private controller: AbortController | null = null;
  constructor(private readonly host: KnowledgeUpgradeHost) {
    this.ready = this.scan();
  }
  ownsTask(taskId: string): boolean { return this.record?.originConversationId === taskId; }
  currentPreviewId(): string | undefined { return this.record?.upgrade?.plan.id ?? this.plan?.id; }
  get running(): boolean { return this.runFlight !== null; }
  async getUpgradeSnapshot(): Promise<MaintenanceUpgradeSnapshot> {
    await this.ready;
    const record = this.record, upgrade = record?.upgrade;
    if (upgrade) {
      const completed = upgradeCounts(record!);
      return { status: upgrade.phase === "completed" ? "completed" : this.running ? "running" : "interrupted", counts: upgrade.plan.counts,
        preview: this.preview(upgrade.plan), recordId: record!.recordId, taskId: record!.originConversationId,
        completed, ...(record!.progress?.failures[0] ? { message: record!.progress!.failures[0].message } : {}) };
    }
    return { status: this.error ? "failed" : this.plan ? "ready" : "scanning", counts: this.plan?.counts ?? countEmpty(),
      ...(this.plan ? { preview: previewMaintenanceUpgradePlan(this.plan) } : {}), ...(this.error ? { message: this.error } : {}) };
  }
  async previewUpgrade(): Promise<MaintenanceUpgradePreview> {
    await this.ready;
    if (!this.record || this.record.upgrade?.phase === "completed") { this.record = null; await this.scan(); }
    const plan = this.record?.upgrade?.plan ?? this.plan;
    if (!plan || this.error) throw new Error(this.error || "旧资料暂时读不到，请重试。");
    return this.preview(plan);
  }
  async confirmUpgrade(previewId: string): Promise<MaintenanceUpgradeSnapshot> {
    await this.ready;
    if (this.running) return this.getUpgradeSnapshot();
    if (this.record?.upgrade?.phase !== "completed" && this.record?.upgrade) return this.resumeUpgrade();
    const plan = this.plan;
    if (!plan || plan.id !== previewId) throw new Error("这份预览已变化，请重新查看后确认。");
    if ((this.host.bindings()?.revision ?? 0) !== plan.bindingRevision) throw new Error("知识库目录已变化，请重新查看升级预览。");
    for (const item of [...plan.sourceItems, ...plan.wikiItems]) if (version(await this.read(item.path)) !== item.revision) throw new Error("预览中的资料有了新修改，请重新查看后确认。");
    const taskId = await this.host.createTask(), now = Date.now();
    this.record = { schemaVersion: 1, recordId: `maintenance-${randomUUID().replaceAll("-", "")}`, runId: `knowledge-upgrade-${randomUUID()}`,
      originConversationId: taskId, at: now, date: localDateKey(now), summary: "升级旧知识", sources: [],
      result: createKnowledgeMaintenanceResultEnvelope({ status: "partial", issues: [{ code: "upgrade_incomplete", message: "旧知识升级尚未完成。" }] }), progress: newMaintenanceProgress(now),
      upgrade: { version: 1, plan: structuredClone(plan), phase: "classify", classifications: {}, writes: {}, skipped: {}, rootsRegistered: false } };
    holdMaintenancePages(this.record.recordId, this.host.vaultRoot, plan.wikiItems.map(item => item.path));
    await this.persist(); this.start(false);
    return this.getUpgradeSnapshot();
  }
  async stopUpgrade(): Promise<void> {
    this.controller?.abort();
    await this.runFlight;
  }
  async resumeUpgrade(): Promise<MaintenanceUpgradeSnapshot> {
    await this.ready;
    if (!this.record?.upgrade) throw new Error("没有需要继续的升级任务。");
    if (this.record.upgrade.phase === "completed" || this.running) return this.getUpgradeSnapshot();
    this.start(true); return this.getUpgradeSnapshot();
  }
  async dispose(): Promise<void> { await this.stopUpgrade(); }
  private async scan(): Promise<void> {
    if (this.scanFlight) return this.scanFlight;
    const flight = (async () => {
      try {
        this.error = "";
        const records = await this.host.records();
        for (const record of records) if (record.upgrade && record.upgrade.phase !== "completed") {
          holdMaintenancePages(record.recordId, this.host.vaultRoot, record.upgrade.plan.wikiItems.map(item => item.path));
        }
        const unfinished = [...records].filter(record => record.upgrade && record.upgrade.phase !== "completed").sort((a,b) => b.at-a.at)[0];
        if (unfinished) {
          this.record = structuredClone(unfinished);
          const progress = this.record.progress ??= newMaintenanceProgress(Date.now());
          // A persisted running state has no live worker after a restart. Do not
          // count time spent offline or project a phantom running task.
          progress.status = "interrupted";
          delete progress.completedAt;
          if (!progress.failures.length) progress.failures = [{ key: "upgrade", message: "升级上次停下了，已补好的内容会保留，点继续接着处理。", at: Date.now() }];
          this.host.changed(this.record); return;
        }
        const { files, additions } = await this.discover();
        const registry = await readRawDigestRegistry(this.host.vaultRoot, true), latest = latestMaintenanceSourceStates(records);
        const evidence = Object.fromEntries(files.filter(file => file.role !== "wiki").map(file => [file.path, { registry: registry.entries[file.path], maintenance: latest.get(file.path), fingerprint: () => file.fingerprint ?? "" }]));
        this.plan = buildMaintenanceUpgradePlan({ files, evidence, rootAdditions: additions, bindingRevision: this.host.bindings()?.revision ?? 0, id: `upgrade-preview-${randomUUID()}` });
      } catch { this.error = "旧资料检查没完成，请重试；原有文件没有改动。"; }
    })();
    this.scanFlight = flight;
    try { await flight; } finally { this.scanFlight = null; }
  }
  private async discover(): Promise<{ files: MaintenanceUpgradeFile[]; additions: MaintenanceUpgradeRootAddition[] }> {
    const bindings = this.host.bindings() ?? emptyKnowledgeFolderBindings(), roots = new Map<string, MaintenanceUpgradeRootAddition>();
    for (const role of ["raw", "inbox", "wiki", "outputs"] as const) for (const item of bindings.roles[role].readPaths) roots.set(`${role}\0${item}`, { role, path: item });
    for (const name of await fs.readdir(this.host.vaultRoot)) {
      const role = knowledgeRootRole(name);
      if (role && ["raw", "inbox", "wiki", "outputs"].includes(role)) roots.set(`${role}\0${name}`, { role: role as MaintenanceUpgradeRootAddition["role"], path: name });
    }
    for (const root of await this.host.historyRoots?.() ?? []) roots.set(`${root.role}\0${root.path}`, root);
    const additions: MaintenanceUpgradeRootAddition[] = [], files = new Map<string, MaintenanceUpgradeFile>();
    const walk = async (relative: string, role: "raw" | "inbox" | "wiki") => {
      for (const entry of await fs.readdir(this.absolute(relative), { withFileTypes: true })) {
        if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
        const target = `${relative}/${entry.name}`;
        if (entry.isDirectory()) await walk(target, role);
        else if (entry.isFile() && /\.(?:md|markdown)$/iu.test(entry.name) && (role === "wiki" || isKnowledgeMaintenanceSourcePath(target))) {
          const bytes = await fs.readFile(this.absolute(target));
          const content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
          files.set(target, { path: target, role, content, revision: version(content), ...(role !== "wiki" ? { fingerprint: rawDigestFingerprint(target, bytes) } : {}) });
        }
      }
    };
    for (const root of roots.values()) {
      const stat = await this.safeStat(root.path);
      if (!stat) continue;
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("旧目录不是可读取的普通目录。");
      if (!bindings.roles[root.role].readPaths.includes(root.path)) additions.push(root);
      if (root.role !== "outputs") await walk(root.path, root.role);
    }
    return { files: [...files.values()], additions };
  }
  private absolute(relative: string): string {
    if (!relative || relative.startsWith("/") || relative.includes("\\") || relative.split("/").some(part => !part || part === "." || part === "..")) throw new Error("旧资料位置无法安全读取。");
    return path.join(this.host.vaultRoot, relative);
  }
  private async read(relative: string): Promise<string> {
    if (!(await this.safeStat(relative))?.isFile()) throw new Error("旧资料文件暂时读不到。");
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(await fs.readFile(this.absolute(relative)));
  }
  private async safeStat(relative: string) {
    this.absolute(relative);
    let current = this.host.vaultRoot, result: Awaited<ReturnType<typeof fs.lstat>> | null = null;
    for (const segment of relative.split("/")) {
      current = path.join(current, segment);
      result = await fs.lstat(current).catch(error => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; });
      if (!result) return null;
      if (result.isSymbolicLink()) throw new Error("旧资料位置包含链接，保留原文件。");
    }
    return result;
  }
  private preview(plan: MaintenanceUpgradePlan): MaintenanceUpgradePreview {
    const preview = previewMaintenanceUpgradePlan(plan);
    for (const [file, message] of Object.entries(this.record?.upgrade?.skipped ?? {})) {
      const title = [...plan.sourceItems, ...plan.wikiItems].find(item => item.path === file)?.title;
      preview.issues.push({ path: file, title, message, kind: "review", executionFailure: true });
    }
    return preview;
  }
  private start(retry: boolean): void {
    if (this.runFlight) return;
    this.controller = new AbortController();
    const flight = this.run(this.controller.signal, retry);
    this.runFlight = flight;
    void flight.finally(() => { if (this.runFlight === flight) { this.runFlight = null; this.controller = null; if (this.record) this.host.changed(this.record); } }).catch(() => undefined);
  }
  private async run(signal: AbortSignal, retry: boolean): Promise<void> {
    const record = this.record!, state = record.upgrade!, progress = record.progress!;
    let tick = Date.now();
    const stage = async (value: typeof progress.stage, currentPath?: string) => {
      const now = Date.now(); progress.elapsedMs[progress.stage] = (progress.elapsedMs[progress.stage] ?? 0) + now - tick; tick = now;
      progress.stage = value; progress.currentPath = currentPath; progress.status = "running"; progress.failures = []; await this.persist();
    };
    try {
      await this.host.taskStatus(record.originConversationId!, "running"); await stage("scan");
      state.confirmedBindingRevision = await this.host.registerRoots(state.plan.rootAdditions, state.confirmedBindingRevision ?? state.plan.bindingRevision);
      state.rootsRegistered = true; await this.persist();
      state.preserved ??= [];
      if (retry) state.skipped = {};
      const fail = (file: string, message: string) => { state.skipped[file] = message; };
      const preserve = (file: string) => { if (!state.preserved!.includes(file)) state.preserved!.push(file); delete state.skipped[file]; };
      for (const item of state.plan.wikiItems) {
        if (signal.aborted) throw new Error("stopped");
        if (state.writes[item.path]?.done || state.preserved.includes(item.path)) continue;
        await stage("decompose", item.path);
        try {
          const current = await this.read(item.path);
          if (readMaintenanceFrontmatterProperty(current, "类型").present) { preserve(item.path); await this.persist(); continue; }
          if (version(current) !== item.revision) { fail(item.path, "这页有了新修改，保留现状，未补类型。"); await this.persist(); continue; }
          if (!state.classifications[item.path]) state.classifications[item.path] = await this.host.classify(item, record, signal);
          delete state.classificationFailures?.[item.path];
        } catch (error) {
          if (signal.aborted) throw new Error("stopped");
          const controlled = error instanceof KnowledgeUpgradeClassificationError;
          (state.classificationFailures ??= {})[item.path] = controlled ? { reason: error.reason, stopReason: error.stopReason } : { reason: "provider-or-settings" };
          fail(item.path, controlled ? error.message : "这页的类型判断没完成，原文件会保留，点继续重试。");
        }
        await this.persist();
      }
      state.phase = "write"; await stage("plan");
      for (const item of [...state.plan.sourceItems, ...state.plan.wikiItems]) {
        if (signal.aborted) throw new Error("stopped");
        if (state.writes[item.path]?.done || state.preserved.includes(item.path) || state.skipped[item.path]) continue;
        await stage("write", item.path);
        try {
          let write = state.writes[item.path];
          if (!write) {
            const current = await this.read(item.path);
            const source = state.plan.sourceItems.find(source => source.path === item.path);
            const content = source ? patchMaintenanceUpgradeSourceFrontmatter(current, { status: source.addStatus, targetPaths: source.addTargetPaths })
              : appendMaintenancePageType(current, state.classifications[item.path]);
            if (content === current) { preserve(item.path); await this.persist(); continue; }
            if (version(current) !== item.revision) { fail(item.path, "这页在升级期间有了新修改，保留现状，请核对后继续。"); await this.persist(); continue; }
            write = state.writes[item.path] = { operationId: `${record.recordId}:${version(item.path).slice(0, 16)}`, path: item.path, role: source ? "source" : "wiki", expectedVersion: item.revision, content };
            await this.persist();
          }
          const outcome = await serializeMaintenancePage(this.host.vaultRoot, item.path, () => this.host.write(write!, record, signal, retry));
          if (outcome.done) { write.done = true; write.readbackRevision = outcome.revision; delete state.skipped[item.path]; }
          else {
            // A new user property may settle the action, but it never authorizes
            // replaying an old draft over a changed file.
            const current = await this.read(item.path);
            const source = state.plan.sourceItems.find(source => source.path === item.path);
            const missing = source ? patchMaintenanceUpgradeSourceFrontmatter(current, { status: source.addStatus, targetPaths: source.addTargetPaths })
              : appendMaintenancePageType(current, state.classifications[item.path]);
            if (missing === current && current !== write.content) preserve(item.path);
            else fail(item.path, outcome.reason || "这页尚未核对，已保留现状，点继续重试。");
          }
        } catch {
          if (signal.aborted) throw new Error("stopped");
          fail(item.path, "这页的属性没补完，原文件会保留，点继续重试。");
        }
        await this.persist();
      }
      if (signal.aborted) throw new Error("stopped");
      await stage("finalize");
      if (Object.keys(state.skipped).length) {
        progress.status = "interrupted"; delete progress.completedAt;
        progress.failures = [{ key: "upgrade", message: "有些资料没补完，已补好的内容会保留；查看清单后点继续重试。", at: Date.now() }];
        record.result = createKnowledgeMaintenanceResultEnvelope({ status: "partial", issues: [{ code: "upgrade_incomplete", message: "旧知识升级尚未完成。" }] });
        await this.persist(); await this.host.taskStatus(record.originConversationId!, "interrupted"); return;
      }
      state.phase = "completed"; progress.status = "completed"; progress.completedAt = Date.now();
      record.result = createKnowledgeMaintenanceResultEnvelope({ status: "noop" });
      await this.persist(); releaseMaintenancePages(record.recordId); await this.host.taskStatus(record.originConversationId!, "completed");
      if (!progress.notified.includes("upgrade-completed")) {
        progress.notified.push("upgrade-completed"); await this.persist();
        const done = upgradeCounts(record); this.host.notice(`已补好 ${done.sources} 篇资料状态、${done.links} 条链接，为 ${done.wiki} 页 Wiki 补好类型。`);
      }
    } catch (error) {
      const stopped = signal.aborted || (error instanceof Error && error.message === "stopped");
      progress.status = "interrupted"; delete progress.completedAt; progress.failures = [{ key: "upgrade", message: stopped ? "升级已停下，已补好的内容会保留，点继续会接着处理。" : "升级没做完，已补好的内容会保留，请继续重试。", at: Date.now() }];
      await this.persist(); await this.host.taskStatus(record.originConversationId!, "interrupted");
    } finally { progress.elapsedMs[progress.stage] = (progress.elapsedMs[progress.stage] ?? 0) + Date.now() - tick; await this.persist(); }
  }
  private async persist(): Promise<void> { if (this.record) { this.record.progress!.updatedAt = Date.now(); await this.host.save(structuredClone(this.record)); this.host.changed(this.record); } }
}

export function upgradeCounts(record: KnowledgeMaintenanceRecord) {
  const state = record.upgrade!, done = Object.values(state.writes).filter(write => write.done), sources = done.filter(write => write.role === "source");
  return { sources: sources.filter(write => state.plan.sourceItems.find(item => item.path === write.path)?.addStatus !== undefined).length, links: sources.reduce((n, write) => n + (state.plan.sourceItems.find(item => item.path === write.path)?.addTargetPaths?.length ?? 0), 0), wiki: done.filter(write => write.role === "wiki").length };
}

export function createProductionKnowledgeUpgradeService(plugin: CodexForObsidianPlugin): KnowledgeUpgradeService {
  const root = plugin.getVaultPath(), privateRoot = knowledgePrivateRoot(root) ?? path.join(pluginDataDir(root, plugin.getPluginDataDirName()), "pi-agent-product-v1", "knowledge");
  let domain: VaultDomainService | undefined;
  const local = () => plugin.getKnowledgeUpgradeLocalData();
  const service = new KnowledgeUpgradeService({
    vaultRoot: root, bindings: () => plugin.settings.knowledgeBase.folderBindings,
    records: () => readPrivateMaintenanceRecords(privateRoot),
    historyRoots: () => readUpgradeHistoryRoots(pluginDataDir(root, plugin.getPluginDataDirName())),
    save: async record => { const data = await local(); await new FilePhase3MaintenanceStateStore({ storageRootPath: privateRoot, vaultRootPath: root, vaultId: data.deviceScope.vaultIdDigest }).saveUpgradeRecord(record); },
    createTask: async () => { const id = `knowledge-upgrade-${randomUUID()}`; await plugin.createPiConversation({ conversationId: id, title: "升级旧知识", cwd: root, defaultMemoryMode: "no_memory", agentId: plugin.settings.agentRegistry.moduleOwners["knowledge-base"], taskStatus: "running", taskStartedAt: Date.now() }); return id; },
    taskStatus: async (id, status) => { await plugin.setPiConversationTaskMetadata(id, { taskStatus: status, ...(status === "completed" ? { taskCompletedAt: Date.now() } : {}), ...(status === "interrupted" ? { taskInterruptedAt: Date.now() } : {}), pendingResponse: undefined }); plugin.getCodexView?.()?.refreshAgentTasks(); },
    registerRoots: async (roots, revision) => {
      const previous = plugin.settings.knowledgeBase.folderBindings ?? emptyKnowledgeFolderBindings();
      const missing = roots.filter(entry => !previous.roles[entry.role].enabled || !previous.roles[entry.role].readPaths.includes(entry.path));
      // Settings may have been saved just before the maintenance checkpoint
      // failed. Existing additions are already committed and must not duplicate.
      if (!missing.length) return previous.revision;
      if (previous.revision !== revision) throw new Error("知识库目录已变化。");
      const next = structuredClone(previous);
      for (const entry of missing) { next.roles[entry.role].readPaths = [...new Set([...next.roles[entry.role].readPaths, entry.path])]; next.roles[entry.role].enabled = true; }
      next.revision++; plugin.settings.knowledgeBase.folderBindings = next;
      try { await plugin.saveSettings(true); } catch (error) { plugin.settings.knowledgeBase.folderBindings = previous; throw error; }
      return next.revision;
    },
    classify: async (item, record, signal) => classifyKnowledgeUpgradePage(plugin, await local(), { conversationId: record.originConversationId!, runId: record.runId, path: item.path, content: item.content, signal }),
    write: async function performWrite(write, record, signal, retry) {
      const data = await local(), vaultId = data.deviceScope.vaultIdDigest, task = await data.catalog.get(record.originConversationId!);
      if (!task) throw new Error("升级任务会话暂时读不到。");
      domain ??= new VaultDomainService(new ObsidianVaultDomainAdapter(plugin.app, vaultId, root));
      const contract: ApprovalOperationContract = { productRunId: record.runId, toolCallId: `${write.operationId}:attempt-${write.attempt ?? 0}`, conversationId: task.conversationId, piSessionId: task.piSessionId,
        userId: `local-${data.deviceScope.deviceIdDigest}`, deviceId: data.deviceScope.deviceIdDigest, vaultId, toolId: "note_update", toolVersion: "1", policyVersion: "echoink-knowledge-upgrade-v1",
        normalizedArguments: { relativePath: write.path, expectedVersion: write.expectedVersion, contentSha256: version(write.content) }, resolvedTarget: { relativePath: write.path },
        targetVersion: { beforeVersion: write.expectedVersion, expectedAfterSha256: version(write.content) }, preview: { upgradePreviewId: record.upgrade!.plan.id, relativePath: write.path } };
      const identity = createOperationIdentity(contract), inspection = await data.receipts.inspectRecovery(identity);
      if (inspection.state === "receipt_present") {
        if (inspection.receipt.status === "completed" && inspection.receipt.readback.readbackVerified) return { done: true, revision: version(write.content) };
        if (retry && (inspection.receipt.status === "failed" || inspection.receipt.status === "cancelled")) {
          const current = await domain.readback({ vaultId, relativePath: write.path });
          if (current.snapshot?.version === write.expectedVersion) {
            write.attempt = (write.attempt ?? 0) + 1;
            await new FilePhase3MaintenanceStateStore({ storageRootPath: privateRoot, vaultRootPath: root, vaultId }).saveUpgradeRecord(record);
            return performWrite(write, record, signal, false);
          }
        }
        return { done: false, reason: "这页的写入还没核对好，保留现状，请核对后继续。" };
      }
      if (inspection.state === "readback_required") {
        const receipt = await data.receipts.recoverMissingReceipt(identity, async () => {
          const readback = await domain!.readback({ vaultId, relativePath: write.path }), verified = readback.snapshot?.version === version(write.content);
          return { status: verified ? "completed" : "uncertain", safeSummary: "旧知识升级恢复核对", readback: { checkedAt: Date.now(), readbackVerified: verified, observedTargetVersion: readback.snapshot?.version ?? null, safeSummary: "只读核对，不重复写入" } };
        });
        return { done: receipt.status === "completed", revision: version(write.content), reason: "这页有了新修改，保留现状，请核对。" };
      }
      if (inspection.state === "not_found") {
        const authorization = await confirmAndConsumeApprovalTicket({ approvals: data.approvals, contract, signal,
          confirm: async () => record.upgrade!.plan.id === service.currentPreviewId() && !signal.aborted });
        await data.receipts.beginAuthorizedOperation(authorization);
      }
      const result = await domain.noteUpdate({ vaultId, operationIdentity: identity, relativePath: write.path, expectedVersion: write.expectedVersion, content: write.content, signal,
        beforeSideEffect: async () => { await data.receipts.markEffectStarted(identity); } });
      if (result.sideEffectStarted) await data.receipts.markEffectCompleted(identity);
      await data.receipts.persistReceipt({ operationIdentity: identity, status: result.status, safeSummary: "旧知识属性补写", readback: { checkedAt: Date.now(), readbackVerified: result.readbackVerified,
        observedTargetVersion: result.readback.source.snapshot?.version ?? null, safeSummary: result.status === "completed" ? "已写入并核对" : "未完成，保留现状" } });
      return { done: result.status === "completed" && result.readbackVerified, revision: version(write.content), reason: "这页在写入前有了新修改，保留现状。" };
    },
    changed: record => { plugin.getKnowledgeSurfaceService()?.activity.update(record); plugin.refreshKnowledgeBaseSurfaces(); },
    notice: message => new Notice(message)
  });
  return service;
}

/** Read the existing initialization directory history; never move or restore it. */
async function readUpgradeHistoryRoots(pluginRoot: string): Promise<MaintenanceUpgradeRootAddition[]> {
  const index = path.join(pluginRoot, "knowledge/initialization/original-directory-index.json");
  let value: { version?: number; bindings?: KnowledgeFolderBindings; appliedBindings?: KnowledgeFolderBindings; folders?: string[]; createdFolders?: string[]; folderRenames?: { original: string; current: string }[] };
  try { value = JSON.parse(await fs.readFile(index, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  if (value.version !== 1) throw new Error("暂时看不出旧文件夹的位置，原文件先保留，请重试。");
  const roots = new Map<string, MaintenanceUpgradeRootAddition>();
  const add = (role: MaintenanceUpgradeRootAddition["role"], directory: string) => roots.set(`${role}\0${directory}`, { role, path: directory });
  for (const bindings of [value.bindings, value.appliedBindings]) if (bindings) {
    for (const role of ["raw", "inbox", "wiki", "outputs"] as const) for (const directory of bindings.roles[role].readPaths) add(role, directory);
  }
  for (const directory of [...value.folders ?? [], ...value.createdFolders ?? []]) {
    const role = knowledgeRootRole(directory.split("/")[0]);
    if (role === "raw" || role === "inbox" || role === "wiki" || role === "outputs") add(role, directory.split("/")[0]);
  }
  for (const renamed of value.folderRenames ?? []) {
    const role = knowledgeRootRole(renamed.original.split("/")[0]);
    if (role === "raw" || role === "inbox" || role === "wiki" || role === "outputs") { add(role, renamed.original); add(role, renamed.current); }
  }
  return [...roots.values()];
}
