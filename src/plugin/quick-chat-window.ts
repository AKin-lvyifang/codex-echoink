import { Notice, Platform, WorkspaceWindow, type WorkspaceLeaf, type WorkspaceWindowInitData } from "obsidian";
import type CodexForObsidianPlugin from "../main";
import { CodexView, VIEW_TYPE_CODEX, type CodexViewMigrationState } from "../ui/codex-view";
import { normalizeAccelerator } from "../core/quick-hotkey";
import {
  computeQuickWindowBounds,
  getElectronRemote,
  getQuickGlobalShortcut,
  isNativeWindowUsable,
  resolveNativeWindowForDom,
  type QuickNativeWindowHandle
} from "../core/quick-window-bridge";

export type QuickChatRegistrationReason =
  | ""
  | "disabled"
  | "invalid"
  | "unavailable"
  | "occupied";

export interface QuickChatRegistrationResult {
  ok: boolean;
  reason: QuickChatRegistrationReason;
}

const QUICK_WINDOW_WIDTH = 420;
const QUICK_WINDOW_HEIGHT = 640;
const QUICK_POPOUT_BODY_CLASS = "echoink-quick-chat-popout";

/**
 * Owns the global quick-chat window: the global accelerator, the single
 * Obsidian popout that hosts the shared CodexView, and the migration between
 * the sidebar and that popout. The popout is hidden (never destroyed) when
 * collapsed, so drafts and running generations survive; explicit window
 * close keeps Obsidian's native destroy semantics.
 */
export class QuickChatWindowController {
  private workspaceWindow: WorkspaceWindow | null = null;
  private leaf: WorkspaceLeaf | null = null;
  private domWindow: Window | null = null;
  private nativeWindow: QuickNativeWindowHandle | null = null;
  private registeredAccelerator = "";
  private lastRegistration: QuickChatRegistrationResult = { ok: false, reason: "disabled" };
  private escapeCleanup: (() => void) | null = null;
  private toggling: Promise<void> | null = null;

  constructor(private readonly plugin: CodexForObsidianPlugin) {
    plugin.registerEvent(plugin.app.workspace.on("window-close", (closedWindow) => {
      if (closedWindow === this.workspaceWindow) this.clearAdoptedState();
    }));
  }

  get currentAccelerator(): string {
    return this.registeredAccelerator;
  }

  get registration(): QuickChatRegistrationResult {
    return this.lastRegistration;
  }

  get isQuickWindowOpen(): boolean {
    return this.isAdoptedAlive() && Boolean(this.nativeWindow?.isVisible?.());
  }

  /** True while the shared CodexView currently lives inside the managed popout. */
  isQuickWindowHoldingView(): boolean {
    return this.isAdoptedAlive();
  }

  /** Register (or re-register) the global accelerator from current settings. */
  applySettings(): QuickChatRegistrationResult {
    const result = this.computeRegistration();
    this.lastRegistration = result;
    return result;
  }

  private computeRegistration(): QuickChatRegistrationResult {
    this.unregisterAccelerator();
    const config = this.plugin.settings.quickChat;
    if (!config.enabled) return { ok: false, reason: "disabled" };
    const normalized = normalizeAccelerator(config.hotkey);
    if (!normalized) return { ok: false, reason: "invalid" };
    const shortcut = getQuickGlobalShortcut();
    if (!shortcut) return { ok: false, reason: "unavailable" };
    try {
      const registered = shortcut.register(normalized, () => {
        void this.toggle();
      });
      if (!registered) return { ok: false, reason: "occupied" };
      this.registeredAccelerator = normalized;
      return { ok: true, reason: "" };
    } catch {
      return { ok: false, reason: "invalid" };
    }
  }

  async toggle(): Promise<void> {
    if (this.toggling) return this.toggling;
    const task = (async () => {
      const native = this.nativeWindow;
      if (this.isAdoptedAlive() && native && isNativeWindowUsable(native)) {
        try {
          if (native.isVisible() && native.isFocused()) {
            this.hide();
            return;
          }
        } catch {
          // Fall through to the show path; ensurePopout re-validates state.
        }
      }
      await this.show();
    })();
    this.toggling = task;
    try {
      await task;
    } finally {
      if (this.toggling === task) this.toggling = null;
    }
    return task;
  }

