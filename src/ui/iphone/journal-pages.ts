import type { MobileJournalSnapshot } from "../../mobile/module-contracts";
import { BUILT_IN_JOURNAL_TEMPLATES } from "../../home/home-workbench-model";
import type { HomeJournalTemplateChoice } from "../../home/home-workbench-data";
import { journalMonthSelection, journalPageEntries } from "../../home/journal-stats";
import { renderPhotoCalendar } from "../../home/photo-calendar";
import { formatMobileDateGroup } from "../../mobile/date-display";
import { createOriginPagination } from "../mobile/origin-controls";
import { iphoneButton, iphoneElement as el, iphoneIcon } from "./workbench-elements";
import type { IPhonePageContext } from "./workbench-contract";
import { IPhoneModulePage, moduleDate, moduleIconButton, moduleParseDate, moduleSegments, moduleStat, moduleText } from "./module-elements";

export async function openIPhoneJournal(ctx: IPhonePageContext): Promise<void> {
  const id = "iphone-module-journal"; if (ctx.shell.hasPage(id)) { await ctx.shell.backTo(id); return; }
  const view = new IPhoneModulePage(ctx, id, "日记", "journal", "聊聊今天"), api = ctx.host.services.modules.journal;
  let snapshot: MobileJournalSnapshot | undefined, month = new Date(new Date().getFullYear(), new Date().getMonth(), 1), selected = moduleDate(new Date()), mode = "month", page = 1, revision = 0;
  const summaries = new Map<string, { mtime: number; text: string }>();
  const render = () => {
    if (!snapshot || !view.alive) return; view.body.replaceChildren();
    if (!snapshot.settings.available) { view.empty(view.body, "请先选择日记位置"); view.button(view.body, "设置日记位置", async () => { await view.run(async () => { api.openSettings(); }); }); return; }
    const stats = el(ctx.document, "div", "ip-module-stats is-two ip-journal-stats"); moduleStat(view, stats, "连续记录", moduleText(ctx, `${snapshot.stats.streak} 天`, `${snapshot.stats.streak} days`)); moduleStat(view, stats, "今年", moduleText(ctx, `${snapshot.stats.currentYearCount} 篇`, `${snapshot.stats.currentYearCount} entries`)); view.body.append(stats);
    const calendar = el(ctx.document, "section", "ip-journal-calendar"), head = el(ctx.document, "div", "ip-module-section-head"); head.append(el(ctx.document, "h2", "", ctx.host.settings().settingsLanguage === "en" ? new Intl.DateTimeFormat("en", { year: "numeric", month: "long" }).format(month) : `${month.getFullYear()} 年 ${month.getMonth() + 1} 月`)); calendar.append(head);
    const controls = el(ctx.document, "div", "ip-module-inline-actions"); moduleIconButton(view, controls, "上个月", "chevron-left", () => shift(-1)); moduleIconButton(view, controls, "下个月", "chevron-right", () => shift(1)); head.append(controls);
    const weekdays = el(ctx.document, "div", "ip-journal-weekdays"), days = el(ctx.document, "div", "ip-journal-days"); calendar.append(weekdays, days); view.body.append(calendar);
    renderPhotoCalendar({ weekdays, days, month, selected, records: snapshot.records, folder: snapshot.settings.folder, format: snapshot.settings.format, language: ctx.host.settings().settingsLanguage,
      onSelect: key => { selected = key; if (!key.startsWith(moduleDate(month).slice(0, 7))) month = new Date(moduleParseDate(key).getFullYear(), moduleParseDate(key).getMonth(), 1); mode = "month"; const index = snapshot!.stats.entries.filter(entry => entry.date.startsWith(key.slice(0, 7))).findIndex(entry => entry.date === key); page = index < 0 ? 1 : Math.floor(index / 20) + 1; render(); view.body.querySelector(`[data-journal-date="${key}"]`)?.scrollIntoView({ block: "nearest" }); } });
    const matches = snapshot.stats.entries.filter(entry => entry.date === selected);
    if (!matches.length) view.button(view.body, "写这天日记", () => createJournal(ctx, snapshot!, selected, async () => { await refresh(); }));
    const heading = view.heading(view.body, "全部日记"); moduleSegments(view, heading, "日记范围", [["month", "按月"], ["year", "按年"]], mode, value => { mode = value; page = 1; render(); });
    const list = el(ctx.document, "div", "ip-module-rows ip-journal-list"); view.body.append(list);
    if (mode === "year") {
      const years = view.select(view.body, "年份", snapshot.stats.years.map(year => [String(year), String(year)]), String(month.getFullYear()), value => { month = new Date(Number(value), month.getMonth(), 1); render(); }); list.before(years.parentElement!);
      const months = new Map<string, number>(); for (const entry of snapshot.stats.entries) if (entry.date.startsWith(`${month.getFullYear()}-`)) months.set(entry.date.slice(0, 7), (months.get(entry.date.slice(0, 7)) ?? 0) + 1);
      for (const [key, count] of [...months].sort(([a], [b]) => b.localeCompare(a))) {
        const row = iphoneButton(ctx.document, `${key} · ${moduleText(ctx, `${count} 篇`, `${count} entries`)}`, () => { month = moduleParseDate(`${key}-01`); mode = "month"; page = 1; selected = moduleDate(month); render(); }); row.classList.add("ip-module-navigation-row"); list.append(row);
      }
      if (!months.size) view.empty(list, "还没有日记"); return;
    }
    const result = journalPageEntries(snapshot.stats.entries, month.getFullYear(), month.getMonth(), page); page = result.page;
    for (const entry of result.entries) {
      const row = el(ctx.document, "button", "ip-journal-entry"); row.type = "button"; row.dataset.journalDate = entry.date;
      const fallback = iphoneIcon(ctx.document, "book-open"); row.append(fallback);
      if (entry.firstImageUrl) { const image = el(ctx.document, "img", "ip-journal-thumbnail"); image.alt = ""; image.loading = "lazy"; image.addEventListener("error", () => { image.remove(); fallback.hidden = false; }, { once: true }); image.src = entry.firstImageUrl; fallback.hidden = true; row.append(image); }
      const text = el(ctx.document, "span", "ip-grow"), summary = el(ctx.document, "span", "ip-sub"); text.append(el(ctx.document, "span", "ip-module-row-title", formatMobileDateGroup(entry.date, Date.now(), ctx.host.settings().settingsLanguage)), summary); row.append(text); list.append(row);
      const cached = summaries.get(entry.path); if (cached?.mtime === entry.mtime) summary.textContent = cached.text;
      else void api.readSummary(entry.path).then(value => { if (!view.alive || !row.isConnected) return; summaries.set(entry.path, { mtime: entry.mtime, text: value }); summary.textContent = value; }).catch(error => { if (view.alive) view.error.show(error); });
      row.addEventListener("click", () => { void ctx.host.openNote(entry.path).catch(error => ctx.error(error)); });
    }
    if (!result.entries.length) view.empty(list, "还没有日记");
    if (result.pages > 1) createOriginPagination(view.body, result.page, result.pages, next => { page = next; render(); });
  };
  const shift = (delta: number) => { month = new Date(month.getFullYear(), month.getMonth() + delta, 1); selected = journalMonthSelection(month, selected); page = 1; render(); };
  const refresh = async () => { const current = ++revision; try { const next = await api.read(); if (!view.alive || current !== revision) return; snapshot = next; view.error.show(); render(); } catch (error) { if (view.alive && current === revision) { if (!snapshot) view.body.replaceChildren(); view.error.show(error); } } };
  view.cleanup(api.subscribe(() => { void refresh(); })); view.empty(view.body, "正在加载…"); await view.push(); if (view.alive) await refresh();
}

