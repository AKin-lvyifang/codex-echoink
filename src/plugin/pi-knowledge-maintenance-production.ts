import { isBilingualWikiFolder, wikiFolderEnglishId } from "../knowledge-base/wiki-folder-names";
import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath
} from "node:fs/promises";
import * as path from "node:path";
import { TextDecoder } from "node:util";
import type {
  PiKnowledgeMaintenanceToolInput,
  PiKnowledgeMaintenanceToolPort,
  PiKnowledgeMaintenanceToolResult
} from "../harness/pi-native/contracts";
import {
  atomicWriteJsonFile,
  isNodeErrorWithCode,
  readJsonFileIfPresent,
  serializePiNativeFileWrite
} from "../harness/pi-native/file-store-utils";
import type {
  VaultDomainService
} from "../harness/pi-native/vault-domain-service";
import { normalizeVaultRelativePath } from "../harness/pi-native/vault-target-resolver";
import {
  PHASE3_MAINTENANCE_RAW_INDEX_PATH,
  PHASE3_MAINTENANCE_RECOVERED_RETRY_MESSAGE,
  PHASE3_MAINTENANCE_TRACKER_PATH,
  Phase3KnowledgeMaintenanceService,
  Phase3MaintenanceError,
  type Phase3MaintenanceFaultPoint,
  type Phase3MaintenanceImmutableFileBinding,
  type Phase3MaintenanceProposal,
  type Phase3MaintenanceProposalAction,
  type Phase3MaintenanceProposalInput,
  type Phase3MaintenanceProposalPort,
  type Phase3MaintenanceSourceBinding,
  type Phase3MaintenanceSourceSnapshotPort,
  type Phase3MaintenanceStateStore,
  type Phase3MaintenanceStoredPreview,
  type Phase3MaintenanceTrackerPort,
  type Phase3MaintenanceTrackerSnapshot,
  type Phase3MaintenanceWalRecord
} from "../knowledge-base/phase3-maintenance-service";
import {
  ECHOINK_KNOWLEDGE_MAINTENANCE_PROTOCOL_VERSION,
  echoInkKnowledgeMaintenanceProtocolPrompt,
  validateKnowledgeMaintenanceCandidateSources
} from "../knowledge-base/knowledge-maintenance-protocol";
import {
  createKnowledgeMaintenanceResultEnvelope
} from "../knowledge-base/knowledge-maintenance-result";
import type {
  KnowledgeAgentIndex,
  KnowledgeAgentReliableRawKnowledge
} from "../knowledge-base/knowledge-agent-index";

const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const CONTROL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;

export interface KnowledgeMaintenanceTerminalEvent {
  readonly input: Readonly<PiKnowledgeMaintenanceToolInput>;
  readonly result: Readonly<PiKnowledgeMaintenanceToolResult>;
  readonly at: number;
}

export interface CreateProductionPiKnowledgeMaintenanceOptions {
  readonly onTerminal?: (event: KnowledgeMaintenanceTerminalEvent) => void | Promise<void>;
  readonly vaultRootPath: string;
  readonly privateKnowledgeRootPath: string;
  readonly vaultId: string;
  readonly userId: string;
  readonly deviceId: string;
  readonly domainService: VaultDomainService;
  readonly knowledgeAgentIndex?: Pick<
    KnowledgeAgentIndex,
    "readReliableKnowledgeForRaw"
  >;
  readonly now?: () => number;
  readonly createPreviewId?: () => string;
  readonly dateKey?: () => string;
  readonly faultInjector?: (
    point: Phase3MaintenanceFaultPoint
  ) => void | Promise<void>;
  /** Reconcile private derived state after a confirmed Vault readback. */
  readonly onCommitted?: (
    producedPaths: readonly string[]
  ) => void | Promise<void>;
  /** Test-only naming seam for the frozen Manifest's exact WAL paths. */
  readonly walFileId?: (previewId: string) => string;
}

/**
 * Production Phase 3 boundary behind the one `knowledge_maintain` Pi Tool.
 * It owns no Agent, Session, Tool loop, or transcript. Preview/control bytes
 * stay below `.echoink/`; every formal write goes through VaultDomainService.
 */
