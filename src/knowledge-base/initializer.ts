import { knowledgeRootRole, knowledgeRolePath, rebaseKnowledgePathRecords } from "./root-paths";
import { knowledgeErrorDetail } from "./initialization-error";
import { createHash, randomUUID } from "node:crypto";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import knowledgeGuideBody from "./assets/guide/knowledge-guide.zh-CN.md";
import knowledgeFlowImageDataUrl from "./assets/guide/knowledge-flow-v1.webp";

export const KNOWLEDGE_BASE_TEMPLATE_VERSION = "onboarding-v1";
export const KNOWLEDGE_INITIALIZATION_GUIDE_PATH = "wiki/开始使用 EchoInk 知识库.md";
export const KNOWLEDGE_INITIALIZATION_GUIDE_ASSET_PATHS = Object.freeze([
  "assets/echoink-guide/knowledge-flow-v1.webp"
] as const);
export const KNOWLEDGE_INITIALIZATION_INDEX_PATH = "wiki/index.md";
export const KNOWLEDGE_INITIALIZATION_TRACKER_PATH = "outputs/.ingest-tracker.md";
export const KNOWLEDGE_INITIALIZATION_ROOTS = Object.freeze([
  "raw", "wiki", "projects", "outputs", "inbox", "journal", "work",
  "archive", "templates", "assets"
] as const);
export type KnowledgeBaseRoot = typeof KNOWLEDGE_INITIALIZATION_ROOTS[number];

export type KnowledgeInitializationMode = "recommended" | "custom";
export type KnowledgeInitializationRole =
  | "raw" | "wiki" | "projects" | "outputs" | "inbox" | "journal"
  | "work" | "archive" | "templates" | "keep";

/**
 * 新 UI 可分配的 Markdown 目标目录（assets 是附件目录，不作为 Markdown
 * 角色；keep 只保留给旧内部状态与兼容逻辑，不再是主 UI 选项）。
 */
export const KNOWLEDGE_INITIALIZATION_MARKDOWN_ROLES:
  readonly Exclude<KnowledgeInitializationRole, "keep">[] = Object.freeze([
    "raw", "wiki", "projects", "outputs", "inbox", "journal",
    "work", "archive", "templates"
  ]);

export interface KnowledgeInitializationAssignment {
  readonly sourcePath: string;
  readonly role: KnowledgeInitializationRole;
}

export function isKnowledgeInitializationRole(value: unknown): value is KnowledgeInitializationRole {
  if (typeof value !== "string") return false;
  if (value === "keep") return true;
  return (KNOWLEDGE_INITIALIZATION_MARKDOWN_ROLES as readonly string[]).includes(value);
}

/**
 * 自定义初始化里一篇笔记的默认归属：已经位于九个 Markdown 目录中的
 * 笔记保持当前目录；其他位置的 Markdown 默认进入 Raw。
 */
export function knowledgeInitializationSourceDefaultRole(
  sourcePath: string
): Exclude<KnowledgeInitializationRole, "keep"> {
  return managedMarkdownRole(sourcePath) ?? "raw";
}

export function isKnowledgeInitializationMarkdownPath(sourcePath: string): boolean {
  const extension = normalizedExtension(sourcePath);
  return extension === ".md" || extension === ".markdown";
}
export type KnowledgeInitializationPhase =
  | "scan" | "preview" | "confirmed" | "create_directories"
  | "move_notes" | "batch_extraction" | "generate_guide" | "complete";
export type KnowledgeInitializationJobStatus =
  | "preview" | "active" | "paused" | "failed_recoverable"
  | "blocked_conflict" | "write_uncertain" | "cancelled" | "initialized";
export type KnowledgeInitializationItemState =
  | "pending" | "moved" | "kept" | "ignored" | "conflict";

export interface KnowledgeInitializationVaultFile {
  readonly path: string;
  readonly size: number;
  readonly mtime: number;
  readonly extension: string;
  readonly symbolicLink: boolean;
}

export type KnowledgeBasePathKind = "missing" | "folder" | "other";
export type KnowledgeBaseStructureState = "uninitialized" | "incomplete" | "ready";

export interface KnowledgeBaseStructureSnapshot {
  readonly state: KnowledgeBaseStructureState;
  readonly existingRoots: readonly KnowledgeBaseRoot[];
  readonly missingRoots: readonly KnowledgeBaseRoot[];
  /** 同名路径存在，但不是文件夹；恢复过程绝不会覆盖或移动它。 */
  readonly conflictingRoots: readonly KnowledgeBaseRoot[];
  readonly checkedAt: number;
}

export interface KnowledgeBaseStructureRepairProgress {
  readonly completed: number;
  readonly total: number;
  readonly percent: number;
  readonly currentRoot: KnowledgeBaseRoot | null;
}

export interface KnowledgeBaseStructureRepairResult {
  readonly structure: Readonly<KnowledgeBaseStructureSnapshot>;
  readonly createdRoots: readonly KnowledgeBaseRoot[];
  readonly warnings?: readonly string[];
}

export interface KnowledgeInitializationProviderSnapshot {
  readonly providerId: string;
  readonly model: string;
}

export interface KnowledgeInitializationItem {
  readonly sourcePath: string;
  targetPath: string | null;
  role: KnowledgeInitializationRole;
  readonly sourceRevision: string;
  readonly contentHash: string;
  readonly size: number;
  readonly mtime: number;
  state: KnowledgeInitializationItemState;
  reason: string;
}

export interface KnowledgeInitializationSourceSnapshot {
  readonly path: string;
  readonly sourceRevision: string;
  readonly contentHash: string;
}

export interface KnowledgeInitializationCounts {
  readonly move: number;
  readonly keep: number;
  readonly conflict: number;
  readonly ignored: number;
  readonly extraction: number;
}

export interface KnowledgeInitializationJob {
  readonly schemaVersion: 1;
  readonly jobId: string;
  readonly templateVersion: typeof KNOWLEDGE_BASE_TEMPLATE_VERSION;
  mode: KnowledgeInitializationMode;
  phase: KnowledgeInitializationPhase;
  status: KnowledgeInitializationJobStatus;
  readonly createdAt: number;
  updatedAt: number;
  provider: KnowledgeInitializationProviderSnapshot | null;
  planDigest: string;
  confirmedDigest: string | null;
  items: KnowledgeInitializationItem[];
  extractionSources: KnowledgeInitializationSourceSnapshot[];
  extractionQueue: string[];
  extractionCursor: number;
  expectedBatches: number;
  moveCursor: number;
  createdDirectories: string[];
  conversationId: string | null;
  productRunIds: string[];
  counts: KnowledgeInitializationCounts;
  guidePath: string;
  lastError: string;
  pauseCause?: "pause_button" | "reload" | "model_cancelled" | "error";
  recoveryAction: string;
  warnings?: string[];
  pendingSourcePaths?: string[];
  analysisOnly?: boolean;
  analyzedSourcePaths?: string[];
  savePending?: boolean;
  pendingMoves?: boolean;
}

export interface KnowledgeInitializationBatchResult {
  readonly status: "completed" | "failed" | "cancelled" | "write_uncertain";
  readonly productRunId?: string;
  readonly processedSourcePaths?: readonly string[];
  readonly message?: string;
  readonly pendingSourcePaths?: readonly string[];
  readonly analysisOnly?: boolean;
}

