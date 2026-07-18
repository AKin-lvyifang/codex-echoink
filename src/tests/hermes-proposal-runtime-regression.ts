import * as assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  HermesProposalContractError,
  parseAndValidateHermesMaintenanceProposal,
  type HermesProposalValidationContext
} from "../harness/maintenance/hermes-proposal-contract";
import {
  HermesProposalMaterializationError,
  materializeHermesMaintenanceProposal
} from "../harness/maintenance/hermes-proposal-materializer";
import {
  createHermesProposalLease,
  HermesProposalRuntimeError,
  hermesProposalInvocationInputDigest,
  isHermesProposalLeaseActive,
  isTrustedHermesProposalLeaseRevocationReceipt,
  isTrustedHermesVaultNoWriteAuthorityReceipt,
  probeHermesVaultNoWriteCapability,
  runHermesProposalInvocation,
  type HermesProposalLaunchIdentity,
  type HermesProposalLaunchInspector,
  type HermesProposalProcessOptions,
  type HermesProposalProcessRunner,
  type HermesProposalProjectResolver,
  type HermesVaultNoWriteCapability
} from "../core/hermes-proposal-runtime";
import { isTrustedExactWriteFenceReceipt } from "../agent/write-fence";
import {
  KnowledgeAgentAttemptError,
  KnowledgeBaseAgentTaskService
} from "../knowledge-base/agent-task-service";
import { isTrustedKnowledgeAgentNativeTerminationReceipt } from "../knowledge-base/native-termination";
import { DEFAULT_SETTINGS } from "../settings/settings";

const FULL_LOCAL_COMMIT = "1c473bc6a6a0f62e4c264fa0c59ce58606100301";
const FAKE_DISCOVERY_COMMAND = "/opt/hermes/bin/hermes";
const FAKE_PROJECT_PATH = "/opt/hermes/project";
const SOURCE_PATH = "raw/source.md";
const SOURCE_HASH = fingerprint("source");
const INVOCATION_PROMPT = "return proposal JSON";
const INVOCATION_SYSTEM_PROMPT = "host-output-only";

interface FakeHermesOptions {
  version?: string;
  upstreamCommit?: string;
  localCommit?: string;
  head?: string;
  status?: string;
  probe?: Partial<FakeProbe>;
  chatStdout?: string;
  chatDelayMs?: number;
  chatIgnoresAbort?: boolean;
  chatNeverSettles?: boolean;
  directProjectPath?: string;
  projectResolver?: HermesProposalProjectResolver;
  launchInspector?: HermesProposalLaunchInspector;
  onCall?: (
    command: string,
    args: readonly string[],
    options: HermesProposalProcessOptions
  ) => void;
}

interface FakeProbe {
  plugins: number;
  mcp: Record<string, unknown>;
  hooks: unknown[];
  registryTools: string[];
  contextTools: string[];
  contextEngine: string;
  provider: {
    id: string;
    transport: string;
    authType: string;
    baseUrl: string;
    baseUrlEnvVar: string;
    apiKeyEnvVars: string[];
  };
}

interface InvocationFixture {
  rootPath: string;
  shadowVaultPath: string;
  liveVaultPath: string;
  controlRootPath: string;
  capability: HermesVaultNoWriteCapability;
  lease: ReturnType<typeof createHermesProposalLease>;
  invocation: Awaited<ReturnType<typeof runHermesProposalInvocation>>;
}

export async function runHermesProposalRuntimeRegressionTests(): Promise<void> {
  await testContractRejectsUnsafePathsAndAllowsNewPages();
  await testPreflightIdentityEnvironmentProviderAndCapabilityProbe();
  await testPreflightRejectsUnauditedProvidersAndDiscoveryMismatch();
  await testProbeCommandsHonorDeadlineAndAbortSignal();
  await testOpaqueCapabilityLeaseProposalAndReceiptBrands();
  await testInvocationRevalidatesIdentityInputAndIsolation();
  await testMaterializerNewPageExistingPageAndCasRace();
  await testMaterializerRejectsSymlinkHardlinkSpecialAndParentEscape();
  await testTimeoutCancelAndNeverSettlingRunner();
  await testServiceRunsTrustedProposalTransportAndMaterializesShadow();
  await testServiceCancelDuringCapabilityProbe();
  await testServiceTimeoutRejectsLateProposalBeforeMaterialization();
}

async function testContractRejectsUnsafePathsAndAllowsNewPages(): Promise<void> {
  const newPage = proposalJson("attempt-new-page", [{
    op: "upsert",
    path: "wiki/new-page.md",
    content: "new page",
    sources: [{ path: SOURCE_PATH, sha256: SOURCE_HASH }],
    baseSha256: null
  }]);
  const validated = parseAndValidateHermesMaintenanceProposal(newPage, {
    attemptId: "attempt-new-page",
    sourceFingerprints: { [SOURCE_PATH]: SOURCE_HASH },
    targetFingerprints: {}
  });
  assert.equal(validated.outcome, "committable");
  assert.equal(validated.operations[0]?.path, "wiki/new-page.md");

  const existingHash = fingerprint("old");
  const omittedExisting = parseAndValidateHermesMaintenanceProposal(
    proposalJson("attempt-omitted-existing", [{
      op: "upsert",
      path: "wiki/existing.md",
      content: "new",
      sources: [{ path: SOURCE_PATH, sha256: SOURCE_HASH }],
      baseSha256: existingHash
    }]),
    {
      attemptId: "attempt-omitted-existing",
      sourceFingerprints: { [SOURCE_PATH]: SOURCE_HASH },
      targetFingerprints: {}
    }
  );
  assert.equal(omittedExisting.outcome, "invalid");
  assert.equal(omittedExisting.rejectedOperations[0]?.code, "target_changed");

  const unsafe = parseAndValidateHermesMaintenanceProposal(
    proposalJson("attempt-unsafe", [
      operation("raw/forbidden.md"),
      operation("outputs/.ingest-tracker.md"),
      operation("/absolute.md"),
      operation("wiki/../escape.md"),
      operation("wiki/duplicate.md"),
      operation("wiki/duplicate.md"),
      operation("wiki/.obsidian/control.md")
    ]),
    {
      attemptId: "attempt-unsafe",
      sourceFingerprints: { [SOURCE_PATH]: SOURCE_HASH },
      targetFingerprints: {}
    }
  );
  assert.equal(unsafe.outcome, "invalid");
  assert.deepEqual(
    unsafe.rejectedOperations.map((entry) => entry.code),
    [
      "path_denied",
      "path_denied",
      "invalid_path",
      "invalid_path",
      "duplicate_path",
      "duplicate_path",
      "path_denied"
    ]
  );

  assert.throws(
    () => parseAndValidateHermesMaintenanceProposal(newPage, {
      attemptId: "attempt-new-page",
      sourceFingerprints: { [SOURCE_PATH]: SOURCE_HASH },
      targetFingerprints: {},
      allowedRoots: ["raw"]
    }),
    (error: unknown) =>
      error instanceof HermesProposalContractError
      && error.code === "invalid_envelope"
  );
}

async function testPreflightIdentityEnvironmentProviderAndCapabilityProbe(): Promise<void> {
  const rootPath = await createRoot("preflight");
  const inheritedKanban = process.env.HERMES_KANBAN_TASK;
  process.env.HERMES_KANBAN_TASK = "must-not-leak";
  const seenEnvironmentKeys: string[][] = [];
  try {
    const ready = await probeHermesVaultNoWriteCapability({
      ...fakeIdentityDependencies(),
      attemptId: "attempt-preflight-ready",
      command: FAKE_DISCOVERY_COMMAND,
      providerId: "openrouter",
      modelId: "model",
      isolationRootPath: path.join(rootPath, "ready"),
      credentialEnvironment: {
        OPENROUTER_API_KEY: "secret",
        OPENROUTER_BASE_URL: "https://openrouter.ai/api/v1"
      },
      processRunner: fakeHermesRunner({
        onCall: (calledCommand, _args, options) => {
          assert.notEqual(
            calledCommand,
            FAKE_DISCOVERY_COMMAND,
            "the discovery wrapper must be inspected, never executed"
          );
          seenEnvironmentKeys.push(Object.keys(options.env));
          assert.equal(options.env.HERMES_KANBAN_TASK, undefined);
        }
      })
    });
    assert.equal(ready.ready, true);
    assert.ok(seenEnvironmentKeys.length >= 3);
    if (ready.ready) {
      assert.equal(ready.capability.hermesVersion, "0.18.0");
      assert.equal(ready.capability.localCommit, "1c473bc6");
      assert.equal(ready.capability.osSandbox, false);
      assert.equal(ready.capability.scope, "vault-only");
      assert.ok(!ready.capability.environmentKeys.includes("HERMES_KANBAN_TASK"));
    }

    const polluted = await probeHermesVaultNoWriteCapability({
      ...fakeIdentityDependencies(),
      attemptId: "attempt-env-polluted",
      command: FAKE_DISCOVERY_COMMAND,
      providerId: "openrouter",
      modelId: "model",
      isolationRootPath: path.join(rootPath, "polluted"),
      credentialEnvironment: { HERMES_KANBAN_TASK: "inject-tools" },
      processRunner: fakeHermesRunner()
    });
    assert.deepEqual(
      polluted.ready ? null : polluted.code,
      "unsafe_environment"
    );

    const wrongVersion = await probeWith(rootPath, "wrong-version", {
      version: "0.18.1"
    });
    assert.equal(wrongVersion.ready ? null : wrongVersion.code, "unsupported_identity");
    assert.deepEqual(await readdir(path.join(rootPath, "probe-wrong-version")), []);

    const wrongCommit = await probeWith(rootPath, "wrong-commit", {
      head: "0000000000000000000000000000000000000000"
    });
    assert.equal(wrongCommit.ready ? null : wrongCommit.code, "dirty_installation");

    const nonemptyProbe = await probeWith(rootPath, "nonempty-probe", {
      probe: { contextTools: ["write_file"] }
    });
    assert.equal(nonemptyProbe.ready ? null : nonemptyProbe.code, "capability_probe_nonempty");

    const unsafeProvider = await probeWith(rootPath, "unsafe-provider", {
      probe: {
        provider: {
          id: "openrouter",
          transport: "external_process",
          authType: "external_process",
          baseUrl: "file:///tmp/provider",
          baseUrlEnvVar: "",
          apiKeyEnvVars: []
        }
      }
    });
    assert.equal(unsafeProvider.ready ? null : unsafeProvider.code, "unsafe_provider");

    const imageModality = await probeHermesVaultNoWriteCapability({
      ...fakeIdentityDependencies(),
      attemptId: "attempt-image",
      command: FAKE_DISCOVERY_COMMAND,
      providerId: "openrouter",
      modelId: "model",
      inputModalities: ["text", "image"],
      isolationRootPath: path.join(rootPath, "image"),
      processRunner: fakeHermesRunner()
    });
    assert.equal(imageModality.ready ? null : imageModality.code, "unsupported_modality");
  } finally {
    if (inheritedKanban === undefined) delete process.env.HERMES_KANBAN_TASK;
    else process.env.HERMES_KANBAN_TASK = inheritedKanban;
    await rm(rootPath, { recursive: true, force: true });
  }
}

