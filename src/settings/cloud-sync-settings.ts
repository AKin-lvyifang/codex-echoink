import { cloudFailureText } from "../sync/cloud/messages";
import { Notice, setIcon } from "obsidian";
import type CodexForObsidianPlugin from "../main";
import { textInputModal } from "../ui/modals";
import { cloudSyncStatusText } from "../ui/mobile/cloud-sync-settings";
import { cloudSyncScopeSummary, mountCloudSyncFolders } from "../ui/cloud-sync-folders";
import { OriginSetting } from "./origin-setting";
import { createOriginButton, createOriginCheck, disposeOriginControls } from "./origin-controls";
import { syncUsagePresentation, syncDeviceIcon, syncLastSeen } from "./cloud-sync-presentation";
import { applySettingsRow, createSettingsGroup, createSettingsNavigationRow, createSettingsSection } from "./settings-v2";

/** Opens a second-level page inside the settings container (top-left back); `closed` runs when it goes away. */
export type CloudSyncPageOpener = (title: string, render: (body: HTMLElement) => () => void) => void;

/** Desktop "云同步" group: on/off with the account password, folders, attachments, devices. */
export function renderDesktopCloudSync(plugin: CodexForObsidianPlugin, parent: HTMLElement, zh: boolean, openPage?: CloudSyncPageOpener): () => void {
  const controller = plugin.cloudSync;
  const section = createSettingsSection(parent, { title: zh ? "云同步" : "Cloud sync", surface: "group" });
  section.addClass("echoink-cloud-sync-settings");
  const header = section.querySelector<HTMLElement>(".echoink-settings-section-header")!;
  const status = header.createSpan({ cls: "echoink-cloud-sync-status", attr: { role: "status" } });
  const group = createSettingsGroup(section);
  if (!controller) { status.setText(zh ? "这台设备暂不支持云同步。" : "Cloud sync is not available on this device."); return () => { section.remove(); }; }
  const message = (error: unknown) => new Notice(cloudFailureText(error, zh));
  const settings = () => plugin.settings.cloudSync;
  let toggleControl: { setValue(value: boolean): unknown; setDisabled(value: boolean): unknown } | null = null;
  applySettingsRow(new OriginSetting(group).setName(zh ? "开启云同步" : "Cloud sync").setDesc(zh ? "用账号密码加密，EchoInk 看不到内容；忘记密码后重置，云端会用你设备上的数据重新上传。" : "Encrypted with your account password; EchoInk cannot read it. After a password reset the cloud is rebuilt from your devices.")
    .addOriginToggle(toggle => {
      toggle.toggleEl.setAttribute("aria-label", zh ? "开启云同步" : "Turn on cloud sync");
      toggleControl = toggle;
      toggle.setValue(controller.view().enabled).onChange(async value => {
        try {
          if (value) {
            const password = await textInputModal(plugin.app, zh ? "开启云同步" : "Turn on cloud sync", zh ? "账号密码" : "Account password", "", { secret: true });
            if (!password) { toggle.setValue(false); return; }
            await controller.enable(password);
          } else await controller.disable();
        } catch (error) {
          const view = controller.view();
          toggle.setValue(view.enabled);
          if (!view.enableRateLimited) message(error);
        }
      });
    }));
  // 主页面只留一行摘要；树形选择要浏览和搜索，按审美层第 8 节进二级页。
  const scopeTitle = zh ? "同步范围" : "Sync scope";
  const mountScope = (body: HTMLElement) => mountCloudSyncFolders({ parent: body, controller, settings, save: () => plugin.saveSettings(true), zh,
    createCheck: (host, labelledBy) => createOriginCheck(host, { attr: { "aria-labelledby": labelledBy } }), disposeChecks: disposeOriginControls, error: message });
  let stopFolders = () => {};
  let scopeValue: HTMLElement | null = null;
  if (openPage) {
    const scopeRow = createSettingsNavigationRow(group, { title: scopeTitle, value: cloudSyncScopeSummary(settings().excludedFolders, zh), focusKey: "account:cloud-sync-scope",
      onActivate: () => openPage(scopeTitle, body => { body.addClass("echoink-cloud-sync-scope-page"); const stop = mountScope(body); return () => { stop(); render(); }; }) });
    scopeRow.addClass("echoink-cloud-sync-scope-row");
    scopeValue = scopeRow.querySelector<HTMLElement>(".echoink-settings-navigation-value");
  } else {
    const folders = applySettingsRow(new OriginSetting(group).setName(scopeTitle));
    folders.settingEl.addClass("echoink-cloud-sync-folder-row");
    folders.controlEl.addClass("echoink-cloud-sync-folder-control");
    stopFolders = mountScope(folders.controlEl);
  }
  applySettingsRow(new OriginSetting(group).setName(zh ? "连附件一起同步" : "Include attachments").addOriginToggle(toggle => {
    toggle.toggleEl.setAttribute("aria-label", zh ? "连附件一起同步" : "Include attachments");
    toggle.setValue(settings().includeAttachments).onChange(async value => { const before = settings().includeAttachments; settings().includeAttachments = value; toggle.setDisabled(true); try { await plugin.saveSettings(true); controller.scopeChanged(); } catch (error) { settings().includeAttachments = before; toggle.setValue(before); message(error); } finally { toggle.setDisabled(false); } });
  }));
  const usage = applySettingsRow(new OriginSetting(group).setName(zh ? "用量" : "Usage"));
  usage.controlEl.addClass("echoink-cloud-sync-usage-control");
  const meter = usage.controlEl.createDiv({ cls: "echoink-cloud-sync-meter", attr: { role: "progressbar", "aria-label": zh ? "云同步用量" : "Cloud storage usage", "aria-valuemin": "0", "aria-valuemax": "100" } });
  const fill = meter.createDiv({ cls: "echoink-cloud-sync-meter-fill" });
  const deviceSection = createSettingsSection(parent, { title: zh ? "已绑定设备" : "Linked devices", surface: "group" });
  deviceSection.addClass("echoink-cloud-sync-device-section");
  const deviceCount = deviceSection.querySelector<HTMLElement>(".echoink-settings-section-header")!.createSpan({ cls: "echoink-cloud-sync-device-count" });
  const devices = createSettingsGroup(deviceSection);
  devices.addClass("echoink-cloud-sync-devices");
  const removing = new Set<string>();
  let deviceSignature = "";
  let render = () => {};
  render = () => {
    const view = controller.view();
    const scopeText = cloudSyncScopeSummary(settings().excludedFolders, zh);
    if (scopeValue && scopeValue.textContent !== scopeText) scopeValue.setText(scopeText);
    const account = plugin.accountService?.read(), ent = account?.entitlements;
    const unavailable = ent?.sync.status === "none";
    const rateLimited = view.enableRateLimited || view.status?.phase === "rate-limited";
    status.setText(view.signedIn && unavailable && !rateLimited ? zh ? "未开通：云同步随 PRO / Max 订阅" : "Cloud sync is included with PRO / Max subscriptions" : cloudSyncStatusText(view, zh));
    toggleControl?.setValue(view.enabled); toggleControl?.setDisabled(!view.signedIn || (!view.enabled && (!view.passwordSet || !view.deviceReady || unavailable)));
    const data = syncUsagePresentation(view.status?.usedBytes ?? 0, view.status?.quotaBytes ?? ent?.sync.quotaBytes ?? 0);
    usage.setDesc(view.status ? data.label : data.available ? `— / ${data.label.split(" / ")[1]}` : "—");
    meter.hidden = !view.status || !data.available;
    meter.setAttribute("aria-valuenow", String(data.percent));
    meter.setAttribute("aria-valuetext", data.label);
    meter.toggleClass("is-warning", data.warning);
    fill.style.width = `${data.percent}%`;
    status.toggleClass("is-warning", data.warning);
    const limit = ent?.sync.deviceLimit ?? account?.membership.deviceLimit;
    // Binding belongs to membership. A bound device may not have synced yet.
    const linked = account?.membership?.devices?.map(device => {
      const synced = view.devices.find(item => item.deviceId === device.id);
      return { deviceId: device.id, name: device.name, lastSeenAt: synced?.lastSeenAt ?? 0,
        kind: /ipad|tablet/iu.test(device.description) ? "tablet" : /iphone|android|phone/iu.test(device.description) ? "phone" : synced?.kind ?? "desktop" };
    }) ?? view.devices;
    deviceCount.setText(`${linked.length} / ${limit ?? "—"}`);
    const nextDevices = JSON.stringify([linked, [...removing], controller.deviceId, linked.map(device => syncLastSeen(device.lastSeenAt, zh))]);
    if (nextDevices === deviceSignature) return;
    deviceSignature = nextDevices;
    disposeOriginControls(devices); devices.empty();
    if (!linked.length) devices.createDiv({ cls: "echoink-cloud-sync-device-seen echoink-cloud-sync-device", text: zh ? "还没有已绑定设备" : "No linked devices yet" });
    for (const device of [...linked].sort((a, b) => Number(b.deviceId === controller.deviceId) - Number(a.deviceId === controller.deviceId))) {
      const line = devices.createDiv({ cls: "echoink-cloud-sync-device" });
      setIcon(line.createSpan({ cls: "echoink-cloud-sync-device-icon", attr: { "aria-hidden": "true" } }), syncDeviceIcon(device.kind));
      const copy = line.createDiv({ cls: "echoink-cloud-sync-device-copy" });
      copy.createDiv({ cls: "echoink-cloud-sync-device-name", text: device.deviceId === controller.deviceId ? `${device.name}${zh ? "（本机）" : " (this device)"}` : device.name });
      copy.createDiv({ cls: "echoink-cloud-sync-device-seen", text: syncLastSeen(device.lastSeenAt, zh) });
      if (device.deviceId !== controller.deviceId) {
        const busy = removing.has(device.deviceId);
        const button = createOriginButton(line, { text: busy ? zh ? "解绑中…" : "Removing…" : zh ? "解绑" : "Remove", cls: "text-button is-tertiary echoink-cloud-sync-remove", attr: { "aria-label": `${zh ? "解绑" : "Remove"} ${device.name}` } });
        button.disabled = busy;
        button.onclick = () => {
          if (removing.has(device.deviceId)) return;
          removing.add(device.deviceId); render();
          void controller.revokeDevice(device.deviceId).catch(message).finally(() => { removing.delete(device.deviceId); render(); });
        };
      }
    }
  };
  render();
  const unsubscribe = controller.subscribe(render);
  void controller.refreshDevices();
  return () => { unsubscribe(); stopFolders(); disposeOriginControls(section); disposeOriginControls(deviceSection); section.remove(); deviceSection.remove(); };
}