export interface KnowledgeInitializationHost {
  readonly vaultRootPath: string;
  readonly privateRootPath: string;
  now(): number;
  resolvePath?(relativePath: string): string;
  beforeStructureChange?(jobId: string): Promise<void | readonly string[]>;
  withStructureMutation?<T>(action: () => Promise<T>): Promise<T>;
  optimizeWikiFolders?(assertActive: () => void): Promise<void>;
  listVaultFiles(): Promise<readonly KnowledgeInitializationVaultFile[]>;
  readText(relativePath: string): Promise<string | null>;
  /** 按原始字节计算哈希，适用于 Markdown、图片、PDF 等所有普通文件。 */
  readFileHash(relativePath: string): Promise<string | null>;
  pathExists(relativePath: string): Promise<boolean>;
  pathKind(relativePath: string): Promise<KnowledgeBasePathKind>;
  createFolder(relativePath: string): Promise<void>;
  configureNativeJournal?(): Promise<void>;
  createText(relativePath: string, content: string): Promise<void>;
  createBinary(relativePath: string, content: ArrayBuffer): Promise<void>;
  updateText(relativePath: string, expectedContentHash: string, content: string): Promise<void>;
  moveFile(sourcePath: string, targetPath: string, expectedContentHash: string): Promise<void>;
  readMoveState?(sourcePath: string, targetPath: string): Promise<"ready" | "already_moved" | "conflict" | "missing" | "ambiguous">;
  currentProvider(): KnowledgeInitializationProviderSnapshot | null;
  processedRawPaths(): ReadonlySet<string>;
  ensureInitializationConversation(existingConversationId: string | null): Promise<string>;
  runMaintenanceBatch(input: Readonly<{
    conversationId: string;
    sourcePaths: readonly string[];
    batchIndex: number;
    expectedBatches: number;
    signal: AbortSignal;
  }>): Promise<Readonly<KnowledgeInitializationBatchResult>>;
  openGuide(relativePath: string): Promise<void>;
  markInitialized(job: Readonly<KnowledgeInitializationJob>): Promise<void>;
  onStateChanged?(): void;
  /**
   * 仅用于失败注入回归：在持久化对应阶段返回非 null 错误即令该次写入失败。
   * 生产 host 不实现此方法（可选）。
   */
  faultInjectPersist?(stage: "plan" | "job"): Error | null;
}

const PRIVATE_JOB_DIR = "knowledge/initialization/onboarding-v1";
const JOB_FILE = "job.json";
const PLAN_DIR = "plans";
const INDEX_MARKER_START = "<!-- echoink-onboarding-kb-init:start -->";
const INDEX_MARKER_END = "<!-- echoink-onboarding-kb-init:end -->";
const EXTRACTION_BATCH_SIZE = 20;
const MAX_PROVIDER_ATTEMPTS = 1;
const FIXED_ROOTS = new Set<string>(KNOWLEDGE_INITIALIZATION_ROOTS);
// Legacy user files are protected from initialization moves, but EchoInk no longer
// reads, generates, repairs, or otherwise manages LLM-WIKI.md.
const EXCLUDED_FILENAMES = new Set(["llm-wiki.md", "agents.md"]);

interface KnowledgeInitializationGuideAsset {
  readonly path: typeof KNOWLEDGE_INITIALIZATION_GUIDE_ASSET_PATHS[number];
  readonly content: ArrayBuffer;
  readonly contentHash: string;
}

const KNOWLEDGE_INITIALIZATION_GUIDE_ASSETS:
readonly KnowledgeInitializationGuideAsset[] = Object.freeze([
  guideAsset(KNOWLEDGE_INITIALIZATION_GUIDE_ASSET_PATHS[0], knowledgeFlowImageDataUrl)
]);

export class KnowledgeBaseInitializer {
  private job: KnowledgeInitializationJob | null = null;
  private readError: string | null = null;
  private runFlight: Promise<void> | null = null;
  private abortController: AbortController | null = null;

  constructor(private readonly host: KnowledgeInitializationHost) {}

  private actualPath(relativePath: string): string { return this.host.resolvePath?.(relativePath) ?? relativePath; }

  private isReusableGuide(content: string): boolean {
    const createdAt = echoInkKnowledgeGuideCreatedAt(content);
    return isReusableEchoInkKnowledgeGuide(content) || (createdAt !== null && content === this.guide(createdAt));
  }

