import assert from "node:assert/strict";
import { defaultGenerationTemplates, generationTemplateIsEdited, normalizeGenerationTemplates, uniqueGenerationTemplateName, validateGenerationTemplate } from "../settings/generation-templates";

export function runGenerationTemplateTests(): void {
  const defaults = defaultGenerationTemplates();
  assert.deepEqual(defaults.map(item => item.id), ["brief", "guide", "blog", "mind"]);
  defaults[0].instructions = "edited";
  assert.notEqual(defaultGenerationTemplates()[0].instructions, "edited", "defaults are independent objects");
  const custom = { id: "user-1", name: "我的格式", description: "", instructions: "按时间线写作", outputKind: "markdown" as const };
  const normalized = normalizeGenerationTemplates([
    { ...defaults[0], name: "我的简报", outputKind: "canvas" }, custom,
    { ...custom, name: "另一个名字" }, { ...custom, id: "user-2", name: " 我的格式 " },
    { ...custom, id: "user-3", outputKind: "invalid" }, { ...custom, id: "user-4", instructions: " " },
    { ...custom, id: "user-5", name: "学习指南", builtin: true }, null
  ]);
  assert.equal(normalized.length, 5);
  assert.equal(normalized[0].instructions, "edited");
  assert.equal(normalized[0].name, "我的简报");
  assert.equal(normalized[0].builtin, true);
  assert.equal(normalized[0].outputKind, "canvas");
  assert.equal(normalized[4].builtin, false, "custom input cannot claim built-in privileges");
  assert.equal(normalizeGenerationTemplates(null).length, 4);
  assert.equal(generationTemplateIsEdited(normalized[0]), true);
  assert.equal(generationTemplateIsEdited(defaultGenerationTemplates()[0]), false);
  assert.deepEqual(validateGenerationTemplate({ ...custom, name: " ", instructions: " " }, normalized), { name: "名称不能为空", instructions: "写作要求不能为空" });
  assert.equal(validateGenerationTemplate({ ...custom, id: "another", name: "学习指南" }, normalized).name, "已有同名模板");
  assert.equal(validateGenerationTemplate(custom, normalized).name, undefined, "editing the same record is allowed");
  assert.equal(uniqueGenerationTemplateName([...normalized, { ...custom, id: "more", name: "我的格式 2" }]), "我的格式 3");
  assert.equal(normalizeGenerationTemplates([{ ...custom, name: "BLOG" }, { ...custom, id: "other", name: "blog" }]).length, 5);
}
