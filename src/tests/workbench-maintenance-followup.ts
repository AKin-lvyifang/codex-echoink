import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { CURRENT_SESSION_VERSION, SessionManager, VERSION } from "@earendil-works/pi-coding-agent";
import { FileConversationCatalog } from "../harness/pi-native/file-conversation-catalog";
import { FileProductRunStore } from "../harness/pi-native/file-product-run-store";
import { FileApprovalTicketStore } from "../harness/pi-native/tool-authorization";
import { FileDomainReceiptStore } from "../harness/pi-native/domain-receipt-store";
import { PersonalMemoryRepository } from "../harness/memory/personal-memory-repository";
import { FileKnowledgeUsageStore } from "../knowledge-base/usage";
import { devicePiCanonicalStoreRoots } from "../harness/pi/pi-store-layout";
import { createPiProductionRuntimeBundle } from "../plugin/pi-production-runtime-composition";
import { prepareTaskResumeSafety } from "../plugin/task-resume-safety";
import { DEFAULT_SETTINGS, createApiProviderConfig } from "../settings/settings";
import { emptyKnowledgeFolderBindings, registerKnowledgeFolderBindings, registerKnowledgePrivateRoot } from "../knowledge-base/root-paths";
import { inspectPiSessionJsonl } from "../harness/pi-native/pi-session-durability";
import { diskApp } from "./workbench-maintenance-chain";
import type { PiChatSubmitRequest } from "../harness/pi-native/contracts";

const source = "raw/articles/星系专题.md";
const other = "raw/articles/第二范围.md";
const third = "raw/articles/第三来源.md";
const markdownSource = "raw/articles/扩展名资料.markdown";
const wiki = "知识库（wiki）/维护成果.md";
const confirmation = "都按你推荐的去做";

