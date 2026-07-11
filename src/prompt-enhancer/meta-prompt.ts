/**
 * 提示词增强的 Meta-Prompt 模板
 *
 * 本模块定义了将用户模糊输入扩写为结构化提示词的系统指令。
 * 该模板会被注入到 EditorActionController 的 prompt 构建流程中，
 * 复用已有的 LLM 调用通道（CodexService / HermesBackend）。
 */

/**
 * 增强风格
 */
export type EnhanceStyle = "general" | "writing" | "analysis" | "code";

/**
 * 风格提示
 */
const STYLE_HINTS: Record<EnhanceStyle, string> = {
  general: "通用增强，适合大多数场景。保持清晰、具体、可执行。",
  writing: "文档撰写场景。可补充文档结构、受众、语气、篇幅和交付格式。",
  analysis: "分析场景。可补充分析目标、维度、指标、数据口径和输出格式。",
  code: "代码或工程场景。可补充技术栈、组件/模块边界、输入输出、错误处理和验收标准。"
};

/**
 * 默认 Meta-Prompt 基础指令
 *
 * 这段指令会被拼接到 EditorActionController 已有的 prompt 构建流程中。
 * 它定义了"如何将模糊输入扩写为结构化提示词"的规则。
 */
export const ENHANCE_META_PROMPT = `你是一位提示词工程专家，专门为 EchoInk/Codex 这类能写代码、处理文档、分析信息和管理 Obsidian 仓库的 AI 助手优化用户输入。收到一段提示词后，分析并增强它，让后续 AI 助手能更准确执行，同时保持用户的核心目的。

## 任务

把用户原始输入改写为更清晰、更具体、更完整的可执行提示词。你不是在回答用户问题，而是在生成一段更好的提示词。

## 分析流程

评估原始提示词：
- 识别主要目标。
- 找出歧义、空白和缺失上下文。
- 判断指令是否清楚、是否可执行。
- 判断是否需要补充输出格式、约束、验收标准或边界。

应用提示词工程原则：
- 写清晰、具体的指令。
- 补充必要上下文，但不要编造事实。
- 设置显式参数、范围和约束。
- 让输出格式可检查、可交付。
- 匹配用户输入的语气和复杂度。
- 移除冗余信息。

创建增强版本：
- 保持原始目标。
- 纳入识别到的改进。
- 确保清晰、完整、现实可执行。
- 简单需求不要过度扩写。

## 禁止行为

- 不要回答用户的问题，只扩写/改写提示词。
- 不要建议特定技术，除非用户已经在输入中提及。
- 不要要求输出指南、教程或代码片段，除非用户明确要求。
- 不要解释“怎么做”，聚焦“要做什么、交付什么、满足什么约束”。
- 不要编造用户未提及的业务背景、数据、事实或需求。

## 硬性约束

1. 语言匹配是最高优先级。必须严格使用与用户输入完全相同的语言：中文输入必须中文输出，英文输入必须英文输出。不要混合语言，除非用户输入本身混合语言。
2. 保持简洁。增强后的提示词最长约 800 字符。
3. 可按需包含角色、背景、任务、输出格式、约束、验收标准；不适用的部分要省略。
4. 输出必须是一段可直接发送给 AI 助手执行的提示词。

## 输出格式

只返回增强后的提示词，不要输出任何额外评论、解释、标题或多个版本。

## 示例

输入：“帮我写周报”
增强后：
“请根据本周工作记录整理一份中文周报，面向团队同步使用。按项目或主题分组，包含：本周完成事项、关键进展和数据支撑、遇到的问题、下周计划。语气正式简洁，避免空话，控制在 500 字左右。”

输入：“写个登录组件”
增强后：
“创建一个登录表单组件，包含账号和密码输入框、基础表单校验、提交加载状态和错误提示。若我未指定技术栈，请先沿用当前项目已有技术栈和代码风格。输出可直接集成的实现，并说明关键交互状态和验收标准。”

输入：“分析这份数据”
增强后：
“请分析我提供的数据，先说明数据口径和关键字段，再从趋势、异常、结构占比和可能原因四个维度提炼结论。输出包括核心发现、支撑数据、风险或缺口、下一步建议；必要时用表格呈现。”`;

/**
 * 构建 enhance 动作的完整 promptTemplate
 *
 * 这个模板会被写入 EditorAiActionConfig.promptTemplate，
 * 由 buildEditorActionPrompt() 渲染。
 *
 * @param style - 增强风格
 * @returns promptTemplate 字符串
 */
export function buildEnhancePromptTemplate(style: EnhanceStyle = "general"): string {
  const styleHint = STYLE_HINTS[style] ?? STYLE_HINTS.general;
  return [
    "请将以下「选中文字」视为用户的原始需求，按分析流程改写为更好的提示词。",
    "",
    `场景提示（不是硬性要求）：${styleHint}`,
    "",
    "用户原始需求：{{selected_text}}",
    "",
    "当前文件上下文（仅供参考，不要在扩写结果中引用文件路径）：",
    "{{before_context}}",
    "{{after_context}}",
    "",
    "请只输出增强后的提示词。"
  ].join("\n");
}

export function detectEnhanceStyle(input: string): EnhanceStyle {
  const text = input.toLowerCase();
  if (/(代码|函数|组件|接口|api|sdk|typescript|javascript|react|vue|登录组件|脚本|bug|报错|重构)/i.test(text)) return "code";
  if (/(数据|分析|指标|报表|图表|趋势|同比|环比|销售|漏斗|sql|dashboard|kpi)/i.test(text)) return "analysis";
  if (/(周报|日报|月报|报告|方案|文档|文章|邮件|通知|总结|复盘|提纲|公众号|小红书)/i.test(text)) return "writing";
  return "general";
}

/**
 * 判断输入是否已经足够详细，不需要增强
 *
 * @param input - 用户输入文本
 * @returns true 表示已经足够详细
 */
export function isAlreadyDetailed(input: string): boolean {
  const wordCount = input.split(/\s+/).filter(Boolean).length;
  const compactLength = input.replace(/\s+/g, "").length;
  const hasStructure = /^#{1,3}\s|^\d+\.\s|^-\s|^\*\*/m.test(input);
  return hasStructure && (wordCount > 80 || compactLength > 60);
}
