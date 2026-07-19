import { createHash } from "node:crypto";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import {
  assertDurableDirectoryStat,
  assertDurableRegularFileStat,
  durableAppendOnlyChainPath,
  durableLstatOrNull,
  DurableAppendOnlyCasError,
  publishDurableAppendOnlyChain,
  readDurableRegularFile,
  resolveDurableAppendOnlyLayout,
  resolveDurablePlainRoot,
  type DurableAppendOnlyFaultPoint,
  type DurableAppendOnlyLayout
} from "./durable-append-only-cas";

const ROOT_REGISTRY_SCHEMA_VERSION = 1;
const ROOT_REGISTRY_NAMESPACE = "record-root-bindings";
const ENTRY_PREFIX = "binding-";
const ENTRY_WIDTH = 12;
const ENTRY_PATTERN = /^binding-([0-9]{12})\.json$/;
const SAFE_ROOT_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:@-]{0,127}$/;
const SAFE_REGISTRY_ID = /^registry-[a-f0-9]{24}$/;
const SAFE_CHAIN_TOKEN = /^root-[a-f0-9]{24}$/;
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const MAX_BINDING_BYTES = 64 * 1024;
const MAX_BINDING_REVISIONS = 128;
const recordRootRegistryLaneTails = new Map<string, Promise<void>>();

export type RecordRootAuthority = "plugin-owned" | "vault-managed";

export interface RecordRootFileIdentity {
  dev: number;
  ino: number;
}

export interface RecordRootBinding {
  schemaVersion: typeof ROOT_REGISTRY_SCHEMA_VERSION;
  kind: "record-root-binding";
  registryId: string;
  rootId: string;
  authority: RecordRootAuthority;
  boundaryPathDigest: string;
  rootPathDigest: string;
  rootIdentity: RecordRootFileIdentity;
  revision: number;
  previousRevision: number | null;
  previousDigest: string | null;
  createdAt: number;
  updatedAt: number;
  digest: string;
}

export interface RecordRootBindingRef {
  registryId: string;
  rootId: string;
  authority: RecordRootAuthority;
  boundaryPathDigest: string;
  rootPathDigest: string;
  rootIdentity: RecordRootFileIdentity;
  revision: number;
  digest: string;
}

export interface RecordRootBindingHandle {
  storageRootPath: string;
  registryId: string;
  rootId: string;
  chainToken: string;
}

export interface LoadedRecordRootBinding {
  handle: RecordRootBindingHandle;
  binding: RecordRootBinding;
}

export type RecordRootRegistryErrorCode =
  | "invalid_path"
  | "unsafe_entry"
  | "missing"
  | "registry_conflict"
  | "binding_mismatch"
  | "registry_corrupt"
  | "future_schema";

export class RecordRootRegistryError extends Error {
  constructor(
    public readonly code: RecordRootRegistryErrorCode,
    message: string
  ) {
    super(message);
    this.name = "RecordRootRegistryError";
  }
}

export const RECORD_ROOT_REGISTRY_NODE_THREAT_BOUNDARY =
  "canonical-plugin-owned-roots-with-cooperative-writers" as const;

export async function createOrLoadRecordRootBinding(input: {
  storageRootPath: string;
  rootId: string;
  rootPath: string;
  boundaryRootPath: string;
  authority: RecordRootAuthority;
  createdAt: number;
  faultInjector?: (
    point: DurableAppendOnlyFaultPoint
  ) => void | Promise<void>;
}): Promise<LoadedRecordRootBinding> {
  try {
    const rootId = requireRootId(input.rootId);
    const storageRootPath = await resolveDurablePlainRoot(
      input.storageRootPath,
      "Record Root Registry storage root"
    );
    const laneKey = `${storageRootPath}\0${rootId}`;
    return await withRecordRootRegistryLane(
      laneKey,
      async () => await createOrLoadRecordRootBindingUnlocked({
        ...input,
        storageRootPath,
        rootId
      })
    );
  } catch (error) {
    throw mapRegistryError(error);
  }
}

