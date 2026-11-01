import { Notice, TFolder, setIcon, type EventRef, type Modal } from "obsidian";
import type CodexForObsidianPlugin from "../main";
import { emptyKnowledgeFolderBindings, normalizeKnowledgeFolderBindings, KNOWLEDGE_COLLECTION_LABELS, knowledgeCollectionLabel, knowledgeCollectionKinds, knowledgeCollectionTargets, knowledgeCollectionDirectory, knowledgeOrganizationSettings, pathInKnowledgeDirectory, rebaseKnowledgeFolderBindings, type KnowledgeFolderBindings } from "../knowledge-base/folder-bindings";
import { knowledgeOrganizationSelectable } from "../knowledge-base/folder-organization";
import { rebaseKnowledgePath } from "../knowledge-base/root-paths-core";
import type { KnowledgeDirectoryMode, KnowledgeDirectoryPlan, KnowledgeModuleDirectories } from "../knowledge-base/folder-plan";
import { readNativeJournalSettings } from "../home/native-journal";
import { TODO_SOURCE_PATH } from "../home/todo-store";
import { OriginSetting } from "./origin-setting";
import { createOriginButton, createOriginInput, createOriginCheck, createOriginSelect, disposeOriginControls } from "./origin-controls";
import { createSettingsPage, createSettingsNavigationRow, replaceSettingsNavigationRow, createSettingsSection, createSettingsGroup, attachSettingsHelpTooltip, showSettingsInlineConfirmation } from "./settings-v2";
import { renderKnowledgeFolderActions } from "./knowledge-folder-actions";
import { renderKnowledgeLinkingSection } from "./knowledge-linking-section";
import { applyDeleteButton } from "./amicro-buttons";
import { createKnowledgeFolderPicker, type KnowledgeFolderChoice, type KnowledgeFolderPicker } from "./knowledge-folder-picker";
import { initializationFolderTree, renderInitializationFolderTree } from "./knowledge-initialization-tree";
import { initializationFolderIssues, type InitializationFolderField } from "../knowledge-base/initialization-choices";

type Role = "raw" | "wiki" | "projects" | "inbox";
const titles: Record<Role, string> = { raw: "资料来源", wiki: "知识成果", projects: "项目", inbox: "收件箱" };
const purposeExplanations: Record<Role, string> = {
  raw: "选择 Agent 可以读取的资料文件夹",
  wiki: "保存提炼后的主题知识；选择一个文件夹，Agent 在里面按主题建分类",
  projects: "保存项目型知识",
  inbox: "保存临时笔记"
};
type Page = "sources" | "role" | "initialize" | "initialize-preview" | "picker" | "collections" | "permissions" | "management" | null;

