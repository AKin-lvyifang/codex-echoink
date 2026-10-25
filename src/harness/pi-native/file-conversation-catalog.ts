import { copyFile, lstat, unlink } from "node:fs/promises";
import { constants } from "node:fs";
import { CONVERSATION_TASK_METADATA_KEYS, normalizeConversationTaskMetadata, applyConversationTaskMetadata, type ConversationTaskMetadata } from "../../agents/task-metadata";
import * as path from "node:path";
import type {
  PiConversationCatalogEntry,
  PiConversationCatalogStatus,
  PiConversationDiagnostic,
  PiConversationDraftRecord,
  PiConversationMemoryMode
} from "./contracts";
import {
  PI_NATIVE_FILE_SCHEMA_VERSION,
  PiNativeFileStoreError,
  atomicWriteJsonFile,
  ensurePiNativeVaultFileLayout,
  piNativeVaultFileLayout,
  readJsonFileIfPresent,
  requireExactKeys,
  requireNonEmptyString,
  requirePlainObject,
  requireTimestamp,
  serializePiNativeFileWrite,
  stablePathToken,
  type PiNativeVaultFileLayout
} from "./file-store-utils";
import { normalizedJournalDirectoryOrNull } from "../../home/journal-directory";

const CATALOG_STATUSES = new Set<PiConversationCatalogStatus>([
  "active",
  "archived",
  "deleted"
]);
const MEMORY_MODES = new Set<PiConversationMemoryMode>([
  "normal",
  "no_memory"
]);
const DRAFT_SOURCES = new Set<PiConversationDraftRecord["source"]>([
  "steering",
  "follow_up",
  "abort",
  "restart"
]);
const DIAGNOSTIC_CODES = new Set<PiConversationDiagnostic["code"]>([
  "session_jsonl_malformed",
  "session_jsonl_truncated",
  "session_recovered_prefix",
  "model_metadata_incompatible",
  "runtime_resource_warning",
  "runtime_interrupted"
]);

interface ConversationCatalogDocumentV1 {
  schemaVersion: typeof PI_NATIVE_FILE_SCHEMA_VERSION;
  vaultId: string;
  entries: PiConversationCatalogEntry[];
  drafts: PiConversationDraftRecord[];
  diagnostics: PiConversationDiagnostic[];
}

interface ConversationSessionBindingV1 {
  schemaVersion: typeof PI_NATIVE_FILE_SCHEMA_VERSION;
  vaultId: string;
  conversationId: string;
  piSessionId: string;
}

export interface FileConversationCatalogOptions {
  /** Common root shared by every Vault so identity claims can prevent cross-Vault reuse. */
  storageRootPath: string;
  vaultId: string;
  now?: () => number;
}

export interface PiConversationCatalogListOptions {
  statuses?: readonly PiConversationCatalogStatus[];
  agentId?: string;
}

export interface AdoptVerifiedRecoverySessionFileInput {
  conversationId: string;
  piSessionId: string;
  expectedSessionFile: string;
  recoverySessionFile: string;
  updatedAt?: number;
}

export interface DiscardUnacceptedConversationCreateInput {
  conversationId: string;
  piSessionId: string;
}

/**
 * The EchoInk-owned metadata index for Pi-native conversations.
 *
 * It deliberately has no message, Tool result, compaction or branch fields.
 * Those remain owned by the Pi Session JSONL under `sessionRootPath`.
 */
export class FileConversationCatalog {
  readonly vaultId: string;
  readonly storageRootPath: string;
  readonly vaultRootPath: string;
  readonly sessionRootPath: string;
  readonly filePath: string;

  private readonly layout: PiNativeVaultFileLayout;
  private readonly now: () => number;
  private preAgentMetadataBackupReady = false;

  constructor(options: FileConversationCatalogOptions) {
    this.vaultId = requireNonEmptyString(options.vaultId, "vaultId");
    this.layout = piNativeVaultFileLayout(
      options.storageRootPath,
      this.vaultId
    );
    this.storageRootPath = this.layout.storageRootPath;
    this.vaultRootPath = this.layout.vaultRootPath;
    this.sessionRootPath = this.layout.sessionRootPath;
    this.filePath = this.layout.catalogPath;
    this.now = options.now ?? Date.now;
  }

  async initialize(): Promise<void> {
    await serializePiNativeFileWrite(this.storageRootPath, async () => {
      await ensurePiNativeVaultFileLayout(this.layout);
      const existing = await readJsonFileIfPresent(
        this.filePath,
        "Pi Conversation Catalog"
      );
      if (existing !== null) {
        parseCatalogDocument(existing, this.vaultId, this.layout);
        return;
      }
      await this.writeDocument(emptyCatalogDocument(this.vaultId));
    });
  }

  async list(
    options: PiConversationCatalogListOptions = {}
  ): Promise<Readonly<PiConversationCatalogEntry>[]> {
    const document = await this.readDocument();
    const statuses = options.statuses
      ? new Set(options.statuses.map(requireCatalogStatus))
      : null;
    return document.entries
      .filter((entry) => !statuses || statuses.has(entry.status))
      .filter((entry) => !options.agentId || entry.agentId === options.agentId)
      .sort((left, right) =>
        right.updatedAt - left.updatedAt
        || left.conversationId.localeCompare(right.conversationId)
      )
      .map(cloneCatalogEntry);
  }

  async get(
    conversationId: string
  ): Promise<Readonly<PiConversationCatalogEntry> | null> {
    const normalizedId = requireNonEmptyString(
      conversationId,
      "conversationId"
    );
    const document = await this.readDocument();
    const entry = document.entries.find(
      (candidate) => candidate.conversationId === normalizedId
    );
    return entry ? cloneCatalogEntry(entry) : null;
  }

