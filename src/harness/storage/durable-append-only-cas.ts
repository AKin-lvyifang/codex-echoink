import { randomUUID } from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";

const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024;
const SAFE_COMPONENT = /^[a-zA-Z0-9.][a-zA-Z0-9._-]{0,127}$/;
const SAFE_CHAIN_TOKEN = /^[a-z][a-z0-9-]{1,79}$/;

/**
 * Node does not expose fd-relative openat/unlinkat primitives. These helpers
 * therefore require canonical, plugin-owned roots and cooperative writers.
 * Identity checks detect drift, but do not claim syscall-level protection
 * against an external process swapping an ancestor in the final race window.
 */
export const DURABLE_APPEND_ONLY_NODE_THREAT_BOUNDARY =
  "canonical-plugin-owned-roots-with-cooperative-writers" as const;

export type DurableAppendOnlyCasErrorCode =
  | "invalid_path"
  | "unsafe_entry"
  | "already_exists"
  | "missing"
  | "revision_conflict"
  | "content_too_large";

export class DurableAppendOnlyCasError extends Error {
  constructor(
    public readonly code: DurableAppendOnlyCasErrorCode,
    message: string
  ) {
    super(message);
    this.name = "DurableAppendOnlyCasError";
  }
}

export type DurableAppendOnlyFaultPoint =
  | "after-staging-sync"
  | "after-chain-claim"
  | "after-publish";

export interface DurableFileIdentity {
  dev: number;
  ino: number;
}

export interface DurableFileSnapshot extends DurableFileIdentity {
  size: number;
  mode: number;
  nlink: number;
  mtimeMs: number;
  ctimeMs: number;
}

export interface DurableAppendOnlyLayout {
  storageRootPath: string;
  namespaceRootPath: string;
  stagingRootPath: string;
}

export interface DurableAppendOnlyPublishOptions {
  maxBytes?: number;
  faultInjector?: (
    point: DurableAppendOnlyFaultPoint
  ) => void | Promise<void>;
  preserveStagingOnError?: (error: unknown) => boolean;
}

export interface DurableReadResult {
  content: Buffer;
  snapshot: DurableFileSnapshot;
}

export async function resolveDurableAppendOnlyLayout(
  storageRootPathInput: string,
  namespaceName: string,
  create: boolean
): Promise<DurableAppendOnlyLayout | null> {
  if (!SAFE_COMPONENT.test(namespaceName)) {
    throw new DurableAppendOnlyCasError(
      "invalid_path",
      `append-only namespace 非法：${namespaceName}`
    );
  }
  const storageRootPath = await resolveDurablePlainRoot(
    storageRootPathInput,
    "append-only storage root"
  );
  const namespaceRootPath = await ensureDurableChildDirectory(
    storageRootPath,
    namespaceName,
    create
  );
  if (!namespaceRootPath) return null;
  const stagingRootPath = await ensureDurableChildDirectory(
    namespaceRootPath,
    ".staging",
    create
  );
  if (!stagingRootPath) {
    throw new DurableAppendOnlyCasError(
      "unsafe_entry",
      "append-only namespace 缺少 staging 目录"
    );
  }
  return { storageRootPath, namespaceRootPath, stagingRootPath };
}

export function durableAppendOnlyChainPath(
  layout: DurableAppendOnlyLayout,
  chainToken: string
): string {
  assertSafeChainToken(chainToken);
  return path.join(layout.namespaceRootPath, chainToken);
}

