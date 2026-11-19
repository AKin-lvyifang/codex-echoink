export const ECHOINK_REASONING_SUMMARY_SCHEMA_VERSION = 1 as const;
export const ECHOINK_REASONING_SUMMARY_ENTRY_TYPE =
  "echoink.reasoning-summary.v1" as const;

export const ECHOINK_REASONING_SUMMARY_STATUSES = [
  "running",
  "completed",
  "failed",
  "interrupted",
  "cancelled"
] as const;

export type EchoInkReasoningSummaryStatus =
  typeof ECHOINK_REASONING_SUMMARY_STATUSES[number];

export type EchoInkReasoningActivityKind =
  | "provider"
  | "judgment"
  | "knowledge"
  | "memory"
  | "task"
  | "tool";

export type EchoInkReasoningActivityStatus =
  | "active"
  | "completed"
  | "failed"
  | "interrupted"
  | "cancelled";

export type EchoInkReasoningActivityStage =
  | "requesting"
  | "searching"
  | "selecting_knowledge"
  | "continuing_search"
  | "reading_knowledge"
  | "comparing_memory"
  | "checking_conflicts_freshness"
  | "refining_knowledge"
  | "writing_and_readback"
  | "loading"
  | "catalog"
  | "matching"
  | "budgeting"
  | "assembling"
  | "pending"
  | "in_progress"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";

export interface EchoInkReasoningActivity {
  readonly id: string;
  readonly kind: EchoInkReasoningActivityKind;
  readonly status: EchoInkReasoningActivityStatus;
  readonly startedAt: number;
  readonly updatedAt: number;
  readonly stage?: EchoInkReasoningActivityStage;
  /** Registered Tool name only; never arguments, results, or model prose. */
  readonly name?: string;
  readonly current?: number;
  readonly total?: number;
  readonly completed?: number;
  /** Unique delivered notes; retrieval totals above may count source spans. */
  readonly notesRead?: number;
  readonly knowledgeDecision?: boolean;
  readonly skillName?: string;
}

export interface EchoInkReasoningSummarySnapshot {
  readonly schemaVersion: typeof ECHOINK_REASONING_SUMMARY_SCHEMA_VERSION;
  readonly conversationId: string;
  readonly piSessionId: string;
  readonly productRunId: string;
  readonly status: EchoInkReasoningSummaryStatus;
  readonly startedAt: number;
  readonly updatedAt: number;
  readonly firstAssistantTextAt?: number;
  readonly terminalAt?: number;
  readonly activities: readonly Readonly<EchoInkReasoningActivity>[];
}

export interface EchoInkReasoningSummaryEntryData {
  readonly schemaVersion: typeof ECHOINK_REASONING_SUMMARY_SCHEMA_VERSION;
  readonly conversationId: string;
  readonly piSessionId: string;
  readonly productRunId: string;
  readonly summary: Readonly<EchoInkReasoningSummarySnapshot>;
}

export interface EchoInkReasoningSummaryEntryView {
  readonly type: string;
  readonly customType?: string;
  readonly data?: unknown;
}

const IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const TOOL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const ACTIVITY_LIMIT = 64;
const ACTIVITY_KINDS = new Set<EchoInkReasoningActivityKind>([
  "provider",
  "judgment",
  "knowledge",
  "memory",
  "task",
  "tool"
]);
const ACTIVITY_STATUSES = new Set<EchoInkReasoningActivityStatus>([
  "active",
  "completed",
  "failed",
  "interrupted",
  "cancelled"
]);
const ACTIVITY_STAGES = new Set<EchoInkReasoningActivityStage>([
  "requesting",
  "searching",
  "selecting_knowledge",
  "continuing_search",
  "reading_knowledge",
  "comparing_memory",
  "checking_conflicts_freshness",
  "refining_knowledge",
  "writing_and_readback",
  "loading",
  "catalog",
  "matching",
  "budgeting",
  "assembling",
  "pending",
  "in_progress",
  "paused",
  "completed",
  "failed",
  "cancelled"
]);

