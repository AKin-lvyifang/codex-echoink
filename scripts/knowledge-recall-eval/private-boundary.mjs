#!/usr/bin/env node
// Supplemental privacy observations. Never writes formal scores or frozen data.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, copyFile, writeFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';
import { buildAdapter } from './cli.mjs';
import { verifyDataset, readCases, relativeFile } from './dataset.mjs';

const options = {};
for (let i = 2; i < process.argv.length; i += 2) {
  assert.ok(process.argv[i].startsWith('--') && process.argv[i + 1], 'Expected --name value');
  options[process.argv[i].slice(2)] = process.argv[i + 1];
}
for (const name of ['dataset', 'source-root', 'work-root', 'output']) assert.ok(options[name], `--${name} required`);
const sourceRoot = path.resolve(options['source-root']), workRoot = path.resolve(options['work-root']), output = path.resolve(options.output);
const datasetPath = path.resolve(options.dataset);
assert.ok(workRoot.startsWith(path.join(process.env.HOME, 'EchoInk-TestVaults/90-任务临时/knowledge-private-boundary-20261018-builder') + path.sep));
assert.ok(!output.startsWith(datasetPath + path.sep));
const { manifest, digest } = await verifyDataset(datasetPath);
await assert.rejects(lstat(workRoot), { code: 'ENOENT' });
await assert.rejects(lstat(output), { code: 'ENOENT' });
await mkdir(workRoot, { recursive: true });
const adapter = await buildAdapter(sourceRoot, workRoot);
// Independent host only; source selection, tool authorization, serialization and
// all content reads below use the selected checkout's production classes.
const directOutput = path.join(workRoot, 'direct-probes.mjs');
await esbuild.build({
  stdin: { contents: `
import * as fs from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import { VaultBodySearch } from '@production/knowledge-base/vault-body-search';
import { KnowledgeAgentIndex } from '@production/knowledge-base/knowledge-agent-index';
import { KnowledgeRetriever } from '@production/knowledge-base/query';
import { normalizeKnowledgeFolderBindings, registerKnowledgeFolderBindings } from '@production/knowledge-base/root-paths';
import { PiKnowledgeReadToolSecurity, createPiKnowledgeReadToolDefinitions } from '@production/harness/pi-native/pi-knowledge-read-tools';
import { EchoInkVaultToolEgressPolicy } from '@production/harness/pi-native/vault-tool-result-safety';
import { VaultDomainService } from '@production/harness/pi-native/vault-domain-service';
import { ObsidianVaultDomainAdapter } from '@production/plugin/obsidian-vault-domain-adapter';
import { sha256Hex } from '@production/utils/sha256';
import * as composition from '@production/plugin/pi-production-runtime-composition';
export async function probe(root, savedBindings, originalQuery, replayQueries) {
  const reads = [], metadata = [];
  const file = name => { const stat = fs.statSync(path.join(root, name)); return { path: name, basename: path.basename(name, path.extname(name)), extension: path.extname(name).slice(1), stat: { mtime: stat.mtimeMs, size: stat.size, ctime: stat.ctimeMs } }; };
  const files = (directory = '') => fs.readdirSync(path.join(root, directory), { withFileTypes: true }).filter(entry => !entry.name.startsWith('.')).flatMap(entry => { const name = directory ? directory + '/' + entry.name : entry.name; return entry.isDirectory() ? files(name) : /\\.md$/iu.test(name) ? [file(name)] : []; });
  const app = { vault: { getFiles: files, getMarkdownFiles: files, getAbstractFileByPath: name => { try { return file(name); } catch { return null; } }, read: async entry => { reads.push(entry.path); return fs.promises.readFile(path.join(root, entry.path), 'utf8'); } }, metadataCache: { getFileCache: entry => { metadata.push(entry.path); const text=fs.readFileSync(path.join(root, entry.path),'utf8'), frontmatter=/^---\\r?\\n([\\s\\S]*?)\\r?\\n---(?:\\r?\\n|$)/u.exec(text); return { frontmatter: frontmatter ? parse(frontmatter[1]) : {} }; } }, workspace: { getActiveFile: () => null, getLastOpenFiles: () => [] } };
  const bindings = normalizeKnowledgeFolderBindings(savedBindings);
  const unregister = bindings ? registerKnowledgeFolderBindings(root, () => bindings) : () => {};
  const adapter = new ObsidianVaultDomainAdapter(app, 'privacy-v', root), service = new VaultDomainService(adapter);
  const canonicalResolverFactory = Reflect.get(composition, 'createDesktopKnowledgeSourcePathResolver');
  const canonicalResolverEnabled = typeof canonicalResolverFactory === 'function';
  const port = new VaultBodySearch(app, () => bindings, canonicalResolverEnabled ? { resolveSourcePath: canonicalResolverFactory(adapter) } : {});
  const index = new KnowledgeAgentIndex({ vaultPath: root, storageRootPath: path.join(root, '.probe-index'), bodySearch: port });
  const security = new PiKnowledgeReadToolSecurity({ currentRunIdentity: () => ({ vaultId: 'privacy-v', conversationId: 'privacy-c', piSessionId: 'privacy-s', productRunId: 'privacy-r' }), currentWorkflow: () => 'chat', egress: new EchoInkVaultToolEgressPolicy() });
  const tools = createPiKnowledgeReadToolDefinitions({ retriever: new KnowledgeRetriever(root, { agentIndex: index }), security });
  const privatePaths = ['私有记忆/偏好草稿.md', '.obsidian/plugins/echoink/偏好缓存.md'];
  const calls = [], generic = [];
  const adapterReads = [], baseRead = adapter.readFile.bind(adapter);
  adapter.readFile = async (target, options) => { adapterReads.push(target.relativePath); return await baseRead(target, options); };
  try {
    for (const input of [{ toolName: 'knowledge_search', args: { query: originalQuery } }, { toolName: 'knowledge_search', args: { mode: 'recent', limit: 20 } }, { toolName: 'knowledge_search', args: { query: '私有记忆/偏好草稿.md' } }, ...(replayQueries ? [{ toolName: 'knowledge_search', args: { queries: replayQueries, limit: 10 }, label: 'supplemental replay of observed B11 tool call; frozen B11 unchanged' }] : []), ...privatePaths.map(name => ({ toolName: 'knowledge_read', args: { vaultRelativePath: name, expectedContentRevision: 'sha256:' + sha256Hex(fs.readFileSync(path.join(root, name), 'utf8')) } }))]) {
      const id = 'privacy-call-' + calls.length, before = reads.length;
      const blocked = await security.handleToolCall({ toolName: input.toolName, toolCallId: id, input: input.args }, undefined);
      let result;
      if (blocked) result = { isError: true, blocked };
      else { try { await tools.find(tool => tool.name === input.toolName).execute(id, input.args, undefined, undefined); } catch {} result = await security.handleToolResult({ toolName: input.toolName, toolCallId: id, isError: false }); }
      calls.push({ ...input, result, product_body_reads: reads.slice(before) });
    }
    for (const relativePath of privatePaths) {
      const before = adapterReads.length;
      try { generic.push({ tool: 'note_read', relativePath, snapshot: await service.noteRead({ vaultId: adapter.vaultId, relativePath }), denied: false }); }
      catch (error) { generic.push({ tool: 'note_read', relativePath, denied: true, error: String(error), code: error.code }); }
      generic.at(-1).adapter_body_reads = adapterReads.slice(before);
    }
    for (const query of [originalQuery, '私有记忆']) generic.push({ tool: 'vault_search', query, result: await service.vaultSearch({ vaultId: adapter.vaultId, query }) });
    return { calls, generic, canonical_resolver_enabled: canonicalResolverEnabled, product_body_reads: reads, metadata_paths: metadata, fixture_hash_paths: privatePaths, host: 'Synthetic public Vault API with actual frozen file bodies/metadata; fixture revision hashing is separate from counted product body reads. Desktop canonical resolver factory is wired when available in the tested checkout.' };
  } finally { port.dispose(); unregister(); }
}
`, resolveDir: sourceRoot, loader: 'ts' }, bundle: true, platform: 'node', target: 'node22', format: 'esm', outfile: directOutput,
  loader: { '.md': 'text', '.webp': 'dataurl', '.svg': 'text' },
  external: ['@earendil-works/pi-ai', '@earendil-works/pi-coding-agent', '@earendil-works/pi-agent-core', 'yaml', 'jsdom'],
  plugins: [{ name: 'selected-source', setup(build) {
    build.onResolve({ filter: /^@production\// }, args => ({ path: path.join(sourceRoot, 'src', `${args.path.slice('@production/'.length)}.ts`) }));
    build.onResolve({ filter: /^obsidian$/ }, () => ({ path: path.join(sourceRoot, 'src/tests/obsidian-shim.ts') }));
  } }], logLevel: 'silent'
});
const { probe } = await import(pathToFileURL(directOutput).href);
const cases = await readCases(datasetPath);
const report = {
  kind: 'supplemental-private-boundary-not-formal-score',
  source: { root: sourceRoot, commit: execFileSync('git', ['-C', sourceRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), diff: execFileSync('git', ['-C', sourceRoot, 'diff', '--', 'src'], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }) },
  dataset: { version: manifest.dataset_version, sha256: digest.content_sha256 }, adapter: adapter.metadata,
  parameter_audit: {
    original_excluded_directories: manifest.settings?.excluded_directories,
    effective_excluded_directories: [],
    reason: 'Product default private-root policy must protect notes; frozen expected/excluded roots are not injected. Production composition separately adds actual Personal Memory layout.root (.echoink), already a hidden root.',
    H5: 'Original query and notes. Supplemental Knowledge branch uses case_id=knowledge-H5 and domain=knowledge to bypass original evaluator Memory early return; no Memory result is reconstructed. Memory regression uses unchanged original CLI.',
    host: 'Existing production-adapter synthetic Vault and metadata host; host metadata loading is not a product body read assertion. Direct/pre-I/O probes live in private-note-boundary-tests.',
    limitations: 'No Provider/Obsidian/device; supplemental observations do not replace candidate/delivery/answer scores. Function explicitPaths does not prove native note mentions.'
  }, results: []
};
const effectiveManifest = { ...manifest, settings: { ...manifest.settings, excluded_directories: [] } };
const protectedPath = name => name === '私有记忆' || name.startsWith('私有记忆/') || name === '.obsidian/plugins' || name.startsWith('.obsidian/plugins/');
const notePrefix = `${manifest.notes_dir ?? '笔记'}/`;
for (const caseId of ['A5', 'H5', 'B11']) {
  const original = cases.find(item => item.case_id === caseId);
  assert.ok(original, caseId);
  const item = caseId === 'H5' ? { ...original, case_id: 'knowledge-H5', domain: 'knowledge' } : original;
  const stateRoot = path.join(workRoot, caseId), vaultPath = path.join(stateRoot, 'vault');
  await mkdir(vaultPath, { recursive: true });
  for (const entry of digest.entries.filter(entry => entry.path.startsWith(notePrefix))) {
    const destination = relativeFile(vaultPath, entry.path.slice(notePrefix.length));
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(relativeFile(datasetPath, entry.path), destination);
  }
  const actual = await adapter.evaluate({ vaultPath, statePath: path.join(stateRoot, 'index'), datasetPath, manifest: effectiveManifest, item, runId: `private-boundary-${path.basename(workRoot)}` });
  const direct = await probe(vaultPath, item.setup?.folder_bindings ?? manifest.settings?.folder_bindings ?? manifest.folder_bindings, original.query,
    caseId === 'B11' ? ['雁荡山 灵峰 温州 行程', '雁荡山 交通 住宿 门票'] : undefined);
  const explicit = [];
  for (const privatePath of ['私有记忆/偏好草稿.md', '.obsidian/plugins/echoink/偏好缓存.md']) {
    try {
      const value = await adapter.evaluate({ vaultPath, statePath: path.join(stateRoot, `explicit-${explicit.length}`), datasetPath, manifest: effectiveManifest,
        item: { ...item, setup: { ...item.setup, mutations: [], explicit_paths: [privatePath] } }, runId: `private-explicit-${path.basename(workRoot)}` });
      explicit.push({ path: privatePath, delivered: value.delivery_items, provider_text: value.provider_text, error: null });
    } catch (error) { explicit.push({ path: privatePath, delivered: [], provider_text: '', error: String(error) }); }
  }
  report.results.push({ case_id: caseId, query: original.query, actual, explicit, direct,
    privacy: { candidates: !actual.candidate_items.some(item => protectedPath(item.vaultRelativePath)), delivery: !actual.delivery_items.some(item => protectedPath(item.vaultRelativePath)), explicit: explicit.every(item => !item.delivered.some(value => protectedPath(value.vaultRelativePath))),
      direct_tools: direct.calls.every(call => call.toolName === 'knowledge_read' ? call.result.isError && call.product_body_reads.length === 0 : (call.result.details?.references ?? []).every(reference => !protectedPath(reference.vaultRelativePath)))
        && direct.generic.every(call => call.tool === 'note_read' ? call.denied && call.adapter_body_reads.length === 0 : call.result.items.every(item => !protectedPath(item.relativePath))),
      product_body_reads: direct.product_body_reads.every(name => !protectedPath(name)), metadata: direct.metadata_paths.every(name => !protectedPath(name)) } });
}
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
console.log(JSON.stringify({ output, results: report.results.map(item => ({ case_id: item.case_id, privacy: item.privacy, candidates: item.actual.candidate_items.map(value => value.vaultRelativePath), delivered: item.actual.delivery_items.map(value => value.vaultRelativePath) })) }));
if (options['expect-private-blocked'] === 'true') assert.ok(report.results.every(item => Object.values(item.privacy).every(Boolean)), 'Private candidate/delivery leakage');
