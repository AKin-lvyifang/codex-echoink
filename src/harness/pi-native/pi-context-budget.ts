import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  convertToLlm,
  formatSkillsForPrompt,
  sessionEntryToContextMessages,
  type BeforeAgentStartEvent,
  type SessionEntry,
  type SessionManager
} from "@earendil-works/pi-coding-agent";
import type { Context, Message, Model } from "@earendil-works/pi-ai";
import { estimateTokenValue, ESTIMATED_IMAGE_TOKENS } from "../usage/token-estimator";
import {
  calculatePiEffectiveInputBudget,
  PiContextBudgetError,
  type PiEffectiveInputBudget
} from "./pi-effective-input-budget";

export {
  calculatePiEffectiveInputBudget,
  PI_DEFAULT_KEEP_RECENT_TOKENS,
  PI_EFFECTIVE_INPUT_RATIO,
  PiContextBudgetError,
  type PiEffectiveInputBudget
} from "./pi-effective-input-budget";

export const PI_CONTEXT_LEDGER_CUSTOM_TYPE =
  "echoink.context-ledger.v1" as const;
export const PI_CONTEXT_LEDGER_SCHEMA_VERSION = 1 as const;
export const PI_PERSONAL_MEMORY_CONTEXT_CUSTOM_TYPE =
  "echoink-personal-memory-context-v1" as const;

export const PI_CONTEXT_CATEGORY_IDS = Object.freeze([
  "system",
  "vault_tool_schema",
  "mcp_tool_schema",
  "skill",
  "conversation",
  "compaction",
  "memory",
  "knowledge",
  "temporary_materials"
] as const);

export type PiContextCategoryId =
  typeof PI_CONTEXT_CATEGORY_IDS[number];
export type PiTokenMeasurementAccuracy = "exact" | "estimated";
export type PiContextLedgerRequestKind = "agent" | "summarization";

export interface PiContextCategoryUsage {
  readonly category: PiContextCategoryId;
  readonly tokens: number;
  readonly accuracy: PiTokenMeasurementAccuracy;
}

export interface PiContextCompactionBoundary {
  readonly summaryEntryId: string;
  readonly firstKeptEntryId: string;
  readonly tokensBefore: number;
  readonly summaryTokens: number;
  readonly recentMessageCount: number;
  readonly recentTokens: number;
}

export interface PiPersonalMemoryContextEvidence {
  /** Optional only for backward compatibility with pre-observability ledgers. */
  readonly mode?: "normal" | "no_memory" | "not_applicable";
  readonly effectiveMode?: "normal" | "no_memory" | "not_applicable";
  readonly capability?:
    | "read_write"
    | "read_only"
    | "recall_only"
    | "fixed_context_only"
    | "not_applicable";
  readonly fixedContextRevision?: number | null;
  readonly recall?: Readonly<PiPersonalMemoryRecallEvidence>;
  readonly injectionKeys: readonly Readonly<{
    key: string;
    count: number;
  }>[];
  readonly toolResults: readonly Readonly<{
    toolName: string;
    toolCallId: string;
    count: number;
  }>[];
  readonly withinOnceBoundary: boolean;
}

export interface PiPersonalMemoryRecallEvidence {
  readonly result: "completed" | "skipped_no_memory" | "failed";
  readonly stage: "loading" | "catalog" | "matching" | "budgeting" | "assembling";
  readonly elapsedMs: number;
  readonly scanned: number;
  readonly candidates: number;
  readonly injected: number;
  readonly remaining: number;
  readonly exhausted: boolean;
}

export interface PiContextLedger {
  readonly schemaVersion: typeof PI_CONTEXT_LEDGER_SCHEMA_VERSION;
  readonly conversationId: string;
  readonly piSessionId: string;
  readonly productRunId: string;
  /** Optional only for backward compatibility with pre-observability ledgers. */
  readonly requestKind?: PiContextLedgerRequestKind;
  readonly requestSequence: number;
  readonly requestLeafId: string | null;
  readonly recordedAt: number;
  readonly model: Readonly<{
    provider: string;
    id: string;
  }>;
  readonly budget: Readonly<PiEffectiveInputBudget>;
  readonly accuracy: PiTokenMeasurementAccuracy;
  readonly categories: readonly Readonly<PiContextCategoryUsage>[];
  readonly totalInputTokens: number;
  readonly remainingInputTokens: number;
  readonly overBudgetTokens: number;
  readonly compaction: Readonly<PiContextCompactionBoundary> | null;
  readonly personalMemory: Readonly<PiPersonalMemoryContextEvidence>;
  readonly diagnostics: readonly string[];
}

export interface PiContextTokenMeasurement {
  readonly tokens: number;
  readonly accuracy: PiTokenMeasurementAccuracy;
}

export type PiContextTokenCounter = (
  value: unknown
) => Readonly<PiContextTokenMeasurement>;

