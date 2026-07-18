import type { ChatMessage, DiffSummary, StoredSession } from "../../settings/settings";
import type { ProcessFileRef } from "../../types/app-server";
import { buildDiffSummary, diffSummaryLabel, serializeFileChanges } from "../../core/diff-summary";
import { basename, reasoningTextFromPayload, summarizeProcessEvent } from "../../core/mapping";
import { newId } from "../../settings/settings";
import { insertAgentProcessMessage, isAgentProcessItemType as isProcessItemType, isAgentTurnTerminalMessage } from "./agent-turn-process";

const TERMINAL_CARRIER_STATUSES = new Set(["completed", "failed", "error", "interrupted", "cancelled", "canceled"]);

export type SessionMessageInput = Omit<ChatMessage, "id" | "createdAt"> & Partial<Pick<ChatMessage, "id" | "createdAt">>;

export interface SessionMessageStoreContext {
  getActiveRunId(): string;
  getActiveTurnId(): string;
  getVaultPath(): string;
  externalizeMessageText(message: ChatMessage, text: string): Promise<void>;
  renderMessagesIfActive(session: StoredSession, updatedMessage?: ChatMessage): void;
  scheduleSessionSave(): void;
}

export class SessionMessageStore {
  private activeThinkingMessageId = "";
  private activePlanMessageId = "";
  private activeItemMessages = new Map<string, string>();

  constructor(private readonly context: SessionMessageStoreContext) {}

  clearActiveRun(): void {
    this.activeThinkingMessageId = "";
    this.activePlanMessageId = "";
    this.activeItemMessages.clear();
  }

  appendItemDelta(session: StoredSession, itemId: string, role: ChatMessage["role"], delta: string, itemType: string, title: string): void {
    if (!delta) return;
    let messageId = this.activeItemMessages.get(itemId);
    let message = messageId ? session.messages.find((item) => item.id === messageId) : null;
    if (!message) {
      message = {
        id: itemId || newId("msg"),
        role,
        text: "",
        itemType,
        title,
        runId: this.context.getActiveRunId() || undefined,
        turnId: this.context.getActiveTurnId() || undefined,
        createdAt: Date.now()
      };
      session.messages.push(message);
      this.activeItemMessages.set(itemId, message.id);
    }
    message.text += delta;
    session.updatedAt = Date.now();
    this.context.renderMessagesIfActive(session, message);
  }

  appendProcessDelta(session: StoredSession, itemId: string, itemType: string, delta: string, payload: unknown): void {
    if (!delta) return;
    let messageId = this.activeItemMessages.get(itemId);
    let message = messageId ? session.messages.find((item) => item.id === messageId) : null;
    const payloadRecord = processPayloadRecord(payload);
    const summaryPayload = { ...payloadRecord, status: payloadRecord.status ?? "running" };
    const summary = this.summarize(itemType, summaryPayload, session);
    if (!message) {
      message = {
        id: itemId || newId("process"),
        role: roleForProcessItem(itemType),
        text: "",
        itemType,
        title: summary.title,
        details: summary.detail,
        files: summary.files,
        processKind: summary.kind,
        runId: this.context.getActiveRunId() || undefined,
        turnId: this.context.getActiveTurnId() || undefined,
        status: "running",
        createdAt: Date.now()
      };
      session.messages.push(message);
      this.activeItemMessages.set(itemId, message.id);
    }
    if (itemType === "reasoning" || !message.title || message.title === "命令输出") message.title = summary.title;
    if (itemType === "reasoning") {
      if (summary.detail) message.details = summary.detail;
    } else if (!message.details && summary.detail) {
      message.details = summary.detail;
    }
    message.processKind = summary.kind;
    message.files = mergeProcessFiles(message.files, summary.files);
    message.status = "running";
    message.text += delta;
    session.updatedAt = Date.now();
    this.context.renderMessagesIfActive(session, message);
  }

  ensureThinkingMessage(session: StoredSession, title: string, text: string): void {
    if (this.activeThinkingMessageId) {
      const existing = session.messages.find((message) => message.id === this.activeThinkingMessageId);
      if (existing) {
        existing.title = title;
        existing.text = text;
        existing.status = "running";
        this.context.renderMessagesIfActive(session);
        return;
      }
    }
    const id = newId("thinking");
    this.activeThinkingMessageId = id;
    session.messages.push({
      id,
      role: "assistant",
      title,
      text,
      itemType: "thinking",
      runId: this.context.getActiveRunId() || undefined,
      turnId: this.context.getActiveTurnId() || undefined,
      status: "running",
      createdAt: Date.now()
    });
    this.context.renderMessagesIfActive(session);
  }

