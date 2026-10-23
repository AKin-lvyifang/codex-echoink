import { MAINTENANCE_KNOWLEDGE_TYPES } from "../../knowledge-base/maintenance-knowledge-types";
import type { MaintenanceP1Action } from "../../knowledge-base/maintenance-p1-contract";
import { throwMaintenanceDiagnostics } from "../../knowledge-base/maintenance-diagnostics";
import { knowledgeRolePath, knowledgePathRole } from "../../knowledge-base/root-paths";
import { knowledgeErrorDetail } from "../../knowledge-base/initialization-error";
import { isDeepStrictEqual } from "node:util";
import {
  defineTool,
  type AgentToolResult,
  type SessionEntry,
  type ToolCallEvent,
  type ToolDefinition,
  type ToolResultEvent
} from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import type {
  PiKnowledgeMaintenanceToolPort,
  PiKnowledgeMaintenanceToolResult,
  PiKnowledgeMaintenanceScope,
  PiKnowledgeRunIdentity
} from "./contracts";
import type { PiVaultAdditionalToolSecurityPort } from "./pi-vault-tool-security-extension";
import {
  secureVaultToolResult,
  type VaultToolResultEgressPort
} from "./vault-tool-result-safety";
import { echoInkKnowledgeMaintenanceProtocolPrompt, MAINTENANCE_TOOL_PARAMETER_EXAMPLES } from "../../knowledge-base/knowledge-maintenance-protocol";
import { isRawMarkdownPath } from "../../knowledge-base/raw-digest";
import type { KnowledgeMaintenanceAssessment } from "../../knowledge-base/knowledge-maintenance-result";

export const PI_KNOWLEDGE_MAINTAIN_TOOL_ID = "knowledge_maintain" as const;

const MAINTENANCE_RESULT_LIMIT_BYTES = 8_000;
const RESULT_PENDING_SAFETY = "knowledge_maintain_result_pending_safety";

/** File revisions identify citations; only an explicitly observed Raw body digest authorizes maintenance. */
export function recordMaintenanceSourceBodyFingerprint(fingerprints: Record<string, string>, relativePath: string, fingerprint: string | undefined, vaultRoot = ""): void {
  if (["raw", "inbox"].includes(knowledgePathRole(vaultRoot, relativePath) ?? "") && typeof fingerprint === "string" && /^sha256:\d+:[a-f0-9]{64}$/u.test(fingerprint)) fingerprints[relativePath] = fingerprint;
}

/** Reuse source versions already delivered in this conversation after reopening. */
export function maintenanceSourceFingerprintsFromEntries(entries: readonly SessionEntry[], vaultRoot = ""): Record<string, string> {
  const fingerprints: Record<string, string> = {};
  const reads = new Map<string, string>();
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (message.role === "assistant") {
      for (const part of message.content) {
        if (part.type !== "toolCall" || !["note_read", "knowledge_read"].includes(part.name)) continue;
        const relative: unknown = part.arguments?.relativePath ?? part.arguments?.vaultRelativePath;
        if (typeof relative === "string") reads.set(part.id, relative);
      }
      continue;
    }
    if (message.role !== "toolResult") continue;
    const details = message.details && typeof message.details === "object" ? message.details as Record<string, unknown> : {};
    const adopt = (relative: unknown, revision: unknown) => {
      if (typeof relative === "string" && typeof revision === "string") recordMaintenanceSourceBodyFingerprint(fingerprints, relative, revision, vaultRoot);
    };
    if (message.toolName === PI_KNOWLEDGE_MAINTAIN_TOOL_ID) {
      if (details.sourceBodyFingerprints && typeof details.sourceBodyFingerprints === "object") {
        for (const [relative, revision] of Object.entries(details.sourceBodyFingerprints)) adopt(relative, revision);
      }
    } else if (["note_read", "knowledge_read"].includes(message.toolName)) {
      if (message.isError) { const relative = reads.get(message.toolCallId); if (relative) delete fingerprints[relative]; continue; }
      // Legacy citation SHA values do not identify which digest was used.
      // A missing explicit body digest requires a new complete source read.
      for (const [relative, fingerprint] of Object.entries((details.sourceBodyFingerprints ?? {}) as Record<string, unknown>)) adopt(relative, fingerprint);
    }
  }
  return fingerprints;
}

export type PiKnowledgeMaintenanceCommandContext = Readonly<{
  folderBindingsRevision?: number;
  mode: "maintain";
  request: string;
  scope: PiKnowledgeMaintenanceScope;
  preference: Readonly<{
    profileVersion: string;
    state: "default" | "custom";
    revision: string;
    providerResourceText: string;
  }>;
}>;