/** Desktop presentation only. All writes use the existing directory service. */
export class DesktopKnowledgeSettings {
  private page: Page = null;
  private linkingCleanup: (() => void) | null = null;
  private linkingTaskId?: string;
  private locateLinking = false;
  openLinking(taskId?: string): void { this.linkingTaskId = taskId; this.locateLinking = true; this.change("permissions"); }
  private selectedRole: Role = "wiki";
  private host: HTMLElement | null = null;
  private error = "";
  private busy = false;
  private picker: { title: string; role?: Role; onChoose: (path: string) => Promise<void>; back: Page } | null = null;
  private draft: KnowledgeFolderBindings | null = null;
  private mode: KnowledgeDirectoryMode | null = null;
  private moduleDraft: KnowledgeModuleDirectories = {};
  private wikiChanged = false;
  private plan: KnowledgeDirectoryPlan | null = null;
  private generation = 0;
  private previewing = false;
  private events: EventRef[] = [];
  private choices: Record<string, KnowledgeFolderChoice[]> = {};
  private previewTimer?: number;
  private folderPickers: KnowledgeFolderPicker[] = [];
  private initializationParent: "management" | null = null;
  private returnFocusKey: string | null = null;
  constructor(private readonly plugin: CodexForObsidianPlugin, private readonly navigation: {
    redraw(): void; openPreferences(): void; openLinking(): void; openEditor(editor: Modal): void;
  }) {}
  open(target: "sources" | "initialize" | "collections" | "permissions" | "management"): void {
    if (target === "initialize") this.initializationParent = null;
    this.change(target);
  }
  navigationKey(): string | null { return this.page === null ? null : `${this.page}:${this.page === "role" ? this.selectedRole : this.page === "picker" ? this.picker?.title ?? "" : ""}`; }
  get isDetail(): boolean { return this.page !== null; }
  get hasDraft(): boolean { return this.draft !== null && this.mode !== null; }
  get submitting(): boolean { return this.busy; }
  followFolderRename(from: string, to: string): void {
    if (!this.draft) return;
    this.draft = rebaseKnowledgeFolderBindings(this.draft, from, to);
    for (const values of Object.values(this.choices)) for (const value of values) value.path = rebaseKnowledgePath(value.path, from, to);
    for (const key of Object.keys(this.moduleDraft) as (keyof KnowledgeModuleDirectories)[]) {
      const value = this.moduleDraft[key];
      if (value) this.moduleDraft[key] = rebaseKnowledgePath(value, from, to);
    }
    this.invalidatePlan();
  }
  private bindings(): KnowledgeFolderBindings { return normalizeKnowledgeFolderBindings(this.plugin.settings.knowledgeBase.folderBindings) ?? emptyKnowledgeFolderBindings(); }
  private service() { const service = this.plugin.getKnowledgeSurfaceService(); if (!service) throw new Error("目录服务尚未就绪，请稍后重试"); return service; }
  private change(page: Page): void { this.page = page; this.error = ""; this.navigation.redraw(); }
  private restoreReturnFocus(parent: HTMLElement): void {
    if (!this.returnFocusKey) return;
    const target = parent.querySelector<HTMLElement>(`[data-echoink-focus-key="${this.returnFocusKey}"]`);
    if (!target) return;
    this.returnFocusKey = null;
    queueMicrotask(() => { if (target.isConnected) target.focus({ preventScroll: true }); });
  }
  private back(): void {
    if (this.busy) return;
    if (this.page === "initialize-preview") { this.change("initialize"); return; }
    if (this.page === "picker") {
      this.returnFocusKey = this.picker?.role === "raw" ? "knowledge:sources:add" : "knowledge:role:picker";
      this.change(this.picker?.back ?? null); return;
    }
    const current = this.page;
    const parent = current === "initialize" ? this.initializationParent : null;
    const focusKey = parent === "management" ? "knowledge:onboarding" : current === "sources" ? "knowledge:directory:raw" : current === "role" ? `knowledge:directory:${this.selectedRole}` : current === "initialize" ? "knowledge:management" : `knowledge:${current}`;
    this.requestLeave(() => { this.page = parent; this.returnFocusKey = focusKey; this.navigation.redraw(); });
  }
  requestLeave(done: () => void): void {
    if (this.busy) return;
    this.reset(); this.page = null; done();
  }
  private reset(): void { this.draft = null; this.mode = null; this.moduleDraft = {}; this.choices = {}; this.wikiChanged = false; this.plan = null; this.previewing = false; this.error = ""; this.generation++; }
  suspend(): void {
    this.linkingCleanup?.(); this.linkingCleanup = null;
    if (this.previewTimer !== undefined) window.clearTimeout(this.previewTimer);
    this.previewTimer = undefined;
    this.events.splice(0).forEach(ref => this.plugin.app.vault.offref(ref));
    this.folderPickers.splice(0).forEach(picker => picker.dispose());
    this.host = null;
  }
  dispose(): void { this.suspend(); }
  private help(parent: HTMLElement, hint: string): void {
    const help = createOriginButton(parent, { cls: "is-icon echoink-settings-help-trigger echoink-knowledge-help-trigger", attr: { "aria-label": hint } });
    setIcon(help, "circle-alert"); attachSettingsHelpTooltip(help, hint);
  }
  private checkbox(parent: HTMLElement, title: string, checked: boolean, hint: string, save: (value: boolean) => Promise<void>): OriginSetting {
    const row = new OriginSetting(parent).setName(title);
    this.help(row.nameEl, hint);
    const check = createOriginCheck(row.controlEl, { attr: { "aria-label": title } }); check.checked = checked; let accepted = checked;
    check.onchange = () => { const next = check.checked; check.disabled = true; void save(next).then(() => { accepted = next; }).catch(error => { check.checked = accepted; new Notice(error instanceof Error ? error.message : String(error)); }).finally(() => { check.disabled = false; }); };
    return row;
  }
  private async save(next: KnowledgeFolderBindings, wikiChanged = false): Promise<void> {
    if (this.busy) throw new Error("正在保存，请稍后重试");
    this.busy = true;
    try { await this.service().saveDirectoryBindings(next, { wikiChanged }); this.error = ""; }
    catch (error) { this.error = `绑定未保存，仍使用原目录：${error instanceof Error ? error.message : String(error)}`; throw error; }
    finally { this.busy = false; }
  }
  renderSummary(parent: HTMLElement): HTMLElement {
    const bindings = this.bindings();
    const folders = createSettingsSection(parent, { surface: "flat" });
    for (const role of ["raw", "wiki", "projects", "inbox"] as const) {
      const binding = bindings.roles[role];
      const invalid = binding.readPaths.some(path => !(this.plugin.app.vault.getAbstractFileByPath(path) instanceof TFolder));
      const configured = binding.enabled && binding.readPaths.length > 0;
      const status = invalid ? " · 文件夹不存在" : "";
      const suffix = `${binding.readPaths.length > 1 ? `等 ${binding.readPaths.length} 个` : ""}${status}`.trim();
      const row = createSettingsNavigationRow(folders, { title: titles[role], value: configured ? binding.readPaths[0] : binding.enabled ? "未配置" : "未启用", valueSuffix: configured && suffix ? suffix : undefined, valueDescription: configured ? `${binding.readPaths.join("、")}${status}` : undefined, explanation: purposeExplanations[role], focusKey: `knowledge:directory:${role}`, onActivate: () => role === "raw" ? this.change("sources") : this.openRole(role) });
      row.addClass("echoink-knowledge-purpose-row");
      row.querySelector<HTMLElement>(".echoink-settings-navigation-title")?.createSpan({ cls: "echoink-knowledge-purpose-commands", text: role === "inbox" ? "召回" : "/ask /maintain 召回" });
    }
    for (const [target, title] of [["collections", "收藏保存位置"], ["permissions", "Agent 权限与维护"], ["management", "目录管理"]] as const) {
      createSettingsNavigationRow(folders, { title, focusKey: `knowledge:${target}`, onActivate: () => this.change(target) });
    }
    if (this.error) parent.createDiv({ cls: "settings-error", text: this.error, attr: { role: "alert" } });
    this.restoreReturnFocus(parent);
    return folders;
  }
  private renderCollections(page: HTMLElement): void {
    const bindings = this.bindings();
    page.querySelector(".echoink-settings-page-heading")?.createDiv({ cls: "echoink-settings-page-description", text: "EchoInk 收藏或导入的资料存到这里；不影响你自己新建的笔记，修改不会移动已有文件。" });
    const targets = createSettingsGroup(createSettingsSection(page, { surface: "flat" }));
    targets.addClass("echoink-knowledge-collection-fields");
    const saved = knowledgeCollectionTargets(bindings);
    for (const key of knowledgeCollectionKinds(bindings)) {
      const title = knowledgeCollectionLabel(key, bindings);
      const row = new OriginSetting(targets).setName(title);
      row.settingEl.dataset.collectionKind = key;
      const picker = createKnowledgeFolderPicker(row.controlEl, { label: `${title}保存位置`,
        folders: () => { const roots = this.bindings().roles.raw.readPaths; return this.plugin.app.vault.getAllFolders(false).map(folder => folder.path).filter(path => roots.some(root => pathInKnowledgeDirectory(path, root))); },
        values: saved[key] ? [{ path: saved[key], create: false }] : [], multiple: false, required: true, allowCreate: false, app: this.plugin.app,
        onChange: values => {
          const next = this.bindings(); next.collectionTargets = knowledgeCollectionTargets(next); next.collectionTargets[key] = values[0]?.path ?? null;
          picker.setDisabled(true);
          void this.save(next).catch(error => new Notice(error instanceof Error ? error.message : String(error))).finally(() => this.navigation.redraw());
        }
      });
      this.folderPickers.push(picker);
      const missing = saved[key] && !(this.plugin.app.vault.getAbstractFileByPath(saved[key]) instanceof TFolder);
      if (!knowledgeCollectionDirectory(bindings, key) || missing) picker.setError(missing ? "文件夹不存在，请重新选择" : "请重新选择资料来源文件夹");
    }
  }
  private renderPermissions(page: HTMLElement): void {
    const bindings = this.bindings();
    const permissions = createSettingsGroup(createSettingsSection(page, { surface: "flat" }));
    this.renderOrganizationPermission(permissions, bindings);
    this.checkbox(permissions, "自动补链", this.plugin.settings.knowledgeBase.autoLinkEnabled !== false, "新知识写入后，给本批笔记和相关老笔记补全双链。关闭后不再发起自动补链，已开始的写入会完成；仍可手动补全。", async value => {
      const previous = this.plugin.settings.knowledgeBase.autoLinkEnabled; this.plugin.settings.knowledgeBase.autoLinkEnabled = value;
      try { await this.plugin.saveSettings(true); } catch (error) { this.plugin.settings.knowledgeBase.autoLinkEnabled = previous; throw error; }
    });
    const preferenceOptions = { title: "知识提炼偏好", focusKey: "knowledge:preferences", onActivate: () => this.navigation.openPreferences() };
    let preference = createSettingsNavigationRow(permissions, { ...preferenceOptions, description: "正在读取偏好…" });
    const showPreference = (value?: string, error?: string) => {
      preference = replaceSettingsNavigationRow(preference, { ...preferenceOptions, description: error, value });
    };
    if (typeof this.plugin.getEchoInkKnowledgeMaintenancePreferenceState === "function") {
      void this.plugin.getEchoInkKnowledgeMaintenancePreferenceState().then(state => { showPreference(state.state === "custom" ? "已自定义" : "使用默认"); })
        .catch(() => { showPreference(undefined, "知识提炼偏好读取失败"); });
    } else showPreference(undefined, "知识提炼偏好状态暂不可用");
    this.linkingCleanup = renderKnowledgeLinkingSection(permissions, this.plugin, this.linkingTaskId, this.locateLinking);
    this.locateLinking = false;
    this.linkingTaskId = undefined;
  }
  private renderOrganizationPermission(parent: HTMLElement, bindings: KnowledgeFolderBindings): void {
    let accepted = knowledgeOrganizationSettings(bindings);
    let saving = false;
    let picker: KnowledgeFolderPicker | null = null;
    const checkRow = this.checkbox(parent, "允许 Agent 分类整理", accepted.enabled, "Agent 可以在允许的文件夹里新建子文件夹，把文件归类挪进去；不删除文件，也不挪出原来的根文件夹；整理前会先给你看方案。", async enabled => {
      await persist({ ...accepted, enabled });
    });
    const check = checkRow.controlEl.querySelector<HTMLInputElement | HTMLButtonElement>('input, [role="checkbox"]')!;
    const rangeRow = new OriginSetting(parent).setName("范围");
    rangeRow.settingEl.addClass("echoink-knowledge-organization-range");
    const controls = rangeRow.controlEl.createDiv({ cls: "echoink-knowledge-organization-controls" });
    const scope = createOriginSelect(controls, { attr: { "aria-label": "分类整理范围" } }, [
      { value: "all", label: "全部文件夹" }, { value: "selected", label: "选定的文件夹" }
    ], accepted.scope, this.plugin.app).element;
    const selectionError = () => {
      const current = this.bindings();
      const invalid = accepted.paths.filter(path => !(this.plugin.app.vault.getAbstractFileByPath(path) instanceof TFolder) || !knowledgeOrganizationSelectable(current, path));
      return invalid.length ? `文件夹不存在或已不在允许范围内，请移除后重新选择：${invalid.join("、")}` : accepted.paths.length ? "" : "请至少选择一个文件夹";
    };
    const syncDisabled = () => {
      check.disabled = saving;
      scope.disabled = saving || !accepted.enabled;
      picker?.setDisabled(saving || !accepted.enabled);
    };
    const persist = async (organization: typeof accepted) => {
      if (saving) throw new Error("正在保存，请稍后重试");
      saving = true; syncDisabled();
      try {
        const next = this.bindings(); next.organization = organization;
        await this.save(next);
        accepted = knowledgeOrganizationSettings(this.bindings());
      } finally { saving = false; syncDisabled(); }
    };
    const renderSelection = () => {
      if (picker) {
        const previous = picker;
        this.folderPickers = this.folderPickers.filter(item => item !== previous);
        previous.dispose(); picker = null;
      }
      if (accepted.scope !== "selected") return;
      picker = createKnowledgeFolderPicker(controls, {
        label: "分类整理文件夹", multiple: true, allowCreate: false, disabled: !accepted.enabled, app: this.plugin.app,
        folders: () => {
          const current = this.bindings();
          return this.plugin.app.vault.getAllFolders(false).map(folder => folder.path).filter(path => knowledgeOrganizationSelectable(current, path));
        },
        values: accepted.paths.map(path => ({ path, create: false })),
        onChange: values => {
          const active = picker!;
          void persist({ ...accepted, paths: values.map(value => value.path) }).then(() => active.setError(selectionError())).catch(error => {
            active.setValues(accepted.paths.map(path => ({ path, create: false })));
            active.setError(error instanceof Error ? error.message : String(error));
          });
        }
      });
      this.folderPickers.push(picker);
      picker.setError(selectionError());
    };
    scope.onchange = () => {
      if (scope.disabled) return;
      const nextScope = scope.value === "selected" ? "selected" : "all";
      void persist({ ...accepted, scope: nextScope }).then(renderSelection).catch(error => {
        scope.value = accepted.scope;
        new Notice(error instanceof Error ? error.message : String(error));
      });
    };
    renderSelection(); syncDisabled();
  }
  private renderManagement(page: HTMLElement): void {
    const bindings = this.bindings();
    const service = this.plugin.getKnowledgeSurfaceService();
    if (service) renderKnowledgeFolderActions(page, service, this.plugin.settings.settingsLanguage, async () => this.navigation.redraw(), group => {
      createSettingsNavigationRow(group, { title: bindings.configured ? "重新初始化" : "初始化文件夹", focusKey: "knowledge:onboarding", onActivate: () => { this.reset(); this.initializationParent = "management"; this.change("initialize"); } });
    }, editor => this.navigation.openEditor(editor));
  }
  renderDetail(container: HTMLElement): void {
    this.suspend();
    const title = this.page === "sources" ? "资料来源" : this.page === "role" ? titles[this.selectedRole] : this.page === "picker" ? this.picker?.title ?? "选择文件夹" : this.page === "collections" ? "收藏保存位置" : this.page === "permissions" ? "Agent 权限与维护" : this.page === "management" ? "目录管理" : this.page === "initialize-preview" ? "预览" : "初始化文件夹";
    const page = createSettingsPage(container, { title, detail: true, backLabel: this.page === "initialize-preview" ? "返回初始化文件夹" : this.page === "picker" ? "返回" : this.page === "initialize" && this.initializationParent ? "返回目录管理" : "返回模块", onBack: () => this.back() });
    page.addClass("echoink-knowledge-module-page"); this.host = page;
    if (this.error) page.createDiv({ cls: "settings-error", text: this.error, attr: { role: "alert" } });
    if (this.page === "sources") this.renderSources(page);
    else if (this.page === "role") this.renderRole(page);
    else if (this.page === "picker") this.renderPicker(page);
    else if (this.page === "collections") this.renderCollections(page);
    else if (this.page === "permissions") this.renderPermissions(page);
    else if (this.page === "management") this.renderManagement(page);
    else if (this.page === "initialize-preview") this.renderInitializationPreview(page);
    else this.renderInitialization(page);
    this.restoreReturnFocus(page);
  }
  private openRole(role: Role): void { this.selectedRole = role; this.change("role"); }
  private renderRole(page: HTMLElement): void {
    const role = this.selectedRole, bindings = this.bindings(), binding = bindings.roles[role];
    const section = createSettingsSection(page, { title: "文件夹", surface: "flat" });
    const rows = section.createDiv({ cls: "echoink-knowledge-source-list echoink-knowledge-role-group" });
    createSettingsNavigationRow(rows, { title: binding.readPaths.length ? "更改文件夹" : "选择文件夹", focusKey: "knowledge:role:picker", onActivate: () => this.chooseRole(role) });
    if (!binding.enabled) return;
    for (const path of binding.readPaths) this.renderDirectoryEntry(rows, page, role, path);
    const search = createSettingsSection(page, { title: "资料检索", surface: "flat" });
    this.renderSearchPermission(search.createDiv({ cls: "echoink-knowledge-source-list" }), role);
  }
  private renderDirectoryEntry(list: HTMLElement, page: HTMLElement, role: Role, path: string): void {
    const row = list.createDiv({ cls: "echoink-knowledge-source" });
    const pathLabel = row.createDiv({ cls: "echoink-knowledge-source-path" });
    setIcon(pathLabel.createSpan({ cls: "echoink-knowledge-source-icon", attr: { "aria-hidden": "true" } }), "folder");
    pathLabel.createSpan({ text: path });
    const unbind = createOriginButton(row, { cls: "is-icon echoink-knowledge-source-unbind", attr: { "aria-label": `解绑 ${path}` } });
    applyDeleteButton(unbind, { iconOnly: true }); unbind.onclick = () => this.confirmUnbind(page, unbind, role, path);
    if (!(this.plugin.app.vault.getAbstractFileByPath(path) instanceof TFolder)) row.createDiv({ cls: "settings-error", text: "文件夹不存在" });
  }
  private renderSearchPermission(page: HTMLElement, role: Role): void {
    this.checkbox(page, "允许 Agent 检索这些资料", this.bindings().roles[role].searchEnabled !== false, "回答问题时，知识库检索与读取会使用上方所有资料文件夹；关闭后不再使用这些资料，文件、目录绑定和保存位置不变。你主动 @ 引用或提交到聊天的内容除外。此项不授权整理，也不影响 Obsidian 自带搜索。", async enabled => { const next = this.bindings(); next.roles[role].searchEnabled = enabled; await this.save(next); });
  }
  private chooseRole(role: Role): void {
    this.picker = { title: role === "wiki" ? "知识成果 · 请选择一个文件夹" : `选择${titles[role]}文件夹`, role, back: this.page, onChoose: async path => {
      const next = this.bindings(), binding = next.roles[role];
      binding.readPaths = role === "raw" ? [...new Set([...binding.readPaths, path])] : [path];
      binding.writePath = role === "raw" && binding.writePath ? binding.writePath : path; binding.enabled = true; binding.searchEnabled = true;
      await this.save(next, role === "wiki"); this.change(role === "raw" ? "sources" : null);
    } }; this.change("picker");
  }
  private renderPicker(page: HTMLElement): void {
    const picker = this.picker; if (!picker) return;
    const input = createOriginInput(page, { attr: { placeholder: "搜索文件夹", "aria-label": "搜索文件夹" } });
    const list = page.createDiv({ cls: "echoink-knowledge-folder-picker" });
    const render = () => { disposeOriginControls(list); list.empty();
      const folders = this.plugin.app.vault.getAllFolders(false).filter(folder => !folder.path.split("/").some(part => part.startsWith(".")) && folder.path.toLocaleLowerCase().includes(input.value.toLocaleLowerCase())).sort((a, b) => a.path.localeCompare(b.path));
      if (!folders.length) list.createDiv({ cls: "setting-item-description", text: "没有符合条件的文件夹" });
      for (const folder of folders) createSettingsNavigationRow(list, { title: folder.path, actionLabel: "选择", onActivate: () => { if (this.busy) return; void picker.onChoose(folder.path).catch(error => { new Notice(error instanceof Error ? error.message : String(error)); this.navigation.redraw(); }); } });
    }; input.oninput = render; render();
    const role = picker.role;
    if (role && this.bindings().roles[role].enabled && role !== "raw") {
      const unbind = createOriginButton(page, { text: "解绑文件夹", cls: "mod-warning" });
      applyDeleteButton(unbind);
      unbind.onclick = () => this.confirmUnbind(page, unbind, role);
    }
  }
  private confirmUnbind(page: HTMLElement, trigger: HTMLButtonElement, role: Role, path?: string): void {
    showSettingsInlineConfirmation(page, trigger, { deleteAction: true, message: "解绑只解除用途绑定，不会删除目录或笔记。", confirmLabel: "确认解绑", cancelLabel: "取消", onConfirm: async () => {
      const next = this.bindings(), binding = next.roles[role]; binding.readPaths = path ? binding.readPaths.filter(item => item !== path) : [];
      binding.enabled = binding.readPaths.length > 0; binding.writePath = binding.readPaths.includes(binding.writePath ?? "") ? binding.writePath : binding.readPaths[0] ?? null;
      try { await this.save(next);
        if (role === "raw") {
          const affected = knowledgeCollectionKinds(next).filter(kind => !knowledgeCollectionDirectory(next, kind));
          if (affected.length) new Notice(`${affected.map(kind => KNOWLEDGE_COLLECTION_LABELS[kind]).join("、")}的保存位置已失效，请到收藏保存位置重新选择。`);
        }
        this.change(role === "raw" ? "sources" : null); }
      catch { this.navigation.redraw(); }
    } });
  }
  private renderSources(page: HTMLElement): void {
    const section = createSettingsSection(page, { title: "文件夹", surface: "flat" });
    const header = section.querySelector<HTMLElement>(".echoink-settings-section-header")!;
    header.addClass("echoink-knowledge-sources-heading");
    const add = createOriginButton(header, { cls: "is-icon", attr: { "aria-label": "添加来源目录", "data-echoink-focus-key": "knowledge:sources:add" } }); setIcon(add, "plus"); add.onclick = () => this.chooseRole("raw");
    const list = section.createDiv({ cls: "echoink-knowledge-source-list" });
    const bindings = this.bindings(); if (!bindings.roles.raw.readPaths.length) list.createDiv({ cls: "setting-item-description echoink-knowledge-source-empty", text: "还没有资料来源" });
    for (const path of bindings.roles.raw.readPaths) this.renderDirectoryEntry(list, page, "raw", path);
    if (bindings.roles.raw.enabled) {
      const search = createSettingsSection(page, { title: "资料检索", surface: "flat" });
      this.renderSearchPermission(search.createDiv({ cls: "echoink-knowledge-source-list" }), "raw");
    }
  }