export class ProductionPiKnowledgeMaintenanceToolPort
implements PiKnowledgeMaintenanceToolPort {
  readonly state: FilePhase3MaintenanceStateStore;

  private readonly onTerminal?: CreateProductionPiKnowledgeMaintenanceOptions["onTerminal"];
  private readonly vaultRootPath: string;
  private readonly privateKnowledgeRootPath: string;
  private readonly vaultId: string;
  private readonly userId: string;
  private readonly deviceId: string;
  private readonly domainService: VaultDomainService;
  private readonly knowledgeAgentIndex?: Pick<
    KnowledgeAgentIndex,
    "readReliableKnowledgeForRaw"
  >;
  private readonly sources: FilePhase3MaintenanceSourceSnapshotPort;
  private readonly tracker: FilePhase3MaintenanceTrackerPort;
  private readonly now: () => number;
  private readonly createPreviewId: () => string;
  private readonly dateKey: () => string;
  private readonly faultInjector?: (
    point: Phase3MaintenanceFaultPoint
  ) => void | Promise<void>;
  private readonly onCommitted?: (
    producedPaths: readonly string[]
  ) => void | Promise<void>;

  constructor(
    options: Readonly<CreateProductionPiKnowledgeMaintenanceOptions>
  ) {
    this.vaultRootPath = path.resolve(options.vaultRootPath);
    this.privateKnowledgeRootPath = path.resolve(
      options.privateKnowledgeRootPath
    );
    this.vaultId = requireNonEmpty(options.vaultId, "vaultId");
    this.userId = requireNonEmpty(options.userId, "userId");
    this.deviceId = requireNonEmpty(options.deviceId, "deviceId");
    this.domainService = options.domainService;
    this.knowledgeAgentIndex = options.knowledgeAgentIndex;
    this.now = options.now ?? Date.now;
    this.createPreviewId = options.createPreviewId ?? randomUUID;
    this.dateKey = options.dateKey ?? localDateKey;
    this.faultInjector = options.faultInjector;
    this.onCommitted = options.onCommitted;
    this.onTerminal = options.onTerminal;
    this.state = new FilePhase3MaintenanceStateStore({
      storageRootPath: this.privateKnowledgeRootPath,
      vaultId: this.vaultId,
      walFileId: options.walFileId
    });
    this.sources = new FilePhase3MaintenanceSourceSnapshotPort({
      vaultRootPath: this.vaultRootPath,
      vaultId: this.vaultId
    });
    this.tracker = new FilePhase3MaintenanceTrackerPort({
      vaultRootPath: this.vaultRootPath,
      vaultId: this.vaultId,
      domainService: this.domainService
    });
  }

  async initialize(): Promise<void> {
    await this.state.initialize();
    await this.createService(
      new UnavailableMaintenanceProposalPort()
    ).recoverPendingOrThrow(this.vaultId);
  }

  async execute(
    input: Readonly<PiKnowledgeMaintenanceToolInput>
  ): Promise<Readonly<PiKnowledgeMaintenanceToolResult>> {
    const result = await this.executeMaintenance(input);
    try {
      await this.onTerminal?.({ input, result, at: this.now() });
    } catch (error) {
      console.error("EchoInk maintenance history could not be saved", error);
    }
    return result;
  }

  private async executeMaintenance(
    input: Readonly<PiKnowledgeMaintenanceToolInput>
  ): Promise<Readonly<PiKnowledgeMaintenanceToolResult>> {
    try {
      this.assertIdentity(input);
      if (input.signal?.aborted) return cancelledResult();
      const actions = input.candidateActions ?? [];
      if (actions.length > 0 && !(input.assessments?.length)) {
        throw new Phase3MaintenanceError(
          "invalid_input",
          "Knowledge maintenance writes require at least one assessment"
        );
      }
      const sourcePaths = input.sourcePaths?.length
        ? [...input.sourcePaths]
        : extractExplicitRawPaths(input.request);
      if (sourcePaths.length === 1 && this.knowledgeAgentIndex) {
        const reliable = await this.knowledgeAgentIndex
          .readReliableKnowledgeForRaw(sourcePaths[0])
          .catch(() => null);
        if (reliable?.entries.length) {
          return Object.freeze({
            status: "completed" as const,
            producedPaths: Object.freeze([]),
            maintenanceResult: createKnowledgeMaintenanceResultEnvelope({
              status: "noop",
              assessments: input.assessments
            }),
            protocolVersion: ECHOINK_KNOWLEDGE_MAINTENANCE_PROTOCOL_VERSION,
            preferenceProfileVersion: input.preferenceSnapshot?.profileVersion,
            preferenceState: input.preferenceSnapshot?.state,
            message: reliableKnowledgeNoopMessage(reliable)
          });
        }
      }
      const preference = requirePreferenceSnapshot(input.preferenceSnapshot);
      const proposal = new FilePhase3MaintenanceShadowProposalPort({
          vaultRootPath: this.vaultRootPath,
          privateKnowledgeRootPath: this.privateKnowledgeRootPath,
          vaultId: this.vaultId,
          candidateActions: actions
      });
      const committed = await this.createService(proposal).execute({
        vaultId: this.vaultId,
        dateKey: this.dateKey(),
        explicitRawPaths: sourcePaths,
        preference,
        toolCall: {
          productRunId: input.productRunId,
          toolCallId: input.toolCallId,
          conversationId: input.conversationId,
          piSessionId: input.piSessionId,
          vaultId: input.vaultId,
          userId: this.userId,
          deviceId: this.deviceId
        },
        ...(input.signal ? { signal: input.signal } : {})
      });
      if (committed.appliedPaths.length && this.onCommitted) {
        await Promise.resolve(this.onCommitted(committed.appliedPaths))
          .catch(() => undefined);
      }
      return Object.freeze({
        status: committed.status === "completed" ? "completed" as const : "failed" as const,
        producedPaths: committed.appliedPaths,
        maintenanceResult: createKnowledgeMaintenanceResultEnvelope({
          status: actions.length === 0 && committed.status === "completed"
            ? "noop"
            : committed.status,
          notes: committed.notes,
          issues: committed.issues,
          systemPaths: committed.systemPaths,
          assessments: input.assessments
        }),
        protocolVersion: ECHOINK_KNOWLEDGE_MAINTENANCE_PROTOCOL_VERSION,
        preferenceProfileVersion:
          preference.profileVersion,
        preferenceState: preference.state,
        ...(committed.status === "completed"
          ? {}
          : { errorCode: committed.status === "write_uncertain"
              ? "write_uncertain" as const
              : "write_failed" as const }),
        message: [
          committed.status === "completed" && actions.length === 0
            ? "Raw 已检查，没有可提炼内容；原文保留，本轮未生成知识笔记。"
            : committed.status === "completed"
              ? "知识维护已安全写入并完成 Readback。"
              : committed.status === "partial"
                ? "知识维护部分完成；仅展示已回读验证的知识笔记。"
                : committed.status === "write_uncertain"
                  ? "知识写入状态不确定，已停止继续写入。"
                  : "知识维护失败，未完成回读验证的候选不会显示为成功。",
          ...committed.appliedPaths.map((relativePath) => `- ${relativePath}`)
        ].join("\n")
      });
    } catch (error) {
      if (input.signal?.aborted) return cancelledResult();
      return Object.freeze({
        status: "failed" as const,
        ...(error instanceof Phase3MaintenanceError
          ? { errorCode: error.code }
          : { errorCode: "knowledge_maintenance_failed" as const }),
        message: safeMaintenanceError(error),
        maintenanceResult: createKnowledgeMaintenanceResultEnvelope({
          status: error instanceof Phase3MaintenanceError
            && error.code === "write_uncertain"
            ? "write_uncertain"
            : "failed",
          issues: [{
            code: error instanceof Phase3MaintenanceError
              ? error.code
              : "knowledge_maintenance_failed",
            message: safeMaintenanceError(error),
            ...(error instanceof Phase3MaintenanceError && error.relativePath
              ? { path: error.relativePath }
              : {})
          }],
          assessments: input.assessments
        })
      });
    }
  }

  private createService(
    proposal: Phase3MaintenanceProposalPort
  ): Phase3KnowledgeMaintenanceService {
    return new Phase3KnowledgeMaintenanceService({
      domain: this.domainService,
      sources: this.sources,
      tracker: this.tracker,
      proposal,
      state: this.state,
      createPreviewId: this.createPreviewId,
      now: this.now,
      ...(this.faultInjector ? { faultInjector: this.faultInjector } : {})
    });
  }

  private assertIdentity(
    input: Readonly<PiKnowledgeMaintenanceToolInput>
  ): void {
    if (input.vaultId !== this.vaultId) {
      throw new Phase3MaintenanceError(
        "invalid_input",
        "Knowledge maintenance Tool Call belongs to another Vault"
      );
    }
    for (const key of [
      "conversationId",
      "piSessionId",
      "productRunId",
      "toolCallId"
    ] as const) requireNonEmpty(input[key], key);
  }
}

