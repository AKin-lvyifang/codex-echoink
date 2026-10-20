import type { GenerationTemplate } from "../generation/types";

const LEGACY_MIND_TEMPLATES = [
  { id: "mind", name: "思维导图", description: "在 Canvas 里展开概念和层级", outputKind: "canvas",
    instructions: "中心节点：资料的主题\n一级分支 3–5 个，每个不超过 12 个字\n每个分支下 2–4 个要点，每个不超过 20 个字\n要点出自某篇笔记时，标出来源\n\n只用所选资料；资料里没有的，写“资料未提及”。" },
  { id: "mind", name: "思维导图", description: "按资料内容组织导图、流程、时间线或对比", outputKind: "canvas",
    instructions: "根据资料内容选择最清楚的呈现方式：概念关系用导图，步骤用流程，事件用时间线，差异用对比，相关内容可分组。\n自行安排 Canvas 节点、坐标、尺寸和连线，让阅读顺序清楚，节点不重叠，文字留足空间。不要硬凑固定分支或要点数。\n来源使用本轮成功读取笔记的精确路径；网址只能来自资料正文。\n\n只用所选资料；资料里没有的，写“资料未提及”。" }
] as const;

/** Fresh objects: editing a saved template must never mutate the built-in defaults. */
export function defaultGenerationTemplates(): GenerationTemplate[] {
  return [
    { id: "brief", name: "简报", description: "核心观点、关键概念和分歧，每条带来源", outputKind: "markdown", builtin: true,
      instructions: "1. 一句话结论（引用块）\n2. 核心观点：3–6 条，每条末尾标出来源笔记\n3. 关键概念：表格，两列「概念｜一句话解释」\n4. 分歧：资料之间、或资料与评论之间不一致的地方\n5. 值得追问：2–3 个问题\n\n只用所选资料；资料里没有的，写“资料未提及”。" },
    { id: "guide", name: "学习指南", description: "自测问题、思考题和术语表", outputKind: "markdown", builtin: true,
      instructions: "1. 自测问题 5 道，附答案出处\n2. 思考题 2 道\n3. 术语表：两列「术语｜解释」\n\n只用所选资料；资料里没有的，写“资料未提及”。" },
    { id: "blog", name: "博文", description: "把观点串成一篇好读的文章", outputKind: "markdown", builtin: true,
      instructions: "写成一篇 1200 字左右的文章：开头一个问题，中间按观点展开，结尾回到问题。每段引用一处原文，并标出来源笔记。\n\n只用所选资料；资料里没有的，写“资料未提及”。" },
    { id: "mind", name: "思维导图", description: "按资料内容组织导图、流程、时间线或对比", outputKind: "canvas", builtin: true,
      instructions: "根据资料的实际关系选择结构：概念层级用导图，步骤用流程，历史事件用时间线，差异用对比，相关内容可分组。\n流程中的步骤节点按先后串联，判断或实际分支才分叉；历史事件按时间连接主干和事件点；对比对象并排、对应维度对齐，连线表达真实关系。不要把各类资料统一排成“中心→分支→详情”的三列树，也不要硬凑固定分支或要点数。\n自行安排 Canvas 节点、坐标、尺寸、颜色和连线，让阅读顺序清楚，节点不重叠，文字留足空间。\n来源使用本轮成功读取笔记的精确路径；网址只能来自资料正文。\n\n只用所选资料；资料里没有的，写“资料未提及”。" }
  ];
}

function readTemplate(value: unknown): GenerationTemplate | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (typeof item.id !== "string" || !item.id.trim() || item.id !== item.id.trim() || typeof item.name !== "string" || !item.name.trim()
    || typeof item.description !== "string" || typeof item.instructions !== "string" || !item.instructions.trim()
    || (item.outputKind !== "markdown" && item.outputKind !== "canvas")) return null;
  // Preserve editable text so a later load cannot erase evidence of a user edit.
  // IDs are immutable identifiers; reject malformed whitespace rather than aliasing a built-in ID.
  return { id: item.id, name: item.name, description: item.description, instructions: item.instructions, outputKind: item.outputKind };
}

export function generationTemplateNameKey(name: string): string { return name.trim().toLocaleLowerCase(); }

/** Repair missing built-ins, retain valid edits, and reject malformed/duplicate custom records. */
export function normalizeGenerationTemplates(value: unknown): GenerationTemplate[] {
  const defaults = defaultGenerationTemplates();
  const saved = Array.isArray(value) ? value.map(value => {
    const item = readTemplate(value);
    // Even whitespace edits belong to the user and must survive subsequent loads.
    const legacy = value && typeof value === "object" && !Array.isArray(value)
      && LEGACY_MIND_TEMPLATES.some(template => Object.entries(template).every(([key, expected]) => (value as Record<string, unknown>)[key] === expected));
    return legacy ? defaults.find(template => template.id === "mind")! : item;
  }).filter((item): item is GenerationTemplate => Boolean(item)) : [];
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
