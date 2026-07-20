import * as assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type {
  AgentAdapter,
  AgentConnectContext,
  AgentConnectionStatus,
  AgentManifest,
  AgentRunRequest,
  AgentRunResult
} from "../../harness/agents/adapter";
import { CodexRichAgentAdapter } from "../../harness/agents/adapters/codex-rich-adapter";
import { noCapabilities } from "../../harness/contracts/capability";
import { emptyContextBundle } from "../../harness/contracts/context";
import type { HarnessEvent, HarnessEventSink } from "../../harness/contracts/event";
import type {
  MemoryTransactionAuthorityReceipt,
  NativeExecutionDispositionRequest,
  NativeExecutionDispositionResult,
  NativeExecutionRecord,
  NativeExecutionRef
} from "../../harness/contracts/native-execution";
import type { HarnessRunRequest } from "../../harness/contracts/run";
import type { CreateHarnessAgentAdapterInput } from "../../harness/agents/adapter-factory";
import { EchoInkHarnessKernel } from "../../harness/kernel/harness-kernel";
import { InMemoryRunLedger } from "../../harness/ledger/run-ledger";
import { NoopMemoryProvider } from "../../harness/memory/noop-provider";
import {
  validateMemoryCuratorResult,
  type MemoryCuratorRequest
} from "../../harness/memory/v2-engine";
import {
  type EphemeralUtilityLifecycleHost,
  type EphemeralUtilityWorkflow,
  runEphemeralUtility
} from "../../harness/native/ephemeral-utility-lifecycle";
import {
  backendProbeContainsToken,
  runBackendProbe
} from "../../harness/native/backend-probe-lifecycle";
import { canonicalProviderEndpointIdentity } from "../../harness/native/provider-endpoint-identity";
import {
  NativeExecutionManager,
  type NativeCleanupResult,
  type SettleNativeExecutionInput
} from "../../harness/native/native-execution-manager";
import { NativeExecutionStore } from "../../harness/native/native-execution-store";
import { EchoInkHarnessService } from "../../plugin/harness-service";
import { validatePromptEnhancerCandidateOutput } from "../../prompt-enhancer/service";
import {
  DEFAULT_SETTINGS,
  type CodexForObsidianSettings
} from "../../settings/settings";

type UtilityStatus = "completed" | "failed" | "cancelled";

export async function runEphemeralUtilityNativeLifecycleTests(): Promise<void> {
  await assertUtilityLifecycleMatrix();
  await assertCanonicalProviderEndpointIdentityIsSafeAndStable();
  await assertHarnessServiceSharesCanonicalEndpointWithCleanupAdapter();
  await assertBackendProbeUsesAuditableEphemeralLifecycle();
  await assertBackendProbeSettingsAreIsolatedOnFailureAndCancellation();
  await assertBackendProbeRejectsMismatchedRuntimeEndpoint();
  await assertBackendProbeSanitizesNativeEndpointIdentity();
  await assertBackendProbeSetModelFailureSettlesRegisteredNative();
  await assertPromptEnhancerValidationPrecedesCompletedTerminal();
  await assertMemoryCuratorValidationPrecedesCompletedTerminal();
  await assertStartTimeoutCancelsAndDrainsRegistration();
  await assertPreStartAbortSkipsHarnessExecution();
  await assertAbortAfterValidationWinsBeforeCompletedTerminal();
  await assertCodexRegistrationFailureArchivesExactlyOnceBeforePrompt();
  await assertTerminalFailureRetainsRecoveryRecord();
  await assertDeferredMemorySettlementWaitsForExactDurableAuthority();
  await assertCleanupFailureDoesNotReverseCompletedResult();
}

async function assertCanonicalProviderEndpointIdentityIsSafeAndStable(): Promise<void> {
  assert.equal(
    canonicalProviderEndpointIdentity("HTTP://OpenCode.Example:80/"),
    "http://opencode.example",
    "a bare origin may remain readable after URL normalization"
  );
  const sensitive =
    "https://user:password@opencode.example/v1?token=sk-secret#private";
  const identity = canonicalProviderEndpointIdentity(sensitive);
  assert.match(identity, /^endpoint-sha256:[a-f0-9]{64}$/);
  assert.equal(
    canonicalProviderEndpointIdentity(identity),
    identity,
    "a durable endpoint digest must be idempotent"
  );
  assert.notEqual(
    canonicalProviderEndpointIdentity(
      "https://user:password@opencode.example/v1?token=another-secret#private"
    ),
    identity,
    "different scoped credentials must not collapse to one cleanup identity"
  );
  const opaque = canonicalProviderEndpointIdentity("sk-secret-token");
  assert.match(
    opaque,
    /^endpoint-sha256:[a-f0-9]{64}$/,
    "an unknown opaque value must be digested instead of persisted verbatim"
  );
  for (const secret of [
    "user",
    "password",
    "token",
    "sk-secret",
    "private"
  ]) {
    assert.equal(identity.includes(secret), false);
    assert.equal(opaque.includes(secret), false);
  }
  assert.equal(
    canonicalProviderEndpointIdentity("codex-login"),
    "codex-login"
  );
  assert.equal(
    canonicalProviderEndpointIdentity(
      "hermes-acp+stdio://local/probe-profile"
    ),
    "hermes-acp+stdio://local/probe-profile"
  );
}

