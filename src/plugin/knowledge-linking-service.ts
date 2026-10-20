import { createHash, randomUUID } from "node:crypto";
import { buildKnowledgeLinkingTargets, scanKnowledgeLinkingMentions, buildKnowledgeLinkingPatch, selectKnowledgeLinkingMentions } from "../knowledge-base/knowledge-linking";
import type { KnowledgeLinkingDocument, KnowledgeLinkingMention, KnowledgeLinkingProposal, KnowledgeLinkingTarget, KnowledgeLinkingTask, KnowledgeLinkingOrigin } from "../knowledge-base/knowledge-linking-types";
import type { KnowledgeLinkingStateStore } from "../knowledge-base/knowledge-linking-state";

export interface KnowledgeLinkingHost {
  automaticEnabled?(): boolean;
  documents(origin?: Readonly<KnowledgeLinkingOrigin>): AsyncIterable<KnowledgeLinkingDocument>;
  judge(input: KnowledgeLinkingOrigin & { taskId: string; documents: KnowledgeLinkingDocument[]; targets: KnowledgeLinkingTarget[]; candidates: Array<KnowledgeLinkingMention & { path: string }>; allowAliases: boolean; signal: AbortSignal }): Promise<KnowledgeLinkingProposal[]>;
  read(path: string, origin?: Readonly<KnowledgeLinkingOrigin>): Promise<string>;
  write(path: string, before: string, after: string, origin?: Readonly<KnowledgeLinkingOrigin>, signal?: AbortSignal): Promise<void>;
  bindingSignature(): string;
  canWrite(origin?: Readonly<KnowledgeLinkingOrigin>): boolean | Promise<boolean>;
  release?(): Promise<void>;
  completed?(task: KnowledgeLinkingTask): void;
}
const running = (task: KnowledgeLinkingTask | null) => !!task && ["scanning", "judging", "writing", "awaiting-confirmation", "interrupted"].includes(task.phase);
const revision = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const yieldUI = () => new Promise<void>(resolve => setTimeout(resolve, 0));

