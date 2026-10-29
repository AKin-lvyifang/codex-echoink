import { getDesktopFsPromises } from "../../platform/desktop-filesystem";
import { getDesktopPath } from "../../platform/desktop-paths";
import { getDesktopUtil } from "../../platform/desktop-runtime";

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
import {
  approvalContractFromAuthorizationContext,
  createOperationIdentity,
  isMcpApprovalToolId,
  isSideEffectApprovalToolId,
  isWriteToolAuthorizationContext,
  normalizeJsonValue,
  normalizeToolAuthorizationContext,
  type JsonValue,
  type SideEffectApprovalToolId,
  type WriteToolAuthorizationContext
} from "./tool-authorization";

const { isDeepStrictEqual } = getDesktopUtil();

const { mkdir, readdir } = getDesktopFsPromises();
const path = getDesktopPath();

export const TEST_UNCERTAIN = "TEST_UNCERTAIN" as const;

export const DOMAIN_RECEIPT_STATUSES = [
  "completed",
  "failed",
  "cancelled",
  "uncertain"
] as const;

export type DomainReceiptStatus = typeof DOMAIN_RECEIPT_STATUSES[number];
export type DomainOperationEffectState =
  | "authorized"
  | "effect_started"
  | "effect_completed";
export type DomainReceiptRecoveryState =
  | "not_required"
  | "readback_recovered"
  | "uncertain_recovered";

export interface DomainReadbackSummary {
  checkedAt: number;
  readbackVerified: boolean;
  observedTargetVersion: JsonValue;
  safeSummary: JsonValue;
}

/**
 * Product-side proof for one write effect. It intentionally contains no Tool
 * Result, note body, model transcript or retry payload; those stay in the Pi
 * Session and the Vault respectively.
 */
export interface DomainReceipt {
  receiptId: string;
  operationIdentity: string;
  productRunId: string;
  toolCallId: string;
  conversationId: string;
  piSessionId: string;
  vaultId: string;
  toolId: SideEffectApprovalToolId;
  toolVersion: string;
  policyVersion: string;
  resolvedTarget: JsonValue;
  targetVersion: JsonValue;
  approvalTicketId: string;
  status: DomainReceiptStatus;
  safeSummary: JsonValue;
  readback: DomainReadbackSummary;
  recoveryState: DomainReceiptRecoveryState;
  recordedAt: number;
}

export interface PersistDomainReceiptInput {
  operationIdentity: string;
  status: DomainReceiptStatus;
  safeSummary: JsonValue;
  readback: DomainReadbackSummary;
  failureInjection?: typeof TEST_UNCERTAIN;
}

export interface DomainRecoveryReadbackResult {
  status: DomainReceiptStatus;
  safeSummary: JsonValue;
  readback: DomainReadbackSummary;
}

export interface DomainOperationJournal {
  operationIdentity: string;
  productRunId: string;
  toolCallId: string;
  conversationId: string;
  piSessionId: string;
  vaultId: string;
  toolId: SideEffectApprovalToolId;
  toolVersion: string;
  policyVersion: string;
  resolvedTarget: JsonValue;
  targetVersion: JsonValue;
  approvalTicketId: string;
  authorizedAt: number;
  effectState: DomainOperationEffectState;
  effectStartedAt: number | null;
  effectCompletedAt: number | null;
}

/** Minimal, read-only data made available to crash recovery. */
export interface DomainRecoveryReadbackContext {
  operationIdentity: string;
  productRunId: string;
  toolCallId: string;
  conversationId: string;
  piSessionId: string;
  vaultId: string;
  toolId: SideEffectApprovalToolId;
  toolVersion: string;
  policyVersion: string;
  resolvedTarget: JsonValue;
  targetVersion: JsonValue;
  approvalTicketId: string;
}

export type DomainReceiptRecoveryInspection =
  | Readonly<{ state: "not_found" }>
  | Readonly<{
      state: "not_started";
      operation: Readonly<DomainRecoveryReadbackContext>;
    }>
  | Readonly<{
      state: "readback_required";
      effectState: "effect_started" | "effect_completed";
      operation: Readonly<DomainRecoveryReadbackContext>;
    }>
  | Readonly<{
      state: "receipt_present";
      receipt: Readonly<DomainReceipt>;
    }>;

export interface FileDomainReceiptStoreOptions {
  storageRootPath: string;
  vaultId: string;
  now?: () => number;
}

export interface DomainReceiptListOptions {
  conversationId?: string;
  productRunId?: string;
  statuses?: readonly DomainReceiptStatus[];
}

export interface DomainReceiptUiView {
  operationIdentity: string;
  productRunId: string;
  toolCallId: string;
  conversationId: string;
  piSessionId: string;
  vaultId: string;
  toolId: SideEffectApprovalToolId;
  resolvedTarget: JsonValue;
  approvalTicketId: string;
  effectState: DomainOperationEffectState;
  recoveryState: "not_started" | "readback_required" | "receipt_present";
  receipt: Readonly<DomainReceipt> | null;
  readbackRequired: boolean;
}

interface DomainOperationDocumentV1 {
  schemaVersion: typeof PI_NATIVE_FILE_SCHEMA_VERSION;
  vaultId: string;
  operation: DomainOperationJournal;
}

interface DomainReceiptDocumentV1 {
  schemaVersion: typeof PI_NATIVE_FILE_SCHEMA_VERSION;
  vaultId: string;
  receipt: DomainReceipt;
}

