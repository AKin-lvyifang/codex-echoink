import type { PersonalMemoryRecord } from "./personal-memory-contracts";

export type DreamCorrectionConclusion = "confirmed" | "correct" | "obsolete" | "uncertain";
export type DreamCorrectionStatus = "waiting_source" | "judged" | "pending_write" | "written" | "conflict" | "skipped" | "user_undone";
export interface DreamCorrectionCheck {
  readonly key: string;
  readonly phase: "original" | "change";
  readonly memoryId: string;
  readonly memoryRevision: number;
  readonly source: string;
  readonly fingerprint?: string;
  readonly conclusion?: DreamCorrectionConclusion;
  readonly status: DreamCorrectionStatus;
  readonly reason?: string;
  readonly at: number;
}
export interface DreamCorrectionExperience {
  readonly catalogCount?: number;
  readonly sentIds?: readonly string[];
  readonly prefilterReason?: string;
  readonly fingerprint: string;
  readonly source?: string;
  readonly candidates: readonly Readonly<{ id: string; revision: number }>[];
  readonly completed: boolean;
  readonly reason?: string;
}
export interface DreamCorrectionEvent {
  readonly confirmedByUser?: boolean;
  readonly profileBackup?: string;
  readonly id: string;
  readonly checkKey: string;
  readonly phase: "original" | "change";
  readonly source: string;
  readonly beforeId: string;
  readonly afterId?: string;
  readonly beforeRevision: number;
  readonly afterRevision?: number;
  readonly action: "correct" | "obsolete";
  readonly at: number;
  readonly undoneAt?: number;
}
export interface DreamCorrectionCall {
  readonly id: string;
  readonly runId: string;
  readonly step: string;
  readonly inputTokens: number;
  readonly outputReserve: number;
  readonly outputTokens: number;
  readonly tokenSource: "server" | "estimated";
  readonly status: "started" | "completed" | "failed";
  readonly usageRequestId?: string;
}
export interface DreamCorrectionDiagnostic {
  readonly runId: string;
  readonly checkedExperiences: number;
  readonly checkedMemories: number;
  readonly confirmed: number;
  readonly corrected: number;
  readonly obsolete: number;
  readonly uncertain: number;
  readonly skipped: number;
  readonly reasons: Readonly<Record<string, number>>;
  readonly modelCalls: number;
}
export interface DreamCorrectionState {
  readonly checks: readonly DreamCorrectionCheck[];
  readonly experiences: readonly DreamCorrectionExperience[];
  readonly events: readonly DreamCorrectionEvent[];
  readonly calls: readonly DreamCorrectionCall[];
  readonly diagnostic?: DreamCorrectionDiagnostic;
}
export const emptyDreamCorrectionState = (): DreamCorrectionState => ({ checks: [], experiences: [], events: [], calls: [] });
export function correctionCheckKey(phase: "original" | "change", record: Pick<PersonalMemoryRecord, "id" | "revision">, source: string, fingerprint?: string): string {
  return JSON.stringify([phase, record.id, record.revision, source, fingerprint ?? null]);
}
export function correctionCheckComplete(check: DreamCorrectionCheck | undefined): boolean {
  return !!check && ["written", "skipped", "user_undone"].includes(check.status);
}
export function mergeCorrectionState(current: DreamCorrectionState, patch: Partial<DreamCorrectionState>): DreamCorrectionState {
  const merge = <T>(before: readonly T[], after: readonly T[] | undefined, key: (item: T) => string): T[] =>
    [...new Map([...before, ...(after ?? [])].map(item => [key(item), item])).values()];
  return { checks: merge(current.checks, patch.checks, item => item.key), experiences: merge(current.experiences, patch.experiences, item => item.fingerprint),
    events: merge(current.events, patch.events, item => item.id),
    calls: merge(current.calls, patch.calls, item => item.id), ...(patch.diagnostic ?? current.diagnostic ? { diagnostic: patch.diagnostic ?? current.diagnostic } : {}) };
}
/** Missing fields are legacy defaults; malformed new data must never erase undo history. */
export function parseDreamCorrectionState(value: unknown): DreamCorrectionState | null {
  if (value === undefined) return emptyDreamCorrectionState();
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as DreamCorrectionState;
  const text = (v: unknown): v is string => typeof v === "string" && v.length > 0;
  const number = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
  const revision = (v: unknown) => number(v) && Number.isSafeInteger(v) && v > 0;
  if (![raw.checks, raw.experiences, raw.events, raw.calls].every(Array.isArray)) return null;
  if (raw.checks.some(c => !c || !text(c.key) || !["original", "change"].includes(c.phase) || !text(c.memoryId) || !revision(c.memoryRevision)
    || typeof c.source !== "string" || !number(c.at) || !["waiting_source", "judged", "pending_write", "written", "conflict", "skipped", "user_undone"].includes(c.status)
    || (c.conclusion !== undefined && !["confirmed", "correct", "obsolete", "uncertain"].includes(c.conclusion)))) return null;
  if (raw.experiences.some(e => !e || !text(e.fingerprint) || !Array.isArray(e.candidates) || typeof e.completed !== "boolean"
    || (e.candidates as readonly unknown[]).some(c => !c || typeof c !== "object" || !text((c as Record<string, unknown>).id) || !revision((c as Record<string, unknown>).revision)))) return null;
  if (raw.events.some(e => !e || !text(e.id) || !text(e.checkKey) || !text(e.source) || !text(e.beforeId) || !revision(e.beforeRevision)
    || !["original", "change"].includes(e.phase) || !["correct", "obsolete"].includes(e.action) || !number(e.at)
    || (e.action === "correct" && (!text(e.afterId) || !revision(e.afterRevision))) || (e.undoneAt !== undefined && !number(e.undoneAt)))) return null;
  if (raw.calls.some(c => !c || !text(c.id) || !text(c.runId) || !text(c.step) || ![c.inputTokens, c.outputReserve, c.outputTokens].every(number)
    || !["server", "estimated"].includes(c.tokenSource) || !["started", "completed", "failed"].includes(c.status))) return null;
  if (raw.diagnostic && (![raw.diagnostic.checkedExperiences, raw.diagnostic.checkedMemories, raw.diagnostic.confirmed, raw.diagnostic.corrected,
    raw.diagnostic.obsolete, raw.diagnostic.uncertain, raw.diagnostic.skipped, raw.diagnostic.modelCalls].every(number)
    || !text(raw.diagnostic.runId) || !raw.diagnostic.reasons || Object.values(raw.diagnostic.reasons).some(n => !number(n)))) return null;
  // Legacy pinned suggestions are retired; ignore even malformed payloads.
  return { checks: raw.checks, experiences: raw.experiences, events: raw.events, calls: raw.calls,
    ...(raw.diagnostic ? { diagnostic: raw.diagnostic } : {}) };
}
export interface DreamCorrectionMutation {
  readonly check: DreamCorrectionCheck;
  readonly action: "correct" | "obsolete";
  readonly title?: string;
  readonly content?: string;
  readonly recallWhen?: string;
  readonly fields?: Readonly<Pick<PersonalMemoryRecord, "scope" | "asOf" | "due" | "remindAt">>;
  readonly derived?: Readonly<{
    facts: readonly import("./secondary-memory-store").SecondaryFactCandidate[];
    profileItems: readonly Readonly<{ section: import("./user-profile-state").UserProfileSection; profileKey: import("./user-profile-state").DreamProfileInput["items"][number]["profileKey"]; text: string }>[];
  }>;
}
export interface DreamCorrectionBatch {
  readonly expectedMemoryRevision: number;
  readonly mutations: readonly DreamCorrectionMutation[];
  readonly patch: Partial<DreamCorrectionState>;
  readonly inboxChange?: Readonly<{ relativePath: string; content: string }>;
}
export function canUndoDreamCorrection(event: DreamCorrectionEvent, records: readonly PersonalMemoryRecord[]): boolean {
  if (event.undoneAt !== undefined) return false;
  const before = records.find(r => r.id === event.beforeId);
  if (!before || before.revision !== event.beforeRevision) return false;
  if (event.action === "obsolete") return before.status === "closed" && !records.some(r => r.supersedes === before.id && (r.status === "current" || r.revision > event.beforeRevision));
  const after = records.find(r => r.id === event.afterId);
  return before.status === "superseded" && after?.status === "current" && after.revision === event.afterRevision
    && after.supersedes === before.id && !records.some(r => r.supersedes === after.id);
}