export interface BuildPiContextLedgerInput {
  readonly conversationId: string;
  readonly piSessionId: string;
  readonly productRunId: string;
  readonly requestKind?: PiContextLedgerRequestKind;
  readonly requestSequence: number;
  readonly requestLeafId: string | null;
  readonly recordedAt: number;
  readonly model: Pick<Model<any>, "provider" | "id">;
  readonly budget: Readonly<PiEffectiveInputBudget>;
  readonly context: Readonly<Context>;
  /** Native attachments added to the wire payload outside text Context. */
  readonly additionalInputTokens?: number;
  readonly contextEntries: readonly SessionEntry[];
  readonly transientContextMessages?: readonly AgentMessage[];
  readonly vaultToolNames: ReadonlySet<string>;
  readonly memoryToolNames?: ReadonlySet<string>;
  readonly personalMemoryAccess?: Readonly<Pick<
    PiPersonalMemoryContextEvidence,
    "mode" | "effectiveMode" | "capability" | "fixedContextRevision" | "recall"
  >>;
  readonly mcpToolNames: ReadonlySet<string>;
  readonly systemSkillFragment?: string;
  readonly tokenCounter?: PiContextTokenCounter;
}

export interface PiContextLedgerRecorderOptions {
  readonly conversationId: string;
  readonly piSessionId: string;
  readonly sessionManager: SessionManager;
  readonly model: Pick<Model<any>, "provider" | "id" | "contextWindow">;
  readonly budget: Readonly<PiEffectiveInputBudget>;
  readonly vaultToolNames: readonly string[];
  readonly memoryToolNames?: readonly string[];
  readonly mcpToolNames: readonly string[];
  readonly now?: () => number;
  readonly tokenCounter?: PiContextTokenCounter;
}

export interface PiContextLedgerExecutionIdentity {
  readonly runId: string;
  readonly conversationId: string;
}

/**
 * Records only the Context that is actually passed to EchoInk's controlled
 * Provider. It never assembles or mutates a second request.
 */
export class PiContextLedgerRecorder {
  private readonly now: () => number;
  private readonly mcpToolNames: ReadonlySet<string>;
  private readonly memoryToolNames: ReadonlySet<string>;
  private readonly vaultToolNames: ReadonlySet<string>;
  private readonly tokenCounter?: PiContextTokenCounter;
  private requestSequence = 0;
  private expectedSystemPrompt: string | null = null;
  private systemSkillFragment = "";
  private transientContextMessages: readonly AgentMessage[] = Object.freeze([]);
  private personalMemoryAccess: BuildPiContextLedgerInput["personalMemoryAccess"];

  constructor(private readonly options: PiContextLedgerRecorderOptions) {
    if (
      !nonEmptyText(options.conversationId)
      || !nonEmptyText(options.piSessionId)
      || options.sessionManager.getSessionId() !== options.piSessionId
      || options.model.contextWindow !== options.budget.contextWindow
    ) {
      throw new PiContextBudgetError(
        "Pi Context ledger recorder identity or model budget is incompatible"
      );
    }
    this.now = options.now ?? Date.now;
    this.mcpToolNames = new Set(options.mcpToolNames);
    this.memoryToolNames = new Set(options.memoryToolNames ?? []);
    this.vaultToolNames = new Set(options.vaultToolNames);
    this.tokenCounter = options.tokenCounter;
  }

  captureBeforeAgentStart(event: Readonly<BeforeAgentStartEvent>): void {
    this.expectedSystemPrompt = event.systemPrompt;
    const skills = event.systemPromptOptions.skills ?? [];
    const candidate = skills.length > 0
      ? formatSkillsForPrompt([...skills])
      : "";
    this.systemSkillFragment = candidate && event.systemPrompt.includes(candidate)
      ? candidate
      : "";
  }

  captureTransientContextMessages(messages: readonly AgentMessage[]): void {
    // These messages exist only in Pi's per-request context transform, so the
    // durable Session cannot be used to infer their Provider category.
    this.transientContextMessages = Object.freeze(
      messages.map((message) => structuredClone(message))
    );
  }

  capturePersonalMemoryAccess(
    access: NonNullable<BuildPiContextLedgerInput["personalMemoryAccess"]>
  ): void {
    this.personalMemoryAccess = Object.freeze({ ...access });
  }

  recordProviderRequest(
    context: Readonly<Context>,
    execution: Readonly<PiContextLedgerExecutionIdentity>,
    additionalInputTokens = 0
  ): PiContextLedger | null {
    if (execution.conversationId !== this.options.conversationId) {
      return null;
    }
    const requestKind: PiContextLedgerRequestKind = this.expectedSystemPrompt
      && context.systemPrompt === this.expectedSystemPrompt
      ? "agent"
      : "summarization";
    this.requestSequence += 1;
    const ledger = buildPiContextLedger({
      conversationId: this.options.conversationId,
      piSessionId: this.options.piSessionId,
      productRunId: execution.runId,
      requestKind,
      requestSequence: this.requestSequence,
      requestLeafId: this.options.sessionManager.getLeafId(),
      recordedAt: this.now(),
      model: this.options.model,
      budget: this.options.budget,
      context,
      additionalInputTokens,
      contextEntries: this.options.sessionManager.buildContextEntries(),
      transientContextMessages: requestKind === "agent"
        ? this.transientContextMessages
        : [],
      vaultToolNames: this.vaultToolNames,
      memoryToolNames: this.memoryToolNames,
      ...(requestKind === "summarization"
        ? {
            personalMemoryAccess: {
              mode: "not_applicable" as const,
              effectiveMode: "not_applicable" as const,
              capability: "not_applicable" as const,
              fixedContextRevision: null
            }
          }
        : this.personalMemoryAccess
        ? { personalMemoryAccess: this.personalMemoryAccess }
        : {}),
      mcpToolNames: this.mcpToolNames,
      ...(requestKind === "agent" && this.systemSkillFragment
        ? { systemSkillFragment: this.systemSkillFragment }
        : {}),
      ...(this.tokenCounter ? { tokenCounter: this.tokenCounter } : {})
    });
    this.options.sessionManager.appendCustomEntry(
      PI_CONTEXT_LEDGER_CUSTOM_TYPE,
      ledger
    );
    return ledger;
  }
}

