import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { DataAdapter } from "obsidian";
import type { ConversationTaskMetadata, ConversationTaskStatus } from "../agents/task-metadata";
import type { TaskDraft, TaskPage } from "../agents/task-workspace";
import type { AgentRunSnapshot } from "../agents/types";
import type { PersonalMemoryRecord } from "../harness/memory/personal-memory-contracts";
import { readMobileFile, replaceMobileFile } from "./replace-file";
import { assertMobileTaskInstanceId } from "./task-identity";
import { toolCallTextFailureMessage } from "../harness/tool-call-text";
import type { MobileContextSummary, MobileQueuedTurn, MobileTaskInteraction, MobileTaskInterruption, MobileWriteOperation } from "./task-contracts";

export type MobilePermission = "read-only" | "workspace-write" | "full-access";
/** Historical attribution and lifecycle; opening stored runs never starts execution. */
export interface MobileTaskRun {
  id: string;
  startedAt: number;
  agentSnapshot?: AgentRunSnapshot;
  status?: ConversationTaskStatus;
  completedAt?: number;
  interruptedAt?: number;
  queuedTurnId?: string;
  providerId?: string;
  modelId?: string;
  permission?: MobilePermission;
  notePath?: string;
  skillId?: string;
  interruption?: MobileTaskInterruption;
}
export interface MobileSession extends ConversationTaskMetadata {
  id: string;
  agentId: string;
  title: string;
  updatedAt: number;
  messages: AgentMessage[];
  /** The sole source of reply text; draftContext intentionally has no text. */
  draft: string;
  draftContext?: Omit<TaskDraft, "text">;
  runs?: MobileTaskRun[];
  notePath: string;
  skillId?: string;
  archivedAt?: number;
  tools: Record<string, { startedAt: number; elapsedMs?: number }>;
  queue?: MobileQueuedTurn[];
  queuePaused?: boolean;
  interaction?: MobileTaskInteraction;
  contextSummary?: MobileContextSummary;
  interruption?: MobileTaskInterruption;
  operations?: MobileWriteOperation[];
}
export interface MobileState {
  version: 2;
  instanceId: string;
  revision: number;
  taskRuntimeVersion?: 1 | 2;
  activeSessionId: string;
  sessions: MobileSession[];
  memoryEnabled: boolean;
  memories: PersonalMemoryRecord[];
  permission: MobilePermission;
  page: TaskPage;
  newTaskDrafts: Record<string, TaskDraft>;
}
export type MobileStorageAdapter = Pick<DataAdapter, "exists" | "read" | "write" | "mkdir" | "rename" | "remove">;
export const newId = () => crypto.randomUUID();
export function newSession(agentId = "sol"): MobileSession {
  return { id: newId(), agentId, title: "新对话", updatedAt: Date.now(), messages: [], draft: "", notePath: "", tools: {} };
}

