import { setIcon, setTooltip } from "obsidian";
import { openExternalInElectron } from "../core/electron";
import { createOriginButton } from "./origin-controls";
import { applyAmicroButton, setAmicroButtonPending } from "./amicro-buttons";
import type { ReleaseUpdateController } from "./release-update";

export function renderCompactAbout(parent: HTMLElement, options: {
  version: string; language: string; websiteUrl: string;
  onLogoClick: (altKey: boolean) => void;
  update: ReleaseUpdateController;
}): () => void {
  const zh = options.language !== "en";
  const row = parent.createDiv({ cls: "echoink-about-compact" });
  const brand = row.createDiv({ cls: "echoink-about-compact-brand" });
  const logo = createOriginButton(brand, { cls: "echoink-about-compact-icon", attr: { type: "button", "aria-label": "EchoInk Agent" } });
  applyAmicroButton(logo, { variant: "icon" });
  setIcon(logo, "feather");
  logo.onclick = event => options.onLogoClick(event.altKey);
  const name = brand.createDiv();
  name.createDiv({ cls: "echoink-about-compact-name", text: "EchoInk Agent" });
  name.createDiv({ cls: "echoink-about-compact-version", text: `v${options.version}` });
  const actions = row.createDiv({ cls: "echoink-about-compact-actions" });
  for (const [icon, label, url] of [
    ["globe", zh ? "访问官网" : "Visit website", options.websiteUrl],
    ["github", "GitHub", "https://github.com/AKin-lvyifang/codex-echoink"],
    ["message-circle", zh ? "反馈问题" : "Report an issue", "https://github.com/AKin-lvyifang/codex-echoink/issues"]
  ]) {
    const button = createOriginButton(actions, { attr: { type: "button", "aria-label": label } });
    applyAmicroButton(button, { variant: "icon" });
    setIcon(button, icon); setTooltip(button, label);
    button.onclick = () => { openExternalInElectron(url); };
  }
  const check = createOriginButton(actions, { cls: "echoink-about-compact-check", attr: { type: "button" } });
  applyAmicroButton(check, { variant: "primary", icon: "refresh-cw" });
  const checkLabel = check.createSpan();
  const status = row.createDiv({ cls: "echoink-about-compact-status", attr: { role: "status", "aria-live": "polite" } });
  const render = () => {
    const state = options.update.state;
    const pending = state.status === "checking";
    check.disabled = pending;
    setAmicroButtonPending(check, pending);
    checkLabel.setText(pending ? (zh ? "正在检查…" : "Checking…") : (zh ? "检查更新" : "Check for updates"));
    status.empty(); status.hidden = state.status === "idle" || pending;
    status.toggleClass("is-error", state.status === "error");
    if (state.status === "error") status.setText(zh ? "暂时无法检查，请重试" : "Could not check for updates. Please try again.");
    if (state.status === "current") status.setText(zh ? "已是最新版本" : "You're up to date");
    if (state.status === "available") {
      status.createSpan({ text: zh ? `发现新版本 v${state.version}` : `New version v${state.version}` });
      const link = status.createEl("a", { text: zh ? "查看发布页" : "View release", attr: { href: state.url, target: "_blank", rel: "noopener noreferrer" } });
      link.onclick = event => { event.preventDefault(); openExternalInElectron(state.url); };
    }
  };
  check.onclick = () => { void options.update.check(options.version); };
  const unsubscribe = options.update.subscribe(render);
  render();
  return unsubscribe;
}
