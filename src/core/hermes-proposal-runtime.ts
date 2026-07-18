import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import {
  createHermesProposalValidationSnapshot,
  HERMES_MAINTENANCE_PROPOSAL_SCHEMA_DIGEST,
  isTrustedValidatedHermesMaintenanceProposal,
  parseAndValidateHermesMaintenanceProposal,
  type HermesProposalValidationContext,
  type HermesProposalValidationSnapshot,
  type ValidatedHermesMaintenanceProposal
} from "../harness/maintenance/hermes-proposal-contract";

const SUPPORTED_HERMES_VERSION = "0.18.0";
const SUPPORTED_HERMES_UPSTREAM = "4281151a";
const SUPPORTED_HERMES_LOCAL_COMMIT = "1c473bc6";
const SUPPORTED_HERMES_LOCAL_COMMIT_FULL = "1c473bc6a6a0f62e4c264fa0c59ce58606100301";
const HERMES_PROPOSAL_TOOLSET = "context_engine";
const MAX_PROBE_OUTPUT_BYTES = 1024 * 1024;
const MAX_AUTH_FILE_BYTES = 8 * 1024 * 1024;
const MAX_LAUNCHER_FILE_BYTES = 64 * 1024;
const MAX_PINNED_PYTHON_BYTES = 64 * 1024 * 1024;
const DEFAULT_HERMES_PROBE_COMMAND_TIMEOUT_MS = 15_000;
const DEFAULT_HERMES_TERMINATION_GRACE_MS = 5_000;
const ALLOWED_AUTH_FILE_NAMES = new Set(["auth.json", ".anthropic_oauth.json"]);
const SAFE_ENV_EXACT = new Set([
  "ALL_PROXY",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "REQUESTS_CA_BUNDLE",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE"
]);
const DENIED_ENV_PREFIXES = [
  "BASH_",
  "DYLD_",
  "HERMES_",
  "LD_",
  "NODE_",
  "PYTHON",
  "TERMINAL_"
] as const;
const AUDITED_PROVIDER_PROFILES = Object.freeze({
  deepseek: Object.freeze({
    id: "deepseek",
    transport: "openai_chat",
    authType: "api_key",
    baseUrlEnvironmentKey: "DEEPSEEK_BASE_URL",
    defaultBaseUrl: "https://api.deepseek.com/v1",
    credentialEnvironmentKeys: Object.freeze(["DEEPSEEK_API_KEY"])
  }),
  openrouter: Object.freeze({
    id: "openrouter",
    transport: "openai_chat",
    authType: "api_key",
    baseUrlEnvironmentKey: "OPENROUTER_BASE_URL",
    defaultBaseUrl: "https://openrouter.ai/api/v1",
    credentialEnvironmentKeys: Object.freeze(["OPENROUTER_API_KEY"])
  })
} as const);
const AUDITED_LAUNCH_PROFILES = Object.freeze({
  "darwin-arm64": Object.freeze({
    profileId: "hermes-0.18.0-darwin-arm64-python-3.11.15",
    normalizedEntrypointSha256: "sha256:445ddc27f83f5ca997d75f0a5ac8aeb3ab162dca791c0cceb4634888880aa127",
    pythonSha256: "sha256:612bb6e55a95ea6eaf3c9693cf17fbf1a738408ad3bbfce988f712d7321d2c42"
  })
} as const);

type AuditedProviderProfile =
  (typeof AUDITED_PROVIDER_PROFILES)[keyof typeof AUDITED_PROVIDER_PROFILES];

export interface HermesProposalLaunchIdentity {
  command: string;
  commandDigest: string;
  pythonPath: string;
  pythonRealPath: string;
  pythonDigest: string;
  profileId: string;
  digest: string;
}

export interface HermesProposalOperationControl {
  signal: AbortSignal;
  timeoutMs: number;
}

export type HermesProposalLaunchInspector = (
  projectPath: string,
  control?: HermesProposalOperationControl
) => Promise<HermesProposalLaunchIdentity>;

export type HermesProposalProjectResolver = (
  discoveryCommand: string,
  control?: HermesProposalOperationControl
) => Promise<string>;

export interface HermesProposalProcessOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  maxBuffer: number;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export type HermesProposalProcessRunner = (
  command: string,
  args: readonly string[],
  options: HermesProposalProcessOptions
) => Promise<{ stdout: string; stderr: string }>;

export interface HermesProposalCredentialFile {
  sourcePath: string;
  destinationName: "auth.json" | ".anthropic_oauth.json";
}

export interface ProbeHermesVaultNoWriteCapabilityInput {
  attemptId: string;
  command: string;
  providerId: string;
  modelId: string;
  inputModalities?: readonly string[];
  isolationRootPath: string;
  credentialEnvironment?: Readonly<Record<string, string>>;
  credentialFiles?: readonly HermesProposalCredentialFile[];
  processRunner?: HermesProposalProcessRunner;
  /**
   * Test-only dependency injection. Production callers must omit this so the
   * discovery wrapper, pinned entrypoint and interpreter are inspected from
   * disk without executing the wrapper.
   */
  projectResolver?: HermesProposalProjectResolver;
  launchInspector?: HermesProposalLaunchInspector;
  abortSignal?: AbortSignal;
  probeCommandTimeoutMs?: number;
}

export interface HermesVaultNoWriteCapability {
  readonly version: 1;
  readonly authority: "vault-no-write-host-output-only";
  readonly scope: "vault-only";
  readonly osSandbox: false;
  readonly attemptId: string;
  readonly command: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly hermesVersion: string;
  readonly upstreamCommit: string;
  readonly localCommit: string;
  readonly projectPath: string;
  readonly discoveryCommand: string;
  readonly launchProfileId: string;
  readonly launchIdentityDigest: string;
  readonly pythonPath: string;
  readonly pythonRealPath: string;
  readonly isolatedHomePath: string;
  readonly neutralCwd: string;
  readonly environmentKeys: readonly string[];
  readonly environmentDigest: string;
  readonly probeDigest: string;
  readonly probedAt: string;
}

export type HermesVaultNoWriteCapabilityResult =
  | { ready: true; capability: HermesVaultNoWriteCapability }
  | {
    ready: false;
    code:
      | "unsupported_identity"
      | "dirty_installation"
      | "invalid_isolation"
      | "unsafe_environment"
      | "unsafe_provider"
      | "unsupported_modality"
      | "capability_probe_failed"
      | "capability_probe_nonempty";
    reason: string;
  };

export interface HermesProposalLease {
  readonly version: 1;
  readonly attemptId: string;
  readonly leaseId: string;
  readonly inputDigest: string;
  readonly createdAt: string;
}

export interface HermesProposalLeaseRevocationReceipt {
  readonly version: 1;
  readonly attemptId: string;
  readonly leaseId: string;
  readonly inputDigest: string;
  readonly noAcceptedProposal: boolean;
  readonly acceptedProposalDigest?: string;
  readonly reason: string;
  readonly revokedAt: string;
}

export interface HermesVaultNoWriteAuthorityReceipt {
  readonly version: 1;
  readonly authority: "vault-no-write-host-output-only";
  readonly scope: "vault-only";
  readonly osSandbox: false;
  readonly backend: "hermes";
  readonly attemptId: string;
  readonly leaseId: string;
  readonly deniedLivePaths: readonly string[];
  readonly deniedControlPaths: readonly string[];
  readonly hostMaterializerRoots: readonly string[];
  readonly hermesVersion: string;
  readonly upstreamCommit: string;
  readonly localCommit: string;
  readonly command: string;
  readonly argvWithoutPrompt: readonly string[];
  readonly argvDigest: string;
  readonly environmentKeys: readonly string[];
  readonly environmentDigest: string;
  readonly cwd: string;
  readonly outputSchemaDigest: string;
  readonly capabilityProbeDigest: string;
  readonly promptDigest: string;
  readonly inputDigest: string;
  readonly configuredAt: string;
}

export interface RunHermesProposalInvocationInput {
  capability: HermesVaultNoWriteCapability;
  lease: HermesProposalLease;
  prompt: string;
  systemPrompt: string;
  validation: HermesProposalValidationContext;
  deniedLivePaths: readonly string[];
  deniedControlPaths: readonly string[];
  hostMaterializerRoots: readonly string[];
  timeoutMs: number;
  terminationGraceMs?: number;
  abortSignal?: AbortSignal;
  onAuthorityConfigured?: (
    receipt: HermesVaultNoWriteAuthorityReceipt,
    control?: HermesProposalOperationControl
  ) => void | Promise<void>;
  /**
   * Fires only after the audited process runner has accepted the invocation
   * and immediately before its returned process promise is awaited.
   */
  onSubmitted?: () => void;
}

export interface HermesProposalInvocationDigestInput {
  prompt: string;
  systemPrompt: string;
  validation: HermesProposalValidationContext;
}

export interface HermesProposalInvocationResult {
  proposal: ValidatedHermesMaintenanceProposal;
  authorityReceipt: HermesVaultNoWriteAuthorityReceipt;
  stderr: string;
}

export type HermesProposalRuntimeErrorCode =
  | "capability_untrusted"
  | "lease_untrusted"
  | "lease_revoked"
  | "authority_rejected"
  | "process_failed"
  | "timeout"
  | "canceled"
  | "late_output_rejected"
  | "invalid_stdout"
  | "invalid_proposal";

export class HermesProposalRuntimeError extends Error {
  constructor(
    public readonly code: HermesProposalRuntimeErrorCode,
    message: string,
    public readonly revocationReceipt?: HermesProposalLeaseRevocationReceipt,
    options?: ErrorOptions,
    public readonly terminationConfirmedAt?: number
  ) {
    super(message, options);
    this.name = "HermesProposalRuntimeError";
  }
}

