import type { AgentBackendKind } from "../agent/types";

const NATIVE_TERMINATION_TOKEN = Symbol("knowledge-agent-native-termination");
const issuedNativeTerminationReceipts = new WeakSet<KnowledgeAgentNativeTerminationReceipt>();

export type KnowledgeAgentNativeTerminationKind =
  | "abort-ack"
  | "interrupt-ack";

/**
 * Nominal in-process proof that a backend transport acknowledged termination
 * for one concrete native execution. A timestamp copied from an arbitrary
 * Error is deliberately insufficient.
 */
export class KnowledgeAgentNativeTerminationReceipt {
  readonly terminated = true;

  constructor(
    token: typeof NATIVE_TERMINATION_TOKEN,
    readonly backend: AgentBackendKind,
    readonly harnessRunId: string,
    readonly nativeExecutionId: string,
    readonly kind: KnowledgeAgentNativeTerminationKind,
    readonly confirmedAt: number
  ) {
    if (token !== NATIVE_TERMINATION_TOKEN) {
      throw new Error("Knowledge Agent native termination receipt cannot be constructed externally");
    }
  }
}

export function issueKnowledgeAgentNativeTerminationReceipt(input: {
  backend: AgentBackendKind;
  harnessRunId: string;
  nativeExecutionId: string;
  kind: KnowledgeAgentNativeTerminationKind;
  confirmedAt?: number;
}): KnowledgeAgentNativeTerminationReceipt {
  const harnessRunId = boundedIdentifier(input.harnessRunId, "harness run");
  const nativeExecutionId = boundedIdentifier(input.nativeExecutionId, "native execution");
  const confirmedAt = input.confirmedAt ?? Date.now();
  if (!Number.isFinite(confirmedAt) || confirmedAt <= 0) {
    throw new Error("Knowledge Agent native termination receipt requires a valid confirmation time");
  }
  const receipt = Object.freeze(new KnowledgeAgentNativeTerminationReceipt(
    NATIVE_TERMINATION_TOKEN,
    input.backend,
    harnessRunId,
    nativeExecutionId,
    input.kind,
    confirmedAt
  ));
  issuedNativeTerminationReceipts.add(receipt);
  return receipt;
}

export function isTrustedKnowledgeAgentNativeTerminationReceipt(
  value: unknown
): value is KnowledgeAgentNativeTerminationReceipt {
  return value instanceof KnowledgeAgentNativeTerminationReceipt
    && issuedNativeTerminationReceipts.has(value)
    && Object.isFrozen(value)
    && value.terminated === true
    && Boolean(value.harnessRunId)
    && Boolean(value.nativeExecutionId)
    && (value.kind === "abort-ack" || value.kind === "interrupt-ack")
    && Number.isFinite(value.confirmedAt)
    && value.confirmedAt > 0;
}

export function nativeTerminationReceiptFrom(
  value: unknown
): KnowledgeAgentNativeTerminationReceipt | undefined {
  if (!value || typeof value !== "object") return undefined;
  const receipt = (value as { nativeTerminationReceipt?: unknown }).nativeTerminationReceipt;
  return isTrustedKnowledgeAgentNativeTerminationReceipt(receipt) ? receipt : undefined;
}

export function codexNativeExecutionId(threadId: string, turnId: string): string {
  return JSON.stringify([
    boundedIdentifier(threadId, "Codex thread"),
    boundedIdentifier(turnId, "Codex turn")
  ]);
}

function boundedIdentifier(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 2_000 || /[\0-\x1f\x7f]/.test(normalized)) {
    throw new Error(`Knowledge Agent ${label} id is invalid`);
  }
  return normalized;
}
