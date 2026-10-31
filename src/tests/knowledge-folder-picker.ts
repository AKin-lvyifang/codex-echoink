import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { parse } from "postcss";
import { createKnowledgeFolderPicker, type KnowledgeFolderChoice, type KnowledgeFolderPickerOptions } from "../settings/knowledge-folder-picker";
import { createOriginSelectHostFixture } from "./origin-obsidian-dom-shim";
import { initializationFolderIssues } from "../knowledge-base/initialization-choices";

function installWindow(value: unknown): void {
  const win = value as Window & typeof globalThis;
  Object.assign(win.HTMLElement.prototype, {
    createDiv(this: HTMLElement, options: { cls?: string } = {}) {
      const element = this.ownerDocument.createElement("div");
      element.className = options.cls ?? ""; this.append(element); return element;
    },
    scrollIntoView() {}
  });
}

export async function runKnowledgeFolderPickerTests(value: unknown, pickerCss: string): Promise<void> {
  const existingSymbolPath = "PDF/中文 空格|分隔 (draft)";
  assert.equal(initializationFolderIssues([{ key: "raw", title: "资料来源", values: [{ path: existingSymbolPath, create: false }] }], [existingSymbolPath]).size, 0, "existing host folders remain selectable even if their names are not valid for creating a new cross-platform folder");
  assert.equal(initializationFolderIssues([{ key: "raw", title: "资料来源", values: [{ path: existingSymbolPath, create: true }] }], []).size, 1, "new folder names still reject illegal characters");

  const win = value as Window & typeof globalThis;
  installWindow(win);
  const fixture = createOriginSelectHostFixture(win);
  const host = win.document.createElement("div"); host.className = "echoink-settings-demo"; win.document.body.append(host);
  const outside = win.document.createElement("button"); outside.textContent = "outside"; win.document.body.append(outside);
  const changes: KnowledgeFolderChoice[][] = [];
  const editing: boolean[] = [];
  const css = parse(pickerCss);
  const declarations = (selector: string, container?: string) => {
    const result: Record<string, string> = {};
    css.walkRules(selector, rule => {
      const scope = rule.parent;
      if (container ? scope?.type !== "atrule" || scope.params !== container : scope?.type !== "root") return;
      rule.walkDecls(declaration => { result[declaration.prop] = declaration.value; });
    });
    return result;
  };
  assert.equal(declarations(".echoink-folder-picker").width, "230px");
  assert.equal(declarations(".echoink-folder-picker").flex, "0 0 230px", "single and multiple share one fixed control column");
  assert.equal(declarations(".echoink-folder-picker", "settings (max-width: 760px)").width, "200px");
  assert.equal(declarations(".echoink-folder-picker", "settings (max-width: 600px)").width, "100%");
  assert.equal(declarations(".echoink-folder-picker-values")["justify-content"], "flex-start");
  assert.equal(declarations(".echoink-folder-picker-values.is-multiple .echoink-folder-picker-controls").width, "100%", "Add remains the same width as single selects");
  assert.deepEqual(Object.fromEntries(["overflow", "text-overflow", "white-space"].map(key => [key, declarations(".echoink-folder-picker-tag-path")[key]])), { overflow: "hidden", "text-overflow": "ellipsis", "white-space": "nowrap" });
  const fieldIssues = (path: string, create: boolean) => initializationFolderIssues([{ key: "test", title: "文件夹", values: [{ path, create }] }], ["notes", "notes/raw"]);
  assert.deepEqual(fieldIssues("deleted", false).get("test"), ["文件夹不存在"]);
  assert.equal(fieldIssues("notes/new", true).size, 0, "valid new child paths remain accepted");
  assert.match(fieldIssues("notes/raw", true).get("test")?.[0] ?? "", /重名/u);
  let folderReads = 0;
  const paths = ["raw", "wiki", "待新建同名", ...Array.from({ length: 450 }, (_, index) => `资料/Folder-${String(index).padStart(3, "0")}`)];
  const tick = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); await new Promise(resolve => setTimeout(resolve, 0)); };
  const create = (extra: Partial<KnowledgeFolderPickerOptions> = {}) => createKnowledgeFolderPicker(host, {
    label: "文件夹", folders: () => { folderReads++; return paths; }, values: [{ path: "raw", create: false }], multiple: false,
    app: fixture.app, onChange: values => changes.push(values), onEditingChange: value => editing.push(value), ...extra
  });
  const trigger = (root: ParentNode = host) => root.querySelector<HTMLButtonElement>('[data-slot="select-trigger"]')!;
  const draft = (root: ParentNode = host) => root.querySelector<HTMLInputElement>("input[data-folder-draft]")!;
  const popup = (owner: Document = win.document) => owner.querySelector<HTMLElement>(".echoink-folder-picker-popover")!;
  const menuOption = (text: string, owner: Document = win.document) => [...popup(owner).querySelectorAll<HTMLElement>("[data-folder-option]")].find(item => item.textContent === text)!;
  const type = (input: HTMLInputElement, text: string) => { input.value = text; input.dispatchEvent(new input.ownerDocument.defaultView!.Event("input", { bubbles: true })); };
  const key = (element: HTMLElement, key: string, composing = false) => element.dispatchEvent(new element.ownerDocument.defaultView!.KeyboardEvent("keydown", { key, isComposing: composing, bubbles: true, cancelable: true }));
  const begin = async (root: ParentNode = host) => { trigger(root).click(); await tick(); menuOption("新建文件夹…", trigger(root).ownerDocument).click(); await tick(); return draft(root); };
  let picker = create({ values: [{ path: "默认/待新建", create: true }] });
  try {
    assert.equal(host.querySelectorAll('[data-slot="select-trigger"]').length, 1);
    assert.equal(host.querySelectorAll("input").length, 0, "confirmed new defaults remain selects");
    assert.equal(host.querySelectorAll("button").length, 1, "single selections have no X action");
    assert(trigger().textContent?.includes("默认/待新建"));
    assert.equal(host.querySelector(".echoink-folder-picker-new")?.textContent, "新建");
    await tick(); assert.equal(changes.length, 0);

    trigger().click(); await tick();
    assert.equal(fixture.depth, 1);
    assert(menuOption("不设置"));
    const readsBeforeSearch = folderReads;
    const search = popup().querySelector<HTMLInputElement>('input[type="search"]')!;
    type(search, "folder-449"); await tick();
    assert(menuOption("资料/Folder-449"), "search is case insensitive and includes the entire Vault folder set");
    assert.equal(folderReads, readsBeforeSearch, "typing reuses the opening's folder snapshot");
    key(search, "ArrowDown"); key(win.document.activeElement as HTMLElement, "End");
    assert.equal(win.document.activeElement?.textContent, "新建文件夹…");
    key(win.document.activeElement as HTMLElement, "Escape"); await tick();
    assert.equal(popup(), null); assert.equal(fixture.depth, 0); assert.equal(fixture.escapes, 0);
    assert.equal(win.document.activeElement, trigger());

    let field = await begin();
    assert(field); assert.equal(win.document.activeElement, field, "closing the menu must not steal focus from the new input");
    assert.equal(field.placeholder, "新文件夹名称");
    assert.deepEqual(editing, [true]);
    type(field, "本地/草稿"); await tick();
    assert.equal(changes.length, 0, "opening and typing cannot update preview or create values");
    key(field, "Escape"); field.dispatchEvent(new win.FocusEvent("focusout", { bubbles: true })); await tick();
    assert.equal(changes.length, 0); assert(trigger().textContent?.includes("默认/待新建")); assert.equal(fixture.depth, 0);
    assert.deepEqual(editing, [true, false], "Escape ends editing without changing the confirmed value");

    field = await begin(); type(field, "  新目录/已确认  "); key(field, "Enter");
    field.dispatchEvent(new win.FocusEvent("focusout", { bubbles: true })); await tick();
    assert.deepEqual(changes, [[{ path: "新目录/已确认", create: true }]], "Enter and following blur commit once");
    assert.equal(host.querySelectorAll("input").length, 0); assert.equal(host.querySelectorAll("button").length, 1);
    assert(trigger().textContent?.includes("新目录/已确认"));
    assert.deepEqual(editing, [true, false, true, false], "Enter and following blur end editing once");

    field = await begin(); type(field, "失焦/确认"); outside.focus(); await tick();
    assert.deepEqual(changes.at(-1), [{ path: "失焦/确认", create: true }]);
    assert.equal(changes.length, 2);
    field = await begin(); type(field, "  "); outside.focus(); await tick();
    assert.equal(changes.length, 2); assert.equal(draft(), field, "blank blur keeps the input available for correction");
    assert.equal(host.querySelector('[role="alert"]')?.textContent, "请输入新文件夹名称");
    assert.equal(editing.at(-1), true, "invalid blur cannot release the containing form's submit guard");
    field.focus(); type(field, "notes/raw"); key(field, "Enter"); await tick();
    assert.deepEqual(changes.at(-1), [{ path: "notes/raw", create: true }], "a valid child path can be confirmed after accidental blur");
    assert.equal(editing.at(-1), false);

    field = await begin();
    for (const path of ["wiki", "WIKI", "bad?name", "notes/../raw", "notes//raw", "notes/", "notes\\raw", "notes/raw:bad"]) {
      type(field, path); key(field, "Enter"); await tick();
      assert.equal(draft(), field); assert.equal(field.getAttribute("aria-invalid"), "true");
      assert(host.querySelector('[role="alert"]'), `${path} should fail in place`);
      assert.equal(editing.at(-1), true);
      assert.deepEqual(changes.at(-1), [{ path: "notes/raw", create: true }], "invalid drafts never replace the confirmed selection");
    }
    picker.setError(); assert(host.querySelector('[role="alert"]'), "parent validation cannot erase a draft's local error");
    key(field, "Escape"); await tick();
    picker.setError("文件夹不存在");
    assert.equal(trigger().getAttribute("aria-invalid"), "true");
    trigger().click(); await tick(); menuOption("raw").click(); await tick();
    assert.deepEqual(changes.at(-1), [{ path: "raw", create: false }]);
    trigger().click(); await tick(); menuOption("不设置").click(); await tick();
    assert.deepEqual(changes.at(-1), []); assert.equal(trigger().textContent, "不设置"); assert.equal(host.querySelectorAll("input").length, 0);
    picker.dispose(); changes.length = 0;

    picker = create({ required: true }); trigger().click(); await tick();
    assert(!menuOption("不设置"), "required selectors do not expose the empty choice");
    key(popup().querySelector("input")!, "Escape"); await tick(); picker.dispose();

    picker = create({ multiple: true, values: [{ path: "raw", create: false }, { path: "待新建同名", create: true }] });
    assert.equal(host.querySelectorAll(".echoink-folder-picker-tag").length, 2);
    assert.equal(host.querySelectorAll(".echoink-folder-picker-new").length, 1);
    assert.equal(host.querySelectorAll("input").length, 0); assert.equal(trigger().textContent, "添加");
    assert.equal(host.querySelector<HTMLElement>(".echoink-folder-picker-tag")?.dataset.testTooltip, "raw", "full tag paths use Obsidian setTooltip");
    assert.equal(host.querySelectorAll('[data-test-icon="x"]').length, 2, "tag removal uses the host Lucide icon");
    trigger().click(); await tick();
    assert(!menuOption("raw") && !menuOption("待新建同名"), "both existing and confirmed-new selections are excluded");
    menuOption("wiki").click(); await tick();
    assert.deepEqual(changes.at(-1), [{ path: "raw", create: false }, { path: "待新建同名", create: true }, { path: "wiki", create: false }]);
    const count = changes.length;
    field = await begin(); type(field, "raw"); key(field, "Enter"); await tick();
    assert.equal(changes.length, count, "retyping an already selected name cannot append a duplicate tag");
    assert.equal(draft(), field); key(field, "Escape"); await tick();
    field = await begin(); type(field, "新增来源");
    assert.equal(changes.length, count); key(field, "Escape"); await tick();
    assert.equal(host.querySelectorAll(".echoink-folder-picker-tag").length, 3);
    field = await begin(); type(field, "新增来源"); outside.focus(); await tick();
    assert.equal(host.querySelectorAll(".echoink-folder-picker-tag").length, 4);
    assert.deepEqual(changes.at(-1)?.at(-1), { path: "新增来源", create: true });
    const beforeDisabled = changes.length;
    picker.setDisabled(true); trigger().click(); host.querySelector<HTMLButtonElement>(".echoink-folder-picker-remove")!.click(); await tick();
    assert.equal(popup(), null); assert.equal(changes.length, beforeDisabled);
    picker.setDisabled(false); host.querySelector<HTMLButtonElement>('.echoink-folder-picker-remove[aria-label="移除raw"]')!.click();
    assert.equal(host.querySelectorAll(".echoink-folder-picker-tag").length, 3); assert(!changes.at(-1)?.some(item => item.path === "raw"));
    picker.dispose(); changes.length = 0;

    picker = create({ values: [{ path: "deleted", create: false }] }); await tick();
    assert.equal(changes.length, 0, "missing existing bindings are never silently converted into create requests");
    assert.equal(host.querySelector(".echoink-folder-picker-new"), null);
    trigger().click(); await tick();
    const index = paths.indexOf("wiki"); paths.splice(index, 1);
    menuOption("wiki").click(); await tick();
    assert.equal(host.querySelector('[role="alert"]')?.textContent, "文件夹不存在");
    assert.equal(changes.length, 0, "an option deleted after opening cannot be confirmed");
    paths.splice(index, 0, "wiki"); picker.dispose();

    picker = create(); field = await begin(); type(field, "中文输入");
    field.dispatchEvent(new win.CompositionEvent("compositionstart", { bubbles: true }));
    key(field, "Enter"); key(field, "Escape"); await tick();
    assert.equal(draft(), field); assert.equal(changes.length, 0); assert.equal(fixture.depth, 1);
    field.dispatchEvent(new win.CompositionEvent("compositionend", { bubbles: true })); key(field, "Enter");
    assert.equal(changes.length, 0, "the composition-ending Enter cannot submit"); await tick();
    key(field, "Enter"); await tick(); assert.deepEqual(changes, [[{ path: "中文输入", create: true }]]);
    field = await begin(); type(field, "被禁用的草稿"); picker.setDisabled(true); await tick();
    assert.equal(fixture.depth, 0); assert.equal(host.querySelectorAll("input").length, 0); assert.equal(changes.length, 1);
    assert.equal(editing.at(-1), false);
    picker.setDisabled(false); picker.setValues([{ path: "外部/已确认", create: true }]);
    assert(trigger().textContent?.includes("外部/已确认")); assert.equal(host.querySelectorAll("input").length, 0);
    field = await begin(); type(field, "销毁草稿"); picker.dispose(); picker.dispose();
    assert.equal(fixture.depth, 0); assert.equal(popup(), null); assert.equal(changes.length, 1);
    assert.equal(editing.at(-1), false);
    key(outside, "Escape"); assert.equal(fixture.escapes, 1, "disposing restores the parent's Escape scope");

    const detached = new JSDOM("<!doctype html><html><body><div class='echoink-settings-demo'></div></body></html>", { pretendToBeVisual: true });
    installWindow(detached.window);
    const other = createOriginSelectHostFixture(detached.window as unknown as Window);
    const otherHost = detached.window.document.querySelector<HTMLElement>("div")!;
    const otherPicker = createKnowledgeFolderPicker(otherHost, { label: "独立窗口", values: [], multiple: false, folders: () => paths, app: other.app, onChange() {} });
    try {
      trigger(otherHost).click(); await tick();
      assert(popup(detached.window.document)); assert.equal(popup(), null, "portals remain in their owning document");
      key(popup(detached.window.document).querySelector("input")!, "Escape"); await tick();
      assert.equal(other.depth, 0); assert.equal(other.escapes, 0); assert.equal(detached.window.document.activeElement, trigger(otherHost));
      const otherField = await begin(otherHost); assert.equal(detached.window.document.activeElement, otherField);
      detached.window.dispatchEvent(new detached.window.Event("pagehide")); await tick();
      assert.equal(other.depth, 0); assert.equal(otherHost.children.length, 0);
    } finally { otherPicker.dispose(); other.dispose(); detached.window.close(); }
    console.log("PASS folder picker: confirmed defaults, optional/required, search, local drafts, Enter/blur/Escape, additive tags, disabled/error, IME, owning-window scope and lifecycle");
  } finally { picker.dispose(); fixture.dispose(); host.remove(); outside.remove(); }
}
