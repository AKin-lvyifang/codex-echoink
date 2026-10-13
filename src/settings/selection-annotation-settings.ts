import { Notice, setIcon } from "obsidian";
import type CodexForObsidianPlugin from "../main";
import { createOriginButton, createOriginInput, createOriginSwitch } from "./origin-controls";
import { createSettingsPage, createSettingsSection } from "./settings-v2";
import { createPluginEditionBadge } from "./plugin-edition-badge";
import { normalizeSelectionAskSettings, selectionActionNameError, type SelectionAskAction } from "../selection-ask/settings";
import { conversationUiText } from "../ui/codex-view/ui-i18n";

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

export function renderSelectionAnnotationSettings(container: HTMLElement, plugin: CodexForObsidianPlugin, onBack: () => void): void {
  const language = plugin.settings.settingsLanguage, en = language === "en";
  const text = (zh: string, english: string) => conversationUiText(language, zh, english);
  const draft = normalizeSelectionAskSettings(plugin.settings.selectionAsk);
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
    const updatePreview = () => { action.template = template.value; preview.textContent = action.template.trim() ? `${en ? "Annotation 1, " : "注释1，"}${action.template}` : text("仅添加引用", "Add a reference only"); };
    fields.set(action.id, { name, template, error });
    let composing = false;
    name.addEventListener("compositionstart", () => { composing = true; });
    name.addEventListener("compositionend", () => { composing = false; validate(action); });
    name.addEventListener("input", (event) => { if (!composing && !(event as InputEvent).isComposing) validate(action); });
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
    const next = normalizeSelectionAskSettings(draft); next.enabled = previous.enabled;
    saving = true; save.disabled = true; updateAdd(); status.textContent = "";
    plugin.settings.selectionAsk = next;
    try { await plugin.saveSettings(true); status.textContent = text("已保存", "Saved"); }
    catch (error) { plugin.settings.selectionAsk = previous; status.textContent = text(`保存失败：${String(error)}`, `Could not save: ${String(error)}`); }
    finally { saving = false; save.disabled = false; updateAdd(); }
  };
}
