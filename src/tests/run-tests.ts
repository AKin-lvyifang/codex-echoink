import * as assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { extractClipboardImageFiles, imageExtensionForMime, saveClipboardImageAttachment } from "../core/clipboard-images";
import { buildDiffSummary, parseFileChangeDiff, serializeFileChanges } from "../core/diff-summary";
import { calculateVirtualWindow, isNearVirtualBottom, scrollTopForVirtualBottom } from "../core/virtual-window";
import {
  buildCollaborationMode,
  buildSandboxPolicy,
  buildUserInput,
  contextPercent,
  contextUsageView,
  extractProcessFileRefs,
  filterSkills,
  getSlashQuery,
  normalizeProcessFileRef,
  normalizeServiceTier,
  reasoningTextFromPayload,
  summarizeProcessEvent
} from "../core/mapping";
import { settleStaleRunningMessages } from "../core/message-state";
import { formatRateLimitUsage, normalizeRateLimitResponse } from "../core/rate-limits";
import { externalizeLargeMessages, prepareRawMessage, readRawText } from "../core/raw-message-store";
import {
  emptyWorkspaceResourceSnapshot,
  loadedTabsFromWorkspaceResourceCache,
  mergeMcpServers,
  mergeWorkspaceResourceSnapshot,
  snapshotFromWorkspaceResourceCache,
  updateWorkspaceResourceCache
} from "../core/workspace-resources";
import {
  DEFAULT_SETTINGS,
  getApiProviderModels,
  getActiveApiProvider,
  ensureModelChoices,
  filterEnabledSkills,
  getKnowledgeBaseRulesFileChoices,
  ensureKnowledgeBaseSession,
  openCodeAgentChoiceLabel,
  openCodeAgentChoiceValue,
  openCodeAgentModeLabel,
  openCodeModelCapabilityLabel,
  openCodeModelChoiceLabel,
  openCodeModelChoiceValue,
  parseOpenCodeAgentChoiceValue,
  parseOpenCodeModelChoiceValue,
  providerModelLabel,
  providerConnectionLabel,
  KNOWLEDGE_BASE_SESSION_TITLE,
  isKnowledgeBaseSession,
  normalizeSettingsData,
  recordKnowledgeBaseHealthCheck,
  removeApiProvider,
  resolveEditorActionModeConfig,
  validateApiProvider,
  resourceEnabled
} from "../settings/settings";
import { buildCodexLaunchConfig, resolveCodexCommand } from "../core/codex-service";
import {
  detectOpenCodeCommand,
  ensureOpenCodeModelSupportsFiles,
  flattenOpenCodeAgents,
  flattenOpenCodeModels,
  mimeForKnowledgeFile,
  modelInputModalities,
  requiredModalityForMime,
  resolveOpenCodeCommand
} from "../core/opencode-models";
import { SETTINGS_GEAR_ICON_PATHS } from "../ui/codex-icon";
import { buildEditorActionPrompt, buildEditorActionReviewPrompt, buildEditorActionUserInput, resolveEditorActionStyle } from "../editor-actions/prompt";
import { cleanEditorActionOutput, validateEditorActionCandidateText } from "../editor-actions/output";
import {
  buildEditorActionSummaryPrompt,
  buildArticleUnderstandingPrompt,
  editorActionContentHash,
  getFreshArticleUnderstanding,
  getFreshEditorActionSummary,
  makeArticleUnderstandingFingerprint,
  makeArticleUnderstandingCacheEntry,
  makeEditorActionSummaryCacheEntry,
  resolveArticleUnderstandingCache,
  upsertArticleUnderstandingCache,
  upsertEditorActionSummaryCache
} from "../editor-actions/summary-cache";
import {
  buildEditorActionSelectionSnapshot,
  editorActionCandidateInvalidationReason,
  editorActionCandidateReplacementRange,
  confirmEditorActionCandidate,
  enabledEditorActionConfigs,
  validateEditorActionSelection
} from "../editor-actions/selection";
import { editorActionStartBlockReason, editorActionStatusFromResult, extractEditorActionNotificationIds, isEditorActionCurrentRunNotification, isEditorActionHiddenNotification, routeEditorActionNotification } from "../editor-actions/state";
import { buildEditorActionTurnOptions, DEFAULT_EDITOR_ACTION_MODEL, resolveEditorActionModel } from "../editor-actions/turn-options";
import { discoverKnowledgeBaseSources } from "../knowledge-base/discovery";
import { buildKnowledgeBaseDashboardSnapshot } from "../knowledge-base/dashboard";
import { buildKnowledgeBaseInitializationPreview, executeKnowledgeBaseInitialization, KNOWLEDGE_BASE_TEMPLATE_VERSION } from "../knowledge-base/initializer";
import { buildKnowledgeBasePrompt } from "../knowledge-base/prompt";
import { parseKnowledgeBaseCommand } from "../knowledge-base/commands";
import { routeKnowledgeBaseCodexNotification } from "../knowledge-base/codex-route";
import { isLintOnlyKnowledgeBaseReport, readKnowledgeBaseReportExcerpt, recoveredLintReportSummary } from "../knowledge-base/report";
import { repairKnowledgeBaseRulesFile } from "../knowledge-base/rules-repair";

const workspace = buildSandboxPolicy("workspace-write", "/vault");
assert.equal(workspace.type, "workspaceWrite");
assert.ok(workspace.writableRoots?.includes("/vault"));

assert.equal(buildSandboxPolicy("read-only", "/vault").type, "readOnly");
assert.equal(buildSandboxPolicy("danger-full-access", "/vault").type, "dangerFullAccess");
assert.deepEqual(buildSandboxPolicy("workspace-write", "/vault", ["/vault/wiki", "/vault/outputs"]).writableRoots?.slice(0, 2), ["/vault/wiki", "/vault/outputs"]);

assert.equal(normalizeServiceTier("standard"), null);
assert.equal(normalizeServiceTier("fast"), "fast");
assert.equal(normalizeServiceTier("flex"), "flex");

assert.equal(DEFAULT_SETTINGS.defaultModel, "gpt-5.5");
assert.equal(DEFAULT_SETTINGS.defaultReasoning, "high");
assert.equal(DEFAULT_SETTINGS.proxyEnabled, false);
assert.equal(DEFAULT_SETTINGS.settingsVersion, 20);
assert.equal(DEFAULT_SETTINGS.settingsTab, "general");
assert.equal(DEFAULT_SETTINGS.agentBackend, "codex-cli");
assert.equal(DEFAULT_SETTINGS.providerMode, "codex-login");
assert.equal(DEFAULT_SETTINGS.editorActions.enabled, false);
assert.equal(DEFAULT_SETTINGS.editorActions.statusSlotEnabled, true);
assert.equal(DEFAULT_SETTINGS.editorActions.model, DEFAULT_EDITOR_ACTION_MODEL);
assert.equal(DEFAULT_SETTINGS.editorActions.qualityMode, "quality");
assert.equal(DEFAULT_SETTINGS.editorActions.showContextPanel, true);
assert.equal(resolveEditorActionModeConfig(DEFAULT_SETTINGS.editorActions, "fast").model, "gpt-5.4-mini");
assert.equal(resolveEditorActionModeConfig(DEFAULT_SETTINGS.editorActions, "fast").contextCharsBefore, 500);
assert.equal(resolveEditorActionModeConfig(DEFAULT_SETTINGS.editorActions, "quality").model, "gpt-5.4");
assert.equal(resolveEditorActionModeConfig(DEFAULT_SETTINGS.editorActions, "quality").contextCharsBefore, 1000);
assert.equal(resolveEditorActionModeConfig(DEFAULT_SETTINGS.editorActions, "strict").model, "gpt-5.5");
assert.equal(resolveEditorActionModeConfig(DEFAULT_SETTINGS.editorActions, "strict").contextCharsBefore, 1500);
assert.equal(DEFAULT_SETTINGS.editorActions.defaultStyleId, "clear");
assert.equal(DEFAULT_SETTINGS.editorActions.maxSelectedChars, 4000);
assert.equal(DEFAULT_SETTINGS.editorActions.contextCharsBefore, 300);
assert.equal(DEFAULT_SETTINGS.editorActions.contextCharsAfter, 300);
assert.equal(DEFAULT_SETTINGS.editorActions.timeoutMs, 45000);
assert.deepEqual(DEFAULT_SETTINGS.editorActions.articleUnderstandingCache, {});
assert.deepEqual(DEFAULT_SETTINGS.editorActions.actions.map((action) => action.id), ["rewrite", "expand", "continue", "translate"]);
assert.equal(DEFAULT_SETTINGS.opencode.autoStart, true);
assert.equal(DEFAULT_SETTINGS.opencode.hostname, "127.0.0.1");
assert.equal(DEFAULT_SETTINGS.opencode.port, 4096);
assert.equal(DEFAULT_SETTINGS.opencode.textEnabled, true);
assert.equal(DEFAULT_SETTINGS.opencode.imageEnabled, false);
assert.equal(DEFAULT_SETTINGS.opencode.pdfEnabled, false);
assert.equal(DEFAULT_SETTINGS.knowledgeBase.enabled, false);
assert.equal(DEFAULT_SETTINGS.knowledgeBase.backend, "default");
assert.equal(DEFAULT_SETTINGS.knowledgeBase.useCustomRulesFile, false);
assert.equal(DEFAULT_SETTINGS.knowledgeBase.rulesFilePath, "AGENTS.md");
assert.equal(DEFAULT_SETTINGS.knowledgeBase.scheduleTime, "09:00");
assert.equal(DEFAULT_SETTINGS.knowledgeBase.sessionId, "");
assert.equal(DEFAULT_SETTINGS.knowledgeBase.initialization.status, "not-started");
assert.equal(DEFAULT_SETTINGS.knowledgeBase.initialization.templateVersion, KNOWLEDGE_BASE_TEMPLATE_VERSION);
assert.deepEqual(DEFAULT_SETTINGS.knowledgeBase.healthHistory, []);
assert.deepEqual(
  getKnowledgeBaseRulesFileChoices(["docs/kb-rules.md", "raw/source.pdf", "CLAUDE.md", "/AGENTS.md", "../bad.md", "docs/kb-rules.md", "notes/todo.txt"]),
  ["AGENTS.md", "CLAUDE.md", "docs/kb-rules.md"]
);
const openCodeChoice = { providerId: "deepseek", modelId: "deepseek-reasoner" };
assert.equal(openCodeModelChoiceValue(openCodeChoice), "deepseek\u0000deepseek-reasoner");
assert.deepEqual(parseOpenCodeModelChoiceValue("deepseek\u0000deepseek-reasoner"), openCodeChoice);
assert.equal(parseOpenCodeModelChoiceValue("bad"), null);
assert.equal(openCodeModelCapabilityLabel({ inputModalities: ["text", "image"] }), "文本 ✓ · 图片 ✓ · PDF ×");
assert.equal(openCodeModelChoiceLabel({
  providerId: "deepseek",
  modelId: "deepseek-reasoner",
  displayName: "DeepSeek · Reasoner",
  inputModalities: ["text"]
}), "DeepSeek · Reasoner · 文本 ✓ · 图片 × · PDF ×");
const openCodeAgent = { name: "build", mode: "primary" as const, native: true };
assert.equal(openCodeAgentChoiceValue(openCodeAgent), "build");
assert.equal(parseOpenCodeAgentChoiceValue(" build "), "build");
assert.equal(parseOpenCodeAgentChoiceValue(" "), null);
assert.equal(openCodeAgentModeLabel(openCodeAgent), "主 Agent");
assert.equal(openCodeAgentChoiceLabel(openCodeAgent), "build · 主 Agent · 内置");
const freshInstallEditorActions = normalizeSettingsData({}).settings.editorActions;
assert.equal(freshInstallEditorActions.qualityMode, "quality");
assert.equal(resolveEditorActionModeConfig(freshInstallEditorActions, "fast").contextCharsBefore, 500);
assert.equal(resolveEditorActionModeConfig(freshInstallEditorActions, "quality").contextCharsBefore, 1000);
const migratedKnowledgeBaseSettings = normalizeSettingsData({
  settingsVersion: 19,
  knowledgeBase: {
    healthHistory: [
      { date: "2026-05-15", status: "success", at: 1778803200000 },
      { date: "bad", status: "success", at: 1 },
      { date: "2026-05-16", status: "unknown", at: 2 }
    ]
  }
}).settings.knowledgeBase;
assert.deepEqual(migratedKnowledgeBaseSettings.healthHistory, [
  { date: "2026-05-15", status: "success", at: 1778803200000 }
]);
recordKnowledgeBaseHealthCheck(migratedKnowledgeBaseSettings, "failed", 1778889600000);
assert.deepEqual(migratedKnowledgeBaseSettings.healthHistory.at(-1), {
  date: "2026-05-16",
  status: "failed",
  at: 1778889600000
});

