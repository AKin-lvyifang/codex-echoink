import {
  defineTool,
  type AgentToolResult,
  type AgentToolUpdateCallback,
  type ToolDefinition
} from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "@earendil-works/pi-ai";
import type { PiKnowledgeReference } from "./contracts";
import {
  isWriteToolAuthorizationContext,
  type JsonValue,
  type ToolAuthorizationContext
} from "./tool-authorization";
import {
  VaultDomainService,
  type VaultMetadataPatch,
  type VaultOperationResult
} from "./vault-domain-service";

export const PI_VAULT_TOOL_IDS = [
  "vault_search",
  "note_read",
  "note_create",
  "note_update",
  "metadata_update",
  "note_move",
  "note_delete"
] as const;

export type PiVaultToolId = typeof PI_VAULT_TOOL_IDS[number];
export type PiVaultToolEffectType = "read" | "user_write";
export type PiVaultToolExecutionStatus =
  | "approved"
  | "running"
  | "verifying"
  | "completed"
  | "failed"
  | "cancelled"
  | "uncertain";

export const PI_VAULT_TOOL_VERSION = "echoink-vault-tool-v1";
export const PI_VAULT_TOOL_POLICY_VERSION = "echoink-vault-tool-policy-v1";
export const PI_VAULT_TOOL_EGRESS_POLICY =
  "echoink-configured-provider-v1";
export const PI_VAULT_TOOL_REDACTION_POLICY =
  "echoink-local-secrets-v1" as const;

const READ_RESULT_LIMIT_BYTES = 32_000;
const WRITE_RESULT_LIMIT_BYTES = 8_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const RESULT_PENDING_SAFETY = "vault_tool_result_pending_safety";

export interface ToolPolicyMetadata {
  readonly toolId: PiVaultToolId;
  readonly effectType: PiVaultToolEffectType;
  readonly approvalPolicy: "none" | "always";
  readonly executionMode: "parallel" | "sequential";
  readonly timeoutMs: number;
  readonly resultSizeLimit: number;
  readonly redactionPolicy: typeof PI_VAULT_TOOL_REDACTION_POLICY;
  readonly egressPolicy: string;
  readonly domainService: string;
}

export interface VaultSearchToolArguments {
  readonly query: string;
  readonly scopePath?: string;
}

export interface NoteReadToolArguments {
  readonly relativePath: string;
}

export interface NoteCreateToolArguments {
  readonly relativePath: string;
  readonly content: string;
}

export interface NoteUpdateToolArguments extends NoteCreateToolArguments {
  readonly expectedVersion: string;
}

export interface MetadataUpdateToolArguments {
  readonly relativePath: string;
  readonly expectedVersion: string;
  readonly patch: Readonly<VaultMetadataPatch>;
}

export interface NoteMoveToolArguments {
  readonly sourcePath: string;
  readonly targetPath: string;
  readonly expectedVersion: string;
}

export interface NoteDeleteToolArguments {
  readonly relativePath: string;
  readonly expectedVersion: string;
}

export interface PiVaultToolArgumentsById {
  vault_search: VaultSearchToolArguments;
  note_read: NoteReadToolArguments;
  note_create: NoteCreateToolArguments;
  note_update: NoteUpdateToolArguments;
  metadata_update: MetadataUpdateToolArguments;
  note_move: NoteMoveToolArguments;
  note_delete: NoteDeleteToolArguments;
}

export type PiVaultToolArguments =
  PiVaultToolArgumentsById[PiVaultToolId];

/**
 * Details stay identity/status-only unless Phase 3 explicitly enables the
 * bounded KnowledgeReference envelope for a successful `note_read`.
 */
export interface PiVaultToolResultDetails {
  readonly source: "echoink-vault";
  readonly toolId: PiVaultToolId;
  readonly toolCallId: string;
  readonly productRunId: string;
  readonly piSessionId: string;
  readonly authorizationId: string;
  readonly operationIdentity?: string;
  readonly effectType: PiVaultToolEffectType;
  readonly status: PiVaultToolExecutionStatus;
  readonly readbackVerified?: boolean;
  readonly type?: "echoink.knowledge-references.v1";
  readonly schemaVersion?: 1;
  readonly references?: readonly Readonly<PiKnowledgeReference>[];
}

