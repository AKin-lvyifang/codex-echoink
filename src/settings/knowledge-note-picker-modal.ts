import { createOriginInput, createOriginButton, createOriginCheck, disposeOriginControls, type OriginCheckElement } from "./origin-controls";
import { Modal, setIcon, type App } from "obsidian";
import type {
  KnowledgeInitializationAssignment,
  KnowledgeInitializationRole
} from "../knowledge-base/initializer";
import { applyAmicroButton } from "./amicro-buttons";

export interface KnowledgeNotePickerNote {
  readonly sourcePath: string;
  readonly role: KnowledgeInitializationRole;
}

export interface KnowledgeNotePickerOptions {
  readonly zh: boolean;
  /** 本次「添加笔记」的目标目录角色。 */
  readonly targetRole: Exclude<KnowledgeInitializationRole, "keep">;
  readonly targetLabel: string;
  /** 当前 preview 中全部可分配笔记（keep 等遗留状态由调用方过滤）。 */
  readonly notes: readonly KnowledgeNotePickerNote[];
  /**
   * 确认后回传变更集合；未变化时不会调用。
   * 抛错 = 保存失败：Modal 保持打开、不锁死、显示内联错误，允许再次提交。
   */
  readonly onConfirm: (
    assignments: readonly KnowledgeInitializationAssignment[]
  ) => void | Promise<void>;
  /** 触发该 Modal 的「添加笔记」按钮；仅在未提供 restoreFocus 时使用。 */
  readonly triggerEl?: HTMLElement | null;
  /**
   * 稳定的焦点恢复回调。目录列表提交后会被重建，旧 triggerEl 可能脱离 DOM；
   * 调用方应在这里按 role 重新找到重建后的按钮，并只在 isConnected 时 focus。
   * 取消、Escape、提交成功、提交失败后取消四条路径都会走这里。
   */
  readonly restoreFocus?: () => void;
}

const KNOWLEDGE_NOTE_NAME_COLLATOR = new Intl.Collator("en", {
  numeric: true,
  sensitivity: "base"
});

export function sortKnowledgeNotePickerNotes(
  notes: readonly KnowledgeNotePickerNote[]
): KnowledgeNotePickerNote[] {
  return [...notes].sort((left, right) => {
    const leftName = left.sourcePath.split("/").at(-1) ?? left.sourcePath;
    const rightName = right.sourcePath.split("/").at(-1) ?? right.sourcePath;
    return KNOWLEDGE_NOTE_NAME_COLLATOR.compare(leftName, rightName)
      || KNOWLEDGE_NOTE_NAME_COLLATOR.compare(left.sourcePath, right.sourcePath);
  });
}

/** Local selection draft. Only confirmation submits preview assignments. */
export class KnowledgeNotePickerModal extends Modal {
  private readonly notes: readonly KnowledgeNotePickerNote[];
  private readonly checked = new Set<string>();
  private query = "";
  private searchEl: HTMLInputElement | null = null;
  private listEl: HTMLElement | null = null;
  private selectVisibleEl: OriginCheckElement | null = null;
  private resultCountEl: HTMLElement | null = null;
  private selectedCountEl: HTMLElement | null = null;
  private clearEl: HTMLButtonElement | null = null;
  private confirmEl: HTMLButtonElement | null = null;
  private cancelEl: HTMLButtonElement | null = null;
  private closeEl: HTMLButtonElement | null = null;
  private errorEl: HTMLElement | null = null;
  private confirmed = false;
  private submitting = false;
  private keydownHandler: ((event: KeyboardEvent) => void) | null = null;

  constructor(app: App, private readonly options: KnowledgeNotePickerOptions) {
    super(app);
    // Existing assignments are viewed/removed in the directory, never unchecked
    // implicitly in an Add dialog. Raw uses the same candidate-only semantics.
    this.notes = Object.freeze(sortKnowledgeNotePickerNotes(options.notes.filter(note =>
      note.role !== options.targetRole && note.role !== "keep"
    )));
  }

