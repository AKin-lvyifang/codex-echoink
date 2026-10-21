import type { App } from "obsidian";
import type { PersonalMemoryRecord } from "../harness/memory/personal-memory-contracts";
import { sha256Hex } from "../utils/sha256";
import type { MobileResumeSnapshot, MobileToolExecutionContext, MobileWriteOperation } from "./task-contracts";
import type { MobileSession, MobileStore } from "./store";
import type { LifestyleFinanceService } from "../lifestyle/finance-service";
import { mobileFinanceObservation, mobileFinanceReceiptFollows, type MobileFinanceObservation } from "./finance-journal";
import { isFinanceTool, financeToolEffect, normalizeFinanceToolRequest, type PiFinanceToolId } from "../harness/pi-native/finance-tool-policy";

type WriteTool = MobileWriteOperation["toolName"];
interface LegacyWrite { id: string; toolCallId: string; toolName: WriteTool; runId?: string; target?: string; requestedTarget?: string; receiptTarget?: string; semanticKey?: string; expectedHash?: string; financeTool?: PiFinanceToolId }
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const stopped = (signal?: AbortSignal) => { if (signal?.aborted) throw new Error("已停止，未继续核对或写入。"); };
const changed = () => new Error("上次写入的目标或记录已变化，请重新核对后再继续。");
export function normalizeMobileNoteTarget(value: string): string {
  const path = value.trim();
  if (!path || path.startsWith("/") || /[\\:]/u.test(path) || Array.from(path).some(character => character.charCodeAt(0) < 32)
    || path.split("/").some(part => !part || part.startsWith(".")) || !path.toLowerCase().endsWith(".md")) {
    throw new Error("请使用当前笔记库内的 Markdown 相对路径，例如：笔记/想法.md。");
  }
  return path;
}
export const mobileNoteWriteKey = (path: string): string => `note_create:${path}`;
export function mobileMemoryWriteHash(value: Readonly<{ kind: string; title: string; content: string; recallWhen: string; basis: string }>): string {
  return sha256Hex(JSON.stringify({ kind: value.kind, title: value.title, content: value.content, recallWhen: value.recallWhen, basis: value.basis }));
}
export const mobileMemoryWriteKey = (hash: string, targetId?: string): string => `memory_write:${targetId ?? "new"}:${hash}`;
export const mobileNoteUpdateKey = (path: string, beforeHash: string, requestedHash: string): string => `note_update:${path}:${beforeHash}:${requestedHash}`;
export function assertMobileWriteRun(task: MobileSession, execution: MobileToolExecutionContext): void {
  const run = task.runs?.find(item => item.id === execution.runId);
  if (!run || run.status !== "running") throw new Error("这次运行已结束或中断，未开始新的写入。");
  if (execution.resume && execution.resume.taskId !== task.id) throw changed();
}
export function assertMobileWriteNotReplayed(task: MobileSession, execution: MobileToolExecutionContext,
  toolName: WriteTool, toolCallId: string, semanticKey: string, target: string): void {
  assertMobileWriteRun(task, execution);
  const recordedRepeat = (task.operations ?? []).some(operation => operation.semanticKey === semanticKey
      && (!["finance_write", "note_update"].includes(toolName) || operation.toolName !== toolName || operation.status !== "completed" || operation.runId === execution.runId || !!execution.resume)
    || operation.runId === execution.runId && operation.toolCallId === toolCallId);
  if (recordedRepeat && !execution.resume) throw new Error("这次写入已有记录，不能重复执行；请基于现有结果继续。");
  // The review does not erase uncertainty: this guard also applies to later ordinary turns.
  const legacy = legacyWrites(task).filter(operation => !(operation.runId === execution.runId && operation.toolName === toolName && operation.toolCallId === toolCallId));
  if (legacy.some(operation => operation.toolName === toolName && (toolName === "note_update" && operation.semanticKey ? operation.semanticKey === semanticKey : !operation.target || operation.target === target || operation.requestedTarget === target || operation.semanticKey === semanticKey))
    || execution.resume?.operations.some(operation => operation.toolName === toolName && (toolName === "mcp_write" || toolName === "note_update" ? operation.semanticKey === semanticKey : operation.target === target || operation.semanticKey === semanticKey))) {
    throw new Error("上次写入已完成或结果仍不确定，不能重放；核对只允许基于现状继续。");
  }
  if (recordedRepeat) {
    throw new Error("这次写入已有记录，不能重复执行；请基于现有结果继续。");
  }
}
function memoryVersion(records: readonly PersonalMemoryRecord[], target: string): string {
  const record = records.find(item => item.id === target);
  return record ? `revision:${record.revision}:sha256:${mobileMemoryWriteHash(record)}` : "missing";
}
function observationTarget(toolName: WriteTool, target: string): string { return `${toolName}:${target}`; }
async function noteVersion(app: App, target: string): Promise<string> {
  try {
    if (normalizeMobileNoteTarget(target) !== target) return "unreadable";
    if (!await app.vault.adapter.exists(target)) return "missing";
    return `sha256:${sha256Hex(await app.vault.adapter.read(target))}`;
  } catch { return "unreadable"; }
}
async function currentVersion(app: App, store: MobileStore, target: string, finance?: LifestyleFinanceService, operations: readonly MobileWriteOperation[] = []): Promise<string> {
  if (target.startsWith("finance_write:")) {
    const operation = operations.find(item => item.toolName === "finance_write" && observationTarget(item.toolName, item.target) === target);
    return operation?.finance ? (await mobileFinanceObservation(finance, operation.finance)).hash : "unreadable";
  }
  return target.startsWith("note_update:") ? noteVersion(app, target.slice("note_update:".length)) : target.startsWith("note_create:") ? noteVersion(app, target.slice("note_create:".length))
    : target.startsWith("memory_write:") ? memoryVersion(await store.readMemoryRecords(), target.slice("memory_write:".length)) : "unreadable";
}
export async function assertMobileResumeObservations(app: App, store: MobileStore, snapshot?: MobileResumeSnapshot, signal?: AbortSignal, finance?: LifestyleFinanceService): Promise<void> {
  if (!snapshot) return;
  for (const observation of snapshot.observations) {
    stopped(signal);
    if (await currentVersion(app, store, observation.target, finance, snapshot.operations) !== observation.version) throw changed();
    stopped(signal);
  }
}
export function assertMobileResumeMemoryObservations(snapshot: MobileResumeSnapshot | undefined, records: readonly PersonalMemoryRecord[]): void {
  for (const observation of snapshot?.observations ?? []) if (observation.target.startsWith("memory_write:")
    && memoryVersion(records, observation.target.slice("memory_write:".length)) !== observation.version) throw changed();
}
/** Accepted runs append exactly one user turn; queued, unaccepted runs have no message boundary. */
function messageRunIds(task: MobileSession): Map<number, string> {
  const pending = new Set((task.queue ?? []).map(turn => turn.id));
  const runs = (task.runs ?? []).filter(run => !pending.has(run.id));
  const boundaries = task.messages.flatMap((message, index) => message.role === "user" ? [{ index, timestamp: message.timestamp }] : []);
  const result = new Map<number, string>();
  if (!runs.length || boundaries.length < runs.length) return result;
  const accepted = boundaries.slice(-runs.length);
  if (runs.some((run, index) => typeof accepted[index].timestamp !== "number" || accepted[index].timestamp < run.startedAt
    || index > 0 && run.startedAt < runs[index - 1].startedAt)) return result;
  runs.forEach((run, index) => {
    const end = accepted[index + 1]?.index ?? task.messages.length;
    for (let message = accepted[index].index; message < end; message++) result.set(message, run.id);
  });
  return result;
}
function legacyWrites(task: MobileSession): LegacyWrite[] {
  const facts: (LegacyWrite & { receipt?: boolean })[] = [], runIds = messageRunIds(task);
  for (const [messageIndex, message] of task.messages.entries()) {
    const item = object(message);
    if (item.role === "assistant" && Array.isArray(item.content)) for (const [blockIndex, raw] of item.content.entries()) {
      const block = object(raw);
      const financeTool = typeof block.name === "string" && isFinanceTool(block.name) ? block.name : undefined;
      if (block.type !== "toolCall" || (block.name !== "note_create" && block.name !== "note_update" && block.name !== "memory_write" && !financeTool)) continue;
      if (financeTool) { try { if (financeToolEffect(financeTool, normalizeFinanceToolRequest(financeTool, block.arguments)) === "read") continue; } catch { if (financeTool === "finance_query") continue; } }
      const callId = typeof block.id === "string" && block.id ? block.id : `unidentified-${messageIndex}-${blockIndex}`;
      const key = `${messageIndex}:${blockIndex}:${String(block.name)}:${callId}`;
      const args = object(block.arguments), fact: LegacyWrite = { id: `legacy-${sha256Hex(key).slice(0, 24)}`, toolCallId: callId, toolName: financeTool ? "finance_write" : block.name as WriteTool, ...(financeTool ? { financeTool } : {}),
        ...(runIds.has(messageIndex) ? { runId: runIds.get(messageIndex) } : {}) };
      if ((block.name === "note_create" || block.name === "note_update") && typeof args.path === "string") {
        try { fact.target = normalizeMobileNoteTarget(args.path); fact.semanticKey = block.name === "note_update" && typeof args.expectedContentRevision === "string" && /^sha256:[a-f0-9]{64}$/u.test(args.expectedContentRevision) && typeof args.content === "string" ? mobileNoteUpdateKey(fact.target, args.expectedContentRevision.slice(7), sha256Hex(args.content)) : block.name === "note_create" ? mobileNoteWriteKey(fact.target) : undefined; } catch { /* Invalid historical targets remain unknown. */ }
        if (typeof args.content === "string") fact.expectedHash = sha256Hex(args.content);
      } else if (block.name === "memory_write") {
        if (typeof args.targetId === "string" && args.targetId) { fact.target = args.targetId; fact.requestedTarget = args.targetId; }
        if (["kind", "title", "content", "recallWhen", "basis"].every(field => typeof args[field] === "string")) {
          fact.expectedHash = mobileMemoryWriteHash(args as unknown as Parameters<typeof mobileMemoryWriteHash>[0]);
          fact.semanticKey = mobileMemoryWriteKey(fact.expectedHash, fact.target);
        }
      }
      facts.push(fact);
    }
    const financeTool = typeof item.toolName === "string" && isFinanceTool(item.toolName) ? item.toolName : undefined;
    if (item.role === "toolResult" && (item.toolName === "note_create" || item.toolName === "note_update" || item.toolName === "memory_write" || financeTool)) {
      const callId = typeof item.toolCallId === "string" && item.toolCallId ? item.toolCallId : `unidentified-result-${messageIndex}`;
      const details = object(item.details);
      if (financeTool && (financeTool === "finance_query" || details.command === "finance_budget.get" || details.command === "finance_bill.list")) continue;
      const writeTool: WriteTool = financeTool ? "finance_write" : item.toolName as WriteTool;
      let target: string | undefined;
      if ((item.toolName === "note_create" || item.toolName === "note_update") && typeof details.path === "string") {
        try { target = normalizeMobileNoteTarget(details.path); } catch { /* A receipt is not proof of a valid target. */ }
      } else if (item.toolName === "memory_write" && typeof details.id === "string" && details.id) target = details.id;
      const prior = [...facts].reverse().find(fact => !fact.receipt && fact.toolName === writeTool && fact.financeTool === financeTool && fact.toolCallId === callId
        && fact.runId === runIds.get(messageIndex) && (item.toolName === "memory_write" || !fact.target || !target || fact.target === target));
      if (prior) { prior.receipt = true; if (target) { prior.target = target; prior.receiptTarget = target; } }
      else facts.push({ id: `legacy-${sha256Hex(`${messageIndex}:result:${String(item.toolName)}:${callId}`).slice(0, 24)}`,
        toolCallId: callId, toolName: writeTool, ...(financeTool ? { financeTool } : {}), ...(runIds.has(messageIndex) ? { runId: runIds.get(messageIndex) } : {}), ...(target ? { target } : {}), receipt: true });
    }
  }
  const covered = new Set<string>();
  for (const operation of task.operations ?? []) {
    // Provider IDs are only unique within a run. Missing/ambiguous attribution stays unknown.
    const matches = facts.filter(fact => fact.runId === operation.runId && fact.toolName === operation.toolName && fact.toolCallId === operation.toolCallId
      && (operation.toolName === "finance_write" ? fact.financeTool === operation.finance?.tool : fact.semanticKey === operation.semanticKey && (operation.toolName === "note_create" || operation.toolName === "note_update"
        ? fact.target === operation.target && fact.expectedHash === (operation.toolName === "note_update" ? operation.requestedHash : operation.expectedHash)
        : !fact.receiptTarget || fact.receiptTarget === operation.target)));
    if (matches.length === 1) covered.add(matches[0].id);
  }
  return facts.filter(fact => !covered.has(fact.id)).map(({ receipt: _receipt, ...fact }) => fact).sort((a, b) => a.id.localeCompare(b.id));
}
const stableFacts = (task: MobileSession) => JSON.stringify({ operations: task.operations ?? [], legacy: legacyWrites(task) });

