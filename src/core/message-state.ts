import { createHash } from "node:crypto";
import {
  LARGE_MESSAGE_THRESHOLD,
  countLines,
  rawRefForMessage
} from "./raw-message-store";
import type {
  ChatMessage,
  EchoInkChatRunTerminalRecovery,
  StoredSession
} from "../settings/settings";

export interface PendingRunTerminalRecovery {
  runId: string;
  backendId?: string;
  status: "completed" | "cancelled" | "failed";
  text?: string;
  error?: string;
  data?: Record<string, unknown>;
}

export interface ResolvedEchoInkChatRunTerminalRecovery {
  marker: EchoInkChatRunTerminalRecovery;
  carrier: ChatMessage;
  terminal: PendingRunTerminalRecovery;
  projectedText: string;
}

export type ReadChatTerminalRawText = (rawRef: string) => Promise<string>;

interface ClearedRunTerminalRecovery {
  message: ChatMessage;
  pending: ChatMessage["runTerminalRecoveryPending"];
  authority: ChatMessage["echoInkRunTerminalRecovery"];
  recovered: ChatMessage["runTerminalRecovered"];
}

export function normalizeChatRunTerminal(
  input: PendingRunTerminalRecovery
): PendingRunTerminalRecovery {
  const runId = input.runId.trim();
  if (!runId) throw new Error("Chat terminal authority requires a runId");
  const backendId = input.backendId?.trim();
  if (input.backendId !== undefined && !backendId) {
    throw new Error("Chat terminal authority backendId is invalid");
  }
  if (input.status === "completed" && input.error !== undefined) {
    throw new Error(
      `Completed Chat terminal ${runId} cannot carry an error payload`
    );
  }
  if (input.status !== "completed" && input.text !== undefined) {
    throw new Error(
      `${input.status} Chat terminal ${runId} cannot carry a text payload`
    );
  }
  if (input.text !== undefined && typeof input.text !== "string") {
    throw new Error(`Chat terminal text is invalid for ${runId}`);
  }
  if (input.error !== undefined && typeof input.error !== "string") {
    throw new Error(`Chat terminal error is invalid for ${runId}`);
  }
  const data = input.data === undefined
    ? undefined
    : normalizePersistableJsonRecord(input.data, "terminal data");
  return {
    runId,
    status: input.status,
    ...(backendId ? { backendId } : {}),
    ...(input.text !== undefined ? { text: input.text } : {}),
    ...(input.error !== undefined ? { error: input.error } : {}),
    ...(data ? { data } : {})
  };
}

export function chatRunTerminalPayloadHash(
  input: PendingRunTerminalRecovery
): string {
  const terminal = normalizeChatRunTerminal(input);
  const payloadValue = terminal.status === "completed"
    ? terminal.text
    : terminal.error;
  return sha256(stableJson({
    status: terminal.status,
    backendId: terminal.backendId ?? null,
    payload: {
      field: terminal.status === "completed" ? "text" : "error",
      present: payloadValue !== undefined,
      value: payloadValue ?? null
    },
    data: terminal.data === undefined
      ? { present: false, value: null }
      : { present: true, value: terminal.data }
  }));
}

export function echoInkChatTerminalCommitId(
  input: PendingRunTerminalRecovery,
  carrierMessageId: string
): string {
  const terminal = normalizeChatRunTerminal(input);
  const normalizedCarrier = carrierMessageId.trim();
  if (!normalizedCarrier) {
    throw new Error(
      `Chat terminal authority requires a carrier message for ${terminal.runId}`
    );
  }
  const digest = sha256(stableJson({
    namespace: "echoink.chat-terminal",
    schemaVersion: 1,
    runId: terminal.runId,
    payloadHash: chatRunTerminalPayloadHash(terminal),
    carrierMessageId: normalizedCarrier
  })).slice("sha256:".length);
  return `echoink:chat-terminal:v1:${digest}`;
}

export function echoInkChatTerminalRawRef(
  input: PendingRunTerminalRecovery,
  carrierMessageId: string
): string {
  const commitId = echoInkChatTerminalCommitId(input, carrierMessageId);
  const digest = commitId
    .slice("echoink:chat-terminal:v1:".length)
    .slice(0, 24);
  return rawRefForMessage(
    `${carrierMessageId}--echoink-chat-terminal-${digest}`
  );
}

