import * as assert from "node:assert/strict";
import { chmod, lstat, mkdtemp, mkdir, readdir, realpath, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { createExactWriteFenceReceipt } from "../../agent/write-fence";
import type { AgentBackendKind, AgentTaskInput } from "../../agent/types";
import {
  classifyMaintenanceFailure,
  createMaintenanceS2FailoverProof,
  createMaintenanceRoutingWorkflow,
  issueMaintenanceSameLeaseTerminationReceipt,
  isMaintenanceFailoverAllowed,
  maintenanceBackendOrder,
  resolveMaintenanceAttemptOutcome,
  startMaintenanceRouting,
  type MaintenanceRoutingAttempt,
  type MaintenanceS2FailoverProof
} from "../../knowledge-base/maintenance-routing";
import { issueKnowledgeAgentNativeTerminationReceipt } from "../../knowledge-base/native-termination";
import {
  attestMaintenanceShadowZeroResult,
  confirmMaintenanceShadowTransportConfigFence,
  createMaintenanceShadowTransportConfigReceipt,
  createMaintenanceShadowVault,
  maintenanceExactWriteFenceBindingDigest,
  maintenanceShadowExecutionBoundary,
  quarantineMaintenanceShadowZeroResult,
  sealMaintenanceShadowVault
} from "../../harness/maintenance/shadow-vault";
import {
  KnowledgeBaseMaintenanceRunner,
  MaintenanceAgentRoutingError,
  MaintenanceShadowAttemptError,
  maintenanceTurnOverridesForAttempt,
  runSelectedMaintenanceAgentTask
} from "../../knowledge-base/maintenance-runner";
import {
  KnowledgeAgentAttemptError,
  KnowledgeBaseAgentTaskService
} from "../../knowledge-base/agent-task-service";
import { KnowledgeAgentRuntimeController } from "../../knowledge-base/agent-runner";
import type { KnowledgeBaseRunCompletion } from "../../knowledge-base/types";
import { DEFAULT_SETTINGS } from "../../settings/settings";

export async function runHarnessV2MaintenanceRoutingTests(): Promise<void> {
  assertSelectedBackendRotatesStableRegistryOrder();
  assertFirstAttemptUsesSelectedBackendAndStableIds();
  await assertSuccessDoesNotInspectStandbyBackends();
  await assertPreflightFailureSelectsNextReadyBackend();
  await runHarnessV2MaintenanceS2RoutingTests();
  await assertSafetyFailureCannotFailOver();
  await assertVisitedBackendsCannotLoop();
  await assertNoReadyBackendStopsAfterOneStablePass();
  assertFailureClassifierKeepsOperationalAndSafetyFailuresDistinct();
  await assertFailureClassifierRejectsFalsePositiveFailovers();
  assertFallbackDoesNotInheritSelectedAgentModelOrSession();
  await assertSelectedFirstExecutionUsesOnlyOneAgentOnSuccess();
  await assertDeterministicNoopDoesNotStartAnyAgent();
  await assertSelectedFirstExecutionLazilyFallsBackAfterPreflightFailure();
  await assertRunnerFenceAckBeforePromptFailureCanSafelyFallBack();
  await assertSubmittedFailureCannotStartStandbyAgent();
  await assertRunnerAbortWithoutNativeAckNeverChecksStandby();
  await assertCommitPhaseNeverReopensFailover();
  await assertUnknownPreflightFailureFailsClosed();
  await assertGenericBackendPreflightFailureIsStructured();
  await assertMaintenanceManagedKindsCannotDowngradeWithoutIdentity();
  await assertUnknownManagedKindCannotReachAnyRuntime();
  await assertMaintenanceAttemptWithoutShadowFailsClosed();
  await assertLiveAttachmentIsRejectedBeforeAnyBackendPreflight();
  await assertShadowOverrideReachesRuntimeAndHarnessBoundaries();
  await assertServicePreservesShadowOverrideAndExactWriteRoots();
  await assertMaintenanceWritableRootsRejectNonAllowlistedPaths();
}

export async function runHarnessV2MaintenanceS2RoutingTests(): Promise<void> {
  await assertRuntimeFailureWithoutProofDoesNotInspectStandbyBackends();
  await assertTrustedS2ProofAllowsPostStartFailover();
  await assertS2ProofRejectsClonesAndForeignLease();
  await assertHardStopsIgnoreTrustedS2Proof();
}

function assertSelectedBackendRotatesStableRegistryOrder(): void {
  assert.deepEqual(maintenanceBackendOrder("codex-cli"), ["codex-cli", "opencode", "hermes"]);
  assert.deepEqual(maintenanceBackendOrder("opencode"), ["opencode", "hermes", "codex-cli"]);
  assert.deepEqual(maintenanceBackendOrder("hermes"), ["hermes", "codex-cli", "opencode"]);
}

function assertFirstAttemptUsesSelectedBackendAndStableIds(): void {
  const workflow = createMaintenanceRoutingWorkflow({
    workflowId: "maintain-2026-07-18",
    selectedBackend: "opencode"
  });
  const started = startMaintenanceRouting(workflow);

  assert.deepEqual(started.workflow.candidateBackends, ["opencode", "hermes", "codex-cli"]);
  assert.deepEqual(started.workflow.visitedBackends, ["opencode"]);
  assert.deepEqual(started.workflow.attemptedBackends, ["opencode"]);
  assert.equal(started.workflow.attemptCount, 1);
  assert.deepEqual(started.attempt, {
    workflowId: "maintain-2026-07-18",
    attemptId: "maintain-2026-07-18-attempt-1-opencode",
    ordinal: 1,
    backend: "opencode"
  });
}

async function assertSuccessDoesNotInspectStandbyBackends(): Promise<void> {
  const backends: AgentBackendKind[] = ["codex-cli", "opencode", "hermes"];
  const outcomes = [
    { status: "full" as const },
    { status: "recovered" as const },
    { status: "partial" as const },
    { status: "noop" as const }
  ];

  for (const selectedBackend of backends) {
    for (const outcome of outcomes) {
      const started = startMaintenanceRouting(createMaintenanceRoutingWorkflow({
        workflowId: `maintain-${selectedBackend}-${outcome.status}`,
        selectedBackend
      }));
      let readinessChecks = 0;

      const decision = await resolveMaintenanceAttemptOutcome({
        workflow: started.workflow,
        attempt: started.attempt,
        outcome,
        isBackendReady() {
          readinessChecks += 1;
          return true;
        }
      });

      assert.equal(decision.action, "complete", `${selectedBackend}:${outcome.status}`);
      assert.equal(
        readinessChecks,
        0,
        `${selectedBackend}:${outcome.status} must not inspect standby Agent readiness`
      );
      assert.deepEqual(
        decision.workflow.attemptedBackends,
        [selectedBackend],
        `${selectedBackend}:${outcome.status} must complete after the selected Agent`
      );
    }
  }
}

async function assertPreflightFailureSelectsNextReadyBackend(): Promise<void> {
  const started = startMaintenanceRouting(createMaintenanceRoutingWorkflow({
    workflowId: "maintain-preflight-fallback",
    selectedBackend: "opencode"
  }));
  const checked: string[] = [];
  const failure = classifyMaintenanceFailure({
    phase: "preflight",
    error: Object.assign(new Error("spawn opencode ENOENT"), { code: "ENOENT" })
  });

  const decision = await resolveMaintenanceAttemptOutcome({
    workflow: started.workflow,
    attempt: started.attempt,
    outcome: { status: "failed", failure },
    async isBackendReady(backend) {
      checked.push(backend);
      return backend === "codex-cli";
    }
  });

  assert.equal(failure.category, "backend-unavailable");
  assert.equal(failure.failoverEligible, true);
  assert.equal(decision.action, "retry");
  if (decision.action !== "retry") throw new Error("expected a retry decision");
  assert.deepEqual(checked, ["hermes", "codex-cli"]);
  assert.deepEqual(decision.workflow.visitedBackends, ["opencode", "hermes", "codex-cli"]);
  assert.deepEqual(decision.workflow.attemptedBackends, ["opencode", "codex-cli"]);
  assert.deepEqual(decision.attempt, {
    workflowId: "maintain-preflight-fallback",
    attemptId: "maintain-preflight-fallback-attempt-2-codex-cli",
    ordinal: 2,
    backend: "codex-cli"
  });
}

async function assertRuntimeFailureWithoutProofDoesNotInspectStandbyBackends(): Promise<void> {
  const started = startMaintenanceRouting(createMaintenanceRoutingWorkflow({
    workflowId: "maintain-running-timeout",
    selectedBackend: "codex-cli"
  }));
  let readinessChecks = 0;
  const failure = classifyMaintenanceFailure({
    phase: "execution",
    error: Object.assign(new Error("agent timed out"), { code: "ETIMEDOUT" }),
    agentStarted: true
  });

  const decision = await resolveMaintenanceAttemptOutcome({
    workflow: started.workflow,
    attempt: started.attempt,
    outcome: { status: "failed", failure },
    isBackendReady() {
      readinessChecks += 1;
      return true;
    }
  });

  assert.equal(failure.category, "timeout");
  assert.equal(failure.retryable, true);
  assert.equal(failure.failoverEligible, true);
  assert.equal(isMaintenanceFailoverAllowed(failure), false);
  assert.equal(decision.action, "stop");
  if (decision.action !== "stop") throw new Error("expected a stop decision");
  assert.equal(decision.reason, "failover-not-safe");
  assert.equal(readinessChecks, 0, "post-start failure without trusted zero-result proof must not inspect standby Agents");
}

async function assertTrustedS2ProofAllowsPostStartFailover(): Promise<void> {
  const started = startMaintenanceRouting(createMaintenanceRoutingWorkflow({
    workflowId: "maintain-s2-timeout",
    selectedBackend: "opencode"
  }));
  const fixture = await createTrustedS2ProofFixture(started.attempt);
  try {
    const checked: string[] = [];
    const failure = classifyMaintenanceFailure({
      phase: "execution",
      error: Object.assign(new Error("OpenCode transport timed out"), { code: "ETIMEDOUT" }),
      agentStarted: true
    });
    const decision = await resolveMaintenanceAttemptOutcome({
      workflow: started.workflow,
      attempt: started.attempt,
      outcome: {
        status: "failed",
        failure,
        postStartFailoverProof: fixture.proof
      },
      async isBackendReady(backend) {
        checked.push(backend);
        return backend === "codex-cli";
      }
    });

    assert.equal(failure.failoverGate, "S2_POST_START_ZERO_RESULT");
    assert.equal(isMaintenanceFailoverAllowed(failure, {
      attempt: started.attempt,
      postStartFailoverProof: fixture.proof
    }), true);
    assert.equal(decision.action, "retry");
    if (decision.action !== "retry") throw new Error("expected trusted S2 retry");
    assert.deepEqual(checked, ["hermes", "codex-cli"]);
    assert.deepEqual(decision.workflow.visitedBackends, ["opencode", "hermes", "codex-cli"]);
    assert.deepEqual(decision.workflow.attemptedBackends, ["opencode", "codex-cli"]);
    assert.equal(decision.attempt.backend, "codex-cli");
  } finally {
    await fixture.cleanup();
  }
}

async function assertS2ProofRejectsClonesAndForeignLease(): Promise<void> {
  const started = startMaintenanceRouting(createMaintenanceRoutingWorkflow({
    workflowId: "maintain-s2-nominal",
    selectedBackend: "codex-cli"
  }));
  const fixture = await createTrustedS2ProofFixture(started.attempt);
  try {
    const failure = classifyMaintenanceFailure({
      phase: "execution",
      error: new Error("process crashed before returning"),
      agentStarted: true
    });
    const clonedProof = { ...fixture.proof } as MaintenanceS2FailoverProof;
    assert.equal(isMaintenanceFailoverAllowed(failure, {
      attempt: started.attempt,
      postStartFailoverProof: clonedProof
    }), false, "a plain-object proof clone must not authorize failover");

    assert.throws(
      () => createMaintenanceS2FailoverProof({
        attempt: started.attempt,
        writeFenceReceipt: fixture.writeFenceReceipt,
        sameLeaseTerminationReceipt: { ...fixture.sameLeaseTerminationReceipt } as typeof fixture.sameLeaseTerminationReceipt,
        quarantineReceipt: fixture.quarantineReceipt,
        zeroResultAttestation: fixture.zeroResultAttestation
      }),
      /trusted same-lease native termination receipt/
    );

    assert.throws(
      () => createMaintenanceS2FailoverProof({
        attempt: started.attempt,
        writeFenceReceipt: { ...fixture.writeFenceReceipt },
        sameLeaseTerminationReceipt: fixture.sameLeaseTerminationReceipt,
        quarantineReceipt: fixture.quarantineReceipt,
        zeroResultAttestation: fixture.zeroResultAttestation
      }),
      /trusted exact-write-fence receipt/
    );

    const foreignFence = createExactWriteFenceReceipt({
      backend: started.attempt.backend,
      task: exactFenceTask(started.attempt, "lease-foreign", fixture.paths),
      transport: "test-transport",
      transportAck: { accepted: true }
    });
    assert.throws(
      () => createMaintenanceS2FailoverProof({
        attempt: started.attempt,
        writeFenceReceipt: foreignFence,
        sameLeaseTerminationReceipt: fixture.sameLeaseTerminationReceipt,
        quarantineReceipt: fixture.quarantineReceipt,
        zeroResultAttestation: fixture.zeroResultAttestation
      }),
      /same lease/
    );
    assert.throws(
      () => createMaintenanceS2FailoverProof({
        attempt: started.attempt,
        writeFenceReceipt: fixture.writeFenceReceipt,
        sameLeaseTerminationReceipt: fixture.sameLeaseTerminationReceipt,
        quarantineReceipt: { ...fixture.quarantineReceipt } as typeof fixture.quarantineReceipt,
        zeroResultAttestation: fixture.zeroResultAttestation
      }),
      /durable Shadow quarantine receipt/
    );
    assert.throws(
      () => createMaintenanceS2FailoverProof({
        attempt: started.attempt,
        writeFenceReceipt: fixture.writeFenceReceipt,
        sameLeaseTerminationReceipt: fixture.sameLeaseTerminationReceipt,
        quarantineReceipt: JSON.parse(
          JSON.stringify(fixture.quarantineReceipt)
        ) as typeof fixture.quarantineReceipt,
        zeroResultAttestation: fixture.zeroResultAttestation
      }),
      /durable Shadow quarantine receipt/
    );
    const prototypeClonedQuarantine = Object.assign(
      Object.create(Object.getPrototypeOf(fixture.quarantineReceipt)),
      { ...fixture.quarantineReceipt }
    ) as typeof fixture.quarantineReceipt;
    assert.throws(
      () => createMaintenanceS2FailoverProof({
        attempt: started.attempt,
        writeFenceReceipt: fixture.writeFenceReceipt,
        sameLeaseTerminationReceipt: fixture.sameLeaseTerminationReceipt,
        quarantineReceipt: prototypeClonedQuarantine,
        zeroResultAttestation: fixture.zeroResultAttestation
      }),
      /durable Shadow quarantine receipt/
    );
    assert.throws(
      () => createMaintenanceS2FailoverProof({
        attempt: started.attempt,
        writeFenceReceipt: fixture.writeFenceReceipt,
        sameLeaseTerminationReceipt: fixture.sameLeaseTerminationReceipt,
        quarantineReceipt: fixture.quarantineReceipt,
        zeroResultAttestation: { ...fixture.zeroResultAttestation } as typeof fixture.zeroResultAttestation
      }),
      /nominal Shadow zero-result attestation/
    );
    const jsonClonedAttestation = JSON.parse(
      JSON.stringify(fixture.zeroResultAttestation)
    ) as typeof fixture.zeroResultAttestation;
    assert.throws(
      () => createMaintenanceS2FailoverProof({
        attempt: started.attempt,
        writeFenceReceipt: fixture.writeFenceReceipt,
        sameLeaseTerminationReceipt: fixture.sameLeaseTerminationReceipt,
        quarantineReceipt: fixture.quarantineReceipt,
        zeroResultAttestation: jsonClonedAttestation
      }),
      /nominal Shadow zero-result attestation/
    );
    const prototypeClonedAttestation = Object.assign(
      Object.create(Object.getPrototypeOf(fixture.zeroResultAttestation)),
      { ...fixture.zeroResultAttestation }
    ) as typeof fixture.zeroResultAttestation;
    assert.throws(
      () => createMaintenanceS2FailoverProof({
        attempt: started.attempt,
        writeFenceReceipt: fixture.writeFenceReceipt,
        sameLeaseTerminationReceipt: fixture.sameLeaseTerminationReceipt,
        quarantineReceipt: fixture.quarantineReceipt,
        zeroResultAttestation: prototypeClonedAttestation
      }),
      /nominal Shadow zero-result attestation/
    );
  } finally {
    await fixture.cleanup();
  }
}

async function assertHardStopsIgnoreTrustedS2Proof(): Promise<void> {
  const started = startMaintenanceRouting(createMaintenanceRoutingWorkflow({
    workflowId: "maintain-s2-hard-stops",
    selectedBackend: "hermes"
  }));
  const fixture = await createTrustedS2ProofFixture(started.attempt);
  try {
    const cases = [
      new Error("知识库任务已取消"),
      new Error("403 denied by policy: write scope is not allowed"),
      new Error("Raw source integrity changed unexpectedly"),
      new Error("检测到不安全的 Vault 符号链接结构"),
      new Error("digest evidence is missing"),
      new Error("unclassified execution exception")
    ];
    for (const error of cases) {
      let readinessChecks = 0;
      const failure = classifyMaintenanceFailure({
        phase: "execution",
        error,
        agentStarted: true
      });
      const outcome = failure.category === "cancelled"
        ? { status: "cancelled" as const, failure }
        : {
            status: "failed" as const,
            failure,
            postStartFailoverProof: fixture.proof
          };
      const decision = await resolveMaintenanceAttemptOutcome({
        workflow: started.workflow,
        attempt: started.attempt,
        outcome,
        isBackendReady() {
          readinessChecks += 1;
          return true;
        }
      });
      assert.equal(decision.action, "stop", failure.category);
      assert.equal(readinessChecks, 0, failure.category);
    }
  } finally {
    await fixture.cleanup();
  }
}

async function assertSafetyFailureCannotFailOver(): Promise<void> {
  const started = startMaintenanceRouting(createMaintenanceRoutingWorkflow({
    workflowId: "maintain-unsafe-vault",
    selectedBackend: "codex-cli"
  }));
  let readinessChecks = 0;
  const failure = classifyMaintenanceFailure({
    phase: "preflight",
    error: new Error("检测到不安全的 Vault 符号链接结构")
  });

  const decision = await resolveMaintenanceAttemptOutcome({
    workflow: started.workflow,
    attempt: started.attempt,
    outcome: { status: "failed", failure },
    isBackendReady() {
      readinessChecks += 1;
      return true;
    }
  });

  assert.equal(failure.category, "unsafe-vault");
  assert.equal(failure.failoverEligible, false);
  assert.equal(decision.action, "stop");
  assert.equal(readinessChecks, 0, "switching Agents cannot repair a Vault safety failure");
}

async function assertVisitedBackendsCannotLoop(): Promise<void> {
  const first = startMaintenanceRouting(createMaintenanceRoutingWorkflow({
    workflowId: "maintain-no-loop",
    selectedBackend: "codex-cli"
  }));
  const preflightFailure = classifyMaintenanceFailure({
    phase: "preflight",
    error: new Error("Agent backend is not ready")
  });
  const secondDecision = await resolveMaintenanceAttemptOutcome({
    workflow: first.workflow,
    attempt: first.attempt,
    outcome: { status: "failed", failure: preflightFailure },
    isBackendReady: (backend) => backend === "hermes"
  });

  assert.equal(secondDecision.action, "retry");
  if (secondDecision.action !== "retry") throw new Error("expected the second attempt");
  assert.equal(secondDecision.attempt.backend, "hermes");
  assert.deepEqual(secondDecision.workflow.visitedBackends, ["codex-cli", "opencode", "hermes"]);

  let readinessChecks = 0;
  const terminalDecision = await resolveMaintenanceAttemptOutcome({
    workflow: secondDecision.workflow,
    attempt: secondDecision.attempt,
    outcome: { status: "failed", failure: preflightFailure },
    isBackendReady() {
      readinessChecks += 1;
      return true;
    }
  });

  assert.equal(terminalDecision.action, "stop");
  if (terminalDecision.action !== "stop") throw new Error("expected routing to stop");
  assert.equal(terminalDecision.reason, "no-ready-backend");
  assert.equal(readinessChecks, 0, "an inspected or attempted backend cannot be revisited in one workflow");
}

async function assertNoReadyBackendStopsAfterOneStablePass(): Promise<void> {
  const started = startMaintenanceRouting(createMaintenanceRoutingWorkflow({
    workflowId: "maintain-none-ready",
    selectedBackend: "hermes"
  }));
  const checked: string[] = [];
  const failure = classifyMaintenanceFailure({
    phase: "preflight",
    error: new Error("Hermes connection refused")
  });

  const decision = await resolveMaintenanceAttemptOutcome({
    workflow: started.workflow,
    attempt: started.attempt,
    outcome: { status: "failed", failure },
    isBackendReady(backend) {
      checked.push(backend);
      return false;
    }
  });

  assert.equal(decision.action, "stop");
  if (decision.action !== "stop") throw new Error("expected routing to stop");
  assert.equal(decision.reason, "no-ready-backend");
  assert.deepEqual(checked, ["codex-cli", "opencode"]);
  assert.deepEqual(decision.workflow.visitedBackends, ["hermes", "codex-cli", "opencode"]);
  assert.deepEqual(decision.workflow.attemptedBackends, ["hermes"]);
}

function assertFailureClassifierKeepsOperationalAndSafetyFailuresDistinct(): void {
  const cases = [
    ["User authentication required (401)", "authentication-required", true],
    ["EXACT_WRITE_FENCE_UNAVAILABLE: opencode 无法证明精确写隔离", "isolation-unavailable", true],
    ["connect ECONNREFUSED 127.0.0.1", "transport-unavailable", true],
    ["preflight deadline exceeded", "timeout", true],
    ["OpenCode 长时间没有返回（1 秒），已请求中断。", "timeout", true],
    ["知识库任务已取消", "cancelled", false],
    ["403 denied by policy: write scope is not allowed", "policy-denied", false],
    ["Raw source integrity changed unexpectedly", "raw-integrity", false],
    ["digest evidence is missing", "evidence-invalid", false],
    ["concurrent maintenance commit conflict", "commit-conflict", false],
    ["write failed: ENOSPC", "storage-failure", false],
    ["unclassified preflight exception", "unknown", false]
  ] as const;

  for (const [message, category, eligible] of cases) {
    const classified = classifyMaintenanceFailure({ phase: "preflight", error: new Error(message) });
    assert.equal(classified.category, category, message);
    assert.equal(classified.failoverEligible, eligible, message);
  }

  const crossedAgentBoundary = classifyMaintenanceFailure({
    phase: "preflight",
    error: new Error("connect ECONNREFUSED"),
    agentStarted: true
  });
  const crossedWriteBoundary = classifyMaintenanceFailure({
    phase: "preflight",
    error: new Error("Agent unavailable"),
    vaultMutationObserved: true
  });
  assert.equal(crossedAgentBoundary.failoverEligible, false);
  assert.equal(crossedWriteBoundary.failoverEligible, false);
}

async function assertFailureClassifierRejectsFalsePositiveFailovers(): Promise<void> {
  const cases: Array<{
    label: string;
    error: Error & { code?: string };
    category: "policy-denied" | "evidence-invalid" | "unknown";
  }> = [
    {
      label: "Vault ENOENT",
      error: Object.assign(
        new Error("ENOENT: no such file or directory, scandir '/vault/wiki'"),
        { code: "ENOENT" }
      ),
      category: "unknown"
    },
    {
      label: "source ENOENT",
      error: Object.assign(
        new Error("ENOENT: no such file or directory, open '/vault/raw/source.md'"),
        { code: "ENOENT" }
      ),
      category: "unknown"
    },
    {
      label: "rules ENOENT",
      error: Object.assign(
        new Error("ENOENT: no such file or directory, open '/vault/LLM-WIKI.md'"),
        { code: "ENOENT" }
      ),
      category: "unknown"
    },
    {
      label: "write permission 403",
      error: Object.assign(
        new Error("HTTP 403 Forbidden while writing Vault output"),
        { code: "403" }
      ),
      category: "policy-denied"
    },
    {
      label: "explicit policy denial",
      error: Object.assign(new Error("write scope rejected"), { code: "POLICY_DENIED" }),
      category: "policy-denied"
    },
    {
      label: "invalid evidence",
      error: Object.assign(new Error("business evidence rejected"), { code: "EVIDENCE_INVALID" }),
      category: "evidence-invalid"
    },
    {
      label: "invalid business result",
      error: Object.assign(
        new Error("maintenance produced an invalid business result"),
        { code: "BUSINESS_RESULT_INVALID" }
      ),
      category: "unknown"
    },
    {
      label: "unknown exception",
      error: new Error("unexpected maintenance parser state"),
      category: "unknown"
    }
  ];

  for (const testCase of cases) {
    const called: AgentBackendKind[] = [];
    const readinessChecks: AgentBackendKind[] = [];
    await assert.rejects(
      runSelectedMaintenanceAgentTask({
        workflowRunId: `closed-failure-${testCase.label.replace(/\s+/g, "-").toLowerCase()}`,
        selectedBackend: "codex-cli",
        attempts: [],
        isBackendReady: async (backend) => {
          readinessChecks.push(backend);
          return true;
        },
        execute: async (attempt) => {
          called.push(attempt.backend);
          throw new KnowledgeAgentAttemptError(
            "preflight",
            attempt.backend,
            attempt.workflowId,
            attempt.attemptId,
            attempt.ordinal,
            `harness-${attempt.backend}`,
            undefined,
            testCase.error
          );
        }
      }),
      (error) => error instanceof MaintenanceAgentRoutingError
        && error.failure.category === testCase.category
        && error.failure.failoverEligible === false,
      testCase.label
    );
    assert.deepEqual(called, ["codex-cli"], `${testCase.label} must not execute a standby Agent`);
    assert.deepEqual(
      readinessChecks,
      [],
      `${testCase.label} must fail closed before inspecting standby readiness`
    );
  }
}

interface TrustedS2FixturePaths {
  writableRootPaths: string[];
  deniedShadowPaths: string[];
  liveVaultPath: string;
  controlRootPath: string;
}

async function createTrustedS2ProofFixture(attempt: MaintenanceRoutingAttempt) {
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), "echoink-routing-s2-"));
  const liveVaultPath = path.join(fixtureRoot, "live");
  const storageRootPath = path.join(fixtureRoot, "shadow-storage");
  await Promise.all([
    mkdir(path.join(liveVaultPath, "raw"), { recursive: true }),
    mkdir(path.join(liveVaultPath, "wiki"), { recursive: true }),
    mkdir(path.join(liveVaultPath, "projects"), { recursive: true }),
    mkdir(path.join(liveVaultPath, "outputs"), { recursive: true }),
    mkdir(path.join(liveVaultPath, "inbox"), { recursive: true })
  ]);
  await writeFile(path.join(liveVaultPath, "LLM-WIKI.md"), "# Rules\n", "utf8");

  const handle = await createMaintenanceShadowVault({
    liveVaultPath,
    attemptId: attempt.attemptId,
    storageRootPath
  });
  try {
    const boundary = await maintenanceShadowExecutionBoundary(handle);
    const paths: TrustedS2FixturePaths = {
      writableRootPaths: boundary.writableRootPaths,
      deniedShadowPaths: boundary.deniedPaths,
      liveVaultPath,
      controlRootPath: boundary.deniedParentPath
    };
    const writeFenceReceipt = createExactWriteFenceReceipt({
      backend: attempt.backend,
      task: exactFenceTask(attempt, `lease:${attempt.attemptId}`, paths),
      transport: "test-transport",
      transportAck: { accepted: true, attemptId: attempt.attemptId }
    });
    const shadowReceipt = createMaintenanceShadowTransportConfigReceipt({
      backend: attempt.backend,
      attemptId: attempt.attemptId,
      leaseId: writeFenceReceipt.leaseToken,
      enforcedWritableRootPaths: boundary.writableRootPaths,
      enforcedDeniedShadowPaths: boundary.deniedPaths,
      deniedLiveVaultPath: liveVaultPath,
      deniedControlPath: boundary.deniedParentPath,
      transportAck: writeFenceReceipt.transport,
      transportConfigDigest: maintenanceExactWriteFenceBindingDigest(writeFenceReceipt),
      issuedAt: writeFenceReceipt.configuredAt
    });
    await confirmMaintenanceShadowTransportConfigFence(handle, liveVaultPath, shadowReceipt);
    const harnessRunId = `harness:${attempt.attemptId}`;
    const nativeTerminationReceipt = issueKnowledgeAgentNativeTerminationReceipt({
      backend: attempt.backend,
      harnessRunId,
      nativeExecutionId: `native:${attempt.attemptId}`,
      kind: "abort-ack"
    });
    const sameLeaseTerminationReceipt = issueMaintenanceSameLeaseTerminationReceipt({
      attempt,
      writeFenceReceipt,
      harnessRunId,
      nativeTerminationReceipt
    });
    const changeSet = await sealMaintenanceShadowVault(handle);
    assert.equal(changeSet.structuralResult, "zero-result");
    const zeroResultAttestation = await attestMaintenanceShadowZeroResult(handle, liveVaultPath);
    const quarantineReceipt = await quarantineMaintenanceShadowZeroResult(handle, liveVaultPath, {
      writeFenceReceipt,
      zeroResultAttestation,
      reason: "fixture post-start zero-result"
    });
    const proof = createMaintenanceS2FailoverProof({
      attempt,
      writeFenceReceipt,
      sameLeaseTerminationReceipt,
      quarantineReceipt,
      zeroResultAttestation
    });
    return {
      proof,
      writeFenceReceipt,
      sameLeaseTerminationReceipt,
      quarantineReceipt,
      zeroResultAttestation,
      paths,
      async cleanup(): Promise<void> {
        await makeOwnerWritableTree(fixtureRoot);
        await rm(fixtureRoot, { recursive: true, force: true });
      }
    };
  } catch (error) {
    await makeOwnerWritableTree(fixtureRoot).catch(() => undefined);
    await rm(fixtureRoot, { recursive: true, force: true });
    throw error;
  }
}

