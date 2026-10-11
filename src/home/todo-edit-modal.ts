import { App, Modal, Notice, setIcon } from "obsidian";
import type { TodoHost } from "./home-host";
import { newId } from "../core/new-id";
import { createOriginButton, createOriginInput, createOriginSelect, disposeOriginControls } from "../settings/origin-controls";
import type { ParsedTodoRecord } from "./todo-markdown";
import { joinPeopleNames, parsePeopleNames, personColorIndex, personInitial, TODO_AVATAR_PALETTE_SIZE } from "./todo-people";

/** The form reuses settings' native date input and Origin/Radix selection. */
export class EchoInkTodoFormModal extends Modal {
  private titleValue = "";
  private peopleNames: string[] = [];
  private peopleInputEl: HTMLInputElement | null = null;
  private dueInputEl: HTMLInputElement | null = null;
  private dueTimeInputEl: HTMLInputElement | null = null;
  private dueValue = "";
  private dueTimeValue = "";
  private deadlineChanged = false;
  private categoryName = "";
  private saving = false;
  private syncDisabled: (() => void) | null = null;
  private commitPeopleDraft: (() => void) | null = null;

  constructor(
    app: App,
    private readonly plugin: TodoHost,
    private readonly record: ParsedTodoRecord | null
  ) {
    super(app);
    if (record) {
      this.titleValue = record.title;
      this.peopleNames = [...parsePeopleNames(record.people)];
      this.dueValue = record.dueDate;
      this.dueTimeValue = record.dueTime ?? "";
      this.categoryName = record.categoryName;
    }
  }

  onOpen(): void {
    this.modalEl.addClass("echoink-todo-form-modal");
    const nativeClose = this.modalEl.querySelector(".modal-header-button");
    if (nativeClose) nativeClose.setAttribute("aria-label", this.t("关闭", "Close"));
    this.render();
  }

  onClose(): void {
    disposeOriginControls(this.contentEl);
    this.peopleInputEl = null;
    this.dueInputEl = null;
    this.dueTimeInputEl = null;
    this.syncDisabled = null;
    this.commitPeopleDraft = null;
    this.contentEl.empty();
  }

  private requestClose(): void {
    this.close();
  }

  private t(zh: string, en: string): string {
    return this.plugin.settings.settingsLanguage === "en" ? en : zh;
  }

