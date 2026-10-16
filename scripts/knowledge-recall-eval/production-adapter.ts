// The only production-dependent adapter. Assertions live separately in judge.mjs.
// @ts-nocheck -- bundled against the explicitly supplied source checkout.
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { KnowledgeAgentIndex } from '@production/knowledge-base/knowledge-agent-index';
import { KnowledgeRetriever } from '@production/knowledge-base/query';
import { registerKnowledgeFolderBindings, normalizeKnowledgeFolderBindings } from '@production/knowledge-base/root-paths';
import { createProductionPiKnowledgeRuntime, createPiKnowledgeInlineExtension } from '@production/plugin/pi-production-runtime-composition';
import { PersonalMemoryRepository } from '@production/harness/memory/personal-memory-repository';
import { PersonalMemoryRecallHarness } from '@production/harness/memory/personal-memory-recall-harness';
import { serializeSecondaryRecord } from '@production/harness/memory/secondary-memory-store';

const inside = (root, relative) => {
  if (typeof relative !== 'string' || !relative || relative.includes('\\') || relative.startsWith('/') || relative.split('/').some(part => !part || part === '.' || part === '..')) throw new Error(`Unsafe setup path: ${relative}`);
  return path.join(root, ...relative.split('/'));
};

/** Also usable with a native Repository: keep the returned stable->actual ID map. */
export async function writeMemorySeed(repository, seed, runtime, beforeWrite = () => undefined, invoke = async (_name, _request, callback) => callback()) {
  const idMap = {};
  const results = [];
  for (const operation of seed.operations ?? []) {
    beforeWrite(operation);
    const request = { ...operation.request };
    if (request.targetId) request.targetId = idMap[request.targetId] ?? request.targetId;
    const result = await invoke('PersonalMemoryRepository.write', request, () => repository.write(request, { ...runtime, explicitlyAuthorized: true }));
    if (result.status === 'possible_duplicate') throw new Error(`Seed write reported possible_duplicate for ${operation.id}; fixture was not imported as requested`);
    if (result.record) idMap[operation.id] = result.record.id;
    results.push(result);
  }
  return { id_map: idMap, results };
}

