import { createHash } from "node:crypto";
import type { App } from "obsidian";
import {
  TEST_UNCERTAIN,
  TestUncertainInjectionError,
  type DomainReadbackSummary,
  type DomainReceiptRecoveryInspection,
  type DomainReceiptUiView,
  type FileDomainReceiptStore
} from "../harness/pi-native/domain-receipt-store";
import type {
  PiChatUiToolApprovalView,
  PiChatUiToolProductProjectionInput,
  PiChatUiToolReceiptStatus,
  PiChatUiToolReceiptView
} from "../harness/pi-native/pi-chat-ui-projector";
import {
  type ExecutePiVaultWriteInput,
  type PiVaultToolId,
  type PiVaultToolWriteExecutionPort
} from "../harness/pi-native/pi-vault-tool-contracts";
import {
  PiVaultToolAuthorizationError,
  type AuthorizePiVaultToolCallInput,
  type PiVaultToolAuthorizationPort
} from "../harness/pi-native/pi-vault-tool-security-extension";
import {
  canonicalJsonStringify,
  createReadToolAuthorizationContext,
  isMcpApprovalToolId,
  normalizeJsonValue,
  type ApprovalOperationContract,
  type ApprovalTicketState,
  type FileApprovalTicketStore,
  type JsonValue,
  type WriteToolAuthorizationContext
} from "../harness/pi-native/tool-authorization";
import {
  applyVaultFrontmatterPatch,
  type VaultDomainAdapter,
  type VaultFileSnapshot,
  type VaultOperationReadback,
  type VaultOperationResult,
  type VaultOperationStatus,
  type VaultReadbackState,
  type VaultDomainService
} from "../harness/pi-native/vault-domain-service";
import {
  VaultTargetResolutionError,
  VaultTargetResolver,
  type ResolvedVaultTarget
} from "../harness/pi-native/vault-target-resolver";
import { confirmModal } from "../ui/modals";

const APPROVAL_TTL_MS = 5 * 60 * 1000;
const APPROVAL_DIFF_LIMIT_BYTES = 12_000;
const APPROVAL_DIFF_CONTEXT_LINES = 3;

export interface PiVaultToolRunIdentity {
  readonly conversationId: string;
  readonly piSessionId: string;
  readonly productRunId: string;
  readonly vaultId: string;
}

export interface PiVaultApprovalConfirmationInput {
  readonly requestId: string;
  readonly conversationId: string;
  readonly piSessionId: string;
  readonly productRunId: string;
  readonly toolCallId: string;
  readonly toolId: PiVaultToolId;
  readonly target: JsonValue;
  readonly preview: JsonValue;
  readonly signal: AbortSignal | undefined;
}

export interface PiVaultApprovalConfirmationPort {
  confirm(input: Readonly<PiVaultApprovalConfirmationInput>): Promise<boolean>;
}

export interface CreatePiVaultProductionAuthorizationOptions {
  readonly approvals: FileApprovalTicketStore;
  readonly adapter: VaultDomainAdapter;
  readonly currentRunIdentity: () => Readonly<PiVaultToolRunIdentity>;
  readonly userId: string;
  readonly deviceId: string;
  readonly confirmation: PiVaultApprovalConfirmationPort;
  readonly now?: () => number;
  readonly approvalTtlMs?: number;
}

export interface CreatePiVaultProductionWriteExecutionOptions {
  readonly receipts: FileDomainReceiptStore;
  readonly domainService: VaultDomainService;
  readonly now?: () => number;
  readonly failureInjection?: (
    input: Readonly<ExecutePiVaultWriteInput>
  ) => typeof TEST_UNCERTAIN | undefined;
}

export function createObsidianPiVaultApprovalConfirmation(
  app: App
): PiVaultApprovalConfirmationPort {
  return Object.freeze({
    async confirm(input: Readonly<PiVaultApprovalConfirmationInput>) {
      return await confirmModal(
        app,
        `允许 ${input.toolId}？`,
        formatApprovalBody(input.target, input.preview),
        "确认执行",
        "拒绝",
        { signal: input.signal, preformatted: true }
      );
    }
  });
}

