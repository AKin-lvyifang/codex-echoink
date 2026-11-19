#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFile, lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { disposableTestRoot } from '../disposable-test-root.mjs';
import { buildAdapter } from './cli.mjs';
import { canonicalJson, readCases, relativeFile, verifyDataset } from './dataset.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const BASELINE = 'dc068a25';
const VERSION = 'knowledge-pick-local-v1';
const json = value => `${JSON.stringify(value, null, 2)}\n`;
const jsonl = values => values.length ? `${values.map(value => JSON.stringify(value)).join('\n')}\n` : '';
const unique = values => [...new Set(values)];
const sha256 = text => createHash('sha256').update(text).digest('hex');
const git = (root, args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).trim();
const contains = (root, child) => { const relative = path.relative(root, child); return relative === '' || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); };

async function ensureNew(directory) {
  try { await lstat(directory); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  throw new Error(`Refusing to overwrite existing directory: ${directory}`);
}
async function rejectSymlinks(directory) {
  let cursor = path.resolve(directory);
  while (true) {
    try { if ((await lstat(cursor)).isSymbolicLink()) throw new Error(`Output/work symlink rejected: ${cursor}`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const parent = path.dirname(cursor);
    if (cursor === parent) return;
    cursor = parent;
  }
}
async function createNew(directory) {
  await rejectSymlinks(directory);
  await mkdir(path.dirname(directory), { recursive: true });
  await mkdir(directory);
}
function separateOutput(output, inputs) {
  for (const input of inputs) if (contains(input, output) || contains(output, input)) throw new Error('Output must be separate from dataset and collection');
}
async function readJsonl(file) {
  return (await readFile(file, 'utf8')).split(/\r?\n/u).filter(line => line.trim()).map(line => JSON.parse(line));
}
function validateCases(items) {
  for (const item of items) {
    if (!['dev', 'holdout'].includes(item.partition)) throw new Error(`Invalid partition: ${item.case_id}`);
    if (typeof item.query !== 'string' || !item.query.trim()) throw new Error(`Missing query: ${item.case_id}`);
    if (item.subcases?.length) throw new Error(`Flatten subcases into independent case_id values before freezing: ${item.case_id}`);
    const recent = item.recent ?? [];
    if (!Array.isArray(recent) || recent.length > 3 || recent.some(value => typeof value !== 'string' || [...value].length > 500)) throw new Error(`Invalid recent: ${item.case_id}`);
    if ([...item.query].length > 2000) throw new Error(`Query exceeds decision API limit: ${item.case_id}`);
  }
}

export async function collectKnowledgePick(options) {
  const datasetPath = path.resolve(options.dataset);
  const { manifest, digest } = await verifyDataset(datasetPath);
  const items = await readCases(datasetPath);
  validateCases(items);
  const sourceRoot = path.resolve(options['source-root']);
  const output = path.resolve(options['output-run']);
  const runId = options['run-id'];
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/u.test(runId ?? '')) throw new Error('Invalid run-id');
  separateOutput(output, [datasetPath]);
  const workRoot = path.join(disposableTestRoot(path.join(os.homedir(), 'EchoInk-TestVaults/90-任务临时')), `知识库-挑笔记评测-${runId}`);
  if ([datasetPath, output].some(input => contains(input, workRoot) || contains(workRoot, input))) throw new Error('Dataset, output and work directory must be separate');
  const baselineCommit = git(sourceRoot, ['rev-parse', options['baseline-commit'] ?? BASELINE]);
  const baselineFiles = ['src/plugin/pi-production-runtime-composition.ts', 'src/knowledge-base/query.ts'];
  if (git(sourceRoot, ['diff', baselineCommit, '--', ...baselineFiles])) throw new Error('Ordinary-chat baseline implementation differs from the requested baseline commit');
  const code = { gitCommit: git(sourceRoot, ['rev-parse', 'HEAD']), baselineCommit,
    baselineFiles, baselineMatches: true, worktreeStatus: git(sourceRoot, ['status', '--porcelain']), sourceDiff: git(sourceRoot, ['diff', 'HEAD', '--', 'src']) };
  await ensureNew(output);
  await ensureNew(workRoot);
  await rejectSymlinks(output);
  await createNew(workRoot);
  const startedAt = new Date().toISOString();
  try {
    const adapter = await buildAdapter(sourceRoot, workRoot, { entryPoint: 'knowledge-pick-adapter.ts', exportName: 'evaluateKnowledgePick', fixtureWindowTimers: true });
    const noteDirectory = manifest.notes_dir ?? '笔记';
    const prefix = `${noteDirectory}/`;
    const files = digest.entries.filter(entry => entry.path.startsWith(prefix));
    if (!files.length) throw new Error('Frozen dataset has no note files');
    const rows = [], mappings = [], templates = [];
    for (const [index, item] of items.entries()) {
      const caseRoot = path.join(workRoot, `case-${String(index + 1).padStart(3, '0')}`);
      const vaultPath = path.join(caseRoot, 'vault');
      await mkdir(vaultPath, { recursive: true });
      for (const entry of files) {
        const target = relativeFile(vaultPath, entry.path.slice(prefix.length));
        await mkdir(path.dirname(target), { recursive: true });
        await copyFile(relativeFile(datasetPath, entry.path), target);
      }
      const actual = await adapter.evaluate({ vaultPath, statePath: path.join(caseRoot, 'index'), manifest, item, runId });
      const ids = new Set(), paths = new Set();
      for (const candidate of actual.candidates) {
        const { note, hit } = candidate;
        if (typeof note?.id !== 'string' || !note.id || ids.has(note.id) || typeof note.title !== 'string' || typeof note.excerpt !== 'string') throw new Error(`Invalid/duplicate candidate id: ${item.case_id}`);
        if ([...note.title].length > 120 || [...note.excerpt].length > 200) throw new Error(`Candidate exceeds fixed 120/200 character budget: ${item.case_id}`);
        relativeFile(vaultPath, hit.vaultRelativePath);
        if (paths.has(hit.vaultRelativePath)) throw new Error(`Candidate paths were not deduplicated: ${item.case_id}`);
        ids.add(note.id); paths.add(hit.vaultRelativePath);
      }
      if (actual.candidates.length > 25) throw new Error(`Candidate count exceeds fixed 25-note budget: ${item.case_id}`);
      const row = { caseId: item.case_id, split: item.partition, question: item.query, recent: item.recent ?? [], ...actual };
      rows.push(row);
      const union = unique([...paths, ...actual.baselineA.receivedPaths]);
      mappings.push({ caseId: item.case_id, notes: actual.candidates.map(({ note, hit }) => ({ id: note.id, path: hit.vaultRelativePath, datasetFile: `${prefix}${hit.vaultRelativePath}` })), baselineAPaths: actual.baselineA.receivedPaths });
      templates.push({ caseId: item.case_id, notes: union.map(relative => {
        const candidate = actual.candidates.find(value => value.hit.vaultRelativePath === relative);
        const reference = actual.baselineA.references.find(value => value.vaultRelativePath === relative);
        return { path: relative, id: candidate?.note.id ?? null, datasetFile: `${prefix}${relative}`, source: candidate && reference ? 'candidate+baselineA' : candidate ? 'candidate' : 'baselineA', title: candidate?.note.title ?? reference.title, excerpt: candidate?.note.excerpt ?? reference.excerpt, useful: null, reason: '' };
      }) });
      process.stderr.write(`${item.case_id}: candidates=${actual.candidates.length}; A received=${actual.baselineA.receivedReferenceCount} refs/${actual.baselineA.receivedNoteCount} notes\n`);
    }
    await verifyDataset(datasetPath);
    // Do not silently combine a bundle with source changes made during collection.
    for (const file of adapter.metadata.imported_files) {
      const absolute = file.path.startsWith('evaluator/') ? path.join(here, file.path.slice('evaluator/'.length)) : path.join(sourceRoot, file.path);
      if (sha256(await readFile(absolute)) !== file.sha256) throw new Error(`Source changed during collect: ${file.path}`);
    }
    const rawText = jsonl(rows), mapText = json({ schemaVersion: VERSION, datasetPath, cases: mappings });
    const run = { schemaVersion: VERSION, command: 'collect', runId, startedAt, endedAt: new Date().toISOString(),
      dataset: { path: datasetPath, version: manifest.dataset_version ?? manifest.version, contentSha256: digest.content_sha256, cases: items.length },
      code, adapter: adapter.metadata, configuration: { maxCandidates: 25, excerptCharacters: 200, maxScannedHits: 250, maxPages: 50, candidateTimeBudgetMs: 600, modelCalls: 0, networkCalls: 0, perCaseVaultCopies: true },
      artifacts: { 'raw-cases.jsonl': sha256(rawText), 'local-path-map.json': sha256(mapText) },
      limitations: ['Synthetic Vault host; no native Obsidian, Provider, decision API or model call.', 'A is actual ordinary retrieveChat final delivery after the existing reference/text budget. Recent context is exported but does not alter local retrieval.', 'Candidate and A path mapping, raw hits and provider text are local audit artifacts; only notes and question/recent form the decision-model input.'] };
    await createNew(output);
    await writeFile(path.join(output, 'raw-cases.jsonl'), rawText);
    await writeFile(path.join(output, 'local-path-map.json'), mapText);
    await writeFile(path.join(output, 'labels-template.jsonl'), jsonl(templates));
    await writeFile(path.join(output, 'run.json'), json(run));
    return run;
  } finally { await rm(workRoot, { recursive: true, force: true }); }
}

function pathList(value, name) {
  if (!Array.isArray(value) || value.some(relative => typeof relative !== 'string')) throw new Error(`Invalid ${name}`);
  for (const relative of value) relativeFile('/synthetic-path-validation', relative);
  if (new Set(value).size !== value.length) throw new Error(`Duplicate path in ${name}`);
  return value;
}
export function normalizePickGold(item, label) {
  const gold = label.gold ?? label.pick_gold ?? item.pick_gold;
  if (!gold || typeof gold.should_read_zero !== 'boolean') throw new Error(`Missing explicit pick_gold/should_read_zero: ${item.case_id}`);
  const requiredPaths = pathList(gold.required_paths ?? [], 'required_paths');
  const usefulPaths = pathList(gold.useful_paths ?? [], 'useful_paths');
  const distractorPaths = pathList(gold.distractor_paths ?? [], 'distractor_paths');
  const groups = gold.required_groups ?? [];
  if (!Array.isArray(groups)) throw new Error('Invalid required_groups');
  const requiredGroups = groups.map(group => {
    const paths = pathList(group, 'required_groups entry');
    if (!paths.length) throw new Error('Empty required_groups entry');
    return paths;
  });
  if (new Set(requiredGroups.map(group => canonicalJson([...group].sort()))).size !== requiredGroups.length) throw new Error('Duplicate required group');
  if (gold.should_read_zero && (requiredPaths.length || requiredGroups.length || usefulPaths.length)) throw new Error(`Zero-read gold includes useful/required sources: ${item.case_id}`);
  if (distractorPaths.some(relative => requiredPaths.includes(relative) || requiredGroups.some(group => group.includes(relative)) || usefulPaths.includes(relative))) throw new Error(`Gold marks a source both useful/required and distractor: ${item.case_id}`);
  return { requiredPaths, requiredGroups, usefulPaths, distractorPaths, shouldReadZero: gold.should_read_zero };
}

export function scorePickCase(item, row, label) {
  const gold = normalizePickGold(item, label);
  if (!Array.isArray(label.notes)) throw new Error(`Missing notes labels: ${item.case_id}`);
  const labels = new Map();
  for (const note of label.notes) {
    relativeFile('/synthetic-path-validation', note.path);
    if (labels.has(note.path) || typeof note.useful !== 'boolean' || typeof note.reason !== 'string' || !note.reason.trim()) throw new Error(`Duplicate/incomplete usefulness label: ${item.case_id}/${note.path}`);
    labels.set(note.path, note);
  }
  const candidates = row.candidates;
  const candidatePaths = candidates.map(candidate => candidate.hit.vaultRelativePath);
  const aPaths = unique(row.baselineA.references.map(reference => reference.vaultRelativePath));
  const union = unique([...candidatePaths, ...aPaths]);
  for (const relative of union) if (!labels.has(relative)) throw new Error(`Missing usefulness label: ${item.case_id}/${relative}`);
  for (const [relative, note] of labels) {
    if (gold.shouldReadZero && note.useful) throw new Error(`Zero-read case has useful label: ${item.case_id}/${relative}`);
    if ((gold.requiredPaths.includes(relative) || gold.requiredGroups.some(group => group.includes(relative)) || gold.usefulPaths.includes(relative)) && !note.useful) throw new Error(`Required/useful path labeled useless: ${item.case_id}/${relative}`);
    if (gold.distractorPaths.includes(relative) && note.useful) throw new Error(`Distractor labeled useful: ${item.case_id}/${relative}`);
  }
  const idByPath = new Map(candidates.map(candidate => [candidate.hit.vaultRelativePath, candidate.note.id]));
  if (idByPath.size !== candidates.length || new Set(candidates.map(candidate => candidate.note.id)).size !== candidates.length) throw new Error(`Duplicate candidate path/id: ${item.case_id}`);
  const ids = paths => paths.flatMap(relative => idByPath.has(relative) ? [idByPath.get(relative)] : []);
  const exported = {
    caseId: row.caseId, split: row.split, question: row.question, recent: row.recent ?? [],
    notes: candidates.map(({ note }) => ({ id: note.id, title: note.title, excerpt: note.excerpt })),
    gold: {
      usefulIds: candidates.filter(candidate => labels.get(candidate.hit.vaultRelativePath).useful).map(candidate => candidate.note.id),
      requiredIds: ids(gold.requiredPaths),
      requiredCount: gold.requiredPaths.length,
      missingRequiredCount: gold.requiredPaths.filter(relative => !idByPath.has(relative)).length,
      distractorIds: ids(gold.distractorPaths), shouldReadZero: gold.shouldReadZero,
      ...(gold.requiredGroups.length ? { requiredGroups: gold.requiredGroups.map(ids) } : {})
    }
  };
  const audit = {
    caseId: row.caseId, split: row.split, gold,
    missingRequiredPaths: gold.requiredPaths.filter(relative => !idByPath.has(relative)),
    requiredGroups: gold.requiredGroups.map(paths => ({ paths, candidateIds: ids(paths), missingPaths: paths.filter(relative => !idByPath.has(relative)), candidateCovered: paths.some(relative => idByPath.has(relative)) })),
    baselineAOnlyPaths: aPaths.filter(relative => !idByPath.has(relative)),
    labelCount: labels.size, candidateCount: candidates.length,
    labels: [...labels.values()],
    // Metrics use complete path gold, never the shorter exported requiredIds.
    denominator: { requiredPaths: gold.requiredPaths.length, requiredGroups: gold.requiredGroups.length, requirementUnits: gold.requiredPaths.length + gold.requiredGroups.length }
  };
  const evaluate = selected => {
    const paths = unique(selected), selectedSet = new Set(paths);
    const hitPaths = gold.requiredPaths.filter(relative => selectedSet.has(relative)).length;
    const hitGroups = gold.requiredGroups.filter(group => group.some(relative => selectedSet.has(relative))).length;
    const requirementTotal = gold.requiredPaths.length + gold.requiredGroups.length;
    const useful = paths.filter(relative => labels.get(relative)?.useful === true).length;
    const directGoldHit = hitPaths + hitGroups > 0;
    return { selectedCount: paths.length, usefulCount: useful, requiredHit: hitPaths + hitGroups, requiredTotal: requirementTotal,
      requiredPathHit: hitPaths, requiredPathTotal: gold.requiredPaths.length, requiredGroupHit: hitGroups, requiredGroupTotal: gold.requiredGroups.length,
      positive: !gold.shouldReadZero, positiveHit: requirementTotal ? directGoldHit : useful > 0,
      positiveAllRequired: requirementTotal ? hitPaths + hitGroups === requirementTotal : null,
      shouldReadZero: gold.shouldReadZero, zeroSelected: paths.length === 0 };
  };
  return { exported, audit, metrics: {
    candidate25: evaluate(candidatePaths), A: evaluate(aPaths), C3: evaluate(candidatePaths.slice(0, 3)), C6: evaluate(candidatePaths.slice(0, 6))
  } };
}

const fraction = (numerator, denominator) => ({ numerator, denominator, ratio: denominator ? numerator / denominator : null });
export function summarizePickMetrics(values) {
  const sum = key => values.reduce((total, value) => total + value[key], 0);
  const positives = values.filter(value => value.positive), requiredPositives = positives.filter(value => value.requiredTotal > 0), negatives = values.filter(value => value.shouldReadZero);
  return {
    cases: values.length, positiveCases: positives.length, negativeCases: negatives.length,
    // An any-of group contributes one requirement unit. Individual mandatory
    // paths are also reported separately so this denominator is transparent.
    requiredCoverageMicro: fraction(sum('requiredHit'), sum('requiredTotal')),
    requiredPathCoverageMicro: fraction(sum('requiredPathHit'), sum('requiredPathTotal')),
    requiredGroupCoverageMicro: fraction(sum('requiredGroupHit'), sum('requiredGroupTotal')),
    positiveAtLeastOne: fraction(positives.filter(value => value.positiveHit).length, positives.length),
    positiveAllRequired: fraction(requiredPositives.filter(value => value.positiveAllRequired).length, requiredPositives.length),
    selectedUsefulMicro: fraction(sum('usefulCount'), sum('selectedCount')),
    negativeZeroSelection: fraction(negatives.filter(value => value.zeroSelected).length, negatives.length),
    averageSelected: values.length ? sum('selectedCount') / values.length : null,
    selectedCount: sum('selectedCount'), usefulCount: sum('usefulCount')
  };
}

export async function scoreKnowledgePick(options) {
  const datasetPath = path.resolve(options.dataset), collection = path.resolve(options.collection), output = path.resolve(options['output-run']);
  separateOutput(output, [datasetPath, collection]);
  await ensureNew(output);
  await rejectSymlinks(output);
  const { manifest, digest } = await verifyDataset(datasetPath);
  const items = await readCases(datasetPath);
  validateCases(items);
  const run = JSON.parse(await readFile(path.join(collection, 'run.json'), 'utf8'));
  if (run.schemaVersion !== VERSION || run.command !== 'collect' || run.dataset.contentSha256 !== digest.content_sha256) throw new Error('Collection does not match frozen dataset/version');
  for (const [name, hash] of Object.entries(run.artifacts)) if (sha256(await readFile(relativeFile(collection, name))) !== hash) throw new Error(`Collection artifact changed: ${name}`);
  const rows = await readJsonl(path.join(collection, 'raw-cases.jsonl'));
  const labelsText = await readFile(path.resolve(options.labels), 'utf8');
  const labels = labelsText.split(/\r?\n/u).filter(line => line.trim()).map(line => JSON.parse(line));
  const byId = (values, key) => {
    const map = new Map(values.map(value => [value[key], value]));
    if (map.size !== values.length || map.has(undefined)) throw new Error(`Missing/duplicate ${key}`);
    return map;
  };
  const rowsById = byId(rows, 'caseId'), labelsById = byId(labels, 'caseId');
  if (rows.length !== items.length || labels.length !== items.length) throw new Error('Collection and labels must cover every frozen case exactly once');
  const scores = items.map(item => {
    const row = rowsById.get(item.case_id), label = labelsById.get(item.case_id);
    if (!row || !label || row.question !== item.query || row.split !== item.partition || canonicalJson(row.recent) !== canonicalJson(item.recent ?? [])) throw new Error(`Case input mismatch: ${item.case_id}`);
    return scorePickCase(item, row, label);
  });
  const baselines = {
    schemaVersion: VERSION, dataset: { version: manifest.dataset_version ?? manifest.version, contentSha256: digest.content_sha256 },
    collection: { path: collection, runId: run.runId, rawSha256: run.artifacts['raw-cases.jsonl'] }, labelsSha256: sha256(labelsText),
    methods: {
      candidate25: { layer: 'candidate', description: 'All deduplicated local candidate notes, before selection or reference building.' },
      A: { layer: 'final_delivery', description: 'Actual production ordinary retrieveChat final references, deduplicated by path; source/provider text retained in raw-cases.jsonl.' },
      C3: { layer: 'selection', description: 'First 3 deduplicated candidate notes, no reference builder or final body-budget pass.' },
      C6: { layer: 'selection', description: 'First 6 deduplicated candidate notes, no reference builder or final body-budget pass.' }
    },
    metricDefinitions: {
      requiredCoverageMicro: 'Mandatory paths plus any-of groups; each mandatory path/group is one requirement unit, including those absent from candidates.',
      positiveAtLeastOne: 'At least one required source/group hit on positive cases; if no mandatory sources were specified, at least one selected useful note.',
      positiveAllRequired: 'All mandatory paths and any-of groups hit; positive cases without requirements excluded.',
      selectedUsefulMicro: 'Total useful selected unique notes / total selected unique notes; all selected candidate+A union notes require explicit usefulness labels with reasons.',
      negativeZeroSelection: 'Zero selected notes on should_read_zero cases. /turn was not run and cannot receive credit.'
    },
    splits: Object.fromEntries(['dev', 'holdout', 'all'].map(split => [split, Object.fromEntries(['candidate25', 'A', 'C3', 'C6'].map(method => [method, summarizePickMetrics(scores.filter(score => split === 'all' || score.exported.split === split).map(score => score.metrics[method]))]))])),
    limitations: ['No B/model/API inference in this round. Holdout metrics here are local A/C baselines, not a B threshold validation.', 'C3/C6 are selection-layer metrics only; they have not passed final original-text delivery budgets and cannot establish final-delivery acceptance.', 'Exported gold ID arrays only contain available candidates. The local audit retains every missing path/group; all metrics are computed from complete path gold.']
  };
  await verifyDataset(datasetPath);
  await createNew(output);
  for (const split of ['dev', 'holdout']) await writeFile(path.join(output, `candidates-${split}.jsonl`), jsonl(scores.filter(score => score.exported.split === split).map(score => score.exported)));
  await writeFile(path.join(output, 'audit.jsonl'), jsonl(scores.map(score => ({ ...score.audit, metrics: score.metrics }))));
  await writeFile(path.join(output, 'baselines.json'), json(baselines));
  return baselines;
}

async function main() {
  const [command, ...args] = process.argv.slice(2), options = {};
  if (!command || ['help', '--help'].includes(command)) {
    console.log('node scripts/knowledge-recall-eval/knowledge-pick.mjs collect --dataset PATH --source-root CHECKOUT --output-run NEW_PATH --run-id ID [--baseline-commit dc068a25]\nnode scripts/knowledge-recall-eval/knowledge-pick.mjs score --dataset PATH --collection COLLECT_PATH --labels LABELS.jsonl --output-run NEW_PATH\nLabels: one {caseId,notes:[{path,useful:boolean,reason:string}],gold?:pick_gold} per case. Label every candidate+A path; gold is score-only. Never send local audit/path mapping or gold to the decision API.');
    return;
  }
  for (let index = 0; index < args.length; index += 2) {
    if (!args[index]?.startsWith('--') || !args[index + 1] || args[index + 1].startsWith('--') || Object.hasOwn(options, args[index].slice(2))) throw new Error(`Expected unique --name value near ${args[index]}`);
    options[args[index].slice(2)] = args[index + 1];
  }
  if (!['collect', 'score'].includes(command)) throw new Error(`Unknown command: ${command}`);
  for (const key of ['dataset', 'output-run', ...(command === 'collect' ? ['source-root', 'run-id'] : ['collection', 'labels'])]) if (!options[key]) throw new Error(`--${key} is required`);
  const result = await (command === 'collect' ? collectKnowledgePick : scoreKnowledgePick)(options);
  console.log(JSON.stringify({ command, output: path.resolve(options['output-run']), cases: command === 'collect' ? result.dataset.cases : result.splits.all.A.cases }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.env.PI_OFFLINE = '1';
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