interface CapabilitySecrets {
  env: Readonly<NodeJS.ProcessEnv>;
  runner: HermesProposalProcessRunner;
  projectResolver: HermesProposalProjectResolver;
  launchInspector: HermesProposalLaunchInspector;
  launchIdentity: HermesProposalLaunchIdentity;
  commandTimeoutMs: number;
}

interface LeaseState {
  active: boolean;
  acceptedProposalDigest?: string;
  revocationReceipt?: HermesProposalLeaseRevocationReceipt;
}

const trustedCapabilities = new WeakSet<object>();
const capabilitySecrets = new WeakMap<object, CapabilitySecrets>();
const trustedLeases = new WeakSet<object>();
const leaseStates = new WeakMap<object, LeaseState>();
const trustedAuthorityReceipts = new WeakSet<object>();
const trustedRevocationReceipts = new WeakSet<object>();
const proposalInvocationBindings = new WeakMap<
object,
{ lease: HermesProposalLease; authorityReceipt: HermesVaultNoWriteAuthorityReceipt }
>();
const leaseInvocationBindings = new WeakMap<
object,
{
  authorityReceipt: HermesVaultNoWriteAuthorityReceipt;
  proposal?: ValidatedHermesMaintenanceProposal;
}
>();
const authorityInvocationBindings = new WeakMap<
object,
{
  lease: HermesProposalLease;
  proposal?: ValidatedHermesMaintenanceProposal;
}
>();

export async function probeHermesVaultNoWriteCapability(
  input: ProbeHermesVaultNoWriteCapabilityInput
): Promise<HermesVaultNoWriteCapabilityResult> {
  const commandTimeoutMs = normalizePositiveTimeout(
    input.probeCommandTimeoutMs,
    DEFAULT_HERMES_PROBE_COMMAND_TIMEOUT_MS
  );
  const attemptId = input.attemptId.trim();
  const command = input.command.trim();
  const providerId = input.providerId.trim();
  const modelId = input.modelId.trim();
  if (!attemptId || !command || !path.isAbsolute(command) || !providerId || !modelId) {
    return {
      ready: false,
      code: "invalid_isolation",
      reason: "Hermes proposal preflight 缺少 attempt、绝对 command、provider 或 model"
    };
  }
  if (input.abortSignal?.aborted) {
    return {
      ready: false,
      code: "capability_probe_failed",
      reason: "Hermes proposal preflight 已取消"
    };
  }
  const providerProfile = auditedProviderProfile(providerId);
  if (!providerProfile) {
    return {
      ready: false,
      code: "unsafe_provider",
      reason: `Hermes proposal v1 尚未审计 provider：${providerId}`
    };
  }
  const modalities = input.inputModalities ?? ["text"];
  if (modalities.length !== 1 || modalities[0] !== "text") {
    return {
      ready: false,
      code: "unsupported_modality",
      reason: "Hermes proposal transport v1 只支持纯文本输入"
    };
  }

  let isolationRootPath: string;
  try {
    isolationRootPath = await prepareIsolationRoot(input.isolationRootPath, attemptId);
  } catch (error) {
    return {
      ready: false,
      code: "invalid_isolation",
      reason: errorMessage(error)
    };
  }
  const isolatedHomePath = path.join(isolationRootPath, "home");
  const neutralCwd = path.join(isolationRootPath, "cwd");
  const tempPath = path.join(isolationRootPath, "tmp");
  const noManagedScopePath = path.join(isolationRootPath, "managed-scope-disabled");
  const fail = async (
    code: Extract<HermesVaultNoWriteCapabilityResult, { ready: false }>["code"],
    reason: string
  ): Promise<HermesVaultNoWriteCapabilityResult> => {
    const cleanupError = await fsp.rm(isolationRootPath, { recursive: true, force: true })
      .then(() => "")
      .catch((error) => errorMessage(error));
    return {
      ready: false,
      code,
      reason: cleanupError ? `${reason}；隔离目录清理失败：${cleanupError}` : reason
    };
  };
  try {
    await Promise.all([
      fsp.mkdir(isolatedHomePath, { recursive: true, mode: 0o700 }),
      fsp.mkdir(neutralCwd, { recursive: true, mode: 0o700 }),
      fsp.mkdir(tempPath, { recursive: true, mode: 0o700 }),
      fsp.mkdir(noManagedScopePath, { recursive: true, mode: 0o700 })
    ]);
  } catch (error) {
    return await fail("invalid_isolation", errorMessage(error));
  }

  try {
    await copyCredentialFiles(input.credentialFiles ?? [], isolatedHomePath);
  } catch (error) {
    return await fail("unsafe_environment", errorMessage(error));
  }
  if (input.abortSignal?.aborted) {
    return await fail("capability_probe_failed", "Hermes proposal preflight 已取消");
  }

  let env: NodeJS.ProcessEnv;
  try {
    env = buildHermesProposalEnvironment({
      isolatedHomePath,
      neutralCwd,
      tempPath,
      noManagedScopePath,
      providerProfile,
      credentialEnvironment: input.credentialEnvironment ?? {}
    });
  } catch (error) {
    return await fail("unsafe_environment", errorMessage(error));
  }
  const runner = input.processRunner ?? defaultProcessRunner;
  const projectResolver = input.projectResolver ?? resolvePinnedHermesProjectFromDiscoveryCommand;
  const launchInspector = input.launchInspector ?? inspectPinnedHermesLaunchIdentity;
  let projectPath: string;
  let launchIdentity: HermesProposalLaunchIdentity;
  let identity: HermesProposalIdentity;
  try {
    projectPath = await runHermesOperationWithDeadline({
      label: "Hermes project resolver",
      timeoutMs: commandTimeoutMs,
      externalSignal: input.abortSignal,
      operation: async (signal) => await projectResolver(command, {
        signal,
        timeoutMs: commandTimeoutMs
      })
    });
    if (input.abortSignal?.aborted) {
      return await fail("capability_probe_failed", "Hermes proposal preflight 已取消");
    }
    if (!path.isAbsolute(projectPath) || path.resolve(projectPath) !== projectPath) {
      throw new Error("Hermes discovery command 未解析到规范绝对 projectPath");
    }
    launchIdentity = await runHermesOperationWithDeadline({
      label: "Hermes launch inspector",
      timeoutMs: commandTimeoutMs,
      externalSignal: input.abortSignal,
      operation: async (signal) => await launchInspector(projectPath, {
        signal,
        timeoutMs: commandTimeoutMs
      })
    });
    if (input.abortSignal?.aborted) {
      return await fail("capability_probe_failed", "Hermes proposal preflight 已取消");
    }
    assertLaunchIdentityShape(launchIdentity);
    const directVersion = await runHermesProcessWithDeadline(
      runner,
      launchIdentity.command,
      ["--version"],
      {
      cwd: neutralCwd,
      env,
      maxBuffer: MAX_PROBE_OUTPUT_BYTES
      },
      commandTimeoutMs,
      input.abortSignal
    );
    identity = parseHermesProposalIdentity(
      `${directVersion.stdout}\n${directVersion.stderr}`
    );
    if (
      identity.version !== SUPPORTED_HERMES_VERSION
      || identity.upstreamCommit !== SUPPORTED_HERMES_UPSTREAM
      || identity.localCommit !== SUPPORTED_HERMES_LOCAL_COMMIT
      || !identity.projectPath
      || !path.isAbsolute(identity.projectPath)
      || path.resolve(identity.projectPath) !== projectPath
    ) {
      throw new Error(
        `Hermes identity 未经过 proposal transport 审计：v${identity.version || "?"} upstream=${identity.upstreamCommit || "?"} local=${identity.localCommit || "?"}`
      );
    }
  } catch (error) {
    return await fail(
      "unsupported_identity",
      `Hermes launcher/entrypoint/interpreter 未通过审计：${errorMessage(error)}`
    );
  }

  try {
    await assertPinnedHermesGitIdentity(
      runner,
      projectPath,
      neutralCwd,
      env,
      commandTimeoutMs,
      input.abortSignal
    );
  } catch (error) {
    return await fail(
      "dirty_installation",
      `无法验证 Hermes 安装源：${errorMessage(error)}`
    );
  }

  let probe: HermesCapabilityProbeOutput;
  try {
    const probeScript = buildCapabilityProbeScript(projectPath, providerId);
    const result = await runHermesProcessWithDeadline(
      runner,
      launchIdentity.pythonPath,
      ["-I", "-c", probeScript],
      {
        cwd: neutralCwd,
        env,
        maxBuffer: MAX_PROBE_OUTPUT_BYTES
      },
      commandTimeoutMs,
      input.abortSignal
    );
    probe = JSON.parse(extractSingleJsonObject(result.stdout)) as HermesCapabilityProbeOutput;
  } catch (error) {
    return await fail(
      "capability_probe_failed",
      `Hermes no-tool capability probe 失败：${errorMessage(error)}`
    );
  }
  if (
    probe.plugins !== 0
    || Object.keys(probe.mcp ?? {}).length !== 0
    || (probe.hooks?.length ?? 0) !== 0
    || (probe.registryTools?.length ?? 0) !== 0
    || (probe.contextTools?.length ?? 0) !== 0
    || probe.contextEngine !== "compressor"
  ) {
    return await fail(
      "capability_probe_nonempty",
      `Hermes proposal probe 发现可调用能力：${stableJson(probe)}`
    );
  }
  if (
    !probe.provider
    || !providerMatchesAuditedProfile(probe.provider, providerProfile, env)
  ) {
    return await fail(
      "unsafe_provider",
      `Hermes provider 不是受支持的纯 HTTP transport：${stableJson(probe.provider)}`
    );
  }

  const environmentKeys = Object.freeze(Object.keys(env).sort());
  const environmentDigest = digestEnvironment(env);
  const probeDigest = digestJson({
    identity,
    gitHead: SUPPORTED_HERMES_LOCAL_COMMIT_FULL,
    launchIdentityDigest: launchIdentity.digest,
    probe,
    environmentDigest,
    neutralCwd,
    isolatedHomePath
  });
  const capability: HermesVaultNoWriteCapability = Object.freeze({
    version: 1,
    authority: "vault-no-write-host-output-only",
    scope: "vault-only",
    osSandbox: false,
    attemptId,
    command: launchIdentity.command,
    providerId,
    modelId,
    hermesVersion: identity.version,
    upstreamCommit: identity.upstreamCommit,
    localCommit: identity.localCommit,
    projectPath,
    discoveryCommand: command,
    launchProfileId: launchIdentity.profileId,
    launchIdentityDigest: launchIdentity.digest,
    pythonPath: launchIdentity.pythonPath,
    pythonRealPath: launchIdentity.pythonRealPath,
    isolatedHomePath,
    neutralCwd,
    environmentKeys,
    environmentDigest,
    probeDigest,
    probedAt: new Date().toISOString()
  });
  trustedCapabilities.add(capability);
  capabilitySecrets.set(capability, {
    env: Object.freeze({ ...env }),
    runner,
    projectResolver,
    launchInspector,
    launchIdentity,
    commandTimeoutMs
  });
  return { ready: true, capability };
}

