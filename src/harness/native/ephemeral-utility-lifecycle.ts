import { createHash } from "node:crypto";
import type { AgentAdapter, AgentRunResult } from "../agents/adapter";
import type { HarnessEvent } from "../contracts/event";
import type {
  LocalRunCommitResult,
  MemoryTransactionAuthorityReceipt,
  NativeExecutionRecord,
  NativeExecutionRef,
  NativeLocalCommitAuthority,
  NativeRunOutcome
} from "../contracts/native-execution";
import type { HarnessRunRequest, HarnessRunResult } from "../contracts/run";
import type { HarnessRunWithAdapterInput } from "../kernel/harness-kernel";
import type { SettleRunTerminalInput } from "../kernel/run-orchestrator";
import type {
  NativeCleanupResult,
  SettleNativeExecutionInput
} from "./native-execution-manager";

export type EphemeralUtilityWorkflow =
  | "backend.probe"
  | "prompt.enhance"
  | "memory.curate";

const EPHEMERAL_UTILITY_SURFACES: Record<
  EphemeralUtilityWorkflow,
  HarnessRunRequest["surface"]
> = {
  "backend.probe": "system",
  "prompt.enhance": "chat",
  "memory.curate": "review"
};

export interface EphemeralUtilityLifecycleHost {
  runHarnessWithAdapter(
    input: HarnessRunWithAdapterInput
  ): Promise<HarnessRunResult>;
  cancelHarnessRun(runId: string): Promise<void>;
  settleHarnessRunTerminal(
    input: SettleRunTerminalInput
  ): Promise<HarnessEvent>;
  recordNativeExecution(record: NativeExecutionRecord): Promise<void>;
  settleNativeExecution(
    input: SettleNativeExecutionInput
  ): Promise<NativeExecutionRecord | null>;
  cleanupNativeExecutionRecord(recordId: string): Promise<NativeCleanupResult>;
}

export interface EphemeralUtilityValidatedOutput<T> {
  value: T;
  terminalText: string;
  terminalData?: Record<string, unknown>;
}

interface RunEphemeralUtilityInputBase<T> {
  host: EphemeralUtilityLifecycleHost;
  adapter: AgentAdapter;
  request: HarnessRunRequest & { workflow: EphemeralUtilityWorkflow };
  signal?: AbortSignal;
  timeoutMs?: number;
  timeoutMessage?: string;
  onHarnessStarted?(): void;
  awaitResult?(): Promise<AgentRunResult>;
  validateOutput(
    text: string,
    result: HarnessRunResult | AgentRunResult
  ): Promise<EphemeralUtilityValidatedOutput<T>>
    | EphemeralUtilityValidatedOutput<T>;
  failureTerminalData?(error: unknown): Record<string, unknown> | undefined;
  isCancellation?: (error: unknown) => boolean;
  disposeAdapter?(): Promise<void>;
  logLabel?: string;
}

export interface RunImmediateEphemeralUtilityInput<T>
  extends RunEphemeralUtilityInputBase<T> {
  settlement?: { mode: "immediate" };
}

export interface RunDeferredEphemeralUtilityInput<T>
  extends RunEphemeralUtilityInputBase<T> {
  settlement: {
    mode: "deferred";
    authority: NativeLocalCommitAuthority;
  };
}

export type RunEphemeralUtilityInput<T> =
  | RunImmediateEphemeralUtilityInput<T>
  | RunDeferredEphemeralUtilityInput<T>;

export interface EphemeralUtilityNativeFinalizationReceipt {
  recordId: string;
  settlement: "settled" | "missing" | "failed" | "mismatch";
  cleanup?: NativeCleanupResult;
  error?: string;
}

export interface EphemeralUtilityFinalizationReceipt {
  runId: string;
  authority: MemoryTransactionAuthorityReceipt;
  records: EphemeralUtilityNativeFinalizationReceipt[];
}

export interface DeferredEphemeralUtilityResult<T> {
  value: T;
  authority: NativeLocalCommitAuthority;
  finalize(
    receipt: MemoryTransactionAuthorityReceipt
  ): Promise<EphemeralUtilityFinalizationReceipt>;
}

export class EphemeralUtilityExecutionError extends Error {
  constructor(
    message: string,
    readonly runOutcome: Exclude<NativeRunOutcome, "success">,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "EphemeralUtilityExecutionError";
  }
}