  get selectedCount(): number { return this.checked.size; }
  get wasConfirmed(): boolean { return this.confirmed; }
  get isSubmitting(): boolean { return this.submitting; }

  open(): void {
    super.open();
    // Obsidian completes its initial focus after onOpen returns. Run after that
    // lifecycle boundary, and cover its first layout pass without a timer.
    const search = this.searchEl;
    search?.focus({ preventScroll: true });
    this.modalEl.ownerDocument.defaultView?.requestAnimationFrame(() => {
      if (!search?.isConnected || this.searchEl !== search) return;
      const active = this.modalEl.ownerDocument.activeElement;
      if (active === this.closeEl || active === this.modalEl || active === this.modalEl.ownerDocument.body) {
        search.focus({ preventScroll: true });
      }
    });
  }

  onOpen(): void {
    const { zh, targetLabel, targetRole, triggerEl } = this.options;
    this.modalEl.addClass("echoink-knowledge-note-picker");
    // Modal lives outside settings; inherit that window's effective theme/scale.
    const source = triggerEl?.closest<HTMLElement>(".echoink-settings-demo");
    const computed = source?.ownerDocument.defaultView?.getComputedStyle?.(source);
    for (const name of ["--bg", "--text", "--secondary", "--muted", "--line", "--soft", "--accent", "--accent-bg", "--font-text-size"]) {
      const value = computed?.getPropertyValue?.(name);
      if (value?.trim()) this.modalEl.style.setProperty(name, value);
    }
    this.titleEl.setText(targetRole === "raw"
      ? (zh ? "移回 Raw" : "Move notes back to Raw")
      : (zh ? `添加笔记到 ${targetLabel}` : `Add notes to ${targetLabel}`));
    const heading = this.contentEl.createDiv({ cls: "picker-heading" });
    setIcon(heading.createSpan({ cls: "picker-folder-icon", attr: { "aria-hidden": "true" } }), "folders");
    const headingCopy = heading.createDiv();
    headingCopy.appendChild(this.titleEl);
    headingCopy.createEl("p", { text: zh ? "可以跨搜索结果多选，选好后一起确认。" : "Select across search results, then confirm your choices together." });
    this.closeEl = heading.createEl("button", { cls: "picker-close", attr: { type: "button", "aria-label": zh ? "关闭" : "Close" } });
    setIcon(this.closeEl, "x");
    this.closeEl.onclick = () => { if (!this.submitting) this.close(); };
    const body = this.contentEl.createDiv({ cls: "echoink-knowledge-note-picker-body" });
    const searchWrap = body.createDiv({ cls: "picker-search" });
    setIcon(searchWrap.createSpan({ attr: { "aria-hidden": "true" } }), "search");
    this.searchEl = createOriginInput(searchWrap, { cls: "echoink-knowledge-note-picker-search", attr: {
      type: "search", placeholder: zh ? "搜索笔记标题或路径…" : "Search note title or path…",
      "aria-label": zh ? "搜索笔记标题或路径" : "Search note title or path", autocomplete: "off"
    } });
    this.searchEl.oninput = () => { this.query = this.searchEl?.value ?? ""; this.renderList(); };
    const listHeading = body.createDiv({ cls: "picker-list-heading" });
    const selectLabel = listHeading.createEl("label");
    this.selectVisibleEl = createOriginCheck(selectLabel, { cls: "picker-select-visible" });
    selectLabel.createSpan({ text: zh ? "全选当前结果" : "Select all results" });
    this.selectVisibleEl.onchange = () => {
      for (const note of this.visibleNotes()) {
        if (this.selectVisibleEl?.checked) this.checked.add(note.sourcePath);
        else this.checked.delete(note.sourcePath);
      }
      this.renderList();
    };
    this.resultCountEl = listHeading.createSpan({ cls: "picker-result-count" });
    this.listEl = body.createDiv({ cls: "echoink-knowledge-note-picker-list", attr: {
      role: "group", "aria-label": zh ? "可分配的笔记" : "Assignable notes"
    } });
    this.errorEl = this.contentEl.createDiv({ cls: "echoink-knowledge-note-picker-error", attr: { role: "alert", "aria-live": "assertive" } });
    const footer = this.contentEl.createDiv({ cls: "echoink-knowledge-note-picker-footer" });
    const selection = footer.createDiv({ cls: "picker-selection" });
    this.selectedCountEl = selection.createEl("strong", { attr: { role: "status", "aria-live": "polite" } });
    this.clearEl = selection.createEl("button", { cls: "picker-clear", text: zh ? "清空" : "Clear", attr: { type: "button" } });
    this.clearEl.onclick = () => { this.checked.clear(); this.renderList(); };
    const actions = footer.createDiv({ cls: "picker-actions" });
    this.cancelEl = createOriginButton(actions, { cls: "echoink-knowledge-note-picker-cancel", text: zh ? "取消" : "Cancel", attr: { type: "button" } });
    applyAmicroButton(this.cancelEl, { variant: "secondary" });
    this.cancelEl.onclick = () => { if (!this.submitting) this.close(); };
    this.confirmEl = createOriginButton(actions, { cls: "mod-cta echoink-knowledge-note-picker-confirm", attr: { type: "button" } });
    applyAmicroButton(this.confirmEl, { variant: "primary", motion: "complete" });
    this.confirmEl.onclick = () => void this.confirm();
    this.renderList();
    this.keydownHandler = event => this.handleKeydown(event);
    this.modalEl.addEventListener("keydown", this.keydownHandler);
    this.searchEl.focus();
  }