async function assertHarnessServiceSharesCanonicalEndpointWithCleanupAdapter(): Promise<void> {
  const settings = cloneSettings();
  const codexEndpoint =
    "https://codex-user:codex-password@api.example/v1?token=codex-secret#scope";
  const openCodeEndpoint =
    "https://open-user:open-password@opencode.example/v1?token=open-secret#scope";
  settings.providerMode = "custom-api";
  settings.activeApiProviderId = "provider-sensitive";
  settings.apiProviders = [{
    id: "provider-sensitive",
    name: "Sensitive provider",
    baseUrl: codexEndpoint,
    model: "test-model",
    models: ["test-model"],
    apiKey: "api-key-that-must-not-be-a-native-identity"
  }];
  settings.opencode.serverUrl = openCodeEndpoint;
  const archived: string[] = [];
  const service = new EchoInkHarnessService({
    settings,
    getVaultPath: () => "/vault",
    getPluginDataDirName: () => "codex-echoink",
    ensureHarnessBackendConnected: async () => ({
      connected: true,
      errors: []
    })
  } as never);
  service.archiveCodexThread = async (threadId: string) => {
    archived.push(threadId);
  };

  const codexContext = service.getNativeExecutionRefContext("codex-cli");
  const openCodeContext = service.getNativeExecutionRefContext("opencode");
  assert.equal(
    codexContext.providerEndpoint,
    canonicalProviderEndpointIdentity(codexEndpoint)
  );
  assert.equal(
    openCodeContext.providerEndpoint,
    canonicalProviderEndpointIdentity(openCodeEndpoint)
  );
  const persistedContexts = JSON.stringify({
    codexContext,
    openCodeContext
  });
  for (const secret of [
    "codex-user",
    "codex-password",
    "codex-secret",
    "open-user",
    "open-password",
    "open-secret"
  ]) {
    assert.equal(
      persistedContexts.includes(secret),
      false,
      `Harness Native context must not persist ${secret}`
    );
  }

  const cleanupAdapter = (
    service as unknown as {
      createNativeCleanupAdapter(backendId: "codex-cli"): AgentAdapter;
    }
  ).createNativeCleanupAdapter("codex-cli");
  const connection = await cleanupAdapter.connect({
    runId: "run-canonical-cleanup",
    sessionId: "session-canonical-cleanup",
    workspace: { vaultPath: "/vault", cwd: "/vault" }
  });
  assert.equal(connection.connected, true);
  const canonicalRef: NativeExecutionRef = {
    backendId: "codex-cli",
    id: "thread-canonical-cleanup",
    kind: "thread",
    persistence: "provider-persistent",
    ...codexContext,
    createdAt: 1
  };
  const mismatched = await cleanupAdapter.disposeNativeExecution?.({
    ref: { ...canonicalRef, providerEndpoint: codexEndpoint },
    requested: "archive",
    reason: "manual"
  });
  assert.equal(mismatched?.outcome, "retained");
  assert.deepEqual(archived, []);
  const disposed = await cleanupAdapter.disposeNativeExecution?.({
    ref: canonicalRef,
    requested: "archive",
    reason: "manual"
  });
  assert.deepEqual(disposed, {
    outcome: "disposed",
    applied: "archive"
  });
  assert.deepEqual(archived, ["thread-canonical-cleanup"]);
  await cleanupAdapter.dispose();
}

