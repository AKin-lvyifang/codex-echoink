import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { DataAdapter } from "obsidian";
import type { PersonalMemoryRecord } from "../harness/memory/personal-memory-contracts";

export type MobilePermission = "read-only" | "workspace-write" | "full-access";
export interface MobileSession {
  id: string;
  title: string;
  updatedAt: number;
  messages: AgentMessage[];
  draft: string;
  notePath: string;
  tools: Record<string, { startedAt: number; elapsedMs?: number }>;
}
export interface MobileState {
  version: 1;
  activeSessionId: string;
  sessions: MobileSession[];
  memoryEnabled: boolean;
  memories: PersonalMemoryRecord[];
  permission: MobilePermission;
}
export const newId = () => globalThis.crypto.randomUUID();
export function newSession(): MobileSession {
  return { id: newId(), title: "新对话", updatedAt: Date.now(), messages: [], draft: "", notePath: "", tools: {} };
}

/** One writer per plugin instance. Snapshots are captured before queuing. */
export class MobileStore {
  state: MobileState;
  private writes: Promise<void> = Promise.resolve();
  constructor(private adapter: Pick<DataAdapter, "exists" | "read" | "write" | "mkdir">, private directory: string) {
    const session = newSession();
    this.state = { version: 1, activeSessionId: session.id, sessions: [session], memoryEnabled: true, memories: [], permission: "workspace-write" };
  }
  async load(): Promise<void> {
    if (!await this.adapter.exists(this.directory)) await this.adapter.mkdir(this.directory);
    const path = `${this.directory}/state.json`;
    if (!await this.adapter.exists(path)) return;
    const stored = JSON.parse(await this.adapter.read(path)) as MobileState;
    if (stored.version !== 1 || !Array.isArray(stored.sessions) || !Array.isArray(stored.memories)) {
      throw new Error("移动端本地数据格式无法读取，已保留原文件。");
    }
    this.state = stored;
    if (!stored.sessions.length) stored.sessions.push(newSession());
    if (!stored.sessions.some(s => s.id === stored.activeSessionId)) stored.activeSessionId = stored.sessions[0].id;
  }
  get session(): MobileSession {
    return this.state.sessions.find(s => s.id === this.state.activeSessionId)!;
  }
  save(): Promise<void> {
    const snapshot = JSON.stringify(this.state);
    const write = this.writes.catch(() => {}).then(() => this.adapter.write(`${this.directory}/state.json`, snapshot));
    this.writes = write;
    return write;
  }
  async createSession(): Promise<MobileSession> {
    const session = newSession();
    this.state.sessions.unshift(session);
    this.state.activeSessionId = session.id;
    await this.save();
    return session;
  }
}
