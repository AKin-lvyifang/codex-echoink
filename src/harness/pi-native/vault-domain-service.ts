import { rawDigestFingerprint } from "../../knowledge-base/raw-digest";
import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  VaultTargetResolver,
  normalizeVaultRelativePath,
  type ResolvedVaultTarget,
  type VaultTargetAdapter
} from "./vault-target-resolver";

export const VAULT_SEARCH_RESULT_LIMIT = 20;
export const VAULT_READ_RESULT_LIMIT_BYTES = 32_000;
export const VAULT_WRITE_RESULT_LIMIT_BYTES = 8_000;

const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const SHA256 = /^[a-f0-9]{64}$/u;

export type VaultWriteOperation =
  | "note_create"
  | "note_update"
  | "metadata_update"
  | "note_move"
  | "note_delete";

export type VaultOperationStatus =
  | "completed"
  | "failed"
  | "cancelled"
  | "uncertain";

export type VaultDomainAdapterErrorCode =
  | "not_found"
  | "already_exists"
  | "version_conflict"
  | "not_file"
  | "unsafe_target"
  | "cancelled"
  | "io_error";

export class VaultDomainAdapterError extends Error {
  constructor(
    readonly code: VaultDomainAdapterErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "VaultDomainAdapterError";
  }
}

export type VaultDomainErrorCode =
  | "invalid_input"
  | "operation_cancelled"
  | "operation_identity_conflict"
  | "adapter_contract_invalid"
  | "metadata_invalid";

export class VaultDomainError extends Error {
  constructor(
    readonly code: VaultDomainErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "VaultDomainError";
  }
}

export interface VaultFileSnapshot {
  relativePath: string;
  version: string;
  byteLength: number;
  content: string;
  contentSha256: string;
  /** Full Raw body revision, independent of the public excerpt size. */
  bodyFingerprint?: string;
  truncated: boolean;
}

export interface VaultAdapterSearchResult {
  relativePath: string;
  excerpt: string;
  version: string;
}

export interface VaultSearchAdapterInput {
  query: string;
  scope: Readonly<ResolvedVaultTarget>;
  maxResults: number;
  maxExcerptBytes: number;
}

export interface VaultTrashEvidence {
  kind: "obsidian_recoverable";
  operationIdentity: string;
  originalRelativePath: string;
  trashRelativePath?: string;
}

/**
 * All mutation methods are single attempts. Implementations must re-check the
 * canonical target carried by `ResolvedVaultTarget`, perform CAS/no-overwrite
 * atomically within their adapter, and never follow an unverified link.
 */
export interface VaultDomainAdapter extends VaultTargetAdapter {
  search(
    input: Readonly<VaultSearchAdapterInput>
  ): Promise<readonly Readonly<VaultAdapterSearchResult>[]>;
  readFile(
    target: Readonly<ResolvedVaultTarget>,
    options: Readonly<{ maxBytes?: number }>
  ): Promise<Readonly<VaultFileSnapshot> | null>;
  createFile(
    target: Readonly<ResolvedVaultTarget>,
    content: string
  ): Promise<void>;
  updateFile(
    target: Readonly<ResolvedVaultTarget>,
    expectedVersion: string,
    content: string
  ): Promise<void>;
  moveFile(
    source: Readonly<ResolvedVaultTarget>,
    target: Readonly<ResolvedVaultTarget>,
    expectedSourceVersion: string
  ): Promise<void>;
  trashFileRecoverably(
    source: Readonly<ResolvedVaultTarget>,
    expectedVersion: string,
    operationIdentity: string
  ): Promise<Readonly<VaultTrashEvidence>>;
}

export interface VaultSearchResultItem {
  relativePath: string;
  excerpt: string;
  version: string;
  truncated: boolean;
}

export interface VaultSearchResult {
  query: string;
  scopePath: string;
  items: readonly Readonly<VaultSearchResultItem>[];
  truncated: boolean;
}

export interface VaultNoteReadResult {
  snapshot: Readonly<VaultFileSnapshot>;
}

export interface VaultReadbackState {
  status: "present" | "missing" | "unavailable";
  snapshot?: Readonly<VaultFileSnapshot>;
  error?: Readonly<VaultOperationError>;
}

export interface VaultOperationReadback {
  source: Readonly<VaultReadbackState>;
  target?: Readonly<VaultReadbackState>;
  trash?: Readonly<VaultTrashEvidence>;
}

export interface VaultOperationError {
  code: string;
  message: string;
}

export interface VaultOperationResult {
  operationIdentity: string;
  operation: VaultWriteOperation;
  status: VaultOperationStatus;
  sourcePath: string;
  targetPath?: string;
  sideEffectStarted: boolean;
  readbackVerified: boolean;
  readback: Readonly<VaultOperationReadback>;
  error?: Readonly<VaultOperationError>;
}

export interface VaultSearchInput {
  vaultId: string;
  query: string;
  scopePath?: string;
  signal?: AbortSignal;
}

export interface VaultNoteReadInput {
  vaultId: string;
  relativePath: string;
  signal?: AbortSignal;
}