export function hermesProposalInvocationInputDigest(
  input: HermesProposalInvocationDigestInput
): string {
  if (typeof input.prompt !== "string" || typeof input.systemPrompt !== "string") {
    throw new HermesProposalRuntimeError(
      "lease_untrusted",
      "Hermes proposal prompt 与 systemPrompt 必须是 string"
    );
  }
  return invocationInputDigestFromSnapshot(
    input.prompt,
    input.systemPrompt,
    createHermesProposalValidationSnapshot(input.validation)
  );
}

export function createHermesProposalLease(input: {
  attemptId: string;
  inputDigest: string;
  leaseId?: string;
  createdAt?: string;
}): HermesProposalLease {
  const attemptId = input.attemptId.trim();
  const inputDigest = input.inputDigest.trim();
  const leaseId = input.leaseId?.trim() || randomUUID();
  const createdAt = input.createdAt ?? new Date().toISOString();
  if (
    !attemptId
    || !leaseId
    || !isDigest(inputDigest)
    || Number.isNaN(Date.parse(createdAt))
  ) {
    throw new HermesProposalRuntimeError("lease_untrusted", "Hermes proposal lease 参数非法");
  }
  const lease: HermesProposalLease = Object.freeze({
    version: 1,
    attemptId,
    leaseId,
    inputDigest,
    createdAt
  });
  trustedLeases.add(lease);
  leaseStates.set(lease, { active: true });
  return lease;
}

export function revokeHermesProposalLease(
  lease: HermesProposalLease,
  reason: string,
  revokedAt = new Date().toISOString()
): HermesProposalLeaseRevocationReceipt {
  const state = trustedLeaseState(lease);
  if (state.revocationReceipt) return state.revocationReceipt;
  if (Number.isNaN(Date.parse(revokedAt))) {
    throw new HermesProposalRuntimeError("lease_untrusted", "Hermes proposal revokedAt 非法");
  }
  state.active = false;
  const receipt: HermesProposalLeaseRevocationReceipt = Object.freeze({
    version: 1,
    attemptId: lease.attemptId,
    leaseId: lease.leaseId,
    inputDigest: lease.inputDigest,
    noAcceptedProposal: !state.acceptedProposalDigest,
    ...(state.acceptedProposalDigest
      ? { acceptedProposalDigest: state.acceptedProposalDigest }
      : {}),
    reason: reason.trim() || "revoked",
    revokedAt
  });
  state.revocationReceipt = receipt;
  trustedRevocationReceipts.add(receipt);
  return receipt;
}

export function acceptBoundHermesProposalMaterialization(input: {
  lease: HermesProposalLease;
  proposal: ValidatedHermesMaintenanceProposal;
  authorityReceipt: HermesVaultNoWriteAuthorityReceipt;
}): void {
  const state = trustedLeaseState(input.lease);
  if (!state.active) {
    throw new HermesProposalRuntimeError(
      "late_output_rejected",
      `Hermes proposal lease ${input.lease.leaseId} 已撤销，拒绝迟到 proposal`,
      state.revocationReceipt
    );
  }
  if (!isTrustedValidatedHermesMaintenanceProposal(input.proposal)) {
    throw new HermesProposalRuntimeError(
      "lease_untrusted",
      "拒绝普通对象、spread 或 JSON clone 伪造的 Hermes proposal"
    );
  }
  if (!isTrustedHermesVaultNoWriteAuthorityReceipt(input.authorityReceipt)) {
    throw new HermesProposalRuntimeError(
      "lease_untrusted",
      "拒绝普通对象、spread 或 JSON clone 伪造的 Hermes authority receipt"
    );
  }
  if (
    input.proposal.attemptId !== input.lease.attemptId
    || input.authorityReceipt.attemptId !== input.lease.attemptId
    || input.authorityReceipt.leaseId !== input.lease.leaseId
    || !isHermesProposalBoundToInvocation(
      input.proposal,
      input.lease,
      input.authorityReceipt
    )
  ) {
    throw new HermesProposalRuntimeError(
      "lease_untrusted",
      "proposal、lease 与 authority receipt 没有三方绑定"
    );
  }
  if (
    state.acceptedProposalDigest
    && state.acceptedProposalDigest !== input.proposal.digest
  ) {
    throw new HermesProposalRuntimeError("lease_untrusted", "同一 Hermes proposal lease 不允许接受多个不同 proposal");
  }
  state.acceptedProposalDigest = input.proposal.digest;
}

export function isHermesProposalLeaseActive(lease: HermesProposalLease): boolean {
  return Boolean(trustedLeases.has(lease) && leaseStates.get(lease)?.active);
}

export function isTrustedHermesProposalLeaseRevocationReceipt(
  value: unknown
): value is HermesProposalLeaseRevocationReceipt {
  if (!value || typeof value !== "object" || !trustedRevocationReceipts.has(value)) return false;
  const receipt = value as HermesProposalLeaseRevocationReceipt;
  return receipt.version === 1
    && Boolean(receipt.attemptId)
    && Boolean(receipt.leaseId)
    && isDigest(receipt.inputDigest)
    && !Number.isNaN(Date.parse(receipt.revokedAt))
    && Object.isFrozen(receipt);
}

export function isTrustedHermesVaultNoWriteAuthorityReceipt(
  value: unknown
): value is HermesVaultNoWriteAuthorityReceipt {
  if (!value || typeof value !== "object" || !trustedAuthorityReceipts.has(value)) return false;
  const receipt = value as HermesVaultNoWriteAuthorityReceipt;
  return receipt.version === 1
    && receipt.authority === "vault-no-write-host-output-only"
    && receipt.scope === "vault-only"
    && receipt.osSandbox === false
    && receipt.backend === "hermes"
    && receipt.outputSchemaDigest === HERMES_MAINTENANCE_PROPOSAL_SCHEMA_DIGEST
    && isDigest(receipt.capabilityProbeDigest)
    && isDigest(receipt.promptDigest)
    && isDigest(receipt.inputDigest)
    && Object.isFrozen(receipt);
}

export function isHermesProposalBoundToInvocation(
  proposal: ValidatedHermesMaintenanceProposal,
  lease: HermesProposalLease,
  authorityReceipt: HermesVaultNoWriteAuthorityReceipt
): boolean {
  const proposalBinding = proposalInvocationBindings.get(proposal);
  const leaseBinding = leaseInvocationBindings.get(lease);
  const authorityBinding = authorityInvocationBindings.get(authorityReceipt);
  return Boolean(
    proposalBinding
    && proposalBinding.lease === lease
    && proposalBinding.authorityReceipt === authorityReceipt
    && leaseBinding
    && leaseBinding.authorityReceipt === authorityReceipt
    && leaseBinding.proposal === proposal
    && authorityBinding
    && authorityBinding.lease === lease
    && authorityBinding.proposal === proposal
    && trustedLeases.has(lease)
    && trustedAuthorityReceipts.has(authorityReceipt)
  );
}

