import { createProductionKnowledgeLinkingService } from "./knowledge-linking-production";
import { KnowledgeActivityService } from "./knowledge-activity-service";
import { DESKTOP_KNOWLEDGE_ROOT_ROLES, KNOWLEDGE_ROOT_ROLES, rebaseKnowledgeFolderBindings, knowledgePathRole, knowledgeRoleRoots } from "../knowledge-base/root-paths";
import { rebasePrivateMaintenanceRecords } from "./pi-knowledge-maintenance-production";
import { previewKnowledgeDirectoryPlan, knowledgeDirectoryPlanSignature, type KnowledgeDirectoryPlan, type KnowledgeDirectoryPlanOptions, type KnowledgeDirectoryApplyResult, type KnowledgeModuleDirectories } from "../knowledge-base/folder-plan";
import { classifyKnowledgePath, emptyKnowledgeFolderBindings, knowledgeFolderBindingsSignature, knowledgeFolderIssues, knowledgeInboxRecallExclusions, knowledgeWikiFolderSelectionIssues, normalizeKnowledgeDirectory, type KnowledgeFolderBindings } from "../knowledge-base/folder-bindings";
import { isEchoInkFinanceBase, isFinanceRootName, isLegacyFinancePath } from "../lifestyle/finance-paths";
import { knowledgePrivateRoot } from "../knowledge-base/root-paths";
import { readPrivateMaintenanceRecords, privateMaintenanceSourceScope } from "./pi-knowledge-maintenance-production";
import type { WorkbenchTaskSource } from "../home/workbench-types";
import type { PiKnowledgeMaintenanceScope } from "../harness/pi-native/contracts";
import type { PiTurnInteractionIdentity } from "./pi-turn-interaction-broker";
import { readRawDigestRegistry, writeRawDigestRegistry } from "../knowledge-base/raw-digest";
import { resolveKnowledgePath, knowledgeRootRole, rebaseKnowledgePath, rebaseKnowledgePathRecords } from "../knowledge-base/root-paths";
import { knowledgeErrorDetail } from "../knowledge-base/initialization-error";
import { InitializationDirectoryHistory, type DirectoryModuleSettings } from "../knowledge-base/initialization-directory-history";
import { createHash } from "node:crypto";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { normalizePath, Notice, TFolder, type TFile } from "obsidian";
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
  getActiveApiProviderModel,
  newId
} from "../settings/settings";
import {
  isEchoInkPiReasoningEffortSupported,
  normalizeEchoInkReasoningEffort,
  resolveEchoInkPiReasoningCapabilities
} from "../settings/pi-model-catalog";
import type { ReasoningEffort } from "../types/app-server";
import {
  KnowledgeBaseInitializer,
  knowledgeMaintenanceBatchPrompt,
  splitKnowledgeMaintenanceSources,
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
import { initializeNativeJournal, nativeRootJournalPaths, rebaseNativeJournalPaths, saveNativeJournalFolder } from "../home/native-journal";

export interface KnowledgeFolderNamePreview {
  revision: number;
  scopes: string[];
  result: WikiFolderNameResult;
}
import { captureFolderLinkRenames, applyFolderLinkRenames } from "../knowledge-base/folder-link-renames";

export type KnowledgeMaintenanceSurfaceStatus = Readonly<{
  state: "ready";
  message: "";
}>;

export { resolveKnowledgeMaintenanceSubmitSnapshot } from "../settings/knowledge-maintenance-submit";
import { resolveKnowledgeMaintenanceSubmitSnapshot } from "../settings/knowledge-maintenance-submit";

/** Current Knowledge dashboard and capture surfaces. Pi owns agent execution. */
export class EchoInkKnowledgeSurfaceService {
  readonly linking: ReturnType<typeof createProductionKnowledgeLinkingService>;
  readonly activity: KnowledgeActivityService;
  private readonly captureService: KnowledgeBaseCaptureService;
  private readonly directoryHistory: InitializationDirectoryHistory;
  private restoring = false;
  private readonly ownedRenames = new Set<string>();
  private renameSyncQueue: Promise<void> = Promise.resolve();
  private readonly initializer: KnowledgeBaseInitializer;
  private readonly initializerReady: Promise<void>;
  private dashboardSnapshot:
    | { value: KnowledgeBaseDashboardSnapshot; signature: string; savedAt: number }
    | null = null;
  private dashboardFlight: Promise<KnowledgeBaseDashboardSnapshot> | null = null;

  private structureRevision = 0;
  private structureQueue: Promise<unknown> = Promise.resolve();
  folderOperationMessage = "";
  private initializationInteraction: Readonly<PiTurnInteractionIdentity> | null = null;
  getInitializationQuestion() {
    return this.initializationInteraction ? this.plugin.piTurnInteractionBinding(this.initializationInteraction) : null;
  }
  get directoryWritable(): boolean { return this.plugin.settings.defaultPermission !== "read-only"; }
  get app() { return this.plugin.app; }
  get folderOperationBusy(): boolean { return this.namingFlight !== null || this.folderNamingBusy || this.restoring || this.directoryPlanBusy === true || this.initializer.isRunning; }
  private folderNamingBusy = false;
  private directoryPlanBusy = false;
  private namingFlight: Promise<WikiFolderNameResult> | null = null;

  constructor(private readonly plugin: CodexForObsidianPlugin) {
    this.linking = createProductionKnowledgeLinkingService(plugin);
    this.activity = new KnowledgeActivityService(this.linking, () => readPrivateMaintenanceRecords(path.join(pluginDataDir(plugin.getVaultPath(), plugin.getPluginDataDirName()), "pi-agent-product-v1", "knowledge")), () => plugin.readKnowledgeInitialActivities());
    void this.activity.ready.catch(error => console.error("EchoInk maintenance progress recovery failed", error));
    void this.linking.ready.catch(error => console.error("EchoInk knowledge linking recovery failed", error));
    this.captureService = new KnowledgeBaseCaptureService(plugin);
    const host = createKnowledgeInitializationHost(plugin, (identity) => { this.initializationInteraction = identity; });
    this.directoryHistory = new InitializationDirectoryHistory({
      vaultRoot: plugin.getVaultPath(), privateRoot: host.privateRootPath,
      mkdir: (folder) => host.createFolder(folder),
      rename: (from, to, restoring) => this.renameWithLinks(from, to, restoring),
      currentBindings: () => this.plugin.settings.knowledgeBase.folderBindings,
      restoreBindings: async (from, to, keepCurrent, originalBindings) => {
        const bindings = this.plugin.settings.knowledgeBase.folderBindings;
        if (!bindings) return;
        const restored = structuredClone(bindings);
        for (const role of Object.keys(bindings.roles) as (keyof typeof bindings.roles)[]) {
          const originalPaths = originalBindings?.roles[role].readPaths ?? (knowledgeRootRole(to) === role ? [to] : []);
          const eligible = (directory: string) => (directory === from || directory.startsWith(`${from}/`)) && originalPaths.includes(rebaseKnowledgePath(directory, from, to));
          restored.roles[role].readPaths = [...new Set(bindings.roles[role].readPaths.flatMap((directory) => eligible(directory) ? keepCurrent ? [rebaseKnowledgePath(directory, from, to), directory] : [rebaseKnowledgePath(directory, from, to)] : [directory]))];
          if (bindings.roles[role].writePath && eligible(bindings.roles[role].writePath)) restored.roles[role].writePath = rebaseKnowledgePath(bindings.roles[role].writePath, from, to);
          if (bindings.roles[role].autoOrganizePaths) restored.roles[role].autoOrganizePaths = [...new Set(bindings.roles[role].autoOrganizePaths.flatMap(directory => eligible(directory) ? keepCurrent ? [rebaseKnowledgePath(directory, from, to), directory] : [rebaseKnowledgePath(directory, from, to)] : [directory]))];
          if (bindings.roles[role].allowedSubdirectoryRoots) restored.roles[role].allowedSubdirectoryRoots = [...new Set(bindings.roles[role].allowedSubdirectoryRoots.flatMap(directory => eligible(directory) ? keepCurrent ? [rebaseKnowledgePath(directory, from, to), directory] : [rebaseKnowledgePath(directory, from, to)] : [directory]))];
          if (keepCurrent && restored.roles[role].readPaths.length > 1) restored.roles[role].compatibilityReadScopes = true;
        }
        if (restored.collectionTargets) for (const kind of ["web", "wechat"] as const) {
          const target = restored.collectionTargets[kind];
          if (target && (target === from || target.startsWith(`${from}/`)) && originalBindings?.roles.raw.readPaths.includes(rebaseKnowledgePath(target, from, to))) {
            restored.collectionTargets[kind] = rebaseKnowledgePath(target, from, to);
          }
        }
        if (knowledgeFolderBindingsSignature(restored) !== knowledgeFolderBindingsSignature(bindings)) restored.revision += 1;
        this.plugin.settings.knowledgeBase.folderBindings = restored;
        await this.plugin.saveSettings(true);
      },
      restorePlanBindings: async (original, applied) => {
        const current = this.plugin.settings.knowledgeBase.folderBindings;
        if (!current) return;
        const restored = structuredClone(current);
        const originalConfig = original ?? emptyKnowledgeFolderBindings();
        if (current.allowAgentSubfolders === applied.allowAgentSubfolders) restored.allowAgentSubfolders = originalConfig.allowAgentSubfolders;
        if (JSON.stringify(current.collectionTargets) === JSON.stringify(applied.collectionTargets)) restored.collectionTargets = structuredClone(originalConfig.collectionTargets);
        if (JSON.stringify(current.inboxRecallExclusions) === JSON.stringify(applied.inboxRecallExclusions)) restored.inboxRecallExclusions = structuredClone(originalConfig.inboxRecallExclusions);
        for (const role of Object.keys(current.roles) as (keyof typeof current.roles)[]) {
          const currentOnly = emptyKnowledgeFolderBindings(); currentOnly.roles[role] = { ...current.roles[role], autoOrganizePaths: [] };
          const appliedOnly = emptyKnowledgeFolderBindings(); appliedOnly.roles[role] = { ...applied.roles[role], autoOrganizePaths: [] };
          if (knowledgeFolderBindingsSignature(currentOnly) !== knowledgeFolderBindingsSignature(appliedOnly)) continue; // A later user edit wins.
          const binding = structuredClone(originalConfig.roles[role]);
          const retained: string[] = [];
          for (const directory of applied.roles[role].readPaths) {
            if (binding.readPaths.includes(directory)) continue;
            // Adapter deletion can resolve before the Vault cache receives its
            // event. Only content still on disk keeps a newly created binding.
            const children = await fsp.readdir(path.join(plugin.getVaultPath(), directory)).catch((error: NodeJS.ErrnoException) => {
              if (error.code === "ENOENT") return [];
              throw error;
            });
            if (children.length > 0) retained.push(directory);
          }
          binding.readPaths = [...new Set([...binding.readPaths, ...retained])];
          binding.autoOrganizePaths = [...new Set([...(binding.autoOrganizePaths ?? []), ...(current.roles[role].autoOrganizePaths ?? []).filter(directory => binding.readPaths.includes(directory))])];
          if (retained.length) {
            binding.enabled = true;
            binding.writePath ??= retained.includes(applied.roles[role].writePath ?? "") ? applied.roles[role].writePath : retained[0];
            if (binding.readPaths.length > 1) binding.compatibilityReadScopes = true;
          }
          restored.roles[role] = binding;
        }
        if (knowledgeFolderBindingsSignature(restored) === knowledgeFolderBindingsSignature(current)) return;
        restored.revision = current.revision + 1;
        const rolesOnly = (value: KnowledgeFolderBindings) => knowledgeFolderBindingsSignature(value);
        restored.configured = originalConfig.configured === true || rolesOnly(restored) !== rolesOnly(originalConfig);
        this.plugin.settings.knowledgeBase.folderBindings = restored;
        this.plugin.englishDiary?.refreshStoragePaths();
        await this.plugin.saveSettings(true);
      },
      restoreFolderLinks: async (from, to) => {
        const links = await captureFolderLinkRenames(plugin.app, from, to);
        await applyFolderLinkRenames(plugin.app, links);
      },
      restoreModuleSettings: (original, applied) => this.restoreDirectoryModuleSettings(original, applied),
      currentModuleDirectories: () => {
        const settings = this.plugin.settings;
        const native = (this.plugin.app as unknown as { internalPlugins?: { plugins?: Record<string, { instance?: { options?: { folder?: string } } }> } }).internalPlugins?.plugins;
        return [settings.journalDirectory, native?.["daily-notes"]?.instance?.options?.folder, settings.review.outputDir,
          settings.englishDiary.englishDirectory, settings.englishDiary.expressionDirectory, settings.pdfReading.originalDirectory].filter((directory): directory is string => !!directory);
      },
      removeEmptyFolder: (relative) => this.removeEmptyCreatedFolder(relative)
    });
    const createFolder = host.createFolder.bind(host) as typeof host.createFolder;
    host.createFolder = async (relative) => {
      const parts = relative.split("/");
      for (let i = 1; i <= parts.length; i++) {
        const folder = parts.slice(0, i).join("/");
        if (await host.pathKind(folder) === "missing") await this.directoryHistory.createdFolder(folder);
      }
      await createFolder(relative);
    };
    host.folderBindingsRevision = () => plugin.settings.knowledgeBase.folderBindings?.revision;
    host.beforeStructureChange = (jobId) => this.directoryHistory.capture(jobId);
    host.withStructureMutation = (action) => this.withStructureMutation(action);
    host.optimizeWikiFolders = async (assertActive) => { await this.optimizeFolderNames(undefined, true, { assertActive }); };
    host.readMoveState = (from, to) => this.directoryHistory.moveState(from, to);
    host.moveFile = async (from, to) => {
      const parent = knowledgeInitializationParentFolder(to);
      if (parent) await host.createFolder(parent);
      await this.renameTracked(from, to);
    };
    this.initializer = new KnowledgeBaseInitializer(host);
    this.initializerReady = this.initializer.initialize();
    plugin.registerEvent(plugin.app.vault.on("rename", (file, oldPath) => {
      const target = file.path;
      if (this.ownedRenames.has(`${oldPath}→${target}`)) return;
      this.renameSyncQueue = this.renameSyncQueue.then(() => this.syncRenamedPaths(oldPath, target)).catch((error) => { this.folderOperationMessage = `目录或历史路径同步未完成：${knowledgeErrorDetail(error)}`; });
    }));
    // 插件 onload 早于 Vault 文件索引完全就绪；等 Obsidian layoutReady 后
    // 再读取并升级旧指南，否则 getFileByPath 可能暂时返回 null 而被跳过。
    plugin.app.workspace.onLayoutReady(() => {
      void this.initializerReady.then(async () => {
        try {
          if (!plugin.settings.knowledgeBase.folderBindings) await this.initializer.refreshManagedGuide();
        } catch (error) {
          // 指南升级是可选维护，不得阻断知识库设置与既有初始化恢复链。
          console.error("EchoInk managed knowledge guide refresh failed", knowledgeErrorDetail(error));
        }
      }).catch((error) => {
        console.error("EchoInk knowledge initializer failed before guide refresh", knowledgeErrorDetail(error));
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
    if (this.plugin.settings.knowledgeBase.folderBindings) return Promise.reject(new Error("请先选择目录范围并预览实际改名方案。"));
    if (this.namingFlight) return this.namingFlight;
    if (this.initializer.isRunning && !initialization) return Promise.reject(new Error("初始化进行中，请稍后再优化目录。"));
    const assertActive = maintenance ? () => maintenance.assertActive() : undefined;
    this.namingFlight = this.withStructureMutation(async () => {
      const vault = this.plugin.app.vault;
      try {
        await this.directoryHistory.capture(`folder-names-${Date.now()}`);
        return await optimizeWikiFolderNames({
          folders: () => vault.getAllLoadedFiles().filter((file): file is TFolder => file instanceof TFolder)
            .map((folder) => ({ path: folder.path, titles: folder.children.filter((file) => !(file instanceof TFolder)).map((file) => file.name) })),
          assertActive,
          generate: (systemPrompt, userPrompt) => this.plugin.generateWikiFolderNames(systemPrompt, userPrompt),
          exists: (target) => vault.getAbstractFileByPath(target) !== null,
          unsafeReason: (source) => this.renameUnsafeReason(source),
          rename: async (source, target) => {
            const folder = vault.getAbstractFileByPath(source);
            if (!(folder instanceof TFolder)) throw new Error("目录已变化");
            if (await knowledgeInitializationPathHasSymbolicLink(this.plugin.getVaultPath(), source)) throw new Error("符号链接目录保持原位");
            assertActive?.();
            await this.renameTracked(source, target, assertActive);
          }
        }, onProgress);
      } finally {
        this.dashboardSnapshot = null;
        this.plugin.refreshKnowledgeBaseSurfaces();
      }
    }, maintenance?.authorized === true).finally(() => { this.namingFlight = null; });
    return this.namingFlight;
  }

  folderNameScopes(): string[] {
    const bindings = this.plugin.settings.knowledgeBase.folderBindings;
    return [...new Set(bindings ? DESKTOP_KNOWLEDGE_ROOT_ROLES.flatMap(role => bindings.roles[role].enabled ? bindings.roles[role].readPaths : []) : [])].filter(directory => this.plugin.app.vault.getAbstractFileByPath(directory) instanceof TFolder);
  }

  async previewFolderNames(scopes: readonly string[]): Promise<KnowledgeFolderNamePreview> {
    if (this.folderOperationBusy) throw new Error("目录操作进行中，请稍后重试。");
    this.folderNamingBusy = true;
    try {
    const allowed = this.folderNameScopes();
    if (!scopes.length || scopes.some(scope => !allowed.includes(scope))) throw new Error("请选择已绑定的目录范围。");
    const revision = this.plugin.settings.knowledgeBase.folderBindings?.revision ?? 0;
    const vault = this.plugin.app.vault;
    const folders = vault.getAllLoadedFiles().filter((file): file is TFolder => file instanceof TFolder).map(folder => ({ path: folder.path, titles: folder.children.filter(file => !(file instanceof TFolder)).map(file => file.name) }));
    const allPaths = new Set(folders.map(folder => folder.path));
    const result = await optimizeWikiFolderNames({
      folders: () => folders.filter(folder => scopes.some(scope => folder.path === scope || folder.path.startsWith(`${scope}/`))),
      generate: (system, prompt) => this.plugin.generateWikiFolderNames(system, prompt),
      exists: target => allPaths.has(target) || vault.getAbstractFileByPath(target) !== null,
      unsafeReason: source => this.renameUnsafeReason(source),
      rename: async (from, to) => { allPaths.delete(from); allPaths.add(to); }
    });
    if (revision !== (this.plugin.settings.knowledgeBase.folderBindings?.revision ?? 0)) throw new Error("目录配置已变化，请重新预览。");
    return { revision, scopes: [...scopes], result };
    } finally { this.folderNamingBusy = false; }
  }

  applyFolderNamePreview(preview: KnowledgeFolderNamePreview): Promise<WikiFolderNameResult> {
    if (this.folderOperationBusy) return Promise.reject(new Error("目录操作进行中，请稍后重试。"));
    this.folderNamingBusy = true;
    return this.withStructureMutation(async () => {
      if (this.initializer.isRunning) throw new Error("知识优化进行中，请稍后重试。");
      if (preview.revision !== (this.plugin.settings.knowledgeBase.folderBindings?.revision ?? 0)) throw new Error("目录配置已变化，请重新预览。");
      const allowed = this.folderNameScopes();
      if (!preview.scopes.length || preview.scopes.some(scope => !allowed.includes(scope))) throw new Error("目录范围已变化，请重新预览。");
      const result: WikiFolderNameResult = { renamed: [], skipped: [...preview.result.skipped] };
      await this.directoryHistory.capture(`folder-names-${Date.now()}`);
      for (const change of preview.result.renamed) {
        try {
          if (!preview.scopes.some(scope => change.from === scope || change.from.startsWith(`${scope}/`))) throw new Error("改名超出选定范围");
          const folder = this.plugin.app.vault.getAbstractFileByPath(change.from);
          if (!(folder instanceof TFolder) || this.plugin.app.vault.getAbstractFileByPath(change.to)) throw new Error("目录或目标已变化，请重新预览");
          const reason = this.renameUnsafeReason(change.from);
          if (reason) throw new Error(reason);
          if (await knowledgeInitializationPathHasSymbolicLink(this.plugin.getVaultPath(), change.from)) throw new Error("符号链接目录保持原位");
          await this.renameTracked(change.from, change.to);
          result.renamed.push(change);
        } catch (error) { result.skipped.push({ path: change.from, reason: knowledgeErrorDetail(error) }); }
      }
      this.plugin.refreshKnowledgeBaseSurfaces();
      return result;
    }).finally(() => { this.folderNamingBusy = false; });
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
    const autoLinks = (this.plugin.app.vault as unknown as { getConfig(key: string): unknown }).getConfig("alwaysUpdateLinks");
    if ((linked.length || relativeOutgoing) && autoLinks !== true) return "请在 Obsidian 开启自动更新内部链接，再重试此目录";
    // Unresolved links can be old broken links, folder links, or unrelated names.
    // Their presence does not establish that renaming this folder is unsafe.
    return null;
  }

  private async renameTracked(source: string, target: string, assertActive?: () => void): Promise<void> {
    await this.directoryHistory.rename(source, target, assertActive);
  }

  /** Callers pass only folders recorded as created by this operation. */
  private async removeEmptyCreatedFolder(relative: string): Promise<void> {
    const absolute = path.join(this.plugin.getVaultPath(), relative);
    const stat = await fsp.lstat(absolute).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!stat?.isDirectory() || stat.isSymbolicLink() || (await fsp.readdir(absolute)).length > 0) return;
    // Obsidian 1.14.4 routes both Vault.delete and adapter.rmdir(false) to
    // fs.rm({ recursive: false }), which rejects directories with EISDIR.
    // rmdir is atomic and cannot delete hidden or concurrently added content.
    // The host filesystem watcher reconciles the removal; binding restoration
    // above reads disk rather than waiting for that cache event.
    await fsp.rmdir(absolute);
  }

  private async renameWithLinks(source: string, target: string, restoring = false): Promise<void> {
    if (restoring) {
      const reason = this.renameUnsafeReason(source);
      if (reason) throw new Error(reason);
    }
    const file = this.plugin.app.vault.getAbstractFileByPath(source);
    if (!file) throw new Error(`源路径不存在：${source}`);
    if (this.plugin.app.vault.getAbstractFileByPath(target)) throw new Error(`目标已存在：${target}`);
    const isFolder = file instanceof TFolder;
    const folderLinks = await captureFolderLinkRenames(this.plugin.app, source, target);
    const key = `${source}→${target}`;
    this.ownedRenames.add(key);
    try { await this.plugin.app.fileManager.renameFile(file, target); await this.syncRenamedPaths(source, target); }
    finally { this.ownedRenames.delete(key); }
    await applyFolderLinkRenames(this.plugin.app, folderLinks);
  }

  private async syncRenamedPaths(from: string, to: string): Promise<void> {
    const bindings = this.plugin.settings.knowledgeBase.folderBindings;
    const wasSource = knowledgePathRole(this.plugin.getVaultPath(), from) === "raw" || knowledgePathRole(this.plugin.getVaultPath(), to) === "raw" || bindings?.roles.raw.readPaths.some((directory) => directory.startsWith(`${from}/`) || directory.startsWith(`${to}/`));
    this.plugin.settings.knowledgeBase = rebaseKnowledgePathRecords(this.plugin.settings.knowledgeBase, from, to);
    if (bindings) this.plugin.settings.knowledgeBase.folderBindings = rebaseKnowledgeFolderBindings(bindings, from, to);
    this.plugin.settings.englishDiary = rebaseKnowledgePathRecords(this.plugin.settings.englishDiary, from, to);
    const privateRoot = knowledgePrivateRoot(this.plugin.getVaultPath());
    if (privateRoot) await rebasePrivateMaintenanceRecords(privateRoot, from, to);
    await this.plugin.pdfReading?.api.rebasePaths(from, to);
    this.plugin.englishDiary?.refreshStoragePaths();
    this.plugin.settings.journalDirectory = rebaseKnowledgePath(this.plugin.settings.journalDirectory, from, to);
    for (const session of this.plugin.settings.sessions) if (session.journalDirectory) session.journalDirectory = rebaseKnowledgePath(session.journalDirectory, from, to);
    const registry = await readRawDigestRegistry(this.plugin.getVaultPath(), true);
    if (Object.keys(registry.entries).length) await writeRawDigestRegistry(this.plugin.getVaultPath(), rebaseKnowledgePathRecords(registry, from, to));
    if (wasSource) {
      for (const file of this.plugin.app.vault.getMarkdownFiles()) {
        if (!["wiki", "projects"].includes(knowledgePathRole(this.plugin.getVaultPath(), file.path) ?? "")) continue;
        const rebaseMarkers = (content: string) => content.replace(/<!--\s*echoink-source\s*:\s*(\{[^\r\n]*\})\s*-->/gu, (marker, json: string) => {
          try {
            const record = JSON.parse(json) as Record<string, unknown>;
            if (typeof record.path !== "string") return marker;
            const next = rebaseKnowledgePath(record.path, from, to);
            return next === record.path ? marker : `<!-- echoink-source: ${JSON.stringify({ ...record, path: next })} -->`;
          } catch { return marker; }
        });
        const current = await this.plugin.app.vault.cachedRead(file);
        if (rebaseMarkers(current) !== current) await this.plugin.app.vault.process(file, rebaseMarkers);
      }
      const tracker = resolveKnowledgePath(this.plugin.getVaultPath(), "outputs/.ingest-tracker.md");
      const trackerAbsolute = path.join(this.plugin.getVaultPath(), tracker);
      const currentTracker = await fsp.readFile(trackerAbsolute, "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
      if (currentTracker !== null) {
        const next = currentTracker.replace(/^(\s*-\s+`)([^`\r\n]+)(`)/gmu, (_match, prefix: string, source: string, suffix: string) => prefix + rebaseKnowledgePath(source, from, to) + suffix);
        if (next !== currentTracker) {
          // Obsidian's hidden-file process preserves its normal concurrent-write behavior.
          const file = this.plugin.app.vault.getFileByPath(tracker);
          const update = (text: string) => text.replace(/^(\s*-\s+`)([^`\r\n]+)(`)/gmu, (_match, prefix: string, source: string, suffix: string) => prefix + rebaseKnowledgePath(source, from, to) + suffix);
          if (file) await this.plugin.app.vault.process(file, update);
          else await this.plugin.app.vault.adapter.process(tracker, update);
        }
      }
    }
    await rebaseNativeJournalPaths(this.plugin.app, from, to);
    await this.initializer.rebasePaths(from, to);
    await this.plugin.saveSettings(true);
    this.dashboardSnapshot = null;
    this.plugin.refreshKnowledgeBaseSurfaces();
  }

  async getMaintenanceRecords() {
    const root = knowledgePrivateRoot(this.plugin.getVaultPath());
    if (!root) return [];
    let invalidCount = 0;
    const records = await readPrivateMaintenanceRecords(root, { onInvalidRecord: () => { invalidCount++; } });
    if (invalidCount) new Notice(this.plugin.settings.settingsLanguage === "en"
      ? `Skipped ${invalidCount} damaged maintenance record${invalidCount === 1 ? "" : "s"}.`
      : `已跳过 ${invalidCount} 条损坏的维护记录。`);
    return records;
  }

  async getOriginalDirectoryStatus() { return this.directoryHistory.status(); }

  async restoreOriginalDirectories(onProgress?: (message: string) => void) {
    if (this.restoring || this.initializer.isRunning) throw new Error("已有目录操作进行中，请稍后重试。");
    this.restoring = true;
    try {
      return await this.withStructureMutation(async () => {
        await this.initializerReady;
        const result = await this.directoryHistory.restore(onProgress);
        await this.plugin.lifestyle?.finance.reconcileAfterDirectoryRestore();
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

  /** Recheck the reminder's exact objects; the existing Conversation queue owns execution and cancellation. */
  async prepareWorkbenchMaintenance(source: Readonly<WorkbenchTaskSource>, request = ""): Promise<readonly Readonly<{
    text: string; maintenanceScope: Extract<PiKnowledgeMaintenanceScope, { mode: "batch" }>;
  }>[]> {
    if (source.signalId !== 7 || source.moduleId !== "knowledge-base") throw new Error("这条提醒不属于资料维护。");
    const pending = await privateMaintenanceSourceScope(this.plugin.getVaultPath(), { limit: Infinity, processedSources: this.plugin.settings.knowledgeBase.processedSources });
    const selected = new Set(source.objects);
    const batches = splitKnowledgeMaintenanceSources(pending.sourcePaths.filter(relative => selected.has(relative)));
    if (!batches.length) throw new Error("这批资料已处理或不再属于维护范围，请刷新工作台。");
    return Object.freeze(batches.map((paths, batchIndex) => Object.freeze({
      text: knowledgeMaintenanceBatchPrompt({ sourcePaths: paths, batchIndex, expectedBatches: batches.length, origin: "workbench", request }),
      maintenanceScope: Object.freeze({ mode: "batch" as const, sourcePaths: paths, folderBindingsRevision: pending.folderBindingsRevision })
    })));
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

  async previewDirectoryPlan(bindings: KnowledgeFolderBindings, createPaths: readonly string[], options: KnowledgeDirectoryPlanOptions = {}): Promise<KnowledgeDirectoryPlan> {
    const vault = this.plugin.app.vault;
    const vaultRoot = this.plugin.getVaultPath();
    const baseline = structuredClone(this.plugin.settings.knowledgeBase.folderBindings);
    const baseSettingsSignature = await this.directorySettingsSignature();
    const observedFiles = await Promise.all((vault.getFiles?.() ?? vault.getMarkdownFiles()).map(async file => {
      const stat = await fsp.lstat(path.join(vaultRoot, file.path)).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
      if (!stat) return null; // A removed file can briefly remain in the host cache.
      return { path: file.path, size: stat.size, mtime: stat.mtimeMs,
        symbolicLink: await knowledgeInitializationPathHasSymbolicLink(vaultRoot, file.path) };
    }));
    const files = observedFiles.filter((file): file is NonNullable<typeof file> => file !== null);
    const protectedPaths = new Set<string>();
    const protect = (directory: string | null | undefined) => { if (directory) protectedPaths.add(directory.replace(/\\/gu, "/").replace(/\/$/u, "")); };
    const privateRoot = knowledgePrivateRoot(vaultRoot);
    if (privateRoot) { const relative = path.relative(vaultRoot, privateRoot).replace(/\\/gu, "/"); if (relative && !relative.startsWith("../") && !path.isAbsolute(relative)) protect(relative); }
    protect(vault.configDir);
    protect("EchoInk/待办.md"); protect("EchoInk/待办-settings-backup.json");
    protect(this.plugin.settings.review?.outputDir);
    protect(this.plugin.settings.lifestyle?.finance.analysisDirectory);
    protect(this.plugin.lifestyle?.finance.ledger.paths().root);
    protect(this.plugin.settings.englishDiary?.englishDirectory); protect(this.plugin.settings.englishDiary?.expressionDirectory);
    this.plugin.settings.englishDiary?.legacyEnglishDirectories?.forEach(protect);
    this.plugin.settings.englishDiary?.legacyExpressionDirectories?.forEach(protect);
    protect(this.plugin.settings.pdfReading?.originalDirectory);
    for (const directory of Object.values<unknown>({ ...options.moduleDirectories })) {
      if (typeof directory !== "string" || !directory.trim()) continue;
      try { protect(normalizeKnowledgeDirectory(directory)); } catch { /* The plan reports invalid selections. */ }
    }
    protect(this.plugin.settings.journalDirectory);
    for (const [role, binding] of Object.entries(this.plugin.settings.knowledgeBase.folderBindings?.roles ?? {})) {
      if (role !== "raw") binding.readPaths.forEach(protect);
    }
    const native = (this.plugin.app as unknown as { internalPlugins?: { plugins?: Record<string, { instance?: { options?: { folder?: string } } }> } }).internalPlugins?.plugins;
    protect(native?.["daily-notes"]?.instance?.options?.folder); protect(native?.templates?.instance?.options?.folder);
    nativeRootJournalPaths(this.plugin.app, files.map(file => file.path)).forEach(protect);
    if (options.moduleDirectories?.journal?.trim() === "") {
      const rootJournalApp = { internalPlugins: { plugins: { "daily-notes": { instance: { options: { ...native?.["daily-notes"]?.instance?.options, folder: "" } } } } } } as unknown as typeof this.plugin.app;
      nativeRootJournalPaths(rootJournalApp, files.map(file => file.path)).forEach(protect);
    }
    for (const file of files) {
      const root = file.path.split("/")[0];
      if (isFinanceRootName(root) || isLegacyFinancePath(file.path)) protect(isLegacyFinancePath(file.path) ? "EchoInk/财务" : root);
      if (file.path.endsWith("/ledger.base") && vault.getFileByPath && vault.cachedRead) {
        const base = vault.getFileByPath(file.path);
        if (base && isEchoInkFinanceBase(await vault.cachedRead(base))) protect(file.path.slice(0, -"/ledger.base".length));
      }
    }
    const plan = await previewKnowledgeDirectoryPlan({ roleScope: DESKTOP_KNOWLEDGE_ROOT_ROLES, baseRevision: baseline?.revision ?? 0, baseline, baseSettingsSignature, wikiChanged: options.wikiChanged, moduleDirectories: options.moduleDirectories, mode: options.mode, bindings, createPaths, files, protectedPaths: [...protectedPaths],
      kind: async (relative) => {
        if (await knowledgeInitializationPathHasSymbolicLink(vaultRoot, relative, true)) return "other";
        const file = vault.getAbstractFileByPath(relative);
        const stat = await fsp.lstat(path.join(vaultRoot, relative)).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
        return stat ? stat.isDirectory() ? "folder" : "other" : file instanceof TFolder ? "folder" : file ? "other" : "missing";
      }, sourcePaths: files.filter(file => /\.(?:md|markdown)$/iu.test(file.path) && !file.symbolicLink).map(file => file.path) });
    if (await this.directorySettingsSignature() !== baseSettingsSignature || knowledgeFolderBindingsSignature(this.plugin.settings.knowledgeBase.folderBindings) !== knowledgeFolderBindingsSignature(baseline)) {
      plan.issues.push("文件或设置已变化，请重新核对。");
    }
    return plan;
  }

  /** Settings used by initialization; a module edit invalidates an older preview. */
  private async directorySettingsSignature(): Promise<string> {
    const settings = this.plugin.settings;
    type NativeSettings = { enabled?: boolean; loadData?(): Promise<unknown>; instance?: { options?: unknown; plugin?: NativeSettings } };
    const native = (this.plugin.app as unknown as { internalPlugins?: { plugins?: Record<string, NativeSettings> } }).internalPlugins?.plugins;
    const config = { journalDirectory: settings.journalDirectory, review: settings.review, englishDiary: settings.englishDiary,
      pdfReading: settings.pdfReading, finance: settings.lifestyle?.finance, financeRoot: this.plugin.lifestyle?.finance.ledger.paths().root,
      permission: settings.defaultPermission, dailyNotes: native?.["daily-notes"]?.instance?.options, templates: native?.templates?.instance?.options,
      dailyNotesEnabled: native?.["daily-notes"]?.enabled, templatesEnabled: native?.templates?.enabled };
    const current = JSON.stringify(config);
    const persisted = await Promise.all(["daily-notes", "templates"].map(async id => {
      const record = native?.[id];
      return await (record?.instance?.plugin ?? record)?.loadData?.();
    }));
    return createHash("sha256").update(current).update(JSON.stringify(persisted)).digest("hex");
  }

  /** Immediate binding edits are configuration only, including in read-only mode. */
  async saveDirectoryBindings(bindings: KnowledgeFolderBindings, options: { wikiChanged?: boolean } = {}): Promise<KnowledgeFolderBindings> {
    if (this.folderOperationBusy) throw new Error("已有目录操作进行中，请稍后重试。");
    const next = structuredClone(bindings);
    return await this.withStructureMutation(async () => {
      const previous = this.plugin.settings.knowledgeBase.folderBindings;
      if (previous && next.revision !== previous.revision) throw new Error("目录配置已改变，请重新选择。");
      for (const role of KNOWLEDGE_ROOT_ROLES) if (!DESKTOP_KNOWLEDGE_ROOT_ROLES.includes(role) && previous) next.roles[role] = structuredClone(previous.roles[role]);
      const baseSignature = knowledgeFolderBindingsSignature(previous);
      const exclusions = knowledgeInboxRecallExclusions(previous, next);
      if (exclusions.length || next.inboxRecallExclusions) next.inboxRecallExclusions = exclusions;
      const oldIssues = new Set(previous ? knowledgeFolderIssues(previous, DESKTOP_KNOWLEDGE_ROOT_ROLES) : []);
      const issues = knowledgeFolderIssues(next, DESKTOP_KNOWLEDGE_ROOT_ROLES).filter(issue => !oldIssues.has(issue));
      if (options.wikiChanged) issues.push(...knowledgeWikiFolderSelectionIssues(next));
      if (issues.length) throw new Error(issues.join("；"));
      const checkPaths = new Set<string>();
      for (const role of DESKTOP_KNOWLEDGE_ROOT_ROLES) {
        const binding = next.roles[role];
        if (!binding.enabled || (binding.native && ["journal", "templates"].includes(role))) continue;
        const before = previous?.roles[role];
        const newlyEnabled = !before?.enabled || (binding.searchEnabled !== false && before.searchEnabled === false);
        const newChildApproval = binding.allowedSubdirectories.some(child => !before?.allowedSubdirectories.includes(child));
        const newAgentApproval = next.allowAgentSubfolders === true && previous?.allowAgentSubfolders !== true && ["wiki", "projects"].includes(role);
        for (const directory of binding.readPaths) {
          if (!before?.readPaths.includes(directory) || newlyEnabled || newAgentApproval
            || (binding.autoOrganizePaths?.includes(directory) && !before?.autoOrganizePaths?.includes(directory))
            || (newChildApproval && (binding.allowedSubdirectoryRoots ?? binding.readPaths).includes(directory))
            || (binding.allowedSubdirectoryRoots?.includes(directory) && !before?.allowedSubdirectoryRoots?.includes(directory))
            || (binding.writePath === directory && binding.writePath !== before?.writePath)) checkPaths.add(directory);
        }
      }
      for (const kind of ["web", "wechat"] as const) {
        const target = next.collectionTargets?.[kind];
        const oldTarget = previous?.collectionTargets ? previous.collectionTargets[kind] : previous?.roles.raw.writePath;
        if (target && target !== oldTarget) {
          if (!next.roles.raw.enabled || !next.roles.raw.readPaths.includes(target)) throw new Error("收藏目的地只能选择已绑定的资料来源目录。");
          checkPaths.add(target);
        }
      }
      for (const directory of checkPaths) {
        if (normalizeKnowledgeDirectory(directory) !== directory || await knowledgeInitializationPathHasSymbolicLink(this.plugin.getVaultPath(), directory, true)) throw new Error(`${directory}：原目录已失效，请重新选择。`);
        const info = await fsp.lstat(path.join(this.plugin.getVaultPath(), directory)).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
        if (!info?.isDirectory()) throw new Error(`${directory}：原目录已失效，请重新选择。`);
      }
      if (knowledgeFolderBindingsSignature(this.plugin.settings.knowledgeBase.folderBindings) !== baseSignature) throw new Error("目录配置已改变，请重新选择。");
      next.configured = true;
      next.revision = (previous?.revision ?? 0) + 1;
      this.plugin.settings.knowledgeBase.folderBindings = next;
      try { await this.plugin.saveSettings(true); }
      catch (failure) {
        this.plugin.settings.knowledgeBase.folderBindings = previous;
        let recovery = "";
        try { await this.plugin.saveSettings(true); } catch (error) { recovery = `；原配置恢复保存失败：${knowledgeErrorDetail(error)}`; }
        throw new Error(`绑定未保存，原绑定保留：${knowledgeErrorDetail(failure)}${recovery}`);
      }
      this.dashboardSnapshot = null;
      this.plugin.refreshKnowledgeBaseSurfaces();
      return structuredClone(next);
    }, true);
  }

  async applyDirectoryPlan(plan: KnowledgeDirectoryPlan, optimize = false): Promise<KnowledgeDirectoryApplyResult> {
    if (this.folderOperationBusy || ((plan.create.length > 0 || plan.moves.length > 0 || optimize) && !this.directoryWritable)) throw new Error("当前只读或已有目录操作，请稍后重试。");
    if (plan.issues.length) throw new Error(plan.issues.join("；"));
    this.directoryPlanBusy = true;
    const result: KnowledgeDirectoryApplyResult = { configured: true, created: [], moved: [], refinement: "not-started" };
    try { return await this.withStructureMutation(async () => {
      if ((this.plugin.settings.knowledgeBase.folderBindings?.revision ?? 0) !== plan.baseRevision) throw new Error("目录配置已改变，请重新预览。");
      if (knowledgeFolderBindingsSignature(this.plugin.settings.knowledgeBase.folderBindings) !== plan.baseSignature) throw new Error("目录配置已改变，请重新预览。");
      if (await this.directorySettingsSignature() !== plan.baseSettingsSignature) throw new Error("文件或设置已变化，请重新核对；请重新预览。");
      const checked = await this.previewDirectoryPlan(plan.bindings, plan.create, { mode: plan.mode, wikiChanged: plan.wikiChanged, moduleDirectories: plan.moduleDirectories });
      if (checked.issues.length || knowledgeDirectoryPlanSignature(checked) !== knowledgeDirectoryPlanSignature(plan)) throw new Error("目录或文件已改变，请重新预览。");
      if (plan.moves.length && (this.plugin.app.vault as unknown as { getConfig(key: string): unknown }).getConfig?.("alwaysUpdateLinks") !== true) throw new Error("请在 Obsidian 开启自动更新内部链接，再重新预览搬迁。");
      const previous = this.plugin.settings.knowledgeBase.folderBindings;
      const previousDiary = structuredClone(this.plugin.settings.englishDiary);
      const previousJournal = this.plugin.settings.journalDirectory;
      const previousReview = this.plugin.settings.review.outputDir;
      const previousPdfOriginal = this.plugin.settings.pdfReading.originalDirectory;
      const previousPdfOriginalConfigured = Object.hasOwn(this.plugin.settings.pdfReading, "originalDirectory");
      const nativeJournal = plan.moduleDirectories?.journal !== undefined ? await this.captureNativeJournalSettings() : null;
      const moduleSettings = plan.moduleDirectories ? this.directoryModuleSettings(plan.moduleDirectories) : null;
      const intendedModules = moduleSettings ? structuredClone(moduleSettings) : null;
      if (intendedModules && plan.moduleDirectories) {
        const modules = plan.moduleDirectories;
        if (modules.journal !== undefined) { intendedModules.journal = modules.journal; intendedModules.nativeJournal = { folder: modules.journal }; }
        if (modules.review !== undefined) intendedModules.review = modules.review;
        if (modules.english !== undefined) intendedModules.english = { directory: modules.english, mode: "custom" };
        if (modules.expressions !== undefined) intendedModules.expressions = { directory: modules.expressions, mode: "custom" };
        if (modules.pdfOriginal !== undefined) intendedModules.pdfOriginal = { directory: modules.pdfOriginal };
      }
      let nativeJournalChanged = false;
      try {
        if (plan.create.length || plan.moves.length || moduleSettings) await this.directoryHistory.capture(`folder-plan-${Date.now()}`);
        if (moduleSettings && intendedModules) await this.directoryHistory.recordModuleSettings(moduleSettings, intendedModules);
        for (const directory of plan.create) {
          if (this.plugin.app.vault.getAbstractFileByPath(directory) || await knowledgeInitializationPathExists(this.plugin.getVaultPath(), directory, false)) throw new Error(`路径已存在：${directory}`);
          await this.directoryHistory.createdFolder(directory);
          await this.plugin.app.vault.createFolder(directory);
          result.created.push(directory);
        }
        // Validate the entire inventory once, before renameFile updates links (and
        // mtimes) in other pending files. Each move still verifies the actual path
        // and file identity through the existing durable directory journal.
        for (const move of plan.moves) {
          this.folderOperationMessage = `正在搬迁 ${result.moved.length + 1} / ${plan.moves.length}：${move.from}`;
          await this.renameTracked(move.from, move.to);
          result.moved.push(move);
        }
        this.plugin.settings.knowledgeBase.folderBindings = { ...structuredClone(plan.bindings), configured: true, revision: plan.baseRevision + 1 };
        const modules = plan.moduleDirectories;
        if (modules?.journal !== undefined) {
          nativeJournalChanged = true; // Native save can complete before its refresh hook fails.
          await saveNativeJournalFolder(this.plugin.app, modules.journal);
          this.plugin.settings.journalDirectory = modules.journal;
        }
        if (modules?.review !== undefined) this.plugin.settings.review.outputDir = modules.review;
        if (modules?.english !== undefined) {
          if (modules.english !== previousDiary.englishDirectory) this.plugin.settings.englishDiary.legacyEnglishDirectories = [...new Set([...(previousDiary.legacyEnglishDirectories ?? []), previousDiary.englishDirectory])];
          this.plugin.settings.englishDiary.englishDirectory = modules.english;
          this.plugin.settings.englishDiary.englishDirectoryMode = "custom";
        }
        if (modules?.expressions !== undefined) {
          if (modules.expressions !== previousDiary.expressionDirectory) this.plugin.settings.englishDiary.legacyExpressionDirectories = [...new Set([...(previousDiary.legacyExpressionDirectories ?? []), previousDiary.expressionDirectory])];
          this.plugin.settings.englishDiary.expressionDirectory = modules.expressions;
          this.plugin.settings.englishDiary.expressionDirectoryMode = "custom";
        }
        if (modules?.pdfOriginal !== undefined) this.plugin.settings.pdfReading.originalDirectory = modules.pdfOriginal;
        this.plugin.englishDiary?.refreshStoragePaths();
        if (moduleSettings && modules) await this.directoryHistory.recordModuleSettings(moduleSettings, this.directoryModuleSettings(modules));
        if (plan.create.length || plan.moves.length || moduleSettings) await this.directoryHistory.appliedBindings(this.plugin.settings.knowledgeBase.folderBindings);
        await this.plugin.saveSettings(true);
      } catch (failure) {
        this.plugin.settings.knowledgeBase.folderBindings = previous;
        this.plugin.settings.englishDiary = previousDiary;
        this.plugin.settings.journalDirectory = previousJournal;
        this.plugin.settings.review.outputDir = previousReview;
        if (previousPdfOriginalConfigured) this.plugin.settings.pdfReading.originalDirectory = previousPdfOriginal;
        else delete this.plugin.settings.pdfReading.originalDirectory;
        this.plugin.englishDiary?.refreshStoragePaths();
        const recovery: string[] = [];
        if (nativeJournalChanged && nativeJournal) {
          try { await nativeJournal.restore(); }
          catch (error) { recovery.push(`Obsidian 日记设置恢复：${knowledgeErrorDetail(error)}`); }
        }
        // renameFile may have completed before an integration sync failed.
        const moved = plan.moves.filter(move => !this.plugin.app.vault.getAbstractFileByPath(move.from) && this.plugin.app.vault.getAbstractFileByPath(move.to));
        for (const move of [...moved].reverse()) {
          try { await this.renameTracked(move.to, move.from); }
          catch (error) { recovery.push(`${move.to} → ${move.from}：${knowledgeErrorDetail(error)}`); }
        }
        for (const directory of [...result.created].reverse()) {
          try { await this.removeEmptyCreatedFolder(directory); }
          catch (error) { recovery.push(`${directory}：${knowledgeErrorDetail(error)}`); }
        }
        if (moduleSettings && plan.moduleDirectories) {
          try { await this.directoryHistory.recordModuleSettings(moduleSettings, this.directoryModuleSettings(plan.moduleDirectories)); }
          catch (error) { recovery.push(`模块目录恢复记录：${knowledgeErrorDetail(error)}`); }
        }
        try { await this.plugin.saveSettings(true); } catch (error) { recovery.push(`配置恢复：${knowledgeErrorDetail(error)}`); }
        throw new Error(`目录方案未应用：${knowledgeErrorDetail(failure)}。${recovery.length ? `仍需恢复 ${recovery.length} 项：${recovery.join("；")}。可在目录管理复原仓库。` : `已恢复本次搬迁的 ${moved.length} 个文件，原配置保留；请重新预览。`}`);
      }
      if (optimize && plan.sources.length) {
        try { resolveKnowledgeMaintenanceSubmitSnapshot(this.plugin.settings); }
        catch (error) { result.refinementError = `目录配置已完成，提炼尚未开始：${knowledgeErrorDetail(error)}`; }
        if (!result.refinementError) {
          try { await this.initializer.startBoundOptimization(plan.sources, plan.baseRevision + 1); result.refinement = "started"; }
          catch (error) { result.refinement = "failed"; result.refinementError = `目录配置已完成，提炼启动失败：${knowledgeErrorDetail(error)}`; }
        }
      }
      this.dashboardSnapshot = null;
      this.plugin.refreshKnowledgeBaseSurfaces();
      return result;
    }, plan.create.length === 0 && plan.moves.length === 0 && !optimize); }
    finally { this.directoryPlanBusy = false; this.folderOperationMessage = ""; }
  }

  private directoryModuleSettings(choices: KnowledgeModuleDirectories): DirectoryModuleSettings {
    const settings = this.plugin.settings;
    const snapshot: DirectoryModuleSettings = {};
    if (choices.journal !== undefined) {
      const native = (this.plugin.app as unknown as { internalPlugins?: { plugins?: Record<string, { instance?: { options?: { folder?: string } } }> } }).internalPlugins?.plugins;
      snapshot.journal = settings.journalDirectory;
      snapshot.nativeJournal = { folder: native?.["daily-notes"]?.instance?.options?.folder };
    }
    if (choices.review !== undefined) snapshot.review = settings.review.outputDir;
    if (choices.english !== undefined) snapshot.english = { directory: settings.englishDiary.englishDirectory, mode: settings.englishDiary.englishDirectoryMode, legacyDirectories: structuredClone(settings.englishDiary.legacyEnglishDirectories) };
    if (choices.expressions !== undefined) snapshot.expressions = { directory: settings.englishDiary.expressionDirectory, mode: settings.englishDiary.expressionDirectoryMode, legacyDirectories: structuredClone(settings.englishDiary.legacyExpressionDirectories) };
    if (choices.pdfOriginal !== undefined) snapshot.pdfOriginal = { directory: settings.pdfReading.originalDirectory };
    return snapshot;
  }

  private async restoreDirectoryModuleSettings(original: DirectoryModuleSettings, applied: DirectoryModuleSettings): Promise<void> {
    const settings = this.plugin.settings;
    const current = this.directoryModuleSettings({ journal: applied.nativeJournal ? "" : undefined, review: applied.review,
      english: applied.english?.directory, expressions: applied.expressions?.directory, pdfOriginal: applied.pdfOriginal ? "" : undefined });
    const previous = { journal: settings.journalDirectory, review: settings.review.outputDir, english: structuredClone(settings.englishDiary), pdf: structuredClone(settings.pdfReading) };
    const native = original.nativeJournal && JSON.stringify(current.nativeJournal) === JSON.stringify(applied.nativeJournal)
      && JSON.stringify(current.nativeJournal) !== JSON.stringify(original.nativeJournal) ? await this.captureNativeJournalSettings() : null;
    let changed = false;
    try {
      if (native) { changed = true; await native.restoreFolder(original.nativeJournal!.folder); }
      if (original.journal !== undefined && current.journal === applied.journal && current.journal !== original.journal) { settings.journalDirectory = original.journal; changed = true; }
      if (original.review !== undefined && current.review === applied.review && current.review !== original.review) { settings.review.outputDir = original.review; changed = true; }
      for (const kind of ["english", "expressions"] as const) {
        const before = original[kind], after = applied[kind], active = current[kind];
        if (!before || !after || !active || active.directory !== after.directory || active.mode !== after.mode
          || (active.directory === before.directory && active.mode === before.mode)) continue;
        const directoryKey = kind === "english" ? "englishDirectory" : "expressionDirectory";
        const modeKey = kind === "english" ? "englishDirectoryMode" : "expressionDirectoryMode";
        const legacyKey = kind === "english" ? "legacyEnglishDirectories" : "legacyExpressionDirectories";
        const hasNewContent = (await fsp.readdir(path.join(this.plugin.getVaultPath(), active.directory)).catch(() => [])).length > 0;
        settings.englishDiary[directoryKey] = before.directory;
        if (before.mode === undefined) delete settings.englishDiary[modeKey]; else settings.englishDiary[modeKey] = before.mode;
        if (before.legacyDirectories === undefined && !hasNewContent) delete settings.englishDiary[legacyKey];
        else settings.englishDiary[legacyKey] = [...new Set([...(before.legacyDirectories ?? []), ...(hasNewContent ? [active.directory] : [])])].filter(directory => directory !== before.directory);
        changed = true;
      }
      if (original.pdfOriginal && JSON.stringify(current.pdfOriginal) === JSON.stringify(applied.pdfOriginal) && JSON.stringify(current.pdfOriginal) !== JSON.stringify(original.pdfOriginal)) {
        if (original.pdfOriginal.directory === undefined) delete settings.pdfReading.originalDirectory;
        else settings.pdfReading.originalDirectory = original.pdfOriginal.directory;
        changed = true;
      }
      if (!changed) return;
      this.plugin.englishDiary?.refreshStoragePaths();
      await this.plugin.saveSettings(true);
    } catch (failure) {
      settings.journalDirectory = previous.journal;
      settings.review.outputDir = previous.review;
      settings.englishDiary = previous.english;
      settings.pdfReading = previous.pdf;
      const recovery: string[] = [];
      if (native) try { await native.restore(); } catch (error) { recovery.push(`Obsidian 日记设置：${knowledgeErrorDetail(error)}`); }
      this.plugin.englishDiary?.refreshStoragePaths();
      try { await this.plugin.saveSettings(true); } catch (error) { recovery.push(`配置保存：${knowledgeErrorDetail(error)}`); }
      throw new Error(`模块目录复原未完成：${knowledgeErrorDetail(failure)}。${recovery.length ? `仍需恢复：${recovery.join("；")}` : "原模块设置已保留，请重试"}`);
    }
  }

  private async captureNativeJournalSettings(): Promise<{ restore(): Promise<void>; restoreFolder(folder: string | undefined): Promise<void> }> {
    type NativeRecord = { instance?: { options?: Record<string, unknown>; plugin?: NativeRecord; onExternalSettingsChange?(): Promise<void> }; loadData?(): Promise<unknown>; saveData?(value: Record<string, unknown>): Promise<void> };
    const core = (this.plugin.app as unknown as { internalPlugins?: { plugins?: Record<string, NativeRecord>; getPluginById?(id: string): NativeRecord | undefined } }).internalPlugins;
    const record = core?.getPluginById?.("daily-notes") ?? core?.plugins?.["daily-notes"];
    const instance = record?.instance;
    const storage = instance?.plugin ?? record;
    if (!instance || !storage?.loadData || !storage.saveData) throw new Error("Obsidian 原生日记设置不可用，尚未初始化。");
    const options = structuredClone(instance.options);
    const loaded = await storage.loadData();
    const saved = loaded && typeof loaded === "object" && !Array.isArray(loaded) ? structuredClone(loaded as Record<string, unknown>) : {};
    return { restoreFolder: async folder => {
      if (folder !== undefined) { await saveNativeJournalFolder(this.plugin.app, folder); return; }
      const loaded = await storage.loadData!();
      const next = { ...(loaded && typeof loaded === "object" && !Array.isArray(loaded) ? loaded as Record<string, unknown> : {}), ...instance.options };
      delete next.folder;
      await storage.saveData!(next);
      instance.options = next;
      await instance.onExternalSettingsChange?.();
    }, restore: async () => {
      await storage.saveData!(saved);
      await instance.onExternalSettingsChange?.();
      instance.options = options;
    } };
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

  async unload(): Promise<void> { this.activity.dispose(); await this.linking.dispose(); }
}

export function createKnowledgeInitializationHost(
  plugin: CodexForObsidianPlugin,
  onInteraction: (identity: Readonly<PiTurnInteractionIdentity> | null) => void = () => undefined
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
      if (existing instanceof TFolder) continue;
      if (existing) throw new Error(`同名路径不是文件夹：${current}`);
      try {
        await plugin.app.vault.createFolder(current);
      } catch (error) {
        if (!(plugin.app.vault.getAbstractFileByPath(current) instanceof TFolder)) throw error;
      }
    }
  };
  return {
    vaultRootPath,
    privateRootPath,
    roleScope: DESKTOP_KNOWLEDGE_ROOT_ROLES,
    folderBindings: () => plugin.settings.knowledgeBase.folderBindings,
    resolvePath: (relative) => resolveKnowledgePath(vaultRootPath, relative),
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
    async moveFile(sourcePath: string, targetPath: string): Promise<void> {
      const source = requireVaultFile(plugin, sourcePath);
      if (plugin.app.vault.getAbstractFileByPath(normalizePath(targetPath))) {
        throw new Error(`目标已存在：${targetPath}`);
      }
      const parentFolder = knowledgeInitializationParentFolder(targetPath);
      if (parentFolder) await ensureFolder(parentFolder);
      await plugin.app.fileManager.renameFile(source, normalizePath(targetPath));
    },
    currentProvider() {
      const active = getActiveApiProviderModel(plugin.settings);
      if (!active) return null;
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
        text: knowledgeMaintenanceBatchPrompt(input),
        permission: plugin.settings.defaultPermission,
        submittedAt: Date.now(),
        ...modelSnapshot,
        maintenanceScope: {
          mode: "batch",
          sourcePaths: Object.freeze([...input.sourcePaths])
        }
      });
      const subscription = plugin.subscribePiRun(handle.productRunId, (event) => {
        if (event.type === "interaction_requested" && event.interaction.kind === "question") {
          onInteraction({ conversationId: input.conversationId, piSessionId: event.interaction.piSessionId,
            productRunId: handle.productRunId, interactionId: event.interaction.interactionId });
        } else if (event.type === "interaction_resolved") onInteraction(null);
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
          processedSourcePaths: Object.freeze([...(result.maintenance?.processedSourcePaths ?? [])]),
          pendingSourcePaths: result.maintenance?.pendingSourcePaths ?? input.sourcePaths,
          analysisOnly: result.maintenance?.analysisOnly ?? result.permission === "read-only",
          message: result.maintenance?.warnings.join("\n")
        };
      } finally {
        subscription.unsubscribe();
        onInteraction(null);
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
  relativePath: string,
  allowMissingPath = false
): Promise<boolean> {
  let cursor = vaultRootPath;
  for (const segment of normalizePath(relativePath).split("/").filter(Boolean)) {
    cursor = path.join(cursor, segment);
    try {
      if ((await fsp.lstat(cursor)).isSymbolicLink()) return true;
    } catch (error) {
      return !(allowMissingPath && (error as NodeJS.ErrnoException).code === "ENOENT");
    }
  }
  return false;
}
