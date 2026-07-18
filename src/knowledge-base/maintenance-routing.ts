import { AGENT_BACKEND_DEFINITIONS } from "../agent/registry";
import { isTrustedExactWriteFenceReceipt } from "../agent/write-fence";
import type { AgentBackendKind, AgentExactWriteFenceReceipt } from "../agent/types";
import {
  isTrustedMaintenanceShadowQuarantineReceipt,
  isTrustedMaintenanceShadowZeroResultAttestation,
  maintenanceExactWriteFenceBindingDigest,
  type MaintenanceShadowQuarantineReceipt,
  type MaintenanceShadowZeroResultAttestation
} from "../harness/maintenance/shadow-vault";
import {
  isTrustedKnowledgeAgentNativeTerminationReceipt,
  type KnowledgeAgentNativeTerminationReceipt
} from "./native-termination";

export const MAINTENANCE_FAILOVER_GATE = "S1_PRE_AGENT" as const;
export const MAINTENANCE_POST_START_FAILOVER_GATE = "S2_POST_START_ZERO_RESULT" as const;
export type MaintenanceFailoverGate =
  | typeof MAINTENANCE_FAILOVER_GATE
  | typeof MAINTENANCE_POST_START_FAILOVER_GATE;

export type MaintenanceAttemptPhase =
  | "preflight"
  | "execution"
  | "verification"
  | "commit"
  | "cleanup";

export type MaintenanceFailureCategory =
  | "backend-unavailable"
  | "authentication-required"
  | "isolation-unavailable"
  | "transport-unavailable"
  | "timeout"
  | "cancelled"
  | "policy-denied"
  | "raw-integrity"
  | "unsafe-vault"
  | "evidence-invalid"
  | "commit-conflict"
  | "storage-failure"
  | "unknown";

export interface MaintenanceFailureClassification {
  phase: MaintenanceAttemptPhase;
  category: MaintenanceFailureCategory;
  code: string;
  message: string;
  /** Infrastructure category may be retried only if its phase-specific gate is also satisfied. */
  retryable: boolean;
  failoverEligible: boolean;
  failoverGate: MaintenanceFailoverGate | null;
}

export interface ClassifyMaintenanceFailureInput {
  phase: MaintenanceAttemptPhase;
  error: unknown;
  /** True once an Agent request may have started, even if no native run id was observed. */
  agentStarted?: boolean;
  /** Defensive boundary for writes observed outside the Agent lifecycle. */
  vaultMutationObserved?: boolean;
}

export interface MaintenanceRoutingWorkflow {
  workflowId: string;
  selectedBackend: AgentBackendKind;
  /** Stable, selected-first rotation of AGENT_BACKEND_DEFINITIONS. */
  candidateBackends: readonly AgentBackendKind[];
  /** Backends already attempted or inspected for readiness in this workflow. */
  visitedBackends: readonly AgentBackendKind[];
  /** Backends for which a real attempt was started. */
  attemptedBackends: readonly AgentBackendKind[];
  attemptCount: number;
}

export interface MaintenanceRoutingAttempt {
  workflowId: string;
  attemptId: string;
  ordinal: number;
  backend: AgentBackendKind;
}

const SAME_LEASE_TERMINATION_TOKEN = Symbol("maintenance-same-lease-termination");
const issuedSameLeaseTerminationReceipts = new WeakSet<MaintenanceSameLeaseTerminationReceipt>();

/**
 * Nominal Service-issued proof that the native execution bound to an exact
 * write-fence lease is no longer able to mutate its Shadow.
 */
export class MaintenanceSameLeaseTerminationReceipt {
  readonly terminated = true;

  constructor(
    token: typeof SAME_LEASE_TERMINATION_TOKEN,
    readonly attemptId: string,
    readonly backend: AgentBackendKind,
    readonly leaseToken: string,
    readonly writeFenceConfigAckDigest: string,
    readonly nativeExecutionId: string,
    readonly terminatedAt: number
  ) {
    if (token !== SAME_LEASE_TERMINATION_TOKEN) {
      throw new Error("Maintenance same-lease termination receipt cannot be constructed externally");
    }
  }
}