export function chatRunTerminalProjectedText(
  input: PendingRunTerminalRecovery
): string {
  const terminal = normalizeChatRunTerminal(input);
  if (terminal.status === "completed") return terminal.text ?? "";
  if (terminal.error !== undefined) return terminal.error;
  return terminal.status === "cancelled"
    ? "本轮对话已中断。"
    : "本轮对话失败。";
}

export function createEchoInkChatRunTerminalRecovery(
  input: PendingRunTerminalRecovery,
  carrier: ChatMessage
): EchoInkChatRunTerminalRecovery {
  const terminal = normalizeChatRunTerminal(input);
  const projectedText = chatRunTerminalProjectedText(terminal);
  const payloadValue = terminal.status === "completed"
    ? terminal.text
    : terminal.error;
  const payloadHash = chatRunTerminalPayloadHash(terminal);
  const terminalCommitId = echoInkChatTerminalCommitId(
    terminal,
    carrier.id
  );
  const contentHash = hashText(projectedText);
  const size = projectedText.length;
  const lines = countLines(projectedText);
  let payloadSource: EchoInkChatRunTerminalRecovery["payloadSource"];
  if (carrier.rawRef) {
    if (
      carrier.rawRef !== echoInkChatTerminalRawRef(terminal, carrier.id)
      || carrier.rawSize !== size
      || carrier.rawLines !== lines
      || carrier.rawTruncatedForPreview !== true
    ) {
      throw new Error(
        `Chat terminal Raw identity is incomplete for ${terminal.runId}`
      );
    }
    payloadSource = {
      kind: "raw",
      rawRef: carrier.rawRef,
      contentHash,
      previewHash: hashText(carrier.text),
      size,
      lines
    };
  } else {
    if (projectedText.length > LARGE_MESSAGE_THRESHOLD) {
      throw new Error(
        `Chat terminal Raw payload was not persisted for ${terminal.runId}`
      );
    }
    if (
      carrier.previewText !== undefined
      || carrier.rawSize !== undefined
      || carrier.rawLines !== undefined
      || carrier.rawTruncatedForPreview !== undefined
    ) {
      throw new Error(
        `Chat terminal inline payload has stale Raw metadata for ${terminal.runId}`
      );
    }
    payloadSource = {
      kind: "inline",
      value: projectedText,
      contentHash,
      size,
      lines
    };
  }
  return {
    namespace: "echoink.chat-terminal",
    schemaVersion: 1,
    runId: terminal.runId,
    status: terminal.status,
    ...(terminal.backendId ? { backendId: terminal.backendId } : {}),
    ...(terminal.data ? { data: terminal.data } : {}),
    payloadPresent: payloadValue !== undefined,
    payloadHash,
    terminalCommitId,
    carrierMessageId: carrier.id,
    payloadSource
  };
}

