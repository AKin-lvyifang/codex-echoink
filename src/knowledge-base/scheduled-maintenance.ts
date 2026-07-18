import * as fsp from "fs/promises";
import { Notice } from "obsidian";
import type CodexForObsidianPlugin from "../main";
import { ensureKnowledgeBaseSession, newId, type ChatMessage, type StoredSession } from "../settings/settings";
import { resolveRawRef } from "../core/raw-message-store";
import { appendKnowledgeBaseWarning, saveSettingsSafely } from "./maintenance";
import { buildKnowledgeBaseMaintainReportPayload } from "./maintain-report-card";
import { readKnowledgeBaseReportExcerpt } from "./report";
import { buildScheduledKnowledgeBaseMessage } from "./scheduled-message";
import type { KnowledgeBaseRunResult } from "./types";

export async function appendScheduledMaintenanceMessage(
  plugin: CodexForObsidianPlugin,
  result: KnowledgeBaseRunResult,
  afterMessageSaved: () => Promise<void>
): Promise<void> {
  const settings = plugin.settings;
  const sessionsBefore = cloneStoredSessions(settings.sessions);
  const sessionIdBefore = settings.knowledgeBase.sessionId;
  const lastErrorBefore = settings.knowledgeBase.lastError;
  let vaultPath = "";
  let scheduledSessionId: string | null = null;
  let scheduledMessageId: string | null = null;
  let scheduledRawRef: string | null = null;
  try {
    vaultPath = plugin.getVaultPath();
    const session = ensureKnowledgeBaseSession(settings, vaultPath);
    scheduledSessionId = session.id;
    const reportText = result.reportPath
      ? await readKnowledgeBaseReportExcerpt(vaultPath, result.reportPath, 3000).catch(() => null)
      : null;
    const message = buildScheduledMaintenanceChatMessage(result, reportText ?? "");
    scheduledMessageId = message.id;
    await plugin.externalizeMessageText(message, message.text);
    scheduledRawRef = message.rawRef ?? null;
    session.messages.push(message);
    session.title = "知识库管理";
    session.updatedAt = message.createdAt;
    await plugin.saveSettings(true);
    await afterMessageSaved();
    await plugin.pruneKnowledgeBaseHistoryByRetention().catch((cleanupError) => console.warn("知识库历史清理失败", cleanupError));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    rollbackScheduledMaintenanceMessage(settings, {
      sessionsBefore,
      sessionIdBefore,
      scheduledSessionId,
      scheduledMessageId
    });
    const cleanupError = scheduledRawRef
      ? await removeUnreferencedScheduledRawMessage(vaultPath, scheduledRawRef, plugin.getPluginDataDirName(), settings)
      : null;
    const warning = cleanupError
      ? `自动维护消息保存失败：${message}；外置原文清理失败：${cleanupError}`
      : `自动维护消息保存失败：${message}`;
    settings.knowledgeBase.lastError = appendKnowledgeBaseWarning(lastErrorBefore, warning);
    await saveSettingsSafely(plugin);
    new Notice(`每日维护消息保存失败：${message}`);
    return;
  }
  try {
    plugin.getCodexView()?.refreshAfterBackgroundKnowledgeMessage();
  } catch (error) {
    console.warn("每日维护消息刷新失败", error);
  }
}

export function buildScheduledMaintenanceChatMessage(
  result: KnowledgeBaseRunResult,
  reportText = "",
  createdAt = Date.now()
): ChatMessage {
  const ui = buildKnowledgeBaseMaintainReportPayload("maintain", result);
  return {
    id: newId("msg"),
    role: "assistant",
    title: "每日知识库维护",
    itemType: "knowledgeBase",
    status: result.status === "success"
      ? "completed"
      : result.status === "canceled"
        ? "canceled"
        : "failed",
    text: buildScheduledKnowledgeBaseMessage(result, reportText),
    ...(ui.runId ? { runId: ui.runId } : {}),
    ...(ui.backend ? { backendId: ui.backend } : {}),
    knowledgeBaseUi: ui,
    createdAt,
    completedAt: createdAt
  };
}

function rollbackScheduledMaintenanceMessage(
  settings: CodexForObsidianPlugin["settings"],
  options: {
    sessionsBefore: StoredSession[];
    sessionIdBefore: string;
    scheduledSessionId: string | null;
    scheduledMessageId: string | null;
  }
): void {
  const beforeById = new Map(options.sessionsBefore.map((session) => [session.id, session]));
  const scheduledSession = options.scheduledSessionId
    ? settings.sessions.find((session) => session.id === options.scheduledSessionId)
    : null;
  if (scheduledSession && options.scheduledMessageId) {
    scheduledSession.messages = scheduledSession.messages.filter((message) => message.id !== options.scheduledMessageId);
    const beforeSession = beforeById.get(scheduledSession.id);
    if (!beforeSession) {
      if (scheduledSession.messages.length === 0) {
        settings.sessions = settings.sessions.filter((session) => session.id !== scheduledSession.id);
      }
    } else if (sameSessionMessageIds(scheduledSession, beforeSession)) {
      Object.assign(scheduledSession, cloneStoredSessions([beforeSession])[0]);
    } else {
      scheduledSession.updatedAt = Math.max(
        beforeSession.updatedAt,
        scheduledSession.createdAt,
        ...scheduledSession.messages.map((message) => message.createdAt)
      );
    }
  }
  if (settings.knowledgeBase.sessionId === options.scheduledSessionId) {
    const scheduledStillExists = Boolean(options.scheduledSessionId && settings.sessions.some((session) => session.id === options.scheduledSessionId));
    settings.knowledgeBase.sessionId = scheduledStillExists ? options.scheduledSessionId! : options.sessionIdBefore;
  }
}

async function removeUnreferencedScheduledRawMessage(
  vaultPath: string,
  rawRef: string | null,
  pluginDir: string,
  settings: CodexForObsidianPlugin["settings"]
): Promise<string | null> {
  if (!vaultPath || !rawRef) return null;
  const stillReferenced = settings.sessions.some((session) => session.messages.some((message) => message.rawRef === rawRef));
  if (stillReferenced) return null;
  try {
    await fsp.rm(resolveRawRef(vaultPath, rawRef, pluginDir), { force: true });
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function sameSessionMessageIds(left: StoredSession, right: StoredSession): boolean {
  if (left.messages.length !== right.messages.length) return false;
  return left.messages.every((message, index) => message.id === right.messages[index]?.id);
}

function cloneStoredSessions(sessions: StoredSession[] | undefined): StoredSession[] {
  return clonePlainValue(sessions ?? []);
}

function clonePlainValue<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => clonePlainValue(item)) as T;
  if (value instanceof Date) return new Date(value.getTime()) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, clonePlainValue(entry)])
    ) as T;
  }
  return value;
}
