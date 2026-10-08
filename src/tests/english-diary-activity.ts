import assert from "node:assert/strict";
import { summarizeDiaryActivity } from "../english-diary/activity";
import type { DiaryGenerationDay } from "../english-diary/types";

export function runEnglishDiaryActivityTests(): void {
  const records = (...dates: string[]): DiaryGenerationDay[] => dates.map((date) => ({ date, expressionCount: 1, generationCount: 1 }));
  const localDay = (date: string) => new Date(`${date}T12:00:00`);
  assert.deepEqual(summarizeDiaryActivity([], localDay("2026-10-08")), { streak: 0, days: 0 });
  assert.deepEqual(summarizeDiaryActivity(records("2025-12-30", "2025-12-31", "2026-01-01", "2026-01-02"), localDay("2026-01-02")), { streak: 4, days: 4 }, "streak crosses a year boundary");
  assert.deepEqual(summarizeDiaryActivity(records("2024-02-28", "2024-02-29", "2024-03-01"), localDay("2024-03-01")), { streak: 3, days: 3 }, "leap day stays consecutive");
  assert.deepEqual(summarizeDiaryActivity(records("2026-01-29", "2026-01-30", "2026-01-31"), localDay("2026-02-01")), { streak: 3, days: 3 }, "today remains open when yesterday has a record");
  assert.deepEqual(summarizeDiaryActivity(records("2026-03-01"), localDay("2026-03-03")), { streak: 0, days: 1 }, "a missing yesterday ends the streak");
  assert.deepEqual(summarizeDiaryActivity(records("2026-03-01", "2026-03-03", "2026-03-04"), localDay("2026-03-04")), { streak: 2, days: 3 }, "streak stops at the gap but keeps historical days");
  assert.deepEqual(summarizeDiaryActivity(records("2020-01-01", "2026-03-04", "2026-03-05", "2027-01-01"), localDay("2026-03-04")), { streak: 1, days: 2 }, "history is not limited to the heatmap window; future days are excluded");
  assert.deepEqual(summarizeDiaryActivity(records("2026-03-06", "2026-03-07", "2026-03-08", "2026-03-09"), localDay("2026-03-09")), { streak: 4, days: 4 }, "calendar days stay consecutive through spring DST");
  assert.deepEqual(summarizeDiaryActivity(records("2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02"), localDay("2026-11-02")), { streak: 4, days: 4 }, "calendar days stay consecutive through fall DST");
  const activity: DiaryGenerationDay[] = [
    { date: "2026-10-06", expressionCount: 0, generationCount: 1 },
    { date: "2026-10-06", expressionCount: 4, generationCount: 2 },
    { date: "2026-10-05", expressionCount: 12, generationCount: 0 }
  ];
  const before = JSON.stringify(activity);
  assert.deepEqual(summarizeDiaryActivity(activity, localDay("2026-10-06")), { streak: 1, days: 1 }, "successful zero-expression days count; duplicate days and unsuccessful rows do not inflate totals");
  assert.equal(JSON.stringify(activity), before, "summary does not modify stored activity");
}
