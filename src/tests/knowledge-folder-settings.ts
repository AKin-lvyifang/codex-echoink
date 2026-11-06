import { installObsidianDom } from "./obsidian-dom";
import { createHash } from "node:crypto";
import { renderKnowledgeLinkingSection } from "../settings/knowledge-linking-section";
import { KnowledgeLinkingService } from "../plugin/knowledge-linking-service";
import { readKnowledgeLinkingDocument } from "../knowledge-base/knowledge-linking";
import type { KnowledgeLinkingTask } from "../knowledge-base/knowledge-linking-types";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { TFolder } from "obsidian";
import type CodexForObsidianPlugin from "../main";
import { emptyKnowledgeFolderBindings, knowledgeCollectionTargets } from "../knowledge-base/folder-bindings";
import { previewKnowledgeDirectoryPlan, type KnowledgeDirectoryPlan } from "../knowledge-base/folder-plan";
import { initializationFolderTree } from "../settings/knowledge-initialization-tree";
import { DesktopKnowledgeSettings } from "../settings/desktop-knowledge-settings";
import { DEFAULT_SETTINGS } from "../settings/settings";
import { DESKTOP_KNOWLEDGE_ROOT_ROLES } from "../knowledge-base/root-paths-core";
import { disposeOriginControls } from "../settings/origin-controls";
import { runKnowledgeFolderActionsTests } from "./knowledge-folder-actions";

function bound() {
  const config = emptyKnowledgeFolderBindings();
  for (const [role, path] of [["raw", "阅读/资料"], ["wiki", "知识/卡片"]] as const) Object.assign(config.roles[role], { enabled: true, readPaths: [path], writePath: path });
  return config;
}

