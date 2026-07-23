import { appendFile, mkdir, readFile } from "node:fs/promises";
import * as path from "node:path";
import type { HarnessEvent } from "../contracts/event";

export interface RunLedger {
  append(event: HarnessEvent): Promise<void>;
  readRun(runId: string): Promise<HarnessEvent[]>;
}

export type RunLedgerAppendReadbackReceipt =
  | {
    status: "committed";
    events: HarnessEvent[];
  }
  | {
    status: "absent";
    events: HarnessEvent[];
  };

export class RunLedgerAppendReadbackConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunLedgerAppendReadbackConflictError";
  }
}

/**
 * Resolves the ambiguous outcome of an append that rejected.
 *
 * A readback is authoritative only when it preserves the lane's exact durable
 * prefix and contains either no suffix (the append is clearly absent) or one
 * exact JSON-persistence-equivalent candidate. Any other observation is
 * split-brain evidence and must fail closed.
 */
export function resolveRunLedgerAppendReadbackReceipt(input: {
  previousEvents: readonly HarnessEvent[];
  candidate: HarnessEvent;
  observedEvents: readonly HarnessEvent[];
}): RunLedgerAppendReadbackReceipt {
  const previous = input.previousEvents;
  const observed = input.observedEvents;
  const candidate = input.candidate;

  validateUnambiguousReadback(candidate.runId, observed);
  if (previous.some((event) => sameRunEventIdentity(event, candidate))) {
    throw new RunLedgerAppendReadbackConflictError(
      `Run Ledger candidate identity already existed before append: ${candidate.eventId}`
    );
  }
  if (observed.length < previous.length) {
    throw new RunLedgerAppendReadbackConflictError(
      `Run Ledger durable prefix regressed while reading back ${candidate.eventId}`
    );
  }
  for (let index = 0; index < previous.length; index += 1) {
    if (!sameRunEventPayload(previous[index], observed[index])) {
      throw new RunLedgerAppendReadbackConflictError(
        `Run Ledger durable prefix changed while reading back ${candidate.eventId}`
      );
    }
  }

  const suffix = observed.slice(previous.length);
  if (suffix.length === 0) {
    return { status: "absent", events: [...observed] };
  }
  if (suffix.length !== 1) {
    throw new RunLedgerAppendReadbackConflictError(
      `Run Ledger append readback contains duplicate or competing events for ${candidate.eventId}`
    );
  }

  const persisted = suffix[0];
  if (!sameRunEventIdentity(persisted, candidate)) {
    throw new RunLedgerAppendReadbackConflictError(
      `Run Ledger append identity conflicts with ${candidate.eventId}`
    );
  }
  if (!sameRunEventPayload(persisted, candidate)) {
    throw new RunLedgerAppendReadbackConflictError(
      `Run Ledger append payload conflicts with ${candidate.eventId}`
    );
  }
  return { status: "committed", events: [...observed] };
}

export class InMemoryRunLedger implements RunLedger {
  private readonly eventsByRun = new Map<string, HarnessEvent[]>();

  async append(event: HarnessEvent): Promise<void> {
    const events = this.eventsByRun.get(event.runId) ?? [];
    events.push(event);
    this.eventsByRun.set(event.runId, events);
  }

  async readRun(runId: string): Promise<HarnessEvent[]> {
    return [...(this.eventsByRun.get(runId) ?? [])];
  }
}

export interface FileRunLedgerOptions {
  rootPath: string;
}

export class FileRunLedger implements RunLedger {
  constructor(private readonly options: FileRunLedgerOptions) {}

  async append(event: HarnessEvent): Promise<void> {
    const filePath = this.filePathForRun(event.runId);
    await mkdir(path.dirname(filePath), { recursive: true });
    await appendFile(filePath, `${JSON.stringify(event)}\n`, "utf8");
  }

  async readRun(runId: string): Promise<HarnessEvent[]> {
    const filePath = this.filePathForRun(runId);
    const text = await readFile(filePath, "utf8").catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
      throw error;
    });
    return text.split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as HarnessEvent)
      .sort((left, right) => left.sequence - right.sequence);
  }

  private filePathForRun(runId: string): string {
    return path.join(this.options.rootPath, `${safeRunFileName(runId)}.jsonl`);
  }
}

function safeRunFileName(runId: string): string {
  const safe = runId.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return safe || "run";
}

function validateUnambiguousReadback(
  runId: string,
  events: readonly HarnessEvent[]
): void {
  const eventIds = new Set<string>();
  const sequences = new Set<number>();
  let terminalCount = 0;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (
      event.runId !== runId
      || !event.eventId
      || !Number.isSafeInteger(event.sequence)
      || event.sequence !== index + 1
    ) {
      throw new RunLedgerAppendReadbackConflictError(
        `Run Ledger sequence or run identity is ambiguous for ${runId}`
      );
    }
    if (eventIds.has(event.eventId) || sequences.has(event.sequence)) {
      throw new RunLedgerAppendReadbackConflictError(
        `Run Ledger contains duplicate event identity for ${runId}`
      );
    }
    eventIds.add(event.eventId);
    sequences.add(event.sequence);
    if (isTerminalRunEvent(event)) terminalCount += 1;
  }
  if (terminalCount > 1) {
    throw new RunLedgerAppendReadbackConflictError(
      `Run Ledger contains multiple terminal events for ${runId}`
    );
  }
}

function sameRunEventIdentity(
  left: HarnessEvent,
  right: HarnessEvent
): boolean {
  return left.runId === right.runId
    && left.eventId === right.eventId
    && left.sequence === right.sequence;
}

function sameRunEventPayload(
  left: HarnessEvent,
  right: HarnessEvent
): boolean {
  return stableJson(left) === stableJson(right);
}

function stableJson(value: unknown): string {
  const persisted = JSON.stringify(value);
  if (persisted === undefined) {
    throw new TypeError("Run Ledger event payload is not serializable");
  }
  return JSON.stringify(
    canonicalJsonValue(JSON.parse(persisted), new Set<object>())
  );
}

function canonicalJsonValue(
  value: unknown,
  ancestors: Set<object>
): unknown {
  if (!value || typeof value !== "object") return value;
  if (ancestors.has(value)) {
    throw new TypeError("Run Ledger event payload is not serializable");
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => canonicalJsonValue(item, ancestors));
    }
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [
          key,
          canonicalJsonValue(item, ancestors)
        ])
    );
  } finally {
    ancestors.delete(value);
  }
}

function isTerminalRunEvent(event: HarnessEvent): boolean {
  return event.type === "run.completed"
    || event.type === "run.failed"
    || event.type === "run.cancelled";
}