async function testPreflightRejectsUnauditedProvidersAndDiscoveryMismatch(): Promise<void> {
  const rootPath = await createRoot("preflight-negative");
  try {
    for (const providerId of ["github-copilot", "unknown-provider"]) {
      const result = await probeHermesVaultNoWriteCapability({
        ...fakeIdentityDependencies(),
        attemptId: `attempt-provider-${providerId}`,
        command: FAKE_DISCOVERY_COMMAND,
        providerId,
        modelId: "model",
        isolationRootPath: path.join(rootPath, providerId),
        processRunner: fakeHermesRunner()
      });
      assert.equal(result.ready ? null : result.code, "unsafe_provider");
    }

    const unrelatedBaseUrl = await probeHermesVaultNoWriteCapability({
      ...fakeIdentityDependencies(),
      attemptId: "attempt-unrelated-base-url",
      command: FAKE_DISCOVERY_COMMAND,
      providerId: "openrouter",
      modelId: "model",
      isolationRootPath: path.join(rootPath, "unrelated-base-url"),
      credentialEnvironment: {
        OPENROUTER_API_KEY: "secret",
        DEEPSEEK_BASE_URL: "https://api.deepseek.com/v1"
      },
      processRunner: fakeHermesRunner()
    });
    assert.equal(
      unrelatedBaseUrl.ready ? null : unrelatedBaseUrl.code,
      "unsafe_environment"
    );

    const unrelatedProject = await probeWith(rootPath, "unrelated-project", {
      directProjectPath: "/opt/unrelated/project"
    });
    assert.equal(
      unrelatedProject.ready ? null : unrelatedProject.code,
      "unsupported_identity"
    );

    const externalCredentialProvider = await probeWith(
      rootPath,
      "provider-external-credential",
      {
        probe: {
          provider: {
            id: "openrouter",
            transport: "openai_chat",
            authType: "api_key",
            baseUrl: "https://openrouter.ai/api/v1",
            baseUrlEnvVar: "OPENROUTER_BASE_URL",
            apiKeyEnvVars: ["GITHUB_TOKEN"]
          }
        }
      }
    );
    assert.equal(
      externalCredentialProvider.ready ? null : externalCredentialProvider.code,
      "unsafe_provider"
    );
  } finally {
    await rm(rootPath, { recursive: true, force: true });
  }
}

async function testProbeCommandsHonorDeadlineAndAbortSignal(): Promise<void> {
  const rootPath = await createRoot("probe-deadlines");
  const probeCases: Array<{
    name: string;
    matches(command: string, args: readonly string[]): boolean;
    expectedCode: "unsupported_identity" | "dirty_installation" | "capability_probe_failed";
  }> = [
    {
      name: "version",
      matches: (_command, args) => args[0] === "--version",
      expectedCode: "unsupported_identity"
    },
    {
      name: "git-head",
      matches: (command, args) => command === "/usr/bin/git" && args.includes("rev-parse"),
      expectedCode: "dirty_installation"
    },
    {
      name: "git-status",
      matches: (command, args) => command === "/usr/bin/git" && args.includes("status"),
      expectedCode: "dirty_installation"
    },
    {
      name: "python-capability",
      matches: (_command, args) => args[0] === "-I",
      expectedCode: "capability_probe_failed"
    }
  ];

  try {
    for (const testCase of probeCases) {
      const baseRunner = fakeHermesRunner();
      let targetedCalls = 0;
      let chatCalls = 0;
      let abortSignalsObserved = 0;
      const processRunner: HermesProposalProcessRunner = async (command, args, options) => {
        if (args[0] === "chat") chatCalls += 1;
        if (!testCase.matches(command, args)) {
          return await baseRunner(command, args, options);
        }
        targetedCalls += 1;
        assert.equal(options.timeoutMs, 10, `${testCase.name} must receive the probe deadline`);
        assert.ok(options.signal, `${testCase.name} must receive an AbortSignal`);
        return await new Promise<{ stdout: string; stderr: string }>((_resolve, reject) => {
          const onAbort = () => {
            abortSignalsObserved += 1;
            reject(new Error(`${testCase.name} aborted`));
          };
          if (options.signal?.aborted) onAbort();
          else options.signal?.addEventListener("abort", onAbort, { once: true });
        });
      };
      const startedAt = Date.now();
      const result = await probeHermesVaultNoWriteCapability({
        ...fakeIdentityDependencies(),
        attemptId: `attempt-probe-deadline-${testCase.name}`,
        command: FAKE_DISCOVERY_COMMAND,
        providerId: "openrouter",
        modelId: "model",
        isolationRootPath: path.join(rootPath, testCase.name),
        credentialEnvironment: { OPENROUTER_API_KEY: "secret" },
        processRunner,
        probeCommandTimeoutMs: 10
      });
      assert.equal(result.ready, false, `${testCase.name} must fail closed`);
      if (result.ready) continue;
      assert.equal(result.code, testCase.expectedCode);
      assert.equal(targetedCalls, 1);
      assert.equal(abortSignalsObserved, 1, `${testCase.name} must be actively aborted`);
      assert.equal(chatCalls, 0, `${testCase.name} failure must not submit a prompt`);
      assert.ok(
        Date.now() - startedAt < 500,
        `${testCase.name} must settle on the injected deadline`
      );
    }

    for (const operationName of ["project-resolver", "launch-inspector"] as const) {
      const baseIdentity = fakeIdentityDependencies();
      let operationAborts = 0;
      let chatCalls = 0;
      const processRunner = fakeHermesRunner({
        onCall: (_command, args) => {
          if (args[0] === "chat") chatCalls += 1;
        }
      });
      const blockedOperation = async (
        _value: string,
        control?: { signal: AbortSignal; timeoutMs: number }
      ): Promise<any> => {
        assert.equal(control?.timeoutMs, 10);
        assert.ok(control?.signal);
        return await new Promise((_resolve, reject) => {
          const onAbort = () => {
            operationAborts += 1;
            reject(new Error(`${operationName} aborted`));
          };
          if (control?.signal.aborted) onAbort();
          else control?.signal.addEventListener("abort", onAbort, { once: true });
        });
      };
      const startedAt = Date.now();
      const result = await probeHermesVaultNoWriteCapability({
        attemptId: `attempt-${operationName}-deadline`,
        command: FAKE_DISCOVERY_COMMAND,
        providerId: "openrouter",
        modelId: "model",
        isolationRootPath: path.join(rootPath, operationName),
        credentialEnvironment: { OPENROUTER_API_KEY: "secret" },
        processRunner,
        projectResolver: operationName === "project-resolver"
          ? blockedOperation
          : baseIdentity.projectResolver,
        launchInspector: operationName === "launch-inspector"
          ? blockedOperation
          : baseIdentity.launchInspector,
        probeCommandTimeoutMs: 10
      });
      assert.equal(result.ready, false);
      if (result.ready) continue;
      assert.equal(result.code, "unsupported_identity");
      assert.equal(operationAborts, 1, `${operationName} must receive an active abort`);
      assert.equal(chatCalls, 0, `${operationName} timeout must not submit a prompt`);
      assert.ok(
        Date.now() - startedAt < 500,
        `${operationName} must settle on the injected deadline`
      );
    }

    const baseRunner = fakeHermesRunner();
    let versionCalls = 0;
    let revalidationAborts = 0;
    let chatCalls = 0;
    const revalidationRunner: HermesProposalProcessRunner = async (command, args, options) => {
      if (args[0] === "chat") chatCalls += 1;
      if (args[0] === "--version") {
        versionCalls += 1;
        if (versionCalls === 2) {
          assert.equal(options.timeoutMs, 10);
          assert.ok(options.signal);
          return await new Promise<{ stdout: string; stderr: string }>((_resolve, reject) => {
            const onAbort = () => {
              revalidationAborts += 1;
              reject(new Error("invocation revalidation aborted"));
            };
            if (options.signal?.aborted) onAbort();
            else options.signal?.addEventListener("abort", onAbort, { once: true });
          });
        }
      }
      return await baseRunner(command, args, options);
    };
    const attemptId = "attempt-invocation-probe-deadline";
    const capabilityResult = await probeHermesVaultNoWriteCapability({
      ...fakeIdentityDependencies(),
      attemptId,
      command: FAKE_DISCOVERY_COMMAND,
      providerId: "openrouter",
      modelId: "model",
      isolationRootPath: path.join(rootPath, "invocation-revalidation"),
      credentialEnvironment: { OPENROUTER_API_KEY: "secret" },
      processRunner: revalidationRunner,
      probeCommandTimeoutMs: 10
    });
    assert.equal(capabilityResult.ready, true);
    if (!capabilityResult.ready) return;
    const validation = baseValidation(attemptId);
    const paths = await prepareInvocationPaths(rootPath, "invocation-probe-deadline");
    const startedAt = Date.now();
    await assert.rejects(
      () => runHermesProposalInvocation({
        capability: capabilityResult.capability,
        lease: boundLease({ attemptId, validation }),
        prompt: INVOCATION_PROMPT,
        systemPrompt: INVOCATION_SYSTEM_PROMPT,
        validation,
        deniedLivePaths: [paths.liveVaultPath],
        deniedControlPaths: [paths.controlRootPath],
        hostMaterializerRoots: writableRoots(paths.shadowVaultPath),
        timeoutMs: 1_000
      }),
      (error: unknown) =>
        error instanceof HermesProposalRuntimeError
        && error.code === "capability_untrusted"
        && runtimeReceipt(error)?.reason === "capability_revalidation_failed"
    );
    assert.equal(versionCalls, 2);
    assert.equal(revalidationAborts, 1);
    assert.equal(chatCalls, 0, "a stuck invocation revalidation must not submit a prompt");
    assert.ok(
      Date.now() - startedAt < 500,
      "invocation revalidation must settle on the stored probe deadline"
    );

    for (const operationName of ["project-resolver", "launch-inspector"] as const) {
      const operationAttemptId = `attempt-${operationName}-revalidation-deadline`;
      const baseIdentity = fakeIdentityDependencies();
      const baseProcessRunner = fakeHermesRunner();
      let operationCalls = 0;
      let operationAborts = 0;
      let operationChatCalls = 0;
      const processRunner: HermesProposalProcessRunner = async (command, args, options) => {
        if (args[0] === "chat") operationChatCalls += 1;
        return await baseProcessRunner(command, args, options);
      };
      const projectResolver: HermesProposalProjectResolver = operationName === "project-resolver"
        ? async (command, control) => {
          operationCalls += 1;
          if (operationCalls === 1) {
            return await baseIdentity.projectResolver(command, control);
          }
          assert.equal(control?.timeoutMs, 10);
          assert.ok(control?.signal);
          return await new Promise<string>((_resolve, reject) => {
            const onAbort = () => {
              operationAborts += 1;
              reject(new Error("project resolver revalidation aborted"));
            };
            if (control?.signal.aborted) onAbort();
            else control?.signal.addEventListener("abort", onAbort, { once: true });
          });
        }
        : baseIdentity.projectResolver;
      const launchInspector: HermesProposalLaunchInspector = operationName === "launch-inspector"
        ? async (projectPath, control) => {
          operationCalls += 1;
          if (operationCalls === 1) {
            return await baseIdentity.launchInspector(projectPath, control);
          }
          assert.equal(control?.timeoutMs, 10);
          assert.ok(control?.signal);
          return await new Promise<HermesProposalLaunchIdentity>((_resolve, reject) => {
            const onAbort = () => {
              operationAborts += 1;
              reject(new Error("launch inspector revalidation aborted"));
            };
            if (control?.signal.aborted) onAbort();
            else control?.signal.addEventListener("abort", onAbort, { once: true });
          });
        }
        : baseIdentity.launchInspector;
      const operationCapability = await probeHermesVaultNoWriteCapability({
        attemptId: operationAttemptId,
        command: FAKE_DISCOVERY_COMMAND,
        providerId: "openrouter",
        modelId: "model",
        isolationRootPath: path.join(rootPath, `${operationName}-revalidation`),
        credentialEnvironment: { OPENROUTER_API_KEY: "secret" },
        processRunner,
        projectResolver,
        launchInspector,
        probeCommandTimeoutMs: 10
      });
      assert.equal(operationCapability.ready, true);
      if (!operationCapability.ready) continue;
      const operationValidation = baseValidation(operationAttemptId);
      const operationPaths = await prepareInvocationPaths(
        rootPath,
        `${operationName}-revalidation`
      );
      const operationStartedAt = Date.now();
      await assert.rejects(
        () => runHermesProposalInvocation({
          capability: operationCapability.capability,
          lease: boundLease({
            attemptId: operationAttemptId,
            validation: operationValidation
          }),
          prompt: INVOCATION_PROMPT,
          systemPrompt: INVOCATION_SYSTEM_PROMPT,
          validation: operationValidation,
          deniedLivePaths: [operationPaths.liveVaultPath],
          deniedControlPaths: [operationPaths.controlRootPath],
          hostMaterializerRoots: writableRoots(operationPaths.shadowVaultPath),
          timeoutMs: 1_000
        }),
        (error: unknown) =>
          error instanceof HermesProposalRuntimeError
          && error.code === "capability_untrusted"
          && runtimeReceipt(error)?.reason === "capability_revalidation_failed"
      );
      assert.equal(operationCalls, 2);
      assert.equal(operationAborts, 1);
      assert.equal(
        operationChatCalls,
        0,
        `${operationName} revalidation timeout must not submit a prompt`
      );
      assert.ok(
        Date.now() - operationStartedAt < 500,
        `${operationName} revalidation must settle on the stored probe deadline`
      );
    }
  } finally {
    await rm(rootPath, { recursive: true, force: true });
  }
}

