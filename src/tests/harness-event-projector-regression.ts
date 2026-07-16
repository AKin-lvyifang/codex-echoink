import * as assert from "node:assert/strict";
import type { HarnessEvent } from "../harness/contracts/event";
import type { ChatMessage } from "../settings/settings";
import {
  HarnessEventProjector,
  applyHarnessProjectionBatch
} from "../ui/codex-view/harness-event-projector";
import { buildAgentTurnProjection } from "../ui/codex-view/agent-turn-process";
import { LatestByKeyFrameBatcher, isDirectProcessVirtualRow, terminalAnswerFooterMessageIds } from "../ui/codex-view/message-list";

runHarnessEventProjectorRegressionTests();

export function runHarnessEventProjectorRegressionTests(): void {
  testSequenceOrderingAndReasoningBoundaries();
  testSameNameToolCallsStayCorrelated();
  testMissingToolIdsNeverGuessAnActiveCall();
  testEmptyChannelsAndTerminalFallbackStatuses();
  testCommandKindsAndSparseToolUpdatesPreserveCodexSemantics();
  testStructuredToolPathOverridesAmbiguousPreview();
  testStableAnswerAndIncrementalUpsert();
  testReplayDeduplicationAcrossSequences();
  testAnswerToolAnswerKeepsWireOrder();
  testFailedAndCancelledSettlementPreserveWireOrder();
  testUsageSnapshotStaysOnFinalAnswer();
  testRepeatedReasoningBlockSplitsAtCompletionOnlyTool();
  testPlanToolWithoutCompletionStaysUnconfirmed();
  testCanonicalStreamIsBackendAgnostic();
  testHundredDeltasKeepStableRowsAndHonorReplace();
  testFrameBatcherCoalescesHundredUpdates();
  testDirectProcessVirtualRowGuard();
}

function testSequenceOrderingAndReasoningBoundaries(): void {
  const answer = createAnswer("run-boundary");
  const projector = createProjector(answer);

  assert.deepEqual(projector.project(event("run-boundary", 2, "tool.requested", {
    toolName: "memory",
    data: {
      callId: "call-memory",
      toolCallId: "call-memory",
      semanticKind: "tool",
      toolStatus: "requested",
      inputState: "unavailable",
      outputState: "unavailable",
      displayPreview: "Memory manage (memory)"
    }
  })).acceptedSequences, [], "future events must wait for the missing sequence");

  const ordered = projector.project(event("run-boundary", 1, "agent.reasoning.summary.delta", {
    text: "先检查记忆。",
    data: { blockId: "reasoning-a", reasoningKind: "summary", visibility: "public" }
  }));
  assert.deepEqual(ordered.acceptedSequences, [1, 2]);

  projector.project(event("run-boundary", 3, "tool.completed", {
    toolName: "memory",
    data: {
      callId: "call-memory",
      toolCallId: "call-memory",
      semanticKind: "tool",
      toolStatus: "completed",
      outputState: "provided",
      output: "Memory saved"
    }
  }));
  projector.project(event("run-boundary", 4, "agent.reasoning.summary.delta", {
    text: "再确认最终答复。",
    data: { blockId: "reasoning-b", reasoningKind: "summary", visibility: "public" }
  }));
  projector.project(event("run-boundary", 5, "agent.message.delta", {
    text: "已记住",
    data: { messageId: "answer-provider-1" }
  }));
  projector.project(event("run-boundary", 6, "run.completed", { text: "已记住" }));

  const process = projector.snapshot().filter((message) => message.id !== answer.id);
  assert.deepEqual(process.map((message) => message.itemType), ["reasoning", "dynamicToolCall", "reasoning"]);
  assert.deepEqual(process.map((message) => message.status), ["completed", "completed", "completed"]);
  assert.match(process[0].id, /reasoning-a$/);
  assert.match(process[1].id, /call-memory$/);
  assert.match(process[2].id, /reasoning-b$/);
  assert.equal(process[1].text, "Memory saved");
  assert.equal(process[1].processInputAvailability, "unavailable");
  assert.equal(process[1].processOutputAvailability, "provided");
  assert.equal(process[1].processOutput, "Memory saved");
  assert.equal(answer.text, "Agent 正在处理...", "projector must not mutate its input object before applying a batch");
  assert.equal(projector.snapshot().at(-1)?.text, "已记住");
}

