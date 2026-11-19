// @ts-nocheck -- bundled against the explicitly supplied production checkout.
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { KnowledgeAgentIndex } from '@production/knowledge-base/knowledge-agent-index';
import { VaultBodySearch } from '@production/knowledge-base/vault-body-search';
import { collectChatKnowledgeCandidates } from '@production/knowledge-base/chat-knowledge-candidates';
import { getKnowledgeFolderBindings, normalizeKnowledgeFolderBindings, registerKnowledgeFolderBindings } from '@production/knowledge-base/root-paths';
import { createDesktopKnowledgeSourcePathResolver, createProductionPiKnowledgeRuntime } from '@production/plugin/pi-production-runtime-composition';
import { syntheticVaultHost } from './production-adapter';
import { createCollectorProfiler, PROFILE_KEY } from './collector-profile-instrumentation.mjs';

const methods = ['collector', 'retrieveChat'];
const counterNames = ['getMarkdownFilesCalls', 'getFileCacheCalls', 'getAbstractFileByPathCalls', 'vaultReadCalls', 'realpathCalls', 'bodySearchCalls', 'bodyReadCalls', 'bodyInvalidations'];
const counters = () => Object.fromEntries(counterNames.map(name => [name, 0]));
const delta = (before, after) => Object.fromEntries(counterNames.map(name => [name, after[name] - before[name]]));
const contains = (root, target) => { const relative = path.relative(root, target); return relative === '' || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); };
const numericCoverage = coverage => Object.fromEntries(Object.entries(coverage ?? {}).filter(([, value]) => typeof value === 'number'));

async function prepareMethod({ vaultPath, statePath, copyRoot, method, expectedMarkdownFiles, profiling }) {
  const counts = counters();
  const hostStart = performance.now();
  const host = syntheticVaultHost(vaultPath, [], undefined, []);
  // Obsidian keeps File objects, its Markdown file list and metadata in memory.
  // Eagerly adapt the existing synthetic host once, then discard body strings.
  // Host preparation is measured separately from every search call.
  const files = host.vault.getMarkdownFiles();
  const fileMap = new Map(files.map(file => [file.path, file]));
  const metadataMap = new Map(files.map(file => [file.path, host.metadataCache.getFileCache(file)]));
  if (files.length !== expectedMarkdownFiles) throw new Error(`Unexpected Markdown count for ${method}: ${files.length}`);
  host.vault.getMarkdownFiles = () => { counts.getMarkdownFilesCalls++; return files; };
  host.vault.getAbstractFileByPath = relative => { counts.getAbstractFileByPathCalls++; return fileMap.get(relative) ?? null; };
  host.metadataCache.getFileCache = file => { counts.getFileCacheCalls++; return metadataMap.get(file.path) ?? null; };
  host.vault.read = async file => {
    counts.vaultReadCalls++;
    const target = path.resolve(vaultPath, file.path);
    if (!contains(vaultPath, target)) throw new Error('Read outside measured Vault rejected');
    return await fs.readFile(target, 'utf8');
  };
  const hostSetupMs = performance.now() - hostStart;
  const initStart = performance.now();
  // Production helper passes ABSOLUTE paths to adapter.realpath: both the
  // Vault root and path.join(Vault root, requested relative path). Do not join
  // the root a second time or bypass per-page canonical-identity validation.
  const resolveSourcePath = createDesktopKnowledgeSourcePathResolver({
    vaultRootPath: vaultPath,
    realpath: async absolute => {
      counts.realpathCalls++;
      if (!path.isAbsolute(absolute) || !contains(vaultPath, absolute)) throw new Error('Canonical identity request outside measured Vault rejected');
      const actual = await fs.realpath(absolute);
      if (!contains(vaultPath, actual) || !contains(copyRoot, actual)) throw new Error('Canonical identity escaped acceptance copy');
      return actual;
    }
  });
  const bodySearch = new VaultBodySearch(host, () => getKnowledgeFolderBindings(vaultPath), { resolveSourcePath });
  const pageReceipts = [];
  const search = bodySearch.search.bind(bodySearch), read = bodySearch.read.bind(bodySearch), invalidate = bodySearch.invalidate.bind(bodySearch);
  bodySearch.search = async request => {
    counts.bodySearchCalls++;
    const page = await search(request);
    pageReceipts.push({ returned: page.returned, total: page.total, remaining: page.remaining, hasMore: page.hasMore, exhausted: page.exhausted, coverage: numericCoverage(page.coverage) });
    return page;
  };
  bodySearch.read = async request => { counts.bodyReadCalls++; return await read(request); };
  bodySearch.invalidate = relative => { counts.bodyInvalidations++; return invalidate(relative); };
  const index = new KnowledgeAgentIndex({ vaultPath, storageRootPath: statePath, bodySearch });
  const production = createProductionPiKnowledgeRuntime({ vaultRootPath: vaultPath, knowledgeAgentIndex: index, knowledgePreferences: {}, usage: {} });
  const assemblyMs = performance.now() - initStart;
  const beforeRefresh = { ...counts }, refreshStart = performance.now();
  const refreshed = await index.refresh();
  const legacyRefreshMs = performance.now() - refreshStart, initMs = performance.now() - initStart;
  const refreshCounters = delta(beforeRefresh, counts);
  if (refreshCounters.bodySearchCalls || refreshCounters.bodyReadCalls || refreshCounters.vaultReadCalls) throw new Error('Legacy index.refresh unexpectedly warmed body search');
  const initialization = { method, markdownFiles: files.length, hostSetupMs, assemblyMs, legacyRefreshMs, initMs,
    legacyIndexEntries: refreshed.entries, refreshCounters, refreshDidNotWarmBodySearch: true,
    hostPreparation: { cachedFileObjects: fileMap.size, cachedMetadataEntries: metadataMap.size,
      bodyStringsRetainedByHost: false, vaultReadsUseFsReadFile: true, metadataParser: 'existing syntheticVaultHost; not native Obsidian metadata parsing' } };
  let invocation = 0;
  return {
    initialization,
    async probe(question, temperature, sequence, repetition) {
      const before = { ...counts }, pageStart = pageReceipts.length;
      const profiler = profiling ? createCollectorProfiler() : undefined;
      if (profiler && globalThis[PROFILE_KEY]) throw new Error('Concurrent collector profiling is unsupported');
      if (profiler) globalThis[PROFILE_KEY] = profiler;
      const start = performance.now();
      let result;
      try {
        result = method === 'collector'
          ? await collectChatKnowledgeCandidates({ vaultPath, agentIndex: index, question: question.text })
          : await production.retrieveChat({ vaultId: 'collector-timing', conversationId: `timing-${method}`, productRunId: `timing-${method}-${++invocation}`, question: question.text, explicitPaths: [], includeUnrefined: false });
      } finally { if (profiler) delete globalThis[PROFILE_KEY]; }
      const callMs = performance.now() - start;
      const pages = pageReceipts.slice(pageStart);
      const noteCount = method === 'collector' ? result.candidates.length : new Set(result.references.map(reference => reference.vaultRelativePath)).size;
      return { method, temperature, sequence, repetition, category: question.category, queryId: question.id, queryUtf16Length: question.text.length,
        callMs, ...(temperature === 'cold' ? { hostSetupMs, initMs, preparedTotalMs: initMs + callMs, totalMs: hostSetupMs + initMs + callMs } : {}),
        noteCount, referenceCount: method === 'retrieveChat' ? result.references.length : null,
        scannedHits: method === 'collector' ? result.scannedHits : null,
        pageCount: method === 'collector' ? result.pages : pages.length,
        stopReason: method === 'collector' ? result.stopReason : result.status,
        hitsReturnedAcrossPages: pages.reduce((total, page) => total + page.returned, 0),
        counters: delta(before, counts), pageCoverage: pages,
        ...(profiler ? { profile: profiler.snapshot(callMs) } : {}) };
    },
    dispose() { bodySearch.dispose(); }
  };
}