async function assertBackendProbeUsesAuditableEphemeralLifecycle(): Promise<void> {
  assert.equal(backendProbeContainsToken("PONG", "PONG"), true);
  assert.equal(backendProbeContainsToken("```text\nPONG\n```", "PONG"), true);
  assert.equal(
    backendProbeContainsToken(
      "Cannot comply; requested PONG",
      "PONG"
    ),
    false,
    "a probe must not verify a sentence that merely mentions the token"
  );
  assert.equal(
    backendProbeContainsToken("pong", "PONG"),
    false,
    "a probe token is case-sensitive"
  );
  assert.equal(
    backendProbeContainsToken("PONG.", "PONG"),
    false,
    "a probe token cannot contain punctuation or commentary"
  );
  assert.equal(
    backendProbeContainsToken("PONG\nPONG", "PONG"),
    false,
    "a probe token must be the only normalized response"
  );
  for (const backend of ["opencode", "hermes"] as const) {
    const requestedModel = {
      providerId: `${backend}-provider`,
      modelId: `${backend}-model`
    };
    const fixture = await createFixture({
      backend,
      asynchronous: false,
      status: "completed",
      workflow: "backend.probe",
      outputText: `${backend.toUpperCase()}_PONG`,
      effectiveModel: requestedModel
    });
    let adapterInput: CreateHarnessAgentAdapterInput | null = null;
    const liveSettings = cloneSettings();
    if (backend === "opencode") {
      liveSettings.opencode.serverUrl = "http://opencode.test";
    }
    try {
      const expectedToken = `${backend.toUpperCase()}_PONG`;
      const result = await runBackendProbe({
        host: fixture.host,
        backendId: backend,
        settings: liveSettings,
        vaultPath: "/vault",
        nativeRefContext: {
          deviceKey: "device-test",
          vaultId: "/vault",
          providerEndpoint: `http://${backend}.test`
        },
        prompt: `只回复 ${expectedToken}`,
        expectedToken,
        failureMessage: `${backend} probe failed`,
        timeoutMs: 60_000,
        model: requestedModel,
        ...(backend === "opencode"
          ? { agent: "build" }
          : { profile: "probe-profile" })
      }, {
        createAdapter: (input) => {
          adapterInput = input;
          return fixture.adapter;
        },
        createRunId: () => `run-backend-probe-${backend}`
      });

      assert.equal(result.runId, `run-backend-probe-${backend}`);
      assert.equal(result.text, expectedToken);
      assert.deepEqual(result.testedConfig.requestedModel, requestedModel);
      assert.deepEqual(result.testedConfig.effectiveModel, requestedModel);
      assert.equal(
        result.testedConfig.transport.kind,
        backend === "hermes"
          ? "hermes-acp-stdio"
          : "opencode-http"
      );
      assert.equal(adapterInput?.backendId, backend);
      assert.equal(
        adapterInput?.task?.requireNativeRegistrationBeforePrompt,
        true
      );
      assert.notEqual(
        adapterInput?.settings,
        liveSettings,
        "probe runtime must never receive the live settings object"
      );
      if (backend === "hermes") {
        assert.equal(result.testedConfig.profile, "probe-profile");
        assert.equal(
          adapterInput?.settings.agents.hermes.profile,
          "probe-profile"
        );
        assert.equal(
          adapterInput?.nativeRefContext?.providerEndpoint,
          "hermes-acp+stdio://local/probe-profile"
        );
        assert.doesNotMatch(
          adapterInput?.nativeRefContext?.providerEndpoint ?? "",
          /^https?:/i,
          "Hermes ACP Native identity must not inherit the configured HTTP server URL"
        );
      } else {
        assert.equal(result.testedConfig.agent, "build");
        assert.equal(
          result.testedConfig.transport.endpointIdentity,
          "http://opencode.test"
        );
        assert.equal(
          adapterInput?.settings.opencode.providerId,
          requestedModel.providerId
        );
        assert.equal(
          adapterInput?.settings.opencode.modelId,
          requestedModel.modelId
        );
        assert.equal(adapterInput?.settings.opencode.agent, "build");
      }
      assert.ok(
        fixture.calls.indexOf("native:registered")
          < fixture.calls.indexOf("agent:prompt")
      );

      const events = await fixture.ledger.readRun(result.runId);
      const started = events.find((event) => event.type === "run.started");
      assert.equal(started?.data?.workflow, "backend.probe");
      assert.equal(started?.data?.surface, "system");
      assert.deepEqual(
        events.filter(isTerminal).map((event) => event.type),
        ["run.completed"]
      );
      const terminal = events.find((event) => event.type === "run.completed");
      assert.deepEqual(
        terminal?.data?.backendProbe,
        result.testedConfig,
        "the durable Run Ledger terminal must identify the tested configuration"
      );

      const record = (await fixture.store.list())[0];
      assert.equal(record.workflow, "backend.probe");
      assert.equal(record.surface, "system");
      assert.equal(record.native.backendId, backend);
      assert.equal(record.native.identityAuthority, undefined);
      assert.equal(record.localCommit, "committed");
      assert.equal(record.cleanup, "disposed");
    } finally {
      await fixture.cleanup();
    }
  }

  const invalidOutput = await createFixture({
    backend: "opencode",
    asynchronous: false,
    status: "completed",
    workflow: "backend.probe",
    outputText: "unexpected response",
    effectiveModel: {
      providerId: "opencode-provider",
      modelId: "opencode-model"
    }
  });
  const invalidOutputSettings = cloneSettings();
  invalidOutputSettings.opencode.serverUrl = "http://opencode.test";
  try {
    await assert.rejects(
      runBackendProbe({
        host: invalidOutput.host,
        backendId: "opencode",
        settings: invalidOutputSettings,
        vaultPath: "/vault",
        nativeRefContext: {
          deviceKey: "device-test",
          vaultId: "/vault",
          providerEndpoint: "http://opencode.test"
        },
        prompt: "只回复 OPENCODE_PONG",
        expectedToken: "OPENCODE_PONG",
        failureMessage: "OpenCode probe token mismatch",
        timeoutMs: 60_000,
        model: {
          providerId: "opencode-provider",
          modelId: "opencode-model"
        },
        agent: "build"
      }, {
        createAdapter: () => invalidOutput.adapter,
        createRunId: () => "run-backend-probe-invalid"
      }),
      /OpenCode probe token mismatch/
    );
    assert.deepEqual(
      (await invalidOutput.ledger.readRun("run-backend-probe-invalid"))
        .filter(isTerminal)
        .map((event) => event.type),
      ["run.failed"]
    );
    const failedTerminal = (
      await invalidOutput.ledger.readRun("run-backend-probe-invalid")
    ).find((event) => event.type === "run.failed");
    assert.deepEqual(
      failedTerminal?.data?.backendProbe,
      {
        schemaVersion: 1,
        backendId: "opencode",
        requestedModel: {
          providerId: "opencode-provider",
          modelId: "opencode-model"
        },
        effectiveModel: {
          providerId: "opencode-provider",
          modelId: "opencode-model"
        },
        agent: "build",
        transport: {
          kind: "opencode-http",
          endpointIdentity: "http://opencode.test"
        },
        verification: "failed"
      },
      "failed probes must retain a non-sensitive attempted/effective identity"
    );
    const record = (await invalidOutput.store.list())[0];
    assert.equal(record.runOutcome, "failed");
    assert.equal(record.localCommit, "committed");
    assert.equal(record.cleanup, "disposed");
  } finally {
    await invalidOutput.cleanup();
  }

  const effectiveModelMismatch = await createFixture({
    backend: "hermes",
    asynchronous: false,
    status: "completed",
    workflow: "backend.probe",
    outputText: "PONG",
    effectiveModel: {
      providerId: "default-provider",
      modelId: "default-model"
    }
  });
  try {
    await assert.rejects(
      runBackendProbe({
        host: effectiveModelMismatch.host,
        backendId: "hermes",
        settings: cloneSettings(),
        vaultPath: "/vault",
        nativeRefContext: {
          deviceKey: "device-test",
          vaultId: "/vault",
          providerEndpoint: "http://must-not-be-used.test"
        },
        prompt: "只回复 PONG",
        expectedToken: "PONG",
        failureMessage: "Hermes probe token mismatch",
        timeoutMs: 60_000,
        model: {
          providerId: "selected-provider",
          modelId: "selected-model"
        },
        profile: "selected-profile"
      }, {
        createAdapter: () => effectiveModelMismatch.adapter,
        createRunId: () => "run-backend-probe-effective-model-mismatch"
      }),
      /effective model.*selected-provider.*selected-model/i
    );
    const failedTerminal = (
      await effectiveModelMismatch.ledger.readRun(
        "run-backend-probe-effective-model-mismatch"
      )
    ).find((event) => event.type === "run.failed");
    assert.deepEqual(
      failedTerminal?.data?.backendProbe,
      {
        schemaVersion: 1,
        backendId: "hermes",
        requestedModel: {
          providerId: "selected-provider",
          modelId: "selected-model"
        },
        effectiveModel: {
          providerId: "default-provider",
          modelId: "default-model"
        },
        profile: "selected-profile",
        transport: {
          kind: "hermes-acp-stdio",
          endpointIdentity:
            "hermes-acp+stdio://local/selected-profile"
        },
        verification: "failed"
      }
    );
  } finally {
    await effectiveModelMismatch.cleanup();
  }

  const registrationFailure = await createFixture({
    backend: "hermes",
    asynchronous: false,
    status: "completed",
    workflow: "backend.probe",
    outputText: "PONG",
    effectiveModel: {
      providerId: "hermes-provider",
      modelId: "hermes-model"
    }
  });
  try {
    await assert.rejects(
      runBackendProbe({
        host: {
          ...registrationFailure.host,
          recordNativeExecution: async () => {
            throw new Error("probe Native store unavailable");
          }
        },
        backendId: "hermes",
        settings: cloneSettings(),
        vaultPath: "/vault",
        nativeRefContext: {
          deviceKey: "device-test",
          vaultId: "/vault",
          providerEndpoint: "http://hermes.test"
        },
        prompt: "只回复 PONG",
        expectedToken: "PONG",
        failureMessage: "Hermes probe token mismatch",
        timeoutMs: 60_000,
        model: {
          providerId: "hermes-provider",
          modelId: "hermes-model"
        },
        profile: "probe-profile"
      }, {
        createAdapter: () => registrationFailure.adapter,
        createRunId: () => "run-backend-probe-registration-failure"
      }),
      /probe Native store unavailable/
    );
    assert.equal(
      registrationFailure.calls.includes("agent:prompt"),
      false,
      "registration failure must close before the provider prompt boundary"
    );
    assert.deepEqual(await registrationFailure.store.list(), []);
  } finally {
    await registrationFailure.cleanup();
  }
}

