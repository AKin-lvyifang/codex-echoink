import { Modal, type App } from "obsidian";
import type { ChatMessage } from "../../settings/settings";
import { displayTextForMessage } from "../../core/raw-message-store";
import { parseKnowledgeBaseCommand, type KnowledgeBaseCommandIntent } from "../../knowledge-base/commands";
import type { KnowledgeBaseHistoryDaySummary } from "../../knowledge-base/history-store";
import { getDisplayKnowledgeBaseMessages } from "../../knowledge-base/session-history";

type KnowledgeBaseHistoryCommandFilter = "ask" | "lint" | "maintain" | "reingest" | "calibrate" | "outputs" | "inbox" | "journal" | "review" | "collect";
type KnowledgeBaseHistoryStatusFilter = "completed" | "canceled" | "failed";
type KnowledgeBaseHistoryFilter = "all" | "user" | "assistant" | "process" | KnowledgeBaseHistoryCommandFilter | KnowledgeBaseHistoryStatusFilter;

export class KnowledgeBaseHistoryModal extends Modal {
  private activeDate = "";
  private activeFilter: KnowledgeBaseHistoryFilter = "all";
  private messages: ChatMessage[] = [];
  private dateListEl: HTMLElement | null = null;
  private activeDateEl: HTMLElement | null = null;
  private filterEl: HTMLElement | null = null;
  private listEl: HTMLElement | null = null;

  constructor(
    app: App,
    private readonly days: KnowledgeBaseHistoryDaySummary[],
    private readonly loadDay: (date: string) => Promise<ChatMessage[]>,
    private readonly restoreDay: (date: string) => Promise<void>
  ) {
    super(app);
    this.activeDate = days[0]?.date ?? "";
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("codex-kb-history-modal");
    const header = contentEl.createDiv({ cls: "codex-kb-history-header" });
    header.createEl("h2", { text: "历史" });
    header.createDiv({ cls: "codex-kb-history-summary", text: `${this.days.length} 天记录 · 按天聚合` });

    const layout = contentEl.createDiv({ cls: "codex-kb-history-layout" });
    this.dateListEl = layout.createDiv({ cls: "codex-kb-history-days" });
    const main = layout.createDiv({ cls: "codex-kb-history-main" });
    this.filterEl = main.createDiv({ cls: "codex-kb-history-actions" });
    this.activeDateEl = main.createDiv({ cls: "codex-kb-history-current-day" });
    this.listEl = main.createDiv({ cls: "codex-kb-history-list" });
    this.renderDates();
    this.renderFilters();
    void this.selectDate(this.activeDate);
  }

  onClose(): void {
    this.contentEl.empty();
    this.contentEl.removeClass("codex-kb-history-modal");
  }

  private renderDates(): void {
    if (!this.dateListEl) return;
    this.dateListEl.empty();
    for (const day of this.days) {
      const button = this.dateListEl.createEl("button", {
        cls: `codex-kb-history-day ${day.date === this.activeDate ? "is-active" : ""}`.trim(),
        attr: { type: "button" }
      });
      button.createSpan({ text: day.date });
      button.createEl("small", { text: `${day.messageCount} 条` });
      button.onclick = () => void this.selectDate(day.date);
    }
  }

  private renderFilters(): void {
    if (!this.filterEl) return;
    this.filterEl.empty();
    const labels: Record<KnowledgeBaseHistoryFilter, string> = {
      all: "全部",
      user: "我",
      assistant: "回复",
      process: "过程",
      ask: "提问",
      lint: "体检",
      maintain: "维护",
      reingest: "重提炼",
      calibrate: "校准",
      outputs: "outputs",
      inbox: "inbox",
      journal: "日记",
      review: "周报",
      collect: "收集",
      completed: "成功",
      canceled: "取消",
      failed: "失败"
    };
    for (const filter of Object.keys(labels) as KnowledgeBaseHistoryFilter[]) {
      const button = this.filterEl.createEl("button", {
        cls: `codex-resource-tab ${filter === this.activeFilter ? "is-active" : ""}`.trim(),
        text: labels[filter],
        attr: { type: "button" }
      });
      button.onclick = () => {
        this.activeFilter = filter;
        this.renderFilters();
        this.renderMessages();
      };
    }
    const restoreButton = this.filterEl.createEl("button", { cls: "mod-cta", text: "恢复显示", attr: { type: "button", title: "只恢复可见内容，不恢复旧模型上下文" } });
    restoreButton.onclick = async () => {
      await this.restoreDay(this.activeDate);
      this.close();
    };
  }

