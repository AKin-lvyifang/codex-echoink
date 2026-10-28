import assert from "node:assert/strict";
import {
  PiChatUiProjector,
  piEntryIdFromProjectedMessageId,
  type PiSessionBranchEntryView
} from "../../harness/pi-native/pi-chat-ui-projector";
import type { PiChatRuntimeEvent } from "../../harness/pi-native/contracts";
import {
  appendOutputContinuationText,
  outputContinuationFromSessionEntry
} from "../../harness/pi-native/pi-output-continuation";

const piSessionId = "continuation-session";
const productRunId = "continuation-run";
const instant = "2026-10-28T00:00:00Z";
const assistant = (id: string, text: string, stopReason = "length"): PiSessionBranchEntryView => ({
  type: "message", id, parentId: null, timestamp: instant,
  message: { role: "assistant", content: [{ type: "text", text }], stopReason }
});
const continuation = (id: string, assistantEntryIds: string[], status = "completed"): PiSessionBranchEntryView => ({
  type: "custom", id, parentId: null, timestamp: instant,
  customType: "echoink.output-continuation.v1",
  data: { schemaVersion: 1, piSessionId, productRunId, assistantEntryIds, status }
});

export async function runOutputContinuationProjectionTests(): Promise<void> {
  const entries = [
    assistant("a1", "第一段。"), assistant("a2", "第一段。第二段。", "stop"),
    continuation("continuation", ["a1", "a2"]),
    { type: "custom", id: "saved", parentId: "continuation", timestamp: instant,
      customType: "echoink.answer-saved.v1",
      data: { schemaVersion: 1, piSessionId, assistantEntryId: "a2", path: "outputs/完整回答.md" } }
  ];
  const projector = new PiChatUiProjector();
  const cold = projector.projectSessionBranch({ piSessionId, activeLeafId: "saved", entries });
  const answers = cold.messages.filter(message => message.role === "assistant");
  assert.equal(answers.length, 1, "cold continuation is one answer, not one bubble per model request");
  assert.equal(answers[0].text, "第一段。第二段。", "copy/save consume the full projected answer");
  assert.equal(piEntryIdFromProjectedMessageId(answers[0].id), "a2", "derive/save anchor includes every preceding continuation entry");
  assert.equal(answers[0].savedNotePath, "outputs/完整回答.md");
  assert.equal(answers[0].itemType, "assistant");
  assert.equal(answers[0].status, "completed");
  assert.equal(answers[0].details, undefined);

  const base = { piSessionId, productRunId, conversationId: "continuation-conversation", activeLeafId: null, occurredAt: 1 };
  const event = (value: Record<string, unknown>) => ({ ...base, ...value }) as PiChatRuntimeEvent;
  let live = projector.projectRuntimeEvent({ current: projector.createEmpty({ piSessionId }),
    event: event({ type: "message_start", messageKey: "root", role: "assistant" }) });
  live = projector.projectRuntimeEvent({ current: live,
    event: event({ type: "message_end", messageKey: "root", role: "assistant", text: "第一段。", status: "failed", entryId: "a1" }) });
  const before = structuredClone(live);
  const original = live;
  live = projector.projectRuntimeEvent({ current: live,
    event: event({ type: "output_continuation", messageKey: "root", text: "第一段。第二段。", status: "running" }) });
  assert.deepEqual(original, before, "live projection never mutates its input view");
  assert.equal(live.messages.filter(message => message.role === "assistant").length, 1);
  assert.equal(live.messages[0].text, "第一段。第二段。");
  assert.equal(live.messages[0].itemType, "assistant");
  assert.equal(live.messages[0].title, undefined, "a resumed answer must drop the earlier failure title");
  live = projector.projectRuntimeEvent({ current: live,
    event: event({ type: "output_continuation", messageKey: "root", text: "第一段。第二段。", status: "completed", entryId: "a2" }) });
  assert.equal(piEntryIdFromProjectedMessageId(live.messages[0].id), "a2");
  assert.equal(live.messages[0].status, "completed");
  console.log("PASS output continuation: live/cold single answer, full text, final Entry anchor and saved receipt");
  await runOutputContinuationHelperTests();
  runContinuationDurableStateTests();
  runContinuationReconciliationTests();
  runKnowledgeVerificationProjectionTests();
}

