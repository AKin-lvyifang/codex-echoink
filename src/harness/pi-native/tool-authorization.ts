import { createHash } from "node:crypto";
import { mkdir, readdir } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import * as path from "node:path";
import {
  PI_NATIVE_FILE_SCHEMA_VERSION,
  PiNativeFileStoreError,
  atomicWriteJsonFile,
  ensurePiNativeVaultFileLayout,
  isNodeErrorWithCode,
  piNativeVaultFileLayout,
  readJsonFileIfPresent,
  requireNonEmptyString,
  requireTimestamp,
  serializePiNativeFileWrite,
  stablePathToken,
  type PiNativeVaultFileLayout
} from "./file-store-utils";

export const APPROVAL_WRITE_TOOL_IDS = [
  "note_create",
  "note_update",
  "metadata_update",
  "note_move",
  "note_delete"
] as const;

/** Phase 3 reuses the same exact, single-consume Ticket store for its batch. */
export const KNOWLEDGE_MAINTENANCE_APPROVAL_TOOL_ID =
  "knowledge_maintain" as const;
export const APPROVAL_TOOL_IDS = [
  ...APPROVAL_WRITE_TOOL_IDS,
  KNOWLEDGE_MAINTENANCE_APPROVAL_TOOL_ID,
  "obsidian_cli"
] as const;

export type McpApprovalToolId = `echoink_mcp_${string}`;

export const AUTO_ALLOWED_READ_TOOL_IDS = [
  "vault_search",
  "note_read"
] as const;

export type ApprovalWriteToolId = typeof APPROVAL_WRITE_TOOL_IDS[number];
export type SideEffectApprovalToolId = ApprovalWriteToolId | McpApprovalToolId | "obsidian_cli";
export type ApprovalToolId = typeof APPROVAL_TOOL_IDS[number] | McpApprovalToolId;
export type AutoAllowedReadToolId = typeof AUTO_ALLOWED_READ_TOOL_IDS[number];
export type AuthorizedVaultToolId =
  | ApprovalWriteToolId
  | AutoAllowedReadToolId;

export const APPROVAL_TICKET_STATUSES = [
  "pending",
  "approved",
  "denied",
  "expired",
  "cancelled"
] as const;

export type ApprovalTicketStatus = typeof APPROVAL_TICKET_STATUSES[number];

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export interface ApprovalOperationContract {
  productRunId: string;
  toolCallId: string;
  conversationId: string;
  piSessionId: string;
  userId: string;
  vaultId: string;
  deviceId: string;
  toolId: ApprovalToolId;
  toolVersion: string;
  policyVersion: string;
  normalizedArguments: JsonValue;
  resolvedTarget: JsonValue;
  targetVersion: JsonValue;
  preview: JsonValue;
}

export interface ApprovalTicketIssueInput extends ApprovalOperationContract {
  issuedAt: number;
  expiresAt: number;
}

export interface EchoInkApprovalTicket extends ApprovalTicketIssueInput {
  ticketId: string;
  operationIdentity: string;
}

/**
 * The immutable capability handed from Extension `tool_call` to the matching
 * controlled Tool wrapper. A wrapper must not infer any of these fields from
 * model arguments or a previously active Conversation.
 */
export interface WriteToolAuthorizationContext extends EchoInkApprovalTicket {
  authorizationKind: "approval_ticket";
  effectType: "user_write";
  consumedAt: number;
}

export interface ReadToolAuthorizationInput {
  productRunId: string;
  toolCallId: string;
  conversationId: string;
  piSessionId: string;
  userId: string;
  vaultId: string;
  deviceId: string;
  toolId: AutoAllowedReadToolId;
  toolVersion: string;
  policyVersion: string;
  normalizedArguments: JsonValue;
  resolvedTarget: JsonValue;
  targetVersion: JsonValue;
  authorizedAt: number;
}

export interface ReadToolAuthorizationContext extends ReadToolAuthorizationInput {
  authorizationKind: "policy_allow";
  effectType: "read";
  authorizationId: string;
}

export type ToolAuthorizationContext =
  | ReadToolAuthorizationContext
  | WriteToolAuthorizationContext;

export interface ConsumeApprovalTicketInput {
  ticketId: string;
  operationIdentity: string;
  contract: ApprovalOperationContract;
}

export interface ApprovalTicketState {
  ticket: Readonly<EchoInkApprovalTicket>;
  status: ApprovalTicketStatus;
  resolvedAt: number | null;
  consumedAt: number | null;
}

export interface ResolveApprovalTicketInput {
  productRunId: string;
  toolCallId: string;
  ticketId: string;
  resolution: "denied" | "cancelled";
}

export interface ApprovalTicketListOptions {
  conversationId?: string;
  productRunId?: string;
  statuses?: readonly ApprovalTicketStatus[];
}

export interface FileApprovalTicketStoreOptions {
  storageRootPath: string;
  vaultId: string;
  now?: () => number;
}

interface ApprovalTicketDocumentV1 {
  schemaVersion: typeof PI_NATIVE_FILE_SCHEMA_VERSION;
  vaultId: string;
  ticket: EchoInkApprovalTicket;
  status: ApprovalTicketStatus;
  resolvedAt: number | null;
  consumedAt: number | null;
}

