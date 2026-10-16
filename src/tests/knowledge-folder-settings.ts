import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { Modal, TFolder } from "obsidian";
import type CodexForObsidianPlugin from "../main";
import { emptyKnowledgeFolderBindings } from "../knowledge-base/folder-bindings";
import { previewKnowledgeDirectoryPlan, type KnowledgeDirectoryPlan } from "../knowledge-base/folder-plan";
import { KnowledgeFolderDraft, KnowledgeFolderSection, knowledgeFolderPlanSummary, knowledgeFoldersConfigured } from "../settings/knowledge-folder-section";
import { disposeOriginControls } from "../settings/origin-controls";
import { openTestModals, openTestNoticeMessages } from "./obsidian-shim";
import { runKnowledgeFolderActionsTests } from "./knowledge-folder-actions";

function bound() {
  const config = emptyKnowledgeFolderBindings();
  for (const [role, path] of [["raw", "阅读/资料"], ["wiki", "知识/卡片"]] as const) Object.assign(config.roles[role], { enabled: true, readPaths: [path], writePath: path });
  return config;
}

function prepareDOM() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
  const win = dom.window;
  const previous = new Map<string, PropertyDescriptor | undefined>();
  for (const name of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "Event", "MouseEvent", "KeyboardEvent", "MutationObserver", "DocumentFragment", "getComputedStyle"]) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, value: name === "getComputedStyle" ? win.getComputedStyle.bind(win) : win[name] });
  }
  const create = function(this: HTMLElement, tag: string, options: any = {}) {
    if (typeof options === "string") options = { cls: options };
    const el = this.ownerDocument.createElement(tag);
    if (options.cls) el.className = options.cls;
    if (options.text !== undefined) el.textContent = options.text;
    if (options.value !== undefined) (el as HTMLInputElement).value = options.value;
    for (const [name, value] of Object.entries(options.attr ?? {})) el.setAttribute(name, String(value));
    this.append(el); return el;
  };
  Object.assign(win.HTMLElement.prototype, {
    empty() { this.replaceChildren(); }, addClass(...names: string[]) { this.classList.add(...names); }, removeClass(...names: string[]) { this.classList.remove(...names); },
    toggleClass(name: string, force: boolean) { this.classList.toggle(name, force); }, setText(text: string) { this.textContent = text; },
    setAttr(name: string, value: string) { this.setAttribute(name, value); },
    createEl: create, createDiv(options: unknown) { return create.call(this, "div", options); }, createSpan(options: unknown) { return create.call(this, "span", options); }
  });
  let reducedMotion = false;
  const motionListeners = new Set<() => void>();
  const motionQuery = {
    get matches() { return reducedMotion; },
    addEventListener(_type: string, listener: () => void) { motionListeners.add(listener); },
    removeEventListener(_type: string, listener: () => void) { motionListeners.delete(listener); },
    addListener() {}, removeListener() {}
  };
  win.matchMedia = () => motionQuery as any;
  return { win, motionListeners, setReducedMotion(value: boolean) { reducedMotion = value; for (const listener of [...motionListeners]) listener(); }, close() { dom.window.close(); for (const [name, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); } } };
}

