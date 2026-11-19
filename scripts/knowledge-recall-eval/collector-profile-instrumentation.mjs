// Benchmark-only instrumentation for exactly three production source files.
// Replacements fail closed if an upstream marker changes or is ambiguous.
export const PROFILE_KEY = '__echoinkCollectorPhaseProfileV1';
const hook = `globalThis.${PROFILE_KEY}`;
function once(source, marker, replacement, name) {
  const matches = source.split(marker).length - 1;
  if (matches !== 1) throw new Error(`Profile marker ${name}: expected one match, got ${matches}`);
  return source.replace(marker, replacement);
}
function insertBefore(source, marker, statement, name) { return once(source, marker, `${statement}\n${marker}`, name); }

export const collectorProfileTransforms = {
  'src/knowledge-base/vault-body-search.ts': source => {
    source = insertBefore(source, '    const scope = this.ensureScope();', `    const __kpPage = ${hook}?.beginPage();`, 'page.begin');
    source = insertBefore(source, '    if (this.options.resolveSourcePath) {', `    __kpPage?.mark("scopeSetupMs");`, 'page.scope');
    source = insertBefore(source, '    const documents: BodySearchDocument[] = files.flatMap(file => {', `    __kpPage?.mark("canonicalPathsMs");`, 'page.canonical');
    source = insertBefore(source, '    const sourceFailures = failedSourcePaths.size;', `    __kpPage?.mark("metadataMs");`, 'page.metadata');
    source = insertBefore(source, '    let result: Awaited<ReturnType<BodySearchMemoryIndex["search"]>>;', `    __kpPage?.mark("querySetupMs");`, 'page.query');
    source = insertBefore(source, '    const snapshots = new Map<string, Promise<KnowledgeAgentReadResult>>();', `    __kpPage?.mark("bodyMemorySearchMs");
    __kpPage?.rawHits(hits.length);`, 'page.memory');
    const fit = '    hits = fitKnowledgeNavigation(hits, values => new TextEncoder().encode(JSON.stringify(values)).length <= 10_000);';
    source = insertBefore(source, fit, `    __kpPage?.mark("navigationMs");
    __kpPage?.beforeFit(hits);`, 'page.navigation');
    source = insertBefore(source, '    const remaining = Math.max(0, result.total - offset - hits.length);', `    __kpPage?.mark("jsonFitMs");
    __kpPage?.finish(hits);`, 'page.fit');
    return source;
  },
  'src/knowledge-base/search/body-search.ts': source => {
    const bodyMark = name => `  ${hook}?.bodyMark("${name}", performance.now() - __kpBodyAt); __kpBodyAt = performance.now();`;
    source = insertBefore(source, '  const sections: Section[] = [];', '  let __kpBodyAt = performance.now();', 'body.cache.begin');
    source = insertBefore(source, '  const df = new Map<string, number>();', bodyMark('bodyCachePreparationMs'), 'body.cache.end');
    source = insertBefore(source, '  const averageLength = totalLength / Math.max(1, sections.length);', bodyMark('termStatisticsMs'), 'body.df.end');
    source = insertBefore(source, '  const fused = new Map<Section, { section: Section; score: number; query: number; bestRank: number }>();', bodyMark('sectionScoreSortMs'), 'body.score.end');
    source = insertBefore(source, '  const matchedPaths = new Set(ordered.map(result => result.section.document.vaultRelativePath));', bodyMark('fusionMs'), 'body.fusion.end');
    source = insertBefore(source, '  const cueSections = new Map<string, Section>();', bodyMark('linkBoostMs'), 'body.links.end');
    source = insertBefore(source, '  checkAbort(request.signal);\n  cache?.check();\n  coverage.complete = coverage.complete', `${bodyMark('excerptMaterializeMs')}
  ${hook}?.bodyCounts({ sections: sections.length, queryCount: queries.length, queryTerms: union.size, rankedHits: ordered.length });`, 'body.materialize.end');
    source = once(source, '    const prepared = prepareSearch(options);', `    const __kpMemoryStart = performance.now();
    const prepared = prepareSearch(options);
    ${hook}?.bodyMark("queryPreparationMs", performance.now() - __kpMemoryStart);
    let __kpMemoryAt = performance.now();`, 'memory.query');
    source = insertBefore(source, '      const result = await executeSearch(options, prepared, {', `      ${hook}?.bodyMark("cacheViewPreparationMs", performance.now() - __kpMemoryAt);`, 'memory.view');
    source = once(source, '      checkAbort(options.request.signal);\n      check();', `      __kpMemoryAt = performance.now();
      checkAbort(options.request.signal);
      check();`, 'memory.commit.begin');
    source = once(source, '      return result;\n    } finally { this.activeSearches.delete(active); }', `      ${hook}?.bodyMark("cacheCommitValidationMs", performance.now() - __kpMemoryAt);
      return result;
    } finally { this.activeSearches.delete(active); }`, 'memory.commit.end');
    return source;
  },
  'src/knowledge-base/chat-knowledge-candidates.ts': source => {
    source = insertBefore(source, '  const maxCandidates = Math.min(30, countBudget(input.maxCandidates, 25));', `  const __kpCollector = ${hook};
  let __kpOwnAt = performance.now();`, 'collector.begin');
    source = insertBefore(source, '    const page = await input.agentIndex.search({', '    __kpCollector?.collectorOwn(performance.now() - __kpOwnAt);', 'collector.wait.begin');
    source = once(source, '    });\n    checkAbort(input.signal);\n    pages++;', '    });\n    __kpOwnAt = performance.now();\n    checkAbort(input.signal);\n    pages++;', 'collector.wait.end');
    source = once(source, '    pruneWithdrawn();\n    return { candidates, scannedHits, pages, stopReason };', '    pruneWithdrawn();\n    __kpCollector?.collectorOwn(performance.now() - __kpOwnAt);\n    return { candidates, scannedHits, pages, stopReason };', 'collector.finish');
    return source;
  }
};

