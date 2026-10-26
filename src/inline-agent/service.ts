import { randomUUID } from "node:crypto";
import { ChangeSet, type ChangeDesc } from "@codemirror/state";
import { anchorAt, applyChanges, cleanDocument, commitChanges, intersects, locateInstruction, locateTarget, mapAnchor, markerFor, markerPattern, touchesInterior } from "./document";
import { validNotePath, type InlineRepository } from "./store";
import type { InlineChange, InlineContext, InlineModelSelection, InlineProposalInput, InlineRequest, InlineTarget, InlineTiming } from "./types";

export interface InlineEditorPort {
  read(): string;
  apply(changes: readonly InlineChange[], history: "normal" | "system", requestId: string): void;
  save(): Promise<void>;
}
export interface InlineHost {
  editor(path: string): Promise<InlineEditorPort>;
  changed(): void;
  report(error: unknown): void;
}
const terminal = (r: InlineRequest) => ["confirmed", "revoked", "withdrawn", "modified"].includes(r.status);
const missingInstructionError = (document: string, r: InlineRequest): string => {
  const first = document.indexOf(r.instruction.marker);
  return first >= 0 && document.indexOf(r.instruction.marker, first + r.instruction.marker.length) >= 0
    ? "正文编号重复，位置已失效。" : "正文位置已删除或指令不完整。";
};

/** Independent of sidebar/view lifetime and ordinary ProductRun completion. */
export class InlineRequestService {
  private requests = new Map<string, InlineRequest>();
  private flights = new Map<string, Promise<void>>();
  private fileFlights = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private readonly runDocuments = new Map<string, { token: string; document: string; changes: ChangeDesc }>();
  private readonly commitTails = new Map<string, Promise<void>>();
  private readonly restoredReadyQueues = new Set<string>();
  private nextOrder = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  readonly comparingOriginal = new Set<string>();
  storageError: string | undefined;
  constructor(readonly vaultId: string, private readonly repository: InlineRepository, private readonly host: InlineHost) {}