export function createPiVaultProductionAuthorizationPort(
  options: Readonly<CreatePiVaultProductionAuthorizationOptions>
): PiVaultToolAuthorizationPort {
  const resolver = new VaultTargetResolver(options.adapter);
  const now = options.now ?? Date.now;
  const ttlMs = options.approvalTtlMs ?? APPROVAL_TTL_MS;
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
    throw new TypeError("approval_ttl_invalid");
  }
  return Object.freeze({
    async authorize(input: Readonly<AuthorizePiVaultToolCallInput>) {
      if (input.signal?.aborted) {
        throw new PiVaultToolAuthorizationError("approval_cancelled");
      }
      const identity = requireRunIdentity(options.currentRunIdentity());
      if (identity.vaultId !== options.approvals.vaultId) {
        throw new PiVaultToolAuthorizationError("authorization_failed");
      }
      let target: ResolvedAuthorizationTarget;
      try {
        target = await resolveAuthorizationTarget(
          resolver,
          options.adapter,
          identity.vaultId,
          input.toolId,
          input.arguments
        );
      } catch (error) {
        if (error instanceof VaultTargetResolutionError) {
          // Missing/wrong-kind targets are local resolution failures, not policy denials.
          // Only safe categories cross this boundary; paths and adapter messages do not.
          throw new PiVaultToolAuthorizationError(
            error.code === "target_not_found" || error.code === "target_kind_invalid"
              ? error.code
              : "tool_policy_blocked"
          );
        }
        throw error;
      }
      if (input.signal?.aborted) {
        throw new PiVaultToolAuthorizationError("approval_cancelled");
      }
      const normalizedArguments = normalizeJsonValue(input.arguments);
      if (input.policy.effectType === "read") {
        return createReadToolAuthorizationContext({
          ...identity,
          toolCallId: input.toolCallId,
          userId: options.userId,
          deviceId: options.deviceId,
          toolId: input.toolId as "vault_search" | "note_read",
          toolVersion: input.toolVersion,
          policyVersion: input.policyVersion,
          normalizedArguments,
          resolvedTarget: target.resolvedTarget,
          targetVersion: target.targetVersion,
          authorizedAt: now()
        });
      }
      if (input.signal?.aborted) {
        throw new PiVaultToolAuthorizationError("approval_cancelled");
      }
      const issuedAt = now();
      const contract: ApprovalOperationContract = {
        ...identity,
        toolCallId: input.toolCallId,
        userId: options.userId,
        deviceId: options.deviceId,
        toolId: input.toolId as ApprovalOperationContract["toolId"],
        toolVersion: input.toolVersion,
        policyVersion: input.policyVersion,
        normalizedArguments,
        resolvedTarget: target.resolvedTarget,
        targetVersion: target.targetVersion,
        preview: target.preview
      };
      const ticket = await options.approvals.issue({
        ...contract,
        issuedAt,
        expiresAt: issuedAt + ttlMs
      });
      let accepted = false;
      try {
        accepted = await options.confirmation.confirm({
          requestId: ticket.ticketId,
          conversationId: ticket.conversationId,
          piSessionId: ticket.piSessionId,
          productRunId: ticket.productRunId,
          toolCallId: ticket.toolCallId,
          toolId: input.toolId,
          target: target.resolvedTarget,
          preview: target.preview,
          signal: input.signal
        });
      } catch {
        await resolvePendingTicket(
          options.approvals,
          ticket,
          "cancelled"
        );
        throw new PiVaultToolAuthorizationError("approval_cancelled");
      }
      if (!accepted || input.signal?.aborted) {
        const resolution = input.signal?.aborted ? "cancelled" : "denied";
        await resolvePendingTicket(options.approvals, ticket, resolution);
        throw new PiVaultToolAuthorizationError(
          resolution === "cancelled" ? "approval_cancelled" : "approval_denied"
        );
      }
      return await options.approvals.consume({
        ticketId: ticket.ticketId,
        operationIdentity: ticket.operationIdentity,
        contract
      });
    }
  });
}