const sessionSettings = normalizeSettingsData({
  settingsVersion: 16,
  sessions: [
    { id: "chat-1", title: "普通会话", cwd: "/vault", messages: [], createdAt: 1, updatedAt: 1 }
  ],
  activeSessionId: "chat-1"
}).settings;
const kbSession = ensureKnowledgeBaseSession(sessionSettings, "/vault", () => "kb-fixed");
assert.equal(kbSession.id, "kb-fixed");
assert.equal(kbSession.title, KNOWLEDGE_BASE_SESSION_TITLE);
assert.equal(kbSession.kind, "knowledge-base");
assert.equal(sessionSettings.knowledgeBase.sessionId, "kb-fixed");
assert.equal(sessionSettings.activeSessionId, "chat-1");
assert.equal(sessionSettings.sessions[0].id, "kb-fixed");
assert.equal(isKnowledgeBaseSession(kbSession), true);
assert.equal(ensureKnowledgeBaseSession(sessionSettings, "/vault-next", () => "kb-new").id, "kb-fixed");
assert.equal(kbSession.cwd, "/vault-next");

assert.deepEqual(parseKnowledgeBaseCommand("只体检一下").intent, "lint");
assert.deepEqual(parseKnowledgeBaseCommand("帮我维护并消化今天的 raw").intent, "maintain");
assert.deepEqual(parseKnowledgeBaseCommand("重新提炼最近的资料").intent, "reingest");
assert.deepEqual(parseKnowledgeBaseCommand("/check 只看断链").intent, "lint");
assert.deepEqual(parseKnowledgeBaseCommand("/体检？只看断链").intent, "lint");
assert.deepEqual(parseKnowledgeBaseCommand("/maintain 只处理今天新增").intent, "maintain");
assert.deepEqual(parseKnowledgeBaseCommand("/outputs 提炼最近发布稿").intent, "process-outputs");
assert.deepEqual(parseKnowledgeBaseCommand("/inbox 只归类不沉淀").intent, "process-inbox");
assert.deepEqual(parseKnowledgeBaseCommand("/journal 今天完成知识库命令优化").intent, "journal");
assert.deepEqual(parseKnowledgeBaseCommand("/init").intent, "init");
assert.deepEqual((parseKnowledgeBaseCommand("/init confirm") as any).confirm, true);
assert.deepEqual((parseKnowledgeBaseCommand("/初始化 确认") as any).confirm, true);
assert.deepEqual((parseKnowledgeBaseCommand("/init 先预览，不确认") as any).confirm, false);
assert.deepEqual(parseKnowledgeBaseCommand("写日记：今天测试知识库频道").intent, "journal");
assert.deepEqual(parseKnowledgeBaseCommand("处理 inbox").intent, "process-inbox");
assert.deepEqual(parseKnowledgeBaseCommand("处理 outputs").intent, "process-outputs");
assert.deepEqual(parseKnowledgeBaseCommand("收集这个链接 https://example.com/a").target, "raw-articles");
assert.deepEqual(parseKnowledgeBaseCommand("记一下：这个想法很重要").target, "inbox");
assert.deepEqual(parseKnowledgeBaseCommand("收集这个 PDF", 1).target, "raw-attachments");
assert.deepEqual(parseKnowledgeBaseCommand("今天知识库状态怎么样").intent, "help");

const kbRouteItems = new Set<string>();
const orphanStarted = routeKnowledgeBaseCodexNotification("item/started", { item: { id: "item-1" } }, {
  threadId: "thread-kb",
  turnId: "turn-kb",
  itemIds: kbRouteItems
});
assert.equal(orphanStarted.swallow, true);
assert.equal(orphanStarted.rememberItemId, "item-1");
kbRouteItems.add(orphanStarted.rememberItemId!);
const orphanDelta = routeKnowledgeBaseCodexNotification("item/agentMessage/delta", { itemId: "item-1", delta: "报告" }, {
  threadId: "thread-kb",
  turnId: "turn-kb",
  itemIds: kbRouteItems
});
assert.equal(orphanDelta.swallow, true);
assert.equal(orphanDelta.collectAssistantDelta, true);
assert.equal(routeKnowledgeBaseCodexNotification("thread/tokenUsage/updated", { threadId: "thread-other" }, {
  threadId: "thread-kb",
  turnId: "turn-kb",
  itemIds: kbRouteItems
}).swallow, false);
assert.equal(routeKnowledgeBaseCodexNotification("error", { message: "failed" }, {
  threadId: "thread-kb",
  turnId: "turn-kb",
  itemIds: kbRouteItems
}).swallow, true);

assert.deepEqual(buildCollaborationMode("agent", "gpt-5.4", "high"), null);
assert.deepEqual(buildCollaborationMode("plan", "gpt-5.4", "high"), {
  mode: "plan",
  settings: {
    model: "gpt-5.4",
    reasoning_effort: "high",
    developer_instructions: null
  }
});

assert.equal(getSlashQuery("/"), "");
assert.equal(getSlashQuery("帮我 /answer"), "answer");
assert.equal(getSlashQuery("没有 slash"), null);

const skills = [
  { name: "answer", description: "回答问题", path: "/skills/answer", enabled: true },
  { name: "fix-bug", description: "修 bug", path: "/skills/fix", enabled: true },
  { name: "hidden", description: "隐藏", path: "/skills/hidden", enabled: false }
];
assert.equal(filterSkills(skills, "fix").length, 1);
assert.equal(filterSkills(skills, "").length, 2);

const input = buildUserInput(
  "你好",
  [
    { type: "file", name: "a.md", path: "/vault/a.md" },
    { type: "image", name: "b.png", path: "/vault/b.png" }
  ],
  { name: "answer", description: "", path: "/skills/answer", enabled: true }
);
assert.equal(input[0].type, "skill");
assert.equal(input[1].type, "text");
assert.ok(input[1].type === "text" && input[1].text.includes("回复格式要求"));
assert.equal(input[2].type, "text");
assert.ok(input[2].type === "text" && input[2].text.includes("用户已附带以下文件"));
assert.ok(input[2].type === "text" && input[2].text.includes("/vault/a.md"));
assert.equal(input[3].type, "text");
assert.equal(input[4].type, "mention");
assert.equal(input[5].type, "localImage");

assert.equal(imageExtensionForMime("image/png"), "png");
assert.equal(imageExtensionForMime("image/jpeg"), "jpg");
assert.equal(imageExtensionForMime("image/webp"), "webp");

const clipboardPng = new File([new Uint8Array([1, 2, 3])], "wechat-screenshot.png", { type: "image/png" });
const clipboardText = new File(["hello"], "hello.txt", { type: "text/plain" });
assert.deepEqual(
  extractClipboardImageFiles({
    items: [
      { kind: "string", type: "text/plain", getAsFile: () => null },
      { kind: "file", type: "image/png", getAsFile: () => clipboardPng },
      { kind: "file", type: "text/plain", getAsFile: () => clipboardText }
    ]
  }),
  [clipboardPng]
);

const clipboardVault = await mkdtemp(path.join(tmpdir(), "codex-clipboard-"));
try {
  const attachment = await saveClipboardImageAttachment(clipboardPng, {
    vaultPath: clipboardVault,
    timestamp: 1700000000000,
    index: 1
  });
  const expectedPath = path.join(clipboardVault, ".obsidian", "plugins", "obsidian-codex", "clipboard", "clipboard-1700000000000-1.png");
  assert.deepEqual(attachment, {
    type: "image",
    name: "clipboard-1700000000000-1.png",
    path: expectedPath
  });
  assert.deepEqual(await readFile(expectedPath), Buffer.from([1, 2, 3]));
} finally {
  await rm(clipboardVault, { recursive: true, force: true });
}

assert.equal(contextPercent(50, 100), 50);
assert.equal(contextPercent(200, 100), 100);
assert.equal(contextPercent(0, 100), 0);
assert.deepEqual(contextUsageView(undefined), {
  percent: null,
  label: "--",
  totalTokens: 0,
  contextWindow: null,
  angle: 0,
  title: "暂未读取到上下文容量"
});
assert.deepEqual(contextUsageView({ total: { totalTokens: 256 }, modelContextWindow: 1024 }), {
  percent: 25,
  label: "25%",
  totalTokens: 256,
  contextWindow: 1024,
  angle: 90,
  title: "上下文 25%，256 / 1024 tokens"
});
const cumulativeTokenUsageView = contextUsageView({
  total: { totalTokens: 1_347_500 },
  last: { totalTokens: 97_270 },
  modelContextWindow: 950_000
});
assert.equal(cumulativeTokenUsageView.percent, 10);
assert.equal(cumulativeTokenUsageView.label, "10%");
assert.equal(cumulativeTokenUsageView.totalTokens, 97_270);
assert.match(cumulativeTokenUsageView.title, /累计消耗 1347500 tokens/);

const vaultFile = normalizeProcessFileRef("/vault/notes/a.md", "/vault");
assert.equal(vaultFile.kind, "vault");
assert.equal(vaultFile.path, "notes/a.md");
assert.equal(vaultFile.name, "a.md");
const externalFile = normalizeProcessFileRef("/tmp/out.txt", "/vault");
assert.equal(externalFile.kind, "external");
assert.equal(externalFile.path, "/tmp/out.txt");
const refs = extractProcessFileRefs("sed -n '1,20p' src/ui/codex-view.ts && rg foo docs/sample.md", "/vault");
assert.deepEqual(
  refs.map((item) => item.path),
  ["src/ui/codex-view.ts", "docs/sample.md"]
);
assert.equal(summarizeProcessEvent("commandExecution", { command: "sed -n '1,20p' src/ui/codex-view.ts" }, "/vault").title, "查看文件");
assert.equal(summarizeProcessEvent("commandExecution", { command: "rg -n foo docs" }, "/vault").title, "搜索文件");
assert.equal(summarizeProcessEvent("commandExecution", { command: "npm run build" }, "/vault").title, "运行检查");
assert.equal(summarizeProcessEvent("commandExecution", { command: "rg -n foo docs" }, "/vault").kind, "search");
assert.equal(summarizeProcessEvent("commandExecution", { command: "sed -n '1,20p' src/ui/codex-view.ts" }, "/vault").kind, "view");
assert.equal(summarizeProcessEvent("commandExecution", { command: "npm run build" }, "/vault").kind, "run");
assert.equal(summarizeProcessEvent("fileChange", { changes: [{ path: "docs/sample.md" }] }, "/vault").title, "编辑文件");
assert.equal(summarizeProcessEvent("fileChange", { changes: [{ path: "docs/sample.md" }] }, "/vault").kind, "edit");
assert.equal(reasoningTextFromPayload({ summary: ["先确认附件", "再读取文件"], content: ["检查结构"] }), "先确认附件\n再读取文件\n检查结构");
assert.equal(summarizeProcessEvent("reasoning", { text: "确认当前文档", status: "running" }, "/vault").title, "正在思考");
assert.equal(summarizeProcessEvent("reasoning", { summary: ["确认完成"] }, "/vault").title, "已思考");
assert.equal(summarizeProcessEvent("reasoning", { summary: ["确认完成"] }, "/vault").defaultOpen, true);

const migratedSettings = normalizeSettingsData({
  settingsVersion: 2,
  defaultReasoning: "high",
  defaultServiceTier: "standard",
  proxyEnabled: true,
  proxyUrl: "http://127.0.0.1:7890"
});
assert.equal(migratedSettings.settings.settingsVersion, 20);
assert.equal(migratedSettings.settings.defaultReasoning, "high");
assert.equal(migratedSettings.settings.defaultServiceTier, "fast");
assert.equal(migratedSettings.settings.proxyEnabled, true);
assert.equal(migratedSettings.settings.proxyUrl, "http://127.0.0.1:7890");
assert.equal(migratedSettings.changed, true);

const persistedComposerSettings = normalizeSettingsData({
  settingsVersion: 3,
  defaultModel: "gpt-5.5",
  defaultReasoning: "xhigh",
  defaultServiceTier: "flex",
  defaultPermission: "read-only",
  defaultMode: "plan"
});
assert.equal(persistedComposerSettings.settings.defaultModel, "gpt-5.5");
assert.equal(persistedComposerSettings.settings.defaultReasoning, "xhigh");
assert.equal(persistedComposerSettings.settings.defaultServiceTier, "flex");
assert.equal(persistedComposerSettings.settings.defaultPermission, "read-only");
assert.equal(persistedComposerSettings.settings.defaultMode, "plan");