interface VaultWriteInputBase {
  vaultId: string;
  operationIdentity: string;
  signal?: AbortSignal;
  /** Durable journal barrier invoked immediately before the adapter mutation. */
  beforeSideEffect?: () => Promise<void> | void;
}

export interface VaultNoteCreateInput extends VaultWriteInputBase {
  relativePath: string;
  content: string;
}

export interface VaultNoteUpdateInput extends VaultWriteInputBase {
  relativePath: string;
  expectedVersion: string;
  content: string;
}

export type VaultMetadataValue =
  | null
  | string
  | number
  | boolean
  | readonly VaultMetadataValue[]
  | { readonly [key: string]: VaultMetadataValue };

export interface VaultMetadataPatch {
  set?: Readonly<Record<string, VaultMetadataValue>>;
  remove?: readonly string[];
}

export interface VaultMetadataUpdateInput extends VaultWriteInputBase {
  relativePath: string;
  expectedVersion: string;
  patch: Readonly<VaultMetadataPatch>;
}

export interface VaultNoteMoveInput extends VaultWriteInputBase {
  sourcePath: string;
  targetPath: string;
  expectedVersion: string;
}

export interface VaultNoteDeleteInput extends VaultWriteInputBase {
  relativePath: string;
  expectedVersion: string;
}

export interface VaultReadbackInput {
  vaultId: string;
  relativePath: string;
}

interface CachedOperation {
  fingerprint: string;
  result: Promise<Readonly<VaultOperationResult>>;
}

interface MutationReadbackClassification {
  status: VaultOperationStatus;
  readbackVerified: boolean;
  error?: Readonly<VaultOperationError>;
}

export class VaultDomainService {
  private readonly resolver: VaultTargetResolver;
  private readonly operations = new Map<string, CachedOperation>();

  constructor(
    private readonly adapter: VaultDomainAdapter,
    private readonly options: Readonly<{
      allowMissingParentDirectories?: boolean;
    }> = {}
  ) {
    this.resolver = new VaultTargetResolver(adapter);
  }

  async vaultSearch(
    input: Readonly<VaultSearchInput>
  ): Promise<Readonly<VaultSearchResult>> {
    throwIfAborted(input.signal);
    const query = requireNonEmptyString(input.query, "query");
    const scope = await this.resolver.resolve({
      vaultId: input.vaultId,
      relativePath: input.scopePath ?? "",
      allowRoot: true,
      mustExist: true,
      expectedKind: "directory"
    });
    throwIfAborted(input.signal);
    const rawValue: unknown = await this.adapter.search({
      query,
      scope,
      // One look-ahead item proves whether the public 20-item result truncated.
      maxResults: VAULT_SEARCH_RESULT_LIMIT + 1,
      maxExcerptBytes: VAULT_READ_RESULT_LIMIT_BYTES
    });
    if (!isUnknownArray(rawValue)) {
      throw domainError(
        "adapter_contract_invalid",
        "Vault search adapter did not return an array"
      );
    }
    const raw = rawValue.map(normalizeSearchCandidate);
    const items: VaultSearchResultItem[] = [];
    let remainingBytes = VAULT_READ_RESULT_LIMIT_BYTES;
    let truncated = raw.length > VAULT_SEARCH_RESULT_LIMIT;
    for (const candidate of raw) {
      if (items.length >= VAULT_SEARCH_RESULT_LIMIT) break;
      throwIfAborted(input.signal);
      const target = await this.resolver.resolve({
        vaultId: input.vaultId,
        relativePath: candidate.relativePath,
        mustExist: true,
        expectedKind: "file"
      });
      const pathBytes = Buffer.byteLength(target.relativePath, "utf8");
      if (pathBytes >= remainingBytes) {
        truncated = true;
        break;
      }
      const limited = limitUtf8(
        requireString(candidate.excerpt, "search excerpt"),
        remainingBytes - pathBytes
      );
      items.push({
        relativePath: target.relativePath,
        excerpt: limited.text,
        version: requireNonEmptyString(candidate.version, "search version"),
        truncated: limited.truncated
      });
      remainingBytes -= pathBytes + Buffer.byteLength(limited.text, "utf8");
      truncated ||= limited.truncated;
    }
    return Object.freeze({
      query,
      scopePath: scope.relativePath,
      items: Object.freeze(items.map((item) => Object.freeze(item))),
      truncated
    });
  }

  async noteRead(
    input: Readonly<VaultNoteReadInput>
  ): Promise<Readonly<VaultNoteReadResult>> {
    throwIfAborted(input.signal);
    const target = await this.resolver.resolve({
      vaultId: input.vaultId,
      relativePath: input.relativePath,
      mustExist: true,
      expectedKind: "file"
    });
    throwIfAborted(input.signal);
    const snapshot = await this.adapter.readFile(target, {
      maxBytes: target.relativePath.startsWith("raw/") ? Number.MAX_SAFE_INTEGER : VAULT_READ_RESULT_LIMIT_BYTES
    });
    if (!snapshot) {
      throw domainError(
        "adapter_contract_invalid",
        "Vault file disappeared during an authorized read"
      );
    }
    return Object.freeze({
      snapshot: Object.freeze({ ...normalizeSnapshot(snapshot, target, VAULT_READ_RESULT_LIMIT_BYTES),
        ...(!snapshot.truncated && target.relativePath.startsWith("raw/") ? { bodyFingerprint: rawDigestFingerprint(target.relativePath, Buffer.from(snapshot.content, "utf8")) } : {})
      })
    });
  }