export function buildPiContextLedger(
  input: Readonly<BuildPiContextLedgerInput>
): PiContextLedger {
  const counter = input.tokenCounter ?? estimatePiContextTokens;
  const accumulator = new CategoryAccumulator(counter);
  if (input.additionalInputTokens) {
    accumulator.addMeasurement("temporary_materials", {
      tokens: input.additionalInputTokens,
      accuracy: "estimated"
    });
  }
  const memoryToolNames = input.memoryToolNames ?? new Set<string>();
  const systemPrompt = input.context.systemPrompt ?? "";
  if (systemPrompt) {
    const full = counter(systemPrompt);
    const skill = input.systemSkillFragment
      && systemPrompt.includes(input.systemSkillFragment)
      ? counter(input.systemSkillFragment)
      : null;
    if (skill && skill.tokens > 0) {
      accumulator.addMeasurement("skill", skill);
      accumulator.addMeasurement("system", {
        tokens: Math.max(0, full.tokens - skill.tokens),
        accuracy: combinedAccuracy(full.accuracy, skill.accuracy)
      });
    } else {
      accumulator.addMeasurement("system", full);
    }
  }

  for (const tool of input.context.tools ?? []) {
    accumulator.add(
      memoryToolNames.has(tool.name)
        ? "memory"
        : input.mcpToolNames.has(tool.name)
        ? "mcp_tool_schema"
        : "vault_tool_schema",
      tool
    );
  }

  const origins = messageOriginQueues(
    input.contextEntries,
    input.transientContextMessages ?? []
  );
  let recentMessageCount = 0;
  let recentTokens = 0;
  for (const message of input.context.messages) {
    const origin = origins.get(providerMessageFingerprint(message))?.shift()
      ?? "conversation";
    const measurement = counter(message);
    if (message.role === "toolResult" && memoryToolNames.has(message.toolName)) {
      accumulator.addMeasurement("memory", measurement);
    } else if (origin === "conversation") {
      recentMessageCount += 1;
      recentTokens += measurement.tokens;
      addConversationMessage(accumulator, message, measurement, counter);
    } else {
      accumulator.addMeasurement(origin, measurement);
    }
  }

  const categories = accumulator.snapshot();
  const totalInputTokens = categories.reduce(
    (total, category) => total + category.tokens,
    0
  );
  const remainingInputTokens = Math.max(
    0,
    input.budget.effectiveInputBudget - totalInputTokens
  );
  const overBudgetTokens = Math.max(
    0,
    totalInputTokens - input.budget.effectiveInputBudget
  );
  const compaction = contextCompactionBoundary({
    entries: input.contextEntries,
    summaryTokens: categories.find(
      (category) => category.category === "compaction"
    )?.tokens ?? 0,
    recentMessageCount,
    recentTokens
  });
  const accuracy = categories.some(
    (category) => category.accuracy === "estimated"
  ) ? "estimated" : "exact";
  const personalMemory = buildPersonalMemoryContextEvidence(
    input.context.messages,
    input.transientContextMessages ?? [],
    memoryToolNames,
    effectivePersonalMemoryAccess(
      input.context,
      memoryToolNames,
      input.personalMemoryAccess,
      input.requestKind ?? "agent"
    )
  );
  const diagnostics = [
    ...(accuracy === "estimated"
      ? ["按 EchoInk 通用 Token 标准估算输入内容；不等同于服务商账单。"]
      : []),
    ...(overBudgetTokens > 0
      ? ["本轮输入估算已超过 effectiveInputBudget，Pi 将按同一边界触发原生 Compaction。"]
      : []),
    ...unexpectedToolDiagnostics(
      input.context,
      input.vaultToolNames,
      memoryToolNames,
      input.mcpToolNames
    ),
    ...(!personalMemory.withinOnceBoundary
      ? ["Personal Memory injection key or Tool Result entered the final Provider Request more than once."]
      : [])
  ];
  return freezeLedger({
    schemaVersion: PI_CONTEXT_LEDGER_SCHEMA_VERSION,
    conversationId: input.conversationId,
    piSessionId: input.piSessionId,
    productRunId: input.productRunId,
    requestKind: input.requestKind ?? "agent",
    requestSequence: input.requestSequence,
    requestLeafId: input.requestLeafId,
    recordedAt: input.recordedAt,
    model: {
      provider: input.model.provider,
      id: input.model.id
    },
    budget: input.budget,
    accuracy,
    categories,
    totalInputTokens,
    remainingInputTokens,
    overBudgetTokens,
    compaction,
    personalMemory,
    diagnostics
  });
}