  async upsert(
    input: Readonly<PiConversationCatalogEntry>
  ): Promise<Readonly<PiConversationCatalogEntry>> {
    const candidate = normalizeCatalogEntry(
      input,
      this.vaultId,
      this.layout
    );
    return await serializePiNativeFileWrite(
      this.storageRootPath,
      async () => {
        await ensurePiNativeVaultFileLayout(this.layout);
        const document = await this.readDocument();
        const existingIndex = document.entries.findIndex(
          (entry) => entry.conversationId === candidate.conversationId
        );
        const sessionOwner = document.entries.find(
          (entry) => entry.piSessionId === candidate.piSessionId
        );
        if (
          sessionOwner
          && sessionOwner.conversationId !== candidate.conversationId
        ) {
          throw mappingConflict(
            `piSessionId ${candidate.piSessionId} 已绑定到 Conversation ${sessionOwner.conversationId}`
          );
        }

        if (existingIndex >= 0) {
          const existing = document.entries[existingIndex];
          assertStableCatalogIdentity(existing, candidate);
          // Existing task fields have their own CAS writer. A stale full-entry
          // upsert for memory/session metadata must not erase a newer task patch.
          applyConversationTaskMetadata(candidate, existing);
          if (existing.status === "deleted" && candidate.status !== "deleted") {
            throw mappingConflict(
              `已删除的 Conversation ${candidate.conversationId} 不能重新激活或复用`
            );
          }
          if (candidate.createdAt !== existing.createdAt) {
            throw mappingConflict(
              `Conversation ${candidate.conversationId} 的 createdAt 不可改写`
            );
          }
          if (candidate.updatedAt < existing.updatedAt) {
            throw new PiNativeFileStoreError(
              "invalid-input",
              `Conversation ${candidate.conversationId} 的 updatedAt 不得回退`
            );
          }
        }

        await this.ensureBindingClaims(candidate);
        const nextDocument = cloneCatalogDocument(document);
        if (existingIndex >= 0) {
          nextDocument.entries[existingIndex] = candidate;
        } else {
          nextDocument.entries.push(candidate);
        }
        const readback = await this.writeDocument(nextDocument);
        return cloneCatalogEntry(requireCatalogEntry(
          readback,
          candidate.conversationId
        ));
      }
    );
  }

  async discardUnacceptedCreate(
    input: Readonly<DiscardUnacceptedConversationCreateInput>
  ): Promise<void> {
    const conversationId = requireNonEmptyString(
      input.conversationId,
      "conversationId"
    );
    const piSessionId = requireNonEmptyString(input.piSessionId, "piSessionId");
    const claim: ConversationSessionBindingV1 = {
      schemaVersion: PI_NATIVE_FILE_SCHEMA_VERSION,
      vaultId: this.vaultId,
      conversationId,
      piSessionId
    };
    await serializePiNativeFileWrite(this.storageRootPath, async () => {
      await ensurePiNativeVaultFileLayout(this.layout);
      const document = await this.readDocument();
      const matchingIndex = document.entries.findIndex((entry) =>
        entry.conversationId === conversationId
        && entry.piSessionId === piSessionId);
      if (matchingIndex >= 0) {
        const nextDocument = cloneCatalogDocument(document);
        nextDocument.entries.splice(matchingIndex, 1);
        nextDocument.drafts = nextDocument.drafts.filter((draft) =>
          draft.conversationId !== conversationId
          || draft.piSessionId !== piSessionId);
        nextDocument.diagnostics = nextDocument.diagnostics.filter((diagnostic) =>
          diagnostic.conversationId !== conversationId
          || diagnostic.piSessionId !== piSessionId);
        await this.writeDocument(nextDocument);
      }
      await removeExactBindingClaim(
        path.join(
          this.layout.conversationBindingsRootPath,
          `${stablePathToken(conversationId)}.json`
        ),
        claim,
        "Conversation identity claim"
      );
      await removeExactBindingClaim(
        path.join(
          this.layout.piSessionBindingsRootPath,
          `${stablePathToken(piSessionId)}.json`
        ),
        claim,
        "Pi Session identity claim"
      );
    });
  }

  async rename(
    conversationId: string,
    title: string,
    updatedAt = this.now()
  ): Promise<Readonly<PiConversationCatalogEntry>> {
    const normalizedTitle = requireNonEmptyString(title, "title");
    return await this.updateEntry(
      conversationId,
      updatedAt,
      (entry) => ({ ...entry, title: normalizedTitle })
    );
  }

  async status(
    conversationId: string,
    status: PiConversationCatalogStatus,
    updatedAt = this.now()
  ): Promise<Readonly<PiConversationCatalogEntry>> {
    const normalizedStatus = requireCatalogStatus(status);
    return await this.updateEntry(
      conversationId,
      updatedAt,
      (entry) => {
        if (entry.status === "deleted" && normalizedStatus !== "deleted") {
          throw mappingConflict(
            `已删除的 Conversation ${entry.conversationId} 不能重新激活或复用`
          );
        }
        return { ...entry, status: normalizedStatus };
      }
    );
  }

  /** Optimistic projection writes cannot replace newer Catalog metadata. */
  async updateTaskMetadata(
    conversationId: string,
    metadata: ConversationTaskMetadata,
    expectedRevision: number | undefined,
    metadataUpdatedAt = this.now()
  ): Promise<Readonly<PiConversationCatalogEntry>> {
    const metadataTimestamp = requireTimestamp(metadataUpdatedAt, "taskMetadataUpdatedAt");
    // Metadata projections are not conversation activity (sorting/auto-archive).
    return await this.updateEntry(conversationId, undefined, entry => {
      if (entry.taskMetadataUpdatedAt !== expectedRevision) {
        throw new PiNativeFileStoreError("invalid-input", "Conversation task metadata changed; reload before saving");
      }
      const next = applyConversationTaskMetadata(entry, metadata);
      next.taskMetadataUpdatedAt = Math.max(metadataTimestamp, (expectedRevision ?? 0) + 1);
      return next;
    });
  }