async function createOrLoadRecordRootBindingUnlocked(input: {
  storageRootPath: string;
  rootId: string;
  rootPath: string;
  boundaryRootPath: string;
  authority: RecordRootAuthority;
  createdAt: number;
  faultInjector?: (
    point: DurableAppendOnlyFaultPoint
  ) => void | Promise<void>;
}): Promise<LoadedRecordRootBinding> {
  try {
    const prepared = await prepareBindingCandidate(input);
    const layout = await resolveDurableAppendOnlyLayout(
      prepared.storageRootPath,
      ROOT_REGISTRY_NAMESPACE,
      true
    );
    if (!layout) {
      throw new RecordRootRegistryError(
        "registry_corrupt",
        "Record Root Registry 无法创建 namespace"
      );
    }
    const handle = bindingHandle(
      layout,
      prepared.registryId,
      prepared.rootId
    );
    const existing = await loadBindingFromLayout(layout, handle);
    if (existing) {
      assertSamePhysicalBinding(existing.binding, prepared.binding);
      return existing;
    }
    try {
      await publishDurableAppendOnlyChain(
        layout,
        handle.chainToken,
        bindingEntryName(0),
        bindingBytes(prepared.binding),
        {
          maxBytes: MAX_BINDING_BYTES,
          faultInjector: input.faultInjector
        }
      );
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
    }
    const readback = await loadBindingFromLayout(layout, handle);
    if (!readback) {
      throw new RecordRootRegistryError(
        "registry_corrupt",
        "Record Root Registry publish 后缺少 binding"
      );
    }
    assertSamePhysicalBinding(readback.binding, prepared.binding);
    return readback;
  } catch (error) {
    throw mapRegistryError(error);
  }
}

export async function loadRecordRootBinding(input: {
  storageRootPath: string;
  rootId: string;
}): Promise<LoadedRecordRootBinding | null> {
  try {
    const rootId = requireRootId(input.rootId);
    const storageRootPath = await resolveDurablePlainRoot(
      input.storageRootPath,
      "Record Root Registry storage root"
    );
    const registryId = await registryIdentity(storageRootPath);
    const layout = await resolveDurableAppendOnlyLayout(
      storageRootPath,
      ROOT_REGISTRY_NAMESPACE,
      false
    );
    if (!layout) return null;
    return await loadBindingFromLayout(
      layout,
      bindingHandle(layout, registryId, rootId)
    );
  } catch (error) {
    throw mapRegistryError(error);
  }
}

export async function verifyRecordRootBinding(
  bindingInput: RecordRootBinding,
  input: {
    storageRootPath: string;
    rootPath: string;
    boundaryRootPath: string;
  }
): Promise<string> {
  try {
    const binding = parseRecordRootBinding(bindingInput);
    const storageRootPath = await resolveDurablePlainRoot(
      input.storageRootPath,
      "Record Root Registry storage root"
    );
    const registryId = await registryIdentity(storageRootPath);
    const layout = await resolveDurableAppendOnlyLayout(
      storageRootPath,
      ROOT_REGISTRY_NAMESPACE,
      false
    );
    const current = layout
      ? await loadBindingFromLayout(
        layout,
        bindingHandle(layout, registryId, binding.rootId)
      )
      : null;
    if (
      !current
      || current.binding.revision !== binding.revision
      || current.binding.digest !== binding.digest
    ) {
      throw new RecordRootRegistryError(
        "binding_mismatch",
        `Record root ${binding.rootId} 的 Registry authority 已缺失或变化`
      );
    }
    const physical = await resolvePhysicalBinding({
      storageRootPath,
      rootPath: input.rootPath,
      boundaryRootPath: input.boundaryRootPath,
      authority: binding.authority
    });
    if (
      binding.registryId !== registryId
      || binding.boundaryPathDigest !== physical.boundaryPathDigest
      || binding.rootPathDigest !== physical.rootPathDigest
      || binding.rootIdentity.dev !== physical.rootIdentity.dev
      || binding.rootIdentity.ino !== physical.rootIdentity.ino
    ) {
      throw new RecordRootRegistryError(
        "binding_mismatch",
        `Record root ${binding.rootId} 的物理 binding 已变化`
      );
    }
    return physical.rootPath;
  } catch (error) {
    if (
      error instanceof DurableAppendOnlyCasError
      && error.code === "missing"
    ) {
      throw new RecordRootRegistryError(
        "binding_mismatch",
        "Record root 或 owner boundary 已不存在"
      );
    }
    throw mapRegistryError(error);
  }
}

