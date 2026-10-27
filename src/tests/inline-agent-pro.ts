import assert from "node:assert/strict";
import { ChangeSet } from "@codemirror/state";
import type CodexForObsidianPlugin from "../main";
import { inlineGenerationAccess, requireInlineGeneration } from "../inline-agent/access";
import { normalizeInlineAgentSettings } from "../inline-agent/settings";
import { InlineAgentRuntimeController } from "../inline-agent/orchestrator";
import { InlineRequestService, type InlineEditorPort } from "../inline-agent/service";
import { anchorAt, applyChanges } from "../inline-agent/document";
import type { InlineRequest } from "../inline-agent/types";
import type { CapabilityAccess } from "../membership/types";
import { createApiProviderConfig, DEFAULT_SETTINGS } from "../settings/settings";
import { createInlineProposalDispatchGuard } from "../plugin/pi-production-runtime-composition";
import { INLINE_PROPOSAL_SYSTEM_PROMPT, inlineProposalContextContent } from "../inline-agent/protocol";
import type { PiChatSubmitRequest, PiProductRunRecord } from "../harness/pi-native/contracts";

const tick = async () => { for (let i = 0; i < 15; i++) await new Promise<void>(resolve => setImmediate(resolve)); };
async function fixture() {
  const settings = structuredClone(DEFAULT_SETTINGS), provider = createApiProviderConfig("deepseek", "pro-gate-provider");
  provider.models[0].reasoning = false; provider.models[0].reasoningEnabled = false;
  settings.apiProviders = [provider]; settings.activeApiProviderId = provider.id; settings.defaultModel = provider.models[0].id;
  let paid = true, failSave = false, beforeEditor: (() => void) | undefined, beforeSubmit: (() => void) | undefined;
  const agent = settings.agentRegistry.agents[0], instruction = `@${agent.name} 改写这一段`;
  let document = `# PRO 验收\n\n原文段落。\n\n其他原文。\n\n${instruction}\n`, persisted: InlineRequest[] = [];
  let created = 0, calls = 0, applies = 0, aborts = 0;
  const access: CapabilityAccess = { checkCapability: () => paid, requireCapability: () => { if (!paid) throw new Error("需要有效 PRO"); }, subscribe: () => () => {} };
  const runs: { request: PiChatSubmitRequest; finish(): void }[] = [];
  let service: InlineRequestService;
  const editor: InlineEditorPort = { read: () => document, apply: (changes, _history, id) => {
    applies++; const before = document; document = applyChanges(document, changes);
    service.observe("正文.md", ChangeSet.of(changes, before.length), before, document, id);
  }, save: async () => { if (failSave) throw new Error("synthetic save failure"); } };
  const openEditor = async () => { beforeEditor?.(); beforeEditor = undefined; return editor; };
  const plugin = { settings, accountService: access as CapabilityAccess | null, getVaultPath: () => process.env.ECHOINK_TEST_ROOT!,
    createPiConversation: async () => { created++; }, submitPiChat: async (request: PiChatSubmitRequest) => {
      beforeSubmit?.(); beforeSubmit = undefined; requireInlineGeneration(plugin); calls++;
      let finish!: (result: Readonly<PiProductRunRecord>) => void;
      const result = new Promise<Readonly<PiProductRunRecord>>(resolve => { finish = resolve; });
      const candidate = request.inlineProposalRequest!.candidates.find(c => c.kind === "replace" && c.text.includes("原文段落"))!;
      runs.push({ request, finish: () => finish({ productRunId: `run-${calls}`, conversationId: request.conversationId, toolCallIds: [], terminalState: "completed",
        inlineProposalResult: { kind: "proposal", candidateId: candidate.id, original: candidate.text, text: "PRO 生成的新稿。" } } as unknown as PiProductRunRecord) });
      return { productRunId: `run-${calls}`, result };
    }, subscribePiRun: () => ({ unsubscribe() {} }), releasePiProductionRun() {}, abortPiConversation: async () => { aborts++; } };
  service = new InlineRequestService("pro-vault", { load: async () => persisted, save: async records => { persisted = structuredClone([...records]); } },
    { editor: openEditor, assertCanGenerate: () => requireInlineGeneration(plugin), changed() {}, report() {} });
  await service.initialize();
  const runtime = new InlineAgentRuntimeController(plugin as unknown as CodexForObsidianPlugin, service, { editor: openEditor, openTask: async () => {} });
  const draft = () => ({ path: "正文.md", agentId: agent.id, trigger: "@", from: document.indexOf(instruction), to: document.indexOf(instruction) + instruction.length, document, text: "改写这一段" });
  const stage = () => service.stageProposal({ path: "正文.md", taskId: "inline-pro-task", agentId: agent.id, agentName: agent.name, trigger: "@",
    instruction: { from: document.indexOf(instruction), to: document.indexOf(instruction) + instruction.length },
    target: { kind: "replace", from: document.indexOf("原文段落。"), to: document.indexOf("原文段落。") + "原文段落。".length }, text: "已生成的旧稿。" });
  return { plugin, runtime, service, editor, runs, draft, stage, snapshot: () => JSON.stringify(service.list()), document: () => document,
    counters: () => ({ created, calls, applies, aborts }), paid(value: boolean) { paid = value; runtime.refreshAccess(); },
    failSave(value: boolean) { failSave = value; }, beforeEditor(fn: () => void) { beforeEditor = fn; }, beforeSubmit(fn: () => void) { beforeSubmit = fn; },
    close: async () => { runtime.dispose(); await service.dispose(); } };
}