const APPROVAL_IDS = new Set<string>(APPROVAL_TOOL_IDS);
const MCP_APPROVAL_TOOL_ID_PATTERN = /^echoink_mcp_[a-f0-9]{64}$/u;
const READ_TOOL_IDS = new Set<string>(AUTO_ALLOWED_READ_TOOL_IDS);
const APPROVAL_STATUSES = new Set<string>(APPROVAL_TICKET_STATUSES);
const CONTRACT_KEYS = [
  "productRunId",
  "toolCallId",
  "conversationId",
  "piSessionId",
  "userId",
  "vaultId",
  "deviceId",
  "toolId",
  "toolVersion",
  "policyVersion",
  "normalizedArguments",
  "resolvedTarget",
  "targetVersion",
  "preview"
] as const;
const ISSUE_KEYS = [...CONTRACT_KEYS, "issuedAt", "expiresAt"] as const;
const TICKET_KEYS = [
  ...ISSUE_KEYS,
  "ticketId",
  "operationIdentity"
] as const;
const WRITE_AUTHORIZATION_CONTEXT_KEYS = [
  ...TICKET_KEYS,
  "authorizationKind",
  "effectType",
  "consumedAt"
] as const;
const READ_AUTHORIZATION_INPUT_KEYS = [
  "productRunId",
  "toolCallId",
  "conversationId",
  "piSessionId",
  "userId",
  "vaultId",
  "deviceId",
  "toolId",
  "toolVersion",
  "policyVersion",
  "normalizedArguments",
  "resolvedTarget",
  "targetVersion",
  "authorizedAt"
] as const;
const READ_AUTHORIZATION_CONTEXT_KEYS = [
  ...READ_AUTHORIZATION_INPUT_KEYS,
  "authorizationKind",
  "effectType",
  "authorizationId"
] as const;

/**
 * Per-Vault durable Approval Ticket store.
 *
 * The file key is the ProductRun/Tool Call pair, so there can be only one
 * current Ticket for that pair. Re-issuing an unconsumed preview replaces the
 * file atomically and makes the former ticketId unusable. A consumed Ticket is
 * never replaceable.
 */
export class FileApprovalTicketStore {
  readonly storageRootPath: string;
  readonly vaultId: string;
  readonly rootPath: string;

  private readonly layout: PiNativeVaultFileLayout;
  private readonly now: () => number;

  constructor(options: FileApprovalTicketStoreOptions) {
    this.vaultId = requireNonEmptyString(options.vaultId, "vaultId");
    this.layout = piNativeVaultFileLayout(
      options.storageRootPath,
      this.vaultId
    );
    this.storageRootPath = this.layout.storageRootPath;
    this.rootPath = path.join(
      this.layout.vaultRootPath,
      "tool-domain",
      "approval-tickets"
    );
    this.now = options.now ?? Date.now;
  }

  async initialize(): Promise<void> {
    await serializePiNativeFileWrite(this.storageRootPath, async () => {
      await ensurePiNativeVaultFileLayout(this.layout);
      await mkdir(this.rootPath, { recursive: true, mode: 0o700 });
    });
  }

  async issue(
    input: Readonly<ApprovalTicketIssueInput>
  ): Promise<Readonly<EchoInkApprovalTicket>> {
    const normalized = normalizeApprovalTicketIssueInput(input);
    if (normalized.vaultId !== this.vaultId) {
      throw new PiNativeFileStoreError(
        "mapping-conflict",
        "Approval Ticket 的 Vault 与当前 Store 不匹配"
      );
    }
    const observedAt = requireTimestamp(this.now(), "approval.now");
    if (normalized.issuedAt > observedAt) {
      throw new PiNativeFileStoreError(
        "invalid-input",
        "Approval Ticket 的 issuedAt 不能晚于当前时间"
      );
    }
    if (normalized.expiresAt <= observedAt) {
      throw new PiNativeFileStoreError(
        "invalid-transition",
        "不能签发已经过期的 Approval Ticket"
      );
    }
    const candidate = createApprovalTicket(normalized);

    return await serializePiNativeFileWrite(
      this.storageRootPath,
      async () => {
        await ensurePiNativeVaultFileLayout(this.layout);
        await mkdir(this.rootPath, { recursive: true, mode: 0o700 });
        const existingValue = await this.readState(
          candidate.productRunId,
          candidate.toolCallId
        );
        const existing = existingValue
          ? await this.expireIfNeeded(existingValue)
          : null;
        if (existing && existing.status !== "pending") {
          throw new PiNativeFileStoreError(
            "invalid-transition",
            `Tool Call ${candidate.toolCallId} 的 Approval Ticket 已进入 ${existing.status}，不能替换`
          );
        }
        if (existing && isDeepStrictEqual(existing.ticket, candidate)) {
          return cloneAndFreeze(candidate);
        }
        const readback = await this.writeDocument({
          schemaVersion: PI_NATIVE_FILE_SCHEMA_VERSION,
          vaultId: this.vaultId,
          ticket: candidate,
          status: "pending",
          resolvedAt: null,
          consumedAt: null
        });
        return cloneAndFreeze(readback.ticket);
      }
    );
  }

