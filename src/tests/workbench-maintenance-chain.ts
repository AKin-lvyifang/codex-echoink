import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { TFile, TFolder } from "./obsidian-shim";
import { CURRENT_SESSION_VERSION, SessionManager, VERSION } from "@earendil-works/pi-coding-agent";
import { FileConversationCatalog } from "../harness/pi-native/file-conversation-catalog";
import { FileProductRunStore } from "../harness/pi-native/file-product-run-store";
import { FileApprovalTicketStore } from "../harness/pi-native/tool-authorization";
import { FileDomainReceiptStore } from "../harness/pi-native/domain-receipt-store";
import { PersonalMemoryRepository } from "../harness/memory/personal-memory-repository";
import { FileKnowledgeUsageStore } from "../knowledge-base/usage";
import { devicePiCanonicalStoreRoots } from "../harness/pi/pi-store-layout";
import { createPiProductionRuntimeBundle } from "../plugin/pi-production-runtime-composition";
import { DEFAULT_SETTINGS, createApiProviderConfig } from "../settings/settings";
import { emptyKnowledgeFolderBindings, registerKnowledgeFolderBindings, registerKnowledgePrivateRoot } from "../knowledge-base/root-paths";
import { readRawDigestRegistry, rawDigestRecordFromMarkdown } from "../knowledge-base/raw-digest";