async function testOpaqueCapabilityLeaseProposalAndReceiptBrands(): Promise<void> {
  const rootPath = await createRoot("opaque-brands");
  try {
    const capabilityResult = await probeWith(rootPath, "capability", {});
    assert.equal(capabilityResult.ready, true);
    if (!capabilityResult.ready) return;

    const capabilityCloneLease = createHermesProposalLease({
      attemptId: "attempt-capability-clone",
      inputDigest: fingerprint("capability-clone")
    });
    await assert.rejects(
      () => runHermesProposalInvocation({
        capability: { ...capabilityResult.capability } as HermesVaultNoWriteCapability,
        lease: capabilityCloneLease,
        prompt: "prompt",
        systemPrompt: "system",
        validation: baseValidation("attempt-capability-clone"),
        deniedLivePaths: [path.join(rootPath, "live")],
        deniedControlPaths: [path.join(rootPath, "control")],
        hostMaterializerRoots: [path.join(rootPath, "shadow", "wiki")],
        timeoutMs: 100
      }),
      (error: unknown) => {
        const receipt = runtimeReceipt(error);
        return errorCode(error) === "capability_untrusted"
          && receipt?.noAcceptedProposal === true
          && isTrustedHermesProposalLeaseRevocationReceipt(receipt);
      }
    );

    const lease = createHermesProposalLease({
      attemptId: "attempt-lease-clone",
      inputDigest: fingerprint("lease-clone")
    });
    await assert.rejects(
      () => runHermesProposalInvocation({
        capability: capabilityResult.capability,
        lease: { ...lease },
        prompt: "prompt",
        systemPrompt: "system",
        validation: baseValidation("attempt-lease-clone"),
        deniedLivePaths: [path.join(rootPath, "live")],
        deniedControlPaths: [path.join(rootPath, "control")],
        hostMaterializerRoots: [path.join(rootPath, "shadow", "wiki")],
        timeoutMs: 100
      }),
      (error: unknown) => errorCode(error) === "lease_untrusted"
    );
    assert.equal(isHermesProposalLeaseActive(lease), true);

    const proposalCloneFixture = await createInvocationFixture(
      rootPath,
      "proposal-clone",
      [operation("wiki/clone.md")],
      {}
    );
    await assert.rejects(
      () => materializeHermesMaintenanceProposal({
        shadowVaultPath: proposalCloneFixture.shadowVaultPath,
        proposal: {
          ...proposalCloneFixture.invocation.proposal,
          operations: [...proposalCloneFixture.invocation.proposal.operations],
          rejectedOperations: [...proposalCloneFixture.invocation.proposal.rejectedOperations]
        },
        authorityReceipt: proposalCloneFixture.invocation.authorityReceipt,
        lease: proposalCloneFixture.lease
      }),
      (error: unknown) =>
        error instanceof HermesProposalMaterializationError
        && error.code === "proposal_untrusted"
        && error.revocationReceipt?.noAcceptedProposal === true
    );

    const receiptCloneFixture = await createInvocationFixture(
      rootPath,
      "receipt-clone",
      [operation("wiki/receipt.md")],
      {}
    );
    const receiptClone = {
      ...receiptCloneFixture.invocation.authorityReceipt,
      deniedLivePaths: [...receiptCloneFixture.invocation.authorityReceipt.deniedLivePaths],
      deniedControlPaths: [...receiptCloneFixture.invocation.authorityReceipt.deniedControlPaths],
      hostMaterializerRoots: [...receiptCloneFixture.invocation.authorityReceipt.hostMaterializerRoots]
    };
    assert.equal(isTrustedHermesVaultNoWriteAuthorityReceipt(receiptClone), false);
    await assert.rejects(
      () => materializeHermesMaintenanceProposal({
        shadowVaultPath: receiptCloneFixture.shadowVaultPath,
        proposal: receiptCloneFixture.invocation.proposal,
        authorityReceipt: receiptClone,
        lease: receiptCloneFixture.lease
      }),
      (error: unknown) =>
        error instanceof HermesProposalMaterializationError
        && error.code === "authority_untrusted"
        && error.revocationReceipt?.noAcceptedProposal === true
    );

    const unboundFixture = await createInvocationFixture(
      rootPath,
      "unbound",
      [operation("wiki/bound.md")],
      {}
    );
    const independentlyValidated = parseAndValidateHermesMaintenanceProposal(
      proposalJson("attempt-unbound", [operation("wiki/bound.md")]),
      baseValidation("attempt-unbound")
    );
    await assert.rejects(
      () => materializeHermesMaintenanceProposal({
        shadowVaultPath: unboundFixture.shadowVaultPath,
        proposal: independentlyValidated,
        authorityReceipt: unboundFixture.invocation.authorityReceipt,
        lease: unboundFixture.lease
      }),
      (error: unknown) =>
        error instanceof HermesProposalMaterializationError
        && error.code === "invocation_unbound"
        && error.revocationReceipt?.noAcceptedProposal === true
    );
  } finally {
    await rm(rootPath, { recursive: true, force: true });
  }
}

