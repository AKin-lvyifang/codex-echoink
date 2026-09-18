import { knowledgeRolePath } from "./root-paths";
import { createHash, randomUUID } from "node:crypto";
import type {
  VaultDomainService,
  VaultOperationResult,
  VaultReadbackState
} from "../harness/pi-native/vault-domain-service";
import { normalizeVaultRelativePath } from "../harness/pi-native/vault-target-resolver";
import {
  ECHOINK_KNOWLEDGE_MAINTENANCE_PROTOCOL_VERSION,
  validateKnowledgeMaintenanceCandidateSources
} from "./knowledge-maintenance-protocol";
import {
  knowledgeMaintenanceNoteFromReadback,
  type KnowledgeMaintenanceResultNote
} from "./knowledge-maintenance-result";

export const PHASE3_MAINTENANCE_SOURCE_LIMIT = 20;
export const PHASE3_MAINTENANCE_TRACKER_PATH =
  "outputs/.ingest-tracker.md";
export const PHASE3_MAINTENANCE_RAW_INDEX_PATH = "raw/index.md";
export const PHASE3_MAINTENANCE_WORKFLOW_ROOT =
  ".echoink/knowledge-maintenance";

const SHA256 = /^[a-f0-9]{64}$/u;
const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/u;
export const PHASE3_MAINTENANCE_RECOVERED_RETRY_MESSAGE =
  "Previous maintenance WAL was recovered; run /maintain again to rebuild candidates";

export type Phase3MaintenanceSourceMode = "explicit" | "tracker";

export type Phase3MaintenanceErrorCode =
  | "invalid_input"
  | "invalid_raw_path"
  | "proposal_invalid"
  | "preview_not_found"
  | "preview_inactive"
  | "preview_stale"
  | "approval_failed"
  | "wal_conflict"
  | "write_failed"
  | "write_uncertain"
  | "recovery_blocked";

export class Phase3MaintenanceError extends Error {
  constructor(
    readonly code: Phase3MaintenanceErrorCode,
    message: string,
    readonly relativePath?: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "Phase3MaintenanceError";
  }
}

/** The only Phase 3 crash point required by the frozen contract. */
export class Phase3MaintenanceSimulatedReload extends Error {
  constructor(message = "simulated reload after WAL persistence") {
    super(message);
    this.name = "Phase3MaintenanceSimulatedReload";
  }
}

export interface Phase3MaintenanceImmutableFileBinding {
  kind: "file";
  relativePath: string;
  revision: string;
  contentSha256: string;
  byteLength: number;
}

export interface Phase3MaintenanceSourceBinding {
  raw: Readonly<Phase3MaintenanceImmutableFileBinding>;
  attachments: readonly Readonly<Phase3MaintenanceImmutableFileBinding>[];
}

export type Phase3MaintenanceTargetBinding =
  | { kind: "missing" }
  | {
      kind: "file";
      version: string;
      contentSha256: string;
      byteLength: number;
    };

export interface Phase3MaintenanceTrackerSnapshot {
  binding: Readonly<Phase3MaintenanceTargetBinding>;
  changedRawPaths: readonly string[];
}

export interface Phase3MaintenanceProposalAction {
  targetPath: string;
  content: string;
  expectedTarget?: Readonly<
    | { kind: "missing" }
    | { kind: "file"; contentRevision: string }
  >;
}

export interface Phase3MaintenanceProposal {
  /** Existing Shadow attempt/control identity. */
  shadowId: string;
  /** Sealed Shadow/change-set digest. */
  shadowRevision: string;
  actions: readonly Readonly<Phase3MaintenanceProposalAction>[];
}

export interface Phase3MaintenanceProposalInput {
  protocolVersion: typeof ECHOINK_KNOWLEDGE_MAINTENANCE_PROTOCOL_VERSION;
  preferenceProfileVersion: string;
  preferenceState: "default" | "custom";
  preferenceRevision: string;
  previewId: string;
  vaultId: string;
  dateKey: string;
  sourceMode: Phase3MaintenanceSourceMode;
  selectedSources: readonly Readonly<Phase3MaintenanceSourceBinding>[];
  remainingRawPaths: readonly string[];
  tracker: Readonly<Phase3MaintenanceTrackerSnapshot>;
  reportPath: string;
}

/**
 * Production implementations generate only inside the existing maintenance
 * Shadow. Calling this port is the sole model/Agent generation step; WAL
 * recovery never calls it.
 */
export interface Phase3MaintenanceProposalPort {
  generate(
    input: Readonly<Phase3MaintenanceProposalInput>
  ): Promise<Readonly<Phase3MaintenanceProposal>>;
}

/**
 * Uses the existing Shadow baseline/read fence to bind one Raw file and all of
 * its attachments. It must reject missing, linked, non-regular, or unsafe
 * entries and hash the original bytes without rewriting them.
 */
export interface Phase3MaintenanceSourceSnapshotPort {
  snapshotRaw(input: Readonly<{
    vaultId: string;
    relativePath: string;
  }>): Promise<Readonly<Phase3MaintenanceSourceBinding>>;
}

/** Parses the existing ingest tracker and returns the revision it parsed. */
export interface Phase3MaintenanceTrackerPort {
  snapshot(input: Readonly<{
    vaultId: string;
  }>): Promise<Readonly<Phase3MaintenanceTrackerSnapshot>>;
}

export interface Phase3MaintenanceConfirmToolCallContext {
  productRunId: string;
  toolCallId: string;
  conversationId: string;
  piSessionId: string;
  vaultId: string;
  userId: string;
  deviceId: string;
}

export interface Phase3MaintenanceApprovalContract
  extends Phase3MaintenanceConfirmToolCallContext {
  previewId: string;
  previewDigest: string;
  preferenceProfileVersion: string;
  preferenceState: "default" | "custom";
  preferenceRevision: string;
  orderedActions: readonly Readonly<Phase3MaintenanceAction>[];
}

export interface Phase3MaintenanceBatchApprovalInput
  extends Phase3MaintenanceApprovalContract {
  signal?: AbortSignal;
}

export interface Phase3MaintenanceBatchAuthorization {
  approvalId: string;
  operationIdentity: string;
  consumedAt: number;
  contract: Readonly<Phase3MaintenanceApprovalContract>;
}

/**
 * One Phase 2 EchoInkApprovalTicket binds the current confirm Tool Call and
 * complete ordered batch. The adapter performs issue -> UI confirmation ->
 * exact single consume inside this call and returns only the consumed proof.
 */
export interface Phase3MaintenanceBatchApprovalPort {
  authorize(
    input: Readonly<Phase3MaintenanceBatchApprovalInput>
  ): Promise<Readonly<Phase3MaintenanceBatchAuthorization>>;
}

export type Phase3MaintenanceVaultDomain = Pick<
  VaultDomainService,
  "readback" | "noteCreate" | "noteUpdate"
>;

export interface Phase3MaintenanceAction {
  actionId: string;
  operation: "create" | "update";
  targetPath: string;
  content: string;
  contentSha256: string;
  expected: Readonly<Phase3MaintenanceTargetBinding>;
}

export interface Phase3MaintenancePreview {
  protocolVersion: typeof ECHOINK_KNOWLEDGE_MAINTENANCE_PROTOCOL_VERSION;
  preferenceProfileVersion: string;
  preferenceState: "default" | "custom";
  preferenceRevision: string;
  previewId: string;
  previewDigest: string;
  vaultId: string;
  dateKey: string;
  sourceMode: Phase3MaintenanceSourceMode;
  selectedSources: readonly Readonly<Phase3MaintenanceSourceBinding>[];
  remainingRawPaths: readonly string[];
  tracker: Readonly<Phase3MaintenanceTrackerSnapshot>;
  shadowId: string;
  shadowRevision: string;
  reportPath: string;
  actions: readonly Readonly<Phase3MaintenanceAction>[];
  createdAt: number;
}

