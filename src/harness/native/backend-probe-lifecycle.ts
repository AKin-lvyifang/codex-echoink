import { randomUUID } from "node:crypto";
import type { AgentTaskInput } from "../../agent/types";
import type { CodexForObsidianSettings } from "../../settings/settings";
import {
  createHarnessAgentAdapter,
  type CreateHarnessAgentAdapterInput
} from "../agents/adapter-factory";
import type { AgentAdapter } from "../agents/adapter";
import type { NativeExecutionRef } from "../contracts/native-execution";
import type { HarnessRunRequest } from "../contracts/run";
import {
  runEphemeralUtility,
  type EphemeralUtilityLifecycleHost
} from "./ephemeral-utility-lifecycle";
import { canonicalProviderEndpointIdentity } from "./provider-endpoint-identity";

const NO_RESOURCES = { selected: [], resolvedAt: 0, warnings: [] };
const NO_TOOLS = { read: false, write: false, edit: false, bash: false };

export type BackendProbeBackend = "opencode" | "hermes";

export type BackendProbeTransportKind =
  | "opencode-http"
  | "opencode-https"
  | "opencode-server"
  | "hermes-acp-stdio";

export interface BackendProbeTestedConfig {
  schemaVersion: 1;
  backendId: BackendProbeBackend;
  requestedModel: NonNullable<AgentTaskInput["model"]>;
  effectiveModel?: NonNullable<AgentTaskInput["model"]>;
  agent?: string;
  profile?: string;
  transport: {
    kind: BackendProbeTransportKind;
    endpointIdentity: string;
  };
  verification: "verified" | "failed";
}

export interface BackendProbeResult {
  runId: string;
  text: string;
  testedConfig: BackendProbeTestedConfig;
}

export interface RunBackendProbeInput {
  host: EphemeralUtilityLifecycleHost;
  backendId: BackendProbeBackend;
  settings: CodexForObsidianSettings;
  vaultPath: string;
  nativeRefContext: Pick<
    NativeExecutionRef,
    "deviceKey" | "vaultId" | "providerEndpoint"
  >;
  prompt: string;
  expectedToken: string;
  failureMessage: string;
  timeoutMs: number;
  signal?: AbortSignal;
  model?: AgentTaskInput["model"];
  agent?: string;
  profile?: string;
  onHarnessStarted?(runId: string): void;
}

export interface BackendProbeDependencies {
  createAdapter(input: CreateHarnessAgentAdapterInput): AgentAdapter;
  createRunId(backendId: BackendProbeBackend): string;
}

const DEFAULT_DEPENDENCIES: BackendProbeDependencies = {
  createAdapter: (input) => createHarnessAgentAdapter(input),
  createRunId: (backendId) => `backend-probe-${backendId}-${randomUUID()}`
};

/**
 * Runs a real provider connectivity prompt through the same auditable
 * ephemeral lifecycle as other isolated Harness utilities.
 *
 * The selected adapter must durably register a backend-owned Native identity
 * before submitting the prompt. A transport that cannot expose that identity
 * fails closed at the registration barrier; this helper never manufactures a
 * provider run/session ID from the Harness run ID.
 */