async function makeOwnerWritableTree(rootPath: string): Promise<void> {
  const stat = await lstat(rootPath).catch(() => undefined);
  if (!stat) return;
  if (!stat.isDirectory()) {
    await chmod(rootPath, 0o600);
    return;
  }
  await chmod(rootPath, 0o700);
  for (const entry of await readdir(rootPath)) {
    await makeOwnerWritableTree(path.join(rootPath, entry));
  }
}

function exactFenceTask(
  attempt: MaintenanceRoutingAttempt,
  leaseToken: string,
  paths: TrustedS2FixturePaths
): AgentTaskInput {
  return {
    prompt: "maintain",
    permission: "workspace-write",
    writableRoots: paths.writableRootPaths,
    requireExactWriteFence: true,
    exactWriteFence: {
      attemptToken: attempt.attemptId,
      leaseToken,
      deniedLivePaths: [paths.liveVaultPath],
      deniedControlPaths: [paths.controlRootPath]
    }
  };
}

function assertFallbackDoesNotInheritSelectedAgentModelOrSession(): void {
  const harnessSession = { id: "selected-agent-session" } as any;
  const overrides = {
    model: "selected-provider/model",
    reasoning: "high",
    serviceTier: "default",
    mcpEnabled: false,
    workspaceResources: { skills: false, mcp: false },
    codexInactivityTimeoutMs: 1234,
    workflowRunId: "kb-run-selected-agent",
    harnessSession
  } as any;

  assert.equal(
    maintenanceTurnOverridesForAttempt(overrides, "opencode", "opencode"),
    overrides
  );
  assert.deepEqual(
    maintenanceTurnOverridesForAttempt(overrides, "opencode", "codex-cli"),
    {
      model: "",
      reasoning: "high",
      serviceTier: "default",
      mcpEnabled: false,
      workspaceResources: { skills: false, mcp: false },
      codexInactivityTimeoutMs: 1234,
      workflowRunId: "kb-run-selected-agent"
    }
  );
}