export type Phase3MaintenancePreviewStatus =
  | "active"
  | "confirmed"
  | "invalid";

export interface Phase3MaintenanceStoredPreview {
  preview: Readonly<Phase3MaintenancePreview>;
  status: Phase3MaintenancePreviewStatus;
  reason?: string;
}

export type Phase3MaintenanceWalActionStatus =
  | "pending"
  | "completed"
  | "failed"
  | "uncertain";

export interface Phase3MaintenanceWalAction {
  action: Readonly<Phase3MaintenanceAction>;
  status: Phase3MaintenanceWalActionStatus;
  domainStatus?: VaultOperationResult["status"];
  error?: string;
}

export type Phase3MaintenanceWalStatus =
  | "prepared"
  | "applying"
  | "completed"
  | "blocked";

export interface Phase3MaintenanceWalRecord {
  version: 1;
  preview: Readonly<Phase3MaintenancePreview>;
  authorization: Readonly<Phase3MaintenanceBatchAuthorization>;
  status: Phase3MaintenanceWalStatus;
  sequence: number;
  actions: readonly Readonly<Phase3MaintenanceWalAction>[];
  createdAt: number;
  updatedAt: number;
  error?: string;
}

/**
 * Production adapters persist previews and WALs below the existing workflow
 * control root. `saveWal` is a CAS on `expectedSequence` and must be durable
 * before it resolves. The store never writes a formal Vault target.
 */
export interface Phase3MaintenanceStateStore {
  createPreview(
    preview: Readonly<Phase3MaintenancePreview>
  ): Promise<void>;
  loadPreview(
    previewId: string
  ): Promise<Readonly<Phase3MaintenanceStoredPreview> | null>;
  setPreviewStatus(input: Readonly<{
    previewId: string;
    expected: Phase3MaintenancePreviewStatus;
    status: Phase3MaintenancePreviewStatus;
    reason?: string;
  }>): Promise<void>;
  createWal(
    wal: Readonly<Phase3MaintenanceWalRecord>
  ): Promise<Readonly<Phase3MaintenanceWalRecord>>;
  loadWal(
    previewId: string
  ): Promise<Readonly<Phase3MaintenanceWalRecord> | null>;
  listRecoverableWals(
    vaultId: string
  ): Promise<readonly Readonly<Phase3MaintenanceWalRecord>[]>;
  saveWal(
    wal: Readonly<Phase3MaintenanceWalRecord>,
    expectedSequence: number
  ): Promise<Readonly<Phase3MaintenanceWalRecord>>;
}

export interface Phase3MaintenancePreparePreviewInput {
  vaultId: string;
  dateKey: string;
  explicitRawPaths?: readonly string[];
  preference: Readonly<{
    profileVersion: string;
    state: "default" | "custom";
    revision: string;
  }>;
}

export interface Phase3MaintenanceConfirmInput {
  previewId: string;
  toolCall: Readonly<Phase3MaintenanceConfirmToolCallContext>;
  signal?: AbortSignal;
}

export interface Phase3MaintenanceCommitResult {
  previewId: string;
  status: "completed";
  appliedPaths: readonly string[];
  readbackVerified: true;
  recovered: boolean;
}

export interface Phase3MaintenanceExecuteInput
  extends Phase3MaintenancePreparePreviewInput {
  toolCall: Readonly<Phase3MaintenanceConfirmToolCallContext>;
  signal?: AbortSignal;
}

export interface Phase3MaintenanceExecutionResult {
  status: "completed" | "partial" | "failed" | "write_uncertain";
  appliedPaths: readonly string[];
  notes: readonly Readonly<KnowledgeMaintenanceResultNote>[];
  systemPaths: readonly string[];
  issues: readonly Readonly<{
    code: string;
    message: string;
    path?: string;
  }>[];
  readbackVerified: boolean;
  recovered: false;
}

export interface Phase3MaintenanceRecoveryResult {
  recovered: number;
  blocked: number;
  issues: readonly string[];
}

export type Phase3MaintenanceFaultPoint =
  "after-wal-before-first-write";

export interface Phase3KnowledgeMaintenanceServiceOptions {
  domain: Phase3MaintenanceVaultDomain;
  sources: Phase3MaintenanceSourceSnapshotPort;
  tracker: Phase3MaintenanceTrackerPort;
  proposal: Phase3MaintenanceProposalPort;
  /** Legacy preview confirmation only; direct maintenance does not use it. */
  approvals?: Phase3MaintenanceBatchApprovalPort;
  state: Phase3MaintenanceStateStore;
  resolvePath?: (relativePath: string) => string;
  createPreviewId?: () => string;
  now?: () => number;
  faultInjector?: (
    point: Phase3MaintenanceFaultPoint
  ) => void | Promise<void>;
}

/**
 * Pure P3-3 coordinator. It does not own a Conversation, AgentSession, Tool
 * loop, UI, or model runtime. Shadow generation, batch approval and durable
 * WAL storage are explicit ports; formal writes use the Phase 2 Domain Service
 * exactly once and in preview order.
 */
export class Phase3KnowledgeMaintenanceService {
  private readonly resolvePath: (relativePath: string) => string;
  private readonly domain: Phase3MaintenanceVaultDomain;
  private readonly sources: Phase3MaintenanceSourceSnapshotPort;
  private readonly tracker: Phase3MaintenanceTrackerPort;
  private readonly proposal: Phase3MaintenanceProposalPort;
  private readonly approvals?: Phase3MaintenanceBatchApprovalPort;
  private readonly state: Phase3MaintenanceStateStore;
  private readonly createPreviewId: () => string;
  private readonly now: () => number;
  private readonly faultInjector?: (
    point: Phase3MaintenanceFaultPoint
  ) => void | Promise<void>;

  constructor(options: Readonly<Phase3KnowledgeMaintenanceServiceOptions>) {
    this.resolvePath = options.resolvePath ?? ((value) => value);
    this.domain = options.domain;
    this.sources = options.sources;
    this.tracker = options.tracker;
    this.proposal = options.proposal;
    this.approvals = options.approvals;
    this.state = options.state;
    this.createPreviewId = options.createPreviewId ?? randomUUID;
    this.now = options.now ?? Date.now;
    this.faultInjector = options.faultInjector;
  }

  async preparePreview(
    input: Readonly<Phase3MaintenancePreparePreviewInput>
  ): Promise<Readonly<Phase3MaintenancePreview>> {
    const preview = await this.buildInternalPlan(input);
    await this.state.createPreview(preview);
    return preview;
  }

