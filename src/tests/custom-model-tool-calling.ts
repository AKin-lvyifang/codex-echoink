import assert from "node:assert/strict";
import { createApiProviderConfig, createApiProviderModelConfig, createDiscoveredApiProviderModelConfig, normalizeSettingsData } from "../settings/settings";
import { createPiKnowledgeInlineExtension } from "../plugin/pi-production-runtime-composition";
import { diagnoseToolCallText } from "../harness/tool-call-text";

export async function runCustomModelToolCallingTests(): Promise<void> {
  const provider = createApiProviderConfig("custom", "tool-defaults");
  const unknown = createApiProviderModelConfig("custom", "uncatalogued-agent");
  const discovered = createDiscoveredApiProviderModelConfig("custom", unknown.id, "custom", { id: unknown.id });
  assert.equal(unknown.toolCalling, true);
  assert.equal(discovered.toolCalling, true);
  const cases = [
    { model: { ...unknown, toolCalling: false }, expected: true },
    { model: { ...discovered, toolCalling: false }, expected: true },
    { model: { ...discovered, discovery: { id: unknown.id, toolCalling: false } }, expected: false },
    { model: { ...unknown, toolCalling: false, metadataSource: "manual", capabilityOverrides: { toolCalling: false } }, expected: false },
    { model: { ...discovered, capabilityOverrides: { toolCalling: true }, discovery: { id: unknown.id, toolCalling: false } }, expected: true },
    { model: { ...unknown, toolCalling: false, metadataSource: "manual" }, expected: false },
    { model: { ...discovered, toolCalling: false, metadataSource: "manual" }, expected: false },
    { model: { ...unknown, toolCalling: false, metadataSource: "manual", capabilityOverrides: { reasoning: false } }, expected: true }
  ];
  for (const { model, expected } of cases) {
    const once = normalizeSettingsData({ apiProviders: [{ ...provider, models: [model], defaultModelId: model.id }], activeApiProviderId: provider.id, defaultModel: model.id }).settings;
    assert.equal(once.apiProviders[0].models[0].toolCalling, expected, JSON.stringify(model));
    assert.deepEqual(normalizeSettingsData(once).settings.apiProviders, once.apiProviders, "migration is idempotent");
  }
  console.log("PASS tool calling defaults: ID-only discovery and 8 stored provenance/override round trips");

  const handlers = new Map<string, (event: unknown) => Promise<any>>();
  const extension = createPiKnowledgeInlineExtension({ supportsToolCalling: false, vaultSecurity: () => {}, currentTurn: () => null,
    currentWorkspaceAccess: () => ({ permission: "workspace-write", mode: "plan", memoryMode: "no_memory" }),
    currentTaskPlanTurn: () => ({ mode: "plan", plan: null }) });
  await (typeof extension === "function" ? extension : extension.factory)({ on: (name: string, handler: any) => handlers.set(name, handler) } as never);
  const result = await handlers.get("before_agent_start")!({ systemPrompt: "保留身份、事实核验和安全边界。" });
  assert.match(result.systemPrompt, /保留身份、事实核验和安全边界/);
  assert.match(result.systemPrompt, /当前模型未开启工具调用/);
  assert.doesNotMatch(result.systemPrompt, /web_search|task_update|当前可使用已准入的读写工具|必须调用/u);
  console.log("PASS tool calling disabled: production prompt hook keeps conversation boundaries without tool instructions");

  const xml = '<tool_call>{"name":"note_read","arguments":{"path":"example.md"}}</tool_call>';
  const dsml = '<｜DSML｜function_calls><｜DSML｜invoke name="note_read"><｜DSML｜parameter name="path">example.md</｜DSML｜parameter></｜DSML｜invoke></｜DSML｜function_calls>';
  const fn = '<function_call>{"name":"note_read","arguments":{}}</function_call>';
  for (const text of [xml, dsml, fn]) {
    assert.equal(diagnoseToolCallText(text, false, false), "model_tool_call_text_disabled");
    assert.equal(diagnoseToolCallText(text, false, true), "model_tool_call_text_incompatible");
    assert.equal(diagnoseToolCallText(text, true, true), undefined);
    for (const sample of [`\`\`\`xml\n${text}\n\`\`\``, `~~~~\n${text}\n~~~~`, `\`${text}\``, `> ${text}`, `    ${text}`]) {
      assert.equal(diagnoseToolCallText(sample, false, true), undefined, sample);
    }
  }
  assert.equal(diagnoseToolCallText("请解释 <tool_call>、<function_call> 和 DSML。", false, true), undefined);
  assert.equal(diagnoseToolCallText('<tool_call>{"name":"note_read"}</tool_call>', false, true), undefined);
  console.log("PASS tool text detection: 3 invocation formats, both switch states, actual execution and Markdown examples");
}
