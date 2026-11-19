import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { disposableTestRoot } from '../disposable-test-root.mjs';
import { buildAdapter } from './cli.mjs';
import { freezeDataset, verifyDataset } from './dataset.mjs';
import { collectKnowledgePick, scoreKnowledgePick, scorePickCase, summarizePickMetrics } from './knowledge-pick.mjs';

process.env.PI_OFFLINE = '1';
const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const runId = `pick-selftest-${process.pid}-${Date.now()}`;
const fixture = path.join(disposableTestRoot(path.join(os.homedir(), 'EchoInk-TestVaults/90-任务临时')), `知识库-挑笔记自测-${runId}`);
const dataset = path.join(fixture, 'dataset');
const collection = path.join(fixture, 'collect');
const output = path.join(fixture, 'score');
const lines = async file => (await readFile(file, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
const serialize = values => `${values.map(value => JSON.stringify(value)).join('\n')}\n`;

// Pure scoring controls: absent required sources retain their denominator;
// alternatives form explicit any-of groups; A-only notes must be labeled.
const controlCase = { case_id: 'CONTROL', pick_gold: { required_paths: ['wiki/missing.md'], required_groups: [['wiki/a.md', 'wiki/b.md']], distractor_paths: ['wiki/no.md'], should_read_zero: false } };
const controlRow = { caseId: 'CONTROL', split: 'dev', question: 'control', recent: [], candidates: [
  { note: { id: 'n0', title: 'a', excerpt: 'a' }, hit: { vaultRelativePath: 'wiki/a.md' } },
  { note: { id: 'n1', title: 'no', excerpt: 'no' }, hit: { vaultRelativePath: 'wiki/no.md' } }
], baselineA: { references: [{ vaultRelativePath: 'wiki/a-only.md' }, { vaultRelativePath: 'wiki/a-only.md' }] } };
const controlLabels = { notes: [
  { path: 'wiki/a.md', useful: true, reason: 'one accepted alternative' },
  { path: 'wiki/no.md', useful: false, reason: 'lexical distractor' },
  { path: 'wiki/a-only.md', useful: true, reason: 'A delivered a useful source absent from candidates' }
] };
const control = scorePickCase(controlCase, controlRow, controlLabels);
assert.deepEqual(control.audit.missingRequiredPaths, ['wiki/missing.md']);
assert.deepEqual(control.exported.gold.requiredIds, []);
assert.equal(control.exported.gold.requiredCount, 1);
assert.equal(control.exported.gold.missingRequiredCount, 1);
assert.deepEqual(control.exported.gold.requiredGroups, [['n0']]);
assert.deepEqual(summarizePickMetrics([control.metrics.C3]).requiredCoverageMicro, { numerator: 1, denominator: 2, ratio: 0.5 });
assert.deepEqual(summarizePickMetrics([control.metrics.C3]).selectedUsefulMicro, { numerator: 1, denominator: 2, ratio: 0.5 });
assert.equal(control.metrics.A.selectedCount, 1, 'A references are deduplicated by note for metrics');
assert.equal(control.metrics.C3.positiveAllRequired, false);
assert.throws(() => scorePickCase(controlCase, controlRow, { notes: controlLabels.notes.slice(0, 2) }), /Missing usefulness label/u);
assert.throws(() => scorePickCase(controlCase, controlRow, { notes: [{ ...controlLabels.notes[0], reason: '' }, ...controlLabels.notes.slice(1)] }), /incomplete usefulness/u);
assert.throws(() => scorePickCase({ ...controlCase, pick_gold: { ...controlCase.pick_gold, should_read_zero: true } }, controlRow, controlLabels), /Zero-read gold/u);
const missingGroup = scorePickCase({ ...controlCase, pick_gold: { ...controlCase.pick_gold, required_groups: [['wiki/b.md', 'wiki/c.md']] } }, controlRow, controlLabels);
assert.deepEqual(missingGroup.exported.gold.requiredGroups, [[]]);
assert.equal(missingGroup.audit.requiredGroups[0].candidateCovered, false);
assert.equal(missingGroup.metrics.candidate25.requiredTotal, 2);

try {
  await mkdir(path.join(dataset, '笔记/wiki'), { recursive: true });
  await writeFile(path.join(dataset, 'manifest.json'), JSON.stringify({ dataset_version: 'synthetic-pick-selftest', settings: {} }));
  for (let index = 0; index < 8; index++) await writeFile(path.join(dataset, `笔记/wiki/note-${String(index).padStart(2, '0')}.md`), `# Fixture ${index}\nPICK_EVAL_TOKEN directly supported synthetic statement ${index}.\n`);
  await writeFile(path.join(dataset, '笔记/wiki/unmatched.md'), '# Nonmatching note\nAn independent synthetic source with unrelated wording.\n');
  const cases = [
    { case_id: 'POS', partition: 'dev', query: 'PICK_EVAL_TOKEN', recent: ['Synthetic previous user sentence.'], pick_gold: { required_paths: ['wiki/note-00.md', 'wiki/unmatched.md'], required_groups: [['wiki/note-01.md', 'wiki/note-02.md']], distractor_paths: [], should_read_zero: false } },
    { case_id: 'ZERO', partition: 'holdout', query: 'PICK_EVAL_TOKEN', pick_gold: { required_paths: [], distractor_paths: [], should_read_zero: true } }
  ];
  await writeFile(path.join(dataset, 'cases.jsonl'), serialize(cases));
  const frozen = await freezeDataset(dataset);
  // This regression exercises today's local fallback, whose composition also
  // owns smart selection now. Real exports retain the pinned dc068a25 guard.
  const collected = await collectKnowledgePick({ dataset, 'baseline-commit': 'HEAD', 'source-root': sourceRoot, 'output-run': collection, 'run-id': runId });
  assert.equal(collected.dataset.cases, 2);
  assert.equal(collected.configuration.modelCalls, 0);
  const rows = await lines(path.join(collection, 'raw-cases.jsonl'));
  assert.equal(rows[0].candidates.length, 8);
  assert.equal(rows[0].baselineA.references.length, 6, 'A must retain the real ordinary-chat six-span limit');
  assert.equal(rows[0].baselineA.receivedReferenceCount, rows[0].baselineA.references.length);
  assert.equal(JSON.parse(rows[0].baselineA.providerResourceText).sources[0].excerpt, rows[0].baselineA.references[0].excerpt);
  assert.ok(rows[0].calls.some(call => call.function === 'createProductionPiKnowledgeRuntime.retrieveChat'));
  assert.ok(!rows[0].calls.some(call => call.function === 'KnowledgeRetriever.retrieve'), 'Generic retrieve is not the A result');
  const labels = (await lines(path.join(collection, 'labels-template.jsonl'))).map(row => ({ caseId: row.caseId, notes: row.notes.map(note => ({ path: note.path, useful: row.caseId !== 'ZERO', reason: row.caseId === 'ZERO' ? 'Synthetic negative control; no personal source should be read.' : 'Synthetic affirmative source.' })) }));
  const labelsFile = path.join(fixture, 'labels.jsonl');
  await writeFile(labelsFile, serialize(labels));
  const report = await scoreKnowledgePick({ dataset, collection, labels: labelsFile, 'output-run': output });
  assert.equal(report.splits.all.A.cases, 2);
  assert.equal(report.splits.dev.candidate25.requiredCoverageMicro.denominator, 3, 'Two singleton mandatory paths plus one any-of group');
  assert.equal(report.splits.dev.candidate25.requiredCoverageMicro.numerator, 2, 'The absent required note remains a miss');
  assert.equal(report.splits.holdout.C3.negativeZeroSelection.ratio, 0);
  assert.equal(report.splits.dev.C3.averageSelected, 3);
  assert.equal(report.methods.A.layer, 'final_delivery');
  assert.equal(report.methods.C6.layer, 'selection');
  const dev = (await lines(path.join(output, 'candidates-dev.jsonl')))[0];
  assert.equal(dev.gold.requiredCount, 2);
  assert.equal(dev.gold.missingRequiredCount, 1);
  assert.deepEqual(Object.keys(dev), ['caseId', 'split', 'question', 'recent', 'notes', 'gold']);
  assert.ok(dev.notes.every(note => Object.keys(note).join(',') === 'id,title,excerpt'));
  assert.ok(!JSON.stringify(dev.notes).includes('wiki/'), 'Path mapping must not enter the decision-model notes');
  const audit = (await lines(path.join(output, 'audit.jsonl')))[0];
  assert.deepEqual(audit.missingRequiredPaths, ['wiki/unmatched.md']);
  assert.equal((await verifyDataset(dataset)).digest.content_sha256, frozen.digest.content_sha256);
  await assert.rejects(collectKnowledgePick({ dataset, 'baseline-commit': 'HEAD', 'source-root': sourceRoot, 'output-run': collection, 'run-id': `${runId}-overwrite` }), /Refusing to overwrite/u);
  await assert.rejects(scoreKnowledgePick({ dataset, collection, labels: labelsFile, 'output-run': path.join(dataset, 'bad-output') }), /separate/u);
  // The historical adapter entry still builds. Current composition imports the
  // collector, but calls without a judgment continue to execute local limit:6.
  const legacyWork = path.join(fixture, 'legacy-adapter');
  await mkdir(legacyWork);
  const legacy = await buildAdapter(sourceRoot, legacyWork);
  assert.equal(typeof legacy.evaluate, 'function');
  console.log('PASS: knowledge-pick local collect/score; current limit-6 fallback, C selection layers, full missing-source/group denominators, labels and split exports, historical adapter interface.');
} finally { await rm(fixture, { recursive: true, force: true }); }
