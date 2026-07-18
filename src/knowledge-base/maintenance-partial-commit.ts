import * as fsp from "node:fs/promises";
import * as path from "node:path";
import type {
  MaintenanceWorkflowCasFile,
  MaintenanceWorkflowFileCas,
  MaintenanceWorkflowIndexCommitRecord,
  MaintenanceWorkflowManagedUpsertDraft
} from "../harness/maintenance/workflow-wal";
import type { MaintenanceShadowChangeSet } from "../harness/maintenance/shadow-vault";
import {
  asMaintenanceWorkflowManagedUpsertDraft,
  maintenanceContentFileCas,
  maintenanceContentUpsertPlan,
  readMaintenanceContentFileBaseline
} from "./maintenance-content-plan";
import type { KnowledgeBaseRunWarning } from "./types";
import { writeFileAtomic } from "./utils";

const MANAGED_INDEX_START = "<!-- echoink-maintenance-index:v1:start -->";
const MANAGED_INDEX_END = "<!-- echoink-maintenance-index:v1:end -->";

export interface MaintenancePartialCommitPlan {
  allowPaths: string[];
  skippedAgentIndexPaths: string[];
  reconciliationIndexPaths: string[];
}

export interface MaintenanceIndexReconciliationResult {
  reconciledPaths: string[];
  updatedPaths: string[];
}

export interface MaintenanceIndexReconciliationCommitted
  extends MaintenanceWorkflowManagedUpsertDraft {
  kind: "index";
  expected: MaintenanceWorkflowFileCas;
  result: MaintenanceWorkflowCasFile;
  sourcePaths: string[];
}

export interface MaintenanceIndexReconciliationDeferred {
  relativePath: string;
  sourcePaths: string[];
  reason: string;
}

export interface MaintenanceIndexReconciliationPlan
  extends MaintenanceIndexReconciliationResult {
  committed: MaintenanceIndexReconciliationCommitted[];
  deferred: MaintenanceIndexReconciliationDeferred[];
  warnings: KnowledgeBaseRunWarning[];
}

export function maintenanceIndexManagedWrites(
  plan: Pick<MaintenanceIndexReconciliationPlan, "committed">
): MaintenanceWorkflowManagedUpsertDraft[] {
  return plan.committed.map((write) => ({
    kind: "index",
    operation: "upsert",
    relativePath: write.relativePath,
    expected: write.expected.kind === "missing"
      ? { kind: "missing" }
      : { ...write.expected },
    ...(write.expectedContent
      ? { expectedContent: Buffer.from(write.expectedContent) }
      : {}),
    desiredContent: Buffer.from(write.desiredContent),
    desiredMode: write.desiredMode
  }));
}

export function maintenanceIndexCommitRecords(
  plan: Pick<MaintenanceIndexReconciliationPlan, "committed">
): MaintenanceWorkflowIndexCommitRecord[] {
  return plan.committed.map((write) => ({
    relativePath: write.relativePath,
    result: { ...write.result },
    sourcePaths: [...write.sourcePaths]
  }));
}

/**
 * Plans the file-atomic subset for a partial maintenance result.
 *
 * Indexes are deliberately excluded even when the Agent changed them: one
 * shared index can reference both verified and pending pages, so applying the
 * whole file would either leak an unverified result or create a broken link.
 * Required indexes are instead handed to the Host reconciler, which rebuilds
 * only its managed block from verified pages that exist in the live Vault.
 */
export function planMaintenancePartialCommit(input: {
  changeSet: Pick<MaintenanceShadowChangeSet, "changes">;
  reportPath: string;
  evidencePaths: Record<string, string[]>;
}): MaintenancePartialCommitPlan {
  const changedPaths = new Set(input.changeSet.changes.map((change) => normalizeRelativePath(change.relativePath)));
  const allowPaths = new Set<string>();
  for (const paths of Object.values(input.evidencePaths)) {
    for (const evidencePath of paths) {
      const normalized = normalizeRelativePath(evidencePath);
      if (changedPaths.has(normalized) && !isKnowledgeIndexPath(normalized)) allowPaths.add(normalized);
    }
  }
  const reportPath = normalizeRelativePath(input.reportPath);
  if (changedPaths.has(reportPath)) allowPaths.add(reportPath);

  const skippedAgentIndexPaths = Array.from(changedPaths)
    .filter(isKnowledgeIndexPath)
    .sort();
  const reconciliationIndexPaths = new Set(skippedAgentIndexPaths);
  for (const paths of Object.values(input.evidencePaths)) {
    for (const evidencePath of paths) {
      for (const indexPath of relatedKnowledgeIndexPaths(evidencePath)) {
        reconciliationIndexPaths.add(indexPath);
      }
    }
  }
  return {
    allowPaths: Array.from(allowPaths).sort(),
    skippedAgentIndexPaths,
    reconciliationIndexPaths: Array.from(reconciliationIndexPaths).sort()
  };
}

