import { App, Modal, Notice, Setting } from "obsidian";
import type CodexForObsidianPlugin from "../main";
import type { ParsedTodoRecord } from "./todo-markdown";

export class EchoInkTodoEditModal extends Modal {
  private titleValue = "";
  private peopleValue = "";
  private dueValue = "";
  private categoryValue = "";

  constructor(
    app: App,
    private readonly plugin: CodexForObsidianPlugin,
    private readonly record: ParsedTodoRecord | null
  ) {
    super(app);
    if (record) {
      this.titleValue = record.title;
      this.peopleValue = record.people;
      this.dueValue = record.dueDate;
      this.categoryValue = record.categoryName;
    }
  }

  onOpen(): void {
    const zh = this.plugin.settings.settingsLanguage !== "en";
    this.modalEl.addClass("echoink-todo-edit-dialog");
    this.titleEl.setText(zh ? (this.record ? "编辑待办" : "新建待办") : this.record ? "Edit to-do" : "New to-do");
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
          dropdown.addOption(category.name, category.name);
        }
        if (this.categoryValue && !this.plugin.settings.todoCategories.some((category) => category.name === this.categoryValue)) {
          dropdown.addOption(this.categoryValue, this.categoryValue);
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
    const store = this.plugin.getTodoStore();
    if (this.record) {
      await store.updateTodo(this.record, {
        title,
        people: this.peopleValue,
        dueDate: this.dueValue,
        categoryName: this.categoryValue
      });
    } else {
      await store.addTodo({
        title,
        people: this.peopleValue,
        dueDate: this.dueValue,
        categoryName: this.categoryValue
      });
    }
    this.close();
  }
}
