import { diaryFingerprint, matchDiaryItem, sameCandidate } from "./identity";
import { dedupePrompt, DIARY_ORGANIZER_SYSTEM, extractionPrompt } from "./prompts";
import type { DiaryDedupeInput } from "./prompts";
import { emptyDiaryOrganizerState, readDiaryOrganizerState } from "./state";
import type {
  DiaryActionOptions, DiaryActionResult, DiaryCandidate, DiaryDocumentState,
  DiaryItem, DiaryOrganizerOptions, DiaryOrganizerPorts, DiaryOrganizerState, DiaryOrganizerSummary,
  DiarySource, DiaryWrittenRecord, DiaryWriteInput,
} from "./types";
import { financeDuplicateCandidates, localDate, parseDiaryCandidates, parseDiaryJson, validDiaryDate, validateDiaryCandidate } from "./validation";

export const DIARY_ORGANIZER_DEFAULTS = {
  stableMs: 60 * 60 * 1000,
  retryMs: 6 * 60 * 60 * 1000,
  timeoutMs: 120 * 1000,
  maxPerRun: 5,
  maxDiaryChars: 24000,
} as const;

type Decision = { id: string; decision: "distinct" | "duplicate" | "uncertain"; matchedIds: string[]; reason: string };

export class DiaryOrganizerEngine {
  private state: DiaryOrganizerState = emptyDiaryOrganizerState();
  private initialization: Promise<void> | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private active = false;
  private disposed = false;
  private controller: AbortController | null = null;
  private readonly options: { [K in keyof typeof DIARY_ORGANIZER_DEFAULTS]: number };

  constructor(private readonly ports: DiaryOrganizerPorts, options: DiaryOrganizerOptions = {}) {
    this.options = { ...DIARY_ORGANIZER_DEFAULTS, ...options };
  }

  get running(): boolean { return this.active; }

  async initialize(): Promise<void> {
    this.initialization ??= this.ports.loadState().then(raw => { this.state = readDiaryOrganizerState(raw); });
    await this.initialization;
  }

  /** Freeze the first enable date immediately, without scanning or invoking a model. */
  enable(): Promise<void> {
    return this.exclusive(async () => { await this.anchor(); });
  }

  private async anchor(): Promise<void> {
    if (this.state.enabledAt !== null) return;
    this.state.enabledAt = this.now();
    const start = new Date(this.now());
    start.setDate(start.getDate() - 7);
    this.state.startDate = localDate(start.getTime());
    await this.save();
  }

  dispose(): void {
    this.disposed = true;
    this.controller?.abort();
  }

  getState(): DiaryOrganizerState { return structuredClone(this.state); }

  getSummary(): DiaryOrganizerSummary {
    const items = structuredClone(this.state.items);
    return {
      writtenTodos: items.filter(item => item.status === "written" && item.candidate.type === "todo").length,
      writtenFinance: items.filter(item => item.status === "written" && item.candidate.type === "finance").length,
      review: items.filter(item => item.status === "review").length,
      pendingFinance: this.state.documents.filter(doc => doc.financePending).length,
      items,
    };
  }

  private now(): number { return this.ports.now?.() ?? Date.now(); }
  private id(): string { return this.ports.createId?.() ?? window.crypto?.randomUUID?.() ?? `diary-${this.now().toString(36)}-${Math.random().toString(36).slice(2)}`; }