export async function runHermesProposalInvocation(
  input: RunHermesProposalInvocationInput
): Promise<HermesProposalInvocationResult> {
  const leaseState = trustedLeaseState(input.lease);
  if (!leaseState.active) {
    throw new HermesProposalRuntimeError(
      "lease_revoked",
      "Hermes proposal lease 已撤销",
      leaseState.revocationReceipt
    );
  }
  const reject = (
    code: HermesProposalRuntimeErrorCode,
    message: string,
    reason: string,
    cause?: unknown
  ): HermesProposalRuntimeError => {
    const receipt = revokeHermesProposalLease(input.lease, reason);
    return new HermesProposalRuntimeError(
      code,
      message,
      receipt,
      cause === undefined ? undefined : { cause }
    );
  };
  const capability = input.capability;
  if (!trustedCapabilities.has(capability)) {
    throw reject(
      "capability_untrusted",
      "拒绝未由本进程 preflight 签发的 Hermes capability",
      "capability_untrusted"
    );
  }
  const secrets = capabilitySecrets.get(capability);
  if (!secrets) {
    throw reject(
      "capability_untrusted",
      "Hermes capability 缺少受保护的 launch state",
      "capability_state_missing"
    );
  }
  let validationSnapshot: HermesProposalValidationSnapshot;
  let invocationInputDigest: string;
  try {
    validationSnapshot = createHermesProposalValidationSnapshot(input.validation);
    invocationInputDigest = invocationInputDigestFromSnapshot(
      input.prompt,
      input.systemPrompt,
      validationSnapshot
    );
  } catch (error) {
    throw reject(
      "lease_untrusted",
      `Hermes proposal validation snapshot 无效：${errorMessage(error)}`,
      "validation_snapshot_invalid",
      error
    );
  }
  if (
    capability.attemptId !== input.lease.attemptId
    || validationSnapshot.attemptId !== input.lease.attemptId
  ) {
    throw reject(
      "lease_untrusted",
      "capability、lease 和 validation attemptId 不一致",
      "attempt_mismatch"
    );
  }
  if (invocationInputDigest !== input.lease.inputDigest) {
    throw reject(
      "lease_untrusted",
      "Hermes proposal lease 未绑定当前 prompt、systemPrompt 与 validation snapshot",
      "input_digest_mismatch"
    );
  }
  if (leaseInvocationBindings.has(input.lease)) {
    throw reject(
      "lease_untrusted",
      "同一 Hermes proposal lease 不允许启动多个 invocation",
      "lease_already_bound"
    );
  }
  if (input.abortSignal?.aborted) {
    throw reject(
      "canceled",
      "Hermes proposal 在 prompt 提交前已取消",
      "canceled_before_submission"
    );
  }
  let deniedLivePaths: string[];
  let deniedControlPaths: string[];
  let hostMaterializerRoots: string[];
  try {
    const canonicalPaths = await runHermesOperationWithDeadline({
      label: "Hermes authority path validation",
      timeoutMs: secrets.commandTimeoutMs,
      externalSignal: input.abortSignal,
      operation: async (signal) => {
        const resolved = await Promise.all([
          canonicalExistingPaths(input.deniedLivePaths, "denied live"),
          canonicalExistingPaths(input.deniedControlPaths, "denied control"),
          canonicalExistingPaths(input.hostMaterializerRoots, "materializer")
        ]);
        throwIfAborted(signal, "Hermes authority path validation 已取消");
        return resolved;
      }
    });
    [deniedLivePaths, deniedControlPaths, hostMaterializerRoots] = canonicalPaths;
  } catch (error) {
    if (
      input.abortSignal?.aborted
      || (error instanceof HermesProposalProcessControlError && error.kind === "canceled")
    ) {
      throw reject(
        "canceled",
        "Hermes proposal 在 prompt 提交前已取消",
        "canceled_before_submission",
        error
      );
    }
    throw reject(
      "authority_rejected",
      `Vault-no-write authority 路径非法：${errorMessage(error)}`,
      "authority_paths_invalid",
      error
    );
  }
  if (!deniedLivePaths.length || !deniedControlPaths.length || !hostMaterializerRoots.length) {
    throw reject(
      "authority_rejected",
      "Vault-no-write authority 缺少拒写路径或 host materializer roots",
      "authority_paths_missing"
    );
  }
  if (
    deniedLivePaths.some((denied) =>
      hostMaterializerRoots.some((root) => pathsOverlap(denied, root))
    )
    || deniedControlPaths.some((denied) =>
      hostMaterializerRoots.some((root) => pathsOverlap(denied, root))
    )
  ) {
    throw reject(
      "authority_rejected",
      "拒写路径与 host materializer root 不能重叠",
      "authority_paths_overlap"
    );
  }
  if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs <= 0) {
    throw reject(
      "authority_rejected",
      "Hermes proposal timeoutMs 必须为正整数",
      "invalid_timeout"
    );
  }
  try {
    await runHermesOperationWithDeadline({
      label: "Hermes capability revalidation",
      timeoutMs: scaledHermesTimeoutMs(secrets.commandTimeoutMs, 6),
      externalSignal: input.abortSignal,
      operation: async (signal) => await revalidateHermesCapabilityBeforeInvocation({
        capability,
        secrets,
        deniedLivePaths,
        deniedControlPaths,
        hostMaterializerRoots,
        abortSignal: signal
      })
    });
  } catch (error) {
    if (input.abortSignal?.aborted) {
      throw reject(
        "canceled",
        "Hermes proposal 在 prompt 提交前已取消",
        "canceled_before_submission",
        error
      );
    }
    throw reject(
      "capability_untrusted",
      `Hermes capability 在 prompt 提交前复验失败：${errorMessage(error)}`,
      "capability_revalidation_failed",
      error
    );
  }
  if (input.abortSignal?.aborted) {
    throw reject(
      "canceled",
      "Hermes proposal 在 prompt 提交前已取消",
      "canceled_before_submission"
    );
  }

  const args = [
    "chat",
    "-q",
    input.prompt,
    "--quiet",
    "--safe-mode",
    "--toolsets",
    HERMES_PROPOSAL_TOOLSET,
    "--max-turns",
    "1",
    "--source",
    "tool",
    "--cli",
    "--provider",
    capability.providerId,
    "--model",
    capability.modelId
  ] as const;
  const env = {
    ...secrets.env,
    HERMES_EPHEMERAL_SYSTEM_PROMPT: input.systemPrompt,
    HERMES_QUIET: "1"
  };
  const promptDigest = digestText(input.prompt);
  const argvDigest = digestJson(args);
  const environmentDigest = digestEnvironment(env);
  const authorityReceipt: HermesVaultNoWriteAuthorityReceipt = Object.freeze({
    version: 1,
    authority: "vault-no-write-host-output-only",
    scope: "vault-only",
    osSandbox: false,
    backend: "hermes",
    attemptId: input.lease.attemptId,
    leaseId: input.lease.leaseId,
    deniedLivePaths: Object.freeze(deniedLivePaths),
    deniedControlPaths: Object.freeze(deniedControlPaths),
    hostMaterializerRoots: Object.freeze(hostMaterializerRoots),
    hermesVersion: capability.hermesVersion,
    upstreamCommit: capability.upstreamCommit,
    localCommit: capability.localCommit,
    command: capability.command,
    argvWithoutPrompt: Object.freeze([
      "chat",
      "-q",
      `<prompt:${promptDigest}>`,
      ...args.slice(3)
    ]),
    argvDigest,
    environmentKeys: Object.freeze(Object.keys(env).sort()),
    environmentDigest,
    cwd: capability.neutralCwd,
    outputSchemaDigest: HERMES_MAINTENANCE_PROPOSAL_SCHEMA_DIGEST,
    capabilityProbeDigest: capability.probeDigest,
    promptDigest,
    inputDigest: invocationInputDigest,
    configuredAt: new Date().toISOString()
  });
  trustedAuthorityReceipts.add(authorityReceipt);
  try {
    if (input.onAuthorityConfigured) {
      const authorityTimeoutMs = secrets.commandTimeoutMs;
      await runHermesOperationWithDeadline({
        label: "Hermes exact-write authority callback",
        timeoutMs: authorityTimeoutMs,
        externalSignal: input.abortSignal,
        operation: async (signal) => await input.onAuthorityConfigured?.(
          authorityReceipt,
          {
            signal,
            timeoutMs: authorityTimeoutMs
          }
        )
      });
    }
  } catch (error) {
    if (
      input.abortSignal?.aborted
      || (error instanceof HermesProposalProcessControlError && error.kind === "canceled")
    ) {
      throw reject(
        "canceled",
        "Hermes proposal 在 prompt 提交前已取消",
        "canceled_before_submission",
        error
      );
    }
    throw reject(
      "authority_rejected",
      `Vault-no-write authority 回调失败，prompt 尚未提交：${errorMessage(error)}`,
      "authority_callback_failed",
      error
    );
  }
  if (input.abortSignal?.aborted) {
    throw reject(
      "canceled",
      "Hermes proposal 在 prompt 提交前已取消",
      "canceled_before_submission"
    );
  }
  const leaseBinding: {
    authorityReceipt: HermesVaultNoWriteAuthorityReceipt;
    proposal?: ValidatedHermesMaintenanceProposal;
  } = { authorityReceipt };
  const authorityBinding: {
    lease: HermesProposalLease;
    proposal?: ValidatedHermesMaintenanceProposal;
  } = { lease: input.lease };
  leaseInvocationBindings.set(input.lease, leaseBinding);
  authorityInvocationBindings.set(authorityReceipt, authorityBinding);

  const controller = new AbortController();
  let abortKind: "timeout" | "canceled" | undefined;
  let abortReceipt: HermesProposalLeaseRevocationReceipt | undefined;
  let rejectAbortGate: ((error: Error) => void) | undefined;
  const abortGate = new Promise<never>((_resolve, rejectAbort) => {
    rejectAbortGate = rejectAbort;
  });
  const abort = (kind: "timeout" | "canceled") => {
    if (controller.signal.aborted) return;
    abortKind = kind;
    // Revocation is deliberately first: a runner that ignores AbortSignal may
    // still return, but its output can no longer be accepted or materialized.
    abortReceipt = revokeHermesProposalLease(input.lease, kind);
    controller.abort(kind);
    rejectAbortGate?.(new Error(`Hermes proposal ${kind}`));
  };
  const onExternalAbort = () => abort("canceled");
  input.abortSignal?.addEventListener("abort", onExternalAbort, { once: true });
  if (input.abortSignal?.aborted) abort("canceled");
  const timeout = setTimeout(() => abort("timeout"), input.timeoutMs);

  let output: { stdout: string; stderr: string };
  let submitted = false;
  let runnerPromise: Promise<{ stdout: string; stderr: string }> | undefined;
  try {
    runnerPromise = controller.signal.aborted
      ? new Promise<{ stdout: string; stderr: string }>(() => undefined)
      : Promise.resolve().then(async () => {
        const processPromise = secrets.runner(capability.command, args, {
          cwd: capability.neutralCwd,
          env,
          maxBuffer: 32 * 1024 * 1024,
          signal: controller.signal
        });
        // The default runner starts execFile while constructing its Promise.
        // A synchronous launch failure therefore cannot be misreported as a
        // submitted Agent attempt.
        submitted = true;
        input.onSubmitted?.();
        return await processPromise;
      });
    output = await Promise.race([runnerPromise, abortGate]);
  } catch (error) {
    if (abortKind) {
      const terminationConfirmedAt = submitted && runnerPromise
        ? await runnerSettlementConfirmedAt(
          runnerPromise,
          input.terminationGraceMs
        )
        : undefined;
      throw new HermesProposalRuntimeError(
        abortKind,
        abortKind === "timeout" ? "Hermes proposal 超时，lease 已先撤销" : "Hermes proposal 已取消，lease 已先撤销",
        abortReceipt,
        { cause: error },
        terminationConfirmedAt
      );
    }
    const receipt = revokeHermesProposalLease(input.lease, "process_failed");
    throw new HermesProposalRuntimeError(
      "process_failed",
      `Hermes proposal process 失败：${errorMessage(error)}`,
      receipt,
      { cause: error }
    );
  } finally {
    clearTimeout(timeout);
    input.abortSignal?.removeEventListener("abort", onExternalAbort);
  }

  if (!isHermesProposalLeaseActive(input.lease)) {
    throw new HermesProposalRuntimeError(
      "late_output_rejected",
      "Hermes process 在 lease 撤销后返回，迟到输出已拒绝",
      leaseStates.get(input.lease)?.revocationReceipt
    );
  }
  let proposalJson: string;
  try {
    proposalJson = extractHermesProposalStdout(output.stdout);
  } catch (error) {
    throw reject(
      "invalid_stdout",
      errorMessage(error),
      "invalid_stdout",
      error
    );
  }
  let proposal: ValidatedHermesMaintenanceProposal;
  try {
    proposal = parseAndValidateHermesMaintenanceProposal(proposalJson, {
      attemptId: validationSnapshot.attemptId,
      sourceFingerprints: new Map(validationSnapshot.sourceFingerprints),
      targetFingerprints: new Map(validationSnapshot.targetFingerprints),
      allowedRoots: validationSnapshot.allowedRoots,
      limits: validationSnapshot.limits
    });
  } catch (error) {
    throw reject(
      "invalid_proposal",
      `Hermes proposal contract 校验失败：${errorMessage(error)}`,
      "invalid_proposal",
      error
    );
  }
  if (
    leaseBinding.authorityReceipt !== authorityReceipt
    || authorityBinding.lease !== input.lease
    || leaseBinding.proposal
    || authorityBinding.proposal
  ) {
    throw reject(
      "lease_untrusted",
      "Hermes proposal invocation 三方绑定状态已变化",
      "invocation_binding_changed"
    );
  }
  leaseBinding.proposal = proposal;
  authorityBinding.proposal = proposal;
  proposalInvocationBindings.set(proposal, {
    lease: input.lease,
    authorityReceipt
  });
  return { proposal, authorityReceipt, stderr: output.stderr };
}