export function normalizeEchoInkReasoningSummarySnapshot(
  value: unknown
): Readonly<EchoInkReasoningSummarySnapshot> {
  const record = strictRecord(value, "reasoning_summary_invalid");
  assertExactKeys(record, [
    "schemaVersion",
    "conversationId",
    "piSessionId",
    "productRunId",
    "status",
    "startedAt",
    "updatedAt",
    "activities"
  ], ["firstAssistantTextAt", "terminalAt"], "reasoning_summary_invalid");
  if (record.schemaVersion !== ECHOINK_REASONING_SUMMARY_SCHEMA_VERSION) {
    throw new TypeError("reasoning_summary_invalid");
  }
  const conversationId = reasoningIdentity(record.conversationId);
  const piSessionId = reasoningIdentity(record.piSessionId);
  const productRunId = reasoningIdentity(record.productRunId);
  if (!isReasoningSummaryStatus(record.status)) {
    throw new TypeError("reasoning_summary_status_invalid");
  }
  const startedAt = nonNegativeTime(record.startedAt);
  const updatedAt = nonNegativeTime(record.updatedAt);
  const firstAssistantTextAt = optionalTime(record.firstAssistantTextAt);
  const terminalAt = optionalTime(record.terminalAt);
  if (
    updatedAt < startedAt
    || (firstAssistantTextAt !== undefined
      && (firstAssistantTextAt < startedAt || firstAssistantTextAt > updatedAt))
    || (terminalAt !== undefined
      && (terminalAt < startedAt || terminalAt > updatedAt))
  ) throw new TypeError("reasoning_summary_time_invalid");
  if (record.status === "running" && (
    firstAssistantTextAt !== undefined || terminalAt !== undefined
  )) throw new TypeError("reasoning_summary_running_invalid");
  if (
    record.status === "completed"
    && firstAssistantTextAt === undefined
    && terminalAt === undefined
  ) {
    throw new TypeError("reasoning_summary_completion_invalid");
  }
  if (
    record.status !== "running"
    && record.status !== "completed"
    && terminalAt === undefined
  ) throw new TypeError("reasoning_summary_terminal_invalid");
  if (!Array.isArray(record.activities) || record.activities.length > ACTIVITY_LIMIT) {
    throw new TypeError("reasoning_summary_activities_invalid");
  }
  const seen = new Set<string>();
  const activities = Object.freeze(record.activities.map((item) => {
    const activity = normalizeReasoningActivity(item, startedAt, updatedAt);
    if (seen.has(activity.id)) {
      throw new TypeError("reasoning_summary_activity_duplicate");
    }
    seen.add(activity.id);
    return activity;
  }));
  return freezeEchoInkReasoningSummary({
    schemaVersion: ECHOINK_REASONING_SUMMARY_SCHEMA_VERSION,
    conversationId,
    piSessionId,
    productRunId,
    status: record.status,
    startedAt,
    updatedAt,
    ...(firstAssistantTextAt !== undefined ? { firstAssistantTextAt } : {}),
    ...(terminalAt !== undefined ? { terminalAt } : {}),
    activities
  });
}

export function reasoningSummaryEntryData(input: Readonly<{
  conversationId: string;
  piSessionId: string;
  summary: Readonly<EchoInkReasoningSummarySnapshot>;
}>): Readonly<EchoInkReasoningSummaryEntryData> {
  const summary = normalizeEchoInkReasoningSummarySnapshot(input.summary);
  if (
    summary.conversationId !== input.conversationId
    || summary.piSessionId !== input.piSessionId
  ) throw new TypeError("reasoning_summary_identity_mismatch");
  return Object.freeze({
    schemaVersion: ECHOINK_REASONING_SUMMARY_SCHEMA_VERSION,
    conversationId: reasoningIdentity(input.conversationId),
    piSessionId: reasoningIdentity(input.piSessionId),
    productRunId: summary.productRunId,
    summary
  });
}

export function reasoningSummaryFromSessionEntry(
  entry: Readonly<EchoInkReasoningSummaryEntryView>,
  expectedPiSessionId?: string
): Readonly<EchoInkReasoningSummarySnapshot> | null {
  if (
    entry.type !== "custom"
    || entry.customType !== ECHOINK_REASONING_SUMMARY_ENTRY_TYPE
  ) return null;
  try {
    const data = strictRecord(entry.data, "reasoning_summary_entry_invalid");
    assertExactKeys(data, [
      "schemaVersion",
      "conversationId",
      "piSessionId",
      "productRunId",
      "summary"
    ], [], "reasoning_summary_entry_invalid");
    if (data.schemaVersion !== ECHOINK_REASONING_SUMMARY_SCHEMA_VERSION) return null;
    const summary = normalizeEchoInkReasoningSummarySnapshot(data.summary);
    if (
      data.conversationId !== summary.conversationId
      || data.piSessionId !== summary.piSessionId
      || data.productRunId !== summary.productRunId
      || (expectedPiSessionId !== undefined
        && summary.piSessionId !== expectedPiSessionId)
    ) return null;
    return summary;
  } catch {
    return null;
  }
}

export function freezeEchoInkReasoningSummary(
  value: EchoInkReasoningSummarySnapshot
): Readonly<EchoInkReasoningSummarySnapshot> {
  return Object.freeze({
    ...value,
    activities: Object.freeze(value.activities.map((activity) =>
      Object.freeze({ ...activity })
    ))
  });
}

export function isReasoningSummaryStatus(
  value: unknown
): value is EchoInkReasoningSummaryStatus {
  return typeof value === "string"
    && (ECHOINK_REASONING_SUMMARY_STATUSES as readonly string[]).includes(value);
}

