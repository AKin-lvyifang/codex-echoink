import * as assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import * as path from "node:path";
import { createAgentTaskRuntime } from "../../agent/factory";
import type { AgentTaskInput } from "../../agent/types";
import { assertOpenCodeAgentSelection, requireDirectOpenCodeAgent } from "../../core/opencode-agent-selection";
import { TaskRuntimeAgentAdapter } from "../../harness/agents/adapters/task-runtime-adapter";
import { emptyContextBundle } from "../../harness/contracts/context";
import { cleanPromptEnhancerOutput, ENHANCE_META_PROMPT, ENHANCE_PROMPT_AGENT_NAME } from "../../prompt-enhancer/meta-prompt";
import { createPromptEnhancerRuntimeWorkspace } from "../../prompt-enhancer/runtime-workspace";
import { DEFAULT_SETTINGS, normalizeSettingsData } from "../../settings/settings";

export async function runPromptEnhancerHarnessTests(): Promise<void> {
  await assertPromptEnhancerIsSeparateFromEditorActions();
  await assertPromptEnhancerUsesWorkBuddyMetaPrompt();
  await assertPromptEnhancerTaskSeparatesSystemAndUser();
  await assertPromptEnhancerOpenCodeWorkspaceIsIsolated();
  await assertPromptEnhancerOpenCodeAgentIsDirectAndVerified();
  await assertPromptEnhancerUiEntryIsComposerToolbarIcon();
  await assertPromptEnhancerServiceUsesIsolatedWorkflow();
}

async function assertPromptEnhancerIsSeparateFromEditorActions(): Promise<void> {
  assert.equal(DEFAULT_SETTINGS.promptEnhancer.enabled, true);
  assert.equal(DEFAULT_SETTINGS.promptEnhancer.backend, "default");
  assert.equal(DEFAULT_SETTINGS.promptEnhancer.agent, "");
  assert.equal(DEFAULT_SETTINGS.editorActions.actions.some((action) => action.id === "enhance"), false);

  const normalized = normalizeSettingsData({
    settingsVersion: 29,
    editorActions: {
      actions: [
        ...DEFAULT_SETTINGS.editorActions.actions,
        { id: "enhance", label: "增强提示词", enabled: true, promptTemplate: "legacy" }
      ]
    }
  }).settings;
  assert.equal(normalized.editorActions.actions.some((action) => action.id === "enhance"), false);
  assert.equal(normalized.promptEnhancer.enabled, true);
  assert.equal(normalizeSettingsData({
    settingsVersion: 30,
    promptEnhancer: { agent: "enhance-prompt" }
  }).settings.promptEnhancer.agent, "", "旧半成品中的内置子代理名不能被当成后端 Agent/Profile");
  assert.equal(normalizeSettingsData({
    settingsVersion: 31,
    promptEnhancer: { agent: "custom-backend-agent" }
  }).settings.promptEnhancer.agent, "custom-backend-agent");
}

