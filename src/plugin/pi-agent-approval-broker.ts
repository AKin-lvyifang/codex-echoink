export type PiAgentApprovalDecision = "approve" | "reject";

export interface PiAgentApprovalIdentity {
  readonly conversationId: string;
  readonly piSessionId: string;
  readonly productRunId: string;
  readonly toolCallId: string;
}

export type PiAgentApprovalRunIdentity = Omit<
  PiAgentApprovalIdentity,
  "toolCallId"
>;

export interface PiAgentApprovalWaitInput extends PiAgentApprovalIdentity {
  /** Opaque live-request identity. It is never exposed to ChatMessage or DOM. */
  readonly requestId: string;
  readonly target: string;
  readonly preview: string;
  readonly deleteAction?: boolean;
  readonly signal?: AbortSignal;
}

export interface PiAgentApprovalDecisionBinding {
  readonly target: string;
  readonly preview: string;
  readonly deleteAction?: boolean;
  decide(decision: PiAgentApprovalDecision): boolean;
}

export interface PiAgentApprovalSubscription {
  unsubscribe(): void;
}

interface ApprovalWaiter extends PiAgentApprovalIdentity {
  readonly requestId: string;
  readonly key: string;
  readonly target: string;
  readonly preview: string;
  readonly deleteAction?: boolean;
  readonly resolve: (accepted: boolean) => void;
  readonly reject: (error: Error) => void;
  readonly signal?: AbortSignal;
  readonly onAbort?: () => void;
}

interface ApprovalListener {
  readonly runKey: string;
  readonly listener: () => void;
}

/**
 * Runtime-owned live Promise broker for Pi Agent approvals.
 *
 * Durable Ticket state remains authoritative. This broker keeps no decision
 * history and removes a waiter before resolving the existing confirmation
 * Promise, so stale or repeated decisions cannot reach another request.
 */
export class PiAgentApprovalBroker {
  private readonly waitersByRequest = new Map<string, ApprovalWaiter>();
  private readonly waitersByIdentity = new Map<string, ApprovalWaiter>();
  private readonly listeners = new Set<ApprovalListener>();
  private disposed = false;

  constructor(private readonly onWaiting?: (input: Readonly<PiAgentApprovalWaitInput>, waiting: boolean) => void | Promise<void>) {}

  waitForDecision(input: Readonly<PiAgentApprovalWaitInput>): Promise<boolean> {
    const identity = normalizeIdentity(input);
    const requestId = requiredIdentity(input.requestId, "requestId");
    const key = identityKey(identity);
    if (this.disposed) {
      return Promise.reject(new Error("pi_agent_approval_broker_disposed"));
    }
    if (this.waitersByRequest.has(requestId) || this.waitersByIdentity.has(key)) {
      return Promise.reject(new Error("pi_agent_approval_waiter_conflict"));
    }
    if (input.signal?.aborted) {
      return Promise.reject(new Error("pi_agent_approval_cancelled"));
    }

    const pending = new Promise<boolean>((resolve, reject) => {
      let waiter!: ApprovalWaiter;
      const onAbort = input.signal
        ? () => this.cancelWaiter(waiter)
        : undefined;
      waiter = {
        ...identity,
        requestId,
        key,
        target: input.target.trim(),
        preview: input.preview.trim(),
        ...(input.deleteAction === true ? { deleteAction: true } : {}),
        resolve,
        reject,
        ...(input.signal ? { signal: input.signal } : {}),
        ...(onAbort ? { onAbort } : {})
      };
      if (input.signal && onAbort) {
        input.signal.addEventListener("abort", onAbort, { once: true });
      }
      this.waitersByRequest.set(requestId, waiter);
      this.waitersByIdentity.set(key, waiter);
      this.notify(runIdentityKey(waiter));
    });
    if (!this.onWaiting) return pending;
    void pending.catch(() => undefined);
    // Every approval wrapper, including cancellation/disposal, uses this bridge.
    // Install the live waiter synchronously so existing decision bindings stay valid.
    return Promise.resolve(this.onWaiting(input, true)).then(() => pending).finally(() => this.onWaiting?.(input, false));
  }

  bindingFor(
    input: Readonly<PiAgentApprovalIdentity>
  ): PiAgentApprovalDecisionBinding | null {
    if (this.disposed) return null;
    const identity = normalizeIdentity(input);
    const waiter = this.waitersByIdentity.get(identityKey(identity));
    if (!waiter || !sameIdentity(waiter, identity)) return null;
    return Object.freeze({
      target: waiter.target,
      preview: waiter.preview,
      ...(waiter.deleteAction === true ? { deleteAction: true } : {}),
      decide: (decision: PiAgentApprovalDecision) =>
        this.decide(waiter, decision)
    });
  }

