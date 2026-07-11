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
  general: "通用增强，适合大多数场景。保持平衡的结构。",
  writing: "针对文档撰写优化。强调文档结构、字数、语气和受众。",
  analysis: "针对数据分析优化。强调分析维度、输出格式（表格/图表）和关键指标。",
  code: "针对代码生成优化。强调技术栈、组件结构、错误处理和代码风格。"
};

/**
 * 默认 Meta-Prompt 基础指令
 *
 * 这段指令会被拼接到 EditorActionController 已有的 prompt 构建流程中。
 * 它定义了"如何将模糊输入扩写为结构化提示词"的规则。
 */
export const ENHANCE_META_PROMPT = `你是一位提示词工程专家。你的任务是将用户输入的简短、模糊的需求，扩写为一段结构完整、语义精确的提示词，让 AI 助手能够准确执行。

## 扩写规则

1. 保留用户的原始意图，不要编造新的需求。
2. 扩写后的提示词应包含以下部分（不适用的可省略）：
   - **角色**：AI 应扮演什么角色？
   - **背景**：相关上下文和数据来源。
   - **任务**：具体步骤，用编号列出。
   - **输出格式**：期望的结构（表格/列表/分段/代码等）。
   - **约束**：字数、语气、范围、语言。
3. 保持简洁，不要过度扩写简单的请求。
4. 使用与用户输入相同的语言（中文输入 → 中文输出）。
5. 只输出扩写后的提示词本身，不要输出解释或元评论。`;

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
    "请将以下「选中文字」视为用户的原始需求，按照扩写规则将其扩写为一段结构化的提示词。",
    "",
    `风格提示：${styleHint}`,
    "",
    "用户原始需求：{{selected_text}}",
    "",
    "当前文件上下文（仅供参考，不要在扩写结果中引用文件路径）：",
    "{{before_context}}",
    "{{after_context}}",
    "",
    "请按照扩写规则输出结构化提示词。"
  ].join("\n");
}

/**
 * 判断输入是否已经足够详细，不需要增强
 *
 * @param input - 用户输入文本
 * @returns true 表示已经足够详细
 */
export function isAlreadyDetailed(input: string): boolean {
  const wordCount = input.split(/\s+/).filter(Boolean).length;
  const hasStructure = /^#{1,3}\s|^\d+\.\s|^-\s|^\*\*/m.test(input);
  return wordCount > 80 && hasStructure;
}