  onClose(): void {
    this.searchEl = null;
    disposeOriginControls(this.contentEl);
    if (this.keydownHandler) this.modalEl.removeEventListener("keydown", this.keydownHandler);
    this.keydownHandler = null;
    if (this.options.restoreFocus) this.options.restoreFocus();
    else if (this.options.triggerEl?.isConnected) this.options.triggerEl.focus();
  }

  private confirmLabel(): string {
    const { zh, targetRole, targetLabel } = this.options;
    return targetRole === "raw"
      ? (zh ? `移回 Raw（${this.checked.size}）` : `Move to Raw (${this.checked.size})`)
      : (zh ? `添加到 ${targetLabel}（${this.checked.size}）` : `Add to ${targetLabel} (${this.checked.size})`);
  }

  private visibleNotes(): readonly KnowledgeNotePickerNote[] {
    const query = this.query.trim().toLocaleLowerCase();
    return this.notes.filter(note => !query || note.sourcePath.toLocaleLowerCase().includes(query));
  }

  private renderList(): void {
    const list = this.listEl;
    if (!list) return;
    const { zh } = this.options;
    const scrollTop = list.scrollTop;
    disposeOriginControls(list);
    list.empty();
    const visible = this.visibleNotes();
    if (!visible.length) {
      const empty = list.createDiv({ cls: "echoink-knowledge-note-picker-empty" });
      setIcon(empty.createSpan({ attr: { "aria-hidden": "true" } }), "search");
      empty.createEl("h3", { text: this.query.trim()
        ? (zh ? "没有匹配的笔记" : "No matching notes")
        : (zh ? "没有可添加的笔记" : "No notes to add") });
      empty.createEl("p", { text: this.query.trim()
        ? (zh ? "试试其他关键词，已选内容会保留。" : "Try another search. Your selections are kept.")
        : (zh ? "当前预览中没有其他可分配的 Markdown 笔记。" : "There are no other assignable Markdown notes in this preview.") });
    }
    for (const note of visible) {
      const row = list.createEl("label", { cls: "echoink-knowledge-note-picker-row", attr: { "data-note-path": note.sourcePath } });
      row.toggleClass("is-selected", this.checked.has(note.sourcePath));
      const checkbox = createOriginCheck(row, { cls: "echoink-knowledge-note-picker-checkbox" });
      checkbox.checked = this.checked.has(note.sourcePath);
      checkbox.disabled = this.submitting;
      const icon = row.createSpan({ cls: "picker-note-icon", attr: { "aria-hidden": "true" } });
      setIcon(icon, "file-text");
      const copy = row.createDiv({ cls: "echoink-knowledge-note-picker-copy" });
      const slash = note.sourcePath.lastIndexOf("/");
      copy.createEl("strong", { text: note.sourcePath.slice(slash + 1), cls: "picker-note-title" });
      copy.createEl("small", { cls: "echoink-knowledge-note-picker-path", text: slash < 0 ? (zh ? "根目录" : "Root folder") : note.sourcePath.slice(0, slash) });
      row.createSpan({ cls: "echoink-knowledge-note-picker-badge", text: note.role.charAt(0).toUpperCase() + note.role.slice(1) });
      checkbox.onchange = () => {
        if (checkbox.checked) this.checked.add(note.sourcePath);
        else this.checked.delete(note.sourcePath);
        row.toggleClass("is-selected", checkbox.checked);
        this.updateSelection();
      };
    }
    list.scrollTop = scrollTop;
    this.updateSelection();
  }

