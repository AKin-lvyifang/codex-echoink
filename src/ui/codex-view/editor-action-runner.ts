import { Notice } from "obsidian";
import { newId, resolveEditorActionModeConfig } from "../../settings/settings";
import { buildEditorActionPrompt, buildEditorActionReviewPrompt } from "../../editor-actions/prompt";
import { buildEditorActionTurnOptions } from "../../editor-actions/turn-options";
import { buildArticleUnderstandingPrompt, makeArticleUnderstandingCacheEntry, resolveArticleUnderstandingCache, upsertArticleUnderstandingCache } from "../../editor-actions/summary-cache";
import type { ArticleUnderstandingEntry, EditorActionQualityMode, EditorActionRequest } from "../../editor-actions/types";
import { cleanEditorActionOutput, validateEditorActionCandidateText } from "../../editor-actions/output";
import type { ArticleUnderstandingPanelState } from "./header";

export async function sendEditorActionRequest(view: any, request: EditorActionRequest): Promise<string> {
  if (view.editorSummaryRun) view.cancelEditorSummaryRun("写作操作抢占文章理解");
  const blockReason = view.editorActionStartBlockReason();
  if (blockReason) throw new Error(blockReason);
  const harnessRunId = newId("editor-action-harness");
  view.editorActionHarnessRunId = harnessRunId;
  const timeoutMs = editorActionTimeoutForMode(view.plugin.settings.editorActions.timeoutMs, request.qualityMode);
  const requestStartedAt = Date.now();
  try {
    setArticleUnderstandingPanelState(view, {
      status: request.qualityMode === "fast" ? "idle" : "missing",
      source: request.source,
      mode: request.qualityMode,
      modeLabel: request.modeConfig.label,
      model: request.modeConfig.model,
      usedInLastRun: false
    });
    view.setEditorActionStatus({ status: "connecting", actionLabel: request.action.label, qualityMode: request.qualityMode, modeLabel: request.modeConfig.label, filePath: request.source.filePath, model: request.modeConfig.model, startedAt: requestStartedAt });
    const status = await view.withEditorActionTimeout(view.plugin.ensureCodexConnected(false, { silent: true }), timeoutMs, "写作操作连接超时");
    view.applyStatus();
    if (!status.connected) throw new Error(status.errors[0] || "Codex 未连接");

    const availableModels = status.models.map((model: any) => model.model);
    const model = view.effectiveEditorActionModel(availableModels, request.modeConfig.model);
    const understanding = await ensureArticleUnderstanding(view, request, availableModels, model, timeoutMs);
    const snapshot = understanding
      ? {
        ...request.snapshot,
        articleUnderstanding: understanding.understanding,
        articleUnderstandingState: view.articleUnderstandingPanelState.status === "reused" ? "reusable" as const : "fresh" as const
      }
      : request.snapshot;
    const contextChars = request.snapshot.beforeContext.length + request.snapshot.afterContext.length;
    const debugMessage = `${request.modeConfig.label} · 模型 ${model} · 上下文 ${contextChars} 字 · 超时 ${Math.round(timeoutMs / 1000)}s`;
    let result = await runEditorActionPromptTurn(view, {
      prompt: buildEditorActionPrompt({ action: request.action, style: request.style, snapshot, qualityMode: request.qualityMode, modeLabel: request.modeConfig.label }),
      actionLabel: request.action.label,
      qualityMode: request.qualityMode,
      modeLabel: request.modeConfig.label,
      model,
      phase: "generating",
      statusMessage: debugMessage,
      timeoutMs,
      startedAt: requestStartedAt
    });
    if (request.qualityMode === "strict") {
      const candidateText = cleanEditorActionOutput(result);
      const candidateValidation = validateEditorActionCandidateText(candidateText);
      if (!candidateValidation.ok) throw new Error(candidateValidation.reason);
      result = await runEditorActionPromptTurn(view, {
        prompt: buildEditorActionReviewPrompt({ action: request.action, style: request.style, snapshot, qualityMode: request.qualityMode, modeLabel: request.modeConfig.label, candidateText }),
        actionLabel: request.action.label,
        qualityMode: request.qualityMode,
        modeLabel: request.modeConfig.label,
        model,
        phase: "reviewing",
        statusMessage: `${request.modeConfig.label}审校中`,
        timeoutMs: Math.max(45000, Math.min(timeoutMs, 90000)),
        startedAt: requestStartedAt
      });
    }
    view.prewarmEditorActionThread();
    return result;
  } catch (error) {
    const diagnostic = view.diagnoseCodexFailure(error);
    view.rejectEditorActionRun(new Error(diagnostic.text));
    view.running = false;
    view.activeTurnId = "";
    view.editorActionActiveTimeoutMs = 0;
    view.clearTurnWatchdog();
    view.clearActiveRun();
    view.editorActionCurrentItemIds.clear();
    view.applyStatus();
    setArticleUnderstandingPanelState(view, { ...view.articleUnderstandingPanelState, status: "failed", error: diagnostic.text });
    view.prewarmEditorActionThread();
    throw error;
  } finally {
    if (view.editorActionHarnessRunId === harnessRunId) view.editorActionHarnessRunId = "";
  }
}

