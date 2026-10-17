import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { PiKnowledgeReference } from "./contracts";
import type { KnowledgeRelationPage } from "../../knowledge-base/knowledge-relations";

export const KNOWLEDGE_ASK_PROTOCOL = [
  "知识阅读建议：根据当前问题自主选择资料。按需核对对象、期间、适用条件和资料性质；上下文足够时直接推进，有歧义可声明合理假设或分情况回答，确实影响结论且无法合理处理时再澄清。",
  "路径和关系列表是线索；实际交付并核验的原文可直接作为依据，已覆盖当前问题时无需为重复确认而再读。片段外的内容及链接目标仍属未读；按需只补与当前问题有关的缺口，可继续搜索、按段读取或用 knowledge_search mode=related 查看关联。来源上的 hasMore 只表示文件还有其他正文，不表示必须读完整篇。",
  "按问题选择原始依据、实施结果、限制、反例或版本；普通链接不等于支持或替代关系。修改时间和版本号不能单独证明哪个值可靠。判断应说明根据，推断与原文事实区分。",
  "计算时给出采用值、单位和公式，区分活动、期间、实际与预算。数据不全可以给出条件结果或估算并说明缺口，不补造数据。",
  "由你判断何时回答，不必完成固定读数、清空关联候选或取得通过信号。缺字段、断链、歧义或单条来源变化只影响相应材料；可换来源、重读或缩小结论。引用实际收到的正文，不声称穷尽知识库。"
].join("\n");

/** Built from the current user turn's delivered resource and successful tool envelopes only. */
export function knowledgeReadingState(
  initial: readonly Readonly<PiKnowledgeReference>[],
  messages: readonly AgentMessage[]
): string {
  const reads = new Map<string, Record<string, unknown>>();
  const candidates = new Set<string>();
  const pages = new Map<string, boolean>();
  const failures: string[] = [];
  const addRelations = (page: KnowledgeRelationPage | undefined) => {
    if (!page || !Array.isArray(page.items)) return;
    pages.set(page.vaultRelativePath, page.hasMore);
    for (const relation of page.items) {
      const target = relation.direction === "incoming" ? relation.source : relation.target;
      if (target) candidates.add(target.vaultRelativePath);
      for (const candidate of relation.candidates ?? []) candidates.add(candidate.vaultRelativePath);
    }
  };
  const addRead = (reference: Readonly<PiKnowledgeReference>) => {
    reads.set(reference.referenceId, { path: reference.vaultRelativePath, revision: reference.contentRevision, lines: [reference.lineStart, reference.lineEnd], totalLines: reference.totalLines, hasUnreturnedBody: reference.hasMore });
    addRelations(reference.related);
  };
  initial.forEach(addRead);
  for (const message of messages) {
    if (message.role !== "toolResult" || !["knowledge_read", "knowledge_search"].includes(message.toolName)) continue;
    const details = message.details as Record<string, unknown> | undefined;
    if (message.isError || details?.status !== "completed" || details.truncated === true) {
      failures.push(typeof details?.errorCode === "string"
        ? details.errorCode
        : details?.truncated ? "result_truncated" : "result_not_delivered");
      continue;
    }
    for (const reference of (Array.isArray(details.references) ? details.references : []) as PiKnowledgeReference[]) addRead(reference);
    try {
      const text = message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
      const value = JSON.parse(text) as { related?: KnowledgeRelationPage; hits?: { vaultRelativePath: string }[] };
      addRelations(value.related);
      for (const hit of value.hits ?? []) candidates.add(hit.vaultRelativePath);
    } catch { /* Unparseable optional hints never erase delivered reads. */ }
  }
  if (!reads.size && !candidates.size && !failures.length) return "";
  return "本轮阅读状态（仅描述已交付范围，不是答案门槛；已交付不等于已正确理解）：\n" + JSON.stringify({
    deliveredRanges: [...reads.values()].slice(-24),
    deliveredRangeCount: reads.size,
    candidatePaths: [...candidates].slice(-24),
    candidateCount: candidates.size,
    relationPagesWithMore: [...pages].filter(([, more]) => more).map(([value]) => value).slice(-16),
    localFailures: failures.slice(-8)
  });
}
