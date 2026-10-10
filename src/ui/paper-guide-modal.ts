import { Modal, Notice, setIcon, type App } from "obsidian";
import { createPluginEditionBadge } from "../settings/plugin-edition-badge";

export type PaperGuideSceneId = "english" | "finance" | "knowledge";

export interface PaperGuideScene {
  readonly id: PaperGuideSceneId;
  readonly title: string;
  readonly description: string;
  readonly badge?: string;
  readonly icon: string;
}

export interface PaperGuideModalOptions {
  readonly language: "zh-CN" | "en";
  readonly scenes: readonly PaperGuideScene[];
  /** Save first; return navigation to run after the native modal restores focus. */
  readonly onChoose: (id: PaperGuideSceneId) => Promise<(() => Promise<void>) | void>;
  readonly onDismiss: () => Promise<void>;
  readonly onClosed: () => void;
}

/** One short, dismissible choice after the existing first-run flow reaches Home. */
export class PaperGuideModal extends Modal {
  private scenes: readonly PaperGuideScene[];
  private pendingScenes: readonly PaperGuideScene[] | null = null;
  private choicesEl: HTMLElement | null = null;
  private feedbackEl: HTMLElement | null = null;
  private skipButtonEl: HTMLButtonElement | null = null;
  private busy = false;
  private closed = false;
  private disposed = false;
  private focusFrame: number | null = null;
  private focusWindow: Window | null = null;

  constructor(app: App, private readonly options: PaperGuideModalOptions) {
    super(app);
    this.scenes = options.scenes.slice(0, 3);
  }

  onOpen(): void {
    if (this.disposed || this.closed) {
      super.close();
      return;
    }
    const zh = this.options.language !== "en";
    this.modalEl.addClass("echoink-paper-guide-modal");
    this.contentEl.addClass("echoink-paper-guide-content");
    this.contentEl.empty();
    this.setTitle(zh ? "今天，想先做哪件事？" : "Where would you like to start today?");

    // Keep the native title and close control; this decoration has no reading order.
    const mascot = this.titleEl.createSpan({
      cls: "echoink-paper-guide-mascot",
      attr: { "aria-hidden": "true" }
    });
    mascot.createSpan({ cls: "echoink-paper-guide-eyes" });
    mascot.createSpan({ cls: "echoink-paper-guide-mouth" });
    mascot.createSpan({ cls: "echoink-paper-guide-feet" });
    this.titleEl.prepend(mascot);
    this.closeControl()?.setAttribute("aria-label", zh ? "关闭" : "Close");

    this.choicesEl = this.contentEl.createDiv({ cls: "echoink-paper-guide-choices" });
    this.renderScenes();

    const footer = this.contentEl.createDiv({ cls: "echoink-paper-guide-footer" });
    this.feedbackEl = footer.createDiv({
      cls: "echoink-paper-guide-feedback",
      attr: { role: "status", "aria-live": "polite", "aria-atomic": "true" }
    });
    this.feedbackEl.hidden = true;
    this.skipButtonEl = footer.createEl("button", {
      cls: "echoink-paper-guide-skip",
      text: zh ? "我先自己逛逛" : "I'll explore on my own",
      attr: { type: "button" }
    });
    this.skipButtonEl.addEventListener("click", () => this.close());

    // Native Modal owns Escape, focus trapping, its document, and return focus.
    this.focusWindow = this.modalEl.ownerDocument.defaultView;
    this.focusFrame = this.focusWindow?.requestAnimationFrame(() => {
      this.focusFrame = null;
      if (this.closed || this.disposed || this.busy) return;
      const first = this.choicesEl?.querySelector<HTMLButtonElement>("button") ?? this.skipButtonEl;
      if (first?.isConnected) first.focus({ preventScroll: true });
    }) ?? null;
  }

  /** Refresh entitlement copy without replacing a focused button during saving. */
  updateScenes(scenes: readonly PaperGuideScene[]): void {
    if (this.closed || this.disposed) return;
    const next = scenes.slice(0, 3);
    if (this.busy) {
      this.pendingScenes = next;
      return;
    }
    this.scenes = next;
    this.renderScenes();
  }

  /** All native close affordances pass through the same persisted dismissal. */
  close(): void {
    if (this.closed || this.disposed || this.busy) return;
    void this.complete(() => this.options.onDismiss());
  }