export async function publishDurableAppendOnlyChain(
  layout: DurableAppendOnlyLayout,
  chainToken: string,
  firstEntryName: string,
  content: Buffer,
  options: DurableAppendOnlyPublishOptions = {}
): Promise<{ chainRootPath: string; entryPath: string }> {
  assertSafeChainToken(chainToken);
  assertSafeComponent(firstEntryName, "append-only entry");
  const namespaceIdentity = await requireSafeDirectory(
    layout.namespaceRootPath,
    "append-only namespace"
  );
  const stagingRootIdentity = await requireSafeDirectory(
    layout.stagingRootPath,
    "append-only staging root"
  );
  const chainRootPath = durableAppendOnlyChainPath(layout, chainToken);
  await removeEmptyChainClaimOrThrow(
    layout.namespaceRootPath,
    chainRootPath,
    chainToken
  );

  const stagedRootPath = path.join(
    layout.stagingRootPath,
    `.create-${chainToken}-${randomUUID()}`
  );
  const stagedRootIdentity = await createExclusiveDirectory(
    stagedRootPath,
    layout.stagingRootPath
  );
  const stagedEntryPath = path.join(stagedRootPath, firstEntryName);
  let stagedEntry: DurableFileSnapshot | null = null;
  try {
    stagedEntry = await writeDurableNewFile(
      stagedEntryPath,
      content,
      options.maxBytes ?? DEFAULT_MAX_FILE_BYTES
    );
    await syncDurableDirectory(stagedRootPath);
    await syncDurableDirectory(layout.stagingRootPath);
    await options.faultInjector?.("after-staging-sync");
    await assertDirectoryIdentity(
      layout.namespaceRootPath,
      namespaceIdentity,
      "append-only namespace"
    );
    await publishDurablePreparedChainDirectory(
      stagedRootPath,
      chainRootPath,
      chainToken
    );
    await assertDirectoryIdentity(
      layout.namespaceRootPath,
      namespaceIdentity,
      "append-only namespace"
    );
    await assertDirectoryIdentity(
      layout.stagingRootPath,
      stagingRootIdentity,
      "append-only staging root"
    );
    await syncDurableDirectory(layout.stagingRootPath);
    await syncDurableDirectory(layout.namespaceRootPath);
    await assertDirectoryIdentity(
      chainRootPath,
      stagedRootIdentity,
      "append-only atomic chain claim"
    );
    await options.faultInjector?.("after-chain-claim");
    const entryPath = path.join(chainRootPath, firstEntryName);
    const published = await fsp.lstat(entryPath);
    assertDurableRegularFileStat(published, "append-only first entry");
    if (!sameDurableIdentity(published, stagedEntry)) {
      throw new DurableAppendOnlyCasError(
        "unsafe_entry",
        "append-only first entry publish 后 identity 不匹配"
      );
    }
    await assertDirectoryIdentity(
      layout.namespaceRootPath,
      namespaceIdentity,
      "append-only namespace"
    );
    await syncDurableDirectory(chainRootPath);
    await syncDurableDirectory(layout.namespaceRootPath);
    await options.faultInjector?.("after-publish");
    return {
      chainRootPath,
      entryPath
    };
  } catch (error) {
    if (!options.preserveStagingOnError?.(error)) {
      await removeDurableStagingTree(stagedRootPath).catch(() => undefined);
      await syncDurableDirectory(layout.stagingRootPath).catch(() => undefined);
    }
    throw error;
  }
}

