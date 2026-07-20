import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  canonicalConversationV2Json,
  validateConversationCommitV2,
  validateConversationMetadataV2,
  validateConversationPayloadV2,
  type ConversationCommitV2,
  type ConversationMetadataV2,
  type ConversationPayloadV2
} from "../contracts/conversation-v2";
import {
  projectConversationShellV2,
  validateConversationShellV2,
  type ConversationShellV2
} from "./conversation-shell";
import {
  parseConversationDeletionTombstone,
  type ConversationDeletionTombstoneV1
} from "./conversation-store";

const STORE_DIRECTORY = "conversations-v2";
const CONVERSATIONS_DIRECTORY = "conversations";
const PAYLOADS_DIRECTORY = "payloads";
const DELETIONS_DIRECTORY = "deletions";
const MIGRATION_CONFLICTS_DIRECTORY = "migration-conflicts";
const STAGING_DIRECTORY = ".staging";
const METADATA_DIRECTORY = "metadata";
const RETIREMENTS_DIRECTORY = "retirements";
const HEAD_FILE = "head.json";
const INDEX_FILE = "index.json";
const ENTRY_PREFIX = "entry-";
const ENTRY_WIDTH = 16;
const ENTRY_PATTERN = /^entry-([0-9]{16})\.json$/;
const CONVERSATION_TOKEN_PATTERN = /^conversation-[a-f0-9]{64}$/;
const DELETION_FILE_PATTERN = /^conversation-[a-f0-9]{64}\.json$/;
const PAYLOAD_FILE_PATTERN = /^[a-f0-9]{64}\.json$/;
const RETIREMENT_FILE_PATTERN = /^retirement-([0-9]{16})\.json$/;
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const MAX_RECORD_BYTES = 64 * 1024 * 1024;
const INDEX_SCHEMA_VERSION = 2 as const;
const conversationMutationTails = new Map<string, Promise<void>>();

export type ConversationStoreV2FaultPoint =
  | "before-payload"
  | "after-payload"
  | "before-metadata-marker"
  | "after-metadata-publish"
  | "after-metadata-marker"
  | "before-index"
  | "after-index";

export type ConversationStoreV2ErrorCode =
  | "unsafe-path"
  | "unsafe-entry"
  | "store-corrupt"
  | "future-schema"
  | "revision-conflict";

export class ConversationStoreV2Error extends Error {
  constructor(
    public readonly code: ConversationStoreV2ErrorCode,
    message: string
  ) {
    super(message);
    this.name = "ConversationStoreV2Error";
  }
}

export class ConversationStoreV2ConflictError extends ConversationStoreV2Error {
  constructor(message: string) {
    super("revision-conflict", message);
    this.name = "ConversationStoreV2ConflictError";
  }
}

/** Test-only abrupt-stop sentinel used by the crash-window fixtures. */
export class ConversationStoreV2SimulatedCrash extends Error {
  constructor(message = "simulated Conversation Store V2 crash") {
    super(message);
    this.name = "ConversationStoreV2SimulatedCrash";
  }
}

export interface ConversationStoreV2FaultContext {
  conversationId: string;
  revision: number;
  commitId: string;
  payloadDigest: string;
}

export interface FileConversationStoreV2Options {
  storageRootPath?: string;
  rootPath?: string;
  now?: () => number;
  faultInjector?: (
    point: ConversationStoreV2FaultPoint,
    context: ConversationStoreV2FaultContext
  ) => void | Promise<void>;
}

export interface ConversationStoreV2CommitOptions {
  expectedRevision: number | null;
  expectedCommitId: string | null;
  recordMutationPayloadReplacement?: {
    mutationId: string;
    sourceRelativePaths: readonly string[];
  };
  faultInjector?: (
    point: ConversationStoreV2FaultPoint,
    context: ConversationStoreV2FaultContext
  ) => void | Promise<void>;
}

export interface ConversationStoreV2MigrationSnapshot {
  commits: ConversationCommitV2[];
  deletionTombstones: ConversationDeletionTombstoneV1[];
}

export interface ConversationStoreV2DeletionOptions {
  recordMutationRetirement?: {
    mutationId: string;
    sourceRelativePaths: readonly string[];
  };
}

interface ConversationIndexEntryV2 {
  metadataRevision: number;
  metadataCommitId: string;
  shell: ConversationShellV2;
}

interface ConversationIndexV2 {
  schemaVersion: typeof INDEX_SCHEMA_VERSION;
  recordType: "conversation-index";
  generatedAt: number;
  entries: ConversationIndexEntryV2[];
}

interface StoreLayout {
  rootPath: string;
  conversationsRootPath: string;
  payloadsRootPath: string;
  deletionsRootPath: string;
  migrationConflictsRootPath: string;
  stagingRootPath: string;
  indexPath: string;
}

interface ConversationLayout {
  token: string;
  rootPath: string;
  metadataRootPath: string;
  retirementsRootPath: string;
  headPath: string;
}

interface ConversationPayloadRetirementMarkerV1 {
  schemaVersion: 1;
  recordType: "conversation-payload-retirement";
  conversationId: string;
  mutationId: string;
  retainedRevision: number;
  retainedMetadataCommitId: string;
  retainedMetadataDigest: string;
  retiredThroughRevision: number;
  retiredHeadCommitId: string;
  retiredHeadDigest: string;
  sourceRelativePaths: string[];
  previousMarkerDigest: string | null;
  digest: string;
}

interface ConversationHeadV1 {
  schemaVersion: 1;
  recordType: "conversation-head";
  conversationToken: string;
  metadataRevision: number;
  metadataCommitId: string;
  metadataDigest: string;
}

export function conversationStoreV2Root(storageRootPath: string): string {
  return path.join(path.resolve(storageRootPath), STORE_DIRECTORY);
}

export class FileConversationStoreV2 {
  readonly rootPath: string;
  readonly storageRootPath: string;
  private readonly now: () => number;
  private readonly defaultFaultInjector:
    | FileConversationStoreV2Options["faultInjector"]
    | undefined;

  constructor(options: FileConversationStoreV2Options) {
    if (!options.rootPath && !options.storageRootPath) {
      throw new ConversationStoreV2Error(
        "unsafe-path",
        "Conversation Store V2 requires rootPath or storageRootPath"
      );
    }
    this.rootPath = options.rootPath
      ? path.resolve(options.rootPath)
      : conversationStoreV2Root(options.storageRootPath as string);
    this.storageRootPath = options.storageRootPath
      ? path.resolve(options.storageRootPath)
      : path.dirname(this.rootPath);
    this.now = options.now ?? Date.now;
    this.defaultFaultInjector = options.faultInjector;
  }

  async commitConversation(
    candidateInput: ConversationCommitV2,
    options: ConversationStoreV2CommitOptions
  ): Promise<ConversationCommitV2> {
    const candidate = validateConversationCommitV2(candidateInput);
    return await enqueueConversationStoreV2Mutation(
      this.rootPath,
      candidate.metadata.conversationId,
      async () => await this.commitConversationUnlocked(candidate, options)
    );
  }

  private async commitConversationUnlocked(
    candidate: ConversationCommitV2,
    options: ConversationStoreV2CommitOptions
  ): Promise<ConversationCommitV2> {
    const layout = await ensureStoreLayout(this.rootPath);
    await assertStoreNamespacesSafe(layout);
    if (
      await readDeletionTombstoneFromLayout(
        layout,
        candidate.metadata.conversationId
      )
    ) {
      throw new ConversationStoreV2ConflictError(
        "Conversation Store V2 cannot commit a Conversation with a durable deletion tombstone"
      );
    }
    const conversation = await ensureConversationLayout(
      layout,
      candidate.metadata.conversationId
    );
    const currentMetadata = await readCurrentMetadata(conversation);
    assertConversationExpectation(currentMetadata, options);
    assertCandidateFollows(currentMetadata, candidate.metadata);
    if (currentMetadata) {
      const currentPayload = await readPayload(layout, currentMetadata.payloadDigest);
      if (options.recordMutationPayloadReplacement) {
        await assertAndPublishPayloadRetirementMarker({
          layout,
          conversation,
          currentMetadata,
          candidate,
          mutationId:
            options.recordMutationPayloadReplacement.mutationId,
          sourceRelativePaths:
            options.recordMutationPayloadReplacement.sourceRelativePaths
        });
      } else {
        assertConversationPayloadTransition(currentPayload, candidate.payload);
      }
    } else if (options.recordMutationPayloadReplacement) {
      throw new ConversationStoreV2ConflictError(
        "Conversation Store V2 payload retirement requires an active Conversation"
      );
    }

    const faultContext: ConversationStoreV2FaultContext = {
      conversationId: candidate.metadata.conversationId,
      revision: candidate.metadata.revision,
      commitId: candidate.metadata.commitId,
      payloadDigest: candidate.metadata.payloadDigest
    };
    const inject = async (point: ConversationStoreV2FaultPoint): Promise<void> => {
      await (options.faultInjector ?? this.defaultFaultInjector)?.(
        point,
        faultContext
      );
    };

    await inject("before-payload");
    await publishImmutablePayload(layout, candidate.payload);
    await inject("after-payload");

    await inject("before-metadata-marker");
    await publishMetadataMarker(
      layout,
      conversation,
      candidate.metadata,
      () => inject("after-metadata-publish")
    );
    const readback = await this.readConversation(candidate.metadata.conversationId);
    if (!readback || !isDeepStrictEqual(readback, candidate)) {
      throw new ConversationStoreV2Error(
        "store-corrupt",
        "Conversation Store V2 metadata marker readback 不一致"
      );
    }
    await inject("after-metadata-marker");

    await this.reconcileIndexInternal(layout, inject);
    return readback;
  }

