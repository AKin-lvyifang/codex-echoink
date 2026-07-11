import { Notice, type Editor, type MarkdownFileInfo, type MarkdownView, type Menu } from "obsidian";
import type CodexForObsidianPlugin from "../main";
import { newId, resolveEditorActionModeConfig } from "../settings/settings";
import { cleanEditorActionOutput, validateEditorActionCandidateText } from "./output";
import { buildEditorActionPrompt, resolveEditorActionStyle } from "./prompt";
import { buildEditorActionSelectionSnapshot, confirmEditorActionCandidate, editorActionCandidateInvalidationReason, editorActionCandidateReplacementRange, enabledEditorActionConfigs, validateEditorActionSelection } from "./selection";
import { createEditorActionExtension, setEditorActionCandidate } from "./editor-extension";
import { resolveArticleUnderstandingCache, type EditorActionSummarySource } from "./summary-cache";
import type { EditorActionCandidate, EditorActionRequest, EditorAiActionConfig } from "./types";

export class EditorActionController {
  private active: { editor: Editor; candidate: EditorActionCandidate } | null = null;
  private confirming = false;

  constructor(private readonly plugin: CodexForObsidianPlugin) {}

  register(): void {
    this.plugin.registerEditorExtension(createEditorActionExtension({
      confirm: () => this.confirmActiveCandidate(),
      cancel: () => this.cancelActiveCandidate("canceled", true)
    }));
    this.plugin.app.workspace.updateOptions();
    this.plugin.registerEvent(this.plugin.app.workspace.on("editor-menu", (menu, editor, info) => this.onEditorMenu(menu, editor, info)));
    this.plugin.registerEvent(this.plugin.app.workspace.on("editor-change", (editor) => {
      if (!this.active || this.active.editor !== editor || this.confirming) return;
      const reason = editorActionCandidateInvalidationReason(editor.getValue(), this.active.candidate);
      if (reason) this.cancelActiveCandidate("canceled", false, "正文已变化，候选已取消");
    }));
    this.plugin.registerEvent(this.plugin.app.workspace.on("active-leaf-change", () => {
      if (!this.active) return;
      const activeFilePath = this.plugin.app.workspace.getActiveFile()?.path;
      if (activeFilePath && activeFilePath !== this.active.candidate.filePath) {
        this.cancelActiveCandidate("canceled", false, "已切换文件，候选已取消");
      }
    }));
  }

  cancelActiveCandidate(status: "canceled" | "failed" = "canceled", showNotice = false, message?: string): boolean {
    if (!this.active) return false;
    setEditorActionCandidate(this.active.editor, null);
    this.active = null;
    this.plugin.getCodexView()?.setEditorActionStatus({ status, message: message ?? (status === "failed" ? "候选已失效" : "已取消") });
    if (showNotice) new Notice("已取消 Agent 候选");
    return true;
  }

  private onEditorMenu(menu: Menu, editor: Editor, info: MarkdownView | MarkdownFileInfo): void {
    const settings = this.plugin.settings.editorActions;
    if (!settings.enabled) return;
    const actions = enabledEditorActionConfigs(settings);
    if (!actions.length) return;
    const selectedText = editor.getSelection();
    const validation = validateEditorActionSelection({
      selectedText,
      selectionCount: editor.listSelections().length,
      maxSelectedChars: settings.maxSelectedChars
    });
    if (!validation.ok) return;
    menu.addSeparator();
    for (const action of actions) {
      menu.addItem((item) => {
        item
          .setTitle(`EchoInk：${action.label}`)
          .setIcon(actionIcon(action.id))
          .onClick(() => void this.runEditorAction(editor, info, action));
      });
    }
  }

