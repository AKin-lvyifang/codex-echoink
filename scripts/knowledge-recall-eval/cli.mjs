#!/usr/bin/env node
import { disposableTestRoot } from "../disposable-test-root.mjs";
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile, lstat, copyFile, symlink, rm, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { freezeDataset, verifyDataset, readCases, relativeFile } from './dataset.mjs';
import { judgeCandidate, judgeDelivery, notRun, summarize } from './judge.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const RETRIEVAL_BASELINE = 'c8fce67c91ce20ebfb0203bd7bb34f32d5b8fb23';
export const CSV_COLUMNS = ['run_id', 'started_at', 'phase', 'git_commit', 'dataset_version', 'device', 'model', 'candidate', 'delivery', 'answer', 'tool_calls_median', 'elapsed_seconds_median', 'record_path', 'notes'];
export function csvRow(run, recordPath, notes = '') {
  const values = [run.run_id, run.started_at, run.phase, run.code.git_commit, run.dataset.version, run.device, '', run.scores.candidate.score, run.scores.delivery.score, '', run.answer_metrics?.summary?.tool_calls_median, run.answer_metrics?.summary?.elapsed_seconds_median, recordPath, notes];
  return values.map(value => `"${String(value ?? '').replaceAll('"', '""')}"`).join(',');
}