function testSameNameToolCallsStayCorrelated(): void {
  const answer = createAnswer("run-parallel");
  const projector = createProjector(answer);

  projector.project(event("run-parallel", 1, "tool.requested", {
    toolName: "read_file",
    data: { callId: "read-a", semanticKind: "read", inputState: "provided", input: { path: "testing/a.md" } }
  }));
  projector.project(event("run-parallel", 2, "tool.requested", {
    toolName: "read_file",
    data: { callId: "read-b", semanticKind: "read", inputState: "provided", input: { path: "testing/b.md" } }
  }));
  projector.project(event("run-parallel", 3, "tool.completed", {
    toolName: "read_file",
    data: { callId: "read-b", semanticKind: "read", toolStatus: "completed", outputState: "provided", output: "B" }
  }));
  projector.project(event("run-parallel", 4, "tool.output.delta", {
    toolName: "read_file",
    text: "A",
    data: { callId: "read-a", semanticKind: "read", toolStatus: "running" }
  }));
  projector.project(event("run-parallel", 5, "tool.completed", {
    toolName: "read_file",
    data: { callId: "read-a", semanticKind: "read", toolStatus: "completed", outputState: "provided", output: "A done" }
  }));

  const tools = projector.snapshot().filter((message) => message.role === "tool");
  assert.equal(tools.length, 2);
  assert.equal(tools.find((message) => message.id.endsWith("read-a"))?.text, "A done");
  assert.equal(tools.find((message) => message.id.endsWith("read-b"))?.text, "B");
}

function testMissingToolIdsNeverGuessAnActiveCall(): void {
  const answer = createAnswer("run-missing-tool-id");
  const projector = createProjector(answer);

  projector.project(event("run-missing-tool-id", 1, "tool.requested", {
    toolName: "read_file",
    data: { semanticKind: "read", toolStatus: "requested", inputState: "provided", input: { path: "testing/a.md" } }
  }));
  projector.project(event("run-missing-tool-id", 2, "tool.completed", {
    toolName: "read_file",
    data: { semanticKind: "read", toolStatus: "completed", outputState: "provided", output: "A" }
  }));
  projector.project(event("run-missing-tool-id", 3, "run.completed", { text: "done" }));

  const tools = projector.snapshot().filter((message) => message.role === "tool");
  assert.equal(tools.length, 2, "a terminal update without callId must not be guessed onto the only active tool");
  assert.equal(tools[0]?.status, "unconfirmed");
  assert.equal(tools[1]?.status, "completed");
  assert.notEqual(tools[0]?.id, tools[1]?.id);
}

function testEmptyChannelsAndTerminalFallbackStatuses(): void {
  const completedAnswer = createAnswer("run-unconfirmed");
  const completed = createProjector(completedAnswer);
  completed.project(event("run-unconfirmed", 1, "tool.requested", {
    toolName: "memory",
    data: {
      callId: "empty-tool",
      semanticKind: "tool",
      inputState: "empty",
      outputState: "unavailable",
      input: {},
      displayPreview: "Memory manage (memory)"
    }
  }));
  completed.project(event("run-unconfirmed", 2, "run.completed", { text: "done" }));
  const unconfirmed = completed.snapshot().find((message) => message.id.endsWith("empty-tool"));
  assert.equal(unconfirmed?.status, "unconfirmed");
  assert.equal(unconfirmed?.text, "");
  assert.equal(unconfirmed?.details, "Memory manage (memory)");
  assert.equal(unconfirmed?.processContentAvailability, "unavailable");
  assert.equal(unconfirmed?.processInputAvailability, "empty");
  assert.equal(unconfirmed?.processOutputAvailability, "unavailable");
  assert.equal(unconfirmed?.processInput, undefined);
  assert.equal(unconfirmed?.processOutput, undefined);
  assert.doesNotMatch(JSON.stringify(unconfirmed), /2 B/);
  assert.notEqual(unconfirmed?.text, "{}");

  const failedAnswer = createAnswer("run-interrupted");
  const failed = createProjector(failedAnswer);
  failed.project(event("run-interrupted", 1, "tool.started", {
    toolName: "search",
    data: { callId: "unfinished-search", semanticKind: "search", toolStatus: "running" }
  }));
  failed.project(event("run-interrupted", 2, "run.failed", { error: "provider disconnected" }));
  assert.equal(failed.snapshot().find((message) => message.id.endsWith("unfinished-search"))?.status, "interrupted");
}

