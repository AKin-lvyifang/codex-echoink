import * as assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { chmod, link, lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
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
  processGroupStateId,
  reasoningTextFromPayload,
  summarizeProcessEvent
} from "../core/mapping";
import { settleStaleRunningMessages } from "../core/message-state";
import { formatRateLimitUsage, normalizeRateLimitResponse } from "../core/rate-limits";
import { diagnoseCodexError } from "../core/codex-diagnostics";
import { formatJsonRpcError } from "../core/codex-rpc";
import { externalizeLargeMessages, pluginDataDir, prepareRawMessage, readRawText } from "../core/raw-message-store";
import { splitVaultNoteLinkSegments } from "../core/vault-note-links";
import { CHAT_TURN_WATCHDOG_MS, turnWatchdogTimeoutForSession, turnWatchdogTimeoutText } from "../ui/turn-watchdog";
import {
  emptyWorkspaceResourceSnapshot,
  loadedTabsFromWorkspaceResourceCache,
  mergeMcpServers,
  mergeWorkspaceResourceSnapshot,
  snapshotFromWorkspaceResourceCache,
  updateWorkspaceResourceCache
} from "../core/workspace-resources";
import { filterWorkspaceResourceRows } from "../core/workspace-resource-filter";
import {
  DEFAULT_SETTINGS,
  DEFAULT_REVIEW_OUTPUT_DIR,
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
  clearLegacyChatWorkspaceDefaults,
  isKnowledgeBaseSession,
  normalizeSettingsData,
  recordKnowledgeBaseHealthCheck,
  recordKnowledgeBaseMaintenanceRun,
  removeApiProvider,
  normalizeReviewOutputDir,
  resolveEditorActionModeConfig,
  validateApiProvider,
  resourceEnabled,
  type ChatMessage
} from "../settings/settings";
import { buildSetupCheck, completeSetupState } from "../settings/setup-check";
import { SETTINGS_COPY, SETTINGS_LANGUAGE_OPTIONS, settingsCopy } from "../settings/i18n";
import { buildCodexLaunchConfig, CodexService, resolveCodexCommand } from "../core/codex-service";
import { formatOpenCodeError } from "../core/opencode-errors";
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
import { shouldCloseComposerMenusForClick } from "../ui/composer-menu";
import { composerIsBusy, composerPrimaryActionForRuntimeState, composerPrimaryActionForState } from "../ui/composer-state";
import { CodexView, isKnowledgeDashboardHealthTooltipHoverPoint } from "../ui/codex-view";
import { canStartQueuedTurn, RuntimeTurnQueue, type QueuedTurnItem } from "../ui/turn-queue";
import { extractKnowledgeBaseResultTitle } from "../ui/knowledge-base-result-title";
import { formatMessageHeaderTime } from "../ui/message-time";
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
import { buildKnowledgeBaseDashboardSnapshot, type KnowledgeBaseDashboardFile, type KnowledgeBaseDashboardSnapshot } from "../knowledge-base/dashboard";
import { runKnowledgeBasePerformanceTests } from "./knowledge-base-performance-tests";
import { buildHomeCards, buildHomeFolderFilterItems, calendarMonthLabel, filterHomeCards, filterHomeCardsByFolder, HOME_CARD_ACTION_LABELS, HOME_CARDS_PAGE_SIZE, HOME_FOLDER_ALL, HOME_SORT_OPTIONS, homeCardFolderScope, homeCardMarkdownLinkToCopy, homeCardObsidianLinkToCopy, homeCardPathToCopy, isSystemHomeCardPath, resolveActiveHomeFilter, resolveDefaultHomeFilter, shiftCalendarMonth, sortHomeCards } from "../home/home-view";
import { buildKnowledgeBaseInitializationPreview, executeKnowledgeBaseInitialization, KNOWLEDGE_BASE_TEMPLATE_VERSION } from "../knowledge-base/initializer";
import { buildKnowledgeBaseJournalPrompt, ensureJournalTargetFolders, resolveJournalDailyTarget, stripJournalPrefix } from "../knowledge-base/journal";
import { KnowledgeBaseManager } from "../knowledge-base/manager";
import { formatKnowledgeBaseCodexFailureSignal, isKnowledgeBaseCancelError } from "../knowledge-base/failure";
import { buildKnowledgeBaseAskPrompt, buildKnowledgeBasePrompt } from "../knowledge-base/prompt";
import { applyRawDigestFrontmatter, rawDigestFingerprint, rawDigestRecordFromMarkdown, rawDigestRecordIsTrusted, readRawDigestRegistry } from "../knowledge-base/raw-digest";
import { classifyRawSnapshotChanges, contentFingerprint, diffRawSnapshot, fingerprintRawContentSnapshot, formatRawIntegrityError, isRawIntegrityErrorMessage, rawSnapshotChangeMessages, restoreRawSnapshot, snapshotRawFileContents } from "../knowledge-base/raw-integrity";
import type { RawSnapshotEntry } from "../knowledge-base/raw-integrity";
import { KNOWLEDGE_BASE_COMMAND_GUIDE, getTrailingSlashQuery, knowledgeBaseHelpText, knowledgeCommandOptions, knowledgeCommandQueryForInput, parseKnowledgeBaseCommand, shouldHandleKnowledgeBaseCommand } from "../knowledge-base/commands";
import { buildKnowledgeBaseCitationSummary, findKnowledgeBaseAskMatches, stripAskCommand } from "../knowledge-base/query";
import { routeKnowledgeBaseCodexNotification } from "../knowledge-base/codex-route";
import {
  compactKnowledgeBaseMessagesToActiveDay,
  collectKnowledgeBaseStorageStats,
  filterKnowledgeBaseMessagesForDate,
  latestKnowledgeBaseMessageDate,
  migrateKnowledgeBaseHistory,
  persistAndCompactKnowledgeBaseHistory,
  persistKnowledgeBaseHistoryMessages,
  pruneKnowledgeBaseHistoryByRetention,
  readKnowledgeBaseHistoryDay,
  readKnowledgeBaseHistoryIndex,
  removeKnowledgeBaseHistoryDays,
  rebuildKnowledgeBaseHistoryIndex
} from "../knowledge-base/history-store";
import { ensureKnowledgeBaseFallbackReport, isLintOnlyKnowledgeBaseReport, readFreshKnowledgeBaseReportExcerpt, readKnowledgeBaseReportExcerpt, readKnowledgeBaseReportMtime, recoveredLintReportSummary, shouldRecoverKnowledgeBaseLintFailure } from "../knowledge-base/report";
import { repairKnowledgeBaseRulesFile } from "../knowledge-base/rules-repair";
import { shouldRunScheduledKnowledgeBaseMaintenance } from "../knowledge-base/schedule";
import { buildScheduledKnowledgeBaseMessage, extractKnowledgeBaseReportConclusion } from "../knowledge-base/scheduled-message";
import { normalizeKnowledgeBaseStructure } from "../knowledge-base/structure-normalizer";
import { CODEX_MEMORY_LITE_URL, DEFAULT_KNOWLEDGE_BASE_RULES_FILE } from "../knowledge-base/constants";
import { clearKnowledgeBaseVisibleHistory, getDisplayKnowledgeBaseMessages, getHiddenKnowledgeBaseMessages, getVisibleKnowledgeBaseMessages, restoreKnowledgeBaseVisibleHistory } from "../knowledge-base/session-history";
import { buildCodexKnowledgeTurnOptions } from "../knowledge-base/turn-options";
import type { KnowledgeBaseRunMode, KnowledgeBaseRunResult } from "../knowledge-base/types";
import { REVIEW_HTML_CSS, REVIEW_SECTION_HEADINGS, renderReviewHtml } from "../review/review-html-template";
import {
  REVIEW_OUTPUT_DIR,
  buildReviewDocuments,
  collectAgentChatReviewEvidence,
  collectKnowledgeBaseReviewEvidence,
  reportBaseName
} from "../review/report";
import {
  currentReviewRange,
  isReviewHtmlPath,
  latestScheduledReviewRange,
  reviewRangeForMode,
  reviewRangeKey,
  shouldRunScheduledReview
} from "../review/schedule";

const execFile = promisify(execFileCallback);

const manifest = JSON.parse(await readFile(path.join(process.cwd(), "manifest.json"), "utf8")) as { id: string; name: string; version: string; author: string };
assert.equal(manifest.id, "codex-echoink");
assert.equal(manifest.name, "Codex EchoInk");
assert.equal(manifest.version, "1.0.1");
assert.equal(manifest.author, "AKin-lvyifang");
assert.equal(manifest.id.includes("obsidian"), false);

assert.equal(formatMessageHeaderTime(new Date(2026, 4, 22, 8, 29).getTime()), "星期五08:29");
assert.equal(formatMessageHeaderTime(0), "");
function assertI18nShapeMatches(reference: unknown, candidate: unknown, pathLabel = "copy"): void {
  if (typeof reference === "function") {
    assert.equal(typeof candidate, "function", `${pathLabel} should be a function`);
    return;
  }
  if (Array.isArray(reference)) {
    assert.equal(Array.isArray(candidate), true, `${pathLabel} should be an array`);
    assert.equal((candidate as unknown[]).length, reference.length, `${pathLabel} array length`);
    reference.forEach((item, index) => assertI18nShapeMatches(item, (candidate as unknown[])[index], `${pathLabel}[${index}]`));
    return;
  }
  if (reference && typeof reference === "object") {
    assert.equal(Boolean(candidate && typeof candidate === "object" && !Array.isArray(candidate)), true, `${pathLabel} should be an object`);
    assert.deepEqual(Object.keys(candidate as Record<string, unknown>).sort(), Object.keys(reference as Record<string, unknown>).sort(), `${pathLabel} keys`);
    for (const key of Object.keys(reference as Record<string, unknown>)) {
      assertI18nShapeMatches((reference as Record<string, unknown>)[key], (candidate as Record<string, unknown>)[key], `${pathLabel}.${key}`);
    }
    return;
  }
  assert.equal(typeof candidate, typeof reference, `${pathLabel} primitive type`);
}

function cssRuleBody(styles: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`^${escaped}\\s*\\{([^}]*)\\}`, "m").exec(styles);
  assert.ok(match, `Missing CSS rule: ${selector}`);
  return match[1];
}

const workspace = buildSandboxPolicy("workspace-write", "/vault");
assert.equal(workspace.type, "workspaceWrite");
assert.ok(workspace.writableRoots?.includes("/vault"));

const reportLinkSegments = splitVaultNoteLinkSegments(
  "报告已写入：[outputs/kb-maintenance-2026-05-19.md]\n(/vault/outputs/kb-maintenance-2026-05-19.md)",
  "/vault"
);
assert.equal(reportLinkSegments.filter((segment) => segment.kind === "noteLink").length, 2);
assert.deepEqual(reportLinkSegments.filter((segment) => segment.kind === "noteLink").map((segment) => segment.text), [
  "kb-maintenance-2026-05-19",
  "kb-maintenance-2026-05-19"
]);
assert.ok(reportLinkSegments.some((segment) => segment.kind === "noteLink" && segment.original.includes("/vault/outputs/kb-maintenance-2026-05-19.md")));
const bareReportLink = splitVaultNoteLinkSegments("报告： outputs/kb-maintenance-2026-05-19.md。", "/vault");
assert.equal(bareReportLink.find((segment) => segment.kind === "noteLink")?.text, "kb-maintenance-2026-05-19");
assert.equal(bareReportLink.find((segment) => segment.kind === "noteLink")?.title, "/vault/outputs/kb-maintenance-2026-05-19.md");
const markdownReportLink = splitVaultNoteLinkSegments("报告：[打开报告](outputs/kb-maintenance-2026-05-19.md)", "/vault");
assert.equal(markdownReportLink.find((segment) => segment.kind === "noteLink")?.text, "打开报告");
assert.equal(markdownReportLink.find((segment) => segment.kind === "noteLink")?.targetPath, "outputs/kb-maintenance-2026-05-19.md");
const encodedWikiLink = splitVaultNoteLinkSegments(
  "[GitHub 2026-05-19 热门项目简报.md](/vault/wiki/ai-intelligence/references/GitHub%202026-05-19%20热门项目简报.md)",
  "/vault"
);
assert.equal(encodedWikiLink.find((segment) => segment.kind === "noteLink")?.targetPath, "wiki/ai-intelligence/references/GitHub 2026-05-19 热门项目简报.md");
const aliasReportLink = splitVaultNoteLinkSegments("报告：[[outputs/kb-maintenance-2026-05-19.md|今日体检报告]]", "/vault");
assert.equal(aliasReportLink.find((segment) => segment.kind === "noteLink")?.text, "今日体检报告");
assert.equal(aliasReportLink.find((segment) => segment.kind === "noteLink")?.targetPath, "outputs/kb-maintenance-2026-05-19.md");
const bareWikiTitleLinks = splitVaultNoteLinkSegments("主要新增页面包括：\n• [[GitHub 2026-05-24 热门项目简报]]", "/vault");
assert.equal(bareWikiTitleLinks.find((segment) => segment.kind === "noteLink")?.text, "GitHub 2026-05-24 热门项目简报");
assert.equal(bareWikiTitleLinks.find((segment) => segment.kind === "noteLink")?.targetPath, "GitHub 2026-05-24 热门项目简报.md");
const indexLinks = splitVaultNoteLinkSegments("依据：raw/index.md 和 wiki/index.md", "/vault");
assert.deepEqual(indexLinks.filter((segment) => segment.kind === "noteLink").map((segment) => segment.text), ["raw/index", "wiki/index"]);
assert.deepEqual(splitVaultNoteLinkSegments("不是笔记：src/ui/render-message.ts", "/vault"), [{ kind: "text", text: "不是笔记：src/ui/render-message.ts" }]);

assert.equal(buildSandboxPolicy("read-only", "/vault").type, "readOnly");
assert.equal(buildSandboxPolicy("danger-full-access", "/vault").type, "dangerFullAccess");
assert.deepEqual(buildSandboxPolicy("workspace-write", "/vault", ["/vault/wiki", "/vault/outputs"]).writableRoots?.slice(0, 2), ["/vault/wiki", "/vault/outputs"]);
const kbTurnOptions = buildCodexKnowledgeTurnOptions({
  settings: DEFAULT_SETTINGS,
  availableModels: [{ model: "gpt-test" }],
  vaultPath: "/vault",
  permission: "workspace-write"
});
assert.ok(!kbTurnOptions.writableRoots?.includes(path.join("/vault", "raw")));
assert.ok(kbTurnOptions.writableRoots?.includes(path.join("/vault", "raw", "index.md")));
assert.ok(kbTurnOptions.writableRoots?.includes(path.join("/vault", "inbox")));
assert.ok(kbTurnOptions.writableRoots?.includes(path.join("/vault", "projects")));
const kbLintTurnOptions = buildCodexKnowledgeTurnOptions({
  settings: DEFAULT_SETTINGS,
  availableModels: [{ model: "gpt-test" }],
  vaultPath: "/vault",
  permission: "workspace-write",
  writeScope: "knowledge-lint"
});
assert.deepEqual(kbLintTurnOptions.writableRoots, [path.join("/vault", "outputs")]);
const codexThreadRequests: Array<{ method: string; params: any }> = [];
const codexService = new CodexService({
  cliPath: "",
  proxyEnabled: false,
  proxyUrl: "",
  providerMode: "codex-login",
  activeApiProvider: null,
  vaultPath: "/vault",
  onNotification: () => undefined,
  onServerRequest: async () => ({})
});
(codexService as any).client = {
  isAlive: () => true,
  request: async (method: string, params: any) => {
    codexThreadRequests.push({ method, params });
    if (method === "thread/start") return { thread: { id: "thread-kb", name: "KB" } };
    if (method === "thread/resume") return {};
    if (method === "turn/start") return { turn: { id: "turn-kb" } };
    throw new Error(`unexpected request: ${method}`);
  }
};
await codexService.startThread(kbTurnOptions);
const codexThreadStartParams = codexThreadRequests.find((request) => request.method === "thread/start")?.params;
assert.equal(codexThreadStartParams?.sandboxPolicy?.type, "workspaceWrite");
assert.ok(!codexThreadStartParams?.sandboxPolicy?.writableRoots?.includes(path.join("/vault", "raw")));
assert.ok(codexThreadStartParams?.sandboxPolicy?.writableRoots?.includes(path.join("/vault", "raw", "index.md")));
await codexService.resumeThread("thread-kb", kbTurnOptions);
const codexThreadResumeParams = codexThreadRequests.find((request) => request.method === "thread/resume")?.params;
assert.equal(codexThreadResumeParams?.sandboxPolicy?.type, "workspaceWrite");
assert.ok(!codexThreadResumeParams?.sandboxPolicy?.writableRoots?.includes(path.join("/vault", "raw")));
assert.ok(codexThreadResumeParams?.sandboxPolicy?.writableRoots?.includes(path.join("/vault", "raw", "index.md")));
await codexService.startTurn("thread-kb", [{ type: "text", text: "lint", text_elements: [] }], kbLintTurnOptions);
const codexTurnStartParams = codexThreadRequests.find((request) => request.method === "turn/start")?.params;
assert.equal(codexTurnStartParams?.sandbox, "workspace-write");
assert.equal(codexTurnStartParams?.sandboxPolicy?.type, "workspaceWrite");
assert.deepEqual(codexTurnStartParams?.sandboxPolicy?.writableRoots?.slice(0, 1), [path.join("/vault", "outputs")]);
assert.ok(!codexTurnStartParams?.sandboxPolicy?.writableRoots?.includes(path.join("/vault", "raw")));
const archiveCalls: Array<{ command: string; args: string[]; cwd: string | undefined }> = [];
const archiveService = new CodexService({
  cliPath: process.execPath,
  proxyEnabled: false,
  proxyUrl: "",
  providerMode: "codex-login",
  activeApiProvider: null,
  vaultPath: "/vault",
  onNotification: () => undefined,
  onServerRequest: async () => ({}),
  processRunner: async (command, args, options) => {
    archiveCalls.push({ command, args, cwd: options.cwd });
    return { stdout: "", stderr: "" };
  }
});
await archiveService.archiveThread("thread-kb");
assert.deepEqual(archiveCalls, [{ command: process.execPath, args: ["archive", "thread-kb"], cwd: "/vault" }]);
const queuedKbTurnOptions = buildCodexKnowledgeTurnOptions({
  settings: DEFAULT_SETTINGS,
  availableModels: [{ model: "gpt-test" }],
  vaultPath: "/vault",
  permission: "read-only",
  overrides: {
    model: "gpt-queued",
    reasoning: "low",
    serviceTier: "standard",
    mcpEnabled: true,
    workspaceResources: { plugins: { "plugin-a": true }, mcpServers: {}, skills: { "skill-a": true } }
  }
});
assert.equal(queuedKbTurnOptions.model, "gpt-queued");
assert.equal(queuedKbTurnOptions.reasoning, "low");
assert.equal(queuedKbTurnOptions.serviceTier, "standard");
assert.equal(queuedKbTurnOptions.mcpEnabled, true);
assert.deepEqual(queuedKbTurnOptions.workspaceResources?.skills, { "skill-a": true });
const journalTurnOptions = buildCodexKnowledgeTurnOptions({
  settings: DEFAULT_SETTINGS,
  availableModels: [{ model: "gpt-test" }],
  vaultPath: "/vault",
  permission: "workspace-write",
  writeScope: "journal"
});
assert.deepEqual(journalTurnOptions.writableRoots, ["/vault/journal", "/vault/01-日记"]);
assert.equal(turnWatchdogTimeoutForSession(false), CHAT_TURN_WATCHDOG_MS);
assert.equal(turnWatchdogTimeoutForSession(true), null);
assert.ok(turnWatchdogTimeoutText(CHAT_TURN_WATCHDOG_MS).includes("重新连接 Codex"));
const kbFailureSignal = formatKnowledgeBaseCodexFailureSignal("turn/completed", {
  turn: {
    id: "turn-1",
    threadId: "thread-1",
    status: "failed",
    error: { code: "rate_limit_exceeded", message: "model service timed out" }
  }
}, "Codex 知识库任务失败");
assert.match(kbFailureSignal, /错误信号：turn\/completed/);
assert.match(kbFailureSignal, /状态：failed/);
assert.match(kbFailureSignal, /错误码：rate_limit_exceeded/);
assert.match(kbFailureSignal, /原始消息：model service timed out/);

assert.equal(normalizeServiceTier("standard"), null);
assert.equal(normalizeServiceTier("fast"), "fast");
assert.equal(normalizeServiceTier("flex"), "flex");

assert.equal(DEFAULT_SETTINGS.defaultModel, "");
assert.equal(DEFAULT_SETTINGS.defaultReasoning, "high");
assert.equal(DEFAULT_SETTINGS.proxyEnabled, false);
assert.equal(DEFAULT_SETTINGS.settingsVersion, 27);
assert.equal(DEFAULT_SETTINGS.settingsLanguage, "zh-CN");
assert.equal(DEFAULT_SETTINGS.settingsTab, "general");
assert.equal(DEFAULT_SETTINGS.agentBackend, "codex-cli");
assert.equal(DEFAULT_SETTINGS.providerMode, "codex-login");
assert.equal(DEFAULT_SETTINGS.autoOpenHome, false);
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
assert.equal(DEFAULT_SETTINGS.setup.completedAt, 0);
assert.equal(DEFAULT_SETTINGS.setup.lastCheckedAt, 0);
assert.equal(DEFAULT_SETTINGS.knowledgeBase.enabled, false);
assert.equal(DEFAULT_SETTINGS.knowledgeBase.backend, "default");
assert.equal(DEFAULT_SETTINGS.knowledgeBase.useCustomRulesFile, true);
assert.equal(DEFAULT_SETTINGS.knowledgeBase.rulesFilePath, DEFAULT_KNOWLEDGE_BASE_RULES_FILE);
assert.equal(CODEX_MEMORY_LITE_URL, "https://github.com/AKin-lvyifang/codex-memory-lite");
assert.equal(DEFAULT_SETTINGS.knowledgeBase.scheduleTime, "09:00");
assert.equal(DEFAULT_SETTINGS.knowledgeBase.sessionId, "");
assert.equal(DEFAULT_SETTINGS.knowledgeBase.lastScheduledRunAt, 0);
assert.equal(DEFAULT_SETTINGS.knowledgeBase.lastScheduledRunStatus, "idle");
assert.equal(DEFAULT_SETTINGS.knowledgeBase.historyRetentionDays, 30);
assert.equal(DEFAULT_SETTINGS.knowledgeBase.initialization.status, "not-started");
assert.equal(DEFAULT_SETTINGS.knowledgeBase.initialization.templateVersion, KNOWLEDGE_BASE_TEMPLATE_VERSION);
assert.deepEqual(DEFAULT_SETTINGS.knowledgeBase.healthHistory, []);
assert.deepEqual(DEFAULT_SETTINGS.knowledgeBase.maintenanceHistory, []);
assert.deepEqual(DEFAULT_SETTINGS.knowledgeBase.managedThreads, {});
const scheduledKnowledgeBaseBase = {
  enabled: true,
  scheduleEnabled: true,
  scheduleTime: "09:00",
  catchUpOnStartup: true,
  lastRunAt: 0
};
assert.equal(shouldRunScheduledKnowledgeBaseMaintenance(
  scheduledKnowledgeBaseBase,
  new Date("2026-05-19T08:30:00+08:00"),
  new Date("2026-05-19T08:00:00+08:00").getTime(),
  true
), false);
assert.equal(shouldRunScheduledKnowledgeBaseMaintenance(
  scheduledKnowledgeBaseBase,
  new Date("2026-05-19T09:01:00+08:00"),
  new Date("2026-05-19T08:00:00+08:00").getTime()
), true);
assert.equal(shouldRunScheduledKnowledgeBaseMaintenance(
  { ...scheduledKnowledgeBaseBase, catchUpOnStartup: false },
  new Date("2026-05-19T10:00:00+08:00"),
  new Date("2026-05-19T10:00:00+08:00").getTime()
), false);
assert.equal(shouldRunScheduledKnowledgeBaseMaintenance(
  { ...scheduledKnowledgeBaseBase, lastRunAt: new Date("2026-05-19T01:17:00+08:00").getTime() },
  new Date("2026-05-19T09:01:00+08:00"),
  new Date("2026-05-19T08:00:00+08:00").getTime()
), true);
assert.equal(shouldRunScheduledKnowledgeBaseMaintenance(
  { ...scheduledKnowledgeBaseBase, lastScheduledRunAt: new Date("2026-05-19T09:00:10+08:00").getTime(), lastScheduledRunStatus: "success" },
  new Date("2026-05-19T09:01:00+08:00"),
  new Date("2026-05-19T08:00:00+08:00").getTime()
), false);
assert.equal(shouldRunScheduledKnowledgeBaseMaintenance(
  { ...scheduledKnowledgeBaseBase, lastScheduledRunAt: new Date("2026-05-19T09:00:10+08:00").getTime(), lastScheduledRunStatus: "running" },
  new Date("2026-05-19T09:01:00+08:00"),
  new Date("2026-05-19T08:00:00+08:00").getTime()
), true);
assert.equal(shouldRunScheduledKnowledgeBaseMaintenance(
  { ...scheduledKnowledgeBaseBase, scheduleTime: "09:20" },
  new Date("2026-05-19T09:00:00+08:00"),
  new Date("2026-05-19T08:00:00+08:00").getTime()
), false);
assert.equal(DEFAULT_SETTINGS.review.enabled, false);
assert.equal(DEFAULT_SETTINGS.review.knowledgeBaseEnabled, true);
assert.equal(DEFAULT_SETTINGS.review.agentChatEnabled, true);
assert.equal(DEFAULT_SETTINGS.review.scheduleTime, "21:00");
assert.equal(DEFAULT_SETTINGS.review.catchUpOnStartup, true);
assert.equal(DEFAULT_SETTINGS.review.reports.knowledgeBase.lastRunStatus, "idle");
assert.equal(DEFAULT_SETTINGS.review.reports.agentChat.lastRunStatus, "idle");
assert.equal(normalizeSettingsData({ settingsVersion: DEFAULT_SETTINGS.settingsVersion, settingsLanguage: "en" }).settings.settingsLanguage, "en");
assert.equal(normalizeSettingsData({ settingsVersion: DEFAULT_SETTINGS.settingsVersion, settingsLanguage: "fr" }).settings.settingsLanguage, "zh-CN");
assert.equal(normalizeSettingsData({ settingsVersion: DEFAULT_SETTINGS.settingsVersion, settingsLanguage: "en" }).changed, false);
assert.equal(normalizeSettingsData({ settingsVersion: DEFAULT_SETTINGS.settingsVersion, settingsLanguage: "fr" }).changed, true);
assert.equal(normalizeSettingsData({ settingsVersion: DEFAULT_SETTINGS.settingsVersion }).changed, true);
assert.equal(normalizeSettingsData({ settingsVersion: DEFAULT_SETTINGS.settingsVersion, autoOpenHome: true }).settings.autoOpenHome, true);
assert.equal(normalizeSettingsData({ settingsVersion: DEFAULT_SETTINGS.settingsVersion, autoOpenHome: "yes" }).settings.autoOpenHome, false);
assert.deepEqual(SETTINGS_LANGUAGE_OPTIONS, ["zh-CN", "en"]);
assert.deepEqual(Object.keys(SETTINGS_COPY).sort(), SETTINGS_LANGUAGE_OPTIONS.slice().sort());
assertI18nShapeMatches(SETTINGS_COPY["zh-CN"], SETTINGS_COPY.en);
assert.equal(settingsCopy("en").general.settingsLanguage, "Settings language");
assert.equal(settingsCopy("en").tabs.knowledgeBase, "Knowledge");
assert.equal(settingsCopy("en").knowledge.dailyMaintenance, "Automatic maintenance");
assert.equal(settingsCopy("en").knowledge.repairSummary("patched", DEFAULT_KNOWLEDGE_BASE_RULES_FILE), `Knowledge guide updated: ${DEFAULT_KNOWLEDGE_BASE_RULES_FILE}`);
assert.deepEqual(
  getKnowledgeBaseRulesFileChoices([DEFAULT_KNOWLEDGE_BASE_RULES_FILE, "docs/kb-rules.md", "raw/source.pdf", "CLAUDE.md", "/AGENTS.md", "../bad.md", "docs/kb-rules.md", "notes/todo.txt"]),
  [DEFAULT_KNOWLEDGE_BASE_RULES_FILE, "AGENTS.md", "CLAUDE.md", "docs/kb-rules.md"]
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
assert.deepEqual(migratedKnowledgeBaseSettings.maintenanceHistory, [
  { date: "2026-05-15", status: "success", at: 1778803200000, mode: "lint", reportPath: "" }
]);
recordKnowledgeBaseHealthCheck(migratedKnowledgeBaseSettings, "failed", 1778889600000);
assert.deepEqual(migratedKnowledgeBaseSettings.healthHistory.at(-1), {
  date: "2026-05-16",
  status: "failed",
  at: 1778889600000
});
recordKnowledgeBaseMaintenanceRun(migratedKnowledgeBaseSettings, {
  status: "success",
  mode: "maintain",
  at: 1778976000000,
  reportPath: "outputs/kb-maintenance-2026-05-17.md"
});
assert.deepEqual(migratedKnowledgeBaseSettings.maintenanceHistory.at(-1), {
  date: "2026-05-17",
  status: "success",
  at: 1778976000000,
  mode: "maintain",
  reportPath: "outputs/kb-maintenance-2026-05-17.md"
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
assert.equal(clearLegacyChatWorkspaceDefaults(sessionSettings, "/vault", 21), 0);

const legacyWorkspaceSettings = normalizeSettingsData({
  settingsVersion: 20,
  knowledgeBase: { sessionId: "kb-old" },
  sessions: [
    { id: "chat-vault", title: "普通会话", cwd: "/vault", threadId: "old-thread", tokenUsage: { total: { totalTokens: 1 } }, messages: [], createdAt: 1, updatedAt: 1 },
    { id: "chat-external", title: "外部项目", cwd: "/project", messages: [], createdAt: 1, updatedAt: 1 },
    { id: "kb-old", title: KNOWLEDGE_BASE_SESSION_TITLE, kind: "knowledge-base", cwd: "/vault", messages: [], createdAt: 1, updatedAt: 1 }
  ],
  activeSessionId: "chat-vault"
}).settings;
assert.equal(clearLegacyChatWorkspaceDefaults(legacyWorkspaceSettings, "/vault", 20), 1);
assert.equal(legacyWorkspaceSettings.sessions.find((session) => session.id === "chat-vault")?.cwd, "");
assert.equal(legacyWorkspaceSettings.sessions.find((session) => session.id === "chat-vault")?.threadId, undefined);
assert.equal(legacyWorkspaceSettings.sessions.find((session) => session.id === "chat-vault")?.tokenUsage, undefined);
assert.equal(legacyWorkspaceSettings.sessions.find((session) => session.id === "chat-external")?.cwd, "/project");
assert.equal(legacyWorkspaceSettings.sessions.find((session) => session.id === "kb-old")?.cwd, "/vault");

assert.deepEqual(parseKnowledgeBaseCommand("只体检一下").intent, "lint");
assert.deepEqual(parseKnowledgeBaseCommand("帮我维护并消化今天的 raw").intent, "maintain");
assert.deepEqual(parseKnowledgeBaseCommand("重新提炼最近的资料").intent, "reingest");
assert.deepEqual(parseKnowledgeBaseCommand("/check 只看断链").intent, "lint");
assert.deepEqual(parseKnowledgeBaseCommand("/体检？只看断链").intent, "lint");
assert.deepEqual(parseKnowledgeBaseCommand("/maintain 只处理今天新增").intent, "maintain");
assert.deepEqual(parseKnowledgeBaseCommand("/outputs 提炼最近发布稿").intent, "process-outputs");
assert.deepEqual(parseKnowledgeBaseCommand("/inbox 只归类不沉淀").intent, "process-inbox");
assert.deepEqual(parseKnowledgeBaseCommand("/journal 今天完成知识库命令优化").intent, "journal");
assert.deepEqual(parseKnowledgeBaseCommand("/ask Harness Engineering 和 Vibe Coding 有什么关系？").intent, "ask");
assert.deepEqual(parseKnowledgeBaseCommand("/clear").intent, "clear");
assert.deepEqual(parseKnowledgeBaseCommand("/history").intent, "history");
assert.deepEqual(parseKnowledgeBaseCommand("/历史").intent, "history");
assert.deepEqual(parseKnowledgeBaseCommand("停止").intent, "cancel");
assert.deepEqual(parseKnowledgeBaseCommand("停止当前知识库任务").intent, "cancel");
assert.equal(isKnowledgeBaseCancelError("知识库任务已取消"), true);
assert.equal(isKnowledgeBaseCancelError("用户取消"), false);
assert.deepEqual(parseKnowledgeBaseCommand("请写一段较长的测试回复，主题是停止按钮验证。只输出文字，不读取或修改文件。").intent, "chat");
assert.deepEqual(parseKnowledgeBaseCommand("当前文件的提炼太精简了，你可以再深入提炼一下。", 1).intent, "chat");
assert.equal(shouldHandleKnowledgeBaseCommand("当前文件的提炼太精简了，你可以再深入提炼一下。", 1), false);
assert.deepEqual(parseKnowledgeBaseCommand("这篇文章里第二个例子怎么理解？").intent, "chat");
assert.deepEqual(parseKnowledgeBaseCommand("", 1).intent, "chat");
assert.deepEqual(parseKnowledgeBaseCommand("/week").intent, "review");
assert.deepEqual(parseKnowledgeBaseCommand("/week").reviewKind, "knowledge-base");
assert.deepEqual(parseKnowledgeBaseCommand("/week agent").reviewKind, "agent-chat");
assert.deepEqual(parseKnowledgeBaseCommand("/写周报").reviewKind, "knowledge-base");
assert.deepEqual(parseKnowledgeBaseCommand("写周报").reviewKind, "knowledge-base");
assert.ok(KNOWLEDGE_BASE_COMMAND_GUIDE.some((item) => item.command === "/week"));
assert.ok(KNOWLEDGE_BASE_COMMAND_GUIDE.some((item) => item.command === "/clear"));
assert.ok(KNOWLEDGE_BASE_COMMAND_GUIDE.some((item) => item.command === "/history"));
assert.ok(knowledgeBaseHelpText().includes("`/week`：写知识库周报"));
assert.ok(knowledgeBaseHelpText().includes("`/clear`：清空当前页面"));
assert.equal(getTrailingSlashQuery("/"), "");
assert.equal(getTrailingSlashQuery("/ma"), "ma");
assert.equal(knowledgeCommandQueryForInput("/", true), "");
assert.equal(knowledgeCommandQueryForInput("/", false), null);
assert.deepEqual(knowledgeCommandOptions("ma").map((item) => item.text), ["/maintain "]);
assert.deepEqual(knowledgeCommandOptions("").map((item) => item.text), ["/ask ", "/check ", "/maintain ", "/calibrate ", "/outputs ", "/inbox ", "/journal ", "/week ", "/clear", "/history", "/init ", "/help"]);
assert.ok(knowledgeCommandOptions("").some((item) => item.text === "/maintain "));
assert.ok(knowledgeCommandOptions("").some((item) => item.text === "/history"));
assert.ok(knowledgeCommandOptions("").some((item) => item.text === "/clear"));
assert.deepEqual(parseKnowledgeBaseCommand("Harness Engineering 和 Vibe Coding 有什么关系？").intent, "chat");
assert.equal(shouldHandleKnowledgeBaseCommand("Harness Engineering 和 Vibe Coding 有什么关系？"), false);
assert.equal(shouldHandleKnowledgeBaseCommand("/ask Harness Engineering 和 Vibe Coding 有什么关系？"), true);
assert.equal(composerPrimaryActionForState({ viewRunning: true, knowledgeTaskRunning: false, hasDraft: false, hasQueuedItems: false }), "stop-turn");
assert.equal(composerPrimaryActionForState({ viewRunning: true, knowledgeTaskRunning: false, hasDraft: true, hasQueuedItems: false }), "enqueue");
assert.equal(composerPrimaryActionForState({ viewRunning: true, knowledgeTaskRunning: true, hasDraft: false, hasQueuedItems: false }), "stop-turn");
assert.equal(composerPrimaryActionForState({ viewRunning: true, knowledgeTaskRunning: true, hasDraft: true, hasQueuedItems: false }), "enqueue");
assert.equal(composerPrimaryActionForState({ viewRunning: false, knowledgeTaskRunning: true, hasDraft: true, hasQueuedItems: false }), "enqueue");
assert.equal(composerPrimaryActionForState({ viewRunning: false, knowledgeTaskRunning: true, hasDraft: false, hasQueuedItems: false }), "cancel-knowledge-task");
assert.equal(composerPrimaryActionForState({ viewRunning: false, knowledgeTaskRunning: false, hasDraft: false, hasQueuedItems: false }), "send");
assert.equal(composerPrimaryActionForState({ viewRunning: false, knowledgeTaskRunning: false, hasDraft: false, hasQueuedItems: true }), "resume-queue");
assert.equal(composerPrimaryActionForState({ viewRunning: false, knowledgeTaskRunning: false, hasDraft: true, hasQueuedItems: true }), "enqueue");
assert.equal(composerPrimaryActionForRuntimeState({ viewRunning: false, globalKnowledgeTaskRunning: true, hasDraft: true, hasQueuedItems: false }), "enqueue");
assert.equal(composerPrimaryActionForRuntimeState({ viewRunning: false, globalKnowledgeTaskRunning: true, hasDraft: false, hasQueuedItems: false }), "cancel-knowledge-task");
assert.equal(composerPrimaryActionForRuntimeState({ viewRunning: true, globalKnowledgeTaskRunning: true, hasDraft: false, hasQueuedItems: false }), "stop-turn");
assert.equal(canStartQueuedTurn({ queueStartInProgress: false, viewRunning: false, knowledgeTaskRunning: false }), true);
assert.equal(canStartQueuedTurn({ queueStartInProgress: true, viewRunning: false, knowledgeTaskRunning: false }), false);
assert.equal(canStartQueuedTurn({ queueStartInProgress: false, viewRunning: true, knowledgeTaskRunning: false }), false);
assert.equal(canStartQueuedTurn({ queueStartInProgress: false, viewRunning: false, knowledgeTaskRunning: true }), false);
const menuTarget = {} as Node;
const rootOnlyTarget = {} as Node;
const outsideTarget = {} as Node;
const fakeRoot = { contains: (target: Node | null) => target === menuTarget || target === rootOnlyTarget };
const fakeMenu = { contains: (target: Node | null) => target === menuTarget };
assert.equal(shouldCloseComposerMenusForClick(menuTarget, fakeRoot, [fakeMenu]), false);
assert.equal(shouldCloseComposerMenusForClick(rootOnlyTarget, fakeRoot, [fakeMenu]), true);
assert.equal(shouldCloseComposerMenusForClick(outsideTarget, fakeRoot, [fakeMenu]), true);
assert.equal(shouldCloseComposerMenusForClick(null, fakeRoot, [fakeMenu]), false);

function queuedTurn(id: string, sessionId: string, text: string): QueuedTurnItem {
  return {
    id,
    sessionId,
    text,
    attachments: [],
    skill: null,
    turnOptions: {
      model: "gpt-test",
      reasoning: "high",
      serviceTier: "fast",
      permission: "workspace-write",
      mode: "agent",
      mcpEnabled: false,
      workspaceResources: { plugins: {}, mcpServers: {}, skills: {} }
    },
    kind: "chat",
    createdAt: Date.now()
  };
}

const queue = new RuntimeTurnQueue();
queue.enqueue(queuedTurn("a", "s1", "first"));
queue.enqueue(queuedTurn("b", "s1", "second"));
queue.enqueue(queuedTurn("c", "s2", "other session"));
assert.deepEqual(queue.itemsForSession("s1").map((item) => item.id), ["a", "b"]);
assert.deepEqual(queue.itemsForSession("s2").map((item) => item.id), ["c"]);
assert.equal(queue.hasQueuedItems("s1"), true);
assert.equal(queue.hasQueuedItems("missing"), false);
assert.equal(queue.reorderQueuedItem("s1", "b", 0), true);
assert.deepEqual(queue.itemsForSession("s1").map((item) => item.id), ["b", "a"]);
assert.equal(queue.removeQueuedItem("s1", "a"), true);
assert.deepEqual(queue.itemsForSession("s1").map((item) => item.id), ["b"]);
queue.pauseSessionQueue("s1");
assert.equal(queue.isSessionQueuePaused("s1"), true);
assert.equal(queue.dequeueNext("s1"), null);
queue.resumeSessionQueue("s1");
assert.equal(queue.isSessionQueuePaused("s1"), false);
assert.equal(queue.dequeueNext("s1")?.id, "b");
assert.equal(queue.hasQueuedItems("s1"), false);
queue.enqueue(queuedTurn("d", "s1", "deleted session item"));
queue.clearSessionQueue("s1");
assert.equal(queue.hasQueuedItems("s1"), false);
const settlementQueue = new RuntimeTurnQueue();
assert.equal(settlementQueue.settleSessionQueue("s1", true), "idle");
assert.equal(settlementQueue.settleSessionQueue("s1", false), "idle");
settlementQueue.enqueue(queuedTurn("settle-a", "s1", "next after success"));
assert.equal(settlementQueue.settleSessionQueue("s1", true), "continue");
assert.equal(settlementQueue.isSessionQueuePaused("s1"), false);
settlementQueue.enqueue(queuedTurn("settle-b", "s2", "pause after failure"));
assert.equal(settlementQueue.settleSessionQueue("s2", false), "paused");
assert.equal(settlementQueue.isSessionQueuePaused("s2"), true);
assert.equal(settlementQueue.dequeueNext("s2"), null);
settlementQueue.resumeSessionQueue("s2");
assert.equal(settlementQueue.dequeueNext("s2")?.id, "settle-b");
const throwingQueueViewQueue = new RuntimeTurnQueue();
throwingQueueViewQueue.enqueue(queuedTurn("throw-a", "throw-session", "failing queued turn"));
throwingQueueViewQueue.enqueue(queuedTurn("throw-b", "throw-session", "remaining queued turn"));
const throwingQueueView: any = {
  queueStartInProgress: false,
  running: false,
  plugin: { getKnowledgeBaseManager: () => ({ isRunning: false }) },
  turnQueue: throwingQueueViewQueue,
  renderQueue: () => undefined,
  renderToolbar: () => undefined,
  startQueuedTurnItem: async () => {
    throw new Error("post-run save failed");
  },
  startQueuedTurnItemSafely: (CodexView.prototype as any).startQueuedTurnItemSafely,
  startNextQueuedTurn: (CodexView.prototype as any).startNextQueuedTurn,
  afterTurnSettled: (CodexView.prototype as any).afterTurnSettled
};
let throwingQueueViewError: unknown = null;
try {
  await throwingQueueView.startNextQueuedTurn("throw-session");
} catch (error) {
  throwingQueueViewError = error;
}
assert.equal(throwingQueueViewError, null);
assert.equal(throwingQueueView.queueStartInProgress, false);
assert.equal(throwingQueueViewQueue.isSessionQueuePaused("throw-session"), true);
assert.deepEqual(throwingQueueViewQueue.itemsForSession("throw-session").map((item) => item.id), ["throw-b"]);
const backgroundKnowledgeNotificationSession = {
  id: "chat-during-background-kb",
  title: "普通会话",
  kind: "chat" as const,
  cwd: "/vault",
  messages: [] as any[],
  createdAt: Date.now(),
  updatedAt: Date.now()
};
const backgroundKnowledgeNotificationView: any = {
  activeRunKind: "chat",
  activeRunId: "chat-run",
  activeRunSessionId: backgroundKnowledgeNotificationSession.id,
  activeTurnId: "chat-turn",
  activeItemMessages: new Map(),
  plugin: {
    settings: {
      sessions: [backgroundKnowledgeNotificationSession],
      activeSessionId: backgroundKnowledgeNotificationSession.id
    },
    getVaultPath: () => "/vault",
    saveSettings: async () => undefined
  },
  ensureSession: () => backgroundKnowledgeNotificationSession,
  handleKnowledgeBaseCodexNotification: (CodexView.prototype as any).handleKnowledgeBaseCodexNotification,
  handleCodexNotification: (CodexView.prototype as any).handleCodexNotification,
  handleEditorActionNotification: () => false,
  activeRunSession: (CodexView.prototype as any).activeRunSession,
  isKnowledgeBaseSession: () => false,
  markThinkingAsStreaming: () => undefined,
  appendItemDelta: (CodexView.prototype as any).appendItemDelta,
  renderMessagesIfActive: () => undefined,
  applyStatus: () => undefined,
  diagnoseCodexFailure: () => ({ title: "失败", text: "失败" })
};
const backgroundKnowledgeForwarded = backgroundKnowledgeNotificationView.handleKnowledgeBaseCodexNotification({
  method: "item/agentMessage/delta",
  params: { threadId: "kb-thread", turnId: "kb-turn", itemId: "kb-item", delta: "后台维护输出" }
} as any);
assert.equal(backgroundKnowledgeForwarded, false);
assert.equal(backgroundKnowledgeNotificationSession.messages.length, 0);
const foregroundKnowledgeNotificationSession = {
  ...backgroundKnowledgeNotificationSession,
  id: "foreground-kb-session",
  kind: "knowledge-base" as const,
  messages: [] as any[]
};
const foregroundKnowledgeNotificationView: any = {
  ...backgroundKnowledgeNotificationView,
  activeRunKind: "knowledge-base",
  activeRunId: "kb-run",
  activeRunSessionId: foregroundKnowledgeNotificationSession.id,
  activeTurnId: "kb-turn",
  activeItemMessages: new Map(),
  plugin: {
    settings: {
      sessions: [foregroundKnowledgeNotificationSession],
      activeSessionId: foregroundKnowledgeNotificationSession.id
    },
    getVaultPath: () => "/vault",
    saveSettings: async () => undefined
  },
  ensureSession: () => foregroundKnowledgeNotificationSession,
  isKnowledgeBaseSession: () => true
};
const foregroundKnowledgeForwarded = foregroundKnowledgeNotificationView.handleKnowledgeBaseCodexNotification({
  method: "item/agentMessage/delta",
  params: { threadId: "kb-thread", turnId: "kb-turn", itemId: "kb-item", delta: "前台知识库输出" }
} as any);
assert.equal(foregroundKnowledgeForwarded, true);
assert.equal(foregroundKnowledgeNotificationSession.messages.length, 0);
const knowledgeFinalizeSession = {
  id: "kb-finalize-session",
  title: KNOWLEDGE_BASE_SESSION_TITLE,
  kind: "knowledge-base" as const,
  cwd: "/vault",
  messages: [] as any[],
  createdAt: Date.now(),
  updatedAt: Date.now()
};
const knowledgeFinalizeItem: QueuedTurnItem = {
  ...queuedTurn("kb-finalize-item", knowledgeFinalizeSession.id, "/check final save"),
  kind: "knowledge-base"
};
let knowledgeFinalizeSaveCalls = 0;
let knowledgeFinalizeRenderMessagesCalls = 0;
let knowledgeFinalizeToolbarCalls = 0;
let knowledgeFinalizeApplyStatusCalls = 0;
const knowledgeFinalizeView: any = {
  plugin: {
    settings: { activeSessionId: knowledgeFinalizeSession.id },
	    getKnowledgeBaseManager: () => ({
	      handleUserMessage: async () => ({ status: "success", message: "体检完成" })
	    }),
	    externalizeMessageText: async () => undefined,
	    archivePendingKnowledgeBaseThreads: async () => 0,
	    saveSettings: async () => {
	      knowledgeFinalizeSaveCalls += 1;
	      if (knowledgeFinalizeSaveCalls === 2) throw new Error("final save failed");
	    }
  },
  activeRunId: "",
  activeRunKind: "",
  activeRunSessionId: "",
  activeTurnId: "",
  activeItemMessages: new Map(),
  running: false,
  renderTabs: () => undefined,
  renderMessagesIfActive: () => undefined,
  renderToolbar: () => { knowledgeFinalizeToolbarCalls += 1; },
  renderMessages: () => { knowledgeFinalizeRenderMessagesCalls += 1; },
  applyStatus: () => { knowledgeFinalizeApplyStatusCalls += 1; },
  refreshKnowledgeDashboard: async () => undefined,
  clearTurnWatchdog: () => undefined,
  clearActiveRun: (CodexView.prototype as any).clearActiveRun,
  moveMessageToEnd: (CodexView.prototype as any).moveMessageToEnd,
  finishThinkingMessage: () => undefined,
  finishRunningProcessMessages: () => undefined,
  finishPlanMessage: () => undefined,
  startKnowledgeBaseTurn: (CodexView.prototype as any).startKnowledgeBaseTurn
};
let knowledgeFinalizeError: unknown = null;
try {
  await knowledgeFinalizeView.startKnowledgeBaseTurn(knowledgeFinalizeSession, knowledgeFinalizeItem, "queue");
} catch (error) {
  knowledgeFinalizeError = error;
}
assert.match(knowledgeFinalizeError instanceof Error ? knowledgeFinalizeError.message : String(knowledgeFinalizeError), /final save failed/);
assert.equal(knowledgeFinalizeView.running, false);
assert.equal(knowledgeFinalizeSession.messages.at(-1)?.status, "failed");
assert.equal(knowledgeFinalizeRenderMessagesCalls > 0, true);
assert.equal(knowledgeFinalizeToolbarCalls > 1, true);
assert.equal(knowledgeFinalizeApplyStatusCalls > 0, true);
assert.equal(knowledgeFinalizeSaveCalls, 3);
const knowledgeInitialSaveFailureSession = {
  id: "kb-initial-save-failure-session",
  title: KNOWLEDGE_BASE_SESSION_TITLE,
  kind: "knowledge-base" as const,
  cwd: "/vault",
  messages: [] as any[],
  createdAt: Date.now(),
  updatedAt: Date.now()
};
const knowledgeInitialSaveFailureItem: QueuedTurnItem = {
  ...queuedTurn("kb-initial-save-failure-item", knowledgeInitialSaveFailureSession.id, "/check initial save"),
  kind: "knowledge-base"
};
let knowledgeInitialSaveCalls = 0;
let knowledgeInitialHandleCalls = 0;
const knowledgeInitialSaveFailureView: any = {
  ...knowledgeFinalizeView,
  plugin: {
    settings: { activeSessionId: knowledgeInitialSaveFailureSession.id },
	    getKnowledgeBaseManager: () => ({
	      handleUserMessage: async () => {
	        knowledgeInitialHandleCalls += 1;
	        return { status: "success", message: "不应执行" };
	      }
	    }),
	    externalizeMessageText: async () => undefined,
	    archivePendingKnowledgeBaseThreads: async () => 0,
	    saveSettings: async () => {
	      knowledgeInitialSaveCalls += 1;
	      if (knowledgeInitialSaveCalls === 1) throw new Error("initial save failed");
	    }
  },
  running: false,
  activeRunId: "",
  activeRunKind: "",
  activeRunSessionId: "",
  activeTurnId: "",
  activeItemMessages: new Map()
};
let knowledgeInitialSaveFailureError: unknown = null;
try {
  await knowledgeInitialSaveFailureView.startKnowledgeBaseTurn(knowledgeInitialSaveFailureSession, knowledgeInitialSaveFailureItem, "queue");
} catch (error) {
  knowledgeInitialSaveFailureError = error;
}
assert.match(knowledgeInitialSaveFailureError instanceof Error ? knowledgeInitialSaveFailureError.message : String(knowledgeInitialSaveFailureError), /initial save failed/);
assert.equal(knowledgeInitialSaveFailureView.running, false);
assert.equal(knowledgeInitialHandleCalls, 0);
assert.equal(knowledgeInitialSaveFailureSession.messages.at(-1)?.status, "failed");
const knowledgeCanceledSession = {
  id: "kb-canceled-session",
  title: KNOWLEDGE_BASE_SESSION_TITLE,
  kind: "knowledge-base" as const,
  cwd: "/vault",
  messages: [] as any[],
  createdAt: Date.now(),
  updatedAt: Date.now()
};
const knowledgeCanceledView: any = {
  ...knowledgeFinalizeView,
  plugin: {
    settings: { activeSessionId: knowledgeCanceledSession.id },
	    getKnowledgeBaseManager: () => ({
	      handleUserMessage: async () => ({ status: "canceled", message: "知识库体检已取消。\n原因：用户取消" })
	    }),
	    externalizeMessageText: async () => undefined,
	    archivePendingKnowledgeBaseThreads: async () => 0,
	    saveSettings: async () => undefined
	  },
  running: false,
  activeRunId: "",
  activeRunKind: "",
  activeRunSessionId: "",
  activeTurnId: "",
  activeItemMessages: new Map()
};
const knowledgeCanceledOutcome = await knowledgeCanceledView.startKnowledgeBaseTurn(knowledgeCanceledSession, {
  ...queuedTurn("kb-canceled-item", knowledgeCanceledSession.id, "/check cancel"),
  kind: "knowledge-base"
}, "queue");
assert.equal(knowledgeCanceledOutcome, "failed");
assert.equal(knowledgeCanceledSession.messages.at(-1)?.status, "canceled");
assert.match(knowledgeCanceledSession.messages.at(-1)?.text ?? "", /已取消/);
const knowledgeContextBridgeSession = {
  id: "kb-context-bridge-session",
  title: KNOWLEDGE_BASE_SESSION_TITLE,
  kind: "knowledge-base" as const,
  cwd: "/vault",
  messages: [] as any[],
  createdAt: Date.now(),
  updatedAt: Date.now()
};
const knowledgeContextBridgeView: any = {
  ...knowledgeFinalizeView,
  plugin: {
    settings: { activeSessionId: knowledgeContextBridgeSession.id },
    getKnowledgeBaseManager: () => ({
      handleUserMessage: async () => ({
        status: "success",
        message: "Alpha 项目来自本地 Wiki，适合继续跟进。",
        citations: {
          status: "strong",
          counts: { wiki: 1, journal: 0, outputs: 0 },
          citations: [{
            bucket: "wiki",
            title: "GitHub 项目雷达",
            path: "wiki/projects/github-radar.md",
            excerptLines: ["Alpha 项目近期增长很快。"],
            relevance: "strong",
            reason: "命中项目名",
            score: 3
          }]
        }
      })
    }),
    externalizeMessageText: async () => undefined,
    archivePendingKnowledgeBaseThreads: async () => 0,
    saveSettings: async () => undefined
  },
  running: false,
  activeRunId: "",
  activeRunKind: "",
  activeRunSessionId: "",
  activeTurnId: "",
  activeItemMessages: new Map()
};
const knowledgeContextBridgeOutcome = await knowledgeContextBridgeView.startKnowledgeBaseTurn(knowledgeContextBridgeSession, {
  ...queuedTurn("kb-context-bridge-item", knowledgeContextBridgeSession.id, "/ask 最近有哪些 GitHub 项目？"),
  kind: "knowledge-base"
}, "queue");
assert.equal(knowledgeContextBridgeOutcome, "completed");
assert.equal((knowledgeContextBridgeSession as any).knowledgeContext?.length, 1);
assert.equal((knowledgeContextBridgeSession as any).knowledgeContext[0].intent, "ask");
assert.equal((knowledgeContextBridgeSession as any).knowledgeContext[0].command, "/ask 最近有哪些 GitHub 项目？");
assert.match((knowledgeContextBridgeSession as any).knowledgeContext[0].summary, /Alpha 项目/);
assert.match((knowledgeContextBridgeSession as any).knowledgeContext[0].summary, /wiki\/projects\/github-radar\.md/);
assert.match(knowledgeContextBridgeSession.messages.at(-1)?.details ?? "", /已保存为后续上下文摘要/);

const failedKnowledgeContextSession = {
  id: "kb-context-failed-session",
  title: KNOWLEDGE_BASE_SESSION_TITLE,
  kind: "knowledge-base" as const,
  cwd: "/vault",
  messages: [] as any[],
  createdAt: Date.now(),
  updatedAt: Date.now()
};
const failedKnowledgeContextView: any = {
  ...knowledgeContextBridgeView,
  plugin: {
    ...knowledgeContextBridgeView.plugin,
    settings: { activeSessionId: failedKnowledgeContextSession.id },
    getKnowledgeBaseManager: () => ({
      handleUserMessage: async () => ({ status: "failed", message: "知识库任务失败" })
    })
  },
  running: false,
  activeRunId: "",
  activeRunKind: "",
  activeRunSessionId: "",
  activeTurnId: "",
  activeItemMessages: new Map()
};
await failedKnowledgeContextView.startKnowledgeBaseTurn(failedKnowledgeContextSession, {
  ...queuedTurn("kb-context-failed-item", failedKnowledgeContextSession.id, "/ask 失败问题"),
  kind: "knowledge-base"
}, "queue");
assert.equal((failedKnowledgeContextSession as any).knowledgeContext, undefined);

const knowledgeContextChatSession = {
  id: "kb-context-chat-session",
  title: KNOWLEDGE_BASE_SESSION_TITLE,
  kind: "knowledge-base" as const,
  cwd: "/vault",
  threadId: "thread-chat",
  messages: [] as any[],
  knowledgeContext: [{
    id: "ctx-alpha",
    intent: "ask",
    command: "/ask Alpha",
    summary: "Alpha 项目来自本地 Wiki，适合继续跟进。",
    sourceMessageId: "assistant-alpha",
    createdAt: 1,
    injectedThreadIds: [] as string[]
  }],
  createdAt: Date.now(),
  updatedAt: Date.now()
};
let capturedKnowledgeContextInput: any[] = [];
const knowledgeContextChatView: any = {
  plugin: {
    ensureCodexConnected: async () => ({ connected: true, accountLabel: "Codex", loggedIn: true, models: [], skills: [], mcpServers: [], errors: [] }),
    codex: {
      resumeThread: async () => undefined,
      startThread: async () => ({ threadId: "thread-new", title: "KB" }),
      startTurn: async (_threadId: string, input: any[]) => {
        capturedKnowledgeContextInput = input;
        return "turn-chat";
      }
    },
    externalizeMessageText: async () => undefined,
    saveSettings: async () => undefined
  },
  running: false,
  activeRunId: "",
  activeRunKind: "",
  activeRunSessionId: "",
  activeTurnId: "",
  threadPrewarmPromise: null,
  threadPrewarmSessionId: "",
  applyStatus: () => undefined,
  ensureThinkingMessage: () => undefined,
  armTurnWatchdog: () => undefined,
  finishThinkingMessage: () => undefined,
  addMessageToSession: (CodexView.prototype as any).addMessageToSession,
  clearTurnWatchdog: () => undefined,
  clearActiveRun: (CodexView.prototype as any).clearActiveRun,
  attachTurnIdToRun: () => undefined,
  renderTabs: () => undefined,
  renderMessagesIfActive: () => undefined,
  renderToolbar: () => undefined,
  diagnoseCodexFailure: () => ({ title: "失败", text: "失败" }),
  isKnowledgeBaseSession: () => true,
  startChatTurn: (CodexView.prototype as any).startChatTurn
};
const knowledgeContextChatOutcome = await knowledgeContextChatView.startChatTurn(knowledgeContextChatSession, {
  ...queuedTurn("kb-context-chat-item", knowledgeContextChatSession.id, "继续讲这个项目"),
  kind: "chat"
}, "queue");
assert.equal(knowledgeContextChatOutcome, "running");
const injectedKnowledgeContextText = capturedKnowledgeContextInput.map((item) => item.text ?? "").join("\n");
assert.match(injectedKnowledgeContextText, /Alpha 项目来自本地 Wiki/);
assert.match(injectedKnowledgeContextText, /继续讲这个项目/);
assert.deepEqual((knowledgeContextChatSession as any).knowledgeContext[0].injectedThreadIds, ["thread-chat"]);

capturedKnowledgeContextInput = [];
await knowledgeContextChatView.startChatTurn(knowledgeContextChatSession, {
  ...queuedTurn("kb-context-chat-item-2", knowledgeContextChatSession.id, "再继续"),
  kind: "chat"
}, "queue");
assert.doesNotMatch(capturedKnowledgeContextInput.map((item) => item.text ?? "").join("\n"), /Alpha 项目来自本地 Wiki/);

const knowledgeContextResumeFailureSession = {
  ...knowledgeContextChatSession,
  id: "kb-context-resume-failure-session",
  threadId: "thread-old",
  messages: [] as any[],
  knowledgeContext: [{
    ...(knowledgeContextChatSession as any).knowledgeContext[0],
    injectedThreadIds: ["thread-old"]
  }]
};
let capturedResumeFailureInput: any[] = [];
const knowledgeContextResumeFailureView: any = {
  ...knowledgeContextChatView,
  plugin: {
    ...knowledgeContextChatView.plugin,
    codex: {
      resumeThread: async () => { throw new Error("resume failed"); },
      startThread: async () => ({ threadId: "thread-new", title: "KB" }),
      startTurn: async (_threadId: string, input: any[]) => {
        capturedResumeFailureInput = input;
        return "turn-new";
      }
    }
  },
  running: false,
  activeRunId: "",
  activeRunKind: "",
  activeRunSessionId: "",
  activeTurnId: ""
};
await knowledgeContextResumeFailureView.startChatTurn(knowledgeContextResumeFailureSession, {
  ...queuedTurn("kb-context-resume-failure-item", knowledgeContextResumeFailureSession.id, "新线程继续"),
  kind: "chat"
}, "queue");
assert.equal(knowledgeContextResumeFailureSession.threadId, "thread-new");
assert.match(capturedResumeFailureInput.map((item) => item.text ?? "").join("\n"), /Alpha 项目来自本地 Wiki/);
assert.deepEqual((knowledgeContextResumeFailureSession as any).knowledgeContext[0].injectedThreadIds, ["thread-old", "thread-new"]);
assert.equal(composerIsBusy({ viewRunning: true, knowledgeTaskRunning: false }), true);
assert.deepEqual(parseKnowledgeBaseCommand("/init").intent, "init");
assert.deepEqual((parseKnowledgeBaseCommand("/init confirm") as any).confirm, true);
assert.deepEqual((parseKnowledgeBaseCommand("/初始化 确认") as any).confirm, true);
assert.deepEqual((parseKnowledgeBaseCommand("/init 先预览，不确认") as any).confirm, false);
assert.deepEqual(parseKnowledgeBaseCommand("写日记：今天测试知识库频道").intent, "journal");
assert.equal(stripJournalPrefix("/journal 写一下今天的日记。"), "写一下今天的日记。");
assert.deepEqual(parseKnowledgeBaseCommand("处理 inbox").intent, "process-inbox");
assert.deepEqual(parseKnowledgeBaseCommand("处理 outputs").intent, "process-outputs");
assert.deepEqual(parseKnowledgeBaseCommand("收集这个链接 https://example.com/a").target, "raw-articles");
assert.deepEqual(parseKnowledgeBaseCommand("记一下：这个想法很重要").target, "inbox");
assert.deepEqual(parseKnowledgeBaseCommand("收集这个 PDF", 1).target, "raw-attachments");
assert.deepEqual(parseKnowledgeBaseCommand("这是当前笔记上下文，请帮我总结", 1).intent, "chat");
assert.deepEqual(parseKnowledgeBaseCommand("今天知识库状态怎么样").intent, "chat");

const hiddenHistorySettings = normalizeSettingsData({
  sessions: [
    {
      id: "kb-history",
      title: KNOWLEDGE_BASE_SESSION_TITLE,
      kind: "knowledge-base",
      cwd: "/vault",
      threadId: "thread-old",
      messagesHiddenBefore: 20,
      tokenUsage: { total: { totalTokens: 99 } },
      messages: [
        { id: "old-user", role: "user", text: "/help", createdAt: 10 },
        { id: "old-assistant", role: "assistant", text: "帮助", createdAt: 20 },
        { id: "new-user", role: "user", text: "新问题", createdAt: 21 }
      ],
      createdAt: 1,
      updatedAt: 2
    }
  ],
  activeSessionId: "kb-history",
  knowledgeBase: { sessionId: "kb-history" }
}).settings;
const normalizedHistorySession = hiddenHistorySettings.sessions[0];
assert.equal(normalizedHistorySession.messagesHiddenBefore, 20);
assert.deepEqual(getVisibleKnowledgeBaseMessages(normalizedHistorySession).map((message) => message.id), ["new-user"]);
assert.deepEqual(getHiddenKnowledgeBaseMessages(normalizedHistorySession).map((message) => message.id), ["old-user", "old-assistant"]);

const clearableHistorySession = {
  ...normalizedHistorySession,
  threadId: "thread-old",
  tokenUsage: { total: { totalTokens: 99 } },
  knowledgeContext: [{
    id: "ctx-old",
    intent: "ask",
    command: "/ask old",
    summary: "旧知识库上下文",
    sourceMessageId: "old-assistant",
    createdAt: 12,
    injectedThreadIds: ["thread-old"]
  }],
  messagesHiddenBefore: undefined,
  messages: [...normalizedHistorySession.messages]
};
const clearResult = clearKnowledgeBaseVisibleHistory(clearableHistorySession, 15);
assert.equal(clearResult.hiddenCount, 3);
assert.equal(clearableHistorySession.messages.length, 3);
assert.equal(clearableHistorySession.threadId, undefined);
assert.equal(clearableHistorySession.tokenUsage, undefined);
assert.equal((clearableHistorySession as any).knowledgeContext, undefined);
assert.equal(clearableHistorySession.messagesHiddenBefore, 21);
assert.deepEqual(getVisibleKnowledgeBaseMessages(clearableHistorySession).map((message) => message.id), []);
assert.deepEqual(getHiddenKnowledgeBaseMessages(clearableHistorySession).map((message) => message.id), ["old-user", "old-assistant", "new-user"]);
restoreKnowledgeBaseVisibleHistory(clearableHistorySession);
assert.equal(clearableHistorySession.messagesHiddenBefore, undefined);
assert.deepEqual(getVisibleKnowledgeBaseMessages(clearableHistorySession).map((message) => message.id), ["old-user", "old-assistant", "new-user"]);
const duplicateKnowledgeRunSession = {
  id: "kb-duplicate-run-session",
  title: KNOWLEDGE_BASE_SESSION_TITLE,
  kind: "knowledge-base" as const,
  cwd: "/vault",
  messages: [
    { id: "dup-user", role: "user", text: "/ask duplicate", runId: "kb-run-dup", createdAt: 1 },
    { id: "dup-assistant-1", role: "assistant", title: "回复", itemType: "assistant", text: "过程回答", runId: "kb-run-dup", createdAt: 2 },
    { id: "dup-tool", role: "tool", title: "查看文件", itemType: "commandExecution", text: "工具输出", runId: "kb-run-dup", status: "completed", createdAt: 3 },
    { id: "dup-thinking", role: "assistant", title: "生成中", itemType: "thinking", text: "正在生成", runId: "kb-run-dup", status: "running", createdAt: 4 },
    { id: "dup-final", role: "assistant", title: "知识库管理", itemType: "knowledgeBase", text: "最终答案", runId: "kb-run-dup", status: "completed", createdAt: 5 },
    { id: "other-assistant", role: "assistant", title: "回复", itemType: "assistant", text: "别的普通回复", runId: "chat-run", createdAt: 6 }
  ] as any[],
  createdAt: 1,
  updatedAt: 6
};
assert.deepEqual(getDisplayKnowledgeBaseMessages(duplicateKnowledgeRunSession).map((message) => message.id), ["dup-user", "dup-final", "other-assistant"]);

const may18 = new Date(2026, 4, 18, 23, 0, 0).getTime();
const may19 = new Date(2026, 4, 19, 1, 0, 0).getTime();
const crossDayHistorySession = normalizeSettingsData({
  sessions: [{
    id: "kb-cross-day",
    title: KNOWLEDGE_BASE_SESSION_TITLE,
    kind: "knowledge-base",
    cwd: "/vault",
    historyActiveDate: "2026-05-19",
    messages: [
      { id: "day-18", role: "user", text: "旧日", createdAt: may18 },
      { id: "day-19", role: "assistant", text: "今日", createdAt: may19 }
    ],
    createdAt: may18,
    updatedAt: may19
  }],
  knowledgeBase: { sessionId: "kb-cross-day" }
}).settings.sessions[0];
assert.equal(crossDayHistorySession.historyActiveDate, "2026-05-19");
assert.equal(latestKnowledgeBaseMessageDate(crossDayHistorySession.messages), "2026-05-19");
assert.deepEqual(filterKnowledgeBaseMessagesForDate(crossDayHistorySession.messages, "2026-05-18").map((message) => message.id), ["day-18"]);
assert.deepEqual(getVisibleKnowledgeBaseMessages(crossDayHistorySession).map((message) => message.id), ["day-19"]);
assert.equal(clearableHistorySession.threadId, undefined);

const may21 = new Date(2026, 4, 21, 10, 0, 0).getTime();
const activeHistoryWithTodaySession = normalizeSettingsData({
  sessions: [{
    id: "kb-active-with-today",
    title: KNOWLEDGE_BASE_SESSION_TITLE,
    kind: "knowledge-base",
    cwd: "/vault",
    historyActiveDate: "2026-05-19",
    messages: [
      { id: "recent-19", role: "assistant", text: "最近一天详情", createdAt: may19 },
      { id: "today-21", role: "user", text: "/maintain", createdAt: may21 }
    ],
    createdAt: may19,
    updatedAt: may21
  }],
  knowledgeBase: { sessionId: "kb-active-with-today" }
}).settings.sessions[0];
compactKnowledgeBaseMessagesToActiveDay(activeHistoryWithTodaySession, may21);
assert.equal(activeHistoryWithTodaySession.historyActiveDate, "2026-05-19");
assert.deepEqual(activeHistoryWithTodaySession.messages.map((message) => message.id), ["recent-19", "today-21"]);
assert.deepEqual(getVisibleKnowledgeBaseMessages(activeHistoryWithTodaySession, may21).map((message) => message.id), ["recent-19", "today-21"]);

const alreadySwitchedToTodaySession = normalizeSettingsData({
  sessions: [{
    id: "kb-already-today",
    title: KNOWLEDGE_BASE_SESSION_TITLE,
    kind: "knowledge-base",
    cwd: "/vault",
    historyActiveDate: "2026-05-21",
    messages: [
      { id: "recent-19", role: "assistant", text: "最近一天详情", createdAt: may19 },
      { id: "today-21", role: "user", text: "/maintain", createdAt: may21 }
    ],
    createdAt: may19,
    updatedAt: may21
  }],
  knowledgeBase: { sessionId: "kb-already-today" }
}).settings.sessions[0];
compactKnowledgeBaseMessagesToActiveDay(alreadySwitchedToTodaySession, may21);
assert.equal(alreadySwitchedToTodaySession.historyActiveDate, "2026-05-19");
assert.deepEqual(getVisibleKnowledgeBaseMessages(alreadySwitchedToTodaySession, may21).map((message) => message.id), ["recent-19", "today-21"]);

const reviewEvidenceSettings = normalizeSettingsData({
  settingsVersion: DEFAULT_SETTINGS.settingsVersion,
  knowledgeBase: {
    sessionId: "kb-review",
    lastRunAt: Date.parse("2026-05-17T08:00:00+08:00"),
    lastRunStatus: "success",
    lastReportPath: "outputs/kb-maintenance-2026-05-17.md",
    lastSummary: "知识库体检完成"
  },
  sessions: [
    {
      id: "kb-review",
      title: KNOWLEDGE_BASE_SESSION_TITLE,
      kind: "knowledge-base",
      cwd: "/vault",
      messages: [
        { id: "kb-u-1", role: "user", text: "/check 只看断链", createdAt: Date.parse("2026-05-17T08:00:00+08:00") },
        { id: "kb-a-1", role: "assistant", itemType: "knowledgeBase", status: "completed", text: "完成", createdAt: Date.parse("2026-05-17T08:02:00+08:00") },
        { id: "kb-u-2", role: "user", text: "/ask 知识库状态怎么样？", createdAt: Date.parse("2026-05-17T09:00:00+08:00") }
      ],
      createdAt: Date.parse("2026-05-17T08:00:00+08:00"),
      updatedAt: Date.parse("2026-05-17T09:00:00+08:00")
    },
    {
      id: "chat-review",
      title: "普通 Agent 对话",
      cwd: "/project",
      tokenUsage: { total: { totalTokens: 12345 }, last: { totalTokens: 345 }, modelContextWindow: 200000 },
      messages: [
        { id: "chat-u-1", role: "user", text: "请先判断这个需求是否成立，再给验收标准。", createdAt: Date.parse("2026-05-17T10:00:00+08:00") },
        { id: "chat-a-1", role: "assistant", text: "结论", createdAt: Date.parse("2026-05-17T10:01:00+08:00") },
        { id: "chat-p-1", role: "tool", itemType: "commandExecution", status: "completed", text: "npm test", createdAt: Date.parse("2026-05-17T10:02:00+08:00") },
        { id: "chat-s-1", role: "system", itemType: "contextCompaction", text: "压缩", createdAt: Date.parse("2026-05-17T10:03:00+08:00") }
      ],
      createdAt: Date.parse("2026-05-17T10:00:00+08:00"),
      updatedAt: Date.parse("2026-05-17T10:03:00+08:00")
    }
  ]
}).settings;
const reviewEvidenceRange = currentReviewRange(new Date("2026-05-17T21:00:00+08:00"));
const agentEvidence = collectAgentChatReviewEvidence(reviewEvidenceSettings, reviewEvidenceRange);
assert.equal(agentEvidence.sessionCount, 1);
assert.equal(agentEvidence.userMessageCount, 1);
assert.equal(agentEvidence.totalTokens, 12345);
assert.equal(agentEvidence.contextCompactionCount, 1);
assert.equal(agentEvidence.toolEventCount, 1);
assert.equal(agentEvidence.promptSamples[0].text, "请先判断这个需求是否成立，再给验收标准。");
const kbEvidence = collectKnowledgeBaseReviewEvidence(reviewEvidenceSettings, reviewEvidenceRange, {
  dashboard: { healthScore: 96, rawCount: 12, wikiCount: 8, outputsCount: 4, inboxCount: 1, latestReportPath: "outputs/kb-maintenance-2026-05-17.md" },
  maintenanceReports: [{ path: "outputs/kb-maintenance-2026-05-17.md", excerpt: "一眼结论：健康。" }]
});
assert.equal(kbEvidence.messageCount, 3);
assert.equal(kbEvidence.commandCounts.lint, 1);
assert.equal(kbEvidence.commandCounts.ask, 1);
assert.equal(kbEvidence.dashboard.healthScore, 96);
assert.equal(kbEvidence.maintenanceReports[0].path, "outputs/kb-maintenance-2026-05-17.md");
assert.equal(reportBaseName("knowledge-base", reviewEvidenceRange), "knowledge-base-review-2026-05-11-to-2026-05-17");
assert.equal(reportBaseName("agent-chat", reviewEvidenceRange), "agent-chat-review-2026-05-11-to-2026-05-17");
assert.equal(REVIEW_OUTPUT_DIR, "outputs");
assert.equal(DEFAULT_REVIEW_OUTPUT_DIR, "outputs");
const agentDocs = buildReviewDocuments("agent-chat", reviewEvidenceRange, agentEvidence);
assert.ok(agentDocs.markdown.startsWith("---\ncreated:"));
assert.ok(agentDocs.markdown.includes("[打开同名 HTML 看板](./agent-chat-review-2026-05-11-to-2026-05-17.html)"));
assert.ok(agentDocs.markdown.includes("### 4.2 问题决策"));
assert.ok(agentDocs.markdown.includes("### 6.2 坏习惯"));
assert.ok(agentDocs.html.includes("<h1>Agent 对话使用周复盘</h1>"));
assert.ok(agentDocs.html.includes("请先判断这个需求是否成立"));
const kbDocs = buildReviewDocuments("knowledge-base", reviewEvidenceRange, kbEvidence);
assert.ok(kbDocs.markdown.includes("# 知识库使用周复盘"));
assert.ok(kbDocs.markdown.includes("raw 12；wiki 8；outputs 4；inbox 1"));
assert.ok(kbDocs.markdown.includes("outputs/kb-maintenance-2026-05-17.md"));
assert.ok(kbDocs.html.includes("<h1>知识库使用周复盘</h1>"));
const emptyAgentDocs = buildReviewDocuments("agent-chat", reviewEvidenceRange, collectAgentChatReviewEvidence(normalizeSettingsData({
  settingsVersion: DEFAULT_SETTINGS.settingsVersion,
  sessions: []
}).settings, reviewEvidenceRange));
assert.ok(emptyAgentDocs.html.includes("<span class=\"pill\">提示词质量</span><h3>待观察</h3>"));

const kbRouteItems = new Set<string>();
const unknownOrphanDelta = routeKnowledgeBaseCodexNotification("item/agentMessage/delta", { itemId: "unknown-item", delta: "其他任务输出" }, {
  threadId: "thread-kb",
  turnId: "turn-kb",
  itemIds: kbRouteItems
});
assert.equal(unknownOrphanDelta.swallow, false);
assert.equal(unknownOrphanDelta.collectAssistantDelta, false);
const orphanStarted = routeKnowledgeBaseCodexNotification("item/started", { item: { id: "item-1" } }, {
  threadId: "thread-kb",
  turnId: "turn-kb",
  itemIds: kbRouteItems
});
assert.equal(orphanStarted.swallow, false);
assert.equal(orphanStarted.rememberItemId, undefined);
const orphanDelta = routeKnowledgeBaseCodexNotification("item/agentMessage/delta", { itemId: "item-1", delta: "报告" }, {
  threadId: "thread-kb",
  turnId: "turn-kb",
  itemIds: kbRouteItems
});
assert.equal(orphanDelta.swallow, false);
assert.equal(orphanDelta.collectAssistantDelta, false);
const orphanBeforeTurnStarted = routeKnowledgeBaseCodexNotification("item/started", { item: { id: "item-before-turn" } }, {
  threadId: "thread-kb",
  turnId: "",
  itemIds: kbRouteItems
});
assert.equal(orphanBeforeTurnStarted.swallow, true);
assert.equal(orphanBeforeTurnStarted.rememberItemId, "item-before-turn");
kbRouteItems.add(orphanBeforeTurnStarted.rememberItemId!);
const delayedOrphanDeltaAfterTurnKnown = routeKnowledgeBaseCodexNotification("item/agentMessage/delta", { itemId: "item-before-turn", delta: "可能是其他任务输出" }, {
  threadId: "thread-kb",
  turnId: "turn-kb",
  itemIds: kbRouteItems
});
assert.equal(delayedOrphanDeltaAfterTurnKnown.swallow, false);
assert.equal(delayedOrphanDeltaAfterTurnKnown.collectAssistantDelta, false);
const rememberedItemDifferentThread = routeKnowledgeBaseCodexNotification("item/agentMessage/delta", { threadId: "thread-other", itemId: "item-before-turn", delta: "其他 thread 输出" }, {
  threadId: "thread-kb",
  turnId: "turn-kb",
  itemIds: kbRouteItems
});
assert.equal(rememberedItemDifferentThread.swallow, false);
assert.equal(rememberedItemDifferentThread.collectAssistantDelta, false);
assert.equal(routeKnowledgeBaseCodexNotification("thread/tokenUsage/updated", { threadId: "thread-other" }, {
  threadId: "thread-kb",
  turnId: "turn-kb",
  itemIds: kbRouteItems
}).swallow, false);
assert.equal(routeKnowledgeBaseCodexNotification("turn/completed", { threadId: "thread-kb", turn: { id: "turn-other", status: "failed" } }, {
  threadId: "thread-kb",
  turnId: "turn-kb",
  itemIds: kbRouteItems
}).swallow, false);
assert.equal(routeKnowledgeBaseCodexNotification("turn/started", { threadId: "thread-kb", turn: { id: "turn-new" } }, {
  threadId: "thread-kb",
  turnId: "",
  itemIds: kbRouteItems
}).swallow, true);
assert.equal(routeKnowledgeBaseCodexNotification("turn/completed", { threadId: "thread-kb", turn: { id: "turn-new", status: "completed" } }, {
  threadId: "thread-kb",
  turnId: "",
  itemIds: kbRouteItems
}).swallow, false);
assert.equal(routeKnowledgeBaseCodexNotification("error", { message: "failed" }, {
  threadId: "thread-kb",
  turnId: "turn-kb",
  itemIds: kbRouteItems
}).swallow, false);

assert.deepEqual(buildCollaborationMode("agent", "gpt-5.4", "high"), null);
assert.deepEqual(buildCollaborationMode("plan", "gpt-5.4", "high"), {
  mode: "plan",
  settings: {
    model: "gpt-5.4",
    reasoning_effort: "high",
    developer_instructions: null
  }
});
assert.deepEqual(buildCollaborationMode("plan", "", "high"), {
  mode: "plan",
  settings: {
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
const manySkills = Array.from({ length: 15 }, (_, index) => ({
  name: `skill-${String(15 - index).padStart(2, "0")}`,
  description: "test skill",
  path: `/skills/${index}`,
  enabled: true
}));
const filteredManySkills = filterSkills(manySkills, "");
assert.equal(filteredManySkills.length, 15);
assert.deepEqual(
  filteredManySkills.map((skill) => skill.name),
  ["skill-01", "skill-02", "skill-03", "skill-04", "skill-05", "skill-06", "skill-07", "skill-08", "skill-09", "skill-10", "skill-11", "skill-12", "skill-13", "skill-14", "skill-15"]
);
assert.deepEqual(
  filterSkills([
    { name: "ask-claude", description: "Ask Claude", path: "/skills/ask-claude-a", enabled: true },
    { name: "ask-claude", description: "Ask Claude", path: "/skills/ask-claude-b", enabled: true },
    { name: "ask-gemini", description: "Ask Gemini", path: "/skills/ask-gemini", enabled: true }
  ], "").map((skill) => skill.name),
  ["ask-claude", "ask-gemini"]
);

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
  const expectedPath = path.join(clipboardVault, ".obsidian", "plugins", "codex-echoink", "clipboard", "clipboard-1700000000000-1.png");
  assert.deepEqual(attachment, {
    type: "image",
    name: "clipboard-1700000000000-1.png",
    path: expectedPath
  });
  assert.deepEqual(await readFile(expectedPath), Buffer.from([1, 2, 3]));
} finally {
  await rm(clipboardVault, { recursive: true, force: true });
}

const legacyRawVault = await mkdtemp(path.join(tmpdir(), "codex-legacy-raw-"));
try {
  assert.equal(pluginDataDir(legacyRawVault), path.join(legacyRawVault, ".obsidian", "plugins", "codex-echoink"));
  assert.equal(pluginDataDir(legacyRawVault, "custom-plugin-dir"), path.join(legacyRawVault, ".obsidian", "plugins", "custom-plugin-dir"));
  const legacyRawPath = path.join(legacyRawVault, ".obsidian", "plugins", "obsidian-codex", "raw", "legacy.txt");
  await mkdir(path.dirname(legacyRawPath), { recursive: true });
  await writeFile(legacyRawPath, "legacy raw text", "utf8");
  assert.equal(await readRawText(legacyRawVault, "raw/legacy.txt", "codex-echoink"), "legacy raw text");
  const currentRawPath = path.join(legacyRawVault, ".obsidian", "plugins", "codex-echoink", "raw", "legacy.txt");
  await mkdir(path.dirname(currentRawPath), { recursive: true });
  await writeFile(currentRawPath, "current raw text", "utf8");
  assert.equal(await readRawText(legacyRawVault, "raw/legacy.txt", "codex-echoink"), "current raw text");
} finally {
  await rm(legacyRawVault, { recursive: true, force: true });
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
const relativeVaultFile = normalizeProcessFileRef("notes/a.md", "/vault", "/vault");
assert.equal(relativeVaultFile.kind, "vault");
assert.equal(relativeVaultFile.path, "notes/a.md");
assert.equal(relativeVaultFile.absolutePath, path.normalize("/vault/notes/a.md"));
const relativeExternalFile = normalizeProcessFileRef("src/a.ts", "/vault", "/tmp/workspace");
assert.equal(relativeExternalFile.kind, "external");
assert.equal(relativeExternalFile.path, path.normalize("/tmp/workspace/src/a.ts"));
assert.equal(relativeExternalFile.absolutePath, path.normalize("/tmp/workspace/src/a.ts"));
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
assert.equal(summarizeProcessEvent("commandExecution", { command: "sed -n '1,20p' .codex-memory/current.md" }, "/vault").detail, "Read current.md");
assert.equal(summarizeProcessEvent("commandExecution", { command: "rg -n foo docs/sample.md" }, "/vault").detail, "搜索 sample.md");
assert.equal(summarizeProcessEvent("commandExecution", { command: "npm run typecheck" }, "/vault").detail, "已运行 npm run typecheck");
assert.equal(summarizeProcessEvent("fileChange", { changes: [{ path: "docs/sample.md" }] }, "/vault").title, "编辑文件");
assert.equal(summarizeProcessEvent("fileChange", { changes: [{ path: "docs/sample.md" }] }, "/vault").kind, "edit");
assert.equal(processGroupStateId([{ id: "a", runId: "run-1" }, { id: "b", runId: "run-1" }]), "group-run-1-a-b-2");
assert.notEqual(
  processGroupStateId([{ id: "a", runId: "run-1" }, { id: "b", runId: "run-1" }]),
  processGroupStateId([{ id: "c", runId: "run-1" }, { id: "d", runId: "run-1" }])
);
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
assert.equal(migratedSettings.settings.settingsVersion, DEFAULT_SETTINGS.settingsVersion);
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
assert.equal(persistedComposerSettings.settings.defaultModel, "");
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
assert.equal(migratedDefaultModelSettings.settings.settingsVersion, DEFAULT_SETTINGS.settingsVersion);
assert.equal(migratedDefaultModelSettings.settings.defaultModel, "");
assert.equal(migratedDefaultModelSettings.settings.defaultReasoning, "high");
assert.equal(migratedDefaultModelSettings.changed, true);

const customDefaultModelSettings = normalizeSettingsData({
  settingsVersion: 24,
  defaultModel: "custom-stable-model",
  apiProviders: [{
    id: "provider_demo",
    name: "Demo API",
    baseUrl: "https://api.example.com/v1",
    model: "gpt-5.4",
    models: ["gpt-5.4", "gpt-5.5"],
    apiKey: "test-key-demo"
  }]
});
assert.equal(customDefaultModelSettings.settings.defaultModel, "custom-stable-model");
assert.deepEqual(getApiProviderModels(customDefaultModelSettings.settings.apiProviders[0]), ["gpt-5.4", "gpt-5.5"]);

const workspaceResources = normalizeSettingsData({
  settingsVersion: 4,
  workspaceResources: {
    plugins: { "browser-use@openai-bundled": false },
    mcpServers: { paper: true },
    skills: { "/home/demo/.codex/skills/answer/SKILL.md": false }
  }
});
assert.equal(workspaceResources.settings.settingsVersion, DEFAULT_SETTINGS.settingsVersion);
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
const searchableResourceRows = [
  { key: "browser-use@openai-bundled", name: "Browser Use", meta: "Engineering · openai-bundled · 已安装", desc: "Control the in-app browser with Codex" },
  { key: "paper", name: "paper", meta: "3 个工具 · loggedIn", desc: "来自 Codex MCP 配置" },
  { key: "/Users/demo/.codex/skills/fix-bug/SKILL.md", name: "/fix-bug", meta: "repo · /Users/demo/.codex/skills/fix-bug/SKILL.md", desc: "处理缺陷、回归、崩溃" }
];
assert.deepEqual(filterWorkspaceResourceRows(searchableResourceRows, "browser").map((item) => item.name), ["Browser Use"]);
assert.deepEqual(filterWorkspaceResourceRows(searchableResourceRows, "loggedin").map((item) => item.name), ["paper"]);
assert.deepEqual(filterWorkspaceResourceRows(searchableResourceRows, "缺陷").map((item) => item.name), ["/fix-bug"]);
assert.deepEqual(filterWorkspaceResourceRows(searchableResourceRows, "repo fix").map((item) => item.name), ["/fix-bug"]);
assert.deepEqual(filterWorkspaceResourceRows(searchableResourceRows, "  ").map((item) => item.name), searchableResourceRows.map((item) => item.name));
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

const settingsStyles = await readFile(path.join(process.cwd(), "styles.css"), "utf8");
const codexViewSource = await readFile(path.join(process.cwd(), "src/ui/codex-view.ts"), "utf8");
const mainPluginSource = await readFile(path.join(process.cwd(), "src/main.ts"), "utf8");
const homeViewSource = await readFile(path.join(process.cwd(), "src/home/home-view.ts"), "utf8");
const resourceRowCss = cssRuleBody(settingsStyles, ".codex-resource-row");
const resourceRowContentCss = cssRuleBody(settingsStyles, ".codex-resource-row-content");
const resourceRowNameCss = cssRuleBody(settingsStyles, ".codex-resource-row-name");
const resourceSearchInputCss = cssRuleBody(settingsStyles, ".codex-resource-search-input");
const headerHistoryCss = cssRuleBody(settingsStyles, ".codex-header-history");
const homePageCss = cssRuleBody(settingsStyles, ".codex-home-page");
const homeTopGridCss = cssRuleBody(settingsStyles, ".codex-home-top-grid");
const homeCalendarCss = cssRuleBody(settingsStyles, ".codex-home-calendar");
const homeHeatmapCss = cssRuleBody(settingsStyles, ".codex-home-heatmap");
const homeTextLinkCss = cssRuleBody(settingsStyles, ".codex-home-text-link");
const homeCardGridCss = cssRuleBody(settingsStyles, ".codex-home-card-grid");
const knowledgeBaseDashboardCss = cssRuleBody(settingsStyles, ".codex-kb-dashboard");
const knowledgeBaseDashboardVisibleCss = cssRuleBody(settingsStyles, ".codex-kb-dashboard.is-visible");
const knowledgeBaseDashboardHeaderCss = cssRuleBody(settingsStyles, ".codex-kb-dashboard-header");
const knowledgeBaseDashboardSummaryCss = cssRuleBody(settingsStyles, ".codex-kb-dashboard-summary");
const knowledgeBaseDashboardDetailsCss = cssRuleBody(settingsStyles, ".codex-kb-dashboard-details");
const knowledgeBaseHealthTooltipCss = cssRuleBody(settingsStyles, ".codex-kb-health-tooltip");
const knowledgeBaseHealthTooltipTriggerCss = cssRuleBody(settingsStyles, ".codex-kb-health-tooltip-trigger");
const knowledgeBaseHealthTooltipPanelCss = cssRuleBody(settingsStyles, ".codex-kb-health-tooltip-panel");
const knowledgeBaseHealthTooltipBridgeCss = cssRuleBody(settingsStyles, ".codex-kb-health-tooltip-bridge");
const knowledgeBaseHealthTooltipBridgeVisibleCss = cssRuleBody(settingsStyles, ".codex-kb-health-tooltip-bridge.is-visible");
const processFileLinkCss = cssRuleBody(settingsStyles, ".codex-process-file-link");
const processIconCss = cssRuleBody(settingsStyles, ".codex-process-icon");
const processEditIconCss = cssRuleBody(settingsStyles, ".codex-process-kind-edit .codex-process-icon");
const settingsStatusErrorCss = cssRuleBody(settingsStyles, ".codex-settings-status-error");
const settingsStatusErrorBodyCss = cssRuleBody(settingsStyles, ".codex-settings-status-error-body");
const messageNoteLinkCss = cssRuleBody(settingsStyles, ".codex-message-note-link");
const knowledgeBaseResultTitleCss = cssRuleBody(settingsStyles, ".codex-kb-result-title");
const knowledgeBaseResultBodyCss = cssRuleBody(settingsStyles, ".codex-kb-result-body");
const knowledgeBaseResultSuccessCss = cssRuleBody(settingsStyles, ".codex-kb-result-title-success");
const knowledgeBaseResultFailedCss = cssRuleBody(settingsStyles, ".codex-kb-result-title-failed");
assert.match(codexViewSource, /codex-header-history/);
assert.match(codexViewSource, /title: "查看知识库历史"/);
assert.match(codexViewSource, /this\.messages = getDisplayKnowledgeBaseMessages/);
assert.doesNotMatch(codexViewSource, /codex-kb-dashboard-history/);
assert.match(mainPluginSource, /VIEW_TYPE_ECHOINK_HOME/);
assert.match(mainPluginSource, /id: "open-echoink-home"/);
assert.match(mainPluginSource, /activateHomeAndSidebar/);
assert.match(mainPluginSource, /ensureHomeWorkspaceSpace/);
assert.match(mainPluginSource, /rightSplit\.collapse/);
assert.match(mainPluginSource, /leftSplit\.collapse/);
assert.match(homeViewSource, /知识活动日历/);
assert.match(homeViewSource, /今日复盘/);
assert.match(homeViewSource, /按相关度/);
assert.match(homeViewSource, /openRefineCommand/);
assert.match(homeViewSource, /openReviewCommand/);
assert.equal(calendarMonthLabel(new Date(2026, 6, 1)), "2026年7月");
assert.equal(calendarMonthLabel(shiftCalendarMonth(new Date(2026, 6, 15), -1)), "2026年6月");
assert.equal(calendarMonthLabel(shiftCalendarMonth(new Date(2026, 0, 15), -1)), "2025年12月");
assert.match(homeViewSource, /private calendarMonthOffset = 0/);
assert.match(homeViewSource, /codex-home-month-button/);
assert.match(homeViewSource, /this\.shiftCalendarMonth\(-1\)/);
assert.match(homeViewSource, /this\.shiftCalendarMonth\(1\)/);
assert.match(homeViewSource, /this\.resetCalendarMonth\(\)/);
assert.match(homeViewSource, /isSystemHomeCardPath/);
assert.match(homeViewSource, /basename\.startsWith\(["']\.["']\)/);
assert.doesNotMatch(homeViewSource, /card\.kind === "raw" \? "提炼" : "复盘"/);
assert.doesNotMatch(homeViewSource, /"处理"/);
const homeDashboardFile = (filePath: string, mtime: number): KnowledgeBaseDashboardFile => ({ path: filePath, size: 1, mtime });
const homeCards = buildHomeCards({
  raw: {
    recentFiles: [
      homeDashboardFile("raw/.secret.md", 1700000000001),
      homeDashboardFile("raw/index.md", 1700000000002),
      homeDashboardFile("raw/articles/real-source.md", 1700000000003)
    ],
    changedCount: 1,
    todayCount: 1
  },
  wiki: {
    recentFiles: [
      homeDashboardFile("wiki/index.md", 1700000000004),
      homeDashboardFile("wiki/ai/00-索引.md", 1700000000005),
      homeDashboardFile("wiki/ai/real-page.md", 1700000000006)
    ],
    todayCount: 1
  },
  inbox: {
    recentFiles: [
      homeDashboardFile("inbox/.DS_Store", 1700000000007),
      homeDashboardFile("inbox/capture.md", 1700000000008)
    ],
    todayCount: 1
  },
  outputs: {
    recentFiles: [
      homeDashboardFile("outputs/.ingest-tracker.md", 1700000000009),
      homeDashboardFile("outputs/.raw-digest-registry.json", 1700000000010),
      homeDashboardFile("outputs/maintenance/kb-check-2026-06-28.md", 1700000000011)
    ]
  }
} as unknown as KnowledgeBaseDashboardSnapshot);
assert.deepEqual(homeCards.map((card) => card.path).sort(), [
  "inbox/capture.md",
  "outputs/maintenance/kb-check-2026-06-28.md",
  "raw/articles/real-source.md",
  "wiki/ai/real-page.md"
]);
assert.equal(isSystemHomeCardPath("outputs/.ingest-tracker.md"), true);
assert.equal(isSystemHomeCardPath("outputs/.raw-digest-registry.json"), true);
assert.equal(isSystemHomeCardPath("wiki/ai/00-索引.md"), true);
assert.equal(isSystemHomeCardPath("raw/articles/real-source.md"), false);
assert.deepEqual(HOME_CARD_ACTION_LABELS, ["打开", "提炼", "加入复盘"]);
assert.match(settingsStyles, /\.codex-home-page\s*\{[\s\S]*?max-width:\s*1360px;/);
assert.match(settingsStyles, /\.codex-home-top-grid\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0,\s*1\.22fr\)\s*minmax\(430px,\s*0\.78fr\);/);
assert.match(homeCalendarCss, /grid-template-columns:\s*repeat\(7,\s*minmax\(0,\s*1fr\)\);/);
assert.match(settingsStyles, /\.codex-home-review-metrics\s*\{[\s\S]*?grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\);/);
assert.match(settingsStyles, /\.codex-home-heatmap-cells\s*\{[\s\S]*?grid-template-columns:\s*repeat\(52,\s*minmax\(5px,\s*1fr\)\);/);
assert.match(settingsStyles, /\.workspace-leaf-content\[data-type="codex-echoink-home"\]\s+\.view-header\s*\{[\s\S]*?display:\s*none;/);
assert.match(settingsStyles, /\.codex-home-card-grid\s*\{[\s\S]*?grid-template-columns:\s*repeat\(auto-fill,\s*minmax\(min\(360px,\s*100%\),\s*1fr\)\);/);
assert.doesNotMatch(settingsStyles, /\.codex-home-card-grid\s*\{[\s\S]*?grid-template-columns:\s*repeat\(auto-fit,/);
assert.match(homeTextLinkCss, /min-height:\s*30px;/);
assert.match(homeTextLinkCss, /padding:\s*0 12px;/);
assert.match(homeTextLinkCss, /white-space:\s*nowrap;/);
assert.match(settingsStyles, /\.codex-home-card-actions\s*\{[\s\S]*?grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)\s*30px;[\s\S]*?gap:\s*8px;/);
assert.match(cssRuleBody(settingsStyles, ".codex-home-card-status strong"), /color:\s*inherit;/);
assert.match(cssRuleBody(settingsStyles, ".codex-home-legend-dot.is-checked"), /background:\s*var\(--color-blue\);/);
assert.match(settingsStyles, /@container\s+codex-home-card\s*\(max-width:\s*320px\)/);
assert.match(settingsStyles, /@container\s+codex-home\s*\(max-width:\s*1120px\)/);
assert.match(settingsStyles, /@container\s+codex-home\s*\(max-width:\s*760px\)/);
assert.doesNotMatch(settingsStyles, /\.codex-home-card-grid\s+\.codex-home-card:nth-child/);
assert.match(homeViewSource, /HOME_CARDS_PAGE_SIZE/);
assert.match(homeViewSource, /显示更多/);
assert.match(homeViewSource, /openHomeSortMenu/);
assert.match(homeViewSource, /openHomeFolderMenu/);
assert.match(homeViewSource, /openHomeCardMenu/);
assert.match(homeViewSource, /复制链接/);
assert.match(homeViewSource, /复制 Obsidian 内链/);
assert.match(homeViewSource, /复制相对路径/);
assert.match(homeViewSource, /复制 Markdown 链接/);
assert.match(homeViewSource, /homeCardObsidianLinkToCopy\(card\)/);
assert.match(homeViewSource, /homeCardPathToCopy\(card\)/);
assert.match(homeViewSource, /homeCardMarkdownLinkToCopy\(card\)/);
assert.match(homeViewSource, /按更新时间/);
assert.match(homeViewSource, /按文件夹/);
assert.match(homeViewSource, /全部文件夹/);
assert.match(homeViewSource, /文件夹筛选/);
assert.deepEqual(HOME_SORT_OPTIONS.map((option) => option.label), ["按相关度", "按更新时间", "按文件夹"]);
const sortableHomeCards = [
  { id: "older-b", title: "Older B", path: "wiki/b/older.md", kind: "wiki", summary: "", tags: [], status: "Wiki 笔记", touchedAt: 10 },
  { id: "newer-a", title: "Newer A", path: "raw/a/newer.md", kind: "raw", summary: "", tags: [], status: "Raw 待提炼", touchedAt: 30 },
  { id: "middle-a", title: "Middle A", path: "raw/a/middle.md", kind: "raw", summary: "", tags: [], status: "Raw 待提炼", touchedAt: 20 }
] as const;
assert.deepEqual(sortHomeCards([...sortableHomeCards], "relevance").map((card) => card.id), ["older-b", "newer-a", "middle-a"]);
assert.deepEqual(sortHomeCards([...sortableHomeCards], "updated").map((card) => card.id), ["newer-a", "middle-a", "older-b"]);
assert.deepEqual(sortHomeCards([...sortableHomeCards], "folder").map((card) => card.id), ["newer-a", "middle-a", "older-b"]);
assert.equal(HOME_FOLDER_ALL, "all");
assert.equal(homeCardFolderScope("wiki/ai-intelligence/concepts/page.md"), "wiki/ai-intelligence");
assert.equal(homeCardFolderScope("raw/source.md"), "raw");
assert.deepEqual(buildHomeFolderFilterItems([...sortableHomeCards]).map((item) => `${item.id}:${item.count}`), [
  "all:3",
  "raw/a:2",
  "wiki/b:1"
]);
assert.deepEqual(filterHomeCardsByFolder([...sortableHomeCards], "raw/a").map((card) => card.id), ["newer-a", "middle-a"]);
assert.equal(homeCardPathToCopy(sortableHomeCards[1]), "raw/a/newer.md");
assert.equal(homeCardObsidianLinkToCopy(sortableHomeCards[1]), "[[raw/a/newer]]");
assert.equal(homeCardMarkdownLinkToCopy(sortableHomeCards[1]), "[Newer A](<raw/a/newer.md>)");
assert.equal(homeCardMarkdownLinkToCopy({ ...sortableHomeCards[1], title: "A [link]" }), "[A \\[link\\]](<raw/a/newer.md>)");
assert.equal(HOME_CARDS_PAGE_SIZE, 24);
assert.equal(resolveDefaultHomeFilter([
  { id: "a", title: "A", path: "wiki/a.md", kind: "wiki", summary: "", tags: [], status: "Wiki 更新", touchedAt: 3 },
  { id: "b", title: "B", path: "raw/b.md", kind: "raw", summary: "", tags: [], status: "Raw 待提炼", touchedAt: 2 }
]), "wiki");
assert.equal(resolveDefaultHomeFilter([
  { id: "b", title: "B", path: "raw/b.md", kind: "raw", summary: "", tags: [], status: "Raw 待提炼", touchedAt: 2 }
]), "suggested");
assert.equal(resolveActiveHomeFilter("all", false, [
  { id: "b", title: "B", path: "raw/b.md", kind: "raw", summary: "", tags: [], status: "Raw 待提炼", touchedAt: 2 }
], true), "suggested");
assert.equal(resolveActiveHomeFilter("all", true, [
  { id: "b", title: "B", path: "raw/b.md", kind: "raw", summary: "", tags: [], status: "Raw 待提炼", touchedAt: 2 }
], true), "all");
assert.equal(resolveActiveHomeFilter(null, false, [], false), "all");
assert.equal(filterHomeCards([
  { id: "a", title: "A", path: "wiki/a.md", kind: "wiki", summary: "", tags: [], status: "Wiki 更新", touchedAt: 3 },
  { id: "b", title: "B", path: "raw/b.md", kind: "raw", summary: "", tags: [], status: "Raw 待提炼", touchedAt: 2 }
], "wiki").length, 1);
assert.match(headerHistoryCss, /gap:\s*5px;/);
assert.match(headerHistoryCss, /padding:\s*0 9px;/);
assert.match(knowledgeBaseDashboardCss, /flex:\s*0 1 auto;/);
assert.match(knowledgeBaseDashboardCss, /max-height:\s*min\(420px,\s*48vh\);/);
assert.match(knowledgeBaseDashboardCss, /overflow:\s*visible;/);
assert.match(knowledgeBaseDashboardVisibleCss, /display:\s*flex;/);
assert.match(knowledgeBaseDashboardVisibleCss, /flex-direction:\s*column;/);
assert.match(knowledgeBaseDashboardHeaderCss, /flex:\s*0 0 auto;/);
assert.match(knowledgeBaseDashboardSummaryCss, /overflow:\s*visible;/);
assert.match(knowledgeBaseDashboardDetailsCss, /flex:\s*1 1 auto;/);
assert.match(knowledgeBaseDashboardDetailsCss, /min-height:\s*0;/);
assert.match(knowledgeBaseDashboardDetailsCss, /overflow-y:\s*auto;/);
assert.match(knowledgeBaseDashboardDetailsCss, /overscroll-behavior:\s*contain;/);
assert.match(knowledgeBaseHealthTooltipCss, /position:\s*relative;/);
assert.match(knowledgeBaseHealthTooltipCss, /display:\s*inline-flex;/);
assert.match(knowledgeBaseHealthTooltipTriggerCss, /width:\s*16px;/);
assert.match(knowledgeBaseHealthTooltipTriggerCss, /height:\s*16px;/);
assert.match(knowledgeBaseHealthTooltipTriggerCss, /line-height:\s*1;/);
assert.match(knowledgeBaseHealthTooltipPanelCss, /position:\s*fixed;/);
assert.match(knowledgeBaseHealthTooltipPanelCss, /z-index:\s*99999;/);
assert.match(knowledgeBaseHealthTooltipPanelCss, /width:\s*320px;/);
assert.match(knowledgeBaseHealthTooltipPanelCss, /max-width:\s*320px;/);
assert.match(knowledgeBaseHealthTooltipPanelCss, /white-space:\s*normal;/);
assert.match(knowledgeBaseHealthTooltipBridgeCss, /position:\s*fixed;/);
assert.match(knowledgeBaseHealthTooltipBridgeCss, /z-index:\s*99998;/);
assert.match(knowledgeBaseHealthTooltipBridgeCss, /pointer-events:\s*none;/);
assert.match(knowledgeBaseHealthTooltipBridgeVisibleCss, /pointer-events:\s*auto;/);
assert.match(knowledgeBaseHealthTooltipBridgeVisibleCss, /visibility:\s*visible;/);
assert.match(settingsStyles, /\.codex-kb-health-tooltip-panel\.is-visible/);
assert.doesNotMatch(settingsStyles, /\.codex-kb-health-tooltip:hover\s+\.codex-kb-health-tooltip-panel/);
assert.doesNotMatch(settingsStyles, /\.codex-kb-health-tooltip:focus-within\s+\.codex-kb-health-tooltip-panel/);
assert.match(resourceRowCss, /min-width:\s*0;/);
assert.match(resourceRowCss, /width:\s*100%;/);
assert.match(resourceRowCss, /box-sizing:\s*border-box;/);
assert.match(resourceRowContentCss, /overflow:\s*hidden;/);
assert.match(resourceRowNameCss, /overflow:\s*hidden;/);
assert.match(resourceRowNameCss, /text-overflow:\s*ellipsis;/);
assert.match(resourceRowNameCss, /white-space:\s*nowrap;/);
assert.match(resourceSearchInputCss, /width:\s*100%;/);
assert.match(resourceSearchInputCss, /min-width:\s*0;/);
assert.match(processFileLinkCss, /background:\s*transparent;/);
assert.match(processFileLinkCss, /border:\s*0;/);
assert.doesNotMatch(processFileLinkCss, /box-shadow:\s*var\(/);
assert.match(processIconCss, /color:\s*color-mix\(in srgb,\s*var\(--interactive-accent\)/);
assert.match(processEditIconCss, /color:\s*var\(--text-accent\);/);
assert.match(settingsStatusErrorCss, /var\(--text-error\)/);
assert.match(settingsStatusErrorBodyCss, /white-space:\s*pre-wrap;/);
assert.match(messageNoteLinkCss, /color:\s*color-mix\(in srgb,\s*var\(--interactive-accent\)/);
assert.match(messageNoteLinkCss, /text-decoration:\s*none;/);
assert.match(messageNoteLinkCss, /cursor:\s*pointer;/);
assert.match(knowledgeBaseResultTitleCss, /display:\s*inline-flex;/);
assert.match(knowledgeBaseResultTitleCss, /border-left:\s*3px solid var\(--interactive-accent\);/);
assert.match(knowledgeBaseResultBodyCss, /min-width:\s*0;/);
assert.match(knowledgeBaseResultSuccessCss, /var\(--color-green\)/);
assert.match(knowledgeBaseResultFailedCss, /var\(--text-error\)/);
assert.match(codexViewSource, /addKnowledgeDashboardHealthTooltip/);
assert.match(codexViewSource, /positionKnowledgeDashboardHealthTooltip/);
assert.match(codexViewSource, /clearKnowledgeDashboardHealthTooltips/);
assert.match(codexViewSource, /document\.body\.createDiv/);
assert.match(codexViewSource, /codex-kb-health-tooltip-bridge/);
assert.match(codexViewSource, /panel\.addClass\("is-visible"\)/);
assert.match(codexViewSource, /bridge\.addClass\("is-visible"\)/);
assert.match(codexViewSource, /panel\.removeClass\("is-visible"\)/);
assert.match(codexViewSource, /bridge\.removeClass\("is-visible"\)/);
assert.match(codexViewSource, /panel\.style\.visibility\s*=\s*"visible"/);
assert.match(codexViewSource, /panel\.style\.opacity\s*=\s*"1"/);
assert.match(codexViewSource, /panel\.style\.pointerEvents\s*=\s*"auto"/);
assert.match(codexViewSource, /panel\.style\.visibility\s*=\s*"hidden"/);
assert.match(codexViewSource, /button\.setAttribute\("aria-expanded",\s*"true"\)/);
assert.match(codexViewSource, /button\.setAttribute\("aria-expanded",\s*"false"\)/);
assert.match(codexViewSource, /const openPanelFromClick/);
assert.match(codexViewSource, /button\.onpointerdown\s*=\s*openPanelFromClick/);
assert.match(codexViewSource, /button\.onmousedown\s*=\s*openPanelFromClick/);
assert.match(codexViewSource, /button\.onmousedown/);
assert.match(codexViewSource, /button\.onmouseleave/);
assert.match(codexViewSource, /button\.onpointerenter/);
assert.match(codexViewSource, /button\.onpointerleave/);
assert.match(codexViewSource, /button\.onmouseover/);
assert.match(codexViewSource, /panel\.onmouseenter/);
assert.match(codexViewSource, /panel\.onpointerenter/);
assert.match(codexViewSource, /panel\.onpointerleave/);
assert.match(codexViewSource, /isKnowledgeDashboardHealthTooltipHoverPoint/);
assert.match(codexViewSource, /scheduleCloseIfOutside/);
assert.match(codexViewSource, /wrapper\.hasClass\("is-click-open"\)/);
assert.match(codexViewSource, /window\.addEventListener\("resize"/);
assert.match(codexViewSource, /window\.addEventListener\("scroll",\s*repositionOpenPanel,\s*true/);
assert.match(codexViewSource, /window\.addEventListener\("pointermove",\s*trackOpenTooltipPointer/);
assert.match(codexViewSource, /window\.addEventListener\("mousemove",\s*trackOpenTooltipPointer/);
assert.match(codexViewSource, /document\.addEventListener\("pointerdown",\s*closeOnOutsidePointerDown,\s*true/);
assert.match(codexViewSource, /document\.addEventListener\("mousedown",\s*closeOnOutsidePointerDown,\s*true/);
assert.match(codexViewSource, /window\.removeEventListener\("resize"/);
assert.match(codexViewSource, /window\.removeEventListener\("scroll",\s*repositionOpenPanel,\s*true/);
assert.match(codexViewSource, /window\.removeEventListener\("pointermove",\s*trackOpenTooltipPointer/);
assert.match(codexViewSource, /window\.removeEventListener\("mousemove",\s*trackOpenTooltipPointer/);
assert.match(codexViewSource, /document\.removeEventListener\("pointerdown",\s*closeOnOutsidePointerDown,\s*true/);
assert.match(codexViewSource, /document\.removeEventListener\("mousedown",\s*closeOnOutsidePointerDown,\s*true/);
assert.doesNotMatch(codexViewSource, /window\.addEventListener\("mousemove",\s*(?:close|schedule|.*Close)/);
assert.doesNotMatch(codexViewSource, /scheduleClose\(3500\)/);
assert.match(codexViewSource, /lastTooltipPointer/);
assert.match(codexViewSource, /rememberTooltipPointer/);
assert.match(codexViewSource, /isPointerCurrentlyInsideTooltip/);
assert.match(codexViewSource, /closePanelIfPointerOutside/);
assert.match(codexViewSource, /closeOnOutsidePointerDown/);
assert.match(codexViewSource, /document\.elementFromPoint/);
assert.match(codexViewSource, /bridge\.onmouseenter/);
assert.match(codexViewSource, /bridge\.onpointerenter/);
assert.match(codexViewSource, /event\.relatedTarget/);
assert.match(codexViewSource, /isTooltipTarget/);
assert.match(codexViewSource, /aria-describedby/);
assert.match(codexViewSource, /aria-expanded/);
assert.match(codexViewSource, /codex-kb-health-tooltip-placement-summary/);
assert.match(codexViewSource, /codex-kb-health-tooltip-placement-meter/);
assert.match(codexViewSource, /codex-kb-health-tooltip-trigger/);
assert.match(codexViewSource, /"aria-label": "解释知识库健康分"/);
assert.match(codexViewSource, /健康分解释/);
assert.match(codexViewSource, /暂无扣分项/);
assert.match(codexViewSource, /scoreThresholdText/);
assert.match(codexViewSource, /体检成功只代表检查完成/);
const healthTooltipTriggerRect = { left: 100, right: 116, top: 100, bottom: 116 };
const healthTooltipBelowPanelRect = { left: 80, right: 320, top: 124, bottom: 260 };
const healthTooltipAbovePanelRect = { left: 80, right: 320, top: 20, bottom: 92 };
assert.equal(isKnowledgeDashboardHealthTooltipHoverPoint(healthTooltipTriggerRect, healthTooltipBelowPanelRect, 108, 120), true);
assert.equal(isKnowledgeDashboardHealthTooltipHoverPoint(healthTooltipTriggerRect, healthTooltipBelowPanelRect, 78, 120), true);
assert.equal(isKnowledgeDashboardHealthTooltipHoverPoint(healthTooltipTriggerRect, healthTooltipBelowPanelRect, 40, 120), false);
assert.equal(isKnowledgeDashboardHealthTooltipHoverPoint(healthTooltipTriggerRect, healthTooltipAbovePanelRect, 108, 96), true);
assert.equal(isKnowledgeDashboardHealthTooltipHoverPoint(healthTooltipTriggerRect, healthTooltipAbovePanelRect, 40, 96), false);
assert.match(codexViewSource, /renderKnowledgeBaseResultContent/);
assert.match(codexViewSource, /codex-kb-result-title/);
assert.match(codexViewSource, /codex-kb-result-body/);
assert.match(settingsStyles, /codex-process-kind-search\s+\.codex-process-icon/);
assert.match(settingsStyles, /codex-process-kind-view\s+\.codex-process-icon/);
assert.match(settingsStyles, /codex-process-kind-run\s+\.codex-process-icon/);

assert.deepEqual(extractKnowledgeBaseResultTitle("knowledgeBase", "知识库维护完成。\n报告：outputs/maintenance/kb-maintenance.md"), {
  title: "知识库维护完成。",
  body: "报告：outputs/maintenance/kb-maintenance.md",
  status: "success"
});
assert.equal(extractKnowledgeBaseResultTitle("knowledgeBase", "知识库体检完成。\n报告：x")?.status, "success");
assert.equal(extractKnowledgeBaseResultTitle("knowledgeBase", "知识库重新提炼完成。\n报告：x")?.status, "success");
assert.equal(extractKnowledgeBaseResultTitle("knowledgeBase", "每日维护执行完毕。\n简短报告：")?.status, "success");
assert.equal(extractKnowledgeBaseResultTitle("knowledgeBase", "知识库维护失败：Agent 失败\n报告：x")?.status, "failed");
assert.equal(extractKnowledgeBaseResultTitle("knowledgeBase", "知识库体检已取消。\n原因：用户取消")?.status, "canceled");
assert.equal(extractKnowledgeBaseResultTitle("knowledgeBase", "每日维护已取消。")?.status, "canceled");
assert.equal(extractKnowledgeBaseResultTitle("knowledgeBase", "方哥，按 wiki 证据看没有命中。"), null);
assert.equal(extractKnowledgeBaseResultTitle("assistant", "知识库维护完成。\n报告：x"), null);

const codexKnowledgeOptions = buildCodexKnowledgeTurnOptions({
  settings: normalizeSettingsData({
    settingsVersion: DEFAULT_SETTINGS.settingsVersion,
    defaultModel: "selected-kb-model",
    defaultReasoning: "medium",
    defaultServiceTier: "fast",
    mcpEnabled: false
  }).settings,
  availableModels: [{ model: "gpt-5.5" }],
  vaultPath: "/vault",
  permission: "read-only"
});
assert.equal(codexKnowledgeOptions.model, "selected-kb-model");
assert.equal(codexKnowledgeOptions.reasoning, "medium");
assert.equal(codexKnowledgeOptions.serviceTier, "fast");
assert.equal(codexKnowledgeOptions.permission, "read-only");
assert.deepEqual(codexKnowledgeOptions.writableRoots, undefined);
const autoCodexKnowledgeOptions = buildCodexKnowledgeTurnOptions({
  settings: normalizeSettingsData({ settingsVersion: DEFAULT_SETTINGS.settingsVersion, defaultModel: "" }).settings,
  availableModels: [{ model: "gpt-5.4", isDefault: true }, { model: "gpt-5.5" }],
  vaultPath: "/vault",
  permission: "read-only"
});
assert.equal(autoCodexKnowledgeOptions.model, "gpt-5.4");
const emptyCodexKnowledgeOptions = buildCodexKnowledgeTurnOptions({
  settings: normalizeSettingsData({ settingsVersion: DEFAULT_SETTINGS.settingsVersion, defaultModel: "" }).settings,
  availableModels: [],
  vaultPath: "/vault",
  permission: "read-only"
});
assert.equal(emptyCodexKnowledgeOptions.model, "");
const writableCodexKnowledgeOptions = buildCodexKnowledgeTurnOptions({
  settings: normalizeSettingsData({ settingsVersion: DEFAULT_SETTINGS.settingsVersion, defaultModel: "", defaultReasoning: "xhigh" }).settings,
  availableModels: [{ model: "gpt-5.5", isDefault: true }],
  vaultPath: "/vault",
  permission: "workspace-write"
});
assert.equal(writableCodexKnowledgeOptions.model, "gpt-5.5");
assert.equal(writableCodexKnowledgeOptions.reasoning, "xhigh");
assert.deepEqual(writableCodexKnowledgeOptions.writableRoots, ["/vault/raw/index.md", "/vault/wiki", "/vault/outputs", "/vault/inbox", "/vault/projects"]);
const rawMoveRewrite = [{ from: "raw/articles/GitHub项目收集", to: "raw/articles/github-trending", kind: "directory" as const }];
const rawSnapshotEntry = (fingerprint: string, mtimeMs = 100): RawSnapshotEntry => ({ fingerprint, mtimeMs });
assert.deepEqual(
  diffRawSnapshot(
    new Map([["raw/articles/GitHub项目收集/demo.md", rawSnapshotEntry("hash-a")], ["raw/index.md", rawSnapshotEntry("index-before")]]),
    new Map([["raw/articles/github-trending/demo.md", rawSnapshotEntry("hash-a")], ["raw/index.md", rawSnapshotEntry("index-after")]]),
    rawMoveRewrite
  ),
  []
);
assert.deepEqual(
  diffRawSnapshot(
    new Map([["raw/articles/GitHub项目收集/demo.md", rawSnapshotEntry("hash-a")]]),
    new Map([["raw/articles/github-trending/demo.md", rawSnapshotEntry("hash-b")]]),
    rawMoveRewrite
  ),
  ["raw/articles/GitHub项目收集/demo.md -> raw/articles/github-trending/demo.md 文件内容被改写"]
);
assert.deepEqual(
  diffRawSnapshot(
    new Map([["raw/articles/GitHub项目收集/demo.md", rawSnapshotEntry("hash-a", 100)]]),
    new Map([["raw/articles/github-trending/demo.md", rawSnapshotEntry("hash-a", 200)]]),
    rawMoveRewrite
  ),
  ["raw/articles/GitHub项目收集/demo.md -> raw/articles/github-trending/demo.md 文件元数据被改写"]
);
assert.deepEqual(
  diffRawSnapshot(
    new Map([["raw/articles/demo.md", { ...rawSnapshotEntry("hash-a", 1000), mode: 0o100644, identity: "1:2:1" }]]),
    new Map([["raw/articles/demo.md", { ...rawSnapshotEntry("hash-a", 1004.9), mode: 0o100644, identity: "1:2:1" }]])
  ),
  []
);
assert.deepEqual(
  diffRawSnapshot(
    new Map([["raw/articles/github-trending/old.md", rawSnapshotEntry("hash-old")]]),
    new Map([["raw/articles/github-trending/old.md", rawSnapshotEntry("hash-old")], ["raw/articles/GitHub项目收集/2026-05-25 GitHub 热门项目简报.md", rawSnapshotEntry("hash-new")]])
  ),
  ["raw/articles/GitHub项目收集/2026-05-25 GitHub 热门项目简报.md 文件新增或被移动到 raw/"]
);
const rawSafeAddClassification = classifyRawSnapshotChanges(
  new Map([["raw/articles/github-trending/old.md", rawSnapshotEntry("hash-old")]]),
  new Map([["raw/articles/github-trending/old.md", rawSnapshotEntry("hash-old")], ["raw/articles/GitHub项目收集/2026-05-25 GitHub 热门项目简报.md", { ...rawSnapshotEntry("hash-new"), kind: "file" as const, nlink: 1 }]])
);
assert.deepEqual(rawSnapshotChangeMessages(rawSafeAddClassification.blockingChanges), []);
assert.deepEqual(rawSnapshotChangeMessages(rawSafeAddClassification.externalAdditions), [
  "raw/articles/GitHub项目收集/2026-05-25 GitHub 热门项目简报.md 文件新增或被移动到 raw/"
]);
const rawUnsafeAddClassification = classifyRawSnapshotChanges(
  new Map([["raw/articles/github-trending/old.md", rawSnapshotEntry("hash-old")]]),
  new Map([["raw/articles/github-trending/old.md", rawSnapshotEntry("hash-old")], ["raw/articles/linked.md", { ...rawSnapshotEntry("hash-link"), kind: "symlink" as const }]])
);
assert.deepEqual(rawSnapshotChangeMessages(rawUnsafeAddClassification.blockingChanges), [
  "raw/articles/linked.md 文件新增或被移动到 raw/"
]);
assert.deepEqual(rawSnapshotChangeMessages(rawUnsafeAddClassification.externalAdditions), []);
const rawMetadataClassification = classifyRawSnapshotChanges(
  new Map([["raw/articles/demo.md", { ...rawSnapshotEntry("hash-a", 100), kind: "file" as const, mode: 0o100644, identity: "1:2:1" }]]),
  new Map([["raw/articles/demo.md", { ...rawSnapshotEntry("hash-a", 500), kind: "file" as const, mode: 0o100644, identity: "1:2:1" }]])
);
assert.deepEqual(rawSnapshotChangeMessages(rawMetadataClassification.blockingChanges), [
  "raw/articles/demo.md 文件元数据被改写"
]);
assert.deepEqual(rawSnapshotChangeMessages(rawMetadataClassification.externalAdditions), []);
const rawManagedFrontmatterClassification = classifyRawSnapshotChanges(
  new Map([["raw/articles/demo.md", { ...rawSnapshotEntry("canonical-a", 100), kind: "file" as const, mode: 0o100644, identity: "1:2:1" }]]),
  new Map([["raw/articles/demo.md", { ...rawSnapshotEntry("canonical-a", 500), kind: "file" as const, mode: 0o100644, identity: "1:2:1" }]]),
  [],
  { allowedManagedFrontmatterPaths: new Set(["raw/articles/demo.md"]) }
);
assert.deepEqual(rawSnapshotChangeMessages(rawManagedFrontmatterClassification.blockingChanges), []);
const rawManagedFrontmatterIdentityClassification = classifyRawSnapshotChanges(
  new Map([["raw/articles/demo.md", { ...rawSnapshotEntry("canonical-a", 100), kind: "file" as const, mode: 0o100644, identity: "1:2:1" }]]),
  new Map([["raw/articles/demo.md", { ...rawSnapshotEntry("canonical-a", 500), kind: "file" as const, mode: 0o100644, identity: "1:3:1" }]]),
  [],
  { allowedManagedFrontmatterPaths: new Set(["raw/articles/demo.md"]) }
);
assert.deepEqual(rawSnapshotChangeMessages(rawManagedFrontmatterIdentityClassification.blockingChanges), []);
const rawManagedFrontmatterHardlinkClassification = classifyRawSnapshotChanges(
  new Map([["raw/articles/demo.md", { ...rawSnapshotEntry("canonical-a", 100), kind: "file" as const, mode: 0o100644, identity: "1:2:1", nlink: 1 }]]),
  new Map([["raw/articles/demo.md", { ...rawSnapshotEntry("canonical-a", 500), kind: "file" as const, mode: 0o100644, identity: "1:3:2", nlink: 2 }]]),
  [],
  { allowedManagedFrontmatterPaths: new Set(["raw/articles/demo.md"]) }
);
assert.deepEqual(rawSnapshotChangeMessages(rawManagedFrontmatterHardlinkClassification.blockingChanges), [
  "raw/articles/demo.md 文件身份被改写"
]);
const rawDigestMarkdownBefore = Buffer.from("---\ntags:\n  - ai\n提炼状态: 旧状态\n---\n\n# Demo\n\n正文", "utf8");
const rawDigestEntry = {
  rawPath: "raw/articles/demo.md",
  fingerprint: rawDigestFingerprint("raw/articles/demo.md", rawDigestMarkdownBefore),
  size: rawDigestMarkdownBefore.length,
  mtime: 100,
  digestedAt: Date.parse("2026-06-04T00:00:00.000Z"),
  runId: "test-run",
  reportPath: "outputs/maintenance/kb-maintenance-2026-06-04.md",
  evidencePaths: ["wiki/ai-intelligence/references/demo.md"],
  confidence: "verified" as const
};
const rawDigestMarkdownAfter = applyRawDigestFrontmatter(rawDigestMarkdownBefore, rawDigestEntry);
assert.equal(rawDigestFingerprint("raw/articles/demo.md", rawDigestMarkdownAfter), rawDigestEntry.fingerprint);
assert.ok(rawDigestMarkdownAfter.toString("utf8").includes("tags:\n  - ai"));
assert.ok(rawDigestMarkdownAfter.toString("utf8").includes("已处理: true"));
assert.ok(rawDigestMarkdownAfter.toString("utf8").includes("# Demo\n\n正文"));
const rawDigestExternalFrontmatterChange = Buffer.from(rawDigestMarkdownAfter.toString("utf8").replace("tags:\n  - ai", "tags:\n  - ai\nupdated: 2026-06-04T01:30:00+08:00"), "utf8");
assert.equal(rawDigestFingerprint("raw/articles/demo.md", rawDigestExternalFrontmatterChange), rawDigestEntry.fingerprint);
const rawDigestRecord = rawDigestRecordFromMarkdown(rawDigestMarkdownAfter);
assert.equal(rawDigestRecordIsTrusted(rawDigestRecord, rawDigestEntry.fingerprint), true);
const rawDigestManualOnly = Buffer.from("---\n已处理: true\n提炼状态: 已提炼\n提炼指纹: sha256:1:abc\n---\n\n# Demo\n", "utf8");
assert.equal(rawDigestRecordIsTrusted(rawDigestRecordFromMarkdown(rawDigestManualOnly), "sha256:1:abc"), false);
const rawRestoreVault = await mkdtemp(path.join(tmpdir(), "codex-raw-restore-"));
try {
  await mkdir(path.join(rawRestoreVault, "raw", "articles"), { recursive: true });
  await mkdir(path.join(rawRestoreVault, "raw", "articles", ".assets"), { recursive: true });
  const rawArticlePath = path.join(rawRestoreVault, "raw", "articles", "source.md");
  const rawAssetPath = path.join(rawRestoreVault, "raw", "articles", ".assets", "image.png");
  const rawNewDirPath = path.join(rawRestoreVault, "raw", "articles", "empty-added");
  const rawNewPath = path.join(rawRestoreVault, "raw", "articles", "new.md");
  const rawSymlinkPath = path.join(rawRestoreVault, "raw", "articles", "linked.md");
  const rawOriginal = "---\nupdated: 2026-05-24T23:35\n---\n\n原文正文";
  const rawAssetOriginal = "asset-before";
  await writeFile(rawArticlePath, rawOriginal, "utf8");
  await writeFile(rawAssetPath, rawAssetOriginal, "utf8");
  const rawOriginalTime = new Date("2026-05-24T15:35:00.000Z");
  await utimes(rawArticlePath, rawOriginalTime, rawOriginalTime);
  await utimes(rawAssetPath, rawOriginalTime, rawOriginalTime);
  const rawContentBefore = await snapshotRawFileContents(rawRestoreVault);
  const rawFingerprintBefore = fingerprintRawContentSnapshot(rawContentBefore);
  await utimes(rawArticlePath, new Date(rawOriginalTime.getTime() + 5000), new Date(rawOriginalTime.getTime() + 5000));
  const rawMetadataAfter = fingerprintRawContentSnapshot(await snapshotRawFileContents(rawRestoreVault));
  assert.deepEqual(diffRawSnapshot(rawFingerprintBefore, rawMetadataAfter), [
    "raw/articles/source.md 文件元数据被改写"
  ]);
  await restoreRawSnapshot(rawRestoreVault, rawContentBefore, rawFingerprintBefore, rawMetadataAfter);
  assert.equal(Math.round((await stat(rawArticlePath)).mtimeMs), Math.round(rawOriginalTime.getTime()));
  const rawExternalTarget = path.join(rawRestoreVault, "outside-target.md");
  await writeFile(rawExternalTarget, "outside should stay unchanged", "utf8");
  await rm(rawArticlePath, { force: true });
  await symlink(rawExternalTarget, rawArticlePath);
  const rawSymlinkReplacementAfter = fingerprintRawContentSnapshot(await snapshotRawFileContents(rawRestoreVault));
  assert.deepEqual(diffRawSnapshot(rawFingerprintBefore, rawSymlinkReplacementAfter), [
    "raw/articles/source.md 文件内容被改写"
  ]);
  await restoreRawSnapshot(rawRestoreVault, rawContentBefore, rawFingerprintBefore, rawSymlinkReplacementAfter);
  assert.equal((await lstat(rawArticlePath)).isSymbolicLink(), false);
  assert.equal(await readFile(rawArticlePath, "utf8"), rawOriginal);
  assert.equal(await readFile(rawExternalTarget, "utf8"), "outside should stay unchanged");
  const rawHardlinkTarget = path.join(rawRestoreVault, "outside-hardlink-target.md");
  await writeFile(rawHardlinkTarget, "hardlink should stay unchanged", "utf8");
  await rm(rawArticlePath, { force: true });
  await link(rawHardlinkTarget, rawArticlePath);
  const rawHardlinkReplacementAfter = fingerprintRawContentSnapshot(await snapshotRawFileContents(rawRestoreVault));
  assert.deepEqual(diffRawSnapshot(rawFingerprintBefore, rawHardlinkReplacementAfter), [
    "raw/articles/source.md 文件内容被改写"
  ]);
  await restoreRawSnapshot(rawRestoreVault, rawContentBefore, rawFingerprintBefore, rawHardlinkReplacementAfter);
  assert.equal(await readFile(rawArticlePath, "utf8"), rawOriginal);
  assert.equal(await readFile(rawHardlinkTarget, "utf8"), "hardlink should stay unchanged");
  assert.equal((await stat(rawArticlePath)).ino === (await stat(rawHardlinkTarget)).ino, false);
  const rawSameHardlinkTarget = path.join(rawRestoreVault, "outside-same-hardlink-target.md");
  await writeFile(rawSameHardlinkTarget, rawOriginal, "utf8");
  await utimes(rawSameHardlinkTarget, rawOriginalTime, rawOriginalTime);
  await rm(rawArticlePath, { force: true });
  await link(rawSameHardlinkTarget, rawArticlePath);
  const rawSameHardlinkAfter = fingerprintRawContentSnapshot(await snapshotRawFileContents(rawRestoreVault));
  assert.deepEqual(diffRawSnapshot(rawFingerprintBefore, rawSameHardlinkAfter), [
    "raw/articles/source.md 文件身份被改写"
  ]);
  await restoreRawSnapshot(rawRestoreVault, rawContentBefore, rawFingerprintBefore, rawSameHardlinkAfter);
  assert.equal(await readFile(rawArticlePath, "utf8"), rawOriginal);
  assert.equal(await readFile(rawSameHardlinkTarget, "utf8"), rawOriginal);
  assert.equal((await stat(rawArticlePath)).ino === (await stat(rawSameHardlinkTarget)).ino, false);
  await writeFile(rawArticlePath, rawOriginal.replace("2026-05-24T23:35", "2026-05-27T01:16"), "utf8");
  await writeFile(rawAssetPath, "asset-after", "utf8");
  await mkdir(rawNewDirPath, { recursive: true });
  await writeFile(rawNewPath, "# new raw", "utf8");
  await writeFile(path.join(rawRestoreVault, "raw", "articles", ".DS_Store"), "agent metadata", "utf8");
  await symlink(rawArticlePath, rawSymlinkPath);
  const rawFingerprintAfter = fingerprintRawContentSnapshot(await snapshotRawFileContents(rawRestoreVault));
  const rawChanges = diffRawSnapshot(rawFingerprintBefore, rawFingerprintAfter);
  assert.deepEqual(rawChanges, [
    "raw/articles/.assets/image.png 文件内容被改写",
    "raw/articles/source.md 文件内容被改写",
    "raw/articles/.DS_Store 文件新增或被移动到 raw/",
    "raw/articles/empty-added 文件新增或被移动到 raw/",
    "raw/articles/linked.md 文件新增或被移动到 raw/",
    "raw/articles/new.md 文件新增或被移动到 raw/"
  ]);
  assert.equal(isRawIntegrityErrorMessage(formatRawIntegrityError(rawChanges, true)), true);
  await restoreRawSnapshot(rawRestoreVault, rawContentBefore, rawFingerprintBefore, rawFingerprintAfter);
  assert.equal(await readFile(rawArticlePath, "utf8"), rawOriginal);
  assert.equal(await readFile(rawAssetPath, "utf8"), rawAssetOriginal);
  assert.equal(Math.round((await stat(rawArticlePath)).mtimeMs), Math.round(rawOriginalTime.getTime()));
  assert.equal(Math.round((await stat(rawAssetPath)).mtimeMs), Math.round(rawOriginalTime.getTime()));
  assert.equal(await fileExists(path.join(rawRestoreVault, "raw", "articles", ".DS_Store")), false);
  assert.equal(await fileExists(rawNewDirPath), false);
  assert.equal(await fileExists(rawNewPath), false);
  assert.equal(await lstat(rawSymlinkPath).then(() => true, () => false), false);
  const rawModeBeforeContent = await snapshotRawFileContents(rawRestoreVault);
  const rawModeBefore = fingerprintRawContentSnapshot(rawModeBeforeContent);
  await chmod(rawArticlePath, 0o600);
  const rawModeAfter = fingerprintRawContentSnapshot(await snapshotRawFileContents(rawRestoreVault));
  assert.deepEqual(diffRawSnapshot(rawModeBefore, rawModeAfter), [
    "raw/articles/source.md 文件权限被改写"
  ]);
  await restoreRawSnapshot(rawRestoreVault, rawModeBeforeContent, rawModeBefore, rawModeAfter);
  assert.equal((await stat(rawArticlePath)).mode & 0o777, (rawModeBeforeContent.get("raw/articles/source.md") as any).mode & 0o777);
  const rawDirPath = path.join(rawRestoreVault, "raw", "articles");
  await utimes(rawDirPath, rawOriginalTime, rawOriginalTime);
  const rawDirStatBefore = await stat(rawDirPath);
  const rawDirModeBeforeContent = await snapshotRawFileContents(rawRestoreVault);
  const rawDirModeBefore = fingerprintRawContentSnapshot(rawDirModeBeforeContent);
  await chmod(rawDirPath, 0o700);
  const rawDirModeAfter = fingerprintRawContentSnapshot(await snapshotRawFileContents(rawRestoreVault));
  assert.deepEqual(diffRawSnapshot(rawDirModeBefore, rawDirModeAfter), [
    "raw/articles 文件权限被改写"
  ]);
  await restoreRawSnapshot(rawRestoreVault, rawDirModeBeforeContent, rawDirModeBefore, rawDirModeAfter);
  assert.equal(await readFile(rawArticlePath, "utf8"), rawOriginal);
  assert.equal(await readFile(rawAssetPath, "utf8"), rawAssetOriginal);
  const rawDirStatAfter = await stat(rawDirPath);
  assert.equal(rawDirStatAfter.mode & 0o777, (rawDirModeBeforeContent.get("raw/articles") as any).mode & 0o777);
  assert.ok(Math.abs(rawDirStatAfter.mtimeMs - rawDirStatBefore.mtimeMs) <= 5);
  const rawRootPath = path.join(rawRestoreVault, "raw");
  const rawRootModeBeforeContent = await snapshotRawFileContents(rawRestoreVault);
  const rawRootModeBefore = fingerprintRawContentSnapshot(rawRootModeBeforeContent);
  await chmod(rawRootPath, 0o700);
  const rawRootModeAfter = fingerprintRawContentSnapshot(await snapshotRawFileContents(rawRestoreVault));
  assert.deepEqual(diffRawSnapshot(rawRootModeBefore, rawRootModeAfter), [
    "raw 文件权限被改写"
  ]);
  await restoreRawSnapshot(rawRestoreVault, rawRootModeBeforeContent, rawRootModeBefore, rawRootModeAfter);
  assert.equal((await stat(rawRootPath)).mode & 0o777, (rawRootModeBeforeContent.get("raw") as any).mode & 0o777);
  const rawEmptyIdentityDir = path.join(rawRestoreVault, "raw", "articles", "identity-empty");
  await mkdir(rawEmptyIdentityDir, { recursive: true });
  const rawEmptyDirBeforeContent = await snapshotRawFileContents(rawRestoreVault);
  const rawEmptyDirBefore = fingerprintRawContentSnapshot(rawEmptyDirBeforeContent);
  await rm(rawEmptyIdentityDir, { recursive: true, force: true });
  await mkdir(rawEmptyIdentityDir, { recursive: true });
  await chmod(rawEmptyIdentityDir, (rawEmptyDirBeforeContent.get("raw/articles/identity-empty") as any).mode & 0o777);
  const rawEmptyDirAfter = fingerprintRawContentSnapshot(await snapshotRawFileContents(rawRestoreVault));
  assert.deepEqual(diffRawSnapshot(rawEmptyDirBefore, rawEmptyDirAfter), [
    "raw/articles/identity-empty 文件身份被改写"
  ]);
  await restoreRawSnapshot(rawRestoreVault, rawEmptyDirBeforeContent, rawEmptyDirBefore, rawEmptyDirAfter);
  assert.equal((await stat(rawEmptyIdentityDir)).isDirectory(), true);
  const rawRootExternalTarget = path.join(rawRestoreVault, "outside-raw-root");
  await mkdir(rawRootExternalTarget, { recursive: true });
  await rm(rawRootPath, { recursive: true, force: true });
  await symlink(rawRootExternalTarget, rawRootPath);
  const rawRootSymlinkAfter = fingerprintRawContentSnapshot(await snapshotRawFileContents(rawRestoreVault));
  assert.ok(diffRawSnapshot(rawRootModeBefore, rawRootSymlinkAfter).includes("raw 文件内容被改写"));
  await restoreRawSnapshot(rawRestoreVault, rawRootModeBeforeContent, rawRootModeBefore, rawRootSymlinkAfter);
  assert.equal((await lstat(rawRootPath)).isSymbolicLink(), false);
  assert.equal(await readFile(rawArticlePath, "utf8"), rawOriginal);
  assert.deepEqual(await readdir(rawRootExternalTarget), []);
} finally {
  await rm(rawRestoreVault, { recursive: true, force: true });
}

const rawMissingVault = await mkdtemp(path.join(tmpdir(), "codex-raw-missing-"));
try {
  assert.equal((await snapshotRawFileContents(rawMissingVault)).size, 0);
  const missingRawDiscovery = await discoverKnowledgeBaseSources(rawMissingVault, {});
  assert.equal(missingRawDiscovery.sources.length, 0);
} finally {
  await rm(rawMissingVault, { recursive: true, force: true });
}

const rawUnreadableVault = await mkdtemp(path.join(tmpdir(), "codex-raw-unreadable-"));
const rawUnreadableDir = path.join(rawUnreadableVault, "raw", "locked");
try {
  await mkdir(rawUnreadableDir, { recursive: true });
  await chmod(rawUnreadableDir, 0);
  await assert.rejects(() => snapshotRawFileContents(rawUnreadableVault));
  await assert.rejects(() => discoverKnowledgeBaseSources(rawUnreadableVault, {}));
} finally {
  await chmod(rawUnreadableDir, 0o700).catch(() => undefined);
  await rm(rawUnreadableVault, { recursive: true, force: true });
}

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
    lastScheduledRunAt: 30,
    lastScheduledRunStatus: "failed",
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
assert.equal(knowledgeBaseSettings.settingsVersion, DEFAULT_SETTINGS.settingsVersion);
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
assert.equal(knowledgeBaseSettings.knowledgeBase.lastScheduledRunAt, 30);
assert.equal(knowledgeBaseSettings.knowledgeBase.lastScheduledRunStatus, "failed");
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
assert.equal(invalidKnowledgeBaseSettings.knowledgeBase.lastScheduledRunStatus, "idle");

const migratedReviewSettings = normalizeSettingsData({
  settingsVersion: 21,
  review: {
    enabled: true,
    knowledgeBaseEnabled: false,
    agentChatEnabled: true,
    scheduleTime: "22:30",
    catchUpOnStartup: false,
    reports: {
      knowledgeBase: {
        lastRunAt: 10,
        lastRunStatus: "success",
        lastRangeKey: "2026-05-11-to-2026-05-17",
        lastMarkdownPath: "outputs/obsidian-weekly-review/knowledge-base-review-2026-05-11-to-2026-05-17.md",
        lastHtmlPath: "outputs/obsidian-weekly-review/knowledge-base-review-2026-05-11-to-2026-05-17.html",
        lastSummary: "已生成"
      },
      agentChat: {
        lastRunAt: 11,
        lastRunStatus: "failed",
        lastRangeKey: "2026-05-11-to-2026-05-17",
        lastError: "失败"
      }
    }
  }
}).settings;
assert.equal(migratedReviewSettings.review.enabled, false);
assert.equal(migratedReviewSettings.review.knowledgeBaseEnabled, false);
assert.equal(migratedReviewSettings.review.agentChatEnabled, true);
assert.equal(migratedReviewSettings.review.scheduleTime, "22:30");
assert.equal(migratedReviewSettings.review.catchUpOnStartup, false);
assert.equal(migratedReviewSettings.review.outputDir, "outputs");
assert.equal(migratedReviewSettings.review.rangeMode, "previous-week");
assert.equal(migratedReviewSettings.review.openHtmlAfterRun, false);
assert.equal(migratedReviewSettings.review.reports.knowledgeBase.lastRunStatus, "success");
assert.equal(migratedReviewSettings.review.reports.knowledgeBase.lastHtmlPath.endsWith(".html"), true);
assert.equal(migratedReviewSettings.review.reports.agentChat.lastRunStatus, "failed");

const invalidReviewSettings = normalizeSettingsData({
  settingsVersion: 21,
  review: {
    enabled: "yes",
    knowledgeBaseEnabled: "no",
    agentChatEnabled: 1,
    scheduleTime: "25:99",
    catchUpOnStartup: "bad",
    outputDir: "../bad//reports",
    rangeMode: "bad",
    openHtmlAfterRun: "bad",
    reports: {
      knowledgeBase: { lastRunStatus: "bad", lastRunAt: -1, lastHtmlPath: "../bad.html" },
      agentChat: { lastRunStatus: "success", lastMarkdownPath: "outputs/ok.md" }
    }
  }
}).settings.review;
assert.equal(invalidReviewSettings.enabled, false);
assert.equal(invalidReviewSettings.knowledgeBaseEnabled, true);
assert.equal(invalidReviewSettings.agentChatEnabled, true);
assert.equal(invalidReviewSettings.scheduleTime, "21:00");
assert.equal(invalidReviewSettings.catchUpOnStartup, true);
assert.equal(invalidReviewSettings.outputDir, "bad/reports");
assert.equal(invalidReviewSettings.rangeMode, "previous-week");
assert.equal(invalidReviewSettings.openHtmlAfterRun, false);
assert.equal(invalidReviewSettings.reports.knowledgeBase.lastRunStatus, "idle");
assert.equal(invalidReviewSettings.reports.knowledgeBase.lastHtmlPath, "");
assert.equal(invalidReviewSettings.reports.agentChat.lastRunStatus, "success");
assert.equal(invalidReviewSettings.reports.agentChat.lastMarkdownPath, "outputs/ok.md");
assert.equal(normalizeReviewOutputDir("/reports/weekly/../safe"), "reports/weekly/safe");

const reviewRange = currentReviewRange(new Date("2026-05-17T20:30:00+08:00"));
assert.equal(reviewRange.startDate, "2026-05-11");
assert.equal(reviewRange.endDate, "2026-05-17");
assert.equal(reviewRangeKey(reviewRange), "2026-05-11-to-2026-05-17");
const previousWeekRange = reviewRangeForMode("previous-week", new Date("2026-05-18T09:00:00+08:00"));
assert.equal(previousWeekRange.startDate, "2026-05-11");
assert.equal(previousWeekRange.endDate, "2026-05-17");
const currentWeekRange = reviewRangeForMode("current-week", new Date("2026-05-18T09:00:00+08:00"));
assert.equal(currentWeekRange.startDate, "2026-05-18");
assert.equal(currentWeekRange.endDate, "2026-05-18");
const scheduledReviewRange = latestScheduledReviewRange(new Date("2026-05-18T09:00:00+08:00"), "21:00");
assert.equal(scheduledReviewRange?.startDate, "2026-05-11");
assert.equal(scheduledReviewRange?.endDate, "2026-05-17");
assert.equal(shouldRunScheduledReview(DEFAULT_SETTINGS.review, "knowledge-base", new Date("2026-05-18T09:00:00+08:00")), false);
assert.equal(shouldRunScheduledReview({ ...DEFAULT_SETTINGS.review, enabled: true }, "knowledge-base", new Date("2026-05-18T09:00:00+08:00")), true);
assert.equal(shouldRunScheduledReview({ ...DEFAULT_SETTINGS.review, enabled: true, knowledgeBaseEnabled: false }, "knowledge-base", new Date("2026-05-18T09:00:00+08:00")), false);
assert.equal(shouldRunScheduledReview({
  ...DEFAULT_SETTINGS.review,
  enabled: true,
  reports: {
    ...DEFAULT_SETTINGS.review.reports,
    knowledgeBase: { ...DEFAULT_SETTINGS.review.reports.knowledgeBase, lastRangeKey: "2026-05-11-to-2026-05-17" }
  }
}, "knowledge-base", new Date("2026-05-18T09:00:00+08:00")), false);
assert.equal(isReviewHtmlPath("outputs/obsidian-weekly-review/agent-chat-review-2026-05-11-to-2026-05-17.html"), true);
assert.equal(isReviewHtmlPath("outputs/obsidian-weekly-review/agent-chat-review-2026-05-11-to-2026-05-17.md"), false);
assert.equal(isReviewHtmlPath("../outputs/obsidian-weekly-review/bad.html"), false);
assert.equal(isReviewHtmlPath("reviews/agent-chat-review-2026-05-11-to-2026-05-17.html", "reviews"), true);
assert.equal(isReviewHtmlPath("outputs/agent-chat-review-2026-05-11-to-2026-05-17.html", "reviews"), true);
assert.equal(isReviewHtmlPath("other/agent-chat-review-2026-05-11-to-2026-05-17.html", "reviews"), false);

const reviewHtml = renderReviewHtml({
  title: "Codex 使用效率周复盘",
  periodLabel: "2026-05-11 至 2026-05-17",
  scopeLabel: "测试口径",
  verdict: "一眼结论：测试周报。",
  metrics: [
    { label: "有效线程", value: "2" },
    { label: "剔除线程", value: "1" },
    { label: "消息数", value: "4" },
    { label: "失败数", value: "0" }
  ],
  scores: [
    { label: "方向选择", rating: "好", description: "目标集中。" },
    { label: "执行效率", rating: "中", description: "有长线程。" },
    { label: "提示词质量", rating: "中上", description: "样本清楚。" },
    { label: "决策质量", rating: "中上", description: "有证据。" },
    { label: "token 使用效率", rating: "中", description: "可优化。" },
    { label: "使用方式", rating: "好", description: "能复盘。" }
  ],
  distribution: [{ label: "普通 Agent 对话", countLabel: "2 会话 / 4 消息", value: 100, description: "测试分布。" }],
  highQualityPrompts: [{ scene: "测试", excerpt: "请先判断", judgement: "高质量", reason: "验收前置。" }],
  lowEfficiencyPrompts: [{ scene: "测试", excerpt: "做一下", problem: "过泛", impact: "易返工", correction: "补验收。" }],
  goodDecisions: [{ decision: "先做测试", evaluation: "降低回归。" }],
  problemDecisions: [{ decision: "长线程", problem: "上下文重", correction: "拆阶段。" }],
  reworkItems: [{ item: "返工", surfaceCause: "标准晚", deepCause: "没模板", correction: "固定模板。" }],
  goodHabits: [{ habit: "看证据", evaluation: "稳定。" }],
  badHabits: [{ habit: "提示过短", problem: "范围不清", correction: "补背景。" }],
  templates: [{ title: "产品判断类", body: "先不要实现。" }],
  checklist: [{ item: "是否前置验收", judgement: "是。" }],
  finalJudgement: "最终判断：模板稳定。"
});
assert.ok(reviewHtml.startsWith("<!doctype html><html lang=\"zh-CN\">"));
assert.ok(reviewHtml.includes(`<style>\n${REVIEW_HTML_CSS}\n</style>`));
let lastHeadingIndex = -1;
for (const heading of REVIEW_SECTION_HEADINGS) {
  const index = reviewHtml.indexOf(`<h2>${heading}</h2>`);
  assert.ok(index > lastHeadingIndex, `Missing or misordered heading: ${heading}`);
  lastHeadingIndex = index;
}
for (const cls of ["hero", "grid", "score", "barrow", "wide", "low", "decision", "baddecision", "templates"]) {
  assert.ok(reviewHtml.includes(`class="${cls}`) || reviewHtml.includes(`class="${cls}"`), `Missing template class: ${cls}`);
}
assert.ok(reviewHtml.includes("card note"), "Missing template class: note");
assert.equal((reviewHtml.match(/class="tr"/g) ?? []).length >= 8, true);
assert.equal(reviewHtml.includes("purple"), false);

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
assert.equal(apiProviderSettings.settings.settingsVersion, DEFAULT_SETTINGS.settingsVersion);
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
assert.equal(editorActionSettings.settingsVersion, DEFAULT_SETTINGS.settingsVersion);
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
assert.equal(legacyEditorActionSettings.settingsVersion, DEFAULT_SETTINGS.settingsVersion);
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
const websocketDiagnostic = diagnoseCodexError(
  "failed to connect to websocket: No connection could be made because the target machine actively refused it. (os error 10061) url: wss://chatgpt.com/backend-api/codex/responses transport=\"responses_websocket\"",
  { model: "gpt-5.5", providerLabel: "Codex 登录态", proxyEnabled: false, proxyUrl: "http://127.0.0.1:7890" }
);
assert.equal(websocketDiagnostic.kind, "websocket");
assert.match(websocketDiagnostic.text, /Codex WebSocket 连接失败/);
assert.match(websocketDiagnostic.text, /gpt-5\.5/);
assert.match(websocketDiagnostic.text, /启用本地代理/);
assert.match(websocketDiagnostic.text, /原始错误/);
const proxyDiagnostic = diagnoseCodexError(
  "connect ECONNREFUSED 127.0.0.1:7890",
  { model: "", providerLabel: "Codex 登录态", proxyEnabled: true, proxyUrl: "http://127.0.0.1:7890" }
);
assert.equal(proxyDiagnostic.kind, "proxy");
assert.match(proxyDiagnostic.text, /代理连接失败/);
assert.match(proxyDiagnostic.text, /模型 自动/);
assert.equal(diagnoseCodexError("request timed out after 60000ms").kind, "timeout");
assert.equal(diagnoseCodexError("spawn codex ENOENT").kind, "missing-cli");
assert.equal(diagnoseCodexError("app-server exited with code 1").kind, "app-server");
assert.match(formatJsonRpcError({ code: -32000, message: "model timeout", data: { status: 504 } }).message, /错误码：-32000/);
assert.match(formatJsonRpcError({ code: -32000, message: "model timeout", data: { status: 504 } }).message, /status/);
assert.match(formatOpenCodeError({ status: 504, data: { code: "upstream_timeout", message: "upstream timed out" } }), /错误码：upstream_timeout/);
assert.match(formatOpenCodeError({ status: 504, data: { code: "upstream_timeout", message: "upstream timed out" } }), /状态：504/);
assert.equal(diagnoseCodexError(websocketDiagnostic.text).text, websocketDiagnostic.text);
assert.match(diagnoseCodexError("mystery failure").text, /mystery failure/);
const missingCliEnglishDiagnostic = diagnoseCodexError("找不到 Codex CLI：/definitely/missing/codex。请先安装 Codex CLI，或在设置里填写正确路径。", {
  model: "",
  providerLabel: "Codex login",
  proxyEnabled: false,
  proxyUrl: "http://127.0.0.1:7890",
  language: "en"
});
assert.equal(missingCliEnglishDiagnostic.kind, "missing-cli");
assert.match(missingCliEnglishDiagnostic.text, /Codex CLI not found/);
assert.match(missingCliEnglishDiagnostic.text, /Possible cause/);
assert.match(missingCliEnglishDiagnostic.text, /Model Auto/);
assert.doesNotMatch(missingCliEnglishDiagnostic.text, /可能原因|建议处理|当前上下文|原始错误/);
assert.match(diagnoseCodexError(websocketDiagnostic.text, { language: "en" }).text, /Suggested fix/);
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
assert.equal(resolveCodexCommand("", {
  home: "C:\\Users\\demo",
  envPath: "",
  platform: "win32",
  appData: "C:\\Users\\demo\\AppData\\Roaming",
  exists: (candidate) => candidate === "C:\\Users\\demo\\AppData\\Roaming\\npm\\codex.cmd"
}), "C:\\Users\\demo\\AppData\\Roaming\\npm\\codex.cmd");

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
assert.equal(detectOpenCodeCommand("", {
  home: "C:\\Users\\demo",
  envPath: "",
  platform: "win32",
  appData: "C:\\Users\\demo\\AppData\\Roaming",
  exists: (candidate) => candidate === "C:\\Users\\demo\\AppData\\Roaming\\npm\\opencode.cmd"
}), "C:\\Users\\demo\\AppData\\Roaming\\npm\\opencode.cmd");
assert.throws(() => resolveOpenCodeCommand("/definitely/missing/opencode", {
  exists: () => false
}), /找不到 OpenCode CLI/);

const setupDisconnectedStatus = {
  connected: false,
  accountLabel: "未连接",
  loggedIn: false,
  models: [],
  skills: [],
  mcpServers: [],
  rateLimits: null,
  rateLimitsByLimitId: null,
  errors: []
};
const setupConnectedStatus = {
  ...setupDisconnectedStatus,
  connected: true,
  accountLabel: "ChatGPT：demo@example.com",
  loggedIn: true
};
const setupMissingCodex = buildSetupCheck(DEFAULT_SETTINGS, setupDisconnectedStatus, {
  os: "darwin",
  codexCommand: null,
  openCodeCommand: null
});
assert.equal(setupMissingCodex.status, "blocking");
assert.equal(setupMissingCodex.canStart, false);
assert.ok(setupMissingCodex.requirements.some((item) => item.id === "codex-cli" && item.status === "blocking"));
assert.ok(setupMissingCodex.requirements.find((item) => item.id === "codex-cli")?.actions.some((action) => action.value.includes("@openai/codex")));

const setupCodexInstalledNotLoggedIn = buildSetupCheck(DEFAULT_SETTINGS, setupDisconnectedStatus, {
  os: "darwin",
  codexCommand: "/Applications/Codex.app/Contents/Resources/codex",
  openCodeCommand: null
});
assert.equal(setupCodexInstalledNotLoggedIn.status, "blocking");
assert.equal(setupCodexInstalledNotLoggedIn.canStart, false);
assert.ok(setupCodexInstalledNotLoggedIn.requirements.some((item) => item.id === "codex-cli" && item.status === "ok"));
assert.ok(setupCodexInstalledNotLoggedIn.requirements.some((item) => item.id === "codex-login" && item.status === "blocking"));
assert.ok(setupCodexInstalledNotLoggedIn.requirements.find((item) => item.id === "codex-login")?.actions.some((action) => action.value === "codex"));

const setupCodexOnly = buildSetupCheck(DEFAULT_SETTINGS, setupConnectedStatus, {
  os: "darwin",
  codexCommand: "/Applications/Codex.app/Contents/Resources/codex",
  openCodeCommand: null
});
assert.equal(setupCodexOnly.canStart, true);
assert.equal(setupCodexOnly.requirements.find((item) => item.id === "opencode-cli")?.status, "warning");

const setupOpenCodeRequired = buildSetupCheck({
  ...DEFAULT_SETTINGS,
  knowledgeBase: { ...DEFAULT_SETTINGS.knowledgeBase, backend: "opencode" }
}, setupConnectedStatus, {
  os: "win32",
  codexCommand: "C:\\Users\\demo\\AppData\\Roaming\\npm\\codex.cmd",
  openCodeCommand: null
});
assert.equal(setupOpenCodeRequired.status, "blocking");
assert.equal(setupOpenCodeRequired.canStart, false);
assert.ok(setupOpenCodeRequired.requirements.some((item) => item.id === "opencode-cli" && item.status === "blocking"));

const setupOpenCodeServerFailed = buildSetupCheck({
  ...DEFAULT_SETTINGS,
  knowledgeBase: { ...DEFAULT_SETTINGS.knowledgeBase, backend: "opencode" },
  opencode: {
    ...DEFAULT_SETTINGS.opencode,
    lastConnectedAt: 0,
    lastError: "opencode serve failed"
  }
}, setupConnectedStatus, {
  os: "darwin",
  codexCommand: "/Applications/Codex.app/Contents/Resources/codex",
  openCodeCommand: "/opt/homebrew/bin/opencode"
});
assert.equal(setupOpenCodeServerFailed.status, "blocking");
assert.equal(setupOpenCodeServerFailed.canStart, false);
assert.ok(setupOpenCodeServerFailed.requirements.some((item) => item.id === "opencode-server" && item.status === "blocking"));
assert.match(setupOpenCodeServerFailed.requirements.find((item) => item.id === "opencode-server")?.message ?? "", /opencode serve failed/);

const setupOpenCodeReady = buildSetupCheck({
  ...DEFAULT_SETTINGS,
  knowledgeBase: { ...DEFAULT_SETTINGS.knowledgeBase, backend: "opencode" },
  opencode: {
    ...DEFAULT_SETTINGS.opencode,
    providerId: "anthropic",
    modelId: "claude-sonnet-4-20250514",
    agent: "build",
    lastConnectedAt: 1700000000000,
    lastError: ""
  }
}, setupConnectedStatus, {
  os: "win32",
  codexCommand: "C:\\Users\\demo\\AppData\\Roaming\\npm\\codex.cmd",
  openCodeCommand: "C:\\Users\\demo\\AppData\\Roaming\\npm\\opencode.cmd"
});
assert.equal(setupOpenCodeReady.status, "ok");
assert.equal(setupOpenCodeReady.canStart, true);
const setupCompleted = completeSetupState(DEFAULT_SETTINGS.setup, 1700000001234, "0.5.3");
assert.equal(setupCompleted.completedAt, 1700000001234);
assert.equal(setupCompleted.lastCheckedAt, 1700000001234);
assert.equal(setupCompleted.dismissedVersion, "0.5.3");

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
  await mkdir(path.join(kbVault, "wiki", "ai-intelligence", "concepts"), { recursive: true });
  await mkdir(path.join(kbVault, "wiki", "product-method", "concepts"), { recursive: true });
  await mkdir(path.join(kbVault, "journal", "daily", "2026-05"), { recursive: true });
  await mkdir(path.join(kbVault, "outputs", "notes"), { recursive: true });
  await writeFile(path.join(kbVault, "raw", "articles", "demo.md"), "# Demo\n\n正文", "utf8");
  await writeFile(path.join(kbVault, "raw", "articles", "demo.assets", "image.png"), Buffer.from([1, 2, 3]));
  await writeFile(path.join(kbVault, "raw", "attachments", "image.png"), Buffer.from([1, 2, 3]));
  await writeFile(path.join(kbVault, "raw", "attachments", "paper.pdf"), Buffer.from("%PDF-1.7"));
  await writeFile(path.join(kbVault, "raw", "attachments", "doc.docx"), Buffer.from("PK"));
  await writeFile(path.join(kbVault, "raw", "index.md"), "# Raw Index\n", "utf8");
  await writeFile(path.join(kbVault, "raw", "index 2.md"), "# Raw Index Copy\n", "utf8");
  await writeFile(path.join(kbVault, "raw", "ignore.csv"), "a,b", "utf8");
  await writeFile(path.join(kbVault, "raw", "articles", "index 2.md"), "# Article Index Copy\n\n正文", "utf8");
  await writeFile(path.join(kbVault, "raw", "articles", "demo.base.md"), "# Base\n", "utf8");
  await writeFile(path.join(kbVault, "wiki", "ai-intelligence", "concepts", "harness-engineering.md"), [
    "# Harness Engineering",
    "",
    "Harness Engineering 把 Vibe Coding 从一次性生成变成可验证、可回放、可审计的工程系统。",
    "它强调规则、测试、回链和 Agent 协作记录。"
  ].join("\n"), "utf8");
  await writeFile(path.join(kbVault, "wiki", "product-method", "concepts", "roadmap.md"), "# Roadmap\n\n产品路线规划。", "utf8");
  await writeFile(path.join(kbVault, "journal", "daily", "2026-05", "2026-05-18-周一.md"), [
    "# 2026-05-18 周一",
    "",
    "今天复盘节奏偏慢。",
    "Vibe Coding 讨论只作为当天工作背景。"
  ].join("\n"), "utf8");
  await writeFile(path.join(kbVault, "outputs", "notes", "vibe-coding-review.md"), [
    "# Vibe Coding 复盘",
    "",
    "这份输出记录了 Vibe Coding 的阶段性复盘。",
    "它不是稳定知识结论，只适合作为 Outputs 背景。"
  ].join("\n"), "utf8");
  await mkdir(path.join(kbVault, "raw", "clippings"), { recursive: true });
  await writeFile(path.join(kbVault, "raw", "clippings", "clip.md"), "# Clip\n\n正文", "utf8");
  const firstDiscovery = await discoverKnowledgeBaseSources(kbVault, {});
  assert.deepEqual(firstDiscovery.sources.map((source) => source.relativePath).sort(), [
    "raw/articles/demo.md",
    "raw/articles/index 2.md",
    "raw/attachments/doc.docx",
    "raw/attachments/image.png",
    "raw/attachments/paper.pdf",
    "raw/clippings/clip.md"
  ]);
  assert.equal(firstDiscovery.changedSources.length, 6);
  assert.equal(firstDiscovery.sources.find((source) => source.relativePath.endsWith("image.png"))?.modality, "image");
  assert.equal(firstDiscovery.sources.find((source) => source.relativePath.endsWith("paper.pdf"))?.modality, "pdf");
  const demoSource = firstDiscovery.sources.find((source) => source.relativePath === "raw/articles/demo.md")!;
  const secondDiscovery = await discoverKnowledgeBaseSources(kbVault, {
    [demoSource.relativePath]: { size: demoSource.size, mtime: demoSource.mtime }
  });
  assert.equal(secondDiscovery.sources.find((source) => source.relativePath === "raw/articles/demo.md")?.changed, true);
  assert.equal(secondDiscovery.changedSources.length, 6);
  assert.ok(secondDiscovery.reportPath.startsWith("outputs/maintenance/kb-maintenance-"));
  const lintDiscovery = await discoverKnowledgeBaseSources(kbVault, {}, "lint");
  assert.ok(lintDiscovery.reportPath.startsWith("outputs/maintenance/kb-check-"));
  await mkdir(path.join(kbVault, "outputs"), { recursive: true });
  await writeFile(path.join(kbVault, "outputs", ".ingest-tracker.md"), [
    "# Ingest Tracker",
    "",
    "## raw/articles/、raw/clippings/ — 已处理",
    "- demo.md",
    "- clip.md"
  ].join("\n"), "utf8");
  const multiPrefixTrackerBase = new Date(Date.now() - 20_000);
  await utimes(path.join(kbVault, "outputs", ".ingest-tracker.md"), multiPrefixTrackerBase, multiPrefixTrackerBase);
  await utimes(path.join(kbVault, "raw", "articles", "demo.md"), new Date(multiPrefixTrackerBase.getTime() + 1000), new Date(multiPrefixTrackerBase.getTime() + 1000));
  await utimes(path.join(kbVault, "raw", "clippings", "clip.md"), new Date(multiPrefixTrackerBase.getTime() + 1000), new Date(multiPrefixTrackerBase.getTime() + 1000));
  const multiPrefixTrackerDiscovery = await discoverKnowledgeBaseSources(kbVault, {});
  assert.equal(multiPrefixTrackerDiscovery.sources.find((source) => source.relativePath === "raw/articles/demo.md")?.changed, true);
  assert.equal(multiPrefixTrackerDiscovery.sources.find((source) => source.relativePath === "raw/clippings/clip.md")?.changed, true);
  await writeFile(path.join(kbVault, "outputs", ".ingest-tracker.md"), [
    "# Ingest Tracker",
    "",
    "## raw/articles/ — 共 1 个文件",
    "- demo.md：已处理"
  ].join("\n"), "utf8");
  const trackerGraceBase = new Date(Date.now() - 10000);
  await utimes(path.join(kbVault, "outputs", ".ingest-tracker.md"), trackerGraceBase, trackerGraceBase);
  const trackerGraceRawTime = new Date(trackerGraceBase.getTime() + 1500);
  await utimes(path.join(kbVault, "raw", "articles", "demo.md"), trackerGraceRawTime, trackerGraceRawTime);
  const trackerDiscovery = await discoverKnowledgeBaseSources(kbVault, {});
  assert.equal(trackerDiscovery.sources.find((source) => source.relativePath === "raw/articles/demo.md")?.changed, true);
  await writeFile(path.join(kbVault, "raw", "articles", "unlisted.md"), "# Unlisted\n\n正文", "utf8");
  await writeFile(path.join(kbVault, "outputs", ".ingest-tracker.md"), [
    "# Ingest Tracker",
    "",
    "## raw/articles/ — 共 1 个文件",
    "- demo.md：已处理"
  ].join("\n"), "utf8");
  const partialSectionTrackerTime = new Date(Date.now() - 60_000);
  await utimes(path.join(kbVault, "outputs", ".ingest-tracker.md"), partialSectionTrackerTime, partialSectionTrackerTime);
  await utimes(path.join(kbVault, "raw", "articles", "demo.md"), new Date(partialSectionTrackerTime.getTime() - 1000), new Date(partialSectionTrackerTime.getTime() - 1000));
  await utimes(path.join(kbVault, "raw", "articles", "unlisted.md"), new Date(partialSectionTrackerTime.getTime() - 1000), new Date(partialSectionTrackerTime.getTime() - 1000));
  const partialSectionDiscovery = await discoverKnowledgeBaseSources(kbVault, {});
  assert.equal(partialSectionDiscovery.sources.find((source) => source.relativePath === "raw/articles/demo.md")?.changed, true);
  assert.equal(partialSectionDiscovery.sources.find((source) => source.relativePath === "raw/articles/unlisted.md")?.changed, true);
  await rm(path.join(kbVault, "raw", "articles", "unlisted.md"), { force: true });
  await writeFile(path.join(kbVault, "outputs", ".ingest-tracker.md"), [
    "# Ingest Tracker",
    "",
    "## raw/articles/ — 已处理",
    "- demo.md"
  ].join("\n"), "utf8");
  const relativeTrackerBase = new Date(Date.now() - 60_000);
  await utimes(path.join(kbVault, "outputs", ".ingest-tracker.md"), relativeTrackerBase, relativeTrackerBase);
  await utimes(path.join(kbVault, "raw", "articles", "demo.md"), new Date(relativeTrackerBase.getTime() + 30_000), new Date(relativeTrackerBase.getTime() + 30_000));
  const relativeTrackerDiscovery = await discoverKnowledgeBaseSources(kbVault, {});
  assert.equal(relativeTrackerDiscovery.sources.find((source) => source.relativePath === "raw/articles/demo.md")?.changed, true);
  await writeFile(path.join(kbVault, "outputs", ".ingest-tracker.md"), [
    "# Ingest Tracker",
    "",
    "## 风险 / 待处理",
    `- \`raw/articles/demo.md\` | size=${Buffer.byteLength("# Demo\n\n正文", "utf8")} | mtime=100 | fingerprint=${contentFingerprint(Buffer.from("# Demo\n\n正文"))} | digested=2026-05-25T15:57:45.294Z`,
    "",
    "<!-- codex-echoink-kb:start -->",
    "",
    "## Codex EchoInk 处理记录（2026-05-25T15:57:45.294Z）",
    "",
    "",
    "<!-- codex-echoink-kb:end -->"
  ].join("\n"), "utf8");
  const riskSectionTrackerTime = new Date(Date.now() - 60_000);
  await utimes(path.join(kbVault, "outputs", ".ingest-tracker.md"), riskSectionTrackerTime, riskSectionTrackerTime);
  await utimes(path.join(kbVault, "raw", "articles", "demo.md"), new Date(riskSectionTrackerTime.getTime() + 30_000), new Date(riskSectionTrackerTime.getTime() + 30_000));
  const riskSectionDiscovery = await discoverKnowledgeBaseSources(kbVault, {});
  assert.equal(riskSectionDiscovery.sources.find((source) => source.relativePath === "raw/articles/demo.md")?.changed, true);
  await writeFile(path.join(kbVault, "outputs", ".ingest-tracker.md"), [
    "# Ingest Tracker",
    "",
    "<!-- codex-echoink-kb:start -->",
    "",
    "## Codex EchoInk 处理记录（2026-05-25T15:57:45.294Z）",
    "",
    `- \`raw/articles/demo.md\` | size=${Buffer.byteLength("# Demo\n\n正文", "utf8")} | mtime=100 | digested=2026-05-25T15:57:45.294Z`,
    "",
    "<!-- codex-echoink-kb:end -->"
  ].join("\n"), "utf8");
  const legacyTrackerTime = new Date(Date.now() - 60_000);
  await utimes(path.join(kbVault, "outputs", ".ingest-tracker.md"), legacyTrackerTime, legacyTrackerTime);
  const metadataDriftTime = new Date(legacyTrackerTime.getTime() + 30_000);
  await utimes(path.join(kbVault, "raw", "articles", "demo.md"), metadataDriftTime, metadataDriftTime);
  const legacyMetadataDriftDiscovery = await discoverKnowledgeBaseSources(kbVault, {});
  assert.equal(legacyMetadataDriftDiscovery.sources.find((source) => source.relativePath === "raw/articles/demo.md")?.changed, true);
  await writeFile(path.join(kbVault, "outputs", ".ingest-tracker.md"), [
    "# Ingest Tracker",
    "",
    "<!-- codex-echoink-kb:start -->",
    "",
    "## Codex EchoInk 处理记录（2026-05-25T15:57:45.294Z）",
    "",
    `- \`raw/articles/demo.md\` | size=${Buffer.byteLength("# Demo\n\n正文", "utf8")} | mtime=100 | fingerprint=${contentFingerprint(Buffer.from("# Demo\n\n正文"))} | digested=2026-05-25T15:57:45.294Z`,
    "",
    "<!-- codex-echoink-kb:end -->"
  ].join("\n"), "utf8");
  await utimes(path.join(kbVault, "outputs", ".ingest-tracker.md"), legacyTrackerTime, legacyTrackerTime);
  await utimes(path.join(kbVault, "raw", "articles", "demo.md"), metadataDriftTime, metadataDriftTime);
  const metadataDriftDiscovery = await discoverKnowledgeBaseSources(kbVault, {});
  const metadataDriftSource = metadataDriftDiscovery.sources.find((source) => source.relativePath === "raw/articles/demo.md");
  assert.equal(metadataDriftSource?.fingerprint, contentFingerprint(Buffer.from("# Demo\n\n正文")));
  assert.match(metadataDriftSource?.fingerprint ?? "", /^sha256:\d+:[a-f0-9]{64}$/);
  assert.equal(metadataDriftSource?.changed, true);
  await writeFile(path.join(kbVault, "outputs", ".ingest-tracker.md"), [
    "# Ingest Tracker",
    "",
    "## raw/articles/ — 已处理",
    "",
    `- demo.md | size=${Buffer.byteLength("# Demo\n\n正文", "utf8")} | fingerprint=${contentFingerprint(Buffer.from("# Demo\n\n正文"))}`
  ].join("\n"), "utf8");
  await utimes(path.join(kbVault, "outputs", ".ingest-tracker.md"), legacyTrackerTime, legacyTrackerTime);
  await utimes(path.join(kbVault, "raw", "articles", "demo.md"), metadataDriftTime, metadataDriftTime);
  const relativeFingerprintDiscovery = await discoverKnowledgeBaseSources(kbVault, {});
  assert.equal(relativeFingerprintDiscovery.sources.find((source) => source.relativePath === "raw/articles/demo.md")?.changed, true);
  await rm(path.join(kbVault, "outputs", ".ingest-tracker.md"), { force: true });
  const externalTrackerPath = path.join(path.dirname(kbVault), "external-ingest-tracker.md");
  await rm(externalTrackerPath, { force: true });
  await writeFile(externalTrackerPath, [
    "# External Tracker",
    "",
    "<!-- codex-echoink-kb:start -->",
    "",
    "## Codex EchoInk 处理记录（2026-05-25T15:57:45.294Z）",
    "",
    `- \`raw/articles/demo.md\` | size=${Buffer.byteLength("# Demo\n\n正文", "utf8")} | mtime=100 | fingerprint=${contentFingerprint(Buffer.from("# Demo\n\n正文"))} | digested=2026-05-25T15:57:45.294Z`,
    "",
    "<!-- codex-echoink-kb:end -->"
  ].join("\n"), "utf8");
  await symlink(externalTrackerPath, path.join(kbVault, "outputs", ".ingest-tracker.md"));
  const symlinkTrackerDiscovery = await discoverKnowledgeBaseSources(kbVault, {});
  assert.equal(symlinkTrackerDiscovery.sources.find((source) => source.relativePath === "raw/articles/demo.md")?.changed, true);
  await rm(path.join(kbVault, "outputs", ".ingest-tracker.md"), { force: true });
  await rm(externalTrackerPath, { force: true });
  const riskNamedRawPath = path.join(kbVault, "raw", "articles", "AI 风险管理.md");
  await writeFile(riskNamedRawPath, "# Risk\n\n正文", "utf8");
  const riskNamedRawStat = await stat(riskNamedRawPath);
  await writeFile(path.join(kbVault, "outputs", ".ingest-tracker.md"), [
    "# Ingest Tracker",
    "",
    "<!-- codex-echoink-kb:start -->",
    "",
    "## Codex EchoInk 处理记录（2026-05-25T15:57:45.294Z）",
    "",
    `- \`raw/articles/AI 风险管理.md\` | size=${riskNamedRawStat.size} | mtime=100 | fingerprint=${contentFingerprint(Buffer.from("# Risk\n\n正文"))} | digested=2026-05-25T15:57:45.294Z`,
    "",
    "<!-- codex-echoink-kb:end -->"
  ].join("\n"), "utf8");
  const riskTrackerTime = new Date(Date.now() - 60_000);
  await utimes(path.join(kbVault, "outputs", ".ingest-tracker.md"), riskTrackerTime, riskTrackerTime);
  await utimes(riskNamedRawPath, new Date(riskTrackerTime.getTime() + 30_000), new Date(riskTrackerTime.getTime() + 30_000));
  const riskNamedDiscovery = await discoverKnowledgeBaseSources(kbVault, {});
  assert.equal(riskNamedDiscovery.sources.find((source) => source.relativePath === "raw/articles/AI 风险管理.md")?.changed, true);
  await writeFile(path.join(kbVault, "outputs", ".ingest-tracker.md"), [
    "# Ingest Tracker",
    "",
    "## raw/articles/ — 已处理",
    "",
    "- AI 风险管理.md"
  ].join("\n"), "utf8");
  const riskNameSectionTrackerTime = new Date(Date.now() - 60_000);
  await utimes(path.join(kbVault, "outputs", ".ingest-tracker.md"), riskNameSectionTrackerTime, riskNameSectionTrackerTime);
  await utimes(riskNamedRawPath, new Date(riskNameSectionTrackerTime.getTime() - 1000), new Date(riskNameSectionTrackerTime.getTime() - 1000));
  const riskNameSectionDiscovery = await discoverKnowledgeBaseSources(kbVault, {});
  assert.equal(riskNameSectionDiscovery.sources.find((source) => source.relativePath === "raw/articles/AI 风险管理.md")?.changed, true);
  await writeFile(path.join(kbVault, "outputs", ".ingest-tracker.md"), [
    "# Ingest Tracker",
    "",
    "## raw/articles/ — 已处理",
    "",
    "- AI 风险管理.md：已处理"
  ].join("\n"), "utf8");
  const riskNameColonTrackerTime = new Date(Date.now() - 60_000);
  await utimes(path.join(kbVault, "outputs", ".ingest-tracker.md"), riskNameColonTrackerTime, riskNameColonTrackerTime);
  await utimes(riskNamedRawPath, new Date(riskNameColonTrackerTime.getTime() - 1000), new Date(riskNameColonTrackerTime.getTime() - 1000));
  const riskNameColonDiscovery = await discoverKnowledgeBaseSources(kbVault, {});
  assert.equal(riskNameColonDiscovery.sources.find((source) => source.relativePath === "raw/articles/AI 风险管理.md")?.changed, true);
  await mkdir(path.join(kbVault, "raw", "articles", "风险管理"), { recursive: true });
  const riskDirRawPath = path.join(kbVault, "raw", "articles", "风险管理", "demo.md");
  await writeFile(riskDirRawPath, "# Risk Dir\n\n正文", "utf8");
  await writeFile(path.join(kbVault, "outputs", ".ingest-tracker.md"), [
    "# Ingest Tracker",
    "",
    "## raw/articles/风险管理/ — 已处理",
    "",
    "- demo.md"
  ].join("\n"), "utf8");
  const riskDirTrackerTime = new Date(Date.now() - 60_000);
  await utimes(path.join(kbVault, "outputs", ".ingest-tracker.md"), riskDirTrackerTime, riskDirTrackerTime);
  await utimes(riskDirRawPath, new Date(riskDirTrackerTime.getTime() - 1000), new Date(riskDirTrackerTime.getTime() - 1000));
  const riskDirDiscovery = await discoverKnowledgeBaseSources(kbVault, {});
  assert.equal(riskDirDiscovery.sources.find((source) => source.relativePath === "raw/articles/风险管理/demo.md")?.changed, true);
  await rm(path.join(kbVault, "outputs", ".ingest-tracker.md"), { force: true });
  const changedByFingerprintDiscovery = await discoverKnowledgeBaseSources(kbVault, {
    "raw/articles/demo.md": {
      size: metadataDriftSource!.size,
      mtime: metadataDriftSource!.mtime,
      fingerprint: contentFingerprint(Buffer.from("# demo\n\n正文"))
    }
  });
  assert.equal(changedByFingerprintDiscovery.sources.find((source) => source.relativePath === "raw/articles/demo.md")?.changed, true);
  const frontmatterTrustedPath = "raw/articles/frontmatter-trusted.md";
  const frontmatterTrustedBefore = Buffer.from("# Frontmatter Trusted\n\n正文", "utf8");
  const frontmatterTrustedFingerprint = rawDigestFingerprint(frontmatterTrustedPath, frontmatterTrustedBefore);
  await writeFile(path.join(kbVault, frontmatterTrustedPath), applyRawDigestFrontmatter(frontmatterTrustedBefore, {
    rawPath: frontmatterTrustedPath,
    fingerprint: frontmatterTrustedFingerprint,
    size: frontmatterTrustedBefore.length,
    mtime: 100,
    digestedAt: Date.parse("2026-06-04T01:00:00.000Z"),
    runId: "frontmatter-trusted",
    reportPath: "outputs/maintenance/kb-maintenance-2026-06-04.md",
    evidencePaths: ["wiki/ai-intelligence/references/frontmatter-trusted.md"],
    confidence: "verified"
  }), "utf8");
  const frontmatterTrustedDiscovery = await discoverKnowledgeBaseSources(kbVault, {});
  assert.equal(frontmatterTrustedDiscovery.sources.find((source) => source.relativePath === frontmatterTrustedPath)?.changed, false);
  const docSourceForRegistry = frontmatterTrustedDiscovery.sources.find((source) => source.relativePath === "raw/attachments/doc.docx")!;
  await writeFile(path.join(kbVault, "outputs", ".raw-digest-registry.json"), JSON.stringify({
    schemaVersion: 1,
    updatedAt: "2026-06-04T01:00:00.000Z",
    entries: {
      "raw/attachments/doc.docx": {
        rawPath: "raw/attachments/doc.docx",
        fingerprint: docSourceForRegistry.fingerprint,
        size: docSourceForRegistry.size,
        mtime: docSourceForRegistry.mtime,
        digestedAt: Date.parse("2026-06-04T01:00:00.000Z"),
        runId: "registry-trusted",
        reportPath: "outputs/maintenance/kb-maintenance-2026-06-04.md",
        evidencePaths: ["wiki/ai-intelligence/references/doc.md"],
        confidence: "verified"
      }
    }
  }, null, 2), "utf8");
  const registryTrustedDiscovery = await discoverKnowledgeBaseSources(kbVault, {});
  assert.equal(registryTrustedDiscovery.sources.find((source) => source.relativePath === "raw/attachments/doc.docx")?.changed, false);

  const kbPrompt = buildKnowledgeBasePrompt({
    vaultPath: kbVault,
    mode: "maintain",
    reportPath: secondDiscovery.reportPath,
    sources: secondDiscovery.changedSources,
    rulesFilePath: DEFAULT_KNOWLEDGE_BASE_RULES_FILE,
    rulesFileExists: true,
    useCustomRulesFile: true,
    hasRawIndex: true,
    hasWikiIndex: true,
    hasTracker: false
  });
  assert.ok(kbPrompt.includes("执行 Ingest + Structure Normalize + Lint"));
  assert.ok(kbPrompt.includes(`自定义规则文件：${DEFAULT_KNOWLEDGE_BASE_RULES_FILE}`));
  assert.ok(kbPrompt.includes("知识库结构以这个文件为准"));
  assert.ok(kbPrompt.includes("不要把 AGENTS.md 当作知识库规则合并"));
  assert.ok(kbPrompt.includes(`${DEFAULT_KNOWLEDGE_BASE_RULES_FILE}: 存在，必须读取`));
  assert.ok(kbPrompt.includes("raw/attachments/image.png"));
  assert.ok(kbPrompt.includes("raw/index.md"));
  assert.ok(kbPrompt.includes("只适用于本次知识库管理任务"));
  assert.ok(kbPrompt.includes("raw/ 源文件内容边界"));
  assert.ok(kbPrompt.includes("只有 EchoInk 插件后处理阶段可以写入 raw Markdown 的托管元属性"));
  assert.ok(kbPrompt.includes("raw 路径不在每日维护中自动整理"));
  assert.ok(kbPrompt.includes("本轮来源列表外的新 raw 文件"));
  assert.ok(kbPrompt.includes("非索引正文页留下结构层证据"));
  assert.ok(kbPrompt.includes("禁止用 `标题 2.md`"));
  assert.ok(kbPrompt.includes("必须读取并更新原始正式文件"));
  assert.ok(kbPrompt.includes("Structure Normalize"));
  assert.ok(kbPrompt.includes("低风险自动执行"));
  assert.ok(kbPrompt.includes("不确定或会断链的改动只写进报告"));
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
  assert.equal(stripAskCommand("/ask Harness Engineering 和 Vibe Coding 有什么关系？"), "Harness Engineering 和 Vibe Coding 有什么关系？");
  const askMatches = await findKnowledgeBaseAskMatches(kbVault, "Harness Engineering 和 Vibe Coding 有什么关系？");
  assert.equal(askMatches[0]?.relativePath, "wiki/ai-intelligence/concepts/harness-engineering.md");
  assert.ok(askMatches[0]?.excerpt.includes("Vibe Coding"));
  assert.equal(askMatches[0]?.bucket, "wiki");
  assert.equal(askMatches[0]?.relevance, "strong");
  assert.ok(askMatches[0]?.excerptLines.length >= 2);
  assert.ok(askMatches[0]?.excerptLines.length <= 4);
  assert.ok(askMatches.some((match) => match.bucket === "journal"));
  assert.ok(askMatches.some((match) => match.bucket === "outputs"));
  const askCitations = buildKnowledgeBaseCitationSummary(askMatches);
  assert.equal(askCitations.status, "strong");
  assert.ok(askCitations.counts.wiki >= 1);
  assert.ok(askCitations.counts.journal >= 1);
  assert.ok(askCitations.counts.outputs >= 1);
  assert.equal(askCitations.citations[0]?.path, "wiki/ai-intelligence/concepts/harness-engineering.md");
  const weakAskMatches = await findKnowledgeBaseAskMatches(kbVault, "节奏安排");
  const weakCitations = buildKnowledgeBaseCitationSummary(weakAskMatches);
  assert.equal(weakCitations.status, "weak");
  assert.equal(weakCitations.counts.journal, 1);
  assert.equal(weakCitations.counts.wiki, 0);
  const emptyCitations = buildKnowledgeBaseCitationSummary([]);
  assert.equal(emptyCitations.status, "none");
  assert.equal(emptyCitations.counts.wiki, 0);
  await writeFile(path.join(kbVault, "journal", "daily", "2026-05", "2026-05-19-周二.md"), [
    "# 2026-05-19 周二",
    "",
    "Daily Check List",
    "本地 evidence 和 local note 只是流程词，不代表具体知识命中。"
  ].join("\n"), "utf8");
  await writeFile(path.join(kbVault, "outputs", "notes", "local-evidence-check.md"), [
    "# Local evidence check",
    "",
    "This file mentions local evidence check as generic testing wording."
  ].join("\n"), "utf8");
  const unrelatedMatches = await findKnowledgeBaseAskMatches(kbVault, "zqxjv-178293 totally unrelated local evidence check");
  const unrelatedCitations = buildKnowledgeBaseCitationSummary(unrelatedMatches);
  assert.equal(unrelatedMatches.length, 0);
  assert.equal(unrelatedCitations.status, "none");
  assert.deepEqual(unrelatedCitations.counts, { wiki: 0, journal: 0, outputs: 0 });
  const askPrompt = buildKnowledgeBaseAskPrompt({
    vaultPath: kbVault,
    userRequest: "Harness Engineering 和 Vibe Coding 有什么关系？",
    rulesFilePath: DEFAULT_KNOWLEDGE_BASE_RULES_FILE,
    rulesFileExists: true,
    useCustomRulesFile: true,
    matches: askMatches
  });
  assert.ok(askPrompt.includes("只读问答任务"));
  assert.ok(askPrompt.includes("Wiki 是优先依据"));
  assert.ok(askPrompt.includes("Journal / Outputs 只作为背景或过程依据"));
  assert.ok(askPrompt.includes("可以使用可用搜索工具、外部资料或模型已有知识补充"));
  assert.ok(askPrompt.includes("必须区分“来自 Vault 的依据”和“补充信息 / 推断”"));
  assert.ok(askPrompt.includes("wiki/ai-intelligence/concepts/harness-engineering.md"));
  assert.ok(askPrompt.includes("来源集合：Wiki"));
  assert.ok(askPrompt.includes("引用片段"));
  assert.ok(buildKnowledgeBaseAskPrompt({
    vaultPath: kbVault,
    userRequest: "完全没有命中的问题",
    rulesFilePath: "AGENTS.md",
    rulesFileExists: false,
    useCustomRulesFile: false,
    matches: []
  }).includes("未找到相关本地来源"));
  await mkdir(path.dirname(path.join(kbVault, secondDiscovery.reportPath)), { recursive: true });
  await writeFile(path.join(kbVault, secondDiscovery.reportPath), "---\nmode: lint-only\n---\n# 体检报告\n\n这是一份已经生成的报告。", "utf8");
  const reportExcerpt = await readKnowledgeBaseReportExcerpt(kbVault, secondDiscovery.reportPath);
  assert.equal(reportExcerpt, "---\nmode: lint-only\n---\n# 体检报告\n\n这是一份已经生成的报告。");
  assert.equal(isLintOnlyKnowledgeBaseReport(reportExcerpt!), true);
  assert.equal(isLintOnlyKnowledgeBaseReport("# 维护报告\n\n执行 Ingest + Lint"), false);
  assert.equal(isLintOnlyKnowledgeBaseReport("# 维护报告\n\n不是 lint-only。"), false);
  assert.equal(isLintOnlyKnowledgeBaseReport("# Check\n\nnot lint-only."), false);
  assert.equal(isLintOnlyKnowledgeBaseReport("# 维护报告\n\n不是只执行体检，而是执行 Ingest + Lint。"), false);
  assert.equal(isLintOnlyKnowledgeBaseReport("# 维护报告\n\n并非只执行 Lint，而是执行维护。"), false);
  const recoveredSummary = recoveredLintReportSummary(secondDiscovery.reportPath);
  assert.ok(recoveredSummary.includes(secondDiscovery.reportPath));
  assert.ok(!recoveredSummary.includes("created:"));
  assert.ok(!recoveredSummary.includes("# 体检报告"));
  assert.equal(shouldRecoverKnowledgeBaseLintFailure("Codex 连接失败", reportExcerpt), true);
  assert.equal(shouldRecoverKnowledgeBaseLintFailure(formatRawIntegrityError(["raw/articles/demo.md 文件内容被改写"], true), reportExcerpt), false);
  assert.equal(await readKnowledgeBaseReportExcerpt(kbVault, "outputs/missing.md"), null);
  const staleFallbackPath = "outputs/maintenance/kb-maintenance-stale.md";
  await writeFile(path.join(kbVault, staleFallbackPath), "# 旧报告\n\n上一轮结果", "utf8");
  const fallbackStartedAt = Date.now() - 30_000;
  await utimes(path.join(kbVault, staleFallbackPath), new Date(fallbackStartedAt - 60_000), new Date(fallbackStartedAt - 60_000));
  await ensureKnowledgeBaseFallbackReport(kbVault, staleFallbackPath, {
    mode: "lint",
    output: "本轮体检结果",
    sources: [],
    startedAt: fallbackStartedAt
  });
  const fallbackText = await readFile(path.join(kbVault, staleFallbackPath), "utf8");
  assert.ok(fallbackText.includes("fallback: true"));
  assert.ok(fallbackText.includes("本轮体检结果"));
  assert.ok(!fallbackText.includes("上一轮结果"));
  assert.equal(await readFreshKnowledgeBaseReportExcerpt(kbVault, staleFallbackPath, fallbackStartedAt), fallbackText.trim().slice(0, 1000).trim());
  const nearStaleFallbackPath = "outputs/maintenance/kb-maintenance-near-stale.md";
  await writeFile(path.join(kbVault, nearStaleFallbackPath), "# 近邻旧报告\n\n不应复用", "utf8");
  const nearStaleTime = new Date(fallbackStartedAt - 10);
  await utimes(path.join(kbVault, nearStaleFallbackPath), nearStaleTime, nearStaleTime);
  const nearStalePreviousMtime = await readKnowledgeBaseReportMtime(kbVault, nearStaleFallbackPath);
  assert.equal(await readFreshKnowledgeBaseReportExcerpt(kbVault, nearStaleFallbackPath, fallbackStartedAt, { previousMtimeMs: nearStalePreviousMtime }), null);
  await ensureKnowledgeBaseFallbackReport(kbVault, nearStaleFallbackPath, {
    mode: "lint",
    output: "近邻本轮结果",
    sources: [],
    startedAt: fallbackStartedAt,
    previousMtimeMs: nearStalePreviousMtime
  });
  const nearStaleText = await readFile(path.join(kbVault, nearStaleFallbackPath), "utf8");
  assert.ok(nearStaleText.includes("近邻本轮结果"));
  assert.ok(!nearStaleText.includes("不应复用"));
  const symlinkFallbackPath = "outputs/maintenance/kb-maintenance-symlink.md";
  const symlinkOutsideTarget = path.join(kbVault, "outside-report-target.md");
  await writeFile(symlinkOutsideTarget, "# Outside\n\n不能被报告写入污染", "utf8");
  await symlink(symlinkOutsideTarget, path.join(kbVault, symlinkFallbackPath));
  await ensureKnowledgeBaseFallbackReport(kbVault, symlinkFallbackPath, {
    mode: "lint",
    output: "symlink 本轮结果",
    sources: [],
    startedAt: fallbackStartedAt
  });
  assert.equal(await readFile(symlinkOutsideTarget, "utf8"), "# Outside\n\n不能被报告写入污染");
  assert.equal((await lstat(path.join(kbVault, symlinkFallbackPath))).isSymbolicLink(), false);
  const symlinkFallbackText = await readFile(path.join(kbVault, symlinkFallbackPath), "utf8");
  assert.ok(symlinkFallbackText.includes("symlink 本轮结果"));
  const traversalReportOutside = path.join(path.dirname(kbVault), "kb-report-traversal.md");
  await rm(traversalReportOutside, { force: true });
  await assert.rejects(
    () => ensureKnowledgeBaseFallbackReport(kbVault, "../kb-report-traversal.md", {
      mode: "lint",
      output: "不应写出 Vault",
      sources: [],
      startedAt: fallbackStartedAt
    }),
    /知识库报告路径越界/
  );
  assert.equal(await fileExists(traversalReportOutside), false);
  const freshFallbackPath = "outputs/maintenance/kb-maintenance-fresh.md";
  const freshLintOnlyReport = "---\nmode: lint-only\n---\n# 新报告\n\nAgent 已写入";
  await writeFile(path.join(kbVault, freshFallbackPath), freshLintOnlyReport, "utf8");
  await utimes(path.join(kbVault, freshFallbackPath), new Date(fallbackStartedAt + 10_000), new Date(fallbackStartedAt + 10_000));
  const freshPreviousMtime = fallbackStartedAt - 10_000;
  await ensureKnowledgeBaseFallbackReport(kbVault, freshFallbackPath, {
    mode: "lint",
    output: "不应覆盖",
    sources: [],
    startedAt: fallbackStartedAt,
    previousMtimeMs: freshPreviousMtime
  });
  assert.equal(await readFile(path.join(kbVault, freshFallbackPath), "utf8"), freshLintOnlyReport);
  const staleRecoveredPath = "outputs/maintenance/kb-maintenance-stale-recovered.md";
  await writeFile(path.join(kbVault, staleRecoveredPath), "# 旧体检报告\n\n上一轮报告", "utf8");
  await utimes(path.join(kbVault, staleRecoveredPath), new Date(fallbackStartedAt - 10_000), new Date(fallbackStartedAt - 10_000));
  assert.equal(await readFreshKnowledgeBaseReportExcerpt(kbVault, staleRecoveredPath, fallbackStartedAt), null);
  assert.equal(await readFreshKnowledgeBaseReportExcerpt(kbVault, freshFallbackPath, fallbackStartedAt), freshLintOnlyReport);
  const scheduledReportText = [
    "---",
    "type: kb-maintenance-report",
    "---",
    "",
    "# 知识库维护报告 - 2026-05-19",
    "",
    "## 一眼结论",
    "",
    "无变化。",
    "",
    "本轮没有新增 raw。",
    "",
    "## 体检发现",
    "",
    "断链 0。"
  ].join("\n");
  assert.equal(extractKnowledgeBaseReportConclusion(scheduledReportText), "无变化。 本轮没有新增 raw。");
  const scheduledMessage = buildScheduledKnowledgeBaseMessage({
    status: "success",
    reportPath: "outputs/kb-maintenance-2026-05-19.md",
    summary: "fallback",
    processedSources: []
  }, scheduledReportText);
  assert.ok(scheduledMessage.includes("每日维护执行完毕。"));
  assert.ok(scheduledMessage.includes("- 状态：成功"));
  assert.ok(scheduledMessage.includes("- 报告：outputs/kb-maintenance-2026-05-19.md"));
  assert.ok(scheduledMessage.includes("- 摘要：无变化。 本轮没有新增 raw。"));
  const scheduledConcurrentRawMessage = buildScheduledKnowledgeBaseMessage({
    status: "success",
    reportPath: "outputs/kb-maintenance-2026-06-03.md",
    summary: "fallback",
    processedSources: [],
    externalRawAdditions: ["raw/articles/GitHub项目收集/2026-06-03 GitHub 热门项目简报.md"]
  }, scheduledReportText);
  assert.ok(scheduledConcurrentRawMessage.includes("运行中新出现 1 个 raw，已保留，留到下次 /maintain。"));

  const scheduledAppendFailureVault = await mkdtemp(path.join(tmpdir(), "codex-kb-scheduled-append-failure-"));
  try {
    const scheduledAppendSettings = normalizeSettingsData({
      settingsVersion: DEFAULT_SETTINGS.settingsVersion,
      knowledgeBase: {
        enabled: true,
        scheduleEnabled: true,
        catchUpOnStartup: true,
        scheduleTime: "00:00"
      },
      sessions: [{
        id: "kb-scheduled-existing",
        title: KNOWLEDGE_BASE_SESSION_TITLE,
        kind: "knowledge-base",
        cwd: scheduledAppendFailureVault,
        messages: [],
        createdAt: Date.now(),
        updatedAt: Date.now()
      }]
    }).settings;
    scheduledAppendSettings.knowledgeBase.sessionId = "kb-scheduled-existing";
    let scheduledAppendSaveCalls = 0;
    const scheduledAppendRawRef = "raw/scheduled-orphan.txt";
    const scheduledAppendRawPath = path.join(pluginDataDir(scheduledAppendFailureVault), scheduledAppendRawRef);
    const scheduledAppendManager = new KnowledgeBaseManager({
      settings: scheduledAppendSettings,
      getVaultPath: () => scheduledAppendFailureVault,
      saveSettings: async () => {
        scheduledAppendSaveCalls += 1;
        if (scheduledAppendSaveCalls === 1) throw new Error("scheduled message save failed");
      },
      getPluginDataDirName: () => "codex-echoink",
      externalizeMessageText: async (message: ChatMessage) => {
        message.rawRef = scheduledAppendRawRef;
        await mkdir(path.dirname(scheduledAppendRawPath), { recursive: true });
        await writeFile(scheduledAppendRawPath, "orphan scheduled message", "utf8");
      },
      getCodexView: () => ({
        refreshAfterBackgroundKnowledgeMessage: () => {
          throw new Error("should not refresh unsaved scheduled message");
        },
        refreshKnowledgeBaseDashboard: () => undefined
	      }),
	      getReviewManager: () => null,
	      pruneKnowledgeBaseHistoryByRetention: async () => ({ removedDayCount: 0, removedMessageCount: 0 }),
	      activateKnowledgeBaseChannel: async () => undefined,
	      addCommand: () => undefined,
      addRibbonIcon: () => undefined,
      registerInterval: () => undefined,
      app: { workspace: { onLayoutReady: () => undefined, getActiveFile: () => null } }
    } as any);
    (scheduledAppendManager as any).runMaintenance = async (): Promise<KnowledgeBaseRunResult> => {
      scheduledAppendSettings.knowledgeBase.lastRunAt = Date.now();
      scheduledAppendSettings.knowledgeBase.lastRunStatus = "success";
      scheduledAppendSettings.knowledgeBase.lastError = "";
      return {
        status: "success",
        reportPath: "",
        summary: "scheduled ok",
        processedSources: []
      };
    };
    await (scheduledAppendManager as any).runScheduledIfDue(true);
    assert.equal(scheduledAppendSettings.knowledgeBase.lastRunStatus, "success");
    assert.equal(scheduledAppendSettings.knowledgeBase.lastScheduledRunStatus, "success");
    assert.ok(scheduledAppendSettings.knowledgeBase.lastScheduledRunAt > 0);
    assert.match(scheduledAppendSettings.knowledgeBase.lastError, /自动维护消息保存失败：scheduled message save failed/);
    assert.equal(scheduledAppendSettings.sessions.length, 1);
    assert.equal(scheduledAppendSettings.sessions[0].messages.length, 0);
    assert.equal(scheduledAppendSaveCalls, 2);
    assert.equal(await fileExists(scheduledAppendRawPath), false);
  } finally {
    await rm(scheduledAppendFailureVault, { recursive: true, force: true });
  }

  const scheduledAppendRefreshFailureVault = await mkdtemp(path.join(tmpdir(), "codex-kb-scheduled-refresh-failure-"));
  try {
    const scheduledRefreshSettings = normalizeSettingsData({
      settingsVersion: DEFAULT_SETTINGS.settingsVersion,
      knowledgeBase: {
        enabled: true,
        scheduleEnabled: true,
        catchUpOnStartup: true,
        scheduleTime: "00:00"
      },
      sessions: [{
        id: "kb-scheduled-refresh",
        title: KNOWLEDGE_BASE_SESSION_TITLE,
        kind: "knowledge-base",
        cwd: scheduledAppendRefreshFailureVault,
        messages: [],
        createdAt: Date.now(),
        updatedAt: Date.now()
      }]
    }).settings;
    scheduledRefreshSettings.knowledgeBase.sessionId = "kb-scheduled-refresh";
    let scheduledRefreshSaveCalls = 0;
    const scheduledRefreshManager = new KnowledgeBaseManager({
      settings: scheduledRefreshSettings,
      getVaultPath: () => scheduledAppendRefreshFailureVault,
      saveSettings: async () => {
        scheduledRefreshSaveCalls += 1;
      },
      externalizeMessageText: async () => undefined,
      getCodexView: () => ({
        refreshAfterBackgroundKnowledgeMessage: () => {
          throw new Error("scheduled dashboard refresh failed");
        },
        refreshKnowledgeBaseDashboard: () => undefined
	      }),
	      getReviewManager: () => null,
	      pruneKnowledgeBaseHistoryByRetention: async () => ({ removedDayCount: 0, removedMessageCount: 0 }),
	      activateKnowledgeBaseChannel: async () => undefined,
	      addCommand: () => undefined,
      addRibbonIcon: () => undefined,
      registerInterval: () => undefined,
      app: { workspace: { onLayoutReady: () => undefined, getActiveFile: () => null } }
    } as any);
    (scheduledRefreshManager as any).runMaintenance = async (): Promise<KnowledgeBaseRunResult> => {
      scheduledRefreshSettings.knowledgeBase.lastRunAt = Date.now();
      scheduledRefreshSettings.knowledgeBase.lastRunStatus = "success";
      scheduledRefreshSettings.knowledgeBase.lastError = "";
      return {
        status: "success",
        reportPath: "",
        summary: "scheduled ok",
        processedSources: []
      };
    };
    const warnBeforeScheduledRefreshFailureTest = console.warn;
    const scheduledRefreshWarnings: unknown[][] = [];
    try {
      console.warn = (...args: unknown[]) => {
        scheduledRefreshWarnings.push(args);
      };
      await (scheduledRefreshManager as any).runScheduledIfDue(true);
    } finally {
      console.warn = warnBeforeScheduledRefreshFailureTest;
    }
    assert.equal(scheduledRefreshSettings.knowledgeBase.lastRunStatus, "success");
    assert.equal(scheduledRefreshSettings.knowledgeBase.lastScheduledRunStatus, "success");
    assert.ok(scheduledRefreshSettings.knowledgeBase.lastScheduledRunAt > 0);
    assert.equal(scheduledRefreshSettings.knowledgeBase.lastError, "");
    assert.equal(scheduledRefreshSettings.sessions.length, 1);
    assert.equal(scheduledRefreshSettings.sessions[0].messages.length, 1);
    assert.equal(scheduledRefreshSettings.sessions[0].messages[0].status, "completed");
    assert.equal((scheduledRefreshSettings.sessions[0] as any).knowledgeContext, undefined);
    assert.equal(scheduledRefreshSaveCalls, 1);
    assert.equal(scheduledRefreshWarnings.length, 1);
    assert.equal(scheduledRefreshWarnings[0][0], "每日维护消息刷新失败");
  } finally {
    await rm(scheduledAppendRefreshFailureVault, { recursive: true, force: true });
  }

  const scheduledAppendConcurrentSessionVault = await mkdtemp(path.join(tmpdir(), "codex-kb-scheduled-append-concurrent-"));
  try {
    const scheduledConcurrentSettings = normalizeSettingsData({
      settingsVersion: DEFAULT_SETTINGS.settingsVersion,
      knowledgeBase: {
        enabled: true,
        scheduleEnabled: true,
        catchUpOnStartup: true,
        scheduleTime: "00:00"
      },
      sessions: [{
        id: "kb-scheduled-concurrent",
        title: KNOWLEDGE_BASE_SESSION_TITLE,
        kind: "knowledge-base",
        cwd: scheduledAppendConcurrentSessionVault,
        messages: [],
        createdAt: Date.now(),
        updatedAt: Date.now()
      }]
    }).settings;
    scheduledConcurrentSettings.knowledgeBase.sessionId = "kb-scheduled-concurrent";
    let scheduledConcurrentSaveCalls = 0;
    const scheduledConcurrentManager = new KnowledgeBaseManager({
      settings: scheduledConcurrentSettings,
      getVaultPath: () => scheduledAppendConcurrentSessionVault,
      saveSettings: async () => {
        scheduledConcurrentSaveCalls += 1;
        if (scheduledConcurrentSaveCalls === 1) throw new Error("scheduled message save failed");
      },
      externalizeMessageText: async () => {
        scheduledConcurrentSettings.sessions.push({
          id: "manual-session-created-during-scheduled-message",
          title: "手动会话",
          kind: "chat",
          cwd: scheduledAppendConcurrentSessionVault,
          messages: [{ id: "manual-message", role: "user", text: "用户同时发了一条消息", createdAt: Date.now() }],
          createdAt: Date.now(),
          updatedAt: Date.now()
        });
      },
      getCodexView: () => ({
        refreshAfterBackgroundKnowledgeMessage: () => {
          throw new Error("should not refresh unsaved scheduled message");
        },
        refreshKnowledgeBaseDashboard: () => undefined
	      }),
	      getReviewManager: () => null,
	      pruneKnowledgeBaseHistoryByRetention: async () => ({ removedDayCount: 0, removedMessageCount: 0 }),
	      activateKnowledgeBaseChannel: async () => undefined,
	      addCommand: () => undefined,
      addRibbonIcon: () => undefined,
      registerInterval: () => undefined,
      app: { workspace: { onLayoutReady: () => undefined, getActiveFile: () => null } }
    } as any);
    (scheduledConcurrentManager as any).runMaintenance = async (): Promise<KnowledgeBaseRunResult> => {
      scheduledConcurrentSettings.knowledgeBase.lastRunAt = Date.now();
      scheduledConcurrentSettings.knowledgeBase.lastRunStatus = "success";
      scheduledConcurrentSettings.knowledgeBase.lastError = "";
      return {
        status: "success",
        reportPath: "",
        summary: "scheduled ok",
        processedSources: []
      };
    };
    await (scheduledConcurrentManager as any).runScheduledIfDue(true);
    assert.equal(scheduledConcurrentSettings.knowledgeBase.lastRunStatus, "success");
    assert.match(scheduledConcurrentSettings.knowledgeBase.lastError, /自动维护消息保存失败：scheduled message save failed/);
    assert.equal(scheduledConcurrentSettings.sessions.some((session) => session.id === "manual-session-created-during-scheduled-message"), true);
    assert.equal(scheduledConcurrentSettings.sessions.find((session) => session.id === "kb-scheduled-concurrent")?.messages.length, 0);
    assert.equal(scheduledConcurrentSaveCalls, 2);
  } finally {
    await rm(scheduledAppendConcurrentSessionVault, { recursive: true, force: true });
  }

  const scheduledAppendConcurrentSameSessionVault = await mkdtemp(path.join(tmpdir(), "codex-kb-scheduled-append-same-session-"));
  try {
    const scheduledSameSessionSettings = normalizeSettingsData({
      settingsVersion: DEFAULT_SETTINGS.settingsVersion,
      knowledgeBase: {
        enabled: true,
        scheduleEnabled: true,
        catchUpOnStartup: true,
        scheduleTime: "00:00"
      },
      sessions: [{
        id: "kb-scheduled-same-session",
        title: KNOWLEDGE_BASE_SESSION_TITLE,
        kind: "knowledge-base",
        cwd: scheduledAppendConcurrentSameSessionVault,
        messages: [],
        createdAt: Date.now(),
        updatedAt: Date.now()
      }]
    }).settings;
    scheduledSameSessionSettings.knowledgeBase.sessionId = "kb-scheduled-same-session";
    let scheduledSameSessionSaveCalls = 0;
    const manualMessageCreatedAt = Date.now() + 60_000;
    const scheduledSameSessionManager = new KnowledgeBaseManager({
      settings: scheduledSameSessionSettings,
      getVaultPath: () => scheduledAppendConcurrentSameSessionVault,
      saveSettings: async () => {
        scheduledSameSessionSaveCalls += 1;
        if (scheduledSameSessionSaveCalls === 1) throw new Error("scheduled message save failed");
      },
      externalizeMessageText: async () => {
        const session = scheduledSameSessionSettings.sessions.find((item) => item.id === "kb-scheduled-same-session");
        assert.ok(session);
        session.messages.push({ id: "manual-message-same-session", role: "user", text: "用户同时在知识库频道发消息", createdAt: manualMessageCreatedAt });
        session.updatedAt = manualMessageCreatedAt;
      },
      getCodexView: () => ({
        refreshAfterBackgroundKnowledgeMessage: () => {
          throw new Error("should not refresh unsaved scheduled message");
        },
        refreshKnowledgeBaseDashboard: () => undefined
	      }),
	      getReviewManager: () => null,
	      pruneKnowledgeBaseHistoryByRetention: async () => ({ removedDayCount: 0, removedMessageCount: 0 }),
	      activateKnowledgeBaseChannel: async () => undefined,
	      addCommand: () => undefined,
      addRibbonIcon: () => undefined,
      registerInterval: () => undefined,
      app: { workspace: { onLayoutReady: () => undefined, getActiveFile: () => null } }
    } as any);
    (scheduledSameSessionManager as any).runMaintenance = async (): Promise<KnowledgeBaseRunResult> => {
      scheduledSameSessionSettings.knowledgeBase.lastRunAt = Date.now();
      scheduledSameSessionSettings.knowledgeBase.lastRunStatus = "success";
      scheduledSameSessionSettings.knowledgeBase.lastError = "";
      return {
        status: "success",
        reportPath: "",
        summary: "scheduled ok",
        processedSources: []
      };
    };
    await (scheduledSameSessionManager as any).runScheduledIfDue(true);
    const session = scheduledSameSessionSettings.sessions.find((item) => item.id === "kb-scheduled-same-session");
    assert.ok(session);
    assert.deepEqual(session.messages.map((message) => message.id), ["manual-message-same-session"]);
    assert.equal(session.updatedAt, manualMessageCreatedAt);
    assert.equal(scheduledSameSessionSaveCalls, 2);
  } finally {
    await rm(scheduledAppendConcurrentSameSessionVault, { recursive: true, force: true });
  }

  const historySettings = normalizeSettingsData({
    sessions: [{
      id: "kb-history-store",
      title: KNOWLEDGE_BASE_SESSION_TITLE,
      kind: "knowledge-base",
      cwd: kbVault,
      messages: [
        { id: "h-18-user", role: "user", text: "旧日问题", createdAt: new Date(2026, 4, 18, 10, 0, 0).getTime() },
        { id: "h-18-assistant", role: "assistant", text: "旧日回答", createdAt: new Date(2026, 4, 18, 10, 1, 0).getTime() },
        { id: "h-19-user", role: "user", text: "今日问题", createdAt: new Date(2026, 4, 19, 9, 0, 0).getTime() },
        { id: "h-19-process", role: "system", itemType: "reasoning", title: "思考", text: "过程", status: "completed", createdAt: new Date(2026, 4, 19, 9, 0, 1).getTime() }
      ],
      createdAt: new Date(2026, 4, 18, 10, 0, 0).getTime(),
      updatedAt: new Date(2026, 4, 19, 9, 0, 1).getTime()
    }],
    activeSessionId: "kb-history-store",
    knowledgeBase: { sessionId: "kb-history-store" }
  }).settings;
  const migrationResult = await migrateKnowledgeBaseHistory(kbVault, "codex-echoink", historySettings);
  assert.equal(migrationResult.activeDate, "2026-05-19");
  assert.deepEqual(historySettings.sessions[0].messages.map((message) => message.id), ["h-19-user", "h-19-process"]);
  const historyIndex = await readKnowledgeBaseHistoryIndex(kbVault, "codex-echoink");
  assert.equal(historyIndex.sessions[0]?.dayCount, 2);
  assert.equal(historyIndex.sessions[0]?.messageCount, 4);
  assert.deepEqual((await readKnowledgeBaseHistoryDay(kbVault, "codex-echoink", "kb-history-store", "2026-05-18")).map((message) => message.id), ["h-18-user", "h-18-assistant"]);
  historySettings.sessions[0].messages.push({ id: "h-20-user", role: "user", text: "新日问题", createdAt: new Date(2026, 4, 20, 8, 0, 0).getTime() });
  await persistAndCompactKnowledgeBaseHistory(kbVault, "codex-echoink", historySettings);
  assert.deepEqual(historySettings.sessions[0].messages.map((message) => message.id), ["h-20-user"]);
  const rebuiltHistoryIndex = await rebuildKnowledgeBaseHistoryIndex(kbVault, "codex-echoink");
  assert.equal(rebuiltHistoryIndex.sessions[0]?.dayCount, 3);
  assert.equal(rebuiltHistoryIndex.sessions[0]?.messageCount, 5);
  const storageStats = await collectKnowledgeBaseStorageStats(kbVault, "codex-echoink");
  assert.equal(storageStats.messageCount, 5);
  assert.equal(storageStats.dayCount, 3);
  const removedMay18 = await removeKnowledgeBaseHistoryDays(kbVault, "codex-echoink", ["2026-05-18"]);
  assert.equal(removedMay18.removedDayCount, 1);
  assert.equal(removedMay18.removedMessageCount, 2);
  const afterRemoveMay18 = await readKnowledgeBaseHistoryIndex(kbVault, "codex-echoink");
  assert.deepEqual(afterRemoveMay18.sessions[0]?.days.map((day) => day.date), ["2026-05-20", "2026-05-19"]);
  const prunedHistory = await pruneKnowledgeBaseHistoryByRetention(kbVault, "codex-echoink", 7, new Date(2026, 4, 28, 12, 0, 0).getTime());
  assert.equal(prunedHistory.removedDayCount, 2);
  assert.deepEqual((await readKnowledgeBaseHistoryIndex(kbVault, "codex-echoink")).sessions[0]?.days.map((day) => day.date) ?? [], []);

  const recoveredHistorySession = {
    id: "kb-history-recover",
    title: KNOWLEDGE_BASE_SESSION_TITLE,
    kind: "knowledge-base" as const,
    cwd: kbVault,
    historyActiveDate: "2026-05-21",
    messages: [
      { id: "recover-21", role: "user" as const, text: "/maintain", createdAt: new Date(2026, 4, 21, 10, 0, 0).getTime() }
    ],
    createdAt: new Date(2026, 4, 21, 10, 0, 0).getTime(),
    updatedAt: new Date(2026, 4, 21, 10, 0, 0).getTime()
  };
  await persistKnowledgeBaseHistoryMessages(kbVault, "codex-echoink", recoveredHistorySession, [
    { id: "recover-19", role: "assistant", text: "最近一天详情", createdAt: new Date(2026, 4, 19, 9, 0, 0).getTime() }
  ]);
  const recoverySettings = normalizeSettingsData({
    sessions: [recoveredHistorySession],
    activeSessionId: "kb-history-recover",
    knowledgeBase: { sessionId: "kb-history-recover" }
  }).settings;
  await persistAndCompactKnowledgeBaseHistory(kbVault, "codex-echoink", recoverySettings, new Date(2026, 4, 21, 12, 0, 0).getTime());
  assert.equal(recoverySettings.sessions[0].historyActiveDate, "2026-05-19");
  assert.deepEqual(recoverySettings.sessions[0].messages.map((message) => message.id), ["recover-19", "recover-21"]);
} finally {
  await rm(kbVault, { recursive: true, force: true });
}

const maintenanceStartSaveFailureVault = await createMaintenanceVaultForTest("codex-kb-maintain-start-save-");
try {
  const { manager, settings } = makeKnowledgeBaseManagerForTest(maintenanceStartSaveFailureVault, { failSaveCall: 1 });
  let thrown: unknown = null;
  let result: Awaited<ReturnType<KnowledgeBaseManager["runMaintenance"]>> | null = null;
  try {
    result = await manager.runMaintenance("maintain", "/maintain 测试保存失败");
  } catch (error) {
    thrown = error;
  }
  assert.equal(thrown, null);
  assert.equal(result?.status, "failed");
  assert.match(result?.error ?? "", /saveSettings failed at call 1/);
  assert.equal(manager.isRunning, false);
  assert.equal(settings.knowledgeBase.lastRunStatus, "failed");
} finally {
  await rm(maintenanceStartSaveFailureVault, { recursive: true, force: true });
}

const maintenanceVaultPathFailureVault = await createMaintenanceVaultForTest("codex-kb-maintain-vault-path-failure-");
try {
  const { manager, settings } = makeKnowledgeBaseManagerForTest(maintenanceVaultPathFailureVault, {
    throwOnGetVaultPath: true
  });
  let thrown: unknown = null;
  let result: Awaited<ReturnType<KnowledgeBaseManager["runMaintenance"]>> | null = null;
  try {
    result = await manager.runMaintenance("lint", "/check 测试 vault 路径读取失败");
  } catch (error) {
    thrown = error;
  }
  assert.equal(thrown, null);
  assert.equal(result?.status, "failed");
  assert.match(result?.error ?? "", /vault path unavailable/);
  assert.equal(manager.isRunning, false);
  assert.equal(settings.knowledgeBase.lastRunStatus, "failed");
  assert.match(settings.knowledgeBase.lastError, /vault path unavailable/);
} finally {
  await rm(maintenanceVaultPathFailureVault, { recursive: true, force: true });
}

const maintenanceFailureStatusSaveFailureVault = await createMaintenanceVaultForTest("codex-kb-maintain-failure-save-failure-");
try {
  const { manager, settings, saveCalls } = makeKnowledgeBaseManagerForTest(maintenanceFailureStatusSaveFailureVault, {
    failSaveCall: 2,
    beforeAgentReturn: async () => {
      throw new Error("Agent failed before report");
    }
  });
  let thrown: unknown = null;
  let result: Awaited<ReturnType<KnowledgeBaseManager["runMaintenance"]>> | null = null;
  try {
    result = await manager.runMaintenance("maintain", "/maintain 测试失败状态保存也失败");
  } catch (error) {
    thrown = error;
  }
  assert.equal(thrown, null);
  assert.equal(result?.status, "failed");
  assert.match(result?.error ?? "", /Agent failed before report/);
  assert.match(result?.error ?? "", /状态保存失败：saveSettings failed at call 2/);
  assert.equal(manager.isRunning, false);
  assert.equal(settings.knowledgeBase.lastError.includes("状态保存失败：saveSettings failed at call 2"), true);
  assert.equal(saveCalls(), 3);
} finally {
  await rm(maintenanceFailureStatusSaveFailureVault, { recursive: true, force: true });
}

const maintenanceCancelSaveFailureVault = await createMaintenanceVaultForTest("codex-kb-maintain-cancel-save-failure-");
try {
  const { manager, settings, saveCalls } = makeKnowledgeBaseManagerForTest(maintenanceCancelSaveFailureVault, { failSaveCall: 1 });
  (manager as any).running = true;
  let thrown: unknown = null;
  try {
    await manager.cancelMaintenance();
  } catch (error) {
    thrown = error;
  }
  assert.equal(thrown, null);
  assert.equal(settings.knowledgeBase.lastRunStatus, "canceled");
  assert.match(settings.knowledgeBase.lastError, /状态保存失败：saveSettings failed at call 1/);
  assert.equal(saveCalls(), 2);
} finally {
  await rm(maintenanceCancelSaveFailureVault, { recursive: true, force: true });
}

const maintenanceCancelDuringInitialSaveVault = await createMaintenanceVaultForTest("codex-kb-maintain-cancel-initial-save-");
try {
  const codexTaskCalls: Array<{ permission: string; writeScope: string }> = [];
  const { manager, settings } = makeKnowledgeBaseManagerForTest(maintenanceCancelDuringInitialSaveVault, {
    cancelViaManagerBeforeSaveCall: 1,
    codexTaskCalls
  });
  const result = await manager.runMaintenance("lint", "/check 测试初始保存期间取消");
  assert.equal(result.status, "canceled");
  assert.deepEqual(codexTaskCalls, []);
  assert.equal(manager.isRunning, false);
  assert.equal(settings.knowledgeBase.lastRunStatus, "canceled");
  assert.deepEqual(settings.knowledgeBase.maintenanceHistory, []);
} finally {
  await rm(maintenanceCancelDuringInitialSaveVault, { recursive: true, force: true });
}

const maintenanceFinalSaveFailureVault = await createMaintenanceVaultForTest("codex-kb-maintain-final-save-");
try {
  await mkdir(path.join(maintenanceFinalSaveFailureVault, "inbox", "Clippings"), { recursive: true });
  await writeFile(path.join(maintenanceFinalSaveFailureVault, "inbox", "Clippings", "clip.md"), "# Clip\n", "utf8");
  await writeFile(path.join(maintenanceFinalSaveFailureVault, "inbox", "skills-local-audit.md"), "# Skills\n", "utf8");
  const { manager, settings } = makeKnowledgeBaseManagerForTest(maintenanceFinalSaveFailureVault, {
    failSaveCall: 2,
    beforeAgentReturn: async () => {
      await writeFile(path.join(maintenanceFinalSaveFailureVault, "raw", "index.md"), "# Raw\n\n- [[raw/articles/new]]\n", "utf8");
      await writeFile(path.join(maintenanceFinalSaveFailureVault, "wiki", "agent-temp.md"), "# Temp\n\n来源：[[raw/articles/new]]\n\n核心要点：本轮新增正文已经进入临时知识页。\n", "utf8");
      const reportPath = path.join(maintenanceFinalSaveFailureVault, "outputs", "maintenance", `kb-maintenance-${formatDateKeyForTest(new Date())}.md`);
      await mkdir(path.dirname(reportPath), { recursive: true });
      await writeFile(reportPath, [
        "---",
        "source: codex-echoink",
        "---",
        "",
        "# 知识库维护报告",
        "",
        "## 本轮来源",
        "- [[raw/articles/new]]",
        ""
      ].join("\n"), "utf8");
    }
  });
  const result = await manager.runMaintenance("maintain", "/maintain 测试最终保存失败");
  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /saveSettings failed at call 2/);
  assert.equal(manager.isRunning, false);
  assert.equal(result.processedSources.length, 0);
  assert.deepEqual(Object.keys(settings.knowledgeBase.processedSources), []);
  assert.equal(settings.knowledgeBase.maintenanceHistory.at(-1)?.status, "failed");
  assert.equal(await fileExists(path.join(maintenanceFinalSaveFailureVault, "outputs", ".ingest-tracker.md")), false);
  assert.equal(await fileExists(path.join(maintenanceFinalSaveFailureVault, "inbox", "Clippings", "clip.md")), true);
  assert.equal(await fileExists(path.join(maintenanceFinalSaveFailureVault, "inbox", "skills-local-audit.md")), true);
  assert.equal(await fileExists(path.join(maintenanceFinalSaveFailureVault, "inbox", "research", "skills-local-audit.md")), false);
  assert.equal(await readFile(path.join(maintenanceFinalSaveFailureVault, "raw", "index.md"), "utf8"), "# Raw\n");
  assert.equal(await readFile(path.join(maintenanceFinalSaveFailureVault, "raw", "articles", "new.md"), "utf8"), "# New\n\n正文");
  assert.equal(await fileExists(path.join(maintenanceFinalSaveFailureVault, "outputs", ".raw-digest-registry.json")), false);
  assert.equal(await fileExists(path.join(maintenanceFinalSaveFailureVault, "wiki", "agent-temp.md")), false);
} finally {
  await rm(maintenanceFinalSaveFailureVault, { recursive: true, force: true });
}

const maintenanceDirectoryReplacedRollbackVault = await createMaintenanceVaultForTest("codex-kb-maintain-dir-replaced-");
try {
  const { manager } = makeKnowledgeBaseManagerForTest(maintenanceDirectoryReplacedRollbackVault, {
    beforeAgentReturn: async () => {
      await rm(path.join(maintenanceDirectoryReplacedRollbackVault, "wiki"), { recursive: true, force: true });
      await writeFile(path.join(maintenanceDirectoryReplacedRollbackVault, "wiki"), "# Bad replacement\n", "utf8");
      throw new Error("Agent replaced managed directory");
    }
  });
  const result = await manager.runMaintenance("maintain", "/maintain 测试目录替换回滚");
  assert.equal(result.status, "failed");
  assert.equal((await stat(path.join(maintenanceDirectoryReplacedRollbackVault, "wiki"))).isDirectory(), true);
  assert.equal(await readFile(path.join(maintenanceDirectoryReplacedRollbackVault, "wiki", "index.md"), "utf8"), "# Wiki\n");
} finally {
  await rm(maintenanceDirectoryReplacedRollbackVault, { recursive: true, force: true });
}

const maintenanceRootSymlinkAfterAgentVault = await createMaintenanceVaultForTest("codex-kb-maintain-root-symlink-after-agent-");
try {
  const externalWikiTarget = path.join(maintenanceRootSymlinkAfterAgentVault, "outside-wiki-target");
  await mkdir(externalWikiTarget, { recursive: true });
  const { manager } = makeKnowledgeBaseManagerForTest(maintenanceRootSymlinkAfterAgentVault, {
    beforeAgentReturn: async () => {
      await rm(path.join(maintenanceRootSymlinkAfterAgentVault, "wiki"), { recursive: true, force: true });
      await symlink(externalWikiTarget, path.join(maintenanceRootSymlinkAfterAgentVault, "wiki"));
    }
  });
  const result = await manager.runMaintenance("maintain", "/maintain 测试 Agent 替换写入根为 symlink");
  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /知识库写入区不能包含 symlink/);
  assert.equal((await lstat(path.join(maintenanceRootSymlinkAfterAgentVault, "wiki"))).isDirectory(), true);
  assert.equal(await readFile(path.join(maintenanceRootSymlinkAfterAgentVault, "wiki", "index.md"), "utf8"), "# Wiki\n");
  assert.deepEqual(await readdir(externalWikiTarget), []);
} finally {
  await rm(maintenanceRootSymlinkAfterAgentVault, { recursive: true, force: true });
}

const maintenanceSpecialFileAfterAgentVault = await createMaintenanceVaultForTest("codex-kb-maintain-special-after-agent-");
try {
  const { manager } = makeKnowledgeBaseManagerForTest(maintenanceSpecialFileAfterAgentVault, {
    beforeAgentReturn: async () => {
      await execFile("mkfifo", [path.join(maintenanceSpecialFileAfterAgentVault, "wiki", "agent.pipe")]);
    }
  });
  const result = await manager.runMaintenance("maintain", "/maintain 测试 Agent 新增特殊文件");
  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /知识库写入区不能包含特殊文件/);
  assert.equal(await fileExists(path.join(maintenanceSpecialFileAfterAgentVault, "wiki", "agent.pipe")), false);
} finally {
  await rm(maintenanceSpecialFileAfterAgentVault, { recursive: true, force: true });
}

const maintenanceHardlinkAfterAgentVault = await createMaintenanceVaultForTest("codex-kb-maintain-hardlink-after-agent-");
try {
  const externalWikiTarget = path.join(maintenanceHardlinkAfterAgentVault, "outside-wiki-hardlink.md");
  const hardlinkPath = path.join(maintenanceHardlinkAfterAgentVault, "wiki", "ai-intelligence", "references", "agent-hardlink.md");
  await writeFile(externalWikiTarget, "# External wiki hardlink\n\n不应进入知识库写入区", "utf8");
  const { manager } = makeKnowledgeBaseManagerForTest(maintenanceHardlinkAfterAgentVault, {
    beforeAgentReturn: async () => {
      await mkdir(path.dirname(hardlinkPath), { recursive: true });
      await link(externalWikiTarget, hardlinkPath);
    }
  });
  const result = await manager.runMaintenance("maintain", "/maintain 测试 Agent 新增 hardlink 不继续");
  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /知识库写入区不能包含 hardlink/);
  assert.equal(await readFile(externalWikiTarget, "utf8"), "# External wiki hardlink\n\n不应进入知识库写入区");
  assert.equal(await fileExists(hardlinkPath), false);
} finally {
  await rm(maintenanceHardlinkAfterAgentVault, { recursive: true, force: true });
}

const maintenancePreexistingConflictDuplicateVault = await createMaintenanceVaultForTest("codex-kb-maintain-preexisting-conflict-duplicate-");
try {
  const today = new Date();
  const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  const basePath = path.join(maintenancePreexistingConflictDuplicateVault, "wiki", "ai-intelligence", "references", "agent-conflict.md");
  const duplicatePath = path.join(maintenancePreexistingConflictDuplicateVault, "wiki", "ai-intelligence", "references", "agent-conflict 3.md");
  const reportPath = path.join(maintenancePreexistingConflictDuplicateVault, "outputs", "maintenance", `kb-maintenance-${todayKey}.md`);
  const evidencePath = path.join(maintenancePreexistingConflictDuplicateVault, "wiki", "ai-intelligence", "references", "existing-page.md");
  await mkdir(path.dirname(basePath), { recursive: true });
  await writeFile(basePath, "# Agent conflict\n\n原始正文", "utf8");
  await writeFile(duplicatePath, "# Agent conflict\n\n历史冲突副本正文", "utf8");
  await writeFile(evidencePath, [
    "# Existing Page",
    "",
    "历史来源：[[raw/articles/new]]",
    "",
    "旧正文。",
    ""
  ].join("\n"), "utf8");
  const { manager } = makeKnowledgeBaseManagerForTest(maintenancePreexistingConflictDuplicateVault, {
    beforeAgentReturn: async () => {
      await mkdir(path.dirname(evidencePath), { recursive: true });
      await writeFile(evidencePath, [
        "# Existing Page",
        "",
        "历史来源：[[raw/articles/new]]",
        "",
        "旧正文。",
        "",
        "本轮来源：[[raw/articles/new]]",
        "核心要点：本轮新增正文已经消化进既有页面。",
        "",
      ].join("\n"), "utf8");
      await mkdir(path.dirname(reportPath), { recursive: true });
      await writeFile(reportPath, [
        "---",
        "source: codex-echoink",
        "---",
        "",
        "# 知识库维护报告",
        "",
        "## 本轮来源",
        "- [[raw/articles/new]]",
        ""
      ].join("\n"), "utf8");
    }
  });
  const result = await manager.runMaintenance("maintain", "/maintain 测试预存冲突副本自愈");
  assert.equal(result.status, "success", result.error);
  assert.equal(await readFile(basePath, "utf8"), "# Agent conflict\n\n原始正文");
  assert.equal(await fileExists(duplicatePath), false);
  const maintenanceEntries = await readdir(path.join(maintenancePreexistingConflictDuplicateVault, "outputs", "maintenance"), { withFileTypes: true });
  const backupDir = maintenanceEntries.find((entry) => entry.isDirectory() && entry.name.startsWith("conflict-duplicates-"));
  assert.ok(backupDir);
  const backupPath = path.join(maintenancePreexistingConflictDuplicateVault, "outputs", "maintenance", backupDir.name, "wiki", "ai-intelligence", "references", "agent-conflict 3.md");
  assert.equal(await readFile(backupPath, "utf8"), "# Agent conflict\n\n历史冲突副本正文");
  assert.match(await readFile(reportPath, "utf8"), /冲突副本预检/);
  assert.match(result.summary, /冲突副本预检：转移 1 个历史数字副本/);
} finally {
  await rm(maintenancePreexistingConflictDuplicateVault, { recursive: true, force: true });
}

const maintenanceConflictDuplicateAfterAgentVault = await createMaintenanceVaultForTest("codex-kb-maintain-conflict-duplicate-after-agent-");
try {
  const basePath = path.join(maintenanceConflictDuplicateAfterAgentVault, "wiki", "ai-intelligence", "references", "agent-conflict.md");
  const duplicatePath = path.join(maintenanceConflictDuplicateAfterAgentVault, "wiki", "ai-intelligence", "references", "agent-conflict 2.md");
  await mkdir(path.dirname(basePath), { recursive: true });
  await writeFile(basePath, "# Agent conflict\n\n原始正文", "utf8");
  const { manager } = makeKnowledgeBaseManagerForTest(maintenanceConflictDuplicateAfterAgentVault, {
    beforeAgentReturn: async () => {
      await writeFile(duplicatePath, "# Agent conflict\n\n冲突副本正文", "utf8");
    }
  });
  const result = await manager.runMaintenance("maintain", "/maintain 测试 Agent 新增冲突副本不继续");
  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /知识库写入区不能包含冲突副本/);
  assert.equal(await readFile(basePath, "utf8"), "# Agent conflict\n\n原始正文");
  assert.equal(await fileExists(duplicatePath), false);
} finally {
  await rm(maintenanceConflictDuplicateAfterAgentVault, { recursive: true, force: true });
}

const maintenanceFailurePreservesUntouchedFilesVault = await createMaintenanceVaultForTest("codex-kb-maintain-preserve-untouched-");
try {
  const untouchedWikiPath = path.join(maintenanceFailurePreservesUntouchedFilesVault, "wiki", "index.md");
  const untouchedWikiBefore = await stat(untouchedWikiPath);
  const { manager } = makeKnowledgeBaseManagerForTest(maintenanceFailurePreservesUntouchedFilesVault, {
    beforeAgentReturn: async () => {
      throw new Error("Agent failed without touching files");
    }
  });
  const result = await manager.runMaintenance("maintain", "/maintain 测试失败不重写未改文件");
  assert.equal(result.status, "failed");
  const untouchedWikiAfter = await stat(untouchedWikiPath);
  assert.equal(await readFile(untouchedWikiPath, "utf8"), "# Wiki\n");
  assert.equal(untouchedWikiAfter.ino, untouchedWikiBefore.ino);
  assert.equal(Math.round(untouchedWikiAfter.mtimeMs), Math.round(untouchedWikiBefore.mtimeMs));
} finally {
  await rm(maintenanceFailurePreservesUntouchedFilesVault, { recursive: true, force: true });
}

const maintenanceRawViolationRollbackVault = await createMaintenanceVaultForTest("codex-kb-maintain-raw-violation-rollback-");
try {
  const rawPath = path.join(maintenanceRawViolationRollbackVault, "raw", "articles", "new.md");
  const rawTextBefore = await readFile(rawPath, "utf8");
  const rawStatBefore = await stat(rawPath);
  const { manager, settings } = makeKnowledgeBaseManagerForTest(maintenanceRawViolationRollbackVault, {
    beforeAgentReturn: async () => {
      await writeFile(rawPath, "# New\n\nAgent 不该改 raw 正文", "utf8");
      await writeFile(path.join(maintenanceRawViolationRollbackVault, "wiki", "agent-temp.md"), "# Temp\n", "utf8");
      const reportPath = path.join(maintenanceRawViolationRollbackVault, "outputs", "maintenance", `kb-maintenance-${formatDateKeyForTest(new Date())}.md`);
      await mkdir(path.dirname(reportPath), { recursive: true });
      await writeFile(reportPath, "# Bad Report\n", "utf8");
    }
  });
  const result = await manager.runMaintenance("maintain", "/maintain 测试 raw 违规全量回滚");
  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /试图改写 raw\/ 原始资料文件/);
  assert.match(result.error ?? "", /文件内容被改写/);
  assert.equal(await readFile(rawPath, "utf8"), rawTextBefore);
  assert.ok(Math.abs((await stat(rawPath)).mtimeMs - rawStatBefore.mtimeMs) <= 5);
  assert.equal(await fileExists(path.join(maintenanceRawViolationRollbackVault, "wiki", "agent-temp.md")), false);
  assert.equal(await fileExists(path.join(maintenanceRawViolationRollbackVault, "outputs", "maintenance", `kb-maintenance-${formatDateKeyForTest(new Date())}.md`)), false);
  assert.deepEqual(Object.keys(settings.knowledgeBase.processedSources), []);
  assert.equal(await fileExists(path.join(maintenanceRawViolationRollbackVault, "outputs", ".ingest-tracker.md")), false);
} finally {
  await rm(maintenanceRawViolationRollbackVault, { recursive: true, force: true });
}

const maintenanceRawViolationPreservesConcurrentAddVault = await createMaintenanceVaultForTest("codex-kb-maintain-raw-preserve-concurrent-add-");
try {
  const rawPath = path.join(maintenanceRawViolationPreservesConcurrentAddVault, "raw", "articles", "new.md");
  const concurrentRaw = path.join(maintenanceRawViolationPreservesConcurrentAddVault, "raw", "articles", "external-concurrent.md");
  const rawTextBefore = await readFile(rawPath, "utf8");
  const { manager } = makeKnowledgeBaseManagerForTest(maintenanceRawViolationPreservesConcurrentAddVault, {
    beforeAgentReturn: async () => {
      await writeFile(rawPath, "# New\n\nAgent 不该改 raw 正文", "utf8");
      await writeFile(concurrentRaw, "# External\n\n外部自动化同时新增 raw", "utf8");
    }
  });
  const result = await manager.runMaintenance("maintain", "/maintain 测试恢复既有 raw 但不删除并发新增 raw");
  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /试图改写 raw\/ 原始资料文件/);
  assert.equal(await readFile(rawPath, "utf8"), rawTextBefore);
  assert.equal(await readFile(concurrentRaw, "utf8"), "# External\n\n外部自动化同时新增 raw");
} finally {
  await rm(maintenanceRawViolationPreservesConcurrentAddVault, { recursive: true, force: true });
}

const maintenanceUnsafeRawAddVault = await createMaintenanceVaultForTest("codex-kb-maintain-unsafe-raw-add-");
try {
  const externalTarget = path.join(maintenanceUnsafeRawAddVault, "outside.md");
  const rawSymlink = path.join(maintenanceUnsafeRawAddVault, "raw", "articles", "unsafe-link.md");
  await writeFile(externalTarget, "# Outside\n", "utf8");
  const { manager } = makeKnowledgeBaseManagerForTest(maintenanceUnsafeRawAddVault, {
    beforeAgentReturn: async () => {
      await symlink(externalTarget, rawSymlink);
    }
  });
  const result = await manager.runMaintenance("maintain", "/maintain 测试 unsafe raw 新增仍失败");
  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /试图改写 raw\/ 原始资料文件/);
  assert.match(result.error ?? "", /unsafe-link\.md 文件新增或被移动到 raw\//);
  assert.equal(await fileExists(rawSymlink), false);
  assert.equal(await readFile(externalTarget, "utf8"), "# Outside\n");
} finally {
  await rm(maintenanceUnsafeRawAddVault, { recursive: true, force: true });
}

const maintenanceRawUnreadableOnErrorVault = await createMaintenanceVaultForTest("codex-kb-maintain-raw-unreadable-error-");
try {
  const rawDir = path.join(maintenanceRawUnreadableOnErrorVault, "raw");
  const rawFile = path.join(maintenanceRawUnreadableOnErrorVault, "raw", "articles", "new.md");
  const rawModeBefore = (await stat(rawDir)).mode & 0o777;
  const rawFileBefore = await stat(rawFile);
  const { manager } = makeKnowledgeBaseManagerForTest(maintenanceRawUnreadableOnErrorVault, {
    beforeAgentReturn: async () => {
      await chmod(rawDir, 0o000);
      throw new Error("Agent failed after raw chmod");
    }
  });
  const result = await manager.runMaintenance("maintain", "/maintain 测试失败时 raw 不可读也要恢复");
  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /试图改写 raw\/ 原始资料文件/);
  assert.match(result.error ?? "", /文件权限被改写/);
  assert.equal((await stat(rawDir)).mode & 0o777, rawModeBefore);
  assert.equal((await stat(rawFile)).ino, rawFileBefore.ino);
} finally {
  await chmod(path.join(maintenanceRawUnreadableOnErrorVault, "raw"), 0o755).catch(() => undefined);
  await rm(maintenanceRawUnreadableOnErrorVault, { recursive: true, force: true });
}

const maintenanceLateCancelVault = await createMaintenanceVaultForTest("codex-kb-maintain-late-cancel-");
try {
  const { manager, settings } = makeKnowledgeBaseManagerForTest(maintenanceLateCancelVault, {
    cancelBeforeSaveCall: 2,
    beforeAgentReturn: async () => {
      await mkdir(path.join(maintenanceLateCancelVault, "wiki", "ai-intelligence", "references"), { recursive: true });
      await writeFile(path.join(maintenanceLateCancelVault, "wiki", "ai-intelligence", "references", "late-cancel.md"), [
        "# Late Cancel",
        "",
        "来源：[[raw/articles/new]]",
        "核心要点：本轮新增正文已经进入取消窗口测试页。",
        ""
      ].join("\n"), "utf8");
      const reportPath = path.join(maintenanceLateCancelVault, "outputs", "maintenance", `kb-maintenance-${formatDateKeyForTest(new Date())}.md`);
      await mkdir(path.dirname(reportPath), { recursive: true });
      await writeFile(reportPath, [
        "---",
        "source: codex-echoink",
        "---",
        "",
        "# 知识库维护报告",
        "",
        "## 本轮来源",
        "- [[raw/articles/new]]",
        ""
      ].join("\n"), "utf8");
    }
  });
  const result = await manager.runMaintenance("maintain", "/maintain 测试最终保存窗口取消");
  assert.equal(result.status, "canceled");
  assert.equal(result.processedSources.length, 0);
  assert.match(result.error ?? "", /用户取消/);
  assert.equal(manager.isRunning, false);
  assert.equal(settings.knowledgeBase.lastRunStatus, "canceled");
  assert.match(settings.knowledgeBase.lastError, /用户取消/);
  assert.deepEqual(Object.keys(settings.knowledgeBase.processedSources), []);
  assert.deepEqual(settings.knowledgeBase.maintenanceHistory, []);
  assert.equal(await fileExists(path.join(maintenanceLateCancelVault, "outputs", ".ingest-tracker.md")), false);
} finally {
  await rm(maintenanceLateCancelVault, { recursive: true, force: true });
}

const maintenanceHandleCanceledVault = await createMaintenanceVaultForTest("codex-kb-maintain-handle-canceled-");
try {
  const { manager } = makeKnowledgeBaseManagerForTest(maintenanceHandleCanceledVault);
  (manager as any).runMaintenance = async () => ({
    status: "canceled",
    reportPath: "outputs/maintenance/kb-maintenance-cancel.md",
    summary: "",
    processedSources: [],
    error: "用户取消"
  });
  const result = await manager.handleUserMessage("/check 测试取消返回");
  assert.equal(result.status, "canceled");
  assert.match(result.message, /知识库体检已取消/);
  assert.doesNotMatch(result.message, /失败/);
} finally {
  await rm(maintenanceHandleCanceledVault, { recursive: true, force: true });
}

const maintenanceLintScopeVault = await createMaintenanceVaultForTest("codex-kb-maintain-lint-scope-");
try {
  const codexTaskCalls: Array<{ permission: string; writeScope: string }> = [];
  const { manager } = makeKnowledgeBaseManagerForTest(maintenanceLintScopeVault, { codexTaskCalls });
  const result = await manager.runMaintenance("lint", "/check 测试权限边界");
  assert.equal(result.status, "success");
  assert.deepEqual(codexTaskCalls.map((call) => ({ permission: call.permission, writeScope: call.writeScope })), [
    { permission: "workspace-write", writeScope: "knowledge-lint" }
  ]);
} finally {
  await rm(maintenanceLintScopeVault, { recursive: true, force: true });
}

const maintenanceOpenCodeLintScopeVault = await createMaintenanceVaultForTest("codex-kb-maintain-opencode-lint-scope-");
try {
  const openCodeTaskCalls: Array<{ permission: string }> = [];
  const { manager } = makeKnowledgeBaseManagerForTest(maintenanceOpenCodeLintScopeVault, { agentBackend: "opencode", openCodeTaskCalls });
  const result = await manager.runMaintenance("lint", "/check 测试 OpenCode 权限边界");
  assert.equal(result.status, "success");
  assert.deepEqual(openCodeTaskCalls, [{ permission: "read-only" }]);
} finally {
  await rm(maintenanceOpenCodeLintScopeVault, { recursive: true, force: true });
}

const maintenanceOpenCodeCancelBeforePromptVault = await createMaintenanceVaultForTest("codex-kb-maintain-opencode-cancel-before-prompt-");
try {
  let managerForHook: KnowledgeBaseManager | null = null;
  (globalThis as any).__opencodeBackendTestHooks = {
    models: [{ id: "test/text", providerId: "test", modelId: "text", displayName: "Test Text", inputModalities: ["text"] }],
    onListModels: async () => {
      await managerForHook?.cancelMaintenance();
    }
  };
  const { manager, settings } = makeKnowledgeBaseManagerForTest(maintenanceOpenCodeCancelBeforePromptVault, {
    agentBackend: "opencode",
    useRealOpenCodeTask: true
  });
  managerForHook = manager;
  const result = await manager.runMaintenance("lint", "/check 测试 OpenCode prompt 前取消");
  assert.equal(result.status, "canceled");
  assert.equal(result.processedSources.length, 0);
  assert.equal((globalThis as any).__opencodeBackendTestHooks.sendPromptCalls ?? 0, 0);
  assert.equal(settings.knowledgeBase.lastRunStatus, "canceled");
  assert.deepEqual(settings.knowledgeBase.maintenanceHistory, []);
} finally {
  delete (globalThis as any).__opencodeBackendTestHooks;
  await rm(maintenanceOpenCodeCancelBeforePromptVault, { recursive: true, force: true });
}

const maintenanceOpenCodeCancelDuringPromptVault = await createMaintenanceVaultForTest("codex-kb-maintain-opencode-cancel-during-prompt-");
try {
  let managerForHook: KnowledgeBaseManager | null = null;
  (globalThis as any).__opencodeBackendTestHooks = {
    models: [{ id: "test/text", providerId: "test", modelId: "text", displayName: "Test Text", inputModalities: ["text"] }],
    abortCalls: [],
    onSendPrompt: async () => {
      await managerForHook?.cancelMaintenance();
    },
    sendPromptError: new Error("OpenCode aborted")
  };
  const { manager, settings } = makeKnowledgeBaseManagerForTest(maintenanceOpenCodeCancelDuringPromptVault, {
    agentBackend: "opencode",
    useRealOpenCodeTask: true
  });
  managerForHook = manager;
  const result = await manager.runMaintenance("lint", "/check 测试 OpenCode prompt 中取消");
  assert.equal(result.status, "canceled");
  assert.equal(result.processedSources.length, 0);
  assert.equal((globalThis as any).__opencodeBackendTestHooks.sendPromptCalls ?? 0, 1);
  assert.deepEqual((globalThis as any).__opencodeBackendTestHooks.abortCalls, ["test-opencode-session"]);
  assert.equal(settings.opencode.lastError, "");
  assert.equal(settings.knowledgeBase.lastRunStatus, "canceled");
  assert.deepEqual(settings.knowledgeBase.maintenanceHistory, []);
} finally {
  delete (globalThis as any).__opencodeBackendTestHooks;
  await rm(maintenanceOpenCodeCancelDuringPromptVault, { recursive: true, force: true });
}

const maintenanceOpenCodeStalledPromptTimeoutVault = await createMaintenanceVaultForTest("codex-kb-maintain-opencode-stalled-prompt-timeout-");
try {
  (globalThis as any).__opencodeBackendTestHooks = {
    models: [{ id: "test/text", providerId: "test", modelId: "text", displayName: "Test Text", inputModalities: ["text"] }],
    abortCalls: [],
    onSendPrompt: async () => await new Promise(() => undefined)
  };
  const { manager, settings } = makeKnowledgeBaseManagerForTest(maintenanceOpenCodeStalledPromptTimeoutVault, {
    agentBackend: "opencode",
    useRealOpenCodeTask: true
  });
  const result = await Promise.race([
    manager.runMaintenance("lint", "/check 测试 OpenCode prompt 卡死超时", { opencodeTaskTimeoutMs: 10 } as any),
    new Promise((resolve) => setTimeout(() => resolve("hung"), 80))
  ]);
  assert.notEqual(result, "hung");
  assert.equal((result as KnowledgeBaseRunResult).status, "failed");
  assert.match((result as KnowledgeBaseRunResult).error ?? "", /OpenCode.*长时间没有返回/);
  assert.deepEqual((globalThis as any).__opencodeBackendTestHooks.abortCalls, ["test-opencode-session"]);
  assert.equal((manager as any).activeOpenCode, null);
  assert.equal(settings.knowledgeBase.lastRunStatus, "failed");
  assert.equal(settings.knowledgeBase.maintenanceHistory.at(-1)?.status, "failed");
} finally {
  delete (globalThis as any).__opencodeBackendTestHooks;
  await rm(maintenanceOpenCodeStalledPromptTimeoutVault, { recursive: true, force: true });
}

const maintenanceOpenCodeStalledPromptCancelVault = await createMaintenanceVaultForTest("codex-kb-maintain-opencode-stalled-prompt-cancel-");
try {
  let managerForHook: KnowledgeBaseManager | null = null;
  (globalThis as any).__opencodeBackendTestHooks = {
    models: [{ id: "test/text", providerId: "test", modelId: "text", displayName: "Test Text", inputModalities: ["text"] }],
    abortCalls: [],
    onSendPrompt: async () => {
      await managerForHook?.cancelMaintenance();
      await new Promise(() => undefined);
    }
  };
  const { manager, settings } = makeKnowledgeBaseManagerForTest(maintenanceOpenCodeStalledPromptCancelVault, {
    agentBackend: "opencode",
    useRealOpenCodeTask: true
  });
  managerForHook = manager;
  const result = await Promise.race([
    manager.runMaintenance("lint", "/check 测试 OpenCode prompt 卡死时取消"),
    new Promise((resolve) => setTimeout(() => resolve("hung"), 80))
  ]);
  assert.notEqual(result, "hung");
  assert.equal((result as KnowledgeBaseRunResult).status, "canceled");
  assert.deepEqual((globalThis as any).__opencodeBackendTestHooks.abortCalls, ["test-opencode-session"]);
  assert.equal(settings.opencode.lastError, "");
  assert.equal(settings.knowledgeBase.lastRunStatus, "canceled");
  assert.deepEqual(settings.knowledgeBase.maintenanceHistory, []);
} finally {
  delete (globalThis as any).__opencodeBackendTestHooks;
  await rm(maintenanceOpenCodeStalledPromptCancelVault, { recursive: true, force: true });
}

const maintenanceCodexCancelDuringStartTurnVault = await createMaintenanceVaultForTest("codex-kb-maintain-codex-cancel-start-turn-");
try {
  const settings = normalizeSettingsData({ settingsVersion: DEFAULT_SETTINGS.settingsVersion }).settings;
  const interruptCalls: Array<{ threadId: string; turnId: string }> = [];
  let manager: KnowledgeBaseManager;
  const plugin = {
    settings,
    getVaultPath: () => maintenanceCodexCancelDuringStartTurnVault,
    ensureCodexConnected: async () => ({
      connected: true,
      accountLabel: "Codex",
      loggedIn: true,
      models: [],
      skills: [],
      mcpServers: [],
      errors: []
    }),
    codex: {
      startThread: async () => ({ threadId: "thread-cancel", title: "KB" }),
      startTurn: async () => {
        (manager as any).cancelRequested = true;
        return "turn-cancel";
      },
      interruptTurn: async (threadId: string, turnId: string) => {
        interruptCalls.push({ threadId, turnId });
      }
    }
  };
  manager = new KnowledgeBaseManager(plugin as any);
  let errorMessage = "";
  try {
    await (manager as any).runCodexKnowledgeTask("prompt", [], "workspace-write", "knowledge-base");
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : String(error);
  }
  assert.equal(isKnowledgeBaseCancelError(errorMessage), true);
  assert.deepEqual(interruptCalls, [{ threadId: "thread-cancel", turnId: "turn-cancel" }]);
  assert.equal((manager as any).codexWaiter, null);
} finally {
  await rm(maintenanceCodexCancelDuringStartTurnVault, { recursive: true, force: true });
}

const maintenanceCodexArchiveVault = await createMaintenanceVaultForTest("codex-kb-maintain-codex-archive-");
try {
  const settings = normalizeSettingsData({ settingsVersion: DEFAULT_SETTINGS.settingsVersion }).settings;
  let manager: KnowledgeBaseManager;
  const archivedThreadIds: string[] = [];
  const plugin = {
    settings,
    getVaultPath: () => maintenanceCodexArchiveVault,
    saveSettings: async () => undefined,
    ensureCodexConnected: async () => ({
      connected: true,
      accountLabel: "Codex",
      loggedIn: true,
      models: [],
      skills: [],
      mcpServers: [],
      errors: []
    }),
    codex: {
      startThread: async () => ({ threadId: "thread-archive", title: "KB" }),
	      setThreadName: async () => undefined,
	      startTurn: async () => {
	        queueMicrotask(() => {
	          manager.handleCodexNotification({
	            method: "turn/started",
	            params: { threadId: "thread-archive", turn: { id: "turn-archive" } }
	          } as any);
	          manager.handleCodexNotification({
	            method: "item/agentMessage/delta",
	            params: { threadId: "thread-archive", turnId: "turn-archive", itemId: "item-archive", delta: "归档输出" }
	          } as any);
          manager.handleCodexNotification({
            method: "turn/completed",
            params: { threadId: "thread-archive", turn: { id: "turn-archive", status: "completed" } }
          } as any);
        });
        return "turn-archive";
      },
      interruptTurn: async () => undefined,
      archiveThread: async (threadId: string) => {
        archivedThreadIds.push(threadId);
      }
    }
  };
  manager = new KnowledgeBaseManager(plugin as any);
  assert.equal(await (manager as any).runCodexKnowledgeTask("prompt", [], "workspace-write", "knowledge-base", undefined, "ask"), "归档输出");
  assert.equal(settings.knowledgeBase.managedThreads["thread-archive"]?.archiveState, "pending-archive");
  await manager.archivePendingCodexKnowledgeThreads();
  assert.deepEqual(archivedThreadIds, ["thread-archive"]);
  assert.equal(settings.knowledgeBase.managedThreads["thread-archive"]?.archiveState, "archived");
} finally {
  await rm(maintenanceCodexArchiveVault, { recursive: true, force: true });
}

const maintenanceCodexFinalAssistantItemVault = await createMaintenanceVaultForTest("codex-kb-maintain-codex-final-item-");
try {
  const settings = normalizeSettingsData({ settingsVersion: DEFAULT_SETTINGS.settingsVersion }).settings;
  let manager: KnowledgeBaseManager;
  const plugin = {
    settings,
    getVaultPath: () => maintenanceCodexFinalAssistantItemVault,
    saveSettings: async () => undefined,
    ensureCodexConnected: async () => ({
      connected: true,
      accountLabel: "Codex",
      loggedIn: true,
      models: [],
      skills: [],
      mcpServers: [],
      errors: []
    }),
    codex: {
      startThread: async () => ({ threadId: "thread-final-item", title: "KB" }),
      startTurn: async () => {
        queueMicrotask(() => {
          manager.handleCodexNotification({
            method: "turn/started",
            params: { threadId: "thread-final-item", turn: { id: "turn-final-item" } }
          } as any);
          manager.handleCodexNotification({
            method: "item/agentMessage/delta",
            params: { threadId: "thread-final-item", turnId: "turn-final-item", itemId: "item-process", delta: "方哥，我先核对本地 Wiki。" }
          } as any);
          manager.handleCodexNotification({
            method: "item/agentMessage/delta",
            params: { threadId: "thread-final-item", turnId: "turn-final-item", itemId: "item-final", delta: "## 一眼结论\n最终答案" }
          } as any);
          manager.handleCodexNotification({
            method: "turn/completed",
            params: { threadId: "thread-final-item", turn: { id: "turn-final-item", status: "completed" } }
          } as any);
        });
        return "turn-final-item";
      },
      interruptTurn: async () => undefined
    }
  };
  manager = new KnowledgeBaseManager(plugin as any);
  assert.equal(await (manager as any).runCodexKnowledgeTask("prompt", [], "workspace-write", "knowledge-base", undefined, "ask"), "## 一眼结论\n最终答案");
} finally {
  await rm(maintenanceCodexFinalAssistantItemVault, { recursive: true, force: true });
}

const maintenanceCodexStaleRunningThreadVault = await createMaintenanceVaultForTest("codex-kb-maintain-codex-stale-running-");
try {
  const settings = normalizeSettingsData({ settingsVersion: DEFAULT_SETTINGS.settingsVersion }).settings;
  settings.knowledgeBase.managedThreads["thread-stale-running"] = {
    threadId: "thread-stale-running",
    runId: "run-stale-running",
    kind: "maintain",
    vaultPath: maintenanceCodexStaleRunningThreadVault,
    archiveState: "running",
    createdAt: Date.now() - 60_000,
    settledAt: 0,
    archivedAt: 0,
    attempts: 0,
    lastError: ""
  };
  let saveCalls = 0;
  const manager = new KnowledgeBaseManager({
    settings,
    getVaultPath: () => maintenanceCodexStaleRunningThreadVault,
    saveSettings: async () => {
      saveCalls += 1;
    },
    codex: null
  } as any);
  assert.equal(await manager.archivePendingCodexKnowledgeThreads(), 0);
  assert.equal(settings.knowledgeBase.managedThreads["thread-stale-running"]?.archiveState, "pending-archive");
  assert.match(settings.knowledgeBase.managedThreads["thread-stale-running"]?.lastError ?? "", /running/);
  assert.equal(saveCalls, 1);
} finally {
  await rm(maintenanceCodexStaleRunningThreadVault, { recursive: true, force: true });
}

const maintenanceCodexOldCompletedDuringStartTurnVault = await createMaintenanceVaultForTest("codex-kb-maintain-codex-old-completed-");
try {
  const settings = normalizeSettingsData({ settingsVersion: DEFAULT_SETTINGS.settingsVersion }).settings;
  let manager: KnowledgeBaseManager;
  const plugin = {
    settings,
    getVaultPath: () => maintenanceCodexOldCompletedDuringStartTurnVault,
    ensureCodexConnected: async () => ({
      connected: true,
      accountLabel: "Codex",
      loggedIn: true,
      models: [],
      skills: [],
      mcpServers: [],
      errors: []
    }),
    codex: {
      startThread: async () => ({ threadId: "thread-reused", title: "KB" }),
      startTurn: async () => {
        assert.equal(manager.handleCodexNotification({
          method: "turn/completed",
          params: { threadId: "thread-reused", turn: { id: "turn-old", status: "completed" } }
        } as any), false);
        return "turn-new";
      },
      interruptTurn: async () => undefined
    }
  };
  manager = new KnowledgeBaseManager(plugin as any);
  const taskPromise = (manager as any).runCodexKnowledgeTask("prompt", [], "workspace-write", "knowledge-base");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal((manager as any).codexWaiter?.turnId, "turn-new");
  assert.equal(manager.handleCodexNotification({
    method: "item/agentMessage/delta",
    params: { threadId: "thread-reused", turnId: "turn-new", itemId: "item-new", delta: "新任务输出" }
  } as any), true);
  assert.equal(manager.handleCodexNotification({
    method: "turn/completed",
    params: { threadId: "thread-reused", turn: { id: "turn-new", status: "completed" } }
  } as any), true);
  assert.equal(await taskPromise, "新任务输出");
} finally {
  await rm(maintenanceCodexOldCompletedDuringStartTurnVault, { recursive: true, force: true });
}

const maintenanceCodexFastCompletionDuringStartTurnVault = await createMaintenanceVaultForTest("codex-kb-maintain-codex-fast-completed-");
try {
  const settings = normalizeSettingsData({ settingsVersion: DEFAULT_SETTINGS.settingsVersion }).settings;
  let manager: KnowledgeBaseManager;
  const plugin = {
    settings,
    getVaultPath: () => maintenanceCodexFastCompletionDuringStartTurnVault,
    ensureCodexConnected: async () => ({
      connected: true,
      accountLabel: "Codex",
      loggedIn: true,
      models: [],
      skills: [],
      mcpServers: [],
      errors: []
    }),
    codex: {
      startThread: async () => ({ threadId: "thread-fast", title: "KB" }),
      startTurn: async () => {
        assert.equal(manager.handleCodexNotification({
          method: "turn/started",
          params: { threadId: "thread-fast", turn: { id: "turn-fast" } }
        } as any), true);
        assert.equal(manager.handleCodexNotification({
          method: "item/agentMessage/delta",
          params: { threadId: "thread-fast", turnId: "turn-fast", itemId: "item-fast", delta: "快速输出" }
        } as any), true);
        assert.equal(manager.handleCodexNotification({
          method: "turn/completed",
          params: { threadId: "thread-fast", turn: { id: "turn-fast", status: "completed" } }
        } as any), true);
        return "turn-fast";
      },
      interruptTurn: async () => undefined
    }
  };
  manager = new KnowledgeBaseManager(plugin as any);
  const taskPromise = (manager as any).runCodexKnowledgeTask("prompt", [], "workspace-write", "knowledge-base");
  const result = await Promise.race([
    taskPromise,
    new Promise((resolve) => setTimeout(() => resolve("timeout"), 50))
  ]);
  assert.equal(result, "快速输出");
} finally {
  await rm(maintenanceCodexFastCompletionDuringStartTurnVault, { recursive: true, force: true });
}

const maintenanceCodexRetryingErrorVault = await createMaintenanceVaultForTest("codex-kb-maintain-codex-retrying-error-");
try {
  const settings = normalizeSettingsData({ settingsVersion: DEFAULT_SETTINGS.settingsVersion }).settings;
  let manager: KnowledgeBaseManager;
  const plugin = {
    settings,
    getVaultPath: () => maintenanceCodexRetryingErrorVault,
    ensureCodexConnected: async () => ({
      connected: true,
      accountLabel: "Codex",
      loggedIn: true,
      models: [],
      skills: [],
      mcpServers: [],
      errors: []
    }),
    codex: {
      startThread: async () => ({ threadId: "thread-retry", title: "KB" }),
      startTurn: async () => "turn-retry",
      interruptTurn: async () => undefined
    }
  };
  manager = new KnowledgeBaseManager(plugin as any);
  const taskPromise = (manager as any).runCodexKnowledgeTask("prompt", [], "workspace-write", "knowledge-base");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(manager.handleCodexNotification({
    method: "error",
    params: {
      threadId: "thread-retry",
      turnId: "turn-retry",
      willRetry: true,
      error: { message: "Reconnecting... 1/5" }
    }
  } as any), true);
  assert.notEqual((manager as any).codexWaiter, null);
  assert.equal(manager.handleCodexNotification({
    method: "item/agentMessage/delta",
    params: { threadId: "thread-retry", turnId: "turn-retry", itemId: "item-retry", delta: "重连后输出" }
  } as any), true);
  assert.equal(manager.handleCodexNotification({
    method: "turn/completed",
    params: { threadId: "thread-retry", turn: { id: "turn-retry", status: "completed" } }
  } as any), true);
  assert.equal(await taskPromise, "重连后输出");
} finally {
  await rm(maintenanceCodexRetryingErrorVault, { recursive: true, force: true });
}

const maintenanceCodexRetryingErrorDuringStartTurnVault = await createMaintenanceVaultForTest("codex-kb-maintain-codex-retrying-start-turn-");
try {
  const settings = normalizeSettingsData({ settingsVersion: DEFAULT_SETTINGS.settingsVersion }).settings;
  let manager: KnowledgeBaseManager;
  const plugin = {
    settings,
    getVaultPath: () => maintenanceCodexRetryingErrorDuringStartTurnVault,
    ensureCodexConnected: async () => ({
      connected: true,
      accountLabel: "Codex",
      loggedIn: true,
      models: [],
      skills: [],
      mcpServers: [],
      errors: []
    }),
    codex: {
      startThread: async () => ({ threadId: "thread-retry-start", title: "KB" }),
      startTurn: async () => {
        assert.equal(manager.handleCodexNotification({
          method: "error",
          params: {
            threadId: "thread-retry-start",
            turnId: "turn-retry-start",
            willRetry: true,
            error: { message: "Reconnecting... 1/5" }
          }
        } as any), true);
        return "turn-retry-start";
      },
      interruptTurn: async () => undefined
    }
  };
  manager = new KnowledgeBaseManager(plugin as any);
  const taskPromise = (manager as any).runCodexKnowledgeTask("prompt", [], "workspace-write", "knowledge-base");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal((manager as any).codexWaiter?.pendingTerminal, undefined);
  assert.equal(manager.handleCodexNotification({
    method: "item/agentMessage/delta",
    params: { threadId: "thread-retry-start", turnId: "turn-retry-start", itemId: "item-retry-start", delta: "启动后输出" }
  } as any), true);
  assert.equal(manager.handleCodexNotification({
    method: "turn/completed",
    params: { threadId: "thread-retry-start", turn: { id: "turn-retry-start", status: "completed" } }
  } as any), true);
  assert.equal(await taskPromise, "启动后输出");
} finally {
  await rm(maintenanceCodexRetryingErrorDuringStartTurnVault, { recursive: true, force: true });
}

const maintenanceCodexStalledTurnTimeoutVault = await createMaintenanceVaultForTest("codex-kb-maintain-codex-stalled-turn-timeout-");
try {
  const settings = normalizeSettingsData({ settingsVersion: DEFAULT_SETTINGS.settingsVersion }).settings;
  const interruptCalls: Array<{ threadId: string; turnId: string }> = [];
  const plugin = {
    settings,
    getVaultPath: () => maintenanceCodexStalledTurnTimeoutVault,
    ensureCodexConnected: async () => ({
      connected: true,
      accountLabel: "Codex",
      loggedIn: true,
      models: [],
      skills: [],
      mcpServers: [],
      errors: []
    }),
    codex: {
      startThread: async () => ({ threadId: "thread-stalled", title: "KB" }),
      startTurn: async () => "turn-stalled",
      interruptTurn: async (threadId: string, turnId: string) => {
        interruptCalls.push({ threadId, turnId });
      }
    }
  };
  const manager = new KnowledgeBaseManager(plugin as any);
  const taskPromise = (manager as any).runCodexKnowledgeTask("prompt", [], "workspace-write", "knowledge-base", { codexInactivityTimeoutMs: 10 });
  const result = await Promise.race([
    taskPromise.then(() => "resolved", (error: unknown) => error instanceof Error ? error.message : String(error)),
    new Promise((resolve) => setTimeout(() => resolve("hung"), 80))
  ]);
  assert.notEqual(result, "hung");
  assert.match(String(result), /长时间没有收到 Codex 终态/);
  assert.deepEqual(interruptCalls, [{ threadId: "thread-stalled", turnId: "turn-stalled" }]);
  assert.equal((manager as any).codexWaiter, null);
} finally {
  await rm(maintenanceCodexStalledTurnTimeoutVault, { recursive: true, force: true });
}

const maintenanceCodexStalledStartTurnTimeoutVault = await createMaintenanceVaultForTest("codex-kb-maintain-codex-stalled-start-turn-");
try {
  const settings = normalizeSettingsData({ settingsVersion: DEFAULT_SETTINGS.settingsVersion }).settings;
  const plugin = {
    settings,
    getVaultPath: () => maintenanceCodexStalledStartTurnTimeoutVault,
    ensureCodexConnected: async () => ({
      connected: true,
      accountLabel: "Codex",
      loggedIn: true,
      models: [],
      skills: [],
      mcpServers: [],
      errors: []
    }),
    codex: {
      startThread: async () => ({ threadId: "thread-stalled-start", title: "KB" }),
      startTurn: async () => new Promise<string>(() => undefined),
      interruptTurn: async () => undefined
    }
  };
  const manager = new KnowledgeBaseManager(plugin as any);
  const taskPromise = (manager as any).runCodexKnowledgeTask("prompt", [], "workspace-write", "knowledge-base", { codexInactivityTimeoutMs: 10 });
  const result = await Promise.race([
    taskPromise.then(() => "resolved", (error: unknown) => error instanceof Error ? error.message : String(error)),
    new Promise((resolve) => setTimeout(() => resolve("hung"), 80))
  ]);
  assert.notEqual(result, "hung");
  assert.match(String(result), /长时间没有收到 Codex turn id/);
  assert.equal(settings.knowledgeBase.managedThreads["thread-stalled-start"]?.archiveState, "pending-archive");
  assert.equal((manager as any).codexWaiter, null);
} finally {
  await rm(maintenanceCodexStalledStartTurnTimeoutVault, { recursive: true, force: true });
}

const maintenanceCodexOldStartedCompletedDuringStartTurnVault = await createMaintenanceVaultForTest("codex-kb-maintain-codex-old-started-completed-");
try {
  const settings = normalizeSettingsData({ settingsVersion: DEFAULT_SETTINGS.settingsVersion }).settings;
  let manager: KnowledgeBaseManager;
  const plugin = {
    settings,
    getVaultPath: () => maintenanceCodexOldStartedCompletedDuringStartTurnVault,
    ensureCodexConnected: async () => ({
      connected: true,
      accountLabel: "Codex",
      loggedIn: true,
      models: [],
      skills: [],
      mcpServers: [],
      errors: []
    }),
    codex: {
      startThread: async () => ({ threadId: "thread-reused", title: "KB" }),
      startTurn: async () => {
        assert.equal(manager.handleCodexNotification({
          method: "turn/started",
          params: { threadId: "thread-reused", turn: { id: "turn-old" } }
        } as any), true);
        assert.equal(manager.handleCodexNotification({
          method: "item/agentMessage/delta",
          params: { threadId: "thread-reused", turnId: "turn-old", itemId: "item-old", delta: "旧任务输出" }
        } as any), true);
        assert.equal(manager.handleCodexNotification({
          method: "turn/completed",
          params: { threadId: "thread-reused", turn: { id: "turn-old", status: "completed" } }
        } as any), true);
        return "turn-new";
      },
      interruptTurn: async () => undefined
    }
  };
  manager = new KnowledgeBaseManager(plugin as any);
  const taskPromise = (manager as any).runCodexKnowledgeTask("prompt", [], "workspace-write", "knowledge-base");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal((manager as any).codexWaiter?.turnId, "turn-new");
  assert.equal(manager.handleCodexNotification({
    method: "item/agentMessage/delta",
    params: { threadId: "thread-reused", turnId: "turn-new", itemId: "item-new", delta: "新任务输出" }
  } as any), true);
  assert.equal(manager.handleCodexNotification({
    method: "turn/completed",
    params: { threadId: "thread-reused", turn: { id: "turn-new", status: "completed" } }
  } as any), true);
  assert.equal(await taskPromise, "新任务输出");
} finally {
  await rm(maintenanceCodexOldStartedCompletedDuringStartTurnVault, { recursive: true, force: true });
}

const maintenanceLintDoesNotCreateWikiVault = await mkdtemp(path.join(tmpdir(), "codex-kb-maintain-lint-no-wiki-"));
try {
  await mkdir(path.join(maintenanceLintDoesNotCreateWikiVault, "raw", "articles"), { recursive: true });
  await mkdir(path.dirname(path.join(maintenanceLintDoesNotCreateWikiVault, DEFAULT_KNOWLEDGE_BASE_RULES_FILE)), { recursive: true });
  await writeFile(path.join(maintenanceLintDoesNotCreateWikiVault, DEFAULT_KNOWLEDGE_BASE_RULES_FILE), "# LLM Wiki Rules\n", "utf8");
  await writeFile(path.join(maintenanceLintDoesNotCreateWikiVault, "raw", "articles", "new.md"), "# New\n\n正文", "utf8");
  const { manager } = makeKnowledgeBaseManagerForTest(maintenanceLintDoesNotCreateWikiVault);
  const result = await manager.runMaintenance("lint", "/check 测试不创建 wiki");
  assert.equal(result.status, "success");
  assert.equal(await fileExists(path.join(maintenanceLintDoesNotCreateWikiVault, "wiki")), false);
  assert.equal(await fileExists(path.join(maintenanceLintDoesNotCreateWikiVault, "outputs", "maintenance")), true);
} finally {
  await rm(maintenanceLintDoesNotCreateWikiVault, { recursive: true, force: true });
}

const maintenanceLintDoesNotOverwriteDailyMaintainReportVault = await createMaintenanceVaultForTest("codex-kb-lint-preserve-maintain-report-");
try {
  const today = new Date();
  const maintainReportPath = knowledgeReportAbsolutePathForTest(maintenanceLintDoesNotOverwriteDailyMaintainReportVault, "maintain", today);
  const checkReportPath = knowledgeReportAbsolutePathForTest(maintenanceLintDoesNotOverwriteDailyMaintainReportVault, "lint", today);
  const maintainReportText = "# 知识库维护报告\n\n本轮维护已经消化 raw/articles/new.md。";
  await mkdir(path.dirname(maintainReportPath), { recursive: true });
  await writeFile(maintainReportPath, maintainReportText, "utf8");
  const { manager, settings } = makeKnowledgeBaseManagerForTest(maintenanceLintDoesNotOverwriteDailyMaintainReportVault, {
    beforeAgentReturn: async () => {
      await mkdir(path.dirname(checkReportPath), { recursive: true });
      await writeFile(checkReportPath, "---\nmode: lint-only\n---\n# 体检报告\n\n只执行 Lint 体检。", "utf8");
    }
  });
  const result = await manager.runMaintenance("lint", "/check 测试不覆盖同日维护报告");
  assert.equal(result.status, "success");
  assert.ok(result.reportPath.includes(`/kb-check-${formatDateKeyForTest(today)}.md`));
  assert.equal(settings.knowledgeBase.lastReportPath, `outputs/maintenance/${knowledgeReportFileNameForTest("lint", today)}`);
  assert.equal(await readFile(maintainReportPath, "utf8"), maintainReportText);
  assert.ok((await readFile(checkReportPath, "utf8")).includes("mode: lint-only"));
} finally {
  await rm(maintenanceLintDoesNotOverwriteDailyMaintainReportVault, { recursive: true, force: true });
}

const maintenanceDashboardRefreshFailureVault = await createMaintenanceVaultForTest("codex-kb-maintain-dashboard-refresh-failure-");
try {
  const { manager, settings } = makeKnowledgeBaseManagerForTest(maintenanceDashboardRefreshFailureVault, {
    throwOnDashboardRefresh: true
  });
  const warnBeforeDashboardRefreshFailureTest = console.warn;
  let thrown: unknown = null;
  let result: Awaited<ReturnType<KnowledgeBaseManager["runMaintenance"]>> | null = null;
  try {
    console.warn = () => undefined;
    result = await manager.runMaintenance("lint", "/check 测试 dashboard 刷新失败不污染任务结果");
  } catch (error) {
    thrown = error;
  } finally {
    console.warn = warnBeforeDashboardRefreshFailureTest;
  }
  assert.equal(thrown, null);
  assert.equal(result?.status, "success");
  assert.equal(manager.isRunning, false);
  assert.equal(settings.knowledgeBase.lastRunStatus, "success");
  assert.equal(settings.knowledgeBase.lastError, "");
} finally {
  await rm(maintenanceDashboardRefreshFailureVault, { recursive: true, force: true });
}

const maintenanceOutputsSymlinkVault = await mkdtemp(path.join(tmpdir(), "codex-kb-maintain-outputs-symlink-"));
try {
  await mkdir(path.join(maintenanceOutputsSymlinkVault, "raw", "articles"), { recursive: true });
  await mkdir(path.dirname(path.join(maintenanceOutputsSymlinkVault, DEFAULT_KNOWLEDGE_BASE_RULES_FILE)), { recursive: true });
  await writeFile(path.join(maintenanceOutputsSymlinkVault, DEFAULT_KNOWLEDGE_BASE_RULES_FILE), "# LLM Wiki Rules\n", "utf8");
  await writeFile(path.join(maintenanceOutputsSymlinkVault, "raw", "articles", "new.md"), "# New\n\n正文", "utf8");
  const externalOutputsTarget = path.join(maintenanceOutputsSymlinkVault, "outside-outputs-target");
  await mkdir(externalOutputsTarget, { recursive: true });
  await symlink(externalOutputsTarget, path.join(maintenanceOutputsSymlinkVault, "outputs"));
  const { manager } = makeKnowledgeBaseManagerForTest(maintenanceOutputsSymlinkVault);
  const result = await manager.runMaintenance("lint", "/check 测试 outputs symlink 不外写");
  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /知识库写入区不能包含 symlink/);
  assert.equal((await lstat(path.join(maintenanceOutputsSymlinkVault, "outputs"))).isSymbolicLink(), true);
  assert.deepEqual(await readdir(externalOutputsTarget), []);
  assert.equal(await fileExists(path.join(externalOutputsTarget, "maintenance")), false);
} finally {
  await rm(maintenanceOutputsSymlinkVault, { recursive: true, force: true });
}

const maintenanceOutputsSpecialFileVault = await mkdtemp(path.join(tmpdir(), "codex-kb-maintain-outputs-special-"));
try {
  await mkdir(path.join(maintenanceOutputsSpecialFileVault, "raw", "articles"), { recursive: true });
  await mkdir(path.join(maintenanceOutputsSpecialFileVault, "outputs"), { recursive: true });
  await mkdir(path.dirname(path.join(maintenanceOutputsSpecialFileVault, DEFAULT_KNOWLEDGE_BASE_RULES_FILE)), { recursive: true });
  await writeFile(path.join(maintenanceOutputsSpecialFileVault, DEFAULT_KNOWLEDGE_BASE_RULES_FILE), "# LLM Wiki Rules\n", "utf8");
  await writeFile(path.join(maintenanceOutputsSpecialFileVault, "raw", "articles", "new.md"), "# New\n\n正文", "utf8");
  await execFile("mkfifo", [path.join(maintenanceOutputsSpecialFileVault, "outputs", "agent.pipe")]);
  const { manager } = makeKnowledgeBaseManagerForTest(maintenanceOutputsSpecialFileVault);
  const result = await manager.runMaintenance("lint", "/check 测试 outputs special file 不继续");
  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /知识库写入区不能包含特殊文件/);
} finally {
  await rm(maintenanceOutputsSpecialFileVault, { recursive: true, force: true });
}

const maintenanceRawRootSymlinkVault = await mkdtemp(path.join(tmpdir(), "codex-kb-maintain-raw-root-symlink-"));
try {
  await mkdir(path.dirname(path.join(maintenanceRawRootSymlinkVault, DEFAULT_KNOWLEDGE_BASE_RULES_FILE)), { recursive: true });
  await writeFile(path.join(maintenanceRawRootSymlinkVault, DEFAULT_KNOWLEDGE_BASE_RULES_FILE), "# LLM Wiki Rules\n", "utf8");
  const externalRawTarget = path.join(maintenanceRawRootSymlinkVault, "outside-raw-target");
  await mkdir(path.join(externalRawTarget, "articles"), { recursive: true });
  await writeFile(path.join(externalRawTarget, "articles", "external.md"), "# External\n\n不应作为 Vault raw 扫描", "utf8");
  await symlink(externalRawTarget, path.join(maintenanceRawRootSymlinkVault, "raw"));
  const { manager } = makeKnowledgeBaseManagerForTest(maintenanceRawRootSymlinkVault);
  const result = await manager.runMaintenance("lint", "/check 测试 raw 根 symlink 不扫描外部");
  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /raw\/ 不是普通目录/);
  assert.equal(await fileExists(path.join(maintenanceRawRootSymlinkVault, "outputs")), false);
} finally {
  await rm(maintenanceRawRootSymlinkVault, { recursive: true, force: true });
}

const maintenanceRawChildSymlinkVault = await createMaintenanceVaultForTest("codex-kb-maintain-raw-child-symlink-");
try {
  const externalRawTarget = path.join(maintenanceRawChildSymlinkVault, "outside-raw.md");
  await writeFile(externalRawTarget, "# External\n\n不应作为 raw 证据", "utf8");
  await symlink(externalRawTarget, path.join(maintenanceRawChildSymlinkVault, "raw", "articles", "linked.md"));
  const { manager } = makeKnowledgeBaseManagerForTest(maintenanceRawChildSymlinkVault);
  const result = await manager.runMaintenance("lint", "/check 测试 raw 子 symlink 不继续");
  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /raw\/ 不能包含 symlink/);
  assert.equal(await readFile(externalRawTarget, "utf8"), "# External\n\n不应作为 raw 证据");
  assert.equal(await fileExists(path.join(maintenanceRawChildSymlinkVault, "outputs", "maintenance")), false);
} finally {
  await rm(maintenanceRawChildSymlinkVault, { recursive: true, force: true });
}

const maintenanceRawHardlinkVault = await createMaintenanceVaultForTest("codex-kb-maintain-raw-hardlink-");
try {
  const externalHardlinkTarget = path.join(maintenanceRawHardlinkVault, "outside-hardlink.md");
  const rawHardlinkPath = path.join(maintenanceRawHardlinkVault, "raw", "articles", "hardlinked.md");
  await writeFile(externalHardlinkTarget, "# External hardlink\n\n共享 inode 不应作为 raw 证据", "utf8");
  await link(externalHardlinkTarget, rawHardlinkPath);
  const { manager } = makeKnowledgeBaseManagerForTest(maintenanceRawHardlinkVault);
  const result = await manager.runMaintenance("lint", "/check 测试 raw hardlink 不继续");
  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /raw\/ 不能包含 hardlink/);
  assert.equal(await readFile(externalHardlinkTarget, "utf8"), "# External hardlink\n\n共享 inode 不应作为 raw 证据");
  assert.equal(await fileExists(path.join(maintenanceRawHardlinkVault, "outputs", "maintenance")), false);
} finally {
  await rm(maintenanceRawHardlinkVault, { recursive: true, force: true });
}

const maintenanceLintWrongReportVault = await createMaintenanceVaultForTest("codex-kb-maintain-lint-wrong-report-");
try {
  const { manager } = makeKnowledgeBaseManagerForTest(maintenanceLintWrongReportVault, {
    beforeAgentReturn: async () => {
      const reportPath = knowledgeReportAbsolutePathForTest(maintenanceLintWrongReportVault, "lint");
      await mkdir(path.dirname(reportPath), { recursive: true });
      await writeFile(reportPath, "# 维护报告\n\n执行 Ingest + Structure Normalize + Lint。", "utf8");
    }
  });
  const result = await manager.runMaintenance("lint", "/check 测试错误报告不复用");
  assert.equal(result.status, "success");
  const reportText = await readFile(path.join(maintenanceLintWrongReportVault, result.reportPath), "utf8");
  assert.ok(reportText.includes("mode: lint-only"));
  assert.ok(reportText.includes("fallback: true"));
  assert.ok(reportText.includes("不是 lint-only 体检报告"));
  assert.ok(!reportText.includes("执行 Ingest + Structure Normalize + Lint"));
} finally {
  await rm(maintenanceLintWrongReportVault, { recursive: true, force: true });
}

const maintenanceLintSemanticReportMetadataVault = await createMaintenanceVaultForTest("codex-kb-maintain-lint-semantic-metadata-");
try {
  const { manager } = makeKnowledgeBaseManagerForTest(maintenanceLintSemanticReportMetadataVault, {
    beforeAgentReturn: async () => {
      const reportPath = knowledgeReportAbsolutePathForTest(maintenanceLintSemanticReportMetadataVault, "lint");
      await mkdir(path.dirname(reportPath), { recursive: true });
      await writeFile(reportPath, [
        "---",
        "source: codex-echoink",
        "mode: check",
        "---",
        "",
        "# 体检报告",
        "",
        "本轮只执行 Lint 体检，不做新增消化。"
      ].join("\n"), "utf8");
    }
  });
  const result = await manager.runMaintenance("lint", "/check 测试语义 lint 报告补齐 mode");
  assert.equal(result.status, "success");
  const reportText = await readFile(path.join(maintenanceLintSemanticReportMetadataVault, result.reportPath), "utf8");
  assert.ok(reportText.includes("mode: lint-only"));
  assert.equal(reportText.includes("mode: check"), false);
  assert.equal((reportText.match(/^mode:/gm) ?? []).length, 1);
  assert.ok(reportText.includes("本轮只执行 Lint 体检"));
  assert.equal(reportText.includes("fallback: true"), false);
} finally {
  await rm(maintenanceLintSemanticReportMetadataVault, { recursive: true, force: true });
}

const maintenanceLintSuccessDropsExtraOutputsVault = await createMaintenanceVaultForTest("codex-kb-maintain-lint-drop-extra-outputs-");
try {
  await mkdir(path.join(maintenanceLintSuccessDropsExtraOutputsVault, "outputs", "notes"), { recursive: true });
  await writeFile(path.join(maintenanceLintSuccessDropsExtraOutputsVault, "outputs", "notes", "existing.md"), "# Existing\n", "utf8");
  const existingOutputBefore = await stat(path.join(maintenanceLintSuccessDropsExtraOutputsVault, "outputs", "notes", "existing.md"));
  const { manager } = makeKnowledgeBaseManagerForTest(maintenanceLintSuccessDropsExtraOutputsVault, {
    beforeAgentReturn: async () => {
      const reportPath = knowledgeReportAbsolutePathForTest(maintenanceLintSuccessDropsExtraOutputsVault, "lint");
      await mkdir(path.dirname(reportPath), { recursive: true });
      await writeFile(reportPath, "---\nmode: lint-only\n---\n# 体检报告\n\nAgent 已写出报告。", "utf8");
      await writeFile(path.join(maintenanceLintSuccessDropsExtraOutputsVault, "outputs", "notes", "extra.md"), "# Extra\n", "utf8");
    }
  });
  const result = await manager.runMaintenance("lint", "/check 测试成功只保留报告");
  assert.equal(result.status, "success");
  assert.equal(await fileExists(path.join(maintenanceLintSuccessDropsExtraOutputsVault, "outputs", "notes", "existing.md")), true);
  assert.equal(await fileExists(path.join(maintenanceLintSuccessDropsExtraOutputsVault, "outputs", "notes", "extra.md")), false);
  const existingOutputAfter = await stat(path.join(maintenanceLintSuccessDropsExtraOutputsVault, "outputs", "notes", "existing.md"));
  assert.equal(existingOutputAfter.ino, existingOutputBefore.ino);
  assert.equal(Math.round(existingOutputAfter.mtimeMs), Math.round(existingOutputBefore.mtimeMs));
  assert.ok((await readFile(path.join(maintenanceLintSuccessDropsExtraOutputsVault, result.reportPath), "utf8")).includes("mode: lint-only"));
} finally {
  await rm(maintenanceLintSuccessDropsExtraOutputsVault, { recursive: true, force: true });
}

const maintenanceLintRecoveredReportVault = await createMaintenanceVaultForTest("codex-kb-maintain-lint-recovered-report-");
try {
  const { manager, settings } = makeKnowledgeBaseManagerForTest(maintenanceLintRecoveredReportVault, {
    beforeAgentReturn: async () => {
      const reportPath = knowledgeReportAbsolutePathForTest(maintenanceLintRecoveredReportVault, "lint");
      await mkdir(path.dirname(reportPath), { recursive: true });
      await writeFile(reportPath, "---\nmode: lint-only\n---\n# 体检报告\n\nAgent 已写出报告。", "utf8");
      throw new Error("Codex turn reported failed after report");
    }
  });
  const result = await manager.runMaintenance("lint", "/check 测试失败状态恢复报告");
  assert.equal(result.status, "success");
  assert.equal(result.processedSources.length, 0);
  assert.equal(settings.knowledgeBase.lastRunStatus, "success");
  assert.equal(settings.knowledgeBase.lastError, "");
  assert.ok((await readFile(path.join(maintenanceLintRecoveredReportVault, result.reportPath), "utf8")).includes("mode: lint-only"));
} finally {
  await rm(maintenanceLintRecoveredReportVault, { recursive: true, force: true });
}

const maintenanceLintRecoveredReportSaveFailureVault = await createMaintenanceVaultForTest("codex-kb-maintain-lint-recovered-save-failure-");
try {
  const { manager, settings, saveCalls } = makeKnowledgeBaseManagerForTest(maintenanceLintRecoveredReportSaveFailureVault, {
    failSaveCall: 2,
    beforeAgentReturn: async () => {
      const reportPath = knowledgeReportAbsolutePathForTest(maintenanceLintRecoveredReportSaveFailureVault, "lint");
      await mkdir(path.dirname(reportPath), { recursive: true });
      await writeFile(reportPath, "---\nmode: lint-only\n---\n# 体检报告\n\nAgent 已写出报告。", "utf8");
      throw new Error("Codex turn reported failed after report");
    }
  });
  const result = await manager.runMaintenance("lint", "/check 测试恢复成功但保存失败");
  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /状态保存失败：saveSettings failed at call 2/);
  assert.equal(settings.knowledgeBase.lastRunStatus, "failed");
  assert.deepEqual(settings.knowledgeBase.maintenanceHistory, []);
  assert.equal(await fileExists(path.join(maintenanceLintRecoveredReportSaveFailureVault, result.reportPath)), false);
  assert.equal(saveCalls(), 3);
} finally {
  await rm(maintenanceLintRecoveredReportSaveFailureVault, { recursive: true, force: true });
}

const maintenanceLintRecoveredReportCommitFailureVault = await createMaintenanceVaultForTest("codex-kb-maintain-lint-recovered-commit-failure-");
try {
  let reportDirectory = "";
  const { manager, settings } = makeKnowledgeBaseManagerForTest(maintenanceLintRecoveredReportCommitFailureVault, {
    beforeAgentReturn: async () => {
      const reportPath = knowledgeReportAbsolutePathForTest(maintenanceLintRecoveredReportCommitFailureVault, "lint");
      reportDirectory = path.dirname(reportPath);
      await mkdir(reportDirectory, { recursive: true });
      await writeFile(reportPath, "---\nmode: lint-only\n---\n# 体检报告\n\nAgent 已写出报告。", "utf8");
      await chmod(reportDirectory, 0o555);
      throw new Error("Codex turn reported failed after report");
    }
  });
  const result = await manager.runMaintenance("lint", "/check 测试恢复报告提交失败仍然收口");
  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /Codex turn reported failed after report/);
  assert.match(result.error ?? "", /体检报告恢复失败/);
  assert.equal(settings.knowledgeBase.lastRunStatus, "failed");
  assert.equal(settings.knowledgeBase.maintenanceHistory.at(-1)?.status, "failed");
} finally {
  await chmod(path.join(maintenanceLintRecoveredReportCommitFailureVault, "outputs", "maintenance"), 0o755).catch(() => undefined);
  await rm(maintenanceLintRecoveredReportCommitFailureVault, { recursive: true, force: true });
}

const maintenanceLintRecoveredReportCancelVault = await createMaintenanceVaultForTest("codex-kb-maintain-lint-recovered-cancel-");
try {
  const { manager, settings } = makeKnowledgeBaseManagerForTest(maintenanceLintRecoveredReportCancelVault, {
    cancelBeforeSaveCall: 2,
    beforeAgentReturn: async () => {
      const reportPath = knowledgeReportAbsolutePathForTest(maintenanceLintRecoveredReportCancelVault, "lint");
      await mkdir(path.dirname(reportPath), { recursive: true });
      await writeFile(reportPath, "---\nmode: lint-only\n---\n# 体检报告\n\nAgent 已写出报告。", "utf8");
      throw new Error("Codex turn reported failed after report");
    }
  });
  const result = await manager.runMaintenance("lint", "/check 测试恢复报告前取消");
  assert.equal(result.status, "canceled");
  assert.match(result.error ?? "", /用户取消/);
  assert.equal(settings.knowledgeBase.lastRunStatus, "canceled");
  assert.deepEqual(settings.knowledgeBase.maintenanceHistory, []);
  assert.equal(await fileExists(path.join(maintenanceLintRecoveredReportCancelVault, result.reportPath)), false);
} finally {
  await rm(maintenanceLintRecoveredReportCancelVault, { recursive: true, force: true });
}

const maintenanceLintFinalSaveFailureVault = await createMaintenanceVaultForTest("codex-kb-maintain-lint-final-save-failure-");
try {
  const { manager, settings, saveCalls } = makeKnowledgeBaseManagerForTest(maintenanceLintFinalSaveFailureVault, {
    failSaveCall: 2
  });
  const result = await manager.runMaintenance("lint", "/check 测试最终保存失败不误恢复");
  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /saveSettings failed at call 2/);
  assert.equal(settings.knowledgeBase.lastRunStatus, "failed");
  assert.equal(settings.knowledgeBase.maintenanceHistory.at(-1)?.status, "failed");
  assert.equal(await fileExists(path.join(maintenanceLintFinalSaveFailureVault, result.reportPath)), false);
  assert.equal(saveCalls(), 3);
} finally {
  await rm(maintenanceLintFinalSaveFailureVault, { recursive: true, force: true });
}

const maintenanceLateCancelSaveFailureVault = await createMaintenanceVaultForTest("codex-kb-maintain-late-cancel-save-failure-");
try {
  const { manager, settings } = makeKnowledgeBaseManagerForTest(maintenanceLateCancelSaveFailureVault, {
    cancelBeforeSaveCall: 2,
    failSaveCall: 2
  });
  const result = await manager.runMaintenance("lint", "/check 测试最终保存窗口取消且保存失败");
  assert.equal(result.status, "canceled");
  assert.match(result.error ?? "", /用户取消/);
  assert.match(result.error ?? "", /状态保存失败：saveSettings failed at call 2/);
  assert.equal(settings.knowledgeBase.lastRunStatus, "canceled");
  assert.match(settings.knowledgeBase.lastError, /状态保存失败：saveSettings failed at call 2/);
  assert.equal(await fileExists(path.join(maintenanceLateCancelSaveFailureVault, result.reportPath)), false);
} finally {
  await rm(maintenanceLateCancelSaveFailureVault, { recursive: true, force: true });
}

const maintenanceCancelStatusSaveRetryVault = await createMaintenanceVaultForTest("codex-kb-maintain-cancel-status-save-retry-");
try {
  const { manager, settings, saveCalls } = makeKnowledgeBaseManagerForTest(maintenanceCancelStatusSaveRetryVault, {
    cancelBeforeSaveCall: 2,
    failSaveCall: 3
  });
  const result = await manager.runMaintenance("lint", "/check 测试取消状态保存失败后重试");
  assert.equal(result.status, "canceled");
  assert.match(result.error ?? "", /用户取消/);
  assert.match(result.error ?? "", /状态保存失败：saveSettings failed at call 3/);
  assert.equal(settings.knowledgeBase.lastRunStatus, "canceled");
  assert.match(settings.knowledgeBase.lastError, /状态保存失败：saveSettings failed at call 3/);
  assert.equal(saveCalls(), 4);
  assert.equal(await fileExists(path.join(maintenanceCancelStatusSaveRetryVault, result.reportPath)), false);
} finally {
  await rm(maintenanceCancelStatusSaveRetryVault, { recursive: true, force: true });
}

const maintenanceLintSymlinkAfterAgentVault = await createMaintenanceVaultForTest("codex-kb-maintain-lint-symlink-after-agent-");
try {
  const externalOutputTarget = path.join(maintenanceLintSymlinkAfterAgentVault, "outside-output-target");
  await mkdir(externalOutputTarget, { recursive: true });
  const { manager } = makeKnowledgeBaseManagerForTest(maintenanceLintSymlinkAfterAgentVault, {
    beforeAgentReturn: async () => {
      const reportPath = knowledgeReportAbsolutePathForTest(maintenanceLintSymlinkAfterAgentVault, "lint");
      await mkdir(path.dirname(reportPath), { recursive: true });
      await writeFile(reportPath, "---\nmode: lint-only\n---\n# 体检报告\n\nAgent 已写出报告。", "utf8");
      await symlink(externalOutputTarget, path.join(maintenanceLintSymlinkAfterAgentVault, "outputs", "agent-link"));
    }
  });
  const result = await manager.runMaintenance("lint", "/check 测试 Agent 新增 symlink 不误恢复");
  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /知识库写入区不能包含 symlink/);
  assert.equal(await fileExists(path.join(maintenanceLintSymlinkAfterAgentVault, result.reportPath)), false);
  assert.equal(await fileExists(path.join(maintenanceLintSymlinkAfterAgentVault, "outputs", "agent-link")), false);
  assert.deepEqual(await readdir(externalOutputTarget), []);
} finally {
  await rm(maintenanceLintSymlinkAfterAgentVault, { recursive: true, force: true });
}

const maintenanceLintConcurrentRawVault = await createMaintenanceVaultForTest("codex-kb-maintain-lint-concurrent-raw-");
try {
  const concurrentRaw = path.join(maintenanceLintConcurrentRawVault, "raw", "articles", "external.md");
  const { manager } = makeKnowledgeBaseManagerForTest(maintenanceLintConcurrentRawVault, {
    beforeAgentReturn: async () => {
      await writeFile(concurrentRaw, "# External\n\n外部自动化新增 raw", "utf8");
    }
  });
  const result = await manager.runMaintenance("lint", "/check 测试并发 raw 新增不被删除");
  assert.equal(result.status, "success");
  assert.equal(result.error, undefined);
  assert.equal(await readFile(concurrentRaw, "utf8"), "# External\n\n外部自动化新增 raw");
  assert.equal(await fileExists(path.join(maintenanceLintConcurrentRawVault, result.reportPath)), true);
  assert.ok((await readFile(path.join(maintenanceLintConcurrentRawVault, result.reportPath), "utf8")).includes("raw/articles/external.md"));
} finally {
  await rm(maintenanceLintConcurrentRawVault, { recursive: true, force: true });
}

const maintenanceLintRecoveredReportDropsExtraOutputsVault = await createMaintenanceVaultForTest("codex-kb-maintain-lint-recovered-drop-extra-");
try {
  const { manager } = makeKnowledgeBaseManagerForTest(maintenanceLintRecoveredReportDropsExtraOutputsVault, {
    beforeAgentReturn: async () => {
      const reportPath = knowledgeReportAbsolutePathForTest(maintenanceLintRecoveredReportDropsExtraOutputsVault, "lint");
      await mkdir(path.dirname(reportPath), { recursive: true });
      await writeFile(reportPath, "---\nmode: lint-only\n---\n# 体检报告\n\nAgent 已写出报告。", "utf8");
      await mkdir(path.join(maintenanceLintRecoveredReportDropsExtraOutputsVault, "outputs", "tmp"), { recursive: true });
      await writeFile(path.join(maintenanceLintRecoveredReportDropsExtraOutputsVault, "outputs", "tmp", "extra.md"), "# Extra\n", "utf8");
      throw new Error("Codex turn reported failed after report");
    }
  });
  const result = await manager.runMaintenance("lint", "/check 测试失败恢复只保留报告");
  assert.equal(result.status, "success");
  assert.ok((await readFile(path.join(maintenanceLintRecoveredReportDropsExtraOutputsVault, result.reportPath), "utf8")).includes("mode: lint-only"));
  assert.equal(await fileExists(path.join(maintenanceLintRecoveredReportDropsExtraOutputsVault, "outputs", "tmp", "extra.md")), false);
} finally {
  await rm(maintenanceLintRecoveredReportDropsExtraOutputsVault, { recursive: true, force: true });
}

const maintenanceLintFailedReportRollbackVault = await createMaintenanceVaultForTest("codex-kb-maintain-lint-failed-report-rollback-");
try {
  const { manager } = makeKnowledgeBaseManagerForTest(maintenanceLintFailedReportRollbackVault, {
    beforeAgentReturn: async () => {
      const reportPath = knowledgeReportAbsolutePathForTest(maintenanceLintFailedReportRollbackVault, "lint");
      await mkdir(path.dirname(reportPath), { recursive: true });
      await writeFile(reportPath, "# 维护报告\n\n不是 lint-only。", "utf8");
      throw new Error("Codex turn failed without lint-only report");
    }
  });
  const result = await manager.runMaintenance("lint", "/check 测试失败报告回滚");
  assert.equal(result.status, "failed");
  assert.equal(await fileExists(path.join(maintenanceLintFailedReportRollbackVault, result.reportPath)), false);
} finally {
  await rm(maintenanceLintFailedReportRollbackVault, { recursive: true, force: true });
}

const maintenanceLintFailurePreservesNonOutputVault = await createMaintenanceVaultForTest("codex-kb-maintain-lint-preserve-non-output-");
try {
  await mkdir(path.join(maintenanceLintFailurePreservesNonOutputVault, "inbox"), { recursive: true });
  await mkdir(path.join(maintenanceLintFailurePreservesNonOutputVault, "projects", "demo"), { recursive: true });
  await writeFile(path.join(maintenanceLintFailurePreservesNonOutputVault, "inbox", "idea.md"), "# Idea\n", "utf8");
  await writeFile(path.join(maintenanceLintFailurePreservesNonOutputVault, "projects", "demo", "brief.md"), "# Brief\n", "utf8");
  const { manager } = makeKnowledgeBaseManagerForTest(maintenanceLintFailurePreservesNonOutputVault, {
    beforeAgentReturn: async () => {
      const reportPath = knowledgeReportAbsolutePathForTest(maintenanceLintFailurePreservesNonOutputVault, "lint");
      await mkdir(path.dirname(reportPath), { recursive: true });
      await writeFile(reportPath, "# 维护报告\n\n不是 lint-only。", "utf8");
      throw new Error("Codex turn failed without lint-only report");
    }
  });
  const result = await manager.runMaintenance("lint", "/check 测试失败只回滚 outputs");
  assert.equal(result.status, "failed");
  assert.equal(await fileExists(path.join(maintenanceLintFailurePreservesNonOutputVault, result.reportPath)), false);
  assert.equal(await readFile(path.join(maintenanceLintFailurePreservesNonOutputVault, "raw", "index.md"), "utf8"), "# Raw\n");
  assert.equal(await readFile(path.join(maintenanceLintFailurePreservesNonOutputVault, "wiki", "index.md"), "utf8"), "# Wiki\n");
  assert.equal(await readFile(path.join(maintenanceLintFailurePreservesNonOutputVault, "inbox", "idea.md"), "utf8"), "# Idea\n");
  assert.equal(await readFile(path.join(maintenanceLintFailurePreservesNonOutputVault, "projects", "demo", "brief.md"), "utf8"), "# Brief\n");
} finally {
  await rm(maintenanceLintFailurePreservesNonOutputVault, { recursive: true, force: true });
}

const maintenanceFailureRemovesDsStoreVault = await createMaintenanceVaultForTest("codex-kb-maintain-ds-store-rollback-");
try {
  const { manager } = makeKnowledgeBaseManagerForTest(maintenanceFailureRemovesDsStoreVault, {
    beforeAgentReturn: async () => {
      await writeFile(path.join(maintenanceFailureRemovesDsStoreVault, "wiki", ".DS_Store"), "agent metadata", "utf8");
      throw new Error("Agent failed after metadata write");
    }
  });
  const result = await manager.runMaintenance("maintain", "/maintain 测试失败回滚 DS_Store");
  assert.equal(result.status, "failed");
  assert.equal(await fileExists(path.join(maintenanceFailureRemovesDsStoreVault, "wiki", ".DS_Store")), false);
} finally {
  await rm(maintenanceFailureRemovesDsStoreVault, { recursive: true, force: true });
}

const maintenanceTrackerSymlinkCreatedByAgentVault = await createMaintenanceVaultForTest("codex-kb-maintain-tracker-symlink-");
try {
  const trackerSecretPath = path.join(maintenanceTrackerSymlinkCreatedByAgentVault, "outside-tracker-secret.md");
  await writeFile(trackerSecretPath, "# Secret Tracker Target\n\nSECRET-TRACKER-CONTENT", "utf8");
  const { manager } = makeKnowledgeBaseManagerForTest(maintenanceTrackerSymlinkCreatedByAgentVault, {
    beforeAgentReturn: async () => {
      const trackerPath = path.join(maintenanceTrackerSymlinkCreatedByAgentVault, "outputs", ".ingest-tracker.md");
      await mkdir(path.dirname(trackerPath), { recursive: true });
      await rm(trackerPath, { force: true });
      await symlink(trackerSecretPath, trackerPath);
      await mkdir(path.join(maintenanceTrackerSymlinkCreatedByAgentVault, "wiki", "ai-intelligence", "references"), { recursive: true });
      await writeFile(path.join(maintenanceTrackerSymlinkCreatedByAgentVault, "wiki", "ai-intelligence", "references", "tracker-symlink.md"), [
        "# Tracker Symlink",
        "",
        "来源：[[raw/articles/new]]",
        "核心要点：本轮新增正文已经进入 tracker symlink 测试页。",
        ""
      ].join("\n"), "utf8");
      const reportPath = path.join(maintenanceTrackerSymlinkCreatedByAgentVault, "outputs", "maintenance", `kb-maintenance-${formatDateKeyForTest(new Date())}.md`);
      await mkdir(path.dirname(reportPath), { recursive: true });
      await writeFile(reportPath, [
        "---",
        "source: codex-echoink",
        "---",
        "",
        "# 知识库维护报告",
        "",
        "## 本轮来源",
        "- [[raw/articles/new]]",
        ""
      ].join("\n"), "utf8");
    }
  });
  const result = await manager.runMaintenance("maintain", "/maintain tracker symlink 不读外部目标");
  assert.equal(result.status, "success");
  const trackerPath = path.join(maintenanceTrackerSymlinkCreatedByAgentVault, "outputs", ".ingest-tracker.md");
  assert.equal((await lstat(trackerPath)).isSymbolicLink(), false);
  const trackerText = await readFile(trackerPath, "utf8");
  assert.ok(!trackerText.includes("SECRET-TRACKER-CONTENT"));
  assert.equal(await readFile(trackerSecretPath, "utf8"), "# Secret Tracker Target\n\nSECRET-TRACKER-CONTENT");
} finally {
  await rm(maintenanceTrackerSymlinkCreatedByAgentVault, { recursive: true, force: true });
}

const maintenanceTrackerHardlinkCreatedByAgentVault = await createMaintenanceVaultForTest("codex-kb-maintain-tracker-hardlink-");
try {
  const trackerSecretPath = path.join(maintenanceTrackerHardlinkCreatedByAgentVault, "outside-tracker-hardlink.md");
  await writeFile(trackerSecretPath, "# Secret Tracker Hardlink\n\nSECRET-HARDLINK-TRACKER-CONTENT", "utf8");
  const { manager } = makeKnowledgeBaseManagerForTest(maintenanceTrackerHardlinkCreatedByAgentVault, {
    beforeAgentReturn: async () => {
      const trackerPath = path.join(maintenanceTrackerHardlinkCreatedByAgentVault, "outputs", ".ingest-tracker.md");
      await mkdir(path.dirname(trackerPath), { recursive: true });
      await rm(trackerPath, { force: true });
      await link(trackerSecretPath, trackerPath);
      await mkdir(path.join(maintenanceTrackerHardlinkCreatedByAgentVault, "wiki", "ai-intelligence", "references"), { recursive: true });
      await writeFile(path.join(maintenanceTrackerHardlinkCreatedByAgentVault, "wiki", "ai-intelligence", "references", "tracker-hardlink.md"), [
        "# Tracker Hardlink",
        "",
        "来源：[[raw/articles/new]]",
        "核心要点：本轮新增正文已经进入 tracker hardlink 测试页。",
        ""
      ].join("\n"), "utf8");
      const reportPath = path.join(maintenanceTrackerHardlinkCreatedByAgentVault, "outputs", "maintenance", `kb-maintenance-${formatDateKeyForTest(new Date())}.md`);
      await mkdir(path.dirname(reportPath), { recursive: true });
      await writeFile(reportPath, [
        "---",
        "source: codex-echoink",
        "---",
        "",
        "# 知识库维护报告",
        "",
        "## 本轮来源",
        "- [[raw/articles/new]]",
        ""
      ].join("\n"), "utf8");
    }
  });
  const result = await manager.runMaintenance("maintain", "/maintain tracker hardlink 不读外部目标");
  assert.equal(result.status, "success");
  const trackerPath = path.join(maintenanceTrackerHardlinkCreatedByAgentVault, "outputs", ".ingest-tracker.md");
  assert.equal((await lstat(trackerPath)).nlink, 1);
  const trackerText = await readFile(trackerPath, "utf8");
  assert.ok(!trackerText.includes("SECRET-HARDLINK-TRACKER-CONTENT"));
  assert.equal(await readFile(trackerSecretPath, "utf8"), "# Secret Tracker Hardlink\n\nSECRET-HARDLINK-TRACKER-CONTENT");
} finally {
  await rm(maintenanceTrackerHardlinkCreatedByAgentVault, { recursive: true, force: true });
}

const maintenanceNoEvidenceVault = await createMaintenanceVaultForTest("codex-kb-maintain-no-evidence-");
try {
  const { manager, settings } = makeKnowledgeBaseManagerForTest(maintenanceNoEvidenceVault);
  settings.knowledgeBase.lastSummary = "旧成功摘要不应残留";
  const result = await manager.runMaintenance("maintain", "/maintain Agent 未写报告不能提交 tracker");
  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /未写出本轮来源证据/);
  assert.equal(settings.knowledgeBase.lastSummary, "");
  assert.deepEqual(Object.keys(settings.knowledgeBase.processedSources), []);
  assert.equal(await fileExists(path.join(maintenanceNoEvidenceVault, "outputs", ".ingest-tracker.md")), false);
  const rediscovered = await discoverKnowledgeBaseSources(maintenanceNoEvidenceVault, settings.knowledgeBase.processedSources);
  assert.equal(rediscovered.changedSources.some((source) => source.relativePath === "raw/articles/new.md"), true);
} finally {
  await rm(maintenanceNoEvidenceVault, { recursive: true, force: true });
}

const maintenanceReportOnlyVault = await createMaintenanceVaultForTest("codex-kb-maintain-report-only-");
try {
  const { manager, settings } = makeKnowledgeBaseManagerForTest(maintenanceReportOnlyVault, {
    beforeAgentReturn: async () => {
      const reportPath = path.join(maintenanceReportOnlyVault, "outputs", "maintenance", `kb-maintenance-${formatDateKeyForTest(new Date())}.md`);
      await mkdir(path.dirname(reportPath), { recursive: true });
      await writeFile(reportPath, [
        "---",
        "source: codex-echoink",
        "---",
        "",
        "# 知识库维护报告",
        "",
        "## 本轮来源",
        "- [[raw/articles/new]]",
        ""
      ].join("\n"), "utf8");
    }
  });
  const result = await manager.runMaintenance("maintain", "/maintain Agent 只写报告不能提交 tracker");
  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /未写出结构层消化证据/);
  assert.deepEqual(Object.keys(settings.knowledgeBase.processedSources), []);
  assert.equal(await fileExists(path.join(maintenanceReportOnlyVault, "outputs", ".ingest-tracker.md")), false);
  const rediscovered = await discoverKnowledgeBaseSources(maintenanceReportOnlyVault, settings.knowledgeBase.processedSources);
  assert.equal(rediscovered.changedSources.some((source) => source.relativePath === "raw/articles/new.md"), true);
} finally {
  await rm(maintenanceReportOnlyVault, { recursive: true, force: true });
}

const maintenanceIndexOnlyVault = await createMaintenanceVaultForTest("codex-kb-maintain-index-only-");
try {
  await writeFile(path.join(maintenanceIndexOnlyVault, "raw", "index.md"), [
    "# Raw",
    "",
    "- [[raw/articles/new]]",
    ""
  ].join("\n"), "utf8");
  const { manager, settings } = makeKnowledgeBaseManagerForTest(maintenanceIndexOnlyVault, {
    beforeAgentReturn: async () => {
      await writeFile(path.join(maintenanceIndexOnlyVault, "raw", "index.md"), [
        "# Raw",
        "",
        "- [[raw/articles/new]]",
        "",
        "Agent updated raw index only",
        ""
      ].join("\n"), "utf8");
      await writeFile(path.join(maintenanceIndexOnlyVault, "wiki", "index.md"), [
        "# Wiki",
        "",
        "- [[raw/articles/new]]",
        ""
      ].join("\n"), "utf8");
      const reportPath = path.join(maintenanceIndexOnlyVault, "outputs", "maintenance", `kb-maintenance-${formatDateKeyForTest(new Date())}.md`);
      await mkdir(path.dirname(reportPath), { recursive: true });
      await writeFile(reportPath, [
        "---",
        "source: codex-echoink",
        "---",
        "",
        "# 知识库维护报告",
        "",
        "## 本轮来源",
        "- [[raw/articles/new]]",
        ""
      ].join("\n"), "utf8");
    }
  });
  const result = await manager.runMaintenance("maintain", "/maintain Agent 只改索引不能提交 tracker");
  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /未写出结构层消化证据/);
  assert.deepEqual(Object.keys(settings.knowledgeBase.processedSources), []);
  assert.equal(await fileExists(path.join(maintenanceIndexOnlyVault, "outputs", ".ingest-tracker.md")), false);
  const rediscovered = await discoverKnowledgeBaseSources(maintenanceIndexOnlyVault, settings.knowledgeBase.processedSources);
  assert.equal(rediscovered.changedSources.some((source) => source.relativePath === "raw/articles/new.md"), true);
} finally {
  await rm(maintenanceIndexOnlyVault, { recursive: true, force: true });
}

const maintenanceStaleLinkOnlyVault = await createMaintenanceVaultForTest("codex-kb-maintain-stale-link-only-");
try {
  await mkdir(path.join(maintenanceStaleLinkOnlyVault, "wiki", "ai-intelligence", "references"), { recursive: true });
  await writeFile(path.join(maintenanceStaleLinkOnlyVault, "wiki", "ai-intelligence", "references", "stale-link.md"), [
    "# Stale Link",
    "",
    "历史来源：[[raw/articles/new]]",
    "",
    "旧正文，没有本轮消化。",
    ""
  ].join("\n"), "utf8");
  const { manager, settings } = makeKnowledgeBaseManagerForTest(maintenanceStaleLinkOnlyVault, {
    beforeAgentReturn: async () => {
      await writeFile(path.join(maintenanceStaleLinkOnlyVault, "wiki", "ai-intelligence", "references", "stale-link.md"), [
        "# Stale Link",
        "",
        "历史来源：[[raw/articles/new]]",
        "",
        "旧正文，没有本轮消化。",
        "",
        "Agent 只补了一条无关备注。",
        ""
      ].join("\n"), "utf8");
      const reportPath = path.join(maintenanceStaleLinkOnlyVault, "outputs", "maintenance", `kb-maintenance-${formatDateKeyForTest(new Date())}.md`);
      await mkdir(path.dirname(reportPath), { recursive: true });
      await writeFile(reportPath, [
        "---",
        "source: codex-echoink",
        "---",
        "",
        "# 知识库维护报告",
        "",
        "## 本轮来源",
        "- [[raw/articles/new]]",
        ""
      ].join("\n"), "utf8");
    }
  });
  const result = await manager.runMaintenance("maintain", "/maintain Agent 未新增来源证据不能提交 tracker");
  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /未写出结构层消化证据/);
  assert.deepEqual(Object.keys(settings.knowledgeBase.processedSources), []);
  assert.equal(await fileExists(path.join(maintenanceStaleLinkOnlyVault, "outputs", ".ingest-tracker.md")), false);
  const rediscovered = await discoverKnowledgeBaseSources(maintenanceStaleLinkOnlyVault, settings.knowledgeBase.processedSources);
  assert.equal(rediscovered.changedSources.some((source) => source.relativePath === "raw/articles/new.md"), true);
} finally {
  await rm(maintenanceStaleLinkOnlyVault, { recursive: true, force: true });
}

const maintenanceExistingPageNewEvidenceVault = await createMaintenanceVaultForTest("codex-kb-maintain-existing-new-evidence-");
try {
  await mkdir(path.join(maintenanceExistingPageNewEvidenceVault, "wiki", "ai-intelligence", "references"), { recursive: true });
  await writeFile(path.join(maintenanceExistingPageNewEvidenceVault, "wiki", "ai-intelligence", "references", "existing-page.md"), [
    "# Existing Page",
    "",
    "历史来源：[[raw/articles/new]]",
    "",
    "旧正文。",
    ""
  ].join("\n"), "utf8");
  const { manager, settings } = makeKnowledgeBaseManagerForTest(maintenanceExistingPageNewEvidenceVault, {
    beforeAgentReturn: async () => {
      await writeFile(path.join(maintenanceExistingPageNewEvidenceVault, "wiki", "ai-intelligence", "references", "existing-page.md"), [
        "# Existing Page",
        "",
        "历史来源：[[raw/articles/new]]",
        "",
        "旧正文。",
        "",
        "本轮来源：[[raw/articles/new]]",
        "核心要点：本轮新增正文已经消化进既有页面。",
        ""
      ].join("\n"), "utf8");
      const reportPath = path.join(maintenanceExistingPageNewEvidenceVault, "outputs", "maintenance", `kb-maintenance-${formatDateKeyForTest(new Date())}.md`);
      await mkdir(path.dirname(reportPath), { recursive: true });
      await writeFile(reportPath, [
        "---",
        "source: codex-echoink",
        "---",
        "",
        "# 知识库维护报告",
        "",
        "## 本轮来源",
        "- [[raw/articles/new]]",
        ""
      ].join("\n"), "utf8");
    }
  });
  const result = await manager.runMaintenance("maintain", "/maintain Agent 在既有正文页新增本轮来源证据");
  assert.equal(result.status, "success");
  assert.equal(result.processedSources.length, 1);
  assert.ok(settings.knowledgeBase.processedSources["raw/articles/new.md"]);
  const tracker = await readFile(path.join(maintenanceExistingPageNewEvidenceVault, "outputs", ".ingest-tracker.md"), "utf8");
  assert.ok(tracker.includes("raw/articles/new.md"));
} finally {
  await rm(maintenanceExistingPageNewEvidenceVault, { recursive: true, force: true });
}

const maintenanceStandardWikiPageDigestVault = await createMaintenanceVaultForTest("codex-kb-maintain-standard-wiki-page-");
try {
  const { manager, settings } = makeKnowledgeBaseManagerForTest(maintenanceStandardWikiPageDigestVault, {
    beforeAgentReturn: async () => {
      await mkdir(path.join(maintenanceStandardWikiPageDigestVault, "wiki", "ai-intelligence", "references"), { recursive: true });
      await writeFile(path.join(maintenanceStandardWikiPageDigestVault, "wiki", "ai-intelligence", "references", "standard-page.md"), [
        "---",
        "created: 2026-06-03",
        "updated: 2026-06-03T15:42",
        "---",
        "",
        "# Standard Page",
        "",
        "> 来源：[[raw/articles/new]]",
        "",
        "## 核心要点",
        "",
        "这份资料已经按标准 Wiki 页面格式消化进正文，来源行和正文之间允许有标题分隔。",
        ""
      ].join("\n"), "utf8");
      const reportPath = path.join(maintenanceStandardWikiPageDigestVault, "outputs", "maintenance", `kb-maintenance-${formatDateKeyForTest(new Date())}.md`);
      await mkdir(path.dirname(reportPath), { recursive: true });
      await writeFile(reportPath, [
        "---",
        "source: codex-echoink",
        "---",
        "",
        "# 知识库维护报告",
        "",
        "## 本轮来源",
        "- [[raw/articles/new]]",
        ""
      ].join("\n"), "utf8");
    }
  });
  const result = await manager.runMaintenance("maintain", "/maintain 标准 wiki 页顶部来源加正文可提交 tracker");
  assert.equal(result.status, "success");
  assert.equal(result.processedSources.length, 1);
  assert.ok(settings.knowledgeBase.processedSources["raw/articles/new.md"]?.fingerprint);
  const rediscovered = await discoverKnowledgeBaseSources(maintenanceStandardWikiPageDigestVault, settings.knowledgeBase.processedSources);
  assert.equal(rediscovered.changedSources.length, 0);
} finally {
  await rm(maintenanceStandardWikiPageDigestVault, { recursive: true, force: true });
}

const maintenanceLegacyDigestBackfillVault = await createMaintenanceVaultForTest("codex-kb-maintain-legacy-digest-backfill-");
try {
  await mkdir(path.join(maintenanceLegacyDigestBackfillVault, "wiki", "knowledge-workflow", "references"), { recursive: true });
  await writeFile(path.join(maintenanceLegacyDigestBackfillVault, "wiki", "knowledge-workflow", "references", "legacy-page.md"), [
    "# Legacy Page",
    "",
    "> 来源：[[raw/articles/new]]",
    "",
    "## 核心要点",
    "",
    "这份旧资料已经有正文消化证据，本轮只需要为旧 processed 记录补齐 fingerprint。",
    ""
  ].join("\n"), "utf8");
  const rawStat = await stat(path.join(maintenanceLegacyDigestBackfillVault, "raw", "articles", "new.md"));
  const { manager, settings } = makeKnowledgeBaseManagerForTest(maintenanceLegacyDigestBackfillVault, {
    beforeAgentReturn: async () => {
      const reportPath = path.join(maintenanceLegacyDigestBackfillVault, "outputs", "maintenance", `kb-maintenance-${formatDateKeyForTest(new Date())}.md`);
      await mkdir(path.dirname(reportPath), { recursive: true });
      await writeFile(reportPath, [
        "---",
        "source: codex-echoink",
        "---",
        "",
        "# 知识库维护报告",
        "",
        "## 本轮来源",
        "- [[raw/articles/new]]：旧正文页已复核，本轮补齐 fingerprint。",
        ""
      ].join("\n"), "utf8");
    }
  });
  settings.knowledgeBase.processedSources["raw/articles/new.md"] = {
    path: "raw/articles/new.md",
    size: rawStat.size,
    mtime: rawStat.mtimeMs,
    digestedAt: 100
  };
  const result = await manager.runMaintenance("maintain", "/maintain 旧 processed 记录补 fingerprint");
  assert.equal(result.status, "success");
  assert.equal(result.processedSources.length, 1);
  assert.match(settings.knowledgeBase.processedSources["raw/articles/new.md"]?.fingerprint ?? "", /^sha256:\d+:[a-f0-9]{64}$/);
  const rediscovered = await discoverKnowledgeBaseSources(maintenanceLegacyDigestBackfillVault, settings.knowledgeBase.processedSources);
  assert.equal(rediscovered.changedSources.length, 0);
} finally {
  await rm(maintenanceLegacyDigestBackfillVault, { recursive: true, force: true });
}

const maintenanceExistingDigestRepairVault = await createMaintenanceVaultForTest("codex-kb-maintain-existing-digest-repair-");
try {
  const rawPath = path.join(maintenanceExistingDigestRepairVault, "raw", "articles", "new.md");
  const rawTime = new Date(Date.now() - 60_000);
  await utimes(rawPath, rawTime, rawTime);
  await mkdir(path.join(maintenanceExistingDigestRepairVault, "wiki", "ai-intelligence", "references"), { recursive: true });
  const pagePath = path.join(maintenanceExistingDigestRepairVault, "wiki", "ai-intelligence", "references", "existing-digest.md");
  await writeFile(pagePath, [
    "# Existing Digest",
    "",
    "> 来源：[[raw/articles/new]]",
    "",
    "## 核心要点",
    "",
    "这份资料已经在上一次失败前写出正文证据，本轮可以据此修复 tracker 状态。",
    ""
  ].join("\n"), "utf8");
  const pageTime = new Date(Date.now() - 10_000);
  await utimes(pagePath, pageTime, pageTime);
  const { manager, settings } = makeKnowledgeBaseManagerForTest(maintenanceExistingDigestRepairVault, {
    beforeAgentReturn: async () => {
      const reportPath = path.join(maintenanceExistingDigestRepairVault, "outputs", "maintenance", `kb-maintenance-${formatDateKeyForTest(new Date())}.md`);
      await mkdir(path.dirname(reportPath), { recursive: true });
      await writeFile(reportPath, [
        "---",
        "source: codex-echoink",
        "---",
        "",
        "# 知识库维护报告",
        "",
        "## 本轮来源",
        "- [[raw/articles/new]]：已存在正文消化证据，本轮修复 tracker。",
        ""
      ].join("\n"), "utf8");
    }
  });
  const result = await manager.runMaintenance("maintain", "/maintain 已有正文证据修复 tracker");
  assert.equal(result.status, "success");
  assert.equal(result.processedSources.length, 1);
  assert.match(settings.knowledgeBase.processedSources["raw/articles/new.md"]?.fingerprint ?? "", /^sha256:\d+:[a-f0-9]{64}$/);
  const rediscovered = await discoverKnowledgeBaseSources(maintenanceExistingDigestRepairVault, settings.knowledgeBase.processedSources);
  assert.equal(rediscovered.changedSources.length, 0);
} finally {
  await rm(maintenanceExistingDigestRepairVault, { recursive: true, force: true });
}

const maintenanceExistingDigestOlderThanRawVault = await createMaintenanceVaultForTest("codex-kb-maintain-existing-digest-older-than-raw-");
try {
  const rawPath = path.join(maintenanceExistingDigestOlderThanRawVault, "raw", "articles", "new.md");
  await mkdir(path.join(maintenanceExistingDigestOlderThanRawVault, "wiki", "ai-intelligence", "references"), { recursive: true });
  const pagePath = path.join(maintenanceExistingDigestOlderThanRawVault, "wiki", "ai-intelligence", "references", "old-digest.md");
  await writeFile(pagePath, [
    "# Old Digest",
    "",
    "> 来源：[[raw/articles/new]]",
    "",
    "## 核心要点",
    "",
    "这份旧正文早于 raw 当前版本，不能用来修复 tracker。",
    ""
  ].join("\n"), "utf8");
  const baseTime = Date.now();
  const pageTime = new Date(baseTime - 120_000);
  const rawTime = new Date(baseTime - 10_000);
  await utimes(pagePath, pageTime, pageTime);
  await utimes(rawPath, rawTime, rawTime);
  const { manager, settings } = makeKnowledgeBaseManagerForTest(maintenanceExistingDigestOlderThanRawVault, {
    beforeAgentReturn: async () => {
      const reportPath = path.join(maintenanceExistingDigestOlderThanRawVault, "outputs", "maintenance", `kb-maintenance-${formatDateKeyForTest(new Date())}.md`);
      await mkdir(path.dirname(reportPath), { recursive: true });
      await writeFile(reportPath, [
        "---",
        "source: codex-echoink",
        "---",
        "",
        "# 知识库维护报告",
        "",
        "## 本轮来源",
        "- [[raw/articles/new]]：旧正文页早于 raw，不能修复 tracker。",
        ""
      ].join("\n"), "utf8");
    }
  });
  const result = await manager.runMaintenance("maintain", "/maintain 旧正文早于 raw 不能修复 tracker");
  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /未写出结构层消化证据/);
  assert.deepEqual(Object.keys(settings.knowledgeBase.processedSources), []);
  assert.equal(await fileExists(path.join(maintenanceExistingDigestOlderThanRawVault, "outputs", ".ingest-tracker.md")), false);
} finally {
  await rm(maintenanceExistingDigestOlderThanRawVault, { recursive: true, force: true });
}

const maintenanceLegacyMetadataDriftRepairVault = await createMaintenanceVaultForTest("codex-kb-maintain-legacy-metadata-drift-repair-");
try {
  const rawPath = path.join(maintenanceLegacyMetadataDriftRepairVault, "raw", "articles", "new.md");
  const rawTime = new Date(Date.now() - 60_000);
  await utimes(rawPath, rawTime, rawTime);
  await mkdir(path.join(maintenanceLegacyMetadataDriftRepairVault, "wiki", "knowledge-workflow", "references"), { recursive: true });
  const pagePath = path.join(maintenanceLegacyMetadataDriftRepairVault, "wiki", "knowledge-workflow", "references", "legacy-drift-page.md");
  await writeFile(pagePath, [
    "# Legacy Drift Page",
    "",
    "> 来源：[[raw/articles/new]]",
    "",
    "## 核心要点",
    "",
    "这份旧 processed 记录没有 fingerprint 且元数据漂移，但已有晚于 raw 的正文消化证据，可以修复 tracker。",
    ""
  ].join("\n"), "utf8");
  const pageTime = new Date(Date.now() - 10_000);
  await utimes(pagePath, pageTime, pageTime);
  const rawStat = await stat(rawPath);
  const { manager, settings } = makeKnowledgeBaseManagerForTest(maintenanceLegacyMetadataDriftRepairVault, {
    beforeAgentReturn: async () => {
      const reportPath = path.join(maintenanceLegacyMetadataDriftRepairVault, "outputs", "maintenance", `kb-maintenance-${formatDateKeyForTest(new Date())}.md`);
      await mkdir(path.dirname(reportPath), { recursive: true });
      await writeFile(reportPath, [
        "---",
        "source: codex-echoink",
        "---",
        "",
        "# 知识库维护报告",
        "",
        "## 本轮来源",
        "- [[raw/articles/new]]：已有晚于 raw 的正文证据，本轮修复漂移的旧 processed 记录。",
        ""
      ].join("\n"), "utf8");
    }
  });
  settings.knowledgeBase.processedSources["raw/articles/new.md"] = {
    path: "raw/articles/new.md",
    size: rawStat.size,
    mtime: rawStat.mtimeMs - 10_000,
    digestedAt: 100
  };
  const result = await manager.runMaintenance("maintain", "/maintain 旧 processed 元数据漂移但已有晚于 raw 的正文证据可修复");
  assert.equal(result.status, "success");
  assert.equal(result.processedSources.length, 1);
  assert.match(settings.knowledgeBase.processedSources["raw/articles/new.md"]?.fingerprint ?? "", /^sha256:\d+:[a-f0-9]{64}$/);
  const rediscovered = await discoverKnowledgeBaseSources(maintenanceLegacyMetadataDriftRepairVault, settings.knowledgeBase.processedSources);
  assert.equal(rediscovered.changedSources.length, 0);
} finally {
  await rm(maintenanceLegacyMetadataDriftRepairVault, { recursive: true, force: true });
}

const maintenanceLegacyDigestMtimeDriftVault = await createMaintenanceVaultForTest("codex-kb-maintain-legacy-digest-mtime-drift-");
try {
  await mkdir(path.join(maintenanceLegacyDigestMtimeDriftVault, "wiki", "knowledge-workflow", "references"), { recursive: true });
  const legacyDigestMtimeDriftPage = path.join(maintenanceLegacyDigestMtimeDriftVault, "wiki", "knowledge-workflow", "references", "legacy-page.md");
  await writeFile(legacyDigestMtimeDriftPage, [
    "# Legacy Page",
    "",
    "> 来源：[[raw/articles/new]]",
    "",
    "## 核心要点",
    "",
    "这份旧资料已有正文，但 raw 元数据漂移时不能直接复用旧证据。",
    ""
  ].join("\n"), "utf8");
  const legacyDigestMtimeDriftRaw = path.join(maintenanceLegacyDigestMtimeDriftVault, "raw", "articles", "new.md");
  const rawStat = await stat(legacyDigestMtimeDriftRaw);
  const legacyPageTime = new Date(Date.now() - 120_000);
  const legacyRawTime = new Date(Date.now() - 10_000);
  await utimes(legacyDigestMtimeDriftPage, legacyPageTime, legacyPageTime);
  await utimes(legacyDigestMtimeDriftRaw, legacyRawTime, legacyRawTime);
  const driftedRawStat = await stat(legacyDigestMtimeDriftRaw);
  const { manager, settings } = makeKnowledgeBaseManagerForTest(maintenanceLegacyDigestMtimeDriftVault, {
    beforeAgentReturn: async () => {
      await mkdir(path.join(maintenanceLegacyDigestMtimeDriftVault, "wiki", "ai-intelligence", "references"), { recursive: true });
      await writeFile(path.join(maintenanceLegacyDigestMtimeDriftVault, "wiki", "ai-intelligence", "references", "partial.md"), [
        "# Partial",
        "",
        "本轮来源：[[raw/articles/new]]",
        ""
      ].join("\n"), "utf8");
      const reportPath = path.join(maintenanceLegacyDigestMtimeDriftVault, "outputs", "maintenance", `kb-maintenance-${formatDateKeyForTest(new Date())}.md`);
      await mkdir(path.dirname(reportPath), { recursive: true });
      await writeFile(reportPath, [
        "---",
        "source: codex-echoink",
        "---",
        "",
        "# 知识库维护报告",
        "",
        "## 本轮来源",
        "- [[raw/articles/new]]",
        ""
      ].join("\n"), "utf8");
    }
  });
  settings.knowledgeBase.processedSources["raw/articles/new.md"] = {
    path: "raw/articles/new.md",
    size: driftedRawStat.size,
    mtime: driftedRawStat.mtimeMs - 10_000,
    digestedAt: 100
  };
  const result = await manager.runMaintenance("maintain", "/maintain raw 元数据漂移不能复用旧正文证据");
  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /未写出结构层消化证据/);
  assert.equal(await fileExists(path.join(maintenanceLegacyDigestMtimeDriftVault, "wiki", "ai-intelligence", "references", "partial.md")), false);
  assert.deepEqual(Object.keys(settings.knowledgeBase.processedSources), ["raw/articles/new.md"]);
  assert.equal(settings.knowledgeBase.processedSources["raw/articles/new.md"]?.fingerprint, undefined);
} finally {
  await rm(maintenanceLegacyDigestMtimeDriftVault, { recursive: true, force: true });
}

const maintenanceDatedAggregateDigestVault = await createMaintenanceVaultForTest("codex-kb-maintain-dated-aggregate-digest-");
try {
  await rm(path.join(maintenanceDatedAggregateDigestVault, "raw", "articles", "new.md"), { force: true });
  await mkdir(path.join(maintenanceDatedAggregateDigestVault, "raw", "articles", "Reddit社区洞察"), { recursive: true });
  await writeFile(path.join(maintenanceDatedAggregateDigestVault, "raw", "articles", "Reddit社区洞察", "2026-05-27 Reddit ObsidianMD 插件机会雷达日报.md"), "# 2026-05-27\n\n正文", "utf8");
  await writeFile(path.join(maintenanceDatedAggregateDigestVault, "raw", "articles", "Reddit社区洞察", "2026-05-28 Reddit ObsidianMD 插件机会雷达日报.md"), "# 2026-05-28\n\n正文", "utf8");
  await mkdir(path.join(maintenanceDatedAggregateDigestVault, "wiki", "knowledge-workflow", "references"), { recursive: true });
  await writeFile(path.join(maintenanceDatedAggregateDigestVault, "wiki", "knowledge-workflow", "references", "reddit-aggregate.md"), [
    "# Reddit Aggregate",
    "",
    "> 来源：",
    "> - [[raw/articles/Reddit社区洞察/2026-05-26 Reddit ObsidianMD 插件机会雷达日报]]",
    "",
    "## 日报结论 2026-05-26",
    "",
    "旧结论。",
    ""
  ].join("\n"), "utf8");
  const { manager, settings } = makeKnowledgeBaseManagerForTest(maintenanceDatedAggregateDigestVault, {
    beforeAgentReturn: async () => {
      await writeFile(path.join(maintenanceDatedAggregateDigestVault, "wiki", "knowledge-workflow", "references", "reddit-aggregate.md"), [
        "# Reddit Aggregate",
        "",
        "> 来源：",
        "> - [[raw/articles/Reddit社区洞察/2026-05-26 Reddit ObsidianMD 插件机会雷达日报]]",
        "> - [[raw/articles/Reddit社区洞察/2026-05-27 Reddit ObsidianMD 插件机会雷达日报]]",
        "> - [[raw/articles/Reddit社区洞察/2026-05-28 Reddit ObsidianMD 插件机会雷达日报]]",
        "",
        "## 日报结论 2026-05-26",
        "",
        "旧结论。",
        "",
        "## 日报结论 2026-05-27",
        "",
        "今天的新信号已经按日期独立消化进聚合页正文。",
        "",
        "## 日报结论 2026-05-28",
        "",
        "今天的新信号也已经按日期独立消化进聚合页正文。",
        ""
      ].join("\n"), "utf8");
      const reportPath = path.join(maintenanceDatedAggregateDigestVault, "outputs", "maintenance", `kb-maintenance-${formatDateKeyForTest(new Date())}.md`);
      await mkdir(path.dirname(reportPath), { recursive: true });
      await writeFile(reportPath, [
        "---",
        "source: codex-echoink",
        "---",
        "",
        "# 知识库维护报告",
        "",
        "## 本轮来源",
        "- [[raw/articles/Reddit社区洞察/2026-05-27 Reddit ObsidianMD 插件机会雷达日报]]",
        "- [[raw/articles/Reddit社区洞察/2026-05-28 Reddit ObsidianMD 插件机会雷达日报]]",
        ""
      ].join("\n"), "utf8");
    }
  });
  const result = await manager.runMaintenance("maintain", "/maintain 既有聚合页按日期新增来源和正文");
  assert.equal(result.status, "success");
  assert.equal(result.processedSources.length, 2);
  assert.ok(settings.knowledgeBase.processedSources["raw/articles/Reddit社区洞察/2026-05-27 Reddit ObsidianMD 插件机会雷达日报.md"]?.fingerprint);
  assert.ok(settings.knowledgeBase.processedSources["raw/articles/Reddit社区洞察/2026-05-28 Reddit ObsidianMD 插件机会雷达日报.md"]?.fingerprint);
} finally {
  await rm(maintenanceDatedAggregateDigestVault, { recursive: true, force: true });
}

const maintenanceDuplicateDigestLineVault = await createMaintenanceVaultForTest("codex-kb-maintain-duplicate-digest-line-");
try {
  await mkdir(path.join(maintenanceDuplicateDigestLineVault, "wiki", "ai-intelligence", "references"), { recursive: true });
  await writeFile(path.join(maintenanceDuplicateDigestLineVault, "wiki", "ai-intelligence", "references", "duplicate-digest.md"), [
    "# Duplicate Digest",
    "",
    "核心要点：这句模板摘要已经在旧段落出现。",
    ""
  ].join("\n"), "utf8");
  const { manager, settings } = makeKnowledgeBaseManagerForTest(maintenanceDuplicateDigestLineVault, {
    beforeAgentReturn: async () => {
      await writeFile(path.join(maintenanceDuplicateDigestLineVault, "wiki", "ai-intelligence", "references", "duplicate-digest.md"), [
        "# Duplicate Digest",
        "",
        "核心要点：这句模板摘要已经在旧段落出现。",
        "",
        "本轮来源：[[raw/articles/new]]",
        "核心要点：这句模板摘要已经在旧段落出现。",
        ""
      ].join("\n"), "utf8");
      const reportPath = path.join(maintenanceDuplicateDigestLineVault, "outputs", "maintenance", `kb-maintenance-${formatDateKeyForTest(new Date())}.md`);
      await mkdir(path.dirname(reportPath), { recursive: true });
      await writeFile(reportPath, [
        "---",
        "source: codex-echoink",
        "---",
        "",
        "# 知识库维护报告",
        "",
        "## 本轮来源",
        "- [[raw/articles/new]]",
        ""
      ].join("\n"), "utf8");
    }
  });
  const result = await manager.runMaintenance("maintain", "/maintain 新增的重复模板摘要也算本轮消化");
  assert.equal(result.status, "success");
  assert.equal(result.processedSources.length, 1);
  assert.ok(settings.knowledgeBase.processedSources["raw/articles/new.md"]);
  const rediscovered = await discoverKnowledgeBaseSources(maintenanceDuplicateDigestLineVault, settings.knowledgeBase.processedSources);
  assert.equal(rediscovered.changedSources.length, 0);
} finally {
  await rm(maintenanceDuplicateDigestLineVault, { recursive: true, force: true });
}

const maintenanceInsertedDuplicateSourceBlockVault = await createMaintenanceVaultForTest("codex-kb-maintain-inserted-duplicate-source-block-");
try {
  await mkdir(path.join(maintenanceInsertedDuplicateSourceBlockVault, "wiki", "ai-intelligence", "references"), { recursive: true });
  await writeFile(path.join(maintenanceInsertedDuplicateSourceBlockVault, "wiki", "ai-intelligence", "references", "inserted-duplicate-source.md"), [
    "# Inserted Duplicate Source",
    "",
    "来源：[[raw/articles/new]]",
    "旧正文。",
    ""
  ].join("\n"), "utf8");
  const { manager, settings } = makeKnowledgeBaseManagerForTest(maintenanceInsertedDuplicateSourceBlockVault, {
    beforeAgentReturn: async () => {
      await writeFile(path.join(maintenanceInsertedDuplicateSourceBlockVault, "wiki", "ai-intelligence", "references", "inserted-duplicate-source.md"), [
        "# Inserted Duplicate Source",
        "",
        "来源：[[raw/articles/new]]",
        "核心要点：本轮新增正文已经插入到旧来源块之前。",
        "",
        "来源：[[raw/articles/new]]",
        "旧正文。",
        ""
      ].join("\n"), "utf8");
      const reportPath = path.join(maintenanceInsertedDuplicateSourceBlockVault, "outputs", "maintenance", `kb-maintenance-${formatDateKeyForTest(new Date())}.md`);
      await mkdir(path.dirname(reportPath), { recursive: true });
      await writeFile(reportPath, [
        "---",
        "source: codex-echoink",
        "---",
        "",
        "# 知识库维护报告",
        "",
        "## 本轮来源",
        "- [[raw/articles/new]]",
        ""
      ].join("\n"), "utf8");
    }
  });
  const result = await manager.runMaintenance("maintain", "/maintain 插入到旧重复来源块前的新证据也要识别");
  assert.equal(result.status, "success");
  assert.equal(result.processedSources.length, 1);
  assert.ok(settings.knowledgeBase.processedSources["raw/articles/new.md"]);
  const rediscovered = await discoverKnowledgeBaseSources(maintenanceInsertedDuplicateSourceBlockVault, settings.knowledgeBase.processedSources);
  assert.equal(rediscovered.changedSources.length, 0);
} finally {
  await rm(maintenanceInsertedDuplicateSourceBlockVault, { recursive: true, force: true });
}

const maintenanceSourceLinkStubVault = await createMaintenanceVaultForTest("codex-kb-maintain-source-link-stub-");
try {
  const { manager, settings } = makeKnowledgeBaseManagerForTest(maintenanceSourceLinkStubVault, {
    beforeAgentReturn: async () => {
      await mkdir(path.join(maintenanceSourceLinkStubVault, "wiki", "ai-intelligence", "references"), { recursive: true });
      await writeFile(path.join(maintenanceSourceLinkStubVault, "wiki", "ai-intelligence", "references", "source-link-stub.md"), [
        "# Source Link Stub",
        "",
        "来源：[[raw/articles/new]]",
        ""
      ].join("\n"), "utf8");
      const reportPath = path.join(maintenanceSourceLinkStubVault, "outputs", "maintenance", `kb-maintenance-${formatDateKeyForTest(new Date())}.md`);
      await mkdir(path.dirname(reportPath), { recursive: true });
      await writeFile(reportPath, [
        "---",
        "source: codex-echoink",
        "---",
        "",
        "# 知识库维护报告",
        "",
        "## 本轮来源",
        "- [[raw/articles/new]]",
        ""
      ].join("\n"), "utf8");
    }
  });
  const result = await manager.runMaintenance("maintain", "/maintain Agent 只建来源链接空壳页不能提交 tracker");
  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /未写出结构层消化证据/);
  assert.deepEqual(Object.keys(settings.knowledgeBase.processedSources), []);
  assert.equal(await fileExists(path.join(maintenanceSourceLinkStubVault, "outputs", ".ingest-tracker.md")), false);
  const rediscovered = await discoverKnowledgeBaseSources(maintenanceSourceLinkStubVault, settings.knowledgeBase.processedSources);
  assert.equal(rediscovered.changedSources.some((source) => source.relativePath === "raw/articles/new.md"), true);
} finally {
  await rm(maintenanceSourceLinkStubVault, { recursive: true, force: true });
}

const maintenanceMarkdownSourceLabelStubVault = await createMaintenanceVaultForTest("codex-kb-maintain-markdown-link-label-stub-");
try {
  const { manager, settings } = makeKnowledgeBaseManagerForTest(maintenanceMarkdownSourceLabelStubVault, {
    beforeAgentReturn: async () => {
      await mkdir(path.join(maintenanceMarkdownSourceLabelStubVault, "wiki", "ai-intelligence", "references"), { recursive: true });
      await writeFile(path.join(maintenanceMarkdownSourceLabelStubVault, "wiki", "ai-intelligence", "references", "markdown-link-label-stub.md"), [
        "# Markdown Link Label Stub",
        "",
        "来源：[这是一篇特别长特别长但仍只是标题的资料](raw/articles/new.md)",
        ""
      ].join("\n"), "utf8");
      const reportPath = path.join(maintenanceMarkdownSourceLabelStubVault, "outputs", "maintenance", `kb-maintenance-${formatDateKeyForTest(new Date())}.md`);
      await mkdir(path.dirname(reportPath), { recursive: true });
      await writeFile(reportPath, [
        "---",
        "source: codex-echoink",
        "---",
        "",
        "# 知识库维护报告",
        "",
        "## 本轮来源",
        "- [这是一篇特别长特别长但仍只是标题的资料](raw/articles/new.md)",
        ""
      ].join("\n"), "utf8");
    }
  });
  const result = await manager.runMaintenance("maintain", "/maintain Markdown 来源链接标题不能冒充摘要");
  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /未写出结构层消化证据/);
  assert.deepEqual(Object.keys(settings.knowledgeBase.processedSources), []);
  assert.equal(await fileExists(path.join(maintenanceMarkdownSourceLabelStubVault, "outputs", ".ingest-tracker.md")), false);
  const rediscovered = await discoverKnowledgeBaseSources(maintenanceMarkdownSourceLabelStubVault, settings.knowledgeBase.processedSources);
  assert.equal(rediscovered.changedSources.some((source) => source.relativePath === "raw/articles/new.md"), true);
} finally {
  await rm(maintenanceMarkdownSourceLabelStubVault, { recursive: true, force: true });
}

const maintenanceFrontmatterOnlyDigestVault = await createMaintenanceVaultForTest("codex-kb-maintain-frontmatter-only-digest-");
try {
  const { manager, settings } = makeKnowledgeBaseManagerForTest(maintenanceFrontmatterOnlyDigestVault, {
    beforeAgentReturn: async () => {
      await mkdir(path.join(maintenanceFrontmatterOnlyDigestVault, "wiki", "ai-intelligence", "references"), { recursive: true });
      await writeFile(path.join(maintenanceFrontmatterOnlyDigestVault, "wiki", "ai-intelligence", "references", "frontmatter-only-digest.md"), [
        "---",
        "source: raw/articles/new.md",
        "summary: 核心要点：这段只在 frontmatter 元数据里，不能证明正文已经消化。",
        "---",
        "# Frontmatter Only Digest",
        ""
      ].join("\n"), "utf8");
      const reportPath = path.join(maintenanceFrontmatterOnlyDigestVault, "outputs", "maintenance", `kb-maintenance-${formatDateKeyForTest(new Date())}.md`);
      await mkdir(path.dirname(reportPath), { recursive: true });
      await writeFile(reportPath, [
        "---",
        "source: codex-echoink",
        "---",
        "",
        "# 知识库维护报告",
        "",
        "## 本轮来源",
        "- raw/articles/new.md",
        ""
      ].join("\n"), "utf8");
    }
  });
  const result = await manager.runMaintenance("maintain", "/maintain frontmatter 元数据不能冒充正文消化");
  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /未写出结构层消化证据/);
  assert.deepEqual(Object.keys(settings.knowledgeBase.processedSources), []);
  assert.equal(await fileExists(path.join(maintenanceFrontmatterOnlyDigestVault, "outputs", ".ingest-tracker.md")), false);
  const rediscovered = await discoverKnowledgeBaseSources(maintenanceFrontmatterOnlyDigestVault, settings.knowledgeBase.processedSources);
  assert.equal(rediscovered.changedSources.some((source) => source.relativePath === "raw/articles/new.md"), true);
} finally {
  await rm(maintenanceFrontmatterOnlyDigestVault, { recursive: true, force: true });
}

const maintenanceCodeBlockOnlyDigestVault = await createMaintenanceVaultForTest("codex-kb-maintain-code-block-only-digest-");
try {
  const { manager, settings } = makeKnowledgeBaseManagerForTest(maintenanceCodeBlockOnlyDigestVault, {
    beforeAgentReturn: async () => {
      await mkdir(path.join(maintenanceCodeBlockOnlyDigestVault, "wiki", "ai-intelligence", "references"), { recursive: true });
      await writeFile(path.join(maintenanceCodeBlockOnlyDigestVault, "wiki", "ai-intelligence", "references", "code-block-only-digest.md"), [
        "# Code Block Only Digest",
        "",
        "```markdown",
        "来源：[[raw/articles/new]]",
        "核心要点：这段只在代码块示例里，不能证明正文已经消化。",
        "```",
        ""
      ].join("\n"), "utf8");
      const reportPath = path.join(maintenanceCodeBlockOnlyDigestVault, "outputs", "maintenance", `kb-maintenance-${formatDateKeyForTest(new Date())}.md`);
      await mkdir(path.dirname(reportPath), { recursive: true });
      await writeFile(reportPath, [
        "---",
        "source: codex-echoink",
        "---",
        "",
        "# 知识库维护报告",
        "",
        "## 本轮来源",
        "- [[raw/articles/new]]",
        ""
      ].join("\n"), "utf8");
    }
  });
  const result = await manager.runMaintenance("maintain", "/maintain 代码块示例不能冒充正文消化");
  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /未写出结构层消化证据/);
  assert.deepEqual(Object.keys(settings.knowledgeBase.processedSources), []);
  assert.equal(await fileExists(path.join(maintenanceCodeBlockOnlyDigestVault, "outputs", ".ingest-tracker.md")), false);
  const rediscovered = await discoverKnowledgeBaseSources(maintenanceCodeBlockOnlyDigestVault, settings.knowledgeBase.processedSources);
  assert.equal(rediscovered.changedSources.some((source) => source.relativePath === "raw/articles/new.md"), true);
} finally {
  await rm(maintenanceCodeBlockOnlyDigestVault, { recursive: true, force: true });
}

const maintenanceSeparatedDigestVault = await createMaintenanceVaultForTest("codex-kb-maintain-separated-digest-");
try {
  const { manager, settings } = makeKnowledgeBaseManagerForTest(maintenanceSeparatedDigestVault, {
    beforeAgentReturn: async () => {
      await mkdir(path.join(maintenanceSeparatedDigestVault, "wiki", "ai-intelligence", "references"), { recursive: true });
      await writeFile(path.join(maintenanceSeparatedDigestVault, "wiki", "ai-intelligence", "references", "separated-digest.md"), [
        "# Separated Digest",
        "",
        "本轮来源：[[raw/articles/new]]",
        "",
        "## 无关段落",
        "核心要点：这行只是另一个段落的正文，不能证明来源已经被消化。",
        ""
      ].join("\n"), "utf8");
      const reportPath = path.join(maintenanceSeparatedDigestVault, "outputs", "maintenance", `kb-maintenance-${formatDateKeyForTest(new Date())}.md`);
      await mkdir(path.dirname(reportPath), { recursive: true });
      await writeFile(reportPath, [
        "---",
        "source: codex-echoink",
        "---",
        "",
        "# 知识库维护报告",
        "",
        "## 本轮来源",
        "- [[raw/articles/new]]",
        ""
      ].join("\n"), "utf8");
    }
  });
  const result = await manager.runMaintenance("maintain", "/maintain 来源和正文跨段不能提交 tracker");
  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /未写出结构层消化证据/);
  assert.deepEqual(Object.keys(settings.knowledgeBase.processedSources), []);
  assert.equal(await fileExists(path.join(maintenanceSeparatedDigestVault, "outputs", ".ingest-tracker.md")), false);
  const rediscovered = await discoverKnowledgeBaseSources(maintenanceSeparatedDigestVault, settings.knowledgeBase.processedSources);
  assert.equal(rediscovered.changedSources.some((source) => source.relativePath === "raw/articles/new.md"), true);
} finally {
  await rm(maintenanceSeparatedDigestVault, { recursive: true, force: true });
}

const maintenanceSourceExtraExtensionVault = await createMaintenanceVaultForTest("codex-kb-maintain-source-extra-extension-");
try {
  const { manager, settings } = makeKnowledgeBaseManagerForTest(maintenanceSourceExtraExtensionVault, {
    beforeAgentReturn: async () => {
      await mkdir(path.join(maintenanceSourceExtraExtensionVault, "wiki", "ai-intelligence", "references"), { recursive: true });
      await writeFile(path.join(maintenanceSourceExtraExtensionVault, "wiki", "ai-intelligence", "references", "extra-extension.md"), [
        "# Extra Extension",
        "",
        "本轮来源：[[raw/articles/new.md.bak]]",
        "核心要点：这里只提到了另一个更长文件名，不能证明 new.md 已经被消化。",
        ""
      ].join("\n"), "utf8");
      const reportPath = path.join(maintenanceSourceExtraExtensionVault, "outputs", "maintenance", `kb-maintenance-${formatDateKeyForTest(new Date())}.md`);
      await mkdir(path.dirname(reportPath), { recursive: true });
      await writeFile(reportPath, [
        "---",
        "source: codex-echoink",
        "---",
        "",
        "# 知识库维护报告",
        "",
        "## 本轮来源",
        "- [[raw/articles/new.md.bak]]",
        ""
      ].join("\n"), "utf8");
    }
  });
  const result = await manager.runMaintenance("maintain", "/maintain 更长扩展名路径不能冒充来源");
  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /raw\/articles\/new\.md/);
  assert.deepEqual(Object.keys(settings.knowledgeBase.processedSources), []);
  assert.equal(await fileExists(path.join(maintenanceSourceExtraExtensionVault, "outputs", ".ingest-tracker.md")), false);
  const rediscovered = await discoverKnowledgeBaseSources(maintenanceSourceExtraExtensionVault, settings.knowledgeBase.processedSources);
  assert.equal(rediscovered.changedSources.some((source) => source.relativePath === "raw/articles/new.md"), true);
} finally {
  await rm(maintenanceSourceExtraExtensionVault, { recursive: true, force: true });
}

const maintenanceEncodedSourceLinkVault = await createMaintenanceVaultForTest("codex-kb-maintain-encoded-source-");
try {
  await rm(path.join(maintenanceEncodedSourceLinkVault, "raw", "articles", "new.md"), { force: true });
  await writeFile(path.join(maintenanceEncodedSourceLinkVault, "raw", "articles", "AI 笔记.md"), "# AI 笔记\n\n带空格和中文文件名。", "utf8");
  const { manager, settings } = makeKnowledgeBaseManagerForTest(maintenanceEncodedSourceLinkVault, {
    beforeAgentReturn: async () => {
      await mkdir(path.join(maintenanceEncodedSourceLinkVault, "wiki", "ai-intelligence", "references"), { recursive: true });
      await writeFile(path.join(maintenanceEncodedSourceLinkVault, "wiki", "ai-intelligence", "references", "encoded-source.md"), [
        "# Encoded Source",
        "",
        "来源：[AI 笔记](raw/articles/AI%20%E7%AC%94%E8%AE%B0.md)",
        "核心要点：URL 编码来源链接已经消化进知识页。",
        ""
      ].join("\n"), "utf8");
      const reportPath = path.join(maintenanceEncodedSourceLinkVault, "outputs", "maintenance", `kb-maintenance-${formatDateKeyForTest(new Date())}.md`);
      await mkdir(path.dirname(reportPath), { recursive: true });
      await writeFile(reportPath, [
        "---",
        "source: codex-echoink",
        "---",
        "",
        "# 知识库维护报告",
        "",
        "## 本轮来源",
        "- [AI 笔记](raw/articles/AI%20%E7%AC%94%E8%AE%B0.md)",
        ""
      ].join("\n"), "utf8");
    }
  });
  const result = await manager.runMaintenance("maintain", "/maintain URL 编码来源链接可以提交 tracker");
  assert.equal(result.status, "success");
  assert.equal(result.processedSources.length, 1);
  assert.ok(settings.knowledgeBase.processedSources["raw/articles/AI 笔记.md"]);
  const rediscovered = await discoverKnowledgeBaseSources(maintenanceEncodedSourceLinkVault, settings.knowledgeBase.processedSources);
  assert.equal(rediscovered.changedSources.length, 0);
} finally {
  await rm(maintenanceEncodedSourceLinkVault, { recursive: true, force: true });
}

const maintenanceLowercaseEncodedSourceLinkVault = await createMaintenanceVaultForTest("codex-kb-maintain-lowercase-encoded-source-");
try {
  await rm(path.join(maintenanceLowercaseEncodedSourceLinkVault, "raw", "articles", "new.md"), { force: true });
  await writeFile(path.join(maintenanceLowercaseEncodedSourceLinkVault, "raw", "articles", "AI 笔记.md"), "# AI 笔记\n\n带空格和中文文件名。", "utf8");
  const { manager, settings } = makeKnowledgeBaseManagerForTest(maintenanceLowercaseEncodedSourceLinkVault, {
    beforeAgentReturn: async () => {
      await mkdir(path.join(maintenanceLowercaseEncodedSourceLinkVault, "wiki", "ai-intelligence", "references"), { recursive: true });
      await writeFile(path.join(maintenanceLowercaseEncodedSourceLinkVault, "wiki", "ai-intelligence", "references", "lowercase-encoded-source.md"), [
        "# Lowercase Encoded Source",
        "",
        "来源：[AI 笔记](raw/articles/AI%20%e7%ac%94%e8%ae%b0.md)",
        "核心要点：小写 URL 编码来源链接已经消化进知识页。",
        ""
      ].join("\n"), "utf8");
      const reportPath = path.join(maintenanceLowercaseEncodedSourceLinkVault, "outputs", "maintenance", `kb-maintenance-${formatDateKeyForTest(new Date())}.md`);
      await mkdir(path.dirname(reportPath), { recursive: true });
      await writeFile(reportPath, [
        "---",
        "source: codex-echoink",
        "---",
        "",
        "# 知识库维护报告",
        "",
        "## 本轮来源",
        "- [AI 笔记](raw/articles/AI%20%e7%ac%94%e8%ae%b0.md)",
        ""
      ].join("\n"), "utf8");
    }
  });
  const result = await manager.runMaintenance("maintain", "/maintain 小写 URL 编码来源链接可以提交 tracker");
  assert.equal(result.status, "success");
  assert.equal(result.processedSources.length, 1);
  assert.ok(settings.knowledgeBase.processedSources["raw/articles/AI 笔记.md"]);
  const rediscovered = await discoverKnowledgeBaseSources(maintenanceLowercaseEncodedSourceLinkVault, settings.knowledgeBase.processedSources);
  assert.equal(rediscovered.changedSources.length, 0);
} finally {
  await rm(maintenanceLowercaseEncodedSourceLinkVault, { recursive: true, force: true });
}

const maintenanceBareSourceDigestVault = await createMaintenanceVaultForTest("codex-kb-maintain-bare-source-digest-");
try {
  const { manager, settings } = makeKnowledgeBaseManagerForTest(maintenanceBareSourceDigestVault, {
    beforeAgentReturn: async () => {
      await mkdir(path.join(maintenanceBareSourceDigestVault, "wiki", "ai-intelligence", "references"), { recursive: true });
      await writeFile(path.join(maintenanceBareSourceDigestVault, "wiki", "ai-intelligence", "references", "bare-source-digest.md"), [
        "# Bare Source Digest",
        "",
        "- raw/articles/new.md：核心要点：裸路径来源行自身已经包含本轮消化正文。",
        ""
      ].join("\n"), "utf8");
      const reportPath = path.join(maintenanceBareSourceDigestVault, "outputs", "maintenance", `kb-maintenance-${formatDateKeyForTest(new Date())}.md`);
      await mkdir(path.dirname(reportPath), { recursive: true });
      await writeFile(reportPath, [
        "---",
        "source: codex-echoink",
        "---",
        "",
        "# 知识库维护报告",
        "",
        "## 本轮来源",
        "- raw/articles/new.md：已纳入维护",
        ""
      ].join("\n"), "utf8");
    }
  });
  const result = await manager.runMaintenance("maintain", "/maintain 裸路径来源行摘要可以提交 tracker");
  assert.equal(result.status, "success");
  assert.equal(result.processedSources.length, 1);
  assert.ok(settings.knowledgeBase.processedSources["raw/articles/new.md"]);
  const rediscovered = await discoverKnowledgeBaseSources(maintenanceBareSourceDigestVault, settings.knowledgeBase.processedSources);
  assert.equal(rediscovered.changedSources.length, 0);
} finally {
  await rm(maintenanceBareSourceDigestVault, { recursive: true, force: true });
}

const maintenanceBareSourceAfterColonVault = await createMaintenanceVaultForTest("codex-kb-maintain-bare-source-after-colon-");
try {
  const { manager, settings } = makeKnowledgeBaseManagerForTest(maintenanceBareSourceAfterColonVault, {
    beforeAgentReturn: async () => {
      await mkdir(path.join(maintenanceBareSourceAfterColonVault, "wiki", "ai-intelligence", "references"), { recursive: true });
      await writeFile(path.join(maintenanceBareSourceAfterColonVault, "wiki", "ai-intelligence", "references", "bare-source-after-colon.md"), [
        "# Bare Source After Colon",
        "",
        "来源：raw/articles/new.md：核心要点：中文冒号后的裸路径来源行已经包含本轮消化正文。",
        ""
      ].join("\n"), "utf8");
      const reportPath = path.join(maintenanceBareSourceAfterColonVault, "outputs", "maintenance", `kb-maintenance-${formatDateKeyForTest(new Date())}.md`);
      await mkdir(path.dirname(reportPath), { recursive: true });
      await writeFile(reportPath, [
        "---",
        "source: codex-echoink",
        "---",
        "",
        "# 知识库维护报告",
        "",
        "## 本轮来源",
        "- raw/articles/new.md：已纳入维护",
        ""
      ].join("\n"), "utf8");
    }
  });
  const result = await manager.runMaintenance("maintain", "/maintain 中文冒号后的裸路径来源行可以提交 tracker");
  assert.equal(result.status, "success");
  assert.equal(result.processedSources.length, 1);
  assert.ok(settings.knowledgeBase.processedSources["raw/articles/new.md"]);
  const rediscovered = await discoverKnowledgeBaseSources(maintenanceBareSourceAfterColonVault, settings.knowledgeBase.processedSources);
  assert.equal(rediscovered.changedSources.length, 0);
} finally {
  await rm(maintenanceBareSourceAfterColonVault, { recursive: true, force: true });
}

const maintenanceAbsoluteSourcePathVault = await createMaintenanceVaultForTest("codex-kb-maintain-absolute-source-path-");
try {
  const absoluteRawPath = path.join(maintenanceAbsoluteSourcePathVault, "raw", "articles", "new.md");
  const { manager, settings } = makeKnowledgeBaseManagerForTest(maintenanceAbsoluteSourcePathVault, {
    beforeAgentReturn: async () => {
      await mkdir(path.join(maintenanceAbsoluteSourcePathVault, "wiki", "ai-intelligence", "references"), { recursive: true });
      await writeFile(path.join(maintenanceAbsoluteSourcePathVault, "wiki", "ai-intelligence", "references", "absolute-source-path.md"), [
        "# Absolute Source Path",
        "",
        `来源：${absoluteRawPath}`,
        "核心要点：绝对路径来源行已经消化进知识页。",
        ""
      ].join("\n"), "utf8");
      const reportPath = path.join(maintenanceAbsoluteSourcePathVault, "outputs", "maintenance", `kb-maintenance-${formatDateKeyForTest(new Date())}.md`);
      await mkdir(path.dirname(reportPath), { recursive: true });
      await writeFile(reportPath, [
        "---",
        "source: codex-echoink",
        "---",
        "",
        "# 知识库维护报告",
        "",
        "## 本轮来源",
        `- ${absoluteRawPath}`,
        ""
      ].join("\n"), "utf8");
    }
  });
  const result = await manager.runMaintenance("maintain", "/maintain 绝对路径来源行可以提交 tracker");
  assert.equal(result.status, "success");
  assert.equal(result.processedSources.length, 1);
  assert.ok(settings.knowledgeBase.processedSources["raw/articles/new.md"]);
  const rediscovered = await discoverKnowledgeBaseSources(maintenanceAbsoluteSourcePathVault, settings.knowledgeBase.processedSources);
  assert.equal(rediscovered.changedSources.length, 0);
} finally {
  await rm(maintenanceAbsoluteSourcePathVault, { recursive: true, force: true });
}

const maintenancePartialBatchDigestVault = await createMaintenanceVaultForTest("codex-kb-maintain-partial-batch-digest-");
try {
  await writeFile(path.join(maintenancePartialBatchDigestVault, "raw", "articles", "second.md"), "# Second\n\n第二份正文", "utf8");
  const { manager, settings } = makeKnowledgeBaseManagerForTest(maintenancePartialBatchDigestVault, {
    beforeAgentReturn: async () => {
      await mkdir(path.join(maintenancePartialBatchDigestVault, "wiki", "ai-intelligence", "references"), { recursive: true });
      await writeFile(path.join(maintenancePartialBatchDigestVault, "wiki", "ai-intelligence", "references", "partial-batch.md"), [
        "# Partial Batch",
        "",
        "本轮来源：[[raw/articles/new]]",
        "核心要点：第一份新增正文已经消化进批次页面。",
        "",
        "本轮来源：[[raw/articles/second]]",
        ""
      ].join("\n"), "utf8");
      const reportPath = path.join(maintenancePartialBatchDigestVault, "outputs", "maintenance", `kb-maintenance-${formatDateKeyForTest(new Date())}.md`);
      await mkdir(path.dirname(reportPath), { recursive: true });
      await writeFile(reportPath, [
        "---",
        "source: codex-echoink",
        "---",
        "",
        "# 知识库维护报告",
        "",
        "## 本轮来源",
        "- [[raw/articles/new]]",
        "- [[raw/articles/second]]",
        ""
      ].join("\n"), "utf8");
    }
  });
  const result = await manager.runMaintenance("maintain", "/maintain Agent 只消化批次部分 raw 不能提交 tracker");
  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /未写出结构层消化证据/);
  assert.deepEqual(Object.keys(settings.knowledgeBase.processedSources), []);
  assert.equal(await fileExists(path.join(maintenancePartialBatchDigestVault, "outputs", ".ingest-tracker.md")), false);
  const rediscovered = await discoverKnowledgeBaseSources(maintenancePartialBatchDigestVault, settings.knowledgeBase.processedSources);
  assert.equal(rediscovered.changedSources.some((source) => source.relativePath === "raw/articles/new.md"), true);
  assert.equal(rediscovered.changedSources.some((source) => source.relativePath === "raw/articles/second.md"), true);
} finally {
  await rm(maintenancePartialBatchDigestVault, { recursive: true, force: true });
}

const maintenanceSourcePrefixVault = await createMaintenanceVaultForTest("codex-kb-maintain-source-prefix-");
try {
  await writeFile(path.join(maintenanceSourcePrefixVault, "raw", "articles", "newer.md"), "# Newer\n\n更长文件名正文", "utf8");
  const { manager, settings } = makeKnowledgeBaseManagerForTest(maintenanceSourcePrefixVault, {
    beforeAgentReturn: async () => {
      await mkdir(path.join(maintenanceSourcePrefixVault, "wiki", "ai-intelligence", "references"), { recursive: true });
      await writeFile(path.join(maintenanceSourcePrefixVault, "wiki", "ai-intelligence", "references", "newer-only.md"), [
        "# Newer Only",
        "",
        "本轮来源：[[raw/articles/newer]]",
        "核心要点：只消化了更长文件名资料。",
        ""
      ].join("\n"), "utf8");
      const reportPath = path.join(maintenanceSourcePrefixVault, "outputs", "maintenance", `kb-maintenance-${formatDateKeyForTest(new Date())}.md`);
      await mkdir(path.dirname(reportPath), { recursive: true });
      await writeFile(reportPath, [
        "---",
        "source: codex-echoink",
        "---",
        "",
        "# 知识库维护报告",
        "",
        "## 本轮来源",
        "- [[raw/articles/newer]]",
        ""
      ].join("\n"), "utf8");
    }
  });
  const result = await manager.runMaintenance("maintain", "/maintain raw 路径前缀不能冒充来源");
  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /raw\/articles\/new\.md/);
  assert.deepEqual(Object.keys(settings.knowledgeBase.processedSources), []);
  assert.equal(await fileExists(path.join(maintenanceSourcePrefixVault, "outputs", ".ingest-tracker.md")), false);
  const rediscovered = await discoverKnowledgeBaseSources(maintenanceSourcePrefixVault, settings.knowledgeBase.processedSources);
  assert.equal(rediscovered.changedSources.some((source) => source.relativePath === "raw/articles/new.md"), true);
  assert.equal(rediscovered.changedSources.some((source) => source.relativePath === "raw/articles/newer.md"), true);
} finally {
  await rm(maintenanceSourcePrefixVault, { recursive: true, force: true });
}

const maintenanceSuccessVault = await createMaintenanceVaultForTest("codex-kb-maintain-success-");
try {
  const rawBeforeMaintain = await readFile(path.join(maintenanceSuccessVault, "raw", "articles", "new.md"));
  const { manager, settings } = makeKnowledgeBaseManagerForTest(maintenanceSuccessVault, {
    beforeAgentReturn: async () => {
      await mkdir(path.join(maintenanceSuccessVault, "wiki", "ai-intelligence", "references"), { recursive: true });
      await writeFile(path.join(maintenanceSuccessVault, "wiki", "ai-intelligence", "references", "maintain-success.md"), [
        "# Maintain Success",
        "",
        "来源：[[raw/articles/new]]",
        "核心要点：本轮新增正文已经消化进成功路径知识页。",
        ""
      ].join("\n"), "utf8");
      const reportPath = path.join(maintenanceSuccessVault, "outputs", "maintenance", `kb-maintenance-${formatDateKeyForTest(new Date())}.md`);
      await mkdir(path.dirname(reportPath), { recursive: true });
      await writeFile(reportPath, [
        "---",
        "source: codex-echoink",
        "---",
        "",
        "# 知识库维护报告",
        "",
        "## 本轮来源",
        "- [[raw/articles/new]]",
        ""
      ].join("\n"), "utf8");
    }
  });
  const result = await manager.runMaintenance("maintain", "/maintain 测试成功提交");
  assert.equal(result.status, "success");
  assert.equal(result.processedSources.length, 1);
  const processed = settings.knowledgeBase.processedSources["raw/articles/new.md"];
  assert.ok(processed);
  assert.match(processed.fingerprint ?? "", /^sha256:\d+:[a-f0-9]{64}$/);
  assert.ok(processed.fingerprint);
  const processedFingerprint = processed.fingerprint;
  const rawAfterMaintain = await readFile(path.join(maintenanceSuccessVault, "raw", "articles", "new.md"));
  assert.notDeepEqual(rawAfterMaintain, rawBeforeMaintain);
  assert.ok(rawAfterMaintain.toString("utf8").includes(rawBeforeMaintain.toString("utf8")));
  const rawDigestAfterMaintain = rawDigestRecordFromMarkdown(rawAfterMaintain);
  assert.equal(rawDigestRecordIsTrusted(rawDigestAfterMaintain, processedFingerprint), true);
  assert.deepEqual(rawDigestAfterMaintain?.evidencePaths, ["wiki/ai-intelligence/references/maintain-success.md"]);
  assert.equal(rawDigestFingerprint("raw/articles/new.md", rawAfterMaintain), processedFingerprint);
  const rawRegistryAfterMaintain = await readRawDigestRegistry(maintenanceSuccessVault);
  assert.equal(rawRegistryAfterMaintain.entries["raw/articles/new.md"]?.fingerprint, processedFingerprint);
  const tracker = await readFile(path.join(maintenanceSuccessVault, "outputs", ".ingest-tracker.md"), "utf8");
  assert.ok(tracker.includes("raw/articles/new.md"));
  assert.ok(tracker.includes(`fingerprint=${processedFingerprint}`));
  assert.ok((await readFile(path.join(maintenanceSuccessVault, "wiki", "ai-intelligence", "references", "maintain-success.md"), "utf8")).includes("[[raw/articles/new]]"));
  const rediscovered = await discoverKnowledgeBaseSources(maintenanceSuccessVault, settings.knowledgeBase.processedSources);
  assert.equal(rediscovered.changedSources.length, 0);
} finally {
  await rm(maintenanceSuccessVault, { recursive: true, force: true });
}

const maintenanceConcurrentRawAddVault = await createMaintenanceVaultForTest("codex-kb-maintain-concurrent-raw-add-");
try {
  const concurrentRaw = path.join(maintenanceConcurrentRawAddVault, "raw", "articles", "GitHub项目收集", "2026-06-03 GitHub 热门项目简报.md");
  const { manager, settings } = makeKnowledgeBaseManagerForTest(maintenanceConcurrentRawAddVault, {
    beforeAgentReturn: async () => {
      await mkdir(path.dirname(concurrentRaw), { recursive: true });
      await writeFile(concurrentRaw, "# 2026-06-03 GitHub 热门项目简报\n\n外部自动化新增。", "utf8");
      await mkdir(path.join(maintenanceConcurrentRawAddVault, "wiki", "ai-intelligence", "references"), { recursive: true });
      await writeFile(path.join(maintenanceConcurrentRawAddVault, "wiki", "ai-intelligence", "references", "maintain-concurrent.md"), [
        "# Maintain Concurrent",
        "",
        "- [[raw/articles/new]]：核心要点：本轮原始资料已经提炼，运行中新出现的 GitHub raw 留到下次维护。",
        ""
      ].join("\n"), "utf8");
      const reportPath = path.join(maintenanceConcurrentRawAddVault, "outputs", "maintenance", `kb-maintenance-${formatDateKeyForTest(new Date())}.md`);
      await mkdir(path.dirname(reportPath), { recursive: true });
      await writeFile(reportPath, [
        "---",
        "source: codex-echoink",
        "---",
        "",
        "# 知识库维护报告",
        "",
        "## 本轮来源",
        "- [[raw/articles/new]]",
        ""
      ].join("\n"), "utf8");
    }
  });
  const result = await manager.runMaintenance("maintain", "/maintain 测试外部自动化并发新增 raw");
  assert.equal(result.status, "success");
  assert.equal(result.processedSources.length, 1);
  assert.equal(result.processedSources[0]?.relativePath, "raw/articles/new.md");
  assert.equal(Object.keys(settings.knowledgeBase.processedSources).includes("raw/articles/GitHub项目收集/2026-06-03 GitHub 热门项目简报.md"), false);
  assert.equal(await readFile(concurrentRaw, "utf8"), "# 2026-06-03 GitHub 热门项目简报\n\n外部自动化新增。");
  const tracker = await readFile(path.join(maintenanceConcurrentRawAddVault, "outputs", ".ingest-tracker.md"), "utf8");
  assert.ok(tracker.includes("raw/articles/new.md"));
  assert.ok(!tracker.includes("raw/articles/GitHub项目收集/2026-06-03 GitHub 热门项目简报.md"));
  const report = await readFile(path.join(maintenanceConcurrentRawAddVault, result.reportPath), "utf8");
  assert.ok(report.includes("## 运行中新出现的 raw"));
  assert.ok(report.includes("raw/articles/GitHub项目收集/2026-06-03 GitHub 热门项目简报.md"));
  const rediscovered = await discoverKnowledgeBaseSources(maintenanceConcurrentRawAddVault, settings.knowledgeBase.processedSources);
  assert.equal(rediscovered.changedSources.some((source) => source.relativePath === "raw/articles/new.md"), false);
  assert.equal(rediscovered.changedSources.some((source) => source.relativePath === "raw/articles/GitHub项目收集/2026-06-03 GitHub 热门项目简报.md"), true);
} finally {
  await rm(maintenanceConcurrentRawAddVault, { recursive: true, force: true });
}

const rawDigestCalibrationVault = await createMaintenanceVaultForTest("codex-kb-raw-digest-calibration-");
try {
  const rawBeforeCalibration = await readFile(path.join(rawDigestCalibrationVault, "raw", "articles", "new.md"));
  const knownRawPath = path.join(rawDigestCalibrationVault, "raw", "articles", "known.md");
  await writeFile(knownRawPath, "# Known\n\n这份历史 raw 已在 settings 中登记，校准时应补 Obsidian 元属性。", "utf8");
  const knownRawBeforeCalibration = await readFile(knownRawPath);
  const knownRawStat = await stat(knownRawPath);
  const knownRawFingerprint = rawDigestFingerprint("raw/articles/known.md", knownRawBeforeCalibration);
  const driftRawPath = path.join(rawDigestCalibrationVault, "raw", "articles", "drift.md");
  await writeFile(driftRawPath, "# Drift\n\n这份 raw 的 mtime 漂移了，但 Wiki 已有精确来源证据。", "utf8");
  const driftRawStat = await stat(driftRawPath);
  const legacyWholeRawPath = path.join(rawDigestCalibrationVault, "raw", "articles", "legacy-whole.md");
  await writeFile(legacyWholeRawPath, [
    "---",
    "created: 2026-06-04",
    "---",
    "",
    "# Legacy Whole",
    "",
    "这份 raw 的旧记录使用整文件指纹；新规则应迁移为正文指纹。"
  ].join("\n"), "utf8");
  const legacyWholeBeforeCalibration = await readFile(legacyWholeRawPath);
  const legacyWholeStat = await stat(legacyWholeRawPath);
  const legacyWholeDigestFingerprint = rawDigestFingerprint("raw/articles/legacy-whole.md", legacyWholeBeforeCalibration);
  const legacyWholeFileFingerprint = contentFingerprint(legacyWholeBeforeCalibration);
  await mkdir(path.join(rawDigestCalibrationVault, "wiki", "ai-intelligence", "references"), { recursive: true });
  await writeFile(path.join(rawDigestCalibrationVault, "wiki", "ai-intelligence", "references", "calibrated.md"), [
    "# Calibrated",
    "",
    "> 来源：[[raw/articles/new]]",
    "> 来源：[[raw/articles/drift]]",
    "> 来源：[[raw/articles/legacy-whole]]",
    "",
    "## 核心要点",
    "",
    "这份历史 raw 已经有强正文证据，本轮只做状态校准，不重新提炼。",
    ""
  ].join("\n"), "utf8");
  const { manager, settings } = makeKnowledgeBaseManagerForTest(rawDigestCalibrationVault);
  settings.knowledgeBase.processedSources["raw/articles/known.md"] = {
    path: "raw/articles/known.md",
    size: knownRawStat.size,
    mtime: knownRawStat.mtimeMs,
    fingerprint: knownRawFingerprint,
    digestedAt: Date.now() - 86_400_000,
    reportPath: "outputs/maintenance/kb-maintenance-old.md",
    evidencePaths: ["wiki/ai-intelligence/references/calibrated.md"],
    runId: "old-run",
    confidence: "verified"
  };
  settings.knowledgeBase.processedSources["raw/articles/drift.md"] = {
    path: "raw/articles/drift.md",
    size: driftRawStat.size,
    mtime: driftRawStat.mtimeMs - 60_000,
    digestedAt: Date.now() - 86_400_000
  };
  settings.knowledgeBase.processedSources["raw/articles/legacy-whole.md"] = {
    path: "raw/articles/legacy-whole.md",
    size: legacyWholeStat.size,
    mtime: legacyWholeStat.mtimeMs,
    fingerprint: legacyWholeFileFingerprint,
    digestedAt: Date.now() - 86_400_000
  };
  const result = await manager.calibrateRawDigestStatus();
  assert.equal(result.status, "success");
  assert.equal(result.processedSources.length, 4);
  const processed = settings.knowledgeBase.processedSources["raw/articles/new.md"];
  assert.ok(processed);
  assert.equal(processed.confidence, "repaired");
  assert.ok(processed.fingerprint);
  const processedFingerprint = processed.fingerprint;
  const rawAfterCalibration = await readFile(path.join(rawDigestCalibrationVault, "raw", "articles", "new.md"));
  assert.notDeepEqual(rawAfterCalibration, rawBeforeCalibration);
  assert.ok(rawAfterCalibration.toString("utf8").includes(rawBeforeCalibration.toString("utf8")));
  const rawDigestAfterCalibration = rawDigestRecordFromMarkdown(rawAfterCalibration);
  assert.equal(rawDigestRecordIsTrusted(rawDigestAfterCalibration, processedFingerprint), true);
  assert.deepEqual(rawDigestAfterCalibration?.evidencePaths, ["wiki/ai-intelligence/references/calibrated.md"]);
  const knownProcessed = settings.knowledgeBase.processedSources["raw/articles/known.md"];
  assert.ok(knownProcessed);
  const knownRawAfterCalibration = await readFile(knownRawPath);
  assert.ok(knownRawAfterCalibration.toString("utf8").includes(knownRawBeforeCalibration.toString("utf8")));
  assert.equal(rawDigestRecordIsTrusted(rawDigestRecordFromMarkdown(knownRawAfterCalibration), knownProcessed.fingerprint ?? ""), true);
  assert.equal(rawDigestFingerprint("raw/articles/known.md", knownRawAfterCalibration), knownRawFingerprint);
  const driftProcessed = settings.knowledgeBase.processedSources["raw/articles/drift.md"];
  assert.ok(driftProcessed);
  assert.equal(rawDigestRecordIsTrusted(rawDigestRecordFromMarkdown(await readFile(driftRawPath)), driftProcessed.fingerprint ?? ""), true);
  const legacyWholeProcessed = settings.knowledgeBase.processedSources["raw/articles/legacy-whole.md"];
  assert.ok(legacyWholeProcessed);
  assert.equal(legacyWholeProcessed.fingerprint, legacyWholeDigestFingerprint);
  assert.equal(rawDigestRecordIsTrusted(rawDigestRecordFromMarkdown(await readFile(legacyWholeRawPath)), legacyWholeDigestFingerprint), true);
  const registry = await readRawDigestRegistry(rawDigestCalibrationVault);
  assert.equal(registry.entries["raw/articles/new.md"]?.fingerprint, processedFingerprint);
  assert.equal(registry.entries["raw/articles/known.md"]?.fingerprint, knownRawFingerprint);
  assert.equal(registry.entries["raw/articles/drift.md"]?.fingerprint, driftProcessed.fingerprint);
  assert.equal(registry.entries["raw/articles/legacy-whole.md"]?.fingerprint, legacyWholeDigestFingerprint);
  const rediscovered = await discoverKnowledgeBaseSources(rawDigestCalibrationVault, settings.knowledgeBase.processedSources);
  assert.equal(rediscovered.changedSources.some((source) => source.relativePath === "raw/articles/new.md"), false);
  assert.equal(rediscovered.changedSources.some((source) => source.relativePath === "raw/articles/known.md"), false);
  assert.equal(rediscovered.changedSources.some((source) => source.relativePath === "raw/articles/drift.md"), false);
  assert.equal(rediscovered.changedSources.some((source) => source.relativePath === "raw/articles/legacy-whole.md"), false);
  const report = await readFile(path.join(rawDigestCalibrationVault, result.reportPath), "utf8");
  assert.ok(report.includes("mode: raw-digest-calibration"));
  assert.ok(report.includes("raw/articles/new.md"));
  assert.ok(report.includes("raw/articles/known.md"));
} finally {
  await rm(rawDigestCalibrationVault, { recursive: true, force: true });
}

const maintenanceBatchLimitVault = await createMaintenanceVaultForTest("codex-kb-maintain-batch-limit-");
try {
  await rm(path.join(maintenanceBatchLimitVault, "raw", "articles", "new.md"), { force: true });
  for (let index = 1; index <= 25; index++) {
    await writeFile(path.join(maintenanceBatchLimitVault, "raw", "articles", `batch-${String(index).padStart(2, "0")}.md`), `# Batch ${index}\n\n正文 ${index}`, "utf8");
  }
  const { manager, settings } = makeKnowledgeBaseManagerForTest(maintenanceBatchLimitVault, {
    beforeAgentReturn: async () => {
      await mkdir(path.join(maintenanceBatchLimitVault, "wiki", "ai-intelligence", "references"), { recursive: true });
      await writeFile(path.join(maintenanceBatchLimitVault, "wiki", "ai-intelligence", "references", "maintain-batch.md"), [
        "# Maintain Batch",
        "",
        ...Array.from({ length: 20 }, (_, index) => `- [[raw/articles/batch-${String(index + 1).padStart(2, "0")}]]：核心要点：第 ${index + 1} 份资料已经提炼进批量维护页。`),
        ""
      ].join("\n"), "utf8");
      const reportPath = path.join(maintenanceBatchLimitVault, "outputs", "maintenance", `kb-maintenance-${formatDateKeyForTest(new Date())}.md`);
      await mkdir(path.dirname(reportPath), { recursive: true });
      await writeFile(reportPath, [
        "---",
        "source: codex-echoink",
        "---",
        "",
        "# 知识库维护报告",
        "",
        "## 本轮来源",
        ...Array.from({ length: 20 }, (_, index) => `- [[raw/articles/batch-${String(index + 1).padStart(2, "0")}]]`),
        ""
      ].join("\n"), "utf8");
    }
  });
  const result = await manager.runMaintenance("maintain", "/maintain 测试批次上限");
  assert.equal(result.status, "success");
  assert.equal(result.processedSources.length, 20);
  assert.equal(Object.keys(settings.knowledgeBase.processedSources).length, 20);
  const rediscovered = await discoverKnowledgeBaseSources(maintenanceBatchLimitVault, settings.knowledgeBase.processedSources);
  assert.equal(rediscovered.changedSources.length, 5);
} finally {
  await rm(maintenanceBatchLimitVault, { recursive: true, force: true });
}

const maintenanceReplicaVault = await createMaintenanceVaultForTest("codex-kb-maintain-replica-");
try {
  const stableRawPath = path.join(maintenanceReplicaVault, "raw", "articles", "stable.md");
  const legacyRawPath = path.join(maintenanceReplicaVault, "raw", "articles", "legacy.md");
  const newRawPath = path.join(maintenanceReplicaVault, "raw", "articles", "new.md");
  await writeFile(stableRawPath, "# Stable\n\n已处理正文", "utf8");
  await writeFile(legacyRawPath, "# Legacy\n\n旧记录没有 fingerprint", "utf8");
  await writeFile(newRawPath, "# New\n\n本轮新增正文", "utf8");
  const oldTime = new Date(Date.now() - 86_400_000);
  await utimes(stableRawPath, oldTime, oldTime);
  await utimes(legacyRawPath, oldTime, oldTime);
  await utimes(newRawPath, oldTime, oldTime);
  const stableStat = await stat(stableRawPath);
  const legacyStat = await stat(legacyRawPath);
  const rawSourceBefore = new Map(await Promise.all(
    [stableRawPath, legacyRawPath, newRawPath].map(async (filePath) => {
      const fileStat = await stat(filePath);
      return [filePath, {
        text: await readFile(filePath, "utf8"),
        mtime: Math.round(fileStat.mtimeMs),
        mode: fileStat.mode & 0o777
      }] as const;
    })
  ));
  const { manager, settings } = makeKnowledgeBaseManagerForTest(maintenanceReplicaVault, {
    beforeAgentReturn: async () => {
      await mkdir(path.join(maintenanceReplicaVault, "wiki", "ai-intelligence", "references"), { recursive: true });
      await writeFile(path.join(maintenanceReplicaVault, "raw", "index.md"), [
        "# Raw",
        "",
        "- [[raw/articles/stable]]",
        "- [[raw/articles/legacy]]",
        "- [[raw/articles/new]]",
        ""
      ].join("\n"), "utf8");
      await writeFile(path.join(maintenanceReplicaVault, "wiki", "ai-intelligence", "references", "maintain-replica.md"), [
        "# Maintain Replica",
        "",
        "来源：[[raw/articles/legacy]]、[[raw/articles/new]]",
        "核心要点：legacy 与 new 两份资料已经合并进副本验收页。",
        ""
      ].join("\n"), "utf8");
      await writeFile(path.join(maintenanceReplicaVault, "wiki", "index.md"), [
        "# Wiki",
        "",
        "- [[wiki/ai-intelligence/references/maintain-replica]]",
        ""
      ].join("\n"), "utf8");
      const reportPath = path.join(maintenanceReplicaVault, "outputs", "maintenance", `kb-maintenance-${formatDateKeyForTest(new Date())}.md`);
      await mkdir(path.dirname(reportPath), { recursive: true });
      await writeFile(reportPath, [
        "---",
        "source: codex-echoink",
        "---",
        "",
        "# 知识库维护报告",
        "",
        "## 本轮来源",
        "- [[raw/articles/legacy]]",
        "- [[raw/articles/new]]",
        ""
      ].join("\n"), "utf8");
    }
  });
  settings.knowledgeBase.processedSources = {
    "raw/articles/stable.md": {
      path: "raw/articles/stable.md",
      size: stableStat.size,
      mtime: stableStat.mtimeMs,
      fingerprint: contentFingerprint(Buffer.from("# Stable\n\n已处理正文")),
      digestedAt: oldTime.getTime()
    },
    "raw/articles/legacy.md": {
      path: "raw/articles/legacy.md",
      size: legacyStat.size,
      mtime: legacyStat.mtimeMs,
      digestedAt: oldTime.getTime()
    }
  };
  const result = await manager.runMaintenance("maintain", "/maintain 副本验收成功路径");
  assert.equal(result.status, "success");
  assert.deepEqual(result.processedSources.map((source) => source.relativePath).sort(), [
    "raw/articles/legacy.md",
    "raw/articles/new.md"
  ]);
  for (const [filePath, before] of rawSourceBefore) {
    const afterStat = await stat(filePath);
    assert.equal(afterStat.mode & 0o777, before.mode);
    const afterContent = await readFile(filePath);
    if (filePath === stableRawPath) {
      assert.equal(afterContent.toString("utf8"), before.text);
      assert.equal(Math.round(afterStat.mtimeMs), before.mtime);
      continue;
    }
    const relativeRawPath = path.relative(maintenanceReplicaVault, filePath).split(path.sep).join("/");
    const processed = settings.knowledgeBase.processedSources[relativeRawPath];
    assert.ok(processed);
    assert.ok(afterContent.toString("utf8").includes(before.text));
    assert.equal(rawDigestRecordIsTrusted(rawDigestRecordFromMarkdown(afterContent), processed.fingerprint ?? ""), true);
    assert.equal(rawDigestFingerprint(relativeRawPath, afterContent), processed.fingerprint);
  }
  assert.ok((await readFile(path.join(maintenanceReplicaVault, "raw", "index.md"), "utf8")).includes("[[raw/articles/new]]"));
  assert.ok((await readFile(path.join(maintenanceReplicaVault, "wiki", "ai-intelligence", "references", "maintain-replica.md"), "utf8")).includes("[[raw/articles/legacy]]"));
  assert.match(settings.knowledgeBase.processedSources["raw/articles/legacy.md"]?.fingerprint ?? "", /^sha256:\d+:[a-f0-9]{64}$/);
  assert.match(settings.knowledgeBase.processedSources["raw/articles/new.md"]?.fingerprint ?? "", /^sha256:\d+:[a-f0-9]{64}$/);
  const tracker = await readFile(path.join(maintenanceReplicaVault, "outputs", ".ingest-tracker.md"), "utf8");
  assert.ok(tracker.includes("raw/articles/stable.md"));
  assert.ok(tracker.includes("raw/articles/legacy.md"));
  assert.ok(tracker.includes("raw/articles/new.md"));
  assert.ok(tracker.includes(`fingerprint=${settings.knowledgeBase.processedSources["raw/articles/legacy.md"].fingerprint}`));
  assert.ok(tracker.includes(`fingerprint=${settings.knowledgeBase.processedSources["raw/articles/new.md"].fingerprint}`));
  const rawDigestRegistry = JSON.parse(await readFile(path.join(maintenanceReplicaVault, "outputs", ".raw-digest-registry.json"), "utf8"));
  assert.equal(rawDigestRegistry.entries["raw/articles/legacy.md"].fingerprint, settings.knowledgeBase.processedSources["raw/articles/legacy.md"].fingerprint);
  assert.equal(rawDigestRegistry.entries["raw/articles/new.md"].fingerprint, settings.knowledgeBase.processedSources["raw/articles/new.md"].fingerprint);
  assert.deepEqual(rawDigestRegistry.entries["raw/articles/legacy.md"].evidencePaths, ["wiki/ai-intelligence/references/maintain-replica.md"]);
  const rediscovered = await discoverKnowledgeBaseSources(maintenanceReplicaVault, settings.knowledgeBase.processedSources);
  assert.equal(rediscovered.changedSources.length, 0);
  const dashboard = await buildKnowledgeBaseDashboardSnapshot(maintenanceReplicaVault, settings.knowledgeBase);
  assert.equal(dashboard.raw.changedCount, 0);
} finally {
  await rm(maintenanceReplicaVault, { recursive: true, force: true });
}

const structureVault = await mkdtemp(path.join(tmpdir(), "codex-kb-structure-"));
try {
  await mkdir(path.join(structureVault, "raw", "articles", "GitHub项目收集"), { recursive: true });
  await mkdir(path.join(structureVault, "raw", "articles", "微信公众号", "2026-05-19 Hermes agent 昨晚又更新了.assets"), { recursive: true });
  await mkdir(path.join(structureVault, "raw", "clippings", "文章"), { recursive: true });
  await mkdir(path.join(structureVault, "wiki", "ai-intelligence", "references"), { recursive: true });
  await mkdir(path.join(structureVault, "outputs"), { recursive: true });
  await mkdir(path.join(structureVault, "inbox", "Clippings"), { recursive: true });
  await mkdir(path.join(structureVault, "inbox", "桌面 TodoList 调研"), { recursive: true });
  await mkdir(path.join(structureVault, "projects", "demo", "10-沉淀"), { recursive: true });
  await mkdir(path.join(structureVault, "projects", "demo", "20-实践"), { recursive: true });
  const githubRaw = "# GitHub\n\n原文正文\n\n原始路径记录：raw/articles/GitHub项目收集/2026-05-19 GitHub 热门项目简报.md";
  const wechatRaw = "# Hermes\n\n公众号正文";
  await writeFile(path.join(structureVault, "raw", "articles", "GitHub项目收集", "2026-05-19 GitHub 热门项目简报.md"), githubRaw, "utf8");
  await writeFile(path.join(structureVault, "raw", "articles", "微信公众号", "2026-05-19 Hermes agent 昨晚又更新了.md"), wechatRaw, "utf8");
  await writeFile(path.join(structureVault, "raw", "articles", "微信公众号", "2026-05-19 Hermes agent 昨晚又更新了.assets", "cover.png"), Buffer.from([1, 2, 3]));
  await writeFile(path.join(structureVault, "raw", "策略信号系统介绍.md"), "# 策略\n\n原文不能改", "utf8");
  await writeFile(path.join(structureVault, "raw", "index.md"), [
    "# Raw",
    "",
    "### GitHub 项目收集 (articles/GitHub项目收集/)",
    "",
    "- [[raw/articles/GitHub项目收集/2026-05-19 GitHub 热门项目简报]]",
    "- [[raw/articles/微信公众号/2026-05-19 Hermes agent 昨晚又更新了]]",
    "- `raw/策略信号系统介绍.md`"
  ].join("\n"), "utf8");
  await writeFile(path.join(structureVault, "wiki", "ai-intelligence", "references", "github.md"), [
    "# GitHub",
    "",
    "来源：[[raw/articles/GitHub项目收集/2026-05-19 GitHub 热门项目简报]]"
  ].join("\n"), "utf8");
  await writeFile(path.join(structureVault, "outputs", ".ingest-tracker.md"), [
    "# Tracker",
    "",
    "- `raw/articles/GitHub项目收集/2026-05-19 GitHub 热门项目简报.md`",
    "- `raw/策略信号系统介绍.md`"
  ].join("\n"), "utf8");
  await writeFile(path.join(structureVault, "outputs", "kb-maintenance-2026-05-19.md"), "# 维护报告", "utf8");
  await writeFile(path.join(structureVault, "outputs", "knowledge-base-review-2026-05-11-to-2026-05-17.md"), "# 周报", "utf8");
  await writeFile(path.join(structureVault, "outputs", "obsidian-codex-v041-xhs-post.md"), "# 小红书", "utf8");
  await writeFile(path.join(structureVault, "outputs", "global-instructions-2026-05-10.md"), "# instructions", "utf8");
  await writeFile(path.join(structureVault, "outputs", "old-wiki-merge-2026-05-19.md"), "# migration", "utf8");
  await writeFile(path.join(structureVault, "inbox", "Clippings", "clip.md"), "# clip", "utf8");
  await writeFile(path.join(structureVault, "inbox", "skills-local-audit.md"), "# skills", "utf8");
  await writeFile(path.join(structureVault, "inbox", "日常记录.md"), "# idea", "utf8");
  await writeFile(path.join(structureVault, "inbox", "桌面 TodoList 调研", "00-汇总报告.md"), "# todo", "utf8");
  await writeFile(path.join(structureVault, "projects", "demo", "10-沉淀", "insight.md"), "# insight", "utf8");
  await writeFile(path.join(structureVault, "projects", "demo", "20-实践", "run.md"), "# run", "utf8");
  await writeFile(path.join(structureVault, "projects", "demo", "00-项目总览.md"), [
    "# Demo",
    "",
    "### 10-沉淀",
    "- [[10-沉淀/insight|insight]]",
    "### 20-实践",
    "- [[20-实践/run|run]]"
  ].join("\n"), "utf8");
  await writeFile(path.join(structureVault, "projects", "多 Agent 方案讨论 APP：项目初步启动.md"), "# project", "utf8");

  const result = await normalizeKnowledgeBaseStructure(structureVault, {
    lastReportPath: "outputs/kb-maintenance-2026-05-19.md",
    includeRawMoves: true
  });
  assert.equal(await readFile(path.join(structureVault, "raw", "articles", "github-trending", "2026-05-19 GitHub 热门项目简报.md"), "utf8"), githubRaw);
  assert.equal(await readFile(path.join(structureVault, "raw", "articles", "wechat-official-accounts", "2026-05-19 Hermes agent 昨晚又更新了.md"), "utf8"), wechatRaw);
  assert.equal(await fileExists(path.join(structureVault, "raw", "articles", "wechat-official-accounts", "2026-05-19 Hermes agent 昨晚又更新了.assets", "cover.png")), true);
  assert.equal(await readFile(path.join(structureVault, "raw", "articles", "investment", "策略信号系统介绍.md"), "utf8"), "# 策略\n\n原文不能改");
  assert.equal(await fileExists(path.join(structureVault, "raw", "articles", "GitHub项目收集")), false);
  assert.ok((await readFile(path.join(structureVault, "wiki", "ai-intelligence", "references", "github.md"), "utf8")).includes("[[raw/articles/github-trending/2026-05-19 GitHub 热门项目简报]]"));
  assert.ok((await readFile(path.join(structureVault, "raw", "index.md"), "utf8")).includes("articles/github-trending/"));
  const trackerAfter = await readFile(path.join(structureVault, "outputs", ".ingest-tracker.md"), "utf8");
  assert.ok(trackerAfter.includes("raw/articles/github-trending/2026-05-19 GitHub 热门项目简报.md"));
  assert.ok(trackerAfter.includes("raw/articles/investment/策略信号系统介绍.md"));
  assert.ok(!trackerAfter.includes("raw/articles/GitHub项目收集"));
  assert.equal(await fileExists(path.join(structureVault, "outputs", "maintenance", "kb-maintenance-2026-05-19.md")), true);
  assert.equal(result.updatedLastReportPath, "outputs/maintenance/kb-maintenance-2026-05-19.md");
  assert.equal(await fileExists(path.join(structureVault, "outputs", "reviews", "knowledge-base-review-2026-05-11-to-2026-05-17.md")), true);
  assert.equal(await fileExists(path.join(structureVault, "outputs", "publishing", "xiaohongshu", "obsidian-codex-v041-xhs-post.md")), true);
  assert.equal(await fileExists(path.join(structureVault, "outputs", "instructions", "global-instructions-2026-05-10.md")), true);
  assert.equal(await fileExists(path.join(structureVault, "outputs", "migrations", "old-wiki-merge-2026-05-19.md")), true);
  assert.equal(await fileExists(path.join(structureVault, "inbox", "clippings", "clip.md")), true);
  assert.ok((await readdir(path.join(structureVault, "inbox"))).includes("clippings"));
  assert.ok(!(await readdir(path.join(structureVault, "inbox"))).includes("Clippings"));
  assert.equal(await fileExists(path.join(structureVault, "inbox", "research", "skills-local-audit.md")), true);
  assert.equal(await fileExists(path.join(structureVault, "inbox", "ideas", "日常记录.md")), true);
  assert.equal(await fileExists(path.join(structureVault, "inbox", "research", "desktop-todolist", "00-汇总报告.md")), true);
  assert.equal(await fileExists(path.join(structureVault, "projects", "demo", "insights", "insight.md")), true);
  assert.equal(await fileExists(path.join(structureVault, "projects", "demo", "execution", "run.md")), true);
  const projectOverviewAfter = await readFile(path.join(structureVault, "projects", "demo", "00-项目总览.md"), "utf8");
  assert.ok(projectOverviewAfter.includes("[[insights/insight|insight]]"));
  assert.ok(projectOverviewAfter.includes("[[execution/run|run]]"));
  assert.ok(result.moves.some((move) => move.from === "raw/articles/GitHub项目收集"));
  assert.ok(result.moves.some((move) => move.from === "raw/articles/微信公众号"));
  assert.ok(result.moves.some((move) => move.from === "projects/demo/10-沉淀"));
  assert.ok(result.remainingRootNotes.includes("projects/多 Agent 方案讨论 APP：项目初步启动.md"));
} finally {
  await rm(structureVault, { recursive: true, force: true });
}

const defaultStructureVault = await mkdtemp(path.join(tmpdir(), "codex-kb-structure-default-"));
try {
  await mkdir(path.join(defaultStructureVault, "raw", "articles", "GitHub项目收集"), { recursive: true });
  await mkdir(path.join(defaultStructureVault, "wiki"), { recursive: true });
  await mkdir(path.join(defaultStructureVault, "outputs"), { recursive: true });
  await mkdir(path.join(defaultStructureVault, "inbox", "Clippings"), { recursive: true });
  await mkdir(path.join(defaultStructureVault, "projects"), { recursive: true });
  await writeFile(path.join(defaultStructureVault, "raw", "articles", "GitHub项目收集", "demo.md"), "# raw\n\n正文", "utf8");
  await writeFile(path.join(defaultStructureVault, "inbox", "Clippings", "clip.md"), "# clip", "utf8");
  const result = await normalizeKnowledgeBaseStructure(defaultStructureVault);
  assert.equal(await fileExists(path.join(defaultStructureVault, "raw", "articles", "GitHub项目收集", "demo.md")), true);
  assert.equal(await fileExists(path.join(defaultStructureVault, "raw", "articles", "github-trending", "demo.md")), false);
  assert.equal(await fileExists(path.join(defaultStructureVault, "inbox", "clippings", "clip.md")), true);
  assert.ok(!result.moves.some((move) => move.from.startsWith("raw/")));
  assert.ok(result.skipped.some((item) => item.from === "raw/articles/GitHub项目收集" && /raw 自动移动已关闭/.test(item.reason)));
} finally {
  await rm(defaultStructureVault, { recursive: true, force: true });
}

const mergeStructureVault = await mkdtemp(path.join(tmpdir(), "codex-kb-structure-merge-"));
try {
  await mkdir(path.join(mergeStructureVault, "raw", "articles", "GitHub项目收集"), { recursive: true });
  await mkdir(path.join(mergeStructureVault, "raw", "articles", "github-trending"), { recursive: true });
  await writeFile(path.join(mergeStructureVault, "raw", "articles", "GitHub项目收集", "2026-05-25 GitHub 热门项目简报.md"), "# new", "utf8");
  await writeFile(path.join(mergeStructureVault, "raw", "articles", "github-trending", "2026-05-24 GitHub 热门项目简报.md"), "# old", "utf8");
  const result = await normalizeKnowledgeBaseStructure(mergeStructureVault, { includeRawMoves: true });
  assert.equal(await readFile(path.join(mergeStructureVault, "raw", "articles", "github-trending", "2026-05-25 GitHub 热门项目简报.md"), "utf8"), "# new");
  assert.equal(await readFile(path.join(mergeStructureVault, "raw", "articles", "github-trending", "2026-05-24 GitHub 热门项目简报.md"), "utf8"), "# old");
  assert.equal(await fileExists(path.join(mergeStructureVault, "raw", "articles", "GitHub项目收集")), false);
  assert.ok(result.moves.some((move) => move.from === "raw/articles/GitHub项目收集" && move.to === "raw/articles/github-trending"));
  assert.ok(!result.skipped.some((item) => item.from === "raw/articles/GitHub项目收集"));
} finally {
  await rm(mergeStructureVault, { recursive: true, force: true });
}

const collisionStructureVault = await mkdtemp(path.join(tmpdir(), "codex-kb-structure-collision-"));
try {
  await mkdir(path.join(collisionStructureVault, "raw", "articles", "GitHub项目收集"), { recursive: true });
  await mkdir(path.join(collisionStructureVault, "raw", "articles", "github-trending"), { recursive: true });
  await writeFile(path.join(collisionStructureVault, "raw", "articles", "GitHub项目收集", "a.md"), "# old", "utf8");
  await writeFile(path.join(collisionStructureVault, "raw", "articles", "github-trending", "a.md"), "# target", "utf8");
  const result = await normalizeKnowledgeBaseStructure(collisionStructureVault, { includeRawMoves: true });
  assert.equal(await fileExists(path.join(collisionStructureVault, "raw", "articles", "GitHub项目收集", "a.md")), true);
  assert.ok(result.skipped.some((item) => item.from === "raw/articles/GitHub项目收集" && /冲突/.test(item.reason)));
  assert.ok(result.risks.some((item) => item.includes("raw/articles/GitHub项目收集")));
} finally {
  await rm(collisionStructureVault, { recursive: true, force: true });
}

const journalVault = await mkdtemp(path.join(tmpdir(), "codex-kb-journal-"));
try {
  await mkdir(path.join(journalVault, "journal", "daily", "2026-05"), { recursive: true });
  await mkdir(path.join(journalVault, "journal", "monthly", "2026"), { recursive: true });
  await writeFile(path.join(journalVault, "journal", "daily", "2026-05", "2026-05-09-周六.md"), "# 2026-05-09 周六\n\n## 🚶 行动轨迹\n", "utf8");
  await writeFile(path.join(journalVault, "journal", "daily", "2026-05-18.md"), "# Wrong flat note\n", "utf8");
  const target = await resolveJournalDailyTarget(journalVault, "/journal 写一下今天的日记。", new Date(2026, 4, 18, 9, 0, 0));
  assert.equal(target.relativePath, "journal/daily/2026-05/2026-05-18-周一.md");
  assert.ok(target.samplePaths.includes("journal/daily/2026-05/2026-05-09-周六.md"));
  assert.ok(target.templateDirectories.includes("journal/monthly/2026"));
  assert.equal(target.evidenceWindow.label, "2026-05-18 00:00 - 2026-05-19 06:00");
  assert.ok(target.codexSessionGlobs.some((item) => item.endsWith("/2026/05/18/*.jsonl")));
  assert.ok(target.codexSessionGlobs.some((item) => item.endsWith("/2026/05/19/*.jsonl")));
  await ensureJournalTargetFolders(journalVault, target);
  assert.equal(await fileExists(path.join(journalVault, "journal", "daily", "2026-05")), true);
  assert.equal(await fileExists(path.join(journalVault, "journal", "weekly")), true);
  const journalPrompt = buildKnowledgeBaseJournalPrompt({
    vaultPath: journalVault,
    userRequest: "写一下今天的日记。",
    target,
    generatedAt: new Date(2026, 4, 18, 9, 1, 0)
  });
  assert.ok(journalPrompt.includes("Codex Obsidian Daily Journal"));
  assert.ok(journalPrompt.includes("journal/daily/2026-05/2026-05-18-周一.md"));
  assert.ok(journalPrompt.includes("不要写到扁平路径 journal/daily/YYYY-MM-DD.md"));
  assert.ok(journalPrompt.includes("只做增量更新"));
  assert.ok(journalPrompt.includes("2026-05-18 00:00 - 2026-05-19 06:00"));
  assert.ok(journalPrompt.includes("不要再使用 00:00-02:30 旧口径"));
  assert.ok(journalPrompt.includes("2026/05/19/*.jsonl"));
  const openCodeJournalPrompt = buildKnowledgeBaseJournalPrompt({
    vaultPath: journalVault,
    userRequest: "写一下今天的日记。",
    target,
    backend: "opencode",
    openCodeHistory: {
      serverUrl: "http://127.0.0.1:4096",
      sessionsScanned: 3,
      sessionsMatched: 1,
      truncated: false,
      messages: [{
        sessionId: "ses_1",
        sessionTitle: "OpenCode 知识库维护",
        directory: journalVault,
        role: "user",
        createdAt: new Date(2026, 4, 19, 1, 30, 0).getTime(),
        createdAtLabel: "2026-05-19 01:30",
        modelLabel: "anthropic/claude",
        text: "处理 journal 后端切换"
      }]
    },
    generatedAt: new Date(2026, 4, 18, 9, 1, 0)
  });
  assert.ok(openCodeJournalPrompt.includes("记录来源：OpenCode API"));
  assert.ok(openCodeJournalPrompt.includes("session.list"));
  assert.ok(openCodeJournalPrompt.includes("处理 journal 后端切换"));
  assert.ok(openCodeJournalPrompt.includes("不要再读取 Codex sessions 当作主证据"));
  const yesterdayTarget = await resolveJournalDailyTarget(journalVault, "写日记：昨天的内容", new Date(2026, 4, 18, 9, 0, 0));
  assert.equal(yesterdayTarget.relativePath, "journal/daily/2026-05/2026-05-17-周日.md");
} finally {
  await rm(journalVault, { recursive: true, force: true });
}

const emptyJournalVault = await mkdtemp(path.join(tmpdir(), "codex-kb-empty-journal-"));
try {
  const target = await resolveJournalDailyTarget(emptyJournalVault, "写日记", new Date(2026, 4, 18, 9, 0, 0));
  assert.equal(target.relativePath, "journal/daily/2026-05/2026-05-18-周一.md");
  assert.ok(target.templateDirectories.includes("journal/quarterly"));
} finally {
  await rm(emptyJournalVault, { recursive: true, force: true });
}

const initVault = await mkdtemp(path.join(tmpdir(), "codex-kb-init-"));
try {
  await writeFile(path.join(initVault, "old-note.md"), "# Old note\n\n项目资料", "utf8");
  const preview = await buildKnowledgeBaseInitializationPreview(initVault);
  assert.equal(preview.status, "preview-ready");
  assert.equal(preview.rulesFilePath, DEFAULT_KNOWLEDGE_BASE_RULES_FILE);
  assert.ok(preview.summary.includes(`将生成规则文件：${DEFAULT_KNOWLEDGE_BASE_RULES_FILE}`));
  assert.ok(preview.directories.includes("raw/articles"));
  assert.ok(preview.directories.includes("wiki/ai-intelligence"));
  assert.ok(preview.directories.includes("journal/monthly"));
  assert.ok(preview.suggestions.some((item) => item.path === "old-note.md" && item.target === "projects"));
  assert.equal(await fileExists(path.join(initVault, DEFAULT_KNOWLEDGE_BASE_RULES_FILE)), false);

  const result = await executeKnowledgeBaseInitialization(initVault, preview, new Date("2026-05-15T08:00:00.000Z"));
  assert.equal(result.rulesFilePath, DEFAULT_KNOWLEDGE_BASE_RULES_FILE);
  assert.equal(await fileExists(path.join(initVault, "raw", "articles")), true);
  assert.equal(await fileExists(path.join(initVault, "wiki", "index.md")), true);
  assert.equal(await fileExists(path.join(initVault, "outputs", ".ingest-tracker.md")), true);
  const initializedRules = await readFile(path.join(initVault, DEFAULT_KNOWLEDGE_BASE_RULES_FILE), "utf8");
  assert.ok(initializedRules.includes("LLM Wiki"));
  assert.ok(initializedRules.includes("普通 Agent 对话中明确要求整理 `raw/`"));
  assert.ok(initializedRules.includes("知识库管理动作中禁止 Agent 改写 `raw/` 正文"));
  assert.ok(initializedRules.includes("Structure Normalize"));
  assert.ok(initializedRules.includes("托管元属性"));
  assert.ok(initializedRules.includes("`raw/` 只更新 `raw/index.md`，不移动原始资料"));
  assert.ok(initializedRules.includes("普通 Agent 对话不默认检索知识库"));
  assert.ok((await readFile(path.join(initVault, "wiki", "index.md"), "utf8")).includes("AI 与智能体"));
  assert.ok((await readFile(path.join(initVault, "raw", "index.md"), "utf8")).includes("插件可写托管元属性，不自动移动"));
} finally {
  await rm(initVault, { recursive: true, force: true });
}

const initVaultWithAgents = await mkdtemp(path.join(tmpdir(), "codex-kb-init-agents-"));
try {
  await writeFile(path.join(initVaultWithAgents, "AGENTS.md"), "# Existing agents\n", "utf8");
  const preview = await buildKnowledgeBaseInitializationPreview(initVaultWithAgents);
  assert.equal(preview.rulesFilePath, DEFAULT_KNOWLEDGE_BASE_RULES_FILE);
  await executeKnowledgeBaseInitialization(initVaultWithAgents, preview, new Date("2026-05-15T08:00:00.000Z"));
  assert.ok((await readFile(path.join(initVaultWithAgents, "AGENTS.md"), "utf8")).includes("Existing agents"));
  assert.ok((await readFile(path.join(initVaultWithAgents, DEFAULT_KNOWLEDGE_BASE_RULES_FILE), "utf8")).includes("LLM Wiki"));
} finally {
  await rm(initVaultWithAgents, { recursive: true, force: true });
}

const initVaultWithBothRules = await mkdtemp(path.join(tmpdir(), "codex-kb-init-both-"));
try {
  await writeFile(path.join(initVaultWithBothRules, "AGENTS.md"), "# Existing agents\n", "utf8");
  await writeFile(path.join(initVaultWithBothRules, "CLAUDE.md"), "# Existing claude\n", "utf8");
  const preview = await buildKnowledgeBaseInitializationPreview(initVaultWithBothRules);
  assert.equal(preview.rulesFilePath, DEFAULT_KNOWLEDGE_BASE_RULES_FILE);
  await executeKnowledgeBaseInitialization(initVaultWithBothRules, preview, new Date("2026-05-15T08:00:00.000Z"));
  assert.ok((await readFile(path.join(initVaultWithBothRules, "CLAUDE.md"), "utf8")).includes("Existing claude"));
  assert.ok((await readFile(path.join(initVaultWithBothRules, DEFAULT_KNOWLEDGE_BASE_RULES_FILE), "utf8")).includes("LLM Wiki"));
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
  assert.ok(createdRules.includes("知识库管理动作中禁止 Agent 改写 `raw/` 正文"));
  assert.ok(createdRules.includes("托管元属性"));
  assert.ok(createdRules.includes("Structure Normalize"));
  assert.ok(createdRules.includes("普通 Agent 对话中明确要求整理 `raw/`"));

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
    rulesFilePath: DEFAULT_KNOWLEDGE_BASE_RULES_FILE
  }, new Date("2026-05-15T08:00:00.000Z"));
  assert.equal(customCreated.status, "created");
  assert.equal(customCreated.rulesFilePath, DEFAULT_KNOWLEDGE_BASE_RULES_FILE);
  assert.equal(await fileExists(path.join(customRulesRepairVault, "AGENTS.md")), false);
  assert.ok((await readFile(path.join(customRulesRepairVault, DEFAULT_KNOWLEDGE_BASE_RULES_FILE), "utf8")).includes("LLM Wiki"));
} finally {
  await rm(customRulesRepairVault, { recursive: true, force: true });
}

const patchRulesRepairVault = await mkdtemp(path.join(tmpdir(), "codex-kb-patch-rules-repair-"));
try {
  await writeFile(path.join(patchRulesRepairVault, DEFAULT_KNOWLEDGE_BASE_RULES_FILE), "# Existing rules\n\n只写团队协作偏好。", "utf8");
  const patched = await repairKnowledgeBaseRulesFile(patchRulesRepairVault, {
    useCustomRulesFile: true,
    rulesFilePath: DEFAULT_KNOWLEDGE_BASE_RULES_FILE
  }, new Date("2026-05-15T08:00:00.000Z"));
  assert.equal(patched.status, "patched");
  assert.ok(patched.missingRules.includes("raw/ 内容保护与托管元属性边界"));
  assert.ok(patched.missingRules.includes("raw/ 普通对话授权边界"));
  assert.ok(patched.missingRules.includes("Structure Normalize 阶段"));
  const patchedRules = await readFile(path.join(patchRulesRepairVault, DEFAULT_KNOWLEDGE_BASE_RULES_FILE), "utf8");
  assert.ok(patchedRules.startsWith("# Existing rules"));
  assert.ok(patchedRules.includes("codex-echoink-kb-minimum-rules:start"));
  assert.ok(patchedRules.includes("`raw/` 是原始资料与待整理来源区"));
  assert.ok(patchedRules.includes("只有 EchoInk 插件后处理阶段可以写入托管元属性"));
  assert.ok(patchedRules.includes("raw 路径归一只写入报告风险"));
  assert.ok(patchedRules.includes("普通 Agent 对话中，如果用户明确要求整理 `raw/`"));
  assert.ok(patchedRules.includes("把维护报告写入 `outputs/maintenance/`"));
} finally {
  await rm(patchRulesRepairVault, { recursive: true, force: true });
}

const replaceMinimumRulesVault = await mkdtemp(path.join(tmpdir(), "codex-kb-replace-min-rules-"));
try {
  await writeFile(path.join(replaceMinimumRulesVault, DEFAULT_KNOWLEDGE_BASE_RULES_FILE), [
    "# Existing rules",
    "",
    "<!-- codex-echoink-kb-minimum-rules:start -->",
    "",
    "## Codex 知识库最小运行规则",
    "",
    "- `raw/` 是不可变原始资料区，只读。",
    "- 禁止删除文件。",
    "",
    "<!-- codex-echoink-kb-minimum-rules:end -->"
  ].join("\n"), "utf8");
  const replaced = await repairKnowledgeBaseRulesFile(replaceMinimumRulesVault, {
    useCustomRulesFile: true,
    rulesFilePath: DEFAULT_KNOWLEDGE_BASE_RULES_FILE
  }, new Date("2026-05-15T08:00:00.000Z"));
  assert.equal(replaced.status, "patched");
  const replacedRules = await readFile(path.join(replaceMinimumRulesVault, DEFAULT_KNOWLEDGE_BASE_RULES_FILE), "utf8");
  assert.equal((replacedRules.match(/codex-echoink-kb-minimum-rules:start/g) ?? []).length, 1);
  assert.ok(replacedRules.includes("普通 Agent 对话中，如果用户明确要求整理 `raw/`"));
  assert.ok(!replacedRules.includes("不可变原始资料区"));
} finally {
  await rm(replaceMinimumRulesVault, { recursive: true, force: true });
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

function knowledgeReportFileNameForTest(mode: KnowledgeBaseRunMode, value = new Date()): string {
  const prefix = mode === "lint" ? "kb-check" : "kb-maintenance";
  return `${prefix}-${formatDateKeyForTest(value)}.md`;
}

function knowledgeReportAbsolutePathForTest(vaultPath: string, mode: KnowledgeBaseRunMode, value = new Date()): string {
  return path.join(vaultPath, "outputs", "maintenance", knowledgeReportFileNameForTest(mode, value));
}

const dashboardVault = await mkdtemp(path.join(tmpdir(), "codex-kb-dashboard-"));
try {
  await mkdir(path.join(dashboardVault, "raw", "articles"), { recursive: true });
  await mkdir(path.join(dashboardVault, "wiki", "ai-intelligence"), { recursive: true });
  await mkdir(path.join(dashboardVault, "wiki", "content"), { recursive: true });
  await mkdir(path.join(dashboardVault, "outputs"), { recursive: true });
  await mkdir(path.join(dashboardVault, "inbox"), { recursive: true });
  await writeFile(path.join(dashboardVault, "AGENTS.md"), "# Rules\n", "utf8");
  await writeFile(path.join(dashboardVault, DEFAULT_KNOWLEDGE_BASE_RULES_FILE), "# LLM Wiki Rules\n", "utf8");
  await writeFile(path.join(dashboardVault, "raw", "index.md"), "# Raw\n", "utf8");
  await writeFile(path.join(dashboardVault, "raw", "articles", "old.md"), "# Old\n", "utf8");
  const newPath = path.join(dashboardVault, "raw", "articles", "new.md");
  await writeFile(newPath, "# New\n", "utf8");
  await mkdir(path.join(dashboardVault, "raw", "articles", "new.assets"), { recursive: true });
  await writeFile(path.join(dashboardVault, "raw", "articles", "new.assets", "image.png"), Buffer.from("asset"));
  await writeFile(path.join(dashboardVault, "wiki", "index.md"), "# Wiki\n", "utf8");
  await writeFile(path.join(dashboardVault, "wiki", "ai-intelligence", "00-索引.md"), "# AI\n", "utf8");
  await writeFile(path.join(dashboardVault, "wiki", "ai-intelligence", "today.md"), "# Today\n", "utf8");
  await writeFile(path.join(dashboardVault, "wiki", "content", "old.md"), "# Content\n", "utf8");
  await writeFile(path.join(dashboardVault, "outputs", ".ingest-tracker.md"), "# Tracker\n", "utf8");
  await writeFile(path.join(dashboardVault, "outputs", "kb-maintenance-2026-05-15.md"), [
    "# Report",
    "",
    "本次维护完成 raw、wiki 与 inbox 状态同步。",
    "",
    "- 断链：0"
  ].join("\n"), "utf8");
  await writeFile(path.join(dashboardVault, "inbox", "idea.md"), "# Idea\n", "utf8");
  await writeFile(path.join(dashboardVault, "inbox", "old.md"), "# Old idea\n", "utf8");
  const today = daysAgoDateForTest(0);
  const yesterday = daysAgoDateForTest(1);
  const twoDaysAgo = daysAgoDateForTest(2);
  const threeDaysAgo = daysAgoDateForTest(3);
  const fourDaysAgo = daysAgoDateForTest(4);
  await utimes(path.join(dashboardVault, "outputs", ".ingest-tracker.md"), twoDaysAgo, twoDaysAgo);
  await utimes(path.join(dashboardVault, "outputs", "kb-maintenance-2026-05-15.md"), twoDaysAgo, twoDaysAgo);
  const oldPath = path.join(dashboardVault, "raw", "articles", "old.md");
  await utimes(oldPath, threeDaysAgo, threeDaysAgo);
  await utimes(path.join(dashboardVault, "wiki", "ai-intelligence", "00-索引.md"), threeDaysAgo, threeDaysAgo);
  await utimes(path.join(dashboardVault, "wiki", "content", "old.md"), threeDaysAgo, threeDaysAgo);
  await utimes(path.join(dashboardVault, "inbox", "old.md"), threeDaysAgo, threeDaysAgo);
  const historicalReportDate = formatDateKeyForTest(threeDaysAgo);
  const historicalReportPath = path.join(dashboardVault, "outputs", `kb-maintenance-${historicalReportDate}.md`);
  await writeFile(historicalReportPath, "# Historical Report\n", "utf8");
  await utimes(historicalReportPath, threeDaysAgo, threeDaysAgo);
  const reportlessMaintenanceDate = formatDateKeyForTest(fourDaysAgo);
  const oldStat = await stat(oldPath);
  const newStat = await stat(newPath);
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
      maintenanceHistory: [
        { date: reportlessMaintenanceDate, status: "success", at: fourDaysAgo.getTime(), mode: "maintain", reportPath: "" }
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
  assert.equal(dashboard.raw.fileCount, 2);
  assert.equal(dashboard.raw.changedCount, 1);
  assert.equal(dashboard.raw.todayCount, 1);
  assert.equal(dashboard.wiki.indexExists, true);
  assert.equal(dashboard.wiki.domainCount, 2);
  assert.deepEqual(dashboard.wiki.groups.map((group) => [group.path, group.totalCount, group.sharePercent, group.todayCount]), [
    ["wiki/ai-intelligence", 2, 67, 1],
    ["wiki/content", 1, 33, 0]
  ]);
  assert.equal(dashboard.outputs.latestReportPath, "outputs/kb-maintenance-2026-05-15.md");
  assert.equal(dashboard.inbox.fileCount, 2);
  assert.equal(dashboard.inbox.todayCount, 1);
  assert.equal(dashboard.health.status, "healthy");
  assert.equal(dashboard.health.label, "健康");
  assert.equal(dashboard.health.streakDays, 2);
  assert.equal(dashboard.health.lastCheckAt, today.getTime());
  assert.equal(dashboard.checkFreshness.status, "fresh");
  assert.equal(dashboard.checkFreshness.label, "新鲜");
  assert.equal(dashboard.checkFreshness.score, 100);
  assert.equal(dashboard.checkHeatmap[0]?.date, `${today.getFullYear()}-01-01`);
  assert.equal(dashboard.checkHeatmap.at(-1)?.date, `${today.getFullYear()}-12-31`);
  assert.equal(dashboard.checkHeatmap.find((day) => day.date === formatDateKeyForTest(today))?.status, "success");
  assert.equal(dashboard.checkHeatmap.find((day) => day.date === historicalReportDate)?.status, "none");
  assert.equal(dashboard.checkHeatmap.find((day) => day.date === reportlessMaintenanceDate)?.status, "success");
  assert.ok(dashboard.checkHeatmap.length >= 365);
  assert.ok(dashboard.checkHeatmap.length <= 366);
  assert.equal(dashboard.outputs.latestReportTitle, "Report");
  assert.match(dashboard.outputs.latestReportSummary, /raw、wiki 与 inbox 状态同步/);
  const todayActivity = dashboard.activity.days.find((day) => day.date === formatDateKeyForTest(today));
  assert.equal(todayActivity?.raw, 1);
  assert.equal(todayActivity?.wiki, 1);
  assert.equal(todayActivity?.inbox, 1);
  assert.equal(todayActivity?.checks, 1);
  assert.equal(todayActivity?.failures, 0);
  assert.ok((todayActivity?.total ?? 0) >= 4);
  assert.deepEqual(dashboard.activity.heatmapRows.map((row) => row.id), ["health", "wiki", "raw", "maintenance"]);
  assert.equal(dashboard.activity.heatmapRows.every((row) => row.cells.length === 52), true);
  assert.ok(dashboard.activity.heatmapRows.find((row) => row.id === "raw")?.cells.some((cell) => cell.count > 0 && cell.level !== "none"));
  assert.ok(dashboard.activity.logs.some((log) => log.label === "体检完成" && log.tone === "green"));
  assert.ok(dashboard.activity.logs.some((log) => log.label === "Raw 待提炼" && log.tone === "orange"));
  assert.ok(dashboard.recommendations.cards.some((card) => card.path === "raw/articles/new.md" && card.status === "Raw 待提炼"));
  assert.ok(dashboard.recommendations.cards.some((card) => card.path === "wiki/ai-intelligence/today.md" && card.status === "Wiki 更新"));
  assert.ok(dashboard.recommendations.cards.some((card) => card.path === "outputs/kb-maintenance-2026-05-15.md" && card.summary.includes("raw、wiki")));
  assert.equal(dashboard.recommendations.cards.some((card) => card.path.includes(".ingest-tracker") || card.path.includes(".raw-digest-registry")), false);

  await utimes(path.join(dashboardVault, "outputs", ".ingest-tracker.md"), threeDaysAgo, threeDaysAgo);
  await utimes(path.join(dashboardVault, "outputs", "kb-maintenance-2026-05-15.md"), threeDaysAgo, threeDaysAgo);

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
  assert.equal(riskDashboard.health.status, "healthy");
  assert.ok(!riskDashboard.health.reasons.some((reason) => reason.includes("3 天未体检")));
  assert.equal(riskDashboard.checkFreshness.status, "stale");
  assert.equal(riskDashboard.checkFreshness.label, "待检");
  assert.equal(riskDashboard.checkFreshness.score, 76);
  assert.ok(riskDashboard.checkFreshness.reasons.some((reason) => reason.includes("3 天前确认")));

  const staleNoNewSettings = normalizeSettingsData({
    settingsVersion: 19,
    knowledgeBase: {
      rulesFilePath: "AGENTS.md",
      healthHistory: [
        { date: formatDateKeyForTest(threeDaysAgo), status: "success", at: threeDaysAgo.getTime() }
      ],
      processedSources: {
        "raw/articles/old.md": { size: oldStat.size, mtime: oldStat.mtimeMs, fingerprint: contentFingerprint(Buffer.from("# Old\n")), digestedAt: 100 },
        "raw/articles/new.md": { size: newStat.size, mtime: newStat.mtimeMs, fingerprint: contentFingerprint(Buffer.from("# New\n")), digestedAt: 101 }
      }
    }
  }).settings.knowledgeBase;
  const staleNoNewDashboard = await buildKnowledgeBaseDashboardSnapshot(dashboardVault, staleNoNewSettings);
  assert.equal(staleNoNewDashboard.raw.changedCount, 0);
  assert.equal(staleNoNewDashboard.health.status, "healthy");
  assert.equal(staleNoNewDashboard.health.score, 100);
  assert.equal(staleNoNewDashboard.health.scoreSummary, "当前 100 分，达到 85+，显示健康。");
  assert.deepEqual(staleNoNewDashboard.health.scoreReasons, []);
  assert.equal(staleNoNewDashboard.health.scoreCheckNote, "体检成功只代表检查完成；健康分反映检查发现的结构问题。");
  assert.equal(staleNoNewDashboard.health.scoreThresholdText, "85+ 健康，60-84 风险，低于 60 异常。");
  assert.equal(staleNoNewDashboard.checkFreshness.status, "stale");
  assert.equal(staleNoNewDashboard.checkFreshness.score, 76);

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
  assert.equal(missingRulesDashboard.health.label, "异常");
  assert.ok(missingRulesDashboard.health.reasons.includes("规则文件缺失"));

  const legacyDashboard = await buildKnowledgeBaseDashboardSnapshot(dashboardVault, normalizeSettingsData({ settingsVersion: 19 }).settings.knowledgeBase);
  assert.notEqual(legacyDashboard.health.status, "bad");
  assert.ok(!legacyDashboard.health.reasons.includes("从未体检"));
  assert.equal(legacyDashboard.checkFreshness.status, "missing");
  assert.equal(legacyDashboard.checkHeatmap.at(-1)?.status, "none");

  await mkdir(path.join(dashboardVault, "outputs", "maintenance"), { recursive: true });
  await writeFile(path.join(dashboardVault, "outputs", "maintenance", "kb-check-2026-06-03.md"), [
    "# KB Check 2026-06-03",
    "",
    "| 项目 | 结果 |",
    "|---|---:|",
    "| 全 wiki 硬断链出现次数 | 40 |",
    "| 全 wiki 唯一断链目标 | 25 |",
    "| 孤儿页面 | 19 |",
    "| draft / TODO / 待补等命中文件 | 10 |",
    "| `wiki/index.md` 断链 | 0 |"
  ].join("\n"), "utf8");
  const tableReportDashboard = await buildKnowledgeBaseDashboardSnapshot(dashboardVault, normalizeSettingsData({
    settingsVersion: 19,
    knowledgeBase: {
      rulesFilePath: "AGENTS.md",
      lastReportPath: "outputs/maintenance/kb-check-2026-06-03.md",
      healthHistory: [
        { date: formatDateKeyForTest(today), status: "success", at: today.getTime() }
      ],
      processedSources: {
        "raw/articles/old.md": { size: oldStat.size, mtime: oldStat.mtimeMs, fingerprint: contentFingerprint(Buffer.from("# Old\n")), digestedAt: 100 },
        "raw/articles/new.md": { size: newStat.size, mtime: newStat.mtimeMs, fingerprint: contentFingerprint(Buffer.from("# New\n")), digestedAt: 101 }
      }
    }
  }).settings.knowledgeBase);
  assert.equal(tableReportDashboard.raw.changedCount, 0);
  assert.equal(tableReportDashboard.health.status, "bad");
  assert.equal(tableReportDashboard.health.score, 50);
  assert.ok(tableReportDashboard.health.reasons.includes("断链 40 处"));
  assert.ok(tableReportDashboard.health.reasons.includes("孤儿页面 19 个"));
  assert.ok(tableReportDashboard.health.reasons.includes("过时/草稿 10 处"));

  for (let index = 0; index < 93; index += 1) {
    await writeFile(path.join(dashboardVault, "raw", "articles", `pending-${String(index).padStart(2, "0")}.md`), `# Pending ${index}\n`, "utf8");
  }
  const lowScoreDashboard = await buildKnowledgeBaseDashboardSnapshot(dashboardVault, normalizeSettingsData({
    settingsVersion: 19,
    knowledgeBase: {
      rulesFilePath: "AGENTS.md",
      lastReportPath: "outputs/maintenance/kb-check-2026-06-03.md",
      healthHistory: [
        { date: formatDateKeyForTest(today), status: "success", at: today.getTime() }
      ],
      processedSources: {
        "raw/articles/old.md": { size: oldStat.size, mtime: oldStat.mtimeMs, fingerprint: contentFingerprint(Buffer.from("# Old\n")), digestedAt: 100 },
        "raw/articles/new.md": { size: newStat.size, mtime: newStat.mtimeMs, fingerprint: contentFingerprint(Buffer.from("# New\n")), digestedAt: 101 }
      }
    }
  }).settings.knowledgeBase);
  assert.equal(lowScoreDashboard.checkFreshness.status, "fresh");
  assert.equal(lowScoreDashboard.raw.changedCount, 93);
  assert.equal(lowScoreDashboard.health.score, 6);
  assert.equal(lowScoreDashboard.health.status, "bad");
  assert.equal(lowScoreDashboard.health.label, "异常");
  assert.equal(lowScoreDashboard.health.scoreSummary, "当前 6 分，低于 60，显示异常。");
  assert.equal(lowScoreDashboard.health.scoreCheckNote, "体检成功只代表检查完成；健康分反映检查发现的结构问题。");
  assert.deepEqual(lowScoreDashboard.health.scoreReasons.map((reason) => reason.label), ["Raw 待提炼", "断链", "孤儿页面", "过时/草稿"]);
  assert.deepEqual(lowScoreDashboard.health.scoreReasons.map((reason) => reason.count), [93, 40, 19, 10]);
  assert.ok(lowScoreDashboard.health.scoreReasons.some((reason) => reason.label === "Raw 待提炼" && reason.explanation.includes("来源未被确认消化或登记")));
  assert.ok(lowScoreDashboard.health.scoreReasons.some((reason) => reason.label === "断链" && reason.explanation.includes("链接目标不存在")));
  assert.ok(lowScoreDashboard.health.scoreReasons.some((reason) => reason.label === "孤儿页面" && reason.explanation.includes("缺少有效入口或引用")));
  assert.ok(lowScoreDashboard.health.scoreReasons.some((reason) => reason.label === "过时/草稿" && reason.explanation.includes("待补、TODO、draft")));

  const thresholdRiskReportPath = path.join(dashboardVault, "outputs", "maintenance", "kb-check-2026-06-04.md");
  await writeFile(thresholdRiskReportPath, [
    "# KB Check 2026-06-04",
    "",
    "| 项目 | 结果 |",
    "|---|---:|",
    "| 全 wiki 硬断链出现次数 | 3 |",
    "| 孤儿页面 | 0 |",
    "| draft / TODO / 待补等命中文件 | 0 |"
  ].join("\n"), "utf8");
  const thresholdRiskProcessedSources: Record<string, { size: number; mtime: number; fingerprint: string; digestedAt: number }> = {
    "raw/articles/old.md": { size: oldStat.size, mtime: oldStat.mtimeMs, fingerprint: contentFingerprint(Buffer.from("# Old\n")), digestedAt: 100 },
    "raw/articles/new.md": { size: newStat.size, mtime: newStat.mtimeMs, fingerprint: contentFingerprint(Buffer.from("# New\n")), digestedAt: 101 }
  };
  for (let index = 0; index < 93; index += 1) {
    const relativePath = `raw/articles/pending-${String(index).padStart(2, "0")}.md`;
    const fileStat = await stat(path.join(dashboardVault, relativePath));
    thresholdRiskProcessedSources[relativePath] = {
      size: fileStat.size,
      mtime: fileStat.mtimeMs,
      fingerprint: contentFingerprint(Buffer.from(`# Pending ${index}\n`)),
      digestedAt: 102 + index
    };
  }
  const thresholdRiskDashboard = await buildKnowledgeBaseDashboardSnapshot(dashboardVault, normalizeSettingsData({
    settingsVersion: 19,
    knowledgeBase: {
      rulesFilePath: "AGENTS.md",
      lastReportPath: "outputs/maintenance/kb-check-2026-06-04.md",
      healthHistory: [
        { date: formatDateKeyForTest(today), status: "success", at: today.getTime() }
      ],
      processedSources: thresholdRiskProcessedSources
    }
  }).settings.knowledgeBase);
  assert.equal(thresholdRiskDashboard.health.score, 80);
  assert.equal(thresholdRiskDashboard.health.status, "risk");
  assert.equal(thresholdRiskDashboard.health.label, "风险");
} finally {
  await rm(dashboardVault, { recursive: true, force: true });
}

const homeAllCardsVault = await mkdtemp(path.join(tmpdir(), "codex-kb-home-all-cards-"));
try {
  await mkdir(path.join(homeAllCardsVault, "raw", "articles"), { recursive: true });
  await mkdir(path.join(homeAllCardsVault, "wiki", "topic"), { recursive: true });
  await mkdir(path.join(homeAllCardsVault, "outputs"), { recursive: true });
  await mkdir(path.join(homeAllCardsVault, "inbox"), { recursive: true });
  await writeFile(path.join(homeAllCardsVault, DEFAULT_KNOWLEDGE_BASE_RULES_FILE), "# LLM Wiki Rules\n", "utf8");
  await writeFile(path.join(homeAllCardsVault, "raw", "index.md"), "# Raw\n", "utf8");
  await writeFile(path.join(homeAllCardsVault, "wiki", "index.md"), "# Wiki\n", "utf8");
  await writeFile(path.join(homeAllCardsVault, "outputs", ".ingest-tracker.md"), "# Tracker\n", "utf8");
  for (let index = 0; index < 48; index += 1) {
    await writeFile(path.join(homeAllCardsVault, "wiki", "topic", `page-${String(index).padStart(2, "0")}.md`), `# Wiki Page ${index}\n\n第 ${index} 条知识页。`, "utf8");
  }
  await writeFile(path.join(homeAllCardsVault, "raw", "articles", "source.md"), "# Source\n\nRaw source", "utf8");
  const snapshot = await buildKnowledgeBaseDashboardSnapshot(homeAllCardsVault, normalizeSettingsData({ settingsVersion: 27 }).settings.knowledgeBase);
  assert.ok(snapshot.recommendations.cards.length > 36);
  assert.equal(snapshot.recommendations.cards.filter((card) => card.kind === "wiki").length, 48);
  assert.equal(snapshot.recommendations.cards.some((card) => card.path === "wiki/index.md"), false);
  assert.ok(snapshot.recommendations.cards.every((card) => card.title && card.summary));
} finally {
  await rm(homeAllCardsVault, { recursive: true, force: true });
}

const externalMaintenanceVault = await mkdtemp(path.join(tmpdir(), "codex-kb-external-"));
try {
  await mkdir(path.join(externalMaintenanceVault, "raw", "articles", "GitHub项目收集"), { recursive: true });
  await mkdir(path.join(externalMaintenanceVault, "wiki"), { recursive: true });
  await mkdir(path.join(externalMaintenanceVault, "outputs"), { recursive: true });
  await mkdir(path.join(externalMaintenanceVault, "inbox"), { recursive: true });
  await writeFile(path.join(externalMaintenanceVault, "AGENTS.md"), "# Rules\n", "utf8");
  await writeFile(path.join(externalMaintenanceVault, DEFAULT_KNOWLEDGE_BASE_RULES_FILE), "# LLM Wiki Rules\n", "utf8");
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
  const externalOldReportDate = formatDateKeyForTest(externalOld);
  const externalReportlessDate = formatDateKeyForTest(externalYesterday);
  const externalOldReportPath = path.join(externalMaintenanceVault, "outputs", `kb-maintenance-${externalOldReportDate}.md`);
  await writeFile(externalOldReportPath, "# Earlier maintenance\n", "utf8");
  await utimes(processedRaw, externalOld, externalOld);
  await utimes(trackerPath, externalYesterday, externalYesterday);
  await utimes(newRaw, externalToday, externalToday);
  await utimes(reportPath, externalToday, externalToday);
  await utimes(externalOldReportPath, externalOld, externalOld);
  const externalDashboard = await buildKnowledgeBaseDashboardSnapshot(externalMaintenanceVault, normalizeSettingsData({
    settingsVersion: 19,
    knowledgeBase: {
      lastReportPath: "outputs/kb-maintenance-2026-05-15.md",
      maintenanceHistory: [
        { date: externalReportlessDate, status: "success", at: externalYesterday.getTime(), mode: "maintain", reportPath: "" },
        { date: formatDateKeyForTest(externalToday), status: "success", at: externalToday.getTime(), mode: "lint", reportPath: "outputs/kb-maintenance-2026-05-15.md" }
      ]
    }
  }).settings.knowledgeBase);
  assert.equal(externalDashboard.raw.changedCount, 1);
  assert.equal(externalDashboard.raw.digestStatus.pending, 1);
  assert.equal(externalDashboard.raw.digestStatus.calibration, 1);
  assert.equal(externalDashboard.tracker.trackedCount, 0);
  assert.ok(externalDashboard.health.score >= 80);
  assert.equal(externalDashboard.health.status, "risk");
  assert.ok(externalDashboard.health.reasons.some((reason) => reason.includes("Raw 状态待校准 1 个")));
  assert.ok(externalDashboard.health.reasons.some((reason) => reason.includes("断链 1 处")));
  assert.ok(externalDashboard.health.reasons.some((reason) => reason.includes("过时/草稿 1 处")));
  assert.ok(!externalDashboard.health.reasons.includes("从未体检"));
  assert.equal(externalDashboard.health.lastCheckAt, externalToday.getTime());
  assert.equal(externalDashboard.checkFreshness.status, "fresh");
  assert.equal(externalDashboard.checkHeatmap.find((day) => day.date === formatDateKeyForTest(externalToday))?.status, "success");
  assert.equal(externalDashboard.checkHeatmap.find((day) => day.date === externalReportlessDate)?.status, "success");
  assert.equal(externalDashboard.checkHeatmap.find((day) => day.date === externalOldReportDate)?.status, "none");
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

async function createMaintenanceVaultForTest(prefix: string): Promise<string> {
  const vaultPath = await mkdtemp(path.join(tmpdir(), prefix));
  await mkdir(path.join(vaultPath, "raw", "articles"), { recursive: true });
  await mkdir(path.join(vaultPath, "wiki"), { recursive: true });
  await mkdir(path.dirname(path.join(vaultPath, DEFAULT_KNOWLEDGE_BASE_RULES_FILE)), { recursive: true });
  await writeFile(path.join(vaultPath, DEFAULT_KNOWLEDGE_BASE_RULES_FILE), "# LLM Wiki Rules\n", "utf8");
  await writeFile(path.join(vaultPath, "raw", "index.md"), "# Raw\n", "utf8");
  await writeFile(path.join(vaultPath, "wiki", "index.md"), "# Wiki\n", "utf8");
  await writeFile(path.join(vaultPath, "raw", "articles", "new.md"), "# New\n\n正文", "utf8");
  return vaultPath;
}

function makeKnowledgeBaseManagerForTest(
  vaultPath: string,
  options: {
    failSaveCall?: number;
    cancelBeforeSaveCall?: number;
    cancelViaManagerBeforeSaveCall?: number;
    agentBackend?: "codex-cli" | "opencode";
    beforeAgentReturn?: () => Promise<void>;
    codexTaskCalls?: Array<{ permission: string; writeScope: string }>;
    openCodeTaskCalls?: Array<{ permission: string }>;
    useRealOpenCodeTask?: boolean;
    throwOnDashboardRefresh?: boolean;
    throwOnGetVaultPath?: boolean;
  } = {}
) {
  const settings = normalizeSettingsData({
    settingsVersion: DEFAULT_SETTINGS.settingsVersion,
    agentBackend: options.agentBackend ?? "codex-cli",
    knowledgeBase: {
      backend: "default",
      useCustomRulesFile: true,
      rulesFilePath: DEFAULT_KNOWLEDGE_BASE_RULES_FILE
    }
  }).settings;
  let saveCalls = 0;
  let manager: KnowledgeBaseManager | null = null;
  const plugin = {
    settings,
    getVaultPath: () => {
      if (options.throwOnGetVaultPath) throw new Error("vault path unavailable");
      return vaultPath;
    },
    saveSettings: async () => {
      saveCalls += 1;
      if (options.cancelViaManagerBeforeSaveCall === saveCalls && manager) {
        await manager.cancelMaintenance();
      }
      if (options.cancelBeforeSaveCall === saveCalls && manager) {
        (manager as any).cancelRequested = true;
      }
      if (options.failSaveCall === saveCalls) {
        throw new Error(`saveSettings failed at call ${saveCalls}`);
      }
    },
    getCodexView: () => ({
      refreshKnowledgeBaseDashboard: () => {
        if (options.throwOnDashboardRefresh) throw new Error("dashboard refresh failed");
      }
    }),
    getReviewManager: () => null,
    externalizeMessageText: async () => undefined,
    pruneKnowledgeBaseHistoryByRetention: async () => ({ removedDayCount: 0, removedMessageCount: 0 }),
    activateKnowledgeBaseChannel: async () => undefined,
    addCommand: () => undefined,
    addRibbonIcon: () => undefined,
    registerInterval: () => undefined,
    app: {
      workspace: {
        onLayoutReady: () => undefined,
        getActiveFile: () => null
      }
    }
  };
  manager = new KnowledgeBaseManager(plugin as any);
  (manager as any).runCodexKnowledgeTask = async (_prompt: string, _sources: unknown[], permission: string, writeScope: string) => {
    options.codexTaskCalls?.push({ permission, writeScope });
    await options.beforeAgentReturn?.();
    return "Agent 输出：维护完成。";
  };
  if (!options.useRealOpenCodeTask) {
    (manager as any).runOpenCodeKnowledgeTask = async (_prompt: string, _sources: unknown[], permission: string) => {
      options.openCodeTaskCalls?.push({ permission });
      await options.beforeAgentReturn?.();
      return "Agent 输出：维护完成。";
    };
  }
  return { manager, settings, saveCalls: () => saveCalls };
}

async function fileExists(filePath: string): Promise<boolean> {
  return stat(filePath).then(() => true, () => false);
}

await runKnowledgeBasePerformanceTests();

console.log("All tests passed");