  async get(
    productRunId: string,
    toolCallId: string
  ): Promise<Readonly<ApprovalTicketState> | null> {
    const normalizedProductRunId = requireNonEmptyString(
      productRunId,
      "productRunId"
    );
    const normalizedToolCallId = requireNonEmptyString(toolCallId, "toolCallId");
    return await serializePiNativeFileWrite(
      this.storageRootPath,
      async () => {
        const state = await this.readState(
          normalizedProductRunId,
          normalizedToolCallId
        );
        if (!state) return null;
        return freezeTicketState(await this.expireIfNeeded(state));
      }
    );
  }

  async listViews(
    options: Readonly<ApprovalTicketListOptions> = {}
  ): Promise<Readonly<ApprovalTicketState>[]> {
    const conversationId = options.conversationId === undefined
      ? undefined
      : requireNonEmptyString(options.conversationId, "conversationId");
    const productRunId = options.productRunId === undefined
      ? undefined
      : requireNonEmptyString(options.productRunId, "productRunId");
    const statuses = options.statuses === undefined
      ? null
      : new Set(options.statuses.map(requireApprovalTicketStatus));
    return await serializePiNativeFileWrite(
      this.storageRootPath,
      async () => {
        let names: string[];
        try {
          names = await readdir(this.rootPath);
        } catch (error) {
          if (isNodeErrorWithCode(error, "ENOENT")) return [];
          throw error;
        }
        const states: ApprovalTicketState[] = [];
        for (const name of names.sort()) {
          if (!name.endsWith(".json")) continue;
          const value = await readJsonFileIfPresent(
            path.join(this.rootPath, name),
            `Approval Ticket view ${name}`
          );
          if (value === null) continue;
          const document = parseApprovalTicketDocument(value, this.vaultId);
          if (
            name !== path.basename(this.ticketFilePath(
              document.ticket.productRunId,
              document.ticket.toolCallId
            ))
          ) {
            throw new PiNativeFileStoreError(
              "store-corrupt",
              `Approval Ticket view ${name} 的文件名与身份不匹配`
            );
          }
          const state = await this.expireIfNeeded({
            ticket: document.ticket,
            status: document.status,
            resolvedAt: document.resolvedAt,
            consumedAt: document.consumedAt
          });
          if (
            (conversationId === undefined
              || state.ticket.conversationId === conversationId)
            && (productRunId === undefined
              || state.ticket.productRunId === productRunId)
            && (!statuses || statuses.has(state.status))
          ) {
            states.push(state);
          }
        }
        return states
          .sort((left, right) =>
            left.ticket.issuedAt - right.ticket.issuedAt
            || left.ticket.toolCallId.localeCompare(right.ticket.toolCallId)
          )
          .map(freezeTicketState);
      }
    );
  }

  async listPending(
    options: Omit<ApprovalTicketListOptions, "statuses"> = {}
  ): Promise<Readonly<ApprovalTicketState>[]> {
    return await this.listViews({ ...options, statuses: ["pending"] });
  }

  async resolve(
    input: Readonly<ResolveApprovalTicketInput>
  ): Promise<Readonly<ApprovalTicketState>> {
    const normalized = normalizeResolveApprovalTicketInput(input);
    return await serializePiNativeFileWrite(
      this.storageRootPath,
      async () => {
        const currentValue = await this.readState(
          normalized.productRunId,
          normalized.toolCallId
        );
        if (!currentValue) {
          throw new PiNativeFileStoreError(
            "not-found",
            "当前 ProductRun / Tool Call 没有可处理的 Approval Ticket"
          );
        }
        const current = await this.expireIfNeeded(currentValue);
        if (current.ticket.ticketId !== normalized.ticketId) {
          throw approvalMismatch("ticketId 已失效或已被新预览替换");
        }
        if (current.status !== "pending") {
          throw new PiNativeFileStoreError(
            "invalid-transition",
            `Approval Ticket ${current.ticket.ticketId} 已进入 ${current.status}`
          );
        }
        const resolvedAt = requireTimestamp(this.now(), "approval.resolvedAt");
        if (resolvedAt >= current.ticket.expiresAt) {
          await this.writeDocument({
            schemaVersion: PI_NATIVE_FILE_SCHEMA_VERSION,
            vaultId: this.vaultId,
            ticket: current.ticket,
            status: "expired",
            resolvedAt,
            consumedAt: null
          });
          throw new PiNativeFileStoreError(
            "invalid-transition",
            `Approval Ticket ${current.ticket.ticketId} 已过期`
          );
        }
        const document = await this.writeDocument({
          schemaVersion: PI_NATIVE_FILE_SCHEMA_VERSION,
          vaultId: this.vaultId,
          ticket: current.ticket,
          status: normalized.resolution,
          resolvedAt,
          consumedAt: null
        });
        return freezeTicketState(ticketStateFromDocument(document));
      }
    );
  }