function testCommandKindsAndSparseToolUpdatesPreserveCodexSemantics(): void {
  const answer = createAnswer("run-tool-semantics");
  const projector = createProjector(answer);

  projector.project(event("run-tool-semantics", 1, "tool.started", {
    toolName: "rg marker testing/a.md",
    data: {
      callId: "search-command",
      semanticKind: "command",
      toolStatus: "running",
      inputState: "provided",
      input: { command: "rg marker testing/a.md" },
      outputState: "unavailable"
    }
  }));
  const command = projector.snapshot().find((message) => message.id.endsWith("search-command"));
  assert.equal(command?.processKind, "search", "Codex command items must retain search/view/run presentation semantics");

  projector.project(event("run-tool-semantics", 2, "file.change.proposed", {
    toolName: "文件改动",
    data: {
      callId: "sparse-diff",
      semanticKind: "edit",
      toolStatus: "running",
      changes: [{ path: "testing/a.md", diff: "@@ -1 +1 @@\n-old\n+new" }]
    }
  }));
  projector.project(event("run-tool-semantics", 3, "file.change.applied", {
    toolName: "文件改动",
    data: { callId: "sparse-diff", semanticKind: "edit", toolStatus: "completed" }
  }));
  const edit = projector.snapshot().find((message) => message.id.endsWith("sparse-diff"));
  assert.equal(edit?.diffSummary?.files[0]?.path, "testing/a.md", "a sparse terminal update must not erase the start event diff");
  assert.match(edit?.processOutput ?? "", /old/);

  projector.project(event("run-tool-semantics", 4, "tool.started", {
    toolName: "external_tool",
    data: { callId: "failed-tool", semanticKind: "tool", toolStatus: "running" }
  }));
  projector.project(event("run-tool-semantics", 5, "tool.failed", {
    toolName: "external_tool",
    error: "permission denied",
    data: { callId: "failed-tool", semanticKind: "tool", toolStatus: "failed" }
  }));
  const failed = projector.snapshot().find((message) => message.id.endsWith("failed-tool"));
  assert.equal(failed?.status, "failed");
  assert.equal(failed?.processOutput, "permission denied", "tool failures must expose the provider error instead of a generic failed state");
}

function testStructuredToolPathOverridesAmbiguousPreview(): void {
  const answer = createAnswer("run-structured-path", "opencode");
  const projector = new HarnessEventProjector({
    runId: answer.runId ?? "",
    backendId: "opencode",
    vaultPath: "/tmp/echoink-vault",
    answerMessage: answer
  });
  const absolutePath = "/tmp/echoink-vault/testing/echoink-ui-check.md";

  projector.project(event("run-structured-path", 1, "tool.completed", {
    backendId: "opencode",
    toolName: "read",
    data: {
      callId: "read-absolute-vault-path",
      semanticKind: "read",
      toolStatus: "completed",
      inputState: "provided",
      input: { filePath: absolutePath },
      outputState: "provided",
      output: `<path>${absolutePath}</path>`,
      displayPreview: "tmp/echoink-vault/testing/echoink-ui-check.md"
    }
  }));

  const tool = projector.snapshot().find((message) => message.id.endsWith("read-absolute-vault-path"));
  assert.deepEqual(tool?.files, [{
    name: "echoink-ui-check.md",
    path: "testing/echoink-ui-check.md",
    displayPath: "testing/echoink-ui-check.md",
    kind: "vault",
    openable: true,
    absolutePath
  }], "structured absolute paths inside the Vault must win over a provider preview missing its leading slash");
}

