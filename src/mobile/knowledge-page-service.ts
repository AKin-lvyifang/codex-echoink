import type { MobileKnowledgePagePort } from "./knowledge-page-contracts";
import type { MobileServices } from "./services";
import type { EventRef } from "obsidian";
import { aggregateKnowledgePageActivity, type KnowledgePageSnapshot } from "../home/knowledge-page-core";
import { emptyKnowledgeFolderBindings, knowledgeFolderBindingsSignature, classifyKnowledgePath, type KnowledgeFolderBindings } from "../knowledge-base/folder-bindings";
import { KnowledgeLinkHealthService } from "../knowledge-base/link-health";
import { mergeKnowledgeMaintenanceHistory } from "../knowledge-base/maintenance-history-core";
import { loadKnowledgeSourceHealthCore } from "../knowledge-base/source-health-core";
import { extractMachineSourceMarkers } from "../knowledge-base/knowledge-maintenance-sources-core";
import { openObsidianFolderGraphLeaf } from "../home/open-native-graph";
import { scanKnowledgePageRole, pagePathWithin } from "./knowledge-page-scan";
import { mobileKnowledgeSourcesHost, strictKnowledgePagePath } from "./knowledge-page-paths";
import { loadMobileKnowledgeHealth } from "./knowledge-page-health";
import { validateKnowledgePageRecord } from "./knowledge-page-records";
import type { KnowledgeMaintenanceRecord } from "../knowledge-base/maintenance-record";