export async function runInlineProGateTests(): Promise<void> {
  assert.equal(normalizeInlineAgentSettings(undefined).enabled, true);
  assert.equal(normalizeInlineAgentSettings({ trigger: "!" }).enabled, true);
  assert.equal(normalizeInlineAgentSettings({ enabled: false }).enabled, false);
  for (const state of ["free", "expired", "signed-out", "missing", "disabled"] as const) {
    const f = await fixture();
    try {
      if (state === "disabled") f.plugin.settings.inlineAgent.enabled = false; else f.paid(false);
      if (state === "missing") f.plugin.accountService = null;
      const before = f.document();
      await assert.rejects(f.runtime.sendDraft(f.draft()), state === "disabled" ? /停用/ : /PRO/);
      assert.equal(f.document(), before); assert.equal(f.snapshot(), "[]"); assert.deepEqual(f.counters(), { created: 0, calls: 0, applies: 0, aborts: 0 });
    } finally { await f.close(); }
  }
  for (const status of ["pending", "clarifying", "confirmed", "revoked", "failed", "interrupted"] as const) {
    const f = await fixture();
    try {
      const record = await f.stage();
      if (status === "confirmed" || status === "revoked") await f.service[status === "confirmed" ? "confirm" : "revoke"](record.id, record.currentVersionId);
      if (["clarifying", "failed", "interrupted"].includes(status)) {
        const source = await f.service.readSource(record.id), token = await f.service.startRun(record.id, "旧要求", { providerSettingsId: "p", runtimeProviderId: "p", modelId: "m", reasoning: "none", memoryMode: "normal" }, source.context);
        if (status === "clarifying") await f.service.clarify(record.id, token, { question: "改哪段？", options: [{ id: "a", label: "第一段" }] }, {});
        else await f.service.failRun(record.id, token, "旧失败", status === "interrupted");
      }
      f.paid(false); const before = f.snapshot(), document = f.document(), counters = f.counters();
      await assert.rejects(f.runtime.reply(record.taskId, "澄清回答 / 编辑重发 / 继续追问"), /PRO/);
      await assert.rejects(f.runtime.retry(record.taskId), /PRO/);
      assert.equal(f.snapshot(), before, status); assert.equal(f.document(), document); assert.deepEqual(f.counters(), counters);
    } finally { await f.close(); }
  }
  {
    const f = await fixture();
    try {
      const r = await f.stage(), before = f.snapshot(); f.beforeEditor(() => f.paid(false));
      await assert.rejects(f.runtime.reply(r.taskId, "读取来源后会员失效"), /PRO/); await tick();
      assert.equal(f.snapshot(), before); assert.equal(f.counters().calls, 0);
    } finally { await f.close(); }
  }
  {
    const f = await fixture();
    try {
      const r = await f.stage(), before = f.snapshot(), text = f.document(); f.beforeSubmit(() => f.paid(false));
      await assert.rejects(f.runtime.reply(r.taskId, "发送前失效"), /PRO/); await tick();
      assert.equal(f.snapshot(), before, "a final dispatch denial restores the earned version and thread"); assert.equal(f.document(), text); assert.equal(f.counters().calls, 0);
      f.service.compare(r.id); f.service.compare(r.id); f.failSave(true);
      await assert.rejects(f.service.confirm(r.id, r.currentVersionId), /save/); assert.equal(f.service.get(r.id)?.status, "save_failed");
      const applies = f.counters().applies; f.failSave(false); await f.service.confirm(r.id, r.currentVersionId);
      assert.equal(f.counters().applies, applies, "retry-save never applies the edit twice"); assert.equal(f.service.get(r.id)?.status, "confirmed");
    } finally { await f.close(); }
  }
  {
    const f = await fixture();
    try {
      await f.runtime.sendDraft(f.draft()); await tick(); assert.equal(f.counters().calls, 1);
      f.paid(false); f.runs[0].finish(); await tick(); const r = f.service.list()[0];
      assert.equal(r.status, "pending", "a request already dispatched finishes after expiry"); await f.service.revoke(r.id, r.currentVersionId); assert.equal(f.service.get(r.id)?.status, "revoked");
      f.paid(true); assert.equal(inlineGenerationAccess(f.plugin).allowed, true);
      f.plugin.settings.inlineAgent.enabled = false; assert.equal(inlineGenerationAccess(f.plugin).allowed, false);
    } finally { await f.close(); }
  }
  {
    const f = await fixture();
    try {
      const req = { requestId: "guard", context: "全文", candidates: [{ id: "p", kind: "replace" as const, text: "正文", label: "段落" }] };
      const guard = createInlineProposalDispatchGuard({ currentRequest: () => req, effectiveInputBudget: 30000, assertAccess: () => requireInlineGeneration(f.plugin) });
      const context = { systemPrompt: INLINE_PROPOSAL_SYSTEM_PROMPT, messages: [{ role: "user" as const, content: inlineProposalContextContent(req), timestamp: 1 }], tools: [] };
      f.paid(false); assert.throws(() => guard(context, { runId: "before-dispatch" }), /PRO/);
      f.paid(true); guard(context, { runId: "restored" });
      const ordinary = createInlineProposalDispatchGuard({ currentRequest: () => null, effectiveInputBudget: 30000, assertAccess: () => { throw new Error("must not gate ordinary selection chat"); } }); ordinary(context, { runId: "ordinary" });
    } finally { await f.close(); }
  }
  for (const regenerate of [false, true]) {
    const f = await fixture();
    try {
      const first = await f.stage(), command = "@小墨 处理后块";
      const tail = f.document().length; f.editor.apply([{ from: tail, to: tail, insert: `\n${command}\n` }], "normal", "test-command");
      const from = f.document().indexOf(command), targetText = regenerate ? "原文段落。" : "其他原文。";
      const targetFrom = f.document().indexOf(targetText), target = { kind: "replace" as const, ...anchorAt(f.document(), { from: targetFrom, to: targetFrom + targetText.length }) };
      if (!regenerate) {
        const source = await f.service.readSource(first.id);
        await f.service.startRun(first.id, "前块尚未返回", { providerSettingsId: "p", runtimeProviderId: "p", modelId: "m", reasoning: "none", memoryMode: "normal" }, source.context);
      }
      const second = await f.service.stageProposal({ path: "正文.md", taskId: "second-task", agentId: first.agentId, agentName: first.agentName, trigger: "@", instruction: { from, to: from + command.length }, target, text: "后块已有稿。" });
      if (regenerate) {
        const source = await f.service.readSource(second.id), token = await f.service.startRun(second.id, "后块重写", { providerSettingsId: "p", runtimeProviderId: "p", modelId: "m", reasoning: "none", memoryMode: "normal" }, source.context, false);
        await f.service.completeProposal(second.id, token, source.document, target, "后块已有稿。", "重写", "PRO 验收", {});
      }
      assert.equal(f.service.get(second.id)?.status, "queued");
      f.paid(false); const currentFirst = f.service.get(first.id)!; await f.service.revoke(first.id, currentFirst.currentVersionId); await tick();
      assert.equal(f.counters().calls, 0);
      assert.equal(f.service.get(second.id)?.status, regenerate ? "queued" : "pending", "earned queue promotion remains free; regeneration stays queued");
      if (regenerate) { f.runtime.refreshAccess(); await tick(); assert.equal(f.counters().calls, 0); f.paid(true); await tick(); assert.equal(f.counters().calls, 1); f.runs[0].finish(); await tick(); }
    } finally { await f.close(); }
  }
  console.log("PASS inline PRO: migration; five denied access states with ZERO model calls/tasks/body edits; six old-task states retain drafts/threads; async preflight and final-dispatch denial; old compare/confirm/revoke/retry-save; in-flight expiry; final Provider guard; ordinary chat exclusion; free queue promotion, blocked regeneration and renewal recovery");
}