async function assertSelectedFirstExecutionUsesOnlyOneAgentOnSuccess(): Promise<void> {
  const backends: AgentBackendKind[] = ["codex-cli", "opencode", "hermes"];
  // noop is a deterministic zero-source Harness outcome and must never be
  // produced by an Agent attempt.
  const completions: KnowledgeBaseRunCompletion[] = ["full", "recovered", "partial"];

  for (const selectedBackend of backends) {
    for (const completion of completions) {
      const called: AgentBackendKind[] = [];
      const readyChecks: AgentBackendKind[] = [];
      const attempts: any[] = [];
      const harnessRunId = `harness-${selectedBackend}-${completion}`;
      const result = await runSelectedMaintenanceAgentTask({
        workflowRunId: `selected-${selectedBackend}-${completion}`,
        selectedBackend,
        attempts,
        isBackendReady: async (backend) => {
          readyChecks.push(backend);
          return true;
        },
        execute: async (attempt) => {
          called.push(attempt.backend);
          return {
            output: {
              text: "ok",
              harnessRunId,
              submittedAt: 101
            },
            completion,
            verifiedSources: [],
            pendingSources: [],
            evidencePaths: {},
            appliedPaths: [],
            warnings: []
          };
        }
      });

      assert.deepEqual(
        called,
        [selectedBackend],
        `${selectedBackend}:${completion} must execute only the selected Agent`
      );
      assert.deepEqual(
        readyChecks,
        [],
        `${selectedBackend}:${completion} must not inspect standby readiness`
      );
      assert.equal(result.attempt.backend, selectedBackend);
      assert.equal(result.completion, completion);
      assert.equal(attempts.length, 1);
      assert.equal(attempts[0].terminal.status, "completed");
      assert.equal(attempts[0].submitted.harnessRunId, harnessRunId);
    }
  }
}

