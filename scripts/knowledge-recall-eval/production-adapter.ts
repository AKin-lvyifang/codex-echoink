// The only production-dependent adapter. Assertions live separately in judge.mjs.
// @ts-nocheck -- bundled against the explicitly supplied source checkout.
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import { parse as parseYaml } from 'yaml';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { KnowledgeAgentIndex } from '@production/knowledge-base/knowledge-agent-index';
import { KnowledgeRetriever } from '@production/knowledge-base/query';
import { VaultBodySearch } from '@production/knowledge-base/vault-body-search';
import { getKnowledgeFolderBindings, registerKnowledgeFolderBindings, normalizeKnowledgeFolderBindings } from '@production/knowledge-base/root-paths';
import { bindKnowledgeIndexToVault, createProductionPiKnowledgeRuntime, createPiKnowledgeInlineExtension } from '@production/plugin/pi-production-runtime-composition';
import { PersonalMemoryRepository } from '@production/harness/memory/personal-memory-repository';
import { PersonalMemoryRecallHarness } from '@production/harness/memory/personal-memory-recall-harness';
import { serializeSecondaryRecord } from '@production/harness/memory/secondary-memory-store';
import { capturePromptBoundary } from './prompt-boundary-adapter';

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
  let unbindIndexEvents;
  let vaultEventSource;
  let vaultEventBinding;
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
      let scopedCandidates;
      if (typeof setup.project === 'string') {
        await observe('PersonalMemoryRepository.prepareTurnSnapshot.projectCandidates', { query: item.query, scope: setup.project }, () => repository.prepareTurnSnapshot({
          memoryMode: 'normal', query: item.query, scope: setup.project,
          selectCandidateIds(candidates) { scopedCandidates = [...candidates]; return []; }
        }, runtime));
      }
      candidateEvidence = { candidate_items: pages.flatMap(value => value.items), raw_candidate_pages: pages };
      const harness = new PersonalMemoryRecallHarness(repository);
      let prepared;
      const handlers = new Map();
      const extension = createPiKnowledgeInlineExtension({
        vaultSecurity: { name: 'eval-host-adapter', factory: async () => undefined },
        currentTurn: () => null,
        currentMemoryTurn: () => ({ ...runtime, ...(typeof setup.project === 'string' ? { projectId: setup.project } : {}), query: item.query, recentConversation: item.recent_conversation ?? setup.recent_conversation ?? [] }),
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
        candidate_items: scopedCandidates ?? pages.flatMap(value => value.items), delivery_items: delivered,
        provider_text: text, calls, raw: { fixture_validation: { status: 'valid', secondary_ids: validatedSecondaryIds, method: 'serializeSecondaryRecord (calls normalizeAssociationClueFields); provider fields unchanged' }, seed_results: seedResults, repository_search: pages, prepared_turn: prepared, before_agent_start: before, context },
        host_adapters: ['synthetic Vault and runtime IDs', 'deterministic Repository idFactory/now', 'Repository secondaryRecordsProvider from frozen synthetic SecondaryMemoryRecord records', 'Pi event registration host only; production handler and serialization unchanged'],
        unsupported_setup: unsupportedSetup(setup)
      };
    }

    const host = syntheticVaultHost(vaultPath, setup.opened_paths ?? []);
    const index = new KnowledgeAgentIndex({ vaultPath, storageRootPath: statePath,
      ...(VaultBodySearch ? { bodySearch: new VaultBodySearch(host, () => getKnowledgeFolderBindings(vaultPath), { excludedRoots: () => manifest.settings?.excluded_directories ?? [] }) } : {}) });
    if (setup.mutations?.length) {
      vaultEventSource = new EventEmitter();
      const app = { vault: {
        on(name, handler) { vaultEventSource.on(name, handler); return { name, handler }; },
        offref(reference) { vaultEventSource.off(reference.name, reference.handler); }
      } };
      unbindIndexEvents = await observe('bindKnowledgeIndexToVault', { event_source: 'synthetic Vault EventEmitter' }, () => bindKnowledgeIndexToVault(app, index));
      vaultEventBinding = { producer_binding: 'bindKnowledgeIndexToVault', event_source: 'synthetic Vault EventEmitter', bound: true, unbound: false };
    }
    const initialRefresh = await observe('KnowledgeAgentIndex.refresh', {}, () => index.refresh());
    const mutationResults = [];
    if (setup.mutations?.length) {
      // Warm the real index, then deliver synthetic host events through the
      // unchanged production binding. Never call index.invalidate directly.
      const before = await observe('KnowledgeAgentIndex.search.beforeMutation', { query: item.query, limit: 50 }, () => index.search({ query: item.query, limit: 50 }));
      mutationResults.push({ before });
      for (const mutation of setup.mutations) {
        const full = inside(vaultPath, mutation.path);
        let event;
        let eventPath = mutation.path;
        let oldPath;
        if (mutation.action === 'write') {
          let existed;
          try { await fs.lstat(full); existed = true; } catch (error) { if (error.code !== 'ENOENT') throw error; existed = false; }
          await fs.mkdir(path.dirname(full), { recursive: true }); await fs.writeFile(full, mutation.content, 'utf8');
          event = existed ? 'modify' : 'create';
        }
        else if (mutation.action === 'delete') { await fs.unlink(full); event = 'delete'; }
        else if (mutation.action === 'rename') { const to = inside(vaultPath, mutation.to); await fs.mkdir(path.dirname(to), { recursive: true }); await fs.rename(full, to); event = 'rename'; eventPath = mutation.to; oldPath = mutation.path; }
        else throw new Error(`Unsupported mutation: ${mutation.action}`);
        const notification = await observe(`bindKnowledgeIndexToVault.handler.${event}`, { path: eventPath, old_path: oldPath ?? null }, () => {
          if (!vaultEventSource.emit(event, { path: eventPath }, ...(oldPath === undefined ? [] : [oldPath]))) throw new Error(`No production listener registered for ${event}`);
          return { event, path: eventPath, old_path: oldPath ?? null, producer_binding: 'bindKnowledgeIndexToVault', event_source: 'synthetic Vault EventEmitter', handler_completed: true, refresh_behavior: 'Production synchronous callback returned; lazy index refresh occurs on next search.' };
        });
        mutationResults.push({ action: mutation.action, path: mutation.path, to: mutation.to, notification });
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
    const promptBoundary = item.expected?.delivery?.boundary_contract
      ? await capturePromptBoundary({ chat, question: item.query, regressionFixture: item.regression_fixture, vaultPath, observe })
      : null;
    const selectedMode = setup.preflight_mode ?? manifest.settings?.preflight_mode ?? 'chat';
    if (!['chat', 'ask'].includes(selectedMode)) throw new Error(`Unknown preflight mode: ${selectedMode}`);
    const selected = selectedMode === 'ask' ? ask : chat;
    return {
      candidate_items: pages.flatMap(value => value.hits), delivery_items: selected.references,
      provider_text: selected.providerResourceText, calls,
      ...(promptBoundary ? { prompt_boundary: promptBoundary } : {}),
      raw: { initial_refresh: initialRefresh, vault_event_binding: vaultEventBinding ?? null, mutations: mutationResults, index_search: pages, retriever: retrieved, production_chat: chat, production_ask: ask, scored_delivery: selectedMode },
      effective_configuration: {
        retrieval_request: retrievalRequest, selected_preflight: selectedMode,
        directory_bindings: savedBindings ?? null,
        knowledge_preferences_repository: 'Empty host adapter; only maintenance methods use it. retrieveChat/retrieveAsk do not consult this repository.',
        explicit_path_override_vs_native_chat: retrievalRequest.explicitPaths.length > 0 ? 'Function-level explicitPaths override; ordinary native chat preflight passes []. This is not a native noteMention test.' : null,
        opened_paths_applied: Boolean(VaultBodySearch), history_applied_to_knowledge_preflight: false,
        host_hints: { opened_paths: setup.opened_paths ?? [], history: setup.history ?? [] }
      },
      host_adapters: ['synthetic Vault', 'Knowledge directory binding registration', ...(vaultEventBinding ? ['Synthetic Vault event source; unchanged production bindKnowledgeIndexToVault handlers. Native Obsidian event delivery/timeliness is not measured.'] : [])],
      unsupported_setup: unsupportedSetup(setup)
    };
  } catch (error) {
    error.evaluator_evidence = { ...candidateEvidence, calls };
    throw error;
  } finally {
    unbindIndexEvents?.();
    if (vaultEventBinding) {
      vaultEventBinding.unbound = true;
      vaultEventBinding.listeners_remaining = vaultEventSource.eventNames().reduce((count, name) => count + vaultEventSource.listenerCount(name), 0);
    }
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

// Synthetic public-API host; it only adapts file access and metadata. Ranking,
// filtering, positions and delivery use the unchanged production implementation.
function syntheticVaultHost(root, openedPaths) {
  const file = relative => {
    const stat = fsSync.statSync(inside(root, relative));
    return { path: relative, basename: path.basename(relative, path.extname(relative)), extension: path.extname(relative).slice(1), stat: { mtime: stat.mtimeMs, ctime: stat.ctimeMs, size: stat.size } };
  };
  const files = () => {
    const result = [];
    const walk = directory => {
      for (const entry of fsSync.readdirSync(path.join(root, directory), { withFileTypes: true })) {
        if (entry.name.startsWith('.')) continue;
        const relative = directory ? `${directory}/${entry.name}` : entry.name;
        if (entry.isDirectory()) walk(relative);
        else if (entry.isFile() && /\.(md|markdown)$/iu.test(relative)) result.push(file(relative));
      }
    };
    walk(''); return result;
  };
  return {
    vault: { getMarkdownFiles: files, getAbstractFileByPath(relative) { try { return file(relative); } catch { return null; } }, read: item => fs.readFile(inside(root, item.path), 'utf8') },
    metadataCache: { getFileCache(item) {
      const content = fsSync.readFileSync(inside(root, item.path), 'utf8');
      const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(content);
      return { frontmatter: frontmatter ? parseYaml(frontmatter[1]) : {}, tags: [...content.matchAll(/(?:^|\s)#([\p{L}\p{N}_/-]+)/gu)].map(match => ({ tag: `#${match[1]}` })) };
    } },
    workspace: { getActiveFile: () => openedPaths[0] ? file(openedPaths[0]) : null, getLastOpenFiles: () => openedPaths }
  };
}
