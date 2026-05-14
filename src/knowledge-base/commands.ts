export type KnowledgeBaseCommandIntent = "maintain" | "lint" | "reingest" | "process-inbox" | "journal" | "cancel" | "collect" | "help";
export type KnowledgeBaseCommandTarget = "inbox" | "raw-articles" | "raw-attachments" | "journal";

export interface KnowledgeBaseCommand {
  intent: KnowledgeBaseCommandIntent;
  target?: KnowledgeBaseCommandTarget;
  reason: string;
}

const URL_PATTERN = /https?:\/\/\S+/i;

export function parseKnowledgeBaseCommand(text: string, attachmentCount = 0): KnowledgeBaseCommand {
  const normalized = text.trim().toLowerCase();
  if (!normalized && attachmentCount <= 0) return { intent: "help", reason: "empty" };

  if (/取消|停止|中断|\bcancel\b|\bstop\b/.test(normalized)) {
    return { intent: "cancel", reason: "cancel" };
  }
  if (/只体检|体检|检查|扫描|lint|health|doctor/.test(normalized)) {
    return { intent: "lint", reason: "lint" };
  }
  if (/重新提炼|重新消化|重新整理|重提炼|reingest|redigest|re-digest/.test(normalized)) {
    return { intent: "reingest", reason: "reingest" };
  }
  if (/处理\s*inbox|整理\s*inbox|处理收件箱|整理收件箱|process\s*inbox/.test(normalized)) {
    return { intent: "process-inbox", reason: "process-inbox" };
  }
  if (/写日记|记日记|日报|daily journal|journal/.test(normalized)) {
    return { intent: "journal", target: "journal", reason: "journal" };
  }
  if (/维护|消化|整理|沉淀|更新知识库|ingest|digest|maintain/.test(normalized)) {
    return { intent: "maintain", reason: "maintain" };
  }
  if (attachmentCount > 0) {
    return { intent: "collect", target: "raw-attachments", reason: "attachment" };
  }
  if (URL_PATTERN.test(text) || /链接|网页|文章|公众号|收集|剪藏|保存到 raw|archive|clip/.test(normalized)) {
    return { intent: "collect", target: "raw-articles", reason: "source" };
  }
  if (/记一下|记录|想法|灵感|inbox|memo|note/.test(normalized)) {
    return { intent: "collect", target: "inbox", reason: "idea" };
  }
  return { intent: "help", reason: "unknown" };
}

export function knowledgeBaseHelpText(): string {
  return [
    "这是知识库管理频道。我可以在这里执行：",
    "",
    "- `只体检一下`：只生成体检报告，不消化 raw。",
    "- `维护知识库`：增量消化 raw，更新 wiki、索引和报告。",
    "- `重新提炼 ...`：按指定资料重新生成或更新 wiki。",
    "- `写日记：...`：写入 journal/daily。",
    "- `处理 inbox`：整理收件箱并写报告。",
    "- `收集这个链接 https://...`：写入 raw/articles/手动收集。",
    "- `记一下：...`：写入 inbox。",
    "- 附上图片或 PDF 后输入 `收集这个附件`：复制到 raw/attachments。"
  ].join("\n");
}
