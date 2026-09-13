import { Notice, Platform, WorkspaceTabs, WorkspaceWindow, type WorkspaceLeaf, type WorkspaceSplit, type WorkspaceWindowInitData } from "obsidian";
import type CodexForObsidianPlugin from "../main";
import { CodexView, VIEW_TYPE_CODEX, type CodexViewMigrationState } from "../ui/codex-view";
import { normalizeAccelerator } from "../core/quick-hotkey";
import {
  computeQuickWindowBounds,
  getElectronRemote,
  getQuickGlobalShortcut,
  isNativeWindowUsable,
  resolveNativeWindowForDom,
  type QuickNativeCloseEvent,
  type QuickNativeWindowBounds,
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

/** Structural view of Obsidian's internal workspace layout tree. */
interface QuickLayoutNode {
  children?: QuickLayoutNode[];
  /** Runtime signature is (index, child); an out-of-range index appends. */
  insertChild?(index: number, node: QuickLayoutNode): unknown;
  removeChild?(node: QuickLayoutNode): unknown;
  detach?(): void;
}

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
  private disposing = false;
  private appQuitting = false;
  private migrationInProgress = false;
  private lastBounds: QuickNativeWindowBounds | null = null;

  constructor(private readonly plugin: CodexForObsidianPlugin) {
    plugin.registerEvent(plugin.app.workspace.on("window-close", (closedWindow) => {
      if (closedWindow === this.workspaceWindow) this.clearAdoptedState();
    }));
    // Observe app quit so window-level close during shutdown never triggers
    // an automatic return-to-sidebar migration.
    try {
      const remoteApp = getElectronRemote()?.app;
      for (const quitEvent of ["before-quit", "will-quit"]) {
        remoteApp?.on?.(quitEvent, () => {
          this.appQuitting = true;
        });
      }
    } catch {
      // Remote bridge missing: quit protection degrades to the dispose flag.
    }
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
      // The Electron registry is shared by every Vault and plugin in this
      // process. Only unregisterAccelerator may release our own registration;
      // an occupied candidate must stay with its existing owner.
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
    this.rememberBounds();
    try {
      native.hide();
    } catch (error) {
      console.error("EchoInk quick window hide failed", error);
    }
  }

  /**
   * Window-level close (traffic-light button, Cmd+W, `window.close()`) returns
   * the conversation to the right sidebar instead of destroying it: the close
   * is blocked, the shared view migrates with runs/draft intact, and the now
   * empty popout closes through the same native path.
   */
  private handleNativeClose(event?: QuickNativeCloseEvent): void {
    if (this.disposing || this.appQuitting || this.migrationInProgress) return;
    if (!this.leaf || !(this.leaf.view instanceof CodexView)) return;
    if (event && typeof event.preventDefault === "function") event.preventDefault();
    void this.returnToSidebar();
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
    this.migrationInProgress = true;
    this.rememberBounds();
    oldView.enterMigrationMode();
    const snapshot = oldView.exportMigrationState();
    let succeeded = false;
    try {
      const workspace = this.plugin.app.workspace;
      // Move the ORIGINAL leaf back into the top sidebar tab group: one leaf
      // for the whole conversation, no duplicate tabs or splits.
      let targetLeaf: WorkspaceLeaf | null = null;
      const tabGroup = this.findSidebarTabGroup(workspace.rightSplit);
      if (tabGroup) {
        const tabNode = tabGroup as unknown as QuickLayoutNode;
        // Fresh leaf via the official API, then claimed by the top tab group.
        const created = workspace.getRightLeaf(true);
        if (created) {
          const oldParent = created.parent as unknown as QuickLayoutNode | null;
          tabNode.insertChild?.(tabNode.children?.length ?? 0, created);
          // insertChild does not prune the previous parent's children array;
          // sync it manually and drop the group when it becomes empty.
          if (oldParent && oldParent !== tabNode) {
            const siblings = oldParent.children;
            if (Array.isArray(siblings)) {
              const at = siblings.indexOf(created);
              if (at >= 0) siblings.splice(at, 1);
            }
            if (!siblings || siblings.length === 0) {
              const grand = (oldParent as { parent?: QuickLayoutNode }).parent;
              const uncles = grand?.children;
              if (Array.isArray(uncles)) {
                const at = uncles.indexOf(oldParent);
                if (at >= 0) uncles.splice(at, 1);
              }
              const shell = oldParent as { containerEl?: { detach?: () => void } };
              shell.containerEl?.detach?.();
            }
          }
          targetLeaf = created;
        }
      } else {
        targetLeaf = workspace.getRightLeaf(true);
      }
      if (!targetLeaf) throw new Error("无法创建右侧栏标签");
      await targetLeaf.setViewState({ type: VIEW_TYPE_CODEX, active: true });
      const newView = targetLeaf.view instanceof CodexView ? targetLeaf.view : null;
      if (newView && newView !== oldView) {
        newView.importMigrationState(snapshot);
        oldView.installMigrationForwarding(newView);
      }
      // The popout leaf exits last, through the official detach path, so the
      // window closes with no dangling leaves.
      this.clearAdoptedState();
      leaf.detach();
      succeeded = true;
      this.cleanupEmptySidebarGroups();
      if (workspace.rightSplit.collapsed) workspace.rightSplit.expand();
      workspace.setActiveLeaf(targetLeaf, { focus: true });
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
      this.migrationInProgress = false;
    }
  }

  dispose(): void {
    this.disposing = true;
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
      try {
        native.on?.("close", (event) => this.handleNativeClose(event));
      } catch (error) {
        console.warn("EchoInk quick window close hook failed", error);
      }
    }
    this.installEscapeHandler(doc);
  }

  private rememberBounds(): void {
    const native = this.nativeWindow;
    if (!native || !isNativeWindowUsable(native)) return;
    try {
      // Copy eagerly: remote member proxies die with their BrowserWindow, so
      // the remembered bounds must be plain numbers.
      const { x, y, width, height } = native.getBounds();
      if (typeof x === "number" && typeof y === "number") {
        this.lastBounds = { x, y, width, height };
      }
    } catch {
      // Keep the previously remembered bounds.
    }
  }

  /**
   * The sidebar home for the conversation is the right sidebar's existing
   * top tab group (the one hosting Outline/Backlinks/etc.), never a fresh
   * split: a new tab is appended there so sibling tabs stay untouched.
   */
  private findSidebarTabGroup(rightSplit: WorkspaceSplit): WorkspaceTabs | null {
    const systemTabTypes = new Set([
      "outline",
      "backlink",
      "outgoing-link",
      "tag",
      "search",
      "file-explorer",
      "bookmarks",
      "starred",
      "calendar"
    ]);
    let firstTabs: WorkspaceTabs | null = null;
    let systemTabs: WorkspaceTabs | null = null;
    const walk = (item: unknown): void => {
      if (!item || typeof item !== "object") return;
      if (item instanceof WorkspaceTabs) {
        if (!firstTabs) firstTabs = item;
        if (!systemTabs) {
          const children = (item as unknown as QuickLayoutNode).children ?? [];
          const hostsSystemTab = children.some((child) => {
            const leaf = child as unknown as WorkspaceLeaf;
            const type = typeof leaf.view?.getViewType === "function"
              ? leaf.view.getViewType()
              : "";
            return systemTabTypes.has(type);
          });
          if (hostsSystemTab) systemTabs = item;
        }
        return;
      }
      const children = (item as QuickLayoutNode).children;
      if (Array.isArray(children)) {
        for (const child of children) walk(child);
      }
    };
    walk(rightSplit);
    return systemTabs ?? firstTabs;
  }

  /**
   * Remove tab groups/splits under the right sidebar that became empty after
   * the migration (e.g. splits created by earlier misplaced returns), while
   * keeping the top tab group and anything still hosting a view.
   */
  private cleanupEmptySidebarGroups(): void {
    const workspace = this.plugin.app.workspace;
    const rightSplit = workspace.rightSplit;
    const keep = this.findSidebarTabGroup(rightSplit);
    const prune = (item: unknown): boolean => {
      if (!item || typeof item !== "object") return false;
      if (item instanceof WorkspaceTabs) {
        // Drop stray empty tabs left behind by earlier misplaced migrations
        // (never the active leaf, never real views).
        const tabsNode = item as unknown as QuickLayoutNode;
        for (const child of [...(tabsNode.children ?? [])]) {
          const leaf = child as unknown as WorkspaceLeaf;
          const type = typeof leaf.view?.getViewType === "function"
            ? leaf.view.getViewType()
            : "";
          if (type === "empty" && leaf !== workspace.activeLeaf) {
            tabsNode.removeChild?.(child);
          }
        }
        if (item === keep) return false;
        const children = tabsNode.children ?? [];
        return children.length === 0;
      }
      if (item === rightSplit) return false;
      const node = item as QuickLayoutNode;
      if (!Array.isArray(node.children)) return false;
      for (const child of [...node.children]) {
        if (prune(child)) {
          this.detachLayoutChild(node, child);
        }
      }
      return node.children.length === 0;
    };
    try {
      const root = rightSplit as unknown as QuickLayoutNode;
      for (const child of [...(root.children ?? [])]) {
        if (prune(child)) {
          this.detachLayoutChild(root, child);
        }
      }
    } catch (error) {
      console.warn("EchoInk quick window sidebar cleanup skipped", error);
    }
  }

  private detachLayoutChild(parent: QuickLayoutNode, child: QuickLayoutNode): void {
    if (typeof parent.removeChild === "function") {
      parent.removeChild(child);
      return;
    }
    child.detach?.();
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
    // Reuse the last user-placed bounds so re-invoking the quick window never
    // resets a position the user dragged to.
    if (this.lastBounds?.x !== undefined && this.lastBounds?.y !== undefined) {
      return {
        x: this.lastBounds.x,
        y: this.lastBounds.y,
        size: {
          width: this.lastBounds.width ?? QUICK_WINDOW_WIDTH,
          height: this.lastBounds.height ?? QUICK_WINDOW_HEIGHT
        }
      };
    }
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
