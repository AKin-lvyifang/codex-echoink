import { getDesktopCrypto } from "../../platform/desktop-crypto";
import { getDesktopUtil } from "../../platform/desktop-runtime";

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolCallEvent, type ToolDefinition, type ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { fingerprint, normalizePrivacy, splitDiaryBlocks } from "../../english-diary/model";
import { normalizeDiaryPath } from "../../english-diary/repository";
import type { DiaryGenerator, DiaryRecord, EnglishDiaryApi } from "../../english-diary/types";
import { requireProPlugin, unavailableCapabilityAccess } from "../../membership/access";
import type { PiVaultAdditionalToolSecurityPort } from "./pi-vault-tool-security-extension";
import type { PiWorkspaceAccess } from "./pi-workspace-access";
import type { FileDomainReceiptStore } from "./domain-receipt-store";
import { canonicalJsonStringify, normalizeJsonValue, type ApprovalOperationContract, type FileApprovalTicketStore, type JsonValue, type WriteToolAuthorizationContext } from "./tool-authorization";
import { EchoInkVaultToolEgressPolicy, secureVaultToolResult } from "./vault-tool-result-safety";

const { createHash } = getDesktopCrypto();
const { isDeepStrictEqual } = getDesktopUtil();

export const PI_ENGLISH_DIARY_TOOL_ID = "english_diary_generate" as const;
interface RunIdentity { vaultId: string; conversationId: string; piSessionId: string; productRunId: string }
export interface EnglishDiaryApprovalInput extends RunIdentity {
  requestId: string; toolCallId: string; toolId: typeof PI_ENGLISH_DIARY_TOOL_ID;
  target: JsonValue; preview: JsonValue; signal: AbortSignal | undefined;
}
export interface PiEnglishDiaryToolPort {
  api: EnglishDiaryApi;
  generator: DiaryGenerator;
  /** Pure inspection: no association creation, transaction recovery, migration or file writes. */
  inspect(sourcePath: string): Promise<DiaryRecord>;
  /** Host validates the exact native diary path and its current read scope. */
  validateSource(path: string): Promise<void>;
}
export interface PiEnglishDiarySecurityOptions {
  assertToolAllowed(toolName: string, args: Readonly<Record<string, unknown>>, resolvedTarget?: unknown, currentOperation?: Readonly<{ productRunId: string; toolCallId: string }>): Promise<void>;
  currentRequest(): { sourcePath: string; intentEntryId?: string } | null;
  currentAccess?: () => PiWorkspaceAccess | null | undefined;
  currentRunIdentity?: () => RunIdentity;
  currentUserEntry?: () => { entryId: string; text: string };
  approvals?: FileApprovalTicketStore;
  receipts?: FileDomainReceiptStore;
  confirmation?: { confirm(input: EnglishDiaryApprovalInput): Promise<boolean> };
  userId?: string; deviceId?: string;
}
interface DiarySnapshot {
  record: DiaryRecord;
  sourceFingerprint: string;
  version: JsonValue;
  target: JsonValue;
}
interface DiaryRequestIdentity {
  /** Stable host-owned task intent, including when a resumed run has a new user entry. */
  intentEntryId: string;
  /** The actual user entry of this authorized run; must not change while confirming/executing. */
  userEntryId: string;
}
interface DiaryCall {
  input: { sourcePath: string };
  identity: RunIdentity;
  requestIdentity: DiaryRequestIdentity;
  snapshot: DiarySnapshot;
  operationId: string;
  authorization: Readonly<WriteToolAuthorizationContext>;
  state: "authorized" | "consumed" | "result_ready";
  result?: Record<string, unknown>;
}
const activeSources = new WeakMap<EnglishDiaryApi, Set<string>>();
function digest(value: unknown): string { return createHash("sha256").update(canonicalJsonStringify(normalizeJsonValue(value))).digest("hex"); }
function fail(code: string): never { throw new Error(code); }
function codeOf(error: unknown): string {
  const candidate = error && typeof error === "object" && "code" in error ? String(error.code) : error instanceof Error ? error.message : "";
  // Provider and filesystem error messages can contain user content. Only fixed codes leave this adapter.
  return /^(?:english_diary_[a-z_]+|approval_[a-z_]+|authorization_failed|tool_policy_blocked|agent_capability_[a-z_]+|SOURCE_CHANGED|ABORTED|FILE_MODIFIED|CONFLICT|SAVE_FAILED)$/u.test(candidate)
    ? candidate : "english_diary_failed";
}
export function normalizeEnglishDiaryToolRequest(value: unknown): { sourcePath: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("english_diary_invalid_request");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).length !== 1 || typeof input.sourcePath !== "string" || !input.sourcePath || input.sourcePath.length > 2_000) fail("english_diary_invalid_request");
  try { if (normalizeDiaryPath(input.sourcePath) !== input.sourcePath) fail("english_diary_invalid_request"); }
  catch { fail("english_diary_invalid_request"); }
  return { sourcePath: input.sourcePath };
}

