import type CodexForObsidianPlugin from "../main";
import { getProPluginAccess, unavailableCapabilityAccess } from "../membership/access";
import { PaperGuideModal, type PaperGuideScene, type PaperGuideSceneId } from "../ui/paper-guide-modal";
import { workbenchModuleOwner } from "../home/module-navigation";
import type { AgentModuleId } from "../agents/types";

const sceneTargets: Readonly<Record<PaperGuideSceneId, { module: AgentModuleId; zh: string; en: string }>> = {
  english: { module: "english-diary", zh: "我想用日记练习英语，先帮我看看今天的日记。", en: "I'd like to practice English with my diary. First, help me look at today's entry." },
  finance: { module: "finance", zh: "帮我看看本月的收支和预算，先告诉我有哪些值得留意的地方。", en: "Help me review this month's spending, income and budget. First, tell me what deserves attention." },
  knowledge: { module: "knowledge-base", zh: "帮我看看有哪些笔记适合整理，先给我一个方案。", en: "Help me find notes that would benefit from organizing. Give me a plan first." }
};

/** Called only by the tutorial's completion card, after it returns home. */
export class PaperGuideController {
  private modal: PaperGuideModal | null = null;
  private opening = false;
  private disposed = false;
  private unsubscribe: (() => void) | null = null;
  private cancelFrame: (() => void) | null = null;

  constructor(
    private readonly plugin: CodexForObsidianPlugin,
    private readonly getHome: () => HTMLElement | null
  ) {}

  async showAfterOnboarding(): Promise<void> {
    if (!this.canShow() || this.opening || this.modal) return;
    const home = this.getHome();
    const win = home?.ownerDocument.defaultView;
    if (!home || !win) return;
    this.opening = true;
    try {
      // Let the returned workbench paint before inserting its first-task dialog.
      await this.afterPaint(win);
      if (!this.canShow() || this.getHome() !== home || !home.isConnected
        || home.getClientRects().length === 0 || home.ownerDocument.hidden
        || home.ownerDocument.querySelector(".modal-container")) return;
      this.modal = new PaperGuideModal(this.plugin.app, {
        language: this.plugin.settings.settingsLanguage,
        scenes: this.scenes(),
        onDismiss: () => this.remember(),
        onChoose: async (scene) => {
          await this.remember();
          return async () => { if (!this.disposed) await this.openScene(scene); };
        },
        onClosed: () => {
          this.unsubscribe?.();
          this.unsubscribe = null;
          this.modal = null;
        }
      });
      this.modal.open();
      const refreshScenes = () => { this.modal?.updateScenes(this.scenes()); };
      const unsubscribeAccount = this.plugin.accountService?.subscribe(refreshScenes);
      const unsubscribeRegistry = this.plugin.onAgentRegistryChanged(refreshScenes);
      this.unsubscribe = () => { unsubscribeAccount?.(); unsubscribeRegistry(); };
    } finally {
      this.opening = false;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.cancelFrame?.();
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.modal?.dispose();
    this.modal = null;
  }

  private canShow(): boolean {
    return !this.disposed && !this.plugin.isEchoInkOnboardingRequested()
      && this.plugin.settings.setup.completedAt > 0
      && this.plugin.settings.setup.paperGuideDismissedAt === 0;
  }

  private afterPaint(win: Window): Promise<void> {
    return new Promise((resolve) => {
      let frame = win.requestAnimationFrame(() => {
        frame = win.requestAnimationFrame(finish);
      });
      const finish = () => { this.cancelFrame = null; resolve(); };
      this.cancelFrame = () => { win.cancelAnimationFrame(frame); finish(); };
    });
  }

  private async remember(): Promise<void> {
    const setup = this.plugin.settings.setup;
    if (setup.paperGuideDismissedAt > 0) return;
    const previous = setup.paperGuideDismissedAt;
    setup.paperGuideDismissedAt = Date.now();
    try {
      await this.plugin.saveSettings(true, { flushConversationStore: false });
    } catch (error) {
      setup.paperGuideDismissedAt = previous;
      throw error;
    }
  }

  private scenes(): readonly PaperGuideScene[] {
    const zh = this.plugin.settings.settingsLanguage !== "en";
    const access = this.plugin.accountService ?? unavailableCapabilityAccess;
    const description = (scene: PaperGuideSceneId, enabled?: boolean) => {
      const owner = workbenchModuleOwner(this.plugin, sceneTargets[scene].module);
      const parts = [zh ? `交给 ${owner.name}，仅预填` : `Prepare a draft for ${owner.name}`];
      if (enabled !== undefined) {
        if (!getProPluginAccess(access, enabled).canWrite) parts.push(zh ? "需要 PRO" : "PRO required");
        if (!enabled) parts.push(scene === "english"
          ? zh ? "需先启用英文日记" : "Enable English Diary first"
          : zh ? "需先启用财务" : "Enable Finance first");
      }
      return parts.join(" · ");
    };
    return [
      {
        id: "english", icon: "book-open", badge: "PRO",
        title: zh ? "用日记练习英语" : "Practice English with a diary",
        description: description("english", this.plugin.settings.englishDiary.enabled)
      },
      {
        id: "finance", icon: "wallet", badge: "PRO",
        title: zh ? "梳理收支和预算" : "Organize spending and budgets",
        description: description("finance", this.plugin.settings.lifestyle.finance.enabled)
      },
      {
        id: "knowledge", icon: "files",
        title: zh ? "整理和检索我的笔记" : "Organize and find my notes",
        description: description("knowledge")
      }
    ];
  }

  private async openScene(scene: PaperGuideSceneId): Promise<void> {
    const target = sceneTargets[scene];
    // The task list owns draft conflicts; execution checks run only on Send.
    const owner = workbenchModuleOwner(this.plugin, target.module);
    await this.plugin.openAgentTaskList(owner.id, this.plugin.settings.settingsLanguage === "en" ? target.en : target.zh);
  }
}