  async writeConversation(
    candidate: ConversationCommitV2,
    options: ConversationStoreV2CommitOptions
  ): Promise<ConversationCommitV2> {
    return await this.commitConversation(candidate, options);
  }

  async readConversation(
    conversationId: string
  ): Promise<ConversationCommitV2 | null> {
    const layout = storeLayout(this.rootPath);
    const rootStat = await lstatOrNull(layout.rootPath);
    if (!rootStat) return null;
    assertPlainDirectory(rootStat, "Conversation Store V2 root");
    await assertStoreNamespacesSafe(layout);
    const conversation = conversationLayout(layout, conversationId);
    const conversationStat = await lstatOrNull(conversation.rootPath);
    if (!conversationStat) return null;
    assertPlainDirectory(conversationStat, "Conversation V2 directory");
    await assertConversationDirectorySafe(conversation);
    const metadata = await readCurrentMetadata(conversation);
    if (!metadata) return null;
    const payload = await readPayload(layout, metadata.payloadDigest);
    const commit = { metadata, payload };
    validateConversationCommitV2(commit);
    return commit;
  }

  async loadConversation(
    conversationId: string
  ): Promise<ConversationCommitV2 | null> {
    return await this.readConversation(conversationId);
  }

  async readConversationHistory(
    conversationId: string
  ): Promise<ConversationCommitV2[]> {
    const layout = storeLayout(this.rootPath);
    const rootStat = await lstatOrNull(layout.rootPath);
    if (!rootStat) return [];
    assertPlainDirectory(rootStat, "Conversation Store V2 root");
    await assertStoreNamespacesSafe(layout);
    const conversation = conversationLayout(layout, conversationId);
    const conversationStat = await lstatOrNull(conversation.rootPath);
    if (!conversationStat) return [];
    assertPlainDirectory(conversationStat, "Conversation V2 directory");
    await assertConversationDirectorySafe(conversation);
    const metadataChain = await readMetadataChain(conversation);
    const commits: ConversationCommitV2[] = [];
    for (const metadata of metadataChain) {
      const payload = await readPayload(layout, metadata.payloadDigest);
      const commit = { metadata, payload };
      validateConversationCommitV2(commit);
      commits.push(commit);
    }
    return commits;
  }

  async planRecordMutationSources(input: {
    operation: "clear-conversation-records" | "delete-conversation";
    conversationId: string;
  }): Promise<string[]> {
    const layout = storeLayout(this.rootPath);
    const rootStat = await lstatOrNull(layout.rootPath);
    if (!rootStat) {
      throw new ConversationStoreV2ConflictError(
        "Conversation Store V2 record mutation source is missing"
      );
    }
    assertPlainDirectory(rootStat, "Conversation Store V2 root");
    await assertStoreNamespacesSafe(layout);
    if (await readDeletionTombstoneFromLayout(layout, input.conversationId)) {
      throw new ConversationStoreV2ConflictError(
        "Conversation Store V2 record mutation source is already deleted"
      );
    }
    return await conversationRecordMutationSourceRelativePaths(
      layout,
      conversationLayout(layout, input.conversationId),
      input.operation
    );
  }

  async commitDeletionTombstone(
    tombstoneInput: ConversationDeletionTombstoneV1,
    options: ConversationStoreV2DeletionOptions = {}
  ): Promise<ConversationDeletionTombstoneV1> {
    const tombstone = parseConversationDeletionTombstone(tombstoneInput);
    return await enqueueConversationStoreV2Mutation(
      this.rootPath,
      tombstone.conversationId,
      async () => await this.commitDeletionTombstoneUnlocked(
        tombstone,
        options
      )
    );
  }

  private async commitDeletionTombstoneUnlocked(
    tombstone: ConversationDeletionTombstoneV1,
    options: ConversationStoreV2DeletionOptions
  ): Promise<ConversationDeletionTombstoneV1> {
    const layout = await ensureStoreLayout(this.rootPath);
    await assertStoreNamespacesSafe(layout);
    const conversation = conversationLayout(
      layout,
      tombstone.conversationId
    );
    const currentMetadata = await readCurrentMetadata(conversation);
    if (currentMetadata && !options.recordMutationRetirement) {
      throw new ConversationStoreV2ConflictError(
        "Conversation Store V2 cannot tombstone an active Conversation"
      );
    }
    if (options.recordMutationRetirement) {
      if (
        !currentMetadata
        || options.recordMutationRetirement.mutationId
          !== tombstone.mutationId
      ) {
        throw new ConversationStoreV2ConflictError(
          "Conversation Store V2 deletion retirement authority is invalid"
        );
      }
      const planned = await conversationRecordMutationSourceRelativePaths(
        layout,
        conversation,
        "delete-conversation"
      );
      assertRecordMutationSourcePlan(
        options.recordMutationRetirement.sourceRelativePaths,
        planned,
        "deletion"
      );
    }
    const existing = await readDeletionTombstoneFromLayout(
      layout,
      tombstone.conversationId
    );
    if (existing) {
      if (!isDeepStrictEqual(existing, tombstone)) {
        throw new ConversationStoreV2ConflictError(
          "Conversation Store V2 deletion tombstone conflicts"
        );
      }
      return existing;
    }
    const targetPath = deletionTombstonePath(
      layout,
      tombstone.conversationId
    );
    await publishImmutableFile(
      layout,
      targetPath,
      Buffer.from(canonicalConversationV2Json(tombstone), "utf8"),
      {
        kind: "deletion-tombstone",
        existingIsSuccess: true
      }
    );
    const readback = await readDeletionTombstoneFromLayout(
      layout,
      tombstone.conversationId
    );
    if (!readback || !isDeepStrictEqual(readback, tombstone)) {
      throw new ConversationStoreV2Error(
        "store-corrupt",
        "Conversation Store V2 deletion tombstone readback mismatch"
      );
    }
    await this.reconcileIndexInternal(layout);
    return readback;
  }

  async readDeletionTombstone(
    conversationId: string
  ): Promise<ConversationDeletionTombstoneV1 | null> {
    const layout = storeLayout(this.rootPath);
    const rootStat = await lstatOrNull(layout.rootPath);
    if (!rootStat) return null;
    assertPlainDirectory(rootStat, "Conversation Store V2 root");
    await assertStoreNamespacesSafe(layout);
    return await readDeletionTombstoneFromLayout(layout, conversationId);
  }

  async listDeletionTombstones():
  Promise<ConversationDeletionTombstoneV1[]> {
    const layout = storeLayout(this.rootPath);
    const rootStat = await lstatOrNull(layout.rootPath);
    if (!rootStat) return [];
    assertPlainDirectory(rootStat, "Conversation Store V2 root");
    await assertStoreNamespacesSafe(layout);
    return await scanDeletionTombstones(layout);
  }

  async listConversationShells(): Promise<ConversationShellV2[]> {
    const layout = await ensureStoreLayout(this.rootPath);
    const index = await this.reconcileIndexInternal(layout);
    return index.entries.map((entry) => ({ ...entry.shell }));
  }

  async reconcileIndex(): Promise<ConversationShellV2[]> {
    return await this.listConversationShells();
  }

  async readIndex(): Promise<ConversationShellV2[]> {
    const layout = storeLayout(this.rootPath);
    const rootStat = await lstatOrNull(layout.rootPath);
    if (!rootStat) return [];
    assertPlainDirectory(rootStat, "Conversation Store V2 root");
    await assertStoreNamespacesSafe(layout);
    const index = await readIndexOrNull(layout.indexPath);
    return index?.entries.map((entry) => ({ ...entry.shell })) ?? [];
  }