export async function resolveEchoInkChatRunTerminalRecovery(
  messages: ChatMessage[],
  runId: string,
  readRawText: ReadChatTerminalRawText,
  options: { strictProjection?: boolean } = {}
): Promise<ResolvedEchoInkChatRunTerminalRecovery | null> {
  const normalizedRunId = runId.trim();
  const runMessages = messages.filter(
    (message) => message.runId?.trim() === normalizedRunId
  );
  const statusMarkers = runMessages.filter(
    (message) => message.runTerminalRecoveryPending !== undefined
  );
  const authorityMarkers = runMessages.filter(
    (message) => message.echoInkRunTerminalRecovery !== undefined
  );
  if (!authorityMarkers.length) {
    if (statusMarkers.length) {
      throw new Error(
        `Chat terminal recovery marker for ${normalizedRunId} lacks full authority identity`
      );
    }
    return null;
  }
  if (authorityMarkers.length !== 1 || statusMarkers.length !== 1) {
    throw new Error(
      `Chat terminal authority is ambiguous for ${normalizedRunId}`
    );
  }
  const carrier = authorityMarkers[0];
  const marker = carrier.echoInkRunTerminalRecovery!;
  if (
    statusMarkers[0] !== carrier
    || carrier.runTerminalRecoveryPending !== marker.status
  ) {
    throw new Error(
      `Chat terminal authority status marker conflicts for ${normalizedRunId}`
    );
  }
  if (
    marker.namespace !== "echoink.chat-terminal"
    || marker.schemaVersion !== 1
    || marker.runId !== normalizedRunId
    || marker.carrierMessageId !== carrier.id
  ) {
    throw new Error(
      `Chat terminal authority identity is invalid for ${normalizedRunId}`
    );
  }
  const projectedText = await readEchoInkTerminalPayloadSource(
    marker,
    readRawText
  );
  const terminal: PendingRunTerminalRecovery = normalizeChatRunTerminal({
    runId: marker.runId,
    status: marker.status,
    ...(marker.backendId ? { backendId: marker.backendId } : {}),
    ...(marker.payloadPresent
      ? marker.status === "completed"
        ? { text: projectedText }
        : { error: projectedText }
      : {}),
    ...(marker.data ? { data: marker.data } : {})
  });
  if (
    chatRunTerminalPayloadHash(terminal) !== marker.payloadHash
    || echoInkChatTerminalCommitId(terminal, carrier.id)
      !== marker.terminalCommitId
  ) {
    throw new Error(
      `Chat terminal authority payload hash conflicts for ${normalizedRunId}`
    );
  }
  if (marker.payloadSource.kind === "raw") {
    const expectedRawRef = echoInkChatTerminalRawRef(
      terminal,
      carrier.id
    );
    if (
      marker.payloadSource.rawRef !== expectedRawRef
      || carrier.rawRef !== expectedRawRef
    ) {
      throw new Error(
        `Chat terminal Raw authority identity conflicts for ${normalizedRunId}`
      );
    }
  }
  if (options.strictProjection) {
    assertEchoInkChatTerminalProjection(marker, carrier, projectedText);
  }
  return {
    marker,
    carrier,
    terminal,
    projectedText
  };
}

export function findStoredSessionForChatRun(
  sessions: StoredSession[],
  runId: string
): StoredSession | null {
  const normalizedRunId = runId.trim();
  const matches = sessions.filter((session) =>
    session.messages.some(
      (message) => message.runId?.trim() === normalizedRunId
    )
  );
  if (matches.length > 1) {
    throw new Error(
      `Chat terminal authority spans multiple Conversations for ${normalizedRunId}`
    );
  }
  return matches[0] ?? null;
}

export interface StaleHarnessRunRecoveryResult {
  settledMessageCount: number;
  settledRunIds: string[];
  failedRunIds: string[];
}

export interface StaleChatHarnessRunRecoveryInput {
  messages: ChatMessage[];
  commitLocalHistory: () => Promise<void>;
  commitRunTerminal: (
    candidate: PendingRunTerminalRecovery,
    persistWinner: (winner: PendingRunTerminalRecovery) => Promise<void>
  ) => Promise<void>;
  deferRunIds?: ReadonlySet<string>;
}

export async function recoverStaleChatHarnessRuns(
  input: StaleChatHarnessRunRecoveryInput
): Promise<StaleHarnessRunRecoveryResult> {
  const candidates = planStaleHarnessRunRecoveries(
    input.messages,
    input.deferRunIds
  );
  let settledMessageCount = 0;
  const settledRunIds: string[] = [];
  const failedRunIds: string[] = [];

  for (const candidate of candidates) {
    let winnerPersisted = false;
    let winner: PendingRunTerminalRecovery | null = null;
    try {
      await input.commitRunTerminal(candidate, async (actualWinner) => {
        assertRecoveryWinner(candidate.runId, actualWinner);
        winner = actualWinner;
        settledMessageCount += applyChatRunTerminalWinner(
          input.messages,
          actualWinner
        );
        await input.commitLocalHistory();
        winnerPersisted = true;
      });
      if (!winnerPersisted || !winner) {
        throw new Error(
          `Chat terminal authority did not persist a winner for ${candidate.runId}`
        );
      }
      const durableWinner = winner as PendingRunTerminalRecovery;

      const recoveredMarker = clearRunTerminalRecovery(
        input.messages,
        candidate.runId
      );
      try {
        await input.commitLocalHistory();
      } catch (error) {
        restoreRunTerminalRecovery(
          input.messages,
          candidate.runId,
          durableWinner.status,
          recoveredMarker
        );
        throw error;
      }
      settledRunIds.push(candidate.runId);
    } catch {
      failedRunIds.push(candidate.runId);
    }
  }

  return { settledMessageCount, settledRunIds, failedRunIds };
}

