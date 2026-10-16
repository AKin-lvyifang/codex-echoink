import type { KnowledgeInitializationJob } from "../knowledge-base/initializer";
import { Modal, Notice, TFolder, setIcon } from "obsidian";
import type CodexForObsidianPlugin from "../main";
import { KNOWLEDGE_ROOT_NAMES, KNOWLEDGE_ROOT_ROLES, type KnowledgeRootRole } from "../knowledge-base/root-paths-core";
import { emptyKnowledgeFolderBindings, knowledgeFolderBindingsSignature, knowledgeFolderIssues, knowledgeMaintenanceFolderIssues, type KnowledgeFolderBindings } from "../knowledge-base/folder-bindings";
import type { KnowledgeDirectoryMode, KnowledgeDirectoryPlan } from "../knowledge-base/folder-plan";
import { OriginSetting } from "./origin-setting";
import { createOriginButton, createOriginCheck, createOriginSwitch, disposeOriginControls } from "./origin-controls";
import { attachSettingsTooltip, createSettingsGroup, createSettingsNavigationRow, createSettingsPage, createSettingsSection } from "./settings-v2";
import { applyAmicroButton, setAmicroButtonPending } from "./amicro-buttons";

const LABELS: Record<KnowledgeRootRole, [string, string]> = {
  raw: ["资料来源", "Sources"], wiki: ["知识成果", "Knowledge"], projects: ["项目", "Projects"], outputs: ["输出", "Outputs"], inbox: ["收件箱", "Inbox"], journal: ["日记", "Journal"], work: ["工作", "Work"], archive: ["归档", "Archive"], templates: ["模板", "Templates"], assets: ["附件", "Attachments"]
};
const DESCRIPTIONS: Record<KnowledgeRootRole, [string, string]> = {
  raw: ["保存原始收藏和材料。", "Keep original collections and source material."], wiki: ["保存提炼后的主题知识。", "Keep distilled knowledge by topic."], projects: ["保存项目型知识。", "Keep project knowledge."], outputs: ["保存英文日记、表达库等产物。", "Keep English diary, expression library, and other outputs."], inbox: ["保存临时笔记。", "Keep temporary notes."], journal: ["保存日常记录。", "Keep daily records."], work: ["保存正在整理的工作资料。", "Keep material used for ongoing work."], archive: ["保存已归档的内容。", "Keep archived content."], templates: ["保存笔记模板。", "Keep note templates."], assets: ["保存图片等引用附件；收藏的 PDF 仍属于资料来源。", "Keep images and referenced attachments; collected PDFs stay in Sources."]
};
const label = (role: KnowledgeRootRole, zh: boolean) => LABELS[role][zh ? 0 : 1];

/** A saved binding is sufficient; no new onboarding flag is required for upgrades. */
export function knowledgeFoldersConfigured(config: KnowledgeFolderBindings | null | undefined, exists?: (path: string) => boolean): boolean {
  if (!config) return false;
  if ((config as KnowledgeFolderBindings & { configured?: boolean }).configured === true) return true;
  if (knowledgeFolderIssues(config).length > 0) return false;
  const enabled = KNOWLEDGE_ROOT_ROLES.filter(role => config.roles[role].enabled);
  return enabled.length > 0
    && (!config.roles.raw.enabled || (["wiki", "projects"] as const).some(role => config.roles[role].enabled && !!config.roles[role].writePath))
    && enabled.every(role => config.roles[role].readPaths.every(path => !exists || exists(path)));
}

/** Summarize saved choices, never an uncommitted draft or assumed default roots. */
export function knowledgeFolderPlanSummary(config: KnowledgeFolderBindings | null | undefined, exists: (path: string) => boolean, zh: boolean): string {
  if (!knowledgeFoldersConfigured(config)) return zh ? "尚未初始化" : "Not initialized";
  if (KNOWLEDGE_ROOT_ROLES.some(role => config!.roles[role].enabled && !config!.roles[role].native && config!.roles[role].readPaths.some(path => !exists(path)))) return zh ? "有目录已失效" : "Some folders are no longer available";
  const count = (roles: KnowledgeRootRole[]) => roles.reduce((total, role) => total + (config!.roles[role].enabled ? config!.roles[role].readPaths.filter(exists).length : 0), 0);
  const inbox = config!.roles.inbox.enabled ? (zh ? "收件箱已启用" : "Inbox enabled") : (zh ? "收件箱未启用" : "Inbox disabled");
  return zh ? `来源 ${count(["raw"])} 个 · 成果 ${count(["wiki", "projects"])} 个 · ${inbox}` : `${count(["raw"])} source folders · ${count(["wiki", "projects"])} result folders · ${inbox}`;
}

function folderErrorText(error: unknown, zh: boolean): string {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  if (/revision|stale|预览.*(?:变化|过期)|目录.*已变化/iu.test(message)) return zh ? "目录已变化，请重新预览" : "Folders have changed. Preview the plan again.";
  return message.replace(/默认保存位置/gu, zh ? "收藏保存位置" : "Collection destination") || (zh ? "目录操作未完成，请重试" : "Folder operation did not complete. Try again.");
}

