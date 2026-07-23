import { Notice } from "obsidian";
import { runPromptEnhancer } from "../../prompt-enhancer/service";
import { clearPromptEnhanceReview, renderPromptEnhanceReview } from "./composer";
import type { CodexViewPromptEnhanceContext } from "./runner-context";

export async function enhanceChatInput(view: CodexViewPromptEnhanceContext): Promise<void> {
  const settings = view.plugin.settings.promptEnhancer;
  if (!settings.enabled) {
    new Notice("增强提示词未启用");
    return;
  }
  if (view.normalTaskRunning || view.promptEnhancerRunning) {
    new Notice("当前已有任务运行中");
    return;
  }
  const originalInput = view.inputEl.value;
  if (!originalInput.trim()) {
    new Notice("请先输入要增强的文本");
    return;
  }
  if (originalInput.length > settings.maxInputChars) {
    new Notice(`输入过长，请控制在 ${settings.maxInputChars} 字以内`);
    return;
  }
  const lifecycle = view.captureViewLifecycle();
  if (lifecycle.signal.aborted) return;

  clearPromptEnhanceReview(view.promptEnhanceReviewEl);
  view.promptEnhancerRunning = true;
  view.promptEnhancerRunId = "";
  view.promptEnhancerTurnId = "";
  view.applyStatus();
  new Notice("正在增强提示词");
  let runId = "";
  try {
    const enhanced = await runPromptEnhancer({
      plugin: view.plugin,
      prompt: originalInput,
      signal: lifecycle.signal,
      onRunCreated: (createdRunId) => {
        if (!isCurrentViewLifecycle(view, lifecycle)) return;
        runId = createdRunId;
        view.promptEnhancerRunId = createdRunId;
      },
      onTurnStarted: (turnId) => {
        if (
          isCurrentViewLifecycle(view, lifecycle)
          && view.promptEnhancerRunId === runId
        ) {
          view.promptEnhancerTurnId = turnId;
        }
      }
    });
    if (
      !isCurrentViewLifecycle(view, lifecycle)
      || view.promptEnhancerRunId !== runId
    ) {
      return;
    }
    view.inputEl.value = enhanced;
    view.inputEl.setSelectionRange(enhanced.length, enhanced.length);
    view.onInputChanged();
    renderPromptEnhanceReview(view.promptEnhanceReviewEl, {
      onRestore: () => {
        view.inputEl.value = originalInput;
        view.inputEl.setSelectionRange(originalInput.length, originalInput.length);
        clearPromptEnhanceReview(view.promptEnhanceReviewEl);
        view.onInputChanged();
        view.focusInput();
        new Notice("已恢复原输入");
      }
    });
    view.focusInput();
    new Notice("提示词已增强，可编辑后发送");
  } catch (error) {
    if (
      isCurrentViewLifecycle(view, lifecycle)
      && (!runId || view.promptEnhancerRunId === runId)
    ) {
      new Notice(`增强失败：${error instanceof Error ? error.message : String(error)}`);
    }
  } finally {
    if (
      isCurrentViewLifecycle(view, lifecycle)
      && (!runId || view.promptEnhancerRunId === runId)
    ) {
      view.promptEnhancerRunning = false;
      view.promptEnhancerRunId = "";
      view.promptEnhancerTurnId = "";
      view.applyStatus();
    }
  }
}

function isCurrentViewLifecycle(
  view: CodexViewPromptEnhanceContext,
  lifecycle: ReturnType<CodexViewPromptEnhanceContext["captureViewLifecycle"]>
): boolean {
  return (
    !lifecycle.signal.aborted
    && view.captureViewLifecycle().generation === lifecycle.generation
  );
}