const RECEIPT_STATUSES = new Set<string>(DOMAIN_RECEIPT_STATUSES);
const EFFECT_STATES = new Set<string>([
  "authorized",
  "effect_started",
  "effect_completed"
]);
const RECOVERY_STATES = new Set<string>([
  "not_required",
  "readback_recovered",
  "uncertain_recovered"
]);

/**
 * Durable operation journal and Receipt store shared by Vault writes and
 * approved MCP side effects.
 *
 * There is intentionally no `execute` callback in this API. Once an effect is
 * marked started, recovery can only receive a readback callback for the same
 * operationIdentity; this structurally prevents an automatic side-effect retry.
 */
export class FileDomainReceiptStore {
  readonly storageRootPath: string;
  readonly vaultId: string;
  readonly operationsRootPath: string;
  readonly receiptsRootPath: string;

  private readonly layout: PiNativeVaultFileLayout;
  private readonly now: () => number;

  constructor(options: FileDomainReceiptStoreOptions) {
    this.vaultId = requireNonEmptyString(options.vaultId, "vaultId");
    this.layout = piNativeVaultFileLayout(
      options.storageRootPath,
      this.vaultId
    );
    this.storageRootPath = this.layout.storageRootPath;
    const toolDomainRoot = path.join(this.layout.vaultRootPath, "tool-domain");
    this.operationsRootPath = path.join(toolDomainRoot, "operations");
    this.receiptsRootPath = path.join(toolDomainRoot, "receipts");
    this.now = options.now ?? Date.now;
  }

  async initialize(): Promise<void> {
    await serializePiNativeFileWrite(this.storageRootPath, async () => {
      await ensurePiNativeVaultFileLayout(this.layout);
      await Promise.all([
        mkdir(this.operationsRootPath, { recursive: true, mode: 0o700 }),
        mkdir(this.receiptsRootPath, { recursive: true, mode: 0o700 })
      ]);
    });
  }

  async beginAuthorizedOperation(
    context: Readonly<WriteToolAuthorizationContext>
  ): Promise<Readonly<DomainOperationJournal>> {
    const authorization = normalizeToolAuthorizationContext(context);
    if (!isWriteToolAuthorizationContext(authorization)) {
      throw new PiNativeFileStoreError(
        "invalid-input",
        "Domain Receipt 只接受受控副作用 Tool 的 Approval authorization context"
      );
    }
    if (authorization.vaultId !== this.vaultId) {
      throw new PiNativeFileStoreError(
        "mapping-conflict",
        "Tool authorization context 的 Vault 与 Receipt Store 不匹配"
      );
    }
    const expectedIdentity = createOperationIdentity(
      approvalContractFromAuthorizationContext(authorization)
    );
    if (authorization.operationIdentity !== expectedIdentity) {
      throw new PiNativeFileStoreError(
        "mapping-conflict",
        "Tool authorization context 的 operationIdentity 无效"
      );
    }
    const candidate = operationFromAuthorization(authorization);

    return await serializePiNativeFileWrite(
      this.storageRootPath,
      async () => {
        await ensurePiNativeVaultFileLayout(this.layout);
        await Promise.all([
          mkdir(this.operationsRootPath, { recursive: true, mode: 0o700 }),
          mkdir(this.receiptsRootPath, { recursive: true, mode: 0o700 })
        ]);
        const receipt = await this.readReceiptInternal(
          authorization.operationIdentity
        );
        if (receipt) {
          throw new PiNativeFileStoreError(
            "invalid-transition",
            `operationIdentity ${authorization.operationIdentity} 已有 Receipt`
          );
        }
        const existing = await this.readOperationInternal(
          authorization.operationIdentity
        );
        if (existing) {
          if (!sameOperationIdentityFields(existing, candidate)) {
            throw new PiNativeFileStoreError(
              "mapping-conflict",
              "operationIdentity 已由另一份授权上下文占用"
            );
          }
          if (existing.effectState !== "authorized") {
            throw new PiNativeFileStoreError(
              "invalid-transition",
              `operationIdentity ${existing.operationIdentity} 的副作用已经开始，不能重新授权执行`
            );
          }
          return cloneAndFreeze(existing);
        }
        return cloneAndFreeze(await this.writeOperation(candidate));
      }
    );
  }

  async markEffectStarted(
    operationIdentity: string
  ): Promise<Readonly<DomainOperationJournal>> {
    const identity = requireNonEmptyString(
      operationIdentity,
      "operationIdentity"
    );
    return await serializePiNativeFileWrite(
      this.storageRootPath,
      async () => {
        const operation = await this.requireOperation(identity);
        await this.assertReceiptAbsent(identity);
        if (operation.effectState !== "authorized") {
          throw new PiNativeFileStoreError(
            "invalid-transition",
            `operationIdentity ${identity} 已经开始或完成，禁止再次启动副作用`
          );
        }
        const startedAt = requireTimestamp(this.now(), "effectStartedAt");
        if (startedAt < operation.authorizedAt) {
          throw new PiNativeFileStoreError(
            "invalid-transition",
            "effectStartedAt 不能早于授权时间"
          );
        }
        return cloneAndFreeze(await this.writeOperation({
          ...operation,
          effectState: "effect_started",
          effectStartedAt: startedAt
        }));
      }
    );
  }

