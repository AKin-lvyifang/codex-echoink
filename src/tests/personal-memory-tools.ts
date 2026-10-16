import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Value } from "typebox/value";
import {
  runAgentLoop,
  type AgentEvent,
  type AgentTool
} from "@earendil-works/pi-agent-core";
import {
  createAssistantMessageEventStream,
  type AssistantMessage
} from "@earendil-works/pi-ai";
import {
  PI_PERSONAL_MEMORY_TOOL_IDS,
  PI_PERSONAL_MEMORY_TOOL_SCHEMAS,
  PiPersonalMemoryToolSecurity,
  createPiPersonalMemoryToolDefinitions,
  normalizePiPersonalMemoryToolArguments,
  type MemoryWriteToolArguments
} from "../harness/pi-native/pi-personal-memory-tools";
import { PersonalMemoryRecallHarness } from "../harness/memory/personal-memory-recall-harness";
import type { PersonalMemoryRuntimeContext } from "../harness/memory/personal-memory-contracts";
import { PersonalMemoryAccessError } from "../harness/memory/personal-memory-repository";
import { USER_PROFILE_SLOTS } from "../harness/memory/user-profile-state";
import { withPersonalMemoryFixture, type PersonalMemoryFixture } from "./personal-memory-fixture";

export async function runPersonalMemoryToolContractScenarios(): Promise<void> {
  assertOpenAiCompatibleMemoryToolSchemas();
  await scenarioProviderVisibleDescriptionsStayAligned();
  await scenarioRuntimeIdentityIsNotModelControlled();
  await scenarioInvalidArgumentsAndMemoryModeErrors();
  await scenarioPiAgentLoopPreparesValidatesThenExecutesMemoryWrite();
  await scenarioSearchBeforeAutonomousWriteAndCurrentEntryBinding();
  await scenarioAllPrimaryKindsPersistAcrossReopen();
  await scenarioHostRevisionUpdateForgetAndErrors();
  await scenarioProfileUpdateIsIdempotentAndReplacesSource();
  await scenarioConcurrentWritersUseCas();
  await scenarioExternalPrimaryTruthWinsWithoutWatchers();
  await scenarioRepositoryDisposeStopsExternalWatchers();
  await scenarioOversizedReadFailsExplicitly();
  console.log("PASS P3 Memory Tool contract scenarios (partial automated coverage)");
}

async function scenarioPiAgentLoopPreparesValidatesThenExecutesMemoryWrite():
Promise<void> {
  await withPersonalMemoryFixture(async (fixture) => {
    const entry = {
      entryId: "user-entry-fixture",
      text: "请记住这个 Agent Loop 字符串兼容测试。"
    };
    const security = createSecurity(fixture, entry, fixture.runtime());
    const tools = createPiPersonalMemoryToolDefinitions({
      repository: fixture.repository,
      security
    });
    await executeThroughSecurity(
      security,
      tools,
      "memory_search",
      "agent-loop-search-before-write",
      { query: "Agent Loop 字符串兼容" }
    );

    const writeTool = tools.find((tool) => tool.name === "memory_write");
    assert.ok(writeTool?.prepareArguments);
    const order: string[] = [];
    let prepareCalls = 0;
    let executeCalls = 0;
    const wrappedWriteTool: AgentTool = {
      ...writeTool,
      prepareArguments: (args) => {
        prepareCalls += 1;
        order.push("prepareArguments");
        return writeTool.prepareArguments!(args);
      },
      execute: async (...args) => {
        executeCalls += 1;
        order.push("execute");
        return await writeTool.execute(...args);
      }
    };
    const validEvents = await runMemoryToolCallThroughPiAgentLoop({
      tool: wrappedWriteTool,
      toolCallId: "agent-loop-valid-write",
      arguments: {
        request: JSON.stringify(createArguments("fact").request)
      },
      beforeToolCall: async (event, signal) => {
        order.push("validated");
        return await security.handleToolCall({
          toolName: event.toolCall.name,
          toolCallId: event.toolCall.id,
          input: event.args
        } as never, signal);
      },
      afterToolCall: async (event) => await security.handleToolResult({
        toolName: event.toolCall.name,
        toolCallId: event.toolCall.id,
        content: event.result.content,
        details: event.result.details,
        isError: event.isError
      } as never)
    });
    assert.deepEqual(order, ["prepareArguments", "validated", "execute"]);
    assert.equal(prepareCalls, 1);
    assert.equal(executeCalls, 1, "the validated memory_write executes exactly once");
    assert.equal(lastToolExecution(validEvents)?.isError, false);

    const invalidCases = [
      { name: "invalid-json", request: "not-json" },
      { name: "null", request: "null" },
      { name: "array", request: "[]" },
      { name: "nested-string", request: JSON.stringify("second string") },
      {
        name: "unknown-field",
        request: JSON.stringify({
          ...createArguments("fact").request,
          unknownField: true
        })
      }
    ] as const;
    for (const invalidCase of invalidCases) {
      let invalidPrepareCalls = 0;
      let invalidValidatedCalls = 0;
      let invalidExecuteCalls = 0;
      const invalidTool: AgentTool = {
        ...writeTool,
        prepareArguments: (args) => {
          invalidPrepareCalls += 1;
          return writeTool.prepareArguments!(args);
        },
        execute: async (...args) => {
          invalidExecuteCalls += 1;
          return await writeTool.execute(...args);
        }
      };
      const invalidEvents = await runMemoryToolCallThroughPiAgentLoop({
        tool: invalidTool,
        toolCallId: `agent-loop-${invalidCase.name}`,
        arguments: { request: invalidCase.request },
        beforeToolCall: async () => {
          invalidValidatedCalls += 1;
          return undefined;
        }
      });
      assert.equal(invalidPrepareCalls, 1, `${invalidCase.name} reaches the one preparation pass`);
      assert.equal(invalidValidatedCalls, 0,
        `${invalidCase.name} must fail before the post-schema beforeToolCall hook`);
      assert.equal(invalidExecuteCalls, 0, `${invalidCase.name} must never execute`);
      assert.equal(lastToolExecution(invalidEvents)?.isError, true);
    }

    for (const toolName of ["memory_search", "memory_read"] as const) {
      const tool = tools.find((candidate) => candidate.name === toolName);
      assert.ok(tool);
      assert.equal(tool.prepareArguments, undefined);
      let validatedCalls = 0;
      let otherExecuteCalls = 0;
      const wrappedTool: AgentTool = {
        ...tool,
        execute: async (...args) => {
          otherExecuteCalls += 1;
          return await tool.execute(...args);
        }
      };
      const events = await runMemoryToolCallThroughPiAgentLoop({
        tool: wrappedTool,
        toolCallId: `agent-loop-no-compat-${toolName}`,
        arguments: JSON.stringify(toolName === "memory_search"
          ? { query: "no compatibility" }
          : { id: "mem_target" }),
        beforeToolCall: async () => {
          validatedCalls += 1;
          return undefined;
        }
      });
      assert.equal(validatedCalls, 0, `${toolName} string arguments fail schema validation`);
      assert.equal(otherExecuteCalls, 0, `${toolName} receives no string compatibility`);
      assert.equal(lastToolExecution(events)?.isError, true);
    }
  });
}

