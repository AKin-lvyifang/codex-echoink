import type {
  ToolCallEvent,
  ToolResultEvent
} from "@earendil-works/pi-coding-agent";
import { Type, validateToolArguments } from "@earendil-works/pi-ai";
import type { FileDomainReceiptStore } from "./domain-receipt-store";
import {
  type PiMcpExecutionContext,
  type PiMcpExecutionSecurityPort,
  type PiMcpToolDetails,
  type PiMcpToolSecurityDescriptor
} from "./pi-mcp-custom-tool-adapter";
import type { PiVaultAdditionalToolSecurityPort } from "./pi-vault-tool-security-extension";
import {
  canonicalJsonStringify,
  normalizeJsonValue,
  type ApprovalOperationContract,
  type EchoInkApprovalTicket,
  type FileApprovalTicketStore,
  type JsonValue,
  type WriteToolAuthorizationContext
} from "./tool-authorization";
import {
  EchoInkVaultToolEgressPolicy,
  secureVaultToolResult,
  type VaultToolResultEgressPort
} from "./vault-tool-result-safety";

const MCP_TOOL_VERSION = "echoink-mcp-tool-v1";
const MCP_POLICY_VERSION = "echoink-mcp-policy-v1";
const MCP_APPROVAL_TTL_MS = 5 * 60 * 1_000;
const MAX_MCP_RESULT_BYTES = 20_000;

type McpToolBlockReason =
  | "approval_denied"
  | "approval_cancelled"
  | "tool_policy_blocked"
  | "authorization_failed";

export interface PiMcpApprovalConfirmationInput {
  readonly requestId: string;
  readonly conversationId: string;
  readonly piSessionId: string;
  readonly productRunId: string;
  readonly toolCallId: string;
  readonly resourceName: string;
  readonly toolName: string;
  readonly destructive: boolean;
  readonly arguments: JsonValue;
  readonly target: JsonValue;
  readonly preview: JsonValue;
  readonly signal: AbortSignal | undefined;
}

export interface PiMcpApprovalConfirmationPort {
  confirm(input: Readonly<PiMcpApprovalConfirmationInput>): Promise<boolean>;
}

interface AuthorizedMcpToolCall {
  readonly toolCallId: string;
  readonly descriptor: Readonly<PiMcpToolSecurityDescriptor>;
  readonly executionContext: Readonly<PiMcpExecutionContext>;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly authorization?: Readonly<WriteToolAuthorizationContext>;
  state: "authorized" | "executing" | "blocked";
  blockReason?: McpToolBlockReason;
}

/**
 * Policy/approval/Receipt seam around Pi's own MCP Tool execution. It owns no
 * loop or transcript; the durable Tool Call/Result remains in AgentSession.
 */
