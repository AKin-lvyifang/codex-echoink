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

/** Independent of sidebar/view lifetime and ordinary ProductRun completion. */
export class InlineRequestService {
  private requests = new Map<string, InlineRequest>();
  private flights = new Map<string, Promise<void>>();
  private fileFlights = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  readonly comparingOriginal = new Set<string>();
  storageError: string | undefined;
  constructor(readonly vaultId: string, private readonly repository: InlineRepository, private readonly host: InlineHost) {}

  async initialize(): Promise<void> {
    for (const record of await this.repository.load()) {
      if (["thinking", "preparing"].includes(record.status)) record.status = "interrupted";
      this.requests.set(record.id, record);
    }
  }
  list(path?: string): InlineRequest[] { return [...this.requests.values()].filter(r => !path || r.path === path).map(r => structuredClone(r)); }
  get(id: string): InlineRequest | undefined { const r = this.requests.get(id); return r && structuredClone(r); }
  compare(id: string): void {
    if (this.comparingOriginal.has(id)) this.comparingOriginal.delete(id); else this.comparingOriginal.add(id);
    this.host.changed();
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
        if (thinking) throw new Error("请先处理这篇笔记里的上一块，再交代新请求。");
        const control = locateInstruction(before, r);
        if (control && (intersects(control, instruction) || intersects(control, target) || intersects(r.target, target))) throw new Error("目标与已有正文块重叠；本轮尚未接入排队。");
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
      const record: InlineRequest = { id, vaultId: this.vaultId, path: input.path, taskId: input.taskId, agentId: input.agentId, agentName: input.agentName,
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
      this.host.changed();
      return structuredClone(record);
    } finally { this.fileFlights.delete(input.path); }
  }

  async readSource(id: string): Promise<{ request: InlineRequest; document: string; context: InlineContext }> {
    const r = this.requests.get(id); if (!r) throw new Error("正文请求不存在。");
    const editor = await this.host.editor(r.path), document = editor.read();
    this.reconcileRecord(r, document);
    if (!locateInstruction(document, r) || r.status === "missing") throw new Error("正文位置已删除，请重新 @ 管家。");
    const controls = this.list(r.path).flatMap(record => { const span = locateInstruction(document, record); return span ? [span] : []; });
    return { request: structuredClone(r), document, context: cleanDocument(document, controls) };
  }
  async startRun(id: string, requirement: string, model: InlineModelSelection, context: InlineContext, addMessage = true): Promise<string> {
    const r = this.requests.get(id); if (!r || terminal(r) || r.status === "missing") throw new Error("这块已结束，请重新建立位置。");
    if (r.question && r.timing?.questionAt) r.timing.userWaitMs = (r.timing.userWaitMs ?? 0) + Date.now() - r.timing.questionAt;
    r.question = undefined; r.error = undefined; r.status = "thinking"; r.model = structuredClone(model); r.readContext = structuredClone(context); r.runToken = randomUUID(); r.updatedAt = Date.now();
    r.timing = { submittedAt: r.timing?.submittedAt ?? Date.now(), userWaitMs: r.timing?.userWaitMs, contextReadyAt: Date.now(), modelStartedAt: Date.now() };
    if (addMessage) { r.followups.push(requirement); (r.thread ??= []).push({ id: randomUUID(), role: "user", text: requirement, at: Date.now() }); }
    this.comparingOriginal.delete(id); await this.flush(); this.host.changed(); return r.runToken;
  }
  async completeProposal(id: string, token: string, sourceDocument: string, target: InlineTarget, text: string, requirement: string, section: string, timing: Partial<InlineTiming>): Promise<void> {
    const r = this.requests.get(id); if (!r || r.runToken !== token || r.status !== "thinking") return;
    const source = await this.readSource(id);
    if (r.runToken !== token || r.status !== "thinking") return;
    const resolved = locateTarget(source.document, target, source.document === sourceDocument);
    const instruction = locateInstruction(source.document, r);
    if (!resolved || !instruction || intersects(instruction, resolved) || markerPattern().test(resolved.text)) throw new Error("正文已变化或目标包含指令，请重试生成。");
    const versionId = randomUUID(); r.target = { ...resolved, kind: target.kind }; r.targetResolved = true; r.section = section;
    r.versions.push({ id: versionId, number: r.versions.length + 1, text, requirement, sourceDocument: source.document, context: r.readContext ?? source.context, target: structuredClone(r.target), createdAt: Date.now(), model: r.model && structuredClone(r.model) });
    r.currentVersionId = versionId; r.observedDocument = source.document; r.status = "pending"; r.updatedAt = Date.now(); r.timing = { ...r.timing!, ...timing, proposalReadyAt: Date.now() };
    (r.thread ??= []).push({ id: randomUUID(), role: "assistant", text: `${r.versions.length > 1 ? `第 ${r.versions.length} 版` : "新稿"}写好了，已经放在正文里等你确认。`, versionId, at: Date.now() });
    await this.flush(); this.host.changed();
  }
  async clarify(id: string, token: string, question: NonNullable<InlineRequest["question"]>, timing: Partial<InlineTiming>): Promise<void> {
    const r = this.requests.get(id); if (!r || r.runToken !== token || r.status !== "thinking") return;
    r.question = structuredClone(question); r.status = "clarifying"; r.timing = { ...r.timing!, ...timing, questionAt: Date.now() }; r.updatedAt = Date.now();
    (r.thread ??= []).push({ id: randomUUID(), role: "assistant", text: question.question, question: structuredClone(question), at: Date.now() });
    await this.flush(); this.host.changed();
  }
  async failRun(id: string, token: string | undefined, error: string, interrupted = false): Promise<void> {
    if (this.stopped) return;
    const r = this.requests.get(id); if (!r || r.runToken !== token || terminal(r) || r.status === "missing") return;
    r.status = interrupted ? "interrupted" : "failed"; r.runToken = randomUUID(); r.error = error; r.updatedAt = Date.now();
    (r.thread ??= []).push({ id: randomUUID(), role: "assistant", text: interrupted ? "已停下，正文没动。点重试我再来一次。" : `这次没写成，正文没动。${error}`, at: Date.now() });
    await this.flush(); this.host.changed();
  }
  async timing(id: string, token: string, timing: Partial<InlineTiming>): Promise<void> { const r = this.requests.get(id); if (r?.runToken === token) { r.timing = { ...r.timing!, ...timing }; this.scheduleSave(); } }
  latestForTask(taskId: string): InlineRequest | undefined { return this.list().filter(r => r.taskId === taskId).at(-1); }

