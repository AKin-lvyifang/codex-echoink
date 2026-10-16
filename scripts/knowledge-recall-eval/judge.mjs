import { isDeepStrictEqual } from 'node:util';
import { judgePromptBoundary } from './prompt-boundary.mjs';

const get = (object, key) => key.split('.').reduce((value, part) => value?.[part], object);
const identity = item => item.vaultRelativePath ?? item.id;
export const notRun = reason => ({ status: 'not_run', assertions: [], reasons: [reason] });

/** Parse only the current production serialization; never add missing identity. */
export function parseDeliveryPayload(text) {
  const items = [];
  const errors = [];
  const marker = /^### [1-9]\d*\. ([^\n]*)\n来源：([^\n]+)\n行号：([1-9]\d*)-([1-9]\d*)；([^\n]+)\n版本：(sha256:[a-f0-9]{64})\n来源类型：([^\n]+)\n记录时间：([^\n]+)\n发布时间：([^\n]+)\n核验状态：([^；\n]+)；[^\n]*/gmu;
  const matches = [...text.matchAll(marker)];
  for (let index = 0; index < matches.length; index++) {
    const match = matches[index];
    const body = text.slice(match.index + match[0].length, matches[index + 1]?.index ?? text.length);
    const original = /^原文：\n/gmu.exec(body);
    const item = { title: match[1], vaultRelativePath: match[2], lineStart: Number(match[3]), lineEnd: Number(match[4]), contentRevision: match[6], sourceType: match[7], verificationStatus: match[10], excerpt: original ? body.slice(original.index + original[0].length) : '' };
    const total = /全文 ([1-9]\d*) 行/u.exec(match[5]);
    if (total) item.totalLines = Number(total[1]);
    item.hasMore = !match[5].includes('已交付全文');
    if (match[8] !== 'unknown' && Number.isFinite(Date.parse(match[8]))) item.recordedAt = Date.parse(match[8]);
    if (match[9] !== '未声明') item.publishedAt = match[9];
    if (!original) errors.push(`Missing original-text marker for ${item.vaultRelativePath}`);
    items.push(item);
  }
  for (const [tag, extract] of [['echoink_memory_recall', value => value.candidates ?? []], ['echoink_memory_secondary', value => (value.secondaryFacts ?? []).map(entry => entry.fact)]]) {
    const expression = new RegExp(`<${tag}\\b[^>]*>\\n([\\s\\S]*?)\\n<\\/${tag}>`, 'gu');
    for (const match of text.matchAll(expression)) {
      try { const decoded = extract(JSON.parse(match[1])); if (!Array.isArray(decoded)) throw new Error('Expected items array'); items.push(...decoded); }
      catch (error) { errors.push(`${tag}: ${error.message}`); }
    }
  }
  return { items, errors };
}

function validField(item, field) {
  const value = get(item, field);
  if (value === undefined || value === null) return false;
  if (field === 'contentRevision') return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/u.test(value);
  if (['lineStart', 'lineEnd', 'totalLines', 'sourceMemoryRevision'].includes(field)) return Number.isSafeInteger(value) && value >= 1 && (field !== 'lineEnd' || value >= item.lineStart);
  if (field === 'recordedAt') return typeof value === 'number' && Number.isFinite(value) && value >= 0;
  if (['date', 'asOf'].includes(field)) return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(value) && Number.isFinite(Date.parse(value));
  if (field === 'status') return ['current', 'superseded', 'closed', 'disabled'].includes(value);
  if (field === 'basis') return ['explicit', 'observed', 'inferred', 'llm_inferred', 'user_edited_inference'].includes(value);
  if (field === 'supportLevel') return ['direct', 'strong_inference', 'weak_inference'].includes(value);
  if (field === 'sourceType') return ['wiki', 'projects', 'raw', 'journal', 'notes', 'outputs', 'inbox', 'work', 'archive', 'templates', 'assets'].includes(value);
  if (field === 'verificationStatus') return ['local_revision_verified', 'source_link_changed'].includes(value);
  if (['id', 'vaultRelativePath', 'sourceSummary', 'scope', 'contentOrigin', 'evidence', 'parentId'].includes(field)) return typeof value === 'string' && value.trim().length > 0;
  return typeof value !== 'string' || value.trim().length > 0;
}
function sameField(sidecar, payload, field) {
  if (field === 'recordedAt' && validField(sidecar, field)) return Math.trunc(sidecar[field]) === payload[field];
  return isDeepStrictEqual(get(sidecar, field), get(payload, field));
}

