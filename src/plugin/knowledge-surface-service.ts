import { InitializationDirectoryHistory } from "../knowledge-base/initialization-directory-history";
import { createHash } from "node:crypto";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { normalizePath, TFolder, type TFile } from "obsidian";
import type CodexForObsidianPlugin from "../main";
import { KnowledgeBaseCaptureService } from "../knowledge-base/capture";
import {
  buildKnowledgeBaseDashboardSnapshot,
  type KnowledgeBaseDashboardSnapshot
} from "../knowledge-base/dashboard";
import type {
  CodexForObsidianSettings,
  StoredAttachment
} from "../settings/settings";
import {
  apiProviderHasUsableCredential,
  apiProviderModelHadInvalidStoredReasoningEffort,
  getActiveApiProviderModel,
  newId,
  validateApiProvider
} from "../settings/settings";
import {
  isEchoInkPiReasoningEffortSupported,
  normalizeEchoInkReasoningEffort,
  resolveEchoInkPiReasoningCapabilities
} from "../settings/pi-model-catalog";
import type { ReasoningEffort } from "../types/app-server";
import {
  KnowledgeBaseInitializer,
  knowledgeInitializationParentFolder,
  knowledgeInitializationPathExists,
  type KnowledgeBaseStructureRepairProgress,
  type KnowledgeInitializationAssignment,
  type KnowledgeInitializationHost,
  type KnowledgeInitializationJob,
  type KnowledgeInitializationMode,
  type KnowledgeInitializationRole,
  type KnowledgeInitializationVaultFile
} from "../knowledge-base/initializer";
import { optimizeWikiFolderNames, type WikiFolderNameResult } from "../knowledge-base/wiki-folder-names";
import { pluginDataDir } from "./plugin-data-paths";
import { initializeNativeJournal } from "../home/native-journal";

export type KnowledgeMaintenanceSurfaceStatus = Readonly<{
  state: "ready";
  message: "";
}>;

export function resolveKnowledgeMaintenanceSubmitSnapshot(
  settings: Pick<
    CodexForObsidianSettings,
    | "activeApiProviderId"
    | "apiProviders"
    | "defaultModel"
    | "openAICodexCredential"
  >
): Readonly<{
  runtimeProviderId: string;
  modelId: string;
  reasoning: ReasoningEffort;
}> {
  const active = getActiveApiProviderModel(settings);
  if (
    !active
    || !apiProviderHasUsableCredential(
      active.provider,
      settings.openAICodexCredential
    )
    || validateApiProvider(active.provider).length > 0
  ) {
    throw new Error("知识初始化无法冻结当前 Provider/模型，请先检查 Provider 设置。");
  }
  const capabilities = resolveEchoInkPiReasoningCapabilities(
    active.provider.runtimeProviderId,
    active.model.id,
    active.model.reasoning
  );
  if (
    !capabilities.supported
    || (capabilities.supportsOff && !active.model.reasoningEnabled)
  ) {
    return Object.freeze({
      runtimeProviderId: active.provider.runtimeProviderId,
      modelId: active.model.id,
      reasoning: "none"
    });
  }
  if (apiProviderModelHadInvalidStoredReasoningEffort(
    active.provider.id,
    active.model
  )) {
    throw new Error("知识初始化发现非法思考强度，请先在 Composer 完成回落。");
  }
  const stored = normalizeEchoInkReasoningEffort(
    active.model.reasoningEffort
  );
  if (active.model.reasoningEffort !== undefined && !stored) {
    throw new Error("知识初始化发现非法思考强度，请先在 Composer 完成回落。");
  }
  const reasoning = stored ?? capabilities.defaultEffort ?? "none";
  if (!isEchoInkPiReasoningEffortSupported(capabilities, reasoning)) {
    throw new Error("知识初始化发现当前思考强度已不可用，请先在 Composer 完成回落。");
  }
  return Object.freeze({
    runtimeProviderId: active.provider.runtimeProviderId,
    modelId: active.model.id,
    reasoning
  });
}

