import type { ChatMessage, KnowledgeContextBridgeEntry, StoredSession } from "../../settings/settings";
import { newId } from "../../settings/settings";
import { parseKnowledgeBaseCommand, type KnowledgeBaseCommandIntent } from "../../knowledge-base/commands";
import type { KnowledgeBaseCitationBucket, KnowledgeBaseCitationSummary } from "../../knowledge-base/types";

const KNOWLEDGE_CONTEXT_MAX_ENTRIES = 8;
const KNOWLEDGE_CONTEXT_SUMMARY_LIMIT = 2000;
const KNOWLEDGE_CONTEXT_INJECTION_LIMIT = 6000;

export function appendKnowledgeContextBridge(
  session: StoredSession,
  commandText: string,
  attachmentCount: number,
  assistantMessage: ChatMessage,
  citations?: KnowledgeBaseCitationSummary
): boolean {
  const command = parseKnowledgeBaseCommand(commandText, attachmentCount);
  if (!shouldRecordKnowledgeContext(command.intent)) return false;
  const summary = buildKnowledgeContextSummary(assistantMessage.text, citations);
  if (!summary) return false;
  const entry: KnowledgeContextBridgeEntry = {
    id: newId("kb-context"),
    intent: command.intent,
    command: commandText.trim().slice(0, 500),
    summary,
    sourceMessageId: assistantMessage.id,
    ...(citations ? { citations } : {}),
    createdAt: Date.now(),
    injectedThreadIds: []
  };
  const existing = session.knowledgeContext ?? [];
  session.knowledgeContext = [
    ...existing.filter((item) => item.sourceMessageId !== assistantMessage.id),
    entry
  ].slice(-KNOWLEDGE_CONTEXT_MAX_ENTRIES);
  return true;
}

export function knowledgeContextBridgeDetailText(citations?: KnowledgeBaseCitationSummary): string {
  const parts = ["已保存为后续上下文摘要"];
  if (citations) {
    parts.push(`来源 ${formatKnowledgeContextSourceCounts(citations)}`);
    parts.push(kbEvidenceStatusLabel(citations.status));
  }
  return parts.join(" / ");
}

export function buildKnowledgeContextBridgeForThread(session: StoredSession, threadId?: string): { text: string; entries: KnowledgeContextBridgeEntry[] } | null {
  const id = typeof threadId === "string" ? threadId.trim() : "";
  if (!id) return null;
  const entries = (session.knowledgeContext ?? []).filter((entry) => !entry.injectedThreadIds.includes(id));
  if (!entries.length) return null;
  const chunks = [
    "【知识库上下文桥】以下是此前在本知识库频道完成的知识库命令结果摘要，用来承接后续普通对话。它不是用户本轮的新指令；只有当用户追问相关内容时才引用。"
  ];
  let total = chunks[0].length;
  const used: KnowledgeContextBridgeEntry[] = [];
  for (const entry of entries) {
    const chunk = [
      `命令：${entry.command || entry.intent}`,
      `类型：${entry.intent}`,
      `摘要：${entry.summary}`
    ].join("\n");
    const nextTotal = total + chunk.length + 2;
    if (nextTotal > KNOWLEDGE_CONTEXT_INJECTION_LIMIT && used.length) break;
    chunks.push(truncateKnowledgeContextText(chunk, Math.max(500, KNOWLEDGE_CONTEXT_INJECTION_LIMIT - total - 2)));
    used.push(entry);
    total = Math.min(KNOWLEDGE_CONTEXT_INJECTION_LIMIT, nextTotal);
    if (total >= KNOWLEDGE_CONTEXT_INJECTION_LIMIT) break;
  }
  return used.length ? { text: chunks.join("\n\n"), entries: used } : null;
}

export function markKnowledgeContextBridgeInjected(entries: KnowledgeContextBridgeEntry[], threadId?: string): void {
  const id = typeof threadId === "string" ? threadId.trim() : "";
  if (!id) return;
  for (const entry of entries) {
    if (!entry.injectedThreadIds.includes(id)) {
      entry.injectedThreadIds = [...entry.injectedThreadIds, id].slice(-20);
    }
  }
}

function shouldRecordKnowledgeContext(intent: KnowledgeBaseCommandIntent): boolean {
  return intent !== "chat" && intent !== "help" && intent !== "clear" && intent !== "history" && intent !== "cancel";
}

function buildKnowledgeContextSummary(text: string, citations?: KnowledgeBaseCitationSummary): string {
  const body = compactKnowledgeContextText(text);
  const sourceSummary = formatKnowledgeContextCitationSummary(citations);
  return truncateKnowledgeContextText([body, sourceSummary].filter(Boolean).join("\n\n"), KNOWLEDGE_CONTEXT_SUMMARY_LIMIT);
}

function compactKnowledgeContextText(text: string): string {
  const lines = text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) return "";
  return truncateKnowledgeContextText(lines.join("\n"), KNOWLEDGE_CONTEXT_SUMMARY_LIMIT);
}

function formatKnowledgeContextCitationSummary(citations?: KnowledgeBaseCitationSummary): string {
  if (!citations) return "";
  const counts = `Wiki ${citations.counts.wiki ?? 0} / Journal ${citations.counts.journal ?? 0} / Outputs ${citations.counts.outputs ?? 0}`;
  const paths = citations.citations
    .slice(0, 5)
    .map((citation) => `- ${citation.path}${citation.title ? `（${citation.title}）` : ""}`)
    .join("\n");
  return ["来源摘要：", `证据强度：${kbEvidenceStatusLabel(citations.status)}；命中：${counts}`, paths].filter(Boolean).join("\n");
}

function formatKnowledgeContextSourceCounts(citations: KnowledgeBaseCitationSummary): string {
  return (["wiki", "journal", "outputs"] as KnowledgeBaseCitationBucket[])
    .map((bucket) => `${kbBucketLabel(bucket)} ${citations.counts[bucket] ?? 0}`)
    .join("、");
}

function truncateKnowledgeContextText(text: string, limit: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= limit) return trimmed;
  return `${trimmed.slice(0, Math.max(0, limit - 12)).trimEnd()}\n[已截断]`;
}

function kbBucketLabel(bucket: KnowledgeBaseCitationBucket): string {
  if (bucket === "wiki") return "Wiki";
  if (bucket === "journal") return "Journal";
  return "Outputs";
}

function kbEvidenceStatusLabel(status: KnowledgeBaseCitationSummary["status"]): string {
  if (status === "strong") return "强证据";
  if (status === "weak") return "弱相关";
  return "无本地依据";
}