/** Reads targets only. The sole permitted repair records an exact, previously intended create. */
export async function inspectMobileTaskResume(app: App, store: MobileStore, taskId: string, signal?: AbortSignal, finance?: LifestyleFinanceService): Promise<MobileResumeSnapshot> {
  stopped(signal); await store.flush(); stopped(signal);
  const task = store.getSession(taskId);
  if (!task) throw new Error("任务不存在，未核对写入记录。");
  const baseline = stableFacts(task), operations = structuredClone(task.operations ?? []), legacy = legacyWrites(task);
  const observations = new Map<string, string>(), issues: MobileResumeSnapshot["issues"] = [], completed = new Set<string>();
  const noteVersions = new Map<string, string>(), verifiedNotes = new Set<string>();
  for (let index = operations.length - 1; index >= 0; index--) {
    const operation = operations[index];
    if (operation.toolName !== "note_create" && operation.toolName !== "note_update") continue;
    stopped(signal);
    const version = noteVersions.get(operation.target) ?? await noteVersion(app, operation.target); noteVersions.set(operation.target, version);
    const exact = version === `sha256:${operation.expectedHash}` && (operation.toolName === "note_update" || operation.targetWasMissing === true);
    const followed = operation.status === "completed" && operations.slice(index + 1).some(next => next.toolName === "note_update" && next.status === "completed" && next.target === operation.target && next.beforeHash === operation.expectedHash && verifiedNotes.has(next.id));
    if (exact || followed) verifiedNotes.add(operation.id);
    if (exact && operation.status !== "completed") { operation.status = "completed"; completed.add(operation.id); }
  }
  const financeObservations = new Map<string, MobileFinanceObservation>(), verifiedFinance = new Set<string>();
  for (let index = operations.length - 1; index >= 0; index--) {
    const operation = operations[index];
    if (operation.toolName !== "finance_write") continue;
    stopped(signal);
    const observed: MobileFinanceObservation = operation.finance ? await mobileFinanceObservation(finance, operation.finance) : { hash: "unreadable", matches: false };
    stopped(signal); financeObservations.set(operation.id, observed);
    if (operation.status !== "completed" || !operation.finance) continue;
    if (observed.matches && observed.hash !== "unreadable" && observed.hash === operation.finance.observedHash
      || operations.slice(index + 1).some(next => next.toolName === "finance_write" && next.status === "completed" && next.finance
        && verifiedFinance.has(next.id) && mobileFinanceReceiptFollows(operation.finance!, next.finance, observed.records))) verifiedFinance.add(operation.id);
  }
  for (const operation of operations) {
    stopped(signal);
    if (operation.toolName === "finance_write") {
      const key = observationTarget(operation.toolName, operation.target), observed = financeObservations.get(operation.id)!;
      stopped(signal); observations.set(key, observed.hash);
      if (!verifiedFinance.has(operation.id)) issues.push({ operationId: operation.id, target: operation.target,
        status: operation.status === "completed" && observed.hash !== "unreadable" ? "conflict" : "unknown", label: "原财务写入结果或当前版本尚未核实；只能查询现状，不能重放。" });
      continue;
    }
    if (operation.toolName === "mcp_write") {
      // Reading a local note cannot establish an external effect. Only the original
      // same-call readback may have marked it completed. Resume never replays it.
      if (operation.status !== "completed") issues.push({ operationId: operation.id, target: operation.target, status: "unknown",
        label: "外部 MCP 写入结果尚未核实；只能基于现状继续，不能重放旧写入。" });
      continue;
    }
    const key = observationTarget(operation.toolName, operation.target), version = await currentVersion(app, store, key);
    stopped(signal); observations.set(key, version);
    if (operation.toolName === "note_create" || operation.toolName === "note_update") {
      if (verifiedNotes.has(operation.id)) {
        if (operation.status !== "completed") { operation.status = "completed"; completed.add(operation.id); }
      } else issues.push({ operationId: operation.id, target: operation.target, status: version === "missing" || version === "unreadable" ? "unknown" : "conflict",
        label: version === "missing" ? "原写入目标当前不存在，不能据此推断从未写入。" : version === "unreadable" ? "原写入目标暂时无法读取。" : "当前笔记与原写入内容不同。" });
    } else if (operation.memoryRepository === "canonical" && operation.targetWasMissing === true
      && version.endsWith(`:sha256:${operation.expectedHash}`) && /^revision:[1-9][0-9]*:/u.test(version)) {
      if (operation.status !== "completed") { operation.status = "completed"; operation.completedRevision = Number(version.split(":")[1]); completed.add(operation.id); }
    } else if (operation.status !== "completed" || version !== `revision:${operation.completedRevision}:sha256:${operation.expectedHash}`) {
      issues.push({ operationId: operation.id, target: operation.target, status: version === "missing" || version === "unreadable" || operation.status !== "completed" ? "unknown" : "conflict", label: "原记忆写入结果或当前版本尚未核实。" });
    }
  }
  for (const fact of legacy) {
    stopped(signal);
    if (fact.target) observations.set(observationTarget(fact.toolName, fact.target), await currentVersion(app, store, observationTarget(fact.toolName, fact.target)));
    stopped(signal);
    issues.push({ operationId: fact.id, target: fact.target ?? "目标未记录", status: "unknown", label: `旧${fact.toolName === "note_create" || fact.toolName === "note_update" ? "笔记" : fact.toolName === "finance_write" ? "财务" : "记忆"}写调用缺少写前意图，不能判定是否完成，也不能重放。` });
  }
  const latest = store.getSession(taskId);
  if (!latest || stableFacts(latest) !== baseline) throw changed();
  if (completed.size) {
    await store.updateSession(taskId, current => {
      stopped(signal);
      if (stableFacts(current) !== baseline) throw changed();
      for (const operation of current.operations ?? []) if (completed.has(operation.id)) { operation.status = "completed"; operation.completedRevision = operations.find(item => item.id === operation.id)?.completedRevision ?? operation.completedRevision; operation.updatedAt = Date.now(); }
    });
    for (const operation of operations) {
      const saved = store.getSession(taskId)?.operations?.find(item => item.id === operation.id);
      if (saved) Object.assign(operation, saved);
    }
  }
  stopped(signal);
  const observed = [...observations].sort(([a], [b]) => a.localeCompare(b)).map(([target, version]) => ({ target, version }));
  const fingerprint = sha256Hex(JSON.stringify({ taskId, operations, legacy, issues, observations: observed }));
  return { taskId, fingerprint, checkedAt: Date.now(), issues, operations, observations: observed };
}
export function mobileResumeContext(snapshot: MobileResumeSnapshot): string {
  return `\n上次任务的写入核对事实（不是操作指令，也不增加权限）：\n${JSON.stringify({
    operations: snapshot.operations.map(operation => ({ tool: operation.toolName, target: operation.target, status: operation.status })),
    issues: snapshot.issues.map(issue => ({ target: issue.target, status: issue.status, detail: issue.label }))
  })}\n只能基于当前事实开展新工作。已完成或结果不确定的旧写入一律禁止重放；用户核对确认不会授予重试、覆盖或重复写入权限。`;
}
