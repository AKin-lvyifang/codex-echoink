import { isDeepStrictEqual } from "node:util";
import { mkdir, readdir } from "node:fs/promises";
import * as path from "node:path";
import type { KnowledgeReference } from "./types";
import type { PersonalMemorySourceReference } from "../settings/settings";
import {
  PI_NATIVE_FILE_SCHEMA_VERSION,
  PiNativeFileStoreError,
  atomicWriteJsonFile,
  ensurePiNativeVaultFileLayout,
  isNodeErrorWithCode,
  piNativeVaultFileLayout,
  readJsonFileIfPresent,
  requireExactKeys,
  requireNonEmptyString,
  requirePlainObject,
  serializePiNativeFileWrite,
  stablePathToken,
  type PiNativeVaultFileLayout
} from "../harness/pi-native/file-store-utils";

export const KNOWLEDGE_REFERENCE_ENTRY_DETAILS_TYPE =
  "echoink.knowledge-references.v1" as const;

export type KnowledgeUsageWorkflow = "normal_read" | "ask" | "maintain";

/** Phase 3 emits facts only; answers and Vault bodies stay in Pi/Vault. */
export interface KnowledgeUsageEvent {
  sourceEventId: string;
  vaultId: string;
  conversationId: string;
  piSessionId: string;
  piEntryId: string;
  productRunId: string;
  referenceIds: string[];
  workflow: KnowledgeUsageWorkflow;
  producedPaths: string[];
  /** Present only for `/ask`; never includes Memory body or recall clues. */
  personalMemorySources?: PersonalMemorySourceReference[];
}

export interface KnowledgeReferenceEntryDetailsV1 {
  type: typeof KNOWLEDGE_REFERENCE_ENTRY_DETAILS_TYPE;
  schemaVersion: 1;
  references: KnowledgeReference[];
}

export interface KnowledgeUsagePiEntryView {
  readonly type: string;
  readonly id: string;
  readonly details?: unknown;
  readonly message?: {
    readonly role: string;
    readonly toolCallId?: string;
    readonly details?: unknown;
  };
}

export interface KnowledgeUsageMessageDecoration {
  readonly piSessionId: string;
  readonly entryId?: string;
  readonly toolCallId?: string;
  readonly knowledgeReferences?: readonly KnowledgeReference[];
  readonly knowledgeProducedPaths?: readonly string[];
  /** Enables truthful empty-state rendering for a settled `/ask` answer. */
  readonly askSourceAttribution?: true;
  readonly personalMemorySources?: readonly PersonalMemorySourceReference[];
}

export interface KnowledgeUsageMessageData {
  readonly askSourceAttribution: boolean;
  readonly references: readonly KnowledgeReference[];
  readonly producedPaths: readonly string[];
  readonly personalMemorySources: readonly PersonalMemorySourceReference[];
}

export interface FileKnowledgeUsageStoreOptions {
  storageRootPath: string;
  vaultId: string;
}

export interface KnowledgeUsageListOptions {
  conversationId?: string;
  piSessionId?: string;
  productRunId?: string;
}

interface KnowledgeUsageDocumentV1 {
  schemaVersion: typeof PI_NATIVE_FILE_SCHEMA_VERSION;
  vaultId: string;
  event: KnowledgeUsageEvent;
}

const EVENT_KEYS = [
  "sourceEventId",
  "vaultId",
  "conversationId",
  "piSessionId",
  "piEntryId",
  "productRunId",
  "referenceIds",
  "workflow",
  "producedPaths",
  "personalMemorySources"
] as const;

const LEGACY_EVENT_KEYS = EVENT_KEYS.slice(0, -1);

const REFERENCE_KEYS = [
  "referenceId",
  "vaultRelativePath",
  "title",
  "excerpt",
  "contentRevision",
  "lineStart",
  "lineEnd"
] as const;

const OPTIONAL_REFERENCE_KEYS = [
  "sourceType",
  "recordedAt",
  "publishedAt",
  "verificationStatus",
  "totalLines",
  "hasMore",
  "related",
  "applicability"
] as const;

const PERSONAL_MEMORY_SOURCE_KEYS = ["id", "title"] as const;

const WORKFLOWS = new Set<KnowledgeUsageWorkflow>([
  "normal_read",
  "ask",
  "maintain"
]);