const migratedDefaultModelSettings = normalizeSettingsData({
  settingsVersion: 3,
  defaultModel: "gpt-5.4",
  defaultReasoning: "low",
  defaultServiceTier: "fast"
});
assert.equal(migratedDefaultModelSettings.settings.settingsVersion, 20);
assert.equal(migratedDefaultModelSettings.settings.defaultModel, "gpt-5.5");
assert.equal(migratedDefaultModelSettings.settings.defaultReasoning, "high");
assert.equal(migratedDefaultModelSettings.changed, true);

const workspaceResources = normalizeSettingsData({
  settingsVersion: 4,
  workspaceResources: {
    plugins: { "browser-use@openai-bundled": false },
    mcpServers: { paper: true },
    skills: { "/home/demo/.codex/skills/answer/SKILL.md": false }
  }
});
assert.equal(workspaceResources.settings.settingsVersion, 20);
assert.equal(resourceEnabled(workspaceResources.settings.workspaceResources.plugins, "browser-use@openai-bundled", true), false);
assert.equal(resourceEnabled(workspaceResources.settings.workspaceResources.mcpServers, "paper", false), true);
assert.equal(resourceEnabled(workspaceResources.settings.workspaceResources.skills, "missing", true), true);
assert.deepEqual(
  filterEnabledSkills(
    [
      {
        name: "answer",
        description: "Answer questions",
        path: "/home/demo/.codex/skills/answer/SKILL.md",
        scope: "personal",
        enabled: true
      },
      {
        name: "hidden",
        description: "Hidden skill",
        path: "/home/demo/.codex/skills/hidden/SKILL.md",
        scope: "personal",
        enabled: false
      },
      {
        name: "fix-bug",
        description: "Fix bugs",
        path: "/home/demo/.codex/skills/fix-bug/SKILL.md",
        scope: "personal",
        enabled: true
      }
    ],
    workspaceResources.settings.workspaceResources.skills
  ).map((skill) => skill.name),
  ["fix-bug"]
);

const stagedResources = mergeWorkspaceResourceSnapshot(
  emptyWorkspaceResourceSnapshot(),
  "plugins",
  [{ id: "browser-use@openai-bundled", name: "browser-use", displayName: "Browser Use" }],
  null
);
const stagedWithMcp = mergeWorkspaceResourceSnapshot(stagedResources, "mcp", [{ name: "paper", tools: { read: {} } }], null);
assert.equal(stagedWithMcp.plugins.length, 1);
assert.equal(stagedWithMcp.mcpServers.length, 1);
assert.equal(stagedWithMcp.skills.length, 0);
const cachedResources = updateWorkspaceResourceCache(undefined, "mcp", [{ name: "paper", tools: { read: { schema: "large" } } }], null);
assert.equal(loadedTabsFromWorkspaceResourceCache(cachedResources).mcp, true);
assert.equal(snapshotFromWorkspaceResourceCache(cachedResources).mcpServers[0].name, "paper");
assert.deepEqual(Object.keys(snapshotFromWorkspaceResourceCache(cachedResources).mcpServers[0].tools ?? {}), ["read"]);
assert.deepEqual(
  mergeMcpServers(
    [
      { name: "paper", authStatus: "configured", tools: {} },
      { name: "figma", authStatus: "configured", tools: {} }
    ],
    [{ name: "paper", authStatus: "loggedIn", tools: { read: true } }]
  ).map((server) => `${server.name}:${server.authStatus}:${Object.keys(server.tools ?? {}).length}`),
  ["figma:configured:0", "paper:loggedIn:1"]
);
assert.equal(
  normalizeSettingsData({ settingsVersion: 5, workspaceResourceCache: cachedResources }).settings.workspaceResourceCache.mcp?.items[0].name,
  "paper"
);

const knowledgeBaseSettings = normalizeSettingsData({
  settingsVersion: 14,
  agentBackend: "opencode",
  opencode: {
    cliPath: "~/bin/opencode",
    serverUrl: "http://127.0.0.1:4096/",
    autoStart: false,
    hostname: "0.0.0.0",
    port: 5000,
    providerId: "deepseek",
    modelId: "deepseek-reasoner",
    agent: "build",
    textEnabled: true,
    imageEnabled: true,
    pdfEnabled: true,
    lastConnectedAt: 10,
    lastError: "旧错误"
  },
  knowledgeBase: {
    enabled: true,
    backend: "opencode",
    useCustomRulesFile: true,
    rulesFilePath: "CLAUDE.md",
    scheduleEnabled: true,
    scheduleTime: "23:30",
    catchUpOnStartup: false,
    lastRunAt: 20,
    lastRunStatus: "success",
    lastReportPath: "outputs/kb-maintenance.md",
    lastError: "",
    lastSummary: "已维护",
    initialization: {
      status: "initialized",
      initializedAt: 123,
      rulesFilePath: "CLAUDE.md",
      templateVersion: "v0.4",
      lastPreviewSummary: "旧预览"
    },
    processedSources: {
      "raw/demo.md": { size: 12, mtime: 100, digestedAt: 200 }
    }
  }
}).settings;
assert.equal(knowledgeBaseSettings.settingsVersion, 20);
assert.equal(knowledgeBaseSettings.agentBackend, "opencode");
assert.equal(knowledgeBaseSettings.opencode.serverUrl, "http://127.0.0.1:4096/");
assert.equal(knowledgeBaseSettings.opencode.autoStart, false);
assert.equal(knowledgeBaseSettings.opencode.imageEnabled, true);
assert.equal(knowledgeBaseSettings.opencode.pdfEnabled, true);
assert.equal(knowledgeBaseSettings.knowledgeBase.backend, "opencode");
assert.equal(knowledgeBaseSettings.knowledgeBase.useCustomRulesFile, true);
assert.equal(knowledgeBaseSettings.knowledgeBase.rulesFilePath, "CLAUDE.md");
assert.equal(knowledgeBaseSettings.knowledgeBase.scheduleTime, "23:30");
assert.equal(knowledgeBaseSettings.knowledgeBase.catchUpOnStartup, false);
assert.equal(knowledgeBaseSettings.knowledgeBase.processedSources["raw/demo.md"].path, "raw/demo.md");
assert.equal(knowledgeBaseSettings.knowledgeBase.initialization.status, "initialized");
assert.equal(knowledgeBaseSettings.knowledgeBase.initialization.rulesFilePath, "CLAUDE.md");
assert.equal(knowledgeBaseSettings.knowledgeBase.initialization.templateVersion, "v0.4");

const invalidKnowledgeBaseSettings = normalizeSettingsData({
  settingsVersion: 14,
  agentBackend: "bad",
  opencode: { port: 1, textEnabled: false, imageEnabled: "yes", pdfEnabled: "yes" },
  knowledgeBase: { backend: "bad", rulesFilePath: "../bad/path.md", scheduleTime: "25:99", lastRunStatus: "bad" }
}).settings;
assert.equal(invalidKnowledgeBaseSettings.agentBackend, "codex-cli");
assert.equal(invalidKnowledgeBaseSettings.opencode.port, 1024);
assert.equal(invalidKnowledgeBaseSettings.opencode.textEnabled, false);
assert.equal(invalidKnowledgeBaseSettings.opencode.imageEnabled, false);
assert.equal(invalidKnowledgeBaseSettings.opencode.pdfEnabled, false);
assert.equal(invalidKnowledgeBaseSettings.knowledgeBase.backend, "default");
assert.equal(invalidKnowledgeBaseSettings.knowledgeBase.useCustomRulesFile, false);
assert.equal(invalidKnowledgeBaseSettings.knowledgeBase.rulesFilePath, "bad/path.md");
assert.equal(invalidKnowledgeBaseSettings.knowledgeBase.scheduleTime, "09:00");
assert.equal(invalidKnowledgeBaseSettings.knowledgeBase.lastRunStatus, "idle");

const apiProviderSettings = normalizeSettingsData({
  settingsVersion: 5,
  providerMode: "custom-api",
  activeApiProviderId: "provider_demo",
  apiProviders: [
    {
      id: "provider_demo",
      name: "Demo API",
      baseUrl: "https://api.example.com/v1",
      model: "gpt-5.4",
      models: ["gpt-5.4", "gpt-5.5", "gpt-4.1"],
      apiKey: "test-key-demo",
      queryParams: {
        "api-version": "2026-04-28",
        empty: ""
      }
    },
    {
      id: "bad id!",
      name: 42,
      baseUrl: "",
      model: "",
      apiKey: ""
    }
  ]
});
assert.equal(apiProviderSettings.settings.settingsVersion, 20);
assert.equal(apiProviderSettings.settings.providerMode, "custom-api");
assert.equal(apiProviderSettings.settings.settingsTab, "general");
assert.equal(apiProviderSettings.settings.apiProviders.length, 2);
assert.equal(apiProviderSettings.settings.apiProviders[1].id, "provider_2");
assert.deepEqual(apiProviderSettings.settings.apiProviders[0].queryParams, { "api-version": "2026-04-28" });
assert.equal(getActiveApiProvider(apiProviderSettings.settings)?.name, "Demo API");
assert.deepEqual(getApiProviderModels(apiProviderSettings.settings.apiProviders[0]), ["gpt-5.4", "gpt-5.5", "gpt-4.1"]);
assert.equal(providerModelLabel(apiProviderSettings.settings.apiProviders[0]), "gpt-5.4 等 3 个");
assert.equal(providerConnectionLabel(apiProviderSettings.settings), "自定义 API：Demo API · gpt-5.4 等 3 个");
assert.deepEqual(
  ensureModelChoices([], ...getApiProviderModels(apiProviderSettings.settings.apiProviders[0])).map((model) => model.model),
  ["gpt-5.4", "gpt-5.5", "gpt-4.1"]
);

const invalidActiveProviderSettings = normalizeSettingsData({
  settingsVersion: 6,
  providerMode: "custom-api",
  activeApiProviderId: "missing",
  apiProviders: []
});
assert.equal(invalidActiveProviderSettings.settings.providerMode, "codex-login");
assert.equal(invalidActiveProviderSettings.settings.activeApiProviderId, "");
assert.equal(providerConnectionLabel(invalidActiveProviderSettings.settings), "Codex 登录态");

const providerDeleteSettings = normalizeSettingsData({
  settingsVersion: 6,
  providerMode: "custom-api",
  activeApiProviderId: "first",
  apiProviders: [
    { id: "first", name: "First", baseUrl: "https://first.example/v1", model: "gpt-5.4", apiKey: "test-key-first" },
    { id: "second", name: "Second", baseUrl: "https://second.example/v1", model: "gpt-5.4-mini", apiKey: "test-key-second" }
  ]
}).settings;
assert.equal(removeApiProvider(providerDeleteSettings, "first"), true);
assert.equal(providerDeleteSettings.providerMode, "custom-api");
assert.equal(providerDeleteSettings.activeApiProviderId, "second");
assert.equal(removeApiProvider(providerDeleteSettings, "second"), true);
assert.equal(providerDeleteSettings.providerMode, "codex-login");
assert.equal(providerDeleteSettings.activeApiProviderId, "");
assert.deepEqual(validateApiProvider({ name: "", baseUrl: "", model: "", apiKey: "" }), [
  "名称不能为空",
  "Base URL 不能为空",
  "模型不能为空",
  "API key 不能为空"
]);

const editorActionSettings = normalizeSettingsData({
  settingsVersion: 6,
  defaultModel: "gpt-5.5",
  defaultPermission: "workspace-write",
  defaultMode: "plan",
  editorActions: {
    enabled: true,
    defaultStyleId: "missing-style",
    actions: [{ id: "rewrite", label: "改写", enabled: false, promptTemplate: "rewrite {{selected_text}}" }],
    styles: [{ id: "clear", label: "清楚", instruction: "表达清楚。" }]
  }
}).settings;
assert.equal(editorActionSettings.settingsVersion, 20);
assert.equal(editorActionSettings.editorActions.model, DEFAULT_EDITOR_ACTION_MODEL);
assert.equal(editorActionSettings.editorActions.qualityMode, "fast");
assert.equal(editorActionSettings.defaultPermission, "workspace-write");
assert.equal(editorActionSettings.defaultMode, "plan");
assert.equal(enabledEditorActionConfigs(editorActionSettings.editorActions).some((action) => action.id === "rewrite"), false);
assert.equal(enabledEditorActionConfigs(editorActionSettings.editorActions).some((action) => action.id === "translate"), true);
assert.equal(resolveEditorActionStyle(editorActionSettings.editorActions).id, "clear");

