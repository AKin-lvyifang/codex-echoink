import { getDesktopCrypto } from "../../platform/desktop-crypto";
import {
  defineTool,
  type AgentToolResult,
  type ToolDefinition
} from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "@earendil-works/pi-ai";
import { buildCallableMcpToolCatalog } from "../../resources/mcp-tool-catalog";
import { mcpToolContractFingerprint } from "../../resources/mcp-connections";
import type {
  EchoInkMcpConnectionRecords,
  EchoInkMcpToolReadbackContract,
  EchoInkResource
} from "../../resources/types";
import { createMcpApprovalToolId, type McpApprovalToolId } from "./tool-authorization";
import { redactEchoInkLocalSecretsV1 } from "./vault-tool-result-safety";

const { createHash } = getDesktopCrypto();

const DEFAULT_MCP_TIMEOUT_MS = 30_000;
const MAX_PI_TOOL_NAME_LENGTH = 64;
const MAX_PROGRESS_CHARS = 2_000;

export interface PiMcpExecutionContext {
  conversationId: string;
  piSessionId: string;
  productRunId: string;
  vaultId: string;
}

export interface PiMcpDomainToolCallInput {
  resourceId: string;
  resourceName: string;
  backend: "pi-native";
  toolName: string;
  toolCallId: string;
  arguments: Record<string, unknown>;
  timeoutMs: number;
  signal: AbortSignal;
  executionContext: Readonly<PiMcpExecutionContext>;
  invocationKind?: "model_tool" | "readback";
  onProgress(update: unknown): void;
}

export interface PiMcpCustomToolAdapterOptions {
  loadCatalog(): Promise<EchoInkResource[]>;
  connections(): EchoInkMcpConnectionRecords;
  listTools(
    resourceId: string,
    timeoutMs: number,
    signal: AbortSignal
  ): Promise<unknown[]>;
  /** Domain/Broker invocation. A side effect is called once; Readback is separate. */
  callTool(input: PiMcpDomainToolCallInput): Promise<unknown>;
  /** Every broker invocation, including hidden readback, rechecks current policy. */
  assertInvocationAllowed?(input: PiMcpDomainToolCallInput): Promise<void>;
  /** Re-read for every execute() so a previous Conversation is never captured. */
  currentExecutionContext(): Readonly<PiMcpExecutionContext>;
  /** Shares the sole Pi Extension preflight with the Tool wrapper. */
  executionSecurity?: PiMcpExecutionSecurityPort;
  timeoutMs?: number;
}

export interface PiMcpExecutionSecurityPort {
  registerTool(descriptor: Readonly<PiMcpToolSecurityDescriptor>): void;
  beginExecution(input: Readonly<{
    toolCallId: string;
    toolName: string;
    arguments: Readonly<Record<string, unknown>>;
    executionContext: Readonly<PiMcpExecutionContext>;
  }>): Promise<void>;
}

export interface PiMcpToolDetails {
  source: "echoink-mcp";
  resourceId: string;
  resourceName: string;
  toolName: string;
  status: "running" | "completed" | "failed";
  effectType: "read" | "user_write";
  readbackRequired: boolean;
  readbackVerified?: boolean;
  protocolCompleted?: boolean;
  errorCode?: string;
  update?: unknown;
}

export interface PiMcpCustomToolSnapshot {
  readonly toolNames: readonly string[];
  readonly customTools: readonly ToolDefinition[];
  readonly toolSecurity: readonly PiMcpToolSecurityDescriptor[];
  readonly warnings: readonly string[];
}

export interface PiMcpToolSecurityDescriptor {
  readonly name: string;
  readonly resourceId: string;
  readonly resourceName: string;
  readonly toolName: string;
  readonly readOnly: boolean;
  readonly destructive: boolean;
  readonly approvalToolId: McpApprovalToolId;
  readonly contractFingerprint: string;
  readonly inputSchema?: Readonly<Record<string, unknown>>;
  readonly readback?: EchoInkMcpToolReadbackContract;
}