  private async selectDate(date: string): Promise<void> {
    if (!date) return;
    this.activeDate = date;
    this.renderDates();
    if (this.listEl) {
      this.listEl.empty();
      this.listEl.createDiv({ cls: "codex-kb-history-more", text: "读取中..." });
    }
    try {
      this.messages = getDisplayKnowledgeBaseMessages({
        messages: await this.loadDay(date),
        historyActiveDate: date
      });
    } catch (error) {
      console.error("Codex knowledge history day read failed", error);
      this.messages = [];
      if (this.listEl) {
        this.listEl.empty();
        this.listEl.createDiv({ cls: "codex-kb-history-more", text: "读取失败" });
      }
      return;
    }
    this.renderMessages();
  }

  private renderMessages(): void {
    if (!this.listEl) return;
    this.listEl.empty();
    const commandByRunId = buildHistoryCommandByRunId(this.messages);
    const filtered = this.messages.filter((message) => historyMessageMatchesFilter(message, this.activeFilter, commandByRunId));
    if (this.activeDateEl) {
      this.activeDateEl.setText(`${this.activeDate} · ${filtered.length}/${this.messages.length} 条`);
    }
    if (!filtered.length) {
      this.listEl.createDiv({ cls: "codex-kb-history-more", text: "这一天没有符合筛选的记录。" });
      return;
    }
    for (const message of filtered) {
      const row = this.listEl.createDiv({ cls: "codex-kb-history-row" });
      const meta = row.createDiv({ cls: "codex-kb-history-meta" });
      meta.createSpan({ text: formatAbsoluteTime(message.createdAt) });
      meta.createSpan({ text: roleLabel(message.role) });
      if (message.title) meta.createSpan({ text: message.title });
      if (message.status) meta.createSpan({ text: message.status });
      row.createDiv({ cls: "codex-kb-history-text", text: compactHistoryText(message) });
    }
  }
}

function historyMessageMatchesFilter(message: ChatMessage, filter: KnowledgeBaseHistoryFilter, commandByRunId: Map<string, KnowledgeBaseHistoryCommandFilter>): boolean {
  if (filter === "all") return true;
  if (filter === "user") return message.role === "user";
  if (filter === "assistant") return message.role === "assistant";
  if (filter === "process") return Boolean(message.itemType) && message.role !== "user" && message.role !== "assistant";
  if (isHistoryCommandFilter(filter)) return historyCommandForMessage(message, commandByRunId) === filter;
  if (filter === "completed") return message.status === "completed";
  if (filter === "canceled") return message.status === "canceled" || message.status === "interrupted";
  if (filter === "failed") return message.status === "failed" || message.status === "error";
  return true;
}

function buildHistoryCommandByRunId(messages: ChatMessage[]): Map<string, KnowledgeBaseHistoryCommandFilter> {
  const map = new Map<string, KnowledgeBaseHistoryCommandFilter>();
  for (const message of messages) {
    if (message.role !== "user" || !message.runId) continue;
    const command = historyCommandFilterForIntent(parseKnowledgeBaseCommand(message.text, message.attachments?.length ?? 0).intent);
    if (command) map.set(message.runId, command);
  }
  return map;
}

function historyCommandForMessage(message: ChatMessage, commandByRunId: Map<string, KnowledgeBaseHistoryCommandFilter>): KnowledgeBaseHistoryCommandFilter | null {
  if (message.runId) {
    const command = commandByRunId.get(message.runId);
    if (command) return command;
  }
  return message.role === "user" ? historyCommandFilterForIntent(parseKnowledgeBaseCommand(message.text, message.attachments?.length ?? 0).intent) : null;
}

function historyCommandFilterForIntent(intent: KnowledgeBaseCommandIntent): KnowledgeBaseHistoryCommandFilter | null {
  if (intent === "ask" || intent === "journal" || intent === "review" || intent === "collect" || intent === "reingest" || intent === "maintain" || intent === "calibrate") return intent;
  if (intent === "lint") return "lint";
  if (intent === "process-outputs") return "outputs";
  if (intent === "process-inbox") return "inbox";
  return null;
}

function isHistoryCommandFilter(value: KnowledgeBaseHistoryFilter): value is KnowledgeBaseHistoryCommandFilter {
  return value === "ask" || value === "lint" || value === "maintain" || value === "reingest" || value === "calibrate" || value === "outputs" || value === "inbox" || value === "journal" || value === "review" || value === "collect";
}

function roleLabel(role: ChatMessage["role"]): string {
  if (role === "user") return "我";
  if (role === "assistant") return "EchoInk";
  if (role === "tool") return "工具";
  return "系统";
}

function compactHistoryText(message: ChatMessage): string {
  const text = (displayTextForMessage(message) || message.previewText || "").replace(/\s+/g, " ").trim();
  if (!text) return "(空消息)";
  return text.length > 180 ? `${text.slice(0, 180)}...` : text;
}

function formatAbsoluteTime(value: number): string {
  return new Date(value).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}