interface KnowledgeMaintenanceCandidateAction {
  targetPath: string;
  content: string;
  expectedTarget: Readonly<
    | { kind: "missing" }
    | { kind: "file"; contentRevision: string }
  >;
}

interface AuthorizedMaintenanceExecution {
  readonly identity: Readonly<PiKnowledgeRunIdentity>;
  readonly command: Readonly<PiKnowledgeMaintenanceCommandContext>;
  readonly p1: Readonly<MaintenanceP1Action>;
  readonly candidateActions: readonly Readonly<KnowledgeMaintenanceCandidateAction>[];
  readonly sourcePaths: readonly string[];
  readonly assessments: readonly Readonly<KnowledgeMaintenanceAssessment>[];
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly externalReadVerified: boolean;
  state: "authorized" | "consumed" | "result_ready";
  result?: Readonly<PiKnowledgeMaintenanceToolResult>;
}

export interface CreatePiKnowledgeMaintenanceSecurityOptions {
  currentRunIdentity(): Readonly<PiKnowledgeRunIdentity>;
  currentCommand(): Readonly<PiKnowledgeMaintenanceCommandContext> | Promise<Readonly<PiKnowledgeMaintenanceCommandContext>>;
  /** True only after a successful external-read Tool result in this ProductRun. */
  hasSuccessfulExternalRead?(): boolean;
  readonly egress: VaultToolResultEgressPort;
}