  async markEffectCompleted(
    operationIdentity: string
  ): Promise<Readonly<DomainOperationJournal>> {
    const identity = requireNonEmptyString(
      operationIdentity,
      "operationIdentity"
    );
    return await serializePiNativeFileWrite(
      this.storageRootPath,
      async () => {
        const operation = await this.requireOperation(identity);
        await this.assertReceiptAbsent(identity);
        if (
          operation.effectState !== "effect_started"
          || operation.effectStartedAt === null
        ) {
          throw new PiNativeFileStoreError(
            "invalid-transition",
            `operationIdentity ${identity} 没有唯一的已启动副作用可完成`
          );
        }
        const completedAt = requireTimestamp(this.now(), "effectCompletedAt");
        if (completedAt < operation.effectStartedAt) {
          throw new PiNativeFileStoreError(
            "invalid-transition",
            "effectCompletedAt 不能早于副作用启动时间"
          );
        }
        return cloneAndFreeze(await this.writeOperation({
          ...operation,
          effectState: "effect_completed",
          effectCompletedAt: completedAt
        }));
      }
    );
  }

  async persistReceipt(
    input: Readonly<PersistDomainReceiptInput>
  ): Promise<Readonly<DomainReceipt>> {
    const normalized = normalizePersistReceiptInput(input);
    return await serializePiNativeFileWrite(
      this.storageRootPath,
      async () => {
        const operation = await this.requireOperation(
          normalized.operationIdentity
        );
        const existing = await this.readReceiptInternal(
          normalized.operationIdentity
        );
        if (existing) {
          if (normalized.failureInjection === TEST_UNCERTAIN) {
            throw new PiNativeFileStoreError(
              "invalid-transition",
              "TEST_UNCERTAIN 只能在 Receipt 尚未持久化时注入"
            );
          }
          const expected = receiptFromOperation(
            operation,
            normalized,
            existing.recoveryState,
            existing.recordedAt
          );
          if (!isDeepStrictEqual(existing, expected)) {
            throw new PiNativeFileStoreError(
              "mapping-conflict",
              `operationIdentity ${normalized.operationIdentity} 已有不同 Receipt`
            );
          }
          return cloneAndFreeze(existing);
        }

        validateReceiptAgainstEffectState(operation, normalized);
        if (normalized.failureInjection === TEST_UNCERTAIN) {
          if (operation.effectState !== "effect_completed") {
            throw new PiNativeFileStoreError(
              "invalid-transition",
              "TEST_UNCERTAIN 只能注入在副作用已完成、Receipt 尚未持久化的窗口"
            );
          }
          throw new TestUncertainInjectionError(operation.operationIdentity);
        }

        const recordedAt = requireTimestamp(this.now(), "receipt.recordedAt");
        if (recordedAt < normalized.readback.checkedAt) {
          throw new PiNativeFileStoreError(
            "invalid-transition",
            "Receipt recordedAt 不能早于 Readback"
          );
        }
        const receipt = receiptFromOperation(
          operation,
          normalized,
          "not_required",
          recordedAt
        );
        return cloneAndFreeze(await this.writeReceipt(receipt));
      }
    );
  }

  async readReceipt(
    operationIdentity: string
  ): Promise<Readonly<DomainReceipt> | null> {
    const receipt = await this.readReceiptInternal(requireNonEmptyString(
      operationIdentity,
      "operationIdentity"
    ));
    return receipt ? cloneAndFreeze(receipt) : null;
  }

  async readOperation(
    operationIdentity: string
  ): Promise<Readonly<DomainOperationJournal> | null> {
    const operation = await this.readOperationInternal(requireNonEmptyString(
      operationIdentity,
      "operationIdentity"
    ));
    return operation ? cloneAndFreeze(operation) : null;
  }

  async inspectRecovery(
    operationIdentity: string
  ): Promise<DomainReceiptRecoveryInspection> {
    const identity = requireNonEmptyString(
      operationIdentity,
      "operationIdentity"
    );
    const [operation, receipt] = await Promise.all([
      this.readOperationInternal(identity),
      this.readReceiptInternal(identity)
    ]);
    return inspectRecoveryState(identity, operation, receipt);
  }

  async listUiViews(
    options: Readonly<DomainReceiptListOptions> = {}
  ): Promise<Readonly<DomainReceiptUiView>[]> {
    const conversationId = options.conversationId === undefined
      ? undefined
      : requireNonEmptyString(options.conversationId, "conversationId");
    const productRunId = options.productRunId === undefined
      ? undefined
      : requireNonEmptyString(options.productRunId, "productRunId");
    const statuses = options.statuses === undefined
      ? null
      : new Set(options.statuses.map(requireReceiptStatus));
    return await serializePiNativeFileWrite(
      this.storageRootPath,
      async () => {
        let names: string[];
        try {
          names = await readdir(this.operationsRootPath);
        } catch (error) {
          if (isNodeErrorWithCode(error, "ENOENT")) return [];
          throw error;
        }
        const views: DomainReceiptUiView[] = [];
        for (const name of names.sort()) {
          if (!name.endsWith(".json")) continue;
          const value = await readJsonFileIfPresent(
            path.join(this.operationsRootPath, name),
            `Domain operation view ${name}`
          );
          if (value === null) continue;
          const document = parseOperationDocument(value, this.vaultId);
          const operation = document.operation;
          if (
            name !== path.basename(this.operationFilePath(
              operation.operationIdentity
            ))
          ) {
            throw new PiNativeFileStoreError(
              "store-corrupt",
              `Domain operation view ${name} 的文件名与身份不匹配`
            );
          }
          if (
            (conversationId !== undefined
              && operation.conversationId !== conversationId)
            || (productRunId !== undefined
              && operation.productRunId !== productRunId)
          ) {
            continue;
          }
          const receipt = await this.readReceiptInternal(
            operation.operationIdentity
          );
          if (statuses && (!receipt || !statuses.has(receipt.status))) continue;
          views.push(uiViewFromOperation(operation, receipt));
        }
        return views
          .sort((left, right) =>
            left.productRunId.localeCompare(right.productRunId)
            || left.toolCallId.localeCompare(right.toolCallId)
          )
          .map(cloneAndFreeze);
      }
    );
  }