  private renderInitialization(page: HTMLElement): void {
    if (!this.mode) {
      const routes = page.createDiv({ cls: "echoink-knowledge-init-routes" });
      for (const [mode, title, description] of [["build", "帮我搭建", "预填默认位置，确认后创建。"], ["existing", "使用现有文件夹", "选择已有位置，只改绑定，不移动文件。"]] as const) {
        const row = createSettingsNavigationRow(routes, { title, description, onActivate: () => {
        this.mode = mode; this.draft = this.bindings(); this.choices = {}; this.moduleDraft = {};
        const core = (this.plugin.app as unknown as { internalPlugins?: { plugins?: Record<string, { instance?: { options?: { folder?: string } } }> } }).internalPlugins?.plugins;
        // Journal/templates are owned by Obsidian; stale shared bindings are not a new directory choice.
        for (const [role, id] of [["journal", "daily-notes"], ["templates", "templates"]] as const) {
          const folder = core?.[id]?.instance?.options?.folder;
          if (typeof folder !== "string") continue;
          const binding = this.draft.roles[role]; binding.native = true; binding.enabled = true;
          binding.readPaths = folder ? [folder] : []; binding.writePath = folder || null;
        }
        if (mode === "build") for (const role of ["raw", "wiki", "projects", "inbox"] as const) { const binding = this.draft.roles[role]; binding.enabled = true; binding.readPaths = [role]; binding.writePath = role; if (role === "wiki") this.wikiChanged = true; }
        this.change("initialize");
        } });
        row.addClass("echoink-knowledge-init-route");
        const icon = row.createSpan({ cls: "echoink-knowledge-init-route-icon", attr: { "aria-hidden": "true" } });
        setIcon(icon, mode === "build" ? "sparkles" : "folder-open"); row.prepend(icon);
      }
      return;
    }
    const route = createOriginButton(page, { text: "换一条路线", cls: "text-button" }); route.onclick = () => this.requestLeave(() => { this.page = "initialize"; this.navigation.redraw(); });
    const bindings = this.draft!;
    const fields = page.createDiv({ cls: "echoink-knowledge-init-fields" });
    const fieldGroup = (title: string) => {
      const section = createSettingsSection(fields, { title, surface: "flat" });
      return section.createDiv({ cls: "echoink-knowledge-init-group" });
    };
    const native = readNativeJournalSettings(this.plugin.app, this.plugin.settings.journalDirectory, bindings);
    const defaults: KnowledgeModuleDirectories = this.mode === "build"
      ? { journal: "journal", review: "outputs", english: "outputs/english-diary", expressions: "outputs/english-diary/expressions", pdfOriginal: "raw/pdf" }
      : { journal: native.available ? native.folder : "", review: "", english: "", expressions: "", pdfOriginal: "" };
    const folders = () => this.plugin.app.vault.getAllFolders(false).map(folder => folder.path)
      .filter(path => !path.split("/").some(part => part.startsWith(".")));
    const formFields: InitializationFolderField[] = [];
    const pickers = new Map<string, KnowledgeFolderPicker>();
    const editing = new Set<string>();
    const addField = (parent: HTMLElement, key: string, title: string, paths: string[], update: (paths: string[]) => void) => {
      const row = new OriginSetting(parent).setName(title);
      this.choices[key] ??= paths.filter(Boolean).map(path => ({ path, create: this.mode === "build" && !folders().includes(path) }));
      formFields.push({ key, title, values: this.choices[key] });
      update(this.choices[key].map(choice => choice.path.trim()).filter(Boolean));
      const picker = createKnowledgeFolderPicker(row.controlEl, { label: `初始化${title}`, folders,
        values: this.choices[key], multiple: key === "raw", required: this.mode === "build" && (key === "raw" || key === "wiki"), app: this.plugin.app,
        onEditingChange: active => { active ? editing.add(key) : editing.delete(key); refresh(); },
        onChange: values => {
          this.choices[key] = values;
          const field = formFields.find(field => field.key === key); if (field) field.values = values;
          update(values.map(choice => choice.path.trim()).filter(Boolean));
          this.invalidatePlan(); refresh(); schedulePreview();
        }
      });
      this.folderPickers.push(picker); pickers.set(key, picker);
    };
    const knowledgeFields = fieldGroup("知识库");
    for (const role of ["raw", "wiki", "projects", "inbox"] as const) {
      addField(knowledgeFields, role, titles[role], bindings.roles[role].readPaths, paths => {
        const binding = bindings.roles[role];
        binding.readPaths = paths; binding.enabled = paths.length > 0;
        binding.writePath = binding.writePath && paths.includes(binding.writePath) ? binding.writePath : paths[0] ?? null;
        if (role === "wiki" && paths.join("\n") !== this.bindings().roles.wiki.readPaths.join("\n")) this.wikiChanged = true;
      });
    }
    const moduleFields = fieldGroup("模块保存位置");
    for (const [key, title] of [["journal", "日记"], ["review", "复盘输出"], ["english", "英文稿"], ["expressions", "表达库"], ["pdfOriginal", "原 PDF"]] as const) {
      addField(moduleFields, key, title, [this.moduleDraft[key] ?? defaults[key] ?? ""], paths => {
        if (key === "journal" && !paths.length) delete this.moduleDraft.journal;
        else this.moduleDraft[key] = paths[0] ?? "";
      });
    }
    const nativeFields = fieldGroup("待办、附件与模板");
    new OriginSetting(nativeFields).setName("待办源文件").setDesc(TODO_SOURCE_PATH);
    new OriginSetting(nativeFields).setName("附件与模板").setDesc("沿用 Obsidian 设置");
    const result = page.createDiv({ attr: { "aria-live": "polite" } });
    const actions = page.createDiv({ cls: "echoink-knowledge-init-actions" });
    const summary = actions.createSpan({ cls: "echoink-knowledge-init-impact" });
    const previewButton = createOriginButton(actions, { text: "预览", cls: "text-button" });
    const confirm = createOriginButton(actions, { cls: "mod-cta", text: "确认初始化" }); confirm.disabled = true;
    const formIssues = () => {
      const issues = initializationFolderIssues(formFields, folders());
      if (this.mode === "build") for (const role of ["raw", "wiki"] as const) if (!bindings.roles[role].readPaths.length && !issues.has(role)) issues.set(role, ["请选择文件夹"]);
      return issues;
    };
    const refresh = () => { if (!page.isConnected) return; result.empty();
      const issues = formIssues();
      const unassigned: string[] = [];
      for (const issue of this.plan?.issues ?? []) {
        const matches = formFields.filter(field => issue.startsWith(field.title) || (field.key === "english" && issue.startsWith("英文日记")) || field.values.some(choice => choice.path && issue.includes(choice.path)));
        if (!matches.length) unassigned.push(issue);
        else for (const field of matches) issues.set(field.key, [...(issues.get(field.key) ?? []), issue]);
      }
      for (const [key, picker] of pickers) picker.setError(issues.get(key)?.join("；"));
      confirm.disabled = this.busy || this.previewing || editing.size > 0 || issues.size > 0 || !this.plan || this.plan.issues.length > 0;
      previewButton.disabled = confirm.disabled;
      summary.setText(this.busy ? "正在初始化…" : editing.size ? "请先确认新文件夹名称" : issues.size ? "请修正标红的位置" : this.previewing ? "正在核对…" : this.plan ? `将新建 ${this.plan.create.length} 个文件夹 · 移动 ${this.plan.moves.length} 个文件` : "正在核对…");
      if (this.error) result.createDiv({ cls: "settings-error", text: this.error, attr: { role: "alert" } });
      for (const issue of unassigned) result.createDiv({ cls: "settings-error", text: issue, attr: { role: "alert" } });

    };
    const preview = async () => {
      if (this.busy) return;
      if (formIssues().size) { this.invalidatePlan(); refresh(); return; }
      const version = ++this.generation; this.plan = null; this.previewing = true; this.error = ""; refresh();
      try {
        const createPaths = formFields.flatMap(field => field.values.filter(choice => choice.create).map(choice => choice.path.trim()));
        const plan = await this.service().previewDirectoryPlan(bindings, createPaths, { mode: this.mode!, wikiChanged: this.wikiChanged, moduleDirectories: this.moduleDraft });
        if (version === this.generation) this.plan = plan;
      } catch (error) { if (version === this.generation) this.error = error instanceof Error ? error.message : String(error); }
      finally { if (version === this.generation) this.previewing = false; refresh(); }
    };
    const schedulePreview = () => {
      if (this.previewTimer !== undefined) window.clearTimeout(this.previewTimer);
      this.previewTimer = window.setTimeout(() => { this.previewTimer = undefined; if (page.isConnected) void preview(); }, 150);
    };
    const invalidate = () => { if (!this.busy) { this.invalidatePlan(); refresh(); schedulePreview(); } };
    this.events.push(this.plugin.app.vault.on("create", invalidate), this.plugin.app.vault.on("delete", invalidate), this.plugin.app.vault.on("rename", invalidate), this.plugin.app.vault.on("modify", invalidate));
    previewButton.onclick = async () => {
      if (previewButton.disabled) return;
      await preview();
      if (this.plan && !this.plan.issues.length && !formIssues().size && !editing.size) this.change("initialize-preview");
    };
    confirm.onclick = () => {
      if (!formIssues().size && !editing.size) void this.confirmInitialization(refresh);
    };
    if (this.plan || this.error) refresh(); else void preview();
  }
  private async confirmInitialization(refresh: () => void): Promise<void> {
    const plan = this.plan;
    if (!plan || this.busy || this.previewing || plan.issues.length) return;
    this.busy = true; this.folderPickers.forEach(picker => picker.setDisabled(true)); refresh();
    try {
      const result = await this.service().applyDirectoryPlan(plan, false);
      new Notice(`已新建 ${result.created.length} 个文件夹，移动 ${result.moved.length} 个文件`);
      this.reset(); this.page = this.initializationParent;
      this.returnFocusKey = this.initializationParent ? "knowledge:onboarding" : "knowledge:management";
    } catch (error) { this.error = error instanceof Error ? error.message : String(error); this.plan = null; }
    finally { this.busy = false; this.navigation.redraw(); }
  }
  private renderInitializationPreview(page: HTMLElement): void {
    const tree = page.createDiv();
    const errors = page.createDiv({ attr: { role: "alert" } });
    const actions = page.createDiv({ cls: "echoink-knowledge-init-actions" });
    const summary = actions.createSpan({ cls: "echoink-knowledge-init-impact" });
    const confirm = createOriginButton(actions, { cls: "mod-cta", text: "确认初始化" });
    const refresh = () => {
      if (!page.isConnected) return;
      tree.empty(); errors.empty();
      confirm.disabled = this.busy || this.previewing || !this.plan || !!this.plan.issues.length;
      summary.setText(this.busy ? "正在初始化…" : this.previewing ? "正在核对…" : this.plan
        ? `将新建 ${this.plan.create.length} 个文件夹 · 移动 ${this.plan.moves.length} 个文件` : "预览未完成");
      if (this.error) errors.createDiv({ cls: "settings-error", text: this.error });
      for (const issue of this.plan?.issues ?? []) errors.createDiv({ cls: "settings-error", text: issue });
      if (!this.plan) return;
      const vault = this.plugin.app.vault;
      const native = this.plugin.app as unknown as { internalPlugins?: { plugins?: Record<string, { instance?: { options?: { folder?: string } } }> } };
      const nativePurposes: { path: string; purpose: string }[] = [];
      for (const [key, path, purpose] of [
        ["journal", this.plugin.settings.journalDirectory, "日记"],
        ["review", this.plugin.settings.review.outputDir, "复盘输出"],
        ["english", this.plugin.settings.englishDiary.englishDirectory, "英文稿"],
        ["expressions", this.plugin.settings.englishDiary.expressionDirectory, "表达库"],
        ["pdfOriginal", this.plugin.settings.pdfReading.originalDirectory, "原 PDF"]
      ] as const) if (!this.plan.moduleDirectories?.[key] && path) nativePurposes.push({ path, purpose });
      const template = native.internalPlugins?.plugins?.templates?.instance?.options?.folder;
      if (template) nativePurposes.push({ path: template, purpose: "模板" });
      const attachment = (vault as unknown as { getConfig?(key: string): unknown }).getConfig?.("attachmentFolderPath");
      if (typeof attachment === "string" && attachment && attachment !== "/" && !attachment.startsWith(".")) nativePurposes.push({ path: attachment, purpose: "附件" });
      renderInitializationFolderTree(tree, initializationFolderTree(vault.getAllFolders(false).map(folder => folder.path)
        .filter(path => !path.split("/").some(part => part.startsWith("."))), this.plan, nativePurposes));
    };
    const recheck = async () => {
      if (this.busy || !this.draft || !this.mode) return;
      const version = ++this.generation;
      this.previewing = true; refresh();
      try {
        const createPaths = Object.values(this.choices).flatMap(values => values.filter(value => value.create).map(value => value.path));
        const plan = await this.service().previewDirectoryPlan(this.draft, createPaths, { mode: this.mode, wikiChanged: this.wikiChanged, moduleDirectories: this.moduleDraft });
        if (version === this.generation) this.plan = plan;
      } catch (error) { if (version === this.generation) { this.error = error instanceof Error ? error.message : String(error); this.plan = null; } }
      finally { if (version === this.generation) this.previewing = false; refresh(); }
    };
    const invalidate = () => {
      if (this.busy) return;
      this.invalidatePlan(); refresh();
      if (this.previewTimer !== undefined) window.clearTimeout(this.previewTimer);
      this.previewTimer = window.setTimeout(() => { this.previewTimer = undefined; if (page.isConnected) void recheck(); }, 150);
    };
    this.events.push(this.plugin.app.vault.on("create", invalidate), this.plugin.app.vault.on("delete", invalidate), this.plugin.app.vault.on("rename", invalidate));
    confirm.onclick = () => void this.confirmInitialization(refresh);
    refresh();
    if (!this.plan && !this.busy) void recheck();
  }
  private invalidatePlan(): void { this.plan = null; this.previewing = false; this.generation++; }
}
