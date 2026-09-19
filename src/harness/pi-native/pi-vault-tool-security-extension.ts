import { knowledgeRolePath } from "../../knowledge-base/root-paths";
import {
  type InlineExtension,
  type ToolCallEvent,
  type ToolResultEvent
} from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { PiKnowledgeReference } from "./contracts";
import {
  isWriteToolAuthorizationContext,
  normalizeToolAuthorizationContext,
  type ToolAuthorizationContext
} from "./tool-authorization";
import {
  PI_VAULT_TOOL_POLICY_VERSION,
  PI_VAULT_TOOL_POLICIES,
  PI_VAULT_TOOL_VERSION,
  isPiVaultToolId,
  normalizePiVaultToolArguments,
  type CompletePiVaultToolExecutionInput,
  type ConsumePiVaultToolAuthorizationInput,
  type PiVaultToolExecutionSecurityPort,
  type PiVaultToolExecutionStatus,
  type PiVaultToolId,
  type PiVaultToolResultDetails,
  type ToolPolicyMetadata
} from "./pi-vault-tool-contracts";
import {
  secureVaultToolResult,
  type VaultToolResultEgressPort
} from "./vault-tool-result-safety";

export type PiVaultToolBlockReason =
  | "approval_denied"
  | "approval_cancelled"
  | "tool_policy_blocked"
  | "target_not_found"
  | "target_kind_invalid"
  | "authorization_failed";

export class PiVaultToolAuthorizationError extends Error {
  constructor(readonly code: PiVaultToolBlockReason) {
    super(code);
    this.name = "PiVaultToolAuthorizationError";
  }
}

export interface AuthorizePiVaultToolCallInput {
  readonly toolCallId: string;
  readonly toolId: PiVaultToolId;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly policy: Readonly<ToolPolicyMetadata>;
  readonly toolVersion: typeof PI_VAULT_TOOL_VERSION;
  readonly policyVersion: typeof PI_VAULT_TOOL_POLICY_VERSION;
  readonly signal: AbortSignal | undefined;
}

export interface PiVaultToolAuthorizationPort {
  authorize(
    input: Readonly<AuthorizePiVaultToolCallInput>
  ): Promise<Readonly<ToolAuthorizationContext>>;
}

export interface CorrectPiVaultToolResultInput {
  readonly toolCallId: string;
  readonly toolId: PiVaultToolId;
  readonly authorization: Readonly<ToolAuthorizationContext>;
  readonly policy: Readonly<ToolPolicyMetadata>;
  readonly value: unknown;
  readonly status: PiVaultToolExecutionStatus;
  readonly readbackVerified?: boolean;
  readonly isError: boolean;
}

export interface CorrectedPiVaultToolResult {
  readonly content: readonly Readonly<{ type: "text"; text: string }>[];
  readonly isError: boolean;
}

export interface PiVaultToolResultCorrectionPort {
  correct(
    input: Readonly<CorrectPiVaultToolResultInput>
  ): Promise<Readonly<CorrectedPiVaultToolResult>>;
}

export interface CreatePiVaultToolSecurityAdapterOptions {
  /** Same ProductRun policy used to publish the active tool list. Checked before dispatch. */
  readonly isToolAllowed?: (toolName: string) => boolean;
  /** Required fail-closed port; there is no allow-all authorization default. */
  readonly authorization: PiVaultToolAuthorizationPort;
  /** Required fail-closed port; there is no unsanitized result default. */
  readonly resultCorrection: PiVaultToolResultCorrectionPort;
  /** Phase 3 production only: persist a citation envelope on note_read. */
  readonly includeNoteReadKnowledgeReferences?: boolean;
  readonly onSuccessfulNoteRead?: (value: unknown) => void;
  /** One separately policy-bound product Tool may share the sole Extension. */
  readonly additionalToolSecurity?: PiVaultAdditionalToolSecurityPort;
  /** Dynamic declared-readonly MCP Tools use that same sole Extension. */
  readonly additionalToolSecurities?: readonly PiVaultAdditionalToolSecurityPort[];
}

export interface PiVaultAdditionalToolSecurityPort {
  readonly toolName: string;
  /** A dynamic product Tool set can share this same sole Extension. */
  readonly toolNames?: readonly string[];
  handleToolCall(
    event: ToolCallEvent,
    signal: AbortSignal | undefined
  ): Promise<Readonly<{ block: true; reason: string }> | void>;
  handleToolResult(event: ToolResultEvent): Promise<Readonly<{
    content: Array<{ type: "text"; text: string }>;
    details: Readonly<Record<string, unknown>>;
    isError: boolean;
  }>>;
}