export function createPiVaultProductionWriteExecutionPort(
  options: Readonly<CreatePiVaultProductionWriteExecutionOptions>
): PiVaultToolWriteExecutionPort {
  const now = options.now ?? Date.now;
  const port: PiVaultToolWriteExecutionPort = {
    async execute(input, invokeDomainOnce) {
      await options.receipts.beginAuthorizedOperation(input.authorization);
      let result: Readonly<VaultOperationResult>;
      try {
        result = await invokeDomainOnce(async () => {
          await options.receipts.markEffectStarted(
            input.authorization.operationIdentity
          );
        });
      } catch (error) {
        result = await resultAfterDomainFailure(
          options,
          input,
          error,
          now
        );
      }
      const operation = await options.receipts.readOperation(
        input.authorization.operationIdentity
      );
      if (!operation) throw new Error("domain_operation_journal_missing");
      if (result.sideEffectStarted) {
        if (operation.effectState !== "effect_started") {
          throw new Error("domain_effect_journal_mismatch");
        }
        await options.receipts.markEffectCompleted(
          input.authorization.operationIdentity
        );
      } else if (operation.effectState !== "authorized") {
        result = uncertainOperationResult(
          result,
          "domain_effect_journal_mismatch"
        );
        if (operation.effectState === "effect_started") {
          await options.receipts.markEffectCompleted(
            input.authorization.operationIdentity
          );
        }
      }
      input.onVerifying();
      const receiptInput = receiptInputFromResult(result, now());
      try {
        await options.receipts.persistReceipt({
          ...receiptInput,
          ...(result.sideEffectStarted
            && options.failureInjection?.(input) === TEST_UNCERTAIN
            ? { failureInjection: TEST_UNCERTAIN }
            : {})
        });
        return result;
      } catch (error) {
        if (
          error instanceof TestUncertainInjectionError
          || result.sideEffectStarted
        ) {
          return uncertainOperationResult(
            result,
            "receipt_persistence_uncertain"
          );
        }
        throw error;
      }
    }
  };
  return Object.freeze(port);
}

export async function recoverPiVaultDomainReceipts(input: {
  readonly receipts: FileDomainReceiptStore;
  readonly domainService: VaultDomainService;
  readonly now?: () => number;
}): Promise<void> {
  const now = input.now ?? Date.now;
  const pending = await input.receipts.listPendingRecovery();
  for (const view of pending) {
    if (isMcpApprovalToolId(view.toolId)) continue;
    const inspection = await input.receipts.inspectRecovery(
      view.operationIdentity
    );
    if (inspection.state === "not_started") {
      const readback = await readbackForRecovery(
        input.domainService,
        inspection
      );
      await input.receipts.persistReceipt({
        operationIdentity: view.operationIdentity,
        status: "cancelled",
        safeSummary: safeReadbackSummary(readback.readback, {
          reason: "recovered_before_side_effect"
        }),
        readback: domainReadbackSummary(readback.readback, false, now())
      });
      continue;
    }
    if (inspection.state !== "readback_required") continue;
    await input.receipts.recoverMissingReceipt(
      view.operationIdentity,
      async (context) => {
        const observed = await readbackForRecovery(
          input.domainService,
          inspection
        );
        const classification = classifyRecoveredEffect(
          context.toolId,
          context.targetVersion,
          observed.readback
        );
        return {
          status: classification.status,
          safeSummary: safeReadbackSummary(observed.readback, {
            reason: classification.reason
          }),
          readback: domainReadbackSummary(
            observed.readback,
            classification.readbackVerified,
            now()
          )
        };
      }
    );
  }
}

export async function loadPiVaultToolProductState(input: {
  readonly approvals: FileApprovalTicketStore;
  readonly receipts: FileDomainReceiptStore;
  readonly conversationId: string;
  readonly piSessionId: string;
  readonly productRunId?: string;
}): Promise<Readonly<PiChatUiToolProductProjectionInput>> {
  const [approvalStates, receiptViews] = await Promise.all([
    input.approvals.listViews({
      conversationId: input.conversationId,
      ...(input.productRunId ? { productRunId: input.productRunId } : {})
    }),
    input.receipts.listUiViews({
      conversationId: input.conversationId,
      ...(input.productRunId ? { productRunId: input.productRunId } : {})
    })
  ]);
  return Object.freeze({
    approvals: Object.freeze(approvalStates.map(approvalUiView)),
    receipts: Object.freeze(receiptViews.map(receiptUiView))
  });
}