  async initialize(): Promise<void> {
    for (const record of await this.repository.load()) {
      if (["thinking", "preparing"].includes(record.status)) record.status = "interrupted";
      record.order ??= ++this.nextOrder;
      this.nextOrder = Math.max(this.nextOrder, record.order);
      this.requests.set(record.id, record);
      if (record.status === "queued" && record.queue?.regenerate && !record.queue.blockedBy.length) this.restoredReadyQueues.add(record.id);
    }
    this.changed(false);
  }
  /** A queue already ready at boot pauses; handling a still-blocking predecessor resumes its successors normally. */
  canAutomaticallyRegenerate(id: string): boolean { return this.requests.has(id) && !this.restoredReadyQueues.has(id); }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  list(path?: string): InlineRequest[] { return [...this.requests.values()].filter(r => !path || r.path === path).sort((a, b) => (a.order ?? 0) - (b.order ?? 0)).map(r => structuredClone(r)); }
  get(id: string): InlineRequest | undefined { const r = this.requests.get(id); return r && structuredClone(r); }
  compare(id: string): void {
    if (this.comparingOriginal.has(id)) this.comparingOriginal.delete(id); else this.comparingOriginal.add(id);
    this.changed();
  }
  async stageProposal(input: InlineProposalInput): Promise<InlineRequest> { return await this.createRequest(input, false); }
  async beginRequest(input: Omit<InlineProposalInput, "target" | "text">, requirement: string, submittedAt = Date.now()): Promise<InlineRequest> {
    const record = await this.createRequest({ ...input, target: { kind: "insert", from: input.instruction.from, to: input.instruction.from }, text: "" }, true, requirement, submittedAt);
    return record;
  }
  private async createRequest(input: InlineProposalInput, thinking: boolean, requirement?: string, submittedAt?: number): Promise<InlineRequest> {
    if (this.stopped || this.fileFlights.has(input.path)) throw new Error("这篇笔记正在处理，请稍后重试。");
    if (!validNotePath(input.path) || !input.taskId || !input.agentId || !input.trigger || typeof input.text !== "string") throw new Error("正文提案信息不完整。");
    this.fileFlights.add(input.path);
    try {
      const editor = await this.host.editor(input.path), before = editor.read();
      const instruction = anchorAt(before, input.instruction), target = anchorAt(before, input.target);
      if (!instruction.text.startsWith(input.trigger) || !instruction.text.slice(input.trigger.length).trim() || markerPattern().test(instruction.text)) throw new Error("请提供完整的原始指令范围。");
      if ((input.target.kind === "insert") !== (target.from === target.to)) throw new Error("插入位置与替换范围类型不符。");
      if (intersects(instruction, target) || markerPattern().test(target.text)) throw new Error("目标包含指令，请重新选择正文范围。");
      for (const r of this.requests.values()) {
        if (r.path !== input.path || terminal(r) || r.status === "missing") continue;
        const control = locateInstruction(before, r);
        if (control && (intersects(control, instruction) || intersects(control, target))) throw new Error("目标或指令包含另一块的指令，请换一个位置。");
      }
      const id = randomUUID(), marker = markerFor(id), addition = ` ${marker}`;
      const changes = ChangeSet.of({ from: instruction.to, insert: addition }, before.length);
      const document = applyChanges(before, [{ from: instruction.to, to: instruction.to, insert: addition }]);
      const mappedTarget: InlineTarget = { ...mapAnchor(target, changes, document), kind: input.target.kind };
      if (target.from === target.to && target.from === instruction.to) {
        Object.assign(mappedTarget, anchorAt(document, { from: target.from + addition.length, to: target.to + addition.length }));
      }
      const control = { ...anchorAt(document, { from: instruction.from, to: instruction.to + addition.length }), trigger: input.trigger, marker };
      const versionId = randomUUID(), now = Date.now();
      const controls = this.list(input.path).flatMap(r => { const span = locateInstruction(document, r); return span ? [span] : []; });
      const record: InlineRequest = { id, order: ++this.nextOrder, vaultId: this.vaultId, path: input.path, taskId: input.taskId, agentId: input.agentId, agentName: input.agentName,
        status: "preparing", instruction: control, target: mappedTarget, observedDocument: document, currentVersionId: versionId, followups: [], createdAt: now, updatedAt: now,
        versions: thinking ? [] : [{ id: versionId, number: 1, text: input.text, requirement: instruction.text, sourceDocument: document, context: cleanDocument(document, [...controls, control]), target: structuredClone(mappedTarget), createdAt: now }],
        targetResolved: !thinking, thread: [{ id: randomUUID(), role: "user", text: requirement ?? instruction.text, at: now }], timing: { submittedAt: submittedAt ?? now } };
      if (thinking) record.currentVersionId = "";
      this.requests.set(id, record);
      await this.flush();
      if (editor.read() !== before) { record.status = "missing"; record.error = "发送前正文已变化，未添加编号。"; await this.flush(); throw new Error(record.error); }
      editor.apply([{ from: instruction.to, to: instruction.to, insert: addition }], "system", id);
      record.status = thinking ? "thinking" : "pending";
      try { await editor.save(); await this.flush(); }
      catch (error) { record.status = "interrupted"; record.error = "指令或请求保存失败，请重开后核对。"; this.scheduleSave(); throw error; }
      this.changed();
      return structuredClone(record);
    } finally { this.fileFlights.delete(input.path); }
  }