export function isKnowledgeIndexPath(relativePath: string): boolean {
  const normalized = normalizeRelativePath(relativePath);
  if (
    normalized === "wiki/index.md"
    || normalized === "projects/index.md"
    || normalized === "projects/00-索引.md"
  ) {
    return true;
  }
  return /^(?:wiki|projects)\/.+\/00-索引\.md$/i.test(normalized);
}

/**
 * Rebuilds a Harness-owned index block from the pages that actually exist in
 * the live Vault after a partial commit. Agent index files are never applied
 * wholesale, so a pending Shadow page cannot leak into the live index.
 */
export async function reconcileMaintenanceIndexes(
  vaultPathInput: string,
  indexPaths: readonly string[],
  options: { verifiedPagePaths?: readonly string[] } = {}
): Promise<MaintenanceIndexReconciliationResult> {
  const plan = await planMaintenanceIndexReconciliation(
    vaultPathInput,
    indexPaths,
    options
  );
  if (plan.deferred.length) {
    throw new Error(plan.deferred[0].reason);
  }
  const vaultPath = path.resolve(vaultPathInput);
  for (const write of plan.committed) {
    const absolutePath = resolveInsideVault(vaultPath, write.relativePath);
    const currentStat = await fsp.lstat(absolutePath).catch(() => null);
    if (write.expected.kind === "missing") {
      if (currentStat) {
        throw new Error(
          `partial index reconciliation 写入前目标由外部创建：${write.relativePath}`
        );
      }
    } else {
      if (!currentStat?.isFile() || currentStat.isSymbolicLink() || currentStat.nlink !== 1) {
        throw new Error(
          `partial index reconciliation 写入前目标不再安全：${write.relativePath}`
        );
      }
      const current = await fsp.readFile(absolutePath);
      const currentCas = maintenanceContentFileCas(
        current,
        currentStat.mode
      );
      if (
        currentCas.kind !== "file"
        || currentCas.sha256 !== write.expected.sha256
        || currentCas.size !== write.expected.size
        || currentCas.mode !== write.expected.mode
      ) {
        throw new Error(
          `partial index reconciliation 写入前内容发生变化：${write.relativePath}`
        );
      }
    }
    await writeFileAtomic(absolutePath, write.desiredContent);
    await fsp.chmod(absolutePath, write.desiredMode);
  }
  return {
    reconciledPaths: plan.reconciledPaths,
    updatedPaths: plan.updatedPaths
  };
}

/**
 * Computes every shared-index mutation before any live write. Child indexes
 * are planned first and treated as future live targets when the root index is
 * calculated, so the returned drafts can be committed atomically by the
 * workflow WAL.
 */
