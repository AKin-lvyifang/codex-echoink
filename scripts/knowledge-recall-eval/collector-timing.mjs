#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDisposableTestRoot } from '../disposable-test-root.mjs';
import { buildAdapter } from './cli.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const sourceRoot = path.resolve(here, '../..');
const schemaVersion = 'collector-timing-local-v1';
const contains = (root, target) => { const relative = path.relative(root, target); return relative === '' || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); };
const sha256 = content => createHash('sha256').update(content).digest('hex');
const git = args => execFileSync('git', ['-C', sourceRoot, ...args], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).trim();

function environment() {
  const cpus = os.cpus();
  return { at: new Date().toISOString(), loadavg: os.loadavg(), node: process.version, platform: process.platform, arch: process.arch,
    osRelease: os.release(), cpuModels: [...new Set(cpus.map(cpu => cpu.model))], logicalCpus: cpus.length, memoryBytes: os.totalmem() };
}
async function ensureNew(directory) {
  try { await lstat(directory); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  throw new Error(`Refusing to overwrite existing directory: ${directory}`);
}
async function rejectSymlinkAncestors(directory) {
  let cursor = directory;
  while (true) {
    try { if ((await lstat(cursor)).isSymbolicLink()) throw new Error('Output/work symlink rejected'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const parent = path.dirname(cursor);
    if (parent === cursor) return;
    cursor = parent;
  }
}
async function validateCopyRoot(value) {
  if (!path.isAbsolute(value)) throw new Error('--copy-root must be absolute');
  const requested = path.resolve(value);
  if (!isDisposableTestRoot(requested) || requested.split(path.sep).some(segment => segment.includes('样板'))) throw new Error('Only an explicit disposable acceptance copy may be measured');
  const canonical = await realpath(requested);
  if (!isDisposableTestRoot(canonical) || canonical !== requested || !(await lstat(canonical)).isDirectory()) throw new Error('Acceptance copy root must be a real, non-symlink directory');
  return canonical;
}
async function validateLibrary(copyRoot, relative, expectedMarkdownFiles) {
  const requested = path.join(copyRoot, relative);
  if (!contains(copyRoot, requested)) throw new Error('Measured library is outside acceptance copy');
  const canonical = await realpath(requested);
  if (canonical !== requested || !isDisposableTestRoot(canonical) || !contains(copyRoot, canonical)) throw new Error('Measured library canonical path escaped acceptance copy');
  let count = 0;
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      // Match the synthetic host's source listing; hidden plugin/configuration
      // trees are not measured, read or parsed, including data.json.
      if (entry.name.startsWith('.')) continue;
      const target = path.join(directory, entry.name), stat = await lstat(target);
      const actual = await realpath(target);
      if (stat.isSymbolicLink() || actual !== target || !contains(canonical, actual) || !contains(copyRoot, actual) || !isDisposableTestRoot(actual)) throw new Error('Measured source path escaped acceptance copy or used a symlink');
      if (stat.isDirectory()) await visit(target);
      else if (stat.isFile() && /\.(?:md|markdown)$/iu.test(entry.name)) count++;
      else if (!stat.isFile()) throw new Error('Special source file rejected');
    }
  }
  await visit(canonical);
  if (count !== expectedMarkdownFiles) throw new Error(`Unexpected Markdown count in ${relative}: expected ${expectedMarkdownFiles}, got ${count}`);
  return canonical;
}

function questions(library) {
  const smalltalk = [
    '早上好，今天先不用查我的笔记，和我简单打个招呼。',
    '不用查知识库，帮我把“今天辛苦了”翻译成英文。',
    '先别看我的资料，给我一句简短的鼓励。',
    '不用搜索我的笔记，解释一下为什么天空通常看起来是蓝色的。',
    '今天想随便聊两句，不需要查看我的消费、日记或笔记。'
  ];
  const needs = library === 'eval_dataset' ? [
    '我之前记录的 EchoInk 为什么放弃方案 A，最后选择了什么？',
    '我的 EchoInk 笔记里，方案 A 和方案 B 分别有哪些取舍？',
    '请查我记录的 EchoInk 决策原因，哪些限制影响了最终方案？',
    'EchoInk 相关笔记中，放弃旧方案后还留下哪些待解决的问题？',
    '我关于 EchoInk 方案选择的记录里，最终决定和最初想法有什么变化？'
  ] : [
    '我之前记过的咖啡和餐饮消费有哪些？',
    '请查我的消费记录，咖啡与吃饭分别有哪些相关笔记？',
    '我的日记中有哪些提到餐饮、咖啡或外出吃饭的记录？',
    '请找我写过的笔记，归纳和咖啡、餐饮消费有关的内容。',
    '我记录的日记和消费笔记里，关于咖啡与餐饮有哪些可以回看的材料？'
  ];
  const topic = library === 'eval_dataset' ? '我过去关于 EchoInk、放弃方案 A、比较方案 B 和最终决定的笔记' : '我过去关于咖啡、餐饮消费、日记和相关笔记的记录';
  const conditions = [
    '请先核对问题所涉及的时间范围，把当前决定和过去尝试分开，无法判断时间的材料需要明确说明。',
    '请只把笔记中明确记录过的信息作为依据，区分事实、当时的想法和后续计划，不把相似词语当成同一事件。',
    '请检查不同记录之间是否存在条件变化，把使用场景、比较标准、适用限制与最终选择分别说明。',
    '如果多个记录讲的是同一件事，请合并重复信息，同时保留它们之间能改变判断的差异和修订关系。',
    '请关注直接回答问题的材料，不要为了增加来源数量而纳入只有标题相似、实际没有帮助的笔记。',
    '请把结论组织成便于回看的说明，先讲能够确认的内容，再列仍需补充的证据和无法核实的部分。',
    '涉及数字、日期、因果关系或方案取舍时，请用原记录支持，不要根据常识补齐未写出的个人经历。',
    '请分别说明哪些内容可以直接引用，哪些内容只能作为检索线索，遇到冲突时不要擅自认定某一条一定正确。'
  ];
  const long = Array.from({ length: 5 }, (_, index) => {
    let text = `请系统回顾${topic}。这次我尤其关心第${index + 1}类条件：${conditions[index]}\n`;
    let section = 0;
    while (text.length < 1800) {
      text += `核对维度${section + 1}：${conditions[(section + index) % conditions.length]}\n`;
      section++;
    }
    return text.slice(0, 1800);
  });
  const rows = [];
  // Initial warmup itself alternates categories rather than one long block.
  for (let index = 0; index < 5; index++) for (const [category, values] of [['smalltalk', smalltalk], ['needs_knowledge', needs], ['long_question', long]]) {
    const text = values[index];
    if (text.length > 2000 || category === 'long_question' && (text.length < 1500 || text.length > 1900)) throw new Error('Authored query length violated timing protocol');
    rows.push({ id: `${library}-${category}-${index + 1}`, category, text, utf16Length: text.length });
  }
  return rows;
}

function summarize(samples) {
  const values = samples.map(sample => sample.callMs).sort((left, right) => left - right), count = values.length;
  const middle = Math.floor(count / 2);
  return { count, medianMs: count ? count % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2 : null,
    p90Ms: count ? values[Math.ceil(count * 0.9) - 1] : null, maxMs: count ? values[count - 1] : null,
    atMost300Ms: values.filter(value => value <= 300).length, atMost1200Ms: values.filter(value => value <= 1200).length,
    averageNotes: count ? samples.reduce((total, sample) => total + sample.noteCount, 0) / count : null,
    averagePages: count ? samples.reduce((total, sample) => total + sample.pageCount, 0) / count : null };
}

function summarizeProfile(samples) {
  const stats = values => {
    const sorted = values.toSorted((left, right) => left - right), count = sorted.length, middle = Math.floor(count / 2);
    return { count, medianMs: count ? count % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2 : null,
      p90Ms: count ? sorted[Math.ceil(count * 0.9) - 1] : null, maxMs: count ? sorted[count - 1] : null,
      totalMs: sorted.reduce((total, value) => total + value, 0) };
  };
  const fields = name => [...new Set(samples.flatMap(sample => Object.keys(sample.profile[name])))];
  return {
    collectorOwn: stats(samples.map(sample => sample.profile.collectorOwnMs)),
    pageWall: stats(samples.map(sample => sample.profile.pageWallMs)),
    unattributedCall: stats(samples.map(sample => sample.profile.unattributedCallMs)),
    jsonReceiptOverhead: stats(samples.map(sample => sample.profile.jsonReceiptOverheadMs)),
    phaseMs: Object.fromEntries(fields('phaseMs').map(name => [name, stats(samples.map(sample => sample.profile.phaseMs[name] ?? 0))])),
    bodyPhaseMs: Object.fromEntries(fields('bodyPhaseMs').map(name => [name, stats(samples.map(sample => sample.profile.bodyPhaseMs[name] ?? 0))]))
  };
}

export async function measureCollectorTiming(options) {
  if (options.profile !== undefined && !['true', 'false'].includes(options.profile)) throw new Error('--profile must be true or false');
  const profiling = options.profile === 'true';
  const measuredMethods = profiling ? ['collector'] : ['collector', 'retrieveChat'];
  const copyRoot = await validateCopyRoot(options['copy-root']);
  if (!path.isAbsolute(options['output-run'])) throw new Error('--output-run must be absolute');
  const output = path.resolve(options['output-run']);
  const repetitions = Number(options.repetitions ?? (profiling ? 5 : 20));
  if (!Number.isSafeInteger(repetitions) || repetitions < 1 || repetitions > 100) throw new Error('--repetitions must be an integer from 1 to 100');
  await ensureNew(output);
  await rejectSymlinkAncestors(output);
  const libraries = [
    { id: 'eval_dataset', vaultPath: await validateLibrary(copyRoot, 'eval-dataset/笔记', 76), expectedMarkdownFiles: 76, corpusMarkdownFiles: 77 },
    { id: 'large_vault', vaultPath: await validateLibrary(copyRoot, 'large-vault', 2940), expectedMarkdownFiles: 2940, corpusMarkdownFiles: 2940 }
  ];
  if (libraries.some(library => contains(library.vaultPath, output) || contains(output, library.vaultPath)) || contains(output, copyRoot)) throw new Error('Output must not overlap measured library paths');
  // Honor the frozen evaluation dataset's declared search scope if supplied.
  // The batch-based large Vault uses default production path classification;
  // its legacy wiki index may legitimately contain zero entries.
  try {
    const manifest = JSON.parse(await readFile(path.join(copyRoot, 'eval-dataset/manifest.json'), 'utf8'));
    libraries[0].folderBindings = manifest.settings?.folder_bindings ?? manifest.folder_bindings;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  for (const library of libraries) library.queries = questions(library.id);
  const runId = `collector-timing-${Date.now()}-${randomUUID()}`;
  const workRoot = path.join(copyRoot, `.${runId}`);
  await ensureNew(workRoot);
  await mkdir(workRoot);
  const envStart = environment();
  try {
    const sourceTransforms = profiling ? (await import('./collector-profile-instrumentation.mjs')).collectorProfileTransforms : {};
    const adapter = await buildAdapter(sourceRoot, workRoot, { entryPoint: 'collector-timing-adapter.ts', exportName: 'runCollectorTiming', sourceTransforms, fixtureWindowTimers: true });
    const results = await adapter.evaluate({ libraries, copyRoot, stateRoot: path.join(workRoot, 'state'), repetitions, profiling });
    const envEnd = environment();
    for (const file of adapter.metadata.imported_files) {
      const absolute = file.path.startsWith('evaluator/') ? path.join(here, file.path.slice('evaluator/'.length)) : path.join(sourceRoot, file.path);
      if (sha256(await readFile(absolute)) !== file.sha256) throw new Error(`Source changed during timing: ${file.path}`);
    }
    const protocol = {
      methods: measuredMethods, fixedColdMethodOrder: measuredMethods, repetitionsPerCategory: repetitions, queriesPerCategory: 5,
      markdownFileCounts: 'markdownFiles counts visible Markdown returned by the host, excluding hidden directories; corpusMarkdownFiles counts all physical Markdown in the copied corpus, including hidden directories.',
      temperatureDefinition: 'cold = first search on a fresh per-method host/body-search/index; warm = after all 15 authored questions were warmed once per method',
      hostPreparation: 'existing synthetic host eager File list, metadata and getAbstractFileByPath map; all three return memory data during calls; vault.read remains fs.readFile',
      canonicalIdentity: 'production createDesktopKnowledgeSourcePathResolver backed by real fs.realpath; VaultBodySearch retains every eligible-file identity check on each page',
      initMs: 'constructor/runtime assembly plus legacy index.refresh; refresh is verified not to invoke body search or host vault.read',
      preparedTotalMs: 'initMs + cold callMs', totalMs: 'hostSetupMs + initMs + cold callMs',
      warmOrder: 'three categories rotate each repetition; five questions per category cycle; paired method order alternates for every question',
      coldFilesystemCache: 'OS page cache was not purged; metadata setup and legacy refresh may already warm filesystem pages. Cold refers to production body-search cache only.',
      counterScope: 'vaultReadCalls covers host vault.read only; direct filesystem reads by legacy reference building are not counted. Page coverage is the actual production per-page receipt and may recount files across pages.',
      privacy: 'Only authored questions, lengths, durations and numeric/count receipts are emitted; no hit text, note body, note title, file path or provider resource text is recorded.',
      limitations: ['Synthetic cached metadata host; no native Obsidian timing.', 'Machine activity outside this process is uncontrolled; start/end load averages are recorded, not an idle-machine claim.', 'No model/API or /turn call. These measurements do not establish click-to-send, UI stage, first-token latency or selected-note relevance.']
    };
    if (profiling) protocol.profiling = {
      sourceTransforms: Object.keys(sourceTransforms), markerPolicy: 'Every source marker must match exactly once; original src files are never written.',
      topLevel: 'profile.phaseMs are disjoint wall-clock spans within sequential VaultBodySearch pages. canonicalPathsMs measures the whole parallel realpath batch wall time, never the sum of individual I/O durations.',
      nestedBody: 'profile.bodyPhaseMs are a breakdown INSIDE phaseMs.bodyMemorySearchMs. Do not add nested body phases to the top-level phase total.',
      collectorOwn: 'Exclusive collector setup, filtering, deduplication, redaction and final consent-pruning fragments; await index.search time is excluded.',
      pageReceipts: 'Each profile.pages entry aligns with pageCoverage and records rawHitCount, preFitHitCount/postFitHitCount and preFitJsonBytes/postFitJsonBytes for the 10KB hits-array fit.',
      observerCost: 'Extra JSON byte-count receipts are timed separately as jsonReceiptOverheadMs. Marks and receipt emission add small overhead; this diagnostic instrumented run is not the final uninstrumented performance acceptance.',
      samples: 'Cold is diagnostic only. Each method warms all 15 queries once; reported warm samples cycle three categories and five authored queries per category.'
    };
    const currentSchema = profiling ? 'collector-profile-local-v1' : schemaVersion;
    const raw = { schemaVersion: currentSchema, runId, copyRoot, startedAt: envStart.at, endedAt: envEnd.at,
      environment: { start: envStart, end: envEnd }, code: { sourceRoot, gitCommit: git(['rev-parse', 'HEAD']), worktreeStatus: git(['status', '--porcelain']),
        driverSha256: sha256(await readFile(fileURLToPath(import.meta.url))), adapter: adapter.metadata },
      protocol, libraries: results };
    const summary = { schemaVersion: currentSchema, runId, startedAt: raw.startedAt, endedAt: raw.endedAt, environment: raw.environment, protocol,
      libraries: results.map(library => ({ id: library.id, markdownFiles: library.markdownFiles, corpusMarkdownFiles: library.corpusMarkdownFiles, initialization: library.initialization,
        cold: library.cold, warmupCallsPerMethod: library.warmupCallsPerMethod,
        warm: Object.fromEntries(measuredMethods.map(method => [method, {
          all: summarize(library.warm.filter(sample => sample.method === method)),
          categories: Object.fromEntries(['smalltalk', 'needs_knowledge', 'long_question'].map(category => [category, summarize(library.warm.filter(sample => sample.method === method && sample.category === category))])),
          ...(profiling ? { profile: {
            all: summarizeProfile(library.warm.filter(sample => sample.method === method)),
            categories: Object.fromEntries(['smalltalk', 'needs_knowledge', 'long_question'].map(category => [category, summarizeProfile(library.warm.filter(sample => sample.method === method && sample.category === category))]))
          } } : {})
        }])) })) };
    await mkdir(path.dirname(output), { recursive: true });
    await mkdir(output);
    await writeFile(path.join(output, 'raw.json'), `${JSON.stringify(raw, null, 2)}\n`);
    await writeFile(path.join(output, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
    return summary;
  } finally {
    // Only this run's new private work directory is removed. Preserve both
    // copied libraries and the acceptance root for the owning agent.
    await rm(workRoot, { recursive: true, force: true });
  }
}

async function main() {
  const args = process.argv.slice(2), options = {};
  if (!args.length || args.includes('--help')) {
    console.log('node scripts/knowledge-recall-eval/collector-timing.mjs --copy-root ABSOLUTE_ACCEPTANCE_COPY --output-run NEW_ABSOLUTE_DIRECTORY [--repetitions 20]\nAdd --profile true for benchmark-only source marks, collector only, default 5 repetitions/category.');
    return;
  }
  for (let index = 0; index < args.length; index += 2) {
    if (!args[index]?.startsWith('--') || !args[index + 1] || args[index + 1].startsWith('--') || Object.hasOwn(options, args[index].slice(2))) throw new Error('Expected unique --name value options');
    options[args[index].slice(2)] = args[index + 1];
  }
  for (const key of ['copy-root', 'output-run']) if (!options[key]) throw new Error(`--${key} is required`);
  const summary = await measureCollectorTiming(options);
  console.log(JSON.stringify({ output: path.resolve(options['output-run']), runId: summary.runId, libraries: summary.libraries.map(library => ({ id: library.id, collectorSamples: library.warm.collector.all.count, ...(library.warm.retrieveChat ? { retrieveChatSamples: library.warm.retrieveChat.all.count } : {}) })) }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.env.PI_OFFLINE = '1';
  main().catch(error => { console.error(`${error.name}: ${error.message}`); process.exitCode = 1; });
}
