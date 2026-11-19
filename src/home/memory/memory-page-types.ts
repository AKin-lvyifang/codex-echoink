import type { PersonalMemoryRecord, SecondaryMemoryRecord } from "../../harness/memory/personal-memory-contracts";
import type { MemoryActivityState, MemoryLayer } from "../../harness/memory/memory-relevance";
import type { UserProfileItem } from "../../harness/memory/user-profile-core";
import type { DreamCorrectionEvent } from "../../harness/memory/dream-correction-core";

export interface MemoryCorrectionView extends DreamCorrectionEvent {
  before?: PersonalMemoryRecord;
  after?: PersonalMemoryRecord;
  canUndo: boolean;
}

export type MemoryCategory = "facts" | "views" | "decisions" | "active" | "episodes";
export const MEMORY_CATEGORIES = [
  { id: "facts", zh: "事实", en: "Facts", kinds: ["fact"] },
  { id: "views", zh: "观点", en: "Views", kinds: ["view"] },
  { id: "decisions", zh: "决定", en: "Decisions", kinds: ["decision"] },
  { id: "active", zh: "进行中", en: "Active", kinds: ["goal", "task", "open_loop"] },
  { id: "episodes", zh: "经历", en: "Episodes", kinds: ["episode"] }
] as const;
export const MEMORY_LAYERS: readonly { id: MemoryLayer; zh: string; en: string }[] = [
  { id: "core", zh: "核心", en: "Core" }, { id: "frequent", zh: "常用", en: "Frequent" },
  { id: "peripheral", zh: "外围", en: "Peripheral" }, { id: "faded", zh: "淡出", en: "Faded" }
];
export interface MemorySource { text: string; conversationId?: string; entryId?: string }
export interface MemoryStar extends PersonalMemoryRecord {
  category: MemoryCategory;
  layer: MemoryLayer;
  activity: number;
  lastRecalledAt?: number;
  recallCount: number;
  sourceView: MemorySource;
  history: readonly PersonalMemoryRecord[];
  profiles: readonly UserProfileItem[];
  clues: readonly SecondaryMemoryRecord[];
}
export interface MemoryReceipt { conversationId: string; messageId?: string; question?: string; selectedId?: string; sources: readonly { id: string; title: string; reason?: string; relatedFrom?: { id: string; title: string } }[] }
export interface MemoryPageSnapshot {
  corrections?: readonly MemoryCorrectionView[];
  revision: number;
  now: number;
  enabled: boolean;
  stars: readonly MemoryStar[];
  profile: readonly UserProfileItem[];
  activityState: MemoryActivityState;
  preview?: { query: string; reasons?: Readonly<Record<string, string | undefined>>; relatedFrom?: Readonly<Record<string, { id: string; title: string } | undefined>>; recalled: readonly string[]; faded: readonly string[] };
  receipt?: MemoryReceipt;
}
export interface MemoryPageRequest { query?: string; receipt?: MemoryReceipt; now?: number }
/** The view consumes one query and user-control commands; no repository escapes. */
export interface MemoryPagePort {
  undoCorrection?(eventId: string): Promise<string>;
  originalQuote?(source: string): Promise<string>;
  query(request: MemoryPageRequest): Promise<MemoryPageSnapshot>;
  pin(id: string, pinned: boolean, revision: number): Promise<void>;
  restore(id: string): Promise<void>;
  correct(id: string, title: string, content: string, revision: number): Promise<string>;
  forget(id: string, revision: number): Promise<void>;
  undoForget(id: string, revision: number): Promise<void>;
  saveProfile(key: string, text: string, revision: number): Promise<void>;
  deleteProfile(key: string, revision: number): Promise<void>;
  source(source: MemorySource): Promise<void>;
  back(): Promise<void>;
}