export async function planMaintenanceIndexReconciliation(
  vaultPathInput: string,
  indexPaths: readonly string[],
  options: {
    verifiedPagePaths?: readonly string[];
    verifiedEvidencePaths?: Readonly<Record<string, readonly string[]>>;
    trustedSealedPagePaths?: readonly string[];
    skippedAgentIndexPaths?: readonly string[];
  } = {}
): Promise<MaintenanceIndexReconciliationPlan> {
  const vaultPath = path.resolve(vaultPathInput);
  const vaultStat = await fsp.lstat(vaultPath).catch(() => null);
  if (!vaultStat?.isDirectory() || vaultStat.isSymbolicLink()) {
    throw new Error("partial index reconciliation 要求普通 Vault 目录");
  }
  const verifiedEvidencePaths = normalizeVerifiedEvidencePaths(
    options.verifiedEvidencePaths ?? {}
  );
  const verifiedPagePaths = Array.from(new Set([
    ...(options.verifiedPagePaths ?? []).map(normalizeRelativePath),
    ...Object.values(verifiedEvidencePaths).flat()
  ].filter((relativePath) =>
    isMarkdownPath(relativePath)
    && !isKnowledgeIndexPath(relativePath)
  ))).sort();
  const verifiedPagePathSet = new Set(verifiedPagePaths);
  const trustedSealedPagePaths = new Set(
    (options.trustedSealedPagePaths ?? []).map(normalizeRelativePath)
  );
  for (const trustedPath of trustedSealedPagePaths) {
    if (!verifiedPagePathSet.has(trustedPath)) {
      throw new Error(
        `partial index reconciliation trusted sealed 页面未绑定 verified evidence：${trustedPath}`
      );
    }
  }
  const reconciledPaths: string[] = [];
  const updatedPaths: string[] = [];
  const committed: MaintenanceIndexReconciliationCommitted[] = [];
  const deferred: MaintenanceIndexReconciliationDeferred[] = [];
  const plannedTargets = new Set<string>();
  const orderedIndexPaths = Array.from(new Set(indexPaths.map(normalizeRelativePath))).sort((left, right) => {
    const depth = right.split("/").length - left.split("/").length;
    return depth || left.localeCompare(right);
  });
  for (const indexPathInput of orderedIndexPaths) {
    const sourcePaths = verifiedSourcePathsForIndex(
      indexPathInput,
      verifiedEvidencePaths
    );
    try {
      if (!isKnowledgeIndexPath(indexPathInput)) {
        throw new Error(`partial index reconciliation 拒绝非索引路径：${indexPathInput}`);
      }
      const absoluteIndexPath = resolveInsideVault(vaultPath, indexPathInput);
      const parentPath = path.dirname(absoluteIndexPath);
      let baseline;
      try {
        baseline = await readMaintenanceContentFileBaseline(
          vaultPath,
          indexPathInput
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/目标不是独立普通文件/.test(message)) {
          throw new Error(`partial index reconciliation 索引不是普通文件：${indexPathInput}`);
        }
        throw error;
      }
      const parentStat = await fsp.lstat(parentPath).catch(() => null);
      if (
        parentStat
        && (!parentStat.isDirectory() || parentStat.isSymbolicLink())
      ) {
        throw new Error(`partial index reconciliation 目录不安全：${indexPathInput}`);
      }
      if (
        !parentStat
        && !trustedEvidencePagePathsForIndex(
          indexPathInput,
          trustedSealedPagePaths
        ).length
      ) {
        throw new Error(`partial index reconciliation 目录不存在且无 sealed verified 页面：${indexPathInput}`);
      }
      const existing = baseline.content?.toString("utf8")
        ?? defaultIndexPreamble(indexPathInput);
      const existingManagedTargets = extractManagedIndexTargets(
        existing,
        indexPathInput
      );
      const outsideManagedBlock = removeManagedIndexBlock(existing);
      const targetPaths = await liveIndexTargets(
        vaultPath,
        indexPathInput,
        [
          ...existingManagedTargets,
          ...verifiedTargetsForIndex(indexPathInput, verifiedPagePaths)
        ],
        plannedTargets,
        trustedSealedPagePaths
      );
      const missingFromCuratedIndex = targetPaths.filter((targetPath) =>
        !indexTextMentionsPath(outsideManagedBlock, indexPathInput, targetPath));
      const managedBlock = buildManagedIndexBlock(missingFromCuratedIndex);
      const next = `${outsideManagedBlock.trimEnd()}${managedBlock ? `\n\n${managedBlock}` : ""}\n`;
      reconciledPaths.push(indexPathInput);
      plannedTargets.add(indexPathInput);
      if (next === existing) continue;
      const draft = asMaintenanceWorkflowManagedUpsertDraft(
        "index",
        maintenanceContentUpsertPlan(baseline, next, {
          includeExpectedContent: baseline.content !== null
        })
      );
      const result = maintenanceContentFileCas(
        draft.desiredContent,
        draft.desiredMode
      );
      committed.push({
        ...draft,
        kind: "index",
        result,
        sourcePaths
      });
      updatedPaths.push(indexPathInput);
    } catch (error) {
      deferred.push({
        relativePath: indexPathInput,
        sourcePaths,
        reason: error instanceof Error ? error.message : String(error)
      });
    }
  }
  const warnings = [
    ...maintenanceIndexReconciliationWarning(
      { reconciledPaths, updatedPaths },
      { skippedAgentIndexPaths: options.skippedAgentIndexPaths }
    ),
    ...(deferred.length ? [{
      id: "partial-index-deferred",
      message: `有 ${deferred.length} 个共享索引未进入本轮提交，已保留原文件并等待下轮恢复：${deferred.map((item) => item.relativePath).join("、")}。`
    }] : [])
  ];
  return {
    reconciledPaths,
    updatedPaths,
    committed,
    deferred,
    warnings
  };
}

