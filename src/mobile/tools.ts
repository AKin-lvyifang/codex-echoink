import { mobileNoteUpdateTool } from "./note-update";
import { boundKnowledgeSourceSpan, sliceKnowledgeSourceSpan, sourceSpanHasMore } from "../knowledge-base/source-span";
import type { KnowledgeBodySearchPort } from "../knowledge-base/vault-body-search";
import { memoryRelevanceEntry, memoryRelevanceScorer, memoryTemporalContext, rankMemory, type MemoryActivityState, type MemoryRecallMode } from "../harness/memory/memory-relevance";
import type { KnowledgeFolderBindings } from "../knowledge-base/folder-bindings";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { App } from "obsidian";
import { Type } from "typebox";
import { PERSONAL_MEMORY_SCHEMA, type PersonalMemoryKind, type PersonalMemoryRecord } from "../harness/memory/personal-memory-contracts";
import { MobileStore, newId } from "./store";
import { createScopedMobileBodySearch, defaultMobileCapabilityPolicy, isScopedMobileBodySearch, requireMobileAgentCapability, type MobileCapabilityPolicy } from "./capability-policy";
import { sha256Hex } from "../utils/sha256";
import type { MobileToolExecutionContext, MobileWriteOperation } from "./task-contracts";
import type { MobileMemoryService } from "./memory-service";
import type { LifestyleFinanceService } from "../lifestyle/finance-service";
import { mobileFinanceTools } from "./finance-tools";
import { assertMobileResumeMemoryObservations, assertMobileResumeObservations, assertMobileWriteNotReplayed, assertMobileWriteRun,
  mobileMemoryWriteHash, mobileMemoryWriteKey, mobileNoteWriteKey, normalizeMobileNoteTarget } from "./task-recovery";

export const memoryCategories = [
  { id: "all", label: "全部", kinds: [] },
  { id: "facts", label: "事实", kinds: ["fact"] },
  { id: "views", label: "观点", kinds: ["view"] },
  { id: "decisions", label: "决定", kinds: ["decision"] },
  { id: "active", label: "进行中", kinds: ["goal", "task", "open_loop"] },
  { id: "episodes", label: "经历", kinds: ["episode"] }
] as const;
export function checkedNotePath(value: string): string {
  return normalizeMobileNoteTarget(value);
}
export function searchMemories(records: readonly PersonalMemoryRecord[], query: string, limit = 20, mode: MemoryRecallMode = "search", activity?: MemoryActivityState, now = Date.now()): PersonalMemoryRecord[] {
  const current = records.filter(record => record.status === "current" && (mode === "search" || !record.pinned));
  const entries = current.map(record => ({ record, entry: memoryRelevanceEntry(record) }));
  const score = memoryRelevanceScorer(entries.map(item => item.entry), query, mode);
  return entries.map(item => ({ record: item.record, ...rankMemory(query.trim() ? score(item.entry) : 0, item.record, activity ?? { version: 1, vaultId: "preview", initializedAt: new Date(now).toISOString(), records: {} }, now, query, mode) }))
    .filter(item => item.eligible && (!query.trim() || item.score > 0)).sort((a, b) => b.score - a.score || b.record.date.localeCompare(a.record.date) || a.record.id.localeCompare(b.record.id))
    .slice(0, limit).map(item => item.record);
}
export function memoryRuntimeView(record: PersonalMemoryRecord, now = Date.now()) {
  return { id: record.id, kind: record.kind, title: record.title, content: record.content, basis: record.basis,
    recallWhen: record.recallWhen, date: record.date, ...memoryTemporalContext(record, now) };
}

