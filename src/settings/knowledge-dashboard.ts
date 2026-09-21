import { setIcon } from "obsidian";
import {
  knowledgeDashboardHealthReasonText,
  knowledgeRunStatusLabel,
  type KnowledgeDashboardActions,
  type KnowledgeDashboardRenderState
} from "../ui/codex-view/knowledge-dashboard";

/** Settings-only presentation of the same evidence used by Home and chat. */
export function renderSettingsKnowledgeDashboard(
  container: HTMLElement,
  state: KnowledgeDashboardRenderState,
  actions: KnowledgeDashboardActions & { onOpenHistory: () => void; onOpenRaw: () => void }
): void {
  const zh = state.language !== "en";
  const t = (cn: string, en: string) => zh ? cn : en;
  const time = (at: number) => at ? new Date(at).toLocaleString(zh ? "zh-CN" : "en-US", {
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit"
  }) : t("暂无记录", "No record");
  container.empty();
  container.addClass("settings-knowledge-dashboard", "dashboard-section");
  container.setAttr("aria-busy", String(state.loading));
  const heading = container.createDiv({ cls: "section-heading" });
  const headingCopy = heading.createDiv();
  headingCopy.createEl("h3", { text: t("知识库 Dashboard", "Knowledge Dashboard") });
  headingCopy.createEl("p", { cls: "settings-note", text: t("查看结构、资料状态与已确认的体检记录。", "Review structure, source status, and verified check history.") });
  const controls = heading.createDiv({ cls: "dashboard-actions" });
  if (state.snapshot) controls.createSpan({ cls: "snapshot-time", text: time(state.snapshot.generatedAt) });
  const refresh = button(controls, t("刷新状态", "Refresh status"), state.loading ? "loader-circle" : "refresh-cw", actions.onRefresh, true);
  refresh.disabled = state.loading;
  const toggle = button(controls, state.expanded ? t("收起详情", "Collapse details") : t("展开详情", "Expand details"), state.expanded ? "chevron-up" : "chevron-down", actions.onToggleExpanded, true);
  toggle.setAttr("aria-expanded", String(state.expanded));
  if (state.error || state.recovery.state !== "ready") {
    container.createDiv({ cls: "echoink-settings-state is-error", text: state.error || state.recovery.message, attr: { role: "alert" } });
  }
  const snapshot = state.snapshot;
  if (!snapshot) {
    container.createDiv({ cls: "settings-empty", text: state.loading ? t("正在读取知识库状态…", "Reading knowledge status…") : t("暂无可用快照", "No snapshot available"), attr: { role: "status" } });
    return;
  }
  const { health, checkFreshness: freshness } = snapshot;
  const available = health.assessment === "local-structure" || health.assessment === "limited";
  const healthLabel = zh ? health.label : health.assessment === "uninitialized" ? "Not initialized" : !available ? "Unavailable" : health.status === "healthy" ? "Healthy" : health.status === "risk" ? "At risk" : "Unhealthy";
  if (!state.expanded) {
    const summary = container.createDiv({ cls: "collapsed-summary" });
    summary.createSpan({ text: `${healthLabel} · ${available ? health.score : "—"}` });
    summary.createSpan({ text: `Wiki ${snapshot.wiki.fileCount} · Raw ${snapshot.raw.fileCount} · Inbox ${snapshot.inbox.fileCount}` });
    return;
  }
  const overview = container.createDiv({ cls: "health-overview" });
  const healthCard = overview.createDiv({ cls: `health-card is-${health.status}` });
  const label = healthCard.createDiv({ cls: "card-label" });
  label.createEl("h3", { text: t("结构健康度", "Structural health") });
  const healthBadge = label.createSpan({ cls: `status ${health.status === "healthy" ? "healthy" : "neutral"}` });
  healthBadge.createEl("b"); healthBadge.createSpan({ text: healthLabel });
  const score = healthCard.createDiv({ cls: "health-score" });
  score.createEl("strong", { text: available ? String(health.score) : "—" });
  if (available) score.createSpan({ text: "/ 100" });
  const explanation = container.createDiv({ cls: "health-explanation" });
  explanation.hidden = true;
  const explanationHeader = explanation.createDiv({ cls: "panel-heading" });
  explanationHeader.createEl("h3", { text: t("评分说明与检查范围", "Score and coverage") });
  const detailsButton = button(score, t("评分说明", "Score details"), "info", () => {
    explanation.hidden = !explanation.hidden;
    detailsButton.setAttr("aria-expanded", String(!explanation.hidden));
  });
  detailsButton.setAttr("aria-expanded", "false");
  button(explanationHeader, t("关闭", "Close"), "x", () => {
    explanation.hidden = true;
    detailsButton.setAttr("aria-expanded", "false");
    detailsButton.focus();
  });
  if (available) {
    const meter = healthCard.createDiv({ cls: "health-meter", attr: { role: "meter", "aria-label": t("结构健康度", "Structural health"), "aria-valuenow": String(health.score), "aria-valuemin": "0", "aria-valuemax": "100" } });
    meter.createSpan().style.width = `${health.score}%`;
  }
  healthCard.createEl("p", { text: !available
    ? health.assessment === "uninitialized" ? t("初始化完成后显示本地结构评分。", "Initialize the knowledge base to see its structural score.") : t("必要文件读取或扫描失败，暂时无法评估。", "Required reads or scans failed; assessment is unavailable.")
    : t("基于已检查的本地结构与来源状态。", "Based on inspected local structure and source status.") });
  const check = overview.createDiv({ cls: "check-card" });
  const checkLabel = check.createDiv({ cls: "card-label" });
  checkLabel.createEl("h3", { text: t("体检新鲜度", "Check freshness") });
  checkLabel.createSpan({ cls: "status neutral", text: freshness.lastCheckAt ? t("已有记录", "Recorded") : t("待确认", "Unconfirmed") });
  const checkTitle = check.createDiv({ cls: "check-empty-title" });
  setIcon(checkTitle.createSpan(), "calendar-days");
  checkTitle.createEl("strong", { text: freshness.lastCheckAt
    ? t(`${freshness.daysSinceCheck} 天前确认`, `Confirmed ${freshness.daysSinceCheck} days ago`)
    : t("暂无体检记录", "No verified check yet") });
  check.createEl("p", { text: freshness.lastCheckAt
    ? t("仅以成功的体检记录计算，失败和普通维护不会刷新确认时间。", "Only successful checks refresh this time. Failed checks and ordinary maintenance do not.")
    : t("这代表缺少确认，不代表知识库已经损坏。", "This means confirmation is missing, not that the knowledge base is damaged.") });
  const checkNote = check.createDiv({ cls: "check-note" });
  setIcon(checkNote.createSpan(), "circle-help");
  checkNote.createSpan({ text: t("维护成功不等于完成全库体检。", "Successful maintenance is not a full knowledge-base check.") });
  for (const reason of health.scoreReasons) {
    const row = explanation.createDiv({ cls: "score-reason" });
    row.createSpan({ text: knowledgeDashboardHealthReasonText(reason, state.language) });
    row.createEl("strong", { text: `−${reason.penalty}` });
  }
  if (available && !health.scoreReasons.length) explanation.createEl("p", { text: t("已检查的范围内没有扣分项。", "No deductions in the inspected scope.") });
  explanation.createEl("p", { text: t(health.coverage, health.assessment === "limited" ? "Coverage is limited: each folder is capped at 3,000 files; some source content remains unread within the reading budget." : "Checks cover raw, wiki, wiki/index.md, Tracker, and Raw source status only.") });
  explanation.createEl("p", { text: t("尚未检查：断链、孤儿页面、过时内容和索引链接有效性。", "Not checked: broken links, orphan pages, stale content, and index-link validity.") });
  explanation.createDiv({ cls: "score-thresholds", text: t(health.scoreThresholdText, "85+ healthy; 60–84 at risk; below 60 unhealthy. Missing raw, wiki, wiki/index.md, or Tracker deducts 24 points each and overrides the score to unhealthy.") });
  explanation.createEl("small", { text: t(health.scoreCheckNote, "Score = max(0, min(100, 100 − deductions)). Queues and failed maintenance do not deduct structural points.") });
  const facts = container.createEl("dl", { cls: "status-facts" });
  const runStatus = knowledgeRunStatusLabel(snapshot.lastRun.status, snapshot.lastRun.at, snapshot.lastRun.completion, snapshot.lastRun.pendingSourceCount, state.language);
  for (const [name, value] of [
    [t("最近成功体检", "Last successful check"), time(freshness.lastCheckAt)],
    [t("连续体检", "Check streak"), t(`${health.streakDays} 天`, `${health.streakDays} days`)],
    [t("最近维护", "Latest maintenance"), snapshot.lastRun.at ? runStatus : t("暂无记录", "No record")],
    ["Tracker", snapshot.tracker.exists ? t(`已追踪 ${snapshot.tracker.trackedCount} 项`, `${snapshot.tracker.trackedCount} tracked`) : t("缺失", "Missing")]
  ]) { const fact = facts.createDiv(); fact.createEl("dt", { text: name }); fact.createEl("dd", { text: value }); }
  const panels = container.createDiv({ cls: "content-status" });
  const wiki = table(panels, t("Wiki 结构", "Wiki structure"), snapshot.wiki.fileCount, [t("分类", "Category"), t("数量", "Count"), t("占比", "Share"), t("今日新增", "Added today")]);
  for (const group of snapshot.wiki.groups) {
    const names: Record<string, string> = { 概念: "Concepts", 实体: "Entities", 主题: "Topics", 来源: "Sources", 其他: "Other" };
    const row = cells(wiki, [zh ? group.label : names[group.label] ?? group.label, String(group.totalCount), "", group.todayCount ? `+${group.todayCount}` : "—"]);
    const share = (row.children[2] as HTMLElement).createDiv({ cls: "wiki-share" });
    share.createSpan({ text: `${group.sharePercent}%` });
    share.createDiv({ cls: "wiki-share-track", attr: { "aria-hidden": "true" } })
      .createSpan().style.width = `${Math.max(0, Math.min(100, group.sharePercent))}%`;
  }
  wiki.closest(".data-panel")?.createEl("p", { cls: "table-note", text: t("占比以 Wiki 一级分类目录内的文件为分母；入口页等根目录文件只计入总数。", "Shares use files inside first-level Wiki category folders. Root-level files such as index.md count toward the total only.") });
  const queues = table(panels, t("Raw / Inbox 状态", "Raw / Inbox status"), snapshot.raw.fileCount + snapshot.inbox.fileCount, [t("区域", "Area"), t("总数", "Total"), t("今日新增", "Added today"), t("待处理", "Pending"), t("待校准", "Calibration")]);
  const raw = cells(queues, ["Raw", String(snapshot.raw.fileCount), String(snapshot.raw.todayCount), "", ""]);
  for (const [index, count] of [[3, snapshot.raw.digestStatus.pending + snapshot.raw.digestStatus.changed], [4, snapshot.raw.digestStatus.calibration]]) {
    const open = (raw.children[index] as HTMLElement).createEl("button", { cls: "queue-count", text: String(count), attr: {
      type: "button", title: t("在文件列表中打开 Raw 目录", "Open the Raw folder in the file explorer"),
      "aria-label": t(`${index === 3 ? "待处理" : "待校准"} ${count} 项，打开 Raw 目录`, `${count} ${index === 3 ? "pending" : "needing calibration"}; open the Raw folder`)
    } });
    open.onclick = actions.onOpenRaw;
  }
  cells(queues, ["Inbox", String(snapshot.inbox.fileCount), String(snapshot.inbox.todayCount), String(snapshot.inbox.fileCount), "—"]);
  queues.closest(".data-panel")?.createEl("p", { cls: "table-note", text: t("今日新增依据文件属性统计；待处理数量用于整理提示，不扣结构分。", "Added today uses file metadata. Pending counts are organization suggestions and do not reduce structural health.") });
  const history = container.createEl("section", { cls: "history-panel" });
  const historyHeading = history.createDiv({ cls: "panel-heading" });
  const historyTitle = historyHeading.createEl("h3");
  setIcon(historyTitle.createSpan(), "calendar-days"); historyTitle.createSpan({ text: t("全年体检记录", "Checks throughout the year") });
  const year = new Date(snapshot.generatedAt).getFullYear();
  historyHeading.createSpan({ cls: "history-period", text: t(`${year} 年 · ${snapshot.checkHeatmap.filter((day) => day.status !== "none").length} 天有体检记录`, `${year} · ${snapshot.checkHeatmap.filter((day) => day.status !== "none").length} days with checks`) });
  const historyBody = history.createDiv();
  const collapse = button(historyHeading, t("收起", "Collapse"), "chevron-up", () => {
    historyBody.hidden = !historyBody.hidden;
    collapse.setAttr("aria-expanded", String(!historyBody.hidden));
    collapse.setAttr("aria-label", historyBody.hidden ? t("展开", "Expand") : t("收起", "Collapse"));
    collapse.lastElementChild?.setText(historyBody.hidden ? t("展开", "Expand") : t("收起", "Collapse"));
    setIcon(collapse.firstElementChild as HTMLElement, historyBody.hidden ? "chevron-down" : "chevron-up");
  });
  collapse.setAttr("aria-expanded", "true");
  const first = new Date(year, 0, 1, 12);
  const grid = historyBody.createDiv({ cls: "heatmap-scroll" }).createDiv({ cls: "heatmap" });
  const week = (date: Date) => Math.floor((Math.round((date.getTime() - first.getTime()) / 86400000) + first.getDay()) / 7);
  for (let month = 0; month < 12; month++) {
    const date = new Date(year, month, 1, 12);
    const label = grid.createSpan({ cls: "heatmap-month", text: date.toLocaleString(zh ? "zh-CN" : "en-US", { month: "short" }) });
    label.style.gridColumn = String(week(date) + 2);
  }
  for (const [weekday, cn, en] of [[1, "一", "Mon"], [3, "三", "Wed"], [5, "五", "Fri"]] as const) {
    const label = grid.createSpan({ cls: "heatmap-weekday", text: t(cn, en) });
    label.style.gridRow = String(weekday + 2);
  }
  for (const day of snapshot.checkHeatmap) {
    const date = new Date(`${day.date}T12:00:00`);
    const label = `${day.date} · ${day.status === "success" ? t("成功", "Successful") : day.status === "failed" ? t("失败", "Failed") : t("无记录", "No record")}`;
    const cell = grid.createSpan({ cls: `heatmap-cell is-${day.status}`, attr: { title: label, "aria-label": label } });
    cell.style.gridColumn = String(week(date) + 2); cell.style.gridRow = String(date.getDay() + 2);
  }
  const footer = historyBody.createDiv({ cls: "heatmap-footer" });
  footer.createSpan({ text: t("已完成的体检会显示在对应日期。", "Completed checks appear on their dates.") });
  const legend = footer.createDiv({ cls: "heatmap-legend" });
  for (const [cls, text] of [["", t("无记录", "No record")], ["success", t("成功", "Successful")], ["failure", t("失败", "Failed")]]) { const item = legend.createSpan(); item.createEl("b", { cls }); item.createSpan({ text }); }
  button(footer, t("查看维护日志", "Maintenance history"), "arrow-up-right", actions.onOpenHistory);
}