  async sessionFile(conversationId: string): Promise<string | null>;
  async sessionFile(
    conversationId: string,
    sessionFile: string,
    updatedAt?: number
  ): Promise<Readonly<PiConversationCatalogEntry>>;
  async sessionFile(
    conversationId: string,
    sessionFile?: string,
    updatedAt = this.now()
  ): Promise<string | null | Readonly<PiConversationCatalogEntry>> {
    if (sessionFile === undefined) {
      const entry = await this.get(conversationId);
      if (!entry) throw notFound(conversationId);
      return entry.sessionFile ?? null;
    }
    const normalizedPath = normalizeSessionFilePath(
      sessionFile,
      this.layout
    );
    return await this.updateEntry(
      conversationId,
      updatedAt,
      (entry) => {
        if (entry.sessionFile && entry.sessionFile !== normalizedPath) {
          throw mappingConflict(
            `Conversation ${entry.conversationId} 的 Pi Session 文件不可改绑`
          );
        }
        return { ...entry, sessionFile: normalizedPath };
      }
    );
  }

  /**
   * The sole Catalog pointer replacement path. Validation that the target is
   * an exact durability-adapter recovery prefix remains the Runtime's job;
   * this method only performs an atomic identity/path compare-and-swap.
   */
  async adoptVerifiedRecoverySessionFile(
    input: Readonly<AdoptVerifiedRecoverySessionFileInput>
  ): Promise<Readonly<PiConversationCatalogEntry>> {
    const conversationId = requireNonEmptyString(
      input.conversationId,
      "conversationId"
    );
    const piSessionId = requireNonEmptyString(
      input.piSessionId,
      "piSessionId"
    );
    const expectedSessionFile = normalizeSessionFilePath(
      input.expectedSessionFile,
      this.layout
    );
    const recoverySessionFile = normalizeSessionFilePath(
      input.recoverySessionFile,
      this.layout
    );
    if (expectedSessionFile === recoverySessionFile) {
      throw new PiNativeFileStoreError(
        "invalid-input",
        "Verified recovery Session file must differ from its corrupt source"
      );
    }
    const updatedAt = requireTimestamp(
      input.updatedAt ?? this.now(),
      "updatedAt"
    );
    return await serializePiNativeFileWrite(
      this.storageRootPath,
      async () => {
        const document = await this.readDocument();
        const index = document.entries.findIndex(
          (entry) => entry.conversationId === conversationId
        );
        if (index < 0) throw notFound(conversationId);
        const existing = document.entries[index];
        if (existing.status === "deleted") {
          throw new PiNativeFileStoreError(
            "invalid-transition",
            `已删除的 Conversation ${conversationId} 不能恢复 Pi Session`
          );
        }
        if (existing.piSessionId !== piSessionId) {
          throw mappingConflict(
            `Conversation ${conversationId} 的 Pi Session 身份已变化`
          );
        }
        if (existing.sessionFile !== expectedSessionFile) {
          throw mappingConflict(
            `Conversation ${conversationId} 的 Pi Session 文件已变化，拒绝恢复改绑`
          );
        }
        if (updatedAt < existing.updatedAt) {
          throw new PiNativeFileStoreError(
            "invalid-input",
            `Conversation ${conversationId} 的 updatedAt 不得回退`
          );
        }
        const recoveryOwner = document.entries.find(
          (entry) => entry.sessionFile === recoverySessionFile
        );
        if (
          recoveryOwner
          && recoveryOwner.conversationId !== conversationId
        ) {
          throw mappingConflict(
            `Verified recovery Session file 已绑定到 Conversation ${recoveryOwner.conversationId}`
          );
        }
        const candidate = normalizeCatalogEntry(
          {
            ...cloneCatalogEntry(existing),
            sessionFile: recoverySessionFile,
            updatedAt
          },
          this.vaultId,
          this.layout
        );
        const nextDocument = cloneCatalogDocument(document);
        nextDocument.entries[index] = candidate;
        const readback = await this.writeDocument(nextDocument);
        return cloneCatalogEntry(requireCatalogEntry(
          readback,
          conversationId
        ));
      }
    );
  }

  sessionFilePath(piSessionId: string): string {
    const normalizedSessionId = requireNonEmptyString(
      piSessionId,
      "piSessionId"
    );
    return path.join(
      this.sessionRootPath,
      `${stablePathToken(normalizedSessionId)}.jsonl`
    );
  }

  async drafts(
    conversationId: string
  ): Promise<Readonly<PiConversationDraftRecord>[]>;
  async drafts(
    conversationId: string,
    replacement: readonly Readonly<PiConversationDraftRecord>[]
  ): Promise<Readonly<PiConversationDraftRecord>[]>;
  async drafts(
    conversationId: string,
    replacement?: readonly Readonly<PiConversationDraftRecord>[]
  ): Promise<Readonly<PiConversationDraftRecord>[]> {
    const normalizedConversationId = requireNonEmptyString(
      conversationId,
      "conversationId"
    );
    if (replacement === undefined) {
      const document = await this.readDocument();
      requireCatalogEntry(document, normalizedConversationId);
      return sortedDrafts(document.drafts, normalizedConversationId);
    }
    return await serializePiNativeFileWrite(
      this.storageRootPath,
      async () => {
        const document = await this.readDocument();
        const entry = requireMutableCatalogEntry(
          document,
          normalizedConversationId
        );
        const normalized = replacement.map((draft) =>
          normalizeDraftRecord(draft, entry)
        );
        assertUniqueRecordIds(normalized, "draftId", "Draft");
        const nextDocument = cloneCatalogDocument(document);
        nextDocument.drafts = [
          ...nextDocument.drafts.filter(
            (draft) => draft.conversationId !== normalizedConversationId
          ),
          ...normalized
        ];
        const readback = await this.writeDocument(nextDocument);
        return sortedDrafts(readback.drafts, normalizedConversationId);
      }
    );
  }