export function createProductionPiKnowledgeMaintenanceToolPort(
  options: Readonly<CreateProductionPiKnowledgeMaintenanceOptions>
): ProductionPiKnowledgeMaintenanceToolPort {
  return new ProductionPiKnowledgeMaintenanceToolPort(options);
}

interface FilePhase3MaintenanceStateStoreOptions {
  storageRootPath: string;
  vaultId: string;
  walFileId?: (previewId: string) => string;
}

export class FilePhase3MaintenanceStateStore
implements Phase3MaintenanceStateStore {
  readonly rootPath: string;

  private readonly vaultId: string;
  private readonly walFileId: (previewId: string) => string;

  constructor(options: Readonly<FilePhase3MaintenanceStateStoreOptions>) {
    this.vaultId = requireNonEmpty(options.vaultId, "vaultId");
    this.rootPath = path.resolve(options.storageRootPath);
    this.walFileId = options.walFileId ?? ((previewId) => previewId);
  }

  async initialize(): Promise<void> {
    await assertExistingPrivateStateDirectoriesSafe(this.rootPath);
  }

  async createPreview(
    preview: Parameters<Phase3MaintenanceStateStore["createPreview"]>[0]
  ): Promise<void> {
    this.assertVault(preview.vaultId);
    const previewId = requireControlId(preview.previewId);
    await serializePiNativeFileWrite(this.rootPath, async () => {
      await this.initializeUnlocked();
      const filePath = this.previewPath(previewId);
      if (await readJsonFileIfPresent(filePath, "Phase 3 preview") !== null) {
        throw new Error("phase3_preview_exists");
      }
      await writeControlEnvelope(filePath, this.vaultId, "preview", {
        preview,
        status: "active"
      });
    });
  }

  async loadPreview(
    previewIdInput: string
  ): Promise<Readonly<Phase3MaintenanceStoredPreview> | null> {
    const previewId = requireControlId(previewIdInput);
    const payload = await readControlEnvelope(
      this.previewPath(previewId),
      this.vaultId,
      "preview"
    );
    if (payload === null) return null;
    const stored = requireStoredPreview(payload);
    if (stored.preview.previewId !== previewId) {
      throw new Error("phase3_preview_identity_mismatch");
    }
    this.assertVault(stored.preview.vaultId);
    return stored;
  }

  async listActivePreviews(): Promise<
    readonly Readonly<Phase3MaintenanceStoredPreview>[]
  > {
    await this.initialize();
    let names: string[];
    try {
      names = await readdir(path.join(this.rootPath, "previews"));
    } catch (error) {
      if (isNodeErrorWithCode(error, "ENOENT")) return Object.freeze([]);
      throw error;
    }
    const previews: Readonly<Phase3MaintenanceStoredPreview>[] = [];
    for (const name of names.sort()) {
      if (!name.endsWith(".json")) continue;
      const previewId = requireControlId(name.slice(0, -".json".length));
      const stored = await this.loadPreview(previewId);
      if (stored?.status === "active") previews.push(stored);
    }
    previews.sort((left, right) =>
      right.preview.createdAt - left.preview.createdAt
      || left.preview.previewId.localeCompare(right.preview.previewId, "en")
    );
    return Object.freeze(previews);
  }

  async setPreviewStatus(
    input: Parameters<Phase3MaintenanceStateStore["setPreviewStatus"]>[0]
  ): Promise<void> {
    const previewId = requireControlId(input.previewId);
    await serializePiNativeFileWrite(this.rootPath, async () => {
      const stored = await this.loadPreview(previewId);
      if (!stored) throw new Error("phase3_preview_missing");
      if (stored.status !== input.expected) {
        throw new Error("phase3_preview_status_conflict");
      }
      await writeControlEnvelope(
        this.previewPath(previewId),
        this.vaultId,
        "preview",
        {
          preview: stored.preview,
          status: input.status,
          ...(input.reason ? { reason: input.reason } : {})
        }
      );
    });
  }

  async createWal(
    wal: Parameters<Phase3MaintenanceStateStore["createWal"]>[0]
  ): Promise<Readonly<Phase3MaintenanceWalRecord>> {
    this.assertVault(wal.preview.vaultId);
    const previewId = requireControlId(wal.preview.previewId);
    return await serializePiNativeFileWrite(this.rootPath, async () => {
      await this.initializeUnlocked();
      const filePath = this.walPath(previewId);
      if (await readJsonFileIfPresent(filePath, "Phase 3 WAL") !== null) {
        throw new Error("phase3_wal_exists");
      }
      return await writeControlEnvelope(
        filePath,
        this.vaultId,
        "wal",
        wal
      );
    });
  }

  async loadWal(
    previewIdInput: string
  ): Promise<Readonly<Phase3MaintenanceWalRecord> | null> {
    const previewId = requireControlId(previewIdInput);
    const payload = await readControlEnvelope(
      this.walPath(previewId),
      this.vaultId,
      "wal"
    );
    if (payload === null) return null;
    const wal = requireWal(payload);
    if (wal.preview.previewId !== previewId) {
      throw new Error("phase3_wal_identity_mismatch");
    }
    this.assertVault(wal.preview.vaultId);
    return wal;
  }

  async listRecoverableWals(
    vaultId: string
  ): Promise<readonly Readonly<Phase3MaintenanceWalRecord>[]> {
    this.assertVault(vaultId);
    let names: string[];
    try {
      names = await readdir(path.join(this.rootPath, "wal"));
    } catch (error) {
      if (isNodeErrorWithCode(error, "ENOENT")) return [];
      throw error;
    }
    const records: Phase3MaintenanceWalRecord[] = [];
    for (const name of names.sort()) {
      if (!name.endsWith(".json")) continue;
      const payload = await readControlEnvelope(
        path.join(this.rootPath, "wal", name),
        this.vaultId,
        "wal"
      );
      if (payload === null) continue;
      const wal = requireWal(payload);
      this.assertVault(wal.preview.vaultId);
      records.push(wal);
    }
    return Object.freeze(records.map((record) => deepFreeze(record)));
  }

  async saveWal(
    wal: Parameters<Phase3MaintenanceStateStore["saveWal"]>[0],
    expectedSequence: number
  ): Promise<Readonly<Phase3MaintenanceWalRecord>> {
    this.assertVault(wal.preview.vaultId);
    const previewId = requireControlId(wal.preview.previewId);
    return await serializePiNativeFileWrite(this.rootPath, async () => {
      const current = await this.loadWal(previewId);
      if (!current) throw new Error("phase3_wal_missing");
      if (current.sequence !== expectedSequence) {
        throw new Error("phase3_wal_sequence_conflict");
      }
      return await writeControlEnvelope(
        this.walPath(previewId),
        this.vaultId,
        "wal",
        wal
      );
    });
  }

  private async initializeUnlocked(): Promise<void> {
    await ensurePrivateStateDirectories(this.rootPath);
  }

  private assertVault(vaultId: string): void {
    if (vaultId !== this.vaultId) throw new Error("phase3_vault_mismatch");
  }

  private previewPath(previewId: string): string {
    return path.join(this.rootPath, "previews", `${previewId}.json`);
  }

  private walPath(previewId: string): string {
    return path.join(
      this.rootPath,
      "wal",
      `${requireControlId(this.walFileId(previewId))}.json`
    );
  }
}