/** Per-Vault, immutable, file-per-event pointer store. */
export class FileKnowledgeUsageStore {
  readonly storageRootPath: string;
  readonly vaultId: string;
  readonly rootPath: string;

  private readonly layout: PiNativeVaultFileLayout;

  constructor(options: FileKnowledgeUsageStoreOptions) {
    this.vaultId = requireNonEmptyString(options.vaultId, "vaultId");
    this.layout = piNativeVaultFileLayout(options.storageRootPath, this.vaultId);
    this.storageRootPath = this.layout.storageRootPath;
    this.rootPath = path.join(this.layout.vaultRootPath, "knowledge-usage", "events");
  }

  async initialize(): Promise<void> {
    await serializePiNativeFileWrite(this.storageRootPath, async () => {
      await ensurePiNativeVaultFileLayout(this.layout);
      await mkdir(this.rootPath, { recursive: true, mode: 0o700 });
    });
  }

  async record(input: Readonly<KnowledgeUsageEvent>): Promise<Readonly<KnowledgeUsageEvent>> {
    const event = normalizeKnowledgeUsageEvent(input, "invalid-input");
    if (event.vaultId !== this.vaultId) {
      throw new PiNativeFileStoreError(
        "mapping-conflict",
        "KnowledgeUsageEvent 的 Vault 与 Store 不匹配"
      );
    }
    return await serializePiNativeFileWrite(this.storageRootPath, async () => {
      await ensurePiNativeVaultFileLayout(this.layout);
      await mkdir(this.rootPath, { recursive: true, mode: 0o700 });
      const existing = await this.read(event.sourceEventId);
      if (existing) {
        if (!isDeepStrictEqual(existing, event)) {
          throw new PiNativeFileStoreError(
            "mapping-conflict",
            `sourceEventId ${event.sourceEventId} 已指向另一条使用事实`
          );
        }
        return cloneAndFreezeEvent(existing);
      }
      const document: KnowledgeUsageDocumentV1 = {
        schemaVersion: PI_NATIVE_FILE_SCHEMA_VERSION,
        vaultId: this.vaultId,
        event
      };
      const readback = await atomicWriteJsonFile(
        this.eventFilePath(event.sourceEventId),
        document,
        `KnowledgeUsageEvent ${event.sourceEventId}`,
        (value) => parseKnowledgeUsageDocument(value, this.vaultId)
      );
      return cloneAndFreezeEvent(readback.event);
    });
  }

  async read(sourceEventId: string): Promise<Readonly<KnowledgeUsageEvent> | null> {
    const id = requireNonEmptyString(sourceEventId, "sourceEventId");
    const value = await readJsonFileIfPresent(
      this.eventFilePath(id),
      `KnowledgeUsageEvent ${id}`
    );
    if (value === null) return null;
    const document = parseKnowledgeUsageDocument(value, this.vaultId);
    if (document.event.sourceEventId !== id) {
      throw new PiNativeFileStoreError(
        "store-corrupt",
        "KnowledgeUsageEvent 文件名与 sourceEventId 不匹配"
      );
    }
    return cloneAndFreezeEvent(document.event);
  }

  async list(options: KnowledgeUsageListOptions = {}): Promise<Readonly<KnowledgeUsageEvent>[]> {
    let names: string[];
    try {
      names = await readdir(this.rootPath);
    } catch (error) {
      if (isNodeErrorWithCode(error, "ENOENT")) return [];
      throw error;
    }
    const events: KnowledgeUsageEvent[] = [];
    for (const name of names.sort()) {
      if (!name.endsWith(".json")) continue;
      const value = await readJsonFileIfPresent(
        path.join(this.rootPath, name),
        `KnowledgeUsageEvent file ${name}`
      );
      if (value === null) continue;
      const document = parseKnowledgeUsageDocument(value, this.vaultId);
      if (name !== `${stablePathToken(document.event.sourceEventId)}.json`) {
        throw new PiNativeFileStoreError(
          "store-corrupt",
          `KnowledgeUsageEvent file ${name} 的身份不匹配`
        );
      }
      if (
        (options.conversationId && document.event.conversationId !== options.conversationId)
        || (options.piSessionId && document.event.piSessionId !== options.piSessionId)
        || (options.productRunId && document.event.productRunId !== options.productRunId)
      ) continue;
      events.push(document.event);
    }
    return events
      .sort((left, right) => left.sourceEventId.localeCompare(right.sourceEventId))
      .map(cloneAndFreezeEvent);
  }