  async readback(
    input: Readonly<VaultReadbackInput>
  ): Promise<Readonly<VaultReadbackState>> {
    return await this.readbackPath(input.vaultId, input.relativePath);
  }

  async noteCreate(
    input: Readonly<VaultNoteCreateInput>
  ): Promise<Readonly<VaultOperationResult>> {
    const relativePath = normalizeVaultRelativePath(input.relativePath);
    const content = requireString(input.content, "content");
    return await this.executeOnce(
      input.operationIdentity,
      { operation: "note_create", vaultId: input.vaultId, relativePath, content },
      async () => await this.createOnce({ ...input, relativePath, content })
    );
  }

  async noteUpdate(
    input: Readonly<VaultNoteUpdateInput>
  ): Promise<Readonly<VaultOperationResult>> {
    const relativePath = normalizeVaultRelativePath(input.relativePath);
    const content = requireString(input.content, "content");
    const expectedVersion = requireNonEmptyString(
      input.expectedVersion,
      "expectedVersion"
    );
    return await this.executeOnce(
      input.operationIdentity,
      {
        operation: "note_update",
        vaultId: input.vaultId,
        relativePath,
        expectedVersion,
        content
      },
      async () => await this.updateOnce({
        ...input,
        relativePath,
        expectedVersion,
        content
      })
    );
  }

  async metadataUpdate(
    input: Readonly<VaultMetadataUpdateInput>
  ): Promise<Readonly<VaultOperationResult>> {
    const relativePath = normalizeVaultRelativePath(input.relativePath);
    const expectedVersion = requireNonEmptyString(
      input.expectedVersion,
      "expectedVersion"
    );
    const patch = normalizeMetadataPatch(input.patch);
    return await this.executeOnce(
      input.operationIdentity,
      {
        operation: "metadata_update",
        vaultId: input.vaultId,
        relativePath,
        expectedVersion,
        patch
      },
      async () => await this.metadataOnce({
        ...input,
        relativePath,
        expectedVersion,
        patch
      })
    );
  }

  async noteMove(
    input: Readonly<VaultNoteMoveInput>
  ): Promise<Readonly<VaultOperationResult>> {
    const sourcePath = normalizeVaultRelativePath(input.sourcePath);
    const targetPath = normalizeVaultRelativePath(input.targetPath);
    if (sourcePath === targetPath) {
      throw domainError("invalid_input", "Move source and target must differ");
    }
    const expectedVersion = requireNonEmptyString(
      input.expectedVersion,
      "expectedVersion"
    );
    return await this.executeOnce(
      input.operationIdentity,
      {
        operation: "note_move",
        vaultId: input.vaultId,
        sourcePath,
        targetPath,
        expectedVersion
      },
      async () => await this.moveOnce({
        ...input,
        sourcePath,
        targetPath,
        expectedVersion
      })
    );
  }

  async noteDelete(
    input: Readonly<VaultNoteDeleteInput>
  ): Promise<Readonly<VaultOperationResult>> {
    const relativePath = normalizeVaultRelativePath(input.relativePath);
    const expectedVersion = requireNonEmptyString(
      input.expectedVersion,
      "expectedVersion"
    );
    return await this.executeOnce(
      input.operationIdentity,
      {
        operation: "note_delete",
        vaultId: input.vaultId,
        relativePath,
        expectedVersion
      },
      async () => await this.deleteOnce({
        ...input,
        relativePath,
        expectedVersion
      })
    );
  }

  private async createOnce(
    input: Readonly<VaultNoteCreateInput>
  ): Promise<Readonly<VaultOperationResult>> {
    const operation = "note_create" as const;
    if (input.signal?.aborted) {
      return cancelledBeforeStart(
        input.operationIdentity,
        operation,
        input.relativePath
      );
    }
    const target = await this.resolver.resolve({
      vaultId: input.vaultId,
      relativePath: input.relativePath,
      allowMissingParentDirectories: true,
      mustExist: false,
      expectedKind: "file"
    });
    if (target.exists) {
      return failedBeforeStart(
        input.operationIdentity,
        operation,
        target.relativePath,
        "target_exists",
        "Create target already exists",
        await this.readbackPath(input.vaultId, target.relativePath)
      );
    }
    if (input.signal?.aborted) {
      return cancelledBeforeStart(
        input.operationIdentity,
        operation,
        target.relativePath
      );
    }
    let mutationError: unknown;
    await input.beforeSideEffect?.();
    try {
      await this.adapter.createFile(target, input.content);
    } catch (error) {
      mutationError = error;
    }
    const source = await this.readbackPath(input.vaultId, target.relativePath);
    const classification = classifySingleTargetMutation({
      mutationError,
      signal: input.signal,
      readback: source,
      expectedSha256: sha256(input.content),
      beforeSha256: null
    });
    return operationResult({
      operationIdentity: input.operationIdentity,
      operation,
      status: classification.status,
      sourcePath: target.relativePath,
      sideEffectStarted: true,
      readbackVerified: classification.readbackVerified,
      readback: { source },
      error: classification.error
    });
  }

