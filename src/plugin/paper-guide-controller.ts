import type CodexForObsidianPlugin from "../main";
import { getProPluginAccess, unavailableCapabilityAccess } from "../membership/access";
import { PaperGuideModal, type PaperGuideScene, type PaperGuideSceneId } from "../ui/paper-guide-modal";

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
      this.unsubscribe = this.plugin.accountService?.subscribe(() => {
        this.modal?.updateScenes(this.scenes());
      }) ?? null;
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
    const description = (enabled: boolean, readyZh: string, readyEn: string) => {
      const policy = getProPluginAccess(access, enabled);
      if (!policy.canEnter) return zh ? "查看 PRO 权益" : "View PRO access";
      if (!policy.canWrite) return zh ? "查看已有记录" : "View existing records";
      if (!enabled) return zh ? "启用后开始使用" : "Enable and get started";
      return zh ? readyZh : readyEn;
    };
    return [
      {
        id: "english", icon: "book-open", badge: "PRO",
        title: zh ? "用日记练习英语" : "Practice English with a diary",
        description: description(this.plugin.settings.englishDiary.enabled,
          "打开今天的日记，写下生活里的小事", "Open today's diary and write about your day")
      },
      {
        id: "finance", icon: "wallet", badge: "PRO",
        title: zh ? "梳理收支和预算" : "Organize spending and budgets",
        description: description(this.plugin.settings.lifestyle.finance.enabled,
          "进入财务工作区", "Open your finance workspace")
      },
      {
        id: "knowledge", icon: "files",
        title: zh ? "整理和检索我的笔记" : "Organize and find my notes",
        description: zh ? "打开知识库，选择要整理的资料" : "Open Knowledge and choose your source notes"
      }
    ];
  }

  private async openScene(scene: PaperGuideSceneId): Promise<void> {
    if (scene === "knowledge") {
      await this.plugin.openEchoInkKnowledgeSettings();
      return;
    }
    // Re-read access after the dialog closes; the account may have changed.
    const enabled = scene === "english" ? this.plugin.settings.englishDiary.enabled
      : this.plugin.settings.lifestyle.finance.enabled;
    const policy = getProPluginAccess(this.plugin.accountService ?? unavailableCapabilityAccess, enabled);
    if (!policy.canEnter) {
      await this.plugin.openEchoInkAccountSettings();
      return;
    }
    if (scene === "english") {
      const diary = this.plugin.englishDiary;
      if (!diary) throw new Error(this.plugin.settings.settingsLanguage === "en"
        ? "English Diary is not ready. Try again from Plugins." : "英文日记尚未准备好，请从插件设置重试。");
      if (!enabled) await diary.setEnabled(true);
      await diary.openToday();
    } else {
      if (!enabled) await this.plugin.lifestyle.setEnabled("finance", true);
      await this.plugin.lifestyle.open("finance");
    }
  }
}
