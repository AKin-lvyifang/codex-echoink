import * as assert from "node:assert/strict";
import { startKnowledgeBaseTurn } from "../../ui/codex-view/turn-runner";
import type { HarnessRunResult } from "../../harness/contracts/run";
import type { ChatMessage, StoredSession } from "../../settings/settings";
import type { QueuedTurnItem } from "../../ui/turn-queue";

export async function runHarnessV2KnowledgeTurnTests(): Promise<void> {
  await assertKnowledgeAskStoresHarnessBackendBinding();
}

async function assertKnowledgeAskStoresHarnessBackendBinding(): Promise<void> {
  const session = baseSession();
  const result: HarnessRunResult = {
    runId: "run-knowledge-ask",
    status: "completed",
    outputText: "回答",
    nativeExecution: {
      backendId: "codex-cli",
      id: "codex-native-thread-1",
      kind: "thread",
      persistence: "provider-persistent",
      deviceKey: "device-1",
      vaultId: "vault-1",
      createdAt: 1000
    },
    backendBinding: {
      backendId: "codex-cli",
      nativeThreadId: "codex-native-thread-1",
      nativeExecutionKind: "thread",
      leaseId: "lease-kb-codex",
      leaseStatus: "active",
      leaseTurnCount: 1,
      contextMode: "bootstrap",
      syncedThroughMessageId: "msg-user-1",
      syncedSessionRevision: 1,
      contextCursor: {
        syncedThroughMessageId: "msg-user-1",
        syncedSessionRevision: 1
      },
      lastUsedAt: 2000,
      expiresAt: 62000
    },
    contextManifest: {
      mode: "bootstrap",
      cursor: {
        syncedThroughMessageId: "msg-user-1",
        syncedSessionRevision: 1
      },
      sections: [],
      messageCount: 1,
      tokenEstimate: 10,
      compiledAt: 1000
    }
  };
  const savedSnapshots: StoredSession[] = [];
  const view = fakeKnowledgeView(session, result, savedSnapshots);

  const status = await startKnowledgeBaseTurn(view, session, queuedKnowledgeAsk(), "composer");

  assert.equal(status, "completed");
  assert.equal(session.backendBindings?.["codex-cli"]?.nativeThreadId, "codex-native-thread-1");
  assert.equal(session.backendBindings?.["codex-cli"]?.leaseId, "lease-kb-codex");
  assert.ok(
    savedSnapshots.some((snapshot) => snapshot.backendBindings?.["codex-cli"]?.leaseId === "lease-kb-codex"),
    "knowledge turn should persist backend binding before later /ask turns"
  );
}

function fakeKnowledgeView(session: StoredSession, harnessResult: HarnessRunResult, savedSnapshots: StoredSession[]) {
  const manager = {
    handleUserMessage: async () => ({
      status: "success" as const,
      message: "回答",
      harnessResult
    }),
    getLastNativeLifecycleSummary: () => undefined
  };
  return {
    plugin: {
      settings: {
        activeSessionId: session.id,
        knowledgeBase: { backend: "codex-cli" }
      },
      getKnowledgeBaseManager: () => manager,
      externalizeMessageText: async (message: ChatMessage, text: string) => {
        message.text = text;
      },
      saveSettings: async () => {
        savedSnapshots.push(JSON.parse(JSON.stringify(session)) as StoredSession);
      },
      settlePendingKnowledgeBaseNativeExecutions: async () => undefined
    },
    activeRunId: "",
    activeRunKind: "",
    activeRunSessionId: "",
    running: false,
    clearComposerDraft: () => undefined,
    renderTabs: () => undefined,
    renderMessagesIfActive: () => undefined,
    renderMessages: () => undefined,
    renderToolbar: () => undefined,
    clearTurnWatchdog: () => undefined,
    clearActiveRun: () => undefined,
    applyStatus: () => undefined,
    refreshKnowledgeDashboard: async () => undefined,
    finishThinkingMessage: () => undefined,
    finishRunningProcessMessages: () => undefined,
    finishPlanMessage: () => undefined,
    moveMessageToEnd: () => undefined,
    fillKnowledgeBaseCommand: () => undefined
  };
}

function baseSession(): StoredSession {
  return {
    id: "kb-session",
    title: "Knowledge",
    cwd: "/vault",
    messages: [],
    createdAt: 1,
    updatedAt: 1
  };
}

function queuedKnowledgeAsk(): QueuedTurnItem {
  return {
    id: "turn-kb-ask",
    sessionId: "kb-session",
    text: "/ask 第一轮",
    attachments: [],
    createdAt: 1,
    turnOptions: {}
  };
}
