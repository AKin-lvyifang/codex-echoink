import { fixtureKnowledgeUnit } from "./maintenance-staged-fixture";
import { createMaintenanceSectionSnapshot } from "../knowledge-base/maintenance-section-patch";
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
  for (const stages of ["omitted-root-source-paths", "narrowed-write-root"] as const) await scenario(`sdk-${stages}-frozen-batch`,async f=>{
    const idea="inbox/并列的第二来源.md",paths=[source,idea];
    await f.write(idea,"# 并列第二来源\n本篇保留独立证据，在计划阶段汇总为同一页。\n");
    const beforeWiki=await f.wiki();
    const result=await f.run("/maintain 按冻结批次整理两篇资料",{maintenanceScope:{mode:"batch",sourcePaths:paths}},paths,stages);
    const run=await f.productRuns.read(result.result.productRunId);
    if(stages==="omitted-root-source-paths"){
      assert.equal(result.result.terminalState,"completed");assert.equal(result.tool?.isError,false,result.tool?.content);
      assert.deepEqual(run?.maintenance?.processedSourcePaths,paths);assert.deepEqual(run?.maintenance?.pendingSourcePaths,[]);
      for(const selected of paths)assert.ok((await f.wiki()).includes(selected),"omitting every tool root sourcePaths still inherits the whole frozen Raw+Inbox batch");
    }else{
      assert.equal(result.result.terminalState,"failed");assert.equal(result.tool?.isError,true);
      assert.match(result.tool?.content??"",/knowledge_maintenance_source_scope_invalid/u);
      for(const selected of paths)assert.ok(result.tool?.content.includes(selected),"root narrowing still prints both authorized paths");
      assert.deepEqual(run?.maintenance?.processedSourcePaths,[]);assert.deepEqual(run?.maintenance?.pendingSourcePaths,paths);
      assert.equal(await f.wiki(),beforeWiki,"a single-page root cannot authorize a write outside the frozen batch contract");
    }
  });
  for (const stage of ["bad-decompose", "bad-plan"] as const) await scenario(`sdk-${stage}-aggregated-bounded-diagnostics`, async f => {
    const before = await f.maintenanceSnapshot();
    const result = await f.run("/maintain 检查工具多处错误", { maintenanceScope: { mode: "batch", sourcePaths: [source] } }, source, stage);
    assert.equal(result.result.terminalState, "failed");
    assert.equal(result.tool?.isError, true);
    assert.match(result.tool?.content ?? "", /共\d+项错误/u, "the real SDK session must reach bounded diagnostics instead of AJV's unbounded argument echo");
    assert.match(result.tool?.content ?? "", stage === "bad-plan" ? /knowledge\.unitIds/u : /decompositions\[0\]/u);
    assert.doesNotMatch(result.tool?.content ?? "", /Received arguments|DO_NOT_ECHO_THIS_BODY/u);
    assert.ok(Buffer.byteLength(result.tool?.content ?? "") < 8_000);
    assert.deepEqual(await f.maintenanceSnapshot(), before, "rejected arguments cannot create a maintenance record or modify content");
  });
  await scenario("sdk-omitted-unit-aliases-safe-default", async f => {
    const result = await f.run("/maintain 整理来源", { maintenanceScope: { mode: "batch", sourcePaths: [source] } }, source, "omitted-aliases");
    assert.equal(result.result.terminalState, "completed");
    assert.equal(result.tool?.isError, false, result.tool?.content);
  });
  await scenario("processed-batch-new-conversation-readonly-noop", async f => {
    const paths = [source, other];
    const first = await f.run("/maintain 整理这批资料", { maintenanceScope: { mode: "batch", sourcePaths: paths } }, paths);
    assert.equal(first.result.terminalState, "completed");
    assert.equal(first.tool?.isError, false);
    const before = await f.maintenanceSnapshot();
    assert.ok(Object.keys(before).some(relative => relative.includes("/records/maintenance-")), "the first run created real private maintenance records");
    for (const stage of ["inspect", "resume-only"] as const) {
      const conversationId = `processed-repeat-${stage}`;
      await f.createConversation(conversationId);
      const repeat = await f.run("/maintain 检查同一批已整理资料", { conversationId, maintenanceScope: { mode: "batch", sourcePaths: paths } }, paths, stage);
      assert.equal(repeat.result.terminalState, "completed", repeat.result.error);
      assert.equal(repeat.tool?.isError, false, repeat.tool?.content);
      const run = await f.productRuns.read(repeat.result.productRunId);
      assert.deepEqual(run?.maintenance?.processedSourcePaths, paths);
      assert.deepEqual(run?.maintenance?.pendingSourcePaths, []);
      assert.deepEqual(run?.maintenance?.warnings, []);
      assert.match(repeat.tool?.content ?? "", /已提炼|已处理/u);
      assert.deepEqual(await f.maintenanceSnapshot(), before, "repeat only reads: Raw/Inbox/Wiki/maps and maintenance record bytes stay identical");
    }
  });
  await scenario("unprocessed-inspect-still-requires-decomposition", async f => {
    const before = await f.maintenanceSnapshot();
    const result = await f.run("/maintain 检查尚未整理的资料", { maintenanceScope: { mode: "batch", sourcePaths: [source] } }, source, "inspect");
    assert.equal(result.result.terminalState, "failed");
    assert.equal(result.tool?.isError, true);
    assert.match(result.tool?.content ?? "", /没有未完成清单；先stage=decompose/u);
    const run = await f.productRuns.read(result.result.productRunId);
    assert.deepEqual(run?.maintenance?.processedSourcePaths, []);
    assert.deepEqual(run?.maintenance?.pendingSourcePaths, [source]);
    assert.deepEqual(await f.maintenanceSnapshot(), before);
  });
  await scenario("noop-inspect-keeps-authorized-source-boundary", async f => {
    const first = await f.run("/maintain 整理授权来源", { maintenanceScope: { mode: "batch", sourcePaths: [source] } }, source);
    assert.equal(first.result.terminalState, "completed");
    const before = await f.maintenanceSnapshot();
    await f.createConversation("out-of-scope-inspect");
    const repeat = await f.run("/maintain 检查授权来源", { conversationId: "out-of-scope-inspect", maintenanceScope: { mode: "batch", sourcePaths: [source] } }, other, "inspect");
    assert.equal(repeat.result.terminalState, "failed");
    assert.equal(repeat.tool?.isError, true);
    assert.ok(repeat.tool?.content.includes(source), "the rejection still prints the complete authorized path");
    assert.deepEqual(await f.maintenanceSnapshot(), before);
  });
  await scenario("processed-noop-cannot-hide-historical-unfinished-job", async f => {
    const paths = [source];
    const first = await f.run("/maintain 先保存清单", { maintenanceScope: { mode: "batch", sourcePaths: paths } }, paths, "plan");
    assert.equal(first.result.terminalState, "completed");
    await f.write(source, "---\n提炼状态: 已提炼\n---\n# 星系专题\n星系专题记录可追溯的观测资料。\n");
    const before = await f.maintenanceSnapshot();
    await f.createConversation("historical-inspect");
    const repeat = await f.run("/maintain 检查这批资料", { conversationId: "historical-inspect", maintenanceScope: { mode: "batch", sourcePaths: paths } }, paths, "inspect");
    assert.equal(repeat.result.terminalState, "failed");
    assert.equal(repeat.tool?.isError, true);
    assert.match(repeat.tool?.content ?? "", /未完成清单|未完清单/u);
    assert.deepEqual((await f.productRuns.read(repeat.result.productRunId))?.maintenance?.pendingSourcePaths, paths);
    assert.deepEqual(await f.maintenanceSnapshot(), before);
  });
  await scenario("completed-earlier-batch-cannot-settle-new-pending-source", async f => {
    const firstPaths = [source, other];
    const first = await f.run("/maintain 整理首批", { maintenanceScope: { mode: "batch", sourcePaths: firstPaths } }, firstPaths);
    assert.equal(first.result.terminalState, "completed");
    const before = await f.maintenanceSnapshot();
    const next = await f.run("/maintain 检查下一批", { maintenanceScope: { mode: "batch", sourcePaths: [third] } }, third, "inspect");
    assert.equal(next.result.terminalState, "failed");
    assert.match(next.tool?.content ?? "", /先stage=decompose/u);
    const run = await f.productRuns.read(next.result.productRunId);
    assert.deepEqual(run?.maintenance?.processedSourcePaths, []);
    assert.deepEqual(run?.maintenance?.pendingSourcePaths, [third]);
    assert.deepEqual(await f.maintenanceSnapshot(), before);
  });
  await scenario("reset-source-state-overrides-completed-conversation-record", async f => {
    const paths = [source];
    const first = await f.run("/maintain 整理来源", { maintenanceScope: { mode: "batch", sourcePaths: paths } }, paths);
    assert.equal(first.result.terminalState, "completed");
    await f.write(source, "---\n提炼状态: 未提炼\n---\n# 星系专题\n星系专题记录可追溯的观测资料。\n");
    const before = await f.maintenanceSnapshot();
    const repeat = await f.run("/maintain 检查被重置的来源", { maintenanceScope: { mode: "batch", sourcePaths: paths } }, paths, "inspect");
    assert.equal(repeat.result.terminalState, "failed");
    assert.match(repeat.tool?.content ?? "", /先stage=decompose/u);
    const run = await f.productRuns.read(repeat.result.productRunId);
    assert.deepEqual(run?.maintenance?.processedSourcePaths, []);
    assert.deepEqual(run?.maintenance?.pendingSourcePaths, paths);
    assert.deepEqual(await f.maintenanceSnapshot(), before);
  });
  await scenario("p1-raw-inbox-plan-pause-cold-resume", async f => {
    const idea = "inbox/间隔复习随手记.md", paths = [source, idea];
    await f.write(idea, "# 收件箱想法\n间隔复习与星系专题需要定期回顾。\n");
    const first = await f.run("/maintain 请先拆解并保存写作清单后停下，等下一轮继续。", { maintenanceScope: { mode: "batch", sourcePaths: paths } }, paths, "plan");
    assert.equal(first.result.terminalState, "completed", "a durable stage pause is not a failed ProductRun");
    const firstRun = await f.productRuns.read(first.result.productRunId);
    assert.equal(firstRun?.knowledge?.workflow, "maintain");
    assert.deepEqual(firstRun?.maintenance?.processedSourcePaths, []);
    assert.deepEqual(firstRun?.maintenance?.pendingSourcePaths, paths);
    assert.doesNotMatch(await f.wiki(), /星系专题/u, "decomposition and plan cannot write Wiki");
    await f.reopen();
    const resumed = await f.run("继续", {}, paths, "resume");
    assert.equal(resumed.result.terminalState, "completed"); assert.equal(resumed.tool?.isError, false, resumed.tool?.content);
    for (const selected of paths) assert.ok((await f.wiki()).includes(selected));
    const completed = await f.productRuns.read(resumed.result.productRunId);
    assert.equal(completed?.knowledge?.workflow, "maintain", "cold continuation updates execution and durable observation workflow together");
    assert.deepEqual(completed?.maintenance?.processedSourcePaths, paths);
  });
  await scenario("p1-stage-success-then-write-failure", async f => {
    const result = await f.run("/maintain 按清单整理", { maintenanceScope: { mode: "batch", sourcePaths: [source] } }, source, "invalid-write");
    assert.equal(result.result.terminalState, "failed", "earlier successful stages cannot hide an uncorrected page failure");
    assert.equal(result.tool?.isError, true);
    assert.doesNotMatch(await f.wiki(), /星系专题/u);
    const run = await f.productRuns.read(result.result.productRunId);
    assert.deepEqual(run?.maintenance?.processedSourcePaths, []); assert.deepEqual(run?.maintenance?.pendingSourcePaths, [source]);
  });
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
  for (const [role, directory] of [["raw", "raw"], ["inbox", "inbox"], ["wiki", "知识库（wiki）"]] as const) bindings.roles[role] = { enabled: true, readPaths: [directory], writePath: directory, allowedSubdirectories: [] };
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
      if (request.kinds?.includes("raw")) rawQueries.push(request.query);
      return await search(request);
    };
  };
  observeRawQueries();
  const createConversation = (conversationId: string) => bundle.runtime.createConversation({ conversationId, title: "维护跟进", cwd: vault });
  await createConversation("followup");
  return { vault, catalog, productRuns, approvals, receipts, bodies, runs, rawQueries, createConversation, runtime: () => bundle.runtime,
    maintenanceSnapshot: async () => {
      const snapshot: Record<string, string> = {};
      const visit = async (relative: string): Promise<void> => {
        for (const entry of await fs.readdir(path.join(vault, relative), { withFileTypes: true }).catch(error => { if (error.code === "ENOENT") return []; throw error; })) {
          const child = `${relative}/${entry.name}`;
          if (entry.isDirectory()) await visit(child);
          else if (entry.isFile()) snapshot[child] = (await fs.readFile(path.join(vault, child))).toString("base64");
        }
      };
      for (const relative of ["raw", "inbox", "知识库（wiki）", ".obsidian/plugins/echoink/pi-agent-product-v1/knowledge/records"]) await visit(relative);
      return snapshot;
    },
    wiki: () => fs.readFile(path.join(vault, wiki), "utf8"),
    write: async (relative: string, text: string) => { await fs.mkdir(path.dirname(path.join(vault, relative)), { recursive: true }); await fs.writeFile(path.join(vault, relative), text); },
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
    run: async (text: string, extra: Partial<PiChatSubmitRequest> = {}, maintainSource?: string | readonly string[], stages: "all" | "plan" | "resume" | "invalid-write" | "inspect" | "resume-only" | "bad-decompose" | "bad-plan" | "omitted-aliases" | "omitted-root-source-paths" | "narrowed-write-root" = "all") => {
      const requestStart = bodies.length;
      const toolCall = (name: string, args: object) => {
        let parameters=args;
        if(name==="knowledge_maintain"&&stages==="omitted-root-source-paths")parameters=Object.fromEntries(Object.entries(args).filter(([key])=>key!=="sourcePaths"));
        if(name==="knowledge_maintain"&&stages==="narrowed-write-root"&&(args as {stage?:string}).stage==="write")parameters={...args,sourcePaths:[typeof maintainSource==="string"?maintainSource:maintainSource![0]]};
        return { id: `v9-${++callNumber}`, type: "function", function: { name, arguments: JSON.stringify(parameters) } };
      };
      let maintenanceCallId: string | undefined;
      if (maintainSource) {
        const paths = typeof maintainSource === "string" ? [maintainSource] : maintainSource;
        const before = await fs.readFile(path.join(vault, wiki), "utf8");
        replies.push({ role: "assistant", content: null, tool_calls: [...paths.map(relativePath => toolCall("note_read", { relativePath })), toolCall("note_read", { relativePath: wiki })] });
        const units = await Promise.all(paths.map(async (sourcePath, index) => fixtureKnowledgeUnit(`source-${index}`, sourcePath, await fs.readFile(path.join(vault, sourcePath), "utf8").catch(() => ""), before.match(/^#\s+(.+)$/mu)?.[1] ?? "合成知识点")));
        const decomposition = toolCall("knowledge_maintain", { stage: "decompose", sourcePaths: paths, decompositions: paths.map((sourcePath, index) => ({ sourcePath, summary: `合成摘要 ${sourcePath}`, units: [stages === "omitted-aliases" ? Object.fromEntries(Object.entries(units[index]).filter(([key]) => key !== "aliases")) : units[index]] })) });
        const plan = toolCall("knowledge_maintain", { stage: "plan", sourcePaths: paths, writingPlan: [{ id: "summary", targetPath: wiki, sourcePaths: paths, knowledge: { unitIds: units.map(unit => unit.id), decision: { kind: "same_point", reason: "合成夹具：维护同一主题原有页以验证范围继承", candidatePath: wiki } }, expectedTarget: { kind: "file", contentRevision: `sha256:${createHash("sha256").update(before).digest("hex")}` } }] });
        const snapshot = createMaintenanceSectionSnapshot(before), intro = snapshot.regions.find(region => region.kind === "introduction")!;
        const sections = toolCall("knowledge_maintain", { stage: "sections", sourcePaths: paths, targetPath: wiki });
        const maintenance = toolCall("knowledge_maintain", { stage: "write", sourcePaths: paths, pageId: "summary", sectionPatches: [{ regionId: stages === "invalid-write" ? "invalid-region" : intro.id, operation: "replace", content: paths.map(selected => `已整理 [[${selected}|原始资料]]。`).join("\n") + "\n\n" }] });
        const resume = toolCall("knowledge_maintain", { stage: "resume", sourcePaths: paths });
        const inspect = toolCall("knowledge_maintain", { stage: "inspect", sourcePaths: paths, view: "pages" });
        const badDecompose = toolCall("knowledge_maintain", { stage: "decompose", sourcePaths: paths, debugPayload: "DO_NOT_ECHO_THIS_BODY".repeat(5_000), decompositions: [{ sourcePath: paths[0], summary: 123, units: [{ id: 1, type: "unknown", title: null, domain: "", aliases: null, points: [], evidence: [{ sourcePath: 1, sourceRevision: 5, quote: [] }] }, "old string"] }] });
        const badPlan = toolCall("knowledge_maintain", { stage: "plan", sourcePaths: paths, extra: "DO_NOT_ECHO_THIS_BODY".repeat(5_000), writingPlan: [{ id: "p1", targetPath: wiki, sourcePaths: paths, summary: "unknown extra", unitIds: ["source-0"], expectedTarget: { kind: "file" }, knowledge: { unitIds: [], decision: null } }] });
        const ordered = stages === "bad-decompose" ? [badDecompose] : stages === "bad-plan" ? [badPlan] : stages === "inspect" ? [inspect] : stages === "resume-only" ? [resume] : stages === "plan" ? [decomposition, plan] : stages === "resume" ? [resume, sections, maintenance] : [decomposition, plan, sections, maintenance];
        maintenanceCallId = ordered.at(-1)!.id;
        for (const stage of ordered) replies.push({ role: "assistant", content: null, tool_calls: [stage] });
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
