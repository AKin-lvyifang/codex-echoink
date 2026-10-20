import type { GenerationTemplate } from "../generation/types";

/** Fresh objects: editing a saved template must never mutate the built-in defaults. */
export function defaultGenerationTemplates(): GenerationTemplate[] {
  return [
    { id: "brief", name: "简报", description: "核心观点、关键概念和分歧，每条带来源", outputKind: "markdown", builtin: true,
      instructions: "1. 一句话结论（引用块）\n2. 核心观点：3–6 条，每条末尾标出来源笔记\n3. 关键概念：表格，两列「概念｜一句话解释」\n4. 分歧：资料之间、或资料与评论之间不一致的地方\n5. 值得追问：2–3 个问题\n\n只用所选资料；资料里没有的，写“资料未提及”。" },
    { id: "guide", name: "学习指南", description: "自测问题、思考题和术语表", outputKind: "markdown", builtin: true,
      instructions: "1. 自测问题 5 道，附答案出处\n2. 思考题 2 道\n3. 术语表：两列「术语｜解释」\n\n只用所选资料；资料里没有的，写“资料未提及”。" },
    { id: "blog", name: "博文", description: "把观点串成一篇好读的文章", outputKind: "markdown", builtin: true,
      instructions: "写成一篇 1200 字左右的文章：开头一个问题，中间按观点展开，结尾回到问题。每段引用一处原文，并标出来源笔记。\n\n只用所选资料；资料里没有的，写“资料未提及”。" },
    { id: "mind", name: "思维导图", description: "在 Canvas 里展开概念和层级", outputKind: "canvas", builtin: true,
      instructions: "中心节点：资料的主题\n一级分支 3–5 个，每个不超过 12 个字\n每个分支下 2–4 个要点，每个不超过 20 个字\n要点出自某篇笔记时，标出来源\n\n只用所选资料；资料里没有的，写“资料未提及”。" }
  ];
}

function readTemplate(value: unknown): GenerationTemplate | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (typeof item.id !== "string" || !item.id.trim() || typeof item.name !== "string" || !item.name.trim()
    || typeof item.description !== "string" || typeof item.instructions !== "string" || !item.instructions.trim()
    || (item.outputKind !== "markdown" && item.outputKind !== "canvas")) return null;
  return { id: item.id.trim(), name: item.name.trim(), description: item.description.trim(), instructions: item.instructions.trim(), outputKind: item.outputKind };
}

export function generationTemplateNameKey(name: string): string { return name.trim().toLocaleLowerCase(); }

/** Repair missing built-ins, retain valid edits, and reject malformed/duplicate custom records. */
export function normalizeGenerationTemplates(value: unknown): GenerationTemplate[] {
  const saved = Array.isArray(value) ? value.map(readTemplate).filter((item): item is GenerationTemplate => Boolean(item)) : [];
  const defaults = defaultGenerationTemplates();
  const templates = defaults.map(item => ({ ...(saved.find(candidate => candidate.id === item.id) ?? item), builtin: true }));
  const ids = new Set(templates.map(item => item.id));
  const names = new Set(templates.map(item => generationTemplateNameKey(item.name)));
  for (const item of saved) {
    const name = generationTemplateNameKey(item.name);
    if (ids.has(item.id) || names.has(name)) continue;
    templates.push({ ...item, builtin: false }); ids.add(item.id); names.add(name);
  }
  return templates;
}

export function uniqueGenerationTemplateName(templates: readonly GenerationTemplate[], preferred = "我的格式"): string {
  const base = preferred.trim() || "我的格式";
  const names = new Set(templates.map(item => generationTemplateNameKey(item.name)));
  let name = base;
  for (let suffix = 2; names.has(generationTemplateNameKey(name)); suffix++) name = `${base} ${suffix}`;
  return name;
}

export function generationTemplateIsEdited(template: GenerationTemplate): boolean {
  const original = defaultGenerationTemplates().find(item => item.id === template.id);
  return Boolean(original && (original.name !== template.name || original.description !== template.description
    || original.instructions !== template.instructions || original.outputKind !== template.outputKind));
}

export function validateGenerationTemplate(template: GenerationTemplate, templates: readonly GenerationTemplate[]): { name?: string; instructions?: string } {
  const errors: { name?: string; instructions?: string } = {};
  if (!template.name.trim()) errors.name = "名称不能为空";
  else if (templates.some(item => item.id !== template.id && generationTemplateNameKey(item.name) === generationTemplateNameKey(template.name))) errors.name = "已有同名模板";
  if (!template.instructions.trim()) errors.instructions = "写作要求不能为空";
  return errors;
}