export async function publishDurableAppendOnlyEntry(
  layout: DurableAppendOnlyLayout,
  chainToken: string,
  entryName: string,
  content: Buffer,
  options: DurableAppendOnlyPublishOptions = {}
): Promise<string> {
  assertSafeChainToken(chainToken);
  assertSafeComponent(entryName, "append-only entry");
  const chainRootPath = durableAppendOnlyChainPath(layout, chainToken);
  const chainIdentity = await requireSafeDirectory(
    chainRootPath,
    "append-only chain"
  );
  const stagingIdentity = await requireSafeDirectory(
    layout.stagingRootPath,
    "append-only staging root"
  );
  const targetPath = path.join(chainRootPath, entryName);
  const stagingPath = path.join(
    layout.stagingRootPath,
    `.${chainToken}.${entryName}.${randomUUID()}.tmp`
  );
  let stagedFile: DurableFileSnapshot | null = null;
  try {
    stagedFile = await writeDurableNewFile(
      stagingPath,
      content,
      options.maxBytes ?? DEFAULT_MAX_FILE_BYTES
    );
    await assertDirectoryIdentity(
      layout.stagingRootPath,
      stagingIdentity,
      "append-only staging root"
    );
    await syncDurableDirectory(layout.stagingRootPath);
    await options.faultInjector?.("after-staging-sync");
    await assertDirectoryIdentity(
      chainRootPath,
      chainIdentity,
      "append-only chain"
    );
    try {
      await fsp.link(stagingPath, targetPath);
    } catch (error) {
      if (isAlreadyExists(error)) {
        throw new DurableAppendOnlyCasError(
          "revision_conflict",
          `append-only entry 已由并发 writer 发布：${entryName}`
        );
      }
      throw error;
    }
    await assertDirectoryIdentity(
      chainRootPath,
      chainIdentity,
      "append-only chain"
    );
    await syncDurableDirectory(chainRootPath);
    await options.faultInjector?.("after-publish");
    await unlinkDurableFileIfIdentityMatches(stagingPath, stagedFile, [1, 2]);
    await assertDirectoryIdentity(
      layout.stagingRootPath,
      stagingIdentity,
      "append-only staging root"
    );
    await syncDurableDirectory(layout.stagingRootPath);
    return targetPath;
  } catch (error) {
    if (stagedFile && !options.preserveStagingOnError?.(error)) {
      await unlinkDurableFileIfIdentityMatches(stagingPath, stagedFile, [1, 2])
        .catch(() => undefined);
      await syncDurableDirectory(layout.stagingRootPath).catch(() => undefined);
    }
    throw error;
  }
}

export async function resolveDurablePlainRoot(
  absolutePathInput: string,
  label: string
): Promise<string> {
  if (
    typeof absolutePathInput !== "string"
    || absolutePathInput !== absolutePathInput.trim()
    || !absolutePathInput
    || absolutePathInput.includes("\0")
  ) {
    throw new DurableAppendOnlyCasError("invalid_path", `${label} 路径非法`);
  }
  const absolutePath = path.resolve(absolutePathInput);
  if (absolutePathInput !== absolutePath && !path.isAbsolute(absolutePathInput)) {
    throw new DurableAppendOnlyCasError("invalid_path", `${label} 必须是绝对路径`);
  }
  const before = await durableLstatOrNull(absolutePath);
  if (!before) {
    throw new DurableAppendOnlyCasError("missing", `${label} 不存在`);
  }
  assertDurableDirectoryStat(before, label);
  const real = path.resolve(await fsp.realpath(absolutePath));
  const after = await fsp.lstat(real);
  if (!sameDurableIdentity(before, after)) {
    throw new DurableAppendOnlyCasError(
      "unsafe_entry",
      `${label} canonical identity 不一致`
    );
  }
  return real;
}

export async function ensureDurableRelativeParent(
  rootPathInput: string,
  relativePathInput: string
): Promise<{
  rootPath: string;
  parentPath: string;
  absolutePath: string;
  parentIdentity: DurableFileIdentity;
}> {
  const rootPath = await resolveDurablePlainRoot(rootPathInput, "relative path root");
  const relativePath = validateDurableRelativePath(relativePathInput);
  const segments = relativePath.split("/");
  const leaf = segments.pop();
  if (!leaf) {
    throw new DurableAppendOnlyCasError("invalid_path", "relative path 缺少文件名");
  }
  let parentPath = rootPath;
  for (const segment of segments) {
    parentPath = await ensureDurableChildDirectory(parentPath, segment, true)
      ?? neverMissingDirectory(segment);
  }
  const parentIdentity = await requireSafeDirectory(
    parentPath,
    "relative path parent"
  );
  const absolutePath = path.join(parentPath, leaf);
  if (!isPathInside(rootPath, absolutePath)) {
    throw new DurableAppendOnlyCasError("invalid_path", "relative path 越界");
  }
  return { rootPath, parentPath, absolutePath, parentIdentity };
}