export async function verifyRecordRootBindingRef(
  bindingRefInput: RecordRootBindingRef,
  input: {
    storageRootPath: string;
    rootPath: string;
    boundaryRootPath: string;
  }
): Promise<LoadedRecordRootBinding> {
  const bindingRef = parseRecordRootBindingRef(bindingRefInput);
  const loaded = await loadRecordRootBinding({
    storageRootPath: input.storageRootPath,
    rootId: bindingRef.rootId
  });
  if (
    !loaded
    || !sameRecordRootBindingRef(
      bindingRef,
      recordRootBindingRef(loaded.binding)
    )
  ) {
    throw new RecordRootRegistryError(
      "binding_mismatch",
      `Record root ${bindingRef.rootId} 的 frozen binding ref 已变化`
    );
  }
  await verifyRecordRootBinding(loaded.binding, input);
  return loaded;
}

export function recordRootBindingRef(
  bindingInput: RecordRootBinding
): RecordRootBindingRef {
  const binding = parseRecordRootBinding(bindingInput);
  return parseRecordRootBindingRef({
    registryId: binding.registryId,
    rootId: binding.rootId,
    authority: binding.authority,
    boundaryPathDigest: binding.boundaryPathDigest,
    rootPathDigest: binding.rootPathDigest,
    rootIdentity: { ...binding.rootIdentity },
    revision: binding.revision,
    digest: binding.digest
  });
}

export function parseRecordRootBindingRef(
  value: unknown
): RecordRootBindingRef {
  const record = requirePlainRecord(value, "record root binding ref");
  assertExactKeys(record, [
    "registryId",
    "rootId",
    "authority",
    "boundaryPathDigest",
    "rootPathDigest",
    "rootIdentity",
    "revision",
    "digest"
  ], "record root binding ref");
  if (
    typeof record.registryId !== "string"
    || !SAFE_REGISTRY_ID.test(record.registryId)
  ) {
    throw registryCorrupt("Record Root Binding Ref registryId 非法");
  }
  const rootId = requireRootId(record.rootId);
  if (record.authority !== "plugin-owned" && record.authority !== "vault-managed") {
    throw registryCorrupt("Record Root Binding Ref authority 非法");
  }
  const identity = requirePlainRecord(
    record.rootIdentity,
    "record root binding ref rootIdentity"
  );
  assertExactKeys(
    identity,
    ["dev", "ino"],
    "record root binding ref rootIdentity"
  );
  return {
    registryId: record.registryId,
    rootId,
    authority: record.authority,
    boundaryPathDigest: requireDigest(
      record.boundaryPathDigest,
      "binding ref boundaryPathDigest"
    ),
    rootPathDigest: requireDigest(
      record.rootPathDigest,
      "binding ref rootPathDigest"
    ),
    rootIdentity: {
      dev: requireSafeInteger(identity.dev, "binding ref rootIdentity.dev", 0),
      ino: requireSafeInteger(identity.ino, "binding ref rootIdentity.ino", 1)
    },
    revision: requireSafeInteger(
      record.revision,
      "binding ref revision",
      0,
      MAX_BINDING_REVISIONS - 1
    ),
    digest: requireDigest(record.digest, "binding ref digest")
  };
}

export function sameRecordRootBindingRef(
  leftInput: RecordRootBindingRef,
  rightInput: RecordRootBindingRef
): boolean {
  const left = parseRecordRootBindingRef(leftInput);
  const right = parseRecordRootBindingRef(rightInput);
  return (
    left.registryId === right.registryId
    && left.rootId === right.rootId
    && left.authority === right.authority
    && left.boundaryPathDigest === right.boundaryPathDigest
    && left.rootPathDigest === right.rootPathDigest
    && left.rootIdentity.dev === right.rootIdentity.dev
    && left.rootIdentity.ino === right.rootIdentity.ino
    && left.revision === right.revision
    && left.digest === right.digest
  );
}