  async listReceipts(
    options: Readonly<DomainReceiptListOptions> = {}
  ): Promise<Readonly<DomainReceipt>[]> {
    const views = await this.listUiViews(options);
    return views
      .flatMap((view) => view.receipt ? [view.receipt] : [])
      .map((receipt) => cloneAndFreeze(receipt as DomainReceipt));
  }

  async listPendingRecovery(
    options: Omit<DomainReceiptListOptions, "statuses"> = {}
  ): Promise<Readonly<DomainReceiptUiView>[]> {
    const views = await this.listUiViews(options);
    return views.filter((view) => view.recoveryState !== "receipt_present");
  }

  async recoverMissingReceipt(
    operationIdentity: string,
    readback: (
      context: Readonly<DomainRecoveryReadbackContext>
    ) => Promise<Readonly<DomainRecoveryReadbackResult>>
      | Readonly<DomainRecoveryReadbackResult>
  ): Promise<Readonly<DomainReceipt>> {
    const identity = requireNonEmptyString(
      operationIdentity,
      "operationIdentity"
    );
    if (typeof readback !== "function") {
      throw new PiNativeFileStoreError(
        "invalid-input",
        "recoverMissingReceipt 只接受只读 Readback callback"
      );
    }
    return await serializePiNativeFileWrite(
      this.storageRootPath,
      async () => {
        const operation = await this.readOperationInternal(identity);
        const existing = await this.readReceiptInternal(identity);
        const inspection = inspectRecoveryState(identity, operation, existing);
        if (inspection.state === "receipt_present") {
          return cloneAndFreeze(inspection.receipt as DomainReceipt);
        }
        if (inspection.state === "not_found") {
          throw new PiNativeFileStoreError(
            "not-found",
            `operationIdentity ${identity} 不存在`
          );
        }
        if (inspection.state === "not_started") {
          throw new PiNativeFileStoreError(
            "invalid-transition",
            `operationIdentity ${identity} 的副作用尚未启动，禁止伪造恢复 Receipt`
          );
        }
        if (!operation) {
          throw new PiNativeFileStoreError(
            "store-corrupt",
            `operationIdentity ${identity} 缺少恢复 Journal`
          );
        }

        const result = normalizeRecoveryReadbackResult(
          await readback(inspection.operation)
        );
        validateReceiptAgainstEffectState(operation, result, true);
        const recordedAt = requireTimestamp(this.now(), "receipt.recordedAt");
        if (recordedAt < result.readback.checkedAt) {
          throw new PiNativeFileStoreError(
            "invalid-transition",
            "恢复 Receipt 的 recordedAt 不能早于 Readback"
          );
        }
        const receipt = receiptFromOperation(
          operation,
          result,
          operationRequiresReadback(operation)
            ? "readback_recovered"
            : "uncertain_recovered",
          recordedAt
        );
        return cloneAndFreeze(await this.writeReceipt(receipt));
      }
    );
  }

  private operationFilePath(operationIdentity: string): string {
    return path.join(
      this.operationsRootPath,
      `${stablePathToken(operationIdentity)}.json`
    );
  }

  private receiptFilePath(operationIdentity: string): string {
    return path.join(
      this.receiptsRootPath,
      `${stablePathToken(operationIdentity)}.json`
    );
  }

  private async requireOperation(
    operationIdentity: string
  ): Promise<DomainOperationJournal> {
    const operation = await this.readOperationInternal(operationIdentity);
    if (!operation) {
      throw new PiNativeFileStoreError(
        "not-found",
        `operationIdentity ${operationIdentity} 没有授权 Journal`
      );
    }
    return operation;
  }

  private async assertReceiptAbsent(operationIdentity: string): Promise<void> {
    if (await this.readReceiptInternal(operationIdentity)) {
      throw new PiNativeFileStoreError(
        "invalid-transition",
        `operationIdentity ${operationIdentity} 已有 Receipt`
      );
    }
  }

  private async readOperationInternal(
    operationIdentity: string
  ): Promise<DomainOperationJournal | null> {
    const value = await readJsonFileIfPresent(
      this.operationFilePath(operationIdentity),
      `Domain operation ${operationIdentity}`
    );
    if (value === null) return null;
    const document = parseOperationDocument(value, this.vaultId);
    if (document.operation.operationIdentity !== operationIdentity) {
      throw new PiNativeFileStoreError(
        "store-corrupt",
        "Domain operation 文件名与 operationIdentity 不匹配"
      );
    }
    return document.operation;
  }

  private async readReceiptInternal(
    operationIdentity: string
  ): Promise<DomainReceipt | null> {
    const value = await readJsonFileIfPresent(
      this.receiptFilePath(operationIdentity),
      `Domain Receipt ${operationIdentity}`
    );
    if (value === null) return null;
    const document = parseReceiptDocument(value, this.vaultId);
    if (document.receipt.operationIdentity !== operationIdentity) {
      throw new PiNativeFileStoreError(
        "store-corrupt",
        "Domain Receipt 文件名与 operationIdentity 不匹配"
      );
    }
    return document.receipt;
  }

