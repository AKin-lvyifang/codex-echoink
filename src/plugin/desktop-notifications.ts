import { Platform } from "obsidian";

export type DesktopNotificationPermission = NotificationPermission | "unavailable";
export interface DesktopNotificationResult { ok: boolean; cancelled?: boolean; error?: string; }
export interface DesktopNotificationMessage { title: string; body: string; }

export interface DesktopNotificationPort {
  permission(): DesktopNotificationPermission;
  send(message: DesktopNotificationMessage): Promise<DesktopNotificationResult>;
  cancelPending(): void;
}

type NotificationWindow = Window & { Notification?: typeof Notification };

/** Uses the main Obsidian renderer's browser API; never requests permission implicitly. */
export class DesktopNotifications implements DesktopNotificationPort {
  private disposed = false;
  private pending = new Map<Notification, () => void>();

  constructor(private readonly win: Window | null, private readonly desktop = Platform.isDesktopApp) {}

  permission(): DesktopNotificationPermission {
    if (this.disposed || !this.desktop || !this.api()) return "unavailable";
    return this.api()!.permission;
  }

  private api(): typeof Notification | undefined {
    return (this.win as NotificationWindow | null)?.Notification;
  }

  /** Call directly from an enable/test interaction, before any other await. */
  async requestPermission(): Promise<DesktopNotificationPermission> {
    const permission = this.permission();
    if (permission !== "default") return permission;
    return this.api()!.requestPermission();
  }

  send(message: DesktopNotificationMessage): Promise<DesktopNotificationResult> {
    const permission = this.permission();
    if (permission !== "granted") return Promise.resolve({ ok: false, error: permission });
    return new Promise((resolve) => {
      let notification: Notification;
      try {
        notification = new (this.api()!)(message.title, { body: message.body });
      } catch {
        resolve({ ok: false, error: "send" });
        return;
      }
      let settled = false;
      const finish = (result: DesktopNotificationResult): void => {
        if (settled) return;
        settled = true;
        this.win?.clearTimeout(timer);
        notification.onshow = null;
        notification.onerror = null;
        notification.onclose = null;
        this.pending.delete(notification);
        resolve(result);
      };
      const cancel = (): void => {
        finish({ ok: false, cancelled: true });
        try { notification.close(); } catch { /* Renderer may already be gone. */ }
      };
      const timer = this.win!.setTimeout(() => {
        finish({ ok: false, error: "unconfirmed" });
        try { notification.close(); } catch { /* Best-effort cleanup. */ }
      }, 5000);
      this.pending.set(notification, cancel);
      notification.onshow = () => finish({ ok: true });
      notification.onerror = () => {
        finish({ ok: false, error: "send" });
        try { notification.close(); } catch { /* Best-effort cleanup. */ }
      };
      notification.onclose = () => finish({ ok: false, error: "unconfirmed" });
    });
  }

  cancelPending(): void {
    for (const cancel of [...this.pending.values()]) cancel();
  }

  dispose(): void { this.disposed = true; this.cancelPending(); }
}
