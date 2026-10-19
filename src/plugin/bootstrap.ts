import { TodoPageView, TODO_PAGE_VIEW_TYPE } from "../home/todo-page";
import { EchoInkJournalView, VIEW_TYPE_ECHOINK_JOURNAL } from "../home/journal-page";
import { Notice, Platform, type WorkspaceLeaf } from "obsidian";
import type CodexForObsidianPlugin from "../main";
import { EchoInkHomeView, EchoInkLegacyHomeView, VIEW_TYPE_ECHOINK_HOME } from "../home/home-view";
import { EchoInkWorkbenchView } from "../home/workbench-view";
import { getWorkbenchDataService } from "../home/workbench-data";
import { EchoInkKnowledgeSurfaceService } from "./knowledge-surface-service";
import { ReviewManager } from "../review/manager";
import { ReviewPreviewView, VIEW_TYPE_REVIEW_PREVIEW } from "../review/preview-view";
import { CodexSettingTab } from "../settings/settings-tab";
import { CodexView, VIEW_TYPE_CODEX } from "../ui/codex-view";
import {
  captureTranslationSelection,
  replaceTranslationSelectionIfUnchanged
} from "../editor-actions/translation-selection";

import { SelectionAskController } from "../selection-ask/controller";

export interface EchoInkPluginControllers {
  selectionAsk: SelectionAskController;
  knowledgeBase: EchoInkKnowledgeSurfaceService;
  review: ReviewManager;
}

export function registerEchoInkPluginFeatures(plugin: CodexForObsidianPlugin): EchoInkPluginControllers {
  plugin.registerView(VIEW_TYPE_CODEX, (leaf: WorkspaceLeaf) => new CodexView(leaf, plugin));
  plugin.registerView(VIEW_TYPE_ECHOINK_HOME, (leaf: WorkspaceLeaf) => Platform.isDesktopApp
    ? new EchoInkWorkbenchView(leaf, plugin) : new EchoInkHomeView(leaf, plugin));
  if (Platform.isDesktopApp) {
    plugin.registerView(TODO_PAGE_VIEW_TYPE, (leaf: WorkspaceLeaf) => new TodoPageView(leaf, plugin));
    plugin.registerView(VIEW_TYPE_ECHOINK_JOURNAL, (leaf: WorkspaceLeaf) => new EchoInkJournalView(leaf, plugin));
    plugin.registerView("echoink-legacy-home", (leaf: WorkspaceLeaf) => new EchoInkLegacyHomeView(leaf, plugin));
    const workbench = getWorkbenchDataService(plugin);
    plugin.register(() => workbench.dispose());
  }
  plugin.registerView(VIEW_TYPE_REVIEW_PREVIEW, (leaf: WorkspaceLeaf) => new ReviewPreviewView(leaf, plugin));

  const ribbonAnchor = plugin.addRibbonIcon("feather", Platform.isDesktopApp ? "打开 EchoInk 工作台和 Agent 侧栏" : "打开 EchoInk 首页和 Agent 侧栏", () => {
    void (async () => {
      await plugin.activateHomeAndSidebar();
      await plugin.handleEchoInkOnboardingTargetActivated("sidebar");
    })();
  });
  plugin.setEchoInkOnboardingRibbonAnchor(ribbonAnchor);

  plugin.addCommand({
    id: "open-echoink-home",
    name: Platform.isDesktopApp ? "打开 EchoInk 工作台" : "打开 EchoInk 首页",
    callback: () => void plugin.activateHomeView()
  });
  plugin.addCommand({
    id: "open-codex-sidebar",
    name: "打开 EchoInk Agent 侧栏",
    callback: () => void plugin.activateView()
  });
  plugin.addCommand({
    id: "toggle-quick-chat-window",
    name: "全局 AI 小窗：显示/收起",
    callback: () => void plugin.toggleQuickChatWindow()
  });
  plugin.addCommand({
    id: "new-codex-chat",
    name: "新建 Agent 会话",
    callback: async () => {
      await plugin.activateView();
      new Notice("已打开 EchoInk Agent，可点击 + 新建会话");
    }
  });
  const settingTab = new CodexSettingTab(plugin);
  plugin.setSettingsTabInstance(settingTab);
  plugin.addSettingTab(settingTab);
  plugin.registerEvent(plugin.app.workspace.on(
    "editor-menu",
    (menu, editor) => {
      const snapshot = captureTranslationSelection(editor);
      if (!snapshot) return;
      menu.addItem((item) => item
        .setTitle("翻译成英文")
        .setIcon("languages")
        .onClick(() => {
          void (async () => {
            try {
              const translation = await plugin.translateEditorSelectionToEnglish(
                snapshot.text
              );
              if (!replaceTranslationSelectionIfUnchanged(
                editor,
                snapshot,
                translation
              )) {
                new Notice("正文或选区已变化，未写入翻译结果。");
              }
            } catch (error) {
              new Notice(error instanceof Error
                ? error.message
                : "翻译失败，正文未修改。");
            }
          })();
        }));
    }
  ));

  const knowledgeBase = new EchoInkKnowledgeSurfaceService(plugin);
  const review = new ReviewManager(plugin);
  review.register();

  const selectionAsk = new SelectionAskController(plugin);
  selectionAsk.register();
  return { knowledgeBase, review, selectionAsk };
}

export function registerEchoInkStartupTasks(plugin: CodexForObsidianPlugin): void {
  if (plugin.shouldAutoOpenEchoInkOnboarding()) {
    plugin.app.workspace.onLayoutReady(() => void plugin.openPendingEchoInkOnboarding());
    // The first two guide steps deliberately wait for real user clicks. Do not
    // let the normal auto-open preferences skip those controls underneath it.
    return;
  }
  if (plugin.settings.autoOpen) {
    plugin.app.workspace.onLayoutReady(() => void plugin.activateView());
  }
  if (plugin.settings.autoOpenHome) {
    plugin.app.workspace.onLayoutReady(() => void plugin.activateHomeView());
  }
}