  async upsertDraft(
    input: Readonly<PiConversationDraftRecord>
  ): Promise<Readonly<PiConversationDraftRecord>> {
    return await serializePiNativeFileWrite(
      this.storageRootPath,
      async () => {
        const document = await this.readDocument();
        const entry = requireMutableCatalogEntry(
          document,
          input.conversationId
        );
        const candidate = normalizeDraftRecord(input, entry);
        const nextDocument = cloneCatalogDocument(document);
        const existingIndex = nextDocument.drafts.findIndex(
          (draft) => draft.draftId === candidate.draftId
        );
        if (existingIndex >= 0) {
          const existing = nextDocument.drafts[existingIndex];
          if (
            existing.conversationId !== candidate.conversationId
            || existing.piSessionId !== candidate.piSessionId
            || existing.createdAt !== candidate.createdAt
          ) {
            throw mappingConflict(
              `draftId ${candidate.draftId} 已由另一条草稿占用`
            );
          }
          nextDocument.drafts[existingIndex] = candidate;
        } else {
          nextDocument.drafts.push(candidate);
        }
        const readback = await this.writeDocument(nextDocument);
        return cloneDraftRecord(readback.drafts.find(
          (draft) => draft.draftId === candidate.draftId
        )!);
      }
    );
  }

  async removeDraft(draftId: string): Promise<boolean> {
    const normalizedDraftId = requireNonEmptyString(draftId, "draftId");
    return await serializePiNativeFileWrite(
      this.storageRootPath,
      async () => {
        const document = await this.readDocument();
        const nextDrafts = document.drafts.filter(
          (draft) => draft.draftId !== normalizedDraftId
        );
        if (nextDrafts.length === document.drafts.length) return false;
        const nextDocument = cloneCatalogDocument(document);
        nextDocument.drafts = nextDrafts.map(cloneDraftRecord);
        await this.writeDocument(nextDocument);
        return true;
      }
    );
  }

  async diagnostics(
    conversationId: string
  ): Promise<Readonly<PiConversationDiagnostic>[]>;
  async diagnostics(
    conversationId: string,
    replacement: readonly Readonly<PiConversationDiagnostic>[]
  ): Promise<Readonly<PiConversationDiagnostic>[]>;
  async diagnostics(
    conversationId: string,
    replacement?: readonly Readonly<PiConversationDiagnostic>[]
  ): Promise<Readonly<PiConversationDiagnostic>[]> {
    const normalizedConversationId = requireNonEmptyString(
      conversationId,
      "conversationId"
    );
    if (replacement === undefined) {
      const document = await this.readDocument();
      requireCatalogEntry(document, normalizedConversationId);
      return sortedDiagnostics(document.diagnostics, normalizedConversationId);
    }
    return await serializePiNativeFileWrite(
      this.storageRootPath,
      async () => {
        const document = await this.readDocument();
        const entry = requireCatalogEntry(document, normalizedConversationId);
        const normalized = replacement.map((diagnostic) =>
          normalizeDiagnostic(diagnostic, entry)
        );
        assertUniqueRecordIds(normalized, "diagnosticId", "Diagnostic");
        const nextDocument = cloneCatalogDocument(document);
        nextDocument.diagnostics = [
          ...nextDocument.diagnostics.filter(
            (diagnostic) =>
              diagnostic.conversationId !== normalizedConversationId
          ),
          ...normalized
        ];
        const readback = await this.writeDocument(nextDocument);
        return sortedDiagnostics(
          readback.diagnostics,
          normalizedConversationId
        );
      }
    );
  }

  async appendDiagnostic(
    input: Readonly<PiConversationDiagnostic>
  ): Promise<Readonly<PiConversationDiagnostic>> {
    return await serializePiNativeFileWrite(
      this.storageRootPath,
      async () => {
        const document = await this.readDocument();
        const entry = requireCatalogEntry(document, input.conversationId);
        const candidate = normalizeDiagnostic(input, entry);
        const existing = document.diagnostics.find(
          (diagnostic) => diagnostic.diagnosticId === candidate.diagnosticId
        );
        if (existing) {
          if (!sameDiagnostic(existing, candidate)) {
            throw mappingConflict(
              `diagnosticId ${candidate.diagnosticId} 已由另一条诊断占用`
            );
          }
          return cloneDiagnostic(existing);
        }
        const nextDocument = cloneCatalogDocument(document);
        nextDocument.diagnostics.push(candidate);
        const readback = await this.writeDocument(nextDocument);
        return cloneDiagnostic(readback.diagnostics.find(
          (diagnostic) => diagnostic.diagnosticId === candidate.diagnosticId
        )!);
      }
    );
  }

  private async updateEntry(
    conversationId: string,
    updatedAt: number | undefined,
    update: (
      entry: PiConversationCatalogEntry
    ) => PiConversationCatalogEntry
  ): Promise<Readonly<PiConversationCatalogEntry>> {
    const normalizedConversationId = requireNonEmptyString(
      conversationId,
      "conversationId"
    );
    const normalizedUpdatedAt = updatedAt === undefined ? undefined : requireTimestamp(updatedAt, "updatedAt");
    return await serializePiNativeFileWrite(
      this.storageRootPath,
      async () => {
        const document = await this.readDocument();
        const index = document.entries.findIndex(
          (entry) => entry.conversationId === normalizedConversationId
        );
        if (index < 0) throw notFound(normalizedConversationId);
        const existing = document.entries[index];
        if (normalizedUpdatedAt !== undefined && normalizedUpdatedAt < existing.updatedAt) {
          throw new PiNativeFileStoreError(
            "invalid-input",
            `Conversation ${normalizedConversationId} 的 updatedAt 不得回退`
          );
        }
        const candidate = normalizeCatalogEntry(
          update({ ...cloneCatalogEntry(existing), ...(normalizedUpdatedAt === undefined ? {} : { updatedAt: normalizedUpdatedAt }) }),
          this.vaultId,
          this.layout
        );
        assertStableCatalogIdentity(existing, candidate);
        const nextDocument = cloneCatalogDocument(document);
        nextDocument.entries[index] = candidate;
        const readback = await this.writeDocument(nextDocument);
        return cloneCatalogEntry(requireCatalogEntry(
          readback,
          normalizedConversationId
        ));
      }
    );
  }