/** Vault-owned lifecycle. A view subscribes; it never owns this controller. */
export class KnowledgeLinkingService {
  private task: KnowledgeLinkingTask | null = null;
  private readonly listeners = new Set<(task: KnowledgeLinkingTask | null) => void>();
  private controller: AbortController | null = null;
  private flight: Promise<void> | null = null;
  private disposed = false;
  private notifyTimer: ReturnType<typeof setTimeout> | null = null;
  private starts: Promise<void> = Promise.resolve();
  private handoffStops = 0;
  private readonly blockedOrigins = new Set<string>();
  private automaticQueue: NonNullable<KnowledgeLinkingTask["queuedAutomatic"]> = [];
  readonly ready: Promise<void>;
  constructor(private readonly host: KnowledgeLinkingHost, private readonly store: Pick<KnowledgeLinkingStateStore, "load" | "save"> & Partial<Pick<KnowledgeLinkingStateStore, "loadTask" | "saveRecord">>) {
    this.ready = this.restore();
  }
  snapshot(): KnowledgeLinkingTask | null { return this.task ? structuredClone(this.task) : null; }
  async readTask(id: string): Promise<KnowledgeLinkingTask | null> { return this.task?.id === id ? this.snapshot() : this.automaticQueue.some(item => item.id === id) ? this.queuedTask(this.automaticQueue.find(item => item.id === id)!) : await this.store.loadTask?.(id) ?? null; }
  subscribe(listener: (task: KnowledgeLinkingTask | null) => void): () => void {
    this.listeners.add(listener); listener(this.snapshot());
    return () => { this.listeners.delete(listener); };
  }
  private async restore(): Promise<void> {
    this.task = await this.store.load();
    if (this.task) this.restoreOrigin(this.task);
    this.automaticQueue = this.task?.queuedAutomatic ?? [];
    for (const queued of this.automaticQueue) this.restoreOrigin(queued);
    for (const item of [this.task, ...this.automaticQueue]) if (item?.pausedForHandoff && item.originConversationId) this.blockedOrigins.add(item.originConversationId);
    if (this.task && ["scanning", "judging", "writing"].includes(this.task.phase)) {
      this.task.phase = "interrupted";
      await this.persist();
    }
    this.notify();
    this.advanceQueue();
  }
  async start(mode: "manual" | "automatic" = "manual", targetPaths?: string[], queuedId?: string, sourcePaths?: string[], originConversationId?: string): Promise<KnowledgeLinkingTask> {
    const next = this.starts.then(() => this.startScoped(mode, targetPaths, queuedId, sourcePaths, originConversationId));
    this.starts = next.then(() => undefined, () => undefined);
    const task = await next;
    this.advanceQueue();
    return task;
  }
  private async startScoped(mode: "manual" | "automatic", targetPaths?: string[], queuedId?: string, sourcePaths?: string[], originConversationId?: string): Promise<KnowledgeLinkingTask> {
    await this.ready;
    if (this.disposed) throw new Error("知识关联服务已关闭。");
    if (mode === "automatic" && this.host.automaticEnabled?.() === false) throw new Error("自动补链已关闭，待处理关联保留。");
    const origin: KnowledgeLinkingOrigin = originConversationId
      ? { originConversationId, authorizationSource: "conversation" }
      : { authorizationSource: mode === "manual" ? "manual-user" : "unknown" };
    if (queuedId) {
      if (this.task?.id === queuedId) return this.snapshot()!;
      const queued = this.automaticQueue.find(item => item.id === queuedId);
      if (queued) return this.queuedTask(queued);
      const saved = await this.store.loadTask?.(queuedId);
      if (saved && saved.phase !== "queued") return structuredClone(saved);
    }
    if (running(this.task)) {
      if (mode === "automatic") {
        const queued = { ...origin, ...(originConversationId && this.blockedOrigins.has(originConversationId) ? { pausedForHandoff: true } : {}), id: queuedId ?? randomUUID(), paths: [...new Set(targetPaths ?? [])], ...(sourcePaths ? { sourcePaths: [...new Set(sourcePaths)] } : {}), at: Date.now() };
        this.automaticQueue.push(queued); this.task!.queuedAutomatic = this.automaticQueue;
        await this.persist(); const snapshot = this.queuedTask(queued); await this.store.saveRecord?.(snapshot); return snapshot;
      }
      return this.snapshot()!;
    }
    const at = Date.now();
    this.task = { ...origin, ...(originConversationId && this.blockedOrigins.has(originConversationId) ? { pausedForHandoff: true } : {}), schemaVersion: 1, id: queuedId ?? randomUUID(), mode, queuedAutomatic: this.automaticQueue, phase: "scanning", bindingSignature: this.host.bindingSignature(), createdAt: at, updatedAt: at, processed: 0, total: null, proposals: [], patches: [], results: [], ...(targetPaths ? { targetPaths: [...new Set(targetPaths)] } : {}), ...(sourcePaths ? { sourcePaths: [...new Set(sourcePaths)] } : {}) };
    const created = this.task;
    if (created.pausedForHandoff) created.phase = "interrupted";
    await this.persist();
    if (!this.disposed && this.task === created && created.phase === "scanning") this.launch(signal => this.scan(signal));
    return this.snapshot()!;
  }
  async confirm(): Promise<void> {
    await this.ready;
    const task = this.task;
    if (this.disposed || this.handoffStops || task?.pausedForHandoff || task?.phase !== "awaiting-confirmation" || this.flight) return;
    if (!await this.host.canWrite(task)) throw new Error("当前权限只允许读取，不能补全关联。");
    // Confirmation preflight belongs to the same cancellable operation as
    // writing. Closing or cancelling during an awaited read cannot revive it.
    this.launch(async signal => {
      const active = () => !signal.aborted && !this.disposed && this.task === task;
      if (!active()) return;
      if (task.bindingSignature !== this.host.bindingSignature()) return await this.regenerate(signal);
      for (const patch of task.patches) {
        const content = await this.host.read(patch.path, task).catch(() => null);
        if (!active() || task.phase !== "awaiting-confirmation") return;
        if (content !== patch.before) return await this.regenerate(signal);
      }
      for (const targetPath of new Set(task.patches.flatMap(patch => patch.mentions.map(mention => mention.targetPath)))) {
        const content = await this.host.read(targetPath, task).catch(() => null);
        if (!active() || task.phase !== "awaiting-confirmation") return;
        if (content === null || !this.targetCurrent(task, targetPath, content)) return await this.regenerate(signal);
      }
      if (!active() || task.phase !== "awaiting-confirmation") return;
      task.writeConfirmed = true; task.phase = "writing"; task.processed = task.results.filter(result => result.status === "written").length; task.total = task.patches.length;
      await this.persist();
      if (active() && task.phase === "writing") await this.write(signal);
    });
  }
  async resume(taskId?: string): Promise<void> {
    await this.ready;
    if (this.handoffStops) throw new Error("知识关联正在等待归属转交。");
    if (this.disposed || this.flight) return;
    if (taskId && this.task?.id !== taskId) {
      if (this.flight || this.task && running(this.task) && !this.task.pausedForHandoff) throw new Error("知识关联任务正在运行。");
      const index = this.automaticQueue.findIndex(item => item.id === taskId);
      if (index < 0) {
        const saved = await this.store.loadTask?.(taskId);
        if (!saved || saved.phase !== "interrupted") return;
        this.restoreOrigin(saved);
        this.task = { ...saved, queuedAutomatic: this.automaticQueue };
      } else {
        const queued = this.automaticQueue.splice(index, 1)[0];
        this.task = { ...this.queuedTask(queued), phase: "interrupted", queuedAutomatic: this.automaticQueue };
      }
    }
    if (this.task?.pausedForHandoff) {
      if (this.task.originConversationId) this.blockedOrigins.delete(this.task.originConversationId);
      delete this.task.pausedForHandoff;
      await this.persist();
    }
    if (this.disposed || !this.task || this.flight || this.task.phase !== "interrupted") return;
    if (this.task.bindingSignature !== this.host.bindingSignature()) return await this.regenerate();
    if (this.task.patches.length) {
      // A recovered manual preview still needs explicit confirmation.
      this.task.phase = this.task.writeConfirmed ? "writing" : "awaiting-confirmation";
      await this.persist();
      if (this.task.phase === "writing") this.launch(signal => this.write(signal));
    } else this.launch(signal => this.scan(signal));
  }
  private async regenerate(signal?: AbortSignal): Promise<void> {
    if (!this.task || this.disposed || signal?.aborted) return;
    this.task.bindingSignature = this.host.bindingSignature(); this.task.patches = []; this.task.proposals = []; this.task.results = [];
    this.task.writeConfirmed = false; this.task.mode = "manual"; this.task.error = "笔记或目录已变化，已重新扫描；请核对新的预览。";
    await this.persist();
    if (this.disposed || signal?.aborted) return;
    if (signal) await this.scan(signal); else this.launch(nextSignal => this.scan(nextSignal));
  }
  private originOf(value: KnowledgeLinkingOrigin): KnowledgeLinkingOrigin {
    return { ...(value.originConversationId ? { originConversationId: value.originConversationId } : {}), authorizationSource: value.authorizationSource ?? "unknown" };
  }
  private restoreOrigin(value: KnowledgeLinkingOrigin): void {
    if (value.originConversationId !== undefined && (typeof value.originConversationId !== "string" || !value.originConversationId.trim() || /[\0\r\n]/u.test(value.originConversationId))) throw new Error("知识关联来源无效。");
    value.authorizationSource = value.originConversationId ? "conversation" : value.authorizationSource === "manual-user" ? "manual-user" : "unknown";
  }
  /** Pause matching work durably before Catalog handoff; wait for any write/readback already in flight. */
  async stopForOrigins(originConversationIds: readonly string[]): Promise<void> {
    const origins = new Set(originConversationIds);
    for (const id of origins) this.blockedOrigins.add(id);
    this.handoffStops++;
    try {
      await this.ready;
      await this.starts;
      const current = this.task;
      const ownsCurrent = !!current?.originConversationId && origins.has(current.originConversationId);
      for (const queued of this.automaticQueue) if (queued.originConversationId && origins.has(queued.originConversationId)) {
        queued.pausedForHandoff = true;
        await this.store.saveRecord?.(this.queuedTask(queued));
      }
      if (ownsCurrent) {
        current.pausedForHandoff = true;
        this.controller?.abort();
        await this.flight;
        if (this.task === current && !["completed", "partial", "cancelled"].includes(current.phase)) current.phase = "interrupted";
        await this.host.release?.();
      }
      await this.persist();
    } finally { this.handoffStops--; }
  }
  async cancel(): Promise<void> {
    await this.ready;
    this.controller?.abort();
    await this.flight; await this.host.release?.();
    if (this.task) { this.task.phase = "cancelled"; await this.persist(); this.notify(); }
    this.advanceQueue();
  }
  async dismiss(): Promise<void> { await this.ready; if (this.task && !running(this.task)) { this.task.dismissed = true; await this.persist(); } }
  async dispose(): Promise<void> {
    this.disposed = true; this.controller?.abort(); await this.flight; await this.host.release?.();
    if (this.task && ["scanning", "judging", "writing"].includes(this.task.phase)) { this.task.phase = "interrupted"; await this.persist(); }
    if (this.notifyTimer) clearTimeout(this.notifyTimer);
    this.listeners.clear();
  }
  async waitForIdle(): Promise<void> { await this.ready; await this.flight; }
  private launch(work: (signal: AbortSignal) => Promise<void>): void {
    this.controller = new AbortController();
    this.flight = work(this.controller.signal).catch(async error => {
      if (this.controller?.signal.aborted) return;
      if (this.task) { this.task.phase = "failed"; this.task.error = error instanceof Error ? error.message : String(error); await this.persist(); this.publish(structuredClone(this.task)); }
      await this.host.release?.();
    }).finally(() => {
      this.flight = null; this.controller = null; this.notify();
      this.advanceQueue();
    });
  }
  private queuedTask(queued: NonNullable<KnowledgeLinkingTask["queuedAutomatic"]>[number]): KnowledgeLinkingTask {
    return { schemaVersion: 1, id: queued.id, ...this.originOf(queued), ...(queued.pausedForHandoff ? { pausedForHandoff: true } : {}), mode: "automatic", phase: queued.pausedForHandoff ? "interrupted" : "queued", bindingSignature: this.host.bindingSignature(), createdAt: queued.at, updatedAt: queued.at, processed: 0, total: null, proposals: [], patches: [], results: [], targetPaths: queued.paths, ...(queued.sourcePaths ? { sourcePaths: queued.sourcePaths } : {}) };
  }
  private advanceQueue(): void {
    if (this.disposed || this.host.automaticEnabled?.() === false || this.handoffStops || this.flight || running(this.task) || !this.automaticQueue.length) return;
    const index = this.automaticQueue.findIndex(item => !item.pausedForHandoff && !(item.originConversationId && this.blockedOrigins.has(item.originConversationId)));
    if (index < 0) return;
    const queued = this.automaticQueue.splice(index, 1)[0];
    void this.start("automatic", queued.paths, queued.id, queued.sourcePaths, queued.originConversationId).catch(async error => {
      // The setting may change after dequeue but before the serialized start.
      if (!this.automaticQueue.some(item => item.id === queued.id)) this.automaticQueue.splice(index, 0, queued);
      if (this.task) this.task.queuedAutomatic = this.automaticQueue;
      if (!this.disposed) await this.persist();
      if (this.host.automaticEnabled?.() !== false) console.error("EchoInk automatic linking queue could not start", error);
    });
  }
  private async scan(signal: AbortSignal): Promise<void> {
    const task = this.task!; task.phase = "scanning"; task.processed = 0; task.total = null;
    task.proposals = []; task.patches = []; task.results = [];
    const documents: KnowledgeLinkingDocument[] = [];
    for await (const document of this.host.documents(task)) {
      if (signal.aborted) return;
      documents.push(document); task.processed++; this.notify();
      if (documents.length % 32 === 0) await yieldUI();
    }
    const merged = new Map<string, KnowledgeLinkingProposal>();
    // Manual aliases are judged first, so newly discovered names participate
    // in this very scan, including mentions in every other page.
    if (task.mode === "manual") {
      task.phase = "judging"; task.judgment = "aliases"; task.processed = 0; task.total = documents.length; await this.persist();
      for (const document of documents) {
        if (signal.aborted) return;
        if (document.aliases.length) { task.processed++; continue; }
        try {
          const proposals = await this.host.judge({ ...this.originOf(task), taskId: task.id, documents: [document], targets: [], candidates: [], allowAliases: true, signal });
          const proposal = proposals.find(item => item.path === document.path);
          if (proposal?.aliases?.length) merged.set(document.path, { path: document.path, version: document.version, mentions: [], aliases: proposal.aliases });
        } catch (error) { task.results.push({ path: document.path, status: "failed", links: 0, aliases: 0, message: `别名判断：${error instanceof Error ? error.message : String(error)}` }); }
        task.processed++; this.notify(); await yieldUI();
      }
    }
    task.targetVersions = Object.fromEntries(documents.map(document => [document.path, revision(document.content)]));
    const allTargets = buildKnowledgeLinkingTargets(documents).map(target => ({ ...target, aliases: [...new Set([...target.aliases, ...(merged.get(target.path)?.aliases ?? [])])] }));
    const reverseTargets = allTargets.filter(target => !task.targetPaths || task.targetPaths.includes(target.path));
    const sourcePaths = new Set(task.sourcePaths ?? []);
    const targetsFor = (document: KnowledgeLinkingDocument) => sourcePaths.has(document.path) ? allTargets : reverseTargets;
    const batches: Array<{ documents: KnowledgeLinkingDocument[]; targets: KnowledgeLinkingTarget[]; candidates: Array<KnowledgeLinkingMention & { path: string }> }> = [];
    task.phase = "scanning"; task.processed = 0; task.total = documents.length;
    for (const document of documents) {
      if (signal.aborted) return;
      const targets = targetsFor(document);
      const candidates = scanKnowledgeLinkingMentions(document, targets).map(mention => ({ ...mention, path: document.path }));
      for (let offset = 0; offset < candidates.length; offset += 40) batches.push({ documents: [document], targets, candidates: candidates.slice(offset, offset + 40) });
      task.processed++; this.notify(); if (task.processed % 32 === 0) await yieldUI();
    }
    task.phase = "judging"; task.judgment = "mentions"; task.processed = 0; task.total = batches.length; await this.persist();
    for (const batch of batches) {
      if (signal.aborted) return;
      try {
        const proposals = await this.host.judge({ ...this.originOf(task), taskId: task.id, ...batch, allowAliases: false, signal });
        for (const proposal of proposals) {
          const document = batch.documents.find(doc => doc.path === proposal.path);
          if (!document) throw new Error("模型返回了本批范围之外的笔记。");
          const previous = merged.get(proposal.path) ?? { path: proposal.path, version: document.version, mentions: [] };
          previous.mentions.push(...proposal.mentions); merged.set(proposal.path, previous);
        }
      } catch (error) { task.results.push({ path: batch.documents[0].path, status: "failed", links: 0, aliases: 0, message: `关联判断：${error instanceof Error ? error.message : String(error)}` }); }
      task.processed++; await this.persist(); await yieldUI();
    }
    if (signal.aborted) return;
    for (const proposal of merged.values()) {
      const document = documents.find(doc => doc.path === proposal.path)!;
      // Keep the earliest semantically accepted mention for each target.
      const selected = selectKnowledgeLinkingMentions(proposal.mentions);
      proposal.mentions = selected.mentions;
      if (selected.ambiguous.length) task.results.push({ path: document.path, status: "skipped", links: 0, aliases: 0, message: "同一处提及无法确定唯一目标，保留原词；其他关联继续处理。" });
      const checked = buildKnowledgeLinkingPatch(document, proposal, targetsFor(document), { allowAliases: task.mode === "manual" });
      if (checked.patch) { task.proposals.push(proposal); task.patches.push(checked.patch); }
      for (const rejected of checked.rejected) task.results.push({ path: rejected.path, status: "skipped", links: 0, aliases: 0, message: rejected.reason });
    }
    if (!task.patches.length) return await this.finish();
    task.phase = task.mode === "manual" ? "awaiting-confirmation" : "writing";
    task.writeConfirmed = task.mode === "automatic";
    task.processed = 0; task.total = task.patches.length; await this.persist();
    if (task.mode === "automatic") await this.write(signal);
    else await this.host.release?.();
  }
  private targetCurrent(task: KnowledgeLinkingTask, targetPath: string, content: string): boolean {
    const targetPatch = task.patches.find(patch => patch.path === targetPath);
    return !!targetPatch && (content === targetPatch.before || content === targetPatch.after)
      || task.targetVersions?.[targetPath] === revision(content);
  }
  private async write(signal: AbortSignal): Promise<void> {
    const task = this.task!;
    if (!await this.host.canWrite(task)) throw new Error("当前权限只允许读取，不能补全关联。");
    for (const patch of task.patches) {
      if (signal.aborted) return;
      if (task.results.some(result => result.path === patch.path && result.status === "written")) continue;
      try {
        if (!await this.host.canWrite(task)) throw new Error("当前权限只允许读取，保留尚未写入的笔记。");
        if (task.bindingSignature !== this.host.bindingSignature()) throw new Error("目录已变化，请重新扫描并确认。");
        const current = await this.host.read(patch.path, task);
        if (signal.aborted || this.disposed || this.task !== task) return;
        for (const targetPath of new Set(patch.mentions.map(mention => mention.targetPath))) {
          const targetContent = await this.host.read(targetPath, task);
          if (signal.aborted || this.disposed || this.task !== task) return;
          if (!this.targetCurrent(task, targetPath, targetContent)) throw new Error("关联目标已变化，保留原文，请重新扫描。");
        }
        if (current !== patch.after) {
          if (current !== patch.before) throw new Error("笔记已变化，保留当前内容，请重新扫描。");
          await this.host.write(patch.path, patch.before, patch.after, task, signal);
        }
        if (await this.host.read(patch.path, task) !== patch.after) throw new Error("写后核对失败，请查看笔记。");
        task.results.push({ path: patch.path, status: "written", links: patch.mentions.length, aliases: patch.addedAliases.length });
      } catch (error) { task.results.push({ path: patch.path, status: "failed", links: 0, aliases: 0, message: error instanceof Error ? error.message : String(error) }); }
      task.processed++; await this.persist(); await yieldUI();
    }
    if (!signal.aborted) await this.finish();
  }
  private async finish(): Promise<void> {
    const task = this.task!; task.phase = task.results.some(result => result.status !== "written") ? "partial" : "completed";
    await this.persist(); await this.host.release?.(); this.publish(structuredClone(task)); this.host.completed?.(structuredClone(task));
  }
  private async persist(): Promise<void> { if (this.task) { this.task.updatedAt = Date.now(); await this.store.save(this.task); } this.notify(); }
  private publish(snapshot: KnowledgeLinkingTask | null): void {
    for (const listener of this.listeners) { try { listener(snapshot); } catch (error) { console.error("EchoInk linking observer failed", error); } }
  }
  private notify(): void {
    if (this.notifyTimer || this.disposed) return;
    this.notifyTimer = setTimeout(() => { this.notifyTimer = null; this.publish(this.snapshot()); }, 80);
  }
}