  async show(): Promise<void> {
    if (!Platform.isDesktopApp || !getElectronRemote()) {
      this.notice(
        "当前环境不支持全局 AI 小窗，已打开侧栏。",
        "The quick AI window needs the desktop app; the sidebar was opened instead."
      );
      await this.plugin.activateView().catch(() => undefined);
      return;
    }
    try {
      await this.ensurePopout();
    } catch (error) {
      console.error("EchoInk quick window failed to open", error);
      this.notice(
        `打开 AI 小窗失败：${error instanceof Error ? error.message : String(error)}`,
        `Could not open the quick AI window: ${error instanceof Error ? error.message : String(error)}`
      );
      await this.plugin.activateView().catch(() => undefined);
      return;
    }
    const native = this.nativeWindow;
    if (!native || !isNativeWindowUsable(native)) {
      this.notice(
        "无法识别 AI 小窗的原生窗口，已打开侧栏。",
        "Could not resolve the native quick window; the sidebar was opened instead."
      );
      await this.plugin.activateView().catch(() => undefined);
      return;
    }
    try {
      native.show();
      native.focus();
    } catch (error) {
      console.error("EchoInk quick window focus failed", error);
    }
    this.currentView()?.focusInput();
  }

  hide(): void {
    const native = this.nativeWindow;
    if (!native || !isNativeWindowUsable(native)) return;
    try {
      native.hide();
    } catch (error) {
      console.error("EchoInk quick window hide failed", error);
    }
  }

  /**
   * Migrate the conversation view from the quick popout back into the right
   * sidebar. The view instance is rebuilt by Obsidian, so the migration guard
   * hands runs, queue, draft and composer state over to the successor.
   */
  async returnToSidebar(): Promise<void> {
    const leaf = this.leaf;
    const oldView = leaf?.view instanceof CodexView ? leaf.view : null;
    if (!leaf || !oldView) {
      this.clearAdoptedState();
      await this.plugin.activateView().catch(() => undefined);
      return;
    }
    oldView.enterMigrationMode();
    const snapshot = oldView.exportMigrationState();
    let succeeded = false;
    try {
      const workspace = this.plugin.app.workspace;
      const sidebarLeaf = workspace.getRightLeaf(true);
      if (!sidebarLeaf) throw new Error("无法创建右侧栏");
      await sidebarLeaf.setViewState({ type: VIEW_TYPE_CODEX, active: true });
      const newView = sidebarLeaf.view instanceof CodexView ? sidebarLeaf.view : null;
      if (newView && newView !== oldView) {
        newView.importMigrationState(snapshot);
        oldView.installMigrationForwarding(newView);
      }
      // Drop adopted state first so the popout's window-close event does not
      // race with the migration bookkeeping.
      this.clearAdoptedState();
      leaf.detach();
      succeeded = true;
      if (workspace.rightSplit.collapsed) workspace.rightSplit.expand();
      workspace.setActiveLeaf(sidebarLeaf, { focus: true });
      newView?.focusInput();
    } catch (error) {
      console.error("EchoInk quick window return-to-sidebar failed", error);
      this.notice(
        `回到侧边栏失败：${error instanceof Error ? error.message : String(error)}`,
        `Could not return to the sidebar: ${error instanceof Error ? error.message : String(error)}`
      );
      await this.plugin.activateView().catch(() => undefined);
    } finally {
      if (!succeeded) this.clearAdoptedState();
      oldView.exitMigrationMode();
    }
  }

  dispose(): void {
    this.unregisterAccelerator();
    this.clearAdoptedState();
  }

  private async ensurePopout(): Promise<void> {
    if (this.isAdoptedAlive()) return;
    this.clearAdoptedState();
    const workspace = this.plugin.app.workspace;
    const existing = workspace.getLeavesOfType(VIEW_TYPE_CODEX)
      .find((leaf) => leaf.view instanceof CodexView) ?? null;
    if (existing) {
      const container = typeof existing.getContainer === "function"
        ? existing.getContainer()
        : null;
      if (container instanceof WorkspaceWindow) {
        // Already living in a popout (manually detached earlier): adopt it.
        this.adopt(container, existing);
        return;
      }
      const oldView = existing.view as CodexView;
      oldView.enterMigrationMode();
      const snapshot = oldView.exportMigrationState();
      let popoutWindow: WorkspaceWindow;
      try {
        popoutWindow = workspace.moveLeafToPopout(existing, this.buildWindowInitData());
      } catch (error) {
        oldView.exitMigrationMode();
        throw error;
      }
      oldView.exitMigrationMode();
      const movedLeaf = await this.waitForCodexLeafInWindow(popoutWindow) ?? existing;
      this.adopt(popoutWindow, movedLeaf);
      this.handoverIfRebuilt(oldView, snapshot);
      return;
    }
    const newLeaf = workspace.openPopoutLeaf(this.buildWindowInitData());
    await newLeaf.setViewState({ type: VIEW_TYPE_CODEX, active: true });
    const container = typeof newLeaf.getContainer === "function"
      ? newLeaf.getContainer()
      : null;
    if (!(container instanceof WorkspaceWindow)) {
      throw new Error("无法创建 EchoInk 小窗容器");
    }
    this.adopt(container, newLeaf);
  }

