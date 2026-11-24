import { settingsRow } from "./settings-elements";
import type { MobileTodoSnapshot } from "../../mobile/module-contracts";
import type { TodoInput } from "../../home/todo-store";
import type { ParsedTodoRecord } from "../../home/todo-markdown";
import { newMobileTodoPlannerState, renderMobileTodoPlanner } from "../mobile/todo-planner-view";
import { parsePeopleNames, joinPeopleNames } from "../../home/todo-people";
import { iphoneButton, iphoneElement as el } from "./workbench-elements";
import type { IPhonePageContext } from "./workbench-contract";
import { IPhoneModulePage, moduleDate, moduleText } from "./module-elements";
import { settingsMessage } from "./settings-language";

export async function openIPhoneTodos(ctx: IPhonePageContext): Promise<void> {
  const id = "iphone-module-todos"; if (ctx.shell.hasPage(id)) { await ctx.shell.backTo(id); return; }
  const view = new IPhoneModulePage(ctx, id, "待办", "todos", "帮我把今天和本周的待办排个顺序"), api = ctx.host.services.modules.todos;
  let snapshot: MobileTodoSnapshot | undefined, revision = 0;
  const state = newMobileTodoPlannerState(moduleDate(new Date())), host = el(ctx.document, "div", "ip-todo-planner");
  const render = () => {
    if (!view.alive || !snapshot) return; if (!host.isConnected) { view.body.replaceChildren(host); }
    renderMobileTodoPlanner(host, snapshot, state, { platform: "iphone", language: ctx.host.settings().settingsLanguage, today: moduleDate(new Date()), rerender: render,
      toggle: async (record, done) => { await view.run(async () => { await api.toggle(record, done, snapshot!.contentVersion, snapshot!.sourcePath); await refresh(); }); render(); },
      add: async input => { if (!await view.run(async () => { await api.add(input, snapshot!.contentVersion, snapshot!.sourcePath); await refresh(); })) throw new Error("not saved"); },
      open: record => { void openTodoForm(ctx, snapshot!, record, refresh).catch(error => ctx.error(error)); },
      sheet: (title, content) => ctx.shell.openSheet({ title, content }), closeSheet: () => { ctx.shell.closeSheet(); } });
    if (snapshot.warnings.length) view.error.show(moduleText(ctx, `有 ${snapshot.warnings.length} 行无法解析，原文件已保留。`, `${snapshot.warnings.length} lines could not be parsed. The source was kept.`));
  };
  const refresh = async () => { const ticket = ++revision; try { const next = await api.read(); if (!view.alive || ticket !== revision) return; snapshot = next; view.error.show(); render(); } catch (error) { if (view.alive && ticket === revision) view.error.show(error); } };
  view.cleanup(api.subscribe(() => { if (!view.busy) void refresh(); })); view.empty(view.body, "正在加载…"); await view.push(); if (view.alive) await refresh();
}

async function openTodoForm(ctx: IPhonePageContext, source: MobileTodoSnapshot, record: ParsedTodoRecord | null, saved: () => Promise<void>): Promise<void> {
  const api = ctx.host.services.modules.todos, view = new IPhoneModulePage(ctx, `iphone-todo-form-${record?.id ?? "new"}`, record ? "编辑待办" : "新增待办");
  const sourcePath = source.sourcePath;
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
  view.button(view.footer, "重新读取", async () => { await view.run(async () => { const latest = await api.read(); if (latest.sourcePath !== sourcePath) throw new Error(moduleText(ctx, "待办数据文件已切换，请返回后重新打开；输入已保留。", "The to-do file changed. Return and reopen; your draft is retained.")); if (target) { const next = latest.records.find(item => item.id === target!.id); if (!next) throw new Error(moduleText(ctx, "待办已不存在。")); target = next; } version = latest.contentVersion; }); });
  view.button(view.footer, "取消", async () => { view.allow(); await ctx.shell.back(); });
  view.button(view.footer, "保存", async () => {
    addPeople(); const success = await view.run(async () => { if (!draft.title.trim()) throw new Error(moduleText(ctx, "请填写事项。")); if (target) { const patch: Partial<TodoInput> = {}; for (const key of changed) Object.assign(patch, { [key]: draft[key] }); await api.update(target, patch, version, sourcePath); } else await api.add({ ...draft, title: draft.title.trim() }, version, sourcePath); await saved(); });
    if (success) { view.allow(); await ctx.shell.back(); }
  }, true);
  if (record) view.button(view.body, "删除待办", () => view.confirm(view.content, "删除这条待办？删除后无法恢复。", "删除", async () => { if (await view.run(async () => { await api.remove(target!, version, sourcePath); await saved(); })) { view.allow(); await ctx.shell.back(); } }, true)); await view.push();
}