  dismissThinkingMessage(session: StoredSession): void {
    const activeId = this.activeThinkingMessageId;
    this.activeThinkingMessageId = "";
    if (!activeId) return;
    const messageIndex = session.messages.findIndex((item) => item.id === activeId);
    if (messageIndex < 0) return;
    session.messages.splice(messageIndex, 1);
    session.updatedAt = Date.now();
    this.context.renderMessagesIfActive(session);
  }

  markThinkingAsStreaming(session: StoredSession): void {
    const message = session.messages.find((item) => item.id === this.activeThinkingMessageId);
    if (!message || message.status !== "running") return;
    message.text = "正在生成回复...";
    this.context.renderMessagesIfActive(session);
  }

  finishThinkingMessage(session: StoredSession, status: string): void {
    if (/完成|成功/.test(status)) {
      this.dismissThinkingMessage(session);
      return;
    }
    const messageIndex = session.messages.findIndex((item) => item.id === this.activeThinkingMessageId);
    const message = messageIndex >= 0 ? session.messages[messageIndex] : null;
    if (!message) return;
    const hasNativeProcess = session.messages.some((item) => item.id !== message.id
      && sameAgentRun(item, message)
      && isProcessItemType(item.itemType));
    const hasTerminalCarrier = session.messages.some((item) => item.id !== message.id
      && sameAgentRun(item, message)
      && isAgentTurnTerminalMessage(item)
      && TERMINAL_CARRIER_STATUSES.has(item.status ?? ""));
    session.messages.splice(messageIndex, 1);
    if (!hasNativeProcess && !hasTerminalCarrier) {
      const settled = settledThinkingMessage(status);
      message.title = "处理过程";
      message.text = settled.text;
      message.status = settled.status;
      message.completedAt = Date.now();
      insertAgentProcessMessage(session.messages, message);
    }
    session.updatedAt = Date.now();
    this.activeThinkingMessageId = "";
    this.context.renderMessagesIfActive(session);
  }

  finishPlanMessage(session: StoredSession): void {
    const message = session.messages.find((item) => item.id === this.activePlanMessageId);
    if (message) message.status = "completed";
    this.activePlanMessageId = "";
  }

  finishRunningProcessMessages(session: StoredSession, status: string): void {
    for (const message of session.messages) {
      if (isProcessItemType(message.itemType) && message.status === "running") {
        message.status = status;
        if (message.text) void this.context.externalizeMessageText(message, message.text);
        if (message.itemType === "reasoning") this.refreshProcessSummary(message, status, session);
      }
    }
    this.context.renderMessagesIfActive(session);
  }

  renderPlanUpdate(session: StoredSession, params: unknown): void {
    const payload = processPayloadRecord(params);
    const lines: string[] = [];
    if (typeof payload.explanation === "string" && payload.explanation) lines.push(payload.explanation, "");
    const plan = Array.isArray(payload.plan) ? payload.plan : [];
    for (const rawItem of plan) {
      const item = processPayloadRecord(rawItem);
      const status = typeof item.status === "string" ? item.status : "";
      const step = typeof item.step === "string" ? item.step : "";
      if (!step) continue;
      const mark = status === "completed" ? "x" : " ";
      const suffix = status === "inProgress" ? " (进行中)" : "";
      lines.push(`- [${mark}] ${step}${suffix}`);
    }
    if (!lines.length) return;
    let message = this.activePlanMessageId ? session.messages.find((item) => item.id === this.activePlanMessageId) : null;
    if (!message) {
      message = {
        id: newId("plan"),
        role: "assistant",
        itemType: "plan",
        title: "更新计划",
        text: "",
        processKind: "plan",
        runId: this.context.getActiveRunId() || undefined,
        turnId: this.context.getActiveTurnId() || undefined,
        status: "running",
        createdAt: Date.now()
      };
      this.activePlanMessageId = message.id;
      session.messages.push(message);
    }
    message.text = lines.join("\n");
    session.updatedAt = Date.now();
    this.context.renderMessagesIfActive(session);
  }

  renderStartedItem(session: StoredSession, item: unknown): void {
    const payload = processPayloadRecord(item);
    const type = stringPayload(payload.type);
    if (!isProcessItemType(type)) return;
    if (type === "reasoning" && !rawTextForProcessItem(payload)) return;
    const status = stringPayload(payload.status) || "running";
    void this.upsertProcessItem(session, stringPayload(payload.id) || newId("process"), type, rawTextForProcessItem(payload), status, { ...payload, status });
  }