  private eventFilePath(sourceEventId: string): string {
    return path.join(this.rootPath, `${stablePathToken(sourceEventId)}.json`);
  }
}

/** Validates the committed Pi pointer before publishing the product fact. */
export class KnowledgeUsageBridge {
  constructor(readonly store: FileKnowledgeUsageStore) {}

  async record(input: {
    readonly event: Readonly<KnowledgeUsageEvent>;
    readonly entries: readonly KnowledgeUsagePiEntryView[];
  }): Promise<Readonly<KnowledgeUsageEvent>> {
    const event = normalizeKnowledgeUsageEvent(input.event, "invalid-input");
    const targetIndex = committedEntryIndex(input.entries, event.piEntryId);
    if (targetIndex < 0) {
      throw new PiNativeFileStoreError(
        "not-found",
        `piEntryId ${event.piEntryId} 不是已提交的 Tool Result 或 Assistant Entry`
      );
    }
    const references = referenceRegistry(input.entries, targetIndex);
    const missing = event.referenceIds.filter((id) => !references.has(id));
    if (missing.length) {
      throw new PiNativeFileStoreError(
        "mapping-conflict",
        `KnowledgeUsageEvent 引用了 Pi Branch 中不存在的引用：${missing.join(", ")}`
      );
    }
    return await this.store.record(event);
  }
}

/** Product-owned Pi Tool Results or hidden Custom Messages use this envelope. */
export function knowledgeReferenceEntryDetails(
  references: readonly KnowledgeReference[]
): Readonly<KnowledgeReferenceEntryDetailsV1> {
  return Object.freeze({
    type: KNOWLEDGE_REFERENCE_ENTRY_DETAILS_TYPE,
    schemaVersion: 1,
    references: references.map((reference) => cloneAndFreezeReference(
      normalizeKnowledgeReference(reference, "invalid-input")
    ))
  });
}

/**
 * Rebuilds product decorations from the active durable Branch plus Usage
 * pointers. Missing Entries or reference envelopes fail closed.
 */
export function decorationsForBranch(
  entries: readonly KnowledgeUsagePiEntryView[],
  usage: readonly Readonly<KnowledgeUsageEvent>[]
): KnowledgeUsageMessageDecoration[] {
  const grouped = new Map<string, {
    piSessionId: string;
    entryId?: string;
    toolCallId?: string;
    references: Map<string, KnowledgeReference>;
    producedPaths: string[];
    askSourceAttribution: boolean;
    personalMemorySources: Map<string, PersonalMemorySourceReference>;
  }>();

  for (const rawEvent of usage) {
    let event: KnowledgeUsageEvent;
    try {
      event = normalizeKnowledgeUsageEvent(rawEvent, "invalid-input");
    } catch {
      continue;
    }
    const targetIndex = committedEntryIndex(entries, event.piEntryId);
    if (targetIndex < 0) continue;
    const target = entries[targetIndex];
    const registry = referenceRegistry(entries, targetIndex);
    const references = event.referenceIds.map((id) => registry.get(id));
    if (references.some((reference) => !reference)) continue;
    const toolCallId = target.message?.role === "toolResult"
      ? visibleIdentity(target.message.toolCallId)
      : undefined;
    if (target.message?.role === "toolResult" && !toolCallId) continue;
    const identity = toolCallId ? `tool:${toolCallId}` : `entry:${target.id}`;
    const key = `${event.piSessionId}\0${identity}`;
    const current = grouped.get(key) ?? {
      piSessionId: event.piSessionId,
      ...(toolCallId ? { toolCallId } : { entryId: target.id }),
      references: new Map<string, KnowledgeReference>(),
      producedPaths: [],
      askSourceAttribution: false,
      personalMemorySources: new Map<string, PersonalMemorySourceReference>()
    };
    for (const reference of references) {
      if (reference) current.references.set(reference.referenceId, reference);
    }
    current.producedPaths = uniqueStrings([
      ...current.producedPaths,
      ...event.producedPaths
    ]);
    if (event.workflow === "ask") {
      current.askSourceAttribution = true;
      for (const source of event.personalMemorySources ?? []) {
        if (!current.personalMemorySources.has(source.id)) {
          current.personalMemorySources.set(source.id, clonePersonalMemorySource(source));
        }
      }
    }
    grouped.set(key, current);
  }

  return Array.from(grouped.values()).map((item) => ({
    piSessionId: item.piSessionId,
    ...(item.entryId ? { entryId: item.entryId } : {}),
    ...(item.toolCallId ? { toolCallId: item.toolCallId } : {}),
    ...(item.references.size
      ? { knowledgeReferences: Array.from(item.references.values()).map(cloneAndFreezeReference) }
      : {}),
    ...(item.producedPaths.length
      ? { knowledgeProducedPaths: [...item.producedPaths] }
      : {}),
    ...(item.askSourceAttribution
      ? {
          askSourceAttribution: true as const,
          personalMemorySources: Array.from(item.personalMemorySources.values())
            .map(clonePersonalMemorySource)
        }
      : {})
  }));
}