const migratedFastEditorActions = normalizeSettingsData({
  settingsVersion: 9,
  editorActions: {
    ...DEFAULT_SETTINGS.editorActions,
    contextCharsBefore: 1200,
    contextCharsAfter: 1200,
    timeoutMs: 90000
  }
}).settings.editorActions;
assert.equal(migratedFastEditorActions.contextCharsBefore, 300);
assert.equal(migratedFastEditorActions.contextCharsAfter, 300);
assert.equal(migratedFastEditorActions.timeoutMs, 45000);
assert.equal(migratedFastEditorActions.qualityMode, "fast");
assert.equal(resolveEditorActionModeConfig(migratedFastEditorActions, "fast").contextCharsBefore, 300);
assert.equal(resolveEditorActionModeConfig(migratedFastEditorActions, "fast").contextCharsAfter, 300);

const migratedStableEditorActions = normalizeSettingsData({
  settingsVersion: 12,
  editorActions: {
    ...DEFAULT_SETTINGS.editorActions,
    timeoutMs: 25000,
    summaryCacheEnabled: true
  }
}).settings.editorActions;
assert.equal(migratedStableEditorActions.timeoutMs, 45000);
assert.equal(migratedStableEditorActions.qualityMode, "fast");

const customFastEditorActions = normalizeSettingsData({
  settingsVersion: 9,
  editorActions: {
    ...DEFAULT_SETTINGS.editorActions,
    contextCharsBefore: 900,
    contextCharsAfter: 800,
    timeoutMs: 45000
  }
}).settings.editorActions;
assert.equal(customFastEditorActions.contextCharsBefore, 900);
assert.equal(customFastEditorActions.contextCharsAfter, 800);
assert.equal(customFastEditorActions.timeoutMs, 45000);
assert.equal(resolveEditorActionModeConfig(customFastEditorActions, "fast").contextCharsBefore, 900);
assert.equal(resolveEditorActionModeConfig(customFastEditorActions, "fast").contextCharsAfter, 800);

assert.equal(validateEditorActionSelection({ selectedText: "", selectionCount: 1, maxSelectedChars: 4000 }).ok, false);
assert.equal(validateEditorActionSelection({ selectedText: "   \n", selectionCount: 1, maxSelectedChars: 4000 }).ok, false);
assert.equal(validateEditorActionSelection({ selectedText: "abc", selectionCount: 2, maxSelectedChars: 4000 }).ok, false);
assert.equal(validateEditorActionSelection({ selectedText: "abcde", selectionCount: 1, maxSelectedChars: 3 }).ok, false);
assert.equal(validateEditorActionSelection({ selectedText: "abc", selectionCount: 1, maxSelectedChars: 4000 }).ok, true);

const selectionSnapshot = buildEditorActionSelectionSnapshot({
  fullText: "0123456789[SELECTED]abcdefghijklmnopqrstuvwxyz",
  fromOffset: 10,
  toOffset: 20,
  contextCharsBefore: 4,
  contextCharsAfter: 5,
  filePath: "folder/demo.md"
});
assert.equal(selectionSnapshot.selectedText, "[SELECTED]");
assert.equal(selectionSnapshot.beforeContext, "6789");
assert.equal(selectionSnapshot.afterContext, "abcde");
assert.equal(selectionSnapshot.fileName, "demo.md");

const rewriteAction = DEFAULT_SETTINGS.editorActions.actions.find((action) => action.id === "rewrite")!;
const rewritePrompt = buildEditorActionPrompt({
  action: rewriteAction,
  style: resolveEditorActionStyle(DEFAULT_SETTINGS.editorActions),
  snapshot: selectionSnapshot
});
assert.ok(rewritePrompt.includes("改写"));
assert.ok(rewritePrompt.includes("[SELECTED]"));
assert.ok(rewritePrompt.includes("demo.md"));
assert.ok(rewritePrompt.includes("只返回最终候选文本"));
assert.ok(rewritePrompt.includes("不要使用代码块包裹"));
assert.ok(rewritePrompt.includes("明显不同"));
assert.ok(rewritePrompt.includes("不要只替换一两个词"));
assert.equal((rewritePrompt.match(/\[SELECTED\]/g) ?? []).length, 1);

const continueAction = DEFAULT_SETTINGS.editorActions.actions.find((action) => action.id === "continue")!;
const continuePrompt = buildEditorActionPrompt({
  action: continueAction,
  style: resolveEditorActionStyle(DEFAULT_SETTINGS.editorActions),
  snapshot: selectionSnapshot
});
assert.ok(continuePrompt.includes("续写"));
assert.ok(continuePrompt.includes("不要重复原文"));
assert.ok(continuePrompt.includes("追加在选中文字后面"));
assert.ok(!continuePrompt.includes("追加或替换"));
assert.ok(continuePrompt.includes("不要擅自修改未选中的内容"));
const translateAction = DEFAULT_SETTINGS.editorActions.actions.find((action) => action.id === "translate")!;
const translatePrompt = buildEditorActionPrompt({
  action: translateAction,
  style: resolveEditorActionStyle(DEFAULT_SETTINGS.editorActions),
  snapshot: selectionSnapshot
});
assert.ok(translatePrompt.includes("翻译成英文"));
assert.ok(translatePrompt.includes("只返回英文译文"));
assert.ok(translatePrompt.includes("保留 Markdown 格式"));
assert.ok(!translatePrompt.includes("写作风格："));
assert.equal((translatePrompt.match(/\[SELECTED\]/g) ?? []).length, 1);
assert.equal(buildEditorActionUserInput(rewritePrompt)[0].type, "text");
const promptWithSummary = buildEditorActionPrompt({
  action: rewriteAction,
  style: resolveEditorActionStyle(DEFAULT_SETTINGS.editorActions),
  snapshot: { ...selectionSnapshot, articleUnderstanding: "主题：老房改造\n关键事实：回老家改造。" },
  qualityMode: "quality",
  modeLabel: "质量"
});
assert.ok(promptWithSummary.includes("当前文章理解"));
assert.ok(promptWithSummary.includes("老房改造"));
assert.ok(promptWithSummary.includes("写作质量：质量"));
const promptWithReusableUnderstanding = buildEditorActionPrompt({
  action: rewriteAction,
  style: resolveEditorActionStyle(DEFAULT_SETTINGS.editorActions),
  snapshot: { ...selectionSnapshot, articleUnderstanding: "主题：老房改造", articleUnderstandingState: "reusable" },
  qualityMode: "quality",
  modeLabel: "质量"
});
assert.ok(promptWithReusableUnderstanding.includes("当前选区和前后文优先"));

const reviewPrompt = buildEditorActionReviewPrompt({
  action: rewriteAction,
  style: resolveEditorActionStyle(DEFAULT_SETTINGS.editorActions),
  snapshot: { ...selectionSnapshot, articleUnderstanding: "主题：老房改造" },
  qualityMode: "strict",
  modeLabel: "严格",
  candidateText: "候选正文"
});
assert.ok(reviewPrompt.includes("审校"));
assert.ok(reviewPrompt.includes("候选正文"));
assert.ok(reviewPrompt.includes("<codex-candidate>"));

const legacyEditorActionSettings = normalizeSettingsData({
  settingsVersion: 7,
  editorActions: {
    ...DEFAULT_SETTINGS.editorActions,
    actions: [
      {
        id: "rewrite",
        label: "改写",
        enabled: true,
        promptTemplate: "请在保持原意的前提下改写选中文字，让表达更清楚、更自然。\n\n选中文字：\n{{selected_text}}\n\n写作风格：{{style}}"
      }
    ],
    styles: [
      { id: "xiaohongshu", label: "小红书", instruction: "表达更有分享感和吸引力，但不要夸张堆词。" }
    ]
  }
}).settings;
const migratedRewrite = legacyEditorActionSettings.editorActions.actions.find((action) => action.id === "rewrite")!;
const migratedXhs = legacyEditorActionSettings.editorActions.styles.find((style) => style.id === "xiaohongshu")!;
assert.equal(legacyEditorActionSettings.settingsVersion, 20);
assert.ok(migratedRewrite.promptTemplate.includes("明显不同"));
assert.ok(migratedRewrite.promptTemplate.includes("不要只替换一两个词"));
assert.ok(migratedXhs.instruction.includes("生活化"));
assert.ok(migratedXhs.instruction.includes("画面感"));

const customPromptSettings = normalizeSettingsData({
  settingsVersion: 7,
  editorActions: {
    ...DEFAULT_SETTINGS.editorActions,
    actions: [{ id: "rewrite", label: "改写", enabled: true, promptTemplate: "我的自定义改写 {{selected_text}}" }]
  }
}).settings;
assert.equal(customPromptSettings.editorActions.actions.find((action) => action.id === "rewrite")?.promptTemplate, "我的自定义改写 {{selected_text}}");

assert.equal(cleanEditorActionOutput("```markdown\n候选正文\n```"), "候选正文");
assert.equal(cleanEditorActionOutput("改写如下：\n候选正文"), "候选正文");
assert.equal(cleanEditorActionOutput("翻译如下：\nTranslated text"), "Translated text");
assert.equal(cleanEditorActionOutput("当然可以，以下是扩写后的内容：\n\n- 保留列表\n- 继续表达"), "- 保留列表\n- 继续表达");
assert.equal(cleanEditorActionOutput("我先确认一下上下文。\n<codex-candidate>\n真正应该写入笔记的正文\n</codex-candidate>"), "真正应该写入笔记的正文");
assert.equal(cleanEditorActionOutput("思考过程：我先分析选区。\n最终输出：\n候选正文"), "候选正文");
assert.equal(validateEditorActionCandidateText("候选正文").ok, true);
assert.equal(validateEditorActionCandidateText("版本一：候选\n版本二：另一个候选").ok, false);
assert.equal(validateEditorActionCandidateText("```markdown\n候选正文\n```").ok, false);

const editorActionTurnOptions = buildEditorActionTurnOptions({
  model: "gpt-5.5",
  serviceTier: "standard",
  timeoutMs: 45000
});
assert.deepEqual(editorActionTurnOptions, {
  model: "gpt-5.5",
  reasoning: "medium",
  serviceTier: "fast",
  permission: "read-only",
  mode: "agent",
  mcpEnabled: false,
  persistExtendedHistory: false,
  requestTimeoutMs: 45000,
  workspaceResources: { plugins: {}, mcpServers: {}, skills: {} }
});
assert.equal(resolveEditorActionModel({ fallbackModel: "gpt-5.5" }), "gpt-5.5");
assert.equal(resolveEditorActionModel({ configuredModel: DEFAULT_EDITOR_ACTION_MODEL, availableModels: ["gpt-5.5", DEFAULT_EDITOR_ACTION_MODEL], fallbackModel: "gpt-5.5" }), DEFAULT_EDITOR_ACTION_MODEL);
assert.equal(resolveEditorActionModel({ configuredModel: DEFAULT_EDITOR_ACTION_MODEL, availableModels: ["gpt-5.4", "gpt-5.5"], fallbackModel: "gpt-5.5" }), "gpt-5.4");
assert.equal(resolveEditorActionModel({ configuredModel: DEFAULT_EDITOR_ACTION_MODEL, availableModels: ["custom-fast", "custom-large"], fallbackModel: "gpt-5.5" }), "custom-fast");
assert.equal(resolveEditorActionModel({ configuredModel: DEFAULT_EDITOR_ACTION_MODEL, availableModels: ["custom-fast"], fallbackModel: "gpt-5.5", preferConfiguredWithoutAvailability: false }), "custom-fast");