  private async writeOperation(
    operation: DomainOperationJournal
  ): Promise<DomainOperationJournal> {
    const document: DomainOperationDocumentV1 = {
      schemaVersion: PI_NATIVE_FILE_SCHEMA_VERSION,
      vaultId: this.vaultId,
      operation
    };
    const readback = await atomicWriteJsonFile(
      this.operationFilePath(operation.operationIdentity),
      document,
      `Domain operation ${operation.operationIdentity}`,
      (value) => parseOperationDocument(value, this.vaultId)
    );
    if (!isDeepStrictEqual(readback, document)) {
      throw new PiNativeFileStoreError(
        "readback-diverged",
        `Domain operation ${operation.operationIdentity} 语义回读不一致`
      );
    }
    return readback.operation;
  }

  private async writeReceipt(receipt: DomainReceipt): Promise<DomainReceipt> {
    const document: DomainReceiptDocumentV1 = {
      schemaVersion: PI_NATIVE_FILE_SCHEMA_VERSION,
      vaultId: this.vaultId,
      receipt
    };
    const readback = await atomicWriteJsonFile(
      this.receiptFilePath(receipt.operationIdentity),
      document,
      `Domain Receipt ${receipt.operationIdentity}`,
      (value) => parseReceiptDocument(value, this.vaultId)
    );
    if (!isDeepStrictEqual(readback, document)) {
      throw new PiNativeFileStoreError(
        "readback-diverged",
        `Domain Receipt ${receipt.operationIdentity} 语义回读不一致`
      );
    }
    return readback.receipt;
  }
}

export class TestUncertainInjectionError extends Error {
  readonly code = TEST_UNCERTAIN;
  readonly operationIdentity: string;

  constructor(operationIdentity: string) {
    super(
      `Injected ${TEST_UNCERTAIN} after effect completion and before Receipt persistence for ${operationIdentity}`
    );
    this.name = "TestUncertainInjectionError";
    this.operationIdentity = operationIdentity;
  }
}

function operationFromAuthorization(
  context: Readonly<WriteToolAuthorizationContext>
): DomainOperationJournal {
  return cloneAndFreeze({
    operationIdentity: context.operationIdentity,
    productRunId: context.productRunId,
    toolCallId: context.toolCallId,
    conversationId: context.conversationId,
    piSessionId: context.piSessionId,
    vaultId: context.vaultId,
    toolId: requireWriteToolId(context.toolId),
    toolVersion: context.toolVersion,
    policyVersion: context.policyVersion,
    resolvedTarget: normalizeJsonValue(context.resolvedTarget, "resolvedTarget"),
    targetVersion: normalizeJsonValue(context.targetVersion, "targetVersion"),
    approvalTicketId: context.ticketId,
    authorizedAt: context.consumedAt,
    effectState: "authorized",
    effectStartedAt: null,
    effectCompletedAt: null
  });
}

function receiptFromOperation(
  operation: DomainOperationJournal,
  input: Pick<
    PersistDomainReceiptInput,
    "status" | "safeSummary" | "readback"
  >,
  recoveryState: DomainReceiptRecoveryState,
  recordedAt: number
): DomainReceipt {
  return cloneAndFreeze({
    receiptId: `echoink-receipt_${stablePathToken(operation.operationIdentity)}`,
    operationIdentity: operation.operationIdentity,
    productRunId: operation.productRunId,
    toolCallId: operation.toolCallId,
    conversationId: operation.conversationId,
    piSessionId: operation.piSessionId,
    vaultId: operation.vaultId,
    toolId: operation.toolId,
    toolVersion: operation.toolVersion,
    policyVersion: operation.policyVersion,
    resolvedTarget: normalizeJsonValue(operation.resolvedTarget, "resolvedTarget"),
    targetVersion: normalizeJsonValue(operation.targetVersion, "targetVersion"),
    approvalTicketId: operation.approvalTicketId,
    status: input.status,
    safeSummary: normalizeJsonValue(input.safeSummary, "safeSummary"),
    readback: normalizeReadbackSummary(input.readback),
    recoveryState,
    recordedAt
  });
}

function validateReceiptAgainstEffectState(
  operation: DomainOperationJournal,
  input: Pick<PersistDomainReceiptInput, "status" | "readback">,
  allowStartedRecovery = false
): void {
  if (
    input.status === "completed"
    && operation.effectState !== "effect_completed"
    && !(allowStartedRecovery && operation.effectState === "effect_started")
  ) {
    throw new PiNativeFileStoreError(
      "invalid-transition",
      "completed Receipt 只能对应已完成的副作用"
    );
  }
  if (
    input.status === "completed"
    && operationRequiresReadback(operation)
    && !input.readback.readbackVerified
  ) {
    throw new PiNativeFileStoreError(
      "invalid-transition",
      "completed Receipt 必须 readbackVerified=true"
    );
  }
  if (input.status === "uncertain" && input.readback.readbackVerified) {
    throw new PiNativeFileStoreError(
      "invalid-transition",
      "uncertain Receipt 不能声明 Readback 已验证"
    );
  }
  if (
    input.status === "uncertain"
    && operation.effectState !== "effect_completed"
    && !(allowStartedRecovery && operation.effectState === "effect_started")
  ) {
    throw new PiNativeFileStoreError(
      "invalid-transition",
      "uncertain Receipt 只能来自已完成副作用或 started Journal 的只读恢复"
    );
  }
}