class FilePhase3MaintenanceSourceSnapshotPort
implements Phase3MaintenanceSourceSnapshotPort {
  private readonly vaultRootPath: string;

  constructor(private readonly options: Readonly<{
    vaultRootPath: string;
    vaultId: string;
  }>) {
    this.vaultRootPath = path.resolve(options.vaultRootPath);
  }

  async snapshotRaw(input: Readonly<{
    vaultId: string;
    relativePath: string;
  }>): Promise<Readonly<Phase3MaintenanceSourceBinding>> {
    this.assertVault(input.vaultId);
    const raw = await readImmutableFile(
      this.vaultRootPath,
      normalizeVaultRelativePath(input.relativePath)
    );
    const text = UTF8_DECODER.decode(raw.bytes);
    const attachments: Phase3MaintenanceImmutableFileBinding[] = [];
    for (const relativePath of extractAttachmentPaths(raw.relativePath, text)) {
      const attachment = await readImmutableFileIfPresent(
        this.vaultRootPath,
        relativePath
      );
      if (attachment) attachments.push(fileBinding(attachment));
    }
    attachments.sort((left, right) => left.relativePath.localeCompare(
      right.relativePath,
      "en"
    ));
    return Object.freeze({
      raw: fileBinding(raw),
      attachments: Object.freeze(attachments)
    });
  }

  private assertVault(vaultId: string): void {
    if (vaultId !== this.options.vaultId) {
      throw new Error("phase3_source_vault_mismatch");
    }
  }
}

class FilePhase3MaintenanceTrackerPort implements Phase3MaintenanceTrackerPort {
  private readonly vaultRootPath: string;

  constructor(private readonly options: Readonly<{
    vaultRootPath: string;
    vaultId: string;
    domainService: VaultDomainService;
  }>) {
    this.vaultRootPath = path.resolve(options.vaultRootPath);
  }

  async snapshot(input: Readonly<{
    vaultId: string;
  }>): Promise<Readonly<Phase3MaintenanceTrackerSnapshot>> {
    if (input.vaultId !== this.options.vaultId) {
      throw new Error("phase3_tracker_vault_mismatch");
    }
    const [file, readback] = await Promise.all([
      readImmutableFileIfPresent(
        this.vaultRootPath,
        PHASE3_MAINTENANCE_TRACKER_PATH
      ),
      this.options.domainService.readback({
        vaultId: input.vaultId,
        relativePath: PHASE3_MAINTENANCE_TRACKER_PATH
      })
    ]);
    if (!file) {
      if (readback.status !== "missing") {
        throw new Error("phase3_tracker_readback_mismatch");
      }
      return Object.freeze({
        binding: Object.freeze({ kind: "missing" as const }),
        changedRawPaths: Object.freeze([])
      });
    }
    if (
      readback.status !== "present"
      || !readback.snapshot
      || readback.snapshot.contentSha256 !== file.sha256
      || readback.snapshot.byteLength !== file.bytes.length
    ) {
      throw new Error("phase3_tracker_readback_mismatch");
    }
    return Object.freeze({
      binding: Object.freeze({
        kind: "file" as const,
        version: readback.snapshot.version,
        contentSha256: file.sha256,
        byteLength: file.bytes.length
      }),
      changedRawPaths: Object.freeze(parseChangedRawPaths(
        UTF8_DECODER.decode(file.bytes)
      ))
    });
  }
}

