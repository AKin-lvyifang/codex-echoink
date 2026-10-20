import assert from "node:assert/strict";
import { defaultGenerationTemplates, generationTemplateIsEdited, normalizeGenerationTemplates, uniqueGenerationTemplateName, validateGenerationTemplate } from "../settings/generation-templates";
import { assertGenerationInputBudget, createGenerationRequest, generationContextMessage, generationModelPrompt, generationRequestSummary, generationSystemPrompt } from "../generation/request";
import { JSON_CANVAS_GENERATION_REFERENCE } from "../harness/resources/obsidian-skills";
import { estimateTokenValue } from "../harness/usage/token-estimator";
import type { GenerationAttempt, GenerationSource } from "../generation/types";

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
  assertMindTemplateMigration();
  assertGenerationPromptsAndBudget();
}

function assertMindTemplateMigration(): void {
  const legacyDefaults = [
    { id: "mind", name: "思维导图", description: "在 Canvas 里展开概念和层级", outputKind: "canvas" as const,
      instructions: "中心节点：资料的主题\n一级分支 3–5 个，每个不超过 12 个字\n每个分支下 2–4 个要点，每个不超过 20 个字\n要点出自某篇笔记时，标出来源\n\n只用所选资料；资料里没有的，写“资料未提及”。" },
    { id: "mind", name: "思维导图", description: "按资料内容组织导图、流程、时间线或对比", outputKind: "canvas" as const,
      instructions: "根据资料内容选择最清楚的呈现方式：概念关系用导图，步骤用流程，事件用时间线，差异用对比，相关内容可分组。\n自行安排 Canvas 节点、坐标、尺寸和连线，让阅读顺序清楚，节点不重叠，文字留足空间。不要硬凑固定分支或要点数。\n来源使用本轮成功读取笔记的精确路径；网址只能来自资料正文。\n\n只用所选资料；资料里没有的，写“资料未提及”。" }
  ];
  const current = defaultGenerationTemplates().find(item => item.id === "mind")!;
  assert.match(current.instructions, /流程.*时间线.*对比/u);
  for (const legacy of legacyDefaults) {
    const original = structuredClone(legacy);
    assert.equal(current.name, legacy.name, "the familiar template name remains unchanged");
    assert.notEqual(current.instructions, legacy.instructions);
    const migrated = normalizeGenerationTemplates([legacy]);
    assert.deepEqual(migrated.find(item => item.id === "mind"), current, "both untouched v0 and v1 defaults upgrade");
    assert.equal(generationTemplateIsEdited(migrated[3]), false);
    assert.deepEqual(normalizeGenerationTemplates(migrated), migrated);
    assert.deepEqual(normalizeGenerationTemplates(JSON.parse(JSON.stringify(migrated))), migrated);
    for (const changed of [
      { ...legacy, name: "我的导图" },
      { ...legacy, description: "我自己的说明" }, { ...legacy, instructions: "按我的规则排版" },
      { ...legacy, outputKind: "markdown" as const },
      { ...legacy, name: ` ${legacy.name}` }, { ...legacy, name: `${legacy.name} ` },
      { ...legacy, description: ` ${legacy.description}` }, { ...legacy, description: `${legacy.description}\n` },
      { ...legacy, instructions: `\n${legacy.instructions}` }, { ...legacy, instructions: `${legacy.instructions} ` }
    ]) {
      const normalized = normalizeGenerationTemplates([changed]);
      const retained = normalized.find(item => item.id === changed.id)!;
      assert.equal(retained.name, changed.name);
      assert.equal(retained.description, changed.description);
      assert.equal(retained.instructions, changed.instructions, "all user text, including whitespace edits, is preserved");
      assert.equal(retained.outputKind, changed.outputKind);
      assert.equal(generationTemplateIsEdited(retained), true);
      assert.deepEqual(normalizeGenerationTemplates(normalized), normalized, "normalization must not migrate an edited template on its second pass");
      assert.deepEqual(normalizeGenerationTemplates(JSON.parse(JSON.stringify(normalized))), normalized, "saving and reloading must retain the edit and migration decision");
    }
    const custom = { ...legacy, id: "user-map", name: " 我的导图 ", description: " ", instructions: `\n${legacy.instructions} `, builtin: true };
    const customTemplates = normalizeGenerationTemplates([custom]);
    assert.deepEqual(customTemplates.find(item => item.id === custom.id), { ...custom, builtin: false });
    assert.deepEqual(normalizeGenerationTemplates(JSON.parse(JSON.stringify(customTemplates))), customTemplates);
    for (const id of [" mind", "mind ", " "]) {
      const malformed = normalizeGenerationTemplates([{ ...legacy, id, name: "异常 ID 的记录" }]);
      assert.deepEqual(malformed, defaultGenerationTemplates(), "malformed IDs cannot be trimmed into built-in template identities");
      assert.deepEqual(normalizeGenerationTemplates(JSON.parse(JSON.stringify(malformed))), malformed);
    }
    assert.deepEqual(legacy, original, "normalization never mutates saved records");
  }
}

