import assert from 'node:assert/strict';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';
import esbuild from 'esbuild';
import ts from 'typescript';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const { JSDOM } = require(process.env.ECHOINK_JSDOM_PATH || 'jsdom');
const directory = path.join(root, '.tmp/community-warning-fixes');
const shortcutOnly = process.argv.includes('--shortcut-only');
await mkdir(directory, { recursive: true });
try {
  // Run the production path resolver against all three OS path semantics.
  const source = await readFile(path.join(root, 'src/plugin/plugin-data-paths.ts'), 'utf8');
  const compiled = await esbuild.transform(source, { loader: 'ts', format: 'cjs' });
  for (const [os, flavor, vault] of shortcutOnly ? [] : [
    ['macOS', path.posix, '/Users/test/Vault'],
    ['Linux', path.posix, '/home/test/Vault'],
    ['Windows', path.win32, 'C:\\Users\\test\\Vault']
  ]) {
    const module = { exports: {} };
    vm.runInNewContext(compiled.code, {
      module, exports: module.exports,
      require: name => name === 'node:path' ? flavor : require(name)
    });
    const { pluginDataDir, pluginInstallDir } = module.exports;
    assert.equal(pluginDataDir(vault), flavor.join(vault, '.obsidian/plugins/codex-echoink'));
    for (const configDir of ['.obsidian-work', 'Config']) {
      const dir = pluginInstallDir({ id: 'codex-echoink' }, configDir);
      assert.equal(pluginDataDir(vault, dir), flavor.join(vault, configDir, 'plugins/codex-echoink'));
      assert.equal(pluginDataDir(vault, `${configDir}\\plugins\\codex-echoink`), flavor.join(vault, configDir, 'plugins/codex-echoink'));
    }
    assert.equal(pluginInstallDir({ id: 'codex-echoink', dir: 'custom/install' }, '.ignored'), 'custom/install');
    assert.equal(pluginDataDir(vault, 'custom/install'), flavor.join(vault, 'custom/install'));
    assert.throws(() => pluginDataDir(vault, '../outside'));
    console.log(`${os} path semantics: PASS (simulation)`);
  }

  const entry = path.join(directory, 'tests.mjs');
  await esbuild.build({
    entryPoints: ['src/tests/community-warning-fixes.ts'], absWorkingDir: root,
    bundle: true, platform: 'node', target: 'node22', format: 'esm', outfile: entry,
    banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
    loader: { '.md': 'text', '.svg': 'dataurl', '.webp': 'dataurl' },
    external: ['@earendil-works/pi-agent-core', '@earendil-works/pi-ai', '@earendil-works/pi-coding-agent', 'yaml'],
    alias: { obsidian: path.join(root, 'src/tests/obsidian-shim.ts') },
    logLevel: 'silent'
  });
  const first = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
  const second = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
  try {
    for (const name of ['window', 'document', 'navigator', 'Element', 'Node', 'HTMLElement', 'HTMLButtonElement', 'MutationObserver']) {
      Object.defineProperty(globalThis, name, { configurable: true, value: name === 'window' ? first.window : first.window[name] });
    }
    const tests = await import(pathToFileURL(entry).href);
    // Exercise the real toolbar callback without rendering unrelated toolbar UI.
    const composer = ts.createSourceFile('composer.ts', await readFile(path.join(root, 'src/ui/codex-view/composer-controller.ts'), 'utf8'), ts.ScriptTarget.Latest, true);
    let capture;
    function find(node) {
      if (ts.isPropertyAssignment(node) && node.name.getText(composer) === 'onCaptureKnowledgeSource') capture = node.initializer;
      ts.forEachChild(node, find);
    }
    find(composer);
    assert.ok(capture);
    const callback = await esbuild.transform(`const callback = ${capture.getText(composer)};`, { loader: 'ts' });
    const createCallback = new Function('host', 'Notice', 'conversationUiText', `${callback.code}\nreturn callback;`);
    const captureFactory = host => createCallback(host, tests.Notice, tests.conversationUiText);
    if (shortcutOnly) await tests.runShortcutFailureTests(captureFactory);
    else await tests.runCommunityWarningFixesTests(first.window, second.window, captureFactory);
  } finally { first.window.close(); second.window.close(); }
} finally { await rm(directory, { recursive: true, force: true }); }