export function estimatePiContextTokens(
  value: unknown
): PiContextTokenMeasurement {
  return Object.freeze({
    tokens: estimateTokenValue(value),
    accuracy: "estimated"
  });
}

export function latestPiContextLedger(
  entries: readonly SessionEntry[]
): PiContextLedger | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (
      entry?.type === "custom"
      && entry.customType === PI_CONTEXT_LEDGER_CUSTOM_TYPE
    ) {
      const parsed = parsePiContextLedger(entry.data);
      if (parsed) return parsed;
    }
  }
  return null;
}

export function parsePiContextLedger(value: unknown): PiContextLedger | null {
  if (!recordValue(value)) return null;
  if (
    value.schemaVersion !== PI_CONTEXT_LEDGER_SCHEMA_VERSION
    || !nonEmptyText(value.conversationId)
    || !nonEmptyText(value.piSessionId)
    || !nonEmptyText(value.productRunId)
    || !(
      value.requestKind === undefined
      || value.requestKind === "agent"
      || value.requestKind === "summarization"
    )
    || !positiveSafeInteger(value.requestSequence)
    || !(value.requestLeafId === null || nonEmptyText(value.requestLeafId))
    || !nonNegativeSafeInteger(value.recordedAt)
    || !recordValue(value.model)
    || !nonEmptyText(value.model.provider)
    || !nonEmptyText(value.model.id)
    || !recordValue(value.budget)
    || !validBudgetRecord(value.budget)
    || !validAccuracy(value.accuracy)
    || !Array.isArray(value.categories)
    || !nonNegativeSafeInteger(value.totalInputTokens)
    || !nonNegativeSafeInteger(value.remainingInputTokens)
    || !nonNegativeSafeInteger(value.overBudgetTokens)
    || !(value.compaction === null || validCompactionRecord(value.compaction))
    || !boundedTextArray(value.diagnostics, 1_000)
  ) return null;

  const personalMemory = value.personalMemory === undefined
    ? emptyPersonalMemoryContextEvidence()
    : parsePersonalMemoryContextEvidence(value.personalMemory);
  if (!personalMemory) return null;

  const categories: PiContextCategoryUsage[] = [];
  const seen = new Set<PiContextCategoryId>();
  for (const item of value.categories) {
    if (!recordValue(item)) return null;
    const category = item.category;
    if (
      !isPiContextCategoryId(category)
      || seen.has(category)
      || !positiveSafeInteger(item.tokens)
      || !validAccuracy(item.accuracy)
    ) return null;
    seen.add(category);
    categories.push(Object.freeze({
      category,
      tokens: item.tokens,
      accuracy: item.accuracy
    }));
  }
  const categoryTotal = categories.reduce(
    (total, category) => total + category.tokens,
    0
  );
  const budget = value.budget as unknown as PiEffectiveInputBudget;
  if (
    categoryTotal !== value.totalInputTokens
    || value.remainingInputTokens !== Math.max(
      0,
      budget.effectiveInputBudget - categoryTotal
    )
    || value.overBudgetTokens !== Math.max(
      0,
      categoryTotal - budget.effectiveInputBudget
    )
  ) return null;
  return freezeLedger({
    schemaVersion: PI_CONTEXT_LEDGER_SCHEMA_VERSION,
    conversationId: value.conversationId,
    piSessionId: value.piSessionId,
    productRunId: value.productRunId,
    ...(value.requestKind === undefined
      ? {}
      : { requestKind: value.requestKind }),
    requestSequence: value.requestSequence,
    requestLeafId: value.requestLeafId,
    recordedAt: value.recordedAt,
    model: {
      provider: value.model.provider,
      id: value.model.id
    },
    budget: {
      contextWindow: budget.contextWindow,
      maxOutputReserve: budget.maxOutputReserve,
      ratioInputBoundary: budget.ratioInputBoundary,
      outputReserveBoundary: budget.outputReserveBoundary,
      effectiveInputBudget: budget.effectiveInputBudget,
      reserveTokens: budget.reserveTokens,
      keepRecentTokens: budget.keepRecentTokens
    },
    accuracy: value.accuracy,
    categories,
    totalInputTokens: value.totalInputTokens,
    remainingInputTokens: value.remainingInputTokens,
    overBudgetTokens: value.overBudgetTokens,
    compaction: value.compaction === null
      ? null
      : {
          summaryEntryId: value.compaction.summaryEntryId,
          firstKeptEntryId: value.compaction.firstKeptEntryId,
          tokensBefore: value.compaction.tokensBefore,
          summaryTokens: value.compaction.summaryTokens,
          recentMessageCount: value.compaction.recentMessageCount,
          recentTokens: value.compaction.recentTokens
        },
    personalMemory,
    diagnostics: [...value.diagnostics]
  });
}

