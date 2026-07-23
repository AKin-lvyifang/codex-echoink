import { Notice } from "obsidian";
import type CodexForObsidianPlugin from "../main";
import { CodexService } from "../core/codex-service";
import { diagnoseCodexError } from "../core/codex-diagnostics";
import { swallowError } from "../core/error-handling";
import { HermesBackend } from "../core/hermes-backend";
import { isSyntheticHermesDefaultModel } from "../core/hermes-models";
import { CodexServerRequestRouter } from "../core/server-request-router";
import { skillResourcesForScope } from "../resources/registry";
import { EchoInkMcpBrokerService, type CallEchoInkMcpToolInput } from "../resources/mcp-broker-service";
import type { EchoInkResource } from "../resources/types";
import { getActiveApiProvider, providerConnectionLabel } from "../settings/settings";
import { reconcileKnowledgeBaseNativeLifecycleRecovery } from "../knowledge-base/scheduled-maintenance";
import { confirmModal, requestUserInputModal } from "../ui/modals";
import type { CodexNotification, CodexSkill, CodexStatusSnapshot } from "../types/app-server";
import { runBackendProbe } from "../harness/native/backend-probe-lifecycle";

export interface HermesConnectionTestResult {
  connected: boolean;
  providerConfigured: boolean;
  message: string;
  version: string;
}

export class EchoInkConnectionService {
  private skillsLoadPromise: Promise<CodexSkill[]> | null = null;
  private connectPromise: Promise<CodexStatusSnapshot> | null = null;
  private serverRequestRouter: CodexServerRequestRouter | null = null;
  private echoInkMcpBroker: EchoInkMcpBrokerService | null = null;

  constructor(
    private readonly plugin: CodexForObsidianPlugin,
    private readonly onNotification: (notification: CodexNotification) => void
  ) {}

  async ensureCodexConnected(force = false, options: { silent?: boolean; refreshLogin?: boolean } = {}): Promise<CodexStatusSnapshot> {
    if (this.plugin.codex?.isConnected() && !force && this.plugin.lastStatus?.connected) return this.plugin.lastStatus;
    if (this.connectPromise && !force) return this.connectPromise;
    if (force) {
      this.connectPromise = null;
      await this.plugin.codex?.disconnect();
      this.plugin.codex = null;
    }
    if (!this.plugin.codex || force) {
      this.plugin.codex = new CodexService({
        cliPath: this.plugin.settings.cliPath,
        proxyEnabled: this.plugin.settings.proxyEnabled,
        proxyUrl: this.plugin.settings.proxyUrl,
        providerMode: this.plugin.settings.providerMode,
        activeApiProvider: getActiveApiProvider(this.plugin.settings),
        vaultPath: this.plugin.getVaultPath(),
        onNotification: (notification) => this.onNotification(notification),
        onServerRequest: (request) => this.getServerRequestRouter().handle(request)
      });
    }
    this.connectPromise = (async () => {
      try {
        const previousStatus = this.plugin.lastStatus;
        const nextStatus = await this.plugin.codex!.connect(force, { refreshLogin: options.refreshLogin === true });
        this.plugin.lastStatus = {
          ...nextStatus,
          rateLimits: nextStatus.rateLimits ?? previousStatus?.rateLimits ?? null,
          rateLimitsByLimitId: nextStatus.rateLimitsByLimitId ?? previousStatus?.rateLimitsByLimitId ?? null
        };
        if (this.plugin.lastStatus.connected) {
          void this.reconcileKnowledgeBaseNativeLifecycleRecovery().catch((error) => {
            console.warn("EchoInk Native execution recovery after Codex connection failed", error);
          });
        }
      } catch (error) {
        const diagnostic = diagnoseCodexError(error, {
          model: this.plugin.settings.defaultModel,
          providerLabel: providerConnectionLabel(this.plugin.settings, this.plugin.settings.settingsLanguage),
          proxyEnabled: this.plugin.settings.proxyEnabled,
          proxyUrl: this.plugin.settings.proxyUrl,
          language: this.plugin.settings.settingsLanguage
        });
        this.plugin.lastStatus = {
          connected: false,
          accountLabel: this.plugin.settings.settingsLanguage === "en" ? "Disconnected" : "未连接",
          loggedIn: false,
          models: [],
          skills: [],
          mcpServers: [],
          rateLimits: null,
          rateLimitsByLimitId: null,
          errors: [diagnostic.text]
        };
        if (!options.silent) {
          new Notice(this.plugin.settings.settingsLanguage === "en" ? `Codex failed: ${diagnostic.title}` : `Codex 连接失败：${diagnostic.title}`);
        }
      }
      return this.plugin.lastStatus!;
    })().finally(() => {
      this.connectPromise = null;
    });
    return this.connectPromise;
  }

