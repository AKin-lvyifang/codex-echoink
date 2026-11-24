import { isPersonalMemoryKind, type PersonalMemoryRecord } from "../harness/memory/personal-memory-contracts";
import { PersonalMemoryAccessError } from "../harness/memory/personal-memory-error";
import type { DreamCorrectionEvent } from "../harness/memory/dream-correction-core";
import type { UserProfileItem, UserProfileSlotDefinition } from "../harness/memory/user-profile-state";
import type { MobileSession } from "./store";

export interface MobileMemorySettingsSnapshot {
  memoryEnabled: boolean; dreamEnabled: boolean; dreamRunsPerDay: number; autoArchive: boolean; version: string;
}
export interface MobileForgottenMemory { id: string; title: string; forgottenAt: number; reason: string }
export interface MobileMemoryCorrectionEvent extends DreamCorrectionEvent { before?: PersonalMemoryRecord; after?: PersonalMemoryRecord; canUndo: boolean }
export interface MobileMemoryListSnapshot { corrections?: readonly MobileMemoryCorrectionEvent[]; revision: number; records: PersonalMemoryRecord[]; forgotten: MobileForgottenMemory[] }
export interface MobileMemorySnapshot { corrections?: readonly MobileMemoryCorrectionEvent[]; revision: number; record: PersonalMemoryRecord }
export interface MobileMemoryCorrection { title: string; content: string; recallWhen: string }
export interface MobileMemoryCorrectionPreview extends MobileMemoryCorrection { id: string; revision: number; original: PersonalMemoryRecord }
export interface MobileProfileSource { profileKey: string; id: string; title: string; content: string; basis: string; available: boolean }
export interface MobileUserProfileSnapshot { revision: number; slots: readonly UserProfileSlotDefinition[]; items: UserProfileItem[]; sources: MobileProfileSource[] }
export interface MobileDreamStatus {
  phase: "idle" | "running" | "completed" | "interrupted" | "failed";
  attemptsToday: number; dailyLimit: number; dayKey: string; startedAt: number | null; finishedAt: number | null; error: string;
}
export interface MobileArchiveItem { id: string; agentId: string; title: string; updatedAt: number; archivedAt: number; messageCount: number }
/** Both device pages consume data only. Local management never needs a Provider. */
export interface MobileMemorySettingsPort {
  corrections(): Promise<readonly MobileMemoryCorrectionEvent[]>;
  originalQuote(source: string): Promise<import('../harness/memory/memory-quote-core').MemoryQuoteResult>;
  undoCorrection(id: string): Promise<string>;
  readSettings(): MobileMemorySettingsSnapshot;
  saveSettings(draft: MobileMemorySettingsSnapshot): Promise<MobileMemorySettingsSnapshot>;
  list(query?: string): Promise<MobileMemoryListSnapshot>;
  read(id: string): Promise<MobileMemorySnapshot>;
  previewCorrection(id: string, draft: MobileMemoryCorrection, revision: number): Promise<MobileMemoryCorrectionPreview>;
  applyCorrection(preview: MobileMemoryCorrectionPreview): Promise<MobileMemorySnapshot>;
  forget(id: string, reason: string, revision: number): Promise<MobileMemoryListSnapshot>;
  restore(id: string, revision: number): Promise<MobileMemorySnapshot>;
  export(): Promise<{ path: string; revision: number }>;
  readProfile(): Promise<MobileUserProfileSnapshot>;
  saveProfile(profileKey: string, text: string, revision: number): Promise<MobileUserProfileSnapshot>;
  confirmProfile(profileKey: string, revision: number): Promise<MobileUserProfileSnapshot>;
  deleteProfile(profileKey: string, revision: number): Promise<MobileUserProfileSnapshot>;
  dreamStatus(): MobileDreamStatus;
  runDream(signal?: AbortSignal): Promise<MobileDreamStatus>;
  cancelDream(): Promise<void>;
  subscribe(listener: () => void): () => void;
  listArchives(): Promise<MobileArchiveItem[]>;
  readArchive(id: string): Promise<MobileSession>;
  restoreArchive(id: string): Promise<void>;
}

export function validateMobileMemoryWriteEnums(kind: unknown, basis: unknown): void {
  if (!isPersonalMemoryKind(kind) || (basis !== "explicit" && basis !== "observed")) {
    throw new PersonalMemoryAccessError("invalid_request", "新增或修正记忆需要有效的类型、标题、正文、触发场景和依据。");
  }
}
