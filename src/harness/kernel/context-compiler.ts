import type { ChatMessage, StoredSession } from "../../settings/settings";
import {
  emptyContextBundle,
  type ContextBundle,
  type ContextCompileMode,
  type ContextManifest,
  type ContextSection,
  type ContextSyncCursor,
  type SessionContextSnapshot
} from "../contracts/context";
import type { HarnessUserInput, HarnessWorkflow } from "../contracts/run";
import type { MemoryBundle } from "../memory/provider";

export interface CompileContextBundleInput {
  runId?: string;
  session: StoredSession;
  backendId: string;
  workflow: HarnessWorkflow;
  userInput: HarnessUserInput;
  memory: MemoryBundle;
  corePolicySections: ContextSection[];
  mode?: ContextCompileMode;
  cursor?: ContextSyncCursor | null;
  sessionRevision?: number;
  now?: number;
}

export function compileContextBundle(input: CompileContextBundleInput): ContextBundle {
  const mode = input.mode ?? "bootstrap";
  const bundle = emptyContextBundle();
  bundle.corePolicy = [...input.corePolicySections].sort(sortSectionByPriority);
  bundle.workflowContract = [workflowContractSection(input.workflow)];
  bundle.turnInstruction = [{
    id: "turn-instruction",
    priority: 900,
    channel: "user",
    content: input.userInput.text,
    source: "user",
    required: true,
    sensitive: false
  }];
  bundle.sessionContext = sessionContextSections(input.session, input.backendId, mode, input.cursor ?? null);
  bundle.memoryContext = input.memory.sections;
  bundle.attachments = input.userInput.attachments.map((attachment) => ({ ...attachment }));
  bundle.manifest = buildContextManifest({
    runId: input.runId ?? "",
    session: input.session,
    backendId: input.backendId,
    mode,
    sessionRevision: input.sessionRevision ?? input.session.revision ?? 1,
    now: input.now ?? Date.now(),
    bundle
  });
  return bundle;
}

function workflowContractSection(workflow: HarnessWorkflow): ContextSection {
  return {
    id: `workflow:${workflow}`,
    priority: 950,
    channel: "system",
    content: `EchoInk workflow: ${workflow}. Follow EchoInk Core Policy and return output according to this workflow contract.`,
    source: "echoink-workflow",
    required: true,
    sensitive: false
  };
}

function sessionContextSections(session: StoredSession, backendId: string, mode: ContextCompileMode, cursor: ContextSyncCursor | null): ContextSection[] {
  if (mode === "workflow") return [];

  const sections: ContextSection[] = [];
  const snapshot = session.contextSnapshot ?? legacySnapshotFromRollingSummary(session);
  if (snapshot && (mode === "bootstrap" || mode === "catch-up")) {
    sections.push(sessionSnapshotSection(snapshot));
  }

  const messages = messagesForMode(session.messages, mode, cursor, snapshot?.summarizedThroughMessageId);
  const recent = messages
    .map((message) => `${message.role}: ${compactMessageText(message.text)}`)
    .filter(Boolean)
    .join("\n");
  if (recent) {
    sections.push({
      id: `session:${mode}:${backendId}`,
      priority: mode === "catch-up" ? 720 : 650,
      channel: "memory",
      content: recent,
      source: "echoink-session",
      required: false,
      sensitive: false,
      maxTokens: 1200
    });
  }
  return sections;
}