interface HermesProposalIdentity {
  version: string;
  upstreamCommit: string;
  localCommit: string;
  projectPath: string;
}

interface HermesCapabilityProbeOutput {
  plugins: number;
  mcp: Record<string, unknown>;
  hooks: unknown[];
  registryTools: string[];
  contextTools: string[];
  contextEngine: string;
  provider?: {
    id: string;
    transport: string;
    authType: string;
    baseUrl: string;
    baseUrlEnvVar: string;
    apiKeyEnvVars: string[];
  };
}

function parseHermesProposalIdentity(output: string): HermesProposalIdentity {
  return {
    version: output.match(/Hermes Agent v?([0-9]+(?:\.[0-9]+){1,3})/i)?.[1] ?? "",
    upstreamCommit: output.match(/upstream\s+([a-f0-9]{7,40})/i)?.[1] ?? "",
    localCommit: output.match(/local\s+([a-f0-9]{7,40})/i)?.[1] ?? "",
    projectPath: output.match(/(?:^|\n)Project:\s*(.+?)\s*(?:\n|$)/i)?.[1]?.trim() ?? ""
  };
}

async function assertPinnedHermesGitIdentity(
  runner: HermesProposalProcessRunner,
  projectPath: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  commandTimeoutMs: number,
  abortSignal?: AbortSignal
): Promise<void> {
  const head = await runHermesProcessWithDeadline(
    runner,
    "/usr/bin/git",
    ["-C", projectPath, "rev-parse", "HEAD"],
    {
      cwd,
      env,
      maxBuffer: MAX_PROBE_OUTPUT_BYTES
    },
    commandTimeoutMs,
    abortSignal
  );
  const status = await runHermesProcessWithDeadline(
    runner,
    "/usr/bin/git",
    ["-C", projectPath, "status", "--porcelain"],
    {
      cwd,
      env,
      maxBuffer: MAX_PROBE_OUTPUT_BYTES
    },
    commandTimeoutMs,
    abortSignal
  );
  const unexpectedStatus = status.stdout
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .filter((line) => line !== "?? .install_method");
  if (head.stdout.trim() !== SUPPORTED_HERMES_LOCAL_COMMIT_FULL || unexpectedStatus.length > 0) {
    throw new Error(
      `Hermes 安装源与已审计 commit 不一致：${unexpectedStatus.join(", ") || head.stdout.trim()}`
    );
  }
}

async function resolvePinnedHermesProjectFromDiscoveryCommand(
  discoveryCommandInput: string,
  control?: HermesProposalOperationControl
): Promise<string> {
  throwIfAborted(control?.signal, "Hermes project resolver 已取消");
  const discoveryCommand = path.resolve(discoveryCommandInput);
  if (
    !path.isAbsolute(discoveryCommandInput)
    || discoveryCommand !== discoveryCommandInput
    || process.platform === "win32"
  ) {
    throw new Error("Hermes discovery command 必须是规范的非 Windows 绝对路径");
  }
  const commandBytes = await readPinnedExecutable(
    discoveryCommand,
    MAX_LAUNCHER_FILE_BYTES,
    "Hermes discovery command",
    control?.signal
  );
  throwIfAborted(control?.signal, "Hermes project resolver 已取消");
  let auditedEntrypoint = directHermesEntrypointFromPath(discoveryCommand);
  if (!auditedEntrypoint) {
    const lines = commandBytes.toString("utf8").trimEnd().split(/\r?\n/);
    const execMatch = lines[3]?.match(/^exec "([^"\r\n]+)" "\$@"$/);
    if (
      lines.length !== 4
      || lines[0] !== "#!/usr/bin/env bash"
      || lines[1] !== "unset PYTHONPATH"
      || lines[2] !== "unset PYTHONHOME"
      || !execMatch
      || !path.isAbsolute(execMatch[1] ?? "")
    ) {
      throw new Error("Hermes discovery wrapper 不符合已审计的四行启动格式");
    }
    auditedEntrypoint = directHermesEntrypointFromPath(path.resolve(execMatch[1]!));
    if (!auditedEntrypoint) {
      throw new Error("Hermes discovery wrapper 未指向 project/venv/bin/hermes");
    }
  }
  const projectPath = path.dirname(path.dirname(path.dirname(auditedEntrypoint)));
  const projectStat = await fsp.lstat(projectPath);
  throwIfAborted(control?.signal, "Hermes project resolver 已取消");
  if (!projectStat.isDirectory() || projectStat.isSymbolicLink()) {
    throw new Error("Hermes discovery projectPath 不是安全目录");
  }
  if (path.resolve(await fsp.realpath(projectPath)) !== projectPath) {
    throw new Error("Hermes discovery projectPath 路径经过 symlink");
  }
  throwIfAborted(control?.signal, "Hermes project resolver 已取消");
  return projectPath;
}

function directHermesEntrypointFromPath(candidate: string): string | null {
  const normalized = path.resolve(candidate);
  if (
    path.basename(normalized) !== "hermes"
    || path.basename(path.dirname(normalized)) !== "bin"
    || path.basename(path.dirname(path.dirname(normalized))) !== "venv"
  ) {
    return null;
  }
  return normalized;
}