async function assertBackendProbeSettingsAreIsolatedOnFailureAndCancellation(): Promise<void> {
  const requestedModel = {
    providerId: "probe-provider",
    modelId: "probe-model"
  };
  for (const scenario of ["failure", "cancellation"] as const) {
    const liveSettings = cloneSettings();
    liveSettings.opencode.providerId = "live-provider";
    liveSettings.opencode.modelId = "live-model";
    liveSettings.opencode.agent = "live-agent";
    liveSettings.opencode.serverUrl = "http://opencode.test";
    liveSettings.opencode.textEnabled = false;
    liveSettings.opencode.imageEnabled = true;
    liveSettings.opencode.pdfEnabled = true;
    liveSettings.opencode.lastConnectedAt = 123;
    const baseline = structuredClone(liveSettings);
    const fixture = await createFixture({
      backend: "opencode",
      asynchronous: false,
      status: "completed",
      workflow: "backend.probe",
      outputText: scenario === "failure"
        ? "unexpected response"
        : "OPENCODE_PONG",
      effectiveModel: requestedModel
    });
    const controller = new AbortController();
    try {
      const probe = runBackendProbe({
        host: fixture.host,
        backendId: "opencode",
        settings: liveSettings,
        vaultPath: "/vault",
        nativeRefContext: {
          deviceKey: "device-test",
          vaultId: "/vault",
          providerEndpoint: "http://opencode.test"
        },
        prompt: "只回复 OPENCODE_PONG",
        expectedToken: "OPENCODE_PONG",
        failureMessage: "injected probe failure",
        timeoutMs: 60_000,
        signal: controller.signal,
        model: requestedModel,
        agent: "build"
      }, {
        createAdapter: (adapterInput) => {
          adapterInput.settings.opencode.providerId = "runtime-provider";
          adapterInput.settings.opencode.modelId = "runtime-model";
          adapterInput.settings.opencode.agent = "runtime-agent";
          adapterInput.settings.opencode.textEnabled = true;
          adapterInput.settings.opencode.imageEnabled = false;
          adapterInput.settings.opencode.pdfEnabled = false;
          adapterInput.settings.opencode.lastConnectedAt = 999;
          if (scenario === "cancellation") controller.abort();
          return fixture.adapter;
        },
        createRunId: () => `run-backend-probe-settings-${scenario}`
      });
      await assert.rejects(
        probe,
        scenario === "failure"
          ? /injected probe failure/
          : /cancelled/
      );
      assert.deepEqual(
        liveSettings,
        baseline,
        `OpenCode ${scenario} probe must not mutate live settings`
      );
    } finally {
      await fixture.cleanup();
    }
  }
}

async function assertBackendProbeRejectsMismatchedRuntimeEndpoint(): Promise<void> {
  const settings = cloneSettings();
  settings.opencode.serverUrl =
    "https://actual.example/v1?token=actual-secret";
  const fixture = await createFixture({
    backend: "opencode",
    asynchronous: false,
    status: "completed",
    workflow: "backend.probe",
    outputText: "OPENCODE_PONG",
    effectiveModel: {
      providerId: "probe-provider",
      modelId: "probe-model"
    }
  });
  let adapterCreations = 0;
  try {
    await assert.rejects(
      runBackendProbe({
        host: fixture.host,
        backendId: "opencode",
        settings,
        vaultPath: "/vault",
        nativeRefContext: {
          deviceKey: "device-test",
          vaultId: "/vault",
          providerEndpoint:
            "https://different.example/v1?token=different-secret"
        },
        prompt: "只回复 OPENCODE_PONG",
        expectedToken: "OPENCODE_PONG",
        failureMessage: "OpenCode probe token mismatch",
        timeoutMs: 60_000,
        model: {
          providerId: "probe-provider",
          modelId: "probe-model"
        },
        agent: "build"
      }, {
        createAdapter: () => {
          adapterCreations += 1;
          return fixture.adapter;
        }
      }),
      /Invalid backend probe request for opencode/
    );
    assert.equal(
      adapterCreations,
      0,
      "a stale endpoint context must fail before any Native execution or Prompt"
    );
    assert.deepEqual(await fixture.store.list(), []);
  } finally {
    await fixture.cleanup();
  }
}

async function assertBackendProbeSanitizesNativeEndpointIdentity(): Promise<void> {
  const sensitiveEndpoint =
    "https://user:password@opencode.example/v1?token=sk-secret#private";
  const liveSettings = cloneSettings();
  liveSettings.opencode.serverUrl = sensitiveEndpoint;
  const fixture = await createFixture({
    backend: "opencode",
    asynchronous: false,
    status: "completed",
    workflow: "backend.probe",
    outputText: "OPENCODE_PONG",
    effectiveModel: {
      providerId: "probe-provider",
      modelId: "probe-model"
    }
  });
  let safeEndpoint = "";
  try {
    const result = await runBackendProbe({
      host: fixture.host,
      backendId: "opencode",
      settings: liveSettings,
      vaultPath: "/vault",
      nativeRefContext: {
        deviceKey: "device-test",
        vaultId: "/vault",
        providerEndpoint: sensitiveEndpoint
      },
      prompt: "只回复 OPENCODE_PONG",
      expectedToken: "OPENCODE_PONG",
      failureMessage: "OpenCode probe token mismatch",
      timeoutMs: 60_000,
      model: {
        providerId: "probe-provider",
        modelId: "probe-model"
      },
      agent: "build"
    }, {
      createAdapter: (adapterInput) => {
        safeEndpoint =
          adapterInput.nativeRefContext?.providerEndpoint ?? "";
        fixture.adapter.setNativeProviderEndpoint(safeEndpoint);
        return fixture.adapter;
      },
      createRunId: () =>
        "run-backend-probe-sensitive-native-endpoint"
    });
    assert.match(safeEndpoint, /^endpoint-sha256:[a-f0-9]{64}$/);
    for (const secret of [
      "user",
      "password",
      "token",
      "sk-secret",
      "private"
    ]) {
      assert.equal(
        safeEndpoint.includes(secret),
        false,
        `Native endpoint identity must not persist ${secret}`
      );
    }
    const record = (await fixture.store.list())[0];
    assert.equal(record.native.providerEndpoint, safeEndpoint);
    assert.equal(
      result.testedConfig.transport.endpointIdentity,
      safeEndpoint
    );
    assert.equal(
      result.testedConfig.transport.kind,
      "opencode-https",
      "transport classification must come from the live settings endpoint, not the opaque durable identity"
    );
    const terminal = (
      await fixture.ledger.readRun(result.runId)
    ).find(isTerminal);
    const durableProbeRecords = JSON.stringify({
      native: record,
      terminal
    });
    for (const secret of [
      "user",
      "password",
      "token",
      "sk-secret",
      "private"
    ]) {
      assert.equal(
        durableProbeRecords.includes(secret),
        false,
        `Native Store and terminal must not persist ${secret}`
      );
    }
  } finally {
    await fixture.cleanup();
  }
}