  async renderCompletedItem(session: StoredSession, item: unknown): Promise<void> {
    const payload = processPayloadRecord(item);
    const type = stringPayload(payload.type);
    if (!type) return;
    if (type === "agentMessage") return;
    const id = stringPayload(payload.id) || newId("process");
    const status = stringPayload(payload.status) || "completed";
    if (type === "reasoning" || type === "plan") {
      const text = rawTextForProcessItem(payload);
      if (text) {
        await this.upsertProcessItem(session, id, type, text, status, { ...payload, status });
      } else {
        this.finishProcessItem(session, id, status);
      }
      return;
    }
    if (type === "commandExecution") {
      await this.upsertProcessItem(session, id, "commandExecution", `${stringPayload(payload.command)}\n\n${stringPayload(payload.aggregatedOutput)}`.trim(), status, payload);
    } else if (type === "fileChange") {
      const changes = Array.isArray(payload.changes) ? payload.changes : [];
      const diffSummary = buildDiffSummary(changes);
      const text = serializeFileChanges(changes);
      await this.upsertProcessItem(session, id, "fileChange", text || status, status, payload, diffSummary);
    } else if (type === "mcpToolCall") {
      await this.upsertProcessItem(session, id, "mcpToolCall", JSON.stringify(payload.result ?? payload.error ?? payload.arguments, null, 2), status, payload);
    } else if (type === "dynamicToolCall") {
      await this.upsertProcessItem(session, id, "dynamicToolCall", JSON.stringify(payload.contentItems ?? payload.result ?? payload.arguments, null, 2), status, payload);
    } else if (type === "collabAgentToolCall") {
      await this.upsertProcessItem(session, id, "collabAgentToolCall", JSON.stringify(payload.result ?? payload.arguments ?? payload, null, 2), status, payload);
    } else if (type === "imageView") {
      const itemPath = stringPayload(payload.path);
      if (!itemPath) return;
      this.addMessageToSession(session, {
        role: "assistant",
        title: "图片",
        itemType: "image",
        text: itemPath,
        images: [{ type: "image", name: basename(itemPath), path: itemPath }],
        createdAt: Date.now()
      });
    } else if (type === "contextCompaction") {
      this.addMessageToSession(session, { role: "system", title: "上下文压缩", itemType: "contextCompaction", text: "Codex 已自动压缩上下文。", createdAt: Date.now() });
    }
  }

  async upsertProcessItem(session: StoredSession, id: string, itemType: string, text: string, status: string | undefined, payload: unknown, diffSummary?: DiffSummary): Promise<void> {
    const summary = this.summarize(itemType, { ...processPayloadRecord(payload), status }, session);
    const existingId = this.activeItemMessages.get(id);
    const existing = existingId ? session.messages.find((item) => item.id === existingId) : null;
    if (existing) {
      existing.role = roleForProcessItem(itemType);
      existing.itemType = itemType;
      existing.title = summary.title;
      existing.details = diffSummary ? diffSummaryLabel(diffSummary) : summary.detail || existing.details;
      existing.diffSummary = diffSummary;
      existing.files = mergeProcessFiles(existing.files, summary.files);
      existing.processKind = summary.kind;
      if (text) await this.context.externalizeMessageText(existing, text);
      existing.status = status;
      existing.turnId = this.context.getActiveTurnId() || existing.turnId;
      existing.runId = this.context.getActiveRunId() || existing.runId;
    } else {
      const message: ChatMessage = {
        id,
        role: roleForProcessItem(itemType),
        itemType,
        title: summary.title,
        details: diffSummary ? diffSummaryLabel(diffSummary) : summary.detail,
        diffSummary,
        files: summary.files,
        processKind: summary.kind,
        text,
        runId: this.context.getActiveRunId() || undefined,
        turnId: this.context.getActiveTurnId() || undefined,
        status,
        createdAt: Date.now()
      };
      if (text) await this.context.externalizeMessageText(message, text);
      session.messages.push(message);
      this.activeItemMessages.set(id, id);
    }
    session.updatedAt = Date.now();
    this.context.renderMessagesIfActive(session);
  }