async function inspectPinnedHermesLaunchIdentity(
  projectPathInput: string,
  control?: HermesProposalOperationControl
): Promise<HermesProposalLaunchIdentity> {
  throwIfAborted(control?.signal, "Hermes launch inspector 已取消");
  const profileKey = `${process.platform}-${process.arch}`;
  const profile = Object.prototype.hasOwnProperty.call(AUDITED_LAUNCH_PROFILES, profileKey)
    ? AUDITED_LAUNCH_PROFILES[profileKey as keyof typeof AUDITED_LAUNCH_PROFILES]
    : undefined;
  if (!profile) {
    throw new Error(`当前平台没有 Hermes proposal launch 审计档案：${profileKey}`);
  }
  const projectPath = path.resolve(projectPathInput);
  const projectStat = await fsp.lstat(projectPath);
  throwIfAborted(control?.signal, "Hermes launch inspector 已取消");
  if (!projectStat.isDirectory() || projectStat.isSymbolicLink()) {
    throw new Error("Hermes projectPath 不是安全目录");
  }
  if (path.resolve(await fsp.realpath(projectPath)) !== projectPath) {
    throw new Error("Hermes projectPath 路径经过 symlink");
  }
  throwIfAborted(control?.signal, "Hermes launch inspector 已取消");
  if (process.platform === "win32") {
    throw new Error("Hermes proposal v1 尚未审计 Windows launcher");
  }

  const command = path.join(projectPath, "venv", "bin", "hermes");
  const commandBytes = await readPinnedExecutable(
    command,
    MAX_LAUNCHER_FILE_BYTES,
    "Hermes entrypoint",
    control?.signal
  );
  const commandText = commandBytes.toString("utf8");
  const firstLine = commandText.split(/\r?\n/, 1)[0] ?? "";
  if (!firstLine.startsWith("#!")) {
    throw new Error("Hermes entrypoint 缺少 Python shebang");
  }
  const shebangPythonPath = firstLine.slice(2).trim();
  const venvBinPath = path.join(projectPath, "venv", "bin");
  if (
    !path.isAbsolute(shebangPythonPath)
    || !isSameOrDescendant(path.resolve(shebangPythonPath), venvBinPath)
  ) {
    throw new Error("Hermes entrypoint shebang 未绑定当前 venv");
  }
  const normalizedEntrypoint = commandText.replace(/^#![^\r\n]+/, "#!<PYTHON>");
  const commandDigest = digestText(normalizedEntrypoint);
  if (commandDigest !== profile.normalizedEntrypointSha256) {
    throw new Error(`Hermes entrypoint 摘要未审计：${commandDigest}`);
  }

  const pythonPath = path.resolve(shebangPythonPath);
  const pythonPathStat = await fsp.lstat(pythonPath);
  throwIfAborted(control?.signal, "Hermes launch inspector 已取消");
  if (!pythonPathStat.isFile() && !pythonPathStat.isSymbolicLink()) {
    throw new Error("Hermes venv Python launcher 不是文件或 symlink");
  }
  const pythonRealPath = path.resolve(await fsp.realpath(pythonPath));
  const pythonBytes = await readPinnedExecutable(
    pythonRealPath,
    MAX_PINNED_PYTHON_BYTES,
    "Hermes Python interpreter",
    control?.signal
  );
  throwIfAborted(control?.signal, "Hermes launch inspector 已取消");
  const pythonDigest = `sha256:${createHash("sha256").update(pythonBytes).digest("hex")}`;
  if (pythonDigest !== profile.pythonSha256) {
    throw new Error(`Hermes Python interpreter 摘要未审计：${pythonDigest}`);
  }
  const identity: HermesProposalLaunchIdentity = Object.freeze({
    command,
    commandDigest,
    pythonPath,
    pythonRealPath,
    pythonDigest,
    profileId: profile.profileId,
    digest: digestJson({
      command,
      commandDigest,
      pythonPath,
      pythonRealPath,
      pythonDigest,
      profileId: profile.profileId
    })
  });
  assertLaunchIdentityShape(identity);
  return identity;
}

async function readPinnedExecutable(
  absolutePath: string,
  maxBytes: number,
  label: string,
  abortSignal?: AbortSignal
): Promise<Buffer> {
  throwIfAborted(abortSignal, `${label} 读取已取消`);
  const pathStat = await fsp.lstat(absolutePath);
  throwIfAborted(abortSignal, `${label} 读取已取消`);
  if (
    !pathStat.isFile()
    || pathStat.isSymbolicLink()
    || pathStat.nlink !== 1
    || (pathStat.mode & 0o022) !== 0
    || pathStat.size > maxBytes
  ) {
    throw new Error(`${label} 不是只由 owner 可改的独立普通文件`);
  }
  const handle = await fsp.open(
    absolutePath,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)
  );
  try {
    const before = await handle.stat();
    throwIfAborted(abortSignal, `${label} 读取已取消`);
    if (
      !before.isFile()
      || before.nlink !== 1
      || Number(before.dev) !== Number(pathStat.dev)
      || Number(before.ino) !== Number(pathStat.ino)
      || before.size !== pathStat.size
    ) {
      throw new Error(`${label} 在打开前已变化`);
    }
    const bytes = await handle.readFile(abortSignal ? { signal: abortSignal } : undefined);
    const after = await handle.stat();
    const current = await fsp.lstat(absolutePath);
    throwIfAborted(abortSignal, `${label} 读取已取消`);
    if (
      Number(after.dev) !== Number(before.dev)
      || Number(after.ino) !== Number(before.ino)
      || after.size !== before.size
      || bytes.byteLength !== before.size
      || Number(current.dev) !== Number(before.dev)
      || Number(current.ino) !== Number(before.ino)
    ) {
      throw new Error(`${label} 在摘要读取期间变化`);
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

function assertLaunchIdentityShape(identity: HermesProposalLaunchIdentity): void {
  if (
    !path.isAbsolute(identity.command)
    || !path.isAbsolute(identity.pythonPath)
    || !path.isAbsolute(identity.pythonRealPath)
    || !isDigest(identity.commandDigest)
    || !isDigest(identity.pythonDigest)
    || !isDigest(identity.digest)
    || !identity.profileId.trim()
    || identity.digest !== digestJson({
      command: identity.command,
      commandDigest: identity.commandDigest,
      pythonPath: identity.pythonPath,
      pythonRealPath: identity.pythonRealPath,
      pythonDigest: identity.pythonDigest,
      profileId: identity.profileId
    })
  ) {
    throw new Error("Hermes launch identity 结构或摘要无效");
  }
}

function buildCapabilityProbeScript(projectPath: string, providerId: string): string {
  return [
    "import json,sys",
    `sys.path.insert(0,${JSON.stringify(projectPath)})`,
    "from hermes_cli.plugins import discover_plugins,get_plugin_manager",
    "discover_plugins()",
    "from tools.mcp_tool import _load_mcp_config",
    "from model_tools import get_tool_definitions",
    "from agent.context_compressor import ContextCompressor",
    "from agent.shell_hooks import register_from_config",
    "from hermes_cli.config import load_config",
    "from hermes_cli.providers import get_provider",
    `provider=get_provider(${JSON.stringify(providerId)})`,
    "cfg=load_config()",
    "compressor=ContextCompressor(model='openai/gpt-5',config_context_length=200000,quiet_mode=True)",
    "out={'plugins':len(get_plugin_manager()._plugins),'mcp':_load_mcp_config(),'hooks':register_from_config(cfg),'registryTools':[x['function']['name'] for x in get_tool_definitions(enabled_toolsets=['context_engine'],quiet_mode=True)],'contextTools':[x.get('name') for x in compressor.get_tool_schemas()],'contextEngine':str((cfg.get('context') or {}).get('engine') or 'compressor'),'provider':None if provider is None else {'id':provider.id,'transport':provider.transport,'authType':provider.auth_type,'baseUrl':provider.base_url,'baseUrlEnvVar':provider.base_url_env_var,'apiKeyEnvVars':list(provider.api_key_env_vars)}}",
    "print(json.dumps(out,sort_keys=True))"
  ].join(";");
}

async function prepareIsolationRoot(rawRoot: string, attemptId: string): Promise<string> {
  if (!path.isAbsolute(rawRoot)) {
    throw new Error("Hermes proposal isolationRoot 必须是绝对路径");
  }
  const root = path.resolve(rawRoot);
  if (!path.isAbsolute(root) || root === path.parse(root).root) {
    throw new Error("Hermes proposal isolationRoot 必须是非根绝对路径");
  }
  await fsp.mkdir(root, { recursive: true, mode: 0o700 });
  const stat = await fsp.lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("Hermes proposal isolationRoot 必须是真实目录");
  }
  const realRoot = await fsp.realpath(root);
  if (path.resolve(realRoot) !== root) {
    throw new Error("Hermes proposal isolationRoot 路径不能经过 symlink");
  }
  const attemptRoot = path.join(root, `hermes-proposal-${safePathToken(attemptId)}-${randomUUID()}`);
  await fsp.mkdir(attemptRoot, { recursive: false, mode: 0o700 });
  return attemptRoot;
}

async function copyCredentialFiles(
  files: readonly HermesProposalCredentialFile[],
  isolatedHomePath: string
): Promise<void> {
  const seen = new Set<string>();
  for (const file of files) {
    if (!ALLOWED_AUTH_FILE_NAMES.has(file.destinationName) || seen.has(file.destinationName)) {
      throw new Error(`Hermes proposal credential file 不允许：${file.destinationName}`);
    }
    seen.add(file.destinationName);
    const sourcePath = path.resolve(file.sourcePath);
    const sourceBytes = await readPinnedExecutable(
      sourcePath,
      MAX_AUTH_FILE_BYTES,
      "Hermes proposal credential source"
    );
    const destinationPath = path.join(isolatedHomePath, file.destinationName);
    const destination = await fsp.open(
      destinationPath,
      fsConstants.O_WRONLY
        | fsConstants.O_CREAT
        | fsConstants.O_EXCL
        | (fsConstants.O_NOFOLLOW ?? 0),
      0o600
    );
    try {
      await destination.writeFile(sourceBytes);
      await destination.sync();
    } finally {
      await destination.close();
    }
  }
}

function buildHermesProposalEnvironment(input: {
  isolatedHomePath: string;
  neutralCwd: string;
  tempPath: string;
  noManagedScopePath: string;
  providerProfile: AuditedProviderProfile;
  credentialEnvironment: Readonly<Record<string, string>>;
}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    HOME: input.isolatedHomePath,
    HERMES_HOME: input.isolatedHomePath,
    HERMES_SAFE_MODE: "1",
    HERMES_IGNORE_USER_CONFIG: "1",
    HERMES_IGNORE_RULES: "1",
    HERMES_MANAGED_DIR: input.noManagedScopePath,
    HERMES_SESSION_SOURCE: "tool",
    HERMES_TUI: "0",
    HERMES_YOLO_MODE: "0",
    HERMES_ACCEPT_HOOKS: "0",
    HERMES_DEFER_AGENT_STARTUP: "0",
    PYTHONDONTWRITEBYTECODE: "1",
    PYTHONNOUSERSITE: "1",
    TERMINAL_CWD: input.neutralCwd,
    TMPDIR: input.tempPath,
    TERM: "dumb",
    NO_COLOR: "1",
    LANG: "C.UTF-8"
  };
  env[input.providerProfile.baseUrlEnvironmentKey] = input.providerProfile.defaultBaseUrl;
  const providerKeys = new Set<string>([
    input.providerProfile.baseUrlEnvironmentKey,
    ...input.providerProfile.credentialEnvironmentKeys
  ]);
  for (const [key, value] of Object.entries(input.credentialEnvironment)) {
    if (!isSafeCredentialEnvironmentKey(key, providerKeys)
      || typeof value !== "string"
      || value.includes("\0")
      || Buffer.byteLength(value, "utf8") > 64 * 1024) {
      throw new Error(`Hermes proposal environment key 不允许：${key}`);
    }
    if (key === input.providerProfile.baseUrlEnvironmentKey && !isSafeHttpEndpoint(value)) {
      throw new Error(`Hermes proposal provider endpoint 必须为 HTTP(S)：${key}`);
    }
    env[key] = value;
  }
  return env;
}

function isSafeCredentialEnvironmentKey(
  key: string,
  providerKeys: ReadonlySet<string>
): boolean {
  if (!/^[A-Z][A-Z0-9_]{1,127}$/.test(key)) return false;
  if (DENIED_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) return false;
  return SAFE_ENV_EXACT.has(key) || providerKeys.has(key);
}

function auditedProviderProfile(providerId: string): AuditedProviderProfile | null {
  const normalized = providerId.trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(AUDITED_PROVIDER_PROFILES, normalized)
    ? AUDITED_PROVIDER_PROFILES[normalized as keyof typeof AUDITED_PROVIDER_PROFILES]
    : null;
}

function providerMatchesAuditedProfile(
  provider: NonNullable<HermesCapabilityProbeOutput["provider"]>,
  profile: AuditedProviderProfile,
  environment: NodeJS.ProcessEnv
): boolean {
  const providerCredentialKeys = [...(provider.apiKeyEnvVars ?? [])].sort();
  const auditedCredentialKeys = [...profile.credentialEnvironmentKeys].sort();
  if (
    provider.id !== profile.id
    || provider.transport !== profile.transport
    || provider.authType !== profile.authType
    || provider.baseUrlEnvVar !== profile.baseUrlEnvironmentKey
    || providerCredentialKeys.some((key) => !auditedCredentialKeys.includes(key))
  ) {
    return false;
  }
  const effectiveEndpoint =
    environment[profile.baseUrlEnvironmentKey]
    || provider.baseUrl
    || profile.defaultBaseUrl;
  const canonicalEffectiveEndpoint = canonicalSafeHttpEndpoint(effectiveEndpoint);
  const canonicalReportedEndpoint = provider.baseUrl
    ? canonicalSafeHttpEndpoint(provider.baseUrl)
    : canonicalEffectiveEndpoint;
  return Boolean(
    canonicalEffectiveEndpoint
    && canonicalReportedEndpoint
    && canonicalEffectiveEndpoint === canonicalReportedEndpoint
  );
}

function isSafeHttpEndpoint(value: string): boolean {
  return Boolean(canonicalSafeHttpEndpoint(value));
}

function canonicalSafeHttpEndpoint(value: string): string | null {
  try {
    const endpoint = new URL(value);
    if (!endpoint.hostname || endpoint.username || endpoint.password) return null;
    if (endpoint.protocol === "https:") return endpoint.toString();
    if (endpoint.protocol !== "http:") return null;
    return endpoint.hostname === "127.0.0.1"
      || endpoint.hostname === "localhost"
      || endpoint.hostname === "::1"
      ? endpoint.toString()
      : null;
  } catch {
    return null;
  }
}

function extractHermesProposalStdout(stdout: string): string {
  const lines = stdout.split(/\r?\n/);
  const retained = lines.filter((line) => {
    const trimmed = stripAnsi(line).trim();
    if (!trimmed) return false;
    return !/^⚠\s+tirith security scanner enabled but not available\b/i.test(trimmed);
  });
  return extractSingleJsonObject(retained.join("\n"));
}

function extractSingleJsonObject(value: string): string {
  const input = value.trim();
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  let end = -1;
  let objectCount = 0;
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]!;
    if (start < 0) {
      if (/\s/.test(char)) continue;
      if (char !== "{") throw new Error("Hermes stdout 含 JSON 以外的非白名单文本");
      start = index;
      depth = 1;
      objectCount += 1;
      continue;
    }
    if (end >= 0) {
      if (!/\s/.test(char)) throw new Error("Hermes stdout 含多个或尾随 payload");
      continue;
    }
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }
    if (char === "\"") {
      inString = true;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) end = index;
    }
  }
  if (objectCount !== 1 || start < 0 || end < start || depth !== 0 || inString) {
    throw new Error("Hermes stdout 不包含单一完整 JSON object");
  }
  return input.slice(start, end + 1);
}