/** Editing only changes this draft. Files and saved settings belong to the service. */
export class KnowledgeFolderDraft {
  readonly baseline: KnowledgeFolderBindings;
  bindings: KnowledgeFolderBindings;
  mode: KnowledgeDirectoryMode | null;
  readonly names = new Map<KnowledgeRootRole, string>();
  readonly parents = new Map<KnowledgeRootRole, string>();
  readonly createdRoles = new Set<KnowledgeRootRole>();
  constructor(saved: KnowledgeFolderBindings | null | undefined, readonly initialized = knowledgeFoldersConfigured(saved)) {
    this.baseline = structuredClone(saved ?? emptyKnowledgeFolderBindings());
    for (const binding of Object.values(this.baseline.roles)) binding.allowedSubdirectoryRoots ??= [...binding.readPaths];
    this.bindings = structuredClone(this.baseline);
    this.mode = initialized ? "existing" : null;
  }
  get dirty(): boolean { return knowledgeFolderBindingsSignature(this.bindings) !== knowledgeFolderBindingsSignature(this.baseline); }
  get createPaths(): string[] { return [...this.createdRoles].filter(role => this.bindings.roles[role].enabled && !this.bindings.roles[role].native).flatMap(role => this.bindings.roles[role].readPaths); }
  get issues(): string[] {
    const names = [...this.createdRoles].filter(role => this.bindings.roles[role].enabled && (!this.names.get(role)?.trim() || /[/\\]/u.test(this.names.get(role)!)))
      .map(role => `${LABELS[role][0]}：请填写不含路径分隔符的目录名称。`);
    return [...names, ...knowledgeFolderIssues(this.bindings), ...knowledgeMaintenanceFolderIssues(this.bindings, this.baseline, this.mode === "build")];
  }
  choose(mode: KnowledgeDirectoryMode): void {
    this.mode = mode;
    if (mode === "build") {
      this.bindings = structuredClone(this.baseline);
      for (const role of KNOWLEDGE_ROOT_ROLES) {
        this.bindings.roles[role].enabled = this.bindings.roles[role].native === true;
        this.names.set(role, KNOWLEDGE_ROOT_NAMES[role]);
        this.parents.set(role, ""); this.createdRoles.add(role);
      }
      for (const role of ["raw", "wiki"] as const) this.enable(role, true);
    }
  }
  enable(role: KnowledgeRootRole, enabled: boolean): void {
    this.bindings.roles[role].enabled = enabled;
    if (enabled && this.createdRoles.has(role)) this.updateNew(role);
  }
  bind(role: KnowledgeRootRole, path: string, previous?: string): void {
    const binding = this.bindings.roles[role];
    if (path === previous) { binding.enabled = true; return; }
    if (previous) binding.readPaths = binding.readPaths.map(item => item === previous ? path : item);
    else binding.readPaths = role === "raw" ? [...binding.readPaths, path] : [path];
    binding.readPaths = [...new Set(binding.readPaths)];
    // Legacy child approvals retain their original roots; binding never grants new ones.
    binding.autoOrganizePaths = (binding.autoOrganizePaths ?? []).filter(item => binding.readPaths.includes(item) && item !== previous);
    if (binding.writePath === previous) binding.writePath = path;
    if (binding.readPaths.length === 1) binding.writePath = path;
    binding.enabled = true; binding.compatibilityReadScopes = false;
  }
  unbind(role: KnowledgeRootRole, path: string): void {
    const binding = this.bindings.roles[role];
    binding.readPaths = binding.readPaths.filter(item => item !== path);
    binding.autoOrganizePaths = (binding.autoOrganizePaths ?? []).filter(item => item !== path);
    if (binding.writePath === path) binding.writePath = null;
    if (binding.readPaths.length === 1) binding.writePath = binding.readPaths[0];
    if (!binding.readPaths.length) binding.enabled = false;
  }
  organize(role: KnowledgeRootRole, path: string, allowed: boolean): void {
    const binding = this.bindings.roles[role];
    binding.autoOrganizePaths = (binding.autoOrganizePaths ?? []).filter(item => item !== path && binding.readPaths.includes(item));
    if (allowed && binding.readPaths.includes(path)) binding.autoOrganizePaths.push(path);
  }
  updateNew(role: KnowledgeRootRole): void {
    const binding = this.bindings.roles[role];
    const name = (this.names.get(role) ?? "").trim();
    const parent = this.parents.get(role) ?? "";
    const path = name ? (parent ? `${parent}/${name}` : name) : "";
    const previous = binding.readPaths[0];
    binding.readPaths = path ? [path] : []; binding.writePath = path || null;
    // Keep legacy approval roots unchanged. A different root also needs fresh consent.
    if (path !== previous) binding.autoOrganizePaths = [];
  }
}

interface FolderNavigation { open(): void; close(): void }
let folderDrawerSequence = 0;