async function assertDeterministicNoopDoesNotStartAnyAgent(): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "echoink-maintenance-noop-"));
  const vaultPath = path.join(root, "vault");
  const previousHome = process.env.HOME;
  try {
    process.env.HOME = root;
    await mkdir(path.join(vaultPath, "raw"), { recursive: true });
    const settings = structuredClone(DEFAULT_SETTINGS);
    let running = false;
    let rulesChecks = 0;
    let readinessChecks = 0;
    let executeCalls = 0;
    let settingsGeneration = 0;
    let commitLocked = false;
    const settingsHost = {
      withExclusiveTransaction: async (action: any) => await action({
        readWithGeneration: () => ({
          settings: structuredClone(settings.knowledgeBase),
          generation: String(settingsGeneration)
        }),
        persistCas: (expectedGeneration: string, next: any) => {
          assert.equal(expectedGeneration, String(settingsGeneration));
          settings.knowledgeBase = structuredClone(next);
          settingsGeneration += 1;
          return {
            settings: structuredClone(settings.knowledgeBase),
            generation: String(settingsGeneration)
          };
        }
      })
    };
    const plugin = {
      settings,
      getVaultPath: () => vaultPath,
      getKnowledgeBaseWorkflowStorageRoot: () =>
        path.join(root, "maintenance-storage"),
      getKnowledgeBaseWorkflowSettingsHost: () => settingsHost,
      saveSettings: async () => undefined
    };
    const runner = new KnowledgeBaseMaintenanceRunner(plugin as any, {
      isRunning: () => running,
      beginRun: () => { running = true; },
      finishRun: () => {
        running = false;
        commitLocked = false;
      },
      isCancelRequested: () => false,
      tryEnterCommitPhase: () => {
        commitLocked = true;
        return true;
      },
      isCommitPhaseLocked: () => commitLocked,
      resolveRulesFile: async () => {
        rulesChecks += 1;
        throw new Error("deterministic noop must not resolve Agent rules");
      },
      isMaintenanceBackendReady: async () => {
        readinessChecks += 1;
        return true;
      },
      runKnowledgeAgentTask: async () => {
        executeCalls += 1;
        throw new Error("deterministic noop must not execute an Agent");
      }
    });

    const result = await runner.runMaintenance(
      "maintain",
      "/maintain deterministic empty Vault",
      { workflowRunId: "kb-run-noop" },
      "opencode"
    );

    assert.equal(result.status, "success", result.error);
    assert.equal(result.completion, "noop");
    assert.equal(result.workflowRunId, "kb-run-noop");
    assert.equal(result.selectedBackend, "opencode");
    assert.equal(result.winnerBackend, null);
    assert.equal(result.terminalPhase, "finalized");
    assert.equal(result.commitState, "committed");
    assert.equal(result.failureCode, null);
    assert.equal(
      settings.knowledgeBase.maintenanceHistory.at(-1)?.runId,
      "kb-run-noop"
    );
    assert.deepEqual(result.attempts, []);
    assert.deepEqual(
      settings.knowledgeBase.maintenanceHistory.at(-1),
      {
        ...settings.knowledgeBase.maintenanceHistory.at(-1),
        selectedBackend: "opencode",
        winnerBackend: null,
        attempts: [],
        failureCode: null,
        terminalPhase: "finalized"
      }
    );
    assert.equal(rulesChecks, 0, "zero-source noop must not resolve Agent-specific rules");
    assert.equal(readinessChecks, 0, "zero-source noop must not inspect any Agent readiness");
    assert.equal(executeCalls, 0, "zero-source noop must not execute any Agent");
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await makeOwnerWritableTree(root).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
}

