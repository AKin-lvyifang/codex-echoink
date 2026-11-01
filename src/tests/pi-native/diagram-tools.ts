import assert from "node:assert/strict";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import type { ToolCallEvent, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { PiDiagramToolSecurity, createPiDiagramToolDefinition, type PiDiagramPort } from "../../harness/pi-native/pi-diagram-tools";
import { FileApprovalTicketStore, canonicalJsonStringify, isSideEffectApprovalToolId } from "../../harness/pi-native/tool-authorization";
import { FileDomainReceiptStore } from "../../harness/pi-native/domain-receipt-store";
import { FileConversationCatalog } from "../../harness/pi-native/file-conversation-catalog";
import { FileProductRunStore } from "../../harness/pi-native/file-product-run-store";
import { prepareTaskResumeSafety, assertTaskResumeToolAllowed } from "../../plugin/task-resume-safety";
import { parseDrawingOutput } from "../../excalidraw/elements";
import type { DrawingCreation } from "../../excalidraw/service";
import type { PiWorkspaceAccess } from "../../harness/pi-native/pi-workspace-access";
const model = () => ({ title: "资料到知识", elements: [
  { id: "a", type: "rectangle", x: 0, y: 0, width: 320, height: 140, label: { text: "📖 资料" } },
  { id: "b", type: "rectangle", x: 440, y: 0, width: 320, height: 140, label: { text: "🧩 知识" } },
  { id: "ab", type: "arrow", start: { id: "a" }, end: { id: "b" } }
] });
export async function runDiagramToolTests(root: string): Promise<void> {
  assert(isSideEffectApprovalToolId("diagram_create"));
  const sourceFree = parseDrawingOutput(model(), [], "white", false);
  assert(!sourceFree.elements.some(e => e.link || e.text?.startsWith("来源：")));
  const mixed = model(); (mixed.elements[0] as Record<string, unknown>).sourcePaths = ["资料/原文.md"];
  const referenced = parseDrawingOutput(mixed, ["资料/原文.md"], "blackboard", false);
  assert.equal(referenced.elements.filter(e => e.link).length, 1);
  assert.equal(referenced.elements.at(-1)?.text, "来源：原文");
  for (const mode of ["success", "cancel", "invalid", "disabled", "plan", "read-only", "changed", "unknown"] as const) {
    const fixture = path.join(root, "diagram-tool-" + mode), vault = path.join(fixture, "vault"), store = path.join(fixture, "store");
    await mkdir(vault, { recursive: true });
    const vaultId = "diagram-vault", approvals = new FileApprovalTicketStore({ storageRootPath: store, vaultId }), receipts = new FileDomainReceiptStore({ storageRootPath: store, vaultId });
    await approvals.initialize(); await receipts.initialize();
    let confirms = 0, writes = 0, opens = 0, checked = 0, changed = false;
    let resumeIds: string[] = [];
    let access: PiWorkspaceAccess = { permission: mode === "read-only" ? "read-only" : "workspace-write", mode: mode === "plan" ? "plan" : "agent", memoryMode: "normal" };
    const identity = { vaultId, conversationId: "conversation", piSessionId: "session", productRunId: "run", userEntryId: "entry" };
    const port: PiDiagramPort = {
      disabledReason: () => mode === "disabled" ? "请先启用 Excalidraw 插件。" : null,
      prepare: async (input, requestId) => ({ requestId, path: "图.excalidraw.md", style: input.style === "blackboard" ? "blackboard" : "white", output: parseDrawingOutput(input, [], "white", false) }),
      check: async () => { checked++; if (changed) throw new Error("保存位置已改变"); },
      create: async creation => { writes++; await writeFile(path.join(vault, creation.path), JSON.stringify(creation.output)); if (mode === "unknown") throw new Error("crash after saved before receipt"); return { path: creation.path, verified: true }; },
      reconcile: async creation => ({ path: creation.path, verified: await readFile(path.join(vault, creation.path), "utf8").then(value => canonicalJsonStringify(JSON.parse(value)) === canonicalJsonStringify(creation.output)).catch(() => false) }),
      version: async relative => createHash("sha256").update(await readFile(path.join(vault, relative))).digest("hex"),
      open: async () => { opens++; }
    };
    const make = (a = approvals, r = receipts) => new PiDiagramToolSecurity({ port, approvals: a, receipts: r, identity: () => identity, access: () => access,
      resumeOperationIds: () => resumeIds, userId: "user", deviceId: "device", assertToolAllowed: async () => {},
      confirm: async request => { confirms++; assert.equal((request.preview as Record<string, unknown>).domain, "excalidraw"); assert.equal((request.preview as Record<string, unknown>).path, "图.excalidraw.md"); if (mode === "changed") changed = true; return mode !== "cancel"; } });
    const security = make(), definition = createPiDiagramToolDefinition(security);
    assert.equal(definition.name, "diagram_create");
    const input = mode === "invalid" ? { title: "错误", elements: [{ id: "a", type: "arrow", start: { id: "missing" }, end: { id: "other" } }] } : model();
    const event = { type: "tool_call", toolName: "diagram_create", toolCallId: "call", input } as ToolCallEvent;
    const blocked = await security.handleToolCall(event);
    if (!["success", "unknown"].includes(mode)) {
      assert(blocked?.block); assert(blocked.reason.length > 4); assert.equal(writes, 0);
      assert.equal((await readdir(vault)).length, 0);
      if (mode === "invalid") assert.match(blocked.reason, /框/u);
      console.log(`PASS diagram tool: ${mode}, zero files`); continue;
    }
    assert.equal(blocked, undefined); await security.execute("call", input);
    const result = await security.handleToolResult({ ...event, type: "tool_result", content: [], details: {}, isError: false } as unknown as ToolResultEvent);
    assert.equal(result.details.status, mode === "unknown" ? "uncertain" : "completed");
    const view = (await receipts.listUiViews())[0]; assert(view);
    if (mode === "unknown") {
      const changed = { ...model(), title: "不准换名重建" }, retry = make();
      assert.equal(await retry.handleToolCall({ ...event, toolCallId: "changed-retry", input: changed }), undefined);
      await retry.execute("changed-retry", changed);
      const reused = await retry.handleToolResult({ ...event, toolCallId: "changed-retry", type: "tool_result", content: [], details: {}, isError: false } as unknown as ToolResultEvent);
      assert.equal(reused.details.reused, true); assert.equal(reused.details.path, "图.excalidraw.md"); assert.equal(reused.details.title, "资料到知识");
      assert.equal(writes, 1); assert.equal(confirms, 1); assert.equal(opens, 0);
    }
    resumeIds = [view.operationIdentity];
    const catalog = new FileConversationCatalog({ storageRootPath: store, vaultId }); await catalog.initialize();
    const runs = new FileProductRunStore({ storageRootPath: store, vaultId, catalog });
    const at = Date.now(); await catalog.upsert({ conversationId: identity.conversationId, piSessionId: identity.piSessionId, vaultId, title: "diagram", status: "active", defaultMemoryMode: "normal", createdAt: at, updatedAt: at });
    await runs.create({ productRunId: "run", conversationId: identity.conversationId, piSessionId: identity.piSessionId, userEntryId: identity.userEntryId, toolCallIds: ["call"], memoryMode: "normal", state: "product_run_settled", terminalState: "cancelled", activeLeafId: null, createdAt: at, updatedAt: at, agentSettledAt: at, settledAt: at });
    const snapshot = await prepareTaskResumeSafety({ receipts, approvals, catalog, productRuns: runs, vaultRootPath: vault, conversationId: identity.conversationId, interruptedRunId: "run",
      reconcileDiagram: async creation => (await port.reconcile(creation)).verified ? await port.version(creation.path) : null });
    assert.equal(snapshot.operations[0].status, "completed"); assert.equal(snapshot.fileConflicts.length, 0); assert.equal(snapshot.fileVersions[0].relativePath, "图.excalidraw.md");
    await assert.rejects(assertTaskResumeToolAllowed({ snapshot, receipts, approvals, vaultRootPath: vault, toolName: "diagram_create", arguments: model(), resolvedTarget: { path: "换名.excalidraw.md" } }), /already_completed/u);
    // New security and file stores model a process restart; no in-memory service map survives.
    const restarted = make(new FileApprovalTicketStore({ storageRootPath: store, vaultId }), new FileDomainReceiptStore({ storageRootPath: store, vaultId }));
    identity.productRunId = "resumed-run"; identity.userEntryId = "resumed-entry"; access = { ...access };
    const retried = { ...model(), title: "不能换名再建" };
    assert.equal(await restarted.handleToolCall({ ...event, input: retried, toolCallId: "resume-call" }), undefined);
    await restarted.execute("resume-call", retried);
    const resumed = await restarted.handleToolResult({ ...event, toolCallId: "resume-call", type: "tool_result", content: [], details: {}, isError: false } as unknown as ToolResultEvent);
    assert.equal(resumed.details.status, "completed"); assert.equal(resumed.details.reused, true);
    assert.equal(writes, 1); assert.equal(confirms, 1); assert.equal(opens, mode === "success" ? 1 : 0); assert(checked > 0);
    assert.deepEqual(await readdir(vault), ["图.excalidraw.md"]);
    console.log(`PASS diagram tool: ${mode}, durable restart readback, no duplicate or reopen`);
  }
}
