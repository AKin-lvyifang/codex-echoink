import { attachNativeTooltip } from "../native-tooltip";
import type { MobileJournalSnapshot } from "../../mobile/module-contracts";
import { dateKey, BUILT_IN_JOURNAL_TEMPLATES, homeContributionLevel, decodeImportedMarkdown } from "../../home/home-workbench-model";
import { journalMonthSelection, journalPageEntries } from "../../home/journal-stats";
import { renderPhotoCalendar } from "../../home/photo-calendar";
import { formatMobileDiaryHeading } from "../../mobile/date-display";
import type { HomeJournalTemplateChoice } from "../../home/home-workbench-data";
import type { MobileShellPage } from "../mobile/shell-types";
import type { IPadPageContext } from "./workbench-contract";
import { ipadIcon } from "./workbench-elements";
import { el, moduleActions, moduleButton, moduleConfirm, moduleEmpty, moduleNavigationRow, moduleSettingsGroup, moduleSegments, selectModuleSegment, moduleView, moduleText as t } from "./module-elements";

export function createJournalPage(ctx: IPadPageContext): MobileShellPage {
  const api = ctx.host.services.modules.journal, v = moduleView(ctx, "module:journal", t(ctx, "日记", "Journal"), "journal");
  let snapshot: MobileJournalSnapshot | undefined, month = new Date(new Date().getFullYear(), new Date().getMonth(), 1, 12), selected = dateKey(new Date()), mode = "month", page = 1, summaryGeneration = 0;
  const top = el(ctx.document, "div", "pd-journal-top"), calendar = el(ctx.document, "section", "pd-journal-calendar"), calendarHead = el(ctx.document, "div", "pd-module-section-head"), monthLabel = el(ctx.document, "h2", ""), weekdays = el(ctx.document, "div", "pd-journal-weekdays"), days = el(ctx.document, "div", "pd-journal-days"), statistics = el(ctx.document, "section", "pd-journal-statistics"), listHead = el(ctx.document, "div", "pd-module-section-head"), list = el(ctx.document, "div", "pd-module-list pd-journal-list"), listActions = moduleActions(ctx, v.body);
  const moveMonth = (delta: number) => { month = new Date(month.getFullYear(), month.getMonth() + delta, 1, 12); selected = journalMonthSelection(month, selected); page = 1; render(); };
  calendarHead.append(monthLabel, moduleButton(ctx, "", () => moveMonth(-1), false, "chevron-left"), moduleButton(ctx, "", () => moveMonth(1), false, "chevron-right"));
  calendarHead.querySelectorAll("button")[0].setAttribute("aria-label", t(ctx, "上个月", "Previous month")); calendarHead.querySelectorAll("button")[1].setAttribute("aria-label", t(ctx, "下个月", "Next month"));
  const modeControl = moduleSegments(ctx, [["month", t(ctx, "按月", "Month")], ["year", t(ctx, "按年", "Year")]], mode, value => { mode = value; page = 1; renderList(); });
  calendar.append(calendarHead, weekdays, days); top.append(calendar, statistics); listHead.append(el(ctx.document, "h2", "", t(ctx, "全部日记", "All journals")), modeControl);
  v.body.prepend(top, listHead, list);
  const create = moduleButton(ctx, t(ctx, "写这天日记", "Write this day's journal"), () => {
    if (snapshot?.settings.available) return v.push(createTemplatePicker(ctx, snapshot, selected));
  }); listActions.append(create);
  function render(): void {
    if (!snapshot || !v.alive) return;
    const available = snapshot.settings.available; create.disabled = !available;
    monthLabel.textContent = ctx.host.settings().settingsLanguage === "en" ? month.toLocaleDateString("en", { year: "numeric", month: "long" }) : `${month.getFullYear()} 年 ${month.getMonth() + 1} 月`;
    renderPhotoCalendar({ days, weekdays, month, selected, records: snapshot.records, folder: snapshot.settings.folder, format: snapshot.settings.format, language: ctx.host.settings().settingsLanguage, showOutsideDays: false,
      activity: new Map(snapshot.stats.days.map(day => [day.date, day.count])), onSelect: date => { selected = date; mode = "month"; selectModuleSegment(modeControl, mode); const chosen = new Date(`${date}T12:00:00`); month = new Date(chosen.getFullYear(), chosen.getMonth(), 1, 12); const index = snapshot!.stats.entries.filter(entry => entry.date.startsWith(selected.slice(0, 7))).findIndex(entry => entry.date === selected); page = index < 0 ? 1 : Math.floor(index / 20) + 1; render(); list.querySelector<HTMLElement>(".is-selected")?.scrollIntoView?.({ block: "nearest" }); } });
    statistics.replaceChildren(); const facts = el(ctx.document, "div", "pd-journal-facts");
    for (const [value, label] of [[t(ctx, `${snapshot.stats.streak} 天`, `${snapshot.stats.streak} days`), t(ctx, "连续记录", "Current streak")], [t(ctx, `${snapshot.stats.currentYearCount} 篇`, `${snapshot.stats.currentYearCount} entries`), t(ctx, "今年", "This year")]] as const) { const item = el(ctx.document, "div", "pd-journal-stat"); item.append(el(ctx.document, "strong", "", available ? String(value) : "—"), el(ctx.document, "span", "", label)); facts.append(item); } statistics.append(facts);
    const graph = el(ctx.document, "div", "pd-journal-heatmap"), grid = el(ctx.document, "div", "pd-journal-heat-grid"), activity = new Map(snapshot.stats.days.map(day => [day.date, day.count])), today = new Date();
    graph.append(el(ctx.document, "h2", "", t(ctx, "最近一年", "Past year")), grid); grid.setAttribute("role", "img"); grid.setAttribute("aria-label", t(ctx, "最近一年日记记录", "Journal activity over the past year"));
    const weekday = (today.getDay() + 6) % 7, weeks = Math.ceil((365 + 6 - weekday) / 7);
    for (let week = 0; week < weeks; week++) for (let row = 0; row < 7; row++) {
      const offset = week * 7 + weekday - row, date = new Date(today.getFullYear(), today.getMonth(), today.getDate() - offset, 12), key = dateKey(date), outside = offset < 0 || offset >= 365, count = activity.get(key) ?? 0;
      const cell = el(ctx.document, "span", `pd-journal-heat-cell ${outside ? "is-outside" : `level-${homeContributionLevel(count)}`}`); cell.dataset.date = key;
      if (outside) cell.setAttribute("aria-hidden", "true");
      else { cell.setAttribute("aria-label", `${key} · ${count}`); attachNativeTooltip(cell, `${key} · ${count}`, { touch: "notice" }); }
      grid.append(cell);
    } if (available) statistics.append(graph);
    if (!available) { v.status(t(ctx, "日记目录尚未配置。", "The journal location is not configured.")); list.replaceChildren(moduleButton(ctx, t(ctx, "配置日记", "Configure journals"), () => api.openSettings())); }
    else renderList();
  }
  function renderList(): void {
    if (!snapshot || !snapshot.settings.available || !v.alive) return; const ticket = ++summaryGeneration; list.replaceChildren();
    if (mode === "year") {
      const months = new Map<string, number>(); for (const entry of snapshot.stats.entries) { const key = entry.date.slice(0, 7); months.set(key, (months.get(key) ?? 0) + 1); }
      for (const [key, count] of [...months].sort(([a], [b]) => b.localeCompare(a))) { const row = moduleButton(ctx, "", () => { month = new Date(`${key}-01T12:00:00`); selected = journalMonthSelection(month, selected); mode = "month"; selectModuleSegment(modeControl, mode); render(); }), [year, number] = key.split("-").map(Number); row.classList.add("pd-journal-month"); row.querySelector(".pd-module-button-visible")!.replaceChildren(ipadIcon(ctx.document, "calendar"), el(ctx.document, "span", "pd-grow", t(ctx, `${year} 年 ${number} 月`, `${year}-${number}`)), el(ctx.document, "span", "pd-module-secondary", t(ctx, `${count} 篇`, `${count} entries`)), ipadIcon(ctx.document, "chevron-right")); list.append(row); }
      if (!months.size) moduleEmpty(ctx, list, t(ctx, "还没有日记", "No journals yet")); return;
    }
    const result = journalPageEntries(snapshot.stats.entries, month.getFullYear(), month.getMonth(), page); page = result.page;
    for (const entry of result.entries) {
      const row = el(ctx.document, "button", "pd-journal-entry"); row.type = "button"; row.dataset.path = entry.path;
      const fallback = ipadIcon(ctx.document, "book-open"); fallback.classList.add("pd-journal-placeholder"); row.append(fallback);
      if (entry.firstImageUrl) { const image = el(ctx.document, "img", "pd-journal-thumbnail"); image.src = entry.firstImageUrl; image.alt = ""; image.loading = "lazy"; image.addEventListener("error", () => { image.remove(); fallback.hidden = false; }, { once: true }); fallback.hidden = true; row.append(image); }
      const copy = el(ctx.document, "span", "pd-journal-entry-copy"), summary = el(ctx.document, "span", "pd-module-secondary"); copy.append(el(ctx.document, "span", "", formatMobileDiaryHeading(entry.date, ctx.host.settings().settingsLanguage)), summary); row.append(copy); row.classList.toggle("is-selected", entry.date === selected);
      row.addEventListener("click", () => { void ctx.host.openNote(entry.path).catch(error => v.report(error)); }); list.append(row);
      void api.readSummary(entry.path).then(text => { if (v.alive && ticket === summaryGeneration && row.isConnected) summary.textContent = text; }).catch(error => { if (v.alive && ticket === summaryGeneration) v.report(error); });
    }
    if (!result.entries.length) moduleEmpty(ctx, list, t(ctx, "这个月还没有日记", "No journals this month"));
    if (result.pages > 1) { const actions = moduleActions(ctx, list), previous = moduleButton(ctx, t(ctx, "上一页", "Previous"), () => { page--; renderList(); }), next = moduleButton(ctx, t(ctx, "下一页", "Next"), () => { page++; renderList(); }); previous.disabled = page === 1; next.disabled = page === result.pages; actions.append(previous, el(ctx.document, "span", "", `${page}/${result.pages}`), next); }
  }
  const reload = () => { if (!v.busy) void v.read(() => api.read(), value => { snapshot = value; render(); }); }; v.cleanup(api.subscribe(reload)); v.cleanup(() => { summaryGeneration++; }); reload(); return v.finish();
}

