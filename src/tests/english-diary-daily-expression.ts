import * as assert from "node:assert/strict";
import { dailyExpression, localDiaryDay } from "../english-diary/daily-expression";
import type { ExpressionEntry, ExpressionOccurrence } from "../english-diary/types";

export function dailyExpressionFixture(id: string, dates = ["2026-10-01"]): ExpressionEntry {
  return { schema: 1, id, path: `Expressions/${id}.md`, term: `expression ${id}`, type: "phrase", meaning: "表达", category: "其他", userCategory: false, note: "",
    occurrences: dates.map((date, index) => ({ id: `${id}-${index}`, journalId: `${id}-${index}`, sourcePath: "journal/day.md", englishPath: "English/day.md",
      sourceTitle: "Day", date, sourceFingerprint: "hash", scene: "", example: "", reason: "", usage: "", sourceExcerpt: "原文", targetExcerpt: `Latest ${date}`, status: "verified" })) };
}

export function runDailyExpressionTests(): void {
  assert.equal(dailyExpression([]), null);
  const invalid = dailyExpressionFixture("invalid");
  invalid.occurrences[0].status = "needs-review";
  assert.equal(dailyExpression([invalid]), null);
  invalid.occurrences[0].status = "verified";
  invalid.occurrences[0].date = "2026-02-30";
  assert.equal(dailyExpression([invalid]), null);
  const a = dailyExpressionFixture("a", ["2026-10-01", "2026-10-16"]), b = dailyExpressionFixture("b"), c = dailyExpressionFixture("c", ["2026-10-02"]);
  a.occurrences.push({ ...a.occurrences[0], date: "2026-10-17", targetExcerpt: "unverified", status: "needs-review" } as ExpressionOccurrence);
  const day = new Date(2026, 9, 16, 1), same = new Date(2026, 9, 16, 23);
  const first = dailyExpression([c, b, a], day)!;
  assert.equal(first.entry.id, dailyExpression([b, a, c], same)?.entry.id, "same local day and content give stable selection independently of list order");
  assert.equal(dailyExpression([a], day)?.occurrence.targetExcerpt, "Latest 2026-10-16", "use the latest valid excerpt");
  assert.equal(new Set([0, 1, 2].map((offset) => dailyExpression([a, b, c], new Date(2026, 9, 16 + offset))?.entry.id)).size, 3, "visit every candidate once before repeating");
  assert.equal(localDiaryDay(new Date(2026, 2, 9)) - localDiaryDay(new Date(2026, 2, 8)), 1, "calendar-day rotation survives DST");
  assert.equal(localDiaryDay(new Date(2026, 10, 2)) - localDiaryDay(new Date(2026, 10, 1)), 1);
}
