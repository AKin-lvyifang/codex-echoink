import type { DecisionClient } from "../membership/decision-client";

/* 智能判断设置的显示规则：桌面和手机共用；这里不引用任何界面组件，手机包可以放心引用。 */

const LOW_REMAINING = 30;

/** "2026-12-01T00:00:00+08:00" → "12 月 1 日" / "Dec 1"; uses the date as written (Beijing time). */
export function decisionResetDate(resetAt: string, en: boolean): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/u.exec(resetAt);
  if (!match) return en ? "next month" : "下月";
  const month = Number(match[2]), day = Number(match[3]);
  return en ? `${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][month - 1]} ${day}` : `${month} 月 ${day} 日`;
}

export interface SmartJudgmentView {
  /** 灰度外或服务器关着：整组不出现。 */
  hidden: boolean;
  /** 基础版：开关置灰 + 升级。 */
  free: boolean;
  on: boolean;
  status: string;
  warning: boolean;
  /** 内测显示次数；付费档只有碰到上限才显示这一行。percent 为 null 时不画进度条。 */
  usage: { text: string; percent: number | null; warning: boolean } | null;
}

/** 桌面和手机共用的显示规则。 */
export function smartJudgmentView(client: DecisionClient, zh: boolean): SmartJudgmentView {
  const t = (cn: string, en: string) => zh ? cn : en;
  const view = client.status(), resetAt = client.exhausted();
  const quota = view?.quota ?? null, beta = quota?.showCount === true;
  const hidden = !!view && !view.available && view.reason !== "NOT_ENTITLED";
  const free = !!view && !view.available && view.reason === "NOT_ENTITLED";
  const on = !free && client.enabled();
  const date = decisionResetDate(resetAt ?? quota?.resetAt ?? "", !zh);
  const remaining = quota ? Math.max(0, quota.remaining) : null;
  const low = beta && remaining !== null && remaining <= LOW_REMAINING;
  const status = free ? t("PRO 功能", "PRO feature") : !view ? "" : !on ? t("已关闭", "Off")
    : resetAt ? (beta ? t(`本月已用完 · ${date}恢复`, `Used up · resumes ${date}`) : t(`本月已达上限 · ${date}恢复`, `Limit reached · resumes ${date}`))
    : beta && remaining !== null ? t(`本月剩 ${remaining} 次`, `${remaining} left this month`) : t("已开启", "On");
  const usage = !free && on && quota && (beta || resetAt) ? {
    text: beta ? t(`${quota.used.toLocaleString()} / ${quota.limit.toLocaleString()} · ${date}重置`, `${quota.used.toLocaleString()} / ${quota.limit.toLocaleString()} · resets ${date}`)
      : t(`已达 ${quota.limit.toLocaleString()} 次上限 · ${date}恢复`, `Reached the ${quota.limit.toLocaleString()} limit · resumes ${date}`),
    percent: beta ? quota.limit > 0 ? Math.min(100, Math.round(quota.used / quota.limit * 100)) : 0 : null,
    warning: low || !!resetAt
  } : null;
  return { hidden, free, on, status, warning: !free && on && (!!resetAt || low), usage };
}

export const SMART_JUDGMENT_HELP = {
  zh: "开启后，EchoInk 召回和查阅笔记、记忆、技能，记账分类等都会更准，需要 PRO。",
  en: "When on, EchoInk recalls and looks up notes, memories and skills, and categorizes bills more accurately. Requires PRO."
} as const;