  /**
   * Executes one explicitly authorized maintenance ToolCall. The generated
   * plan remains internal to this call and the WAL; it is never persisted as
   * an active user preview and never requires a second confirmation.
   */
  async execute(
    input: Readonly<Phase3MaintenanceExecuteInput>
  ): Promise<Readonly<Phase3MaintenanceExecutionResult>> {
    await this.recoverBeforeExecute(input.vaultId);
    const preview = await this.buildInternalPlan(input);
    const toolCall = normalizeConfirmToolCallContext(input.toolCall);
    if (toolCall.vaultId !== preview.vaultId) {
      throw phase3Error(
        "approval_failed",
        "Maintenance Tool Call Vault does not belong to this run"
      );
    }
    const contract = freezeApprovalContract({
      ...toolCall,
      previewId: preview.previewId,
      previewDigest: preview.previewDigest,
      preferenceProfileVersion: preview.preferenceProfileVersion,
      preferenceState: preview.preferenceState,
      preferenceRevision: preview.preferenceRevision,
      orderedActions: preview.actions
    });
    const authorization = freezeBatchAuthorization({
      approvalId: `direct:${toolCall.toolCallId}`,
      operationIdentity: [
        "knowledge-maintain",
        toolCall.productRunId,
        toolCall.toolCallId
      ].join(":"),
      consumedAt: this.now(),
      contract
    });
    await this.assertPreviewUnchanged(preview);
    let wal = await this.state.createWal(freezeWal({
      version: 1,
      preview,
      authorization,
      status: "prepared",
      sequence: 0,
      actions: preview.actions.map((action) => ({
        action,
        status: "pending"
      })),
      createdAt: this.now(),
      updatedAt: this.now()
    }));
    try {
      await this.faultInjector?.("after-wal-before-first-write");
      wal = await this.resumeWal(wal);
    } catch (error) {
      if (error instanceof Phase3MaintenanceSimulatedReload) throw error;
      const latest = await this.state.loadWal(preview.previewId);
      if (latest) wal = latest;
      const evidence = await this.collectExecutionEvidence(wal);
      const uncertain = error instanceof Phase3MaintenanceError
        && error.code === "write_uncertain";
      return Object.freeze({
        status: uncertain
          ? "write_uncertain"
          : evidence.notes.length
            ? "partial"
            : "failed",
        appliedPaths: evidence.appliedPaths,
        notes: evidence.notes,
        systemPaths: evidence.systemPaths,
        issues: Object.freeze([Object.freeze({
          code: error instanceof Phase3MaintenanceError
            ? error.code
            : "knowledge_maintenance_failed",
          message: errorMessage(error),
          ...(error instanceof Phase3MaintenanceError && error.relativePath
            ? { path: error.relativePath }
            : {})
        })]),
        readbackVerified: false,
        recovered: false
      });
    }
    const committed = commitResult(wal, false);
    const evidence = await this.collectExecutionEvidence(wal);
    const expectedKnowledgeNotes = preview.actions.some((action) =>
      knowledgeRolePath(action.targetPath).startsWith("wiki/")
      || knowledgeRolePath(action.targetPath).startsWith("projects/")
    );
    if (expectedKnowledgeNotes && evidence.notes.length === 0) {
      return Object.freeze({
        status: "failed",
        appliedPaths: evidence.appliedPaths,
        notes: evidence.notes,
        systemPaths: evidence.systemPaths,
        issues: Object.freeze([Object.freeze({
          code: "no_knowledge_notes",
          message: "Maintenance completed without a Readback-verified Wiki or Project note"
        })]),
        readbackVerified: false,
        recovered: false
      });
    }
    return Object.freeze({
      status: wal.actions.some((entry) => entry.status === "failed") && evidence.notes.length ? "partial" : committed.status,
      appliedPaths: evidence.appliedPaths,
      notes: evidence.notes,
      systemPaths: evidence.systemPaths,
      issues: Object.freeze(wal.actions.filter((entry) => entry.status === "failed").map((entry) => ({ code: "write_failed", path: entry.action.targetPath, message: `${entry.action.targetPath}: ${entry.error ?? "写入失败，其他内容已保留"}` }))),
      readbackVerified: committed.readbackVerified,
      recovered: false
    });
  }

  async isNoop(
    input: Readonly<Phase3MaintenancePreparePreviewInput>
  ): Promise<boolean> {
    const vaultId = requireNonEmpty(input.vaultId, "vaultId");
    if (normalizeRawPaths(input.explicitRawPaths ?? []).length > 0) return false;
    const tracker = normalizeTrackerSnapshot(
      await this.tracker.snapshot({ vaultId })
    );
    await this.assertTrackerMatchesDomain(vaultId, tracker.binding);
    return normalizeRawPaths(tracker.changedRawPaths).length === 0;
  }

  private async collectExecutionEvidence(
    wal: Readonly<Phase3MaintenanceWalRecord>
  ): Promise<Readonly<{
    appliedPaths: readonly string[];
    notes: readonly Readonly<KnowledgeMaintenanceResultNote>[];
    systemPaths: readonly string[];
  }>> {
    const notes: KnowledgeMaintenanceResultNote[] = [];
    const systemPaths: string[] = [];
    const appliedPaths: string[] = [];
    for (const entry of wal.actions) {
      if (entry.status !== "completed") continue;
      appliedPaths.push(entry.action.targetPath);
      if (
        knowledgeRolePath(entry.action.targetPath).startsWith("wiki/")
        || knowledgeRolePath(entry.action.targetPath).startsWith("projects/")
      ) {
        const readback = await this.domain.readback({
          vaultId: wal.preview.vaultId,
          relativePath: entry.action.targetPath
        });
        const snapshot = readback.status === "present"
          ? readback.snapshot
          : undefined;
        if (
          !snapshot
          || snapshot.contentSha256 !== entry.action.contentSha256
          || snapshot.byteLength !== Buffer.byteLength(
            entry.action.content,
            "utf8"
          )
        ) {
          continue;
        }
        notes.push(knowledgeMaintenanceNoteFromReadback({
          operation: entry.action.operation === "create" ? "created" : "updated",
          path: entry.action.targetPath,
          content: snapshot.content
        }));
      } else {
        systemPaths.push(entry.action.targetPath);
      }
    }
    return Object.freeze({
      appliedPaths: Object.freeze(appliedPaths),
      notes: Object.freeze(notes),
      systemPaths: Object.freeze(systemPaths)
    });
  }

  private async buildInternalPlan(
    input: Readonly<Phase3MaintenancePreparePreviewInput>
  ): Promise<Readonly<Phase3MaintenancePreview>> {
    const vaultId = requireNonEmpty(input.vaultId, "vaultId");
    const dateKey = requireDateKey(input.dateKey);
    const preference = normalizePreferenceSnapshot(input.preference);
    const tracker = normalizeTrackerSnapshot(
      await this.tracker.snapshot({ vaultId })
    );
    await this.assertTrackerMatchesDomain(vaultId, tracker.binding);

    const explicit = normalizeRawPaths(input.explicitRawPaths ?? []);
    const trackerPaths = normalizeRawPaths(tracker.changedRawPaths);
    const sourceMode: Phase3MaintenanceSourceMode = explicit.length
      ? "explicit"
      : "tracker";
    const candidates = sourceMode === "explicit" ? explicit : trackerPaths;
    if (!candidates.length) {
      throw phase3Error(
        "invalid_input",
        "Knowledge maintenance requires at least one Raw source"
      );
    }
    // The contract validates the complete deduplicated candidate set before
    // truncating the current batch. Remaining entries are reported only; they
    // are never sent to the proposal/model port in this run.
    const candidateSources = await this.snapshotSources(vaultId, candidates);
    const selectedPaths = candidates.slice(0, PHASE3_MAINTENANCE_SOURCE_LIMIT);
    const remainingRawPaths = candidates.slice(PHASE3_MAINTENANCE_SOURCE_LIMIT);
    const selectedSources = Object.freeze(
      candidateSources.slice(0, selectedPaths.length)
    );
    const previewId = requireNonEmpty(this.createPreviewId(), "previewId");
    const reportPath = this.resolvePath(phase3MaintenanceReportPath(dateKey));
    const proposal = normalizeProposal(await this.proposal.generate({
      protocolVersion: ECHOINK_KNOWLEDGE_MAINTENANCE_PROTOCOL_VERSION,
      preferenceProfileVersion: preference.profileVersion,
      preferenceState: preference.state,
      preferenceRevision: preference.revision,
      previewId,
      vaultId,
      dateKey,
      sourceMode,
      selectedSources,
      remainingRawPaths,
      tracker,
      reportPath
    }));

    await this.assertTrackerMatchesDomain(vaultId, tracker.binding);
    await this.assertSourceBindingsUnchanged(vaultId, selectedSources);
    const actions = await this.materializeActions({
      vaultId,
      previewId,
      dateKey,
      reportPath,
      selectedSources,
      remainingRawPaths,
      proposal
    });
    const createdAt = this.now();
    const previewDigest = digestJson({
      protocolVersion: ECHOINK_KNOWLEDGE_MAINTENANCE_PROTOCOL_VERSION,
      preferenceProfileVersion: preference.profileVersion,
      preferenceState: preference.state,
      preferenceRevision: preference.revision,
      previewId,
      vaultId,
      dateKey,
      sourceMode,
      selectedSources,
      remainingRawPaths,
      tracker,
      shadowId: proposal.shadowId,
      shadowRevision: proposal.shadowRevision,
      reportPath,
      actions: actions.map(actionDigestInput),
      createdAt
    });
    const preview = freezePreview({
      protocolVersion: ECHOINK_KNOWLEDGE_MAINTENANCE_PROTOCOL_VERSION,
      preferenceProfileVersion: preference.profileVersion,
      preferenceState: preference.state,
      preferenceRevision: preference.revision,
      previewId,
      previewDigest,
      vaultId,
      dateKey,
      sourceMode,
      selectedSources,
      remainingRawPaths,
      tracker,
      shadowId: proposal.shadowId,
      shadowRevision: proposal.shadowRevision,
      reportPath,
      actions,
      createdAt
    });
    return preview;
  }

