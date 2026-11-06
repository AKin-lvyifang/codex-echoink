// Supplemental frozen cases: the accepted v1.4 dataset stays byte-for-byte intact.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { freezeDataset, verifyDataset } from './dataset.mjs';

const [source, target] = process.argv.slice(2);
if (!source || !target) throw new Error('Usage: prepare-v14-time.mjs FROZEN_V14 NEW_TARGET');
const parent = await verifyDataset(path.resolve(source));
await mkdir(path.resolve(target));
await mkdir(path.join(target, '记忆'));
const now = '2026-11-03T12:00:00Z';
const seedRecord = (id, kind, title, at, extra = {}) => ({ id, at,
  request: { operation: 'create', kind, title, content: `${title}，需要核对现有记录。`, recallWhen: title, basis: 'explicit', ...extra } });
const future = seedRecord('mem_time_future', 'task', '长期待办', '2025-11-03T12:00:00Z', { due: '2027-12-31' });
const unresolved = seedRecord('mem_time_unresolved', 'open_loop', '长期未决', '2025-11-03T12:00:00Z');
const first = ['fact', 'view', 'decision', 'goal', 'episode', 'open_loop', 'task'].map((kind, index) => seedRecord(`mem_time_first_${index}`, kind, `首次启用检查 ${index}`, '2020-01-01T12:00:00Z'));
const cases = [
  { case_id: 'T01', category: 'future_task', query: '长期待办有什么进展？', operations: [future], activity: true,
    expected: { candidate: { required_ids: [future.id] }, delivery: { required_ids: [future.id] } } },
  { case_id: 'T02', category: 'long_open_loop', query: '长期未决有什么进展？', operations: [unresolved], activity: true,
    expected: { candidate: { required_ids: [unresolved.id] }, delivery: { empty: true } } },
  { case_id: 'T03', category: 'first_enable', query: '首次启用检查', operations: first,
    expected: { candidate: { required_ids: first.map(record => record.id), max_rank: 10 }, delivery: { required_ids: first.map(record => record.id) } } }
];
for (const item of cases) {
  const records = Object.fromEntries(item.operations.map(record => [record.id, { lastRecalledAt: Date.parse(record.at), recallCount: 0 }]));
  await writeFile(path.join(target, `记忆/${item.case_id}.json`), JSON.stringify({ clock: now, synthetic: true, operations: item.operations,
    ...(item.activity ? { memory_activity: { version: 1, initializedAt: '2025-11-03T12:00:00Z', records } } : {}) }, null, 2) + '\n');
}
await writeFile(path.join(target, 'cases.jsonl'), cases.map(({ operations, activity, ...item }) => JSON.stringify({ ...item,
  domain: 'memory', starter: true, partition: 'dev', setup: { fixed_now: now, memory_seed: `记忆/${item.case_id}.json`, memory_token_budget: 5000 } })).join('\n') + '\n');
await writeFile(path.join(target, 'manifest.json'), JSON.stringify({ dataset_version: 'kb-recall-v1.4-time', scoring_rule_version: 'kb-recall-mechanical-v3',
  parent_dataset: 'kb-recall-v1.4', parent_content_sha256: parent.digest.content_sha256, fixed_date: now, settings: {},
  synthetic_provenance: { all_content_synthetic: true, real_vault_accessed: false }, case_counts: { active: 3 }, frozen_at: new Date().toISOString() }, null, 2) + '\n');
const frozen = await freezeDataset(path.resolve(target));
console.log(JSON.stringify({ dataset: path.resolve(target), cases: 3, content_sha256: frozen.digest.content_sha256 }));
