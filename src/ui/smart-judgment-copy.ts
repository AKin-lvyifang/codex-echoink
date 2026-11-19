import { decisionResetDate } from "../settings/smart-judgment-view";

/** 智能判断在对话里只说的两句话；桌面和手机共用。 */
export function smartJudgmentIntroText(en: boolean): string {
  return en ? "Smart judgment is on: choosing skills, recalling memories and categorizing bills get more accurate." : "已为你开启智能判断：选技能、挑记忆、给账单分类会更准。";
}
export function smartJudgmentExhaustedText(resetAt: string, beta: boolean, en: boolean): string {
  const date = decisionResetDate(resetAt, en);
  return en
    ? `${beta ? "This month's smart judgments are used up" : "Smart judgment reached this month's limit"}; it resumes ${date}. Answers continue as usual, with skills and memories chosen the original way.`
    : `${beta ? "本月智能判断次数用完了" : "本月智能判断已达上限"}，${date}恢复。在这之前照常回答，只是选技能、挑记忆回到原来的方式。`;
}

export type SmartJudgmentExhaustedAction = { action: "upgrade" | "usage" | "dismiss"; text: string; primary: boolean };
/** 用完卡片的按钮：内测档引导升级（升级 PRO 在前、主按钮）；付费档已达上限不推销（查看次数 / 知道了）。 */
export function smartJudgmentExhaustedActions(beta: boolean, en: boolean): SmartJudgmentExhaustedAction[] {
  const usage: SmartJudgmentExhaustedAction = { action: "usage", text: en ? "View usage" : "查看次数", primary: false };
  return beta
    ? [{ action: "upgrade", text: en ? "Upgrade to PRO" : "升级 PRO", primary: true }, usage]
    : [usage, { action: "dismiss", text: en ? "Got it" : "知道了", primary: true }];
}