  private async updateOnce(
    input: Readonly<VaultNoteUpdateInput>
  ): Promise<Readonly<VaultOperationResult>> {
    return await this.replaceContentOnce({
      operation: "note_update",
      operationIdentity: input.operationIdentity,
      vaultId: input.vaultId,
      relativePath: input.relativePath,
      expectedVersion: input.expectedVersion,
      content: input.content,
      signal: input.signal,
      beforeSideEffect: input.beforeSideEffect
    });
  }

  private async metadataOnce(
    input: Readonly<VaultMetadataUpdateInput>
  ): Promise<Readonly<VaultOperationResult>> {
    const operation = "metadata_update" as const;
    if (input.signal?.aborted) {
      return cancelledBeforeStart(
        input.operationIdentity,
        operation,
        input.relativePath
      );
    }
    const target = await this.resolver.resolve({
      vaultId: input.vaultId,
      relativePath: input.relativePath,
      mustExist: true,
      expectedKind: "file"
    });
    const original = await this.readFullSnapshot(target);
    if (original.version !== input.expectedVersion) {
      return failedBeforeStart(
        input.operationIdentity,
        operation,
        target.relativePath,
        "version_conflict",
        "Metadata update expected version no longer matches",
        limitedSnapshotState(original)
      );
    }
    const content = applyVaultFrontmatterPatch(original.content, input.patch);
    return await this.replaceContentOnce({
      operation,
      operationIdentity: input.operationIdentity,
      vaultId: input.vaultId,
      relativePath: target.relativePath,
      expectedVersion: input.expectedVersion,
      content,
      signal: input.signal,
      beforeSideEffect: input.beforeSideEffect,
      knownBefore: original
    });
  }

  private async replaceContentOnce(input: Readonly<{
    operation: "note_update" | "metadata_update";
    operationIdentity: string;
    vaultId: string;
    relativePath: string;
    expectedVersion: string;
    content: string;
    signal?: AbortSignal;
    beforeSideEffect?: () => Promise<void> | void;
    knownBefore?: Readonly<VaultFileSnapshot>;
  }>): Promise<Readonly<VaultOperationResult>> {
    if (input.signal?.aborted) {
      return cancelledBeforeStart(
        input.operationIdentity,
        input.operation,
        input.relativePath
      );
    }
    const target = await this.resolver.resolve({
      vaultId: input.vaultId,
      relativePath: input.relativePath,
      mustExist: true,
      expectedKind: "file"
    });
    const before = input.knownBefore ?? await this.readSnapshot(
      target,
      VAULT_WRITE_RESULT_LIMIT_BYTES
    );
    if (before.version !== input.expectedVersion) {
      return failedBeforeStart(
        input.operationIdentity,
        input.operation,
        target.relativePath,
        "version_conflict",
        "Update expected version no longer matches",
        limitedSnapshotState(before)
      );
    }
    if (input.signal?.aborted) {
      return cancelledBeforeStart(
        input.operationIdentity,
        input.operation,
        target.relativePath
      );
    }
    let mutationError: unknown;
    await input.beforeSideEffect?.();
    try {
      await this.adapter.updateFile(
        target,
        input.expectedVersion,
        input.content
      );
    } catch (error) {
      mutationError = error;
    }
    const source = await this.readbackPath(input.vaultId, target.relativePath);
    const classification = classifySingleTargetMutation({
      mutationError,
      signal: input.signal,
      readback: source,
      expectedSha256: sha256(input.content),
      beforeSha256: before.contentSha256
    });
    return operationResult({
      operationIdentity: input.operationIdentity,
      operation: input.operation,
      status: classification.status,
      sourcePath: target.relativePath,
      sideEffectStarted: true,
      readbackVerified: classification.readbackVerified,
      readback: { source },
      error: classification.error
    });
  }

