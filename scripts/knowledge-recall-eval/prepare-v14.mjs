// Synthetic lifecycle benchmark. v1.3 cases and expectations are copied verbatim.
import assert from 'node:assert/strict';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freezeDataset, readCases, verifyDataset } from './dataset.mjs';

const clock = '2026-11-03T12:00:00Z';
const create = (id, title, content, recallWhen, extra = {}) => ({
  id, at: clock, request: { operation: 'create', kind: 'fact', title, content, recallWhen, basis: 'explicit', ...extra }
});
const coffee = create('mem-v14-coffee', '咖啡饮用偏好', '我不喝咖啡，平时喝白水。', '询问饮品偏好、咖啡时');
const shell = create('mem-v14-shell', '终端默认环境', '我的终端默认使用 zsh。', '询问终端配置时');
const travel = create('mem-v14-travel', '旅行订房原则', '旅行订房先确认能免费取消。', '讨论旅行住宿时');
const allergy = { ...create('mem-v14-allergy', '青霉素过敏', '我对青霉素过敏。', '用药安全'), pinned: true };
const noise = [
  create('mem-v14-generic', '项目工作记录', '今天讨论项目计划和工作安排，明天继续整理项目资料。'.repeat(30), '讨论项目计划和工作时'),
  create('mem-v14-meeting', '日常会议安排', '今天会议讨论工作情况，明天查看计划，之后继续讨论。'.repeat(15), '讨论今天的工作安排时'),
  create('mem-v14-notes', '资料整理习惯', '资料、记录、情况、建议、安排、计划都需要定期检查。'.repeat(20), '询问记录和资料时')
];

// Each tuple declares an independent product expectation before any scoring run.
// Paraphrases without an association clue and pinned/faded behavior deliberately
// retain failures until their corresponding product capability exists.
export const MEMORY_CASES = [
  ['literal', '我喝咖啡吗？', [coffee, shell], { required_ids: [coffee.id] }],
  ['literal', '终端默认用什么？', [shell, travel], { required_ids: [shell.id] }],
  ['literal', '旅行订房有什么原则？', [travel, coffee], { required_ids: [travel.id] }],
  ['literal', '我对青霉素过敏吗？', [allergy, travel], { required_ids: [allergy.id] }],
  ['literal', '咖啡饮用偏好', [coffee, ...noise], { required_ids: [coffee.id] }],
  ['literal', 'zsh', [shell, coffee], { required_ids: [shell.id] }],
  ['paraphrase', '给我来杯拿铁行吗？', [coffee, travel], { required_ids: [coffee.id] }],
  ['paraphrase', '预订酒店要留意什么？', [travel, shell], { required_ids: [travel.id] }],
  ['paraphrase', '命令行打开后使用哪个解释器？', [shell, travel], { required_ids: [shell.id] }],
  ['paraphrase', '抗生素使用有什么禁忌？', [allergy, coffee], { required_ids: [allergy.id] }],
  ['core_no_overlap', '帮我做一份生日晚宴菜单', [allergy, shell], { required_ids: [allergy.id] }, { applicable: false }],
  ['core_no_overlap', '帮我安排周末的徒步路线', [allergy, coffee], { required_ids: [allergy.id] }, { applicable: false }],
  ['core_no_overlap', '评价一下这本侦探小说', [allergy, travel], { required_ids: [allergy.id] }, { applicable: false }],
  ['noise', '今天讨论一下北斗迁移项目的工作计划', [create('mem-v14-beidou', '北斗迁移项目', '北斗迁移必须先导出归档，再切换数据库。', '北斗迁移'), ...noise], { required_ids: ['mem-v14-beidou'], forbidden_ids: noise.map(r => r.id) }],
  ['noise', '帮我安排蓝鹭复诊的时间', [create('mem-v14-clinic', '蓝鹭复诊', '蓝鹭门诊复诊预约在周四下午。', '蓝鹭复诊'), ...noise], { required_ids: ['mem-v14-clinic'], forbidden_ids: noise.map(r => r.id) }],
  ['noise', '讨论一下琥珀许可证续费计划', [create('mem-v14-license', '琥珀许可证', '琥珀许可证续费应联系采购员。', '琥珀许可证'), ...noise], { required_ids: ['mem-v14-license'], forbidden_ids: noise.map(r => r.id) }],
  ['noise', '今天整理雪松相机的资料', [create('mem-v14-camera', '雪松相机', '雪松相机存放在二楼防潮柜。', '雪松相机'), ...noise], { required_ids: ['mem-v14-camera'], forbidden_ids: noise.map(r => r.id) }],
  ['noise', '给我一些关于星桥预算的建议', [create('mem-v14-budget', '星桥预算', '星桥预算上限为三千元。', '星桥预算'), ...noise], { required_ids: ['mem-v14-budget'], forbidden_ids: noise.map(r => r.id) }],
  ...[
    ['报销', 'task', '2026-11-01', true, 10],
    ['体检', 'task', '2026-11-20', false, 10],
    ['回访', 'open_loop', '2026-11-02T10:00:00Z', true, 10],
    ['签约', 'task', '2026-11-03T18:00:00Z', false, 10]
  ].map(([title, kind, due, overdue, daysAgo], index) => {
    const record = { ...create(`mem-v14-due-${index}`, `${title}截止`, `${title}尚未确认完成，请核对日期。`, `${title}`, { kind, due }), at: '2026-10-24T12:00:00Z' };
    return ['expiry', `${title}的截止日期是什么？`, [record, coffee], { required_ids: [record.id], identity: { due, overdue, daysAgo } }, { required_ids: [record.id] }];
  }),
  ...['工具', '通勤', '备份'].map((topic, index) => {
    const old = create(`mem-v14-old-${index}`, `${topic}旧约定`, `${topic}旧约定已经不再使用。`, `${topic}`);
    const replacement = { id: `mem-v14-new-${index}`, at: clock, request: { operation: 'supersede', targetId: old.id, title: `${topic}当前约定`, content: `${topic}现在按照新约定执行。`, recallWhen: topic, basis: 'explicit', reason: '用户明确更新' } };
    return ['superseded', `${topic}目前的约定是什么？`, [old, replacement], { required_ids: [replacement.id], forbidden_ids: [old.id] }];
  }),
  ...['投稿', '参展', '团购'].map((topic, index) => {
    const record = { ...create(`mem-v14-faded-${index}`, `${topic}跟进`, `${topic}活动暂时搁置，等待消息。`, `${topic}`, { kind: 'open_loop' }), at: '2026-04-01T12:00:00Z' };
    return ['faded', `${topic}有什么进展？`, [record, coffee], { forbidden_ids: [record.id] }, { required_ids: [record.id] }, { memory_activity: { version: 1, initializedAt: '2026-04-01T12:00:00Z', records: { [record.id]: { lastRecalledAt: Date.parse(record.at), recallCount: 0 } } } }];
  }),
  ['no_answer', '海王星的卫星有多少？', [coffee, shell, travel], { empty: true }],
  ['no_answer', '讨论一下明天的项目安排', noise, { empty: true }]
];
assert.equal(MEMORY_CASES.length, 30);