/** Current Knowledge dashboard and capture surfaces. Pi owns agent execution. */
export class EchoInkKnowledgeSurfaceService {
  private readonly captureService: KnowledgeBaseCaptureService;
  private readonly directoryHistory: InitializationDirectoryHistory;
  private restoring = false;
  private readonly initializer: KnowledgeBaseInitializer;
  private readonly initializerReady: Promise<void>;
  private dashboardSnapshot:
    | { value: KnowledgeBaseDashboardSnapshot; signature: string; savedAt: number }
    | null = null;
  private dashboardFlight: Promise<KnowledgeBaseDashboardSnapshot> | null = null;

  private structureRevision = 0;
  private structureQueue: Promise<unknown> = Promise.resolve();
  folderOperationMessage = "";
  get directoryWritable(): boolean { return this.plugin.settings.defaultPermission !== "read-only"; }
  get folderOperationBusy(): boolean { return this.namingFlight !== null || this.restoring || this.initializer.isRunning; }
  private namingFlight: Promise<WikiFolderNameResult> | null = null;

  constructor(private readonly plugin: CodexForObsidianPlugin) {
    this.captureService = new KnowledgeBaseCaptureService(plugin);
    const host = createKnowledgeInitializationHost(plugin);
    this.directoryHistory = new InitializationDirectoryHistory({
      vaultRoot: plugin.getVaultPath(), privateRoot: host.privateRootPath,
      mkdir: (folder) => host.createFolder(folder),
      rename: (from, to, restoring) => this.renameWithLinks(from, to, restoring),
      removeEmptyFolder: async (relative) => {
        const folder = plugin.app.vault.getAbstractFileByPath(relative);
        if (folder instanceof TFolder && folder.children.length === 0) await plugin.app.vault.delete(folder);
      }
    });
    const createFolder = host.createFolder;
    host.createFolder = async (relative) => {
      const parts = relative.split("/");
      for (let i = 1; i <= parts.length; i++) {
        const folder = parts.slice(0, i).join("/");
        if (await host.pathKind(folder) === "missing") await this.directoryHistory.createdFolder(folder);
      }
      await createFolder(relative);
    };
    host.beforeStructureChange = (jobId) => this.directoryHistory.capture(jobId);
    host.withStructureMutation = (action) => this.withStructureMutation(action);
    host.optimizeWikiFolders = async (assertActive) => { await this.optimizeFolderNames(undefined, true, { assertActive }); };
    host.moveFile = async (from, to, expectedHash) => {
      if (await host.readFileHash(from) !== expectedHash) throw new Error(`源文件已变化：${from}`);
      const parent = knowledgeInitializationParentFolder(to);
      if (parent) await host.createFolder(parent);
      await this.renameTracked(from, to);
    };
    this.initializer = new KnowledgeBaseInitializer(host);
    this.initializerReady = this.initializer.initialize();
    // 插件 onload 早于 Vault 文件索引完全就绪；等 Obsidian layoutReady 后
    // 再读取并升级旧指南，否则 getFileByPath 可能暂时返回 null 而被跳过。
    plugin.app.workspace.onLayoutReady(() => {
      void this.initializerReady.then(async () => {
        try {
          await this.initializer.refreshManagedGuide();
        } catch (error) {
          // 指南升级是可选维护，不得阻断知识库设置与既有初始化恢复链。
          console.error("EchoInk managed knowledge guide refresh failed", error);
        }
      }).catch((error) => {
        console.error("EchoInk knowledge initializer failed before guide refresh", error);
      });
    });
  }

  get isRunning(): boolean {
    return this.initializer.isRunning;
  }

  get maintenanceRecoveryStatus(): KnowledgeMaintenanceSurfaceStatus {
    return { state: "ready", message: "" };
  }

  async withStructureMutation<T>(action: () => Promise<T>, authorized = false): Promise<T> {
    const run = this.structureQueue.then(() => {
      if (!authorized && this.plugin.settings.defaultPermission === "read-only") throw new Error("工作区只读，不能改变目录。");
      return action().finally(() => { this.structureRevision++; this.dashboardSnapshot = null; });
    });
    this.structureQueue = run.catch(() => undefined);
    return run;
  }

