import { summarizeDiaryActivity } from "../english-diary/activity";
import type { DiaryGenerationDay, DiaryRepository, ExpressionEntry, SavedDiaryEntry } from "../english-diary/types";

export interface EnglishDiaryPageHost { repository: DiaryRepository }
export interface EnglishDiaryPageData {
  streak: number | null;
  expressionCount: number | null;
  diaryCount: number | null;
  activity: DiaryGenerationDay[];
  diaries: SavedDiaryEntry[];
  expressions: ExpressionEntry[];
  errors: Partial<Record<"activity" | "diaries" | "expressions", string>>;
}

const message = (error: unknown): string => error instanceof Error ? error.message : "暂时读不到，请重试。";

/** Local, independent read regions. A failed or incomplete count stays unknown. */
export async function loadEnglishDiaryPageData(host: EnglishDiaryPageHost, now = new Date()): Promise<EnglishDiaryPageData> {
  const repository = host.repository;
  const [activityResult, diaryResult, expressionResult] = await Promise.allSettled([
    Promise.resolve().then(() => repository.listGenerationActivity({ readOnly: true })),
    Promise.resolve().then(() => {
      if (!repository.listSavedDiaries) throw new Error("英文日记列表暂时读不到，请重试。");
      return repository.listSavedDiaries();
    }),
    Promise.resolve().then(() => repository.listExpressions("", undefined, { readOnly: true }))
  ]);
  const errors: EnglishDiaryPageData["errors"] = {};
  const activity = activityResult.status === "fulfilled" ? activityResult.value : [];
  if (activityResult.status === "rejected") errors.activity = message(activityResult.reason);
  const diaries = diaryResult.status === "fulfilled" ? diaryResult.value.entries : [];
  if (diaryResult.status === "rejected") errors.diaries = message(diaryResult.reason);
  else if (diaryResult.value.errors.length) errors.diaries = diaryResult.value.errors.join("；");
  const expressions = expressionResult.status === "fulfilled" ? expressionResult.value : [];
  if (expressionResult.status === "rejected") errors.expressions = message(expressionResult.reason);
  return {
    streak: errors.activity ? null : summarizeDiaryActivity(activity, now).streak,
    expressionCount: errors.expressions ? null : new Set(expressions.map(entry => entry.id)).size,
    diaryCount: errors.diaries ? null : new Set(diaries.filter(entry => !entry.missingEnglish).map(entry => entry.id)).size,
    activity, diaries, expressions, errors
  };
}
