import { App, Modal, Notice, setIcon } from "obsidian";
import type CodexForObsidianPlugin from "../main";
import { newId } from "../settings/settings";
import type { ParsedTodoRecord } from "./todo-markdown";
import { joinPeopleNames, parsePeopleNames, personColorIndex, personInitial, TODO_AVATAR_PALETTE_SIZE } from "./todo-people";
import { dateKey } from "./home-workbench-model";

/**
 * To-do create/edit form. Follows the journal template dialog norms (head
 * copy + close, 20px content padding, 36px controls, bottom cancel/save bar)
 * and EchoInk design variables. Date uses a Popover + month Calendar; the
 * category field is a searchable Combobox with inline category creation so no
 * second-layer dialog or settings detour is needed.
 */
export class EchoInkTodoFormModal extends Modal {
  private titleValue = "";
  private peopleNames: string[] = [];
  private dueValue = "";
  private categoryName = "";
  private pendingNewCategory = "";
  private creatingCategory = false;
  private categoryQuery = "";
  private openPanel: "date" | "category" | null = null;
  private allowClose = false;
  private categoryTriggerEl: HTMLElement | null = null;
  private categoryPopEl: HTMLElement | null = null;
  private popOutsideHandler: ((event: PointerEvent) => void) | null = null;
  private popScrollHandler: (() => void) | null = null;
  private popResizeHandler: (() => void) | null = null;
  private month: Date;
  private saving = false;

  constructor(
    app: App,
    private readonly plugin: CodexForObsidianPlugin,
    private readonly record: ParsedTodoRecord | null
  ) {
    super(app);
    if (record) {
      this.titleValue = record.title;
      this.peopleNames = [...parsePeopleNames(record.people)];
      this.dueValue = record.dueDate;
      this.categoryName = record.categoryName;
    }
    const base = record?.dueDate ? parseDateKey(record.dueDate) : new Date();
    this.month = new Date(base.getFullYear(), base.getMonth(), 1);
  }

  onOpen(): void {
    this.modalEl.addClass("echoink-todo-form-modal");
    // Obsidian 1.13 renders its single native close button without a label;
    // give it the correct accessible name for this dialog.
    const nativeClose = this.modalEl.querySelector(".modal-header-button");
    if (nativeClose) nativeClose.setAttribute("aria-label", this.t("关闭", "Close"));
    this.render();
  }

  onClose(): void {
    this.closeCategoryPop(false);
    this.contentEl.empty();
  }

  /**
   * Esc (or any base-Modal close trigger) consumes an open date/category
   * popover first; deliberate exits (save/cancel/close button) set
   * allowClose before calling close().
   */
  close(): void {
    if (this.openPanel === "category" && !this.allowClose) {
      this.closeCategoryPop();
      return;
    }
    if (this.openPanel === "date" && !this.allowClose) {
      this.openPanel = null;
      this.render();
      return;
    }
    super.close();
  }

  private requestClose(): void {
    this.allowClose = true;
    this.close();
  }

  private t(zh: string, en: string): string {
    return this.plugin.settings.settingsLanguage === "en" ? en : zh;
  }