  async confirmPreview(
    input: Readonly<Phase3MaintenanceConfirmInput>
  ): Promise<Readonly<Phase3MaintenanceCommitResult>> {
    const previewId = requireNonEmpty(input.previewId, "previewId");
    const stored = await this.state.loadPreview(previewId);
    if (!stored) {
      throw phase3Error("preview_not_found", "Maintenance preview was not found");
    }
    if (stored.status !== "active") {
      throw phase3Error(
        "preview_inactive",
        `Maintenance preview is ${stored.status}`
      );
    }
    const preview = stored.preview;
    const toolCall = normalizeConfirmToolCallContext(input.toolCall);
    if (toolCall.vaultId !== preview.vaultId) {
      throw phase3Error(
        "approval_failed",
        "Confirm Tool Call Vault does not belong to this maintenance preview"
      );
    }
    const approvalContract = freezeApprovalContract({
      ...toolCall,
      previewId,
      previewDigest: preview.previewDigest,
      preferenceProfileVersion: preview.preferenceProfileVersion,
      preferenceState: preview.preferenceState,
      preferenceRevision: preview.preferenceRevision,
      orderedActions: preview.actions
    });
    const approvals = this.approvals;
    if (!approvals) {
      throw phase3Error(
        "approval_failed",
        "Legacy maintenance preview confirmation is unavailable"
      );
    }
    let authorization: Readonly<Phase3MaintenanceBatchAuthorization>;
    try {
      authorization = freezeBatchAuthorization(
        await approvals.authorize({
          ...approvalContract,
          ...(input.signal ? { signal: input.signal } : {})
        })
      );
      assertAuthorizationMatchesContract(authorization, approvalContract);
    } catch (error) {
      throw phase3Error(
        "approval_failed",
        "Maintenance batch approval could not be confirmed and consumed",
        undefined,
        error
      );
    }

    try {
      await this.assertPreviewUnchanged(preview);
    } catch (error) {
      await this.state.setPreviewStatus({
        previewId,
        expected: "active",
        status: "invalid",
        reason: errorMessage(error)
      }).catch(() => undefined);
      throw error;
    }
    let wal = await this.state.createWal(freezeWal({
      version: 1,
      preview,
      authorization,
      status: "prepared",
      sequence: 0,
      actions: preview.actions.map((action) => ({
        action,
        status: "pending"
      })),
      createdAt: this.now(),
      updatedAt: this.now()
    }));
    await this.state.setPreviewStatus({
      previewId,
      expected: "active",
      status: "confirmed"
    });
    await this.faultInjector?.("after-wal-before-first-write");
    wal = await this.resumeWal(wal);
    return commitResult(wal, false);
  }

  async recoverPending(
    vaultIdInput: string
  ): Promise<Readonly<Phase3MaintenanceRecoveryResult>> {
    const vaultId = requireNonEmpty(vaultIdInput, "vaultId");
    const listed = [...await this.state.listRecoverableWals(vaultId)]
      .sort((left, right) =>
        left.createdAt - right.createdAt
        || compareText(left.preview.previewId, right.preview.previewId)
      );
    let recovered = 0;
    let blocked = 0;
    const issues: string[] = [];
    for (const candidate of listed) {
      try {
        const latest = await this.state.loadWal(candidate.preview.previewId);
        if (!latest || latest.status === "completed") continue;
        await this.resumeWal(latest);
        recovered += 1;
      } catch (error) {
        const latest = await this.state.loadWal(candidate.preview.previewId);
        if (latest?.status === "completed" && latest.actions.every((entry) => entry.status === "failed")) { recovered += 1; continue; }
        blocked += 1;
        issues.push(
          `${candidate.preview.previewId}: ${errorMessage(error)}`
        );
        break;
      }
    }
    return Object.freeze({
      recovered,
      blocked,
      issues: Object.freeze(issues)
    });
  }

  async recoverPendingOrThrow(
    vaultId: string
  ): Promise<Readonly<Phase3MaintenanceRecoveryResult>> {
    const recovery = await this.recoverPending(vaultId);
    if (recovery.blocked > 0) {
      throw phase3Error(
        "recovery_blocked",
        recovery.issues[0] ?? "Knowledge maintenance WAL recovery is blocked"
      );
    }
    return recovery;
  }

  async recoverBeforeExecute(vaultId: string): Promise<void> {
    await this.recoverPendingOrThrow(vaultId);
  }

  private async resumeWal(
    walInput: Readonly<Phase3MaintenanceWalRecord>
  ): Promise<Readonly<Phase3MaintenanceWalRecord>> {
    let wal = freezeWal(walInput);
    if (wal.status === "completed") return wal;
    if (wal.status === "blocked") {
      throw phase3Error(
        "recovery_blocked",
        wal.error ?? "Maintenance WAL is blocked"
      );
    }
    try {
      await this.assertWalCanResume(wal);
    } catch (error) {
      if (error instanceof Phase3MaintenanceError && error.code === "preview_stale" && wal.actions.every((entry) => entry.status === "pending")) {
        await this.saveWal(wal, { status: "completed", actions: wal.actions.map((entry) => ({ ...entry, status: "failed" as const, error: errorMessage(error) })), error: errorMessage(error), updatedAt: this.now() });
      } else await this.blockWal(wal, errorMessage(error));
      throw error;
    }
    if (wal.status === "prepared") {
      wal = await this.saveWal(wal, {
        status: "applying",
        updatedAt: this.now()
      });
    }

    for (let index = 0; index < wal.actions.length; index += 1) {
      const entry = wal.actions[index];
      if (entry.status === "completed" || entry.status === "failed") continue;
      const current = await this.readTargetBinding(
        wal.preview.vaultId,
        entry.action.targetPath
      );
      if (targetHasDesiredContent(current, entry.action)) {
        wal = await this.checkpointCompletedAction(wal, index);
        continue;
      }
      if (entry.status === "uncertain") {
        const message = `Uncertain write requires readback only: ${entry.action.targetPath}`;
        await this.blockWal(wal, message);
        throw phase3Error(
          "write_uncertain",
          message,
          entry.action.targetPath
        );
      }
      if (!sameTargetBinding(current, entry.action.expected)) {
        const message = `Target revision changed before batch write: ${entry.action.targetPath}`;
        wal = await this.saveWalAction(wal, index, { status: "failed", error: message });
        continue;
      }
      const result = await this.executeAction(
        wal.authorization,
        wal.preview,
        entry.action
      );
      if (result.status !== "completed" || !result.readbackVerified) {
        const uncertain = result.status === "uncertain";
        wal = await this.saveWalAction(wal, index, {
          status: uncertain ? "uncertain" : "failed",
          domainStatus: result.status,
          error: result.error?.message ?? result.status
        });
        const message = result.error?.message
          ?? `Maintenance write ended as ${result.status}`;
        if (!uncertain) continue;
        await this.blockWal(wal, message);
        throw phase3Error(
          "write_uncertain",
          message,
          entry.action.targetPath
        );
      }
      const readback = await this.readTargetBinding(
        wal.preview.vaultId,
        entry.action.targetPath
      );
      if (!targetHasDesiredContent(readback, entry.action)) {
        wal = await this.saveWalAction(wal, index, {
          status: "uncertain",
          domainStatus: "uncertain",
          error: "Post-write readback did not match the preview"
        });
        const message = `Post-write readback mismatch: ${entry.action.targetPath}`;
        await this.blockWal(wal, message);
        throw phase3Error(
          "write_uncertain",
          message,
          entry.action.targetPath
        );
      }
      wal = await this.checkpointCompletedAction(wal, index);
    }

    await this.assertSourceBindingsUnchanged(
      wal.preview.vaultId,
      wal.preview.selectedSources
    );
    wal = await this.saveWal(wal, {
      status: "completed",
      updatedAt: this.now(),
      error: undefined
    });
    return wal;
  }