export interface ConsumePiVaultToolAuthorizationInput {
  readonly toolCallId: string;
  readonly toolId: PiVaultToolId;
  readonly arguments: Readonly<PiVaultToolArguments>;
  readonly policy: Readonly<ToolPolicyMetadata>;
}

export interface CompletePiVaultToolExecutionInput {
  readonly toolCallId: string;
  readonly toolId: PiVaultToolId;
  readonly value: unknown;
  readonly status: PiVaultToolExecutionStatus;
  readonly readbackVerified?: boolean;
}

/** Shared one-shot bridge owned by the sole controlled Inline Extension. */
export interface PiVaultToolExecutionSecurityPort {
  consumeAuthorization(
    input: Readonly<ConsumePiVaultToolAuthorizationInput>
  ): Readonly<ToolAuthorizationContext>;
  completeExecution(
    input: Readonly<CompletePiVaultToolExecutionInput>
  ): void;
}

export interface ExecutePiVaultWriteInput {
  readonly toolCallId: string;
  readonly toolId: Exclude<PiVaultToolId, "vault_search" | "note_read">;
  readonly arguments: Readonly<PiVaultToolArguments>;
  readonly authorization: Readonly<
    Extract<ToolAuthorizationContext, { authorizationKind: "approval_ticket" }>
  >;
  readonly signal: AbortSignal | undefined;
  readonly onVerifying: () => void;
}

export type InvokePiVaultDomainWrite = (
  beforeSideEffect: () => Promise<void>
) => Promise<Readonly<VaultOperationResult>>;

/**
 * Product-owned write lifecycle invoked by the controlled Tool wrapper. The
 * supplied Domain callback is guarded to one invocation, so the lifecycle can
 * persist Journal/Receipt but cannot retry the Vault side effect.
 */
export interface PiVaultToolWriteExecutionPort {
  execute(
    input: Readonly<ExecutePiVaultWriteInput>,
    invokeDomainOnce: InvokePiVaultDomainWrite
  ): Promise<Readonly<VaultOperationResult>>;
}

export interface CreatePiVaultToolDefinitionsOptions {
  readonly domainService: VaultDomainService;
  readonly security: PiVaultToolExecutionSecurityPort;
  readonly writeExecution: PiVaultToolWriteExecutionPort;
  readonly assertToolAllowed?: (toolName: string, args: Readonly<Record<string, unknown>>) => Promise<void>;
}

export const PI_VAULT_TOOL_POLICIES: Readonly<
Record<PiVaultToolId, Readonly<ToolPolicyMetadata>>
> = Object.freeze({
  vault_search: readPolicy("vault_search", "VaultDomainService.vaultSearch"),
  note_read: readPolicy("note_read", "VaultDomainService.noteRead"),
  note_create: writePolicy("note_create", "VaultDomainService.noteCreate"),
  note_update: writePolicy("note_update", "VaultDomainService.noteUpdate"),
  metadata_update: writePolicy(
    "metadata_update",
    "VaultDomainService.metadataUpdate"
  ),
  note_move: writePolicy("note_move", "VaultDomainService.noteMove"),
  note_delete: writePolicy("note_delete", "VaultDomainService.noteDelete")
});

const METADATA_VALUE = Type.Union([
  Type.Null(),
  Type.String(),
  Type.Number(),
  Type.Boolean(),
  Type.Array(Type.Unknown()),
  Type.Record(Type.String(), Type.Unknown())
]);