  private updateSelection(): void {
    const { zh } = this.options;
    const visible = this.visibleNotes();
    if (this.selectVisibleEl) {
      const selected = visible.filter(note => this.checked.has(note.sourcePath)).length;
      this.selectVisibleEl.checked = visible.length > 0 && selected === visible.length;
      this.selectVisibleEl.indeterminate = selected > 0 && selected < visible.length;
      this.selectVisibleEl.disabled = this.submitting || !visible.length;
    }
    this.resultCountEl?.setText(zh ? `${visible.length} 篇可选笔记` : `${visible.length} available notes`);
    this.selectedCountEl?.setText(zh ? `已选择 ${this.checked.size} 篇` : `${this.checked.size} selected`);
    if (this.clearEl) this.clearEl.disabled = this.submitting || !this.checked.size;
    if (this.confirmEl) {
      this.confirmEl.disabled = this.submitting || !this.checked.size;
      this.confirmEl.setText(this.submitting ? (zh ? "正在保存…" : "Saving…") : this.confirmLabel());
    }
  }

  private setSubmitting(value: boolean): void {
    this.submitting = value;
    for (const control of [this.searchEl, this.cancelEl, this.closeEl]) if (control) control.disabled = value;
    this.listEl?.querySelectorAll<HTMLButtonElement>(".echoink-knowledge-note-picker-checkbox").forEach(control => { control.disabled = value; });
    this.updateSelection();
  }

  private async confirm(): Promise<void> {
    if (this.confirmed || this.submitting || !this.checked.size) return;
    const assignments = this.notes.filter(note => this.checked.has(note.sourcePath))
      .map(note => ({ sourcePath: note.sourcePath, role: this.options.targetRole }));
    this.setSubmitting(true);
    this.errorEl?.setText("");
    try {
      await this.options.onConfirm(Object.freeze(assignments));
      this.confirmed = true;
      this.close();
    } catch {
      this.setSubmitting(false);
      this.errorEl?.setText(this.options.zh ? "没有保存成功，请再试一次。" : "Changes weren't saved. Try again.");
    }
  }

  private handleKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (!this.submitting) this.close();
      return;
    }
    if (event.key !== "Tab") return;
    // Match visual/DOM order, including native close and select-all controls.
    const focusables = Array.from(this.contentEl.querySelectorAll<HTMLElement>("button, input"))
      .filter(element => !(element as HTMLInputElement).disabled && element.getAttribute("tabindex") !== "-1");
    if (!focusables.length) return;
    const index = focusables.indexOf(this.modalEl.ownerDocument.activeElement as HTMLElement);
    const next = index < 0 ? 0 : (index + (event.shiftKey ? -1 : 1) + focusables.length) % focusables.length;
    event.preventDefault();
    focusables[next].focus();
  }
}
