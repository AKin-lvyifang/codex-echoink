import type { MobileKnowledgeFolderApplyResult, MobileKnowledgeFolderPreview, MobileKnowledgeFolderRequest, MobileKnowledgeFoldersSnapshot } from "../../mobile/knowledge-folders-contracts";
import { emptyKnowledgeFolderBindings, normalizeKnowledgeDirectory, type KnowledgeFolderBindings } from "../../knowledge-base/folder-bindings";
import { KNOWLEDGE_ROOT_NAMES } from "../../knowledge-base/root-paths-core";
import { formatMobileDateTime } from "../../mobile/date-display";
import type { MobileShellPage } from "../mobile/shell-types";
import type { IPhonePageContext } from "./workbench-contract";
import { iphoneElement as el, iphoneButton } from "./workbench-elements";
import { settingsError, settingsField, settingsGroup, settingsRow, pushSettingsPage } from "./settings-elements";

type Role = "raw" | "wiki" | "projects" | "inbox";
const ROLES = [["raw", "资料来源", "Sources", "files"], ["wiki", "知识成果", "Knowledge", "library"], ["projects", "项目", "Projects", "folder"], ["inbox", "收件箱", "Inbox", "inbox"]] as const;
const t = (ctx: IPhonePageContext, zh: string, en: string): string => ctx.host.settings().settingsLanguage === "en" ? en : zh;
const config = (snapshot: MobileKnowledgeFoldersSnapshot): KnowledgeFolderBindings => structuredClone(snapshot.bindings ?? emptyKnowledgeFolderBindings());

/** iPhone settings pages retain their own inputs and never perform Vault IO. */
class FolderPage {
  readonly content: HTMLElement;
  readonly body: HTMLFieldSetElement;
  readonly footer: HTMLElement;
  readonly error: ReturnType<typeof settingsError>;
  readonly page: MobileShellPage;
  alive = true;
  busy = false;
  private readonly disposers: (() => void)[] = [];
  constructor(readonly ctx: IPhonePageContext, id: string, title: string) {
    this.content = el(ctx.document, "div", "ip-settings ip-knowledge-settings"); this.body = el(ctx.document, "fieldset", "ip-knowledge-body"); this.footer = el(ctx.document, "div", "ip-settings-actions ip-knowledge-footer");
    this.content.append(this.body); this.error = settingsError(ctx, this.content);
    this.page = { id, title, content: this.content, footer: this.footer, canLeave: () => !this.busy, dispose: () => { this.alive = false; this.disposers.forEach(dispose => dispose()); } };
  }
  async push(): Promise<void> { if (!this.footer.childElementCount) this.page.footer = undefined; await pushSettingsPage(this.ctx, this.page); }
  cleanup(dispose: () => void): void { this.disposers.push(dispose); }
  button(parent: HTMLElement, label: string, action: () => unknown, primary = false): HTMLButtonElement {
    const button = iphoneButton(this.ctx.document, label, () => { if (!button.disabled) void Promise.resolve().then(action).catch(error => { if (this.alive) this.error.show(error); }); }, primary ? "is-primary" : ""); parent.append(button); return button;
  }
  group(label: string): HTMLElement { return settingsGroup(this.ctx, this.body, label, true); }
  row(parent: HTMLElement, title: string, value: string, action?: () => void | Promise<void>, icon?: string): HTMLElement { return settingsRow(this.ctx, parent, title, { value, action, icon, literal: true, literalValue: true }); }
  check(parent: HTMLElement, label: string, checked: boolean, change: (value: boolean) => void | Promise<void>, toggle = false): HTMLInputElement {
    const row = el(this.ctx.document, "label", "ip-settings-row ip-knowledge-choice"), input = el(this.ctx.document, "input", toggle ? "ip-settings-switch" : "ip-settings-check"); input.type = "checkbox"; input.checked = checked; input.setAttribute("aria-label", label); if (toggle) input.setAttribute("role", "switch");
    row.append(el(this.ctx.document, "span", "ip-settings-label", label), input); parent.append(row);
    input.addEventListener("change", () => { if (this.busy) return; const requested = input.checked; void Promise.resolve().then(() => change(requested)).catch(error => { input.checked = !requested; if (this.alive) this.error.show(error); }); }); return input;
  }
  select(parent: HTMLElement, label: string, values: readonly (readonly [string, string])[], selected: string, change: (value: string) => Promise<void>): HTMLSelectElement {
    const field = el(this.ctx.document, "label", "ip-settings-field"), input = el(this.ctx.document, "select", "ip-settings-input"); input.setAttribute("aria-label", label); for (const [value, text] of values) { const option = el(this.ctx.document, "option", "", text); option.value = value; input.append(option); } input.value = selected;
    field.append(el(this.ctx.document, "span", "ip-settings-field-label", label), input); parent.append(field); input.addEventListener("change", () => { void change(input.value).catch(error => { input.value = selected; if (this.alive) this.error.show(error); }); }); return input;
  }
  async run(action: () => Promise<void>): Promise<boolean> {
    if (!this.alive || this.busy) return false; this.busy = true; this.body.disabled = true; this.error.show(); this.content.setAttribute("aria-busy", "true");
    const buttons = Array.from(this.footer.querySelectorAll("button")).map(button => ({ button, disabled: button.disabled })); for (const { button } of buttons) if (!button.hasAttribute("data-stop")) button.disabled = true;
    try { await action(); return this.alive; } catch (error) { if (this.alive) this.error.show(error); return false; }
    finally { this.busy = false; if (this.alive) { this.body.disabled = false; this.content.removeAttribute("aria-busy"); for (const { button, disabled } of buttons) if (button.isConnected) button.disabled = disabled; } }
  }
}

