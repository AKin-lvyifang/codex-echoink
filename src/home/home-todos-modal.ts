import { App, Modal, Notice, Setting } from "obsidian";
import type CodexForObsidianPlugin from "../main";
import type { EchoInkTodoItem } from "../settings/settings";
import { confirmModal } from "../ui/modals";
import {
  createTodo,
  removeTodo,
  setTodoDone,
  sortOpenTodos,
  todoCategoryName,
  todoDueState,
  updateTodo,
  saveTodos,
  type EchoInkTodoDueState
} from "./home-todos";

type TodoFilter = "open" | "done" | "all";

export class EchoInkTodosModal extends Modal {
  private filter: TodoFilter = "open";

  constructor(
    app: App,
    private readonly plugin: CodexForObsidianPlugin,
    private readonly onChanged: () => void
  ) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("echoink-todos-dialog");
    this.render();
  }

  private t(zh: string, en: string): string {
    return this.plugin.settings.settingsLanguage === "en" ? en : zh;
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: this.t("全部待办", "All to-dos") });
    const bar = contentEl.createDiv({ cls: "todo-dialog-bar" });
    for (const option of ["open", "done", "all"] as const) {
      const label = this.t(
        { open: "未完成", done: "已完成", all: "全部" }[option],
        { open: "Open", done: "Done", all: "All" }[option]
      );
      const button = bar.createEl("button", {
        cls: `todo-filter ${this.filter === option ? "is-active" : ""}`,
        text: label,
        attr: { type: "button", "aria-pressed": String(this.filter === option) }
      });
      button.onclick = () => {
        this.filter = option;
        this.render();
      };
    }
    const addButton = bar.createEl("button", {
      cls: "todo-dialog-add mod-cta",
      text: this.t("新建待办", "New to-do"),
      attr: { type: "button" }
    });
    addButton.onclick = () => this.openEditor(null);

    const todos = this.plugin.settings.todos;
    const visible = this.filter === "open"
      ? sortOpenTodos(todos)
      : this.filter === "done"
        ? todos.filter((todo) => todo.done).sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0))
        : [
          ...sortOpenTodos(todos),
          ...todos
            .filter((todo) => todo.done)
            .sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0))
        ];
    if (!visible.length) {
      contentEl.createEl("p", {
        cls: "todo-dialog-empty",
        text: this.t(
          this.filter === "done" ? "还没有已完成的待办。" : "暂时没有待办，先加一条吧。",
          this.filter === "done" ? "Nothing completed yet." : "No to-dos yet. Add one to get started."
        )
      });
      return;
    }
    const list = contentEl.createDiv({ cls: "todo-dialog-list" });
    for (const todo of visible) list.appendChild(this.renderRow(todo));
  }

  private renderRow(todo: EchoInkTodoItem): HTMLElement {
    const row = this.contentEl.createDiv({ cls: `todo-row ${todo.done ? "is-done" : ""}` });
    const checkbox = row.createEl("input", {
      attr: { type: "checkbox", "aria-label": this.t("完成状态", "Done state") }
    });
    checkbox.checked = todo.done;
    checkbox.onchange = () => {
      setTodoDone(this.plugin, todo.id, checkbox.checked);
      void saveTodos(this.plugin).then(() => {
        this.onChanged();
        this.render();
      });
    };
    const main = row.createDiv({ cls: "todo-row-main" });
    main.createEl("strong", { text: todo.title });
    const meta = main.createDiv({ cls: "todo-row-meta" });
    if (todo.people) meta.createSpan({ cls: "todo-chip todo-chip-people", text: todo.people });
    const due = todoDueState(todo);
    if (todo.dueDate) {
      meta.createSpan({
        cls: `todo-chip todo-due-${due}`,
        text: `${this.dueLabel(due)} · ${todo.dueDate}`
      });
    }
    meta.createSpan({
      cls: "todo-chip todo-chip-category",
      text: todoCategoryName(
        this.plugin.settings.todoCategories,
        todo.categoryId,
        this.t("未分类", "Uncategorized")
      )
    });
    const actions = row.createDiv({ cls: "todo-row-actions" });
    const editButton = actions.createEl("button", {
      text: this.t("编辑", "Edit"),
      attr: { type: "button" }
    });
    editButton.onclick = () => this.openEditor(todo);
    const deleteButton = actions.createEl("button", {
      cls: "mod-warning",
      text: this.t("删除", "Delete"),
      attr: { type: "button" }
    });
    deleteButton.onclick = () => void this.confirmDelete(todo);
    return row;
  }

  private dueLabel(state: EchoInkTodoDueState): string {
    return this.t(
      { overdue: "逾期", today: "今天到期", future: "到期", none: "" }[state],
      { overdue: "Overdue", today: "Due today", future: "Due", none: "" }[state]
    );
  }

  private async confirmDelete(todo: EchoInkTodoItem): Promise<void> {
    const accepted = await confirmModal(
      this.app,
      this.t("删除待办", "Delete to-do"),
      this.t(`确定删除「${todo.title}」吗？删除后无法恢复。`, `Delete "${todo.title}"? This cannot be undone.`),
      this.t("删除", "Delete"),
      this.t("取消", "Cancel")
    );
    if (!accepted) return;
    removeTodo(this.plugin, todo.id);
    await saveTodos(this.plugin);
    this.onChanged();
    this.render();
  }

  private openEditor(todo: EchoInkTodoItem | null): void {
    new EchoInkTodoEditModal(this.app, this.plugin, todo, () => {
      this.onChanged();
      this.render();
    }).open();
  }
}

