import { Notice, TFolder, setIcon, type EventRef, type Modal } from "obsidian";
import type CodexForObsidianPlugin from "../main";
import { emptyKnowledgeFolderBindings, normalizeKnowledgeFolderBindings, knowledgeCollectionDirectory, type KnowledgeFolderBindings } from "../knowledge-base/folder-bindings";
import type { KnowledgeDirectoryMode, KnowledgeDirectoryPlan, KnowledgeModuleDirectories } from "../knowledge-base/folder-plan";
import { readNativeJournalSettings } from "../home/native-journal";
import { TODO_SOURCE_PATH } from "../home/todo-store";
import { OriginSetting } from "./origin-setting";
import { createOriginButton, createOriginInput, createOriginCheck, createOriginSelect, disposeOriginControls } from "./origin-controls";
import { createSettingsPage, createSettingsNavigationRow, createSettingsSection, attachSettingsTooltip, showSettingsInlineConfirmation } from "./settings-v2";
import { renderKnowledgeFolderActions } from "./knowledge-folder-actions";

type Role = "raw" | "wiki" | "projects" | "inbox";
const titles: Record<Role, string> = { raw: "资料来源", wiki: "知识成果", projects: "项目", inbox: "收件箱" };
type Page = "sources" | "role" | "initialize" | "picker" | null;

