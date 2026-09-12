import { setIcon } from "obsidian";
import type { SettingsLanguage } from "../settings/settings";
import type { ParsedTodoRecord } from "./todo-markdown";
import { todoDueState, type EchoInkTodoDueState } from "./home-todos";

export interface TodoTableCallbacks {
  onToggle(record: ParsedTodoRecord, done: boolean): void;
  onEdit(record: ParsedTodoRecord): void;
  onDelete(record: ParsedTodoRecord): void;
}

export interface TodoTableCopy {
  doneHead: string;
  titleHead: string;
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
  callbacks: TodoTableCallbacks
): void {
  host.empty();
  const wrap = host.createDiv({ cls: "echoink-todo-table-wrap" });
  const table = wrap.createEl("table", { cls: "echoink-todo-table" });
  const thead = table.createEl("thead", { cls: "echoink-todo-table-head" });
  const headRow = thead.createEl("tr");
  for (const head of [
    copy.doneHead,
    copy.titleHead,
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
    const cell = row.createEl("td", { attr: { colspan: "6" } });
    cell.setText(copy.empty);
    return;
  }
  for (const record of records) tbody.appendChild(renderRow(record, copy, callbacks));
}

function renderRow(
  record: ParsedTodoRecord,
  copy: TodoTableCopy,
  callbacks: TodoTableCallbacks
): HTMLTableRowElement {
  const row = document.createElement("tr");
  row.className = record.done ? "is-done" : "";

  const checkCell = row.createEl("td", { cls: "echoink-todo-check" });
  const checkbox = checkCell.createEl("input", {
    attr: { type: "checkbox", "aria-label": `${copy.doneHead}: ${record.title}` }
  });
  checkbox.checked = record.done;
  checkbox.addEventListener("change", () => callbacks.onToggle(record, checkbox.checked));

  const titleCell = row.createEl("td", { cls: "echoink-todo-title" });
  titleCell.createEl("span", { text: record.title });

  row.createEl("td", { cls: "echoink-todo-people", text: record.people });

  const dueCell = row.createEl("td", { cls: "echoink-todo-due" });
  if (record.dueDate) {
    const state = todoDueState(record.dueDate);
    // Completed items show a plain date: no overdue/today warning.
    const emphasized = !record.done && (state === "overdue" || state === "today");
    const label = record.done ? "" : copy.dueLabels[state];
    dueCell.createEl("span", {
      cls: emphasized ? `echoink-due echoink-due-${state}` : "echoink-due",
      text: label ? `${label} · ${record.dueDate}` : record.dueDate
    });
  }

  row.createEl("td", {
    cls: "echoink-todo-category",
    text: record.categoryName || copy.uncategorized
  });

  const actionsCell = row.createEl("td", { cls: "echoink-todo-actions" });
  const editButton = actionsCell.createEl("button", {
    cls: "echoink-todo-action",
    attr: { type: "button", "aria-label": copy.edit, title: copy.edit }
  });
  setIcon(editButton, "pencil");
  editButton.addEventListener("click", () => callbacks.onEdit(record));
  const deleteButton = actionsCell.createEl("button", {
    cls: "echoink-todo-action echoink-todo-action-danger",
    attr: { type: "button", "aria-label": copy.remove, title: copy.remove }
  });
  setIcon(deleteButton, "trash-2");
  deleteButton.addEventListener("click", () => callbacks.onDelete(record));
  return row;
}