type EphemeralUtilityCancellationCause = {
  error: Error;
};

type ReflectedUtilityOperation<T> =
  | { status: "fulfilled"; value: T }
  | { status: "rejected"; error: unknown };

/**
 * Converts timeout or product-surface abort into an awaitable Harness cancel.
 *
 * The losing operation is always drained before its caller can dispose the
 * adapter or settle Native records. This prevents a timed-out run from
 * crossing the durable registration barrier, submitting a late prompt, or
 * registering a Native execution after lifecycle settlement already ran.
 */
class EphemeralUtilityCancellationCoordinator {
  private readonly cancellation: Promise<EphemeralUtilityCancellationCause>;
  private resolveCancellation!: (
    cause: EphemeralUtilityCancellationCause
  ) => void;
  private readonly onExternalAbort: () => void;
  private cause: EphemeralUtilityCancellationCause | null = null;
  private cancelFlight: Promise<void> | null = null;
  private harnessStarted = false;

  constructor(
    private readonly input: Pick<
      RunEphemeralUtilityInput<unknown>,
      "host" | "request" | "signal" | "timeoutMs" | "timeoutMessage" | "logLabel"
    >
  ) {
    this.cancellation = new Promise((resolve) => {
      this.resolveCancellation = resolve;
    });
    this.onExternalAbort = () => {
      const reason: unknown = input.signal?.reason;
      const cause = reason instanceof Error ? reason : undefined;
      this.trigger({
        error: new EphemeralUtilityExecutionError(
          "Utility run was cancelled",
          "cancelled",
          cause ? { cause } : undefined
        )
      });
    };
    if (input.signal?.aborted) {
      this.onExternalAbort();
    } else {
      input.signal?.addEventListener("abort", this.onExternalAbort, {
        once: true
      });
    }
  }

  markHarnessStarted(): void {
    this.harnessStarted = true;
    if (this.cause) this.requestHarnessCancellation();
  }

  throwIfCancelled(): void {
    if (this.cause) throw this.cause.error;
  }

  cancelForFailure(error: unknown): void {
    this.trigger({ error: normalizeError(error) });
  }

  async waitFor<T>(operation: Promise<T>): Promise<T> {
    const reflected = operation.then<
      ReflectedUtilityOperation<T>,
      ReflectedUtilityOperation<T>
    >(
      (value) => ({ status: "fulfilled", value }),
      (error: unknown) => ({ status: "rejected", error })
    );
    const timer = this.armTimeout();
    let winner:
      | { kind: "operation"; result: ReflectedUtilityOperation<T> }
      | { kind: "cancellation"; cause: EphemeralUtilityCancellationCause };
    try {
      winner = await Promise.race([
        reflected.then((result) => ({ kind: "operation" as const, result })),
        this.cancellation.then((cause) => ({
          kind: "cancellation" as const,
          cause
        }))
      ]);
    } finally {
      if (timer !== null) window.clearTimeout(timer);
    }

    const cancellation = this.cause
      ?? (winner.kind === "cancellation" ? winner.cause : null);
    if (cancellation) {
      await this.drainCancelledOperation(reflected);
      throw cancellation.error;
    }
    if (winner.kind !== "operation") {
      throw new Error("Ephemeral utility cancellation state is inconsistent");
    }
    if (winner.result.status === "rejected") throw winner.result.error;
    return winner.result.value;
  }

  dispose(): void {
    this.input.signal?.removeEventListener("abort", this.onExternalAbort);
  }

  private armTimeout(): number | null {
    const timeoutMs = this.input.timeoutMs;
    if (
      timeoutMs === undefined
      || !Number.isFinite(timeoutMs)
      || timeoutMs <= 0
    ) {
      return null;
    }
    return window.setTimeout(() => {
      this.trigger({
        error: new Error(
          this.input.timeoutMessage
            ?? `${this.input.request.workflow} timed out`
        )
      });
    }, Math.max(1, Math.floor(timeoutMs)));
  }

  private trigger(cause: EphemeralUtilityCancellationCause): void {
    if (this.cause) return;
    this.cause = cause;
    if (this.harnessStarted) this.requestHarnessCancellation();
    this.resolveCancellation(cause);
  }

  private requestHarnessCancellation(): void {
    if (this.cancelFlight) return;
    this.cancelFlight = this.input.host.cancelHarnessRun(
      this.input.request.runId
    );
    void this.cancelFlight.catch(() => undefined);
  }

