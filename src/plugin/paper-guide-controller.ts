import { Platform } from "obsidian";
import type CodexForObsidianPlugin from "../main";
import { PaperGuideModal, type PaperGuideModelResult } from "../ui/paper-guide-modal";
import { GENERAL_ASSISTANT_ID } from "../agents/types";
import { activateApiProvider, apiProviderModelSupportsImage, createApiProviderConfig, getActiveApiProviderModel, getDefaultApiProviderModel, validateApiProvider } from "../settings/settings";
import { getApiProviderPreset, type ApiProviderId } from "../settings/provider-presets";
import { settingsCopy } from "../settings/i18n";
import { providerFailureDetailText } from "../harness/pi/provider-failure";
import { onboardingSetupComplete } from "../settings/onboarding-setup-status";

/** Owns automatic/manual entry and delegates mutations to the existing services. */
export class PaperGuideController {
  private modal: PaperGuideModal | null = null;
  private opening = false;
  private disposed = false;
  private cancelFrame: (() => void) | null = null;

  constructor(private readonly plugin: CodexForObsidianPlugin, private readonly getHome: () => HTMLElement | null) {}

  async showAfterOnboarding(): Promise<void> { await this.show(false); }
  async showManually(): Promise<void> { await this.show(true); }

  private async show(manual: boolean): Promise<void> {
    if (!Platform.isDesktopApp || this.disposed || this.opening || this.modal || (!manual && !this.canShow())) return;
    const home = this.getHome(), win = home?.ownerDocument.defaultView;
    if (!manual && (!home || !win)) return;
    this.opening = true;
    try {
      if (!manual && win) await this.afterPaint(win);
      if (this.disposed || (!manual && (!this.canShow() || this.getHome() !== home || !home?.isConnected
        || home.getClientRects().length === 0 || home.ownerDocument.hidden || home.ownerDocument.querySelector(".modal-container")))) return;
      this.modal = new PaperGuideModal(this.plugin.app, {
        language: this.plugin.settings.settingsLanguage,
        preview: async choices => {
          const service = this.plugin.getKnowledgeSurfaceService();
          if (!service) throw new Error("目录服务尚未就绪，请稍后重试。");
          return await service.previewOnboardingSetupPlan(undefined, choices);
        },
        apply: async (plan, progress) => {
          const service = this.plugin.getKnowledgeSurfaceService();
          if (!service) throw new Error("目录服务尚未就绪，请稍后重试。");
          return await service.applyOnboardingSetupPlan(plan, progress);
        },
        model: () => this.modelName(),
        connect: (provider, key) => this.connect(provider, key),
        writeGuide: async (plan, created) => {
          const service = this.plugin.getKnowledgeSurfaceService();
          if (!service) throw new Error("目录服务尚未就绪，请稍后重试。");
          return await service.writeOnboardingSetupGuide(plan, created);
        },
        openGuide: async path => {
          const service = this.plugin.getKnowledgeSurfaceService();
          if (!service) throw new Error("目录服务尚未就绪，请稍后重试。");
          await service.openOnboardingSetupGuide(path);
        },
        refine: plan => this.plugin.startOnboardingRefinement(plan.refinementSources ?? []),
        onManual: () => this.plugin.openEchoInkKnowledgeInitializationSettings(),
        onTry: async () => {
          return await this.plugin.openAgentTaskList(GENERAL_ASSISTANT_ID, this.plugin.settings.settingsLanguage === "en"
            ? "Summarize my recent notes. What have I been focusing on?" : "总结一下我最近写的笔记，我主要在关注什么？");
        },
        onDismiss: () => this.remember(),
        onClosed: () => { this.modal = null; }
      });
      this.modal.open();
    } finally { this.opening = false; }
  }

  dispose(): void {
    this.disposed = true; this.cancelFrame?.(); this.modal?.dispose(); this.modal = null;
  }

  private modelName(): string | null {
    const active = getActiveApiProviderModel(this.plugin.settings);
    if (!active || validateApiProvider(active.provider).length) return null;
    return active.model.displayName || active.model.id;
  }

  private canShow(): boolean {
    return !this.disposed && !this.plugin.isEchoInkOnboardingRequested() && this.plugin.settings.setup.completedAt > 0
      && this.plugin.settings.setup.paperGuideDismissedAt === 0 && !onboardingSetupComplete(this.plugin.settings);
  }

  private afterPaint(win: Window): Promise<void> {
    return new Promise(resolve => {
      let frame = win.requestAnimationFrame(() => { frame = win.requestAnimationFrame(finish); });
      const finish = () => { this.cancelFrame = null; resolve(); };
      this.cancelFrame = () => { win.cancelAnimationFrame(frame); finish(); };
    });
  }

  private async remember(): Promise<void> {
    const setup = this.plugin.settings.setup;
    if (setup.paperGuideDismissedAt > 0) return;
    setup.paperGuideDismissedAt = Date.now();
    try { await this.plugin.saveSettings(true, { flushConversationStore: false }); }
    catch (error) { setup.paperGuideDismissedAt = 0; throw error; }
  }

  private async connect(providerId: ApiProviderId, key: string): Promise<PaperGuideModelResult> {
    if (!key.trim()) return { available: false, message: "" }; // No factory, save or activation on skip.
    const draft = createApiProviderConfig(providerId);
    draft.apiKey = key.trim();
    const errors = validateApiProvider(draft, this.plugin.settings.settingsLanguage);
    if (errors.length) return { available: false, message: errors.join("；") };
    const model = getDefaultApiProviderModel(draft)!;
    const preset = getApiProviderPreset(providerId);
    const result = await this.plugin.testPiProviderConnection({ providerSettingsId: draft.id, providerId, runtimeProviderId: draft.runtimeProviderId,
      apiProtocol: draft.apiProtocol, authMode: draft.authMode, baseUrl: draft.baseUrl, modelId: model.id, apiKey: draft.apiKey,
      toolCalling: model.toolCalling, imageInput: apiProviderModelSupportsImage(model), reasoning: model.reasoning,
      discovery: model.discovery, contextWindow: model.contextWindow, modelMaxTokens: model.modelMaxTokens, maxOutputTokens: model.maxOutputTokens });
    if (this.disposed) throw new Error("设置引导已关闭。 ");
    if (result.status !== "available") {
      const detail = providerFailureDetailText(result.detail);
      return { available: false, message: `${settingsCopy(this.plugin.settings.settingsLanguage).providers.connectionFailures[result.failure]}${detail ? `：${detail}` : ""}` };
    }
    await this.plugin.activateApiProviderSettings(settings => {
      settings.apiProviders.push(structuredClone(draft));
      activateApiProvider(settings, draft);
    });
    return { available: true, message: model.displayName || preset.model };
  }
}