  addMessageToSession(session: StoredSession, message: SessionMessageInput): void {
    session.messages.push({
      id: message.id ?? newId("msg"),
      createdAt: message.createdAt ?? Date.now(),
      role: message.role,
      text: message.text,
      previewText: message.previewText,
      rawRef: message.rawRef,
      rawSize: message.rawSize,
      rawLines: message.rawLines,
      rawTruncatedForPreview: message.rawTruncatedForPreview,
      phase: message.phase,
      itemType: message.itemType,
      runId: message.runId ?? (this.context.getActiveRunId() || undefined),
      turnId: message.turnId ?? (this.context.getActiveTurnId() || undefined),
      processKind: message.processKind,
      title: message.title,
      status: message.status,
      details: message.details,
      diffSummary: message.diffSummary,
      citations: message.citations,
      knowledgeBaseUi: message.knowledgeBaseUi,
      attachments: message.attachments,
      files: message.files,
      images: message.images
    });
    session.updatedAt = Date.now();
    this.context.renderMessagesIfActive(session);
    this.context.scheduleSessionSave();
  }

  moveMessageToEnd(session: StoredSession, messageId: string): void {
    const index = session.messages.findIndex((message) => message.id === messageId);
    if (index < 0 || index === session.messages.length - 1) return;
    const [message] = session.messages.splice(index, 1);
    session.messages.push(message);
  }

  private finishProcessItem(session: StoredSession, id: string, status: string): void {
    const existingId = this.activeItemMessages.get(id);
    const existing = existingId ? session.messages.find((item) => item.id === existingId) : session.messages.find((item) => item.id === id);
    if (!existing) return;
    existing.status = status;
    if (existing.itemType === "reasoning") this.refreshProcessSummary(existing, status, session);
    session.updatedAt = Date.now();
    this.context.renderMessagesIfActive(session);
  }

  private refreshProcessSummary(message: ChatMessage, status: string, session: StoredSession): void {
    if (!message.itemType) return;
    const summary = this.summarize(message.itemType, { text: message.text, status }, session);
    message.title = summary.title;
    if (summary.detail) message.details = summary.detail;
    message.processKind = summary.kind;
  }

  private summarize(itemType: string, payload: Record<string, unknown>, session: StoredSession) {
    const vaultPath = this.context.getVaultPath();
    return summarizeProcessEvent(itemType, payload, vaultPath, session.cwd || vaultPath);
  }
}

function sameAgentRun(left: ChatMessage, right: ChatMessage): boolean {
  if (left.runId || right.runId) return Boolean(left.runId && right.runId && left.runId === right.runId);
  return Boolean(left.turnId && right.turnId && left.turnId === right.turnId);
}

function settledThinkingMessage(status: string): { status: string; text: string } {
  if (status === "recovery-pending" || /安全恢复中|恢复中|等待恢复|正在恢复/.test(status)) {
    return { status: "recovery-pending", text: "安全恢复中" };
  }
  if (status === "recovery-blocked" || /恢复受阻|恢复被阻断/.test(status)) {
    return { status: "recovery-blocked", text: "安全恢复受阻" };
  }
  if (/完成|成功/.test(status)) return { status: "completed", text: "处理完成" };
  if (/中断|取消/.test(status)) return { status: "interrupted", text: "处理已中断" };
  return { status: "failed", text: "处理失败" };
}

function roleForProcessItem(itemType: string): ChatMessage["role"] {
  return itemType === "reasoning" || itemType === "plan" ? "assistant" : "tool";
}

function rawTextForProcessItem(item: unknown): string {
  const payload = processPayloadRecord(item);
  const type = stringPayload(payload.type);
  if (type === "commandExecution") return stringPayload(payload.command);
  if (type === "fileChange") return (Array.isArray(payload.changes) ? payload.changes : [])
    .map((change) => stringPayload(processPayloadRecord(change).path))
    .filter(Boolean)
    .join("\n");
  if (type === "mcpToolCall") return [payload.server, payload.tool].map(stringPayload).filter(Boolean).join(".");
  if (type === "dynamicToolCall") return [payload.namespace, payload.tool].map(stringPayload).filter(Boolean).join(".");
  if (type === "collabAgentToolCall") return stringPayload(payload.tool);
  if (type === "reasoning") return reasoningTextFromPayload(payload);
  if (type === "plan") return stringPayload(payload.text);
  return "";
}

function processPayloadRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringPayload(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function mergeProcessFiles(current: ProcessFileRef[] | undefined, incoming: ProcessFileRef[]): ProcessFileRef[] {
  const byKey = new Map<string, ProcessFileRef>();
  for (const file of [...(current ?? []), ...incoming]) {
    byKey.set(`${file.kind}:${file.path}`, file);
  }
  return Array.from(byKey.values()).slice(0, 8);
}
