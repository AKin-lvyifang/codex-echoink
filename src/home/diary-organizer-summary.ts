import type { DiaryItem } from "../diary-organizer/types";

export const DIARY_HOME_RECENT_MS = 7 * 24 * 60 * 60 * 1000;

/** Recent verified writes plus every outstanding review; historical scans do not renew it. */
export function diaryHomeSummary(items: readonly DiaryItem[], now = Date.now()) {
  const visible = items.filter(item => item.status === "review" || item.status === "written"
    && Number.isFinite(item.writtenAt) && item.writtenAt! <= now && item.writtenAt! >= now - DIARY_HOME_RECENT_MS);
  const written = visible.filter(item => item.status === "written");
  return {
    writtenFinance: written.filter(item => item.candidate.type === "finance").length,
    writtenTodos: written.filter(item => item.candidate.type === "todo").length,
    review: visible.filter(item => item.status === "review").length,
    items: visible,
    nextRefreshAt: written.length ? Math.min(...written.map(item => item.writtenAt! + DIARY_HOME_RECENT_MS + 1)) : undefined
  };
}