function effectivePersonalMemoryAccess(
  context: Readonly<Context>,
  memoryToolNames: ReadonlySet<string>,
  access: BuildPiContextLedgerInput["personalMemoryAccess"],
  requestKind: PiContextLedgerRequestKind
): BuildPiContextLedgerInput["personalMemoryAccess"] {
  if (requestKind === "summarization") {
    return Object.freeze({
      mode: "not_applicable",
      effectiveMode: "not_applicable",
      capability: "not_applicable",
      fixedContextRevision: null
    });
  }
  if (!access) return undefined;
  const actualMemoryTools = new Set(
    (context.tools ?? [])
      .map((tool) => tool.name)
      .filter((name) => memoryToolNames.has(name))
  );
  let capability: NonNullable<BuildPiContextLedgerInput["personalMemoryAccess"]>["capability"];
  if (actualMemoryTools.size === 0) {
    capability = access.mode === "no_memory" || access.mode === "not_applicable"
      ? "not_applicable"
      : access.capability === "recall_only"
        ? "recall_only"
        : "fixed_context_only";
  } else if (access.mode === "no_memory" || access.mode === "not_applicable") {
    capability = actualMemoryTools.has("memory_write") ? "read_write" : "read_only";
  } else if (access.capability === "read_only") {
    capability = "read_only";
  } else {
    capability = actualMemoryTools.has("memory_write") ? "read_write" : "read_only";
  }
  return Object.freeze({ ...access, capability });
}

function parsePersonalMemoryContextEvidence(
  value: unknown
): PiPersonalMemoryContextEvidence | null {
  if (
    !recordValue(value)
    || !Array.isArray(value.injectionKeys)
    || !Array.isArray(value.toolResults)
    || typeof value.withinOnceBoundary !== "boolean"
  ) return null;
  const accessFieldsPresent = [
    "mode",
    "effectiveMode",
    "capability",
    "fixedContextRevision"
  ].some((key) => key in value);
  const recall = value.recall === undefined
    ? undefined
    : parsePersonalMemoryRecallEvidence(value.recall);
  if (value.recall !== undefined && !recall) return null;
  const modes = new Set(["normal", "no_memory", "not_applicable"]);
  const capabilities = new Set([
    "read_write",
    "read_only",
    "recall_only",
    "fixed_context_only",
    "not_applicable"
  ]);
  if (
    accessFieldsPresent
    && (
      !modes.has(String(value.mode))
      || !modes.has(String(value.effectiveMode))
      || !capabilities.has(String(value.capability))
      || !(
        value.fixedContextRevision === null
        || nonNegativeSafeInteger(value.fixedContextRevision)
      )
    )
  ) return null;
  const injectionKeys: Array<{ key: string; count: number }> = [];
  const seenKeys = new Set<string>();
  for (const item of value.injectionKeys) {
    if (
      !recordValue(item)
      || !boundedText(item.key, 200)
      || seenKeys.has(item.key)
      || !nonNegativeSafeInteger(item.count)
    ) return null;
    seenKeys.add(item.key);
    injectionKeys.push({ key: item.key, count: item.count });
  }
  const toolResults: Array<{ toolName: string; toolCallId: string; count: number }> = [];
  const seenToolResults = new Set<string>();
  for (const item of value.toolResults) {
    if (
      !recordValue(item)
      || !boundedText(item.toolName, 200)
      || !boundedText(item.toolCallId, 512)
      || !nonNegativeSafeInteger(item.count)
    ) return null;
    const key = `${item.toolName}\u0000${item.toolCallId}`;
    if (seenToolResults.has(key)) return null;
    seenToolResults.add(key);
    toolResults.push({
      toolName: item.toolName,
      toolCallId: item.toolCallId,
      count: item.count
    });
  }
  const withinOnceBoundary = injectionKeys.every((item) => item.count <= 1)
    && toolResults.every((item) => item.count <= 1);
  if (value.withinOnceBoundary !== withinOnceBoundary) return null;
  return Object.freeze({
    ...(accessFieldsPresent
      ? {
          mode: value.mode as "normal" | "no_memory" | "not_applicable",
          effectiveMode: value.effectiveMode as "normal" | "no_memory" | "not_applicable",
          capability: value.capability as
            | "read_write"
            | "read_only"
            | "recall_only"
            | "fixed_context_only"
            | "not_applicable",
          fixedContextRevision: value.fixedContextRevision as number | null,
          ...(recall ? { recall } : {})
        }
      : {}),
    injectionKeys: Object.freeze(injectionKeys.map((item) => Object.freeze(item))),
    toolResults: Object.freeze(toolResults.map((item) => Object.freeze(item))),
    withinOnceBoundary
  });
}

