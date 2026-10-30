import { Notice, Platform, setIcon } from "obsidian";
import type CodexForObsidianPlugin from "../main";
import { createOriginButton, createOriginInput, createOriginSwitch, disposeOriginControls } from "./origin-controls";
import { createSettingsPage, createSettingsSection, showSettingsInlineConfirmation } from "./settings-v2";
import { createPluginEditionBadge } from "./plugin-edition-badge";
import { applyDeleteButton } from "./amicro-buttons";
import { normalizeSelectionAskSettings, selectionActionNameError, type SelectionAskAction } from "../selection-ask/settings";
import { conversationUiText } from "../ui/codex-view/ui-i18n";
import { isComposingInput } from "../ui/ime-composition";

export function renderSelectionAskPluginRow(container: HTMLElement, plugin: CodexForObsidianPlugin, visible: boolean, onSettings: () => void): void {
  const en = plugin.settings.settingsLanguage === "en";
  const name = en ? "Selection Ask" : "选文提问", description = en ? "Add selected passages to a conversation and prepare questions." : "将笔记选段加入聊天，按模板准备问题。";
  const row = container.createDiv({ cls: `codex-resource-row codex-resource-builtin-plugin ${visible ? "" : "is-search-hidden"}`, attr: { "data-resource-key": "echoink:selection-ask", "data-resource-name": name, "data-resource-desc": description, "data-resource-meta": en ? "Basic" : "基础", "data-resource-aliases": "选文提问\nSelection Ask" } });
  setIcon(row.createSpan({ cls: "codex-resource-row-icon" }), "pencil");
  const content = row.createDiv({ cls: "codex-resource-row-content" }), title = content.createDiv({ cls: "codex-resource-row-title" });
  const nameButton = createOriginButton(title, { cls: "codex-resource-row-name", text: name, attr: { "data-echoink-focus-key": "selection-ask:detail" } }); nameButton.onclick = onSettings;
  createPluginEditionBadge(title, "basic", plugin.settings.settingsLanguage);
  content.createDiv({ cls: "codex-resource-row-desc", text: description });
  const settings = createOriginButton(row.createDiv({ cls: "codex-resource-row-actions" }), { cls: "text-button", text: en ? "Settings" : "设置", attr: { "data-echoink-focus-key": "selection-ask:settings" } }); settings.onclick = onSettings;
  const toggle = createOriginSwitch(row, { cls: "codex-resource-toggle", attr: { "aria-label": name, "data-echoink-focus-key": "selection-ask:enabled" } }); toggle.checked = plugin.settings.selectionAsk.enabled;
  row.toggleClass("is-enabled", toggle.checked); row.toggleClass("is-disabled", !toggle.checked);
  toggle.onchange = async () => {
    const previous = plugin.settings.selectionAsk.enabled; toggle.disabled = true; plugin.settings.selectionAsk.enabled = toggle.checked;
    try { await plugin.saveSettings(true); row.toggleClass("is-enabled", toggle.checked); row.toggleClass("is-disabled", !toggle.checked); }
    catch (error) { plugin.settings.selectionAsk.enabled = previous; toggle.checked = previous; new Notice(String(error)); }
    finally { toggle.disabled = false; }
  };
}

export interface SelectionAnnotationSettingsController {
  hasUnsavedChanges(): boolean;
  isPending(): boolean;
  /** An optional destination lets the owning shell guard tab changes too. */
  requestBack(onLeave?: () => void): void;
}