  /**
   * Strict read-only migration snapshot. Unlike listConversationShells(), this
   * never initializes namespaces or repairs index drift.
   */
  async inspectMigrationSnapshot():
  Promise<ConversationStoreV2MigrationSnapshot> {
    const layout = storeLayout(this.rootPath);
    const rootStat = await lstatOrNull(layout.rootPath);
    if (!rootStat) {
      return { commits: [], deletionTombstones: [] };
    }
    assertPlainDirectory(rootStat, "Conversation Store V2 root");
    await assertStoreNamespacesSafe(layout);
    const stagingEntries = await fsp.readdir(
      layout.stagingRootPath,
      { withFileTypes: true }
    );
    if (stagingEntries.length) {
      throw new ConversationStoreV2Error(
        "store-corrupt",
        "Conversation Store V2 migration snapshot 含未收口 staging"
      );
    }
    const scannedEntries = await scanCommittedConversations(layout);
    const index = await readIndexOrNull(layout.indexPath);
    if (!index || !isDeepStrictEqual(index.entries, scannedEntries)) {
      throw new ConversationStoreV2Error(
        "store-corrupt",
        "Conversation Store V2 migration snapshot index 漂移"
      );
    }
    const commits: ConversationCommitV2[] = [];
    const conversationIds = new Set<string>();
    const referencedPayloadFiles = new Set<string>();
    for (const entry of scannedEntries) {
      const commit = await this.readConversation(entry.shell.conversationId);
      if (!commit) {
        throw new ConversationStoreV2Error(
          "store-corrupt",
          "Conversation Store V2 migration snapshot 丢失 committed payload"
        );
      }
      commits.push(commit);
      conversationIds.add(commit.metadata.conversationId);
      const conversation = conversationLayout(
        layout,
        commit.metadata.conversationId
      );
      const committedMetadata = await readMetadataChain(conversation);
      const metadataEntries = await fsp.readdir(
        conversation.metadataRootPath,
        { withFileTypes: true }
      );
      if (metadataEntries.length !== committedMetadata.length) {
        throw new ConversationStoreV2Error(
          "store-corrupt",
          "Conversation Store V2 migration snapshot contains uncommitted metadata"
        );
      }
      for (const metadata of committedMetadata) {
        await readPayload(layout, metadata.payloadDigest);
        referencedPayloadFiles.add(
          `${metadata.payloadDigest.slice("sha256:".length)}.json`
        );
      }
    }
    const payloadFiles = (await fsp.readdir(
      layout.payloadsRootPath,
      { withFileTypes: true }
    )).map((entry) => entry.name).sort();
    if (
      !isDeepStrictEqual(
        payloadFiles,
        [...referencedPayloadFiles].sort()
      )
    ) {
      throw new ConversationStoreV2Error(
        "store-corrupt",
        "Conversation Store V2 migration snapshot 含未归属 payload"
      );
    }
    const deletionTombstones = await scanDeletionTombstones(layout);
    for (const tombstone of deletionTombstones) {
      if (conversationIds.has(tombstone.conversationId)) {
        throw new ConversationStoreV2Error(
          "store-corrupt",
          "Conversation Store V2 contains both an active Conversation and its deletion tombstone"
        );
      }
    }
    return {
      commits: commits.sort((left, right) =>
        left.metadata.conversationId.localeCompare(
          right.metadata.conversationId
        )),
      deletionTombstones
    };
  }

  private async reconcileIndexInternal(
    layout: StoreLayout,
    inject?: (point: ConversationStoreV2FaultPoint) => Promise<void>
  ): Promise<ConversationIndexV2> {
    await assertStoreNamespacesSafe(layout);
    const existing = await readIndexOrNull(layout.indexPath);
    const deletedConversationIds = new Set(
      (await scanDeletionTombstones(layout)).map(
        (tombstone) => tombstone.conversationId
      )
    );
    const entries = (await scanCommittedConversations(layout)).filter(
      (entry) => !deletedConversationIds.has(entry.shell.conversationId)
    );
    if (existing && isDeepStrictEqual(existing.entries, entries)) {
      return existing;
    }
    await inject?.("before-index");
    const generatedAt = Math.max(
      this.now(),
      (existing?.generatedAt ?? 0) + 1,
      ...entries.map((entry) => entry.shell.updatedAt)
    );
    const candidate: ConversationIndexV2 = {
      schemaVersion: INDEX_SCHEMA_VERSION,
      recordType: "conversation-index",
      generatedAt,
      entries
    };
    validateIndex(candidate);
    await writeIndexAtomically(layout, candidate);
    const readback = await readIndexOrNull(layout.indexPath);
    if (!readback || !isDeepStrictEqual(readback, candidate)) {
      throw new ConversationStoreV2Error(
        "store-corrupt",
        "Conversation Store V2 index readback 不一致"
      );
    }
    await inject?.("after-index");
    return readback;
  }
}

async function publishImmutablePayload(
  layout: StoreLayout,
  payload: ConversationPayloadV2
): Promise<void> {
  validateConversationPayloadV2(payload);
  const digest = digestPayload(payload);
  const targetPath = payloadPath(layout, digest);
  const bytes = Buffer.from(canonicalConversationV2Json(payload), "utf8");
  await publishImmutableFile(layout, targetPath, bytes, {
    kind: "payload",
    existingIsSuccess: true
  });
  const readback = await readPayload(layout, digest);
  if (!isDeepStrictEqual(readback, payload)) {
    throw new ConversationStoreV2Error(
      "store-corrupt",
      "Conversation Store V2 payload readback 不一致"
    );
  }
}

async function publishMetadataMarker(
  layout: StoreLayout,
  conversation: ConversationLayout,
  metadata: ConversationMetadataV2,
  afterPublish?: () => void | Promise<void>
): Promise<void> {
  validateConversationMetadataV2(metadata);
  const targetPath = path.join(
    conversation.metadataRootPath,
    entryFileName(metadata.revision)
  );
  const bytes = Buffer.from(canonicalConversationV2Json(metadata), "utf8");
  await publishImmutableFile(layout, targetPath, bytes, {
    kind: "metadata",
    existingIsSuccess: true
  });
  await afterPublish?.();
  await writeConversationHeadAtomically(layout, conversation, metadata);
  const chain = await readMetadataChain(conversation);
  const readback = chain.at(-1);
  if (!readback || !isDeepStrictEqual(readback, metadata)) {
    throw new ConversationStoreV2Error(
      "store-corrupt",
      "Conversation Store V2 metadata marker readback 不一致"
    );
  }
}

async function publishImmutableFile(
  layout: StoreLayout,
  targetPath: string,
  bytes: Buffer,
  options: {
    kind:
      | "payload"
      | "metadata"
      | "deletion-tombstone"
      | "retirement-marker";
    existingIsSuccess: boolean;
  }
): Promise<void> {
  if (bytes.byteLength > MAX_RECORD_BYTES) {
    throw new ConversationStoreV2Error(
      "unsafe-entry",
      `Conversation Store V2 ${options.kind} 超过安全大小上限`
    );
  }
  const stagedPath = path.join(
    layout.stagingRootPath,
    `.${options.kind}-${randomUUID()}.tmp`
  );
  let staged = false;
  try {
    await writeNewFileDurably(stagedPath, bytes);
    staged = true;
    await syncDirectory(layout.stagingRootPath);
    try {
      await fsp.link(stagedPath, targetPath);
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      if (!options.existingIsSuccess) {
        throw new ConversationStoreV2ConflictError(
          "Conversation Store V2 revision 已由另一个 writer 提交"
        );
      }
      const existing = await readRegularFileSafely(
        targetPath,
        `Conversation Store V2 existing ${options.kind}`,
        [1, 2]
      );
      if (!existing.equals(bytes)) {
        if (
          options.kind === "metadata"
          || options.kind === "deletion-tombstone"
          || options.kind === "retirement-marker"
        ) {
          throw new ConversationStoreV2ConflictError(
            `Conversation Store V2 ${options.kind} identity is already occupied`
          );
        }
        throw new ConversationStoreV2Error(
          "store-corrupt",
          `Conversation Store V2 immutable ${options.kind} 地址内容冲突`
        );
      }
      await fsp.unlink(stagedPath);
      staged = false;
      await syncDirectory(layout.stagingRootPath);
      return;
    }
    await syncDirectory(path.dirname(targetPath));
    const readback = await readRegularFileSafely(
      targetPath,
      `Conversation Store V2 published ${options.kind}`,
      [1, 2]
    );
    if (!readback.equals(bytes)) {
      throw new ConversationStoreV2Error(
        "store-corrupt",
        `Conversation Store V2 ${options.kind} publish readback 不一致`
      );
    }
    await fsp.unlink(stagedPath);
    staged = false;
    await syncDirectory(layout.stagingRootPath);
  } catch (error) {
    if (staged) {
      await fsp.unlink(stagedPath).catch(() => undefined);
      await syncDirectory(layout.stagingRootPath).catch(() => undefined);
    }
    throw error;
  }
}