export async function hasPendingPiVaultProductWork(input: {
  readonly approvals: FileApprovalTicketStore;
  readonly receipts: FileDomainReceiptStore;
  readonly conversationId: string;
  readonly productRunId: string;
}): Promise<boolean> {
  const [approvals, receiptViews] = await Promise.all([
    input.approvals.listViews({
      conversationId: input.conversationId,
      productRunId: input.productRunId,
      statuses: ["pending", "approved"]
    }),
    input.receipts.listUiViews({
      conversationId: input.conversationId,
      productRunId: input.productRunId
    })
  ]);
  if (approvals.some((state) => state.status === "pending")) return true;
  if (receiptViews.some((view) => view.receipt === null)) return true;
  const receiptCalls = new Set(receiptViews.map((view) => view.toolCallId));
  return approvals.some((state) =>
    state.status === "approved"
    && state.ticket.toolId !== "knowledge_maintain"
    && !receiptCalls.has(state.ticket.toolCallId)
  );
}

export function localPiVaultUserId(deviceId: string): string {
  return createHash("sha256")
    .update(`echoink-local-user-v1\0${deviceId}`, "utf8")
    .digest("hex");
}

interface ResolvedAuthorizationTarget {
  readonly resolvedTarget: JsonValue;
  readonly targetVersion: JsonValue;
  readonly preview: JsonValue;
}

async function resolveAuthorizationTarget(
  resolver: VaultTargetResolver,
  adapter: VaultDomainAdapter,
  vaultId: string,
  toolId: PiVaultToolId,
  args: Readonly<Record<string, unknown>>
): Promise<ResolvedAuthorizationTarget> {
  if (toolId === "vault_search") {
    const scope = await resolver.resolve({
      vaultId,
      relativePath: optionalString(args.scopePath) ?? "",
      allowRoot: true,
      mustExist: true,
      expectedKind: "directory"
    });
    return freezeTarget({
      resolvedTarget: { scopePath: scope.relativePath },
      targetVersion: null,
      preview: { query: requireString(args.query), scopePath: scope.relativePath }
    });
  }
  if (toolId === "note_move") {
    const source = await resolver.resolve({
      vaultId,
      relativePath: requireString(args.sourcePath),
      mustExist: true,
      expectedKind: "file"
    });
    const target = await resolver.resolve({
      vaultId,
      relativePath: requireString(args.targetPath),
      mustExist: false,
      expectedKind: "file"
    });
    if (target.exists) {
      throw new PiVaultToolAuthorizationError("tool_policy_blocked");
    }
    const snapshot = await requireSnapshot(adapter, source, 0);
    return freezeTarget({
      resolvedTarget: {
        sourcePath: source.relativePath,
        targetPath: target.relativePath
      },
      targetVersion: {
        sourceBeforeVersion: snapshot.version,
        expectedContentSha256: snapshot.contentSha256,
        targetBeforeVersion: null
      },
      preview: {
        operation: toolId,
        sourcePath: source.relativePath,
        targetPath: target.relativePath,
        expectedVersion: requireString(args.expectedVersion)
      }
    });
  }
  const relativePath = requireString(args.relativePath);
  const create = toolId === "note_create";
  const target = await resolver.resolve({
    vaultId,
    relativePath,
    mustExist: !create,
    allowMissingParentDirectories: create,
    expectedKind: "file"
  });
  if (create && target.exists) {
    throw new PiVaultToolAuthorizationError("tool_policy_blocked");
  }
  if (toolId === "note_read") {
    return freezeTarget({
      resolvedTarget: { relativePath: target.relativePath },
      targetVersion: null,
      preview: { operation: toolId, relativePath: target.relativePath }
    });
  }
  const snapshot = create
    ? null
    : await requireSnapshot(
      adapter,
      target,
      toolId === "note_update" ? undefined : 0
    );
  if (toolId === "note_create" || toolId === "note_update") {
    const content = requireString(args.content);
    const contentSha256 = sha256(content);
    const change = buildVaultContentDiffPreview(
      target.relativePath,
      snapshot?.content ?? "",
      content,
      toolId === "note_create" ? "add" : "update"
    );
    return freezeTarget({
      resolvedTarget: { relativePath: target.relativePath },
      targetVersion: {
        beforeVersion: snapshot?.version ?? null,
        expectedAfterSha256: contentSha256
      },
      preview: {
        operation: toolId,
        relativePath: target.relativePath,
        ...(toolId === "note_update"
          ? { expectedVersion: requireString(args.expectedVersion) }
          : {}),
        change,
        byteLength: Buffer.byteLength(content, "utf8"),
        contentSha256
      }
    });
  }
  if (toolId === "metadata_update") {
    const full = await requireSnapshot(adapter, target);
    const patch = args.patch as Parameters<typeof applyVaultFrontmatterPatch>[1];
    const after = applyVaultFrontmatterPatch(full.content, patch);
    const afterSha256 = sha256(after);
    const change = buildVaultContentDiffPreview(
      target.relativePath,
      full.content,
      after,
      "update"
    );
    return freezeTarget({
      resolvedTarget: { relativePath: target.relativePath },
      targetVersion: {
        beforeVersion: full.version,
        expectedAfterSha256: afterSha256
      },
      preview: {
        operation: toolId,
        relativePath: target.relativePath,
        expectedVersion: requireString(args.expectedVersion),
        patch: normalizeJsonValue(args.patch),
        change,
        expectedAfterSha256: afterSha256
      }
    });
  }
  return freezeTarget({
    resolvedTarget: { relativePath: target.relativePath },
    targetVersion: {
      beforeVersion: snapshot?.version ?? null,
      expectedContentSha256: snapshot?.contentSha256 ?? null
    },
    preview: {
      operation: toolId,
      relativePath: target.relativePath,
      expectedVersion: requireString(args.expectedVersion),
      recoverableTrashOnly: true
    }
  });
}