  async consume(
    input: Readonly<ConsumeApprovalTicketInput>
  ): Promise<Readonly<WriteToolAuthorizationContext>> {
    const normalizedInput = normalizeConsumeApprovalTicketInput(input);
    const expectedOperationIdentity = createOperationIdentity(
      normalizedInput.contract
    );
    if (normalizedInput.operationIdentity !== expectedOperationIdentity) {
      throw approvalMismatch("operationIdentity 与当前授权合同不匹配");
    }

    return await serializePiNativeFileWrite(
      this.storageRootPath,
      async () => {
        const current = await this.readState(
          normalizedInput.contract.productRunId,
          normalizedInput.contract.toolCallId
        );
        if (!current) {
          throw new PiNativeFileStoreError(
            "not-found",
            "当前 ProductRun / Tool Call 没有可消费的 Approval Ticket"
          );
        }
        if (current.status !== "pending") {
          throw new PiNativeFileStoreError(
            "invalid-transition",
            `Approval Ticket ${current.ticket.ticketId} 已进入 ${current.status}`
          );
        }
        if (current.ticket.ticketId !== normalizedInput.ticketId) {
          throw approvalMismatch("ticketId 已失效或已被新预览替换");
        }
        if (current.ticket.operationIdentity !== expectedOperationIdentity) {
          throw approvalMismatch("Ticket 的 operationIdentity 已失效");
        }
        if (!isDeepStrictEqual(
          approvalContractFromTicket(current.ticket),
          normalizedInput.contract
        )) {
          throw approvalMismatch("Ticket 的参数、目标、版本、身份或预览已变化");
        }

        const consumedAt = requireTimestamp(this.now(), "approval.consumedAt");
        if (consumedAt < current.ticket.issuedAt) {
          throw new PiNativeFileStoreError(
            "invalid-transition",
            "Approval Ticket 尚未生效"
          );
        }
        if (consumedAt >= current.ticket.expiresAt) {
          await this.writeDocument({
            schemaVersion: PI_NATIVE_FILE_SCHEMA_VERSION,
            vaultId: this.vaultId,
            ticket: current.ticket,
            status: "expired",
            resolvedAt: consumedAt,
            consumedAt: null
          });
          throw new PiNativeFileStoreError(
            "invalid-transition",
            `Approval Ticket ${current.ticket.ticketId} 已过期`
          );
        }

        const readback = await this.writeDocument({
          schemaVersion: PI_NATIVE_FILE_SCHEMA_VERSION,
          vaultId: this.vaultId,
          ticket: current.ticket,
          status: "approved",
          resolvedAt: consumedAt,
          consumedAt
        });
        return normalizeToolAuthorizationContext({
          ...readback.ticket,
          authorizationKind: "approval_ticket",
          effectType: "user_write",
          consumedAt
        }) as Readonly<WriteToolAuthorizationContext>;
      }
    );
  }

  private ticketFilePath(productRunId: string, toolCallId: string): string {
    return path.join(
      this.rootPath,
      `${stablePathToken(`${productRunId}\u0000${toolCallId}`)}.json`
    );
  }

  private async readState(
    productRunId: string,
    toolCallId: string
  ): Promise<ApprovalTicketState | null> {
    const value = await readJsonFileIfPresent(
      this.ticketFilePath(productRunId, toolCallId),
      `Approval Ticket ${productRunId}/${toolCallId}`
    );
    if (value === null) return null;
    const document = parseApprovalTicketDocument(value, this.vaultId);
    if (
      document.ticket.productRunId !== productRunId
      || document.ticket.toolCallId !== toolCallId
    ) {
      throw new PiNativeFileStoreError(
        "store-corrupt",
        "Approval Ticket 文件名与 ProductRun / Tool Call 身份不匹配"
      );
    }
    return {
      ticket: document.ticket,
      status: document.status,
      resolvedAt: document.resolvedAt,
      consumedAt: document.consumedAt
    };
  }

  private async expireIfNeeded(
    state: ApprovalTicketState
  ): Promise<ApprovalTicketState> {
    if (state.status !== "pending") return state;
    const observedAt = requireTimestamp(this.now(), "approval.now");
    if (observedAt < state.ticket.expiresAt) return state;
    const document = await this.writeDocument({
      schemaVersion: PI_NATIVE_FILE_SCHEMA_VERSION,
      vaultId: this.vaultId,
      ticket: state.ticket,
      status: "expired",
      resolvedAt: observedAt,
      consumedAt: null
    });
    return ticketStateFromDocument(document);
  }

  private async writeDocument(
    document: ApprovalTicketDocumentV1
  ): Promise<ApprovalTicketDocumentV1> {
    const readback = await atomicWriteJsonFile(
      this.ticketFilePath(
        document.ticket.productRunId,
        document.ticket.toolCallId
      ),
      document,
      `Approval Ticket ${document.ticket.ticketId}`,
      (value) => parseApprovalTicketDocument(value, this.vaultId)
    );
    if (!isDeepStrictEqual(readback, document)) {
      throw new PiNativeFileStoreError(
        "readback-diverged",
        `Approval Ticket ${document.ticket.ticketId} 语义回读不一致`
      );
    }
    return readback;
  }
}

