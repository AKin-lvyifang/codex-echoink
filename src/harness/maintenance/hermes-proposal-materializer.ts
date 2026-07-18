import { createHash } from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import {
  HERMES_MAINTENANCE_PROPOSAL_ALLOWED_ROOTS,
  isTrustedValidatedHermesMaintenanceProposal,
  type HermesMaintenanceProposalUpsertV1,
  type ValidatedHermesMaintenanceProposal
} from "./hermes-proposal-contract";
import {
  acceptBoundHermesProposalMaterialization,
  isHermesProposalBoundToInvocation,
  isHermesProposalLeaseActive,
  isTrustedHermesVaultNoWriteAuthorityReceipt,
  revokeHermesProposalLease,
  type HermesProposalLease,
  type HermesProposalLeaseRevocationReceipt,
  type HermesVaultNoWriteAuthorityReceipt
} from "../../core/hermes-proposal-runtime";

const MAX_TARGET_BASELINE_BYTES = 128 * 1024 * 1024;
const WINDOWS_ABSOLUTE_PATTERN = /^[a-zA-Z]:[\\/]/;
const DENIED_EXACT_PATHS = new Set(["outputs/.ingest-tracker.md"]);
const DENIED_PATH_SEGMENTS = new Set([".echoink", ".git", ".obsidian"]);
const ALLOWED_MATERIALIZER_ROOTS = new Set([
  "wiki",
  "projects",
  "outputs/maintenance",
  "inbox"
]);

export interface MaterializeHermesMaintenanceProposalInput {
  shadowVaultPath: string;
  proposal: ValidatedHermesMaintenanceProposal;
  authorityReceipt: HermesVaultNoWriteAuthorityReceipt;
  lease: HermesProposalLease;
  /**
   * Deterministic fault/race injection point. Production callers normally
   * leave this unset. Baselines and lease state are checked again afterwards.
   */
  beforeApply?: (input: {
    attemptId: string;
    proposalDigest: string;
    relativePaths: readonly string[];
  }) => void | Promise<void>;
}

export interface HermesProposalMaterializationResult {
  readonly version: 1;
  readonly attemptId: string;
  readonly proposalDigest: string;
  readonly outcome: "committable" | "partial" | "noop";
  readonly materializedPaths: readonly string[];
  readonly revocationReceipt: HermesProposalLeaseRevocationReceipt;
}

export type HermesProposalMaterializationErrorCode =
  | "proposal_untrusted"
  | "authority_untrusted"
  | "invocation_unbound"
  | "lease_revoked"
  | "invalid_binding"
  | "invalid_shadow_root"
  | "path_denied"
  | "unsafe_entry"
  | "target_changed"
  | "invalid_proposal"
  | "write_failed";

export class HermesProposalMaterializationError extends Error {
  constructor(
    public readonly code: HermesProposalMaterializationErrorCode,
    message: string,
    public readonly relativePath?: string,
    public readonly revocationReceipt?: HermesProposalLeaseRevocationReceipt,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "HermesProposalMaterializationError";
  }
}

interface TargetBaselineMissing {
  kind: "missing";
}

interface TargetBaselineFile {
  kind: "file";
  fingerprint: string;
  size: number;
  mode: number;
  dev: number;
  ino: number;
}

type TargetBaseline = TargetBaselineMissing | TargetBaselineFile;

interface PreparedOperation {
  operation: HermesMaintenanceProposalUpsertV1;
  relativePath: string;
  targetPath: string;
  stagePath: string;
  backupPath: string;
  baseline: TargetBaseline;
}