function parsePersonalMemoryRecallEvidence(
  value: unknown
): Readonly<PiPersonalMemoryRecallEvidence> | null {
  if (!recordValue(value)) return null;
  const keys = Object.keys(value).sort();
  if (keys.join("\u0000") !== [
    "candidates",
    "elapsedMs",
    "exhausted",
    "injected",
    "remaining",
    "result",
    "scanned",
    "stage"
  ].join("\u0000")) return null;
  if (
    !["completed", "skipped_no_memory", "failed"].includes(String(value.result))
    || !["loading", "catalog", "matching", "budgeting", "assembling"].includes(String(value.stage))
    || !nonNegativeSafeInteger(value.elapsedMs)
    || !nonNegativeSafeInteger(value.scanned)
    || !nonNegativeSafeInteger(value.candidates)
    || !nonNegativeSafeInteger(value.injected)
    || !nonNegativeSafeInteger(value.remaining)
    || typeof value.exhausted !== "boolean"
    || value.candidates > value.scanned
    || value.injected > value.candidates
  ) return null;
  return Object.freeze({
    result: value.result as PiPersonalMemoryRecallEvidence["result"],
    stage: value.stage as PiPersonalMemoryRecallEvidence["stage"],
    elapsedMs: value.elapsedMs,
    scanned: value.scanned,
    candidates: value.candidates,
    injected: value.injected,
    remaining: value.remaining,
    exhausted: value.exhausted
  });
}

function emptyPersonalMemoryContextEvidence(): PiPersonalMemoryContextEvidence {
  return Object.freeze({
    injectionKeys: Object.freeze([]),
    toolResults: Object.freeze([]),
    withinOnceBoundary: true
  });
}

class CategoryAccumulator {
  private readonly values = new Map<
    PiContextCategoryId,
    { tokens: number; accuracy: PiTokenMeasurementAccuracy }
  >();

  constructor(private readonly counter: PiContextTokenCounter) {}

  add(category: PiContextCategoryId, value: unknown): void {
    this.addMeasurement(category, this.counter(value));
  }

  addMeasurement(
    category: PiContextCategoryId,
    measurement: Readonly<PiContextTokenMeasurement>
  ): void {
    if (!nonNegativeSafeInteger(measurement.tokens)) {
      throw new PiContextBudgetError("Context token counter returned invalid tokens");
    }
    if (measurement.tokens === 0) return;
    const current = this.values.get(category);
    this.values.set(category, {
      tokens: (current?.tokens ?? 0) + measurement.tokens,
      accuracy: combinedAccuracy(
        current?.accuracy ?? "exact",
        measurement.accuracy
      )
    });
  }

  snapshot(): readonly PiContextCategoryUsage[] {
    return Object.freeze(PI_CONTEXT_CATEGORY_IDS.flatMap((category) => {
      const value = this.values.get(category);
      return value
        ? [Object.freeze({ category, ...value })]
        : [];
    }));
  }
}

function addConversationMessage(
  accumulator: CategoryAccumulator,
  message: Readonly<Message>,
  full: Readonly<PiContextTokenMeasurement>,
  counter: PiContextTokenCounter
): void {
  const skillFragment = skillEnvelopeFromMessage(message);
  const imageCount = imageCountInMessage(message);
  let assignedTokens = 0;
  let assignedAccuracy: PiTokenMeasurementAccuracy = full.accuracy;
  if (skillFragment) {
    const skill = counter(skillFragment);
    assignedTokens += Math.min(full.tokens, skill.tokens);
    assignedAccuracy = combinedAccuracy(assignedAccuracy, skill.accuracy);
    accumulator.addMeasurement("skill", {
      tokens: Math.min(full.tokens, skill.tokens),
      accuracy: skill.accuracy
    });
  }
  if (imageCount > 0) {
    const temporaryTokens = Math.min(
      Math.max(0, full.tokens - assignedTokens),
      imageCount * ESTIMATED_IMAGE_TOKENS
    );
    assignedTokens += temporaryTokens;
    accumulator.addMeasurement("temporary_materials", {
      tokens: temporaryTokens,
      accuracy: "estimated"
    });
    assignedAccuracy = "estimated";
  }
  accumulator.addMeasurement("conversation", {
    tokens: Math.max(0, full.tokens - assignedTokens),
    accuracy: assignedAccuracy
  });
}

function messageOriginQueues(
  entries: readonly SessionEntry[],
  transientMessages: readonly AgentMessage[]
): Map<string, PiContextMessageOrigin[]> {
  const result = new Map<string, PiContextMessageOrigin[]>();
  for (const entry of entries) {
    const origin = contextCategoryForEntry(entry);
    for (const message of convertToLlm(sessionEntryToContextMessages(entry))) {
      const fingerprint = providerMessageFingerprint(message);
      const queue = result.get(fingerprint) ?? [];
      queue.push(origin);
      result.set(fingerprint, queue);
    }
  }
  for (const message of transientMessages) {
    const origin = contextCategoryForAgentMessage(message);
    for (const providerMessage of convertToLlm([structuredClone(message)])) {
      const fingerprint = providerMessageFingerprint(providerMessage);
      const queue = result.get(fingerprint) ?? [];
      queue.push(origin);
      result.set(fingerprint, queue);
    }
  }
  return result;
}