export class PiMcpToolSecurity
implements PiVaultAdditionalToolSecurityPort, PiMcpExecutionSecurityPort {
  readonly toolName = "echoink_mcp";

  private readonly descriptors = new Map<string, Readonly<PiMcpToolSecurityDescriptor>>();
  private readonly calls = new Map<string, AuthorizedMcpToolCall>();
  private readonly seenToolCallIds = new Set<string>();
  private readonly currentExecutionContext: () => Readonly<PiMcpExecutionContext>;
  private readonly isToolAllowed: (
    descriptor: Readonly<PiMcpToolSecurityDescriptor>, args: Readonly<Record<string, unknown>>
  ) => Promise<boolean>;
  private readonly approvals?: FileApprovalTicketStore;
  private readonly receipts?: FileDomainReceiptStore;
  private readonly confirmation?: PiMcpApprovalConfirmationPort;
  private readonly userId?: string;
  private readonly deviceId?: string;
  private readonly now: () => number;
  private readonly egress: VaultToolResultEgressPort;

  constructor(options: {
    readonly tools?: readonly PiMcpToolSecurityDescriptor[];
    readonly currentExecutionContext: () => Readonly<PiMcpExecutionContext>;
    /** Rechecks current Vault/scope/Server/Tool admission at call time. */
    readonly isToolAllowed: (
      descriptor: Readonly<PiMcpToolSecurityDescriptor>, args: Readonly<Record<string, unknown>>
    ) => Promise<boolean>;
    readonly approvals?: FileApprovalTicketStore;
    readonly receipts?: FileDomainReceiptStore;
    readonly confirmation?: PiMcpApprovalConfirmationPort;
    readonly userId?: string;
    readonly deviceId?: string;
    readonly now?: () => number;
    readonly egress?: VaultToolResultEgressPort;
  }) {
    this.currentExecutionContext = options.currentExecutionContext;
    this.isToolAllowed = options.isToolAllowed;
    this.approvals = options.approvals;
    this.receipts = options.receipts;
    this.confirmation = options.confirmation;
    this.userId = options.userId;
    this.deviceId = options.deviceId;
    this.now = options.now ?? Date.now;
    this.egress = options.egress ?? new EchoInkVaultToolEgressPolicy();
    for (const tool of options.tools ?? []) this.registerTool(tool);
  }

  get toolNames(): readonly string[] {
    return Object.freeze([...this.descriptors.keys()]);
  }

  registerTool(descriptor: Readonly<PiMcpToolSecurityDescriptor>): void {
    if (!descriptor.name || this.descriptors.has(descriptor.name)) {
      throw new TypeError("pi_mcp_tool_security_invalid_registry");
    }
    this.descriptors.set(descriptor.name, freezeDescriptor(descriptor));
  }

  async handleToolCall(
    event: ToolCallEvent,
    signal: AbortSignal | undefined
  ): Promise<Readonly<{ block: true; reason: McpToolBlockReason }> | void> {
    const descriptor = this.descriptors.get(event.toolName);
    if (!descriptor || this.seenToolCallIds.has(event.toolCallId)) {
      return block("tool_policy_blocked");
    }
    this.seenToolCallIds.add(event.toolCallId);
    let argumentsValue = normalizeMcpToolInput(event.input);
    if (!argumentsValue) return block("tool_policy_blocked");
    if (descriptor.inputSchema) {
      try {
        argumentsValue = normalizeMcpToolInput(validateToolArguments({ name: descriptor.name, description: "", parameters: Type.Unsafe({ ...descriptor.inputSchema }) }, { type: "toolCall", id: event.toolCallId, name: descriptor.name, arguments: argumentsValue }));
        if (!argumentsValue) return block("tool_policy_blocked");
      } catch { return block("tool_policy_blocked"); }
    }

    let executionContext: Readonly<PiMcpExecutionContext>;
    try {
      if (!await this.isToolAllowed(descriptor, argumentsValue)) {
        return this.rememberBlocked(
          event.toolCallId,
          descriptor,
          argumentsValue,
          "tool_policy_blocked"
        );
      }
      executionContext = freezeExecutionContext(this.currentExecutionContext());
    } catch {
      return this.rememberBlocked(
        event.toolCallId,
        descriptor,
        argumentsValue,
        "authorization_failed"
      );
    }

    event.input = argumentsValue;
    if (descriptor.readOnly) {
      this.calls.set(event.toolCallId, {
        toolCallId: event.toolCallId,
        descriptor,
        executionContext,
        arguments: argumentsValue,
        state: "authorized"
      });
      return;
    }

    try {
      const authorization = await this.authorizeSideEffect({
        descriptor,
        executionContext,
        arguments: argumentsValue,
        toolCallId: event.toolCallId,
        signal
      });
      this.calls.set(event.toolCallId, {
        toolCallId: event.toolCallId,
        descriptor,
        executionContext,
        arguments: argumentsValue,
        authorization,
        state: "authorized"
      });
    } catch (error) {
      return this.rememberBlocked(
        event.toolCallId,
        descriptor,
        argumentsValue,
        blockReasonFromError(error),
        executionContext
      );
    }
  }

  async beginExecution(input: Readonly<{
    toolCallId: string;
    toolName: string;
    arguments: Readonly<Record<string, unknown>>;
    executionContext: Readonly<PiMcpExecutionContext>;
  }>): Promise<void> {
    const call = this.calls.get(input.toolCallId);
    if (
      !call
      || call.state !== "authorized"
      || call.descriptor.name !== input.toolName
      || canonicalJsonStringify(call.arguments) !== canonicalJsonStringify(input.arguments)
      || !sameExecutionContext(call.executionContext, input.executionContext)
    ) {
      throw codedError("authorization_failed");
    }
    if (!await this.isToolAllowed(call.descriptor, input.arguments)) throw codedError("tool_policy_blocked");
    if (call.authorization) {
      await this.requireReceipts().markEffectStarted(
        call.authorization.operationIdentity
      );
    }
    call.state = "executing";
  }

  async handleToolResult(event: ToolResultEvent): Promise<Readonly<{
    content: Array<{ type: "text"; text: string }>;
    details: Readonly<Record<string, unknown>>;
    isError: boolean;
  }>> {
    const call = this.calls.get(event.toolCallId);
    if (!call || event.toolName !== call.descriptor.name) {
      return rejectedResult(event.toolCallId, "authorization_failed");
    }
    this.calls.delete(event.toolCallId);

    if (call.state === "blocked") {
      return rejectedResult(event.toolCallId, call.blockReason ?? "authorization_failed", call);
    }
    if (call.state !== "executing") {
      return rejectedResult(event.toolCallId, "authorization_failed", call);
    }

    const adapterDetails = mcpAdapterDetails(event.details, call.descriptor);
    const adapterFailed = event.isError || adapterDetails.status === "failed";
    if (!call.authorization) {
      return await this.finalizeReadResult(call, event, adapterDetails, adapterFailed);
    }
    return await this.finalizeSideEffectResult(call, event, adapterDetails, adapterFailed);
  }

  private async authorizeSideEffect(input: {
    descriptor: Readonly<PiMcpToolSecurityDescriptor>;
    executionContext: Readonly<PiMcpExecutionContext>;
    arguments: Readonly<Record<string, unknown>>;
    toolCallId: string;
    signal: AbortSignal | undefined;
  }): Promise<Readonly<WriteToolAuthorizationContext>> {
    const approvals = this.requireApprovals();
    const receipts = this.requireReceipts();
    const confirmation = this.confirmation;
    if (!confirmation || !this.userId?.trim() || !this.deviceId?.trim()) {
      throw codedError("authorization_failed");
    }
    if (input.executionContext.vaultId !== approvals.vaultId) {
      throw codedError("authorization_failed");
    }
    if (input.signal?.aborted) throw codedError("approval_cancelled");

    const issuedAt = this.now();
    const normalizedArguments = normalizeJsonValue(input.arguments);
    const contract: ApprovalOperationContract = Object.freeze({
      productRunId: input.executionContext.productRunId,
      toolCallId: input.toolCallId,
      conversationId: input.executionContext.conversationId,
      piSessionId: input.executionContext.piSessionId,
      userId: this.userId,
      vaultId: input.executionContext.vaultId,
      deviceId: this.deviceId,
      toolId: input.descriptor.approvalToolId,
      toolVersion: MCP_TOOL_VERSION,
      policyVersion: MCP_POLICY_VERSION,
      normalizedArguments,
      resolvedTarget: normalizeJsonValue({
        kind: "mcp_tool",
        resourceId: input.descriptor.resourceId,
        resourceName: input.descriptor.resourceName,
        toolName: input.descriptor.toolName
      }),
      targetVersion: mcpTargetVersion(input.descriptor, input.arguments),
      preview: normalizeJsonValue({
        server: input.descriptor.resourceName,
        tool: input.descriptor.toolName,
        destructive: input.descriptor.destructive,
        arguments: normalizedArguments
      })
    });
    const ticket = await approvals.issue({
      ...contract,
      issuedAt,
      expiresAt: issuedAt + MCP_APPROVAL_TTL_MS
    });
    let accepted = false;
    try {
      accepted = await confirmation.confirm({
        requestId: ticket.ticketId,
        conversationId: ticket.conversationId,
        piSessionId: ticket.piSessionId,
        productRunId: ticket.productRunId,
        toolCallId: ticket.toolCallId,
        resourceName: input.descriptor.resourceName,
        toolName: input.descriptor.toolName,
        destructive: input.descriptor.destructive,
        arguments: normalizedArguments,
        target: ticket.resolvedTarget,
        preview: ticket.preview,
        signal: input.signal
      });
    } catch {
      await resolvePendingTicket(approvals, ticket, "cancelled");
      throw codedError("approval_cancelled");
    }
    if (!accepted || input.signal?.aborted) {
      const resolution = input.signal?.aborted ? "cancelled" : "denied";
      await resolvePendingTicket(approvals, ticket, resolution);
      throw codedError(resolution === "cancelled" ? "approval_cancelled" : "approval_denied");
    }
    const authorization = await approvals.consume({
      ticketId: ticket.ticketId,
      operationIdentity: ticket.operationIdentity,
      contract
    });
    await receipts.beginAuthorizedOperation(authorization);
    return authorization;
  }

  private async finalizeReadResult(
    call: AuthorizedMcpToolCall,
    event: ToolResultEvent,
    adapterDetails: Readonly<PiMcpToolDetails>,
    failed: boolean
  ) {
    try {
      const content = await secureMcpContent({
        descriptor: call.descriptor,
        value: textFromToolContent(event.content),
        effectType: "read",
        egress: this.egress
      });
      return Object.freeze({
        content: [{ type: "text" as const, text: content }],
        details: finalDetails(call, adapterDetails, failed ? "failed" : "completed"),
        isError: failed
      });
    } catch {
      return rejectedResult(event.toolCallId, "tool_result_rejected", call);
    }
  }

  private async finalizeSideEffectResult(
    call: AuthorizedMcpToolCall,
    event: ToolResultEvent,
    adapterDetails: Readonly<PiMcpToolDetails>,
    adapterFailed: boolean
  ) {
    const authorization = call.authorization!;
    const readbackRequired = Boolean(call.descriptor.readback);
    const readbackVerified = readbackRequired && adapterDetails.readbackVerified === true;
    const protocolCompleted = adapterDetails.protocolCompleted === true;
    const completed = !adapterFailed
      && protocolCompleted
      && (!readbackRequired || readbackVerified);
    const status = completed ? "completed" as const : "uncertain" as const;
    try {
      await this.requireReceipts().markEffectCompleted(authorization.operationIdentity);
      const checkedAt = this.now();
      await this.requireReceipts().persistReceipt({
        operationIdentity: authorization.operationIdentity,
        status,
        safeSummary: normalizeJsonValue({
          source: "echoink-mcp",
          resourceId: call.descriptor.resourceId,
          toolName: call.descriptor.toolName,
          protocolCompleted,
          readbackRequired,
          readbackVerified
        }),
        readback: {
          checkedAt,
          readbackVerified,
          observedTargetVersion: normalizeJsonValue({
            protocolCompleted,
            readbackRequired,
            readbackVerified
          }),
          safeSummary: normalizeJsonValue(readbackRequired
            ? (readbackVerified ? "MCP Readback 已验证" : "MCP Readback 未能验证")
            : "该 MCP Tool 未声明可靠 Readback；仅确认协议调用完成")
        }
      });
      const rawValue = textFromToolContent(event.content);
      const modelValue = completed
        ? rawValue
        : {
            status: "uncertain",
            message: "MCP 副作用的最终结果尚不确定，请勿自动重试。",
            result: rawValue
          };
      const content = await secureMcpContent({
        descriptor: call.descriptor,
        value: modelValue,
        effectType: "user_write",
        egress: this.egress
      });
      return Object.freeze({
        content: [{ type: "text" as const, text: content }],
        details: finalDetails(call, adapterDetails, status),
        isError: !completed
      });
    } catch {
      return Object.freeze({
        content: [{
          type: "text" as const,
          text: "MCP 副作用已开始，但 Receipt 尚未完成；结果不确定，请勿自动重试。"
        }],
        details: finalDetails(call, adapterDetails, "uncertain"),
        isError: true
      });
    }
  }

  private rememberBlocked(
    toolCallId: string,
    descriptor: Readonly<PiMcpToolSecurityDescriptor>,
    argumentsValue: Readonly<Record<string, unknown>>,
    reason: McpToolBlockReason,
    executionContext?: Readonly<PiMcpExecutionContext>
  ): Readonly<{ block: true; reason: McpToolBlockReason }> {
    this.calls.set(toolCallId, {
      toolCallId,
      descriptor,
      executionContext: executionContext ?? emptyExecutionContext(),
      arguments: argumentsValue,
      state: "blocked",
      blockReason: reason
    });
    return block(reason);
  }

  private requireApprovals(): FileApprovalTicketStore {
    if (!this.approvals) throw codedError("authorization_failed");
    return this.approvals;
  }

  private requireReceipts(): FileDomainReceiptStore {
    if (!this.receipts) throw codedError("authorization_failed");
    return this.receipts;
  }
}