export function renderSelectionAnnotationSettings(container: HTMLElement, plugin: CodexForObsidianPlugin, onBack: () => void): SelectionAnnotationSettingsController | undefined {
  if (Platform.isDesktopApp) return renderDesktopSelectionActions(container, plugin, onBack);
  const language = plugin.settings.settingsLanguage, en = language === "en";
  const text = (zh: string, english: string) => conversationUiText(language, zh, english);
  const normalized = normalizeSelectionAskSettings(plugin.settings.selectionAsk);
  const draft = { ...normalized, actions: normalized.actions.slice(0, 3) };
  const page = createSettingsPage(container, { title: text("选文提问", "Selection Ask"), detail: true, backLabel: text("返回插件", "Back to plugins"), onBack });
  const section = createSettingsSection(page, { title: text("提问选项", "Question actions"), surface: "flat" });
  const list = section.createDiv({ cls: "echoink-selection-settings-actions" });
  const status = page.createDiv({ cls: "echoink-selection-settings-status", attr: { role: "status", "aria-live": "polite" } });
  const footer = page.createDiv({ cls: "echoink-selection-settings-footer" });
  const add = createOriginButton(footer, { text: text("新增选项", "Add action") });
  const save = createOriginButton(footer, { cls: "mod-cta", text: text("保存", "Save") });
  const fields = new Map<string, { name: HTMLInputElement; template: HTMLTextAreaElement; error: HTMLElement }>();
  let saving = false;
  const validate = (action: SelectionAskAction): boolean => {
    const field = fields.get(action.id)!;
    if (action.id !== "default") action.name = field.name.value.trim();
    const error = action.id === "default" ? null : selectionActionNameError(action.name, draft.actions, action.id);
    field.name.setAttribute("aria-invalid", String(Boolean(error)));
    field.error.textContent = error === "empty" ? text("名称不能为空", "Enter a name") : error === "length" ? text("名称最多4个字", "Use at most four visible characters") : error === "duplicate" ? text("名称不能重复", "Use a unique name") : "";
    return !error;
  };
  const renderAction = (action: SelectionAskAction) => {
    const card = list.createDiv({ cls: "echoink-selection-settings-action" });
    const nameRow = card.createDiv({ cls: "echoink-selection-settings-name" });
    const label = nameRow.createEl("label", { text: text("名称", "Name") });
    const name = createOriginInput(nameRow, { value: action.id === "default" ? text("提问", "Ask") : action.name, attr: { "aria-label": text("选项名称", "Action name"), "data-action-id": action.id } });
    const nameId = `selection-action-name-${action.id}`; name.id = nameId; label.htmlFor = nameId; name.disabled = action.id === "default";
    if (action.id !== "default") {
      const remove = createOriginButton(nameRow, { text: text("删除", "Delete"), attr: { "aria-label": text(`删除${action.name}`, `Delete ${action.name}`) } });
      remove.onclick = () => { if (saving) return; draft.actions = draft.actions.filter((value) => value.id !== action.id); fields.delete(action.id); card.remove(); add.disabled = false; add.textContent = text("新增选项", "Add action"); };
    }
    const error = card.createDiv({ cls: "echoink-selection-settings-error", attr: { role: "status" } });
    const templateLabel = card.createEl("label", { text: text("提问模板", "Question template") });
    const template = card.createEl("textarea", { cls: "echoink-selection-settings-template", attr: { rows: "3", "aria-label": text("提问模板", "Question template"), placeholder: text("只填写问题正文", "Enter only the question") } });
    template.id = `selection-template-${action.id}`; templateLabel.htmlFor = template.id; template.value = action.template;
    const preview = card.createDiv({ cls: "echoink-selection-settings-preview" });
    const updatePreview = () => { action.template = template.value; preview.textContent = `${en ? "Annotation 1, " : "注释1，"}${action.template.trim() ? action.template : ""}`; };
    fields.set(action.id, { name, template, error });
    let composing = false;
    name.addEventListener("compositionstart", () => { composing = true; });
    name.addEventListener("compositionend", () => { composing = false; validate(action); });
    name.addEventListener("input", (event) => { if (!composing && !isComposingInput(event)) validate(action); });
    template.addEventListener("input", updatePreview); updatePreview();
  };
  const updateAdd = () => { add.disabled = draft.actions.length >= 3 || saving; add.textContent = draft.actions.length >= 3 ? text("最多3个", "At most 3") : text("新增选项", "Add action"); };
  draft.actions.forEach(renderAction); updateAdd();
  add.onclick = () => {
    if (saving || draft.actions.length >= 3) return;
    let number = draft.actions.length + 1; while (draft.actions.some((action) => action.name === `选项${number}` || action.name === `Opt${number}`)) number++;
    const action = { id: `action-${Date.now()}-${Math.random().toString(36).slice(2)}`, name: en ? `Opt${number}` : `选项${number}`, template: "" };
    draft.actions.push(action); renderAction(action); updateAdd(); fields.get(action.id)!.name.focus();
  };
  save.onclick = async () => {
    if (saving) return;
    if (!draft.actions.map(validate).every(Boolean)) { status.textContent = text("请检查选项名称", "Check the action names"); return; }
    const previous = plugin.settings.selectionAsk;
    const next = normalizeSelectionAskSettings({ ...draft, actions: [...draft.actions, ...previous.actions.slice(3)] }); next.enabled = previous.enabled;
    saving = true; save.disabled = true; updateAdd(); status.textContent = "";
    plugin.settings.selectionAsk = next;
    try { await plugin.saveSettings(true); status.textContent = text("已保存", "Saved"); }
    catch (error) { plugin.settings.selectionAsk = previous; status.textContent = text(`保存失败：${String(error)}`, `Could not save: ${String(error)}`); }
    finally { saving = false; save.disabled = false; updateAdd(); }
  };
}