  private async drainCancelledOperation<T>(
    operation: Promise<ReflectedUtilityOperation<T>>
  ): Promise<void> {
    try {
      await this.cancelFlight;
    } catch (error) {
      console.error(
        `${this.input.logLabel ?? this.input.request.workflow} Harness cancellation failed`,
        error
      );
    }
    await operation;
  }
}

/**
 * Owns the complete Native lifecycle for isolated utility Harness runs.
 *
 * The adapter's registration barrier persists every Native ID before the first
 * prompt/process execution. The product validates the candidate before the
 * only Run Ledger terminal is committed. Native settlement happens only after
 * adapter disposal, and exact cleanup is deliberately best-effort because it
 * must never rewrite an already committed business result.
 */
export function runEphemeralUtility<T>(
  input: RunImmediateEphemeralUtilityInput<T>
): Promise<T>;
export function runEphemeralUtility<T>(
  input: RunDeferredEphemeralUtilityInput<T>
): Promise<DeferredEphemeralUtilityResult<T>>;
export async function runEphemeralUtility<T>(
  input: RunEphemeralUtilityInput<T>
): Promise<T | DeferredEphemeralUtilityResult<T>> {
  assertEphemeralUtilityRequest(input.request, input.adapter);
  assertEphemeralUtilitySettlement(input);
  const cancellation = new EphemeralUtilityCancellationCoordinator(input);
  const recordIds = new Set<string>();
  let runOutcome: NativeRunOutcome = "failed";
  let localCommit = utilityLocalCommit(false, "Run Ledger terminal was not committed");
  let terminalCommitAttempted = false;
  let harnessStartAttempted = false;
  let deferredSuccessfulSettlement = false;

  try {
    cancellation.throwIfCancelled();
    harnessStartAttempted = true;
    cancellation.markHarnessStarted();
    const start = input.host.runHarnessWithAdapter({
      adapter: input.adapter,
      request: input.request,
      terminalAuthority: "surface",
      registerNativeExecution: async ({ request, native }) => {
        assertRegistrationRequest(input.request, request, native);
        const record = ephemeralUtilityNativeRecord(
          input.request,
          native,
          input.settlement?.mode === "deferred"
            ? input.settlement.authority
            : undefined
        );
        await input.host.recordNativeExecution(record);
        recordIds.add(record.id);
        return { recordId: record.id };
      }
    });
    try {
      input.onHarnessStarted?.();
    } catch (error) {
      cancellation.cancelForFailure(error);
    }
    const initial = await cancellation.waitFor(start);
    const output = await resolveUtilityOutput(input, initial, cancellation);
    cancellation.throwIfCancelled();
    runOutcome = "success";
    terminalCommitAttempted = true;
    try {
      await commitExactUtilityTerminal(input.host, {
        runId: input.request.runId,
        status: "completed",
        backendId: input.request.backendId,
        text: output.terminalText,
        data: output.terminalData
      });
      localCommit = utilityLocalCommit(true);
    } catch (error) {
      localCommit = utilityLocalCommit(false, errorMessage(error));
      throw error;
    }
    if (input.settlement?.mode === "deferred") {
      deferredSuccessfulSettlement = true;
      return createDeferredUtilityResult(
        input as RunDeferredEphemeralUtilityInput<T>,
        output.value,
        recordIds
      );
    }
    return output.value;
  } catch (error) {
    const taskError = normalizeError(error);
    if (harnessStartAttempted && !terminalCommitAttempted) {
      runOutcome = utilityRunOutcome(error, input.isCancellation);
      terminalCommitAttempted = true;
      try {
        await commitExactUtilityTerminal(input.host, {
          runId: input.request.runId,
          status: runOutcome === "cancelled" ? "cancelled" : "failed",
          backendId: input.request.backendId,
          error: taskError.message,
          data: input.failureTerminalData?.(error)
        });
        localCommit = utilityLocalCommit(true);
      } catch (terminalError) {
        localCommit = utilityLocalCommit(false, errorMessage(terminalError));
        console.error(
          `${input.logLabel ?? input.request.workflow} Run Ledger terminal remains pending`,
          terminalError
        );
      }
    }
    throw taskError;
  } finally {
    cancellation.dispose();
    try {
      await (input.disposeAdapter?.() ?? input.adapter.dispose());
    } catch (error) {
      console.error(
        `${input.logLabel ?? input.request.workflow} adapter disposal failed`,
        error
      );
    }
    if (!deferredSuccessfulSettlement) {
      await settleAndCleanupUtilityRecords(
        input.host,
        recordIds,
        runOutcome,
        localCommit,
        input.logLabel ?? input.request.workflow
      );
    }
  }
}