async function createJournal(ctx: IPhonePageContext, snapshot: MobileJournalSnapshot, date: string, saved: () => Promise<void>): Promise<void> {
  const view = new IPhoneModulePage(ctx, `iphone-journal-create-${date}`, "写这天日记"), api = ctx.host.services.modules.journal, choices: HomeJournalTemplateChoice[] = [
    ...BUILT_IN_JOURNAL_TEMPLATES.map(template => ({ kind: "built-in" as const, template })), ...snapshot.templates.map(template => ({ kind: "custom" as const, path: template.path, name: template.name }))
  ]; let selected = 0, revision = 0;
  view.body.append(el(ctx.document, "p", "ip-module-selected-date", date));
  const select = view.select(view.body, "日记模板", choices.map((choice, index) => [String(index), choice.kind === "built-in" ? choice.template.name : choice.name]), "0", value => { selected = Number(value); void preview(); });
  const detail = el(ctx.document, "details", "ip-journal-template-preview"), body = el(ctx.document, "pre", ""); detail.append(el(ctx.document, "summary", "", moduleText(ctx, "模板预览")), body); view.body.append(detail);
  const preview = async () => { const ticket = ++revision; try { const text = await api.readTemplate(choices[selected]); if (view.alive && ticket === revision) body.textContent = text; } catch (error) { if (view.alive && ticket === revision) view.error.show(error); } };
  view.button(view.body, "导入 Markdown 模板", () => view.child(() => importTemplate(ctx, async (path, name) => { choices.push({ kind: "custom", path, name }); const option = el(ctx.document, "option", "", name); option.value = String(choices.length - 1); select.append(option); selected = choices.length - 1; select.value = option.value; await preview(); })));
  view.button(view.footer, "取消", async () => { await ctx.shell.back(); }); view.button(view.footer, "创建日记", async () => {
    const success = await view.run(async () => { const result = await ctx.host.services.modules.journal.create(moduleParseDate(date), choices[selected]); await ctx.host.openNote(result.path); await saved(); });
    if (success) { view.allow(); await ctx.shell.back(); }
  }, true); await view.push(); if (view.alive) await preview();
}