/**
 * Discovers admitted EchoInk MCP Tools and normalizes them into Pi's public
 * ToolDefinition contract. It owns no Agent loop, retry loop, or transcript.
 */
export class PiMcpCustomToolAdapter {
  constructor(private readonly options: PiMcpCustomToolAdapterOptions) {}

  async discover(signal: AbortSignal): Promise<PiMcpCustomToolSnapshot> {
    throwIfAborted(signal);
    const resources = (await this.options.loadCatalog())
      .filter(isCurrentEchoInkMcpResource);
    throwIfAborted(signal);
    if (!resources.length) return emptySnapshot();
    const timeoutMs = normalizeTimeout(this.options.timeoutMs);
    const catalog = await buildCallableMcpToolCatalog({
      resources,
      connections: this.options.connections(),
      listTools: async (resource) => {
        throwIfAborted(signal);
        const listed = await this.options.listTools(resource.id, timeoutMs, signal);
        throwIfAborted(signal);
        return listed;
      }
    });
    throwIfAborted(signal);

    const names = new Set<string>();
    const toolSecurity: PiMcpToolSecurityDescriptor[] = [];
    const customTools = catalog.tools
      .sort((left, right) =>
        left.resourceId.localeCompare(right.resourceId, "en")
        || left.toolName.localeCompare(right.toolName, "en")
      )
      .map((tool) => {
        const name = piToolName(tool.resourceId, tool.toolName);
        if (names.has(name)) {
          throw new Error(`Duplicate normalized Pi MCP Tool name: ${name}`);
        }
        names.add(name);
        const descriptor: PiMcpToolSecurityDescriptor = Object.freeze({
          name,
          resourceId: tool.resourceId,
          resourceName: tool.resourceName,
          toolName: tool.toolName,
          readOnly: tool.readOnly,
          destructive: tool.destructive,
          inputSchema: Object.freeze(structuredClone(tool.inputSchema)),
          approvalToolId: createMcpApprovalToolId(tool),
          contractFingerprint: mcpToolContractFingerprint({
            ...tool,
            name: tool.toolName
          }),
          ...(tool.readback ? { readback: tool.readback } : {})
        });
        this.options.executionSecurity?.registerTool(descriptor);
        toolSecurity.push(descriptor);
        return this.createToolDefinition({
          descriptor,
          description: tool.readOnly
            ? tool.description
            : `${tool.description}${tool.description ? " " : ""}此 Tool 有副作用，执行前必须由用户确认。`,
          parameters: toolParameters(tool.inputSchema),
          timeoutMs
        });
      });
    return Object.freeze({
      toolNames: Object.freeze([...names]),
      customTools: Object.freeze(customTools),
      toolSecurity: Object.freeze(toolSecurity),
      warnings: Object.freeze([...catalog.warnings])
    });
  }