async function scanCommittedConversations(
  layout: StoreLayout
): Promise<ConversationIndexEntryV2[]> {
  const entries = await fsp.readdir(
    layout.conversationsRootPath,
    { withFileTypes: true }
  );
  const output: ConversationIndexEntryV2[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (
      !CONVERSATION_TOKEN_PATTERN.test(entry.name)
      || !entry.isDirectory()
      || entry.isSymbolicLink()
    ) {
      throw new ConversationStoreV2Error(
        "unsafe-entry",
        `Conversation Store V2 conversations 含 unknown/unsafe entry：${entry.name}`
      );
    }
    const conversation: ConversationLayout = {
      token: entry.name,
      rootPath: path.join(layout.conversationsRootPath, entry.name),
      metadataRootPath: path.join(
        layout.conversationsRootPath,
        entry.name,
        METADATA_DIRECTORY
      ),
      retirementsRootPath: path.join(
        layout.conversationsRootPath,
        entry.name,
        RETIREMENTS_DIRECTORY
      ),
      headPath: path.join(
        layout.conversationsRootPath,
        entry.name,
        HEAD_FILE
      )
    };
    await assertConversationDirectorySafe(conversation);
    const metadata = await readCurrentMetadata(conversation);
    if (!metadata) continue;
    if (conversationToken(metadata.conversationId) !== conversation.token) {
      throw new ConversationStoreV2Error(
        "store-corrupt",
        "Conversation Store V2 metadata identity 与目录 token 不一致"
      );
    }
    const payload = await readPayload(layout, metadata.payloadDigest);
    const commit = { metadata, payload };
    validateConversationCommitV2(commit);
    output.push({
      metadataRevision: metadata.revision,
      metadataCommitId: metadata.commitId,
      shell: projectConversationShellV2(commit)
    });
  }
  output.sort((left, right) => (
    right.shell.updatedAt - left.shell.updatedAt
    || left.shell.conversationId.localeCompare(right.shell.conversationId)
  ));
  return output;
}

async function readCurrentMetadata(
  conversation: ConversationLayout
): Promise<ConversationMetadataV2 | null> {
  const chain = await readMetadataChain(conversation);
  return chain.at(-1) ?? null;
}

async function readMetadataChain(
  conversation: ConversationLayout
): Promise<ConversationMetadataV2[]> {
  const metadataStat = await lstatOrNull(conversation.metadataRootPath);
  if (!metadataStat) {
    if (await readConversationHeadOrNull(conversation)) {
      throw new ConversationStoreV2Error(
        "store-corrupt",
        "Conversation V2 head exists without metadata directory"
      );
    }
    return [];
  }
  assertPlainDirectory(metadataStat, "Conversation V2 metadata root");
  const entries = await fsp.readdir(
    conversation.metadataRootPath,
    { withFileTypes: true }
  );
  if (!entries.length) {
    if (await readConversationHeadOrNull(conversation)) {
      throw new ConversationStoreV2Error(
        "store-corrupt",
        "Conversation V2 head exists without metadata chain"
      );
    }
    return [];
  }
  const ordered = entries.map((entry) => {
    const match = ENTRY_PATTERN.exec(entry.name);
    if (!match || !entry.isFile() || entry.isSymbolicLink()) {
      throw new ConversationStoreV2Error(
        "unsafe-entry",
        `Conversation V2 metadata 含 unknown/unsafe entry：${entry.name}`
      );
    }
    return {
      name: entry.name,
      revision: Number(match[1])
    };
  }).sort((left, right) => left.revision - right.revision);
  const firstRevision = ordered[0].revision;
  const retirementMarkers =
    await readConversationPayloadRetirementMarkers(conversation);
  const baseRetirementMarker = firstRevision === 0
    ? null
    : retirementMarkers.at(-1) ?? null;
  if (
    firstRevision > 0
    && baseRetirementMarker?.retainedRevision !== firstRevision
  ) {
    throw new ConversationStoreV2Error(
      "store-corrupt",
      "Conversation V2 retired metadata base lacks its immutable marker"
    );
  }
  const chain: ConversationMetadataV2[] = [];
  for (let index = 0; index < ordered.length; index += 1) {
    const entry = ordered[index];
    const expectedRevision = firstRevision + index;
    if (
      entry.revision !== expectedRevision
      || entry.name !== entryFileName(expectedRevision)
    ) {
      throw new ConversationStoreV2Error(
        "store-corrupt",
        "Conversation V2 metadata revision chain 不连续"
      );
    }
    const raw = await readJsonFileSafely(
      path.join(conversation.metadataRootPath, entry.name),
      "Conversation V2 metadata entry",
      [1, 2]
    );
    const metadata = validateConversationMetadataV2(raw);
    if (
      metadata.revision !== entry.revision
      || conversationToken(metadata.conversationId) !== conversation.token
    ) {
      throw new ConversationStoreV2Error(
        "store-corrupt",
        "Conversation V2 metadata revision 或 identity 不匹配"
      );
    }
    if (index === 0 && firstRevision > 0) {
      assertRetiredMetadataBase(metadata, baseRetirementMarker!);
    } else {
      assertMetadataChainTransition(chain.at(-1) ?? null, metadata);
    }
    chain.push(metadata);
  }
  const head = await readConversationHeadOrNull(conversation);
  if (!head) {
    if (chain.length === 1 && chain[0].revision === 0) {
      return [];
    }
    throw new ConversationStoreV2Error(
      "store-corrupt",
      "Conversation V2 metadata chain 缺少 commit head"
    );
  }
  const committed = chain.find(
    (metadata) => metadata.revision === head.metadataRevision
  );
  if (
    !committed
    || head.conversationToken !== conversation.token
    || head.metadataCommitId !== committed.commitId
    || head.metadataDigest !== committed.digest
    || ordered.at(-1)!.revision > head.metadataRevision + 1
  ) {
    throw new ConversationStoreV2Error(
      "store-corrupt",
      "Conversation V2 metadata head 与 append-only chain 不一致"
    );
  }
  return chain.filter(
    (metadata) => metadata.revision <= head.metadataRevision
  );
}

async function readPayload(
  layout: StoreLayout,
  digest: string
): Promise<ConversationPayloadV2> {
  if (!SHA256_PATTERN.test(digest)) {
    throw new ConversationStoreV2Error(
      "store-corrupt",
      "Conversation V2 payload digest 非法"
    );
  }
  const raw = await readJsonFileSafely(
    payloadPath(layout, digest),
    "Conversation V2 payload",
    [1, 2]
  );
  const payload = validateConversationPayloadV2(raw);
  if (digestPayload(payload) !== digest) {
    throw new ConversationStoreV2Error(
      "store-corrupt",
      "Conversation V2 payload content address 不匹配"
    );
  }
  return payload;
}

function digestPayload(payload: ConversationPayloadV2): string {
  const bytes = canonicalConversationV2Json(payload);
  return `sha256:${createHash("sha256").update(bytes.slice(0, -1), "utf8").digest("hex")}`;
}

function payloadPath(layout: StoreLayout, digest: string): string {
  if (!SHA256_PATTERN.test(digest)) {
    throw new ConversationStoreV2Error(
      "unsafe-path",
      "Conversation V2 payload digest 不能映射为路径"
    );
  }
  return path.join(
    layout.payloadsRootPath,
    `${digest.slice("sha256:".length)}.json`
  );
}

function assertConversationExpectation(
  current: ConversationMetadataV2 | null,
  options: ConversationStoreV2CommitOptions
): void {
  if (
    (current?.revision ?? null) !== options.expectedRevision
    || (current?.commitId ?? null) !== options.expectedCommitId
  ) {
    throw new ConversationStoreV2ConflictError(
      "Conversation Store V2 revision + commit CAS expectation 已过期"
    );
  }
}

function assertCandidateFollows(
  current: ConversationMetadataV2 | null,
  candidate: ConversationMetadataV2
): void {
  if (!current) {
    if (candidate.revision !== 0) {
      throw new ConversationStoreV2ConflictError(
        "Conversation Store V2 initial revision 必须为 0"
      );
    }
    return;
  }
  if (
    candidate.revision !== current.revision + 1
    || candidate.createdAt !== current.createdAt
    || candidate.updatedAt < current.updatedAt
    || candidate.commitId === current.commitId
    || candidate.previousRevision !== current.revision
    || candidate.previousCommitId !== current.commitId
    || candidate.previousDigest !== current.digest
  ) {
    throw new ConversationStoreV2ConflictError(
      "Conversation Store V2 candidate 不满足 revision/commit 单调 CAS"
    );
  }
  assertMetadataContextTransition(current, candidate);
}

function assertMetadataChainTransition(
  current: ConversationMetadataV2 | null,
  candidate: ConversationMetadataV2
): void {
  if (!current) {
    if (candidate.revision !== 0) {
      throw new ConversationStoreV2Error(
        "store-corrupt",
        "Conversation V2 metadata chain 必须从 revision 0 开始"
      );
    }
    return;
  }
  if (
    candidate.conversationId !== current.conversationId
    || candidate.revision !== current.revision + 1
    || candidate.createdAt !== current.createdAt
    || candidate.updatedAt < current.updatedAt
    || candidate.commitId === current.commitId
    || candidate.previousRevision !== current.revision
    || candidate.previousCommitId !== current.commitId
    || candidate.previousDigest !== current.digest
  ) {
    throw new ConversationStoreV2Error(
      "store-corrupt",
      "Conversation V2 metadata chain 单调性损坏"
    );
  }
  assertMetadataContextTransition(current, candidate, "store-corrupt");
}