  private render(): void {
    const { contentEl } = this;
    disposeOriginControls(contentEl);
    contentEl.empty();

    const head = contentEl.createDiv({ cls: "echoink-todo-form-head" });
    const headCopy = head.createDiv();
    headCopy.createEl("h2", { text: this.record ? this.t("编辑待办", "Edit to-do") : this.t("新增待办", "New to-do") });
    headCopy.createEl("p", { text: this.t("保存到 Vault 内的待办源文件。", "Saved to the vault to-do source file.") });
    const body = contentEl.createDiv({ cls: "echoink-todo-form-body" });
    const field = (label: string): HTMLElement => {
      const element = body.createDiv({ cls: "echoink-todo-form-field" });
      element.createEl("label", { text: label });
      return element;
    };

    const titleLabel = this.t("事项", "Item");
    const titleInput = createOriginInput(field(titleLabel), {
      attr: { type: "text", placeholder: this.t("要做什么？（必填）", "What needs doing? (required)"), "aria-label": titleLabel }
    });
    titleInput.value = this.titleValue;
    titleInput.oninput = () => { this.titleValue = titleInput.value; };

    const peopleLabel = this.t("相关人员（选填）", "People (optional)");
    const peopleBox = field(peopleLabel).createDiv({ cls: "echoink-people-field" });
    const renderPeopleTags = (): void => {
      const draft = this.peopleInputEl?.value ?? "";
      disposeOriginControls(peopleBox);
      peopleBox.empty();
      for (const name of this.peopleNames) {
        const tag = peopleBox.createDiv({ cls: "echoink-people-tag" });
        tag.createEl("span", {
          cls: `echoink-todo-avatar echoink-todo-avatar-sm echoink-todo-avatar-c${personColorIndex(name, TODO_AVATAR_PALETTE_SIZE)}`,
          text: personInitial(name),
          attr: { "aria-hidden": "true" }
        });
        tag.createEl("span", { cls: "echoink-people-tag-name", text: name });
        const remove = createOriginButton(tag, {
          cls: "echoink-people-tag-remove is-icon",
          attr: { "aria-label": this.t(`移除 ${name}`, `Remove ${name}`) }
        });
        setIcon(remove, "x");
        remove.onclick = () => {
          this.peopleNames = this.peopleNames.filter((entry) => entry !== name);
          renderPeopleTags();
          this.peopleInputEl?.focus();
        };
      }
      const input = createOriginInput(peopleBox, {
        cls: "echoink-people-input",
        attr: { type: "text", placeholder: this.t("输入姓名，回车或逗号添加", "Type a name, Enter or comma to add"), "aria-label": peopleLabel }
      });
      this.peopleInputEl = input;
      input.value = draft;
      input.onkeydown = (event) => {
        if (event.isComposing || event.keyCode === 229) return;
        if (event.key === "Enter" || event.key === ",") {
          event.preventDefault();
          this.addPeopleFromInput(input);
          renderPeopleTags();
          this.peopleInputEl?.focus();
        } else if (event.key === "Backspace" && !input.value && this.peopleNames.length) {
          event.preventDefault();
          this.peopleNames = this.peopleNames.slice(0, -1);
          renderPeopleTags();
          this.peopleInputEl?.focus();
        }
      };
    };
    renderPeopleTags();
    this.commitPeopleDraft = () => {
      if (this.peopleInputEl) this.addPeopleFromInput(this.peopleInputEl);
      renderPeopleTags();
    };

    const dueLabel = this.t("截止日期（选填）", "Due date (optional)");
    const dueRow = field(dueLabel).createDiv({ cls: "echoink-todo-field-row" });
    const dueInput = createOriginInput(dueRow, { cls: "echoink-todo-date-input", attr: { type: "date", "aria-label": dueLabel } });
    this.dueInputEl = dueInput;
    dueInput.value = this.dueValue;
    const clearDue = createOriginButton(dueRow, { cls: "echoink-origin-button is-tertiary echoink-todo-clear", text: this.t("清空", "Clear") });
    const timeLabel = this.t("截止时间（选填，默认 09:00）", "Due time (optional, defaults to 09:00)");
    const timeField = field(timeLabel);
    const timeInput = createOriginInput(timeField, { attr: { type: "time", step: "60", "aria-label": timeLabel } });
    this.dueTimeInputEl = timeInput;
    timeInput.value = this.dueTimeValue;
    timeInput.oninput = timeInput.onchange = () => { this.deadlineChanged = true; this.dueTimeValue = timeInput.value; };
    const updateDue = (): void => {
      this.dueValue = dueInput.value;
      timeField.hidden = !this.dueValue;
      timeInput.disabled = this.saving || !this.dueValue;
      if (!this.dueValue) { this.dueTimeValue = ""; timeInput.value = ""; }
      clearDue.disabled = this.saving || !this.dueValue;
    };
    dueInput.oninput = dueInput.onchange = () => { this.deadlineChanged = true; updateDue(); };
    clearDue.onclick = () => { this.deadlineChanged = true; dueInput.value = ""; updateDue(); dueInput.focus(); };
    updateDue();

    const categoryLabel = this.t("分类（选填）", "Category (optional)");
    const categoryField = field(categoryLabel);
    const categoryRow = categoryField.createDiv({ cls: "echoink-todo-field-row" });
    const categoryNames = new Set(this.plugin.settings.todoCategories.map((category) => category.name));
    if (this.categoryName) categoryNames.add(this.categoryName);
    const categorySelect = createOriginSelect(categoryRow, {
      cls: "echoink-todo-category-select", attr: { "aria-label": categoryLabel }
    }, [
      { value: "", label: this.t("未分类", "Uncategorized") },
      ...[...categoryNames].map((name) => ({ value: name, label: name }))
    ], this.categoryName, this.app);
    categorySelect.element.onchange = () => { this.categoryName = categorySelect.element.value; };
    const createCategory = createOriginButton(categoryRow, {
      cls: "echoink-origin-button is-tertiary echoink-todo-new-category", text: this.t("新建分类", "New category")
    });
    const editor = categoryField.createDiv({ cls: "echoink-todo-category-editor" });
    editor.hidden = true;
    const categoryInput = createOriginInput(editor, { attr: {
      type: "text", placeholder: this.t("新分类名称", "New category name"), "aria-label": this.t("新分类名称", "New category name")
    } });
    const editorActions = editor.createDiv({ cls: "echoink-todo-category-actions" });
    const cancelCreate = createOriginButton(editorActions, { text: this.t("取消", "Cancel") });
    const confirm = createOriginButton(editorActions, { text: this.t("确定", "Add"), cls: "echoink-origin-button mod-cta" });
    const closeEditor = (): void => {
      editor.hidden = true;
      categoryInput.value = "";
      createCategory.hidden = false;
      createCategory.setAttribute("aria-expanded", "false");
    };
    createCategory.setAttribute("aria-expanded", "false");
    createCategory.onclick = () => {
      editor.hidden = false;
      createCategory.hidden = true;
      createCategory.setAttribute("aria-expanded", "true");
      categoryInput.focus();
    };
    cancelCreate.onclick = () => { closeEditor(); createCategory.focus(); };
    confirm.onclick = () => {
      const name = categoryInput.value.trim();
      if (!name) {
        new Notice(this.t("分类名称不能为空", "The category name cannot be empty"));
        categoryInput.focus();
        return;
      }
      if (!categoryNames.has(name)) {
        categoryNames.add(name);
        categorySelect.addOption(name, name);
      }
      this.categoryName = name;
      categorySelect.element.value = name;
      closeEditor();
      categorySelect.element.focus();
    };
    categoryInput.onkeydown = (event) => {
      if (event.isComposing || event.keyCode === 229 || event.key !== "Enter") return;
      event.preventDefault();
      confirm.click();
    };

    const actions = contentEl.createDiv({ cls: "echoink-todo-form-actions" });
    const cancel = createOriginButton(actions, { text: this.t("取消", "Cancel") });
    cancel.onclick = () => this.requestClose();
    const save = createOriginButton(actions, { cls: "echoink-origin-button mod-cta", text: this.t("保存", "Save") });
    save.onclick = () => void this.save();
    this.syncDisabled = () => {
      for (const control of Array.from(contentEl.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>("input, button, select"))) control.disabled = this.saving;
      clearDue.disabled = this.saving || !this.dueValue;
      timeInput.disabled = this.saving || !this.dueValue;
      save.setAttribute("aria-busy", String(this.saving));
    };
    this.syncDisabled();
    if (!this.record) titleInput.focus();
  }