export async function openIPhoneTodoSettings(ctx: IPhonePageContext): Promise<void> {
  const id = "iphone-settings-todos"; if (ctx.shell.hasPage(id)) { await ctx.shell.backTo(id); return; }
  const view = new IPhoneModulePage(ctx, id, "待办设置"), api = ctx.host.services.modules.todos; let revision = 0;
  const refresh = async () => {
    const ticket = ++revision; try { const snapshot = await api.read(); if (!view.alive || ticket !== revision) return; view.body.replaceChildren(); const data = view.group("数据文件");
      settingsRow(ctx, data, "数据文件", { value: snapshot.sourcePath, literalValue: true, action: () => sourcePicker(snapshot.sourcePath) });
      const categories = view.group("待办分类"); for (const item of snapshot.categories) settingsRow(ctx, categories, item.name, { literal: true, action: () => categoryForm(item.name, snapshot.contentVersion, snapshot.sourcePath) });
      settingsRow(ctx, categories, "添加分类", { action: () => categoryForm(undefined, snapshot.contentVersion, snapshot.sourcePath) });
    } catch (error) { if (view.alive && ticket === revision) view.error.show(error); }
  };
  const sourcePicker = async (original: string) => {
    const picker = new IPhoneModulePage(ctx, "iphone-todo-source-picker", "选择数据文件"); let selected = original, query = "";
    picker.field(picker.body, "搜索文件", "", value => { query = value; draw(); }, "search"); const list = picker.group();
    const draw = () => { list.replaceChildren(); const files = api.listSourceFiles().filter(path => path.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
      for (const path of files) settingsRow(ctx, list, path, { literal: true, selected: path === selected, action: async () => { selected = path; draw(); } });
      if (!files.length) picker.empty(list, "没有匹配的文件");
    };
    picker.button(picker.footer, "取消", () => ctx.shell.back().then(() => {})); picker.button(picker.footer, "保存", async () => {
      if (await picker.run(() => api.selectSource(selected, original))) { picker.allow(); await refresh(); await ctx.shell.back(); }
    }, true); draw(); await picker.push();
  };
  const categoryForm = async (oldName: string | undefined, version: string | null, sourcePath: string) => {
    const form = new IPhoneModulePage(ctx, `iphone-todo-category-${oldName ?? "new"}`, oldName ? "编辑分类" : "添加分类"); let name = oldName ?? ""; form.dirty = () => name !== (oldName ?? "");
    form.field(form.body, "分类名称", name, value => { name = value; }); form.button(form.footer, "取消", async () => { form.allow(); await ctx.shell.back(); });
    form.button(form.footer, "保存", async () => { if (await form.run(async () => { if (oldName) await api.renameCategory(oldName, name.trim(), version, sourcePath); else await api.addCategory(name.trim()); await refresh(); })) { form.allow(); await ctx.shell.back(); } }, true); await form.push();
  };
  view.cleanup(api.subscribe(() => { if (!view.busy) void refresh(); })); await view.push(); if (view.alive) await refresh();
}