async function requireSnapshot(
  adapter: VaultDomainAdapter,
  target: Readonly<ResolvedVaultTarget>,
  maxBytes?: number
): Promise<Readonly<VaultFileSnapshot>> {
  const snapshot = await adapter.readFile(
    target,
    maxBytes === undefined ? {} : { maxBytes }
  );
  if (!snapshot) throw new PiVaultToolAuthorizationError("tool_policy_blocked");
  return snapshot;
}

async function resultAfterDomainFailure(
  options: Readonly<CreatePiVaultProductionWriteExecutionOptions>,
  input: Readonly<ExecutePiVaultWriteInput>,
  error: unknown,
  now: () => number
): Promise<Readonly<VaultOperationResult>> {
  const operation = await options.receipts.readOperation(
    input.authorization.operationIdentity
  );
  const readback = await readbackForAuthorization(
    options.domainService,
    input.authorization
  );
  const effectStarted = operation?.effectState === "effect_started"
    || operation?.effectState === "effect_completed";
  const status: VaultOperationStatus = effectStarted
    ? "uncertain"
    : input.signal?.aborted
      ? "cancelled"
      : "failed";
  void now;
  return Object.freeze({
    operationIdentity: input.authorization.operationIdentity,
    operation: input.toolId,
    status,
    sourcePath: readback.sourcePath,
    ...(readback.targetPath ? { targetPath: readback.targetPath } : {}),
    sideEffectStarted: effectStarted,
    readbackVerified: false,
    readback: readback.readback,
    error: Object.freeze({
      code: status === "cancelled" ? "operation_cancelled" : "vault_tool_execution_failed",
      message: safeErrorMessage(error)
    })
  });
}

function receiptInputFromResult(
  result: Readonly<VaultOperationResult>,
  checkedAt: number
) {
  return Object.freeze({
    operationIdentity: result.operationIdentity,
    status: result.status,
    safeSummary: safeOperationSummary(result),
    readback: domainReadbackSummary(
      result.readback,
      result.readbackVerified,
      checkedAt
    )
  });
}

function domainReadbackSummary(
  readback: Readonly<VaultOperationReadback>,
  readbackVerified: boolean,
  checkedAt: number
): DomainReadbackSummary {
  return Object.freeze({
    checkedAt,
    readbackVerified,
    observedTargetVersion: observedVersions(readback),
    safeSummary: safeReadbackSummary(readback)
  });
}

function safeOperationSummary(result: Readonly<VaultOperationResult>): JsonValue {
  return normalizeJsonValue({
    operation: result.operation,
    status: result.status,
    sourcePath: result.sourcePath,
    ...(result.targetPath ? { targetPath: result.targetPath } : {}),
    sideEffectStarted: result.sideEffectStarted,
    readbackVerified: result.readbackVerified,
    ...(result.error ? { errorCode: result.error.code } : {}),
    readback: safeReadbackSummary(result.readback)
  });
}

function safeReadbackSummary(
  readback: Readonly<VaultOperationReadback>,
  extra: Readonly<Record<string, JsonValue>> = {}
): JsonValue {
  return normalizeJsonValue({
    ...extra,
    source: safeReadbackState(readback.source),
    ...(readback.target ? { target: safeReadbackState(readback.target) } : {}),
    ...(readback.trash
      ? {
          trash: {
            kind: readback.trash.kind,
            originalRelativePath: readback.trash.originalRelativePath,
            ...(readback.trash.trashRelativePath
              ? { trashRelativePath: readback.trash.trashRelativePath }
              : {})
          }
        }
      : {})
  });
}