  optimizeFolderNames(onProgress?: (message: string) => void, initialization = false, maintenance?: { assertActive(): void; authorized?: boolean }): Promise<WikiFolderNameResult> {
    if (this.namingFlight) return this.namingFlight;
    if (this.initializer.isRunning && !initialization) return Promise.reject(new Error("初始化进行中，请稍后再优化目录。"));
    this.namingFlight = this.withStructureMutation(async () => {
      const vault = this.plugin.app.vault;
      try {
        return await optimizeWikiFolderNames({
          folders: () => vault.getAllLoadedFiles().filter((file): file is TFolder => file instanceof TFolder)
            .map((folder) => ({ path: folder.path, titles: folder.children.filter((file) => !(file instanceof TFolder)).map((file) => file.name) })),
          assertActive: maintenance?.assertActive,
          generate: (systemPrompt, userPrompt) => this.plugin.generateWikiFolderNames(systemPrompt, userPrompt),
          exists: (target) => vault.getAbstractFileByPath(target) !== null,
          unsafeReason: (source) => this.renameUnsafeReason(source),
          rename: async (source, target) => {
            const folder = vault.getAbstractFileByPath(source);
            if (!(folder instanceof TFolder)) throw new Error("目录已变化");
            if (await knowledgeInitializationPathHasSymbolicLink(this.plugin.getVaultPath(), source)) throw new Error("符号链接目录保持原位");
            maintenance?.assertActive();
            await this.renameTracked(source, target, maintenance?.assertActive);
          }
        }, onProgress);
      } finally {
        this.dashboardSnapshot = null;
        this.plugin.refreshKnowledgeBaseSurfaces();
      }
    }, maintenance?.authorized === true).finally(() => { this.namingFlight = null; });
    return this.namingFlight;
  }

  private renameUnsafeReason(source: string): string | null {
    const cache = this.plugin.app.metadataCache;
    const targets = this.plugin.app.vault.getFiles().filter((file) => file.path === source || file.path.startsWith(`${source}/`));
    const affected = new Set(targets.map((file) => file.path));
    const linked = Object.entries(cache.resolvedLinks).filter(([, links]) => Object.keys(links).some((to) => affected.has(to)));
    const relativeOutgoing = targets.some((file) => {
      const metadata = cache.getFileCache(file);
      return [...(metadata?.links ?? []), ...(metadata?.embeds ?? [])].some((link) => /^(?:\.\.?\/)/u.test(link.link));
    });
    if (linked.some(([from, links]) => from.startsWith("raw/") && Object.keys(links).some((to) => affected.has(to)))) return "Raw 引用了此目录，改名会改写 Raw，已保留原路径";
    const autoLinks = (this.plugin.app.vault as unknown as { getConfig(key: string): unknown }).getConfig("alwaysUpdateLinks");
    if ((linked.length || relativeOutgoing) && autoLinks !== true) return "请在 Obsidian 开启自动更新内部链接，再重试此目录";
    const names = new Set(targets.map((file) => file.basename));
    if (Object.values(cache.unresolvedLinks).some((links) => Object.keys(links).some((link) => link.includes(source) || names.has(link)))) return "存在无法确认目标的引用，已保留原路径";
    return null;
  }

  private async renameTracked(source: string, target: string, assertActive?: () => void): Promise<void> {
    await this.directoryHistory.rename(source, target, assertActive);
  }

  private async renameWithLinks(source: string, target: string, restoring = false): Promise<void> {
    // Initialization already owns link-aware file moves. Wiki-only Raw protection
    // must not reject the next note merely because an earlier note moved to Raw.
    if (restoring && source.startsWith("wiki/") && target.startsWith("wiki/")) {
      const reason = this.renameUnsafeReason(source);
      if (reason) throw new Error(reason);
    }
    const file = this.plugin.app.vault.getAbstractFileByPath(source);
    if (!file) throw new Error(`源路径不存在：${source}`);
    if (this.plugin.app.vault.getAbstractFileByPath(target)) throw new Error(`目标已存在：${target}`);
    await this.plugin.app.fileManager.renameFile(file, target);
  }

  async getOriginalDirectoryStatus() { return this.directoryHistory.status(); }

  async restoreOriginalDirectories(onProgress?: (message: string) => void) {
    if (this.restoring || this.initializer.isRunning) throw new Error("已有目录操作进行中，请稍后重试。");
    this.restoring = true;
    try {
      return await this.withStructureMutation(async () => {
        await this.initializerReady;
        const result = await this.directoryHistory.restore(onProgress);
        await this.initializer.markDirectoryRestored();
        this.plugin.settings.knowledgeBase.initialization.status = "not-started";
        await this.plugin.saveSettings(true);
        return result;
      });
    } finally {
      this.restoring = false;
      this.dashboardSnapshot = null;
      this.plugin.refreshKnowledgeBaseSurfaces();
    }
  }