  private createToolDefinition(input: {
    descriptor: PiMcpToolSecurityDescriptor;
    description: string;
    parameters: TSchema;
    timeoutMs: number;
  }): ToolDefinition {
    const descriptor = input.descriptor;
    return defineTool({
      name: descriptor.name,
      label: `${descriptor.resourceName}: ${descriptor.toolName}`,
      description: input.description,
      parameters: input.parameters,
      executionMode: descriptor.readOnly ? "parallel" : "sequential",
      execute: async (
        toolCallId,
        params,
        signal,
        onUpdate
      ): Promise<AgentToolResult<PiMcpToolDetails>> => {
        const executionSignal = signal ?? new AbortController().signal;
        throwIfAborted(executionSignal);
        const executionContext = Object.freeze({
          ...this.options.currentExecutionContext()
        });
        const args = isRecord(params) ? params : {};
        try {
          if (!descriptor.readOnly && !this.options.executionSecurity) {
            throw securityError();
          }
          await this.options.executionSecurity?.beginExecution({
            toolCallId,
            toolName: descriptor.name,
            arguments: args,
            executionContext
          });
          throwIfAborted(executionSignal);
          const result = await this.invokeTool({
            resourceId: descriptor.resourceId,
            resourceName: descriptor.resourceName,
            backend: "pi-native",
            toolName: descriptor.toolName,
            toolCallId,
            arguments: args,
            timeoutMs: input.timeoutMs,
            signal: executionSignal,
            executionContext,
            invocationKind: "model_tool",
            onProgress: (update) => {
              throwIfAborted(executionSignal);
              onUpdate?.(toolResult(descriptor, "running", sanitizeProgress(update)));
            }
          });
          throwIfAborted(executionSignal);
          const toolReportedError = mcpToolResultIsError(result);
          const readback = descriptor.readOnly || !descriptor.readback || toolReportedError
            ? { required: false, verified: false }
            : await this.performReadback({
              descriptor,
              toolCallId,
              args,
              timeoutMs: input.timeoutMs,
              signal: executionSignal,
              executionContext
            });
          const completed = !toolReportedError && (!readback.required || readback.verified);
          return toolResult(descriptor, completed ? "completed" : "failed", result, {
            protocolCompleted: true,
            readbackRequired: Boolean(descriptor.readback),
            readbackVerified: descriptor.readback ? readback.verified : undefined,
            ...(toolReportedError ? { errorCode: "mcp_tool_reported_error" } : {}),
            ...(!toolReportedError && readback.required && !readback.verified
              ? { errorCode: "mcp_readback_unverified" }
              : {})
          });
        } catch (error) {
          if (executionSignal.aborted) throwIfAborted(executionSignal);
          return toolResult(descriptor, "failed", safeExecutionError(error), {
            protocolCompleted: false,
            readbackRequired: Boolean(descriptor.readback),
            readbackVerified: false,
            errorCode: safeExecutionErrorCode(error)
          });
        }
      }
    });
  }

  private async performReadback(input: {
    descriptor: PiMcpToolSecurityDescriptor;
    toolCallId: string;
    args: Record<string, unknown>;
    timeoutMs: number;
    signal: AbortSignal;
    executionContext: Readonly<PiMcpExecutionContext>;
  }): Promise<Readonly<{ required: true; verified: boolean }>> {
    const contract = input.descriptor.readback;
    if (!contract) return Object.freeze({ required: true, verified: false });
    const readbackArgs = buildPiMcpReadbackArguments(contract, input.args);
    try {
      const result = await this.invokeTool({
        resourceId: input.descriptor.resourceId,
        resourceName: input.descriptor.resourceName,
        backend: "pi-native",
        toolName: contract.toolName,
        toolCallId: `${input.toolCallId}:readback`,
        arguments: readbackArgs,
        timeoutMs: input.timeoutMs,
        signal: input.signal,
        executionContext: input.executionContext,
        invocationKind: "readback",
        onProgress: () => undefined
      });
      const verified = verifyPiMcpReadback(contract, input.args, result);
      return Object.freeze({ required: true, verified });
    } catch {
      return Object.freeze({ required: true, verified: false });
    }
  }

  private async invokeTool(input: PiMcpDomainToolCallInput): Promise<unknown> {
    await this.options.assertInvocationAllowed?.(input);
    return await this.options.callTool(input);
  }
}

function emptySnapshot(): PiMcpCustomToolSnapshot {
  return Object.freeze({
    toolNames: Object.freeze([]),
    customTools: Object.freeze([]),
    toolSecurity: Object.freeze([]),
    warnings: Object.freeze([])
  });
}

function toolIdentity(input: { resourceId: string; toolName: string }): string {
  return `${input.resourceId}\u0000${input.toolName}`;
}

function piToolName(resourceId: string, toolName: string): string {
  const digest = createHash("sha256")
    .update(toolIdentity({ resourceId, toolName }))
    .digest("hex")
    .slice(0, 10);
  const normalized = `${resourceId}_${toolName}`
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
  const suffix = `_${digest}`;
  const prefix = "echoink_mcp_";
  const bodyLength = MAX_PI_TOOL_NAME_LENGTH - prefix.length - suffix.length;
  const body = (normalized || "tool").slice(0, bodyLength);
  return `${prefix}${body}${suffix}`;
}