class FilePhase3MaintenanceShadowProposalPort
implements Phase3MaintenanceProposalPort {
  private readonly vaultRootPath: string;
  private readonly privateKnowledgeRootPath: string;

  constructor(private readonly options: Readonly<{
    vaultRootPath: string;
    privateKnowledgeRootPath: string;
    vaultId: string;
    candidateActions: readonly Readonly<{
      targetPath: string;
      content: string;
      expectedTarget: Readonly<
        | { kind: "missing" }
        | { kind: "file"; contentRevision: string }
      >;
    }>[];
  }>) {
    this.vaultRootPath = path.resolve(options.vaultRootPath);
    this.privateKnowledgeRootPath = path.resolve(
      options.privateKnowledgeRootPath
    );
  }

  async generate(
    input: Readonly<Phase3MaintenanceProposalInput>
  ): Promise<Readonly<Phase3MaintenanceProposal>> {
    if (input.vaultId !== this.options.vaultId) {
      throw new Error("phase3_shadow_vault_mismatch");
    }
    const previewId = requireControlId(input.previewId);
    const shadowRoot = await ensurePrivateStateDirectory(
      this.privateKnowledgeRootPath,
      ["shadow", previewId]
    );
    const proposedFolders = new Set<string>();
    for (const action of this.options.candidateActions) {
      const target = normalizeVaultRelativePath(action.targetPath);
      if (!target.startsWith("wiki/")) continue;
      const parts = target.split("/").slice(0, -1);
      for (let depth = 2; depth <= parts.length; depth++) {
        const folder = parts.slice(0, depth).join("/");
        const name = parts[depth - 1];
        const existing = await lstat(path.join(this.vaultRootPath, folder)).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return null; throw error;
        });
        if (existing || proposedFolders.has(folder)) continue;
        if (!isBilingualWikiFolder(name)) throw new Phase3MaintenanceError("proposal_invalid", "wiki_category_requires_bilingual", folder);
        const parent = parts.slice(0, depth - 1).join("/");
        const siblings: import("node:fs").Dirent[] = await readdir(path.join(this.vaultRootPath, parent), { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return []; throw error;
        });
        const names = [...siblings.filter((entry) => entry.isDirectory()).map((entry) => entry.name),
          ...[...proposedFolders].filter((entry) => path.posix.dirname(entry) === parent).map((entry) => path.posix.basename(entry))];
        const duplicate = names.find((sibling) => wikiFolderEnglishId(sibling) === wikiFolderEnglishId(name));
        if (duplicate) throw new Phase3MaintenanceError("proposal_invalid", "wiki_category_already_exists", `${parent}/${duplicate}`);
        proposedFolders.add(folder);
      }
    }
    const knowledgeActions = this.options.candidateActions.map((action) => {
      const requestedTargetPath = normalizeVaultRelativePath(action.targetPath);
      if (
        !requestedTargetPath.toLowerCase().endsWith(".md")
        || (
          !requestedTargetPath.startsWith("wiki/")
          && !requestedTargetPath.startsWith("projects/")
        )
        || requestedTargetPath.split("/").some((segment) =>
          segment.startsWith("."))
      ) {
        throw new Error("phase3_model_candidate_outside_knowledge_targets");
      }
      // Keep the formal target exactly aligned with the Agent's note_read
      // evidence. Only the private Shadow file name is flattened below.
      const targetPath = requestedTargetPath;
      validateKnowledgeMaintenanceCandidateSources({
        targetPath,
        content: action.content,
        selectedSources: input.selectedSources.map((source) => ({
          relativePath: source.raw.relativePath,
          contentSha256: source.raw.contentSha256
        }))
      });
      return Object.freeze({
        targetPath,
        content: action.content,
        expectedTarget: action.expectedTarget
      });
    });
    const usedNames = new Set<string>();
    for (const action of knowledgeActions) {
      const fileName = uniqueShadowFileName(action.targetPath, usedNames);
      await writeNewFileWithReadback(
        path.join(shadowRoot, fileName),
        Buffer.from(action.content, "utf8")
      );
    }
    const managedActions = await deterministicManagedActions(
      this.vaultRootPath,
      input,
      knowledgeActions
    );
    const actions: readonly Readonly<Phase3MaintenanceProposalAction>[] =
      Object.freeze([...knowledgeActions, ...managedActions]);
    return Object.freeze({
      shadowId: previewId,
      shadowRevision: sha256(stableJson(actions)),
      actions: Object.freeze(actions.map((action) =>
        Object.freeze({
          targetPath: action.targetPath,
          content: action.content,
          ...(action.expectedTarget
            ? { expectedTarget: action.expectedTarget }
            : {})
        })
      ))
    });
  }
}

async function deterministicManagedActions(
  vaultRootPath: string,
  input: Readonly<Phase3MaintenanceProposalInput>,
  knowledgeActions: readonly Readonly<{
    targetPath: string;
    content: string;
  }>[]
): Promise<readonly Readonly<{ targetPath: string; content: string }>[]> {
  const [rawIndexFile, trackerFile] = await Promise.all([
    readImmutableFileIfPresent(vaultRootPath, PHASE3_MAINTENANCE_RAW_INDEX_PATH),
    readImmutableFileIfPresent(vaultRootPath, PHASE3_MAINTENANCE_TRACKER_PATH)
  ]);
  const selectedPaths = input.selectedSources.map((source) =>
    source.raw.relativePath
  );
  const rawIndexBefore = rawIndexFile
    ? UTF8_DECODER.decode(rawIndexFile.bytes).trimEnd()
    : "# Raw Index";
  const trackerBefore = trackerFile
    ? UTF8_DECODER.decode(trackerFile.bytes).trimEnd()
    : "# Knowledge Maintenance Tracker";
  const rawIndexContent = [
    rawIndexBefore,
    "",
    `## Phase 3 ${input.dateKey}`,
    ...selectedPaths.map((relativePath) => `- \`${relativePath}\``),
    ""
  ].join("\n");
  const trackerContent = [
    trackerBefore,
    "",
    `## Processed ${input.dateKey} (${input.previewId})`,
    ...selectedPaths.map((relativePath) => `- \`${relativePath}\``),
    ...(input.remainingRawPaths.length
      ? [
          "",
          "## Changed Raw",
          ...input.remainingRawPaths.map((relativePath) =>
            `- \`${relativePath}\``
          )
        ]
      : []),
    ""
  ].join("\n");
  const reportContent = [
    `# Knowledge Maintenance ${input.dateKey}`,
    "",
    `- previewId: \`${input.previewId}\``,
    `- protocolVersion: \`${input.protocolVersion}\``,
    `- sourceMode: \`${input.sourceMode}\``,
    "",
    "## Processed Raw",
    ...selectedPaths.map((relativePath) => `- \`${relativePath}\``),
    "",
    "## Knowledge targets",
    ...knowledgeActions.map((action) => `- \`${action.targetPath}\``),
    "",
    "## Remaining Raw",
    ...(input.remainingRawPaths.length
      ? input.remainingRawPaths.map((relativePath) => `- \`${relativePath}\``)
      : ["- none"]),
    ""
  ].join("\n");
  return Object.freeze([
    Object.freeze({
      targetPath: PHASE3_MAINTENANCE_RAW_INDEX_PATH,
      content: rawIndexContent
    }),
    Object.freeze({
      targetPath: PHASE3_MAINTENANCE_TRACKER_PATH,
      content: trackerContent
    }),
    Object.freeze({
      targetPath: input.reportPath,
      content: reportContent
    })
  ]);
}