/** Rules consume actual production output; never construct a reference from gold. */
export function judgeCandidate(expected, items) {
  if (!expected || expected.applicable === false) return { status: 'not_applicable', assertions: [], reasons: [] };
  const assertions = [];
  const assert = (name, pass, actual) => assertions.push({ name, pass: Boolean(pass), actual });
  const paths = items.map(identity);
  const rank = name => paths.indexOf(name) < 0 ? null : paths.indexOf(name) + 1;
  const maxRank = expected.max_rank ?? 5;
  if (expected.empty === true) assert('empty candidate list', items.length === 0, paths);
  for (const name of [...(expected.required_paths ?? []), ...(expected.required_ids ?? [])]) assert(`${name} rank <= ${maxRank}`, rank(name) !== null && rank(name) <= maxRank, { rank: rank(name) });
  for (const name of expected.required_secondary_ids ?? []) {
    const parents = items.flatMap((item, index) => [
      ...(item.matchedSecondaryId === name ? [{ parent_id: item.id, rank: index + 1, matched_secondary_id: item.matchedSecondaryId }] : []),
      ...(item.secondaryMatches ?? []).filter(fact => fact.id === name).map(fact => ({ parent_id: item.id, rank: index + 1, fact }))
    ]);
    assert(`secondary ${name} parent rank <= ${maxRank}`, parents.some(parent => parent.rank <= maxRank), parents);
  }
  for (const group of expected.required_groups ?? []) {
    const names = Array.isArray(group) ? group : group.paths;
    const bound = Array.isArray(group) ? maxRank : group.max_rank ?? maxRank;
    assert(`one of ${names.join(' | ')} rank <= ${bound}`, names.some(name => rank(name) !== null && rank(name) <= bound), names.map(name => ({ path: name, rank: rank(name) })));
  }
  for (const name of [...(expected.forbidden_paths ?? []), ...(expected.forbidden_ids ?? [])]) assert(`${name} absent`, !paths.includes(name), { rank: rank(name) });
  for (const name of expected.forbidden_top_paths ?? []) assert(`${name} outside top ${maxRank}`, rank(name) === null || rank(name) > maxRank, { rank: rank(name) });
  const ordered = expected.ordered_paths ?? [];
  for (let i = 1; i < ordered.length; i++) assert(`${ordered[i - 1]} before ${ordered[i]}`, rank(ordered[i - 1]) !== null && rank(ordered[i]) !== null && rank(ordered[i - 1]) < rank(ordered[i]), [rank(ordered[i - 1]), rank(ordered[i])]);
  return verdict(assertions);
}