export async function runKnowledgeFolderSettingsTests(): Promise<void> {
  assert.equal(knowledgeFoldersConfigured(null), false);
  assert.equal(knowledgeFoldersConfigured(emptyKnowledgeFolderBindings()), false, "empty migration does not skip first-time routes");
  assert.equal(knowledgeFoldersConfigured(bound()), true, "existing configuration needs no new flag");
  assert.equal(knowledgeFolderPlanSummary(bound(), () => true, true), "来源 1 个 · 成果 1 个 · 收件箱未启用");
  assert.equal(knowledgeFolderPlanSummary(bound(), path => path !== "阅读/资料", true), "有目录已失效");
  assert.equal(knowledgeFolderPlanSummary(null, () => false, true), "尚未初始化");
  const incomplete = bound(); incomplete.roles.wiki.enabled = false;
  assert.equal(knowledgeFoldersConfigured(incomplete), false, "old Raw-only configuration can choose Build");
  const inbox = emptyKnowledgeFolderBindings(); Object.assign(inbox.roles.inbox, { enabled: true, readPaths: ["临时笔记"], writePath: "临时笔记" });
  assert.equal(knowledgeFoldersConfigured(inbox), true, "non-maintenance uses remain valid configurations");
  assert.equal(knowledgeFoldersConfigured({ ...emptyKnowledgeFolderBindings(), configured: true } as any), true, "explicitly saved all-disabled plan remains configured");
  const legacy = bound();
  legacy.roles.raw.allowedSubdirectories = ["旧分类"];
  const legacyBefore = JSON.stringify(legacy);
  const legacyDraft = new KnowledgeFolderDraft(legacy);
  assert.equal(legacyDraft.dirty, false, "freezing legacy approval roots does not create a dirty draft");
  assert.deepEqual(legacyDraft.baseline.roles.raw.allowedSubdirectoryRoots, ["阅读/资料"]);
  assert.deepEqual(legacyDraft.bindings.roles.raw.allowedSubdirectoryRoots, ["阅读/资料"]);
  assert.equal(JSON.stringify(legacy), legacyBefore, "freezing roots never changes saved settings");
  legacyDraft.bind("raw", "新的来源", "阅读/资料");
  assert.deepEqual(legacyDraft.bindings.roles.raw.allowedSubdirectories, ["旧分类"]);
  assert.deepEqual(legacyDraft.bindings.roles.raw.allowedSubdirectoryRoots, ["阅读/资料"], "old child approvals do not transfer to a newly bound root");
  legacyDraft.choose("build");
  legacyDraft.names.set("raw", "新材料"); legacyDraft.updateNew("raw");
  assert(!legacyDraft.bindings.roles.raw.allowedSubdirectoryRoots?.includes("新材料"), "new build roots do not inherit old child approvals");
  const draft = new KnowledgeFolderDraft(bound());
  draft.bind("raw", "工作/调研");
  assert.equal(draft.bindings.roles.raw.writePath, "阅读/资料", "adding a second source retains an existing default");
  draft.unbind("raw", "阅读/资料");
  assert.equal(draft.bindings.roles.raw.writePath, "工作/调研", "single remaining source becomes the write destination");
  assert.equal(draft.baseline.roles.raw.readPaths[0], "阅读/资料", "draft mutations do not change saved bindings");
  draft.bind("raw", "阅读/资料", "工作/调研");
  assert.equal(draft.dirty, false, "restoring effective values clears dirty state");
  draft.organize("raw", "阅读/资料", true);
  assert.equal(draft.dirty, true);
  draft.organize("raw", "阅读/资料", false);
  assert.equal(draft.dirty, false, "switching consent back clears dirty state");
  draft.bindings.roles.raw.allowedSubdirectories = ["旧分类"];
  draft.organize("raw", "阅读/资料", true);
  draft.bind("raw", "新的来源", "阅读/资料");
  assert.deepEqual(draft.bindings.roles.raw.autoOrganizePaths, [], "rebindings never inherit consent");
  assert.deepEqual(draft.bindings.roles.raw.allowedSubdirectories, ["旧分类"], "legacy explicit child approvals are retained");
  draft.unbind("wiki", "知识/卡片");
  assert(draft.issues.some(issue => issue.includes("维护需要")), "last maintenance output cannot disappear silently");
  const build = new KnowledgeFolderDraft(undefined);
  build.choose("build");
  assert.deepEqual(build.createPaths.length, 2);
  assert.equal(build.bindings.roles.raw.readPaths.length, 1);
  assert.equal(build.bindings.roles.raw.enabled, true);
  assert.equal(build.bindings.roles.wiki.enabled, true);
  assert.equal(build.parents.get("raw"), "");
  build.names.set("raw", "材料"); build.parents.set("raw", "读书/2026"); build.updateNew("raw");
  assert.deepEqual(build.bindings.roles.raw.readPaths, ["读书/2026/材料"], "parent path belongs to the created folder");
  build.names.set("raw", "bad/path"); build.updateNew("raw");
  assert(build.issues.some(issue => issue.includes("分隔符")));

  const dom = prepareDOM();
  const host = dom.win.document.body.createDiv({ cls: "echoink-settings-demo" });
  const folders = ["/", "", "阅读/资料", "知识/卡片", "工作/调研", "读书/2026"].map(path => Object.assign(new TFolder(), { path }));
  let saved = bound();
  let detail = false;
  let failed = false;
  let applyCalls = 0;
  const optimizeCalls: boolean[] = [];
  let previewCalls = 0;
  let folderReadFails = false;
  let noFolders = false;
  let settleApply: (() => void) | undefined;
  const manager = {
    directoryWritable: true, folderOperationBusy: false,
    async previewDirectoryPlan(bindings: any, createPaths: string[], options: any) {
      previewCalls++;
      return previewKnowledgeDirectoryPlan({ baseRevision: saved.revision, baseline: saved, bindings, createPaths, mode: options.mode,
        kind: async path => folders.some(folder => folder.path === path) ? "folder" : "missing", sourcePaths: [], files: [] });
    },
    async applyDirectoryPlan(plan: KnowledgeDirectoryPlan, optimize = false) {
      applyCalls++; optimizeCalls.push(optimize);
      await new Promise<void>(resolve => { settleApply = resolve; });
      if (failed) throw new Error("预览后的资料已变化，请重新预览；目录尚未应用。");
      saved = structuredClone(plan.bindings); (saved as any).configured = true;
      plugin.settings.knowledgeBase.folderBindings = saved;
      return { configured: true as const, created: plan.create, moved: plan.moves, refinement: "not-started" as const, refinementError: "未配置模型" };
    },
    async getInitializationState() { return null; }
  };
  const plugin = {
    settings: { knowledgeBase: { folderBindings: saved } },
    app: { vault: { getAllLoadedFiles: () => { if (folderReadFails) throw new Error("read failed"); return noFolders ? [] : folders; }, getAbstractFileByPath: (path: string) => folders.find(folder => folder.path === path) ?? null } },
    getKnowledgeSurfaceService: () => manager
  } as unknown as CodexForObsidianPlugin;
  let section: KnowledgeFolderSection;
  const draw = () => { disposeOriginControls(host); host.empty(); if (detail) section.renderDetail(host, true); else section.render(host, true); };
  section = new KnowledgeFolderSection(plugin, draw, { open() { detail = true; draw(); }, close() { detail = false; draw(); } });
  const button = (text: string, root: ParentNode = host) => {
    const found = [...root.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent === text || item.getAttribute("aria-label") === text || item.querySelector(".echoink-settings-navigation-title")?.textContent === text);
    assert(found, `Expected button: ${text}`); return found;
  };
  const change = (control: HTMLInputElement) => control.dispatchEvent(new dom.win.Event("change", { bubbles: true }));
  const flush = async () => { for (let index = 0; index < 8; index++) await Promise.resolve(); await new Promise(resolve => setTimeout(resolve, 0)); };
  try {
    draw();
    assert.equal(host.querySelectorAll("button").length, 1, "home has one folder entry");
    button("目录方案").click();
    assert.equal(host.querySelector('[role="tablist"]'), null);
    assert.equal(host.querySelectorAll(".echoink-folder-purpose").length, 10);
    assert(!host.textContent?.includes("预览方案"), "unchanged draft has no preview action");
    let raw = host.querySelector<HTMLElement>('[data-folder-role="raw"]')!;
    assert.equal(host.querySelectorAll(".echoink-folder-purpose.is-group.settings-card").length, 10, "each purpose uses the existing grouped card surface");
    assert([...host.querySelectorAll<HTMLElement>(".echoink-folder-bindings")].every(item => item.hidden), "existing configurations initially collapse every drawer");
    assert.equal(host.querySelectorAll('.echoink-folder-header-top > [role="switch"]').length, 10, "every purpose has one outer Switch");
    assert.equal(host.querySelectorAll('.echoink-folder-bindings [role="switch"]').length, 0, "drawers contain no nested Switches");
    const disclosure = () => host.querySelector<HTMLButtonElement>('[data-folder-role="raw"] .echoink-folder-disclosure')!;
    const rawContent = () => host.querySelector<HTMLElement>('[data-folder-role="raw"] .echoink-folder-bindings')!;
    const finishDrawerMotion = () => {
      const event = new dom.win.Event("transitionend", { bubbles: true });
      Object.defineProperty(event, "propertyName", { value: "grid-template-rows" });
      rawContent().closest(".echoink-folder-drawer-viewport")!.dispatchEvent(event);
    };
    assert.equal(dom.motionListeners.size, 0, "initial rendering starts no drawer animation");
    assert.equal(raw.querySelector(".echoink-folder-list-header > span")?.textContent, "指定文件夹");
    assert(raw.querySelector(".echoink-folder-summary")?.textContent?.includes("阅读/资料"), "collapsed headers summarize bound folders");
    disclosure().focus();
    disclosure().dispatchEvent(new dom.win.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    assert.equal(rawContent().hidden, false, "Enter expands an enabled drawer");
    assert.equal(disclosure().getAttribute("aria-expanded"), "true");
    disclosure().dispatchEvent(new dom.win.KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true }));
    assert.equal(rawContent().hidden, false, "closing keeps the content rendered until its slide finishes");
    assert.equal(rawContent().inert, true, "closing content immediately leaves keyboard interaction");
    assert.equal(rawContent().getAttribute("aria-hidden"), "true");
    assert.equal(disclosure().getAttribute("aria-expanded"), "false");
    disclosure().click();
    finishDrawerMotion();
    assert.equal(rawContent().hidden, false, "a quick reversal finishes in the latest requested state");
    assert.equal(rawContent().inert, false);
    assert.equal(dom.motionListeners.size, 0, "completed motion releases its listener");
    raw.querySelector<HTMLButtonElement>(".echoink-folder-path")!.focus();
    disclosure().click(); finishDrawerMotion();
    assert.equal(rawContent().hidden, true, "the completed close restores hidden semantics");
    assert.equal(dom.win.document.activeElement, disclosure(), "closing returns content focus to its disclosure");
    disclosure().click(); finishDrawerMotion();
    disclosure().click();
    dom.setReducedMotion(true);
    assert.equal(rawContent().hidden, true, "enabling reduced motion immediately finishes an active close");
    disclosure().click();
    assert.equal(rawContent().hidden, false);
    assert.equal(dom.motionListeners.size, 0, "reduced motion starts no transition");
    disclosure().click();
    assert.equal(rawContent().hidden, true, "reduced motion closes immediately");
    dom.setReducedMotion(false);
    dom.win.document.body.classList.add("is-mobile"); draw();
    assert.equal(host.querySelector(".echoink-folder-drawer-viewport"), null, "mobile keeps the existing drawer structure");
    disclosure().click();
    assert.equal(rawContent().hidden, false);
    disclosure().click();
    assert.equal(rawContent().hidden, true, "mobile still closes immediately");
    assert.equal(dom.motionListeners.size, 0);
    dom.win.document.body.classList.remove("is-mobile"); draw();
    disclosure().click(); draw(); raw = host.querySelector<HTMLElement>('[data-folder-role="raw"]')!;
    assert.equal(dom.motionListeners.size, 0, "redraw releases an interrupted animation");
    assert.equal(rawContent().hidden, false, "redraw preserves UI expansion");
    assert.equal(section.hasDraft, false, "expansion never dirties business settings");
    raw.querySelector<HTMLElement>(".echoink-folder-purpose-header")!.click();
    finishDrawerMotion();
    assert.equal(rawContent().hidden, true, "empty header space folds the same drawer");
    raw.querySelector<HTMLElement>(".echoink-folder-purpose-header")!.click();
    const purposeHelp = raw.querySelector<HTMLButtonElement>(".echoink-folder-purpose-help")!;
    purposeHelp.click();
    assert.equal(rawContent().hidden, false, "purpose help never folds the drawer");
    purposeHelp.blur();
    assert(!host.textContent?.includes("预览方案"));
    const help = raw.querySelector<HTMLButtonElement>(".echoink-folder-help")!;
    const tooltipId = help.getAttribute("aria-describedby")!;
    const helpLabelId = help.getAttribute("aria-labelledby")!;
    assert(helpLabelId, "permission help has a stable accessible name reference");
    assert.equal(help.getAttribute("aria-label"), null, "permission help avoids the native title tooltip trigger");
    assert.equal(help.getAttribute("title"), null, "permission help relies on the attached settings tooltip");
    assert.equal(raw.querySelector(`#${helpLabelId}`)?.textContent, "自动整理权限说明");
    assert.equal(help.querySelector(`#${helpLabelId}`)?.classList.contains("echoink-folder-help-label"), true);
    assert.equal(raw.querySelector('[role="checkbox"]')?.getAttribute("aria-label"), "允许 Agent 自动整理 · 阅读/资料");
    assert.equal(raw.querySelector(".echoink-folder-organize .setting-item-description"), null, "organization explanations do not occupy permanent rows");
    help.click();
    let tooltip = dom.win.document.getElementById(tooltipId)!;
    assert.equal(tooltip.hidden, false, "touch/click opens the existing settings tooltip");
    assert.equal(tooltip.textContent, "允许 Agent 在这个文件夹内创建分类文件夹，并移动文件进行归类。");
    help.focus();
    assert.equal(dom.win.document.getElementById(tooltipId)?.hidden, false, "keyboard focus also exposes permission details");
    help.blur();
    assert.equal(dom.win.document.getElementById(tooltipId), null);
    help.click(); disclosure().click();
    finishDrawerMotion();
    assert.equal(rawContent().hidden, true);
    assert.equal(dom.win.document.getElementById(tooltipId), null, "collapsing a drawer closes its detached tooltip");
    disclosure().click();
    assert.equal(section.hasDraft, false, "tooltip and disclosure interactions leave the draft unchanged");
    assert(raw.querySelector('[data-folder-path="阅读/资料"]')?.closest(".echoink-folder-bindings"), "binding is nested under its purpose");
    assert.equal(raw.querySelectorAll(".echoink-folder-tag").length, 2);
    assert.equal(host.querySelectorAll(".echoink-folder-tag").length, 6, "only Raw/Wiki/Projects receive Ask and maintenance tags");
    assert(!host.textContent?.includes("拟新建子目录"));
    assert(!host.textContent?.includes("收藏保存位置"), "single source is automatic");
    button("添加来源目录", raw).click();
    let picker = dom.win.document.body.querySelector(".echoink-folder-picker")!;
    const existingChoices = [...picker.querySelectorAll(".echoink-settings-navigation-title")].map(item => item.textContent);
    assert.deepEqual(existingChoices.slice().sort(), ["阅读/资料", "知识/卡片", "工作/调研", "读书/2026"].sort(), "existing-folder picker excludes both Obsidian root path forms");
    button("工作/调研", picker).click(); await flush();
    assert.equal(rawContent().hidden, false, "folder selection preserves the expanded drawer");
    assert.equal(host.querySelector<HTMLElement>('[data-folder-role="wiki"] .echoink-folder-bindings')!.hidden, true, "folder selection preserves other collapsed drawers");
    assert(host.textContent?.includes("收藏保存位置"), "multiple sources reveal the default destination selector");
    const destination = host.querySelector<HTMLSelectElement>('[aria-label="收藏保存位置"]')!;
    assert.deepEqual([...destination.options].map(option => option.textContent), ["请选择收藏保存位置", "阅读/资料", "工作/调研"], "collection destination only lists this purpose's bound sources");
    const rawHelpIds = [...host.querySelectorAll<HTMLElement>('[data-folder-role="raw"] .echoink-folder-help')]
      .map(trigger => trigger.getAttribute("aria-labelledby"));
    assert.equal(rawHelpIds.length, 2, "each raw source has its own permission help name");
    assert.equal(new Set(rawHelpIds).size, rawHelpIds.length, "permission help labels remain unique across sources");
    const extraSource = host.querySelector('[data-folder-path="工作/调研"]')!;
    extraSource.querySelector<HTMLButtonElement>('[aria-label="解绑文件夹 · 工作/调研"]')!.click();
    assert(!host.textContent?.includes("收藏保存位置"));
    assert.equal(plugin.settings.knowledgeBase.folderBindings!.roles.raw.readPaths.length, 1, "unbind does not write saved settings or delete anything");
    const originalPath = host.querySelector<HTMLButtonElement>('[aria-label="重新选择 · 阅读/资料"]')!;
    originalPath.click(); picker = dom.win.document.body.querySelector(".echoink-folder-picker")!;
    button("工作/调研", picker).click(); await flush();
    host.querySelector<HTMLButtonElement>('[aria-label="重新选择 · 工作/调研"]')!.click();
    picker = dom.win.document.body.querySelector(".echoink-folder-picker")!;
    button("阅读/资料", picker).click(); await flush();
    assert(!host.textContent?.includes("预览方案"), "restoring the original path clears dirty UI");
    let organize = host.querySelector<HTMLInputElement>('[data-folder-role="raw"] input[aria-label^="允许 Agent 自动整理"]')!;
    organize.checked = true; change(organize);
    assert(host.textContent?.includes("预览方案"));
    const disableRaw = host.querySelector<HTMLInputElement>('[data-folder-role="raw"] [data-folder-control="enabled"]')!;
    disableRaw.checked = false; change(disableRaw);
    assert.equal(rawContent().hidden, true, "disabling a purpose collapses its drawer");
    assert.equal(disclosure().getAttribute("aria-expanded"), "false");
    assert(host.querySelector('[data-folder-role="raw"] .echoink-folder-summary')?.textContent?.includes("未启用"), "disabled purposes show their state instead of old paths");
    const enableRaw = host.querySelector<HTMLInputElement>('[data-folder-role="raw"] [data-folder-control="enabled"]')!;
    enableRaw.checked = true; change(enableRaw);
    assert.equal(host.querySelector<HTMLInputElement>('[data-folder-role="raw"] [data-folder-control="enabled"]')!.checked, false, "switch remains off during selection");
    assert.equal(rawContent().hidden, true);
    assert(openTestModals.at(-1)!.modalEl.classList.contains("echoink-settings-modal"));
    button("取消", openTestModals.at(-1)!.contentEl).click(); await flush();
    assert.equal(host.querySelector<HTMLInputElement>('[data-folder-role="raw"] [data-folder-control="enabled"]')!.checked, false, "cancel keeps a previously configured purpose disabled");
    const reenable = host.querySelector<HTMLInputElement>('[data-folder-role="raw"] [data-folder-control="enabled"]')!;
    reenable.checked = true; change(reenable);
    picker = dom.win.document.body.querySelector(".echoink-folder-picker")!;
    button("阅读/资料", picker).click(); await flush();
    assert.equal(rawContent().hidden, false, "explicitly selecting the same old path enables and opens the drawer");
    organize = host.querySelector<HTMLInputElement>('[data-folder-role="raw"] input[aria-label^="允许 Agent 自动整理"]')!;
    assert.equal(organize.checked, true, "disabling and re-enabling preserves path consent");
    assert(host.querySelector('[data-folder-path="阅读/资料"]'));
    organize.checked = false; change(organize);
    assert(!host.textContent?.includes("预览方案"));
    organize.checked = true; change(organize);
    host.querySelector<HTMLButtonElement>(".settings-back")!.click();
    button("保留草稿并返回").click();
    assert.equal(detail, false);
    button("目录方案").click();
    assert.equal(host.querySelector<HTMLInputElement>('input[aria-label^="允许 Agent 自动整理"]')!.checked, true, "return and reopen retains the draft");
    button("预览方案").click(); await flush();
    assert.equal(previewCalls, 1);
    assert(!host.textContent?.includes("提炼"), "ordinary binding and consent previews do not promise refinement");
    assert(host.textContent?.includes("关闭 → 允许"));
    assert(!host.textContent?.includes("移动 0"), "preview never invents move counts");
    button("返回修改").click();
    assert.equal(host.querySelector<HTMLInputElement>('input[aria-label^="允许 Agent 自动整理"]')!.checked, true);
    button("预览方案").click(); await flush();
    failed = true;
    const apply = button("应用修改");
    apply.click(); apply.click(); await flush();
    assert.equal(applyCalls, 1, "double activation cannot submit twice");
    assert(host.textContent?.includes("正在应用"));
    settleApply!(); await flush();
    assert(host.textContent?.includes("目录已变化，请重新预览"));
    assert(!host.textContent?.includes("应用修改"), "an expired preview cannot be submitted again");
    assert.equal(detail, true, "failed apply remains in the editor");
    assert.equal(host.querySelector<HTMLInputElement>('input[aria-label^="允许 Agent 自动整理"]')!.checked, true, "failure retains consent draft");
    failed = false;
    button("预览方案").click(); await flush();
    button("应用修改").click(); await flush(); settleApply!(); await flush();
    assert.equal(detail, false, "successful save returns to parent");
    assert(openTestNoticeMessages.at(-1)?.includes("目录设置已应用"));
    assert(!openTestNoticeMessages.at(-1)?.includes("提炼"), "ordinary saves report only the actual folder settings result");
    assert(!openTestNoticeMessages.at(-1)?.includes("未配置模型"));
    assert(optimizeCalls.every(value => value === false), "ordinary saves never request refinement");
    button("目录方案").click();
    assert([...host.querySelectorAll<HTMLElement>(".echoink-folder-bindings")].every(item => item.hidden), "a successfully saved configuration reopens collapsed");
    assert.equal(host.querySelector<HTMLInputElement>('input[aria-label^="允许 Agent 自动整理"]')!.checked, true, "reopening reads persisted consent");
    assert(!host.textContent?.includes("预览方案"));
    // Legacy configured folders remain in the maintenance editor when only one source disappears.
    section.dispose(); detail = false; saved = bound();
    saved.roles.raw.readPaths.push("丢失的来源", "另一个丢失来源"); saved.roles.raw.writePath = "丢失的来源";
    plugin.settings.knowledgeBase.folderBindings = saved;
    section = new KnowledgeFolderSection(plugin, draw, { open() { detail = true; draw(); }, close() { detail = false; draw(); } });
    draw(); assert.equal(section.showDashboard, true, "a missing legacy folder never resets initialization");
    assert(host.textContent?.includes("有目录已失效")); button("目录方案").click();
    assert.equal(host.querySelector("h2")?.textContent, "目录方案");
    assert.equal(host.querySelector(".echoink-folder-routes"), null);
    let reselect = host.querySelector<HTMLButtonElement>('[data-folder-role="raw"] .echoink-folder-header-summary > button')!;
    assert.equal(reselect.textContent, "重新选择");
    reselect.click(); button("取消", openTestModals.at(-1)!.contentEl).click(); await flush();
    assert.deepEqual((section as any).draft.bindings.roles.raw.readPaths, ["阅读/资料", "丢失的来源", "另一个丢失来源"]);
    assert.equal(section.hasDraft, false, "canceling a repair preserves the saved invalid state");
    reselect = host.querySelector<HTMLButtonElement>('[data-folder-role="raw"] .echoink-folder-header-summary > button')!;
    reselect.click(); button("工作/调研", openTestModals.at(-1)!.contentEl).click(); await flush();
    assert.deepEqual((section as any).draft.bindings.roles.raw.readPaths, ["阅读/资料", "工作/调研", "另一个丢失来源"], "repair replaces only the corresponding missing source");
    assert.equal((section as any).draft.bindings.roles.raw.writePath, "工作/调研");
    assert(host.querySelector('[data-folder-role="raw"] .echoink-folder-header-summary')?.textContent?.includes("原目录已失效"), "other broken sources remain visible");
    const removeDefault = host.querySelector<HTMLButtonElement>('[aria-label="解绑文件夹 · 工作/调研"]')!;
    removeDefault.click();
    assert.equal((section as any).draft.bindings.roles.raw.writePath, null, "removing a default with multiple sources does not silently choose another");
    assert(host.querySelector('[aria-label="收藏保存位置"]')?.textContent?.includes("请选择收藏保存位置"));
    assert(host.querySelector(".echoink-folder-issues")?.textContent?.includes("收藏保存位置"));
    const snapshotBeforeRead = JSON.stringify((section as any).draft.bindings);
    folderReadFails = true;
    host.querySelector<HTMLButtonElement>('[aria-label="添加来源目录"]')!.click();
    let failedPicker = openTestModals.at(-1)!;
    assert(failedPicker.contentEl.textContent?.includes("文件夹列表读取失败，请重试"));
    folderReadFails = false; button("重试", failedPicker.contentEl).click();
    assert(failedPicker.contentEl.textContent?.includes("阅读/资料"));
    button("取消", failedPicker.contentEl).click(); await flush();
    assert.equal(JSON.stringify((section as any).draft.bindings), snapshotBeforeRead);
    noFolders = true; host.querySelector<HTMLButtonElement>('[aria-label="添加来源目录"]')!.click();
    failedPicker = openTestModals.at(-1)!;
    assert(failedPicker.contentEl.textContent?.includes("当前仓库还没有可选择的文件夹"));
    assert.equal(failedPicker.contentEl.querySelectorAll(".echoink-settings-navigation-row").length, 0);
    button("取消", failedPicker.contentEl).click(); await flush(); noFolders = false;
    host.querySelector<HTMLButtonElement>(".settings-back")!.click();
    assert(button("放弃修改").classList.contains("settings-danger"));
    button("放弃修改").click(); assert.equal(detail, false);
    // A fresh, empty migration uses route cards; build has only name and parent fields.
    section.dispose(); detail = false; plugin.settings.knowledgeBase.folderBindings = emptyKnowledgeFolderBindings();
    section = new KnowledgeFolderSection(plugin, draw, { open() { detail = true; draw(); }, close() { detail = false; draw(); } });
    draw(); button("目录方案").click();
    assert.equal(host.querySelectorAll(".echoink-folder-routes button").length, 2);
    assert.equal(host.querySelectorAll(".echoink-folder-routes > .echoink-settings-navigation-row").length, 2, "first-time choices use the existing navigation rows");
    button("使用现有").click();
    assert(host.textContent?.includes("资料来源")); assert(!host.textContent?.includes("帮我搭建"));
    section.dispose(); detail = false;
    section = new KnowledgeFolderSection(plugin, draw, { open() { detail = true; draw(); }, close() { detail = false; draw(); } });
    draw(); button("目录方案").click(); button("帮我搭建").click();
    assert.equal(host.querySelectorAll('.echoink-folder-header-top > [role="switch"]').length, 10, "first-time Build also uses outer Switches");
    assert.equal(host.querySelectorAll('.echoink-folder-bindings [role="switch"]').length, 0);
    assert.equal(host.querySelectorAll('.echoink-folder-purpose.is-expanded').length, 2, "Build initially expands only Raw and Wiki");
    assert.equal(host.querySelector<HTMLElement>('[data-folder-role="raw"] .echoink-folder-bindings')!.hidden, false);
    assert.equal(host.querySelector<HTMLElement>('[data-folder-role="wiki"] .echoink-folder-bindings')!.hidden, false);
    assert.equal(host.querySelectorAll('input[aria-label$="目录名称"]').length, 0, "new-folder fields live in a short configuration modal");
    assert(host.querySelector('[data-folder-role="raw"] .echoink-folder-summary')?.textContent?.startsWith("待创建 · "));
    assert(!host.textContent?.includes("原目录已失效"), "planned folders are not broken saved bindings");
    const inboxEnable = host.querySelector<HTMLInputElement>('[data-folder-role="inbox"] [data-folder-control="enabled"]')!;
    const beforeOptional = JSON.stringify((section as any).draft.bindings);
    inboxEnable.checked = true; change(inboxEnable);
    let createModal = openTestModals.at(-1)!;
    assert.equal(host.querySelector<HTMLInputElement>('[data-folder-role="inbox"] [data-folder-control="enabled"]')!.checked, false);
    button("取消", createModal.contentEl).click(); await flush();
    assert.equal(JSON.stringify((section as any).draft.bindings), beforeOptional, "canceling optional Build setup does not change the draft");
    host.querySelector<HTMLButtonElement>('[data-folder-role="raw"] .echoink-folder-path')!.click();
    createModal = openTestModals.at(-1)!;
    assert(createModal.modalEl.classList.contains("echoink-settings-modal"));
    const rawName = createModal.contentEl.querySelector<HTMLInputElement>('input[aria-label="资料来源 · 目录名称"]')!;
    const setName = (value: string) => { rawName.value = value; rawName.dispatchEvent(new dom.win.Event("input", { bubbles: true })); };
    for (const name of ["Raw", "Wiki", "中文目录", "Custom Folder 2026"]) {
      setName(name); assert.equal(button("确认目录", createModal.contentEl).disabled, false, `${name} is a valid name`);
    }
    for (const name of ["bad/path", "bad" + String.fromCharCode(1) + "name"]) {
      setName(name); assert.equal(button("确认目录", createModal.contentEl).disabled, true, "invalid separators and control characters cannot be confirmed");
    }
    setName("重新命名的材料");
    button("仓库根目录", createModal.contentEl).click();
    const parentModal = openTestModals.at(-1)!;
    const parentChoices = [...parentModal.contentEl.querySelectorAll(".echoink-settings-navigation-title")].map(item => item.textContent);
    assert.equal(parentChoices.filter(title => title === "仓库根目录").length, 1);
    assert(!parentChoices.includes("/") && !parentChoices.includes(""));
    assert.equal(parentChoices.length, 5);
    button("读书/2026", parentModal.contentEl).click(); await flush();
    assert(button("读书/2026", createModal.contentEl));
    button("确认目录", createModal.contentEl).click(); await flush();
    assert(host.querySelector('[data-folder-role="raw"] .echoink-folder-summary')?.textContent?.includes("读书/2026/重新命名的材料"));
    const newConsent = host.querySelector<HTMLInputElement>('[data-folder-role="raw"] input[aria-label^="允许 Agent 自动整理"]')!;
    assert.equal(newConsent.checked, false);
    newConsent.checked = true; change(newConsent);
    host.querySelector<HTMLButtonElement>('[data-folder-role="raw"] .echoink-folder-path')!.click();
    createModal = openTestModals.at(-1)!;
    const renamed = createModal.contentEl.querySelector<HTMLInputElement>('input[aria-label="资料来源 · 目录名称"]')!;
    renamed.value = "再次命名"; renamed.dispatchEvent(new dom.win.Event("input", { bubbles: true }));
    button("确认目录", createModal.contentEl).click(); await flush();
    assert.equal(host.querySelector<HTMLInputElement>('[data-folder-role="raw"] input[aria-label^="允许 Agent 自动整理"]')!.checked, false, "changing a planned root clears its old consent");
    // Old bindings can lack native metadata. Live native folders remain authoritative,
    // including Vault-root daily notes, without dirtying a redraw or mutating saved data.
    section.dispose(); detail = false; saved = bound(); plugin.settings.knowledgeBase.folderBindings = saved;
    const savedBeforeNative = JSON.stringify(saved);
    (plugin.app as any).internalPlugins = { plugins: {
      "daily-notes": { instance: { options: { folder: "" } } },
      templates: { instance: { options: { folder: "读书/2026" } } }
    } };
    section = new KnowledgeFolderSection(plugin, draw, { open() { detail = true; draw(); }, close() { detail = false; draw(); } });
    draw(); button("目录方案").click();
    assert(host.querySelector('[data-folder-role="journal"]')?.textContent?.includes("仓库根目录"));
    assert(host.querySelector('[data-folder-role="templates"]')?.textContent?.includes("读书/2026"));
    assert.equal(host.querySelectorAll('button').length > 0, true);
    assert.equal(host.querySelector<HTMLInputElement>('[data-folder-role="journal"] [data-folder-control="enabled"]')!.disabled, true);
    host.querySelector<HTMLButtonElement>('[data-folder-role="journal"] .echoink-folder-disclosure')!.click();
    assert(host.querySelector('[data-folder-role="journal"] .echoink-folder-bindings')?.textContent?.includes("编辑 Obsidian 设置"));
    assert(!host.textContent?.includes("预览方案")); draw();
    assert(!host.textContent?.includes("预览方案"), "native compatibility does not dirty a redraw");
    assert.equal(JSON.stringify(saved), savedBeforeNative, "native readback never mutates plugin settings");
    section.dispose(); detail = false; plugin.settings.knowledgeBase.folderBindings = emptyKnowledgeFolderBindings();
    section = new KnowledgeFolderSection(plugin, draw, { open() { detail = true; draw(); }, close() { detail = false; draw(); } });
    draw(); button("目录方案").click();
    assert.equal(host.querySelectorAll(".echoink-folder-routes button").length, 2, "native plugins do not skip first-time routes");
    button("帮我搭建").click();
    assert.equal((section as any).draft.createPaths.length, 2, "build never creates a second Journal or Templates folder");
    assert(host.querySelector('[data-folder-role="journal"]')?.textContent?.includes("仓库根目录"));
    assert(host.querySelector('[data-folder-role="templates"]')?.textContent?.includes("读书/2026"));
    button("预览方案").click(); await flush();
    assert(!host.textContent?.includes("创建目录 · 4"));
    assert(host.textContent?.includes("待提炼"), "build previews retain real refinement information");
    button("确认初始化").click(); await flush(); settleApply!(); await flush();
    assert.equal(detail, false);
    assert.equal(optimizeCalls.at(-1), true, "build confirmation requests refinement after configuration");
    assert(openTestNoticeMessages.at(-1)?.includes("目录配置完成"));
    assert(openTestNoticeMessages.at(-1)?.includes("知识提炼未开始：未配置模型"), "build completion reports its actual no-Provider state");
    assert.equal(typeof Modal, "function");
    await runKnowledgeFolderActionsTests(host, dom.win);
  } finally { section.dispose(); disposeOriginControls(host); host.remove(); dom.close(); }
  console.log("Knowledge folder settings: PASS (draft and host DOM; native visual acceptance is separate)");
}