async function assertBackendProbeSetModelFailureSettlesRegisteredNative(): Promise<void> {
  const fixture = await createFixture({
    backend: "hermes",
    asynchronous: false,
    status: "completed",
    workflow: "backend.probe",
    outputText: "must not reach output validation",
    effectiveModel: {
      providerId: "selected-provider",
      modelId: "selected-model"
    },
    failAfterRegistrationBeforePrompt: new Error(
      "Hermes ACP set_model acknowledgement rejected"
    )
  });
  try {
    await assert.rejects(
      runBackendProbe({
        host: fixture.host,
        backendId: "hermes",
        settings: cloneSettings(),
        vaultPath: "/vault",
        nativeRefContext: {
          deviceKey: "device-test",
          vaultId: "/vault",
          providerEndpoint: "http://must-not-be-used.test"
        },
        prompt: "只回复 PONG",
        expectedToken: "PONG",
        failureMessage: "Hermes probe token mismatch",
        timeoutMs: 60_000,
        model: {
          providerId: "selected-provider",
          modelId: "selected-model"
        },
        profile: "selected-profile"
      }, {
        createAdapter: () => fixture.adapter,
        createRunId: () => "run-backend-probe-set-model-rejected"
      }),
      /set_model acknowledgement rejected/
    );

    assert.ok(
      fixture.calls.includes("native:registered"),
      "the ACP session must be durable before set_model rejection"
    );
    assert.equal(
      fixture.calls.includes("agent:prompt"),
      false,
      "set_model rejection must not cross the Prompt boundary"
    );
    assert.ok(
      fixture.calls.indexOf("native:registered")
        < fixture.calls.indexOf("adapter:disposed")
    );
    assert.ok(
      fixture.calls.indexOf("adapter:disposed")
        < fixture.calls.indexOf("native:settled")
    );
    assert.ok(
      fixture.calls.indexOf("native:settled")
        < fixture.calls.indexOf("native:cleanup")
    );

    const terminals = (
      await fixture.ledger.readRun(
        "run-backend-probe-set-model-rejected"
      )
    ).filter(isTerminal);
    assert.deepEqual(
      terminals.map((event) => event.type),
      ["run.failed"]
    );
    assert.equal(
      terminals[0]?.data?.backendProbe
        && "effectiveModel" in terminals[0].data.backendProbe,
      false,
      "a rejected model acknowledgement must not claim an effective model"
    );
    const record = (await fixture.store.list())[0];
    assert.equal(record.runOutcome, "failed");
    assert.equal(record.localCommit, "committed");
    assert.equal(record.cleanup, "disposed");
  } finally {
    await fixture.cleanup();
  }
}

async function assertUtilityLifecycleMatrix(): Promise<void> {
  for (const backend of ["codex-cli", "opencode", "hermes"] as const) {
    for (const asynchronous of [false, true]) {
      for (const status of ["completed", "failed", "cancelled"] as const) {
        const workflow: EphemeralUtilityWorkflow = status === "completed"
          ? "prompt.enhance"
          : "memory.curate";
        const fixture = await createFixture({
          backend,
          asynchronous,
          status,
          workflow
        });
        try {
          const lifecycleInput = {
            host: fixture.host,
            adapter: fixture.adapter,
            request: fixture.request,
            awaitResult: async () => await fixture.adapter.awaitResult!(
              fixture.request.runId
            ),
            validateOutput: (text) => ({
              value: text,
              terminalText: text
            }),
            logLabel: "Utility lifecycle matrix"
          };
          const run = workflow === "memory.curate"
            ? runEphemeralUtility({
              ...lifecycleInput,
              settlement: deferredMemorySettlement(
                `transaction-${fixture.request.runId}`
              )
            })
            : runEphemeralUtility(lifecycleInput);
          if (status === "completed") {
            assert.equal(await run, "validated output");
          } else {
            await assert.rejects(
              run,
              status === "cancelled" ? /cancelled/ : /failed/
            );
          }

          const registration = fixture.calls.indexOf("native:registered");
          const prompt = fixture.calls.indexOf("agent:prompt");
          const disposed = fixture.calls.indexOf("adapter:disposed");
          const settled = fixture.calls.indexOf("native:settled");
          const cleanup = fixture.calls.indexOf("native:cleanup");
          assert.ok(registration >= 0 && registration < prompt);
          assert.ok(disposed >= 0 && disposed < settled);
          assert.ok(settled >= 0 && settled < cleanup);

          const terminals = (await fixture.ledger.readRun(
            fixture.request.runId
          )).filter(isTerminal);
          assert.equal(terminals.length, 1);
          assert.equal(terminals[0].type, `run.${status}`);
          assert.equal(terminals[0].backendId, backend);

          const records = await fixture.store.list();
          assert.equal(records.length, 1);
          assert.equal(
            records[0].runOutcome,
            status === "completed" ? "success" : status
          );
          assert.equal(records[0].localCommit, "committed");
          assert.equal(records[0].cleanup, "disposed");
        } finally {
          await fixture.cleanup();
        }
      }
    }
  }
}

async function assertPromptEnhancerValidationPrecedesCompletedTerminal(): Promise<void> {
  for (const [name, text, errorPattern] of [
    ["empty", "```text\n\n```", /增强结果为空/],
    ["too-long", "x".repeat(4_001), /增强结果过长/]
  ] as const) {
    const fixture = await createFixture({
      backend: "codex-cli",
      asynchronous: false,
      status: "completed",
      workflow: "prompt.enhance",
      outputText: text,
      runId: `run-prompt-${name}`
    });
    try {
      await assert.rejects(
        runEphemeralUtility({
          host: fixture.host,
          adapter: fixture.adapter,
          request: fixture.request,
          validateOutput: (candidate) =>
            validatePromptEnhancerCandidateOutput(candidate, 1_000)
        }),
        errorPattern
      );
      const terminals = (await fixture.ledger.readRun(
        fixture.request.runId
      )).filter(isTerminal);
      assert.equal(terminals.length, 1);
      assert.equal(terminals[0].type, "run.failed");
      assert.equal(
        terminals.some((event) => event.type === "run.completed"),
        false
      );
    } finally {
      await fixture.cleanup();
    }
  }
}

async function assertMemoryCuratorValidationPrecedesCompletedTerminal(): Promise<void> {
  const source: MemoryCuratorRequest = {
    transactionId: "memory-tx-current",
    baseRevision: 1,
    events: [{
      schemaVersion: 2,
      eventId: "event-current",
      runId: "run-current",
      sessionId: "session-current",
      workflow: "chat.generic",
      backendId: "codex-cli",
      eventType: "user-input",
      createdAt: 1,
      payload: { text: "remember this" },
      redacted: false,
      checksum: "checksum-current"
    }],
    activeMemories: []
  };
  const invalidCandidates = [
    {
      name: "invalid-json",
      text: "{",
      errorPattern: /JSON/
    },
    {
      name: "invalid-schema",
      text: JSON.stringify({
        schemaVersion: 1,
        outcome: "no-op",
        summary: "wrong schema",
        candidates: []
      }),
      errorPattern: /schemaVersion must be 2/
    },
    {
      name: "transaction-field-mismatch",
      text: JSON.stringify({
        schemaVersion: 2,
        transactionId: "memory-tx-other",
        outcome: "no-op",
        summary: "wrong transaction",
        candidates: []
      }),
      errorPattern: /unexpected field: transactionId/
    },
    {
      name: "cross-transaction-event",
      text: JSON.stringify({
        schemaVersion: 2,
        outcome: "no-op",
        summary: "wrong event authority",
        candidates: [{
          candidateId: "skip-other",
          disposition: "skip",
          sourceEventIds: ["event-other"],
          reason: "belongs to another transaction"
        }]
      }),
      errorPattern: /Invalid memory coverage/
    }
  ] as const;

  for (const candidate of invalidCandidates) {
    const fixture = await createFixture({
      backend: "codex-cli",
      asynchronous: false,
      status: "completed",
      workflow: "memory.curate",
      outputText: candidate.text,
      runId: `run-memory-${candidate.name}`
    });
    try {
      await assert.rejects(
        runEphemeralUtility({
          host: fixture.host,
          adapter: fixture.adapter,
          request: fixture.request,
          settlement: deferredMemorySettlement(source.transactionId),
          validateOutput: (text) => {
            const result = validateMemoryCuratorResult(source, text).result;
            return {
              value: result,
              terminalText: JSON.stringify(result)
            };
          }
        }),
        candidate.errorPattern
      );

      const terminals = (await fixture.ledger.readRun(
        fixture.request.runId
      )).filter(isTerminal);
      assert.deepEqual(
        terminals.map((event) => event.type),
        ["run.failed"]
      );
      const record = (await fixture.store.list())[0];
      assert.equal(record.localCommit, "committed");
      assert.equal(record.runOutcome, "failed");
      assert.equal(record.cleanup, "disposed");
    } finally {
      await fixture.cleanup();
    }
  }
}