async function testInvocationRevalidatesIdentityInputAndIsolation(): Promise<void> {
  const rootPath = await createRoot("invocation-revalidation");
  try {
    let launchIdentity = fakeLaunchIdentity();
    let replacementChatCalls = 0;
    const replacementOptions: FakeHermesOptions = {
      launchInspector: async () => launchIdentity,
      onCall: (_command, args) => {
        if (args[0] === "chat") replacementChatCalls += 1;
      }
    };
    const replacementCapability = await probeWith(
      rootPath,
      "entrypoint-replaced",
      replacementOptions
    );
    assert.equal(replacementCapability.ready, true);
    if (!replacementCapability.ready) return;
    launchIdentity = fakeLaunchIdentity({
      commandDigest: fingerprint("entrypoint-replaced")
    });
    const replacementPaths = await prepareInvocationPaths(
      rootPath,
      "entrypoint-replaced"
    );
    const replacementValidation = baseValidation("attempt-entrypoint-replaced");
    const replacementLease = boundLease({
      attemptId: "attempt-entrypoint-replaced",
      validation: replacementValidation
    });
    await assert.rejects(
      () => runHermesProposalInvocation({
        capability: replacementCapability.capability,
        lease: replacementLease,
        prompt: INVOCATION_PROMPT,
        systemPrompt: INVOCATION_SYSTEM_PROMPT,
        validation: replacementValidation,
        deniedLivePaths: [replacementPaths.liveVaultPath],
        deniedControlPaths: [replacementPaths.controlRootPath],
        hostMaterializerRoots: writableRoots(replacementPaths.shadowVaultPath),
        timeoutMs: 100
      }),
      (error: unknown) => errorCode(error) === "capability_untrusted"
    );
    assert.equal(replacementChatCalls, 0);

    let gitChatCalls = 0;
    const mutableGitOptions: FakeHermesOptions = {
      head: FULL_LOCAL_COMMIT,
      onCall: (_command, args) => {
        if (args[0] === "chat") gitChatCalls += 1;
      }
    };
    const gitCapability = await probeWith(rootPath, "git-replaced", mutableGitOptions);
    assert.equal(gitCapability.ready, true);
    if (!gitCapability.ready) return;
    mutableGitOptions.head = "0000000000000000000000000000000000000000";
    const gitPaths = await prepareInvocationPaths(rootPath, "git-replaced");
    const gitValidation = baseValidation("attempt-git-replaced");
    await assert.rejects(
      () => runHermesProposalInvocation({
        capability: gitCapability.capability,
        lease: boundLease({
          attemptId: "attempt-git-replaced",
          validation: gitValidation
        }),
        prompt: INVOCATION_PROMPT,
        systemPrompt: INVOCATION_SYSTEM_PROMPT,
        validation: gitValidation,
        deniedLivePaths: [gitPaths.liveVaultPath],
        deniedControlPaths: [gitPaths.controlRootPath],
        hostMaterializerRoots: writableRoots(gitPaths.shadowVaultPath),
        timeoutMs: 100
      }),
      (error: unknown) => errorCode(error) === "capability_untrusted"
    );
    assert.equal(gitChatCalls, 0);

    const digestCapability = await probeWith(rootPath, "digest-mismatch", {});
    assert.equal(digestCapability.ready, true);
    if (!digestCapability.ready) return;
    const digestPaths = await prepareInvocationPaths(rootPath, "digest-mismatch");
    const digestValidation = baseValidation("attempt-digest-mismatch");
    const digestLease = createHermesProposalLease({
      attemptId: "attempt-digest-mismatch",
      inputDigest: hermesProposalInvocationInputDigest({
        prompt: "original prompt",
        systemPrompt: INVOCATION_SYSTEM_PROMPT,
        validation: digestValidation
      })
    });
    await assert.rejects(
      () => runHermesProposalInvocation({
        capability: digestCapability.capability,
        lease: digestLease,
        prompt: "tampered prompt",
        systemPrompt: INVOCATION_SYSTEM_PROMPT,
        validation: digestValidation,
        deniedLivePaths: [digestPaths.liveVaultPath],
        deniedControlPaths: [digestPaths.controlRootPath],
        hostMaterializerRoots: writableRoots(digestPaths.shadowVaultPath),
        timeoutMs: 100
      }),
      (error: unknown) =>
        errorCode(error) === "lease_untrusted"
        && runtimeReceipt(error)?.reason === "input_digest_mismatch"
    );

    const mutableSources = new Map<string, string>([[SOURCE_PATH, SOURCE_HASH]]);
    const mutableValidation: HermesProposalValidationContext = {
      attemptId: "attempt-validation-mutation",
      sourceFingerprints: mutableSources,
      targetFingerprints: {}
    };
    const mutationCapability = await probeWith(
      rootPath,
      "validation-mutation",
      {}
    );
    assert.equal(mutationCapability.ready, true);
    if (!mutationCapability.ready) return;
    const mutationLease = boundLease({
      attemptId: "attempt-validation-mutation",
      validation: mutableValidation
    });
    mutableSources.set(SOURCE_PATH, fingerprint("source-mutated-after-lease"));
    const mutationPaths = await prepareInvocationPaths(
      rootPath,
      "validation-mutation"
    );
    await assert.rejects(
      () => runHermesProposalInvocation({
        capability: mutationCapability.capability,
        lease: mutationLease,
        prompt: INVOCATION_PROMPT,
        systemPrompt: INVOCATION_SYSTEM_PROMPT,
        validation: mutableValidation,
        deniedLivePaths: [mutationPaths.liveVaultPath],
        deniedControlPaths: [mutationPaths.controlRootPath],
        hostMaterializerRoots: writableRoots(mutationPaths.shadowVaultPath),
        timeoutMs: 100
      }),
      (error: unknown) =>
        errorCode(error) === "lease_untrusted"
        && runtimeReceipt(error)?.reason === "input_digest_mismatch"
    );

    const isolationCapability = await probeWith(rootPath, "isolation-overlap", {});
    assert.equal(isolationCapability.ready, true);
    if (!isolationCapability.ready) return;
    const isolationPaths = await prepareInvocationPaths(rootPath, "isolation-overlap");
    const isolationValidation = baseValidation("attempt-isolation-overlap");
    await assert.rejects(
      () => runHermesProposalInvocation({
        capability: isolationCapability.capability,
        lease: boundLease({
          attemptId: "attempt-isolation-overlap",
          validation: isolationValidation
        }),
        prompt: INVOCATION_PROMPT,
        systemPrompt: INVOCATION_SYSTEM_PROMPT,
        validation: isolationValidation,
        deniedLivePaths: [isolationCapability.capability.isolatedHomePath],
        deniedControlPaths: [isolationPaths.controlRootPath],
        hostMaterializerRoots: writableRoots(isolationPaths.shadowVaultPath),
        timeoutMs: 100
      }),
      (error: unknown) =>
        errorCode(error) === "capability_untrusted"
        && runtimeReceipt(error)?.reason === "capability_revalidation_failed"
    );
  } finally {
    await rm(rootPath, { recursive: true, force: true });
  }
}

