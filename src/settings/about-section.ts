import { Notice, setIcon, setTooltip } from "obsidian";
import { openExternalInElectron } from "../core/electron";
import { createOriginButton } from "./origin-controls";
import { applyAmicroButton, setAmicroButtonPending } from "./amicro-buttons";
import type { ReleaseUpdateController } from "./release-update";

// Original filled GitHub mark from the existing About action in settings-tab.ts.
const GITHUB_MARK_PATH = "M12 2C6.477 2 2 6.477 2 12c0 4.42 2.865 8.166 6.839 9.489.5.092.682-.217.682-.482 0-.237-.009-.866-.013-1.7-2.782.604-3.369-1.34-3.369-1.34-.454-1.156-1.11-1.463-1.11-1.463-.908-.62.069-.608.069-.608 1.003.07 1.531 1.03 1.531 1.03.892 1.529 2.341 1.087 2.91.831.092-.646.35-1.086.636-1.336-2.22-.253-4.555-1.11-4.555-4.943 0-1.091.39-1.984 1.029-2.683-.103-.253-.446-1.27.098-2.647 0 0 .84-.269 2.75 1.025A9.578 9.578 0 0112 6.836c.85.004 1.705.115 2.504.337 1.909-1.294 2.747-1.025 2.747-1.025.546 1.377.203 2.394.1 2.647.64.699 1.028 1.592 1.028 2.683 0 3.842-2.339 4.687-4.566 4.935.359.309.678.919.678 1.852 0 1.336-.012 2.415-.012 2.743 0 .267.18.578.688.48C19.138 20.163 22 16.418 22 12c0-5.523-4.477-10-10-10z";

function renderMorphIcon(button: HTMLElement, idle: string, hover: string): void {
  const wrap = button.createSpan({ cls: "echoink-about-morph-icon-wrap", attr: { "aria-hidden": "true" } });
  setIcon(wrap.createSpan({ cls: "echoink-about-morph-icon-default" }), idle);
  setIcon(wrap.createSpan({ cls: "echoink-about-morph-icon-hover" }), hover);
}

function renderStarIcon(button: HTMLElement): void {
  const wrap = button.createSpan({ cls: "echoink-sparkle-icon-wrap", attr: { "aria-hidden": "true" } });
  const github = wrap.createSpan({ cls: "echoink-sparkle-icon-default" });
  const svg = button.ownerDocument.createElementNS("http://www.w3.org/2000/svg", "svg");
  for (const [key, value] of Object.entries({ width: "14", height: "14", viewBox: "0 0 24 24", fill: "currentColor", focusable: "false" })) svg.setAttribute(key, value);
  const path = button.ownerDocument.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", GITHUB_MARK_PATH); svg.appendChild(path); github.appendChild(svg);
  setIcon(wrap.createSpan({ cls: "echoink-sparkle-icon-hover" }), "star");
  for (const particle of ["p1", "p2"]) setIcon(wrap.createSpan({ cls: `echoink-sparkle-particle echoink-sparkle-${particle}` }), "star");
}

export function renderCompactAbout(parent: HTMLElement, options: {
  version: string; language: string; websiteUrl: string;
  onLogoClick: (altKey: boolean) => void;
  update: ReleaseUpdateController;
}): () => void {
  const zh = options.language !== "en";
  const openLink = (url: string) => {
    void openExternalInElectron(url).then(opened => {
      if (!opened) new Notice(zh ? "暂时无法打开链接" : "Could not open this link");
    }).catch(error => {
      console.warn("[EchoInk] Could not open about link", error);
      new Notice(zh ? "暂时无法打开链接" : "Could not open this link");
    });
  };
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
  for (const [kind, label, url] of [
    ["website", zh ? "访问官网" : "Visit website", options.websiteUrl],
    ["star", "Star on GitHub", "https://github.com/AKin-lvyifang/codex-echoink"],
    ["issue", zh ? "反馈问题" : "Report an issue", "https://github.com/AKin-lvyifang/codex-echoink/issues"]
  ]) {
    const button = createOriginButton(actions, { cls: `echoink-about-compact-${kind}`, attr: { type: "button", "aria-label": label } });
    applyAmicroButton(button, { variant: "icon" });
    if (kind === "star") renderStarIcon(button);
    else renderMorphIcon(button, kind === "website" ? "globe" : "message-circle", kind === "website" ? "send" : "check");
    setTooltip(button, label);
    button.onclick = () => { openLink(url); };
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
      link.onclick = event => { event.preventDefault(); openLink(state.url); };
    }
  };
  check.onclick = () => { void options.update.check(options.version); };
  const unsubscribe = options.update.subscribe(render);
  render();
  return unsubscribe;
}