  private async assertPreviewUnchanged(
    preview: Readonly<Phase3MaintenancePreview>
  ): Promise<void> {
    await this.assertTrackerMatchesDomain(
      preview.vaultId,
      preview.tracker.binding
    );
    await this.assertSourceBindingsUnchanged(
      preview.vaultId,
      preview.selectedSources
    );
  }

  private async assertWalCanResume(
    wal: Readonly<Phase3MaintenanceWalRecord>
  ): Promise<void> {
    assertAuthorizationMatchesPreview(wal.authorization, wal.preview);
    await this.assertSourceBindingsUnchanged(
      wal.preview.vaultId,
      wal.preview.selectedSources
    );
    for (const entry of wal.actions) {
      if (entry.status === "pending" || entry.status === "failed") continue;
      const current = await this.readTargetBinding(
        wal.preview.vaultId,
        entry.action.targetPath
      );
      const desired = targetHasDesiredContent(current, entry.action);
      if (entry.status === "completed" && !desired) {
        throw phase3Error(
          "recovery_blocked",
          `Completed WAL target changed: ${entry.action.targetPath}`,
          entry.action.targetPath
        );
      }
      if (entry.status === "uncertain" && !desired) {
        throw phase3Error(
          "write_uncertain",
          `Uncertain WAL target is not readback-verified: ${entry.action.targetPath}`,
          entry.action.targetPath
        );
      }

    }
  }

  private async executeAction(
    authorization: Readonly<Phase3MaintenanceBatchAuthorization>,
    preview: Readonly<Phase3MaintenancePreview>,
    action: Readonly<Phase3MaintenanceAction>
  ): Promise<Readonly<VaultOperationResult>> {
    const operationIdentity = [
      authorization.operationIdentity,
      action.actionId,
      action.contentSha256.slice(0, 16)
    ].join(":");
    if (action.operation === "create") {
      return await this.domain.noteCreate({
        vaultId: preview.vaultId,
        operationIdentity,
        relativePath: action.targetPath,
        content: action.content
      });
    }
    if (action.expected.kind !== "file") {
      throw phase3Error(
        "wal_conflict",
        `Update action lacks an expected file revision: ${action.targetPath}`,
        action.targetPath
      );
    }
    return await this.domain.noteUpdate({
      vaultId: preview.vaultId,
      operationIdentity,
      relativePath: action.targetPath,
      expectedVersion: action.expected.version,
      content: action.content
    });
  }

  private async materializeActions(input: Readonly<{
    vaultId: string;
    previewId: string;
    dateKey: string;
    reportPath: string;
    selectedSources: readonly Readonly<Phase3MaintenanceSourceBinding>[];
    remainingRawPaths: readonly string[];
    proposal: Readonly<Phase3MaintenanceProposal>;
  }>): Promise<readonly Readonly<Phase3MaintenanceAction>[]> {
    const protectedPaths = new Set<string>();
    for (const source of input.selectedSources) {
      protectedPaths.add(source.raw.relativePath);
      for (const attachment of source.attachments) {
        protectedPaths.add(attachment.relativePath);
      }
    }
    const drafts = input.proposal.actions.map((draft) => {
      const targetPath = normalizeFormalTargetPath(
        draft.targetPath,
        input.dateKey
      );
      if (protectedPaths.has(targetPath)) {
        throw phase3Error(
          "proposal_invalid",
          `Maintenance proposal targets Raw or its attachment: ${targetPath}`,
          targetPath
        );
      }
      return {
        targetPath,
        content: requireString(draft.content, "action.content"),
        ...(draft.expectedTarget
          ? { expectedTarget: draft.expectedTarget }
          : {})
      };
    });
    for (const draft of drafts) {
      if (
        knowledgeRolePath(draft.targetPath).startsWith("wiki/")
        || knowledgeRolePath(draft.targetPath).startsWith("projects/")
      ) {
        if (!draft.expectedTarget) {
          throw phase3Error(
            "proposal_invalid",
            `Knowledge candidate lacks expected target evidence: ${draft.targetPath}`,
            draft.targetPath
          );
        }
        try {
          validateKnowledgeMaintenanceCandidateSources({
            targetPath: draft.targetPath,
            content: draft.content,
            selectedSources: input.selectedSources.map((source) => ({
              relativePath: source.raw.relativePath,
              contentSha256: source.raw.contentSha256
            }))
          });
        } catch (error) {
          throw phase3Error(
            "proposal_invalid",
            `Knowledge candidate lacks an exact Raw source binding: ${draft.targetPath}`,
            draft.targetPath,
            error
          );
        }
      }
    }
    const uniqueTargets = new Set(drafts.map((draft) => draft.targetPath));
    if (uniqueTargets.size !== drafts.length) {
      throw phase3Error(
        "proposal_invalid",
        "Maintenance proposal contains duplicate target paths"
      );
    }
    if (!drafts.some((draft) =>
      knowledgeRolePath(draft.targetPath) === PHASE3_MAINTENANCE_TRACKER_PATH)) {
      throw phase3Error(
        "proposal_invalid",
        "Maintenance proposal must update the ingest tracker"
      );
    }
    if (drafts.filter((draft) => draft.targetPath === input.reportPath).length !== 1) {
      throw phase3Error(
        "proposal_invalid",
        "Maintenance proposal must contain exactly one dated report"
      );
    }
    const report = drafts.find((draft) => draft.targetPath === input.reportPath)!;
    for (const remainingPath of input.remainingRawPaths) {
      if (!report.content.includes(remainingPath)) {
        throw phase3Error(
          "proposal_invalid",
          `Maintenance report omits remaining Raw: ${remainingPath}`,
          remainingPath
        );
      }
    }
    drafts.sort((left, right) =>
      targetRank(left.targetPath) - targetRank(right.targetPath)
      || compareText(left.targetPath, right.targetPath)
    );
    const actions: Phase3MaintenanceAction[] = [];
    for (const [index, draft] of drafts.entries()) {
      const expected = await this.readTargetBinding(
        input.vaultId,
        draft.targetPath
      );
      if (
        draft.expectedTarget
        && !agentExpectedTargetMatches(expected, draft.expectedTarget)
      ) {
        throw phase3Error(
          "preview_stale",
          `Maintenance target changed after Agent read: ${draft.targetPath}`,
          draft.targetPath
        );
      }
      actions.push(Object.freeze({
        actionId: `${input.previewId}:${String(index + 1).padStart(3, "0")}`,
        operation: expected.kind === "missing" ? "create" : "update",
        targetPath: draft.targetPath,
        content: draft.content,
        contentSha256: sha256(draft.content),
        expected
      }));
    }
    return Object.freeze(actions);
  }

  private async snapshotSources(
    vaultId: string,
    paths: readonly string[]
  ): Promise<readonly Readonly<Phase3MaintenanceSourceBinding>[]> {
    const snapshots: Phase3MaintenanceSourceBinding[] = [];
    for (const relativePath of paths) {
      snapshots.push(normalizeSourceBinding(
        await this.sources.snapshotRaw({ vaultId, relativePath }),
        relativePath
      ));
    }
    return Object.freeze(snapshots.map(freezeSourceBinding));
  }