export const PI_VAULT_TOOL_SCHEMAS: Readonly<Record<PiVaultToolId, TSchema>> =
  Object.freeze({
    vault_search: Type.Object({
      query: Type.String({ minLength: 1 }),
      scopePath: Type.Optional(Type.String())
    }, { additionalProperties: false }),
    note_read: Type.Object({
      relativePath: Type.String({ minLength: 1 })
    }, { additionalProperties: false }),
    note_create: Type.Object({
      relativePath: Type.String({ minLength: 1 }),
      content: Type.String()
    }, { additionalProperties: false }),
    note_update: Type.Object({
      relativePath: Type.String({ minLength: 1 }),
      expectedVersion: Type.String({ minLength: 1 }),
      content: Type.String()
    }, { additionalProperties: false }),
    metadata_update: Type.Object({
      relativePath: Type.String({ minLength: 1 }),
      expectedVersion: Type.String({ minLength: 1 }),
      patch: Type.Object({
        set: Type.Optional(Type.Record(Type.String(), METADATA_VALUE)),
        remove: Type.Optional(Type.Array(Type.String({ minLength: 1 })))
      }, { additionalProperties: false })
    }, { additionalProperties: false }),
    note_move: Type.Object({
      sourcePath: Type.String({ minLength: 1 }),
      targetPath: Type.String({ minLength: 1 }),
      expectedVersion: Type.String({ minLength: 1 })
    }, { additionalProperties: false }),
    note_delete: Type.Object({
      relativePath: Type.String({ minLength: 1 }),
      expectedVersion: Type.String({ minLength: 1 })
    }, { additionalProperties: false })
  });

export function isPiVaultToolId(value: string): value is PiVaultToolId {
  return (PI_VAULT_TOOL_IDS as readonly string[]).includes(value);
}

/** Exact-key validation is repeated in Extension `tool_call` after Pi Schema validation. */
export function normalizePiVaultToolArguments<T extends PiVaultToolId>(
  toolId: T,
  value: unknown
): Readonly<PiVaultToolArgumentsById[T]> {
  const input = requireRecord(value);
  switch (toolId) {
    case "vault_search":
      requireExactKeys(input, ["query"], ["scopePath"]);
      return freeze({
        query: requireNonEmptyString(input.query),
        ...(input.scopePath === undefined
          ? {}
          : { scopePath: requireString(input.scopePath) })
      }) as Readonly<PiVaultToolArgumentsById[T]>;
    case "note_read":
      requireExactKeys(input, ["relativePath"]);
      return freeze({
        relativePath: requireNonEmptyString(input.relativePath)
      }) as Readonly<PiVaultToolArgumentsById[T]>;
    case "note_create":
      requireExactKeys(input, ["relativePath", "content"]);
      return freeze({
        relativePath: requireNonEmptyString(input.relativePath),
        content: requireString(input.content)
      }) as Readonly<PiVaultToolArgumentsById[T]>;
    case "note_update":
      requireExactKeys(input, [
        "relativePath",
        "expectedVersion",
        "content"
      ]);
      return freeze({
        relativePath: requireNonEmptyString(input.relativePath),
        expectedVersion: requireNonEmptyString(input.expectedVersion),
        content: requireString(input.content)
      }) as Readonly<PiVaultToolArgumentsById[T]>;
    case "metadata_update":
      requireExactKeys(input, ["relativePath", "expectedVersion", "patch"]);
      return freeze({
        relativePath: requireNonEmptyString(input.relativePath),
        expectedVersion: requireNonEmptyString(input.expectedVersion),
        patch: normalizeMetadataPatch(input.patch)
      }) as Readonly<PiVaultToolArgumentsById[T]>;
    case "note_move":
      requireExactKeys(input, [
        "sourcePath",
        "targetPath",
        "expectedVersion"
      ]);
      return freeze({
        sourcePath: requireNonEmptyString(input.sourcePath),
        targetPath: requireNonEmptyString(input.targetPath),
        expectedVersion: requireNonEmptyString(input.expectedVersion)
      }) as Readonly<PiVaultToolArgumentsById[T]>;
    case "note_delete":
      requireExactKeys(input, ["relativePath", "expectedVersion"]);
      return freeze({
        relativePath: requireNonEmptyString(input.relativePath),
        expectedVersion: requireNonEmptyString(input.expectedVersion)
      }) as Readonly<PiVaultToolArgumentsById[T]>;
  }
}

export function createPiVaultToolDefinitions(
  options: Readonly<CreatePiVaultToolDefinitionsOptions>
): readonly ToolDefinition[] {
  return Object.freeze(PI_VAULT_TOOL_IDS.map((toolId) => defineTool({
    name: toolId,
    label: toolLabel(toolId),
    description: toolDescription(toolId),
    parameters: PI_VAULT_TOOL_SCHEMAS[toolId],
    executionMode: PI_VAULT_TOOL_POLICIES[toolId].executionMode,
    execute: async (toolCallId, rawArguments, signal, onUpdate) =>
      await executeVaultTool(
        options,
        toolId,
        toolCallId,
        rawArguments,
        signal,
        onUpdate
      )
  })));
}

