import assert from 'node:assert/strict';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { canonicalJson, readCases, verifyDataset } from './dataset.mjs';

export const SOURCE_SHA256 = 'eae763745d800a96b47ac9e66ca222a734ce7890e6a2ec7d2df8341e682d14c2';
const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const commonDir = execFileSync('git', ['-C', workspace, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' }).trim();
export const PRIVATE_ROOT = path.join(path.dirname(commonDir), 'docs/测试集/知识库召回');
export const SOURCE_ROOT = path.join(PRIVATE_ROOT, '数据集/kb-recall-v1.2');
export const TARGET_ROOT = path.join(PRIVATE_ROOT, '数据集/kb-recall-v1.3');
export const RULE_VERSION = 'kb-recall-mechanical-v3';
export const RUBRIC_VERSION = 'kb-recall-rubric-v3';
export const PREVIEW_ROOT = path.join(workspace, '.tmp/v13-prepare-20261017/script-ready');
const clone = value => structuredClone(value);

export const NEW_NOTES = [
  { path: 'wiki/会后联络约定.md', fact_group: 'v13-qinghe-followup', partition: 'dev', content: '---\ntags: [青禾回访]\naliases: [QH-followup]\n---\n# 会后联络约定\n\n会后先发邮件确认对方要解决的问题，收到回复再约十五分钟通话。\n' },
  { path: 'wiki/会后点心安排.md', fact_group: 'v13-qinghe-followup', partition: 'dev', content: '---\ntags: [茶歇]\n---\n# 会后点心安排\n\n小组会结束后到茶水间取饼干，餐具放回推车。\n' },
  { path: 'projects/晨岚/待办卡.md', fact_group: 'v13-active-note-chenlan', partition: 'dev', content: '# 晨岚待办卡\n\n下一步先把蓝色样品寄给林岚，等她确认尺寸后再做包装。\n' },
  { path: 'projects/暮桥/待办卡.md', fact_group: 'v13-active-note-chenlan', partition: 'dev', content: '# 暮桥待办卡\n\n下一步先预约场地，再请韩禾确认座位数量。\n' }
];

export function h4Rules(source) {
  const item = clone(source);
  delete item.expected.candidate.empty;
  delete item.expected.delivery.empty;
  item.expected.candidate.forbidden_excerpts = [...new Set([...(item.expected.candidate.forbidden_excerpts ?? []), '小灰盒'])];
  item.expected.candidate.forbidden_ids = [...new Set([...(item.expected.candidate.forbidden_ids ?? []), 'mem-camera-forgotten'])];
  item.expected.delivery.forbidden_ids = [...new Set([...(item.expected.delivery.forbidden_ids ?? []), 'mem-camera-forgotten'])];
  item.expected.delivery.forbidden_excerpts = [...new Set([...(item.expected.delivery.forbidden_excerpts ?? []), '小灰盒'])];
  return item;
}

export function buildFiveCases(cases) {
  const byId = new Map(cases.map(item => [item.case_id, item]));
  function derive(sourceId, caseId, query, history, purpose, extraCriteria) {
    const source = byId.get(sourceId);
    assert(source, `Missing source ${sourceId}`);
    assert.equal(source.partition, 'dev', 'A development paraphrase must retain its source partition');
    const item = clone(source);
    item.case_id = caseId;
    item.query = query;
    item.batch = 'two';
    item.starter = false;
    item.rubric_version = RUBRIC_VERSION;
    item.derived_from = sourceId;
    item.evaluation_focus = purpose;
    item.observations = [...new Set([...(item.observations ?? []), 'search_call_count', 'extra_query_tokens'])];
    item.expected.answer.criteria.push(...extraCriteria);
    if (history) item.setup.history = history;
    // Execute the current query even when an API cannot consume history.
    // Native answers separately seed the complete user/assistant session.
    if (history) item.execution = { script: true, reason: '实际当前问题运行生产预检；Memory前文传recentConversation，Knowledge未消费历史如实记录；真实回答另验。' };
    if (item.process_checks) item.process_checks = item.process_checks.map(check => ({ ...check, case_id: caseId }));
    return item;
  }
  const result = [
    derive('B2', 'M1', '换个话题，EchoInk 当初为什么放弃方案 A？', [
      { role: 'user', content: '我下个月想去德清旅行，留一天走莫干山，交通还没定。' },
      { role: 'assistant', content: '这趟德清旅行先留一天徒步；具体交通等查过路线再定。' }
    ], '多轮①旅行转产品：明确新问题不受旅行前文污染', ['说明每次开卡片要联网及离线无法看已有内容；不能把旅行路线当方案取舍依据。']),
    derive('H3', 'M2', '它的截止时间呢？', [
      { role: 'user', content: '先看 EchoInk 候选版的安排，具体日期还没查。' },
      { role: 'assistant', content: '接下来围绕 EchoInk 候选版；涉及日期时再查记录。' }
    ], '多轮②EchoInk转它的截止时间：消解项目指代', ['“它”对应 EchoInk；回答候选版截止日期并保留记忆身份，不能混入潮汐日期。']),
    derive('H3', 'M3', '那潮汐呢？', [
      { role: 'user', content: '先讨论 EchoInk 的截止安排，日期待查。' },
      { role: 'assistant', content: '这轮先讨论 EchoInk 的截止安排，需要日期时再查记录。' }
    ], '多轮③A项目转B项目：EchoInk转潮汐截止安排', ['跟随当前问题转到潮汐，明确是内测截止时间2026-12-18；不能沿用EchoInk候选版日期。'])
  ];
  result[0].distractors.push('wiki/莫干山徒步路线.md');
  for (const item of result.slice(1)) {
    item.source_domain = item.domain;
    item.domain = 'memory'; // Existing adapter dispatches by this exact value.
  }
  const tide = result[2];
  tide.evidence = [{ memory_id: 'mem-deadline-tide', text: '潮汐内测截止时间是 2026-12-18', project: '潮汐', state: 'current' }];
  tide.distractors = ['memory:mem-deadline-echoink'];
  tide.expected.candidate.required_ids = ['mem-deadline-tide'];
  tide.expected.candidate.forbidden_ids = ['mem-deadline-echoink'];
  tide.expected.delivery.required_ids = ['mem-deadline-tide'];
  tide.expected.delivery.required_excerpts = ['潮汐内测截止时间是 2026-12-18'];
  tide.expected.delivery.forbidden_excerpts = ['EchoInk 候选版截止时间是 2026-11-02'];
  tide.expected.delivery.identity_assertions[0].id = 'mem-deadline-tide';
  // EchoInk is the existing host project from history, not a gold-fed Tide scope.
  tide.setup.project = 'EchoInk';
  function independent(id, factGroup, query, setup, evidence, distractors, focus, criteria, executable) {
    return { case_id: id, starter: false, batch: 'two', partition: 'dev', domain: 'obsidian_hints', fact_group: factGroup, query,
      synthetic_provenance: 'v1.3独立合成事实；未复用D2/D4或其他留出材料',
      setup: { isolation: 'fresh_dataset_copy_per_case_or_subcase', ...setup }, evidence, distractors,
      acceptable_alternatives: [], allow_no_answer: false, layer_applicability: { candidate: true, delivery: true, answer: true },
      expected: { candidate: { required_paths: evidence.map(entry => entry.path), max_rank: 3 },
        delivery: { required_paths: evidence.map(entry => entry.path), required_excerpts: evidence.map(entry => entry.text), required_fields: ['vaultRelativePath', 'contentRevision', 'lineStart', 'lineEnd', 'sourceType'] },
        answer: { mode: 'manual', applicable: true, criteria } },
      rubric_version: RUBRIC_VERSION, evaluation_focus: focus,
      execution: { script: true, reason: executable ? '实际生产预检。' : '合成host真实设置active_path/opened_paths，调用实际生产预检；不替产品消解指代。' } };
  }
  const tag = independent('C5', 'v13-qinghe-followup', '青禾回访这类笔记里，默认先做什么？', { query_terms_only_in_tags: ['青禾回访'] },
    [{ path: NEW_NOTES[0].path, kind: 'wiki', line_start: 7, line_end: 7, text: '会后先发邮件确认对方要解决的问题，收到回复再约十五分钟通话。' }],
    [NEW_NOTES[1].path], '开发题2.1：仅标签命中时保留首段证据', ['准确回答先发邮件确认问题、收到回复再约十五分钟通话；标签只负责定位，答案必须来自首段正文。'], true);
  tag.process_checks = [{ case_id: 'C5', phase: 'P2', requirement: '当匹配仅来自标签青禾回访时，实际候选excerpt应包含首段正文；现有候选机械规则只查排名，片段用实际输出另验，不能以候选命中冒充片段通过。' }];
  const current = independent('C6', 'v13-active-note-chenlan', '当前这篇里，下一步安排是什么？',
    { active_path: NEW_NOTES[2].path, opened_paths: [NEW_NOTES[3].path, NEW_NOTES[2].path] },
    [{ path: NEW_NOTES[2].path, kind: 'projects', line_start: 3, line_end: 3, text: '下一步先把蓝色样品寄给林岚，等她确认尺寸后再做包装。' }],
    [NEW_NOTES[3].path], '开发题2.2：当前/最近打开笔记指代', ['根据真实当前晨岚待办卡回答寄样品及确认尺寸后做包装；不能沿用先前打开暮桥的预约场地安排。'], false);
  current.expected.delivery.forbidden_excerpts = ['下一步先预约场地，再请韩禾确认座位数量。'];
  result.push(tag, current);
  validateFiveCases(result, cases);
  return result;
}

export function validateFiveCases(items, sourceCases) {
  assert.equal(items.length, 5);
  assert.equal(items.filter(item => item.setup.history).length, 3);
  const existing = new Set(sourceCases.map(item => item.case_id));
  const groups = new Map();
  for (const item of sourceCases) {
    const partitions = groups.get(item.fact_group) ?? new Set();
    partitions.add(item.partition);
    groups.set(item.fact_group, partitions);
  }
  for (const item of items) {
    assert(!existing.has(item.case_id), `Duplicate case ${item.case_id}`);
    existing.add(item.case_id);
    const source = sourceCases.find(value => value.case_id === item.derived_from);
    if (source) {
      for (const field of ['fact_group', 'partition']) assert.equal(item[field], source[field], `${item.case_id}.${field} changed`);
      assert.equal(item.source_domain ?? item.domain, source.domain);
      assert.deepEqual([...groups.get(item.fact_group)], [item.partition], `Cross-partition fact group ${item.fact_group}`);
    } else {
      assert(!groups.has(item.fact_group), 'New synthetic fact group must be independent');
      assert(NEW_NOTES.some(note => note.fact_group === item.fact_group && note.partition === item.partition));
    }
    if (!item.setup.history) continue;
    assert.deepEqual(item.setup.history.map(turn => turn.role), ['user', 'assistant']);
    assert(item.setup.history.every(turn => typeof turn.content === 'string' && turn.content.trim()));
    const history = item.setup.history.map(turn => turn.content).join('\n');
    const gold = [...(item.evidence ?? []).map(entry => entry.text), ...(item.expected.delivery.required_excerpts ?? [])].filter(Boolean);
    for (const excerpt of gold) assert(!history.includes(excerpt), `Gold leaked into ${item.case_id} history`);
  }
}

export function buildRubric(source) {
  const rubric = clone(source);
  rubric.version = RUBRIC_VERSION;
  rubric.mechanical_version = RULE_VERSION;
  rubric.supersedes = source.version;
  // Approval and historical regrades belong to the v2 archive, not this draft.
  delete rubric.approved_by;
  delete rubric.effective_date;
  delete rubric.historical_regrade;
  rubric.status = 'draft_pending_preview_review';
  rubric.future_dataset = 'kb-recall-v1.3';
  rubric.changes = [
    'H4取消候选和交付必须为空，只禁止已忘记ID mem-camera-forgotten及昵称小灰盒；无关的合法候选或交付不扣分。',
    '候选层新增通用forbidden_excerpts，逐项检查实际候选的字符串字段及嵌套二级事实；未声明该规则的用例判分保持不变。',
    '新增M1旅行转产品、M2项目指代、M3项目切换三条冻结user+assistant历史的多轮题；M2/M3使用memory领域进入现有记忆适配路径。',
    'C5/C6为标签命中首段与当前笔记指代两道独立开发题；新增四篇合成笔记，独立事实组全在dev，不复用D2/D4留出材料。',
    'H2/history历史原文和身份断言全部保留；第二批提示收益单列观察，不能替代任何旧断言。'
  ];
  rubric.candidate_forbidden_excerpts = { matching: 'exact_substring', source: 'actual_candidate_string_fields_recursively', includes: 'title, summary, excerpt, content, recallWhen, sourceSummary and nested secondary facts when present', absent_declaration: 'identical_legacy_assertions_and_verdict', no_gold_backfill: true };
  rubric.prompt_benefit_observations = { scored: false, case_ids: ['H2/history', 'M1', 'M2', 'M3'], fields: ['explicit_history_or_project_hint_used', 'model_query', 'search_call_count', 'extra_query_tokens'], preserves_existing_assertions: true, note: '提示是否帮助定位单列记录；身份、原文、当前/历史判分继续执行。' };
  return rubric;
}

export async function loadPreparation() {
  const verified = await verifyDataset(SOURCE_ROOT);
  assert.equal(verified.digest.content_sha256, SOURCE_SHA256, 'v1.2 baseline changed');
  const cases = await readCases(SOURCE_ROOT);
  const added = buildFiveCases(cases);
  const sourceRubric = JSON.parse(await readFile(path.join(SOURCE_ROOT, verified.manifest.rubric_file), 'utf8'));
  const rubric = buildRubric(sourceRubric);
  const diff = {
    source_dataset: 'kb-recall-v1.2', source_sha256: SOURCE_SHA256,
    target_dataset: 'kb-recall-v1.3', status: 'preview_not_frozen',
    scoring_rule_version: RULE_VERSION, rubric_version: RUBRIC_VERSION,
    source_case_count: cases.length, target_case_count: cases.length + added.length,
    note_files_changed: [], note_files_added: NEW_NOTES.map(note => ({ path: note.path, fact_group: note.fact_group, partition: note.partition })), memory_seed_changed: false,
    changed_cases: { H4: { removed: ['expected.candidate.empty', 'expected.delivery.empty'], added: ['expected.candidate.forbidden_excerpts: 小灰盒', 'expected.delivery.forbidden_ids: mem-camera-forgotten'] } },
    added_cases: added.map(item => ({ case_id: item.case_id, derived_from: item.derived_from ?? null, domain: item.domain, source_domain: item.source_domain ?? null, fact_group: item.fact_group, partition: item.partition, evaluation_focus: item.evaluation_focus })),
    infrastructure_gaps: [
      'production-adapter.ts仅识别domain=memory或H题号；M2/M3显式使用memory，未修改适配器。',
      'M1-M3/C6全部执行实际当前问题预检。Memory完整前文传生产recentConversation；Knowledge没有历史参数，标记未消费；current/opened仅通过公开host接口。',
      'C5候选机械规则仅验证排名；标签命中候选excerpt首段内容保留process_checks，须核对实际输出，尚未验证。',
      'dataset.mjs支持mechanical-v1/v2/v3；SHA算法不变，冻结后原生与脚本均先verify。'
    ],
    retained: ['H2/history原文断言', 'H2/history身份断言', '其余旧用例机械断言', '全部既有事实文件和记忆输入字节'],
    approval: '五题预览待主控复核；此脚本不执行freeze。'
  };
  return { verified, cases, added, rubric, diff };
}

export function readablePreview(items, diff) {
  const sections = items.map(item => [
    `## ${item.case_id}：${item.evaluation_focus}`,
    `${item.derived_from ? `沿用 ${item.derived_from}` : '新增独立合成事实'}；领域 ${item.domain}，事实组 ${item.fact_group}，分区 ${item.partition}。`,
    item.setup.history ? `冻结前文：\n\n${item.setup.history.map(turn => `- ${turn.role}: ${turn.content}`).join('\n')}` : '前文：无。',
    `当前问：${item.query}`,
    `宿主前置状态：${JSON.stringify(item.setup)}。`,
    `金标准证据：\n\n${item.evidence.map(entry => `- ${entry.path ?? entry.memory_id}${entry.heading ? ` / ${entry.heading}` : ''}: ${entry.text}`).join('\n')}`,
    `干扰来源：${item.distractors.join('、') || '无新增干扰'}。`,
    `允许替代证据：${JSON.stringify(item.acceptable_alternatives)}。`,
    `候选/交付断言：\n\n\`\`\`json\n${JSON.stringify({ candidate: item.expected.candidate, delivery: item.expected.delivery }, null, 2)}\n\`\`\``,
    `回答要求：\n\n${item.expected.answer.criteria.map(value => `- ${value}`).join('\n')}`,
    ...(item.process_checks ? [`过程检查（独立记录）：\n\n${item.process_checks.map(check => `- ${check.requirement}`).join('\n')}`] : []),
    `执行边界：${item.execution.script ? '可做离线候选/交付检查；真实回答另验。' : item.execution.reason}`
  ].join('\n\n'));
  return `# v1.3 五题预览（修订稿，未冻结）\n\n保留 v1.2 的73篇合成笔记和记忆输入，新增四篇独立合成笔记；49条活动题扩为54条。三条多轮题在 setup.history 冻结完整角色和内容，前文不预先给出本题答案。C5/C6未复用D2/D4留出材料。\n\n${sections.join('\n\n')}\n\n## 旧规则与版本差异\n\nH4允许无关合法候选和交付，但已忘记ID或“小灰盒”出现仍失败。H2/history的原文和身份断言继续逐项执行；提示收益单独记录。\n\n## 基建缺口\n\n${diff.infrastructure_gaps.map(value => `- ${value}`).join('\n')}\n\nv1.2 摘要：${diff.source_sha256}。当前只是预览，尚未运行候选、交付或真实回答，也没有冻结v1.3。\n`;
}

export async function writePreview(prepared) {
  await mkdir(PREVIEW_ROOT, { recursive: true });
  for (const [name, value] of Object.entries({ 'five-cases.json': prepared.added, 'synthetic-notes.json': NEW_NOTES, 'dataset-diff.json': prepared.diff, 'kb-recall-rubric-v3.json': prepared.rubric, 'h4-rules.json': h4Rules(prepared.cases.find(item => item.case_id === 'H4')) })) {
    await writeFile(path.join(PREVIEW_ROOT, name), `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
  }
  await writeFile(path.join(PREVIEW_ROOT, 'five-cases-preview.md'), readablePreview(prepared.added, prepared.diff), { flag: 'wx' });
  for (const note of NEW_NOTES) {
    const target = path.join(PREVIEW_ROOT, '新增笔记', note.path);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, note.content, { flag: 'wx' });
  }
  assert.equal((await verifyDataset(SOURCE_ROOT)).digest.content_sha256, SOURCE_SHA256);
  return { preview_root: PREVIEW_ROOT, case_ids: prepared.added.map(item => item.case_id), source_sha256: SOURCE_SHA256, frozen: false };
}

// Explicit preparation creates a fresh private draft; it never freezes or
// overwrites a prior v1.3. Native evaluation must still pass verifyDataset.
export async function prepareDraft(prepared) {
  await mkdir(TARGET_ROOT);
  await cp(SOURCE_ROOT, TARGET_ROOT, { recursive: true, errorOnExist: true, force: false });
  const manifest = clone(prepared.verified.manifest);
  delete manifest.content_sha256;
  delete manifest.frozen_at;
  manifest.dataset_version = 'kb-recall-v1.3';
  manifest.supersedes = 'kb-recall-v1.2';
  manifest.source_content_sha256 = SOURCE_SHA256;
  manifest.rubric_version = RUBRIC_VERSION;
  manifest.scoring_rule_version = RULE_VERSION;
  manifest.status = 'draft_pending_preview_review';
  manifest.frozen = false;
  manifest.note_count += NEW_NOTES.length;
  manifest.max_note_count_after_B11_setup += NEW_NOTES.length;
  manifest.v13_synthetic_fact_groups = [...new Set(NEW_NOTES.map(note => note.fact_group))].map(fact_group => ({ fact_group, domain: 'obsidian_hints', partition: 'dev', source_paths: NEW_NOTES.filter(note => note.fact_group === fact_group).map(note => note.path) }));
  manifest.case_counts.active += prepared.added.length;
  manifest.active_case_ids.push(...prepared.added.map(item => item.case_id));
  for (const item of prepared.added) manifest.partitions[item.partition].push(item.case_id);
  manifest.version_changes = [...prepared.rubric.changes];
  manifest.schema_notes.candidate_forbidden_excerpts = '实际候选字符串字段及嵌套事实精确子串；只按声明检查，不用金标准补正文。';
  const cases = buildV13Cases(prepared.cases);
  const historyBefore = prepared.cases.find(item => item.case_id === 'H2').subcases.find(item => item.subcase_id === 'history');
  const historyAfter = cases.find(item => item.case_id === 'H2').subcases.find(item => item.subcase_id === 'history');
  assert.equal(canonicalJson(historyAfter), canonicalJson(historyBefore));
  await writeFile(path.join(TARGET_ROOT, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(path.join(TARGET_ROOT, 'cases.jsonl'), `${[...cases, ...prepared.added].map(item => JSON.stringify(item)).join('\n')}\n`);
  await writeFile(path.join(TARGET_ROOT, manifest.rubric_file), `${JSON.stringify(prepared.rubric, null, 2)}\n`);
  await writeFile(path.join(TARGET_ROOT, 'v1.3-dataset-diff.json'), `${JSON.stringify(prepared.diff, null, 2)}\n`, { flag: 'wx' });
  for (const note of NEW_NOTES) {
    const target = path.join(TARGET_ROOT, manifest.note_root, note.path);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, note.content, { flag: 'wx' });
  }
  const privateRubric = path.join(PRIVATE_ROOT, '评分规则/kb-recall-rubric-v3.json');
  await writeFile(privateRubric, `${JSON.stringify(prepared.rubric, null, 2)}\n`, { flag: 'wx' });
  assert.equal((await verifyDataset(SOURCE_ROOT)).digest.content_sha256, SOURCE_SHA256);
  return { dataset_root: TARGET_ROOT, status: manifest.status, frozen: false, source_sha256: SOURCE_SHA256 };
}

export function buildV13Cases(sourceCases) {
  return sourceCases.map(source => ({ ...(source.case_id === 'H4' ? h4Rules(source) : clone(source)), rubric_version: RUBRIC_VERSION }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  assert(args.length <= 1 && (!args.length || ['--preview', '--prepare-draft'].includes(args[0])), 'Usage: node prepare-v13.mjs [--preview|--prepare-draft] (never freezes)');
  const prepared = await loadPreparation();
  const result = args[0] === '--prepare-draft' ? await prepareDraft(prepared) : await writePreview(prepared);
  console.log(JSON.stringify(result, null, 2));
}