async function runMemoryToolCallThroughPiAgentLoop(input: Readonly<{
  tool: AgentTool;
  toolCallId: string;
  arguments: unknown;
  beforeToolCall?: NonNullable<Parameters<typeof runAgentLoop>[2]["beforeToolCall"]>;
  afterToolCall?: NonNullable<Parameters<typeof runAgentLoop>[2]["afterToolCall"]>;
}>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  const assistantMessage: AssistantMessage = {
    role: "assistant",
    content: [{
      type: "toolCall",
      id: input.toolCallId,
      name: input.tool.name,
      arguments: input.arguments as Record<string, unknown>
    }],
    api: "openai-completions",
    provider: "fixture",
    model: "fixture-model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
    },
    stopReason: "toolUse",
    timestamp: 2
  };
  await runAgentLoop(
    [{ role: "user", content: "run one tool", timestamp: 1 }],
    { systemPrompt: "fixture", messages: [], tools: [input.tool] },
    {
      model: { provider: "fixture", id: "fixture-model" } as never,
      convertToLlm: (messages) => messages as never,
      toolExecution: "sequential",
      shouldStopAfterTurn: () => true,
      ...(input.beforeToolCall ? { beforeToolCall: input.beforeToolCall } : {}),
      ...(input.afterToolCall ? { afterToolCall: input.afterToolCall } : {})
    },
    async (event) => { events.push(event); },
    undefined,
    () => {
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "done", reason: "toolUse", message: assistantMessage });
      return stream;
    }
  );
  return events;
}

function lastToolExecution(events: readonly AgentEvent[]):
Extract<AgentEvent, { type: "tool_execution_end" }> | undefined {
  return events.findLast((event): event is Extract<AgentEvent, {
    type: "tool_execution_end";
  }> => event.type === "tool_execution_end");
}

function assertOpenAiCompatibleMemoryToolSchemas(): void {
  const schemas = PI_PERSONAL_MEMORY_TOOL_SCHEMAS as unknown as Readonly<Record<
    (typeof PI_PERSONAL_MEMORY_TOOL_IDS)[number],
    Readonly<Record<string, unknown>>
  >>;
  for (const toolId of PI_PERSONAL_MEMORY_TOOL_IDS) {
    assert.equal(
      schemas[toolId].type,
      "object",
      `${toolId} function.parameters must have a top-level object schema`
    );
  }
  assert.deepEqual(schemas.memory_write.required, ["request"]);
  const writeProperties = schemas.memory_write.properties as Readonly<Record<
    string,
    Readonly<Record<string, unknown>>
  >>;
  assert.deepEqual(Object.keys(writeProperties), ["request"]);
  const requestVariants = writeProperties.request.anyOf as ReadonlyArray<
    Readonly<Record<string, unknown>>
  >;
  const operationVariants = requestVariants.slice(0, 4);
  const jsonStringVariant = requestVariants[4]!;
  const operationNames = operationVariants.map((variant) => {
    const properties = variant.properties as Readonly<Record<
      string,
      Readonly<Record<string, unknown>>
    >>;
    return properties.operation.const;
  });
  assert.deepEqual(operationNames, [
    "create",
    "update",
    "profile_update",
    "forget"
  ]);
  assert.deepEqual(operationVariants.map((variant) => variant.additionalProperties), [
    false, false, false, false
  ]);
  assert.deepEqual(operationVariants.map((variant) => variant.required), [
    ["operation", "kind", "title", "content", "recallWhen"],
    ["operation", "targetId", "title", "content", "recallWhen", "reason"],
    ["operation", "profileKey", "text"],
    ["operation", "targetId", "reason", "evidenceQuote"]
  ]);
  assert.equal(jsonStringVariant.type, "string");
  assert.equal(jsonStringVariant.maxLength, 32_768);
  const profileVariant = operationVariants[2]!;
  const profileProperties = profileVariant.properties as Readonly<Record<
    string,
    Readonly<Record<string, unknown>>
  >>;
  const profileKeyVariants = profileProperties.profileKey.anyOf as ReadonlyArray<
    Readonly<Record<string, unknown>>
  >;
  assert.deepEqual(
    profileKeyVariants.map((variant) => variant.const),
    USER_PROFILE_SLOTS.map((slot) => slot.profileKey),
    "profile_update.profileKey must expose the complete closed profile taxonomy"
  );
  for (const hiddenHostField of [
    "basis",
    "contentOrigin",
    "expectedRevision"
  ]) {
    assert.equal(
      JSON.stringify(writeProperties).includes(`\"${hiddenHostField}\"`),
      false,
      `${hiddenHostField} must be host-controlled rather than model-visible`
    );
  }
  const createProperties = operationVariants[0]!.properties as Readonly<Record<
    string,
    Readonly<Record<string, unknown>>
  >>;
  const kindVariants = createProperties.kind.anyOf as ReadonlyArray<
    Readonly<Record<string, unknown>>
  >;
  assert.deepEqual(kindVariants.map((variant) => variant.const), [
    "fact", "view", "decision", "goal", "task", "open_loop", "episode"
  ]);
  assert.match(String(createProperties.recallWhen.description ?? ""), /未来.*召回/iu);
  assert.match(String(schemas.memory_write.description ?? ""), /跨轮价值.*新增或更新.*USER 画像.*忘记/iu);
  assert.doesNotMatch(String(schemas.memory_write.description ?? ""), /nextCursor|revision|outcome=/iu);
  assert.match(String(schemas.memory_search.description ?? ""), /默认只返回current.*statuses包含superseded.*scope\/from\/to.*定位现有记录/iu);
  assert.doesNotMatch(String(schemas.memory_search.description ?? ""), /nextCursor|revision|冲突/iu);
  assert.equal(profileProperties.text.maxLength, 120);

  const createRequest = {
    operation: "create",
    kind: "view",
    title: "沟通偏好",
    content: "用户希望先给结论。",
    recallWhen: "需要组织回答时"
  } as const;
  const normalizedCreate = {
    request: {
      operation: "create",
      kind: "view",
      title: "沟通偏好",
      content: "用户希望先给结论。",
      recallWhen: "需要组织回答时"
    }
  };
  const writeSchema = PI_PERSONAL_MEMORY_TOOL_SCHEMAS.memory_write;
  assert.equal(Value.Check(writeSchema, { request: createRequest }), true);
  assert.equal(Value.Check(writeSchema, { request: JSON.stringify(createRequest) }), true);
  assert.deepEqual(normalizePiPersonalMemoryToolArguments("memory_write", {
    request: createRequest
  }), normalizedCreate);
  assert.deepEqual(normalizePiPersonalMemoryToolArguments("memory_write", {
    request: JSON.stringify(createRequest)
  }), normalizedCreate);

  assert.equal(Value.Check(writeSchema, { request: null }), false);
  assert.equal(Value.Check(writeSchema, { request: [] }), false);
  assert.equal(Value.Check(writeSchema, { request: "x".repeat(32_769) }), false);
  assert.equal(Value.Check(writeSchema, {
    request: { ...createRequest, unexpected: true }
  }), false);
  for (const invalidJsonRequest of [
    "{",
    "null",
    "[]",
    JSON.stringify(JSON.stringify(createRequest)),
    JSON.stringify({ ...createRequest, unexpected: true }),
    "x".repeat(32_769)
  ]) {
    assert.throws(() => normalizePiPersonalMemoryToolArguments("memory_write", {
      request: invalidJsonRequest
    }));
  }
  assert.deepEqual(normalizePiPersonalMemoryToolArguments("memory_write", {
    request: {
      operation: "forget",
      targetId: "mem_target",
      reason: "用户明确要求忘掉",
      evidenceQuote: "忘掉我以前偏好表格这件事。"
    }
  }), {
    request: {
      operation: "forget",
      targetId: "mem_target",
      reason: "用户明确要求忘掉",
      evidenceQuote: "忘掉我以前偏好表格这件事。"
    }
  });
}

