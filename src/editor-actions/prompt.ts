import type { UserInput } from "../types/app-server";
import { ENHANCE_META_PROMPT } from "../prompt-enhancer/meta-prompt";
import type { EditorActionPromptInput, EditorAiActionSettings, EditorAiStyleConfig } from "./types";

export const EDITOR_ACTION_OUTPUT_RULES = [
  "只返回最终候选文本。",
  "把候选正文放在 <codex-candidate> 和 </codex-candidate> 之间。",
  "标签外不要输出任何内容；如果误输出，插件会丢弃。",
  "不要解释。",
  "不要使用代码块包裹。",
  "不要擅自修改未选中的内容。",
  "保留 Markdown 格式。"
].join("\n");

export function resolveEditorActionStyle(settings: EditorAiActionSettings, styleId = settings.defaultStyleId): EditorAiStyleConfig {
  return settings.styles.find((style) => style.id === styleId) ?? settings.styles.find((style) => style.id === "clear") ?? settings.styles[0] ?? {
    id: "clear",
    label: "清楚",
    instruction: "表达清楚、准确、自然。"
  };
}

export function buildEditorActionPrompt(input: EditorActionPromptInput): string {
  const modeLabel = input.modeLabel ?? "";
  const translateAction = isTranslateAction(input.action.id);
  const enhanceAction = isEnhanceAction(input.action.id);
  const articleUnderstanding = input.snapshot.articleUnderstanding ?? input.snapshot.noteSummary ?? "";
  const variables: Record<string, string> = {
    action: input.action.label,
    style: `${input.style.label}：${input.style.instruction}`,
    selected_text: input.snapshot.selectedText,
    before_context: input.snapshot.beforeContext,
    after_context: input.snapshot.afterContext,
    file_path: input.snapshot.filePath,
    file_name: input.snapshot.fileName
  };
  const renderedTemplate = renderTemplate(input.action.promptTemplate, variables).trim();
  const articleUnderstandingNotice = articleUnderstanding && input.snapshot.articleUnderstandingState === "reusable"
    ? "注意：这份文章理解来自稍早版本。当前选区和前后文优先，文章理解只用于主题、风格、事实边界。"
    : "";
  if (enhanceAction) {
    return [
      ENHANCE_META_PROMPT,
      "",
      "当前文件：",
      fenceContext(input.snapshot.fileName),
      "",
      "用户原始需求（选中文字）：",
      fenceContext(input.snapshot.selectedText),
      "",
      "文件上下文（选区前文）：",
      fenceContext(input.snapshot.beforeContext),
      "",
      "文件上下文（选区后文）：",
      fenceContext(input.snapshot.afterContext),
      "",
      "任务要求：",
      renderedTemplate,
      "",
      "输出规则：",
      EDITOR_ACTION_OUTPUT_RULES
    ].join("\n");
  }
  return [
    `你正在 Obsidian 笔记中执行「${input.action.label}」。`,
    `当前文件：${input.snapshot.fileName} (${input.snapshot.filePath})`,
    modeLabel ? `写作质量：${modeLabel}` : "",
    translateAction ? "" : `写作风格：${variables.style}`,
    articleUnderstanding ? "当前文章理解：" : "",
    articleUnderstandingNotice,
    articleUnderstanding ? fenceContext(articleUnderstanding) : "",
    "",
    "选区前文：",
    fenceContext(input.snapshot.beforeContext),
    "",
    "选中文字：",
    fenceContext(input.snapshot.selectedText),
    "",
    "选区后文：",
    fenceContext(input.snapshot.afterContext),
    "",
    "任务要求：",
    renderedTemplate,
    input.action.id === "continue" ? "续写时不要重复原文，只返回应该追加在选中文字后面的正文。" : "",
    translateAction ? "翻译时只返回英文译文，不要附带中文原文、解释、注释或多个版本。" : "",
    "",
    "输出规则：",
    EDITOR_ACTION_OUTPUT_RULES
  ].filter((line) => line !== "").join("\n");
}

export function buildEditorActionReviewPrompt(input: EditorActionPromptInput & { candidateText: string }): string {
  const modeLabel = input.modeLabel ?? "严格";
  const translateAction = isTranslateAction(input.action.id);
  const articleUnderstanding = input.snapshot.articleUnderstanding ?? input.snapshot.noteSummary ?? "";
  const articleUnderstandingNotice = articleUnderstanding && input.snapshot.articleUnderstandingState === "reusable"
    ? "注意：这份文章理解来自稍早版本。当前选区和前后文优先，文章理解只用于主题、风格、事实边界。"
    : "";
  return [
    `你正在审校 Obsidian 笔记中的「${input.action.label}」候选。`,
    `当前文件：${input.snapshot.fileName} (${input.snapshot.filePath})`,
    `写作质量：${modeLabel}`,
    translateAction ? "" : `写作风格：${input.style.label}：${input.style.instruction}`,
    articleUnderstanding ? "当前文章理解：" : "",
    articleUnderstandingNotice,
    articleUnderstanding ? fenceContext(articleUnderstanding) : "",
    "",
    "选区前文：",
    fenceContext(input.snapshot.beforeContext),
    "",
    "原选中文字：",
    fenceContext(input.snapshot.selectedText),
    "",
    "选区后文：",
    fenceContext(input.snapshot.afterContext),
    "",
    "待审校候选：",
    fenceContext(input.candidateText),
    "",
    "审校要求：",
    ...(translateAction ? [
      "1. 检查候选是否准确翻译为自然英文。",
      "2. 检查是否保留原文事实、数字、专有名词、Markdown 和语气。",
      "3. 不要恢复中文原文，不要新增解释，不要输出多个版本。",
      "4. 如果候选没有问题，原样返回。",
      "5. 如果有问题，只返回修正后的最终英文译文。"
    ] : [
      "1. 检查候选是否保留事实、贴合文章风格、和前后文自然衔接。",
      "2. 检查是否重复原文、编造硬事实、破坏 Markdown 或输出多个版本。",
      "3. 如果候选没有问题，原样返回。",
      "4. 如果有问题，只返回修正后的最终候选正文。",
      input.action.id === "continue" ? "5. 续写只能返回追加在选中文字后面的正文，不要重复原文，也不要改写后文。" : ""
    ]),
    "",
    "输出规则：",
    EDITOR_ACTION_OUTPUT_RULES
  ].filter((line) => line !== "").join("\n");
}

export function buildEditorActionUserInput(prompt: string): UserInput[] {
  return [{ type: "text", text: prompt.trim(), text_elements: [] }];
}

function renderTemplate(template: string, variables: Record<string, string>): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, key: string) => variables[key] ?? "");
}

function fenceContext(value: string): string {
  return value ? `<<<\n${value}\n>>>` : "<<<\n\n>>>";
}

function isTranslateAction(actionId: string): boolean {
  return actionId === "translate";
}

function isEnhanceAction(actionId: string): boolean {
  return actionId === "enhance";
}