function inspectRecoveryState(
  operationIdentity: string,
  operation: DomainOperationJournal | null,
  receipt: DomainReceipt | null
): DomainReceiptRecoveryInspection {
  if (receipt && !operation) {
    throw new PiNativeFileStoreError(
      "store-corrupt",
      `operationIdentity ${operationIdentity} 有 Receipt 但缺少 Operation Journal`
    );
  }
  if (receipt) {
    return cloneAndFreeze({ state: "receipt_present", receipt });
  }
  if (!operation) return Object.freeze({ state: "not_found" });
  const recoveryContext = recoveryContextFromOperation(operation);
  if (operation.effectState === "authorized") {
    return cloneAndFreeze({
      state: "not_started",
      operation: recoveryContext
    });
  }
  return cloneAndFreeze({
    state: "readback_required",
    effectState: operation.effectState,
    operation: recoveryContext
  });
}

function recoveryContextFromOperation(
  operation: DomainOperationJournal
): DomainRecoveryReadbackContext {
  return cloneAndFreeze({
    operationIdentity: operation.operationIdentity,
    productRunId: operation.productRunId,
    toolCallId: operation.toolCallId,
    conversationId: operation.conversationId,
    piSessionId: operation.piSessionId,
    vaultId: operation.vaultId,
    toolId: operation.toolId,
    toolVersion: operation.toolVersion,
    policyVersion: operation.policyVersion,
    resolvedTarget: normalizeJsonValue(operation.resolvedTarget, "resolvedTarget"),
    targetVersion: normalizeJsonValue(operation.targetVersion, "targetVersion"),
    approvalTicketId: operation.approvalTicketId
  });
}

function uiViewFromOperation(
  operation: DomainOperationJournal,
  receipt: DomainReceipt | null
): DomainReceiptUiView {
  return cloneAndFreeze({
    operationIdentity: operation.operationIdentity,
    productRunId: operation.productRunId,
    toolCallId: operation.toolCallId,
    conversationId: operation.conversationId,
    piSessionId: operation.piSessionId,
    vaultId: operation.vaultId,
    toolId: operation.toolId,
    resolvedTarget: normalizeJsonValue(operation.resolvedTarget, "resolvedTarget"),
    approvalTicketId: operation.approvalTicketId,
    effectState: operation.effectState,
    recoveryState: receipt
      ? "receipt_present"
      : operation.effectState === "authorized"
        ? "not_started"
        : "readback_required",
    receipt: receipt ? cloneAndFreeze(receipt) : null,
    readbackRequired: operationRequiresReadback(operation)
  });
}

function normalizePersistReceiptInput(
  value: unknown
): PersistDomainReceiptInput {
  const object = requireInputObject(value, "Persist Domain Receipt input");
  requireInputKeys(
    object,
    ["operationIdentity", "status", "safeSummary", "readback"],
    ["failureInjection"],
    "Persist Domain Receipt input"
  );
  const failureInjection = object.failureInjection;
  if (failureInjection !== undefined && failureInjection !== TEST_UNCERTAIN) {
    let description: unknown;
    switch (typeof failureInjection) {
      case "string": case "number": case "boolean": case "bigint": case "symbol":
        description = String(failureInjection);
        break;
      default:
        description = Object.prototype.toString.call(failureInjection);
    }
    throw new PiNativeFileStoreError(
      "invalid-input",
      `不支持的 Receipt failureInjection ${typeof description === "string" ? description : "unknown"}`
    );
  }
  return cloneAndFreeze({
    operationIdentity: requireNonEmptyString(
      object.operationIdentity,
      "operationIdentity"
    ),
    status: requireReceiptStatus(object.status),
    safeSummary: normalizeJsonValue(object.safeSummary, "safeSummary"),
    readback: normalizeReadbackSummary(object.readback),
    ...(failureInjection === TEST_UNCERTAIN
      ? { failureInjection: TEST_UNCERTAIN }
      : {})
  });
}

function normalizeRecoveryReadbackResult(
  value: unknown
): DomainRecoveryReadbackResult {
  const object = requireInputObject(value, "Domain recovery Readback result");
  requireInputKeys(
    object,
    ["status", "safeSummary", "readback"],
    [],
    "Domain recovery Readback result"
  );
  return cloneAndFreeze({
    status: requireReceiptStatus(object.status),
    safeSummary: normalizeJsonValue(object.safeSummary, "safeSummary"),
    readback: normalizeReadbackSummary(object.readback)
  });
}

function normalizeReadbackSummary(value: unknown): DomainReadbackSummary {
  const object = requireInputObject(value, "Domain Readback summary");
  requireInputKeys(
    object,
    ["checkedAt", "readbackVerified", "observedTargetVersion", "safeSummary"],
    [],
    "Domain Readback summary"
  );
  if (typeof object.readbackVerified !== "boolean") {
    throw new PiNativeFileStoreError(
      "invalid-input",
      "Domain Readback summary.readbackVerified 必须是 boolean"
    );
  }
  return cloneAndFreeze({
    checkedAt: requireTimestamp(object.checkedAt, "readback.checkedAt"),
    readbackVerified: object.readbackVerified,
    observedTargetVersion: normalizeJsonValue(
      object.observedTargetVersion,
      "readback.observedTargetVersion"
    ),
    safeSummary: normalizeJsonValue(
      object.safeSummary,
      "readback.safeSummary"
    )
  });
}

function parseOperationDocument(
  value: unknown,
  expectedVaultId: string
): DomainOperationDocumentV1 {
  try {
    const object = requireInputObject(value, "Domain operation document");
    requireInputKeys(
      object,
      ["schemaVersion", "vaultId", "operation"],
      [],
      "Domain operation document"
    );
    if (object.schemaVersion !== PI_NATIVE_FILE_SCHEMA_VERSION) {
      throw new Error(`不支持 schemaVersion ${String(object.schemaVersion)}`);
    }
    if (object.vaultId !== expectedVaultId) {
      throw new Error("Vault identity 与目录不匹配");
    }
    const operation = normalizeOperationJournal(object.operation);
    if (operation.vaultId !== expectedVaultId) {
      throw new Error("Operation Vault identity 与目录不匹配");
    }
    return {
      schemaVersion: PI_NATIVE_FILE_SCHEMA_VERSION,
      vaultId: expectedVaultId,
      operation
    };
  } catch (error) {
    throw storeCorrupt("Domain operation document", error);
  }
}