function status(ctx: IPhonePageContext, snapshot: MobileKnowledgeFoldersSnapshot, role: Role): string {
  const binding = snapshot.bindings?.roles[role]; if (!binding?.enabled) return t(ctx, "未启用", "Disabled"); if (!binding.readPaths.length) return t(ctx, "尚未绑定", "No folder selected");
  const invalid = binding.readPaths.filter(path => !snapshot.directories.includes(path)); return invalid.length ? t(ctx, `位置失效：${invalid.join("、")}`, `Unavailable: ${invalid.join(", ")}`) : binding.readPaths.join("、");
}

export async function openIPhoneKnowledgeSettings(ctx: IPhonePageContext): Promise<void> {
  const id = "iphone-settings-knowledge"; if (ctx.shell.hasPage(id)) { await ctx.shell.backTo(id); return; }
  const view = new FolderPage(ctx, id, t(ctx, "知识库", "Knowledge")), port = ctx.host.services.knowledgeFolders;
  let revision = 0;
  const reload = async () => { const ticket = ++revision; try { const snapshot = await port.read(); if (!view.alive || ticket !== revision) return; view.body.replaceChildren(); view.error.show();
    const purposes = view.group(t(ctx, "用途", "Purposes")); for (const [role, zh, en, icon] of ROLES) view.row(purposes, t(ctx, zh, en), status(ctx, snapshot, role), () => openPurpose(ctx, snapshot, role, reload), icon);
    const management = view.group(t(ctx, "目录管理", "Folder management")); view.row(management, t(ctx, "重新初始化", "Set up folders again"), "", () => openInitialization(ctx, snapshot, reload), "folder-cog"); view.row(management, t(ctx, "文件夹名称优化", "Improve folder names"), "", () => openNames(ctx, snapshot, reload), "text-cursor-input"); view.row(management, t(ctx, "复原仓库", "Restore changes"), "", () => openRestoreRecords(ctx, snapshot, reload), "rotate-ccw");
  } catch (error) { if (view.alive && ticket === revision) { view.body.replaceChildren(); view.error.show(error); view.button(view.body, t(ctx, "重新读取", "Reload"), reload); } } };
  view.body.append(el(ctx.document, "div", "ip-knowledge-empty", t(ctx, "正在读取…", "Loading…"))); await view.push(); await reload();
}