class UnavailableMaintenanceProposalPort
implements Phase3MaintenanceProposalPort {
  async generate(): Promise<never> {
    throw new Error("phase3_proposal_generation_not_available_during_confirm");
  }
}

interface ImmutableFileRead {
  relativePath: string;
  bytes: Buffer;
  sha256: string;
}

async function readImmutableFile(
  vaultRootPath: string,
  relativePathInput: string
): Promise<Readonly<ImmutableFileRead>> {
  const relativePath = normalizeVaultRelativePath(relativePathInput);
  const absolutePath = await resolveRegularFile(vaultRootPath, relativePath);
  const flags = fsConstants.O_RDONLY
    | (typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0);
  const handle = await open(absolutePath, flags);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("phase3_source_not_regular");
    const bytes = await handle.readFile();
    return Object.freeze({
      relativePath,
      bytes,
      sha256: createHash("sha256").update(bytes).digest("hex")
    });
  } finally {
    await handle.close();
  }
}

async function readImmutableFileIfPresent(
  vaultRootPath: string,
  relativePath: string
): Promise<Readonly<ImmutableFileRead> | null> {
  try {
    return await readImmutableFile(vaultRootPath, relativePath);
  } catch (error) {
    if (isNodeErrorWithCode(error, "ENOENT")) return null;
    throw error;
  }
}

async function resolveRegularFile(
  vaultRootPathInput: string,
  relativePath: string
): Promise<string> {
  const vaultRootPath = await realpath(vaultRootPathInput);
  let cursor = vaultRootPath;
  const segments = relativePath.split("/");
  for (const [index, segment] of segments.entries()) {
    cursor = path.join(cursor, segment);
    const stat = await lstat(cursor);
    if (stat.isSymbolicLink()) throw new Error("phase3_symbolic_link_rejected");
    if (index < segments.length - 1 && !stat.isDirectory()) {
      throw new Error("phase3_parent_not_directory");
    }
    if (index === segments.length - 1 && !stat.isFile()) {
      throw new Error("phase3_source_not_regular");
    }
  }
  const resolved = await realpath(cursor);
  if (!isInside(vaultRootPath, resolved)) {
    throw new Error("phase3_source_outside_vault");
  }
  return resolved;
}

function fileBinding(
  file: Readonly<ImmutableFileRead>
): Readonly<Phase3MaintenanceImmutableFileBinding> {
  return Object.freeze({
    kind: "file" as const,
    relativePath: file.relativePath,
    revision: file.sha256,
    contentSha256: file.sha256,
    byteLength: file.bytes.length
  });
}

function extractAttachmentPaths(
  rawRelativePath: string,
  text: string
): string[] {
  const candidates: string[] = [];
  for (const match of text.matchAll(/!\[\[([^\]]+)\]\]/gu)) {
    if (match[1]) candidates.push(match[1].split(/[|#^]/u, 1)[0] ?? "");
  }
  for (const match of text.matchAll(/!\[[^\]]*\]\(([^)]+)\)/gu)) {
    if (match[1]) candidates.push(match[1].split(/[?#]/u, 1)[0] ?? "");
  }
  const rawDirectory = path.posix.dirname(rawRelativePath);
  const normalized = new Set<string>();
  for (const raw of candidates) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(raw.trim().replace(/^<|>$/gu, ""));
    } catch {
      continue;
    }
    if (!decoded || /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(decoded)) continue;
    if (decoded.startsWith("/") || decoded.includes("\\")) continue;
    try {
      const relativePath = normalizeVaultRelativePath(
        decoded.includes("/")
          ? decoded
          : path.posix.join(rawDirectory, decoded)
      );
      if (
        relativePath !== rawRelativePath
        && !relativePath.split("/").some((segment) => segment.startsWith("."))
      ) normalized.add(relativePath);
    } catch {
      // Invalid link text is not an attachment capability.
    }
  }
  return [...normalized].sort((left, right) => left.localeCompare(right, "en"));
}

function parseChangedRawPaths(text: string): string[] {
  const changed = new Set<string>();
  let inChangedSection = false;
  for (const line of text.split(/\r?\n/u)) {
    const heading = /^#{1,6}\s+(.+)$/u.exec(line);
    if (heading) {
      inChangedSection = /(?:changed|变更|变化|待处理|未处理)/iu.test(
        heading[1] ?? ""
      );
      continue;
    }
    if (!inChangedSection && !/(?:changed|变更|变化)/iu.test(line)) continue;
    for (const match of line.matchAll(/raw\/[\p{L}\p{N}_. /-]+?\.md\b/giu)) {
      try {
        changed.add(normalizeVaultRelativePath(match[0].trim()));
      } catch {
        // The service rejects invalid paths; the parser ignores non-path text.
      }
    }
  }
  return [...changed].sort((left, right) => left.localeCompare(right, "en"));
}

async function ensureSafeControlDirectories(
  vaultRootPathInput: string,
  relativePaths: readonly string[]
): Promise<void> {
  const vaultRootPath = await realpath(vaultRootPathInput);
  for (const relativePathInput of relativePaths) {
    const relativePath = normalizeVaultRelativePath(relativePathInput);
    let cursor = vaultRootPath;
    for (const segment of relativePath.split("/")) {
      cursor = path.join(cursor, segment);
      let stat = await lstat(cursor).catch((error: unknown) => {
        if (isNodeErrorWithCode(error, "ENOENT")) return null;
        throw error;
      });
      if (!stat) {
        await mkdir(cursor, { mode: 0o700 });
        stat = await lstat(cursor);
      }
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error("phase3_control_path_unsafe");
      }
    }
    const resolved = await realpath(cursor);
    if (!isInside(vaultRootPath, resolved)) {
      throw new Error("phase3_control_path_outside_vault");
    }
  }
}