export async function ensureArticleUnderstanding(
  view: any,
  request: EditorActionRequest,
  availableModels: string[],
  model: string,
  timeoutMs: number,
  forceRefresh = false
): Promise<ArticleUnderstandingEntry | null> {
  if (request.qualityMode === "fast") {
    setArticleUnderstandingPanelState(view, {
      status: "idle",
      source: request.source,
      mode: request.qualityMode,
      modeLabel: request.modeConfig.label,
      model,
      entry: null,
      usedInLastRun: false
    });
    return null;
  }
  const settings = view.plugin.settings.editorActions;
  const cached = forceRefresh ? { state: "stale" as const, entry: null } : resolveArticleUnderstandingCache(settings.articleUnderstandingCache, request.source, request.qualityMode, model);
  if (!forceRefresh && cached.entry && (cached.state === "fresh" || cached.state === "reusable")) {
    setArticleUnderstandingPanelState(view, {
      status: cached.state === "fresh" ? "fresh" : "reused",
      source: request.source,
      mode: request.qualityMode,
      modeLabel: request.modeConfig.label,
      model,
      entry: cached.entry,
      usedInLastRun: true
    });
    return cached.entry;
  }

  setArticleUnderstandingPanelState(view, {
    status: "running",
    source: request.source,
    mode: request.qualityMode,
    modeLabel: request.modeConfig.label,
    model,
    entry: null,
    usedInLastRun: false
  });
  const understandingRaw = await runEditorActionPromptTurn(view, {
    prompt: buildArticleUnderstandingPrompt(request.source),
    actionLabel: "理解文章",
    qualityMode: request.qualityMode,
    modeLabel: request.modeConfig.label,
    model: view.effectiveEditorActionModel(availableModels, model),
    phase: "understanding",
    statusMessage: `${request.modeConfig.label} · 正在理解文章`,
    timeoutMs: Math.max(45000, Math.min(timeoutMs, 90000)),
    startedAt: Date.now()
  });
  const understanding = cleanEditorActionOutput(understandingRaw);
  if (!understanding.trim()) throw new Error("文章理解为空");
  const entry = makeArticleUnderstandingCacheEntry(request.source, understanding, request.qualityMode, model);
  settings.articleUnderstandingCache = upsertArticleUnderstandingCache(settings.articleUnderstandingCache, entry);
  await view.plugin.saveSettings();
  setArticleUnderstandingPanelState(view, {
    status: "fresh",
    source: request.source,
    mode: request.qualityMode,
    modeLabel: request.modeConfig.label,
    model,
    entry,
    usedInLastRun: true
  });
  return entry;
}

export async function runEditorActionPromptTurn(view: any, input: {
  prompt: string;
  actionLabel: string;
  qualityMode: EditorActionQualityMode;
  modeLabel: string;
  model: string;
  phase: "understanding" | "generating" | "reviewing";
  statusMessage: string;
  timeoutMs: number;
  startedAt: number;
}): Promise<string> {
  const runId = newId(`editor-${input.phase}-run`);
  view.editorActionCurrentItemIds.clear();
  const waitForResult = new Promise<string>((resolve, reject) => {
    view.editorActionRun = { runId, text: "", resolve, reject };
  });
  const turnOptions = buildEditorActionTurnOptions({
    model: input.model,
    serviceTier: view.selectedServiceTier,
    timeoutMs: input.timeoutMs,
    workspaceResources: { plugins: {}, mcpServers: {}, skills: {} }
  });
  try {
    view.activeRunId = runId;
    view.activeRunSessionId = "";
    view.activeRunKind = "chat";
    view.running = true;
    view.editorActionThreadId = await view.takeEditorActionThread(turnOptions);
    view.editorActionThreadIds.add(view.editorActionThreadId);
    view.setEditorActionStatus({ status: "generating", actionLabel: input.actionLabel, qualityMode: input.qualityMode, modeLabel: input.modeLabel, phase: input.phase, model: input.model, message: input.statusMessage, startedAt: input.startedAt });
    view.applyStatus();
    view.activeTurnId = await view.plugin.codex!.startTurn(view.editorActionThreadId, [{ type: "text", text: input.prompt, text_elements: [] }], turnOptions);
    view.editorActionTurnIds.add(view.activeTurnId);
    view.armTurnWatchdog(input.timeoutMs, `${input.actionLabel}超时，请重试`);
    const result = await view.withEditorActionTimeout(waitForResult, input.timeoutMs, `${input.actionLabel}超时，请重试`);
    const cleaned = cleanEditorActionOutput(result);
    const validation = validateEditorActionCandidateText(cleaned);
    if (!validation.ok) throw new Error(validation.reason);
    view.resolveEditorActionRun(cleaned);
    view.setEditorActionStatus({ status: "awaiting-confirm", actionLabel: input.actionLabel, qualityMode: input.qualityMode, modeLabel: input.modeLabel, model: input.model, message: "候选已生成，等待确认", startedAt: input.startedAt });
    return cleaned;
  } catch (error) {
    view.rejectEditorActionRun(error instanceof Error ? error : new Error(String(error)));
    throw error;
  } finally {
    view.running = false;
    view.activeTurnId = "";
    view.editorActionActiveTimeoutMs = 0;
    view.clearTurnWatchdog();
    view.clearActiveRun();
    view.releaseEditorActionRunLock(runId);
    view.applyStatus();
  }
}

