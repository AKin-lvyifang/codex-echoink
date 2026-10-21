import type { AccountStatistics } from "../../settings/account-membership-model";
import { USAGE_TOKEN_STANDARD } from "./token-estimator";
import type { UsageRequestEvent } from "./usage-stream";

export interface UsageDocument {
  schemaVersion: 1;
  standard: typeof USAGE_TOKEN_STANDARD;
  startedAt: number;
  requests: UsageRequestEvent[];
  completedTurns: { runId: string; recordedAt: number }[];
}

export function usageStatistics(document: UsageDocument | null, now: number): AccountStatistics {
  if (!document) return { totalTokens: null, totalTurns: null, currentStreak: null, bestStreak: null, coverage: null, days: [], rankings: {}, assets: {} };
    const days = new Map<string, { date: string; tokens: number; turns: number; input: number; output: number }>();
    const day = (time: number) => {
      const date = localDate(time);
      let item = days.get(date);
      if (!item) { item = { date, tokens: 0, turns: 0, input: 0, output: 0 }; days.set(date, item); }
      return item;
    };
    let totalTokens = 0;
    for (const request of document.requests) {
      const item = day(request.recordedAt);
      item.input += request.inputTokens;
      item.output += request.outputTokens;
      item.tokens += request.inputTokens + request.outputTokens;
      totalTokens += request.inputTokens + request.outputTokens;
    }
    for (const turn of document.completedTurns) day(turn.recordedAt).turns += 1;
    const activeDates = [...days.values()].filter(item => item.turns > 0).map(item => item.date).sort();
    const activeOrdinals = activeDates.map(date => Math.floor(Date.parse(`${date}T12:00:00Z`) / 86_400_000));
    let bestStreak = 0;
    let streak = 0;
    for (let index = 0; index < activeOrdinals.length; index += 1) {
      streak = index > 0 && activeOrdinals[index] === activeOrdinals[index - 1] + 1 ? streak + 1 : 1;
      bestStreak = Math.max(bestStreak, streak);
    }
    const today = Math.floor(Date.parse(`${localDate(now)}T12:00:00Z`) / 86_400_000);
    const last = activeOrdinals.at(-1);
    const currentStreak = last !== undefined && (last === today || last === today - 1) ? streak : 0;
    const rankings: AccountStatistics["rankings"] = Object.fromEntries(([30, 90, "all"] as const).map(range => {
      const start = range === "all" ? -Infinity : today - range + 1;
      const counts = new Map<string, number>();
      for (const request of document.requests) {
        const ordinal = Math.floor(Date.parse(`${localDate(request.recordedAt)}T12:00:00Z`) / 86_400_000);
        if (ordinal < start || ordinal > today) continue;
        const name = `${request.provider} / ${request.model}`;
        counts.set(name, (counts.get(name) ?? 0) + 1);
      }
      return [range, { models: [...counts].map(([name, count]) => ({ name, count }))
        .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name)), skills: [] }];
    }));
    return { totalTokens, totalTurns: document.completedTurns.length, currentStreak, bestStreak,
      coverage: `${localDate(document.startedAt)} 起记录 · Token 估算`,
      days: [...days.values()].sort((left, right) => left.date.localeCompare(right.date)), rankings, assets: {} };
}

function localDate(time: number): string {
  const date = new Date(time);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
function text(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 512; }
function integer(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 0; }
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
export function parseRequest(value: unknown): UsageRequestEvent {
  if (!record(value) || !text(value.requestId) || !text(value.provider) || !text(value.model)
    || !integer(value.recordedAt) || !integer(value.inputTokens) || !integer(value.outputTokens)
    || !["conversation", "background", "connection-test"].includes(String(value.source))
    || !["completed", "failed", "cancelled"].includes(String(value.status))
    || value.standard !== USAGE_TOKEN_STANDARD) throw new Error("Invalid usage evidence");
  return { requestId: value.requestId, recordedAt: value.recordedAt, provider: value.provider, model: value.model,
    inputTokens: value.inputTokens, outputTokens: value.outputTokens,
    source: value.source as UsageRequestEvent["source"], status: value.status as UsageRequestEvent["status"], standard: USAGE_TOKEN_STANDARD };
}
export function parseDocument(value: unknown): UsageDocument {
  if (!record(value) || value.schemaVersion !== 1 || value.standard !== USAGE_TOKEN_STANDARD
    || !integer(value.startedAt) || !Array.isArray(value.requests) || !Array.isArray(value.completedTurns)) {
    throw new Error("Invalid usage store; existing evidence was preserved");
  }
  const requests = value.requests.map(parseRequest);
  const completedTurns = value.completedTurns.map(turn => {
    if (!record(turn) || !text(turn.runId) || !integer(turn.recordedAt)) throw new Error("Invalid completed turn evidence");
    return { runId: turn.runId, recordedAt: turn.recordedAt };
  });
  if (new Set(requests.map(request => request.requestId)).size !== requests.length
    || new Set(completedTurns.map(turn => turn.runId)).size !== completedTurns.length) throw new Error("Duplicate usage evidence");
  return { schemaVersion: 1, standard: USAGE_TOKEN_STANDARD, startedAt: value.startedAt, requests, completedTurns };
}
