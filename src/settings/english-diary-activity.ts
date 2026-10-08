import type { App } from "obsidian";
import type { DiaryRepository } from "../english-diary/types";
import { renderDiaryProgress } from "../english-diary/activity";
import { renderActivityHeatmap } from "./activity-heatmap";
import { createOriginButton, disposeOriginControls } from "./origin-controls";

/** Diary activity uses the same year/month calendar as the other settings pages. */
export async function renderEnglishDiaryActivity(
  container: HTMLElement,
  repository: Pick<DiaryRepository, "listGenerationActivity" | "listExpressions"> | undefined,
  app?: Pick<App, "keymap" | "scope">
): Promise<void> {
  disposeOriginControls(container);
  container.empty();
  container.addClass("echoink-diary-activity");
  const loading = container.createEl("p", { cls: "settings-note", text: "正在读取日记足迹…", attr: { role: "status" } });
  try {
    if (!repository) throw new Error("英文日记尚未就绪。");
    const [activity, expressions] = await Promise.all([repository.listGenerationActivity(), repository.listExpressions()]);
    if (!container.contains(loading)) return;
    container.empty();
    renderDiaryProgress(container, activity, expressions.length);
    const byDate = new Map(activity.map((day) => [day.date, day]));
    const heading = container.createDiv({ cls: "echoink-diary-activity-heading" });
    renderActivityHeatmap(container, heading, container, {
      days: activity.map(day => ({ date: day.date, count: day.expressionCount })), thresholds: [6, 11], zh: true, stateKey: "diaryActivity", app,
      title: "每日生成的表达数",
      label: (date, count) => `${date} · ${count} 个表达 · 生成 ${byDate.get(date)?.generationCount ?? 0} 次`,
      summary: days => `生成 ${days.reduce((sum, day) => sum + (day.count ?? 0), 0)} 个表达 · 打卡 ${days.filter(day => (byDate.get(day.date)?.generationCount ?? 0) > 0).length} 天`
    });
  } catch {
    if (!container.contains(loading)) return;
    container.empty();
    container.createEl("p", { cls: "settings-note", text: "暂时无法读取日记足迹，请重试。", attr: { role: "status" } });
    const retry = createOriginButton(container, { text: "重试", attr: { type: "button" } });
    retry.onclick = () => { void renderEnglishDiaryActivity(container, repository, app); };
  }
}