  private async moveOnce(
    input: Readonly<VaultNoteMoveInput>
  ): Promise<Readonly<VaultOperationResult>> {
    const operation = "note_move" as const;
    if (input.signal?.aborted) {
      return cancelledBeforeStart(
        input.operationIdentity,
        operation,
        input.sourcePath,
        input.targetPath
      );
    }
    const source = await this.resolver.resolve({
      vaultId: input.vaultId,
      relativePath: input.sourcePath,
      mustExist: true,
      expectedKind: "file"
    });
    const target = await this.resolver.resolve({
      vaultId: input.vaultId,
      relativePath: input.targetPath,
      allowMissingParentDirectories:
        this.options.allowMissingParentDirectories === true,
      mustExist: false,
      expectedKind: "file"
    });
    const before = await this.readSnapshot(
      source,
      VAULT_WRITE_RESULT_LIMIT_BYTES
    );
    if (before.version !== input.expectedVersion || target.exists) {
      const code = target.exists ? "target_exists" : "version_conflict";
      return failedBeforeStart(
        input.operationIdentity,
        operation,
        source.relativePath,
        code,
        target.exists
          ? "Move target already exists"
          : "Move expected version no longer matches",
        limitedSnapshotState(before),
        target.relativePath
      );
    }
    if (input.signal?.aborted) {
      return cancelledBeforeStart(
        input.operationIdentity,
        operation,
        source.relativePath,
        target.relativePath
      );
    }
    let mutationError: unknown;
    await input.beforeSideEffect?.();
    try {
      await this.adapter.moveFile(source, target, input.expectedVersion);
    } catch (error) {
      mutationError = error;
    }
    const [sourceReadback, targetReadback] = await Promise.all([
      this.readbackPath(input.vaultId, source.relativePath),
      this.readbackPath(input.vaultId, target.relativePath)
    ]);
    const moved = sourceReadback.status === "missing"
      && targetReadback.status === "present"
      && targetReadback.snapshot?.contentSha256 === before.contentSha256;
    const unchanged = sourceReadback.status === "present"
      && sourceReadback.snapshot?.contentSha256 === before.contentSha256
      && targetReadback.status === "missing";
    const classification = classifyCompositeMutation(
      moved,
      unchanged,
      mutationError,
      input.signal
    );
    return operationResult({
      operationIdentity: input.operationIdentity,
      operation,
      status: classification.status,
      sourcePath: source.relativePath,
      targetPath: target.relativePath,
      sideEffectStarted: true,
      readbackVerified: classification.readbackVerified,
      readback: { source: sourceReadback, target: targetReadback },
      error: classification.error
    });
  }

  private async deleteOnce(
    input: Readonly<VaultNoteDeleteInput>
  ): Promise<Readonly<VaultOperationResult>> {
    const operation = "note_delete" as const;
    if (input.signal?.aborted) {
      return cancelledBeforeStart(
        input.operationIdentity,
        operation,
        input.relativePath
      );
    }
    const source = await this.resolver.resolve({
      vaultId: input.vaultId,
      relativePath: input.relativePath,
      mustExist: true,
      expectedKind: "file"
    });
    const before = await this.readSnapshot(
      source,
      VAULT_WRITE_RESULT_LIMIT_BYTES
    );
    if (before.version !== input.expectedVersion) {
      return failedBeforeStart(
        input.operationIdentity,
        operation,
        source.relativePath,
        "version_conflict",
        "Delete expected version no longer matches",
        limitedSnapshotState(before)
      );
    }
    if (input.signal?.aborted) {
      return cancelledBeforeStart(
        input.operationIdentity,
        operation,
        source.relativePath
      );
    }
    let mutationError: unknown;
    let trash: Readonly<VaultTrashEvidence> | undefined;
    await input.beforeSideEffect?.();
    try {
      const candidate = await this.adapter.trashFileRecoverably(
        source,
        input.expectedVersion,
        input.operationIdentity
      );
      assertTrashEvidence(candidate, source, input.operationIdentity);
      trash = candidate;
    } catch (error) {
      mutationError = error;
    }
    const sourceReadback = await this.readbackPath(
      input.vaultId,
      source.relativePath
    );
    const deleted = sourceReadback.status === "missing" && trash !== undefined;
    const unchanged = sourceReadback.status === "present"
      && sourceReadback.snapshot?.contentSha256 === before.contentSha256;
    const classification = classifyCompositeMutation(
      deleted,
      unchanged,
      mutationError,
      input.signal
    );
    return operationResult({
      operationIdentity: input.operationIdentity,
      operation,
      status: classification.status,
      sourcePath: source.relativePath,
      sideEffectStarted: true,
      readbackVerified: classification.readbackVerified,
      readback: {
        source: sourceReadback,
        ...(trash ? { trash } : {})
      },
      error: classification.error
    });
  }

  private async readbackPath(
    vaultId: string,
    relativePath: string
  ): Promise<Readonly<VaultReadbackState>> {
    try {
      const target = await this.resolver.resolve({
        vaultId,
        relativePath,
        allowMissingParentDirectories:
          this.options.allowMissingParentDirectories === true,
        mustExist: false,
        expectedKind: "file"
      });
      if (!target.exists) return Object.freeze({ status: "missing" });
      const snapshot = await this.adapter.readFile(target, {
        maxBytes: VAULT_WRITE_RESULT_LIMIT_BYTES
      });
      if (!snapshot) return Object.freeze({ status: "missing" });
      return Object.freeze({
        status: "present",
        snapshot: normalizeSnapshot(
          snapshot,
          target,
          VAULT_WRITE_RESULT_LIMIT_BYTES
        )
      });
    } catch (error) {
      return Object.freeze({
        status: "unavailable",
        error: safeOperationError(error)
      });
    }
  }

