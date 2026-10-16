#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { canonicalJson, relativeFile } from './dataset.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
// Fixed before any timing. No quality claim or query tuning is performed.
export const FIXED_QUERY = '知识管理';
export function nearestRank(values, percentile) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(percentile * sorted.length) - 1)];
}
const within = (parent, child) => { const value = path.relative(parent, child); return !value || (!path.isAbsolute(value) && value !== '..' && !value.startsWith(`..${path.sep}`)); };
const git = (root, args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }).trim();

async function rejectSymlinks(target) {
  let cursor = path.resolve(target);
  while (true) {
    try { if ((await fs.lstat(cursor)).isSymbolicLink()) throw new Error(`Symlink rejected: ${cursor}`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const parent = path.dirname(cursor);
    if (parent === cursor) return;
    cursor = parent;
  }
}
async function requireNew(target) {
  try { await fs.lstat(target); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  throw new Error(`Refusing to overwrite ${target}`);
}
async function snapshot(root) {
  await rejectSymlinks(root);
  const entries = [];
  async function visit(directory, prefix) {
    for (const name of await fs.readdir(directory)) {
      const relative = prefix ? `${prefix}/${name}` : name;
      const full = relativeFile(root, relative);
      const stat = await fs.lstat(full);
      if (stat.isSymbolicLink()) throw new Error(`Fixture symlink rejected: ${relative}`);
      if (stat.isDirectory()) await visit(full, relative);
      else if (stat.isFile()) entries.push({ path: relative, bytes: stat.size, mtime_ms: stat.mtimeMs, sha256: createHash('sha256').update(await fs.readFile(full)).digest('hex') });
      else throw new Error(`Special fixture file rejected: ${relative}`);
    }
  }
  await visit(root, '');
  entries.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  const digest = createHash('sha256').update(canonicalJson(entries.map(({ path: name, bytes, sha256 }) => ({ path: name, bytes, sha256 })))).digest('hex');
  return { entries, sha256: digest, file_count: entries.length, markdown_count: entries.filter(entry => /\.(?:md|markdown)$/iu.test(entry.path)).length, total_bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0) };
}
async function build(sourceRoot, workRoot) {
  const esbuild = await import('esbuild');
  const outfile = path.join(workRoot, 'performance-worker.mjs');
  await fs.symlink(path.join(sourceRoot, 'node_modules'), path.join(workRoot, 'node_modules'), 'dir');
  const built = await esbuild.build({
    absWorkingDir: sourceRoot, entryPoints: [path.join(here, 'performance-adapter.ts')], outfile,
    bundle: true, platform: 'node', target: 'node22', format: 'esm', metafile: true,
    loader: { '.md': 'text', '.svg': 'text', '.webp': 'dataurl' },
    external: ['@earendil-works/pi-agent-core', '@earendil-works/pi-ai', '@earendil-works/pi-coding-agent', 'yaml', 'jsdom'],
    plugins: [{ name: 'explicit-performance-production-checkout', setup(builder) {
      builder.onResolve({ filter: /^@production\// }, args => ({ path: path.join(sourceRoot, 'src', `${args.path.slice('@production/'.length)}.ts`) }));
      builder.onResolve({ filter: /^obsidian$/ }, () => ({ path: path.join(sourceRoot, 'src/tests/obsidian-shim.ts') }));
    } }], logLevel: 'silent'
  });
  const imported = [];
  for (const name of Object.keys(built.metafile.inputs).sort()) {
    const full = path.resolve(sourceRoot, name);
    if (within(path.join(sourceRoot, 'src'), full) || within(here, full)) imported.push({ path: within(here, full) ? `evaluator/${path.relative(here, full)}` : path.relative(sourceRoot, full), sha256: createHash('sha256').update(await fs.readFile(full)).digest('hex') });
  }
  return { outfile, imported_files: imported, functions: await import(pathToFileURL(outfile).href) };
}
async function childWorker(outfile, configPath) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [outfile, '--worker-config', configPath], { env: { ...process.env, PI_OFFLINE: '1' }, stdio: ['ignore', 'inherit', 'inherit'] });
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`Performance worker exited ${code ?? signal}`)));
  });
}
function distributions(samples, temperature) {
  const selected = samples.filter(sample => sample.temperature === temperature);
  const stats = values => ({ n: values.length, p50_ms: nearestRank(values, 0.50), p95_ms: nearestRank(values, 0.95), raw_ms: values });
  const names = ['KnowledgeAgentIndex.search', 'KnowledgeRetriever.retrieve', 'createProductionPiKnowledgeRuntime.retrieveChat', 'createProductionPiKnowledgeRuntime.retrieveAsk'];
  return {
    initialization_refresh: stats(selected.flatMap(sample => sample.initialization ? [sample.initialization.elapsed_ms] : [])),
    functions: Object.fromEntries(names.map(name => [name, stats(selected.map(sample => sample.calls.find(call => call.function === name).elapsed_ms))]))
  };
}