assert.equal(editorActionStatusFromResult("success"), "awaiting-confirm");
assert.equal(editorActionStatusFromResult("failed"), "failed");
assert.equal(editorActionStatusFromResult("canceled"), "canceled");
assert.equal(editorActionStatusFromResult("timeout"), "failed");
assert.equal(editorActionStartBlockReason({ running: false }), null);
assert.equal(editorActionStartBlockReason({ running: true }), null);
assert.match(editorActionStartBlockReason({ running: true, activeRunId: "run-1" }) ?? "", /上一轮/);
assert.match(editorActionStartBlockReason({ running: true, activeTurnId: "turn-1" }) ?? "", /上一轮/);
assert.match(editorActionStartBlockReason({ running: true, hasEditorActionRun: true }) ?? "", /上一轮/);
assert.deepEqual(extractEditorActionNotificationIds({
  thread: { id: "thread-hidden" },
  turn: { id: "turn-hidden" },
  item: { id: "item-hidden" }
}), { threadId: "thread-hidden", turnId: "turn-hidden", itemId: "item-hidden" });
assert.equal(isEditorActionHiddenNotification({
  params: { itemId: "item-hidden" },
  threadIds: new Set(["thread-hidden"]),
  turnIds: new Set(["turn-hidden"]),
  itemIds: new Set(["item-hidden"])
}), true);
assert.equal(isEditorActionHiddenNotification({
  params: { turn: { threadId: "thread-hidden" } },
  threadIds: new Set(["thread-hidden"]),
  turnIds: new Set(),
  itemIds: new Set()
}), true);
assert.equal(isEditorActionHiddenNotification({
  params: { item: { turnId: "turn-hidden", id: "later-item" } },
  threadIds: new Set(),
  turnIds: new Set(["turn-hidden"]),
  itemIds: new Set()
}), true);
assert.equal(isEditorActionHiddenNotification({
  params: { itemId: "normal-item" },
  threadIds: new Set(["thread-hidden"]),
  turnIds: new Set(["turn-hidden"]),
  itemIds: new Set(["item-hidden"])
}), false);
assert.equal(isEditorActionCurrentRunNotification({
  params: { itemId: "old-hidden-item" },
  currentThreadId: "thread-hidden",
  currentTurnId: "turn-hidden",
  threadIds: new Set(["thread-hidden"]),
  turnIds: new Set(["turn-hidden"]),
  itemIds: new Set(["old-hidden-item"]),
  currentItemIds: new Set(["item-hidden"])
}), false);
assert.equal(isEditorActionCurrentRunNotification({
  params: { threadId: "thread-hidden", itemId: "old-hidden-item" },
  currentThreadId: "thread-hidden",
  currentTurnId: "turn-hidden",
  threadIds: new Set(["thread-hidden"]),
  turnIds: new Set(["turn-hidden"]),
  itemIds: new Set(["old-hidden-item"]),
  currentItemIds: new Set(["item-hidden"])
}), false);
assert.equal(isEditorActionCurrentRunNotification({
  params: { item: { turnId: "turn-hidden", id: "candidate-item" } },
  currentThreadId: "thread-hidden",
  currentTurnId: "turn-hidden",
  threadIds: new Set(["thread-hidden"]),
  turnIds: new Set(["turn-hidden"]),
  itemIds: new Set(),
  currentItemIds: new Set()
}), true);
assert.equal(isEditorActionCurrentRunNotification({
  params: { itemId: "candidate-item" },
  currentThreadId: "thread-hidden",
  currentTurnId: "turn-hidden",
  threadIds: new Set(["thread-hidden"]),
  turnIds: new Set(["turn-hidden"]),
  itemIds: new Set(["old-hidden-item"]),
  currentItemIds: new Set(["candidate-item"])
}), true);
assert.deepEqual(routeEditorActionNotification({
  method: "item/agentMessage/delta",
  params: { itemId: "candidate-item", delta: "候选" },
  active: true,
  currentThreadId: "thread-current",
  currentTurnId: "turn-current",
  threadIds: new Set(["old-thread"]),
  turnIds: new Set(["turn-current"]),
  itemIds: new Set(["old-item"]),
  currentItemIds: new Set()
}), {
  swallow: true,
  current: true,
  collectAssistantDelta: true,
  rememberCurrentItem: true
});
assert.deepEqual(routeEditorActionNotification({
  method: "item/agentMessage/delta",
  params: { itemId: "old-item", delta: "旧输出" },
  active: true,
  currentThreadId: "thread-current",
  currentTurnId: "turn-current",
  threadIds: new Set(["old-thread"]),
  turnIds: new Set(["old-turn"]),
  itemIds: new Set(["old-item"]),
  currentItemIds: new Set()
}), {
  swallow: true,
  current: false,
  collectAssistantDelta: false,
  rememberCurrentItem: false
});
assert.deepEqual(routeEditorActionNotification({
  method: "item/reasoning/textDelta",
  params: { itemId: "reasoning-item", delta: "过程" },
  active: true,
  currentThreadId: "thread-current",
  currentTurnId: "turn-current",
  threadIds: new Set(),
  turnIds: new Set(),
  itemIds: new Set(),
  currentItemIds: new Set()
}), {
  swallow: true,
  current: false,
  collectAssistantDelta: false,
  rememberCurrentItem: false
});

const summarySource = {
  filePath: "folder/demo.md",
  fileName: "demo.md",
  text: "第一段内容。\n第二段内容。",
  mtime: 100,
  size: 12
};
const summaryEntry = makeEditorActionSummaryCacheEntry(summarySource, "这是一篇测试摘要。", 1000);
let summaryCache = upsertEditorActionSummaryCache({}, summaryEntry, 200);
assert.equal(getFreshEditorActionSummary(summaryCache, summarySource, 1100), "这是一篇测试摘要。");
assert.equal(getFreshEditorActionSummary(summaryCache, { ...summarySource, mtime: 101 }, 1100), null);
assert.equal(getFreshEditorActionSummary(summaryCache, { ...summarySource, text: "正文变化" }, 1100), null);
assert.ok(buildEditorActionSummaryPrompt(summarySource).includes("只返回摘要正文"));
assert.equal(summaryEntry.contentHash, editorActionContentHash(summarySource.text));
for (let index = 0; index < 205; index++) {
  summaryCache = upsertEditorActionSummaryCache(summaryCache, makeEditorActionSummaryCacheEntry({
    filePath: `note-${index}.md`,
    fileName: `note-${index}.md`,
    text: `内容 ${index}`,
    mtime: index,
    size: index
  }, `摘要 ${index}`, 2000 + index), 200);
}
assert.equal(Object.keys(summaryCache).length, 200);
assert.equal(summaryCache["folder/demo.md"], undefined);

const articleEntry = makeArticleUnderstandingCacheEntry(summarySource, "主题：测试文章\n关键事实：第二段内容。", "quality", "gpt-5.4", 3000);
let articleCache = upsertArticleUnderstandingCache({}, articleEntry, 200);
assert.equal(getFreshArticleUnderstanding(articleCache, summarySource, "quality", "gpt-5.4", 3100)?.understanding, "主题：测试文章\n关键事实：第二段内容。");
assert.equal(getFreshArticleUnderstanding(articleCache, { ...summarySource, mtime: 101 }, "quality", "gpt-5.4", 3100), null);
assert.equal(getFreshArticleUnderstanding(articleCache, summarySource, "strict", "gpt-5.4", 3100), null);
assert.equal(getFreshArticleUnderstanding(articleCache, summarySource, "quality", "gpt-5.5", 3100), null);
assert.equal(resolveArticleUnderstandingCache(articleCache, summarySource, "quality", "gpt-5.4", 3100).state, "fresh");
assert.equal(resolveArticleUnderstandingCache(articleCache, { ...summarySource, text: `${summarySource.text}\n续写一点内容。`, mtime: 101, size: 20 }, "quality", "gpt-5.4", 3100).state, "reusable");
assert.equal(resolveArticleUnderstandingCache(articleCache, summarySource, "strict", "gpt-5.4", 3100).state, "stale");
assert.equal(resolveArticleUnderstandingCache(articleCache, summarySource, "quality", "gpt-5.5", 3100).state, "stale");
const oldFingerprintlessEntry = { ...articleEntry, fingerprint: undefined };
assert.equal(resolveArticleUnderstandingCache({ [oldFingerprintlessEntry.filePath]: oldFingerprintlessEntry }, { ...summarySource, text: `${summarySource.text}\n续写一点内容。`, mtime: 101, size: 20 }, "quality", "gpt-5.4", 3100).state, "stale");
const articleSource = {
  filePath: "folder/article.md",
  fileName: "article.md",
  text: "# 老房改造\n\n第一段记录老房改造的缘起和宅家空间变化。\n\n第二段描述光线、家具和动线的调整。",
  mtime: 200,
  size: 52
};
const articleUnderstandingEntry = makeArticleUnderstandingCacheEntry(articleSource, "主题：老房改造", "quality", "gpt-5.4", 5000);
const articleUnderstandingCache = { [articleSource.filePath]: articleUnderstandingEntry };
assert.ok(articleUnderstandingEntry.fingerprint);
assert.deepEqual(makeArticleUnderstandingFingerprint(articleSource.text).titleHash, articleUnderstandingEntry.fingerprint?.titleHash);
assert.equal(resolveArticleUnderstandingCache(articleUnderstandingCache, { ...articleSource, text: `${articleSource.text}\n\n第三段补充一点使用感受。`, mtime: 201, size: 70 }, "quality", "gpt-5.4", 5100).state, "reusable");
assert.equal(resolveArticleUnderstandingCache(articleUnderstandingCache, { ...articleSource, text: "# 完全不同主题\n\n这篇文章改成了旅行攻略、签证材料、酒店预订和行程安排。".repeat(160), mtime: 202, size: 9000 }, "quality", "gpt-5.4", 5100).state, "stale");
assert.equal(resolveArticleUnderstandingCache(articleUnderstandingCache, { ...articleSource, text: `${articleSource.text}\n\n轻微补充。`, mtime: 203, size: 60 }, "quality", "gpt-5.4", 5000 + 8 * 24 * 60 * 60 * 1000).state, "stale");
assert.ok(buildArticleUnderstandingPrompt(summarySource).includes("文章理解"));
assert.ok(buildArticleUnderstandingPrompt(summarySource).includes("禁止编造"));
for (let index = 0; index < 205; index++) {
  articleCache = upsertArticleUnderstandingCache(articleCache, makeArticleUnderstandingCacheEntry({
    filePath: `article-${index}.md`,
    fileName: `article-${index}.md`,
    text: `正文 ${index}`,
    mtime: index,
    size: index
  }, `主题：${index}`, "quality", "gpt-5.4", 4000 + index), 200);
}
assert.equal(Object.keys(articleCache).length, 200);
assert.equal(articleCache["folder/demo.md"], undefined);

const candidate = {
  id: "candidate-1",
  actionId: "rewrite",
  filePath: "demo.md",
  fromOffset: 6,
  toOffset: 11,
  originalText: "world",
  candidateText: "Obsidian",
  documentLength: 11,
  createdAt: 1
};
const confirmedCandidate = confirmEditorActionCandidate("hello world", candidate);
assert.equal(confirmedCandidate.ok, true);
assert.equal(confirmedCandidate.ok ? confirmedCandidate.text : "", "hello Obsidian");
assert.deepEqual(editorActionCandidateReplacementRange(candidate), { fromOffset: 6, toOffset: 11 });
const continueCandidate = { ...candidate, id: "candidate-2", actionId: "continue", candidateText: " again" };
const confirmedContinueCandidate = confirmEditorActionCandidate("hello world", continueCandidate);
assert.equal(confirmedContinueCandidate.ok, true);
assert.equal(confirmedContinueCandidate.ok ? confirmedContinueCandidate.text : "", "hello world again");
assert.deepEqual(editorActionCandidateReplacementRange(continueCandidate), { fromOffset: 11, toOffset: 11 });
const translateCandidate = { ...candidate, id: "candidate-3", actionId: "translate", candidateText: "world" };
const confirmedTranslateCandidate = confirmEditorActionCandidate("hello world", translateCandidate);
assert.equal(confirmedTranslateCandidate.ok, true);
assert.equal(confirmedTranslateCandidate.ok ? confirmedTranslateCandidate.text : "", "hello world");
assert.deepEqual(editorActionCandidateReplacementRange(translateCandidate), { fromOffset: 6, toOffset: 11 });
const conflictedCandidate = confirmEditorActionCandidate("hello there", candidate);
assert.equal(conflictedCandidate.ok, false);
assert.match(conflictedCandidate.ok ? "" : conflictedCandidate.reason, /原文已变化/);
assert.equal(editorActionCandidateInvalidationReason("hello world", candidate), null);
assert.equal(editorActionCandidateInvalidationReason("hello world!", candidate), "document-changed");
assert.equal(editorActionCandidateInvalidationReason("hello there", candidate), "original-text-changed");

const customLaunch = buildCodexLaunchConfig({
  proxyEnabled: false,
  proxyUrl: "",
  providerMode: "custom-api",
  activeApiProvider: {
    id: "provider_demo",
    name: "Demo API",
    baseUrl: "https://api.example.com/v1",
    model: "gpt-5.4",
    models: ["gpt-5.4", "gpt-5.5"],
    apiKey: "test-key-value",
    queryParams: { "api-version": "2026-04-28" }
  }
});
assert.deepEqual(customLaunch.args.slice(0, 3), ["app-server", "--listen", "stdio://"]);
assert.ok(customLaunch.args.includes('model_provider="provider_demo"'));
assert.ok(customLaunch.args.includes('model="gpt-5.4"'));
assert.ok(customLaunch.args.includes('model_providers.provider_demo.base_url="https://api.example.com/v1"'));
assert.ok(customLaunch.args.includes('model_providers.provider_demo.wire_api="responses"'));
assert.ok(customLaunch.args.includes('model_providers.provider_demo.env_key="OBSIDIAN_CODEX_API_KEY_PROVIDER_DEMO"'));
assert.ok(customLaunch.args.includes('model_providers.provider_demo.query_params.api-version="2026-04-28"'));
assert.equal(customLaunch.args.join(" ").includes("test-key-value"), false);
assert.equal(customLaunch.env.OBSIDIAN_CODEX_API_KEY_PROVIDER_DEMO, "test-key-value");

