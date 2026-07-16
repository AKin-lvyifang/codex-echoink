export type HarnessEventSource = "kernel" | "agent" | "workflow" | "tool" | "memory";

export type HarnessContentAvailability = "provided" | "empty" | "unavailable";

export type HarnessReasoningKind = "summary" | "trace" | "provider";

export type HarnessReasoningVisibility = "public";

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