async function assertSelectedFirstExecutionLazilyFallsBackAfterPreflightFailure(): Promise<void> {
  const called: string[] = [];
  const readyChecks: string[] = [];
  const attempts: any[] = [];
  const result = await runSelectedMaintenanceAgentTask({
    workflowRunId: "selected-fallback",
    selectedBackend: "opencode",
    attempts,
    isBackendReady: async (backend) => {
      readyChecks.push(backend);
      return backend === "hermes";
    },
    execute: async (attempt) => {
      called.push(attempt.backend);
      if (attempt.backend === "opencode") {
        throw new KnowledgeAgentAttemptError(
          "preflight",
          attempt.backend,
          attempt.workflowId,
          attempt.attemptId,
          attempt.ordinal,
          "harness-opencode",
          undefined,
          Object.assign(new Error("OpenCode Agent backend unavailable"), { code: "BACKEND_UNAVAILABLE" })
        );
      }
      return {
        output: { text: "fallback ok", harnessRunId: "harness-hermes", submittedAt: 202 },
        completion: "full",
        verifiedSources: [],
        pendingSources: [],
        evidencePaths: {},
        appliedPaths: [],
        warnings: []
      };
    }
  });

  assert.deepEqual(called, ["opencode", "hermes"]);
  assert.deepEqual(readyChecks, ["hermes"]);
  assert.equal(result.attempt.backend, "hermes");
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0].failure.failoverEligible, true);
  assert.equal(attempts[0].submitted, undefined);
  assert.equal(attempts[1].terminal.status, "completed");
}