async function scenarioProviderVisibleDescriptionsStayAligned(): Promise<void> {
  await withPersonalMemoryFixture(async (fixture) => {
    const entry = { entryId: "user-entry-fixture", text: "核对 Memory Tool 描述" };
    const security = createSecurity(fixture, entry, fixture.runtime());
    const tools = createPiPersonalMemoryToolDefinitions({ repository: fixture.repository, security });
    const descriptions = Object.fromEntries(tools.map((tool) => [tool.name, tool.description]));
    const searchDescription = descriptions.memory_search ?? "";
    const writeDescription = descriptions.memory_write ?? "";
    assert.equal(
      tools.find((tool) => tool.name === "memory_write")?.executionMode,
      "sequential",
      "renewable write sessions require every memory_write result before the next write"
    );
    const schemas = PI_PERSONAL_MEMORY_TOOL_SCHEMAS as unknown as Readonly<Record<
      (typeof PI_PERSONAL_MEMORY_TOOL_IDS)[number],
      Readonly<Record<string, unknown>>
    >>;

    assert.equal(searchDescription, schemas.memory_search.description);
    assert.match(searchDescription, /current与superseded.*supersedes.*写入、修正或忘记前按需定位现有记录/iu);
    assert.doesNotMatch(searchDescription, /exhausted|nextCursor|revision|冲突/iu);

    assert.equal(writeDescription, schemas.memory_write.description);
    assert.match(writeDescription, /跨轮价值且对象明确.*新增或更新长期 Memory.*修正 USER 画像.*用户当前原话忘记/iu);
    assert.match(writeDescription, /普通文字不会保存.*真实结果/iu);
    assert.doesNotMatch(writeDescription, /exhausted|nextCursor|revision|outcome=/iu);
  });
}

async function scenarioOversizedReadFailsExplicitly(): Promise<void> {
  await withPersonalMemoryFixture(async (fixture) => {
    const content = "\\\"".repeat(12_000);
    const created = await fixture.repository.write({
      operation: "create",
      kind: "episode",
      title: "超长 Memory Read",
      content,
      recallWhen: "需要读取超长含转义字符的正文时",
      basis: "explicit"
    } as never, fixture.runtime());
    const entry = { entryId: "user-entry-fixture", text: "读取超长 Memory" };
    const security = createSecurity(fixture, entry, fixture.runtime());
    const tools = createPiPersonalMemoryToolDefinitions({ repository: fixture.repository, security });
    const result = await executeThroughSecurity(
      security,
      tools,
      "memory_read",
      "oversized-memory-read",
      { id: created.record!.id }
    );
    assert.equal(result.isError, true);
    assert.equal(result.details.errorCode, "personal_memory_result_too_large");
    assert.doesNotMatch(result.content[0]?.text ?? "", /<echoink_memory_result/iu);
  });
}

async function scenarioRuntimeIdentityIsNotModelControlled(): Promise<void> {
  const schemas = JSON.stringify(PI_PERSONAL_MEMORY_TOOL_SCHEMAS);
  for (const forbidden of [
    "vaultId",
    "conversationId",
    "piSessionId",
    "productRunId",
    "userEntryId",
    "explicitlyAuthorized",
    "explicitForget"
  ]) {
    assert.equal(schemas.includes(forbidden), false, `${forbidden} must not be model-controlled`);
  }
  assert.throws(() => normalizePiPersonalMemoryToolArguments("memory_search", {
    query: "证据",
    vaultId: "forged-vault"
  }));
  assert.throws(() => normalizePiPersonalMemoryToolArguments("memory_write", {
    request: createArguments().request,
    explicitlyAuthorized: true
  }));
  assert.throws(() => normalizePiPersonalMemoryToolArguments("memory_write", {
    request: {
      operation: "close",
      targetId: "mem_target",
      reason: "已完成"
    }
  }));
  assert.throws(() => normalizePiPersonalMemoryToolArguments("memory_write", {
    request: {
      operation: "update",
      targetId: "mem_target",
      title: "新观点",
      content: "新内容",
      reason: "用户改变观点"
    }
  }));
  assert.throws(() => normalizePiPersonalMemoryToolArguments("memory_write", {
    request: {
      operation: "profile_update",
      profileKey: "preference.unknown",
      text: "用户偏好中文"
    }
  }));
  const boundedProfileText = "甲".repeat(120);
  assert.deepEqual(normalizePiPersonalMemoryToolArguments("memory_write", {
    request: {
      operation: "profile_update",
      targetId: "mem_existing_profile_fact",
      profileKey: "preference.language",
      text: boundedProfileText
    }
  }), {
    request: {
      operation: "profile_update",
      targetId: "mem_existing_profile_fact",
      profileKey: "preference.language",
      text: boundedProfileText
    }
  });
  assert.throws(() => normalizePiPersonalMemoryToolArguments("memory_write", {
    request: {
      operation: "profile_update",
      profileKey: "preference.language",
      text: "甲".repeat(121)
    }
  }));
  assert.throws(() => normalizePiPersonalMemoryToolArguments("memory_write", {
    request: {
      operation: "profile_update",
      profileKey: "preference.language",
      text: "用户偏好中文",
      content: "旧的 16000/24000 字段路径不得继续存在"
    }
  }));
  assert.throws(() => normalizePiPersonalMemoryToolArguments("memory_write", {
    request: {
      operation: "forget",
      targetId: "mem_target",
      reason: "请忘记"
    }
  }));
  assert.throws(() => normalizePiPersonalMemoryToolArguments("memory_write", {
    request: {
      ...createArguments().request,
      targetId: "mem_cross_operation"
    }
  }));
  assert.throws(() => normalizePiPersonalMemoryToolArguments("memory_write", {
    request: {
      ...createArguments().request,
      evidenceQuote: "普通 create 不再接受 evidenceQuote。"
    }
  }));
  assert.throws(() => normalizePiPersonalMemoryToolArguments("memory_write", {
    request: {
      operation: "close",
      targetId: "mem_target",
      reason: "任务已完成",
      expectedRevision: 3,
      content: "close 不接受 create 字段"
    }
  }));
}

