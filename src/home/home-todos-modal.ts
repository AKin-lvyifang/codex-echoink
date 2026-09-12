import { App, Modal, Notice, Setting } from "obsidian";
import type CodexForObsidianPlugin from "../main";
import type { ParsedTodoRecord } from "./todo-markdown";
import { confirmModal } from "../ui/modals";
import { sortOpenTodos } from "./home-todos";
import { renderTodoTable, todoTableCopy } from "./todo-table";
import { EchoInkTodoEditModal } from "./todo-edit-modal";

type TodoFilter = "open" | "done" | "all";

export class EchoInkTodosModal extends Modal {
  private filter: TodoFilter = "open";
  private unsubscribe: (() => void) | null = null;

  constructor(
    app: App,
    private readonly plugin: CodexForObsidianPlugin
  ) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("echoink-todos-dialog");
    this.unsubscribe = this.plugin.getTodoStore().subscribe(() => this.render());
    this.render();
  }

  onClose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.contentEl.empty();
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
      text: this.t("新增待办", "New to-do"),
      attr: { type: "button" }
    });
    addButton.onclick = () => this.openEditor(null);

    const store = this.plugin.getTodoStore();
    const records = store.snapshot();
    const visible = this.filter === "open"
      ? sortOpenTodos(records)
      : this.filter === "done"
        ? records.filter((record) => record.done)
        : [...sortOpenTodos(records), ...records.filter((record) => record.done)];
    const tableHost = contentEl.createDiv({ cls: "todo-dialog-table" });
    renderTodoTable(tableHost, visible, todoTableCopy(this.plugin.settings.settingsLanguage), {
      onToggle: (record, done) => void store.toggleDone(record, done),
      onEdit: (record) => this.openEditor(record),
      onDelete: (record) => void this.confirmDelete(record)
    });
  }

  private async confirmDelete(record: ParsedTodoRecord): Promise<void> {
    const accepted = await confirmModal(
      this.app,
      this.t("删除待办", "Delete to-do"),
      this.t(`确定删除「${record.title}」吗？删除后无法恢复。`, `Delete "${record.title}"? This cannot be undone.`),
      this.t("删除", "Delete"),
      this.t("取消", "Cancel")
    );
    if (!accepted) return;
    await this.plugin.getTodoStore().removeTodo(record);
  }

  private openEditor(record: ParsedTodoRecord | null): void {
    new EchoInkTodoEditModal(this.app, this.plugin, record).open();
  }
}

export function openTodoNotice(message: string): void {
  new Notice(message);
}