async function executeVaultTool(
  options: Readonly<CreatePiVaultToolDefinitionsOptions>,
  toolId: PiVaultToolId,
  toolCallId: string,
  rawArguments: unknown,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<PiVaultToolResultDetails> | undefined
): Promise<AgentToolResult<PiVaultToolResultDetails>> {
  const args = normalizePiVaultToolArguments(toolId, rawArguments);
  await options.assertToolAllowed?.(toolId, args);
  const policy = PI_VAULT_TOOL_POLICIES[toolId];
  const authorization = options.security.consumeAuthorization({
    toolCallId,
    toolId,
    arguments: args,
    policy
  });
  const baseDetails = authorizationDetails(toolId, authorization);
  try {
    if (policy.effectType === "user_write") {
      onUpdate?.(safeToolResult({ ...baseDetails, status: "approved" }));
    }
    throwIfAborted(signal);
    onUpdate?.(safeToolResult({ ...baseDetails, status: "running" }));
    const value = policy.effectType === "user_write"
      ? await executeControlledWrite(
        options,
        toolId,
        toolCallId,
        args,
        authorization,
        signal,
        () => onUpdate?.(safeToolResult({
          ...baseDetails,
          status: "verifying"
        }))
      )
      : await callVaultDomainService(
        options.domainService,
        toolId,
        args,
        authorization,
        signal
      );
    const completion = completionFromValue(policy, value);
    options.security.completeExecution({
      toolCallId,
      toolId,
      value,
      ...completion
    });
    return safeToolResult({ ...baseDetails, ...completion });
  } catch (error) {
    const code = safeExecutionErrorCode(error);
    const status = code === "operation_cancelled"
      ? "cancelled" as const
      : "failed" as const;
    options.security.completeExecution({
      toolCallId,
      toolId,
      value: Object.freeze({ error: code }),
      status
    });
    throw new Error(code);
  }
}

async function executeControlledWrite(
  options: Readonly<CreatePiVaultToolDefinitionsOptions>,
  toolId: PiVaultToolId,
  toolCallId: string,
  args: Readonly<PiVaultToolArguments>,
  authorization: Readonly<ToolAuthorizationContext>,
  signal: AbortSignal | undefined,
  onVerifying: () => void
): Promise<Readonly<VaultOperationResult>> {
  if (
    toolId === "vault_search"
    || toolId === "note_read"
    || !isWriteToolAuthorizationContext(authorization)
  ) {
    throw new Error("authorization_failed");
  }
  let invoked = false;
  const result = await options.writeExecution.execute(
    Object.freeze({
      toolCallId,
      toolId,
      arguments: args,
      authorization,
      signal,
      onVerifying
    }),
    async (beforeSideEffect) => {
      if (invoked) throw new Error("domain_effect_already_invoked");
      invoked = true;
      const value = await callVaultDomainService(
        options.domainService,
        toolId,
        args,
        authorization,
        signal,
        async () => {
          // Domain has now resolved both move endpoints and checked versions.
          // Revalidate current Agent/global/PRO rights around the existing
          // receipt/folder preflight, immediately before its actual mutation.
          await options.assertToolAllowed?.(toolId, args);
          await beforeSideEffect();
          await options.assertToolAllowed?.(toolId, args);
        }
      );
      return requireVaultOperationResult(value, authorization.operationIdentity);
    }
  );
  if (!invoked) throw new Error("domain_effect_not_invoked");
  return requireVaultOperationResult(result, authorization.operationIdentity);
}