  confirm(id: string, versionId: string): Promise<void> { return this.commit(id, versionId, "confirm"); }
  revoke(id: string, versionId: string): Promise<void> { return this.commit(id, versionId, "revoke"); }
  private commit(id: string, versionId: string, action: "confirm" | "revoke"): Promise<void> {
    const existing = this.flights.get(id);
    if (existing) return existing;
    const flight = this.performCommit(id, versionId, action).finally(() => this.flights.delete(id));
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
      this.reconcileRecord(r, before);
      const instruction = locateInstruction(before, r);
      if (!instruction) {
        if (action === "revoke") { r.status = "revoked"; r.error = undefined; await this.flush(); this.host.changed(); return; }
        throw new Error("正文位置已删除或指令损坏，未写入。");
      }
      if (action === "confirm" && r.status !== "pending") throw new Error(r.error ?? "目标已变化，请重新生成后确认。");
      const version = r.versions.find(v => v.id === versionId)!;
      if (action === "confirm" && (!version || r.targetResolved === false)) throw new Error("还没有可确认的新稿。");
      if (action === "confirm" && before.slice(r.target.from, r.target.to) !== version.target.text) throw new Error("目标已变化，未写入。");
      const changes = commitChanges(before, instruction, action === "confirm" ? r.target : undefined, version?.text ?? "");
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
    } finally { this.fileFlights.delete(r.path); this.host.changed(); }
  }
  private async finishSave(r: InlineRequest, editor: InlineEditorPort): Promise<void> {
    const commit = r.commit!;
    try {
      await editor.save();
      if (editor.read() !== commit.afterDocument) throw new Error("保存期间正文已变化，请核对后重试。");
      r.status = commit.action === "confirm" ? "confirmed" : "revoked";
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
        if (!instruction) { r.status = "missing"; r.error = "正文位置已删除。"; }
        else {
          r.instruction = { ...r.instruction, ...instruction };
          if (touchesInterior(r.target, changes)) { r.status = "conflict"; r.error = "目标已变动，请重新生成。"; }
          r.target = { ...r.target, ...mapAnchor(r.target, changes, next) };
        }
      }
      r.observedDocument = next; r.updatedAt = Date.now(); changed = true;
    }
    if (changed) { this.scheduleSave(); this.host.changed(); }
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
    if (!instruction) { r.status = "missing"; r.error = "正文位置已删除或指令不完整。"; return; }
    const target = locateTarget(document, r.target, r.observedDocument === document);
    r.instruction = { ...r.instruction, ...instruction };
    if (!target || intersects(instruction, target)) { r.status = "conflict"; r.error = "无法唯一定位目标，请重新选择。"; }
    else r.target = { ...r.target, ...target };
    r.observedDocument = document;
  }
  rename(oldPath: string, newPath: string): void {
    for (const r of this.requests.values()) if (r.path === oldPath || r.path.startsWith(`${oldPath}/`)) r.path = newPath + r.path.slice(oldPath.length);
    this.scheduleSave(); this.host.changed();
  }
  delete(path: string): void {
    for (const r of this.requests.values()) if (r.path === path || r.path.startsWith(`${path}/`)) { r.status = "missing"; r.error = "来源笔记已删除。"; }
    this.scheduleSave(); this.host.changed();
  }
  async flush(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    try { await this.repository.save(this.list()); this.storageError = undefined; }
    catch (error) { this.storageError = "正文请求保存失败，暂时不能确认。"; this.host.changed(); throw error; }
  }
  private scheduleSave(): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = undefined; void this.flush().catch(error => this.host.report(error)); }, 120);
  }
  async dispose(): Promise<void> { this.stopped = true; if (this.timer) { clearTimeout(this.timer); this.timer = undefined; } await this.flush(); }
}