export async function evaluateProduction(input) {
  const { vaultPath, statePath, datasetPath, manifest, item, runId } = input;
  const setup = item.setup ?? {};
  const calls = [];
  async function observe(name, request, callback) {
    const start = performance.now();
    try {
      const value = await callback();
      calls.push({ function: name, request, elapsed_ms: performance.now() - start, outcome: 'returned' });
      return value;
    } catch (error) {
      calls.push({ function: name, request, elapsed_ms: performance.now() - start, outcome: 'threw', error: String(error) });
      throw error;
    }
  }
  const runtime = {
    vaultId: `eval-${runId}`, conversationId: `eval-${item.case_id}`,
    piSessionId: `eval-${item.case_id}`, productRunId: `${runId}-${item.case_id}-${item.subcase_id ?? 'main'}`,
    userEntryId: `seed-${item.case_id}`, memoryMode: 'normal'
  };
  let unregister;
  let repository;
  let candidateEvidence;
  try {
    const savedBindings = setup.folder_bindings ?? manifest.settings?.folder_bindings ?? manifest.folder_bindings;
    if (savedBindings) {
      const bindings = normalizeKnowledgeFolderBindings(savedBindings);
      if (!bindings) throw new Error('Invalid dataset folder_bindings');
      unregister = registerKnowledgeFolderBindings(vaultPath, () => bindings);
    }
    if (item.domain === 'memory' || item.case_id.startsWith('H')) {
      let nextId;
      const seedPaths = setup.memory_seed ? (Array.isArray(setup.memory_seed) ? setup.memory_seed : [setup.memory_seed]) : [];
      const seeds = await Promise.all(seedPaths.map(async seedPath => JSON.parse(await fs.readFile(inside(datasetPath, seedPath), 'utf8'))));
      const secondaryRecords = seeds.flatMap(seed => seed.secondary_records ?? []);
      const validatedSecondaryIds = [];
      for (const record of secondaryRecords) {
        try {
          // Use the exact production serializer/normalizer before the provider
          // seam. Validation must not silently repair or replace frozen fields.
          await observe('serializeSecondaryRecord.fixtureValidation', { id: record.id }, () => serializeSecondaryRecord(record));
          validatedSecondaryIds.push(record.id);
        } catch (error) {
          const invalidFixture = { key: 'memory_seed.secondary_records', classification: 'invalid_fixture', blocks_standard_setup: true, record_id: record.id, reason: String(error) };
          return {
            candidate_items: [], delivery_items: [], provider_text: '', calls,
            raw: { fixture_validation: { status: 'invalid_fixture', ...invalidFixture } },
            host_adapters: ['Frozen synthetic secondary records were rejected by the production serializer before Repository/Recall execution.'],
            unsupported_setup: [...unsupportedSetup(setup), invalidFixture]
          };
        }
      }
      let timestamp = Date.parse(setup.fixed_now ?? seeds[0]?.clock ?? manifest.fixed_date ?? manifest.fixed_today ?? '2026-10-16T12:00:00+08:00');
      if (!Number.isFinite(timestamp)) throw new Error('Invalid fixed_date');
      repository = new PersonalMemoryRepository({
        vaultPath, vaultId: runtime.vaultId, now: () => ++timestamp,
        idFactory: () => { if (!nextId) throw new Error('Memory seed must supply a stable ID for each create/supersede'); return nextId; },
        secondaryRecordsProvider: async () => secondaryRecords,
        watchExternalChanges: false
      });
      await observe('PersonalMemoryRepository.initialize', {}, () => repository.initialize());
      const seedResults = [];
      for (const seed of seeds) {
        seedResults.push(await writeMemorySeed(repository, seed, runtime, operation => { nextId = operation.id; }, observe));
      }
      const searchRequest = { query: item.query, limit: 50, ...(setup.memory_search ?? {}) };
      const pages = [];
      let page;
      do {
        const request = { ...searchRequest, ...(page?.nextCursor ? { cursor: page.nextCursor } : {}) };
        page = await observe('PersonalMemoryRepository.search', request, () => repository.search(request, runtime));
        pages.push(page);
        if (pages.length > 1000) throw new Error('Memory pagination did not terminate');
      } while (page.nextCursor);
      candidateEvidence = { candidate_items: pages.flatMap(value => value.items), raw_candidate_pages: pages };
      const harness = new PersonalMemoryRecallHarness(repository);
      let prepared;
      const handlers = new Map();
      const extension = createPiKnowledgeInlineExtension({
        vaultSecurity: { name: 'eval-host-adapter', factory: async () => undefined },
        currentTurn: () => null,
        currentMemoryTurn: () => ({ ...runtime, query: item.query, recentConversation: item.recent_conversation ?? setup.recent_conversation ?? [] }),
        personalMemory: {
          loadFixedContext: request => repository.loadFixedContext(request),
          prepareTurnContext: async request => (prepared = await observe('PersonalMemoryRecallHarness.prepareTurnContext', request, () => harness.prepareTurnContext(request)))
        },
        personalMemoryRecallTokenBudget: setup.memory_token_budget ?? 1200,
        personalMemoryAvailable: true
      });
      await extension.factory({ on: (name, handler) => handlers.set(name, handler) });
      const before = await observe('createPiKnowledgeInlineExtension.before_agent_start', { prompt: item.query }, () => handlers.get('before_agent_start')({ systemPrompt: 'EchoInk offline evaluation', prompt: item.query }));
      const context = await observe('createPiKnowledgeInlineExtension.context', { query: item.query }, () => handlers.get('context')({ messages: [{ role: 'user', content: item.query, timestamp }] }));
      const text = context.messages.filter(message => message.role === 'custom' && message.customType === 'echoink-personal-memory-context-v1').map(message => message.content).join('\n');
      // Decode the production serialization, not a reconstructed recall payload.
      const block = text.match(/<echoink_memory_recall\b[^>]*>\n([\s\S]*?)\n<\/echoink_memory_recall>/u);
      const secondaryBlock = text.match(/<echoink_memory_secondary\b[^>]*>\n([\s\S]*?)\n<\/echoink_memory_secondary>/u);
      const delivered = [...(block ? JSON.parse(block[1]).candidates : []), ...(secondaryBlock ? JSON.parse(secondaryBlock[1]).secondaryFacts.map(entry => entry.fact) : [])];
      return {
        candidate_items: pages.flatMap(value => value.items), delivery_items: delivered,
        provider_text: text, calls, raw: { fixture_validation: { status: 'valid', secondary_ids: validatedSecondaryIds, method: 'serializeSecondaryRecord (calls normalizeAssociationClueFields); provider fields unchanged' }, seed_results: seedResults, repository_search: pages, prepared_turn: prepared, before_agent_start: before, context },
        host_adapters: ['synthetic Vault and runtime IDs', 'deterministic Repository idFactory/now', 'Repository secondaryRecordsProvider from frozen synthetic SecondaryMemoryRecord records', 'Pi event registration host only; production handler and serialization unchanged'],
        unsupported_setup: unsupportedSetup(setup)
      };
    }

    const index = new KnowledgeAgentIndex({ vaultPath, storageRootPath: statePath });
    const initialRefresh = await observe('KnowledgeAgentIndex.refresh', {}, () => index.refresh());
    const mutationResults = [];
    if (setup.mutations?.length) {
      // Warm the real index before mutation, then send the same invalidate event
      // the host sends. Rebuilding a fresh index after mutation would mask I2.
      const before = await observe('KnowledgeAgentIndex.search.beforeMutation', { query: item.query, limit: 50 }, () => index.search({ query: item.query, limit: 50 }));
      mutationResults.push({ before });
      for (const mutation of setup.mutations) {
        const full = inside(vaultPath, mutation.path);
        if (mutation.action === 'write') { await fs.mkdir(path.dirname(full), { recursive: true }); await fs.writeFile(full, mutation.content, 'utf8'); }
        else if (mutation.action === 'delete') await fs.unlink(full);
        else if (mutation.action === 'rename') { const to = inside(vaultPath, mutation.to); await fs.mkdir(path.dirname(to), { recursive: true }); await fs.rename(full, to); }
        else throw new Error(`Unsupported mutation: ${mutation.action}`);
        index.invalidate(mutation.path);
        if (mutation.to) index.invalidate(mutation.to);
        mutationResults.push({ action: mutation.action, path: mutation.path, to: mutation.to });
      }
    }
    const pages = [];
    let page;
    do {
      const request = { query: item.query, limit: 50, ...(page?.continuationCursor ? { cursor: page.continuationCursor } : {}) };
      page = await observe('KnowledgeAgentIndex.search', request, () => index.search(request));
      pages.push(page);
      if (pages.length > 1000) throw new Error('Knowledge pagination did not terminate');
    } while (page.hasMore && page.continuationCursor);
    candidateEvidence = { candidate_items: pages.flatMap(value => value.hits), raw_candidate_pages: pages };
    const retriever = new KnowledgeRetriever(vaultPath, { agentIndex: index });
    const retrievalRequest = { question: item.query, explicitPaths: setup.explicit_paths ?? [], includeUnrefined: setup.include_unrefined ?? manifest.settings?.include_unrefined ?? false };
    const retrieved = await observe('KnowledgeRetriever.retrieve', retrievalRequest, () => retriever.retrieve(retrievalRequest));
    const production = createProductionPiKnowledgeRuntime({ vaultRootPath: vaultPath, knowledgeAgentIndex: index, knowledgePreferences: {}, usage: {} });
    const request = { ...runtime, ...retrievalRequest };
    const chat = await observe('createProductionPiKnowledgeRuntime.retrieveChat', request, () => production.retrieveChat(request));
    const ask = await observe('createProductionPiKnowledgeRuntime.retrieveAsk', request, () => production.retrieveAsk(request));
    const selectedMode = setup.preflight_mode ?? manifest.settings?.preflight_mode ?? 'chat';
    if (!['chat', 'ask'].includes(selectedMode)) throw new Error(`Unknown preflight mode: ${selectedMode}`);
    const selected = selectedMode === 'ask' ? ask : chat;
    return {
      candidate_items: pages.flatMap(value => value.hits), delivery_items: selected.references,
      provider_text: selected.providerResourceText, calls,
      raw: { initial_refresh: initialRefresh, mutations: mutationResults, index_search: pages, retriever: retrieved, production_chat: chat, production_ask: ask, scored_delivery: selectedMode },
      effective_configuration: {
        retrieval_request: retrievalRequest, selected_preflight: selectedMode,
        directory_bindings: savedBindings ?? null,
        knowledge_preferences_repository: 'Empty host adapter; only maintenance methods use it. retrieveChat/retrieveAsk do not consult this repository.',
        explicit_path_override_vs_native_chat: retrievalRequest.explicitPaths.length > 0 ? 'Function-level explicitPaths override; ordinary native chat preflight passes []. This is not a native noteMention test.' : null,
        opened_paths_applied: false, history_applied_to_knowledge_preflight: false,
        host_hints: { opened_paths: setup.opened_paths ?? [], history: setup.history ?? [] }
      },
      host_adapters: ['synthetic Vault', 'Knowledge directory binding registration', 'host modify/rename/delete invalidation events'],
      unsupported_setup: unsupportedSetup(setup)
    };
  } catch (error) {
    error.evaluator_evidence = { ...candidateEvidence, calls };
    throw error;
  } finally {
    unregister?.();
    await repository?.dispose();
  }
}

