import { runErrors } from "../run-reports/recent-errors";
import { Notice, Platform } from "obsidian";
import path from "node:path";
import { migrateLegacyAgentRegistry, synchronizeLegacyAgentIdentity } from "../agents/migration";
import { pluginDataDir } from "./plugin-data-paths";
import type CodexForObsidianPlugin from "../main";
import { prepareRawMessage, readRawText, writeRawText } from "../core/raw-message-store";
import {
  ConversationMutationLane
} from "../harness/conversation/conversation-mutation-lane";
import {
  normalizeSettingsData,
  sanitizeStoredPiImageAttachments,
  sanitizeCredentialSettingsForDataSave,
  type ChatMessage,
  type ApiProviderConfig,
  type CodexForObsidianSettings,
  type KnowledgeBaseSettings,
  type StoredSession
} from "../settings/settings";
import { readKnowledgeBaseReportExcerpt, recoveredLintReportSummary, shouldRecoverKnowledgeBaseLintFailure } from "../knowledge-base/report";
import { ResourceMutationError } from "./resource-mutation-authority";
import { isEmptyEchoInkPluginData } from "../settings/onboarding";
import { DESKTOP_KNOWLEDGE_ROOT_ROLES, knowledgeRootDirectories, migrateKnowledgeFolderBindings, preferExistingBilingualKnowledgeDefaults, registerKnowledgeFolderBindings } from "../knowledge-base/root-paths";
export { ResourceMutationError, resourceMutationRollbackIsSafe } from "./resource-mutation-authority";

export interface SettingsSaveOptions {
  flushConversationStore?: boolean;
  strictConversationStore?: boolean;
  flushRawWrites?: boolean;
}

export interface SettingsLoadResult {
  readonly emptyData: boolean;
}

export type ApiProviderSettingsSnapshot = Pick<
  CodexForObsidianSettings,
  | "providerMode"
  | "activeApiProviderId"
  | "apiProviders"
  | "defaultModel"
>;

export function snapshotApiProviderSettings(
  settings: CodexForObsidianSettings
): ApiProviderSettingsSnapshot {
  return {
    providerMode: settings.providerMode,
    activeApiProviderId: settings.activeApiProviderId,
    apiProviders: cloneSettings(settings).apiProviders,
    defaultModel: settings.defaultModel
  };
}

export function restoreApiProviderSettings(
  settings: CodexForObsidianSettings,
  snapshot: ApiProviderSettingsSnapshot
): void {
  settings.providerMode = snapshot.providerMode;
  settings.activeApiProviderId = snapshot.activeApiProviderId;
  settings.apiProviders = cloneJsonValue(snapshot.apiProviders) as ApiProviderConfig[];
  settings.defaultModel = snapshot.defaultModel;
}

const SETTINGS_CAS_MAX_PRE_COMMIT_ATTEMPTS = 3;
const SETTINGS_SAVE_RETRY_DELAYS_MS = [200, 1_000, 3_000] as const;
const SETTINGS_CONFLICT_BACKUP_FILE = "settings-save-conflict-backup.json";

export type SettingsPersistenceStatus = "not_committed" | "unknown";

export class SettingsPersistenceError extends Error {
  constructor(
    readonly code: "settings_cas_conflict" | "settings_persist_failed",
    message: string,
    readonly persistenceStatus: SettingsPersistenceStatus,
    readonly persistedSettings: CodexForObsidianSettings | null = null,
    options: ErrorOptions = {}
  ) {
    super(message, options);
    this.name = "SettingsPersistenceError";
  }
}

export class EchoInkSettingsStore {
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private saveQueue: Promise<void> = Promise.resolve();
  private resourceMutationTail: Promise<void> = Promise.resolve();
  private rawWrites = new Set<Promise<void>>();
  private rawOwnerMutationTail: Promise<void> = Promise.resolve();
  private settingsConflictBackupPending = false;
  private readonly reportedSettingsSaveErrors = new Set<string>();
  private resourceMutationRecoveryError: ResourceMutationError | null = null;
  private readonly conversationMutationLane = new ConversationMutationLane();

  constructor(private readonly plugin: CodexForObsidianPlugin) {}