  private render(): void {
    const zh = this.plugin.settings.settingsLanguage !== "en";
    const { contentEl } = this;
    if (this.categoryPopEl) this.closeCategoryPop(false);
    contentEl.empty();

    const head = contentEl.createDiv({ cls: "echoink-todo-form-head" });
    const headCopy = head.createDiv();
    headCopy.createEl("h2", { text: this.record ? this.t("编辑待办", "Edit to-do") : this.t("新增待办", "New to-do") });
    headCopy.createEl("p", { text: this.t("保存到 Vault 内的待办源文件。", "Saved to the vault to-do source file.") });
    // The base Modal already renders one native close button (top-right,
    // labelled); a second custom button here only confused users.

    const body = contentEl.createDiv({ cls: "echoink-todo-form-body" });

    const titleField = body.createDiv({ cls: "echoink-todo-form-field" });
    titleField.createEl("label", { text: this.t("事项", "Item") });
    const titleInput = titleField.createEl("input", {
      attr: { type: "text", placeholder: zh ? "要做什么？（必填）" : "What needs doing? (required)" }
    });
    titleInput.value = this.titleValue;
    titleInput.oninput = () => {
      this.titleValue = titleInput.value;
    };

    const peopleField = body.createDiv({ cls: "echoink-todo-form-field" });
    peopleField.createEl("label", { text: this.t("相关人员（选填）", "People (optional)") });
    const peopleBox = peopleField.createDiv({ cls: "echoink-people-field" });
    const renderPeopleTags = (): void => {
      peopleBox.empty();
      for (const name of this.peopleNames) {
        const tag = peopleBox.createDiv({ cls: "echoink-people-tag" });
        tag.createEl("span", {
          cls: `echoink-todo-avatar echoink-todo-avatar-sm echoink-todo-avatar-c${personColorIndex(name, TODO_AVATAR_PALETTE_SIZE)}`,
          text: personInitial(name),
          attr: { "aria-hidden": "true" }
        });
        tag.createEl("span", { cls: "echoink-people-tag-name", text: name });
        const remove = tag.createEl("button", {
          cls: "echoink-people-tag-remove",
          attr: { type: "button", "aria-label": this.t(`移除 ${name}`, `Remove ${name}`) }
        });
        setIcon(remove, "x");
        remove.onclick = () => {
          this.peopleNames = this.peopleNames.filter((entry) => entry !== name);
          renderPeopleTags();
        };
      }
      const input = peopleBox.createEl("input", {
        cls: "echoink-people-input",
        attr: { type: "text", placeholder: this.t("输入姓名，回车或逗号添加", "Type a name, Enter or comma to add") }
      });
      input.onkeydown = (event) => {
        if (event.isComposing || event.keyCode === 229) return;
        if (event.key === "Enter" || event.key === ",") {
          event.preventDefault();
          this.addPeopleFromInput(input);
          renderPeopleTags();
          peopleBox.querySelector<HTMLInputElement>(".echoink-people-input")?.focus();
          return;
        }
        if (event.key === "Backspace" && !input.value && this.peopleNames.length) {
          event.preventDefault();
          this.peopleNames = this.peopleNames.slice(0, -1);
          renderPeopleTags();
          peopleBox.querySelector<HTMLInputElement>(".echoink-people-input")?.focus();
        }
      };
    };
    renderPeopleTags();

    const dueField = body.createDiv({ cls: "echoink-todo-form-field" });
    dueField.createEl("label", { text: this.t("截止日期（选填）", "Due date (optional)") });
    const dueRow = dueField.createDiv({ cls: "echoink-todo-field-row" });
    const dueTrigger = dueRow.createEl("button", {
      cls: "echoink-home-icon-button echoink-todo-trigger",
      text: this.dueValue || this.t("选择日期", "Pick a date"),
      attr: { type: "button" }
    });
    dueTrigger.classList.toggle("is-empty", !this.dueValue);
    dueTrigger.onclick = () => {
      this.openPanel = this.openPanel === "date" ? null : "date";
      this.render();
    };
    if (this.dueValue) {
      const clearDue = dueRow.createEl("button", {
        cls: "echoink-home-icon-button echoink-todo-clear",
        text: this.t("清空", "Clear"),
        attr: { type: "button" }
      });
      clearDue.onclick = () => {
        this.dueValue = "";
        this.openPanel = null;
        this.render();
      };
    }
    if (this.openPanel === "date") dueField.appendChild(this.renderCalendar());

    const categoryField = body.createDiv({ cls: "echoink-todo-form-field" });
    categoryField.createEl("label", { text: this.t("分类（选填）", "Category (optional)") });
    const categoryRow = categoryField.createDiv({ cls: "echoink-todo-field-row" });
    const categoryTrigger = categoryRow.createEl("button", {
      cls: "echoink-home-icon-button echoink-todo-trigger",
      text: this.categoryName || this.t("未分类", "Uncategorized"),
      attr: { type: "button", "aria-haspopup": "listbox", "aria-expanded": "false" }
    });
    categoryTrigger.classList.toggle("is-empty", !this.categoryName);
    this.categoryTriggerEl = categoryTrigger;
    categoryTrigger.onclick = () => this.toggleCategoryPop();

    const actions = contentEl.createDiv({ cls: "echoink-todo-form-actions" });
    const cancel = actions.createEl("button", { text: this.t("取消", "Cancel"), attr: { type: "button" } });
    cancel.onclick = () => this.requestClose();
    const save = actions.createEl("button", {
      cls: "mod-cta",
      text: this.t("保存", "Save"),
      attr: { type: "button" }
    });
    save.disabled = this.saving;
    save.onclick = () => void this.save();

    if (!this.record) titleInput.focus();
  }

