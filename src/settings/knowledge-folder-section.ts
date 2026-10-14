import type { KnowledgeInitializationJob } from "../knowledge-base/initializer";
import { Modal, Notice, TFolder } from "obsidian";
import type CodexForObsidianPlugin from "../main";
import { KNOWLEDGE_ROOT_NAMES, KNOWLEDGE_ROOT_ROLES, type KnowledgeRootRole } from "../knowledge-base/root-paths-core";
import { emptyKnowledgeFolderBindings, type KnowledgeFolderBindings } from "../knowledge-base/folder-bindings";
import type { KnowledgeDirectoryPlan } from "../knowledge-base/folder-plan";
import { OriginSetting } from "./origin-setting";
import { createOriginButton, disposeOriginControls } from "./origin-controls";
import { createSettingsGroup, createSettingsNavigationRow, createSettingsSection } from "./settings-v2";
import { resolveKnowledgeMaintenanceSubmitSnapshot } from "./knowledge-maintenance-submit";

const LABELS: Record<KnowledgeRootRole, string> = { raw: "资料来源", wiki: "知识成果", projects: "项目", outputs: "输出", inbox: "收件箱", journal: "日记", work: "工作", archive: "归档", templates: "模板", assets: "附件" };

/** The existing settings host and Origin controls render one shared directory configuration. */
export class KnowledgeFolderSection {
  private mode: "existing" | "build" = "existing";
  private drafts = new Map<string, KnowledgeFolderBindings>();
  private draft: KnowledgeFolderBindings;
  private newPaths = new Set<string>();
  private roleModes = new Map<KnowledgeRootRole, "existing" | "new">();
  private newNames = new Map<KnowledgeRootRole, string>();
  private parents = new Map<KnowledgeRootRole, string>();
  private preview: KnowledgeDirectoryPlan | null = null;
  private busy = false;
  private error = "";
  private root: HTMLElement | null = null;
  private timer: number | null = null;
  private job: Readonly<KnowledgeInitializationJob> | null = null;
  private jobLoaded = false;
  private editorStates = new Map<string, { paths: Set<string>; modes: Map<KnowledgeRootRole, "existing" | "new">; names: Map<KnowledgeRootRole, string>; parents: Map<KnowledgeRootRole, string> }>();