/** One-shot policy authority shared by Extension hooks and the Tool wrapper. */
export class PiKnowledgeMaintenanceToolSecurity
implements PiVaultAdditionalToolSecurityPort {
  readonly toolName = PI_KNOWLEDGE_MAINTAIN_TOOL_ID;

  private readonly executions = new Map<string, AuthorizedMaintenanceExecution>();
  private readonly seenToolCallIds = new Set<string>();

  constructor(
    private readonly options: Readonly<CreatePiKnowledgeMaintenanceSecurityOptions>
  ) {
    if (!options.egress) throw new TypeError("knowledge_maintenance_egress_required");
  }

  async handleToolCall(
    event: ToolCallEvent,
    _signal: AbortSignal | undefined
  ): Promise<Readonly<{ block: true; reason: string }> | void> {
    if (event.toolName !== this.toolName) return block("tool_policy_blocked");
    if (this.seenToolCallIds.has(event.toolCallId)) {
      return block("authorization_failed");
    }
    let identity: Readonly<PiKnowledgeRunIdentity>;
    let command: Readonly<PiKnowledgeMaintenanceCommandContext> | undefined;
    let candidateActions: readonly Readonly<KnowledgeMaintenanceCandidateAction>[];
    let sourcePaths: readonly string[];
    let assessments: readonly Readonly<KnowledgeMaintenanceAssessment>[];
    let normalizedArguments: Readonly<Record<string, unknown>>;
    let externalReadVerified: boolean;
    try {
      identity = freezeIdentity(this.options.currentRunIdentity());
      command = freezeCommand(await this.options.currentCommand());
      externalReadVerified = this.options.hasSuccessfulExternalRead?.() === true;
      const normalized = normalizeArguments(
        event.input,
        command,
        externalReadVerified
      );
      candidateActions = normalized.candidateActions;
      sourcePaths = normalized.sourcePaths;
      assessments = normalized.assessments;
      normalizedArguments = normalized.arguments;
    } catch (error) {
      const detail = knowledgeErrorDetail(error);
      const scope = command?.scope;
      const scopeHint = detail === "knowledge_maintenance_source_scope_invalid" && scope
        ? scope.mode === "global" ? "；本轮为 global，不能提供 sourcePaths"
          : `；本轮 ${scope.mode} 只可使用 ${JSON.stringify(scope.mode === "query" ? scope.candidatePaths : scope.sourcePaths)}`
        : "";
      return block(`维护参数未通过：${detail}${scopeHint}；请修正本次参数后重试。`);
    }
    this.seenToolCallIds.add(event.toolCallId);
    this.executions.set(event.toolCallId, {
      identity,
      command,
      p1: normalizeP1(event.input),
      candidateActions,
      sourcePaths,
      assessments,
      arguments: normalizedArguments,
      externalReadVerified,
      state: "authorized"
    });
  }

  consume(
    toolCallId: string,
    rawArguments: unknown
  ): Readonly<{
    identity: Readonly<PiKnowledgeRunIdentity>;
    command: Readonly<PiKnowledgeMaintenanceCommandContext>;
    p1: Readonly<MaintenanceP1Action>;
    candidateActions: readonly Readonly<KnowledgeMaintenanceCandidateAction>[];
    sourcePaths: readonly string[];
    assessments: readonly Readonly<KnowledgeMaintenanceAssessment>[];
  }> {
    const execution = this.executions.get(toolCallId);
    if (!execution || execution.state !== "authorized") {
      throw new Error("knowledge_maintenance_authorization_failed");
    }
    const normalized = normalizeArguments(
      rawArguments,
      execution.command,
      execution.externalReadVerified
    );
    if (!isDeepStrictEqual(normalized.arguments, execution.arguments)) {
      throw new Error("knowledge_maintenance_authorization_failed");
    }
    execution.state = "consumed";
    return Object.freeze({
      identity: execution.identity,
      command: execution.command,
      p1: execution.p1,
      candidateActions: execution.candidateActions,
      sourcePaths: execution.sourcePaths,
      assessments: execution.assessments
    });
  }

  complete(
    toolCallId: string,
    result: Readonly<PiKnowledgeMaintenanceToolResult>
  ): void {
    const execution = this.executions.get(toolCallId);
    if (!execution || execution.state !== "consumed") {
      throw new Error("knowledge_maintenance_authorization_failed");
    }
    execution.result = Object.freeze({
      ...result,
      ...(result.maintenanceResult
        ? { maintenanceResult: result.maintenanceResult }
        : {}),
      ...(result.producedPaths
        ? { producedPaths: Object.freeze([...result.producedPaths]) }
        : {})
    });
    execution.state = "result_ready";
  }

  async handleToolResult(event: ToolResultEvent): Promise<Readonly<{
    content: Array<{ type: "text"; text: string }>;
    details: Readonly<Record<string, unknown>>;
    isError: boolean;
  }>> {
    const execution = this.executions.get(event.toolCallId);
    if (
      event.toolName !== this.toolName
      || !execution
      || execution.state !== "result_ready"
      || !execution.result
    ) {
      this.executions.delete(event.toolCallId);
      return rejectedResult(event.toolCallId, "authorization_failed");
    }
    try {
      const secured = await secureVaultToolResult({
        toolId: this.toolName,
        effectType: "user_write",
        egressPolicy: "echoink-configured-provider-v1",
        value: execution.result.message,
        sizeLimitBytes: MAINTENANCE_RESULT_LIMIT_BYTES,
        egress: this.options.egress
      });
      return Object.freeze({
        content: [{ type: "text" as const, text: secured.text }],
        details: Object.freeze({
          source: "echoink-knowledge-maintenance",
          toolCallId: event.toolCallId,
          productRunId: execution.identity.productRunId,
          piSessionId: execution.identity.piSessionId,
          status: execution.result.status,
          ...(execution.result.userReceipt ? { userReceipt: execution.result.userReceipt } : {}),
          ...(execution.result.maintenanceStage ? { maintenanceStage: execution.result.maintenanceStage } : {}),
          ...(execution.result.protocolVersion
            ? { protocolVersion: execution.result.protocolVersion }
            : {}),
          ...(execution.result.preferenceProfileVersion
            ? {
                preferenceProfileVersion:
                  execution.result.preferenceProfileVersion
              }
            : {}),
          ...(execution.result.preferenceState
            ? { preferenceState: execution.result.preferenceState }
            : {}),
          ...(execution.result.errorCode
            ? { errorCode: execution.result.errorCode }
            : {}),
          ...(execution.result.refreshedSources ? { readSourcePaths: Object.keys(execution.result.refreshedSources), sourceBodyFingerprints: execution.result.refreshedSources } : {}),
          ...(execution.result.recordId ? { recordId: execution.result.recordId } : {}),
          ...(execution.result.processedSourcePaths ? { processedSourcePaths: [...execution.result.processedSourcePaths] } : {}),
          ...(execution.result.producedPaths
            ? { producedPaths: [...execution.result.producedPaths] }
            : {}),
          ...(execution.result.maintenanceResult
            ? { maintenanceResult: execution.result.maintenanceResult }
            : {})
        }),
        isError: event.isError
          || execution.result.status === "failed"
          || execution.result.status === "cancelled"
      });
    } catch {
      return rejectedResult(event.toolCallId, "tool_result_rejected");
    } finally {
      this.executions.delete(event.toolCallId);
    }
  }
}

export function createPiKnowledgeMaintenanceToolSecurity(
  options: Readonly<CreatePiKnowledgeMaintenanceSecurityOptions>
): PiKnowledgeMaintenanceToolSecurity {
  return new PiKnowledgeMaintenanceToolSecurity(options);
}

export interface CreatePiKnowledgeMaintenanceToolOptions {
  readonly port: PiKnowledgeMaintenanceToolPort;
  readonly security: PiKnowledgeMaintenanceToolSecurity;
}

/**
 * The same AgentSession reads Raw and supplies ordered candidate actions. The
 * wrapper never starts a Provider, Agent, Harness, or second Tool loop.
 */
