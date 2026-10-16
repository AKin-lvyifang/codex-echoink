import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rm, symlink, access } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { freezeDataset, verifyDataset, canonicalJson } from './dataset.mjs';
import { judgeCandidate, judgeDelivery } from './judge.mjs';
import { runEvaluation, CSV_COLUMNS, csvRow } from './cli.mjs';

process.env.PI_OFFLINE = '1';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const temporary = path.join(os.homedir(), 'EchoInk-TestVaults/90-任务临时');
await mkdir(temporary, { recursive: true });
const fixture = await mkdtemp(path.join(temporary, '知识库-召回评测-selftest-'));
const dataset = path.join(fixture, 'dataset');
const runId = `selftest-${process.pid}-${Date.now()}`;
const work = path.join(temporary, `知识库-召回评测-${runId}`);
try {
  await mkdir(path.join(dataset, '笔记/wiki'), { recursive: true });
  await mkdir(path.join(dataset, '记忆'), { recursive: true });
  await writeFile(path.join(dataset, 'manifest.json'), JSON.stringify({ dataset_version: 'selftest', fixed_date: '2026-10-16T12:00:00+08:00', settings: {} }));
  await writeFile(path.join(dataset, '笔记/wiki/gold.md'), '# Golden fixture\nGOLD_TOKEN answer: preserve this exact sentence.\n');
  await writeFile(path.join(dataset, '记忆/seed.json'), JSON.stringify({
    operations: [
      { id: 'mem_eval_coffee', request: { operation: 'create', kind: 'fact', title: 'COFFEE_MEMORY_TOKEN', recallWhen: 'COFFEE_MEMORY_TOKEN', content: 'COFFEE_MEMORY_TOKEN I do not drink coffee.', basis: 'explicit' } },
      { id: 'mem_eval_old', request: { operation: 'create', kind: 'decision', title: 'HISTORY_MEMORY_TOKEN', recallWhen: 'HISTORY_MEMORY_TOKEN', content: 'HISTORY_MEMORY_TOKEN old Notion reason.', basis: 'explicit' } },
      { id: 'mem_eval_new', request: { operation: 'supersede', targetId: 'mem_eval_old', title: 'CURRENT_MEMORY_TOKEN', recallWhen: 'CURRENT_MEMORY_TOKEN', content: 'CURRENT_MEMORY_TOKEN now Obsidian.', basis: 'explicit', reason: 'Changed tool.' } }
    ], secondary_records: [{ schema: 'echoink.memory-secondary.v1', id: 'secondary_eval_tea', parentId: 'mem_eval_coffee', status: 'current', disabledReason: null, title: 'Possible tea preference', content: 'Maybe tea.', recallWhen: 'COFFEE_MEMORY_TOKEN', matchTerms: ['COFFEE_MEMORY_TOKEN'], relation: 'associated', reason: 'Synthetic inference.', supportLevel: 'weak_inference', evidence: 'Synthetic explicit statement only.', basis: 'llm_inferred', sourceMemoryRevision: 1, confidence: 0.70, hitCount: 0, lastHitAt: null, lastDecayAt: null, createdAt: 1792108800000, updatedAt: 1792108800000, revision: 1, file: 'secondary/secondary_eval_tea.md' }]
  }));
  const cases = [
    { case_id: 'A1', starter: true, query: 'GOLD_TOKEN', setup: { opened_paths: ['wiki/gold.md'], history: [{ role: 'user', content: 'Prior host hint' }], model_must_derive_date_range: true }, expected: { candidate: { required_paths: ['wiki/gold.md'], max_rank: 1 }, delivery: { required_paths: ['wiki/gold.md'], required_excerpts: ['preserve this exact sentence.'], required_fields: ['contentRevision', 'lineStart', 'lineEnd'] } } },
    { case_id: 'A3', starter: true, query: 'GOLD_TOKEN', expected: { candidate: { required_paths: ['missing.md'] }, delivery: { required_excerpts: ['THIS_IS_NOT_IN_THE_VAULT'] } } },
    { case_id: 'A4', starter: true, query: 'GOLD_TOKEN', setup: { settings_override: { search_journal: false } }, expected: { candidate: { required_paths: ['wiki/gold.md'] }, delivery: { required_paths: ['wiki/gold.md'] } } },
    { case_id: 'H1', starter: true, domain: 'memory', query: 'COFFEE_MEMORY_TOKEN', setup: { memory_seed: '记忆/seed.json' }, expected: { candidate: { required_ids: ['mem_eval_coffee'], required_secondary_ids: ['secondary_eval_tea'] }, delivery: { required_ids: ['mem_eval_coffee', 'secondary_eval_tea'], required_excerpts: ['I do not drink coffee.', 'Maybe tea.'], required_fields: ['basis'] } } },
    { case_id: 'H2', starter: true, domain: 'memory', query: 'split', setup: { memory_seed: '记忆/seed.json' }, subcases: [
      { subcase_id: 'current', query: 'CURRENT_MEMORY_TOKEN', expected: { candidate: { required_ids: ['mem_eval_new'], forbidden_ids: ['mem_eval_old'] }, delivery: { required_ids: ['mem_eval_new'], required_excerpts: ['now Obsidian.'] } } },
      { subcase_id: 'history', query: 'HISTORY_MEMORY_TOKEN', setup: { memory_search: { statuses: ['current', 'superseded'] } }, expected: { candidate: { required_ids: ['mem_eval_old'] }, delivery: { required_ids: ['mem_eval_old'], required_excerpts: ['old Notion reason.'] } } }
    ] },
    { case_id: 'I2', starter: true, query: 'CHANGED_TOKEN', setup: { mutations: [{ action: 'write', path: 'wiki/gold.md', content: '# Changed\nCHANGED_TOKEN latest sentence.\n' }] }, expected: { candidate: { required_paths: ['wiki/gold.md'] }, delivery: { required_excerpts: ['latest sentence.'] } } },
    { case_id: 'J1', starter: true, query: '', execution: { script: false, reason: 'Needs native iPhone and iPad.' } },
    { case_id: 'K1', starter: true, query: '', execution: { script: false, reason: 'Separate large-vault performance run.' } }
  ];
  await writeFile(path.join(dataset, 'cases.jsonl'), `${cases.map(item => JSON.stringify(item)).join('\n')}\n`);
  const frozen = await freezeDataset(dataset);
  assert.equal((await verifyDataset(dataset)).digest.content_sha256, frozen.digest.content_sha256);
  const original = await readFile(path.join(dataset, '笔记/wiki/gold.md'));
  await writeFile(path.join(dataset, '笔记/wiki/gold.md'), Buffer.concat([original, Buffer.from('tamper')]));
  await assert.rejects(verifyDataset(dataset), /digest mismatch/u);
  const invalidOutput = path.join(fixture, 'must-not-exist');
  await assert.rejects(runEvaluation({ dataset, 'source-root': root, 'output-run': invalidOutput, 'run-id': `${runId}-bad`, phase: 'selftest' }), /digest mismatch/u);
  await assert.rejects(access(invalidOutput));
  await writeFile(path.join(dataset, '笔记/wiki/gold.md'), original);
  await writeFile(path.join(dataset, 'unexpected.txt'), 'extra file');
  await assert.rejects(verifyDataset(dataset), /digest mismatch/u);
  await rm(path.join(dataset, 'unexpected.txt'));
  await symlink(path.join(dataset, '笔记/wiki/gold.md'), path.join(dataset, 'link.md'));
  await assert.rejects(verifyDataset(dataset), /symlink rejected/u);
  await rm(path.join(dataset, 'link.md'));
  const manifest = JSON.parse(await readFile(path.join(dataset, 'manifest.json'), 'utf8'));
  await writeFile(path.join(dataset, 'manifest.json'), JSON.stringify({ ...manifest, settings: { changed: true } }));
  await assert.rejects(verifyDataset(dataset), /digest mismatch/u);
  await writeFile(path.join(dataset, 'manifest.json'), canonicalJson(manifest));
  await verifyDataset(dataset);
  const outputAlias = path.join(fixture, 'output-alias');
  await symlink(dataset, outputAlias, 'dir');
  await assert.rejects(runEvaluation({ dataset, 'source-root': root, 'output-run': path.join(outputAlias, 'must-not-exist'), 'run-id': `${runId}-symlink`, phase: 'selftest' }), /symlink rejected/u);
  await assert.rejects(access(path.join(dataset, 'must-not-exist')));
  await rm(outputAlias);

  assert.equal(judgeCandidate({ required_paths: ['a'], max_rank: 1 }, [{ vaultRelativePath: 'b' }, { vaultRelativePath: 'a' }]).status, 'fail');
  assert.equal(judgeDelivery({ required_excerpts: ['evidence'] }, [{ excerpt: 'other' }], 'wrapper evidence').status, 'fail');
  const output = path.join(fixture, 'run');
  const run = await runEvaluation({ dataset, 'source-root': root, 'output-run': output, 'run-id': runId, phase: 'selftest' });
  const results = (await readFile(path.join(output, 'results.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  const byId = Object.fromEntries(results.map(item => [item.case_id, item]));
  assert.equal(byId.A1.candidate.status, 'pass');
  assert.equal(byId.A1.delivery.status, 'pass', JSON.stringify({ verdict: byId.A1.delivery, delivered: byId.A1.actual.delivery_items, text: byId.A1.actual.provider_text }));
  assert.equal(judgeDelivery({ empty: true, forbidden_excerpts: ['行程里不显示住址'] }, [], '行程里不显示住址').status, 'fail');
  assert.equal(judgeDelivery({ empty: true, forbidden_excerpts: ['我支持量子计算'] }, [], '我支持量子计算').status, 'fail');
  const actualGold = byId.A1.actual.delivery_items[0];
  const goldRule = cases[0].expected.delivery;
  assert.equal(judgeDelivery(goldRule, [{ ...actualGold, contentRevision: 'bogus', lineStart: 'bogus', lineEnd: 'bogus' }], actualGold.excerpt).status, 'fail');
  assert.equal(judgeDelivery(goldRule, [actualGold], actualGold.excerpt).status, 'fail', 'Bare excerpt must not stand in for serialized source identity');
  assert.equal(judgeDelivery(goldRule, [actualGold], byId.A1.actual.provider_text.replace(`版本：${actualGold.contentRevision}`, '版本：bogus')).status, 'fail');
  assert.equal(judgeDelivery({ identity_assertions: [{ id: 'not-delivered', required_fields: ['basis'] }] }, [], '').status, 'fail');
  assert.equal(byId.A3.candidate.status, 'fail');
  assert.equal(byId.A3.delivery.status, 'fail');
  assert.equal(byId.A4.candidate.status, 'blocked', 'Unperformed host configuration must not count as product failure');
  assert.equal(byId.A4.delivery.status, 'blocked');
  assert.equal(byId.A1.actual.effective_configuration.opened_paths_applied, false);
  assert.equal(byId.A1.actual.effective_configuration.retrieval_request.includeUnrefined, false);
  assert.equal(byId.H1.candidate.status, 'pass', JSON.stringify({ verdict: byId.H1.candidate, raw: byId.H1.actual.raw.repository_search, delivered: byId.H1.actual.delivery_items }));
  assert.equal(byId.H1.delivery.status, 'fail', 'Real recall currently drops basis; evaluator must expose this');
  assert.ok(byId.H1.actual.delivery_items.length > 0, 'Memory delivery must come from production serialization');
  assert.ok(byId.H1.actual.delivery_items.some(item => item.id === 'secondary_eval_tea'), 'Dream must be delivered by real matching and production secondary serialization');
  assert.equal(results.find(item => item.case_id === 'H2' && item.subcase_id === 'current').delivery.status, 'pass');
  assert.equal(results.find(item => item.case_id === 'H2' && item.subcase_id === 'history').candidate.status, 'pass');
  assert.equal(results.find(item => item.case_id === 'H2' && item.subcase_id === 'history').delivery.status, 'fail');
  assert.equal(byId.I2.candidate.status, 'pass');
  assert.equal(byId.I2.delivery.status, 'pass');
  assert.equal(byId.J1.candidate.status, 'not_run');
  assert.equal(byId.K1.candidate.status, 'not_run');
  assert.equal(run.scores.candidate.score, '5/6');
  assert.equal(run.scores.delivery.score, '3/6');
  assert.equal(run.scores.answer.score, '');
  assert.equal(run.device, 'desktop-script');
  assert.equal(run.model, '');
  assert.equal(CSV_COLUMNS.join(','), 'run_id,started_at,phase,git_commit,dataset_version,device,model,candidate,delivery,answer,record_path,notes');
  assert.equal(csvRow(run, 'run.json').match(/","/gu).length, 11);
  assert.ok(byId.A1.actual.calls.some(item => item.function === 'createProductionPiKnowledgeRuntime.retrieveChat'));
  assert.ok(byId.A1.actual.calls.some(item => item.function === 'KnowledgeRetriever.retrieve'));
  assert.ok(byId.H1.actual.calls.some(item => item.function === 'PersonalMemoryRecallHarness.prepareTurnContext'));
  assert.ok(run.adapter.imported_files.some(item => item.path === 'src/plugin/pi-production-runtime-composition.ts'));
  console.log('PASS: positive/negative freeze, extra-file and symlink rejection, no output after mismatch, actual production retrieval/Recall serialization, golden pass/fail, output/12-column format.');
} finally {
  await rm(fixture, { recursive: true, force: true });
  await rm(work, { recursive: true, force: true });
}