export function knowledgeUsageMessageData(value: unknown): KnowledgeUsageMessageData {
  if (!value || typeof value !== "object") {
    return {
      askSourceAttribution: false,
      references: [],
      producedPaths: [],
      personalMemorySources: []
    };
  }
  const record = value as Record<string, unknown>;
  const askSourceAttribution = record.askSourceAttribution === true;
  const references: KnowledgeReference[] = [];
  if (Array.isArray(record.knowledgeReferences)) {
    for (const candidate of record.knowledgeReferences) {
      try {
        references.push(cloneAndFreezeReference(
          normalizeKnowledgeReference(candidate, "invalid-input")
        ));
      } catch {
        // Malformed product metadata never becomes a visible citation.
      }
    }
  }
  const personalMemorySources: PersonalMemorySourceReference[] = [];
  if (askSourceAttribution && Array.isArray(record.personalMemorySources)) {
    for (const candidate of record.personalMemorySources) {
      try {
        personalMemorySources.push(clonePersonalMemorySource(
          normalizePersonalMemorySource(candidate, "invalid-input")
        ));
      } catch {
        // Malformed source metadata never becomes a visible Memory source.
      }
    }
  }
  const producedPaths: string[] = [];
  if (Array.isArray(record.knowledgeProducedPaths)) {
    for (const candidate of record.knowledgeProducedPaths) {
      try {
        producedPaths.push(normalizeVaultRelativePath(candidate, "producedPath"));
      } catch {
        // Malformed product metadata never becomes an openable path.
      }
    }
  }
  return {
    askSourceAttribution,
    references: uniqueReferences(references),
    producedPaths: uniqueStrings(producedPaths),
    personalMemorySources: uniquePersonalMemorySources(personalMemorySources)
  };
}

export function mergeKnowledgeUsageMessageData(
  values: readonly unknown[]
): KnowledgeUsageMessageData {
  const references = new Map<string, KnowledgeReference>();
  const producedPaths: string[] = [];
  const personalMemorySources = new Map<string, PersonalMemorySourceReference>();
  let askSourceAttribution = false;
  for (const value of values) {
    const data = knowledgeUsageMessageData(value);
    for (const reference of data.references) {
      references.set(reference.referenceId, reference);
    }
    producedPaths.push(...data.producedPaths);
    if (data.askSourceAttribution) {
      askSourceAttribution = true;
      for (const source of data.personalMemorySources) {
        if (!personalMemorySources.has(source.id)) {
          personalMemorySources.set(source.id, clonePersonalMemorySource(source));
        }
      }
    }
  }
  return {
    askSourceAttribution,
    references: Array.from(references.values()),
    producedPaths: uniqueStrings(producedPaths),
    personalMemorySources: Array.from(personalMemorySources.values())
      .map(clonePersonalMemorySource)
  };
}

function committedEntryIndex(
  entries: readonly KnowledgeUsagePiEntryView[],
  entryId: string
): number {
  return entries.findIndex((entry) =>
    entry.type === "message"
    && entry.id === entryId
    && (entry.message?.role === "assistant" || entry.message?.role === "toolResult")
  );
}

