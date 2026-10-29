import assert from "node:assert/strict";
import type { ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { PiWorkspaceToolSecurity, createPiWorkspaceToolDefinitions } from "../../harness/pi-native/pi-workspace-tools";
import { createPiVaultToolSecurityAdapter } from "../../harness/pi-native/pi-vault-tool-security-extension";
import { createControlledPiToolRegistration } from "../../harness/pi-native/controlled-resources";
import { piWorkspaceToolDecision } from "../../harness/pi-native/pi-workspace-access";
import { WorkspaceService, WORKSPACE_ROOT, workspaceRevision, type WorkspaceFilePort } from "../../workspace/service";

function fixture() {
  const files = new Map<string, string>(), folders = new Set<string>(), writes: string[] = [];
  let permitted = true, permission: "read-only" | "workspace-write" = "workspace-write", run = "run-1", beforeRead: (() => void) | undefined;
  const assertAllowed = async (tool: string, args: Readonly<Record<string, unknown>>) => {
    if (!permitted) throw new Error("agent_capability_conversation_revoked");
    const decision = piWorkspaceToolDecision({ permission, mode: "agent", memoryMode: "normal", toolName: tool, toolArguments: { ...args },
      planToolNames: ["workspace_read"], memoryToolNames: [], externalReadToolNames: [] });
    if (!decision.allowed) throw new Error("tool_policy_blocked");
  };
  const port: WorkspaceFilePort = {
    adapter: {
      async stat(path) { return files.has(path) ? { type: "file", size: new TextEncoder().encode(files.get(path)!).length, ctime: 0, mtime: 0 }
        : folders.has(path) ? { type: "folder", size: 0, ctime: 0, mtime: 0 } : null; },
      async list() { return { files: [...files.keys()], folders: [...folders] }; },
      async mkdir(path) { folders.add(path); },
      async read(path) { beforeRead?.(); const value = files.get(path); if (value === undefined) throw new Error("missing"); return value; },
    },
    async create(path, content, guard) { guard(); if (files.has(path)) throw new Error("exists"); files.set(path, content); writes.push(path); },
    async process(path, change) { const content = change(files.get(path)!); files.set(path, content); writes.push(path); return content; }
  };
  const workspace = new PiWorkspaceToolSecurity({ service: new WorkspaceService(port),
    currentRunIdentity: () => ({ vaultId: "vault-test", conversationId: "conversation-test", piSessionId: "session-test", productRunId: run }),
    assertToolAllowed: assertAllowed,
    guard: operation => { if (!permitted || operation !== "read" && permission === "read-only") throw new Error("agent_capability_conversation_revoked"); }
  });
  const adapter = createPiVaultToolSecurityAdapter({
    isToolAllowed: async (name, args) => { try { await assertAllowed(name, args ?? {}); return true; } catch { return false; } },
    authorization: { async authorize() { throw new Error("unexpected generic vault authorization"); } },
    resultCorrection: { async correct() { throw new Error("unexpected generic vault result"); } },
    additionalToolSecurities: [workspace],
  });
  const handlers = new Map<string, (event: unknown, context?: unknown) => Promise<unknown>>();
  const ready = adapter.inlineExtension.factory({ on: (name: string, handler: (event: unknown, context?: unknown) => Promise<unknown>) => handlers.set(name, handler) } as never);
  const registration = createControlledPiToolRegistration(createPiWorkspaceToolDefinitions(workspace), assertAllowed);
  const call = (id: string, name: string, input: object, signal?: AbortSignal) => handlers.get("tool_call")!({ type: "tool_call", toolCallId: id, toolName: name, input } as ToolCallEvent, { signal });
  const execute = async (id: string, name: string, input: object) => {
    const tool = registration.customTools.find(tool => tool.name === name)!;
    return await tool.execute(id, input, undefined, undefined, {} as never);
  };
  const result = (id: string, name: string, content = "UNTRUSTED EVENT CONTENT") => handlers.get("tool_result")!({ type: "tool_result", toolCallId: id, toolName: name,
    input: {}, content: [{ type: "text", text: content }], details: { previewPath: "outside.html", content }, isError: false }) as Promise<{ isError: boolean; content: { text: string }[]; details: Record<string, unknown> }>;
  const complete = async (id: string, name: string, input: object) => {
    assert.equal(await call(id, name, input), undefined);
    const pending = await execute(id, name, input);
    assert.equal(pending.content[0].type, "text");
    assert.equal((pending.content[0] as { text: string }).text, "workspace_result_pending_safety");
    assert.deepEqual(pending.details, {}, "execute cannot bypass the inline result gate");
    return await result(id, name);
  };
  return { ready, files, writes, call, execute, result, complete,
    permit(value: boolean) { permitted = value; }, readOnly(value = true) { permission = value ? "read-only" : "workspace-write"; },
    run(value: string) { run = value; }, beforeRead(value?: () => void) { beforeRead = value; } };
}

export async function runPiWorkspaceToolTests(): Promise<void> {
  let passed = 0;
  const test = async (name: string, run: () => void | Promise<void>) => { await run(); ++passed; console.log(`OK Pi workspace security: ${name}`); };
  await test("all three tools pass the real inline call -> controlled execute -> trusted result chain", async () => {
    const f = fixture(); await f.ready;
    const created = await f.complete("create", "workspace_create", { path: "demo.html", content: "<button>one</button>" });
    assert.equal(created.isError, false); assert.equal(created.details.previewPath, `${WORKSPACE_ROOT}/demo.html`);
    assert.equal(JSON.parse(created.content[0].text).previewPath, `${WORKSPACE_ROOT}/demo.html`);
    assert.ok(!created.content[0].text.includes("UNTRUSTED EVENT CONTENT"));
    const read = await f.complete("read", "workspace_read", { path: "demo.html" });
    assert.equal(read.isError, false); assert.equal(JSON.parse(read.content[0].text).content, "<button>one</button>");
    const updated = await f.complete("update", "workspace_update", { path: "demo.html", expectedRevision: read.details.contentRevision, content: "<button>two</button>" });
    assert.equal(updated.isError, false); assert.equal(updated.details.previewPath, `${WORKSPACE_ROOT}/demo.html`);
    assert.equal(f.files.get(`${WORKSPACE_ROOT}/demo.html`), "<button>two</button>"); assert.equal(f.writes.length, 2);
  });
  await test("unknown tool names remain blocked by the sole security extension", async () => {
    const f = fixture(); await f.ready;
    assert.deepEqual(await f.call("unknown", "workspace_delete", { path: "demo.html" }), { block: true, reason: "tool_policy_blocked" });
    assert.equal((await f.result("unknown", "workspace_delete")).isError, true); assert.equal(f.writes.length, 0);
  });
  await test("admission and execution are one-shot and parameter-bound", async () => {
    const f = fixture(); await f.ready; const args = { path: "once.md", content: "one" };
    assert.equal(await f.call("once", "workspace_create", args), undefined);
    await assert.rejects(f.execute("once", "workspace_create", { ...args, path: "other.md" }), /authorization/u);
    await f.execute("once", "workspace_create", args);
    await assert.rejects(f.execute("once", "workspace_create", args), /authorization/u);
    assert.equal((await f.result("once", "workspace_create")).isError, false);
    assert.equal((await f.result("once", "workspace_create")).isError, true);
    assert.equal((await f.call("once", "workspace_create", args) as { block: boolean }).block, true); assert.equal(f.writes.length, 1);
  });
  await test("read-only dispatch blocks writes while allowing an admitted workspace read", async () => {
    const f = fixture(); await f.ready; f.files.set(`${WORKSPACE_ROOT}/read.md`, "safe"); f.readOnly();
    assert.equal((await f.call("deny-write", "workspace_create", { path: "new.md", content: "x" }) as { block: boolean }).block, true);
    assert.equal((await f.complete("allow-read", "workspace_read", { path: "read.md" })).isError, false); assert.equal(f.writes.length, 0);
  });
  await test("live Agent permission revocation before execution or during async reads stops access", async () => {
    const f = fixture(); await f.ready; const args = { path: "new.md", content: "x" };
    assert.equal(await f.call("revoke", "workspace_create", args), undefined); f.permit(false);
    await assert.rejects(f.execute("revoke", "workspace_create", args)); assert.equal((await f.result("revoke", "workspace_create")).isError, true);
    assert.equal(f.writes.length, 0); f.permit(true); f.files.set(`${WORKSPACE_ROOT}/private.md`, "PRIVATE READ BODY");
    f.beforeRead(() => f.permit(false));
    const result = await f.complete("revoke-read", "workspace_read", { path: "private.md" });
    assert.equal(result.isError, true); assert.ok(!JSON.stringify(result).includes("PRIVATE READ BODY"));
  });
  await test("result egress checks current authority and task identity without trusting event details", async () => {
    for (const change of ["permission", "identity"] as const) {
      const f = fixture(); await f.ready; const args = { path: "private.md" }; f.files.set(`${WORKSPACE_ROOT}/private.md`, "PRIVATE EGRESS BODY");
      assert.equal(await f.call(change, "workspace_read", args), undefined); await f.execute(change, "workspace_read", args);
      if (change === "permission") f.permit(false); else f.run("another-run");
      const result = await f.result(change, "workspace_read"); assert.equal(result.isError, true); assert.ok(!JSON.stringify(result).includes("PRIVATE EGRESS BODY"));
    }
  });
  await test("path traversal is rejected before execution and stale revisions cannot overwrite files", async () => {
    const f = fixture(); await f.ready;
    assert.equal((await f.call("traversal", "workspace_read", { path: "../private.md" }) as { block: boolean }).block, true);
    f.files.set(`${WORKSPACE_ROOT}/edit.md`, "user changed");
    const result = await f.complete("stale", "workspace_update", { path: "edit.md", content: "model overwrite", expectedRevision: workspaceRevision("old body") });
    assert.equal(result.isError, true); assert.equal(result.content[0].text, "workspace_source_changed");
    assert.equal(f.files.get(`${WORKSPACE_ROOT}/edit.md`), "user changed"); assert.equal(f.writes.length, 0);
  });
  await test("the admitted turn's cancellation signal is rechecked before result delivery", async () => {
    const f = fixture(); await f.ready; const controller = new AbortController(), args = { path: "private.md" };
    f.files.set(`${WORKSPACE_ROOT}/private.md`, "PRIVATE CANCELLED BODY");
    assert.equal(await f.call("cancelled", "workspace_read", args, controller.signal), undefined);
    await f.execute("cancelled", "workspace_read", args); controller.abort();
    const result = await f.result("cancelled", "workspace_read"); assert.equal(result.isError, true);
    assert.ok(!JSON.stringify(result).includes("PRIVATE CANCELLED BODY"));
  });
  console.log(`Pi workspace security: ${passed} scenarios passed.`);
}
