import type { MobileTodoSnapshot } from "../../mobile/module-contracts";
import type { TodoInput } from "../../home/todo-store";
import type { ParsedTodoRecord } from "../../home/todo-markdown";
import { todoPageRecords } from "../../home/todo-page-model";
import { resolveTodoProject } from "../../home/todo-projects";
import { parsePeopleNames, joinPeopleNames } from "../../home/todo-people";
import { createOriginCheck, createOriginPagination } from "../mobile/origin-controls";
import { iphoneButton, iphoneElement as el } from "./workbench-elements";
import type { IPhonePageContext } from "./workbench-contract";
import { IPhoneModulePage, moduleDate, moduleSegments, moduleText } from "./module-elements";
import { settingsMessage } from "./settings-language";

export async function openIPhoneTodos(ctx: IPhonePageContext): Promise<void> {
  const id = "iphone-module-todos"; if (ctx.shell.hasPage(id)) { await ctx.shell.backTo(id); return; }
  const view = new IPhoneModulePage(ctx, id, "待办", "todos", "帮我把今天和本周的待办排个顺序"), api = ctx.host.services.modules.todos;
  let snapshot: MobileTodoSnapshot | undefined, status: "open" | "done" | "all" = "open", category: string | null = null, project: string | null = null, date = "all", page = 1, revision = 0;
  const render = () => {
    if (!view.alive || !snapshot) return; view.body.replaceChildren(); const filters = el(ctx.document, "div", "ip-module-filters"); view.body.append(filters);
    moduleSegments(view, filters, "待办状态", [["open", "未完成"], ["done", "已完成"], ["all", "全部"]], status, value => { status = value as typeof status; page = 1; render(); });
    view.select(filters, "按项目筛选", [["all", moduleText(ctx, "全部项目")], ["none", moduleText(ctx, "不属于项目")], ...snapshot.projects.map(item => [`path:${item.path}`, item.label] as const)], project ?? "all", value => { project = value === "all" ? null : value; page = 1; render(); });
    view.select(filters, "待办分类", [["all", moduleText(ctx, "全部分类")], ...[...new Set([...snapshot.categories.map(item => item.name), ...snapshot.records.map(item => item.categoryName).filter(Boolean)])].map(name => [name, name] as const)], category ?? "all", value => { category = value === "all" ? null : value; page = 1; render(); });
    view.select(filters, "待办日期", [["all", moduleText(ctx, "全部日期")], ["today", moduleText(ctx, "今天")], ["overdue", moduleText(ctx, "已逾期")], ["none", moduleText(ctx, "无日期")]], date, value => { date = value; page = 1; render(); });
    const today = moduleDate(new Date()), available = snapshot.records.filter(record => date === "all" || (date === "none" ? !record.dueDate : date === "today" ? record.dueDate === today : !!record.dueDate && record.dueDate < today && !record.done));
    const result = todoPageRecords(available, snapshot.projects, { status, category, project, page }); page = result.page;
    const count = el(ctx.document, "div", "ip-todo-count"); count.append(el(ctx.document, "span", "", moduleText(ctx, `符合条件 ${result.total} 项 · 全部 ${snapshot.records.length} 项`, `${result.total} matching · ${snapshot.records.length} total`)), el(ctx.document, "span", "", moduleText(ctx, `累计完成 ${snapshot.completion.total} · 今日完成 ${snapshot.completion.today}`, `Total completed ${snapshot.completion.total} · Today ${snapshot.completion.today}`))); view.body.append(count);
    if (snapshot.warnings.length) view.error.show(moduleText(ctx, `有 ${snapshot.warnings.length} 行无法解析，原文件已保留。`, `${snapshot.warnings.length} lines could not be parsed. The source was kept.`));
    const list = el(ctx.document, "div", "ip-todo-rows"); view.body.append(list);
    for (const record of result.records) {
      const row = el(ctx.document, "div", `ip-todo-row${record.done ? " is-done" : ""}`); row.dataset.todoId = record.id;
      const check = createOriginCheck(row, { cls: "ip-todo-check", attr: { "aria-label": moduleText(ctx, `${record.done ? "取消完成" : "完成"} ${record.title}`, `${record.done ? "Reopen" : "Complete"} ${record.title}`) } }); check.checked = record.done;
      check.addEventListener("change", () => { const value = check.checked; check.disabled = true; void view.run(async () => { await api.toggle(record, value, snapshot!.contentVersion); await refresh(); }).finally(() => { if (view.alive && check.isConnected) { check.checked = snapshot?.records.find(item => item.id === record.id)?.done ?? record.done; check.disabled = false; } }); });
      const title = iphoneButton(ctx.document, record.title, () => { void openTodoForm(ctx, snapshot!, record, refresh).catch(error => ctx.error(error)); }, "is-text"); title.classList.add("ip-todo-main");
      const label = title.querySelector(".ip-button-visible")!; const projectName = resolveTodoProject(record.project, snapshot.projects).label;
      label.append(el(ctx.document, "span", "ip-sub", [record.categoryName, projectName === "—" ? "" : projectName, record.people].filter(Boolean).join(" · "))); row.append(title);
      if (record.dueDate) { const time = el(ctx.document, "time", `ip-todo-date${!record.done && record.dueDate < today ? " is-overdue" : ""}`, [record.dueDate === today ? moduleText(ctx, "今天") : record.dueDate, record.dueTime].filter(Boolean).join(" ")); time.dateTime = record.dueDate + (record.dueTime ? `T${record.dueTime}` : ""); row.append(time); } list.append(row);
    }
    if (!result.records.length) view.empty(list, "没有符合条件的待办");
    const actions = el(ctx.document, "div", "ip-settings-actions"); view.button(actions, "新增待办", () => openTodoForm(ctx, snapshot!, null, refresh)); view.button(actions, "待办设置", () => openIPhoneTodoSettings(ctx)); view.body.append(actions);
    if (result.pages > 1) createOriginPagination(view.body, result.page, result.pages, value => { page = value; render(); });
  };
  const refresh = async () => { const ticket = ++revision; try { const next = await api.read(); if (!view.alive || ticket !== revision) return; snapshot = next; view.error.show(); render(); } catch (error) { if (view.alive && ticket === revision) view.error.show(error); } };
  view.cleanup(api.subscribe(() => { if (!view.busy) void refresh(); })); view.empty(view.body, "正在加载…"); await view.push(); if (view.alive) await refresh();
}

