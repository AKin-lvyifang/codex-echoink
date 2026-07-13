import { Notice, type App } from "obsidian";
import type CodexForObsidianPlugin from "../../main";
import type { TurnOptions } from "../../core/codex-service";
import { getActiveApiProvider, getApiProviderModels, type AgentBackendMode, type StoredSession } from "../../settings/settings";
import { buildEchoInkResourceCatalog, hasEnabledMcpResources, workspaceResourcesFromEchoInkResources } from "../../resources/registry";
import type { EchoInkResource } from "../../resources/types";
import type { PermissionMode, ReasoningEffort, ServiceTierChoice, UiMode } from "../../types/app-server";
import { showItemInFinder } from "../../core/electron";
import { textInputModal } from "../modals";
import { openWorkspaceMenu as showWorkspaceMenu } from "./menus";
import { normalizeWorkspacePath, pickWorkspaceDirectory, workspaceDirectoryExists, workspaceDisplayName } from "./workspace-utils";

export interface CodexWorkspaceHost {
  readonly app: App;
  readonly plugin: CodexForObsidianPlugin;
  running: boolean;
  selectedModel: string;
  selectedReasoning: ReasoningEffort;
  selectedServiceTier: ServiceTierChoice;
  selectedPermission: PermissionMode;
  selectedMode: UiMode;
  threadPrewarmPromise: Promise<boolean> | null;
  threadPrewarmSessionId: string;
  ensureSession(): StoredSession;
  isKnowledgeBaseSession(session: StoredSession): boolean;
  renderToolbar(): void;
  renderMessages(options?: { forceBottom?: boolean; fromScroll?: boolean; preserveScroll?: boolean }): void;
  updateInputPlaceholder(): void;
  prewarmActiveThread(): void;
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

export async function chooseChatWorkspace(host: CodexWorkspaceHost, session: StoredSession): Promise<boolean> {
  if (host.running) {
    new Notice("当前会话运行中，结束后再切换工作区");
    return false;
  }
  const pickedPath = await pickWorkspaceDirectory(session.cwd);
  const selectedPath = pickedPath === undefined
    ? await textInputModal(host.app, "选择工作区", "文件夹路径", session.cwd)
    : pickedPath;
  if (!selectedPath) return false;
  const workspacePath = normalizeWorkspacePath(selectedPath);
  if (!workspaceDirectoryExists(workspacePath)) {
    new Notice("请选择一个存在的文件夹作为工作区");
    return false;
  }
  const changed = normalizeWorkspacePath(session.cwd) !== workspacePath;
  session.cwd = workspacePath;
  if (changed) {
    delete session.threadId;
    delete session.tokenUsage;
  }
  session.updatedAt = Date.now();
  await host.plugin.saveSettings(true);
  host.renderToolbar();
  host.updateInputPlaceholder();
  host.renderMessages();
  host.prewarmActiveThread();
  new Notice(changed ? `工作区已设为：${workspaceDisplayName(workspacePath)}，下一轮将开启新线程` : `工作区已设为：${workspaceDisplayName(workspacePath)}`);
  return true;
}

export async function clearChatWorkspace(host: CodexWorkspaceHost, session: StoredSession): Promise<void> {
  if (host.running) {
    new Notice("当前会话运行中，结束后再清除工作区");
    return;
  }
  session.cwd = "";
  delete session.threadId;
  delete session.tokenUsage;
  session.updatedAt = Date.now();
  await host.plugin.saveSettings(true);
  host.renderToolbar();
  host.updateInputPlaceholder();
  host.renderMessages();
  new Notice("已清除工作区");
}

export async function ensureChatWorkspaceSelected(host: CodexWorkspaceHost, session: StoredSession): Promise<boolean> {
  const workspacePath = normalizeWorkspacePath(session.cwd);
  if (workspacePath && workspaceDirectoryExists(workspacePath)) return true;
  const picked = await chooseChatWorkspace(host, session);
  if (!picked) new Notice("普通会话需要先选择一个文件夹作为工作区");
  return picked;
}

export function currentTurnOptions(host: CodexWorkspaceHost, session?: StoredSession): TurnOptions {
  const knowledgeSession = session ? host.isKnowledgeBaseSession(session) : false;
  const cwd = session && !knowledgeSession ? normalizeWorkspacePath(session.cwd) : "";
  const catalog = currentEchoInkResourceCatalog(host);
  const resourceScope = knowledgeSession ? "knowledge" : "chat";
  const workspaceResources = workspaceResourcesFromEchoInkResources(catalog, resourceScope, host.plugin.settings.resources.enabledByScope);
  return {
    ...(cwd ? { cwd } : {}),
    model: host.effectiveModel(),
    reasoning: host.selectedReasoning,
    serviceTier: host.selectedServiceTier,
    permission: host.selectedPermission,
    mode: host.selectedMode,
    mcpEnabled: hasEnabledMcpResources(catalog, resourceScope, host.plugin.settings.resources.enabledByScope),
    workspaceResources
  };
}

export function currentEchoInkResourceCatalog(host: CodexWorkspaceHost): EchoInkResource[] {
  return buildEchoInkResourceCatalog({ settings: host.plugin.settings.resources });
}

export function activeProviderModels(host: CodexWorkspaceHost): string[] {
  if (host.plugin.settings.providerMode !== "custom-api") return [];
  const provider = getActiveApiProvider(host.plugin.settings);
  return provider ? getApiProviderModels(provider) : [];
}

export function resolvedKnowledgeBackend(host: CodexWorkspaceHost): AgentBackendMode {
  const configured = host.plugin.settings.knowledgeBase.backend;
  return configured === "default" ? host.plugin.settings.agentBackend : configured;
}

export function effectiveModel(host: CodexWorkspaceHost): string {
  const providerModels = activeProviderModels(host);
  if (providerModels.length) {
    return providerModels.includes(host.selectedModel) ? host.selectedModel : providerModels[0];
  }
  return host.selectedModel || host.plugin.settings.defaultModel || "";
}

export function prewarmActiveThread(host: CodexWorkspaceHost): void {
  const session = host.ensureSession();
  if (host.isKnowledgeBaseSession(session)) return;
  if (session.threadId || host.running) return;
  if (!normalizeWorkspacePath(session.cwd) || !workspaceDirectoryExists(session.cwd)) return;
  if (host.threadPrewarmPromise && host.threadPrewarmSessionId === session.id) return;
  host.threadPrewarmSessionId = session.id;
  host.threadPrewarmPromise = startThreadForSession(host, session)
    .catch(() => false)
    .finally(() => {
      if (host.threadPrewarmSessionId === session.id) {
        host.threadPrewarmPromise = null;
        host.threadPrewarmSessionId = "";
      }
    });
}

export async function startThreadForSession(host: CodexWorkspaceHost, session: StoredSession): Promise<boolean> {
  if (session.threadId) return true;
  if (!normalizeWorkspacePath(session.cwd) || !workspaceDirectoryExists(session.cwd)) return false;
  const status = await host.plugin.ensureCodexConnected();
  if (!status.connected || !host.plugin.codex || session.threadId) return Boolean(session.threadId);
  const started = await host.plugin.startCodexHarnessThread(currentTurnOptions(host, session));
  session.threadId = started.threadId;
  await host.plugin.saveSettings();
  return true;
}