export function isEphemeralUtilityWorkflow(
  workflow: string
): workflow is EphemeralUtilityWorkflow {
  return workflow === "backend.probe"
    || workflow === "prompt.enhance"
    || workflow === "memory.curate";
}

export function assertRecoverableEphemeralUtilityNativeRecord(
  record: NativeExecutionRecord
): asserts record is NativeExecutionRecord & {
  workflow: EphemeralUtilityWorkflow;
} {
  if (
    !isEphemeralUtilityWorkflow(record.workflow)
    || record.surface !== EPHEMERAL_UTILITY_SURFACES[record.workflow]
    || record.policy.mode !== "ephemeral-run"
    || record.localCommit !== "pending"
    || record.cleanup !== "not-needed"
    || record.retirement !== undefined
    || !record.id.trim()
    || !record.runId.trim()
    || !record.sessionId.trim()
    || !record.native.backendId.trim()
  ) {
    throw new Error(
      `Ephemeral utility Native startup recovery found an invalid pending record: ${record.id || "<missing-id>"}`
    );
  }
}

/**
 * Validates complete Run Ledger authority for a pending utility run. Callers
 * must resolve every plan before mutating any Native record.
 */
export function resolveEphemeralUtilityStartupTerminal(
  runId: string,
  records: readonly NativeExecutionRecord[],
  events: readonly HarnessEvent[]
): HarnessEvent | null {
  if (!records.length) {
    throw new Error(`Ephemeral utility Native recovery has no records for ${runId}`);
  }
  for (const record of records) {
    assertRecoverableEphemeralUtilityNativeRecord(record);
    if (record.runId !== runId) {
      throw new Error(
        `Ephemeral utility Native record does not match recovery run ${runId}: ${record.id}`
      );
    }
  }
  const sessionIds = new Set(records.map((record) => record.sessionId.trim()));
  const workflows = new Set(records.map((record) => record.workflow));
  const surfaces = new Set(records.map((record) => record.surface));
  const backendIds = new Set(
    records.map((record) => record.native.backendId.trim())
  );
  if (
    sessionIds.size !== 1
    || workflows.size !== 1
    || surfaces.size !== 1
    || backendIds.size !== 1
  ) {
    throw new Error(
      `Ephemeral utility Native records have conflicting authority identity for ${runId}`
    );
  }

  assertRunLedgerSequence(runId, events);
  const created = events.filter((event) => event.type === "run.created");
  if (
    created.length !== 1
    || events[0] !== created[0]
    || created[0].source !== "kernel"
  ) {
    throw new Error(
      `Ephemeral utility Run Ledger must begin with exactly one kernel run.created for ${runId}`
    );
  }
  const started = events.filter((event) => event.type === "run.started");
  if (started.length !== 1 || events[1] !== started[0]) {
    throw new Error(
      `Ephemeral utility Run Ledger must place exactly one run.started immediately after run.created for ${runId}`
    );
  }
  const workflow = workflows.values().next().value as EphemeralUtilityWorkflow;
  const surface = surfaces.values().next().value as HarnessRunRequest["surface"];
  const sessionId = sessionIds.values().next().value as string;
  const startedData = started[0].data;
  if (
    started[0].source !== "kernel"
    || startedData?.workflow !== workflow
    || startedData?.surface !== surface
    || startedData?.sessionId !== sessionId
  ) {
    throw new Error(
      `Ephemeral utility Run Ledger start authority does not match Native records for ${runId}`
    );
  }

  const terminals = events.filter(isRunTerminalEvent);
  if (!terminals.length) return null;
  if (terminals.length !== 1) {
    throw new Error(
      `Ephemeral utility Run Ledger has ambiguous terminal authority for ${runId}`
    );
  }
  const terminal = terminals[0];
  if (
    terminal.sequence <= started[0].sequence
    || events[events.length - 1] !== terminal
  ) {
    throw new Error(
      `Ephemeral utility Run Ledger terminal must follow run.started and be the final event for ${runId}`
    );
  }
  const backendId = backendIds.values().next().value as string;
  if (
    terminal.source !== "kernel"
    || terminal.backendId?.trim() !== backendId
  ) {
    throw new Error(
      `Ephemeral utility Run Ledger terminal authority does not match Native backend for ${runId}`
    );
  }
  return terminal;
}

