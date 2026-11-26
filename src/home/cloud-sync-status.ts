import { Notice, setIcon } from "obsidian";
import type CodexForObsidianPlugin from "../main";
import { createOriginButton, disposeOriginControls } from "../settings/origin-controls";
import { applyAmicroButton } from "../settings/amicro-buttons";
import { syncUsagePresentation } from "../settings/cloud-sync-presentation";
import { cloudSyncStatusText } from "../ui/mobile/cloud-sync-settings";
import { attachNativeTooltip } from "../ui/native-tooltip";

export interface WorkbenchCloudSyncState {
  icon: string;
  /** Full status for the tooltip and screen readers. */
  label: string;
  syncing: boolean;
  /** Set only when the user should act: an error, offline, a limit, or 90% of the quota used. */
  attention: string | null;
}

/** Reads the existing controller; never starts or changes synchronization. */
export function workbenchCloudSyncState(plugin: CodexForObsidianPlugin, zh: boolean): WorkbenchCloudSyncState | null {
  const controller = plugin.cloudSync;
  if (!controller) return null;
  const t = (cn: string, en: string) => zh ? cn : en;
  const view = controller.view(), ent = plugin.accountService?.read().entitlements;
  const active = ent?.sync.status !== "none" && !!ent?.sync.quotaBytes;
  const phase = view.status?.phase;
  const rateLimited = view.enableRateLimited || phase === "rate-limited";
  const usage = syncUsagePresentation(view.status?.usedBytes ?? 0, view.status?.quotaBytes ?? ent?.sync.quotaBytes ?? 0);
  const statusText = cloudSyncStatusText(view, zh);
  const label = !view.signedIn || rateLimited ? statusText : !active ? t("未开通（PRO / Max 订阅可用）", "Not included (PRO / Max)")
    : statusText + (view.status?.pending ? t(` · ${view.status.pending} 个待上传`, ` · ${view.status.pending} uploads pending`) : "");
  const phaseText = statusText.split(" · ")[0];
  const attention = !view.signedIn || !view.enabled ? (rateLimited ? statusText : null)
    : rateLimited ? statusText
    : phase === "error" || phase === "offline" || phase === "read-only" ? (phase === "offline" ? t("云同步已离线，连接恢复后自动续传。", "Cloud sync is offline and resumes when the connection returns.") : phase === "read-only" ? t("云同步为只读，订阅已到期。", "Cloud sync is read-only because the subscription has expired.") : t(`云同步出错：${phaseText}`, `Cloud sync error: ${phaseText}`))
    : active && view.status && usage.warning ? t(`云端空间已用 ${usage.percent}%`, `Cloud storage ${usage.percent}% used`)
    : null;
  return {
    icon: rateLimited ? "cloud" : !active || phase === "offline" ? "cloud-off" : "cloud",
    // Status texts may carry their own colon; keep one colon after the prefix.
    label: zh ? `云同步：${label.replace(/：/gu, "，")}` : `Cloud sync: ${label.replace(/: /gu, ", ")}`,
    syncing: phase === "syncing", attention
  };
}

/** The title-bar cloud button: a dot marks a state that needs attention; it opens account settings. */
export function mountWorkbenchCloudSync(parent: HTMLElement, plugin: CodexForObsidianPlugin, zh: boolean, onChange: () => void = () => {}): () => void {
  const controller = plugin.cloudSync;
  if (!controller) return () => {};
  const t = (cn: string, en: string) => zh ? cn : en;
  const button = createOriginButton(parent, { cls: "wb-button is-icon wb-cloud-sync", attr: { "data-wb-focus": "cloud-sync" } });
  applyAmicroButton(button, { variant: "icon" });
  const symbol = button.createSpan({ cls: "wb-button-icon wb-cloud-sync-icon", attr: { "aria-hidden": "true" } });
  const dot = button.createSpan({ cls: "wb-cloud-sync-dot", attr: { "aria-hidden": "true" } });
  // Search stays to the right of the cloud button.
  const search = parent.querySelector<HTMLElement>('[data-wb="search-trigger"]');
  if (search) parent.insertBefore(button, search);
  button.onclick = () => { void plugin.openEchoInkAccountSettings().catch(() => new Notice(t("设置未能打开。请重试。", "Settings did not open. Try again."))); };
  let tooltip = "", attention: string | null = null;
  attachNativeTooltip(button, () => tooltip);
  const render = () => {
    const state = workbenchCloudSyncState(plugin, zh);
    if (!state) return;
    setIcon(symbol, state.icon);
    symbol.toggleClass("is-syncing", state.syncing);
    dot.hidden = !state.attention;
    button.toggleClass("has-attention", !!state.attention);
    if (state.label !== tooltip) { tooltip = state.label; button.setAttribute("aria-label", tooltip); }
    if (state.attention !== attention) { attention = state.attention; onChange(); }
  };
  render();
  const unsubscribe = controller.subscribe(render), accountUnsubscribe = plugin.accountService?.subscribe(render);
  return () => { unsubscribe(); accountUnsubscribe?.(); disposeOriginControls(button); button.remove(); };
}