interface AuthorizedExecutionRecord {
  readonly authorization: Readonly<ToolAuthorizationContext>;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly policy: Readonly<ToolPolicyMetadata>;
  state: "authorized" | "consumed" | "result_ready";
  value?: unknown;
  status?: PiVaultToolExecutionStatus;
  readbackVerified?: boolean;
}

/**
 * The only stateful seam around Pi's own Tool loop. It keeps an ephemeral,
 * one-shot authorization capability; it owns no loop and writes no transcript.
 */
export class PiVaultToolSecurityAdapter
implements PiVaultToolExecutionSecurityPort {
  readonly inlineExtension: InlineExtension;

  private readonly records = new Map<string, AuthorizedExecutionRecord>();
  private readonly seenToolCallIds = new Set<string>();
  private readonly additionalToolSecurities: readonly PiVaultAdditionalToolSecurityPort[];

  constructor(
    private readonly options: Readonly<CreatePiVaultToolSecurityAdapterOptions>
  ) {
    if (
      !options.authorization
      || !options.resultCorrection
    ) {
      throw new TypeError("pi_vault_security_ports_required");
    }
    this.additionalToolSecurities = Object.freeze([
      ...(options.additionalToolSecurity ? [options.additionalToolSecurity] : []),
      ...(options.additionalToolSecurities ?? [])
    ]);
    this.inlineExtension = Object.freeze({
      name: "echoink-vault-tool-security",
      hidden: true,
      factory: (pi) => {
        pi.on("tool_call", async (event, ctx) =>
          await this.handleToolCall(event, ctx.signal));
        pi.on("tool_result", async (event) =>
          await this.handleToolResult(event));
      }
    });
  }

  consumeAuthorization(
    input: Readonly<ConsumePiVaultToolAuthorizationInput>
  ): Readonly<ToolAuthorizationContext> {
    const record = this.records.get(input.toolCallId);
    if (
      !record
      || record.state !== "authorized"
      || record.authorization.toolCallId !== input.toolCallId
      || record.authorization.toolId !== input.toolId
      || record.policy.toolId !== input.toolId
      || !isDeepStrictEqual(record.policy, input.policy)
      || !isDeepStrictEqual(record.arguments, input.arguments)
    ) {
      throw new PiVaultToolAuthorizationError("authorization_failed");
    }
    record.state = "consumed";
    return record.authorization;
  }

  completeExecution(
    input: Readonly<CompletePiVaultToolExecutionInput>
  ): void {
    const record = this.records.get(input.toolCallId);
    if (
      !record
      || record.state !== "consumed"
      || record.authorization.toolId !== input.toolId
    ) {
      throw new PiVaultToolAuthorizationError("authorization_failed");
    }
    record.value = input.value;
    record.status = input.status;
    record.readbackVerified = input.readbackVerified;
    record.state = "result_ready";
  }

  private async handleToolCall(
    event: ToolCallEvent,
    signal: AbortSignal | undefined
  ): Promise<Readonly<{ block: true; reason: PiVaultToolBlockReason }> | void> {
    if (this.options.isToolAllowed) {
      try {
        if (!this.options.isToolAllowed(event.toolName)) return block("tool_policy_blocked");
      } catch {
        return block("authorization_failed");
      }
    }
    if (!isPiVaultToolId(event.toolName)) {
      const additionalSecurity = this.additionalToolSecurities.find((security) =>
        additionalToolSecurityHandles(security, event.toolName));
      if (additionalSecurity) {
        const result = await additionalSecurity.handleToolCall(
          event,
          signal
        );
        return result?.block
          ? block(isBlockReason(result.reason)
            ? result.reason
            : "tool_policy_blocked")
          : undefined;
      }
      return block("tool_policy_blocked");
    }
    if (this.seenToolCallIds.has(event.toolCallId)) {
      return block("authorization_failed");
    }
    this.seenToolCallIds.add(event.toolCallId);
    let normalizedArguments: Readonly<Record<string, unknown>>;
    try {
      normalizedArguments = normalizePiVaultToolArguments(
        event.toolName,
        event.input
      );
    } catch {
      return block("tool_policy_blocked");
    }
    const policy = policyFor(event.toolName);
    try {
      const value = await this.options.authorization.authorize(Object.freeze({
        toolCallId: event.toolCallId,
        toolId: event.toolName,
        arguments: normalizedArguments,
        policy,
        toolVersion: PI_VAULT_TOOL_VERSION,
        policyVersion: PI_VAULT_TOOL_POLICY_VERSION,
        signal
      }));
      const authorization = normalizeToolAuthorizationContext(value);
      assertAuthorizationMatches(
        authorization,
        event.toolCallId,
        event.toolName,
        normalizedArguments,
        policy
      );
      this.records.set(event.toolCallId, {
        authorization,
        arguments: normalizedArguments,
        policy,
        state: "authorized"
      });
    } catch (error) {
      return block(authorizationBlockReason(error));
    }
  }

  private async handleToolResult(event: ToolResultEvent): Promise<Readonly<{
    content: Array<{ type: "text"; text: string }>;
    details: Readonly<PiVaultToolResultDetails> | Readonly<Record<string, unknown>>;
    isError: boolean;
  }> | void> {
    if (!isPiVaultToolId(event.toolName)) {
      const additionalSecurity = this.additionalToolSecurities.find((security) =>
        additionalToolSecurityHandles(security, event.toolName));
      if (additionalSecurity) return await additionalSecurity.handleToolResult(event);
      return rejectedResult(event.toolCallId, "tool_policy_blocked");
    }
    const record = this.records.get(event.toolCallId);
    if (
      !record
      || record.state !== "result_ready"
      || record.authorization.toolId !== event.toolName
      || record.status === undefined
    ) {
      return rejectedResult(event.toolCallId, "authorization_failed");
    }
    try {
      const result = await this.options.resultCorrection.correct(Object.freeze({
        toolCallId: event.toolCallId,
        toolId: event.toolName,
        authorization: record.authorization,
        policy: record.policy,
        value: record.value,
        status: record.status,
        readbackVerified: record.readbackVerified,
        isError: event.isError || record.status !== "completed"
      }));
      const content = normalizeCorrectedContent(result.content);
      if (event.toolName === "note_read" && !result.isError && record.status === "completed") this.options.onSuccessfulNoteRead?.(record.value);
      return Object.freeze({
        content,
        details: safeDetails(
          event.toolName,
          record.authorization,
          record.status,
          record.readbackVerified,
          this.options.includeNoteReadKnowledgeReferences === true,
          record.value
        ),
        isError: result.isError || record.status !== "completed"
      });
    } catch {
      return rejectedResult(event.toolCallId, "tool_result_rejected");
    } finally {
      this.records.delete(event.toolCallId);
    }
  }
}