export function maintenanceIndexReconciliationWarning(
  result: MaintenanceIndexReconciliationResult,
  options: { skippedAgentIndexPaths?: readonly string[] } = {}
): KnowledgeBaseRunWarning[] {
  if (!result.reconciledPaths.length) return [];
  const skippedCount = options.skippedAgentIndexPaths?.length ?? 0;
  return [{
    id: "partial-index-reconciled",
    message: `${skippedCount
      ? `部分完成未直接采用 ${skippedCount} 个可能混入待处理来源的 Agent 索引改动`
      : "部分完成由 EchoInk 接管索引同步"}；已按真实已提交页面核对 ${result.reconciledPaths.length} 个索引${result.updatedPaths.length ? `，更新 ${result.updatedPaths.length} 个` : "，现有内容无需改动"}。`
  }];
}

function relatedKnowledgeIndexPaths(evidencePathInput: string): string[] {
  const evidencePath = normalizeRelativePath(evidencePathInput);
  if (isKnowledgeIndexPath(evidencePath) || !isMarkdownPath(evidencePath)) return [];
  const parts = evidencePath.split("/");
  if (parts[0] === "wiki") {
    if (parts.length < 3) return ["wiki/index.md"];
    return ["wiki/index.md", `wiki/${parts[1]}/00-索引.md`];
  }
  if (parts[0] === "projects") return ["projects/00-索引.md"];
  return [];
}

async function liveIndexTargets(
  vaultPath: string,
  indexPath: string,
  candidates: readonly string[],
  plannedTargets: ReadonlySet<string> = new Set(),
  trustedSealedPagePaths: ReadonlySet<string> = new Set()
): Promise<string[]> {
  const results: string[] = [];
  for (const candidate of Array.from(new Set(candidates.map(normalizeRelativePath))).sort()) {
    if (!targetBelongsToIndex(indexPath, candidate)) continue;
    if (
      plannedTargets.has(candidate)
      || trustedSealedPagePaths.has(candidate)
    ) {
      results.push(candidate);
      continue;
    }
    const baseline = await readMaintenanceContentFileBaseline(
      vaultPath,
      candidate
    ).catch((error) => {
      throw new Error(
        `partial index reconciliation 目标页面不安全：${candidate}（${error instanceof Error ? error.message : String(error)}）`
      );
    });
    if (baseline.expected.kind === "missing") continue;
    results.push(candidate);
  }
  return results;
}

function verifiedSourcePathsForIndex(
  indexPath: string,
  verifiedEvidencePaths: Readonly<Record<string, readonly string[]>>
): string[] {
  return Object.entries(verifiedEvidencePaths)
    .filter(([, evidencePaths]) =>
      evidencePaths.some((evidencePath) =>
        evidencePageContributesToIndex(indexPath, evidencePath)))
    .map(([sourcePath]) => sourcePath)
    .sort();
}

function trustedEvidencePagePathsForIndex(
  indexPath: string,
  trustedSealedPagePaths: ReadonlySet<string>
): string[] {
  return Array.from(trustedSealedPagePaths)
    .filter((pagePath) =>
      evidencePageContributesToIndex(indexPath, pagePath))
    .sort();
}

function evidencePageContributesToIndex(
  indexPath: string,
  evidencePath: string
): boolean {
  const normalized = normalizeRelativePath(evidencePath);
  if (!isMarkdownPath(normalized) || isKnowledgeIndexPath(normalized)) {
    return false;
  }
  if (indexPath === "wiki/index.md") {
    return normalized.startsWith("wiki/");
  }
  if (
    indexPath === "projects/00-索引.md"
    || indexPath === "projects/index.md"
  ) {
    return normalized.startsWith("projects/");
  }
  const parent = path.posix.dirname(indexPath);
  return normalized.startsWith(`${parent}/`);
}

function normalizeVerifiedEvidencePaths(
  input: Readonly<Record<string, readonly string[]>>
): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const [sourcePathInput, evidencePaths] of Object.entries(input)) {
    const sourcePath = normalizeRelativePath(sourcePathInput);
    if (!sourcePath.startsWith("raw/")) {
      throw new Error(
        `partial index reconciliation verified source 不是 Raw：${sourcePathInput}`
      );
    }
    result[sourcePath] = Array.from(new Set(
      evidencePaths
        .map(normalizeRelativePath)
        .filter((evidencePath) =>
          isMarkdownPath(evidencePath)
          && !isKnowledgeIndexPath(evidencePath))
    )).sort();
  }
  return result;
}

function verifiedTargetsForIndex(indexPath: string, verifiedPagePaths: readonly string[]): string[] {
  if (indexPath === "wiki/index.md") {
    return verifiedPagePaths.flatMap((pagePath) => {
      const parts = pagePath.split("/");
      if (parts[0] !== "wiki") return [];
      return parts.length >= 3 ? [`wiki/${parts[1]}/00-索引.md`] : [pagePath];
    });
  }
  if (indexPath === "projects/00-索引.md") {
    return verifiedPagePaths.filter((pagePath) => pagePath.startsWith("projects/"));
  }
  const parent = path.posix.dirname(indexPath);
  return verifiedPagePaths.filter((pagePath) => pagePath.startsWith(`${parent}/`));
}