function unsupportedSetup(setup) {
  const known = new Set(['folder_bindings', 'memory_seed', 'memory_search', 'memory_token_budget', 'recent_conversation', 'mutations', 'explicit_paths', 'include_unrefined', 'preflight_mode', 'isolation', 'restore', 'reload_plugin', 'project', 'fixed_now', 'timezone', 'query_terms_only_in_aliases', 'query_terms_only_in_tags', 'preserve_settings', 'model_must_derive_date_range']);
  return Object.entries(setup).filter(([key, value]) => !known.has(key) && value !== undefined && value !== null && value !== false && (!Array.isArray(value) || value.length)).map(([key, value]) => {
    const productionDoesNotConsume = ['opened_paths', 'history'].includes(key);
    return { key, value, blocks_standard_setup: !productionDoesNotConsume,
      classification: productionDoesNotConsume ? 'host_hint_not_consumed_by_existing_preflight_api' : 'script_host_precondition_not_executed',
      reason: productionDoesNotConsume ? 'Existing Knowledge search/retriever/preflight APIs accept question and explicit paths, not open-file/history hints. Actual original query is run unchanged; full native host interaction is not exercised.' : 'Standard setup has not been performed by this script. Diagnostic output is retained; this check is blocked, not a product failure.' };
  });
}