export function nativeRunOutcomeForUtilityTerminal(
  event: HarnessEvent
): NativeRunOutcome {
  if (event.type === "run.completed") return "success";
  if (event.type === "run.failed") return "failed";
  if (event.type === "run.cancelled") return "cancelled";
  throw new Error(
    `Ephemeral utility Run Ledger event is not terminal: ${event.type}`
  );
}

export function utilityLocalCommit(
  committed: boolean,
  error = ""
): LocalRunCommitResult {
  return {
    committed,
    conversationCommitted: committed,
    runLedgerCommitted: committed,
    artifactsCommitted: committed,
    historyIndexCommitted: committed,
    ...(error ? { error } : {})
  };
}

async function resolveUtilityOutput<T>(
  input: RunEphemeralUtilityInput<T>,
  initial: HarnessRunResult,
  cancellation: EphemeralUtilityCancellationCoordinator
): Promise<EphemeralUtilityValidatedOutput<T>> {
  let result: HarnessRunResult | AgentRunResult = initial;
  if (initial.status === "running") {
    if (!input.awaitResult) {
      throw new EphemeralUtilityExecutionError(
        "Current Agent does not support asynchronous utility result settlement",
        "failed"
      );
    }
    cancellation.throwIfCancelled();
    result = await cancellation.waitFor(input.awaitResult());
  }
  if (result.status === "cancelled") {
    throw new EphemeralUtilityExecutionError(
      result.error || "Utility run was cancelled",
      "cancelled"
    );
  }
  if (result.status !== "completed") {
    throw new EphemeralUtilityExecutionError(
      result.error || "Utility run failed",
      "failed"
    );
  }
  const output = await input.validateOutput(result.outputText ?? "", result);
  cancellation.throwIfCancelled();
  return output;
}

async function commitExactUtilityTerminal(
  host: EphemeralUtilityLifecycleHost,
  input: SettleRunTerminalInput
): Promise<void> {
  const receipt = await host.settleHarnessRunTerminal(input);
  const expectedType = `run.${input.status}`;
  if (
    receipt.runId !== input.runId
    || receipt.source !== "kernel"
    || receipt.type !== expectedType
    || receipt.backendId !== input.backendId
    || receipt.text !== input.text
    || receipt.error !== input.error
    || !sameJsonValue(receipt.data, input.data)
  ) {
    throw new Error(
      `Ephemeral utility Run Ledger terminal receipt mismatch: expected ${expectedType} for ${input.runId}`
    );
  }
}

function createDeferredUtilityResult<T>(
  input: RunDeferredEphemeralUtilityInput<T>,
  value: T,
  recordIds: ReadonlySet<string>
): DeferredEphemeralUtilityResult<T> {
  const exactRecordIds = new Set(recordIds);
  const authority = { ...input.settlement.authority };
  let acceptedReceiptFingerprint = "";
  let finalizationFlight: Promise<EphemeralUtilityFinalizationReceipt> | null =
    null;
  return {
    value,
    authority,
    finalize: async (receipt) => {
      assertExactMemoryTransactionAuthorityReceipt(authority, receipt);
      const receiptFingerprint = JSON.stringify(canonicalJsonValue(receipt));
      if (finalizationFlight) {
        if (receiptFingerprint !== acceptedReceiptFingerprint) {
          throw new Error(
            `Conflicting deferred utility authority receipt for ${input.request.runId}`
          );
        }
        return await finalizationFlight;
      }

      acceptedReceiptFingerprint = receiptFingerprint;
      const acceptedReceipt = JSON.parse(
        JSON.stringify(receipt)
      ) as MemoryTransactionAuthorityReceipt;
      finalizationFlight = (async () => ({
        runId: input.request.runId,
        authority: acceptedReceipt,
        records: await settleAndCleanupUtilityRecords(
          input.host,
          exactRecordIds,
          "success",
          utilityLocalCommit(true),
          input.logLabel ?? input.request.workflow
        )
      }))();
      return await finalizationFlight;
    }
  };
}

