import { installObsidianDom } from "./obsidian-dom";
import { runGalleryMarkupTests } from "./gallery-markup";
import { galleryNativeMarkup } from "./fixtures/gallery-native-markup";
import assert from "node:assert/strict";
import { EditorState } from "@codemirror/state";
import { history, undo, redo } from "@codemirror/commands";
import { JSDOM } from "jsdom";
import { EditorView } from "@codemirror/view";
import { Menu, Notice, editorInfoField, editorLivePreviewField } from "obsidian";
import { applyGalleryEdit, GalleryController, gallerySelection, toggleGalleryImage } from "../gallery/controller";
import { changeGalleryLayout, galleryAt, galleryBlocks, galleryOptions, groupImages, imagesInSelection, insertGallery, parseImageLine, splitGallery, standaloneImages, type GalleryEdit } from "../gallery/model";
import { validateGalleryMarkup } from "../gallery/markup";
import { readCompanionTheme } from "../ui/appearance-theme";
const edit = (source: string, change: GalleryEdit) => source.slice(0, change.from) + change.insert + source.slice(change.to);
const original = '![[山.png|300]]\n\n![花](<assets/flower (1).png> "花的标题")\n![[山.png|另一个别名]]';
const images = standaloneImages(original);
assert.equal(images.length, 3);
assert.ok(edit("![[a.png]]\n![[b.png]]\n正文", groupImages("![[a.png]]\n![[b.png]]\n正文", standaloneImages("![[a.png]]\n![[b.png]]\n正文"))).includes("\n\n正文"));
const grouped = edit(original, groupImages(original, [images[2], images[0], images[1]]));
assert.equal(grouped, `> [!gallery]\n> ${images.map(image => image.raw).join("\n> ")}`);
assert.equal(galleryBlocks(grouped)[0].images.length, 3);
for (const body of ['![[a.png]]\n> ![[b.png]]', '![[a.png]] ![[b.png]]', '![[a.png]]![[b.png]]', '![[a.png]]\n>\n> ![[b.png]]']) {
  const block = galleryBlocks('> [!gallery]\n> ' + body)[0];
  assert.equal(block.valid, true); assert.equal(block.images.length, 2);
}
assert.deepEqual(galleryOptions('300|row'), {row:true,height:300});
assert.deepEqual(galleryOptions('row|900'), {row:true,height:800});
assert.deepEqual(galleryOptions('0'), {row:false,height:120});
for (const meta of ['300|row','row|300']) {
  const sized = grouped.replace('[!gallery]', `[!gallery|${meta}]`);
  assert.equal(galleryBlocks(sized)[0].height,300);
  const mosaic = edit(sized, changeGalleryLayout(sized,0,false));
  assert.equal(galleryBlocks(mosaic)[0].height,300); assert.equal(galleryBlocks(mosaic)[0].row,false);
  assert.ok(edit(mosaic,splitGallery(mosaic,0)).includes('山.png|300'));
}
const row = edit(grouped, changeGalleryLayout(grouped, 0, true));
assert.equal(row, grouped.replace("[!gallery]", "[!gallery|row]"));
assert.equal(edit(row, changeGalleryLayout(row, 0, false)), grouped);
assert.deepEqual(standaloneImages(edit(row, splitGallery(row, 0))).map(image => image.raw), images.map(image => image.raw));
assert.equal(galleryAt('```md\n'+grouped+'\n```', 8), undefined);
assert.equal(galleryBlocks('---\n'+grouped+'\n---').length, 0);
for (const text of ['![[note.md]]', '![[report.pdf]]', '<img src="a.png">', 'text ![[a.png]]', '- ![[a.png]]', '    ![[a.png]]']) assert.equal(parseImageLine(text), null);
for (const source of ['```\n![[a.png]]\n```', '~~~md\n![[a.png]]\n~~~', '---\na: x\n![[a.png]]\n---', '> quote\n![[a.png]]', '- list\n![[a.png]]', '<div>\n![[a.png]]\n</div>', '<!--\n![[a.png]]\n-->']) assert.equal(standaloneImages(source).length, 0);
assert.equal(standaloneImages('<pre>\n\n![[a.png]]\n![[b.png]]\n</pre>').length, 0);
assert.equal(galleryBlocks('~~~\n~~~md\n> [!gallery]\n> ![[a.png]]\n~~~').length, 0);
const distant = '![[a.png]]\n正文不能移动\n![[b.png]]';
assert.throws(() => groupImages(distant, standaloneImages(distant)), /之间有其他内容/u);
const four = '![[a.png]]\n![[b.png]]\n![[c.png]]\n![[d.png]]';
assert.throws(() => groupImages(four, standaloneImages(four)), /最多 3/u);
assert.throws(() => groupImages(four, [standaloneImages(four)[0], standaloneImages(four)[2]]), /其他内容/u);
assert.throws(() => groupImages(original.replace('山.png', '海.png'), images), /已变化/u);
assert.equal(standaloneImages('![[a.png]] ![[b.png]]').length, 2);
for (const source of ['> [!gallery]\n> 正文\n> ![[a.png]]', '> [!gallery]-\n> ![[a.png]] ![[b.png]] ![[c.png]] ![[d.png]]']) {
  const split = edit(source, splitGallery(source, 0)); assert.ok(split.includes('![[a.png]]')); assert.ok(!split.includes('[!gallery]'));
}
const empty = edit('', insertGallery('', 0)); assert.ok(empty.startsWith('> [!gallery]\n> '));
assert.ok(edit('前后', insertGallery('前后', 1)).includes('前\n\n> [!gallery]\n> \n\n后'));
assert.throws(() => insertGallery('```\nsource\n```', 5), /普通正文/u);
// Real CM history, not a simulated stack: exactly one undo for each operation.
let state = EditorState.create({ doc: original, extensions: [history(), gallerySelection] });
const view = { get state() { return state; }, dispatch(spec: any) { state = state.update(spec).state; }, focus() {} };
state = state.update({ effects: toggleGalleryImage.of(images[0]) }).state;
state = state.update({ changes: { from: 0, insert: '前言\n\n' } }).state;
assert.equal(state.field(gallerySelection)[0].from, 4);
state = state.update({ changes: { from: 7, to: 8, insert: '新' } }).state;
assert.equal(state.field(gallerySelection).length, 0);
state = EditorState.create({ doc: original, extensions: [history(), gallerySelection] });
for (const action of [() => groupImages(state.doc.toString(), standaloneImages(state.doc.toString())), () => changeGalleryLayout(state.doc.toString(), 0, true), () => splitGallery(state.doc.toString(), 0)]) {
  const before = state.doc.toString(); applyGalleryEdit(view as any, before, action()); const after = state.doc.toString();
  assert.ok(undo(view as any)); assert.equal(state.doc.toString(), before); assert.ok(redo(view as any)); assert.equal(state.doc.toString(), after);
}
assert.throws(() => applyGalleryEdit(view as any, 'stale document', { from: 0, to: 0, insert: 'bad' }), /已变化/u);
const fourState = EditorState.create({ doc: four, extensions: [gallerySelection] });
const capped = fourState.update({ effects: standaloneImages(four).map(image => toggleGalleryImage.of(image)) }).state;
assert.equal(capped.field(gallerySelection).length, 3);
const dom = new JSDOM('<html><body></body></html>'); const doc = dom.window.document;
installObsidianDom(dom.window);
assert.deepEqual(readCompanionTheme(doc), { active: false, gallery: false });
doc.documentElement.style.setProperty('--echoink-companion-theme', '1'); assert.equal(readCompanionTheme(doc).gallery, false);
doc.documentElement.style.setProperty('--echoink-gallery', '1'); assert.equal(readCompanionTheme(doc).gallery, true);
doc.documentElement.style.removeProperty('--echoink-gallery'); assert.equal(readCompanionTheme(doc).gallery, false);
// Public menu labels, source snapshots, and no implicit selection expansion.
const controller = new GalleryController({} as any);
for (const count of [1, 2, 3]) {
  const menu = new Menu(); const current = { view: { state: EditorState.create({ doc: original }) }, selected: () => images.slice(0, count) };
  controller.selectionMenu(menu, current as any);
  const items = (menu as any).items; assert.equal(items.length, count === 3 ? 2 : 1); assert.equal(!!items[0].disabled, count === 1);
}
for (const source of [grouped, row]) {
  const menu = new Menu(), current = { view: { state: EditorState.create({ doc: source }) } };
  controller.groupMenu(menu, current as any, 0); assert.equal((menu as any).items.length, 2);
  const saved = current.view.state; current.view.state = EditorState.create({ doc: 'changed\n'+source }); (menu as any).items[0].run();
  assert.equal((Notice as any).messages.at(-1), '图片内容已变化，请重新选择'); current.view.state = saved;
}
const buffered = doc.createElement('div'); buffered.innerHTML = galleryNativeMarkup({ count: 2, buffers: true });
validateGalleryMarkup(buffered);
assert.equal(buffered.querySelector('.callout')!.getAttribute('data-ei-gallery-count'), '2', 'Native cursor buffers must not count as photos');
const groupRoot = doc.createElement('div');
groupRoot.innerHTML = '<div class="callout" data-callout="gallery"><div class="callout-content"><p>不要隐藏正文<span class="image-embed"><img></span></p></div></div>';
validateGalleryMarkup(groupRoot); assert.ok(groupRoot.querySelector('[data-ei-gallery-invalid]'));
groupRoot.querySelector('p')!.firstChild!.textContent = ' '; validateGalleryMarkup(groupRoot); assert.ok(!groupRoot.querySelector('[data-ei-gallery-invalid]')); assert.equal(groupRoot.querySelector('.callout')!.getAttribute('data-ei-gallery-count'), '1');
const registered: any[] = []; const plugin = { settings: { settingsLanguage: 'zh-CN' }, app: { workspace: { containerEl: doc.body, on() {} } }, addCommand(command: any) { registered.push(command); }, registerEditorExtension() {}, registerMarkdownPostProcessor() {}, registerEvent() {}, register() {} };
new GalleryController(plugin as any).register(); assert.equal(registered.length, 3);
for (const command of registered) { command.editorCallback({}, {}); assert.equal((Notice as any).messages.at(-1), '需要配套主题 echoink-theme 才能拼排'); }
async function editorLifecycle() {
  const runtime = new JSDOM('<html><body><div class="markdown-source-view"></div></body></html>', { pretendToBeVisual: true });
  installObsidianDom(runtime.window);
  const win = runtime.window;
  Object.assign(globalThis, { window: win, document: win.document, MutationObserver: win.MutationObserver });
  const cleanups: (() => void)[] = [], events = new Map<string, () => void>(); let extension: any;
  const metadata = { file: { path: 'first.md', extension: 'md' }, editor: {} };
  const host = { settings: { settingsLanguage: 'zh-CN' }, app: { workspace: { containerEl: win.document.body, on(name: string, cb: () => void) { events.set(name, cb); }, iterateAllLeaves() {} } }, addCommand() {}, registerEditorExtension(ext: any) { extension = ext; }, registerMarkdownPostProcessor() {}, registerEvent() {}, register(cb: () => void) { cleanups.push(cb); } };
  win.document.documentElement.style.setProperty('--echoink-gallery', '1');
  new GalleryController(host as any).register();
  const native = new EditorView({ state: EditorState.create({ doc: original, extensions: [editorInfoField.init(() => metadata as any), editorLivePreviewField, extension] }), parent: win.document.querySelector('.markdown-source-view')! });
  native.dispatch({ effects: toggleGalleryImage.of(images[0]) }); assert.equal(native.state.field(gallerySelection).length, 1);
  native.dispatch({ changes: { from: 0, insert: '\n' } }); assert.equal(native.state.field(gallerySelection)[0].from, 1);
  events.get('layout-change')?.(); // JSDOM has no layout; hidden native source views clear selection.
  assert.equal(native.state.field(gallerySelection).length, 0);
  native.dispatch({ effects: toggleGalleryImage.of(standaloneImages(native.state.doc.toString())[0]) });
  win.document.documentElement.style.removeProperty('--echoink-gallery'); events.get('css-change')?.(); assert.equal(native.state.field(gallerySelection).length, 0);
  win.document.documentElement.style.setProperty('--echoink-gallery', '1'); native.dispatch({ effects: toggleGalleryImage.of(standaloneImages(native.state.doc.toString())[0]) });
  metadata.file.path = 'second.md'; native.dispatch({}); await Promise.resolve(); assert.equal(native.state.field(gallerySelection).length, 0);
  for (const cleanup of cleanups) cleanup(); assert.ok(!win.document.querySelector('.echoink-gallery-layer')); native.destroy(); win.close();
}
void runGalleryMarkupTests().then(() => editorLifecycle()).then(() => console.log('Gallery: PASS — grammar, continuity, raw preservation, real CM undo/redo, three-image cap, public menus, editor redraw/file-change/theme-off cleanup')).catch(error => { console.error(error); process.exitCode = 1; });
