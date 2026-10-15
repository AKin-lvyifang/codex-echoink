import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { Modal, TFolder } from "obsidian";
import type CodexForObsidianPlugin from "../main";
import { emptyKnowledgeFolderBindings } from "../knowledge-base/folder-bindings";
import { previewKnowledgeDirectoryPlan, type KnowledgeDirectoryPlan } from "../knowledge-base/folder-plan";
import { KnowledgeFolderDraft, KnowledgeFolderSection, knowledgeFoldersConfigured } from "../settings/knowledge-folder-section";
import { disposeOriginControls } from "../settings/origin-controls";
import { openTestNoticeMessages } from "./obsidian-shim";

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
  win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }) as any;
  return { win, close() { dom.window.close(); for (const [name, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); } } };
}

export async function runKnowledgeFolderSettingsTests(): Promise<void> {
  assert.equal(knowledgeFoldersConfigured(null), false);
  assert.equal(knowledgeFoldersConfigured(emptyKnowledgeFolderBindings()), false, "empty migration does not skip first-time routes");
  assert.equal(knowledgeFoldersConfigured(bound()), true, "existing configuration needs no new flag");
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
    app: { vault: { getAllLoadedFiles: () => folders, getAbstractFileByPath: (path: string) => folders.find(folder => folder.path === path) ?? null } },
    getKnowledgeSurfaceService: () => manager
  } as unknown as CodexForObsidianPlugin;
  let section: KnowledgeFolderSection;
  const draw = () => { disposeOriginControls(host); host.empty(); if (detail) section.renderDetail(host, true); else section.render(host, true); };
  section = new KnowledgeFolderSection(plugin, draw, { open() { detail = true; draw(); }, close() { detail = false; draw(); } });
  const button = (text: string, root: ParentNode = host) => {
    const found = [...root.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent === text || item.querySelector(".echoink-settings-navigation-title")?.textContent === text);
    assert(found, `Expected button: ${text}`); return found;
  };
  const change = (control: HTMLInputElement) => control.dispatchEvent(new dom.win.Event("change", { bubbles: true }));
  const flush = async () => { for (let index = 0; index < 8; index++) await Promise.resolve(); await new Promise(resolve => setTimeout(resolve, 0)); };
  try {
    draw();
    assert.equal(host.querySelectorAll("button").length, 1, "home has one folder entry");
    button("修改目录方案").click();
    assert.equal(host.querySelector('[role="tablist"]'), null);
    assert.equal(host.querySelectorAll(".echoink-folder-purpose").length, 10);
    assert(!host.textContent?.includes("预览方案"), "unchanged draft has no preview action");
    const raw = host.querySelector<HTMLElement>('[data-folder-role="raw"]')!;
    assert(raw.querySelector('[data-folder-path="阅读/资料"]')?.closest(".echoink-folder-bindings"), "binding is nested under its purpose");
    assert.equal(raw.querySelectorAll(".echoink-folder-tag").length, 2);
    assert.equal(host.querySelectorAll(".echoink-folder-tag").length, 6, "only Raw/Wiki/Projects receive Ask and maintenance tags");
    assert(!host.textContent?.includes("拟新建子目录"));
    assert(!host.textContent?.includes("新资料保存到"), "single source is automatic");
    button("添加来源目录", raw).click();
    let picker = dom.win.document.body.querySelector(".echoink-folder-picker")!;
    const existingChoices = [...picker.querySelectorAll(".echoink-settings-navigation-title")].map(item => item.textContent);
    assert.deepEqual(existingChoices.slice().sort(), ["阅读/资料", "知识/卡片", "工作/调研", "读书/2026"].sort(), "existing-folder picker excludes both Obsidian root path forms");
    button("工作/调研", picker).click(); await flush();
    assert(host.textContent?.includes("新资料保存到"), "multiple sources reveal the default destination selector");
    const extraSource = host.querySelector('[data-folder-path="工作/调研"]')!;
    extraSource.querySelector<HTMLButtonElement>('[aria-label="解除绑定"]')!.click();
    assert(!host.textContent?.includes("新资料保存到"));
    assert.equal(plugin.settings.knowledgeBase.folderBindings!.roles.raw.readPaths.length, 1, "unbind does not write saved settings or delete anything");
    const originalPath = host.querySelector<HTMLButtonElement>('[aria-label="重新选择 · 阅读/资料"]')!;
    originalPath.click(); picker = dom.win.document.body.querySelector(".echoink-folder-picker")!;
    button("工作/调研", picker).click(); await flush();
    host.querySelector<HTMLButtonElement>('[aria-label="重新选择 · 工作/调研"]')!.click();
    picker = dom.win.document.body.querySelector(".echoink-folder-picker")!;
    button("阅读/资料", picker).click(); await flush();
    assert(!host.textContent?.includes("预览方案"), "restoring the original path clears dirty UI");
    const organize = host.querySelector<HTMLInputElement>('[data-folder-role="raw"] input[aria-label^="允许 Agent 自动整理"]')!;
    organize.checked = true; change(organize);
    assert(host.textContent?.includes("预览方案"));
    organize.checked = false; change(organize);
    assert(!host.textContent?.includes("预览方案"));
    organize.checked = true; change(organize);
    host.querySelector<HTMLButtonElement>(".settings-back")!.click();
    button("保留草稿并返回").click();
    assert.equal(detail, false);
    button("修改目录方案").click();
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
    assert(host.textContent?.includes("预览后的资料已变化"));
    assert.equal(detail, true, "failed apply remains in the editor");
    button("返回修改").click();
    assert.equal(host.querySelector<HTMLInputElement>('input[aria-label^="允许 Agent 自动整理"]')!.checked, true, "failure retains consent draft");
    failed = false;
    button("预览方案").click(); await flush();
    button("应用修改").click(); await flush(); settleApply!(); await flush();
    assert.equal(detail, false, "successful save returns to parent");
    assert(openTestNoticeMessages.at(-1)?.includes("目录设置已应用"));
    assert(!openTestNoticeMessages.at(-1)?.includes("提炼"), "ordinary saves report only the actual folder settings result");
    assert(!openTestNoticeMessages.at(-1)?.includes("未配置模型"));
    assert(optimizeCalls.every(value => value === false), "ordinary saves never request refinement");
    button("修改目录方案").click();
    assert.equal(host.querySelector<HTMLInputElement>('input[aria-label^="允许 Agent 自动整理"]')!.checked, true, "reopening reads persisted consent");
    assert(!host.textContent?.includes("预览方案"));
    // A fresh, empty migration uses route cards; build has only name and parent fields.
    section.dispose(); detail = false; plugin.settings.knowledgeBase.folderBindings = emptyKnowledgeFolderBindings();
    section = new KnowledgeFolderSection(plugin, draw, { open() { detail = true; draw(); }, close() { detail = false; draw(); } });
    draw(); button("初始化").click();
    assert.equal(host.querySelectorAll(".echoink-folder-routes button").length, 2);
    button("使用现有").click();
    assert(host.textContent?.includes("资料来源")); assert(!host.textContent?.includes("帮我搭建"));
    section.dispose(); detail = false;
    section = new KnowledgeFolderSection(plugin, draw, { open() { detail = true; draw(); }, close() { detail = false; draw(); } });
    draw(); button("初始化").click(); button("帮我搭建").click();
    assert.equal(host.querySelectorAll('input[aria-label$="目录名称"]').length, 2);
    assert(!host.textContent?.includes("新建位置")); assert(!host.textContent?.includes("选择父目录"));
    button("Vault 根目录").click();
    const modal = [...dom.win.document.body.querySelectorAll(".echoink-folder-picker")].at(-1)!;
    const parentChoices = [...modal.querySelectorAll(".echoink-settings-navigation-title")].map(item => item.textContent);
    assert.equal(parentChoices.filter(title => title === "Vault 根目录").length, 1, "parent picker has one explicit Vault-root choice");
    assert(!parentChoices.includes("/") && !parentChoices.includes(""), "native root objects are excluded from parent rows");
    assert.equal(parentChoices.length, 5);
    button("读书/2026", modal).click(); await flush();
    assert(button("读书/2026"));
    assert.equal(host.querySelector<HTMLInputElement>('input[aria-label^="允许 Agent 自动整理 · 读书/2026/"]')?.checked, false);
    const rawName = host.querySelector<HTMLInputElement>('input[aria-label="资料来源 · 目录名称"]')!;
    let newConsent = host.querySelector<HTMLInputElement>('[data-folder-role="raw"] input[aria-label^="允许 Agent 自动整理"]')!;
    newConsent.checked = true; change(newConsent);
    rawName.value = "重新命名的材料"; rawName.dispatchEvent(new dom.win.Event("input", { bubbles: true }));
    newConsent = host.querySelector<HTMLInputElement>('[data-folder-role="raw"] input[aria-label^="允许 Agent 自动整理"]')!;
    assert.equal(newConsent.checked, false, "changing a build root updates visible consent as well as the draft");
    assert(newConsent.getAttribute("aria-label")?.includes("重新命名的材料"));
    // Old bindings can lack native metadata. Live native folders remain authoritative,
    // including Vault-root daily notes, without dirtying a redraw or mutating saved data.
    section.dispose(); detail = false; saved = bound(); plugin.settings.knowledgeBase.folderBindings = saved;
    const savedBeforeNative = JSON.stringify(saved);
    (plugin.app as any).internalPlugins = { plugins: {
      "daily-notes": { instance: { options: { folder: "" } } },
      templates: { instance: { options: { folder: "读书/2026" } } }
    } };
    section = new KnowledgeFolderSection(plugin, draw, { open() { detail = true; draw(); }, close() { detail = false; draw(); } });
    draw(); button("修改目录方案").click();
    assert(host.querySelector('[data-folder-role="journal"]')?.textContent?.includes("Vault 根目录"));
    assert(host.querySelector('[data-folder-role="templates"]')?.textContent?.includes("读书/2026"));
    assert.equal(host.querySelectorAll('button').length > 0, true);
    assert(!host.textContent?.includes("预览方案")); draw();
    assert(!host.textContent?.includes("预览方案"), "native compatibility does not dirty a redraw");
    assert.equal(JSON.stringify(saved), savedBeforeNative, "native readback never mutates plugin settings");
    section.dispose(); detail = false; plugin.settings.knowledgeBase.folderBindings = emptyKnowledgeFolderBindings();
    section = new KnowledgeFolderSection(plugin, draw, { open() { detail = true; draw(); }, close() { detail = false; draw(); } });
    draw(); button("初始化").click();
    assert.equal(host.querySelectorAll(".echoink-folder-routes button").length, 2, "native plugins do not skip first-time routes");
    button("帮我搭建").click();
    assert.equal(host.querySelectorAll('input[aria-label$="目录名称"]').length, 2, "build never creates a second Journal or Templates folder");
    assert(host.querySelector('[data-folder-role="journal"]')?.textContent?.includes("Vault 根目录"));
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
  } finally { section.dispose(); disposeOriginControls(host); host.remove(); dom.close(); }
  console.log("Knowledge folder settings: PASS (draft and host DOM; native visual acceptance is separate)");
}
