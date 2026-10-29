import { normalizedText } from "./identity";
import type { DiaryCandidate, DiaryFinanceCandidate, DiaryFinanceSnapshot, DiaryFinanceSnapshotEntry, DiaryTodoSnapshotEntry } from "./types";

export function validDiaryDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const timestamp = Date.parse(`${value}T12:00:00Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
}

export function localDate(timestamp: number): string {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function dayDistance(a: string, b: string): number {
  return Math.abs(Date.parse(`${a}T12:00:00Z`) - Date.parse(`${b}T12:00:00Z`)) / 86400000;
}

export interface CandidateValidation { reasons: string[]; ignore: boolean }
export function validateDiaryCandidate(candidate: DiaryCandidate, content: string, finance: DiaryFinanceSnapshot): CandidateValidation {
  const reasons: string[] = [];
  const quote = typeof candidate.quote === "string" ? candidate.quote.trim() : "";
  if (!quote || !content.includes(quote)) reasons.push("原文引用未通过核对");
  if (candidate.confidence !== "high") reasons.push("把握程度不足");
  if (candidate.ownership !== "self") reasons.push("无法确认属于你本人");
  if (candidate.occurred !== true) reasons.push(candidate.type === "finance" ? "无法确认已经发生" : "无法确认是明确待办");
  if (Array.isArray(candidate.concerns) && candidate.concerns.length) reasons.push(...candidate.concerns.filter(x => typeof x === "string"));
  const position = quote ? content.indexOf(quote) : -1;
  const before = position >= 0 ? content.slice(Math.max(0, position - 100), position).split(/[。！？!?\n]/u).pop() || "" : "";
  const after = position >= 0 ? content.slice(position + quote.length, position + quote.length + 100).split(/[。！？!?\n]/u)[0] : "";
  const context = `${before}${quote}${after}`;
  const other = candidate.ownership === "other" || /(?:别人|朋友|同事|他|她|他们|她们|老板|爸妈|父母|老公|老婆).{0,6}(?:请我|请客|买单|付了|支付了)/u.test(context)
    || /(?:别人请客|朋友请客|同事请客|他请客|她请客|不用我付|没花我的钱)/u.test(context);
  const planned = /(?:打算|计划|准备|考虑|想要|希望|要不要|如果|还没|未买|没买|预计|预算|明天去买|明天买)/u.test(context);
  if (other) reasons.push("这是他人的收支或请客");
  if (candidate.type === "finance") {
    if (!["expense", "income", "refund", "transfer"].includes(candidate.kind)) reasons.push("收支类型无效");
    if (!Number.isSafeInteger(candidate.amountCents) || candidate.amountCents <= 0) reasons.push("金额必须是正整数分");
    if (!validDiaryDate(candidate.date)) reasons.push("收支日期无效");
    if (typeof candidate.currency !== "string" || !/^[A-Z]{3}$/.test(candidate.currency)) reasons.push("币种无效");
    if (candidate.currency !== "CNY") reasons.push("外币收支需核对");
    if (typeof candidate.merchant !== "string" || !candidate.merchant.trim()) reasons.push("交易对象不明确");
    if (!finance.categories.some(category => category.name === candidate.category && (!category.kind || category.kind === candidate.kind))) reasons.push("分类未对应到已启用分类");
    if (planned) reasons.push("原文描述的是计划或未发生消费");
    if (/(?:垫付|代付|帮.{0,8}付|替.{0,8}付|报销|借给|借了|借款|一百多|几十|几百|大约|大概|左右|差不多|多块|多元|不到|至少|美元|美金|欧元|日元|港币|外币|美刀)/u.test(context)) reasons.push("金额、币种或垫付关系需核对");
    const explicitOwnShare = /(?:我|自己|本人|我的).{0,8}(?:付|出|那份|承担|份额|分摊)/u.test(context);
    if (candidate.kind === "transfer" || candidate.kind === "refund" || /(?:转账|退款|退货|退回|收回垫款)/u.test(context)
      || (/(?:AA|aa|平摊|均摊)/u.test(context) && !explicitOwnShare)) reasons.push("转账、退款或分摊需核对");
    // The model must not invent or scale an Arabic amount visible in the quote.
    const amounts = [...quote.matchAll(/(?:¥|￥|人民币\s*)?(\d+(?:\.\d{1,2})?)\s*(?:元|块|人民币|rmb|RMB|[¥￥])/g)].map(match => Math.round(Number(match[1]) * 100));
    if (amounts.length && !amounts.includes(candidate.amountCents)) reasons.push("金额与原文不一致");
  } else {
    if (typeof candidate.text !== "string" || !candidate.text.trim()) reasons.push("待办内容为空");
    if (candidate.dueDate != null && !validDiaryDate(candidate.dueDate)) reasons.push("待办日期无效");
    if (/(?:希望有一天|真希望|要是能|梦想是|感慨|觉得人生)/u.test(quote)) reasons.push("原文可能是愿望或感想");
  }
  return { reasons: [...new Set(reasons)], ignore: other || (candidate.type === "finance" && planned) };
}

export function financeDuplicateCandidates(candidate: DiaryFinanceCandidate, entries: DiaryFinanceSnapshotEntry[]): DiaryFinanceSnapshotEntry[] {
  return entries.filter(entry => entry.status === "completed" && entry.kind === candidate.kind
    && entry.currency === candidate.currency && entry.amountCents === candidate.amountCents
    && validDiaryDate(entry.date.slice(0, 10)) && validDiaryDate(candidate.date) && dayDistance(entry.date.slice(0, 10), candidate.date) <= 2);
}

export function todoDuplicateCandidates(candidate: DiaryCandidate, entries: DiaryTodoSnapshotEntry[]): DiaryTodoSnapshotEntry[] {
  if (candidate.type !== "todo") return [];
  const text = normalizedText(candidate.text);
  return entries.filter(entry => {
    const other = normalizedText(entry.text);
    return text && other && (text === other || (Math.min(text.length, other.length) >= 6 && (text.includes(other) || other.includes(text))));
  });
}

export function parseDiaryJson(text: string): unknown {
  const plain = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  return JSON.parse(plain);
}

export function parseDiaryCandidates(text: string): DiaryCandidate[] {
  const parsed = parseDiaryJson(text);
  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { candidates?: unknown }).candidates)) throw new Error("抽取结果缺少 candidates 数组");
  const candidates = (parsed as { candidates: unknown[] }).candidates;
  if (candidates.length > 100) throw new Error("单篇候选条目超过限制");
  return candidates.map(candidate => {
    if (!candidate || typeof candidate !== "object" || !["todo", "finance"].includes((candidate as DiaryCandidate).type)) throw new Error("抽取结果含无效条目类型");
    return candidate as DiaryCandidate;
  });
}
