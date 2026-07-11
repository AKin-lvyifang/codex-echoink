import type { ChatMessage } from "../settings/settings";

export function settleStaleRunningMessages(messages: ChatMessage[]): number {
  let settled = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.status !== "running") continue;

    if (message.itemType === "thinking" || isEmptyProcessMessage(message)) {
      messages.splice(index, 1);
      settled += 1;
      continue;
    }

    if (isKnowledgeBaseRunMessage(message)) {
      message.status = "failed";
      message.text = staleKnowledgeBaseRunText(message.knowledgeBaseUi?.mode);
      delete message.knowledgeBaseUi;
      settled += 1;
      continue;
    }

    message.status = "interrupted";
    settled += 1;
  }
  return settled;
}

function isEmptyProcessMessage(message: ChatMessage): boolean {
  if (!isProcessItemType(message.itemType)) return false;
  return !String(message.text ?? "").trim();
}

function isProcessItemType(itemType?: string): boolean {
  return itemType === "reasoning" || itemType === "commandExecution" || itemType === "fileChange" || itemType === "mcpToolCall" || itemType === "dynamicToolCall" || itemType === "collabAgentToolCall" || itemType === "plan";
}

function isKnowledgeBaseRunMessage(message: ChatMessage): boolean {
  return message.itemType === "knowledgeBase" && message.knowledgeBaseUi?.kind === "maintain-run";
}

function staleKnowledgeBaseRunText(mode: unknown): string {
  return `知识库${knowledgeBaseModeLabel(mode)}失败：任务中断，未收到完成报告。`;
}

function knowledgeBaseModeLabel(mode: unknown): string {
  switch (mode) {
    case "lint":
      return "体检";
    case "reingest":
      return "重新提炼";
    case "calibrate":
      return "Raw 状态校准";
    case "outputs":
      return "Outputs 整理";
    case "inbox":
      return "Inbox 分流";
    case "maintain":
    default:
      return "维护";
  }
}