async function scenarioInvalidArgumentsAndMemoryModeErrors(): Promise<void> {
  await withPersonalMemoryFixture(async (fixture) => {
    const entry = { entryId: "user-entry-fixture", text: "请记住这条规则。" };
    const noMemory = createSecurity(fixture, entry, fixture.runtime({ memoryMode: "no_memory" }));
    const tools = createPiPersonalMemoryToolDefinitions({ repository: fixture.repository, security: noMemory });
    const searchTool = tools.find((tool) => tool.name === "memory_search");
    const readTool = tools.find((tool) => tool.name === "memory_read");
    const writeTool = tools.find((tool) => tool.name === "memory_write");
    assert.equal(searchTool?.prepareArguments, undefined);
    assert.equal(readTool?.prepareArguments, undefined);
    assert.ok(writeTool?.prepareArguments);
    const preparedWrite = writeTool.prepareArguments({
      request: JSON.stringify(createArguments("fact").request)
    });
    assert.deepEqual(preparedWrite, createArguments("fact"));
    assert.deepEqual(
      normalizePiPersonalMemoryToolArguments("memory_write", preparedWrite),
      createArguments("fact"),
      "memory_write string compatibility must prepare before the unchanged strict normalizer"
    );
    for (const invalidRequest of ["not-json", "null", "[]", JSON.stringify("nested-string")]) {
      assert.throws(() => writeTool.prepareArguments?.({ request: invalidRequest }));
    }
    assert.throws(() => writeTool.prepareArguments?.(
      JSON.stringify(createArguments("fact"))
    ));
    const calls = [
      { toolName: "memory_search", input: { query: "规则" } },
      { toolName: "memory_read", input: { id: "mem_target" } },
      { toolName: "memory_write", input: createArguments() }
    ] as const;
    for (const [index, call] of calls.entries()) {
      const failed = await executeFailureThroughSecurity(
        noMemory,
        tools,
        call.toolName,
        `no-memory-${index}`,
        call.input
      );
      assert.equal(failed.details.errorCode, "personal_memory_no_memory");
      assert.match(failed.content[0]?.text ?? "", /长期记忆总开关已关闭/u);
    }

    const normal = createSecurity(fixture, entry, fixture.runtime());
    const normalTools = createPiPersonalMemoryToolDefinitions({
      repository: fixture.repository,
      security: normal
    });
    const invalid = await executeFailureThroughSecurity(
      normal,
      normalTools,
      "memory_write",
      "invalid-write-arguments",
      { request: { operation: "create", title: "缺参数" } }
    );
    assert.equal(invalid.details.errorCode, "personal_memory_invalid_request");
    assert.match(invalid.content[0]?.text ?? "", /参数无效/u);
  });
}

async function scenarioSearchBeforeAutonomousWriteAndCurrentEntryBinding(): Promise<void> {
  await withPersonalMemoryFixture(async (fixture) => {
    const entry = {
      entryId: "user-entry-fixture",
      text: "记住这个。"
    };
    const security = createSecurity(fixture, entry, fixture.runtime());
    const tools = createPiPersonalMemoryToolDefinitions({ repository: fixture.repository, security });
    const args: MemoryWriteToolArguments = {
      request: {
        operation: "create",
        kind: "view",
        title: "产品观点",
        content: "用户认为产品应优先解决真实主链，而不是为理论风险扩展范围。",
        recallWhen: "评估产品实施范围时"
      }
    };
    const beforeSearch = await executeFailureThroughSecurity(
      security,
      tools,
      "memory_write",
      "write-before-search",
      args
    );
    assert.equal(
      beforeSearch.details.errorCode,
      "personal_memory_current_turn_search_required"
    );
    assert.match(
      beforeSearch.content[0]?.text ?? "",
      /当前用户消息对应的本轮.*历史轮搜索不能替代.*exhausted=false.*nextCursor.*exhausted=true.*不要直接重试 memory_write/u
    );

    let activeEntry = entry;
    let activeRuntime = fixture.runtime({
      userEntryId: entry.entryId,
      productRunId: "historical-search-product-run"
    });
    const crossTurnSecurity = new PiPersonalMemoryToolSecurity({
      currentRuntime: () => activeRuntime,
      currentUserEntry: { current: () => activeEntry }
    });
    const crossTurnTools = createPiPersonalMemoryToolDefinitions({
      repository: fixture.repository,
      security: crossTurnSecurity
    });
    await executeThroughSecurity(
      crossTurnSecurity,
      crossTurnTools,
      "memory_search",
      "historical-turn-search",
      { query: "产品观点 真实主链" }
    );
    activeEntry = {
      entryId: "current-turn-user-entry",
      text: "这是当前轮新的长期事实。"
    };
    activeRuntime = fixture.runtime({
      userEntryId: activeEntry.entryId,
      productRunId: "current-turn-product-run"
    });
    const afterHistoricalSearch = await executeFailureThroughSecurity(
      crossTurnSecurity,
      crossTurnTools,
      "memory_write",
      "write-after-historical-search",
      args
    );
    assert.equal(
      afterHistoricalSearch.details.errorCode,
      "personal_memory_current_turn_search_required"
    );
    assert.match(
      afterHistoricalSearch.content[0]?.text ?? "",
      /历史轮搜索不能替代/u
    );

    for (const [index, title] of ["无关历史甲", "无关历史乙"].entries()) {
      await fixture.repository.write({
        operation: "create",
        kind: "fact",
        title,
        content: `第 ${index + 1} 条无关历史。`,
        recallWhen: "只用于验证搜索分页时",
        basis: "explicit"
      }, fixture.runtime({ userEntryId: `partial-search-fixture-${index}` }));
    }
    const partialSearch = await executeThroughSecurity(
      security,
      tools,
      "memory_search",
      "partial-search-before-create",
      { query: "", limit: 1 }
    );
    assert.match(partialSearch.content[0]?.text ?? "", /"exhausted":false/u);
    const afterPartialSearch = await executeFailureThroughSecurity(
      security,
      tools,
      "memory_write",
      "write-after-partial-search",
      args
    );
    assert.equal(
      afterPartialSearch.details.errorCode,
      "personal_memory_current_turn_search_required"
    );

    await executeThroughSecurity(
      security,
      tools,
      "memory_search",
      "search-before-create",
      { query: "产品观点 真实主链" }
    );
    const corrected = await executeThroughSecurity(
      security,
      tools,
      "memory_write",
      "create-after-search",
      args
    );
    assert.equal(corrected.isError, false);
    assert.match(corrected.content[0]?.text ?? "", /untrusted-background/u);
    const createdPayload = memoryResultPayload(corrected);
    assert.equal(createdPayload.outcome, "created");
    assert.equal(
      createdPayload.recordId,
      (corrected.details.recordIds as readonly string[] | undefined)?.[0]
    );
    assert.equal(createdPayload.revision, corrected.details.revision);

    const alreadyPresent = await executeThroughSecurity(
      security,
      tools,
      "memory_write",
      "idempotent-after-created-without-new-search",
      args
    );
    const alreadyPresentPayload = memoryResultPayload(alreadyPresent);
    assert.equal(alreadyPresentPayload.outcome, "already_present");
    assert.equal(alreadyPresentPayload.revision, createdPayload.revision);

    const possibleDuplicateArgs = memoryWriteArguments({
      operation: "create",
      kind: "view",
      title: "产品观点",
      content: "这段不同正文与已有产品观点使用同一稳定标题，不应自动重复写入。",
      recallWhen: "评估产品路线时"
    });
    const possibleDuplicate = await executeThroughSecurity(
      security,
      tools,
      "memory_write",
      "possible-duplicate-after-idempotent-without-new-search",
      possibleDuplicateArgs
    );
    const possibleDuplicatePayload = memoryResultPayload(possibleDuplicate);
    assert.equal(possibleDuplicatePayload.outcome, "possible_duplicate");
    assert.equal(possibleDuplicatePayload.revision, createdPayload.revision);

    const chainedArgs = memoryWriteArguments({
      operation: "create",
      kind: "task",
      title: "同轮续签写入",
      content: "同一用户消息中的第二条独立长期 Memory 可以直接继续写入。",
      recallWhen: "验证同轮多条 Memory 写入时"
    });
    const chained = await executeThroughSecurity(
      security,
      tools,
      "memory_write",
      "second-create-without-new-search",
      chainedArgs
    );
    const chainedPayload = memoryResultPayload(chained);
    assert.equal(chainedPayload.outcome, "created");
    assert.equal(
      chainedPayload.revision,
      (createdPayload.revision as number) + 1,
      "a successful write renews the current runtime write session at its real revision"
    );

    const reopened = await fixture.reopen();
    const found = await reopened.search({ query: "产品 真实 主链" }, fixture.runtime());
    assert.equal(found.items.length, 1);
    const read = await reopened.read(found.items[0]!.id, fixture.runtime());
    assert.equal(read.record.kind, "view");
    assert.equal(read.record.basis, "explicit");
    assert.equal(read.record.contentOrigin, "user_statement");
    assert.equal(found.items[0]!.basis, "explicit");
    assert.equal(found.items[0]!.contentOrigin, "user_statement");
    assert.equal(found.items[0]!.status, "current");
    assert.equal(found.items[0]!.revision, read.record.revision);
    assert.equal(found.items[0]!.file, read.record.file);
    assert.match(
      read.record.file,
      /(?:^|\/)views\//u,
      "a short current-turn confirmation may persist the prior-turn view in the correct catalog"
    );
    const runtime = fixture.runtime();
    for (const identity of [
      runtime.vaultId,
      runtime.conversationId,
      runtime.piSessionId,
      runtime.userEntryId,
      runtime.productRunId
    ]) {
      assert.ok(read.record.source.includes(encodeURIComponent(identity)));
    }
    const recalled = await new PersonalMemoryRecallHarness(reopened).prepareTurnContext({
      memoryMode: "normal",
      query: "评估产品实施范围",
      tokenBudget: 320,
      vaultId: runtime.vaultId,
      conversationId: runtime.conversationId,
      piSessionId: runtime.piSessionId,
      productRunId: runtime.productRunId
    });
    assert.equal(
      recalled.recall?.candidates.some((candidate) => candidate.id === read.record.id),
      true,
      "the newly written primary view is reachable on the next turn"
    );
    const recalledView = recalled.recall!.candidates.find((candidate) => candidate.id === read.record.id)!;
    assert.equal(recalledView.basis, "explicit");
    assert.equal(recalledView.contentOrigin, "user_statement");
    assert.equal(recalledView.sourceSummary, found.items[0]!.sourceSummary);
    assert.equal(recalledView.file, read.record.file);
    const chainedRead = await reopened.read(chainedPayload.recordId as string, fixture.runtime());
    assert.equal(chainedRead.record.kind, "task");

    await reopened.write({
      operation: "create",
      kind: "fact",
      title: "外部并发推进 revision",
      content: "另一写入者在当前 Agent 的连续写入之间推进了 Repository revision。",
      recallWhen: "验证同轮写入会话的 CAS 时",
      basis: "explicit",
      contentOrigin: "user_statement"
    }, fixture.runtime({ productRunId: "external-writer-product-run" }));
    const afterExternalChange = await executeFailureThroughSecurity(
      security,
      tools,
      "memory_write",
      "renewed-session-revision-conflict",
      memoryWriteArguments({
        operation: "create",
        kind: "goal",
        title: "冲突后不得写入",
        content: "陈旧写入会话不能覆盖外部变化。",
        recallWhen: "验证冲突处理时"
      })
    );
    assert.equal(
      afterExternalChange.details.errorCode,
      "personal_memory_revision_conflict"
    );
    const afterFailedWrite = await executeFailureThroughSecurity(
      security,
      tools,
      "memory_write",
      "write-after-conflict-without-new-search",
      memoryWriteArguments({
        operation: "create",
        kind: "goal",
        title: "冲突后仍不得直写",
        content: "写入失败后必须先重新搜索。",
        recallWhen: "验证失败失效时"
      })
    );
    assert.equal(
      afterFailedWrite.details.errorCode,
      "personal_memory_current_turn_search_required"
    );

    const mismatched = createSecurity(fixture, {
      entryId: "different-entry",
      text: entry.text
    }, fixture.runtime());
    const blocked = await mismatched.handleToolCall({
      toolName: "memory_write",
      toolCallId: "entry-mismatch",
      input: createArguments()
    } as never, undefined);
    assert.equal(blocked?.reason, "authorization_failed");
  });
}

