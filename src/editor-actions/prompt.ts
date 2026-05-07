import type { UserInput } from "../types/app-server";
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
  return [
    `你正在 Obsidian 笔记中执行「${input.action.label}」。`,
    `当前文件：${input.snapshot.fileName} (${input.snapshot.filePath})`,
    `写作风格：${variables.style}`,
    input.snapshot.noteSummary ? "当前笔记摘要：" : "",
    input.snapshot.noteSummary ? fenceContext(input.snapshot.noteSummary) : "",
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
    input.action.id === "continue" ? "续写时不要重复原文，只返回应该追加或替换为候选的正文。" : "",
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