export function createOperationIdentity(
  contract: Readonly<ApprovalOperationContract>
): string {
  const normalized = normalizeApprovalOperationContract(contract);
  return prefixedSha256("echoink-operation-v1", {
    kind: "echoink-operation-v1",
    contract: normalized
  });
}

export function createMcpApprovalToolId(input: {
  readonly resourceId: string;
  readonly toolName: string;
}): McpApprovalToolId {
  return `echoink_mcp_${createHash("sha256")
    .update(`${input.resourceId}\u0000${input.toolName}`, "utf8")
    .digest("hex")}`;
}

export function isMcpApprovalToolId(value: unknown): value is McpApprovalToolId {
  return typeof value === "string" && MCP_APPROVAL_TOOL_ID_PATTERN.test(value);
}

export function isSideEffectApprovalToolId(value: unknown): value is SideEffectApprovalToolId {
  return (typeof value === "string" && APPROVAL_WRITE_TOOL_IDS.includes(value as ApprovalWriteToolId))
    || value === "obsidian_cli"
    || isMcpApprovalToolId(value);
}

export function approvalContractFromTicket(
  ticket: Readonly<EchoInkApprovalTicket>
): ApprovalOperationContract {
  return normalizeApprovalOperationContract(pickKeys(ticket, CONTRACT_KEYS));
}

export function approvalContractFromAuthorizationContext(
  context: Readonly<WriteToolAuthorizationContext>
): ApprovalOperationContract {
  return normalizeApprovalOperationContract(pickKeys(context, CONTRACT_KEYS));
}

export function normalizeApprovalOperationContract(
  value: unknown
): ApprovalOperationContract {
  const object = requireInputObject(value, "Approval operation contract");
  requireInputExactKeys(object, CONTRACT_KEYS, "Approval operation contract");
  const toolId = requireApprovalToolId(object.toolId, "toolId");
  return cloneAndFreeze({
    productRunId: requireNonEmptyString(object.productRunId, "productRunId"),
    toolCallId: requireNonEmptyString(object.toolCallId, "toolCallId"),
    conversationId: requireNonEmptyString(
      object.conversationId,
      "conversationId"
    ),
    piSessionId: requireNonEmptyString(object.piSessionId, "piSessionId"),
    userId: requireNonEmptyString(object.userId, "userId"),
    vaultId: requireNonEmptyString(object.vaultId, "vaultId"),
    deviceId: requireNonEmptyString(object.deviceId, "deviceId"),
    toolId,
    toolVersion: requireNonEmptyString(object.toolVersion, "toolVersion"),
    policyVersion: requireNonEmptyString(
      object.policyVersion,
      "policyVersion"
    ),
    normalizedArguments: normalizeJsonValue(
      object.normalizedArguments,
      "normalizedArguments"
    ),
    resolvedTarget: normalizeJsonValue(object.resolvedTarget, "resolvedTarget"),
    targetVersion: normalizeJsonValue(object.targetVersion, "targetVersion"),
    preview: normalizeJsonValue(object.preview, "preview")
  });
}

export function normalizeToolAuthorizationContext(
  value: unknown
): Readonly<ToolAuthorizationContext> {
  if (trustedReadAuthorizations.has(value as Readonly<ReadToolAuthorizationContext>)) {
    return value as Readonly<ReadToolAuthorizationContext>;
  }
  const object = requireInputObject(value, "Tool authorization context");
  if (object.authorizationKind === "policy_allow") {
    return normalizeReadToolAuthorizationContext(object);
  }
  if (object.authorizationKind !== "approval_ticket") {
    throw new PiNativeFileStoreError(
      "invalid-input",
      "Tool authorization context 的 authorizationKind 无效"
    );
  }
  requireInputExactKeys(
    object,
    WRITE_AUTHORIZATION_CONTEXT_KEYS,
    "Tool authorization context"
  );
  if (
    object.effectType !== "user_write"
    || object.authorizationKind !== "approval_ticket"
  ) {
    throw new PiNativeFileStoreError(
      "invalid-input",
      "写 Tool authorization context 的判定字段无效"
    );
  }
  const ticket = normalizeEchoInkApprovalTicket(
    pickKeys(object, TICKET_KEYS)
  );
  const consumedAt = requireTimestamp(object.consumedAt, "consumedAt");
  if (consumedAt < ticket.issuedAt || consumedAt >= ticket.expiresAt) {
    throw new PiNativeFileStoreError(
      "invalid-input",
      "Tool authorization context 的消费时间不在 Ticket 有效期内"
    );
  }
  return cloneAndFreeze({
    ...ticket,
    authorizationKind: "approval_ticket",
    effectType: "user_write",
    consumedAt
  });
}

const trustedReadAuthorizations = new WeakSet<Readonly<ReadToolAuthorizationContext>>();

export function createReadToolAuthorizationContext(
  input: Readonly<ReadToolAuthorizationInput>
): Readonly<ReadToolAuthorizationContext> {
  const normalized = normalizeReadToolAuthorizationInput(input);
  const authorizationId = prefixedSha256("echoink-read-authorization", {
    kind: "echoink-read-authorization-v1",
    context: normalized
  });
  const context = cloneAndFreeze({
    ...normalized,
    authorizationKind: "policy_allow" as const,
    effectType: "read" as const,
    authorizationId
  });
  trustedReadAuthorizations.add(context);
  return context;
}