  private async reconcileKnowledgeBaseNativeLifecycleRecovery(): Promise<void> {
    await this.plugin.archivePendingKnowledgeBaseThreads();
    const summary = this.plugin.getKnowledgeBaseManager()
      ?.getLastNativeLifecycleSummary() ?? null;
    const reconciliation = reconcileKnowledgeBaseNativeLifecycleRecovery(
      this.plugin.settings.knowledgeBase,
      summary
    );
    if (!reconciliation.changed) return;
    await this.plugin.saveSettings(true);
    this.plugin.refreshKnowledgeBaseSurfaces();
  }

  async ensureSkillsLoaded(force = false): Promise<CodexSkill[]> {
    if (!force && this.plugin.lastStatus?.skills.length) return this.plugin.lastStatus.skills;
    if (!this.skillsLoadPromise) {
      this.skillsLoadPromise = this.loadSkills(force).finally(() => {
        this.skillsLoadPromise = null;
      });
    }
    return this.skillsLoadPromise;
  }

  async ensureEchoInkSkillResourcesLoaded(force = false): Promise<EchoInkResource[]> {
    void force;
    return skillResourcesForScope(
      await this.plugin.buildRuntimeEchoInkResourceCatalog(),
      "chat",
      this.plugin.settings.resources.enabledByScope
    );
  }

  async reconnectCodex(options: { refreshLogin?: boolean } = {}): Promise<CodexStatusSnapshot> {
    this.connectPromise = null;
    await this.plugin.codex?.disconnect();
    this.plugin.codex = null;
    return this.ensureCodexConnected(true, { refreshLogin: options.refreshLogin === true });
  }

  async listEchoInkMcpTools(resourceId: string, timeoutMs = 30000): Promise<unknown[]> {
    return await this.getEchoInkMcpBrokerService().listTools(resourceId, timeoutMs);
  }

  async callEchoInkMcpTool(input: CallEchoInkMcpToolInput): Promise<unknown> {
    return await this.getEchoInkMcpBrokerService().callTool(input);
  }