function checkStopped(signal?: AbortSignal) { if (signal?.aborted) throw new Error("已停止，未开始此操作。"); }
const result = (details: unknown) => ({ content: [{ type: "text" as const, text: typeof details === "string" ? details : JSON.stringify(details) }], details });
/** Product runtime must pass its durable run. Legacy standalone fixtures have no journal/resume guarantee. */
export function mobileTools(app: App, store: MobileStore, selectedNote: () => string, bindings: () => KnowledgeFolderBindings | null | undefined = () => null, sharedBodySearch?: KnowledgeBodySearchPort, sessionId = store.session.id, suppliedPolicy?: MobileCapabilityPolicy, execution?: MobileToolExecutionContext, memory?: MobileMemoryService, finance?: LifestyleFinanceService): AgentTool[] {
  const policy = suppliedPolicy ?? defaultMobileCapabilityPolicy(store, bindings, sessionId, app);
  const shared = sharedBodySearch && isScopedMobileBodySearch(sharedBodySearch, policy);
  const bodySearch = shared ? sharedBodySearch : createScopedMobileBodySearch(app, bindings, policy);
  const tools: AgentTool[] = [
    {
      name: "vault_search", label: "查找笔记", description: "搜索允许用途和普通笔记的真实正文。query或queries(1-5问法)二选一；可用dateFrom/dateTo筛选日记日期。结果含命中章节、原文片段、版本和行号；可直接使用已交付原文，需要更多时note_read续读。", parameters: Type.Object({ query: Type.Optional(Type.String()), queries: Type.Optional(Type.Array(Type.String(), { minItems: 1, maxItems: 5 })), dateFrom: Type.Optional(Type.String()), dateTo: Type.Optional(Type.String()), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })), cursor: Type.Optional(Type.String()) }),
      async execute(_id, args: { query?: string; queries?: string[]; dateFrom?: string; dateTo?: string; limit?: number; cursor?: string }, signal) {
        checkStopped(signal);
        policy.assertTool("vault_search", args);
        if ((args.query === undefined) === (args.queries === undefined)) throw new Error("请传入query或queries之一。");
        // Standalone callers have no owning runtime to release host listeners.
        if (!shared) bodySearch.invalidate();
        const found = await bodySearch.search({ ...args, signal });
        checkStopped(signal); policy.assertTool("vault_search", args);
        return result({ ...found, hits: found.hits.map(hit => ({ ...hit, sourceType: hit.kind })) });
      }
    },
    {
      name: "note_read", label: "读取笔记", description: "读取允许搜索的当前/选定笔记或搜索命中章节。搜索后原样传expectedContentRevision并用lineStart/lineCount续读。结果含真实原文位置及是否还有后文。", parameters: Type.Object({ path: Type.Optional(Type.String()), expectedContentRevision: Type.Optional(Type.String()), lineStart: Type.Optional(Type.Integer({ minimum: 1 })), columnStart: Type.Optional(Type.Integer({ minimum: 0 })), columnEnd: Type.Optional(Type.Integer({ minimum: 0 })), lineCount: Type.Optional(Type.Integer({ minimum: 1, maximum: 80 })) }),
      async execute(_id, args: { path?: string; expectedContentRevision?: string; lineStart?: number; columnStart?: number; columnEnd?: number; lineCount?: number }, signal) {
        checkStopped(signal);
        const path = checkedNotePath(args.path || selectedNote());
        policy.assertTool("note_read", args, path);
        const source = await bodySearch.read({ vaultRelativePath: path, expectedContentRevision: args.expectedContentRevision });
        checkStopped(signal);
        policy.assertTool("note_read", args, path);
        const lines = source.content.split(/\r\n|\n|\r/u);
        const lineStart = args.lineStart ?? 1;
        const count = args.lineCount ?? 40;
        if (!Number.isSafeInteger(lineStart) || lineStart < 1 || lineStart > lines.length || !Number.isSafeInteger(count) || count < 1 || count > 80) throw new Error("读取行号无效。");
        const requestedEnd = Math.min(lines.length, lineStart + count - 1);
        const span = boundKnowledgeSourceSpan(lines, { lineStart, lineEnd: requestedEnd, ...(args.columnStart === undefined && args.columnEnd === undefined ? {} : { columnStart: args.columnStart ?? 0, columnEnd: args.columnEnd ?? lines[requestedEnd - 1].length }) });
        const lineEnd = span.lineEnd;
        const partialLast = span.columnEnd !== undefined && span.columnEnd < lines[lineEnd - 1].length;
        return result({ path, vaultRelativePath: source.vaultRelativePath, title: source.title, sourceType: source.kind, contentRevision: source.contentRevision,
          ...span, totalLines: lines.length, content: sliceKnowledgeSourceSpan(lines, span),
          hasMore: sourceSpanHasMore(lines, span), ...(partialLast || lineEnd < lines.length ? { nextLineStart: partialLast ? lineEnd : lineEnd + 1, ...(partialLast ? { nextColumnStart: span.columnEnd } : {}) } : {}) });
      }
    },
    {
      name: "note_create", label: "保存文档", description: "在当前笔记库新建 Markdown。不能覆盖已有文件。只读权限禁止写入。", parameters: Type.Object({ path: Type.String(), content: Type.String() }),
      async execute(toolCallId, args: { path: string; content: string }, signal) {
        const path = checkedNotePath(args.path);
        const writable = () => {
          checkStopped(signal); policy.assertTool("note_create", args, path);
          if (execution) {
            const task = store.getSession(sessionId);
            if (!task) throw new Error("任务不存在，未写入笔记。");
            assertMobileWriteRun(task, execution);
          }
        };
        writable();
        const semanticKey = mobileNoteWriteKey(path);
        if (execution) assertMobileWriteNotReplayed(store.getSession(sessionId)!, execution, "note_create", toolCallId, semanticKey, path);
        await assertMobileResumeObservations(app, store, execution?.resume, signal, finance);
        writable();
        if (app.vault.getAbstractFileByPath(path) || await app.vault.adapter.exists(path)) throw new Error("同名文件已存在，请改用新文件名；原文件未被覆盖。");
        writable();
        const now = Date.now();
        const operation: MobileWriteOperation = { id: newId(), taskId: sessionId, runId: execution?.runId ?? "", toolCallId,
          toolName: "note_create", semanticKey, status: "prepared", createdAt: now, updatedAt: now,
          target: path, expectedHash: sha256Hex(args.content), targetWasMissing: true };
        if (execution) {
          await store.updateSession(sessionId, task => {
            writable(); assertMobileWriteNotReplayed(task, execution, "note_create", toolCallId, semanticKey, path);
            task.operations = [...(task.operations ?? []), operation];
          });
          await assertMobileResumeObservations(app, store, execution.resume, signal, finance);
          writable();
          if (await app.vault.adapter.exists(path)) throw new Error("目标在准备期间已变化，原文件未被覆盖。");
          writable();
          await store.updateSession(sessionId, task => {
            writable(); assertMobileWriteRun(task, execution);
            const prepared = task.operations?.find(item => item.id === operation.id);
            if (!prepared || prepared.status !== "prepared") throw new Error("写入意图已变化，未开始写入。");
            prepared.status = "started"; prepared.updatedAt = Date.now();
          });
        }
        const parts = path.split("/").slice(0, -1);
        let directory = "";
        for (const part of parts) {
          await assertMobileResumeObservations(app, store, execution?.resume, signal, finance);
          writable(); directory = directory ? `${directory}/${part}` : part;
          if (!app.vault.getAbstractFileByPath(directory)) await app.vault.createFolder(directory);
        }
        await assertMobileResumeObservations(app, store, execution?.resume, signal, finance);
        writable();
        if (execution && await app.vault.adapter.exists(path)) throw new Error("目标在写入前已变化，原文件未被覆盖。");
        writable();
        const file = await app.vault.create(path, args.content);
        if (execution) {
          // Readback/completion records facts only, even if the owning run was interrupted meanwhile.
          const content = await app.vault.adapter.read(path);
          if (content !== args.content) throw new Error("笔记已创建但回读内容不一致，原文件及写入记录已保留。");
          await store.updateSession(sessionId, task => {
            const written = task.operations?.find(item => item.id === operation.id);
            if (!written || written.expectedHash !== operation.expectedHash || written.target !== path) throw new Error("写入记录已变化，请重新核对。");
            written.status = "completed"; written.updatedAt = Date.now();
          });
          checkStopped(signal);
        }
        return result({ path: file.path, saved: true });
      }
    }
  ];
  if (store.state.memoryEnabled) {
    const enabled = (name: string, signal?: AbortSignal) => { checkStopped(signal); policy.assertTool(name); };
    tools.push({
      name: "memory_search", label: "查找记忆", description: "检索用户记忆；query 为空时列出最近记忆。涉及用户经历、观点、决定或目标时先检索。", parameters: Type.Object({ query: Type.String() }),
      async execute(_id, args: { query: string }, signal) { enabled("memory_search", signal); const records = memory ? await memory.recordsForRuntime() : store.state.memories; enabled("memory_search", signal); const activity = memory ? await memory.memoryActivity() : undefined; enabled("memory_search", signal); return result(searchMemories(records, args.query, 20, "search", activity).map(record => memoryRuntimeView(record))); }
    }, {
      name: "memory_read", label: "读取记忆", description: "读取指定记忆的完整内容和来源。", parameters: Type.Object({ id: Type.String() }),
      async execute(_id, args: { id: string }, signal) { enabled("memory_read", signal); const record = memory ? (await memory.read(args.id)).record : store.state.memories.find(r => r.id === args.id); enabled("memory_read", signal); if (!record) throw new Error("记忆不存在。"); return result(record); }
    }, {
      name: "memory_write", label: "保存记忆", description: "忠实保存用户明确陈述或当前对话中可观察的长期信息。禁止把引用、文档知识、假设、工具输出或模型猜测写成用户事实。先搜索避免重复；修正旧记忆时提供 targetId。不能删除记忆。用户本轮明确要求固定或取消固定时，传operation=pin/unpin、targetId和逐字evidenceQuote；其余字段用于新增或修正。", parameters: Type.Object({
        operation: Type.Optional(Type.Union([Type.Literal("pin"), Type.Literal("unpin")])), evidenceQuote: Type.Optional(Type.String()),
        kind: Type.Optional(Type.Union(["fact", "view", "decision", "goal", "task", "open_loop", "episode"].map(k => Type.Literal(k)))), title: Type.Optional(Type.String({ minLength: 1 })), content: Type.Optional(Type.String({ minLength: 1 })), recallWhen: Type.Optional(Type.String()), basis: Type.Optional(Type.Union([Type.Literal("explicit"), Type.Literal("observed")])), targetId: Type.Optional(Type.String())
      }),
      async execute(toolCallId, args: { operation?: "pin" | "unpin"; evidenceQuote?: string; targetId?: string; kind: PersonalMemoryKind; content: string; title: string; recallWhen: string; basis: "explicit" | "observed" }, signal) {
        enabled("memory_write", signal);
        await assertMobileResumeObservations(app, store, execution?.resume, signal, finance);
        enabled("memory_write", signal);
        if (args.operation && (!args.targetId || !args.evidenceQuote?.trim() || !execution?.userText?.includes(args.evidenceQuote))) throw new Error("固定或取消固定必须引用用户本轮明确要求的原话。");
        if (!args.operation && (!args.title?.trim() || !args.content?.trim() || !args.recallWhen?.trim() || !["explicit", "observed"].includes(args.basis) || !["fact", "view", "decision", "goal", "task", "open_loop", "episode"].includes(args.kind))) throw new Error("新增或修正记忆需要有效的类型、标题、正文、触发场景和依据。");
        if (memory) {
          const plan = args.operation ? await memory.preparePin(args.targetId!, args.operation === "pin") : await memory.prepareToolMemory(args, sessionId, execution?.runId ?? "", toolCallId);
          const semanticKey = args.operation ? mobileMemoryWriteKey(mobileMemoryWriteHash(plan.record), args.targetId) : mobileMemoryWriteKey(mobileMemoryWriteHash(args), args.targetId), now = Date.now();
          const operation: MobileWriteOperation = { id: newId(), taskId: sessionId, runId: execution?.runId ?? "", toolCallId, toolName: "memory_write", memoryRepository: "canonical",
            semanticKey, status: "prepared", createdAt: now, updatedAt: now, target: plan.record.id, expectedHash: mobileMemoryWriteHash(plan.record), targetWasMissing: !plan.duplicate && plan.mode !== "pin",
            ...(plan.duplicate || plan.mode === "pin" ? { beforeRevision: plan.original?.revision ?? plan.record.revision } : {}),
            ...(plan.mode === "pin" && plan.original ? { beforeHash: mobileMemoryWriteHash(plan.original) } : {}) };
          const writable = () => { enabled("memory_write", signal); if (execution) { const task = store.getSession(sessionId); if (!task) throw new Error("任务不存在。"); assertMobileWriteRun(task, execution); } };
          writable();
          if (execution) {
            await store.updateSession(sessionId, task => { writable(); assertMobileWriteNotReplayed(task, execution, "memory_write", toolCallId, semanticKey, plan.record.id); task.operations = [...(task.operations ?? []), operation]; });
            await assertMobileResumeObservations(app, store, execution.resume, signal, finance); writable();
            await store.updateSession(sessionId, task => { writable(); const saved = task.operations?.find(item => item.id === operation.id); if (!saved || saved.status !== "prepared") throw new Error("记忆写入意图已变化。"); saved.status = "started"; saved.updatedAt = Date.now(); });
          }
          try {
            const record = await memory.commitToolMemory(plan, writable);
            if (mobileMemoryWriteHash(record) !== operation.expectedHash) throw new Error("记忆写后回读不一致，请核对当前结果。");
            if (execution) await store.updateSession(sessionId, task => { const saved = task.operations?.find(item => item.id === operation.id); if (!saved) throw new Error("记忆写入记录丢失。"); saved.status = "completed"; saved.completedRevision = record.revision; saved.updatedAt = Date.now(); });
            enabled("memory_write", signal); return result(record);
          } catch (error) {
            if (execution) await store.updateSession(sessionId, task => { const saved = task.operations?.find(item => item.id === operation.id); if (saved && saved.status !== "completed") { saved.status = "uncertain"; saved.updatedAt = Date.now(); } });
            throw error;
          }
        }
        if (args.operation) throw new Error("记忆服务尚未就绪，请重新打开插件。");
        const before = args.targetId ? store.state.memories.find(item => item.id === args.targetId) : undefined;
        const expectedBefore = before ? { revision: before.revision, hash: mobileMemoryWriteHash(before) } : undefined;
        const semanticKey = mobileMemoryWriteKey(mobileMemoryWriteHash(args), args.targetId);
        const recordId = args.targetId ?? newId();
        let record: PersonalMemoryRecord | undefined;
        await store.update(latest => {
          checkStopped(signal);
          policy.assertTool("memory_write", args);
          if (!latest.memoryEnabled) requireMobileAgentCapability({ allowed: false, capabilityId: "memory", reason: "memory_disabled" });
          if (latest.permission === "read-only") requireMobileAgentCapability({ allowed: false, capabilityId: "memory", reason: "read_only" });
          assertMobileResumeMemoryObservations(execution?.resume, latest.memories);
          const task = latest.sessions.find(item => item.id === sessionId);
          if (!task) throw new Error("任务不存在，未写入记忆。");
          const old = args.targetId ? latest.memories.find(r => r.id === args.targetId) : undefined;
          if (args.targetId && !old) throw new Error("要修正的记忆不存在。");
          if (execution && old && (!expectedBefore || old.revision !== expectedBefore.revision || mobileMemoryWriteHash(old) !== expectedBefore.hash)) throw new Error("记忆版本已变化，请重新读取后再修改。");
          const duplicate = latest.memories.find(r => r.content === args.content && r.kind === args.kind && r.status === "current");
          const target = duplicate?.id ?? old?.id ?? recordId;
          if (execution) assertMobileWriteNotReplayed(task, execution, "memory_write", toolCallId, semanticKey, target);
          record = duplicate ?? { schema: PERSONAL_MEMORY_SCHEMA, id: old?.id ?? recordId, pinned: old?.pinned, kind: args.kind, status: "current", date: new Date().toISOString(), source: `mobile:${sessionId}:${toolCallId}`, basis: args.basis, contentOrigin: args.basis === "explicit" ? "user_statement" : "current_instruction", title: args.title, content: args.content, recallWhen: args.recallWhen, revision: (old?.revision ?? 0) + 1, file: store.statePath };
          if (!duplicate) latest.memories = [record, ...latest.memories.filter(r => r.id !== record!.id)];
          if (execution) {
            const previous = duplicate ?? old, now = Date.now();
            task.operations = [...(task.operations ?? []), { id: newId(), taskId: sessionId, runId: execution.runId, toolCallId,
              toolName: "memory_write", semanticKey, status: "completed", createdAt: now, updatedAt: now, target: record.id,
              expectedHash: mobileMemoryWriteHash(record), targetWasMissing: !previous,
              ...(previous ? { beforeRevision: previous.revision } : {}), completedRevision: record.revision }];
          }
        });
        return result(record);
      }
    });
  }
  tools.push(mobileNoteUpdateTool(app, store, sessionId, policy, execution, bindings, finance));
  if (finance) tools.push(...mobileFinanceTools(app, finance, store, sessionId, policy, execution));
  return tools.filter(tool => {
    try { policy.assertTool(tool.name); return true; } catch { return false; }
  });
}