async function openPurpose(ctx: IPhonePageContext, initial: MobileKnowledgeFoldersSnapshot, role: Role, saved: () => Promise<void>): Promise<void> {
  const definition = ROLES.find(item => item[0] === role)!, view = new FolderPage(ctx, `iphone-knowledge-purpose-${role}`, t(ctx, definition[1], definition[2])); let snapshot = initial;
  const commit = async (next: KnowledgeFolderBindings): Promise<boolean> => view.run(async () => { snapshot = await ctx.host.services.knowledgeFolders.saveBindings(next, snapshot.token); await saved(); render(); });
  const choose = async () => openFolderPicker(ctx, snapshot, { selected: config(snapshot).roles[role].readPaths, multiple: role === "raw", topLevel: role === "wiki", defaultPath: config(snapshot).roles[role].writePath }, async (paths, defaultPath) => {
    const next = config(snapshot), binding = next.roles[role]; if (JSON.stringify([...binding.readPaths].sort()) !== JSON.stringify([...paths].sort())) binding.compatibilityReadScopes = false; binding.readPaths = paths; binding.enabled = paths.length > 0; binding.writePath = defaultPath && paths.includes(defaultPath) ? defaultPath : paths.includes(binding.writePath ?? "") ? binding.writePath : paths.length === 1 ? paths[0] : null;
    if (role === "raw") { const old = next.collectionTargets ?? { web: snapshot.bindings?.roles.raw.writePath ?? null, wechat: snapshot.bindings?.roles.raw.writePath ?? null }; next.collectionTargets = { web: paths.includes(old.web ?? "") ? old.web : binding.writePath, wechat: paths.includes(old.wechat ?? "") ? old.wechat : binding.writePath }; }
    next.migrationIssues = next.migrationIssues.filter(issue => !issue.startsWith(`${role}：`)); snapshot = await ctx.host.services.knowledgeFolders.saveBindings(next, snapshot.token); await saved(); render();
  });
  const render = () => { if (!view.alive) return; view.body.replaceChildren(); const binding = config(snapshot).roles[role], group = view.group(t(ctx, "用途", "Purpose")); const toggle = view.check(group, t(ctx, "启用", "Enabled"), binding.enabled, async enabled => {
    if (enabled && !binding.readPaths.length) { toggle.checked = false; await choose(); return; } const next = config(snapshot); next.roles[role].enabled = enabled; if (!await commit(next)) toggle.checked = binding.enabled;
  }, true); toggle.disabled = !snapshot.writable;
    const location = view.group(t(ctx, "位置", "Folders")); view.row(location, t(ctx, "选择已有目录", "Choose existing folders"), status(ctx, snapshot, role), snapshot.writable ? choose : undefined, "folder");
    if (role === "raw") { const options = [["", t(ctx, "请选择位置", "Choose a folder")], ...binding.readPaths.map(path => [path, path]) ] as [string, string][];
      const targets = view.group(t(ctx, "保存位置", "Save destinations"));
      const select = (label: string, value: string | null, change: (next: KnowledgeFolderBindings, value: string) => void) => { const control = view.select(targets, label, options, value ?? "", async selected => { const next = config(snapshot); change(next, selected); await commit(next); }); control.disabled = !snapshot.writable || !binding.enabled; };
      if (binding.readPaths.length >= 2) select(t(ctx, "默认保存到", "Default save folder"), binding.writePath, (next, value) => { next.roles.raw.writePath = value || null; });
      for (const [key, zh, en] of [["web", "网页收藏位置", "Web collection folder"], ["wechat", "公众号收藏位置", "WeChat collection folder"]] as const) select(t(ctx, zh, en), snapshot.bindings?.collectionTargets ? snapshot.bindings.collectionTargets[key] : binding.writePath, (next, value) => { next.collectionTargets ??= { web: binding.writePath, wechat: binding.writePath }; next.collectionTargets[key] = value || null; });
    }
    if (role === "wiki" || role === "projects") { const permissions = view.group(t(ctx, "子目录许可", "Subfolder permissions")); const permission = view.check(permissions, t(ctx, "允许 Agent 在知识成果和项目中新建子文件夹", "Allow Agent to create subfolders in Knowledge and Projects"), snapshot.bindings?.allowAgentSubfolders === true, async enabled => { const next = config(snapshot); next.allowAgentSubfolders = enabled; if (!await commit(next)) permission.checked = snapshot.bindings?.allowAgentSubfolders === true; }); permission.disabled = !snapshot.writable; }
    if (binding.allowedSubdirectories.length || binding.autoOrganizePaths?.length) { const consent = view.group(t(ctx, "已有子目录许可", "Existing subfolder permissions"));
      for (const path of binding.allowedSubdirectories) { const control = view.check(consent, path, true, async () => { const next = config(snapshot); next.roles[role].allowedSubdirectories = next.roles[role].allowedSubdirectories.filter(item => item !== path); if (!await commit(next)) control.checked = true; }); control.disabled = !snapshot.writable; }
      for (const path of binding.autoOrganizePaths ?? []) { const control = view.check(consent, t(ctx, `${path} 内的子目录`, `Subfolders in ${path}`), true, async () => { const next = config(snapshot); next.roles[role].autoOrganizePaths = next.roles[role].autoOrganizePaths?.filter(item => item !== path); if (!await commit(next)) control.checked = true; }); control.disabled = !snapshot.writable; }
    }
  }; render(); await view.push();
}

