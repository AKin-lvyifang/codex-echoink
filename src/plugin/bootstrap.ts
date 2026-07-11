import { Notice, type WorkspaceLeaf } from "obsidian";
import type CodexForObsidianPlugin from "../main";
import { EditorActionController } from "../editor-actions/controller";
import { EchoInkHomeView, VIEW_TYPE_ECHOINK_HOME } from "../home/home-view";
import { KnowledgeBaseManager } from "../knowledge-base/manager";
import { ReviewManager } from "../review/manager";
import { ReviewPreviewView, VIEW_TYPE_REVIEW_PREVIEW } from "../review/preview-view";
import { CodexSettingTab } from "../settings/settings-tab";
import { CodexView, VIEW_TYPE_CODEX } from "../ui/codex-view";

export interface EchoInkPluginControllers {
  editorActions: EditorActionController;
  knowledgeBase: KnowledgeBaseManager;
  review: ReviewManager;
}

export function registerEchoInkPluginFeatures(plugin: CodexForObsidianPlugin): EchoInkPluginControllers {
  plugin.registerView(VIEW_TYPE_CODEX, (leaf: WorkspaceLeaf) => new CodexView(leaf, plugin));
  plugin.registerView(VIEW_TYPE_ECHOINK_HOME, (leaf: WorkspaceLeaf) => new EchoInkHomeView(leaf, plugin));
  plugin.registerView(VIEW_TYPE_REVIEW_PREVIEW, (leaf: WorkspaceLeaf) => new ReviewPreviewView(leaf, plugin));

  plugin.addRibbonIcon("bot", "打开 EchoInk 首页和 Agent 侧栏", () => {
    void plugin.activateHomeAndSidebar();
  });

  plugin.addCommand({
    id: "open-echoink-home",
    name: "打开 EchoInk 首页",
    callback: () => void plugin.activateHomeView()
  });
  plugin.addCommand({
    id: "open-codex-sidebar",
    name: "打开 EchoInk Agent 侧栏",
    callback: () => void plugin.activateView()
  });
  plugin.addCommand({
    id: "new-codex-chat",
    name: "新建 Agent 会话",
    callback: async () => {
      await plugin.activateView();
      new Notice("已打开 EchoInk Agent，可点击 + 新建会话");
    }
  });
  plugin.addCommand({
    id: "test-hermes-connection",
    name: "Agent：检测 Hermes 后端",
    callback: () => void plugin.testHermesConnection()
  });

  registerEditorActionCommands(plugin);
  plugin.addSettingTab(new CodexSettingTab(plugin));

  const editorActions = new EditorActionController(plugin);
  editorActions.register();
  const knowledgeBase = new KnowledgeBaseManager(plugin);
  knowledgeBase.register();
  const review = new ReviewManager(plugin);
  review.register();

  return { editorActions, knowledgeBase, review };
}

export function registerEchoInkStartupTasks(plugin: CodexForObsidianPlugin): void {
  if (plugin.settings.autoOpen) {
    plugin.app.workspace.onLayoutReady(() => void plugin.activateView());
  }
  if (plugin.settings.autoOpenHome) {
    plugin.app.workspace.onLayoutReady(() => void plugin.activateHomeView());
  }
  if (plugin.settings.editorActions.enabled) {
    plugin.app.workspace.onLayoutReady(() => {
      window.setTimeout(() => void plugin.ensureCodexConnected(false, { silent: true }), 800);
    });
  }
  plugin.app.workspace.onLayoutReady(() => {
    window.setTimeout(() => void plugin.runDeferredStartupMaintenance(), 1200);
  });
}

function registerEditorActionCommands(plugin: CodexForObsidianPlugin): void {
  plugin.addCommand({
    id: "editor-action-rewrite",
    name: "改写选中文字",
    editorCallback: (editor, view) => void plugin.getEditorActions()?.runEditorActionById(editor, view, "rewrite")
  });
  plugin.addCommand({
    id: "editor-action-expand",
    name: "扩写选中文字",
    editorCallback: (editor, view) => void plugin.getEditorActions()?.runEditorActionById(editor, view, "expand")
  });
  plugin.addCommand({
    id: "editor-action-continue",
    name: "续写选中文字",
    editorCallback: (editor, view) => void plugin.getEditorActions()?.runEditorActionById(editor, view, "continue")
  });
  plugin.addCommand({
    id: "editor-action-translate",
    name: "翻译选中文字为英文",
    editorCallback: (editor, view) => void plugin.getEditorActions()?.runEditorActionById(editor, view, "translate")
  });
  plugin.addCommand({
    id: "editor-action-enhance",
    name: "增强提示词",
    editorCallback: (editor, view) => void plugin.getEditorActions()?.runEditorActionById(editor, view, "enhance")
  });
}
