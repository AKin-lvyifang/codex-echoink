import type { KnowledgeBaseRunMode, KnowledgeBaseSource } from "./types";
import { AGENTS_RULES_FILE } from "./constants";
import { formatAskMatchesForPrompt, type KnowledgeBaseAskMatch } from "./query";

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
  remainingSourceCount?: number;
}

export function buildKnowledgeBasePrompt(input: KnowledgeBasePromptInput): string {
  const sourceLines = input.sources.length
    ? input.sources.map((source) => `- ${source.relativePath} | ${source.mime} | ${Math.round(source.size / 1024)} KB | ${source.changed ? "新增/变更" : "已处理"}`).join("\n")
    : "- 本轮没有检测到新增或变更 raw 文件；请执行体检并生成 no-op 体检报告。";
  const task = taskForMode(input.mode);
  const rulesMode = input.useCustomRulesFile
    ? `自定义规则文件：${input.rulesFilePath}。知识库结构以这个文件为准；不要把 ${AGENTS_RULES_FILE} 当作知识库规则合并。`
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
    "## 标准执行步骤",
    "1. Discover 增量检测：读取 raw/index.md；用 find 列出 raw/、inbox/、outputs/、projects/ 下知识区文件及修改时间，重点对比 raw/ 与 outputs/.ingest-tracker.md。跳过 raw/ 中以 .base 结尾的辅助文件。",
    "2. Ingest 消化：只处理新增/变更资料；从 wiki/index.md 中选择最匹配领域；写入 wiki/<领域>/ 的 concepts/、guides/、references/ 等合适子文件夹。",
    "3. Structure Normalize：你可以整理 wiki/、outputs/、inbox/、projects/ 的文件夹结构；raw 路径只记录建议或风险，不要移动、重命名或改写 raw 源文件。",
    "4. Wiki 笔记格式：包含 frontmatter（created/updated/tags）、raw 原文回链、3-5 句核心要点、关键概念和术语、与既有 wiki 概念的双向链接。",
    "5. 索引更新：新增、移动或更新页面后，同步更新 wiki/index.md、对应领域 00-索引.md、raw/index.md、projects/00-索引.md 和 outputs/.ingest-tracker.md。",
    "6. Lint 体检：扫描 wiki/ 下 [[链接]]，检查断链、孤儿页面、过时或 draft 内容、根目录散落普通笔记、中文目录残留，以及 wiki/index.md 链接有效性。",
    "7. 报告输出：如果没有任何变化，报告写“无变化”；如果无法判断归属领域，跳过并在报告中说明。",
    "",
    "## 本轮 raw 来源",
    sourceLines,
    input.remainingSourceCount
      ? `- 批次限制：本轮只处理上面列出的 ${input.sources.length} 个 raw；其余 ${input.remainingSourceCount} 个保留到下次 /maintain，不要标记为已消化。`
      : "",
    "",
    "## 知识库管理写入边界",
    "- 以下边界只适用于本次知识库管理任务；不要把它扩展成普通 Agent 对话的全局限制。",
    "- 可以写入和整理：wiki/、outputs/、inbox/、projects/；raw/index.md 可更新索引。",
    "- 不纳入每日自动整理：journal/、work/、templates/、testing/、顶层 assets/。",
    "- raw/ 源文件内容边界：正文、标题、路径、来源内容和 .assets 附件目录都不可由 Agent 改写；Agent 不得写入、覆盖、格式化、补 frontmatter、改 updated 字段、移动或重命名 raw 源文件。",
    "- 只有 EchoInk 插件后处理阶段可以写入 raw Markdown 的托管元属性：已处理、提炼状态、提炼时间、提炼指纹、提炼报告、提炼证据；Agent 不要直接写这些属性。",
    "- raw 路径不在每日维护中自动整理；你只需要在报告中说明建议或风险。",
    "- 如果任务运行期间出现了本轮来源列表外的新 raw 文件，只在报告中记录风险；不要消化、移动、重命名或写入 tracker。",
    "- 禁止删除 raw/，禁止自动归档 raw/，禁止合并 raw/ 原文。",
    "- 低风险自动执行：只移动 wiki/outputs/inbox/projects 文件或目录；目标目录规则明确；无同名冲突；引用和 tracker 可自动同步。",
    "- 不确定或会断链的改动只写进报告：目标目录不确定、同名冲突、附件不匹配、跨出知识区、涉及删除/合并/归档、涉及 journal/work/templates/testing/assets。",
    "- wiki/、outputs/、inbox/、projects/ 文件移动后必须同步相关索引、引用和 tracker；raw 文件路径只记录风险，不自动移动。",
    "",
    "## 输出要求",
    `- ${input.mode === "lint" ? "体检报告" : "维护报告"}必须写入：${input.reportPath}`,
    "- 报告包含：一眼结论、新增/变更文件、已消化、结构整理、体检发现、索引更新、风险/需确认。",
    "- 如果本轮消化了 raw 文件，必须更新 outputs/.ingest-tracker.md。",
    "- 消化后的 wiki 页面必须包含 raw 来源回链。",
    "- 每个本轮 raw 都要在非索引正文页留下结构层证据：新建页可用顶部 `> 来源：[[raw/...]]` + 后续正文；聚合页要按日期或来源独立写小节。只写报告、tracker、索引或来源清单不算消化。",
    "- 对图片/PDF 的理解必须基于模型实际读取到的内容；如果不能读取，写明失败原因，不要编造。",
    "",
    "开始执行。"
  ].join("\n");
}