export function createPiKnowledgeMaintenanceToolDefinition(
  options: Readonly<CreatePiKnowledgeMaintenanceToolOptions>
): ToolDefinition {
  return defineTool({
    name: PI_KNOWLEDGE_MAINTAIN_TOOL_ID,
    label: "维护知识库",
    description: "仅在显式 /maintain 范围内串行维护。必须 decompose（每篇摘要与七类结构化知识点/原句版本证据，可逐篇检查点，全批齐备后返回Wiki候选）→plan（knowledge.unitIds、同知识点decision/理由与related关系，固定逐页写作清单）→write（每次一页），成功页不重写；失败后 resume 仅补未完成。新页提供content；已有页先sections取得完整快照regionId，再sectionPatches只追加/替换选中区域。来源/相关条目为独立区，错误编号重新sections，不猜不整页覆盖。禁止生成关键原句小节，已有同名用户小节逐字保留。只有全部页与原文三个字段成功才已提炼。\n" + MAINTENANCE_TOOL_PARAMETER_EXAMPLES,
    parameters: diagnosticParameters(Type.Object({
      stage: Type.Union(["decompose", "plan", "write", "resume", "sections", "inspect"].map(value => Type.Literal(value))),
      sourcePaths: Type.Optional(Type.Array(Type.String(), { minItems: 1, maxItems: 20 })),
      decompositions: Type.Optional(Type.Array(Type.Object({ sourcePath: Type.String(), summary: Type.String(), units: Type.Array(Type.Object({ id: Type.String(), type: Type.Union(MAINTENANCE_KNOWLEDGE_TYPES.map(value => Type.Literal(value))), typePendingConfirmation: Type.Optional(Type.Boolean()), domain: Type.String(), title: Type.String(), aliases: Type.Optional(Type.Array(Type.String())), points: Type.Array(Type.String(), { minItems: 1 }), evidence: Type.Array(Type.Object({ sourcePath: Type.String(), sourceRevision: Type.String(), quote: Type.String() }, { additionalProperties: false }), { minItems: 1 }) }, { additionalProperties: false })) }, { additionalProperties: false }), { maxItems: 20 })),
      writingPlan: Type.Optional(Type.Array(Type.Object({ id: Type.String(), targetPath: Type.String(), sourcePaths: Type.Array(Type.String(), { minItems: 1, maxItems: 20 }), newSections: Type.Optional(Type.Array(Type.String(), { maxItems: 20 })), expectedTarget: Type.Union([Type.Object({ kind: Type.Literal("missing") }), Type.Object({ kind: Type.Literal("file"), contentRevision: Type.String() })]), knowledge: Type.Object({ unitIds: Type.Array(Type.String(), { minItems: 1 }), decision: Type.Object({ kind: Type.Union([Type.Literal("new"), Type.Literal("same_point"), Type.Literal("uncertain")]), reason: Type.String(), candidatePath: Type.Optional(Type.String()) }, { additionalProperties: false }), related: Type.Optional(Type.Array(Type.Object({ targetPath: Type.String(), reason: Type.String(), reverseReason: Type.Optional(Type.String()) }, { additionalProperties: false }))), type: Type.Optional(Type.Union(MAINTENANCE_KNOWLEDGE_TYPES.map(value => Type.Literal(value)))), domain: Type.Optional(Type.String()) }, { additionalProperties: false }) }, { additionalProperties: false }), { maxItems: 100 })),
      view: Type.Optional(Type.Union([Type.Literal("candidates"), Type.Literal("units"), Type.Literal("pages")])), offset: Type.Optional(Type.Integer({ minimum: 0 })),
      pageId: Type.Optional(Type.String()), targetPath: Type.Optional(Type.String()), content: Type.Optional(Type.String()),
      sectionPatches: Type.Optional(Type.Array(Type.Object({ regionId: Type.String(), operation: Type.Union([Type.Literal("append"), Type.Literal("replace")]), content: Type.String() }, { additionalProperties: false }), { maxItems: 100 }))
    }, { additionalProperties: false })),
    executionMode: "sequential",
    execute: async (toolCallId, rawArguments, signal) => {
      const authorized = options.security.consume(toolCallId, rawArguments);
      const result = await options.port.execute(Object.freeze({
        ...authorized.identity,
        toolCallId,
        mode: "maintain",
        request: authorized.command.request,
        p1: authorized.p1,
        sourcePaths: authorized.sourcePaths,
        candidateActions: authorized.candidateActions,
        assessments: authorized.assessments,
        preferenceSnapshot: {
          profileVersion: authorized.command.preference.profileVersion,
          state: authorized.command.preference.state,
          revision: authorized.command.preference.revision
        },
        ...(signal ? { signal } : {})
      }));
      options.security.complete(toolCallId, result);
      return pendingResult(toolCallId, authorized.identity);
    }
  });
}

