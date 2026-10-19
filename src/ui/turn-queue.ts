import type { TurnOptions } from "./turn-options";
import type { EchoInkResource } from "../resources/types";
import type { StoredAttachment } from "../settings/settings";
import type { NoteMentionSnapshot } from "./codex-view/note-mentions";
import type { PiChatPreparedDocument } from "../harness/pi-native/contracts";

export type QueuedTurnKind = "chat";
export type QueueSettlement = "continue" | "paused" | "idle";

import { cloneSelectionAnnotations, type SelectionAnnotation } from "../types/selection-annotations";

export interface QueuedTurnItem {
  resumeContext?: import("../agents/task-resume").TaskResumeContext;
  id: string;
  sessionId: string;
  text: string;
  composerTextSnapshot?: string;
  /** Local workbench intent, carried to the Catalog only after Pi accepts the turn. */
  prefillSource?: string;
  /** Exact source chosen locally; the original is never a Composer attachment. */
  englishDiarySourcePath?: string;
  attachments: StoredAttachment[];
  /** Document bytes/text/transport frozen before this turn enters the queue. */
  preparedDocuments?: readonly Readonly<PiChatPreparedDocument>[];
  /** Whole-note bodies frozen when the Composer draft is sent or queued. */
  noteMentions?: readonly Readonly<NoteMentionSnapshot>[];
  selectionAnnotations?: readonly SelectionAnnotation[];
  skill: EchoInkResource | null;
  turnOptions: TurnOptions;
  kind: QueuedTurnKind;
  createdAt: number;
  /** Catalog draft selected by the user; consumed only after Pi durably accepts it. */
  piDraftId?: string;
  /** In-memory queue lease marker; never persisted as Conversation content. */
  piUserEntryAccepted?: boolean;
  /** Clear this exact Composer snapshot only after Pi durably accepts it. */
  clearComposerAfterPiAcceptance?: boolean;
}

export interface QueueStartState {
  queueStartInProgress: boolean;
  viewRunning: boolean;
  knowledgeTaskRunning: boolean;
}

interface SessionTurnQueue {
  paused: boolean;
  recoveryRequired: boolean;
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

  enqueueFront(item: QueuedTurnItem): QueuedTurnItem {
    const queue = this.ensureSessionQueue(item.sessionId);
    const snapshot = cloneQueuedTurnItem(item);
    queue.items.unshift(snapshot);
    return cloneQueuedTurnItem(snapshot);
  }

  dequeueNext(sessionId: string): QueuedTurnItem | null {
    return this.consumeNext(sessionId);
  }

  consumeNext(sessionId: string, expectedItemId?: string): QueuedTurnItem | null {
    const queue = this.sessions.get(sessionId);
    if (!queue || queue.paused || queue.recoveryRequired) return null;
    if (expectedItemId && queue.items[0]?.id !== expectedItemId) return null;
    const item = queue.items.shift();
    this.cleanupEmptySession(sessionId);
    return item ? cloneQueuedTurnItem(item) : null;
  }

  acceptPiUserEntry(sessionId: string, itemId: string): boolean {
    const queue = this.sessions.get(sessionId);
    if (!queue) return false;
    const index = queue.items.findIndex((item) => item.id === itemId);
    if (index < 0) return false;
    queue.items[index].piUserEntryAccepted = true;
    queue.items.splice(index, 1);
    this.cleanupEmptySession(sessionId);
    return true;
  }

  peekNext(sessionId: string): QueuedTurnItem | null {
    const queue = this.sessions.get(sessionId);
    if (!queue || queue.paused || queue.recoveryRequired) return null;
    const item = queue.items[0];
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
    const queue = this.sessions.get(sessionId);
    if (queue?.items.length) queue.paused = true;
  }

  resumeSessionQueue(sessionId: string): void {
    const queue = this.sessions.get(sessionId);
    if (queue && !queue.recoveryRequired) queue.paused = false;
  }

  settleSessionQueue(sessionId: string, succeeded: boolean): QueueSettlement {
    if (this.isSessionRecoveryRequired(sessionId)) return "paused";
    if (succeeded) return this.hasQueuedItems(sessionId) ? "continue" : "idle";
    if (!this.hasQueuedItems(sessionId)) return "idle";
    this.pauseSessionQueue(sessionId);
    return "paused";
  }

  isSessionQueuePaused(sessionId: string): boolean {
    return Boolean(this.sessions.get(sessionId)?.paused);
  }

  requireSessionRecovery(sessionId: string): void {
    this.ensureSessionQueue(sessionId).recoveryRequired = true;
  }

  clearSessionRecoveryRequired(sessionId: string): void {
    const queue = this.sessions.get(sessionId);
    if (!queue) return;
    queue.recoveryRequired = false;
    this.cleanupEmptySession(sessionId);
  }

  isSessionRecoveryRequired(sessionId: string): boolean {
    return Boolean(this.sessions.get(sessionId)?.recoveryRequired);
  }

  clearSessionQueue(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  private ensureSessionQueue(sessionId: string): SessionTurnQueue {
    let queue = this.sessions.get(sessionId);
    if (!queue) {
      queue = { paused: false, recoveryRequired: false, items: [] };
      this.sessions.set(sessionId, queue);
    }
    return queue;
  }

  private cleanupEmptySession(sessionId: string): void {
    const queue = this.sessions.get(sessionId);
    if (
      queue
      && queue.items.length === 0
      && !queue.paused
      && !queue.recoveryRequired
    ) {
      this.sessions.delete(sessionId);
    }
  }
}

function clampIndex(index: number, maxInclusive: number): number {
  if (!Number.isFinite(index)) return maxInclusive;
  return Math.max(0, Math.min(Math.trunc(index), maxInclusive));
}

export function cloneQueuedTurnItem(item: QueuedTurnItem): QueuedTurnItem {
  return {
    ...item,
    ...(item.resumeContext ? { resumeContext: structuredClone(item.resumeContext) } : {}),
    attachments: item.attachments.map((attachment) => ({ ...attachment })),
    ...(item.preparedDocuments
      ? {
          preparedDocuments: item.preparedDocuments.map((document) => ({
            ...document,
            bytes: new Uint8Array(document.bytes),
            attachment: { ...document.attachment }
          }))
        }
      : {}),
    ...(item.selectionAnnotations ? { selectionAnnotations: cloneSelectionAnnotations(item.selectionAnnotations) } : {}),
    ...(item.noteMentions
      ? { noteMentions: item.noteMentions.map((mention) => ({ ...mention })) }
      : {}),
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
