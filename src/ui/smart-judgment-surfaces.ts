import { ownedEl } from "./owned-dom";
import { setIcon } from "obsidian";
import { getDecisionClient } from "../membership/decision-client";
import { SMART_JUDGMENT_HELP, smartJudgmentView } from "../settings/smart-judgment-view";
import { attachNativeTooltip } from "./native-tooltip";
import { smartJudgmentExhaustedActions, smartJudgmentExhaustedText, smartJudgmentIntroText } from "./smart-judgment-copy";

/** Shared behavior; each surface supplies its own existing controls and spacing. */
export function mountSmartJudgmentAccount(parent: HTMLElement, options: {
  english(): boolean; signedIn(): boolean; upgrade(): void;
  group(parent: HTMLElement, title: string): HTMLElement;
  row(parent: HTMLElement, title: string): HTMLElement;
  label(row: HTMLElement): HTMLElement;
  toggle(row: HTMLElement, change: (value: boolean) => Promise<void>): HTMLInputElement;
  button(text: string, action: () => void): HTMLButtonElement;
}): { refresh(): void; dispose(): void } {
  const client = getDecisionClient();
  if (!client) return { refresh() {}, dispose() {} };
  const doc = parent.ownerDocument, wrap = ownedEl(doc, "section");
  wrap.className = "echoink-smart-judgment-account"; parent.append(wrap);
  const t = (zh: string, en: string) => options.english() ? en : zh;
  const group = options.group(wrap, t("智能判断", "Smart judgment"));
  const row = options.row(group, t("开启智能判断", "Smart judgment"));
  const label = options.label(row), help = ownedEl(doc, "button");
  help.type = "button"; help.className = "echoink-smart-judgment-help";
  help.setAttribute("aria-label", t("智能判断说明", "About smart judgment")); setIcon(help, "circle-alert"); (label.firstElementChild ?? label).append(help);
  const tooltip = attachNativeTooltip(help, options.english() ? SMART_JUDGMENT_HELP.en : SMART_JUDGMENT_HELP.zh, { touch: "notice" });
  const status = ownedEl(doc, "span"); status.className = "echoink-smart-judgment-status"; status.setAttribute("role", "status"); label.append(status);
  const upgrade = options.button(t("升级 PRO", "Upgrade to PRO"), () => options.upgrade()); row.append(upgrade);
  const toggle = options.toggle(row, value => client.setEnabled(value));
  const usage = options.row(group, t("本月次数", "This month")), usageText = ownedEl(doc, "span");
  usageText.className = "echoink-smart-judgment-count"; options.label(usage).append(usageText);
  const meter = ownedEl(doc, "div"), fill = ownedEl(doc, "span");
  meter.className = "echoink-smart-judgment-meter"; meter.setAttribute("role", "progressbar");
  meter.setAttribute("aria-label", t("本月智能判断次数", "Smart judgments this month")); meter.setAttribute("aria-valuemin", "0"); meter.setAttribute("aria-valuemax", "100");
  meter.append(fill); usage.append(meter);
  const refresh = () => {
    const view = smartJudgmentView(client, !options.english());
    wrap.hidden = !options.signedIn() || view.hidden; upgrade.hidden = !view.free;
    toggle.checked = view.on; toggle.setAttribute("aria-checked", String(view.on)); toggle.disabled = view.free;
    status.textContent = view.status; status.classList.toggle("is-warning", view.warning);
    usage.hidden = !view.usage;
    if (!view.usage) return;
    usageText.textContent = view.usage.text; meter.hidden = view.usage.percent === null;
    meter.setAttribute("aria-valuenow", String(view.usage.percent ?? 0)); fill.style.width = `${view.usage.percent ?? 0}%`;
  };
  const unsubscribe = client.subscribe(refresh); refresh(); void client.refreshStatus({ maxAgeMs: 30_000 });
  return { refresh, dispose() { unsubscribe(); tooltip.dispose(); wrap.remove(); } };
}

export function mountSmartJudgmentNotice(parent: HTMLElement, options: {
  visible(): boolean; english(): boolean; openSettings(): void; upgrade(): void;
  button(text: string, action: () => void, primary: boolean): HTMLButtonElement;
  actionsClass: string;
}): { refresh(): void; dispose(): void } {
  const client = getDecisionClient();
  if (!client) return { refresh() {}, dispose() {} };
  const doc = parent.ownerDocument, card = ownedEl(doc, "section");
  card.className = "echoink-smart-judgment-card"; card.setAttribute("aria-label", "智能判断"); parent.append(card);
  let exhausted: string | null = null;
  const refresh = () => {
    card.replaceChildren(); card.hidden = true;
    if (!options.visible()) return;
    exhausted = client.takeExhaustedNotice() ?? exhausted;
    if (!client.exhausted()) exhausted = null;
    if (!exhausted && !client.shouldShowIntro()) return;
    const en = options.english(), beta = client.status()?.quota?.showCount === true;
    const copy = ownedEl(doc, "p"); copy.textContent = exhausted ? smartJudgmentExhaustedText(exhausted, beta, en) : smartJudgmentIntroText(en);
    const actions = ownedEl(doc, "div"); actions.className = options.actionsClass;
    const next = { upgrade: () => options.upgrade(), usage: () => options.openSettings(), dismiss() {} };
    const items = exhausted ? smartJudgmentExhaustedActions(beta, en) : [
      { action: "usage" as const, text: en ? "Settings" : "设置", primary: false },
      { action: "dismiss" as const, text: en ? "Got it" : "知道了", primary: true }
    ];
    for (const item of items) actions.append(options.button(item.text, () => {
      if (exhausted) { exhausted = null; refresh(); next[item.action](); }
      else void client.dismissIntro().then(() => next[item.action]());
    }, item.primary));
    card.append(copy, actions); card.hidden = false;
  };
  const unsubscribe = client.subscribe(refresh); refresh();
  return { refresh, dispose() { unsubscribe(); card.remove(); } };
}