async function scenarioAllPrimaryKindsPersistAcrossReopen(): Promise<void> {
  await withPersonalMemoryFixture(async (fixture) => {
    const kinds = [
      "fact", "view", "decision", "goal", "task", "open_loop", "episode"
    ] as const;
    const expectedDirectory = {
      fact: "facts",
      view: "views",
      decision: "decisions",
      goal: "active",
      task: "active",
      open_loop: "active",
      episode: "episodes"
    } as const;
    const entry = { entryId: "user-entry-fixture", text: "把前面的内容记住。" };
    const security = createSecurity(fixture, entry, fixture.runtime());
    const tools = createPiPersonalMemoryToolDefinitions({ repository: fixture.repository, security });
    const ids = new Map<(typeof kinds)[number], string>();

    for (const kind of kinds) {
      await executeThroughSecurity(
        security,
        tools,
        "memory_search",
        `search-kind-${kind}`,
        { query: `聊天七类 ${kind}` }
      );
      const result = await executeThroughSecurity(
        security,
        tools,
        "memory_write",
        `create-kind-${kind}`,
        memoryWriteArguments({
          operation: "create",
          kind,
          title: `聊天七类 ${kind}`,
          content: `用户通过聊天创建 ${kind} 类型的长期记忆。`,
          recallWhen: `验证 ${kind} 类型聊天创建时`
        })
      );
      const payload = memoryResultPayload(result);
      assert.equal(payload.outcome, "created");
      assert.equal(
        payload.recordId,
        (result.details.recordIds as readonly string[] | undefined)?.[0]
      );
      ids.set(kind, String(payload.recordId));
    }

    const reopened = await fixture.reopen();
    for (const kind of kinds) {
      const read = await reopened.read(ids.get(kind)!, fixture.runtime());
      assert.equal(read.record.kind, kind);
      assert.match(read.record.file, new RegExp(`(?:^|/)${expectedDirectory[kind]}/`, "u"));
    }
  });
}