async function callVaultDomainService(
  service: VaultDomainService,
  toolId: PiVaultToolId,
  args: Readonly<PiVaultToolArguments>,
  authorization: Readonly<ToolAuthorizationContext>,
  signal: AbortSignal | undefined,
  beforeSideEffect?: () => Promise<void>
): Promise<unknown> {
  switch (toolId) {
    case "vault_search": {
      const input = args as VaultSearchToolArguments;
      return await service.vaultSearch({
        vaultId: authorization.vaultId,
        query: input.query,
        scopePath: input.scopePath,
        signal
      });
    }
    case "note_read": {
      const input = args as NoteReadToolArguments;
      return await service.noteRead({
        vaultId: authorization.vaultId,
        relativePath: input.relativePath,
        signal
      });
    }
  }
  if (!isWriteToolAuthorizationContext(authorization)) {
    throw new Error("authorization_failed");
  }
  const common = {
    vaultId: authorization.vaultId,
    operationIdentity: authorization.operationIdentity,
    signal,
    ...(beforeSideEffect ? { beforeSideEffect } : {})
  };
  switch (toolId) {
    case "note_create":
      return await service.noteCreate({
        ...common,
        ...(args as NoteCreateToolArguments)
      });
    case "note_update":
      return await service.noteUpdate({
        ...common,
        ...(args as NoteUpdateToolArguments)
      });
    case "metadata_update":
      return await service.metadataUpdate({
        ...common,
        ...(args as MetadataUpdateToolArguments)
      });
    case "note_move":
      return await service.noteMove({
        ...common,
        ...(args as NoteMoveToolArguments)
      });
    case "note_delete":
      return await service.noteDelete({
        ...common,
        ...(args as NoteDeleteToolArguments)
      });
  }
}

function requireVaultOperationResult(
  value: unknown,
  operationIdentity: string
): Readonly<VaultOperationResult> {
  const result = value as Partial<VaultOperationResult> | null;
  if (
    !result
    || result.operationIdentity !== operationIdentity
    || typeof result.operation !== "string"
    || !["completed", "failed", "cancelled", "uncertain"].includes(
      String(result.status)
    )
    || typeof result.sideEffectStarted !== "boolean"
    || typeof result.readbackVerified !== "boolean"
    || !result.readback
  ) {
    throw new Error("vault_tool_execution_failed");
  }
  return value as Readonly<VaultOperationResult>;
}

function completionFromValue(
  policy: Readonly<ToolPolicyMetadata>,
  value: unknown
): Readonly<{
  status: PiVaultToolExecutionStatus;
  readbackVerified?: boolean;
}> {
  if (policy.effectType === "read") return Object.freeze({ status: "completed" });
  const result = value as Readonly<VaultOperationResult>;
  return Object.freeze({
    status: result.status,
    readbackVerified: result.readbackVerified
  });
}

function authorizationDetails(
  toolId: PiVaultToolId,
  authorization: Readonly<ToolAuthorizationContext>
): Omit<PiVaultToolResultDetails, "status"> {
  const write = isWriteToolAuthorizationContext(authorization);
  return Object.freeze({
    source: "echoink-vault" as const,
    toolId,
    toolCallId: authorization.toolCallId,
    productRunId: authorization.productRunId,
    piSessionId: authorization.piSessionId,
    authorizationId: write
      ? authorization.ticketId
      : authorization.authorizationId,
    ...(write ? { operationIdentity: authorization.operationIdentity } : {}),
    effectType: authorization.effectType
  });
}

function safeToolResult(
  details: PiVaultToolResultDetails
): AgentToolResult<PiVaultToolResultDetails> {
  return {
    content: [{ type: "text", text: RESULT_PENDING_SAFETY }],
    details: Object.freeze(details)
  };
}

function readPolicy(
  toolId: PiVaultToolId,
  domainService: string
): Readonly<ToolPolicyMetadata> {
  return Object.freeze({
    toolId,
    effectType: "read",
    approvalPolicy: "none",
    executionMode: "parallel",
    timeoutMs: DEFAULT_TIMEOUT_MS,
    resultSizeLimit: READ_RESULT_LIMIT_BYTES,
    redactionPolicy: PI_VAULT_TOOL_REDACTION_POLICY,
    egressPolicy: PI_VAULT_TOOL_EGRESS_POLICY,
    domainService
  });
}