async function assertRunnerFenceAckBeforePromptFailureCanSafelyFallBack(): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "echoink-maintenance-fence-preflight-"));
  const liveVaultPath = path.join(root, "vault");
  const shadowStorageRoot = path.join(root, "shadows");
  const rulesPath = path.join(liveVaultPath, "LLM-WIKI.md");
  try {
    await mkdir(path.join(liveVaultPath, "raw"), { recursive: true });
    await mkdir(path.join(liveVaultPath, "wiki"), { recursive: true });
    await mkdir(path.join(liveVaultPath, "projects"), { recursive: true });
    await mkdir(path.join(liveVaultPath, "outputs"), { recursive: true });
    await mkdir(path.join(liveVaultPath, "inbox"), { recursive: true });
    await writeFile(path.join(liveVaultPath, "raw", "index.md"), "# Raw\n", "utf8");
    await writeFile(rulesPath, "# Knowledge rules\n", "utf8");

    const executedBackends: string[] = [];
    const readinessChecks: string[] = [];
    const attempts: any[] = [];
    let commitLocked = false;
    const runner = new KnowledgeBaseMaintenanceRunner({} as any, {
      isRunning: () => false,
      beginRun: () => undefined,
      finishRun: () => { commitLocked = false; },
      isCancelRequested: () => false,
      tryEnterCommitPhase: () => {
        commitLocked = true;
        return true;
      },
      isCommitPhaseLocked: () => commitLocked,
      resolveRulesFile: async () => ({
        relativePath: "LLM-WIKI.md",
        absolutePath: rulesPath,
        exists: true,
        useCustomRulesFile: false
      }),
      isMaintenanceBackendReady: async () => true,
      runKnowledgeAgentTask: async (input: any) => {
        const backend = input.backend as "opencode" | "hermes";
        executedBackends.push(backend);
        const receipt = createExactWriteFenceReceipt({
          backend,
          task: {
            prompt: input.prompt,
            permission: input.permission,
            writableRoots: input.writableRootsOverride,
            requireExactWriteFence: true,
            exactWriteFence: input.exactWriteFence
          },
          transport: "test-fence-before-prompt",
          transportAck: { accepted: true }
        });
        await input.onExactWriteFenceConfigured(receipt);
        if (backend === "opencode") {
          throw new KnowledgeAgentAttemptError(
            "preflight",
            backend,
            input.workflowRunId,
            input.attemptId,
            input.attemptOrdinal,
            "harness-preflight-after-fence",
            undefined,
            Object.assign(new Error("OpenCode prompt transport unavailable before submission"), {
              code: "BACKEND_UNAVAILABLE"
            })
          );
        }
        return {
          text: "fallback completed",
          harnessRunId: "harness-hermes-fallback",
          submittedAt: 505
        };
      }
    });

    const result = await runSelectedMaintenanceAgentTask({
      workflowRunId: "runner-fence-preflight-fallback",
      selectedBackend: "opencode",
      attempts,
      isBackendReady: async (backend) => {
        readinessChecks.push(backend);
        return backend === "hermes";
      },
      execute: async (attempt) => await (runner as any).executeMaintenanceShadowAttempt({
        attempt,
        selectedBackend: "opencode",
        liveVaultPath,
        shadowStorageRoot,
        mode: "lint",
        userRequest: "/check",
        requestedRawPaths: [],
        reportPath: "outputs/maintenance/kb-check-fence-preflight.md",
        reportMtimeBefore: null,
        sources: [],
        skippedSources: [],
        remainingSourceCount: 0,
        rules: {
          relativePath: "LLM-WIKI.md",
          absolutePath: rulesPath,
          exists: true,
          useCustomRulesFile: false
        },
        processedSourcesBeforeRun: {}
      })
    });

    assert.deepEqual(executedBackends, ["opencode", "hermes"]);
    assert.deepEqual(readinessChecks, ["hermes"]);
    assert.equal(result.attempt.backend, "hermes");
    assert.equal(result.completion, "recovered");
    assert.equal(attempts.length, 2);
    assert.equal(attempts[0].submitted, undefined);
    assert.equal(attempts[0].failure.failoverEligible, true);
    assert.equal(attempts[0].failure.phase, "preflight");
    assert.equal(attempts[0].staging.failedAt > 0, true);
    assert.equal(attempts[1].staging.preparedAt > 0, true);
    assert.equal(attempts[1].terminal.status, "completed");
  } finally {
    await makeOwnerWritableTree(root).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
}

async function assertSubmittedFailureCannotStartStandbyAgent(): Promise<void> {
  const called: string[] = [];
  const readyChecks: string[] = [];
  const attempts: any[] = [];
  const terminationConfirmedAt = 404;
  await assert.rejects(
    runSelectedMaintenanceAgentTask({
      workflowRunId: "submitted-timeout",
      selectedBackend: "codex-cli",
      attempts,
      isBackendReady: async (backend) => {
        readyChecks.push(backend);
        return true;
      },
      execute: async (attempt) => {
        called.push(attempt.backend);
        throw new KnowledgeAgentAttemptError(
          "execution",
          attempt.backend,
          attempt.workflowId,
          attempt.attemptId,
          attempt.ordinal,
          "harness-codex",
          303,
          Object.assign(new Error("Codex timed out"), { code: "ETIMEDOUT" }),
          terminationConfirmedAt,
          "native-codex-timeout"
        );
      }
    }),
    (error) => error instanceof MaintenanceAgentRoutingError
      && error.failure.category === "timeout"
      && error.failure.failoverEligible === true
  );
  assert.deepEqual(called, ["codex-cli"]);
  assert.deepEqual(readyChecks, [], "submitted failure without trusted S2 proof must not inspect standby readiness");
  assert.equal(attempts[0].submitted.at, 303);
  assert.equal(attempts[0].failure.phase, "execution");
  assert.equal(attempts[0].native.id, "native-codex-timeout");
  assert.equal(attempts[0].native.kind, undefined);
  assert.equal(attempts[0].termination.confirmedAt, terminationConfirmedAt);
}

async function assertRunnerAbortWithoutNativeAckNeverChecksStandby(): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "echoink-maintenance-no-abort-ack-"));
  const liveVaultPath = path.join(root, "vault");
  const shadowStorageRoot = path.join(root, "shadows");
  const rulesPath = path.join(liveVaultPath, "LLM-WIKI.md");
  try {
    await mkdir(path.join(liveVaultPath, "raw"), { recursive: true });
    await mkdir(path.join(liveVaultPath, "wiki"), { recursive: true });
    await mkdir(path.join(liveVaultPath, "projects"), { recursive: true });
    await mkdir(path.join(liveVaultPath, "outputs"), { recursive: true });
    await mkdir(path.join(liveVaultPath, "inbox"), { recursive: true });
    await writeFile(path.join(liveVaultPath, "raw", "index.md"), "# Raw\n", "utf8");
    await writeFile(rulesPath, "# Knowledge rules\n", "utf8");

    const executedBackends: string[] = [];
    const readinessChecks: string[] = [];
    const attempts: any[] = [];
    let commitLocked = false;
    const runner = new KnowledgeBaseMaintenanceRunner({} as any, {
      isRunning: () => false,
      beginRun: () => undefined,
      finishRun: () => { commitLocked = false; },
      isCancelRequested: () => false,
      tryEnterCommitPhase: () => {
        commitLocked = true;
        return true;
      },
      isCommitPhaseLocked: () => commitLocked,
      resolveRulesFile: async () => ({
        relativePath: "LLM-WIKI.md",
        absolutePath: rulesPath,
        exists: true,
        useCustomRulesFile: false
      }),
      isMaintenanceBackendReady: async () => true,
      runKnowledgeAgentTask: async (input: any) => {
        const backend = input.backend as "opencode";
        executedBackends.push(backend);
        const receipt = createExactWriteFenceReceipt({
          backend,
          task: {
            prompt: input.prompt,
            permission: input.permission,
            writableRoots: input.writableRootsOverride,
            requireExactWriteFence: true,
            exactWriteFence: input.exactWriteFence
          },
          transport: "test-no-abort-ack",
          transportAck: { accepted: true }
        });
        await input.onExactWriteFenceConfigured(receipt);
        throw new KnowledgeAgentAttemptError(
          "execution",
          backend,
          input.workflowRunId,
          input.attemptId,
          input.attemptOrdinal,
          "harness-no-abort-ack",
          404,
          Object.assign(new Error("OpenCode transport timed out without abort acknowledgement"), {
            code: "ETIMEDOUT"
          }),
          undefined,
          "native-run-without-termination-receipt"
        );
      }
    });

    await assert.rejects(
      runSelectedMaintenanceAgentTask({
        workflowRunId: "runner-no-abort-ack",
        selectedBackend: "opencode",
        attempts,
        isBackendReady: async (backend) => {
          readinessChecks.push(backend);
          return true;
        },
        execute: async (attempt) => await (runner as any).executeMaintenanceShadowAttempt({
          attempt,
          selectedBackend: "opencode",
          liveVaultPath,
          shadowStorageRoot,
          mode: "lint",
          userRequest: "/check",
          requestedRawPaths: [],
          reportPath: "outputs/maintenance/kb-check-no-abort-ack.md",
          reportMtimeBefore: null,
          sources: [],
          skippedSources: [],
          remainingSourceCount: 0,
          rules: {
            relativePath: "LLM-WIKI.md",
            absolutePath: rulesPath,
            exists: true,
            useCustomRulesFile: false
          },
          processedSourcesBeforeRun: {}
        })
      }),
      (error) => error instanceof MaintenanceAgentRoutingError
        && error.failure.category === "timeout"
        && error.failure.failoverEligible === true
    );
    assert.deepEqual(executedBackends, ["opencode"]);
    assert.deepEqual(
      readinessChecks,
      [],
      "a Runner timeout without same-lease native termination acknowledgement must not inspect standby readiness"
    );
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].submitted.at, 404);
    assert.equal(attempts[0].failure.phase, "execution");
    assert.equal(attempts[0].native.id, "native-run-without-termination-receipt");
    const stagedRelativePath = path.relative(
      await realpath(shadowStorageRoot),
      await realpath(attempts[0].staging.path)
    );
    assert.equal(stagedRelativePath.startsWith(".."), false);
    assert.equal(attempts[0].staging.failedAt > 0, true);
    assert.equal(attempts[0].terminal.status, "failed");
  } finally {
    await makeOwnerWritableTree(root).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
}

