import type { MobileTodoSnapshot } from "../../mobile/module-contracts";
import type { ParsedTodoRecord } from "../../home/todo-markdown";
import { resolveTodoProject } from "../../home/todo-projects";
import { formatMobileDate } from "../../mobile/date-display";
import { newMobileTodoPlannerState, renderMobileTodoPlanner } from "../mobile/todo-planner-view";
import type { MobileShellPage } from "../mobile/shell-types";
import type { IPadPageContext } from "./workbench-contract";
import { ipadIcon } from "./workbench-elements";
import { createModuleForm, el, moduleButton, moduleEmpty, moduleView, moduleSettingsGroup, moduleNavigationRow, moduleField, moduleText as t } from "./module-elements";

export function createTodoPage(ctx: IPadPageContext): MobileShellPage {
  const api = ctx.host.services.modules.todos, v = moduleView(ctx, "module:todos", t(ctx, "待办", "To-dos"), "todos");
  const today = () => formatMobileDate(new Date());
  let snapshot: MobileTodoSnapshot | undefined;
  const state = newMobileTodoPlannerState(today()), host = el(ctx.document, "div", "pd-todo-planner"); v.body.append(host);
  const render = () => {
    if (!snapshot || !v.alive) return;
    renderMobileTodoPlanner(host, snapshot, state, { platform: "ipad", language: ctx.host.settings().settingsLanguage, today: today(), rerender: render,
      toggle: async (record, done) => { if (await v.run(() => api.toggle(record, done, snapshot!.contentVersion, snapshot!.sourcePath))) reload(); else render(); },
      add: async input => { if (!await v.run(() => api.add(input, snapshot!.contentVersion, snapshot!.sourcePath))) throw new Error("not saved"); reload(); },
      open: record => { void v.push(createTodoForm(ctx, snapshot!, record)); },
      sheet: () => {}, closeSheet: () => {} });
    if (snapshot.warnings.length) v.status(t(ctx, `${snapshot.warnings.length} 行待办格式需要核对。`, `${snapshot.warnings.length} to-do lines need review.`));
  };
  const reload = () => { if (!v.busy) void v.read(() => api.read(), value => { snapshot = value; render(); }); };
  v.cleanup(api.subscribe(reload)); reload(); return v.finish();
}

function createTodoForm(ctx: IPadPageContext, snapshot: MobileTodoSnapshot, record: ParsedTodoRecord | null): MobileShellPage {
  const api = ctx.host.services.modules.todos, project = resolveTodoProject(record?.project, snapshot.projects), projectValue = project.status === "resolved" ? project.project!.value : record?.project ?? "";
  const page = createModuleForm(ctx, `ipad-todo-form-${record?.id || "new"}`, t(ctx, record ? "编辑待办" : "新增待办", record ? "Edit to-do" : "Add to-do"), [
    { key: "title", label: t(ctx, "事项", "To-do"), value: record?.title ?? "" }, { key: "people", label: t(ctx, "相关人员", "People"), value: record?.people ?? "" },
    { key: "project", label: t(ctx, "项目", "Project"), value: projectValue, options: [["", t(ctx, "不属于项目", "No project")], ...snapshot.projects.map(item => [item.value, item.label] as const), ...(projectValue && project.status !== "resolved" ? [[projectValue, `${projectValue} · ${project.label}`] as const] : [])] },
    { key: "categoryName", label: t(ctx, "分类", "Category"), value: record?.categoryName ?? "", options: [["", t(ctx, "无分类", "No category")], ...snapshot.categories.map(item => [item.name, item.name] as const), ...(record?.categoryName && !snapshot.categories.some(item => item.name === record.categoryName) ? [[record.categoryName, record.categoryName] as const] : [])] },
    { key: "dueDate", label: t(ctx, "截止日期", "Due date"), value: record?.dueDate ?? "", type: "date" }, { key: "dueTime", label: t(ctx, "截止时间", "Due time"), value: record?.dueTime ?? "", type: "time" }
  ], async values => { if (!values.title.trim()) throw new Error(t(ctx, "请填写事项。", "Enter a to-do.")); if (record) await api.update(record, values, snapshot.contentVersion, snapshot.sourcePath); else await api.add({ ...values, title: values.title }, snapshot.contentVersion, snapshot.sourcePath); }, record ? { remove: { message: t(ctx, "删除这条待办？完成历史会保留。", "Delete this to-do? Completion history is retained."), action: () => api.remove(record, snapshot.contentVersion, snapshot.sourcePath) } } : {});
  const dueDate = page.content.querySelector<HTMLInputElement>('input[type="date"]')!, dueTime = page.content.querySelector<HTMLInputElement>('input[type="time"]')!;
  dueTime.step = "60";
  dueTime.parentElement!.append(el(ctx.document, "span", "pd-module-secondary", t(ctx, "截止时间会保存，此设备不会发送系统提醒。", "The due time is saved. This device does not send system reminders.")));
  const syncDue = () => { dueTime.parentElement!.hidden = !dueDate.value; dueTime.disabled = !dueDate.value; };
  dueDate.addEventListener("input", () => { if (!dueDate.value) { dueTime.value = ""; dueTime.dispatchEvent(new ctx.document.defaultView!.Event("input", { bubbles: true })); } syncDue(); });
  syncDue(); return page;
}

