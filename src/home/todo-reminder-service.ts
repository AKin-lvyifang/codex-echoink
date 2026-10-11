import type CodexForObsidianPlugin from "../main";
import { DesktopNotifications, type DesktopNotificationPermission, type DesktopNotificationPort, type DesktopNotificationResult } from "../plugin/desktop-notifications";
import { TodoReminderScheduler, type TodoReminderFailure } from "./todo-reminders";

export interface TodoDesktopNotifications extends DesktopNotificationPort {
  requestPermission(): Promise<DesktopNotificationPermission>;
  dispose(): void;
}

export interface TodoReminderStatus {
  enabled: boolean;
  permission: DesktopNotificationPermission;
  busy: boolean;
  error: TodoReminderFailure | "settings" | "permission";
}

/** Coordinates the existing Markdown store, local settings and desktop lifecycle. */
export class TodoReminderService {
  private readonly notifications: TodoDesktopNotifications;
  private readonly scheduler: TodoReminderScheduler;
  private readonly win: Window | null;
  private readonly doc: Document;
  private readonly listeners = new Set<() => void>();
  private disconnectSource: (() => void) | null = null;
  private observing = false;
  private started = false;
  private disposed = false;
  private actionVersion = 0;
  private pendingActions = 0;
  private error: TodoReminderStatus["error"] = "";

  constructor(private readonly plugin: CodexForObsidianPlugin, notifications?: TodoDesktopNotifications, now = () => Date.now()) {
    this.doc = plugin.app.workspace.containerEl.ownerDocument;
    this.win = this.doc.defaultView;
    this.notifications = notifications ?? new DesktopNotifications(this.win);
    this.scheduler = new TodoReminderScheduler({
      settings: () => this.plugin.settings.todoReminders,
      readRecords: async () => {
        const store = this.plugin.getTodoStore();
        await store.initialize();
        await store.reload();
        return store.snapshot();
      },
      persist: () => this.persist(),
      notifications: this.notifications,
      english: () => this.plugin.settings.settingsLanguage === "en",
      report: (error) => { this.error = error; this.emit(); },
      now,
      setTimeout: (callback, delay) => this.win!.setTimeout(callback, delay),
      clearTimeout: (timer) => this.win?.clearTimeout(timer)
    });
  }

  start(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    this.applyEnabled();
  }

  status(): TodoReminderStatus {
    return { enabled: this.plugin.settings.todoReminders.enabled, permission: this.notifications.permission(), busy: this.pendingActions > 0, error: this.error };
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void { if (!this.disposed) for (const listener of [...this.listeners]) listener(); }
  private persist(): Promise<void> { return this.plugin.saveSettings(true, { flushConversationStore: false }); }

  private readonly resume = (): void => { this.emit(); this.scheduler.resume(); };
  private readonly visibilityChanged = (): void => { if (this.doc.visibilityState !== "hidden") this.resume(); };

  private applyEnabled(): void {
    if (!this.started || this.disposed) return;
    if (this.plugin.settings.todoReminders.enabled && this.win && this.notifications.permission() !== "unavailable") {
      if (!this.observing) {
        this.observing = true;
        this.disconnectSource = this.plugin.getTodoStore().subscribe(() => this.scheduler.sourceChanged());
        this.win.addEventListener("focus", this.resume);
        this.win.addEventListener("pageshow", this.resume);
        this.doc.addEventListener("visibilitychange", this.visibilityChanged);
      }
      this.scheduler.start();
    } else this.disconnect();
  }

  private disconnect(): void {
    this.scheduler.stop();
    this.disconnectSource?.();
    this.disconnectSource = null;
    this.win?.removeEventListener("focus", this.resume);
    this.win?.removeEventListener("pageshow", this.resume);
    this.doc.removeEventListener("visibilitychange", this.visibilityChanged);
    this.observing = false;
  }

  async setEnabled(enabled: boolean): Promise<DesktopNotificationResult> {
    if (this.disposed) return { ok: false, cancelled: true };
    const version = ++this.actionVersion;
    this.pendingActions++;
    this.error = "";
    // Permission is requested in the original user gesture, before saving.
    const permission = enabled ? this.notifications.requestPermission() : Promise.resolve(this.notifications.permission());
    if (!enabled) { this.plugin.settings.todoReminders.enabled = false; this.disconnect(); }
    this.emit();
    try {
      const granted = await permission;
      if (this.disposed || version !== this.actionVersion) return { ok: false, cancelled: true };
      if (enabled && granted !== "granted") return { ok: false, error: granted };
      this.plugin.settings.todoReminders.enabled = enabled;
      try { await this.persist(); }
      catch {
        this.plugin.settings.todoReminders.enabled = false;
        this.disconnect();
        this.error = "settings";
        return { ok: false, error: "settings" };
      }
      if (this.disposed || version !== this.actionVersion) return { ok: false, cancelled: true };
      this.start();
      this.applyEnabled();
      return { ok: true };
    } catch { this.error = "permission"; return { ok: false, error: "permission" }; }
    finally { this.pendingActions--; this.emit(); }
  }

  async testNotification(): Promise<DesktopNotificationResult> {
    if (this.disposed || this.pendingActions) return { ok: false, cancelled: true };
    const version = this.actionVersion;
    this.pendingActions++;
    this.error = "";
    const permission = this.notifications.requestPermission();
    this.emit();
    try {
      const granted = await permission;
      if (this.disposed || version !== this.actionVersion) return { ok: false, cancelled: true };
      if (granted !== "granted") return { ok: false, error: granted };
      const english = this.plugin.settings.settingsLanguage === "en";
      const result = await this.notifications.send({
        title: english ? "EchoInk · Test notification" : "EchoInk · 测试通知",
        body: english ? "Desktop notifications are available. To-do reminders work while Obsidian is running." : "桌面通知测试。待办到期提醒仅在 Obsidian 运行时生效。"
      });
      if (!result.ok && !result.cancelled) this.error = result.error === "unconfirmed" ? "unconfirmed" : "send";
      return result;
    } catch { this.error = "permission"; return { ok: false, error: "permission" }; }
    finally { this.pendingActions--; this.emit(); }
  }

  dispose(): void {
    this.disposed = true;
    this.actionVersion++;
    this.disconnect();
    this.notifications.dispose();
    this.listeners.clear();
  }
}