function safeReadbackState(state: Readonly<VaultReadbackState>): JsonValue {
  return normalizeJsonValue({
    status: state.status,
    ...(state.snapshot
      ? {
          relativePath: state.snapshot.relativePath,
          version: state.snapshot.version,
          contentSha256: state.snapshot.contentSha256,
          byteLength: state.snapshot.byteLength,
          truncated: state.snapshot.truncated
        }
      : {}),
    ...(state.error ? { errorCode: state.error.code } : {})
  });
}

function observedVersions(readback: Readonly<VaultOperationReadback>): JsonValue {
  return normalizeJsonValue({
    source: readback.source.snapshot?.version ?? null,
    ...(readback.target
      ? { target: readback.target.snapshot?.version ?? null }
      : {})
  });
}

function uncertainOperationResult(
  result: Readonly<VaultOperationResult>,
  code: string
): Readonly<VaultOperationResult> {
  return Object.freeze({
    ...result,
    status: "uncertain",
    readbackVerified: false,
    error: Object.freeze({ code, message: code })
  });
}

async function readbackForAuthorization(
  domainService: VaultDomainService,
  authorization: Readonly<WriteToolAuthorizationContext>
): Promise<ResolvedReadback> {
  const paths = targetPaths(authorization.resolvedTarget);
  const source = await domainService.readback({
    vaultId: authorization.vaultId,
    relativePath: paths.sourcePath
  });
  const target = paths.targetPath
    ? await domainService.readback({
        vaultId: authorization.vaultId,
        relativePath: paths.targetPath
      })
    : undefined;
  return Object.freeze({
    ...paths,
    readback: Object.freeze({ source, ...(target ? { target } : {}) })
  });
}

async function readbackForRecovery(
  domainService: VaultDomainService,
  inspection: Exclude<
    DomainReceiptRecoveryInspection,
    { state: "not_found" | "receipt_present" }
  >
): Promise<ResolvedReadback> {
  const paths = targetPaths(inspection.operation.resolvedTarget);
  const source = await domainService.readback({
    vaultId: inspection.operation.vaultId,
    relativePath: paths.sourcePath
  });
  const target = paths.targetPath
    ? await domainService.readback({
        vaultId: inspection.operation.vaultId,
        relativePath: paths.targetPath
      })
    : undefined;
  return Object.freeze({
    ...paths,
    readback: Object.freeze({ source, ...(target ? { target } : {}) })
  });
}

interface ResolvedReadback {
  readonly sourcePath: string;
  readonly targetPath?: string;
  readonly readback: Readonly<VaultOperationReadback>;
}

function classifyRecoveredEffect(
  toolId: string,
  targetVersion: JsonValue,
  readback: Readonly<VaultOperationReadback>
): Readonly<{
  status: "completed" | "failed" | "uncertain";
  readbackVerified: boolean;
  reason: string;
}> {
  const expected = plainRecord(targetVersion);
  const source = readback.source;
  const target = readback.target;
  const afterSha = stringOrNull(expected.expectedAfterSha256);
  const beforeVersion = stringOrNull(expected.beforeVersion);
  if (toolId === "note_create" || toolId === "note_update" || toolId === "metadata_update") {
    if (source.status === "present" && source.snapshot?.contentSha256 === afterSha) {
      return Object.freeze({
        status: "completed",
        readbackVerified: true,
        reason: "expected_content_present"
      });
    }
    if (
      (toolId === "note_create" && source.status === "missing")
      || (source.status === "present" && source.snapshot?.version === beforeVersion)
    ) {
      return Object.freeze({
        status: "failed",
        readbackVerified: true,
        reason: "side_effect_not_observed"
      });
    }
  }
  if (toolId === "note_move") {
    const contentSha = stringOrNull(expected.expectedContentSha256);
    if (
      source.status === "missing"
      && target?.status === "present"
      && target.snapshot?.contentSha256 === contentSha
    ) {
      return Object.freeze({
        status: "completed",
        readbackVerified: true,
        reason: "move_target_verified"
      });
    }
    if (
      source.status === "present"
      && source.snapshot?.contentSha256 === contentSha
      && target?.status === "missing"
    ) {
      return Object.freeze({
        status: "failed",
        readbackVerified: true,
        reason: "move_not_observed"
      });
    }
  }
  if (toolId === "note_delete" && source.status === "present") {
    const contentSha = stringOrNull(expected.expectedContentSha256);
    if (source.snapshot?.contentSha256 === contentSha) {
      return Object.freeze({
        status: "failed",
        readbackVerified: true,
        reason: "delete_not_observed"
      });
    }
  }
  return Object.freeze({
    status: "uncertain",
    readbackVerified: false,
    reason: "readback_not_conclusive"
  });
}