  async loadSettings(): Promise<Readonly<SettingsLoadResult>> {
    const data: unknown = await this.plugin.loadData();
    const emptyData = isEmptyEchoInkPluginData(data);
    const normalized = normalizeSettingsData(data);
    this.plugin.settings = normalized.settings;
    let agentsMigrated = false;
    try {
      let migratedRegistry = await migrateLegacyAgentRegistry(
        this.plugin.settings.agentRegistry,
        path.join(
          pluginDataDir(this.plugin.getVaultPath(), this.plugin.getPluginDataDirName()),
          "pi-agent-product-v1", ".echoink"
        )
      );
      if (!Platform.isMobile) migratedRegistry = await synchronizeLegacyAgentIdentity(migratedRegistry,
        path.join(pluginDataDir(this.plugin.getVaultPath(), this.plugin.getPluginDataDirName()), "pi-agent-product-v1", ".echoink"));
      agentsMigrated = migratedRegistry !== this.plugin.settings.agentRegistry;
      this.plugin.settings.agentRegistry = migratedRegistry;
    } catch (error) {
      // Keep normalized defaults and migrationVersion=0 so the next load retries.
      console.warn("EchoInk Agent identity migration could not complete; it will retry on the next load.", error);
    }
    let bindingsMigrated = false;
    if (!this.plugin.settings.knowledgeBase.folderBindings) {
      const mobilePaths = (data as { mobileUi?: { knowledgePaths?: Partial<Record<"raw" | "wiki" | "inbox", string>> } } | null)?.mobileUi?.knowledgePaths;
      this.plugin.settings.knowledgeBase.folderBindings = migrateKnowledgeFolderBindings(knowledgeRootDirectories(this.plugin.getVaultPath()), mobilePaths);
      bindingsMigrated = true;
    } else {
      const previous = this.plugin.settings.knowledgeBase.folderBindings;
      const corrected = preferExistingBilingualKnowledgeDefaults(previous, knowledgeRootDirectories(this.plugin.getVaultPath()));
      if (corrected !== previous) {
        this.plugin.settings.knowledgeBase.folderBindings = corrected;
        bindingsMigrated = true;
      }
    }
    // Registered before local runtimes and feature controllers are constructed; reloads read live settings.
    registerKnowledgeFolderBindings(this.plugin.getVaultPath(), () => this.plugin.settings.knowledgeBase.folderBindings, DESKTOP_KNOWLEDGE_ROOT_ROLES);
    this.settingsConflictBackupPending = false;
    this.resourceMutationRecoveryError = null;
    const knowledgeStatusRecovered = await this.recoverKnowledgeBaseLintStatus();
    if (normalized.changed || knowledgeStatusRecovered || bindingsMigrated || agentsMigrated) {
      await this.saveSettings(true, {
        flushConversationStore: false
      });
    }
    return Object.freeze({ emptyData });
  }