function isCurrentEchoInkMcpResource(resource: EchoInkResource): boolean {
  return resource.kind === "mcp-server";
}

function toolParameters(inputSchema: Record<string, unknown>): TSchema {
  return Type.Unsafe<Record<string, unknown>>(JSON.parse(JSON.stringify(inputSchema)) as Record<string, unknown>);
}

function toolResult(
  descriptor: PiMcpToolSecurityDescriptor,
  status: PiMcpToolDetails["status"],
  value: unknown,
  options: {
    protocolCompleted?: boolean;
    readbackRequired?: boolean;
    readbackVerified?: boolean;
    errorCode?: string;
  } = {}
): AgentToolResult<PiMcpToolDetails> {
  return {
    content: [{ type: "text", text: jsonText(value) }],
    details: Object.freeze({
      source: "echoink-mcp" as const,
      resourceId: descriptor.resourceId,
      resourceName: descriptor.resourceName,
      toolName: descriptor.toolName,
      status,
      effectType: descriptor.readOnly ? "read" as const : "user_write" as const,
      readbackRequired: options.readbackRequired ?? Boolean(descriptor.readback),
      ...(options.readbackVerified === undefined ? {} : { readbackVerified: options.readbackVerified }),
      ...(options.protocolCompleted === undefined ? {} : { protocolCompleted: options.protocolCompleted }),
      ...(options.errorCode ? { errorCode: options.errorCode } : {}),
      ...(status === "running" ? { update: value } : {})
    })
  };
}

export function buildPiMcpReadbackArguments(
  contract: Readonly<EchoInkMcpToolReadbackContract>,
  argumentsValue: Readonly<Record<string, unknown>>
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(contract.argumentMap).map(([targetKey, sourceKey]) =>
      [targetKey, argumentsValue[sourceKey]])
  );
}

export function verifyPiMcpReadback(
  contract: Readonly<EchoInkMcpToolReadbackContract>,
  argumentsValue: Readonly<Record<string, unknown>>,
  result: unknown
): boolean {
  return contract.assertions.every((assertion) =>
    deepEqualJson(
      readPath(result, assertion.resultPath),
      argumentsValue[assertion.argumentKey]
    ));
}

function normalizeTimeout(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : DEFAULT_MCP_TIMEOUT_MS;
}

function jsonText(value: unknown): string {
  const serialized = JSON.stringify(value);
  return serialized === undefined ? "null" : serialized;
}

function sanitizeProgress(value: unknown): unknown {
  const text = redactEchoInkLocalSecretsV1(jsonText(value));
  const bounded = text.length <= MAX_PROGRESS_CHARS
    ? text
    : `${text.slice(0, MAX_PROGRESS_CHARS - 14)}…[TRUNCATED]`;
  try {
    return JSON.parse(bounded);
  } catch {
    return bounded;
  }
}

function safeExecutionError(error: unknown): Readonly<{ error: string }> {
  return Object.freeze({ error: safeExecutionErrorCode(error) });
}

function safeExecutionErrorCode(error: unknown): string {
  const raw = error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : error instanceof Error && error.name === "AbortError"
      ? "operation_cancelled"
      : "mcp_call_failed";
  return /^[a-z0-9_-]{1,80}$/u.test(raw) ? raw : "mcp_call_failed";
}

function mcpToolResultIsError(value: unknown): boolean {
  return isRecord(value) && value.isError === true;
}

function securityError(): Error & { code: string } {
  const error = new Error("MCP side effect has no execution security port") as Error & { code: string };
  error.code = "authorization_failed";
  return error;
}

function readPath(value: unknown, path: string): unknown {
  return path.split(".").filter(Boolean).reduce<unknown>((current, key) =>
    isRecord(current) ? current[key] : undefined, value);
}

function deepEqualJson(left: unknown, right: unknown): boolean {
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  const error = new Error("EchoInk Pi MCP operation aborted.");
  error.name = "AbortError";
  throw error;
}