function pendingResult(
  toolCallId: string,
  identity: Readonly<PiKnowledgeRunIdentity>
): AgentToolResult<Readonly<Record<string, unknown>>> {
  return {
    content: [{ type: "text", text: RESULT_PENDING_SAFETY }],
    details: Object.freeze({
      source: "echoink-knowledge-maintenance",
      toolCallId,
      productRunId: identity.productRunId,
      piSessionId: identity.piSessionId,
      status: "verifying"
    })
  };
}

function normalizeArguments(
  value: unknown,
  command: Readonly<PiKnowledgeMaintenanceCommandContext>,
  externalReadVerified = false
): Readonly<{
  arguments: Readonly<Record<string, unknown>>;
  candidateActions: readonly Readonly<KnowledgeMaintenanceCandidateAction>[];
  sourcePaths: readonly string[];
  assessments: readonly Readonly<KnowledgeMaintenanceAssessment>[];
}> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("knowledge_maintenance_arguments_invalid");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  const p1 = normalizeP1(value);
  const allowedKeys = new Set(["stage", "sourcePaths", "decompositions", "writingPlan", "pageId", "targetPath", "content", "sectionPatches", "view", "offset"]);
  if (
    keys.some((key) => !allowedKeys.has(key))
    || (record.candidateActions !== undefined && (!Array.isArray(record.candidateActions) || record.candidateActions.length > 100))
  ) {
    throw new TypeError("knowledge_maintenance_arguments_invalid");
  }
  const candidateActions = Object.freeze((record.candidateActions as unknown[] ?? []).map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new TypeError("knowledge_maintenance_action_invalid");
    }
    const action = item as Record<string, unknown>;
    if (
      !Object.prototype.hasOwnProperty.call(action, "targetPath")
      || !Object.prototype.hasOwnProperty.call(action, "content")
      || !Object.prototype.hasOwnProperty.call(action, "expectedTarget")
      || typeof action.targetPath !== "string"
      || !action.targetPath.trim()
      || typeof action.content !== "string"
    ) {
      throw new TypeError("knowledge_maintenance_action_invalid");
    }
    return Object.freeze({
      targetPath: action.targetPath,
      content: action.content,
      expectedTarget: normalizeExpectedTarget(action.expectedTarget)
    });
  }));
  const sourcePaths = normalizeMaintenanceSourcePaths(
    record.sourcePaths,
    command.scope
  );
  const assessments = normalizeMaintenanceAssessments(
    record.assessments,
    externalReadVerified
  );
  return Object.freeze({
    arguments: Object.freeze({
      ...p1,
      ...(sourcePaths.length ? { sourcePaths } : {})
    }),
    candidateActions,
    sourcePaths,
    assessments
  });
}

function normalizeMaintenanceAssessments(
  value: unknown,
  externalReadVerified: boolean
): readonly Readonly<KnowledgeMaintenanceAssessment>[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value) || value.length > 100) {
    throw new TypeError("knowledge_maintenance_assessments_invalid");
  }
  return Object.freeze(value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new TypeError("knowledge_maintenance_assessment_invalid");
    }
    const record = item as Record<string, unknown>;
    if (Object.keys(record).sort().join("\0")
      !== "asOf\0claim\0evidence\0status\0verification"
      || typeof record.claim !== "string" || !record.claim.trim()
      || record.claim.length > 500
      || !["valid", "needs_supplement", "outdated", "conflict"].includes(
        String(record.status)
      )
      || !Array.isArray(record.evidence) || record.evidence.length > 20
      || record.evidence.some((entry) =>
        typeof entry !== "string" || !entry.trim() || entry.length > 500
      )
      || typeof record.asOf !== "string" || !record.asOf.trim()
      || record.asOf.length > 100
      || !["local_verified", "external_verified", "unverified"].includes(
        String(record.verification)
      )) {
      throw new TypeError("knowledge_maintenance_assessment_invalid");
    }
    return Object.freeze({
      claim: record.claim.trim(),
      status: record.status as KnowledgeMaintenanceAssessment["status"],
      evidence: Object.freeze((record.evidence as string[]).map((entry) =>
        entry.trim()
      )),
      asOf: record.asOf.trim(),
      verification: record.verification === "external_verified"
        && !externalReadVerified
        ? "unverified"
        : record.verification as KnowledgeMaintenanceAssessment["verification"]
    });
  }));
}