export async function materializeHermesMaintenanceProposal(
  input: MaterializeHermesMaintenanceProposalInput
): Promise<HermesProposalMaterializationResult> {
  const stagedPaths = new Set<string>();
  let currentRelativePath: string | undefined;
  try {
    assertTrustedInputs(input);
    const shadowVaultPath = await assertShadowRoot(input.shadowVaultPath);
    const authorityRoots = validateAuthorityRoots(shadowVaultPath, input.authorityReceipt);
    if (input.proposal.outcome === "invalid") {
      throw new HermesProposalMaterializationError(
        "invalid_proposal",
        "Hermes proposal 没有任何可接受 operation"
      );
    }

    const normalizedOperations = input.proposal.operations.map((operation) => {
      const relativePath = normalizeMaterializedPath(operation.path);
      const targetPath = resolveInsideShadow(shadowVaultPath, relativePath);
      if (!authorityRoots.some((root) => isSameOrDescendant(targetPath, root))) {
        throw new HermesProposalMaterializationError(
          "path_denied",
          `Hermes proposal 目标不在回执签发的 host materializer root：${relativePath}`,
          relativePath
        );
      }
      return { operation, relativePath, targetPath };
    });

    const baselines = new Map<string, TargetBaseline>();
    for (const item of normalizedOperations) {
      currentRelativePath = item.relativePath;
      await assertSafeParentChain(shadowVaultPath, path.posix.dirname(item.relativePath), false);
      const baseline = await inspectTargetBaseline(item.targetPath, item.relativePath);
      assertExpectedBaseline(item.operation, baseline);
      baselines.set(item.relativePath, baseline);
    }

    const prepared: PreparedOperation[] = [];
    for (const [index, item] of normalizedOperations.entries()) {
      currentRelativePath = item.relativePath;
      await assertLeaseAndBindingStillActive(input);
      await assertSafeParentChain(shadowVaultPath, path.posix.dirname(item.relativePath), true);
      const token = createHash("sha256")
        .update(`${input.lease.leaseId}\0${item.relativePath}\0${index}`)
        .digest("hex")
        .slice(0, 24);
      const parentPath = path.dirname(item.targetPath);
      const stagePath = path.join(parentPath, `.echoink-hermes-${token}.new`);
      const backupPath = path.join(parentPath, `.echoink-hermes-${token}.bak`);
      await assertPathMissing(stagePath, item.relativePath, "staging");
      await assertPathMissing(backupPath, item.relativePath, "backup");
      const baseline = baselines.get(item.relativePath);
      if (!baseline) {
        throw new HermesProposalMaterializationError(
          "target_changed",
          `Hermes proposal 缺少 host baseline：${item.relativePath}`,
          item.relativePath
        );
      }
      stagedPaths.add(stagePath);
      await writeStagedFile(
        stagePath,
        item.operation.content,
        baseline.kind === "file" ? baseline.mode : 0o644
      );
      prepared.push({
        ...item,
        stagePath,
        backupPath,
        baseline
      });
    }

    await input.beforeApply?.({
      attemptId: input.proposal.attemptId,
      proposalDigest: input.proposal.digest,
      relativePaths: Object.freeze(prepared.map((item) => item.relativePath))
    });

    await assertLeaseAndBindingStillActive(input);
    for (const item of prepared) {
      currentRelativePath = item.relativePath;
      await assertSafeParentChain(shadowVaultPath, path.posix.dirname(item.relativePath), false);
      const current = await inspectTargetBaseline(item.targetPath, item.relativePath);
      if (!targetBaselinesEqual(current, item.baseline)) {
        throw new HermesProposalMaterializationError(
          "target_changed",
          `Hermes proposal materialize 前目标已变化：${item.relativePath}`,
          item.relativePath
        );
      }
    }

    for (const item of prepared) {
      currentRelativePath = item.relativePath;
      await assertLeaseAndBindingStillActive(input);
      await assertSafeParentChain(shadowVaultPath, path.posix.dirname(item.relativePath), false);
      if (item.baseline.kind === "missing") {
        await installNewTarget(item);
      } else {
        await replaceExistingTarget(item);
      }
      stagedPaths.delete(item.stagePath);
      const installed = await inspectTargetBaseline(item.targetPath, item.relativePath);
      const expectedFingerprint = fingerprintText(item.operation.content);
      if (
        installed.kind !== "file"
        || installed.fingerprint !== expectedFingerprint
        || installed.size !== Buffer.byteLength(item.operation.content, "utf8")
      ) {
        throw new HermesProposalMaterializationError(
          "write_failed",
          `Hermes proposal 写入后校验失败：${item.relativePath}`,
          item.relativePath
        );
      }
    }

    await assertLeaseAndBindingStillActive(input);
    acceptBoundHermesProposalMaterialization({
      lease: input.lease,
      proposal: input.proposal,
      authorityReceipt: input.authorityReceipt
    });
    const revocationReceipt = revokeHermesProposalLease(input.lease, "materialized");
    return Object.freeze({
      version: 1,
      attemptId: input.proposal.attemptId,
      proposalDigest: input.proposal.digest,
      outcome: input.proposal.outcome,
      materializedPaths: Object.freeze(prepared.map((item) => item.relativePath)),
      revocationReceipt
    });
  } catch (error) {
    const revocationReceipt = revokeActiveLease(input.lease, "materialization_failed");
    const cleanupErrors: string[] = [];
    for (const stagedPath of stagedPaths) {
      try {
        await fsp.rm(stagedPath, { force: true });
      } catch (cleanupError) {
        cleanupErrors.push(errorMessage(cleanupError));
      }
    }
    if (error instanceof HermesProposalMaterializationError) {
      throw new HermesProposalMaterializationError(
        error.code,
        cleanupErrors.length
          ? `${error.message}；staging 清理失败：${cleanupErrors.join("；")}`
          : error.message,
        error.relativePath ?? currentRelativePath,
        error.revocationReceipt ?? revocationReceipt,
        { cause: error }
      );
    }
    throw new HermesProposalMaterializationError(
      "write_failed",
      `Hermes proposal materialize 失败：${errorMessage(error)}${cleanupErrors.length
        ? `；staging 清理失败：${cleanupErrors.join("；")}`
        : ""}`,
      currentRelativePath,
      revocationReceipt,
      { cause: error }
    );
  }
}