function testStableAnswerAndIncrementalUpsert(): void {
  const answer = createAnswer("run-upsert");
  const projector = createProjector(answer);
  const sessionMessages: ChatMessage[] = [
    { id: "user", role: "user", text: "hello", runId: "run-upsert", createdAt: 1 },
    answer
  ];

  applyHarnessProjectionBatch(sessionMessages, projector.project(event("run-upsert", 1, "agent.reasoning.summary.delta", {
    text: "one",
    data: { blockId: "stable-reasoning", visibility: "public" }
  })), answer.id);
  const reasoning = sessionMessages.find((message) => message.itemType === "reasoning");
  assert.ok(reasoning);

  applyHarnessProjectionBatch(sessionMessages, projector.project(event("run-upsert", 2, "agent.reasoning.summary.delta", {
    text: " two",
    data: { blockId: "stable-reasoning", visibility: "public" }
  })), answer.id);
  assert.equal(sessionMessages.find((message) => message.itemType === "reasoning"), reasoning);
  assert.equal(reasoning.text, "one two");
  assert.equal(sessionMessages.filter((message) => message.itemType === "reasoning").length, 1);

  applyHarnessProjectionBatch(sessionMessages, projector.project(event("run-upsert", 3, "agent.message.delta", {
    text: "Hel",
    data: { messageId: "provider-answer" }
  })), answer.id);
  applyHarnessProjectionBatch(sessionMessages, projector.project(event("run-upsert", 4, "agent.message.delta", {
    text: "lo",
    data: { messageId: "provider-answer" }
  })), answer.id);
  applyHarnessProjectionBatch(sessionMessages, projector.project(event("run-upsert", 5, "agent.message.completed", {
    text: "Hello",
    data: { messageId: "provider-answer" }
  })), answer.id);

  assert.equal(sessionMessages.find((message) => message.id === answer.id), answer);
  assert.equal(answer.text, "Hello");
  assert.equal(sessionMessages.filter((message) => message.id === answer.id).length, 1);
  assert.equal(answer.status, "running", "provider message completion must wait for the Harness run terminal");
  assert.equal(answer.completedAt, undefined, "provider message completion must not publish terminal footer time early");
  assert.equal(terminalAnswerFooterMessageIds(sessionMessages).has(answer.id), false, "the answer footer must stay hidden while the run can still emit tools or reasoning");
  assert.equal(buildAgentTurnProjection(sessionMessages).some((item) => item.kind === "completedProcess"), false, "the turn process must not fold before the run terminal");

  applyHarnessProjectionBatch(sessionMessages, projector.project(event("run-upsert", 6, "run.completed", {
    text: "Hello"
  })), answer.id);
  assert.equal(answer.status, "completed");
  assert.equal(answer.completedAt, 1_006);
  assert.equal(terminalAnswerFooterMessageIds(sessionMessages).has(answer.id), true);
  assert.equal(buildAgentTurnProjection(sessionMessages).some((item) => item.kind === "completedProcess"), true);
}

function testReplayDeduplicationAcrossSequences(): void {
  const answer = createAnswer("run-replay");
  const projector = createProjector(answer);

  const replay = event("run-replay", 3, "agent.message.delta", {
    eventId: "provider-event-answer-a",
    text: "A",
    data: { messageId: "answer-a" }
  });
  assert.deepEqual(projector.project(replay).acceptedSequences, []);
  assert.deepEqual(projector.project(event("run-replay", 1, "agent.message.delta", {
    eventId: "provider-event-answer-a",
    text: "A",
    data: { messageId: "answer-a" }
  })).acceptedSequences, [1]);
  const drained = projector.project(event("run-replay", 2, "agent.message.delta", {
    eventId: "provider-event-answer-b",
    text: "B",
    data: { messageId: "answer-a" }
  }));

  assert.deepEqual(drained.acceptedSequences, [2, 3], "replayed sequences must still drain the ordering buffer");
  assert.equal(projector.snapshot().at(-1)?.text, "AB", "same eventId at a new sequence must not append twice");
}