  constructor(private readonly plugin: CodexForObsidianPlugin, private readonly redraw: () => void) {
    this.draft = structuredClone(plugin.settings.knowledgeBase.folderBindings ?? emptyKnowledgeFolderBindings());
  }
  dispose(): void {
    if (this.root) disposeOriginControls(this.root);
    if (this.timer !== null) this.root?.ownerDocument.defaultView?.clearTimeout(this.timer);
    this.timer = null;
    this.root = null;
    this.jobLoaded = false;
  }
  render(page: HTMLElement, zh: boolean): void {
    if (this.root) disposeOriginControls(this.root);
    this.root = createSettingsSection(page, { title: zh ? "知识库目录" : "Knowledge folders", surface: "flat" });
    this.root.addClass("echoink-knowledge-folder-panel");
    this.root.setAttr("data-echoink-focus-key", "knowledge:onboarding");
    const manager = this.plugin.getKnowledgeSurfaceService();
    const locked = this.busy || manager?.folderOperationBusy === true;
    if (this.error) this.root.createDiv({ cls: "settings-error", text: this.error, attr: { role: "alert" } });
    if (this.job && this.job.status !== "preview" && this.job.status !== "initialized") {
      const group = createSettingsGroup(this.root);
      new OriginSetting(group).setName(zh ? "知识分析" : "Knowledge analysis").setDesc(`${this.job.extractionCursor} / ${this.job.extractionQueue.length}${this.job.lastError ? ` · ${this.job.lastError}` : ""}`);
      const actions = group.createDiv({ cls: "echoink-knowledge-init-actions" });
      const action = createOriginButton(actions, { text: this.job.status === "active" ? (zh ? "取消" : "Cancel") : (zh ? "继续" : "Continue") });
      action.disabled = this.busy;
      action.onclick = () => void this.run(async () => { this.job = this.job?.status === "active" ? await manager!.cancelInitialization() : await manager!.continueInitialization(); });
      if (this.job.status !== "active") {
        const configure = createOriginButton(actions, { text: zh ? "重新配置" : "Configure again" });
        configure.disabled = this.busy;
        configure.onclick = () => { this.job = null; this.jobLoaded = true; this.error = ""; this.redraw(); };
      }
      if (this.job.status === "active") this.poll();
      return;
    }
    if (this.preview) { this.renderPreview(this.root, zh, locked); return; }
    const tabs = this.root.createDiv({ cls: "echoink-knowledge-init-tabs", attr: { role: "tablist" } });
    for (const mode of ["existing", "build"] as const) {
      const tab = createOriginButton(tabs, { cls: `echoink-knowledge-init-tab ${mode === this.mode ? "is-active" : ""}`, text: mode === "existing" ? (zh ? "使用现有" : "Use existing") : (zh ? "帮我搭建" : "Build for me"), attr: { role: "tab", "aria-selected": String(mode === this.mode) } });
      tab.disabled = locked;
      tab.tabIndex = mode === this.mode ? 0 : -1;
      tab.onkeydown = (event) => {
        if (locked || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const target = event.key === "Home" ? "existing" : event.key === "End" ? "build" : this.mode === "existing" ? "build" : "existing";
        const next = Array.from(tabs.querySelectorAll<HTMLButtonElement>("[role=tab]")).find(button => button.dataset.mode === target);
        next?.click(); this.root?.querySelector<HTMLElement>('[role=tab][aria-selected="true"]')?.focus();
      };
      tab.dataset.mode = mode;
      tab.onclick = () => {
        this.drafts.set(this.mode, structuredClone(this.draft));
        this.editorStates.set(this.mode, { paths: new Set(this.newPaths), modes: new Map(this.roleModes), names: new Map(this.newNames), parents: new Map(this.parents) });
        this.mode = mode;
        const editor = this.editorStates.get(mode);
        this.newPaths = new Set(editor?.paths); this.roleModes = new Map(editor?.modes); this.newNames = new Map(editor?.names); this.parents = new Map(editor?.parents);
        this.draft = structuredClone(this.drafts.get(mode) ?? this.plugin.settings.knowledgeBase.folderBindings ?? emptyKnowledgeFolderBindings());
        if (mode === "build" && !this.drafts.has(mode) && !Object.values(this.draft.roles).some((binding) => binding.enabled)) {
          for (const role of ["raw", "wiki"] as const) {
            this.draft.roles[role].enabled = true;
            this.roleModes.set(role, "new");
            this.newNames.set(role, KNOWLEDGE_ROOT_NAMES[role]);
            this.updateNewPath(role);
          }
        }
        this.redraw();
      };
    }
    const group = createSettingsGroup(this.root);
    for (const role of KNOWLEDGE_ROOT_ROLES) this.renderRole(group, role, zh, locked);
    const actions = this.root.createDiv({ cls: "echoink-knowledge-init-actions" });
    const preview = createOriginButton(actions, { cls: "mod-cta", text: zh ? "预览方案" : "Preview plan" });
    preview.disabled = locked;
    preview.onclick = () => void this.run(async () => { this.preview = await manager!.previewDirectoryPlan(this.draft, [...this.newPaths]); });
    if (!this.jobLoaded) this.poll();
  }
  private renderRole(group: HTMLElement, role: KnowledgeRootRole, zh: boolean, locked: boolean): void {
    const binding = this.draft.roles[role];
    const row = new OriginSetting(group).setName(zh ? LABELS[role] : role);
    const nativeId = role === "journal" ? "daily-notes" : role === "templates" ? "templates" : null;
    const options = nativeId ? (this.plugin.app as unknown as { internalPlugins?: { plugins?: Record<string, { instance?: { options?: { folder?: string } } }> } }).internalPlugins?.plugins?.[nativeId]?.instance?.options : undefined;
    if (options && typeof options.folder === "string") {
      binding.native = true; binding.enabled = true;
      if (options.folder) { binding.readPaths = [options.folder]; binding.writePath = options.folder; }
      else { binding.readPaths = []; binding.writePath = null; }
      row.setDesc(`${zh ? "沿用 Obsidian" : "Use Obsidian"}：${options.folder || (zh ? "Vault 根目录" : "Vault root")}`);
      row.addOriginButton((button) => button.setButtonText(zh ? "编辑原生设置" : "Native settings").setDisabled(locked).onClick(() => {
        const settings = (this.plugin.app as unknown as { setting?: { open(): void; openTabById(id: string): void } }).setting;
        settings?.open(); settings?.openTabById(nativeId!);
      }));
      return;
    }
    row.addOriginToggle((toggle) => { toggle.toggleEl.setAttribute("aria-label", zh ? LABELS[role] : role); toggle.setValue(binding.enabled).setDisabled(locked).onChange((enabled) => { binding.enabled = enabled; this.redraw(); }); });
    if (!binding.enabled) return;
    const mode = this.roleModes.get(role) ?? "existing";
    row.addOriginDropdown(this.plugin.app, (select) => select.addOption("existing", zh ? "已有位置" : "Existing").addOption("new", zh ? "新建位置" : "New").setValue(mode).setDisabled(locked).onChange((value) => { this.roleModes.set(role, value as "existing" | "new"); this.redraw(); }));
    if (mode === "new") {
      row.addOriginText((input) => input.setValue(this.newNames.get(role) ?? "").setPlaceholder(zh ? "目录名称" : "Folder name").setDisabled(locked).onChange((name) => { this.newNames.set(role, name); this.updateNewPath(role); }));
      row.addOriginButton((button) => button.setButtonText(this.parents.get(role) || (zh ? "选择父目录" : "Choose parent")).setDisabled(locked).onClick(() => void this.pickFolder(true, zh).then((parent) => { if (parent === null) return; this.parents.set(role, parent); this.updateNewPath(role); this.redraw(); })));
    } else {
      row.addOriginButton((button) => button.setButtonText(zh ? "选择目录" : "Choose folder").setDisabled(locked).onClick(() => void this.pickFolder(false, zh).then((directory) => {
        if (!directory) return;
        binding.readPaths = role === "raw" ? [...new Set([...binding.readPaths, directory])] : [directory];
        if (binding.readPaths.length === 1 || role !== "raw") binding.writePath = directory;
        binding.compatibilityReadScopes = false;
        this.redraw();
      })));
    }
    for (const directory of binding.readPaths) {
      const item = new OriginSetting(group).setName(directory);
      item.addOriginButton((button) => button.setButtonText(zh ? "移除绑定" : "Remove binding").setDisabled(locked).onClick(() => {
        binding.readPaths = binding.readPaths.filter((path) => path !== directory);
        if (binding.writePath === directory) binding.writePath = binding.readPaths.length === 1 ? binding.readPaths[0] : null;
        this.newPaths.delete(directory);
        this.redraw();
      }));
    }
    if (role === "raw" || role === "wiki" || role === "assets" || role === "outputs") new OriginSetting(group).setName(zh ? "拟新建子目录" : "Child folders to create").addOriginText((input) => input.setValue(binding.allowedSubdirectories.join("、")).setDisabled(locked).onChange((value) => { binding.allowedSubdirectories = value.split(/[,，、]/u).map((item) => item.trim()).filter(Boolean); }));
    if (role === "raw" && binding.readPaths.length) new OriginSetting(group).setName(zh ? "新增资料默认位置" : "Default source destination")
      .addOriginDropdown(this.plugin.app, (select) => { select.addOption("unbound", zh ? "请选择" : "Choose"); for (const directory of binding.readPaths) select.addOption(directory, directory); select.setValue(binding.writePath ?? "unbound").setDisabled(locked).onChange((directory) => { binding.writePath = directory === "unbound" ? null : directory; }); });
  }
  private updateNewPath(role: KnowledgeRootRole): void {
    const name = this.newNames.get(role) ?? "";
    const parent = this.parents.get(role) ?? "";
    const binding = this.draft.roles[role];
    const directory = parent ? `${parent}/${name}` : name;
    if (role === "raw") {
      for (const prior of binding.readPaths.filter((path) => this.newPaths.has(path))) { binding.readPaths = binding.readPaths.filter((path) => path !== prior); this.newPaths.delete(prior); }
      if (directory) binding.readPaths.push(directory);
      if (binding.writePath && !binding.readPaths.includes(binding.writePath)) binding.writePath = null;
      if (binding.readPaths.length === 1) binding.writePath = directory;
    } else { binding.readPaths = directory ? [directory] : []; binding.writePath = directory || null; }
    if (directory) this.newPaths.add(directory);
  }
  private renderPreview(root: HTMLElement, zh: boolean, locked: boolean): void {
    const plan = this.preview!;
    const group = createSettingsGroup(root);
    for (const [title, paths] of [[zh ? "复用" : "Reuse", plan.reuse], [zh ? "拟新建" : "Create", plan.create], [zh ? "来源范围" : "Sources", plan.bindings.roles.raw.enabled ? plan.bindings.roles.raw.readPaths : []]] as const) new OriginSetting(group).setName(`${title} · ${paths.length}`).setDesc(paths.join("、") || "—");
    new OriginSetting(group).setName(zh ? `待提炼 · ${plan.sources.length} 篇` : `${plan.sources.length} sources to refine`).setDesc(zh ? "移动 0 个文件 · 改名 0 个目录" : "Move 0 files · Rename 0 folders");
    new OriginSetting(group).setName(zh ? "未启用" : "Disabled").setDesc(KNOWLEDGE_ROOT_ROLES.filter((role) => !plan.bindings.roles[role].enabled).map((role) => zh ? LABELS[role] : role).join("、"));
    for (const issue of plan.issues) root.createDiv({ cls: "settings-error", text: issue, attr: { role: "alert" } });
    const actions = root.createDiv({ cls: "echoink-knowledge-init-actions" });
    const back = createOriginButton(actions, { text: zh ? "返回修改" : "Edit" });
    back.disabled = locked; back.onclick = () => { this.preview = null; this.redraw(); };
    const apply = createOriginButton(actions, { text: zh ? "应用目录方案" : "Apply folders" });
    apply.disabled = locked || plan.issues.length > 0 || (plan.create.length > 0 && this.plugin.getKnowledgeSurfaceService()?.directoryWritable === false);
    apply.onclick = () => void this.apply(false, zh);
    const optimize = createOriginButton(actions, { cls: "mod-cta", text: zh ? "应用并优化" : "Apply and refine" });
    let model = true; try { resolveKnowledgeMaintenanceSubmitSnapshot(this.plugin.settings); } catch { model = false; }
    optimize.disabled = apply.disabled || this.plugin.getKnowledgeSurfaceService()?.directoryWritable === false || !model || !plan.sources.length || !plan.bindings.roles.wiki.enabled || !plan.bindings.roles.wiki.writePath;
    optimize.onclick = () => void this.apply(true, zh);
  }
  private async apply(optimize: boolean, zh: boolean): Promise<void> {
    await this.run(async () => {
      const plan = this.preview!;
      await this.plugin.getKnowledgeSurfaceService()!.applyDirectoryPlan(plan, optimize);
      this.draft = structuredClone(this.plugin.settings.knowledgeBase.folderBindings!);
      this.preview = null;
      this.newPaths.clear(); this.roleModes.clear(); this.editorStates.clear(); this.drafts.clear();
      this.job = await this.plugin.getKnowledgeSurfaceService()!.getInitializationState();
      new Notice(zh ? `已应用目录方案：新建 ${plan.create.length}，复用 ${plan.reuse.length}${optimize ? "；知识分析已开始" : ""}` : `Folders applied: ${plan.create.length} created, ${plan.reuse.length} reused`);
    });
  }
  private async run(action: () => Promise<void>): Promise<void> {
    if (this.busy) return;
    this.busy = true; this.error = ""; this.redraw();
    try { await action(); } catch (error) { this.error = error instanceof Error ? error.message : String(error); }
    finally { this.busy = false; this.redraw(); }
  }
  private poll(): void {
    if (this.timer !== null) return;
    const window = this.root?.ownerDocument.defaultView;
    if (!window) return;
    this.timer = window.setTimeout(() => {
      this.timer = null;
      void this.plugin.getKnowledgeSurfaceService()?.getInitializationState().then((job) => { this.job = job; this.jobLoaded = true; if (this.root?.isConnected) this.redraw(); });
    }, 1000);
  }
  private async pickFolder(parent: boolean, zh: boolean): Promise<string | null> {
    return new Promise((resolve) => {
      const modal = new Modal(this.plugin.app);
      modal.modalEl.addClass("echoink-theme-boundary");
      modal.onOpen = () => {
        modal.titleEl.setText(zh ? (parent ? "选择父目录" : "选择已有目录") : "Choose folder");
        const list = modal.contentEl.createDiv({ cls: "settings-card settings-stack" });
        if (parent) createSettingsNavigationRow(list, { title: zh ? "Vault 根目录" : "Vault root", onActivate: () => { resolve(""); modal.close(); } });
        for (const folder of this.plugin.app.vault.getAllLoadedFiles().filter((file): file is TFolder => file instanceof TFolder && !!file.path).sort((a, b) => a.path.localeCompare(b.path))) createSettingsNavigationRow(list, { title: folder.path, onActivate: () => { resolve(folder.path); modal.close(); } });
      };
      modal.onClose = () => { disposeOriginControls(modal.contentEl); resolve(null); };
      modal.open();
    });
  }
}