const loginLaunch = buildCodexLaunchConfig({
  proxyEnabled: false,
  proxyUrl: "",
  providerMode: "codex-login",
  activeApiProvider: {
    id: "provider_demo",
    name: "Demo API",
    baseUrl: "https://api.example.com/v1",
    model: "gpt-5.4",
    models: ["gpt-5.4"],
    apiKey: "test-key-value"
  }
});
assert.deepEqual(loginLaunch.args, ["app-server", "--listen", "stdio://"]);
assert.throws(
  () => resolveCodexCommand("/definitely/missing/codex"),
  /找不到 Codex CLI/
);

const codexAppCommand = "/Applications/Codex.app/Contents/Resources/codex";
assert.equal(resolveCodexCommand("", {
  home: "/Users/demo",
  envPath: "",
  exists: (candidate) => candidate === codexAppCommand
}), codexAppCommand);
assert.equal(resolveCodexCommand("~/bin/codex", {
  home: "/Users/demo",
  envPath: "",
  exists: (candidate) => candidate === "/Users/demo/bin/codex"
}), "/Users/demo/bin/codex");
assert.equal(resolveCodexCommand("", {
  home: "/Users/demo",
  envPath: "/custom/bin",
  exists: (candidate) => candidate === "/custom/bin/codex"
}), "/custom/bin/codex");

assert.equal(detectOpenCodeCommand("~/bin/opencode", {
  home: "/Users/demo",
  envPath: "",
  exists: (candidate) => candidate === "/Users/demo/bin/opencode"
}), "/Users/demo/bin/opencode");
assert.equal(detectOpenCodeCommand("", {
  home: "/Users/demo",
  envPath: "/custom/bin",
  exists: (candidate) => candidate === "/custom/bin/opencode"
}), "/custom/bin/opencode");
assert.throws(() => resolveOpenCodeCommand("/definitely/missing/opencode", {
  exists: () => false
}), /找不到 OpenCode CLI/);
assert.equal(mimeForKnowledgeFile("/vault/raw/a.md"), "text/markdown");
assert.equal(mimeForKnowledgeFile("/vault/raw/a.pdf"), "application/pdf");
assert.equal(mimeForKnowledgeFile("/vault/raw/a.docx"), "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
assert.equal(mimeForKnowledgeFile("/vault/raw/a.png"), "image/png");
assert.equal(requiredModalityForMime("image/png"), "image");
assert.equal(requiredModalityForMime("application/pdf"), "pdf");
assert.equal(requiredModalityForMime("text/markdown"), "text");

const openCodeProviders = [
  {
    id: "deepseek",
    name: "DeepSeek",
    models: {
      "deepseek-chat": {
        id: "deepseek-chat",
        name: "DeepSeek Chat",
        capabilities: { input: { text: true, image: false, pdf: false } }
      },
      "vision-pdf": {
        id: "vision-pdf",
        name: "Vision PDF",
        capabilities: { input: { text: true, image: true, pdf: true } }
      }
    }
  },
  {
    id: "openai",
    name: "OpenAI",
    models: {
      "gpt-vision": {
        id: "gpt-vision",
        name: "GPT Vision",
        capabilities: { input: { text: true, image: true, pdf: false } }
      }
    }
  }
] as any;
const flattenedOpenCodeModels = flattenOpenCodeModels(openCodeProviders);
assert.deepEqual(flattenedOpenCodeModels.map((model) => model.id), ["deepseek/deepseek-chat", "deepseek/vision-pdf", "openai/gpt-vision"]);
assert.deepEqual(flattenedOpenCodeModels.find((model) => model.id === "deepseek/vision-pdf")?.inputModalities, ["text", "image", "pdf"]);
const flattenedOpenCodeAgents = flattenOpenCodeAgents([
  { name: "reviewer", mode: "subagent", permission: {}, options: {} },
  { name: "build", mode: "primary", native: true, permission: {}, options: {} },
  { name: "general", mode: "all", permission: {}, options: {} },
  { name: "hidden", mode: "primary", hidden: true, permission: {}, options: {} }
] as any);
assert.deepEqual(flattenedOpenCodeAgents.map((agent) => agent.name), ["build", "general"]);
assert.deepEqual(modelInputModalities({ capabilities: { input: { text: true, image: false, pdf: true } } } as any), ["text", "pdf"]);
assert.doesNotThrow(() => ensureOpenCodeModelSupportsFiles(flattenedOpenCodeModels[1], [
  { type: "file", path: "/vault/raw/a.pdf", mime: "application/pdf" }
]));
assert.throws(() => ensureOpenCodeModelSupportsFiles(flattenedOpenCodeModels[0], [
  { type: "file", path: "/vault/raw/a.png", mime: "image/png" }
]), /不支持 image 输入/);

const modelChoices = ensureModelChoices([{ id: "gpt-5.4", model: "gpt-5.4", displayName: "GPT-5.4" }], "gpt-5.5");
assert.deepEqual(
  modelChoices.map((item) => item.model),
  ["gpt-5.5", "gpt-5.4"]
);

const rateLimitResponse = normalizeRateLimitResponse({
  rateLimitsByLimitId: {
    codex: {
      limitId: "codex",
      primary: { usedPercent: 18, windowDurationMins: 300, resetsAt: 1777229369 },
      secondary: { usedPercent: 9, windowDurationMins: 10080, resetsAt: 1777424482 }
    }
  }
});
assert.equal(rateLimitResponse.rateLimits?.primary?.usedPercent, 18);
const usage = formatRateLimitUsage(rateLimitResponse.rateLimits);
assert.equal(usage.summary, "用量 82%");
assert.equal(usage.primary?.label, "5小时");
assert.equal(usage.primary?.remainingPercent, 82);
assert.equal(usage.secondary?.label, "1周");
assert.equal(usage.secondary?.remainingPercent, 91);

const fallbackRateLimitResponse = normalizeRateLimitResponse({
  rateLimitsByLimitId: {
    codex: {
      limitId: "codex",
      primary: null,
      secondary: null
    },
    codex_spark: {
      limitId: "codex_spark",
      primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1777229369 },
      secondary: { usedPercent: 4, windowDurationMins: 10080, resetsAt: 1777424482 }
    }
  }
});
assert.equal(fallbackRateLimitResponse.rateLimits?.limitId, "codex_spark");
assert.equal(formatRateLimitUsage(fallbackRateLimitResponse.rateLimits).summary, "用量 88%");

const staleMessages = [
  { id: "m1", role: "assistant", text: "正在组织回复...", itemType: "thinking", status: "running", createdAt: 1 },
  { id: "m2", role: "tool", text: "", itemType: "commandExecution", status: "running", createdAt: 2 },
  { id: "m3", role: "tool", text: "rg -n foo docs", itemType: "commandExecution", status: "running", createdAt: 3 },
  { id: "m4", role: "assistant", text: "完成，思考了 2 秒", itemType: "thinking", status: "completed", createdAt: 4 }
] as any;
assert.equal(settleStaleRunningMessages(staleMessages), 3);
assert.equal(staleMessages.length, 2);
assert.equal(staleMessages[0].status, "interrupted");
assert.equal(staleMessages[0].text, "rg -n foo docs");
assert.equal(staleMessages[1].status, "completed");

const kbVault = await mkdtemp(path.join(tmpdir(), "codex-kb-"));
try {
  await mkdir(path.join(kbVault, "raw", "articles"), { recursive: true });
  await mkdir(path.join(kbVault, "raw", "articles", "demo.assets"), { recursive: true });
  await mkdir(path.join(kbVault, "raw", "attachments"), { recursive: true });
  await writeFile(path.join(kbVault, "raw", "articles", "demo.md"), "# Demo\n\n正文", "utf8");
  await writeFile(path.join(kbVault, "raw", "articles", "demo.assets", "image.png"), Buffer.from([1, 2, 3]));
  await writeFile(path.join(kbVault, "raw", "attachments", "image.png"), Buffer.from([1, 2, 3]));
  await writeFile(path.join(kbVault, "raw", "attachments", "paper.pdf"), Buffer.from("%PDF-1.7"));
  await writeFile(path.join(kbVault, "raw", "attachments", "doc.docx"), Buffer.from("PK"));
  await writeFile(path.join(kbVault, "raw", "index.md"), "# Raw Index\n", "utf8");
  await writeFile(path.join(kbVault, "raw", "ignore.csv"), "a,b", "utf8");
  await writeFile(path.join(kbVault, "raw", "articles", "demo.base.md"), "# Base\n", "utf8");
  const firstDiscovery = await discoverKnowledgeBaseSources(kbVault, {});
  assert.deepEqual(firstDiscovery.sources.map((source) => source.relativePath).sort(), [
    "raw/articles/demo.md",
    "raw/attachments/doc.docx",
    "raw/attachments/image.png",
    "raw/attachments/paper.pdf"
  ]);
  assert.equal(firstDiscovery.changedSources.length, 4);
  assert.equal(firstDiscovery.sources.find((source) => source.relativePath.endsWith("image.png"))?.modality, "image");
  assert.equal(firstDiscovery.sources.find((source) => source.relativePath.endsWith("paper.pdf"))?.modality, "pdf");
  const demoSource = firstDiscovery.sources.find((source) => source.relativePath === "raw/articles/demo.md")!;
  const secondDiscovery = await discoverKnowledgeBaseSources(kbVault, {
    [demoSource.relativePath]: { size: demoSource.size, mtime: demoSource.mtime }
  });
  assert.equal(secondDiscovery.sources.find((source) => source.relativePath === "raw/articles/demo.md")?.changed, false);
  assert.equal(secondDiscovery.changedSources.length, 3);
  assert.ok(secondDiscovery.reportPath.startsWith("outputs/kb-maintenance-"));
  await mkdir(path.join(kbVault, "outputs"), { recursive: true });
  await writeFile(path.join(kbVault, "outputs", ".ingest-tracker.md"), [
    "# Ingest Tracker",
    "",
    "## raw/articles/ — 共 1 个文件",
    "- demo.md"
  ].join("\n"), "utf8");
  const trackerDiscovery = await discoverKnowledgeBaseSources(kbVault, {});
  assert.equal(trackerDiscovery.sources.find((source) => source.relativePath === "raw/articles/demo.md")?.changed, false);

  const kbPrompt = buildKnowledgeBasePrompt({
    vaultPath: kbVault,
    mode: "maintain",
    reportPath: secondDiscovery.reportPath,
    sources: secondDiscovery.changedSources,
    rulesFilePath: "CLAUDE.md",
    rulesFileExists: true,
    useCustomRulesFile: true,
    hasRawIndex: true,
    hasWikiIndex: true,
    hasTracker: false
  });
  assert.ok(kbPrompt.includes("执行 Ingest + Lint"));
  assert.ok(kbPrompt.includes("自定义规则文件：CLAUDE.md"));
  assert.ok(kbPrompt.includes("不读取、不合并 AGENTS.md"));
  assert.ok(kbPrompt.includes("CLAUDE.md: 存在，必须读取"));
  assert.ok(kbPrompt.includes("raw/attachments/image.png"));
  assert.ok(kbPrompt.includes("raw/index.md"));
  assert.ok(kbPrompt.includes("禁止修改 raw/ 中的原始资料正文"));
  assert.ok(kbPrompt.includes("raw/index.md 只允许做索引更新"));
  assert.ok(kbPrompt.includes("find"));
  assert.ok(kbPrompt.includes("跳过 raw/ 中以 .base 结尾"));
  assert.ok(kbPrompt.includes("3-5 句核心要点"));
  assert.ok(kbPrompt.includes("断链、孤儿页面、过时或 draft"));
  assert.ok(kbPrompt.includes(secondDiscovery.reportPath));
  const outputsPrompt = buildKnowledgeBasePrompt({
    vaultPath: kbVault,
    mode: "outputs",
    userRequest: "/outputs 只提炼长期方法论",
    reportPath: secondDiscovery.reportPath,
    sources: [],
    rulesFilePath: "AGENTS.md",
    rulesFileExists: true,
    useCustomRulesFile: false,
    hasRawIndex: true,
    hasWikiIndex: true,
    hasTracker: false
  });
  assert.ok(outputsPrompt.includes("处理 outputs"));
  assert.ok(outputsPrompt.includes("长期复用价值"));
  assert.ok(outputsPrompt.includes("用户原始指令：/outputs 只提炼长期方法论"));
  await writeFile(path.join(kbVault, secondDiscovery.reportPath), "---\nmode: lint-only\n---\n# 体检报告\n\n这是一份已经生成的报告。", "utf8");
  const reportExcerpt = await readKnowledgeBaseReportExcerpt(kbVault, secondDiscovery.reportPath);
  assert.equal(reportExcerpt, "---\nmode: lint-only\n---\n# 体检报告\n\n这是一份已经生成的报告。");
  assert.equal(isLintOnlyKnowledgeBaseReport(reportExcerpt!), true);
  assert.equal(isLintOnlyKnowledgeBaseReport("# 维护报告\n\n执行 Ingest + Lint"), false);
  const recoveredSummary = recoveredLintReportSummary(secondDiscovery.reportPath);
  assert.ok(recoveredSummary.includes(secondDiscovery.reportPath));
  assert.ok(!recoveredSummary.includes("created:"));
  assert.ok(!recoveredSummary.includes("# 体检报告"));
  assert.equal(await readKnowledgeBaseReportExcerpt(kbVault, "outputs/missing.md"), null);
} finally {
  await rm(kbVault, { recursive: true, force: true });
}

