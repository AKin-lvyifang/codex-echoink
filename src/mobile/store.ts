import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { DataAdapter } from "obsidian";
import type { ConversationTaskMetadata, ConversationTaskStatus } from "../agents/task-metadata";
import type { TaskDraft, TaskPage } from "../agents/task-workspace";
import type { AgentRunSnapshot } from "../agents/types";
import type { PersonalMemoryRecord } from "../harness/memory/personal-memory-contracts";
import { readMobileFile, replaceMobileFile } from "./replace-file";
import { assertMobileTaskInstanceId } from "./task-identity";

export type MobilePermission = "read-only" | "workspace-write" | "full-access";
/** Stored attribution only. M2 never starts or resumes a run. */
export interface MobileTaskRun {
  id: string;
  startedAt: number;
  agentSnapshot?: AgentRunSnapshot;
  status?: ConversationTaskStatus;
  completedAt?: number;
  interruptedAt?: number;
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
}
export interface MobileState {
  version: 2;
  instanceId: string;
  revision: number;
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

const dataError = () => new Error("移动端本地数据格式无法读取，已保留原文件。");
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const nonempty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const time = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const permission = (value: unknown): value is MobilePermission => ["read-only", "workspace-write", "full-access"].includes(value as string);
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
  return time(value.startedAt) && (value.status === undefined || ["running", "waiting", "completed", "interrupted"].includes(value.status as string))
    && ["completedAt", "interruptedAt"].every(key => value[key] === undefined || time(value[key]))
    && (snapshot === undefined || (object(snapshot) && nonempty(snapshot.agentId) && typeof snapshot.name === "string" && typeof snapshot.position === "string"
      && ["execution", "analysis", "companion", "creative"].includes(snapshot.styleId as string)
      && ["capabilityIds", "disabledCapabilityIds"].every(key => snapshot[key] === undefined || (Array.isArray(snapshot[key]) && snapshot[key].every(value => typeof value === "string")))));
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
  const value: unknown = JSON.parse(content);
  validateBase(value);
  if (value.version !== 2 || value.instanceId !== instanceId || !Number.isSafeInteger(value.revision) || (value.revision as number) < 0
    || !value.sessions.length || !value.sessions.some(session => session.id === value.activeSessionId)
    || !object(value.page) || !object(value.newTaskDrafts) || !Object.values(value.newTaskDrafts).every(draft => validDraft(draft))) throw dataError();
  const page = value.page;
  if (!(page.kind === "list" && nonempty(page.agentId)) && !(page.kind === "detail" && nonempty(page.taskId)
    && value.sessions.some(session => session.id === page.taskId))) throw dataError();
  const runIds = new Set<string>();
  for (const session of value.sessions) {
    if (!nonempty(session.agentId) || !validMetadata(session) || (session.draftContext !== undefined && !validDraft(session.draftContext, true))) throw dataError();
    if (session.runs !== undefined) {
      if (!uniqueRecords(session.runs)) throw dataError();
      for (const run of session.runs) {
        if (!validRun(run) || runIds.has(run.id as string)) throw dataError();
        runIds.add(run.id as string);
      }
    }
  }
  return value as unknown as MobileState;
}
function migrateV1(content: string, instanceId: string): MobileState {
  const value: unknown = JSON.parse(content);
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
  private committed: MobileState;
  private writes: Promise<void> = Promise.resolve();
  private loaded = false;
  private blocked = false;
  private expected: string | null = null;
  readonly statePath: string;
  constructor(private adapter: MobileStorageAdapter, private directory: string, readonly instanceId: string) {
    assertMobileTaskInstanceId(instanceId);
    this.statePath = `${directory}/devices/${instanceId}/state.json`;
    const session = newSession();
    this.committed = { version: 2, instanceId, revision: 0, activeSessionId: session.id, sessions: [session], memoryEnabled: true,
      memories: [], permission: "workspace-write", page: { kind: "detail", taskId: session.id }, newTaskDrafts: {} };
  }
  private get recoveryPath(): string { return `${this.statePath}.task-replace-backup.json`; }
  get state(): MobileState { return structuredClone(this.committed); }
  get session(): MobileSession { return structuredClone(this.committed.sessions.find(session => session.id === this.committed.activeSessionId)!); }
  getSession(id: string): MobileSession | undefined { return structuredClone(this.committed.sessions.find(session => session.id === id)); }
  private enqueue(work: () => Promise<void>): Promise<void> {
    const next = this.writes.catch(() => {}).then(work);
    this.writes = next; return next;
  }
  load(): Promise<void> {
    return this.enqueue(async () => {
      if (this.loaded) return;
      if (this.blocked) throw new Error("移动端资料恢复尚未完成，请恢复备份后重新打开。");
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
        if (await this.adapter.read(backup) !== legacy) throw new Error("移动端旧资料备份回读不一致，已保留原文件。");
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
    const snapshot = JSON.stringify(next);
    const validated = parseV2(snapshot, this.instanceId);
    await this.mkdir();
    const conflict = () => new Error("移动端资料已变化，请重新打开后再编辑；原资料已保留。");
    const current = await readMobileFile(this.adapter as DataAdapter, this.statePath);
    if (current !== this.expected) { this.blocked = true; throw conflict(); }
    if (current !== null && await this.adapter.exists(this.recoveryPath)) await this.adapter.remove(this.recoveryPath);
    const verifiedAdapter = {
      exists: (path: string) => this.adapter.exists(path), read: (path: string) => this.adapter.read(path),
      write: (path: string, content: string) => this.adapter.write(path, content), remove: (path: string) => this.adapter.remove(path),
      rename: async (from: string, to: string) => {
        await this.adapter.rename(from, to);
        if (to !== this.statePath || from === this.recoveryPath) return;
        try {
          const installed = await this.adapter.read(to);
          if (installed !== snapshot) throw new Error("移动端保存回读不一致，已保留原资料。");
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
      try { if (await readMobileFile(this.adapter as DataAdapter, this.statePath) !== this.expected) this.blocked = true; }
      catch { this.blocked = true; }
      throw error;
    }
    this.expected = snapshot; this.committed = validated;
    // A leftover recovery copy does not invalidate the verified commit.
    try { if (await this.adapter.exists(this.recoveryPath)) await this.adapter.remove(this.recoveryPath); } catch { /* Keep both intact. */ }
  }
  update(change: (draft: MobileState) => void): Promise<void> {
    return this.enqueue(async () => {
      if (!this.loaded || this.blocked) throw new Error("移动端本地资料尚未成功加载或恢复，未保存改动。");
      const draft = structuredClone(this.committed);
      const result: unknown = change(draft);
      if (result && typeof (result as PromiseLike<unknown>).then === "function") {
        void Promise.resolve(result).catch(() => {});
        throw new Error("移动端资料更新必须同步完成。");
      }
      draft.version = 2; draft.instanceId = this.instanceId; draft.revision = this.committed.revision + 1;
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
