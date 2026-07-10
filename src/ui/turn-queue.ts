import type { TurnOptions } from "../core/codex-service";
import type { EchoInkResource } from "../resources/types";
import type { StoredAttachment } from "../settings/settings";

export type QueuedTurnKind = "chat" | "knowledge-base";
export type QueueSettlement = "continue" | "paused" | "idle";

export interface QueuedTurnItem {
  id: string;
  sessionId: string;
  text: string;
  attachments: StoredAttachment[];
  skill: EchoInkResource | null;
  turnOptions: TurnOptions;
  kind: QueuedTurnKind;
  createdAt: number;
}

export interface QueueStartState {
  queueStartInProgress: boolean;
  viewRunning: boolean;
  knowledgeTaskRunning: boolean;
}

interface SessionTurnQueue {
  paused: boolean;
  items: QueuedTurnItem[];
}

export function canStartQueuedTurn(state: QueueStartState): boolean {
  return !state.queueStartInProgress && !state.viewRunning && !state.knowledgeTaskRunning;
}

export class RuntimeTurnQueue {
  private readonly sessions = new Map<string, SessionTurnQueue>();

  enqueue(item: QueuedTurnItem): QueuedTurnItem {
    const queue = this.ensureSessionQueue(item.sessionId);
    const snapshot = cloneQueuedTurnItem(item);
    queue.items.push(snapshot);
    return cloneQueuedTurnItem(snapshot);
  }

  dequeueNext(sessionId: string): QueuedTurnItem | null {
    const queue = this.sessions.get(sessionId);
    if (!queue || queue.paused) return null;
    const item = queue.items.shift();
    this.cleanupEmptySession(sessionId);
    return item ? cloneQueuedTurnItem(item) : null;
  }

  itemsForSession(sessionId: string): QueuedTurnItem[] {
    return (this.sessions.get(sessionId)?.items ?? []).map(cloneQueuedTurnItem);
  }

  hasQueuedItems(sessionId: string): boolean {
    return Boolean(this.sessions.get(sessionId)?.items.length);
  }

  removeQueuedItem(sessionId: string, itemId: string): boolean {
    const queue = this.sessions.get(sessionId);
    if (!queue) return false;
    const index = queue.items.findIndex((item) => item.id === itemId);
    if (index < 0) return false;
    queue.items.splice(index, 1);
    this.cleanupEmptySession(sessionId);
    return true;
  }

  reorderQueuedItem(sessionId: string, itemId: string, targetIndex: number): boolean {
    const queue = this.sessions.get(sessionId);
    if (!queue) return false;
    const currentIndex = queue.items.findIndex((item) => item.id === itemId);
    if (currentIndex < 0) return false;
    const [item] = queue.items.splice(currentIndex, 1);
    const nextIndex = clampIndex(targetIndex, queue.items.length);
    queue.items.splice(nextIndex, 0, item);
    return true;
  }

  pauseSessionQueue(sessionId: string): void {
    this.ensureSessionQueue(sessionId).paused = true;
  }

  resumeSessionQueue(sessionId: string): void {
    const queue = this.sessions.get(sessionId);
    if (queue) queue.paused = false;
  }

  settleSessionQueue(sessionId: string, succeeded: boolean): QueueSettlement {
    if (succeeded) return this.hasQueuedItems(sessionId) ? "continue" : "idle";
    if (!this.hasQueuedItems(sessionId)) return "idle";
    this.pauseSessionQueue(sessionId);
    return "paused";
  }

  isSessionQueuePaused(sessionId: string): boolean {
    return Boolean(this.sessions.get(sessionId)?.paused);
  }

  clearSessionQueue(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  private ensureSessionQueue(sessionId: string): SessionTurnQueue {
    let queue = this.sessions.get(sessionId);
    if (!queue) {
      queue = { paused: false, items: [] };
      this.sessions.set(sessionId, queue);
    }
    return queue;
  }

  private cleanupEmptySession(sessionId: string): void {
    const queue = this.sessions.get(sessionId);
    if (queue && queue.items.length === 0) this.sessions.delete(sessionId);
  }
}

function clampIndex(index: number, maxInclusive: number): number {
  if (!Number.isFinite(index)) return maxInclusive;
  return Math.max(0, Math.min(Math.trunc(index), maxInclusive));
}

function cloneQueuedTurnItem(item: QueuedTurnItem): QueuedTurnItem {
  return {
    ...item,
    attachments: item.attachments.map((attachment) => ({ ...attachment })),
    skill: item.skill ? { ...item.skill } : null,
    turnOptions: cloneTurnOptions(item.turnOptions)
  };
}

function cloneTurnOptions(options: TurnOptions): TurnOptions {
  return {
    ...options,
    writableRoots: options.writableRoots ? [...options.writableRoots] : undefined,
    workspaceResources: options.workspaceResources
      ? {
        plugins: { ...options.workspaceResources.plugins },
        mcpServers: { ...options.workspaceResources.mcpServers },
        skills: { ...options.workspaceResources.skills }
      }
      : undefined
  };
}