/** Desktop presentation only. All writes use the existing directory service. */
export class DesktopKnowledgeSettings {
  private page: Page = null;
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
  private pendingLeave: (() => void) | null = null;
  constructor(private readonly plugin: CodexForObsidianPlugin, private readonly navigation: {
    redraw(): void; openPreferences(): void; openLinking(): void; openEditor(editor: Modal): void;
  }) {}
  open(target: "sources" | "initialize"): void { this.change(target); }
  get isDetail(): boolean { return this.page !== null; }
  get hasDraft(): boolean { return this.draft !== null && this.mode !== null; }
  get submitting(): boolean { return this.busy; }
  private bindings(): KnowledgeFolderBindings { return normalizeKnowledgeFolderBindings(this.plugin.settings.knowledgeBase.folderBindings) ?? emptyKnowledgeFolderBindings(); }
  private service() { const service = this.plugin.getKnowledgeSurfaceService(); if (!service) throw new Error("目录服务尚未就绪，请稍后重试"); return service; }
  private change(page: Page): void { this.page = page; this.error = ""; this.navigation.redraw(); }
  requestLeave(done: () => void): void {
    if (this.busy) return;
    if (!this.hasDraft) { this.page = null; done(); return; }
    this.pendingLeave = done;
    if (this.host?.isConnected) this.renderLeavePrompt();
  }
  private renderLeavePrompt(): void {
    if (!this.host || !this.pendingLeave) return;
    const done = this.pendingLeave; this.pendingLeave = null;
    const trigger = this.host.querySelector<HTMLButtonElement>(".settings-back") ?? createOriginButton(this.host, { text: "返回", cls: "text-button" });
    showSettingsInlineConfirmation(this.host, trigger, { message: "还有未确认的目录方案，要放弃修改吗？", confirmLabel: "放弃修改", cancelLabel: "继续编辑", onConfirm: async () => {
      this.reset(); this.page = null; done?.();
    } });
  }
  private reset(): void { this.draft = null; this.mode = null; this.moduleDraft = {}; this.wikiChanged = false; this.plan = null; this.generation++; }
  suspend(): void { this.events.splice(0).forEach(ref => this.plugin.app.vault.offref(ref)); this.host = null; }
  dispose(): void { this.suspend(); }
  private checkbox(parent: HTMLElement, title: string, checked: boolean, hint: string, save: (value: boolean) => Promise<void>): void {
    const row = new OriginSetting(parent).setName(title);
    const help = createOriginButton(row.nameEl, { cls: "is-icon echoink-settings-help-trigger", attr: { "aria-label": hint } }); setIcon(help, "circle-alert"); attachSettingsTooltip(help, hint);
    const check = createOriginCheck(row.controlEl, { attr: { "aria-label": title } }); check.checked = checked; let accepted = checked;
    check.onchange = () => { const next = check.checked; check.disabled = true; void save(next).then(() => { accepted = next; }).catch(error => { check.checked = accepted; new Notice(error instanceof Error ? error.message : String(error)); }).finally(() => { check.disabled = false; }); };
  }
  private async save(next: KnowledgeFolderBindings, wikiChanged = false): Promise<void> {
    if (this.busy) throw new Error("正在保存，请稍后重试");
    this.busy = true;
    try { await this.service().saveDirectoryBindings(next, { wikiChanged }); this.error = ""; }
    catch (error) { this.error = `绑定未保存，仍使用原目录：${error instanceof Error ? error.message : String(error)}`; throw error; }
    finally { this.busy = false; }
  }
  renderSummary(parent: HTMLElement): void {
    const bindings = this.bindings();
    const folders = createSettingsSection(parent, { title: "用途目录", surface: "flat" });
    for (const role of ["raw", "wiki", "projects", "inbox"] as const) {
      const binding = bindings.roles[role];
      const invalid = binding.readPaths.some(path => !(this.plugin.app.vault.getAbstractFileByPath(path) instanceof TFolder));
      createSettingsNavigationRow(folders, { title: titles[role], description: role === "inbox" ? "召回" : "/ask · /maintain · 召回", value: binding.enabled && binding.readPaths.length ? `${binding.readPaths.join("、")}${invalid ? " · 原目录已失效" : ""}` : "未配置", focusKey: `knowledge:directory:${role}`, onActivate: () => role === "raw" ? this.change("sources") : this.openRole(role) });
    }
    const targets = createSettingsSection(parent, { title: "收藏保存到", surface: "flat" });
    for (const [key, title] of [["web", "网页"], ["wechat", "公众号文章"]] as const) {
      const row = new OriginSetting(targets).setName(title);
      const select = createOriginSelect(row.controlEl, { attr: { "aria-label": `${title}收藏保存到` } }, [], "", this.plugin.app);
      select.addOption("", "先选择资料来源");
      for (const path of bindings.roles.raw.readPaths) select.addOption(path, path);
      select.element.value = knowledgeCollectionDirectory(bindings, key) ?? "";
      select.element.onchange = () => { const next = this.bindings(); next.collectionTargets ??= { web: knowledgeCollectionDirectory(next, "web"), wechat: knowledgeCollectionDirectory(next, "wechat") }; next.collectionTargets[key] = select.element.value || null;
        void this.save(next).then(() => this.navigation.redraw()).catch(() => { select.element.value = knowledgeCollectionDirectory(bindings, key) ?? ""; this.navigation.redraw(); }); };
    }
    const permissions = createSettingsSection(parent, { title: "Agent 权限", surface: "flat" });
    this.checkbox(permissions, "允许 Agent 新建子文件夹", bindings.allowAgentSubfolders === true, "只允许在获准的知识成果和项目中创建子文件夹，不授予移动或删除权限。", async value => { const next = this.bindings(); next.allowAgentSubfolders = value; await this.save(next); });
    this.checkbox(permissions, "自动补链", this.plugin.settings.knowledgeBase.autoLinkEnabled !== false, "新知识写入后自动补全双链。关闭后不再发起自动补链，已开始的写入会完成；仍可手动补全。", async value => {
      const previous = this.plugin.settings.knowledgeBase.autoLinkEnabled; this.plugin.settings.knowledgeBase.autoLinkEnabled = value;
      try { await this.plugin.saveSettings(true); } catch (error) { this.plugin.settings.knowledgeBase.autoLinkEnabled = previous; throw error; }
    });
    createSettingsNavigationRow(parent, { title: "知识提炼偏好", focusKey: "knowledge:preferences", onActivate: this.navigation.openPreferences });
    createSettingsNavigationRow(parent, { title: "知识关联", onActivate: this.navigation.openLinking });
    const service = this.plugin.getKnowledgeSurfaceService();
    if (service) renderKnowledgeFolderActions(parent, service, this.plugin.settings.settingsLanguage, async () => this.navigation.redraw(), group => {
      createSettingsNavigationRow(group, { title: bindings.configured ? "重新初始化" : "初始化文件夹", focusKey: "knowledge:onboarding", onActivate: () => { this.reset(); this.change("initialize"); } });
    }, this.navigation.openEditor);
    if (this.error) parent.createDiv({ cls: "settings-error", text: this.error, attr: { role: "alert" } });
  }
  renderDetail(container: HTMLElement): void {
    this.suspend();
    const page = createSettingsPage(container, { title: this.page === "sources" ? "资料来源" : this.page === "role" ? titles[this.selectedRole] : this.page === "picker" ? this.picker?.title ?? "选择文件夹" : "初始化文件夹", detail: true, backLabel: "返回", onBack: () => {
      if (this.page === "picker") this.change(this.picker?.back ?? null);
      else this.requestLeave(() => this.navigation.redraw());
    } });
    page.addClass("echoink-knowledge-module-page"); this.host = page;
    if (this.error) page.createDiv({ cls: "settings-error", text: this.error, attr: { role: "alert" } });
    if (this.page === "sources") this.renderSources(page);
    else if (this.page === "role") this.renderRole(page);
    else if (this.page === "picker") this.renderPicker(page);
    else this.renderInitialization(page);
    if (this.pendingLeave) this.renderLeavePrompt();
  }
  private openRole(role: Role): void { this.selectedRole = role; this.change("role"); }
  private renderRole(page: HTMLElement): void {
    const role = this.selectedRole, bindings = this.bindings(), binding = bindings.roles[role];
    createSettingsNavigationRow(page, { title: binding.readPaths.length ? "更改文件夹" : "选择文件夹", value: binding.readPaths.join("、") || "未配置", onActivate: () => this.chooseRole(role) });
    if (!binding.enabled) return;
    for (const path of binding.readPaths) {
      const group = createSettingsSection(page, { title: path, surface: "flat" });
      if (!(this.plugin.app.vault.getAbstractFileByPath(path) instanceof TFolder)) group.createDiv({ cls: "settings-error", text: "原目录已失效，请重新选择" });
      this.checkbox(group, "允许 Agent 自动整理", binding.autoOrganizePaths?.includes(path) ?? false, "只在这个已授权的目录内整理，仍沿原有确认与回执。", async enabled => {
        const next = this.bindings(), item = next.roles[role]; item.autoOrganizePaths = (item.autoOrganizePaths ?? []).filter(value => value !== path); if (enabled) item.autoOrganizePaths.push(path); await this.save(next);
      });
    }
    this.renderSearchPermission(page, role);
    const unbind = createOriginButton(page, { text: "解绑文件夹", cls: "settings-danger" }); unbind.onclick = () => this.confirmUnbind(page, unbind, role);
  }
  private renderSearchPermission(page: HTMLElement, role: Role): void {
    this.checkbox(page, "允许搜索正文", this.bindings().roles[role].searchEnabled !== false, "沿用当前用途的正文搜索权限。关闭后保留目录绑定。", async enabled => { const next = this.bindings(); next.roles[role].searchEnabled = enabled; await this.save(next); });
  }
  private chooseRole(role: Role): void {
    this.picker = { title: role === "wiki" ? "知识成果 · 请选择一个一级文件夹" : `选择${titles[role]}文件夹`, role, back: this.page, onChoose: async path => {
      const next = this.bindings(), binding = next.roles[role];
      binding.readPaths = role === "raw" ? [...new Set([...binding.readPaths, path])] : [path];
      binding.writePath = role === "raw" && binding.writePath ? binding.writePath : path; binding.enabled = true; binding.searchEnabled = true;
      binding.autoOrganizePaths = (binding.autoOrganizePaths ?? []).filter(value => binding.readPaths.includes(value));
      await this.save(next, role === "wiki"); this.change(role === "raw" ? "sources" : null);
    } }; this.change("picker");
  }
  private renderPicker(page: HTMLElement): void {
    const picker = this.picker; if (!picker) return;
    const input = createOriginInput(page, { attr: { placeholder: "搜索文件夹", "aria-label": "搜索文件夹" } });
    const list = page.createDiv({ cls: "echoink-knowledge-folder-picker" });
    const render = () => { disposeOriginControls(list); list.empty();
      const folders = this.plugin.app.vault.getAllFolders(false).filter(folder => !folder.path.split("/").some(part => part.startsWith(".")) && (picker.role !== "wiki" || !folder.path.includes("/")) && folder.path.toLocaleLowerCase().includes(input.value.toLocaleLowerCase())).sort((a, b) => a.path.localeCompare(b.path));
      if (!folders.length) list.createDiv({ cls: "setting-item-description", text: "没有符合条件的文件夹" });
      for (const folder of folders) createSettingsNavigationRow(list, { title: folder.path, actionLabel: "选择", onActivate: () => { if (this.busy) return; void picker.onChoose(folder.path).catch(error => { new Notice(error instanceof Error ? error.message : String(error)); this.navigation.redraw(); }); } });
    }; input.oninput = render; render();
    const role = picker.role;
    if (role && this.bindings().roles[role].enabled && role !== "raw") {
      const unbind = createOriginButton(page, { text: "解绑文件夹", cls: "mod-warning" });
      unbind.onclick = () => this.confirmUnbind(page, unbind, role);
    }
  }
  private confirmUnbind(page: HTMLElement, trigger: HTMLButtonElement, role: Role, path?: string): void {
    showSettingsInlineConfirmation(page, trigger, { message: "解绑只解除用途绑定，不会删除目录或笔记。", confirmLabel: "确认解绑", cancelLabel: "取消", onConfirm: async () => {
      const next = this.bindings(), binding = next.roles[role]; binding.readPaths = path ? binding.readPaths.filter(item => item !== path) : [];
      binding.enabled = binding.readPaths.length > 0; binding.writePath = binding.readPaths.includes(binding.writePath ?? "") ? binding.writePath : binding.readPaths[0] ?? null;
      binding.autoOrganizePaths = (binding.autoOrganizePaths ?? []).filter(item => binding.readPaths.includes(item));
      try { await this.save(next); this.change(role === "raw" ? "sources" : null); }
      catch { this.navigation.redraw(); }
    } });
  }
  private renderSources(page: HTMLElement): void {
    const header = page.createDiv({ cls: "echoink-knowledge-sources-heading" }); header.createEl("h3", { text: "来源目录" });
    const add = createOriginButton(header, { cls: "is-icon", attr: { "aria-label": "添加来源目录" } }); setIcon(add, "plus"); add.onclick = () => this.chooseRole("raw");
    const bindings = this.bindings(); if (!bindings.roles.raw.readPaths.length) page.createDiv({ cls: "setting-item-description", text: "还没有资料来源" });
    for (const path of bindings.roles.raw.readPaths) {
      const row = page.createDiv({ cls: "echoink-knowledge-source" });
      row.createDiv({ cls: "echoink-knowledge-source-path", text: path });
      const unbind = createOriginButton(row, { cls: "is-icon", attr: { "aria-label": `解绑 ${path}` } }); setIcon(unbind, "trash-2"); unbind.onclick = () => this.confirmUnbind(page, unbind, "raw", path);
      if (!(this.plugin.app.vault.getAbstractFileByPath(path) instanceof TFolder)) row.createDiv({ cls: "settings-error", text: "原目录已失效" });
      this.checkbox(row, "允许 Agent 自动整理", bindings.roles.raw.autoOrganizePaths?.includes(path) ?? false, "仅对这个已绑定目录生效，执行时仍核对权限并确认写入。", async enabled => {
        const next = this.bindings(), binding = next.roles.raw; binding.autoOrganizePaths = (binding.autoOrganizePaths ?? []).filter(item => item !== path); if (enabled) binding.autoOrganizePaths.push(path); await this.save(next);
      });
    }
    if (bindings.roles.raw.enabled) this.renderSearchPermission(page, "raw");
    if (bindings.roles.raw.readPaths.length > 1) {
      const row = new OriginSetting(page).setName("默认保存到"); const select = createOriginSelect(row.controlEl, {}, [], "", this.plugin.app);
      bindings.roles.raw.readPaths.forEach(path => select.addOption(path, path)); select.element.value = bindings.roles.raw.writePath ?? "";
      select.element.onchange = () => { const next = this.bindings(); next.roles.raw.writePath = select.element.value; void this.save(next).catch(error => { select.element.value = bindings.roles.raw.writePath ?? ""; new Notice(String(error)); }); };
    }
  }
  private renderInitialization(page: HTMLElement): void {
    if (!this.mode) {
      for (const [mode, title, description] of [["existing", "使用现有文件夹", "选择已有位置，只改绑定，不移动文件。"], ["build", "帮我搭建", "核对目录和实际搬迁计划，确认后执行。"]] as const) createSettingsNavigationRow(page, { title, description, onActivate: () => {
        this.mode = mode; this.draft = this.bindings();
        const core = (this.plugin.app as unknown as { internalPlugins?: { plugins?: Record<string, { instance?: { options?: { folder?: string } } }> } }).internalPlugins?.plugins;
        // Journal/templates are owned by Obsidian; stale shared bindings are not a new directory choice.
        for (const [role, id] of [["journal", "daily-notes"], ["templates", "templates"]] as const) {
          const folder = core?.[id]?.instance?.options?.folder;
          if (typeof folder !== "string") continue;
          const binding = this.draft.roles[role]; binding.native = true; binding.enabled = true;
          binding.readPaths = folder ? [folder] : []; binding.writePath = folder || null;
          binding.autoOrganizePaths = (binding.autoOrganizePaths ?? []).filter(path => binding.readPaths.includes(path));
        }
        if (mode === "build") for (const role of ["raw", "wiki"] as const) if (!this.draft.roles[role].enabled) { const binding = this.draft.roles[role]; binding.enabled = true; binding.readPaths = [role]; binding.writePath = role; if (role === "wiki") this.wikiChanged = true; }
        this.change("initialize");
      } });
      return;
    }
    const route = createOriginButton(page, { text: "换一条路线", cls: "text-button" }); route.onclick = () => this.requestLeave(() => { this.page = "initialize"; this.navigation.redraw(); });
    const bindings = this.draft!;
    const fields = page.createDiv({ cls: "echoink-knowledge-init-fields" });
    for (const role of ["raw", "wiki", "projects", "inbox"] as const) {
      const row = new OriginSetting(fields).setName(titles[role]);
      const input = createOriginInput(row.controlEl, { value: bindings.roles[role].writePath ?? "", attr: { "aria-label": `初始化${titles[role]}`, placeholder: role === "wiki" ? "一个一级文件夹" : "Vault 内文件夹" } });
      input.oninput = () => { this.invalidatePlan(); const value = input.value.trim(); const binding = bindings.roles[role];
        // Preserve existing multi-source/read scopes until the user edits this specific role.
        binding.readPaths = role === "raw" ? [...new Set([...binding.readPaths.filter(path => path !== binding.writePath), ...(value ? [value] : [])])] : value ? [value] : [];
        binding.writePath = value || null; binding.enabled = binding.readPaths.length > 0; if (role === "wiki") this.wikiChanged = true;
      }; input.onblur = () => void preview();
      if (role === "raw" && bindings.roles.raw.readPaths.length > 1) row.descEl.setText(`读取：${bindings.roles.raw.readPaths.join("、")}；新内容保存到所选位置。`);
    }
    const native = readNativeJournalSettings(this.plugin.app, this.plugin.settings.journalDirectory);
    const defaults: KnowledgeModuleDirectories = { journal: native.folder, review: this.plugin.settings.review.outputDir, english: this.plugin.settings.englishDiary.englishDirectory, expressions: this.plugin.settings.englishDiary.expressionDirectory, pdfOriginal: this.plugin.settings.pdfReading.originalDirectory ?? knowledgeCollectionDirectory(bindings, "web") ?? "" };
    for (const [key, title] of [["journal", "日记"], ["review", "复盘输出"], ["english", "英文稿"], ["expressions", "表达库"], ["pdfOriginal", "原 PDF"]] as const) {
      const row = new OriginSetting(fields).setName(title); const input = createOriginInput(row.controlEl, { value: this.moduleDraft[key] ?? defaults[key] ?? "", attr: { "aria-label": `初始化${title}` } });
      input.oninput = () => { this.moduleDraft[key] = input.value.trim(); this.invalidatePlan(); }; input.onblur = () => void preview();
    }
    new OriginSetting(fields).setName("待办源文件").setDesc(TODO_SOURCE_PATH);
    new OriginSetting(fields).setName("附件与模板").setDesc("沿用 Obsidian 设置");
    const result = page.createDiv({ attr: { "aria-live": "polite" } });
    const actions = page.createDiv({ cls: "echoink-knowledge-init-actions" });
    const summary = actions.createSpan({ cls: "echoink-knowledge-init-impact" });
    const retry = createOriginButton(actions, { text: "重新核对" });
    const confirm = createOriginButton(actions, { cls: "mod-cta", text: "确认初始化" }); confirm.disabled = true;
    const refresh = () => { if (!page.isConnected) return; result.empty();
      confirm.disabled = this.busy || this.previewing || !this.plan || this.plan.issues.length > 0; retry.disabled = this.busy || this.previewing;
      summary.setText(this.busy ? "正在初始化…" : this.previewing ? "正在核对…" : this.plan ? `将新建 ${this.plan.create.length} 个文件夹 · 移动 ${this.plan.moves.length} 个文件` : "文件或设置已变化，请重新核对");
      if (this.error) result.createDiv({ cls: "settings-error", text: this.error, attr: { role: "alert" } });
      if (this.plan) { for (const issue of this.plan.issues) result.createDiv({ cls: "settings-error", text: issue });
        const details = result.createEl("details"); details.createEl("summary", { text: "查看实际变更" });
        for (const path of this.plan.create) details.createDiv({ text: `新建 ${path}` });
        for (const move of this.plan.moves) details.createDiv({ text: `${move.from} → ${move.to}` });
      }
    };
    const preview = async () => {
      if (this.busy) return; const version = ++this.generation; this.plan = null; this.previewing = true; this.error = ""; refresh();
      try { const createPaths = this.mode === "build" ? Object.values(bindings.roles).filter(binding => binding.enabled && !binding.native).flatMap(binding => binding.readPaths) : [];
        const plan = await this.service().previewDirectoryPlan(bindings, createPaths, { mode: this.mode!, wikiChanged: this.wikiChanged, moduleDirectories: this.moduleDraft });
        if (version === this.generation) this.plan = plan;
      } catch (error) { if (version === this.generation) this.error = error instanceof Error ? error.message : String(error); }
      finally { if (version === this.generation) this.previewing = false; refresh(); }
    };
    const invalidate = () => { if (!this.busy) { this.invalidatePlan(); refresh(); } };
    this.events.push(this.plugin.app.vault.on("create", invalidate), this.plugin.app.vault.on("delete", invalidate), this.plugin.app.vault.on("rename", invalidate), this.plugin.app.vault.on("modify", invalidate));
    fields.addEventListener("input", refresh); retry.onclick = () => void preview();
    confirm.onclick = async () => {
      const plan = this.plan; if (!plan || this.busy || this.previewing || plan.issues.length) return;
      this.busy = true; fields.querySelectorAll<HTMLInputElement>("input").forEach(input => { input.disabled = true; }); refresh();
      try { const result = await this.service().applyDirectoryPlan(plan, false); new Notice(`已新建 ${result.created.length} 个文件夹，移动 ${result.moved.length} 个文件`); this.reset(); this.page = null; }
      catch (error) { this.error = error instanceof Error ? error.message : String(error); this.plan = null; }
      finally { this.busy = false; this.navigation.redraw(); }
    };
    if (this.plan || this.error) refresh(); else void preview();
  }
  private invalidatePlan(): void { this.plan = null; this.previewing = false; this.generation++; }
}