function additionalToolSecurityHandles(
  security: PiVaultAdditionalToolSecurityPort,
  toolName: string
): boolean {
  return security.toolName === toolName || security.toolNames?.includes(toolName) === true;
}

export function createPiVaultToolSecurityAdapter(
  options: Readonly<CreatePiVaultToolSecurityAdapterOptions>
): PiVaultToolSecurityAdapter {
  return new PiVaultToolSecurityAdapter(options);
}

/** Creates the required result port, but still requires an explicit Egress port. */
export function createSecurePiVaultToolResultCorrectionPort(
  egress: VaultToolResultEgressPort
): PiVaultToolResultCorrectionPort {
  if (!egress) throw new TypeError("pi_vault_result_egress_required");
  return Object.freeze({
    async correct(input: Readonly<CorrectPiVaultToolResultInput>) {
      const result = await secureVaultToolResult({
        toolId: input.toolId,
        effectType: input.policy.effectType,
        egressPolicy: input.policy.egressPolicy,
        value: input.value,
        sizeLimitBytes: input.policy.resultSizeLimit,
        egress
      });
      return Object.freeze({
        content: Object.freeze([Object.freeze({
          type: "text" as const,
          text: result.text
        })]),
        isError: input.isError
      });
    }
  });
}

function assertAuthorizationMatches(
  authorization: Readonly<ToolAuthorizationContext>,
  toolCallId: string,
  toolId: PiVaultToolId,
  args: Readonly<Record<string, unknown>>,
  policy: Readonly<ToolPolicyMetadata>
): void {
  if (
    authorization.toolCallId !== toolCallId
    || authorization.toolId !== toolId
    || authorization.toolVersion !== PI_VAULT_TOOL_VERSION
    || authorization.policyVersion !== PI_VAULT_TOOL_POLICY_VERSION
    || authorization.effectType !== policy.effectType
    || !isDeepStrictEqual(authorization.normalizedArguments, args)
    || (policy.effectType === "user_write")
      !== isWriteToolAuthorizationContext(authorization)
  ) {
    throw new PiVaultToolAuthorizationError("authorization_failed");
  }
}

function policyFor(toolId: PiVaultToolId): Readonly<ToolPolicyMetadata> {
  return PI_VAULT_TOOL_POLICIES[toolId];
}

