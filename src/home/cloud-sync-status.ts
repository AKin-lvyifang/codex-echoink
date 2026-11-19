import { Notice, setIcon } from "obsidian";
import type CodexForObsidianPlugin from "../main";
import { createOriginButton, disposeOriginControls } from "../settings/origin-controls";
import { syncUsagePresentation } from "../settings/cloud-sync-presentation";
import { cloudSyncStatusText } from "../ui/mobile/cloud-sync-settings";

/** Workbench projection of the existing controller; never starts or changes synchronization. */
export function mountWorkbenchCloudSync(parent: HTMLElement, plugin: CodexForObsidianPlugin, zh: boolean): () => void {
  const controller = plugin.cloudSync;
  if (!controller) return () => {};
  const t = (cn: string, en: string) => zh ? cn : en;
  const section = parent.createEl("section", { cls: "wb-section wb-cloud-sync" });
  section.createDiv({ cls: "wb-section-heading" }).createEl("h2", { text: t("云同步", "Cloud sync") });
  const row = section.createDiv({ cls: "wb-cloud-sync-row" });
  const symbol = row.createSpan({ cls: "wb-cloud-sync-icon", attr: { "aria-hidden": "true" } });
  const copy = row.createDiv({ cls: "wb-cloud-sync-copy" });
  copy.createDiv({ text: t("云同步", "Cloud sync") });
  const status = copy.createDiv({ cls: "wb-cloud-sync-status", attr: { role: "status" } });
  const meter = row.createDiv({ cls: "wb-cloud-sync-meter", attr: { role: "progressbar", "aria-label": t("云同步用量", "Cloud storage usage"), "aria-valuemin": "0", "aria-valuemax": "100" } });
  const fill = meter.createDiv({ cls: "wb-cloud-sync-fill" });
  const percent = row.createSpan({ cls: "wb-cloud-sync-percent" });
  const settings = createOriginButton(row, { text: t("设置", "Settings"), cls: "wb-btn wb-cloud-sync-settings" });
  settings.onclick = () => { void plugin.openEchoInkAccountSettings().catch(() => new Notice(t("设置未打开，请重试。", "Settings did not open. Try again."))); };
  const render = () => {
    const view = controller.view(), ent = plugin.accountService?.read().entitlements;
    const active = ent?.sync.status !== "none" && !!ent?.sync.quotaBytes;
    const rateLimited = view.enableRateLimited || view.status?.phase === "rate-limited";
    const data = syncUsagePresentation(view.status?.usedBytes ?? 0, view.status?.quotaBytes ?? ent?.sync.quotaBytes ?? 0);
    setIcon(symbol, rateLimited ? "cloud" : !active ? "cloud-off" : view.status?.phase === "syncing" ? "refresh-cw" : view.status?.phase === "offline" ? "cloud-off" : "cloud");
    symbol.toggleClass("is-syncing", view.status?.phase === "syncing");
    const statusText = cloudSyncStatusText(view, zh);
    status.setText(!view.signedIn || rateLimited ? statusText : !active ? t("未开通：云同步随 PRO / Max 订阅", "Cloud sync is included with PRO / Max subscriptions") : statusText + (view.status?.pending ? t(` · ${view.status.pending} 个待上传`, ` · ${view.status.pending} uploads pending`) : ""));
    settings.setText(active ? t("设置", "Settings") : t("查看权益", "View benefits"));
    meter.hidden = percent.hidden = !active || !view.status;
    fill.style.width = `${data.percent}%`;
    percent.setText(`${data.percent}%`);
    meter.setAttribute("aria-valuenow", String(data.percent));
    meter.setAttribute("aria-valuetext", data.label);
    row.toggleClass("is-warning", data.warning);
  };
  render();
  const unsubscribe = controller.subscribe(render), accountUnsubscribe = plugin.accountService?.subscribe(render);
  return () => { unsubscribe(); accountUnsubscribe?.(); disposeOriginControls(section); section.remove(); };
}