export async function runPerformance(options) {
  const sourceRoot = path.resolve(options['source-root']);
  const fixtureRoot = path.resolve(options['fixture-root']);
  const outputRun = path.resolve(options['output-run']);
  const runId = options['run-id'];
  const smoke = options.smoke === 'true';
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/u.test(runId ?? '')) throw new Error('Invalid run-id');
  const testRoot = path.join(os.homedir(), 'EchoInk-TestVaults');
  if (!within(testRoot, fixtureRoot)) throw new Error('Performance fixture must be inside EchoInk-TestVaults');
  if (!smoke && fixtureRoot !== path.join(testRoot, '20-特殊场景/大规模')) throw new Error('Formal K1 requires the approved large-vault source');
  const workRoot = path.join(testRoot, '90-任务临时', `知识库-召回评测-${runId}`);
  if (within(fixtureRoot, outputRun) || within(fixtureRoot, workRoot) || within(workRoot, fixtureRoot)) throw new Error('Source fixture, working copy and output must be separate');
  await requireNew(workRoot); await requireNew(outputRun);
  await rejectSymlinks(workRoot); await rejectSymlinks(outputRun);
  const startedAt = new Date().toISOString();
  const before = await snapshot(fixtureRoot);
  if (!smoke && (before.markdown_count !== 2940 || before.total_bytes !== 3998565)) throw new Error(`Large-vault snapshot differs from approved baseline: ${before.markdown_count} Markdown, ${before.total_bytes} bytes`);
  const code = { git_commit: git(sourceRoot, ['rev-parse', 'HEAD']), worktree_status: git(sourceRoot, ['status', '--porcelain']), source_status: git(sourceRoot, ['status', '--porcelain', '--', 'src']), source_diff: git(sourceRoot, ['diff', 'HEAD', '--', 'src']), plugin_version: JSON.parse(await fs.readFile(path.join(sourceRoot, 'package.json'), 'utf8')).version,
    evaluator_version: 'kb-recall-performance-v1', evaluator_files: await Promise.all(['performance.mjs', 'performance-adapter.ts', 'dataset.mjs'].map(async name => ({ path: name, sha256: createHash('sha256').update(await fs.readFile(path.join(here, name))).digest('hex') }))) };
  await fs.mkdir(workRoot, { recursive: true });
  const vaultPath = path.join(workRoot, 'vault');
  for (const entry of before.entries) {
    const target = relativeFile(vaultPath, entry.path);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(relativeFile(fixtureRoot, entry.path), target);
    await fs.utimes(target, new Date(entry.mtime_ms), new Date(entry.mtime_ms));
  }
  const adapter = await build(sourceRoot, workRoot);
  const directory = await adapter.functions.discoverPerformanceBindings(vaultPath);
  const expectedBatches = smoke ? directory.batches.length : 15;
  if (!expectedBatches || directory.batches.length !== expectedBatches || ['wiki', 'projects', 'raw'].some(role => directory.bindings.roles[role].readPaths.length !== expectedBatches)) throw new Error('Each batch must bind wiki/projects/raw exactly once; no empty-index fallback');
  const definition = {
    schema_version: 'kb-recall-performance-v1', run_id: runId, question: FIXED_QUERY, phase: options.phase,
    cold_rounds: smoke ? 1 : 5, warm_repeats: smoke ? 2 : 20, smoke_only: smoke,
    cold_definition: 'Fresh Node subprocess and fresh on-disk KnowledgeAgentIndex per round. Explicit refresh is awaited, then first search/retriever/chat/ask calls in that exact order. OS filesystem caches are not purged.',
    warm_definition: 'Reuse the last cold subprocess and index for all warm repetitions; no refresh or source edits between them.',
    metric_definition: 'Each function is measured separately. This sequence of four probes is not a native conversation end-to-end latency.',
    percentile_definition: 'nearest_rank: sort ascending, select ceil(p*n), 1-based; p50=0.50, p95=0.95.',
    memory_definition: 'Isolated worker process only, after module imports. Before/after snapshots plus 10ms interval sample process.memoryUsage() in bytes. Sampled peaks can miss synchronous peaks; resourceUsage.maxRSS*1024 is process-lifetime RSS high-water, includes imports and all calls. No claim of per-function exact peak heap or mobile memory.',
    folder_configuration: directory, fixture: { source: fixtureRoot, copied_to: vaultPath, sha256: before.sha256, file_count: before.file_count, markdown_count: before.markdown_count, total_bytes: before.total_bytes }
  };
  // Freeze query, repetitions, and binding configuration before the first sample.
  await fs.writeFile(path.join(workRoot, 'definition.json'), `${JSON.stringify(definition, null, 2)}\n`, 'utf8');
  const samples = [];
  const workers = [];
  for (let round = 1; round <= definition.cold_rounds; round++) {
    const session = path.join(workRoot, `round-${String(round).padStart(2, '0')}`);
    await fs.mkdir(session);
    const configPath = path.join(session, 'config.json');
    const resultPath = path.join(session, 'worker-result.json');
    await fs.writeFile(configPath, JSON.stringify({ vaultPath, statePath: path.join(session, 'index'), bindings: directory.bindings, question: FIXED_QUERY, coldRound: round, warmRepeats: round === definition.cold_rounds ? definition.warm_repeats : 0, runId, resultPath }), 'utf8');
    await childWorker(adapter.outfile, configPath);
    const worker = JSON.parse(await fs.readFile(resultPath, 'utf8'));
    samples.push(...worker.samples); workers.push({ pid: worker.pid, cold_round: round, process_final_memory: worker.process_final_memory });
    process.stderr.write(`K1 cold round ${round}/${definition.cold_rounds}: entries=${worker.samples[0].index_entry_count}; warm=${worker.samples.filter(sample => sample.temperature === 'warm').length}\n`);
  }
  const after = await snapshot(fixtureRoot);
  if (before.sha256 !== after.sha256) throw new Error('Read-only source fixture changed during sampling; no result is published');
  const copyAfter = await snapshot(vaultPath);
  if (before.sha256 !== copyAfter.sha256) throw new Error('Working corpus changed during sampling; no result is published');
  const bundlePath = path.resolve(options['bundle-path'] ?? path.join(sourceRoot, 'dist/main.js'));
  let bundle;
  try { const stat = await fs.stat(bundlePath); if (!stat.isFile()) throw new Error('Bundle is not a file'); bundle = { status: 'measured', path: bundlePath, bytes: stat.size, mtime: stat.mtime.toISOString(), provenance: 'Existing artifact; this script does not build or verify its source commit. Record matching production build evidence separately.' }; }
  catch (error) { bundle = { status: 'not_run', path: bundlePath, bytes: null, reason: error.message }; }
  const run = {
    run_id: runId, started_at: startedAt, ended_at: new Date().toISOString(), phase: options.phase, device: 'desktop-script', model: '', evidence_level: 'isolated-node-production-function-performance',
    code, definition, host: { node: process.version, platform: process.platform, release: os.release(), arch: os.arch(), cpu: os.cpus()[0]?.model, logical_cpus: os.cpus().length, ram_bytes: os.totalmem(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone },
    performance: { cold: distributions(samples, 'cold'), warm: distributions(samples, 'warm'), memory_workers: workers, production_bundle: bundle,
      index_entry_counts: [...new Set(samples.map(sample => sample.index_entry_count))],
      observed_workload: samples.map(sample => ({ temperature: sample.temperature, cold_round: sample.cold_round, repetition: sample.repetition, candidate_total: sample.calls[0].value.total, candidate_returned: sample.calls[0].value.returned, direct_reference_count: sample.calls[1].value.references.length, chat_reference_count: sample.calls[2].value.references.length, ask_reference_count: sample.calls[3].value.references.length })) },
    initialization_wait: { status: 'measured_script_refresh_only', definition: 'KnowledgeAgentIndex.refresh is explicitly awaited; per-round blocking duration is stored in initialization_refresh. First Pi conversation initialization and its UI wait are not exercised.' },
    stop_behavior: { status: 'not_run', reason: 'These existing refresh/search/retrieve APIs have no AbortSignal/cancel parameter. No native UI/turn stop is exercised; killing a child would only prove process termination.' },
    first_pi_runtime_initialization: { status: 'not_run', reason: 'Requires the real Pi conversation lifecycle; this script composes the production knowledge runtime only.' },
    source_integrity: { status: 'unchanged', before_sha256: before.sha256, after_sha256: after.sha256, working_copy_sha256: copyAfter.sha256 },
    sample_path: 'samples.jsonl', quality_scores: null,
    limitations: ['No model, Obsidian UI, iPhone/iPad, native stop, or OS page-cache cold measurement.', 'The host may have other workloads. Cold quantiles contain five samples, so nearest-rank p95 is their maximum.', 'Bundle bytes require separately retained build provenance; this script never builds or changes the artifact.']
  };
  await fs.mkdir(path.dirname(outputRun), { recursive: true }); await fs.mkdir(outputRun);
  await fs.writeFile(path.join(outputRun, 'definition.json'), `${JSON.stringify(definition, null, 2)}\n`, 'utf8');
  await fs.writeFile(path.join(outputRun, 'samples.jsonl'), `${samples.map(sample => JSON.stringify(sample)).join('\n')}\n`, 'utf8');
  await fs.writeFile(path.join(outputRun, 'run.json'), `${JSON.stringify(run, null, 2)}\n`, 'utf8');
  await fs.rm(path.join(workRoot, 'node_modules'), { force: true });
  await fs.rm(adapter.outfile, { force: true });
  return run;
}

