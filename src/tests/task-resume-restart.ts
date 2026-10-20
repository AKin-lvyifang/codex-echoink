import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createAgentSession, defineTool, ModelRuntime, SettingsManager, SessionManager, CURRENT_SESSION_VERSION, VERSION } from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore, InMemoryModelsStore, Type } from "@earendil-works/pi-ai";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createControlledVaultResourceLoader, createControlledPiToolRegistration } from "../harness/pi-native/controlled-resources";
import { FileConversationCatalog } from "../harness/pi-native/file-conversation-catalog";
import { FileProductRunStore } from "../harness/pi-native/file-product-run-store";
import { FileDomainReceiptStore } from "../harness/pi-native/domain-receipt-store";
import { FileApprovalTicketStore } from "../harness/pi-native/tool-authorization";
import { PiNativeConversationRuntime } from "../harness/pi-native/pi-native-conversation-runtime";
import { inspectPiSessionJsonl, readPiActiveLeafCheckpoint } from "../harness/pi-native/pi-session-durability";
import { prepareTaskResumeSafety } from "../plugin/task-resume-safety";
import type { PiChatSubmitRequest } from "../harness/pi-native/contracts";

export async function runTaskResumeRestartTests(root: string, phase: string): Promise<void> {
  (globalThis as any).window = globalThis;
  await mkdir(root, { recursive: true });
  const storageRootPath = path.join(root, "store");
  const catalog = new FileConversationCatalog({ storageRootPath, vaultId: "p4-cold-restart" });
  const productRuns = new FileProductRunStore({ storageRootPath, vaultId: catalog.vaultId, catalog });
  const receipts = new FileDomainReceiptStore({ storageRootPath, vaultId: catalog.vaultId });
  const approvals = new FileApprovalTicketStore({ storageRootPath, vaultId: catalog.vaultId });
  const sessions = new Map<string, any>();
  const contexts = new Map<string, string[]>();
  const started = new Set<string>();
  let completedWrites = 0;
  let pendingToolExecutions = 0;
  let sequence = 0;
  const runtime: any = new PiNativeConversationRuntime({ catalog, productRuns,
    sessionApi: { codingAgentVersion: VERSION, currentSessionVersion: CURRENT_SESSION_VERSION, open: (file, dir, cwd) => SessionManager.open(file, dir, cwd) },
    resolveConversationCwd: () => root, idFactory: () => `${phase}-${++sequence}`,
    createAgentSession: async input => {
      const id = input.catalog.conversationId;
      const faux = fauxProvider({ provider: "p4-cold-provider", api: "openai-completions", models: [{ id: "p4-cold-model", contextWindow: 32000, maxTokens: 1024, reasoning: false }] });
      faux.setResponses(Array.from({ length: 30 }, () => async (context: any) => {
        const serialized = JSON.stringify(context); contexts.set(id, [...contexts.get(id) ?? [], serialized]);
        if (phase === "produce" && id === "pendingtool") return fauxAssistantMessage(fauxToolCall("p4_pending_tool", {}, { id: "old-pending-tool" }), { stopReason: "toolUse" });
        if (phase === "produce" && serialized.includes(`PENDING-GOAL-${id}`)) { started.add(id); await new Promise(() => {}); }
        if (phase === "produce" && id === "future") {
          if (!context.tools?.length) return fauxAssistantMessage("COLD-SUMMARY-future: original goal, completed write, remaining step.");
          const messages = context.messages ?? [];
          const requestText = JSON.stringify(messages.at(-1));
          if (requestText.includes("WARMUP-TOOL")) return fauxAssistantMessage(fauxToolCall("p4_saved_write", {}, { id: "p4-write-once" }), { stopReason: "toolUse" });
          if (messages.some((message: any) => message.role === "toolResult") && !requestText.includes("Summar")) return fauxAssistantMessage("Completed write. " + "Verified task decision. ".repeat(180));
        }
        return fauxAssistantMessage(`COLD-SUMMARY-${id}: keep the original goal, completed write, and remaining step.`);
      }));
      const models = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(), modelsPath: null, allowModelNetwork: false });
      models.registerNativeProvider(faux.provider);
      const tool = defineTool({ name: "p4_saved_write", label: "Save fixture result", description: "Synthetic local effect count", parameters: Type.Object({}), execute: async () => {
        completedWrites += 1;
        return { content: [{ type: "text" as const, text: "FIRST-WRITE-VERIFIED" }], details: { completed: true } };
      } });
      const pendingTool = defineTool({ name: "p4_pending_tool", label: "Wait inside a Tool", description: "Stay pending until this producer process exits", parameters: Type.Object({}), execute: async () => {
        pendingToolExecutions += 1; started.add(id);
        await new Promise(() => {});
        throw new Error("A pending old Tool must never be resumed automatically");
      } });
      const selected = faux.getModel();
      const { session } = await createAgentSession({ cwd: root, agentDir: root, modelRuntime: models, model: selected, ...createControlledPiToolRegistration([tool, pendingTool]), sessionManager: input.sessionManager,
        settingsManager: SettingsManager.inMemory({ defaultProvider: selected.provider, defaultModel: selected.id, defaultThinkingLevel: "off", compaction: { enabled: true, reserveTokens: 512, keepRecentTokens: 128 }, retry: { enabled: false }, packages: [], extensions: [], skills: [], prompts: [], themes: [], enableAnalytics: false }),
        resourceLoader: await createControlledVaultResourceLoader({ vaultRoot: root, systemPrompt: "Offline P4 cold-restart fixture." }) });
      sessions.set(id, session);
      return { session };
    }
  });
  await runtime.initialize();
  const request = (id: string, text: string): PiChatSubmitRequest => ({ conversationId: id, text, submittedAt: Date.now(), runtimeProviderId: "p4-cold-provider", modelId: "p4-cold-model", reasoning: "none", permission: "workspace-write", mode: "agent" });
  if (phase === "produce") {
    for (const id of ["future", "legacy", "pendingtool"]) await runtime.createConversation({ conversationId: id, title: id, cwd: root });
    await (await runtime.submit(request("future", "WARMUP-TOOL: original task goal and key decision"))).result;
    assert.equal(completedWrites, 1);
    await runtime.compactConversation("future", "Keep original goal and completed write.");
    const future = await runtime.submit(request("future", "PENDING-GOAL-future: finish the remaining step"));
    await waitUntil(() => started.has("future"));
    await runtime.recordTaskInterruption("future", "app_closed");
    const checkpoint = readPiActiveLeafCheckpoint({ sessionRoot: catalog.sessionRootPath, piSessionId: future.piSessionId })!;
    const accepted = await productRuns.read(future.productRunId);
    assert.equal(checkpoint.activeLeafId, accepted!.activeLeafId);
    // Reproduce the old implementation's natural timing: only reasoning-start was checkpointed.
    const checkpointLeaf = runtime.checkpointConversationLeaf;
    runtime.checkpointConversationLeaf = () => {};
    const legacy = await runtime.submit(request("legacy", "PENDING-GOAL-legacy: keep the first instruction"));
    await waitUntil(() => started.has("legacy"));
    await runtime.recordTaskInterruption("legacy", "app_closed");
    const old = (await productRuns.read(legacy.productRunId))!;
    const stale = readPiActiveLeafCheckpoint({ sessionRoot: catalog.sessionRootPath, piSessionId: legacy.piSessionId })!;
    assert.ok(stale.modifiedAt <= old.createdAt, `Natural legacy cursor time ${stale.modifiedAt} must predate acceptance ${old.createdAt}`);
    assert.notEqual(stale.activeLeafId, old.activeLeafId);
    runtime.checkpointConversationLeaf = checkpointLeaf;
    const pending = await runtime.submit(request("pendingtool", "PENDING-GOAL-pendingtool: continue only after checking the interrupted Tool"));
    await waitUntil(() => started.has("pendingtool"));
    await runtime.active.get("pendingtool").eventLane;
    assert.equal(pendingToolExecutions, 1);
    assert.deepEqual((await productRuns.read(pending.productRunId))!.toolCallIds, [], "Reproduce a crash before the ProductRun tool index settles");
    await writeFile(path.join(root, "restart-evidence.json"), JSON.stringify({ future: future.productRunId, legacy: legacy.productRunId, pendingtool: pending.productRunId, legacyCursorModifiedAt: stale.modifiedAt, legacyRunCreatedAt: old.createdAt }));
    console.log(`P4 cold producer: native Tool result + compaction persisted; pending runs remain unsettled. Legacy cursor ${stale.modifiedAt} < accepted ${old.createdAt}.`);
    // This is a real process boundary: do not call shutdown/abort or allow run settlement.
    process.exit(0);
  }
  const evidence = JSON.parse(await readFile(path.join(root, "restart-evidence.json"), "utf8"));
  const futureBefore = await runtime.readProjection("future");
  const futureCatalog = (await catalog.get("future"))!;
  const futureInspection = inspectPiSessionJsonl({ sessionRoot: catalog.sessionRootPath, sessionFile: futureCatalog.sessionFile! });
  assert.ok(futureInspection.entries.some(entry => entry.type === "compaction"));
  assert.ok(futureInspection.entries.some(entry => entry.type === "message" && entry.message.role === "toolResult"));
  assert.ok(futureBefore.messages.some((message: any) => message.role === "user" && message.text.includes("PENDING-GOAL-future")), "A new process must read the original pending user from the selected Branch");
  const legacyBefore = await runtime.readProjection("legacy");
  assert.equal(legacyBefore.messages.some((message: any) => message.role === "user" && message.text.includes("PENDING-GOAL-legacy")), false);
  console.log("P4 cold legacy baseline REPRODUCED: the old pre-user cursor excludes the accepted original instruction.");
  for (const id of ["future", "legacy", "pendingtool"]) {
    const previous = (await productRuns.read(evidence[id]))!;
    const safety = await prepareTaskResumeSafety({ receipts, approvals, productRuns, catalog, vaultRootPath: root, conversationId: id, interruptedRunId: previous.productRunId });
    const handle = await runtime.submit({ ...request(id, "Continue the original task from its saved context."), resumeContext: { safety, interruption: previous.interruption ?? { at: previous.updatedAt, reason: "process_unknown", stage: "" } } });
    const settled = await handle.result;
    assert.equal(settled.state, "product_run_settled");
    assert.equal(settled.terminalState, "completed");
    const session = sessions.get(id);
    assert.ok(session.sessionManager.getBranch().some((entry: any) => entry.id === previous.userEntryId), "Resumed run must descend from the original user's verified Branch");
    const outgoing = contexts.get(id)!.at(-1)!;
    assert.match(outgoing, new RegExp(`PENDING-GOAL-${id}`));
    if (id === "future") assert.match(outgoing, /COLD-SUMMARY-future|Completed write/);
    assert.equal(completedWrites, 0, "Reopening/continuing never re-executes the earlier Tool effect");
    assert.equal(handle.piSessionId, previous.piSessionId);
    if (id === "pendingtool") {
      const pendingCatalog = (await catalog.get(id))!;
      const durable = inspectPiSessionJsonl({ sessionRoot: catalog.sessionRootPath, sessionFile: pendingCatalog.sessionFile! });
      assert.equal(durable.entries.some(entry => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolCallId === "old-pending-tool"), false, "Never fabricate a result for the old external Tool");
      assert.equal(pendingToolExecutions, 0, "A new process cannot replay the interrupted Tool");
      assert.equal((await productRuns.read(previous.productRunId))!.state, "running", "Do not invent old-run settlement");
      console.log("P4 cold pending-Tool PASS: current resumed run settles; prior call stays result-unknown with no replay or synthetic result.");
    }
  }
  const previous = (await productRuns.read(evidence.legacy))!;
  const legacyEntry = (await catalog.get("legacy"))!;
  const entries = inspectPiSessionJsonl({ sessionRoot: catalog.sessionRootPath, sessionFile: legacyEntry.sessionFile! }).entries;
  const originalUser = entries.find(entry => entry.id === previous.userEntryId)!;
  assert.ok(originalUser.parentId);
  await runtime.navigateBranch("legacy", originalUser.parentId!, { summarize: false });
  const callsBefore = contexts.get("legacy")!.length;
  const safety = await prepareTaskResumeSafety({ receipts, approvals, productRuns, catalog, vaultRootPath: root, conversationId: "legacy", interruptedRunId: previous.productRunId });
  await assert.rejects(runtime.submit({ ...request("legacy", "Must not override selected branch"), resumeContext: { safety, interruption: previous.interruption! } }), /无法确认原任务/);
  assert.equal(contexts.get("legacy")!.length, callsBefore, "A newer explicit Branch selection is preserved without a model request");
  await runtime.shutdown();
  console.log("P4 cold restart PASS: new process restores user/Tool/compaction; legacy stale cursor repaired deterministically; explicit selection preserved; no Tool replay.");
}
async function waitUntil(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 500; i++) { if (condition()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error("Cold restart fixture did not reach the pending request");
}
