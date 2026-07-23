import { randomUUID } from "node:crypto";
import { NativeRunRegistrationError } from "../../../agent/types";
import { noCapabilities } from "../../contracts/capability";
import type { HarnessEventSink } from "../../contracts/event";
import {
  ECHOINK_HOST_EXECUTION_BACKEND_ID,
  HERMES_PROPOSAL_HOST_TRANSPORT,
  type EchoInkHostProcessDispositionReceipt,
  type NativeExecutionRef
} from "../../contracts/native-execution";
import type {
  AgentAdapter,
  AgentConnectContext,
  AgentConnectionStatus,
  AgentManifest,
  AgentRunRequest,
  AgentRunResult
} from "../adapter";

export interface HermesProposalHostExecutionInput {
  request: AgentRunRequest;
  native: NativeExecutionRef;
  abortSignal: AbortSignal;
  recordProcessDisposition(
    state: EchoInkHostProcessDispositionReceipt["state"],
    observedAt?: number
  ): Promise<EchoInkHostProcessDispositionReceipt>;
}

export interface HermesProposalHostExecutionResult {
  text: string;
  terminalData?: Record<string, unknown>;
}

export interface HermesProposalHostAgentAdapterOptions {
  attemptId: string;
  modelId: string;
  externalAbortSignal?: AbortSignal;
  nativeRefContext: Pick<
    NativeExecutionRef,
    "deviceKey" | "vaultId" | "providerEndpoint"
  >;
  execute(
    input: HermesProposalHostExecutionInput
  ): Promise<HermesProposalHostExecutionResult>;
  persistProcessDisposition(input: {
    native: NativeExecutionRef;
    receipt: EchoInkHostProcessDispositionReceipt;
  }): Promise<void>;
  isCancellation(error: unknown, signal: AbortSignal): boolean;
}

class HermesProposalHostDispositionPersistenceError
  extends NativeRunRegistrationError {
  constructor(cause: unknown) {
    super(
      "Hermes proposal host process disposition could not be durably recorded",
      cause
    );
    this.name = "HermesProposalHostDispositionPersistenceError";
  }
}

class HermesProposalHostDispositionAuthorityError
  extends NativeRunRegistrationError {
  constructor(message: string) {
    super(message);
    this.name = "HermesProposalHostDispositionAuthorityError";
  }
}

/**
 * Formal Harness adapter for the audited Hermes proposal transport.
 *
 * Hermes 0.18.0 does not expose a backend-owned session/run identity before
 * `chat -q <prompt>` is submitted. The adapter therefore registers a
 * separately named EchoInk host-process identity first. It never turns the
 * Harness run ID, write-fence lease, or attempt ID into a fake Hermes ID.
 */
export class HermesProposalHostAgentAdapter implements AgentAdapter {
  readonly manifest: AgentManifest = {
    id: "hermes",
    displayName: "Hermes",
    version: HERMES_PROPOSAL_HOST_TRANSPORT,
    capabilities: {
      ...noCapabilities(),
      input: { text: "native", image: "none", pdf: "none" },
      cancellation: "native"
    },
    nativeExecution: {
      persistence: "process-local",
      dispositions: {
        processExit: true,
        archive: false,
        delete: false
      },
      idempotentDisposition: true,
      canInspectExistence: false
    }
  };

  private readonly activeControllers = new Map<string, AbortController>();

  constructor(private readonly options: HermesProposalHostAgentAdapterOptions) {}

  async connect(_context: AgentConnectContext): Promise<AgentConnectionStatus> {
    return {
      connected: true,
      label: "Hermes proposal host transport",
      version: HERMES_PROPOSAL_HOST_TRANSPORT,
      errors: []
    };
  }

  async dispose(): Promise<void> {
    for (const controller of this.activeControllers.values()) {
      controller.abort("adapter-disposed");
    }
    this.activeControllers.clear();
  }

  async listModels(): Promise<Array<{ id: string; displayName: string }>> {
    const modelId = this.options.modelId.trim();
    return modelId ? [{ id: modelId, displayName: modelId }] : [];
  }

