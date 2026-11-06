import {
  deepCheckupPrompt,
  deepFindingSuppressed,
  parseDeepCheckupFindings,
  type DeepCheckupDocument,
  type DeepCheckupSnapshot,
  type DeepCheckupTask,
} from "./knowledge-deep-checkup";
import { planDeepCheckup } from "./knowledge-deep-checkup-plan";

export interface DeepCheckupHost {
  assertModel(): void;
  documents(): Promise<DeepCheckupDocument[]>;
  read(path: string): Promise<DeepCheckupDocument | null>;
  load(): Promise<DeepCheckupTask | null>;
  save(task: DeepCheckupTask): Promise<void>;
  generate(prompt: string, signal: AbortSignal): Promise<string>;
}

/** One durable diagnosis, independent of the page and of the confirmed repair executor. */
export class KnowledgeDeepCheckupTaskService {
  readonly ready: Promise<void>;
  private task: DeepCheckupTask | null = null;
  private flight: Promise<void> | null = null;
  private controller: AbortController | null = null;
  private listeners = new Set<() => void>();
  constructor(private readonly host: DeepCheckupHost) {
    this.ready = this.restore();
  }
  private async restore() {
    this.task = await this.host.load();
    if (this.task?.status === "running") {
      this.task.status = "interrupted";
      this.task.message = "深查上次停下了，继续只查剩余批次。";
    }
  }
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  async snapshot(): Promise<DeepCheckupSnapshot> {
    await this.ready;
    const task = this.task;
    if (!task) return {
      status: "idle", completedDomains: 0, totalDomains: 0, completedBatches: 0,
      totalBatches: 0, calls: 0, findings: [], invalidated: 0,
    };
    const all = [...new Map(task.batches.flatMap((batch) => batch.findings ?? [])
      .map((finding) => [finding.id, finding])).values()];
    const current = new Map(await Promise.all([...new Set(all.flatMap((item) => item.paths))]
      .map(async (path) => [path, await this.host.read(path)] as const)));
    const findings = all.filter((finding) => {
      const docs = finding.paths.map((path) => current.get(path));
      return docs.every((doc) => doc && doc.revision === finding.revisions[doc.path]) &&
        !deepFindingSuppressed(finding.kind, docs as DeepCheckupDocument[]);
    });
    const noteBatches = task.batches.filter((batch) => batch.scope !== "domains");
    const domains = [...new Set(task.documents.map((doc) => doc.domain))];
    return {
      id: task.id,
      status: task.status,
      completedDomains: domains.filter((domain) =>
        noteBatches.filter((batch) => batch.domain === domain).every((batch) => !!batch.completedAt),
      ).length,
      totalDomains: domains.length,
      completedBatches: task.batches.filter((batch) => !!batch.completedAt).length,
      totalBatches: task.batches.length,
      calls: task.batches.reduce((sum, batch) => sum + batch.calls, 0),
      findings,
      invalidated: all.length - findings.length,
      message: task.message,
    };
  }
  async start(confirmCost?: (calls: number, maximumCalls: number) => Promise<boolean>): Promise<void> {
    await this.ready;
    if (this.flight) return;
    this.host.assertModel();
    // Keep an interrupted task until the user explicitly continues it.
    if (this.task?.status === "interrupted") return this.resume();
    const documents = await this.host.documents();
    const batches = planDeepCheckup(documents).filter(batch => batch.scope !== "domains" ||
      !deepFindingSuppressed("nearDomain", batch.paths.map(path => documents.find(doc => doc.path === path)!)));
    if (batches.length > 50 && (!confirmCost || !await confirmCost(batches.length, batches.length * 2))) return;
    this.task = {
      version: 1,
      id: `knowledge-deep-${crypto.randomUUID()}`,
      createdAt: Date.now(),
      status: "running",
      documents: documents.map(({ path, domain, revision }) => ({ path, domain, revision })),
      batches,
    };
    await this.persist();
    this.launch();
  }
  async resume(): Promise<void> {
    await this.ready;
    if (this.flight || !this.task || this.task.status === "completed") return;
    this.host.assertModel();
    this.task.status = "running";
    delete this.task.message;
    await this.persist();
    this.launch();
  }
  async stop(): Promise<void> {
    this.controller?.abort();
    await this.flight;
  }
  async dispose(): Promise<void> {
    await this.stop();
    this.listeners.clear();
  }
  private launch() {
    this.controller = new AbortController();
    const flight = this.run(this.controller.signal);
    this.flight = flight;
    void flight.finally(() => {
      if (this.flight === flight) { this.flight = null; this.controller = null; }
    });
  }
  private async run(signal: AbortSignal) {
    const task = this.task!;
    try {
      for (const batch of task.batches) {
        if (batch.completedAt) continue;
        if (signal.aborted) throw new Error("stopped");
        const documents: DeepCheckupDocument[] = [];
        for (const path of batch.paths) {
          const doc = await this.host.read(path);
          if (doc) documents.push(doc);
        }
        if (!documents.some((doc) => batch.primary.includes(doc.path))) {
          batch.findings = [];
          batch.completedAt = Date.now();
          await this.persist();
          continue;
        }
        // Two automatic attempts in the original budget; an explicit later resume gets one attempt.
        const attempts = Math.max(1, 2 - batch.calls);
        for (let attempt = 0; attempt < attempts; attempt++) {
          if (signal.aborted) throw new Error("stopped");
          batch.calls++;
          await this.persist();
          const output = await this.host.generate(deepCheckupPrompt(batch, documents), signal);
          if (signal.aborted) throw new Error("stopped");
          try {
            const parsed = parseDeepCheckupFindings(output, documents, batch.scope);
            batch.findings = [...new Map([...(batch.findings ?? []), ...parsed.findings]
              .map(finding => [finding.id, finding])).values()];
            batch.discarded = parsed.discarded.length;
            if (parsed.discarded.length) batch.error = "部分发现缺少可核对的原文。";
            else { delete batch.error; batch.completedAt = Date.now(); }
          } catch (error) {
            if (signal.aborted) throw error;
            batch.error = error instanceof Error ? error.message : "本批返回未通过校验。";
          }
          await this.persist();
          if (batch.completedAt) break;
        }
      }
      const unfinished = task.batches.filter(batch => !batch.completedAt).length;
      task.status = unfinished ? "interrupted" : "completed";
      if (unfinished) task.message = `有 ${unfinished} 批未核对完，已保留有效发现；继续只查剩余批次。`;
      else delete task.message;
    } catch (error) {
      task.status = "interrupted";
      task.message = signal.aborted ? "深查已停止，继续只查剩余批次。"
        : error instanceof Error ? error.message : "本批深查未完成，请继续重试。";
    }
    await this.persist();
  }
  private async persist() {
    await this.host.save(structuredClone(this.task!));
    for (const listener of this.listeners) listener();
  }
}
