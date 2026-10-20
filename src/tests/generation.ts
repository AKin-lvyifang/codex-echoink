import assert from "node:assert/strict";
import { mkdir, writeFile, symlink, mkdtemp, rm } from "node:fs/promises";
import * as path from "node:path";
import { TFolder } from "obsidian";
import { assertGenerationInputBudget, createGenerationRequest, freezeGenerationRequest, GENERATION_REQUEST_ENTRY, GENERATION_RESULT_ENTRY } from "../generation/request";
import { readGenerationSources, isGenerationSourcePath } from "../generation/sources";
import { generationReportMarkdown } from "../generation/output";
import { buildAgentTurns, isAgentProcessItemType } from "../ui/codex-view/agent-turn-process";
import { piToolCallIdFromProjectedMessageId } from "../harness/pi-native/pi-chat-ui-projector";
import { generationStageMessage, projectGenerationEntries } from "../generation/projection";
import { createGenerationRuntimePort } from "../plugin/generation-production";
import { createPiKnowledgeInlineExtension } from "../plugin/pi-production-runtime-composition";
import type { GenerationTemplate } from "../generation/types";
import type { GenerationExecutionIdentity } from "../generation/runtime";
import type { GenerationProductionOptions } from "../plugin/generation-production";
import type { VaultOperationResult } from "../harness/pi-native/vault-domain-service";