  async saveSettings(force = false, options: SettingsSaveOptions = {}): Promise<void> {
    if (force) {
      if (this.saveTimer) {
        clearTimeout(this.saveTimer);
        this.saveTimer = null;
      }
      await this.flushSettingsSave(options);
      return;
    }
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      // flushSettingsSave already emits one redacted diagnostic and Notice.
      void this.flushSettingsSave().catch(() => undefined);
    }, 750);
  }

  async externalizeMessageText(message: ChatMessage, fullText: string): Promise<void> {
    let tracked: Promise<void>;
    let attemptedRawRef: string | null = null;
    tracked = this.withRawOwnerMutation(async () => {
      const write = prepareRawMessage(message, fullText);
      if (!write) return;
      attemptedRawRef = write.rawRef;
      await writeRawText(
        this.plugin.getVaultPath(),
        write.rawRef,
        write.text,
        this.plugin.getPluginDataDirName()
      );
    })
      .catch((error) => {
        console.error("Codex raw message write failed", error);
        // The lane owns both the in-memory rawRef mutation and its file write,
        // so a failed write can safely restore the full inline message.
        if (attemptedRawRef && message.rawRef === attemptedRawRef) {
          message.text = fullText;
          delete message.previewText;
          delete message.rawRef;
          delete message.rawSize;
          delete message.rawLines;
          delete message.rawTruncatedForPreview;
        }
      })
      .finally(() => this.rawWrites.delete(tracked));
    this.rawWrites.add(tracked);
    await tracked;
  }

  private async withRawOwnerMutation<T>(
    action: () => Promise<T>
  ): Promise<T> {
    const previous = this.rawOwnerMutationTail;
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.rawOwnerMutationTail = previous.then(() => current);
    await previous;
    try {
      return await action();
    } finally {
      release();
    }
  }

  async readRawMessageText(rawRef: string): Promise<string> {
    return readRawText(this.plugin.getVaultPath(), rawRef, this.plugin.getPluginDataDirName());
  }

  async withSettingsPersistenceAuthorityGate<R>(
    action: () => Promise<R>
  ): Promise<R> {
    const run = this.saveQueue.then(action);
    this.saveQueue = run.then(
      () => undefined,
      () => undefined
    );
    return await run;
  }

  async withResourceMutation<R>(action: () => Promise<R>): Promise<R> {
    const run = this.resourceMutationTail.then(async () => {
      if (this.resourceMutationRecoveryError) {
        throw this.resourceMutationRecoveryError;
      }
      return await action();
    });
    this.resourceMutationTail = run.then(
      () => undefined,
      () => undefined
    );
    try {
      return await run;
    } catch (error) {
      if (error instanceof ResourceMutationError && !error.rollbackSafe) {
        this.resourceMutationRecoveryError = error;
      }
      throw error;
    }
  }

  async saveResourceMutation(
    previousResources: CodexForObsidianSettings["resources"]
  ): Promise<void> {
    try {
      await this.saveSettings(true);
    } catch (error) {
      if (
        error instanceof SettingsPersistenceError
        && error.persistenceStatus === "not_committed"
      ) {
        this.plugin.settings.resources = cloneJsonValue(
          previousResources
        ) as CodexForObsidianSettings["resources"];
        throw new ResourceMutationError(
          "Resource settings were not committed",
          true,
          false,
          true,
          { cause: error }
        );
      }
      if (
        error instanceof SettingsPersistenceError
        && error.persistedSettings
      ) {
        this.plugin.settings.resources = cloneJsonValue(
          error.persistedSettings.resources
        ) as CodexForObsidianSettings["resources"];
        throw new ResourceMutationError(
          "Resource settings commit has authoritative readback",
          false,
          true,
          true,
          { cause: error }
        );
      }
      this.plugin.settings.resources = cloneJsonValue(
        previousResources
      ) as CodexForObsidianSettings["resources"];
      throw new ResourceMutationError(
        "Resource settings commit is uncertain",
        false,
        true,
        false,
        { cause: error }
      );
    }
  }

  async readPersistedApiProviderSettingsSnapshot(): Promise<ApiProviderSettingsSnapshot> {
    const persisted = normalizeSettingsData(
      await this.readPersistedSettingsDataStrict()
    ).settings;
    return snapshotApiProviderSettings(persisted);
  }

  async readPersistedEchoInkResourceSnapshot(): Promise<
  CodexForObsidianSettings["resources"]> {
    const persisted = normalizeSettingsData(
      await this.readPersistedSettingsDataStrict()
    ).settings;
    return cloneJsonValue(
      persisted.resources
    ) as CodexForObsidianSettings["resources"];
  }

  async restorePersistedApiProviderSettingsSnapshot(
    snapshot: ApiProviderSettingsSnapshot
  ): Promise<void> {
    await this.withSettingsPersistenceAuthorityGate(async () => {
      const current = normalizeSettingsData(
        await this.readPersistedSettingsDataStrict()
      ).settings;
      restoreApiProviderSettings(current, snapshot);
      const target = settingsForDataSave(current);
      await this.plugin.saveData(target);
      const readback = normalizeSettingsData(
        await this.readPersistedSettingsDataStrict()
      ).settings;
      if (
        stableJson(snapshotApiProviderSettings(readback))
        !== stableJson(snapshot)
      ) {
        throw new Error("Provider settings rollback readback mismatch");
      }
      this.settingsConflictBackupPending = false;
    });
  }

  async withConversationMutation<R>(
    conversationId: string,
    action: () => Promise<R>
  ): Promise<R> {
    return await this.conversationMutationLane.withConversationMutation(
      conversationId,
      async () => await action()
    );
  }

  private async recoverKnowledgeBaseLintStatus(): Promise<boolean> {
    const settings = this.plugin.settings.knowledgeBase;
    if (settings.lastRunStatus !== "failed" || !settings.lastReportPath) return false;
    const report = await readKnowledgeBaseReportExcerpt(this.plugin.getVaultPath(), settings.lastReportPath, 2000);
    if (!shouldRecoverKnowledgeBaseLintFailure(settings.lastError, report)) return false;
    settings.lastRunStatus = "success";
    settings.lastError = "";
    settings.lastSummary = `${recoveredLintReportSummary(settings.lastReportPath)}\n\n${report}`.slice(0, 1000);
    return true;
  }

  private async flushSettingsSave(options: SettingsSaveOptions = {}): Promise<void> {
    const run = this.saveQueue.then(async () => {
      if (options.flushRawWrites !== false) {
        await this.flushRawWrites();
      }
      try {
        await this.plugin.syncPiConversationTaskMetadata?.();
      } catch (error) {
        console.warn("EchoInk task metadata could not sync; saving the settings projection for a later retry.", error);
      }
      let uncertainError: SettingsPersistenceError | null = null;
      for (let attempt = 0; ; attempt += 1) {
        try {
          const prepared = await this.prepareCanonicalSettingsCandidate();
          if (this.settingsConflictBackupPending) {
            await this.backupConflictingSettingsData(prepared.persistedBefore);
            this.settingsConflictBackupPending = false;
          }
          await this.persistSettingsDataCandidate(
            prepared.candidate,
            prepared.persistedBefore
          );
          this.reportedSettingsSaveErrors.clear();
          // A write can yield while another caller changes settings. Coalesce a
          // follow-up instead of waiting for all running Conversations to go idle.
          if (stableJson(settingsForDataSave(this.plugin.settings)) !== stableJson(prepared.candidate)) {
            await this.saveSettings();
          }
          return;
        } catch (error) {
          if (error instanceof SettingsPersistenceError && error.persistenceStatus === "unknown") {
            uncertainError = error;
          }
          const delay = SETTINGS_SAVE_RETRY_DELAYS_MS[attempt];
          // A later retry that did not commit cannot prove the earlier partial
          // write harmless. Preserve that status for transactional callers.
          if (delay === undefined) throw uncertainError ?? error;
          await new Promise<void>(resolve => setTimeout(resolve, delay));
        }
      }
    });
    this.saveQueue = run.catch((error) => {
      this.reportSettingsSaveError(error);
    });
    await run;
  }

  private async backupConflictingSettingsData(data: unknown): Promise<void> {
    const vaultPath = this.plugin.getVaultPath();
    const directory = pluginDataDir(vaultPath, this.plugin.getPluginDataDirName());
    const backupPath = path.relative(vaultPath, path.join(directory, SETTINGS_CONFLICT_BACKUP_FILE)).split(path.sep).join("/");
    // The installed plugin directory already exists. If backup fails, keep the
    // pending flag and do not overwrite the only remaining copy on disk.
    await this.plugin.app.vault.adapter.write(backupPath, JSON.stringify(data, null, 2));
  }

  private reportSettingsSaveError(error: unknown): void {
    const code = error instanceof SettingsPersistenceError
      ? error.code
      : error instanceof ResourceMutationError
        ? "resource_mutation_failed"
        : "settings_save_failed";
    runErrors.record("settings.save", error, { code });
    console.error("[EchoInk] settings save failed:", code, settingsSaveErrorDetail(error));
    if (this.reportedSettingsSaveErrors.has(code)) return;
    this.reportedSettingsSaveErrors.add(code);
    new Notice(this.plugin.settings.settingsLanguage === "en"
      ? "EchoInk couldn't save settings. Check whether a sync or antivirus app is locking the plugin folder."
      : "EchoInk 设置多次保存失败，请检查同步或杀毒软件是否占用了插件文件夹");
  }

  private async flushRawWrites(): Promise<void> {
    const pending = Array.from(this.rawWrites);
    if (pending.length) await Promise.allSettled(pending);
  }

  private async prepareCanonicalSettingsCandidate(): Promise<{
    candidate: CodexForObsidianSettings;
    persistedBefore: unknown;
  }> {
    for (
      let attempt = 1;
      attempt <= SETTINGS_CAS_MAX_PRE_COMMIT_ATTEMPTS;
      attempt += 1
    ) {
      const candidate = settingsForDataSave(this.plugin.settings);
      const persistedBefore = await this.readPersistedSettingsDataStrict();
      const latest = settingsForDataSave(this.plugin.settings);
      if (stableJson(latest) === stableJson(candidate)) {
        return { candidate, persistedBefore };
      }
      if (attempt === SETTINGS_CAS_MAX_PRE_COMMIT_ATTEMPTS) {
        return { candidate: latest, persistedBefore };
      }
    }
    throw new Error("Settings snapshot attempts must be positive");
  }

  private async readPersistedSettingsDataStrict(): Promise<unknown> {
    return cloneJsonValue((await this.plugin.loadData()) ?? {});
  }

  private async persistSettingsDataCandidate(
    candidate: CodexForObsidianSettings,
    persistedBefore: unknown
  ): Promise<void> {
    const target = settingsForDataSave(candidate);
    try {
      await this.plugin.saveData(target);
      return;
    } catch (saveError) {
      let readback: unknown;
      try {
        readback = await this.readPersistedSettingsDataStrict();
      } catch (readbackError) {
        this.settingsConflictBackupPending = true;
        throw new SettingsPersistenceError(
          "settings_persist_failed",
          "settings saveData 结果未知，严格 readback 失败",
          "unknown",
          null,
          { cause: new AggregateError([saveError, readbackError], "Settings write and readback failed") }
        );
      }
      if (stableJson(readback) === stableJson(target)) {
        return;
      }
      if (stableJson(readback) === stableJson(persistedBefore)) {
        throw new SettingsPersistenceError(
          "settings_persist_failed",
          `settings saveData 未提交：${errorMessage(saveError)}`,
          "not_committed",
          null,
          { cause: saveError }
        );
      }
      const persistedSettings = normalizeSettingsData(readback).settings;
      const error = new SettingsPersistenceError(
        "settings_persist_failed",
        "settings saveData 抛错后的严格 readback 既不匹配提交前状态，也不匹配完整目标；下次写入前备份磁盘数据",
        "unknown",
        persistedSettings,
        { cause: saveError }
      );
      this.settingsConflictBackupPending = true;
      throw error;
    }
  }

}