async function canonicalExistingPaths(
  values: readonly string[],
  label: string
): Promise<string[]> {
  const resolvedPaths = new Set<string>();
  for (const value of values) {
    if (
      typeof value !== "string"
      || !path.isAbsolute(value)
      || value !== value.trim()
    ) {
      throw new Error(`${label} 必须是规范绝对路径`);
    }
    const resolved = path.resolve(value);
    if (resolved === path.parse(resolved).root) {
      throw new Error(`${label} 必须是非根绝对路径`);
    }
    const stat = await fsp.lstat(resolved);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`${label} 必须是已存在的真实目录：${resolved}`);
    }
    if (path.resolve(await fsp.realpath(resolved)) !== resolved) {
      throw new Error(`${label} 路径不能经过 symlink：${resolved}`);
    }
    resolvedPaths.add(resolved);
  }
  return [...resolvedPaths].sort();
}

async function revalidateHermesCapabilityBeforeInvocation(input: {
  capability: HermesVaultNoWriteCapability;
  secrets: CapabilitySecrets;
  deniedLivePaths: readonly string[];
  deniedControlPaths: readonly string[];
  hostMaterializerRoots: readonly string[];
  abortSignal?: AbortSignal;
}): Promise<void> {
  throwIfAborted(input.abortSignal, "Hermes capability 复验已取消");
  const projectPath = await runHermesOperationWithDeadline({
    label: "Hermes project resolver revalidation",
    timeoutMs: input.secrets.commandTimeoutMs,
    externalSignal: input.abortSignal,
    operation: async (signal) => await input.secrets.projectResolver(
      input.capability.discoveryCommand,
      {
        signal,
        timeoutMs: input.secrets.commandTimeoutMs
      }
    )
  });
  throwIfAborted(input.abortSignal, "Hermes capability 复验已取消");
  if (path.resolve(projectPath) !== input.capability.projectPath) {
    throw new Error("Hermes discovery command 的 projectPath 已变化");
  }
  const launchIdentity = await runHermesOperationWithDeadline({
    label: "Hermes launch inspector revalidation",
    timeoutMs: input.secrets.commandTimeoutMs,
    externalSignal: input.abortSignal,
    operation: async (signal) => await input.secrets.launchInspector(projectPath, {
      signal,
      timeoutMs: input.secrets.commandTimeoutMs
    })
  });
  throwIfAborted(input.abortSignal, "Hermes capability 复验已取消");
  assertLaunchIdentityShape(launchIdentity);
  assertSameLaunchIdentity(launchIdentity, input.secrets.launchIdentity);
  if (
    launchIdentity.command !== input.capability.command
    || launchIdentity.pythonPath !== input.capability.pythonPath
    || launchIdentity.pythonRealPath !== input.capability.pythonRealPath
    || launchIdentity.profileId !== input.capability.launchProfileId
    || launchIdentity.digest !== input.capability.launchIdentityDigest
  ) {
    throw new Error("Hermes capability 与当前 entrypoint/Python 身份不一致");
  }
  const directVersion = await runHermesProcessWithDeadline(
    input.secrets.runner,
    launchIdentity.command,
    ["--version"],
    {
      cwd: input.capability.neutralCwd,
      env: input.secrets.env,
      maxBuffer: MAX_PROBE_OUTPUT_BYTES
    },
    input.secrets.commandTimeoutMs,
    input.abortSignal
  );
  const identity = parseHermesProposalIdentity(
    `${directVersion.stdout}\n${directVersion.stderr}`
  );
  if (
    identity.version !== input.capability.hermesVersion
    || identity.upstreamCommit !== input.capability.upstreamCommit
    || identity.localCommit !== input.capability.localCommit
    || path.resolve(identity.projectPath) !== input.capability.projectPath
  ) {
    throw new Error("Hermes audited entrypoint 的运行身份已变化");
  }
  await assertPinnedHermesGitIdentity(
    input.secrets.runner,
    projectPath,
    input.capability.neutralCwd,
    input.secrets.env,
    input.secrets.commandTimeoutMs,
    input.abortSignal
  );
  await assertHermesIsolationStillSafe(input);
}