function targetBelongsToIndex(indexPath: string, targetPath: string): boolean {
  if (!isMarkdownPath(targetPath) || targetPath === indexPath) return false;
  if (indexPath === "wiki/index.md") {
    if (!targetPath.startsWith("wiki/")) return false;
    const parts = targetPath.split("/");
    return parts.length === 2 || (parts.length === 3 && isKnowledgeIndexPath(targetPath));
  }
  if (indexPath === "projects/00-索引.md") {
    return targetPath.startsWith("projects/") && !isKnowledgeIndexPath(targetPath);
  }
  const parent = path.posix.dirname(indexPath);
  return targetPath.startsWith(`${parent}/`) && !isKnowledgeIndexPath(targetPath);
}

function removeManagedIndexBlock(text: string): string {
  const start = text.indexOf(MANAGED_INDEX_START);
  if (start < 0) {
    if (text.includes(MANAGED_INDEX_END)) throw new Error("partial index reconciliation 检测到损坏的结束标记");
    return text;
  }
  const end = text.indexOf(MANAGED_INDEX_END, start);
  if (end < 0) throw new Error("partial index reconciliation 检测到损坏的开始标记");
  if (text.indexOf(MANAGED_INDEX_START, start + MANAGED_INDEX_START.length) >= 0) {
    throw new Error("partial index reconciliation 检测到重复的托管区块");
  }
  return `${text.slice(0, start)}${text.slice(end + MANAGED_INDEX_END.length)}`;
}

function extractManagedIndexTargets(text: string, indexPath: string): string[] {
  const start = text.indexOf(MANAGED_INDEX_START);
  if (start < 0) return [];
  const end = text.indexOf(MANAGED_INDEX_END, start);
  if (end < 0) return [];
  return extractIndexLinkTargets(text.slice(start + MANAGED_INDEX_START.length, end), indexPath);
}

function extractIndexLinkTargets(text: string, indexPath: string): string[] {
  const targets: string[] = [];
  for (const match of text.matchAll(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g)) {
    const rawTarget = normalizeRelativePath(match[1].trim().replace(/^\/+/, ""));
    if (!rawTarget) continue;
    const rooted = rawTarget.startsWith("wiki/") || rawTarget.startsWith("projects/")
      ? rawTarget
      : normalizeRelativePath(path.posix.join(path.posix.dirname(indexPath), rawTarget));
    targets.push(isMarkdownPath(rooted) ? rooted : `${rooted}.md`);
  }
  return Array.from(new Set(targets));
}

function buildManagedIndexBlock(targetPaths: string[]): string {
  if (!targetPaths.length) return "";
  return [
    MANAGED_INDEX_START,
    "## EchoInk 已验证页面",
    "",
    ...targetPaths.map((targetPath) => `- [[${withoutMarkdownExtension(targetPath)}|${path.posix.basename(withoutMarkdownExtension(targetPath))}]]`),
    MANAGED_INDEX_END
  ].join("\n");
}

function indexTextMentionsPath(text: string, indexPath: string, targetPath: string): boolean {
  const normalizedTarget = normalizeRelativePath(targetPath);
  return extractIndexLinkTargets(text, indexPath).includes(normalizedTarget);
}

function defaultIndexPreamble(indexPath: string): string {
  const title = path.posix.basename(withoutMarkdownExtension(indexPath));
  return `# ${title}`;
}

function resolveInsideVault(vaultPath: string, relativePath: string): string {
  const normalized = normalizeRelativePath(relativePath);
  if (!normalized || normalized.startsWith("/") || normalized.split("/").includes("..")) {
    throw new Error(`partial index reconciliation 路径非法：${relativePath}`);
  }
  const absolute = path.resolve(vaultPath, normalized);
  if (absolute === vaultPath || !absolute.startsWith(`${vaultPath}${path.sep}`)) {
    throw new Error(`partial index reconciliation 路径越界：${relativePath}`);
  }
  return absolute;
}

function isMarkdownPath(relativePath: string): boolean {
  return /\.(?:md|markdown)$/i.test(relativePath);
}

function withoutMarkdownExtension(relativePath: string): string {
  return relativePath.replace(/\.(?:md|markdown)$/i, "");
}

function normalizeRelativePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\/+/, "");
}