function assertExactMemoryTransactionAuthorityReceipt(
  authority: NativeLocalCommitAuthority,
  receipt: MemoryTransactionAuthorityReceipt
): void {
  const source = receipt as unknown as Record<string, unknown>;
  const allowedKeys = new Set([
    "kind",
    "transactionId",
    "state",
    "durable",
    "revision",
    "outcome",
    "error"
  ]);
  if (
    !receipt
    || typeof receipt !== "object"
    || Array.isArray(receipt)
    || Object.keys(source).some((key) => !allowedKeys.has(key))
    || receipt.kind !== authority.kind
    || receipt.transactionId !== authority.transactionId
    || receipt.durable !== true
    || !Number.isSafeInteger(receipt.revision)
    || receipt.revision < 0
  ) {
    throw new Error(
      `Deferred utility authority receipt does not match ${authority.kind}:${authority.transactionId}`
    );
  }
  if (
    (
      receipt.state === "committed"
      && (receipt.outcome === "write" || receipt.outcome === "no-op")
      && !("error" in receipt)
    )
    || (
      receipt.state === "durable-pending"
      && receipt.outcome === "pending"
      && Boolean(receipt.error.trim())
    )
    || (
      receipt.state === "durable-failed"
      && receipt.outcome === "failed"
      && Boolean(receipt.error.trim())
    )
  ) {
    return;
  }
  throw new Error(
    `Deferred utility authority receipt has an invalid durable state for ${authority.transactionId}`
  );
}

async function settleAndCleanupUtilityRecords(
  host: EphemeralUtilityLifecycleHost,
  recordIds: ReadonlySet<string>,
  runOutcome: NativeRunOutcome,
  localCommit: LocalRunCommitResult,
  logLabel: string
): Promise<EphemeralUtilityNativeFinalizationReceipt[]> {
  const receipts: EphemeralUtilityNativeFinalizationReceipt[] = [];
  for (const recordId of Array.from(recordIds).sort()) {
    let settled: NativeExecutionRecord | null;
    try {
      settled = await host.settleNativeExecution({
        recordId,
        runOutcome,
        localCommit
      });
    } catch (error) {
      console.error(`${logLabel} Native settlement remains pending`, error);
      receipts.push({
        recordId,
        settlement: "failed",
        error: errorMessage(error)
      });
      continue;
    }
    if (!settled) {
      console.error(
        `${logLabel} Native settlement receipt is missing for ${recordId}`
      );
      receipts.push({ recordId, settlement: "missing" });
      continue;
    }
    const expectedLocalCommit = localCommit.committed ? "committed" : "failed";
    if (
      settled.runOutcome !== runOutcome
      || settled.localCommit !== expectedLocalCommit
    ) {
      console.error(
        `${logLabel} Native settlement receipt mismatch for ${recordId}`
      );
      receipts.push({
        recordId,
        settlement: "mismatch",
        error: (
          `expected ${runOutcome}/${expectedLocalCommit}, received `
          + `${settled.runOutcome ?? "pending"}/${settled.localCommit}`
        )
      });
      continue;
    }
    if (settled.localCommit !== "committed" || settled.cleanup !== "pending") {
      receipts.push({ recordId, settlement: "settled" });
      continue;
    }
    try {
      const cleanup = await host.cleanupNativeExecutionRecord(recordId);
      if (cleanup.recordId !== recordId) {
        console.error(
          `${logLabel} Native cleanup receipt mismatch for ${recordId}`
        );
        receipts.push({
          recordId,
          settlement: "settled",
          error: (
            `Native cleanup receipt expected ${recordId}, received `
            + `${cleanup.recordId || "<missing-record-id>"}`
          )
        });
        continue;
      }
      receipts.push({
        recordId,
        settlement: "settled",
        cleanup
      });
    } catch (error) {
      console.error(`${logLabel} Native exact cleanup remains pending`, error);
      receipts.push({
        recordId,
        settlement: "settled",
        error: errorMessage(error)
      });
    }
  }
  return receipts;
}

function assertEphemeralUtilityRequest(
  request: HarnessRunRequest & { workflow: EphemeralUtilityWorkflow },
  adapter: AgentAdapter
): void {
  if (
    !request.runId.trim()
    || !request.sessionId.trim()
    || request.surface !== EPHEMERAL_UTILITY_SURFACES[request.workflow]
    || request.backendId !== adapter.manifest.id
  ) {
    throw new Error(
      `Invalid ephemeral utility lifecycle request: ${request.workflow}/${request.runId || "<missing-run-id>"}`
    );
  }
}