export async function runOutputContinuationHelperTests(): Promise<void> {
  assert.deepEqual(appendOutputContinuationText("第一段。", "第一段。第二段。"), { text: "第一段。第二段。", addedCharacters: 4 });
  assert.deepEqual(appendOutputContinuationText("前文重复段后文", "重复段"), { text: "前文重复段后文", addedCharacters: 0 });
  assert.deepEqual(appendOutputContinuationText("abcXYZ", "XYZdef"), { text: "abcXYZdef", addedCharacters: 3 });
  assert.equal(appendOutputContinuationText("相似段甲", "相似段乙").text, "相似段甲相似段乙", "similar prose is never semantically deduplicated");
  assert.equal(appendOutputContinuationText("first\n\n", "\n\nsecond").text, "first\n\nsecond");
  assert.deepEqual(appendOutputContinuationText("正文", " \n\t"), { text: "正文", addedCharacters: 0 });
  assert.deepEqual(appendOutputContinuationText("正文", "正文 \n"), { text: "正文", addedCharacters: 0 });
  assert.deepEqual(appendOutputContinuationText("", "开头"), { text: "开头", addedCharacters: 2 });
  assert.equal(appendOutputContinuationText("abcab", "abc").text, "abcab", "a complete repeated segment wins over a shorter suffix match");
  const long = "a".repeat(300_000);
  const startedAt = performance.now();
  assert.deepEqual(appendOutputContinuationText(`${long}b`, `${long}c`), {
    text: `${long}b${long}c`, addedCharacters: long.length + 1
  });
  assert.equal(appendOutputContinuationText(long, `${long}b`).text, `${long}b`);
  assert.ok(performance.now() - startedAt < 3_000, "long repetitive segments must avoid quadratic overlap comparisons");
  const valid = continuation("valid", ["a1", "a2"]);
  const parsed = outputContinuationFromSessionEntry(valid, piSessionId)!;
  assert.equal(parsed.productRunId, productRunId);
  assert.ok(Object.isFrozen(parsed) && Object.isFrozen(parsed.assistantEntryIds));
  assert.notEqual(parsed.assistantEntryIds, (valid.data as { assistantEntryIds: string[] }).assistantEntryIds);
  assert.equal(outputContinuationFromSessionEntry(valid, "other-session"), null);
  for (const invalid of [null, [], {}, { ...valid, type: "message" },
    continuation("empty", []), continuation("duplicate", ["a1", "a1"]), continuation("bad-status", ["a1"], "unknown"),
    { ...valid, data: { ...(valid.data as object), schemaVersion: 2 } },
    { ...valid, data: { ...(valid.data as object), productRunId: " " } }]) {
    assert.equal(outputContinuationFromSessionEntry(invalid, piSessionId), null);
  }
  console.log("PASS continuation helper: exact duplicate/overlap, similar prose, whitespace, immutable parser and long repetitive segments");
}