/** Single-process, sequential measurement; never returns note text or hit paths. */
export async function runCollectorTiming({ libraries, copyRoot, stateRoot, repetitions, profiling = false }) {
  const measuredMethods = profiling ? ['collector'] : methods;
  const results = [];
  let sequence = 0;
  for (const library of libraries) {
    const contexts = new Map();
    let unregister;
    try {
      if (library.folderBindings) {
        const bindings = normalizeKnowledgeFolderBindings(library.folderBindings);
        if (!bindings) throw new Error(`Invalid folder bindings for ${library.id}`);
        unregister = registerKnowledgeFolderBindings(library.vaultPath, () => bindings);
      }
      const cold = [], warm = [];
      // Fixed cold order is declared in the report. Neither method's search
      // cache is shared; the operating system's file cache is not purged.
      const coldQuestion = library.queries.find(question => question.category === 'needs_knowledge');
      for (const method of measuredMethods) {
        const context = await prepareMethod({ vaultPath: library.vaultPath, copyRoot, method, expectedMarkdownFiles: library.expectedMarkdownFiles, statePath: path.join(stateRoot, library.id, method), profiling });
        contexts.set(method, context);
        cold.push(await context.probe(coldQuestion, 'cold', ++sequence, 0));
      }
      // Warm every authored question once per independent method; omit these
      // probes from measured samples and all summary denominators.
      for (const [index, question] of library.queries.entries()) {
        const order = index % 2 ? [...measuredMethods].reverse() : measuredMethods;
        for (const method of order) await contexts.get(method).probe(question, 'warmup', ++sequence, 0);
      }
      const categories = ['smalltalk', 'needs_knowledge', 'long_question'];
      for (let repetition = 0; repetition < repetitions; repetition++) {
        // Rotate category order each round; alternate which method runs first
        // for each paired query, avoiding a single-category or method block.
        for (let offset = 0; offset < categories.length; offset++) {
          const category = categories[(repetition + offset) % categories.length];
          const questions = library.queries.filter(question => question.category === category);
          const question = questions[repetition % questions.length];
          const order = (repetition * categories.length + offset) % 2 ? [...measuredMethods].reverse() : measuredMethods;
          for (const method of order) warm.push(await contexts.get(method).probe(question, 'warm', ++sequence, repetition + 1));
        }
      }
      results.push({ id: library.id, markdownFiles: library.expectedMarkdownFiles, corpusMarkdownFiles: library.corpusMarkdownFiles, queries: library.queries,
        initialization: measuredMethods.map(method => contexts.get(method).initialization), cold, warm,
        warmupCallsPerMethod: library.queries.length, warmSamplesPerMethod: repetitions * categories.length });
    } finally {
      for (const context of contexts.values()) context.dispose();
      unregister?.();
    }
  }
  return results;
}