export async function recoverStaleHarnessRuns(input: {
  messages: ChatMessage[];
  commitLocalHistory: () => Promise<void>;
  settleRunTerminal: (recovery: PendingRunTerminalRecovery) => Promise<void>;
  deferRunIds?: ReadonlySet<string>;
}): Promise<StaleHarnessRunRecoveryResult> {
  const settledMessageCount = settleStaleRunningMessages(
    input.messages,
    input.deferRunIds
  );
  if (settledMessageCount > 0) await input.commitLocalHistory();

  const recoveries = pendingRunTerminalRecoveries(
    input.messages,
    input.deferRunIds
  );
  const settledRunIds: string[] = [];
  const failedRunIds: string[] = [];
  for (const recovery of recoveries) {
    try {
      await input.settleRunTerminal(recovery);
      clearRunTerminalRecovery(input.messages, recovery.runId);
      settledRunIds.push(recovery.runId);
    } catch {
      failedRunIds.push(recovery.runId);
    }
  }
  if (settledRunIds.length > 0) await input.commitLocalHistory();
  return { settledMessageCount, settledRunIds, failedRunIds };
}

export function settleStaleRunningMessages(
  messages: ChatMessage[],
  deferRunIds: ReadonlySet<string> = new Set()
): number {
  let settled = 0;
  const pendingByRun = new Map<string, "cancelled" | "failed">();
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.status !== "running") continue;
    if (message.runId && deferRunIds.has(message.runId)) continue;

    if (message.runId) {
      const status = isKnowledgeBaseRunMessage(message) ? "failed" : "cancelled";
      if (status === "failed" || !pendingByRun.has(message.runId)) pendingByRun.set(message.runId, status);
    }

    if (message.itemType === "thinking" || isEmptyProcessMessage(message)) {
      messages.splice(index, 1);
      settled += 1;
      continue;
    }

    if (isKnowledgeBaseRunMessage(message)) {
      message.status = "failed";
      message.text = staleKnowledgeBaseRunText(message.knowledgeBaseUi?.mode);
      delete message.knowledgeBaseUi;
      settled += 1;
      continue;
    }

    message.status = "interrupted";
    settled += 1;
  }
  const completedRunIds = new Set(messages
    .filter((message) => message.runId && isCompletedFinalAnswer(message))
    .map((message) => message.runId as string));
  for (const message of messages) {
    if (!message.runId || message.runTerminalRecovered || completedRunIds.has(message.runId)) continue;
    if (message.status === "interrupted" || message.status === "canceled" || message.status === "cancelled") {
      if (!pendingByRun.has(message.runId)) pendingByRun.set(message.runId, "cancelled");
    } else if (message.status === "failed" || message.status === "error") {
      pendingByRun.set(message.runId, "failed");
    }
  }
  for (const [runId, status] of pendingByRun) {
    const marker = [...messages].reverse().find((message) => message.runId === runId);
    if (marker) marker.runTerminalRecoveryPending = status;
  }
  return settled;
}

export function pendingRunTerminalRecoveries(
  messages: ChatMessage[],
  deferRunIds: ReadonlySet<string> = new Set()
): PendingRunTerminalRecovery[] {
  const recoveries = new Map<string, PendingRunTerminalRecovery>();
  for (const message of messages) {
    const status = message.runTerminalRecoveryPending;
    if (!message.runId || !status) continue;
    if (deferRunIds.has(message.runId)) continue;
    const authority = message.echoInkRunTerminalRecovery;
    if (authority) {
      const existing = recoveries.get(message.runId);
      const payload = authority.payloadSource.kind === "inline"
        ? authority.payloadSource.value
        : undefined;
      const candidate = normalizeChatRunTerminal({
        runId: authority.runId,
        status: authority.status,
        ...(authority.backendId ? { backendId: authority.backendId } : {}),
        ...(authority.payloadPresent && payload !== undefined
          ? authority.status === "completed"
            ? { text: payload }
            : { error: payload }
          : {}),
        ...(authority.data ? { data: authority.data } : {})
      });
      if (
        existing
        && (
          existing.status !== candidate.status
          || existing.backendId !== candidate.backendId
          || (
            existing.text !== undefined
            && candidate.text !== undefined
            && existing.text !== candidate.text
          )
          || (
            existing.error !== undefined
            && candidate.error !== undefined
            && existing.error !== candidate.error
          )
        )
      ) {
        throw new Error(
          `Chat terminal recovery markers conflict for ${message.runId}`
        );
      }
      recoveries.set(message.runId, candidate);
      continue;
    }
    const current = recoveries.get(message.runId);
    const recoveryStatus = mergeRunTerminalRecoveryStatus(
      current?.status,
      status
    );
    recoveries.set(message.runId, {
      runId: message.runId,
      backendId: message.backendId ?? current?.backendId,
      status: recoveryStatus,
      ...(recoveryStatus === "completed"
        ? { text: message.text }
        : {
          error: recoveryStatus === "failed"
            ? "插件重载时知识库任务未完成"
            : "插件重载导致运行中断"
        })
    });
  }
  return [...recoveries.values()];
}