function approvalUiView(state: Readonly<ApprovalTicketState>): PiChatUiToolApprovalView {
  return Object.freeze({
    piSessionId: state.ticket.piSessionId,
    toolCallId: state.ticket.toolCallId,
    productRunId: state.ticket.productRunId,
    operationIdentity: state.ticket.operationIdentity,
    status: state.status,
    target: jsonDisplay(state.ticket.resolvedTarget),
    preview: jsonDisplay(state.ticket.preview),
    updatedAt: state.consumedAt ?? state.resolvedAt ?? state.ticket.issuedAt
  });
}

function receiptUiView(view: Readonly<DomainReceiptUiView>): PiChatUiToolReceiptView {
  const status: PiChatUiToolReceiptStatus = view.receipt?.status
    ?? (view.effectState === "effect_completed"
      ? "uncertain"
      : view.effectState === "effect_started"
        ? "verifying"
        : "running");
  return Object.freeze({
    piSessionId: view.piSessionId,
    toolCallId: view.toolCallId,
    productRunId: view.productRunId,
    operationIdentity: view.operationIdentity,
    status,
    readbackVerified: view.receipt?.readback.readbackVerified ?? false,
    readbackRequired: view.readbackRequired,
    target: jsonDisplay(view.resolvedTarget),
    ...(view.receipt
      ? {
          summary: jsonDisplay(view.receipt.safeSummary),
          readbackSummary: jsonDisplay(view.receipt.readback.safeSummary),
          updatedAt: view.receipt.recordedAt
        }
      : {})
  });
}

async function resolvePendingTicket(
  approvals: FileApprovalTicketStore,
  ticket: Readonly<{ productRunId: string; toolCallId: string; ticketId: string }>,
  resolution: "denied" | "cancelled"
): Promise<void> {
  await approvals.resolve({
    productRunId: ticket.productRunId,
    toolCallId: ticket.toolCallId,
    ticketId: ticket.ticketId,
    resolution
  });
}

function targetPaths(value: JsonValue): Readonly<{
  sourcePath: string;
  targetPath?: string;
}> {
  const target = plainRecord(value);
  if (typeof target.relativePath === "string" && target.relativePath) {
    return Object.freeze({ sourcePath: target.relativePath });
  }
  if (typeof target.sourcePath === "string" && target.sourcePath) {
    return Object.freeze({
      sourcePath: target.sourcePath,
      ...(typeof target.targetPath === "string" && target.targetPath
        ? { targetPath: target.targetPath }
        : {})
    });
  }
  throw new Error("resolved_vault_target_invalid");
}

function requireRunIdentity(
  value: Readonly<PiVaultToolRunIdentity>
): Readonly<PiVaultToolRunIdentity> {
  return Object.freeze({
    conversationId: nonEmpty(value.conversationId),
    piSessionId: nonEmpty(value.piSessionId),
    productRunId: nonEmpty(value.productRunId),
    vaultId: nonEmpty(value.vaultId)
  });
}

function freezeTarget(input: ResolvedAuthorizationTarget): ResolvedAuthorizationTarget {
  return Object.freeze({
    resolvedTarget: normalizeJsonValue(input.resolvedTarget),
    targetVersion: normalizeJsonValue(input.targetVersion),
    preview: normalizeJsonValue(input.preview)
  });
}



function formatApprovalBody(target: JsonValue, preview: JsonValue): string {
  const previewRecord = plainRecord(preview);
  const change = plainRecord(previewRecord.change);
  const diff = typeof change.diff === "string" ? change.diff : "";
  const displayPreview = diff
    ? {
        ...previewRecord,
        change: Object.fromEntries(
          Object.entries(change).filter(([key]) => key !== "diff")
        )
      }
    : preview;
  return [
    `目标：\n${prettyJsonDisplay(target)}`,
    `预览：\n${prettyJsonDisplay(normalizeJsonValue(displayPreview))}`,
    ...(diff ? [`差异：\n${diff}`] : [])
  ].join("\n\n");
}