/** Read-only product data. Reads never initialize files or notify their own subscribers. */
export class MobileKnowledgePageService implements MobileKnowledgePagePort {
  private readonly links: KnowledgeLinkHealthService;
  private readonly vaultRefs: EventRef[];
  private readonly metadataRefs: EventRef[];
  private readonly listeners = new Set<() => void>();
  private generation = 0;
  private disposed = false;
  private notificationPending = false;
  constructor(private readonly services: MobileServices) {
    const app = services.app;
    this.links = new KnowledgeLinkHealthService(app);
    const changed = () => this.invalidate();
    this.vaultRefs = [app.vault.on("create", changed), app.vault.on("modify", changed), app.vault.on("rename", changed), app.vault.on("delete", changed)];
    this.metadataRefs = [app.metadataCache.on("resolved", changed), app.metadataCache.on("changed", changed), app.metadataCache.on("deleted", changed)];
  }
  /** The host also calls this after an actual settings save; it is not called by read. */
  invalidate(): void {
    if (this.disposed) return;
    this.generation++;
    if (this.notificationPending) return;
    this.notificationPending = true;
    void Promise.resolve().then(() => {
      this.notificationPending = false;
      if (!this.disposed) for (const listener of [...this.listeners]) { try { listener(); } catch { /* A view cannot interrupt source updates. */ } }
    });
  }
  subscribe: MobileKnowledgePagePort["subscribe"] = listener => {
    if (this.disposed) return () => {};
    this.listeners.add(listener); return () => { this.listeners.delete(listener); };
  };
  private signature(): string {
    return `${this.services.settings.knowledgeBase.folderBindings?.revision ?? 0}:${knowledgeFolderBindingsSignature(this.services.settings.knowledgeBase.folderBindings)}`;
  }
  private snapshotGuard(signal?: AbortSignal): { bindings: KnowledgeFolderBindings; check: () => void } {
    const signature = this.signature(), generation = this.generation;
    const check = () => {
      if (signal?.aborted || this.disposed) throw new Error("已停止读取知识页面。");
      if (signature !== this.signature() || generation !== this.generation) throw new Error("知识目录或文件已变化，请重新读取。");
    };
    check(); return { bindings: structuredClone(this.services.settings.knowledgeBase.folderBindings ?? emptyKnowledgeFolderBindings()), check };
  }
  private async records(check: () => void): Promise<{ records: KnowledgeMaintenanceRecord[]; error?: string }> {
    const path = `${this.services.directory.replace(/\/mobile$/u, "")}/pi-agent-product-v1/knowledge/records`, adapter = this.services.app.vault.adapter;
    const records: KnowledgeMaintenanceRecord[] = [];
    try {
      const stat = await adapter.stat(path); check();
      if (!stat) {
        return { records, ...((this.services.settings.knowledgeBase.maintenanceHistory ?? []).some(entry => entry.recordId) ? { error: "部分维护记录尚未同步或无法读取。" } : {}) };
      }
      if (stat.type !== "folder") throw new Error("记录位置不可用");
      const listed = await adapter.list(path); check();
      let failed = false;
      for (const file of listed.files) {
        const match = /\/(maintenance-[a-f0-9]{32})\.json$/u.exec(file);
        if (!match || file !== `${path}/${match[1]}.json`) continue;
        try { records.push(await this.readRecord(match[1])); } catch { check(); failed = true; }
        check();
      }
      if ((this.services.settings.knowledgeBase.maintenanceHistory ?? []).some(entry => entry.recordId && !records.some(record => record.recordId === entry.recordId))) failed = true;
      return { records: records.sort((a, b) => b.at - a.at), ...(failed ? { error: "部分维护记录损坏、缺失或尚未同步。" } : {}) };
    } catch { check(); return { records, error: "维护记录暂时无法读取。" }; }
  }
  read: MobileKnowledgePagePort["read"] = async signal => {
    const { bindings, check: checkSnapshot } = this.snapshotGuard(signal), now = Date.now(), app = this.services.app;
    const check = () => checkSnapshot();
    const errors: KnowledgePageSnapshot["errors"] = {};
    const scans = await Promise.all((["raw", "wiki", "projects", "inbox"] as const).map(role => scanKnowledgePageRole(app.vault.adapter, bindings, role, check)));
    check();
    const loaded = await this.records(check), maintenanceHistory = mergeKnowledgeMaintenanceHistory(this.services.settings.knowledgeBase.maintenanceHistory ?? [], loaded.records);
    if (loaded.error) errors.history = loaded.error;
    const wiki = scans.find(scan => scan.directory.role === "wiki")!;
    const activity = aggregateKnowledgePageActivity(wiki.files, maintenanceHistory, now);
    if (wiki.directory.state !== "ready" || activity.weekly.unknownCreatedAtCount > 0) {
      activity.weekly.added = null; errors.activity = wiki.directory.state !== "ready" ? "知识成果位置尚未完整读取。" : "部分笔记创建时间无法核实，暂不显示完整新增数。";
    }
    if (errors.history) { activity.weekly.organized = null; errors.activity = [errors.activity, "维护活动记录尚未完整读取。"].filter(Boolean).join("；"); }
    if (scans.some(scan => scan.directory.state === "partial" || scan.directory.state === "unavailable")) errors.directories = "部分目录尚未完整读取，请重试。";
    const links = await this.links.load(bindings); check();
    if (links.state === "unknown") errors.links = links.reason ?? "笔记链接仍在解析。";
    const sourcesHost = mobileKnowledgeSourcesHost(bindings);
    const sources = await loadKnowledgeSourceHealthCore(bindings, wiki.files.map(file => file.path), {
      kind: async path => {
        check();
        try { strictKnowledgePagePath(path); const stat = await app.vault.adapter.stat(path); check(); return stat?.type === "file" ? "file" : stat?.type === "folder" ? "folder" : "missing"; }
        catch { check(); return "unknown"; }
      },
      read: async path => { check(); const text = await app.vault.adapter.read(strictKnowledgePagePath(path)); check(); return text; },
      markers: text => extractMachineSourceMarkers(text, sourcesHost), assertActive: check
    });
    if (wiki.directory.state !== "ready") { sources.state = sources.checkedCount ? "partial" : "unknown"; errors.sources = "知识成果位置尚未完整读取，来源状态未核实。"; }
    let health: KnowledgePageSnapshot["health"] = null;
    try { health = await loadMobileKnowledgeHealth(this.services, bindings, scans, maintenanceHistory, check); if (!health) errors.health = "尚未启用可评估的知识用途位置。"; }
    catch (error) { check(); errors.health = error instanceof Error ? error.message : "健康状态暂时无法核实。"; }
    check();
    return { generatedAt: now, bindings, dashboard: null, health, ...activity, directories: scans.map(scan => scan.directory), links, sources,
      maintenanceHistory, maintenanceRecords: loaded.records, errors };
  };
  readFolder: MobileKnowledgePagePort["readFolder"] = async (path, signal) => {
    const { bindings, check: checkSnapshot } = this.snapshotGuard(signal); const check = () => checkSnapshot(); strictKnowledgePagePath(path);
    const role = classifyKnowledgePath(bindings, path);
    if (role !== "raw" && role !== "wiki" && role !== "projects" && role !== "inbox") throw new Error("目录不在当前已启用的知识用途范围。");
    if (!bindings.roles[role].readPaths.some(root => pagePathWithin(path, root))) throw new Error("目录不在当前绑定范围。");
    if ((await this.services.app.vault.adapter.stat(path))?.type !== "folder") throw new Error("目录已失效，请重新选择。"); check();
    const scoped = structuredClone(bindings); scoped.roles[role].readPaths = [path];
    const scanned = await scanKnowledgePageRole(this.services.app.vault.adapter, scoped, role, check); check();
    if (scanned.directory.state !== "ready") throw new Error("目录尚未完整读取，请重试。");
    return { path, files: scanned.files.map(file => ({ path: file.path, title: file.path.slice(file.path.lastIndexOf("/") + 1).replace(/\.(?:md|markdown)$/iu, ""), mtime: file.mtime })).sort((a, b) => b.mtime - a.mtime || a.path.localeCompare(b.path)) };
  };
  readRecord: MobileKnowledgePagePort["readRecord"] = async id => {
    if (this.disposed) throw new Error("知识页面已关闭。");
    if (!/^maintenance-[a-f0-9]{32}$/u.test(id)) throw new Error("维护记录身份无效。");
    const record = await this.services.readMaintenanceRecord(id);
    if (this.disposed) throw new Error("知识页面已关闭。");
    return validateKnowledgePageRecord(record, id);
  };
  openGraph: MobileKnowledgePagePort["openGraph"] = async () => {
    const { bindings, check: checkSnapshot } = this.snapshotGuard(), roots: string[] = [];
    const check = () => checkSnapshot();
    for (const role of ["wiki", "projects"] as const) if (bindings.roles[role].enabled) for (const root of bindings.roles[role].readPaths) {
      strictKnowledgePagePath(root); if ((await this.services.app.vault.adapter.stat(root))?.type === "folder") roots.push(root); check();
    }
    if (!roots.length) throw new Error("尚未设置有效的知识成果或项目目录。");
    check(); if (!await openObsidianFolderGraphLeaf(this.services.app, roots, this.services.settings.settingsLanguage)) throw new Error("当前宿主暂时无法打开图谱。");
  };
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.generation++;
    this.links.dispose(); this.vaultRefs.forEach(ref => this.services.app.vault.offref(ref)); this.metadataRefs.forEach(ref => this.services.app.metadataCache.offref(ref)); this.listeners.clear();
  }
}