export function createTodoSettings(ctx: IPadPageContext): MobileShellPage {
  const api = ctx.host.services.modules.todos, v = moduleView(ctx, "ipad-todo-settings", t(ctx, "待办设置", "To-do settings")); v.content.classList.add("is-settings");
  const reload = () => { void v.read(() => api.read(), snapshot => { v.body.replaceChildren();
    moduleNavigationRow(ctx, moduleSettingsGroup(ctx, v.body), t(ctx, "数据文件", "Source file"), snapshot.sourcePath, () => v.push(sourcePicker(snapshot.sourcePath)));
    const categories = moduleSettingsGroup(ctx, v.body, t(ctx, "待办分类", "To-do categories"));
    for (const category of snapshot.categories) moduleNavigationRow(ctx, categories, category.name, "", () => v.push(createModuleForm(ctx, `ipad-todo-category-${category.id}`, t(ctx, "编辑分类", "Edit category"), [{ key: "name", label: t(ctx, "分类名称", "Category name"), value: category.name }], async values => { await api.renameCategory(category.name, values.name, snapshot.contentVersion, snapshot.sourcePath); reload(); })));
    moduleNavigationRow(ctx, categories, t(ctx, "新增分类", "Add category"), "", () => v.push(createModuleForm(ctx, "ipad-todo-category-new", t(ctx, "新增分类", "Add category"), [{ key: "name", label: t(ctx, "分类名称", "Category name"), value: "" }], async values => { await api.addCategory(values.name); reload(); })));
  }); };
  const sourcePicker = (original: string): MobileShellPage => {
    const picker = moduleView(ctx, "ipad-todo-source-picker", t(ctx, "选择数据文件", "Choose source file")); picker.content.classList.add("is-settings");
    let selected = original, query = ""; const list = moduleSettingsGroup(ctx, picker.body);
    const draw = () => { list.replaceChildren(); const files = api.listSourceFiles().filter(path => path.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
      for (const path of files) { const row = moduleNavigationRow(ctx, list, path, "", () => { selected = path; draw(); }); row.lastElementChild?.remove(); row.setAttribute("aria-pressed", String(path === selected)); if (path === selected) row.append(ipadIcon(ctx.document, "check")); }
      if (!files.length) moduleEmpty(ctx, list, t(ctx, "没有匹配的文件", "No matching files"));
    };
    const search = moduleField(ctx, picker.body, t(ctx, "搜索文件", "Search files"), "", value => { query = value; draw(); }, "search"); list.before(search.parentElement!);
    const footer = el(ctx.document, "div", "pd-module-actions"); footer.append(moduleButton(ctx, t(ctx, "取消", "Cancel"), () => ctx.shell.back()), moduleButton(ctx, t(ctx, "保存", "Save"), async () => {
      if (await picker.run(() => api.selectSource(selected, original))) { picker.allow(); reload(); await ctx.shell.back(); }
    }, true)); picker.page.footer = footer; draw(); return picker.finish();
  };
  v.cleanup(api.subscribe(reload)); reload(); return v.finish();
}