async function assertExistingPrivateStateDirectoriesSafe(
  rootPathInput: string
): Promise<void> {
  const stat = await lstat(rootPathInput).catch((error: unknown) => {
    if (isNodeErrorWithCode(error, "ENOENT")) return null;
    throw error;
  });
  if (!stat) return;
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("phase3_private_state_root_unsafe");
  }
  const rootPath = await realpath(rootPathInput);
  if (rootPath !== path.resolve(rootPathInput)) {
    throw new Error("phase3_private_state_root_changed");
  }
  for (const name of ["previews", "shadow", "wal"]) {
    const child = path.join(rootPath, name);
    const childStat = await lstat(child).catch((error: unknown) => {
      if (isNodeErrorWithCode(error, "ENOENT")) return null;
      throw error;
    });
    if (!childStat) continue;
    if (!childStat.isDirectory() || childStat.isSymbolicLink()) {
      throw new Error("phase3_private_state_path_unsafe");
    }
    if (await realpath(child) !== child) {
      throw new Error("phase3_private_state_path_changed");
    }
  }
}

async function ensurePrivateStateDirectories(rootPath: string): Promise<void> {
  await Promise.all([
    ensurePrivateStateDirectory(rootPath, ["previews"]),
    ensurePrivateStateDirectory(rootPath, ["shadow"]),
    ensurePrivateStateDirectory(rootPath, ["wal"])
  ]);
}

async function ensurePrivateStateDirectory(
  rootPathInput: string,
  segments: readonly string[]
): Promise<string> {
  const rootPath = path.resolve(rootPathInput);
  await mkdir(rootPath, { recursive: true, mode: 0o700 });
  const rootStat = await lstat(rootPath);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("phase3_private_state_root_unsafe");
  }
  if (await realpath(rootPath) !== rootPath) {
    throw new Error("phase3_private_state_root_changed");
  }
  let cursor = rootPath;
  for (const segment of segments) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u.test(segment)) {
      throw new Error("phase3_private_state_segment_invalid");
    }
    cursor = path.join(cursor, segment);
    let stat = await lstat(cursor).catch((error: unknown) => {
      if (isNodeErrorWithCode(error, "ENOENT")) return null;
      throw error;
    });
    if (!stat) {
      await mkdir(cursor, { mode: 0o700 });
      stat = await lstat(cursor);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error("phase3_private_state_path_unsafe");
    }
    if (await realpath(cursor) !== cursor) {
      throw new Error("phase3_private_state_path_changed");
    }
  }
  return cursor;
}

