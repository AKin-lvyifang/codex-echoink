export type KnowledgeBaseCommandIntent = "init" | "maintain" | "lint" | "reingest" | "process-outputs" | "process-inbox" | "journal" | "ask" | "review" | "cancel" | "collect" | "help";
export type KnowledgeBaseCommandTarget = "inbox" | "raw-articles" | "raw-attachments" | "journal";
export type KnowledgeBaseReviewCommandKind = "knowledge-base" | "agent-chat";

export interface KnowledgeBaseCommand {
  intent: KnowledgeBaseCommandIntent;
  target?: KnowledgeBaseCommandTarget;
  reviewKind?: KnowledgeBaseReviewCommandKind;
  reason: string;
  confirm?: boolean;
}

export interface KnowledgeBaseCommandGuide {
  command: string;
  description: string;
}

export const KNOWLEDGE_BASE_COMMAND_GUIDE: KnowledgeBaseCommandGuide[] = [
  { command: "/ask ...", description: "对知识库发问" },
  { command: "/check ...", description: "只体检知识库" },
  { command: "/maintain ...", description: "维护 raw 到 wiki" },
  { command: "/outputs ...", description: "处理 outputs 并提炼长期价值" },
  { command: "/inbox ...", description: "整理收件箱" },
  { command: "/journal ...", description: "写日记" },
  { command: "/week", description: "写知识库周报；/week agent 写 Agent 周报" },
  { command: "/init", description: "预览初始化；/init confirm 才执行" },
  { command: "/help", description: "显示这份命令说明" }
];

const URL_PATTERN = /https?:\/\/\S+/i;

export function parseKnowledgeBaseCommand(text: string, attachmentCount = 0): KnowledgeBaseCommand {
  const normalized = text.trim().toLowerCase();
  if (!normalized && attachmentCount <= 0) return { intent: "help", reason: "empty" };
  const slashCommand = parseSlashKnowledgeBaseCommand(normalized);
  if (slashCommand) return slashCommand;

  if (/取消|停止|中断|\bcancel\b|\bstop\b/.test(normalized)) {
    return { intent: "cancel", reason: "cancel" };
  }
  if (/只体检|体检|检查|扫描|lint|health|doctor/.test(normalized)) {
    return { intent: "lint", reason: "lint" };
  }
  if (/重新提炼|重新消化|重新整理|重提炼|reingest|redigest|re-digest/.test(normalized)) {
    return { intent: "reingest", reason: "reingest" };
  }
  if (/处理\s*outputs|整理\s*outputs|处理输出|整理输出|outputs\s*to\s*wiki|process\s*outputs/.test(normalized)) {
    return { intent: "process-outputs", reason: "process-outputs" };
  }
  if (/处理\s*inbox|整理\s*inbox|处理收件箱|整理收件箱|process\s*inbox/.test(normalized)) {
    return { intent: "process-inbox", reason: "process-inbox" };
  }
  if (/写日记|记日记|日报|daily journal|journal/.test(normalized)) {
    return { intent: "journal", target: "journal", reason: "journal" };
  }
  if (/写周报|周报|weekly review/.test(normalized)) {
    return { intent: "review", reviewKind: reviewKindFromText(normalized), reason: "review" };
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
  if (looksLikeKnowledgeQuestion(text)) {
    return { intent: "ask", reason: "question" };
  }
  return { intent: "help", reason: "unknown" };
}

export function knowledgeBaseHelpText(): string {
  return [
    "知识库管理频道快捷命令：",
    "",
    ...KNOWLEDGE_BASE_COMMAND_GUIDE.map((item) => `- \`${item.command}\`：${item.description}`),
    "",
    "自然语言也支持：只体检一下、维护知识库、写周报、写日记、收集这个链接、记一下。"
  ].join("\n");
}

function parseSlashKnowledgeBaseCommand(normalized: string): KnowledgeBaseCommand | null {
  const match = normalized.match(/^\/([\p{Script=Han}a-z-]+)(?=$|[\s:：?？])/u);
  if (!match) return null;
  const command = match[1];
  if (command === "help" || command === "帮助") return { intent: "help", reason: "slash-help" };
  if (command === "cancel" || command === "stop" || command === "取消") return { intent: "cancel", reason: "slash-cancel" };
  if (command === "init" || command === "初始化") return { intent: "init", reason: "slash-init", confirm: isInitConfirmCommand(normalized) };
  if (command === "check" || command === "lint" || command === "doctor" || command === "体检" || command === "检查") return { intent: "lint", reason: "slash-lint" };
  if (command === "maintain" || command === "ingest" || command === "digest" || command === "维护") return { intent: "maintain", reason: "slash-maintain" };
  if (command === "outputs" || command === "output" || command === "处理outputs" || command === "处理输出") return { intent: "process-outputs", reason: "slash-outputs" };
  if (command === "inbox" || command === "处理inbox" || command === "收件箱") return { intent: "process-inbox", reason: "slash-inbox" };
  if (command === "journal" || command === "daily" || command === "diary" || command === "日记") return { intent: "journal", target: "journal", reason: "slash-journal" };
  if (command === "week" || command === "weekly" || command === "review" || command === "reviews" || command === "写周报") {
    return { intent: "review", reviewKind: reviewKindFromText(normalized), reason: "slash-review" };
  }
  if (command === "ask" || command === "query" || command === "问" || command === "查询") return { intent: "ask", reason: "slash-ask" };
  if (command === "reingest" || command === "redigest" || command === "重新提炼") return { intent: "reingest", reason: "slash-reingest" };
  return null;
}

function reviewKindFromText(normalized: string): KnowledgeBaseReviewCommandKind {
  if (/\bagent\b|\bchat\b|对话|普通|非知识库/.test(normalized)) return "agent-chat";
  return "knowledge-base";
}

function isInitConfirmCommand(normalized: string): boolean {
  const tail = normalized.replace(/^\/(?:init|初始化)(?:[\s:：?？]+)?/u, "").trim();
  return tail === "confirm" || tail === "确认" || tail === "执行" || tail === "开始" || tail === "apply";
}

function looksLikeKnowledgeQuestion(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return false;
  if (/[?？]$/.test(normalized)) return true;
  return /(什么|为何|为什么|怎么|怎样|如何|是否|是不是|能不能|有没有|关系|区别|怎么看|是谁|哪一个|哪些|多少|where|what|why|how|should|could|can)/i.test(normalized);
}