  private async save(): Promise<void> {
    await this.ports.saveState(structuredClone(this.state));
    this.ports.onChange?.();
  }

  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const operation = this.queue.then(async () => {
      await this.initialize();
      if (this.disposed) throw new Error("日记整理已停止");
      this.active = true;
      try { return await work(); } finally { this.active = false; }
    });
    this.queue = operation.catch(() => undefined);
    return operation;
  }

  /** Preserve document and extraction IDs on the host's Vault rename event. */
  renameDiary(oldPath: string, newPath: string): Promise<void> {
    return this.exclusive(async () => {
      const document = this.state.documents.find(doc => doc.path === oldPath);
      if (document) { document.path = newPath; await this.save(); }
    });
  }

  runOnce(): Promise<DiaryOrganizerSummary> {
    return this.exclusive(async () => {
      if (!this.ports.isEnabled() || this.ports.isBusy()) return this.getSummary();
      await this.anchor();
      await this.recoverWrites();
      const sources = (await this.ports.listDiaries()).filter(source => validDiaryDate(source.date)
        && source.date >= (this.state.startDate || "") && source.date <= localDate(this.now()))
        .sort((a, b) => a.date.localeCompare(b.date) || a.path.localeCompare(b.path));
      const availablePaths = new Set(sources.map(source => source.path));
      const ready: Array<{ doc: DiaryDocumentState; content: string }> = [];
      for (const source of sources) {
        const content = await this.ports.readDiary(source.path);
        if (content === null) continue;
        const fingerprint = diaryFingerprint(content);
        const doc = this.observe(source, fingerprint, availablePaths);
        if (doc.observations < 2 || this.now() - doc.stableSince < this.options.stableMs) continue;
        if (doc.lastFailureAt !== undefined && this.now() - doc.lastFailureAt < this.options.retryMs) continue;
        if (doc.processedFingerprint === fingerprint && !(doc.financePending && this.ports.hasFinanceAccess())) continue;
        ready.push({ doc, content });
      }
      await this.save();
      for (const { doc, content } of ready.slice(0, this.options.maxPerRun)) {
        if (!this.ports.isEnabled() || this.ports.isBusy() || this.disposed) break;
        try {
          await this.processDocument(doc, content);
        } catch (error) {
          doc.lastFailureAt = this.now();
          this.ports.log?.("日记整理暂未完成，六小时后重试", error);
          await this.save();
        }
      }
      return this.getSummary();
    });
  }

  private observe(source: DiarySource, fingerprint: string, availablePaths: Set<string>): DiaryDocumentState {
    let doc = this.state.documents.find(value => value.path === source.path
      || (!!source.identity && value.identity === source.identity));
    // A moved, unchanged file can be recognized even when the host missed a rename event.
    if (!doc) {
      const renamed = this.state.documents.filter(value => !availablePaths.has(value.path) && value.fingerprint === fingerprint);
      if (renamed.length === 1) doc = renamed[0];
    }
    if (!doc) {
      doc = { id: this.id(), path: source.path, identity: source.identity, date: source.date, fingerprint,
        stableSince: this.now(), firstSeenAt: this.now(), observations: 1, financePending: !this.ports.hasFinanceAccess() };
      this.state.documents.push(doc);
    } else {
      doc.path = source.path;
      doc.identity = source.identity ?? doc.identity;
      doc.date = source.date;
      doc.observations++;
      if (doc.fingerprint !== fingerprint) {
        doc.fingerprint = fingerprint;
        doc.stableSince = this.now();
        doc.lastFailureAt = undefined;
      }
      // A future/just-modified mtime never makes a newly observed file prematurely eligible.
      if (Number.isFinite(source.mtime) && source.mtime > doc.stableSince) doc.stableSince = Math.min(source.mtime, this.now());
    }
    return doc;
  }

  private async model(purpose: "extract" | "dedupe", prompt: string): Promise<string> {
    if (!this.ports.isEnabled() || this.ports.isBusy() || this.disposed) throw new Error("模型正在忙，已让路");
    const controller = new AbortController();
    this.controller = controller;
    let timer: ReturnType<typeof window.setTimeout> | undefined;
    try {
      return await Promise.race([
        this.ports.generateText({ purpose, system: DIARY_ORGANIZER_SYSTEM, prompt, signal: controller.signal }),
        new Promise<never>((_, reject) => {
          timer = window.setTimeout(() => { controller.abort(); reject(new Error("日记整理模型调用超时")); }, this.options.timeoutMs);
          controller.signal.addEventListener("abort", () => reject(new Error("日记整理模型调用已取消")), { once: true });
        }),
      ]);
    } finally {
      if (timer !== undefined) window.clearTimeout(timer);
      this.controller = null;
    }
  }

  private async processDocument(doc: DiaryDocumentState, content: string): Promise<void> {
    doc.lastAttemptAt = this.now();
    await this.save();
    const financeEnabled = this.ports.hasFinanceAccess();
    const finance = financeEnabled ? await this.ports.readFinanceSnapshot() : { entries: [], categories: [] };
    const todos = await this.ports.readTodoSnapshot();
    doc.truncated = content.length > this.options.maxDiaryChars;
    const modelContent = content.slice(0, this.options.maxDiaryChars);
    const candidates = parseDiaryCandidates(await this.model("extract", extractionPrompt({ content: modelContent, date: doc.date, truncated: doc.truncated, financeEnabled, finance })))
      .filter(candidate => financeEnabled || candidate.type === "todo");
    if (!await this.sourceUnchanged(doc, content)) return;

    const existing = this.state.items.filter(item => item.documentId === doc.id);
    const used = new Set<string>();
    const current: DiaryItem[] = [];
    for (const candidate of candidates) {
      const match = matchDiaryItem(candidate, existing, used);
      let item = match.item;
      if (item) {
        used.add(item.id);
        if (item.status === "ignored" || item.status === "undone") continue;
        const changed = !sameCandidate(item.candidate, candidate);
        if (changed) {
          item.previousCandidate = structuredClone(item.candidate);
          item.candidate = structuredClone(candidate);
          item.revision++;
          item.reviewedDistinct = undefined;
          item.confirmation = undefined;
          if (item.written) {
            item.status = "review";
            item.reasons = ["原日记中的已写入内容发生变化，请核对后更新原记录"];
          } else {
            item.status = "pending";
            item.reasons = [];
          }
        }
        item.sourceFingerprint = doc.fingerprint;
        item.updatedAt = this.now();
        if (item.written || item.status === "review" && !changed) continue;
      } else {
        item = { id: this.id(), documentId: doc.id, candidate: structuredClone(candidate), status: "pending", reasons: [], revision: 1,
          createdAt: this.now(), updatedAt: this.now(), sourceFingerprint: doc.fingerprint };
        if (match.ambiguous) { item.status = "review"; item.reasons = ["无法唯一对应原有条目，请核对身份"]; }
        this.state.items.push(item);
        used.add(item.id);
      }
      const validation = validateDiaryCandidate(candidate, content, finance);
      item.reasons = [...new Set([...item.reasons, ...validation.reasons])];
      if (validation.ignore) item.status = "ignored";
      else if (item.reasons.length) item.status = "review";
      else current.push(item);
    }
    // Never delete/replace a written record because its source sentence disappeared.
    if (!doc.truncated) for (const item of existing) {
      if (!used.has(item.id) && item.written && item.status !== "undone" && item.status !== "ignored"
        && (financeEnabled || item.candidate.type !== "finance")) {
        item.status = "review";
        item.reasons = ["原日记已找不到这条已写入内容，现有记录保持不变"];
        item.sourceFingerprint = doc.fingerprint;
        item.revision++;
      }
    }

    const dedupeInputs: DiaryDedupeInput[] = current.map(item => ({ id: item.id, candidate: item.candidate,
      financeMatches: item.candidate.type === "finance" ? financeDuplicateCandidates(item.candidate, finance.entries) : [],
      todoMatches: item.candidate.type === "todo" ? todos : [] }));
    // Every Todo receives the complete eligible snapshot, so paraphrased tasks are
    // compared semantically instead of being lost to a text-similarity prefilter.
    if (dedupeInputs.some(input => input.financeMatches.length || input.todoMatches.length) || dedupeInputs.length > 1) {
      await this.applyDedupe(modelContent, dedupeInputs, current);
    }
    await this.save();
    if (!await this.sourceUnchanged(doc, content)) return;
    for (const item of current) {
      if (item.status !== "pending") continue;
      if (!await this.sourceUnchanged(doc, content)) return;
      if (item.candidate.type === "finance") {
        // The batch review already confirmed these are separate events. Bind the
        // earlier writes' actual revisions before the ledger checks again.
        const earlier = current.filter(other => other !== item && other.status === "written" && other.written && other.candidate.type === "finance"
          && other.candidate.kind === item.candidate.kind && other.candidate.currency === item.candidate.currency
          && other.candidate.amountCents === item.candidate.amountCents);
        item.reviewedDistinct = [...item.reviewedDistinct ?? [], ...earlier.map(other => ({ id: other.written!.id, version: other.written!.version }))];
      }
      await this.writeItem(item, doc);
    }
    doc.processedFingerprint = doc.fingerprint;
    doc.financePending = !financeEnabled;
    doc.lastFailureAt = undefined;
    await this.save();
  }

  private async applyDedupe(content: string, inputs: DiaryDedupeInput[], items: DiaryItem[]): Promise<void> {
    const raw = parseDiaryJson(await this.model("dedupe", dedupePrompt(content, inputs)));
    const decisions = raw && typeof raw === "object" && Array.isArray((raw as { decisions?: unknown }).decisions)
      ? (raw as { decisions: Decision[] }).decisions : [];
    for (const item of items) {
      const input = inputs.find(value => value.id === item.id)!;
      const matches = decisions.filter(value => value && value.id === item.id);
      const decision = matches.length === 1 ? matches[0] : undefined;
      const allowed = new Set([...input.financeMatches.map(value => value.id), ...input.todoMatches.map(value => value.id), ...items.filter(value => value.id !== item.id).map(value => value.id)]);
      if (!decision || !["distinct", "duplicate", "uncertain"].includes(decision.decision)
        || !Array.isArray(decision.matchedIds) || decision.matchedIds.some(id => !allowed.has(id))) {
        item.status = "review"; item.reasons = ["查重结果不完整，需要你核对"]; continue;
      }
      item.duplicateRecordIds = decision.matchedIds;
      if (decision.decision === "duplicate" && decision.matchedIds.length) {
        item.status = "ignored"; item.reasons = ["已存在同一条记录", decision.reason || "模型确认重复"];
      } else if (decision.decision !== "distinct") {
        item.status = "review"; item.reasons = ["可能与已有记录重复", decision.reason || "无法确定是否同一笔"];
      } else {
        item.reviewedDistinct = input.financeMatches.map(value => ({ id: value.id, version: value.version }));
      }
    }
    // Identical extracted events are never allowed to become two automatic writes,
    // even if the second model contradicts its own instructions.
    for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
      const a = items[i]; const b = items[j];
      if (a.status === "pending" && b.status === "pending" && sameCandidate(a.candidate, b.candidate)) {
        b.status = "review"; b.reasons = ["本批次存在相同候选，请核对是否同一条"];
      }
    }
  }

  private async sourceUnchanged(doc: DiaryDocumentState, expected: string): Promise<boolean> {
    if (!this.ports.isEnabled() || this.disposed) return false;
    const latest = await this.ports.readDiary(doc.path);
    if (latest === expected) return true;
    if (latest !== null) doc.fingerprint = diaryFingerprint(latest);
    doc.stableSince = this.now();
    doc.processedFingerprint = undefined;
    await this.save();
    return false;
  }

  private async find(item: DiaryItem): Promise<DiaryWrittenRecord | null> {
    return item.candidate.type === "finance"
      ? this.ports.findFinance(item.id, item.written?.id) : this.ports.findTodo(item.id, item.written?.id);
  }

  private input(item: DiaryItem, doc: DiaryDocumentState): DiaryWriteInput<DiaryCandidate> {
    return { extractionId: item.id, diaryPath: doc.path, diaryDate: doc.date, sourceFingerprint: doc.fingerprint,
      candidate: structuredClone(item.candidate), reviewedDistinct: item.reviewedDistinct };
  }

  private async writeItem(item: DiaryItem, doc: DiaryDocumentState, updating = false): Promise<void> {
    if (!this.ports.isEnabled() || (item.candidate.type === "finance" && !this.ports.hasFinanceAccess())) return;
    const source = await this.ports.readDiary(doc.path);
    if (source === null || diaryFingerprint(source) !== item.sourceFingerprint) throw new Error("原日记已变化，未写入");
    if (!updating) {
      const found = await this.find(item);
      if (found) { item.written = found; item.status = "written"; item.writeIntent = false; await this.save(); return; }
    }
    item.writeIntent = true;
    await this.save();
    let receipt: DiaryWrittenRecord;
    if (item.candidate.type === "finance") {
      const input = this.input(item, doc) as DiaryWriteInput<typeof item.candidate>;
      if (updating && item.written) {
        if (!this.ports.updateFinance) throw new Error("当前账本不支持更新原记录");
        receipt = await this.ports.updateFinance(item.written.id, item.written.version, input);
      } else receipt = await this.ports.writeFinance(input);
    } else {
      const input = this.input(item, doc) as DiaryWriteInput<typeof item.candidate>;
      if (updating && item.written) {
        if (!this.ports.updateTodo) throw new Error("当前待办不支持更新原记录");
        receipt = await this.ports.updateTodo(item.written.id, item.written.version, input);
      } else receipt = await this.ports.writeTodo(input);
    }
    item.written = receipt;
    const verified = await this.find(item);
    if (!verified || verified.id !== receipt.id || verified.version !== receipt.version) {
      item.status = "review"; item.reasons = ["写后核对未通过，请检查实际记录"];
    } else { item.status = "written"; item.reasons = []; item.previousCandidate = undefined; }
    item.writeIntent = false;
    item.updatedAt = this.now();
    item.revision++;
    await this.save();
  }

  private async recoverWrites(): Promise<void> {
    let changed = false;
    for (const item of this.state.items) {
      if (item.undoIntent) {
        const current = await this.find(item);
        if (!current) { item.status = "undone"; item.reasons = []; }
        else { item.status = "review"; item.reasons = ["撤销未完成，请核对后再试"]; }
        item.undoIntent = false; item.revision++; changed = true;
      } else if (item.writeIntent) {
        const current = await this.find(item);
        if (item.written) {
          item.status = "review"; item.reasons = ["上次更新中断，请核对原记录后确认"];
        } else if (current) {
          item.written = current; item.status = "written"; item.reasons = [];
        } else item.status = "pending";
        item.writeIntent = false; item.revision++; changed = true;
      } else if (item.status === "written") {
        const current = await this.find(item);
        if (!current) {
          // A user deletion is respected and must never be resurrected.
          item.status = "undone"; item.reasons = ["目标记录已删除"]; item.revision++; changed = true;
        } else if (current.version !== item.written?.version) {
          // Keep the AI receipt so undo can explain that the record was edited.
          // It remains a written record until the user explicitly requests an action.
        }
      }
    }
    if (changed) await this.save();
  }

  confirm(id: string, options: DiaryActionOptions = {}): Promise<DiaryActionResult> {
    return this.exclusive(async () => {
      const item = this.state.items.find(value => value.id === id);
      if (!item) return { status: "blocked", reason: "条目不存在" };
      if (!this.ports.isEnabled()) return { status: "blocked", reason: "请先开启日记自动整理", item: structuredClone(item) };
      if (item.status === "ignored" || item.status === "undone") return { status: "blocked", reason: "该条已忽略或撤销", item: structuredClone(item) };
      if (options.expectedRevision !== undefined && options.expectedRevision !== item.revision
        && options.acknowledgedRevision !== item.revision) return this.changed(item, ["条目已变化，请核对最新内容"]);
      const doc = this.state.documents.find(value => value.id === item.documentId)!;
      const content = await this.ports.readDiary(doc.path);
      if (content === null || diaryFingerprint(content) !== item.sourceFingerprint) return this.changed(item, ["原日记已变化，等待重新整理后再确认"]);
      if (options.candidate && !sameCandidate(options.candidate, item.candidate)) {
        if (options.candidate.type !== item.candidate.type) return { status: "blocked", reason: "不能改变条目类型", item: structuredClone(item) };
        item.candidate = structuredClone(options.candidate);
        item.revision++;
      }
      if (item.candidate.type === "finance" && !this.ports.hasFinanceAccess()) return { status: "blocked", reason: "财务整理需要 PRO", item: structuredClone(item) };
      const finance = item.candidate.type === "finance" ? await this.ports.readFinanceSnapshot() : { entries: [], categories: [] };
      const validation = validateDiaryCandidate(item.candidate, content, finance);
      const hardReasons = validation.reasons.filter(reason => ["原文引用未通过核对", "金额必须是正整数分", "收支日期无效", "币种无效", "交易对象不明确", "分类未对应到已启用分类", "待办内容为空", "待办日期无效", "收支类型无效", "金额与原文不一致"].includes(reason));
      if (hardReasons.length || validation.ignore) return { status: "blocked", reason: [...hardReasons, ...(validation.ignore ? ["该内容不是可确认的本人已发生收支"] : [])].join("；"), item: structuredClone(item) };
      if (item.written) {
        const current = await this.find(item);
        if (!current) return { status: "blocked", reason: "原记录已删除，请勿重新记入", item: structuredClone(item) };
        if (current.version !== item.written.version) {
          if (options.acknowledgedRevision !== item.revision || item.confirmation?.action !== "confirm" || item.confirmation.recordVersion !== current.version) {
            item.revision++;
            item.reasons = ["实际记录已被编辑", current.summary];
            item.confirmation = { action: "confirm", revision: item.revision, recordVersion: current.version };
            await this.save();
            return this.changed(item, item.reasons, current);
          }
          item.written = current;
        }
        if (!item.previousCandidate && item.status === "written") return { status: "done", item: structuredClone(item) };
      }
      if (item.candidate.type === "finance") {
        const matches = financeDuplicateCandidates(item.candidate, finance.entries).filter(entry => entry.id !== item.written?.id);
        const known = new Map((item.reviewedDistinct || []).map(entry => [entry.id, entry.version]));
        if (matches.some(entry => known.get(entry.id) !== entry.version)) {
          if (options.acknowledgedRevision !== item.revision) {
            item.reviewedDistinct = matches.map(entry => ({ id: entry.id, version: entry.version }));
            item.revision++;
            item.reasons = ["存在同金额、相近日期的账目，请确认是独立一笔", ...matches.map(entry => `${entry.date} ${entry.merchant} ${entry.amountCents / 100} ${entry.currency}`)];
            await this.save();
            return this.changed(item, item.reasons);
          }
          item.reviewedDistinct = matches.map(entry => ({ id: entry.id, version: entry.version }));
        }
      }
      try {
        await this.writeItem(item, doc, !!item.written);
      } catch (error) {
        item.status = "review";
        item.reasons = [error instanceof Error ? error.message : "写入未完成，请核对后再试"];
        await this.save();
        return { status: "blocked", reason: item.reasons[0], item: structuredClone(item) };
      }
      return item.status === "written" ? { status: "done", item: structuredClone(item) }
        : { status: "blocked", reason: item.reasons.join("；"), item: structuredClone(item) };
    });
  }

  ignore(id: string): Promise<DiaryActionResult> {
    return this.exclusive(async () => {
      const item = this.state.items.find(value => value.id === id);
      if (!item) return { status: "blocked", reason: "条目不存在" };
      item.status = "ignored"; item.reasons = ["你已忽略该条"]; item.revision++; item.updatedAt = this.now();
      await this.save();
      return { status: "done", item: structuredClone(item) };
    });
  }

  undo(id: string, options: DiaryActionOptions = {}): Promise<DiaryActionResult> {
    return this.exclusive(async () => {
      const item = this.state.items.find(value => value.id === id);
      if (!item || !item.written) return { status: "blocked", reason: "没有可撤销的写入" };
      if (options.expectedRevision !== undefined && options.expectedRevision !== item.revision
        && options.acknowledgedRevision !== item.revision) return this.changed(item, ["条目已变化，请核对最新内容"]);
      const current = await this.find(item);
      if (!current) {
        item.status = "undone"; item.undoIntent = false; item.revision++;
        await this.save();
        return { status: "done", item: structuredClone(item) };
      }
      if (current.version !== item.written.version && (options.acknowledgedRevision !== item.revision || item.confirmation?.action !== "undo" || item.confirmation.recordVersion !== current.version)) {
        item.revision++;
        item.reasons = ["写入后记录已被编辑、勾选或关联账单", `写入时：${item.written.summary}`, `当前：${current.summary}`];
        item.confirmation = { action: "undo", revision: item.revision, recordVersion: current.version };
        await this.save();
        return this.changed(item, item.reasons, current);
      }
      item.undoIntent = true;
      await this.save();
      const result = item.candidate.type === "finance"
        ? await this.ports.undoFinance(current.id, current.version) : await this.ports.undoTodo(current.id, current.version);
      if (!result.deleted || await this.find(item)) {
        item.undoIntent = false; item.revision++;
        item.reasons = ["记录在撤销前发生变化，请重新核对"];
        await this.save();
        return this.changed(item, item.reasons, result.current);
      }
      item.undoIntent = false; item.status = "undone"; item.reasons = []; item.revision++; item.updatedAt = this.now();
      await this.save();
      return { status: "done", item: structuredClone(item) };
    });
  }

  private changed(item: DiaryItem, changes: string[], current?: DiaryWrittenRecord): DiaryActionResult {
    return { status: "needs_confirmation", item: structuredClone(item), changes, ...(current ? { current } : {}) };
  }
}