function assertTrustedInputs(input: MaterializeHermesMaintenanceProposalInput): void {
  if (!isTrustedValidatedHermesMaintenanceProposal(input.proposal)) {
    throw new HermesProposalMaterializationError(
      "proposal_untrusted",
      "拒绝普通对象、spread 或 JSON clone 伪造的 Hermes proposal"
    );
  }
  if (!isTrustedHermesVaultNoWriteAuthorityReceipt(input.authorityReceipt)) {
    throw new HermesProposalMaterializationError(
      "authority_untrusted",
      "拒绝普通对象、spread 或 JSON clone 伪造的 Hermes Vault-no-write 回执"
    );
  }
  if (!isHermesProposalLeaseActive(input.lease)) {
    throw new HermesProposalMaterializationError(
      "lease_revoked",
      "Hermes proposal lease 不可信或已经撤销"
    );
  }
  if (
    input.proposal.attemptId !== input.lease.attemptId
    || input.authorityReceipt.attemptId !== input.lease.attemptId
    || input.authorityReceipt.leaseId !== input.lease.leaseId
    || input.authorityReceipt.inputDigest !== input.lease.inputDigest
  ) {
    throw new HermesProposalMaterializationError(
      "invalid_binding",
      "Hermes proposal、authority receipt 与 lease 绑定不一致"
    );
  }
  if (!isHermesProposalBoundToInvocation(input.proposal, input.lease, input.authorityReceipt)) {
    throw new HermesProposalMaterializationError(
      "invocation_unbound",
      "Hermes proposal 不是该 authority receipt 与 lease 对应进程的原始输出"
    );
  }
}

async function assertLeaseAndBindingStillActive(
  input: MaterializeHermesMaintenanceProposalInput
): Promise<void> {
  if (!isHermesProposalLeaseActive(input.lease)) {
    throw new HermesProposalMaterializationError(
      "lease_revoked",
      "Hermes proposal lease 已在 materialize 前撤销"
    );
  }
  if (!isHermesProposalBoundToInvocation(input.proposal, input.lease, input.authorityReceipt)) {
    throw new HermesProposalMaterializationError(
      "invocation_unbound",
      "Hermes proposal invocation binding 已失效"
    );
  }
}