  /** Unloading the plugin releases UI immediately without changing guide state. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (!this.closed) super.close();
  }

  onClose(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.focusFrame !== null) this.focusWindow?.cancelAnimationFrame(this.focusFrame);
    this.focusFrame = null;
    this.focusWindow = null;
    this.pendingScenes = null;
    this.contentEl.empty();
    this.choicesEl = null;
    this.feedbackEl = null;
    this.skipButtonEl = null;
    this.options.onClosed();
  }

  private renderScenes(): void {
    if (!this.choicesEl) return;
    const focused = this.modalEl.ownerDocument.activeElement;
    const hadSceneFocus = focused !== null && this.choicesEl.contains(focused);
    const focusedId = hadSceneFocus ? focused.getAttribute("data-paper-guide-scene") : null;
    this.choicesEl.empty();
    for (const scene of this.scenes) {
      const button = this.choicesEl.createEl("button", {
        cls: "echoink-paper-guide-choice",
        attr: { type: "button", "data-paper-guide-scene": scene.id }
      });
      const icon = button.createSpan({
        cls: "echoink-paper-guide-icon",
        attr: { "aria-hidden": "true" }
      });
      setIcon(icon, scene.icon);
      const copy = button.createSpan({ cls: "echoink-paper-guide-copy" });
      const heading = copy.createSpan({ cls: "echoink-paper-guide-choice-heading" });
      heading.createSpan({ cls: "echoink-paper-guide-choice-title", text: scene.title });
      if (scene.badge?.toLowerCase() === "pro") {
        createPluginEditionBadge(heading, "pro", this.options.language);
      } else if (scene.badge) {
        heading.createSpan({ cls: "echoink-paper-guide-badge", text: scene.badge });
      }
      if (scene.description) {
        copy.createSpan({ cls: "echoink-paper-guide-description", text: scene.description });
      }
      const arrow = button.createSpan({
        cls: "echoink-paper-guide-arrow",
        attr: { "aria-hidden": "true" }
      });
      setIcon(arrow, "arrow-right");
      button.addEventListener("click", () => {
        void this.complete(() => this.options.onChoose(scene.id), button);
      });
    }
    if (hadSceneFocus) {
      const buttons = Array.from(this.choicesEl.querySelectorAll<HTMLButtonElement>("button"));
      const replacement = buttons.find(button => button.dataset.paperGuideScene === focusedId)
        ?? buttons[0] ?? this.skipButtonEl;
      replacement?.focus({ preventScroll: true });
    }
  }

  private closeControl(): HTMLElement | null {
    return this.modalEl.querySelector<HTMLElement>(".modal-close-button, .modal-header-button");
  }

  private refreshBusyState(): void {
    this.modalEl.setAttribute("aria-busy", String(this.busy));
    for (const button of Array.from(this.contentEl.querySelectorAll<HTMLButtonElement>("button"))) {
      button.disabled = this.busy;
    }
    this.closeControl()?.setAttribute("aria-disabled", String(this.busy));
  }

  private async complete(
    action: () => Promise<(() => Promise<void>) | void>,
    chosenButton?: HTMLButtonElement
  ): Promise<void> {
    if (this.busy || this.closed || this.disposed) return;
    this.busy = true;
    chosenButton?.setAttribute("aria-busy", "true");
    this.refreshBusyState();
    if (this.feedbackEl) {
      this.feedbackEl.hidden = false;
      this.feedbackEl.removeClass("is-error");
      this.feedbackEl.setAttribute("role", "status");
      this.feedbackEl.setText(this.options.language === "en" ? "Saving…" : "正在保存…");
    }
    try {
      const navigate = await action();
      if (this.closed || this.disposed) return;
      super.close();
      if (navigate && !this.disposed) await navigate();
    } catch {
      if (this.disposed) return;
      const zh = this.options.language !== "en";
      if (this.closed) {
        new Notice(zh
          ? "未能打开所选功能，请从工作台重试。"
          : "Couldn't open the selected feature. Please try again from Home.");
      } else if (this.feedbackEl) {
        this.feedbackEl.hidden = false;
        this.feedbackEl.addClass("is-error");
        this.feedbackEl.setAttribute("role", "alert");
        this.feedbackEl.setText(zh
          ? "未能记住这次选择，请重试。"
          : "Couldn't save your choice. Please try again.");
      }
    } finally {
      this.busy = false;
      if (!this.closed && !this.disposed) {
        chosenButton?.removeAttribute("aria-busy");
        this.refreshBusyState();
        if (this.pendingScenes) {
          this.scenes = this.pendingScenes;
          this.pendingScenes = null;
          this.renderScenes();
        }
      }
    }
  }
}
