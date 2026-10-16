// @ts-nocheck -- offline pure conversion, using installed Pi packages unchanged.
import { convertToLlm } from '@earendil-works/pi-coding-agent';
import { convertMessages } from '@earendil-works/pi-ai/api/openai-completions';
import { createPiKnowledgeInlineExtension } from '@production/plugin/pi-production-runtime-composition';
import { formatKnowledgeReferencesForPrompt, KnowledgeReferenceBuilder } from '@production/knowledge-base/query';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

const conversionModel = {
  id: 'offline-boundary-conversion', name: 'Offline conversion profile only', provider: 'offline-eval',
  api: 'openai-completions', baseUrl: 'https://example.invalid/v1', reasoning: false,
  input: ['text'], contextWindow: 32000, maxTokens: 1024,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
};
const compat = { supportsDeveloperRole: false, requiresAssistantAfterToolResult: false, requiresThinkingAsText: false, requiresToolResultName: false };

async function convertTurn(preflight, question, observe, label) {
  const handlers = new Map();
  const basePrompt = 'EchoInk offline prompt-boundary conversion; no model request.';
  const extension = createPiKnowledgeInlineExtension({
    vaultSecurity: { name: 'synthetic-event-registration', factory: async () => undefined },
    currentWorkspaceAccess: () => ({ permission: 'read-only', mode: 'agent', memoryMode: 'normal' }),
    currentTurn: () => ({ kind: 'chat', providerResourceText: preflight.providerResourceText, references: preflight.references })
  });
  await extension.factory({ on: (name, handler) => handlers.set(name, handler) });
  const beforeInput = { type: 'before_agent_start', prompt: question, systemPrompt: basePrompt, systemPromptOptions: { skills: [] } };
  const before = await observe(`${label}.createPiKnowledgeInlineExtension.before_agent_start`, beforeInput, () => handlers.get('before_agent_start')(beforeInput));
  const contextInput = { messages: [
    { role: 'user', content: question, timestamp: 1 },
    { role: 'custom', ...before.message, timestamp: 2 }
  ] };
  const context = await observe(`${label}.createPiKnowledgeInlineExtension.context`, structuredClone(contextInput), () => handlers.get('context')(structuredClone(contextInput)));
  const llm = await observe(`${label}.convertToLlm`, { messages: context.messages }, () => convertToLlm(context.messages));
  const conversionInput = { model: conversionModel, context: { systemPrompt: before.systemPrompt ?? basePrompt, messages: llm }, compat };
  const providerMessages = await observe(`${label}.openaiCompatible.convertMessages`, conversionInput, () => convertMessages(conversionModel, conversionInput.context, compat));
  return {
    provider_resource_text: preflight.providerResourceText, references: preflight.references, question,
    before_agent_start: { input: beforeInput, output: before }, context: { input: contextInput, output: context },
    convert_to_llm: { input: context.messages, output: llm },
    openai_compatible: { input: conversionInput, output: providerMessages }
  };
}

export async function capturePromptBoundary({ chat, question, regressionFixture, vaultPath, observe }) {
  const fixturePath = regressionFixture?.path;
  let source;
  let diagnosticReferences = [...chat.references];
  if (fixturePath) {
    if (fixturePath.startsWith('/') || fixturePath.includes('\\') || fixturePath.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Unsafe boundary fixture path');
    const sourceText = await fs.readFile(path.join(vaultPath, ...fixturePath.split('/')), 'utf8');
    source = { path: fixturePath, source_text: sourceText, sha256: createHash('sha256').update(sourceText).digest('hex'), question_absent: !sourceText.includes(question) };
    if (!diagnosticReferences.length) diagnosticReferences = [await new KnowledgeReferenceBuilder(vaultPath).buildReference({ vaultRelativePath: fixturePath, question })];
  }
  const actual = await convertTurn(chat, question, observe, 'actual');
  let synthetic;
  if (diagnosticReferences.length) {
    const lastExcerpt = diagnosticReferences.at(-1).excerpt;
    const references = diagnosticReferences.map((reference, index) => index === diagnosticReferences.length - 1 ? { ...reference, excerpt: '---' } : reference);
    let diagnosticText = chat.providerResourceText;
    let replacementMethod;
    try {
      const root = JSON.parse(diagnosticText);
      const records = root.sources ?? root.references;
      const target = records?.find(record => (record.path ?? record.vaultRelativePath) === diagnosticReferences.at(-1).vaultRelativePath);
      const key = target && ['excerpt', 'original_text'].find(field => target[field] === lastExcerpt);
      if (key) { target[key] = '---'; diagnosticText = JSON.stringify(root); replacementMethod = 'replace decoded JSON original-text value; preserve closed resource structure'; }
    } catch { /* The current plain-text formatter is handled below. */ }
    if (!replacementMethod) {
      const encoded = lastExcerpt?.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
      const original = lastExcerpt && diagnosticText.includes(lastExcerpt) ? lastExcerpt : encoded;
      const position = original ? diagnosticText.lastIndexOf(original) : -1;
      if (position >= 0) { diagnosticText = `${diagnosticText.slice(0, position)}---${diagnosticText.slice(position + original.length)}`; replacementMethod = 'replace last exact original-text occurrence; preserve surrounding production resource'; }
      else { diagnosticText = formatKnowledgeReferencesForPrompt(references); replacementMethod = 'synthetic fallback through production formatter; no matching retrieved excerpt in preflight'; }
    }
    synthetic = {
      evidence_level: 'synthetic-pure-conversion-control-not-native-evidence',
      modification: 'Only this diagnostic replaces the last excerpt with the fixed literal ---; it is not a Vault read or production retrieval result.',
      replacement_method: replacementMethod,
      capture: await convertTurn({ references, providerResourceText: diagnosticText }, question, observe, 'synthetic-last-excerpt-dash')
    };
  }
  return { actual, synthetic_last_excerpt_dash: synthetic ?? null, frozen_source_check: source ?? null, boundary_contract_evidence: 'Actual production chat resource -> production before_agent_start/context -> installed Pi convertToLlm -> installed OpenAI-compatible convertMessages. No stream or network function is invoked.' };
}