async function assertShadowRoot(inputPath: string): Promise<string> {
  if (!path.isAbsolute(inputPath)) {
    throw new HermesProposalMaterializationError(
      "invalid_shadow_root",
      "Hermes Shadow Vault 必须是绝对路径"
    );
  }
  const shadowVaultPath = path.resolve(inputPath);
  if (shadowVaultPath === path.parse(shadowVaultPath).root) {
    throw new HermesProposalMaterializationError(
      "invalid_shadow_root",
      "Hermes Shadow Vault 不能是文件系统根目录"
    );
  }
  const stat = await lstatOrNull(shadowVaultPath);
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) {
    throw new HermesProposalMaterializationError(
      "invalid_shadow_root",
      "Hermes Shadow Vault 必须是已存在的真实目录"
    );
  }
  const realPath = await fsp.realpath(shadowVaultPath);
  if (path.resolve(realPath) !== shadowVaultPath) {
    throw new HermesProposalMaterializationError(
      "invalid_shadow_root",
      "Hermes Shadow Vault 路径不能经过 symlink"
    );
  }
  return shadowVaultPath;
}

function validateAuthorityRoots(
  shadowVaultPath: string,
  authorityReceipt: HermesVaultNoWriteAuthorityReceipt
): readonly string[] {
  const roots = [...new Set(authorityReceipt.hostMaterializerRoots.map((root) => path.resolve(root)))].sort();
  if (!roots.length) {
    throw new HermesProposalMaterializationError(
      "invalid_binding",
      "Hermes authority receipt 缺少 host materializer roots"
    );
  }
  for (const root of roots) {
    const relative = path.relative(shadowVaultPath, root).split(path.sep).join("/");
    if (
      !relative
      || relative === ".."
      || relative.startsWith("../")
      || path.isAbsolute(relative)
      || !ALLOWED_MATERIALIZER_ROOTS.has(relative)
    ) {
      throw new HermesProposalMaterializationError(
        "invalid_binding",
        `host materializer root 不在精确维护写入根：${root}`
      );
    }
  }
  if (authorityReceipt.deniedLivePaths.some((denied) =>
    pathsOverlap(path.resolve(denied), shadowVaultPath)
  )) {
    throw new HermesProposalMaterializationError(
      "invalid_binding",
      "Shadow Vault 与 authority receipt 的真实 Vault 拒写路径重叠"
    );
  }
  if (authorityReceipt.deniedControlPaths.some((denied) =>
    roots.some((root) => pathsOverlap(path.resolve(denied), root))
  )) {
    throw new HermesProposalMaterializationError(
      "invalid_binding",
      "Shadow control-plane 拒写路径落入 host materializer root"
    );
  }
  return roots;
}

function normalizeMaterializedPath(value: string): string {
  if (
    typeof value !== "string"
    || !value
    || value !== value.trim()
    || value.includes("\\")
    || value.includes("\0")
    || /[\u0000-\u001f\u007f]/.test(value)
    || value.startsWith("/")
    || WINDOWS_ABSOLUTE_PATTERN.test(value)
  ) {
    throw new HermesProposalMaterializationError("path_denied", `Hermes proposal 路径非法：${value}`);
  }
  const segments = value.split("/");
  if (
    segments.some((segment) => !segment || segment === "." || segment === "..")
    || path.posix.normalize(value) !== value
    || !(HERMES_MAINTENANCE_PROPOSAL_ALLOWED_ROOTS as readonly string[]).includes(segments[0] ?? "")
    || DENIED_EXACT_PATHS.has(value)
    || segments.some((segment) => DENIED_PATH_SEGMENTS.has(segment.toLowerCase()))
    || segments.some((segment) => segment.toLowerCase() === ".ingest-tracker.md")
    || !value.toLowerCase().endsWith(".md")
  ) {
    throw new HermesProposalMaterializationError("path_denied", `Hermes proposal 路径不允许：${value}`);
  }
  return value;
}