export function parseRecordRootBinding(value: unknown): RecordRootBinding {
  const record = requirePlainRecord(value, "record root binding");
  assertExactKeys(record, [
    "schemaVersion",
    "kind",
    "registryId",
    "rootId",
    "authority",
    "boundaryPathDigest",
    "rootPathDigest",
    "rootIdentity",
    "revision",
    "previousRevision",
    "previousDigest",
    "createdAt",
    "updatedAt",
    "digest"
  ], "record root binding");
  if (record.schemaVersion !== ROOT_REGISTRY_SCHEMA_VERSION) {
    if (
      Number.isSafeInteger(record.schemaVersion)
      && Number(record.schemaVersion) > ROOT_REGISTRY_SCHEMA_VERSION
    ) {
      throw new RecordRootRegistryError(
        "future_schema",
        `Record Root Registry future schema：${String(record.schemaVersion)}`
      );
    }
    throw registryCorrupt("Record Root Registry schemaVersion 非法");
  }
  if (record.kind !== "record-root-binding") {
    throw registryCorrupt("Record Root Registry kind 非法");
  }
  if (
    typeof record.registryId !== "string"
    || !SAFE_REGISTRY_ID.test(record.registryId)
  ) {
    throw registryCorrupt("Record Root Registry registryId 非法");
  }
  const rootId = requireRootId(record.rootId);
  if (record.authority !== "plugin-owned" && record.authority !== "vault-managed") {
    throw registryCorrupt("Record Root Registry authority 非法");
  }
  const boundaryPathDigest = requireDigest(
    record.boundaryPathDigest,
    "boundaryPathDigest"
  );
  const rootPathDigest = requireDigest(record.rootPathDigest, "rootPathDigest");
  const identity = requirePlainRecord(record.rootIdentity, "rootIdentity");
  assertExactKeys(identity, ["dev", "ino"], "rootIdentity");
  const rootIdentity = {
    dev: requireSafeInteger(identity.dev, "rootIdentity.dev", 0),
    ino: requireSafeInteger(identity.ino, "rootIdentity.ino", 1)
  };
  const revision = requireSafeInteger(
    record.revision,
    "revision",
    0,
    MAX_BINDING_REVISIONS - 1
  );
  const previousRevision = record.previousRevision === null
    ? null
    : requireSafeInteger(
      record.previousRevision,
      "previousRevision",
      0,
      MAX_BINDING_REVISIONS - 1
    );
  const previousDigest = record.previousDigest === null
    ? null
    : requireDigest(record.previousDigest, "previousDigest");
  const createdAt = requireSafeInteger(record.createdAt, "createdAt", 0);
  const updatedAt = requireSafeInteger(record.updatedAt, "updatedAt", createdAt);
  const digest = requireDigest(record.digest, "digest");
  if (
    (revision === 0 && (previousRevision !== null || previousDigest !== null))
    || (
      revision > 0
      && (
        previousRevision !== revision - 1
        || previousDigest === null
        || updatedAt <= createdAt
      )
    )
  ) {
    throw registryCorrupt("Record Root Registry revision 前序字段非法");
  }
  const parsed: RecordRootBinding = {
    schemaVersion: ROOT_REGISTRY_SCHEMA_VERSION,
    kind: "record-root-binding",
    registryId: record.registryId,
    rootId,
    authority: record.authority,
    boundaryPathDigest,
    rootPathDigest,
    rootIdentity,
    revision,
    previousRevision,
    previousDigest,
    createdAt,
    updatedAt,
    digest
  };
  const { digest: _digest, ...withoutDigest } = parsed;
  if (digest !== bindingDigest(withoutDigest)) {
    throw registryCorrupt("Record Root Registry digest 不匹配");
  }
  return parsed;
}