async function assertCommitPhaseNeverReopensFailover(): Promise<void> {
  const executedBackends: string[] = [];
  const readinessChecks: string[] = [];
  const attempts: any[] = [];
  let fixture: Awaited<ReturnType<typeof createTrustedS2ProofFixture>> | null = null;
  try {
    await assert.rejects(
      runSelectedMaintenanceAgentTask({
        workflowRunId: "wal-commit-point-no-failover",
        selectedBackend: "opencode",
        attempts,
        isBackendReady: async (backend) => {
          readinessChecks.push(backend);
          return true;
        },
        execute: async (attempt) => {
          executedBackends.push(attempt.backend);
          fixture = await createTrustedS2ProofFixture(attempt);
          throw new MaintenanceShadowAttemptError(
            Object.assign(
              new Error("transport timeout after workflow WAL commit intent"),
              { code: "ETIMEDOUT" }
            ),
            fixture.writeFenceReceipt,
            fixture.zeroResultAttestation,
            fixture.sameLeaseTerminationReceipt.terminatedAt,
            "commit",
            fixture.proof,
            606
          );
        }
      }),
      (error) => error instanceof MaintenanceAgentRoutingError
        && error.failure.phase === "commit"
        && error.failure.category === "timeout"
        && error.failure.failoverEligible === false
    );
    assert.deepEqual(executedBackends, ["opencode"]);
    assert.deepEqual(
      readinessChecks,
      [],
      "a persisted WAL/commit-phase failure must never inspect standby readiness, even with a previously valid S2 proof"
    );
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].failure.phase, "commit");
    assert.equal(attempts[0].failure.failoverEligible, false);
  } finally {
    await fixture?.cleanup();
  }
}

async function assertUnknownPreflightFailureFailsClosed(): Promise<void> {
  const called: string[] = [];
  const readyChecks: string[] = [];
  await assert.rejects(
    runSelectedMaintenanceAgentTask({
      workflowRunId: "unknown-preflight",
      selectedBackend: "opencode",
      attempts: [],
      isBackendReady: async (backend) => {
        readyChecks.push(backend);
        return true;
      },
      execute: async (attempt) => {
        called.push(attempt.backend);
        throw new Error("unexpected preflight parser state");
      }
    }),
    (error) => error instanceof MaintenanceAgentRoutingError
      && error.failure.category === "unknown"
      && error.failure.failoverEligible === false
  );
  assert.deepEqual(called, ["opencode"]);
  assert.deepEqual(readyChecks, [], "unknown preflight failure must fail closed before standby readiness");
}

async function assertGenericBackendPreflightFailureIsStructured(): Promise<void> {
  const settings = structuredClone(DEFAULT_SETTINGS);
  const controller = new KnowledgeAgentRuntimeController({
    settings,
    vaultPath: () => "/vault/live",
    saveSettings: async () => undefined,
    isCanceled: () => false,
    harness: () => ({
      vaultPath: "/vault/live",
      cwd: "/vault/live",
      runWithAdapter: async () => {
        throw new Error("must not run");
      }
    })
  });
  (controller as any).createRuntime = () => ({
    kind: "opencode",
    connect: async () => {
      throw new Error("OpenCode SSE 在就绪前已断开");
    },
    disconnect: async () => undefined,
    listModels: async () => [],
    runTask: async () => ({ text: "" }),
    abort: async () => undefined
  });

  let structuredError: unknown;
  await assert.rejects(
    controller.preflight({
      backend: "opencode",
      sources: [],
      vaultPathOverride: "/tmp/maintenance-shadow"
    }),
    (error) => {
      structuredError = error;
      return error instanceof Error
        && (error as Error & { code?: string }).code === "BACKEND_UNAVAILABLE"
        && /OpenCode SSE 在就绪前已断开/.test(error.message);
    }
  );
  const failure = classifyMaintenanceFailure({
    phase: "preflight",
    error: structuredError
  });
  assert.equal(failure.category, "backend-unavailable");
  assert.equal(failure.failoverEligible, true);
}

async function assertMaintenanceAttemptWithoutShadowFailsClosed(): Promise<void> {
  const liveVault = "/vault/live";
  const settings = structuredClone(DEFAULT_SETTINGS);
  const service = new KnowledgeBaseAgentTaskService({
    settings,
    getVaultPath: () => liveVault
  } as any, {
    isCancelRequested: () => false
  });
  let preflightCalls = 0;
  let runCalls = 0;
  (service as any).runtimeController.preflight = async () => { preflightCalls += 1; };
  (service as any).runtimeController.run = async () => {
    runCalls += 1;
    return { text: "must not run" };
  };

  await assert.rejects(
    service.runTask({
      backend: "opencode",
      prompt: "maintain",
      sources: [],
      permission: "workspace-write",
      codexWriteScope: "knowledge-base",
      managedKind: "maintain",
      workflowRunId: "missing-shadow",
      attemptId: "missing-shadow-attempt-1-opencode",
      attemptOrdinal: 1
    }),
    (error) => error instanceof KnowledgeAgentAttemptError
      && error.phase === "preflight"
      && error.code === "UNSAFE_VAULT"
  );
  assert.equal(preflightCalls, 0);
  assert.equal(runCalls, 0);
}

async function assertMaintenanceManagedKindsCannotDowngradeWithoutIdentity(): Promise<void> {
  const liveVault = "/vault/live";
  const backends: AgentBackendKind[] = ["codex-cli", "opencode", "hermes"];
  const managedKinds = ["maintain", "reingest", "lint", "outputs", "inbox"] as const;
  const incompleteIdentities = [
    { label: "all-missing", value: {} },
    {
      label: "workflow-missing",
      value: { attemptId: "identity-attempt-1", attemptOrdinal: 1 }
    },
    {
      label: "attempt-missing",
      value: { workflowRunId: "identity-workflow", attemptOrdinal: 1 }
    },
    {
      label: "ordinal-missing",
      value: { workflowRunId: "identity-workflow", attemptId: "identity-attempt-1" }
    }
  ] as const;

  for (const backend of backends) {
    for (const managedKind of managedKinds) {
      for (const identity of incompleteIdentities) {
        const settings = structuredClone(DEFAULT_SETTINGS);
        const service = new KnowledgeBaseAgentTaskService({
          settings,
          getVaultPath: () => liveVault
        } as any, {
          isCancelRequested: () => false
        });
        let preflightCalls = 0;
        let runCalls = 0;
        (service as any).runtimeController.preflight = async () => {
          preflightCalls += 1;
        };
        (service as any).runtimeController.run = async () => {
          runCalls += 1;
          return { text: "must not run" };
        };
        const label = `${backend}:${managedKind}:${identity.label}`;

        await assert.rejects(
          service.runTask({
            backend,
            prompt: managedKind,
            sources: [],
            permission: "workspace-write",
            codexWriteScope: "knowledge-base",
            managedKind,
            ...identity.value
          }),
          (error) =>
            error instanceof Error
            && (error as Error & { code?: string }).code === "UNSAFE_VAULT",
          label
        );
        assert.equal(preflightCalls, 0, `${label} must not preflight a generic runtime`);
        assert.equal(runCalls, 0, `${label} must not run a generic runtime`);
      }
    }
  }
}

async function assertUnknownManagedKindCannotReachAnyRuntime(): Promise<void> {
  const backends: AgentBackendKind[] = ["codex-cli", "opencode", "hermes"];
  for (const backend of backends) {
    const service = new KnowledgeBaseAgentTaskService({
      settings: structuredClone(DEFAULT_SETTINGS),
      getVaultPath: () => "/vault/live"
    } as any, {
      isCancelRequested: () => false
    });
    let preflightCalls = 0;
    let runCalls = 0;
    (service as any).runtimeController.preflight = async () => {
      preflightCalls += 1;
    };
    (service as any).runtimeController.run = async () => {
      runCalls += 1;
      return { text: "must not run" };
    };

    await assert.rejects(
      service.runTask({
        backend,
        prompt: "unknown",
        sources: [],
        permission: "workspace-write",
        codexWriteScope: "knowledge-base",
        managedKind: "unknown"
      }),
      (error) =>
        error instanceof Error
        && (error as Error & { code?: string }).code === "UNSAFE_VAULT"
    );
    assert.equal(preflightCalls, 0, `${backend}:unknown must not preflight a runtime`);
    assert.equal(runCalls, 0, `${backend}:unknown must not execute a runtime`);
  }
}

