import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import esbuild from 'esbuild';
import { JSDOM } from 'jsdom';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, '.tmp/home-photo-calendar-tests.mjs');
await mkdir(path.dirname(output), { recursive: true });
await esbuild.build({
  stdin: { contents: 'export { EchoInkHomeView } from "./src/home/home-view"; export { homeWorkspaceMarkup } from "./src/home/home-workspace-template";',
    resolveDir: root, loader: 'ts' },
  bundle: true, platform: 'node', target: 'node22', format: 'esm', outfile: output,
  loader: { '.md': 'text', '.svg': 'text', '.webp': 'dataurl' },
  external: ['@earendil-works/pi-agent-core', '@earendil-works/pi-ai', '@earendil-works/pi-coding-agent', 'yaml', 'jsdom'],
  plugins: [{ name: 'home-photo-fixture', setup(build) {
    build.onResolve({ filter: /(?:^|\/)origin-controls$/ }, () => ({ path: path.join(root, 'src/tests/origin-controls-shim.ts') }));
    build.onResolve({ filter: /^obsidian$/ }, () => ({ path: path.join(root, 'src/tests/obsidian-shim.ts') }));
  } }]
});
const { EchoInkHomeView, homeWorkspaceMarkup } = await import(pathToFileURL(output).href);
{
  const dom = new JSDOM(`<body class="theme-light" data-echoink-theme="green"><div class="echoink-home-workspace">${homeWorkspaceMarkup('en')}</div></body>`);
  globalThis.document = dom.window.document;
  const proto = dom.window.HTMLElement.prototype;
  proto.empty = function () { this.replaceChildren(); };
  proto.setText = function (text) { this.textContent = text; };
  const view = Object.create(EchoInkHomeView.prototype);
  view.contentEl = document.querySelector('.echoink-home-workspace');
  view.app = { vault: { getRoot: () => ({ children: [{ path: 'Daily' }] }) }, internalPlugins: { plugins: {
    'daily-notes': { instance: { options: { folder: 'Daily', format: 'YYYY-MM-DD' } } }
  } } };
  view.plugin = { settings: { settingsLanguage: 'en', journalDirectory: 'old-journal' }, homeActivity: { snapshot: () => ({ events: [] }) } };
  view.dataService = { existingJournalForDate: () => ({}) };
  const photo = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" fill="seagreen"/><circle cx="60" cy="20" r="12" fill="gold"/><path d="M0 80L30 25L60 80" fill="darkslategray"/></svg>');
  view.data = { records: [
    { path: 'Daily/2026-10-03.md', firstImageUrl: photo },
    { path: 'Daily/2026-10-04.md' },
    { path: 'Daily/2026-09-30.md', firstImageUrl: photo },
    { path: 'Daily/2026-11-02.md', firstImageUrl: photo },
    { path: 'old-journal/2026-10-05.md', firstImageUrl: photo },
    { path: 'wiki/2026-10-06.md', firstImageUrl: photo }
  ] };
  view.month = new Date(2026, 9, 1);
  view.selectedDate = '2026-10-03';
  const day = (date) => view.field('calendar-days').querySelector(`[data-date="${date}"]`);
  view.renderCalendar();
  assert.equal(day('2026-10-03').querySelector('img').src, photo);
  assert.equal(day('2026-10-03').getAttribute('aria-pressed'), 'true');
  assert.match(day('2026-10-03').getAttribute('aria-label'), /With photo/);
  assert(day('2026-10-04').classList.contains('has-record'));
  assert(!day('2026-10-05').classList.contains('has-record'));
  assert(!day('2026-10-06').querySelector('img'));
  assert(!day('2026-09-30').querySelector('img'));
  assert.match(view.field('month-record-count').textContent, /2 days this month · 1 with photos/);
  day('2026-10-03').querySelector('img').dispatchEvent(new dom.window.Event('error'));
  assert(!day('2026-10-03').classList.contains('has-photo'));
  assert(day('2026-10-03').classList.contains('has-record'));
  assert.equal(day('2026-10-03').textContent, '3');
  view.month = new Date(2026, 10, 1);
  view.renderCalendar();
  assert(day('2026-11-02').querySelector('img'));
  assert.equal(view.field('calendar-days').querySelectorAll('img').length, 1);
  view.app.internalPlugins.plugins['daily-notes'].instance.options.folder = 'Empty';
  view.renderCalendar();
  assert.equal(view.field('calendar-days').querySelectorAll('img').length, 0);
  assert.match(view.field('month-record-count').textContent, /0 days this month · 0 with photos/);
  view.app.internalPlugins.plugins['daily-notes'].instance.options.folder = 'Daily';
  view.month = new Date(2026, 9, 1);
  view.renderCalendar();
  let recentRefreshes = 0;
  view.renderRecent = () => { recentRefreshes++; };
  view.renderActivity = () => {};
  await view.handleClick({ target: day('2026-10-04').querySelector('.calendar-day-number') });
  assert.equal(view.selectedDate, '2026-10-04');
  assert.equal(recentRefreshes, 1, 'date selection still refreshes recent notes');
  assert.equal(day('2026-10-04').getAttribute('aria-pressed'), 'true');
  let openedDate;
  view.openJournal = async (date) => { openedDate = date; };
  await view.handleClick({ target: view.contentEl.querySelector('[data-action="selected-journal"]') });
  assert.equal(openedDate.getDate(), 4, 'open journal uses the selected date');
  dom.window.close();
  console.log('Photo calendar: PASS (binding, text/empty days, selection, failure fallback, month switch)');
}