function safeDetails(
  toolId: PiVaultToolId,
  authorization: Readonly<ToolAuthorizationContext>,
  status: PiVaultToolExecutionStatus,
  readbackVerified: boolean | undefined,
  includeNoteReadKnowledgeReferences: boolean,
  value: unknown
): Readonly<PiVaultToolResultDetails> {
  const write = isWriteToolAuthorizationContext(authorization);
  const referenceDetails = includeNoteReadKnowledgeReferences
    && toolId === "note_read"
    && status === "completed"
    ? noteReadKnowledgeReferenceDetails(value)
    : null;
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
    effectType: authorization.effectType,
    status,
    ...(readbackVerified === undefined ? {} : { readbackVerified }),
    ...(referenceDetails ?? {})
  });
}

function noteReadKnowledgeReferenceDetails(
  value: unknown
): Readonly<{
  type: "echoink.knowledge-references.v1";
  schemaVersion: 1;
  references: readonly Readonly<PiKnowledgeReference>[];
}> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const snapshotValue = (value as { snapshot?: unknown }).snapshot;
  if (
    !snapshotValue
    || typeof snapshotValue !== "object"
    || Array.isArray(snapshotValue)
  ) return null;
  const snapshot = snapshotValue as Record<string, unknown>;
  if (
    typeof snapshot.relativePath !== "string"
    || !snapshot.relativePath.trim()
    || typeof snapshot.content !== "string"
    || typeof snapshot.contentSha256 !== "string"
    || !/^[a-f0-9]{64}$/u.test(snapshot.contentSha256)
  ) return null;

  const relativePath = snapshot.relativePath.trim().replace(/\\/gu, "/");
  const lines = snapshot.content.split(/\r?\n/u);
  const firstEvidenceIndex = Math.max(0, lines.findIndex((line) => {
    const text = line.trim();
    return text.length > 0 && text !== "---" && !text.startsWith("#");
  }));
  const line = lines[firstEvidenceIndex] ?? "";
  const heading = lines.find((candidate) => /^#\s+\S/u.test(candidate.trim()));
  const fileName = relativePath.split("/").at(-1) ?? relativePath;
  const title = heading?.trim().replace(/^#\s+/u, "").trim()
    || fileName.replace(/\.[^.]+$/u, "")
    || relativePath;
  const lineNumber = firstEvidenceIndex + 1;
  const contentRevision = knowledgeRolePath(relativePath).startsWith("raw/") && typeof snapshot.bodyFingerprint === "string"
    ? `sha256:${snapshot.bodyFingerprint.split(":").at(-1)}`
    : `sha256:${snapshot.contentSha256}`;
  const reference = Object.freeze({
    referenceId: `knowledge-reference:${createHash("sha256")
      .update(relativePath, "utf8")
      .update("\0", "utf8")
      .update(contentRevision, "utf8")
      .update("\0", "utf8")
      .update(`${lineNumber}:${lineNumber}`, "utf8")
      .digest("hex")}`,
    vaultRelativePath: relativePath,
    title,
    excerpt: line,
    contentRevision,
    lineStart: lineNumber,
    lineEnd: lineNumber
  });
  return Object.freeze({
    type: "echoink.knowledge-references.v1" as const,
    schemaVersion: 1 as const,
    references: Object.freeze([reference])
  });
}

function normalizeCorrectedContent(
  value: readonly Readonly<{ type: "text"; text: string }>[]
): Array<{ type: "text"; text: string }> {
  if (value.length === 0) {
    throw new TypeError("tool_result_rejected");
  }
  return value.map((item) => {
    if (item?.type !== "text" || typeof item.text !== "string") {
      throw new TypeError("tool_result_rejected");
    }
    return { type: "text" as const, text: item.text };
  });
}

function authorizationBlockReason(error: unknown): PiVaultToolBlockReason {
  if (error instanceof PiVaultToolAuthorizationError) return error.code;
  if (error instanceof Error && error.name === "AbortError") {
    return "approval_cancelled";
  }
  const code = error && typeof error === "object" && "code" in error
    ? String(error.code)
    : "";
  return isBlockReason(code) ? code : "authorization_failed";
}

function isBlockReason(value: string): value is PiVaultToolBlockReason {
  return value === "approval_denied"
    || value === "approval_cancelled"
    || value === "tool_policy_blocked"
    || value === "target_not_found"
    || value === "target_kind_invalid"
    || value === "authorization_failed";
}

function block(reason: PiVaultToolBlockReason): Readonly<{
  block: true;
  reason: PiVaultToolBlockReason;
}> {
  return Object.freeze({ block: true, reason });
}

function rejectedResult(
  toolCallId: string,
  reason: string
): Readonly<{
  content: Array<{ type: "text"; text: string }>;
  details: Readonly<Record<string, unknown>>;
  isError: true;
}> {
  return Object.freeze({
    content: [{ type: "text" as const, text: reason }],
    details: Object.freeze({
      source: "echoink-vault",
      toolCallId,
      status: "failed"
    }),
    isError: true
  });
}