function jsonDisplay(value: JsonValue): string {
  return canonicalJsonStringify(value);
}

function prettyJsonDisplay(value: JsonValue): string {
  return JSON.stringify(value, null, 2) ?? "null";
}

function buildVaultContentDiffPreview(
  relativePath: string,
  before: string,
  after: string,
  kind: "add" | "update"
): JsonValue {
  const beforeLines = splitPreviewLines(before);
  const afterLines = splitPreviewLines(after);
  let prefix = 0;
  while (
    prefix < beforeLines.length
    && prefix < afterLines.length
    && beforeLines[prefix] === afterLines[prefix]
  ) prefix += 1;
  let suffix = 0;
  while (
    suffix < beforeLines.length - prefix
    && suffix < afterLines.length - prefix
    && beforeLines[beforeLines.length - suffix - 1]
      === afterLines[afterLines.length - suffix - 1]
  ) suffix += 1;
  const removed = beforeLines.slice(prefix, beforeLines.length - suffix);
  const added = afterLines.slice(prefix, afterLines.length - suffix);
  const contextBefore = beforeLines.slice(
    Math.max(0, prefix - APPROVAL_DIFF_CONTEXT_LINES),
    prefix
  );
  const contextAfter = beforeLines.slice(
    beforeLines.length - suffix,
    Math.min(
      beforeLines.length,
      beforeLines.length - suffix + APPROVAL_DIFF_CONTEXT_LINES
    )
  );
  const oldStart = Math.max(1, prefix - contextBefore.length + 1);
  const newStart = oldStart;
  const oldCount = contextBefore.length + removed.length + contextAfter.length;
  const newCount = contextBefore.length + added.length + contextAfter.length;
  const rawDiff = [
    `--- a/${relativePath}`,
    `+++ b/${relativePath}`,
    `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`,
    ...contextBefore.map((line) => ` ${line}`),
    ...removed.map((line) => `-${line}`),
    ...added.map((line) => `+${line}`),
    ...contextAfter.map((line) => ` ${line}`)
  ].join("\n");
  const limited = truncateApprovalDiff(rawDiff);
  return normalizeJsonValue({
    kind,
    relativePath,
    added: added.length,
    removed: removed.length,
    diff: limited.text,
    truncated: limited.truncated
  });
}

function splitPreviewLines(value: string): string[] {
  if (!value) return [];
  return value.replaceAll("\r\n", "\n").split("\n");
}

function truncateApprovalDiff(value: string): Readonly<{
  text: string;
  truncated: boolean;
}> {
  if (Buffer.byteLength(value, "utf8") <= APPROVAL_DIFF_LIMIT_BYTES) {
    return Object.freeze({ text: value, truncated: false });
  }
  const marker = "\n[DIFF_PREVIEW_TRUNCATED]";
  const prefixLimit = APPROVAL_DIFF_LIMIT_BYTES
    - Buffer.byteLength(marker, "utf8");
  let prefix = "";
  let byteLength = 0;
  for (const scalar of value) {
    const scalarBytes = Buffer.byteLength(scalar, "utf8");
    if (byteLength + scalarBytes > prefixLimit) break;
    prefix += scalar;
    byteLength += scalarBytes;
  }
  return Object.freeze({ text: `${prefix}${marker}`, truncated: true });
}

function plainRecord(value: JsonValue): Record<string, JsonValue> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, JsonValue>;
}

function stringOrNull(value: JsonValue | undefined): string | null {
  return typeof value === "string" ? value : null;
}

function requireString(value: unknown): string {
  if (typeof value !== "string") throw new TypeError("vault_tool_schema_invalid");
  return value;
}

function optionalString(value: unknown): string | undefined {
  return value === undefined ? undefined : requireString(value);
}

function nonEmpty(value: string): string {
  const normalized = value.trim();
  if (!normalized) throw new TypeError("vault_tool_identity_invalid");
  return normalized;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    const code = error && typeof error === "object" && "code" in error
      ? String((error as { code: unknown }).code)
      : error.message;
    return code || "vault_tool_execution_failed";
  }
  return "vault_tool_execution_failed";
}