/** Desktop edits are committed per row; the fixed action keeps its stable id. */
function renderDesktopSelectionActions(container: HTMLElement, plugin: CodexForObsidianPlugin, onBack: () => void): SelectionAnnotationSettingsController {
  const english = plugin.settings.settingsLanguage === "en";
  const text = (zh: string, en: string) => english ? en : zh;
  type Draft = SelectionAskAction & { fresh: boolean; error: string };
  const drafts = new Map<string, Draft>();
  let pending = false;
  const persisted = () => normalizeSelectionAskSettings(plugin.settings.selectionAsk).actions;
  const dirty = () => [...drafts.values()].some(draft => {
    const saved = persisted().find(action => action.id === draft.id);
    return draft.fresh || !saved || saved.name !== draft.name || saved.template !== draft.template;
  });
  const back = (onLeave: () => void = onBack) => {
    if (pending) return;
    if (!dirty()) { onLeave(); return; }
    const trigger = page.querySelector<HTMLButtonElement>(".settings-back")!;
    showSettingsInlineConfirmation(page, trigger, { message: text("选项还有未保存的修改。", "Some action changes have not been saved."), confirmLabel: text("放弃修改", "Discard changes"), cancelLabel: text("继续编辑", "Keep editing"), onConfirm: async () => { drafts.clear(); onLeave(); } });
  };
  const page = createSettingsPage(container, { title: text("提问选项", "Question actions"), detail: true, backLabel: text("返回模块", "Back to modules"), onBack: () => back() });
  const list = page.createDiv({ cls: "echoink-selection-inline-list" });
  const footer = page.createDiv({ cls: "echoink-selection-inline-actions" });
  const status = page.createDiv({ cls: "echoink-selection-settings-status", attr: { role: "status", "aria-live": "polite" } });
  const add = createOriginButton(footer, { text: text("新增选项", "Add action") });
  const limit = footer.createSpan({ text: text("自定义选项最多 3 个", "Up to 3 custom actions") });
  const updatePending = () => {
    for (const field of Array.from(list.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLButtonElement>("input,textarea,button"))) field.disabled = pending || field.dataset.fixedName === "true";
    const total = persisted().length + [...drafts.values()].filter(draft => draft.fresh).length;
    add.hidden = total >= 4; limit.hidden = total < 4; add.disabled = pending;
    page.querySelector<HTMLButtonElement>(".settings-back")!.disabled = pending;
  };
  const saveActions = async (actions: SelectionAskAction[], success: () => void, draft: Draft) => {
    if (pending) return;
    const previous = plugin.settings.selectionAsk;
    pending = true; updatePending(); status.textContent = text("正在保存…", "Saving…");
    plugin.settings.selectionAsk = normalizeSelectionAskSettings({ ...previous, actions });
    try { await plugin.saveSettings(true); success(); status.textContent = text("已保存", "Saved"); }
    catch (error) { plugin.settings.selectionAsk = previous; draft.error = text(`保存失败：${String(error)}`, `Could not save: ${String(error)}`); status.textContent = draft.error; }
    finally { pending = false; render(); }
  };
  const render = (focusId?: string) => {
    disposeOriginControls(list); list.empty();
    const actions = [...persisted(), ...[...drafts.values()].filter(draft => draft.fresh)];
    for (const action of actions) {
      const row = list.createDiv({ cls: "echoink-selection-inline-row", attr: { "data-action-id": action.id } });
      const summary = row.createDiv({ cls: "echoink-selection-inline-summary" });
      const title = action.id === "default" ? text("提问", "Ask") : action.name;
      summary.createEl("strong", { text: title });
      const edit = createOriginButton(summary, { text: text("编辑", "Edit"), cls: "text-button is-tertiary", attr: { "aria-label": text(`编辑${title}`, `Edit ${title}`), "aria-expanded": String(drafts.has(action.id)) } });
      edit.onclick = () => { if (pending) return; if (!drafts.has(action.id)) drafts.set(action.id, { ...action, fresh: false, error: "" }); render(action.id); };
      const draft = drafts.get(action.id);
      if (!draft) continue;
      const editor = row.createDiv({ cls: "echoink-selection-inline-editor" });
      const nameLabel = editor.createEl("label", { text: text("名称", "Name") });
      const name = createOriginInput(nameLabel, { value: action.id === "default" ? text("提问", "Ask") : draft.name, attr: { "aria-label": text("选项名称", "Action name"), "data-fixed-name": String(action.id === "default") } });
      name.disabled = action.id === "default";
      const templateLabel = editor.createEl("label", { text: text("提问模板", "Question template") });
      const template = templateLabel.createEl("textarea", { attr: { rows: "3", "aria-label": text("提问模板", "Question template"), placeholder: text("只填写问题正文", "Enter only the question") } });
      template.value = draft.template;
      const error = editor.createDiv({ cls: "echoink-selection-inline-error", text: draft.error, attr: { role: "status", "aria-live": "polite" } });
      const validate = () => {
        if (action.id !== "default") draft.name = name.value.trim();
        const others = persisted().map(value => drafts.get(value.id) ?? value).concat([...drafts.values()].filter(value => value.fresh));
        const issue = action.id === "default" ? null : selectionActionNameError(draft.name, others, action.id);
        draft.error = issue === "empty" ? text("名称不能为空", "Enter a name") : issue === "length" ? text("名称最多 4 个字", "Use at most 4 visible characters") : issue === "duplicate" ? text("名称不能重复", "Use a unique name") : "";
        error.textContent = draft.error; name.setAttribute("aria-invalid", String(Boolean(issue)));
        return !issue;
      };
      let composing = false;
      name.addEventListener("compositionstart", () => { composing = true; });
      name.addEventListener("compositionend", () => { composing = false; validate(); });
      name.addEventListener("input", event => { draft.name = name.value; if (!composing && !isComposingInput(event)) validate(); });
      template.addEventListener("input", () => { draft.template = template.value; });
      const actionsRow = editor.createDiv({ cls: "echoink-selection-inline-actions" });
      if (action.id !== "default") {
        const remove = createOriginButton(actionsRow, { text: text("删除", "Delete"), cls: "is-danger" });
        applyDeleteButton(remove);
        remove.onclick = () => {
          if (pending) return;
          if (draft.fresh) { drafts.delete(action.id); render(); return; }
          showSettingsInlineConfirmation(row, remove, { deleteAction: true, message: text(`删除“${title}”？`, `Delete “${title}”?`), confirmLabel: text("删除选项", "Delete action"), cancelLabel: text("取消", "Cancel"), onConfirm: async () => { await saveActions(persisted().filter(value => value.id !== action.id), () => drafts.delete(action.id), draft); } });
        };
      }
      const cancel = createOriginButton(actionsRow, { text: text("取消", "Cancel") });
      cancel.onclick = () => { if (!pending) { drafts.delete(action.id); render(); } };
      const save = createOriginButton(actionsRow, { text: text("保存", "Save"), cls: "mod-cta" });
      save.onclick = () => {
        if (pending || composing || !validate()) return;
        draft.template = template.value;
        const current = persisted();
        const next = { id: action.id, name: action.id === "default" ? "提问" : draft.name, template: draft.template };
        if (draft.fresh) { if (current.length >= 4) { draft.error = text("自定义选项最多 3 个", "Up to 3 custom actions"); render(); return; } current.push(next); }
        else { const index = current.findIndex(value => value.id === action.id); if (index < 0) { draft.error = text("选项已变化，请返回后重试", "The action changed. Go back and try again."); render(); return; } current[index] = next; }
        void saveActions(current, () => drafts.delete(action.id), draft);
      };
      if (focusId === action.id) (action.id === "default" ? template : name).focus();
    }
    updatePending();
  };
  add.onclick = () => {
    if (pending || persisted().length + [...drafts.values()].filter(draft => draft.fresh).length >= 4) return;
    const id = `action-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    drafts.set(id, { id, name: "", template: "", fresh: true, error: "" }); render(id);
  };
  page.addEventListener("keydown", event => { if (event.key === "Escape" && !event.defaultPrevented) { event.preventDefault(); event.stopPropagation(); back(); } });
  render();
  return { hasUnsavedChanges: () => pending || dirty(), isPending: () => pending, requestBack: back };
}
