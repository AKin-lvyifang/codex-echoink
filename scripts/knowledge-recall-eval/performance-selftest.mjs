import { disposableTestRoot } from "../disposable-test-root.mjs";
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPerformance, nearestRank } from './performance.mjs';

process.env.PI_OFFLINE = '1';
const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const temporary = disposableTestRoot(path.join(os.homedir(), 'EchoInk-TestVaults/90-任务临时'));
await fs.mkdir(temporary, { recursive: true });
const fixture = await fs.mkdtemp(path.join(temporary, '知识库-召回评测-perf-smoke-'));
const runId = `performance-selftest-${process.pid}-${Date.now()}`;
const workRoot = path.join(temporary, `知识库-召回评测-${runId}`);
try {
  for (const role of ['wiki', 'projects', 'raw']) {
    const directory = path.join(fixture, 'source', '批次01', role);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, 'note.md'), `# ${role} fixture\n知识管理记录：只供性能入口烟测。\n`, 'utf8');
  }
  const output = path.join(fixture, 'result');
  const run = await runPerformance({ 'source-root': sourceRoot, 'fixture-root': path.join(fixture, 'source'), 'output-run': output, 'run-id': runId, phase: 'performance-selftest', smoke: 'true' });
  const samples = (await fs.readFile(path.join(output, 'samples.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(samples.length, 3);
  assert.equal(run.definition.smoke_only, true);
  assert.equal(run.performance.cold.functions['KnowledgeAgentIndex.search'].n, 1);
  assert.equal(run.performance.warm.functions['KnowledgeAgentIndex.search'].n, 2);
  assert.ok(samples.every(sample => sample.index_entry_count === 3));
  assert.ok(samples.every(sample => sample.calls.length === 4 && sample.calls.every(call => call.elapsed_ms >= 0)));
  assert.ok(samples.every(sample => sample.process_memory.process_max_rss_bytes > 0));
  assert.equal(run.definition.folder_configuration.bindings.roles.wiki.readPaths[0], '批次01/wiki');
  assert.equal(run.source_integrity.status, 'unchanged');
  assert.equal(run.stop_behavior.status, 'not_run');
  assert.equal(run.first_pi_runtime_initialization.status, 'not_run');
  assert.equal(run.quality_scores, null);
  assert.equal(nearestRank([9, 1, 4, 7, 6], 0.50), 6);
  assert.equal(nearestRank([9, 1, 4, 7, 6], 0.95), 9);
  console.log('PASS: independent performance workers, nonempty bound index, raw 1/2 smoke samples, nearest-rank percentiles, memory definitions, unchanged source, and explicit unmeasured stop/native initialization.');
} finally {
  await fs.rm(fixture, { recursive: true, force: true });
  await fs.rm(workRoot, { recursive: true, force: true });
}
