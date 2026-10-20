import type { MobileTodoSnapshot } from "../../mobile/module-contracts";
import type { ParsedTodoRecord } from "../../home/todo-markdown";
import { resolveTodoProject } from "../../home/todo-projects";
import { formatMobileDate } from "../../mobile/date-display";
import { todoPageRecords } from "../../home/todo-page-model";
import type { MobileShellPage } from "../mobile/shell-types";
import type { IPadPageContext } from "./workbench-contract";
import { createModuleForm, el, moduleButton, moduleEmpty, moduleSegments, moduleSelect, moduleView, moduleText as t } from "./module-elements";

export function createTodoPage(ctx: IPadPageContext): MobileShellPage {
  const api = ctx.host.services.modules.todos, v = moduleView(ctx, "module:todos", t(ctx, "待办", "To-dos"), "todos");
  let snapshot: MobileTodoSnapshot | undefined, status: "open" | "done" | "all" = "open", project: string | null = null, category: string | null = null, date = "all", page = 1;
  const toolbar = el(ctx.document, "div", "pd-todo-toolbar"), filters = el(ctx.document, "div", "pd-todo-filters"), advanced = el(ctx.document, "details", "pd-todo-more-filters"), range = el(ctx.document, "div", "pd-todo-range"), table = el(ctx.document, "div", "pd-module-table-scroll pd-todo-list"), pager = el(ctx.document, "div", "pd-module-actions");
  toolbar.append(moduleSegments(ctx, [["open", t(ctx, "未完成", "Open")], ["done", t(ctx, "已完成", "Done")], ["all", t(ctx, "全部", "All")]], status, value => { status = value as typeof status; page = 1; renderRows(); }));
  const projectSelect = moduleSelect(ctx, toolbar, t(ctx, "项目", "Project"), [["", t(ctx, "全部项目", "All projects")]], "", value => { project = value || null; page = 1; renderRows(); });
  projectSelect.parentElement!.classList.add("pd-todo-project");
  const actions = el(ctx.document, "div", "pd-module-actions"); actions.append(moduleButton(ctx, t(ctx, "新增待办", "Add to-do"), () => { if (snapshot) return v.push(createTodoForm(ctx, snapshot, null)); }), moduleButton(ctx, t(ctx, "设置", "Settings"), () => v.push(createTodoSettings(ctx)), false, "settings"));
  const categorySelect = moduleSelect(ctx, filters, t(ctx, "分类", "Category"), [["", t(ctx, "全部分类", "All categories")]], "", value => { category = value || null; page = 1; renderRows(); });
  moduleSelect(ctx, filters, t(ctx, "日期", "Date"), [["all", t(ctx, "全部日期", "All dates")], ["today", t(ctx, "今天", "Today")], ["overdue", t(ctx, "已逾期", "Overdue")], ["none", t(ctx, "无日期", "No date")]], date, value => { date = value; page = 1; renderRows(); }); advanced.append(el(ctx.document, "summary", "", t(ctx, "更多筛选", "More filters")), filters); v.body.append(toolbar, advanced, range, table, pager, actions);
  function renderRows(): void {
    if (!snapshot || !v.alive) return; table.replaceChildren(); pager.replaceChildren(); const today = formatMobileDate(new Date());
    const records = snapshot.records.filter(item => date === "all" || date === "today" && item.dueDate === today || date === "overdue" && !item.done && !!item.dueDate && item.dueDate < today || date === "none" && !item.dueDate);
    const result = todoPageRecords(records, snapshot.projects, { status, category, project, page }); page = result.page;
    range.replaceChildren(el(ctx.document, "span", "", t(ctx, `${result.total} 条`, `${result.total} items`)), el(ctx.document, "span", "", t(ctx, `累计完成 ${snapshot.completion.total} · 今日完成 ${snapshot.completion.today}`, `Total completed ${snapshot.completion.total} · Today ${snapshot.completion.today}`)));
    const grid = el(ctx.document, "table", "pd-todo-table"), head = el(ctx.document, "thead", ""), header = el(ctx.document, "tr", "");
    for (const text of ["", t(ctx, "事项", "To-do"), t(ctx, "项目", "Project"), t(ctx, "分类", "Category"), t(ctx, "截止", "Due")]) header.append(el(ctx.document, "th", "", text)); head.append(header); grid.append(head); const body = el(ctx.document, "tbody", "");
    for (const item of result.records) {
      const row = el(ctx.document, "tr", item.done ? "is-done" : ""), doneCell = el(ctx.document, "td", ""), hit = el(ctx.document, "label", "pd-todo-checkbox-hit"), input = el(ctx.document, "input", ""); input.type = "checkbox"; input.checked = item.done; input.setAttribute("aria-label", `${item.done ? t(ctx, "取消完成", "Reopen") : t(ctx, "完成", "Complete")} ${item.title}`);
      input.addEventListener("change", () => { const requested = input.checked; void v.run(() => api.toggle(item, requested, snapshot!.contentVersion)).then(success => { if (success) reload(); else input.checked = item.done; }); }); hit.append(input); doneCell.append(hit);
      const title = el(ctx.document, "td", ""); title.append(moduleButton(ctx, item.title, () => v.push(createTodoForm(ctx, snapshot!, item))));
      const projectLabel = resolveTodoProject(item.project, snapshot.projects); row.append(doneCell, title, el(ctx.document, "td", "", projectLabel.label), el(ctx.document, "td", "", item.categoryName || "—"), el(ctx.document, "td", "", [item.dueDate ? formatMobileDate(item.dueDate) : "", item.dueTime].filter(Boolean).join(" ") || "—")); body.append(row);
    }
    grid.append(body); table.append(grid); if (!result.records.length) moduleEmpty(ctx, table, t(ctx, "没有符合条件的待办", "No matching to-dos"));
    if (result.pages > 1) { const previous = moduleButton(ctx, t(ctx, "上一页", "Previous"), () => { page--; renderRows(); }), next = moduleButton(ctx, t(ctx, "下一页", "Next"), () => { page++; renderRows(); }); previous.disabled = page === 1; next.disabled = page === result.pages; pager.append(previous, el(ctx.document, "span", "", `${page}/${result.pages}`), next); }
    if (snapshot.warnings.length) v.status(t(ctx, `${snapshot.warnings.length} 行待办格式需要核对。`, `${snapshot.warnings.length} to-do lines need review.`));
  }
  const reload = () => { if (!v.busy) void v.read(() => api.read(), value => {
    snapshot = value;
    const replace = (select: HTMLSelectElement, entries: (readonly [string, string])[], selected: string) => { select.replaceChildren(); for (const [key, label] of entries) { const option = el(ctx.document, "option", "", label); option.value = key; select.append(option); } select.value = selected; };
    replace(projectSelect, [["", t(ctx, "全部项目", "All projects")], ...value.projects.map(item => [`path:${item.path}`, item.label] as const), ...(project && !value.projects.some(item => `path:${item.path}` === project) ? [[project, t(ctx, "项目已不存在", "Project no longer exists")]] as const : [])], project ?? "");
    replace(categorySelect, [["", t(ctx, "全部分类", "All categories")], ...value.categories.map(item => [item.name, item.name] as const)], category ?? ""); renderRows();
  }); }; v.cleanup(api.subscribe(reload)); reload(); return v.finish();
}