async function main() {
  const options = {};
  const args = process.argv.slice(2);
  if (!args.length || args[0] === '--help') { console.log('node scripts/knowledge-recall-eval/performance.mjs --source-root CHECKOUT --fixture-root TEST_VAULT --output-run DIR --run-id ID --phase P0 [--bundle-path FILE] [--smoke true]\nFormal K1 uses fixed query 知识管理, cold=5 and warm=20. --smoke true is a small fixture check with 1/2 repetitions, never a K1 baseline.'); return; }
  for (let index = 0; index < args.length; index += 2) {
    if (!args[index]?.startsWith('--') || !args[index + 1] || args[index + 1].startsWith('--')) throw new Error('Options require --name value');
    options[args[index].slice(2)] = args[index + 1];
  }
  for (const name of ['source-root', 'fixture-root', 'output-run', 'run-id', 'phase']) if (!options[name]) throw new Error(`--${name} is required`);
  const run = await runPerformance(options);
  console.log(JSON.stringify({ run_id: run.run_id, smoke_only: run.definition.smoke_only, cold_samples: run.performance.cold.functions['KnowledgeAgentIndex.search'].n, warm_samples: run.performance.warm.functions['KnowledgeAgentIndex.search'].n, index_entries: run.performance.index_entry_counts, source_markdown_count: run.definition.fixture.markdown_count, output: path.resolve(options['output-run']) }));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.stack ?? error.message); process.exitCode = 1; });