export function planStaleHarnessRunRecoveries(
  messages: ChatMessage[],
  deferRunIds: ReadonlySet<string> = new Set()
): PendingRunTerminalRecovery[] {
  const probe = messages.map((message) => ({ ...message }));
  settleStaleRunningMessages(probe, deferRunIds);
  return pendingRunTerminalRecoveries(probe, deferRunIds);
}

export function applyChatRunTerminalWinner(
  messages: ChatMessage[],
  winner: PendingRunTerminalRecovery
): number {
  const terminal = normalizeChatRunTerminal(winner);
  const runMessages = messages.filter(
    (message) => message.runId === terminal.runId
  );
  if (!runMessages.length) {
    throw new Error(
      `Chat terminal recovery cannot find Conversation messages for ${terminal.runId}`
    );
  }
  let changed = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.runId !== terminal.runId) continue;
    if (message.itemType === "thinking" || isEmptyProcessMessage(message)) {
      messages.splice(index, 1);
      changed += 1;
    }
  }

  const remaining = messages.filter(
    (message) => message.runId === terminal.runId
  );
  const authoritativeCarrier = remaining.find((message) =>
    message.echoInkRunTerminalRecovery?.runId === terminal.runId
    && message.echoInkRunTerminalRecovery.carrierMessageId === message.id
  );
  const answer = authoritativeCarrier
    ?? [...remaining].reverse().find((message) =>
      message.role === "assistant"
      && (!message.itemType || message.itemType === "assistant")
    );
  if (terminal.status === "completed" && !answer) {
    throw new Error(
      `Completed Chat terminal recovery has no answer carrier for ${terminal.runId}`
    );
  }

  for (const message of remaining) {
    if (isProcessItemType(message.itemType) && message.status === "running") {
      message.status = terminal.status === "completed"
        ? "completed"
        : "interrupted";
      changed += 1;
    }
  }
  if (answer) {
    const preserveProjection = canPreserveEchoInkTerminalProjection(
      answer,
      terminal
    );
    if (!preserveProjection) clearMessageRawProjection(answer);
    if (terminal.status === "completed") {
      answer.status = "completed";
      if (!preserveProjection) {
        answer.text = chatRunTerminalProjectedText(terminal);
      }
      delete answer.title;
    } else if (terminal.status === "cancelled") {
      answer.status = "interrupted";
      answer.title = "已中断";
      if (!preserveProjection) {
        answer.text = chatRunTerminalProjectedText(terminal);
      }
    } else {
      answer.status = "failed";
      answer.title = "回复失败";
      if (!preserveProjection) {
        answer.text = chatRunTerminalProjectedText(terminal);
      }
    }
    if (terminal.backendId) answer.backendId = terminal.backendId;
    else delete answer.backendId;
    answer.completedAt = Date.now();
    changed += 1;
  }

  const marker = answer ?? remaining.at(-1);
  if (!marker) {
    throw new Error(
      `Chat terminal recovery has no durable marker for ${terminal.runId}`
    );
  }
  marker.runTerminalRecoveryPending = terminal.status;
  delete marker.runTerminalRecovered;
  if (terminal.backendId) marker.backendId = terminal.backendId;
  else delete marker.backendId;
  return changed;
}

