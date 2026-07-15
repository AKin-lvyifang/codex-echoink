import * as fsp from "fs/promises";
import * as path from "path";
import { Notice } from "obsidian";
import type CodexForObsidianPlugin from "../main";
import { swallowError } from "../core/error-handling";
import { recoverStaleHarnessRuns } from "../core/message-state";
import { externalizeLargeMessages, pluginDataDir, prepareRawMessage, readRawText, writeRawText } from "../core/raw-message-store";
import { FileConversationStore } from "../harness/conversation/conversation-store";
import {
  clearLegacyChatWorkspaceDefaults,
  ensureKnowledgeBaseSession,
  normalizeSettingsData,
  type ChatMessage,
  type CodexForObsidianSettings,
  type StoredSession
} from "../settings/settings";
import { DEFAULT_KNOWLEDGE_BASE_RULES_FILE } from "../knowledge-base/constants";
import {
  collectKnowledgeBaseStorageStats,
  compactOldKnowledgeBaseProcessHistory,
  exportKnowledgeBaseHistory,
  migrateKnowledgeBaseHistory,
  persistAndCompactKnowledgeBaseHistory,
  pruneKnowledgeBaseHistoryByRetention,
  readKnowledgeBaseHistoryDay,
  readKnowledgeBaseHistoryIndex,
  rebuildKnowledgeBaseHistoryIndex,
  removeKnowledgeBaseHistory,
  removeKnowledgeBaseHistoryDays,
  type KnowledgeBaseHistoryIndex,
  type KnowledgeBaseHistoryRemovalResult,
  type KnowledgeBaseStorageStats
} from "../knowledge-base/history-store";
import { readKnowledgeBaseReportExcerpt, shouldRecoverKnowledgeBaseLintFailure } from "../knowledge-base/report";
import type { LocalRunCommitResult } from "../harness/contracts/native-execution";

export interface SettingsSaveOptions {
  flushConversationStore?: boolean;
  strictConversationStore?: boolean;
  flushKnowledgeBaseHistory?: boolean;
  strictKnowledgeBaseHistory?: boolean;
}

export class EchoInkSettingsStore {
  private startupMaintenancePromise: Promise<void> | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private saveQueue: Promise<void> = Promise.resolve();
  private rawWrites = new Set<Promise<void>>();
  private conversationStore: FileConversationStore | null = null;
  private conversationStoreRootPath = "";
  private interruptedRunRecoveryQueue: Promise<number> = Promise.resolve(0);

  constructor(private readonly plugin: CodexForObsidianPlugin) {}

  async loadSettings(): Promise<void> {
    const data = (await this.plugin.loadData()) ?? {};
    const previousVersion = typeof data?.settingsVersion === "number" ? data.settingsVersion : 0;
    const normalized = normalizeSettingsData(data);
    this.plugin.settings = normalized.settings;
    await this.hydrateConversationSessions();
    const sessionCountBefore = this.plugin.settings.sessions.length;
    const knowledgeSessionBefore = this.plugin.settings.knowledgeBase.sessionId;
    const knowledgeRulesMigrated = await this.applyKnowledgeBaseRulesFileDefault(data);
    ensureKnowledgeBaseSession(this.plugin.settings, this.plugin.getVaultPath());
    const interruptedRunsRecovered = await this.recoverInterruptedHarnessRuns();
    const legacyChatWorkspacesCleared = clearLegacyChatWorkspaceDefaults(this.plugin.settings, this.plugin.getVaultPath(), previousVersion);
    const knowledgeStatusRecovered = await this.recoverKnowledgeBaseLintStatus();
    const knowledgeSessionChanged = sessionCountBefore !== this.plugin.settings.sessions.length || knowledgeSessionBefore !== this.plugin.settings.knowledgeBase.sessionId;
    if (normalized.changed || legacyChatWorkspacesCleared > 0 || knowledgeSessionChanged || knowledgeStatusRecovered || knowledgeRulesMigrated || interruptedRunsRecovered > 0) {
      await this.saveSettings(true, { flushKnowledgeBaseHistory: false });
    }
  }