  private async runEditorAction(editor: Editor, info: MarkdownView | MarkdownFileInfo, action: EditorAiActionConfig): Promise<void> {
    const settings = this.plugin.settings.editorActions;
    const selectedText = editor.getSelection();
    const validation = validateEditorActionSelection({
      selectedText,
      selectionCount: editor.listSelections().length,
      maxSelectedChars: settings.maxSelectedChars
    });
    if (!validation.ok) {
      new Notice(validation.reason);
      return;
    }
    const filePath = info.file?.path ?? "当前笔记";
    const from = editor.getCursor("from");
    const to = editor.getCursor("to");
    const fullText = editor.getValue();
    const summarySource: EditorActionSummarySource = {
      filePath,
      fileName: info.file?.name ?? filePath.split("/").pop() ?? "当前笔记",
      text: fullText,
      mtime: info.file?.stat.mtime ?? 0,
      size: info.file?.stat.size ?? fullText.length
    };
    const qualityMode = settings.qualityMode;
    const modeConfig = resolveEditorActionModeConfig(settings, qualityMode);
    const articleUnderstanding = qualityMode === "fast"
      ? { state: "missing" as const, entry: null }
      : resolveArticleUnderstandingCache(settings.articleUnderstandingCache, summarySource, qualityMode, modeConfig.model);
    const snapshot = buildEditorActionSelectionSnapshot({
      fullText,
      fromOffset: editor.posToOffset(from),
      toOffset: editor.posToOffset(to),
      from,
      to,
      contextCharsBefore: modeConfig.contextCharsBefore,
      contextCharsAfter: modeConfig.contextCharsAfter,
      filePath,
      articleUnderstanding: articleUnderstanding.entry?.understanding,
      articleUnderstandingState: articleUnderstanding.entry ? articleUnderstanding.state : undefined
    });
    const style = resolveEditorActionStyle(settings);
    const prompt = buildEditorActionPrompt({ action, style, snapshot, qualityMode, modeLabel: modeConfig.label });
    const request: EditorActionRequest = {
      id: newId("editor-action"),
      action,
      style,
      snapshot,
      source: summarySource,
      qualityMode,
      modeConfig,
      prompt,
      createdAt: Date.now()
    };

    this.cancelActiveCandidate("canceled", false);
    await this.plugin.activateView();
    const view = this.plugin.getCodexView();
    if (!view) {
      new Notice("无法打开 EchoInk Agent 侧栏");
      return;
    }

    try {
      view.setEditorActionStatus({ status: "preparing", actionLabel: action.label, startedAt: Date.now() });
      const raw = await view.sendEditorActionRequest(request);
      const candidateText = cleanEditorActionOutput(raw);
      const candidateValidation = validateEditorActionCandidateText(candidateText);
      if (!candidateValidation.ok) throw new Error(candidateValidation.reason);
      const candidate: EditorActionCandidate = {
        id: newId("candidate"),
        actionId: action.id,
        filePath,
        fromOffset: snapshot.fromOffset,
        toOffset: snapshot.toOffset,
        originalText: snapshot.selectedText,
        candidateText,
        documentLength: editor.getValue().length,
        createdAt: Date.now()
      };
      if (!setEditorActionCandidate(editor, candidate)) throw new Error("当前编辑器不支持灰色候选预览");
      this.active = { editor, candidate };
      view.setEditorActionStatus({ status: "awaiting-confirm", actionLabel: action.label, message: "Enter 确认 / Esc 取消" });
      editor.focus();
    } catch (error) {
      view.setEditorActionStatus({ status: "failed", actionLabel: action.label, error: error instanceof Error ? error.message : String(error) });
      new Notice(`Agent ${action.label}失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  runEditorActionById(editor: Editor, info: MarkdownView | MarkdownFileInfo, actionId: string): Promise<void> {
    const action = enabledEditorActionConfigs(this.plugin.settings.editorActions).find((item) => item.id === actionId);
    if (!action) {
      new Notice("这个 Agent 写作操作未启用");
      return Promise.resolve();
    }
    return this.runEditorAction(editor, info, action);
  }

  private confirmActiveCandidate(): boolean {
    if (!this.active) return false;
    const { editor, candidate } = this.active;
    const confirmed = confirmEditorActionCandidate(editor.getValue(), candidate);
    if (!confirmed.ok) {
      this.cancelActiveCandidate("failed", false);
      new Notice(confirmed.reason);
      return true;
    }
    this.confirming = true;
    try {
      const range = editorActionCandidateReplacementRange(candidate);
      setEditorActionCandidate(editor, null);
      editor.replaceRange(candidate.candidateText, editor.offsetToPos(range.fromOffset), editor.offsetToPos(range.toOffset), "codex-editor-action");
      this.active = null;
      const message = confirmedActionMessage(candidate.actionId);
      this.plugin.getCodexView()?.setEditorActionStatus({ status: "confirmed", message });
      new Notice(confirmedActionNotice(candidate.actionId));
    } finally {
      this.confirming = false;
    }
    return true;
  }
}

function actionIcon(actionId: string): string {
  if (actionId === "expand") return "text";
  if (actionId === "continue") return "forward";
  if (actionId === "translate") return "languages";
  if (actionId === "enhance") return "sparkles";
  return "wand-sparkles";
}

function confirmedActionMessage(actionId: string): string {
  if (actionId === "continue") return "已续写";
  if (actionId === "translate") return "已翻译";
  if (actionId === "enhance") return "已增强";
  return "已替换";
}

function confirmedActionNotice(actionId: string): string {
  if (actionId === "continue") return "已插入 Agent 续写";
  if (actionId === "translate") return "已替换为英文译文";
  if (actionId === "enhance") return "已替换为增强提示词";
  return "已替换为 Agent 候选";
}