  private async assertSourceBindingsUnchanged(
    vaultId: string,
    expected: readonly Readonly<Phase3MaintenanceSourceBinding>[]
  ): Promise<void> {
    for (const source of expected) {
      const current = normalizeSourceBinding(
        await this.sources.snapshotRaw({
          vaultId,
          relativePath: source.raw.relativePath
        }),
        source.raw.relativePath
      );
      if (current.raw.relativePath !== source.raw.relativePath || current.raw.contentSha256 !== source.raw.contentSha256) {
        throw phase3Error(
          "preview_stale",
          `Raw body changed: ${source.raw.relativePath}`,
          source.raw.relativePath
        );
      }
    }
  }

  private async assertTrackerMatchesDomain(
    vaultId: string,
    expected: Readonly<Phase3MaintenanceTargetBinding>
  ): Promise<void> {
    const current = await this.readTargetBinding(
      vaultId,
      this.resolvePath(PHASE3_MAINTENANCE_TRACKER_PATH)
    );
    if (!sameTargetBinding(current, expected)) {
      throw phase3Error(
        "preview_stale",
        "Ingest tracker changed while preparing maintenance",
        PHASE3_MAINTENANCE_TRACKER_PATH
      );
    }
  }

  private async readTargetBinding(
    vaultId: string,
    relativePath: string
  ): Promise<Readonly<Phase3MaintenanceTargetBinding>> {
    const readback = await this.domain.readback({ vaultId, relativePath });
    return targetBindingFromReadback(readback, relativePath);
  }

  private async saveWal(
    wal: Readonly<Phase3MaintenanceWalRecord>,
    patch: Partial<Phase3MaintenanceWalRecord>
  ): Promise<Readonly<Phase3MaintenanceWalRecord>> {
    const next = freezeWal({
      ...wal,
      ...patch,
      sequence: wal.sequence + 1
    });
    return await this.state.saveWal(next, wal.sequence);
  }

  private async saveWalAction(
    wal: Readonly<Phase3MaintenanceWalRecord>,
    index: number,
    patch: Partial<Phase3MaintenanceWalAction>
  ): Promise<Readonly<Phase3MaintenanceWalRecord>> {
    const actions = wal.actions.map((entry, entryIndex) =>
      entryIndex === index
        ? Object.freeze({ ...entry, ...patch })
        : entry
    );
    return await this.saveWal(wal, {
      actions: Object.freeze(actions),
      updatedAt: this.now()
    });
  }

  private async checkpointCompletedAction(
    wal: Readonly<Phase3MaintenanceWalRecord>,
    index: number
  ): Promise<Readonly<Phase3MaintenanceWalRecord>> {
    try {
      return await this.saveWalAction(wal, index, {
        status: "completed",
        domainStatus: "completed",
        error: undefined
      });
    } catch (error) {
      const action = wal.actions[index]?.action;
      if (!action) throw error;
      await this.saveWalAction(wal, index, {
        status: "uncertain",
        domainStatus: "completed",
        error: "Readback succeeded but the completed WAL checkpoint failed"
      }).catch(() => undefined);
      throw phase3Error(
        "write_uncertain",
        `Readback succeeded but the completed WAL checkpoint failed: ${action.targetPath}`,
        action.targetPath,
        error
      );
    }
  }

  private async blockWal(
    wal: Readonly<Phase3MaintenanceWalRecord>,
    error: string
  ): Promise<Readonly<Phase3MaintenanceWalRecord>> {
    const latest = await this.state.loadWal(wal.preview.previewId);
    const current = latest ?? wal;
    if (current.status === "blocked") return current;
    return await this.saveWal(current, {
      status: "blocked",
      error,
      updatedAt: this.now()
    });
  }
}

export function phase3MaintenanceReportPath(dateKeyInput: string): string {
  const dateKey = requireDateKey(dateKeyInput);
  return `outputs/maintenance/kb-maintenance-${dateKey}.md`;
}

export function isPhase3MaintenanceFormalWritePath(
  relativePathInput: string,
  dateKeyInput: string
): boolean {
  try {
    normalizeFormalTargetPath(relativePathInput, dateKeyInput);
    return true;
  } catch {
    return false;
  }
}

export function isPhase3MaintenanceWorkflowStatePath(
  relativePathInput: string
): boolean {
  try {
    const relativePath = normalizeVaultRelativePath(relativePathInput);
    return relativePath.startsWith(`${PHASE3_MAINTENANCE_WORKFLOW_ROOT}/`);
  } catch {
    return false;
  }
}

function normalizeRawPaths(paths: readonly string[]): string[] {
  const normalized = paths.map(normalizeRawPath);
  return Array.from(new Set(normalized)).sort(compareText);
}

function normalizeRawPath(value: string): string {
  let relativePath: string;
  try {
    relativePath = normalizeVaultRelativePath(value);
  } catch (error) {
    throw phase3Error(
      "invalid_raw_path",
      `Invalid Raw path: ${String(value)}`,
      String(value),
      error
    );
  }
  if (
    !knowledgeRolePath(relativePath).startsWith("raw/")
    || knowledgeRolePath(relativePath) === PHASE3_MAINTENANCE_RAW_INDEX_PATH
    || hasHiddenSegment(relativePath)
  ) {
    throw phase3Error(
      "invalid_raw_path",
      `Maintenance input is not a normal Raw file: ${relativePath}`,
      relativePath
    );
  }
  return relativePath;
}

function normalizeFormalTargetPath(
  value: string,
  dateKeyInput: string
): string {
  const dateKey = requireDateKey(dateKeyInput);
  let relativePath: string;
  try {
    relativePath = normalizeVaultRelativePath(value);
  } catch (error) {
    throw phase3Error(
      "proposal_invalid",
      `Invalid maintenance target: ${String(value)}`,
      String(value),
      error
    );
  }
  const reportPath = phase3MaintenanceReportPath(dateKey);
  const ordinaryKnowledgePage = (
    knowledgeRolePath(relativePath).startsWith("wiki/")
    || knowledgeRolePath(relativePath).startsWith("projects/")
  ) && relativePath.toLowerCase().endsWith(".md")
    && !hasHiddenSegment(relativePath);
  if (
    ordinaryKnowledgePage
    || knowledgeRolePath(relativePath) === PHASE3_MAINTENANCE_RAW_INDEX_PATH
    || knowledgeRolePath(relativePath) === PHASE3_MAINTENANCE_TRACKER_PATH
    || knowledgeRolePath(relativePath) === reportPath
  ) {
    return relativePath;
  }
  throw phase3Error(
    "proposal_invalid",
    `Maintenance target is outside the Phase 3 whitelist: ${relativePath}`,
    relativePath
  );
}

function normalizeProposal(
  proposal: Readonly<Phase3MaintenanceProposal>
): Readonly<Phase3MaintenanceProposal> {
  if (!proposal || typeof proposal !== "object" || !Array.isArray(proposal.actions)) {
    throw phase3Error("proposal_invalid", "Maintenance proposal is invalid");
  }
  return Object.freeze({
    shadowId: requireNonEmpty(proposal.shadowId, "shadowId"),
    shadowRevision: requireNonEmpty(
      proposal.shadowRevision,
      "shadowRevision"
    ),
    actions: Object.freeze(proposal.actions.map(normalizeProposalAction))
  });
}

function normalizeProposalAction(
  action: unknown
): Readonly<Phase3MaintenanceProposalAction> {
  if (!action || typeof action !== "object" || Array.isArray(action)) {
    throw phase3Error("proposal_invalid", "Maintenance action is invalid");
  }
  const record = action as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    !keys.every((key) =>
      key === "targetPath" || key === "content" || key === "expectedTarget"
    )
  ) {
    throw phase3Error("proposal_invalid", "Maintenance action is invalid");
  }
  return Object.freeze({
    targetPath: requireNonEmpty(record.targetPath, "action.targetPath"),
    content: requireString(record.content, "action.content"),
    ...(record.expectedTarget === undefined
      ? {}
      : { expectedTarget: normalizeAgentExpectedTarget(record.expectedTarget) })
  });
}