function assertMetadataContextTransition(
  current: ConversationMetadataV2,
  candidate: ConversationMetadataV2,
  errorCode: ConversationStoreV2ErrorCode = "revision-conflict"
): void {
  const currentGeneration = current.currentContext.generation;
  const candidateGeneration = candidate.currentContext.generation;
  if (
    candidateGeneration < currentGeneration
    || candidateGeneration > currentGeneration + 1
  ) {
    throwStoreTransitionError(
      errorCode,
      "Conversation V2 currentContext generation 非单调"
    );
  }
  if (
    candidateGeneration === currentGeneration
    && !isDeepStrictEqual(candidate.currentContext, current.currentContext)
  ) {
    throwStoreTransitionError(
      errorCode,
      "Conversation V2 同 generation 不能改变 context/workspace identity"
    );
  }
  if (
    candidateGeneration === currentGeneration + 1
    && candidate.currentContext.id === current.currentContext.id
  ) {
    throwStoreTransitionError(
      errorCode,
      "Conversation V2 新 generation 必须使用新 contextId"
    );
  }
}

function throwStoreTransitionError(
  code: ConversationStoreV2ErrorCode,
  message: string
): never {
  if (code === "revision-conflict") {
    throw new ConversationStoreV2ConflictError(message);
  }
  throw new ConversationStoreV2Error(code, message);
}

async function ensureStoreLayout(rootPath: string): Promise<StoreLayout> {
  const layout = storeLayout(rootPath);
  await ensurePlainDirectory(layout.rootPath);
  await ensurePlainDirectory(layout.conversationsRootPath);
  await ensurePlainDirectory(layout.payloadsRootPath);
  await ensurePlainDirectory(layout.deletionsRootPath);
  await ensurePlainDirectory(layout.migrationConflictsRootPath);
  await ensurePlainDirectory(layout.stagingRootPath);
  await syncDirectory(layout.rootPath);
  return layout;
}

function storeLayout(rootPath: string): StoreLayout {
  const resolved = path.resolve(rootPath);
  return {
    rootPath: resolved,
    conversationsRootPath: path.join(resolved, CONVERSATIONS_DIRECTORY),
    payloadsRootPath: path.join(resolved, PAYLOADS_DIRECTORY),
    deletionsRootPath: path.join(resolved, DELETIONS_DIRECTORY),
    migrationConflictsRootPath: path.join(
      resolved,
      MIGRATION_CONFLICTS_DIRECTORY
    ),
    stagingRootPath: path.join(resolved, STAGING_DIRECTORY),
    indexPath: path.join(resolved, INDEX_FILE)
  };
}

async function ensureConversationLayout(
  layout: StoreLayout,
  conversationId: string
): Promise<ConversationLayout> {
  const conversation = conversationLayout(layout, conversationId);
  await ensurePlainDirectory(conversation.rootPath);
  await ensurePlainDirectory(conversation.metadataRootPath);
  await ensurePlainDirectory(conversation.retirementsRootPath);
  await syncDirectory(layout.conversationsRootPath);
  await syncDirectory(conversation.rootPath);
  return conversation;
}

function conversationLayout(
  layout: StoreLayout,
  conversationId: string
): ConversationLayout {
  const token = conversationToken(conversationId);
  const rootPath = path.join(layout.conversationsRootPath, token);
  return {
    token,
    rootPath,
    metadataRootPath: path.join(rootPath, METADATA_DIRECTORY),
    retirementsRootPath: path.join(rootPath, RETIREMENTS_DIRECTORY),
    headPath: path.join(rootPath, HEAD_FILE)
  };
}

function conversationToken(conversationId: string): string {
  if (
    typeof conversationId !== "string"
    || !conversationId.length
    || conversationId.length > 512
  ) {
    throw new ConversationStoreV2Error(
      "unsafe-path",
      "Conversation V2 identity 不能映射为路径"
    );
  }
  return `conversation-${createHash("sha256")
    .update(conversationId, "utf8")
    .digest("hex")}`;
}

async function assertStoreNamespacesSafe(layout: StoreLayout): Promise<void> {
  const root = await fsp.lstat(layout.rootPath);
  assertPlainDirectory(root, "Conversation Store V2 root");
  for (const [directoryPath, label] of [
    [layout.conversationsRootPath, "Conversation Store V2 conversations"],
    [layout.payloadsRootPath, "Conversation Store V2 payloads"],
    [layout.deletionsRootPath, "Conversation Store V2 deletions"],
    [
      layout.migrationConflictsRootPath,
      "Conversation Store V2 migration conflicts"
    ],
    [layout.stagingRootPath, "Conversation Store V2 staging"]
  ] as const) {
    const stat = await fsp.lstat(directoryPath);
    assertPlainDirectory(stat, label);
  }
  const rootEntries = await fsp.readdir(layout.rootPath, { withFileTypes: true });
  const allowedRootEntries = new Set([
    CONVERSATIONS_DIRECTORY,
    PAYLOADS_DIRECTORY,
    DELETIONS_DIRECTORY,
    MIGRATION_CONFLICTS_DIRECTORY,
    STAGING_DIRECTORY,
    INDEX_FILE
  ]);
  for (const entry of rootEntries) {
    if (!allowedRootEntries.has(entry.name) || entry.isSymbolicLink()) {
      throw new ConversationStoreV2Error(
        "unsafe-entry",
        `Conversation Store V2 root 含 unknown/unsafe entry：${entry.name}`
      );
    }
    if (entry.name === INDEX_FILE && !entry.isFile()) {
      throw new ConversationStoreV2Error(
        "unsafe-entry",
        "Conversation Store V2 index 必须是 regular file"
      );
    }
    if (entry.name !== INDEX_FILE && !entry.isDirectory()) {
      throw new ConversationStoreV2Error(
        "unsafe-entry",
        `Conversation Store V2 namespace 非目录：${entry.name}`
      );
    }
  }

  const payloadEntries = await fsp.readdir(
    layout.payloadsRootPath,
    { withFileTypes: true }
  );
  for (const entry of payloadEntries) {
    if (
      !PAYLOAD_FILE_PATTERN.test(entry.name)
      || !entry.isFile()
      || entry.isSymbolicLink()
    ) {
      throw new ConversationStoreV2Error(
        "unsafe-entry",
        `Conversation Store V2 payloads 含 unknown/unsafe entry：${entry.name}`
      );
    }
  }
  const deletionEntries = await fsp.readdir(
    layout.deletionsRootPath,
    { withFileTypes: true }
  );
  for (const entry of deletionEntries) {
    if (
      !DELETION_FILE_PATTERN.test(entry.name)
      || !entry.isFile()
      || entry.isSymbolicLink()
    ) {
      throw new ConversationStoreV2Error(
        "unsafe-entry",
        `Conversation Store V2 deletions contains unknown/unsafe entry: ${entry.name}`
      );
    }
  }
}

function deletionTombstonePath(
  layout: StoreLayout,
  conversationId: string
): string {
  return path.join(
    layout.deletionsRootPath,
    `${conversationToken(conversationId)}.json`
  );
}

async function readDeletionTombstoneFromLayout(
  layout: StoreLayout,
  conversationId: string
): Promise<ConversationDeletionTombstoneV1 | null> {
  const absolutePath = deletionTombstonePath(layout, conversationId);
  if (!await lstatOrNull(absolutePath)) return null;
  let parsed: ConversationDeletionTombstoneV1;
  try {
    parsed = parseConversationDeletionTombstone(
      await readJsonFileSafely(
        absolutePath,
        "Conversation Store V2 deletion tombstone",
        [1, 2]
      )
    );
  } catch (error) {
    if (error instanceof ConversationStoreV2Error) throw error;
    throw new ConversationStoreV2Error(
      "store-corrupt",
      `Conversation Store V2 deletion tombstone is invalid: ${errorMessage(error)}`
    );
  }
  if (parsed.conversationId !== conversationId) {
    throw new ConversationStoreV2Error(
      "store-corrupt",
      "Conversation Store V2 deletion tombstone identity mismatch"
    );
  }
  return parsed;
}

