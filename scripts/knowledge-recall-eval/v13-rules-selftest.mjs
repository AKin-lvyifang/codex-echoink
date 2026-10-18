import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { judgeCandidate, judgeDelivery } from './judge.mjs';
import { canonicalJson, verifyDataset } from './dataset.mjs';
import { SOURCE_ROOT, SOURCE_SHA256, NEW_NOTES, h4Rules, loadPreparation, buildV13Cases } from './prepare-v13.mjs';

const baseline = '0269358a8b8e11c13e7b3041b63ad2424b3e8a73';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const prepared = await loadPreparation();
const sourceH4 = prepared.cases.find(item => item.case_id === 'H4');
const h4 = h4Rules(sourceH4);
assert.equal(h4.expected.candidate.empty, undefined);
assert.equal(h4.expected.delivery.empty, undefined);
const unrelated = [{ id: 'mem-unrelated-allowed', title: '整理习惯', summary: '每周整理一次资料。' }];
function delivery(items) {
  return judgeDelivery(h4.expected.delivery, items, JSON.stringify({ sources: items }));
}
assert.equal(judgeCandidate(h4.expected.candidate, []).status, 'pass');
assert.equal(delivery([]).status, 'pass');
assert.equal(judgeCandidate(h4.expected.candidate, unrelated).status, 'pass');
assert.equal(delivery(unrelated).status, 'pass');
const forgotten = [{ id: 'mem-camera-forgotten', summary: '不含昵称的旧相机记录' }];
assert.equal(judgeCandidate(h4.expected.candidate, forgotten).status, 'fail');
assert.equal(delivery(forgotten).status, 'fail');
for (const field of ['title', 'summary', 'excerpt', 'content', 'recallWhen', 'sourceSummary']) {
  const leak = [{ ...unrelated[0], [field]: '旧相机叫小灰盒。' }];
  const verdict = judgeCandidate(h4.expected.candidate, leak);
  assert.equal(verdict.status, 'fail', `Nickname must fail in actual ${field}`);
  assert(verdict.assertions.some(item => !item.pass && item.actual.some?.(hit => hit.field === field)));
  assert.equal(delivery(leak).status, 'fail', `Delivered nickname must fail in ${field}`);
}
const secondaryLeak = [{ ...unrelated[0], secondaryMatches: [{ id: 'secondary-camera', content: '小灰盒' }] }];
assert.equal(judgeCandidate(h4.expected.candidate, secondaryLeak).status, 'fail');
// A rule is generic: no H4 ID, nickname or special case is built into judgeCandidate.
assert.equal(judgeCandidate({ forbidden_excerpts: ['SECOND_SECRET'] }, [{ id: 'other', content: 'SECOND_SECRET' }]).status, 'fail');
assert.equal(judgeCandidate({ forbidden_excerpts: ['SECOND_SECRET'] }, [{ id: 'other', content: 'ordinary' }]).status, 'pass');

// Compare complete verdict objects against the immutable product-baseline
// evaluator for every old candidate declaration, including all subcases.
let original = execFileSync('git', ['show', `${baseline}:scripts/knowledge-recall-eval/judge.mjs`], { cwd: root, encoding: 'utf8' });
original = original.replace("'./prompt-boundary.mjs'", JSON.stringify(pathToFileURL(path.join(root, 'scripts/knowledge-recall-eval/prompt-boundary.mjs')).href));
const legacy = await import(`data:text/javascript;base64,${Buffer.from(original).toString('base64')}`);
let comparisons = 0;
function compare(item) {
  const expected = item.expected?.candidate;
  assert.equal(expected?.forbidden_excerpts, undefined, 'v1.2 must have no new candidate declaration');
  const ids = [...(expected?.required_paths ?? []), ...(expected?.required_ids ?? []), ...(expected?.forbidden_paths ?? []), ...(expected?.forbidden_ids ?? []), ...(expected?.ordered_paths ?? [])];
  const samples = [[], unrelated, forgotten, secondaryLeak,
    ids.map(id => id.endsWith('.md') ? { vaultRelativePath: id, excerpt: 'actual excerpt 小灰盒' } : { id, summary: 'actual summary 小灰盒' }),
    [...ids].reverse().map(id => ({ id }))];
  for (const items of samples) {
    assert.deepEqual(judgeCandidate(expected, items), legacy.judgeCandidate(expected, items), `Legacy rule drift in ${item.case_id ?? item.subcase_id}`);
    const text = JSON.stringify({ sources: items });
    assert.deepEqual(judgeDelivery(item.expected?.delivery, items, text), legacy.judgeDelivery(item.expected?.delivery, items, text), `Legacy delivery rule drift in ${item.case_id ?? item.subcase_id}`);
    comparisons++;
  }
  for (const subcase of item.subcases ?? []) compare(subcase);
}
for (const item of prepared.cases) compare(item);
const sourceHistory = prepared.cases.find(item => item.case_id === 'H2').subcases.find(item => item.subcase_id === 'history');
const copiedHistory = buildV13Cases(prepared.cases).find(item => item.case_id === 'H2').subcases.find(item => item.subcase_id === 'history');
assert.equal(canonicalJson(copiedHistory), canonicalJson(sourceHistory));
assert(sourceHistory.expected.delivery.required_excerpts.includes('当时用 Notion，因为读书会排期能直接按负责人看表格'));
assert(sourceHistory.expected.delivery.identity_assertions.some(item => item.id === 'mem-tool-notion' && item.fields.status === 'superseded' && item.fields.basis === 'explicit'));
assert.equal(prepared.added.find(item => item.case_id === 'M2').domain, 'memory');
assert.equal(prepared.added.find(item => item.case_id === 'M3').domain, 'memory');
assert.equal(NEW_NOTES.length, 4);
for (const item of prepared.added.filter(item => ['C5', 'C6'].includes(item.case_id))) {
  assert.equal(item.partition, 'dev');
  assert(!prepared.cases.some(source => source.fact_group === item.fact_group));
  for (const evidence of item.evidence) {
    const note = NEW_NOTES.find(note => note.path === evidence.path);
    assert(note, 'Each new evidence source must have its own synthetic note');
    assert.equal(note.content.split('\n').slice(evidence.line_start - 1, evidence.line_end).join('\n'), evidence.text);
  }
}
const tagBody = NEW_NOTES[0].content.split('---\n').slice(2).join('---\n');
assert(!tagBody.includes('青禾回访'), 'The lookup term must occur only in the tag, not the answer body');
assert.equal((await verifyDataset(SOURCE_ROOT)).digest.content_sha256, SOURCE_SHA256);
console.log(JSON.stringify({ status: 'pass', baseline, legacy_verdict_comparisons: comparisons, new_cases: prepared.added.map(item => item.case_id), h4_unrelated: 'pass', h4_forgotten_id: 'fail_as_required', h4_nickname: 'fail_as_required', h4_nested_secondary: 'fail_as_required', h2_history_assertions: 'preserved', v12_sha256: SOURCE_SHA256, frozen: false }, null, 2));