export class KnowledgeFolderSection {
  private draft: KnowledgeFolderDraft;
  private preview: KnowledgeDirectoryPlan | null = null;
  private busy = false;
  private error = "";
  private root: HTMLElement | null = null;
  private footer: HTMLElement | null = null;
  private issueEl: HTMLElement | null = null;
  private leavePrompt = false;
  private pendingLeave: (() => void) | null = null;
  private localOpen = false;
  private opened = false;
  private animateEntry = false;
  private readonly expandedRoles = new Set<KnowledgeRootRole>();
  private readonly selectingRoles = new Set<KnowledgeRootRole>();
  private readonly drawerMotionCleanups = new Set<() => void>();
  private readonly drawerId = ++folderDrawerSequence;
  private timer: number | null = null;
  private job: Readonly<KnowledgeInitializationJob> | null = null;
  private jobLoading = false;
  private jobLoaded = false;
  constructor(private readonly plugin: CodexForObsidianPlugin, private readonly redraw: () => void, private readonly navigation?: FolderNavigation) {
    this.draft = this.readDraft();
  }
  private readDraft(): KnowledgeFolderDraft {
    const saved = this.plugin.settings.knowledgeBase.folderBindings;
    // Native settings are an effective snapshot, never a mutation of plugin data.
    // Their presence alone does not turn a first-time user into a configured one.
    const effective = structuredClone(saved ?? emptyKnowledgeFolderBindings());
    // Freeze legacy approvals before replacing an old native root with live settings.
    for (const binding of Object.values(effective.roles)) binding.allowedSubdirectoryRoots ??= [...binding.readPaths];
    const nativePlugins = (this.plugin.app as unknown as { internalPlugins?: { plugins?: Record<string, { instance?: { options?: { folder?: string } } }> } }).internalPlugins?.plugins;
    for (const [role, id] of [["journal", "daily-notes"], ["templates", "templates"]] as const) {
      const folder = nativePlugins?.[id]?.instance?.options?.folder;
      if (typeof folder !== "string") continue;
      const binding = effective.roles[role];
      binding.native = true; binding.enabled = true;
      binding.readPaths = folder ? [folder] : []; binding.writePath = folder || null;
      binding.autoOrganizePaths = (binding.autoOrganizePaths ?? []).filter(path => binding.readPaths.includes(path));
    }
    return new KnowledgeFolderDraft(effective, knowledgeFoldersConfigured(saved));
  }
  get showDashboard(): boolean { return this.readDraft().initialized; }
  get hasDraft(): boolean { return this.draft.dirty; }
  get submitting(): boolean { return this.busy; }
  invalidate(): void { this.jobLoaded = false; }
  dispose(): void {
    this.clearDrawerMotion();
    if (this.root) disposeOriginControls(this.root);
    if (this.timer !== null) this.root?.ownerDocument.defaultView?.clearTimeout(this.timer);
    this.timer = null; this.root = null; this.footer = null; this.issueEl = null;
  }
  render(page: HTMLElement, zh: boolean): void {
    if (this.localOpen) { this.renderDetail(page, zh); return; }
    createSettingsNavigationRow(page, {
      title: zh ? "目录方案" : "Folder plan",
      description: knowledgeFolderPlanSummary(this.plugin.settings.knowledgeBase.folderBindings, path => this.plugin.app.vault.getAbstractFileByPath(path) instanceof TFolder, zh),
      focusKey: "knowledge:onboarding",
      onActivate: () => {
        if (!this.draft.dirty) { this.draft = this.readDraft(); this.preview = null; this.expandedRoles.clear(); }
        this.opened = true; this.leavePrompt = false; this.animateEntry = true;
        if (this.navigation) this.navigation.open(); else { this.localOpen = true; this.redraw(); }
      }
    });
  }
  renderDetail(container: HTMLElement, zh: boolean): void {
    this.clearDrawerMotion();
    if (!this.opened) { this.draft = this.readDraft(); this.opened = true; this.animateEntry = true; }
    const page = createSettingsPage(container, {
      title: this.preview ? (zh ? "预览目录方案" : "Preview folder plan") : this.draft.initialized ? (zh ? "目录方案" : "Folder plan") : (zh ? "初始化知识库" : "Initialize knowledge base"),
      detail: true, backLabel: zh ? (this.preview ? "返回修改" : "返回知识库") : (this.preview ? "Back to editing" : "Back to knowledge"),
      onBack: () => this.back()
    });
    page.addClass("echoink-knowledge-folder-panel");
    if (this.animateEntry) page.addClass("is-entering");
    this.animateEntry = false;
    this.root = page; this.footer = null; this.issueEl = null;
    const manager = this.plugin.getKnowledgeSurfaceService();
    const locked = this.busy || manager?.folderOperationBusy === true;
    const back = page.querySelector<HTMLButtonElement>(".settings-back");
    if (back) back.disabled = this.busy;
    if (this.error) page.createDiv({ cls: "settings-error", text: this.error, attr: { role: "alert" } });
    if (this.busy) page.createDiv({ cls: "echoink-folder-status", text: zh ? (this.preview ? "正在应用目录方案…" : "正在读取目录与资料…") : (this.preview ? "Applying folder plan…" : "Reading folders and material…"), attr: { role: "status", "aria-live": "polite" } });
    if (this.leavePrompt) this.renderLeavePrompt(page, zh);
    if (this.preview) { this.renderPreview(page, zh, locked); return; }
    if (!this.draft.mode) {
      const routes = createSettingsSection(page, { surface: "flat" });
      routes.addClass("echoink-folder-routes");
      for (const mode of ["existing", "build"] as const) createSettingsNavigationRow(routes, {
        title: mode === "existing" ? (zh ? "使用现有" : "Use existing") : (zh ? "帮我搭建" : "Build for me"),
        description: mode === "existing" ? (zh ? "保留原有结构，选择各用途使用的文件夹。" : "Keep your structure and select folders for each purpose.") : (zh ? "创建所需目录，预览后集中原始资料并提炼知识。" : "Create selected folders, review material moves, and refine knowledge."),
        onActivate: () => {
          if (locked) return;
          this.draft.choose(mode); this.expandedRoles.clear();
          if (mode === "build") { this.expandedRoles.add("raw"); this.expandedRoles.add("wiki"); }
          this.redraw();
        }
      });
      return;
    }
    const group = createSettingsGroup(page);
    group.addClass("echoink-folder-drawers");
    for (const role of KNOWLEDGE_ROOT_ROLES) this.renderRole(group, role, zh, locked);
    this.issueEl = page.createDiv({ cls: "echoink-folder-issues", attr: { "aria-live": "polite" } });
    this.footer = page.createDiv({ cls: "echoink-knowledge-init-actions" });
    this.updateFooter(zh, locked);
    this.renderJob(page, zh);
  }
  private back(): void {
    if (this.busy) return;
    if (this.preview) { this.preview = null; this.error = ""; this.redraw(); return; }
    this.requestLeave();
  }
  requestLeave(onLeave?: () => void): void {
    if (this.busy) return;
    this.pendingLeave = onLeave ?? null;
    if (this.draft.dirty) { this.leavePrompt = true; this.redraw(); return; }
    this.close();
  }
  private close(): void {
    this.localOpen = false; this.leavePrompt = false;
    const pending = this.pendingLeave; this.pendingLeave = null;
    if (pending) pending();
    else if (this.navigation) this.navigation.close(); else this.redraw();
  }
  private renderLeavePrompt(page: HTMLElement, zh: boolean): void {
    const panel = page.createDiv({ cls: "echoink-settings-inline-confirm", attr: { role: "group", "aria-label": zh ? "尚未应用的目录修改" : "Unapplied folder changes" } });
    panel.createEl("p", { text: zh ? "目录修改尚未应用。返回时可以保留草稿，或放弃这次修改。" : "Your changes have not been applied. Keep the draft or discard it when leaving." });
    const actions = panel.createDiv({ cls: "echoink-knowledge-init-actions" });
    createOriginButton(actions, { text: zh ? "继续编辑" : "Keep editing" }).onclick = () => { this.leavePrompt = false; this.pendingLeave = null; this.redraw(); };
    createOriginButton(actions, { cls: "settings-danger", text: zh ? "放弃修改" : "Discard changes" }).onclick = () => { this.draft = this.readDraft(); this.preview = null; this.expandedRoles.clear(); this.error = ""; this.close(); };
    createOriginButton(actions, { cls: "mod-cta", text: zh ? "保留草稿并返回" : "Keep draft and leave" }).onclick = () => this.close();
  }
  private renderRole(group: HTMLElement, role: KnowledgeRootRole, zh: boolean, locked: boolean): void {
    const binding = this.draft.bindings.roles[role];
    const created = this.draft.createdRoles.has(role) && !binding.native;
    const missing = created || binding.native ? [] : binding.readPaths.filter(path => !(this.plugin.app.vault.getAbstractFileByPath(path) instanceof TFolder));
    const purpose = createSettingsSection(group, { surface: "group" });
    purpose.addClass("echoink-folder-purpose"); purpose.setAttr("data-folder-role", role);
    const header = purpose.createDiv({ cls: "echoink-folder-purpose-header" });
    const top = header.createDiv({ cls: "echoink-folder-header-top" });
    const contentId = `echoink-folder-${this.drawerId}-${role}`;
    const copy = top.createDiv({ cls: "echoink-folder-purpose-copy" });
    const title = copy.createDiv({ cls: "echoink-folder-purpose-title setting-item-name" });
    const disclosure = createOriginButton(title, {
      cls: "echoink-folder-disclosure text-button", text: label(role, zh),
      attr: { "aria-label": label(role, zh), "aria-controls": contentId, "aria-expanded": String(binding.enabled && this.expandedRoles.has(role)) }
    });
    // A disabled purpose stays readable; only its disclosure action is unavailable.
    disclosure.setAttr("aria-disabled", String(locked || !binding.enabled));
    const help = title.createSpan({ cls: "echoink-settings-help" });
    const helpId = `echoink-folder-purpose-${this.drawerId}-${role}-help`;
    const helpTrigger = createOriginButton(help, { cls: "echoink-folder-purpose-help is-icon", attr: { "aria-labelledby": helpId } });
    setIcon(helpTrigger, "circle-alert");
    helpTrigger.createSpan({ cls: "echoink-folder-help-label", text: zh ? `${label(role, zh)}用途说明` : `${label(role, zh)} purpose`, attr: { id: helpId } });
    attachSettingsTooltip(helpTrigger, DESCRIPTIONS[role][zh ? 0 : 1], help);
    help.addEventListener("click", event => event.stopPropagation());
    help.addEventListener("keydown", event => { if (event.key === "Enter" || event.key === " ") event.stopPropagation(); });
    const tags = title.createSpan({ cls: "echoink-folder-tags echoink-folder-command-badges" });
    if (["raw", "wiki", "projects"].includes(role)) for (const command of ["/ask", "/maintain"]) tags.createSpan({ cls: "echoink-folder-tag echoink-folder-command-badge", text: command });
    setIcon(disclosure.createSpan({ cls: "echoink-folder-chevron", attr: { "aria-hidden": "true" } }), "chevron-right");
    const enabled = createOriginSwitch(top, { cls: "echoink-folder-enable", attr: { "aria-label": label(role, zh), "data-folder-control": "enabled" } });
    enabled.setAttr("role", "switch");
    enabled.checked = binding.enabled; enabled.disabled = locked || !!binding.native || this.selectingRoles.has(role);
    enabled.onchange = () => {
      if (locked || binding.native || this.selectingRoles.has(role)) return;
      if (enabled.checked) {
        // Selection is provisional. Cancellation must leave both draft and switch off.
        enabled.checked = false;
        this.chooseFolder(role, zh, binding.readPaths[0]);
      } else {
        this.draft.enable(role, false); this.expandedRoles.delete(role);
        this.error = ""; this.redraw();
      }
    };
    const summaryLine = header.createDiv({ cls: "echoink-folder-header-summary" });
    const path = binding.readPaths[0];
    const summary = !binding.enabled ? (zh ? "未启用" : "Disabled")
      : missing.length ? (zh ? "原目录已失效" : "Original folder is no longer available")
      : created ? `${zh ? "待创建" : "To be created"} · ${path ?? ""}`
      : path ? `${path}${binding.readPaths.length > 1 ? (zh ? ` 等 ${binding.readPaths.length} 个文件夹` : ` and ${binding.readPaths.length - 1} more folders`) : ""}`
      : binding.native ? (zh ? "仓库根目录" : "Vault root") : (zh ? "原目录已失效" : "Original folder is no longer available");
    summaryLine.createDiv({ cls: "echoink-folder-summary", text: summary });
    if (binding.enabled && !binding.native && (missing.length || !binding.readPaths.length)) {
      const reselect = createOriginButton(summaryLine, { text: zh ? "重新选择" : "Choose again" });
      reselect.disabled = locked || this.selectingRoles.has(role);
      reselect.onclick = event => { event.stopPropagation(); this.chooseFolder(role, zh, missing[0]); };
    }
    // Keep the existing mobile structure. Desktop's extra grid track can shrink
    // around the padded content without measuring or retaining a fixed height.
    const desktop = !purpose.ownerDocument.body.classList.contains("is-mobile");
    const viewport = desktop ? purpose.createDiv({ cls: "echoink-folder-drawer-viewport" }) : null;
    const contentParent = viewport ? viewport.createDiv({ cls: "echoink-folder-drawer-clip" }) : purpose;
    const nested = contentParent.createDiv({ cls: "echoink-folder-bindings", attr: { id: contentId } });
    let cancelMotion: (() => void) | null = null;
    const updateExpanded = (animate = false) => {
      const expanded = binding.enabled && this.expandedRoles.has(role);
      cancelMotion?.();
      const win = purpose.ownerDocument.defaultView;
      const reducedMotion = win?.matchMedia?.("(prefers-reduced-motion: reduce)");
      const shouldAnimate = animate && viewport && win && !reducedMotion?.matches;
      if (!expanded && nested.contains(purpose.ownerDocument.activeElement)) disclosure.focus({ preventScroll: true });
      nested.inert = !expanded;
      nested.setAttr("aria-hidden", String(!expanded));
      if (shouldAnimate) {
        const wasHidden = nested.hidden;
        nested.hidden = false;
        viewport.addClass("is-animating");
        // Establish the collapsed track before revealing a previously hidden body.
        // A reversal keeps its current interpolated size and needs no forced reset.
        if (wasHidden) void viewport.offsetHeight;
        const cleanup = () => {
          win.clearTimeout(timeout);
          viewport.removeEventListener("transitionend", onTransitionEnd);
          reducedMotion?.removeEventListener("change", onMotionChange);
          this.drawerMotionCleanups.delete(cleanup);
          cancelMotion = null;
        };
        const finish = () => {
          cleanup();
          viewport.removeClass("is-animating");
          nested.hidden = !expanded;
        };
        const onTransitionEnd = (event: TransitionEvent) => {
          if (event.target === viewport && event.propertyName === "grid-template-rows") finish();
        };
        const onMotionChange = () => { if (reducedMotion?.matches) finish(); };
        const timeout = win.setTimeout(finish, 240);
        viewport.addEventListener("transitionend", onTransitionEnd);
        reducedMotion?.addEventListener("change", onMotionChange);
        this.drawerMotionCleanups.add(cleanup);
        cancelMotion = cleanup;
      } else {
        viewport?.removeClass("is-animating");
        nested.hidden = !expanded;
      }
      disclosure.setAttr("aria-expanded", String(expanded));
      purpose.toggleClass("is-expanded", expanded);
      if (!expanded) purpose.querySelectorAll<HTMLElement>(".echoink-folder-help, .echoink-folder-purpose-help").forEach(trigger => trigger.dispatchEvent(new trigger.ownerDocument.defaultView!.Event("blur")));
    };
    const toggleExpanded = () => {
      if (locked || !binding.enabled || this.selectingRoles.has(role)) return;
      if (this.expandedRoles.has(role)) this.expandedRoles.delete(role); else this.expandedRoles.add(role);
      updateExpanded(true);
    };
    disclosure.onclick = event => { event.stopPropagation(); toggleExpanded(); };
    disclosure.onkeydown = event => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault(); event.stopPropagation(); toggleExpanded();
    };
    header.onclick = event => {
      // Let Origin/Radix receive the original switch event before deciding
      // whether a click on the header's empty area should fold the drawer.
      if ((event.target as Element).closest("button, input, select, a")) return;
      toggleExpanded();
    };
    updateExpanded();
    if (!binding.enabled) return;
    if (binding.native) {
      new OriginSetting(nested).setName(zh ? "沿用 Obsidian 设置" : "Use Obsidian settings").setDesc(binding.readPaths.join("、") || (zh ? "仓库根目录" : "Vault root"))
        .addOriginButton(button => button.setButtonText(zh ? "编辑 Obsidian 设置" : "Edit Obsidian settings").setDisabled(locked).onClick(() => {
          const settings = (this.plugin.app as unknown as { setting?: { open(): void; openTabById(id: string): void } }).setting;
          settings?.open(); settings?.openTabById(role === "journal" ? "daily-notes" : "templates");
        }));
      return;
    }
    const listHeader = nested.createDiv({ cls: "echoink-folder-list-header" });
    listHeader.createSpan({ text: zh ? "指定文件夹" : "Assigned folders" });
    if (role === "raw" && !created) {
      const add = createOriginButton(listHeader, { cls: "is-icon icon-button", attr: { "aria-label": zh ? "添加来源目录" : "Add source folder" } });
      setIcon(add, "plus"); add.disabled = locked || this.selectingRoles.has(role);
      add.onclick = () => this.chooseFolder(role, zh);
    }
    for (const path of binding.readPaths) {
      const item = nested.createDiv({ cls: "echoink-folder-binding echoink-folder-binding-item", attr: { "data-folder-path": path } });
      const line = item.createDiv({ cls: "echoink-folder-path-row echoink-folder-binding-row" });
      const choose = createOriginButton(line, { cls: "echoink-folder-path text-button", attr: { "aria-label": `${zh ? "重新选择" : "Choose another folder"} · ${path}` } });
      setIcon(choose.createSpan({ cls: "echoink-folder-icon" }), "folder");
      choose.createSpan({ text: created ? `${zh ? "待创建" : "To be created"} · ${path}` : path });
      choose.disabled = locked || this.selectingRoles.has(role); choose.onclick = () => this.chooseFolder(role, zh, path);
      if (missing.includes(path)) {
        item.addClass("is-invalid");
        line.createSpan({ cls: "echoink-folder-path-state", text: zh ? "原目录已失效" : "Unavailable" });
      }
      const remove = createOriginButton(line, { cls: "is-icon icon-button", attr: { "aria-label": `${zh ? "解绑文件夹" : "Unbind folder"} · ${path}` } });
      setIcon(remove, "trash-2"); remove.disabled = locked;
      remove.onclick = () => { this.draft.unbind(role, path); this.error = ""; this.redraw(); };
      this.renderOrganize(item, role, path, zh, locked);
    }
    if (!binding.readPaths.length) {
      const select = createOriginButton(nested, { text: zh ? "选择目录" : "Choose folder" });
      select.disabled = locked || this.selectingRoles.has(role); select.onclick = () => this.chooseFolder(role, zh);
    }
    if (role === "raw" && binding.readPaths.length > 1) new OriginSetting(nested).setClass("echoink-folder-write-location").setName(zh ? "收藏保存位置" : "Collection destination")
      .addOriginDropdown(this.plugin.app, select => {
        select.selectEl.setAttribute("aria-label", zh ? "收藏保存位置" : "Collection destination");
        select.addOption("unbound", zh ? "请选择收藏保存位置" : "Choose collection destination");
        for (const path of binding.readPaths) select.addOption(path, path);
        select.setValue(binding.writePath ?? "unbound").setDisabled(locked).onChange(path => { binding.writePath = path === "unbound" ? null : path; this.updateFooter(zh, locked); });
      });
  }
  private clearDrawerMotion(): void {
    for (const cleanup of this.drawerMotionCleanups) cleanup();
  }
  private renderOrganize(parent: HTMLElement, role: KnowledgeRootRole, path: string, zh: boolean, locked: boolean): void {
    const row = new OriginSetting(parent).setClass("echoink-folder-organize");
    row.infoEl.empty(); row.controlEl.remove();
    const option = row.infoEl.createDiv({ cls: "echoink-folder-organize-option" });
    // The checkbox owns its state; the label also provides a reliable touch target.
    const checkId = `echoink-folder-organize-${this.drawerId}-${role}-${this.draft.bindings.roles[role].readPaths.indexOf(path)}`;
    const check = createOriginCheck(option, { attr: { id: checkId, "aria-label": `${zh ? "允许 Agent 自动整理" : "Allow Agent organization"} · ${path}`, "data-folder-control": "organize" } });
    check.setAttr("role", "checkbox");
    check.checked = this.draft.bindings.roles[role].autoOrganizePaths?.includes(path) ?? false;
    check.disabled = locked;
    check.onchange = () => { this.draft.organize(role, path, check.checked); this.updateFooter(zh, locked); };
    option.createEl("label", { text: zh ? "允许 Agent 自动整理" : "Allow Agent organization", attr: { for: checkId } });
    const help = option.createSpan({ cls: "echoink-settings-help" });
    const helpLabelId = `${checkId}-help-label`;
    const trigger = createOriginButton(help, { cls: "echoink-folder-help is-icon", attr: { "aria-labelledby": helpLabelId } });
    setIcon(trigger, "circle-alert");
    trigger.createSpan({
      cls: "echoink-folder-help-label",
      text: zh ? "自动整理权限说明" : "Agent organization permission details",
      attr: { id: helpLabelId }
    });
    attachSettingsTooltip(trigger, zh ? "允许 Agent 在这个文件夹内创建分类文件夹，并移动文件进行归类。" : "Allow Agent to create category folders and move files within this folder.", help);
  }

  private chooseFolder(role: KnowledgeRootRole, zh: boolean, previous?: string): void {
    if (this.selectingRoles.has(role) || this.busy) return;
    this.selectingRoles.add(role);
    const created = this.draft.createdRoles.has(role);
    const selection = created ? this.configureNewFolder(role, zh) : this.pickFolder(false, zh, previous);
    this.redraw();
    void selection.then(result => {
      if (result === null) return;
      if (typeof result === "string") this.draft.bind(role, result, previous);
      else {
        this.draft.names.set(role, result.name); this.draft.parents.set(role, result.parent);
        this.draft.enable(role, true);
      }
      this.expandedRoles.add(role); this.error = "";
    }).catch(error => { this.error = folderErrorText(error, zh); })
      .finally(() => {
        this.selectingRoles.delete(role); this.redraw();
        this.root?.querySelector<HTMLElement>(`[data-folder-role="${role}"] [data-folder-control="enabled"]`)?.focus({ preventScroll: true });
      });
  }
  private updateFooter(zh: boolean, locked: boolean): void {
    if (!this.footer || !this.issueEl) return;
    disposeOriginControls(this.footer); this.footer.empty(); this.issueEl.empty();
    for (const issue of this.draft.issues) this.issueEl.createDiv({ cls: "settings-error", text: folderErrorText(issue, zh) });
    if (!this.draft.dirty) return;
    const preview = createOriginButton(this.footer, { cls: "mod-cta", text: zh ? "预览方案" : "Preview plan" });
    applyAmicroButton(preview, { variant: "primary" });
    preview.disabled = locked || !this.plugin.getKnowledgeSurfaceService() || this.draft.issues.length > 0;
    preview.onclick = () => void this.run(async () => {
      this.preview = await this.plugin.getKnowledgeSurfaceService()!.previewDirectoryPlan(this.draft.bindings, this.draft.createPaths, { mode: this.draft.mode ?? "existing" });
    });
  }
  private renderPreview(page: HTMLElement, zh: boolean, locked: boolean): void {
    const plan = this.preview!;
    const group = createSettingsGroup(page);
    for (const change of plan.changes) {
      const before = change.before.enabled ? change.before.readPaths.join("、") || (change.before.native ? (zh ? "仓库根目录" : "Vault root") : "—") : (zh ? "未启用" : "Disabled");
      const after = change.after.enabled ? change.after.readPaths.join("、") || (change.after.native ? (zh ? "仓库根目录" : "Vault root") : "—") : (zh ? "未启用" : "Disabled");
      new OriginSetting(group).setName(label(change.role, zh)).setDesc(`${before} → ${after}`);
      if (change.role === "raw" && change.before.writePath !== change.after.writePath && change.after.readPaths.length > 1) new OriginSetting(group).setName(zh ? "收藏保存位置" : "Collection destination").setDesc(`${change.before.writePath ?? "—"} → ${change.after.writePath ?? "—"}`);
      const paths = [...new Set([...(change.before.autoOrganizePaths ?? []), ...(change.after.autoOrganizePaths ?? [])])];
      for (const path of paths) {
        const beforeAllowed = change.before.autoOrganizePaths?.includes(path) ?? false;
        const afterAllowed = change.after.autoOrganizePaths?.includes(path) ?? false;
        if (beforeAllowed !== afterAllowed) new OriginSetting(group).setName(`${zh ? "自动整理" : "Agent organization"} · ${path}`).setDesc(afterAllowed ? (zh ? "关闭 → 允许" : "Off → Allowed") : (zh ? "允许 → 关闭" : "Allowed → Off"));
      }
    }
    if (plan.create.length) {
      const create = createSettingsSection(page, { title: zh ? `创建目录 · ${plan.create.length}` : `Create folders · ${plan.create.length}` });
      for (const path of plan.create) create.createDiv({ cls: "echoink-folder-plan-path", text: path });
    }
    if (plan.moves.length) {
      const moves = createSettingsSection(page, { title: zh ? `搬迁文件 · ${plan.moves.length}` : `Move files · ${plan.moves.length}` });
      const list = moves.createDiv({ cls: "echoink-folder-moves" });
      for (const move of plan.moves) list.createDiv({ cls: "echoink-folder-plan-path", text: `${move.from} → ${move.to}` });
    }
    if (plan.mode === "build") {
      new OriginSetting(page).setName(zh ? `待提炼 · ${plan.sources.length} 篇` : `Sources to refine · ${plan.sources.length}`)
        .setDesc(zh ? "确认后先完成目录配置与搬迁，再尝试启动知识提炼。未配置模型不影响目录配置。" : "Confirmation configures folders and moves material, then attempts refinement. A model is not required for folder setup.");
    } else {
      new OriginSetting(page).setName(zh ? "应用范围" : "Changes to apply")
        .setDesc(zh ? "本次只应用绑定和权限修改，不搬迁既有文件。" : "Apply bindings and permissions without moving existing files.");
    }
    if (plan.excluded.length) {
      const details = page.createEl("details");
      details.createEl("summary", { text: zh ? `保持原位 · ${plan.excluded.length}` : `Keep in place · ${plan.excluded.length}` });
      const list = details.createDiv({ cls: "echoink-folder-moves" });
      for (const item of plan.excluded) list.createDiv({ cls: "echoink-folder-plan-path", text: `${item.path} · ${item.reason}` });
    }
    for (const issue of plan.issues) page.createDiv({ cls: "settings-error", text: folderErrorText(issue, zh), attr: { role: "alert" } });
    const actions = page.createDiv({ cls: "echoink-knowledge-init-actions" });
    const back = createOriginButton(actions, { text: zh ? "返回修改" : "Back to editing" });
    back.disabled = locked; back.onclick = () => this.back();
    const apply = createOriginButton(actions, { cls: "mod-cta", text: this.draft.initialized ? (zh ? "应用修改" : "Apply changes") : (zh ? "确认初始化" : "Confirm initialization") });
    applyAmicroButton(apply, { variant: "primary" }); setAmicroButtonPending(apply, this.busy);
    apply.disabled = locked || plan.issues.length > 0 || ((plan.create.length > 0 || plan.moves.length > 0) && this.plugin.getKnowledgeSurfaceService()?.directoryWritable === false);
    apply.onclick = () => void this.apply(zh);
  }
  private async apply(zh: boolean): Promise<void> {
    if (!this.preview) return;
    await this.run(async () => {
      const plan = this.preview!;
      let result;
      try { result = await this.plugin.getKnowledgeSurfaceService()!.applyDirectoryPlan(plan, plan.mode === "build"); }
      catch (error) {
        const message = folderErrorText(error, zh);
        if (message === (zh ? "目录已变化，请重新预览" : "Folders have changed. Preview the plan again.")) this.preview = null;
        throw new Error(message);
      }
      this.draft = this.readDraft(); this.preview = null; this.expandedRoles.clear(); this.jobLoaded = false;
      if (plan.mode === "build") {
        const refinement = result.refinement === "started" ? (zh ? "知识提炼已开始。" : "Knowledge refinement started.") : result.refinement === "failed" ? (zh ? `知识提炼未成功：${result.refinementError ?? "请在知识库中重试"}` : `Refinement failed: ${result.refinementError ?? "Retry from Knowledge"}`) : (zh ? `知识提炼未开始${result.refinementError ? `：${result.refinementError}` : "。"}` : `Refinement has not started${result.refinementError ? `: ${result.refinementError}` : "."}`);
        new Notice(zh ? `目录配置完成：创建 ${result.created.length} 个目录，搬迁 ${result.moved.length} 个文件。${refinement}` : `Folders configured: ${result.created.length} created, ${result.moved.length} files moved. ${refinement}`);
      } else {
        new Notice(zh ? `目录设置已应用：更新 ${plan.changes.length} 个用途。` : `Folder settings applied for ${plan.changes.length} purposes.`);
      }
      this.close();
    });
  }
  private async run(action: () => Promise<void>): Promise<void> {
    if (this.busy) return;
    this.busy = true; this.error = ""; this.redraw();
    try { await action(); }
    catch (error) { this.error = folderErrorText(error, this.plugin.settings.settingsLanguage !== "en"); }
    finally { this.busy = false; this.redraw(); }
  }
  private renderJob(page: HTMLElement, zh: boolean): void {
    const manager = this.plugin.getKnowledgeSurfaceService();
    if (this.job && !["preview", "initialized"].includes(this.job.status)) {
      const section = createSettingsSection(page, { title: zh ? "知识提炼" : "Knowledge refinement" });
      new OriginSetting(section).setName(this.job.status === "active" ? (zh ? "进行中" : "Running") : (zh ? "尚未完成" : "Incomplete"))
        .setDesc(`${this.job.extractionCursor} / ${this.job.extractionQueue.length}${this.job.lastError ? ` · ${this.job.lastError}` : ""}`);
      const actions = section.createDiv({ cls: "echoink-knowledge-init-actions" });
      const button = createOriginButton(actions, { text: this.job.status === "active" ? (zh ? "停止提炼" : "Stop refinement") : (zh ? "继续提炼" : "Continue refinement") });
      button.disabled = this.busy;
      button.onclick = () => void this.run(async () => { this.job = this.job?.status === "active" ? await manager!.cancelInitialization() : await manager!.continueInitialization(); });
    }
    if ((!this.jobLoaded || this.job?.status === "active") && !this.jobLoading && this.timer === null) {
      const view = page.ownerDocument.defaultView;
      if (!view || !manager) return;
      this.timer = view.setTimeout(() => {
        this.timer = null; this.jobLoading = true;
        void manager.getInitializationState().then(job => { this.job = job; this.jobLoaded = true; })
          .catch(error => { this.error = error instanceof Error ? error.message : String(error); this.jobLoaded = true; })
          .finally(() => { this.jobLoading = false; if (this.root?.isConnected && !this.busy) this.redraw(); });
      }, 1000);
    }
  }
  private configureNewFolder(role: KnowledgeRootRole, zh: boolean): Promise<{ name: string; parent: string } | null> {
    return new Promise(resolve => {
      const modal = new Modal(this.plugin.app);
      modal.modalEl.addClass("echoink-settings-modal", "echoink-theme-boundary");
      modal.setTitle(zh ? `设置${label(role, zh)}目录` : `Set up ${label(role, zh)} folder`);
      let name = this.draft.names.get(role) ?? KNOWLEDGE_ROOT_NAMES[role];
      let parent = this.draft.parents.get(role) ?? "";
      const body = modal.contentEl;
      new OriginSetting(body).setName(zh ? "目录名称" : "Folder name").addOriginText(input => {
        input.inputEl.setAttribute("aria-label", `${label(role, zh)} · ${zh ? "目录名称" : "Folder name"}`);
        input.setValue(name).onChange(value => { name = value; validate(); });
      });
      let parentButton: HTMLButtonElement;
      new OriginSetting(body).setName(zh ? "创建于" : "Create in").addOriginButton(button => {
        parentButton = button.buttonEl;
        button.setButtonText(parent || (zh ? "仓库根目录" : "Vault root")).onClick(() => {
          void this.pickFolder(true, zh, parent).then(selected => {
            if (selected === null) return;
            parent = selected; parentButton.setText(parent || (zh ? "仓库根目录" : "Vault root")); validate();
          });
        });
      });
      const error = body.createDiv({ cls: "settings-error", attr: { role: "alert" } });
      const actions = body.createDiv({ cls: "echoink-knowledge-init-actions" });
      createOriginButton(actions, { text: zh ? "取消" : "Cancel" }).onclick = () => modal.close();
      const confirm = createOriginButton(actions, { cls: "mod-cta", text: zh ? "确认目录" : "Confirm folder" });
      const validate = () => {
        const trimmed = name.trim();
        const target = parent ? `${parent}/${trimmed}` : trimmed;
        const invalid = !trimmed || /[/\\]/u.test(trimmed) || trimmed.startsWith(".") || /[\0-\x1f]/u.test(trimmed);
        const existing = !invalid && this.plugin.app.vault.getAbstractFileByPath(target);
        const conflict = !!existing && !(existing instanceof TFolder);
        error.setText(invalid ? (zh ? "请填写合法的目录名称，不含路径分隔符。" : "Enter a valid folder name without path separators.") : conflict ? (zh ? "这个位置已有同名文件，请更换目录名称。" : "A file already uses this location. Choose another folder name.") : "");
        confirm.disabled = invalid || conflict;
      };
      confirm.onclick = () => { validate(); if (confirm.disabled) return; resolve({ name: name.trim(), parent }); modal.close(); };
      modal.onClose = () => { disposeOriginControls(body); resolve(null); };
      validate(); modal.open();
    });
  }
  private async pickFolder(parent: boolean, zh: boolean, current?: string): Promise<string | null> {
    return new Promise(resolve => {
      const modal = new Modal(this.plugin.app);
      const trigger = this.root?.ownerDocument.activeElement as HTMLElement | null;
      modal.modalEl.addClass("echoink-settings-modal", "echoink-theme-boundary");
      modal.onOpen = () => {
        modal.titleEl.setText(zh ? (parent ? "创建于" : "选择已有目录") : (parent ? "Create in" : "Choose existing folder"));
        const list = modal.contentEl.createDiv({ cls: "settings-stack echoink-folder-picker" });
        const render = () => {
          disposeOriginControls(list); list.empty();
          try {
            const folders = this.plugin.app.vault.getAllLoadedFiles().filter((file): file is TFolder => file instanceof TFolder && !!file.path && file.path !== "/").sort((a, b) => a.path.localeCompare(b.path));
            const add = (path: string, title: string) => createSettingsNavigationRow(list, { title, value: path === current ? (zh ? "当前选择" : "Current choice") : undefined, onActivate: () => { resolve(path); modal.close(); } });
            if (parent) add("", zh ? "仓库根目录" : "Vault root");
            for (const folder of folders) add(folder.path, folder.path);
            if (!parent && !folders.length) list.createDiv({ cls: "settings-empty", text: zh ? "当前仓库还没有可选择的文件夹" : "This vault has no folders to choose from" });
          } catch {
            list.createDiv({ cls: "settings-error", text: zh ? "文件夹列表读取失败，请重试" : "Could not read the folder list. Try again.", attr: { role: "alert" } });
            createOriginButton(list, { text: zh ? "重试" : "Retry" }).onclick = render;
          }
        };
        render();
        const actions = modal.contentEl.createDiv({ cls: "echoink-knowledge-init-actions" });
        createOriginButton(actions, { text: zh ? "取消" : "Cancel" }).onclick = () => modal.close();
      };
      modal.onClose = () => { disposeOriginControls(modal.contentEl); resolve(null); if (trigger?.isConnected) trigger.focus({ preventScroll: true }); };
      modal.open();
    });
  }
}