  async getDashboardSnapshot(): Promise<KnowledgeBaseDashboardSnapshot> {
    const revision = this.structureRevision;
    const signature = JSON.stringify(this.plugin.settings.knowledgeBase);
    const now = Date.now();
    if (
      this.dashboardSnapshot
      && this.dashboardSnapshot.signature === signature
      && now - this.dashboardSnapshot.savedAt <= 5_000
    ) {
      return this.dashboardSnapshot.value;
    }
    if (!this.dashboardFlight) {
      this.dashboardFlight = buildKnowledgeBaseDashboardSnapshot(
        this.plugin.getVaultPath(),
        this.plugin.settings.knowledgeBase
      ).then((value) => {
        if (revision === this.structureRevision) this.dashboardSnapshot = { value, signature, savedAt: Date.now() };
        return value;
      }).finally(() => {
        this.dashboardFlight = null;
      });
    }
    const snapshot = await this.dashboardFlight;
    return revision === this.structureRevision ? snapshot : await this.getDashboardSnapshot();
  }

  async cancelMaintenance(): Promise<{ accepted: false; message: string }> {
    return {
      accepted: false,
      message: "Knowledge 维护由 Pi Agent 执行，请在普通 EchoInk 会话中使用 /maintain。"
    };
  }

  async getInitializationState(): Promise<Readonly<KnowledgeInitializationJob> | null> {
    await this.initializerReady;
    return this.initializer.snapshot();
  }

  async getKnowledgeBaseStructure() {
    await this.initializerReady;
    return await this.initializer.inspectStructure();
  }

  async restoreKnowledgeBaseStructure(
    onProgress?: (progress: Readonly<KnowledgeBaseStructureRepairProgress>) => void
  ) {
    await this.initializerReady;
    return await this.withStructureMutation(() => this.initializer.restoreStructure(onProgress));
  }

  async startInitialization(
    mode: KnowledgeInitializationMode
  ): Promise<Readonly<KnowledgeInitializationJob>> {
    await this.initializerReady;
    return await this.initializer.startPreview(mode);
  }

  async assignInitializationNote(
    sourcePath: string,
    role: KnowledgeInitializationRole
  ): Promise<Readonly<KnowledgeInitializationJob>> {
    await this.initializerReady;
    return await this.initializer.assign(sourcePath, role);
  }

  async assignManyInitializationNotes(
    assignments: readonly KnowledgeInitializationAssignment[]
  ): Promise<Readonly<KnowledgeInitializationJob>> {
    await this.initializerReady;
    return await this.initializer.assignMany(assignments);
  }

  async confirmInitialization(): Promise<Readonly<KnowledgeInitializationJob>> {
    await this.initializerReady;
    return await this.withStructureMutation(() => this.initializer.confirm());
  }

  async continueInitialization(): Promise<Readonly<KnowledgeInitializationJob>> {
    await this.initializerReady;
    return await this.withStructureMutation(() => this.initializer.continueJob());
  }

  async cancelInitialization(): Promise<Readonly<KnowledgeInitializationJob> | null> {
    await this.initializerReady;
    return await this.initializer.cancel();
  }

  async captureLink(): Promise<string[]> {
    return await this.captureService.captureLink();
  }

  async captureExternalFiles(files: StoredAttachment[]): Promise<string[]> {
    return await this.captureService.captureExternalFiles(files);
  }

  async unload(): Promise<void> {}
}