  async readSource(id: string): Promise<{ request: InlineRequest; document: string; context: InlineContext }> {
    const r = this.requests.get(id); if (!r) throw new Error("正文请求不存在。");
    const editor = await this.host.editor(r.path), document = editor.read();
    this.reconcileRecord(r, document);
    if (!locateInstruction(document, r) || r.status === "missing") throw new Error(r.error ?? "正文位置已删除，请重新 @ 管家。");
    const controls = this.list(r.path).flatMap(record => { const span = locateInstruction(document, record); return span ? [span] : []; });
    return { request: structuredClone(r), document, context: cleanDocument(document, controls) };
  }
  async startRun(id: string, requirement: string, model: InlineModelSelection, context: InlineContext, addMessage = true): Promise<string> {
    const r = this.requests.get(id); if (!r || terminal(r) || r.status === "missing") throw new Error("这块已结束，请重新建立位置。");
    this.restoredReadyQueues.delete(id);
    if (r.question && r.timing?.questionAt) r.timing.userWaitMs = (r.timing.userWaitMs ?? 0) + Date.now() - r.timing.questionAt;
    r.question = undefined; r.error = undefined; r.status = "thinking"; r.targetResolved = false; r.preparedProposal = undefined; r.queue = undefined; r.model = structuredClone(model); r.readContext = structuredClone(context); r.runToken = randomUUID(); r.updatedAt = Date.now();
    r.timing = { submittedAt: r.timing?.submittedAt ?? Date.now(), userWaitMs: r.timing?.userWaitMs, contextReadyAt: Date.now(), modelStartedAt: Date.now() };
    if (addMessage) { r.followups.push(requirement); (r.thread ??= []).push({ id: randomUUID(), role: "user", text: requirement, at: Date.now() }); }
    this.runDocuments.set(id, { token: r.runToken, document: r.observedDocument, changes: ChangeSet.empty(r.observedDocument.length) });
    this.updateQueues();
    this.comparingOriginal.delete(id); await this.flush(); this.changed(); return r.runToken;
  }
  async completeProposal(id: string, token: string, sourceDocument: string, target: InlineTarget, text: string, requirement: string, section: string, timing: Partial<InlineTiming>): Promise<void> {
    const r = this.requests.get(id); if (!r || r.runToken !== token || r.status !== "thinking") return;
    const source = await this.readSource(id);
    if (r.runToken !== token || r.status !== "thinking") return;
    const tracking = this.runDocuments.get(id);
    const tracked = tracking?.token === token && tracking.document === sourceDocument;
    const from = tracked ? tracking.changes.mapPos(target.from, target.kind === "insert" ? -1 : 1) : target.from;
    const to = tracked ? tracking.changes.mapPos(target.to, -1) : target.to;
    const resolved = tracked && from <= to && to <= source.document.length && source.document.slice(from, to) === target.text
      ? anchorAt(source.document, { from, to }) : tracked ? null : locateTarget(source.document, target, source.document === sourceDocument);
    const controls = this.list(r.path).flatMap(item => { const span = locateInstruction(source.document, item); return span ? [span] : []; });
    if (!resolved || controls.some(control => intersects(control, resolved)) || markerPattern().test(resolved.text)) throw new Error("正文已变化或目标包含指令，请重试生成。");
    r.target = { ...resolved, kind: target.kind }; r.targetResolved = true; r.section = section;
    r.preparedProposal = { text, original: resolved.text, requirement, section, sourceDocument, sourceTarget: structuredClone(target),
      context: structuredClone(r.readContext ?? source.context), createdAt: Date.now(), timing };
    r.observedDocument = source.document; r.status = "queued"; r.queue = { blockedBy: [], reason: "unresolved", regenerate: false };
    r.updatedAt = Date.now(); this.runDocuments.delete(id); this.updateQueues();
    await this.flush(); this.changed();
  }
  async clarify(id: string, token: string, question: NonNullable<InlineRequest["question"]>, timing: Partial<InlineTiming>): Promise<void> {
    const r = this.requests.get(id); if (!r || r.runToken !== token || r.status !== "thinking") return;
    this.runDocuments.delete(id);
    r.question = structuredClone(question); r.status = "clarifying"; r.timing = { ...r.timing!, ...timing, questionAt: Date.now() }; r.updatedAt = Date.now();
    (r.thread ??= []).push({ id: randomUUID(), role: "assistant", text: question.question, question: structuredClone(question), at: Date.now() });
    await this.flush(); this.changed();
  }
  async failRun(id: string, token: string | undefined, error: string, interrupted = false): Promise<void> {
    if (this.stopped) return;
    const r = this.requests.get(id); if (!r || r.runToken !== token || terminal(r) || r.status === "missing") return;
    this.runDocuments.delete(id);
    r.status = interrupted ? "interrupted" : "failed"; r.runToken = randomUUID(); r.error = error; r.updatedAt = Date.now();
    (r.thread ??= []).push({ id: randomUUID(), role: "assistant", text: interrupted ? "已停下，正文没动。点重试我再来一次。" : `这次没写成，正文没动。${error}`, at: Date.now() });
    await this.flush(); this.changed();
  }
  async timing(id: string, token: string, timing: Partial<InlineTiming>): Promise<void> { const r = this.requests.get(id); if (r?.runToken === token) { r.timing = { ...r.timing!, ...timing }; this.scheduleSave(); } }
  latestForTask(taskId: string): InlineRequest | undefined { return this.list().filter(r => r.taskId === taskId).at(-1); }

