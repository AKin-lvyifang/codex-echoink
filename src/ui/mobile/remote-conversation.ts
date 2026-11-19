import { setIcon } from "obsidian";
import { GENERAL_ASSISTANT_ID } from "../../agents/types";
import type { MobileStore } from "../../mobile/store";
import type { SyncFs } from "../../sync/fs";
import type { SyncOverviewService } from "../../sync/overview-service";
import { forkPrefillText, readSyncConversationMessages, syncForkSource, type RemoteConversationSummary, type SyncConversationMessage } from "../../sync/conversations";
import { formatMobileDateTime } from "../../mobile/date-display";
import { shellElement as el } from "./shell-controls";

const icon = (document: Document, name: string) => { const span = el(document, "span", "emc-icon"); span.setAttribute("aria-hidden", "true"); setIcon(span, name); return span; };

/** Home section: other devices' conversations, newest first. Hidden when there are none. */
export function renderRemoteConversationList(document: Document, overview: SyncOverviewService | null, open: (summary: RemoteConversationSummary) => void, prefix: "ip" | "pd"): HTMLElement | null {
  const items = overview?.snapshot().conversations.slice(0, 20) ?? [];
  if (!items.length) return null;
  const area = el(document, "section", `${prefix}-section emc-home-conversations`), heading = el(document, "div", `${prefix}-section-heading`);
  heading.append(el(document, "h2", "", "其他设备的对话"), el(document, "span", `${prefix}-count`, `${items.length}`));
  const list = el(document, "div", "emc-conversations");
  for (const item of items) {
    const row = el(document, "button", "emc-conversation"); row.type = "button"; row.dataset.conversationId = item.id; row.dataset.deviceId = item.deviceId;
    const copy = el(document, "div", "emc-grow");
    copy.append(el(document, "div", "emc-conversation-title", item.title));
    copy.append(el(document, "div", "emc-conversation-sub", [`在${item.deviceName}上`, formatMobileDateTime(item.updatedAt), item.continuedOn.length ? `已在${item.continuedOn.map(c => c.deviceName).join("、")}接着聊` : item.preview].filter(Boolean).join(" · ")));
    row.append(icon(document, "message-circle"), copy, icon(document, "chevron-right"));
    row.addEventListener("click", () => open(item));
    list.append(row);
  }
  area.append(heading, list);
  return area;
}

export interface RemoteConversationPageInput {
  readonly document: Document;
  readonly fs: SyncFs;
  readonly store: MobileStore;
  readonly summary: RemoteConversationSummary;
  readonly agentIds: () => readonly string[];
  readonly openAgent: (agentId: string) => Promise<void>;
  readonly error: (error: unknown) => void;
}

/** Read-only transcript plus "continue here": the fork becomes a new task draft on this device. */
export function createRemoteConversationContent(input: RemoteConversationPageInput): HTMLElement {
  const { document, summary } = input;
  const root = el(document, "div", "emc-remote-conversation");
  const where = el(document, "div", "emc-status emc-device");
  where.append(icon(document, "monitor-smartphone"), el(document, "span", "", `在${summary.deviceName}上 · ${formatMobileDateTime(summary.updatedAt)} · ${summary.messageCount} 条`));
  root.append(el(document, "h1", "", summary.title), where);
  if (summary.continuedOn.length) root.append(el(document, "div", "emc-muted", `已在${summary.continuedOn.map(item => item.deviceName).join("、")}接着聊`));
  const list = el(document, "div", "emc-remote-messages"); list.append(el(document, "div", "emc-empty", "正在读取…")); root.append(list);
  const fork = el(document, "button", "emc-button is-strong", "在这台设备接着聊"); fork.type = "button"; fork.disabled = true;
  let messages: SyncConversationMessage[] = [];
  fork.addEventListener("click", () => {
    fork.disabled = true;
    void (async () => {
      const agentId = input.agentIds().includes(summary.agentId) ? summary.agentId : GENERAL_ASSISTANT_ID;
      const text = forkPrefillText(summary, messages);
      await input.store.update(latest => {
        const previous = latest.newTaskDrafts[agentId];
        if (previous?.text.trim() || previous?.attachments.length) throw new Error("这位 Agent 还有没发送的内容，先处理它再接着聊。");
        latest.newTaskDrafts[agentId] = { ...previous, text, attachments: [], prefillSource: syncForkSource(summary.deviceId, summary.id) };
        latest.page = { kind: "list", agentId };
      });
      await input.openAgent(agentId);
    })().catch(error => { fork.disabled = false; input.error(error); });
  });
  const actions = el(document, "div", "emc-remote-actions"); actions.append(fork); root.append(actions);
  void readSyncConversationMessages(input.fs, summary.deviceId, summary.id).then(read => {
    messages = read; list.replaceChildren();
    if (!messages.length) list.append(el(document, "div", "emc-empty", "暂时无法读取这段对话的记录。"));
    for (const message of messages) {
      if (message.role === "tool") { list.append(el(document, "div", "emc-remote-msg is-tool", message.text)); continue; }
      const row = el(document, "div", `emc-remote-msg is-${message.role}`);
      row.append(el(document, "div", "emc-remote-msg-who", message.role === "user" ? "我" : "助手"), el(document, "div", "emc-remote-msg-text", message.text));
      list.append(row);
    }
    fork.disabled = !messages.length;
  }).catch(error => { list.replaceChildren(el(document, "div", "emc-empty", "暂时无法读取这段对话的记录。请稍后重试。")); input.error(error); });
  return root;
}