async function scenarioHostRevisionUpdateForgetAndErrors(): Promise<void> {
  await withPersonalMemoryFixture(async (fixture) => {
    const entry = {
      entryId: "user-entry-fixture",
      text: "请记住这条规则。我现在改成先给结论再给依据。忘掉这条回答规则。"
    };
    const security = createSecurity(fixture, entry, fixture.runtime());
    const tools = createPiPersonalMemoryToolDefinitions({ repository: fixture.repository, security });
    await executeThroughSecurity(
      security,
      tools,
      "memory_search",
      "search-before-current-create",
      { query: "回答规则" }
    );
    const createdResult = await executeThroughSecurity(
      security,
      tools,
      "memory_write",
      "create-current",
      createArguments("view")
    );
    const createdId = (createdResult.details.recordIds as readonly string[] | undefined)?.[0];
    assert.ok(createdId);
    const createdPayload = memoryResultPayload(createdResult);
    assert.equal(createdPayload.outcome, "created");
    assert.equal(createdPayload.recordId, createdId);
    assert.equal(createdPayload.revision, createdResult.details.revision);
    assert.deepEqual(
      (await fixture.repository.readAuditByProductRun(
        fixture.runtime().productRunId
      )).map((event) => ({ type: event.type, toolCallId: event.toolCallId })),
      [{ type: "created", toolCallId: "create-current" }]
    );
    await executeThroughSecurity(
      security,
      tools,
      "memory_search",
      "search-before-possible-duplicate",
      { query: "回答规则" }
    );
    const possibleDuplicate = await executeThroughSecurity(
      security,
      tools,
      "memory_write",
      "possible-duplicate",
      memoryWriteArguments({
        operation: "create",
        kind: "view",
        title: "回答规则",
        content: "回答先给结论，并省略全部依据。",
        recallWhen: "准备回答工程问题时"
      })
    );
    const possibleDuplicatePayload = memoryResultPayload(possibleDuplicate);
    assert.equal(possibleDuplicatePayload.outcome, "possible_duplicate");
    assert.equal(possibleDuplicatePayload.recordId, createdId);
    assert.equal(possibleDuplicatePayload.revision, createdPayload.revision);
    assert.doesNotMatch(possibleDuplicate.content[0]?.text ?? "", /"outcome":"created"/u);
    const failedRead = await executeFailureThroughSecurity(
      security,
      tools,
      "memory_read",
      "missing-read",
      { id: "mem_missing" }
    );
    assert.deepEqual(failedRead.details, {
      source: "echoink-personal-memory",
      schemaVersion: 1,
      toolId: "memory_read",
      toolCallId: "missing-read",
      status: "failed",
      failureStage: "execution",
      errorCode: "personal_memory_not_found"
    });
    assert.equal(
      JSON.stringify(failedRead.details).includes("does not exist"),
      false
    );
    await executeThroughSecurity(
      security,
      tools,
      "memory_search",
      "search-before-update",
      { query: "回答规则" }
    );
    const updatedResult = await executeThroughSecurity(
      security,
      tools,
      "memory_write",
      "update-current",
      memoryWriteArguments({
        operation: "update",
        targetId: createdId,
        title: "回答规则",
        content: "回答时先给结论，再给依据。",
        recallWhen: "准备回答工程问题时",
        reason: "用户改变了回答偏好"
      })
    );
    const updatedId = (updatedResult.details.recordIds as readonly string[] | undefined)?.[0];
    assert.ok(updatedId);
    const updatedPayload = memoryResultPayload(updatedResult);
    assert.equal(updatedPayload.outcome, "updated");
    assert.equal(updatedPayload.recordId, updatedId);
    const updated = await fixture.repository.read(updatedId, fixture.runtime());
    assert.equal(updated.record.kind, "view", "update preserves the existing kind");
    assert.equal(updated.record.supersedes, createdId);

    await executeThroughSecurity(
      security,
      tools,
      "memory_search",
      "search-before-stale-update",
      { query: "回答规则" }
    );
    await fixture.repository.write({
      operation: "create",
      kind: "fact",
      title: "并发变化",
      content: "这条写入只用于推进 manifest revision。",
      recallWhen: "测试并发 revision 时",
      basis: "explicit"
    }, fixture.runtime({ userEntryId: "concurrent-writer" }));
    const stale = await executeFailureThroughSecurity(
      security,
      tools,
      "memory_write",
      "stale-host-revision",
      memoryWriteArguments({
        operation: "update",
        targetId: updatedId,
        title: "回答规则",
        content: "不应落盘的陈旧更新。",
        recallWhen: "不应生效",
        reason: "测试陈旧 revision"
      })
    );
    assert.equal(stale.details.errorCode, "personal_memory_revision_conflict");
    assert.match(stale.content[0]?.text ?? "", /重新 memory_search/u);

    await executeThroughSecurity(
      security,
      tools,
      "memory_search",
      "search-before-forget",
      { query: "回答规则" }
    );
    const forgetWithoutCurrentEvidence = await security.handleToolCall({
      toolName: "memory_write",
      toolCallId: "forget-without-current-evidence",
      input: memoryWriteArguments({
        operation: "forget",
        targetId: updatedId,
        reason: "不得执行",
        evidenceQuote: "这句忘记要求不在当前用户 Entry。"
      })
    } as never, undefined);
    assert.equal(forgetWithoutCurrentEvidence?.reason, "authorization_failed");
    const forgotten = await executeThroughSecurity(
      security,
      tools,
      "memory_write",
      "forget-directly-from-conversation",
      memoryWriteArguments({
        operation: "forget",
        targetId: updatedId,
        reason: "用户明确要求忘掉",
        evidenceQuote: "忘掉这条回答规则。"
      })
    );
    assert.equal(forgotten.isError, false);
    assert.deepEqual(forgotten.details.recordIds, [updatedId]);
    const forgottenPayload = memoryResultPayload(forgotten);
    assert.equal(forgottenPayload.outcome, "forgotten");
    assert.equal(forgottenPayload.recordId, updatedId);

    await executeThroughSecurity(
      security,
      tools,
      "memory_search",
      "search-before-missing-forget",
      { query: "回答规则" }
    );
    const missingForget = await executeFailureThroughSecurity(
      security,
      tools,
      "memory_write",
      "forget-missing-target",
      memoryWriteArguments({
        operation: "forget",
        targetId: updatedId,
        reason: "再次忘掉不存在的目标",
        evidenceQuote: "忘掉这条回答规则。"
      })
    );
    assert.equal(missingForget.details.errorCode, "personal_memory_not_found");
    assert.match(missingForget.content[0]?.text ?? "", /不存在/u);
  });
}

async function scenarioProfileUpdateIsIdempotentAndReplacesSource(): Promise<void> {
  await withPersonalMemoryFixture(async (fixture) => {
    const entry = {
      entryId: "user-entry-fixture",
      text: "请记住我偏好中文。现在更新为我偏好英文。"
    };
    const security = createSecurity(fixture, entry, fixture.runtime());
    const tools = createPiPersonalMemoryToolDefinitions({ repository: fixture.repository, security });
    const writeProfile = async (
      toolCallId: string,
      text: string
    ) => {
      await executeThroughSecurity(
        security,
        tools,
        "memory_search",
        `search-${toolCallId}`,
        { query: "用户画像 语言偏好" }
      );
      return await executeThroughSecurity(
        security,
        tools,
        "memory_write",
        toolCallId,
        memoryWriteArguments({
          operation: "profile_update",
          profileKey: "preference.language",
          text
        })
      );
    };

    const created = await writeProfile(
      "profile-create",
      "用户偏好中文"
    );
    const createdId = (created.details.recordIds as readonly string[])[0]!;
    assert.equal(memoryResultPayload(created).outcome, "profile_updated");
    const duplicate = await writeProfile(
      "profile-idempotent",
      "用户偏好中文"
    );
    assert.equal(memoryResultPayload(duplicate).outcome, "already_present");
    assert.doesNotMatch(duplicate.content[0]?.text ?? "", /"status":"idempotent"/u);
    assert.deepEqual(duplicate.details.recordIds, [createdId]);

    const replaced = await writeProfile(
      "profile-replace",
      "用户偏好英文"
    );
    assert.equal(memoryResultPayload(replaced).outcome, "profile_updated");
    const replacementId = (replaced.details.recordIds as readonly string[])[0]!;
    assert.notEqual(replacementId, createdId);
    const state = await fixture.repository.readUserControlState();
    const profileRecords = state.records.filter((record) =>
      record.title === "用户画像：语言"
    );
    assert.equal(profileRecords.filter((record) => record.status === "current").length, 1);
    assert.equal(profileRecords.find((record) => record.id === createdId)?.status, "superseded");
    assert.equal(profileRecords.find((record) => record.id === replacementId)?.status, "current");
    const user = await readFile(fixture.repository.layout.user, "utf8");
    assert.match(user, /用户偏好英文/u);
    assert.doesNotMatch(user, /用户偏好中文/u);
  });

  await withPersonalMemoryFixture(async (fixture) => {
    const generic = await fixture.repository.write({
      operation: "create",
      kind: "fact",
      title: "用户称呼",
      content: "用户希望称为方哥",
      recallWhen: "称呼用户时",
      basis: "explicit",
      contentOrigin: "user_statement"
    }, fixture.runtime());
    const promoted = await fixture.repository.write({
      operation: "profile_update",
      profileKey: "identity.name",
      text: "用户希望称为方哥",
      basis: "explicit",
      contentOrigin: "user_statement",
      expectedRevision: generic.revision
    }, fixture.runtime());
    assert.equal(promoted.record?.id, generic.record?.id,
      "an exact generic fact is promoted as the profile source instead of duplicated");
    const afterPromotion = await fixture.repository.inspect();
    assert.equal(afterPromotion.records.filter((record) => record.status === "current").length, 1);
    assert.match(await readFile(fixture.repository.layout.user, "utf8"), /用户希望称为方哥/u);
  });

  await withPersonalMemoryFixture(async (fixture) => {
    const wrong = await fixture.repository.write({
      operation: "create",
      kind: "fact",
      title: "用户称呼",
      content: "用户希望称为老王",
      recallWhen: "称呼用户时",
      basis: "explicit",
      contentOrigin: "user_statement"
    }, fixture.runtime());
    const corrected = await fixture.repository.write({
      operation: "profile_update",
      targetId: wrong.record!.id,
      profileKey: "identity.name",
      text: "用户希望称为方哥",
      basis: "explicit",
      contentOrigin: "confirmed_change",
      expectedRevision: wrong.revision
    }, fixture.runtime());
    assert.notEqual(corrected.record?.id, wrong.record?.id);
    const afterCorrection = await fixture.repository.readUserControlState();
    assert.equal(
      afterCorrection.records.find((record) => record.id === wrong.record!.id)?.status,
      "superseded",
      "the searched generic wrong fact must leave current when profile_update corrects it"
    );
    assert.equal(
      afterCorrection.records.filter((record) => record.status === "current").length,
      1,
      "profile correction leaves one current primary Memory for the user fact"
    );
    const user = await readFile(fixture.repository.layout.user, "utf8");
    assert.match(user, /用户希望称为方哥/u);
    assert.doesNotMatch(user, /用户希望称为老王/u);
  });
}