const template: GenerationTemplate = { id: "brief", name: "简报", description: "重点", instructions: "基于资料生成简报", outputKind: "markdown", builtin: true };
export async function runGenerationTests(testRoot: string): Promise<void> {
  const root = await mkdtemp(path.join(testRoot, "sources-"));
  try {
    await mkdir(path.join(root, "资料")); await mkdir(path.join(root, "输出"));
    await writeFile(path.join(root, "资料/原文.md"), "当前全文");
    const request = createGenerationRequest(template, ["资料/原文.md"], "输出");
    template.instructions = "之后修改"; assert.equal(request.template.instructions, "基于资料生成简报"); template.instructions = "基于资料生成简报";
    assert.throws(() => freezeGenerationRequest({ ...request, outputDirectory: "其他/报告" }));
    for (const excluded of [".hidden/note.md", "资料/.hidden.md", "输出/报告.md", "../秘密.md", "图片.png", "图.canvas"]) assert.equal(isGenerationSourcePath(excluded, ["输出"]), false);
    let assessment = await readGenerationSources(root, ["资料/原文.md", "资料/原文.md", "资料/已删除.md"], ["输出"]);
    assert.equal(assessment.sources.length, 1); assert.equal(assessment.readFailures[0]?.path, "资料/已删除.md"); assert.equal(assessment.error, undefined);
    await writeFile(path.join(root, "资料/原文.md"), "修改后的完整正文");
    assessment = await readGenerationSources(root, ["资料/原文.md"], ["输出"]); assert.equal(assessment.sources[0]?.content, "修改后的完整正文");
    assert.match((await readGenerationSources(root, Array.from({ length: 21 }, (_, i) => `资料/${i}.md`))).error!, /最多 20/u);
    await writeFile(path.join(root, "资料/过大.md"), "a".repeat(32_001)); assert.match((await readGenerationSources(root, ["资料/过大.md"])).error!, /32,000/u);
    for (const name of ["a", "b", "c"]) await writeFile(path.join(root, `资料/${name}.md`), "a".repeat(25_000));
    assert.match((await readGenerationSources(root, ["资料/a.md", "资料/b.md", "资料/c.md"])).error!, /64,000/u);
    await symlink(path.join(root, "资料/原文.md"), path.join(root, "资料/链接.md"));
    assert.equal((await readGenerationSources(root, ["资料/链接.md"])).sources.length, 0);
    const markdown = generationReportMarkdown(request, "报告正文", ["资料/原文.md"]); assert.match(markdown, /\[\[资料\/原文\|原文\]\]/u); assert.match(markdown, /生成时间/u);
    const result = { requestId: request.id, outputKind: "markdown" as const, writeState: "verified" as const, path: "输出/报告/主题 · 简报.md", readFailures: [{ path: "资料/缺失.md", reason: "未找到" }] };
    const entries = [{ type: "custom", customType: GENERATION_REQUEST_ENTRY, data: { productRunId: "r1", request } }, { type: "custom", customType: GENERATION_RESULT_ENTRY, data: { productRunId: "r1", result } }];
    const projection = projectGenerationEntries([{ id: "u", role: "user", text: "short", runId: "r1", createdAt: 0 }, { id: "a", role: "assistant", text: '{"title":"MODEL_JSON"}', runId: "r1", createdAt: 0 }], entries);
    assert.equal(projection.find(message => message.role === "user")?.text, "用「简报」生成 · 1 篇资料");
    assert.equal(projection.some(message => message.text.includes("MODEL_JSON")), false); assert.match(projection.find(message => message.role === "assistant")!.text, /资料\/缺失.md/u);
    assert.equal(projectGenerationEntries([{ id: "a", role: "assistant", text: "RAW", runId: "r1", createdAt: 0 }], entries.slice(0, 1)).length, 0);
    console.log("PASS generation: snapshots, current full source, dedup/read failures, recursive exclusions, limits, links, durable result projection");
    const approval = generationStageMessage({ productRunId: "stage-run", requestId: request.id, stage: "approval", status: "running", at: 2 });
    assert.equal(piToolCallIdFromProjectedMessageId(approval.id), `generation-${request.id}`);
    assert.equal(approval.approval?.status, "pending"); assert.equal(approval.status, "waiting_approval");
    const reading = generationStageMessage({ productRunId: "stage-run", stage: "reading", status: "completed", at: 1 });
    assert.equal(isAgentProcessItemType(reading.itemType), true);
    const stageTurn = buildAgentTurns([reading, approval])[0]!;
    assert.equal(stageTurn.status, "waiting_for_user"); assert.equal(stageTurn.processNodes.some(node => node.status === "waiting" && node.kind === "tool"), true);
    console.log("PASS generation: real stages join the existing process spine and approval has a live-bindable waiting identity");
    await assertContextIsolation(request, assessment);
    await assertWriteOutcomes(root, request);
  } finally { await rm(root, { recursive: true, force: true }); }
}
async function assertContextIsolation(request: ReturnType<typeof createGenerationRequest>, assessment: Awaited<ReturnType<typeof readGenerationSources>>): Promise<void> {
  const handlers = new Map<string, (...args: any[]) => any>(); let memoryReads = 0;
  const extension = createPiKnowledgeInlineExtension({ vaultSecurity: { name: "empty", factory: () => undefined }, currentTurn: () => null,
    currentGenerationContext: () => ({ request, assessment }),
    personalMemory: { loadFixedContext: async () => { memoryReads++; throw new Error("must not read memory"); } } });
  await (extension as { factory: (api: unknown) => unknown }).factory({ on: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler) });
  const before = await handlers.get("before_agent_start")!({ systemPrompt: "OLD_PRIVATE_PROFILE", prompt: "生成" });
  assert.equal(before.systemPrompt.includes("OLD_PRIVATE_PROFILE"), false); assert.equal(memoryReads, 0);
  const user = { role: "user", content: "生成", timestamp: 2 };
  const context = await handlers.get("context")!({ messages: [{ role: "user", content: "UNRELATED_OLD_CHAT", timestamp: 1 }, { role: "custom", customType: "memory", content: "OLD_MEMORY" }, user] });
  assert.equal(context.messages.length, 2); assert.equal(context.messages[1], user); assert.equal(JSON.stringify(context).includes("UNRELATED_OLD_CHAT"), false); assert.equal(JSON.stringify(context).includes("OLD_MEMORY"), false);
  assert.throws(() => assertGenerationInputBudget(request, assessment.sources, 1), /本轮预算/u);
  console.log("PASS generation: actual Provider context excludes old chat, memory and profile; small-model budget rejects without truncation");
}
async function assertWriteOutcomes(root: string, request: ReturnType<typeof createGenerationRequest>): Promise<void> {
  const files = new Map<string, unknown>([["输出", new TFolder()]]); let written = 0, mode: "success" | "failed_verified" | "uncertain" = "success";
  const controller = new AbortController(); let abortAfterWrite = false;
  const identity: GenerationExecutionIdentity = { conversationId: "c", piSessionId: "s", productRunId: "r", vaultId: "v", access: { permission: "workspace-write", mode: "agent", memoryMode: "no_memory" }, signal: controller.signal };
  const options: GenerationProductionOptions = {
    app: { vault: { getAbstractFileByPath: (name: string) => files.get(name), createFolder: async (name: string) => { await mkdir(path.join(root, name)); files.set(name, new TFolder()); } } } as never,
    vaultRoot: root, bindings: () => ({ roles: { outputs: { enabled: true, writePath: "输出", readPaths: ["输出"] } } }) as never,
    assertRead: async () => undefined, assertWrite: async () => undefined,
    authorization: () => ({ authorize: async () => ({ authorizationKind: "approval_ticket", effectType: "user_write", operationIdentity: "op" }) as never }),
    domain: { noteCreate: async (input: any) => { await input.beforeSideEffect(); written++; if (abortAfterWrite) controller.abort(); return { operationIdentity: "op", operation: "note_create", status: mode === "failed_verified" ? "failed" : mode === "uncertain" ? "uncertain" : "completed", readbackVerified: mode !== "uncertain", sideEffectStarted: true, readback: { source: { status: mode === "failed_verified" ? "missing" : "present" } }, sourcePath: input.relativePath } as VaultOperationResult; } } as never,
    writeExecution: { execute: async (_input, invoke) => invoke(async () => undefined) }
  };
  const port = createGenerationRuntimePort(options); const assessment = await port.prepare(request, identity);
  const model = JSON.stringify({ title: "主题", markdown: "正文" });
  let result = await port.finish(request, assessment, model, identity, async () => undefined);
  assert.equal(result.writeState, "verified"); assert.match(result.path!, /输出\/报告\/主题 · 简报.md/u);
  mode = "failed_verified"; result = await port.finish(request, assessment, model, identity, async () => undefined); assert.equal(result.writeState, "not_written"); assert.equal(result.path, undefined);
  mode = "uncertain"; result = await port.finish(request, assessment, model, identity, async () => undefined); assert.equal(result.writeState, "unconfirmed"); assert.match(result.error!, /先核对/u);
  mode = "success"; abortAfterWrite = true; result = await port.finish(request, assessment, model, identity, async () => undefined); assert.equal(result.writeState, "verified", "post-write cancellation retains verified output");
  const beforeCancelCount = written; result = await port.finish(request, assessment, model, identity, async () => undefined); assert.equal(result.writeState, "not_written"); assert.equal(written, beforeCancelCount);
  const changed = createGenerationRuntimePort({ ...options, bindings: () => ({ roles: { outputs: { enabled: true, writePath: "别处", readPaths: ["别处"] } } }) as never });
  await assert.rejects(changed.prepare(request, { ...identity, signal: new AbortController().signal }), /换绑/u);
  const invalidMap = await port.finish({ ...request, outputKind: "canvas", outputDirectory: "输出/导图", template: { ...request.template, outputKind: "canvas" } }, assessment, '{"title":"invalid","branches":[]}', { ...identity, signal: new AbortController().signal }, async () => undefined);
  assert.equal(invalidMap.writeState, "not_written"); assert.equal(written, beforeCancelCount);
  console.log("PASS generation: controlled write, confirmed failure, uncertain result, pre/post-write cancellation, rebound output and invalid map rejection");
}