export function setArticleUnderstandingPanelState(view: any, state: ArticleUnderstandingPanelState): void {
  view.articleUnderstandingPanelState = state;
  view.renderEditorActionStatus();
}

export async function refreshArticleUnderstandingPanelSourceState(view: any): Promise<void> {
  const settings = view.plugin.settings.editorActions;
  const source = await currentArticleUnderstandingSource(view);
  if (!source) {
    setArticleUnderstandingPanelState(view, { status: "idle", usedInLastRun: false });
    return;
  }
  const mode = settings.qualityMode;
  const modeConfig = resolveEditorActionModeConfig(settings, mode);
  const model = view.effectiveEditorActionModel(view.activeProviderModels(), modeConfig.model);
  const cached = resolveArticleUnderstandingCache(settings.articleUnderstandingCache, source, mode, model);
  const status = mode === "fast"
    ? "idle"
    : cached.state === "fresh"
      ? "fresh"
      : cached.state === "reusable"
        ? "reused"
        : cached.state === "stale"
          ? "stale"
          : "missing";
  setArticleUnderstandingPanelState(view, {
    status,
    source,
    mode,
    modeLabel: modeConfig.label,
    model,
    entry: cached.entry,
    usedInLastRun: false
  });
}

export async function refreshArticleUnderstandingFromPanel(view: any): Promise<void> {
  const source = await currentArticleUnderstandingSource(view);
  if (!source) {
    new Notice("当前没有可理解的笔记");
    return;
  }
  const settings = view.plugin.settings.editorActions;
  const mode = settings.qualityMode === "fast" ? "quality" : settings.qualityMode;
  const modeConfig = resolveEditorActionModeConfig(settings, mode);
  const status = await view.withEditorActionTimeout(view.plugin.ensureCodexConnected(false, { silent: true }), settings.timeoutMs, "连接 Codex 超时");
  if (!status.connected) throw new Error(status.errors[0] || "Codex 未连接");
  const model = view.effectiveEditorActionModel(status.models.map((item: any) => item.model), modeConfig.model);
  const request: EditorActionRequest = {
    id: newId("article-understanding-refresh"),
    action: settings.actions[0],
    style: settings.styles[0],
    source,
    snapshot: {
      filePath: source.filePath,
      fileName: source.fileName,
      fromOffset: 0,
      toOffset: 0,
      from: { line: 0, ch: 0 },
      to: { line: 0, ch: 0 },
      selectedText: "",
      beforeContext: source.text,
      afterContext: ""
    },
    qualityMode: mode,
    modeConfig,
    prompt: "",
    createdAt: Date.now()
  };
  try {
    await ensureArticleUnderstanding(view, request, status.models.map((item: any) => item.model), model, editorActionTimeoutForMode(settings.timeoutMs, mode), true);
  } catch (error) {
    const diagnostic = view.diagnoseCodexFailure(error);
    setArticleUnderstandingPanelState(view, {
      status: "failed",
      source,
      mode,
      modeLabel: modeConfig.label,
      model,
      error: diagnostic.text,
      usedInLastRun: false
    });
    new Notice(`文章理解失败：${diagnostic.title}`);
  }
}

export async function currentArticleUnderstandingSource(view: any) {
  const active = view.app.workspace.getActiveViewOfType((await import("obsidian")).MarkdownView);
  if (!active?.file) return null;
  const text = active.editor.getValue();
  if (!text.trim()) return null;
  const stat = active.file.stat;
  return {
    filePath: active.file.path,
    fileName: active.file.basename,
    text,
    mtime: stat.mtime,
    size: stat.size
  };
}

function editorActionTimeoutForMode(baseTimeoutMs: number, mode: EditorActionQualityMode): number {
  if (mode === "strict") return Math.max(baseTimeoutMs, 120000);
  if (mode === "quality") return Math.max(baseTimeoutMs, 90000);
  return baseTimeoutMs;
}