function clearRunTerminalRecovery(
  messages: ChatMessage[],
  runId: string
): ClearedRunTerminalRecovery | null {
  let recoveredMarker: ClearedRunTerminalRecovery | null = null;
  for (const message of messages) {
    if (message.runId !== runId) continue;
    if (
      message.runTerminalRecoveryPending
      || message.echoInkRunTerminalRecovery
    ) {
      recoveredMarker = {
        message,
        pending: message.runTerminalRecoveryPending,
        authority: message.echoInkRunTerminalRecovery,
        recovered: message.runTerminalRecovered
      };
    }
    delete message.runTerminalRecoveryPending;
    delete message.echoInkRunTerminalRecovery;
  }
  if (recoveredMarker) recoveredMarker.message.runTerminalRecovered = true;
  return recoveredMarker;
}

function restoreRunTerminalRecovery(
  messages: ChatMessage[],
  runId: string,
  status: NonNullable<ChatMessage["runTerminalRecoveryPending"]>,
  preferredMarker: ClearedRunTerminalRecovery | null
): void {
  const marker = preferredMarker?.message
    ?? [...messages].reverse().find((message) => message.runId === runId);
  if (!marker) return;
  marker.runTerminalRecoveryPending = preferredMarker?.pending ?? status;
  if (preferredMarker?.authority) {
    marker.echoInkRunTerminalRecovery = preferredMarker.authority;
  }
  if (preferredMarker?.recovered === undefined) {
    delete marker.runTerminalRecovered;
  } else {
    marker.runTerminalRecovered = preferredMarker.recovered;
  }
}

function assertRecoveryWinner(
  expectedRunId: string,
  winner: PendingRunTerminalRecovery
): void {
  if (winner.runId !== expectedRunId) {
    throw new Error(
      `Chat terminal authority returned ${winner.runId} for ${expectedRunId}`
    );
  }
}

function mergeRunTerminalRecoveryStatus(
  current: PendingRunTerminalRecovery["status"] | undefined,
  next: PendingRunTerminalRecovery["status"]
): PendingRunTerminalRecovery["status"] {
  if (!current || current === next) return next;
  if (current === "failed" || next === "failed") return "failed";
  if (current === "cancelled" || next === "cancelled") return "cancelled";
  return "completed";
}

async function readEchoInkTerminalPayloadSource(
  marker: EchoInkChatRunTerminalRecovery,
  readRawText: ReadChatTerminalRawText
): Promise<string> {
  const source = marker.payloadSource;
  let text: string;
  if (source.kind === "inline") {
    if (source.value.length > LARGE_MESSAGE_THRESHOLD) {
      throw new Error(
        `Oversized Chat terminal payload is duplicated inline for ${marker.runId}`
      );
    }
    text = source.value;
  } else {
    text = await readRawText(source.rawRef);
  }
  if (
    source.contentHash !== hashText(text)
    || source.size !== text.length
    || source.lines !== countLines(text)
  ) {
    throw new Error(
      `Chat terminal payload source conflicts for ${marker.runId}`
    );
  }
  return text;
}

function assertEchoInkChatTerminalProjection(
  marker: EchoInkChatRunTerminalRecovery,
  carrier: ChatMessage,
  projectedText: string
): void {
  if (
    carrier.runId !== marker.runId
    || carrier.id !== marker.carrierMessageId
    || carrier.backendId !== marker.backendId
    || !chatTerminalMessageStatusMatches(carrier, marker.status)
  ) {
    throw new Error(
      `Conversation projection conflicts with Chat terminal authority for ${marker.runId}`
    );
  }
  const source = marker.payloadSource;
  if (source.kind === "inline") {
    if (
      carrier.text !== projectedText
      || carrier.previewText !== undefined
      || carrier.rawRef !== undefined
      || carrier.rawSize !== undefined
      || carrier.rawLines !== undefined
      || carrier.rawTruncatedForPreview !== undefined
    ) {
      throw new Error(
        `Conversation inline projection conflicts for ${marker.runId}`
      );
    }
    return;
  }
  if (
    carrier.rawRef !== source.rawRef
    || carrier.rawSize !== source.size
    || carrier.rawLines !== source.lines
    || carrier.rawTruncatedForPreview !== true
    || carrier.previewText !== carrier.text
    || hashText(carrier.text) !== source.previewHash
  ) {
    throw new Error(
      `Conversation Raw projection conflicts for ${marker.runId}`
    );
  }
}