export function isWriteToolAuthorizationContext(
  context: Readonly<ToolAuthorizationContext>
): context is Readonly<WriteToolAuthorizationContext> {
  return context.authorizationKind === "approval_ticket"
    && context.effectType === "user_write";
}

export function isReadToolAuthorizationContext(
  context: Readonly<ToolAuthorizationContext>
): context is Readonly<ReadToolAuthorizationContext> {
  return context.authorizationKind === "policy_allow"
    && context.effectType === "read";
}

export function normalizeJsonValue(value: unknown, label = "JSON value"): JsonValue {
  return deepFreezeJson(normalizeJsonValueInternal(value, label, new WeakSet()));
}

export function canonicalJsonStringify(value: unknown): string {
  return JSON.stringify(normalizeJsonValue(value));
}

function normalizeReadToolAuthorizationInput(
  value: unknown
): ReadToolAuthorizationInput {
  const object = requireInputObject(value, "Read Tool authorization input");
  requireInputExactKeys(
    object,
    READ_AUTHORIZATION_INPUT_KEYS,
    "Read Tool authorization input"
  );
  return cloneAndFreeze({
    productRunId: requireNonEmptyString(object.productRunId, "productRunId"),
    toolCallId: requireNonEmptyString(object.toolCallId, "toolCallId"),
    conversationId: requireNonEmptyString(
      object.conversationId,
      "conversationId"
    ),
    piSessionId: requireNonEmptyString(object.piSessionId, "piSessionId"),
    userId: requireNonEmptyString(object.userId, "userId"),
    vaultId: requireNonEmptyString(object.vaultId, "vaultId"),
    deviceId: requireNonEmptyString(object.deviceId, "deviceId"),
    toolId: requireReadToolId(object.toolId),
    toolVersion: requireNonEmptyString(object.toolVersion, "toolVersion"),
    policyVersion: requireNonEmptyString(
      object.policyVersion,
      "policyVersion"
    ),
    normalizedArguments: normalizeJsonValue(
      object.normalizedArguments,
      "normalizedArguments"
    ),
    resolvedTarget: normalizeJsonValue(object.resolvedTarget, "resolvedTarget"),
    targetVersion: normalizeJsonValue(object.targetVersion, "targetVersion"),
    authorizedAt: requireTimestamp(object.authorizedAt, "authorizedAt")
  });
}

function normalizeReadToolAuthorizationContext(
  value: unknown
): Readonly<ReadToolAuthorizationContext> {
  const object = requireInputObject(value, "Read Tool authorization context");
  requireInputExactKeys(
    object,
    READ_AUTHORIZATION_CONTEXT_KEYS,
    "Read Tool authorization context"
  );
  if (
    object.authorizationKind !== "policy_allow"
    || object.effectType !== "read"
  ) {
    throw new PiNativeFileStoreError(
      "invalid-input",
      "读 Tool authorization context 的判定字段无效"
    );
  }
  const expected = createReadToolAuthorizationContext(
    pickKeys(object, READ_AUTHORIZATION_INPUT_KEYS) as unknown as ReadToolAuthorizationInput
  );
  if (object.authorizationId !== expected.authorizationId) {
    throw new PiNativeFileStoreError(
      "mapping-conflict",
      "读 Tool authorizationId 与完整授权上下文不匹配"
    );
  }
  return expected;
}

function normalizeApprovalTicketIssueInput(
  value: unknown
): ApprovalTicketIssueInput {
  const object = requireInputObject(value, "Approval Ticket issue input");
  requireInputExactKeys(object, ISSUE_KEYS, "Approval Ticket issue input");
  const contract = normalizeApprovalOperationContract(
    pickKeys(object, CONTRACT_KEYS)
  );
  const issuedAt = requireTimestamp(object.issuedAt, "issuedAt");
  const expiresAt = requireTimestamp(object.expiresAt, "expiresAt");
  if (expiresAt <= issuedAt) {
    throw new PiNativeFileStoreError(
      "invalid-input",
      "Approval Ticket 的 expiresAt 必须晚于 issuedAt"
    );
  }
  return cloneAndFreeze({ ...contract, issuedAt, expiresAt });
}

function normalizeConsumeApprovalTicketInput(
  value: unknown
): ConsumeApprovalTicketInput {
  const object = requireInputObject(value, "Consume Approval Ticket input");
  requireInputExactKeys(
    object,
    ["ticketId", "operationIdentity", "contract"],
    "Consume Approval Ticket input"
  );
  return cloneAndFreeze({
    ticketId: requireNonEmptyString(object.ticketId, "ticketId"),
    operationIdentity: requireNonEmptyString(
      object.operationIdentity,
      "operationIdentity"
    ),
    contract: normalizeApprovalOperationContract(object.contract)
  });
}