async function scenarioConcurrentWritersUseCas(): Promise<void> {
  await withPersonalMemoryFixture(async (fixture) => {
    const created = await fixture.repository.write({
      operation: "create",
      kind: "view",
      title: "并发观点",
      content: "初始观点。",
      basis: "explicit"
    }, fixture.runtime());
    const secondRepository = await fixture.reopen();
    const expectedRevision = created.revision;
    const writes = await Promise.allSettled([
      fixture.repository.write({
        operation: "supersede",
        targetId: created.record!.id,
        title: "并发观点 A",
        content: "写者 A 的新观点。",
        basis: "explicit",
        reason: "并发测试",
        expectedRevision
      }, fixture.runtime({ userEntryId: "writer-a" })),
      secondRepository.write({
        operation: "supersede",
        targetId: created.record!.id,
        title: "并发观点 B",
        content: "写者 B 的新观点。",
        basis: "explicit",
        reason: "并发测试",
        expectedRevision
      }, fixture.runtime({ userEntryId: "writer-b" }))
    ]);
    assert.equal(writes.filter((result) => result.status === "fulfilled").length, 1);
    const rejected = writes.find((result): result is PromiseRejectedResult => result.status === "rejected");
    assert.ok(rejected?.reason instanceof PersonalMemoryAccessError);
    assert.equal(rejected.reason.code, "revision_conflict");
  });
}