function runContinuationDurableStateTests(): void {
  const projector = new PiChatUiProjector();
  const parts = [assistant("a1", "Alpha beta "), assistant("a2", "beta gamma "), assistant("a3", "gamma delta.", "stop")];
  const project = (entries: PiSessionBranchEntryView[], runState?: "running" | "failed" | "cancelled") => projector.projectSessionBranch({
    piSessionId, productRunId, activeLeafId: entries.at(-1)!.id, entries, runState
  });
  for (const status of ["running", "completed", "failed", "cancelled"] as const) {
    const projected = project([...parts, continuation("earlier", ["a1"], "failed"),
      continuation("current", ["a1", "a2", "a3"], status),
      continuation("invalid-newer", ["a1", "missing"], "completed")], status === "completed" ? undefined : status);
    const answer = projected.messages.find(message => message.role === "assistant")!;
    assert.equal(projected.messages.filter(message => message.role === "assistant").length, 1);
    assert.equal(answer.text, "Alpha beta gamma delta.");
    assert.equal(piEntryIdFromProjectedMessageId(answer.id), "a3");
    assert.equal(answer.status, status === "cancelled" ? "interrupted" : status);
    assert.equal(answer.itemType, status === "failed" || status === "cancelled" ? "error" : "assistant");
    assert.equal(answer.title, status === "failed" ? "回答未完成" : status === "cancelled" ? "回答已停止" : undefined);
    if (status === "running") assert.equal(answer.completedAt, undefined);
    if (status === "failed" || status === "cancelled") {
      assert.equal(projected.messages.filter(message => message.itemType === "error").length, 1, "the answer itself carries the terminal state without a second error card");
    }
  }
  const networkError = assistant("error", "", "error");
  const failed = project([parts[0], { ...networkError, message: { ...networkError.message!, errorMessage: "provider_auth_failed" } },
    continuation("failed", ["a1", "error"], "failed")], "failed").messages.find(message => message.role === "assistant")!;
  assert.equal(failed.text, "Alpha beta ");
  assert.equal(failed.title, "回答失败");
  assert.match(failed.details!, /API Key/u, "later provider failure retains the real reason beside the accumulated answer");
  assert.equal(project(parts.slice(0, 2)).messages.filter(message => message.role === "assistant").length, 2, "unmarked assistant entries are never folded");
  const foreign = continuation("foreign", ["a1", "a2"]);
  assert.equal(project([...parts.slice(0, 2), { ...foreign, data: { ...(foreign.data as object), piSessionId: "foreign" } }])
    .messages.filter(message => message.role === "assistant").length, 2);
  assert.equal(project([...parts.slice(0, 2), continuation("out-of-order", ["a2", "a1"])])
    .messages.filter(message => message.role === "assistant").length, 2);
  const other = continuation("other-record", ["b1", "b2"]);
  const multi = project([...parts, continuation("a-record", ["a1", "a2", "a3"]),
    assistant("b1", "另外一轮"), assistant("b2", "，继续。", "stop"),
    { ...other, data: { ...(other.data as object), productRunId: "other-run" } }]);
  assert.deepEqual(multi.messages.filter(message => message.role === "assistant").map(message => [message.runId, message.text]), [
    [productRunId, "Alpha beta gamma delta."], ["other-run", "另外一轮，继续。"]
  ]);
  console.log("PASS durable continuation: latest valid per-run marker, branch/session isolation, terminal states and real later provider failure");
}

function runContinuationReconciliationTests(): void {
  const projector = new PiChatUiProjector();
  const base = { piSessionId, productRunId, conversationId: "conversation", activeLeafId: null, occurredAt: 2 };
  const event = (value: Record<string, unknown>) => ({ ...base, ...value }) as PiChatRuntimeEvent;
  let live = projector.projectRuntimeEvent({ current: projector.createEmpty({ piSessionId }),
    event: event({ type: "output_continuation", messageKey: "root", text: "第一段。第二段。", status: "running" }) });
  const original = structuredClone(live);
  const entries = [assistant("a1", "第一段。"), continuation("running", ["a1"], "running")];
  live = projector.reconcileSessionBranch({ current: live, activeLeafId: "running", entries });
  assert.equal(live.messages.filter(message => message.role === "assistant").length, 1);
  assert.equal(live.messages[0].text, "第一段。第二段。", "readback retains a live continuation ahead of the persisted segment");
  assert.equal(piEntryIdFromProjectedMessageId(live.messages[0].id), "a1");
  assert.notDeepEqual(live.outputContinuationMessageIds, original.outputContinuationMessageIds, "aliases follow the durable re-scoped Entry");
  const snapshot = structuredClone(live);
  live = projector.reconcileSessionBranch({ current: live, activeLeafId: "running", entries });
  assert.deepEqual(live.messages, snapshot.messages, "repeated readback retains the accumulated live text");
  live = projector.projectRuntimeEvent({ current: live,
    event: event({ type: "output_continuation", messageKey: "root", text: "第一段。第二段。第三段。", status: "completed", entryId: "a3" }) });
  assert.equal(live.messages.length, 1);
  assert.equal(piEntryIdFromProjectedMessageId(live.messages[0].id), "a3");
  const finalEntries = [...entries, assistant("a2", "第二段。"), assistant("a3", "第三段。", "stop"), continuation("done", ["a1", "a2", "a3"])];
  const reconciled = projector.reconcileSessionBranch({ current: live, activeLeafId: "done", entries: finalEntries });
  assert.equal(reconciled.messages.length, 1);
  assert.equal(reconciled.messages[0].text, "第一段。第二段。第三段。");
  assert.deepEqual(reconciled.provisionalMessageIds, []);
  assert.equal(piEntryIdFromProjectedMessageId(reconciled.messages[0].id), "a3");
  const reemitted = projector.projectRuntimeEvent({ current: reconciled,
    event: event({ type: "output_continuation", messageKey: "root", text: reconciled.messages[0].text, status: "completed", entryId: "a3" }) });
  assert.deepEqual(reemitted.provisionalMessageIds, [], "a final event after durable readback must not reintroduce provisional entries");
  const failed = projector.projectRuntimeEvent({ current: reconciled,
    event: event({ type: "output_continuation", messageKey: "root", text: reconciled.messages[0].text, status: "failed", entryId: "a3" }) });
  assert.equal(failed.messages[0].title, "回答未完成");
  const stopped = projector.projectRuntimeEvent({ current: failed,
    event: event({ type: "output_continuation", messageKey: "root", text: "", status: "cancelled", entryId: "a3" }) });
  assert.equal(stopped.messages[0].text, reconciled.messages[0].text);
  assert.equal(stopped.messages[0].status, "interrupted");
  assert.equal(reconciled.messages[0].status, "completed", "clone does not mutate an earlier settled projection");
  assert.notEqual(stopped.outputContinuationMessageIds, failed.outputContinuationMessageIds, "clone owns its live aliases");
  const changed = projector.projectRuntimeEvent({ current: stopped,
    event: event({ type: "branch_changed", activeLeafId: "other-branch", previousLeafId: "done" }) });
  assert.equal(changed.outputContinuationMessageIds, undefined, "a branch change drops the previous branch's live aliases");
  console.log("PASS continuation events/reconcile: provisional and resolved roots, readback lag, immutable aliases, final re-anchor, failure and cancellation");
}

