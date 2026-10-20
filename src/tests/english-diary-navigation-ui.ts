import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { EnglishDiaryPageView, ENGLISH_DIARY_PAGE_VIEW_TYPE } from "../home/english-diary-page";
import { EnglishExpressionBrowser } from "../english-diary/expression-view";
import { GENERAL_ASSISTANT_ID } from "../agents/types";
import type { ExpressionEntry, SavedDiaryEntry } from "../english-diary/types";

/** Actual page/browser/heatmap components, synthetic repository; native layout is separate. */
export async function runEnglishDiaryNavigationUiTests(): Promise<void> {
  const dom = new JSDOM("<body><main></main></body>", { pretendToBeVisual: true });
  const win = dom.window;
  Object.assign(globalThis, { window: win, document: win.document, HTMLElement: win.HTMLElement });
  const proto = win.HTMLElement.prototype as any;
  proto.empty = function () { this.replaceChildren(); };
  proto.setText = function (text: string) { this.textContent = text; };
  proto.addClass = function (...names: string[]) { this.classList.add(...names); };
  proto.removeClass = function (...names: string[]) { this.classList.remove(...names); };
  proto.toggleClass = function (name: string, value: boolean) { this.classList.toggle(name, value); };
  proto.setAttr = function (name: string, value: string) { this.setAttribute(name, value); };
  proto.scrollIntoView = function () {};
  proto.scrollTo = function (_x: number, y: number) { this.scrollTop = y; };
  proto.getClientRects = function () { return [{}]; };
  proto.createEl = function (tag: string, options: any = {}) {
    const element = this.ownerDocument.createElement(tag);
    if (options.cls) element.className = options.cls;
    if (options.text !== undefined) element.textContent = options.text;
    if (options.value !== undefined) element.value = options.value;
    for (const [name, value] of Object.entries(options.attr ?? {})) element.setAttribute(name, String(value));
    this.appendChild(element); return element;
  };
  proto.createDiv = function (options: any) { return this.createEl("div", options); };
  proto.createSpan = function (options: any) { return this.createEl("span", options); };
  Object.defineProperty(win.document, "hasFocus", { value: () => true });
  const root = win.document.querySelector("main")! as HTMLElement;
  let subscribed = 0, released = 0, scopesPushed = 0, scopesPopped = 0, saved = 0, reads = 0, readOnlyReads = 0;
  const listeners = new Map<string, (file: { path: string }) => void>();
  const events = { on: (event: string, callback: any) => { subscribed++; listeners.set(event, callback); return { event }; }, offref: () => { released++; } };
  const app: any = { vault: events, scope: {}, keymap: { pushScope() { scopesPushed++; }, popScope() { scopesPopped++; } }, workspace: { on: () => ({}), requestSaveLayout() {}, offref() {} } };
  const diary = (index: number): SavedDiaryEntry => ({ id: `diary-${index}`, sourcePath: `Journal/day-${index}.md`, englishPath: `English/day-${index}.md`, title: `Day ${index}`, date: `2026-10-${String(index + 1).padStart(2, "0")}`, preview: `The saved English draft ${index}.`, expressionCount: index, generatedAt: "2026-10-18T12:00:00Z", missingSource: false, missingEnglish: false, sourceChanged: false, englishModified: false });
  let diaries = Array.from({ length: 25 }, (_, index) => diary(index));
  diaries[1].missingSource = true; diaries[2].missingEnglish = true; diaries[3].sourceChanged = true; diaries[4].englishModified = true;
  const expression = (index: number): ExpressionEntry => ({ schema: 1, path: `Expressions/term-${index}.md`, userCategory: false, id: `expression-${index}`, term: `Term ${String(index).padStart(2, "0")}`, type: index % 2 ? "phrase" : "sentence", meaning: `意思${index}`, category: index % 2 ? "Work" : "Life", note: "", occurrences: [{ id: `occurrence-${index}`, journalId: `diary-${index}`, date: "2026-10-18", sourcePath: `Journal/day-${index}.md`, sourceTitle: `Day ${index}`, englishPath: `English/day-${index}.md`, sourceFingerprint: "saved-fingerprint", targetExcerpt: `A saved English sentence ${index}.`, sourceExcerpt: `原文${index}`, scene: "真实收录场景", reason: "具体语境", status: "verified", usage: "已保存的用法", example: "A saved example." }] });
  let entries = Array.from({ length: 45 }, (_, index) => expression(index));
  let expressionsFail = false, diariesFail = false, activityFail = false, writesAllowed = true;
  let openedDiary = "", openedFile = "", openedToday = 0, todayPrefill = "", home = 0, confirms = 0, confirmResult = true;
  const taskPrefills: Array<[string, string]> = [];
  const repository: any = {
    subscribe: () => { subscribed++; return () => { released++; }; }, affectsExpressions: (path: string) => path.startsWith("Expressions/"),
    listGenerationActivity: async (options: any) => { if (options?.readOnly) readOnlyReads++; if (activityFail) throw new Error("activity read failed"); return [{ date: "2026-10-18", expressionCount: 8, generationCount: 2 }]; },
    listSavedDiaries: async () => { reads++; if (diariesFail) throw new Error("diaries read failed"); return { entries: diaries, errors: [] }; },
    listExpressions: async (_query: string, _category: string, options: any) => { if (options?.readOnly) readOnlyReads++; if (expressionsFail) throw new Error("expression read failed"); return entries; },
    updateExpression: async (id: string, patch: any) => { if (!writesAllowed) throw new Error("read only"); saved++; const index = entries.findIndex(entry => entry.id === id); entries[index] = { ...entries[index], ...patch }; return entries[index]; },
    removeOccurrence: async () => {}
  };
  const host: any = { api: { repository, access: { checkCapability: (capability: string) => capability !== "diary.expression.write" || writesAllowed, requireCapability: (capability: string) => { if (capability === "diary.expression.write" && !writesAllowed) throw new Error("需要有效PRO，已有表达仍可查看"); }, subscribe: () => { subscribed++; return () => { released++; }; } } }, enabled: () => true,
    openDiary: async (path: string) => { openedDiary = path; }, openFile: async (path: string) => { openedFile = path; }, openToday: async () => { openedToday++; } };
  let today = { path: "Journal/today.md", hasContent: false, hasResult: false };
  const plugin: any = { app, settings: { settingsLanguage: "zh-CN", englishDiary: { enabled: true, expressionDirectory: "Expressions", legacyExpressionDirectories: ["Legacy expressions"] }, agentRegistry: { agents: [{ id: GENERAL_ASSISTANT_ID, name: "总助" }, { id: "english-owner", name: "英语教练" }], moduleOwners: { "english-diary": "english-owner" } } }, englishDiary: host,
    activateHomeView: async () => { home++; }, openAgentTaskList: async (id: string, text: string) => { taskPrefills.push([id, text]); return true; },
    prepareEnglishDiaryNavigationToday: async () => today, prefillEnglishDiaryTask: async (path: string) => { todayPrefill = path; return true; } };
  (globalThis as any).__p9Confirm = async () => { confirms++; return confirmResult; };
  const view: any = new EnglishDiaryPageView({} as any, plugin);
  Object.assign(view, { app, contentEl: root, containerEl: root, register() {} });
  await view.onOpen();
  assert.equal(view.getViewType(), ENGLISH_DIARY_PAGE_VIEW_TYPE);
  assert.equal(root.querySelectorAll(".english-page-metric").length, 3);
  assert.equal(root.querySelectorAll(".english-page-diary-row").length, 20);
  assert.equal(root.querySelectorAll(".echoink-activity-heatmap").length, 1);
  assert.equal(root.querySelectorAll(".is-primary").length, 1, "Only the header review action is primary");
  assert.equal(taskPrefills.length, 0); assert.equal(todayPrefill, ""); assert.equal(openedToday, 0, "Opening navigation must not create today's source");
  assert.equal(readOnlyReads, 2, "Overview reading uses repository read-only APIs");
  (root.querySelector(".english-page-diary-row") as HTMLButtonElement).click(); await tick(); assert.equal(openedDiary, "Journal/day-0.md");
  (root.querySelectorAll(".english-page-diary-row")[1] as HTMLButtonElement).click(); await tick(); assert.equal(openedFile, "English/day-1.md", "Missing source opens saved English without rebuilding the source");
  (root.querySelector(".english-page-pagination nav button:last-child") as HTMLButtonElement).click();
  assert.equal(root.querySelectorAll(".english-page-diary-row").length, 5);
  const diaryList = root.querySelector(".english-page-diary-list") as HTMLElement; diaryList.scrollTop = 79;
  view.openPage("expressions");
  assert.equal(root.querySelectorAll(".echoink-expression-list-item").length, 20);
  assert.equal(root.querySelectorAll(".echoink-diary-progress").length, 0, "Embedded library does not duplicate page statistics");
  view.openPage("diary"); assert.equal(view.diaryPage, 2); assert.equal(diaryList.scrollTop, 79);
  const range = root.querySelector(".activity-range-trigger") as HTMLButtonElement; range.click();
  const draft = root.querySelector(".activity-range-start") as HTMLInputElement; draft.value = "2020"; draft.focus();
  view.openPage("expressions"); await view.refresh();
  assert.equal(root.querySelector(".activity-range-start"), draft); assert.equal(draft.value, "2020", "Tab switch and refresh preserve unapplied activity range");
  const search = root.querySelector(".echoink-expression-search") as HTMLInputElement;
  search.value = "Term 2"; search.dispatchEvent(new win.Event("input"));
  assert.equal(root.querySelectorAll(".echoink-expression-list-item").length, 10, "Search filters the full dataset before pagination");
  const work = Array.from(root.querySelectorAll<HTMLElement>("[data-expression-category]")).find(button => button.dataset.expressionCategory === "Work")!;
  work.click(); await tick(); assert.equal(root.querySelectorAll(".echoink-expression-list-item").length, 5);
  view.openPage("diary"); view.openPage("expressions"); assert.equal((root.querySelector(".echoink-expression-search") as HTMLInputElement).value, "Term 2");
  const selected = root.querySelector(".echoink-expression-list-item") as HTMLButtonElement; const selectedId = selected.dataset.expressionId!; selected.click(); await tick();
  assert.ok(root.querySelector(".echoink-expression-english-quote")!.textContent!.includes("saved English"));
  const edit = findButton(root, "分类与备注"); edit.click(); await tick();
  assert.equal(root.querySelectorAll(".is-primary,.mod-cta").length, 1, "Editing metadata keeps the header as the only accent action");
  const note = root.querySelector('[data-expression-field="note"]') as HTMLTextAreaElement;
  note.value = "未保存的备注"; note.dispatchEvent(new win.Event("input"));
  view.openPage("diary"); await view.refresh(); view.openPage("expressions");
  assert.equal((root.querySelector('[data-expression-field="note"]') as HTMLTextAreaElement).value, "未保存的备注", "Unsent expression draft survives refresh and another tab");
  confirmResult = false; findButton(root, "返回表达库").click(); await tick(); assert.equal(view.expressions.getState().expressionId, selectedId); assert.equal(confirms, 1);
  const save = findButton(root, "保存分类与备注"); save.click(); await tick(); await tick(); assert.equal(saved, 1); assert.equal(entries.find(entry => entry.id === selectedId)!.note, "未保存的备注");
  findButton(root, "返回表达库").click(); await tick();
  assert.equal((root.querySelector(".echoink-expression-search") as HTMLInputElement).value, "Term 2");
  assert.equal(root.querySelectorAll(".echoink-expression-list-item").length, 5, "Returning keeps both search and classification");
  findButton(root, "清除筛选").click(); await tick();
  (root.querySelector(".echoink-expression-pagination nav button:nth-child(2)") as HTMLButtonElement).click();
  const expressionList = root.querySelector(".echoink-expression-list") as HTMLElement; expressionList.scrollTop = 91;
  (root.querySelector(".echoink-expression-list-item") as HTMLButtonElement).click(); await tick(); findButton(root, "返回表达库").click(); await tick();
  assert.equal(view.expressions.getState().page, 2); assert.equal((root.querySelector(".echoink-expression-list") as HTMLElement).scrollTop, 91, "Detail return restores list page and scrolling");
  assert.equal(root.querySelectorAll(".echoink-expression-list-item").length, 20);
  plugin.settings.agentRegistry.moduleOwners["english-diary"] = "deleted-owner";
  await view.reviewExpressions(); assert.equal(taskPrefills[0][0], GENERAL_ASSISTANT_ID); assert.ok(taskPrefills[0][1].includes("Expressions")); assert.ok(taskPrefills[0][1].includes("Legacy expressions")); assert.equal(taskPrefills[0][1].includes("Journal/"), false);
  view.openPage("diary"); await view.prepareToday(); assert.ok(view.field("status").textContent.includes("今天的原稿还没写好")); assert.equal(openedToday, 0);
  findButton(view.field("status"), "先写今天的原稿").click(); await tick(); assert.equal(openedToday, 1);
  today = { ...today, hasContent: true }; await view.prepareToday(); assert.equal(todayPrefill, "Journal/today.md");
  todayPrefill = ""; today = { ...today, hasResult: true }; await view.prepareToday(); assert.equal(todayPrefill, ""); assert.ok(view.field("status").textContent.includes("今天已有英文日记"));
  // Local reads remain possible after PRO expires; only editing is disabled.
  writesAllowed = false; view.openPage("expressions", selectedId); await tick();
  assert.equal(findButton(root, "分类与备注").disabled, true);
  plugin.settings.englishDiary.enabled = false; await view.refresh(); assert.ok(view.field("status").textContent.includes("已停用"));
  view.openPage("diary"); (root.querySelector(".english-page-diary-row") as HTMLButtonElement).click(); await tick(); assert.equal(openedFile, "English/day-20.md");
  plugin.settings.englishDiary.enabled = true;
  expressionsFail = diariesFail = activityFail = true; await view.refresh();
  assert.equal(root.querySelectorAll(".english-page-metric-number strong")[1].textContent, "—");
  assert.equal(root.querySelectorAll(".english-page-diary-row").length, 5, "Failed reads retain old rows with a visible stale notice");
  assert.ok(root.textContent!.includes("尚未完整更新"));
  expressionsFail = diariesFail = activityFail = false; diaries = diaries.slice(0, 1); entries = []; await view.refresh();
  assert.equal(view.diaryPage, 1, "Shrinking result sets clamp page state"); assert.equal(root.querySelectorAll(".english-page-diary-row").length, 1);
  assert.equal((view.field("owner") as HTMLButtonElement).disabled, true);
  assert.equal(root.querySelectorAll(".english-page-metric-number strong")[1].textContent, "0");
  let resolveLate!: (value: unknown) => void;
  const originalDiaries = repository.listSavedDiaries;
  repository.listSavedDiaries = () => new Promise(resolve => { resolveLate = resolve; });
  const late = view.refresh(); await tick();
  repository.listSavedDiaries = async () => ({ entries: [diary(19)], errors: [] });
  await view.refresh(); resolveLate({ entries: [diary(0)], errors: [] }); await late;
  assert.equal(root.querySelector<HTMLElement>(".english-page-diary-row")!.dataset.diaryId, "diary-19", "An old refresh cannot overwrite a newer snapshot");
  repository.listSavedDiaries = originalDiaries; await view.refresh();
  const beforeEvents = reads;
  listeners.get("modify")?.({ path: "Unrelated/note.md" }); await tick(); assert.equal(reads, beforeEvents);
  listeners.get("modify")?.({ path: "Journal/day-0.md" }); listeners.get("rename")?.({ path: "Journal" }); listeners.get("modify")?.({ path: "Expressions/term-0.md" }); await tick();
  assert.equal(reads, beforeEvents + 1, "Related changes coalesce, including ancestor-folder rename");
  // Leave with a range editor open: its keyboard Scope is released, its draft is kept.
  assert.equal(scopesPushed, 1);
  const beforeHidden = reads;
  Object.defineProperty(win.document, "hidden", { configurable: true, value: true }); win.document.dispatchEvent(new win.Event("visibilitychange"));
  assert.equal(scopesPopped, 1); assert.equal(released, subscribed);
  await view.refresh(); assert.equal(reads, beforeHidden, "Hidden navigation does not scan the repository");
  Object.defineProperty(win.document, "hidden", { configurable: true, value: false }); win.document.dispatchEvent(new win.Event("visibilitychange")); await tick();
  assert.ok(reads > beforeHidden); assert.equal(root.querySelector(".activity-range-start"), draft); assert.equal(draft.value, "2020");
  await view.onClose(); assert.equal(released, subscribed); assert.equal(scopesPopped, scopesPushed);
  // Closing and reopening the controller preserves a dirty draft without a fake native leaf.
  const other = win.document.body.createDiv(); const browser: any = new EnglishExpressionBrowser(app, other, host, { embedded: true, managed: true });
  writesAllowed = true; browser.mount(); browser.setEntries([expression(0)]); await browser.openExpression("expression-0");
  findButton(other, "分类与备注").click(); await tick(); const retainedNote = other.querySelector('[data-expression-field="note"]') as HTMLTextAreaElement; retainedNote.value = "会话草稿"; retainedNote.dispatchEvent(new win.Event("input")); browser.close();
  const reopened: any = new EnglishExpressionBrowser(app, other, host, { embedded: true, managed: true }); reopened.mount(); reopened.setEntries([expression(0)]);
  assert.equal((other.querySelector('[data-expression-field="note"]') as HTMLTextAreaElement).value, "会话草稿"); reopened.close();
  assert.equal(home, 0); dom.window.close();
  console.log("English diary navigation UI passed: real page/browser/heatmap, 20-row pagination, full-set search, edit/save/draft/return, read-only failure/retry, scoped prefills, source fallback and foreground cleanup.");
}
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));
function findButton(root: ParentNode, text: string): HTMLButtonElement {
  const result = Array.from(root.querySelectorAll<HTMLButtonElement>("button")).find(button => button.textContent === text);
  assert.ok(result, `Button not found: ${text}`); return result;
}