interface PickerOptions { selected: string[]; multiple?: boolean; topLevel?: boolean; allowNew?: boolean; allowRoot?: boolean; defaultPath?: string | null }
async function openFolderPicker(ctx: IPhonePageContext, snapshot: MobileKnowledgeFoldersSnapshot, options: PickerOptions, save: (paths: string[], defaultPath?: string) => Promise<void>): Promise<void> {
  const view = new FolderPage(ctx, "iphone-knowledge-folders-picker", t(ctx, "选择目录", "Choose folders")); let selected = [...options.selected], changed = false, query = "", newPath = "", defaultPath = options.defaultPath ?? (selected.length === 1 ? selected[0] : "");
  const search = settingsField(ctx, view.body, t(ctx, "搜索目录", "Search folders"), "", value => { query = value; draw(); }, "search"), list = el(ctx.document, "div", "ip-knowledge-folder-list"); search.parentElement!.after(list);
  const defaults = el(ctx.document, "div", "ip-knowledge-default"); view.body.append(defaults);
  const draw = () => { list.replaceChildren(); defaults.replaceChildren(); const paths = [...new Set([...(options.allowRoot ? [""] : []), ...snapshot.directories, ...selected])].filter(path => (path !== "" || options.allowRoot === true) && (path || t(ctx, "库根目录", "Vault root")).toLocaleLowerCase().includes(query.toLocaleLowerCase()) && (!options.topLevel || !path.includes("/") || options.selected.includes(path)));
    for (const path of paths) { const row = view.check(list, path || t(ctx, "库根目录", "Vault root"), selected.includes(path), value => { changed = true; selected = options.multiple ? value ? [...selected, path] : selected.filter(item => item !== path) : value ? [path] : []; draw(); }); row.type = options.multiple ? "checkbox" : "radio"; row.name = "knowledge-folder"; row.setAttribute("data-path", path); if (options.topLevel && path.includes("/")) row.disabled = true; }
    if (!selected.includes(defaultPath)) defaultPath = selected.length === 1 ? selected[0] : "";
    if (options.multiple && selected.length > 1) view.select(defaults, t(ctx, "默认保存到", "Default save folder"), [["", t(ctx, "请选择位置", "Choose a folder")], ...selected.map(path => [path, path] as const)], defaultPath, async value => { defaultPath = value; });
    if (!paths.length) list.append(el(ctx.document, "div", "ip-knowledge-empty", t(ctx, "没有可选目录", "No folders available")));
  };
  if (options.allowNew) { const area = view.group(t(ctx, "新目录", "New folder")); settingsField(ctx, area, t(ctx, "新目录路径", "New folder path"), "", value => { newPath = value; }); view.button(area, t(ctx, "使用此路径", "Use this path"), () => { const path = normalizeKnowledgeDirectory(newPath); if (options.topLevel && path.includes("/")) throw new Error(t(ctx, "请选择一个一级文件夹。", "Choose one top-level folder.")); changed = true; selected = options.multiple ? [...new Set([...selected, path])] : [path]; draw(); }); }
  view.button(view.footer, t(ctx, "取消", "Cancel"), () => ctx.shell.back()); view.button(view.footer, t(ctx, "确认选择", "Confirm selection"), async () => { const ok = await view.run(async () => { if (options.topLevel && changed && (selected.length !== 1 || selected[0].includes("/"))) throw new Error(t(ctx, "请选择一个一级文件夹。", "Choose one top-level folder.")); if (options.multiple && selected.length > 1 && !selected.includes(defaultPath)) throw new Error(t(ctx, "请选择默认保存位置。", "Choose a default save folder.")); await save(selected, defaultPath); }); if (ok) await ctx.shell.back(); }, true); draw(); await view.push();
}