async function scanDeletionTombstones(
  layout: StoreLayout
): Promise<ConversationDeletionTombstoneV1[]> {
  const entries = await fsp.readdir(
    layout.deletionsRootPath,
    { withFileTypes: true }
  );
  const output: ConversationDeletionTombstoneV1[] = [];
  const conversationIds = new Set<string>();
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name))) {
    if (
      !DELETION_FILE_PATTERN.test(entry.name)
      || !entry.isFile()
      || entry.isSymbolicLink()
    ) {
      throw new ConversationStoreV2Error(
        "unsafe-entry",
        `Conversation Store V2 deletions contains unknown/unsafe entry: ${entry.name}`
      );
    }
    let tombstone: ConversationDeletionTombstoneV1;
    try {
      tombstone = parseConversationDeletionTombstone(
        await readJsonFileSafely(
          path.join(layout.deletionsRootPath, entry.name),
          "Conversation Store V2 deletion tombstone",
          [1, 2]
        )
      );
    } catch (error) {
      if (error instanceof ConversationStoreV2Error) throw error;
      throw new ConversationStoreV2Error(
        "store-corrupt",
        `Conversation Store V2 deletion tombstone is invalid: ${errorMessage(error)}`
      );
    }
    if (
      entry.name !== `${conversationToken(tombstone.conversationId)}.json`
      || conversationIds.has(tombstone.conversationId)
    ) {
      throw new ConversationStoreV2Error(
        "store-corrupt",
        "Conversation Store V2 deletion tombstone namespace conflict"
      );
    }
    conversationIds.add(tombstone.conversationId);
    output.push(tombstone);
  }
  return output.sort((left, right) =>
    left.conversationId.localeCompare(right.conversationId));
}

async function assertConversationDirectorySafe(
  conversation: ConversationLayout
): Promise<void> {
  const rootStat = await fsp.lstat(conversation.rootPath);
  assertPlainDirectory(rootStat, "Conversation V2 directory");
  const entries = await fsp.readdir(conversation.rootPath, { withFileTypes: true });
  for (const entry of entries) {
    if (
      entry.isSymbolicLink()
      || (
        entry.name === METADATA_DIRECTORY
          ? !entry.isDirectory()
          : entry.name === RETIREMENTS_DIRECTORY
            ? !entry.isDirectory()
          : entry.name === HEAD_FILE
            ? !entry.isFile()
            : true
      )
    ) {
      throw new ConversationStoreV2Error(
        "unsafe-entry",
        `Conversation V2 directory 含 unknown/unsafe entry：${entry.name}`
      );
    }
  }
  const retirementStat = await lstatOrNull(
    conversation.retirementsRootPath
  );
  if (retirementStat) {
    assertPlainDirectory(
      retirementStat,
      "Conversation V2 retirement root"
    );
    await readConversationPayloadRetirementMarkers(conversation);
  }
}

function assertConversationPayloadTransition(
  current: ConversationPayloadV2,
  candidate: ConversationPayloadV2
): void {
  if (candidate.messages.length < current.messages.length) {
    throw new ConversationStoreV2ConflictError(
      "Conversation V2 normal commit cannot delete existing messages"
    );
  }
  for (let index = 0; index < current.messages.length; index += 1) {
    if (!isDeepStrictEqual(current.messages[index], candidate.messages[index])) {
      throw new ConversationStoreV2ConflictError(
        "Conversation V2 normal commit cannot rewrite existing messages"
      );
    }
  }
}

async function assertAndPublishPayloadRetirementMarker(input: {
  layout: StoreLayout;
  conversation: ConversationLayout;
  currentMetadata: ConversationMetadataV2;
  candidate: ConversationCommitV2;
  mutationId: string;
  sourceRelativePaths: readonly string[];
}): Promise<void> {
  if (
    !input.mutationId.trim()
    || input.candidate.payload.messages.length !== 0
    || input.candidate.payload.snapshot !== null
    || input.candidate.metadata.currentContext.generation
      !== input.currentMetadata.currentContext.generation + 1
  ) {
    throw new ConversationStoreV2ConflictError(
      "Conversation Store V2 record clear target is invalid"
    );
  }
  const planned = await conversationRecordMutationSourceRelativePaths(
    input.layout,
    input.conversation,
    "clear-conversation-records"
  );
  assertRecordMutationSourcePlan(
    input.sourceRelativePaths,
    planned,
    "record clear"
  );
  await ensurePlainDirectory(input.conversation.retirementsRootPath);
  const markers =
    await readConversationPayloadRetirementMarkers(input.conversation);
  const previousMarker = markers.at(-1) ?? null;
  const markerWithoutDigest = {
    schemaVersion: 1 as const,
    recordType: "conversation-payload-retirement" as const,
    conversationId: input.currentMetadata.conversationId,
    mutationId: input.mutationId.trim(),
    retainedRevision: input.candidate.metadata.revision,
    retainedMetadataCommitId: input.candidate.metadata.commitId,
    retainedMetadataDigest: input.candidate.metadata.digest,
    retiredThroughRevision: input.currentMetadata.revision,
    retiredHeadCommitId: input.currentMetadata.commitId,
    retiredHeadDigest: input.currentMetadata.digest,
    sourceRelativePaths: [...planned],
    previousMarkerDigest: previousMarker?.digest ?? null
  };
  const marker: ConversationPayloadRetirementMarkerV1 = {
    ...markerWithoutDigest,
    digest: conversationV2RecordDigest(markerWithoutDigest)
  };
  const targetPath = path.join(
    input.conversation.retirementsRootPath,
    retirementFileName(marker.retainedRevision)
  );
  await publishImmutableFile(
    input.layout,
    targetPath,
    Buffer.from(canonicalConversationV2Json(marker), "utf8"),
    {
      kind: "retirement-marker",
      existingIsSuccess: true
    }
  );
  const readback =
    await readConversationPayloadRetirementMarkers(input.conversation);
  if (!isDeepStrictEqual(readback.at(-1), marker)) {
    throw new ConversationStoreV2Error(
      "store-corrupt",
      "Conversation V2 payload retirement marker readback mismatch"
    );
  }
}

async function conversationRecordMutationSourceRelativePaths(
  layout: StoreLayout,
  conversation: ConversationLayout,
  operation: "clear-conversation-records" | "delete-conversation"
): Promise<string[]> {
  const conversationStat = await lstatOrNull(conversation.rootPath);
  if (!conversationStat) {
    throw new ConversationStoreV2ConflictError(
      "Conversation Store V2 record mutation source is missing"
    );
  }
  assertPlainDirectory(conversationStat, "Conversation V2 directory");
  await assertConversationDirectorySafe(conversation);
  const metadataChain = await readMetadataChain(conversation);
  if (!metadataChain.length) {
    throw new ConversationStoreV2ConflictError(
      "Conversation Store V2 record mutation source is uncommitted"
    );
  }
  const metadataEntries = await fsp.readdir(
    conversation.metadataRootPath,
    { withFileTypes: true }
  );
  if (
    metadataEntries.length !== metadataChain.length
    || metadataEntries.some(
      (entry) => !entry.isFile() || entry.isSymbolicLink()
    )
  ) {
    throw new ConversationStoreV2ConflictError(
      "Conversation Store V2 record mutation source contains uncommitted metadata"
    );
  }
  const payloadPaths = [...new Set(metadataChain.map(
    (metadata) => (
      `${PAYLOADS_DIRECTORY}/${
        metadata.payloadDigest.slice("sha256:".length)
      }.json`
    )
  ))];
  for (const relativePath of payloadPaths) {
    const stat = await lstatOrNull(path.join(layout.rootPath, relativePath));
    if (!stat) {
      throw new ConversationStoreV2ConflictError(
        "Conversation Store V2 record mutation payload is missing"
      );
    }
    assertSafeRegularFile(
      stat,
      "Conversation Store V2 record mutation payload",
      [1, 2]
    );
  }
  if (operation === "delete-conversation") {
    return [
      `${CONVERSATIONS_DIRECTORY}/${conversation.token}`,
      ...payloadPaths
    ].sort((left, right) => left.localeCompare(right));
  }
  const retainedEmptyPayloadDigest = digestPayload({
    schemaVersion: 2,
    recordType: "conversation-payload",
    conversationId: metadataChain.at(-1)!.conversationId,
    messages: [],
    snapshot: null
  });
  const retiredPayloadPaths = payloadPaths.filter(
    (relativePath) => !relativePath.endsWith(
      `${retainedEmptyPayloadDigest.slice("sha256:".length)}.json`
    )
  );
  return [
    ...metadataChain.map((metadata) => (
      `${CONVERSATIONS_DIRECTORY}/${conversation.token}/${
        METADATA_DIRECTORY
      }/${entryFileName(metadata.revision)}`
    )),
    ...retiredPayloadPaths
  ].sort((left, right) => left.localeCompare(right));
}

function assertRecordMutationSourcePlan(
  input: readonly string[],
  expected: readonly string[],
  label: string
): void {
  const normalized = input.map((value) => {
    if (
      typeof value !== "string"
      || !value.length
      || value !== value.trim()
      || value.startsWith("/")
      || value.includes("\\")
      || value.split("/").some(
        (segment) => !segment || segment === "." || segment === ".."
      )
    ) {
      throw new ConversationStoreV2ConflictError(
        `Conversation Store V2 ${label} source plan is invalid`
      );
    }
    return value;
  }).sort((left, right) => left.localeCompare(right));
  if (
    new Set(normalized).size !== normalized.length
    || !isDeepStrictEqual(normalized, expected)
  ) {
    throw new ConversationStoreV2ConflictError(
      `Conversation Store V2 ${label} source plan changed`
    );
  }
}