function createTodoForm(ctx: IPadPageContext, snapshot: MobileTodoSnapshot, record: ParsedTodoRecord | null): MobileShellPage {
  const api = ctx.host.services.modules.todos, project = resolveTodoProject(record?.project, snapshot.projects), projectValue = project.status === "resolved" ? project.project!.value : record?.project ?? "";
  const page = createModuleForm(ctx, `ipad-todo-form-${record?.id || "new"}`, t(ctx, record ? "编辑待办" : "新增待办", record ? "Edit to-do" : "Add to-do"), [
    { key: "title", label: t(ctx, "事项", "To-do"), value: record?.title ?? "" }, { key: "people", label: t(ctx, "相关人员", "People"), value: record?.people ?? "" },
    { key: "project", label: t(ctx, "项目", "Project"), value: projectValue, options: [["", t(ctx, "不属于项目", "No project")], ...snapshot.projects.map(item => [item.value, item.label] as const), ...(projectValue && project.status !== "resolved" ? [[projectValue, `${projectValue} · ${project.label}`] as const] : [])] },
    { key: "categoryName", label: t(ctx, "分类", "Category"), value: record?.categoryName ?? "", options: [["", t(ctx, "无分类", "No category")], ...snapshot.categories.map(item => [item.name, item.name] as const), ...(record?.categoryName && !snapshot.categories.some(item => item.name === record.categoryName) ? [[record.categoryName, record.categoryName] as const] : [])] },
    { key: "dueDate", label: t(ctx, "截止日期", "Due date"), value: record?.dueDate ?? "", type: "date" }, { key: "dueTime", label: t(ctx, "截止时间", "Due time"), value: record?.dueTime ?? "", type: "time" }
  ], async values => { if (!values.title.trim()) throw new Error(t(ctx, "请填写事项。", "Enter a to-do.")); if (record) await api.update(record, values, snapshot.contentVersion); else await api.add({ ...values, title: values.title }, snapshot.contentVersion); }, record ? { remove: { message: t(ctx, "删除这条待办？完成历史会保留。", "Delete this to-do? Completion history is retained."), action: () => api.remove(record, snapshot.contentVersion) } } : {});
  const dueDate = page.content.querySelector<HTMLInputElement>('input[type="date"]')!, dueTime = page.content.querySelector<HTMLInputElement>('input[type="time"]')!;
  dueTime.step = "60";
  dueTime.parentElement!.append(el(ctx.document, "span", "pd-module-secondary", t(ctx, "截止时间会保存，此设备不会发送系统提醒。", "The due time is saved. This device does not send system reminders.")));
  const syncDue = () => { dueTime.parentElement!.hidden = !dueDate.value; dueTime.disabled = !dueDate.value; };
  dueDate.addEventListener("input", () => { if (!dueDate.value) { dueTime.value = ""; dueTime.dispatchEvent(new ctx.document.defaultView!.Event("input", { bubbles: true })); } syncDue(); });
  syncDue(); return page;
}