async function assertStartTimeoutCancelsAndDrainsRegistration(): Promise<void> {
  const registrationGate = deferred<void>();
  const fixture = await createFixture({
    backend: "opencode",
    asynchronous: false,
    status: "completed",
    workflow: "prompt.enhance",
    registrationGate,
    releaseRegistrationOnCancel: true
  });
  try {
    await assert.rejects(
      runEphemeralUtility({
        host: fixture.host,
        adapter: fixture.adapter,
        request: fixture.request,
        timeoutMs: 10,
        timeoutMessage: "injected utility timeout",
        validateOutput: (text) => ({ value: text, terminalText: text })
      }),
      /injected utility timeout/
    );

    assert.equal(fixture.calls.includes("agent:prompt"), false);
    assert.equal(
      fixture.calls.filter((call) => call === "adapter:cancelled").length,
      1
    );
    assert.ok(
      fixture.calls.indexOf("native:registered")
        < fixture.calls.indexOf("adapter:disposed")
    );
    assert.ok(
      fixture.calls.indexOf("adapter:disposed")
        < fixture.calls.indexOf("native:settled")
    );
    const terminals = (await fixture.ledger.readRun(
      fixture.request.runId
    )).filter(isTerminal);
    assert.deepEqual(terminals.map((event) => event.type), ["run.failed"]);
    const record = (await fixture.store.list())[0];
    assert.equal(record.runOutcome, "failed");
    assert.equal(record.localCommit, "committed");
    assert.equal(record.cleanup, "disposed");
  } finally {
    registrationGate.resolve();
    await fixture.cleanup();
  }
}

async function assertPreStartAbortSkipsHarnessExecution(): Promise<void> {
  const fixture = await createFixture({
    backend: "hermes",
    asynchronous: false,
    status: "completed",
    workflow: "prompt.enhance"
  });
  const controller = new AbortController();
  controller.abort();
  try {
    await assert.rejects(
      runEphemeralUtility({
        host: fixture.host,
        adapter: fixture.adapter,
        request: fixture.request,
        signal: controller.signal,
        validateOutput: (text) => ({ value: text, terminalText: text })
      }),
      /cancelled/
    );
    assert.equal(fixture.calls.includes("native:created"), false);
    assert.equal(fixture.calls.includes("adapter:cancelled"), false);
    assert.deepEqual(await fixture.ledger.readRun(fixture.request.runId), []);
    assert.deepEqual(await fixture.store.list(), []);
  } finally {
    await fixture.cleanup();
  }
}

async function assertAbortAfterValidationWinsBeforeCompletedTerminal(): Promise<void> {
  const fixture = await createFixture({
    backend: "codex-cli",
    asynchronous: false,
    status: "completed",
    workflow: "prompt.enhance"
  });
  const controller = new AbortController();
  try {
    await assert.rejects(
      runEphemeralUtility({
        host: fixture.host,
        adapter: fixture.adapter,
        request: fixture.request,
        signal: controller.signal,
        validateOutput: (text) => {
          controller.abort();
          return { value: text, terminalText: text };
        }
      }),
      /cancelled/
    );
    const terminals = (await fixture.ledger.readRun(
      fixture.request.runId
    )).filter(isTerminal);
    assert.deepEqual(terminals.map((event) => event.type), ["run.cancelled"]);
    assert.equal(
      terminals.some((event) => event.type === "run.completed"),
      false
    );
    const record = (await fixture.store.list())[0];
    assert.equal(record.runOutcome, "cancelled");
    assert.equal(record.localCommit, "committed");
    assert.equal(record.cleanup, "disposed");
  } finally {
    await fixture.cleanup();
  }
}

async function assertCodexRegistrationFailureArchivesExactlyOnceBeforePrompt(): Promise<void> {
  const archived: string[] = [];
  let promptCalls = 0;
  const adapter = new CodexRichAgentAdapter({
    displayName: "Codex",
    version: "test",
    getNativeThreadId: () => undefined,
    setNativeThreadId: () => undefined,
    buildInput: () => [{
      type: "text",
      text: "must not submit",
      text_elements: []
    }],
    startThread: async () => ({
      threadId: "codex-registration-failure",
      title: "Registration failure"
    }),
    resumeThread: async () => undefined,
    startTurn: async () => {
      promptCalls += 1;
      return "turn-must-not-start";
    },
    interruptTurn: async () => undefined,
    archiveThread: async (threadId) => {
      archived.push(threadId);
    },
    nativeRefContext: {
      deviceKey: "device-test",
      vaultId: "/vault"
    }
  });
  try {
    await assert.rejects(
      adapter.run({
        runId: "run-codex-registration-failure",
        sessionId: "session-codex-registration-failure",
        workflow: "prompt.enhance",
        workspace: { vaultPath: "/vault", cwd: "/vault" },
        nativeBindingManagedByHarness: true,
        registerNativeExecution: async () => {
          throw new Error("native store unavailable");
        },
        input: { text: "must not submit", attachments: [] },
        permissions: {
          mode: "read-only",
          writableRoots: [],
          requireApproval: true
        },
        resources: { selected: [], resolvedAt: 1, warnings: [] },
        context: emptyContextBundle(),
        outputContract: { kind: "plain-text" }
      }, () => undefined),
      /registration failed.*native store unavailable/i
    );
    assert.equal(promptCalls, 0);
    assert.deepEqual(archived, ["codex-registration-failure"]);
  } finally {
    await adapter.dispose();
  }
}

async function assertTerminalFailureRetainsRecoveryRecord(): Promise<void> {
  const fixture = await createFixture({
    backend: "opencode",
    asynchronous: false,
    status: "completed",
    workflow: "prompt.enhance"
  });
  try {
    const host: EphemeralUtilityLifecycleHost = {
      ...fixture.host,
      settleHarnessRunTerminal: async () => {
        throw new Error("injected terminal commit failure");
      }
    };
    await assert.rejects(
      runEphemeralUtility({
        host,
        adapter: fixture.adapter,
        request: fixture.request,
        validateOutput: (text) => ({ value: text, terminalText: text })
      }),
      /injected terminal commit failure/
    );
    const record = (await fixture.store.list())[0];
    assert.equal(record.localCommit, "failed");
    assert.equal(record.cleanup, "retained-for-recovery");
    assert.equal(fixture.calls.includes("native:cleanup"), false);
    assert.ok(
      fixture.calls.indexOf("adapter:disposed")
        < fixture.calls.indexOf("native:settled")
    );
  } finally {
    await fixture.cleanup();
  }
}