async function prepareBindingCandidate(input: {
  storageRootPath: string;
  rootId: string;
  rootPath: string;
  boundaryRootPath: string;
  authority: RecordRootAuthority;
  createdAt: number;
}): Promise<{
  storageRootPath: string;
  registryId: string;
  rootId: string;
  binding: RecordRootBinding;
}> {
  const rootId = requireRootId(input.rootId);
  const createdAt = requireSafeInteger(input.createdAt, "createdAt", 0);
  if (input.authority !== "plugin-owned" && input.authority !== "vault-managed") {
    throw new RecordRootRegistryError(
      "invalid_path",
      "Record root authority 非法"
    );
  }
  const storageRootPath = await resolveDurablePlainRoot(
    input.storageRootPath,
    "Record Root Registry storage root"
  );
  const registryId = await registryIdentity(storageRootPath);
  const physical = await resolvePhysicalBinding({
    storageRootPath,
    rootPath: input.rootPath,
    boundaryRootPath: input.boundaryRootPath,
    authority: input.authority
  });
  const draft: Omit<RecordRootBinding, "digest"> = {
    schemaVersion: ROOT_REGISTRY_SCHEMA_VERSION,
    kind: "record-root-binding",
    registryId,
    rootId,
    authority: input.authority,
    boundaryPathDigest: physical.boundaryPathDigest,
    rootPathDigest: physical.rootPathDigest,
    rootIdentity: physical.rootIdentity,
    revision: 0,
    previousRevision: null,
    previousDigest: null,
    createdAt,
    updatedAt: createdAt
  };
  return {
    storageRootPath,
    registryId,
    rootId,
    binding: parseRecordRootBinding({
      ...draft,
      digest: bindingDigest(draft)
    })
  };
}

async function resolvePhysicalBinding(input: {
  storageRootPath: string;
  rootPath: string;
  boundaryRootPath: string;
  authority: RecordRootAuthority;
}): Promise<{
  rootPath: string;
  boundaryPathDigest: string;
  rootPathDigest: string;
  rootIdentity: RecordRootFileIdentity;
}> {
  const boundaryRootPath = await resolveDurablePlainRoot(
    input.boundaryRootPath,
    "Record root owner boundary"
  );
  const rootPath = await resolveDurablePlainRoot(
    input.rootPath,
    "Record root"
  );
  if (
    input.authority === "plugin-owned"
    && boundaryRootPath !== input.storageRootPath
  ) {
    throw new RecordRootRegistryError(
      "invalid_path",
      "plugin-owned root 的 owner boundary 必须是 registry storage root"
    );
  }
  if (!isStrictDescendant(boundaryRootPath, rootPath)) {
    throw new RecordRootRegistryError(
      "invalid_path",
      "Record root 必须严格位于 owner boundary 内"
    );
  }
  const rootStat = await fsp.lstat(rootPath);
  assertDurableDirectoryStat(rootStat, "Record root");
  return {
    rootPath,
    boundaryPathDigest: pathDigest(boundaryRootPath),
    rootPathDigest: pathDigest(rootPath),
    rootIdentity: {
      dev: Number(rootStat.dev),
      ino: Number(rootStat.ino)
    }
  };
}