  subscribeRun(
    input: Readonly<PiAgentApprovalRunIdentity>,
    listener: () => void
  ): PiAgentApprovalSubscription {
    const runKey = runIdentityKey(normalizeRunIdentity(input));
    const entry: ApprovalListener = { runKey, listener };
    if (!this.disposed) {
      this.listeners.add(entry);
      if ([...this.waitersByIdentity.values()].some(
        (waiter) => runIdentityKey(waiter) === runKey
      )) this.callListener(listener);
    }
    let active = true;
    return Object.freeze({
      unsubscribe: () => {
        if (!active) return;
        active = false;
        this.listeners.delete(entry);
      }
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const waiter of [...this.waitersByRequest.values()]) {
      this.removeWaiter(waiter);
      waiter.reject(new Error("pi_agent_approval_broker_disposed"));
    }
    this.listeners.clear();
  }

  private decide(
    waiter: ApprovalWaiter,
    decision: PiAgentApprovalDecision
  ): boolean {
    if (this.disposed || (decision !== "approve" && decision !== "reject")) {
      return false;
    }
    if (
      this.waitersByRequest.get(waiter.requestId) !== waiter
      || this.waitersByIdentity.get(waiter.key) !== waiter
    ) return false;
    this.removeWaiter(waiter);
    waiter.resolve(decision === "approve");
    return true;
  }

  private cancelWaiter(waiter: ApprovalWaiter): void {
    if (this.waitersByRequest.get(waiter.requestId) !== waiter) return;
    this.removeWaiter(waiter);
    waiter.reject(new Error("pi_agent_approval_cancelled"));
  }

  private removeWaiter(waiter: ApprovalWaiter): void {
    this.waitersByRequest.delete(waiter.requestId);
    if (this.waitersByIdentity.get(waiter.key) === waiter) {
      this.waitersByIdentity.delete(waiter.key);
    }
    if (waiter.signal && waiter.onAbort) {
      waiter.signal.removeEventListener("abort", waiter.onAbort);
    }
    this.notify(runIdentityKey(waiter));
  }

  private notify(runKey: string): void {
    for (const entry of this.listeners) {
      if (entry.runKey === runKey) this.callListener(entry.listener);
    }
  }

  private callListener(listener: () => void): void {
    try {
      listener();
    } catch {
      // UI refresh is advisory; it cannot change the live approval decision.
    }
  }
}

function normalizeIdentity(
  input: Readonly<PiAgentApprovalIdentity>
): PiAgentApprovalIdentity {
  return Object.freeze({
    conversationId: requiredIdentity(input.conversationId, "conversationId"),
    piSessionId: requiredIdentity(input.piSessionId, "piSessionId"),
    productRunId: requiredIdentity(input.productRunId, "productRunId"),
    toolCallId: requiredIdentity(input.toolCallId, "toolCallId")
  });
}

function normalizeRunIdentity(
  input: Readonly<PiAgentApprovalRunIdentity>
): PiAgentApprovalRunIdentity {
  return Object.freeze({
    conversationId: requiredIdentity(input.conversationId, "conversationId"),
    piSessionId: requiredIdentity(input.piSessionId, "piSessionId"),
    productRunId: requiredIdentity(input.productRunId, "productRunId")
  });
}

function requiredIdentity(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new TypeError(`pi_agent_approval_${label}_invalid`);
  return normalized;
}

function identityKey(identity: Readonly<PiAgentApprovalIdentity>): string {
  return [
    identity.conversationId,
    identity.piSessionId,
    identity.productRunId,
    identity.toolCallId
  ].join("\u0000");
}

function runIdentityKey(identity: Readonly<PiAgentApprovalRunIdentity>): string {
  return [
    identity.conversationId,
    identity.piSessionId,
    identity.productRunId
  ].join("\u0000");
}

function sameIdentity(
  left: Readonly<PiAgentApprovalIdentity>,
  right: Readonly<PiAgentApprovalIdentity>
): boolean {
  return left.conversationId === right.conversationId
    && left.piSessionId === right.piSessionId
    && left.productRunId === right.productRunId
    && left.toolCallId === right.toolCallId;
}