  private async readDocument(): Promise<ConversationCatalogDocumentV1> {
    const value = await readJsonFileIfPresent(
      this.filePath,
      "Pi Conversation Catalog"
    );
    return value === null
      ? emptyCatalogDocument(this.vaultId)
      : parseCatalogDocument(value, this.vaultId, this.layout);
  }

  private async writeDocument(
    document: ConversationCatalogDocumentV1
  ): Promise<ConversationCatalogDocumentV1> {
    await this.ensurePreAgentMetadataBackup(document);
    const stored = await atomicWriteJsonFile(
      this.filePath,
      document,
      "Pi Conversation Catalog",
      (value) => {
        const normalized = parseCatalogDocument(value, this.vaultId, this.layout);
        return { ...normalized, entries: normalized.entries.map(entry => entry.sessionFile
          ? { ...entry, sessionFile: path.relative(this.sessionRootPath, entry.sessionFile).split(path.sep).join("/") } : entry) };
      }
    );
    return parseCatalogDocument(stored, this.vaultId, this.layout);
  }

  /** Back up actual old bytes before any writer publishes the new strict-schema fields. */
  private async ensurePreAgentMetadataBackup(document: ConversationCatalogDocumentV1): Promise<void> {
    // Every nonempty document gains agentId during schema normalization.
    if (this.preAgentMetadataBackupReady || document.entries.length === 0) return;
    try {
      const original = await readJsonFileIfPresent(this.filePath, "Pi Conversation Catalog");
      // There is no pre-migration document to recover on a new install. Once
      // upgraded, never label a P1 document as an old-version backup either.
      if (original !== null) {
        const raw = requirePlainObject(original, "Pi Conversation Catalog");
        if (!Array.isArray(raw.entries)) throw new Error("Catalog entries invalid");
        const alreadyUpgraded = raw.entries.some((entry: unknown) => entry && typeof entry === "object"
          && CONVERSATION_TASK_METADATA_KEYS.some(key => Object.hasOwn(entry, key)));
        if (!alreadyUpgraded) {
          const backupPath = this.filePath.replace(/\.json$/u, ".pre-agent-metadata-v1.json");
          try {
            await copyFile(this.filePath, backupPath, constants.COPYFILE_EXCL);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !(await lstat(backupPath)).isFile()) throw error;
          }
        }
      }
      this.preAgentMetadataBackupReady = true;
    } catch (error) {
      throw new Error("Pi Conversation Catalog backup failed; task metadata was not written.", { cause: error });
    }
  }

  private async ensureBindingClaims(
    entry: PiConversationCatalogEntry
  ): Promise<void> {
    const claim: ConversationSessionBindingV1 = {
      schemaVersion: PI_NATIVE_FILE_SCHEMA_VERSION,
      vaultId: this.vaultId,
      conversationId: entry.conversationId,
      piSessionId: entry.piSessionId
    };
    const conversationClaimPath = path.join(
      this.layout.conversationBindingsRootPath,
      `${stablePathToken(entry.conversationId)}.json`
    );
    const sessionClaimPath = path.join(
      this.layout.piSessionBindingsRootPath,
      `${stablePathToken(entry.piSessionId)}.json`
    );

    // Preflight both directions before publishing either claim. Within the
    // repository-wide writer queue this avoids leaving a partial claim when an
    // already-owned identity is rejected.
    await assertBindingClaimAvailable(
      conversationClaimPath,
      claim,
      "Conversation identity claim"
    );
    await assertBindingClaimAvailable(
      sessionClaimPath,
      claim,
      "Pi Session identity claim"
    );
    await ensureBindingClaim(
      conversationClaimPath,
      claim,
      "Conversation identity claim"
    );
    await ensureBindingClaim(
      sessionClaimPath,
      claim,
      "Pi Session identity claim"
    );
  }
}

function emptyCatalogDocument(vaultId: string): ConversationCatalogDocumentV1 {
  return {
    schemaVersion: PI_NATIVE_FILE_SCHEMA_VERSION,
    vaultId,
    entries: [],
    drafts: [],
    diagnostics: []
  };
}