export function issueMaintenanceSameLeaseTerminationReceipt(input: {
  attempt: MaintenanceRoutingAttempt;
  writeFenceReceipt: AgentExactWriteFenceReceipt;
  harnessRunId: string;
  nativeTerminationReceipt: KnowledgeAgentNativeTerminationReceipt;
}): MaintenanceSameLeaseTerminationReceipt {
  if (!isTrustedExactWriteFenceReceipt(input.writeFenceReceipt)) {
    throw new Error("Maintenance termination requires a trusted exact-write-fence receipt");
  }
  if (!isTrustedKnowledgeAgentNativeTerminationReceipt(input.nativeTerminationReceipt)) {
    throw new Error("Maintenance termination requires a trusted native termination acknowledgement");
  }
  assertWriteFenceMatchesAttempt(input.attempt, input.writeFenceReceipt);
  const harnessRunId = input.harnessRunId.trim();
  if (
    !harnessRunId
    || input.nativeTerminationReceipt.harnessRunId !== harnessRunId
    || input.nativeTerminationReceipt.backend !== input.attempt.backend
  ) {
    throw new Error("Maintenance termination acknowledgement does not match the current Harness run/backend");
  }
  const nativeExecutionId = input.nativeTerminationReceipt.nativeExecutionId;
  const terminatedAt = input.nativeTerminationReceipt.confirmedAt;
  const configuredAt = Date.parse(input.writeFenceReceipt.configuredAt);
  if (!Number.isFinite(terminatedAt) || terminatedAt <= 0 || terminatedAt < configuredAt) {
    throw new Error("Maintenance termination predates the exact write-fence lease");
  }
  const receipt = Object.freeze(new MaintenanceSameLeaseTerminationReceipt(
    SAME_LEASE_TERMINATION_TOKEN,
    input.attempt.attemptId,
    input.attempt.backend,
    input.writeFenceReceipt.leaseToken,
    input.writeFenceReceipt.configAckDigest,
    nativeExecutionId,
    terminatedAt
  ));
  issuedSameLeaseTerminationReceipts.add(receipt);
  return receipt;
}

export function isTrustedMaintenanceSameLeaseTerminationReceipt(
  value: unknown
): value is MaintenanceSameLeaseTerminationReceipt {
  return value instanceof MaintenanceSameLeaseTerminationReceipt
    && issuedSameLeaseTerminationReceipts.has(value)
    && value.terminated === true;
}

const S2_FAILOVER_PROOF_TOKEN = Symbol("maintenance-s2-failover-proof");
const issuedS2FailoverProofs = new WeakSet<MaintenanceS2FailoverProof>();

/**
 * In-process capability for the conservative post-start failover gate. It is
 * issued only after exact fence, durable quarantine and zero-result receipts
 * agree on attempt, backend, lease and all sealed/revoked digests.
 */
export class MaintenanceS2FailoverProof {
  readonly gate = MAINTENANCE_POST_START_FAILOVER_GATE;
  readonly exactWriteFenceConfirmed = true;
  readonly nativeTerminationConfirmed = true;
  readonly shadowQuarantineConfirmed = true;
  readonly commitAuthorityRevoked = true;
  readonly cleanupAuthorityRevoked = true;
  readonly sealedShadowZeroResult = true;
  readonly noCommitIntent = true;

  constructor(
    token: typeof S2_FAILOVER_PROOF_TOKEN,
    readonly attemptId: string,
    readonly backend: AgentBackendKind,
    readonly leaseToken: string,
    readonly writeFenceConfigAckDigest: string,
    readonly exactWriteFenceBindingDigest: string,
    readonly shadowQuarantineRecordDigest: string,
    readonly abandonedManifestDigest: string,
    readonly shadowZeroResultDigest: string,
    readonly nativeExecutionId: string,
    readonly nativeTerminatedAt: number,
    readonly issuedAt: number
  ) {
    if (token !== S2_FAILOVER_PROOF_TOKEN) {
      throw new Error("Maintenance S2 failover proof cannot be constructed externally");
    }
  }
}