/** Expected data/version conflicts are recoverable at the plugin bootstrap boundary. */
export class MobileDataConflictError extends Error {}
export function isMobileDataConflict(error: unknown): error is Error {
  return error instanceof MobileDataConflictError || error instanceof AggregateError
    && error.errors.length > 0 && error.errors.every(isMobileDataConflict);
}
const dataError = () => new MobileDataConflictError("移动端本地数据格式或版本无法读取，已保留原文件。");
function parseData(content: string): unknown { try { return JSON.parse(content); } catch { throw dataError(); } }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const nonempty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const time = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const permission = (value: unknown): value is MobilePermission => ["read-only", "workspace-write", "full-access"].includes(value as string);
function validInterruption(value: unknown): boolean {
  return object(value) && Object.keys(value).every(key => ["at", "reason", "stage", "toolCallTextFailure"].includes(key)) && time(value.at) && nonempty(value.stage)
    && (value.toolCallTextFailure === undefined || !!toolCallTextFailureMessage(value.toolCallTextFailure))
    && ["app_closed", "user_stopped", "plugin_disabled", "run_failed", "process_unknown", "watchdog", "app_backgrounded"].includes(value.reason as string);
}
function validOperations(value: unknown, session: Record<string, unknown>, ids: Set<string>): boolean {
  if (!uniqueRecords(value)) return false;
  const calls = new Set<string>();
  const runs = Array.isArray(session.runs) ? session.runs as Record<string, unknown>[] : [];
  return value.every(operation => {
    const call = `${String(operation.runId)}\0${String(operation.toolCallId)}`;
    if (ids.has(operation.id as string) || calls.has(call) || operation.taskId !== session.id || !nonempty(operation.runId)
      || !runs.some(run => run.id === operation.runId) || !nonempty(operation.toolCallId) || !nonempty(operation.semanticKey) || !nonempty(operation.target)
      || !["note_create", "note_update", "memory_write", "mcp_write", "finance_write"].includes(operation.toolName as string) || !["prepared", "started", "completed", "uncertain"].includes(operation.status as string)
      || !time(operation.createdAt) || !time(operation.updatedAt) || operation.updatedAt < operation.createdAt
      || typeof operation.expectedHash !== "string" || !/^[a-f0-9]{64}$/u.test(operation.expectedHash)
      || Object.keys(operation).some(key => !["id", "taskId", "runId", "toolCallId", "toolName", "semanticKey", "status", "createdAt", "updatedAt", "target", "expectedHash", "beforeHash", "requestedHash", "targetWasMissing", "beforeRevision", "completedRevision", "mcp", "memoryRepository", "finance"].includes(key))) return false;
    if (operation.toolName !== "note_update" && (operation.beforeHash !== undefined || operation.requestedHash !== undefined)) return false;
    if (operation.toolName !== "mcp_write" && operation.mcp !== undefined) return false;
    if (operation.toolName !== "finance_write" && operation.finance !== undefined) return false;
    if (operation.memoryRepository !== undefined && (operation.toolName !== "memory_write" || operation.memoryRepository !== "canonical")) return false;
    if (operation.toolName === "note_create" || operation.toolName === "note_update") {
      const path = operation.target;
      if (path.trim() !== path || path.startsWith("/") || /[\\:]/u.test(path) || [...path].some(char => char.charCodeAt(0) < 32) || path.split("/").some(part => !part || part.startsWith(".")) || !/\.md$/iu.test(path)
        || (operation.toolName === "note_create" ? operation.semanticKey !== `note_create:${path}` || operation.targetWasMissing !== true : typeof operation.beforeHash !== "string" || !/^[a-f0-9]{64}$/u.test(operation.beforeHash) || typeof operation.requestedHash !== "string" || !/^[a-f0-9]{64}$/u.test(operation.requestedHash) || operation.semanticKey !== `note_update:${path}:${operation.beforeHash}:${operation.requestedHash}` || operation.targetWasMissing !== undefined) || operation.beforeRevision !== undefined || operation.completedRevision !== undefined) return false;
    } else if (operation.toolName === "memory_write" && operation.memoryRepository === "canonical") {
      if (typeof operation.targetWasMissing !== "boolean" || !/^memory_write:.+:[a-f0-9]{64}$/u.test(operation.semanticKey)
        || (operation.beforeRevision !== undefined && (!Number.isSafeInteger(operation.beforeRevision) || Number(operation.beforeRevision) < 1))
        || (operation.status === "completed" && (!Number.isSafeInteger(operation.completedRevision) || Number(operation.completedRevision) < 1))
        || (operation.completedRevision !== undefined && (!Number.isSafeInteger(operation.completedRevision) || Number(operation.completedRevision) < Number(operation.beforeRevision ?? 0)))) return false;
    } else if (operation.toolName === "memory_write") {
      if (operation.status !== "completed" || typeof operation.targetWasMissing !== "boolean" || !Number.isSafeInteger(operation.completedRevision) || (operation.completedRevision as number) < 1
        || !/^memory_write:.+:[a-f0-9]{64}$/u.test(operation.semanticKey)) return false;
      if (operation.beforeRevision !== undefined && (!Number.isSafeInteger(operation.beforeRevision) || (operation.beforeRevision as number) < 1
        || operation.targetWasMissing || (operation.completedRevision as number) < (operation.beforeRevision as number) || (operation.completedRevision as number) > (operation.beforeRevision as number) + 1)) return false;
      if (operation.beforeRevision === undefined && (!operation.targetWasMissing || operation.completedRevision !== 1)) return false;
    } else if (operation.toolName === "finance_write") {
      if (!/^finance:[a-f0-9]{64}$/u.test(String(operation.target)) || !/^finance_write:[a-f0-9]{64}$/u.test(String(operation.semanticKey))
        || !validMobileFinanceEvidence(operation.finance, operation.status, operation.expectedHash)
        || operation.targetWasMissing !== undefined || operation.beforeRevision !== undefined || operation.completedRevision !== undefined) return false;
    } else {
      const mcp = operation.mcp;
      const identity = (value: unknown, maximum: number): value is string => nonempty(value) && value === value.trim() && value.length <= maximum && ![...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
      if (!object(mcp) || Object.keys(mcp).some(key => !["resourceId", "toolName"].includes(key))
        || !identity(mcp.resourceId, 1024) || !identity(mcp.toolName, 256)
        || operation.target !== `${mcp.resourceId}/${mcp.toolName}` || operation.semanticKey !== `mcp_write:${operation.target}:${operation.expectedHash}`
        || operation.targetWasMissing !== undefined || operation.beforeRevision !== undefined || operation.completedRevision !== undefined) return false;
    }
    calls.add(call); ids.add(operation.id as string); return true;
  });
}
function uniqueRecords(value: unknown): value is Record<string, unknown>[] {
  if (!Array.isArray(value)) return false;
  const ids = new Set<string>();
  return value.every(item => {
    if (!object(item) || !nonempty(item.id) || ids.has(item.id)) return false;
    ids.add(item.id); return true;
  });
}
function validDraft(value: unknown, reply = false): boolean {
  return object(value) && (reply ? !Object.hasOwn(value, "text") : typeof value.text === "string")
    && Array.isArray(value.attachments) && value.attachments.every(object)
    && ["selectedModel", "selectedProviderSettingsId", "prefillSource", "englishDiarySourcePath"].every(key => value[key] === undefined || typeof value[key] === "string")
    && (value.selectedPermission === undefined || ["read-only", "workspace-write", "danger-full-access"].includes(value.selectedPermission as string))
    && (value.selectedMode === undefined || ["agent", "plan"].includes(value.selectedMode as string));
}
function validMetadata(value: Record<string, unknown>): boolean {
  const status = value.taskStatus;
  const pending = value.pendingResponse;
  return (status === undefined || ["running", "waiting", "completed", "interrupted"].includes(status as string))
    && ["taskStartedAt", "taskCompletedAt", "taskInterruptedAt", "unreadAnswerAt", "lastReadAt", "taskMetadataUpdatedAt"].every(key => value[key] === undefined || time(value[key]))
    && ["businessKey", "taskStage"].every(key => value[key] === undefined || typeof value[key] === "string")
    && (pending === undefined || (object(pending) && nonempty(pending.runId) && nonempty(pending.questionId) && ["question", "confirmation"].includes(pending.kind as string)));
}
function validRun(value: Record<string, unknown>): boolean {
  const snapshot = value.agentSnapshot;
  return time(value.startedAt) && ["queuedTurnId", "providerId", "modelId", "notePath", "skillId"].every(key => value[key] === undefined || typeof value[key] === "string")
    && (value.permission === undefined || permission(value.permission)) && (value.status === undefined || ["running", "waiting", "completed", "interrupted"].includes(value.status as string))
    && ["completedAt", "interruptedAt"].every(key => value[key] === undefined || time(value[key]))
    && (value.interruption === undefined || (value.status === "interrupted" && validInterruption(value.interruption) && value.interruptedAt === (value.interruption as Record<string, unknown>).at))
    && (snapshot === undefined || (object(snapshot) && nonempty(snapshot.agentId) && typeof snapshot.name === "string" && typeof snapshot.position === "string"
      && ["execution", "analysis", "companion", "creative"].includes(snapshot.styleId as string)
      && ["capabilityIds", "disabledCapabilityIds"].every(key => snapshot[key] === undefined || (Array.isArray(snapshot[key]) && snapshot[key].every(value => typeof value === "string")))));
}
function validQueue(value: unknown): boolean {
  return uniqueRecords(value) && value.every(turn => Object.keys(turn).every(key => ["id", "text", "createdAt", "agentSnapshot", "providerId", "modelId", "permission", "notePath", "skillId"].includes(key))
    && nonempty(turn.text) && time(turn.createdAt) && nonempty(turn.providerId) && nonempty(turn.modelId) && permission(turn.permission)
    && typeof turn.notePath === "string" && (turn.skillId === undefined || typeof turn.skillId === "string")
    && object(turn.agentSnapshot) && Object.keys(turn.agentSnapshot).every(key => ["agentId", "name", "position", "styleId", "capabilityIds", "disabledCapabilityIds"].includes(key))
    && validRun({ startedAt: turn.createdAt, agentSnapshot: turn.agentSnapshot }));
}
function validInteraction(value: unknown, session: Record<string, unknown>): boolean {
  if (!object(value) || value.taskId !== session.id || !nonempty(value.runId) || !nonempty(value.questionId)
    || !["question", "confirmation"].includes(value.kind as string) || !["pending", "answered", "cancelled"].includes(value.status as string)
    || !time(value.createdAt) || !Array.isArray(value.questions) || !value.questions.length || value.questions.length > 3) return false;
  const questionIds = new Set<string>();
  for (const question of value.questions) {
    if (!object(question) || !nonempty(question.questionId) || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u.test(question.questionId) || questionIds.has(question.questionId) || !nonempty(question.prompt) || question.prompt.length > 1_000
      || !["single", "multiple"].includes(question.selection as string) || typeof question.allowSupplement !== "boolean" || !Array.isArray(question.options) || question.options.length < 2 || question.options.length > 8) return false;
    questionIds.add(question.questionId);
    const optionIds = new Set<string>();
    for (const option of question.options) {
      if (!object(option) || !nonempty(option.optionId) || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u.test(option.optionId) || optionIds.has(option.optionId) || !nonempty(option.label) || option.label.length > 200
        || (option.description !== undefined && (typeof option.description !== "string" || option.description.length > 500))) return false;
      optionIds.add(option.optionId);
    }
  }
  if (value.answers !== undefined) {
    if (!Array.isArray(value.answers) || value.answers.length !== value.questions.length) return false;
    const answered = new Set<string>();
    for (const answer of value.answers) {
      if (!object(answer) || !nonempty(answer.questionId) || answered.has(answer.questionId)) return false;
      const question = value.questions.find(question => object(question) && question.questionId === answer.questionId) as Record<string, unknown> | undefined;
      if (!question || !Array.isArray(answer.selectedOptionIds) || new Set(answer.selectedOptionIds).size !== answer.selectedOptionIds.length
        || (question.selection === "single" && answer.selectedOptionIds.length > 1)
        || answer.selectedOptionIds.some(id => !(question.options as Record<string, unknown>[]).some(option => option.optionId === id))
        || (answer.supplement !== undefined && (typeof answer.supplement !== "string" || answer.supplement.length > 1_000 || !question.allowSupplement))
        || (!answer.selectedOptionIds.length && !nonempty(answer.supplement))) return false;
      answered.add(answer.questionId);
    }
  }
  return value.status !== "answered" || value.answers !== undefined;
}
function validateBase(value: unknown): asserts value is Record<string, unknown> & { sessions: Record<string, unknown>[] } {
  if (!object(value) || !uniqueRecords(value.sessions) || !uniqueRecords(value.memories)
    || typeof value.activeSessionId !== "string" || typeof value.memoryEnabled !== "boolean" || !permission(value.permission)) throw dataError();
  for (const session of value.sessions) {
    if (typeof session.title !== "string" || !time(session.updatedAt) || typeof session.draft !== "string" || typeof session.notePath !== "string"
      || !Array.isArray(session.messages) || !session.messages.every(item => object(item) && nonempty(item.role)) || !object(session.tools)
      || Object.values(session.tools).some(tool => !object(tool) || !time(tool.startedAt) || (tool.elapsedMs !== undefined && !time(tool.elapsedMs)))
      || (session.archivedAt !== undefined && !time(session.archivedAt)) || (session.skillId !== undefined && typeof session.skillId !== "string")) throw dataError();
  }
  for (const memory of value.memories) {
    if (memory.schema !== "echoink.memory.v1" || !["fact", "view", "decision", "goal", "task", "open_loop", "episode"].includes(memory.kind as string)
      || !["current", "superseded", "closed"].includes(memory.status as string) || !["explicit", "observed", "inferred"].includes(memory.basis as string)
      || !["date", "source", "title", "recallWhen", "content", "file"].every(key => typeof memory[key] === "string")
      || !Number.isSafeInteger(memory.revision) || (memory.revision as number) < 1) throw dataError();
  }
}
function parseV2(content: string, instanceId: string): MobileState {
  const value = parseData(content);
  validateBase(value);
  if (value.version !== 2 || value.instanceId !== instanceId || !Number.isSafeInteger(value.revision) || (value.revision as number) < 0
    || (value.taskRuntimeVersion !== undefined && value.taskRuntimeVersion !== 1 && value.taskRuntimeVersion !== 2)
    || !value.sessions.length || !value.sessions.some(session => session.id === value.activeSessionId)
    || !object(value.page) || !object(value.newTaskDrafts) || !Object.values(value.newTaskDrafts).every(draft => validDraft(draft))) throw dataError();
  const page = value.page;
  if (!(page.kind === "list" && nonempty(page.agentId)) && !(page.kind === "detail" && nonempty(page.taskId)
    && value.sessions.some(session => session.id === page.taskId))) throw dataError();
  const runIds = new Set<string>();
  const operationIds = new Set<string>();
  for (const session of value.sessions) {
    if (!nonempty(session.agentId) || !validMetadata(session) || (session.draftContext !== undefined && !validDraft(session.draftContext, true))) throw dataError();
    if ((session.queue !== undefined && !validQueue(session.queue)) || (session.queuePaused !== undefined && typeof session.queuePaused !== "boolean")
      || (session.interaction !== undefined && !validInteraction(session.interaction, session))) throw dataError();
    if (value.taskRuntimeVersion === undefined && ["queue", "queuePaused", "interaction", "contextSummary"].some(key => session[key] !== undefined)) throw dataError();
    if ((session.interruption !== undefined && (session.taskStatus !== "interrupted" || !validInterruption(session.interruption) || session.taskInterruptedAt !== (session.interruption as Record<string, unknown>).at))
      || (session.operations !== undefined && !validOperations(session.operations, session, operationIds))) throw dataError();
    if (value.taskRuntimeVersion !== 2 && (session.operations !== undefined || session.interruption !== undefined || (Array.isArray(session.runs) && session.runs.some(run => object(run) && run.interruption !== undefined)))) throw dataError();
    const summary = session.contextSummary;
    if (summary !== undefined && (!object(summary) || !nonempty(summary.text) || !Number.isSafeInteger(summary.throughMessageCount)
      || (summary.throughMessageCount as number) < 1 || (summary.throughMessageCount as number) > (session.messages as unknown[]).length
      || typeof summary.sourceDigest !== "string" || !/^[a-f0-9]{64}$/u.test(summary.sourceDigest) || !time(summary.createdAt))) throw dataError();
    if (session.runs !== undefined) {
      if (!uniqueRecords(session.runs)) throw dataError();
      for (const run of session.runs) {
        if (!validRun(run) || runIds.has(run.id as string)) throw dataError();
        runIds.add(run.id as string);
      }
    }
    const runs = session.runs ?? [];
    if (session.queue !== undefined && (session.queue as Record<string, unknown>[]).some(turn => !runs.some(run => run.id === turn.id))) throw dataError();
    if (object(session.interaction)) {
      const interaction = session.interaction;
      if (!runs.some(run => run.id === interaction.runId)) throw dataError();
      if (interaction.status === "pending" && (!object(session.pendingResponse) || session.pendingResponse.runId !== interaction.runId
        || session.pendingResponse.questionId !== interaction.questionId || session.pendingResponse.kind !== interaction.kind)) throw dataError();
    }
  }
  return value as unknown as MobileState;
}
function migrateV1(content: string, instanceId: string): MobileState {
  const value = parseData(content);
  validateBase(value);
  if (value.version !== 1) throw dataError();
  // Retain references, extension fields and tool payloads without inferring run outcomes.
  const sessions = value.sessions.map(session => ({ ...session, agentId: "sol" })) as unknown as MobileSession[];
  if (!sessions.length) sessions.push(newSession());
  const activeSessionId = sessions.some(session => session.id === value.activeSessionId) ? value.activeSessionId as string : sessions[0].id;
  return parseV2(JSON.stringify({ ...value, version: 2, instanceId, revision: 0, sessions, activeSessionId,
    page: { kind: "detail", taskId: activeSessionId }, newTaskDrafts: {} }), instanceId);
}

/** One authority per instance; only verified commits are visible to readers. */
export class MobileStore {
  private canonicalMemory?: () => Promise<readonly PersonalMemoryRecord[]>;
  bindCanonicalMemory(read: () => Promise<readonly PersonalMemoryRecord[]>): void { this.canonicalMemory = read; }
  readMemoryRecords(): Promise<readonly PersonalMemoryRecord[]> { return this.canonicalMemory ? this.canonicalMemory() : Promise.resolve(this.state.memories); }
  private committed: MobileState;
  private writes: Promise<void> = Promise.resolve();
  private loaded = false;
  private blocked = false;
  private expected: string | null = null;
  readonly statePath: string;
  get m2BackupPath(): string { return `${this.statePath}.m2-backup.json`; }
  get m3BackupPath(): string { return `${this.statePath}.m3-backup.json`; }
  get unavailableReason(): string | undefined { return this.storageIssue; }
  disableWrites(reason: string): void {
    this.storageIssue ??= `${reason} 任务暂不可用，请核对原资料并关闭旧实例后重新打开插件。`;
    this.blocked = true;
  }
  constructor(private adapter: MobileStorageAdapter, private directory: string, readonly instanceId: string, private storageIssue?: string) {
    assertMobileTaskInstanceId(instanceId);
    this.statePath = `${directory}/devices/${instanceId}/state.json`;
    const session = newSession();
    this.committed = { version: 2, instanceId, revision: 0, activeSessionId: session.id, sessions: [session], memoryEnabled: true,
      memories: [], permission: "workspace-write", page: { kind: "detail", taskId: session.id }, newTaskDrafts: {} };
  }
  private get recoveryPath(): string { return `${this.statePath}.task-replace-backup.json`; }
  get state(): MobileState { return structuredClone(this.committed); }
  get permission(): MobilePermission { return this.committed.permission; }
  get memoryEnabled(): boolean { return this.committed.memoryEnabled; }
  get session(): MobileSession { return structuredClone(this.committed.sessions.find(session => session.id === this.committed.activeSessionId)!); }
  getSession(id: string): MobileSession | undefined { return structuredClone(this.committed.sessions.find(session => session.id === id)); }
  private enqueue(work: () => Promise<void>): Promise<void> {
    const next = this.writes.catch(() => {}).then(work);
    this.writes = next; return next;
  }
  load(): Promise<void> {
    // A temporary in-memory shell is never a replacement task partition.
    if (this.unavailableReason) return Promise.resolve();
    return this.enqueue(async () => {
      if (this.loaded) return;
      if (this.blocked) throw new MobileDataConflictError("移动端资料恢复尚未完成，请恢复备份后重新打开。");
      if (!await this.adapter.exists(this.statePath) && await this.adapter.exists(this.recoveryPath)) {
        parseV2(await this.adapter.read(this.recoveryPath), this.instanceId);
        await this.adapter.rename(this.recoveryPath, this.statePath);
      }
      const content = await readMobileFile(this.adapter as DataAdapter, this.statePath);
      if (content !== null) {
        this.committed = parseV2(content, this.instanceId); this.expected = content; this.loaded = true; return;
      }
      const legacyPath = `${this.directory}/state.json`;
      const legacy = await this.adapter.exists(legacyPath) ? await this.adapter.read(legacyPath) : null;
      const next = legacy === null ? this.committed : migrateV1(legacy, this.instanceId);
      if (legacy !== null) {
        await this.mkdir();
        const backup = `${this.directory}/devices/${this.instanceId}/legacy-v1-backup.json`;
        if (!await this.adapter.exists(backup)) await this.adapter.write(backup, legacy);
        if (await this.adapter.read(backup) !== legacy) throw new MobileDataConflictError("移动端旧资料备份回读不一致，已保留原文件。");
      }
      await this.commit(next); this.loaded = true;
    });
  }
  private async mkdir(): Promise<void> {
    let parent = "";
    for (const part of this.statePath.slice(0, this.statePath.lastIndexOf("/")).split("/")) {
      parent = parent ? `${parent}/${part}` : part;
      if (!await this.adapter.exists(parent)) await this.adapter.mkdir(parent);
    }
  }
  private async commit(next: MobileState): Promise<void> {
    if (this.unavailableReason) throw new Error(this.unavailableReason);
    const snapshot = JSON.stringify(next);
    const validated = parseV2(snapshot, this.instanceId);
    await this.mkdir();
    const conflict = () => new MobileDataConflictError("移动端资料已变化，请重新打开后再编辑；原资料已保留。");
    const current = await readMobileFile(this.adapter as DataAdapter, this.statePath);
    if (current !== this.expected) { const error = conflict(); this.disableWrites(error.message); throw error; }
    if (current !== null && await this.adapter.exists(this.recoveryPath)) await this.adapter.remove(this.recoveryPath);
    const verifiedAdapter = {
      exists: (path: string) => this.adapter.exists(path), read: (path: string) => this.adapter.read(path),
      write: (path: string, content: string) => this.adapter.write(path, content), remove: (path: string) => this.adapter.remove(path),
      rename: async (from: string, to: string) => {
        await this.adapter.rename(from, to);
        if (to !== this.statePath || from === this.recoveryPath) return;
        try {
          const installed = await this.adapter.read(to);
          if (installed !== snapshot) throw new MobileDataConflictError("移动端保存回读不一致，已保留原资料。");
          parseV2(installed, this.instanceId);
        } catch (error) {
          try {
            await this.adapter.rename(to, `${to}.failed-${newId()}.json`);
            if (await this.adapter.exists(this.recoveryPath)) await this.adapter.rename(this.recoveryPath, to);
          } catch (restoreError) {
            this.blocked = true;
            throw new AggregateError([error, restoreError], "移动端保存失败，原资料及恢复备份已保留，请恢复后重新打开。");
          }
          throw error;
        }
      }
    };
    try {
      await replaceMobileFile(verifiedAdapter as DataAdapter, this.statePath, snapshot, this.expected, this.recoveryPath, conflict);
    } catch (error) {
      try {
        if (await readMobileFile(this.adapter as DataAdapter, this.statePath) !== this.expected) {
          this.blocked = true;
          if (isMobileDataConflict(error)) this.disableWrites(error.message);
        }
      }
      catch { this.blocked = true; }
      throw error;
    }
    this.expected = snapshot; this.committed = validated;
    // A leftover recovery copy does not invalidate the verified commit.
    try { if (await this.adapter.exists(this.recoveryPath)) await this.adapter.remove(this.recoveryPath); } catch { /* Keep both intact. */ }
  }
  update(change: (draft: MobileState) => void): Promise<void> {
    return this.enqueue(async () => {
      if (this.unavailableReason) throw new Error(this.unavailableReason);
      if (!this.loaded || this.blocked) throw new Error("移动端本地资料尚未成功加载或恢复，未保存改动。");
      const draft = structuredClone(this.committed);
      const result: unknown = change(draft);
      if (result && typeof (result as PromiseLike<unknown>).then === "function") {
        void Promise.resolve(result).catch(() => {});
        throw new Error("移动端资料更新必须同步完成。");
      }
      draft.version = 2; draft.instanceId = this.instanceId; draft.revision = this.committed.revision + 1;
      if (draft.taskRuntimeVersion !== undefined && draft.taskRuntimeVersion !== 1 && draft.taskRuntimeVersion !== 2) throw dataError();
      const m4Fields = draft.sessions.some(task => task.operations !== undefined || task.interruption !== undefined || task.runs?.some(run => run.interruption !== undefined));
      if (m4Fields || (this.committed.taskRuntimeVersion === 2 && (draft.taskRuntimeVersion === undefined || draft.taskRuntimeVersion === 1))) draft.taskRuntimeVersion = 2;
      else if (draft.taskRuntimeVersion !== 2 && draft.sessions.some(task => task.queue !== undefined || task.queuePaused !== undefined || task.interaction !== undefined || task.contextSummary !== undefined)) draft.taskRuntimeVersion = 1;
      if (draft.taskRuntimeVersion !== undefined && this.committed.taskRuntimeVersion === undefined && this.expected !== null) {
        const created = !await this.adapter.exists(this.m2BackupPath);
        if (created) await this.adapter.write(this.m2BackupPath, this.expected);
        const backup = await this.adapter.read(this.m2BackupPath);
        if (created && backup !== this.expected) throw new MobileDataConflictError("移动端升级前备份回读不一致，原资料已保留。");
        const baseline = parseV2(backup, this.instanceId);
        if (baseline.taskRuntimeVersion !== undefined) throw new MobileDataConflictError("移动端升级前备份无效，原资料已保留。");
      }
      if (draft.taskRuntimeVersion === 2 && this.committed.taskRuntimeVersion !== 2 && this.expected !== null) {
        const created = !await this.adapter.exists(this.m3BackupPath);
        if (created) await this.adapter.write(this.m3BackupPath, this.expected);
        const backup = await this.adapter.read(this.m3BackupPath);
        if (created && backup !== this.expected) throw new MobileDataConflictError("移动端M3备份回读不一致，原资料已保留。");
        if (parseV2(backup, this.instanceId).taskRuntimeVersion === 2) throw new MobileDataConflictError("移动端M3备份版本无效，原资料已保留。");
      }
      await this.commit(draft);
    });
  }
  updateSession(id: string, change: (draft: MobileSession) => void): Promise<void> {
    return this.update(draft => {
      const session = draft.sessions.find(session => session.id === id);
      if (!session) throw new Error("会话不存在，未保存改动。");
      return change(session);
    });
  }
  patchSession(id: string, patch: Partial<Omit<MobileSession, "id">>): Promise<void> {
    const copied = structuredClone(patch);
    return this.updateSession(id, session => { Object.assign(session, copied, { id }); });
  }
  selectSession(id: string): Promise<void> {
    return this.update(draft => {
      if (!draft.sessions.some(session => session.id === id)) throw new Error("会话不存在，未切换。");
      draft.activeSessionId = id; draft.page = { kind: "detail", taskId: id };
    });
  }
  async createSession(agentId = "sol"): Promise<MobileSession> {
    const session = newSession(agentId);
    await this.update(draft => { draft.sessions.unshift(session); draft.activeSessionId = session.id; draft.page = { kind: "detail", taskId: session.id }; });
    return structuredClone(session);
  }
  async archiveAndCreateSession(id: string, at = Date.now()): Promise<MobileSession> {
    let created: MobileSession | undefined;
    await this.update(draft => {
      const session = draft.sessions.find(session => session.id === id);
      if (!session) throw new Error("会话不存在，未归档。");
      session.archivedAt = at;
      created = newSession(session.agentId); draft.sessions.unshift(created); draft.activeSessionId = created.id; draft.page = { kind: "detail", taskId: created.id };
    });
    return structuredClone(created!);
  }
  restoreSession(id: string): Promise<void> {
    return this.update(draft => {
      const session = draft.sessions.find(session => session.id === id);
      if (!session) throw new Error("会话不存在，未恢复。");
      delete session.archivedAt; draft.activeSessionId = id; draft.page = { kind: "detail", taskId: id };
    });
  }
  /** Caller must stop active runs first. Historical attribution and unsent drafts stay intact. */
  handoffAgentTasks(fromAgentId: string): Promise<void> {
    return this.update(draft => {
      if (!nonempty(fromAgentId) || fromAgentId === "sol") throw new Error("任务移交来源无效，总助任务不能移交。");
      for (const session of draft.sessions) if (session.agentId === fromAgentId) session.agentId = "sol";
      if (draft.page.kind === "list" && draft.page.agentId === fromAgentId) draft.page = { kind: "list", agentId: "sol" };
    });
  }
  setPermission(value: MobilePermission): Promise<void> { return this.update(draft => { draft.permission = value; }); }
  setMemoryEnabled(value: boolean): Promise<void> { return this.update(draft => { draft.memoryEnabled = value; }); }
  flush(): Promise<void> { return this.writes; }
  /** Compatibility barrier only; external snapshots are never written. */
  save(): Promise<void> { return this.flush(); }
}
import { validMobileFinanceEvidence } from "./finance-journal";
