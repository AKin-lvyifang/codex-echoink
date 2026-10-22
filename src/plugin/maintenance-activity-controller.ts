import { MAINTENANCE_ACTIVITY_STAGES, maintenanceBatchContext, maintenanceRecordStage, newMaintenanceProgress, type MaintenanceActivity, type MaintenanceActivityLifecycle, type MaintenanceActivityProgress, type MaintenanceActivityStage, type MaintenanceInitialActivity } from "../knowledge-base/maintenance-activity";
import type { KnowledgeMaintenanceRecord } from "../knowledge-base/maintenance-record";
import type { PiKnowledgeMaintenanceToolInput } from "../harness/pi-native/contracts";
import type { FileProductRunStore } from "../harness/pi-native/file-product-run-store";
import type { FilePhase3MaintenanceStateStore } from "./pi-knowledge-maintenance-production";

interface ActiveMaintenance {
  runId: string;
  recordId?: string;
  initial: MaintenanceInitialActivity;
  liveSince: number | null;
}
interface ActivityHost {
  state: Pick<FilePhase3MaintenanceStateStore, "saveP1Record" | "updateP1Progress">;
  records(): Promise<KnowledgeMaintenanceRecord[]>;
  runs?: Pick<FileProductRunStore, "read" | "setMaintenanceActivity" | "list">;
  now(): number;
  liveCheckpoint?: boolean;
  onRecord?(record: Readonly<KnowledgeMaintenanceRecord>, holdForHandoff?: boolean): void;
  onInitial?(activity: Readonly<MaintenanceActivity>): void;
  onSettled?(recordId: string): void;
  onInitialSettled?(id: string): void;
  notice?(message: string): void;
}