export function createMaintenanceS2FailoverProof(input: {
  attempt: MaintenanceRoutingAttempt;
  writeFenceReceipt: AgentExactWriteFenceReceipt;
  sameLeaseTerminationReceipt: MaintenanceSameLeaseTerminationReceipt;
  quarantineReceipt: MaintenanceShadowQuarantineReceipt;
  zeroResultAttestation: MaintenanceShadowZeroResultAttestation;
}): MaintenanceS2FailoverProof {
  if (!isTrustedExactWriteFenceReceipt(input.writeFenceReceipt)) {
    throw new Error("Maintenance S2 requires a trusted exact-write-fence receipt");
  }
  if (!isTrustedMaintenanceShadowQuarantineReceipt(input.quarantineReceipt)) {
    throw new Error("Maintenance S2 requires a nominal durable Shadow quarantine receipt");
  }
  if (!isTrustedMaintenanceShadowZeroResultAttestation(input.zeroResultAttestation)) {
    throw new Error("Maintenance S2 requires a nominal Shadow zero-result attestation");
  }
  if (!isTrustedMaintenanceSameLeaseTerminationReceipt(input.sameLeaseTerminationReceipt)) {
    throw new Error("Maintenance S2 requires a trusted same-lease native termination receipt");
  }
  assertWriteFenceMatchesAttempt(input.attempt, input.writeFenceReceipt);
  if (
    input.sameLeaseTerminationReceipt.attemptId !== input.attempt.attemptId
    || input.sameLeaseTerminationReceipt.backend !== input.attempt.backend
    || input.sameLeaseTerminationReceipt.leaseToken !== input.writeFenceReceipt.leaseToken
    || input.sameLeaseTerminationReceipt.writeFenceConfigAckDigest !== input.writeFenceReceipt.configAckDigest
  ) {
    throw new Error("Maintenance S2 native termination does not bind the same lease and attempt");
  }
  if (
    input.quarantineReceipt.attemptId !== input.attempt.attemptId
    || input.quarantineReceipt.backend !== input.attempt.backend
    || input.quarantineReceipt.leaseToken !== input.writeFenceReceipt.leaseToken
    || input.quarantineReceipt.writeFenceConfigAckDigest !== input.writeFenceReceipt.configAckDigest
    || input.quarantineReceipt.exactWriteFenceBindingDigest
      !== maintenanceExactWriteFenceBindingDigest(input.writeFenceReceipt)
    || input.quarantineReceipt.commitAuthorityRevoked !== true
    || input.quarantineReceipt.cleanupAuthorityRevoked !== true
    || input.quarantineReceipt.durableReadBack !== true
  ) {
    throw new Error("Maintenance S2 receipts do not bind the same lease and attempt");
  }
  if (
    input.zeroResultAttestation.attemptId !== input.attempt.attemptId
    || input.zeroResultAttestation.sealed !== true
    || input.zeroResultAttestation.zeroCommittable !== true
    || input.zeroResultAttestation.zeroRecoverable !== true
    || input.zeroResultAttestation.noCommitIntent !== true
    || input.zeroResultAttestation.writeFenceVerified !== true
  ) {
    throw new Error("Maintenance S2 Shadow attestation is not a sealed zero-result/no-commit proof");
  }
  if (
    input.quarantineReceipt.sealedManifestDigest !== input.zeroResultAttestation.manifestDigest
    || input.quarantineReceipt.changeSetDigest !== input.zeroResultAttestation.changeSetDigest
    || input.quarantineReceipt.zeroResultDigest !== input.zeroResultAttestation.digest
  ) {
    throw new Error("Maintenance S2 quarantine does not revoke the attested sealed zero-result");
  }
  const zeroResultIssuedAt = Date.parse(input.zeroResultAttestation.issuedAt);
  const quarantinedAt = Date.parse(input.quarantineReceipt.quarantinedAt);
  const configuredAt = Date.parse(input.writeFenceReceipt.configuredAt);
  const nativeTerminatedAt = input.sameLeaseTerminationReceipt.terminatedAt;
  if (
    !Number.isFinite(zeroResultIssuedAt)
    || !Number.isFinite(quarantinedAt)
    || !Number.isFinite(configuredAt)
    || !Number.isFinite(nativeTerminatedAt)
    || zeroResultIssuedAt < configuredAt
    || zeroResultIssuedAt < nativeTerminatedAt
    || quarantinedAt < zeroResultIssuedAt
  ) {
    throw new Error("Maintenance S2 quarantine/zero-result ordering is invalid");
  }
  const proof = Object.freeze(new MaintenanceS2FailoverProof(
    S2_FAILOVER_PROOF_TOKEN,
    input.attempt.attemptId,
    input.attempt.backend,
    input.writeFenceReceipt.leaseToken,
    input.writeFenceReceipt.configAckDigest,
    input.quarantineReceipt.exactWriteFenceBindingDigest,
    input.quarantineReceipt.quarantineRecordDigest,
    input.quarantineReceipt.abandonedManifestDigest,
    input.zeroResultAttestation.digest,
    input.sameLeaseTerminationReceipt.nativeExecutionId,
    nativeTerminatedAt,
    Date.now()
  ));
  issuedS2FailoverProofs.add(proof);
  return proof;
}