  async recoverInterruptedHarnessRuns(sessionId?: string): Promise<number> {
    const recovery = this.interruptedRunRecoveryQueue
      .catch(() => 0)
      .then(async () => {
        let recovered = 0;
        const sessions = sessionId
          ? this.plugin.settings.sessions.filter((session) => session.id === sessionId)
          : this.plugin.settings.sessions;
        for (const session of sessions) {
          try {
            const result = await recoverStaleHarnessRuns({
              messages: session.messages,
              commitLocalHistory: async () => {
                session.updatedAt = Date.now();
                await this.saveSettings(true, {
                  strictConversationStore: true,
                  strictKnowledgeBaseHistory: session.kind === "knowledge-base"
                });
              },
              settleRunTerminal: async (terminal) => {
                await this.plugin.settleHarnessRunTerminal(terminal);
              }
            });
            recovered += result.settledRunIds.length;
            if (result.failedRunIds.length) {
              console.error("EchoInk interrupted run terminal recovery failed", result.failedRunIds);
            }
          } catch (error) {
            console.error("EchoInk interrupted run local commit failed", error);
          }
        }
        return recovered;
      });
    this.interruptedRunRecoveryQueue = recovery;
    return await recovery;
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
      void this.flushSettingsSave().catch(swallowError("scheduled settings save failed"));
    }, 750);
  }

  async externalizeMessageText(message: ChatMessage, fullText: string): Promise<void> {
    const write = prepareRawMessage(message, fullText);
    if (!write) return;
    let tracked: Promise<void>;
    tracked = writeRawText(this.plugin.getVaultPath(), write.rawRef, write.text, this.plugin.getPluginDataDirName())
      .catch((error) => {
        console.error("Codex raw message write failed", error);
        if (message.rawRef === write.rawRef) {
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

  async readRawMessageText(rawRef: string): Promise<string> {
    return readRawText(this.plugin.getVaultPath(), rawRef, this.plugin.getPluginDataDirName());
  }

  async deleteConversationSession(sessionId: string): Promise<boolean> {
    return await this.getConversationStore().deleteSession(sessionId);
  }

  async commitKnowledgeRunDurably(): Promise<LocalRunCommitResult> {
    try {
      await this.saveSettings(true, { strictConversationStore: true, strictKnowledgeBaseHistory: true });
      return localRunCommitResult(true);
    } catch (error) {
      return localRunCommitResult(false, error instanceof Error ? error.message : String(error));
    }
  }

  async readKnowledgeBaseHistoryIndex(): Promise<KnowledgeBaseHistoryIndex> {
    return readKnowledgeBaseHistoryIndex(this.plugin.getVaultPath(), this.plugin.getPluginDataDirName());
  }

  async readKnowledgeBaseHistoryDay(sessionId: string, date: string): Promise<ChatMessage[]> {
    return readKnowledgeBaseHistoryDay(this.plugin.getVaultPath(), this.plugin.getPluginDataDirName(), sessionId, date);
  }

  async rebuildKnowledgeBaseHistoryIndex(): Promise<KnowledgeBaseHistoryIndex> {
    return rebuildKnowledgeBaseHistoryIndex(this.plugin.getVaultPath(), this.plugin.getPluginDataDirName());
  }

  async getKnowledgeBaseStorageStats(): Promise<KnowledgeBaseStorageStats> {
    return collectKnowledgeBaseStorageStats(this.plugin.getVaultPath(), this.plugin.getPluginDataDirName());
  }

  async exportKnowledgeBaseHistory(): Promise<string> {
    return exportKnowledgeBaseHistory(this.plugin.getVaultPath(), this.plugin.getPluginDataDirName());
  }

  async compactOldKnowledgeBaseProcessHistory(): Promise<number> {
    return compactOldKnowledgeBaseProcessHistory(this.plugin.getVaultPath(), this.plugin.getPluginDataDirName());
  }

  async removeKnowledgeBaseHistory(): Promise<KnowledgeBaseHistoryRemovalResult> {
    return removeKnowledgeBaseHistory(this.plugin.getVaultPath(), this.plugin.getPluginDataDirName());
  }

  async removeKnowledgeBaseHistoryDays(dates: string[]): Promise<KnowledgeBaseHistoryRemovalResult> {
    return removeKnowledgeBaseHistoryDays(this.plugin.getVaultPath(), this.plugin.getPluginDataDirName(), dates);
  }

  async pruneKnowledgeBaseHistoryByRetention(): Promise<KnowledgeBaseHistoryRemovalResult> {
    return pruneKnowledgeBaseHistoryByRetention(
      this.plugin.getVaultPath(),
      this.plugin.getPluginDataDirName(),
      this.plugin.settings.knowledgeBase.historyRetentionDays
    );
  }

  async runDeferredStartupMaintenance(): Promise<void> {
    if (this.startupMaintenancePromise) return this.startupMaintenancePromise;
    this.startupMaintenancePromise = (async () => {
      let changed = false;
      try {
        changed = await externalizeLargeMessages(this.plugin.getVaultPath(), this.plugin.settings, this.plugin.getPluginDataDirName()) > 0 || changed;
      } catch (error) {
        console.error("Codex raw message migration failed", error);
      }
      try {
        changed = (await migrateKnowledgeBaseHistory(this.plugin.getVaultPath(), this.plugin.getPluginDataDirName(), this.plugin.settings)).changed || changed;
      } catch (error) {
        console.error("Codex knowledge history migration failed", error);
      }
      try {
        await this.pruneKnowledgeBaseHistoryByRetention();
      } catch (error) {
        console.warn("Codex knowledge history retention cleanup failed", error);
      }
      if (changed) await this.saveSettings(true, { flushKnowledgeBaseHistory: false });
    })().finally(() => {
      this.startupMaintenancePromise = null;
    });
    return this.startupMaintenancePromise;
  }

  private async applyKnowledgeBaseRulesFileDefault(data: unknown): Promise<boolean> {
    const rawSettings = typeof data === "object" && data !== null ? (data as { knowledgeBase?: unknown }).knowledgeBase : null;
    const hasExplicitRules = typeof rawSettings === "object" && rawSettings !== null
      && (typeof (rawSettings as { useCustomRulesFile?: unknown }).useCustomRulesFile === "boolean" || typeof (rawSettings as { rulesFilePath?: unknown }).rulesFilePath === "string");
    if (hasExplicitRules) return false;

    const vaultPath = this.plugin.getVaultPath();
    const llmWikiPath = path.join(vaultPath, DEFAULT_KNOWLEDGE_BASE_RULES_FILE);
    const llmWiki = await fsp.readFile(llmWikiPath, "utf8").catch(() => "");
    if (!llmWiki) return false;
    const llmWikiLooksLikeKnowledgeRules = /知识库|Raw Sources|Ingest|Lint|Wiki/.test(llmWiki);
    if (!llmWikiLooksLikeKnowledgeRules) return false;

    this.plugin.settings.knowledgeBase.useCustomRulesFile = true;
    this.plugin.settings.knowledgeBase.rulesFilePath = DEFAULT_KNOWLEDGE_BASE_RULES_FILE;
    return true;
  }

  private async recoverKnowledgeBaseLintStatus(): Promise<boolean> {
    const settings = this.plugin.settings.knowledgeBase;
    if (settings.lastRunStatus !== "failed" || !settings.lastReportPath) return false;
    const report = await readKnowledgeBaseReportExcerpt(this.plugin.getVaultPath(), settings.lastReportPath, 2000);
    if (!shouldRecoverKnowledgeBaseLintFailure(settings.lastError, report)) return false;
    settings.lastRunStatus = "success";
    settings.lastError = "";
    settings.lastSummary = `体检报告已生成。上次 Codex 返回失败状态，但 lint-only 报告文件存在，已恢复为成功。\n\n${report}`.slice(0, 1000);
    return true;
  }

  private async flushSettingsSave(options: SettingsSaveOptions = {}): Promise<void> {
    const run = this.saveQueue.then(async () => {
      await this.flushRawWrites();
      if (options.flushConversationStore !== false) await this.flushConversationStore(options.strictConversationStore !== false);
      if (options.flushKnowledgeBaseHistory !== false) await this.flushKnowledgeBaseHistory(options.strictKnowledgeBaseHistory === true);
      await this.plugin.saveData(settingsForDataSave(this.plugin.settings));
    });
    this.saveQueue = run.catch((error) => {
      this.reportSettingsSaveError(error);
    });
    await run;
  }

  private reportSettingsSaveError(error: unknown): void {
    console.error("[EchoInk] settings save failed:", error);
    new Notice(this.plugin.settings.settingsLanguage === "en" ? "EchoInk settings save failed" : "EchoInk 设置保存失败，请稍后重试");
  }

  private async flushRawWrites(): Promise<void> {
    const pending = Array.from(this.rawWrites);
    if (pending.length) await Promise.allSettled(pending);
  }

  private async flushKnowledgeBaseHistory(strict = false): Promise<void> {
    try {
      await persistAndCompactKnowledgeBaseHistory(this.plugin.getVaultPath(), this.plugin.getPluginDataDirName(), this.plugin.settings);
    } catch (error) {
      console.error("Codex knowledge history save failed", error);
      if (strict) throw error;
    }
  }

  private async flushConversationStore(strict = true): Promise<void> {
    try {
      await this.getConversationStore().persistSettingsSessions(this.plugin.settings);
    } catch (error) {
      console.error("EchoInk conversation store save failed", error);
      if (strict) throw error;
    }
  }

  private async hydrateConversationSessions(): Promise<void> {
    await Promise.all(this.plugin.settings.sessions.map(async (session) => {
      const stored = await this.getConversationStore().readSession(session.id).catch(() => null);
      if (!stored) return;
      applyStoredConversation(session, stored);
    }));
  }

  private getConversationStore(): FileConversationStore {
    const rootPath = path.join(pluginDataDir(this.plugin.getVaultPath(), this.plugin.getPluginDataDirName()), "conversations");
    if (this.conversationStore && this.conversationStoreRootPath === rootPath) return this.conversationStore;
    this.conversationStoreRootPath = rootPath;
    this.conversationStore = new FileConversationStore({ rootPath });
    return this.conversationStore;
  }
}

export function settingsForDataSave(settings: CodexForObsidianSettings): CodexForObsidianSettings {
  const data = JSON.parse(JSON.stringify(settings)) as CodexForObsidianSettings;
  for (const session of data.sessions) {
    session.messages = [];
    delete session.threadId;
  }
  return data;
}

function applyStoredConversation(target: StoredSession, stored: StoredSession): void {
  target.title = stored.title;
  target.kind = stored.kind;
  target.cwd = stored.cwd;
  target.messages = stored.messages;
  target.backendBindings = stored.backendBindings;
  target.revision = stored.revision;
  target.contextSnapshot = stored.contextSnapshot;
  target.rollingSummary = stored.rollingSummary;
  target.messagesHiddenBefore = stored.messagesHiddenBefore;
  target.historyActiveDate = stored.historyActiveDate;
  target.tokenUsage = stored.tokenUsage;
  target.createdAt = stored.createdAt;
  target.updatedAt = stored.updatedAt;
}

function localRunCommitResult(committed: boolean, error = ""): LocalRunCommitResult {
  return {
    committed,
    conversationCommitted: committed,
    runLedgerCommitted: committed,
    artifactsCommitted: committed,
    historyIndexCommitted: committed,
    ...(error ? { error } : {})
  };
}
