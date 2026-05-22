export type KnowledgeBaseResultTitleStatus = "success" | "failed";

export interface KnowledgeBaseResultTitle {
  title: string;
  body: string;
  status: KnowledgeBaseResultTitleStatus;
}

export function extractKnowledgeBaseResultTitle(itemType: string | undefined, text: string): KnowledgeBaseResultTitle | null {
  if (itemType !== "knowledgeBase") return null;
  const normalized = text.replace(/\r\n/g, "\n");
  const newlineIndex = normalized.indexOf("\n");
  const firstLine = (newlineIndex === -1 ? normalized : normalized.slice(0, newlineIndex)).trim();
  const body = newlineIndex === -1 ? "" : normalized.slice(newlineIndex + 1);
  if (!firstLine) return null;

  if (isSuccessfulKnowledgeBaseResultTitle(firstLine)) {
    return { title: firstLine, body, status: "success" };
  }
  if (isFailedKnowledgeBaseResultTitle(firstLine)) {
    return { title: firstLine, body, status: "failed" };
  }
  return null;
}

function isSuccessfulKnowledgeBaseResultTitle(value: string): boolean {
  return /^知识库[^\n。]{1,40}完成。$/.test(value) || value === "每日维护执行完毕。";
}

function isFailedKnowledgeBaseResultTitle(value: string): boolean {
  return /^知识库[^\n。]{1,40}失败：.+$/.test(value) || value === "每日维护执行失败。" || value === "每日维护已取消。";
}
