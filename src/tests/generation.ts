import assert from "node:assert/strict";
import { mkdir, writeFile, symlink, mkdtemp, rm } from "node:fs/promises";
import * as path from "node:path";
import { TFolder } from "obsidian";
import { assertGenerationInputBudget, createGenerationRequest, freezeGenerationRequest, GENERATION_REQUEST_ENTRY, GENERATION_RESULT_ENTRY } from "../generation/request";
import { readGenerationSources, isGenerationSourcePath } from "../generation/sources";
import { generationFileStem, generationReportMarkdown } from "../generation/output";
import { buildAgentTurns, isAgentProcessItemType } from "../ui/codex-view/agent-turn-process";
import { piToolCallIdFromProjectedMessageId } from "../harness/pi-native/pi-chat-ui-projector";
import { GENERATION_ATTEMPT_ENTRY, generationStageMessage, projectGenerationEntries } from "../generation/projection";
import { createGenerationRuntimePort } from "../plugin/generation-production";
import { createPiKnowledgeInlineExtension } from "../plugin/pi-production-runtime-composition";
import type { GenerationAttempt, GenerationTemplate } from "../generation/types";
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
    for (const code of [0, 0x1f, 0x7f, 0x80, 0x85, 0x9f, 0x200b, 0x200d]) {
      assert.equal(isGenerationSourcePath(`资料/a${String.fromCodePoint(code)}b.md`), false, "source selection retains its broader Unicode category-C exclusion");
    }
    for (const excluded of ["资料/[原文].md", "资料/原文].md", "资料/原文#标题.md", "资料/../原文.md", "/资料/原文.md"]) {
      assert.equal(isGenerationSourcePath(excluded), false);
    }
    assert.equal(generationFileStem("[主题]#^|?\\\u0080\u200d", "[模板]"), "主题 · 模板");
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
    assertLocalReportTime(request);
    const result = { requestId: request.id, outputKind: "markdown" as const, writeState: "verified" as const, path: "输出/报告/主题 · 简报.md", readFailures: [{ path: "资料/缺失.md", reason: "未找到" }] };
    const entries = [{ type: "custom", customType: GENERATION_REQUEST_ENTRY, data: { productRunId: "r1", request } }, { type: "custom", customType: GENERATION_RESULT_ENTRY, data: { productRunId: "r1", result } }];
    const projection = projectGenerationEntries([{ id: "u", role: "user", text: "short", runId: "r1", createdAt: 0 }, { id: "a", role: "assistant", text: '{"title":"MODEL_JSON"}', runId: "r1", createdAt: 0 }], entries);
    assert.equal(projection.find(message => message.role === "user")?.text, "用「简报」生成 · 1 篇资料");
    assert.equal(projection.some(message => message.text.includes("MODEL_JSON")), false); assert.match(projection.find(message => message.role === "assistant")!.text, /资料\/缺失.md/u);
    assert.equal(projectGenerationEntries([{ id: "a", role: "assistant", text: "RAW", runId: "r1", createdAt: 0 }], entries.slice(0, 1)).length, 0);
    const retryEntries = [...entries, ...["retry:2", "retry:3"].map(userEntryId => ({ type: "custom", customType: GENERATION_ATTEMPT_ENTRY, data: { productRunId: "r1", userEntryId } }))];
    const replay = projectGenerationEntries([
      { id: "u", role: "user", text: "初次", runId: "r1", createdAt: 0 },
      { id: "a1", role: "assistant", text: "INVALID_FIRST", runId: "r1", createdAt: 1 },
      { id: "pi:scope:entry:retry%3A2", role: "user", text: "第二次", runId: "synthetic-2", createdAt: 2 },
      { id: "a2", role: "assistant", text: "INVALID_SECOND", runId: "synthetic-2", createdAt: 3 },
      { id: "pi:scope:entry:retry%3A3", role: "user", text: "第三次", runId: "synthetic-3", createdAt: 4 },
      { id: "a3", role: "assistant", text: "MODEL_JSON", runId: "r1", createdAt: 5 },
      { id: "ordinary", role: "user", text: "下一件普通任务", runId: "unrelated", createdAt: 6 }
    ], retryEntries);
    assert.equal(replay.filter(message => message.role === "user" && message.generationRequest).length, 1);
    assert.equal(replay.filter(message => message.generationResult).length, 1);
    assert.equal(replay.some(message => /INVALID_|MODEL_JSON/u.test(message.text)), false);
    assert.equal(replay.find(message => message.id === "ordinary")?.text, "下一件普通任务");
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
function assertLocalReportTime(request: ReturnType<typeof createGenerationRequest>): void {
  const previousTimezone = process.env.TZ;
  const fixedRequest = { ...request, createdAt: "2026-10-20T01:02:59.000Z" };
  try {
    for (const [timezone, expected] of [
      ["UTC", "2026-10-20 01:02"], ["Asia/Shanghai", "2026-10-20 09:02"], ["America/Los_Angeles", "2026-10-19 18:02"]
    ]) {
      process.env.TZ = timezone;
      const markdown = generationReportMarkdown(fixedRequest, "正文", ["资料/原文.md"]);
      assert(markdown.includes(`生成时间: ${JSON.stringify(expected)}\n`), `report time must use local ${timezone} year/month/day/hour/minute`);
      assert.equal(fixedRequest.createdAt, "2026-10-20T01:02:59.000Z", "the internal snapshot remains ISO UTC");
    }
  } finally {
    if (previousTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = previousTimezone;
  }
  console.log("PASS generation: report time uses local YYYY-MM-DD HH:mm across timezones and day boundaries without changing the snapshot");
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
  let attempt: GenerationAttempt = { kind: "repair", failedOutput: "FAILED_THIS_TURN_ONLY", validationError: "节点重叠" };
  const canvasRequest = { ...request, outputKind: "canvas" as const, outputDirectory: "输出/导图", template: { ...request.template, outputKind: "canvas" as const } };
  const canvasHandlers = new Map<string, (...args: any[]) => any>();
  const canvasExtension = createPiKnowledgeInlineExtension({ vaultSecurity: { name: "empty", factory: () => undefined }, currentTurn: () => null,
    currentGenerationContext: () => ({ request: canvasRequest, assessment, attempt }),
    personalMemory: { loadFixedContext: async () => { throw new Error("repair must not read memory"); } } });
  await (canvasExtension as { factory: (api: unknown) => unknown }).factory({ on: (name: string, handler: (...args: any[]) => any) => canvasHandlers.set(name, handler) });
  const repairBefore = await canvasHandlers.get("before_agent_start")!({ systemPrompt: "OLD_PRIVATE_PROFILE", prompt: "生成" });
  assert.match(repairBefore.systemPrompt, /JSON Canvas/u);
  assert.equal(repairBefore.systemPrompt.includes("OLD_PRIVATE_PROFILE"), false);
  const repairUser = { role: "user", content: "修复请求", timestamp: 3 };
  const repairContext = await canvasHandlers.get("context")!({ messages: [user, { role: "assistant", content: "OLD_ASSISTANT_OUTPUT" }, repairUser] });
  assert.equal(repairContext.messages.length, 2); assert.equal(repairContext.messages[1], repairUser);
  assert.match(JSON.stringify(repairContext.messages[0]), /FAILED_THIS_TURN_ONLY/u);
  assert.match(JSON.stringify(repairContext.messages[0]), /节点重叠/u);
  assert.equal(JSON.stringify(repairContext).includes("OLD_ASSISTANT_OUTPUT"), false);
  attempt = { kind: "fallback" };
  const fallbackBefore = await canvasHandlers.get("before_agent_start")!({ systemPrompt: "OLD_PRIVATE_PROFILE", prompt: "生成" });
  assert.match(fallbackBefore.systemPrompt, /branches/u);
  const fallbackContext = await canvasHandlers.get("context")!({ messages: [user, repairUser] });
  assert.equal(JSON.stringify(fallbackContext).includes("FAILED_THIS_TURN_ONLY"), false);
  console.log("PASS generation: actual Provider context excludes old chat, memory and profile; small-model budget rejects without truncation");
  console.log("PASS generation: real extension injects Canvas skill and attempt-scoped repair, then switches to isolated hierarchy fallback");
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