export function createTodoSettings(ctx: IPadPageContext): MobileShellPage {
  const api = ctx.host.services.modules.todos, v = moduleView(ctx, "ipad-todo-settings", t(ctx, "待办设置", "To-do settings"));
  const reload = () => { void v.read(() => api.read(), snapshot => { v.body.replaceChildren();
    v.body.append(el(ctx.document, "h2", "", t(ctx, "数据文件", "Source file")), moduleButton(ctx, snapshot.sourcePath, () => ctx.host.services.getTodoStore().openSourceFile()), el(ctx.document, "h2", "", t(ctx, "待办分类", "To-do categories")));
    for (const category of snapshot.categories) v.body.append(moduleButton(ctx, category.name, () => v.push(createModuleForm(ctx, `ipad-todo-category-${category.id}`, t(ctx, "编辑分类", "Edit category"), [{ key: "name", label: t(ctx, "分类名称", "Category name"), value: category.name }], async values => { await api.renameCategory(category.name, values.name, snapshot.contentVersion); reload(); }))));
    v.body.append(moduleButton(ctx, t(ctx, "新增分类", "Add category"), () => v.push(createModuleForm(ctx, "ipad-todo-category-new", t(ctx, "新增分类", "Add category"), [{ key: "name", label: t(ctx, "分类名称", "Category name"), value: "" }], async values => { await api.addCategory(values.name); reload(); }))));
  }); }; v.cleanup(api.subscribe(reload)); reload(); return v.finish();
}