async function openTodoForm(ctx: IPhonePageContext, source: MobileTodoSnapshot, record: ParsedTodoRecord | null, saved: () => Promise<void>): Promise<void> {
  const api = ctx.host.services.modules.todos, view = new IPhoneModulePage(ctx, `iphone-todo-form-${record?.id ?? "new"}`, record ? "编辑待办" : "新增待办");
  let version = source.contentVersion, target = record; const draft: TodoInput = { title: record?.title ?? "", people: record?.people ?? "", dueDate: record?.dueDate ?? "", dueTime: record?.dueTime ?? "", categoryName: record?.categoryName ?? "", project: record?.project ?? "" }, original = structuredClone(draft), changed = new Set<keyof TodoInput>();
  const change = <K extends keyof TodoInput>(key: K, value: TodoInput[K]) => { draft[key] = value; changed.add(key); view.changed(); };
  view.dirty = () => JSON.stringify(draft) !== JSON.stringify(original);
  view.field(view.body, "事项", draft.title, value => change("title", value)).required = true;
  const projectChoices: [string, string][] = [["", moduleText(ctx, "不属于项目")], ...source.projects.map(item => [item.value, item.label] as [string, string])];
  if (draft.project && !projectChoices.some(([key]) => key === draft.project)) projectChoices.push([draft.project, `${draft.project} · ${moduleText(ctx, "原项目不可用")}`]);
  view.select(view.body, "项目", projectChoices, draft.project ?? "", value => change("project", value));
  const people = el(ctx.document, "div", "ip-todo-people"), chips = el(ctx.document, "div", "ip-todo-people-chips"); people.append(chips); view.body.append(people);
  const peopleInput = view.field(people, "相关人员（选填）", "", () => {});
  const drawPeople = () => { chips.replaceChildren(); for (const person of parsePeopleNames(draft.people ?? "")) { const chip = iphoneButton(ctx.document, `${person} ×`, () => { change("people", joinPeopleNames(parsePeopleNames(draft.people ?? "").filter(value => value !== person))); drawPeople(); }, "is-text"); chip.setAttribute("aria-label", moduleText(ctx, `移除 ${person}`, `Remove ${person}`)); chips.append(chip); } };
  const addPeople = () => { if (peopleInput.value.trim()) { change("people", joinPeopleNames([...new Set([...parsePeopleNames(draft.people ?? ""), ...parsePeopleNames(peopleInput.value)])])); peopleInput.value = ""; drawPeople(); } };
  peopleInput.addEventListener("keydown", event => { if (event.key === "Enter" || event.key === "," || event.key === "，") { event.preventDefault(); addPeople(); } }); peopleInput.addEventListener("blur", addPeople); drawPeople();
  const due = view.field(view.body, "截止日期（选填）", draft.dueDate ?? "", value => { change("dueDate", value); if (!value) { change("dueTime", ""); time.value = ""; } syncDue(); }, "date"), clear = view.button(view.body, "清空日期", () => { due.value = ""; change("dueDate", ""); change("dueTime", ""); time.value = ""; syncDue(); });
  const time = view.field(view.body, "截止时间（选填，默认 09:00）", draft.dueTime ?? "", value => change("dueTime", value), "time"); time.step = "60";
  time.parentElement!.append(settingsMessage(ctx, el(ctx.document, "span", "ip-module-status"), "截止时间会保存，此设备不会发送系统提醒。"));
  const syncDue = () => { time.parentElement!.hidden = !draft.dueDate; time.disabled = !draft.dueDate; clear.disabled = !draft.dueDate; }; syncDue();
  const category = view.select(view.body, "分类（选填）", [["", moduleText(ctx, "无分类")], ...[...new Set([...source.categories.map(item => item.name), draft.categoryName].filter((value): value is string => !!value))].map(name => [name, name] as const)], draft.categoryName ?? "", value => change("categoryName", value));
  const categoryArea = el(ctx.document, "div", "ip-module-inline-editor"); categoryArea.hidden = true; const categoryName = view.field(categoryArea, "新分类名称", "", () => {});
  view.button(view.body, "新建分类", () => { categoryArea.hidden = false; categoryName.focus(); }); view.body.append(categoryArea);
  view.button(categoryArea, "取消", () => { categoryArea.hidden = true; categoryName.value = ""; }); view.button(categoryArea, "选用分类", () => { const name = categoryName.value.trim(); if (!name) { view.error.show(moduleText(ctx, "分类名称不能为空。")); return; } if (!Array.from(category.options).some(option => option.value === name)) { const option = el(ctx.document, "option", "", name); option.value = name; category.append(option); } category.value = name; change("categoryName", name); categoryArea.hidden = true; });
  view.button(view.footer, "重新读取", async () => { await view.run(async () => { const latest = await api.read(); if (target) { const next = latest.records.find(item => item.id === target!.id); if (!next) throw new Error(moduleText(ctx, "待办已不存在。")); target = next; } version = latest.contentVersion; }); });
  view.button(view.footer, "取消", async () => { view.allow(); await ctx.shell.back(); });
  view.button(view.footer, "保存", async () => {
    addPeople(); const success = await view.run(async () => { if (!draft.title.trim()) throw new Error(moduleText(ctx, "请填写事项。")); if (target) { const patch: Partial<TodoInput> = {}; for (const key of changed) Object.assign(patch, { [key]: draft[key] }); await api.update(target, patch, version); } else await api.add({ ...draft, title: draft.title.trim() }, version); await saved(); });
    if (success) { view.allow(); await ctx.shell.back(); }
  }, true);
  if (record) view.button(view.body, "删除待办", () => view.confirm(view.content, "删除这条待办？删除后无法恢复。", "删除", async () => { if (await view.run(async () => { await api.remove(target!, version); await saved(); })) { view.allow(); await ctx.shell.back(); } }, true)); await view.push();
}