  private handoverIfRebuilt(
    oldView: CodexView,
    snapshot: Readonly<CodexViewMigrationState>
  ): void {
    const newView = this.currentView();
    if (!newView || newView === oldView) return;
    newView.importMigrationState(snapshot);
    oldView.installMigrationForwarding(newView);
  }

  private async waitForCodexLeafInWindow(
    popoutWindow: WorkspaceWindow
  ): Promise<WorkspaceLeaf | null> {
    const deadline = Date.now() + 4_000;
    for (;;) {
      const leaf = this.findCodexLeafInWindow(popoutWindow);
      if (leaf) return leaf;
      if (Date.now() >= deadline) return null;
      await new Promise((resolve) => window.setTimeout(resolve, 50));
    }
  }

  private findCodexLeafInWindow(
    popoutWindow: WorkspaceWindow
  ): WorkspaceLeaf | null {
    return this.plugin.app.workspace.getLeavesOfType(VIEW_TYPE_CODEX)
      .find((leaf) => leaf.view instanceof CodexView
        && typeof leaf.getContainer === "function"
        && leaf.getContainer() === popoutWindow) ?? null;
  }

  private adopt(popoutWindow: WorkspaceWindow, leaf: WorkspaceLeaf): void {
    this.workspaceWindow = popoutWindow;
    this.leaf = leaf;
    this.domWindow = popoutWindow.win ?? null;
    this.nativeWindow = resolveNativeWindowForDom(this.domWindow);
    const doc = this.domWindow?.document ?? null;
    if (doc?.body) doc.body.classList.add(QUICK_POPOUT_BODY_CLASS);
    const native = this.nativeWindow;
    if (native && isNativeWindowUsable(native)) {
      try {
        native.setAlwaysOnTop(true, "floating");
        native.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      } catch (error) {
        console.warn("EchoInk quick window native decoration failed", error);
      }
    }
    this.installEscapeHandler(doc);
  }

  private installEscapeHandler(doc: Document | null): void {
    this.escapeCleanup?.();
    this.escapeCleanup = null;
    if (!doc) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      // IME composition and popups/menus handle their own Escape first: they
      // either set isComposing or preventDefault in earlier phases.
      if (event.isComposing || event.keyCode === 229) return;
      if (event.defaultPrevented) return;
      event.preventDefault();
      this.hide();
    };
    doc.addEventListener("keydown", onKeyDown);
    this.escapeCleanup = () => doc.removeEventListener("keydown", onKeyDown);
  }

  private clearAdoptedState(): void {
    this.escapeCleanup?.();
    this.escapeCleanup = null;
    this.workspaceWindow = null;
    this.leaf = null;
    this.domWindow = null;
    this.nativeWindow = null;
  }

  private isAdoptedAlive(): boolean {
    if (!this.workspaceWindow || !this.leaf) return false;
    if (!(this.leaf.view instanceof CodexView)) return false;
    if (!isNativeWindowUsable(this.nativeWindow)) return false;
    try {
      // The leaf still resolving to our WorkspaceWindow (with a live DOM
      // window) proves the popout was not closed underneath us.
      return typeof this.leaf.getContainer === "function"
        && this.leaf.getContainer() === this.workspaceWindow
        && Boolean(this.workspaceWindow.win);
    } catch {
      return false;
    }
  }

  private currentView(): CodexView | null {
    return this.leaf?.view instanceof CodexView ? this.leaf.view : null;
  }

  private buildWindowInitData(): WorkspaceWindowInitData {
    const bounds = computeQuickWindowBounds(QUICK_WINDOW_WIDTH, QUICK_WINDOW_HEIGHT);
    if (!bounds) return {};
    return {
      x: bounds.x,
      y: bounds.y,
      size: {
        width: bounds.width ?? QUICK_WINDOW_WIDTH,
        height: bounds.height ?? QUICK_WINDOW_HEIGHT
      }
    };
  }

  private unregisterAccelerator(): void {
    const accelerator = this.registeredAccelerator;
    this.registeredAccelerator = "";
    if (!accelerator) return;
    try {
      getQuickGlobalShortcut()?.unregister(accelerator);
    } catch (error) {
      console.warn("EchoInk quick window accelerator release failed", error);
    }
  }

  private notice(zhText: string, enText: string): void {
    const zh = this.plugin.settings.settingsLanguage === "zh-CN";
    new Notice(zh ? zhText : enText);
  }
}