export class EchoInkTodoEditModal extends Modal {
  private titleValue = "";
  private peopleValue = "";
  private dueValue = "";
  private categoryValue = "";

  constructor(
    app: App,
    private readonly plugin: CodexForObsidianPlugin,
    private readonly todo: EchoInkTodoItem | null,
    private readonly onSaved: () => void
  ) {
    super(app);
    if (todo) {
      this.titleValue = todo.title;
      this.peopleValue = todo.people;
      this.dueValue = todo.dueDate;
      this.categoryValue = todo.categoryId;
    }
  }

  onOpen(): void {
    const zh = this.plugin.settings.settingsLanguage !== "en";
    this.modalEl.addClass("echoink-todo-edit-dialog");
    this.titleEl.setText(zh ? (this.todo ? "编辑待办" : "新建待办") : this.todo ? "Edit to-do" : "New to-do");
    const { contentEl } = this;
    new Setting(contentEl)
      .setName(zh ? "事项标题" : "Title")
      .addText((text) => {
        text.setPlaceholder(zh ? "要做什么？" : "What needs doing?");
        text.setValue(this.titleValue);
        text.onChange((value) => {
          this.titleValue = value;
        });
      });
    new Setting(contentEl)
      .setName(zh ? "相关人员" : "People")
      .setDesc(zh ? "选填，自由文本，可写多个人名" : "Optional free text; multiple names are fine")
      .addText((text) => {
        text.setValue(this.peopleValue);
        text.onChange((value) => {
          this.peopleValue = value;
        });
      });
    new Setting(contentEl)
      .setName(zh ? "截止日期" : "Due date")
      .addText((text) => {
        text.inputEl.type = "date";
        text.setValue(this.dueValue);
        text.onChange((value) => {
          this.dueValue = /^\d{4}-\d{2}-\d{2}$/u.test(value) ? value : "";
        });
      });
    new Setting(contentEl)
      .setName(zh ? "分类" : "Category")
      .addDropdown((dropdown) => {
        dropdown.addOption("", zh ? "未分类" : "Uncategorized");
        for (const category of this.plugin.settings.todoCategories) {
          dropdown.addOption(category.id, category.name);
        }
        dropdown.setValue(this.categoryValue);
        dropdown.onChange((value) => {
          this.categoryValue = value;
        });
      });
    const actions = contentEl.createDiv({ cls: "todo-edit-actions" });
    const save = actions.createEl("button", {
      cls: "mod-cta",
      text: zh ? "保存" : "Save",
      attr: { type: "button" }
    });
    save.onclick = () => void this.save();
  }

  private async save(): Promise<void> {
    const zh = this.plugin.settings.settingsLanguage !== "en";
    const title = this.titleValue.trim();
    if (!title) {
      new Notice(zh ? "事项标题不能为空" : "The title cannot be empty");
      return;
    }
    if (this.todo) {
      updateTodo(this.plugin, this.todo.id, {
        title,
        people: this.peopleValue,
        dueDate: this.dueValue,
        categoryId: this.categoryValue
      });
    } else {
      createTodo(this.plugin, {
        title,
        people: this.peopleValue,
        dueDate: this.dueValue,
        categoryId: this.categoryValue
      });
    }
    await saveTodos(this.plugin);
    this.onSaved();
    this.close();
  }
}