async function openInitialization(ctx: IPhonePageContext, snapshot: MobileKnowledgeFoldersSnapshot, saved: () => Promise<void>): Promise<void> {
  const view = new FolderPage(ctx, "iphone-knowledge-initialize", t(ctx, "重新初始化", "Set up folders again")), bindings = config(snapshot); let mode: "existing" | "build" = "existing", modules = { ...snapshot.moduleDirectories }, generation = 0, controller: AbortController | undefined;
  const routes = el(ctx.document, "div", "ip-knowledge-routes"), positions = el(ctx.document, "div", "ip-knowledge-positions"), effects = el(ctx.document, "div", "ip-knowledge-effects"); view.body.append(routes, positions, effects);
  const operation = createOperation(view, effects, saved, snapshot.writable);
  const request = (): MobileKnowledgeFolderRequest => ({ kind: "initialize", mode, bindings: structuredClone(bindings), moduleDirectories: { ...modules }, createPaths: mode === "build" ? [...new Set([...Object.values(bindings.roles).flatMap(binding => binding.enabled ? binding.readPaths : []), ...(modules.journal ? [modules.journal] : [])])].filter(path => !snapshot.directories.includes(path)) : [] });
  const preview = async () => { const ticket = ++generation; operation.invalidate(); controller?.abort(); controller = new AbortController(); const current = controller;
    try { const result = await ctx.host.services.knowledgeFolders.preview(request(), current.signal); if (view.alive && ticket === generation) operation.set(result); } catch (error) { if (view.alive && ticket === generation && !current.signal.aborted) { effects.replaceChildren(); view.error.show(error); } }
  };
  const render = () => { routes.replaceChildren(); for (const [id, zh, en, detailZh, detailEn] of [["existing", "使用现有文件夹", "Use existing folders", "按你现在的目录对应各个用途，不新建、不移动", "Match your current folders without creating or moving files"], ["build", "帮我搭建", "Build a folder structure", "按推荐结构新建文件夹，把未归类的笔记移进去", "Create the selected structure and move unclassified notes"]] as const) {
    const row = el(ctx.document, "label", "ip-knowledge-route"), radio = el(ctx.document, "input", ""); radio.type = "radio"; radio.name = "knowledge-initialization-route"; radio.value = id; radio.checked = id === mode; radio.setAttribute("aria-label", t(ctx, zh, en)); const copy = el(ctx.document, "span", ""); copy.append(el(ctx.document, "span", "ip-knowledge-route-title", t(ctx, zh, en)), el(ctx.document, "span", "ip-knowledge-route-detail", t(ctx, detailZh, detailEn))); row.append(radio, copy); routes.append(row); radio.addEventListener("change", () => { mode = id;
      if (mode === "build") for (const role of ["raw", "wiki", "projects", "inbox", "outputs"] as const) if (!bindings.roles[role].readPaths.length) Object.assign(bindings.roles[role], { enabled: true, readPaths: [KNOWLEDGE_ROOT_NAMES[role]], writePath: KNOWLEDGE_ROOT_NAMES[role] }); render(); void preview(); }); }
    positions.replaceChildren(); const group = settingsGroup(ctx, positions, t(ctx, "位置", "Locations"), true);
    for (const [role, zh, en] of ROLES) view.row(group, t(ctx, zh, en), bindings.roles[role].readPaths.join("、") || t(ctx, "尚未绑定", "No folder selected"), () => openFolderPicker(ctx, snapshot, { selected: bindings.roles[role].readPaths, multiple: role === "raw", topLevel: role === "wiki", allowNew: mode === "build", defaultPath: bindings.roles[role].writePath }, async (paths, defaultPath) => { Object.assign(bindings.roles[role], { enabled: paths.length > 0, readPaths: paths, writePath: defaultPath && paths.includes(defaultPath) ? defaultPath : paths.includes(bindings.roles[role].writePath ?? "") ? bindings.roles[role].writePath : paths[0] ?? null }); if (role === "raw" && bindings.collectionTargets) for (const key of ["web", "wechat"] as const) if (!paths.includes(bindings.collectionTargets[key] ?? "")) bindings.collectionTargets[key] = bindings.roles.raw.writePath; render(); void preview(); }), "folder");
    view.row(group, t(ctx, "日记", "Journal"), modules.journal === "" ? t(ctx, "库根目录", "Vault root") : modules.journal || t(ctx, "尚未绑定", "No folder selected"), () => openFolderPicker(ctx, snapshot, { selected: modules.journal !== undefined ? [modules.journal] : [], allowNew: mode === "build", allowRoot: true }, async paths => { if (paths.length) modules = { ...modules, journal: paths[0] }; render(); void preview(); }), "book-open");
    view.row(group, t(ctx, "输出", "Outputs"), bindings.roles.outputs.readPaths.join("、") || t(ctx, "尚未绑定", "No folder selected"), () => openFolderPicker(ctx, snapshot, { selected: bindings.roles.outputs.readPaths, allowNew: mode === "build" }, async paths => { Object.assign(bindings.roles.outputs, { enabled: paths.length > 0, readPaths: paths, writePath: paths[0] ?? null }); render(); void preview(); }), "folder-output");
    const source = view.row(group, t(ctx, "待办文件", "To-do file"), snapshot.todoSourceExists ? snapshot.todoSourcePath : t(ctx, "未创建", "Not created")); if (snapshot.todoSourceExists) view.button(source, t(ctx, "打开原文", "Open source"), () => ctx.host.openNote(snapshot.todoSourcePath));
  }; view.cleanup(() => { generation++; controller?.abort(); }); render(); await view.push(); await preview();
}

