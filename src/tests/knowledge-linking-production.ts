import { executeStagedMaintenanceFixture } from "./maintenance-staged-fixture";
import { createAgentSession, ModelRuntime, SettingsManager, SessionManager, CURRENT_SESSION_VERSION, VERSION, type SessionManager as PiSessionManager } from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { PiNativeConversationRuntime } from "../harness/pi-native/pi-native-conversation-runtime";
import { FileConversationCatalog } from "../harness/pi-native/file-conversation-catalog";
import { FileProductRunStore } from "../harness/pi-native/file-product-run-store";
import { createProductionPiKnowledgeRuntime } from "../plugin/pi-production-runtime-composition";
import { KnowledgeUsageBridge, FileKnowledgeUsageStore } from "../knowledge-base/usage";
import { knowledgeLinkingProgressVisible } from "../ui/codex-view/knowledge-linking-progress";
import { createPiKnowledgeLinkingTool, knowledgeLinkingInlineExtension, registerPiKnowledgeLinkingBatch, PI_KNOWLEDGE_LINKING_TOOL, type PiKnowledgeLinkingBatch } from "../harness/pi-native/pi-knowledge-linking-tool";
import { createControlledPiToolRegistration, createControlledVaultResourceLoader } from "../harness/pi-native/controlled-resources";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { KnowledgeLinkingService, type KnowledgeLinkingHost } from "../plugin/knowledge-linking-service";
import { KnowledgeLinkingStateStore } from "../knowledge-base/knowledge-linking-state";
import { readKnowledgeLinkingDocument, buildKnowledgeLinkingPatch, buildKnowledgeLinkingTargets, scanKnowledgeLinkingMentions } from "../knowledge-base/knowledge-linking";
import { KnowledgeAgentIndex } from "../knowledge-base/knowledge-agent-index";
import { registerKnowledgeFolderBindings } from "../knowledge-base/root-paths";
import { emptyKnowledgeFolderBindings } from "../knowledge-base/folder-bindings";
import { ObsidianVaultDomainAdapter } from "../plugin/obsidian-vault-domain-adapter";
import { VaultTargetResolver } from "../harness/pi-native/vault-target-resolver";
import { VaultDomainService } from "../harness/pi-native/vault-domain-service";
import { ProductionPiKnowledgeMaintenanceToolPort, readPrivateMaintenanceRecords } from "../plugin/pi-knowledge-maintenance-production";
import { canonicalRawMarkdownForDigest, rawDigestFingerprint } from "../knowledge-base/raw-digest";
import type { KnowledgeLinkingTask } from "../knowledge-base/knowledge-linking-types";
import { nativeJournalFixture } from "./native-journal-fixture";

const hash = (content: string) => createHash("sha256").update(content).digest("hex");
const doc = (name: string, content: string) => readKnowledgeLinkingDocument(name, content, `sha256:${hash(content)}`);
function memoryHarness(contents: Record<string, string>, judge?: KnowledgeLinkingHost["judge"]) {
  const files = new Map(Object.entries(contents)); const writes: string[] = []; let saved: KnowledgeLinkingTask | null = null; const records = new Map<string, KnowledgeLinkingTask>(); let signature = "bindings-1";
  const host: KnowledgeLinkingHost = {
    async *documents() { for (const [name, content] of files) yield doc(name, content); },
    bindingSignature: () => signature, canWrite: () => true,
    read: async name => { if (!files.has(name)) throw new Error("fixture note missing"); return files.get(name)!; },
    async write(name, before, after) { assert.equal(files.get(name), before); files.set(name, after); writes.push(name); },
    judge: judge ?? (async input => input.documents.map(document => ({ path: document.path, version: document.version, mentions: input.candidates.filter(candidate => candidate.path === document.path) })))
  };
  const store = { async load() { return saved && structuredClone(saved); }, async save(task: KnowledgeLinkingTask) { saved = structuredClone(task); records.set(task.id, structuredClone(task)); }, async loadTask(id: string) { return records.get(id) ?? null; }, async saveRecord(task: KnowledgeLinkingTask) { records.set(task.id, structuredClone(task)); } };
  return { files, writes, host, store, service: new KnowledgeLinkingService(host, store), changeBindings() { signature = "bindings-2"; } };
}