function normalizeAgentExpectedTarget(
  value: unknown
): NonNullable<Phase3MaintenanceProposalAction["expectedTarget"]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw phase3Error("proposal_invalid", "Expected target is invalid");
  }
  const record = value as Record<string, unknown>;
  if (record.kind === "missing" && Object.keys(record).length === 1) {
    return Object.freeze({ kind: "missing" as const });
  }
  if (
    record.kind === "file"
    && Object.keys(record).length === 2
    && typeof record.contentRevision === "string"
    && /^sha256:[a-f0-9]{64}$/u.test(record.contentRevision)
  ) {
    return Object.freeze({
      kind: "file" as const,
      contentRevision: record.contentRevision
    });
  }
  throw phase3Error("proposal_invalid", "Expected target is invalid");
}

function agentExpectedTargetMatches(
  current: Readonly<Phase3MaintenanceTargetBinding>,
  expected: NonNullable<Phase3MaintenanceProposalAction["expectedTarget"]>
): boolean {
  if (expected.kind === "missing") return current.kind === "missing";
  return current.kind === "file"
    && expected.contentRevision === `sha256:${current.contentSha256}`;
}

function normalizeTrackerSnapshot(
  snapshot: Readonly<Phase3MaintenanceTrackerSnapshot>
): Readonly<Phase3MaintenanceTrackerSnapshot> {
  if (!snapshot || typeof snapshot !== "object") {
    throw phase3Error("invalid_input", "Tracker snapshot is invalid");
  }
  return Object.freeze({
    binding: normalizeTargetBinding(snapshot.binding),
    changedRawPaths: Object.freeze(normalizeRawPaths(snapshot.changedRawPaths))
  });
}

function normalizeSourceBinding(
  binding: Readonly<Phase3MaintenanceSourceBinding>,
  expectedRawPath: string
): Phase3MaintenanceSourceBinding {
  if (!binding || typeof binding !== "object") {
    throw phase3Error(
      "invalid_input",
      `Raw snapshot is invalid: ${expectedRawPath}`,
      expectedRawPath
    );
  }
  const raw = normalizeImmutableFileBinding(binding.raw);
  if (raw.relativePath !== expectedRawPath) {
    throw phase3Error(
      "invalid_input",
      `Raw snapshot returned a different path: ${expectedRawPath}`,
      expectedRawPath
    );
  }
  const attachments = binding.attachments.map(normalizeImmutableFileBinding)
    .sort((left, right) => compareText(left.relativePath, right.relativePath));
  if (new Set(attachments.map((item) => item.relativePath)).size !== attachments.length) {
    throw phase3Error(
      "invalid_input",
      `Raw attachment snapshot contains duplicates: ${expectedRawPath}`,
      expectedRawPath
    );
  }
  if (attachments.some((item) => item.relativePath === raw.relativePath)) {
    throw phase3Error(
      "invalid_input",
      `Raw snapshot lists itself as an attachment: ${expectedRawPath}`,
      expectedRawPath
    );
  }
  return { raw, attachments };
}

function normalizeImmutableFileBinding(
  binding: Readonly<Phase3MaintenanceImmutableFileBinding>
): Phase3MaintenanceImmutableFileBinding {
  if (!binding || binding.kind !== "file") {
    throw phase3Error("invalid_input", "Maintenance source is not a file");
  }
  const relativePath = normalizeVaultRelativePath(binding.relativePath);
  if (hasHiddenSegment(relativePath)) {
    throw phase3Error(
      "invalid_input",
      `Maintenance source is hidden: ${relativePath}`,
      relativePath
    );
  }
  const revision = requireNonEmpty(binding.revision, "source.revision");
  if (!SHA256.test(binding.contentSha256)) {
    throw phase3Error(
      "invalid_input",
      `Maintenance source digest is invalid: ${relativePath}`,
      relativePath
    );
  }
  if (!Number.isSafeInteger(binding.byteLength) || binding.byteLength < 0) {
    throw phase3Error(
      "invalid_input",
      `Maintenance source byte length is invalid: ${relativePath}`,
      relativePath
    );
  }
  return Object.freeze({
    kind: "file",
    relativePath,
    revision,
    contentSha256: binding.contentSha256,
    byteLength: binding.byteLength
  });
}

function normalizeTargetBinding(
  binding: Readonly<Phase3MaintenanceTargetBinding>
): Readonly<Phase3MaintenanceTargetBinding> {
  if (binding?.kind === "missing") return Object.freeze({ kind: "missing" });
  if (
    !binding
    || binding.kind !== "file"
    || !SHA256.test(binding.contentSha256)
    || !Number.isSafeInteger(binding.byteLength)
    || binding.byteLength < 0
  ) {
    throw phase3Error("invalid_input", "Maintenance target binding is invalid");
  }
  return Object.freeze({
    kind: "file",
    version: requireNonEmpty(binding.version, "target.version"),
    contentSha256: binding.contentSha256,
    byteLength: binding.byteLength
  });
}

function targetBindingFromReadback(
  readback: Readonly<VaultReadbackState>,
  relativePath: string
): Readonly<Phase3MaintenanceTargetBinding> {
  if (readback.status === "missing") return Object.freeze({ kind: "missing" });
  if (readback.status !== "present" || !readback.snapshot) {
    throw phase3Error(
      "preview_stale",
      `Maintenance target could not be read: ${relativePath}`,
      relativePath
    );
  }
  return normalizeTargetBinding({
    kind: "file",
    version: readback.snapshot.version,
    contentSha256: readback.snapshot.contentSha256,
    byteLength: readback.snapshot.byteLength
  });
}

function sameTargetBinding(
  left: Readonly<Phase3MaintenanceTargetBinding>,
  right: Readonly<Phase3MaintenanceTargetBinding>
): boolean {
  return stableStringify(left) === stableStringify(right);
}

function targetHasDesiredContent(
  current: Readonly<Phase3MaintenanceTargetBinding>,
  action: Readonly<Phase3MaintenanceAction>
): boolean {
  return current.kind === "file"
    && current.contentSha256 === action.contentSha256
    && current.byteLength === Buffer.byteLength(action.content, "utf8");
}

function actionDigestInput(action: Readonly<Phase3MaintenanceAction>): unknown {
  return {
    actionId: action.actionId,
    operation: action.operation,
    targetPath: action.targetPath,
    contentSha256: action.contentSha256,
    contentByteLength: Buffer.byteLength(action.content, "utf8"),
    expected: action.expected
  };
}

function normalizeConfirmToolCallContext(
  context: Readonly<Phase3MaintenanceConfirmToolCallContext>
): Readonly<Phase3MaintenanceConfirmToolCallContext> {
  return Object.freeze({
    productRunId: requireNonEmpty(context?.productRunId, "productRunId"),
    toolCallId: requireNonEmpty(context?.toolCallId, "toolCallId"),
    conversationId: requireNonEmpty(
      context?.conversationId,
      "conversationId"
    ),
    piSessionId: requireNonEmpty(context?.piSessionId, "piSessionId"),
    vaultId: requireNonEmpty(context?.vaultId, "vaultId"),
    userId: requireNonEmpty(context?.userId, "userId"),
    deviceId: requireNonEmpty(context?.deviceId, "deviceId")
  });
}

function freezeApprovalContract(
  contract: Phase3MaintenanceApprovalContract
): Readonly<Phase3MaintenanceApprovalContract> {
  const preference = normalizePreferenceSnapshot({
    profileVersion: contract.preferenceProfileVersion,
    state: contract.preferenceState,
    revision: contract.preferenceRevision
  });
  return Object.freeze({
    ...normalizeConfirmToolCallContext(contract),
    previewId: requireNonEmpty(contract.previewId, "previewId"),
    previewDigest: requireNonEmpty(contract.previewDigest, "previewDigest"),
    preferenceProfileVersion: preference.profileVersion,
    preferenceState: preference.state,
    preferenceRevision: preference.revision,
    orderedActions: Object.freeze(
      contract.orderedActions.map(freezeMaintenanceAction)
    )
  });
}

