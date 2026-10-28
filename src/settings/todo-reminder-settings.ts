import { Notice, setIcon } from "obsidian";
import type CodexForObsidianPlugin from "../main";
import type { TodoReminderStatus } from "../home/todo-reminder-service";
import { OriginSetting } from "./origin-setting";
import { applySettingsRow, attachSettingsHelpTooltip, createSettingsGroup, createSettingsSection } from "./settings-v2";
import { createOriginCheck } from "./origin-controls";

export function todoReminderStatusText(status: TodoReminderStatus, english: boolean): string {
  const permission = {
    default: english ? "Not authorized yet. Enable reminders or send a test to request permission." : "尚未授权。开启提醒或发送测试通知时请求权限。",
    granted: english ? "The notification API is authorized. System settings or Do Not Disturb may still hide alerts." : "通知接口已授权。系统通知设置或勿扰模式仍可能隐藏提示。",
    denied: english ? "Notification permission was denied. Allow Obsidian notifications in the host/system settings, then try again." : "通知权限被拒绝。请在宿主或系统设置中允许 Obsidian 通知，再重试。",
    unavailable: english ? "Desktop notifications are unavailable in this host." : "当前宿主不支持桌面通知。"
  }[status.permission];
  const failures: Record<TodoReminderStatus["error"], string> = {
    "": "",
    read: english ? "Could not read the to-do source. No reminders were marked as sent; retrying while enabled." : "待办源文件读取失败，未登记已提醒；开启期间会重试。",
    send: english ? "The host could not send the notification. Check Obsidian's system notification settings and try the test again." : "宿主未能发送通知。请检查系统中的 Obsidian 通知设置，再发送测试通知。",
    unconfirmed: english ? "The host did not confirm sending. This was not marked as sent; try the test again." : "宿主未确认通知发送，未登记已提醒；请重试测试通知。",
    persistence: english ? "The reminder was sent, but its record could not be saved. It may repeat after restarting until saving succeeds." : "提醒已发送，但去重记录保存失败；保存成功前重启可能重复提醒。",
    settings: english ? "The setting could not be saved. Reminders are off for this session; the previous setting may return after restarting." : "设置保存失败，本次运行已关闭提醒；重启后可能恢复先前设置。",
    permission: english ? "Could not request permission. Check Obsidian's notification settings and try again." : "通知权限请求失败，请检查 Obsidian 的通知设置后重试。"
  };
  return [permission, failures[status.error]].filter(Boolean).join(" ");
}

/** Reuses standard settings rows and Origin controls; owns only its subscription. */
export function renderTodoReminderSettings(page: HTMLElement, plugin: CodexForObsidianPlugin, options: { embedded?: boolean } = {}): () => void {
  const service = plugin.getTodoReminderService();
  const english = plugin.settings.settingsLanguage === "en";
  const section = createSettingsSection(page, { title: options.embedded ? undefined : english ? "Desktop reminders" : "桌面提醒", surface: options.embedded ? "flat" : "group" });
  const group = createSettingsGroup(section);
  let disposed = false;
  let refreshToggle = () => {};
  let refreshButton = () => {};
  const name = english ? "Remind me when to-dos are due" : "待办到期提醒";
  const description = english
    ? "Remind unfinished to-dos while Obsidian is running. A date without a time uses 09:00 locally. Missed reminders are combined on return; quitting Obsidian stops reminders."
    : "Obsidian 运行时提醒未完成的到期事项。仅填日期按本地 09:00 提醒，重新启动或恢复运行时合并漏报；完全退出后不提醒。";
  const reminder = new OriginSetting(group).setName(name);
  if (options.embedded) {
    const wrapper = reminder.nameEl.createSpan({ cls: "echoink-settings-help" });
    const help = wrapper.createEl("button", { cls: "echoink-settings-help-trigger", attr: { type: "button", "aria-label": english ? "Reminder information" : "到期提醒说明" } });
    setIcon(help, "circle-alert"); attachSettingsHelpTooltip(help, description, wrapper);
    const check = createOriginCheck(reminder.controlEl, { attr: { "aria-label": name, "data-todo-reminder-toggle": "true" } });
    refreshToggle = () => { const status = service.status(); check.checked = status.enabled; check.disabled = status.busy || (status.permission === "unavailable" && !status.enabled); };
    check.onchange = () => { void service.setEnabled(check.checked).then(result => { if (!disposed && !result.ok && !result.cancelled) new Notice(todoReminderStatusText(service.status(), english)); }); };
  } else reminder.setDesc(description).addOriginToggle((toggle) => {
      toggle.toggleEl.setAttribute("aria-label", name);
      toggle.toggleEl.setAttribute("data-todo-reminder-toggle", "true");
      refreshToggle = () => {
        const status = service.status();
        toggle.setValue(status.enabled).setDisabled(status.busy || (status.permission === "unavailable" && !status.enabled));
      };
      toggle.onChange((enabled) => {
        void service.setEnabled(enabled).then((result) => {
          if (!disposed && !result.ok && !result.cancelled) new Notice(todoReminderStatusText(service.status(), english));
        });
      });
    });
  applySettingsRow(reminder);
  const statusRow = applySettingsRow(new OriginSetting(group).setName(english ? "Notification permission" : "通知权限"));
  statusRow.descEl.setAttribute("aria-live", "polite");
  statusRow.descEl.setAttribute("data-todo-reminder-status", "true");
  applySettingsRow(new OriginSetting(group).setName(english ? "Test notification" : "测试通知").setDesc(english
    ? "To-do reminder history is unchanged. Check the system notification center to confirm receipt."
    : "不改变待办提醒记录；请在系统通知中心确认是否收到。")
    .addOriginButton((button) => {
      button.buttonEl.setAttribute("type", "button");
      button.buttonEl.setAttribute("data-todo-reminder-test", "true");
      refreshButton = () => {
        const status = service.status();
        button.setButtonText(status.busy ? (english ? "Please wait…" : "请稍候…") : (english ? "Send test" : "发送测试"));
        button.setDisabled(status.busy || status.permission === "unavailable");
        button.buttonEl.setAttribute("aria-busy", String(status.busy));
      };
      button.onClick(() => {
        void service.testNotification().then((result) => {
          if (disposed || result.cancelled) return;
          new Notice(result.ok
            ? (english ? "The host confirmed sending. Check your system notification center for receipt." : "宿主已确认发送，请在系统通知中心确认是否收到。")
            : todoReminderStatusText(service.status(), english));
        });
      });
    }));
  const refresh = () => {
    if (disposed) return;
    refreshToggle();
    refreshButton();
    statusRow.setDesc(todoReminderStatusText(service.status(), english));
  };
  refresh();
  const unsubscribe = service.subscribe(refresh);
  return () => { disposed = true; unsubscribe(); };
}