export async function openIPhoneTodoSettings(ctx: IPhonePageContext): Promise<void> {
  const id = "iphone-settings-todos"; if (ctx.shell.hasPage(id)) { await ctx.shell.backTo(id); return; }
  const view = new IPhoneModulePage(ctx, id, "待办设置"), api = ctx.host.services.modules.todos; let revision = 0;
  const refresh = async () => {
    const ticket = ++revision; try { const snapshot = await api.read(); if (!view.alive || ticket !== revision) return; view.body.replaceChildren(); const data = view.group("数据文件");
      const source = view.button(data, "待办源文件", () => ctx.host.openNote(snapshot.sourcePath)); source.disabled = !snapshot.exists; data.append(el(ctx.document, "div", "ip-module-path", snapshot.sourcePath));
      const categories = view.group("待办分类"); for (const item of snapshot.categories) { const row = iphoneButton(ctx.document, item.name, () => { void categoryForm(item.name, snapshot.contentVersion).catch(ctx.error); }); row.classList.add("ip-module-navigation-row"); categories.append(row); }
      view.button(categories, "添加分类", () => categoryForm(undefined, snapshot.contentVersion));
    } catch (error) { if (view.alive && ticket === revision) view.error.show(error); }
  };
  const categoryForm = async (oldName: string | undefined, version: string | null) => {
    const form = new IPhoneModulePage(ctx, `iphone-todo-category-${oldName ?? "new"}`, oldName ? "编辑分类" : "添加分类"); let name = oldName ?? ""; form.dirty = () => name !== (oldName ?? "");
    form.field(form.body, "分类名称", name, value => { name = value; }); form.button(form.footer, "取消", async () => { form.allow(); await ctx.shell.back(); });
    form.button(form.footer, "保存", async () => { if (await form.run(async () => { if (oldName) await api.renameCategory(oldName, name.trim(), version); else await api.addCategory(name.trim()); await refresh(); })) { form.allow(); await ctx.shell.back(); } }, true); await form.push();
  };
  view.cleanup(api.subscribe(() => { if (!view.busy) void refresh(); })); await view.push(); if (view.alive) await refresh();
}
