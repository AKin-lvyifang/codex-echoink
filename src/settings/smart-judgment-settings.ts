import type { DecisionClient } from "../membership/decision-client";
import { SMART_JUDGMENT_HELP, smartJudgmentView } from "./smart-judgment-view";
export { decisionResetDate, smartJudgmentView, SMART_JUDGMENT_HELP, type SmartJudgmentView } from "./smart-judgment-view";
import { OriginSetting } from "./origin-setting";
import { disposeOriginControls } from "./origin-controls";
import { applySettingsRow, attachSettingsHelpTooltip, createSettingsGroup, createSettingsSection } from "./settings-v2";

/**
 * 「账号与会员」里的「智能判断」分组：一个开关；内测多一行本月次数和进度条；
 * 付费档只显示“已开启”，用完才显示上限；基础版开关置灰 + 升级。
 */
export function renderSmartJudgmentSettings(parent: HTMLElement, deps: { client: DecisionClient | null; zh: boolean; openPlans(): void }): () => void {
  const { client, zh } = deps;
  const t = (cn: string, en: string) => zh ? cn : en;
  if (!client) return () => {};
  const section = createSettingsSection(parent, { title: t("智能判断", "Smart judgment"), surface: "group" });
  section.addClass("echoink-smart-judgment-settings");
  const header = section.querySelector<HTMLElement>(".echoink-settings-section-header")!;
  const status = header.createSpan({ cls: "echoink-cloud-sync-status echoink-smart-judgment-status", attr: { role: "status" } });
  const group = createSettingsGroup(section);
  const row = new OriginSetting(group).setName(t("开启智能判断", "Smart judgment"));
  applySettingsRow(row);
  const help = row.nameEl.createSpan({ cls: "echoink-settings-help" });
  const trigger = help.createEl("button", { attr: { type: "button", "aria-label": t("智能判断说明", "About smart judgment") } });
  attachSettingsHelpTooltip(trigger, zh ? SMART_JUDGMENT_HELP.zh : SMART_JUDGMENT_HELP.en, help);
  const controls: { upgrade?: HTMLButtonElement; toggle?: { setValue(value: boolean): unknown; setDisabled(value: boolean): unknown } } = {};
  row.addOriginButton(button => {
    controls.upgrade = button.buttonEl;
    button.setButtonText(t("升级 PRO", "Upgrade to PRO")).onClick(() => deps.openPlans());
  });
  row.addOriginToggle(toggle => {
    controls.toggle = toggle;
    toggle.toggleEl.setAttribute("aria-label", t("开启智能判断", "Turn on smart judgment"));
    toggle.setValue(client.enabled()).onChange(value => { void client.setEnabled(value); });
  });
  const usage = applySettingsRow(new OriginSetting(group).setName(t("本月次数", "This month")));
  usage.controlEl.addClass("echoink-smart-judgment-usage-control");
  const meter = usage.controlEl.createDiv({ cls: "echoink-cloud-sync-meter echoink-smart-judgment-meter", attr: { role: "progressbar", "aria-label": t("本月智能判断次数", "Smart judgments this month"), "aria-valuemin": "0", "aria-valuemax": "100" } });
  const fill = meter.createDiv({ cls: "echoink-cloud-sync-meter-fill" });

  const render = () => {
    const view = smartJudgmentView(client, zh);
    section.hidden = view.hidden;
    if (controls.upgrade) controls.upgrade.hidden = !view.free;
    controls.toggle?.setValue(view.on);
    controls.toggle?.setDisabled(view.free);
    status.setText(view.status);
    status.toggleClass("is-warning", view.warning);
    usage.settingEl.hidden = !view.usage;
    if (!view.usage) return;
    usage.setDesc(view.usage.text);
    meter.hidden = view.usage.percent === null;
    meter.setAttribute("aria-valuenow", String(view.usage.percent ?? 0));
    meter.toggleClass("is-warning", view.usage.warning);
    fill.style.width = `${view.usage.percent ?? 0}%`;
  };
  render();
  const unsubscribe = client.subscribe(render);
  // 账号页打开时拉一次最新次数。
  void client.refreshStatus({ maxAgeMs: 30_000 });
  return () => { unsubscribe(); disposeOriginControls(section); section.remove(); };
}
