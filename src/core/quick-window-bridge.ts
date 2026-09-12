import { Platform } from "obsidian";

/**
 * Minimal Electron desktop bridge for the Quick Chat Window.
 *
 * Every entry point is fail-safe: when the desktop capability is missing
 * (mobile, old Electron, blocked remote module) the helpers return null or
 * false so plugin startup and the sidebar conversation keep working.
 *
 * A DOM Window is NOT an Electron BrowserWindow. Native window handles must
 * always be resolved through `resolveNativeWindowForDom`, which asks the
 * target window's own renderer context so popout windows are never confused
 * with the main window.
 */

type WindowWithRequire = Window & {
  require?: (moduleName: string) => unknown;
  electron_windowId?: number;
};

export interface QuickNativeWindowBounds {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

export interface QuickNativeCloseEvent {
  preventDefault(): void;
}

export interface QuickNativeWindowHandle {
  show(): void;
  hide(): void;
  focus(): void;
  isVisible(): boolean;
  isFocused(): boolean;
  isDestroyed(): boolean;
  setAlwaysOnTop(flag: boolean, level?: string): void;
  setVisibleOnAllWorkspaces(
    visible: boolean,
    options?: { visibleOnFullScreen?: boolean }
  ): void;
  setBounds(bounds: QuickNativeWindowBounds): void;
  getBounds(): QuickNativeWindowBounds;
  /** Remote-proxied EventEmitter: used for the window-level `close` hook. */
  on?(event: string, listener: (event: QuickNativeCloseEvent) => void): void;
  readonly id?: number;
  readonly webContents?: { readonly id?: number };
}

export interface QuickGlobalShortcutBridge {
  register(accelerator: string, callback: () => void): boolean;
  unregister(accelerator: string): void;
  isRegistered(accelerator: string): boolean;
}

export interface QuickScreenRectangle {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface QuickScreenBridge {
  getCursorScreenPoint(): { x: number; y: number };
  getDisplayNearestPoint(point: { x: number; y: number }): {
    bounds: QuickScreenRectangle;
    workArea: QuickScreenRectangle;
  };
}

export interface QuickElectronRemote {
  globalShortcut?: QuickGlobalShortcutBridge;
  screen?: QuickScreenBridge;
  getCurrentWindow?(): QuickNativeWindowHandle;
  getCurrentWebContents?(): { readonly id?: number };
  /** Remote-proxied Electron app; used to observe app quit for cleanup. */
  app?: {
    on?(event: string, listener: () => void): unknown;
  };
  BrowserWindow?: {
    getAllWindows(): QuickNativeWindowHandle[];
    fromId?(id: number): QuickNativeWindowHandle | null;
  };
}

function windowRequire(
  target: Window | null
): ((moduleName: string) => unknown) | null {
  if (!target) return null;
  const candidate = (target as WindowWithRequire).require;
  return typeof candidate === "function" ? candidate : null;
}

/**
 * Resolve the `@electron/remote` bridge (or the legacy `electron.remote`)
 * from the given window's own renderer context. Callers that need the native
 * window of a popout must pass that popout's DOM Window so module lookups run
 * in the correct webContents context.
 */
export function getElectronRemote(
  contextWindow: Window | null = window
): QuickElectronRemote | null {
  if (!Platform.isDesktopApp) return null;
  const requireFn = windowRequire(contextWindow);
  if (!requireFn) return null;
  try {
    const direct = requireFn("@electron/remote") as QuickElectronRemote | undefined;
    if (direct) return direct;
  } catch {
    // @electron/remote is not bundled; fall through to the legacy shape.
  }
  try {
    const electron = requireFn("electron") as { remote?: QuickElectronRemote } | undefined;
    return electron?.remote ?? null;
  } catch {
    return null;
  }
}

export function getQuickGlobalShortcut(): QuickGlobalShortcutBridge | null {
  const shortcut = getElectronRemote()?.globalShortcut;
  if (!shortcut || typeof shortcut.register !== "function") return null;
  return shortcut;
}

export function getQuickScreen(): QuickScreenBridge | null {
  const screen = getElectronRemote()?.screen;
  if (!screen || typeof screen.getDisplayNearestPoint !== "function") return null;
  return screen;
}

/**
 * Map a DOM Window (typically an Obsidian popout's `WorkspaceWindow.win`) to
 * its Electron BrowserWindow handle. Returns null when desktop capabilities
 * are unavailable; callers must treat that as "quick window unsupported".
 */
export function resolveNativeWindowForDom(
  domWindow: Window | null
): QuickNativeWindowHandle | null {
  if (!Platform.isDesktopApp || !domWindow) return null;
  try {
    const contextRemote = getElectronRemote(domWindow);
    const current = contextRemote?.getCurrentWindow?.();
    if (current && typeof current.isVisible === "function") return current;
    // Fallback: Obsidian exposes the native window id on each DOM window.
    const windowId = (domWindow as WindowWithRequire).electron_windowId;
    const hostRemote = getElectronRemote();
    if (typeof windowId === "number" && hostRemote?.BrowserWindow) {
      const byId = hostRemote.BrowserWindow.fromId?.(windowId);
      if (byId) return byId;
      const match = hostRemote.BrowserWindow.getAllWindows()
        .find((candidate) => candidate.id === windowId);
      if (match) return match;
    }
    // Last resort: match by webContents id resolved in the target context.
    const targetContentsId = contextRemote?.getCurrentWebContents?.()?.id;
    if (typeof targetContentsId === "number" && hostRemote?.BrowserWindow) {
      const match = hostRemote.BrowserWindow.getAllWindows()
        .find((candidate) => candidate.webContents?.id === targetContentsId);
      if (match) return match;
    }
  } catch {
    // Remote access can throw on hardened hosts; degrade to unsupported.
  }
  return null;
}

/** Bounds that place a window of the given size at the upper-middle of the
 * display nearest to the mouse cursor. Falls back to the main window's
 * screen metrics when the Electron screen bridge is unavailable. */
export function computeQuickWindowBounds(
  width: number,
  height: number
): QuickNativeWindowBounds | null {
  const screen = getQuickScreen();
  if (screen) {
    try {
      const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
      const area = display.workArea ?? display.bounds;
      return {
        x: Math.round(area.x + (area.width - width) / 2),
        y: Math.round(area.y + Math.max(48, area.height * 0.12)),
        width,
        height
      };
    } catch {
      // Fall through to DOM screen metrics below.
    }
  }
  if (typeof window === "undefined" || !window.screen) return null;
  const screenX = window.screenX ?? 0;
  const screenY = window.screenY ?? 0;
  const availWidth = window.screen.availWidth || width;
  const availHeight = window.screen.availHeight || height;
  return {
    x: Math.round(screenX + (availWidth - width) / 2),
    y: Math.round(screenY + Math.max(48, availHeight * 0.12)),
    width,
    height
  };
}

export function isNativeWindowUsable(handle: QuickNativeWindowHandle | null): boolean {
  if (!handle) return false;
  try {
    return !handle.isDestroyed();
  } catch {
    return false;
  }
}