function parseReceiptDocument(
  value: unknown,
  expectedVaultId: string
): DomainReceiptDocumentV1 {
  try {
    const object = requireInputObject(value, "Domain Receipt document");
    requireInputKeys(
      object,
      ["schemaVersion", "vaultId", "receipt"],
      [],
      "Domain Receipt document"
    );
    if (object.schemaVersion !== PI_NATIVE_FILE_SCHEMA_VERSION) {
      throw new Error(`不支持 schemaVersion ${String(object.schemaVersion)}`);
    }
    if (object.vaultId !== expectedVaultId) {
      throw new Error("Vault identity 与目录不匹配");
    }
    const receipt = normalizeDomainReceipt(object.receipt);
    if (receipt.vaultId !== expectedVaultId) {
      throw new Error("Receipt Vault identity 与目录不匹配");
    }
    return {
      schemaVersion: PI_NATIVE_FILE_SCHEMA_VERSION,
      vaultId: expectedVaultId,
      receipt
    };
  } catch (error) {
    throw storeCorrupt("Domain Receipt document", error);
  }
}

function normalizeOperationJournal(value: unknown): DomainOperationJournal {
  const object = requireInputObject(value, "Domain operation journal");
  requireInputKeys(
    object,
    [
      "operationIdentity",
      "productRunId",
      "toolCallId",
      "conversationId",
      "piSessionId",
      "vaultId",
      "toolId",
      "toolVersion",
      "policyVersion",
      "resolvedTarget",
      "targetVersion",
      "approvalTicketId",
      "authorizedAt",
      "effectState",
      "effectStartedAt",
      "effectCompletedAt"
    ],
    [],
    "Domain operation journal"
  );
  const effectState = requireEffectState(object.effectState);
  const authorizedAt = requireTimestamp(object.authorizedAt, "authorizedAt");
  const effectStartedAt = object.effectStartedAt === null
    ? null
    : requireTimestamp(object.effectStartedAt, "effectStartedAt");
  const effectCompletedAt = object.effectCompletedAt === null
    ? null
    : requireTimestamp(object.effectCompletedAt, "effectCompletedAt");
  validateOperationTimestamps(
    effectState,
    authorizedAt,
    effectStartedAt,
    effectCompletedAt
  );
  return cloneAndFreeze({
    operationIdentity: requireNonEmptyString(
      object.operationIdentity,
      "operationIdentity"
    ),
    productRunId: requireNonEmptyString(object.productRunId, "productRunId"),
    toolCallId: requireNonEmptyString(object.toolCallId, "toolCallId"),
    conversationId: requireNonEmptyString(
      object.conversationId,
      "conversationId"
    ),
    piSessionId: requireNonEmptyString(object.piSessionId, "piSessionId"),
    vaultId: requireNonEmptyString(object.vaultId, "vaultId"),
    toolId: requireWriteToolId(object.toolId),
    toolVersion: requireNonEmptyString(object.toolVersion, "toolVersion"),
    policyVersion: requireNonEmptyString(
      object.policyVersion,
      "policyVersion"
    ),
    resolvedTarget: normalizeJsonValue(object.resolvedTarget, "resolvedTarget"),
    targetVersion: normalizeJsonValue(object.targetVersion, "targetVersion"),
    approvalTicketId: requireNonEmptyString(
      object.approvalTicketId,
      "approvalTicketId"
    ),
    authorizedAt,
    effectState,
    effectStartedAt,
    effectCompletedAt
  });
}

function normalizeDomainReceipt(value: unknown): DomainReceipt {
  const object = requireInputObject(value, "Domain Receipt");
  requireInputKeys(
    object,
    [
      "receiptId",
      "operationIdentity",
      "productRunId",
      "toolCallId",
      "conversationId",
      "piSessionId",
      "vaultId",
      "toolId",
      "toolVersion",
      "policyVersion",
      "resolvedTarget",
      "targetVersion",
      "approvalTicketId",
      "status",
      "safeSummary",
      "readback",
      "recoveryState",
      "recordedAt"
    ],
    [],
    "Domain Receipt"
  );
  const operationIdentity = requireNonEmptyString(
    object.operationIdentity,
    "operationIdentity"
  );
  const expectedReceiptId = `echoink-receipt_${stablePathToken(
    operationIdentity
  )}`;
  if (object.receiptId !== expectedReceiptId) {
    throw new PiNativeFileStoreError(
      "invalid-input",
      "Domain Receipt 的 receiptId 与 operationIdentity 不匹配"
    );
  }
  const status = requireReceiptStatus(object.status);
  const readback = normalizeReadbackSummary(object.readback);
  const toolId = requireWriteToolId(object.toolId);
  const targetVersion = normalizeJsonValue(object.targetVersion, "targetVersion");
  if (
    status === "completed"
    && receiptRequiresReadback(toolId, targetVersion)
    && !readback.readbackVerified
  ) {
    throw new PiNativeFileStoreError(
      "invalid-input",
      "completed Receipt 必须 readbackVerified=true"
    );
  }
  if (status === "uncertain" && readback.readbackVerified) {
    throw new PiNativeFileStoreError(
      "invalid-input",
      "uncertain Receipt 不能声明 Readback 已验证"
    );
  }
  return cloneAndFreeze({
    receiptId: expectedReceiptId,
    operationIdentity,
    productRunId: requireNonEmptyString(object.productRunId, "productRunId"),
    toolCallId: requireNonEmptyString(object.toolCallId, "toolCallId"),
    conversationId: requireNonEmptyString(
      object.conversationId,
      "conversationId"
    ),
    piSessionId: requireNonEmptyString(object.piSessionId, "piSessionId"),
    vaultId: requireNonEmptyString(object.vaultId, "vaultId"),
    toolId,
    toolVersion: requireNonEmptyString(object.toolVersion, "toolVersion"),
    policyVersion: requireNonEmptyString(
      object.policyVersion,
      "policyVersion"
    ),
    resolvedTarget: normalizeJsonValue(object.resolvedTarget, "resolvedTarget"),
    targetVersion,
    approvalTicketId: requireNonEmptyString(
      object.approvalTicketId,
      "approvalTicketId"
    ),
    status,
    safeSummary: normalizeJsonValue(object.safeSummary, "safeSummary"),
    readback,
    recoveryState: requireRecoveryState(object.recoveryState),
    recordedAt: requireTimestamp(object.recordedAt, "recordedAt")
  });
}

