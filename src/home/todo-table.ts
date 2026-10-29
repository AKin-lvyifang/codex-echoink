import { ownedEl } from "../ui/owned-dom";
import { setIcon } from "obsidian";
import { applyDeleteButton } from "../settings/amicro-buttons";
import type { SettingsLanguage } from "../settings/settings";
import type { ParsedTodoRecord } from "./todo-markdown";
import { parsePeopleNames, personColorIndex, personInitial, TODO_AVATAR_PALETTE_SIZE } from "./todo-people";
import { todoDueState, type EchoInkTodoDueState } from "./home-todos";
import { resolveTodoProject, type TodoProject } from "./todo-projects";
import { attachNativeTooltip } from "../ui/native-tooltip";

export interface TodoTableCallbacks {
  onToggle(record: ParsedTodoRecord, done: boolean): void;
  onEdit(record: ParsedTodoRecord): void;
  onDelete(record: ParsedTodoRecord): void;
  onOpenDiary?(path: string): void;
}

export interface TodoTableCopy {
  doneHead: string;
  titleHead: string;
  projectHead: string;
  peopleHead: string;
  dueHead: string;
  categoryHead: string;
  actionsHead: string;
  empty: string;
  edit: string;
  remove: string;
  uncategorized: string;
  dueLabels: Record<EchoInkTodoDueState, string>;
}

export function todoTableCopy(language: SettingsLanguage): TodoTableCopy {
  const zh = language !== "en";
  return {
    doneHead: zh ? "完成" : "Done",
    titleHead: zh ? "事项" : "Item",
    projectHead: zh ? "项目" : "Project",
    peopleHead: zh ? "相关人员" : "People",
    dueHead: zh ? "截止日期" : "Due",
    categoryHead: zh ? "分类" : "Category",
    actionsHead: zh ? "操作" : "Actions",
    empty: zh ? "暂时没有待办。" : "No to-dos yet.",
    edit: zh ? "编辑" : "Edit",
    remove: zh ? "删除" : "Delete",
    uncategorized: zh ? "未分类" : "Uncategorized",
    dueLabels: zh
      ? { overdue: "逾期", today: "今天", future: "", none: "" }
      : { overdue: "Overdue", today: "Today", future: "", none: "" }
  };
}

/**
 * shadcn/ui Table semantics (container > table > thead/tbody, bordered rows,
 * muted hover) adapted to the Obsidian native DOM used by the home view and
 * the all-to-dos dialog. Scoped styles live under .echoink-todo-table.
 */
export function renderTodoTable(
  host: HTMLElement,
  records: readonly ParsedTodoRecord[],
  copy: TodoTableCopy,
  callbacks: TodoTableCallbacks,
  projects?: readonly TodoProject[]
): void {
  host.empty();
  const wrap = host.createDiv({ cls: "echoink-todo-table-wrap" });
  const table = wrap.createEl("table", { cls: "echoink-todo-table" });
  // Explicit column plan: fixed leading checkbox column, fluid item column,
  // and min-widths for the trailing four so they never collapse.
  const colgroup = table.createEl("colgroup");
  for (let index = 0; index < (projects ? 7 : 6); index += 1) colgroup.createEl("col");
  const thead = table.createEl("thead", { cls: "echoink-todo-table-head" });
  const headRow = thead.createEl("tr");
  for (const head of [
    copy.doneHead,
    copy.titleHead,
    ...(projects ? [copy.projectHead] : []),
    copy.peopleHead,
    copy.dueHead,
    copy.categoryHead,
    copy.actionsHead
  ]) {
    headRow.createEl("th", { text: head });
  }
  const tbody = table.createEl("tbody", { cls: "echoink-todo-table-body" });
  if (!records.length) {
    const row = tbody.createEl("tr", { cls: "echoink-todo-table-empty" });
    const cell = row.createEl("td", { attr: { colspan: projects ? "7" : "6" } });
    cell.setText(copy.empty);
    return;
  }
  for (const record of records) {
    const row = renderRow(record, copy, callbacks, host.ownerDocument, projects);
    tbody.appendChild(row);
    const deleteButton = row.querySelector<HTMLButtonElement>(".echoink-todo-action-delete");
    if (deleteButton) applyDeleteButton(deleteButton, { iconOnly: true });
  }
}