function testAnswerToolAnswerKeepsWireOrder(): void {
  const answer = createAnswer("run-answer-tool-answer");
  const projector = createProjector(answer);
  const sessionMessages: ChatMessage[] = [
    { id: "user-interleave", role: "user", text: "hello", runId: "run-answer-tool-answer", createdAt: 1 },
    answer
  ];
  const apply = (sequence: number, type: HarnessEvent["type"], patch: Partial<HarnessEvent>) => {
    applyHarnessProjectionBatch(
      sessionMessages,
      projector.project(event("run-answer-tool-answer", sequence, type, patch)),
      answer.id
    );
  };

  apply(1, "agent.message.completed", { text: "先说明。", data: { messageId: "answer-before" } });
  const canonicalAnswer = answer;
  assert.equal(answer.status, "running");
  assert.equal(answer.completedAt, undefined);
  apply(2, "tool.started", {
    toolName: "read_file",
    data: { callId: "call-between", semanticKind: "read", toolStatus: "running", inputState: "provided", input: { path: "testing/a.md" } }
  });
  assert.equal(answer.completedAt, undefined, "a tool after provider message completion must not settle the canonical answer before a new segment exists");
  answer.details = "stale answer detail";
  answer.rawRef = ".echoink/raw/stale-answer.md";
  answer.rawSize = 99;
  apply(3, "tool.completed", {
    toolName: "read_file",
    data: { callId: "call-between", semanticKind: "read", toolStatus: "completed", outputState: "provided", output: "A" }
  });
  apply(4, "agent.message.delta", { text: "再回答", data: { messageId: "answer-after" } });

  assert.equal(answer.completedAt, undefined, "reusing the canonical answer row must clear the previous segment completion time");
  assert.equal(answer.details, undefined, "reusing the canonical answer row must clear stale projected details");
  assert.equal(answer.rawRef, undefined, "reusing the canonical answer row must clear stale raw references");
  assert.equal(answer.rawSize, undefined, "reusing the canonical answer row must clear stale raw metadata");

  const firstAnswer = sessionMessages.find((message) => message.id.endsWith("answer-before"));
  const tool = sessionMessages.find((message) => message.id.endsWith("call-between"));
  assert.ok(firstAnswer && tool);
  assert.equal(firstAnswer.status, "completed", "demoting a provider-completed canonical answer must settle only the historical segment");
  assert.equal(firstAnswer.completedAt, 1_004);
  assert.deepEqual(
    sessionMessages.filter((message) => message.runId === "run-answer-tool-answer" && message.role !== "user").map((message) => message.itemType),
    ["assistant", "dynamicToolCall", "assistant"]
  );
  assert.equal(sessionMessages.indexOf(firstAnswer) < sessionMessages.indexOf(tool), true);
  assert.equal(sessionMessages.indexOf(tool) < sessionMessages.indexOf(answer), true);
  assert.equal(answer, canonicalAnswer, "the original answer object must remain the final answer target");

  apply(5, "agent.message.delta", { text: "完毕", data: { messageId: "answer-after" } });
  assert.equal(sessionMessages.find((message) => message.id.endsWith("answer-before")), firstAnswer);
  assert.equal(answer.text, "再回答完毕");
  assert.equal(sessionMessages.filter((message) => message.id.endsWith("answer-before")).length, 1);

  applyHarnessProjectionBatch(
    sessionMessages,
    projector.project(event("run-answer-tool-answer", 6, "run.completed", { text: "先说明。\n\n再回答完毕" })),
    answer.id
  );
  assert.equal(answer.text, "再回答完毕", "an aggregate terminal payload must not duplicate an earlier interleaved answer segment");
}

function testFailedAndCancelledSettlementPreserveWireOrder(): void {
  for (const terminal of [
    { runId: "run-answer-tool-failed", type: "run.failed" as const, expectedStatus: "failed", expectedText: "Agent 执行失败" },
    { runId: "run-answer-tool-cancelled", type: "run.cancelled" as const, expectedStatus: "interrupted", expectedText: "已停止生成" }
  ]) {
    const answer = createAnswer(terminal.runId);
    const stableAnswer = answer;
    const projector = createProjector(answer);
    const sessionMessages: ChatMessage[] = [
      { id: `user:${terminal.runId}`, role: "user", text: "hello", runId: terminal.runId, createdAt: 1 },
      answer
    ];
    const apply = (sequence: number, type: HarnessEvent["type"], patch: Partial<HarnessEvent>) => {
      applyHarnessProjectionBatch(sessionMessages, projector.project(event(terminal.runId, sequence, type, patch)), answer.id);
    };

    apply(1, "agent.message.completed", { text: "先说明。", data: { messageId: "answer-before" } });
    apply(2, "tool.started", {
      toolName: "read_file",
      data: { callId: "tool-after-answer", semanticKind: "read", toolStatus: "running" }
    });
    apply(3, terminal.type, {});

    const runMessages = sessionMessages.filter((message) => message.runId === terminal.runId && message.role !== "user");
    assert.deepEqual(runMessages.map((message) => message.itemType), ["assistant", "dynamicToolCall", "error"]);
    const historical = runMessages[0];
    const tool = runMessages[1];
    const finalAnswer = runMessages[2];
    assert.match(historical.id, /inline-answer:.*answer-before$/);
    assert.equal(historical.text, "先说明。");
    assert.equal(historical.status, "completed");
    assert.equal(tool.status, "interrupted");
    assert.equal(finalAnswer, stableAnswer, "terminal settlement must retain the stable answer object identity");
    assert.equal(finalAnswer.id, `answer:${terminal.runId}`);
    assert.equal(finalAnswer.status, terminal.expectedStatus);
    assert.equal(finalAnswer.text, terminal.expectedText, "a missing terminal error must not duplicate the preserved prelude");
    assert.equal(sessionMessages.indexOf(historical) < sessionMessages.indexOf(tool), true);
    assert.equal(sessionMessages.indexOf(tool) < sessionMessages.indexOf(finalAnswer), true);
  }

  const runId = "run-empty-answer-tool-cancelled";
  const answer = createAnswer(runId);
  const projector = createProjector(answer);
  const sessionMessages: ChatMessage[] = [
    { id: `user:${runId}`, role: "user", text: "hello", runId, createdAt: 1 },
    answer
  ];
  const apply = (sequence: number, type: HarnessEvent["type"], patch: Partial<HarnessEvent>) => {
    applyHarnessProjectionBatch(sessionMessages, projector.project(event(runId, sequence, type, patch)), answer.id);
  };
  apply(1, "agent.message.completed", { text: " \n ", data: { messageId: "empty-answer" } });
  apply(2, "tool.started", { toolName: "read_file", data: { callId: "tool-after-empty", semanticKind: "read", toolStatus: "running" } });
  apply(3, "run.cancelled", {});
  const runMessages = sessionMessages.filter((message) => message.runId === runId && message.role !== "user");
  assert.deepEqual(runMessages.map((message) => message.itemType), ["dynamicToolCall", "error"], "an empty pre-tool answer must not leave a blank historical row");
  assert.equal(runMessages.at(-1), answer);
  assert.equal(answer.text, "已停止生成");
}

