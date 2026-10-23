import { disposableTestRoot } from "../disposable-test-root.mjs";
import assert from 'node:assert/strict';
import { appendFile, mkdir, readFile, writeFile, rm, symlink, access, lstat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { freezeDataset, verifyDataset, canonicalJson } from './dataset.mjs';
import { judgeCandidate, judgeDelivery } from './judge.mjs';
import { buildAdapter, runEvaluation, CSV_COLUMNS, csvRow } from './cli.mjs';
import { judgePromptBoundary } from './prompt-boundary.mjs';

process.env.PI_OFFLINE = '1';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const temporary = disposableTestRoot(path.join(os.homedir(), 'EchoInk-TestVaults/90-任务临时'));
const registry = process.env.ECHOINK_TEST_ROOT ? path.join(temporary, 'selftest-registry.md') : path.join(os.homedir(), 'EchoInk-TestVaults/README.md');
const runId = `selftest-${process.pid}-${Date.now()}-${randomUUID()}`;
const fixture = path.join(temporary, `知识库-召回评测-${runId}-fixture`);
const dataset = path.join(fixture, 'dataset');
const work = path.join(temporary, `知识库-召回评测-${runId}`);
const registeredRoots = new Set();
async function registerRoot(directory, purpose) {
  try { await lstat(directory); throw new Error(`Selftest root already exists: ${directory}`); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await appendFile(registry, `\n- \`${path.relative(path.dirname(registry), directory)}\`：evaluator selftest ${runId}，${purpose}；仅独立合成数据，不启动 Obsidian 或 Provider。创建前登记。\n`);
  registeredRoots.add(directory);
  console.log(JSON.stringify({ selftest_root: directory, lifecycle: 'registered_before_creation', purpose }));
}
async function retireRoot(directory) {
  if (!registeredRoots.has(directory)) return;
  await rm(directory, { recursive: true, force: true });
  await appendFile(registry, `\n- \`${path.relative(path.dirname(registry), directory)}\`：evaluator selftest ${runId} 已结束，已按登记的独有路径精确清理并退役。\n`);
  registeredRoots.delete(directory);
  console.log(JSON.stringify({ selftest_root: directory, lifecycle: 'removed_and_retired' }));
}

async function testCurrentProjectScope() {
  const scopeDataset = path.join(fixture, 'scope-dataset');
  await mkdir(path.join(scopeDataset, '记忆'), { recursive: true });
  await writeFile(path.join(scopeDataset, 'manifest.json'), JSON.stringify({ dataset_version: 'selftest-project-scope', fixed_date: '2026-10-16T12:00:00+08:00', settings: {} }));
  const token = 'SYNTHETIC_SCOPE_SIGNAL';
  const allIds = ['mem_scope_alpha', 'mem_scope_beta', 'mem_scope_global'];
  await writeFile(path.join(scopeDataset, '记忆/seed.json'), JSON.stringify({ operations: [
    { id: allIds[0], request: { operation: 'create', kind: 'fact', title: 'Harbor schedule', recallWhen: token, content: `${token} Harbor ferries depart at dawn.`, scope: 'fixture-alpha', basis: 'explicit' } },
    { id: allIds[1], request: { operation: 'create', kind: 'fact', title: 'Orchard harvest', recallWhen: token, content: `${token} Orchard apples ripen in autumn.`, scope: 'fixture-beta', basis: 'explicit' } },
    { id: allIds[2], request: { operation: 'create', kind: 'fact', title: 'Library hours', recallWhen: token, content: `${token} The public library closes at six.`, basis: 'explicit' } }
  ] }));
  const scenarios = [
    { id: 'DECLARED_ONLY', query: token, declared: 'fixture-alpha', projectId: null },
    { id: 'CURRENT_OVERRIDES_DECLARED', query: `Project: fixture-beta\n${token}`, declared: 'fixture-alpha', projectId: 'fixture-beta' },
    { id: 'HISTORY_ONLY', query: token, history: [{ role: 'user', content: `Project: fixture-alpha\n${token}` }, { role: 'assistant', content: 'Earlier project discussion.' }], projectId: null },
    { id: 'CHINESE_TOP_LEVEL', query: `项目：fixture-beta\n${token}`, declared: 'fixture-alpha', projectId: 'fixture-beta' },
    { id: 'FENCED_DIRECTIVE', query: `\`\`\`text\nProject: fixture-beta\n\`\`\`\n${token}`, declared: 'fixture-alpha', projectId: null },
    { id: 'INLINE_PROSE', query: `For Project: fixture-beta, find ${token}.`, declared: 'fixture-alpha', projectId: null },
    { id: 'INDENTED_DIRECTIVE', query: `  Project: fixture-beta\n${token}`, declared: 'fixture-alpha', projectId: null },
    { id: 'CONFLICTING_DIRECTIVES', query: `Project: fixture-alpha\nProject: fixture-beta\n${token}`, declared: 'fixture-alpha', projectId: null }
  ];
  const scopeCases = scenarios.map(scenario => ({
    case_id: `SCOPE_${scenario.id}`, starter: false, domain: 'memory', query: scenario.query,
    setup: { memory_seed: '记忆/seed.json', ...(scenario.declared ? { project: scenario.declared } : {}), ...(scenario.history ? { history: scenario.history } : {}) },
    expected: {
      candidate: { required_ids: scenario.projectId ? allIds.slice(1) : allIds, ...(scenario.projectId ? { forbidden_ids: [allIds[0]] } : {}) },
      delivery: { required_ids: scenario.projectId ? allIds.slice(1) : allIds, ...(scenario.projectId ? { forbidden_ids: [allIds[0]] } : {}) }
    }
  }));
  await writeFile(path.join(scopeDataset, 'cases.jsonl'), `${scopeCases.map(item => JSON.stringify(item)).join('\n')}\n`);
  const scopeFrozen = await freezeDataset(scopeDataset);
  const scopeWork = `${work}-scope`;
  await registerRoot(scopeWork, '当前 query 项目指令回归运行副本');
  try {
    const scopeOutput = path.join(fixture, 'scope-run');
    const scopeRun = await runEvaluation({ dataset: scopeDataset, 'source-root': root, 'output-run': scopeOutput, 'run-id': `${runId}-scope`, phase: 'selftest', cases: scopeCases.map(item => item.case_id).join(',') });
    const scopeResults = (await readFile(path.join(scopeOutput, 'results.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    // Keep the actual production calls, serialized context, and audit in red/green logs.
    console.log(JSON.stringify({ diagnostic: 'synthetic-only current memory project scope', dataset_sha256: scopeFrozen.digest.content_sha256, run: scopeRun, results: scopeResults }));
    const failures = [];
    const check = (label, callback) => { try { callback(); } catch (error) { failures.push(`${label}: ${error.message}`); } };
    for (const [index, scenario] of scenarios.entries()) {
      const result = scopeResults.find(item => item.case_id === scopeCases[index].case_id);
      const label = scopeCases[index].case_id;
      check(`${label} candidate`, () => assert.equal(result.candidate.status, 'pass'));
      check(`${label} delivery`, () => assert.equal(result.delivery.status, 'pass'));
      const actual = result.actual;
      const expectedIds = [...(scenario.projectId ? allIds.slice(1) : allIds)].sort();
      check(`${label} actual candidates`, () => assert.deepEqual(actual.candidate_items.map(item => item.id).sort(), expectedIds));
      check(`${label} serialized delivery`, () => assert.deepEqual(actual.delivery_items.map(item => item.id).sort(), expectedIds));
      const probes = actual.calls.filter(call => call.function === 'PersonalMemoryRepository.prepareTurnSnapshot.projectCandidates');
      check(`${label} candidate probe scope`, () => assert.deepEqual(probes.map(call => call.request), scenario.projectId ? [{ query: scenario.query, scope: scenario.projectId }] : []));
      const recall = actual.calls.find(call => call.function === 'PersonalMemoryRecallHarness.prepareTurnContext');
      check(`${label} Recall input`, () => {
        assert.ok(recall, 'Production Recall must actually be called');
        assert.equal(recall.request.query, scenario.query);
        assert.equal(recall.request.scope ?? null, scenario.projectId);
        assert.equal(Object.hasOwn(recall.request, 'scope'), scenario.projectId !== null, 'No current directive must omit scope from actual Recall input');
        assert.deepEqual(recall.request.recentConversation, scenario.history ? [scenario.history[0].content] : []);
      });
      check(`${label} serialized audit`, () => {
        const audit = actual.effective_configuration;
        assert.equal(audit.declared_project, scenario.declared ?? null);
        assert.equal(audit.projectId, scenario.projectId);
        assert.equal(audit.current_query, scenario.query);
        assert.equal(audit.candidate_query, actual.calls.find(call => call.function === 'PersonalMemoryRepository.search').request.query);
        assert.equal(audit.candidate_query_source, 'observed_production_prepareTurnSnapshot');
        assert.deepEqual(audit.frozen_history, scenario.history ?? []);
        assert.deepEqual(audit.recent_conversation, scenario.history ? [scenario.history[0].content] : []);
      });
    }
    assert.deepEqual(failures, [], 'Current query alone must determine both production project-scope calls and serialized audit');
    assert.ok(scopeRun.adapter.imported_files.some(item => item.path === 'src/harness/memory/project-identity.ts'));
    console.log(`PASS: ${scenarios.length} independent synthetic project-scope cases; actual candidate probe, Recall input, delivery serialization, and frozen-input audit.`);
  } finally { await retireRoot(scopeWork); }
}

async function testMemoryRecallHistory() {
  const bundleRoot = path.join(fixture, 'history-capability-bundle');
  await mkdir(bundleRoot);
  await buildAdapter(root, bundleRoot);
  const { memoryRecallHistoryInput } = await import(pathToFileURL(path.join(bundleRoot, 'production-adapter.mjs')).href);
  const history = [
    { role: 'user', content: '更旧的紫藤工程。' },
    { role: 'assistant', content: 'OLDER_ASSISTANT_ENTITY' },
    { role: 'user', content: 'Project: cedar\n雪松迁移的负责人是林晓。' },
    { role: 'assistant', content: 'ASSISTANT_ENTITY_CANARY' }
  ];
  const legacy = memoryRecallHistoryInput({}, {}, history, {});
  assert.deepEqual(legacy.recentConversation, history.map(turn => turn.content), 'Missing product capability must retain legacy complete strings, including assistants');
  assert.equal(legacy.history_policy, 'legacy_all_recent_conversation_v1');
  let selections = 0;
  const capability = {
    PERSONAL_MEMORY_RECALL_HISTORY_POLICY: 'synthetic-capability',
    selectMemoryRecallPreviousUserContext(input) {
      selections++;
      assert.equal(input, history);
      return ['CAPABILITY_SELECTED_TEXT'];
    }
  };
  assert.deepEqual(memoryRecallHistoryInput({}, {}, history, capability).recentConversation, ['CAPABILITY_SELECTED_TEXT']);
  assert.equal(selections, 1, 'Role-aware input must use the tested product export');
  const opaque = ['opaque user text', 'opaque assistant-like text'];
  const explicit = memoryRecallHistoryInput({ recent_conversation: opaque }, {}, history, capability);
  assert.equal(explicit.recentConversation, opaque, 'Explicit string[] must not guess or filter roles');
  assert.equal(selections, 1, 'Opaque strings bypass role-based selection');
  assert.equal(explicit.history_input_source, 'explicit_opaque_strings');
  assert.deepEqual(memoryRecallHistoryInput({}, { recent_conversation: opaque }, history, {}).recentConversation, opaque);

  const historyDataset = path.join(fixture, 'history-dataset');
  await mkdir(path.join(historyDataset, '记忆'), { recursive: true });
  await writeFile(path.join(historyDataset, 'manifest.json'), JSON.stringify({ dataset_version: 'selftest-memory-history', fixed_date: '2026-10-16T12:00:00+08:00', settings: {} }));
  await writeFile(path.join(historyDataset, '记忆/seed.json'), JSON.stringify({ operations: [
    { id: 'mem_context', request: { operation: 'create', kind: 'fact', title: '合成负责人', recallWhen: '询问负责人时', content: '合成负责人是林晓。', basis: 'explicit' } },
    { id: 'mem_context_cedar', request: { operation: 'create', kind: 'fact', title: 'Cedar 负责人', recallWhen: '询问负责人时', content: '雪松迁移的负责人是林晓。', scope: 'project:cedar', basis: 'explicit' } },
    { id: 'mem_context_harbor', request: { operation: 'create', kind: 'fact', title: 'Harbor 负责人', recallWhen: '询问负责人时', content: '海港工程的负责人是周航。', scope: 'project:harbor', basis: 'explicit' } }
  ] }));
  const previous = history[2].content;
  const repeated = '它的负责人是谁？';
  const scenarios = [
    { id: 'TOPIC_SWITCH', query: '换个话题，海港工程的负责人是谁？', history, previous, expected: '换个话题，海港工程的负责人是谁？' },
    { id: 'NAMED_SUBJECT', query: '那海港工程呢？', history, previous, expected: '那海港工程呢？' },
    { id: 'PRONOUN', query: repeated, history, previous, expected: `${repeated}\n${previous}`, deliveryIds: ['mem_context', 'mem_context_cedar'] },
    { id: 'NAMED_PROJECT', query: 'harbor 项目的负责人是谁？', history, previous, expected: 'harbor 项目的负责人是谁？', deliveryIds: ['mem_context', 'mem_context_harbor'] },
    { id: 'SAME_TEXT_PREVIOUS_USER', query: repeated, history: [{ role: 'user', content: repeated }, history[3]], previous: repeated, expected: `${repeated}\n${repeated}` },
    { id: 'ASSISTANT_ONLY', query: repeated, history: [history[3]], previous: null, expected: repeated },
    { id: 'OPAQUE_STRINGS', query: repeated, history, opaque, previous: null, expected: `${repeated}\n${opaque[1]}` },
    { id: 'CURRENT_PROJECT', query: 'Project: harbor\n它的负责人是谁？', history, previous, scope: 'harbor', expected: 'Project: harbor\n它的负责人是谁？' },
    { id: 'HISTORICAL_STATUSES', query: '合成负责人的历史', history, previous, expected: '合成负责人的历史', statuses: ['current', 'superseded'] },
    { id: 'HISTORY_BUDGET', query: repeated, history: [{ role: 'user', content: `最近用户前文-${'丙'.repeat(2500)}` }, history[3]], previous: `最近用户前文-${'丙'.repeat(2500)}`, budget: 80 }
  ];
  const cases = scenarios.map(scenario => ({
    case_id: `CONTEXT_${scenario.id}`, domain: 'memory', starter: false, query: scenario.query,
    ...(scenario.opaque ? { recent_conversation: scenario.opaque } : {}),
    setup: { history: scenario.history, memory_seed: '记忆/seed.json', ...(scenario.budget ? { memory_token_budget: scenario.budget } : {}), ...(scenario.statuses ? { memory_search: { statuses: scenario.statuses, limit: 1 } } : {}) },
    expected: { candidate: { applicable: false }, delivery: { applicable: false } }
  }));
  await writeFile(path.join(historyDataset, 'cases.jsonl'), `${cases.map(item => JSON.stringify(item)).join('\n')}\n`);
  await freezeDataset(historyDataset);
  const historyWork = `${work}-history`;
  await registerRoot(historyWork, '当前问题与历史策略独立合成反例');
  try {
    const output = path.join(fixture, 'history-run');
    await runEvaluation({ dataset: historyDataset, 'source-root': root, 'output-run': output, 'run-id': `${runId}-history`, phase: 'selftest', cases: cases.map(item => item.case_id).join(',') });
    const results = (await readFile(path.join(output, 'results.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    const queryEvidence = [];
    for (const scenario of scenarios) {
      const { actual } = results.find(result => result.case_id === `CONTEXT_${scenario.id}`);
      const recall = actual.calls.find(call => call.function === 'PersonalMemoryRecallHarness.prepareTurnContext');
      const snapshots = actual.calls.filter(call => call.function === 'PersonalMemoryRepository.prepareTurnSnapshot');
      const snapshot = snapshots.at(-1);
      const searches = actual.calls.filter(call => call.function === 'PersonalMemoryRepository.search');
      assert.ok(recall && snapshot, `${scenario.id} must observe actual production inputs`);
      assert.ok(searches.length > 0, `${scenario.id} must execute the real candidate search`);
      for (const search of searches) {
        assert.equal(search.request.query, snapshot.request.query, `${scenario.id} candidate search must use the exact actual Harness snapshot query`);
        assert.deepEqual(search.request.statuses, scenario.statuses, 'Candidate-only historical statuses must remain unchanged');
      }
      if (scenario.statuses) assert.ok(searches.length > 1, 'Every page must retain the observed query and historical statuses');
      assert.equal(recall.request.query, scenario.query);
      assert.deepEqual(recall.request.recentConversation, scenario.opaque ?? (scenario.previous ? [scenario.previous] : []));
      assert.equal(recall.request.scope, scenario.scope);
      assert.equal(snapshot.request.scope, scenario.scope, 'History Project never adds an actual scope');
      if (scenario.expected) assert.equal(snapshot.request.query, scenario.expected, scenario.id);
      else {
        assert.ok(snapshot.request.query.startsWith(`${repeated}\n最近用户前文-`));
        assert.ok(snapshot.request.query.length <= 2000);
      }
      const audit = actual.effective_configuration;
      assert.deepEqual(audit.frozen_history, scenario.history, 'Full role-bearing input remains available for audit');
      assert.equal(audit.current_query, scenario.query);
      assert.equal(audit.candidate_query, snapshot.request.query);
      assert.equal(audit.candidate_query_source, 'observed_production_prepareTurnSnapshot');
      assert.deepEqual(audit.recent_conversation, recall.request.recentConversation);
      assert.equal(audit.history_policy, 'current_query_with_unresolved_reference_previous_user_v1');
      assert.equal(audit.history_context_selection, scenario.opaque ? 'strings_passed_without_role_inference' : 'tested_product_selectMemoryRecallPreviousUserContext');
      assert.ok(!snapshot.request.query.includes('ASSISTANT_ENTITY_CANARY'));
      if (scenario.deliveryIds) {
        const allIds = ['mem_context', 'mem_context_cedar', 'mem_context_harbor'];
        assert.deepEqual(actual.candidate_items.map(item => item.id).sort(), [...allIds].sort(), 'Candidate source remains the tool search even when automatic Recall filters another project');
        assert.deepEqual(actual.raw.repository_search.flatMap(page => page.items).map(item => item.id).sort(), [...allIds].sort());
        assert.deepEqual(actual.delivery_items.map(item => item.id).sort(), [...scenario.deliveryIds].sort(), 'Automatic Recall delivery applies the production project filter');
      }
      queryEvidence.push({ scenario: scenario.id, current_query: scenario.query, candidate_query: audit.candidate_query, production_snapshot_query: snapshot.request.query, candidate_ids: actual.candidate_items.map(item => item.id), delivery_ids: actual.delivery_items.map(item => item.id) });
    }
    console.log(JSON.stringify({ diagnostic: 'actual candidate query equals production Recall snapshot query; tool candidates and automatic delivery remain distinct', queries: queryEvidence }));
    console.log(`PASS: ${scenarios.length} actual Memory snapshot/context audits; legacy capability absence and explicit string[] compatibility controls.`);
  } finally { await retireRoot(historyWork); }
}

async function testMemoryCandidateError() {
  const errorDataset = path.join(fixture, 'candidate-error-dataset');
  await mkdir(errorDataset);
  await writeFile(path.join(errorDataset, 'manifest.json'), JSON.stringify({ dataset_version: 'selftest-memory-candidate-error', fixed_date: '2026-10-16T12:00:00+08:00', settings: {} }));
  const item = {
    case_id: 'CANDIDATE_SEARCH_ERROR', domain: 'memory', starter: false, query: '合成负责人',
    setup: { memory_search: { cursor: 'invalid' } },
    expected: { candidate: { forbidden_ids: ['mem_synthetic_forbidden'] }, delivery: { forbidden_ids: ['mem_synthetic_forbidden'], forbidden_excerpts: ['SYNTHETIC_FORBIDDEN_EXCERPT'] } }
  };
  await writeFile(path.join(errorDataset, 'cases.jsonl'), `${JSON.stringify(item)}\n`);
  await freezeDataset(errorDataset);
  const errorWork = `${work}-candidate-error`;
  await registerRoot(errorWork, '候选搜索异常不得被生产 Recall 降级吞掉的合成反例');
  try {
    const output = path.join(fixture, 'candidate-error-run');
    await runEvaluation({ dataset: errorDataset, 'source-root': root, 'output-run': output, 'run-id': `${runId}-candidate-error`, phase: 'selftest', cases: item.case_id });
    const result = JSON.parse((await readFile(path.join(output, 'results.jsonl'), 'utf8')).trim());
    console.log(JSON.stringify({ diagnostic: 'candidate search error must reach evaluator CLI despite production Recall fallback', result }));
    assert.match(result.actual_error ?? '', /memory_search cursor is invalid/u, 'CLI must retain the actual candidate-search error');
    assert.equal(result.candidate.status, 'fail', 'A failed search must not pass forbidden-only candidate assertions with an empty result');
    assert.equal(result.delivery.status, 'fail', 'A failed search must not pass forbidden-only delivery assertions with an empty result');
    assert.ok(result.actual.calls.some(call => call.function === 'PersonalMemoryRepository.search' && call.outcome === 'threw' && /memory_search cursor is invalid/u.test(call.error)), 'Actual Repository failure remains in the call audit');
    console.log('PASS: candidate-search cursor error reaches CLI; forbidden-only candidate and delivery remain failed.');
  } finally { await retireRoot(errorWork); }
}

try {
  await registerRoot(fixture, '独立合成 fixture、冻结数据与自测输出');
  await mkdir(fixture);
  if (!process.argv.includes('--scope-only') && !process.argv.includes('--history-only') && !process.argv.includes('--candidate-error-only')) {
  await mkdir(path.join(dataset, '笔记/wiki'), { recursive: true });
  await mkdir(path.join(dataset, '笔记/journal'), { recursive: true });
  await mkdir(path.join(dataset, '记忆'), { recursive: true });
  await writeFile(path.join(dataset, 'manifest.json'), JSON.stringify({ dataset_version: 'selftest', fixed_date: '2026-10-16T12:00:00+08:00', settings: {} }));
  await writeFile(path.join(dataset, '笔记/wiki/gold.md'), '# Golden fixture\nGOLD_TOKEN answer: preserve this exact sentence.\n');
  await writeFile(path.join(dataset, '笔记/wiki/change.md'), '# Change fixture\nBEFOREMUTATION original sentence.\n');
  await writeFile(path.join(dataset, '笔记/wiki/search-policy.md'), '# Search policy\nJOURNAL_FILTER_TOKEN WIKI_CONFIGURATION_EVIDENCE belongs to the knowledge note.\n');
  await writeFile(path.join(dataset, '笔记/journal/interference.md'), '# Daily entry\nJOURNAL_FILTER_TOKEN JOURNAL_CONFIGURATION_DECOY belongs to the diary.\n');
  const journalBindings = { schemaVersion: 1, revision: 1, configured: true, migrationIssues: [], roles: {
    wiki: { enabled: true, readPaths: ['wiki'], writePath: 'wiki', allowedSubdirectories: [], autoOrganizePaths: [] },
    journal: { enabled: true, searchEnabled: true, readPaths: ['journal'], writePath: 'journal', allowedSubdirectories: [], autoOrganizePaths: ['journal'] }
  } };
  await writeFile(path.join(dataset, '记忆/seed.json'), JSON.stringify({
    operations: [
      { id: 'mem_eval_coffee', request: { operation: 'create', kind: 'fact', title: 'COFFEE_MEMORY_TOKEN', recallWhen: 'COFFEE_MEMORY_TOKEN', content: 'COFFEE_MEMORY_TOKEN I do not drink coffee.', basis: 'explicit' } },
      { id: 'mem_eval_old', request: { operation: 'create', kind: 'decision', title: 'HISTORY_MEMORY_TOKEN', recallWhen: 'HISTORY_MEMORY_TOKEN', content: 'HISTORY_MEMORY_TOKEN old Notion reason.', basis: 'explicit' } },
      { id: 'mem_eval_new', request: { operation: 'supersede', targetId: 'mem_eval_old', title: 'CURRENT_MEMORY_TOKEN', recallWhen: 'CURRENT_MEMORY_TOKEN', content: 'CURRENT_MEMORY_TOKEN now Obsidian.', basis: 'explicit', reason: 'Changed tool.' } }
    ], secondary_records: [{ schema: 'echoink.memory-secondary.v1', id: 'secondary_eval_tea', parentId: 'mem_eval_coffee', status: 'current', disabledReason: null, title: 'Possible tea preference', content: 'Maybe tea.', recallWhen: 'COFFEE_MEMORY_TOKEN', matchTerms: ['COFFEE_MEMORY_TOKEN'], relation: 'associated', reason: 'Synthetic inference.', supportLevel: 'weak_inference', evidence: 'Synthetic explicit statement only.', basis: 'llm_inferred', sourceMemoryRevision: 1, confidence: 0.70, hitCount: 0, lastHitAt: null, lastDecayAt: null, createdAt: 1792108800000, updatedAt: 1792108800000, revision: 1, file: 'secondary/secondary_eval_tea.md' }]
  }));
  const invalidSeed = JSON.parse(await readFile(path.join(dataset, '记忆/seed.json'), 'utf8'));
  invalidSeed.secondary_records[0].matchTerms = ['茶'];
  await writeFile(path.join(dataset, '记忆/invalid-seed.json'), JSON.stringify(invalidSeed));
  const cases = [
    { case_id: 'A1', starter: true, query: 'GOLD_TOKEN', setup: { opened_paths: ['wiki/gold.md'], history: [{ role: 'user', content: 'Prior host hint' }], model_must_derive_date_range: true }, expected: { candidate: { required_paths: ['wiki/gold.md'], max_rank: 1 }, delivery: { required_paths: ['wiki/gold.md'], required_excerpts: ['preserve this exact sentence.'], required_fields: ['contentRevision', 'lineStart', 'lineEnd'] } } },
    { case_id: 'A3', starter: true, query: 'GOLD_TOKEN', expected: { candidate: { required_paths: ['missing.md'] }, delivery: { required_excerpts: ['THIS_IS_NOT_IN_THE_VAULT'] } } },
    { case_id: 'A4', starter: true, query: 'JOURNAL_FILTER_TOKEN', setup: { folder_bindings: journalBindings, settings_override: { search_journal: false } }, expected: { candidate: { required_paths: ['wiki/search-policy.md'], forbidden_paths: ['journal/interference.md'] }, delivery: { required_paths: ['wiki/search-policy.md'], forbidden_paths: ['journal/interference.md'], required_excerpts: ['WIKI_CONFIGURATION_EVIDENCE'], forbidden_excerpts: ['JOURNAL_CONFIGURATION_DECOY'] } } },
    { case_id: 'A4_JOURNAL_ENABLED', starter: false, query: 'JOURNAL_FILTER_TOKEN', setup: { folder_bindings: journalBindings, settings_override: { search_journal: true } }, expected: { candidate: { required_paths: ['wiki/search-policy.md', 'journal/interference.md'] }, delivery: { required_paths: ['wiki/search-policy.md', 'journal/interference.md'], required_excerpts: ['WIKI_CONFIGURATION_EVIDENCE', 'JOURNAL_CONFIGURATION_DECOY'] } } },
    { case_id: 'A_UNKNOWN_SETUP', starter: false, query: 'GOLD_TOKEN', setup: { unsupported_fixture_host_switch: 'not-performed' }, expected: { candidate: { required_paths: ['wiki/gold.md'] }, delivery: { required_paths: ['wiki/gold.md'], required_excerpts: ['preserve this exact sentence.'] } } },
    { case_id: 'H1', starter: true, domain: 'memory', query: 'COFFEE_MEMORY_TOKEN', setup: { memory_seed: '记忆/seed.json' }, expected: { candidate: { required_ids: ['mem_eval_coffee'], required_secondary_ids: ['secondary_eval_tea'] }, delivery: { required_ids: ['mem_eval_coffee', 'secondary_eval_tea'], required_excerpts: ['I do not drink coffee.', 'Maybe tea.'], required_fields: ['basis'] } } },
    { case_id: 'H_INVALID', starter: true, domain: 'memory', query: 'COFFEE_MEMORY_TOKEN', setup: { memory_seed: '记忆/invalid-seed.json' }, expected: { candidate: { required_ids: ['mem_eval_coffee'] }, delivery: { required_ids: ['mem_eval_coffee'] } } },
    { case_id: 'H2', starter: true, domain: 'memory', query: 'split', setup: { memory_seed: '记忆/seed.json' }, subcases: [
      { subcase_id: 'current', query: 'CURRENT_MEMORY_TOKEN', expected: { candidate: { required_ids: ['mem_eval_new'], forbidden_ids: ['mem_eval_old'] }, delivery: { required_ids: ['mem_eval_new'], required_excerpts: ['now Obsidian.'] } } },
      { subcase_id: 'history', query: 'HISTORY_MEMORY_TOKEN', setup: { memory_search: { statuses: ['current', 'superseded'] } }, expected: { candidate: { required_ids: ['mem_eval_old'] }, delivery: { required_ids: ['mem_eval_old'], required_excerpts: ['old Notion reason.'] } } }
    ] },
    { case_id: 'I2', starter: true, query: 'AFTERMUTATION', setup: { mutations: [{ action: 'write', path: 'wiki/change.md', content: '# Changed\nAFTERMUTATION latest sentence.\n' }] }, expected: { candidate: { required_paths: ['wiki/change.md'] }, delivery: { required_excerpts: ['latest sentence.'] } } },
    { case_id: 'I2_OLD', starter: true, query: 'BEFOREMUTATION', setup: { mutations: [{ action: 'write', path: 'wiki/change.md', content: '# Changed\nAFTERMUTATION latest sentence.\n' }] }, expected: { candidate: { empty: true }, delivery: { empty: true } } },
    { case_id: 'I7', starter: true, query: 'What is the GOLD_TOKEN record?', execution: { script: false, reason: 'Frozen old adapter does not capture final messages.' }, expected: { candidate: { applicable: false }, delivery: { applicable: true, boundary_contract: ['Capture actual final messages', 'Require explicit closed resource and original-text sections', 'Markdown --- must preserve closure'] } }, regression_fixture: { path: 'wiki/gold.md', legacy_last_excerpt: '---', question_is_not_source_text: true } },
    { case_id: 'J1', starter: true, query: '', execution: { script: false, reason: 'Needs native iPhone and iPad.' } },
    { case_id: 'K1', starter: true, query: '', execution: { script: false, reason: 'Separate large-vault performance run.' } }
  ];
  await writeFile(path.join(dataset, 'cases.jsonl'), `${cases.map(item => JSON.stringify(item)).join('\n')}\n`);
  const frozen = await freezeDataset(dataset);
  assert.equal(frozen.manifest.scoring_rule_version, 'kb-recall-mechanical-v2');
  assert.equal((await verifyDataset(dataset)).digest.content_sha256, frozen.digest.content_sha256);
  const legacyDataset = path.join(fixture, 'archived-v1');
  await mkdir(legacyDataset);
  await writeFile(path.join(legacyDataset, 'manifest.json'), JSON.stringify({ dataset_version: 'selftest-archived-v1', scoring_rule_version: 'kb-recall-mechanical-v1' }));
  await writeFile(path.join(legacyDataset, 'cases.jsonl'), '');
  const legacyFrozen = await freezeDataset(legacyDataset);
  assert.equal((await verifyDataset(legacyDataset)).digest.content_sha256, legacyFrozen.digest.content_sha256);
  assert.equal((await verifyDataset(legacyDataset)).manifest.scoring_rule_version, 'kb-recall-mechanical-v1');
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
  assert.equal(judgeCandidate({ applicable: false }, []).status, 'not_applicable');
  assert.equal(judgeCandidate({}, []).status, 'pending_review', 'An empty applicable rule must not automatically pass');
  assert.equal(judgeDelivery({ required_excerpts: ['evidence'] }, [{ excerpt: 'other' }], 'wrapper evidence').status, 'fail');
  const output = path.join(fixture, 'run');
  await registerRoot(work, '原 starter 评测运行副本');
  const run = await runEvaluation({ dataset, 'source-root': root, 'output-run': output, 'run-id': runId, phase: 'selftest' });
  const results = (await readFile(path.join(output, 'results.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  const byId = Object.fromEntries(results.map(item => [item.case_id, item]));
  assert.equal(byId.A1.candidate.status, 'pass');
  assert.equal(byId.A1.delivery.status, 'pass', JSON.stringify({ verdict: byId.A1.delivery, delivered: byId.A1.actual.delivery_items, text: byId.A1.actual.provider_text }));
  assert.equal(judgeDelivery({ empty: true, forbidden_excerpts: ['行程里不显示住址'] }, [], '行程里不显示住址').status, 'fail');
  assert.equal(judgeDelivery({ empty: true, forbidden_excerpts: ['我支持量子计算'] }, [], '我支持量子计算').status, 'fail');
  const actualGold = byId.A1.actual.delivery_items[0];
  const goldRule = cases[0].expected.delivery;
  const secondSpan = { ...actualGold, lineStart: 2, lineEnd: 2, excerpt: 'GOLD_TOKEN answer: preserve this exact sentence.' };
  assert.equal(judgeDelivery(goldRule, [actualGold, secondSpan], JSON.stringify({ sources: [actualGold, secondSpan] })).status, 'pass', 'Multiple spans pair by version and line range');
  assert.equal(judgeDelivery(goldRule, [actualGold, { ...secondSpan, excerpt: 'fabricated' }], JSON.stringify({ sources: [actualGold, secondSpan] })).status, 'fail', 'Span pairing still rejects fabricated original text');

  assert.equal(judgeDelivery(goldRule, [{ ...actualGold, contentRevision: 'bogus', lineStart: 'bogus', lineEnd: 'bogus' }], actualGold.excerpt).status, 'fail');
  assert.equal(judgeDelivery(goldRule, [actualGold], actualGold.excerpt).status, 'fail', 'Bare excerpt must not stand in for serialized source identity');
  assert.equal(judgeDelivery(goldRule, [actualGold], byId.A1.actual.provider_text.replace(actualGold.contentRevision, 'bogus')).status, 'fail');
  assert.equal(judgeDelivery({ identity_assertions: [{ id: 'not-delivered', required_fields: ['basis'] }] }, [], '').status, 'fail');
  assert.equal(byId.A3.candidate.status, 'fail');
  assert.equal(byId.A3.delivery.status, 'fail');
  assert.equal(byId.A4.candidate.status, 'pass', 'Implemented journal search override must run against the real directory binding');
  assert.equal(byId.A4.delivery.status, 'pass');
  const a4Configuration = byId.A4.actual.effective_configuration;
  assert.equal(journalBindings.roles.journal.searchEnabled, true, 'The fixture starts with journal search enabled');
  assert.equal(a4Configuration.settings_override.search_journal, false);
  assert.equal(a4Configuration.directory_bindings.roles.journal.enabled, true, 'Search is disabled without disabling the journal role');
  assert.equal(a4Configuration.directory_bindings.roles.journal.searchEnabled, false, 'The production binding must receive the override');
  assert.deepEqual(a4Configuration.directory_bindings.roles.journal.autoOrganizePaths, ['journal']);
  assert.equal(a4Configuration.journal_auto_organize_unchanged, true);
  assert.deepEqual(byId.A4.actual.candidate_items.map(item => item.vaultRelativePath), ['wiki/search-policy.md']);
  assert.deepEqual(byId.A4.actual.delivery_items.map(item => item.vaultRelativePath), ['wiki/search-policy.md']);
  assert.ok(byId.A4.actual.provider_text.includes('WIKI_CONFIGURATION_EVIDENCE'));
  assert.ok(!byId.A4.actual.provider_text.includes('JOURNAL_CONFIGURATION_DECOY'));
  const configurationWork = `${work}-configuration`;
  await registerRoot(configurationWork, 'journal 开启正控制与未知 setup 阻断反例运行副本');
  try {
    const configurationOutput = path.join(fixture, 'configuration-run');
    const configurationRun = await runEvaluation({ dataset, 'source-root': root, 'output-run': configurationOutput, 'run-id': `${runId}-configuration`, phase: 'selftest', cases: 'A4_JOURNAL_ENABLED,A_UNKNOWN_SETUP' });
    const configurationResults = (await readFile(path.join(configurationOutput, 'results.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    console.log(JSON.stringify({ diagnostic: 'synthetic-only journal setting and unknown setup controls', starter_scores: run.scores, disabled_journal: byId.A4, run: configurationRun, results: configurationResults }));
    const enabled = configurationResults.find(item => item.case_id === 'A4_JOURNAL_ENABLED');
    assert.equal(enabled.candidate.status, 'pass', 'The same diary must be retrievable when journal search is enabled');
    assert.equal(enabled.delivery.status, 'pass');
    assert.equal(enabled.actual.effective_configuration.directory_bindings.roles.journal.searchEnabled, true);
    assert.ok(enabled.actual.candidate_items.some(item => item.vaultRelativePath === 'journal/interference.md'));
    assert.ok(enabled.actual.delivery_items.some(item => item.vaultRelativePath === 'journal/interference.md'));
    assert.ok(enabled.actual.provider_text.includes('JOURNAL_CONFIGURATION_DECOY'));
    const unknown = configurationResults.find(item => item.case_id === 'A_UNKNOWN_SETUP');
    assert.equal(unknown.candidate.status, 'blocked', 'A genuinely unknown host precondition must remain blocked');
    assert.equal(unknown.delivery.status, 'blocked');
    assert.ok(unknown.actual.unsupported_setup.some(issue => issue.key === 'unsupported_fixture_host_switch' && issue.classification === 'script_host_precondition_not_executed' && issue.blocks_standard_setup));
    assert.equal(judgeCandidate(unknown.expected.candidate, unknown.actual.candidate_items).status, 'pass', 'Blocking is caused by the unsupported setup, not a failed retrieval');
    assert.equal(judgeDelivery(unknown.expected.delivery, unknown.actual.delivery_items, unknown.actual.provider_text).status, 'pass');
    assert.ok(!results.some(item => ['A4_JOURNAL_ENABLED', 'A_UNKNOWN_SETUP'].includes(item.case_id)), 'Independent controls must not enter the original starter denominator');
    assert.equal(configurationRun.scores.candidate.blocked, 1);
    assert.equal(configurationRun.scores.delivery.blocked, 1);
    assert.equal(configurationRun.scores.candidate.executed, 1);
    assert.equal(configurationRun.scores.delivery.executed, 1);
  } finally { await retireRoot(configurationWork); }
  assert.equal(byId.A1.actual.effective_configuration.opened_paths_applied, true);
  assert.equal(byId.A1.actual.effective_configuration.retrieval_request.includeUnrefined, false);
  assert.equal(byId.H1.candidate.status, 'pass', JSON.stringify({ verdict: byId.H1.candidate, raw: byId.H1.actual.raw.repository_search, delivered: byId.H1.actual.delivery_items }));
  assert.equal(byId.H1.delivery.status, 'pass', 'Real recall delivers basis before budgeting');
  assert.equal(byId.H_INVALID.candidate.status, 'blocked');
  assert.equal(byId.H_INVALID.delivery.status, 'blocked');
  assert.equal(byId.H_INVALID.actual.raw.fixture_validation.status, 'invalid_fixture');
  assert.match(byId.H_INVALID.actual.raw.fixture_validation.reason, /association_clue_invalid:matchTerms/u);
  assert.ok(!byId.H_INVALID.actual.calls.some(item => item.function === 'PersonalMemoryRepository.initialize'), 'Invalid fixture must be rejected before Repository execution');
  assert.ok(byId.H1.actual.delivery_items.length > 0, 'Memory delivery must come from production serialization');
  assert.ok(byId.H1.actual.delivery_items.some(item => item.id === 'secondary_eval_tea'), 'Dream must be delivered by real matching and production secondary serialization');
  assert.equal(results.find(item => item.case_id === 'H2' && item.subcase_id === 'current').delivery.status, 'pass');
  assert.equal(results.find(item => item.case_id === 'H2' && item.subcase_id === 'history').candidate.status, 'pass');
  assert.equal(results.find(item => item.case_id === 'H2' && item.subcase_id === 'history').delivery.status, 'fail');
  assert.equal(byId.I2.candidate.status, 'pass');
  assert.equal(byId.I2.delivery.status, 'pass');
  assert.equal(byId.I2_OLD.actual.raw.mutations[0].before.total, 1, 'Old word must exist in the warm index before modification');
  assert.equal(byId.I2_OLD.candidate.status, 'pass', 'Old word must disappear after the real bound modify handler');
  assert.equal(byId.I2_OLD.delivery.status, 'pass');
  assert.equal(byId.I7.delivery.status, 'not_run', 'The new switch must not change default frozen execution flags');
  assert.equal(byId.I2.actual.raw.mutations[1].notification.event, 'modify');
  assert.equal(byId.I2.actual.raw.mutations[1].notification.path, 'wiki/change.md');
  assert.equal(byId.I2.actual.raw.mutations[1].notification.producer_binding, 'bindKnowledgeIndexToVault');
  assert.equal(byId.I2.actual.raw.mutations[1].notification.handler_completed, true);
  assert.equal(byId.I2.actual.raw.vault_event_binding.unbound, true);
  assert.equal(byId.I2.actual.raw.vault_event_binding.listeners_remaining, 0);
  const changedReference = byId.I2.actual.delivery_items[0];
  assert.equal(judgeDelivery({ identity_assertions: [{ path: changedReference.vaultRelativePath, fields: { contentRevision: changedReference.contentRevision } }] }, byId.I2.actual.delivery_items, byId.I2.actual.provider_text).status, 'pass');
  assert.equal(judgeDelivery({ identity_assertions: [{ path: changedReference.vaultRelativePath, fields: { contentRevision: `sha256:${'0'.repeat(64)}` } }] }, byId.I2.actual.delivery_items, byId.I2.actual.provider_text).status, 'fail', 'Correct excerpt with a different expected revision must fail delivery');
  assert.equal(byId.J1.candidate.status, 'not_run');
  assert.equal(byId.K1.candidate.status, 'not_run');
  // A4 now runs and passes: it adds one actual result to each former 6/7 and 5/7 score.
  assert.equal(run.scores.candidate.score, '7/8');
  assert.equal(run.scores.delivery.score, '6/8');
  assert.equal(run.scores.answer.score, '');
  assert.equal(run.device, 'desktop-script');
  assert.equal(run.model, '');
  assert.equal(run.dataset.scoring_rule_version, 'kb-recall-mechanical-v2');
  assert.equal(CSV_COLUMNS.join(','), 'run_id,started_at,phase,git_commit,dataset_version,device,model,candidate,delivery,answer,tool_calls_median,elapsed_seconds_median,record_path,notes');
  assert.equal(csvRow(run, 'run.json').match(/","/gu).length, 13);
  assert.deepEqual(csvRow(run, 'run.json').split('","').slice(10, 12), ['', '']);
  assert.deepEqual(csvRow({ ...run, answer_metrics: { summary: { tool_calls_median: 3, elapsed_seconds_median: 1.25 } } }, 'run.json').split('","').slice(10, 12), ['3', '1.25']);
  assert.deepEqual(csvRow({ ...run, answer_metrics: { summary: { tool_calls_median: 0, elapsed_seconds_median: 0 } } }, 'run.json').split('","').slice(10, 12), ['0', '0']);
  const boundaryWork = `${work}-boundary`;
  await registerRoot(boundaryWork, '原 I7 prompt-boundary 自测运行副本');
  try {
    const boundaryOutput = path.join(fixture, 'boundary-run');
    const boundaryRun = await runEvaluation({ dataset, 'source-root': root, 'output-run': boundaryOutput, 'run-id': `${runId}-boundary`, phase: 'selftest', cases: 'I7', 'prompt-boundary': 'true' });
    const actual = JSON.parse((await readFile(path.join(boundaryOutput, 'results.jsonl'), 'utf8')).trim());
    assert.equal(actual.candidate.status, 'not_applicable');
    assert.equal(actual.delivery.status, 'pass');
    assert.equal(boundaryRun.configuration.execution_overrides[0].case_id, 'I7');
    assert.ok(actual.actual.prompt_boundary.actual.openai_compatible.output.length > 0);
    assert.ok(actual.delivery.assertions.some(assertion => assertion.name.includes('remain separate') && assertion.pass));
    assert.ok(actual.delivery.assertions.some(assertion => assertion.name.includes('explicit closing structure') && assertion.pass));
    assert.equal(actual.actual.prompt_boundary.synthetic_last_excerpt_dash.capture.references.at(-1).excerpt, '---');
    assert.ok(actual.actual.calls.some(call => call.function === 'actual.convertToLlm'));
    assert.ok(actual.actual.calls.some(call => call.function === 'actual.openaiCompatible.convertMessages'));
  } finally { await retireRoot(boundaryWork); }
  const boundaryQuestion = 'CURRENT_QUESTION';
  const boundaryControl = (resource, dashResource, excerpt = 'proof') => {
    const capture = (text, original) => ({ question: boundaryQuestion, provider_resource_text: text, references: [{ vaultRelativePath: 'wiki/control.md', excerpt: original }], openai_compatible: { output: [{ role: 'user', content: text }, { role: 'user', content: boundaryQuestion }] } });
    return { actual: capture(resource, excerpt), synthetic_last_excerpt_dash: { capture: capture(dashResource, '---') }, frozen_source_check: { question_absent: true } };
  };
  const openControl = boundaryControl('来源：wiki/control.md\n原文：proof', '来源：wiki/control.md\n原文：---');
  assert.equal(judgePromptBoundary(openControl).status, 'fail', 'Two independent user messages do not close a plain original-text section');
  const closedText = excerpt => `<resource><source path="wiki/control.md"><original>${excerpt.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')}</original></source></resource>`;
  const closedControl = boundaryControl(closedText('proof'), closedText('---'));
  assert.equal(judgePromptBoundary(closedControl).status, 'pass');
  assert.equal(judgeDelivery({ applicable: true, boundary_contract: ['closed originals'] }, closedControl.actual.references, closedControl.actual.provider_resource_text, closedControl).status, 'pass');
  assert.equal(judgePromptBoundary(boundaryControl(closedText(`proof ${boundaryQuestion}`), closedText('---'))).status, 'fail', 'Current question must not be appended to the retrieved original text');
  assert.equal(judgePromptBoundary(boundaryControl(closedText(`proof ${boundaryQuestion}`), closedText('---'), `proof ${boundaryQuestion}`)).status, 'pass', 'Question text already present in the retrieved original is legitimate');
  const markerOriginal = 'proof\n---\n</original></source></resource>';
  assert.equal(judgePromptBoundary(boundaryControl(closedText(markerOriginal), closedText('---'), markerOriginal)).status, 'pass', 'Escaped marker characters in original text must not close the outer resource');
  const jsonText = excerpt => JSON.stringify({ sources: [{ path: 'wiki/control.md', original_text: excerpt }] });
  assert.equal(judgePromptBoundary(boundaryControl(jsonText(markerOriginal), jsonText('---'), markerOriginal)).status, 'pass', 'Closed JSON source/string boundaries are also explicit and safe for literal marker characters');
  console.log(JSON.stringify({ diagnostic: 'synthetic-only boundary controls', open: { input: openControl.actual.provider_resource_text, output: openControl.actual.openai_compatible.output, verdict: judgePromptBoundary(openControl).status }, closed: { input: closedControl.actual.provider_resource_text, output: closedControl.actual.openai_compatible.output, verdict: judgePromptBoundary(closedControl).status } }));
  const legacyWork = `${work}-v1`;
  await registerRoot(legacyWork, '原 v1 兼容自测运行副本');
  try {
    const legacyRun = await runEvaluation({ dataset: legacyDataset, 'source-root': root, 'output-run': path.join(fixture, 'legacy-run'), 'run-id': `${runId}-v1`, phase: 'selftest' });
    assert.equal(legacyRun.dataset.scoring_rule_version, 'kb-recall-mechanical-v1', 'Archived manifest rule version must not be relabeled as the latest rule');
  } finally { await retireRoot(legacyWork); }
  assert.ok(byId.A1.actual.calls.some(item => item.function === 'createProductionPiKnowledgeRuntime.retrieveChat'));
  assert.ok(byId.A1.actual.calls.some(item => item.function === 'KnowledgeRetriever.retrieve'));
  assert.ok(byId.H1.actual.calls.some(item => item.function === 'PersonalMemoryRecallHarness.prepareTurnContext'));
  assert.ok(run.adapter.imported_files.some(item => item.path === 'src/plugin/pi-production-runtime-composition.ts'));
  console.log('PASS: v1/v2 freeze and run metadata, digest rejection, real production retrieval/Recall, inapplicable candidate and revision assertions, output/14-column CSV with unmeasured blanks.');
  }
  if (!process.argv.includes('--history-only') && !process.argv.includes('--candidate-error-only')) await testCurrentProjectScope();
  if (!process.argv.includes('--scope-only') && !process.argv.includes('--candidate-error-only')) await testMemoryRecallHistory();
  if (!process.argv.includes('--scope-only') && !process.argv.includes('--history-only')) await testMemoryCandidateError();
} finally {
  for (const directory of [...registeredRoots].reverse()) await retireRoot(directory);
}