  async run(
    request: AgentRunRequest,
    emit: HarnessEventSink
  ): Promise<AgentRunResult> {
    const controller = new AbortController();
    const forwardExternalAbort = () => controller.abort(
      this.options.externalAbortSignal?.reason ?? "external-cancel"
    );
    if (this.options.externalAbortSignal?.aborted) {
      forwardExternalAbort();
    } else {
      this.options.externalAbortSignal?.addEventListener(
        "abort",
        forwardExternalAbort,
        { once: true }
      );
    }
    this.activeControllers.set(request.runId, controller);
    const native = createHermesProposalHostExecutionRef({
      attemptId: this.options.attemptId,
      nativeRefContext: this.options.nativeRefContext
    });
    let observedDisposition:
      EchoInkHostProcessDispositionReceipt | undefined;
    let dispositionFlight:
      Promise<EchoInkHostProcessDispositionReceipt> | null = null;
    const recordProcessDisposition = async (
      state: EchoInkHostProcessDispositionReceipt["state"],
      observedAt = Date.now()
    ): Promise<EchoInkHostProcessDispositionReceipt> => {
      if (observedDisposition) {
        if (observedDisposition.state !== state) {
          throw new NativeRunRegistrationError(
            "Hermes proposal host process returned conflicting disposition observations"
          );
        }
        return observedDisposition;
      }
      if (dispositionFlight) {
        const current = await dispositionFlight;
        if (current.state !== state) {
          throw new NativeRunRegistrationError(
            "Hermes proposal host process returned conflicting disposition observations"
          );
        }
        return current;
      }
      const flight = (async () => {
        const receipt = createHermesProposalHostProcessDispositionReceipt({
          native,
          state,
          observedAt
        });
        try {
          await this.options.persistProcessDisposition({ native, receipt });
        } catch (error) {
          throw new HermesProposalHostDispositionPersistenceError(error);
        }
        observedDisposition = receipt;
        return receipt;
      })();
      dispositionFlight = flight;
      try {
        return await flight;
      } finally {
        if (dispositionFlight === flight) dispositionFlight = null;
      }
    };
    try {
      if (!request.registerNativeExecution) {
        throw new NativeRunRegistrationError(
          "Hermes proposal requires durable EchoInk host-execution registration before prompt submission"
        );
      }
      await request.registerNativeExecution(native);
      await emit({
        eventId: "",
        runId: request.runId,
        sequence: 0,
        createdAt: 0,
        source: "agent",
        type: "agent.native_execution.created",
        backendId: "hermes",
        data: {
          nativeExecutionId: native.id,
          nativeExecutionKind: native.kind,
          nativeExecutionPersistence: native.persistence,
          identityAuthority: native.identityAuthority,
          identityOwner: native.hostExecution?.owner,
          targetBackendId: native.hostExecution?.targetBackendId,
          transport: native.hostExecution?.transport,
          attemptId: native.hostExecution?.attemptId,
          backendNativeIdentity: native.hostExecution?.backendNativeIdentity
        }
      });
      const result = await this.options.execute({
        request,
        native,
        abortSignal: controller.signal,
        recordProcessDisposition
      });
      if (!observedDisposition) {
        throw new HermesProposalHostDispositionAuthorityError(
          "Hermes proposal host process completed without durable disposition authority"
        );
      }
      if (observedDisposition.state !== "exited") {
        throw new HermesProposalHostDispositionAuthorityError(
          `Hermes proposal host process cannot complete with a durable ${observedDisposition.state} disposition`
        );
      }
      return {
        status: "completed",
        outputText: result.text,
        terminalData: {
          ...result.terminalData,
          hostExecutionId: native.id,
          identityAuthority: native.identityAuthority,
          backendNativeIdentity: native.hostExecution?.backendNativeIdentity,
          hostProcessDisposition: observedDisposition.state,
          hostProcessDispositionObservedAt: observedDisposition.observedAt
        }
      };
    } catch (error) {
      if (
        error instanceof HermesProposalHostDispositionPersistenceError
        || error instanceof HermesProposalHostDispositionAuthorityError
      ) {
        throw error;
      }
      if (this.options.isCancellation(error, controller.signal)) {
        return {
          status: "cancelled",
          error: error instanceof Error ? error.message : String(error)
        };
      }
      throw error;
    } finally {
      this.options.externalAbortSignal?.removeEventListener(
        "abort",
        forwardExternalAbort
      );
      if (this.activeControllers.get(request.runId) === controller) {
        this.activeControllers.delete(request.runId);
      }
    }
  }

  async cancel(runId: string): Promise<void> {
    this.activeControllers.get(runId)?.abort("run-cancelled");
  }
}

function createHermesProposalHostProcessDispositionReceipt(input: {
  native: NativeExecutionRef;
  state: EchoInkHostProcessDispositionReceipt["state"];
  observedAt: number;
}): EchoInkHostProcessDispositionReceipt {
  if (
    !Number.isSafeInteger(input.observedAt)
    || input.observedAt < input.native.createdAt
  ) {
    throw new NativeRunRegistrationError(
      "Hermes proposal host process disposition has an invalid observation time"
    );
  }
  return {
    version: 1,
    owner: "echoink-host",
    executionId: input.native.id,
    disposition: "process-exit",
    state: input.state,
    observedAt: input.observedAt
  };
}

function createHermesProposalHostExecutionRef(input: {
  attemptId: string;
  nativeRefContext: Pick<
    NativeExecutionRef,
    "deviceKey" | "vaultId" | "providerEndpoint"
  >;
}): NativeExecutionRef {
  const attemptId = input.attemptId.trim();
  if (!attemptId) {
    throw new NativeRunRegistrationError(
      "Hermes proposal host execution requires an attempt identity"
    );
  }
  const createdAt = Date.now();
  const executionId = `echoink-host-process:${randomUUID()}`;
  return {
    backendId: ECHOINK_HOST_EXECUTION_BACKEND_ID,
    id: executionId,
    kind: "process",
    persistence: "process-local",
    identityAuthority: "echoink-host",
    hostExecution: {
      version: 1,
      owner: "echoink-host",
      executionId,
      targetBackendId: "hermes",
      transport: HERMES_PROPOSAL_HOST_TRANSPORT,
      attemptId,
      backendNativeIdentity: "unavailable-before-prompt",
      createdAt
    },
    ...input.nativeRefContext,
    createdAt
  };
}