function referenceRegistry(
  entries: readonly KnowledgeUsagePiEntryView[],
  throughIndex: number
): Map<string, KnowledgeReference> {
  const references = new Map<string, KnowledgeReference>();
  for (let index = 0; index <= throughIndex; index += 1) {
    const entry = entries[index];
    const details = entry.type === "custom_message"
      ? entry.details
      : entry.type === "message" && entry.message?.role === "toolResult"
        ? entry.message.details
        : undefined;
    for (const reference of referencesFromDetails(details)) {
      references.set(reference.referenceId, reference);
    }
  }
  return references;
}

function referencesFromDetails(value: unknown): KnowledgeReference[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const object = value as Record<string, unknown>;
  if (
    object.type !== KNOWLEDGE_REFERENCE_ENTRY_DETAILS_TYPE
    || object.schemaVersion !== 1
    || !Array.isArray(object.references)
  ) return [];
  const references: KnowledgeReference[] = [];
  for (const candidate of object.references) {
    try {
      references.push(normalizeKnowledgeReference(candidate, "store-corrupt"));
    } catch {
      return [];
    }
  }
  return uniqueReferences(references);
}

function normalizeKnowledgeUsageEvent(
  value: unknown,
  errorCode: "invalid-input" | "store-corrupt"
): KnowledgeUsageEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PiNativeFileStoreError(errorCode, "KnowledgeUsageEvent 必须是对象");
  }
  const object = value as Record<string, unknown>;
  const hasPersonalMemorySources = Object.hasOwn(
    object,
    "personalMemorySources"
  );
  assertExactKeys(
    object,
    hasPersonalMemorySources ? EVENT_KEYS : LEGACY_EVENT_KEYS,
    "KnowledgeUsageEvent",
    errorCode
  );
  const workflow = requireUsageString(object.workflow, "workflow", errorCode) as KnowledgeUsageWorkflow;
  if (!WORKFLOWS.has(workflow)) {
    throw new PiNativeFileStoreError(errorCode, `未知 Knowledge workflow：${workflow}`);
  }
  const referenceIds = normalizeStringArray(object.referenceIds, "referenceIds", errorCode);
  const producedPaths = normalizeStringArray(object.producedPaths, "producedPaths", errorCode)
    .map((item) => normalizeVaultRelativePath(item, "producedPath"));
  const personalMemorySources = hasPersonalMemorySources
    ? normalizePersonalMemorySources(object.personalMemorySources, errorCode)
    : undefined;
  if (workflow !== "ask" && personalMemorySources !== undefined) {
    throw new PiNativeFileStoreError(
      errorCode,
      "只有 /ask 可以记录 Personal Memory 来源"
    );
  }
  if (
    workflow !== "ask"
    && referenceIds.length === 0
    && producedPaths.length === 0
  ) {
    throw new PiNativeFileStoreError(
      errorCode,
      "KnowledgeUsageEvent 必须包含实际引用或产物指针"
    );
  }
  return {
    sourceEventId: requireUsageString(object.sourceEventId, "sourceEventId", errorCode),
    vaultId: requireUsageString(object.vaultId, "vaultId", errorCode),
    conversationId: requireUsageString(object.conversationId, "conversationId", errorCode),
    piSessionId: requireUsageString(object.piSessionId, "piSessionId", errorCode),
    piEntryId: requireUsageString(object.piEntryId, "piEntryId", errorCode),
    productRunId: requireUsageString(object.productRunId, "productRunId", errorCode),
    referenceIds: uniqueStrings(referenceIds),
    workflow,
    producedPaths: uniqueStrings(producedPaths),
    ...(personalMemorySources === undefined
      ? {}
      : { personalMemorySources })
  };
}

function parseKnowledgeUsageDocument(
  value: unknown,
  expectedVaultId: string
): KnowledgeUsageDocumentV1 {
  const object = requirePlainObject(value, "KnowledgeUsageEvent document");
  requireExactKeys(object, ["schemaVersion", "vaultId", "event"], [], "KnowledgeUsageEvent document");
  if (object.schemaVersion !== PI_NATIVE_FILE_SCHEMA_VERSION || object.vaultId !== expectedVaultId) {
    throw new PiNativeFileStoreError("store-corrupt", "KnowledgeUsageEvent document 版本或 Vault 不匹配");
  }
  const event = normalizeKnowledgeUsageEvent(object.event, "store-corrupt");
  if (event.vaultId !== expectedVaultId) {
    throw new PiNativeFileStoreError("store-corrupt", "KnowledgeUsageEvent 内外 Vault 不匹配");
  }
  return { schemaVersion: PI_NATIVE_FILE_SCHEMA_VERSION, vaultId: expectedVaultId, event };
}