/** Durable clock checkpoints share the same record/file-write lane as page receipts. */
export class MaintenanceActivityController {
  private readonly active = new Map<string, ActiveMaintenance>();
  private lane: Promise<unknown> = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | undefined;
  private disposed = false;
  constructor(private readonly host: ActivityHost) {}
  async initialize(): Promise<void> {
    for (const record of await this.host.records()) {
      // Never use persisted updatedAt as a live stopwatch on a new process.
      if (record.progress && ["running", "waiting"].includes(record.progress.status)) {
        const saved = await this.host.state.updateP1Progress(record.recordId, latest => {
          latest.progress!.status = "interrupted"; latest.progress!.waitingReasons = []; latest.progress!.updatedAt = this.host.now();
        });
        if (saved) this.host.onRecord?.(saved);
      } else this.host.onRecord?.(record);
    }
  }
  lifecycle(event: Readonly<MaintenanceActivityLifecycle>): Promise<void> {
    return this.serial(async () => {
      if (this.disposed) return;
      let active = this.active.get(event.conversationId);
      if (event.type === "start") {
        if (active?.runId === event.productRunId) return;
        const record = (await this.host.records()).filter(r => r.originConversationId === event.conversationId && r.p1 && r.p1.phase !== "completed").sort((a,b) => b.at - a.at)[0];
        const prior = record ? undefined : (await this.host.runs?.list(event.conversationId))?.filter(run => run.maintenanceActivity && !run.maintenanceActivity.recordId && run.maintenanceActivity.progress.status !== "completed").sort((a,b) => b.createdAt - a.createdAt)[0]?.maintenanceActivity;
        const progress = structuredClone(record?.progress ?? prior?.progress ?? newMaintenanceProgress(this.host.now()));
        progress.waitingReasons = []; progress.status = "running";
        progress.batch ??= maintenanceBatchContext(event.request ?? "");
        active = { runId: event.productRunId, recordId: record?.recordId, initial: { version: 1, sourcePaths: [...(record?.sources.map(s => s.path) ?? prior?.sourcePaths ?? event.sourcePaths ?? [])], progress }, liveSince: this.host.now() };
        this.active.set(event.conversationId, active);
        if (record) await this.patch(active, record.recordId, progress => { progress.status = "running"; progress.waitingReasons = []; });
        else await this.persistInitial(event.conversationId, active);
        this.arm(); return;
      }
      if (!active || active.runId !== event.productRunId) return;
      if (event.type === "waiting") {
        await this.mutate(event.conversationId, active, progress => {
          const reasons = new Set(progress.waitingReasons), reason = event.reason ?? "question";
          if (event.waiting) reasons.add(reason); else reasons.delete(reason);
          progress.waitingReasons = [...reasons];
          if (!["completed", "interrupted", "partial"].includes(progress.status)) progress.status = reasons.size ? "waiting" : "running";
        });
      } else if (event.type === "stage") {
        await this.mutate(event.conversationId, active, progress => {
          if (event.stage && MAINTENANCE_ACTIVITY_STAGES.indexOf(event.stage) >= MAINTENANCE_ACTIVITY_STAGES.indexOf(progress.stage)) progress.stage = event.stage;
          if (event.currentPath) progress.currentPath = event.currentPath;
        });
      } else {
        await this.mutate(event.conversationId, active, progress => {
          if (progress.status !== "completed") progress.status = event.failed ? "failed" : "interrupted";
          progress.waitingReasons = [];
        });
        if (event.type === "settled") {
          if (active.recordId) await this.notifyTerminal(active.recordId, event.productRunId, event.failed === true);
          else await this.notifyInitial(event.conversationId, active);
        }
        this.active.delete(event.conversationId);
        if (!this.active.size) this.disarm();
      }
    });
  }
  async beforeTool(input: Readonly<PiKnowledgeMaintenanceToolInput>): Promise<void> {
    if (this.active.get(input.conversationId)?.runId !== input.productRunId) await this.lifecycle({ type: "start", conversationId: input.conversationId, productRunId: input.productRunId, sourcePaths: input.sourcePaths ?? input.globalSourcePaths, request: input.request });
    await this.serial(async () => {
      const active = this.active.get(input.conversationId);
      if (!active || active.runId !== input.productRunId) return;
      await this.mutate(input.conversationId, active, progress => {
        if (!["completed", "waiting"].includes(progress.status)) progress.status = "running";
        progress.currentPath = input.p1?.decompositions?.[0]?.sourcePath ?? input.p1?.targetPath ?? progress.currentPath;
      });
    });
  }
  async save(record: KnowledgeMaintenanceRecord): Promise<void> {
    await this.serial(async () => {
      const active = record.originConversationId ? this.active.get(record.originConversationId) : undefined;
      await this.host.state.saveP1Record(record, (current, previous) => {
        const progress = this.advance(structuredClone(previous ?? active?.initial.progress ?? current.progress ?? newMaintenanceProgress(this.host.now(), maintenanceRecordStage(current))), active);
        progress.stage = maintenanceRecordStage(current);
        if (current.p1?.phase === "completed") { progress.status = "completed"; progress.completedAt ??= this.host.now(); progress.waitingReasons = []; progress.currentPath = undefined; }
        return progress;
      });
      if (active && !active.recordId) {
        active.recordId = record.recordId;
        // Once bound this ProductRun carries only the pointer, never a second advancing ledger.
        active.initial.recordId = record.recordId;
        await this.persistRun(active);
      }
      this.host.onRecord?.(record, record.p1?.phase === "completed");
    });
  }
  async afterTool(input: Readonly<PiKnowledgeMaintenanceToolInput>, failed: boolean, message: string): Promise<void> {
    await this.serial(async () => {
      const active = this.active.get(input.conversationId);
      if (!active) return;
      const key = `${input.p1?.stage ?? "maintain"}:${input.p1?.pageId ?? input.p1?.targetPath ?? input.p1?.decompositions?.[0]?.sourcePath ?? "batch"}`;
      const update = (progress: MaintenanceActivityProgress, record?: KnowledgeMaintenanceRecord) => {
        progress.failures = progress.failures.filter(item => {
          if (item.key === key || record?.p1?.phase === "completed") return false;
          if (item.key.startsWith("write:") && record?.p1?.committedPages[item.key.slice(6)]) return false;
          if (item.key === "plan:batch" && record?.p1 && ["write", "finalize"].includes(record.p1.phase)) return false;
          if (item.key.startsWith("decompose:") && record?.p1?.decompositions.some(d => d.sourcePath === item.key.slice(10))) return false;
          return true;
        });
        if (failed) {
          progress.failures.push({ key, message: message.slice(0, 500), at: this.host.now() });
        }
      };
      if (active.recordId) await this.patch(active, active.recordId, update);
      else await this.mutate(input.conversationId, active, update);
    });
  }
  async noop(conversationId: string, runId: string): Promise<void> {
    await this.serial(async () => {
      const active = this.active.get(conversationId);
      if (!active || active.runId !== runId || active.recordId) return;
      this.advance(active.initial.progress, active);
      active.initial.progress.status = "completed"; active.initial.progress.completedAt ??= this.host.now();
      active.liveSince = null;
      await this.persistRun(active);
      this.active.delete(conversationId); this.host.onInitialSettled?.(`run:${runId}`);
      if (!this.active.size) this.disarm();
    });
  }
  async complete(recordId: string, runId: string): Promise<void> {
    await this.serial(async () => { await this.notifyTerminal(recordId, runId, false); this.host.onSettled?.(recordId); });
  }
  async dispose(): Promise<void> {
    this.disarm();
    for (const [conversationId, active] of this.active) await this.lifecycle({ type: "stop", conversationId, productRunId: active.runId });
    this.disposed = true;
  }
  private async notifyTerminal(recordId: string, runId: string, failed: boolean): Promise<void> {
    let notice = "";
    const record = await this.host.state.updateP1Progress(recordId, record => {
      const progress = record.progress ??= newMaintenanceProgress(this.host.now(), maintenanceRecordStage(record));
      const complete = record.p1?.phase === "completed";
      const key = complete ? "completed" : `settled:${runId}`;
      if (progress.notified.includes(key)) return;
      progress.notified.push(key);
      if (complete) { progress.status = "completed"; progress.completedAt ??= this.host.now(); notice = `知识库维护完成：${new Set(Object.values(record.p1!.committedPages).map(page => page.path)).size} 页 Wiki 已保存。`; }
      else {
        const count = Object.keys(record.p1!.committedPages).length;
        progress.status = count ? "partial" : failed ? "failed" : "interrupted";
        notice = count ? `知识库维护部分完成：已保存 ${count} 页，可继续剩余内容。` : "知识库维护尚未完成，可继续原清单。";
      }
    });
    if (record) this.host.onRecord?.(record);
    if (notice) this.host.notice?.(notice);
  }
  private async notifyInitial(conversationId: string, active: ActiveMaintenance): Promise<void> {
    const key = `settled:${active.runId}`;
    if (active.initial.progress.notified.includes(key)) return;
    active.initial.progress.notified.push(key);
    await this.persistInitial(conversationId, active);
    this.host.notice?.("知识库维护未完成，可回到原任务继续。");
  }
  private advance(progress: MaintenanceActivityProgress, active?: ActiveMaintenance): MaintenanceActivityProgress {
    const now = this.host.now();
    if (active?.liveSince !== null && active?.liveSince !== undefined && progress.status === "running" && !progress.waitingReasons.length) progress.elapsedMs[progress.stage] = (progress.elapsedMs[progress.stage] ?? 0) + Math.max(0, now - active.liveSince);
    progress.updatedAt = now;
    if (active) active.liveSince = progress.status === "running" && !progress.waitingReasons.length ? now : null;
    return progress;
  }
  private async patch(active: ActiveMaintenance, recordId: string, update: (progress: MaintenanceActivityProgress, record: KnowledgeMaintenanceRecord) => void): Promise<void> {
    const record = await this.host.state.updateP1Progress(recordId, record => {
      const progress = this.advance(record.progress ?? newMaintenanceProgress(this.host.now(), maintenanceRecordStage(record)), active);
      update(progress, record); record.progress = progress;
      active.liveSince = progress.status === "running" && !progress.waitingReasons.length ? this.host.now() : null;
    });
    if (record) this.host.onRecord?.(record, record.p1?.phase === "completed");
  }
  private async mutate(conversationId: string, active: ActiveMaintenance, update: (progress: MaintenanceActivityProgress) => void): Promise<void> {
    if (active.recordId) return this.patch(active, active.recordId, update);
    const progress = this.advance(active.initial.progress, active); update(progress);
    active.liveSince = progress.status === "running" && !progress.waitingReasons.length ? this.host.now() : null;
    await this.persistInitial(conversationId, active);
  }
  private async persistRun(active: ActiveMaintenance): Promise<void> {
    await this.host.runs?.setMaintenanceActivity(active.runId, active.initial);
  }
  private async persistInitial(conversationId: string, active: ActiveMaintenance): Promise<void> {
    await this.persistRun(active);
    const progress = active.initial.progress;
    this.host.onInitial?.({ kind: "maintenance", id: `run:${active.runId}`, originConversationId: conversationId, status: progress.status,
      stage: progress.stage, steps: MAINTENANCE_ACTIVITY_STAGES.map(stage => ({ stage, completed: 0, total: stage === "decompose" && active.initial.sourcePaths.length ? active.initial.sourcePaths.length : null, state: stage === progress.stage ? "running" : "pending" })),
      sourceCount: active.initial.sourcePaths.length || null, sourcePaths: [...active.initial.sourcePaths], batch: progress.batch ?? { index: 1, total: 1 }, currentPath: progress.currentPath,
      activeElapsedMs: Object.values(progress.elapsedMs).reduce((sum, n) => sum + n, 0), etaMs: null, failures: progress.failures, updatedAt: progress.updatedAt });
  }
  private arm(): void {
    if (this.timer || !this.host.liveCheckpoint) return;
    this.timer = setInterval(() => { void this.serial(async () => {
      for (const [conversationId, active] of this.active) if (active.liveSince !== null) await this.mutate(conversationId, active, () => {});
    }).catch(error => console.error("Maintenance progress checkpoint failed", error)); }, 1000);
    this.timer.unref?.();
  }
  private disarm(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; }
  private serial<T>(action: () => Promise<T>): Promise<T> { const next = this.lane.then(action); this.lane = next.catch(() => undefined); return next; }
}
