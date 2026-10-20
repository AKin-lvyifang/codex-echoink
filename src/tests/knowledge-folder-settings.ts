import { createHash } from "node:crypto";
import { renderKnowledgeLinkingSection } from "../settings/knowledge-linking-section";
import { KnowledgeLinkingService } from "../plugin/knowledge-linking-service";
import { readKnowledgeLinkingDocument } from "../knowledge-base/knowledge-linking";
import type { KnowledgeLinkingTask } from "../knowledge-base/knowledge-linking-types";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { TFolder } from "obsidian";
import type CodexForObsidianPlugin from "../main";
import { emptyKnowledgeFolderBindings } from "../knowledge-base/folder-bindings";
import { previewKnowledgeDirectoryPlan, type KnowledgeDirectoryPlan } from "../knowledge-base/folder-plan";
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
  const folders = ["阅读/资料", "知识/卡片", "项目研究", "工作兼容", "归档兼容"].map(path => Object.assign(new TFolder(), { path }));
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
        bindings, createPaths, mode: options.mode, kind: async () => "folder", sourcePaths: [], files: [] });
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
    app: { vault: { getAllFolders: () => folders, getAllLoadedFiles: () => folders, getAbstractFileByPath: (path: string) => folders.find(folder => folder.path === path) ?? null, on: () => ({}), offref() {} } },
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
    draw();
    assert.deepEqual([...host.querySelectorAll(".echoink-knowledge-purpose-row .echoink-settings-navigation-title")].map(item => item.firstChild?.textContent), ["资料来源", "知识成果", "项目", "收件箱"]);
    assert(!host.textContent?.includes("工作兼容") && !host.textContent?.includes("归档兼容"), "saved compatibility purposes do not return to the desktop page");
    section.open("sources");
    const original = JSON.stringify(saved);
    const organization = host.querySelector<HTMLInputElement>('input[aria-label="允许 Agent 自动整理"]')!;
    assert(organization);
    saveFails = true; organization.checked = true; organization.dispatchEvent(new dom.win.Event("change", { bubbles: true })); await flush();
    assert.equal(organization.checked, false, "failed immediate save restores the accepted checkbox state");
    assert.equal(JSON.stringify(saved), original);
    saveFails = false; organization.checked = true; organization.dispatchEvent(new dom.win.Event("change", { bubbles: true })); await flush();
    assert.deepEqual(saved.roles.raw.autoOrganizePaths, ["阅读/资料"]);
    assert.equal(saveCalls, 2);
    const beforeInitialization = JSON.stringify(saved);
    section.open("initialize"); button("使用现有文件夹").click(); await flush();
    assert.equal(host.querySelectorAll('.echoink-knowledge-init-fields input[aria-label^="初始化"]').length, 9, "initialization uses the current four purposes and five module locations");
    assert(previewCalls > 0); assert.equal(applyCalls, 0, "rendering and previewing cannot apply directory changes");
    assert.equal(JSON.stringify(saved), beforeInitialization);
    applyFails = true; button("确认初始化").click(); await flush();
    assert.equal(applyCalls, 1);
    assert.equal(JSON.stringify(saved), beforeInitialization, "failed confirmation preserves the current configuration");
    assert(host.textContent?.includes("fixture application failed"));
    assert.equal(button("确认初始化").disabled, true, "failure requires a fresh preview");
    applyFails = false; button("重新核对").click(); await flush(); button("确认初始化").click(); await flush();
    assert.equal(applyCalls, 2); assert.equal(section.isDetail, false);
    assert.equal(saved.roles.work.writePath, "工作兼容"); assert.equal(saved.roles.archive.writePath, "归档兼容");
    await runKnowledgeFolderActionsTests(host, dom.win);
    section.dispose(); disposeOriginControls(host); host.empty();
    const notes = new Map([["wiki/A.md", '---\naliases: [Alpha]\nprivate: frontmatter-private\n---\n# A\nB 帮助理解原句。<!-- echoink-source: {"path":"raw/private-source.md"} -->\n<!-- echoink-source: {"revision":"internal-revision"} -->\n下一行内容。'], ["wiki/B.md", "---\naliases: [Beta]\n---\n# B"]]);
    let savedTask: KnowledgeLinkingTask | null = null; const history = new Map<string, KnowledgeLinkingTask>(); let linkingWrites = 0; let backCalls = 0;
    const linking = new KnowledgeLinkingService({
      async *documents() { for (const [name, content] of notes) yield readKnowledgeLinkingDocument(name, content, `sha256:${createHash("sha256").update(content).digest("hex")}`); },
      async judge(input) { return [{ path: input.documents[0].path, version: input.documents[0].version, mentions: input.candidates }]; },
      read: async name => notes.get(name)!, async write(name, before, after) { assert.equal(notes.get(name), before); notes.set(name, after); linkingWrites++; },
      bindingSignature: () => "bindings", canWrite: () => true
    }, { async load() { return savedTask; }, async save(task) { savedTask = structuredClone(task); history.set(task.id, structuredClone(task)); }, async loadTask(id) { return history.get(id) ?? null; } });
    (manager as any).linking = linking;
    await linking.start(); await linking.waitForIdle();
    let closeLinking = renderKnowledgeLinkingSection(host, plugin, () => backCalls++);
    assert(host.textContent?.includes("待确认"), JSON.stringify(linking.snapshot())); assert(host.textContent?.includes("B → wiki/B.md"), host.textContent ?? "");
    const previewQuote = host.querySelector(".echoink-knowledge-linking-preview-note p")!.textContent!;
    assert.equal(previewQuote, "B 帮助理解原句。", "preview quotes the original mention line and excludes its inline source comment");
    assert(!host.textContent?.includes("frontmatter-private")); assert(!host.textContent?.includes("echoink-source")); assert(!host.textContent?.includes("internal-revision")); assert(!host.textContent?.includes("下一行内容"));
    assert.equal(host.querySelectorAll(".mod-cta").length, 1, "preview has one primary confirmation");
    closeLinking(); host.empty(); assert.equal(linking.snapshot()?.phase, "awaiting-confirmation", "closing detail never cancels preview");
    closeLinking = renderKnowledgeLinkingSection(host, plugin, () => backCalls++);
    button("确认补全").click(); await flush(); await linking.waitForIdle();
    assert.equal(linkingWrites, 1); assert.equal(linking.snapshot()?.phase, "completed"); const completedTaskId = linking.snapshot()!.id; closeLinking(); host.empty();
    await linking.start(); await linking.waitForIdle();
    assert.equal(linking.snapshot()?.phase, "completed", "a new scan sees the already linked note");
    closeLinking = renderKnowledgeLinkingSection(host, plugin, () => backCalls++);
    button("返回知识库").click(); assert.equal(backCalls, 1); closeLinking(); host.empty();
    closeLinking = renderKnowledgeLinkingSection(host, plugin, () => backCalls++, completedTaskId); await flush();
    assert(host.textContent?.includes("wiki/A.md"), "historical task details retain their own results after the next task finishes");
    assert.equal(linking.snapshot()?.id === completedTaskId, false); closeLinking(); await linking.dispose();
    host.empty();
    const longBody = `---\r\nprivate: hidden-frontmatter\r\n---\r\n# Long\r\n${"😀".repeat(90)}B${"后".repeat(90)}\r\n<!-- echoink-source: hidden-source -->`;
    const mentionStart = longBody.indexOf("B");
    const previewTask: KnowledgeLinkingTask = { ...history.get(completedTaskId)!, phase: "awaiting-confirmation", patches: [{ path: "wiki/Long.md", before: longBody, after: longBody, mentions: [{ start: mentionStart, end: mentionStart + 1, text: "B", targetPath: "wiki/B.md" }], addedAliases: [] }] };
    (manager as any).linking = { subscribe(listener: (task: KnowledgeLinkingTask) => void) { listener(previewTask); return () => undefined; } };
    closeLinking = renderKnowledgeLinkingSection(host, plugin, () => backCalls++);
    assert.equal(host.querySelector(".echoink-knowledge-linking-preview-note p")!.textContent, `…${"😀".repeat(70)}B${"后".repeat(70)}…`, "long-line excerpt keeps original characters and marks truncation without splitting emoji");
    assert(!host.textContent?.includes("hidden-frontmatter")); assert(!host.textContent?.includes("echoink-source")); closeLinking();
  } finally { section.dispose(); disposeOriginControls(host); host.remove(); dom.close(); }
  console.log("Knowledge folder settings: PASS (current desktop page, saves, initialization and linking; native visual acceptance is separate)");
}