  private renderCalendar(): HTMLElement {
    const zh = this.plugin.settings.settingsLanguage !== "en";
    const pop = this.contentEl.createDiv({ cls: "echoink-todo-pop echoink-todo-date-pop" });
    const head = pop.createDiv({ cls: "echoink-todo-cal-head" });
    const prev = head.createEl("button", { attr: { type: "button", "aria-label": zh ? "上个月" : "Previous month" } });
    setIcon(prev, "chevron-left");
    prev.onclick = () => {
      this.month = new Date(this.month.getFullYear(), this.month.getMonth() - 1, 1);
      this.render();
    };
    head.createEl("strong", {
      text: new Intl.DateTimeFormat(this.plugin.settings.settingsLanguage, { year: "numeric", month: "long" }).format(this.month)
    });
    const next = head.createEl("button", { attr: { type: "button", "aria-label": zh ? "下个月" : "Next month" } });
    setIcon(next, "chevron-right");
    next.onclick = () => {
      this.month = new Date(this.month.getFullYear(), this.month.getMonth() + 1, 1);
      this.render();
    };
    const weekdays = pop.createDiv({ cls: "echoink-todo-cal-weekdays" });
    for (const day of zh ? ["一", "二", "三", "四", "五", "六", "日"] : ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"]) {
      weekdays.createSpan({ text: day });
    }
    const grid = pop.createDiv({ cls: "echoink-todo-cal-grid" });
    const first = this.month;
    const offset = (first.getDay() + 6) % 7;
    const days = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
    for (let blank = 0; blank < offset; blank += 1) grid.createSpan({ cls: "echoink-todo-cal-blank" });
    const today = dateKey(new Date());
    for (let day = 1; day <= days; day += 1) {
      const key = dateKey(new Date(first.getFullYear(), first.getMonth(), day));
      const button = grid.createEl("button", {
        cls: `echoink-todo-cal-day${key === today ? " is-today" : ""}${key === this.dueValue ? " is-selected" : ""}`,
        text: String(day),
        attr: { type: "button" }
      });
      button.onclick = () => {
        this.dueValue = key;
        this.openPanel = null;
        this.render();
      };
    }
    return pop;
  }