function writePolicy(
  toolId: PiVaultToolId,
  domainService: string
): Readonly<ToolPolicyMetadata> {
  return Object.freeze({
    toolId,
    effectType: "user_write",
    approvalPolicy: "always",
    executionMode: "sequential",
    timeoutMs: DEFAULT_TIMEOUT_MS,
    resultSizeLimit: WRITE_RESULT_LIMIT_BYTES,
    redactionPolicy: PI_VAULT_TOOL_REDACTION_POLICY,
    egressPolicy: PI_VAULT_TOOL_EGRESS_POLICY,
    domainService
  });
}

function normalizeMetadataPatch(value: unknown): Readonly<VaultMetadataPatch> {
  const patch = requireRecord(value);
  requireExactKeys(patch, [], ["set", "remove"]);
  const set = patch.set === undefined
    ? undefined
    : normalizeMetadataSet(patch.set);
  const remove = patch.remove === undefined
    ? undefined
    : Object.freeze(requireArray(patch.remove).map(requireNonEmptyString));
  return freeze({ ...(set ? { set } : {}), ...(remove ? { remove } : {}) });
}

function normalizeMetadataSet(
  value: unknown
): Readonly<Record<string, JsonValue>> {
  const input = requireRecord(value);
  const output: Record<string, JsonValue> = {};
  for (const [key, item] of Object.entries(input)) {
    output[requireNonEmptyString(key)] = normalizeMetadataValue(item);
  }
  return Object.freeze(output);
}

function normalizeMetadataValue(value: unknown): JsonValue {
  if (
    value === null
    || typeof value === "string"
    || typeof value === "boolean"
    || (typeof value === "number" && Number.isFinite(value))
  ) return value;
  if (Array.isArray(value)) {
    return Object.freeze(value.map(normalizeMetadataValue));
  }
  const input = requireRecord(value);
  const output: Record<string, JsonValue> = {};
  for (const [key, item] of Object.entries(input)) {
    output[key] = normalizeMetadataValue(item);
  }
  return Object.freeze(output);
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("vault_tool_schema_invalid");
  }
  return value as Record<string, unknown>;
}

function requireArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new TypeError("vault_tool_schema_invalid");
  return value;
}

function requireExactKeys(
  input: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = []
): void {
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !(key in input))
    || Object.keys(input).some((key) => !allowed.has(key))
  ) throw new TypeError("vault_tool_schema_invalid");
}

function requireString(value: unknown): string {
  if (typeof value !== "string") throw new TypeError("vault_tool_schema_invalid");
  return value;
}

function requireNonEmptyString(value: unknown): string {
  const result = requireString(value);
  if (!result.trim()) throw new TypeError("vault_tool_schema_invalid");
  return result;
}

function freeze<T extends object>(value: T): Readonly<T> {
  return Object.freeze(value);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw new Error("operation_cancelled");
}

function safeExecutionErrorCode(error: unknown): string {
  if (
    error instanceof Error
    && (error.name === "AbortError" || error.message === "operation_cancelled")
  ) return "operation_cancelled";
  const code = error && typeof error === "object" && "code" in error
    ? String(error.code)
    : "";
  if (SAFE_EXECUTION_ERROR_CODES.has(code)) return code;
  return "vault_tool_execution_failed";
}

const SAFE_EXECUTION_ERROR_CODES = new Set([
  "not_found",
  "already_exists",
  "version_conflict",
  "not_file",
  "unsafe_target",
  "cancelled",
  "io_error",
  "invalid_input",
  "operation_cancelled",
  "operation_identity_conflict",
  "adapter_contract_invalid",
  "metadata_invalid"
]);

function toolLabel(toolId: PiVaultToolId): string {
  return toolId.replaceAll("_", " ");
}

function toolDescription(toolId: PiVaultToolId): string {
  const descriptions: Record<PiVaultToolId, string> = {
    vault_search: "Search notes inside the current Vault and return bounded excerpts.",
    note_read: "Read one note inside the current Vault with its current version.",
    note_create: "Create one note after explicit approval.",
    note_update: "Update one note only when its expected version still matches.",
    metadata_update: "Update only the approved frontmatter fields of one note.",
    note_move: "Move one note inside the current Vault after explicit approval.",
    note_delete: "Move one note to Obsidian's recoverable trash after approval."
  };
  return descriptions[toolId];
}