function button(container: HTMLElement, label: string, icon: string, onClick: () => void, iconOnly = false): HTMLButtonElement {
  const el = container.createEl("button", { cls: iconOnly ? "icon-button text-button" : "text-button", attr: { type: "button", "aria-label": label, title: label } });
  setIcon(el.createSpan(), icon); if (!iconOnly) el.createSpan({ text: label }); el.onclick = onClick;
  return el;
}

function table(container: HTMLElement, title: string, total: number, columns: string[]): HTMLTableSectionElement {
  const panel = container.createDiv({ cls: "data-panel" });
  const heading = panel.createDiv({ cls: "panel-heading" });
  const name = heading.createEl("h3"); setIcon(name.createSpan(), title.startsWith("Wiki") ? "book-open" : "inbox"); name.createSpan({ text: title });
  heading.createSpan({ cls: "panel-total", text: String(total) });
  const table = panel.createDiv({ cls: "table-wrap" }).createEl("table");
  const head = table.createEl("thead").createEl("tr");
  for (const label of columns) head.createEl("th", { text: label, attr: { scope: "col" } });
  return table.createEl("tbody");
}

function cells(body: HTMLTableSectionElement, values: string[]): HTMLTableRowElement {
  const row = body.createEl("tr");
  values.forEach((value, index) => row.createEl(index ? "td" : "th", { text: value, attr: index ? undefined : { scope: "row" } }));
  return row;
}