/** The actual production runtime, durable session, security and maintenance service. */
export async function runWorkbenchMaintenanceFollowupTests(root: string): Promise<void> {
  await fs.mkdir(root, { recursive: true });
  const report: object[] = [];
  await scenario("signal7-reopen-completed", async f => {
    const first = await f.run("请先给出这批资料的整理建议，等我确认。", { maintenanceScope: { mode: "batch", sourcePaths: [source] },
      workbenchSource: { version: 1, signalId: 7, moduleId: "knowledge-base", businessKey: "v9:raw", objects: [source], capturedAt: Date.now(), prompt: "整理这些资料" } });
    await f.reopen();
    const followed = await f.run(confirmation, {}, source);
    assert.equal(followed.tool?.isError ?? false, false, "a new ProductRun inherits the saved signal7 scope after reopening");
    assert.match(await f.wiki(), /星系专题/u);
    assert.notEqual(first.result.productRunId, followed.result.productRunId);
    const written = await f.wiki();
    const completed = await f.run(confirmation, {}, source);
    assert.match(completed.tool?.content ?? "", /请说明要维护哪些资料/u, "processed sources cannot be inherited or replaced by a confirmation search");
    assert.equal(await f.wiki(), written);
  });
  await scenario("parsed-scope-across-clarification", async f => {
    await f.run("/maintain 星系专题");
    await f.reopen();
    await f.run("你推荐先整理哪部分？");
    const followed = await f.run("按上面的方案执行", {}, source);
    assert.equal(followed.tool?.isError ?? false, false, "a clarification does not discard the latest unfinished parsed scope");
    assert.match(await f.wiki(), /星系专题/u);
  });
  for (const [name, text] of [["non-whitelist-do-all", "好的，都做吧"], ["non-whitelist-second-plan", "那就执行你推荐的第二个方案吧"]]) {
    await scenario(name, async f => {
      await f.run("请先给出这篇资料的两种整理建议，等我确认。", { maintenanceScope: { mode: "batch", sourcePaths: [source] } });
      await f.setDecoyText(text);
      await f.reopen();
      const searchCount = f.rawQueries.length;
      const followed = await f.run(text, {}, source);
      assert.equal(f.rawQueries.length, searchCount, "an unfinished frozen selection is inherited before attempting any new Raw query");
      assert.equal(followed.tool?.isError, false, "non-whitelisted follow-up wording keeps the selected source A");
      assert.match(await f.wiki(), /星系专题/u);
      assert.doesNotMatch(await f.wiki(), /第二范围/u);
    });
  }
  await scenario("legacy-signal7-partial-batch", async f => {
    const paths = [source, other, third];
    await f.run("请给出这批资料的整理建议，等我确认。", {
      workbenchSource: { version: 1, signalId: 7, moduleId: "knowledge-base", businessKey: "v9:legacy", objects: paths, capturedAt: Date.now(), prompt: "整理这些资料" }
    });
    await f.reopen();
    await f.createConversation("partial-source-run");
    await f.run("先整理星系专题", { conversationId: "partial-source-run", maintenanceScope: { mode: "batch", sourcePaths: [source] } }, source);
    const followed = await f.run("行，就这么办", {}, paths);
    for (const selected of paths) assert.ok((await f.wiki()).includes(selected), "a partially completed task keeps all three original source paths");
    assert.doesNotMatch(followed.tool?.content ?? "", /维护参数未通过/u);
  });
  await scenario("no-scope-readable", async f => {
    const before = await f.wiki();
    const followed = await f.run(confirmation, {}, source);
    assert.match(followed.tool?.content ?? "", /请说明要维护哪些资料/u);
    assert.doesNotMatch(followed.tool?.content ?? "", /knowledge_maintenance_command_unavailable/u);
    assert.equal(await f.wiki(), before);
  });
  await scenario("stale-binding-is-not-refreshed", async f => {
    await f.run("请先给出建议，等我确认。", { maintenanceScope: { mode: "batch", sourcePaths: [source], folderBindingsRevision: 999 } });
    await f.reopen();
    const followed = await f.run(confirmation, {}, source);
    assert.match(followed.tool?.content ?? "", /目录配置已变化/u, "persisting selection facts must not bless a stale directory revision");
    assert.doesNotMatch(await f.wiki(), /星系专题/u);
  });
  await scenario("explicit-new-scope", async f => {
    await f.run("/maintain 星系专题");
    const followed = await f.run(`请改为维护 ${other} 这篇资料，并更新 ${wiki}`, {}, other);
    assert.equal(followed.tool?.isError ?? false, false, "an explicit new source overrides the earlier scope without /maintain");
    assert.match(await f.wiki(), /第二范围/u);
    assert.doesNotMatch(await f.wiki(), /星系专题/u);
  });
  await scenario("new-scope-advice-then-confirmation", async f => {
    await f.run("/maintain 星系专题");
    await f.run(`请改为整理 ${other} 这篇，先给建议，等我确认。`);
    assert.doesNotMatch(await f.wiki(), /第二范围/u, "capturing a new selection does not execute maintenance");
    await f.reopen();
    const followed = await f.run(confirmation, {}, other);
    assert.equal(followed.tool?.isError ?? false, false, "the third turn inherits B selected by the advice-only second turn");
    assert.match(await f.wiki(), /第二范围/u);
    assert.doesNotMatch(await f.wiki(), /星系专题/u);
  });
  await scenario("bare-path-advice-overrides-saved-scope", async f => {
    await f.run("/maintain 星系专题");
    await f.run(`就这篇 ${other}，先给建议`);
    assert.doesNotMatch(await f.wiki(), /第二范围/u);
    await f.reopen();
    const searchCount = f.rawQueries.length;
    const followed = await f.run("好的，都做吧", {}, other);
    assert.equal(f.rawQueries.length, searchCount);
    assert.equal(followed.tool?.isError, false);
    assert.match(await f.wiki(), /第二范围/u);
    assert.doesNotMatch(await f.wiki(), /星系专题/u);
  });
  await scenario("wiki-target-followup-keeps-source-scope", async f => {
    await f.run("/maintain 星系专题");
    const queryCount = f.rawQueries.length;
    await f.run(`按建议更新 ${wiki}，先给建议`);
    const advised = await f.run(`请维护 ${wiki} 这篇笔记，先给建议`);
    assert.equal(f.rawQueries.length, queryCount, "target-only advice must not resolve a new Raw selection regardless of the leading verb");
    const safety = await prepareTaskResumeSafety({ catalog: f.catalog, productRuns: f.productRuns, receipts: f.receipts, approvals: f.approvals,
      vaultRootPath: f.vault, conversationId: "followup", interruptedRunId: advised.result.productRunId });
    assert.ok(JSON.stringify(safety.maintenanceContext).includes(source), "recovery and live runtime use the same source/target role boundary");
    await f.reopen();
    const searchCount = f.rawQueries.length;
    const followed = await f.run(`请维护 ${wiki} 这篇笔记`, {}, source);
    assert.equal(f.rawQueries.length, searchCount, "a Wiki target cannot replace the selected Raw source with a new query");
    assert.equal(followed.tool?.isError, false);
    assert.match(await f.wiki(), /星系专题/u);
  });
  await scenario("advice-empty-raw", async f => {
    const before = f.bodies.length;
    const advised = await f.run("请整理知识库的维护流程，先给我建议，不要执行。");
    assert.equal(advised.result.terminalState, "completed");
    assert.ok(f.bodies.length > before, "an unmatched advice-only request still reaches the provider in an empty Raw library");
    const confirmed = await f.run(confirmation, {}, source);
    assert.match(confirmed.tool?.content ?? "", /请说明要维护哪些资料/u);
  }, true);
  await scenario("missing-new-source-keeps-old-scope-blocked", async f => {
    await f.run("/maintain 星系专题");
    const before = f.bodies.length;
    const advised = await f.run("请改为整理 raw/articles/不存在B.md 这篇资料，先给建议，等我确认。");
    assert.equal(advised.result.terminalState, "completed");
    assert.ok(f.bodies.length > before);
    const confirmed = await f.run(confirmation, {}, source);
    assert.match(confirmed.tool?.content ?? "", /请说明要维护哪些资料/u);
    assert.doesNotMatch(await f.wiki(), /星系专题/u);
  });
  await scenario("unmatched-new-advice-blocks-old-scope", async f => {
    await f.run("/maintain 星系专题");
    const before = f.bodies.length;
    const advised = await f.run("请整理知识库的zzscopev9nomatch987流程，先给我建议，不要执行。");
    assert.equal(advised.result.terminalState, "completed");
    assert.ok(f.bodies.length > before);
    const conversation = (await f.catalog.get("followup"))!;
    const session = inspectPiSessionJsonl({ sessionRoot: f.catalog.sessionRootPath, sessionFile: conversation.sessionFile! });
    assert.ok(session.valid);
    assert.equal(session.entries.some(entry => entry.type === "custom" && entry.customType === "echoink-maintenance-scope-v1"
      && (entry.data as { productRunId?: string }).productRunId === advised.result.productRunId), false, "the new query had no resolvable Raw selection");
    await f.reopen();
    const confirmed = await f.run(confirmation, {}, source);
    assert.match(confirmed.tool?.content ?? "", /请说明要维护哪些资料/u);
    assert.doesNotMatch(await f.wiki(), /星系专题/u);
  });
  await scenario("explicit-markdown-extension", async f => {
    const followed = await f.run(`请维护 ${markdownSource} 并更新 ${wiki}`, {}, markdownSource);
    assert.ok((await f.wiki()).includes(markdownSource), ".markdown is preserved as the complete source path");
    assert.doesNotMatch(followed.tool?.content ?? "", /维护参数未通过/u);
  });
  await scenario("unmatched-scope-readable", async f => {
    const followed = await f.run("zzscopev9nomatch987", {}, source);
    assert.match(followed.tool?.content ?? "", /请说明要维护哪些资料/u);
  });
  await scenario("topic-boundary", async f => {
    await f.run("/maintain 星系专题");
    await f.run("换个话题，帮我想一个旅行标题。");
    const followed = await f.run(confirmation, {}, source);
    assert.match(followed.tool?.content ?? "", /请说明要维护哪些资料/u, "confirmation of another topic cannot reactivate an old maintenance scope");
  });
  await scenario("conversation-isolation", async f => {
    await f.run("/maintain 星系专题");
    await f.createConversation("other-conversation");
    const followed = await f.run(confirmation, { conversationId: "other-conversation" }, source);
    assert.match(followed.tool?.content ?? "", /请说明要维护哪些资料/u);
  });
  await scenario("branch-isolation", async f => {
    const first = await f.run("/maintain 星系专题");
    const entry = (await f.catalog.get("followup"))!;
    const inspection = inspectPiSessionJsonl({ sessionRoot: f.catalog.sessionRootPath, sessionFile: entry.sessionFile! });
    assert.ok(inspection.valid);
    const user = inspection.entries.find(item => item.id === first.result.userEntryId)!;
    assert.ok(user.parentId);
    await f.runtime().navigateBranch("followup", user.parentId!, { summarize: false });
    const followed = await f.run(confirmation, {}, source);
    assert.match(followed.tool?.content ?? "", /请说明要维护哪些资料/u, "only scope belonging to a user entry on the selected branch is eligible");
  });
  await scenario("production-resume", async f => {
    const first = await f.run("/maintain 星系专题");
    assert.equal(first.result.terminalState, "failed", "the untouched source remains unfinished");
    const interrupted = await f.interruptConfirmation();
    assert.equal(interrupted.terminalState, "cancelled");
    await f.reopen();
    const safety = await prepareTaskResumeSafety({ catalog: f.catalog, productRuns: f.productRuns, receipts: f.receipts, approvals: f.approvals,
      vaultRootPath: f.vault, conversationId: "followup", interruptedRunId: interrupted.productRunId });
    assert.match(JSON.stringify(safety), /星系专题/u, "the production resume snapshot carries the saved original scope");
    const resumed = await f.run("请带着本任务已有上下文继续，先核对已经完成的内容和未完成步骤。", {
      resumeContext: { safety, interruption: interrupted.interruption! }
    }, source);
    assert.equal(resumed.tool?.isError ?? false, false, "runtime consumes the scope from the actual production recovery snapshot");
    assert.equal(resumed.result.piSessionId, first.result.piSessionId);
    assert.match(await f.wiki(), /星系专题/u);
  });
  await fs.writeFile(path.join(root, "followup-scope-report.json"), JSON.stringify(report, null, 2));
  console.log(`Workbench follow-up scope: PASS (${report.length} production scenarios)`);

  async function scenario(name: string, body: (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>, emptyRaw = false) {
    const f = await fixture(root, name, emptyRaw);
    try { await body(f); report.push({ name, passed: true, vault: f.vault, runs: f.runs }); }
    finally { await f.close(); await fs.writeFile(path.join(root, `followup-${name}.json`), JSON.stringify({ name, vault: f.vault, runs: f.runs, requests: f.bodies }, null, 2)); }
  }
}

async function fixture(root: string, name: string, emptyRaw = false) {
  const vault = await fs.mkdtemp(path.join(root, `v9-${name}-`));
  await fs.mkdir(path.join(vault, "raw/articles"), { recursive: true });
  await fs.mkdir(path.join(vault, "知识库（wiki）"), { recursive: true });
  if (!emptyRaw) {
    await fs.writeFile(path.join(vault, source), "# 星系专题\n星系专题记录可追溯的观测资料。\n");
    // A confirmation search would find this unrelated source, exposing widening.
    await fs.writeFile(path.join(vault, other), `# 第二范围\n${confirmation}。第二范围是另一件事的合成资料。\n`);
    await fs.writeFile(path.join(vault, third), "# 第三来源\n第三篇合成资料记录另一组观测。\n");
    await fs.writeFile(path.join(vault, markdownSource), "# 扩展名资料\n这篇合成资料使用完整的 Markdown 扩展名。\n");
  }
  await fs.writeFile(path.join(vault, wiki), "# 维护成果\n尚未整理。\n");
  const replies: any[] = [], bodies: any[] = [], runs: any[] = [];
  let responseNumber = 0, callNumber = 0, blockNextRequest = false;
  const server = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    bodies.push(JSON.parse(body));
    if (blockNextRequest) { blockNextRequest = false; return; }
    const message = replies.shift();
    if (!message) { res.writeHead(500); res.end("Unexpected extra provider request"); return; }
    const delta = { ...message, ...(message.tool_calls ? { tool_calls: message.tool_calls.map((call: any, index: number) => ({ ...call, index })) } : {}) };
    const chunk = { id: `completion-${++responseNumber}`, object: "chat.completion.chunk", created: 1, model: "deepseek-chat", choices: [{ index: 0, delta, finish_reason: null }] };
    const done = { ...chunk, choices: [{ index: 0, delta: {}, finish_reason: message.tool_calls ? "tool_calls" : "stop" }] };
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(done)}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address === "object");
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.memory.useLongTermMemory = false;
  const provider = createApiProviderConfig("deepseek", "fixture-provider");
  provider.baseUrl = `http://127.0.0.1:${address.port}/v1`; provider.apiKey = "synthetic-test-only";
  settings.apiProviders = [provider]; settings.activeApiProviderId = provider.id;
  const bindings = emptyKnowledgeFolderBindings();
  for (const [role, directory] of [["raw", "raw"], ["wiki", "知识库（wiki）"]] as const) bindings.roles[role] = { enabled: true, readPaths: [directory], writePath: directory, allowedSubdirectories: [] };
  settings.knowledgeBase.folderBindings = bindings;
  const unbind = registerKnowledgeFolderBindings(vault, () => bindings);
  const pluginRoot = path.join(vault, ".obsidian/plugins/echoink"), storage = path.join(pluginRoot, "pi-agent-product-v1");
  await fs.mkdir(storage, { recursive: true });
  registerKnowledgePrivateRoot(vault, path.join(storage, "knowledge"));
  const vaultId = `fixture-${path.basename(vault)}`;
  const catalog = new FileConversationCatalog({ storageRootPath: storage, vaultId });
  const productRuns = new FileProductRunStore({ storageRootPath: storage, vaultId, catalog });
  const approvals = new FileApprovalTicketStore({ storageRootPath: storage, vaultId });
  const receipts = new FileDomainReceiptStore({ storageRootPath: storage, vaultId });
  const knowledgeUsageStore = new FileKnowledgeUsageStore({ storageRootPath: storage, vaultId });
  const personalMemory = new PersonalMemoryRepository({ vaultPath: storage, vaultId });
  await Promise.all([catalog.initialize(), productRuns.initialize(), approvals.initialize(), receipts.initialize(), knowledgeUsageStore.initialize(), personalMemory.initialize()]);
  const device = path.join(vault, "fixture-device"); await fs.mkdir(device);
  const plugin = { app: diskApp(vault), settings, getVaultPath: () => vault, getPluginDataDirName: () => "echoink", persistPiNativeSettings: async () => {},
    resolveOpenAICodexAccessToken: async () => "", buildRuntimeEchoInkResourceCatalog: async () => [], readPersistedEchoInkResourceSnapshot: async () => settings.resources,
    listEchoInkMcpTools: async () => [], callEchoInkMcpTool: async () => { throw new Error("unused MCP"); }, callEchoInkMcpToolFromResourceSnapshot: async () => { throw new Error("unused MCP"); },
    getTodoStore: () => ({}), createSkillReviewLlmPort: () => null, requireAvailableEchoInkSkill: async () => { throw new Error("unexpected Skill"); },
    getSkillRuntimeCoordinator: () => ({ inspectBuiltinSkills: async () => {}, advanceLifecycle: async () => {}, selectForTask: async () => null, reviewCompletedTask: async () => {}, recordUse: async () => {} }) } as never;
  const localData = { vaultRootPath: vault, pluginDataRootPath: pluginRoot, piNativeStorageRootPath: storage,
    deviceScope: { stateRootPath: device, vaultIdDigest: vaultId, deviceIdDigest: "fixture-device" },
    storeScope: { pluginDataRootPath: pluginRoot, vaultRootPath: vault, deviceControlRootPath: device, vaultIdDigest: vaultId, deviceIdDigest: "fixture-device" },
    roots: devicePiCanonicalStoreRoots(pluginRoot), catalog, productRuns, approvals, receipts, knowledgeUsageStore, personalMemory,
    sessionApi: { codingAgentVersion: VERSION, currentSessionVersion: CURRENT_SESSION_VERSION, open: (file: string, directory: string, cwd: string) => SessionManager.open(file, directory, cwd) } } as never;
  let bundle = await createPiProductionRuntimeBundle(plugin, localData);
  const rawQueries: string[] = [];
  const observeRawQueries = () => {
    const index = bundle.knowledgeAgentIndex;
    const search = index.search.bind(index);
    index.search = async request => {
      if (request.kinds?.length === 1 && request.kinds[0] === "raw") rawQueries.push(request.query);
      return await search(request);
    };
  };
  observeRawQueries();
  const createConversation = (conversationId: string) => bundle.runtime.createConversation({ conversationId, title: "维护跟进", cwd: vault });
  await createConversation("followup");
  return { vault, catalog, productRuns, approvals, receipts, bodies, runs, rawQueries, createConversation, runtime: () => bundle.runtime,
    wiki: () => fs.readFile(path.join(vault, wiki), "utf8"),
    setDecoyText: (text: string) => fs.writeFile(path.join(vault, other), `# 第二范围\n${text}。这篇不相关资料专门检测确认语被拿去检索。\n`),
    reopen: async () => { await bundle.runtime.shutdown(); bundle = await createPiProductionRuntimeBundle(plugin, localData); observeRawQueries(); },
    close: async () => { await bundle.runtime.shutdown(); unbind(); await new Promise<void>(resolve => server.close(() => resolve())); },
    interruptConfirmation: async () => {
      const start = bodies.length;
      blockNextRequest = true;
      const handle = await bundle.runtime.submit({ conversationId: "followup", text: confirmation, submittedAt: Date.now(), permission: "workspace-write",
        runtimeProviderId: provider.runtimeProviderId, modelId: provider.models[0].id, reasoning: "none", memoryMode: "no_memory" });
      for (let count = 0; bodies.length === start && count < 100; count++) await new Promise(resolve => setTimeout(resolve, 10));
      assert.ok(bodies.length > start, "the confirmation was accepted and its provider request began before interruption");
      await bundle.runtime.abort("followup");
      const result = await handle.result; runs.push({ text: confirmation, result }); return result;
    },
    run: async (text: string, extra: Partial<PiChatSubmitRequest> = {}, maintainSource?: string | readonly string[]) => {
      const requestStart = bodies.length;
      const toolCall = (name: string, args: object) => ({ id: `v9-${++callNumber}`, type: "function", function: { name, arguments: JSON.stringify(args) } });
      let maintenanceCallId: string | undefined;
      if (maintainSource) {
        const paths = typeof maintainSource === "string" ? [maintainSource] : maintainSource;
        const before = await fs.readFile(path.join(vault, wiki), "utf8");
        replies.push({ role: "assistant", content: null, tool_calls: [...paths.map(relativePath => toolCall("note_read", { relativePath })), toolCall("note_read", { relativePath: wiki })] });
        const maintenance = toolCall("knowledge_maintain", { sourcePaths: paths, candidateActions: [{ targetPath: wiki,
          content: `# 维护成果\n${paths.map(selected => `已整理 [[${selected}|原始资料]]。`).join("\n")}\n`, expectedTarget: { kind: "file", contentRevision: `sha256:${createHash("sha256").update(before).digest("hex")}` } }],
          assessments: [{ claim: "资料具有可追溯来源", status: "valid", evidence: paths, asOf: "2026-10-21", verification: "local_verified" }] });
        maintenanceCallId = maintenance.id;
        replies.push({ role: "assistant", content: null, tool_calls: [maintenance] });
      }
      replies.push({ role: "assistant", content: maintainSource ? "本轮依据工具真实结果结束。" : "建议按现有知识库结构整理，等待确认后再执行。" });
      const handle = await bundle.runtime.submit({ conversationId: "followup", text, submittedAt: Date.now(), permission: "workspace-write",
        runtimeProviderId: provider.runtimeProviderId, modelId: provider.models[0].id, reasoning: "none", memoryMode: "no_memory", ...extra });
      const result = await handle.result;
      assert.equal(replies.length, 0, "the production runtime consumed exactly the planned provider replies");
      const tool = bodies.slice(requestStart).flatMap(body => body.messages).filter((message: any) => message.role === "tool" && message.tool_call_id === maintenanceCallId).at(-1);
      if (maintainSource) {
        assert.ok(tool, "the production Tool result reached the provider");
        const conversation = (await catalog.get(extra.conversationId ?? "followup"))!;
        const inspection = inspectPiSessionJsonl({ sessionRoot: catalog.sessionRootPath, sessionFile: conversation.sessionFile! });
        assert.ok(inspection.valid);
        const receipt = inspection.entries.find(entry => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolCallId === maintenanceCallId);
        assert.ok(receipt?.type === "message" && receipt.message.role === "toolResult");
        tool.isError = receipt.message.isError;
      }
      const outcome = { text, result, tool }; runs.push(outcome); return outcome;
    }
  };
}