export async function runKnowledgeLinkingProductionTests(): Promise<void> {
  let groups = 0;
  {
    for (const ambiguous of [false, true]) {
      const harness = memoryHarness({
        "wiki/source.md": "# Source\n人工智能系统改善效率，Agent执行任务。\n",
        "wiki/AI.md": "# 人工智能\n",
        "wiki/AI-system.md": "# 人工智能系统\n",
        "wiki/Agent.md": "# Agent\n",
        ...(ambiguous ? { "wiki/AI-system-other.md": "# 人工智能系统\n" } : {})
      });
      await harness.service.start("automatic", [], undefined, ["wiki/source.md"]); await harness.service.waitForIdle();
      const content = harness.files.get("wiki/source.md")!;
      assert.match(content, /\[\[wiki\/Agent.md\|Agent\]\]执行任务/u,
        "a conflicting concept span does not reject an independent valid mention");
      if (ambiguous) {
        assert.match(content, /人工智能系统改善效率/u);
        assert.equal(harness.service.snapshot()?.phase, "partial");
      } else {
        assert.match(content, /\[\[wiki\/AI-system.md\|人工智能系统\]\]改善效率/u,
          "same-start names choose the longest non-overlapping accepted span");
        assert.equal(harness.service.snapshot()?.phase, "completed");
      }
      await harness.service.dispose();
    }
    groups++;
  }
  {
    const draft = "---\naliases: [智能体]\n---\n# Agent\nAgent 是人工智能系统。AI 中文是人工智能。\n" + "AI 再次出现。\n".repeat(45);
    const old = "# Browser\nHTTP user agent sends headers. 智能体执行任务。Agent 再次出现。\n";
    const unrelated = "# Unrelated\nAI 中文是人工智能。\n";
    const calls: Array<{ source: string; targets: string[]; size: number }> = [];
    const harness = memoryHarness({
      "wiki/AI.md": "---\naliases: [人工智能]\n---\n# AI\n智能体使用工具。\n",
      "wiki/Agent.md": draft,
      "wiki/Browser.md": old,
      "wiki/Unrelated.md": unrelated
    }, async input => {
      const source = input.documents[0];
      calls.push({ source: source.path, targets: input.targets.map(target => target.path), size: input.candidates.length });
      // A semantic classifier returns every true mention, deliberately out of
      // order. The program, not the fixture judge, must choose the first one.
      const accepted = input.candidates.filter(candidate => !source.content.slice(Math.max(0, candidate.start - 5), candidate.start).endsWith("user ")).reverse();
      return [{ path: source.path, version: source.version, mentions: accepted }];
    });
    await harness.service.start("automatic", ["wiki/Agent.md"], undefined, ["wiki/Agent.md"]);
    await harness.service.waitForIdle();
    assert.equal(harness.service.snapshot()?.phase, "completed");
    assert.equal(harness.files.get("wiki/Agent.md"), draft.replace("人工智能系统", "[[wiki/AI.md|人工智能]]系统"),
      "the earliest accepted compound-word occurrence wins across all batches");
    assert.equal(harness.files.get("wiki/Browser.md"), old.replace("智能体执行", "[[wiki/Agent.md|智能体]]执行"),
      "an earlier unrelated user agent stays plain");
    assert.equal(harness.files.get("wiki/Unrelated.md"), unrelated,
      "old notes never gain unrelated pre-existing target links");
    assert.ok(calls.filter(call => call.source === "wiki/Agent.md").length > 1);
    assert.ok(calls.every(call => call.size <= 40));
    assert.ok(calls.filter(call => call.source !== "wiki/Agent.md").every(call => call.targets.join() === "wiki/Agent.md"));
    assert.ok(calls.filter(call => call.source === "wiki/Agent.md").every(call => call.targets.includes("wiki/AI.md")),
      "new drafts can link to every real target, beyond the reverse-link target list");
    await harness.service.dispose(); groups++;
  }
  {
    let aliasPhaseComplete = false;
    const before = '---\r\ncustom: "原格式" # keep\r\n---\r\n# AI\r\n智能体需要判断。\r\n<!-- echoink-source: {"path":"raw/old.md","revision":"old"} -->\r\n';
    const harness = memoryHarness({ "wiki/AI.md": before, "wiki/Agent.md": "# Agent\n" }, async input => {
      if (input.allowAliases) {
        if (input.documents[0].path === "wiki/Agent.md") aliasPhaseComplete = true;
        return [{ path: input.documents[0].path, version: input.documents[0].version, mentions: [], aliases: input.documents[0].path.endsWith("Agent.md") ? ["智能体"] : [] }];
      }
      assert.equal(aliasPhaseComplete, true, "new aliases precede mention judging");
      return [{ path: input.documents[0].path, version: input.documents[0].version, mentions: input.candidates }];
    });
    const first = await harness.service.start();
    assert.equal((await harness.service.start()).id, first.id, "repeated start returns current job");
    const unsubscribe = harness.service.subscribe(() => undefined); unsubscribe();
    await harness.service.waitForIdle();
    assert.equal(harness.service.snapshot()?.phase, "awaiting-confirmation"); assert.deepEqual(harness.writes, []);
    assert.match(harness.service.snapshot()!.patches.find(item => item.path === "wiki/AI.md")!.after, /\[\[wiki\/Agent\.md\|智能体\]\]/u);
    await harness.service.confirm(); await harness.service.waitForIdle();
    assert.equal(harness.service.snapshot()?.phase, "completed");
    assert.equal(harness.files.get("wiki/AI.md")!.replace("[[wiki/Agent.md|智能体]]", "智能体"), before, "old source and entire attributes remain exact");
    await harness.service.dispose(); groups++;
  }
  {
    const harness = memoryHarness({ "wiki/A.md": "# A\nB\n", "wiki/B.md": "# B\n" });
    await harness.service.start(); await harness.service.waitForIdle();
    harness.files.set("wiki/A.md", "# A\n用户新写 B\n");
    await harness.service.confirm(); await harness.service.waitForIdle();
    assert.deepEqual(harness.writes, []); assert.equal(harness.service.snapshot()?.phase, "awaiting-confirmation");
    await harness.service.cancel(); assert.deepEqual(harness.writes, []); assert.equal(harness.service.snapshot()?.phase, "cancelled");
    await harness.service.dispose(); groups++;
  }
  {
    const harness = memoryHarness({ "wiki/A.md": "# A\nB", "wiki/B.md": "# B", "wiki/C.md": "# C\nB" });
    const write = harness.host.write; harness.host.write = async (...args) => { if (args[0].endsWith("A.md")) throw new Error("fixture denied"); await write(...args); };
    await harness.service.start("automatic", ["wiki/B.md"]); await harness.service.waitForIdle();
    assert.equal(harness.service.snapshot()?.phase, "partial"); assert.deepEqual(harness.writes, ["wiki/C.md"]); assert.equal(harness.files.get("wiki/A.md"), "# A\nB");
    await harness.service.dispose(); groups++;
  }
  {
    const harness = memoryHarness({ "wiki/A.md": "# A\nB", "wiki/B.md": "# B" });
    await harness.service.start(); await harness.service.waitForIdle();
    const saved = harness.service.snapshot()!; saved.phase = "writing"; saved.writeConfirmed = true;
    harness.files.set(saved.patches[0].path, saved.patches[0].after); // crash after write, before private receipt
    await harness.store.save(saved); await harness.service.dispose();
    const recovered = new KnowledgeLinkingService(harness.host, harness.store);
    await recovered.ready; assert.equal(recovered.snapshot()?.phase, "interrupted");
    await recovered.resume(); await recovered.waitForIdle();
    assert.deepEqual(harness.writes, [], "readback recognizes an already-applied patch"); assert.equal(recovered.snapshot()?.results[0].status, "written");
    await recovered.dispose(); groups++;
  }
  {
    const harness = memoryHarness({ "wiki/A.md": "# A\nB", "wiki/B.md": "# B" });
    await harness.service.start(); await harness.service.waitForIdle(); const saved = harness.service.snapshot()!;
    await harness.store.save(saved); await harness.service.dispose();
    const recovered = new KnowledgeLinkingService(harness.host, harness.store); await recovered.ready;
    assert.equal(recovered.snapshot()?.phase, "awaiting-confirmation"); await recovered.resume(); assert.deepEqual(harness.writes, []);
    await recovered.dispose(); groups++;
  }
  {
    let calls = 0; const files: Record<string, string> = {};
    for (let index = 0; index < 1000; index++) files[`wiki/${index}.md`] = `---\naliases: [Alias${index}]\n---\n# Title${index}\nIndependent body.\n`;
    const harness = memoryHarness(files, async () => { calls++; throw new Error("No semantic call expected"); });
    const started = performance.now(); await harness.service.start(); await harness.service.waitForIdle();
    assert.equal(harness.service.snapshot()?.phase, "completed"); assert.equal(calls, 0); assert.deepEqual(harness.writes, []);
    console.log(JSON.stringify({ test: "thousand-note-no-candidates", notes: 1000, elapsedMs: Math.round(performance.now() - started), providerCalls: calls }));
    await harness.service.dispose(); groups++;
  }
  {
    const harness = memoryHarness({ "wiki/A.md": "---\naliases: [Alpha]\n---\n# A\nB", "wiki/B.md": "---\naliases: [Beta]\n---\n# B" });
    const manual = await harness.service.start(); await harness.service.waitForIdle();
    const queued = await harness.service.start("automatic", ["wiki/B.md"], undefined, ["wiki/A.md"]);
    assert.notEqual(queued.id, manual.id); assert.equal(queued.phase, "queued");
    assert.equal((await harness.service.readTask(queued.id))?.phase, "queued");
    assert.deepEqual((await harness.service.readTask(queued.id))?.sourcePaths, ["wiki/A.md"]);
    assert.deepEqual((await harness.store.load())?.queuedAutomatic?.[0].sourcePaths, ["wiki/A.md"],
      "queued outbound scope is persisted for reload");
    await harness.service.confirm();
    for (let count = 0; count < 40; count++) { await new Promise(resolve => setTimeout(resolve, 5)); await harness.service.waitForIdle(); if (harness.service.snapshot()?.id === queued.id && harness.service.snapshot()?.phase === "completed") break; }
    assert.equal(harness.service.snapshot()?.id, queued.id); assert.equal(harness.service.snapshot()?.phase, "completed");
    assert.deepEqual(harness.service.snapshot()?.sourcePaths, ["wiki/A.md"], "queue dispatch keeps the outbound scope");
    assert.equal(harness.writes.length, 1, "queued automatic job does not duplicate manual links");
    await harness.service.dispose(); groups++;
  }
  for (const action of ["cancel", "dispose"] as const) {
    const harness = memoryHarness({ "wiki/A.md": "---\naliases: [Alpha]\n---\n# A\nB", "wiki/B.md": "---\naliases: [Beta]\n---\n# B" });
    await harness.service.start(); await harness.service.waitForIdle();
    const read = harness.host.read; let unblock: (() => void) | undefined; let entered: (() => void) | undefined;
    const preflightEntered = new Promise<void>(resolve => { entered = resolve; });
    harness.host.read = async name => { entered!(); await new Promise<void>(resolve => { unblock = resolve; }); return await read(name); };
    await harness.service.confirm(); await preflightEntered;
    const stopping = action === "cancel" ? harness.service.cancel() : harness.service.dispose();
    await Promise.resolve(); unblock!(); await stopping; await harness.service.waitForIdle();
    assert.deepEqual(harness.writes, [], `${action} during confirmation preflight cannot revive writes`);
    assert.equal(harness.service.snapshot()?.phase, action === "cancel" ? "cancelled" : "awaiting-confirmation");
    if (action !== "dispose") await harness.service.dispose(); groups++;
  }
  {
    const harness = memoryHarness({ "wiki/A.md": "---\naliases: [Alpha]\n---\n# A\nB", "wiki/B.md": "---\naliases: [Beta]\n---\n# B" });
    await harness.service.start(); await harness.service.waitForIdle(); harness.files.delete("wiki/B.md");
    await harness.service.confirm(); await harness.service.waitForIdle();
    assert.deepEqual(harness.writes, []); assert.equal(harness.files.get("wiki/A.md")!.includes("[["), false, "deleted preview target never becomes a dangling link"); await harness.service.dispose(); groups++;
  }
  {
    const harness = memoryHarness({ "wiki/A.md": "# A\nB", "wiki/B.md": "# B" });
    harness.host.judge = async input => { harness.files.delete("wiki/B.md"); return [{ path: input.documents[0].path, version: input.documents[0].version, mentions: input.candidates }]; };
    await harness.service.start("automatic", ["wiki/B.md"]); await harness.service.waitForIdle();
    assert.equal(harness.service.snapshot()?.phase, "partial"); assert.deepEqual(harness.writes, []); await harness.service.dispose(); groups++;
  }
  {
    const harness = memoryHarness({ "wiki/A.md": "---\naliases: [Alpha]\n---\n# A\nB", "wiki/B.md": "---\naliases: [Beta]\n---\n# B" });
    await harness.service.start(); await harness.service.waitForIdle();
    const read = harness.host.read; let count = 0; let unblock: (() => void) | undefined; let entered: (() => void) | undefined;
    const reachedWriteRead = new Promise<void>(resolve => { entered = resolve; });
    harness.host.read = async name => { count++; if (count === 3) { entered!(); await new Promise<void>(resolve => { unblock = resolve; }); } return await read(name); };
    await harness.service.confirm(); await reachedWriteRead;
    const stopping = harness.service.cancel(); await Promise.resolve(); unblock!(); await stopping;
    assert.deepEqual(harness.writes, [], "cancel while reading source at writing stage starts no write"); await harness.service.dispose(); groups++;
  }
  {
    const harness = memoryHarness({ "wiki/A.md": "# A\nB", "wiki/B.md": "# B", "wiki/C.md": "# C\nD", "wiki/D.md": "# D" });
    const judge = harness.host.judge; let unblock: (() => void) | undefined; let entered: (() => void) | undefined;
    const judging = new Promise<void>(resolve => { entered = resolve; }); let first = true;
    harness.host.judge = async input => { if (first) { first = false; entered!(); await new Promise<void>(resolve => { unblock = resolve; }); } return await judge(input); };
    const terminals = new Set<string>(); const unsubscribe = harness.service.subscribe(task => { if (task && ["completed", "partial", "failed"].includes(task.phase)) terminals.add(task.id); });
    const taskA = await harness.service.start("automatic", ["wiki/B.md"]); await judging;
    const taskB = await harness.service.start("automatic", ["wiki/D.md"]); unblock!();
    for (let count = 0; count < 60; count++) { await new Promise(resolve => setTimeout(resolve, 5)); await harness.service.waitForIdle(); if (harness.service.snapshot()?.id === taskB.id && harness.service.snapshot()?.phase === "completed") break; }
    assert.equal(harness.service.snapshot()?.id, taskB.id); assert.ok(terminals.has(taskA.id)); assert.ok(terminals.has(taskB.id), "terminal publication cannot be coalesced into the next task");
    const archivedA = await harness.service.readTask(taskA.id); assert.equal(archivedA?.phase, "completed"); assert.equal(archivedA?.results[0].path, "wiki/A.md"); assert.equal((await harness.service.readTask(taskB.id))?.results[0].path, "wiki/C.md");
    unsubscribe(); await harness.service.dispose(); groups++;
  }
  {
    const source = doc("wiki/A.md", "# A\nB"); const target = doc("wiki/B.md", "# B");
    const batch: PiKnowledgeLinkingBatch = { documents: [source], targets: buildKnowledgeLinkingTargets([source, target]), candidates: scanKnowledgeLinkingMentions(source, buildKnowledgeLinkingTargets([source, target])).map(mention => ({ ...mention, path: source.path })), allowAliases: false, proposals: null };
    const tool = createPiKnowledgeLinkingTool(batch); const registration = createControlledPiToolRegistration([tool]);
    assert.equal(registration.noTools, "all"); assert.deepEqual(registration.tools, [PI_KNOWLEDGE_LINKING_TOOL]);
    await assert.rejects(tool.execute("bad-index", { accepted: [999] })); assert.equal(batch.proposals, null);
    await assert.rejects(tool.execute("bad-aliases", { accepted: [], aliases: [{ path: source.path, values: ["new alias"] }] })); assert.equal(batch.proposals, null);
    await tool.execute("proposal", { accepted: [0] }); assert.equal(batch.proposals?.[0].mentions.length, 1);
    const handlers = new Map<string, (...args: any[]) => unknown>();
    const extension = knowledgeLinkingInlineExtension(); const factory = typeof extension === "function" ? extension : extension.factory;
    await factory({ on(name: string, handler: (...args: any[]) => unknown) { handlers.set(name, handler); } } as any);
    assert.deepEqual(await handlers.get("tool_call")!({ toolName: "note_update" }), { block: true, reason: "Only structured linking proposals are allowed." });
    assert.equal(await handlers.get("tool_call")!({ toolName: PI_KNOWLEDGE_LINKING_TOOL }), undefined);
    const extensionRoot = await realpath(await mkdtemp(path.join(tmpdir(), "echoink-linking-loader-")));
    try {
      const loader = await createControlledVaultResourceLoader({ vaultRoot: extensionRoot, skillPaths: [], systemPrompt: "Knowledge linking production registration regression.", inlineExtension: knowledgeLinkingInlineExtension() });
      const loaded = loader.getExtensions(); assert.deepEqual(loaded.errors, []); assert.equal(loaded.extensions.length, 1);
      const registered = loaded.extensions[0].handlers;
      assert.ok(registered.has("tool_call")); assert.ok(registered.has("tool_result"));
      const gate = registered.get("tool_call")![0] as (...args: any[]) => any;
      const resultGate = registered.get("tool_result")![0] as (...args: any[]) => any;
      assert.deepEqual(await gate({ toolName: "note_update" }), { block: true, reason: "Only structured linking proposals are allowed." });
      assert.equal(await gate({ toolName: PI_KNOWLEDGE_LINKING_TOOL }), undefined);
      const receipt = await resultGate({ toolName: PI_KNOWLEDGE_LINKING_TOOL, isError: false, content: [{ type: "text", text: "untrusted content must not escape" }] });
      assert.deepEqual(receipt, { content: [{ type: "text", text: '{"status":"proposal_recorded"}' }], details: { status: "proposal_recorded" }, isError: false });
      const rejected = await resultGate({ toolName: "note_update", isError: false, content: [{ type: "text", text: "unexpected tool result" }] });
      assert.equal(rejected.isError, true); assert.equal(rejected.details.status, "proposal_rejected");
      const failed = await resultGate({ toolName: PI_KNOWLEDGE_LINKING_TOOL, isError: true }); assert.equal(failed.isError, true);
    } finally { await rm(extensionRoot, { recursive: true, force: true }); }
    groups++;
  }
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "echoink-linking-production-")));
  try {
    const vaultRoot = path.join(root, "vault"); const fixture = await nativeJournalFixture(vaultRoot);
    const bindings = emptyKnowledgeFolderBindings();
    Object.assign(bindings.roles.wiki, { enabled: true, readPaths: ["知识"], writePath: "知识" });
    Object.assign(bindings.roles.projects, { enabled: true, readPaths: ["项目"], writePath: "项目" });
    const releaseBindings = registerKnowledgeFolderBindings(vaultRoot, () => bindings);
    try {
      const started = performance.now(); let totalBytes = 0;
      for (let index = 0; index < 1001; index++) {
        const content = `---\naliases: [独立别名${index}]\n---\n# 独立标题${index}\n无概念提及。\n`; totalBytes += Buffer.byteLength(content);
        await fixture.write(`知识/note-${index}.md`, content);
      }
      const bom = '\uFEFF---\r\naliases: [特殊]\r\ncustom: "keep" # exact\r\n---\r\n# BOM\r\n独立标题1\r\n';
      await fixture.write("项目/BOM.md", bom); totalBytes += Buffer.byteLength(bom);
      const index = new KnowledgeAgentIndex({ vaultPath: vaultRoot, storageRootPath: path.join(root, "index") });
      const documents = []; let ticks = 0; const timer = setInterval(() => ticks++, 0);
      for await (const document of index.scanLinkingDocuments()) documents.push(document);
      clearInterval(timer);
      assert.equal(documents.length, 1002, "complete index scan passes pagination and twenty-note boundaries"); assert.ok(ticks > 0, "scan yields UI thread");
      const captured = documents.find(document => document.path === "项目/BOM.md")!;
      assert.equal(captured.content, bom); assert.equal(captured.version, `sha256:${hash(bom)}`);
      const patch = buildKnowledgeLinkingPatch(captured, { path: captured.path, version: captured.version, mentions: scanKnowledgeLinkingMentions(captured, buildKnowledgeLinkingTargets(documents)) }, buildKnowledgeLinkingTargets(documents), { allowAliases: false });
      assert.ok(patch.patch?.after.startsWith("\uFEFF---\r\n"));
      const adapter = new ObsidianVaultDomainAdapter(fixture.app, "fixture", vaultRoot); const resolver = new VaultTargetResolver(adapter);
      const target = await resolver.resolve({ vaultId: "fixture", relativePath: captured.path, mustExist: true, expectedKind: "file" });
      const snapshot = await adapter.readFile(target, {}); assert.equal(snapshot?.content, bom); assert.equal(snapshot?.truncated, false);
      await adapter.updateFile(target, hash(bom), patch.patch!.after);
      assert.equal(await readFile(path.join(vaultRoot, captured.path), "utf8"), patch.patch!.after);
      console.log(JSON.stringify({ test: "complete-index-scan", notes: documents.length, utf8Bytes: totalBytes, elapsedMs: Math.round(performance.now() - started), eventLoopTicks: ticks, providerCalls: 0 })); groups++;
    } finally { releaseBindings(); }
    {
      const vault = path.join(root, "maintenance"); const fixture = await nativeJournalFixture(vault);
      await fixture.app.vault.createFolder("wiki"); // The selected binding root exists before maintenance; only Agent.md creation is injected to fail.
      const config = emptyKnowledgeFolderBindings();
      Object.assign(config.roles.raw, { enabled: true, readPaths: ["raw"], writePath: "raw" });
      Object.assign(config.roles.wiki, { enabled: true, readPaths: ["wiki"], writePath: "wiki" });
      const release = registerKnowledgeFolderBindings(vault, () => config);
      const sources = { "raw/a.md": "# source A\nAI", "raw/b.md": "# source B\nAgent" };
      for (const [name, content] of Object.entries(sources)) await fixture.write(name, content);
      const adapter = new ObsidianVaultDomainAdapter(fixture.app, "maintenance", vault);
      let failCreation = true, aiWrites = 0;
      const create = adapter.createFile.bind(adapter); adapter.createFile = async (target, content) => { if (target.relativePath === "wiki/Agent.md" && failCreation) throw new Error("fixture target creation failure"); const result = await create(target, content); if (target.relativePath === "wiki/AI.md") aiWrites++; return result; };
      let automaticTargets: readonly string[] = []; let automaticStarts = 0; let failAutomatic = false;
      const maintenanceDomain = new VaultDomainService(adapter, { allowMissingParentDirectories: true });
      const port = new ProductionPiKnowledgeMaintenanceToolPort({ vaultRootPath: vault, privateKnowledgeRootPath: path.join(root, "maintenance-private"), vaultId: "maintenance", userId: "fixture", deviceId: "fixture", domainService: maintenanceDomain,
        onCommitted: async (_paths, targets) => { automaticStarts++; if (failAutomatic) throw new Error("fixture linking startup failure"); automaticTargets = targets ?? []; return "fixture-link-task"; }
      });
      await port.initialize();
      const request: Parameters<typeof port.execute>[0] = { vaultId: "maintenance", conversationId: "fixture", piSessionId: "fixture", productRunId: "batch", toolCallId: "maintain", mode: "maintain", request: "", sourcePaths: Object.keys(sources), sourceBodyFingerprints: Object.fromEntries(Object.entries(sources).map(([name, content]) => [name, rawDigestFingerprint(name, Buffer.from(content))])), preferenceSnapshot: { profileVersion: "echoink-knowledge-preference-profile-v1", state: "default", revision: `sha256:${"a".repeat(64)}` }, candidateActions: [
        { targetPath: "wiki/AI.md", content: "---\naliases: [人工智能]\n---\n# AI\n[[wiki/Agent|智能体]]支持人工智能。\n[[raw/a.md]] [[raw/b.md]]\n", expectedTarget: { kind: "missing" } },
        { targetPath: "wiki/Agent.md", content: "---\naliases: [智能体]\n---\n# Agent\n[[wiki/AI|人工智能]]\n[[raw/a.md]] [[raw/b.md]]\n", expectedTarget: { kind: "missing" } }
      ] };
      const result = await executeStagedMaintenanceFixture(port, maintenanceDomain, request);
      assert.equal(result.status, "failed", "a failed second page cannot be reported as batch success");
      const content = await readFile(path.join(vault, "wiki/AI.md"), "utf8");
      assert.match(content, /智能体支持人工智能/u); assert.doesNotMatch(content, /\[\[wiki\/Agent/u, "failed same-batch target leaves no dangling link");
      assert.match(content, /raw\/a/u); assert.match(content, /raw\/b/u); assert.equal((content.match(/echoink-source/gu) ?? []).length, 2, "both Raw source bindings remain intact");
      assert.equal(automaticStarts, 0, "background linking waits for complete P1 page/backlink finalization");
      assert.deepEqual(result.processedSourcePaths, []);
      const incomplete = (await readPrivateMaintenanceRecords(path.join(root, "maintenance-private"), { vaultId: "maintenance" }))[0];
      assert.ok(incomplete.sources.every(source => source.status !== "processed"));
      const firstPageWrites = aiWrites; failCreation = false;
      const resumed = await port.execute({ ...request, productRunId: "batch-resume", toolCallId: "resume", candidateActions: undefined, p1: { stage: "resume" } });
      assert.equal(resumed.status, "completed", resumed.message); assert.deepEqual(resumed.processedSourcePaths?.slice().sort(), Object.keys(sources).sort());
      assert.equal(await readFile(path.join(vault, "wiki/AI.md"), "utf8"), content); assert.equal(aiWrites, firstPageWrites, "successful first page is not rewritten by resume");
      assert.deepEqual(automaticTargets, ["wiki/AI.md", "wiki/Agent.md"]); assert.equal(automaticStarts, 1); assert.equal(resumed.maintenanceResult?.linkingTaskId, "fixture-link-task");
      const records = await readPrivateMaintenanceRecords(path.join(root, "maintenance-private"), { vaultId: "maintenance" });
      assert.equal(records[0].result.linkingTaskId, "fixture-link-task"); assert.deepEqual(records[0].sources.map(source => source.path).sort(), Object.keys(sources).sort()); assert.equal(records[0].result.notes[0].path, "wiki/AI.md");
      const replay = await executeStagedMaintenanceFixture(port, maintenanceDomain, request); assert.equal(replay.maintenanceResult?.linkingTaskId, "fixture-link-task"); assert.equal(automaticStarts, 1, "replay never starts another linking job");
      failAutomatic = true;
      const failingRequest: Parameters<typeof port.execute>[0] = { ...request, productRunId: "startup-failure", candidateActions: [{ targetPath: "wiki/Failure.md", content: "# Failure\n[[raw/a.md]] [[raw/b.md]]\n", expectedTarget: { kind: "missing" } }] };
      const failedStart = await executeStagedMaintenanceFixture(port, maintenanceDomain, failingRequest); assert.ok(failedStart.maintenanceResult?.issues.some(issue => issue.code === "linking_start_failed"));
      const persisted = (await readPrivateMaintenanceRecords(path.join(root, "maintenance-private"), { vaultId: "maintenance" })).find(record => record.runId.startsWith("startup-failure:"))!;
      assert.ok(persisted.result.issues.some(issue => issue.code === "linking_start_failed")); assert.equal(persisted.result.notes[0].path, "wiki/Failure.md");
      const repeated = await executeStagedMaintenanceFixture(port, maintenanceDomain, failingRequest); assert.ok(repeated.maintenanceResult?.issues.some(issue => issue.code === "linking_start_failed")); assert.equal(automaticStarts, 2);
      release(); groups++;
    }
    await assertMaintenanceDraftLinking(path.join(root, "maintenance-drafts")); groups++;
    await assertInternalKnowledgeLinkingRuntimeIsolation(path.join(root, "internal-runtime")); groups++;
    {
      const store = new KnowledgeLinkingStateStore(path.join(root, "dismissed", "linking.json"));
      const harness = memoryHarness({ "wiki/A.md": "# A\nB", "wiki/B.md": "# B" });
      harness.host.write = async () => { throw new Error("fixture write failure"); };
      const service = new KnowledgeLinkingService(harness.host, store);
      await service.start("automatic", ["wiki/B.md"]); await service.waitForIdle();
      const id = service.snapshot()!.id; assert.equal(service.snapshot()?.phase, "partial"); assert.equal(knowledgeLinkingProgressVisible(service.snapshot()), true);
      await service.dismiss(); assert.equal(knowledgeLinkingProgressVisible(service.snapshot()), false); await service.dispose();
      const restored = new KnowledgeLinkingService(harness.host, store); await restored.ready;
      assert.equal(restored.snapshot()?.dismissed, true); assert.equal(knowledgeLinkingProgressVisible(restored.snapshot()), false);
      assert.equal((await restored.readTask(id))?.results[0].status, "failed", "dismissal keeps the archived result available");
      await restored.dispose(); await harness.service.dispose(); groups++;
    }
    {
      const store = new KnowledgeLinkingStateStore(path.join(root, "private", "linking.json"));
      const harness = memoryHarness({ "wiki/A.md": "# A\nB", "wiki/B.md": "# B" });
      const service = new KnowledgeLinkingService(harness.host, store); await service.start(); await service.waitForIdle(); const id = service.snapshot()!.id; await service.dispose();
      const restored = new KnowledgeLinkingService(harness.host, store); await restored.ready; assert.equal(restored.snapshot()?.id, id); assert.equal(restored.snapshot()?.phase, "awaiting-confirmation"); assert.equal((await restored.readTask(id))?.patches.length, 1); await restored.dispose(); await harness.service.dispose(); groups++;
    }
  } finally { await rm(root, { recursive: true, force: true }); }
  console.log(`PASS knowledge-linking production: ${groups} groups. Host I/O and semantic decisions are fixtures; real Provider and native UI remain separate acceptance.`);
}

/** Production maintenance -> persisted scoped linking -> CAS/readback, with only semantic decisions supplied. */
async function assertMaintenanceDraftLinking(root: string): Promise<void> {
  const fixture = await nativeJournalFixture(root);
  const bindings = emptyKnowledgeFolderBindings();
  Object.assign(bindings.roles.raw, { enabled: true, readPaths: ["raw"], writePath: "raw" });
  Object.assign(bindings.roles.wiki, { enabled: true, readPaths: ["wiki"], writePath: "wiki" });
  const release = registerKnowledgeFolderBindings(root, () => bindings);
  const raw = "# Source\nAgent 是人工智能系统。AI 的中文是人工智能。\n";
  await fixture.write("raw/source.md", raw);
  await fixture.write("wiki/AI.md", "---\naliases: [人工智能]\n---\n# AI\n人工智能领域。\n");
  await fixture.write("wiki/Kept.md", "# Kept\n既有概念。\n");
  const index = new KnowledgeAgentIndex({ vaultPath: root, storageRootPath: path.join(root, ".index") });
  await index.refresh();
  const adapter = new ObsidianVaultDomainAdapter(fixture.app, "draft-linking", root);
  const resolver = new VaultTargetResolver(adapter);
  const service = new KnowledgeLinkingService({
    async *documents() { yield* index.scanLinkingDocuments(); },
    bindingSignature: () => "draft-fixture", canWrite: () => true,
    read: async relative => await readFile(path.join(root, relative), "utf8"),
    async write(relative, before, after) {
      const target = await resolver.resolve({ vaultId: "draft-linking", relativePath: relative, mustExist: true, expectedKind: "file" });
      await adapter.updateFile(target, hash(before), after); index.invalidate(relative);
    },
    judge: async input => input.documents.map(document => ({ path: document.path, version: document.version, mentions: [...input.candidates].reverse() }))
  }, new KnowledgeLinkingStateStore(path.join(root, ".linking", "state.json")));
  const committed = new Map<string, string>();
  let starts = 0, writes = 0;
  const options = {
    vaultRootPath: root, privateKnowledgeRootPath: path.join(root, ".maintenance"), vaultId: "draft-linking", userId: "fixture", deviceId: "fixture",
    domainService: new VaultDomainService(adapter, { allowMissingParentDirectories: true }), knowledgeAgentIndex: index
  };
  const schedule = async (paths: readonly string[], targets?: readonly string[], taskId?: string) => {
      for (const relative of paths) committed.set(relative, await readFile(path.join(root, relative), "utf8"));
      await index.refresh(); starts++;
      return (await service.start("automatic", [...targets ?? []], taskId, [...paths])).id;
  };
  const originalWrite = adapter.updateFile.bind(adapter);
  adapter.updateFile = async (...args) => { writes++; return await originalWrite(...args); };
  const port = new ProductionPiKnowledgeMaintenanceToolPort({ ...options, linkingOwnsDraftLinks: true, onCommitted: schedule });
  const request = (name: string, content: string, previous?: string): Parameters<typeof port.execute>[0] => ({
    vaultId: "draft-linking", conversationId: "fixture", piSessionId: "fixture", productRunId: name, toolCallId: "maintain", mode: "maintain", request: "",
    sourcePaths: ["raw/source.md"], sourceBodyFingerprints: { "raw/source.md": rawDigestFingerprint("raw/source.md", Buffer.from(raw)) },
    preferenceSnapshot: { profileVersion: "echoink-knowledge-preference-profile-v1", state: "default", revision: `sha256:${"a".repeat(64)}` },
    candidateActions: [{ targetPath: `wiki/${name}.md`, content, expectedTarget: previous === undefined ? { kind: "missing" } : { kind: "file", contentRevision: `sha256:${hash(previous)}` } }]
  });
  try {
    await port.initialize();
    for (const [name, body] of [
      ["Omitted", "# Omitted\nAgent 是人工智能系统。AI 中文是人工智能。\n"],
      ["Late", "# Late\nAgent 是人工智能系统。AI 中文是[[wiki/AI.md|人工智能]]。\n"]
    ]) {
      const result = await executeStagedMaintenanceFixture(port, options.domainService, request(name, body));
      assert.equal(result.status, "completed", result.message);
      assert.ok(result.maintenanceResult?.linkingTaskId);
      assert.match(result.message, /不要为补链接反复调用 knowledge_maintain 或重写正文/u);
      assert.doesNotMatch(committed.get(`wiki/${name}.md`)!, /\[\[wiki\/AI/u,
        "draft writing commits plain mentions; the shared task owns placement even for a late authored link");
      await service.waitForIdle();
      assert.equal(service.snapshot()?.phase, "completed");
      const after = await readFile(path.join(root, `wiki/${name}.md`), "utf8");
      assert.match(after, /Agent 是\[\[wiki\/AI.md\|人工智能\]\]系统。AI 中文是人工智能。/u);
      assert.equal((after.match(/\[\[wiki\/AI.md\|/gu) ?? []).length, 1);
      assert.match(after, /\[\[raw\/source.md\|Source\]\]/u);
    }
    // Ordinary maintenance has its own relative-Markdown normalization. Exact
    // Markdown preservation is tested at the defer boundary, not promised here.
    const oldLinks = "[[wiki/Kept|原来的写法]] [[wiki/Kept.md]]";
    const previous = `\uFEFF---\r\naliases: [旧别名]\r\ncustom: 'keep' # exact\r\n---\r\n# Existing\r\n${oldLinks}\r\n`;
    await fixture.write("wiki/Existing.md", previous);
    const updated = previous + "Agent 是人工智能系统，后文再提[[wiki/AI.md|人工智能]]。\r\n";
    const result = await executeStagedMaintenanceFixture(port, options.domainService, request("Existing", updated, previous));
    assert.equal(result.status, "completed", result.message);
    assert.equal(committed.get("wiki/Existing.md")!.slice(0, previous.length), previous, "existing valid links retain their exact syntax/counts before background linking");
    assert.equal(committed.get("wiki/Existing.md")!.includes("[[wiki/AI.md|"), false, "only the newly added knowledge link is deferred");
    await service.waitForIdle();
    const after = await readFile(path.join(root, "wiki/Existing.md"), "utf8");
    assert.ok(after.startsWith(previous));
    assert.equal((after.match(/\[\[wiki\/Kept\|原来的写法\]\]/gu) ?? []).length, 1);
    assert.equal((after.match(/\[\[wiki\/Kept.md\]\]/gu) ?? []).length, 1);
    assert.match(after, /Agent 是\[\[wiki\/AI.md\|人工智能\]\]系统，后文再提人工智能。/u);
    assert.deepEqual(service.snapshot()?.targetPaths, [], "an update with no new aliases still starts outbound linking");
    assert.deepEqual(service.snapshot()?.sourcePaths, ["wiki/Existing.md"]);
    const noBackground = new ProductionPiKnowledgeMaintenanceToolPort({ ...options, privateKnowledgeRootPath: path.join(root, ".maintenance-no-background"), linkingOwnsDraftLinks: true });
    await noBackground.initialize();
    const fallback = await executeStagedMaintenanceFixture(noBackground, options.domainService, request("NoBackground", "# NoBackground\nAgent 是[[wiki/AI.md|人工智能]]系统。\n"));
    assert.equal(fallback.status, "completed", fallback.message);
    assert.match(await readFile(path.join(root, "wiki/NoBackground.md"), "utf8"), /是\[\[wiki\/AI.md\|人工智能\]\]系统/u,
      "a host without a background callback never silently strips valid new knowledge links");
    assert.equal(fallback.maintenanceResult?.linkingTaskId, undefined);
    assert.equal(starts, 3);
    for (const point of ["after-private-record", "after-linking-enqueue"] as const) {
      const name = point === "after-private-record" ? "RecoverBeforeSchedule" : "RecoverAfterEnqueue";
      const privateKnowledgeRootPath = path.join(root, `.${name}`);
      let fail = true;
      const crashing = new ProductionPiKnowledgeMaintenanceToolPort({ ...options, privateKnowledgeRootPath, linkingOwnsDraftLinks: true, onCommitted: schedule,
        faultInjector: phase => { if (phase === point && fail) { fail = false; throw new Error(`fixture reload at ${point}`); } }
      });
      await crashing.initialize();
      const body = `# ${name}\nAgent 是人工智能系统。AI 中文是人工智能。\n`;
      const pendingRequest = request(name, body);
      const beforeStart = starts;
      const interrupted = await executeStagedMaintenanceFixture(crashing, options.domainService, pendingRequest);
      const record = (await readPrivateMaintenanceRecords(privateKnowledgeRootPath, { vaultId: "draft-linking" }))[0];
      if (point === "after-linking-enqueue") {
        assert.ok(record.pendingLinking, `${point}: a durable record retains the scoped linking intent`);
        assert.equal(record.pendingLinking.taskId, record.recordId);
        assert.deepEqual(record.pendingLinking.sourcePaths, [`wiki/${name}.md`]);
      } else {
        assert.equal(record.p1?.phase, "write", "the existing P1 record retains its unfinished draft until explicit resume");
        assert.ok(Object.keys(record.p1!.drafts).length);
      }
      if (point === "after-private-record") {
        assert.equal(interrupted.errorCode, "record_pending");
        assert.equal(starts, beforeStart, "a crash after finalization has not yet enqueued the linking task");
      } else {
        assert.ok(interrupted.maintenanceResult?.issues.some(issue => issue.code === "linking_start_failed"));
        await service.waitForIdle();
      }
      const beforeRecoveryWrites = writes;
      const restored = new ProductionPiKnowledgeMaintenanceToolPort({ ...options, privateKnowledgeRootPath, linkingOwnsDraftLinks: true, onCommitted: schedule });
      await restored.initialize();
      if (point === "after-private-record") {
        const resumed = await restored.execute({ ...pendingRequest, toolCallId: "resume", candidateActions: undefined, p1: { stage: "resume" } });
        assert.equal(resumed.status, "completed", resumed.message);
      }
      await service.waitForIdle();
      const recovered = (await readPrivateMaintenanceRecords(privateKnowledgeRootPath, { vaultId: "draft-linking" }))[0];
      assert.equal(recovered.pendingLinking, undefined);
      assert.equal(recovered.result.linkingTaskId, record.recordId, "recovery reuses the record's stable task identity");
      assert.ok(!recovered.result.issues.some(issue => issue.code === "linking_start_failed"), "successful recovery clears stale startup failure status");
      assert.match(await readFile(path.join(root, `wiki/${name}.md`), "utf8"), /是\[\[wiki\/AI.md\|人工智能\]\]系统/u);
      if (point === "after-linking-enqueue") assert.equal(writes, beforeRecoveryWrites,
        "an already persisted linking task is reused without another Provider/write flight");
      const startsAfterRecovery = starts;
      const replay = await executeStagedMaintenanceFixture(restored, options.domainService, pendingRequest);
      assert.equal(replay.maintenanceResult?.linkingTaskId, record.recordId);
      assert.equal(starts, startsAfterRecovery, "saved replay with resolved intent never schedules again");
      await restored.initialize();
      assert.equal(starts, startsAfterRecovery, "completed intent is not replayed on another initialization");
    }
    assert.equal(canonicalRawMarkdownForDigest(await readFile(path.join(root, "raw/source.md"), "utf8")), canonicalRawMarkdownForDigest(raw), "maintenance may add only controlled source metadata; its body remains unchanged");
  } finally { await service.dispose(); release(); }
}

/** Real runtime and controlled loader; only Provider replies and host I/O are fixtures. */
async function assertInternalKnowledgeLinkingRuntimeIsolation(root: string): Promise<void> {
  const fixture = await nativeJournalFixture(root);
  const sourceContent = "# AI\n智能体处理任务。\n";
  const targetContent = "---\naliases: [智能体]\n---\n# Agent\n任务执行工具。\n";
  await fixture.write("wiki/AI.md", sourceContent); await fixture.write("wiki/Agent.md", targetContent);
  const index = new KnowledgeAgentIndex({ vaultPath: root, storageRootPath: path.join(root, ".index") }); await index.refresh();
  const catalog = new FileConversationCatalog({ storageRootPath: path.join(root, ".pi"), vaultId: "linking-isolation" });
  const runs = new FileProductRunStore({ storageRootPath: path.join(root, ".pi"), vaultId: catalog.vaultId, catalog });
  const usageStore = new FileKnowledgeUsageStore({ storageRootPath: path.join(root, ".pi"), vaultId: catalog.vaultId }); await usageStore.initialize();
  const knowledge = createProductionPiKnowledgeRuntime({ vaultRootPath: root, knowledgeAgentIndex: index, knowledgePreferences: {} as never, usage: new KnowledgeUsageBridge(usageStore) });
  const source = doc("wiki/AI.md", sourceContent); const target = doc("wiki/Agent.md", targetContent);
  const batch: PiKnowledgeLinkingBatch = { documents: [source], targets: [], candidates: [], allowAliases: true, proposals: null };
  const conversationId = "knowledge-linking-runtime-isolation"; const unregister = registerPiKnowledgeLinkingBatch(conversationId, batch);
  const identity = { vaultId: catalog.vaultId, conversationId, piSessionId: "preflight", productRunId: "preflight", question: "我的知识库中 Agent 智能体的含义", explicitPaths: [target.path], includeUnrefined: false };
  const internal = await knowledge.retrieveChat!(identity); assert.deepEqual(internal.references, []); assert.equal(internal.providerResourceText, ""); assert.equal(internal.retrieval.total, 0);
  const ordinary = await knowledge.retrieveChat!({ ...identity, conversationId: "ordinary-chat" }); assert.ok(ordinary.references.length > 0, "ordinary chat retrieval remains active");
  let requests = 0; let activeManager: PiSessionManager | null = null; let runSequence = 0;
  const contexts: string[] = [];
  const runtime = new PiNativeConversationRuntime({
    catalog, productRuns: runs,
    sessionApi: { codingAgentVersion: VERSION, currentSessionVersion: CURRENT_SESSION_VERSION, open: (file, directory, cwd) => SessionManager.open(file, directory, cwd) },
    resolveConversationCwd: () => root, idFactory: () => `link-isolation-run-${++runSequence}`, knowledge,
    createAgentSession: async input => {
      activeManager = input.sessionManager;
      const provider = fauxProvider({ provider: "offline-linking", api: "openai-completions", models: [{ id: "link-model", reasoning: false, contextWindow: 32000, maxTokens: 1024 }] });
      const propose = (id: string, args: unknown) => (context: any) => { requests++; contexts.push(JSON.stringify(context.messages)); return fauxAssistantMessage(fauxToolCall(PI_KNOWLEDGE_LINKING_TOOL, args, { id }), { stopReason: "toolUse" }); };
      const answer = (context: any) => { requests++; contexts.push(JSON.stringify(context.messages)); return fauxAssistantMessage("proposal complete"); };
      provider.setResponses([propose("aliases", { accepted: [], aliases: [{ path: source.path, values: ["人工智能"] }] }), answer, propose("mentions", { accepted: [0] }), answer]);
      const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(), modelsPath: null, allowModelNetwork: false });
      modelRuntime.registerNativeProvider(provider.provider); const model = provider.getModel();
      const loader = await createControlledVaultResourceLoader({ vaultRoot: root, skillPaths: [], systemPrompt: "Internal linking uses the explicit user-provided synthetic spans only.", inlineExtension: knowledgeLinkingInlineExtension() });
      const { session } = await createAgentSession({ cwd: root, agentDir: root, modelRuntime, model, sessionManager: input.sessionManager, thinkingLevel: "off", settingsManager: SettingsManager.inMemory({ defaultProvider: model.provider, defaultModel: model.id, defaultThinkingLevel: "off", compaction: { enabled: false }, retry: { enabled: false }, packages: [], extensions: [], skills: [], prompts: [], themes: [], enableAnalytics: false }), resourceLoader: loader, ...createControlledPiToolRegistration([createPiKnowledgeLinkingTool(batch)]) });
      session.setActiveToolsByName([PI_KNOWLEDGE_LINKING_TOOL]);
      return { session, memoryToolNames: [], externalReadToolNames: [PI_KNOWLEDGE_LINKING_TOOL] };
    }
  });
  try {
    await runtime.initialize(); await runtime.createConversation({ conversationId, title: "Internal linking", cwd: root, defaultMemoryMode: "no_memory" });
    const submit = async () => {
      const run = await runtime.submit({ conversationId, text: `请判断知识库中的 Agent 关联。以下是本批 synthetic spans：${JSON.stringify({ path: source.path, excerpt: source.content })}`, submittedAt: Date.now(), permission: "read-only", memoryMode: "no_memory", runtimeProviderId: "offline-linking", modelId: "link-model", reasoning: "none" });
      const settled = await run.result; assert.equal(settled.terminalState, "completed", settled.error ?? "");
    };
    await submit(); assert.deepEqual(batch.proposals?.[0].aliases, ["人工智能"]);
    Object.assign(batch, { targets: buildKnowledgeLinkingTargets([source, target]), candidates: scanKnowledgeLinkingMentions(source, buildKnowledgeLinkingTargets([source, target])).map(mention => ({ ...mention, path: source.path })), allowAliases: false, proposals: null });
    await submit(); assert.equal(batch.proposals?.[0].mentions.length, 1); assert.equal(requests, 4);
    assert.deepEqual(await usageStore.list({ conversationId }), [], "internal synthetic spans never claim ordinary-chat references");
    assert.ok(contexts.every(context => !context.includes("knowledge-reference:") && !context.includes("echoink-knowledge-chat-resource") && !context.includes("echoink-personal-memory")));
    const entries = activeManager!.getBranch(); const assistant = entries.filter(entry => entry.type === "message" && entry.message.role === "assistant").at(-1)!;
    const conversation = (await catalog.get(conversationId))!;
    await assert.rejects(knowledge.recordUsage!({ event: { sourceEventId: "ordinary-usage-must-reject", vaultId: catalog.vaultId, conversationId, piSessionId: conversation.piSessionId, piEntryId: assistant.id, productRunId: "ordinary-control", referenceIds: ordinary.references.map(reference => reference.referenceId), workflow: "normal_read", producedPaths: [] }, entries }), /Pi Branch 中不存在的引用/u, "normal usage pointer validation must remain strict");
  } finally { unregister(); await runtime.shutdown(); }
}
