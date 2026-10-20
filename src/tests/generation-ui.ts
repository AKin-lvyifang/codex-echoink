import assert from "node:assert/strict";
import { GenerationTemplatesSection } from "../settings/generation-templates-section";
import { defaultGenerationTemplates } from "../settings/generation-templates";
import { disposeOriginControls } from "../settings/origin-controls";
import { installProviderBrowserHost } from "./provider-discovery-dom-host";
import { GenerationModal, type GenerationModalService } from "../generation/modal";
import type EchoInkPlugin from "../main";
import type { GenerationTemplate } from "../generation/types";
import type { TurnOptions } from "../ui/turn-options";
import { renderComposerResourcePanel } from "../ui/codex-view/composer";
import { renderKnowledgeCommandMatches } from "../ui/codex-view/menus";
import { handleKnowledgeCommandMenuKeyDown } from "../ui/knowledge-command-menu";
import { Platform } from "obsidian";

export async function runGenerationUiTests(): Promise<void> {
  installProviderBrowserHost();
  const host = document.body.createDiv({ cls: "echoink-settings-demo echoink-settings-aligned" });
  const plugin = { settings: { settingsLanguage: "zh", generationTemplates: defaultGenerationTemplates() }, saves: 0, failSave: false,
    async saveSettings() { this.saves++; if (this.failSave) throw new Error("测试保存失败"); } };
  let editor = false;
  const draw = () => { disposeOriginControls(host); host.empty(); if (editor) section.renderEditor(host); else section.renderDrawer(host); };
  const open = (id: string | null) => { section.open(id); editor = true; draw(); };
  const section = new GenerationTemplatesSection(plugin, { openEditor: open, closeEditor: () => { editor = false; draw(); }, redraw: draw });
  const button = (label: string) => {
    const element = [...host.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent?.trim() === label || item.getAttribute("aria-label") === label);
    assert.ok(element, `button ${label} exists`); return element;
  };
  const field = (label: string, value: string) => {
    const input = host.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[aria-label="${label}"]`)!;
    assert.ok(input); input.value = value; input.dispatchEvent(new Event("input", { bubbles: true })); return input;
  };
  const flush = async () => { for (let count = 0; count < 4; count++) await new Promise(resolve => setTimeout(resolve, 0)); };
  draw();
  assert.equal(host.querySelector('[role="switch"]'), null, "generation templates have no enable switch");
  assert.equal(host.querySelector<HTMLElement>(".echoink-generation-template-list")!.hidden, true);
  button("生成模板4 个模板").click();
  assert.equal(host.querySelector<HTMLElement>(".echoink-generation-template-list")!.hidden, false);
  assert.equal(host.querySelectorAll(".echoink-generation-template-row").length, 4);
  for (const row of host.querySelectorAll(".echoink-generation-template-row")) assert.ok(row.lastElementChild?.classList.contains("echoink-settings-navigation-trailing"), "arrow stays at the right edge");
  button("新增模板").click();
  assert.equal(host.querySelector(".modal-container"), null, "editor stays inside settings");
  button("保存").click();
  assert.equal(plugin.saves, 0);
  assert.match(host.textContent!, /名称不能为空/); assert.match(host.textContent!, /写作要求不能为空/);
  field("名称", "简报"); field("写作要求", "按时间线写作"); button("保存").click();
  assert.equal(plugin.saves, 0); assert.match(host.textContent!, /已有同名模板/);
  field("名称", "时间线"); field("说明", "按时间整理");
  button("Canvas 导图").click(); await flush();
  assert.equal(host.querySelector<HTMLElement>(".echoink-generation-output-segments")!.dataset.outputKind, "canvas");
  assert.equal(button("Canvas 导图").getAttribute("data-state"), "checked", "real Origin radio selected state is retained");
  draw(); assert.equal(host.querySelector<HTMLInputElement>('[aria-label="名称"]')!.value, "时间线", "draft survives settings redraw");
  button("保存").click(); await flush();
  assert.equal(plugin.saves, 1); assert.equal(editor, false);
  const custom = plugin.settings.generationTemplates.find(item => item.name === "时间线")!;
  assert.equal(custom.outputKind, "canvas"); assert.equal(custom.instructions, "按时间线写作");
  open(custom.id); button("复制").click();
  assert.equal(host.querySelector<HTMLInputElement>('[aria-label="名称"]')!.value, "时间线 2");
  button("保存").click(); await flush(); assert.equal(plugin.settings.generationTemplates.length, 6);
  open(custom.id); button("删除").click();
  assert.equal(plugin.settings.generationTemplates.length, 6, "delete requires inline confirmation");
  const confirmation = host.querySelector<HTMLElement>(".echoink-settings-inline-confirm")!;
  const deleteConfirmation = Array.from(confirmation.querySelectorAll<HTMLButtonElement>("button")).find(item => item.textContent?.trim() === "删除")!;
  assert.equal(deleteConfirmation.classList.contains("settings-danger"), true, "delete confirmation retains its danger styling by default");
  assert.equal(deleteConfirmation.classList.contains("echoink-delete-button"), true, "delete confirmation retains Delete Shake styling");
  assert.ok(confirmation); [...confirmation.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent?.trim() === "取消")!.click();
  assert.equal(plugin.settings.generationTemplates.length, 6);
  button("删除").click(); host.querySelector<HTMLButtonElement>(".echoink-settings-inline-confirm .settings-danger")!.click(); await flush();
  assert.equal(plugin.settings.generationTemplates.some(item => item.id === custom.id), false);
  open("brief"); assert.equal([...host.querySelectorAll("button")].some(item => item.textContent?.trim() === "删除"), false);
  field("写作要求", "修改后的要求"); button("保存").click(); await flush();
  open("brief"); button("恢复默认").click();
  assert.equal(plugin.settings.generationTemplates[0].instructions, "修改后的要求");
  const restoreConfirmation = Array.from(host.querySelectorAll<HTMLButtonElement>(".echoink-settings-inline-confirm button")).find(item => item.textContent?.trim() === "恢复")!;
  assert.ok(restoreConfirmation);
  assert.equal(restoreConfirmation.classList.contains("settings-danger"), false, "restore confirmation is not a danger action");
  assert.equal(restoreConfirmation.classList.contains("echoink-delete-button"), false, "restore confirmation has no Delete Shake styling");
  restoreConfirmation.click(); await flush();
  assert.equal(plugin.settings.generationTemplates[0].instructions, defaultGenerationTemplates()[0].instructions);
  assert.equal(host.querySelector<HTMLTextAreaElement>("textarea")!.value, defaultGenerationTemplates()[0].instructions);
  field("写作要求", "保存失败仍保留草稿"); plugin.failSave = true; button("保存").click(); await flush();
  assert.match(host.textContent!, /保存失败：测试保存失败/);
  assert.equal(host.querySelector<HTMLTextAreaElement>("textarea")!.value, "保存失败仍保留草稿");
  assert.equal(plugin.settings.generationTemplates[0].instructions, defaultGenerationTemplates()[0].instructions, "failed settings persistence rolls back the unsaved record");
  disposeOriginControls(host); host.remove();
}

export async function runGenerationModalTests(): Promise<void> {
  const flush = async () => { for (let count = 0; count < 5; count++) await new Promise(resolve => setTimeout(resolve, 0)); };
  const turnOptions: TurnOptions = { providerSettingsId: "test", runtimeProviderId: "test", model: "test", reasoning: "none", permission: "workspace-write", mode: "agent", mcpEnabled: false };
  let outputError = "", assessError = "", submitError = "";
  const recommendations: { paths: readonly string[]; sessionId?: string; signal?: AbortSignal; resolve(value: GenerationTemplate[]): void; reject(error: Error): void }[] = [];
  const submitted: { paths: string[]; template: GenerationTemplate }[] = [];
  const routes: unknown[] = [];
  let settingsOpens = 0, failTemplateSave = false;
  const settings = { settingsLanguage: "zh", generationTemplates: defaultGenerationTemplates() };
  const files = ["Raw/甲.md", "外部/世界模型.md", "Outputs/报告/不应添加.md"].map(path => ({ path, name: path.split("/").at(-1)! }));
  const app = { vault: { getMarkdownFiles: () => files }, metadataCache: { getFileCache: () => ({ frontmatter: {} }) },
    setting: { open() { settingsOpens++; }, openTabById() {} }, keymap: { pushScope() {}, popScope() {} } };
  const plugin = { app, settings, manifest: { id: "echoink" }, prepareDesktopSettingsRoute(route: unknown) { routes.push(route); }, applyAppearanceTheme() {},
    async saveSettings() { if (failTemplateSave) throw new Error("测试模板保存失败"); } } as unknown as EchoInkPlugin;
  const service: GenerationModalService = {
    availableNotes: () => files.filter(file => !file.path.startsWith("Outputs/")).map(file => file.path),
    async assessSources(paths) { return { sources: paths.map(path => ({ path, content: "测试资料", bytes: 12 })), totalBytes: paths.length * 12, readFailures: [], ...(assessError ? { error: assessError } : {}) }; },
    disabledReason: input => input.mode === "plan" ? "请切换到 Agent 模式后生成。" : input.permission === "read-only" ? "请切换到可写权限后生成。" : outputError || null,
    createRequest: (template, paths) => ({ version: 1, id: "request", createdAt: new Date().toISOString(), template: { ...template }, sourcePaths: [...paths], outputKind: template.outputKind, outputRoot: "Outputs", outputDirectory: `Outputs/${template.outputKind === "canvas" ? "导图" : "报告"}` }),
    outputDirectory: kind => { if (outputError) throw new Error(outputError); return `Outputs/${kind === "canvas" ? "导图" : "报告"}`; },
    recommend: (paths, signal, sessionId) => new Promise((resolve, reject) => { recommendations.push({ paths: [...paths], signal, sessionId, resolve, reject }); })
  };
  const open = (paths: string[] = ["Raw/甲.md"], sessionId: string | null = "task-1", templateId?: string) => {
    const modal = new GenerationModal(plugin, { sourcePaths: paths, service, sessionId: sessionId ?? undefined, templateId, turnOptions: () => turnOptions,
      onSubmit: async request => { if (submitError) throw new Error(submitError); submitted.push({ paths: request.sourcePaths, template: request.template }); } });
    modal.open(); return modal;
  };
  const button = (modal: GenerationModal, label: string) => {
    const element = [...modal.contentEl.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent?.trim() === label || item.getAttribute("aria-label") === label);
    assert.ok(element, `modal button ${label} exists`); return element;
  };
  const temporary = (name: string): GenerationTemplate[] => [1, 2].map(index => ({ id: `temp-${name}-${index}`, name: `${name}${index}`, description: "推荐说明", instructions: "推荐写作要求", outputKind: "markdown" }));
  let modal = open(); await flush();
  assert.equal(recommendations.length, 0, "opening the modal never requests recommendations");
  assert.equal(button(modal, "生成").disabled, false);
  button(modal, "更改").click(); button(modal, "添加笔记").click();
  const search = modal.contentEl.querySelector<HTMLInputElement>('[aria-label="搜索笔记"]')!;
  search.value = "shijie"; search.dispatchEvent(new Event("input", { bubbles: true }));
  assert.match(modal.contentEl.querySelector(".echoink-generation-note-results")!.textContent!, /世界模型/);
  assert.doesNotMatch(modal.contentEl.querySelector(".echoink-generation-note-results")!.textContent!, /不应添加/);
  search.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); await flush();
  assert.match(modal.contentEl.textContent!, /已选 2 篇笔记/);
  button(modal, "让 AI 推荐模板").click();
  assert.equal(recommendations.length, 1); assert.equal(recommendations[0].sessionId, "task-1");
  assert.deepEqual(recommendations[0].paths, ["Raw/甲.md", "外部/世界模型.md"]);
  button(modal, "Raw/甲.md").click(); await flush();
  assert.equal(recommendations[0].signal!.aborted, true);
  recommendations[0].resolve(temporary("过期")); await flush();
  assert.doesNotMatch(modal.contentEl.textContent!, /过期1/, "source changes invalidate late recommendations");
  turnOptions.permission = "read-only";
  modal.close(); modal = open(); await flush();
  assert.equal(button(modal, "生成").disabled, true); assert.match(modal.contentEl.textContent!, /可写权限/);
  assert.equal(button(modal, "让 AI 推荐模板").disabled, false, "read-only mode may request recommendations");
  button(modal, "让 AI 推荐模板").click(); recommendations[1].reject(new Error("测试推荐失败")); await flush();
  assert.match(modal.contentEl.querySelector(".echoink-generation-recommend-status")!.textContent!, /测试推荐失败/);
  assert.equal(button(modal, "简报").getAttribute("data-state"), "checked", "recommendation failure retains ordinary selection");
  button(modal, "让 AI 推荐模板").click(); recommendations[2].resolve(temporary("推荐")); await flush();
  button(modal, "推荐1").click(); await flush(); assert.equal(button(modal, "推荐1").getAttribute("data-state"), "checked");
  assert.match(modal.contentEl.querySelector(".echoink-generation-template-card-instructions")!.textContent!, /推荐写作要求/);
  assert.equal(settings.generationTemplates.length, 4, "temporary cards never persist");
  modal.close(); turnOptions.permission = "workspace-write";
  modal = open([], null); await flush();
  assert.equal(button(modal, "生成").disabled, true); assert.match(modal.contentEl.textContent!, /暂无资料/);
  modal.close(); assessError = "资料太多，请缩小范围"; modal = open(); await flush();
  assert.equal(button(modal, "生成").disabled, true); assert.match(modal.contentEl.textContent!, /资料太多/);
  modal.close(); assessError = ""; outputError = "输出目录已失效，请重新绑定"; modal = open(); await flush();
  assert.equal(button(modal, "生成").disabled, true); assert.match(modal.contentEl.textContent!, /输出目录已失效/);
  modal.close(); outputError = ""; turnOptions.mode = "plan"; modal = open(); await flush();
  assert.equal(button(modal, "生成").disabled, true); assert.match(modal.contentEl.textContent!, /Agent 模式/);
  modal.close(); turnOptions.mode = "agent"; submitError = "测试提交失败"; modal = open(["Raw/甲.md"], null, "mind"); await flush();
  button(modal, "生成").click(); await flush();
  assert.match(modal.contentEl.textContent!, /测试提交失败/); assert.equal(button(modal, "思维导图").getAttribute("data-state"), "checked");
  assert.match(modal.contentEl.textContent!, /已选 1 篇笔记/);
  button(modal, "编辑模板「思维导图」").click();
  assert.deepEqual(routes.at(-1), { tab: "modules", section: "knowledgeBase", focus: "knowledge:generation-template:mind" }); assert.equal(settingsOpens, 1);
  modal = open(); await flush(); assert.equal(button(modal, "简报").getAttribute("data-state"), "checked", "reopening does not revive old selections");
  submitError = ""; button(modal, "自制格式").click();
  const customInput = modal.contentEl.querySelector<HTMLTextAreaElement>('[aria-label="自制格式写作要求"]')!;
  customInput.value = "按时间线写"; customInput.dispatchEvent(new Event("input", { bubbles: true }));
  button(modal, "存为模板").click();
  settings.generationTemplates.push({ id: "already", name: "我的格式", description: "", instructions: "原要求", outputKind: "markdown" });
  button(modal, "生成").click(); await flush();
  assert.equal(settings.generationTemplates.at(-1)!.name, "我的格式 2"); assert.equal(submitted.at(-1)!.template.instructions, "按时间线写");
  failTemplateSave = true; modal = open(); await flush(); button(modal, "自制格式").click();
  const nextInput = modal.contentEl.querySelector<HTMLTextAreaElement>('[aria-label="自制格式写作要求"]')!;
  nextInput.value = "继续生成"; nextInput.dispatchEvent(new Event("input", { bubbles: true })); button(modal, "存为模板").click();
  const beforeSaved = settings.generationTemplates.length; button(modal, "生成").click(); await flush();
  assert.equal(settings.generationTemplates.length, beforeSaved, "failed template save is independent from generation");
  assert.equal(submitted.at(-1)!.template.instructions, "继续生成"); failTemplateSave = false;
  modal = open(["Raw/甲.md"], null); await flush(); button(modal, "让 AI 推荐模板").click();
  assert.equal(recommendations.at(-1)!.sessionId, undefined, "file entry uses the knowledge owner rather than a current-task id");
  modal.close(); assert.equal(recommendations.at(-1)!.signal!.aborted, true); recommendations.at(-1)!.resolve(temporary("已取消")); await flush();
  assert.equal(document.querySelector(".echoink-generation-modal"), null, "cancelled recommendation cannot reopen or alter a modal");
}

export function runGenerationComposerEntryTests(): void {
  const panel = document.body.createDiv(); let opens = 0;
  const state = { open: true, selectedSkill: null, selectedMode: "agent" as const, resources: [], resourceSettings: { mcpConnections: {} }, language: "zh-CN" as const, canAttachActiveFile: false };
  const callbacks = { onDismiss() {}, onPickFiles() {}, onAttachActiveFile() {}, onSelectPlanMode() {}, onSelectSkill() {}, onOpenMcpSettings() {}, onGenerateFromSources() { opens++; } };
  Object.assign(Platform, { isDesktopApp: true });
  renderComposerResourcePanel(panel, state, callbacks);
  const generate = [...panel.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent?.includes("从资料生成"))!;
  assert.ok(generate.closest(".codex-composer-resource-group")?.textContent?.includes("添加")); generate.click(); assert.equal(opens, 1);
  renderComposerResourcePanel(panel, { ...state, generationEntryReason: "等这一轮结束。" }, callbacks);
  const disabled = [...panel.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent?.includes("从资料生成"))!;
  assert.equal(disabled.disabled, true); disabled.click(); assert.equal(opens, 1); assert.match(disabled.textContent!, /等这一轮结束/);
  Object.assign(Platform, { isDesktopApp: false }); renderComposerResourcePanel(panel, state, callbacks); assert.doesNotMatch(panel.textContent!, /从资料生成/);
  Object.assign(Platform, { isDesktopApp: true });
  const input = document.body.createEl("textarea"); const menu = document.body.createDiv({ attr: { id: "generation-slash" } }); let chosen = "", commands = "";
  const templates = defaultGenerationTemplates(); templates[0].name = "提问";
  const slashCallbacks = { onFillCommand(command: string) { commands = command; }, onSelectSkill() {}, onSelectGenerationTemplate(template: GenerationTemplate) { chosen = template.id; } };
  renderKnowledgeCommandMatches(menu, input, "", { language: "zh-CN", skills: [], selectedSkill: null, generationTemplates: templates }, slashCallbacks);
  assert.match(menu.textContent!, /生成·提问/); assert.match(menu.textContent!, /\/ask/); assert.match(menu.textContent!, /\/maintain/);
  handleKnowledgeCommandMenuKeyDown(new KeyboardEvent("keydown", { key: "Enter" }), input, menu); assert.equal(commands.trim(), "/ask", "existing command keyboard behavior is preserved");
  renderKnowledgeCommandMatches(menu, input, "思维", { skills: [], selectedSkill: null, generationTemplates: templates }, slashCallbacks);
  handleKnowledgeCommandMenuKeyDown(new KeyboardEvent("keydown", { key: "Enter" }), input, menu); assert.equal(chosen, "mind");
  chosen = ""; renderKnowledgeCommandMatches(menu, input, "思维", { skills: [], selectedSkill: null, generationTemplates: templates, generationEntryReason: "等这一轮结束。" }, slashCallbacks);
  handleKnowledgeCommandMenuKeyDown(new KeyboardEvent("keydown", { key: "Enter" }), input, menu); assert.equal(chosen, ""); assert.match(menu.textContent!, /等这一轮结束/);
  panel.remove(); input.remove(); menu.remove();
}

/** Receives the production registration function extracted by the runner, not a copy. */
export async function runGenerationFileMenuTests(register: (plugin: unknown) => void, File: new (path: string) => { path: string }, Folder: new (path: string) => { path: string }): Promise<void> {
  let registered = 0, activated = 0;
  let onFileMenu: (menu: unknown, file: unknown) => void = () => { throw new Error("File menu was not registered"); };
  const opened: string[] = [];
  const plugin = {
    settings: { knowledgeBase: { folderBindings: { roles: { outputs: { readPaths: ["Outputs"] } } } } },
    app: { workspace: { on(name: string, callback: typeof onFileMenu) { assert.equal(name, "file-menu"); onFileMenu = callback; return {}; } } },
    registerEvent() { registered++; }, async activateView() { activated++; },
    getCodexView() { return { async waitForTaskUiReady() { return true; }, openGenerationForPath(path: string) { opened.push(path); } }; },
    generationService: { sourcesFromPath(path: string) { return [path]; } }
  };
  Object.assign(Platform, { isDesktopApp: false }); register(plugin); assert.equal(registered, 0, "mobile has no file-menu registration");
  Object.assign(Platform, { isDesktopApp: true }); register(plugin); assert.equal(registered, 1);
  const menuFor = (file: unknown) => {
    const items: { title: string; callback?: () => void }[] = [];
    onFileMenu({ addItem(build: (item: unknown) => void) {
      const value: { title: string; callback?: () => void } = { title: "" };
      const item = { setTitle(title: string) { value.title = title; return item; }, setIcon() { return item; }, onClick(callback: () => void) { value.callback = callback; return item; } };
      build(item); items.push(value);
    } }, file);
    return items;
  };
  for (const file of [new File("Raw/a.pdf"), new File("Raw/a.canvas"), new File(".hidden/a.md"), new Folder(".hidden"), new Folder("Outputs"), new Folder("Outputs/报告"), new File("Outputs/报告/a.md")]) assert.equal(menuFor(file).length, 0, `${file.path} has no generation entry`);
  const markdown = menuFor(new File("Raw/甲.md")); assert.equal(markdown.length, 1); assert.equal(markdown[0].title, "用 EchoInk 生成…");
  const emptyFolder = menuFor(new Folder("Empty")); assert.equal(emptyFolder.length, 1, "empty folder can open the modal's empty state");
  markdown[0].callback!(); for (let count = 0; count < 3; count++) await Promise.resolve();
  assert.equal(activated, 1); assert.deepEqual(opened, ["Raw/甲.md"]);
}