export async function runBackendProbe(
  input: RunBackendProbeInput,
  dependencies: Partial<BackendProbeDependencies> = {}
): Promise<BackendProbeResult> {
  assertBackendProbeInput(input);
  const resolvedDependencies = {
    ...DEFAULT_DEPENDENCIES,
    ...dependencies
  };
  const runId = resolvedDependencies.createRunId(input.backendId).trim();
  if (!runId) throw new Error("Backend probe run identity is missing");
  const probeSettings = isolatedProbeSettings(input);
  const probeNativeRefContext = backendProbeNativeRefContext(input);
  let observedEffectiveModel: AgentTaskInput["model"];
  const adapter = resolvedDependencies.createAdapter({
    backendId: input.backendId,
    settings: probeSettings,
    vaultPath: input.vaultPath,
    nativeRefContext: probeNativeRefContext,
    task: {
      timeoutMs: input.timeoutMs,
      tools: NO_TOOLS,
      toolBridge: null,
      ...(input.model ? { model: input.model } : {}),
      ...(input.agent?.trim() ? { agent: input.agent.trim() } : {}),
      ...(input.profile?.trim() ? { profile: input.profile.trim() } : {}),
      requireDirectAgent: input.backendId === "opencode",
      requireNativeRegistrationBeforePrompt: true,
      abortSignal: input.signal
    }
  });
  const request = backendProbeHarnessRequest(input, runId);
  return await runEphemeralUtility({
    host: input.host,
    adapter,
    request,
    signal: input.signal,
    timeoutMs: input.timeoutMs,
    timeoutMessage: `${input.backendId} connection probe timed out`,
    onHarnessStarted: () => input.onHarnessStarted?.(runId),
    validateOutput: (text, result) => {
      observedEffectiveModel = result.effectiveModel
        ? normalizeModelIdentity(result.effectiveModel)
        : undefined;
      assertExpectedEffectiveModel(
        input.backendId,
        normalizeModelIdentity(input.model),
        observedEffectiveModel
      );
      if (!backendProbeContainsToken(text, input.expectedToken)) {
        throw new Error(input.failureMessage);
      }
      const testedConfig = backendProbeTestedConfig(
        input,
        observedEffectiveModel,
        "verified"
      );
      return {
        value: { runId, text, testedConfig },
        terminalText: text,
        terminalData: {
          probeToken: input.expectedToken,
          backendProbe: testedConfig
        }
      };
    },
    failureTerminalData: () => ({
      probeToken: input.expectedToken,
      backendProbe: backendProbeTestedConfig(
        input,
        observedEffectiveModel,
        "failed"
      )
    }),
    isCancellation: (error) =>
      input.signal?.aborted === true
      || /abort|cancel(?:led|ed)?|取消|中断/i.test(errorMessage(error)),
    logLabel: `${input.backendId} backend probe`
  });
}