export async function resolveExistingDurableRelativeFile(
  rootPathInput: string,
  relativePathInput: string,
  maxBytes: number,
  allowedLinkCounts: readonly number[] = [1]
): Promise<DurableReadResult | null> {
  const rootPath = await resolveDurablePlainRoot(rootPathInput, "relative file root");
  const relativePath = validateDurableRelativePath(relativePathInput);
  const segments = relativePath.split("/");
  let parentPath = rootPath;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const nextPath = path.join(parentPath, segments[index]);
    const entry = await durableLstatOrNull(nextPath);
    if (!entry) return null;
    assertDurableDirectoryStat(entry, `relative parent ${segments[index]}`);
    const real = path.resolve(await fsp.realpath(nextPath));
    if (real !== nextPath) {
      throw new DurableAppendOnlyCasError(
        "unsafe_entry",
        `relative parent 经过 symlink：${segments[index]}`
      );
    }
    parentPath = nextPath;
  }
  const absolutePath = path.join(rootPath, ...segments);
  if (!isPathInside(rootPath, absolutePath)) {
    throw new DurableAppendOnlyCasError("invalid_path", "relative file 越界");
  }
  const entry = await durableLstatOrNull(absolutePath);
  if (!entry) return null;
  if (entry.isSymbolicLink() || !entry.isFile()) {
    throw new DurableAppendOnlyCasError(
      "unsafe_entry",
      `relative file 不是安全普通文件：${relativePath}`
    );
  }
  return await readDurableRegularFile(
    absolutePath,
    maxBytes,
    allowedLinkCounts
  );
}