function prepareDOM() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
  installObsidianDom(dom.window);
  const win = dom.window;
  const previous = new Map<string, PropertyDescriptor | undefined>();
  for (const name of ["window", "document", "navigator", "HTMLElement", "HTMLFormElement", "HTMLInputElement", "Element", "Node", "Event", "MouseEvent", "KeyboardEvent", "MutationObserver", "DocumentFragment", "getComputedStyle"]) {
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
  const dom = prepareDOM();
  const host = dom.win.document.body.createDiv({ cls: "echoink-settings-demo" });
  const folders = ["阅读/资料", "阅读/资料/待读", "知识/卡片", "项目研究", "工作兼容", "归档兼容"].map(path => Object.assign(new TFolder(), { path }));
  const settings = structuredClone(DEFAULT_SETTINGS);
  let saved = bound();
  for (const [role, directory] of [["work", "工作兼容"], ["archive", "归档兼容"]] as const) Object.assign(saved.roles[role], { enabled: true, readPaths: [directory], writePath: directory, autoOrganizePaths: [directory] });
  settings.knowledgeBase.folderBindings = saved;
  let saveFails = false, applyFails = false, saveCalls = 0, applyCalls = 0, previewCalls = 0;
  const manager = {
    directoryWritable: true, folderOperationBusy: false,
    folderNameScopes: () => ["阅读/资料", "知识/卡片"],
    async getOriginalDirectoryStatus() { return null; },
    async saveDirectoryBindings(next: typeof saved) {
      saveCalls++;
      if (saveFails) throw new Error("fixture save failed");
      saved = structuredClone(next); saved.revision++;
      settings.knowledgeBase.folderBindings = saved;
      return saved;
    },
    async previewDirectoryPlan(bindings: typeof saved, createPaths: string[], options: any) {
      previewCalls++;
      return previewKnowledgeDirectoryPlan({ baseRevision: saved.revision, baseline: saved, roleScope: DESKTOP_KNOWLEDGE_ROOT_ROLES,
        bindings, createPaths, moduleDirectories: options.moduleDirectories, mode: options.mode, kind: async path => folders.some(folder => folder.path === path) ? "folder" : "missing", sourcePaths: [], files: [] });
    },
    async applyDirectoryPlan(plan: KnowledgeDirectoryPlan) {
      applyCalls++;
      if (applyFails) throw new Error("fixture application failed; original bindings retained");
      saved = structuredClone(plan.bindings); saved.configured = true; saved.revision++;
      settings.knowledgeBase.folderBindings = saved;
      return { configured: true as const, created: [], moved: [], refinement: "not-started" as const };
    },
    async getInitializationState() { return null; }
  };
  const plugin = {
    settings,
    app: { scope: {}, keymap: { pushScope() {}, popScope() {} }, vault: { getAllFolders: () => folders, getAllLoadedFiles: () => folders, getAbstractFileByPath: (path: string) => folders.find(folder => folder.path === path) ?? null, on: () => ({}), offref() {} } },
    getKnowledgeSurfaceService: () => manager
  } as unknown as CodexForObsidianPlugin;
  let section: DesktopKnowledgeSettings;
  const draw = () => { disposeOriginControls(host); host.empty(); if (section.isDetail) section.renderDetail(host); else section.renderSummary(host); };
  section = new DesktopKnowledgeSettings(plugin, { redraw: draw, openPreferences() {}, openLinking() {}, openEditor(editor) { editor.open(); } });
  const button = (text: string, root: ParentNode = host) => {
    const found = [...root.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent === text || item.getAttribute("aria-label") === text || item.querySelector(".echoink-settings-navigation-title")?.textContent === text);
    assert(found, `Expected button: ${text}`); return found;
  };
  const flush = async () => { for (let index = 0; index < 8; index++) await Promise.resolve(); await new Promise(resolve => setTimeout(resolve, 0)); };
  try {
    const existingBindings = saved;
    settings.knowledgeBase.folderBindings = null;
    section.open("sources"); button("添加来源目录").click(); button("阅读/资料").click(); await flush();
    assert.deepEqual(saved.roles.raw.readPaths, ["阅读/资料"]);
    assert.equal(saved.collectionTargets?.answer, "收藏/回答", "a new user's first source binding cannot replace the conversation default");
    assert.equal(saved.answerDirectoryPending, true);
    section.requestLeave(draw);
    saved = emptyKnowledgeFolderBindings(); settings.knowledgeBase.folderBindings = null;
    section.open("initialize"); button("帮我搭建").click(); await flush(); button("预览").click(); await flush(); button("确认初始化").click(); await flush();
    assert.equal(saved.configured, true);
    assert.equal(saved.collectionTargets?.answer, "收藏/回答", "initialization materializes the conversation default before assigning a source role");
    assert.equal(saved.answerDirectoryPending, true);
    saved = existingBindings; settings.knowledgeBase.folderBindings = saved; saveCalls = 0; applyCalls = 0; previewCalls = 0;
    draw();
    assert.deepEqual([...host.querySelectorAll(".echoink-knowledge-purpose-row .echoink-settings-navigation-title")].map(item => item.firstChild?.textContent), ["资料来源", "知识成果", "项目", "收件箱"]);
    assert(!host.textContent?.includes("工作兼容") && !host.textContent?.includes("归档兼容"), "saved compatibility purposes do not return to the desktop page");
    section.open("sources");
    assert(!host.textContent?.includes("资料默认保存到") && !host.querySelector(".echoink-knowledge-save-location"), "sources page only controls reading folders");
    section.open("collections");
    assert.equal(host.querySelectorAll('[role="combobox"]').length, 7, "every capture entry has one searchable destination control");
    assert.deepEqual([...host.querySelectorAll("[data-collection-kind] .setting-item-name")].map(row => row.textContent), ["网页", "公众号文章", "拖入或附加的文档（PDF、Word DOCX、Markdown、TXT）", "拖入或附加的图片（PNG、JPG/JPEG、GIF、WebP）", "存为笔记的回答", "从资料生成", "Excalidraw 手绘图"]);
    const collectionSnapshot = JSON.stringify(knowledgeCollectionTargets(saved));
    host.querySelector<HTMLButtonElement>('[data-collection-kind="excalidraw"] [role="combobox"]')!.click(); await flush();
    const drawingPopup = dom.win.document.querySelector(".echoink-folder-picker-popover")!;
    assert(drawingPopup.textContent?.includes("项目研究"), "drawing folders include ordinary folders outside source bindings");
    [...drawingPopup.querySelectorAll<HTMLElement>('[role="option"]')].find(option => option.textContent === "项目研究")!.click(); await flush();
    assert.equal(saved.excalidrawDirectory, "项目研究");
    assert.equal(JSON.stringify(knowledgeCollectionTargets(saved)), collectionSnapshot, "drawing selection never enters collectionTargets");
    assert(host.textContent?.includes("不影响你自己新建的笔记"));
    assert.equal(host.querySelectorAll('[data-collection-kind]:not([data-collection-kind="excalidraw"]) .setting-item-description').length, 6, "the existing capture and output descriptions are preserved");
    assert(!host.textContent?.includes("跟随默认"));
    saved.collectionTargets = { answer: "收藏/回答" }; saved.answerDirectoryPending = true;
    section.open("collections");
    let conversationRow = host.querySelector<HTMLElement>('[data-collection-kind="answer"]')!;
    assert(conversationRow.querySelector('[data-echoink-focus-key="knowledge:collections:answer"]'));
    assert.equal(conversationRow.querySelector(".echoink-folder-picker-new")?.textContent, "新建");
    assert.equal(conversationRow.querySelector('[role="alert"]'), null, "the pending default is not a missing-folder error");
    conversationRow.querySelector<HTMLButtonElement>('[role="combobox"]')!.click(); await flush();
    const conversationPopup = dom.win.document.querySelector(".echoink-folder-picker-popover")!;
    assert(conversationPopup.textContent?.includes("项目研究"), "conversation content may use folders outside source bindings");
    assert(!conversationPopup.textContent?.includes("新建文件夹…"));
    [...conversationPopup.querySelectorAll<HTMLElement>('[role="option"]')].find(option => option.textContent === "项目研究")!.click(); await flush();
    assert.equal(saved.collectionTargets?.answer, "项目研究");
    assert.equal(saved.answerDirectoryPending, false, "an explicit conversation location is no longer pending");
    conversationRow = host.querySelector<HTMLElement>('[data-collection-kind="answer"]')!;
    assert.equal(conversationRow.querySelector('[role="alert"]'), null);
    saved.collectionTargets!.answer = "已移除对话目录";
    section.open("collections");
    conversationRow = host.querySelector<HTMLElement>('[data-collection-kind="answer"]')!;
    assert(conversationRow.textContent?.includes("已移除对话目录"));
    assert(conversationRow.textContent?.includes("文件夹不存在，请重新选择"));
    const savesBeforeOrganization = saveCalls;
    saved.collectionTargets = { web: "已移除来源", wechat: "阅读/资料", files: "阅读/资料", text: "阅读/资料" };
    section.open("collections");
    assert(host.textContent?.includes("文件夹不存在，请重新选择"));
    assert.equal(saved.collectionTargets.web, "已移除来源");
    saved.collectionTargets.web = "阅读/资料";
    section.open("sources");
    assert(!host.querySelector('[aria-label="允许 Agent 自动整理"]'), "bound folders no longer have independent organization grants");
    section.open("permissions");
    const original = JSON.stringify(saved);
    const organization = host.querySelector<HTMLInputElement>('[aria-label="允许 Agent 分类整理"]')!;
    assert(organization);
    assert.equal(organization.checked, true, "organization is enabled by default");
    assert(!host.querySelector('[aria-label="允许 Agent 新建子文件夹"]'));
    assert(host.textContent?.includes("Agent 可以在允许的文件夹里新建子文件夹，把文件归类挪进去；不删除文件，也不挪出原来的根文件夹；整理前会先给你看方案。"));
    const range = host.querySelector<HTMLSelectElement>('[aria-label="分类整理范围"]')!;
    assert.equal(range.value, "all");
    assert.deepEqual([...range.options].map(option => option.textContent), ["全部文件夹", "选定的文件夹"]);
    saveFails = true; organization.checked = false; organization.dispatchEvent(new dom.win.Event("change", { bubbles: true })); await flush();
    assert.equal(organization.checked, true, "failed immediate save restores the accepted checkbox state");
    assert.equal(JSON.stringify(saved), original);
    saveFails = false; organization.checked = false; organization.dispatchEvent(new dom.win.Event("change", { bubbles: true })); await flush();
    assert.deepEqual(saved.organization, { enabled: false, scope: "all", paths: [] });
    assert.equal(saved.roles.raw.autoOrganizePaths, undefined);
    assert.equal(saveCalls - savesBeforeOrganization, 2);
    assert.equal(range.disabled, true, "disabled organization cannot edit the range");
    range.value = "selected"; range.dispatchEvent(new dom.win.Event("change", { bubbles: true })); await flush();
    assert.equal(saved.organization?.scope, "all");
    organization.checked = true; organization.dispatchEvent(new dom.win.Event("change", { bubbles: true })); await flush();
    saveFails = true;
    range.value = "selected"; range.dispatchEvent(new dom.win.Event("change", { bubbles: true })); await flush();
    assert.equal(saved.organization?.scope, "all");
    assert.equal(range.value, "all", "failed scope saves restore the accepted selection");
    saveFails = false;
    range.value = "selected"; range.dispatchEvent(new dom.win.Event("change", { bubbles: true })); await flush();
    assert.equal(saved.organization?.scope, "selected");
    assert(host.textContent?.includes("请至少选择一个文件夹"));
    const pickerTrigger = () => host.querySelector<HTMLButtonElement>('[role="combobox"][aria-label="分类整理文件夹"]')!;
    const chooseOrganizationFolder = async (path: string) => {
      pickerTrigger().click(); await flush();
      const popup = dom.win.document.querySelector(".echoink-folder-picker-popover")!;
      const options = [...popup.querySelectorAll<HTMLElement>('[role="option"]')];
      assert.deepEqual(options.map(option => option.textContent), ["阅读/资料", "阅读/资料/待读", "知识/卡片"].filter(value => !saved.organization?.paths.includes(value)), "only enabled, bound Knowledge folders and their children can be chosen");
      assert(!popup.textContent?.includes("新建文件夹"));
      options.find(option => option.textContent === path)!.click(); await flush();
    };
    await chooseOrganizationFolder("阅读/资料/待读");
    await chooseOrganizationFolder("知识/卡片");
    assert.deepEqual(saved.organization?.paths, ["阅读/资料/待读", "知识/卡片"]);
    assert.equal(host.querySelectorAll(".echoink-folder-picker-tag").length, 2);
    assert(!host.textContent?.includes("请至少选择一个文件夹"));
    range.value = "all"; range.dispatchEvent(new dom.win.Event("change", { bubbles: true })); await flush();
    assert.equal(host.querySelector('[aria-label="分类整理文件夹"]'), null);
    assert.deepEqual(saved.organization?.paths, ["阅读/资料/待读", "知识/卡片"], "all-folder mode preserves the selected-folder range");
    range.value = "selected"; range.dispatchEvent(new dom.win.Event("change", { bubbles: true })); await flush();
    assert.equal(host.querySelectorAll(".echoink-folder-picker-tag").length, 2);
    organization.checked = false; organization.dispatchEvent(new dom.win.Event("change", { bubbles: true })); await flush();
    assert.equal(pickerTrigger().disabled, true);
    assert.deepEqual(saved.organization?.paths, ["阅读/资料/待读", "知识/卡片"], "turning off organization preserves its selected range");
    organization.checked = true; organization.dispatchEvent(new dom.win.Event("change", { bubbles: true })); await flush();
    saveFails = true; button("移除知识/卡片").click(); await flush();
    assert.deepEqual(saved.organization?.paths, ["阅读/资料/待读", "知识/卡片"]);
    assert.equal(host.querySelectorAll(".echoink-folder-picker-tag").length, 2, "failed range saves restore the accepted selections");
    assert(host.textContent?.includes("fixture save failed"));
    saveFails = false; button("移除知识/卡片").click(); await flush();
    assert.deepEqual(saved.organization?.paths, ["阅读/资料/待读"]);
    saved.organization!.paths.push("项目研究", "已移除文件夹");
    section.open("permissions");
    assert(host.textContent?.includes("文件夹不存在或已不在允许范围内"));
    assert.deepEqual([...host.querySelectorAll(".echoink-folder-picker-tag-path")].map(tag => tag.textContent), ["阅读/资料/待读", "项目研究", "已移除文件夹"], "invalid saved selections remain visible rather than falling back to other folders");
    assert.deepEqual(saved.organization?.paths, ["阅读/资料/待读", "项目研究", "已移除文件夹"]);
    const beforeInitialization = JSON.stringify(saved);
    section.open("initialize"); button("使用现有文件夹").click(); await flush();
    assert.equal(host.querySelectorAll('.echoink-knowledge-init-fields .echoink-folder-picker').length, 9, "initialization uses searchable folder choices for the four purposes and five module locations");
    for (const label of ["初始化复盘输出", "初始化英文稿", "初始化表达库", "初始化原 PDF"]) {
      assert.equal(host.querySelector<HTMLButtonElement>(`[role="combobox"][aria-label="${label}"]`)!.disabled, false, "module folders can be configured before enabling the modules");
    }
    assert(previewCalls > 0); assert.equal(applyCalls, 0, "rendering and previewing cannot apply directory changes");
    assert.equal(JSON.stringify(saved), beforeInitialization);
    assert(!host.textContent?.includes("重新核对") && !host.textContent?.includes("查看实际变更"));
    button("预览").click(); await flush();
    assert(host.querySelector(".echoink-init-tree"), "preview opens a folder tree inside the settings page");
    assert(host.textContent?.includes("资料来源"));
    const previewBranch = host.querySelector<HTMLDetailsElement>(".echoink-init-tree-branch")!;
    assert.equal(previewBranch.open, true);
    previewBranch.querySelector("summary")!.click(); assert.equal(previewBranch.open, false);
    button("返回初始化文件夹").click(); await flush();
    assert(host.querySelector('[aria-label="初始化资料来源"]'), "return retains the selected form");
    applyFails = true; button("预览").click(); await flush(); button("确认初始化").click(); await flush();
    assert.equal(applyCalls, 1);
    assert.equal(JSON.stringify(saved), beforeInitialization, "failed confirmation preserves the current configuration");
    assert(host.textContent?.includes("fixture application failed"));
    assert.equal(button("确认初始化").disabled, false, "the preview automatically rechecks the current selections after a failed application");
    applyFails = false; button("返回初始化文件夹").click(); await flush(); button("确认初始化").click(); await flush();
    assert.equal(applyCalls, 2); assert.equal(section.isDetail, false);
    assert.equal(saved.roles.work.writePath, "工作兼容"); assert.equal(saved.roles.archive.writePath, "归档兼容");
    section.open("initialize"); button("帮我搭建").click(); await flush();
    assert.equal(host.querySelectorAll('.echoink-knowledge-init-fields [role="combobox"]').length, 9, "each location initially has one selector, including pending new folders");
    assert.equal(host.querySelectorAll('.echoink-knowledge-init-fields input').length, 0, "new-folder names do not leave permanent input rows");
    button("预览").click(); await flush();
    assert(host.querySelector('.echoink-init-tree-row[data-folder-path="raw"]')?.textContent?.includes("新建"));
    assert(host.querySelector('.echoink-init-tree-row[data-folder-path="outputs/english-diary"]')?.textContent?.includes("英文稿"));
    const treePlan = (section as any).plan as KnowledgeDirectoryPlan;
    const tree = initializationFolderTree(["old", "old/deep"], { ...treePlan, moves: [{ from: "note.md", to: "raw/note.md", size: 1, mtime: 1 }] });
    assert.equal(tree.find(folder => folder.path === "raw")?.moved, 1);
    assert.equal(tree.find(folder => folder.path === "old")?.created, false);
    const beforeFolderRefresh = previewCalls;
    section.followFolderRename("unselected-folder", "moved-folder"); draw(); await flush();
    assert(previewCalls > beforeFolderRefresh, "redrawing the preview after a folder event recalculates the invalidated plan");
    assert.equal(button("确认初始化").disabled, false, "folder-event redraw cannot strand the preview without a plan");
    button("返回初始化文件夹").click(); await flush();
    const applyCount = applyCalls;
    let left = false; section.requestLeave(() => { left = true; draw(); });
    assert(left && !section.hasDraft && !section.isDetail, "return immediately discards the unconfirmed plan");
    assert.equal(applyCalls, applyCount, "discarding a plan cannot create folders or apply bindings");
    assert(!host.textContent?.includes("放弃修改"));
    await runKnowledgeFolderActionsTests(host, dom.win);
    section.dispose(); disposeOriginControls(host); host.empty();
    const notes = new Map([["wiki/A.md", '---\naliases: [Alpha]\nprivate: frontmatter-private\n---\n# A\nB 帮助理解原句。<!-- echoink-source: {"path":"raw/private-source.md"} -->\n<!-- echoink-source: {"revision":"internal-revision"} -->\n下一行内容。'], ["wiki/B.md", "---\naliases: [Beta]\n---\n# B"]]);
    let savedTask: KnowledgeLinkingTask | null = null; const history = new Map<string, KnowledgeLinkingTask>(); let linkingWrites = 0;
    const linking = new KnowledgeLinkingService({
      async *documents() { for (const [name, content] of notes) yield readKnowledgeLinkingDocument(name, content, `sha256:${createHash("sha256").update(content).digest("hex")}`); },
      async judge(input) { return [{ path: input.documents[0].path, version: input.documents[0].version, mentions: input.candidates }]; },
      read: async name => notes.get(name)!, async write(name, before, after) { assert.equal(notes.get(name), before); notes.set(name, after); linkingWrites++; },
      bindingSignature: () => "bindings", canWrite: () => true
    }, { async load() { return savedTask; }, async save(task) { savedTask = structuredClone(task); history.set(task.id, structuredClone(task)); }, async loadTask(id) { return history.get(id) ?? null; } });
    (manager as any).linking = linking;
    await linking.start(); await linking.waitForIdle();
    let ownerSettings = "";
    (plugin as any).openModuleOwnerSettings = async (module: string) => { ownerSettings = module; };
    const closeUnassigned = renderKnowledgeLinkingSection(host, plugin);
    button("指定负责人").click(); await flush();
    assert.equal(ownerSettings, "knowledge-base"); assert.equal(linkingWrites, 0, "unassigned linking routes to owner settings without applying writes");
    closeUnassigned(); host.empty();
    settings.agentRegistry.moduleOwners["knowledge-base"] = "generalist";
    let closeLinking = renderKnowledgeLinkingSection(host, plugin, undefined, true);
    await flush();
    assert.equal(host.querySelector(".echoink-knowledge-linking-located"), host.querySelector('[data-echoink-focus-key="knowledge:linking"]')?.closest(".setting-item"), "deep link highlights the actual linking row");
    assert.equal(dom.win.document.activeElement, host.querySelector('[data-echoink-focus-key="knowledge:linking"]'), "deep link focuses the row in its owning settings document");
    assert(host.textContent?.includes("待确认"), JSON.stringify(linking.snapshot())); assert(host.textContent?.includes("B → wiki/B.md"), host.textContent ?? "");
    const previewQuote = host.querySelector(".echoink-knowledge-linking-preview-note p")!.textContent!;
    assert.equal(previewQuote, "B 帮助理解原句。", "preview quotes the original mention line and excludes its inline source comment");
    assert(!host.textContent?.includes("frontmatter-private")); assert(!host.textContent?.includes("echoink-source")); assert(!host.textContent?.includes("internal-revision")); assert(!host.textContent?.includes("下一行内容"));
    assert.equal(host.querySelectorAll(".mod-cta").length, 1, "preview has one primary confirmation");
    closeLinking(); host.empty(); assert.equal(linking.snapshot()?.phase, "awaiting-confirmation", "closing detail never cancels preview");
    closeLinking = renderKnowledgeLinkingSection(host, plugin);
    button("确认写入").click(); await flush(); await linking.waitForIdle();
    assert.equal(linkingWrites, 1); assert.equal(linking.snapshot()?.phase, "completed"); const completedTaskId = linking.snapshot()!.id; closeLinking(); host.empty();
    await linking.start(); await linking.waitForIdle();
    assert.equal(linking.snapshot()?.phase, "completed", "a new scan sees the already linked note");
    closeLinking = renderKnowledgeLinkingSection(host, plugin);
    assert.equal(host.querySelector(".settings-back"), null, "linking stays inline without its own detail page");
    assert(host.textContent?.includes("条链接"));
    assert.equal(button("开始").disabled, false); closeLinking(); host.empty();
    closeLinking = renderKnowledgeLinkingSection(host, plugin, completedTaskId); await flush();
    assert(host.textContent?.includes("wiki/A.md"), "historical task details retain their own results after the next task finishes");
    assert.equal(linking.snapshot()?.id === completedTaskId, false); closeLinking(); await linking.dispose();
    host.empty();
    const longBody = `---\r\nprivate: hidden-frontmatter\r\n---\r\n# Long\r\n${"😀".repeat(90)}B${"后".repeat(90)}\r\n<!-- echoink-source: hidden-source -->`;
    const mentionStart = longBody.indexOf("B");
    const previewTask: KnowledgeLinkingTask = { ...history.get(completedTaskId)!, phase: "awaiting-confirmation", patches: [{ path: "wiki/Long.md", before: longBody, after: longBody, mentions: [{ start: mentionStart, end: mentionStart + 1, text: "B", targetPath: "wiki/B.md" }], addedAliases: [] }] };
    (manager as any).linking = { subscribe(listener: (task: KnowledgeLinkingTask) => void) { listener(previewTask); return () => undefined; } };
    closeLinking = renderKnowledgeLinkingSection(host, plugin);
    assert.equal(host.querySelector(".echoink-knowledge-linking-preview-note p")!.textContent, `…${"😀".repeat(70)}B${"后".repeat(70)}…`, "long-line excerpt keeps original characters and marks truncation without splitting emoji");
    assert(!host.textContent?.includes("hidden-frontmatter")); assert(!host.textContent?.includes("echoink-source")); closeLinking();
  } finally { section.dispose(); disposeOriginControls(host); host.remove(); dom.close(); }
  console.log("Knowledge folder settings: PASS (current desktop page, saves, initialization and linking; native visual acceptance is separate)");
}