function parseCatalogDocument(
  value: unknown,
  expectedVaultId: string,
  layout: PiNativeVaultFileLayout
): ConversationCatalogDocumentV1 {
  try {
    const object = requirePlainObject(value, "Pi Conversation Catalog");
    requireExactKeys(
      object,
      ["schemaVersion", "vaultId", "entries", "drafts", "diagnostics"],
      [],
      "Pi Conversation Catalog"
    );
    if (object.schemaVersion !== PI_NATIVE_FILE_SCHEMA_VERSION) {
      throw new Error(`不支持 schemaVersion ${String(object.schemaVersion)}`);
    }
    if (object.vaultId !== expectedVaultId) {
      throw new Error("Vault identity 与目录不匹配");
    }
    if (
      !Array.isArray(object.entries)
      || !Array.isArray(object.drafts)
      || !Array.isArray(object.diagnostics)
    ) {
      throw new Error("entries、drafts、diagnostics 必须是数组");
    }
    const entries = object.entries.map((entry) =>
      normalizeCatalogEntry(entry, expectedVaultId, layout)
    );
    assertUniqueRecordIds(entries, "conversationId", "Conversation");
    assertUniqueRecordIds(entries, "piSessionId", "Pi Session");
    const drafts = object.drafts.map((draft) => {
      const raw = requirePlainObject(draft, "Pi Conversation Draft");
      const conversationId = requireNonEmptyString(
        raw.conversationId,
        "draft.conversationId"
      );
      return normalizeDraftRecord(
        raw,
        requireCatalogEntryById(entries, conversationId)
      );
    });
    assertUniqueRecordIds(drafts, "draftId", "Draft");
    const diagnostics = object.diagnostics.map((diagnostic) => {
      const raw = requirePlainObject(
        diagnostic,
        "Pi Conversation Diagnostic"
      );
      const conversationId = requireNonEmptyString(
        raw.conversationId,
        "diagnostic.conversationId"
      );
      return normalizeDiagnostic(
        raw,
        requireCatalogEntryById(entries, conversationId)
      );
    });
    assertUniqueRecordIds(diagnostics, "diagnosticId", "Diagnostic");
    return {
      schemaVersion: PI_NATIVE_FILE_SCHEMA_VERSION,
      vaultId: expectedVaultId,
      entries,
      drafts,
      diagnostics
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
      `Pi Conversation Catalog 校验失败：${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function normalizeCatalogEntry(
  value: unknown,
  expectedVaultId: string,
  layout: PiNativeVaultFileLayout
): PiConversationCatalogEntry {
  const object = requirePlainObject(value, "Conversation Catalog Entry");
  requireExactKeys(
    object,
    [
      "conversationId",
      "piSessionId",
      "vaultId",
      "title",
      "status",
      "defaultMemoryMode",
      "createdAt",
      "updatedAt"
    ],
    // Legacy P3 display metadata is accepted only for reading and omitted from normalized entries.
    ["sessionFile", "defaultSkillId", "journalDirectory", "taskTransfers", ...CONVERSATION_TASK_METADATA_KEYS],
    "Conversation Catalog Entry"
  );
  const vaultId = requireNonEmptyString(object.vaultId, "entry.vaultId");
  if (vaultId !== expectedVaultId) {
    throw mappingConflict(
      `Conversation Catalog Entry 不属于当前 Vault ${expectedVaultId}`
    );
  }
  const createdAt = requireTimestamp(object.createdAt, "entry.createdAt");
  const updatedAt = requireTimestamp(object.updatedAt, "entry.updatedAt");
  if (updatedAt < createdAt) {
    throw new PiNativeFileStoreError(
      "invalid-input",
      "Conversation Catalog Entry 的 updatedAt 不得早于 createdAt"
    );
  }
  const sessionFile = object.sessionFile === undefined
    ? undefined
    : normalizeSessionFilePath(object.sessionFile, layout);
  const defaultSkillId = object.defaultSkillId === undefined
    ? undefined
    : requireSkillId(object.defaultSkillId, "entry.defaultSkillId");
  const journalDirectory = object.journalDirectory === undefined
    ? undefined
    : requireJournalDirectory(
        object.journalDirectory,
        "entry.journalDirectory"
      );
  const taskMetadata = normalizeConversationTaskMetadata(object);
  for (const key of CONVERSATION_TASK_METADATA_KEYS) {
    const raw = object[key];
    const expected = taskMetadata[key];
    const matches = key === "pendingResponse" && raw && expected
      ? typeof raw === "object" && !Array.isArray(raw)
        && Object.keys(raw).sort().join(",") === "kind,questionId,runId"
        && Object.entries(raw).every(([name, value]) => value === (expected as unknown as Record<string, unknown>)[name])
      : raw === expected;
    if (raw !== undefined && !matches) {
      throw new PiNativeFileStoreError("invalid-input", `Conversation task metadata ${key} invalid`);
    }
  }
  return {
    ...taskMetadata,
    conversationId: requireNonEmptyString(
      object.conversationId,
      "entry.conversationId"
    ),
    piSessionId: requireNonEmptyString(
      object.piSessionId,
      "entry.piSessionId"
    ),
    vaultId,
    title: requireNonEmptyString(object.title, "entry.title"),
    status: requireCatalogStatus(object.status),
    defaultMemoryMode: requireMemoryMode(object.defaultMemoryMode),
    ...(defaultSkillId ? { defaultSkillId } : {}),
    ...(journalDirectory ? { journalDirectory } : {}),
    createdAt,
    updatedAt,
    ...(sessionFile ? { sessionFile } : {})
  };
}

function normalizeDraftRecord(
  value: unknown,
  entry: PiConversationCatalogEntry
): PiConversationDraftRecord {
  const object = requirePlainObject(value, "Pi Conversation Draft");
  requireExactKeys(
    object,
    [
      "draftId",
      "conversationId",
      "piSessionId",
      "source",
      "text",
      "createdAt"
    ],
    [],
    "Pi Conversation Draft"
  );
  const conversationId = requireNonEmptyString(
    object.conversationId,
    "draft.conversationId"
  );
  const piSessionId = requireNonEmptyString(
    object.piSessionId,
    "draft.piSessionId"
  );
  if (
    conversationId !== entry.conversationId
    || piSessionId !== entry.piSessionId
  ) {
    throw mappingConflict("Draft 的 Conversation / Pi Session 绑定不匹配");
  }
  if (
    typeof object.source !== "string"
    || !DRAFT_SOURCES.has(object.source as PiConversationDraftRecord["source"])
  ) {
    throw new PiNativeFileStoreError(
      "invalid-input",
      `不支持的 Draft source ${String(object.source)}`
    );
  }
  if (typeof object.text !== "string") {
    throw new PiNativeFileStoreError(
      "invalid-input",
      "draft.text 必须是字符串"
    );
  }
  return {
    draftId: requireNonEmptyString(object.draftId, "draft.draftId"),
    conversationId,
    piSessionId,
    source: object.source as PiConversationDraftRecord["source"],
    text: object.text,
    createdAt: requireTimestamp(object.createdAt, "draft.createdAt")
  };
}

function normalizeDiagnostic(
  value: unknown,
  entry: PiConversationCatalogEntry
): PiConversationDiagnostic {
  const object = requirePlainObject(value, "Pi Conversation Diagnostic");
  requireExactKeys(
    object,
    [
      "diagnosticId",
      "conversationId",
      "piSessionId",
      "code",
      "message",
      "createdAt"
    ],
    ["sourcePath", "recoveryPath"],
    "Pi Conversation Diagnostic"
  );
  const conversationId = requireNonEmptyString(
    object.conversationId,
    "diagnostic.conversationId"
  );
  const piSessionId = requireNonEmptyString(
    object.piSessionId,
    "diagnostic.piSessionId"
  );
  if (
    conversationId !== entry.conversationId
    || piSessionId !== entry.piSessionId
  ) {
    throw mappingConflict(
      "Diagnostic 的 Conversation / Pi Session 绑定不匹配"
    );
  }
  if (
    typeof object.code !== "string"
    || !DIAGNOSTIC_CODES.has(object.code as PiConversationDiagnostic["code"])
  ) {
    throw new PiNativeFileStoreError(
      "invalid-input",
      `不支持的 Diagnostic code ${String(object.code)}`
    );
  }
  const sourcePath = object.sourcePath === undefined
    ? undefined
    : requireNonEmptyString(object.sourcePath, "diagnostic.sourcePath");
  const recoveryPath = object.recoveryPath === undefined
    ? undefined
    : requireNonEmptyString(object.recoveryPath, "diagnostic.recoveryPath");
  return {
    diagnosticId: requireNonEmptyString(
      object.diagnosticId,
      "diagnostic.diagnosticId"
    ),
    conversationId,
    piSessionId,
    code: object.code as PiConversationDiagnostic["code"],
    message: requireNonEmptyString(object.message, "diagnostic.message"),
    ...(sourcePath ? { sourcePath } : {}),
    ...(recoveryPath ? { recoveryPath } : {}),
    createdAt: requireTimestamp(object.createdAt, "diagnostic.createdAt")
  };
}

async function ensureBindingClaim(
  filePath: string,
  expected: ConversationSessionBindingV1,
  label: string
): Promise<void> {
  const currentValue = await readJsonFileIfPresent(filePath, label);
  if (currentValue !== null) {
    const current = parseBindingClaim(currentValue, label);
    if (!sameBindingClaim(current, expected)) {
      throw mappingConflict(
        `${label} 已绑定到 Vault ${current.vaultId} / Conversation ${current.conversationId} / Pi Session ${current.piSessionId}`
      );
    }
    return;
  }
  await atomicWriteJsonFile(
    filePath,
    expected,
    label,
    (value) => {
      const readback = parseBindingClaim(value, label);
      if (!sameBindingClaim(readback, expected)) {
        throw new PiNativeFileStoreError(
          "readback-diverged",
          `${label} 回读身份不一致`
        );
      }
      return readback;
    }
  );
}

async function assertBindingClaimAvailable(
  filePath: string,
  expected: ConversationSessionBindingV1,
  label: string
): Promise<void> {
  const currentValue = await readJsonFileIfPresent(filePath, label);
  if (currentValue === null) return;
  const current = parseBindingClaim(currentValue, label);
  if (!sameBindingClaim(current, expected)) {
    throw mappingConflict(
      `${label} 已绑定到 Vault ${current.vaultId} / Conversation ${current.conversationId} / Pi Session ${current.piSessionId}`
    );
  }
}

async function removeExactBindingClaim(
  filePath: string,
  expected: ConversationSessionBindingV1,
  label: string
): Promise<void> {
  const currentValue = await readJsonFileIfPresent(filePath, label);
  if (currentValue === null) return;
  const current = parseBindingClaim(currentValue, label);
  if (!sameBindingClaim(current, expected)) {
    throw mappingConflict(
      `${label} 不属于本次未接受的 Conversation，拒绝清理`
    );
  }
  try {
    await unlink(filePath);
  } catch (error) {
    if (!isMissingFileError(error)) throw error;
  }
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function parseBindingClaim(
  value: unknown,
  label: string
): ConversationSessionBindingV1 {
  const object = requirePlainObject(value, label);
  requireExactKeys(
    object,
    ["schemaVersion", "vaultId", "conversationId", "piSessionId"],
    [],
    label
  );
  if (object.schemaVersion !== PI_NATIVE_FILE_SCHEMA_VERSION) {
    throw new PiNativeFileStoreError(
      "store-corrupt",
      `${label} schemaVersion 不受支持`
    );
  }
  return {
    schemaVersion: PI_NATIVE_FILE_SCHEMA_VERSION,
    vaultId: requireNonEmptyString(object.vaultId, `${label}.vaultId`),
    conversationId: requireNonEmptyString(
      object.conversationId,
      `${label}.conversationId`
    ),
    piSessionId: requireNonEmptyString(
      object.piSessionId,
      `${label}.piSessionId`
    )
  };
}

function normalizeSessionFilePath(
  value: unknown,
  layout: PiNativeVaultFileLayout
): string {
  const raw = requireNonEmptyString(value, "sessionFile");
  const candidate = path.resolve(layout.sessionRootPath, raw);
  const relative = path.relative(layout.sessionRootPath, candidate);
  if (
    relative.length === 0
    || relative === ".."
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)
  ) {
    throw new PiNativeFileStoreError(
      "invalid-input",
      "sessionFile 必须位于当前 Vault 的 Pi Session Root 内"
    );
  }
  return candidate;
}

function requireCatalogEntry(
  document: ConversationCatalogDocumentV1,
  conversationId: string
): PiConversationCatalogEntry {
  const entry = document.entries.find(
    (candidate) => candidate.conversationId === conversationId
  );
  if (!entry) throw notFound(conversationId);
  return entry;
}

function requireCatalogEntryById(
  entries: readonly PiConversationCatalogEntry[],
  conversationId: string
): PiConversationCatalogEntry {
  const entry = entries.find(
    (candidate) => candidate.conversationId === conversationId
  );
  if (!entry) {
    throw new PiNativeFileStoreError(
      "store-corrupt",
      `记录引用了不存在的 Conversation ${conversationId}`
    );
  }
  return entry;
}

function requireMutableCatalogEntry(
  document: ConversationCatalogDocumentV1,
  conversationId: string
): PiConversationCatalogEntry {
  const entry = requireCatalogEntry(document, conversationId);
  if (entry.status === "deleted") {
    throw new PiNativeFileStoreError(
      "invalid-transition",
      `已删除的 Conversation ${conversationId} 不能新增或改写草稿`
    );
  }
  return entry;
}

function assertStableCatalogIdentity(
  existing: PiConversationCatalogEntry,
  candidate: PiConversationCatalogEntry
): void {
  if (
    existing.vaultId !== candidate.vaultId
    || existing.conversationId !== candidate.conversationId
    || existing.piSessionId !== candidate.piSessionId
  ) {
    throw mappingConflict(
      `Conversation ${existing.conversationId} 的 Vault / Pi Session 绑定不可改写`
    );
  }
  if (
    existing.sessionFile !== undefined
    && existing.sessionFile !== candidate.sessionFile
  ) {
    throw mappingConflict(
      `Conversation ${existing.conversationId} 的 Pi Session 文件不可改绑`
    );
  }
  if (
    existing.defaultSkillId !== candidate.defaultSkillId
    || existing.journalDirectory !== candidate.journalDirectory
  ) {
    throw mappingConflict(
      `Conversation ${existing.conversationId} 的默认 Skill / 日记目录不可改写`
    );
  }
}

function requireCatalogStatus(value: unknown): PiConversationCatalogStatus {
  if (
    typeof value !== "string"
    || !CATALOG_STATUSES.has(value as PiConversationCatalogStatus)
  ) {
    throw new PiNativeFileStoreError(
      "invalid-input",
      `不支持的 Conversation status ${String(value)}`
    );
  }
  return value as PiConversationCatalogStatus;
}

function requireMemoryMode(value: unknown): PiConversationMemoryMode {
  if (
    typeof value !== "string"
    || !MEMORY_MODES.has(value as PiConversationMemoryMode)
  ) {
    throw new PiNativeFileStoreError(
      "invalid-input",
      `不支持的 memoryMode ${String(value)}`
    );
  }
  return value as PiConversationMemoryMode;
}

function requireSkillId(value: unknown, label: string): string {
  const id = requireNonEmptyString(value, label);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(id)) {
    throw new PiNativeFileStoreError(
      "invalid-input",
      `${label} 不是合法的 Skill ID`
    );
  }
  return id;
}

function requireJournalDirectory(value: unknown, label: string): string {
  const raw = requireNonEmptyString(value, label);
  const normalized = normalizedJournalDirectoryOrNull(raw);
  if (!normalized || normalized !== raw) {
    throw new PiNativeFileStoreError(
      "invalid-input",
      `${label} 不是规范化的 Vault 相对目录`
    );
  }
  return normalized;
}

function assertUniqueRecordIds<T extends object>(
  records: readonly T[],
  key: keyof T,
  label: string
): void {
  const seen = new Set<unknown>();
  for (const record of records) {
    const id = record[key];
    if (seen.has(id)) {
      throw new PiNativeFileStoreError(
        "mapping-conflict",
        `${label} identity 重复：${String(id)}`
      );
    }
    seen.add(id);
  }
}

function sortedDrafts(
  drafts: readonly PiConversationDraftRecord[],
  conversationId: string
): PiConversationDraftRecord[] {
  return drafts
    .filter((draft) => draft.conversationId === conversationId)
    .sort((left, right) =>
      left.createdAt - right.createdAt
      || left.draftId.localeCompare(right.draftId)
    )
    .map(cloneDraftRecord);
}

function sortedDiagnostics(
  diagnostics: readonly PiConversationDiagnostic[],
  conversationId: string
): PiConversationDiagnostic[] {
  return diagnostics
    .filter((diagnostic) => diagnostic.conversationId === conversationId)
    .sort((left, right) =>
      left.createdAt - right.createdAt
      || left.diagnosticId.localeCompare(right.diagnosticId)
    )
    .map(cloneDiagnostic);
}

function cloneCatalogDocument(
  document: ConversationCatalogDocumentV1
): ConversationCatalogDocumentV1 {
  return {
    schemaVersion: PI_NATIVE_FILE_SCHEMA_VERSION,
    vaultId: document.vaultId,
    entries: document.entries.map(cloneCatalogEntry),
    drafts: document.drafts.map(cloneDraftRecord),
    diagnostics: document.diagnostics.map(cloneDiagnostic)
  };
}

function cloneCatalogEntry(
  entry: PiConversationCatalogEntry
): PiConversationCatalogEntry {
  return {
    ...normalizeConversationTaskMetadata(entry),
    conversationId: entry.conversationId,
    piSessionId: entry.piSessionId,
    vaultId: entry.vaultId,
    title: entry.title,
    status: entry.status,
    defaultMemoryMode: entry.defaultMemoryMode,
    ...(entry.defaultSkillId ? { defaultSkillId: entry.defaultSkillId } : {}),
    ...(entry.journalDirectory ? { journalDirectory: entry.journalDirectory } : {}),
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    ...(entry.sessionFile ? { sessionFile: entry.sessionFile } : {})
  };
}

function cloneDraftRecord(
  draft: PiConversationDraftRecord
): PiConversationDraftRecord {
  return { ...draft };
}

function cloneDiagnostic(
  diagnostic: PiConversationDiagnostic
): PiConversationDiagnostic {
  return { ...diagnostic };
}

function sameBindingClaim(
  left: ConversationSessionBindingV1,
  right: ConversationSessionBindingV1
): boolean {
  return left.schemaVersion === right.schemaVersion
    && left.vaultId === right.vaultId
    && left.conversationId === right.conversationId
    && left.piSessionId === right.piSessionId;
}

function sameDiagnostic(
  left: PiConversationDiagnostic,
  right: PiConversationDiagnostic
): boolean {
  return left.diagnosticId === right.diagnosticId
    && left.conversationId === right.conversationId
    && left.piSessionId === right.piSessionId
    && left.code === right.code
    && left.message === right.message
    && left.sourcePath === right.sourcePath
    && left.recoveryPath === right.recoveryPath
    && left.createdAt === right.createdAt;
}

function mappingConflict(message: string): PiNativeFileStoreError {
  return new PiNativeFileStoreError("mapping-conflict", message);
}

function notFound(conversationId: string): PiNativeFileStoreError {
  return new PiNativeFileStoreError(
    "not-found",
    `Conversation ${conversationId} 不存在`
  );
}