async function loadBindingFromLayout(
  layout: DurableAppendOnlyLayout,
  handle: RecordRootBindingHandle
): Promise<LoadedRecordRootBinding | null> {
  const chainRootPath = durableAppendOnlyChainPath(
    layout,
    handle.chainToken
  );
  const chainStat = await durableLstatOrNull(chainRootPath);
  if (!chainStat) return null;
  assertDurableDirectoryStat(chainStat, "Record Root Registry chain");
  const entries = await fsp.readdir(chainRootPath, { withFileTypes: true });
  if (!entries.length) return null;
  if (entries.length > MAX_BINDING_REVISIONS) {
    throw registryCorrupt("Record Root Registry revision 数量非法");
  }
  const ordered = entries.map((entry) => {
    const match = ENTRY_PATTERN.exec(entry.name);
    if (!match || !entry.isFile() || entry.isSymbolicLink()) {
      throw registryCorrupt(
        `Record Root Registry 含 unknown/unsafe entry：${entry.name}`
      );
    }
    return {
      name: entry.name,
      revision: Number(match[1])
    };
  }).sort((left, right) => left.revision - right.revision);
  const chain: RecordRootBinding[] = [];
  for (let index = 0; index < ordered.length; index += 1) {
    const entry = ordered[index];
    if (
      entry.revision !== index
      || entry.name !== bindingEntryName(index)
    ) {
      throw registryCorrupt(
        "Record Root Registry revision chain 不连续"
      );
    }
    const entryPath = path.join(chainRootPath, entry.name);
    const entryStat = await fsp.lstat(entryPath);
    assertDurableRegularFileStat(
      entryStat,
      "Record Root Registry binding",
      [1, 2]
    );
    const bytes = (
      await readDurableRegularFile(
        entryPath,
        MAX_BINDING_BYTES,
        [1, 2]
      )
    ).content;
    const binding = parseRecordRootBinding(parseJson(bytes));
    if (
      binding.registryId !== handle.registryId
      || binding.rootId !== handle.rootId
      || binding.revision !== entry.revision
      || chainToken(binding.rootId) !== handle.chainToken
    ) {
      throw registryCorrupt(
        "Record Root Registry binding identity 与目录不匹配"
      );
    }
    if (chain.length) {
      const previous = chain[chain.length - 1];
      if (
        binding.previousRevision !== previous.revision
        || binding.previousDigest !== previous.digest
        || binding.createdAt !== previous.createdAt
        || binding.updatedAt <= previous.updatedAt
        || binding.authority !== previous.authority
        || binding.boundaryPathDigest !== previous.boundaryPathDigest
        || binding.rootPathDigest !== previous.rootPathDigest
        || binding.rootIdentity.dev !== previous.rootIdentity.dev
        || binding.rootIdentity.ino !== previous.rootIdentity.ino
      ) {
        throw registryCorrupt(
          "Record Root Registry append-only chain 损坏或 immutable binding 被换绑"
        );
      }
    }
    chain.push(binding);
  }
  return {
    handle,
    binding: chain[chain.length - 1]
  };
}

function bindingHandle(
  layout: DurableAppendOnlyLayout,
  registryId: string,
  rootId: string
): RecordRootBindingHandle {
  if (!SAFE_REGISTRY_ID.test(registryId)) {
    throw registryCorrupt("Record Root Registry registryId 非法");
  }
  return {
    storageRootPath: layout.storageRootPath,
    registryId,
    rootId,
    chainToken: chainToken(rootId)
  };
}

function assertSamePhysicalBinding(
  currentInput: RecordRootBinding,
  candidateInput: RecordRootBinding
): void {
  const current = parseRecordRootBinding(currentInput);
  const candidate = parseRecordRootBinding(candidateInput);
  if (
    current.registryId !== candidate.registryId
    || current.rootId !== candidate.rootId
    || current.authority !== candidate.authority
    || current.boundaryPathDigest !== candidate.boundaryPathDigest
    || current.rootPathDigest !== candidate.rootPathDigest
    || current.rootIdentity.dev !== candidate.rootIdentity.dev
    || current.rootIdentity.ino !== candidate.rootIdentity.ino
  ) {
    throw new RecordRootRegistryError(
      "registry_conflict",
      `Record root ${candidate.rootId} 已绑定到不同物理目录`
    );
  }
}

async function registryIdentity(storageRootPath: string): Promise<string> {
  const stat = await fsp.lstat(storageRootPath);
  assertDurableDirectoryStat(stat, "Record Root Registry storage root");
  const digest = sha256(stableStringify({
    namespace: "echoink.record-root-registry",
    storagePathDigest: pathDigest(storageRootPath),
    dev: Number(stat.dev),
    ino: Number(stat.ino)
  }));
  return `registry-${digest.slice("sha256:".length, "sha256:".length + 24)}`;
}