function normalizeKnowledgeReference(
  value: unknown,
  errorCode: "invalid-input" | "store-corrupt"
): KnowledgeReference {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PiNativeFileStoreError(errorCode, "KnowledgeReference 必须是对象");
  }
  const object = value as Record<string, unknown>;
  assertExactKeys(
    object,
    REFERENCE_KEYS,
    "KnowledgeReference",
    errorCode,
    OPTIONAL_REFERENCE_KEYS
  );
  const lineStart = object.lineStart;
  const lineEnd = object.lineEnd;
  if (
    !Number.isSafeInteger(lineStart)
    || !Number.isSafeInteger(lineEnd)
    || (lineStart as number) < 1
    || (lineEnd as number) < (lineStart as number)
  ) throw new PiNativeFileStoreError(errorCode, "KnowledgeReference 行号无效");
  const contentRevision = requireUsageString(object.contentRevision, "contentRevision", errorCode);
  if (!/^sha256:[a-f0-9]{64}$/u.test(contentRevision)) {
    throw new PiNativeFileStoreError(errorCode, "KnowledgeReference contentRevision 无效");
  }
  const hasSourceType = Object.hasOwn(object, "sourceType");
  if (
    hasSourceType
    && object.sourceType !== "wiki"
    && object.sourceType !== "projects"
    && object.sourceType !== "raw"
  ) {
    throw new PiNativeFileStoreError(errorCode, "KnowledgeReference sourceType 无效");
  }
  const hasRecordedAt = Object.hasOwn(object, "recordedAt");
  if (
    hasRecordedAt
    && (
      typeof object.recordedAt !== "number"
      || !Number.isFinite(object.recordedAt)
      || object.recordedAt < 0
    )
  ) {
    throw new PiNativeFileStoreError(errorCode, "KnowledgeReference recordedAt 无效");
  }
  const hasPublishedAt = Object.hasOwn(object, "publishedAt");
  if (
    hasPublishedAt
    && (
      typeof object.publishedAt !== "string"
      || object.publishedAt.length > 100
      || /[\r\n]/u.test(object.publishedAt)
    )
  ) {
    throw new PiNativeFileStoreError(errorCode, "KnowledgeReference publishedAt 无效");
  }
  const hasVerificationStatus = Object.hasOwn(object, "verificationStatus");
  if (
    hasVerificationStatus
    && object.verificationStatus !== "local_revision_verified"
    && object.verificationStatus !== "source_link_changed"
  ) {
    throw new PiNativeFileStoreError(
      errorCode,
      "KnowledgeReference verificationStatus 无效"
    );
  }
  return {
    referenceId: requireUsageString(object.referenceId, "referenceId", errorCode),
    vaultRelativePath: normalizeVaultRelativePath(object.vaultRelativePath, "vaultRelativePath"),
    title: requireUsageString(object.title, "title", errorCode),
    excerpt: typeof object.excerpt === "string"
      ? object.excerpt
      : (() => { throw new PiNativeFileStoreError(errorCode, "KnowledgeReference excerpt 无效"); })(),
    contentRevision,
    lineStart: lineStart as number,
    lineEnd: lineEnd as number,
    ...(Number.isSafeInteger(object.totalLines) && (object.totalLines as number) >= (lineEnd as number) ? { totalLines: object.totalLines as number } : {}),
    ...(typeof object.hasMore === "boolean" ? { hasMore: object.hasMore } : {}),
    // Relation hints stay in the delivered resource; Sources store body ranges only.
    ...(hasSourceType
      ? { sourceType: object.sourceType as KnowledgeReference["sourceType"] }
      : {}),
    ...(hasRecordedAt
      ? { recordedAt: object.recordedAt as number }
      : {}),
    ...(hasPublishedAt
      ? { publishedAt: object.publishedAt as string }
      : {}),
    ...(hasVerificationStatus
      ? {
          verificationStatus:
            object.verificationStatus as KnowledgeReference["verificationStatus"]
        }
      : {})
  };
}