  confirm(id: string, versionId: string): Promise<void> { return this.commit(id, versionId, "confirm"); }
  revoke(id: string, versionId: string): Promise<void> { return this.commit(id, versionId, "revoke"); }
  private commit(id: string, versionId: string, action: "confirm" | "revoke"): Promise<void> {
    const existing = this.flights.get(id);
    if (existing) return existing;
    const path = this.requests.get(id)?.path ?? id, previous = this.commitTails.get(path) ?? Promise.resolve();
    const flight = previous.catch(() => undefined).then(() => this.performCommit(id, versionId, action)).finally(() => {
      this.flights.delete(id); if (this.commitTails.get(path) === flight) this.commitTails.delete(path);
    });
    this.commitTails.set(path, flight);
    this.flights.set(id, flight);
    return flight;
  }
  private async performCommit(id: string, versionId: string, action: "confirm" | "revoke"): Promise<void> {
    const r = this.requests.get(id);
    if (!r || this.stopped) throw new Error("找不到本次正文请求。");
    if (r.currentVersionId !== versionId) throw new Error("稿件版本已变化，请查看当前新稿。");
    if (terminal(r)) return;
    if (action === "confirm" && this.comparingOriginal.has(id)) throw new Error("请先切回新稿，再确认。");
    if (this.fileFlights.has(r.path)) throw new Error("这篇笔记正在保存，请稍后重试。");
    this.fileFlights.add(r.path);
    try {
      const editor = await this.host.editor(r.path), before = editor.read();
      // A failed save is retried as a save, never a second replacement.
      if (r.commit && !r.commit.savedAt && ["saving", "save_failed"].includes(r.status)) {
        if (r.commit.action !== action || r.commit.versionId !== versionId) throw new Error("请先完成上次保存。");
        if (before === r.commit.afterDocument) { await this.finishSave(r, editor); return; }
        if (before !== r.commit.beforeDocument) throw new Error("保存期间正文已变化，请先核对当前文字。");
        r.commit = undefined;
        r.status = "pending";
      }
      this.reconcileRecord(r, before); this.updateQueues();
      const instruction = locateInstruction(before, r);
      if (!instruction) {
        if (action === "revoke") { r.status = "revoked"; r.error = undefined; await this.flush(); this.changed(); return; }
        throw new Error("正文位置已删除或指令损坏，未写入。");
      }
      if (action === "confirm" && r.status !== "pending") throw new Error(r.error ?? "目标已变化，请重新生成后确认。");
      const version = r.versions.find(v => v.id === versionId)!;
      if (action === "confirm" && (!version || r.targetResolved === false)) throw new Error("还没有可确认的新稿。");
      if (action === "confirm" && before.slice(r.target.from, r.target.to) !== version.target.text) throw new Error("目标已变化，未写入。");
      if (action === "confirm" && this.list(r.path).some(item => item.id !== id && (() => { const control = locateInstruction(before, item); return control && intersects(control, r.target); })())) throw new Error("目标包含另一块的指令，未写入。");
      const changes = commitChanges(before, instruction, action === "confirm" ? r.target : undefined, version?.text ?? "");
      r.runToken = randomUUID(); r.preparedProposal = undefined; r.queue = undefined; this.runDocuments.delete(id);
      const after = applyChanges(before, changes);
      const desc = ChangeSet.of(changes, before.length);
      const mergedInsertion = action === "confirm" && r.target.kind === "insert" && changes.length === 1 && r.target.from >= changes[0].from && r.target.from <= changes[0].to;
      const from = desc.mapPos(mergedInsertion ? changes[0].from : r.target.from, -1);
      const result = anchorAt(after, { from, to: action === "confirm" ? from + version.text.length : Math.max(from, desc.mapPos(r.target.to, 1)) });
      r.commit = { action, versionId, beforeDocument: before, afterDocument: after, changes, result, originalTarget: anchorAt(before, r.target), originalResult: structuredClone(result), preparedAt: Date.now() };
      r.status = "saving"; r.error = undefined;
      await this.flush();
      // Persistence yields to user edits. Recheck immediately before the one transaction.
      if (editor.read() !== before) { r.commit = undefined; r.status = "conflict"; r.error = "确认前正文已变化，未写入。"; await this.flush(); throw new Error(r.error); }
      editor.apply(changes, "normal", r.id);
      r.observedDocument = after;
      await this.finishSave(r, editor);
    } catch (error) {
      if (r.status === "saving" && r.commit && !r.commit.savedAt) {
        r.status = "save_failed"; r.error = "保存尚未完成；当前文字保留，请重试。";
        await this.flush().catch(() => undefined);
      }
      throw error;
    } finally { this.fileFlights.delete(r.path); this.changed(); }
  }
  private async finishSave(r: InlineRequest, editor: InlineEditorPort): Promise<void> {
    const commit = r.commit!;
    try {
      await editor.save();
      if (editor.read() !== commit.afterDocument) throw new Error("保存期间正文已变化，请核对后重试。");
      r.status = commit.action === "confirm" ? "confirmed" : "revoked";
      this.updateQueues();
      commit.savedAt = Date.now(); r.updatedAt = commit.savedAt; r.error = undefined; r.observedDocument = editor.read();
      const messageId = `${r.id}:commit:${commit.versionId}:${commit.action}`;
      if (!r.thread?.some(m => m.id === messageId)) (r.thread ??= []).push({ id: messageId, role: "assistant", text: commit.action === "confirm" ? "已写入正文。" : "已撤销，原文没动。想换个说法，可以编辑上面的要求再发。", at: Date.now() });
      await this.flush();
    } catch (error) {
      commit.savedAt = undefined; r.status = "save_failed"; r.error = "保存失败；当前文字保留，重试只核对和保存。";
      await this.flush().catch(() => undefined);
      throw error;
    }
  }