function testUsageSnapshotStaysOnFinalAnswer(): void {
  const answer = createAnswer("run-usage-final", "opencode");
  const projector = createProjector(answer);
  const sessionMessages: ChatMessage[] = [
    { id: "user-usage-final", role: "user", text: "hello", runId: "run-usage-final", createdAt: 1 },
    answer
  ];
  const apply = (sequence: number, type: HarnessEvent["type"], patch: Partial<HarnessEvent>) => {
    applyHarnessProjectionBatch(
      sessionMessages,
      projector.project(event("run-usage-final", sequence, type, patch)),
      answer.id
    );
  };

  apply(1, "agent.message.delta", { text: "先说明。", data: { messageId: "answer-before" } });
  apply(2, "usage.updated", {
    data: { usage: { totalTokens: 11, inputTokens: 8, outputTokens: 3 } }
  });
  apply(3, "tool.started", {
    toolName: "read_file",
    data: { callId: "usage-read", semanticKind: "read", toolStatus: "running" }
  });
  apply(4, "tool.completed", {
    toolName: "read_file",
    data: { callId: "usage-read", semanticKind: "read", toolStatus: "completed", outputState: "provided", output: "A" }
  });
  apply(5, "agent.message.delta", { text: "最终回答。", data: { messageId: "answer-final" } });
  apply(6, "usage.updated", {
    data: { usage: { totalTokens: 22, inputTokens: 15, outputTokens: 7 } }
  });
  apply(7, "run.completed", { text: "先说明。\n\n最终回答。" });

  const prelude = sessionMessages.find((message) => message.id.endsWith("answer-before"));
  assert.ok(prelude);
  assert.equal(prelude.runUsage, undefined, "interleaved answer preludes must not receive the run footer snapshot");
  assert.deepEqual(answer.runUsage, { totalTokens: 22, inputTokens: 15, outputTokens: 7 }, "the latest provider snapshot must be frozen on the final answer");

  const lateUsageBatch = projector.project(event("run-usage-final", 8, "usage.updated", {
    data: { usage: { total_tokens: 31, input_tokens: 21, output_tokens: 10 } }
  }));
  assert.deepEqual(lateUsageBatch.updates.map((message) => message.id), [answer.id], "usage arriving after the terminal must update the completed answer in place");
  assert.deepEqual(lateUsageBatch.updates[0]?.runUsage, { totalTokens: 31, inputTokens: 21, outputTokens: 10 });
  applyHarnessProjectionBatch(sessionMessages, lateUsageBatch, answer.id);
  assert.deepEqual(answer.runUsage, { totalTokens: 31, inputTokens: 21, outputTokens: 10 }, "late provider usage must replace the provisional terminal snapshot");

  const laterAnswer = createAnswer("run-usage-later", "hermes");
  const laterProjector = createProjector(laterAnswer);
  applyHarnessProjectionBatch([laterAnswer], laterProjector.project(event("run-usage-later", 1, "usage.updated", {
    data: { usage: { totalTokens: 99, inputTokens: 70, outputTokens: 29 } }
  })), laterAnswer.id);
  applyHarnessProjectionBatch([laterAnswer], laterProjector.project(event("run-usage-later", 2, "run.completed", { text: "later" })), laterAnswer.id);
  assert.equal(answer.runUsage?.totalTokens, 31, "a later run must not mutate an earlier answer snapshot");
}