function normalizeMaintenanceSourcePaths(
  value: unknown,
  scope: PiKnowledgeMaintenanceScope
): readonly string[] {
  if (scope.mode === "global") {
    if (value !== undefined) {
      throw new TypeError("knowledge_maintenance_source_scope_invalid");
    }
    return Object.freeze([]);
  }
  if (scope.mode === "exact") {
    const expected = scope.sourcePaths[0];
    if (value === undefined) return Object.freeze([expected]);
    if (
      !Array.isArray(value)
      || value.length !== 1
      || normalizeMaintenanceRawPath(value[0]) !== expected
    ) {
      throw new TypeError("knowledge_maintenance_source_scope_invalid");
    }
    return Object.freeze([expected]);
  }
  if (scope.mode === "batch") {
    const expected = scope.sourcePaths;
    if (value === undefined) return Object.freeze([...expected]);
    if (!Array.isArray(value) || value.length !== expected.length) {
      throw new TypeError("knowledge_maintenance_source_scope_invalid");
    }
    const selected = value.map(normalizeMaintenanceRawPath);
    if (new Set(selected).size !== expected.length || selected.some((source) => !expected.includes(source))) {
      throw new TypeError("knowledge_maintenance_source_scope_invalid");
    }
    return Object.freeze([...expected]);
  }
  if (!Array.isArray(value) || value.length !== 1) {
    throw new TypeError("knowledge_maintenance_source_scope_invalid");
  }
  const selected = normalizeMaintenanceRawPath(value[0]);
  if (!scope.candidatePaths.includes(selected)) {
    throw new TypeError("knowledge_maintenance_source_scope_invalid");
  }
  return Object.freeze([selected]);
}

function normalizeMaintenanceRawPath(value: unknown): string {
  if (typeof value !== "string") {
    throw new TypeError("knowledge_maintenance_source_scope_invalid");
  }
  const normalized = value.trim().replaceAll("\\", "/").replace(/^\/+/, "");
  if (
    !isRawMarkdownPath(normalized)
    || normalized.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new TypeError("knowledge_maintenance_source_scope_invalid");
  }
  return normalized;
}

function normalizeExpectedTarget(
  value: unknown
): Readonly<KnowledgeMaintenanceCandidateAction["expectedTarget"]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("knowledge_maintenance_expected_target_invalid");
  }
  const record = value as Record<string, unknown>;
  if (record.kind === "missing" && Object.keys(record).length === 1) {
    return Object.freeze({ kind: "missing" as const });
  }
  if (
    record.kind === "file"
    && Object.keys(record).length === 2
    && typeof record.contentRevision === "string"
    && /^sha256:[a-f0-9]{64}$/u.test(record.contentRevision)
  ) {
    return Object.freeze({
      kind: "file" as const,
      contentRevision: record.contentRevision
    });
  }
  throw new TypeError("knowledge_maintenance_expected_target_invalid");
}

function freezeIdentity(
  value: Readonly<PiKnowledgeRunIdentity>
): Readonly<PiKnowledgeRunIdentity> {
  for (const field of ["vaultId", "conversationId", "piSessionId", "productRunId"] as const) {
    if (typeof value?.[field] !== "string" || !value[field].trim()) {
      throw new TypeError("knowledge_maintenance_identity_invalid");
    }
  }
  return Object.freeze({ ...value });
}

function freezeCommand(
  value: Readonly<PiKnowledgeMaintenanceCommandContext>
): Readonly<PiKnowledgeMaintenanceCommandContext> {
  if (!value || value.mode !== "maintain") {
    throw new TypeError("knowledge_maintenance_command_invalid");
  }
  if (typeof value.request !== "string") {
    throw new TypeError("knowledge_maintenance_command_invalid");
  }
  const scope = value.scope;
  if (
    !scope
    || !["global", "exact", "batch", "query"].includes(scope.mode)
  ) {
    throw new TypeError("knowledge_maintenance_command_invalid");
  }
  if (
    scope.mode === "batch"
    && (
      scope.sourcePaths.length === 0
      || scope.sourcePaths.length > 20
      || new Set(scope.sourcePaths.map(normalizeMaintenanceRawPath)).size
        !== scope.sourcePaths.length
    )
  ) {
    throw new TypeError("knowledge_maintenance_command_invalid");
  }
  const preference = value.preference;
  if (
    !preference
    || typeof preference.profileVersion !== "string"
    || !preference.profileVersion.trim()
    || (preference.state !== "default" && preference.state !== "custom")
    || typeof preference.revision !== "string"
    || !/^sha256:[a-f0-9]{64}$/u.test(preference.revision)
    || typeof preference.providerResourceText !== "string"
    || !preference.providerResourceText.trim()
  ) {
    throw new TypeError("knowledge_maintenance_preference_invalid");
  }
  return Object.freeze({
    ...value,
    scope: scope.mode === "global"
      ? Object.freeze({ ...scope, mode: "global" as const, ...(scope.sourcePaths ? { sourcePaths: Object.freeze(scope.sourcePaths.map(normalizeMaintenanceRawPath)) } : {}) })
      : scope.mode === "exact"
        ? Object.freeze({
            mode: "exact" as const,
            sourcePaths: Object.freeze<[string]>([
              normalizeMaintenanceRawPath(scope.sourcePaths[0])
            ])
          })
        : scope.mode === "batch"
          ? Object.freeze({
              mode: "batch" as const,
              ...(scope.folderBindingsRevision !== undefined ? { folderBindingsRevision: scope.folderBindingsRevision } : {}),
              sourcePaths: Object.freeze(scope.sourcePaths.map(
                normalizeMaintenanceRawPath
              ))
            })
          : Object.freeze({
            mode: "query" as const,
            candidatePaths: Object.freeze(scope.candidatePaths.map(
              normalizeMaintenanceRawPath
            ))
          }),
    preference: Object.freeze({ ...preference })
  });
}