function runKnowledgeVerificationProjectionTests(): void {
  const skipped: PiSessionBranchEntryView = { type: "custom", id: "verification", parentId: null, timestamp: instant,
    customType: "echoink.knowledge-verification.v1",
    data: { schemaVersion: 1, piSessionId, productRunId, assistantEntryId: "a1", reason: "knowledge_permission_revoked", referenceIds: ["ref"] } };
  const entries = [assistant("a1", "第一段。"), assistant("a2", "第二段。", "stop"),
    continuation("combined", ["a1", "a2"]), skipped];
  const projector = new PiChatUiProjector();
  const cold = projector.projectSessionBranch({ piSessionId, activeLeafId: "verification", entries });
  assert.equal(cold.messages.length, 1, "verification outcome is attached to the answer instead of a new card");
  assert.equal(cold.messages[0].text, "第一段。第二段。", "UI explanation never enters copy/save body text");
  assert.equal(cold.messages[0].knowledgeVerificationSkipped, "knowledge_permission_revoked");
  const references = [{ referenceId: "ref", vaultRelativePath: "wiki/source.md", title: "来源", excerpt: "已读正文", contentRevision: "r1",
    lineStart: 1, lineEnd: 1, verificationStatus: "local_revision_verified" as const }];
  const decorated = projector.decorate(cold, [{ entryId: "a2", knowledgeReferences: references }]);
  assert.equal(decorated.messages[0].knowledgeReferences?.[0].verificationStatus, "local_revision_verified", "permission revocation does not rewrite the prior read's verification status");
  const cloned = projector.projectRuntimeEvent({ current: decorated, event: {
    type: "queue_update", piSessionId, productRunId, conversationId: "conversation", activeLeafId: "verification", occurredAt: 3, steering: [], followUp: []
  } });
  assert.equal(cloned.messages[0].knowledgeVerificationSkipped, "knowledge_permission_revoked");
  const foreign = projector.projectSessionBranch({ piSessionId, activeLeafId: "foreign", entries: [...entries.slice(0, -1),
    { ...skipped, data: { ...(skipped.data as object), piSessionId: "foreign" } }] });
  assert.equal(foreign.messages[0].knowledgeVerificationSkipped, undefined);
  console.log("PASS knowledge verification projection: cold durable explanation, combined answer, clean body and unchanged read verification status");
}
