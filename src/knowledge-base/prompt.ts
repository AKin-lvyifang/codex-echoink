import type { KnowledgeBaseRunMode, KnowledgeBaseSource } from "./types";

export interface KnowledgeBasePromptInput {
  vaultPath: string;
  mode: KnowledgeBaseRunMode;
  userRequest?: string;
  reportPath: string;
  sources: KnowledgeBaseSource[];
  rulesFilePath: string;
  rulesFileExists: boolean;
  useCustomRulesFile: boolean;
  hasRawIndex: boolean;
  hasWikiIndex: boolean;
  hasTracker: boolean;
}

export function buildKnowledgeBasePrompt(input: KnowledgeBasePromptInput): string {
  const sourceLines = input.sources.length
    ? input.sources.map((source) => `- ${source.relativePath} | ${source.mime} | ${Math.round(source.size / 1024)} KB | ${source.changed ? "新增/变更" : "已处理"}`).join("\n")
    : "- 本轮没有检测到新增或变更 raw 文件；请执行体检并生成 no-op 维护报告。";
  const task = taskForMode(input.mode);
  const rulesMode = input.useCustomRulesFile
    ? `自定义规则文件：${input.rulesFilePath}。只读取这个文件，不读取、不合并 AGENTS.md。`
    : `默认规则文件：${input.rulesFilePath}。如果存在，必须读取；如果不存在，按本提示的安全边界执行。`;
  return [
    "你正在 Obsidian Vault 内执行知识库维护任务。",
    "",
    "必须使用中文，先给结论，再给依据。",
    "请遵守下面指定的知识库操作指南文件。",
    "",
    "## 任务",
    task,
    input.userRequest?.trim() ? `用户原始指令：${input.userRequest.trim()}` : "",
    "",
    "## Vault",
    input.vaultPath,
    "",
    "## 必读文件状态",
    `- 知识库操作指南：${rulesMode}`,
    `- ${input.rulesFilePath}: ${input.rulesFileExists ? "存在，必须读取" : "不存在"}`,
    `- raw/index.md: ${input.hasRawIndex ? "存在，必须读取" : "不存在"}`,
    `- wiki/index.md: ${input.hasWikiIndex ? "存在，必须读取" : "不存在"}`,
    `- outputs/.ingest-tracker.md: ${input.hasTracker ? "存在，必须读取" : "不存在，可创建或补齐"}`,
    "",
    "## 本轮 raw 来源",
    sourceLines,
    "",
    "## 写入边界",
    "- 可以写入：wiki/、outputs/、outputs/.ingest-tracker.md、journal/、inbox/。",
    "- 可以更新：wiki/index.md、各领域 00-索引.md、raw/index.md。",
    "- 禁止修改 raw/ 中的原始资料正文。",
    "- 禁止删除任何文件。",
    "- 禁止自动归档；如果发现应归档内容，只写进报告等待用户确认。",
    "- raw/index.md 只允许做索引更新，不允许改写任何 raw 原文。",
    "",
    "## 输出要求",
    `- 维护报告必须写入：${input.reportPath}`,
    "- 报告包含：一眼结论、新增/变更文件、已消化、体检发现、索引更新、风险/需确认。",
    "- 如果本轮消化了 raw 文件，必须更新 outputs/.ingest-tracker.md。",
    "- 消化后的 wiki 页面必须包含 raw 来源回链。",
    "- 对图片/PDF 的理解必须基于模型实际读取到的内容；如果不能读取，写明失败原因，不要编造。",
    "",
    "开始执行。"
  ].join("\n");
}

function taskForMode(mode: KnowledgeBaseRunMode): string {
  if (mode === "lint") return "只执行 Lint 体检，不做新增消化。";
  if (mode === "reingest") return "执行重新提炼：按用户指定资料重新生成或更新 wiki；如果未指定具体资料，只处理最近 raw，不全库重写。";
  if (mode === "inbox") return "处理 inbox：按知识库规则归类 inbox 内容，必要时沉淀到 wiki/journal/outputs；不要删除原文件，处理结果写报告。";
  return "执行 Ingest + Lint：消化新增/变更 raw 资料，更新 wiki 与维护报告。";
}