function git(root, args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }).trim();
}
function contains(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
async function ensureNew(directory) {
  try { await lstat(directory); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  throw new Error(`Refusing to overwrite existing directory: ${directory}`);
}
async function rejectSymlinkAncestors(directory) {
  let cursor = path.resolve(directory);
  while (true) {
    try { if ((await lstat(cursor)).isSymbolicLink()) throw new Error(`Output/work symlink rejected: ${cursor}`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const parent = path.dirname(cursor);
    if (parent === cursor) return;
    cursor = parent;
  }
}

export async function buildAdapter(sourceRoot, workRoot) {
  const esbuild = await import('esbuild');
  const output = path.join(workRoot, 'production-adapter.mjs');
  await symlink(path.join(sourceRoot, 'node_modules'), path.join(workRoot, 'node_modules'), 'dir');
  const bodySearchAvailable = await lstat(path.join(sourceRoot, 'src/knowledge-base/vault-body-search.ts')).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
  const result = await esbuild.build({
    entryPoints: [path.join(here, 'production-adapter.ts')],
    absWorkingDir: sourceRoot, outfile: output, bundle: true, platform: 'node', target: 'node22', format: 'esm', metafile: true,
    loader: { '.md': 'text', '.svg': 'text', '.webp': 'dataurl' },
    external: ['@earendil-works/pi-agent-core', '@earendil-works/pi-ai', '@earendil-works/pi-coding-agent', 'yaml', 'jsdom'],
    plugins: [{ name: 'explicit-production-checkout', setup(build) {
      build.onResolve({ filter: /^@production\// }, args => !bodySearchAvailable && args.path === '@production/knowledge-base/vault-body-search'
        ? { path: args.path, namespace: 'legacy-body-search-absent' }
        : { path: path.join(sourceRoot, 'src', `${args.path.slice('@production/'.length)}.ts`) });
      build.onLoad({ filter: /.*/, namespace: 'legacy-body-search-absent' }, () => ({ contents: 'export const VaultBodySearch = undefined;', loader: 'js' }));
      build.onResolve({ filter: /^obsidian$/ }, () => ({ path: path.join(sourceRoot, 'src/tests/obsidian-shim.ts') }));
    } }], logLevel: 'silent'
  });
  const sourceFiles = [];
  for (const name of Object.keys(result.metafile.inputs).sort()) {
    const full = path.resolve(sourceRoot, name);
    if (contains(path.join(sourceRoot, 'src'), full) || contains(here, full)) sourceFiles.push({ path: contains(here, full) ? `evaluator/${path.relative(here, full)}` : path.relative(sourceRoot, full), sha256: createHash('sha256').update(await readFile(full)).digest('hex') });
  }
  const adapter = await import(pathToFileURL(output).href);
  return { evaluate: adapter.evaluateProduction, metadata: { body_search_available: bodySearchAvailable, entry: path.relative(sourceRoot, path.join(here, 'production-adapter.ts')), source_root: sourceRoot, imported_files: sourceFiles, host_shim: 'src/tests/obsidian-shim.ts', bundle_sha256: createHash('sha256').update(await readFile(output)).digest('hex') } };
}

function flattenCases(cases, selected) {
  return cases.filter(item => !selected || selected.includes(item.case_id)).flatMap(item => {
    if (!item.subcases?.length) return [item];
    const { subcases, ...parent } = item;
    return subcases.map(subcase => ({ ...parent, ...subcase, case_id: item.case_id, subcase_id: subcase.subcase_id ?? subcase.id, setup: { ...(item.setup ?? {}), ...(subcase.setup ?? {}) }, expected: { ...(item.expected ?? {}), ...(subcase.expected ?? {}) } }));
  });
}
function applySetupLimitations(verdict, issues) {
  const blockers = issues.filter(issue => issue.blocks_standard_setup);
  if (['not_applicable', 'not_run'].includes(verdict.status) || !blockers.length) return verdict;
  return { ...verdict, status: 'blocked', assertions: [...verdict.assertions, ...blockers.map(issue => ({ name: `standard host setup not executed: ${issue.key}`, pass: false, actual: issue }))], reasons: [...verdict.reasons, ...blockers.map(issue => `Script host precondition not executed: ${issue.key}`)] };
}

export async function runEvaluation(options) {
  const datasetPath = path.resolve(options.dataset);
  // Validate before creating work directories or writing any score/artifact.
  const { manifest, digest } = await verifyDataset(datasetPath);
  const allCases = await readCases(datasetPath);
  const sourceRoot = path.resolve(options['source-root']);
  const outputRun = path.resolve(options['output-run']);
  const runId = options['run-id'];
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/u.test(runId ?? '')) throw new Error('run-id must be 1-120 ASCII letters/digits/._-');
  if (contains(datasetPath, outputRun)) throw new Error('Runtime output cannot be inside frozen dataset');
  const workRoot = path.join(disposableTestRoot(path.join(os.homedir(), 'EchoInk-TestVaults', '90-任务临时')), `知识库-召回评测-${runId}`);
  if (contains(datasetPath, workRoot) || contains(workRoot, datasetPath)) throw new Error('Dataset and work directory must be separate');
  await ensureNew(outputRun);
  await ensureNew(workRoot);
  await rejectSymlinkAncestors(outputRun);
  await rejectSymlinkAncestors(workRoot);
  const startedAt = new Date().toISOString();
  const baselineCommit = options['retrieval-baseline-commit'] ?? RETRIEVAL_BASELINE;
  const code = {
    git_commit: git(sourceRoot, ['rev-parse', 'HEAD']),
    retrieval_baseline_commit: baselineCommit,
    retrieval_matches_baseline: git(sourceRoot, ['diff', '--name-only', baselineCommit, '--', 'src']) === '',
    evaluator_version: 'knowledge-recall-eval-v1',
    evaluator_git_commit: git(path.resolve(here, '../..'), ['rev-parse', 'HEAD']),
    evaluator_files: await Promise.all((await readdir(here)).filter(name => /\.(?:mjs|ts)$/u.test(name)).sort().map(async name => ({ path: name, sha256: createHash('sha256').update(await readFile(path.join(here, name))).digest('hex') }))),
    worktree_status: git(sourceRoot, ['status', '--porcelain']),
    source_diff: git(sourceRoot, ['diff', 'HEAD', '--', 'src']),
    plugin_version: JSON.parse(await readFile(path.join(sourceRoot, 'package.json'), 'utf8')).version
  };
  if (options['expected-commit'] && code.git_commit !== options['expected-commit']) throw new Error(`Unexpected source commit: ${code.git_commit}`);
  const selected = options.cases ? options.cases.split(',') : options['all-cases'] === 'true' ? undefined : allCases.filter(item => item.starter === true).map(item => item.case_id);
  if (selected?.some(id => !allCases.some(item => item.case_id === id))) throw new Error('Unknown selected case_id');
  const items = flattenCases(allCases, selected);
  const promptBoundaryEnabled = options['prompt-boundary'] === 'true';
  const boundaryOverrides = items.filter(item => item.case_id === 'I7' && promptBoundaryEnabled && item.execution?.script === false).map(item => ({ case_id: item.case_id, frozen_execution_script: false, effective_execution_script: true, reason: 'Explicit --prompt-boundary true enables the frozen I7 case through final production message conversion; dataset remains unchanged.' }));
  await mkdir(workRoot, { recursive: true });
  let adapter;
  try { adapter = await buildAdapter(sourceRoot, workRoot); }
  catch (error) { await rm(workRoot, { recursive: true, force: true }); throw error; }
  const results = [];
  const noteDirectory = manifest.notes_dir ?? '笔记';
  const notePrefix = `${noteDirectory}/`;
  const noteFiles = digest.entries.filter(entry => entry.path.startsWith(notePrefix));
  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    const key = `${item.case_id}${item.subcase_id ? `-${item.subcase_id}` : ''}`;
    const result = {
      case_id: item.case_id, subcase_id: item.subcase_id ?? null, device: item.device ?? 'desktop-script', repetition: 1,
      query: item.query ?? '', starter: item.starter === true, batch: item.batch, partition: item.partition,
      answer: notRun('No model request is made by this script; answer text and score remain empty.'), answer_text: '',
      evidence_level: 'script-production-functions-with-synthetic-storage', expected: item.expected ?? {}
    };
    const boundaryOverride = boundaryOverrides.find(override => override.case_id === item.case_id);
    if ((item.execution?.script === false && !boundaryOverride) || /^[JK]/u.test(item.case_id)) {
      const reason = item.case_id === 'J1' ? 'User deferred connecting iPhone/iPad in this round; native device checks were not run.' : item.execution?.reason ?? 'Native device/performance scenario is outside this content script.';
      result.candidate = notRun(reason); result.delivery = notRun(reason);
      results.push(result);
      continue;
    }
    if (typeof item.query !== 'string' || !item.query.trim()) throw new Error(`Missing query: ${key}`);
    const caseRoot = path.join(workRoot, `case-${String(index + 1).padStart(3, '0')}`);
    const vaultPath = path.join(caseRoot, 'vault');
    await mkdir(vaultPath, { recursive: true });
    for (const entry of noteFiles) {
      const target = relativeFile(vaultPath, entry.path.slice(notePrefix.length));
      await mkdir(path.dirname(target), { recursive: true });
      await copyFile(relativeFile(datasetPath, entry.path), target);
    }
    const before = performance.now();
    try {
      const actual = await adapter.evaluate({ vaultPath, statePath: path.join(caseRoot, 'index'), datasetPath, manifest, item, runId });
      result.actual = actual;
      result.candidate_ranking = actual.candidate_items.map((value, rank) => ({ rank: rank + 1, ...value }));
      result.candidate = applySetupLimitations(judgeCandidate(item.expected?.candidate, actual.candidate_items), actual.unsupported_setup);
      result.delivery = applySetupLimitations(judgeDelivery(item.expected?.delivery, actual.delivery_items, actual.provider_text, actual.prompt_boundary), actual.unsupported_setup);
      if (item.engineering_assertions?.length) {
        result.engineering = { status: 'pending_review', assertions: item.engineering_assertions, reason: 'These trace assertions are preserved for review; this adapter does not claim to implement them.' };
        if (result.delivery.status === 'pass') result.delivery = { ...result.delivery, status: 'pending_review', reasons: [...result.delivery.reasons, result.engineering.reason] };
      }
    } catch (error) {
      const reason = `${error.name}: ${error.message}`;
      result.actual_error = reason;
      if (error.evaluator_evidence) result.actual = error.evaluator_evidence;
      if (error.evaluator_evidence?.candidate_items) result.candidate_ranking = error.evaluator_evidence.candidate_items.map((value, rank) => ({ rank: rank + 1, ...value }));
      result.candidate = error.evaluator_evidence?.candidate_items ? judgeCandidate(item.expected?.candidate, error.evaluator_evidence.candidate_items) : item.expected?.candidate?.applicable === false ? { status: 'not_applicable', assertions: [], reasons: [] } : { status: 'fail', assertions: [{ name: 'production invocation completed', pass: false }], reasons: [reason] };
      result.delivery = item.expected?.delivery?.applicable === false ? { status: 'not_applicable', assertions: [], reasons: [] } : { status: 'fail', assertions: [{ name: 'production invocation completed', pass: false }], reasons: [reason] };
    }
    result.elapsed_ms = performance.now() - before;
    result.work_vault = vaultPath;
    results.push(result);
    process.stderr.write(`${key}: candidate=${result.candidate.status}, delivery=${result.delivery.status}\n`);
  }
  // Do not publish scores if the freeze changed during execution.
  await verifyDataset(datasetPath);
  const qualityResults = results.filter(result => !/^K/u.test(result.case_id));
  const scoresFor = device => Object.fromEntries(['candidate', 'delivery', 'answer'].map(layer => [layer, summarize(qualityResults.filter(result => result.device === device), layer)]));
  const scores = scoresFor('desktop-script');
  const run = {
    run_id: runId, started_at: startedAt, ended_at: new Date().toISOString(), phase: options.phase,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, device: 'desktop-script', model: '',
    evidence_level: 'script-production-functions-with-synthetic-storage', code,
    dataset: { path: datasetPath, version: manifest.dataset_version ?? manifest.version, scoring_rule_version: manifest.scoring_rule_version, content_sha256: digest.content_sha256, file_count: digest.file_count, fixed_date: manifest.fixed_date ?? manifest.fixed_today, timezone: manifest.timezone },
    configuration: { settings: manifest.settings ?? {}, prompt_boundary_enabled: promptBoundaryEnabled, execution_overrides: boundaryOverrides, selected_cases: selected ?? null, requested_case_ids: [...new Set(items.map(item => item.case_id))], total_dataset_case_ids: allCases.length, planned_result_rows_including_subcases: results.length, executed_content_checks: results.filter(result => result.actual || result.actual_error).length, work_root: workRoot, model_calls: 0, network_calls: 0 },
    adapter: adapter.metadata, scores, scores_by_device: Object.fromEntries([...new Set(qualityResults.map(result => result.device))].map(device => [device, scoresFor(device)])),
    not_run: results.filter(result => result.candidate.status === 'not_run' || result.delivery.status === 'not_run').map(result => ({ case_id: result.case_id, subcase_id: result.subcase_id, device: result.device, reason: result.candidate.reasons })),
    performance: { cold_p50_ms: null, cold_p95_ms: null, warm_p50_ms: null, warm_p95_ms: null, memory_peak_bytes: null, production_bundle_bytes: null, note: 'Per-case timings are diagnostic script samples, not native or large-vault performance. K cases were not run.' },
    limitations: ['No Provider/model, native Obsidian UI, iPhone or iPad invocation.', 'Pi host event registration and synthetic filesystem are adapters; production retrieval, recall and serialization are called unchanged.', 'Candidate scoring uses KnowledgeAgentIndex/PersonalMemoryRepository return order. Delivery scoring uses selected production preflight or serialized Recall context only.'],
    result_path: 'results.jsonl'
  };
  await mkdir(outputRun, { recursive: true });
  await writeFile(path.join(outputRun, 'results.jsonl'), `${results.map(result => JSON.stringify(result)).join('\n')}\n`, 'utf8');
  await writeFile(path.join(outputRun, 'run.json'), `${JSON.stringify(run, null, 2)}\n`, 'utf8');
  await rm(path.join(workRoot, 'production-adapter.mjs'), { force: true });
  await rm(path.join(workRoot, 'node_modules'), { force: true });
  return run;
}

function argumentsOf(argv) {
  const [command, ...args] = argv;
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    if (!args[index]?.startsWith('--') || !args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`Expected --name value near ${args[index]}`);
    const key = args[index].slice(2);
    if (Object.hasOwn(options, key)) throw new Error(`Duplicate option: ${key}`);
    options[key] = args[index + 1];
  }
  return { command, options };
}

async function main() {
  const { command, options } = argumentsOf(process.argv.slice(2));
  if (!command || command === 'help' || command === '--help') {
    console.log('node scripts/knowledge-recall-eval/cli.mjs freeze|verify --dataset PATH\nnode scripts/knowledge-recall-eval/cli.mjs run --dataset PATH --source-root CHECKOUT --output-run PATH --run-id ID --phase P0 [--cases A1,H2 | --all-cases true] [--prompt-boundary true] [--expected-commit SHA] [--retrieval-baseline-commit SHA]\nrun defaults to starter=true cases. --prompt-boundary true explicitly enables frozen I7; default execution flags remain unchanged. freeze is explicit and refuses to refreeze an existing digest. run verifies first; never writes to the dataset or appends CSV.');
    return;
  }
  if (!['freeze', 'verify', 'run'].includes(command)) throw new Error(`Unknown command: ${command}`);
  if (!options.dataset) throw new Error('--dataset is required');
  if (command === 'run') {
    for (const key of ['source-root', 'output-run', 'run-id', 'phase']) if (!options[key]) throw new Error(`--${key} is required`);
    const run = await runEvaluation(options);
    console.log(JSON.stringify({ run_id: run.run_id, candidate: run.scores.candidate.score, delivery: run.scores.delivery.score, answer: '', output: path.resolve(options['output-run']) }));
  } else {
    const result = await (command === 'freeze' ? freezeDataset : verifyDataset)(path.resolve(options.dataset));
    console.log(JSON.stringify({ command, dataset_version: result.manifest.dataset_version ?? result.manifest.version, content_sha256: result.digest.content_sha256, file_count: result.digest.file_count }));
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.env.PI_OFFLINE = '1';
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