export function createPiMcpToolSecurity(options: ConstructorParameters<typeof PiMcpToolSecurity>[0]): PiMcpToolSecurity {
  return new PiMcpToolSecurity(options);
}

function normalizeMcpToolInput(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  try {
    const normalized = JSON.parse(JSON.stringify(value)) as unknown;
    return normalized && typeof normalized === "object" && !Array.isArray(normalized)
      ? normalized as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function freezeDescriptor(value: Readonly<PiMcpToolSecurityDescriptor>): Readonly<PiMcpToolSecurityDescriptor> {
  if (
    !value.name?.trim()
    || !value.resourceId?.trim()
    || !value.resourceName?.trim()
    || !value.toolName?.trim()
    || !value.approvalToolId?.trim()
    || !/^sha256:[a-f0-9]{64}$/u.test(value.contractFingerprint)
    || typeof value.readOnly !== "boolean"
    || typeof value.destructive !== "boolean"
  ) throw new TypeError("pi_mcp_tool_security_invalid_registry");
  return Object.freeze({
    ...value,
    ...(value.readback ? { readback: structuredClone(value.readback) } : {})
  });
}

function freezeExecutionContext(value: Readonly<PiMcpExecutionContext>): Readonly<PiMcpExecutionContext> {
  const context = {
    conversationId: value.conversationId.trim(),
    piSessionId: value.piSessionId.trim(),
    productRunId: value.productRunId.trim(),
    vaultId: value.vaultId.trim()
  };
  if (Object.values(context).some((part) => !part)) {
    throw new TypeError("pi_mcp_execution_context_invalid");
  }
  return Object.freeze(context);
}

function sameExecutionContext(
  left: Readonly<PiMcpExecutionContext>,
  right: Readonly<PiMcpExecutionContext>
): boolean {
  try {
    return canonicalJsonStringify(freezeExecutionContext(left))
      === canonicalJsonStringify(freezeExecutionContext(right));
  } catch {
    return false;
  }
}

function emptyExecutionContext(): Readonly<PiMcpExecutionContext> {
  return Object.freeze({ conversationId: "", piSessionId: "", productRunId: "", vaultId: "" });
}

function mcpTargetVersion(
  descriptor: Readonly<PiMcpToolSecurityDescriptor>,
  argumentsValue: Readonly<Record<string, unknown>>
): JsonValue {
  const readback = descriptor.readback;
  if (!readback) return normalizeJsonValue({ readbackRequired: false });
  const readbackArguments = Object.fromEntries(
    Object.entries(readback.argumentMap).map(([targetKey, sourceKey]) =>
      [targetKey, argumentsValue[sourceKey]])
  );
  const assertionArguments = Object.fromEntries(
    readback.assertions.map((assertion) =>
      [assertion.argumentKey, argumentsValue[assertion.argumentKey]])
  );
  return normalizeJsonValue({
    readbackRequired: true,
    readbackContract: readback,
    readbackArguments,
    assertionArguments
  });
}

function mcpAdapterDetails(
  value: unknown,
  descriptor: Readonly<PiMcpToolSecurityDescriptor>
): Readonly<PiMcpToolDetails> {
  const object = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const status = object.status === "completed" || object.status === "failed"
    ? object.status
    : "failed";
  return Object.freeze({
    source: "echoink-mcp" as const,
    resourceId: descriptor.resourceId,
    resourceName: descriptor.resourceName,
    toolName: descriptor.toolName,
    status,
    effectType: descriptor.readOnly ? "read" as const : "user_write" as const,
    readbackRequired: Boolean(descriptor.readback),
    ...(typeof object.readbackVerified === "boolean"
      ? { readbackVerified: object.readbackVerified }
      : {}),
    ...(typeof object.protocolCompleted === "boolean"
      ? { protocolCompleted: object.protocolCompleted }
      : {}),
    ...(typeof object.errorCode === "string" ? { errorCode: object.errorCode } : {})
  });
}

function finalDetails(
  call: AuthorizedMcpToolCall,
  adapter: Readonly<PiMcpToolDetails>,
  status: "completed" | "failed" | "uncertain"
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    source: "echoink-mcp",
    resourceId: call.descriptor.resourceId,
    resourceName: call.descriptor.resourceName,
    toolName: call.descriptor.toolName,
    toolCallId: call.toolCallId,
    productRunId: call.executionContext.productRunId,
    piSessionId: call.executionContext.piSessionId,
    status,
    effectType: call.descriptor.readOnly ? "read" : "user_write",
    readbackRequired: Boolean(call.descriptor.readback),
    ...(adapter.readbackVerified === undefined ? {} : { readbackVerified: adapter.readbackVerified }),
    ...(adapter.protocolCompleted === undefined ? {} : { protocolCompleted: adapter.protocolCompleted }),
    ...(adapter.errorCode ? { errorCode: adapter.errorCode } : {}),
    ...(call.authorization ? {
      authorizationId: call.authorization.ticketId,
      operationIdentity: call.authorization.operationIdentity
    } : {})
  });
}

