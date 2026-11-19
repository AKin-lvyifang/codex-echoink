// @ts-nocheck -- bundled against the explicitly supplied source checkout.
// Separate entry: the original evaluator still bundles historical checkouts
// which do not have the new candidate collector.
import { KnowledgeAgentIndex } from '@production/knowledge-base/knowledge-agent-index';
import { VaultBodySearch } from '@production/knowledge-base/vault-body-search';
import { collectChatKnowledgeCandidates } from '@production/knowledge-base/chat-knowledge-candidates';
import { getKnowledgeFolderBindings, normalizeKnowledgeFolderBindings, registerKnowledgeFolderBindings } from '@production/knowledge-base/root-paths';
import { createProductionPiKnowledgeRuntime } from '@production/plugin/pi-production-runtime-composition';
import { syntheticVaultHost } from './production-adapter';

export async function evaluateKnowledgePick({ vaultPath, statePath, manifest, item, runId }) {
  const setup = item.setup ?? {};
  if (setup.mutations?.length) throw new Error('Knowledge-pick collect does not apply mutation scenarios');
  if (setup.explicit_paths?.length) throw new Error('Ordinary-chat baseline requires explicit_paths=[]');
  const calls = [];
  async function observe(name, request, callback) {
    const before = performance.now();
    try {
      const result = await callback();
      calls.push({ function: name, request, elapsedMs: performance.now() - before, outcome: 'returned' });
      return result;
    } catch (error) {
      calls.push({ function: name, request, elapsedMs: performance.now() - before, outcome: 'threw', error: String(error) });
      throw error;
    }
  }
  const bindings = structuredClone(setup.folder_bindings ?? manifest.settings?.folder_bindings ?? manifest.folder_bindings);
  if (setup.settings_override?.search_journal !== undefined && bindings?.roles?.journal) bindings.roles.journal.searchEnabled = setup.settings_override.search_journal;
  let unregister;
  try {
    if (bindings) {
      const normalized = normalizeKnowledgeFolderBindings(bindings);
      if (!normalized) throw new Error('Invalid dataset folder_bindings');
      unregister = registerKnowledgeFolderBindings(vaultPath, () => normalized);
    }
    const host = syntheticVaultHost(vaultPath, setup.opened_paths ?? [], setup.active_path, setup.read_failures ?? []);
    const index = new KnowledgeAgentIndex({ vaultPath, storageRootPath: statePath,
      ...(VaultBodySearch ? { bodySearch: new VaultBodySearch(host, () => getKnowledgeFolderBindings(vaultPath), { excludedRoots: () => manifest.settings?.excluded_directories ?? [] }) } : {}) });
    const initialRefresh = await observe('KnowledgeAgentIndex.refresh', {}, () => index.refresh());
    // Call the ordinary production entry, including its fixed limit:6, scope,
    // reference builder, navigation fit and final secureVaultToolResult budget.
    // A generic KnowledgeRetriever.retrieve() defaults to 20 and is not A.
    const production = createProductionPiKnowledgeRuntime({ vaultRootPath: vaultPath, knowledgeAgentIndex: index, knowledgePreferences: {}, usage: {} });
    const request = {
      vaultId: `pick-${runId}`, conversationId: `pick-${runId}-${item.case_id}`,
      productRunId: `${runId}-${item.case_id}`, question: item.query,
      explicitPaths: [], includeUnrefined: setup.include_unrefined ?? manifest.settings?.include_unrefined ?? false
    };
    const chat = await observe('createProductionPiKnowledgeRuntime.retrieveChat', request, () => production.retrieveChat(request));
    const candidatePages = [];
    const search = index.search.bind(index);
    index.search = request => observe('KnowledgeAgentIndex.search.candidates', request, async () => {
      const page = await search(request);
      candidatePages.push(page);
      return page;
    });
    const candidates = await observe('collectChatKnowledgeCandidates', { question: item.query }, () => collectChatKnowledgeCandidates({ vaultPath, agentIndex: index, question: item.query }));
    const receivedSources = chat.status === 'ready' ? JSON.parse(chat.providerResourceText).sources : [];
    if (!Array.isArray(receivedSources) || receivedSources.length !== chat.references.length) throw new Error('Ordinary-chat final reference/text receipt count mismatch');
    const paths = [...new Set(chat.references.map(reference => reference.vaultRelativePath))];
    return {
      ...candidates,
      baselineA: {
        ...chat, receivedReferenceCount: receivedSources.length, receivedNoteCount: paths.length,
        receivedPaths: paths, layer: 'final_delivery',
        method: 'createProductionPiKnowledgeRuntime.retrieveChat; ordinary explicitPaths=[]; production limit:6; returned final references and providerResourceText'
      },
      calls, candidatePages, initialRefresh,
      hostAdapters: ['synthetic Vault filesystem/metadata; unchanged production ranking, filtering and ordinary-chat delivery'],
      audit: {
        directoryBindings: bindings ?? null, recentNotUsedByLocalSearch: item.recent ?? [],
        injectedReadFailures: host.readFailureEvents,
        baselineAPreflightMode: 'chat', modelCalls: 0, networkCalls: 0
      }
    };
  } finally { unregister?.(); }
}