function freezeBatchAuthorization(
  authorization: Readonly<Phase3MaintenanceBatchAuthorization>
): Readonly<Phase3MaintenanceBatchAuthorization> {
  if (
    !Number.isSafeInteger(authorization?.consumedAt)
    || authorization.consumedAt < 0
  ) {
    throw phase3Error(
      "approval_failed",
      "Maintenance batch authorization consumedAt is invalid"
    );
  }
  return Object.freeze({
    approvalId: requireNonEmpty(authorization.approvalId, "approvalId"),
    operationIdentity: requireNonEmpty(
      authorization.operationIdentity,
      "operationIdentity"
    ),
    consumedAt: authorization.consumedAt,
    contract: freezeApprovalContract(
      authorization.contract as Phase3MaintenanceApprovalContract
    )
  });
}

function assertAuthorizationMatchesContract(
  authorization: Readonly<Phase3MaintenanceBatchAuthorization>,
  expected: Readonly<Phase3MaintenanceApprovalContract>
): void {
  if (stableStringify(authorization.contract) !== stableStringify(expected)) {
    throw phase3Error(
      "approval_failed",
      "Consumed maintenance Ticket does not bind the current confirm Tool Call and batch"
    );
  }
}

function assertAuthorizationMatchesPreview(
  authorization: Readonly<Phase3MaintenanceBatchAuthorization>,
  preview: Readonly<Phase3MaintenancePreview>
): void {
  const contract = authorization.contract;
  if (
    contract.previewId !== preview.previewId
    || contract.previewDigest !== preview.previewDigest
    || contract.preferenceProfileVersion
      !== preview.preferenceProfileVersion
    || contract.preferenceState !== preview.preferenceState
    || contract.preferenceRevision !== preview.preferenceRevision
    || contract.vaultId !== preview.vaultId
    || stableStringify(contract.orderedActions)
      !== stableStringify(preview.actions)
  ) {
    throw phase3Error(
      "recovery_blocked",
      "Maintenance WAL authorization no longer binds its preview and ordered batch"
    );
  }
}

function freezeMaintenanceAction(
  action: Readonly<Phase3MaintenanceAction>
): Readonly<Phase3MaintenanceAction> {
  return Object.freeze({
    ...action,
    expected: normalizeTargetBinding(action.expected)
  });
}

function freezePreview(
  preview: Phase3MaintenancePreview
): Readonly<Phase3MaintenancePreview> {
  if (
    preview.protocolVersion
      !== ECHOINK_KNOWLEDGE_MAINTENANCE_PROTOCOL_VERSION
  ) {
    throw phase3Error(
      "proposal_invalid",
      "Knowledge maintenance protocol version is invalid"
    );
  }
  const preference = normalizePreferenceSnapshot({
    profileVersion: preview.preferenceProfileVersion,
    state: preview.preferenceState,
    revision: preview.preferenceRevision
  });
  return Object.freeze({
    ...preview,
    preferenceProfileVersion: preference.profileVersion,
    preferenceState: preference.state,
    preferenceRevision: preference.revision,
    selectedSources: Object.freeze(
      preview.selectedSources.map(freezeSourceBinding)
    ),
    remainingRawPaths: Object.freeze([...preview.remainingRawPaths]),
    tracker: Object.freeze({
      binding: normalizeTargetBinding(preview.tracker.binding),
      changedRawPaths: Object.freeze([...preview.tracker.changedRawPaths])
    }),
    actions: Object.freeze(preview.actions.map(freezeMaintenanceAction))
  });
}

function normalizePreferenceSnapshot(value: Readonly<{
  profileVersion: string;
  state: "default" | "custom";
  revision: string;
}>): Readonly<{
  profileVersion: string;
  state: "default" | "custom";
  revision: string;
}> {
  const profileVersion = requireNonEmpty(
    value?.profileVersion,
    "preferenceProfileVersion"
  );
  if (value?.state !== "default" && value?.state !== "custom") {
    throw phase3Error(
      "proposal_invalid",
      "Knowledge maintenance preference state is invalid"
    );
  }
  if (!/^sha256:[a-f0-9]{64}$/u.test(value?.revision ?? "")) {
    throw phase3Error(
      "proposal_invalid",
      "Knowledge maintenance preference revision is invalid"
    );
  }
  return Object.freeze({
    profileVersion,
    state: value.state,
    revision: value.revision
  });
}

function freezeSourceBinding(
  source: Readonly<Phase3MaintenanceSourceBinding>
): Readonly<Phase3MaintenanceSourceBinding> {
  return Object.freeze({
    raw: Object.freeze({ ...source.raw }),
    attachments: Object.freeze(
      source.attachments.map((item) => Object.freeze({ ...item }))
    )
  });
}

function freezeWal(
  wal: Phase3MaintenanceWalRecord
): Readonly<Phase3MaintenanceWalRecord> {
  return Object.freeze({
    ...wal,
    preview: freezePreview(wal.preview as Phase3MaintenancePreview),
    authorization: freezeBatchAuthorization(wal.authorization),
    actions: Object.freeze(wal.actions.map((entry) => Object.freeze({
      ...entry,
      action: freezeMaintenanceAction(entry.action)
    })))
  });
}

function commitResult(
  wal: Readonly<Phase3MaintenanceWalRecord>,
  recovered: boolean
): Readonly<Phase3MaintenanceCommitResult> {
  if (
    wal.status !== "completed"
    || wal.actions.some((entry) => entry.status !== "completed" && entry.status !== "failed")
  ) {
    throw phase3Error(
      "wal_conflict",
      `Maintenance WAL did not complete: ${wal.preview.previewId}`
    );
  }
  return Object.freeze({
    previewId: wal.preview.previewId,
    status: "completed",
    appliedPaths: Object.freeze(
      wal.actions.filter((entry) => entry.status === "completed").map((entry) => entry.action.targetPath)
    ),
    readbackVerified: true,
    recovered
  });
}

function targetRank(relativePath: string): number {
  if (knowledgeRolePath(relativePath).startsWith("wiki/")) return 10;
  if (knowledgeRolePath(relativePath).startsWith("projects/")) return 20;
  if (knowledgeRolePath(relativePath) === PHASE3_MAINTENANCE_RAW_INDEX_PATH) return 30;
  if (knowledgeRolePath(relativePath) === PHASE3_MAINTENANCE_TRACKER_PATH) return 40;
  return 50;
}

function hasHiddenSegment(relativePath: string): boolean {
  return relativePath.split("/").some((segment) => segment.startsWith("."));
}

function requireDateKey(value: string): string {
  const dateKey = requireNonEmpty(value, "dateKey");
  if (!DATE_KEY.test(dateKey)) {
    throw phase3Error("invalid_input", `Invalid maintenance date: ${dateKey}`);
  }
  return dateKey;
}

function requireNonEmpty(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw phase3Error("invalid_input", `${label} must be a non-empty string`);
  }
  return value.trim();
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw phase3Error("invalid_input", `${label} must be a string`);
  }
  return value;
}

function phase3Error(
  code: Phase3MaintenanceErrorCode,
  message: string,
  relativePath?: string,
  cause?: unknown
): Phase3MaintenanceError {
  return new Phase3MaintenanceError(
    code,
    message,
    relativePath,
    cause === undefined ? undefined : { cause }
  );
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function digestJson(value: unknown): string {
  return `sha256:${createHash("sha256")
    .update(stableStringify(value), "utf8")
    .digest("hex")}`;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort(compareText)
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(",")}}`;
  }
  return value === undefined ? "null" : JSON.stringify(value);
}

function compareText(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