/** Full production composition and HTTP transport; only the model replies and Obsidian host are fixtures. */
export async function runWorkbenchMaintenanceChain(root: string, bound: boolean, secondTurn = false, expectSecondSuccess = false): Promise<void> {
  const vault = await fs.mkdtemp(path.join(root, bound ? "bound-chain-" : "before-chain-"));
  const source = "raw/articles/合成来源.md", wiki = "知识库（wiki）/已有页面.md";
  const wikiBefore = "# 已有页面\n\n这是保留的合成原稿。\n";
  await fs.mkdir(path.join(vault, "raw/articles"), { recursive: true });
  await fs.mkdir(path.join(vault, "知识库（wiki）"), { recursive: true });
  await fs.writeFile(path.join(vault, source), "# 合成来源\n可靠的笔记维护必须保留资料出处。\n");
  await fs.writeFile(path.join(vault, wiki), wikiBefore);
  const source2 = "raw/articles/第二合成来源.md";
  await fs.writeFile(path.join(vault, source2), "# 第二合成来源\n都按你推荐的去做。第二篇合成资料提供新证据。\n");
  const bodies: any[] = [];
  let automaticSkillSelections = 0;
  let next = 0;
  const toolCall = (name: string, args: object, id = name) => ({ id: `fixture-${id}`, type: "function", function: { name, arguments: JSON.stringify(args) } });
  const candidate = { candidateActions: [{ targetPath: wiki, content: `# 已有页面\n\n原稿与来源合并。\n[[${source}|原始材料]]\n`, expectedTarget: { kind: "file", contentRevision: `sha256:${createHash("sha256").update(wikiBefore).digest("hex")}` } }], sourcePaths: [source], assessments: [{ claim: "出处可追溯", status: "valid", evidence: [source], asOf: "2026-10-21", verification: "local_verified" }] };
  const replies = [
    { role: "assistant", content: null, tool_calls: [toolCall("user_question", { questions: [{ questionId: "maintain-choice", prompt: "按推荐方案更新已有页面吗？", selection: "single", allowSupplement: true, options: [{ optionId: "recommended", label: "按推荐维护" }, { optionId: "hold", label: "暂不维护" }] }] })] },
    { role: "assistant", content: null, tool_calls: [toolCall("note_read", { relativePath: source }, "read-source"), toolCall("note_read", { relativePath: wiki }, "read-wiki")] },
    { role: "assistant", content: null, tool_calls: [toolCall("knowledge_maintain", candidate)] },
    { role: "assistant", content: "已按实际工具回执结束。" }
  ];
  const server = createServer(async (req, res) => {
    let input = ""; for await (const chunk of req) input += chunk;
    bodies.push(JSON.parse(input));
    const message = replies[next++];
    if (!message) { res.writeHead(500); res.end("Unexpected extra provider request"); return; }
    const delta = { ...message, ...(message.tool_calls ? { tool_calls: message.tool_calls.map((call, index) => ({ ...call, index })) } : {}) };
    const chunk = { id: `completion-${next}`, object: "chat.completion.chunk", created: 1, model: "deepseek-chat", choices: [{ index: 0, delta, finish_reason: null }] };
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
  const privateRoot = path.join(storage, "knowledge"); registerKnowledgePrivateRoot(vault, privateRoot);
  const vaultId = `fixture-${path.basename(vault)}`;
  const catalog = new FileConversationCatalog({ storageRootPath: storage, vaultId });
  const productRuns = new FileProductRunStore({ storageRootPath: storage, vaultId, catalog });
  const approvals = new FileApprovalTicketStore({ storageRootPath: storage, vaultId });
  const receipts = new FileDomainReceiptStore({ storageRootPath: storage, vaultId });
  const knowledgeUsageStore = new FileKnowledgeUsageStore({ storageRootPath: storage, vaultId });
  const personalMemory = new PersonalMemoryRepository({ vaultPath: storage, vaultId });
  await Promise.all([catalog.initialize(), productRuns.initialize(), approvals.initialize(), receipts.initialize(), knowledgeUsageStore.initialize(), personalMemory.initialize()]);
  const device = path.join(vault, "fixture-device"); await fs.mkdir(device);
  const app = diskApp(vault);
  const plugin = { app, settings, getVaultPath: () => vault, getPluginDataDirName: () => "echoink", persistPiNativeSettings: async () => {},
    resolveOpenAICodexAccessToken: async () => "", buildRuntimeEchoInkResourceCatalog: async () => [], readPersistedEchoInkResourceSnapshot: async () => settings.resources,
    listEchoInkMcpTools: async () => [], callEchoInkMcpTool: async () => { throw new Error("unused MCP"); }, callEchoInkMcpToolFromResourceSnapshot: async () => { throw new Error("unused MCP"); },
    getTodoStore: () => ({}), createSkillReviewLlmPort: () => null, requireAvailableEchoInkSkill: async () => { throw new Error("unexpected Skill"); },
    getSkillRuntimeCoordinator: () => ({ inspectBuiltinSkills: async () => {}, advanceLifecycle: async () => {}, selectForTask: async () => { automaticSkillSelections++; return null; },
      reviewCompletedTask: async () => {}, recordUse: async () => {} }) } as never;
  const localData = { vaultRootPath: vault, pluginDataRootPath: pluginRoot, piNativeStorageRootPath: storage,
    deviceScope: { stateRootPath: device, vaultIdDigest: vaultId, deviceIdDigest: "fixture-device" },
    storeScope: { pluginDataRootPath: pluginRoot, vaultRootPath: vault, deviceControlRootPath: device, vaultIdDigest: vaultId, deviceIdDigest: "fixture-device" },
    roots: devicePiCanonicalStoreRoots(pluginRoot), catalog, productRuns, approvals, receipts, knowledgeUsageStore, personalMemory,
    sessionApi: { codingAgentVersion: VERSION, currentSessionVersion: CURRENT_SESSION_VERSION, open: (file: string, directory: string, cwd: string) => SessionManager.open(file, directory, cwd) } } as never;
  let bundle: Awaited<ReturnType<typeof createPiProductionRuntimeBundle>> | undefined;
  let subscription: { unsubscribe(): void } | undefined;
  try {
    bundle = await createPiProductionRuntimeBundle(plugin, localData);
    const conversation = await bundle.runtime.createConversation({ conversationId: "workbench-chain", title: "合成资料维护", cwd: vault });
    const handle = await bundle.runtime.submit({ conversationId: conversation.conversationId,
      text: bound ? "/maintain" : "请整理当前版本尚未处理、已改版、失败或待校准的资料，沿用现有知识库维护流程。",
      permission: "workspace-write", submittedAt: Date.now(), runtimeProviderId: provider.runtimeProviderId, modelId: provider.models[0].id,
      reasoning: "none", memoryMode: "no_memory", ...(bound ? { maintenanceScope: { mode: "batch" as const, sourcePaths: [source] } } : {}),
      workbenchSource: { version: 1, signalId: 7, moduleId: "knowledge-base", businessKey: "workbench:knowledge-base:raw:fixture", objects: [source], capturedAt: Date.now(), prompt: "整理这些资料" } });
    subscription = bundle.runtime.subscribeProductRun(handle.productRunId, event => {
      if (event.type !== "interaction_requested" || event.interaction.kind !== "question") return;
      const interaction = event.interaction;
      const respond = () => {
        const binding = bundle!.interactionBroker.bindingFor({ conversationId: conversation.conversationId, piSessionId: interaction.piSessionId, productRunId: handle.productRunId, interactionId: interaction.interactionId });
        if (!binding) { setTimeout(respond, 0); return; }
        assert.equal(binding.submit([{ questionId: "maintain-choice", selectedOptionIds: ["recommended"], supplement: "都按你推荐的去做" }]), true);
      };
      respond();
    });
    const result = await handle.result;
    const projection = await bundle.runtime.readProjection(conversation.conversationId);
    const wikiAfter = await fs.readFile(path.join(vault, wiki), "utf8");
    const rawAfter = rawDigestRecordFromMarkdown(await fs.readFile(path.join(vault, source)));
    const registry = await readRawDigestRegistry(vault, true);
    const evidence = { fixture: "deterministic-loopback-provider; production runtime, security, knowledge port and disk-backed Obsidian host", vault, bound, result, automaticSkillSelections,
      providerCalls: bodies.length, toolResults: bodies.flatMap(body => body.messages.filter((message: any) => message.role === "tool")),
      projection: projection.messages, wikiAfter, rawAfter, registryEntry: registry.entries[source] ?? null };
    await fs.writeFile(path.join(root, bound ? "chain-after.json" : "chain-before.json"), JSON.stringify(evidence, null, 2));
    assert.equal(bodies.length, 4, "the model asked, received an answer, read both files, maintained, and received the real result");
    assert.equal(automaticSkillSelections, bound ? 0 : 1, "only the maintenance entry skips automatic Skill matching");
    assert.match(JSON.stringify(evidence.toolResults.filter(message => message.tool_call_id === "fixture-user_question")), /都按你推荐的去做/u);
    if (bound) {
      assert.notEqual(wikiAfter, wikiBefore); assert.match(wikiAfter, /echoink-source/u);
      assert.ok(registry.entries[source]); assert.deepEqual(registry.entries[source].evidencePaths, [wiki]);
    } else {
      assert.notEqual(wikiAfter, wikiBefore, "the original ordinary-chat path can maintain valid selected sources");
      assert.match(wikiAfter, /echoink-source/u); assert.ok(registry.entries[source]);
    }
    if (secondTurn) {
      const nextCandidate = { ...candidate, sourcePaths: [source2], candidateActions: [{ targetPath: wiki,
        content: `${wikiAfter}\n第二篇补充内容。\n[[${source2}|原始材料]]\n`,
        expectedTarget: { kind: "file", contentRevision: `sha256:${createHash("sha256").update(wikiAfter).digest("hex")}` } }] };
      replies.push({ role: "assistant", content: null, tool_calls: [toolCall("note_read", { relativePath: source2 }, "read-source2"), toolCall("note_read", { relativePath: wiki }, "reread-wiki")] });
      replies.push({ role: "assistant", content: null, tool_calls: [toolCall("knowledge_maintain", nextCandidate, "maintain-second")] });
      replies.push({ role: "assistant", content: "第二轮按真实回执结束。" });
      const second = await bundle.runtime.submit({ conversationId: conversation.conversationId, text: "都按你推荐的去做",
        permission: "workspace-write", submittedAt: Date.now(), runtimeProviderId: provider.runtimeProviderId, modelId: provider.models[0].id,
        reasoning: "none", memoryMode: "no_memory" });
      const secondResult = await second.result;
      const reread = await fs.readFile(path.join(vault, wiki), "utf8");
      const secondTool = bodies.flatMap(body => body.messages).filter((message: any) => message.role === "tool" && message.tool_call_id === "fixture-maintain-second").at(-1);
      assert.ok(secondTool, "the second ProductRun reused its production Tool closure");
      const afterRegistry = await readRawDigestRegistry(vault, true);
      await fs.writeFile(path.join(root, expectSecondSuccess ? "second-turn-after.json" : "second-turn-before.json"), JSON.stringify({ vault, firstRun: result.productRunId, secondRun: secondResult.productRunId, result: secondResult, toolResult: secondTool, wikiBefore: wikiAfter, wikiAfter: reread, firstSource: afterRegistry.entries[source], secondSource: afterRegistry.entries[source2] ?? null }, null, 2));
      assert.notEqual(result.productRunId, secondResult.productRunId);
      if (expectSecondSuccess) {
        assert.match(reread, /raw\/articles\/合成来源\.md/u); assert.match(reread, /raw\/articles\/第二合成来源\.md/u);
        assert.ok(afterRegistry.entries[source2]); assert.doesNotMatch(secondTool.content, /来源不在本次范围/u);
        assert.equal(afterRegistry.entries[source].runId, registry.entries[source].runId, "a retained old source is not marked processed by the new batch");
      } else {
        assert.equal(reread, wikiAfter); assert.match(secondTool.content, /来源不在本次范围.*raw\/articles\/合成来源\.md/u);
        assert.equal(afterRegistry.entries[source2], undefined);
      }
      console.log(`Workbench second ProductRun (${expectSecondSuccess ? "after" : "before"}): PASS; expectedTarget baseline ${expectSecondSuccess ? "preserved" : "reproduced source rejection"}`);
    }
    console.log(`Workbench full production chain (${bound ? "bound" : "before"}): PASS; evidence in ${root}`);
  } finally {
    subscription?.unsubscribe(); await bundle?.runtime.shutdown(); unbind();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

export function diskApp(root: string): any {
  const files = new Map<string, any>();
  const scan = (directory = "") => {
    for (const name of readdirSync(path.join(root, directory))) {
      if (name.startsWith(".")) continue;
      const relative = directory ? `${directory}/${name}` : name, stat = statSync(path.join(root, relative));
      const item = stat.isDirectory() ? Object.assign(new TFolder(), { path: relative, name, children: [] }) : Object.assign(new TFile(relative), { name, basename: name.replace(/\.[^.]+$/u, ""), extension: name.split(".").at(-1), stat: { size: stat.size, mtime: stat.mtimeMs, ctime: stat.ctimeMs } });
      files.set(relative, item); if (stat.isDirectory()) scan(relative);
    }
  };
  scan();
  const listeners = new Map<string, Set<(...args: any[]) => void>>();
  const on = (event: string, callback: (...args: any[]) => void) => { const set = listeners.get(event) ?? new Set(); set.add(callback); listeners.set(event, set); return { event, callback }; };
  const offref = (ref: any) => listeners.get(ref.event)?.delete(ref.callback);
  const process = async (relative: string, change: (before: string) => string) => { await fs.writeFile(path.join(root, relative), change(await fs.readFile(path.join(root, relative), "utf8"))); scan(); for (const fn of listeners.get("modify") ?? []) fn(files.get(relative)); };
  return { vault: { on, offref, config: {}, getConfig: () => "", getFiles: () => [...files.values()].filter(file => file instanceof TFile),
    getMarkdownFiles: () => [...files.values()].filter(file => file instanceof TFile && file.extension === "md"),
    getAbstractFileByPath: (relative: string) => files.get(relative) ?? null, getFileByPath: (relative: string) => files.get(relative) ?? null,
    read: (file: any) => fs.readFile(path.join(root, file.path), "utf8"), cachedRead: (file: any) => fs.readFile(path.join(root, file.path), "utf8"), readBinary: (file: any) => fs.readFile(path.join(root, file.path)),
    process: (file: any, change: (before: string) => string) => process(file.path, change),
    adapter: { process }, createFolder: async (relative: string) => { await fs.mkdir(path.join(root, relative), { recursive: true }); scan(); },
    create: async (relative: string, content: string) => { await fs.writeFile(path.join(root, relative), content, { flag: "wx" }); scan(); return files.get(relative); } },
    metadataCache: { on, offref, getFileCache: () => null, getFirstLinkpathDest: () => null, resolvedLinks: {} },
    workspace: { getActiveFile: () => null, layoutReady: true }, internalPlugins: { getPluginById: () => null } };
}