function resolveInsideShadow(shadowVaultPath: string, relativePath: string): string {
  const absolutePath = path.resolve(shadowVaultPath, ...relativePath.split("/"));
  if (!isStrictDescendant(absolutePath, shadowVaultPath)) {
    throw new HermesProposalMaterializationError(
      "path_denied",
      `Hermes proposal 路径逃逸 Shadow Vault：${relativePath}`,
      relativePath
    );
  }
  return absolutePath;
}

async function assertSafeParentChain(
  shadowVaultPath: string,
  relativeDirectory: string,
  createMissing: boolean
): Promise<void> {
  if (relativeDirectory === ".") return;
  let current = shadowVaultPath;
  for (const segment of relativeDirectory.split("/")) {
    current = path.join(current, segment);
    let stat = await lstatOrNull(current);
    if (!stat && createMissing) {
      try {
        await fsp.mkdir(current, { mode: 0o755 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      stat = await lstatOrNull(current);
    }
    if (!stat) continue;
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new HermesProposalMaterializationError(
        "unsafe_entry",
        `Shadow parent 不是独立真实目录：${path.relative(shadowVaultPath, current)}`,
        path.relative(shadowVaultPath, current).split(path.sep).join("/")
      );
    }
  }
}

async function inspectTargetBaseline(
  absolutePath: string,
  relativePath: string
): Promise<TargetBaseline> {
  const pathStat = await lstatOrNull(absolutePath);
  if (!pathStat) return { kind: "missing" };
  assertIndependentRegularStat(pathStat, relativePath);
  if (pathStat.size > MAX_TARGET_BASELINE_BYTES) {
    throw new HermesProposalMaterializationError(
      "unsafe_entry",
      `Shadow 目标超过 baseline 读取上限：${relativePath}`,
      relativePath
    );
  }
  const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
  const handle = await fsp.open(absolutePath, flags);
  try {
    const before = await handle.stat();
    assertIndependentRegularStat(before, relativePath);
    if (!sameFileIdentity(pathStat, before)) {
      throw new HermesProposalMaterializationError(
        "target_changed",
        `Shadow 目标在打开前已替换：${relativePath}`,
        relativePath
      );
    }
    const content = await handle.readFile();
    const after = await handle.stat();
    const currentPathStat = await fsp.lstat(absolutePath);
    assertIndependentRegularStat(currentPathStat, relativePath);
    if (
      !sameFileIdentity(before, after)
      || !sameFileIdentity(after, currentPathStat)
      || before.size !== after.size
      || after.size !== content.byteLength
    ) {
      throw new HermesProposalMaterializationError(
        "target_changed",
        `Shadow 目标在 baseline 读取期间变化：${relativePath}`,
        relativePath
      );
    }
    return {
      kind: "file",
      fingerprint: fingerprintBytes(content),
      size: content.byteLength,
      mode: after.mode & 0o777,
      dev: Number(after.dev),
      ino: Number(after.ino)
    };
  } finally {
    await handle.close();
  }
}

function assertExpectedBaseline(
  operation: HermesMaintenanceProposalUpsertV1,
  baseline: TargetBaseline
): void {
  if (operation.baseSha256 === null) {
    if (baseline.kind !== "missing") {
      throw new HermesProposalMaterializationError(
        "target_changed",
        `Hermes proposal 期望新建，但目标已存在：${operation.path}`,
        operation.path
      );
    }
    return;
  }
  if (baseline.kind !== "file" || baseline.fingerprint !== operation.baseSha256) {
    throw new HermesProposalMaterializationError(
      "target_changed",
      `Hermes proposal 目标 baseline 不匹配：${operation.path}`,
      operation.path
    );
  }
}

async function writeStagedFile(absolutePath: string, content: string, mode: number): Promise<void> {
  const flags = fsConstants.O_WRONLY
    | fsConstants.O_CREAT
    | fsConstants.O_EXCL
    | (fsConstants.O_NOFOLLOW ?? 0);
  const handle = await fsp.open(absolutePath, flags, mode || 0o644);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
    const stat = await handle.stat();
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
      throw new HermesProposalMaterializationError(
        "unsafe_entry",
        `Hermes proposal staging 不是独立普通文件：${absolutePath}`
      );
    }
  } finally {
    await handle.close();
  }
}