function createKnowledgeInitializationHost(
  plugin: CodexForObsidianPlugin
): KnowledgeInitializationHost {
  const vaultRootPath = path.resolve(plugin.getVaultPath());
  const privateRootPath = pluginDataDir(
    vaultRootPath,
    plugin.getPluginDataDirName()
  );
  const readText = async (relativePath: string): Promise<string | null> => {
    const file = plugin.app.vault.getFileByPath(normalizePath(relativePath));
    return file ? await plugin.app.vault.cachedRead(file) : null;
  };
  const readFileHash = async (relativePath: string): Promise<string | null> => {
    const file = plugin.app.vault.getFileByPath(normalizePath(relativePath));
    if (!file) return null;
    return binaryContentHash(await plugin.app.vault.readBinary(file));
  };
  const ensureFolder = async (relativePath: string): Promise<void> => {
    const segments = normalizePath(relativePath).split("/").filter(Boolean);
    let current = "";
    for (const segment of segments) {
      current = current ? `${current}/${segment}` : segment;
      const existing = plugin.app.vault.getAbstractFileByPath(current);
      if (existing) continue;
      try {
        await plugin.app.vault.createFolder(current);
      } catch (error) {
        if (!plugin.app.vault.getAbstractFileByPath(current)) throw error;
      }
    }
  };
  return {
    vaultRootPath,
    privateRootPath,
    now: Date.now,
    async listVaultFiles(): Promise<readonly KnowledgeInitializationVaultFile[]> {
      return await Promise.all(plugin.app.vault.getFiles().map(async (file) => {
        const symbolicLink = await knowledgeInitializationPathHasSymbolicLink(
          vaultRootPath,
          file.path
        );
        return Object.freeze({
          path: file.path,
          size: file.stat.size,
          mtime: file.stat.mtime,
          extension: file.extension,
          symbolicLink
        });
      }));
    },
    readText,
    readFileHash,
    async pathExists(relativePath: string): Promise<boolean> {
      const normalized = normalizePath(relativePath);
      return await knowledgeInitializationPathExists(
        vaultRootPath,
        normalized,
        plugin.app.vault.getAbstractFileByPath(normalized) !== null
      );
    },
    async pathKind(relativePath) {
      const normalized = normalizePath(relativePath);
      const indexed = plugin.app.vault.getAbstractFileByPath(normalized);
      if (indexed) return "children" in indexed ? "folder" : "other";
      try {
        const stats = await fsp.lstat(path.resolve(vaultRootPath, normalized));
        return stats.isDirectory() ? "folder" : "other";
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
        throw error;
      }
    },
    createFolder: ensureFolder,
    configureNativeJournal: () => initializeNativeJournal(plugin.app, plugin.settings.journalDirectory),
    async createText(relativePath: string, content: string): Promise<void> {
      const normalized = normalizePath(relativePath);
      const parentFolder = knowledgeInitializationParentFolder(normalized);
      if (parentFolder) await ensureFolder(parentFolder);
      if (plugin.app.vault.getAbstractFileByPath(normalized)) {
        throw new Error(`目标已存在：${normalized}`);
      }
      await plugin.app.vault.create(normalized, content);
    },
    async createBinary(relativePath: string, content: ArrayBuffer): Promise<void> {
      const normalized = normalizePath(relativePath);
      const parentFolder = knowledgeInitializationParentFolder(normalized);
      if (parentFolder) await ensureFolder(parentFolder);
      if (plugin.app.vault.getAbstractFileByPath(normalized)) {
        throw new Error(`目标已存在：${normalized}`);
      }
      await plugin.app.vault.createBinary(normalized, content);
    },
    async updateText(relativePath: string, expectedContentHash: string, content: string): Promise<void> {
      const file = requireVaultFile(plugin, relativePath);
      await plugin.app.vault.process(file, (current) => {
        if (contentHash(current) !== expectedContentHash) {
          throw new Error(`目标内容已变化：${relativePath}`);
        }
        return content;
      });
    },
    async moveFile(sourcePath: string, targetPath: string, expectedContentHash: string): Promise<void> {
      const source = requireVaultFile(plugin, sourcePath);
      if (await readFileHash(sourcePath) !== expectedContentHash) {
        throw new Error(`源文件已变化：${sourcePath}`);
      }
      if (plugin.app.vault.getAbstractFileByPath(normalizePath(targetPath))) {
        throw new Error(`目标已存在：${targetPath}`);
      }
      const parentFolder = knowledgeInitializationParentFolder(targetPath);
      if (parentFolder) await ensureFolder(parentFolder);
      await plugin.app.fileManager.renameFile(source, normalizePath(targetPath));
    },
    currentProvider() {
      const active = getActiveApiProviderModel(plugin.settings);
      if (
        !active
        || !apiProviderHasUsableCredential(
          active.provider,
          plugin.settings.openAICodexCredential
        )
        || validateApiProvider(active.provider).length > 0
      ) return null;
      return Object.freeze({
        providerId: active.provider.id,
        model: active.model.id
      });
    },
    processedRawPaths() {
      return new Set(Object.keys(plugin.settings.knowledgeBase.processedSources));
    },
    async ensureInitializationConversation(existingConversationId: string | null): Promise<string> {
      if (existingConversationId) {
        const existing = await plugin.listPiConversations();
        if (existing.some((entry) => entry.conversationId === existingConversationId)) {
          return existingConversationId;
        }
      }
      const conversationId = newId("knowledge-initialization");
      const entry = await plugin.createPiConversation({
        conversationId,
        title: "知识库初始化",
        cwd: vaultRootPath,
        defaultMemoryMode: "normal"
      });
      if (!plugin.settings.sessions.some((session) => session.id === conversationId)) {
        plugin.settings.sessions.push({
          id: conversationId,
          title: entry.title,
          piSessionId: entry.piSessionId,
          defaultMemoryMode: entry.defaultMemoryMode,
          bodyAuthority: "pi_session_only",
          cwd: vaultRootPath,
          messages: [],
          createdAt: entry.createdAt,
          updatedAt: entry.updatedAt
        });
        await plugin.saveSettings(true);
      }
      return conversationId;
    },
    async runMaintenanceBatch(input) {
      const modelSnapshot = resolveKnowledgeMaintenanceSubmitSnapshot(
        plugin.settings
      );
      const handle = await plugin.submitPiChat({
        conversationId: input.conversationId,
        text: "/maintain",
        submittedAt: Date.now(),
        ...modelSnapshot,
        maintenanceScope: {
          mode: "batch",
          sourcePaths: Object.freeze([...input.sourcePaths])
        }
      });
      const cancel = () => void plugin.cancelHarnessRun(handle.productRunId);
      input.signal.addEventListener("abort", cancel, { once: true });
      try {
        const result = await handle.result;
        const error = result.error ?? "";
        if (result.terminalState === "cancelled") {
          return { status: "cancelled" as const, productRunId: handle.productRunId, message: error };
        }
        if (/write_uncertain/u.test(error)) {
          return { status: "write_uncertain" as const, productRunId: handle.productRunId, message: error };
        }
        if (result.terminalState !== "completed") {
          return { status: "failed" as const, productRunId: handle.productRunId, message: error || "知识分析执行未完成，未返回具体错误。" };
        }
        return {
          status: "completed" as const,
          productRunId: handle.productRunId,
          processedSourcePaths: Object.freeze([...input.sourcePaths])
        };
      } finally {
        input.signal.removeEventListener("abort", cancel);
        plugin.releasePiProductionRun(handle.productRunId);
      }
    },
    async openGuide(relativePath: string): Promise<void> {
      const file = requireVaultFile(plugin, relativePath);
      await plugin.app.workspace.getLeaf("tab").openFile(file);
    },
    async markInitialized(job: Readonly<KnowledgeInitializationJob>): Promise<void> {
      plugin.settings.knowledgeBase.initialization = {
        status: "initialized",
        initializedAt: job.updatedAt,
        templateVersion: job.templateVersion,
        lastPreviewSummary: `移动 ${job.counts.move}，保留 ${job.counts.keep}，提炼 ${job.counts.extraction}，批次 ${job.expectedBatches}`
      };
      await plugin.saveSettings(true);
      plugin.refreshKnowledgeBaseSurfaces();
    },
    onStateChanged: () => plugin.refreshKnowledgeBaseSurfaces()
  };
}

function requireVaultFile(
  plugin: CodexForObsidianPlugin,
  relativePath: string
): TFile {
  const file = plugin.app.vault.getFileByPath(normalizePath(relativePath));
  if (!file) throw new Error(`找不到 Vault 文件：${relativePath}`);
  return file;
}

function contentHash(content: string): string {
  return `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
}

function binaryContentHash(content: ArrayBuffer): string {
  return `sha256:${createHash("sha256").update(Buffer.from(content)).digest("hex")}`;
}

async function knowledgeInitializationPathHasSymbolicLink(
  vaultRootPath: string,
  relativePath: string
): Promise<boolean> {
  let cursor = vaultRootPath;
  for (const segment of normalizePath(relativePath).split("/").filter(Boolean)) {
    cursor = path.join(cursor, segment);
    const stats = await fsp.lstat(cursor).catch(() => null);
    if (!stats || stats.isSymbolicLink()) return true;
  }
  return false;
}
