import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { transform } from 'esbuild';
import { JSDOM } from 'jsdom';

// Run production classes with a small host port; native acceptance is separate.
const root = new URL('../', import.meta.url);
const dom = new JSDOM('<!doctype html><body></body>', { pretendToBeVisual: true });
const doc = dom.window.document;
const proto = dom.window.HTMLElement.prototype;
proto.setText = function (text) { this.textContent = text; };
proto.empty = function () { this.replaceChildren(); };
proto.removeClass = function (...names) { this.classList.remove(...names); };
const obsidian = {
  ItemView: class {}, Modal: class {}, WorkspaceLeaf: class {}, TFile: class {}, setIcon() {},
  sanitizeHTMLToDom(html) { const t = doc.createElement('template'); t.innerHTML = html; return t.content; }
};
async function production(relative, mocks = {}) {
  const source = await readFile(new URL(relative, root), 'utf8');
  const { code } = await transform(source, { loader: 'ts', format: 'cjs', target: 'es2022' });
  const module = { exports: {} };
  new Function('require', 'module', 'exports', code)(name => name === 'obsidian' ? obsidian : mocks[name] ?? {}, module, module.exports);
  return module.exports;
}
const visibility = { isHomeNotePath: () => true };
const { HomeSearchService } = await production('src/home/home-search.ts', { './home-note-visibility': visibility });
const i18n = await production('src/home/home-i18n.ts');
const dateKey = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const { EchoInkHomeView } = await production('src/home/home-view.ts', {
  './home-workbench-model': { dateKey }, './home-i18n': i18n, './home-note-visibility': visibility
});
const activityCore = await production('src/home/home-activity-core.ts');
const { HomeActivityService } = await production('src/home/home-activity-service.ts', { './home-activity-core': activityCore });
const { ForegroundView } = await production('src/ui/foreground-view.ts');
const filters = await production('src/english-diary/expression-search.ts');
const { EnglishExpressionView } = await production('src/english-diary/expression-view.ts', { './expression-search': filters });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
try {
  let files = Array.from({ length: 1000 }, (_, i) => ({ path: `notes/${i}.md`, basename: `note-${i}`, stat: { mtime: i + 1 } }));
  let body = 'a'.repeat(32768), reads = 0;
  const app = { vault: { getMarkdownFiles: () => files, cachedRead: async () => { reads++; return body; } }, metadataCache: { getFileCache: () => ({}) } };
  const search = new HomeSearchService(app, () => true);
  assert.equal((await search.search('absent', new AbortController().signal)).count, 0);
  const retained = [...search.contentCache.values()].reduce((sum, item) => sum + item.text.length, 0);
  assert.equal(retained, 983040);
  assert.equal(search.cache.size, 256);
  assert.equal(search.contentCache.size, 30);
  const newest = files.at(-1);
  files = [newest];
  const before = reads;
  await search.search('absent', new AbortController().signal);
  assert.equal(reads, before, 'unchanged retained text is reused');
  newest.stat.mtime++;
  body = 'large prefix '.repeat(30000) + 'oversized-needle';
  assert.equal((await search.search('oversized-needle', new AbortController().signal)).count, 1, 'oversize notes stay searchable');
  assert.equal(search.contentCache.size, 0, 'oversize note is not retained');
  body = 'fresh marker'; newest.stat.mtime++;
  assert.equal((await search.search('fresh marker', new AbortController().signal)).count, 1);
  const cache = search.contentCache;
  cache.clear();
  for (let i = 0; i < 64; i++) cache.set(String(i), { mtime: 1, text: 'small' });
  cache.get('0'); cache.set('64', { mtime: 1, text: 'small' });
  assert(cache.has('0') && !cache.has('1'), 'least recently used text is evicted');
  const searchView = Object.assign(Object.create(EchoInkHomeView.prototype), {
    searchService: search, searchOpen: true, searchTimer: null, searchAbort: new AbortController(), contentEl: doc.createElement('div')
  });
  searchView.contentEl.innerHTML = '<div data-home="header-search"></div><div class="page-heading"></div><div data-home="search-suggestions"></div><input data-home="search-input"><button class="search-trigger"></button><button class="search-close"></button>';
  let lateSearch = 0;
  searchView.searchTimer = dom.window.setTimeout(() => lateSearch++, 1);
  searchView.closeSearch(false);
  await sleep(5);
  assert.equal(lateSearch, 0);
  assert.equal(cache.size + search.cache.size, 0, 'closing releases both caches');
  let resolveRead;
  app.vault.cachedRead = () => new Promise(resolve => { resolveRead = resolve; });
  const abort = new AbortController();
  const flight = search.search('pending', abort.signal);
  abort.abort(); search.clear(); resolveRead('pending');
  await flight;
  assert.equal(cache.size + search.cache.size, 0, 'late aborted read cannot repopulate caches');

  const activity = new HomeActivityService('/not-used');
  for (let i = 0; i < 10000; i++) activity.events.set(String(i), { path: `notes/${i}.md`, kind: 'modified', at: i, date: `2026-03-${String(i % 31 + 1).padStart(2, '0')}` });
  let snapshots = 0;
  const snapshot = activity.snapshot.bind(activity);
  activity.snapshot = () => { snapshots++; return snapshot(); };
  const calendar = Object.assign(Object.create(EchoInkHomeView.prototype), {
    plugin: { settings: { settingsLanguage: 'zh-CN' }, homeActivity: activity }, month: new Date(2026, 2, 1), selectedDate: null,
    dataService: { existingJournalForDate: () => null }, contentEl: doc.createElement('div')
  });
  calendar.contentEl.innerHTML = '<div data-home="month-label"></div><div class="calendar-weekdays"></div><div data-home="calendar-days"></div><div data-home="month-record-count"></div><div data-home="journal-label"></div><div data-home="journal-hint"></div>';
  calendar.renderCalendar();
  assert.equal(snapshots, 1); assert.equal(calendar.contentEl.querySelectorAll('button').length, 42);
  assert.equal(calendar.field('month-record-count').textContent, '本月 31 天');
  assert.match(calendar.contentEl.querySelector('[data-date="2026-03-01"]').getAttribute('aria-label'), / · 323$/);

  let focused = true, visible = true;
  Object.defineProperty(doc, 'hasFocus', { value: () => focused, configurable: true });
  const element = doc.body.appendChild(doc.createElement('div'));
  element.getClientRects = () => visible ? [{}] : [];
  const workspaceEvents = new Map();
  const changes = [];
  const gate = new ForegroundView({ containerEl: element, app: { workspace: { on: (name, fn) => { workspaceEvents.set(name, fn); return {}; } } }, registerEvent() {}, register() {} }, value => changes.push(value));
  assert(gate.isActive());
  focused = false; dom.window.dispatchEvent(new dom.window.Event('blur'));
  focused = true; dom.window.dispatchEvent(new dom.window.Event('focus'));
  visible = false; workspaceEvents.get('active-leaf-change')();
  visible = true; workspaceEvents.get('layout-change')();
  assert.deepEqual(changes, [false, true, false, true]);
  // A visible split remains active independently of the selected leaf.
  workspaceEvents.get('active-leaf-change')(); assert.equal(changes.length, 4);
  const second = new JSDOM('<body></body>', { pretendToBeVisual: true });
  Object.defineProperty(second.window.document, 'hasFocus', { value: () => true });
  second.window.document.body.appendChild(second.window.document.adoptNode(element));
  workspaceEvents.get('layout-change')();
  focused = false; dom.window.dispatchEvent(new dom.window.Event('blur'));
  assert(gate.isActive(), 'popout follows its owning document');
  gate.dispose(); second.window.close();

  let active = false, builds = 0;
  const home = Object.assign(Object.create(EchoInkHomeView.prototype), {
    closed: false, contentEl: doc.createElement('div'), foreground: { isActive: () => active }, refreshTimer: null, refreshPending: false,
    refreshRunning: false, refreshVersion: 1, searchTimer: null, searchService: { clear() {} }, searchOpen: false,
    scheduleShortNavigation() {}, async refresh() { this.refreshPending = false; builds++; }
  });
  for (let i = 0; i < 5; i++) home.scheduleRefresh(0);
  await sleep(5); assert.equal(builds, 0);
  active = true; home.foregroundChanged(true); await sleep(5); assert.equal(builds, 1);
  home.refreshRunning = true; active = false; home.foregroundChanged(false);
  assert.equal(home.refreshVersion, 2); assert.equal(home.canFinishRefresh(1), false, 'old in-flight result cannot paint after hiding');

  const entry = { id: 'one', term: 'Make Space', category: '工作', note: '独有备注', meaning: '腾出空间', occurrences: [{ date: '2026-10-11', sourcePath: 'Daily/a.md', sourceTitle: '原稿', scene: '场景', reason: '原因' }] };
  assert.equal(filters.filterExpressions([entry], 'ＭＡＫＥ   space', '工作').length, 1);
  for (const query of ['独有备注', '腾出空间', '场景', '原因', '原稿', 'Daily/a.md', '2026-10-11']) assert.equal(filters.filterExpressions([entry], query).length, 1);
  assert.equal(filters.filterExpressions([entry], '', '其他').length, 0);
  let lists = 0, renders = 0;
  const expression = Object.assign(Object.create(EnglishExpressionView.prototype), {
    closed: false, foreground: { isActive: () => active }, contentEl: doc.createElement('div'), timer: null, refreshSequence: 0,
    sourcePaths: new Set(['Daily/a.md']), query: '独有备注', category: '工作', selectedId: 'one',
    draft: { id: 'one', category: '工作', note: '尚未保存', initialCategory: '工作', initialNote: '独有备注' },
    host: { api: { repository: { affectsExpressions: path => filters.pathsOverlap(path, 'Expressions'), listExpressions: async () => { lists++; return [entry]; }, listGenerationActivity: async () => [] } } },
    render() { renders++; }
  });
  assert.equal(expression.affectsExpressions('notes/ordinary.md'), false);
  for (const path of ['Expressions/a.md', 'Expressions', 'Daily/a.md', 'Daily']) assert(expression.affectsExpressions(path));
  for (let i = 0; i < 5; i++) expression.scheduleRefresh(0);
  await sleep(5); assert.equal(lists, 0);
  active = true; expression.foregroundChanged(true); await sleep(5);
  assert.equal(lists, 1); assert.equal(renders, 1); assert.equal(expression.draft.note, '尚未保存');
  expression.query = 'Make'; expression.filterLoadedEntries(); assert.equal(lists, 1);
  let resolveList;
  expression.host.api.repository.listExpressions = () => new Promise(resolve => { resolveList = resolve; });
  const refreshing = expression.refresh(); active = false; expression.foregroundChanged(false); resolveList([]); await refreshing;
  assert.equal(expression.allEntries.length, 1, 'hidden late result is discarded');
  assert.equal(expression.refreshPending, true);
  console.log(JSON.stringify({ search: { files: 1000, retainedCharacters: retained, afterClose: 0 }, calendar: { events: 10000, snapshots, cells: 42 }, hiddenHomeBuilds: 0, resumeHomeBuilds: builds, expressionReadsPerRefresh: lists, result: 'PASS' }));
} finally { dom.window.close(); }