function testRepeatedReasoningBlockSplitsAtCompletionOnlyTool(): void {
  const answer = createAnswer("run-repeated-reasoning");
  const projector = createProjector(answer);
  projector.project(event("run-repeated-reasoning", 1, "agent.thinking.delta", {
    text: "工具前。",
    data: { blockId: "provider-reasoning", visibility: "public" }
  }));
  projector.project(event("run-repeated-reasoning", 2, "tool.completed", {
    toolName: "memory",
    data: { callId: "completion-only", semanticKind: "tool", toolStatus: "completed", outputState: "provided", output: "done" }
  }));
  projector.project(event("run-repeated-reasoning", 3, "agent.thinking.delta", {
    text: "工具后。",
    data: { blockId: "provider-reasoning", visibility: "public" }
  }));

  const rows = projector.snapshot().filter((message) => message.id !== answer.id);
  assert.deepEqual(rows.map((message) => message.itemType), ["reasoning", "dynamicToolCall", "reasoning"]);
  assert.deepEqual(rows.filter((message) => message.itemType === "reasoning").map((message) => message.text), ["工具前。", "工具后。"]) ;
  assert.notEqual(rows[0].id, rows[2].id, "a provider blockId reused after a tool boundary must create a new UI segment");
}

function testPlanToolWithoutCompletionStaysUnconfirmed(): void {
  const answer = createAnswer("run-plan-tool");
  const projector = createProjector(answer);
  projector.project(event("run-plan-tool", 1, "tool.requested", {
    toolName: "todowrite",
    data: { callId: "todo-call", semanticKind: "plan", toolStatus: "requested", inputState: "provided", input: [{ content: "check" }] }
  }));
  projector.project(event("run-plan-tool", 2, "run.completed", { text: "done" }));

  const tool = projector.snapshot().find((message) => message.id.endsWith("todo-call"));
  assert.equal(tool?.role, "assistant", "plan tools keep the Codex plan presentation role");
  assert.equal(tool?.status, "unconfirmed", "presentation role must not make an unfinished tool look completed");
}

function testCanonicalStreamIsBackendAgnostic(): void {
  const backendIds = ["codex-cli", "hermes", "opencode"] as const;
  const projections = backendIds.map((backendId) => {
    const answer = createAnswer("run-golden", backendId);
    const projector = createProjector(answer);
    const canonicalEvents: Array<[HarnessEvent["type"], Partial<HarnessEvent>]> = [
      ["agent.reasoning.summary.delta", {
        text: "先读取测试文件。",
        data: { blockId: "reasoning-1", reasoningKind: "provider", visibility: "public" }
      }],
      ["tool.requested", {
        toolName: "read_file",
        data: {
          callId: "call-read",
          semanticKind: "read",
          toolStatus: "requested",
          inputState: "provided",
          input: { path: "testing/a.md" },
          outputState: "unavailable"
        }
      }],
      ["tool.completed", {
        toolName: "read_file",
        data: {
          callId: "call-read",
          semanticKind: "read",
          toolStatus: "completed",
          outputState: "provided",
          output: "A"
        }
      }],
      ["agent.reasoning.summary.delta", {
        text: "再整理回答。",
        data: { blockId: "reasoning-2", reasoningKind: "provider", visibility: "public" }
      }],
      ["agent.message.delta", { text: "完成", data: { messageId: "answer-1" } }],
      ["usage.updated", { data: { usage: { totalTokens: 15, inputTokens: 10, outputTokens: 5 } } }],
      ["run.completed", { text: "完成" }]
    ];
    canonicalEvents.forEach(([type, patch], index) => {
      projector.project(event("run-golden", index + 1, type, { ...patch, backendId }));
    });
    return projector.snapshot().map((message) => {
      const normalized = { ...message };
      delete normalized.backendId;
      if (normalized.itemType === "assistant") delete normalized.title;
      return normalized;
    });
  });

  assert.deepEqual(projections[1], projections[0]);
  assert.deepEqual(projections[2], projections[0]);
  assert.deepEqual(projections[0].map((message) => message.itemType), ["reasoning", "dynamicToolCall", "reasoning", "assistant"]);
}