function createTemplatePicker(ctx: IPadPageContext, snapshot: MobileJournalSnapshot, date: string): MobileShellPage {
  const api = ctx.host.services.modules.journal, v = moduleView(ctx, "ipad-journal-templates", t(ctx, "选择日记模板", "Choose a journal template"));
  const open = (choice: HomeJournalTemplateChoice, label: string) => {
    const preview = moduleView(ctx, "ipad-journal-template-preview", label), content = el(ctx.document, "div", "pd-journal-template-preview markdown-rendered"); preview.body.append(content);
    const actions = moduleActions(ctx, preview.body), use = moduleButton(ctx, t(ctx, "使用这个模板", "Use this template"), async () => { const saved = await preview.run(async () => { const result = await api.create(new Date(`${date}T12:00:00`), choice); await ctx.host.openNote(result.path); }); if (saved) { preview.allow(); await ctx.shell.backTo("module:journal"); } }, true); use.disabled = true; actions.append(use);
    void preview.read(() => api.readTemplate(choice), text => { ctx.host.renderMarkdown(text, content); use.disabled = false; }); return v.push(preview.finish());
  };
  const templates = moduleSettingsGroup(ctx, v.body);
  for (const template of BUILT_IN_JOURNAL_TEMPLATES) moduleNavigationRow(ctx, templates, template.name, "", () => open({ kind: "built-in", template }, template.name));
  for (const template of snapshot.templates) moduleNavigationRow(ctx, templates, template.name, "", () => open({ kind: "custom", path: template.path, name: template.name }, template.name));
  const field = el(ctx.document, "label", "pd-module-field"), input = el(ctx.document, "input", "pd-module-input"); input.type = "file"; input.accept = ".md,.markdown"; input.setAttribute("aria-label", t(ctx, "导入模板", "Import template")); field.append(el(ctx.document, "span", "", t(ctx, "导入模板", "Import template")), input); v.body.append(field);
  input.addEventListener("change", () => { const file = input.files?.[0]; if (!file) return; void (async () => { let review: MobileShellPage | undefined; const loaded = await v.run(async () => {
    const template = api.previewImportedTemplate(file.name, decodeImportedMarkdown(await file.arrayBuffer(), ctx.host.settings().settingsLanguage)), preview = moduleView(ctx, "ipad-journal-import-template", template.name), text = el(ctx.document, "div", "pd-journal-template-preview markdown-rendered"), area = el(ctx.document, "div", "pd-module-confirm-area");
    ctx.host.renderMarkdown(template.content, text); preview.body.append(text); const actions = moduleActions(ctx, preview.body); preview.body.append(area);
    const save = async (resolution?: "safe-copy") => { const saved = await preview.run(async () => { const result = await api.saveImportedTemplate(template, resolution); if (!preview.alive) return;
      if (result.status === "conflict") { moduleConfirm(ctx, area, t(ctx, "已有同名模板，另存安全副本？", "A template with this name exists. Save a separate copy?"), () => save("safe-copy"), t(ctx, "另存副本", "Save a copy")); return; }
      preview.status(t(ctx, `模板已保存：${result.path}`, `Template saved: ${result.path}`)); area.replaceChildren(); actions.replaceChildren(moduleButton(ctx, t(ctx, "使用这个模板", "Use this template"), async () => { const created = await preview.run(async () => { const journal = await api.create(new Date(`${date}T12:00:00`), { kind: "custom", path: result.path, name: template.name }); await ctx.host.openNote(journal.path); }); if (created) { preview.allow(); await ctx.shell.backTo("module:journal"); } }, true));
    }); return saved; };
    actions.append(moduleButton(ctx, t(ctx, "保存模板", "Save template"), () => save(), true));
    review = preview.finish();
  }); if (loaded && review) await v.push(review); })().catch(error => v.report(error)); });
  return v.finish();
}