async function assertPromptEnhancerUsesWorkBuddyMetaPrompt(): Promise<void> {
  const document = await readFile(path.join(process.cwd(), "docs/architecture/WorkBuddy增强提示词实现逻辑参考文档.md"), "utf8");
  const match = document.match(/## 2\. 内置 Meta-Prompt 全文[\s\S]*?未经任何修改：\s*```[^\n]*\n([\s\S]*?)\n```/);
  assert.ok(match?.[1], "WorkBuddy 文档必须包含“内置 Meta-Prompt 全文”代码块");
  assert.equal(ENHANCE_META_PROMPT, match[1], "内置 system prompt 必须与 WorkBuddy 原文逐字符一致");
  assert.equal(cleanPromptEnhancerOutput("```text\n请基于真实记录生成周报。\n```"), "请基于真实记录生成周报。");
}

async function assertPromptEnhancerTaskSeparatesSystemAndUser(): Promise<void> {
  const original = "  帮我写一份周报，并保留原始空格  ";
  let captured: AgentTaskInput | null = null;
  const adapter = new TaskRuntimeAgentAdapter({
    backendId: "opencode",
    displayName: "OpenCode",
    version: "test",
    capabilities: "legacy",
    runtime: {
      kind: "opencode",
      connect: async () => ({ connected: true, label: "OpenCode", errors: [] }),
      listModels: async () => [],
      runTask: async (input) => {
        captured = input;
        return { text: "增强结果" };
      },
      abort: async () => undefined
    },
    legacyTaskDefaults: {
      system: ENHANCE_META_PROMPT,
      tools: { read: false, write: false, edit: false, bash: false }
    }
  });
  const context = emptyContextBundle();
  context.corePolicy = [{ id: "must-not-leak", priority: 1, channel: "system", content: "不要注入我", source: "test", required: true, sensitive: false }];
  context.turnInstruction = [{ id: "turn", priority: 1, channel: "user", content: original, source: "user", required: true, sensitive: false }];
  await adapter.run({
    runId: "prompt-enhance-test",
    sessionId: "prompt-enhance-session",
    workflow: "prompt.enhance",
    input: { text: original, attachments: [] },
    permissions: { mode: "read-only", writableRoots: [], requireApproval: true },
    resources: { selected: [], resolvedAt: 0, warnings: [] },
    context,
    outputContract: { kind: "plain-text" }
  }, () => undefined);

  assert.ok(captured);
  assert.equal(captured.prompt, original, "user 消息必须保持为原始输入，不能拼接 system 或 EchoInk 上下文");
  assert.equal(captured.system, ENHANCE_META_PROMPT);
  assert.deepEqual(captured.sources, []);
  assert.deepEqual(captured.tools, { read: false, write: false, edit: false, bash: false });
}

async function assertPromptEnhancerOpenCodeWorkspaceIsIsolated(): Promise<void> {
  const workspace = await createPromptEnhancerRuntimeWorkspace("opencode");
  const configPath = path.join(workspace.cwd, ".opencode", "opencode.json");
  try {
    assert.match(path.basename(workspace.cwd), /^echoink-prompt-enhancer-/);
    const config = JSON.parse(await readFile(configPath, "utf8")) as any;
    assert.deepEqual(config.plugin, []);
    assert.equal(config.default_agent, ENHANCE_PROMPT_AGENT_NAME);
    assert.equal(config.agent?.[ENHANCE_PROMPT_AGENT_NAME]?.mode, "primary");
    assert.deepEqual(config.agent?.[ENHANCE_PROMPT_AGENT_NAME]?.tools, { "*": false });
    assert.deepEqual(config.agent?.[ENHANCE_PROMPT_AGENT_NAME]?.permission, { "*": "deny" });
  } finally {
    await workspace.cleanup();
  }
  await assert.rejects(access(configPath), /ENOENT/);
}

async function assertPromptEnhancerOpenCodeAgentIsDirectAndVerified(): Promise<void> {
  const primaryAgent = {
    id: ENHANCE_PROMPT_AGENT_NAME,
    name: ENHANCE_PROMPT_AGENT_NAME,
    displayName: ENHANCE_PROMPT_AGENT_NAME,
    mode: "primary" as const
  };
  const subagent = {
    id: "build",
    name: "build",
    displayName: "build",
    mode: "subagent" as const
  };
  assert.equal(requireDirectOpenCodeAgent(`\u200B${ENHANCE_PROMPT_AGENT_NAME}`, [primaryAgent, subagent]), primaryAgent);
  assert.throws(() => requireDirectOpenCodeAgent("build", [primaryAgent, subagent]), /不能直接执行增强提示词/);
  assert.throws(() => requireDirectOpenCodeAgent("missing", [primaryAgent, subagent]), /Agent 不存在/);
  assert.doesNotThrow(() => assertOpenCodeAgentSelection(ENHANCE_PROMPT_AGENT_NAME, `\u200B${ENHANCE_PROMPT_AGENT_NAME}`));
  assert.throws(() => assertOpenCodeAgentSelection(ENHANCE_PROMPT_AGENT_NAME, ""), /无法确认/);
  assert.throws(() => assertOpenCodeAgentSelection(ENHANCE_PROMPT_AGENT_NAME, "Sisyphus - Ultraworker"), /未按设置使用 Agent/);

  const hooks = {
    agents: [primaryAgent, subagent],
    models: [{
      id: "opencode/prompt-test",
      providerId: "opencode",
      modelId: "opencode/prompt-test",
      displayName: "Prompt test",
      inputModalities: ["text"]
    }],
    session: { sessionId: "prompt-enhancer-native-session", title: "Prompt enhancer" },
    startSessionOptions: [] as any[],
    sendPromptOptions: [] as any[],
    deleteSessionCalls: [] as string[],
    sendPromptResult: "增强结果"
  };
  (globalThis as any).__opencodeBackendTestHooks = hooks;
  try {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.opencode.agent = "build";
    const runtime = createAgentTaskRuntime({ backend: "opencode", settings, vaultPath: "/isolated/prompt-enhancer" });
    const result = await runtime.runTask({
      prompt: "  保留原始输入  ",
      system: ENHANCE_META_PROMPT,
      agent: ENHANCE_PROMPT_AGENT_NAME,
      requireDirectAgent: true,
      tools: { read: false, write: false, edit: false, bash: false }
    });
    assert.equal(result.text, "增强结果");
    assert.equal(hooks.startSessionOptions[0]?.agent, ENHANCE_PROMPT_AGENT_NAME);
    assert.equal(hooks.sendPromptOptions[0]?.agent, ENHANCE_PROMPT_AGENT_NAME);
    assert.equal(hooks.sendPromptOptions[0]?.system, ENHANCE_META_PROMPT);
    assert.equal(hooks.sendPromptOptions[0]?.parts?.[0]?.text, "  保留原始输入  ");
    assert.deepEqual(hooks.sendPromptOptions[0]?.tools, { read: false, write: false, edit: false, bash: false });
    assert.deepEqual(hooks.deleteSessionCalls, ["prompt-enhancer-native-session"]);
  } finally {
    delete (globalThis as any).__opencodeBackendTestHooks;
  }
}

async function assertPromptEnhancerUiEntryIsComposerToolbarIcon(): Promise<void> {
  const cwd = process.cwd();
  const composerSource = await readFile(path.join(cwd, "src/ui/codex-view/composer.ts"), "utf8");
  const shellSource = await readFile(path.join(cwd, "src/ui/codex-view/view-shell.ts"), "utf8");
  const viewSource = await readFile(path.join(cwd, "src/ui/codex-view.ts"), "utf8");
  const styles = await readFile(path.join(cwd, "styles.css"), "utf8");
  const settingsTabSource = await readFile(path.join(cwd, "src/settings/settings-tab.ts"), "utf8");

  assert.match(composerSource, /createComposerIconButton\(left,\s*"sparkles",\s*"增强提示词"\)/);
  assert.doesNotMatch(composerSource, /codex-composer-enhance-button/);
  assert.match(composerSource, /codex-composer-model-name/);
  assert.match(composerSource, /codex-composer-reasoning-label/);
  assert.match(composerSource, /text:\s*state\.workspacePath\s*\?\s*state\.workspaceDisplayName\s*:\s*"请选择文件夹"/);
  assert.doesNotMatch(composerSource, /toggleClass\("is-missing"/);
  assert.match(shellSource, /prompt-enhancer-runner/);
  assert.match(viewSource, /enhancePrompt\(\)/);
  assert.match(viewSource, /promptEnhancerRunning/);
  assert.match(viewSource, /promptEnhancerRunId/);
  assert.doesNotMatch(styles, /\.codex-composer-enhance-button/);
  assert.match(styles, /\.codex-model-summary-button[\s\S]*background:\s*color-mix/);
  assert.match(styles, /\.codex-composer-model-name[\s\S]*color:\s*var\(--text-normal\)/);
  assert.match(styles, /\.codex-composer-reasoning-label[\s\S]*color:\s*var\(--text-muted\)/);
  assert.match(settingsTabSource, /renderPromptEnhancerSettings/);
  assert.match(settingsTabSource, /查看内置 Meta-Prompt/);
  assert.match(settingsTabSource, /Codex API 路径/);
}

async function assertPromptEnhancerServiceUsesIsolatedWorkflow(): Promise<void> {
  const serviceSource = await readFile(path.join(process.cwd(), "src/prompt-enhancer/service.ts"), "utf8");
  const editorActionRunnerSource = await readFile(path.join(process.cwd(), "src/ui/codex-view/editor-action-runner.ts"), "utf8");
  const promptEnhancerRunnerSource = await readFile(path.join(process.cwd(), "src/ui/codex-view/prompt-enhancer-runner.ts"), "utf8");
  const taskAdapterSource = await readFile(path.join(process.cwd(), "src/harness/agents/adapters/task-runtime-adapter.ts"), "utf8");
  const eventRuntimeSource = await readFile(path.join(process.cwd(), "src/agent/event-task.ts"), "utf8");
  assert.match(serviceSource, /const NO_TOOLS = \{ read: false, write: false, edit: false, bash: false \}/);
  assert.match(serviceSource, /workflow:\s*"prompt\.enhance"/);
  assert.match(serviceSource, /developerInstructions:\s*ENHANCE_META_PROMPT/);
  assert.match(serviceSource, /ephemeral:\s*true/);
  assert.match(serviceSource, /sessionId:\s*`\$\{ENHANCE_PROMPT_AGENT_NAME\}:\$\{runId\}`/);
  assert.match(serviceSource, /withTimeout\(plugin\.runHarnessWithAdapter/);
  assert.match(serviceSource, /adapter\?\.cancel\(runId\)/);
  assert.doesNotMatch(serviceSource, /buildPromptEnhancerPrompt/);
  assert.match(serviceSource, /outputContract:\s*\{\s*kind:\s*"plain-text"\s*\}/);
  assert.match(taskAdapterSource, /request\.workflow === "prompt\.enhance"/);
  assert.match(eventRuntimeSource, /input\.system/);
  assert.match(promptEnhancerRunnerSource, /view\.promptEnhancerRunning = true/);
  assert.doesNotMatch(promptEnhancerRunnerSource, /view\.running = true|view\.activeRunId\s*=/);
  assert.doesNotMatch(editorActionRunnerSource, /export async function enhanceChatInput|request\.action\.id === "enhance"/);
}