function canPreserveEchoInkTerminalProjection(
  carrier: ChatMessage,
  terminal: PendingRunTerminalRecovery
): boolean {
  const marker = carrier.echoInkRunTerminalRecovery;
  if (
    !marker
    || marker.runId !== terminal.runId
    || marker.status !== terminal.status
    || marker.backendId !== terminal.backendId
    || marker.payloadHash !== chatRunTerminalPayloadHash(terminal)
    || marker.carrierMessageId !== carrier.id
    || !chatTerminalMessageStatusMatches(carrier, terminal.status)
  ) {
    return false;
  }
  const source = marker.payloadSource;
  if (source.kind === "inline") {
    return carrier.text === source.value
      && carrier.rawRef === undefined
      && carrier.previewText === undefined
      && carrier.rawSize === undefined
      && carrier.rawLines === undefined
      && carrier.rawTruncatedForPreview === undefined;
  }
  return carrier.rawRef === source.rawRef
    && carrier.rawSize === source.size
    && carrier.rawLines === source.lines
    && carrier.rawTruncatedForPreview === true
    && carrier.previewText === carrier.text
    && hashText(carrier.text) === source.previewHash;
}

function chatTerminalMessageStatusMatches(
  message: ChatMessage,
  status: PendingRunTerminalRecovery["status"]
): boolean {
  if (status === "completed") {
    return message.status === "completed" && message.title === undefined;
  }
  if (status === "cancelled") {
    return message.status === "interrupted" && message.title === "已中断";
  }
  return message.status === "failed" && message.title === "回复失败";
}

function clearMessageRawProjection(message: ChatMessage): void {
  delete message.previewText;
  delete message.rawRef;
  delete message.rawSize;
  delete message.rawLines;
  delete message.rawTruncatedForPreview;
}

function normalizePersistableJsonRecord(
  value: Record<string, unknown>,
  label: string
): Record<string, unknown> {
  const normalized = normalizePersistableJsonValue(
    value,
    label,
    new WeakSet<object>()
  );
  if (
    !normalized
    || typeof normalized !== "object"
    || Array.isArray(normalized)
  ) {
    throw new Error(`Chat ${label} must be a JSON object`);
  }
  return normalized as Record<string, unknown>;
}

function normalizePersistableJsonValue(
  value: unknown,
  label: string,
  ancestors: WeakSet<object>
): unknown {
  if (
    value === null
    || typeof value === "string"
    || typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`Chat ${label} contains a non-finite number`);
    }
    return value;
  }
  if (!value || typeof value !== "object") {
    throw new Error(`Chat ${label} contains a non-persistable value`);
  }
  if (ancestors.has(value)) {
    throw new Error(`Chat ${label} contains a cyclic value`);
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) =>
        normalizePersistableJsonValue(item, label, ancestors)
      );
    }
    const prototype = Reflect.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error(`Chat ${label} contains a non-plain object`);
    }
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [
          key,
          normalizePersistableJsonValue(item, label, ancestors)
        ])
    );
  } finally {
    ancestors.delete(value);
  }
}

function stableJson(value: unknown): string {
  return JSON.stringify(value);
}

function hashText(text: string): string {
  return sha256(text);
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function isCompletedFinalAnswer(message: ChatMessage): boolean {
  if (message.role !== "assistant" || message.status !== "completed") return false;
  return !message.itemType || message.itemType === "assistant";
}

function isEmptyProcessMessage(message: ChatMessage): boolean {
  if (!isProcessItemType(message.itemType)) return false;
  return !String(message.text ?? "").trim();
}

function isProcessItemType(itemType?: string): boolean {
  return itemType === "reasoning" || itemType === "commandExecution" || itemType === "fileChange" || itemType === "mcpToolCall" || itemType === "dynamicToolCall" || itemType === "collabAgentToolCall" || itemType === "plan";
}

function isKnowledgeBaseRunMessage(message: ChatMessage): boolean {
  return message.itemType === "knowledgeBase" && message.knowledgeBaseUi?.kind === "maintain-run";
}

function staleKnowledgeBaseRunText(mode: unknown): string {
  return `知识库${knowledgeBaseModeLabel(mode)}失败：任务中断，未收到完成报告。`;
}

function knowledgeBaseModeLabel(mode: unknown): string {
  switch (mode) {
    case "lint":
      return "体检";
    case "reingest":
      return "重新提炼";
    case "calibrate":
      return "Raw 状态校准";
    case "outputs":
      return "Outputs 整理";
    case "inbox":
      return "Inbox 分流";
    case "maintain":
    default:
      return "维护";
  }
}