async function assertDeferredMemorySettlementWaitsForExactDurableAuthority(): Promise<void> {
  const receipts: MemoryTransactionAuthorityReceipt[] = [
    {
      kind: "memory-transaction",
      transactionId: "transaction-committed",
      state: "committed",
      durable: true,
      revision: 2,
      outcome: "write"
    },
    {
      kind: "memory-transaction",
      transactionId: "transaction-pending",
      state: "durable-pending",
      durable: true,
      revision: 1,
      outcome: "pending",
      error: "unresolved candidates remain durable"
    },
    {
      kind: "memory-transaction",
      transactionId: "transaction-failed",
      state: "durable-failed",
      durable: true,
      revision: 1,
      outcome: "failed",
      error: "invalid candidate remains recoverable"
    }
  ];

  for (const authorityReceipt of receipts) {
    const fixture = await createFixture({
      backend: "codex-cli",
      asynchronous: false,
      status: "completed",
      workflow: "memory.curate",
      runId: `run-${authorityReceipt.transactionId}`
    });
    try {
      const result = await runEphemeralUtility({
        host: fixture.host,
        adapter: fixture.adapter,
        request: fixture.request,
        settlement: deferredMemorySettlement(
          authorityReceipt.transactionId
        ),
        validateOutput: (text) => ({ value: text, terminalText: text })
      });
      assert.equal(result.value, "validated output");
      assert.deepEqual(result.authority, {
        kind: "memory-transaction",
        transactionId: authorityReceipt.transactionId
      });

      const pending = (await fixture.store.list())[0];
      assert.equal(pending.localCommit, "pending");
      assert.equal(pending.cleanup, "not-needed");
      assert.deepEqual(pending.localCommitAuthority, result.authority);
      assert.equal(fixture.calls.includes("native:settled"), false);
      assert.equal(fixture.calls.includes("native:cleanup"), false);
      assert.ok(
        fixture.calls.indexOf("adapter:disposed")
          > fixture.calls.indexOf("native:registered")
      );

      await assert.rejects(
        result.finalize({
          ...authorityReceipt,
          transactionId: "transaction-other"
        }),
        /does not match/
      );
      assert.equal(fixture.calls.includes("native:settled"), false);

      const finalization = await result.finalize(authorityReceipt);
      assert.equal(finalization.runId, fixture.request.runId);
      assert.deepEqual(finalization.authority, authorityReceipt);
      assert.equal(finalization.records.length, 1);
      assert.equal(finalization.records[0].settlement, "settled");
      assert.equal(finalization.records[0].cleanup?.cleanup, "disposed");

      const settleCallCount = fixture.calls.filter(
        (call) => call === "native:settled"
      ).length;
      const cleanupCallCount = fixture.calls.filter(
        (call) => call === "native:cleanup"
      ).length;
      assert.deepEqual(
        await result.finalize(authorityReceipt),
        finalization
      );
      assert.equal(
        fixture.calls.filter((call) => call === "native:settled").length,
        settleCallCount
      );
      assert.equal(
        fixture.calls.filter((call) => call === "native:cleanup").length,
        cleanupCallCount
      );
      const conflictingReceipt: MemoryTransactionAuthorityReceipt =
        authorityReceipt.state === "committed"
          ? {
            kind: "memory-transaction",
            transactionId: authorityReceipt.transactionId,
            state: "durable-failed",
            durable: true,
            revision: authorityReceipt.revision,
            outcome: "failed",
            error: "conflicting durable state"
          }
          : {
            kind: "memory-transaction",
            transactionId: authorityReceipt.transactionId,
            state: "committed",
            durable: true,
            revision: authorityReceipt.revision,
            outcome: "no-op"
          };
      await assert.rejects(
        result.finalize(conflictingReceipt),
        /Conflicting deferred utility authority receipt/
      );

      const stored = (await fixture.store.list())[0];
      assert.equal(stored.runOutcome, "success");
      assert.equal(stored.localCommit, "committed");
      assert.equal(stored.cleanup, "disposed");
    } finally {
      await fixture.cleanup();
    }
  }
}

async function assertCleanupFailureDoesNotReverseCompletedResult(): Promise<void> {
  const fixture = await createFixture({
    backend: "hermes",
    asynchronous: true,
    status: "completed",
    workflow: "memory.curate",
    cleanupOutcome: "failed"
  });
  try {
    const result = await runEphemeralUtility({
      host: fixture.host,
      adapter: fixture.adapter,
      request: fixture.request,
      settlement: deferredMemorySettlement("transaction-cleanup-failed"),
      awaitResult: async () => await fixture.adapter.awaitResult!(
        fixture.request.runId
      ),
      validateOutput: (text) => ({ value: text, terminalText: text })
    });
    assert.equal(result.value, "validated output");
    await result.finalize({
      kind: "memory-transaction",
      transactionId: "transaction-cleanup-failed",
      state: "committed",
      durable: true,
      revision: 2,
      outcome: "write"
    });
    const record = (await fixture.store.list())[0];
    assert.equal(record.runOutcome, "success");
    assert.equal(record.localCommit, "committed");
    assert.equal(record.cleanup, "failed");
  } finally {
    await fixture.cleanup();
  }
}