function sameOperationIdentityFields(
  left: DomainOperationJournal,
  right: DomainOperationJournal
): boolean {
  return isDeepStrictEqual(
    { ...left, effectState: undefined, effectStartedAt: undefined, effectCompletedAt: undefined },
    { ...right, effectState: undefined, effectStartedAt: undefined, effectCompletedAt: undefined }
  );
}

function validateOperationTimestamps(
  state: DomainOperationEffectState,
  authorizedAt: number,
  startedAt: number | null,
  completedAt: number | null
): void {
  if (state === "authorized" && (startedAt !== null || completedAt !== null)) {
    throw new PiNativeFileStoreError(
      "invalid-input",
      "authorized Journal 不能包含副作用时间"
    );
  }
  if (
    state === "effect_started"
    && (startedAt === null || completedAt !== null)
  ) {
    throw new PiNativeFileStoreError(
      "invalid-input",
      "effect_started Journal 必须只有 effectStartedAt"
    );
  }
  if (
    state === "effect_completed"
    && (startedAt === null || completedAt === null)
  ) {
    throw new PiNativeFileStoreError(
      "invalid-input",
      "effect_completed Journal 必须包含开始和完成时间"
    );
  }
  if (startedAt !== null && startedAt < authorizedAt) {
    throw new PiNativeFileStoreError(
      "invalid-input",
      "effectStartedAt 不能早于 authorizedAt"
    );
  }
  if (
    completedAt !== null
    && startedAt !== null
    && completedAt < startedAt
  ) {
    throw new PiNativeFileStoreError(
      "invalid-input",
      "effectCompletedAt 不能早于 effectStartedAt"
    );
  }
}

function requireReceiptStatus(value: unknown): DomainReceiptStatus {
  const status = requireNonEmptyString(value, "receipt.status");
  if (!RECEIPT_STATUSES.has(status)) {
    throw new PiNativeFileStoreError(
      "invalid-input",
      `不支持的 Receipt status ${status}`
    );
  }
  return status as DomainReceiptStatus;
}

function requireEffectState(value: unknown): DomainOperationEffectState {
  const state = requireNonEmptyString(value, "effectState");
  if (!EFFECT_STATES.has(state)) {
    throw new PiNativeFileStoreError(
      "invalid-input",
      `不支持的 effectState ${state}`
    );
  }
  return state as DomainOperationEffectState;
}

function requireRecoveryState(value: unknown): DomainReceiptRecoveryState {
  const state = requireNonEmptyString(value, "recoveryState");
  if (!RECOVERY_STATES.has(state)) {
    throw new PiNativeFileStoreError(
      "invalid-input",
      `不支持的 recoveryState ${state}`
    );
  }
  return state as DomainReceiptRecoveryState;
}

function requireWriteToolId(value: unknown): SideEffectApprovalToolId {
  const toolId = requireNonEmptyString(value, "toolId");
  if (!isSideEffectApprovalToolId(toolId)) {
    throw new PiNativeFileStoreError(
      "invalid-input",
      "Domain Receipt 只允许受控副作用 Tool"
    );
  }
  return toolId;
}

function operationRequiresReadback(operation: Pick<DomainOperationJournal, "toolId" | "targetVersion">): boolean {
  return receiptRequiresReadback(operation.toolId, operation.targetVersion);
}

function receiptRequiresReadback(
  toolId: SideEffectApprovalToolId,
  targetVersion: JsonValue
): boolean {
  if (!isMcpApprovalToolId(toolId)) return true;
  if (!targetVersion || typeof targetVersion !== "object" || Array.isArray(targetVersion)) {
    return false;
  }
  return (targetVersion as Readonly<Record<string, JsonValue>>).readbackRequired === true;
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

function requireInputKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  label: string
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      throw new PiNativeFileStoreError(
        "invalid-input",
        `${label} 缺少字段 ${key}`
      );
    }
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.has(key)) {
      throw new PiNativeFileStoreError(
        "invalid-input",
        `${label} 包含未声明字段 ${String(key)}`
      );
    }
  }
}

function storeCorrupt(label: string, error: unknown): PiNativeFileStoreError {
  return new PiNativeFileStoreError(
    "store-corrupt",
    `${label} 校验失败：${error instanceof Error ? error.message : String(error)}`
  );
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
