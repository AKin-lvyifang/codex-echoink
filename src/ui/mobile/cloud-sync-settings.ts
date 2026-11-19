import { cloudFailureText } from "../../sync/cloud/messages";
import type { CloudSyncController, CloudSyncView } from "../../sync/cloud/controller";
import type { CloudSyncSettings } from "../../sync/cloud/settings";
import { syncUsagePresentation } from "../../settings/cloud-sync-presentation";
import { mountCloudSyncFolders } from "../cloud-sync-folders";
import { createOriginCheck, disposeOriginControls } from "./origin-controls";
import { shellElement as el } from "./shell-controls";

/** One status line the user reads at a glance; details stay in the service's own words. */
export function cloudSyncStatusText(view: CloudSyncView, zh = true, now = Date.now()): string {
 const t = (cn: string,en: string) => zh ? cn : en;
 if (!view.signedIn) return t("请先在账号与会员登录，再开启同步。", "Sign in under Account & membership, then turn on sync.");
 if (!view.deviceReady) return cloudFailureText("DEVICE_REQUIRED", zh);
 if (view.enableRateLimited) return cloudFailureText("SYNC_ENABLE_RATE_LIMITED", zh);
 if (!view.enabled) return view.passwordSet ? t("未开启", "Off") : cloudFailureText("PASSWORD_REQUIRED", zh);
 const status=view.status;
 if (!status) return view.keyReady ? t("准备中…", "Getting ready…") : t("请重新输入同步密码。", "Enter your sync password again.");
 if (status.phase === "rate-limited") {
   const remaining = (status.retryAt ?? now) - now;
   if (remaining < 60_000) return t("同步请求过多，稍后自动继续", "Too many sync requests. Sync will resume shortly.");
   const minutes = Math.ceil(remaining / 60_000);
   return t(`同步请求过多，约 ${minutes} 分钟后自动继续`, `Too many sync requests. Sync will resume in about ${minutes} minute${minutes === 1 ? "" : "s"}.`);
 }
 const used=syncUsagePresentation(status.usedBytes,status.quotaBytes).label;
 const phase={idle:t("已同步","Synced"),syncing:t("同步中…","Syncing…"),offline:status.lastError==="RATE_LIMITED" ? cloudFailureText("RATE_LIMITED",zh) : t("离线，连接恢复后自动续传。","Offline. Sync resumes when connected."),error:cloudFailureText(status.lastError,zh),"read-only":t("订阅已到期：只读 30 天","Subscription expired: read-only for 30 days"),stopped:t("已停止","Stopped")}[status.phase];
 const warning=status.nearQuota && status.phase!=="error" ? t(" · 云端空间快满了，请清理不需要的文件。"," · Cloud storage is almost full. Remove unneeded files.") : "";
 return `${phase} · ${used}${warning}`;
}

/**
 * Mobile "云同步" group. The host supplies the row builders of its own shell so iPhone and iPad keep their look;
 * this only decides what the rows say and do.
 */
export function renderMobileCloudSync(input: {
  readonly document: Document;
  readonly language?: string;
  readonly group: HTMLElement;
  readonly controller: CloudSyncController | null;
  readonly settings: () => CloudSyncSettings;
  readonly save: () => Promise<void>;
  readonly row: (label: string, control: HTMLElement) => void;
  readonly field: (label: string, value: string, change: (value: string) => void, type?: string) => HTMLInputElement;
  readonly switchRow: (label: string, checked: boolean, change: (checked: boolean) => Promise<void> | void) => HTMLInputElement;
  readonly button: (label: string, action: () => void, variant?: string) => HTMLButtonElement;
  readonly error: (failure?: unknown) => void;
}): () => void {
  const { document, group, controller } = input;
  const zh = input.language !== "en";
  const t = (cn: string,en: string) => zh ? cn : en;
  const report = (failure?: unknown) => input.error(failure ? new Error(cloudFailureText(failure, zh)) : undefined);
  const status = el(document, "div", "emc-muted cloud-sync-status");
  group.append(status);
  if (!controller) { status.textContent = t("这台设备暂不支持云同步，请使用支持的设备。", "Cloud sync is unavailable on this device. Use a supported device."); return () => {}; }
  let password = "";
  const passwordField = input.field("账号密码", "", value => { password = value; }, "password");
  passwordField.autocomplete = "current-password";
  const enableSwitch = input.switchRow("开启云同步", controller.view().enabled, async checked => {
    try {
      if (checked) { if (!password) throw new Error(cloudFailureText("PASSWORD_REQUIRED",zh)); await controller.enable(password); password = ""; passwordField.value = ""; }
      else await controller.disable();
      report();
    } catch (failure) { report(controller.view().enableRateLimited ? undefined : failure); render(); }
  });
  const folders = el(document, "div", "cloud-sync-folder-field");
  folders.append(el(document, "div", "cloud-sync-folder-heading", t("同步范围", "Sync scope"))); group.append(folders);
  const stopFolders = mountCloudSyncFolders({ parent: folders, controller, settings: input.settings, save: input.save, mobile: true, zh,
    createCheck: (parent, labelledBy) => createOriginCheck(parent, { attr: { "aria-labelledby": labelledBy } }), disposeChecks: disposeOriginControls, error: report });
  const attachmentSwitch = input.switchRow("连附件一起同步", input.settings().includeAttachments, async checked => {
    const before = input.settings().includeAttachments; input.settings().includeAttachments = checked;
    try { await input.save(); controller.scopeChanged(); } catch (error) { input.settings().includeAttachments = before; attachmentSwitch.checked = before; report(error); }
  });
  const devices = el(document, "div", "emc-muted cloud-sync-devices"); group.append(devices);
  const removing = new Set<string>();
  let deviceSignature = "";
  const render = () => {
    const view = controller.view();
    status.textContent = cloudSyncStatusText(view, zh);
    enableSwitch.checked = view.enabled; enableSwitch.disabled = !view.signedIn || (!view.enabled && (!view.passwordSet || !view.deviceReady));
    passwordField.parentElement!.hidden = view.enabled || !view.signedIn || !view.passwordSet || !view.deviceReady;
    const nextDevices = JSON.stringify([view.devices, [...removing], controller.deviceId]);
    if (nextDevices === deviceSignature) return;
    deviceSignature = nextDevices;
    devices.replaceChildren();
    for (const device of view.devices) {
      const line = el(document, "div", "cloud-sync-device");
      line.append(el(document, "span", "", device.deviceId === controller.deviceId ? `${device.name}（本机）` : device.name));
      if (device.deviceId !== controller.deviceId) {
        const button = input.button(removing.has(device.deviceId) ? t("解绑中…", "Removing…") : t("解绑", "Remove"), () => {
          if (removing.has(device.deviceId)) return;
          removing.add(device.deviceId); render();
          void controller.revokeDevice(device.deviceId).catch(report).finally(() => { removing.delete(device.deviceId); render(); });
        }, "is-text");
        button.disabled = removing.has(device.deviceId); line.append(button);
      }
      devices.append(line);
    }
  };
  render();
  const unsubscribe = controller.subscribe(render);
  return () => { unsubscribe(); stopFolders(); };
}