function createOperation(view: FolderPage, effects: HTMLElement, saved: () => Promise<void>, writable: boolean) {
  const { ctx } = view; let preview: MobileKnowledgeFolderPreview | undefined, settled = false, execution: AbortController | undefined;
  const stop = view.button(view.footer, t(ctx, "停止", "Stop"), () => execution?.abort()); stop.dataset.stop = "true"; stop.hidden = true;
  const confirm = view.button(view.footer, t(ctx, "确认", "Confirm"), async () => {
    if (!preview || settled || !writable) return; execution = new AbortController(); stop.hidden = false;
    settled = true;
    await view.run(async () => { let result: MobileKnowledgeFolderApplyResult; try { result = await ctx.host.services.knowledgeFolders.apply(preview!.token, execution!.signal); } catch (error) { await saved(); throw new Error(t(ctx, "执行结果未确认，请重新读取记录，不要重复执行。", "Execution could not be confirmed. Reload the records; do not repeat the operation.") + " " + (error instanceof Error ? error.message : String(error))); } if (!view.alive) return;
      if (result.status === "reconfirm") { settled = false; preview = result.preview; draw(); view.error.show(t(ctx, "内容已变化，请核对新的后果后再次确认。", "Content changed. Review the updated effects and confirm again.")); return; }
      settled = true; effects.replaceChildren(el(ctx.document, "p", "ip-knowledge-result", t(ctx, result.status === "completed" ? "已完成" : result.status === "partial" ? "部分完成，未执行的动作不会自动重试。" : "结果尚未确认，请重新读取记录，不要重复执行。", result.status === "completed" ? "Completed" : result.status === "partial" ? "Partially completed. Remaining actions will not retry automatically." : "The result is uncertain. Reload the records before taking further action.")));
      effects.append(el(ctx.document, "p", "", t(ctx, `新建 ${result.created.length} 个文件夹 · 移动 ${result.moved.length} 项`, `${result.created.length} folders created · ${result.moved.length} items moved`))); for (const issue of result.issues) effects.append(el(ctx.document, "div", "ip-knowledge-issue", `${issue.path} · ${issue.reason}`)); await saved();
    }); stop.hidden = true; if (view.alive) view.body.disabled = settled; confirm.disabled = !writable || settled || !preview || !!preview.issues.length || preview.request.kind !== "initialize" && !preview.moves.length;
  }, true); confirm.disabled = true;
  const draw = () => { effects.replaceChildren(); if (!preview) return;
    effects.append(el(ctx.document, "p", "ip-knowledge-effect-summary", t(ctx, `复用 ${preview.reuse.length} 个文件夹 · 新建 ${preview.create.length} 个文件夹 · 移动 ${preview.moves.length} 项`, `Reuse ${preview.reuse.length} folders · Create ${preview.create.length} folders · Move ${preview.moves.length} items`)));
    for (const issue of preview.issues) effects.append(el(ctx.document, "div", "ip-knowledge-issue", issue));
    if (preview.request.kind !== "initialize") for (const excluded of preview.excluded) effects.append(el(ctx.document, "div", "ip-knowledge-issue", `${excluded.path} · ${excluded.reason}`));
    if (preview.create.length || preview.moves.length || preview.excluded.length) { const details = el(ctx.document, "details", "ip-knowledge-details"); details.append(el(ctx.document, "summary", "", t(ctx, "查看范围与后果", "Review scope and effects"))); for (const path of preview.create) details.append(el(ctx.document, "p", "", t(ctx, `新建：${path}`, `Create: ${path}`))); for (const move of preview.moves) details.append(el(ctx.document, "p", "", `${move.from} → ${move.to}`)); for (const excluded of preview.excluded) details.append(el(ctx.document, "p", "", `${excluded.path} · ${excluded.reason}`)); effects.append(details); }
    confirm.disabled = !writable || !preview || !!preview.issues.length || settled || preview.request.kind !== "initialize" && !preview.moves.length;
  };
  view.cleanup(() => execution?.abort()); return { set(value: MobileKnowledgeFolderPreview) { preview = value; settled = false; view.error.show(); draw(); }, invalidate() { preview = undefined; settled = false; confirm.disabled = true; effects.replaceChildren(el(ctx.document, "p", "", t(ctx, "正在计算实际后果…", "Calculating effects…"))); } };
}

