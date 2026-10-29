import type { DiaryFinanceCandidate } from "../diary-organizer/types";
import { money } from "../lifestyle/finance-domain";

/** Presentation only: keep the stored reasons and write eligibility intact. */
export function diaryReviewReason(reasons: readonly string[], zh: boolean): string {
  const rules: Array<[RegExp, string, string]> = [
    [/他人|别人|属于你本人|付款人|ownership|someone else|paid by/iu, "可能是别人付的，确认一下", "Someone else may have paid. Please check."],
    [/已经发生|是否发生|未发生|购买计划|消费计划|打算|还没|尚未|planned|not yet/iu, "可能还没发生，确认一下", "This may not have happened yet. Please check."],
    [/金额|币种|垫付|代付|报销|amount|currency|advance/iu, "金额、币种或垫付关系还不清楚", "Check the amount, currency or who paid upfront."],
    [/转账|退款|分摊|平摊|transfer|refund|split/iu, "转账、退款或分摊，确认一下", "Check this transfer, refund or split payment."],
    [/分类|category/iu, "分类还没对上，选一下", "Choose a matching category."],
    [/重复|同一|相同候选|duplicate/iu, "可能已经记过，确认一下", "This may already be recorded. Please check."],
    [/引用|原文.*核对/iu, "原文还没核对上，确认一下", "The source quote needs checking."],
    [/改|变化|更新中断|找不到/iu, "原记录有变化，核对一下", "The original record changed. Please check."],
    [/交易对象|merchant|counterparty/iu, "交易对象还不清楚，改一下", "Check the counterparty."],
    [/日期|date/iu, "日期还不清楚，改一下", "Check the date."],
    [/写|撤销/iu, "上次操作没完成，核对一下", "The last action needs checking."],
    [/待办|愿望|感想/iu, "是否要做这件事，确认一下", "Check whether this is a to-do."]
  ];
  for (const [pattern, chinese, english] of rules) {
    if (reasons.some(reason => pattern.test(reason))) return zh ? chinese : english;
  }
  return zh ? "这条还需要你确认" : "This needs your review.";
}

export function diaryReviewFinanceTitle(candidate: DiaryFinanceCandidate): string {
  const quoted = candidate.quote.match(/(?:付了?|支付了?|买了?|购买了?)([^了，。；;！？!?\d¥￥\s][^，。；;！？!?\d¥￥]{0,15}?)\s*(?:[¥￥]\s*)?\d/u)?.[1].trim();
  const description = candidate.description?.split(/[，。；;\n]/u)[0].trim().replace(/^(?:支付|购买)了?/u, "");
  return candidate.merchant.trim() || quoted || description || "";
}

export function diaryReviewFinanceAmount(candidate: DiaryFinanceCandidate): string {
  return `${candidate.currency === "CNY" ? "¥" : `${candidate.currency} `}${money(candidate.amountCents)}`;
}
