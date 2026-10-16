// @ts-nocheck -- built against the explicit source checkout, like production-adapter.ts.
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { KnowledgeAgentIndex } from '@production/knowledge-base/knowledge-agent-index';
import { KnowledgeRetriever } from '@production/knowledge-base/query';
import { emptyKnowledgeFolderBindings, registerKnowledgeFolderBindings, knowledgeRootRole } from '@production/knowledge-base/root-paths';
import { createProductionPiKnowledgeRuntime } from '@production/plugin/pi-production-runtime-composition';

export async function discoverPerformanceBindings(vaultPath) {
  const bindings = emptyKnowledgeFolderBindings();
  bindings.configured = true;
  const unbound = [];
  const batches = (await fs.readdir(vaultPath, { withFileTypes: true })).filter(entry => entry.isDirectory() && /^批次\d{2}$/u.test(entry.name)).map(entry => entry.name).sort();
  for (const batch of batches) {
    for (const child of await fs.readdir(path.join(vaultPath, batch), { withFileTypes: true })) {
      if (!child.isDirectory()) continue;
      const relative = `${batch}/${child.name}`;
      const role = knowledgeRootRole(child.name);
      if (role) bindings.roles[role].readPaths.push(relative);
      else unbound.push(relative);
    }
  }
  for (const binding of Object.values(bindings.roles)) {
    binding.readPaths.sort();
    binding.enabled = binding.readPaths.length > 0;
    binding.writePath = binding.readPaths[0] ?? null;
    binding.compatibilityReadScopes = binding.readPaths.length > 1;
  }
  return { bindings, batches, unbound_directories: unbound.sort() };
}

function memory() {
  return { at: new Date().toISOString(), ...process.memoryUsage(), process_max_rss_bytes: process.resourceUsage().maxRSS * 1024 };
}

async function measured(callback) {
  const before = memory();
  const sampled = { rss: before.rss, heapUsed: before.heapUsed, external: before.external, arrayBuffers: before.arrayBuffers };
  const timer = setInterval(() => {
    const current = process.memoryUsage();
    for (const key of Object.keys(sampled)) sampled[key] = Math.max(sampled[key], current[key]);
  }, 10);
  const started = performance.now();
  try {
    const value = await callback();
    const elapsed = performance.now() - started;
    const after = memory();
    for (const key of Object.keys(sampled)) sampled[key] = Math.max(sampled[key], after[key]);
    return { value, elapsed_ms: elapsed, memory_before: before, memory_after: after, sampled_peak_bytes: sampled };
  } finally { clearInterval(timer); }
}

export async function runPerformanceWorker(input) {
  const { vaultPath, statePath, bindings, question, coldRound, warmRepeats, runId } = input;
  const unregister = registerKnowledgeFolderBindings(vaultPath, () => bindings);
  try {
    const assemblyStart = performance.now();
    const index = new KnowledgeAgentIndex({ vaultPath, storageRootPath: statePath });
    const retriever = new KnowledgeRetriever(vaultPath, { agentIndex: index });
    const production = createProductionPiKnowledgeRuntime({ vaultRootPath: vaultPath, knowledgeAgentIndex: index, knowledgePreferences: {}, usage: {} });
    const assemblyMs = performance.now() - assemblyStart;
    const initialization = await measured(() => index.refresh());
    const stored = JSON.parse(await fs.readFile(initialization.value.indexPath, 'utf8'));
    const kinds = Object.values(stored.entries).reduce((counts, entry) => ({ ...counts, [entry.kind]: (counts[entry.kind] ?? 0) + 1 }), {});
    if (initialization.value.entries <= 0 || ['wiki', 'projects', 'raw'].some(kind => !(kinds[kind] > 0))) throw new Error(`Empty/incomplete index cannot produce a performance result: ${JSON.stringify(kinds)}`);
    const samples = [];
    async function probe(temperature, repetition) {
      const request = { vaultId: `perf-${runId}`, conversationId: 'script-performance', piSessionId: `perf-${coldRound}`, productRunId: `${runId}-${temperature}-${repetition}`, question, explicitPaths: [], includeUnrefined: false };
      const candidate = await measured(() => index.search({ query: question, limit: 50 }));
      const direct = await measured(() => retriever.retrieve({ question, explicitPaths: [], includeUnrefined: false }));
      const chat = await measured(() => production.retrieveChat(request));
      const ask = await measured(() => production.retrieveAsk(request));
      samples.push({
        temperature, cold_round: coldRound, repetition, question,
        constructor_and_assembly_ms: temperature === 'cold' ? assemblyMs : null,
        initialization: temperature === 'cold' ? { ...initialization, value: initialization.value } : null,
        index_entry_count: initialization.value.entries, index_entries_by_kind: kinds,
        calls: [
          { function: 'KnowledgeAgentIndex.search', ...candidate },
          { function: 'KnowledgeRetriever.retrieve', ...direct },
          { function: 'createProductionPiKnowledgeRuntime.retrieveChat', ...chat },
          { function: 'createProductionPiKnowledgeRuntime.retrieveAsk', ...ask }
        ],
        process_memory: memory()
      });
    }
    await probe('cold', 1);
    for (let repetition = 1; repetition <= warmRepeats; repetition++) await probe('warm', repetition);
    return { pid: process.pid, samples, process_final_memory: memory() };
  } finally { unregister(); }
}

if (process.argv[2] === '--worker-config') {
  try {
    const input = JSON.parse(await fs.readFile(process.argv[3], 'utf8'));
    const result = await runPerformanceWorker(input);
    await fs.writeFile(input.resultPath, JSON.stringify(result), 'utf8');
  } catch (error) { console.error(error.stack ?? String(error)); process.exitCode = 1; }
}