  private guide(now: Date): string {
    return buildKnowledgeInitializationGuideTemplate(now).replace(/\b(raw|wiki|projects|outputs|inbox|journal|work|archive|templates|assets)(?=\/|`)/gu, (root) => this.actualPath(root));
  }

  async rebasePaths(from: string, to: string): Promise<void> {
    if (!this.job) return;
    const confirmed = this.job.confirmedDigest === this.job.planDigest;
    Object.assign(this.job, rebaseKnowledgePathRecords(this.job, from, to));
    this.job.planDigest = sha256(stableJson(frozenPlanDocument(this.job)));
    if (confirmed) this.job.confirmedDigest = this.job.planDigest;
    await this.persistJob(this.job, true);
  }

  async initialize(): Promise<void> {
    try { this.job = await this.readPersistedJob(); }
    catch (error) { this.readError = `读取初始化记录：${knowledgeErrorDetail(error)}；请重新扫描，原记录会保留。`; return; }
    if (this.job?.status === "active") {
      this.job.status = "paused";
      this.job.lastError = "EchoInk 在知识库初始化期间重新启动。";
      this.job.pauseCause = "reload";
      this.job.recoveryAction = "请检查冻结计划后点击继续；不会自动重跑 Provider。";
      await this.persistJob(this.job);
    }
  }

  /**
   * 插件升级时安全刷新 EchoInk 自己生成、且从未被用户修改的指南。
   * 不创建初始化作业，不移动文件，不调用 Provider；任一内容冲突即跳过。
   */
  async refreshManagedGuide(): Promise<boolean> {
    const existingGuide = await this.host.readText(this.actualPath(KNOWLEDGE_INITIALIZATION_GUIDE_PATH));
    if (!existingGuide || !this.isReusableGuide(existingGuide)) return false;
    const createdAt = echoInkKnowledgeGuideCreatedAt(existingGuide);
    if (!createdAt) return false;
    const assets = await this.provisionGuideAssets();
    if (assets.status !== "ready") return false;
    const expectedGuide = this.guide(createdAt);
    if (existingGuide !== expectedGuide) {
      await this.host.updateText(
        this.actualPath(KNOWLEDGE_INITIALIZATION_GUIDE_PATH),
        sha256(existingGuide),
        expectedGuide
      );
    }
    return await this.host.readText(this.actualPath(KNOWLEDGE_INITIALIZATION_GUIDE_PATH)) === expectedGuide;
  }

  snapshot(): Readonly<KnowledgeInitializationJob> | null {
    if (this.readError) throw new Error(this.readError);
    return this.job ? cloneJob(this.job) : null;
  }

  /** 每次由真实 Vault 路径类型派生，不读取历史 initialized 标记。 */
  async inspectStructure(): Promise<Readonly<KnowledgeBaseStructureSnapshot>> {
    const kinds = await Promise.all(
      KNOWLEDGE_INITIALIZATION_ROOTS.map(async (root) => ({
        root,
        kind: await this.host.pathKind(this.actualPath(root))
      }))
    );
    const existingRoots = kinds
      .filter((entry) => entry.kind === "folder")
      .map((entry) => entry.root);
    const missingRoots = kinds
      .filter((entry) => entry.kind === "missing")
      .map((entry) => entry.root);
    const conflictingRoots = kinds
      .filter((entry) => entry.kind === "other")
      .map((entry) => entry.root);
    const state: KnowledgeBaseStructureState = existingRoots.length === 0
      && conflictingRoots.length === 0
      ? "uninitialized"
      : missingRoots.length === 0 && conflictingRoots.length === 0
        ? "ready"
        : "incomplete";
    return Object.freeze({
      state,
      existingRoots: Object.freeze(existingRoots),
      missingRoots: Object.freeze(missingRoots),
      conflictingRoots: Object.freeze(conflictingRoots),
      checkedAt: this.host.now()
    });
  }

  /**
   * 只补齐缺失的固定目录。现有文件夹保持原样；同名文件只报告冲突，
   * 不移动、不删除、不覆盖，也不调用 Provider 或执行笔记整理。
   */
  async restoreStructure(
    onProgress?: (progress: Readonly<KnowledgeBaseStructureRepairProgress>) => void
  ): Promise<Readonly<KnowledgeBaseStructureRepairResult>> {
    if (this.runFlight) throw new Error("知识库初始化正在运行，暂时不能恢复目录。");
    const createdRoots: KnowledgeBaseRoot[] = [];
    const warnings: string[] = [];
    const total = KNOWLEDGE_INITIALIZATION_ROOTS.length;
    const emit = (completed: number, currentRoot: KnowledgeBaseRoot | null) => {
      const progress = Object.freeze({
        completed,
        total,
        percent: Math.round((completed / total) * 100),
        currentRoot
      });
      try {
        onProgress?.(progress);
      } catch {
        // 进度观察者不能中断真实目录恢复。
      }
    };
    emit(0, null);
    for (let index = 0; index < KNOWLEDGE_INITIALIZATION_ROOTS.length; index += 1) {
      const root = KNOWLEDGE_INITIALIZATION_ROOTS[index];
      if (!root) continue;
      try {
        const kind = await this.host.pathKind(this.actualPath(root));
        if (kind === "missing") {
          await this.host.createFolder(this.actualPath(root));
          if (await this.host.pathKind(this.actualPath(root)) !== "folder") throw new Error(`创建后仍不可用`);
          createdRoots.push(root);
        } else if (kind === "other") warnings.push(`目录 ${root} 被同名文件占用，已保留；其他目录继续。`);
      } catch (error) { warnings.push(`补全目录 ${root}：${knowledgeErrorDetail(error)}`); }
      emit(index + 1, root);
    }
    try { await this.host.configureNativeJournal?.(); } catch (error) { warnings.push(`配置日记：${knowledgeErrorDetail(error)}`); }
    return Object.freeze({
      structure: await this.inspectStructure(),
      warnings: Object.freeze(warnings),
      createdRoots: Object.freeze(createdRoots)
    });
  }

  get isRunning(): boolean {
    return this.runFlight !== null;
  }

  async startPreview(mode: KnowledgeInitializationMode = "recommended"):
  Promise<Readonly<KnowledgeInitializationJob>> {
    if (this.runFlight) throw new Error("知识库初始化正在运行。");
    if (this.readError) {
      await fsp.rename(this.jobFilePath(), `${this.jobFilePath()}.invalid-${this.host.now()}`);
      this.readError = null;
    }
    const now = this.host.now();
    const files = await this.host.listVaultFiles();
    const items: KnowledgeInitializationItem[] = [];
    const existingRaw: KnowledgeInitializationSourceSnapshot[] = [];
    let ignored = 0;
    const warnings: string[] = [];
    const readHash = async (relativePath: string) => {
      try {
        const hash = await this.host.readFileHash(relativePath);
        if (hash === null) warnings.push(`读取 ${relativePath}：文件已缺失，已跳过；恢复文件后可重新扫描。`);
        return hash;
      } catch (error) {
        warnings.push(`读取 ${relativePath}：${knowledgeErrorDetail(error)}；已跳过，其他文件继续。`);
        return null;
      }
    };
    for (const file of files) {
      const relativePath = normalizeRelativePath(file.path);
      if (!relativePath || shouldExcludeFile(relativePath, file)) {
        ignored += 1;
        continue;
      }
      const isMarkdown = isKnowledgeInitializationMarkdownPath(relativePath);
      const topLevel = knowledgeRootRole(relativePath) ?? "";
      if (FIXED_ROOTS.has(topLevel)) {
        // EchoInk 体系内的内容保持原位。只有 Markdown 笔记参与
        // 自定义分配或 Raw 提炼；附件不会被当作可提炼来源。
        if (!isMarkdown) {
          ignored += 1;
          continue;
        }
        const contentHash = await readHash(relativePath);
        if (contentHash === null) {
          ignored += 1;
          continue;
        }
        if (
          topLevel === "raw"
          && knowledgeRolePath(relativePath).toLocaleLowerCase() !== "raw/index.md"
          && !this.host.processedRawPaths().has(relativePath)
        ) {
          existingRaw.push({
            path: relativePath,
            sourceRevision: fileRevision(file, contentHash),
            contentHash
          });
        }
        const managedRole = managedMarkdownRole(relativePath);
        if (mode === "custom" && managedRole) {
          items.push({
            sourcePath: relativePath,
            targetPath: null,
            role: managedRole,
            sourceRevision: fileRevision(file, contentHash),
            contentHash,
            size: file.size,
            mtime: file.mtime,
            state: "kept",
            reason: `笔记已位于 ${managedRole}，默认保持原位`
          });
        } else {
          ignored += 1;
        }
        continue;
      }
      // 推荐方案把体系外的普通 Vault 文件都安全归档到
      // raw/imported，包括 Markdown、图片、PDF 和其他附件。目标路径
      // 保留原相对层级，因此文件夹结构也在 Raw 下复现。
      const contentHash = await readHash(relativePath);
      if (contentHash === null) {
        ignored += 1;
        continue;
      }
      const targetPath = this.actualPath(importedTarget("raw", relativePath));
      const conflict = await this.host.pathExists(targetPath);
      items.push({
        sourcePath: relativePath,
        targetPath,
        role: "raw",
        sourceRevision: fileRevision(file, contentHash),
        contentHash,
        size: file.size,
        mtime: file.mtime,
        state: conflict ? "conflict" : "pending",
        reason: conflict
          ? `目标已存在：${targetPath}`
          : "体系外文件将保留原相对层级移动到 raw/imported"
      });
    }
    const job: KnowledgeInitializationJob = {
      schemaVersion: 1,
      jobId: randomUUID(),
      templateVersion: KNOWLEDGE_BASE_TEMPLATE_VERSION,
      mode,
      phase: "preview",
      status: "preview",
      createdAt: now,
      updatedAt: now,
      provider: this.host.currentProvider(),
      planDigest: "",
      confirmedDigest: null,
      items,
      extractionSources: [],
      extractionQueue: [],
      extractionCursor: 0,
      expectedBatches: 0,
      moveCursor: 0,
      createdDirectories: [],
      conversationId: null,
      productRunIds: [],
      counts: emptyCounts(),
      guidePath: this.actualPath(KNOWLEDGE_INITIALIZATION_GUIDE_PATH),
      warnings,
      lastError: "",
      recoveryAction: "确认前不会移动笔记或调用 Provider。"
    };
    refreshFrozenPlan(job, existingRaw, ignored);
    this.job = job;
    await this.persistJob(job, true);
    return cloneJob(job);
  }

  async assign(sourcePath: string, role: KnowledgeInitializationRole):
  Promise<Readonly<KnowledgeInitializationJob>> {
    return await this.assignMany([{ sourcePath, role }]);
  }

  /**
   * 批量分配笔记目标目录。clone-on-write 语义：
   * 1. 先验证所有 sourcePath 与 role，任一非法则整批不产生任何修改；
   * 2. 同一 sourcePath 只处理一次（重复时以最后一次为准）；
   * 3. 读取当前 job 后立即 structuredClone 出 nextJob；验证与 pathExists
   *    期间不修改当前 job，所有角色/目标/状态/Provider/digest 变更只写
   *    nextJob；
   * 4. nextJob 持久化成功后才替换 this.job 并触发一次 onStateChanged；
   *    持久化失败时公开缓存与磁盘都保持旧状态，绝不回传半成功结果。
   */
  async assignMany(assignments: readonly KnowledgeInitializationAssignment[]):
  Promise<Readonly<KnowledgeInitializationJob>> {
    const job = this.requirePreview();
    if (job.mode !== "custom") throw new Error("推荐模式不支持逐篇分配。");
    const itemByPath = new Map(job.items.map((item) => [item.sourcePath, item] as const));
    const planned = new Map<string, KnowledgeInitializationRole>();
    for (const assignment of assignments) {
      if (!isKnowledgeInitializationRole(assignment.role)) {
        throw new Error("无效的知识库目录角色。");
      }
      const normalizedSource = normalizeRelativePath(assignment.sourcePath);
      if (!normalizedSource || !itemByPath.has(normalizedSource)) {
        throw new Error("找不到待分配的笔记。");
      }
      if (
        !isKnowledgeInitializationMarkdownPath(normalizedSource)
        && assignment.role !== "raw"
      ) {
        throw new Error("附件不能分配到笔记目录；它们会按原路径归入 Raw。");
      }
      planned.set(normalizedSource, assignment.role);
    }
    // pathExists 只读：期间不得触碰当前 job。
    const conflictByPath = new Map<string, boolean>();
    for (const [sourcePath, role] of planned) {
      if (role === "keep" || role === managedMarkdownRole(sourcePath)) continue;
      conflictByPath.set(
        sourcePath,
        await this.host.pathExists(this.actualPath(importedTarget(role, sourcePath)))
      );
    }
    const nextJob = structuredClone(job);
    for (const [sourcePath, role] of planned) {
      const item = nextJob.items.find((candidate) => candidate.sourcePath === sourcePath);
      if (!item) continue;
      item.role = role;
      const existingRole = managedMarkdownRole(item.sourcePath);
      const remainsInExistingDirectory = role !== "keep" && role === existingRole;
      item.targetPath = role === "keep" || remainsInExistingDirectory
        ? null
        : this.actualPath(importedTarget(role, item.sourcePath));
      item.state = role === "keep" || remainsInExistingDirectory
        ? "kept"
        : conflictByPath.get(sourcePath) ? "conflict" : "pending";
      item.reason = role === "keep"
        ? "用户选择保持原位"
        : remainsInExistingDirectory
          ? `笔记已位于 ${role}，保持原位`
        : item.state === "conflict" ? `目标已存在：${item.targetPath}` : `用户分配到 ${role}`;
    }
    nextJob.provider = this.host.currentProvider();
    nextJob.confirmedDigest = null;
    refreshFrozenPlan(nextJob, existingRawSources(nextJob), nextJob.counts.ignored);
    // notify=false：持久化期间不通知；缓存真正替换后才触发一次 onStateChanged。
    await this.persistJob(nextJob, true, false);
    this.job = nextJob;
    this.host.onStateChanged?.();
    return cloneJob(nextJob);
  }

  async confirm(): Promise<Readonly<KnowledgeInitializationJob>> {
    const job = this.requirePreview();
    job.provider = this.host.currentProvider();
    for (const item of job.items.filter((item) => item.state === "conflict")) {
      this.warn(job, `保留 ${item.sourcePath}：目标 ${item.targetPath} 已存在，跳过移动。`);
    }
    job.confirmedDigest = job.planDigest;
    job.phase = "confirmed";
    job.status = "active";
    job.lastError = "";
    job.pauseCause = undefined;
    job.recoveryAction = "";
    await this.persistJob(job);
    this.startRun(job);
    return cloneJob(job);
  }

  async continueJob(): Promise<Readonly<KnowledgeInitializationJob>> {
    const job = this.requireJob();
    if (job.status === "initialized" && job.savePending) {
      await this.finishInitialization(job);
      return cloneJob(job);
    }
    if (job.status === "initialized" && (job.pendingMoves || job.pendingSourcePaths?.length)) {
      for (const [index, item] of job.items.entries()) {
        if (item.targetPath && item.state === "conflict" && job.pendingSourcePaths?.includes(item.targetPath)) {
          item.state = "pending";
          job.moveCursor = Math.min(job.moveCursor, index);
          job.pendingMoves = true;
        }
      }
      job.phase = job.pendingMoves ? "move_notes" : "batch_extraction";
      job.extractionCursor = 0;
      job.status = "paused";
    }
    if (!["paused", "failed_recoverable", "write_uncertain", "cancelled"].includes(job.status)) {
      throw new Error("当前初始化作业不需要继续。");
    }
    if (job.confirmedDigest !== job.planDigest) {
      return await this.pause(job, "paused", "冻结计划 digest 已变化。", "重新生成预览并确认。");
    }
    job.provider = this.host.currentProvider();
    job.status = "active";
    job.lastError = "";
    job.pauseCause = undefined;
    job.recoveryAction = "";
    await this.persistJob(job);
    this.startRun(job);
    return cloneJob(job);
  }

  async cancel(): Promise<Readonly<KnowledgeInitializationJob> | null> {
    if (!this.job) return null;
    this.job.status = "cancelled";
    this.job.pauseCause = "pause_button";
    this.job.lastError = "已通过暂停按钮暂停，可从当前进度继续。";
    this.job.recoveryAction = "点击“继续初始化”，从当前进度接着整理。";
    this.abortController?.abort();
    await this.persistJob(this.job);
    return cloneJob(this.job);
  }

  async markDirectoryRestored(): Promise<void> {
    if (!this.job) return;
    this.job.status = "cancelled";
    this.job.confirmedDigest = null;
    this.job.recoveryAction = "目录已执行位置恢复；再次初始化请重新生成预览。";
    await this.persistJob(this.job);
  }

  private startRun(job: KnowledgeInitializationJob): void {
    if (this.runFlight) return;
    const controller = new AbortController();
    this.abortController = controller;
    this.runFlight = this.run(job, controller.signal)
      .catch(async (error) => {
        if (job.status === "cancelled") return;
        if (job.status !== "initialized") job.status = "failed_recoverable";
        job.lastError = knowledgeErrorDetail(error);
        job.pauseCause = "error";
        job.recoveryAction = "检查错误详情后点击继续；不会回滚已完成的项目。";
        await this.persistJob(job).catch((saveError) => { job.savePending = true; this.warn(job, `保存进度：${knowledgeErrorDetail(saveError)}；完成内容已保留，继续时只补剩余状态。`); });
      })
      .finally(() => {
        if (this.abortController === controller) this.abortController = null;
        this.runFlight = null;
        this.host.onStateChanged?.();
      });
  }

  private async run(job: KnowledgeInitializationJob, signal: AbortSignal): Promise<void> {
    if (job.phase === "complete") { await this.finishInitialization(job); return; }
    if (!["batch_extraction", "generate_guide"].includes(job.phase)) {
      const prepare = async () => {
        try {
          const warnings = await this.host.beforeStructureChange?.(job.jobId);
          for (const warning of warnings ?? []) this.warn(job, warning);
        }
        catch (error) { job.pendingMoves = true; this.warn(job, `记录原目录：${knowledgeErrorDetail(error)}；移动暂停，独立分析继续。`); return; }
        await this.createDirectories(job, signal);
        if (job.status === "active") await this.moveNotes(job, signal);
      };
      try {
        if (this.host.withStructureMutation) await this.host.withStructureMutation(prepare);
        else await prepare();
      } catch (error) { this.warn(job, `本地整理：${knowledgeErrorDetail(error)}；独立分析继续。`); }
      if (job.status !== "active") return;
      await this.optionalStep(job, "优化 Wiki 分类", () => this.host.optimizeWikiFolders?.(() => assertJobActive(job, signal)) ?? Promise.resolve());
    }
    if (job.status !== "active") return;
    await this.runExtractionBatches(job, signal);
    if (job.status !== "active") return;
    if (job.pendingMoves && !job.createdDirectories.length) { job.phase = "complete"; await this.finishInitialization(job); return; }
    await this.generateGuide(job, signal);
  }

  private async createDirectories(job: KnowledgeInitializationJob, signal: AbortSignal): Promise<void> {
    job.phase = "create_directories";
    await this.persistJob(job);
    for (const root of KNOWLEDGE_INITIALIZATION_ROOTS) {
      assertNotCancelled(signal);
      await this.optionalStep(job, `创建目录 ${root}`, async () => {
        const kind = await this.host.pathKind(this.actualPath(root));
        if (kind === "other") throw new Error("同名文件已保留，此目录下的操作将跳过。");
        if (kind === "missing") await this.host.createFolder(this.actualPath(root));
        if (await this.host.pathKind(this.actualPath(root)) !== "folder") throw new Error("创建后未确认文件夹，请检查路径权限。");
        if (!job.createdDirectories.includes(root)) job.createdDirectories.push(root);
      });
      await this.persistJob(job);
    }
    assertNotCancelled(signal);
    await this.optionalStep(job, "配置日记", () => this.host.configureNativeJournal?.() ?? Promise.resolve());
  }

  private async moveNotes(job: KnowledgeInitializationJob, signal: AbortSignal): Promise<void> {
    job.phase = "move_notes";
    await this.persistJob(job);
    job.pendingMoves = false;
    for (let index = job.moveCursor; index < job.items.length; index += 1) {
      assertNotCancelled(signal);
      const item = job.items[index];
      if (item?.targetPath && item.state === "pending") {
        try {
          const before = await this.readMoveState(item);
          if (before === "ambiguous") throw new Error("上次移动位置无法确认；保留恢复记录，暂停后续移动。");
          if (before === "ready") await this.host.moveFile(item.sourcePath, item.targetPath, item.contentHash);
          else if (before !== "already_moved") {
            item.state = "conflict";
            item.reason = `移动 ${item.sourcePath} → ${item.targetPath}：${before}，已保留并跳过。`;
            this.warn(job, item.reason);
          }
          if (item.state === "pending") {
            if (await this.readMoveState(item) !== "already_moved") throw new Error("移动结果未确认；保留恢复记录，暂停后续移动。");
            item.state = "moved";
            job.warnings = (job.warnings ?? []).filter((warning) => !warning.startsWith(`移动 ${item.sourcePath} →`) && !warning.startsWith(`保留 ${item.sourcePath}：`));
          }
        } catch (error) {
          let state: string = "ambiguous";
          try { state = await this.readMoveState(item); } catch { /* preserve pending journal */ }
          if (state === "already_moved") item.state = "moved";
          else {
            item.reason = `移动 ${item.sourcePath} → ${item.targetPath}：${knowledgeErrorDetail(error)}`;
            this.warn(job, item.reason);
            if (state === "ambiguous") { job.pendingMoves = true; return; }
            item.state = "conflict";
          }
        }
      }
      job.moveCursor = index + 1;
      await this.persistJob(job);
    }
  }

  private async runExtractionBatches(job: KnowledgeInitializationJob, signal: AbortSignal): Promise<void> {
    job.phase = "batch_extraction";
    await this.persistJob(job);
    if (job.extractionQueue.length === 0) return;
    if (!job.conversationId) {
      job.conversationId = await this.host.ensureInitializationConversation(null);
      await this.persistJob(job);
    }
    while (job.extractionCursor < job.extractionQueue.length) {
      assertNotCancelled(signal);
      job.provider = this.host.currentProvider();
      const queued = job.extractionQueue.slice(job.extractionCursor, job.extractionCursor + EXTRACTION_BATCH_SIZE);
      const batch: string[] = [];
      for (const sourcePath of queued) {
        if (job.analyzedSourcePaths?.includes(sourcePath)) continue;
        try {
          const move = job.items.find((item) => item.targetPath === sourcePath);
          if (move && move.state !== "moved") throw new Error(`原文件 ${move.sourcePath} 尚未成功移动，不能使用同名目标代替`);
          if (await this.host.readFileHash(sourcePath) === null) throw new Error("文件不存在");
          batch.push(sourcePath);
        } catch (error) {
          this.warn(job, `读取 ${sourcePath}：${knowledgeErrorDetail(error)}；该来源待处理。`);
          job.pendingSourcePaths = [...new Set([...(job.pendingSourcePaths ?? []), sourcePath])];
        }
      }
      if (!batch.length) { job.extractionCursor += queued.length; await this.persistJob(job); continue; }
      let completed: Readonly<KnowledgeInitializationBatchResult> | null = null;
      for (let attempt = 1; attempt <= MAX_PROVIDER_ATTEMPTS; attempt += 1) {
        const result = await this.host.runMaintenanceBatch({
          conversationId: job.conversationId,
          sourcePaths: Object.freeze([...batch]),
          batchIndex: Math.floor(job.extractionCursor / EXTRACTION_BATCH_SIZE),
          expectedBatches: job.expectedBatches,
          signal
        });
        if (result.productRunId && !job.productRunIds.includes(result.productRunId)) {
          job.productRunIds.push(result.productRunId);
        }
        if (result.status === "completed") {
          completed = result;
          break;
        }
        if (result.status === "cancelled") {
          if (signal.aborted && job.pauseCause === "pause_button") return;
          await this.pause(job, "cancelled", result.message || "模型请求已取消，暂未取得具体原因。", "点击“继续初始化”重试未完成的笔记。");
          return;
        }
        if (result.status === "write_uncertain") {
          await this.pause(job, "write_uncertain", result.message ?? "维护写入结果不确定。",
            "先使用 Phase 3 Readback 恢复结果，再点击继续；禁止盲跑。");
          return;
        }
        if (attempt === MAX_PROVIDER_ATTEMPTS) {
          await this.pause(job, "failed_recoverable", result.message || "当前知识分析批次执行失败，未返回具体错误。",
            "查看失败原因后点击继续；已完成批次不会重跑。");
          return;
        }
      }
      const processed = new Set(completed?.processedSourcePaths ?? []);
      job.analyzedSourcePaths = [...new Set([...(job.analyzedSourcePaths ?? []), ...processed])];
      job.pendingSourcePaths = (job.pendingSourcePaths ?? []).filter((source) => !processed.has(source));
      job.warnings = (job.warnings ?? []).filter((warning) => !warning.startsWith("来源待处理：") && ![...processed].some((source) => warning.startsWith(`读取 ${source}：`)));
      const pending = batch.filter((sourcePath) => !processed.has(sourcePath));
      if (completed?.message) this.warn(job, completed.message);
      if (completed?.analysisOnly) job.analysisOnly = true;
      if (pending.length) {
        job.pendingSourcePaths = [...new Set([...(job.pendingSourcePaths ?? []), ...pending])];
        this.warn(job, `来源待处理：${pending.join("、")}；已完成分析保留。`);
      }
      job.extractionCursor += queued.length;
      await this.persistJob(job);
    }
  }

  private async generateGuide(job: KnowledgeInitializationJob, signal: AbortSignal): Promise<void> {
    assertNotCancelled(signal);
    job.phase = "generate_guide";
    await this.persistJob(job);
    const now = new Date(job.createdAt);
    await this.optionalStep(job, "生成指南", async () => {
      const expected = this.guide(now);
      const current = await this.host.readText(this.actualPath(KNOWLEDGE_INITIALIZATION_GUIDE_PATH));
      if (current !== null && current !== expected && !this.isReusableGuide(current)) throw new Error(`保留用户文件 ${this.actualPath(KNOWLEDGE_INITIALIZATION_GUIDE_PATH)}`);
      if (current === null) await this.host.createText(this.actualPath(KNOWLEDGE_INITIALIZATION_GUIDE_PATH), expected);
      else if (current !== expected && !current.includes("\ntemplate: echoink-knowledge-guide-v2\n")) await this.host.updateText(this.actualPath(KNOWLEDGE_INITIALIZATION_GUIDE_PATH), sha256(current), expected);
    });
    assertJobActive(job, signal);
    await this.optionalStep(job, "生成指南配图", async () => {
      const result = await this.provisionGuideAssets(() => assertJobActive(job, signal));
      if (result.status !== "ready") throw new Error(result.status === "conflict" ? `保留同名文件 ${result.path}` : "配图写入未确认，请检查 assets/echoink-guide。");
    });
    for (const [label, action] of [
      ["更新 Wiki 索引", () => this.ensureIndexMarker(now)],
      ["补全 Raw 索引", () => this.createTextIfMissing(this.actualPath("raw/index.md"), buildRawIndexTemplate(now))],
      ["补全处理记录", () => this.createTextIfMissing(this.actualPath(KNOWLEDGE_INITIALIZATION_TRACKER_PATH), buildTrackerTemplate(now))],
      ["打开指南", () => this.host.openGuide(this.actualPath(KNOWLEDGE_INITIALIZATION_GUIDE_PATH))]
    ] as const) {
      assertJobActive(job, signal);
      await this.optionalStep(job, label, action);
    }
    assertJobActive(job, signal);
    job.phase = "complete";
    await this.finishInitialization(job);
  }

  private async finishInitialization(job: KnowledgeInitializationJob): Promise<void> {
    job.status = "initialized";
    job.lastError = "";
    job.pauseCause = undefined;
    job.recoveryAction = "";
    job.savePending = false;
    job.warnings = (job.warnings ?? []).filter((warning) => !warning.startsWith("保存初始化状态：") && !warning.startsWith("保存进度："));
    try {
      await this.host.markInitialized(cloneJob(job));
      await this.persistJob(job);
    } catch (error) {
      job.savePending = true;
      job.lastError = `保存初始化状态：${knowledgeErrorDetail(error)}`;
      job.recoveryAction = "内容已完成；继续只补保存状态，不重跑分析或写入。";
      this.warn(job, job.lastError);
      await this.persistJob(job).catch(() => undefined);
      this.host.onStateChanged?.();
    }
  }

  private warn(job: KnowledgeInitializationJob, message: string): void {
    job.warnings = [...new Set([...(job.warnings ?? []), knowledgeErrorDetail(message)])];
  }

  private async optionalStep(job: KnowledgeInitializationJob, label: string, action: () => Promise<void>): Promise<void> {
    try { await action(); }
    catch (error) { if (isAbortError(error)) throw error; this.warn(job, `${label}：${knowledgeErrorDetail(error)}`); }
  }

  private async provisionGuideAssets(
    beforeWrite: () => void = () => undefined
  ): Promise<
    | Readonly<{ status: "ready" }>
    | Readonly<{ status: "conflict"; path: string }>
    | Readonly<{ status: "write_uncertain" }>
  > {
    const states = await Promise.all(KNOWLEDGE_INITIALIZATION_GUIDE_ASSETS.map(async (asset) => ({
      asset,
      kind: await this.host.pathKind(this.actualPath(asset.path)),
      contentHash: await this.host.readFileHash(this.actualPath(asset.path))
    })));
    for (const state of states) {
      if (state.kind === "missing" || state.contentHash === state.asset.contentHash) continue;
      return Object.freeze({ status: "conflict" as const, path: this.actualPath(state.asset.path) });
    }
    for (const state of states) {
      if (state.kind !== "missing") continue;
      beforeWrite();
      await this.host.createBinary(this.actualPath(state.asset.path), state.asset.content.slice(0));
    }
    beforeWrite();
    const readback = await Promise.all(KNOWLEDGE_INITIALIZATION_GUIDE_ASSETS.map(
      (asset) => this.host.readFileHash(this.actualPath(asset.path))
    ));
    if (readback.some((hash, index) =>
      hash !== KNOWLEDGE_INITIALIZATION_GUIDE_ASSETS[index]?.contentHash)) {
      return Object.freeze({ status: "write_uncertain" as const });
    }
    return Object.freeze({ status: "ready" as const });
  }

  private async createTextIfMissing(relativePath: string, content: string): Promise<void> {
    if (await this.host.pathExists(relativePath)) return;
    await this.host.createText(relativePath, content);
  }

  private async ensureIndexMarker(now: Date): Promise<void> {
    const block = buildWikiIndexMarkerBlock(now).replace(/\b(raw|wiki)(?=\/)/gu, (root) => this.actualPath(root));
    const current = await this.host.readText(this.actualPath(KNOWLEDGE_INITIALIZATION_INDEX_PATH));
    if (current === null) {
      await this.host.createText(this.actualPath(KNOWLEDGE_INITIALIZATION_INDEX_PATH), `# Wiki 知识索引\n\n${block}\n`);
      return;
    }
    const start = current.indexOf(INDEX_MARKER_START);
    const end = current.indexOf(INDEX_MARKER_END);
    if (start >= 0 && end >= start) return;
    if (start >= 0 || end >= 0) throw new Error("Wiki 索引生成块标记不完整，保留用户内容；请修复该标记后重试。");
    await this.host.updateText(
      this.actualPath(KNOWLEDGE_INITIALIZATION_INDEX_PATH),
      sha256(current),
      `${current.replace(/\s*$/u, "")}\n\n${block}\n`
    );
  }

  private async readMoveState(item: Readonly<KnowledgeInitializationItem>):
  Promise<"ready" | "already_moved" | "conflict" | "missing" | "ambiguous"> {
    if (!item.targetPath) return "missing";
    if (this.host.readMoveState) return this.host.readMoveState(item.sourcePath, item.targetPath);
    const [source, target] = await Promise.all([
      this.host.pathExists(item.sourcePath), this.host.pathExists(item.targetPath)
    ]);
    if (!source && target) return "already_moved";
    if (source && !target) return "ready";
    if (source && target) return "conflict";
    return "missing";
  }

  private requirePreview(): KnowledgeInitializationJob {
    const job = this.requireJob();
    if (job.phase !== "preview" || job.status !== "preview") throw new Error("当前没有可确认的初始化预览。");
    return job;
  }

  private requireJob(): KnowledgeInitializationJob {
    if (!this.job) throw new Error("尚未创建知识库初始化作业。");
    return this.job;
  }

  private async pause(
    job: KnowledgeInitializationJob,
    status: Extract<KnowledgeInitializationJobStatus,
      "paused" | "failed_recoverable" | "blocked_conflict" | "write_uncertain" | "cancelled">,
    error: string,
    recoveryAction: string
  ): Promise<Readonly<KnowledgeInitializationJob>> {
    job.status = status;
    job.pauseCause = status === "cancelled" ? "model_cancelled" : "error";
    job.lastError = error;
    job.recoveryAction = recoveryAction;
    await this.persistJob(job);
    return cloneJob(job);
  }

  private async readPersistedJob(): Promise<KnowledgeInitializationJob | null> {
    try {
      return normalizePersistedJob(JSON.parse(await fsp.readFile(this.jobFilePath(), "utf8")) as unknown);
    } catch (error) {
      if (nodeErrorCode(error) === "ENOENT") return null;
      throw error;
    }
  }

  /**
   * 持久化 job（必要时连同冻结计划）。
   *
   * 双文件提交顺序：先写 plan 文件、后写 job 文件。job 是读取入口，
   * 后写 job 保证任何时刻读到的 job 都有完整对应的 plan：
   * - plan 失败：job 未动，磁盘与缓存都是完整旧状态；
   * - plan 成功但 job 失败：把 plan 回滚为写入前的内容，仍然是完整旧状态。
   * 因此 API 抛错后重新读取，只能得到完整旧状态或完整新状态，
   * 不会得到 job 与 plan 互相矛盾的半状态。
   *
   * `notify=false` 用于 clone-on-write 提交：调用方在缓存真正替换成功
   * 之后才自行触发一次 onStateChanged；持久化失败保持静默。
   */
  private async persistJob(
    job: KnowledgeInitializationJob,
    persistPlan = false,
    notify = true
  ): Promise<void> {
    job.updatedAt = this.host.now();
    const directory = path.dirname(this.jobFilePath());
    await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
    let planPath = "";
    let previousPlan: string | null = null;
    if (persistPlan) {
      planPath = path.join(directory, PLAN_DIR, `${job.jobId}.json`);
      try {
        previousPlan = await fsp.readFile(planPath, "utf8");
      } catch (error) {
        if (nodeErrorCode(error) !== "ENOENT") throw error;
        previousPlan = null;
      }
      await fsp.mkdir(path.join(directory, PLAN_DIR), { recursive: true, mode: 0o700 });
      const planFault = this.host.faultInjectPersist?.("plan");
      if (planFault) throw planFault;
      await atomicWriteJson(planPath, frozenPlanDocument(job));
    }
    try {
      const jobFault = this.host.faultInjectPersist?.("job");
      if (jobFault) throw jobFault;
      await atomicWriteJson(this.jobFilePath(), job);
    } catch (error) {
      if (persistPlan) {
        // job 未写成功：把已写的新 plan 回滚到写入前的内容（没有旧文件则删除）。
        if (previousPlan !== null) {
          await fsp.writeFile(planPath, previousPlan, { encoding: "utf8", mode: 0o600 })
            .catch(() => {});
        } else {
          await fsp.rm(planPath, { force: true }).catch(() => {});
        }
      }
      throw error;
    }
    if (notify) this.host.onStateChanged?.();
  }

  private jobFilePath(): string {
    return path.join(this.host.privateRootPath, PRIVATE_JOB_DIR, JOB_FILE);
  }
}

function refreshFrozenPlan(
  job: KnowledgeInitializationJob,
  existingRaw: readonly KnowledgeInitializationSourceSnapshot[],
  ignored: number
): void {
  const movableRaw = job.items
    .filter((item) =>
      item.role === "raw"
      && item.targetPath
      && item.state !== "conflict"
      && isKnowledgeInitializationMarkdownPath(item.sourcePath)
    )
    .map((item) => ({
      path: item.targetPath as string,
      sourceRevision: item.sourceRevision,
      contentHash: item.contentHash
    }));
  const managedRawBySourcePath = new Map(
    job.items
      .filter((item) => managedMarkdownRole(item.sourcePath) === "raw")
      .map((item) => [item.sourcePath, item] as const)
  );
  job.extractionSources = uniqueSources([...existingRaw, ...movableRaw]);
  job.extractionQueue = job.extractionSources
    .filter((source) => {
      const managedRawItem = managedRawBySourcePath.get(source.path);
      if (!managedRawItem) return true;
      return managedRawItem.role === "raw" && managedRawItem.targetPath === null;
    })
    .map((source) => source.path);
  job.expectedBatches = Math.ceil(job.extractionQueue.length / EXTRACTION_BATCH_SIZE);
  job.counts = Object.freeze({
    move: job.items.filter((item) => item.state === "pending").length,
    keep: job.items.filter((item) => item.state === "kept").length,
    conflict: job.items.filter((item) => item.state === "conflict").length,
    ignored,
    extraction: job.extractionQueue.length
  });
  job.planDigest = sha256(stableJson(frozenPlanDocument(job)));
}

function frozenPlanDocument(job: Readonly<KnowledgeInitializationJob>): object {
  return {
    schemaVersion: job.schemaVersion,
    jobId: job.jobId,
    templateVersion: job.templateVersion,
    mode: job.mode,
    items: job.items.map((item) => ({
      sourcePath: item.sourcePath,
      targetPath: item.targetPath,
      role: item.role,
      sourceRevision: item.sourceRevision,
      contentHash: item.contentHash,
      targetMustBeMissing: item.targetPath !== null
    })),
    extractionSources: job.extractionSources,
    extractionQueue: job.extractionQueue,
    expectedBatches: job.expectedBatches,
    counts: job.counts,
    roots: KNOWLEDGE_INITIALIZATION_ROOTS
  };
}

function existingRawSources(
  job: Readonly<KnowledgeInitializationJob>
): KnowledgeInitializationSourceSnapshot[] {
  const generatedRawTargets = new Set(job.items.map((item) =>
    knowledgeRolePath(importedTarget("raw", item.sourcePath))
  ));
  // 保留扫描时发现的 Raw 来源快照，即使用户暂时把它分配到别的目录。
  // refreshFrozenPlan 会按当前角色决定它是否进入 extractionQueue；这样再
  // 移回 Raw 时仍能恢复提炼资格，同时不会把体系外笔记的旧生成目标复活。
  return job.extractionSources.filter((source) => !generatedRawTargets.has(knowledgeRolePath(source.path)));
}

function shouldExcludeFile(relativePath: string, file: Readonly<KnowledgeInitializationVaultFile>): boolean {
  const segments = relativePath.split("/");
  if (file.symbolicLink || segments.some((segment) => segment.startsWith("."))) return true;
  if (segments[0]?.toLocaleLowerCase() === "node_modules") return true;
  return EXCLUDED_FILENAMES.has(segments.at(-1)?.toLocaleLowerCase() ?? "");
}

function importedTarget(role: Exclude<KnowledgeInitializationRole, "keep">, sourcePath: string): string {
  return normalizeRelativePath(`${role}/imported/${sourcePath}`);
}

function normalizeRelativePath(value: string): string {
  const normalized = value.trim().replaceAll("\\", "/").replace(/^\/+|\/+$/gu, "");
  if (!normalized || normalized.split("/").some((segment) => !segment || segment === "." || segment === "..")) return "";
  return normalized;
}

function managedMarkdownRole(
  sourcePath: string
): Exclude<KnowledgeInitializationRole, "keep"> | null {
  const normalized = normalizeRelativePath(sourcePath);
  if (!isKnowledgeInitializationMarkdownPath(normalized)) return null;
  const topLevel = knowledgeRootRole(normalized) ?? "";
  return (KNOWLEDGE_INITIALIZATION_MARKDOWN_ROLES as readonly string[]).includes(topLevel)
    ? topLevel as Exclude<KnowledgeInitializationRole, "keep">
    : null;
}

export function knowledgeInitializationParentFolder(
  relativePath: string
): string | null {
  const normalized = normalizeRelativePath(relativePath);
  if (!normalized) throw new TypeError("knowledge_initialization_path_invalid");
  const parent = path.posix.dirname(normalized);
  return parent === "." ? null : parent;
}

export async function knowledgeInitializationPathExists(
  vaultRootPath: string,
  relativePath: string,
  indexedExists: boolean
): Promise<boolean> {
  if (indexedExists) return true;
  const normalized = normalizeRelativePath(relativePath);
  if (!normalized) throw new TypeError("knowledge_initialization_path_invalid");
  try {
    await fsp.lstat(path.resolve(vaultRootPath, normalized));
    return true;
  } catch (error) {
    if (nodeErrorCode(error) === "ENOENT") return false;
    throw error;
  }
}

function normalizedExtension(relativePath: string): string {
  return path.posix.extname(relativePath).toLocaleLowerCase();
}

function fileRevision(file: Readonly<KnowledgeInitializationVaultFile>, contentHash: string): string {
  return sha256(`${file.path}\0${file.size}\0${file.mtime}\0${contentHash}`);
}

function emptyCounts(): KnowledgeInitializationCounts {
  return Object.freeze({ move: 0, keep: 0, conflict: 0, ignored: 0, extraction: 0 });
}

function uniqueSources(
  values: readonly KnowledgeInitializationSourceSnapshot[]
): KnowledgeInitializationSourceSnapshot[] {
  const sources = new Map<string, KnowledgeInitializationSourceSnapshot>();
  for (const value of values) sources.set(value.path, value);
  return [...sources.values()].sort((left, right) => left.path.localeCompare(right.path));
}

function cloneJob(job: Readonly<KnowledgeInitializationJob>): KnowledgeInitializationJob {
  return structuredClone(job);
}

function normalizePersistedJob(value: unknown): KnowledgeInitializationJob {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("知识库初始化作业格式无效。");
  const job = value as KnowledgeInitializationJob;
  if (job.schemaVersion !== 1 || typeof job.jobId !== "string"
    || job.templateVersion !== KNOWLEDGE_BASE_TEMPLATE_VERSION
    || !Array.isArray(job.items) || !Array.isArray(job.extractionSources)
    || !Array.isArray(job.extractionQueue)) {
    throw new Error("知识库初始化作业版本无效。");
  }
  return structuredClone(job);
}

async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await fsp.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8", mode: 0o600, flag: "wx"
  });
  await fsp.rename(temporary, filePath);
}

function assertNotCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException("初始化已取消", "AbortError");
}

function assertJobActive(
  job: Readonly<KnowledgeInitializationJob>,
  signal: AbortSignal
): void {
  assertNotCancelled(signal);
  if (job.status !== "active") throw new DOMException("初始化已停止", "AbortError");
}

function nodeErrorCode(error: unknown): string {
  if (typeof error !== "object" || error === null || !("code" in error)) return "";
  const code = error.code;
  return typeof code === "string" || typeof code === "number"
    ? String(code)
    : "";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function guideAsset(
  assetPath: typeof KNOWLEDGE_INITIALIZATION_GUIDE_ASSET_PATHS[number],
  dataUrl: string
): KnowledgeInitializationGuideAsset {
  const prefix = "data:image/webp;base64,";
  if (!dataUrl.startsWith(prefix)) {
    throw new Error(`EchoInk guide asset is not an embedded WebP: ${assetPath}`);
  }
  const content = Uint8Array.from(Buffer.from(dataUrl.slice(prefix.length), "base64")).buffer;
  return Object.freeze({
    path: assetPath,
    content,
    contentHash: `sha256:${createHash("sha256").update(Buffer.from(content)).digest("hex")}`
  });
}

export function buildKnowledgeInitializationGuideTemplate(now: Date): string {
  return [
    "---",
    `created: ${formatDateTime(now)}`,
    "type: echoink-knowledge-guide",
    "template: echoink-knowledge-guide-v2",
    "---",
    "",
    knowledgeGuideBody.trim(),
    ""
  ].join("\n");
}

function buildLegacyKnowledgeInitializationGuideTemplate(now: Date): string {
  return [
    "---", `created: ${formatDateTime(now)}`, "type: echoink-knowledge-guide", "---", "",
    "# 开始使用 EchoInk 知识库", "",
    "EchoInk 使用十个固定顶层目录：`raw`、`wiki`、`projects`、`outputs`、`inbox`、`journal`、`work`、`archive`、`templates`、`assets`。",
    "", "## 核心流程", "",
    "1. 把未经提炼的 Markdown 放在 `raw/`。",
    "2. 在普通 EchoInk 会话中使用 `/maintain`，让 Agent 提炼并安全写入 `wiki/` 或 `projects/`。",
    "3. 使用 `/ask` 从 Wiki、Projects 与 Raw 中检索和回答。",
    "4. 新增资料后，在设置页点击“整理新增笔记”进行增量维护。", "",
    "> 非 Markdown 文件和附件保持原位；EchoInk 不会覆盖或删除你的既有笔记。", ""
  ].join("\n");
}

function echoInkKnowledgeGuideCreatedAt(content: string): Date | null {
  const created = /^---\ncreated: (\d{4}-\d{2}-\d{2}T\d{2}:\d{2})\ntype: echoink-knowledge-guide\n(?:template: echoink-knowledge-guide-v2\n)?---\n/u
    .exec(content)?.[1];
  if (!created) return null;
  const createdAt = new Date(`${created}:00.000Z`);
  return !Number.isNaN(createdAt.getTime()) && formatDateTime(createdAt) === created
    ? createdAt
    : null;
}

function isReusableEchoInkKnowledgeGuide(content: string): boolean {
  const createdAt = echoInkKnowledgeGuideCreatedAt(content);
  return createdAt !== null && (
    content === buildKnowledgeInitializationGuideTemplate(createdAt)
    || content === buildLegacyKnowledgeInitializationGuideTemplate(createdAt)
  );
}

function buildWikiIndexMarkerBlock(now: Date): string {
  return [
    INDEX_MARKER_START,
    `## EchoInk 知识库入口（${formatDateTime(now)}）`, "",
    `- [[${KNOWLEDGE_INITIALIZATION_GUIDE_PATH.replace(/\.md$/u, "")}|开始使用 EchoInk 知识库]]`,
    "- 原始资料：[[raw/index|Raw 索引]]",
    INDEX_MARKER_END
  ].join("\n");
}

function buildRawIndexTemplate(now: Date): string {
  return [
    "---", `created: ${formatDateTime(now)}`, "type: index", "---", "",
    "# Raw 索引", "",
    "> Raw 保存未经提炼的原始 Markdown；使用 `/maintain` 后，结构化结果进入 Wiki 或 Projects。", ""
  ].join("\n");
}

function buildTrackerTemplate(now: Date): string {
  return [
    "---", `created: ${formatDateTime(now)}`, "source: codex-echoink", "---", "",
    "# Ingest Tracker", "", "<!-- codex-echoink-kb:start -->", "",
    "- 暂无新增维护记录", "", "<!-- codex-echoink-kb:end -->", ""
  ].join("\n");
}

function formatDateTime(date: Date): string {
  return date.toISOString().slice(0, 16);
}

function isAbortError(error: unknown): boolean { return error instanceof Error && error.name === "AbortError"; }