export function isTrustedMaintenanceS2FailoverProof(
  value: unknown
): value is MaintenanceS2FailoverProof {
  return value instanceof MaintenanceS2FailoverProof
    && issuedS2FailoverProofs.has(value)
    && value.gate === MAINTENANCE_POST_START_FAILOVER_GATE
    && value.exactWriteFenceConfirmed === true
    && value.nativeTerminationConfirmed === true
    && value.shadowQuarantineConfirmed === true
    && value.commitAuthorityRevoked === true
    && value.cleanupAuthorityRevoked === true
    && value.sealedShadowZeroResult === true
    && value.noCommitIntent === true
    && Boolean(value.nativeExecutionId)
    && Number.isFinite(value.nativeTerminatedAt)
    && value.nativeTerminatedAt > 0;
}

export type MaintenanceBusinessTerminalOutcome =
  | "full"
  | "recovered"
  | "partial"
  | "noop";

export type MaintenanceAttemptOutcome =
  | { status: "full" }
  | { status: "recovered" }
  | { status: "partial" }
  | { status: "noop" }
  | { status: "cancelled"; failure?: MaintenanceFailureClassification }
  /**
   * `zero-result` is not itself permission to fail over. The production
   * isolation pipeline must first upgrade it to a trusted retryable failure by
   * binding Shadow, business-evidence and same-lease termination attestations.
   */
  | { status: "zero-result"; failure: MaintenanceFailureClassification }
  | {
    status: "failed";
    failure: MaintenanceFailureClassification;
    postStartFailoverProof?: MaintenanceS2FailoverProof;
  };

export type MaintenanceRoutingDecision =
  | {
    action: "complete";
    workflow: MaintenanceRoutingWorkflow;
  }
  | {
    action: "retry";
    workflow: MaintenanceRoutingWorkflow;
    attempt: MaintenanceRoutingAttempt;
    previousFailure: MaintenanceFailureClassification;
  }
  | {
    action: "stop";
    workflow: MaintenanceRoutingWorkflow;
    reason: "cancelled" | "failover-not-safe" | "no-ready-backend";
    failure?: MaintenanceFailureClassification;
  };

export function maintenanceBackendOrder(selectedBackend: AgentBackendKind): AgentBackendKind[] {
  const registryOrder = AGENT_BACKEND_DEFINITIONS.map((definition) => definition.kind);
  const selectedIndex = registryOrder.indexOf(selectedBackend);
  if (selectedIndex < 0) throw new Error(`Unknown selected Agent backend: ${selectedBackend}`);
  return [
    ...registryOrder.slice(selectedIndex),
    ...registryOrder.slice(0, selectedIndex)
  ];
}

export function createMaintenanceRoutingWorkflow(input: {
  workflowId: string;
  selectedBackend: AgentBackendKind;
}): MaintenanceRoutingWorkflow {
  const workflowId = input.workflowId.trim();
  if (!workflowId) throw new Error("Maintenance routing workflowId is required");
  return {
    workflowId,
    selectedBackend: input.selectedBackend,
    candidateBackends: maintenanceBackendOrder(input.selectedBackend),
    visitedBackends: [],
    attemptedBackends: [],
    attemptCount: 0
  };
}

export function startMaintenanceRouting(workflow: MaintenanceRoutingWorkflow): {
  workflow: MaintenanceRoutingWorkflow;
  attempt: MaintenanceRoutingAttempt;
} {
  if (workflow.attemptCount !== 0
    || workflow.visitedBackends.length !== 0
    || workflow.attemptedBackends.length !== 0) {
    throw new Error(`Maintenance routing workflow ${workflow.workflowId} has already started`);
  }
  return startAttempt(workflow, workflow.selectedBackend, [workflow.selectedBackend]);
}