async function readConversationPayloadRetirementMarkers(
  conversation: ConversationLayout
): Promise<ConversationPayloadRetirementMarkerV1[]> {
  const rootStat = await lstatOrNull(conversation.retirementsRootPath);
  if (!rootStat) return [];
  assertPlainDirectory(rootStat, "Conversation V2 retirement root");
  const entries = (await fsp.readdir(
    conversation.retirementsRootPath,
    { withFileTypes: true }
  )).map((entry) => {
    const match = RETIREMENT_FILE_PATTERN.exec(entry.name);
    if (!match || !entry.isFile() || entry.isSymbolicLink()) {
      throw new ConversationStoreV2Error(
        "unsafe-entry",
        `Conversation V2 retirements contains unsafe entry: ${entry.name}`
      );
    }
    return {
      name: entry.name,
      retainedRevision: Number(match[1])
    };
  }).sort((left, right) =>
    left.retainedRevision - right.retainedRevision);
  const markers: ConversationPayloadRetirementMarkerV1[] = [];
  for (const entry of entries) {
    const marker = validateConversationPayloadRetirementMarker(
      await readJsonFileSafely(
        path.join(conversation.retirementsRootPath, entry.name),
        "Conversation V2 payload retirement marker",
        [1, 2]
      )
    );
    if (
      marker.retainedRevision !== entry.retainedRevision
      || entry.name !== retirementFileName(marker.retainedRevision)
      || conversationToken(marker.conversationId) !== conversation.token
      || marker.previousMarkerDigest
        !== (markers.at(-1)?.digest ?? null)
      || (
        markers.length > 0
        && marker.retiredThroughRevision
          < markers.at(-1)!.retainedRevision
      )
    ) {
      throw new ConversationStoreV2Error(
        "store-corrupt",
        "Conversation V2 payload retirement marker chain is invalid"
      );
    }
    markers.push(marker);
  }
  return markers;
}

function validateConversationPayloadRetirementMarker(
  value: unknown
): ConversationPayloadRetirementMarkerV1 {
  const record = requirePlainRecord(
    value,
    "Conversation V2 payload retirement marker"
  );
  assertExactObjectKeys(record, [
    "schemaVersion",
    "recordType",
    "conversationId",
    "mutationId",
    "retainedRevision",
    "retainedMetadataCommitId",
    "retainedMetadataDigest",
    "retiredThroughRevision",
    "retiredHeadCommitId",
    "retiredHeadDigest",
    "sourceRelativePaths",
    "previousMarkerDigest",
    "digest"
  ], "Conversation V2 payload retirement marker");
  const {
    digest,
    ...withoutDigest
  } = record;
  if (
    record.schemaVersion !== 1
    || record.recordType !== "conversation-payload-retirement"
    || typeof record.conversationId !== "string"
    || !record.conversationId.length
    || typeof record.mutationId !== "string"
    || !record.mutationId.length
    || !isNonNegativeSafeInteger(record.retainedRevision)
    || typeof record.retainedMetadataCommitId !== "string"
    || !record.retainedMetadataCommitId.length
    || typeof record.retainedMetadataDigest !== "string"
    || !SHA256_PATTERN.test(record.retainedMetadataDigest)
    || !isNonNegativeSafeInteger(record.retiredThroughRevision)
    || record.retiredThroughRevision >= record.retainedRevision
    || typeof record.retiredHeadCommitId !== "string"
    || !record.retiredHeadCommitId.length
    || typeof record.retiredHeadDigest !== "string"
    || !SHA256_PATTERN.test(record.retiredHeadDigest)
    || !Array.isArray(record.sourceRelativePaths)
    || record.sourceRelativePaths.some(
      (entry) => typeof entry !== "string" || !entry.length
    )
    || (
      record.previousMarkerDigest !== null
      && (
        typeof record.previousMarkerDigest !== "string"
        || !SHA256_PATTERN.test(record.previousMarkerDigest)
      )
    )
    || typeof digest !== "string"
    || !SHA256_PATTERN.test(digest)
    || digest !== conversationV2RecordDigest(withoutDigest)
  ) {
    throw new ConversationStoreV2Error(
      "store-corrupt",
      "Conversation V2 payload retirement marker is invalid"
    );
  }
  return record as unknown as ConversationPayloadRetirementMarkerV1;
}

function assertRetiredMetadataBase(
  metadata: ConversationMetadataV2,
  marker: ConversationPayloadRetirementMarkerV1
): void {
  if (
    metadata.revision !== marker.retainedRevision
    || metadata.commitId !== marker.retainedMetadataCommitId
    || metadata.digest !== marker.retainedMetadataDigest
    || metadata.previousRevision !== marker.retiredThroughRevision
    || metadata.previousCommitId !== marker.retiredHeadCommitId
    || metadata.previousDigest !== marker.retiredHeadDigest
  ) {
    throw new ConversationStoreV2Error(
      "store-corrupt",
      "Conversation V2 retired metadata base does not match its marker"
    );
  }
}

function conversationV2RecordDigest(value: unknown): string {
  const bytes = canonicalConversationV2Json(value);
  return `sha256:${createHash("sha256")
    .update(bytes.slice(0, -1), "utf8")
    .digest("hex")}`;
}

function retirementFileName(retainedRevision: number): string {
  if (!isNonNegativeSafeInteger(retainedRevision)) {
    throw new ConversationStoreV2Error(
      "unsafe-path",
      "Conversation V2 retirement revision cannot map to a path"
    );
  }
  return `retirement-${String(retainedRevision).padStart(
    ENTRY_WIDTH,
    "0"
  )}.json`;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

async function writeConversationHeadAtomically(
  layout: StoreLayout,
  conversation: ConversationLayout,
  metadata: ConversationMetadataV2
): Promise<void> {
  const head: ConversationHeadV1 = {
    schemaVersion: 1,
    recordType: "conversation-head",
    conversationToken: conversation.token,
    metadataRevision: metadata.revision,
    metadataCommitId: metadata.commitId,
    metadataDigest: metadata.digest
  };
  const existing = await lstatOrNull(conversation.headPath);
  if (existing) assertSafeRegularFile(existing, "Conversation V2 head", [1]);
  const stagedPath = path.join(layout.stagingRootPath, `.head-${randomUUID()}.tmp`);
  await writeNewFileDurably(
    stagedPath,
    Buffer.from(canonicalConversationV2Json(head), "utf8")
  );
  try {
    await syncDirectory(layout.stagingRootPath);
    await fsp.rename(stagedPath, conversation.headPath);
    await syncDirectory(conversation.rootPath);
  } catch (error) {
    await fsp.unlink(stagedPath).catch(() => undefined);
    throw error;
  }
}

async function readConversationHeadOrNull(
  conversation: ConversationLayout
): Promise<ConversationHeadV1 | null> {
  const stat = await lstatOrNull(conversation.headPath);
  if (!stat) return null;
  const record = requirePlainRecord(
    await readJsonFileSafely(conversation.headPath, "Conversation V2 head", [1]),
    "Conversation V2 head"
  );
  assertExactObjectKeys(record, [
    "schemaVersion",
    "recordType",
    "conversationToken",
    "metadataRevision",
    "metadataCommitId",
    "metadataDigest"
  ], "Conversation V2 head");
  if (
    record.schemaVersion !== 1
    || record.recordType !== "conversation-head"
    || typeof record.conversationToken !== "string"
    || !CONVERSATION_TOKEN_PATTERN.test(record.conversationToken)
    || !Number.isSafeInteger(record.metadataRevision)
    || (record.metadataRevision as number) < 0
    || typeof record.metadataCommitId !== "string"
    || !record.metadataCommitId.length
    || typeof record.metadataDigest !== "string"
    || !SHA256_PATTERN.test(record.metadataDigest)
  ) {
    throw new ConversationStoreV2Error("store-corrupt", "Conversation V2 head 非法");
  }
  return record as unknown as ConversationHeadV1;
}

async function ensurePlainDirectory(absolutePath: string): Promise<void> {
  const before = await lstatOrNull(absolutePath);
  if (!before) {
    try {
      await fsp.mkdir(absolutePath, { recursive: false, mode: 0o700 });
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
    }
  }
  const after = await fsp.lstat(absolutePath);
  assertPlainDirectory(after, absolutePath);
}

function assertPlainDirectory(stat: Stats, label: string): void {
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new ConversationStoreV2Error(
      "unsafe-entry",
      `${label} 必须是非 symlink 安全目录`
    );
  }
}