export async function prepareV14(source, target) {
  const { manifest: sourceManifest } = await verifyDataset(source);
  assert.equal(sourceManifest.dataset_version, 'kb-recall-v1.3');
  // mkdir is exclusive: never mutate an existing or frozen dataset.
  await mkdir(target);
  await cp(source, target, { recursive: true });
  const original = await readFile(path.join(source, 'cases.jsonl'), 'utf8');
  const cases = [];
  await mkdir(path.join(target, '记忆/v14'));
  for (const [index, [category, query, operations, delivery, candidate, state]] of MEMORY_CASES.entries()) {
    const case_id = `L${String(index + 1).padStart(2, '0')}`;
    const memory_seed = `记忆/v14/${case_id}.json`;
    await writeFile(path.join(target, memory_seed), JSON.stringify({ synthetic: true, clock, operations, ...state }, null, 2) + '\n');
    cases.push({ case_id, domain: 'memory', category, starter: false, partition: 'dev', fact_group: `v14-${case_id}`, query,
      setup: { memory_seed, fixed_now: category === 'expiry' ? '2026-10-24T12:00:00Z' : clock, advance_days: category === 'expiry' ? 10 : 0 },
      expected: { candidate: candidate ?? (delivery.empty ? { empty: true } : { required_ids: delivery.required_ids, forbidden_ids: delivery.forbidden_ids }), delivery } });
  }
  await writeFile(path.join(target, 'cases.jsonl'), original.trimEnd() + '\n' + cases.map(item => JSON.stringify(item)).join('\n') + '\n');
  const { content_sha256, ...manifest } = sourceManifest;
  await writeFile(path.join(target, 'manifest.json'), JSON.stringify({ ...manifest, dataset_version: 'kb-recall-v1.4', supersedes: 'kb-recall-v1.3', source_content_sha256: content_sha256,
    lifecycle_cases: cases.map(item => item.case_id), lifecycle_case_count: cases.length,
    active_case_ids: [...sourceManifest.active_case_ids, ...cases.map(item => item.case_id)],
    case_counts: { ...sourceManifest.case_counts, active: sourceManifest.case_counts.active + cases.length },
    partitions: { ...sourceManifest.partitions, dev: [...sourceManifest.partitions.dev, ...cases.map(item => item.case_id)] },
    version_changes: ['保留 v1.3 原用例和预期，新增 30 条中文记忆用例；核心和淡出为第三步前的能力缺口。'],
    synthetic_provenance: { all_content_synthetic: true, real_vault_accessed: false }, frozen_at: new Date().toISOString() }, null, 2) + '\n');
  const oldCases = await readCases(source);
  assert.deepEqual((await readCases(target)).slice(0, oldCases.length), oldCases);
  return await freezeDataset(target);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [source, target] = process.argv.slice(2);
  if (!source || !target) throw new Error('Usage: prepare-v14.mjs SOURCE_V13 NEW_TARGET');
  const result = await prepareV14(path.resolve(source), path.resolve(target));
  console.log(JSON.stringify({ dataset: target, digest: result.digest.content_sha256, cases: 30 }));
}