async function testMaterializerNewPageExistingPageAndCasRace(): Promise<void> {
  const rootPath = await createRoot("materialize");
  try {
    const existingContent = "old";
    const updatedContent = "updated";
    const fixtureRoot = path.join(rootPath, "success");
    const shadowVaultPath = await prepareShadow(fixtureRoot);
    await writeFile(path.join(shadowVaultPath, "wiki", "existing.md"), existingContent, "utf8");
    const fixture = await createInvocationFixture(
      rootPath,
      "success",
      [
        {
          ...operation("wiki/existing.md"),
          content: updatedContent,
          baseSha256: fingerprint(existingContent)
        },
        {
          ...operation("wiki/new-page.md"),
          content: "new",
          baseSha256: null
        }
      ],
      { "wiki/existing.md": fingerprint(existingContent) },
      shadowVaultPath
    );
    const result = await materializeHermesMaintenanceProposal({
      shadowVaultPath: fixture.shadowVaultPath,
      proposal: fixture.invocation.proposal,
      authorityReceipt: fixture.invocation.authorityReceipt,
      lease: fixture.lease
    });
    assert.equal(result.outcome, "committable");
    assert.deepEqual(result.materializedPaths, ["wiki/existing.md", "wiki/new-page.md"]);
    assert.equal(await readFile(path.join(fixture.shadowVaultPath, "wiki", "existing.md"), "utf8"), updatedContent);
    assert.equal(await readFile(path.join(fixture.shadowVaultPath, "wiki", "new-page.md"), "utf8"), "new");
    assert.equal(result.revocationReceipt.noAcceptedProposal, false);
    assert.equal(result.revocationReceipt.acceptedProposalDigest, fixture.invocation.proposal.digest);
    assert.equal(isTrustedHermesProposalLeaseRevocationReceipt(result.revocationReceipt), true);
    assert.equal(isTrustedHermesProposalLeaseRevocationReceipt({ ...result.revocationReceipt }), false);
    assert.equal(isHermesProposalLeaseActive(fixture.lease), false);

    const partialFixture = await createInvocationFixture(
      rootPath,
      "partial",
      [
        { ...operation("wiki/partial-valid.md"), content: "valid" },
        { ...operation("raw/partial-invalid.md"), content: "invalid" }
      ],
      {}
    );
    const partialResult = await materializeHermesMaintenanceProposal({
      shadowVaultPath: partialFixture.shadowVaultPath,
      proposal: partialFixture.invocation.proposal,
      authorityReceipt: partialFixture.invocation.authorityReceipt,
      lease: partialFixture.lease
    });
    assert.equal(partialResult.outcome, "partial");
    assert.deepEqual(partialResult.materializedPaths, ["wiki/partial-valid.md"]);
    assert.equal(
      await readFile(path.join(partialFixture.shadowVaultPath, "wiki", "partial-valid.md"), "utf8"),
      "valid"
    );
    await assert.rejects(
      () => lstat(path.join(partialFixture.shadowVaultPath, "raw", "partial-invalid.md")),
      (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT"
    );

    const raceFixture = await createInvocationFixture(
      rootPath,
      "race-new-page",
      [{ ...operation("wiki/race.md"), content: "agent", baseSha256: null }],
      {}
    );
    await assert.rejects(
      () => materializeHermesMaintenanceProposal({
        shadowVaultPath: raceFixture.shadowVaultPath,
        proposal: raceFixture.invocation.proposal,
        authorityReceipt: raceFixture.invocation.authorityReceipt,
        lease: raceFixture.lease,
        beforeApply: async () => {
          await writeFile(path.join(raceFixture.shadowVaultPath, "wiki", "race.md"), "concurrent", "utf8");
        }
      }),
      (error: unknown) =>
        error instanceof HermesProposalMaterializationError
        && error.code === "target_changed"
        && error.revocationReceipt?.noAcceptedProposal === true
    );
    assert.equal(
      await readFile(path.join(raceFixture.shadowVaultPath, "wiki", "race.md"), "utf8"),
      "concurrent"
    );

    const changedFixtureRoot = path.join(rootPath, "changed-existing");
    const changedShadow = await prepareShadow(changedFixtureRoot);
    await writeFile(path.join(changedShadow, "wiki", "changed.md"), "baseline", "utf8");
    const changedFixture = await createInvocationFixture(
      rootPath,
      "changed-existing",
      [{
        ...operation("wiki/changed.md"),
        content: "agent",
        baseSha256: fingerprint("baseline")
      }],
      { "wiki/changed.md": fingerprint("baseline") },
      changedShadow
    );
    await writeFile(path.join(changedShadow, "wiki", "changed.md"), "concurrent", "utf8");
    await assert.rejects(
      () => materializeHermesMaintenanceProposal({
        shadowVaultPath: changedFixture.shadowVaultPath,
        proposal: changedFixture.invocation.proposal,
        authorityReceipt: changedFixture.invocation.authorityReceipt,
        lease: changedFixture.lease
      }),
      (error: unknown) =>
        error instanceof HermesProposalMaterializationError
        && error.code === "target_changed"
        && error.revocationReceipt?.noAcceptedProposal === true
    );
    assert.equal(await readFile(path.join(changedShadow, "wiki", "changed.md"), "utf8"), "concurrent");
  } finally {
    await rm(rootPath, { recursive: true, force: true });
  }
}

async function testMaterializerRejectsSymlinkHardlinkSpecialAndParentEscape(): Promise<void> {
  const rootPath = await createRoot("unsafe-entries");
  try {
    const outsidePath = path.join(rootPath, "outside.md");
    await writeFile(outsidePath, "outside", "utf8");

    const symlinkFixture = await createInvocationFixture(
      rootPath,
      "symlink",
      [{
        ...operation("wiki/symlink.md"),
        content: "agent",
        baseSha256: fingerprint("outside")
      }],
      { "wiki/symlink.md": fingerprint("outside") }
    );
    await symlink(outsidePath, path.join(symlinkFixture.shadowVaultPath, "wiki", "symlink.md"));
    await assertUnsafeMaterialization(symlinkFixture, "unsafe_entry");
    assert.equal(await readFile(outsidePath, "utf8"), "outside");

    const hardlinkFixture = await createInvocationFixture(
      rootPath,
      "hardlink",
      [{
        ...operation("wiki/hardlink.md"),
        content: "agent",
        baseSha256: fingerprint("outside")
      }],
      { "wiki/hardlink.md": fingerprint("outside") }
    );
    await link(outsidePath, path.join(hardlinkFixture.shadowVaultPath, "wiki", "hardlink.md"));
    await assertUnsafeMaterialization(hardlinkFixture, "unsafe_entry");
    assert.equal(await readFile(outsidePath, "utf8"), "outside");
    assert.equal((await lstat(outsidePath)).nlink >= 2, true);

    const parentFixture = await createInvocationFixture(
      rootPath,
      "parent-symlink",
      [operation("wiki/linked-parent/page.md")],
      {}
    );
    const outsideDirectory = path.join(rootPath, "outside-directory");
    await mkdir(outsideDirectory, { recursive: true });
    await symlink(outsideDirectory, path.join(parentFixture.shadowVaultPath, "wiki", "linked-parent"));
    await assertUnsafeMaterialization(parentFixture, "unsafe_entry");
    await assert.rejects(
      () => lstat(path.join(outsideDirectory, "page.md")),
      (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT"
    );

    if (process.platform !== "win32") {
      const fifoFixture = await createInvocationFixture(
        rootPath,
        "fifo",
        [operation("wiki/fifo.md")],
        {}
      );
      execFileSync("mkfifo", [path.join(fifoFixture.shadowVaultPath, "wiki", "fifo.md")]);
      await assertUnsafeMaterialization(fifoFixture, "unsafe_entry");
    }
  } finally {
    await rm(rootPath, { recursive: true, force: true });
  }
}

async function testTimeoutCancelAndNeverSettlingRunner(): Promise<void> {
  const rootPath = await createRoot("timeout");
  try {
    const attemptId = "attempt-timeout";
    const proposal = proposalJson(attemptId, [operation("wiki/late.md")]);
    const capabilityResult = await probeHermesVaultNoWriteCapability({
      ...fakeIdentityDependencies(),
      attemptId,
      command: FAKE_DISCOVERY_COMMAND,
      providerId: "openrouter",
      modelId: "model",
      isolationRootPath: path.join(rootPath, "isolation"),
      credentialEnvironment: { OPENROUTER_API_KEY: "secret" },
      processRunner: fakeHermesRunner({
        chatStdout: proposal,
        chatDelayMs: 30,
        chatIgnoresAbort: true
      })
    });
    assert.equal(capabilityResult.ready, true);
    if (!capabilityResult.ready) return;
    const validation = baseValidation(attemptId);
    const lease = boundLease({ attemptId, validation });
    const paths = await prepareInvocationPaths(rootPath, "timeout");
    const startedAt = Date.now();
    await assert.rejects(
      () => runHermesProposalInvocation({
        capability: capabilityResult.capability,
        lease,
        prompt: INVOCATION_PROMPT,
        systemPrompt: INVOCATION_SYSTEM_PROMPT,
        validation,
        deniedLivePaths: [paths.liveVaultPath],
        deniedControlPaths: [paths.controlRootPath],
        hostMaterializerRoots: writableRoots(paths.shadowVaultPath),
        timeoutMs: 5,
        terminationGraceMs: 100
      }),
      (error: unknown) => {
        const receipt = runtimeReceipt(error);
        return error instanceof HermesProposalRuntimeError
          && error.code === "timeout"
          && typeof error.terminationConfirmedAt === "number"
          && error.terminationConfirmedAt >= startedAt
          && receipt?.reason === "timeout"
          && receipt.noAcceptedProposal === true
          && isTrustedHermesProposalLeaseRevocationReceipt(receipt);
      }
    );
    assert.ok(
      Date.now() - startedAt >= 20,
      "termination confirmation must wait for the delayed runner to settle"
    );
    assert.equal(isHermesProposalLeaseActive(lease), false);
    await delay(40, undefined, true);
    await assert.rejects(
      () => lstat(path.join(paths.shadowVaultPath, "wiki", "late.md")),
      (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT"
    );

    const neverAttemptId = "attempt-never-settles";
    const neverCapability = await probeHermesVaultNoWriteCapability({
      ...fakeIdentityDependencies(),
      attemptId: neverAttemptId,
      command: FAKE_DISCOVERY_COMMAND,
      providerId: "openrouter",
      modelId: "model",
      isolationRootPath: path.join(rootPath, "never-isolation"),
      credentialEnvironment: { OPENROUTER_API_KEY: "secret" },
      processRunner: fakeHermesRunner({ chatNeverSettles: true })
    });
    assert.equal(neverCapability.ready, true);
    if (!neverCapability.ready) return;
    const neverValidation = baseValidation(neverAttemptId);
    const neverPaths = await prepareInvocationPaths(rootPath, "never");
    const neverStartedAt = Date.now();
    await assert.rejects(
      () => runHermesProposalInvocation({
        capability: neverCapability.capability,
        lease: boundLease({
          attemptId: neverAttemptId,
          validation: neverValidation
        }),
        prompt: INVOCATION_PROMPT,
        systemPrompt: INVOCATION_SYSTEM_PROMPT,
        validation: neverValidation,
        deniedLivePaths: [neverPaths.liveVaultPath],
        deniedControlPaths: [neverPaths.controlRootPath],
        hostMaterializerRoots: writableRoots(neverPaths.shadowVaultPath),
        timeoutMs: 5,
        terminationGraceMs: 20
      }),
      (error: unknown) => {
        assert.equal(error instanceof HermesProposalRuntimeError, true);
        if (!(error instanceof HermesProposalRuntimeError)) return false;
        return error.code === "timeout"
          && error.terminationConfirmedAt === undefined
          && runtimeReceipt(error)?.reason === "timeout";
      }
    );
    assert.ok(
      Date.now() - neverStartedAt < 250,
      "a never-settling runner must return after the bounded termination grace"
    );

    const cancelAttemptId = "attempt-pre-cancel";
    let cancelChatCalls = 0;
    const cancelCapability = await probeHermesVaultNoWriteCapability({
      ...fakeIdentityDependencies(),
      attemptId: cancelAttemptId,
      command: FAKE_DISCOVERY_COMMAND,
      providerId: "openrouter",
      modelId: "model",
      isolationRootPath: path.join(rootPath, "cancel-isolation"),
      credentialEnvironment: { OPENROUTER_API_KEY: "secret" },
      processRunner: fakeHermesRunner({
        onCall: (_command, args) => {
          if (args[0] === "chat") cancelChatCalls += 1;
        }
      })
    });
    assert.equal(cancelCapability.ready, true);
    if (!cancelCapability.ready) return;
    const cancelValidation = baseValidation(cancelAttemptId);
    const cancelPaths = await prepareInvocationPaths(rootPath, "cancel");
    const abortController = new AbortController();
    abortController.abort();
    await assert.rejects(
      () => runHermesProposalInvocation({
        capability: cancelCapability.capability,
        lease: boundLease({
          attemptId: cancelAttemptId,
          validation: cancelValidation
        }),
        prompt: INVOCATION_PROMPT,
        systemPrompt: INVOCATION_SYSTEM_PROMPT,
        validation: cancelValidation,
        deniedLivePaths: [cancelPaths.liveVaultPath],
        deniedControlPaths: [cancelPaths.controlRootPath],
        hostMaterializerRoots: writableRoots(cancelPaths.shadowVaultPath),
        timeoutMs: 100,
        abortSignal: abortController.signal
      }),
      (error: unknown) =>
        errorCode(error) === "canceled"
        && runtimeReceipt(error)?.reason === "canceled_before_submission"
    );
    assert.equal(cancelChatCalls, 0);
  } finally {
    await rm(rootPath, { recursive: true, force: true });
  }
}

async function testServiceRunsTrustedProposalTransportAndMaterializesShadow(): Promise<void> {
  const rootPath = await createRoot("service-production");
  try {
    const liveVaultPath = path.join(rootPath, "live");
    const controlRootPath = path.join(rootPath, "control");
    const shadowVaultPath = path.join(rootPath, "shadow");
    const sourcePath = path.join(shadowVaultPath, "raw", "source.md");
    const sourceContent = "# 原始资料\n\n这是需要提炼的事实。";
    const sourceSha256 = fingerprint(sourceContent);
    const attemptId = "service-production-attempt-1-hermes";
    const reportPath = "outputs/maintenance/kb-maintenance-service.md";
    const pagePath = "wiki/service-topic.md";
    const proposal = proposalJson(attemptId, [
      {
        op: "upsert",
        path: pagePath,
        content: "# Service Topic\n\n- 这是需要提炼的事实。来源：[[raw/source.md]]\n",
        sources: [{ path: SOURCE_PATH, sha256: sourceSha256 }],
        baseSha256: null
      },
      {
        op: "upsert",
        path: reportPath,
        content: "# 维护报告\n\n- 已提炼：[[raw/source.md]] -> [[wiki/service-topic.md]]\n",
        sources: [{ path: SOURCE_PATH, sha256: sourceSha256 }],
        baseSha256: null
      }
    ]);
    await Promise.all([
      mkdir(liveVaultPath, { recursive: true }),
      mkdir(controlRootPath, { recursive: true }),
      mkdir(path.dirname(sourcePath), { recursive: true }),
      mkdir(path.join(shadowVaultPath, "wiki"), { recursive: true }),
      mkdir(path.join(shadowVaultPath, "projects"), { recursive: true }),
      mkdir(path.join(shadowVaultPath, "outputs", "maintenance"), { recursive: true }),
      mkdir(path.join(shadowVaultPath, "inbox"), { recursive: true }),
      mkdir(path.join(rootPath, "isolation"), { recursive: true })
    ]);
    await writeFile(sourcePath, sourceContent, "utf8");

    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.agents.hermes.providerId = "openrouter";
    settings.agents.hermes.modelId = "model";
    let fenceConfigured = false;
    let chatCalls = 0;
    const processRunner = fakeHermesRunner({
      chatStdout: proposal,
      onCall: (_command, args) => {
        if (args[0] !== "chat") return;
        chatCalls += 1;
        assert.equal(
          fenceConfigured,
          true,
          "the trusted exact-write receipt must be accepted before Hermes receives the prompt"
        );
      }
    });
    const identityDependencies = fakeIdentityDependencies();
    const service = new KnowledgeBaseAgentTaskService({
      settings,
      getVaultPath: () => liveVaultPath,
      getNativeExecutionRefContext: () => ({})
    } as any, {
      isCancelRequested: () => false
    }, {
      hermesProposalCommand: FAKE_DISCOVERY_COMMAND,
      hermesProposalProcessRunner: processRunner,
      hermesProposalProjectResolver: identityDependencies.projectResolver,
      hermesProposalLaunchInspector: identityDependencies.launchInspector,
      hermesProposalIsolationRootPath: path.join(rootPath, "isolation"),
      hermesProposalCredentialEnvironment: {
        OPENROUTER_API_KEY: "secret"
      },
      hermesProposalCredentialFiles: []
    });
    const exactRoots = [
      path.join(shadowVaultPath, "wiki"),
      path.join(shadowVaultPath, "projects"),
      path.join(shadowVaultPath, "outputs", "maintenance"),
      path.join(shadowVaultPath, "inbox")
    ];
    const output = await service.runTask({
      backend: "hermes",
      prompt: "执行 /maintain，并生成逐来源证据和维护报告。",
      sources: [{
        relativePath: SOURCE_PATH,
        absolutePath: sourcePath,
        size: Buffer.byteLength(sourceContent),
        mtime: Date.now(),
        fingerprint: "legacy-host-fingerprint-is-not-authoritative",
        mime: "text/markdown",
        modality: "text",
        changed: true
      }],
      permission: "workspace-write",
      codexWriteScope: "knowledge-base",
      managedKind: "maintain",
      workflowRunId: "service-production",
      attemptId,
      attemptOrdinal: 1,
      vaultPathOverride: shadowVaultPath,
      writableRootsOverride: exactRoots,
      exactWriteFence: {
        attemptToken: attemptId,
        leaseToken: "service-production-lease",
        deniedLivePaths: [liveVaultPath],
        deniedControlPaths: [controlRootPath]
      },
      onExactWriteFenceConfigured: async (receipt) => {
        assert.equal(isTrustedExactWriteFenceReceipt(receipt), true);
        assert.equal(receipt.backend, "hermes");
        assert.equal(receipt.attemptToken, attemptId);
        assert.equal(receipt.leaseToken, "service-production-lease");
        assert.deepEqual([...receipt.enforcedWritableRoots].sort(), [...exactRoots].sort());
        await assert.rejects(
          () => lstat(path.join(shadowVaultPath, pagePath)),
          (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT"
        );
        fenceConfigured = true;
      }
    });

    assert.equal(chatCalls, 1, "the selected Hermes backend must receive exactly one prompt");
    assert.equal(fenceConfigured, true);
    assert.equal(typeof output.submittedAt, "number");
    assert.equal(output.backend, "hermes");
    assert.equal(output.attemptId, attemptId);
    assert.match(output.harnessRunId ?? "", /^knowledge-hermes-/);
    assert.equal(
      await readFile(path.join(shadowVaultPath, pagePath), "utf8"),
      "# Service Topic\n\n- 这是需要提炼的事实。来源：[[raw/source.md]]\n"
    );
    assert.equal(
      await readFile(path.join(shadowVaultPath, reportPath), "utf8"),
      "# 维护报告\n\n- 已提炼：[[raw/source.md]] -> [[wiki/service-topic.md]]\n"
    );
    await assert.rejects(
      () => lstat(path.join(liveVaultPath, pagePath)),
      (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT"
    );
  } finally {
    await rm(rootPath, { recursive: true, force: true });
  }
}

async function testServiceCancelDuringCapabilityProbe(): Promise<void> {
  const rootPath = await createRoot("service-probe-cancel");
  try {
    const liveVaultPath = path.join(rootPath, "live");
    const controlRootPath = path.join(rootPath, "control");
    const shadowVaultPath = path.join(rootPath, "shadow");
    const sourcePath = path.join(shadowVaultPath, "raw", "source.md");
    const sourceContent = "cancel during capability probe";
    await Promise.all([
      mkdir(liveVaultPath, { recursive: true }),
      mkdir(controlRootPath, { recursive: true }),
      mkdir(path.dirname(sourcePath), { recursive: true }),
      mkdir(path.join(shadowVaultPath, "wiki"), { recursive: true }),
      mkdir(path.join(shadowVaultPath, "projects"), { recursive: true }),
      mkdir(path.join(shadowVaultPath, "outputs", "maintenance"), { recursive: true }),
      mkdir(path.join(shadowVaultPath, "inbox"), { recursive: true }),
      mkdir(path.join(rootPath, "isolation"), { recursive: true })
    ]);
    await writeFile(sourcePath, sourceContent, "utf8");

    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.agents.hermes.providerId = "openrouter";
    settings.agents.hermes.modelId = "model";
    const identityDependencies = fakeIdentityDependencies();
    const exactRoots = [
      path.join(shadowVaultPath, "wiki"),
      path.join(shadowVaultPath, "projects"),
      path.join(shadowVaultPath, "outputs", "maintenance"),
      path.join(shadowVaultPath, "inbox")
    ];

    for (const preparation of ["credential-files", "isolation-root"] as const) {
      let preparationAborts = 0;
      let preparationChatCalls = 0;
      const blockedPreparation = async (signal: AbortSignal): Promise<any> =>
        await new Promise((_resolve, reject) => {
          const onAbort = () => {
            preparationAborts += 1;
            reject(new Error(`${preparation} aborted`));
          };
          if (signal.aborted) onAbort();
          else signal.addEventListener("abort", onAbort, { once: true });
        });
      const preparationService = new KnowledgeBaseAgentTaskService({
        settings,
        getVaultPath: () => liveVaultPath,
        getNativeExecutionRefContext: () => ({})
      } as any, {
        isCancelRequested: () => false
      }, {
        hermesProposalCommand: FAKE_DISCOVERY_COMMAND,
        hermesProposalProcessRunner: fakeHermesRunner({
          onCall: (_command, args) => {
            if (args[0] === "chat") preparationChatCalls += 1;
          }
        }),
        hermesProposalProjectResolver: identityDependencies.projectResolver,
        hermesProposalLaunchInspector: identityDependencies.launchInspector,
        hermesProposalCredentialEnvironment: {
          OPENROUTER_API_KEY: "secret"
        },
        hermesProposalProbeCommandTimeoutMs: 10,
        ...(preparation === "credential-files"
          ? {
            hermesProposalCredentialFilesResolver: blockedPreparation,
            hermesProposalIsolationRootPath: path.join(rootPath, "isolation")
          }
          : {
            hermesProposalCredentialFiles: [],
            hermesProposalIsolationRootResolver: blockedPreparation
          })
      });
      const attemptId = `service-${preparation}-attempt-1-hermes`;
      const startedAt = Date.now();
      await assert.rejects(
        () => preparationService.runTask({
          backend: "hermes",
          prompt: "maintain",
          sources: [{
            relativePath: SOURCE_PATH,
            absolutePath: sourcePath,
            size: Buffer.byteLength(sourceContent),
            mtime: Date.now(),
            fingerprint: "unused",
            mime: "text/markdown",
            modality: "text",
            changed: true
          }],
          permission: "workspace-write",
          codexWriteScope: "knowledge-base",
          managedKind: "maintain",
          workflowRunId: `service-${preparation}`,
          attemptId,
          attemptOrdinal: 1,
          vaultPathOverride: shadowVaultPath,
          writableRootsOverride: exactRoots,
          exactWriteFence: {
            attemptToken: attemptId,
            leaseToken: `service-${preparation}-lease`,
            deniedLivePaths: [liveVaultPath],
            deniedControlPaths: [controlRootPath]
          }
        }),
        (error: unknown) =>
          error instanceof KnowledgeAgentAttemptError
          && error.phase === "preflight"
          && error.code === "BACKEND_UNAVAILABLE"
          && error.submittedAt === undefined
      );
      assert.equal(preparationAborts, 1, `${preparation} must receive an active abort`);
      assert.equal(preparationChatCalls, 0, `${preparation} timeout must not submit a prompt`);
      assert.ok(
        Date.now() - startedAt < 500,
        `${preparation} must settle on the injected deadline`
      );
    }

    const baseRunner = fakeHermesRunner();
    let releaseProbeEntered!: () => void;
    const probeEntered = new Promise<void>((resolve) => {
      releaseProbeEntered = resolve;
    });
    let versionAborts = 0;
    let chatCalls = 0;
    const processRunner: HermesProposalProcessRunner = async (command, args, options) => {
      if (args[0] === "chat") chatCalls += 1;
      if (args[0] !== "--version") {
        return await baseRunner(command, args, options);
      }
      assert.equal(options.timeoutMs, 5_000);
      assert.ok(options.signal);
      releaseProbeEntered();
      return await new Promise<{ stdout: string; stderr: string }>((_resolve, reject) => {
        const onAbort = () => {
          versionAborts += 1;
          reject(new Error("version probe canceled"));
        };
        if (options.signal?.aborted) onAbort();
        else options.signal?.addEventListener("abort", onAbort, { once: true });
      });
    };
    let cancelRequested = false;
    let terminalSettlements = 0;
    const service = new KnowledgeBaseAgentTaskService({
      settings,
      getVaultPath: () => liveVaultPath,
      getNativeExecutionRefContext: () => ({}),
      settleHarnessRunTerminal: async () => {
        terminalSettlements += 1;
      }
    } as any, {
      isCancelRequested: () => cancelRequested
    }, {
      hermesProposalCommand: FAKE_DISCOVERY_COMMAND,
      hermesProposalProcessRunner: processRunner,
      hermesProposalProjectResolver: identityDependencies.projectResolver,
      hermesProposalLaunchInspector: identityDependencies.launchInspector,
      hermesProposalIsolationRootPath: path.join(rootPath, "isolation"),
      hermesProposalCredentialEnvironment: {
        OPENROUTER_API_KEY: "secret"
      },
      hermesProposalCredentialFiles: [],
      hermesProposalProbeCommandTimeoutMs: 5_000,
      hermesProposalTerminationGraceMs: 20
    });
    const runPromise = service.runTask({
      backend: "hermes",
      prompt: "maintain",
      sources: [{
        relativePath: SOURCE_PATH,
        absolutePath: sourcePath,
        size: Buffer.byteLength(sourceContent),
        mtime: Date.now(),
        fingerprint: "unused",
        mime: "text/markdown",
        modality: "text",
        changed: true
      }],
      permission: "workspace-write",
      codexWriteScope: "knowledge-base",
      managedKind: "maintain",
      workflowRunId: "service-probe-cancel",
      attemptId: "service-probe-cancel-attempt-1-hermes",
      attemptOrdinal: 1,
      vaultPathOverride: shadowVaultPath,
      writableRootsOverride: exactRoots,
      exactWriteFence: {
        attemptToken: "service-probe-cancel-attempt-1-hermes",
        leaseToken: "service-probe-cancel-lease",
        deniedLivePaths: [liveVaultPath],
        deniedControlPaths: [controlRootPath]
      }
    });
    const runRejected = assert.rejects(
      runPromise,
      (error: unknown) =>
        error instanceof KnowledgeAgentAttemptError
        && error.phase === "preflight"
        && error.submittedAt === undefined
        && error.nativeTerminationReceipt === undefined
        && /已取消/.test(error.message)
    );
    await probeEntered;
    cancelRequested = true;
    await service.cancelActiveTasks();
    await runRejected;
    assert.equal(versionAborts, 1, "service cancel must abort the active capability probe");
    assert.equal(chatCalls, 0, "cancel during probe must not submit a Hermes prompt");
    assert.equal(
      terminalSettlements,
      0,
      "cancel request must not publish a terminal state before the Service run settles"
    );
    await assert.rejects(
      () => lstat(path.join(shadowVaultPath, "wiki", "canceled.md")),
      (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT"
    );

    cancelRequested = false;
    let authorityChatCalls = 0;
    let releaseAuthorityEntered!: () => void;
    const authorityEntered = new Promise<void>((resolve) => {
      releaseAuthorityEntered = resolve;
    });
    const authorityService = new KnowledgeBaseAgentTaskService({
      settings,
      getVaultPath: () => liveVaultPath,
      getNativeExecutionRefContext: () => ({})
    } as any, {
      isCancelRequested: () => cancelRequested
    }, {
      hermesProposalCommand: FAKE_DISCOVERY_COMMAND,
      hermesProposalProcessRunner: fakeHermesRunner({
        onCall: (_command, args) => {
          if (args[0] === "chat") authorityChatCalls += 1;
        }
      }),
      hermesProposalProjectResolver: identityDependencies.projectResolver,
      hermesProposalLaunchInspector: identityDependencies.launchInspector,
      hermesProposalIsolationRootPath: path.join(rootPath, "isolation"),
      hermesProposalCredentialEnvironment: {
        OPENROUTER_API_KEY: "secret"
      },
      hermesProposalCredentialFiles: [],
      hermesProposalProbeCommandTimeoutMs: 5_000,
      hermesProposalTerminationGraceMs: 20
    });
    const authorityAttemptId = "service-authority-cancel-attempt-1-hermes";
    const authorityRunPromise = authorityService.runTask({
      backend: "hermes",
      prompt: "maintain",
      sources: [{
        relativePath: SOURCE_PATH,
        absolutePath: sourcePath,
        size: Buffer.byteLength(sourceContent),
        mtime: Date.now(),
        fingerprint: "unused",
        mime: "text/markdown",
        modality: "text",
        changed: true
      }],
      permission: "workspace-write",
      codexWriteScope: "knowledge-base",
      managedKind: "maintain",
      workflowRunId: "service-authority-cancel",
      attemptId: authorityAttemptId,
      attemptOrdinal: 1,
      vaultPathOverride: shadowVaultPath,
      writableRootsOverride: exactRoots,
      exactWriteFence: {
        attemptToken: authorityAttemptId,
        leaseToken: "service-authority-cancel-lease",
        deniedLivePaths: [liveVaultPath],
        deniedControlPaths: [controlRootPath]
      },
      onExactWriteFenceConfigured: async () => {
        releaseAuthorityEntered();
        await new Promise<void>(() => undefined);
      }
    });
    const authorityRejected = assert.rejects(
      authorityRunPromise,
      (error: unknown) =>
        error instanceof KnowledgeAgentAttemptError
        && error.phase === "preflight"
        && error.submittedAt === undefined
        && error.nativeTerminationReceipt === undefined
        && /已取消/.test(error.message)
    );
    await authorityEntered;
    cancelRequested = true;
    const cancelStartedAt = Date.now();
    await authorityService.cancelActiveTasks();
    await authorityRejected;
    assert.ok(
      Date.now() - cancelStartedAt < 250,
      "cancel must bound an authority callback that never settles"
    );
    assert.equal(
      authorityChatCalls,
      0,
      "cancel during authority configuration must not submit a Hermes prompt"
    );
  } finally {
    await rm(rootPath, { recursive: true, force: true });
  }
}

async function testServiceTimeoutRejectsLateProposalBeforeMaterialization(): Promise<void> {
  const rootPath = await createRoot("service-timeout");
  try {
    const liveVaultPath = path.join(rootPath, "live");
    const controlRootPath = path.join(rootPath, "control");
    const shadowVaultPath = path.join(rootPath, "shadow");
    const sourcePath = path.join(shadowVaultPath, "raw", "source.md");
    const sourceContent = "late source";
    const attemptId = "service-timeout-attempt-1-hermes";
    const latePath = "wiki/late-service.md";
    await Promise.all([
      mkdir(liveVaultPath, { recursive: true }),
      mkdir(controlRootPath, { recursive: true }),
      mkdir(path.dirname(sourcePath), { recursive: true }),
      mkdir(path.join(shadowVaultPath, "wiki"), { recursive: true }),
      mkdir(path.join(shadowVaultPath, "projects"), { recursive: true }),
      mkdir(path.join(shadowVaultPath, "outputs", "maintenance"), { recursive: true }),
      mkdir(path.join(shadowVaultPath, "inbox"), { recursive: true }),
      mkdir(path.join(rootPath, "isolation"), { recursive: true })
    ]);
    await writeFile(sourcePath, sourceContent, "utf8");
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.agents.hermes.providerId = "openrouter";
    settings.agents.hermes.modelId = "model";
    const identityDependencies = fakeIdentityDependencies();
    const service = new KnowledgeBaseAgentTaskService({
      settings,
      getVaultPath: () => liveVaultPath,
      getNativeExecutionRefContext: () => ({})
    } as any, {
      isCancelRequested: () => false
    }, {
      hermesProposalCommand: FAKE_DISCOVERY_COMMAND,
      hermesProposalProcessRunner: fakeHermesRunner({
        chatStdout: proposalJson(attemptId, [{
          op: "upsert",
          path: latePath,
          content: "late",
          sources: [{ path: SOURCE_PATH, sha256: fingerprint(sourceContent) }],
          baseSha256: null
        }]),
        chatDelayMs: 30,
        chatIgnoresAbort: true
      }),
      hermesProposalProjectResolver: identityDependencies.projectResolver,
      hermesProposalLaunchInspector: identityDependencies.launchInspector,
      hermesProposalIsolationRootPath: path.join(rootPath, "isolation"),
      hermesProposalCredentialEnvironment: {
        OPENROUTER_API_KEY: "secret"
      },
      hermesProposalCredentialFiles: [],
      hermesProposalTerminationGraceMs: 100,
      hermesProposalTrustInjectedRunnerTerminationForTests: true
    });
    const exactRoots = [
      path.join(shadowVaultPath, "wiki"),
      path.join(shadowVaultPath, "projects"),
      path.join(shadowVaultPath, "outputs", "maintenance"),
      path.join(shadowVaultPath, "inbox")
    ];
    await assert.rejects(
      () => service.runTask({
        backend: "hermes",
        prompt: "maintain",
        sources: [{
          relativePath: SOURCE_PATH,
          absolutePath: sourcePath,
          size: Buffer.byteLength(sourceContent),
          mtime: Date.now(),
          fingerprint: "unused",
          mime: "text/markdown",
          modality: "text",
          changed: true
        }],
        permission: "workspace-write",
        codexWriteScope: "knowledge-base",
        managedKind: "maintain",
        workflowRunId: "service-timeout",
        attemptId,
        attemptOrdinal: 1,
        vaultPathOverride: shadowVaultPath,
        writableRootsOverride: exactRoots,
        turnOptionOverrides: { hermesTaskTimeoutMs: 5 },
        exactWriteFence: {
          attemptToken: attemptId,
          leaseToken: "service-timeout-lease",
          deniedLivePaths: [liveVaultPath],
          deniedControlPaths: [controlRootPath]
        },
        onExactWriteFenceConfigured: (receipt) => {
          assert.equal(isTrustedExactWriteFenceReceipt(receipt), true);
        }
      }),
      (error: unknown) => {
        if (
          !(error instanceof KnowledgeAgentAttemptError)
          || error.phase !== "execution"
          || error.code !== "timeout"
          || typeof error.submittedAt !== "number"
          || typeof error.terminationConfirmedAt !== "number"
          || !isTrustedKnowledgeAgentNativeTerminationReceipt(error.nativeTerminationReceipt)
        ) {
          return false;
        }
        assert.equal(error.nativeTerminationReceipt.backend, "hermes");
        assert.equal(error.nativeTerminationReceipt.harnessRunId, error.harnessRunId);
        assert.equal(error.nativeTerminationReceipt.nativeExecutionId, error.nativeExecutionId);
        assert.match(error.nativeExecutionId, /^hermes-proposal:knowledge-hermes-/);
        assert.equal(error.nativeTerminationReceipt.kind, "abort-ack");
        assert.equal(
          error.nativeTerminationReceipt.confirmedAt,
          error.terminationConfirmedAt
        );
        return true;
      }
    );
    await delay(40, undefined, true);
    await assert.rejects(
      () => lstat(path.join(shadowVaultPath, latePath)),
      (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT"
    );
    await assert.rejects(
      () => lstat(path.join(liveVaultPath, latePath)),
      (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT"
    );

    const neverAttemptId = "service-never-settles-attempt-1-hermes";
    const neverPath = "wiki/never-service.md";
    const neverService = new KnowledgeBaseAgentTaskService({
      settings,
      getVaultPath: () => liveVaultPath,
      getNativeExecutionRefContext: () => ({})
    } as any, {
      isCancelRequested: () => false
    }, {
      hermesProposalCommand: FAKE_DISCOVERY_COMMAND,
      hermesProposalProcessRunner: fakeHermesRunner({
        chatNeverSettles: true
      }),
      hermesProposalProjectResolver: identityDependencies.projectResolver,
      hermesProposalLaunchInspector: identityDependencies.launchInspector,
      hermesProposalIsolationRootPath: path.join(rootPath, "isolation"),
      hermesProposalCredentialEnvironment: {
        OPENROUTER_API_KEY: "secret"
      },
      hermesProposalCredentialFiles: [],
      hermesProposalTerminationGraceMs: 20
    });
    const neverStartedAt = Date.now();
    await assert.rejects(
      () => neverService.runTask({
        backend: "hermes",
        prompt: "maintain",
        sources: [{
          relativePath: SOURCE_PATH,
          absolutePath: sourcePath,
          size: Buffer.byteLength(sourceContent),
          mtime: Date.now(),
          fingerprint: "unused",
          mime: "text/markdown",
          modality: "text",
          changed: true
        }],
        permission: "workspace-write",
        codexWriteScope: "knowledge-base",
        managedKind: "maintain",
        workflowRunId: "service-never-settles",
        attemptId: neverAttemptId,
        attemptOrdinal: 1,
        vaultPathOverride: shadowVaultPath,
        writableRootsOverride: exactRoots,
        turnOptionOverrides: { hermesTaskTimeoutMs: 5 },
        exactWriteFence: {
          attemptToken: neverAttemptId,
          leaseToken: "service-never-settles-lease",
          deniedLivePaths: [liveVaultPath],
          deniedControlPaths: [controlRootPath]
        },
        onExactWriteFenceConfigured: (receipt) => {
          assert.equal(isTrustedExactWriteFenceReceipt(receipt), true);
        }
      }),
      (error: unknown) =>
        error instanceof KnowledgeAgentAttemptError
        && error.phase === "execution"
        && error.code === "timeout"
        && typeof error.submittedAt === "number"
        && error.terminationConfirmedAt === undefined
        && error.nativeTerminationReceipt === undefined
    );
    assert.ok(
      Date.now() - neverStartedAt < 250,
      "a never-settling Hermes runner must return after the bounded termination grace"
    );
    await assert.rejects(
      () => lstat(path.join(shadowVaultPath, neverPath)),
      (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT"
    );
    await assert.rejects(
      () => lstat(path.join(liveVaultPath, neverPath)),
      (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT"
    );
  } finally {
    await rm(rootPath, { recursive: true, force: true });
  }
}

async function createInvocationFixture(
  parentRootPath: string,
  name: string,
  operations: readonly Record<string, unknown>[],
  targetFingerprints: Readonly<Record<string, string | null>>,
  existingShadowVaultPath?: string
): Promise<InvocationFixture> {
  const attemptId = `attempt-${name}`;
  const rootPath = path.join(parentRootPath, `fixture-${name}`);
  await mkdir(rootPath, { recursive: true });
  const shadowVaultPath = existingShadowVaultPath ?? await prepareShadow(rootPath);
  const liveVaultPath = path.join(rootPath, "live");
  const controlRootPath = path.join(rootPath, "control");
  await Promise.all([
    mkdir(liveVaultPath, { recursive: true }),
    mkdir(controlRootPath, { recursive: true })
  ]);
  const runner = fakeHermesRunner({
    chatStdout: proposalJson(attemptId, operations)
  });
  const capabilityResult = await probeHermesVaultNoWriteCapability({
    ...fakeIdentityDependencies(),
    attemptId,
    command: FAKE_DISCOVERY_COMMAND,
    providerId: "openrouter",
    modelId: "model",
    isolationRootPath: path.join(rootPath, "isolation"),
    credentialEnvironment: { OPENROUTER_API_KEY: "secret" },
    processRunner: runner
  });
  if (!capabilityResult.ready) {
    assert.fail(`Hermes fixture preflight failed: ${capabilityResult.reason}`);
  }
  const validation: HermesProposalValidationContext = {
    attemptId,
    sourceFingerprints: { [SOURCE_PATH]: SOURCE_HASH },
    targetFingerprints
  };
  const lease = boundLease({ attemptId, validation });
  const invocation = await runHermesProposalInvocation({
    capability: capabilityResult.capability,
    lease,
    prompt: INVOCATION_PROMPT,
    systemPrompt: INVOCATION_SYSTEM_PROMPT,
    validation,
    deniedLivePaths: [liveVaultPath],
    deniedControlPaths: [controlRootPath],
    hostMaterializerRoots: writableRoots(shadowVaultPath),
    timeoutMs: 1_000
  });
  return {
    rootPath,
    shadowVaultPath,
    liveVaultPath,
    controlRootPath,
    capability: capabilityResult.capability,
    lease,
    invocation
  };
}

async function assertUnsafeMaterialization(
  fixture: InvocationFixture,
  expectedCode: string
): Promise<void> {
  await assert.rejects(
    () => materializeHermesMaintenanceProposal({
      shadowVaultPath: fixture.shadowVaultPath,
      proposal: fixture.invocation.proposal,
      authorityReceipt: fixture.invocation.authorityReceipt,
      lease: fixture.lease
    }),
    (error: unknown) =>
      error instanceof HermesProposalMaterializationError
      && error.code === expectedCode
      && error.revocationReceipt?.noAcceptedProposal === true
  );
}

async function prepareShadow(rootPath: string): Promise<string> {
  await mkdir(rootPath, { recursive: true });
  const canonicalRoot = await realpath(rootPath);
  const shadowVaultPath = path.join(canonicalRoot, "vault");
  await mkdir(shadowVaultPath, { recursive: true });
  await Promise.all(writableRoots(shadowVaultPath).map((root) => mkdir(root, { recursive: true })));
  return shadowVaultPath;
}

function writableRoots(shadowVaultPath: string): string[] {
  return [
    path.join(shadowVaultPath, "wiki"),
    path.join(shadowVaultPath, "projects"),
    path.join(shadowVaultPath, "outputs", "maintenance"),
    path.join(shadowVaultPath, "inbox")
  ];
}

async function createRoot(label: string): Promise<string> {
  const created = await mkdtemp(path.join(tmpdir(), `echoink-hermes-${label}-`));
  return await realpath(created);
}

async function prepareInvocationPaths(rootPath: string, name: string): Promise<{
  shadowVaultPath: string;
  liveVaultPath: string;
  controlRootPath: string;
}> {
  const authorityRoot = path.join(rootPath, `authority-${name}`);
  const [shadowVaultPath] = await Promise.all([
    prepareShadow(path.join(authorityRoot, "shadow")),
    mkdir(path.join(authorityRoot, "live"), { recursive: true }),
    mkdir(path.join(authorityRoot, "control"), { recursive: true })
  ]);
  return {
    shadowVaultPath,
    liveVaultPath: path.join(authorityRoot, "live"),
    controlRootPath: path.join(authorityRoot, "control")
  };
}

function boundLease(input: {
  attemptId: string;
  validation: HermesProposalValidationContext;
  prompt?: string;
  systemPrompt?: string;
}) {
  return createHermesProposalLease({
    attemptId: input.attemptId,
    inputDigest: hermesProposalInvocationInputDigest({
      prompt: input.prompt ?? INVOCATION_PROMPT,
      systemPrompt: input.systemPrompt ?? INVOCATION_SYSTEM_PROMPT,
      validation: input.validation
    })
  });
}

function fakeIdentityDependencies(
  options: FakeHermesOptions = {}
): {
  projectResolver: HermesProposalProjectResolver;
  launchInspector: HermesProposalLaunchInspector;
} {
  return {
    projectResolver: options.projectResolver ?? (async () => FAKE_PROJECT_PATH),
    launchInspector: options.launchInspector ?? (async (projectPath) =>
      fakeLaunchIdentity({
        command: path.join(projectPath, "venv", "bin", "hermes"),
        pythonPath: path.join(projectPath, "venv", "bin", "python3"),
        pythonRealPath: "/opt/python/bin/python3"
      })
    )
  };
}

function fakeLaunchIdentity(
  overrides: Partial<Omit<HermesProposalLaunchIdentity, "digest">> = {}
): HermesProposalLaunchIdentity {
  const identity = {
    command: path.join(FAKE_PROJECT_PATH, "venv", "bin", "hermes"),
    commandDigest: fingerprint("audited-entrypoint"),
    pythonPath: path.join(FAKE_PROJECT_PATH, "venv", "bin", "python3"),
    pythonRealPath: "/opt/python/bin/python3",
    pythonDigest: fingerprint("audited-python"),
    profileId: "test-hermes-launch-profile",
    ...overrides
  };
  return Object.freeze({
    ...identity,
    digest: fingerprint(stableJsonForTest(identity))
  });
}

async function probeWith(
  rootPath: string,
  name: string,
  options: FakeHermesOptions
) {
  return await probeHermesVaultNoWriteCapability({
    ...fakeIdentityDependencies(options),
    attemptId: `attempt-${name}`,
    command: FAKE_DISCOVERY_COMMAND,
    providerId: "openrouter",
    modelId: "model",
    isolationRootPath: path.join(rootPath, `probe-${name}`),
    credentialEnvironment: { OPENROUTER_API_KEY: "secret" },
    processRunner: fakeHermesRunner(options)
  });
}

function fakeHermesRunner(options: FakeHermesOptions = {}): HermesProposalProcessRunner {
  const probe: FakeProbe = {
    plugins: 0,
    mcp: {},
    hooks: [],
    registryTools: [],
    contextTools: [],
    contextEngine: "compressor",
    provider: {
      id: "openrouter",
      transport: "openai_chat",
      authType: "api_key",
      baseUrl: "https://openrouter.ai/api/v1",
      baseUrlEnvVar: "OPENROUTER_BASE_URL",
      apiKeyEnvVars: ["OPENROUTER_API_KEY"]
    },
    ...(options.probe ?? {})
  };
  return async (command, args, processOptions) => {
    options.onCall?.(command, args, processOptions);
    if (args[0] === "--version") {
      return {
        stdout: [
          `Hermes Agent v${options.version ?? "0.18.0"}`,
          `upstream ${options.upstreamCommit ?? "4281151a"}`,
          `local ${options.localCommit ?? "1c473bc6"}`,
          `Project: ${options.directProjectPath ?? FAKE_PROJECT_PATH}`
        ].join("\n"),
        stderr: ""
      };
    }
    if (command === "/usr/bin/git" && args.includes("rev-parse")) {
      return { stdout: `${options.head ?? FULL_LOCAL_COMMIT}\n`, stderr: "" };
    }
    if (command === "/usr/bin/git" && args.includes("status")) {
      return { stdout: options.status ?? "?? .install_method\n", stderr: "" };
    }
    if (args[0] === "-I") {
      return { stdout: `${JSON.stringify(probe)}\n`, stderr: "" };
    }
    if (args[0] === "chat") {
      assert.equal(args[1], "-q");
      assert.equal(args[3], "--quiet");
      assert.deepEqual(args.slice(4), [
        "--safe-mode",
        "--toolsets",
        "context_engine",
        "--max-turns",
        "1",
        "--source",
        "tool",
        "--cli",
        "--provider",
        "openrouter",
        "--model",
        "model"
      ]);
      assert.equal(processOptions.env.HERMES_KANBAN_TASK, undefined);
      assert.equal(processOptions.env.HERMES_SAFE_MODE, "1");
      assert.equal(processOptions.env.HERMES_IGNORE_USER_CONFIG, "1");
      assert.equal(processOptions.env.HERMES_ACCEPT_HOOKS, "0");
      assert.equal(typeof processOptions.env.HERMES_EPHEMERAL_SYSTEM_PROMPT, "string");
      assert.ok(processOptions.env.HERMES_EPHEMERAL_SYSTEM_PROMPT);
      if (options.chatNeverSettles) {
        return await new Promise<{ stdout: string; stderr: string }>(() => undefined);
      }
      if (options.chatDelayMs) {
        await delay(options.chatDelayMs, processOptions.signal, options.chatIgnoresAbort ?? false);
      }
      return {
        stdout: options.chatStdout ?? proposalJson("unused", []),
        stderr: ""
      };
    }
    throw new Error(`unexpected fake process: ${command} ${args.join(" ")}`);
  };
}

async function delay(
  milliseconds: number,
  signal: AbortSignal | undefined,
  ignoreAbort: boolean
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(resolve, milliseconds);
    if (!signal || ignoreAbort) return;
    const onAbort = () => {
      clearTimeout(timeout);
      reject(new Error("aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function baseValidation(attemptId: string): HermesProposalValidationContext {
  return {
    attemptId,
    sourceFingerprints: { [SOURCE_PATH]: SOURCE_HASH },
    targetFingerprints: {}
  };
}

function operation(relativePath: string): Record<string, unknown> {
  return {
    op: "upsert",
    path: relativePath,
    content: `content:${relativePath}`,
    sources: [{ path: SOURCE_PATH, sha256: SOURCE_HASH }],
    baseSha256: null
  };
}

function proposalJson(attemptId: string, operations: readonly Record<string, unknown>[]): string {
  return JSON.stringify({ version: 1, attemptId, operations });
}

function fingerprint(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function stableJsonForTest(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJsonForTest).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) =>
      `${JSON.stringify(key)}:${stableJsonForTest(object[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function runtimeReceipt(error: unknown) {
  return typeof error === "object" && error !== null && "revocationReceipt" in error
    ? (error as { revocationReceipt?: ReturnType<typeof createHermesProposalLease> }).revocationReceipt as any
    : undefined;
}