export function classifyMaintenanceFailure(input: ClassifyMaintenanceFailureInput): MaintenanceFailureClassification {
  const message = maintenanceFailureMessage(input.error);
  const code = maintenanceFailureCode(input.error);
  const searchable = `${code} ${message}`.trim();
  const category = maintenanceFailureCategory(searchable);
  const retryable = isMaintenanceRetryableInfrastructureCategory(category);
  const preflightFailover = input.phase === "preflight"
    && input.agentStarted !== true
    && input.vaultMutationObserved !== true
    && retryable;
  const postStartFailoverCandidate = input.phase === "execution"
    && input.agentStarted === true
    && input.vaultMutationObserved !== true
    && retryable;
  const failoverGate = preflightFailover
    ? MAINTENANCE_FAILOVER_GATE
    : postStartFailoverCandidate
      ? MAINTENANCE_POST_START_FAILOVER_GATE
      : null;
  const failoverEligible = failoverGate !== null;
  return {
    phase: input.phase,
    category,
    code,
    message,
    retryable,
    failoverEligible,
    failoverGate
  };
}

export function isMaintenanceFailoverAllowed(
  failure: MaintenanceFailureClassification,
  options: {
    attempt?: MaintenanceRoutingAttempt;
    postStartFailoverProof?: MaintenanceS2FailoverProof;
  } = {}
): boolean {
  if (!failure.retryable || !failure.failoverEligible || isMaintenanceHardStopCategory(failure.category)) {
    return false;
  }
  if (failure.failoverGate === MAINTENANCE_FAILOVER_GATE) {
    return failure.phase === "preflight";
  }
  if (
    failure.failoverGate !== MAINTENANCE_POST_START_FAILOVER_GATE
    || failure.phase !== "execution"
    || !options.attempt
    || !isTrustedMaintenanceS2FailoverProof(options.postStartFailoverProof)
  ) {
    return false;
  }
  return options.postStartFailoverProof.attemptId === options.attempt.attemptId
    && options.postStartFailoverProof.backend === options.attempt.backend;
}

/**
 * Resolves only the cross-Agent routing decision. Agent execution, recovery,
 * rollback and business-success validation remain owned by Maintenance Harness.
 *
 * Standby readiness is deliberately lazy: business terminals, cancellations,
 * hard stops and unproved post-start failures return before readiness checks.
 */
export async function resolveMaintenanceAttemptOutcome(input: {
  workflow: MaintenanceRoutingWorkflow;
  attempt: MaintenanceRoutingAttempt;
  outcome: MaintenanceAttemptOutcome;
  isBackendReady: (backend: AgentBackendKind) => boolean | Promise<boolean>;
}): Promise<MaintenanceRoutingDecision> {
  assertCurrentMaintenanceAttempt(input.workflow, input.attempt);

  if (
    input.outcome.status === "full"
    || input.outcome.status === "recovered"
    || input.outcome.status === "partial"
    || input.outcome.status === "noop"
  ) {
    return { action: "complete", workflow: input.workflow };
  }
  if (input.outcome.status === "cancelled") {
    return {
      action: "stop",
      workflow: input.workflow,
      reason: "cancelled",
      ...(input.outcome.failure ? { failure: input.outcome.failure } : {})
    };
  }

  const failure = input.outcome.failure;
  if (input.outcome.status === "zero-result") {
    return {
      action: "stop",
      workflow: input.workflow,
      reason: "failover-not-safe",
      failure
    };
  }
  if (!isMaintenanceFailoverAllowed(failure, {
    attempt: input.attempt,
    ...(input.outcome.status === "failed" && input.outcome.postStartFailoverProof
      ? { postStartFailoverProof: input.outcome.postStartFailoverProof }
      : {})
  })) {
    return {
      action: "stop",
      workflow: input.workflow,
      reason: "failover-not-safe",
      failure
    };
  }

  const visited = [...input.workflow.visitedBackends];
  for (const backend of input.workflow.candidateBackends) {
    if (visited.includes(backend)) continue;
    visited.push(backend);
    if (!await input.isBackendReady(backend)) continue;
    const started = startAttempt(input.workflow, backend, visited);
    return {
      action: "retry",
      workflow: started.workflow,
      attempt: started.attempt,
      previousFailure: failure
    };
  }

  return {
    action: "stop",
    workflow: {
      ...input.workflow,
      visitedBackends: visited
    },
    reason: "no-ready-backend",
    failure
  };
}