export function judgeDelivery(expected, items, text, promptBoundary) {
  if (!expected || expected.applicable === false) return { status: 'not_applicable', assertions: [], reasons: [] };
  const assertions = [];
  const assert = (name, pass, actual) => assertions.push({ name, pass: Boolean(pass), actual });
  if (expected.boundary_contract) {
    const boundary = judgePromptBoundary(promptBoundary);
    // I7 freezes only a boundary contract. Do not impose the older Markdown
    // identity serialization on a future explicitly closed resource format.
    if (Object.keys(expected).every(key => ['applicable', 'boundary_contract'].includes(key))) return boundary;
    assertions.push(...boundary.assertions);
  }
  const parsed = parseDeliveryPayload(text);
  const delivered = parsed.items;
  const paths = delivered.map(identity);
  const sidecarPaths = items.map(identity);
  if (parsed.errors.length) assert('production payload parses', false, parsed.errors);
  for (const item of items) {
    const payload = delivered.find(candidate => identity(candidate) === identity(item));
    assert(`sidecar ${identity(item)} exists in actual provider payload`, Boolean(payload), { sidecar_id: identity(item), payload_ids: paths });
    const fields = item.vaultRelativePath ? ['vaultRelativePath', 'contentRevision', 'lineStart', 'lineEnd', 'sourceType', 'recordedAt', 'verificationStatus'] : Object.keys(item).filter(key => key !== 'excerpt');
    for (const field of fields) assert(`payload ${identity(item)}.${field} agrees with sidecar`, Boolean(payload) && validField(item, field) && validField(payload, field) && sameField(item, payload, field), { sidecar: get(item, field) ?? null, payload: get(payload, field) ?? null });
    if (item.vaultRelativePath) assert(`payload ${identity(item)} preserves exact excerpt`, Boolean(payload) && payload.excerpt.includes(item.excerpt ?? ''), { excerpt: item.excerpt, payload_excerpt: payload?.excerpt ?? null });
  }
  // Excerpts are checked in delivered evidence payload, never generic wrapper instructions.
  const evidence = delivered.map(item => item.excerpt ?? item.summary ?? item.content ?? '').join('\n');
  if (expected.empty === true) assert('empty delivered evidence', items.length === 0 && delivered.length === 0, { sidecar_ids: sidecarPaths, payload_ids: paths });
  for (const name of [...(expected.required_paths ?? []), ...(expected.required_ids ?? [])]) assert(`${name} delivered`, paths.includes(name) && sidecarPaths.includes(name), { sidecar_ids: sidecarPaths, payload_ids: paths });
  for (const name of [...(expected.forbidden_paths ?? []), ...(expected.forbidden_ids ?? [])]) assert(`${name} not delivered`, !paths.includes(name), paths);
  for (const excerpt of expected.required_excerpts ?? []) assert(`delivered excerpt: ${excerpt}`, evidence.includes(excerpt) && text.includes(excerpt), { evidence_contains: evidence.includes(excerpt), payload_contains: text.includes(excerpt) });
  for (const group of expected.required_excerpt_groups ?? []) assert(`one delivered excerpt of ${group.join(' | ')}`, group.some(excerpt => evidence.includes(excerpt) && text.includes(excerpt)), { alternatives: group });
  for (const excerpt of expected.forbidden_excerpts ?? []) assert(`forbidden excerpt absent: ${excerpt}`, !evidence.includes(excerpt) && !text.includes(excerpt), { evidence_contains: evidence.includes(excerpt), payload_contains: text.includes(excerpt) });
  for (const heading of expected.required_headings ?? []) assert(`delivered heading: ${heading}`, delivered.some(item => String(item.excerpt ?? '').split('\n').some(line => /^#{1,6}\s/u.test(line) && line.replace(/^#{1,6}\s+/u, '').trim() === heading)), { delivered_headings: delivered.flatMap(item => String(item.excerpt ?? '').split('\n').filter(line => /^#{1,6}\s/u.test(line))) });
  if (expected.min_source_line !== undefined) assert(`required source reaches line ${expected.min_source_line}`, delivered.some(item => (!(expected.required_paths?.length) || expected.required_paths.includes(identity(item))) && validField(item, 'lineEnd') && item.lineEnd >= expected.min_source_line), delivered.map(item => ({ id: identity(item), lineStart: item.lineStart ?? null, lineEnd: item.lineEnd ?? null })));
  for (const field of expected.required_fields ?? []) assert(`all delivered items have valid ${field}`, delivered.length > 0 && delivered.every(item => validField(item, field)), delivered.map(item => ({ id: identity(item), value: get(item, field) ?? null })));
  for (const specification of expected.identity_assertions ?? []) {
    const target = delivered.find(item => identity(item) === (specification.id ?? specification.path));
    assert(`identity ${specification.id ?? specification.path} present`, Boolean(target), paths);
    for (const field of specification.required_fields ?? []) assert(`${specification.id ?? specification.path} has valid ${field}`, Boolean(target) && validField(target, field), get(target, field) ?? null);
    for (const [field, value] of Object.entries(specification.fields ?? {})) assert(`${specification.id ?? specification.path}.${field}`, Boolean(target) && isDeepStrictEqual(get(target, field), value), get(target, field) ?? null);
  }
  const requiredIdentities = [...(expected.required_paths ?? []), ...(expected.required_ids ?? [])];
  const targets = requiredIdentities.length ? delivered.filter(item => requiredIdentities.includes(identity(item))) : delivered;
  for (const [field, value] of Object.entries(expected.identity ?? {})) assert(`identity ${field}`, targets.length > 0 && targets.every(item => isDeepStrictEqual(get(item, field), value)), targets.map(item => ({ id: identity(item), value: get(item, field) ?? null })));
  return verdict(assertions);
}

function verdict(assertions) {
  if (!assertions.length) return { status: 'pending_review', assertions, reasons: ['No mechanical assertions configured; do not treat an empty rule as a pass.'] };
  const failures = assertions.filter(item => !item.pass);
  return { status: failures.length ? 'fail' : 'pass', assertions, reasons: failures.map(item => item.name) };
}

export function summarize(results, layer) {
  const counts = Object.fromEntries(['pass', 'fail', 'not_run', 'blocked', 'not_applicable', 'pending_review'].map(status => [status, results.filter(item => item[layer].status === status).length]));
  const executed = counts.pass + counts.fail + counts.pending_review;
  return { ...counts, planned: results.length - counts.not_applicable, executed, score: executed ? `${counts.pass}/${executed}` : '', percent: executed ? 100 * counts.pass / executed : null, provisional: counts.pending_review > 0 };
}
