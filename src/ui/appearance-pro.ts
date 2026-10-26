import { createPluginEditionBadge } from "../settings/plugin-edition-badge";
import { membershipWebsiteLink } from "../membership/website-links";
let sequence = 0;

/** Paid choices stay focusable so the reason and existing upgrade route are reachable. */
export function decorateProAppearanceChoice(trigger: HTMLElement, parent: HTMLElement, options: {
  zh: boolean; allowed(): boolean; upgrade(): void; blocked?(): void;
}): () => void {
  createPluginEditionBadge(trigger, "pro", options.zh ? "zh-CN" : "en");
  const doc = trigger.ownerDocument, panel = doc.createElement("div");
  panel.className = "echoink-appearance-pro-popover"; panel.id = `echoink-appearance-pro-${++sequence}`;
  panel.setAttribute("popover", "auto"); panel.setAttribute("role", "dialog"); panel.hidden = true;
  trigger.setAttribute("aria-controls", panel.id); trigger.setAttribute("aria-haspopup", "dialog");
  const message = doc.createElement("span"); message.textContent = options.zh ? "PRO 专属，开通后可用" : "PRO exclusive. Upgrade to use this appearance.";
  message.id = `${panel.id}-message`; trigger.setAttribute("aria-describedby", message.id); panel.setAttribute("aria-label", message.textContent);
  const link = doc.createElement("a"); link.className = "echoink-appearance-upgrade";
  link.href = membershipWebsiteLink("plugin.plan.year", { planId: "year", currency: options.zh ? "CNY" : "USD" });
  link.textContent = options.zh ? "开通 PRO" : "Get PRO";
  link.addEventListener("click", event => { event.preventDefault(); hide(); options.upgrade(); });
  panel.append(message, link); parent.append(panel);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => { if (timer !== undefined) clearTimeout(timer); timer = undefined; };
  function hide(): void { cancel(); if (typeof panel.hidePopover === "function" && panel.matches(":popover-open")) panel.hidePopover(); panel.hidden = true; }
  const show = () => {
    cancel(); if (options.allowed() || !trigger.isConnected) return;
    panel.hidden = false; if (typeof panel.showPopover === "function" && !panel.matches(":popover-open")) panel.showPopover();
    const anchor = trigger.getBoundingClientRect(), bounds = panel.getBoundingClientRect();
    panel.style.left = `${Math.max(8, Math.min(anchor.left + anchor.width / 2 - bounds.width / 2, (doc.defaultView?.innerWidth ?? 1000) - bounds.width - 8))}px`;
    panel.style.top = `${Math.max(8, anchor.top - bounds.height - 8)}px`;
  };
  trigger.addEventListener("mouseenter", show); trigger.addEventListener("focusin", show);
  trigger.addEventListener("click", event => { if (!options.allowed()) { event.preventDefault(); event.stopPropagation(); show(); if (options.blocked) setTimeout(() => options.blocked?.(), 0); } }, true);
  const leave = () => { cancel(); timer = setTimeout(hide, 120); };
  trigger.addEventListener("mouseleave", leave); panel.addEventListener("mouseenter", cancel); panel.addEventListener("mouseleave", leave);
  trigger.addEventListener("keydown", event => { if (event.key === "Escape") hide(); });
  return () => { const locked = !options.allowed(); trigger.classList.toggle("is-pro-locked", locked); trigger.setAttribute("aria-disabled", String(locked)); if (!locked) hide(); };
}