  private async readSnapshot(
    target: Readonly<ResolvedVaultTarget>,
    maxBytes: number
  ): Promise<Readonly<VaultFileSnapshot>> {
    const snapshot = await this.adapter.readFile(target, { maxBytes });
    if (!snapshot) {
      throw new VaultDomainAdapterError(
        "not_found",
        `Vault target disappeared: ${target.relativePath}`
      );
    }
    return normalizeSnapshot(snapshot, target, maxBytes);
  }

  private async readFullSnapshot(
    target: Readonly<ResolvedVaultTarget>
  ): Promise<Readonly<VaultFileSnapshot>> {
    const snapshot = await this.adapter.readFile(target, {});
    if (!snapshot) {
      throw new VaultDomainAdapterError(
        "not_found",
        `Vault target disappeared: ${target.relativePath}`
      );
    }
    const normalized = normalizeSnapshot(snapshot, target);
    if (normalized.truncated) {
      throw domainError(
        "adapter_contract_invalid",
        "Vault adapter truncated an internal metadata mutation read"
      );
    }
    return normalized;
  }

  private async executeOnce(
    operationIdentityInput: string,
    fingerprintInput: unknown,
    execute: () => Promise<Readonly<VaultOperationResult>>
  ): Promise<Readonly<VaultOperationResult>> {
    const operationIdentity = requireNonEmptyString(
      operationIdentityInput,
      "operationIdentity"
    );
    const fingerprint = sha256(stableJson(fingerprintInput));
    const existing = this.operations.get(operationIdentity);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw domainError(
          "operation_identity_conflict",
          "operationIdentity cannot be reused for different Vault arguments"
        );
      }
      return await existing.result;
    }
    const result = Promise.resolve().then(execute);
    this.operations.set(operationIdentity, { fingerprint, result });
    return await result;
  }
}

function normalizeSearchCandidate(
  value: unknown
): Readonly<VaultAdapterSearchResult> {
  if (!isPlainRecord(value)) {
    throw domainError(
      "adapter_contract_invalid",
      "Vault search adapter returned an invalid item"
    );
  }
  return Object.freeze({
    relativePath: requireString(
      value.relativePath,
      "search relativePath"
    ),
    excerpt: requireString(value.excerpt, "search excerpt"),
    version: requireNonEmptyString(value.version, "search version")
  });
}

function normalizeSnapshot(
  snapshot: Readonly<VaultFileSnapshot>,
  target: Readonly<ResolvedVaultTarget>,
  maxBytes?: number
): Readonly<VaultFileSnapshot> {
  if (snapshot.relativePath !== target.relativePath) {
    throw domainError(
      "adapter_contract_invalid",
      "Vault adapter read back a different target"
    );
  }
  const version = requireNonEmptyString(snapshot.version, "snapshot.version");
  const content = requireString(snapshot.content, "snapshot.content");
  if (
    !Number.isSafeInteger(snapshot.byteLength)
    || snapshot.byteLength < Buffer.byteLength(content, "utf8")
    || !SHA256.test(snapshot.contentSha256)
  ) {
    throw domainError(
      "adapter_contract_invalid",
      "Vault adapter returned invalid snapshot evidence"
    );
  }
  const limited = maxBytes === undefined
    ? { text: content, truncated: snapshot.truncated }
    : limitUtf8(content, maxBytes);
  const truncated = snapshot.truncated || limited.truncated
    || snapshot.byteLength > Buffer.byteLength(limited.text, "utf8");
  if (!truncated && sha256(limited.text) !== snapshot.contentSha256) {
    throw domainError(
      "adapter_contract_invalid",
      "Vault adapter snapshot digest does not match its complete content"
    );
  }
  return Object.freeze({
    relativePath: target.relativePath,
    version,
    byteLength: snapshot.byteLength,
    content: limited.text,
    contentSha256: snapshot.contentSha256,
    truncated
  });
}

function classifySingleTargetMutation(input: Readonly<{
  mutationError: unknown;
  signal?: AbortSignal;
  readback: Readonly<VaultReadbackState>;
  expectedSha256: string;
  beforeSha256: string | null;
}>): MutationReadbackClassification {
  if (
    input.readback.status === "present"
    && input.readback.snapshot?.contentSha256 === input.expectedSha256
  ) {
    return { status: "completed", readbackVerified: true };
  }
  const unchanged = input.beforeSha256 === null
    ? input.readback.status === "missing"
    : input.readback.status === "present"
      && input.readback.snapshot?.contentSha256 === input.beforeSha256;
  return classifyCompositeMutation(
    false,
    unchanged,
    input.mutationError,
    input.signal
  );
}