  private renderCategoryPopover(): HTMLElement {
    const zh = this.plugin.settings.settingsLanguage !== "en";
    const pop = this.modalEl.createDiv({ cls: "echoink-todo-pop echoink-todo-category-pop" });
    if (this.creatingCategory) {
      const row = pop.createDiv({ cls: "echoink-todo-field-row" });
      const input = row.createEl("input", {
        attr: { type: "text", placeholder: zh ? "新分类名称" : "New category name" }
      });
      input.value = this.pendingNewCategory;
      input.oninput = () => {
        this.pendingNewCategory = input.value;
      };
      const confirm = row.createEl("button", {
        cls: "mod-cta",
        text: this.t("确定", "Add"),
        attr: { type: "button" }
      });
      confirm.onclick = () => {
        const name = this.pendingNewCategory.trim();
        if (!name) {
          new Notice(zh ? "分类名称不能为空" : "The category name cannot be empty");
          return;
        }
        // Same name reuses the existing category; creation happens on save.
        this.categoryName = name;
        this.pendingNewCategory = "";
        this.creatingCategory = false;
        this.closeCategoryPop(false);
        this.render();
        this.categoryTriggerEl?.focus();
      };
      const cancelCreate = row.createEl("button", { text: this.t("取消", "Cancel"), attr: { type: "button" } });
      cancelCreate.onclick = () => {
        this.creatingCategory = false;
        this.pendingNewCategory = "";
        this.refreshCategoryPop();
      };
      input.focus();
      return pop;
    }
    const search = pop.createEl("input", {
      cls: "echoink-todo-combobox-search",
      attr: { type: "text", placeholder: zh ? "搜索分类…" : "Search categories…" }
    });
    search.value = this.categoryQuery;
    search.oninput = () => {
      this.categoryQuery = search.value;
      this.refreshCategoryOptions(pop);
    };
    const list = pop.createDiv({ cls: "echoink-todo-combobox-list" });
    this.fillCategoryOptions(list);
    const createRow = pop.createDiv({ cls: "echoink-todo-combobox-create" });
    const createButton = createRow.createEl("button", {
      cls: "echoink-home-icon-button",
      text: this.t("＋ 新建分类", "+ New category"),
      attr: { type: "button" }
    });
    createButton.onclick = () => {
      this.creatingCategory = true;
      this.refreshCategoryPop();
    };
    search.focus();
    return pop;
  }

  /** Floating category menu anchored to its trigger: opening, searching and
   *  picking never resize or reposition the outer dialog. */
  private toggleCategoryPop(): void {
    if (this.categoryPopEl) {
      this.closeCategoryPop();
      return;
    }
    this.openPanel = "category";
    this.creatingCategory = false;
    this.categoryQuery = "";
    const pop = this.renderCategoryPopover();
    this.categoryPopEl = pop;
    this.modalEl.appendChild(pop);
    this.positionCategoryPop();
    this.categoryTriggerEl?.setAttribute("aria-expanded", "true");
    this.popOutsideHandler = (event: PointerEvent) => {
      const target = event.target as Node;
      if (this.categoryPopEl?.contains(target) || this.categoryTriggerEl?.contains(target)) return;
      event.preventDefault();
      event.stopPropagation();
      this.closeCategoryPop();
    };
    this.modalEl.addEventListener("pointerdown", this.popOutsideHandler, true);
    this.popScrollHandler = () => this.positionCategoryPop();
    this.contentEl.addEventListener("scroll", this.popScrollHandler, { passive: true });
    this.popResizeHandler = () => this.positionCategoryPop();
    this.contentEl.ownerDocument.defaultView?.addEventListener("resize", this.popResizeHandler);
  }

  private closeCategoryPop(focusTrigger = true): void {
    this.categoryPopEl?.remove();
    this.categoryPopEl = null;
    if (this.openPanel === "category") this.openPanel = null;
    if (this.popOutsideHandler) {
      this.modalEl.removeEventListener("pointerdown", this.popOutsideHandler, true);
      this.popOutsideHandler = null;
    }
    if (this.popScrollHandler) {
      this.contentEl.removeEventListener("scroll", this.popScrollHandler);
      this.popScrollHandler = null;
    }
    if (this.popResizeHandler) {
      this.contentEl.ownerDocument.defaultView?.removeEventListener("resize", this.popResizeHandler);
      this.popResizeHandler = null;
    }
    this.categoryTriggerEl?.setAttribute("aria-expanded", "false");
    if (focusTrigger) this.categoryTriggerEl?.focus();
  }

  private refreshCategoryPop(): void {
    if (!this.categoryPopEl) return;
    this.categoryPopEl.remove();
    const pop = this.renderCategoryPopover();
    this.categoryPopEl = pop;
    this.modalEl.appendChild(pop);
    this.positionCategoryPop();
  }