function testHundredDeltasKeepStableRowsAndHonorReplace(): void {
  const answer = createAnswer("run-100-deltas", "opencode");
  const projector = createProjector(answer);
  const sessionMessages: ChatMessage[] = [
    { id: "user-100", role: "user", text: "hello", runId: "run-100-deltas", createdAt: 1 },
    answer
  ];
  let reasoning: ChatMessage | undefined;
  for (let sequence = 1; sequence <= 100; sequence += 1) {
    applyHarnessProjectionBatch(sessionMessages, projector.project(event("run-100-deltas", sequence, "agent.thinking.delta", {
      backendId: "opencode",
      text: "x",
      data: { blockId: "stable-100", reasoningKind: "provider", visibility: "public" }
    })), answer.id);
    const current = sessionMessages.find((message) => message.itemType === "reasoning");
    reasoning ??= current;
    assert.equal(current, reasoning);
    assert.equal(sessionMessages.length, 3);
  }
  const rowIds = sessionMessages.map((message) => message.id);
  assert.equal(reasoning?.text.length, 100);

  applyHarnessProjectionBatch(sessionMessages, projector.project(event("run-100-deltas", 101, "agent.thinking.delta", {
    backendId: "opencode",
    text: "provider replacement",
    data: { blockId: "stable-100", reasoningKind: "provider", visibility: "public", replace: true }
  })), answer.id);
  assert.equal(reasoning?.text, "provider replacement");
  assert.deepEqual(sessionMessages.map((message) => message.id), rowIds);

  applyHarnessProjectionBatch(sessionMessages, projector.project(event("run-100-deltas", 102, "agent.message.delta", {
    backendId: "opencode",
    text: "old answer",
    data: { messageId: "stable-answer" }
  })), answer.id);
  applyHarnessProjectionBatch(sessionMessages, projector.project(event("run-100-deltas", 103, "agent.message.delta", {
    backendId: "opencode",
    text: "new answer",
    data: { messageId: "stable-answer", replace: true }
  })), answer.id);
  assert.equal(answer.text, "new answer");
  assert.equal(sessionMessages.find((message) => message.id === answer.id), answer);
  assert.deepEqual(sessionMessages.map((message) => message.id), rowIds);
}

function testFrameBatcherCoalescesHundredUpdates(): void {
  const batcher = new LatestByKeyFrameBatcher<number>();
  const frames: Array<() => void> = [];
  const flushes: number[][] = [];
  for (let index = 0; index < 100; index += 1) {
    batcher.enqueue("stable-row", index, (callback) => frames.push(callback), (values) => flushes.push(values));
  }
  assert.equal(frames.length, 1);
  assert.deepEqual(flushes, []);
  frames[0]();
  assert.deepEqual(flushes, [[99]]);
}

function testDirectProcessVirtualRowGuard(): void {
  const reasoning: ChatMessage = { id: "reasoning-row", role: "assistant", itemType: "reasoning", text: "x", createdAt: 1 };
  const tool: ChatMessage = { id: "tool-row", role: "tool", itemType: "dynamicToolCall", text: "x", createdAt: 1 };
  assert.equal(isDirectProcessVirtualRow("message:reasoning-row", reasoning), true);
  assert.equal(isDirectProcessVirtualRow("actionItem:tool-row", tool), true);
  assert.equal(isDirectProcessVirtualRow("turnProcess:run:answer", reasoning), false);
  assert.equal(isDirectProcessVirtualRow("turnProcess:run:answer", tool), false);
}

function createProjector(answerMessage: ChatMessage): HarnessEventProjector {
  return new HarnessEventProjector({
    runId: answerMessage.runId ?? "",
    backendId: answerMessage.backendId ?? "hermes",
    vaultPath: "/tmp/echoink-projector",
    answerMessage
  });
}

function createAnswer(runId: string, backendId: "codex-cli" | "hermes" | "opencode" = "hermes"): ChatMessage {
  return {
    id: `answer:${runId}`,
    role: "assistant",
    itemType: "assistant",
    status: "running",
    title: backendId === "codex-cli" ? "Codex" : backendId === "opencode" ? "OpenCode" : "Hermes",
    text: "Agent 正在处理...",
    backendId,
    runId,
    createdAt: 1_000
  };
}

function event(
  runId: string,
  sequence: number,
  type: HarnessEvent["type"],
  patch: Partial<HarnessEvent>
): HarnessEvent {
  return {
    eventId: `${runId}:${sequence}`,
    runId,
    sequence,
    createdAt: 1_000 + sequence,
    source: type.startsWith("tool.") ? "tool" : "agent",
    type,
    backendId: "hermes",
    ...patch
  };
}