export function reasoningSummaryIsNewer(
  next: Readonly<EchoInkReasoningSummarySnapshot>,
  previous: Readonly<EchoInkReasoningSummarySnapshot>
): boolean {
  if (next.updatedAt !== previous.updatedAt) return next.updatedAt > previous.updatedAt;
  return reasoningStatusRank(next.status) >= reasoningStatusRank(previous.status);
}

function normalizeReasoningActivity(
  value: unknown,
  summaryStartedAt: number,
  summaryUpdatedAt: number
): Readonly<EchoInkReasoningActivity> {
  const record = strictRecord(value, "reasoning_summary_activity_invalid");
  assertExactKeys(record, [
    "id",
    "kind",
    "status",
    "startedAt",
    "updatedAt"
  ], ["stage", "name", "current", "total", "completed", "notesRead", "knowledgeDecision", "skillName"],
  "reasoning_summary_activity_invalid");
  const id = reasoningIdentity(record.id);
  if (!ACTIVITY_KINDS.has(record.kind as EchoInkReasoningActivityKind)) {
    throw new TypeError("reasoning_summary_activity_kind_invalid");
  }
  if (!ACTIVITY_STATUSES.has(record.status as EchoInkReasoningActivityStatus)) {
    throw new TypeError("reasoning_summary_activity_status_invalid");
  }
  const startedAt = nonNegativeTime(record.startedAt);
  const updatedAt = nonNegativeTime(record.updatedAt);
  if (
    startedAt < summaryStartedAt
    || updatedAt < startedAt
    || updatedAt > summaryUpdatedAt
  ) throw new TypeError("reasoning_summary_activity_time_invalid");
  const stage = record.stage === undefined
    ? undefined
    : ACTIVITY_STAGES.has(record.stage as EchoInkReasoningActivityStage)
      ? record.stage as EchoInkReasoningActivityStage
      : (() => { throw new TypeError("reasoning_summary_activity_stage_invalid"); })();
  const name = record.name === undefined
    ? undefined
    : typeof record.name === "string" && TOOL_NAME.test(record.name)
      ? record.name
      : (() => { throw new TypeError("reasoning_summary_activity_name_invalid"); })();
  if ((record.kind === "tool") !== Boolean(name)) {
    throw new TypeError("reasoning_summary_activity_name_invalid");
  }
  if (record.knowledgeDecision !== undefined && typeof record.knowledgeDecision !== "boolean") throw new TypeError("reasoning_summary_judgment_invalid");
  if (record.skillName !== undefined && (typeof record.skillName !== "string" || record.skillName.length > 160)) throw new TypeError("reasoning_summary_judgment_invalid");
  const current = optionalCount(record.current);
  const total = optionalCount(record.total);
  const completed = optionalCount(record.completed);
  if (
    (current !== undefined && total === undefined)
    || (completed !== undefined && total === undefined)
    || (current !== undefined && total !== undefined && current > total)
    || (completed !== undefined && total !== undefined && completed > total)
  ) throw new TypeError("reasoning_summary_activity_count_invalid");
  return Object.freeze({
    id,
    kind: record.kind as EchoInkReasoningActivityKind,
    status: record.status as EchoInkReasoningActivityStatus,
    startedAt,
    updatedAt,
    ...(stage ? { stage } : {}),
    ...(name ? { name } : {}),
    ...(current !== undefined ? { current } : {}),
    ...(total !== undefined ? { total } : {}),
    ...(completed !== undefined ? { completed } : {}),
    ...(record.notesRead !== undefined ? { notesRead: optionalCount(record.notesRead) } : {}),
    ...(record.knowledgeDecision !== undefined ? { knowledgeDecision: record.knowledgeDecision } : {}),
    ...(record.skillName !== undefined ? { skillName: record.skillName } : {})
  });
}

function strictRecord(value: unknown, error: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(error);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  error: string
): void {
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !Object.prototype.hasOwnProperty.call(value, key))
    || Object.keys(value).some((key) => !allowed.has(key))
  ) throw new TypeError(error);
}

function reasoningIdentity(value: unknown): string {
  if (typeof value !== "string" || !IDENTITY.test(value)) {
    throw new TypeError("reasoning_summary_identity_invalid");
  }
  return value;
}

function nonNegativeTime(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError("reasoning_summary_time_invalid");
  }
  return value as number;
}

function optionalTime(value: unknown): number | undefined {
  return value === undefined ? undefined : nonNegativeTime(value);
}

function optionalCount(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError("reasoning_summary_activity_count_invalid");
  }
  return value as number;
}

function reasoningStatusRank(status: EchoInkReasoningSummaryStatus): number {
  if (status === "running") return 0;
  if (status === "completed") return 1;
  return 2;
}