export function backendProbeContainsToken(
  text: string,
  expectedToken: string
): boolean {
  const token = expectedToken.trim();
  if (!token) return false;
  const candidate = text
    .trim()
    .replace(/^```(?:[a-z0-9_-]+)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  return candidate === token;
}

function backendProbeHarnessRequest(
  input: RunBackendProbeInput,
  runId: string
): HarnessRunRequest & { workflow: "backend.probe"; surface: "system" } {
  return {
    runId,
    sessionId: `backend-probe:${input.backendId}:${runId}`,
    surface: "system",
    workflow: "backend.probe",
    backendId: input.backendId,
    workspace: {
      vaultPath: input.vaultPath,
      cwd: input.vaultPath
    },
    input: {
      text: input.prompt,
      attachments: []
    },
    permissions: {
      mode: "read-only",
      writableRoots: [],
      requireApproval: true
    },
    resourceSelection: {
      ...NO_RESOURCES,
      resolvedAt: Date.now()
    },
    memoryPolicy: {
      enabled: false,
      maxItems: 0
    },
    outputContract: {
      kind: "plain-text"
    }
  };
}

function assertBackendProbeInput(input: RunBackendProbeInput): void {
  const requestedModel = normalizeModelIdentity(input.model);
  const suppliedEndpointIdentity = canonicalProviderEndpointIdentity(
    input.nativeRefContext.providerEndpoint
  );
  const runtimeEndpointIdentity = input.backendId === "opencode"
    ? canonicalProviderEndpointIdentity(openCodeRuntimeEndpoint(input.settings))
    : "";
  if (
    !input.vaultPath.trim()
    || !input.prompt.trim()
    || !input.expectedToken.trim()
    || !input.failureMessage.trim()
    || !input.nativeRefContext.deviceKey.trim()
    || !input.nativeRefContext.vaultId.trim()
    || !requestedModel.providerId
    || !requestedModel.modelId
    || (
      input.backendId === "opencode"
      && (
        !suppliedEndpointIdentity
        || suppliedEndpointIdentity !== runtimeEndpointIdentity
      )
    )
    || (
      input.backendId === "opencode"
      && !input.agent?.trim()
    )
    || !Number.isFinite(input.timeoutMs)
    || input.timeoutMs <= 0
  ) {
    throw new Error(`Invalid backend probe request for ${input.backendId}`);
  }
}

function isolatedProbeSettings(
  input: RunBackendProbeInput
): CodexForObsidianSettings {
  const settings = JSON.parse(
    JSON.stringify(input.settings)
  ) as CodexForObsidianSettings;
  const model = normalizeModelIdentity(input.model);
  if (input.backendId === "opencode") {
    const agent = input.agent?.trim() ?? "";
    settings.opencode.providerId = model.providerId;
    settings.opencode.modelId = model.modelId;
    settings.opencode.agent = agent;
    settings.agents.opencode = {
      ...settings.agents.opencode,
      providerId: model.providerId,
      modelId: model.modelId,
      agent
    };
    return settings;
  }
  settings.agents.hermes.providerId = model.providerId;
  settings.agents.hermes.modelId = model.modelId;
  settings.agents.hermes.profile = input.profile?.trim() ?? "";
  return settings;
}

function backendProbeNativeRefContext(
  input: RunBackendProbeInput
): Pick<
  NativeExecutionRef,
  "deviceKey" | "vaultId" | "providerEndpoint"
> {
  if (input.backendId === "opencode") {
    return {
      deviceKey: input.nativeRefContext.deviceKey,
      vaultId: input.nativeRefContext.vaultId,
      providerEndpoint: canonicalProviderEndpointIdentity(
        openCodeRuntimeEndpoint(input.settings)
      )
    };
  }
  return {
    deviceKey: input.nativeRefContext.deviceKey,
    vaultId: input.nativeRefContext.vaultId,
    providerEndpoint: hermesAcpEndpointIdentity(input.profile)
  };
}

function backendProbeTestedConfig(
  input: RunBackendProbeInput,
  effectiveModel: AgentTaskInput["model"],
  verification: BackendProbeTestedConfig["verification"]
): BackendProbeTestedConfig {
  const requestedModel = normalizeModelIdentity(input.model);
  const agent = input.agent?.trim() ?? "";
  const profile = input.profile?.trim() || "default";
  const endpoint = input.backendId === "hermes"
    ? hermesAcpEndpointIdentity(input.profile)
    : canonicalProviderEndpointIdentity(
      openCodeRuntimeEndpoint(input.settings)
    );
  return {
    schemaVersion: 1,
    backendId: input.backendId,
    requestedModel,
    ...(effectiveModel ? { effectiveModel } : {}),
    ...(input.backendId === "opencode" ? { agent } : { profile }),
    transport: {
      kind: backendProbeTransportKind(input),
      endpointIdentity: endpoint
    },
    verification
  };
}

function backendProbeTransportKind(
  input: RunBackendProbeInput
): BackendProbeTransportKind {
  if (input.backendId === "hermes") return "hermes-acp-stdio";
  try {
    const protocol = new URL(openCodeRuntimeEndpoint(input.settings))
      .protocol
      .toLowerCase();
    if (protocol === "http:") return "opencode-http";
    if (protocol === "https:") return "opencode-https";
  } catch {
    // An opaque endpoint still remains identifiable by its digest.
  }
  return "opencode-server";
}

function openCodeRuntimeEndpoint(
  settings: CodexForObsidianSettings
): string {
  return settings.opencode.serverUrl.trim()
    || `http://${settings.opencode.hostname || "127.0.0.1"}:${settings.opencode.port || 4096}`;
}

function hermesAcpEndpointIdentity(profile: string | undefined): string {
  return `hermes-acp+stdio://local/${encodeURIComponent(
    profile?.trim() || "default"
  )}`;
}

function normalizeModelIdentity(
  model: AgentTaskInput["model"]
): NonNullable<AgentTaskInput["model"]> {
  return {
    providerId: model?.providerId.trim() ?? "",
    modelId: model?.modelId.trim() ?? ""
  };
}

function assertExpectedEffectiveModel(
  backendId: BackendProbeBackend,
  requested: NonNullable<AgentTaskInput["model"]>,
  effective: AgentTaskInput["model"]
): void {
  if (
    effective
    && requested.providerId === effective.providerId
    && requested.modelId === effective.modelId
  ) {
    return;
  }
  throw new Error(
    `${backendId} backend probe effective model `
      + `${effective?.providerId || "<missing>"}/${effective?.modelId || "<missing>"} `
      + `does not match selected ${requested.providerId}/${requested.modelId}`
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