async function openNames(ctx: IPhonePageContext, snapshot: MobileKnowledgeFoldersSnapshot, saved: () => Promise<void>): Promise<void> {
  const view = new FolderPage(ctx, "iphone-knowledge-names", t(ctx, "文件夹名称优化", "Improve folder names")), group = view.group(t(ctx, "目录范围", "Folder scope")), effects = el(ctx.document, "div", "ip-knowledge-effects"); view.body.append(effects); const operation = createOperation(view, effects, saved, snapshot.writable);
  let scopes = [...new Set(Object.values(snapshot.bindings?.roles ?? {}).flatMap(binding => binding.enabled ? binding.readPaths : []))].filter(path => snapshot.directories.includes(path)), generation = 0;
  const all = [...scopes]; const reload = async () => { const ticket = ++generation; operation.invalidate(); if (!scopes.length) { effects.replaceChildren(el(ctx.document, "p", "", t(ctx, "请选择目录范围。", "Select a folder scope."))); return; } try { const preview = await ctx.host.services.knowledgeFolders.preview({ kind: "names", scopes: [...scopes] }); if (view.alive && ticket === generation) { operation.set(preview); if (!preview.moves.length && !preview.issues.length && !preview.excluded.length) effects.prepend(el(ctx.document, "p", "", t(ctx, "目录名称无需优化。", "No folder names need improvement."))); } } catch (error) { if (view.alive && ticket === generation) view.error.show(error); } };
  for (const path of all) view.check(group, path, true, async selected => { scopes = selected ? [...scopes, path] : scopes.filter(item => item !== path); await reload(); }).disabled = !snapshot.writable;
  if (!all.length) group.append(el(ctx.document, "div", "ip-knowledge-empty", t(ctx, "没有可优化的目录", "No folders to improve"))); await view.push(); await reload();
}

async function openRestoreRecords(ctx: IPhonePageContext, snapshot: MobileKnowledgeFoldersSnapshot, saved: () => Promise<void>): Promise<void> {
  const view = new FolderPage(ctx, "iphone-knowledge-restore", t(ctx, "复原仓库", "Restore changes")), group = view.group(t(ctx, "整理记录", "Change records"));
  for (const record of snapshot.restoreRecords) view.row(group, formatMobileDateTime(record.createdAt, Date.now(), ctx.host.settings().settingsLanguage), t(ctx, `${record.files} 项 · ${record.status === "completed" ? "已完成" : record.status === "partial" ? "部分完成" : "待核对"}`, `${record.files} items · ${record.status}`), async () => {
    const detail = new FolderPage(ctx, `iphone-knowledge-restore-${record.id}`, t(ctx, "核对复原范围", "Review restore scope")), effects = el(ctx.document, "div", "ip-knowledge-effects"); detail.body.append(effects); const operation = createOperation(detail, effects, saved, snapshot.writable); operation.invalidate(); await detail.push(); try { const preview = await ctx.host.services.knowledgeFolders.preview({ kind: "restore", recordId: record.id }); if (detail.alive) operation.set(preview); } catch (error) { if (detail.alive) detail.error.show(error); }
  }, "history");
  if (!snapshot.restoreRecords.length) group.append(el(ctx.document, "div", "ip-knowledge-empty", t(ctx, "暂无可复原记录", "No change records to restore"))); await view.push();
}