async function createFixture(options: {
  backend: "codex-cli" | "opencode" | "hermes";
  asynchronous: boolean;
  status: UtilityStatus;
  workflow: EphemeralUtilityWorkflow;
  outputText?: string;
  effectiveModel?: {
    providerId: string;
    modelId: string;
  };
  runId?: string;
  cleanupOutcome?: NativeExecutionDispositionResult["outcome"];
  registrationGate?: Deferred<void>;
  releaseRegistrationOnCancel?: boolean;
  failAfterRegistrationBeforePrompt?: Error;
}): Promise<{
  adapter: UtilityLifecycleAdapter;
  calls: string[];
  request: HarnessRunRequest & { workflow: EphemeralUtilityWorkflow };
  host: EphemeralUtilityLifecycleHost;
  ledger: InMemoryRunLedger;
  store: NativeExecutionStore;
  cleanup(): Promise<void>;
}> {
  const rootPath = await mkdtemp(
    path.join(tmpdir(), "echoink-ephemeral-utility-native-")
  );
  const calls: string[] = [];
  const runId = options.runId
    ?? `run-${options.backend}-${options.workflow}-${options.status}-${options.asynchronous ? "async" : "sync"}`;
  const adapter = new UtilityLifecycleAdapter({
    backend: options.backend,
    asynchronous: options.asynchronous,
    result: {
      status: options.status,
      ...(options.status === "completed"
        ? {
          outputText: options.outputText ?? "validated output",
          ...(options.effectiveModel
            ? { effectiveModel: options.effectiveModel }
            : {})
        }
        : { error: `utility ${options.status}` })
    },
    cleanupOutcome: options.cleanupOutcome ?? "disposed",
    calls,
    failAfterRegistrationBeforePrompt:
      options.failAfterRegistrationBeforePrompt,
    onCancel: options.releaseRegistrationOnCancel
      ? () => options.registrationGate?.resolve()
      : undefined
  });
  const ledger = new InMemoryRunLedger();
  const kernel = new EchoInkHarnessKernel({
    ledger,
    memoryProvider: new NoopMemoryProvider()
  });
  const store = new NativeExecutionStore({ rootPath });
  const manager = new NativeExecutionManager({
    store,
    adapters: [adapter],
    emitRunEvent: async (event) => {
      await kernel.appendRunEvent(event);
    }
  });
  const host: EphemeralUtilityLifecycleHost = {
    runHarnessWithAdapter: async (input) =>
      await kernel.runWithAdapter(input),
    cancelHarnessRun: async (targetRunId) => {
      await kernel.cancelRun(targetRunId);
    },
    settleHarnessRunTerminal: async (input) =>
      await kernel.settleRunTerminal(input),
    recordNativeExecution: async (record) => {
      calls.push("native:registration-started");
      await options.registrationGate?.promise;
      await manager.recordCreated(record);
      calls.push("native:registered");
    },
    settleNativeExecution: async (input: SettleNativeExecutionInput) => {
      calls.push("native:settled");
      return await manager.settleRun(input);
    },
    cleanupNativeExecutionRecord: async (
      recordId: string
    ): Promise<NativeCleanupResult> => {
      calls.push("native:cleanup");
      return await manager.cleanupById(recordId);
    }
  };
  const request: HarnessRunRequest & {
    workflow: EphemeralUtilityWorkflow;
  } = {
    runId,
    sessionId: `${options.workflow}:${runId}`,
    surface: options.workflow === "prompt.enhance"
      ? "chat"
      : options.workflow === "backend.probe"
        ? "system"
        : "review",
    workflow: options.workflow,
    backendId: options.backend,
    workspace: { vaultPath: "/vault", cwd: "/vault" },
    input: { text: "utility input", attachments: [] },
    permissions: {
      mode: "read-only",
      writableRoots: [],
      requireApproval: true
    },
    resourceSelection: { selected: [], resolvedAt: 1, warnings: [] },
    memoryPolicy: { enabled: false, maxItems: 0 },
    outputContract: { kind: "plain-text" }
  };
  return {
    adapter,
    calls,
    request,
    host,
    ledger,
    store,
    cleanup: async () => await rm(rootPath, { recursive: true, force: true })
  };
}

function cloneSettings(): CodexForObsidianSettings {
  return structuredClone(DEFAULT_SETTINGS);
}

class UtilityLifecycleAdapter implements AgentAdapter {
  readonly manifest: AgentManifest;
  private readonly native: NativeExecutionRef;
  private cancelRequested = false;

  constructor(private readonly options: {
    backend: "codex-cli" | "opencode" | "hermes";
    asynchronous: boolean;
    result: AgentRunResult;
    cleanupOutcome: NativeExecutionDispositionResult["outcome"];
    calls: string[];
    onCancel?: () => void;
    failAfterRegistrationBeforePrompt?: Error;
  }) {
    this.manifest = {
      id: options.backend,
      displayName: options.backend,
      version: "test",
      capabilities: noCapabilities(),
      nativeExecution: {
        persistence: options.backend === "codex-cli"
          ? "none"
          : options.backend === "opencode"
            ? "provider-persistent"
            : "process-local",
        dispositions: {
          processExit: true,
          archive: false,
          delete: false
        },
        idempotentDisposition: true,
        canInspectExistence: false
      }
    };
    this.native = {
      backendId: options.backend,
      id: `native-${options.backend}-${options.asynchronous ? "async" : "sync"}-${options.result.status}`,
      kind: options.backend === "codex-cli"
        ? "thread"
        : options.backend === "opencode"
          ? "session"
          : "run",
      persistence: this.manifest.nativeExecution.persistence,
      ...(options.backend === "codex-cli"
        ? {}
        : { providerEndpoint: `http://${options.backend}.test` }),
      deviceKey: "device-test",
      vaultId: "/vault",
      createdAt: 1
    };
  }

  async connect(_context: AgentConnectContext): Promise<AgentConnectionStatus> {
    return {
      connected: true,
      label: this.manifest.displayName,
      errors: []
    };
  }

  async dispose(): Promise<void> {
    this.options.calls.push("adapter:disposed");
  }

  async listModels(): Promise<Array<{ id: string; displayName: string }>> {
    return [];
  }

  setNativeProviderEndpoint(providerEndpoint: string): void {
    this.native.providerEndpoint = providerEndpoint;
  }

  async run(
    request: AgentRunRequest,
    _emit: HarnessEventSink
  ): Promise<AgentRunResult> {
    this.options.calls.push("native:created");
    await request.registerNativeExecution?.(this.native);
    if (this.options.failAfterRegistrationBeforePrompt) {
      throw this.options.failAfterRegistrationBeforePrompt;
    }
    if (this.cancelRequested) {
      return {
        status: "cancelled",
        error: "utility cancelled",
        nativeExecution: this.native
      };
    }
    this.options.calls.push("agent:prompt");
    if (this.options.asynchronous) {
      return {
        status: "running",
        nativeExecution: this.native
      };
    }
    return {
      ...this.options.result,
      nativeExecution: this.native
    };
  }

  async awaitResult(_runId: string): Promise<AgentRunResult> {
    return {
      ...this.options.result,
      nativeExecution: this.native
    };
  }

  async cancel(_runId: string): Promise<void> {
    this.options.calls.push("adapter:cancelled");
    this.cancelRequested = true;
    this.options.onCancel?.();
  }

  async disposeNativeExecution(
    request: NativeExecutionDispositionRequest
  ): Promise<NativeExecutionDispositionResult> {
    this.options.calls.push("provider:cleanup");
    return this.options.cleanupOutcome === "failed"
      ? { outcome: "failed", message: "injected cleanup failure" }
      : {
        outcome: this.options.cleanupOutcome,
        applied: request.requested
      };
  }
}

function isTerminal(event: HarnessEvent): boolean {
  return event.type === "run.completed"
    || event.type === "run.failed"
    || event.type === "run.cancelled";
}

function deferredMemorySettlement(transactionId: string): {
  mode: "deferred";
  authority: {
    kind: "memory-transaction";
    transactionId: string;
  };
} {
  return {
    mode: "deferred",
    authority: {
      kind: "memory-transaction",
      transactionId
    }
  };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value?: T | PromiseLike<T>): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value?: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