function buildPersonalMemoryContextEvidence(
  providerMessages: readonly Message[],
  transientMessages: readonly AgentMessage[],
  memoryToolNames: ReadonlySet<string>,
  access?: BuildPiContextLedgerInput["personalMemoryAccess"]
): PiPersonalMemoryContextEvidence {
  const providerFingerprintCounts = new Map<string, number>();
  for (const message of providerMessages) {
    const fingerprint = providerMessageFingerprint(message);
    providerFingerprintCounts.set(
      fingerprint,
      (providerFingerprintCounts.get(fingerprint) ?? 0) + 1
    );
  }
  const injectionKeyCounts = new Map<string, number>();
  for (const message of transientMessages) {
    if (
      message.role !== "custom"
      || message.customType !== "echoink-personal-memory-context-v1"
    ) continue;
    const details = recordValue(message.details) ? message.details : null;
    const keys = Array.isArray(details?.injectionKeys)
      ? details.injectionKeys.filter((key): key is string => boundedText(key, 200))
      : [];
    const count = convertToLlm([structuredClone(message)])
      .reduce((total, providerMessage) =>
        total + (providerFingerprintCounts.get(providerMessageFingerprint(providerMessage)) ?? 0), 0);
    for (const key of keys) {
      injectionKeyCounts.set(key, (injectionKeyCounts.get(key) ?? 0) + count);
    }
  }

  const toolResultCounts = new Map<string, {
    toolName: string;
    toolCallId: string;
    count: number;
  }>();
  for (const message of providerMessages) {
    if (
      message.role !== "toolResult"
      || !memoryToolNames.has(message.toolName)
      || !boundedText(message.toolCallId, 512)
    ) continue;
    const key = `${message.toolName}\u0000${message.toolCallId}`;
    const current = toolResultCounts.get(key);
    toolResultCounts.set(key, {
      toolName: message.toolName,
      toolCallId: message.toolCallId,
      count: (current?.count ?? 0) + 1
    });
  }
  const injectionKeys = [...injectionKeyCounts.entries()]
    .map(([key, count]) => Object.freeze({ key, count }))
    .sort((left, right) => left.key.localeCompare(right.key));
  const toolResults = [...toolResultCounts.values()]
    .map((item) => Object.freeze({ ...item }))
    .sort((left, right) =>
      left.toolName.localeCompare(right.toolName)
      || left.toolCallId.localeCompare(right.toolCallId));
  return Object.freeze({
    ...(access ? { ...access } : {}),
    injectionKeys: Object.freeze(injectionKeys),
    toolResults: Object.freeze(toolResults),
    withinOnceBoundary: injectionKeys.every((item) => item.count <= 1)
      && toolResults.every((item) => item.count <= 1)
  });
}

type PiContextMessageOrigin = PiContextCategoryId;

function contextCategoryForEntry(entry: SessionEntry): PiContextMessageOrigin {
  if (entry.type === "compaction") return "compaction";
  if (entry.type === "custom_message") {
    return contextCategoryForCustomType(entry.customType);
  }
  return "conversation";
}

function contextCategoryForAgentMessage(
  message: AgentMessage
): PiContextMessageOrigin {
  return message.role === "custom"
    ? contextCategoryForCustomType(message.customType)
    : "conversation";
}

function contextCategoryForCustomType(customType: string): PiContextMessageOrigin {
  if (customType === PI_PERSONAL_MEMORY_CONTEXT_CUSTOM_TYPE) return "memory";
  if (customType === "echoink-memory-enrichment-v1") return "memory";
  if (
    customType === "echoink-knowledge-ask-resource-v1"
    || customType === "echoink-knowledge-maintenance-command-v1"
  ) return "knowledge";
  return "conversation";
}

function providerMessageFingerprint(message: Readonly<Message>): string {
  const normalized: Record<string, unknown> = {
    role: message.role,
    timestamp: message.timestamp,
    content: message.content
  };
  if (message.role === "assistant") {
    normalized.provider = message.provider;
    normalized.model = message.model;
    normalized.stopReason = message.stopReason;
  } else if (message.role === "toolResult") {
    normalized.toolCallId = message.toolCallId;
    normalized.toolName = message.toolName;
    normalized.isError = message.isError;
  }
  return stableStringify(normalized);
}

function skillEnvelopeFromMessage(message: Readonly<Message>): string {
  if (message.role !== "user") return "";
  const firstText = typeof message.content === "string"
    ? message.content
    : message.content.find(
      (item): item is { type: "text"; text: string } => item.type === "text"
    )?.text ?? "";
  const match = firstText.match(
    /^<skill name="[^"]+" location="[^"]+">\n[\s\S]*?\n<\/skill>(?:\n\n|$)/u
  );
  return match?.[0] ?? "";
}

function imageCountInMessage(message: Readonly<Message>): number {
  if (typeof message.content === "string") return 0;
  return message.content.filter((item) => item.type === "image").length;
}

function contextCompactionBoundary(input: {
  entries: readonly SessionEntry[];
  summaryTokens: number;
  recentMessageCount: number;
  recentTokens: number;
}): PiContextCompactionBoundary | null {
  const latest = [...input.entries].reverse().find(
    (entry): entry is Extract<SessionEntry, { type: "compaction" }> =>
      entry.type === "compaction"
  );
  if (!latest) return null;
  return Object.freeze({
    summaryEntryId: latest.id,
    firstKeptEntryId: latest.firstKeptEntryId,
    tokensBefore: Math.max(0, Math.floor(latest.tokensBefore)),
    summaryTokens: input.summaryTokens,
    recentMessageCount: input.recentMessageCount,
    recentTokens: input.recentTokens
  });
}