function normalizeResolveApprovalTicketInput(
  value: unknown
): ResolveApprovalTicketInput {
  const object = requireInputObject(value, "Resolve Approval Ticket input");
  requireInputExactKeys(
    object,
    ["productRunId", "toolCallId", "ticketId", "resolution"],
    "Resolve Approval Ticket input"
  );
  if (object.resolution !== "denied" && object.resolution !== "cancelled") {
    throw new PiNativeFileStoreError(
      "invalid-input",
      "Approval Ticket resolution 只能是 denied 或 cancelled"
    );
  }
  return cloneAndFreeze({
    productRunId: requireNonEmptyString(object.productRunId, "productRunId"),
    toolCallId: requireNonEmptyString(object.toolCallId, "toolCallId"),
    ticketId: requireNonEmptyString(object.ticketId, "ticketId"),
    resolution: object.resolution
  });
}

function createApprovalTicket(
  input: ApprovalTicketIssueInput
): EchoInkApprovalTicket {
  const operationIdentity = createOperationIdentity(
    normalizeApprovalOperationContract(pickKeys(input, CONTRACT_KEYS))
  );
  const unsigned = cloneAndFreeze({ ...input, operationIdentity });
  const ticketId = prefixedSha256("echoink-approval", {
    kind: "echoink-approval-ticket-v1",
    ticket: unsigned
  });
  return cloneAndFreeze({ ...unsigned, ticketId });
}

function normalizeEchoInkApprovalTicket(
  value: unknown
): EchoInkApprovalTicket {
  const object = requireInputObject(value, "EchoInk Approval Ticket");
  requireInputExactKeys(object, TICKET_KEYS, "EchoInk Approval Ticket");
  const issue = normalizeApprovalTicketIssueInput(pickKeys(object, ISSUE_KEYS));
  const candidate = createApprovalTicket(issue);
  if (
    object.operationIdentity !== candidate.operationIdentity
    || object.ticketId !== candidate.ticketId
  ) {
    throw new PiNativeFileStoreError(
      "invalid-input",
      "Approval Ticket 的哈希身份与完整合同不匹配"
    );
  }
  return candidate;
}

function parseApprovalTicketDocument(
  value: unknown,
  expectedVaultId: string
): ApprovalTicketDocumentV1 {
  try {
    const object = requireInputObject(value, "Approval Ticket document");
    requireInputExactKeys(
      object,
      [
        "schemaVersion",
        "vaultId",
        "ticket",
        "status",
        "resolvedAt",
        "consumedAt"
      ],
      "Approval Ticket document"
    );
    if (object.schemaVersion !== PI_NATIVE_FILE_SCHEMA_VERSION) {
      throw new Error(`不支持 schemaVersion ${String(object.schemaVersion)}`);
    }
    if (object.vaultId !== expectedVaultId) {
      throw new Error("Vault identity 与目录不匹配");
    }
    const ticket = normalizeEchoInkApprovalTicket(object.ticket);
    if (ticket.vaultId !== expectedVaultId) {
      throw new Error("Ticket Vault identity 与目录不匹配");
    }
    const status = requireApprovalTicketStatus(object.status);
    const resolvedAt = object.resolvedAt === null
      ? null
      : requireTimestamp(object.resolvedAt, "resolvedAt");
    const consumedAt = object.consumedAt === null
      ? null
      : requireTimestamp(object.consumedAt, "consumedAt");
    validateApprovalTicketState(ticket, status, resolvedAt, consumedAt);
    return {
      schemaVersion: PI_NATIVE_FILE_SCHEMA_VERSION,
      vaultId: expectedVaultId,
      ticket,
      status,
      resolvedAt,
      consumedAt
    };
  } catch (error) {
    if (
      error instanceof PiNativeFileStoreError
      && error.code === "store-corrupt"
    ) {
      throw error;
    }
    throw new PiNativeFileStoreError(
      "store-corrupt",
      `Approval Ticket document 校验失败：${errorMessage(error)}`
    );
  }
}

function freezeTicketState(state: ApprovalTicketState): Readonly<ApprovalTicketState> {
  return cloneAndFreeze({
    ticket: normalizeEchoInkApprovalTicket(state.ticket),
    status: requireApprovalTicketStatus(state.status),
    resolvedAt: state.resolvedAt,
    consumedAt: state.consumedAt
  });
}

function ticketStateFromDocument(
  document: ApprovalTicketDocumentV1
): ApprovalTicketState {
  return {
    ticket: document.ticket,
    status: document.status,
    resolvedAt: document.resolvedAt,
    consumedAt: document.consumedAt
  };
}

function validateApprovalTicketState(
  ticket: EchoInkApprovalTicket,
  status: ApprovalTicketStatus,
  resolvedAt: number | null,
  consumedAt: number | null
): void {
  if (status === "pending") {
    if (resolvedAt !== null || consumedAt !== null) {
      throw new Error("pending Ticket 不能包含 resolution 时间");
    }
    return;
  }
  if (resolvedAt === null) {
    throw new Error(`${status} Ticket 必须包含 resolvedAt`);
  }
  if (resolvedAt < ticket.issuedAt) {
    throw new Error("Ticket resolvedAt 不能早于 issuedAt");
  }
  if (status === "approved") {
    if (
      consumedAt === null
      || consumedAt !== resolvedAt
      || consumedAt >= ticket.expiresAt
    ) {
      throw new Error("approved Ticket 必须在有效期内且只消费一次");
    }
    return;
  }
  if (consumedAt !== null) {
    throw new Error(`${status} Ticket 不能包含 consumedAt`);
  }
  if (status === "expired" && resolvedAt < ticket.expiresAt) {
    throw new Error("expired Ticket 的 resolvedAt 不能早于 expiresAt");
  }
  if (
    (status === "denied" || status === "cancelled")
    && resolvedAt >= ticket.expiresAt
  ) {
    throw new Error(`${status} Ticket 不能在过期后结算`);
  }
}

