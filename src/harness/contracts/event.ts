export type HarnessEventSource = "kernel" | "agent" | "workflow" | "tool" | "memory";

export type HarnessContentAvailability = "provided" | "empty" | "unavailable";

export type HarnessReasoningKind = "summary" | "trace" | "provider";

export type HarnessReasoningVisibility = "public";

/**
 * Backend-neutral usage captured for one Harness run.
 *
 * All fields are optional because providers expose different accounting
 * details. Raw provider usage may remain alongside this snapshot in event
 * data, but presenters should consume only this normalized shape.
 */
export interface HarnessRunUsage {
  totalTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  cost?: number;
}

export type HarnessToolSemanticKind =
  | "read"
  | "search"
  | "command"
  | "edit"
  | "mcp"
  | "agent"
  | "plan"
  | "tool";

export type HarnessToolStatus =
  | "requested"
  | "running"
  | "approval"
  | "completed"
  | "failed"
  | "denied"
  | "interrupted"
  | "unconfirmed";

/**
 * Backend-neutral process metadata consumed by UI projections.
 *
 * Provider payloads may retain additional diagnostic fields, but UI code must
 * use these normalized fields instead of branching on a backend's raw shape.
 */
export interface HarnessProcessEventData extends Record<string, unknown> {
  messageId?: string;
  blockId?: string;
  reasoningKind?: HarnessReasoningKind;
  visibility?: HarnessReasoningVisibility;
  callId?: string;
  toolCallId?: string;
  semanticKind?: HarnessToolSemanticKind;
  toolStatus?: HarnessToolStatus;
  inputState?: HarnessContentAvailability;
  outputState?: HarnessContentAvailability;
  input?: unknown;
  output?: unknown;
  files?: string[];
  locations?: unknown;
  changes?: unknown;
  diff?: unknown;
  diffSummary?: unknown;
  displayPreview?: string;
  streamSource?: string;
  promptSubmitted?: boolean;
  unconfirmedToolCallCount?: number;
  usage?: HarnessRunUsage;
}

export type HarnessEventType =
  | "run.created"
  | "run.started"
  | "run.completed"
  | "run.failed"
  | "run.cancelled"
  | "run.local_commit.started"
  | "run.local_commit.completed"
  | "run.local_commit.failed"
  | "run.surface_terminal.ignored"
  | "session.context.snapshot.updated"
  | "session.context.bootstrap.compiled"
  | "agent.connecting"
  | "agent.connected"
  | "agent.native_execution.created"
  | "agent.native_lease.created"
  | "agent.native_lease.reused"
  | "agent.native_lease.expired"
  | "agent.native_lease.recovery_failed"
  | "agent.native_cleanup.scheduled"
  | "agent.native_cleanup.started"
  | "agent.native_cleanup.completed"
  | "agent.native_cleanup.unsupported"
  | "agent.native_cleanup.failed"
  | "agent.native_cleanup.retained"
  | "agent.native_cleanup.quarantined"
  | "agent.message.delta"
  | "agent.message.completed"
  | "agent.reasoning.started"
  | "agent.reasoning.summary.delta"
  | "agent.reasoning.summary.completed"
  | "agent.thinking.delta"
  | "agent.thinking.completed"
  | "agent.plan.updated"
  | "tool.requested"
  | "tool.approval.requested"
  | "tool.approval.resolved"
  | "tool.started"
  | "tool.output.delta"
  | "tool.completed"
  | "tool.failed"
  | "file.change.proposed"
  | "file.change.applied"
  | "file.change.reverted"
  | "usage.updated"
  | "adapter.fallback.started"
  | "workflow.started"
  | "workflow.phase.started"
  | "workflow.phase.progress"
  | "workflow.phase.completed"
  | "workflow.phase.failed"
  | "workflow.validation.started"
  | "workflow.validation.result"
  | "workflow.transaction.snapshot"
  | "workflow.transaction.committed"
  | "workflow.transaction.rolled_back"
  | "workflow.artifact.created"
  | "workflow.report.ready"
  | "workflow.completed";

export interface HarnessEvent {
  eventId: string;
  runId: string;
  sequence: number;
  createdAt: number;
  source: HarnessEventSource;
  type: HarnessEventType;
  backendId?: string;
  text?: string;
  title?: string;
  status?: string;
  toolName?: string;
  resourceId?: string;
  error?: string;
  data?: HarnessProcessEventData;
}

export type HarnessEventSink = (event: HarnessEvent) => void | Promise<void>;

/**
 * Normalizes Codex, OpenCode and Hermes usage without treating cumulative
 * Codex thread totals as per-run usage. When Codex supplies `{ last, total }`,
 * only `last` is eligible for the answer snapshot.
 */
export function normalizeHarnessRunUsage(value: unknown): HarnessRunUsage | undefined {
  const root = usageRecord(value);
  if (!root) return undefined;
  const wrapped = usageRecord(root.usage) ?? root;
  const source = usageRecord(wrapped.last) ?? wrapped;
  const tokens = usageRecord(source.tokens);
  const cache = usageRecord(tokens?.cache) ?? usageRecord(source.cache);

  const inputTokens = usageNumber(source, tokens, ["inputTokens", "input_tokens", "input", "promptTokens", "prompt_tokens"]);
  const outputTokens = usageNumber(source, tokens, ["outputTokens", "output_tokens", "output", "completionTokens", "completion_tokens"]);
  const explicitTotal = usageNumber(source, tokens, ["totalTokens", "total_tokens", "total"]);
  const totalTokens = explicitTotal ?? (inputTokens !== undefined && outputTokens !== undefined
    ? inputTokens + outputTokens
    : undefined);
  const usage: HarnessRunUsage = compactUsage({
    totalTokens,
    inputTokens,
    outputTokens,
    reasoningTokens: usageNumber(source, tokens, ["reasoningTokens", "reasoning_tokens", "reasoningOutputTokens", "reasoning_output_tokens", "reasoning"]),
    cacheReadTokens: usageNumber(source, tokens, ["cacheReadTokens", "cache_read_tokens", "cachedInputTokens", "cached_input_tokens", "cacheRead", "cache_read"])
      ?? usageNumber(cache ?? {}, undefined, ["read"]),
    cacheWriteTokens: usageNumber(source, tokens, ["cacheWriteTokens", "cache_write_tokens", "cacheWrite", "cache_write"])
      ?? usageNumber(cache ?? {}, undefined, ["write"]),
    cost: usageNumber(source, undefined, ["cost"])
  });
  return Object.keys(usage).length ? usage : undefined;
}

function usageRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function usageNumber(
  source: Record<string, unknown>,
  nested: Record<string, unknown> | undefined,
  keys: string[]
): number | undefined {
  for (const record of [source, nested]) {
    if (!record) continue;
    for (const key of keys) {
      const value = record[key];
      if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
    }
  }
  return undefined;
}

function compactUsage(usage: HarnessRunUsage): HarnessRunUsage {
  return Object.fromEntries(
    Object.entries(usage).filter((entry): entry is [string, number] => entry[1] !== undefined)
  );
}