function renderRow(
  record: ParsedTodoRecord,
  copy: TodoTableCopy,
  callbacks: TodoTableCallbacks,
  ownerDocument: Document,
  projects?: readonly TodoProject[]
): HTMLTableRowElement {
  const row = ownedEl(ownerDocument, "tr");
  row.className = record.done ? "is-done" : "";
  row.dataset.todoId = record.id;

  const checkCell = row.createEl("td", { cls: "echoink-todo-check" });
  const checkbox = checkCell.createEl("input", {
    attr: { type: "checkbox", "aria-label": `${copy.doneHead}: ${record.title}` }
  });
  checkbox.checked = record.done;
  checkbox.addEventListener("change", () => callbacks.onToggle(record, checkbox.checked));

  const titleCell = row.createEl("td", { cls: "echoink-todo-title" });
  titleCell.createSpan({ text: record.title });
  if (record.diaryJournalPath) {
    titleCell.createEl("br");
    const source = titleCell.createEl("a", {
      cls: "internal-link", text: copy.titleHead === "事项" ? "AI 从日记记的" : "AI from journal",
      attr: { href: record.diaryJournalPath, "data-href": record.diaryJournalPath }
    });
    if (callbacks.onOpenDiary) source.addEventListener("click", event => {
      event.preventDefault(); event.stopPropagation(); callbacks.onOpenDiary?.(record.diaryJournalPath!);
    });
  }

  if (projects) {
    const cell = row.createEl("td", { cls: "echoink-todo-project" });
    const resolved = resolveTodoProject(record.project, projects);
    if (resolved.status === "none") cell.createSpan({ text: "—", cls: "echoink-todo-none" });
    else {
      setIcon(cell.createSpan({ cls: "echoink-todo-project-icon", attr: { "aria-hidden": "true" } }), "folder");
      const zh = copy.projectHead === "项目";
      const project = cell.createSpan({ text: resolved.status === "resolved" ? resolved.label
        : resolved.status === "ambiguous" ? (zh ? "有同名项目，请重新选择" : "Duplicate project names; select again")
        : (zh ? "项目已不存在" : "Project no longer exists") });
      attachNativeTooltip(project, record.project ?? "", { touch: "notice" });
    }
  }

  const peopleCell = row.createEl("td", { cls: "echoink-todo-people" });
  renderPeopleAvatars(peopleCell, parsePeopleNames(record.people));

  const dueCell = row.createEl("td", { cls: "echoink-todo-due" });
  if (record.dueDate) {
    const state = todoDueState(record.dueDate);
    // Completed items show a plain date: no overdue/today warning.
    const emphasized = !record.done && (state === "overdue" || state === "today");
    const label = record.done ? "" : copy.dueLabels[state];
    dueCell.createSpan({
      cls: emphasized ? `echoink-due echoink-due-${state}` : "echoink-due",
      text: label ? `${label} · ${record.dueDate}` : record.dueDate
    });
    if (record.dueTime) {
      dueCell.createEl("br");
      dueCell.createEl("time", { text: record.dueTime, attr: { datetime: `${record.dueDate}T${record.dueTime}` } });
    }
  }

  const categoryName = record.categoryName || copy.uncategorized;
  const categoryCell = row.createEl("td", { cls: "echoink-todo-category" });
  const category = categoryCell.createSpan({
    cls: "echoink-todo-category-text",
    text: categoryName
  });
  attachNativeTooltip(category, categoryName, { touch: "notice" });

  const actionsCell = row.createEl("td", { cls: "echoink-todo-actions" });
  const editButton = actionsCell.createEl("button", {
    cls: "echoink-todo-action echoink-todo-action-edit",
    attr: { type: "button", "aria-label": copy.edit }
  });
  attachNativeTooltip(editButton, copy.edit);
  setIcon(editButton, "pencil");
  editButton.addEventListener("click", () => callbacks.onEdit(record));
  const deleteButton = actionsCell.createEl("button", {
    cls: "echoink-todo-action echoink-todo-action-delete",
    attr: { type: "button", "aria-label": copy.remove }
  });
  attachNativeTooltip(deleteButton, copy.remove);
  setIcon(deleteButton, "trash-2");
  deleteButton.addEventListener("click", () => callbacks.onDelete(record));
  return row;
}

/** Circular text avatars with slight overlap; "+N" carries the remainder.
 *  Hover, keyboard focus or touch reveals the full name via the host. */
function renderPeopleAvatars(cell: HTMLElement, names: readonly string[]): void {
  if (!names.length) {
    cell.createSpan({ cls: "echoink-todo-none", text: "—" });
    return;
  }
  const group = cell.createDiv({ cls: "echoink-todo-avatars" });
  for (const name of names.slice(0, 3)) {
    const avatar = group.createSpan({
      cls: `echoink-todo-avatar echoink-todo-avatar-c${personColorIndex(name, TODO_AVATAR_PALETTE_SIZE)}`,
      text: personInitial(name),
      attr: { tabindex: "0", role: "img", "aria-label": name }
    });
    attachNativeTooltip(avatar, name, { touch: "notice" });
  }
  const rest = names.slice(3);
  if (rest.length) {
    const restLabel = rest.join("、");
    const avatar = group.createSpan({
      cls: "echoink-todo-avatar echoink-todo-avatar-more",
      text: `+${rest.length}`,
      attr: { tabindex: "0", role: "img", "aria-label": restLabel }
    });
    attachNativeTooltip(avatar, restLabel, { touch: "notice" });
  }
}
