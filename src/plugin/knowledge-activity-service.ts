import { projectMaintenanceActivity, type KnowledgeActivity, type KnowledgeActivitySnapshot, type KnowledgeActivitySource, type MaintenanceActivity } from "../knowledge-base/maintenance-activity";
import type { KnowledgeMaintenanceRecord } from "../knowledge-base/maintenance-record";
import type { KnowledgeLinkingTask } from "../knowledge-base/knowledge-linking-types";

/** One plugin-owned read projection; views never create tasks or advance clocks. */
export class KnowledgeActivityService implements KnowledgeActivitySource {
  readonly ready: Promise<void>;
  private readonly maintenance = new Map<string, Readonly<MaintenanceActivity>>();
  private linking: Readonly<KnowledgeLinkingTask> | null = null;
  private value: Readonly<KnowledgeActivitySnapshot> = { primary: null, other: null, maintenance: [] };
  private readonly listeners = new Set<(snapshot: Readonly<KnowledgeActivitySnapshot>) => void>();
  private restored = false;
  private visibleSignature = "";
  private readonly unsubscribe: () => void;
  private holdCompleted = new Set<string>();
  constructor(private readonly linkingSource: { ready: Promise<void>; snapshot?(): KnowledgeLinkingTask | null; subscribe(listener: (task: KnowledgeLinkingTask | null) => void): () => void }, load: () => Promise<readonly Readonly<KnowledgeMaintenanceRecord>[]>, loadInitial?: () => Promise<readonly MaintenanceActivity[]>) {
    const linking = linkingSource;
    this.unsubscribe = linking.subscribe(task => { this.linking = task; this.publish(); });
    this.ready = Promise.all([linking.ready, load().then(records => {
      for (const record of records) {
        const activity = projectMaintenanceActivity(record);
        if (activity && !this.maintenance.has(activity.id)) this.maintenance.set(activity.id, { ...activity, status: activity.status === "running" || activity.status === "waiting" ? "interrupted" : activity.status });
      }
    }), loadInitial?.().then(activities => {
      for (const activity of activities) if (!this.maintenance.has(activity.id)) this.maintenance.set(activity.id, { ...activity, status: ["running", "waiting"].includes(activity.status) ? "interrupted" : activity.status });
    })]).then(() => {
      // A crash may occur after record save and before the ProductRun pointer bind.
      // Reconcile only after both independent reads, regardless of completion order.
      const latestInitial = new Map<string, Readonly<MaintenanceActivity>>();
      for (const [id, initial] of this.maintenance) if (id.startsWith("run:")) {
        const previous = latestInitial.get(initial.originConversationId);
        if (previous && previous.updatedAt > initial.updatedAt) this.maintenance.delete(id);
        else { if (previous) this.maintenance.delete(previous.id); latestInitial.set(initial.originConversationId, initial); }
      }
      for (const [id, initial] of this.maintenance) if (id.startsWith("run:") && [...this.maintenance.values()].some(record => !record.id.startsWith("run:") && record.originConversationId === initial.originConversationId && record.updatedAt >= initial.updatedAt)) this.maintenance.delete(id);
      this.restored = true; this.publish();
    });
  }
  snapshot(): Readonly<KnowledgeActivitySnapshot> { return this.value; }
  subscribe(listener: (snapshot: Readonly<KnowledgeActivitySnapshot>) => void): () => void {
    this.listeners.add(listener); listener(this.value); return () => this.listeners.delete(listener);
  }
  update(record: Readonly<KnowledgeMaintenanceRecord>, holdForHandoff = false): void {
    const activity = projectMaintenanceActivity(record);
    if (!activity) return;
    const previous = this.maintenance.get(activity.id);
    this.maintenance.set(activity.id, activity);
    if (holdForHandoff && activity.status === "completed" && previous?.status !== "completed") this.holdCompleted.add(activity.id);
    this.publish();
  }
  updateInitial(activity: Readonly<MaintenanceActivity>): void {
    // Binding replaces the ProductRun entry; it never creates a second task card.
    for (const [id, old] of this.maintenance) if (id.startsWith("run:") && old.originConversationId === activity.originConversationId) this.maintenance.delete(id);
    this.maintenance.set(activity.id, activity); this.publish();
  }
  bind(record: Readonly<KnowledgeMaintenanceRecord>): void {
    for (const [id, old] of this.maintenance) if (id.startsWith("run:") && old.originConversationId === record.originConversationId) this.maintenance.delete(id);
    this.update(record, record.p1?.phase === "completed");
  }
  settle(recordId: string): void {
    // Linking persists its new task before start returns, but batches subscriber
    // notifications. Read that same committed snapshot before releasing the slot.
    if (this.linkingSource.snapshot) this.linking = this.linkingSource.snapshot();
    this.holdCompleted.delete(recordId); this.publish();
  }
  dropInitial(id: string): void { this.maintenance.delete(id); this.publish(); }
  dispose(): void { this.unsubscribe(); this.listeners.clear(); }
  private publish(): void {
    if (!this.restored) return;
    const maintenance = [...this.maintenance.values()].sort((a,b) => b.updatedAt - a.updatedAt);
    const visible = maintenance.filter(activity => activity.status === "running" || activity.status === "waiting" || this.holdCompleted.has(activity.id));
    const task = this.linking;
    const linked: KnowledgeActivity | null = task && !task.dismissed && ["queued", "scanning", "judging", "awaiting-confirmation", "writing"].includes(task.phase) ? {
      kind: "linking", id: task.id, originConversationId: task.originConversationId, task, updatedAt: task.updatedAt,
      status: task.phase === "awaiting-confirmation" ? "waiting" : task.phase === "interrupted" ? "interrupted" : task.phase === "failed" ? "failed" : task.phase === "partial" ? "partial" : "running"
    } : null;
    const activities: KnowledgeActivity[] = [...visible, ...(linked ? [linked] : [])];
    const rank = (activity: KnowledgeActivity) => activity.status === "waiting" ? 0 : activity.kind === "maintenance" && activity.status === "running" ? 1 : activity.kind === "linking" ? 2 : 3;
    activities.sort((a,b) => rank(a) - rank(b) || b.updatedAt - a.updatedAt);
    this.value = deepFreeze({ primary: activities[0] ?? null, other: activities[1] ?? null, maintenance });
    const signature = JSON.stringify(this.value, (key, value: unknown) => key === "updatedAt" || key === "activeElapsedMs" ? undefined : key === "etaMs" && typeof value === "number" ? Math.ceil(value / 60_000) : value);
    if (signature === this.visibleSignature) return;
    this.visibleSignature = signature;
    for (const listener of this.listeners) { try { listener(this.value); } catch (error) { console.error("Knowledge activity subscriber failed", error); } }
  }
}
function deepFreeze<T>(value: T): Readonly<T> {
  if (value && typeof value === "object" && !Object.isFrozen(value)) { for (const child of Object.values(value)) deepFreeze(child); Object.freeze(value); }
  return value;
}