function unexpectedToolDiagnostics(
  context: Readonly<Context>,
  vaultToolNames: ReadonlySet<string>,
  memoryToolNames: ReadonlySet<string>,
  mcpToolNames: ReadonlySet<string>
): string[] {
  const unknown = (context.tools ?? [])
    .map((tool) => tool.name)
    .filter((name) =>
      !vaultToolNames.has(name)
      && !memoryToolNames.has(name)
      && !mcpToolNames.has(name)
    );
  if (unknown.length === 0) return [];
  const visible = unknown.slice(0, 8).join("、");
  const remainder = unknown.length > 8
    ? `，另有 ${unknown.length - 8} 项`
    : "";
  return [
    `发现未归类的 Pi Tool Schema，暂计入 Vault Tool Schema：${visible}${remainder}`
      .slice(0, 1_000)
  ];
}

function stableStringify(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? typeof value;
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => `${JSON.stringify(key)}:${stableStringify(nested)}`)
    .join(",")}}`;
}

function validBudgetRecord(value: Record<string, unknown>): boolean {
  if (
    !positiveSafeInteger(value.contextWindow)
    || !positiveSafeInteger(value.maxOutputReserve)
    || !positiveSafeInteger(value.ratioInputBoundary)
    || !positiveSafeInteger(value.outputReserveBoundary)
    || !positiveSafeInteger(value.effectiveInputBudget)
    || !positiveSafeInteger(value.reserveTokens)
    || !positiveSafeInteger(value.keepRecentTokens)
  ) return false;
  try {
    const calculated = calculatePiEffectiveInputBudget({
      contextWindow: value.contextWindow,
      maxOutputReserve: value.maxOutputReserve
    });
    return calculated.ratioInputBoundary === value.ratioInputBoundary
      && calculated.outputReserveBoundary === value.outputReserveBoundary
      && calculated.effectiveInputBudget === value.effectiveInputBudget
      && calculated.reserveTokens === value.reserveTokens
      && calculated.keepRecentTokens === value.keepRecentTokens;
  } catch {
    return false;
  }
}

function validCompactionRecord(
  value: unknown
): value is PiContextCompactionBoundary {
  return recordValue(value)
    && nonEmptyText(value.summaryEntryId)
    && nonEmptyText(value.firstKeptEntryId)
    && nonNegativeSafeInteger(value.tokensBefore)
    && nonNegativeSafeInteger(value.summaryTokens)
    && nonNegativeSafeInteger(value.recentMessageCount)
    && nonNegativeSafeInteger(value.recentTokens);
}

function freezeLedger(input: PiContextLedger): PiContextLedger {
  return Object.freeze({
    ...input,
    model: Object.freeze({ ...input.model }),
    budget: Object.freeze({ ...input.budget }),
    categories: Object.freeze(input.categories.map((item) =>
      Object.freeze({ ...item })
    )),
    compaction: input.compaction
      ? Object.freeze({ ...input.compaction })
      : null,
    personalMemory: Object.freeze({
      ...(input.personalMemory.mode === undefined
        ? {}
        : {
            mode: input.personalMemory.mode,
            effectiveMode: input.personalMemory.effectiveMode,
            capability: input.personalMemory.capability,
            fixedContextRevision: input.personalMemory.fixedContextRevision,
            ...(input.personalMemory.recall
              ? { recall: Object.freeze({ ...input.personalMemory.recall }) }
              : {})
          }),
      injectionKeys: Object.freeze(input.personalMemory.injectionKeys.map((item) =>
        Object.freeze({ ...item })
      )),
      toolResults: Object.freeze(input.personalMemory.toolResults.map((item) =>
        Object.freeze({ ...item })
      )),
      withinOnceBoundary: input.personalMemory.withinOnceBoundary
    }),
    diagnostics: Object.freeze([...input.diagnostics])
  });
}

function combinedAccuracy(
  left: PiTokenMeasurementAccuracy,
  right: PiTokenMeasurementAccuracy
): PiTokenMeasurementAccuracy {
  return left === "exact" && right === "exact" ? "exact" : "estimated";
}

function isPiContextCategoryId(
  value: unknown
): value is PiContextCategoryId {
  return typeof value === "string"
    && (PI_CONTEXT_CATEGORY_IDS as readonly string[]).includes(value);
}

function validAccuracy(value: unknown): value is PiTokenMeasurementAccuracy {
  return value === "exact" || value === "estimated";
}

function positiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function nonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function nonEmptyText(value: unknown): value is string {
  return boundedText(value, 512);
}

function boundedText(value: unknown, maxLength: number): value is string {
  return typeof value === "string"
    && value.trim().length > 0
    && value.length <= maxLength;
}

function boundedTextArray(
  value: unknown,
  maxLength: number
): value is readonly string[] {
  return Array.isArray(value)
    && value.every((item: unknown) => boundedText(item, maxLength));
}

function recordValue(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