export async function readDurableRegularFile(
  absolutePath: string,
  maxBytes: number,
  allowedLinkCounts: readonly number[] = [1]
): Promise<DurableReadResult> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new DurableAppendOnlyCasError("invalid_path", "read maxBytes 非法");
  }
  let handle: fsp.FileHandle;
  try {
    handle = await fsp.open(
      absolutePath,
      fsConstants.O_RDONLY | noFollowFlag()
    );
  } catch (error) {
    if (isNotFound(error)) {
      throw new DurableAppendOnlyCasError("missing", `文件不存在：${absolutePath}`);
    }
    throw new DurableAppendOnlyCasError(
      "unsafe_entry",
      `文件无法安全打开：${errorMessage(error)}`
    );
  }
  try {
    const before = await handle.stat();
    assertDurableRegularFileStat(before, "durable file", allowedLinkCounts);
    if (before.size > maxBytes) {
      throw new DurableAppendOnlyCasError(
        "content_too_large",
        `文件超过读取上限：${before.size}`
      );
    }
    const content = await handle.readFile();
    const after = await handle.stat();
    if (
      !sameOpenFileVersion(before, after)
      || content.byteLength !== before.size
    ) {
      throw new DurableAppendOnlyCasError(
        "unsafe_entry",
        "文件读取期间发生变化"
      );
    }
    return { content, snapshot: fileSnapshot(after) };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export async function writeDurableNewFile(
  absolutePath: string,
  content: Buffer,
  maxBytes: number,
  mode = 0o600
): Promise<DurableFileSnapshot> {
  if (content.byteLength > maxBytes) {
    throw new DurableAppendOnlyCasError(
      "content_too_large",
      `文件超过写入上限：${content.byteLength}`
    );
  }
  const parentPath = path.dirname(absolutePath);
  const parentIdentity = await requireSafeDirectory(parentPath, "new file parent");
  let handle: fsp.FileHandle;
  try {
    handle = await fsp.open(
      absolutePath,
      fsConstants.O_WRONLY
        | fsConstants.O_CREAT
        | fsConstants.O_EXCL
        | noFollowFlag(),
      mode
    );
  } catch (error) {
    if (isAlreadyExists(error)) {
      throw new DurableAppendOnlyCasError(
        "already_exists",
        `文件已存在：${absolutePath}`
      );
    }
    throw error;
  }
  try {
    await handle.writeFile(content);
    await handle.chmod(mode);
    await handle.sync();
    const stat = await handle.stat();
    assertDurableRegularFileStat(stat, "new durable file");
    await assertDirectoryIdentity(parentPath, parentIdentity, "new file parent");
    return fileSnapshot(stat);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export async function linkDurableFileNoClobber(
  sourcePath: string,
  targetPath: string,
  expectedSource: DurableFileIdentity
): Promise<DurableFileSnapshot> {
  const sourceBefore = await fsp.lstat(sourcePath);
  assertDurableRegularFileStat(sourceBefore, "hard-link source", [1]);
  if (!sameDurableIdentity(sourceBefore, expectedSource)) {
    throw new DurableAppendOnlyCasError(
      "unsafe_entry",
      "hard-link source identity 不匹配"
    );
  }
  const targetParentPath = path.dirname(targetPath);
  const parentIdentity = await requireSafeDirectory(
    targetParentPath,
    "hard-link target parent"
  );
  try {
    await fsp.link(sourcePath, targetPath);
  } catch (error) {
    if (isAlreadyExists(error)) {
      throw new DurableAppendOnlyCasError(
        "already_exists",
        `hard-link target 已存在：${targetPath}`
      );
    }
    throw error;
  }
  await assertDirectoryIdentity(
    targetParentPath,
    parentIdentity,
    "hard-link target parent"
  );
  await syncDurableDirectory(targetParentPath);
  const target = await fsp.lstat(targetPath);
  assertDurableRegularFileStat(target, "hard-link target", [2]);
  if (!sameDurableIdentity(target, expectedSource)) {
    throw new DurableAppendOnlyCasError(
      "unsafe_entry",
      "hard-link target identity 不匹配"
    );
  }
  return fileSnapshot(target);
}

export async function unlinkDurableFileIfIdentityMatches(
  absolutePath: string,
  expected: DurableFileIdentity,
  allowedLinkCounts: readonly number[] = [1]
): Promise<void> {
  const parentPath = path.dirname(absolutePath);
  const parentIdentity = await requireSafeDirectory(parentPath, "unlink parent");
  const current = await durableLstatOrNull(absolutePath);
  if (!current) return;
  assertDurableRegularFileStat(current, "unlink target", allowedLinkCounts);
  if (!sameDurableIdentity(current, expected)) {
    throw new DurableAppendOnlyCasError(
      "unsafe_entry",
      `拒绝 unlink identity 不匹配的文件：${absolutePath}`
    );
  }
  await fsp.unlink(absolutePath);
  await assertDirectoryIdentity(parentPath, parentIdentity, "unlink parent");
  await syncDurableDirectory(parentPath);
}

export async function assertDirectoryIdentity(
  absolutePath: string,
  expected: DurableFileIdentity,
  label: string
): Promise<void> {
  const current = await fsp.lstat(absolutePath);
  assertDurableDirectoryStat(current, label);
  if (!sameDurableIdentity(current, expected)) {
    throw new DurableAppendOnlyCasError(
      "unsafe_entry",
      `${label} identity 发生变化`
    );
  }
}

export function assertDurableDirectoryStat(stat: Stats, label: string): void {
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new DurableAppendOnlyCasError(
      "unsafe_entry",
      `${label} 不是安全目录`
    );
  }
}

export function assertDurableRegularFileStat(
  stat: Stats,
  label: string,
  allowedLinkCounts: readonly number[] = [1]
): void {
  if (
    !stat.isFile()
    || stat.isSymbolicLink()
    || !allowedLinkCounts.includes(stat.nlink)
  ) {
    throw new DurableAppendOnlyCasError(
      "unsafe_entry",
      `${label} 不是安全独立普通文件`
    );
  }
}

export function sameDurableIdentity(
  left: DurableFileIdentity,
  right: DurableFileIdentity
): boolean {
  return Number(left.dev) === Number(right.dev)
    && Number(left.ino) === Number(right.ino);
}

export function validateDurableRelativePath(relativePathInput: string): string {
  if (
    typeof relativePathInput !== "string"
    || !relativePathInput
    || relativePathInput.length > 4096
    || relativePathInput.includes("\0")
    || relativePathInput.includes("\\")
    || path.posix.isAbsolute(relativePathInput)
    || /^[a-zA-Z]:/.test(relativePathInput)
    || relativePathInput !== relativePathInput.normalize("NFC")
  ) {
    throw new DurableAppendOnlyCasError("invalid_path", "relative path 非法");
  }
  const segments = relativePathInput.split("/");
  if (
    segments.length > 128
    || segments.some((segment) => (
      !segment
      || segment === "."
      || segment === ".."
      || segment.length > 255
      || hasUnsafeControlCharacter(segment)
    ))
    || path.posix.normalize(relativePathInput) !== relativePathInput
  ) {
    throw new DurableAppendOnlyCasError("invalid_path", "relative path segment 非法");
  }
  return relativePathInput;
}

function hasUnsafeControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

export async function syncDurableDirectory(directoryPath: string): Promise<void> {
  let handle: fsp.FileHandle | undefined;
  try {
    handle = await fsp.open(directoryPath, "r");
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (
      process.platform !== "win32"
      || !["EINVAL", "ENOTSUP", "EPERM"].includes(code ?? "")
    ) {
      throw error;
    }
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function durableLstatOrNull(
  absolutePath: string
): Promise<Stats | null> {
  return await fsp.lstat(absolutePath).catch((error) => {
    if (isNotFound(error)) return null;
    throw error;
  });
}

async function ensureDurableChildDirectory(
  parentPath: string,
  childName: string,
  create: boolean
): Promise<string | null> {
  assertSafeComponent(childName, "child directory");
  const parentIdentity = await requireSafeDirectory(parentPath, "child parent");
  const childPath = path.join(parentPath, childName);
  let child = await durableLstatOrNull(childPath);
  if (!child && create) {
    try {
      await fsp.mkdir(childPath, { mode: 0o700 });
      await syncDurableDirectory(parentPath);
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
    }
    child = await durableLstatOrNull(childPath);
  }
  if (!child) return null;
  assertDurableDirectoryStat(child, `child directory ${childName}`);
  await assertDirectoryIdentity(parentPath, parentIdentity, "child parent");
  const real = path.resolve(await fsp.realpath(childPath));
  if (real !== childPath) {
    throw new DurableAppendOnlyCasError(
      "unsafe_entry",
      `child directory 经过 symlink：${childName}`
    );
  }
  return real;
}

async function createExclusiveDirectory(
  absolutePath: string,
  parentPath: string
): Promise<DurableFileIdentity> {
  const parentIdentity = await requireSafeDirectory(parentPath, "mkdir parent");
  try {
    await fsp.mkdir(absolutePath, { mode: 0o700 });
  } catch (error) {
    if (isAlreadyExists(error)) {
      throw new DurableAppendOnlyCasError(
        "already_exists",
        `staging directory 已存在：${absolutePath}`
      );
    }
    throw error;
  }
  await assertDirectoryIdentity(parentPath, parentIdentity, "mkdir parent");
  await syncDurableDirectory(parentPath);
  return await requireSafeDirectory(absolutePath, "new staging directory");
}

async function removeEmptyChainClaimOrThrow(
  namespaceRootPath: string,
  chainRootPath: string,
  chainToken: string
): Promise<void> {
  const existing = await durableLstatOrNull(chainRootPath);
  if (!existing) return;
  assertDurableDirectoryStat(existing, "append-only chain");
  const entries = await fsp.readdir(chainRootPath);
  if (entries.length) {
    throw new DurableAppendOnlyCasError(
      "already_exists",
      `append-only chain 已存在：${chainToken}`
    );
  }
  try {
    await fsp.rmdir(chainRootPath);
    await syncDurableDirectory(namespaceRootPath);
  } catch (error) {
    if (isNotFound(error)) return;
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOTEMPTY") {
      throw new DurableAppendOnlyCasError(
        "already_exists",
        `append-only chain 正由并发 writer 创建：${chainToken}`
      );
    }
    throw error;
  }
}

/**
 * Same-version writers only publish a chain that already contains its first
 * entry, so a concurrent target is non-empty and rename fails. POSIX may
 * replace an empty target left by a legacy writer; mixed-version live writers
 * remain outside the cooperative-writer threat boundary.
 */
async function publishDurablePreparedChainDirectory(
  sourcePath: string,
  targetPath: string,
  chainToken: string
): Promise<void> {
  try {
    await fsp.rename(sourcePath, targetPath);
  } catch (error) {
    const target = await durableLstatOrNull(targetPath);
    if (target) {
      assertDurableDirectoryStat(target, "append-only concurrent chain");
      throw new DurableAppendOnlyCasError(
        "already_exists",
        `append-only chain 已由并发 writer 创建：${chainToken}`
      );
    }
    throw error;
  }
}

async function requireSafeDirectory(
  absolutePath: string,
  label: string
): Promise<DurableFileIdentity> {
  const stat = await fsp.lstat(absolutePath).catch((error) => {
    if (isNotFound(error)) {
      throw new DurableAppendOnlyCasError("missing", `${label} 不存在`);
    }
    throw error;
  });
  assertDurableDirectoryStat(stat, label);
  return { dev: Number(stat.dev), ino: Number(stat.ino) };
}

async function removeDurableStagingTree(absolutePath: string): Promise<void> {
  const root = await durableLstatOrNull(absolutePath);
  if (!root) return;
  assertDurableDirectoryStat(root, "staging tree");
  const entries = await fsp.readdir(absolutePath, { withFileTypes: true });
  for (const entry of entries) {
    const childPath = path.join(absolutePath, entry.name);
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      await removeDurableStagingTree(childPath);
      continue;
    }
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new DurableAppendOnlyCasError(
        "unsafe_entry",
        `staging tree 含未知项：${entry.name}`
      );
    }
    const stat = await fsp.lstat(childPath);
    assertDurableRegularFileStat(stat, "staging file", [1, 2]);
    await fsp.unlink(childPath);
  }
  await fsp.rmdir(absolutePath);
}

function fileSnapshot(stat: Stats): DurableFileSnapshot {
  return {
    dev: Number(stat.dev),
    ino: Number(stat.ino),
    size: stat.size,
    mode: stat.mode & 0o777,
    nlink: stat.nlink,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs
  };
}

function sameOpenFileVersion(left: Stats, right: Stats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function assertSafeComponent(value: string, label: string): void {
  if (!SAFE_COMPONENT.test(value) || value === "." || value === "..") {
    throw new DurableAppendOnlyCasError(
      "invalid_path",
      `${label} 名称非法：${value}`
    );
  }
}

function assertSafeChainToken(value: string): void {
  if (!SAFE_CHAIN_TOKEN.test(value)) {
    throw new DurableAppendOnlyCasError(
      "invalid_path",
      `append-only chain token 非法：${value}`
    );
  }
}

function isPathInside(rootPath: string, candidatePath: string): boolean {
  const relative = path.relative(rootPath, candidatePath);
  return relative !== ""
    && !relative.startsWith(`..${path.sep}`)
    && relative !== ".."
    && !path.isAbsolute(relative);
}

function neverMissingDirectory(segment: string): never {
  throw new DurableAppendOnlyCasError(
    "unsafe_entry",
    `无法创建 relative parent：${segment}`
  );
}

function noFollowFlag(): number {
  return typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return ["EEXIST", "ENOTEMPTY"].includes(
    (error as NodeJS.ErrnoException | undefined)?.code ?? ""
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