async function scenarioExternalPrimaryTruthWinsWithoutWatchers(): Promise<void> {
  await withPersonalMemoryFixture(async (fixture) => {
    const created = await fixture.repository.write({
      operation: "create",
      kind: "view",
      title: "外部编辑后再替换",
      content: "缓存中的旧正文。",
      recallWhen: "验证外部编辑优先级时",
      basis: "explicit"
    }, fixture.runtime());
    const file = path.join(fixture.repository.layout.root, created.record!.file);
    await writeRecordBody(file, "磁盘上的新正文，不能被旧缓存覆盖。");

    await assert.rejects(fixture.repository.write({
      operation: "supersede",
      targetId: created.record!.id,
      title: "不应成功的替换",
      content: "不应覆盖磁盘正文。",
      recallWhen: "不应生效",
      basis: "explicit",
      reason: "陈旧 revision",
      expectedRevision: created.revision
    }, fixture.runtime()), isRevisionConflict);

    const reconciled = await fixture.repository.read(created.record!.id, fixture.runtime());
    assert.equal(reconciled.revision, created.revision + 1);
    assert.equal(reconciled.record.content, "磁盘上的新正文，不能被旧缓存覆盖。");
    assert.match(reconciled.record.source, /^user-edit:\/\/personal-memory\//u);
  }, { watchExternalChanges: false });

  await withPersonalMemoryFixture(async (fixture) => {
    const created = await fixture.repository.write({
      operation: "create",
      kind: "task",
      title: "外部删除后再关闭",
      content: "这条记录会从磁盘删除。",
      recallWhen: "验证外部删除优先级时",
      basis: "explicit"
    }, fixture.runtime());
    const file = path.join(fixture.repository.layout.root, created.record!.file);
    await rm(file);

    await assert.rejects(fixture.repository.write({
      operation: "close",
      targetId: created.record!.id,
      reason: "陈旧缓存不得复活删除记录",
      expectedRevision: created.revision
    }, fixture.runtime()), isRevisionConflict);

    const reconciled = await fixture.repository.inspect();
    assert.equal(reconciled.revision, created.revision + 1);
    assert.equal(reconciled.records.some((record) => record.id === created.record!.id), false);
  }, { watchExternalChanges: false });

  await withPersonalMemoryFixture(async (fixture) => {
    const created = await fixture.repository.write({
      operation: "create",
      kind: "fact",
      title: "外部编辑后忘记",
      content: "缓存中的旧事实。",
      recallWhen: "验证忘记备份时",
      basis: "explicit"
    }, fixture.runtime());
    const file = path.join(fixture.repository.layout.root, created.record!.file);
    await writeRecordBody(file, "外部修正后的事实必须进入忘记备份。");

    await assert.rejects(
      fixture.repository.forgetFromUserControl(
        created.record!.id,
        "先用陈旧 revision 尝试",
        created.revision
      ),
      isRevisionConflict
    );
    const reconciled = await fixture.repository.inspect();
    const forgotten = await fixture.repository.forgetFromUserControl(
      created.record!.id,
      "确认忘记外部修正后的事实",
      reconciled.revision
    );
    const afterForget = await fixture.repository.inspect();
    const tombstone = afterForget.tombstones.find((item) => item.recordId === forgotten.forgottenId);
    assert.ok(tombstone);
    assert.match(
      await readFile(path.join(fixture.repository.layout.root, tombstone.backupFile), "utf8"),
      /外部修正后的事实必须进入忘记备份/u
    );
  }, { watchExternalChanges: false });

  await withPersonalMemoryFixture(async (fixture) => {
    const created = await fixture.repository.write({
      operation: "create",
      kind: "decision",
      title: "外部编辑后界面修正",
      content: "缓存中的旧决定。",
      recallWhen: "验证界面修正冲突时",
      basis: "explicit"
    }, fixture.runtime());
    const file = path.join(fixture.repository.layout.root, created.record!.file);
    await writeRecordBody(file, "外部修正后的决定必须保留。");

    await assert.rejects(fixture.repository.supersedeFromUserCorrection({
      targetId: created.record!.id,
      title: "界面生成的新决定",
      content: "不应覆盖外部正文。",
      recallWhen: "不应生效",
      reason: "陈旧界面预览",
      expectedRevision: created.revision
    }), isRevisionConflict);

    const reconciled = await fixture.repository.read(created.record!.id, fixture.runtime());
    assert.equal(reconciled.record.content, "外部修正后的决定必须保留。");
  }, { watchExternalChanges: false });

  await withPersonalMemoryFixture(async (fixture) => {
    const edited = await fixture.repository.write({
      operation: "create",
      kind: "episode",
      title: "导出中的外部编辑",
      content: "导出前的旧正文。",
      recallWhen: "验证导出磁盘真源时",
      basis: "explicit"
    }, fixture.runtime());
    const deleted = await fixture.repository.write({
      operation: "create",
      kind: "fact",
      title: "导出前已从磁盘删除",
      content: "这条记录不应进入导出。",
      recallWhen: "验证导出排除删除时",
      basis: "explicit"
    }, fixture.runtime());
    await writeRecordBody(
      path.join(fixture.repository.layout.root, edited.record!.file),
      "导出必须包含这段磁盘新正文。"
    );
    await rm(path.join(fixture.repository.layout.root, deleted.record!.file));

    const exported = await fixture.repository.exportMemory();
    const exportText = await readFile(exported.path, "utf8");
    assert.match(exportText, /导出必须包含这段磁盘新正文/u);
    assert.doesNotMatch(exportText, /导出前已从磁盘删除/u);
    const reconciled = await fixture.repository.inspect();
    assert.equal(reconciled.records.some((record) => record.id === deleted.record!.id), false);
  }, { watchExternalChanges: false });

  console.log("PASS P1 primary mutations and export reconcile disk truth without watchers");
}

async function scenarioRepositoryDisposeStopsExternalWatchers(): Promise<void> {
  await withPersonalMemoryFixture(async (fixture) => {
    const created = await fixture.repository.write({
      operation: "create",
      kind: "fact",
      title: "dispose watcher 验证",
      content: "关闭前正文。",
      recallWhen: "验证插件卸载后监听生命周期时",
      basis: "explicit"
    }, fixture.runtime());
    let repository = fixture.repository;
    for (let index = 0; index < 3; index += 1) {
      await repository.dispose();
      const before = await Promise.all([
        readFile(repository.layout.manifest, "utf8"),
        readFile(repository.layout.audit, "utf8"),
        readFile(repository.layout.searchIndex, "utf8")
      ]);
      await writeFile(repository.layout.agent, `# 卸载后的 AGENT 外部编辑 ${index}\n`, "utf8");
      await writeFile(repository.layout.user, `# 卸载后的 USER 外部编辑 ${index}\n`, "utf8");
      await writeRecordBody(
        path.join(repository.layout.root, created.record!.file),
        `卸载后的一级 Memory 外部编辑 ${index}。`
      );
      await Promise.all([
        repository.handleExternalChange({
          event: "change",
          relativePath: "agents/echoink/AGENT.md"
        }),
        repository.handleExternalChange({
          event: "change",
          relativePath: "shared-user/USER.md"
        }),
        repository.handleExternalChange({
          event: "change",
          relativePath: created.record!.file
        })
      ]);
      await new Promise((resolve) => setTimeout(resolve, 80));
      const after = await Promise.all([
        readFile(repository.layout.manifest, "utf8"),
        readFile(repository.layout.audit, "utf8"),
        readFile(repository.layout.searchIndex, "utf8")
      ]);
      assert.deepEqual(after, before,
        "disposed and previously reloaded repositories cannot mutate derived state");
      if (index < 2) repository = await fixture.reopen();
    }

    await assert.rejects(
      fixture.repository.exportMemory(),
      /Repository is disposed/u
    );
  });
  console.log("PASS P1 repository dispose stops watcher mutations across repeated reloads");
}

async function writeRecordBody(file: string, content: string): Promise<void> {
  const current = await readFile(file, "utf8");
  const closingFrontmatter = current.indexOf("\n---\n", 4);
  assert.ok(closingFrontmatter > 0, "fixture record must contain closing frontmatter");
  await writeFile(file, `${current.slice(0, closingFrontmatter + 5)}\n${content.trim()}\n`, "utf8");
}

function isRevisionConflict(error: unknown): boolean {
  return error instanceof PersonalMemoryAccessError && error.code === "revision_conflict";
}

function createSecurity(
  fixture: Readonly<PersonalMemoryFixture>,
  entry: Readonly<{ entryId: string; text: string }>,
  runtime: Readonly<PersonalMemoryRuntimeContext>
): PiPersonalMemoryToolSecurity {
  return new PiPersonalMemoryToolSecurity({
    currentRuntime: () => runtime,
    currentUserEntry: { current: () => entry }
  });
}

function createArguments(kind: "fact" | "view" = "fact"): MemoryWriteToolArguments {
  return memoryWriteArguments({
    operation: "create",
    kind,
    title: "回答规则",
    content: "回答先给结论。",
    recallWhen: "准备回答工程问题时"
  });
}

function memoryWriteArguments(
  request: MemoryWriteToolArguments["request"]
): MemoryWriteToolArguments {
  return Object.freeze({ request: Object.freeze({ ...request }) });
}

function memoryResultPayload(result: Readonly<{
  content: Array<{ type: "text"; text: string }>;
}>): Readonly<Record<string, unknown>> {
  const match = (result.content[0]?.text ?? "").match(
    /<echoink_memory_result[^>]*>\n([\s\S]+)\n<\/echoink_memory_result>/u
  );
  const json = match?.[1];
  assert.ok(json, "memory Tool result must contain one complete structured payload");
  return JSON.parse(json) as Readonly<Record<string, unknown>>;
}

async function executeThroughSecurity(
  security: PiPersonalMemoryToolSecurity,
  tools: ReturnType<typeof createPiPersonalMemoryToolDefinitions>,
  toolName: (typeof PI_PERSONAL_MEMORY_TOOL_IDS)[number],
  toolCallId: string,
  input: Record<string, unknown> | MemoryWriteToolArguments
) {
  const tool = tools.find((candidate) => candidate.name === toolName);
  assert.ok(tool);
  const blocked = await security.handleToolCall({ toolName, toolCallId, input } as never, undefined);
  assert.equal(blocked, undefined);
  let raw;
  try {
    raw = await tool.execute(
      toolCallId,
      input,
      new AbortController().signal,
      undefined,
      {} as never
    );
  } catch (error) {
    await security.handleToolResult({
      toolName,
      toolCallId,
      content: [],
      details: {},
      isError: true
    } as never);
    throw error;
  }
  return await security.handleToolResult({
    toolName,
    toolCallId,
    content: raw.content,
    details: raw.details,
    isError: false
  } as never);
}

async function executeFailureThroughSecurity(
  security: PiPersonalMemoryToolSecurity,
  tools: ReturnType<typeof createPiPersonalMemoryToolDefinitions>,
  toolName: (typeof PI_PERSONAL_MEMORY_TOOL_IDS)[number],
  toolCallId: string,
  input: Record<string, unknown>
) {
  const tool = tools.find((candidate) => candidate.name === toolName);
  assert.ok(tool);
  assert.equal(
    await security.handleToolCall({ toolName, toolCallId, input } as never, undefined),
    undefined
  );
  await assert.rejects(() => tool.execute(
    toolCallId,
    input,
    new AbortController().signal,
    undefined,
    {} as never
  ));
  return await security.handleToolResult({
    toolName,
    toolCallId,
    content: [],
    details: {},
    isError: true
  } as never);
}