function assertWriteFenceMatchesAttempt(
  attempt: MaintenanceRoutingAttempt,
  receipt: AgentExactWriteFenceReceipt
): void {
  if (
    receipt.attemptToken !== attempt.attemptId
    || receipt.backend !== attempt.backend
    || !receipt.leaseToken.trim()
  ) {
    throw new Error("Maintenance exact-write-fence receipt does not match attempt/backend/lease");
  }
}

function startAttempt(
  workflow: MaintenanceRoutingWorkflow,
  backend: AgentBackendKind,
  visitedBackends: readonly AgentBackendKind[]
): {
  workflow: MaintenanceRoutingWorkflow;
  attempt: MaintenanceRoutingAttempt;
} {
  if (!workflow.candidateBackends.includes(backend)) {
    throw new Error(`Agent backend ${backend} is outside maintenance workflow ${workflow.workflowId}`);
  }
  if (workflow.attemptedBackends.includes(backend)) {
    throw new Error(`Agent backend ${backend} was already attempted in maintenance workflow ${workflow.workflowId}`);
  }
  const ordinal = workflow.attemptCount + 1;
  const attempt: MaintenanceRoutingAttempt = {
    workflowId: workflow.workflowId,
    attemptId: maintenanceAttemptId(workflow.workflowId, ordinal, backend),
    ordinal,
    backend
  };
  return {
    workflow: {
      ...workflow,
      visitedBackends: [...visitedBackends],
      attemptedBackends: [...workflow.attemptedBackends, backend],
      attemptCount: ordinal
    },
    attempt
  };
}

function assertCurrentMaintenanceAttempt(
  workflow: MaintenanceRoutingWorkflow,
  attempt: MaintenanceRoutingAttempt
): void {
  const expectedBackend = workflow.attemptedBackends[workflow.attemptedBackends.length - 1];
  const expectedAttemptId = maintenanceAttemptId(workflow.workflowId, workflow.attemptCount, expectedBackend);
  if (attempt.workflowId !== workflow.workflowId
    || attempt.ordinal !== workflow.attemptCount
    || attempt.backend !== expectedBackend
    || attempt.attemptId !== expectedAttemptId) {
    throw new Error(`Stale or foreign maintenance attempt: ${attempt.attemptId}`);
  }
}

export function maintenanceAttemptId(
  workflowId: string,
  ordinal: number,
  backend: AgentBackendKind
): string {
  const suffix = `-attempt-${ordinal}-${backend}`;
  const maxWorkflowLength = Math.max(1, 128 - suffix.length);
  const workflowToken = workflowId
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxWorkflowLength)
    || "maintenance";
  return `${workflowToken}${suffix}`;
}

