import type { ReviewRangeMode, ReviewReportKind, WeeklyReviewSettings } from "../settings/settings";
import { DEFAULT_REVIEW_OUTPUT_DIR, normalizeReviewOutputDir } from "../settings/settings";

export interface ReviewRange {
  startAt: number;
  endAt: number;
  startDate: string;
  endDate: string;
}

export function currentReviewRange(now = new Date()): ReviewRange {
  const start = startOfLocalWeek(now);
  return {
    startAt: start.getTime(),
    endAt: now.getTime(),
    startDate: formatLocalDate(start),
    endDate: formatLocalDate(now)
  };
}

export function reviewRangeForMode(mode: ReviewRangeMode, now = new Date()): ReviewRange {
  if (mode === "current-week") return currentReviewRange(now);
  const currentStart = startOfLocalWeek(now);
  const previousEnd = new Date(currentStart);
  previousEnd.setMilliseconds(-1);
  previousEnd.setHours(23, 59, 59, 999);
  const previousStart = startOfLocalWeek(previousEnd);
  return {
    startAt: previousStart.getTime(),
    endAt: previousEnd.getTime(),
    startDate: formatLocalDate(previousStart),
    endDate: formatLocalDate(previousEnd)
  };
}

export function latestScheduledReviewRange(now = new Date(), scheduleTime = "21:00"): ReviewRange | null {
  const [hour, minute] = parseScheduleTime(scheduleTime);
  const scheduled = new Date(now);
  scheduled.setHours(hour, minute, 0, 0);
  scheduled.setDate(scheduled.getDate() - scheduled.getDay());
  if (scheduled.getTime() > now.getTime()) scheduled.setDate(scheduled.getDate() - 7);
  const start = new Date(scheduled);
  start.setDate(scheduled.getDate() - 6);
  start.setHours(0, 0, 0, 0);
  return {
    startAt: start.getTime(),
    endAt: scheduled.getTime(),
    startDate: formatLocalDate(start),
    endDate: formatLocalDate(scheduled)
  };
}

export function shouldRunScheduledReview(settings: WeeklyReviewSettings, kind: ReviewReportKind, now = new Date()): boolean {
  if (!settings.enabled) return false;
  if (kind === "knowledge-base" && !settings.knowledgeBaseEnabled) return false;
  if (kind === "agent-chat" && !settings.agentChatEnabled) return false;
  const range = latestScheduledReviewRange(now, settings.scheduleTime);
  if (!range) return false;
  const state = kind === "knowledge-base" ? settings.reports.knowledgeBase : settings.reports.agentChat;
  return state.lastRangeKey !== reviewRangeKey(range);
}

export function reviewRangeKey(range: Pick<ReviewRange, "startDate" | "endDate">): string {
  return `${range.startDate}-to-${range.endDate}`;
}

export function isReviewHtmlPath(value: string, outputDir = DEFAULT_REVIEW_OUTPUT_DIR): boolean {
  const normalized = value.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized.endsWith(".html")) return false;
  if (normalized.split("/").some((part) => part === ".." || part === "." || !part)) return false;
  const allowedDirs = Array.from(new Set([
    normalizeReviewOutputDir(outputDir, DEFAULT_REVIEW_OUTPUT_DIR),
    DEFAULT_REVIEW_OUTPUT_DIR
  ]));
  return allowedDirs.some((dir) => normalized.startsWith(`${dir}/`));
}

function startOfLocalWeek(date: Date): Date {
  const start = new Date(date);
  const day = start.getDay();
  const daysFromMonday = day === 0 ? 6 : day - 1;
  start.setDate(start.getDate() - daysFromMonday);
  start.setHours(0, 0, 0, 0);
  return start;
}

function parseScheduleTime(value: string): [number, number] {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value.trim());
  if (!match) return [21, 0];
  return [Number(match[1]), Number(match[2])];
}

function formatLocalDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