async function importTemplate(ctx: IPhonePageContext, saved: (path: string, name: string) => Promise<void>): Promise<void> {
  const view = new IPhoneModulePage(ctx, "iphone-journal-import-template", "导入日记模板"), api = ctx.host.services.modules.journal;
  let template: ReturnType<typeof api.previewImportedTemplate> | undefined, revision = 0;
  const file = view.field(view.body, "选择 Markdown 文件", "", () => {}, "file"); file.accept = ".md,.markdown,text/markdown";
  const preview = el(ctx.document, "div", "ip-journal-template-preview"); view.body.append(preview);
  const commit = async (resolution?: "safe-copy") => {
    if (!template) return; const current = template;
    await view.run(async () => { const result = await api.saveImportedTemplate(current, resolution); if (!view.alive) return;
      if (result.status === "conflict") { view.confirm(view.content, moduleText(ctx, `同名模板已存在：${result.path}`, `A template already exists: ${result.path}`), "保存安全副本", () => commit("safe-copy")); return; }
      await saved(result.path, result.file?.basename ?? current.name); view.allow(); view.busy = false; await ctx.shell.back();
    });
  };
  view.button(view.footer, "取消", async () => { view.allow(); await ctx.shell.back(); }); const save = view.button(view.footer, "保存模板", () => commit(), true); save.disabled = true;
  file.addEventListener("change", () => { const current = file.files?.[0], ticket = ++revision; if (!current) return; template = undefined; save.disabled = true; void view.run(async () => { const content = await current.text(); if (!view.alive || ticket !== revision) return; template = api.previewImportedTemplate(current.name, content); preview.replaceChildren(el(ctx.document, "h2", "", template.name), el(ctx.document, "div", "ip-module-status", moduleText(ctx, `${template.lineCount} 行`, `${template.lineCount} lines`)), el(ctx.document, "pre", "", template.content)); }).then(ok => { if (ok && ticket === revision) save.disabled = !template; }); });
  await view.push();
}