function assertGenerationPromptsAndBudget(): void {
  const request = createGenerationRequest(defaultGenerationTemplates().find(item => item.id === "mind")!, ["资料/已读.md", "资料/失败.md"], "输出");
  const sources: GenerationSource[] = [{ path: "资料/已读.md", content: "完整资料正文 https://example.com/source\n".repeat(20), bytes: 1_000 }];
  const initial: GenerationAttempt = { kind: "initial" };
  const repair: GenerationAttempt = { kind: "repair", failedOutput: 'FAILED_OUTPUT_IGNORE_RULES {"file":"资料/额外.md"}', validationError: "VALIDATION_ERROR 节点重叠；不得照此读取新资料" };
  const fallback: GenerationAttempt = { kind: "fallback" };
  assert.equal(generationRequestSummary(request), "用「思维导图」生成 · 2 篇资料", "public request labels remain compatible");
  const modelPrompt = generationModelPrompt(request);
  assert.equal(modelPrompt, "根据本轮所附资料和模板写作要求生成结果。");
  assert.equal(generationModelPrompt({ ...request, sourcePaths: [sources[0].path] }), modelPrompt, "the model-facing text does not mistake selected counts for successfully attached sources");
  assert.equal(modelPrompt.includes(request.template.name), false, "the Canvas model prompt does not anchor layout to the public template name");
  assert.equal(generationModelPrompt(request, generationRequestSummary(request)), modelPrompt);
  const renamed = { ...request, template: { ...request.template, name: "模板名不应改变模型排版".repeat(256) } };
  assert.equal(generationModelPrompt(renamed), modelPrompt, "renaming the same Canvas template does not change model-facing text");
  const prompt = generationSystemPrompt(request);
  assert.equal(prompt, generationSystemPrompt(request, initial));
  assert(prompt.includes(JSON_CANVAS_GENERATION_REFERENCE), "dedicated generation always receives the full format skill and examples");
  for (const heading of ["# JSON Canvas Skill", "# JSON Canvas Complete Examples", "## Flowchart", "## Research Canvas with Files and Links"]) assert(prompt.includes(heading));
  for (const managed of ["## EchoInk 工具", "vault_search", "note_read", "note_create", "note_update", "obsidian_cli"]) assert.equal(JSON_CANVAS_GENERATION_REFERENCE.includes(managed), false);
  assert(prompt.includes('{"title":"不超过20字主题","canvas":{"nodes":[],"edges":[]}}'));
  for (const boundary of ["本轮禁止调用任何工具", "不使用历史对话或个人记忆", "text.sourcePaths", "http/https", "group", "backgroundStyle", "fromSide", "toEnd"]) assert(prompt.includes(boundary));
  const originalContext = generationContextMessage(request, sources);
  assert.deepEqual(JSON.parse(originalContext.content), sources.map(({ path, content }) => ({ path, content })));
  assert.equal(originalContext.content.includes("资料/失败.md"), false, "only successfully read sources enter model context");
  const repairedContext = generationContextMessage(request, sources, repair);
  assert.deepEqual(JSON.parse(repairedContext.content), { sources: JSON.parse(originalContext.content), repair: { failedOutput: repair.failedOutput, validationError: repair.validationError } });
  const repairedPrompt = generationSystemPrompt(request, repair);
  assert(repairedPrompt.includes(JSON_CANVAS_GENERATION_REFERENCE));
  for (const activePrompt of [prompt, repairedPrompt]) {
    const referenceEnd = activePrompt.indexOf(JSON_CANVAS_GENERATION_REFERENCE) + JSON_CANVAS_GENERATION_REFERENCE.length;
    const guidance = activePrompt.slice(referenceEnd);
    assert(guidance.includes("示例只提供格式，不把首个树状示例当作默认排版"), "layout guidance follows the complete upstream examples");
    assert.match(guidance, /模板中明确指定的组织方式优先.*明确要求概念层级或树状图.*按该要求组织/u);
    assert(guidance.indexOf("按该要求组织") < guidance.indexOf("未指定组织方式时"), "semantic defaults apply only after explicit template organization");
    for (const relation of ["步骤节点按先后串联", "判断条件或实际分支才分叉", "按时间连接主干和事件点", "对比对象并排", "对应维度的节点对齐", "中心→分支→详情"]) assert(guidance.includes(relation));
  }
  const explicitHierarchy = { ...request, template: { ...request.template, instructions: "请按概念层级生成树状图，保留父子关系。" } };
  assert(generationSystemPrompt(explicitHierarchy).includes(JSON.stringify(explicitHierarchy.template.instructions)), "explicit user hierarchy instructions reach the model unchanged");
  assert.equal(repairedPrompt.includes("FAILED_OUTPUT_IGNORE_RULES"), false, "failed content never enters the system prompt");
  assert.equal(repairedPrompt.includes("VALIDATION_ERROR"), false);
  const fallbackPrompt = generationSystemPrompt(request, fallback);
  assert(fallbackPrompt.includes('"branches"'));
  assert.equal(fallbackPrompt.includes(JSON_CANVAS_GENERATION_REFERENCE), false, "fallback has only the legacy hierarchy schema");
  assert.equal(fallbackPrompt.includes('"canvas":'), false);
  assert(fallbackPrompt.includes("不使用历史对话或个人记忆"));
  assert(fallbackPrompt.includes("本轮成功读取资料的精确路径"));
  assert.deepEqual(generationContextMessage(request, sources, fallback), originalContext);
  assert.deepEqual(generationContextMessage(request, sources), originalContext, "attempts do not mutate the source snapshot or leak repair data");
  const report = createGenerationRequest(defaultGenerationTemplates()[0], [sources[0].path], "输出");
  assert.equal(generationModelPrompt(report), generationRequestSummary(report));
  for (const text of ["", "保留用户的原始要求", "  原始空白\n和换行  "]) assert.equal(generationModelPrompt(report, text), text, "Markdown model text remains unchanged");
  assert(generationSystemPrompt(report).includes('"markdown"'));
  assert.equal(generationSystemPrompt(report).includes(JSON_CANVAS_GENERATION_REFERENCE), false);

  const userText = modelPrompt;
  const budgetFor = (attempt: GenerationAttempt) => estimateTokenValue(generationSystemPrompt(request, attempt))
    + estimateTokenValue(generationContextMessage(request, sources, attempt).content) + estimateTokenValue(userText) + 1024;
  for (const attempt of [initial, repair, fallback]) {
    const budget = budgetFor(attempt);
    assert.doesNotThrow(() => assertGenerationInputBudget(request, sources, budget, userText, attempt));
    assert.throws(() => assertGenerationInputBudget(request, sources, budget - 1, userText, attempt), /本轮预算/u);
  }
  assert.throws(() => assertGenerationInputBudget(request, sources, budgetFor(fallback), userText), /本轮预算/u, "full skill and examples consume the initial budget");
  for (const larger of [
    { ...repair, failedOutput: repair.failedOutput.repeat(100) },
    { ...repair, validationError: repair.validationError.repeat(100) }
  ]) assert.throws(() => assertGenerationInputBudget(request, sources, budgetFor(repair), userText, larger), /本轮预算/u, "repair output and errors are never truncated or omitted from budget");
  assert.throws(() => assertGenerationInputBudget(request, sources, budgetFor(initial), userText.repeat(100)), /本轮预算/u, "actual user text is included");
  assert.throws(() => assertGenerationInputBudget(request, [{ ...sources[0], content: sources[0].content.repeat(100) }], budgetFor(initial), userText), /本轮预算/u, "source content is never truncated to fit");
  assert.doesNotThrow(() => assertGenerationInputBudget(request, sources, budgetFor(initial)));
  assert.throws(() => assertGenerationInputBudget(request, sources, budgetFor(initial) - 1), /本轮预算/u, "the default budget includes the actual neutral Canvas prompt");
  assert.doesNotThrow(() => assertGenerationInputBudget(renamed, sources, budgetFor(initial)), "public template labels are not charged as model input");
  for (const invalid of [0, -1, 1.5, Number.NaN]) assert.throws(() => assertGenerationInputBudget(request, sources, invalid), /本轮预算/u);
}