  /** Called once per actual document transition, including edits from sibling leaves. */
  observe(path: string, changes: ChangeDesc, previous: string, next: string, ownRequestId?: string): void {
    let changed = false;
    for (const r of this.requests.values()) {
      if (r.path !== path || r.id === ownRequestId || r.observedDocument === next) continue;
      if (r.observedDocument !== previous) continue;
      const tracking = this.runDocuments.get(r.id);
      if (tracking && tracking.changes.newLength === previous.length) tracking.changes = tracking.changes.composeDesc(changes);
      if (this.fileFlights.has(path) && r.commit && ["saving", "save_failed"].includes(r.status)) { r.observedDocument = next; continue; }
      if (r.commit && (terminal(r) || ["saving", "save_failed"].includes(r.status))) {
        if (next === r.commit.beforeDocument) { r.status = "withdrawn"; r.commit.result = structuredClone(r.commit.originalTarget); }
        else if (next === r.commit.afterDocument) { r.status = r.commit.action === "confirm" ? "confirmed" : "revoked"; r.commit.result = structuredClone(r.commit.originalResult); }
        else {
          const result = mapAnchor(r.commit.result, changes, next);
          r.status = result.text === r.commit.originalResult.text && !locateInstruction(next, r)
            ? r.commit.action === "confirm" ? "confirmed" : "revoked" : "modified";
          r.commit.result = result;
        }
      } else if (!["missing", "revoked"].includes(r.status)) {
        const instruction = locateInstruction(next, r);
        if (!instruction) { r.status = "missing"; r.error = missingInstructionError(next, r); }
        else {
          r.instruction = { ...r.instruction, ...instruction };
          if (r.targetResolved !== false && touchesInterior(r.target, changes)) { if (r.status === "queued" && r.queue) r.queue.regenerate = true; else r.status = "conflict"; r.error = "目标已变动，请重新生成。"; }
          r.target = { ...r.target, ...mapAnchor(r.target, changes, next) };
        }
      }
      r.observedDocument = next; r.updatedAt = Date.now(); changed = true;
    }
    if (changed) { this.scheduleSave(); this.changed(); }
  }
  reconcile(path: string, document: string): void {
    if (this.fileFlights.has(path)) return;
    let changed = false;
    for (const r of this.requests.values()) {
      if (r.path !== path) continue;
      const before = JSON.stringify(r);
      this.reconcileRecord(r, document);
      if (JSON.stringify(r) !== before) changed = true;
    }
    if (changed) this.scheduleSave();
  }
  private reconcileRecord(r: InlineRequest, document: string): void {
    if (r.status === "missing") return;
    if (r.commit && (terminal(r) || ["saving", "save_failed"].includes(r.status))) {
      if (document === r.commit.afterDocument) {
        r.status = r.commit.action === "confirm" ? "confirmed" : "revoked";
        r.commit.result = structuredClone(r.commit.originalResult);
        r.commit.savedAt ??= Date.now(); r.error = undefined;
      } else if (document === r.commit.beforeDocument) {
        if (r.commit.savedAt) { r.status = "withdrawn"; r.commit.result = structuredClone(r.commit.originalTarget); }
        else { r.status = "pending"; r.commit = undefined; }
      } else {
        const result = locateTarget(document, r.commit.result, r.observedDocument === document);
        if (r.commit.savedAt && result?.text === r.commit.originalResult.text && !locateInstruction(document, r)) {
          r.status = r.commit.action === "confirm" ? "confirmed" : "revoked"; r.commit.result = result;
        } else r.status = "modified";
      }
      r.observedDocument = document;
      return;
    }
    if (terminal(r)) return;
    const instruction = locateInstruction(document, r);
    if (!instruction) { r.status = "missing"; r.error = missingInstructionError(document, r); return; }
    if (r.targetResolved === false) { r.instruction = { ...r.instruction, ...instruction }; r.observedDocument = document; return; }
    const target = locateTarget(document, r.target, r.observedDocument === document);
    r.instruction = { ...r.instruction, ...instruction };
    if (!target || intersects(instruction, target)) { r.status = "conflict"; r.error = "无法唯一定位目标，请重新选择。"; }
    else r.target = { ...r.target, ...target };
    r.observedDocument = document;
  }
  rename(oldPath: string, newPath: string): void {
    for (const r of this.requests.values()) if (r.path === oldPath || r.path.startsWith(`${oldPath}/`)) r.path = newPath + r.path.slice(oldPath.length);
    this.scheduleSave(); this.changed();
  }
  delete(path: string): void {
    for (const r of this.requests.values()) if (r.path === path || r.path.startsWith(`${path}/`)) { r.status = "missing"; r.error = "来源笔记已删除。"; }
    this.scheduleSave(); this.changed();
  }
  private blockers(r: InlineRequest): { ids: string[]; overlap: boolean } {
    const ids: string[] = []; let overlap = false;
    for (const earlier of this.requests.values()) {
      if (earlier.path !== r.path || (earlier.order ?? 0) >= (r.order ?? 0) || terminal(earlier) || earlier.status === "missing") continue;
      const unresolved = earlier.targetResolved === false || earlier.status === "preparing";
      // CM observers see the edited document before the owning save has settled.
      const range = earlier.commit && ["saving", "save_failed"].includes(earlier.status) && r.observedDocument === earlier.commit.afterDocument
        ? earlier.commit.result : earlier.target;
      const overlaps = !unresolved && intersects(range, r.target);
      const savingBlocker = r.queue?.blockedBy.includes(earlier.id) && ["saving", "save_failed"].includes(earlier.status);
      if (unresolved || overlaps || savingBlocker) { ids.push(earlier.id); overlap ||= overlaps; }
    }
    return { ids, overlap };
  }
  /** Re-evaluate by persistent request order, never by model response order. */
  private updateQueues(): boolean {
    if (this.stopped) return false;
    const signature = () => JSON.stringify([...this.requests.values()].map(r => [r.status, r.queue, r.currentVersionId, r.versions.length, !!r.preparedProposal]));
    const before = signature();
    for (const r of [...this.requests.values()].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))) {
      if (!["pending", "queued"].includes(r.status) || r.targetResolved === false) continue;
      const blockers = this.blockers(r);
      if (r.status === "pending" && blockers.ids.length) {
        const version = r.versions.find(v => v.id === r.currentVersionId);
        if (!version) continue;
        r.preparedProposal = { text: version.text, original: version.target.text, requirement: version.requirement,
          section: r.section ?? "", sourceDocument: version.sourceDocument, sourceTarget: structuredClone(version.target), context: version.context,
          createdAt: version.createdAt, timing: r.timing ?? {}, versionId: version.id };
        r.status = "queued"; this.comparingOriginal.delete(r.id);
      }
      if (r.status !== "queued" || !r.preparedProposal) continue;
      const regenerate = !!r.queue?.regenerate || blockers.overlap || r.target.text !== r.preparedProposal.original;
      r.queue = { blockedBy: blockers.ids, reason: blockers.overlap ? "overlap" : "unresolved", regenerate };
      if (blockers.ids.length || regenerate) continue;
      const proposal = r.preparedProposal;
      let version = proposal.versionId ? r.versions.find(v => v.id === proposal.versionId) : undefined;
      if (!version) {
        version = { id: randomUUID(), number: r.versions.length + 1, text: proposal.text, requirement: proposal.requirement,
          sourceDocument: proposal.sourceDocument, context: proposal.context, target: structuredClone(proposal.sourceTarget), createdAt: proposal.createdAt, model: r.model && structuredClone(r.model) };
        r.versions.push(version);
        (r.thread ??= []).push({ id: randomUUID(), role: "assistant", text: `${version.number > 1 ? `第 ${version.number} 版` : "新稿"}写好了，已经放在正文里等你确认。`, versionId: version.id, at: Date.now() });
      }
      r.currentVersionId = version.id; r.status = "pending"; r.error = undefined; r.preparedProposal = undefined; r.queue = undefined;
      r.updatedAt = Date.now(); r.timing = { ...r.timing!, ...proposal.timing, proposalReadyAt: Date.now() };
    }
    return before !== signature();
  }
  private changed(updateQueues = true): void { if (updateQueues && this.updateQueues()) this.scheduleSave(); this.host.changed(); for (const listener of this.listeners) listener(); }
  async flush(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    try { await this.repository.save(this.list()); this.storageError = undefined; }
    catch (error) { this.storageError = "正文请求保存失败，暂时不能确认。"; this.changed(); throw error; }
  }
  private scheduleSave(): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = undefined; void this.flush().catch(error => this.host.report(error)); }, 120);
  }
  async dispose(): Promise<void> { this.stopped = true; this.listeners.clear(); this.runDocuments.clear(); if (this.timer) { clearTimeout(this.timer); this.timer = undefined; } await this.flush(); }
}