  async testHermesConnection(options: { notify?: boolean; signal?: AbortSignal } = {}): Promise<HermesConnectionTestResult> {
    const notify = options.notify !== false;
    const hermes = this.plugin.settings.agents.hermes;
    const previousHermes = { ...hermes };
    throwIfConnectionTestAborted(options.signal);
    if (isSyntheticHermesDefaultModel(hermes.providerId, hermes.modelId)) {
      hermes.providerId = "";
      hermes.modelId = "";
      hermes.providerConfigured = false;
      hermes.lastProviderCheckAt = 0;
      hermes.lastProviderError = "";
    }
    const backend = new HermesBackend({
      ...hermes,
      vaultPath: this.plugin.getVaultPath()
    });
    try {
      await backend.connect();
      throwIfConnectionTestAborted(options.signal);
      const models = await backend.listModels();
      throwIfConnectionTestAborted(options.signal);
      const info = backend.getConnectionInfo();
      hermes.version = info.version;
      hermes.lastConnectedAt = Date.now();
      hermes.lastError = "";
      const hasConfiguredModel = Boolean(hermes.providerId.trim() || hermes.modelId.trim());
      const configuredModel = models.find((model) => model.providerId === hermes.providerId && model.modelId === hermes.modelId);
      const selectedModel = configuredModel ?? (!hasConfiguredModel ? models[0] ?? null : null);
      if (selectedModel) {
        hermes.providerId = selectedModel.providerId;
        hermes.modelId = selectedModel.modelId;
      }
      try {
        await runBackendProbe({
          host: this.plugin,
          backendId: "hermes",
          settings: this.plugin.settings,
          vaultPath: this.plugin.getVaultPath(),
          nativeRefContext: this.plugin.getNativeExecutionRefContext("hermes"),
          prompt: "只回复 PONG",
          expectedToken: "PONG",
          failureMessage: "Hermes 最小连接检查没有返回 PONG",
          timeoutMs: 60000,
          signal: options.signal,
          ...(selectedModel ? { model: { providerId: selectedModel.providerId, modelId: selectedModel.modelId } } : {}),
          profile: hermes.profile
        });
        throwIfConnectionTestAborted(options.signal);
        hermes.providerConfigured = true;
        hermes.lastProviderCheckAt = Date.now();
        hermes.lastProviderError = "";
      } catch (providerError) {
        hermes.providerConfigured = false;
        hermes.lastProviderCheckAt = Date.now();
        hermes.lastProviderError = providerError instanceof Error ? providerError.message : String(providerError);
      }
      throwIfConnectionTestAborted(options.signal);
      await this.plugin.saveSettings(true);
      const message = hermes.providerConfigured
        ? `Hermes 已检测：${info.version || "version unknown"}，provider 可用`
        : `Hermes CLI 可用，但 provider 未通过：${hermes.lastProviderError}`;
      if (notify) new Notice(message);
      return { connected: true, providerConfigured: hermes.providerConfigured, message, version: info.version };
    } catch (error) {
      if (options.signal?.aborted || isConnectionTestAbortError(error)) {
        Object.assign(hermes, previousHermes);
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      hermes.lastError = message;
      await this.plugin.saveSettings(true);
      if (notify) new Notice(`Hermes 检测失败：${message}`);
      return { connected: false, providerConfigured: false, message, version: "" };
    } finally {
      await backend.disconnect().catch(swallowError("disconnect Hermes backend after loading skills"));
    }
  }

  private getServerRequestRouter(): CodexServerRequestRouter {
    if (!this.serverRequestRouter) {
      this.serverRequestRouter = new CodexServerRequestRouter({
        confirm: (title, body, acceptText, declineText) => confirmModal(this.plugin.app, title, body, acceptText, declineText),
        requestUserInput: (questions) => requestUserInputModal(this.plugin.app, questions),
        openUrl: (url) => window.open(url)
      });
    }
    return this.serverRequestRouter;
  }

  private async loadSkills(force: boolean): Promise<CodexSkill[]> {
    const status = await this.ensureCodexConnected(force);
    if (!status.connected || !this.plugin.codex) return status.skills;
    try {
      const skills = await this.plugin.codex.refreshSkills();
      this.plugin.lastStatus = { ...status, skills };
      return skills;
    } catch (error) {
      this.plugin.lastStatus = {
        ...status,
        errors: [...status.errors, error instanceof Error ? error.message : String(error)]
      };
      return status.skills;
    }
  }

  private getEchoInkMcpBrokerService(): EchoInkMcpBrokerService {
    if (!this.echoInkMcpBroker) this.echoInkMcpBroker = new EchoInkMcpBrokerService(this.plugin);
    return this.echoInkMcpBroker;
  }

}

function throwIfConnectionTestAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = new Error("Hermes connection check cancelled");
  error.name = "AbortError";
  throw error;
}

function isConnectionTestAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