export function settingsForDataSave(settings: CodexForObsidianSettings): CodexForObsidianSettings {
  const data = JSON.parse(JSON.stringify(settings)) as CodexForObsidianSettings;
  sanitizeCredentialSettingsForDataSave(data);
  for (const session of data.sessions) {
    session.messages = [];
    const normalizedImageMetadata = session.bodyAuthority === "pi_session_only"
      ? sanitizeStoredPiImageAttachments(session.piImageAttachments)
      : undefined;
    if (normalizedImageMetadata) {
      session.piImageAttachments = normalizedImageMetadata;
    } else {
      delete session.piImageAttachments;
    }
  }
  return data;
}

function cloneJsonValue(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

function cloneSettings(
  settings: CodexForObsidianSettings
): CodexForObsidianSettings {
  return JSON.parse(JSON.stringify(settings)) as CodexForObsidianSettings;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function settingsSaveErrorDetail(error: unknown, seen = new Set<unknown>()): string {
  if (seen.has(error)) return "";
  seen.add(error);
  if (!(error instanceof Error)) return String(error);
  const code = (error as NodeJS.ErrnoException).code;
  return [code, error.message,
    ...(error instanceof AggregateError ? error.errors.map((cause: unknown) => settingsSaveErrorDetail(cause, seen)) : []),
    ...(error.cause ? [settingsSaveErrorDetail(error.cause, seen)] : [])
  ].filter(Boolean).join(": ");
}