function classifyCompositeMutation(
  completed: boolean,
  unchanged: boolean,
  mutationError: unknown,
  signal?: AbortSignal
): MutationReadbackClassification {
  if (completed) return { status: "completed", readbackVerified: true };
  const error = mutationError === undefined
    ? undefined
    : safeOperationError(mutationError);
  if (unchanged && mutationError !== undefined) {
    return {
      status: signal?.aborted || isAdapterError(mutationError, "cancelled")
        ? "cancelled"
        : "failed",
      readbackVerified: false,
      ...(error ? { error } : {})
    };
  }
  if (mutationError && isKnownNoEffectAdapterError(mutationError)) {
    return {
      status: isAdapterError(mutationError, "cancelled")
        ? "cancelled"
        : "failed",
      readbackVerified: false,
      ...(error ? { error } : {})
    };
  }
  return {
    status: "uncertain",
    readbackVerified: false,
    ...(error ? { error } : {})
  };
}

function cancelledBeforeStart(
  operationIdentity: string,
  operation: VaultWriteOperation,
  sourcePath: string,
  targetPath?: string
): Readonly<VaultOperationResult> {
  return operationResult({
    operationIdentity,
    operation,
    status: "cancelled",
    sourcePath,
    ...(targetPath ? { targetPath } : {}),
    sideEffectStarted: false,
    readbackVerified: false,
    readback: { source: { status: "unavailable" } },
    error: {
      code: "operation_cancelled",
      message: "Vault write was cancelled before it started"
    }
  });
}

function failedBeforeStart(
  operationIdentity: string,
  operation: VaultWriteOperation,
  sourcePath: string,
  code: string,
  message: string,
  source: Readonly<VaultReadbackState>,
  targetPath?: string
): Readonly<VaultOperationResult> {
  return operationResult({
    operationIdentity,
    operation,
    status: "failed",
    sourcePath,
    ...(targetPath ? { targetPath } : {}),
    sideEffectStarted: false,
    readbackVerified: false,
    readback: { source },
    error: { code, message }
  });
}

function operationResult(
  input: VaultOperationResult
): Readonly<VaultOperationResult> {
  return Object.freeze({
    ...input,
    readback: Object.freeze({ ...input.readback }),
    ...(input.error ? { error: Object.freeze({ ...input.error }) } : {})
  });
}

function limitedSnapshotState(
  snapshot: Readonly<VaultFileSnapshot>
): Readonly<VaultReadbackState> {
  const limited = limitUtf8(snapshot.content, VAULT_WRITE_RESULT_LIMIT_BYTES);
  return Object.freeze({
    status: "present",
    snapshot: Object.freeze({
      ...snapshot,
      content: limited.text,
      truncated: snapshot.truncated || limited.truncated
    })
  });
}

function assertTrashEvidence(
  evidence: Readonly<VaultTrashEvidence>,
  source: Readonly<ResolvedVaultTarget>,
  operationIdentity: string
): void {
  if (
    evidence.kind !== "obsidian_recoverable"
    || evidence.operationIdentity !== operationIdentity
    || evidence.originalRelativePath !== source.relativePath
    || (
      evidence.trashRelativePath !== undefined
      && !normalizeVaultRelativePath(evidence.trashRelativePath)
    )
  ) {
    throw domainError(
      "adapter_contract_invalid",
      "Vault adapter did not prove a recoverable Obsidian trash operation"
    );
  }
}

export function applyVaultFrontmatterPatch(
  content: string,
  patch: Readonly<VaultMetadataPatch>
): string {
  const parsed = splitFrontmatter(content);
  let metadata: unknown = {};
  if (parsed.frontmatter !== null && parsed.frontmatter.trim()) {
    try {
      metadata = parseYaml(parsed.frontmatter);
    } catch (error) {
      throw domainError(
        "metadata_invalid",
        "Existing note frontmatter is not valid YAML",
        error
      );
    }
  }
  if (!isPlainRecord(metadata)) {
    throw domainError(
      "metadata_invalid",
      "Existing note frontmatter must be a mapping"
    );
  }
  const entries = new Map<string, VaultMetadataValue>();
  for (const [key, value] of Object.entries(metadata)) {
    assertMetadataValue(value, `frontmatter.${key}`);
    entries.set(key, value);
  }
  for (const key of patch.remove ?? []) entries.delete(key);
  for (const [key, value] of Object.entries(patch.set ?? {})) {
    entries.set(key, value);
  }
  const output = Object.fromEntries(entries);
  const serialized = stringifyYaml(output, { lineWidth: 0 });
  const next = `---${parsed.lineEnding}${serialized}`
    + `---${parsed.lineEnding}${parsed.body}`;
  if (splitFrontmatter(next).body !== parsed.body) {
    throw domainError(
      "metadata_invalid",
      "Metadata update changed the Markdown body"
    );
  }
  return next;
}