const sumFields = objects => {
  const result = {};
  for (const object of objects) for (const [name, value] of Object.entries(object)) result[name] = (result[name] ?? 0) + value;
  return result;
};

/** Sequential page wall-clock spans, with separately named nested body spans. */
export function createCollectorProfiler() {
  const pages = [];
  let current, collectorOwnMs = 0;
  return {
    collectorOwn(ms) { collectorOwnMs += ms; },
    bodyMark(name, ms) { if (current) current.bodyPhaseMs[name] = (current.bodyPhaseMs[name] ?? 0) + ms; },
    bodyCounts(values) { if (current) Object.assign(current.bodyCounts, values); },
    beginPage() {
      const start = performance.now();
      let at = start;
      const page = { page: pages.length + 1, phaseMs: {}, bodyPhaseMs: {}, bodyCounts: {}, jsonReceiptOverheadMs: 0 };
      pages.push(page); current = page;
      return {
        mark(name) { const now = performance.now(); page.phaseMs[name] = now - at; at = performance.now(); },
        rawHits(count) { page.rawHitCount = count; },
        beforeFit(hits) {
          const before = performance.now();
          page.preFitHitCount = hits.length;
          page.preFitJsonBytes = Buffer.byteLength(JSON.stringify(hits), 'utf8');
          page.jsonReceiptOverheadMs += performance.now() - before;
          at = performance.now();
        },
        finish(hits) {
          const before = performance.now();
          page.postFitHitCount = hits.length;
          page.postFitJsonBytes = Buffer.byteLength(JSON.stringify(hits), 'utf8');
          page.jsonReceiptOverheadMs += performance.now() - before;
          page.pageWallMs = performance.now() - start;
          page.unattributedWallMs = page.pageWallMs - Object.values(page.phaseMs).reduce((total, ms) => total + ms, 0) - page.jsonReceiptOverheadMs;
          current = undefined;
        }
      };
    },
    snapshot(callMs) {
      if (pages.some(page => page.pageWallMs === undefined)) throw new Error('Profile page did not reach the normal keyword-search return');
      const pageWallMs = pages.reduce((total, page) => total + page.pageWallMs, 0);
      return { collectorOwnMs, pageWallMs, unattributedCallMs: callMs - collectorOwnMs - pageWallMs,
        phaseMs: sumFields(pages.map(page => page.phaseMs)), bodyPhaseMs: sumFields(pages.map(page => page.bodyPhaseMs)),
        jsonReceiptOverheadMs: pages.reduce((total, page) => total + page.jsonReceiptOverheadMs, 0), pages };
    }
  };
}
