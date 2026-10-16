export function messageText(message) {
  return typeof message?.content === 'string' ? message.content : (message?.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n');
}

// Recommended formatter contract (no product tag names are prescribed):
// close the whole material collection, every source, and every original excerpt;
// encode body text as data so --- or literal boundary characters cannot close
// the outer structure. Keep the current user question in its own message.
// Two independent user messages alone do not satisfy the closing contract.
// This checker never adds a marker to production output.
function explicitOriginalBlocks(text, references) {
  try {
    const root = JSON.parse(text);
    const records = root?.sources ?? root?.references;
    if (Array.isArray(records)) return references.length > 0 && references.every(reference => records.some(record =>
      (record.vaultRelativePath ?? record.path) === reference.vaultRelativePath
      && typeof (record.excerpt ?? record.original_text) === 'string'
      && (record.excerpt ?? record.original_text) === reference.excerpt));
  } catch { /* Plain text must supply explicit paired boundaries instead. */ }
  const value = text.trim();
  const stack = [];
  const nodes = [];
  const tags = /<\/?([A-Za-z_][\w:.-]*)(?:\s[^<>]*?)?\s*\/?>/gu;
  let root;
  for (const match of value.matchAll(tags)) {
    const closing = match[0].startsWith('</');
    if (closing) {
      const node = stack.pop();
      if (!node || node.name !== match[1]) return false;
      node.end = match.index + match[0].length;
      node.inner = value.slice(node.contentStart, match.index);
    } else {
      const node = { name: match[1], start: match.index, contentStart: match.index + match[0].length, parent: stack.at(-1), children: [] };
      if (!stack.length) { if (root) return false; root = node; }
      else stack.at(-1).children.push(node);
      nodes.push(node);
      if (match[0].endsWith('/>')) { node.end = node.contentStart; node.inner = ''; }
      else stack.push(node);
    }
  }
  if (!root || stack.length || root.start !== 0 || root.end !== value.length) return false;
  return references.length > 0 && references.every(reference => nodes.some(node => {
    const decoded = node.inner?.replace(/&(lt|gt|quot|apos|amp);/gu, (_match, entity) => ({ lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' })[entity]);
    if (node === root || node.children.length || decoded !== reference.excerpt) return false;
    for (let ancestor = node.parent; ancestor; ancestor = ancestor.parent) {
      if (ancestor !== root && value.slice(ancestor.start, ancestor.end).includes(reference.vaultRelativePath)) return true;
    }
    return false;
  }));
}

export function judgePromptBoundary(evidence) {
  const assertions = [];
  const check = (name, pass, actual) => assertions.push({ name, pass: Boolean(pass), actual });
  if (!evidence?.actual) return { status: 'fail', assertions: [{ name: 'actual final conversion captured', pass: false }], reasons: ['Actual final conversion was not captured.'] };
  check('frozen source does not contain the current question', evidence.frozen_source_check?.question_absent === true, evidence.frozen_source_check ?? null);
  for (const [label, capture] of [['actual', evidence.actual], ['synthetic --- control', evidence.synthetic_last_excerpt_dash?.capture]]) {
    if (!capture) { check(`${label}: conversion captured`, false, null); continue; }
    const messages = capture.openai_compatible?.output ?? [];
    const questionIndices = messages.flatMap((message, index) => message.role === 'user' && messageText(message) === capture.question ? [index] : []);
    const resourceIndices = messages.flatMap((message, index) => message.role === 'user' && messageText(message) === capture.provider_resource_text ? [index] : []);
    check(`${label}: actual resource and current user question remain separate`, questionIndices.length === 1 && resourceIndices.length === 1 && resourceIndices[0] < questionIndices[0], { question_indices: questionIndices, resource_indices: resourceIndices });
    check(`${label}: each original excerpt and outer resource have explicit closing structure`, explicitOriginalBlocks(capture.provider_resource_text, capture.references), { resource_text: capture.provider_resource_text, reference_paths: capture.references.map(reference => reference.vaultRelativePath) });
    const occurrences = value => capture.question ? value.split(capture.question).length - 1 : 0;
    const originalQuestionCount = capture.references.reduce((count, reference) => count + occurrences(reference.excerpt), 0);
    const resourceQuestionCount = occurrences(capture.provider_resource_text);
    check(`${label}: current question was not newly appended to source material`, resourceQuestionCount <= originalQuestionCount, { question_occurrences_in_retrieved_excerpts: originalQuestionCount, question_occurrences_in_resource: resourceQuestionCount, note: 'A question legitimately present in a retrieved excerpt is allowed; only newly introduced question text is rejected.' });
  }
  const failures = assertions.filter(assertion => !assertion.pass);
  return { status: failures.length ? 'fail' : 'pass', assertions, reasons: failures.map(assertion => assertion.name) };
}