function splitFrontmatter(content: string): Readonly<{
  frontmatter: string | null;
  body: string;
  lineEnding: "\n" | "\r\n";
}> {
  const lineEnding = content.includes("\r\n") ? "\r\n" : "\n";
  const firstEnd = content.indexOf("\n");
  const firstLine = (firstEnd < 0 ? content : content.slice(0, firstEnd))
    .replace(/\r$/u, "");
  if (firstLine !== "---") {
    return { frontmatter: null, body: content, lineEnding };
  }
  let cursor = firstEnd + 1;
  while (cursor > 0 && cursor <= content.length) {
    const nextEnd = content.indexOf("\n", cursor);
    const lineEnd = nextEnd < 0 ? content.length : nextEnd;
    const line = content.slice(cursor, lineEnd).replace(/\r$/u, "");
    if (line === "---" || line === "...") {
      const bodyStart = nextEnd < 0 ? content.length : nextEnd + 1;
      return {
        frontmatter: content.slice(firstEnd + 1, cursor),
        body: content.slice(bodyStart),
        lineEnding
      };
    }
    if (nextEnd < 0) break;
    cursor = nextEnd + 1;
  }
  throw domainError(
    "metadata_invalid",
    "Existing note frontmatter is not closed"
  );
}

function normalizeMetadataPatch(
  patch: Readonly<VaultMetadataPatch>
): Readonly<VaultMetadataPatch> {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw domainError("invalid_input", "metadata patch must be an object");
  }
  const set = Object.fromEntries(
    Object.entries(patch.set ?? {}).map(([key, value]) => {
      const normalizedKey = requireMetadataKey(key);
      assertMetadataValue(value, `patch.set.${normalizedKey}`);
      return [normalizedKey, value] as const;
    })
  );
  const remove = [...new Set((patch.remove ?? []).map(requireMetadataKey))]
    .sort();
  for (const key of remove) {
    if (Object.prototype.hasOwnProperty.call(set, key)) {
      throw domainError(
        "invalid_input",
        `metadata key cannot be set and removed together: ${key}`
      );
    }
  }
  if (!Object.keys(set).length && !remove.length) {
    throw domainError("invalid_input", "metadata patch cannot be empty");
  }
  return Object.freeze({
    ...(Object.keys(set).length ? { set: Object.freeze(set) } : {}),
    ...(remove.length ? { remove: Object.freeze(remove) } : {})
  });
}

function assertMetadataValue(
  value: unknown,
  label: string,
  seen = new Set<object>(),
  depth = 0
): asserts value is VaultMetadataValue {
  if (depth > 20) {
    throw domainError("invalid_input", `${label} is nested too deeply`);
  }
  if (
    value === null
    || typeof value === "string"
    || typeof value === "boolean"
    || (typeof value === "number" && Number.isFinite(value))
  ) {
    return;
  }
  if (!value || typeof value !== "object" || seen.has(value)) {
    throw domainError("invalid_input", `${label} is not metadata-safe`);
  }
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      assertMetadataValue(item, `${label}[${index}]`, seen, depth + 1)
    );
  } else if (isPlainRecord(value)) {
    for (const [key, item] of Object.entries(value)) {
      requireMetadataKey(key);
      assertMetadataValue(item, `${label}.${key}`, seen, depth + 1);
    }
  } else {
    throw domainError("invalid_input", `${label} is not a plain object`);
  }
  seen.delete(value);
}

function requireMetadataKey(value: unknown): string {
  const key = requireNonEmptyString(value, "metadata key");
  if (key.includes("\0") || key.length > 256) {
    throw domainError("invalid_input", "metadata key is invalid");
  }
  return key;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw domainError(
    "operation_cancelled",
    "Vault read was cancelled before access"
  );
}

function limitUtf8(
  text: string,
  maxBytes: number
): Readonly<{ text: string; truncated: boolean }> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw domainError("invalid_input", "byte limit is invalid");
  }
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) return { text, truncated: false };
  let end = maxBytes;
  while (end > 0) {
    try {
      return {
        text: UTF8_DECODER.decode(bytes.subarray(0, end)),
        truncated: true
      };
    } catch {
      end -= 1;
    }
  }
  return { text: "", truncated: true };
}

function isKnownNoEffectAdapterError(error: unknown): boolean {
  return error instanceof VaultDomainAdapterError
    && [
      "not_found",
      "already_exists",
      "version_conflict",
      "not_file",
      "unsafe_target",
      "cancelled"
    ].includes(error.code);
}

function isAdapterError(
  error: unknown,
  code: VaultDomainAdapterErrorCode
): boolean {
  return error instanceof VaultDomainAdapterError && error.code === code;
}

function safeOperationError(error: unknown): Readonly<VaultOperationError> {
  const code = error instanceof VaultDomainAdapterError
    ? error.code
    : error instanceof VaultDomainError
      ? error.code
      : "vault_operation_failed";
  let message = "Vault operation failed";
  try {
    if (error instanceof Error && error.message) message = error.message;
    else if (typeof error === "string" && error) message = error;
  } catch {
    // Keep the fixed safe fallback.
  }
  return Object.freeze({ code, message: message.slice(0, 500) });
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (isPlainRecord(value)) {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, sortJson(value[key])])
    );
  }
  return value;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw domainError("invalid_input", `${label} is required`);
  }
  return value;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw domainError("invalid_input", `${label} must be a string`);
  }
  return value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Reflect.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

function domainError(
  code: VaultDomainErrorCode,
  message: string,
  cause?: unknown
): VaultDomainError {
  return new VaultDomainError(
    code,
    message,
    cause === undefined ? undefined : { cause }
  );
}