async function installNewTarget(item: PreparedOperation): Promise<void> {
  try {
    await fsp.link(item.stagePath, item.targetPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new HermesProposalMaterializationError(
        "target_changed",
        `Hermes proposal 新目标在原子创建前已经出现：${item.relativePath}`,
        item.relativePath,
        undefined,
        { cause: error }
      );
    }
    throw error;
  }
  await fsp.unlink(item.stagePath);
}

async function replaceExistingTarget(item: PreparedOperation): Promise<void> {
  if (item.baseline.kind !== "file") {
    throw new HermesProposalMaterializationError(
      "target_changed",
      `Hermes proposal 替换缺少文件 baseline：${item.relativePath}`,
      item.relativePath
    );
  }
  await fsp.rename(item.targetPath, item.backupPath);
  const displaced = await inspectTargetBaseline(item.backupPath, item.relativePath);
  if (!targetBaselinesEqual(displaced, item.baseline)) {
    await restoreDisplacedTargetBestEffort(item);
    throw new HermesProposalMaterializationError(
      "target_changed",
      `Hermes proposal 原子替换时目标已变化：${item.relativePath}`,
      item.relativePath
    );
  }
  try {
    await fsp.link(item.stagePath, item.targetPath);
  } catch (error) {
    await restoreDisplacedTargetBestEffort(item);
    throw new HermesProposalMaterializationError(
      (error as NodeJS.ErrnoException).code === "EEXIST" ? "target_changed" : "write_failed",
      `Hermes proposal 无法原子安装目标：${item.relativePath}`,
      item.relativePath,
      undefined,
      { cause: error }
    );
  }
  await fsp.unlink(item.stagePath);
  await fsp.unlink(item.backupPath);
}

async function restoreDisplacedTargetBestEffort(item: PreparedOperation): Promise<void> {
  if (await lstatOrNull(item.targetPath)) return;
  try {
    await fsp.link(item.backupPath, item.targetPath);
    await fsp.unlink(item.backupPath);
  } catch {
    // The whole Shadow attempt is abandoned when restoration cannot be proven.
  }
}

async function assertPathMissing(
  absolutePath: string,
  relativePath: string,
  label: string
): Promise<void> {
  if (await lstatOrNull(absolutePath)) {
    throw new HermesProposalMaterializationError(
      "unsafe_entry",
      `Hermes proposal ${label} 路径已存在：${relativePath}`,
      relativePath
    );
  }
}

function assertIndependentRegularStat(stat: Stats, relativePath: string): void {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new HermesProposalMaterializationError(
      "unsafe_entry",
      `Shadow 目标不是独立普通文件：${relativePath}`,
      relativePath
    );
  }
}

function targetBaselinesEqual(left: TargetBaseline, right: TargetBaseline): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "missing" || right.kind === "missing") return true;
  return left.fingerprint === right.fingerprint
    && left.size === right.size
    && left.mode === right.mode
    && left.dev === right.dev
    && left.ino === right.ino;
}

function sameFileIdentity(left: Stats, right: Stats): boolean {
  return Number(left.dev) === Number(right.dev)
    && Number(left.ino) === Number(right.ino)
    && Number(left.nlink) === Number(right.nlink);
}

function revokeActiveLease(
  lease: HermesProposalLease,
  reason: string
): HermesProposalLeaseRevocationReceipt | undefined {
  try {
    return revokeHermesProposalLease(lease, reason);
  } catch {
    return undefined;
  }
}

async function lstatOrNull(absolutePath: string): Promise<Stats | null> {
  try {
    return await fsp.lstat(absolutePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function isSameOrDescendant(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isStrictDescendant(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function pathsOverlap(left: string, right: string): boolean {
  return isSameOrDescendant(left, right) || isSameOrDescendant(right, left);
}

function fingerprintText(value: string): string {
  return fingerprintBytes(Buffer.from(value, "utf8"));
}

function fingerprintBytes(value: Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