function maintenanceFailureCategory(searchable: string): MaintenanceFailureCategory {
  if (/\b(?:ABORT_ERR|CANCELLED|CANCELED)\b|(?:任务|用户|运行)[^\n]*(?:已取消|取消)|run cancelled/i.test(searchable)) {
    return "cancelled";
  }
  if (/\bEXACT_WRITE_FENCE_UNAVAILABLE\b|无法证明精确写隔离/i.test(searchable)) {
    return "isolation-unavailable";
  }
  if (/\braw\b[^\n]*(?:integrity|modified|changed|mutation|read.?only)|(?:Raw|原始资料|原始来源)[^\n]*(?:完整性|被修改|变更|只读)/i.test(searchable)) {
    return "raw-integrity";
  }
  if (/symlink|symbolic link|符号链接|unsafe[^\n]*(?:vault|path|root)|不安全[^\n]*(?:Vault|知识库|路径|目录)/i.test(searchable)) {
    return "unsafe-vault";
  }
  if (/\b(?:POLICY_DENIED|FORBIDDEN)\b|\b403\b|denied by policy|not allowed by policy|policy[^\n]*(?:reject|denied|blocked)|策略[^\n]*(?:拒绝|阻止|不允许)|权限策略[^\n]*(?:拒绝|阻止)/i.test(searchable)) {
    return "policy-denied";
  }
  if (/commit conflict|concurrent[^\n]*commit|ledger[^\n]*(?:corrupt|conflict)|并发[^\n]*(?:提交|写入)[^\n]*冲突|账本[^\n]*(?:损坏|冲突)/i.test(searchable)) {
    return "commit-conflict";
  }
  if (/\b(?:ENOSPC|EACCES|EPERM|EROFS|EMFILE)\b|no space left|read-only file system|磁盘[^\n]*(?:已满|空间)|文件[^\n]*权限|写入权限/i.test(searchable)) {
    return "storage-failure";
  }
  if (/digest evidence|evidence[^\n]*(?:missing|invalid|insufficient)|report[^\n]*(?:stale|not updated)|证据[^\n]*(?:缺失|不足|无效)|报告[^\n]*(?:未更新|过期)/i.test(searchable)) {
    return "evidence-invalid";
  }
  if (/\b(?:UNAUTHENTICATED|AUTH_REQUIRED)\b|\b401\b|unauthori[sz]ed|authentication required|login required|needs auth|未登录|需要登录|认证[^\n]*(?:失败|过期|缺失)/i.test(searchable)) {
    return "authentication-required";
  }
  if (
    /\b(?:ETIMEDOUT|TIMEOUT|DEADLINE_EXCEEDED)\b|timed?\s*out|deadline exceeded|超时|长时间(?:没有|未)返回/i
      .test(searchable)
  ) {
    return "timeout";
  }
  if (/\b(?:ECONNREFUSED|ECONNRESET|EPIPE|ENETUNREACH|EHOSTUNREACH|ENOTFOUND|TRANSPORT_CLOSED)\b|connection refused|network[^\n]*(?:offline|unavailable)|transport[^\n]*(?:closed|unavailable)|网络[^\n]*(?:断开|不可用)|连接被拒绝/i.test(searchable)) {
    return "transport-unavailable";
  }
  if (
    /\b(?:BACKEND_UNAVAILABLE|PROCESS_EXITED|PROCESS_CRASHED)\b|spawn[^\n]*(?:codex|opencode|hermes)[^\n]*(?:not found|ENOENT)|(?:Agent|backend)[^\n]*(?:not ready|unavailable|exited)|(?:CLI|Codex CLI|OpenCode CLI|Hermes CLI)[^\n]*(?:not found|missing|not installed|unavailable|exited)|(?:Agent|后端)[^\n]*(?:未就绪|不可用|已退出)|(?:命令行|CLI)[^\n]*(?:不存在|未安装|不可用|已退出)/i
      .test(searchable)
  ) {
    return "backend-unavailable";
  }
  return "unknown";
}

function isMaintenanceHardStopCategory(category: MaintenanceFailureCategory): boolean {
  return category === "cancelled"
    || category === "policy-denied"
    || category === "raw-integrity"
    || category === "unsafe-vault"
    || category === "evidence-invalid"
    || category === "commit-conflict"
    || category === "storage-failure"
    || category === "unknown";
}

function isMaintenanceRetryableInfrastructureCategory(category: MaintenanceFailureCategory): boolean {
  return category === "backend-unavailable"
    || category === "authentication-required"
    || category === "isolation-unavailable"
    || category === "transport-unavailable"
    || category === "timeout";
}

function maintenanceFailureMessage(value: unknown): string {
  if (value instanceof Error) return value.message.trim();
  if (typeof value === "string") return value.trim();
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.message === "string") return record.message.trim();
    if (record.error !== undefined) {
      const nested = maintenanceFailureMessage(record.error);
      if (nested) return nested;
    }
    try {
      return JSON.stringify(value).slice(0, 2_000);
    } catch {
      return String(value).trim();
    }
  }
  return String(value ?? "").trim();
}

function maintenanceFailureCode(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  if (typeof record.code === "string" && record.code.trim()) return record.code.trim().toUpperCase();
  if (typeof record.code === "number" && Number.isFinite(record.code)) return String(record.code);
  return maintenanceFailureCode(record.error);
}