function sessionSnapshotSection(snapshot: SessionContextSnapshot): ContextSection {
  const lines = [
    snapshot.goal ? `Goal: ${snapshot.goal}` : "",
    snapshot.currentState ? `Current state: ${snapshot.currentState}` : "",
    snapshot.decisions.length ? `Decisions:\n${snapshot.decisions.map((item) => `- ${item}`).join("\n")}` : "",
    snapshot.constraints.length ? `Constraints:\n${snapshot.constraints.map((item) => `- ${item}`).join("\n")}` : "",
    snapshot.openLoops.length ? `Open loops:\n${snapshot.openLoops.map((item) => `- ${item}`).join("\n")}` : "",
    snapshot.keyReferences.length ? `Key references:\n${snapshot.keyReferences.map((item) => `- ${item}`).join("\n")}` : "",
    snapshot.rollingSummary ? `Rolling summary:\n${snapshot.rollingSummary}` : "",
    snapshot.summarizedThroughMessageId ? `Summary through message: ${snapshot.summarizedThroughMessageId}` : ""
  ].filter(Boolean);
  return {
    id: "session:context-snapshot",
    priority: 760,
    channel: "memory",
    content: lines.join("\n\n"),
    source: "echoink-session-snapshot",
    required: false,
    sensitive: false,
    maxTokens: 1600
  };
}

function legacySnapshotFromRollingSummary(session: StoredSession): SessionContextSnapshot | null {
  if (!session.rollingSummary?.text) return null;
  return {
    sessionId: session.id,
    version: "legacy-rolling-summary",
    goal: "",
    currentState: "",
    decisions: [],
    constraints: [],
    openLoops: [],
    keyReferences: [],
    rollingSummary: session.rollingSummary.text,
    sourceMessageCount: session.messages.length,
    createdAt: session.rollingSummary.updatedAt,
    updatedAt: session.rollingSummary.updatedAt
  };
}

function messagesForMode(
  messages: ChatMessage[],
  mode: ContextCompileMode,
  cursor: ContextSyncCursor | null,
  summarizedThroughMessageId?: string
): ChatMessage[] {
  if (mode === "incremental") {
    if (!cursor?.syncedThroughMessageId) return [];
    return messagesAfter(messages, cursor.syncedThroughMessageId);
  }
  if (mode === "catch-up") {
    return recentMessages(cursor?.syncedThroughMessageId ? messagesAfter(messages, cursor.syncedThroughMessageId) : messages, 12);
  }
  const afterSummary = summarizedThroughMessageId ? messagesAfter(messages, summarizedThroughMessageId) : messages;
  return recentMessages(afterSummary.length ? afterSummary : messages, 8);
}

function messagesAfter(messages: ChatMessage[], messageId: string): ChatMessage[] {
  const index = messages.findIndex((message) => message.id === messageId);
  if (index < 0) return messages;
  return messages.slice(index + 1);
}

function recentMessages(messages: ChatMessage[], limit: number): ChatMessage[] {
  return messages.filter((message) => message.role === "user" || message.role === "assistant").slice(-limit);
}

function compactMessageText(text: string): string {
  const trimmed = text.replace(/\s+/g, " ").trim();
  return trimmed.length > 1000 ? `${trimmed.slice(0, 997)}...` : trimmed;
}

function sortSectionByPriority(left: ContextSection, right: ContextSection): number {
  return right.priority - left.priority || left.id.localeCompare(right.id);
}

function buildContextManifest(input: {
  runId: string;
  session: StoredSession;
  backendId: string;
  mode: ContextCompileMode;
  sessionRevision: number;
  now: number;
  bundle: ContextBundle;
}): ContextManifest {
  const sections = [
    ...input.bundle.corePolicy,
    ...input.bundle.workflowContract,
    ...input.bundle.turnInstruction,
    ...input.bundle.vaultProfile,
    ...input.bundle.sessionContext,
    ...input.bundle.memoryContext,
    ...input.bundle.knowledgeEvidence,
    ...input.bundle.echoInkSkills,
    ...input.bundle.nativeResourceHints
  ].map((section) => ({
    id: section.id,
    source: section.source,
    includedChars: section.content.length,
    truncated: false
  }));
  return {
    runId: input.runId,
    sessionId: input.session.id,
    backendId: input.backendId,
    mode: input.mode,
    sections,
    compiledThroughMessageId: lastMessageId(input.session.messages),
    sessionRevision: input.sessionRevision,
    snapshotVersion: input.session.contextSnapshot?.version,
    createdAt: input.now
  };
}

function lastMessageId(messages: ChatMessage[]): string | undefined {
  return messages.length ? messages[messages.length - 1].id : undefined;
}
