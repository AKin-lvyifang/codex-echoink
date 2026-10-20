import path from 'node:path';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { createHash, webcrypto } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';
import { parse } from 'yaml';
import { mobileBuildOptions } from '../mobile-build.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const inside = (root, full) => full === root || full.startsWith(root + path.sep);
const relative = name => {
  if (typeof name !== 'string' || !name || name.includes('\\') || name.includes('\0') || path.posix.isAbsolute(name) || name.split('/').some(p => !p || p === '.' || p === '..')) throw new Error(`Unsafe in-memory path: ${name}`);
  return name;
};
function events(log, surface) {
  const subscriptions = new Map();
  return {
    on(name, callback) { const list = subscriptions.get(name) ?? []; list.push(callback); subscriptions.set(name, list); return { name, callback }; },
    offref(ref) { subscriptions.set(ref.name, (subscriptions.get(ref.name) ?? []).filter(item => item !== ref.callback)); },
    trigger(name, ...args) { log.push({ surface, event: name, path: args[0]?.path ?? null, old_path: args[1] ?? null, listeners: (subscriptions.get(name) ?? []).length }); for (const cb of subscriptions.get(name) ?? []) cb(...args); }
  };
}
export function createMobileShellHost(seed, { fixedNow, openedPaths = [], readFailures = [] } = {}) {
  const files = new Map(Object.entries(seed));
  const folders = new Set(['.echoink-mobile-eval']);
  const objects = new Map(), eventLog = [], writes = [], failures = new Set(readFailures);
  let clock = Date.parse(fixedNow) || Date.now();
  const addParents = name => { const parts = name.split('/'); parts.pop(); while (parts.length) { folders.add(parts.join('/')); parts.pop(); } };
  const file = name => {
    if (!objects.has(name)) objects.set(name, { path: name, name: path.posix.basename(name), basename: path.posix.basename(name).replace(/\.[^.]+$/u, ''), extension: name.split('.').at(-1), stat: { ctime: clock, mtime: clock, size: Buffer.byteLength(files.get(name) ?? '') } });
    return objects.get(name);
  };
  for (const name of files.keys()) { relative(name); addParents(name); file(name); }
  const vaultEvents = events(eventLog, 'vault'), cacheEvents = events(eventLog, 'metadataCache');
  const put = (name, content) => { relative(name); files.set(name, content); addParents(name); const f = file(name); f.stat.mtime = ++clock; f.stat.size = Buffer.byteLength(content); writes.push(name); return f; };
  const adapter = {
    async exists(name) { return files.has(name) || folders.has(name); },
    async read(name) { relative(name); if (failures.has(name)) throw new Error(`Injected frozen read failure: ${name}`); if (!files.has(name)) throw new Error(`Missing in-memory file: ${name}`); return files.get(name); },
    async write(name, content) { put(name, content); },
    async mkdir(name) { relative(name); folders.add(name); addParents(name + '/child'); },
    async stat(name) { return files.has(name) ? { type: 'file', ...file(name).stat } : folders.has(name) ? { type: 'folder', ctime: clock, mtime: clock, size: 0 } : null; },
    async remove(name) { files.delete(name); objects.delete(name); },
    async rename(from, to) { const content = await this.read(from); put(to, content); files.delete(from); objects.delete(from); },
    async list(name) { const prefix = name ? name + '/' : ''; return { files: [...files.keys()].filter(p => p.startsWith(prefix) && !p.slice(prefix.length).includes('/')), folders: [...folders].filter(p => p.startsWith(prefix) && !p.slice(prefix.length).includes('/')) }; }
  };
  const app = {
    metadataCache: { ...cacheEvents, resolvedLinks: {}, getFileCache(f) {
      const content = files.get(f.path) ?? '';
      const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(content);
      const frontmatter = match ? parse(match[1]) ?? {} : {};
      const headings = content.split(/\r?\n/u).flatMap((line, i) => { const h = /^(#{1,6})\s+(.+)$/u.exec(line); return h ? [{ heading: h[2], level: h[1].length, position: { start: { line: i, col: 0, offset: 0 }, end: { line: i, col: line.length, offset: 0 } } }] : []; });
      return { frontmatter, headings, tags: [...content.matchAll(/(?:^|\s)#([\p{L}\p{N}_/-]+)/gu)].map(m => ({ tag: '#' + m[1] })) };
    } },
    vault: { ...vaultEvents, configDir: '.obsidian', adapter,
      getName: () => '电脑模拟手机对话外壳，不是真机',
      getMarkdownFiles: () => [...files.keys()].filter(p => /\.md$/iu.test(p) && !p.split('/').some(part => part.startsWith('.'))).map(file),
      getFiles: () => [...files.keys()].map(file),
      getAbstractFileByPath: name => files.has(name) ? file(name) : folders.has(name) ? { path: name, name: path.posix.basename(name), children: [] } : null,
      async read(f) { return adapter.read(f.path); }, async cachedRead(f) { return adapter.read(f.path); },
      async modify(f, text) { put(f.path, text); vaultEvents.trigger('modify', f); cacheEvents.trigger('changed', f); },
      async create(name, text) { if (files.has(name)) throw new Error('File exists'); const f = put(name, text); vaultEvents.trigger('create', f); cacheEvents.trigger('changed', f); return f; },
      async createFolder(name) { await adapter.mkdir(name); },
      async delete(f) { files.delete(f.path); objects.delete(f.path); vaultEvents.trigger('delete', f); },
      async rename(f, to) { relative(to); const old = f.path; const content = await adapter.read(old); files.delete(old); objects.delete(old); const renamed = put(to, content); vaultEvents.trigger('rename', renamed, old); cacheEvents.trigger('changed', renamed); }
    },
    workspace: { getActiveFile: () => openedPaths[0] && files.has(openedPaths[0]) ? file(openedPaths[0]) : null, getLastOpenFiles: () => [...openedPaths], getLeavesOfType: () => [], getLeaf: () => ({ async openFile() {} }) }
  };
  return { app, adapter, files, eventLog, writes, async mutate(mutation) {
    relative(mutation.path); const f = app.vault.getAbstractFileByPath(mutation.path);
    if (mutation.action === 'write') { if (f) await app.vault.modify(f, mutation.content); else await app.vault.create(mutation.path, mutation.content); }
    else if (mutation.action === 'delete' && f) await app.vault.delete(f);
    else if (mutation.action === 'rename' && f) await app.vault.rename(f, mutation.to);
    else throw new Error(`Unsupported/missing mutation: ${mutation.action} ${mutation.path}`);
  } };
}

export async function buildMobileShell(sourceRoot, fixedNow) {
  const entry = path.join(here, 'mobile-shell-entry.ts');
  const opts = mobileBuildOptions(entry);
  const result = await esbuild.build({ ...opts, absWorkingDir: sourceRoot, metafile: true, plugins: [{ name: 'mobile-shell-explicit-source', setup(build) {
    build.onResolve({ filter: /^@mobile-production\// }, args => ({ path: path.join(sourceRoot, 'src', args.path.slice('@mobile-production/'.length) + '.ts') }));
  } }, ...opts.plugins] });
  const sourceFiles = [];
  for (const name of Object.keys(result.metafile.inputs).sort()) {
    if (name.includes(':') && !path.isAbsolute(name)) continue;
    const full = path.resolve(sourceRoot, name);
    if (full.includes(path.sep + 'src' + path.sep) && !inside(path.join(sourceRoot, 'src'), full)) throw new Error(`Foreign production source: ${full}`);
    if (inside(path.join(sourceRoot, 'src'), full) || full === entry) sourceFiles.push({ path: full === entry ? 'evaluator/mobile-shell-entry.ts' : path.relative(sourceRoot, full), sha256: createHash('sha256').update(await readFile(full)).digest('hex') });
  }
  const module = { exports: {} }, notices = [];
  const fixed = Date.parse(fixedNow);
  class FixtureDate extends Date { constructor(...args) { super(...(args.length ? args : [fixed])); } static now() { return fixed; } }
  vm.runInNewContext(result.outputFiles[0].text, { module, exports: module.exports, Date: FixtureDate, console, crypto: webcrypto, URL, TextEncoder, TextDecoder, AbortController, setTimeout, clearTimeout, structuredClone, btoa, atob,
    require(id) { if (id !== 'obsidian') throw new Error(`Node import in mobile shell: ${id}`); return { Notice: class { constructor(text) { notices.push(text); } }, normalizePath: text => text.replaceAll('\\', '/').replace(/\/+/gu, '/'), Platform: { isMobileApp: true, isMobile: true, isTablet: false } }; }
  });
  return { api: module.exports, metadata: { source_root: sourceRoot, imported_files: sourceFiles, bundle_sha256: createHash('sha256').update(result.outputFiles[0].contents).digest('hex'), platform: 'browser', real_mobile_runtime: true }, notices };
}

export function fixtureResponse(protocol, text = 'Offline capture complete.', calls = []) {
  return protocol === 'openai-responses'
    ? { status: 200, json: { id: 'offline-response', model: 'offline-capture', status: 'completed', output: [...(text ? [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }] : []), ...calls.map(([id, name, args]) => ({ type: 'function_call', call_id: id, name, arguments: JSON.stringify(args) }))] } }
    : { status: 200, json: { id: 'offline-response', model: 'offline-capture', choices: [{ finish_reason: calls.length ? 'tool_calls' : 'stop', message: { role: 'assistant', content: text || null, tool_calls: calls.map(([id, name, args]) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } })) } }] } };
}