function assertEphemeralUtilitySettlement<T>(
  input: RunEphemeralUtilityInput<T>
): void {
  if (input.request.workflow === "memory.curate") {
    if (
      input.settlement?.mode !== "deferred"
      || input.settlement.authority.kind !== "memory-transaction"
      || !input.settlement.authority.transactionId.trim()
    ) {
      throw new Error(
        `Memory Curator requires deferred Memory transaction authority: ${input.request.runId}`
      );
    }
    return;
  }
  if (input.settlement?.mode === "deferred") {
    throw new Error(
      `Deferred utility settlement is not supported for ${input.request.workflow}`
    );
  }
}

function assertRegistrationRequest(
  expected: HarnessRunRequest,
  actual: HarnessRunRequest,
  native: NativeExecutionRef
): void {
  if (
    actual.runId !== expected.runId
    || actual.sessionId !== expected.sessionId
    || actual.surface !== expected.surface
    || actual.workflow !== expected.workflow
    || actual.backendId !== expected.backendId
    || native.backendId !== expected.backendId
    || !native.id.trim()
  ) {
    throw new Error(
      `Ephemeral utility Native registration identity mismatch for ${expected.runId}`
    );
  }
}

function ephemeralUtilityNativeRecord(
  request: HarnessRunRequest & { workflow: EphemeralUtilityWorkflow },
  native: NativeExecutionRef,
  localCommitAuthority?: NativeLocalCommitAuthority
): NativeExecutionRecord {
  const createdAt = native.createdAt || Date.now();
  return {
    id: ephemeralUtilityNativeRecordId(request.runId, native),
    runId: request.runId,
    sessionId: request.sessionId,
    surface: request.surface,
    workflow: request.workflow,
    native,
    ...(localCommitAuthority ? { localCommitAuthority } : {}),
    policy: {
      historyAuthority: "echoink",
      mode: "ephemeral-run",
      preferredDisposition: ["delete", "archive", "process-exit", "retain"],
      retainWhenLocalCommitFails: true,
      cleanupRequiredForTaskSuccess: false
    },
    localCommit: "pending",
    cleanup: "not-needed",
    attempts: 0,
    nextAttemptAt: 0,
    lastError: "",
    createdAt,
    settledAt: 0,
    committedAt: 0,
    disposedAt: 0
  };
}

function ephemeralUtilityNativeRecordId(
  runId: string,
  native: NativeExecutionRef
): string {
  const identity = JSON.stringify([
    native.backendId,
    native.id,
    native.kind,
    native.providerEndpoint ?? null,
    native.deviceKey,
    native.vaultId
  ]);
  const digest = createHash("sha256").update(identity).digest("hex").slice(0, 16);
  return `utility-native:${runId}:${native.backendId}:${digest}`;
}

function assertRunLedgerSequence(
  runId: string,
  events: readonly HarnessEvent[]
): void {
  const eventIds = new Set<string>();
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (
      event.runId !== runId
      || !event.eventId?.trim()
      || !Number.isSafeInteger(event.sequence)
      || event.sequence !== index + 1
      || !Number.isFinite(event.createdAt)
      || event.createdAt < 0
      || typeof event.type !== "string"
      || typeof event.source !== "string"
      || eventIds.has(event.eventId)
    ) {
      throw new Error(
        `Ephemeral utility Run Ledger has an invalid event sequence or identity for ${runId}`
      );
    }
    eventIds.add(event.eventId);
  }
}

function isRunTerminalEvent(event: HarnessEvent): boolean {
  return event.type === "run.completed"
    || event.type === "run.failed"
    || event.type === "run.cancelled";
}

function utilityRunOutcome(
  error: unknown,
  isCancellation: RunEphemeralUtilityInput<unknown>["isCancellation"]
): Exclude<NativeRunOutcome, "success"> {
  if (error instanceof EphemeralUtilityExecutionError) return error.runOutcome;
  return isCancellation?.(error) ? "cancelled" : "failed";
}

function sameJsonValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonicalJsonValue(left))
    === JSON.stringify(canonicalJsonValue(right));
}

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalJsonValue(entry)])
  );
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function errorMessage(error: unknown): string {
  return normalizeError(error).message;
}