export interface KnowledgeBaseAskPromptInput {
  vaultPath: string;
  userRequest: string;
  rulesFilePath: string;
  rulesFileExists: boolean;
  useCustomRulesFile: boolean;
  matches: KnowledgeBaseAskMatch[];
}

export function buildKnowledgeBaseAskPrompt(input: KnowledgeBaseAskPromptInput): string {
  const rulesMode = input.useCustomRulesFile
    ? `自定义规则文件：${input.rulesFilePath}。知识库结构以这个文件为准；不要把 ${AGENTS_RULES_FILE} 当作知识库规则合并。`
    : `默认规则文件：${input.rulesFilePath}。如果存在，必须读取；如果不存在，按本提示的安全边界执行。`;
  return [
    "你正在 Obsidian Vault 内回答知识库问题。",
    "",
    "必须使用中文，先给结论，再给依据。",
    "这是只读问答任务：不要创建、修改、删除或移动任何文件。",
    "",
    "## 用户问题",
    input.userRequest.trim(),
    "",
    "## Vault",
    input.vaultPath,
    "",
    "## 必读文件状态",
    `- 知识库操作指南：${rulesMode}`,
    `- ${input.rulesFilePath}: ${input.rulesFileExists ? "存在，必须读取" : "不存在"}`,
    "",
    "## 相关本地来源",
    formatAskMatchesForPrompt(input.matches),
    "",
    "## 回答规则",
    "- 先检查并优先引用上面的本地来源；如果已附带文件，请读取文件确认上下文，不要只看摘录。",
    "- Wiki 是优先依据；Journal / Outputs 只作为背景或过程依据，不能夸大成稳定结论。",
    "- 本地来源不是唯一依据；可以使用可用搜索工具、外部资料或模型已有知识补充。",
    "- 必须区分“来自 Vault 的依据”和“补充信息 / 推断”。",
    "- 如果没有命中相关本地来源，明确说明“未找到相关本地依据”，再基于可用搜索或通用知识回答。",
    "- 不确定的信息要明确标注，不要编造来源。",
    "- 引用 Vault 内容时写出相对路径；引用外部搜索时写出来源名称或链接。",
    "",
    "## 输出格式",
    "1. 一眼结论",
    "2. Vault 依据",
    "3. 补充信息",
    "4. 不确定 / 下一步",
    "",
    "开始回答。"
  ].join("\n");
}

function taskForMode(mode: KnowledgeBaseRunMode): string {
  if (mode === "lint") return "只执行 Lint 体检，不做新增消化。";
  if (mode === "reingest") return "执行重新提炼：按用户指定资料重新生成或更新 wiki；如果未指定具体资料，只处理最近 raw，不全库重写。";
  if (mode === "outputs") return "处理 outputs：扫描 outputs/ 中的协作产物，只把有长期复用价值的观点、方法、框架、决策提炼回 wiki；临时报告、发布草稿、一次性过程记录只在报告中说明，不要全量搬运。";
  if (mode === "inbox") return "处理 inbox：按知识库规则归类 inbox 内容，必要时沉淀到 wiki/journal/outputs；不要删除原文件，处理结果写报告。";
  return "执行 Ingest + Structure Normalize + Lint：消化新增/变更 raw 资料，整理知识区文件夹结构，更新 wiki、索引、tracker 与维护报告。";
}