const initVault = await mkdtemp(path.join(tmpdir(), "codex-kb-init-"));
try {
  await writeFile(path.join(initVault, "old-note.md"), "# Old note\n\n项目资料", "utf8");
  const preview = await buildKnowledgeBaseInitializationPreview(initVault);
  assert.equal(preview.status, "preview-ready");
  assert.equal(preview.rulesFilePath, "AGENTS.md");
  assert.ok(preview.summary.includes("将生成规则文件：AGENTS.md"));
  assert.ok(preview.directories.includes("raw/articles"));
  assert.ok(preview.directories.includes("wiki/ai-intelligence"));
  assert.ok(preview.suggestions.some((item) => item.path === "old-note.md" && item.target === "projects"));
  assert.equal(await fileExists(path.join(initVault, "AGENTS.md")), false);

  const result = await executeKnowledgeBaseInitialization(initVault, preview, new Date("2026-05-15T08:00:00.000Z"));
  assert.equal(result.rulesFilePath, "AGENTS.md");
  assert.equal(await fileExists(path.join(initVault, "raw", "articles")), true);
  assert.equal(await fileExists(path.join(initVault, "wiki", "index.md")), true);
  assert.equal(await fileExists(path.join(initVault, "outputs", ".ingest-tracker.md")), true);
  assert.ok((await readFile(path.join(initVault, "AGENTS.md"), "utf8")).includes("LLM Wiki"));
  assert.ok((await readFile(path.join(initVault, "wiki", "index.md"), "utf8")).includes("AI 与智能体"));
  assert.ok((await readFile(path.join(initVault, "raw", "index.md"), "utf8")).includes("不可变"));
} finally {
  await rm(initVault, { recursive: true, force: true });
}

const initVaultWithAgents = await mkdtemp(path.join(tmpdir(), "codex-kb-init-agents-"));
try {
  await writeFile(path.join(initVaultWithAgents, "AGENTS.md"), "# Existing agents\n", "utf8");
  const preview = await buildKnowledgeBaseInitializationPreview(initVaultWithAgents);
  assert.equal(preview.rulesFilePath, "CLAUDE.md");
  await executeKnowledgeBaseInitialization(initVaultWithAgents, preview, new Date("2026-05-15T08:00:00.000Z"));
  assert.ok((await readFile(path.join(initVaultWithAgents, "AGENTS.md"), "utf8")).includes("Existing agents"));
  assert.ok((await readFile(path.join(initVaultWithAgents, "CLAUDE.md"), "utf8")).includes("LLM Wiki"));
} finally {
  await rm(initVaultWithAgents, { recursive: true, force: true });
}

const initVaultWithBothRules = await mkdtemp(path.join(tmpdir(), "codex-kb-init-both-"));
try {
  await writeFile(path.join(initVaultWithBothRules, "AGENTS.md"), "# Existing agents\n", "utf8");
  await writeFile(path.join(initVaultWithBothRules, "CLAUDE.md"), "# Existing claude\n", "utf8");
  const preview = await buildKnowledgeBaseInitializationPreview(initVaultWithBothRules);
  assert.equal(preview.rulesFilePath, "CLAUDE.kb-template.md");
  await executeKnowledgeBaseInitialization(initVaultWithBothRules, preview, new Date("2026-05-15T08:00:00.000Z"));
  assert.ok((await readFile(path.join(initVaultWithBothRules, "CLAUDE.md"), "utf8")).includes("Existing claude"));
  assert.ok((await readFile(path.join(initVaultWithBothRules, "CLAUDE.kb-template.md"), "utf8")).includes("LLM Wiki"));
} finally {
  await rm(initVaultWithBothRules, { recursive: true, force: true });
}

const rulesRepairVault = await mkdtemp(path.join(tmpdir(), "codex-kb-rules-repair-"));
try {
  const created = await repairKnowledgeBaseRulesFile(rulesRepairVault, {
    useCustomRulesFile: false,
    rulesFilePath: "AGENTS.md"
  }, new Date("2026-05-15T08:00:00.000Z"));
  assert.equal(created.status, "created");
  assert.equal(created.rulesFilePath, "AGENTS.md");
  const createdRules = await readFile(path.join(rulesRepairVault, "AGENTS.md"), "utf8");
  assert.ok(createdRules.includes("LLM Wiki"));
  assert.ok(createdRules.includes("outputs/.ingest-tracker.md"));
  assert.ok(createdRules.includes("禁止改写 `raw/` 原文"));

  const ok = await repairKnowledgeBaseRulesFile(rulesRepairVault, {
    useCustomRulesFile: false,
    rulesFilePath: "AGENTS.md"
  }, new Date("2026-05-15T08:00:00.000Z"));
  assert.equal(ok.status, "ok");
  assert.equal(await readFile(path.join(rulesRepairVault, "AGENTS.md"), "utf8"), createdRules);
} finally {
  await rm(rulesRepairVault, { recursive: true, force: true });
}

const customRulesRepairVault = await mkdtemp(path.join(tmpdir(), "codex-kb-custom-rules-repair-"));
try {
  const customCreated = await repairKnowledgeBaseRulesFile(customRulesRepairVault, {
    useCustomRulesFile: true,
    rulesFilePath: "CLAUDE.md"
  }, new Date("2026-05-15T08:00:00.000Z"));
  assert.equal(customCreated.status, "created");
  assert.equal(customCreated.rulesFilePath, "CLAUDE.md");
  assert.equal(await fileExists(path.join(customRulesRepairVault, "AGENTS.md")), false);
  assert.ok((await readFile(path.join(customRulesRepairVault, "CLAUDE.md"), "utf8")).includes("LLM Wiki"));
} finally {
  await rm(customRulesRepairVault, { recursive: true, force: true });
}

const patchRulesRepairVault = await mkdtemp(path.join(tmpdir(), "codex-kb-patch-rules-repair-"));
try {
  await writeFile(path.join(patchRulesRepairVault, "CLAUDE.md"), "# Existing rules\n\n只写团队协作偏好。", "utf8");
  const patched = await repairKnowledgeBaseRulesFile(patchRulesRepairVault, {
    useCustomRulesFile: true,
    rulesFilePath: "CLAUDE.md"
  }, new Date("2026-05-15T08:00:00.000Z"));
  assert.equal(patched.status, "patched");
  assert.ok(patched.missingRules.includes("raw/ 只读边界"));
  const patchedRules = await readFile(path.join(patchRulesRepairVault, "CLAUDE.md"), "utf8");
  assert.ok(patchedRules.startsWith("# Existing rules"));
  assert.ok(patchedRules.includes("obsidian-codex-kb-minimum-rules:start"));
  assert.ok(patchedRules.includes("`raw/` 是不可变原始资料区，只读"));
  assert.ok(patchedRules.includes("把维护报告写入 `outputs/`"));
} finally {
  await rm(patchRulesRepairVault, { recursive: true, force: true });
}

function daysAgoDateForTest(daysAgo: number): Date {
  const date = new Date();
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() - daysAgo);
  return date;
}