function assertSameLaunchIdentity(
  current: HermesProposalLaunchIdentity,
  expected: HermesProposalLaunchIdentity
): void {
  if (
    current.command !== expected.command
    || current.commandDigest !== expected.commandDigest
    || current.pythonPath !== expected.pythonPath
    || current.pythonRealPath !== expected.pythonRealPath
    || current.pythonDigest !== expected.pythonDigest
    || current.profileId !== expected.profileId
    || current.digest !== expected.digest
  ) {
    throw new Error("Hermes entrypoint 或 Python 摘要在 preflight 后变化");
  }
}

async function assertHermesIsolationStillSafe(input: {
  capability: HermesVaultNoWriteCapability;
  secrets: CapabilitySecrets;
  deniedLivePaths: readonly string[];
  deniedControlPaths: readonly string[];
  hostMaterializerRoots: readonly string[];
}): Promise<void> {
  const isolationRoot = path.dirname(input.capability.isolatedHomePath);
  const expectedHomePath = path.join(isolationRoot, "home");
  const expectedCwd = path.join(isolationRoot, "cwd");
  const expectedTempPath = path.join(isolationRoot, "tmp");
  const expectedManagedPath = path.join(isolationRoot, "managed-scope-disabled");
  if (
    input.capability.isolatedHomePath !== expectedHomePath
    || input.capability.neutralCwd !== expectedCwd
    || input.secrets.env.HOME !== expectedHomePath
    || input.secrets.env.HERMES_HOME !== expectedHomePath
    || input.secrets.env.TERMINAL_CWD !== expectedCwd
    || input.secrets.env.TMPDIR !== expectedTempPath
    || input.secrets.env.HERMES_MANAGED_DIR !== expectedManagedPath
  ) {
    throw new Error("Hermes capability 的隔离 HOME/CWD/TMP/managed scope 绑定已变化");
  }
  const isolationPaths = [
    isolationRoot,
    expectedHomePath,
    expectedCwd,
    expectedTempPath,
    expectedManagedPath
  ];
  for (const isolationPath of isolationPaths) {
    await assertPrivateRealDirectory(isolationPath);
  }
  const authorityPaths = [
    ...input.deniedLivePaths,
    ...input.deniedControlPaths,
    ...input.hostMaterializerRoots
  ];
  if (
    isolationPaths.some((isolated) =>
      authorityPaths.some((authorityPath) => pathsOverlap(isolated, authorityPath))
    )
  ) {
    throw new Error("Hermes 隔离 HOME/CWD 与 live/control/materializer 路径重叠");
  }
}

async function assertPrivateRealDirectory(directoryPath: string): Promise<void> {
  const stat = await fsp.lstat(directoryPath);
  if (
    !stat.isDirectory()
    || stat.isSymbolicLink()
    || (stat.mode & 0o022) !== 0
    || path.resolve(await fsp.realpath(directoryPath)) !== directoryPath
  ) {
    throw new Error(`Hermes isolation 不是私有真实目录：${directoryPath}`);
  }
}

function isSameOrDescendant(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function pathsOverlap(left: string, right: string): boolean {
  return isSameOrDescendant(left, right) || isSameOrDescendant(right, left);
}

function trustedLeaseState(lease: HermesProposalLease): LeaseState {
  if (!trustedLeases.has(lease)) {
    throw new HermesProposalRuntimeError("lease_untrusted", "拒绝普通对象或伪造的 Hermes proposal lease");
  }
  const state = leaseStates.get(lease);
  if (!state) throw new HermesProposalRuntimeError("lease_untrusted", "Hermes proposal lease state 丢失");
  return state;
}

function safePathToken(value: string): string {
  const token = value.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 80);
  return token || "attempt";
}

function digestEnvironment(env: NodeJS.ProcessEnv): string {
  // The trusted launch state retains the frozen values in-memory. Persisted
  // receipts bind only the key set so low-entropy tokens cannot be recovered
  // by dictionary attacks against a plain value hash.
  return digestJson(Object.keys(env).sort());
}

function invocationInputDigestFromSnapshot(
  prompt: string,
  systemPrompt: string,
  validation: HermesProposalValidationSnapshot
): string {
  if (typeof prompt !== "string" || typeof systemPrompt !== "string") {
    throw new HermesProposalRuntimeError(
      "lease_untrusted",
      "Hermes proposal prompt 与 systemPrompt 必须是 string"
    );
  }
  return digestJson({
    version: 1,
    outputSchemaDigest: HERMES_MAINTENANCE_PROPOSAL_SCHEMA_DIGEST,
    prompt,
    systemPrompt,
    validation
  });
}

function digestText(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function digestJson(value: unknown): string {
  return digestText(stableJson(value));
}

function isDigest(value: string): boolean {
  return /^sha256:[a-f0-9]{64}$/.test(value);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) =>
      `${JSON.stringify(key)}:${stableJson(object[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class HermesProposalProcessControlError extends Error {
  constructor(
    readonly kind: "canceled" | "timeout",
    message: string
  ) {
    super(message);
    this.name = "HermesProposalProcessControlError";
  }
}

function normalizePositiveTimeout(
  value: number | undefined,
  fallback: number
): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : fallback;
}

function scaledHermesTimeoutMs(value: number, multiplier: number): number {
  return Math.min(
    2_147_483_647,
    Math.max(1, Math.trunc(value)) * Math.max(1, Math.trunc(multiplier))
  );
}

function throwIfAborted(signal: AbortSignal | undefined, message: string): void {
  if (signal?.aborted) {
    throw new HermesProposalProcessControlError("canceled", message);
  }
}

async function runHermesOperationWithDeadline<T>(input: {
  label: string;
  timeoutMs: number;
  externalSignal?: AbortSignal;
  operation(signal: AbortSignal): Promise<T>;
}): Promise<T> {
  throwIfAborted(input.externalSignal, `${input.label} 在启动前已取消`);
  const timeoutMs = normalizePositiveTimeout(
    input.timeoutMs,
    DEFAULT_HERMES_PROBE_COMMAND_TIMEOUT_MS
  );
  const controller = new AbortController();
  let rejectGate!: (error: Error) => void;
  const abortGate = new Promise<never>((_resolve, reject) => {
    rejectGate = reject;
  });
  const abort = (kind: "canceled" | "timeout"): void => {
    if (controller.signal.aborted) return;
    controller.abort(kind);
    rejectGate(new HermesProposalProcessControlError(
      kind,
      kind === "canceled"
        ? `${input.label} 已取消`
        : `${input.label} 超过 ${timeoutMs}ms`
    ));
  };
  const onExternalAbort = (): void => abort("canceled");
  input.externalSignal?.addEventListener("abort", onExternalAbort, { once: true });
  if (input.externalSignal?.aborted) abort("canceled");
  const timeout = setTimeout(() => abort("timeout"), timeoutMs);
  try {
    const operationPromise = Promise.resolve().then(() =>
      input.operation(controller.signal)
    );
    return await Promise.race([operationPromise, abortGate]);
  } finally {
    clearTimeout(timeout);
    input.externalSignal?.removeEventListener("abort", onExternalAbort);
  }
}

async function runHermesProcessWithDeadline(
  runner: HermesProposalProcessRunner,
  command: string,
  args: readonly string[],
  options: Omit<HermesProposalProcessOptions, "signal" | "timeoutMs">,
  timeoutMsInput: number,
  externalSignal?: AbortSignal
): Promise<{ stdout: string; stderr: string }> {
  const timeoutMs = normalizePositiveTimeout(
    timeoutMsInput,
    DEFAULT_HERMES_PROBE_COMMAND_TIMEOUT_MS
  );
  return await runHermesOperationWithDeadline({
    label: `Hermes process：${command}`,
    timeoutMs,
    externalSignal,
    operation: async (signal) => await runner(command, args, {
        ...options,
        signal,
        timeoutMs
      })
  });
}

async function runnerSettlementConfirmedAt(
  runnerPromise: Promise<unknown>,
  graceMsInput: number | undefined
): Promise<number | undefined> {
  const graceMs = normalizePositiveTimeout(
    graceMsInput,
    DEFAULT_HERMES_TERMINATION_GRACE_MS
  );
  return await new Promise<number | undefined>((resolve) => {
    let settled = false;
    const finish = (confirmedAt: number | undefined): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(confirmedAt);
    };
    const timeout = setTimeout(() => finish(undefined), graceMs);
    runnerPromise.then(
      () => finish(Date.now()),
      () => finish(Date.now())
    );
  });
}

async function defaultProcessRunner(
  command: string,
  args: readonly string[],
  options: HermesProposalProcessOptions
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(command, [...args], {
      cwd: options.cwd,
      env: options.env,
      maxBuffer: options.maxBuffer,
      signal: options.signal,
      ...(options.timeoutMs ? { timeout: options.timeoutMs } : {})
    }, (error, stdout, stderr) => {
      if (error) {
        const output = [String(stderr ?? "").trim(), String(stdout ?? "").trim()]
          .filter(Boolean)
          .join("\n");
        reject(new Error(output ? `${error.message}\n${output}` : error.message, { cause: error }));
        return;
      }
      resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
  });
}