/** The generator receives private source blocks only through EnglishDiaryService's existing filter. */
export class PiEnglishDiaryToolSecurity implements PiVaultAdditionalToolSecurityPort {
  readonly toolName = PI_ENGLISH_DIARY_TOOL_ID;
  private port?: PiEnglishDiaryToolPort;
  private readonly seen = new Set<string>();
  private readonly calls = new Map<string, DiaryCall>();
  constructor(private readonly options: PiEnglishDiarySecurityOptions) {}
  bindPort(port: PiEnglishDiaryToolPort): void {
    if (this.port && this.port !== port) fail("english_diary_port_already_bound");
    this.port = port;
  }
  private identity(): RunIdentity | undefined {
    const value = this.options.currentRunIdentity?.();
    return value ? { vaultId: value.vaultId, conversationId: value.conversationId, piSessionId: value.piSessionId, productRunId: value.productRunId } : undefined;
  }
  private assertRequest(input: { sourcePath: string }, expected?: DiaryRequestIdentity): DiaryRequestIdentity {
    const request = this.options.currentRequest();
    const entry = this.options.currentUserEntry?.();
    if (!request || request.sourcePath !== input.sourcePath || !entry?.entryId) fail("english_diary_request_mismatch");
    const identity = { intentEntryId: request.intentEntryId ?? entry.entryId, userEntryId: entry.entryId };
    if (!identity.intentEntryId || expected && !isDeepStrictEqual(identity, expected)) fail("english_diary_request_mismatch");
    return identity;
  }
  private assertAccess(): void {
    const access = this.options.currentAccess?.();
    if (!access || access.mode === "plan" || access.permission === "read-only") fail("tool_policy_blocked");
    const product = this.port!.api.access ?? unavailableCapabilityAccess;
    requireProPlugin(product);
    product.requireCapability("diary.explanation.generate");
  }
  private async check(input: { sourcePath: string }, identity: RunIdentity, id: string, target: JsonValue | undefined, requestIdentity: DiaryRequestIdentity): Promise<void> {
    this.assertRequest(input, requestIdentity);
    if (!isDeepStrictEqual(identity, this.identity())) fail("english_diary_authorization_failed");
    this.assertAccess();
    await this.options.assertToolAllowed(this.toolName, input, target, { productRunId: identity.productRunId, toolCallId: id });
    await this.port!.validateSource(input.sourcePath);
    this.assertRequest(input, requestIdentity);
    if (!isDeepStrictEqual(identity, this.identity())) fail("english_diary_authorization_failed");
    this.assertAccess();
  }
  private async snapshot(path: string): Promise<DiarySnapshot> {
    const source = await this.port!.api.readSource(path);
    if (source.path !== path) fail("english_diary_request_mismatch");
    const record = await this.port!.inspect(path);
    if (record.sourcePath !== path) fail("english_diary_request_mismatch");
    const sourceFingerprint = fingerprint(source.content);
    const privacy = normalizePrivacy(splitDiaryBlocks(source.content), sourceFingerprint, record.privacy);
    return { record, sourceFingerprint,
      target: normalizeJsonValue({ sourcePath: path, englishPath: record.englishPath, journalId: record.id }),
      version: normalizeJsonValue({ sourceFingerprint, englishFingerprint: record.observedFileFingerprint ?? null,
        savedFileFingerprint: record.savedFileFingerprint, privacyFingerprint: digest(privacy),
        resultOperationId: record.result?.operationId ?? null, resultFingerprint: record.result?.englishFingerprint ?? null,
        pendingOperationId: record.pending?.operationId ?? null, pendingFingerprint: record.pending?.englishFingerprint ?? null,
        missingEnglish: record.missingEnglish, englishModified: record.englishModified }) };
  }
  private async inspectUnchangedPublication(before: DiarySnapshot, path: string): Promise<DiarySnapshot | null> {
    try {
      const after = await this.snapshot(path);
      const old = before.record, current = after.record;
      // savePrivacy may normalize local rules before a Provider failure. It does not authorize any output change.
      return after.sourceFingerprint === before.sourceFingerprint && isDeepStrictEqual(after.target, before.target)
        && (current.observedFileFingerprint ?? null) === (old.observedFileFingerprint ?? null)
        && current.savedFileFingerprint === old.savedFileFingerprint
        && current.missingEnglish === old.missingEnglish && current.englishModified === old.englishModified
        && isDeepStrictEqual(current.result, old.result) && isDeepStrictEqual(current.pending, old.pending) ? after : null;
    } catch { return null; }
  }
  async handleToolCall(event: ToolCallEvent, signal?: AbortSignal) {
    if (this.seen.has(event.toolCallId)) return { block: true as const, reason: "authorization_failed" };
    this.seen.add(event.toolCallId);
    try {
      if (!this.port || event.toolName !== this.toolName) fail("authorization_failed");
      if (signal?.aborted) fail("approval_cancelled");
      const input = normalizeEnglishDiaryToolRequest(event.input), identity = this.identity();
      const { approvals, receipts, confirmation, userId, deviceId } = this.options;
      if (!identity || !approvals || !receipts || !confirmation || !userId || !deviceId
        || identity.vaultId !== approvals.vaultId || identity.vaultId !== receipts.vaultId) fail("authorization_failed");
      const requestIdentity = this.assertRequest(input);
      const { intentEntryId } = requestIdentity;
      await this.check(input, identity, event.toolCallId, undefined, requestIdentity);
      if (this.port.api.isGenerating(input.sourcePath)) fail("english_diary_busy");
      const snapshot = await this.snapshot(input.sourcePath);
      await this.check(input, identity, event.toolCallId, snapshot.target, requestIdentity);
      if (snapshot.record.pending && snapshot.record.pending.sourceFingerprint !== snapshot.sourceFingerprint) fail("english_diary_pending_source_changed");
      if (snapshot.record.englishModified && (snapshot.record.pending || snapshot.record.result?.sourceFingerprint !== snapshot.sourceFingerprint)) fail("english_diary_overwrite_required");
      // A new conversation must not bypass an unresolved write to this same diary.
      for (const row of (await receipts.listUiViews()).filter(row => row.toolId === this.toolName)) {
        const prior = await receipts.readOperation(row.operationIdentity);
        const version = prior?.targetVersion as Record<string, JsonValue> | undefined;
        const target = prior?.resolvedTarget as Record<string, JsonValue> | undefined;
        if (!prior || target?.sourcePath !== input.sourcePath || prior.effectState === "authorized") continue;
        const sameIntent = version?.intentEntryId === intentEntryId || prior.productRunId === identity.productRunId;
        if ((sameIntent || version?.sourceFingerprint === snapshot.sourceFingerprint) && (!row.receipt || row.receipt.status === "uncertain")) fail("english_diary_previous_result_uncertain_do_not_retry");
        if (sameIntent && row.receipt?.status === "completed") fail("english_diary_operation_already_completed");
      }
      const operationId = snapshot.record.pending?.sourceFingerprint === snapshot.sourceFingerprint ? snapshot.record.pending.operationId
        : snapshot.record.result?.sourceFingerprint === snapshot.sourceFingerprint ? snapshot.record.result.operationId
          : `english_${digest({ ...identity, toolCallId: event.toolCallId }).slice(0, 32)}`;
      const contract: ApprovalOperationContract = { ...identity, toolCallId: event.toolCallId, toolId: this.toolName, userId, deviceId,
        toolVersion: "english-diary-tools-v1", policyVersion: "english-diary-policy-v1", normalizedArguments: normalizeJsonValue(input), resolvedTarget: snapshot.target,
        targetVersion: normalizeJsonValue({ ...snapshot.version as Record<string, JsonValue>, operationId, intentEntryId }),
        preview: normalizeJsonValue({ domain: "english-diary", action: this.toolName, sourcePath: input.sourcePath, englishPath: snapshot.record.englishPath,
          mode: snapshot.record.pending ? "restore-pending" : snapshot.record.result?.sourceFingerprint === snapshot.sourceFingerprint ? "reuse" : "generate" }) };
      const issuedAt = Date.now();
      const ticket = await approvals.issue({ ...contract, issuedAt, expiresAt: issuedAt + 300_000 });
      let accepted: boolean;
      try { accepted = await confirmation.confirm({ ...identity, requestId: ticket.ticketId, toolCallId: event.toolCallId, toolId: this.toolName, target: ticket.resolvedTarget, preview: ticket.preview, signal }); }
      catch { await approvals.resolve({ ticketId: ticket.ticketId, productRunId: identity.productRunId, toolCallId: event.toolCallId, resolution: "cancelled" }); fail("approval_cancelled"); }
      if (!accepted || signal?.aborted) {
        const resolution = signal?.aborted ? "cancelled" : "denied";
        await approvals.resolve({ ticketId: ticket.ticketId, productRunId: identity.productRunId, toolCallId: event.toolCallId, resolution });
        fail(resolution === "cancelled" ? "approval_cancelled" : "approval_denied");
      }
      await this.check(input, identity, event.toolCallId, snapshot.target, requestIdentity);
      const authorization = await approvals.consume({ ticketId: ticket.ticketId, operationIdentity: ticket.operationIdentity, contract });
      await receipts.beginAuthorizedOperation(authorization);
      this.calls.set(event.toolCallId, { input, identity, requestIdentity, snapshot, operationId, authorization, state: "authorized" });
    } catch (error) { return { block: true as const, reason: codeOf(error) }; }
  }
  async execute(id: string, value: unknown, signal?: AbortSignal): Promise<void> {
    const call = this.calls.get(id);
    if (!call || call.state !== "authorized" || !isDeepStrictEqual(call.input, normalizeEnglishDiaryToolRequest(value))) fail("english_diary_authorization_failed");
    call.state = "consumed";
    let started = false, locked = false;
    const active = activeSources.get(this.port!.api) ?? new Set<string>();
    activeSources.set(this.port!.api, active);
    let result: Record<string, unknown>;
    try {
      if (signal?.aborted) fail("approval_cancelled");
      if (active.has(call.input.sourcePath) || this.port!.api.isGenerating(call.input.sourcePath)) fail("english_diary_busy");
      active.add(call.input.sourcePath); locked = true;
      await this.check(call.input, call.identity, id, call.snapshot.target, call.requestIdentity);
      const before = await this.snapshot(call.input.sourcePath);
      if (!isDeepStrictEqual(before.version, call.snapshot.version) || !isDeepStrictEqual(before.target, call.snapshot.target)) fail("english_diary_version_changed");
      const assertCanPublish = async () => {
        if (signal?.aborted) fail("approval_cancelled");
        await this.check(call.input, call.identity, id, call.snapshot.target, call.requestIdentity);
      };
      await assertCanPublish();
      if (this.port!.api.isGenerating(call.input.sourcePath)) fail("english_diary_busy");
      await this.options.receipts!.markEffectStarted(call.authorization.operationIdentity);
      started = true;
      const generated = await this.port!.api.generate(call.input.sourcePath, { owner: "agent", generator: this.port!.generator,
        operationId: call.operationId, signal, assertCanPublish });
      const after = await this.snapshot(call.input.sourcePath);
      const verified = !after.record.pending && !after.record.missingEnglish && !!after.record.observedFileFingerprint
        && after.sourceFingerprint === call.snapshot.sourceFingerprint && after.record.result?.sourceFingerprint === after.sourceFingerprint
        && after.record.result.operationId === generated.result?.operationId && generated.result?.operationId === call.operationId
        && after.record.englishPath === call.snapshot.record.englishPath
        && (after.record.observedFileFingerprint === after.record.savedFileFingerprint
          || generated.result?.operationId === call.snapshot.record.result?.operationId && after.record.observedFileFingerprint === call.snapshot.record.observedFileFingerprint);
      result = { status: verified ? "completed" : "uncertain", readbackVerified: verified, sourcePath: call.input.sourcePath,
        englishPath: after.record.englishPath, operationId: call.operationId,
        expressionCount: after.record.result?.expressions.length ?? 0, observedTargetVersion: after.version,
        ...(!verified ? { reason: "english_diary_result_uncertain_check_original_operation" } : {}) };
    } catch (error) {
      const reason = codeOf(error);
      // Busy is rejected before service I/O. Other started failures are retryable only with pure readback proof.
      const unchanged = started && reason !== "english_diary_busy" ? await this.inspectUnchangedPublication(call.snapshot, call.input.sourcePath) : null;
      result = { status: started && reason !== "english_diary_busy" && !unchanged ? "uncertain" : signal?.aborted ? "cancelled" : "failed", reason, readbackVerified: false,
        sourcePath: call.input.sourcePath, operationId: call.operationId,
        ...(unchanged ? { noPublicationVerified: true, observedTargetVersion: unchanged.version } : {}) };
    } finally { if (locked) active.delete(call.input.sourcePath); }
    try {
      if (started) await this.options.receipts!.markEffectCompleted(call.authorization.operationIdentity);
      await this.options.receipts!.persistReceipt({ operationIdentity: call.authorization.operationIdentity,
        status: result.status as "completed" | "failed" | "cancelled" | "uncertain",
        safeSummary: normalizeJsonValue({ source: "echoink-english-diary", status: result.status, sourcePath: call.input.sourcePath,
          englishPath: call.snapshot.record.englishPath, operationId: call.operationId, expressionCount: result.expressionCount ?? 0,
          noPublicationVerified: result.noPublicationVerified === true }),
        readback: { checkedAt: Date.now(), readbackVerified: result.readbackVerified === true, observedTargetVersion: normalizeJsonValue(result.observedTargetVersion ?? null),
          safeSummary: result.readbackVerified ? "English diary readback verified" : result.noPublicationVerified
            ? "Source and publication state unchanged; no diary published" : "Inspect the original operation before retrying" } });
      result.operationIdentity = call.authorization.operationIdentity;
    } catch { result = { status: "uncertain", reason: "english_diary_receipt_uncertain_check_original_operation", readbackVerified: false, operationIdentity: call.authorization.operationIdentity }; }
    call.result = result;
    call.state = "result_ready";
  }
  async handleToolResult(event: ToolResultEvent) {
    const call = this.calls.get(event.toolCallId); this.calls.delete(event.toolCallId);
    const valid = event.toolName === this.toolName && call?.state === "result_ready";
    const secured = await secureVaultToolResult({ toolId: this.toolName, effectType: "user_write", egressPolicy: "echoink-configured-provider-v1",
      value: valid ? call.result : { error: "english_diary_authorization_failed" }, sizeLimitBytes: 8_000, egress: new EchoInkVaultToolEgressPolicy() });
    return { content: [{ type: "text" as const, text: secured.text }], details: { source: "echoink-english-diary", toolCallId: event.toolCallId,
      status: call?.result?.status, readbackVerified: call?.result?.readbackVerified === true, truncated: secured.truncated },
      isError: !valid || call?.result?.status !== "completed" || secured.truncated };
  }
}
export function createPiEnglishDiaryToolDefinitions(port: PiEnglishDiaryToolPort, security: PiEnglishDiaryToolSecurity): ToolDefinition[] {
  security.bindPort(port);
  return [defineTool({ name: PI_ENGLISH_DIARY_TOOL_ID, label: "生成英文日记",
    description: "只处理当前用户明确指定的原稿精确路径，通过正式英文日记服务生成或恢复，沿用发送范围、英文模型、写入确认与回执。只返回状态、成果路径与表达数量；不返回原稿或英文全文。已有结果先复用；结果不确定不能自动重试，英文手改需回原面板确认。",
    parameters: Type.Object({ sourcePath: Type.String({ minLength: 1, maxLength: 2_000 }) }, { additionalProperties: false }),
    execute: async (id, args, signal) => { await security.execute(id, args, signal); return { content: [{ type: "text" as const, text: "english_diary_result_pending_safety" }], details: {} }; } })];
}