  private positionCategoryPop(): void {
    const pop = this.categoryPopEl;
    const trigger = this.categoryTriggerEl;
    if (!pop || !trigger) return;
    const modalRect = this.modalEl.getBoundingClientRect();
    const triggerRect = trigger.getBoundingClientRect();
    const maxHeight = 264;
    const spaceBelow = modalRect.bottom - triggerRect.bottom - 12;
    const spaceAbove = triggerRect.top - modalRect.top - 12;
    const up = spaceBelow < Math.min(maxHeight, 200) && spaceAbove > spaceBelow;
    pop.classList.toggle("drop-up", up);
    pop.style.left = `${triggerRect.left - modalRect.left}px`;
    pop.style.width = `${Math.max(triggerRect.width, 240)}px`;
    pop.style.top = up
      ? `${triggerRect.top - modalRect.top - 6}px`
      : `${triggerRect.bottom - modalRect.top + 6}px`;
  }

  private refreshCategoryOptions(list: HTMLElement): void {
    list.empty();
    this.fillCategoryOptions(list);
  }

  private fillCategoryOptions(list: HTMLElement): void {
    const zh = this.plugin.settings.settingsLanguage !== "en";
    const query = this.categoryQuery.trim().toLowerCase();
    const option = (name: string, label: string) => {
      const button = list.createEl("button", {
        cls: `echoink-todo-combobox-option${this.categoryName === name ? " is-active" : ""}`,
        text: label,
        attr: { type: "button" }
      });
      button.onclick = () => {
        this.categoryName = name;
        this.closeCategoryPop(false);
        this.render();
        this.categoryTriggerEl?.focus();
      };
    };
    if (!query || (zh ? "未分类" : "uncategorized").includes(query)) option("", zh ? "未分类" : "Uncategorized");
    for (const category of this.plugin.settings.todoCategories) {
      if (query && !category.name.toLowerCase().includes(query)) continue;
      option(category.name, category.name);
    }
  }

  /** Names are added one tag at a time; pasted separator lists split into
   *  multiple tags, plain spaces never split English full names. */
  private addPeopleFromInput(input: HTMLInputElement): void {
    for (const name of parsePeopleNames(input.value)) {
      if (!this.peopleNames.some((entry) => entry.toLowerCase() === name.toLowerCase())) {
        this.peopleNames.push(name);
      }
    }
    input.value = "";
  }

  private async save(): Promise<void> {
    if (this.saving) return;
    const zh = this.plugin.settings.settingsLanguage !== "en";
    const title = this.titleValue.trim();
    if (!title) {
      new Notice(zh ? "事项标题不能为空" : "The title cannot be empty");
      return;
    }
    this.saving = true;
    this.render();
    try {
      let categoryName = this.categoryName;
      if (categoryName && !this.plugin.settings.todoCategories.some((entry) => entry.name === categoryName)) {
        this.plugin.settings.todoCategories.push({ id: newId("todo-category"), name: categoryName });
        await this.plugin.saveSettings();
      }
      const store = this.plugin.getTodoStore();
      if (this.record) {
        await store.updateTodo(this.record, {
          title,
          people: joinPeopleNames(this.peopleNames),
          dueDate: this.dueValue,
          categoryName
        });
      } else {
        await store.addTodo({
          title,
          people: joinPeopleNames(this.peopleNames),
          dueDate: this.dueValue,
          categoryName
        });
      }
      this.requestClose();
    } catch (error) {
      this.saving = false;
      new Notice(
        zh
          ? `保存失败：${error instanceof Error ? error.message : String(error)}；输入已保留，请重试。`
          : `Save failed: ${error instanceof Error ? error.message : String(error)}. Your input was kept.`
      );
      this.render();
    }
  }
}

function parseDateKey(key: string): Date {
  const [year, month, day] = key.split("-").map(Number);
  return new Date(year, month - 1, day);
}
