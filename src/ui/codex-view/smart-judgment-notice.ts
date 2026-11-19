import { setIcon } from "obsidian";
import type { DecisionClient } from "../../membership/decision-client";
import { createOriginButton, disposeOriginControls } from "../../settings/origin-controls";
import { applyAmicroButton } from "../../settings/amicro-buttons";
import { smartJudgmentExhaustedActions, smartJudgmentExhaustedText, smartJudgmentIntroText } from "../smart-judgment-copy";

/**
 * 智能判断在对话里只说两次话：第一次开启时一张卡片（知道了 / 设置），本月次数用完时一句提示（每期只一次）。
 * 平时不显示次数。卡片只在界面上，不进会话记录。
 */
export class SmartJudgmentNotice {
  /** The exhausted line belongs to the conversation where it happened. */
  private exhausted: { resetAt: string; conversationId: string } | null = null;

  constructor(
    private readonly container: HTMLElement,
    private readonly deps: { client(): DecisionClient | null; language(): string; openSettings(): void; upgrade(): void }
  ) {
    container.addClass("echoink-task-interruption", "echoink-smart-judgment-notice");
    container.hidden = true;
  }

  /** Called on every chat render and when the judgment state changes. */
  render(visible: boolean, conversationId: string): void {
    const client = this.deps.client();
    disposeOriginControls(this.container);
    this.container.replaceChildren();
    if (!client || !visible) { this.container.hidden = true; return; }
    const resetAt = client.takeExhaustedNotice();
    if (resetAt) this.exhausted = { resetAt, conversationId };
    if (this.exhausted && !client.exhausted()) this.exhausted = null;
    const en = this.deps.language() === "en";
    if (this.exhausted?.conversationId === conversationId) {
      const beta = client.status()?.quota?.showCount === true;
      this.copy(smartJudgmentExhaustedText(this.exhausted.resetAt, beta, en));
      const next = { upgrade: () => this.deps.upgrade(), usage: () => this.deps.openSettings(), dismiss: () => {} };
      // 点任一个都收起；每期只提示一次由 takeExhaustedNotice 保证。
      this.actions(smartJudgmentExhaustedActions(beta, en).map(item => ({ ...item, run: () => { this.exhausted = null; this.render(true, conversationId); next[item.action](); } })));
      this.container.hidden = false;
      return;
    }
    if (client.shouldShowIntro()) {
      const row = this.container.createDiv({ cls: "echoink-task-interruption-copy echoink-smart-judgment-intro" });
      const icon = row.createSpan({ attr: { "aria-hidden": "true" } });
      setIcon(icon, "sparkles");
      row.createSpan({ text: smartJudgmentIntroText(en) });
      this.actions([
        { text: en ? "Settings" : "设置", run: () => { void client.dismissIntro(); this.deps.openSettings(); } },
        { text: en ? "Got it" : "知道了", primary: true, run: () => { void client.dismissIntro(); } }
      ]);
      this.container.hidden = false;
      return;
    }
    this.container.hidden = true;
  }

  dispose(): void { disposeOriginControls(this.container); this.container.replaceChildren(); }

  private copy(text: string): void { this.container.createDiv({ cls: "echoink-task-interruption-copy", text }); }
  private actions(items: readonly { text: string; primary?: boolean; run(): void }[]): void {
    const actions = this.container.createDiv({ cls: "echoink-task-interruption-actions" });
    for (const item of items) {
      const button = createOriginButton(actions, { text: item.text, attr: { type: "button" } });
      applyAmicroButton(button, { variant: item.primary ? "primary" : "secondary" });
      button.onclick = event => { event.stopPropagation(); item.run(); };
    }
  }
}