function requireApprovalToolId(value: unknown, label: string): ApprovalToolId {
  const toolId = requireNonEmptyString(value, label);
  if (!APPROVAL_IDS.has(toolId) && !isMcpApprovalToolId(toolId)) {
    throw new PiNativeFileStoreError(
      "invalid-input",
      `${label} 必须是受控 Approval Tool 之一`
    );
  }
  return toolId as ApprovalToolId;
}

function requireReadToolId(value: unknown): AutoAllowedReadToolId {
  const toolId = requireNonEmptyString(value, "toolId");
  if (!READ_TOOL_IDS.has(toolId)) {
    throw new PiNativeFileStoreError(
      "invalid-input",
      "读授权只允许 vault_search 或 note_read"
    );
  }
  return toolId as AutoAllowedReadToolId;
}

function requireApprovalTicketStatus(value: unknown): ApprovalTicketStatus {
  const status = requireNonEmptyString(value, "approval.status");
  if (!APPROVAL_STATUSES.has(status)) {
    throw new PiNativeFileStoreError(
      "invalid-input",
      `不支持的 Approval Ticket status ${status}`
    );
  }
  return status as ApprovalTicketStatus;
}

function requireInputObject(
  value: unknown,
  label: string
): Record<string, unknown> {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype
      && Object.getPrototypeOf(value) !== null)
  ) {
    throw new PiNativeFileStoreError(
      "invalid-input",
      `${label} 必须是普通对象`
    );
  }
  return value as Record<string, unknown>;
}

function requireInputExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  label: string
): void {
  const expected = new Set(required);
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      throw new PiNativeFileStoreError(
        "invalid-input",
        `${label} 缺少字段 ${key}`
      );
    }
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !expected.has(key)) {
      throw new PiNativeFileStoreError(
        "invalid-input",
        `${label} 包含未声明字段 ${String(key)}`
      );
    }
  }
}

function normalizeJsonValueInternal(
  value: unknown,
  label: string,
  ancestors: WeakSet<object>
): JsonValue {
  if (
    value === null
    || typeof value === "string"
    || typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new PiNativeFileStoreError(
        "invalid-input",
        `${label} 包含非有限数值`
      );
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== "object" || value === null) {
    throw new PiNativeFileStoreError(
      "invalid-input",
      `${label} 不是 JSON-safe 值`
    );
  }
  if (ancestors.has(value)) {
    throw new PiNativeFileStoreError(
      "invalid-input",
      `${label} 包含循环引用`
    );
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const result: JsonValue[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(value, index)) {
          throw new PiNativeFileStoreError(
            "invalid-input",
            `${label}[${index}] 是稀疏数组空位`
          );
        }
        result.push(normalizeJsonValueInternal(
          value[index],
          `${label}[${index}]`,
          ancestors
        ));
      }
      return result;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new PiNativeFileStoreError(
        "invalid-input",
        `${label} 包含非普通对象`
      );
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new PiNativeFileStoreError(
        "invalid-input",
        `${label} 包含 Symbol 字段`
      );
    }
    const ownNames = Object.getOwnPropertyNames(value);
    const enumerableKeys = Object.keys(value);
    if (ownNames.length !== enumerableKeys.length) {
      throw new PiNativeFileStoreError(
        "invalid-input",
        `${label} 包含不可枚举字段`
      );
    }
    const result: Record<string, JsonValue> = {};
    for (const key of enumerableKeys.sort()) {
      Object.defineProperty(result, key, {
        value: normalizeJsonValueInternal(
          (value as Record<string, unknown>)[key],
          `${label}.${key}`,
          ancestors
        ),
        enumerable: true,
        configurable: true,
        writable: true
      });
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

function deepFreezeJson(value: JsonValue): JsonValue {
  if (value !== null && typeof value === "object") {
    for (const child of Array.isArray(value) ? value : Object.values(value)) {
      deepFreezeJson(child);
    }
    Object.freeze(value);
  }
  return value;
}

function cloneAndFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value as Record<string, unknown>)) {
      cloneAndFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

function pickKeys(
  value: Record<string, unknown> | object,
  keys: readonly string[]
): Record<string, unknown> {
  const source = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const key of keys) result[key] = source[key];
  return result;
}

function prefixedSha256(prefix: string, value: unknown): string {
  return `${prefix}_${createHash("sha256")
    .update(canonicalJsonStringify(value), "utf8")
    .digest("hex")}`;
}

function approvalMismatch(message: string): PiNativeFileStoreError {
  return new PiNativeFileStoreError("mapping-conflict", message);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