function block(reason: string): Readonly<{ block: true; reason: string }> {
  return Object.freeze({ block: true, reason });
}

function rejectedResult(
  toolCallId: string,
  reason: string
): Readonly<{
  content: Array<{ type: "text"; text: string }>;
  details: Readonly<Record<string, unknown>>;
  isError: true;
}> {
  return Object.freeze({
    content: [{ type: "text" as const, text: reason }],
    details: Object.freeze({
      source: "echoink-knowledge-maintenance",
      toolCallId,
      status: "failed"
    }),
    isError: true
  });
}

function normalizeP1(value: unknown): Readonly<MaintenanceP1Action> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("knowledge_maintenance_stage_required");
  const r = value as Record<string, unknown>;
  if (!["decompose", "plan", "write", "resume", "sections", "inspect"].includes(String(r.stage))) throw new TypeError("knowledge_maintenance_stage_required: decompose -> plan -> write; resume 补未完");
  const errors: string[] = [];
  const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
  const keys = (item: Record<string, unknown>, allowed: string[], location: string) => { for (const key of Object.keys(item)) if (!allowed.includes(key)) errors.push(`${location}.${key}不是允许字段；按工具完整示例的嵌套层级提交。`); };
  const text = (value: unknown, location: string) => { if (typeof value !== "string" || !value.trim()) errors.push(`${location}须为非空字符串。`); };
  const list = (value: unknown, location: string, maximum = 100): value is unknown[] => { if (!Array.isArray(value) || value.length > maximum) { errors.push(`${location}须为最多${maximum}项的数组。`); return false; } return true; };
  const strings = (value: unknown, location: string, nonempty = false) => { if (list(value, location)) { if (nonempty && !value.length) errors.push(`${location}不能为空。`); value.forEach((item,index) => text(item, `${location}[${index}]`)); } };
  keys(r, ["stage", "sourcePaths", "decompositions", "writingPlan", "pageId", "targetPath", "content", "sectionPatches", "view", "offset"], "root");
  if (r.view !== undefined && !["candidates", "units", "pages"].includes(String(r.view))) errors.push("view只可为candidates/units/pages。");
  if (r.offset !== undefined && (!Number.isSafeInteger(r.offset) || Number(r.offset) < 0)) errors.push("offset须为非负整数。");
  for (const key of ["pageId", "targetPath"]) if (r[key] !== undefined || (r.stage === "write" && key === "pageId") || (r.stage === "sections" && key === "targetPath")) text(r[key], key);
  if (r.content !== undefined && typeof r.content !== "string") errors.push("content须为Markdown字符串。");
  if (r.decompositions !== undefined || r.stage === "decompose") if (list(r.decompositions, "decompositions", 20)) r.decompositions.forEach((d,index) => {
    const at = `decompositions[${index}]`;
    if (!object(d)) { errors.push(`${at}须含sourcePath/summary/units的对象。`); return; }
    keys(d, ["sourcePath", "summary", "units"], at); text(d.sourcePath, `${at}.sourcePath`); text(d.summary, `${at}.summary`);
    if (list(d.units, `${at}.units`)) d.units.forEach((unit,j) => {
      const path = `${at}.units[${j}]`;
      if (!object(unit)) { errors.push(`${path}须为七类型结构化对象，不能是旧字符串。`); return; }
      keys(unit, ["id", "type", "typePendingConfirmation", "domain", "title", "aliases", "points", "evidence"], path);
      for (const key of ["id", "domain", "title"]) text(unit[key], `${path}.${key}`);
      if (!MAINTENANCE_KNOWLEDGE_TYPES.includes(unit.type as never)) errors.push(`${path}.type须为七种正式类型之一。`);
      if (unit.typePendingConfirmation !== undefined && typeof unit.typePendingConfirmation !== "boolean") errors.push(`${path}.typePendingConfirmation须为boolean。`);
      if (unit.aliases !== undefined) strings(unit.aliases, `${path}.aliases`);
      strings(unit.points, `${path}.points`, true);
      if (list(unit.evidence, `${path}.evidence`)) { if (!unit.evidence.length) errors.push(`${path}.evidence不能为空。`); unit.evidence.forEach((e,k) => { const at = `${path}.evidence[${k}]`; if (!object(e)) { errors.push(`${at}须为sourcePath/sourceRevision/quote对象。`); return; } keys(e, ["sourcePath", "sourceRevision", "quote"], at); for (const key of ["sourcePath", "sourceRevision", "quote"]) text(e[key], `${at}.${key}`); }); }
    });
  });
  if (r.writingPlan !== undefined || r.stage === "plan") if (list(r.writingPlan, "writingPlan")) r.writingPlan.forEach((item,index) => {
    const at = `writingPlan[${index}]`;
    if (!object(item)) { errors.push(`${at}须为清单对象。`); return; }
    keys(item, ["id", "targetPath", "sourcePaths", "expectedTarget", "knowledge", "newSections"], at);
    text(item.id, `${at}.id`); text(item.targetPath, `${at}.targetPath`); strings(item.sourcePaths, `${at}.sourcePaths`, true);
    if (item.newSections !== undefined) { if (list(item.newSections, `${at}.newSections`, 20)) item.newSections.forEach((title,i) => text(title, `${at}.newSections[${i}]`)); }
    if (!object(item.expectedTarget) || !["missing", "file"].includes(String(item.expectedTarget.kind))) errors.push(`${at}.expectedTarget须为{kind:"missing"}或{kind:"file",contentRevision:真实版本}。`);
    else { keys(item.expectedTarget, item.expectedTarget.kind === "file" ? ["kind", "contentRevision"] : ["kind"], `${at}.expectedTarget`); if (item.expectedTarget.kind === "file") text(item.expectedTarget.contentRevision, `${at}.expectedTarget.contentRevision`); }
    const k = item.knowledge;
    if (!object(k)) { errors.push(`${at}.knowledge须嵌套unitIds/decision/related，不能放在清单条目顶层。`); return; }
    keys(k, ["unitIds", "decision", "related", "type", "domain"], `${at}.knowledge`); strings(k.unitIds, `${at}.knowledge.unitIds`, true);
    if (!object(k.decision)) errors.push(`${at}.knowledge.decision须含kind/reason。`);
    else { keys(k.decision, ["kind", "reason", "candidatePath"], `${at}.knowledge.decision`); if (!["new", "same_point", "uncertain"].includes(String(k.decision.kind))) errors.push(`${at}.knowledge.decision.kind非法。`); text(k.decision.reason, `${at}.knowledge.decision.reason`); if (k.decision.candidatePath !== undefined) text(k.decision.candidatePath, `${at}.knowledge.decision.candidatePath`); }
    if (k.related !== undefined && list(k.related, `${at}.knowledge.related`)) k.related.forEach((relation,i) => { const at = `writingPlan[${index}].knowledge.related[${i}]`; if (!object(relation)) { errors.push(`${at}须为关系对象。`); return; } keys(relation, ["targetPath", "reason", "reverseReason"], at); text(relation.targetPath, `${at}.targetPath`); text(relation.reason, `${at}.reason`); if (relation.reverseReason !== undefined) text(relation.reverseReason, `${at}.reverseReason`); });
  });
  if (r.sectionPatches !== undefined && list(r.sectionPatches, "sectionPatches")) r.sectionPatches.forEach((patch,index) => { const at = `sectionPatches[${index}]`; if (!object(patch)) { errors.push(`${at}须为区域补丁对象。`); return; } keys(patch, ["regionId", "operation", "content"], at); text(patch.regionId, `${at}.regionId`); if (!["append", "replace"].includes(String(patch.operation))) errors.push(`${at}.operation须为append/replace。`); if (typeof patch.content !== "string") errors.push(`${at}.content须为正文字符串，不包含新标题。`); });
  throwMaintenanceDiagnostics(errors);
  const cloned = JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(r).filter(([key]) => key !== "sourcePaths")))) as MaintenanceP1Action;
  for (const d of cloned.decompositions ?? []) for (const u of d.units) if (typeof u !== "string" && u.aliases === undefined) (u as { aliases: readonly string[] }).aliases = [];
  return Object.freeze(cloned);
}

/** SDK validates before tool_call hooks. Keep the rich schema as a model hint,
 * but route field-shape failures through our bounded production diagnostics. */
function diagnosticParameters<T extends { properties: Record<string, unknown> }>(schema: T): T {
  return { ...schema, required: [], additionalProperties: true, properties: Object.fromEntries(Object.entries(schema.properties).map(([key,value]) => [key, { anyOf: [value, {}] }])) } as T;
}