async function writeIndexAtomically(
  layout: StoreLayout,
  index: ConversationIndexV2
): Promise<void> {
  const existingStat = await lstatOrNull(layout.indexPath);
  if (existingStat) assertSafeRegularFile(existingStat, "Conversation V2 index", [1]);
  const stagedPath = path.join(
    layout.stagingRootPath,
    `.index-${randomUUID()}.tmp`
  );
  const bytes = Buffer.from(`${JSON.stringify(index, null, 2)}\n`, "utf8");
  await writeNewFileDurably(stagedPath, bytes);
  try {
    await syncDirectory(layout.stagingRootPath);
    await fsp.rename(stagedPath, layout.indexPath);
    await syncDirectory(layout.rootPath);
  } catch (error) {
    await fsp.unlink(stagedPath).catch(() => undefined);
    throw error;
  }
}

async function readIndexOrNull(
  indexPath: string
): Promise<ConversationIndexV2 | null> {
  const stat = await lstatOrNull(indexPath);
  if (!stat) return null;
  assertSafeRegularFile(stat, "Conversation V2 index", [1]);
  const raw = await readJsonFileSafely(
    indexPath,
    "Conversation V2 index",
    [1]
  );
  return validateIndex(raw);
}

function validateIndex(value: unknown): ConversationIndexV2 {
  const record = requirePlainRecord(value, "Conversation V2 index");
  assertExactObjectKeys(record, [
    "schemaVersion",
    "recordType",
    "generatedAt",
    "entries"
  ], "Conversation V2 index");
  if (record.schemaVersion !== INDEX_SCHEMA_VERSION) {
    if (
      typeof record.schemaVersion === "number"
      && Number.isSafeInteger(record.schemaVersion)
      && record.schemaVersion > INDEX_SCHEMA_VERSION
    ) {
      throw new ConversationStoreV2Error(
        "future-schema",
        `Conversation V2 index future schema：${record.schemaVersion}`
      );
    }
    throw new ConversationStoreV2Error(
      "store-corrupt",
      "Conversation V2 index schemaVersion 未知"
    );
  }
  if (record.recordType !== "conversation-index") {
    throw new ConversationStoreV2Error(
      "store-corrupt",
      "Conversation V2 index recordType 非法"
    );
  }
  if (
    typeof record.generatedAt !== "number"
    || !Number.isSafeInteger(record.generatedAt)
    || record.generatedAt < 0
    || !Array.isArray(record.entries)
  ) {
    throw new ConversationStoreV2Error(
      "store-corrupt",
      "Conversation V2 index fields 非法"
    );
  }
  const seen = new Set<string>();
  for (const entry of record.entries) {
    const indexEntry = requirePlainRecord(entry, "Conversation V2 index entry");
    assertExactObjectKeys(indexEntry, [
      "metadataRevision",
      "metadataCommitId",
      "shell"
    ], "Conversation V2 index entry");
    if (
      typeof indexEntry.metadataRevision !== "number"
      || !Number.isSafeInteger(indexEntry.metadataRevision)
      || indexEntry.metadataRevision < 0
      || typeof indexEntry.metadataCommitId !== "string"
      || !indexEntry.metadataCommitId.length
    ) {
      throw new ConversationStoreV2Error(
        "store-corrupt",
        "Conversation V2 index metadata identity 非法"
      );
    }
    const shell = validateConversationShellV2(indexEntry.shell);
    if (seen.has(shell.conversationId)) {
      throw new ConversationStoreV2Error(
        "store-corrupt",
        "Conversation V2 index conversationId 重复"
      );
    }
    seen.add(shell.conversationId);
  }
  return record as unknown as ConversationIndexV2;
}

async function readJsonFileSafely(
  absolutePath: string,
  label: string,
  allowedLinkCounts: readonly number[]
): Promise<unknown> {
  const bytes = await readRegularFileSafely(
    absolutePath,
    label,
    allowedLinkCounts
  );
  try {
    return JSON.parse(bytes.toString("utf8")) as unknown;
  } catch (error) {
    throw new ConversationStoreV2Error(
      "store-corrupt",
      `${label} JSON 无法解析：${errorMessage(error)}`
    );
  }
}

async function readRegularFileSafely(
  absolutePath: string,
  label: string,
  allowedLinkCounts: readonly number[]
): Promise<Buffer> {
  const handle = await fsp.open(
    absolutePath,
    fsConstants.O_RDONLY | noFollowFlag()
  ).catch((error) => {
    throw new ConversationStoreV2Error(
      "unsafe-entry",
      `${label} 无法 O_NOFOLLOW 打开：${errorMessage(error)}`
    );
  });
  try {
    const before = await handle.stat();
    assertSafeRegularFile(before, label, allowedLinkCounts);
    if (before.size > MAX_RECORD_BYTES) {
      throw new ConversationStoreV2Error(
        "unsafe-entry",
        `${label} 超过安全大小上限`
      );
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (!sameFileVersion(before, after) || bytes.byteLength !== before.size) {
      throw new ConversationStoreV2Error(
        "unsafe-entry",
        `${label} 读取期间发生变化`
      );
    }
    return bytes;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function writeNewFileDurably(
  absolutePath: string,
  bytes: Buffer
): Promise<void> {
  if (bytes.byteLength > MAX_RECORD_BYTES) {
    throw new ConversationStoreV2Error(
      "unsafe-entry",
      "Conversation Store V2 record 超过安全大小上限"
    );
  }
  const handle = await fsp.open(
    absolutePath,
    fsConstants.O_WRONLY
      | fsConstants.O_CREAT
      | fsConstants.O_EXCL
      | noFollowFlag(),
    0o600
  );
  try {
    await handle.writeFile(bytes);
    await handle.chmod(0o600);
    await handle.sync();
    assertSafeRegularFile(
      await handle.stat(),
      "new Conversation Store V2 record",
      [1]
    );
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function syncDirectory(absolutePath: string): Promise<void> {
  const handle = await fsp.open(
    absolutePath,
    fsConstants.O_RDONLY | noFollowFlag()
  );
  try {
    await handle.sync();
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function assertSafeRegularFile(
  stat: Stats,
  label: string,
  allowedLinkCounts: readonly number[]
): void {
  if (
    !stat.isFile()
    || stat.isSymbolicLink()
    || !allowedLinkCounts.includes(Number(stat.nlink))
  ) {
    throw new ConversationStoreV2Error(
      "unsafe-entry",
      `${label} 必须是 O_NOFOLLOW regular file`
    );
  }
}

function sameFileVersion(left: Stats, right: Stats): boolean {
  return (
    left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs
  );
}

function entryFileName(revision: number): string {
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new ConversationStoreV2Error(
      "unsafe-path",
      `Conversation V2 metadata revision 非法：${revision}`
    );
  }
  const digits = String(revision);
  if (digits.length > ENTRY_WIDTH) {
    throw new ConversationStoreV2Error(
      "unsafe-path",
      "Conversation V2 metadata revision 超过文件名上限"
    );
  }
  return `${ENTRY_PREFIX}${digits.padStart(ENTRY_WIDTH, "0")}.json`;
}

function requirePlainRecord(
  value: unknown,
  label: string
): Record<string, unknown> {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new ConversationStoreV2Error(
      "store-corrupt",
      `${label} 必须是普通对象`
    );
  }
  return value as Record<string, unknown>;
}

function assertExactObjectKeys(
  record: Record<string, unknown>,
  keys: readonly string[],
  label: string
): void {
  const expected = new Set(keys);
  for (const key of Object.keys(record)) {
    if (!expected.has(key)) {
      throw new ConversationStoreV2Error(
        "store-corrupt",
        `${label} 含未知字段：${key}`
      );
    }
  }
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) {
      throw new ConversationStoreV2Error(
        "store-corrupt",
        `${label} 缺少字段：${key}`
      );
    }
  }
}

function noFollowFlag(): number {
  return (
    (fsConstants as unknown as Record<string, number>).O_NOFOLLOW
    ?? 0
  );
}

function isAlreadyExists(error: unknown): boolean {
  return (
    typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code?: unknown }).code === "EEXIST"
  );
}

async function lstatOrNull(absolutePath: string): Promise<Stats | null> {
  return await fsp.lstat(absolutePath).catch((error) => {
    if (
      typeof error === "object"
      && error !== null
      && "code" in error
      && (error as { code?: unknown }).code === "ENOENT"
    ) return null;
    throw error;
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function enqueueConversationStoreV2Mutation<T>(
  rootPath: string,
  conversationId: string,
  operation: () => Promise<T>
): Promise<T> {
  const key = `${path.resolve(rootPath)}\0${conversationId}`;
  const previous = conversationMutationTails.get(key) ?? Promise.resolve();
  const result = previous
    .catch(() => undefined)
    .then(operation);
  const tail = result.then(
    () => undefined,
    () => undefined
  );
  conversationMutationTails.set(key, tail);
  try {
    return await result;
  } finally {
    if (conversationMutationTails.get(key) === tail) {
      conversationMutationTails.delete(key);
    }
  }
}
