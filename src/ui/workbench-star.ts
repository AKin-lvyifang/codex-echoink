import { Notice, setIcon } from "obsidian";
import { openExternalInElectron } from "../core/electron";
import { GITHUB_STAR_URL, type WorkbenchNotices } from "../membership/workbench-notices";
import { renderStarIcon } from "../settings/about-section";

export function mountWorkbenchStar(
  anchor: HTMLElement, notices: WorkbenchNotices,
  options: { language: string; canShow: () => boolean; focusFallback: HTMLElement },
): { refresh(): void; dispose(): void } {
  const doc = anchor.ownerDocument, win = doc.defaultView!;
  const english = options.language === "en";
  const title = english ? "Support the developer" : "支持作者";
  let timer: number | undefined;
  let scheduledAt: number | undefined;
  let coolingDown = false;
  let card: HTMLElement | undefined;
  let disposed = false;

  function close(restoreFocus: boolean): void {
    if (!card) return;
    const containedFocus = card.contains(doc.activeElement);
    card.remove(); card = undefined;
    notices.releaseStar();
    if (restoreFocus && containedFocus && options.focusFallback.isConnected) options.focusFallback.focus({ preventScroll: true });
  }
  function later(): void {
    notices.laterStar();
    close(true);
  }
  function render(): void {
    card = anchor.createDiv({ cls: "echoink-workbench-star", attr: { role: "dialog", "aria-label": title } });
    const icon = card.createSpan({ cls: "echoink-star-feather", attr: { "aria-hidden": "true" } });
    setIcon(icon, "feather");
    const body = card.createDiv({ cls: "echoink-star-body" });
    body.createDiv({ cls: "echoink-star-title", text: title });
    body.createDiv({ cls: "echoink-star-text", text: english
      ? "If EchoInk has been helpful, consider starring it on GitHub. Thank you for your support."
      : "如果 EchoInk 对您有帮助，欢迎在 GitHub 点亮 Star。感谢您的支持。" });
    const actions = body.createDiv({ cls: "echoink-star-actions" });
    const dismiss = actions.createEl("button", { cls: "echoink-star-later", text: english ? "Maybe later" : "以后再说", attr: { type: "button" } });
    dismiss.onclick = later;
    const link = actions.createEl("button", { cls: "mod-cta echoink-star-go echoink-about-compact-star", attr: { type: "button" } });
    renderStarIcon(link);
    link.createSpan({ text: english ? "Star on GitHub" : "点亮 Star" });
    link.onclick = () => {
      notices.clickStar();
      close(true);
      void openExternalInElectron(GITHUB_STAR_URL).then(opened => {
        if (!opened) new Notice(english ? "Could not open GitHub." : "无法打开 GitHub。");
      }).catch(() => new Notice(english ? "Could not open GitHub." : "无法打开 GitHub。"));
    };
  }
  function refresh(): void {
    if (disposed) return;
    const at = notices.starReadyAt();
    if (at === undefined || !options.canShow()) {
      win.clearTimeout(timer); timer = undefined;
      close(false);
      return;
    }
    if (card) return;
    const now = Date.now();
    if (timer !== undefined && at === scheduledAt && (!coolingDown || at > now)) return;
    win.clearTimeout(timer);
    scheduledAt = at;
    coolingDown = at > now;
    timer = win.setTimeout(() => {
      timer = undefined;
      if (!disposed && options.canShow() && notices.openStar()) render();
      else if (!disposed && at > Date.now()) refresh();
    }, Math.max(0, at - now) + 1500);
  }
  const escape = (event: KeyboardEvent) => {
    if (!card || event.key !== "Escape" || event.defaultPrevented || !options.canShow()) return;
    event.preventDefault();
    later();
  };
  doc.addEventListener("keydown", escape);
  const unsubscribe = notices.subscribe(refresh);
  refresh();
  return { refresh, dispose() {
    disposed = true; win.clearTimeout(timer); close(false); unsubscribe();
    doc.removeEventListener("keydown", escape);
  } };
}
