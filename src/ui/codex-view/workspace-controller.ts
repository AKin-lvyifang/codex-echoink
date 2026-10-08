import { Notice, type App } from "obsidian";
import type CodexForObsidianPlugin from "../../main";
import type { TurnOptions } from "../turn-options";
import {
  apiProviderHasUsableCredential,
  getApiProviderModel,
  type StoredSession
} from "../../settings/settings";
import { buildActiveEchoInkResourceCatalog, hasEnabledMcpResources, workspaceResourcesFromEchoInkResources } from "../../resources/registry";
import type { EchoInkResource } from "../../resources/types";
import type { PermissionMode, UiMode } from "../../types/app-server";
import { showItemInFinder } from "../../core/electron";
import { textInputModal } from "../modals";
import { openWorkspaceMenu as showWorkspaceMenu } from "./menus";
import { normalizeWorkspacePath, pickWorkspaceDirectory, workspaceDirectoryExists, workspaceDisplayName } from "./workspace-utils";
import { resolveComposerReasoningState } from "../composer-reasoning";
import { conversationUiText } from "./ui-i18n";

export interface CodexWorkspaceHost {
  readonly app: App;
  readonly plugin: CodexForObsidianPlugin;
  running: boolean;
  readonly runningSessionIds: ReadonlySet<string>;
  selectedProviderSettingsId: string;
  selectedModel: string;
  selectedPermission: PermissionMode;
  selectedMode: UiMode;
  ensureSession(): StoredSession;
  renderToolbar(): void;
  renderMessages(options?: { forceBottom?: boolean; fromScroll?: boolean; preserveScroll?: boolean }): void;
  updateInputPlaceholder(): void;
  currentTurnOptions(session?: StoredSession): TurnOptions;
  effectiveModel(): string;
}

export function openWorkspaceMenu(host: CodexWorkspaceHost, event: MouseEvent, session: StoredSession): void {
  const workspacePath = normalizeWorkspacePath(session.cwd);
  showWorkspaceMenu(event, workspacePath, {
    onChooseWorkspace: () => void chooseChatWorkspace(host, session),
    onRevealWorkspace: () => showItemInFinder(workspacePath),
    onClearWorkspace: () => void clearChatWorkspace(host, session)
  });
}

export async function chooseChatWorkspace(host: CodexWorkspaceHost, session: StoredSession, preparingTurn = false): Promise<boolean> {
  const language = host.plugin.settings.settingsLanguage;
  if (!preparingTurn && host.runningSessionIds.has(session.id)) {
    new Notice(conversationUiText(language, "当前会话运行中，结束后再切换工作区", "This conversation is running. Switch workspaces after it finishes."));
    return false;
  }
  const pickedPath = await pickWorkspaceDirectory(session.cwd, language);
  const selectedPath = pickedPath === undefined
    ? await textInputModal(
      host.app,
      conversationUiText(language, "选择工作区", "Choose workspace"),
      conversationUiText(language, "文件夹路径", "Folder path"),
      session.cwd
    )
    : pickedPath;
  if (!selectedPath) return false;
  if (!preparingTurn && host.runningSessionIds.has(session.id)) {
    new Notice(conversationUiText(language, "当前会话运行中，结束后再切换工作区", "This conversation is running. Switch workspaces after it finishes."));
    return false;
  }
  const workspacePath = normalizeWorkspacePath(selectedPath);
  if (!workspaceDirectoryExists(workspacePath)) {
    new Notice(conversationUiText(language, "请选择一个存在的文件夹作为工作区", "Choose an existing folder as the workspace."));
    return false;
  }
  const changed = normalizeWorkspacePath(session.cwd) !== workspacePath;
  if (changed) {
    try {
      await commitChatWorkspaceSelection(host, session, workspacePath);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      new Notice(conversationUiText(language, `切换工作区失败：${detail}`, `Could not switch workspace: ${detail}`));
      return false;
    }
  }
  host.renderToolbar();
  host.updateInputPlaceholder();
  host.renderMessages();
  const displayName = workspaceDisplayName(workspacePath);
  new Notice(conversationUiText(language, `工作区已设为：${displayName}`, `Workspace set to: ${displayName}`));
  return true;
}

export async function clearChatWorkspace(host: CodexWorkspaceHost, session: StoredSession): Promise<void> {
  const language = host.plugin.settings.settingsLanguage;
  if (host.runningSessionIds.has(session.id)) {
    new Notice(conversationUiText(language, "当前会话运行中，结束后再清除工作区", "This conversation is running. Clear the workspace after it finishes."));
    return;
  }
  session.cwd = "";
  delete session.tokenUsage;
  await host.plugin.saveSettings(true);
  host.renderToolbar();
  host.updateInputPlaceholder();
  host.renderMessages();
  new Notice(conversationUiText(language, "已清除工作区", "Workspace cleared"));
}

export async function commitChatWorkspaceSelection(
  host: CodexWorkspaceHost,
  session: StoredSession,
  workspacePath: string
): Promise<void> {
  session.cwd = workspacePath;
  delete session.tokenUsage;
  await host.plugin.saveSettings(true);
}

export async function ensureChatWorkspaceSelected(host: CodexWorkspaceHost, session: StoredSession, preparingTurn = false): Promise<boolean> {
  const workspacePath = normalizeWorkspacePath(session.cwd);
  if (workspacePath && workspaceDirectoryExists(workspacePath)) return true;
  const picked = await chooseChatWorkspace(host, session, preparingTurn);
  if (!picked) new Notice(conversationUiText(
    host.plugin.settings.settingsLanguage,
    "普通会话需要先选择一个文件夹作为工作区",
    "Choose a folder as the workspace before starting a regular conversation."
  ));
  return picked;
}

export function currentTurnOptions(host: CodexWorkspaceHost, session?: StoredSession): TurnOptions {
  const cwd = session ? normalizeWorkspacePath(session.cwd) : "";
  const catalog = currentEchoInkResourceCatalog(host);
  const workspaceResources = workspaceResourcesFromEchoInkResources(catalog);
  const model = host.effectiveModel();
  const provider = host.plugin.settings.apiProviders.find(
    (candidate) => candidate.id === host.selectedProviderSettingsId
  );
  const reasoning = resolveComposerReasoningState(
    host.plugin.settings,
    host.selectedProviderSettingsId,
    model
  );
  return {
    ...(cwd ? { cwd } : {}),
    providerSettingsId: host.selectedProviderSettingsId,
    runtimeProviderId: provider?.runtimeProviderId ?? "",
    model,
    reasoning: reasoning?.effort ?? "none",
    permission: host.selectedPermission,
    mode: host.selectedMode,
    mcpEnabled: hasEnabledMcpResources(catalog),
    workspaceResources
  };
}

export function currentEchoInkResourceCatalog(host: CodexWorkspaceHost): EchoInkResource[] {
  const settings = host.plugin.settings.resources;
  return buildActiveEchoInkResourceCatalog({
    settings,
    // The UI reuses the last scanned catalog; execution still loads the live catalog.
    manual: settings.catalog.filter((resource) => resource.source === "echoink-local")
  });
}

export function effectiveModel(host: CodexWorkspaceHost): string {
  const provider = host.plugin.settings.apiProviders.find(
    (candidate) => candidate.id === host.selectedProviderSettingsId
  );
  if (
    !provider
    || !apiProviderHasUsableCredential(
      provider,
      host.plugin.settings.openAICodexCredential
    )
    || !getApiProviderModel(provider, host.selectedModel)
  ) return "";
  return host.selectedModel;
}