async function writeNewFileWithReadback(
  filePath: string,
  bytes: Buffer
): Promise<void> {
  const handle = await open(filePath, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  const readback = await readFile(filePath);
  if (!readback.equals(bytes)) throw new Error("phase3_shadow_readback_failed");
}

interface ControlEnvelope {
  schemaVersion: 1;
  vaultId: string;
  kind: "preview" | "wal";
  payloadDigest: string;
  payload: unknown;
}

async function writeControlEnvelope<T>(
  filePath: string,
  vaultId: string,
  kind: ControlEnvelope["kind"],
  payload: T
): Promise<Readonly<T>> {
  const jsonPayload = JSON.parse(JSON.stringify(payload)) as unknown;
  const envelope: ControlEnvelope = {
    schemaVersion: 1,
    vaultId,
    kind,
    payloadDigest: sha256(stableJson(jsonPayload)),
    payload: jsonPayload
  };
  const readback = await atomicWriteJsonFile(
    filePath,
    envelope,
    `Phase 3 maintenance ${kind}`,
    (value) => parseControlEnvelope(value, vaultId, kind)
  );
  return deepFreeze(readback.payload as T);
}

async function readControlEnvelope(
  filePath: string,
  vaultId: string,
  kind: ControlEnvelope["kind"]
): Promise<unknown> {
  const value = await readJsonFileIfPresent(
    filePath,
    `Phase 3 maintenance ${kind}`
  );
  if (value === null) return null;
  return deepFreeze(parseControlEnvelope(value, vaultId, kind).payload);
}

function parseControlEnvelope(
  value: unknown,
  vaultId: string,
  kind: ControlEnvelope["kind"]
): ControlEnvelope {
  if (!isRecord(value)) throw new Error("phase3_control_document_invalid");
  if (
    value.schemaVersion !== 1
    || value.vaultId !== vaultId
    || value.kind !== kind
    || typeof value.payloadDigest !== "string"
    || value.payloadDigest !== sha256(stableJson(value.payload))
  ) {
    throw new Error("phase3_control_document_invalid");
  }
  return value as unknown as ControlEnvelope;
}

function requireStoredPreview(
  value: unknown
): Readonly<Phase3MaintenanceStoredPreview> {
  if (!isRecord(value) || !isRecord(value.preview)) {
    throw new Error("phase3_preview_document_invalid");
  }
  if (
    value.status !== "active"
    && value.status !== "confirmed"
    && value.status !== "invalid"
  ) throw new Error("phase3_preview_document_invalid");
  if (
    value.preview.protocolVersion
      !== ECHOINK_KNOWLEDGE_MAINTENANCE_PROTOCOL_VERSION
    ||
    typeof value.preview.preferenceProfileVersion !== "string"
    || (value.preview.preferenceState !== "default"
      && value.preview.preferenceState !== "custom")
    || typeof value.preview.preferenceRevision !== "string"
    || !/^sha256:[a-f0-9]{64}$/u.test(value.preview.preferenceRevision)
    ||
    typeof value.preview.previewId !== "string"
    || typeof value.preview.vaultId !== "string"
    || !Array.isArray(value.preview.actions)
  ) throw new Error("phase3_preview_document_invalid");
  return deepFreeze(value as unknown as Phase3MaintenanceStoredPreview);
}

function requireWal(value: unknown): Readonly<Phase3MaintenanceWalRecord> {
  if (
    !isRecord(value)
    || value.version !== 1
    || !isRecord(value.preview)
    || value.preview.protocolVersion
      !== ECHOINK_KNOWLEDGE_MAINTENANCE_PROTOCOL_VERSION
    || typeof value.preview.preferenceProfileVersion !== "string"
    || (value.preview.preferenceState !== "default"
      && value.preview.preferenceState !== "custom")
    || typeof value.preview.preferenceRevision !== "string"
    || !/^sha256:[a-f0-9]{64}$/u.test(value.preview.preferenceRevision)
    || typeof value.preview.previewId !== "string"
    || typeof value.preview.vaultId !== "string"
    || !Number.isSafeInteger(value.sequence)
    || !Array.isArray(value.actions)
  ) throw new Error("phase3_wal_document_invalid");
  return deepFreeze(value as unknown as Phase3MaintenanceWalRecord);
}

function reliableKnowledgeNoopMessage(
  reliable: Readonly<KnowledgeAgentReliableRawKnowledge>
): string {
  const content = [
    `Raw ${reliable.rawPath} 未变化，已复用现有知识；knowledge_maintain=noop。`,
    ...reliable.entries.flatMap((entry) => [
      `\n## ${entry.title}`,
      `路径：${entry.vaultRelativePath}`,
      entry.content
    ])
  ].join("\n");
  const bytes = Buffer.from(content, "utf8");
  if (bytes.byteLength <= 6_000) return content;
  return `${bytes.subarray(0, 5_900).toString("utf8").replace(/\uFFFD$/u, "")}\n\n（现有知识内容较长，已截断显示；本轮仍为 noop。）`;
}

function cancelledResult(): Readonly<PiKnowledgeMaintenanceToolResult> {
  return Object.freeze({
    status: "cancelled" as const,
    message: "Knowledge maintenance was cancelled before a new write started."
  });
}

function safeMaintenanceError(error: unknown): string {
  if (!(error instanceof Phase3MaintenanceError)) {
    return "Knowledge maintenance failed; unverified candidates are not reported as successful.";
  }
  switch (error.code) {
    case "invalid_input":
      return "维护请求无效；请检查是否提供了可处理的 Raw 来源。";
    case "invalid_raw_path":
      return "Raw 来源路径无效；请重新选择当前 Vault 内的 Raw 文件。";
    case "proposal_invalid":
      if (error.message === "wiki_category_requires_bilingual") return "新 Wiki 分类目录须为 中文（english-slug）；本轮没有提交。";
      if (error.message === "wiki_category_already_exists") return `请复用已有 Wiki 分类 ${error.relativePath}，不要新建同义目录；本轮没有提交。`;
      if (error.message === PHASE3_MAINTENANCE_RECOVERED_RETRY_MESSAGE) {
        return "上一次维护事务已完成恢复；本轮候选已作废，请重新运行 /maintain。";
      }
      return "维护候选未通过固定协议校验；本轮没有提交。";
    case "preview_not_found":
      return "维护预览不存在；请重新生成预览。";
    case "preview_inactive":
      return "维护预览已失效或已处理；请重新生成预览。";
    case "preview_stale":
      return "维护预览或来源已变化；请重新生成预览。";
    case "approval_failed":
      return "维护授权上下文无效；本轮没有继续写入。";
    case "wal_conflict":
      return "维护事务状态冲突；请先核对当前维护状态。";
    case "write_failed":
      return "维护写入未完成；请核对目标后再决定是否重试。";
    case "write_uncertain":
      return "维护写入结果尚不确定；请先核对实际文件，勿自动重试。";
    case "recovery_blocked":
      return "维护恢复被阻塞；请先核对上一次事务状态。";
  }
}

function extractExplicitRawPaths(value: string): string[] {
  const paths = new Set<string>();
  for (const match of value.matchAll(/raw\/[\p{L}\p{N}_. /-]+?\.md\b/giu)) {
    try {
      paths.add(normalizeVaultRelativePath(match[0].trim()));
    } catch {
      // The service will use Tracker sources if no valid explicit path exists.
    }
  }
  return [...paths].sort((left, right) => left.localeCompare(right, "en"));
}

function uniqueShadowFileName(
  targetPath: string,
  usedNames: Set<string>
): string {
  const normalized = targetPath
    .replaceAll("\\", "-")
    .replaceAll("/", "-")
    .replace(/[^\p{L}\p{N}_. -]/gu, "-")
    .replace(/^\.+/u, "")
    .slice(0, 180) || "candidate";
  let candidate = normalized;
  if (usedNames.has(candidate)) {
    const extension = path.posix.extname(normalized);
    const stem = extension ? normalized.slice(0, -extension.length) : normalized;
    candidate = `${stem}-${sha256(targetPath).slice(0, 12)}${extension}`;
  }
  if (usedNames.has(candidate)) throw new Error("phase3_shadow_name_collision");
  usedNames.add(candidate);
  return candidate;
}

function requireControlId(value: string): string {
  const id = requireNonEmpty(value, "controlId");
  if (!CONTROL_ID.test(id)) throw new Error("phase3_control_id_invalid");
  return id;
}

function requireNonEmpty(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${label}_invalid`);
  }
  return value.trim();
}

function requirePreferenceSnapshot(
  value: PiKnowledgeMaintenanceToolInput["preferenceSnapshot"]
): Readonly<{
  profileVersion: string;
  state: "default" | "custom";
  revision: string;
}> {
  if (!value) {
    throw new Phase3MaintenanceError(
      "proposal_invalid",
      "Knowledge maintenance preference snapshot is missing"
    );
  }
  const profileVersion = requireNonEmpty(
    value.profileVersion,
    "preferenceProfileVersion"
  );
  if (value.state !== "default" && value.state !== "custom") {
    throw new Phase3MaintenanceError(
      "proposal_invalid",
      "Knowledge maintenance preference state is invalid"
    );
  }
  if (!/^sha256:[a-f0-9]{64}$/u.test(value.revision)) {
    throw new Phase3MaintenanceError(
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

function localDateKey(): string {
  const now = new Date();
  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0")
  ].join("-");
}

function isInside(rootPath: string, candidatePath: string): boolean {
  const relative = path.relative(rootPath, candidatePath);
  return relative === ""
    || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function stableJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).filter((key) => record[key] !== undefined)
    .sort().map((key) =>
    `${JSON.stringify(key)}:${stableJson(record[key])}`
  ).join(",")}}`;
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}