  /** Plain spaces do not split English full names. */
  private addPeopleFromInput(input: HTMLInputElement): void {
    for (const name of parsePeopleNames(input.value)) {
      if (!this.peopleNames.some((entry) => entry.toLowerCase() === name.toLowerCase())) this.peopleNames.push(name);
    }
    input.value = "";
  }

  private async save(): Promise<void> {
    if (this.saving) return;
    const title = this.titleValue.trim();
    if (!title) {
      new Notice(this.t("事项标题不能为空", "The title cannot be empty"));
      return;
    }
    if (this.dueInputEl && !this.dueInputEl.reportValidity()) return;
    if (this.dueValue && this.dueTimeInputEl && !this.dueTimeInputEl.reportValidity()) return;
    this.commitPeopleDraft?.();
    this.saving = true;
    this.syncDisabled?.();
    try {
      const categoryName = this.categoryName;
      if (categoryName && !this.plugin.settings.todoCategories.some((entry) => entry.name === categoryName)) {
        const category = { id: newId("todo-category"), name: categoryName };
        this.plugin.settings.todoCategories.push(category);
        try {
          await this.plugin.saveSettings();
        } catch (error) {
          this.plugin.settings.todoCategories = this.plugin.settings.todoCategories.filter((entry) => entry !== category);
          throw error;
        }
      }
      const store = this.plugin.getTodoStore();
      // An unrelated edit must preserve handwritten deadline metadata, including
      // a time entered before its date. Only explicit deadline edits replace it.
      const values = {
        title, people: joinPeopleNames(this.peopleNames), categoryName,
        ...(!this.record || this.deadlineChanged ? { dueDate: this.dueValue, dueTime: this.dueValue ? this.dueTimeValue : "" } : {})
      };
      if (this.record) await store.updateTodo(this.record, values);
      else await store.addTodo(values);
      this.requestClose();
    } catch (error) {
      this.saving = false;
      this.syncDisabled?.();
      new Notice(this.t(
        `保存失败：${error instanceof Error ? error.message : String(error)}；输入已保留，请重试。`,
        `Save failed: ${error instanceof Error ? error.message : String(error)}. Your input was kept.`
      ));
    }
  }
}