function chainToken(rootId: string): string {
  const token = `root-${sha256(rootId).slice("sha256:".length, "sha256:".length + 24)}`;
  if (!SAFE_CHAIN_TOKEN.test(token)) {
    throw registryCorrupt("Record Root Registry chain token 非法");
  }
  return token;
}

function bindingEntryName(revision: number): string {
  if (
    !Number.isSafeInteger(revision)
    || revision < 0
    || revision >= MAX_BINDING_REVISIONS
  ) {
    throw registryCorrupt("Record Root Registry revision 越界");
  }
  return `${ENTRY_PREFIX}${String(revision).padStart(ENTRY_WIDTH, "0")}.json`;
}

function bindingBytes(binding: RecordRootBinding): Buffer {
  const bytes = Buffer.from(`${stableStringify(binding)}\n`, "utf8");
  if (bytes.byteLength > MAX_BINDING_BYTES) {
    throw registryCorrupt("Record Root Registry binding 超过大小上限");
  }
  return bytes;
}

function bindingDigest(value: unknown): string {
  return sha256(stableStringify(value));
}

function pathDigest(absolutePath: string): string {
  return sha256(path.resolve(absolutePath).normalize("NFC"));
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

function parseJson(bytes: Buffer): unknown {
  try {
    return JSON.parse(bytes.toString("utf8")) as unknown;
  } catch (error) {
    throw registryCorrupt(
      `Record Root Registry JSON 无法解析：${errorMessage(error)}`
    );
  }
}

function requirePlainRecord(
  value: unknown,
  label: string
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw registryCorrupt(`${label} 不是对象`);
  }
  const prototype = Reflect.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw registryCorrupt(`${label} 不是 plain object`);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
  label: string
): void {
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (
    actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])
  ) {
    throw registryCorrupt(`${label} 字段集合非法`);
  }
}

function requireRootId(value: unknown): string {
  if (
    typeof value !== "string"
    || !SAFE_ROOT_ID.test(value)
    || value !== value.normalize("NFC")
  ) {
    throw new RecordRootRegistryError(
      "invalid_path",
      "Record rootId 非法"
    );
  }
  return value;
}

function requireDigest(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw registryCorrupt(`${label} 非法`);
  }
  return value;
}

function requireSafeInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER
): number {
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value < minimum
    || value > maximum
  ) {
    throw registryCorrupt(`${label} 非法`);
  }
  return value;
}

function isStrictDescendant(rootPath: string, candidatePath: string): boolean {
  const relative = path.relative(rootPath, candidatePath);
  return (
    relative !== ""
    && relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

function mapRegistryError(error: unknown): Error {
  if (error instanceof RecordRootRegistryError) return error;
  if (error instanceof DurableAppendOnlyCasError) {
    const code: RecordRootRegistryErrorCode = error.code === "invalid_path"
      ? "invalid_path"
      : error.code === "missing"
        ? "missing"
        : error.code === "already_exists"
          || error.code === "revision_conflict"
          ? "registry_conflict"
          : "unsafe_entry";
    return new RecordRootRegistryError(code, error.message);
  }
  return error instanceof Error
    ? error
    : new RecordRootRegistryError("registry_corrupt", errorMessage(error));
}

function isAlreadyExists(error: unknown): boolean {
  return (
    error instanceof DurableAppendOnlyCasError
    && error.code === "already_exists"
  );
}

function registryCorrupt(message: string): RecordRootRegistryError {
  return new RecordRootRegistryError("registry_corrupt", message);
}

async function withRecordRootRegistryLane<T>(
  key: string,
  action: () => Promise<T>
): Promise<T> {
  const previous = recordRootRegistryLaneTails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.catch(() => undefined).then(() => current);
  recordRootRegistryLaneTails.set(key, tail);
  await previous.catch(() => undefined);
  try {
    return await action();
  } finally {
    release();
    if (recordRootRegistryLaneTails.get(key) === tail) {
      recordRootRegistryLaneTails.delete(key);
    }
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error) || "unknown error";
  } catch {
    return "unknown error";
  }
}