function formatDateKeyForTest(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

const dashboardVault = await mkdtemp(path.join(tmpdir(), "codex-kb-dashboard-"));
try {
  await mkdir(path.join(dashboardVault, "raw", "articles"), { recursive: true });
  await mkdir(path.join(dashboardVault, "wiki", "ai-intelligence"), { recursive: true });
  await mkdir(path.join(dashboardVault, "wiki", "content"), { recursive: true });
  await mkdir(path.join(dashboardVault, "outputs"), { recursive: true });
  await mkdir(path.join(dashboardVault, "inbox"), { recursive: true });
  await writeFile(path.join(dashboardVault, "AGENTS.md"), "# Rules\n", "utf8");
  await writeFile(path.join(dashboardVault, "raw", "index.md"), "# Raw\n", "utf8");
  await writeFile(path.join(dashboardVault, "raw", "articles", "old.md"), "# Old\n", "utf8");
  await writeFile(path.join(dashboardVault, "raw", "articles", "new.md"), "# New\n", "utf8");
  await writeFile(path.join(dashboardVault, "wiki", "index.md"), "# Wiki\n", "utf8");
  await writeFile(path.join(dashboardVault, "wiki", "ai-intelligence", "00-索引.md"), "# AI\n", "utf8");
  await writeFile(path.join(dashboardVault, "wiki", "ai-intelligence", "today.md"), "# Today\n", "utf8");
  await writeFile(path.join(dashboardVault, "wiki", "content", "old.md"), "# Content\n", "utf8");
  await writeFile(path.join(dashboardVault, "outputs", ".ingest-tracker.md"), "# Tracker\n", "utf8");
  await writeFile(path.join(dashboardVault, "outputs", "kb-maintenance-2026-05-15.md"), "# Report\n", "utf8");
  await writeFile(path.join(dashboardVault, "inbox", "idea.md"), "# Idea\n", "utf8");
  await writeFile(path.join(dashboardVault, "inbox", "old.md"), "# Old idea\n", "utf8");
  const today = daysAgoDateForTest(0);
  const yesterday = daysAgoDateForTest(1);
  const twoDaysAgo = daysAgoDateForTest(2);
  const threeDaysAgo = daysAgoDateForTest(3);
  const oldPath = path.join(dashboardVault, "raw", "articles", "old.md");
  await utimes(oldPath, threeDaysAgo, threeDaysAgo);
  await utimes(path.join(dashboardVault, "wiki", "ai-intelligence", "00-索引.md"), threeDaysAgo, threeDaysAgo);
  await utimes(path.join(dashboardVault, "wiki", "content", "old.md"), threeDaysAgo, threeDaysAgo);
  await utimes(path.join(dashboardVault, "inbox", "old.md"), threeDaysAgo, threeDaysAgo);
  const oldStat = await stat(oldPath);
  const dashboardSettings = normalizeSettingsData({
    settingsVersion: 19,
    knowledgeBase: {
      rulesFilePath: "AGENTS.md",
      lastRunStatus: "success",
      lastRunAt: 123,
      lastReportPath: "outputs/kb-maintenance-2026-05-15.md",
      healthHistory: [
        { date: formatDateKeyForTest(twoDaysAgo), status: "failed", at: twoDaysAgo.getTime() },
        { date: formatDateKeyForTest(yesterday), status: "success", at: yesterday.getTime() },
        { date: formatDateKeyForTest(today), status: "success", at: today.getTime() }
      ],
      processedSources: {
        "raw/articles/old.md": { size: oldStat.size, mtime: oldStat.mtimeMs, digestedAt: 100 }
      }
    }
  }).settings.knowledgeBase;
  const dashboard = await buildKnowledgeBaseDashboardSnapshot(dashboardVault, dashboardSettings);
  assert.equal(dashboard.rulesFileExists, true);
  assert.equal(dashboard.tracker.exists, true);
  assert.equal(dashboard.lastRun.reportExists, true);
  assert.equal(dashboard.raw.changedCount, 1);
  assert.equal(dashboard.raw.todayCount, 1);
  assert.equal(dashboard.wiki.indexExists, true);
  assert.equal(dashboard.wiki.domainCount, 2);
  assert.deepEqual(dashboard.wiki.groups.map((group) => [group.path, group.totalCount, group.todayCount]), [
    ["wiki/ai-intelligence", 2, 1],
    ["wiki/content", 1, 0]
  ]);
  assert.equal(dashboard.outputs.latestReportPath, "outputs/kb-maintenance-2026-05-15.md");
  assert.equal(dashboard.inbox.fileCount, 2);
  assert.equal(dashboard.inbox.todayCount, 1);
  assert.equal(dashboard.health.status, "healthy");
  assert.equal(dashboard.health.label, "健康");
  assert.equal(dashboard.health.streakDays, 2);
  assert.equal(dashboard.health.lastCheckAt, today.getTime());
  assert.equal(dashboard.checkHeatmap.at(-1)?.status, "success");
  assert.equal(dashboard.checkHeatmap.length, 14);

  const riskSettings = normalizeSettingsData({
    settingsVersion: 19,
    knowledgeBase: {
      rulesFilePath: "AGENTS.md",
      healthHistory: [
        { date: formatDateKeyForTest(threeDaysAgo), status: "success", at: threeDaysAgo.getTime() }
      ],
      processedSources: {
        "raw/articles/old.md": { size: oldStat.size, mtime: oldStat.mtimeMs, digestedAt: 100 }
      }
    }
  }).settings.knowledgeBase;
  const riskDashboard = await buildKnowledgeBaseDashboardSnapshot(dashboardVault, riskSettings);
  assert.notEqual(riskDashboard.health.status, "bad");
  assert.ok(!riskDashboard.health.reasons.some((reason) => reason.includes("3 天未体检")));

  const missingRulesSettings = normalizeSettingsData({
    settingsVersion: 19,
    knowledgeBase: {
      useCustomRulesFile: true,
      rulesFilePath: "missing.md",
      healthHistory: [
        { date: formatDateKeyForTest(today), status: "success", at: today.getTime() }
      ]
    }
  }).settings.knowledgeBase;
  const missingRulesDashboard = await buildKnowledgeBaseDashboardSnapshot(dashboardVault, missingRulesSettings);
  assert.equal(missingRulesDashboard.health.status, "bad");
  assert.equal(missingRulesDashboard.health.label, "需处理");
  assert.ok(missingRulesDashboard.health.reasons.includes("规则文件缺失"));

  const legacyDashboard = await buildKnowledgeBaseDashboardSnapshot(dashboardVault, normalizeSettingsData({ settingsVersion: 19 }).settings.knowledgeBase);
  assert.notEqual(legacyDashboard.health.status, "bad");
  assert.ok(!legacyDashboard.health.reasons.includes("从未体检"));
  assert.equal(legacyDashboard.checkHeatmap.at(-1)?.status, "success");
} finally {
  await rm(dashboardVault, { recursive: true, force: true });
}

const externalMaintenanceVault = await mkdtemp(path.join(tmpdir(), "codex-kb-external-"));
try {
  await mkdir(path.join(externalMaintenanceVault, "raw", "articles", "GitHub项目收集"), { recursive: true });
  await mkdir(path.join(externalMaintenanceVault, "wiki"), { recursive: true });
  await mkdir(path.join(externalMaintenanceVault, "outputs"), { recursive: true });
  await mkdir(path.join(externalMaintenanceVault, "inbox"), { recursive: true });
  await writeFile(path.join(externalMaintenanceVault, "AGENTS.md"), "# Rules\n", "utf8");
  await writeFile(path.join(externalMaintenanceVault, "raw", "index.md"), "# Raw\n", "utf8");
  await writeFile(path.join(externalMaintenanceVault, "wiki", "index.md"), "# Wiki\n", "utf8");
  const processedRaw = path.join(externalMaintenanceVault, "raw", "articles", "GitHub项目收集", "old.md");
  const newRaw = path.join(externalMaintenanceVault, "raw", "articles", "GitHub项目收集", "new.md");
  await writeFile(processedRaw, "# Old\n", "utf8");
  await writeFile(newRaw, "# New\n", "utf8");
  const trackerPath = path.join(externalMaintenanceVault, "outputs", ".ingest-tracker.md");
  await writeFile(trackerPath, [
    "# Ingest Tracker",
    "",
    "## raw/articles/GitHub项目收集/ — 共 1 个文件",
    "",
    "2026-05-15 处理新增：",
    "- old.md",
    "  → 已消化为 [[Old]]"
  ].join("\n"), "utf8");
  const reportPath = path.join(externalMaintenanceVault, "outputs", "kb-maintenance-2026-05-15.md");
  await writeFile(reportPath, [
    "# 每日知识库维护报告 — 2026-05-15",
    "",
    "### 体检发现",
    "- 断链：1 处实质性断链",
    "- 孤儿页面：0",
    "- 过时/草稿内容：1 处",
    "- 索引链接：全部有效",
    "",
    "### 状态",
    "完成。"
  ].join("\n"), "utf8");
  const externalToday = daysAgoDateForTest(0);
  const externalYesterday = daysAgoDateForTest(1);
  const externalOld = daysAgoDateForTest(2);
  await utimes(processedRaw, externalOld, externalOld);
  await utimes(trackerPath, externalYesterday, externalYesterday);
  await utimes(newRaw, externalToday, externalToday);
  await utimes(reportPath, externalToday, externalToday);
  const externalDashboard = await buildKnowledgeBaseDashboardSnapshot(externalMaintenanceVault, normalizeSettingsData({
    settingsVersion: 19,
    knowledgeBase: {
      lastReportPath: "outputs/kb-maintenance-2026-05-15.md"
    }
  }).settings.knowledgeBase);
  assert.equal(externalDashboard.raw.changedCount, 1);
  assert.equal(externalDashboard.tracker.trackedCount, 1);
  assert.ok(externalDashboard.health.score >= 80);
  assert.equal(externalDashboard.health.status, "risk");
  assert.ok(externalDashboard.health.reasons.some((reason) => reason.includes("断链 1 处")));
  assert.ok(externalDashboard.health.reasons.some((reason) => reason.includes("过时/草稿 1 处")));
  assert.ok(!externalDashboard.health.reasons.includes("从未体检"));
  assert.equal(externalDashboard.health.lastCheckAt, externalToday.getTime());
  assert.equal(externalDashboard.checkHeatmap.at(-1)?.status, "success");
} finally {
  await rm(externalMaintenanceVault, { recursive: true, force: true });
}

const tempVault = await mkdtemp(path.join(tmpdir(), "codex-raw-store-"));
try {
  const largeText = Array.from({ length: 20_000 }, (_, index) => `line ${index}`).join("\n");
  const rawSettings = normalizeSettingsData({
    settingsVersion: 3,
    sessions: [
      {
        id: "s1",
        title: "raw",
        cwd: tempVault,
        createdAt: 1,
        updatedAt: 1,
        messages: [
          {
            id: "tool-1",
            role: "tool",
            itemType: "mcpToolCall",
            title: "使用工具",
            text: largeText,
            createdAt: 1
          }
        ]
      }
    ],
    activeSessionId: "s1"
  }).settings;
  const migrated = await externalizeLargeMessages(tempVault, rawSettings);
  const migratedMessage = rawSettings.sessions[0].messages[0];
  assert.equal(migrated, 1);
  assert.ok(migratedMessage.rawRef);
  assert.equal(migratedMessage.rawSize, largeText.length);
  assert.equal(migratedMessage.rawLines, 20_000);
  assert.ok(migratedMessage.rawTruncatedForPreview);
  assert.ok(migratedMessage.text.length < largeText.length);
  assert.equal(await readRawText(tempVault, migratedMessage.rawRef!), largeText);

  const smallMessage = { id: "tool-2", role: "tool", itemType: "commandExecution", text: "npm run test", createdAt: 1 } as any;
  assert.equal(prepareRawMessage(smallMessage, smallMessage.text), null);
  assert.equal(smallMessage.rawRef, undefined);
  assert.equal(smallMessage.text, "npm run test");

  const pressureText = "screenshot-json-line\n".repeat(Math.ceil((300 * 1024) / "screenshot-json-line\n".length));
  const pressureSettings = normalizeSettingsData({
    settingsVersion: 3,
    sessions: [
      {
        id: "s2",
        title: "pressure",
        cwd: tempVault,
        createdAt: 1,
        updatedAt: 1,
        messages: Array.from({ length: 200 }, (_, index) =>
          index === 120
            ? { id: "mcp-big", role: "tool", itemType: "mcpToolCall", text: pressureText, createdAt: index }
            : { id: `msg-${index}`, role: "assistant", text: `message ${index}`, createdAt: index }
        )
      }
    ],
    activeSessionId: "s2"
  }).settings;
  assert.equal(await externalizeLargeMessages(tempVault, pressureSettings), 1);
  const pressureMessage = pressureSettings.sessions[0].messages[120];
  assert.equal(await readRawText(tempVault, pressureMessage.rawRef!), pressureText);
  assert.ok(JSON.stringify(pressureSettings).length < pressureText.length / 2);
} finally {
  await rm(tempVault, { recursive: true, force: true });
}

const virtualIds = Array.from({ length: 200 }, (_, index) => `message:${index}`);
const firstWindow = calculateVirtualWindow({ rowIds: virtualIds, scrollTop: 0, viewportHeight: 480 });
assert.ok(firstWindow.rows.length < virtualIds.length);
assert.equal(firstWindow.rows[0].id, "message:0");
assert.equal(firstWindow.totalHeight, 200 * 96);

const measuredWindow = calculateVirtualWindow({
  rowIds: virtualIds,
  rowHeights: new Map<string, number>([
    ["message:0", 192],
    ["message:1", 48]
  ]),
  scrollTop: 0,
  viewportHeight: 480,
  overscanPx: 0
});
assert.equal(measuredWindow.totalHeight, 192 + 48 + 198 * 96);
assert.equal(measuredWindow.rows[1].top, 192);

const bottom = scrollTopForVirtualBottom(firstWindow.totalHeight, 480);
assert.equal(bottom, firstWindow.totalHeight - 480);
assert.equal(isNearVirtualBottom(bottom, 480, firstWindow.totalHeight), true);
assert.equal(isNearVirtualBottom(bottom - 200, 480, firstWindow.totalHeight), false);

const pressureVirtualIds = Array.from({ length: 1000 }, (_, index) => `message:pressure-${index}`);
const pressureWindow = calculateVirtualWindow({ rowIds: pressureVirtualIds, scrollTop: 45_000, viewportHeight: 720 });
assert.ok(pressureWindow.rows.length < 30);
assert.ok(pressureWindow.startIndex > 0);
assert.ok(pressureWindow.endIndex < pressureVirtualIds.length);

const diffChanges = [
  {
    path: "src/a.ts",
    kind: { type: "update", move_path: null },
    diff: ["--- a/src/a.ts", "+++ b/src/a.ts", "@@ -1,3 +1,4 @@", " const a = 1;", "-const b = 2;", "+const b = 3;", "+const c = 4;"].join("\n")
  },
  {
    path: "src/b.ts",
    kind: { type: "add" },
    diff: ["@@ -0,0 +1,2 @@", "+export const b = 1;", "+export const c = 2;"].join("\n")
  },
  {
    path: "src/c.ts",
    kind: { type: "update", move_path: "src/old-c.ts" },
    diff: ["@@ -1,2 +1,1 @@", "-old", " kept"].join("\n")
  }
];
const diffSummary = buildDiffSummary(diffChanges);
assert.equal(diffSummary.totalFiles, 3);
assert.equal(diffSummary.added, 4);
assert.equal(diffSummary.removed, 2);
assert.equal(diffSummary.files[0].added, 2);
assert.equal(diffSummary.files[0].removed, 1);
assert.equal(diffSummary.files[1].kind, "add");
assert.equal(diffSummary.files[2].kind, "move");
assert.equal(diffSummary.files[2].previousPath, "src/old-c.ts");
const serializedDiff = serializeFileChanges(diffChanges);
const parsedDiff = parseFileChangeDiff(serializedDiff, diffSummary);
assert.equal(parsedDiff.length, 3);
assert.equal(parsedDiff[0].path, "src/a.ts");
assert.equal(parsedDiff[0].lines.filter((line) => line.type === "add").length, 2);
assert.equal(parsedDiff[0].lines.filter((line) => line.type === "remove").length, 1);
assert.equal(parsedDiff[0].lines.some((line) => line.text.startsWith("+++")), true);
assert.equal(parsedDiff[0].lines.filter((line) => line.type === "add").some((line) => line.text.startsWith("++")), false);

assert.ok(SETTINGS_GEAR_ICON_PATHS[0].includes("M12.22"));

async function fileExists(filePath: string): Promise<boolean> {
  return stat(filePath).then(() => true, () => false);
}

console.log("All tests passed");