function normalizePersonalMemorySources(
  value: unknown,
  errorCode: "invalid-input" | "store-corrupt"
): PersonalMemorySourceReference[] {
  if (!Array.isArray(value)) {
    throw new PiNativeFileStoreError(errorCode, "personalMemorySources 必须是数组");
  }
  return uniquePersonalMemorySources(value.map((source) =>
    normalizePersonalMemorySource(source, errorCode)
  ));
}

function normalizePersonalMemorySource(
  value: unknown,
  errorCode: "invalid-input" | "store-corrupt"
): PersonalMemorySourceReference {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PiNativeFileStoreError(errorCode, "Personal Memory 来源必须是对象");
  }
  const object = value as Record<string, unknown>;
  assertExactKeys(
    object,
    PERSONAL_MEMORY_SOURCE_KEYS,
    "Personal Memory 来源",
    errorCode
  );
  return {
    id: requireUsageString(object.id, "Personal Memory 来源 id", errorCode),
    title: requireUsageString(object.title, "Personal Memory 来源 title", errorCode)
  };
}

function normalizeVaultRelativePath(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) {
    throw new PiNativeFileStoreError("invalid-input", `${label} 必须是 Vault 相对路径`);
  }
  const slashed = value.trim().replace(/\\/gu, "/");
  const normalized = path.posix.normalize(slashed);
  if (
    path.posix.isAbsolute(normalized)
    || normalized === "."
    || normalized === ".."
    || normalized.startsWith("../")
  ) throw new PiNativeFileStoreError("invalid-input", `${label} 不能越过 Vault`);
  return normalized;
}

function normalizeStringArray(
  value: unknown,
  label: string,
  errorCode: "invalid-input" | "store-corrupt"
): string[] {
  if (!Array.isArray(value)) {
    throw new PiNativeFileStoreError(errorCode, `${label} 必须是数组`);
  }
  return value.map((item, index) => requireUsageString(item, `${label}[${index}]`, errorCode));
}

function requireUsageString(
  value: unknown,
  label: string,
  errorCode: "invalid-input" | "store-corrupt"
): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new PiNativeFileStoreError(errorCode, `${label} 必须是非空字符串`);
  }
  return value;
}

function assertExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
  errorCode: "invalid-input" | "store-corrupt",
  optionalKeys: readonly string[] = []
): void {
  const expected = new Set([...keys, ...optionalKeys]);
  if (
    keys.some((key) => !Object.prototype.hasOwnProperty.call(value, key))
    || Object.keys(value).some((key) => !expected.has(key))
  ) throw new PiNativeFileStoreError(errorCode, `${label} 字段集合无效`);
}

function visibleIdentity(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function uniqueStrings(values: readonly string[]): string[] {
  return Array.from(new Set(values));
}

function uniqueReferences(values: readonly KnowledgeReference[]): KnowledgeReference[] {
  return Array.from(new Map(values.map((item) => [item.referenceId, item])).values());
}

function uniquePersonalMemorySources(
  values: readonly PersonalMemorySourceReference[]
): PersonalMemorySourceReference[] {
  const unique = new Map<string, PersonalMemorySourceReference>();
  for (const item of values) {
    if (!unique.has(item.id)) unique.set(item.id, item);
  }
  return Array.from(unique.values());
}

function cloneAndFreezeReference(reference: KnowledgeReference): KnowledgeReference {
  return Object.freeze({ ...reference });
}

function clonePersonalMemorySource(
  source: PersonalMemorySourceReference
): PersonalMemorySourceReference {
  return Object.freeze({ ...source });
}

function cloneAndFreezeEvent(event: Readonly<KnowledgeUsageEvent>): Readonly<KnowledgeUsageEvent> {
  return Object.freeze({
    ...event,
    referenceIds: Object.freeze([...event.referenceIds]) as unknown as string[],
    producedPaths: Object.freeze([...event.producedPaths]) as unknown as string[],
    ...(event.personalMemorySources === undefined
      ? {}
      : {
          personalMemorySources: Object.freeze(
            event.personalMemorySources.map(clonePersonalMemorySource)
          ) as unknown as PersonalMemorySourceReference[]
        })
  });
}