async function assertLiveAttachmentIsRejectedBeforeAnyBackendPreflight(): Promise<void> {
  const liveVault = "/vault/live";
  const shadowVault = "/tmp/echoink-shadow/agent-vault";
  const settings = structuredClone(DEFAULT_SETTINGS);
  const service = new KnowledgeBaseAgentTaskService({
    settings,
    getVaultPath: () => liveVault
  } as any, {
    isCancelRequested: () => false
  });
  let preflightCalls = 0;
  let runCalls = 0;
  (service as any).runtimeController.preflight = async () => { preflightCalls += 1; };
  (service as any).runtimeController.run = async () => {
    runCalls += 1;
    return { text: "must not run" };
  };

  await assert.rejects(
    service.runTask({
      backend: "opencode",
      prompt: "maintain",
      sources: [{
        relativePath: "raw/live.md",
        absolutePath: `${liveVault}/raw/live.md`,
        size: 1,
        mtime: 1,
        fingerprint: "live",
        mime: "text/markdown",
        modality: "text",
        changed: true
      }],
      permission: "workspace-write",
      codexWriteScope: "knowledge-base",
      managedKind: "maintain",
      workflowRunId: "isolation-reject",
      attemptId: "isolation-reject-attempt-1-opencode",
      attemptOrdinal: 1,
      vaultPathOverride: shadowVault
    }),
    (error) => error instanceof KnowledgeAgentAttemptError
      && error.phase === "preflight"
      && error.code === "UNSAFE_VAULT"
  );
  assert.equal(preflightCalls, 0);
  assert.equal(runCalls, 0);
}

async function assertShadowOverrideReachesRuntimeAndHarnessBoundaries(): Promise<void> {
  const liveVault = "/vault/live";
  const shadowVault = "/tmp/echoink-shadow/agent-vault";
  const shadowSource = `${shadowVault}/raw/remapped.md`;
  const exactWriteRoots = [
    `${shadowVault}/wiki`,
    `${shadowVault}/projects`,
    `${shadowVault}/outputs`,
    `${shadowVault}/inbox`
  ];
  const settings = structuredClone(DEFAULT_SETTINGS);
  let runtimeVault = "";
  let harnessVault = "";
  let capturedRequest: any = null;
  const runtime = {
    kind: "opencode" as const,
    connect: async () => ({ connected: true, label: "OpenCode", errors: [] }),
    disconnect: async () => undefined,
    listModels: async () => [{
      id: "test/text",
      providerId: "test",
      modelId: "text",
      displayName: "Test Text",
      inputModalities: ["text" as const]
    }],
    runTask: async () => ({ text: "ok", runId: "shadow-run" }),
    abort: async () => undefined
  };
  const controller = new KnowledgeAgentRuntimeController({
    settings,
    vaultPath: () => liveVault,
    saveSettings: async () => undefined,
    isCanceled: () => false,
    harness: (override) => {
      harnessVault = override ?? liveVault;
      return {
        vaultPath: harnessVault,
        cwd: harnessVault,
        runWithAdapter: async (input) => {
          capturedRequest = input.request;
          return {
            status: "completed",
            outputText: "ok"
          } as any;
        }
      };
    }
  });
  (controller as any).createRuntime = (_backend: string, override?: string) => {
    runtimeVault = override ?? liveVault;
    return runtime;
  };

  await controller.run({
    backend: "opencode",
    prompt: "maintain",
    sources: [{
      relativePath: "raw/remapped.md",
      absolutePath: shadowSource,
      size: 1,
      mtime: 1,
      fingerprint: "shadow",
      mime: "text/markdown",
      modality: "text",
      changed: true
    }],
    permission: "workspace-write",
    workflow: "knowledge.maintain",
    outputKind: "knowledge-ledger",
    vaultPathOverride: shadowVault,
    writableRootsOverride: exactWriteRoots
  });

  assert.equal(runtimeVault, shadowVault);
  assert.equal(harnessVault, shadowVault);
  assert.equal(capturedRequest.workspace.vaultPath, shadowVault);
  assert.equal(capturedRequest.workspace.cwd, shadowVault);
  assert.deepEqual(capturedRequest.permissions.writableRoots, exactWriteRoots);
  assert.deepEqual(capturedRequest.input.attachments.map((item: any) => item.path), [shadowSource]);
  assert.equal(JSON.stringify(capturedRequest).includes(liveVault), false);
}

async function assertServicePreservesShadowOverrideAndExactWriteRoots(): Promise<void> {
  const liveVault = "/vault/live";
  const shadowVault = "/tmp/echoink-shadow/agent-vault";
  const settings = structuredClone(DEFAULT_SETTINGS);
  const service = new KnowledgeBaseAgentTaskService({
    settings,
    getVaultPath: () => liveVault
  } as any, {
    isCancelRequested: () => false
  });
  let preflightInput: any = null;
  let runtimeInput: any = null;
  let harnessOptions: any = null;
  const controller = (service as any).runtimeController;
  controller.preflight = async (input: any) => { preflightInput = input; };
  controller.run = async (input: any) => {
    runtimeInput = input;
    harnessOptions = controller.options.harness(input.vaultPathOverride);
    input.onSubmitted?.();
    return { text: "ok" };
  };

  await service.runTask({
    backend: "opencode",
    prompt: "maintain",
    sources: [{
      relativePath: "raw/remapped.md",
      absolutePath: `${shadowVault}/raw/remapped.md`,
      size: 1,
      mtime: 1,
      fingerprint: "shadow",
      mime: "text/markdown",
      modality: "text",
      changed: true
    }],
    permission: "workspace-write",
    codexWriteScope: "knowledge-base",
    managedKind: "maintain",
    workflowRunId: "isolation-forward",
    attemptId: "isolation-forward-attempt-1-opencode",
    attemptOrdinal: 1,
    vaultPathOverride: shadowVault
  });

  const expectedWriteRoots = [
    `${shadowVault}/wiki`,
    `${shadowVault}/projects`,
    `${shadowVault}/outputs/maintenance`,
    `${shadowVault}/inbox`
  ];
  assert.equal(preflightInput.vaultPathOverride, shadowVault);
  assert.equal(runtimeInput.vaultPathOverride, shadowVault);
  assert.deepEqual(runtimeInput.writableRootsOverride, expectedWriteRoots);
  assert.equal(runtimeInput.requireExactWriteFence, true);
  assert.equal(harnessOptions.vaultPath, shadowVault);
  assert.equal(harnessOptions.cwd, shadowVault);
  assert.equal(JSON.stringify({ preflightInput, runtimeInput, harnessOptions }).includes(liveVault), false);
}

async function assertMaintenanceWritableRootsRejectNonAllowlistedPaths(): Promise<void> {
  const liveVault = "/vault/live";
  const shadowVault = "/tmp/echoink-shadow/agent-vault";
  const invalidRoots = [
    shadowVault,
    `${shadowVault}/raw`,
    `${shadowVault}/LLM-WIKI.md`,
    `${shadowVault}/.obsidian`,
    `${shadowVault}/outputs/.ingest-tracker.md`,
    `${shadowVault}/wiki/topic`,
    "/tmp/outside-shadow"
  ];

  for (const [index, writableRoot] of invalidRoots.entries()) {
    const settings = structuredClone(DEFAULT_SETTINGS);
    const service = new KnowledgeBaseAgentTaskService({
      settings,
      getVaultPath: () => liveVault
    } as any, {
      isCancelRequested: () => false
    });
    let preflightCalls = 0;
    const controller = (service as any).runtimeController;
    controller.preflight = async () => { preflightCalls += 1; };
    controller.run = async () => ({ text: "must not run" });

    await assert.rejects(
      service.runTask({
        backend: "opencode",
        prompt: "maintain",
        sources: [{
          relativePath: "raw/remapped.md",
          absolutePath: `${shadowVault}/raw/remapped.md`,
          size: 1,
          mtime: 1,
          fingerprint: "shadow",
          mime: "text/markdown",
          modality: "text",
          changed: true
        }],
        permission: "workspace-write",
        codexWriteScope: "knowledge-base",
        managedKind: "maintain",
        workflowRunId: `invalid-roots-${index}`,
        attemptId: `invalid-roots-${index}-attempt-1-opencode`,
        attemptOrdinal: 1,
        vaultPathOverride: shadowVault,
        writableRootsOverride: [writableRoot]
      }),
      (error) => error instanceof KnowledgeAgentAttemptError
        && error.phase === "preflight"
        && error.code === "UNSAFE_VAULT",
      writableRoot
    );
    assert.equal(preflightCalls, 0, writableRoot);
  }
}