async function secureMcpContent(input: {
  descriptor: Readonly<PiMcpToolSecurityDescriptor>;
  value: unknown;
  effectType: "read" | "user_write";
  egress: VaultToolResultEgressPort;
}): Promise<string> {
  return (await secureVaultToolResult({
    toolId: input.descriptor.name,
    effectType: input.effectType,
    egressPolicy: "echoink-configured-provider-v1",
    value: input.value,
    sizeLimitBytes: MAX_MCP_RESULT_BYTES,
    egress: input.egress
  })).text;
}

function textFromToolContent(content: unknown): string {
  if (!Array.isArray(content)) return "null";
  const text = content.flatMap((part) =>
    part && typeof part === "object"
      && (part as { type?: unknown }).type === "text"
      && typeof (part as { text?: unknown }).text === "string"
      ? [(part as { text: string }).text]
      : []
  ).join("\n");
  return text || "null";
}

function block(reason: McpToolBlockReason): Readonly<{ block: true; reason: McpToolBlockReason }> {
  return Object.freeze({ block: true, reason });
}

function rejectedResult(
  toolCallId: string,
  reason: string,
  call?: AuthorizedMcpToolCall
): Readonly<{
  content: Array<{ type: "text"; text: string }>;
  details: Readonly<Record<string, unknown>>;
  isError: true;
}> {
  return Object.freeze({
    content: [{ type: "text" as const, text: reason }],
    details: Object.freeze({
      source: "echoink-mcp",
      toolCallId,
      ...(call ? {
        resourceId: call.descriptor.resourceId,
        resourceName: call.descriptor.resourceName,
        toolName: call.descriptor.toolName,
        productRunId: call.executionContext.productRunId,
        piSessionId: call.executionContext.piSessionId
      } : {}),
      status: "failed"
    }),
    isError: true
  });
}

function codedError(code: McpToolBlockReason): Error & { code: McpToolBlockReason } {
  const error = new Error(code) as Error & { code: McpToolBlockReason };
  error.code = code;
  return error;
}

function blockReasonFromError(error: unknown): McpToolBlockReason {
  const code = error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : "";
  return code === "approval_denied"
    || code === "approval_cancelled"
    || code === "tool_policy_blocked"
    || code === "authorization_failed"
    ? code
    : "authorization_failed";
}

async function resolvePendingTicket(
  approvals: FileApprovalTicketStore,
  ticket: Readonly<EchoInkApprovalTicket>,
  resolution: "denied" | "cancelled"
): Promise<void> {
  await approvals.resolve({
    productRunId: ticket.productRunId,
    toolCallId: ticket.toolCallId,
    ticketId: ticket.ticketId,
    resolution
  });
}
