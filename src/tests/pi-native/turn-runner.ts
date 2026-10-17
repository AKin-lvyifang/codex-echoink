import { annotationFixture } from "../selection-annotations";
import { restoreSelectionDraft, emptySelectionDraft } from "../../selection-ask/draft";
import * as assert from "node:assert/strict";
import { CodexView } from "../../ui/codex-view";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  PiChatSubmitRequest,
  PiChatRuntimeEvent,
  PiChatRuntimeEventListener,
  PiConversationProjection,
  PiProductRunRecord
} from "../../harness/pi-native/contracts";
import { PI_IMAGE_INPUT_UNSUPPORTED_MESSAGE } from "../../harness/pi-native/contracts";
import { PI_ANTHROPIC_PDF_DOCUMENT_ADAPTER } from "../../harness/pi-native/pi-document-context";
import {
  activateApiProviderModel,
  createApiProviderConfig,
  createApiProviderModelConfig,
  DEFAULT_SETTINGS,
  type ChatMessage,
  type StoredSession
} from "../../settings/settings";
import {
  createQueuedTurnFromComposer,
  enqueueComposerDraft,
  markUnreadCompletedAnswerIfBackground,
  piChatMemoryModeForGlobalSetting,
  piConversationUnreadAnswerAt,
  sendMessage,
  startChatTurn,
  steerPiChatFromComposer,
  startQueuedTurnItem,
  startNextQueuedTurn
} from "../../ui/codex-view/turn-runner";
import { classifyLocalAttachmentType } from "../../ui/codex-view/attachments";
import {
  enabledSkillsForComposerMenu,
  removeTrailingSlashQuery,
  stopTurnFromComposer
} from "../../ui/codex-view/composer-controller";
import { compactBrandedModelLabel } from "../../ui/codex-view/composer";
import { buildActiveEchoInkResourceCatalog } from "../../resources/registry";
import { splitMessageTableRow } from "../../ui/render-message";
import { copyAnswerMarkdown } from "../../ui/codex-view/answer-copy";
import {
  CodexMessageListRenderer,
  personalMemorySourceCountLabel,
  personalMemorySourceEmptyStateLabel,
  piConversationDeriveActionLabel
} from "../../ui/codex-view/message-list";
import {
  renderMessages as renderMessagesThroughController,
  renderMessagesIfActive as renderMessagesIfActiveThroughController
} from "../../ui/codex-view/message-controller";
import {
  activateSession,
  derivePiConversationFromMessage
} from "../../ui/codex-view/session-controller";
import {
  RuntimeTurnQueue,
  type QueuedTurnItem
} from "../../ui/turn-queue";
import {
  copyPiImageAttachmentsForProjection,
  piComposerImageAttachmentsForEntry,
  projectPiImageAttachments
} from "../../ui/codex-view/pi-conversation-support";
import {
  piProjectedEntryMessageId,
  piToolCallIdFromProjectedMessageId
} from "../../harness/pi-native/pi-chat-ui-projector";
import { openTestNoticeMessages } from "../obsidian-shim";
import { addComposerNoteMentionSelection } from "../../ui/codex-view/note-mentions";
import {
  FakeElement,
  createTestContext
} from "../smooth-conversation-ui";
import { preparePiChatDocuments } from "../../ui/codex-view/pi-document-input";

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
);

export async function runPiNativeTurnRunnerTests(): Promise<void> {
  localAttachmentClassificationUsesMimeOrExtension();
  asyncSkillMenuOnlyReturnsEnabledSkills();
  composerModelLabelsOnlyRemoveKnownBrandPrefixes();
  globalMemoryModeOverridesEverySubmit();
  imageMetadataProjectsAndCopiesByPiEntryIdentity();
  tableRowsKeepVaultNoteAliasesInsideOneCell();
  emptyPersonalMemorySourceDisplayDoesNotClaimInjection();
  await messageActionContractsStayTruthful();
  await assistantImageDerivationCopiesMetadataWithoutInventingResend();
  await activeRunImagesUseTheNormalQueue();
  await activeRunNoteMentionsUseTheNormalQueue();
  await queuedImageFailuresAreRetainedOnlyBeforePiAcceptance();
  await inFlightComposerImageTransferCannotDuplicate();
  await imageCapabilityPreflightPreservesCompletedTurn();
  await imageCapabilityFailurePreservesComposerAndAcceptedFailureRecordsMetadata();
  await queuedNativeDocumentCapabilityLossUsesFrozenTextOnly();
  await agentSettlementOnlyFinalizesPiChatTurn();
  await failedSettlementNoticeMatchesDurableFailureReason();
  unreadAnswerRequiresBackgroundCompletedMatchingAssistant();
  await unreadPersistenceFailureDoesNotRestoreAfterConcurrentRead();
  await pendingSubmitKeepsRunningConversationResidentAcrossSessionSwitch();
  await busyActionInAnotherConversationDoesNotStopTheActiveRun();
  await disabledOrStaleSkillCannotStartTurn();
  await maintainScopeIsResolvedBeforeProviderSubmit();
  await queuedTurnsKeepExactProviderModelAndRetainUnavailableHead();
  await concurrentViewRunsRemainIndependent();
}

async function concurrentViewRunsRemainIndependent(): Promise<void> {
  const dom = installTurnRunnerMessageDom();
  const timers = new Map<number, () => void>();
  let timerId = 0;
  window.setTimeout = ((callback: () => void) => {
    timers.set(++timerId, callback);
    return timerId;
  }) as typeof window.setTimeout;
  window.clearTimeout = (id) => { timers.delete(id); };
  const settings = structuredClone(DEFAULT_SETTINGS);
  const sessions = ["A", "B", "C"].map(piSessionShell);
  settings.sessions = sessions;
  settings.activeSessionId = "A";
  const provider = createApiProviderConfig("custom", "concurrent-ui");
  provider.baseUrl = "https://offline.example/v1";
  provider.apiKey = "offline-fixture";
  provider.models = [createApiProviderModelConfig("custom", "concurrent-model")];
  provider.models[0]!.reasoning = false;
  provider.models[0]!.reasoningEnabled = false;
  provider.defaultModelId = "concurrent-model";
  settings.apiProviders = [provider];
  activateApiProviderModel(settings, provider, "concurrent-model");
  const requests: PiChatSubmitRequest[] = [];
  const runs = new Map<string, {
    request: PiChatSubmitRequest;
    result: ReturnType<typeof deferred<Readonly<PiProductRunRecord>>>;
    listener?: PiChatRuntimeEventListener;
    terminal?: "completed" | "cancelled";
  }>();
  const cancellations: string[] = [];
  const latestId = (sessionId: string) => [...runs].filter(([, run]) => run.request.conversationId === sessionId).at(-1)?.[0] ?? "";
  async function settle(runId: string, terminalState: "completed" | "cancelled") {
    const run = runs.get(runId)!;
    if (run.terminal) return;
    run.terminal = terminalState;
    const session = sessions.find((candidate) => candidate.id === run.request.conversationId)!;
    const identity = { productRunId: runId, conversationId: session.id, piSessionId: session.piSessionId! };
    if (run.listener) {
      await emit(run.listener, { ...runtimeEvent({ type: "agent_settled" }), ...identity });
      await emit(run.listener, {
        ...runtimeEvent({ type: "product_run_settled", terminalState, assistantEntryId: "entry-assistant" }), ...identity
      });
    }
    run.result.resolve({
      ...identity, userEntryId: "entry-user", assistantEntryId: "entry-assistant", toolCallIds: [],
      memoryMode: "normal", state: "product_run_settled", terminalState,
      activeLeafId: "entry-assistant", agentSettledAt: 7, settledAt: 9, createdAt: 2, updatedAt: 9
    });
  }
  const plugin: any = {
    settings,
    getVaultPath: () => "/vault",
    getKnowledgeSurfaceService: () => null,
    persistPiNativeSettings: async () => undefined,
    submitPiChat: async (request: PiChatSubmitRequest) => {
      const productRunId = `${request.conversationId}-${requests.length + 1}`;
      requests.push(request);
      const result = deferred<Readonly<PiProductRunRecord>>();
      runs.set(productRunId, { request, result });
      return { productRunId, conversationId: request.conversationId,
        piSessionId: `pi-${request.conversationId}`, userEntryId: "entry-user", result: result.promise };
    },
    subscribePiRun: (id: string, listener: PiChatRuntimeEventListener) => {
      runs.get(id)!.listener = listener;
      return { unsubscribe: () => { runs.get(id)!.listener = undefined; } };
    },
    subscribePiAgentApproval: () => ({ unsubscribe() {} }),
    isPiProductionRun: (id: string) => runs.has(id),
    cancelHarnessRun: async (id: string) => { cancellations.push(id); await settle(id, "cancelled"); },
    abortPiConversation: async (id: string) => {
      cancellations.push(latestId(id));
      await settle(latestId(id), "cancelled");
    },
    releasePiProductionRun: () => undefined,
    releasePiConversationIfInactive: async () => undefined,
    releasePiConversation: async () => undefined,
    readPiConversationProjection: async (id: string) => {
      const session = sessions.find((candidate) => candidate.id === id)!;
      const runId = latestId(id);
      const projection = durableProjection(session, "completed");
      projection.messages = projection.messages.map((message) => ({
        ...message, runId, turnId: runId,
        text: message.role === "user" ? runs.get(runId)!.request.text : `answer-${id}`
      }));
      return projection;
    }
  };
  const view: any = new CodexView({} as any, plugin);
  view.inputEl = { value: "A1" };
  view.promptEnhanceReviewEl = new FakeElement("div");
  const firstPreparation = deferred<boolean>();
  view.ensureChatWorkspaceSelected = async (session: StoredSession) => session.id === "A" && !requests.some((request) => request.conversationId === "A")
    ? await firstPreparation.promise : true;
  view.currentTurnOptions = () => ({
    providerSettingsId: provider.id, runtimeProviderId: provider.runtimeProviderId,
    model: "concurrent-model", reasoning: "none", permission: "read-only", mode: "agent", mcpEnabled: false
  });
  for (const method of ["renderTabs", "renderToolbar", "renderMessages", "renderMessagesIfActive", "renderQueue", "renderInteractionDock", "renderTaskPlanDock", "applyStatus", "clearKnowledgeBaseRunProgressTimer", "flushSessionSave", "clearHomeAttentionFrame"]) {
    view[method] = () => undefined;
  }
  view.clearComposerDraft = () => { view.inputEl.value = ""; };
  try {
    const firstA = view.sendMessage();
    await view.sendMessage(); // Keyboard submission.
    await view.enqueueComposerDraft(); // The busy Composer button uses the enqueue callback.
    settings.activeSessionId = "B";
    view.inputEl.value = "B1";
    const firstB = view.sendMessage();
    await waitFor(() => Boolean(runs.get(latestId("B"))?.listener)).catch(() => {
      assert.fail(`B did not start: ${openTestNoticeMessages.at(-1)}`);
    });
    assert.deepEqual(requests.map((request) => request.text), ["B1"], "B starts while A is still preparing");
    firstPreparation.resolve(true);
    await waitFor(() => requests.length === 2 && Boolean(runs.get(latestId("A"))?.listener));
    assert.deepEqual(requests.map((request) => request.text), ["B1", "A1"]);
    assert.deepEqual([...view.runningSessionIds].sort(), ["A", "B"]);
    assert.notEqual(view.conversationRuns.get("A").turnWatchdog, view.conversationRuns.get("B").turnWatchdog);
    const bRunId = latestId("B");
    const bWatchdog = view.conversationRuns.get("B").turnWatchdog;
    for (const text of ["A2", "A3"]) {
      view.turnQueue.enqueue({ id: text, sessionId: "A", text, attachments: [], skill: null,
        turnOptions: view.currentTurnOptions(), kind: "chat", createdAt: 2 });
    }
    await view.startNextQueuedTurn("A");
    assert.equal(requests.length, 2, "A's queue cannot start while A1 is running");
    await settle(latestId("A"), "completed");
    await waitFor(() => requests.length === 3 && Boolean(runs.get(latestId("A"))?.listener));
    assert.equal(requests[2]!.text, "A2");
    assert.equal(view.activeRunId, bRunId, "A settlement cannot overwrite B's foreground run");
    assert.equal(view.conversationRuns.get("B").turnWatchdog, bWatchdog);
    await settle(latestId("A"), "completed");
    await waitFor(() => requests.length === 4 && Boolean(runs.get(latestId("A"))?.listener));
    assert.equal(requests[3]!.text, "A3");
    const aWatchdog = view.conversationRuns.get("A").turnWatchdog;
    const timeout = timers.get(aWatchdog)!;
    timers.delete(aWatchdog);
    timeout();
    await firstA;
    assert.deepEqual(cancellations, [latestId("A")], "A's timeout must cancel only A");
    assert.equal(view.activeRunId, bRunId);
    assert.ok(timers.has(bWatchdog));
    assert.equal(sessions[0]!.messages.at(-1)?.text, "answer-A");
    assert.ok(sessions[1]!.messages.every((message) => message.text !== "answer-A"));
    settings.activeSessionId = "C";
    view.inputEl.value = "C1";
    const firstC = view.sendMessage();
    await waitFor(() => requests.length === 5 && Boolean(runs.get(latestId("C"))?.listener));
    assert.deepEqual([...view.runningSessionIds].sort(), ["B", "C"]);
    settings.activeSessionId = "B";
    await view.stopTurn();
    await firstB;
    assert.ok(view.runningSessionIds.has("C"), "stopping B leaves C running");
    settings.activeSessionId = "B";
    view.inputEl.value = "B2";
    const secondB = view.sendMessage();
    await waitFor(() => requests.length === 6 && Boolean(runs.get(latestId("B"))?.listener));
    view.turnQueue.enqueue({ id: "C2", sessionId: "C", text: "C2", attachments: [], skill: null,
      turnOptions: view.currentTurnOptions(), kind: "chat", createdAt: 3 });
    await view.onClose();
    await Promise.all([firstC, secondB]);
    assert.deepEqual([...view.runningSessionIds], []);
    assert.equal(requests.length, 6, "closing the View must not start C's remaining queue");
    assert.equal(timers.size, 0);
    assert.deepEqual(new Set(cancellations.slice(-2)), new Set([latestId("C"), latestId("B")]));

    // A closing View must also cancel a request whose Pi acceptance arrives late.
    view.viewLifecycleAbortController = new AbortController();
    const accepted = deferred<void>();
    const submit = plugin.submitPiChat;
    plugin.submitPiChat = async (request: PiChatSubmitRequest) => {
      const handle = await submit(request);
      await accepted.promise;
      return handle;
    };
    settings.activeSessionId = "C";
    view.turnQueue.clearSessionQueue("C");
    view.turnQueue.enqueue({ id: "late-C", sessionId: "C", text: "late-C", attachments: [], skill: null,
      turnOptions: view.currentTurnOptions(), kind: "chat", createdAt: 4 });
    const lateC = view.startNextQueuedTurn("C");
    await waitFor(() => requests.length === 7).catch(() => {
      assert.fail(`Late submit did not start: ${openTestNoticeMessages.at(-1)}; run=${view.conversationRuns.get("C")?.running}; starting=${view.conversationRuns.get("C")?.queueStartInProgress}; aborted=${view.conversationRuns.get("C")?.controller.signal.aborted}`);
    });
    await view.onClose();
    accepted.resolve();
    await lateC;
    assert.equal(runs.get(latestId("C"))?.terminal, "cancelled");
    assert.equal(view.turnQueue.hasQueuedItems("C"), false,
      "an accepted then cancelled request must not remain queued for duplicate submission");
    assert.equal(timers.size, 0);

    // Exercise the actual View stop path while submit still has no run handle.
    view.viewLifecycleAbortController = new AbortController();
    const preparing = deferred<void>();
    let pendingSignal: AbortSignal | undefined;
    plugin.submitPiChat = async (request: PiChatSubmitRequest) => {
      pendingSignal = request.signal;
      assert.ok(pendingSignal);
      preparing.resolve();
      await new Promise((_resolve, reject) => pendingSignal!.addEventListener("abort", () => reject(Object.assign(new Error("cancelled preparation"), { name: "AbortError" })), { once: true }));
      assert.fail("cancelled preparation returned a handle");
    };
    settings.activeSessionId = "C";
    view.inputEl.value = "pending preflight draft";
    const noticesBeforeStop = openTestNoticeMessages.length;
    const pending = view.sendMessage();
    await preparing.promise;
    assert.equal(view.activeRunId, "");
    settings.activeSessionId = "B";
    await view.stopTurn();
    assert.equal(pendingSignal?.aborted, false, "stopping another conversation cannot abort C's pending submit");
    settings.activeSessionId = "C";
    await view.stopTurn();
    assert.equal(pendingSignal?.aborted, true, "stop reaches the submit signal before activeRunId exists");
    await pending;
    assert.equal(openTestNoticeMessages.length, noticesBeforeStop, "user cancellation is not reported as a send failure");
    assert.equal(view.inputEl.value, "pending preflight draft", "unaccepted cancelled drafts keep ordinary Composer semantics");
    assert.equal(view.runningSessionIds.has("C"), false);
  } finally {
    dom.restore();
  }
}

async function queuedNativeDocumentCapabilityLossUsesFrozenTextOnly(): Promise<void> {
  const session = piSessionShell("conversation-document-capability-loss");
  const settings = structuredClone(DEFAULT_SETTINGS);
  const provider = createApiProviderConfig("custom", "document-fallback-provider");
  provider.baseUrl = "https://document-fallback.example/v1";
  provider.apiKey = "fixture-document-fallback-key";
  provider.models = [createApiProviderModelConfig("custom", "fallback-model")];
  provider.defaultModelId = "fallback-model";
  settings.apiProviders = [provider];
  settings.sessions = [session];
  settings.activeSessionId = session.id;

  const attachment = {
    type: "file" as const,
    name: "frozen.pdf",
    path: "/missing/must-not-be-reread/frozen.pdf",
    mimeType: "application/pdf"
  };
  const preparedDocument = Object.freeze({
    attachment: Object.freeze({
      ...attachment,
      sizeBytes: 3,
      availability: "available" as const
    }),
    kind: "pdf" as const,
    bytes: new Uint8Array([1, 2, 3]),
    sha256: "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81",
    transport: "native" as const,
    text: "FROZEN_EXTRACTED_TEXT"
  });
  const item: QueuedTurnItem = {
    id: "queued-document-capability-loss",
    sessionId: session.id,
    text: "read the frozen document",
    attachments: [attachment],
    preparedDocuments: [preparedDocument],
    skill: null,
    turnOptions: {
      providerSettingsId: provider.id,
      runtimeProviderId: provider.runtimeProviderId,
      model: "fallback-model",
      reasoning: "none",
      permission: "read-only",
      mode: "agent",
      mcpEnabled: false
    },
    kind: "chat",
    createdAt: 2
  };

  let submitted: PiChatSubmitRequest | null = null;
  let submitCalls = 0;
  openTestNoticeMessages.length = 0;
  const view = documentRequestCaptureView({
    settings,
    onSubmit: async (request) => {
      submitCalls += 1;
      submitted = request;
      throw new Error("stop after document request capture");
    }
  });

  assert.equal(await startChatTurn(view, session, item, "queue"), "failed");
  assert.equal(
    submitCalls,
    1,
    openTestNoticeMessages.at(-1)
      ?? "frozen fallback text must still reach Pi submit"
  );
  assert.equal(submitted?.documents?.[0]?.transport, "extracted_text");
  assert.equal(submitted?.documents?.[0]?.text, "FROZEN_EXTRACTED_TEXT");
  assert.deepEqual(submitted?.documents?.[0]?.bytes, new Uint8Array([1, 2, 3]));
  assert.equal(
    item.preparedDocuments?.[0]?.transport,
    "native",
    "runtime reconciliation must not mutate the queued snapshot"
  );

  submitted = null;
  submitCalls = 0;
  openTestNoticeMessages.length = 0;
  const textlessItem: QueuedTurnItem = {
    ...item,
    id: "queued-textless-document-capability-loss",
    preparedDocuments: [Object.freeze({
      ...preparedDocument,
      text: undefined
    })]
  };
  assert.equal(
    await startChatTurn(view, session, textlessItem, "queue"),
    "failed"
  );
  assert.equal(submitCalls, 0, "textless fallback must fail before Pi submit");
  assert.equal(submitted, null);
  assert.match(
    openTestNoticeMessages.at(-1) ?? "",
    /冻结快照没有可提取文字/u
  );
}

async function queuedTurnsKeepExactProviderModelAndRetainUnavailableHead(): Promise<void> {
  const settings = structuredClone(DEFAULT_SETTINGS);
  const first = createApiProviderConfig("custom", "queue-provider-first");
  first.name = "Queue First";
  first.baseUrl = "https://queue-first.example/v1";
  first.apiKey = "fixture-first-key";
  first.models = [createApiProviderModelConfig("custom", "model-a")];
  first.models[0]!.reasoning = false;
  first.models[0]!.reasoningEnabled = false;
  first.defaultModelId = "model-a";
  const second = createApiProviderConfig("custom", "queue-provider-second");
  second.name = "Queue Second";
  second.baseUrl = "https://queue-second.example/v1";
  second.apiKey = "fixture-second-key";
  second.models = [createApiProviderModelConfig("custom", "model-b")];
  second.models[0]!.reasoning = false;
  second.models[0]!.reasoningEnabled = false;
  second.defaultModelId = "model-b";
  settings.apiProviders = [first, second];
  settings.providerMode = "custom-api";
  settings.activeApiProviderId = first.id;
  settings.defaultModel = "model-a";
  const session: StoredSession = {
    id: "queue-exact-combinations",
    title: "Queue exact combinations",
    kind: "chat",
    piSessionId: "pi-queue-exact-combinations",
    bodyAuthority: "pi_session_only",
    cwd: "/vault",
    messages: [],
    createdAt: 1,
    updatedAt: 1
  };
  const queue = new RuntimeTurnQueue();
  const queued = (
    id: string,
    providerSettingsId: string,
    model: string
  ): QueuedTurnItem => ({
    id,
    sessionId: session.id,
    text: id,
    attachments: [],
    skill: null,
    turnOptions: {
      providerSettingsId,
      runtimeProviderId: providerSettingsId === first.id
        ? first.runtimeProviderId
        : second.runtimeProviderId,
      model,
      reasoning: "none",
      permission: "workspace-write",
      mode: "agent",
      mcpEnabled: false
    },
    kind: "chat",
    createdAt: 1
  });

  openTestNoticeMessages.length = 0;
  const invalidComposerItem = await createQueuedTurnFromComposer({
    plugin: { settings },
    inputEl: { value: "invalid reasoning" },
    attachments: [],
    selectedSkill: null,
    ensureSession: () => ({ ...session, bodyAuthority: undefined }),
    ensureChatWorkspaceSelected: async () => true,
    currentTurnOptions: () => ({
      providerSettingsId: first.id,
      runtimeProviderId: first.runtimeProviderId,
      model: "model-a",
      reasoning: "high",
      permission: "workspace-write",
      mode: "agent",
      mcpEnabled: false
    })
  } as any, { allowLocalKnowledgeCommands: false });
  assert.equal(invalidComposerItem, null);
  assert.match(openTestNoticeMessages.at(-1) ?? "", /本轮没有入队/u);

  queue.enqueue(queued("turn-a", first.id, "model-a"));
  queue.enqueue(queued("turn-b", second.id, "model-b"));
  const activations: string[] = [];
  const sends: string[] = [];
  let failBeforePiAcceptance = false;
  const view: any = {
    plugin: {
      settings,
      activateApiProviderSettings: async (
        applyCandidate: (candidate: typeof settings) => void
      ) => {
        applyCandidate(settings);
        activations.push(`${settings.activeApiProviderId}:${settings.defaultModel}`);
      }
    },
    turnQueue: queue,
    queueStartInProgress: false,
    running: false,
    runningSessionIds: new Set<string>(),
    selectedProviderSettingsId: first.id,
    selectedModel: "model-a",
    renderQueue: () => undefined,
    renderToolbar: () => undefined,
    sessionById: (sessionId: string) => sessionId === session.id ? session : null,
    startChatTurn: async (_session: StoredSession, item: QueuedTurnItem) => {
      if (failBeforePiAcceptance) return "failed" as const;
      sends.push(`${item.turnOptions.providerSettingsId}:${item.turnOptions.model}`);
      queue.acceptPiUserEntry(item.sessionId, item.id);
      return "completed" as const;
    },
    afterTurnSettled: async (sessionId: string, succeeded: boolean) => {
      queue.settleSessionQueue(sessionId, succeeded);
    }
  };

  await startNextQueuedTurn(view, session.id);
  await startNextQueuedTurn(view, session.id);
  assert.deepEqual(sends, [
    `${first.id}:model-a`,
    `${second.id}:model-b`
  ]);
  assert.deepEqual(activations, [], "queued requests must not switch global Provider defaults");
  assert.equal(queue.hasQueuedItems(session.id), false);

  queue.enqueue(queued("turn-retained", first.id, "model-a"));
  first.apiKey = "";
  await startNextQueuedTurn(view, session.id);
  assert.equal(queue.isSessionQueuePaused(session.id), true);
  assert.deepEqual(
    queue.itemsForSession(session.id).map((item) => item.id),
    ["turn-retained"]
  );
  assert.equal(sends.length, 2, "an unavailable selection must not send or fall back");
  assert.equal(settings.activeApiProviderId, first.id);
  assert.equal(settings.defaultModel, "model-a");

  first.apiKey = "fixture-first-key";
  queue.resumeSessionQueue(session.id);
  await startNextQueuedTurn(view, session.id);
  assert.deepEqual(sends, [
    `${first.id}:model-a`,
    `${second.id}:model-b`,
    `${first.id}:model-a`
  ]);
  assert.equal(queue.hasQueuedItems(session.id), false);

  queue.enqueue(queued("turn-pre-accept-failure", second.id, "model-b"));
  failBeforePiAcceptance = true;
  await startNextQueuedTurn(view, session.id);
  assert.equal(queue.isSessionQueuePaused(session.id), true);
  assert.deepEqual(
    queue.itemsForSession(session.id).map((item) => item.id),
    ["turn-pre-accept-failure"]
  );
  assert.equal(sends.length, 3, "a pre-accept failure must retain one unsent Prompt");

  failBeforePiAcceptance = false;
  queue.resumeSessionQueue(session.id);
  await startNextQueuedTurn(view, session.id);
  assert.deepEqual(sends, [
    `${first.id}:model-a`,
    `${second.id}:model-b`,
    `${first.id}:model-a`,
    `${second.id}:model-b`
  ]);
  assert.equal(queue.hasQueuedItems(session.id), false);

  const frozenSource = queued("turn-frozen", first.id, "model-a");
  queue.enqueue(frozenSource);
  frozenSource.turnOptions.runtimeProviderId = "mutated-runtime";
  frozenSource.turnOptions.model = "mutated-model";
  frozenSource.turnOptions.reasoning = "high";
  assert.deepEqual(
    queue.itemsForSession(session.id).map((item) => ({
      runtimeProviderId: item.turnOptions.runtimeProviderId,
      model: item.turnOptions.model,
      reasoning: item.turnOptions.reasoning
    })),
    [{
      runtimeProviderId: first.runtimeProviderId,
      model: "model-a",
      reasoning: "none"
    }]
  );
  await startNextQueuedTurn(view, session.id);
  assert.equal(queue.hasQueuedItems(session.id), false);

  const frozenRuntimeProviderId = first.runtimeProviderId;
  queue.enqueue(queued("turn-runtime-drift", first.id, "model-a"));
  first.runtimeProviderId = "changed-runtime";
  openTestNoticeMessages.length = 0;
  await startNextQueuedTurn(view, session.id);
  assert.equal(queue.isSessionQueuePaused(session.id), true);
  assert.deepEqual(
    queue.itemsForSession(session.id).map((item) => item.id),
    ["turn-runtime-drift"]
  );
  assert.match(
    openTestNoticeMessages.at(-1) ?? "",
    /队首已保留并暂停/u
  );
  first.runtimeProviderId = frozenRuntimeProviderId;
  queue.resumeSessionQueue(session.id);
  await startNextQueuedTurn(view, session.id);
  assert.equal(queue.hasQueuedItems(session.id), false);

  const invalidReasoning = queued(
    "turn-reasoning-invalid",
    second.id,
    "model-b"
  );
  invalidReasoning.turnOptions.reasoning = "high";
  queue.enqueue(invalidReasoning);
  openTestNoticeMessages.length = 0;
  await startNextQueuedTurn(view, session.id);
  assert.equal(queue.isSessionQueuePaused(session.id), true);
  assert.deepEqual(
    queue.itemsForSession(session.id).map((item) => ({
      id: item.id,
      reasoning: item.turnOptions.reasoning
    })),
    [{ id: "turn-reasoning-invalid", reasoning: "high" }]
  );
  assert.match(
    openTestNoticeMessages.at(-1) ?? "",
    /思考强度.*队首已保留并暂停/u
  );
  assert.equal(sends.length, 6, "invalid queue snapshots never reach Pi");
  queue.clearSessionQueue(session.id);
  console.log("PASS conversation-ui: Queue preserves exact combinations without changing global defaults");
}

function localAttachmentClassificationUsesMimeOrExtension(): void {
  assert.equal(
    classifyLocalAttachmentType("/fixture/camera-upload", "image/heif"),
    "image"
  );
  assert.equal(
    classifyLocalAttachmentType("/fixture/camera.HEIF", "application/octet-stream"),
    "image"
  );
  assert.equal(
    classifyLocalAttachmentType("/fixture/photo.png", "text/plain"),
    "image",
    "a known image extension remains sufficient when the host MIME is stale"
  );
  assert.equal(
    classifyLocalAttachmentType("/fixture/note.md", "text/markdown"),
    "file"
  );
  assert.equal(
    classifyLocalAttachmentType("/fixture/archive.bin", "application/octet-stream"),
    "file"
  );
}

function imageMetadataProjectsAndCopiesByPiEntryIdentity(): void {
  const entryId = "user-image-metadata";
  const source: StoredSession = {
    id: "conversation-image-metadata",
    title: "Image metadata",
    kind: "chat",
    piSessionId: "pi-image-metadata",
    bodyAuthority: "pi_session_only",
    cwd: "/vault",
    messages: [],
    piImageAttachments: {
      [entryId]: [
        {
          name: "clipboard-1720000000000-0.png",
          path: "/missing/ordered-one.png",
          mimeType: "image/png"
        },
        {
          name: "原图二.jpg",
          path: "/missing/ordered-two.jpg",
          mimeType: "image/jpeg"
        }
      ]
    },
    piDocumentReplay: {
      [entryId]: [{
        name: "恢复文档.md",
        mimeType: "text/markdown",
        sizeBytes: 512,
        kind: "markdown",
        sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        text: "FROZEN_REPLAY_TEXT"
      }, {
        name: "恢复文档.md",
        mimeType: "text/markdown",
        sizeBytes: 512,
        kind: "markdown",
        sha256: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
        text: "SECOND_FROZEN_REPLAY_TEXT"
      }, {
        name: "扫描件.pdf",
        mimeType: "application/pdf",
        sizeBytes: 1024,
        kind: "pdf",
        sha256: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        text: null
      }]
    },
    createdAt: 1,
    updatedAt: 1
  };
  const fallbackMessage: ChatMessage = {
    id: `pi:pi-image-metadata:leaf:leaf:entry:${entryId}`,
    role: "user",
    itemType: "user",
    text: "",
    images: [{
      type: "image",
      name: "图片 1",
      path: "",
      mimeType: "image/png",
      availability: "unavailable"
    }, {
      type: "image",
      name: "图片 2",
      path: "",
      mimeType: "image/jpeg",
      availability: "unavailable"
    }],
    createdAt: 2
  };
  source.messages = [{
    ...fallbackMessage,
    attachments: [{
      type: "file",
      name: "恢复文档.md",
      path: "/missing/retry-document.md",
      mimeType: "text/markdown",
      sizeBytes: 512,
      availability: "available"
    }, {
      type: "file",
      name: "恢复文档.md",
      path: "/missing/second-same-name-document.md",
      mimeType: "text/markdown",
      sizeBytes: 512,
      availability: "available"
    }, {
      type: "file",
      name: "扫描件.pdf",
      path: "/still-present-but-changed/scan.pdf",
      mimeType: "application/pdf",
      sizeBytes: 1024,
      availability: "available"
    }]
  }];

  const projected = projectPiImageAttachments(source, source.messages);
  assert.equal(projected.length, 1, "missing local files must not drop the user message");
  assert.deepEqual(projected[0]?.images, [{
    type: "image",
    name: "粘贴图片 1.png",
    path: "/missing/ordered-one.png",
    mimeType: "image/png",
    availability: "unavailable"
  }, {
    type: "image",
    name: "原图二.jpg",
    path: "/missing/ordered-two.jpg",
    mimeType: "image/jpeg",
    availability: "unavailable"
  }]);

  const derived: StoredSession = {
    id: "conversation-image-derived",
    title: "Derived",
    kind: "chat",
    piSessionId: "pi-image-derived",
    bodyAuthority: "pi_session_only",
    cwd: "/vault",
    messages: [],
    createdAt: 3,
    updatedAt: 3
  };
  copyPiImageAttachmentsForProjection(source, derived, projected);
  assert.deepEqual(derived.piImageAttachments, source.piImageAttachments);
  assert.deepEqual(derived.piDocumentReplay, source.piDocumentReplay);
  assert.deepEqual(piComposerImageAttachmentsForEntry(source, entryId), [
    {
      type: "image",
      name: "粘贴图片 1.png",
      path: "/missing/ordered-one.png",
      mimeType: "image/png",
      availability: "unavailable"
    },
    {
      type: "image",
      name: "原图二.jpg",
      path: "/missing/ordered-two.jpg",
      mimeType: "image/jpeg",
      availability: "unavailable"
    },
    {
      type: "file",
      name: "恢复文档.md",
      path: "/missing/retry-document.md",
      mimeType: "text/markdown",
      sizeBytes: 512,
      availability: "unavailable",
      documentReplay: {
        name: "恢复文档.md",
        mimeType: "text/markdown",
        sizeBytes: 512,
        kind: "markdown",
        sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        text: "FROZEN_REPLAY_TEXT"
      }
    },
    {
      type: "file",
      name: "恢复文档.md",
      path: "/missing/second-same-name-document.md",
      mimeType: "text/markdown",
      sizeBytes: 512,
      availability: "unavailable",
      documentReplay: {
        name: "恢复文档.md",
        mimeType: "text/markdown",
        sizeBytes: 512,
        kind: "markdown",
        sha256: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
        text: "SECOND_FROZEN_REPLAY_TEXT"
      }
    },
    {
      type: "file",
      name: "扫描件.pdf",
      path: "/still-present-but-changed/scan.pdf",
      mimeType: "application/pdf",
      sizeBytes: 1024,
      availability: "unavailable",
      documentReplay: {
        name: "扫描件.pdf",
        mimeType: "application/pdf",
        sizeBytes: 1024,
        kind: "pdf",
        sha256: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        text: null
      }
    }
  ]);
}

async function activeRunImagesUseTheNormalQueue(): Promise<void> {
  const session = piSessionShell("conversation-active-image-queue");
  const queue = new RuntimeTurnQueue();
  const item = queuedImageTurn(session.id, "/fixture/queued-image.png");
  let followUpCalls = 0;
  let composerClearCalls = 0;
  const view: any = {
    plugin: {
      followUpPiConversation: async () => { followUpCalls += 1; }
    },
    running: true,
    activeRunKind: "chat",
    activeRunSessionId: session.id,
    turnQueue: queue,
    createQueuedTurnFromComposer: async () => item,
    sessionById: () => session,
    clearComposerDraft: () => { composerClearCalls += 1; },
    renderQueue: () => undefined,
    renderToolbar: () => undefined
  };

  await enqueueComposerDraft(view);

  assert.equal(followUpCalls, 0, "image turns must not use text-only follow-up");
  assert.equal(queue.itemsForSession(session.id).length, 1);
  assert.deepEqual(queue.itemsForSession(session.id)[0]?.attachments, item.attachments);
  assert.equal(queue.itemsForSession(session.id)[0]?.piUserEntryAccepted, undefined);
  assert.equal(
    queue.itemsForSession(session.id)[0]?.clearComposerAfterPiAcceptance,
    true
  );
  assert.equal(
    composerClearCalls,
    0,
    "Pi must durably accept the queued image turn before Composer clears"
  );

  await enqueueComposerDraft(view);
  assert.equal(
    queue.itemsForSession(session.id).length,
    1,
    "an unchanged Composer snapshot must not be duplicated while waiting"
  );
  assert.equal(followUpCalls, 0);
}

async function activeRunNoteMentionsUseTheNormalQueue(): Promise<void> {
  const session = piSessionShell("conversation-active-note-queue");
  const queue = new RuntimeTurnQueue();
  const item: QueuedTurnItem = {
    ...queuedImageTurn(session.id, "/fixture/unused.png"),
    id: "queued-note-mention",
    text: "总结提及笔记",
    attachments: [],
    noteMentions: [{
      vaultRelativePath: "projects/项目复盘.md",
      fileName: "项目复盘.md",
      content: "# 已冻结正文"
    }]
  };
  let followUpCalls = 0;
  const view: any = {
    plugin: {
      followUpPiConversation: async () => { followUpCalls += 1; }
    },
    running: true,
    activeRunKind: "chat",
    activeRunSessionId: session.id,
    turnQueue: queue,
    createQueuedTurnFromComposer: async () => item,
    sessionById: () => session,
    clearComposerDraft: () => undefined,
    renderQueue: () => undefined,
    renderToolbar: () => undefined
  };

  await enqueueComposerDraft(view);
  assert.equal(followUpCalls, 0, "note mentions must not use text-only follow-up");
  assert.equal(queue.itemsForSession(session.id).length, 1);
  assert.deepEqual(queue.peekNext(session.id)?.noteMentions, item.noteMentions);
  assert.equal(queue.peekNext(session.id)?.clearComposerAfterPiAcceptance, true);

  await enqueueComposerDraft(view);
  assert.equal(queue.itemsForSession(session.id).length, 1,
    "the same frozen note mention draft is not queued twice");
}

async function queuedImageFailuresAreRetainedOnlyBeforePiAcceptance():
Promise<void> {
  const runScenario = async (accepted: boolean) => {
    const sessionId = accepted
      ? "conversation-accepted-image-failure"
      : "conversation-pre-accept-image-failure";
    const session = piSessionShell(sessionId);
    const queue = new RuntimeTurnQueue();
    queue.enqueue(queuedImageTurn(sessionId, `/fixture/${sessionId}.png`));
    const view: any = {
      plugin: { settings: createQueueImageProviderSettings() },
      turnQueue: queue,
      queueStartInProgress: false,
      running: false,
    runningSessionIds: new Set<string>(),
      renderQueue: () => undefined,
      renderToolbar: () => undefined,
      sessionById: () => session,
      startChatTurn: async (_session: StoredSession, turn: QueuedTurnItem) => {
        if (accepted) {
          turn.piUserEntryAccepted = true;
          queue.acceptPiUserEntry(sessionId, turn.id);
        }
        return "failed" as const;
      },
      afterTurnSettled: async (id: string, succeeded: boolean) => {
        queue.settleSessionQueue(id, succeeded);
      }
    };
    await startNextQueuedTurn(view, sessionId);
    return { queue, sessionId };
  };

  const beforeAcceptance = await runScenario(false);
  assert.equal(beforeAcceptance.queue.itemsForSession(beforeAcceptance.sessionId).length, 1);
  assert.equal(
    beforeAcceptance.queue.isSessionQueuePaused(beforeAcceptance.sessionId),
    true,
    "a pre-acceptance failure must return the exact turn to the front and pause"
  );

  const afterAcceptance = await runScenario(true);
  assert.deepEqual(afterAcceptance.queue.itemsForSession(afterAcceptance.sessionId), []);
  assert.equal(
    afterAcceptance.queue.isSessionQueuePaused(afterAcceptance.sessionId),
    false,
    "a durable Pi user Entry must never be duplicated back into the queue"
  );
}

async function inFlightComposerImageTransferCannotDuplicate(): Promise<void> {
  const session = piSessionShell("conversation-in-flight-image-transfer");
  const queue = new RuntimeTurnQueue();
  const queued = queuedImageTurn(session.id, "/fixture/in-flight.png");
  queued.clearComposerAfterPiAcceptance = true;
  queue.enqueue(queued);
  const startGate = deferred<"failed">();
  let running = false;
  const view: any = {
    plugin: {
      settings: createQueueImageProviderSettings(),
      followUpPiConversation: async () => {
        throw new Error("image transfers must not use follow-up");
      }
    },
    turnQueue: queue,
    queueStartInProgress: false,
    get running() { return running; },
    set running(value: boolean) { running = value; },
    activeRunKind: "",
    activeRunSessionId: "",
    renderQueue: () => undefined,
    renderToolbar: () => undefined,
    sessionById: () => session,
    startChatTurn: async () => {
      running = true;
      view.activeRunKind = "chat";
      view.activeRunSessionId = session.id;
      return await startGate.promise;
    },
    afterTurnSettled: async (id: string, succeeded: boolean) => {
      queue.settleSessionQueue(id, succeeded);
    },
    createQueuedTurnFromComposer: async () =>
      queuedImageTurn(session.id, "/fixture/in-flight.png"),
    sessionById: () => session,
    clearComposerDraft: () => undefined
  };

  const flight = startNextQueuedTurn(view, session.id);
  await waitFor(() => view.queueStartInProgress === true && running);
  await enqueueComposerDraft(view);
  assert.equal(
    queue.itemsForSession(session.id).length,
    1,
    "the leased queue head must remain unique until Pi durably accepts it"
  );

  running = false;
  startGate.resolve("failed");
  await flight;
  assert.equal(queue.itemsForSession(session.id).length, 1);
  assert.equal(queue.isSessionQueuePaused(session.id), true);
}

async function imageCapabilityFailurePreservesComposerAndAcceptedFailureRecordsMetadata():
Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "echoink-turn-runner-image-"));
  try {
    const imagePath = path.join(root, "composer.png");
    await writeFile(imagePath, PNG_1X1);
    const unsupportedSession = piSessionShell("conversation-image-unsupported");
    const unsupportedItem = queuedImageTurn(unsupportedSession.id, imagePath);
    let unsupportedClearCalls = 0;
    let unsupportedSubmit: PiChatSubmitRequest | null = null;
    const unsupportedView = imageFailureView({
      session: unsupportedSession,
      onSubmit: async (request) => {
        unsupportedSubmit = request;
        throw new Error(PI_IMAGE_INPUT_UNSUPPORTED_MESSAGE);
      },
      onClearComposer: () => { unsupportedClearCalls += 1; }
    });

    assert.equal(
      await startChatTurn(
        unsupportedView,
        unsupportedSession,
        unsupportedItem,
        "composer"
      ),
      "failed"
    );
    assert.equal(unsupportedSubmit?.text, unsupportedItem.text);
    assert.equal(unsupportedSubmit?.images?.length, 1);
    assert.equal(unsupportedClearCalls, 0);
    assert.equal(unsupportedItem.piUserEntryAccepted, undefined);
    assert.equal(unsupportedSession.piImageAttachments, undefined);

    const acceptedSession = piSessionShell("conversation-image-accepted-failure");
    const acceptedItem = queuedImageTurn(acceptedSession.id, imagePath);
    acceptedItem.clearComposerAfterPiAcceptance = true;
    let acceptedClearCalls = 0;
    let persistenceCalls = 0;
    const acceptedError = Object.assign(
      new Error("Pi user Entry 已接受，但 ProductRun 持久化失败。"),
      {
        piUserEntryAccepted: true as const,
        piUserEntryId: "entry-image-accepted"
      }
    );
    const acceptedView = imageFailureView({
      session: acceptedSession,
      composerItem: acceptedItem,
      onSubmit: async () => { throw acceptedError; },
      onClearComposer: () => { acceptedClearCalls += 1; },
      onPersist: async () => { persistenceCalls += 1; }
    });

    assert.equal(
      await startChatTurn(
        acceptedView,
        acceptedSession,
        acceptedItem,
        "queue"
      ),
      "failed"
    );
    assert.equal(acceptedItem.piUserEntryAccepted, true);
    assert.equal(acceptedClearCalls, 1);
    assert.equal(persistenceCalls, 1);
    assert.deepEqual(
      acceptedSession.piImageAttachments?.["entry-image-accepted"],
      [{
        name: "composer.png",
        path: imagePath,
        mimeType: "image/png",
        availability: "available"
      }]
    );
    assert.doesNotMatch(
      JSON.stringify(acceptedSession.piImageAttachments),
      /iVBORw0KGgo/u
    );

    const switchedSession = piSessionShell("conversation-image-switch-target");
    const switchedItem = queuedImageTurn(acceptedSession.id, imagePath);
    switchedItem.clearComposerAfterPiAcceptance = true;
    let switchedClearCalls = 0;
    const switchedView = imageFailureView({
      session: acceptedSession,
      composerItem: switchedItem,
      onSubmit: async () => { throw acceptedError; },
      onClearComposer: () => { switchedClearCalls += 1; }
    });
    switchedView.plugin.settings.sessions.push(switchedSession);
    switchedView.plugin.settings.activeSessionId = switchedSession.id;

    assert.equal(
      await startChatTurn(
        switchedView,
        acceptedSession,
        switchedItem,
        "queue"
      ),
      "failed"
    );
    assert.equal(
      switchedClearCalls,
      0,
      "an accepted turn from session A must not clear an identical draft in active session B"
    );

    const editedSession = piSessionShell("conversation-image-edited-draft");
    const editedItem = queuedImageTurn(editedSession.id, imagePath);
    let editedClearCalls = 0;
    let editedView: any;
    editedView = imageFailureView({
      session: editedSession,
      composerItem: editedItem,
      onSubmit: async () => {
        editedView.inputEl.value = "这是用户等待期间输入的新草稿";
        throw acceptedError;
      },
      onClearComposer: () => { editedClearCalls += 1; }
    });

    assert.equal(
      await startChatTurn(
        editedView,
        editedSession,
        editedItem,
        "composer"
      ),
      "failed"
    );
    assert.equal(
      editedClearCalls,
      0,
      "direct Composer acceptance must not clear text edited while submit was pending"
    );
    assert.equal(
      editedView.inputEl.value,
      "这是用户等待期间输入的新草稿"
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function imageCapabilityPreflightPreservesCompletedTurn(): Promise<void> {
  const session = piSessionShell("conversation-image-capability-preflight");
  session.messages = [{
    id: "assistant-completed-before-image-preflight",
    role: "assistant",
    itemType: "assistant",
    text: "上一轮已经完成",
    status: "completed",
    runId: "product-run-completed",
    turnId: "product-run-completed",
    assistantTurn: {
      viewVersion: 1,
      conversationId: session.id,
      turnId: "product-run-completed",
      status: "completed",
      startedAt: 2,
      updatedAt: 5,
      completedAt: 5,
      processNodes: [],
      interactionRecords: [],
      finalAnswerMessageId: "assistant-completed-before-image-preflight",
      summary: {
        completedSteps: 3,
        toolCount: 2,
        durationMs: 24_000
      }
    },
    createdAt: 2,
    completedAt: 5
  }];
  const beforeMessages = structuredClone(session.messages);
  const item = queuedImageTurn(session.id, "/fixture/unsupported.png");
  const settings = createQueueImageProviderSettings(false);
  let startCalls = 0;
  let clearCalls = 0;
  const view: any = {
    plugin: { settings },
    selectedProviderSettingsId: item.turnOptions.providerSettingsId,
    selectedModel: item.turnOptions.model,
    inputEl: { value: item.text },
    attachments: item.attachments.map((attachment) => ({ ...attachment })),
    selectedSkill: null,
    renderToolbar: () => undefined,
    clearComposerDraft: () => { clearCalls += 1; },
    sessionById: (sessionId: string) => sessionId === session.id ? session : null,
    startChatTurn: async () => {
      startCalls += 1;
      return "completed" as const;
    }
  };

  assert.equal(await startQueuedTurnItem(view, item, "composer"), "failed");
  assert.equal(startCalls, 0, "unsupported images must not enter Pi submit");
  assert.equal(clearCalls, 0, "unsupported images must retain the Composer draft");
  assert.equal(view.inputEl.value, item.text);
  assert.deepEqual(view.attachments, item.attachments);
  assert.deepEqual(
    session.messages,
    beforeMessages,
    "capability preflight must not rewrite a completed Assistant Turn"
  );
}

function emptyPersonalMemorySourceDisplayDoesNotClaimInjection(): void {
  assert.equal(personalMemorySourceCountLabel(0), "Personal Memory 来源");
  assert.equal(
    personalMemorySourceEmptyStateLabel(),
    "未记录可展示的 Personal Memory 来源。"
  );
  assert.doesNotMatch(
    `${personalMemorySourceCountLabel(0)} ${personalMemorySourceEmptyStateLabel()}`,
    /(?:0 条|未注入)/u
  );
}

async function maintainScopeIsResolvedBeforeProviderSubmit(): Promise<void> {
  const session: StoredSession = {
    id: "conversation-maintain-scope",
    title: "Maintain scope",
    kind: "chat",
    piSessionId: "pi-maintain-scope",
    bodyAuthority: "pi_session_only",
    cwd: "/vault",
    messages: [],
    createdAt: 1,
    updatedAt: 1
  };
  const exactScope = Object.freeze({
    mode: "exact" as const,
    sourcePaths: Object.freeze(["raw/a.md"]) as readonly [string]
  });
  let preparedInput: Readonly<{
    request: string;
    attachmentPaths: readonly string[];
  }> | null = null;
  let submitted: PiChatSubmitRequest | null = null;
  const plugin = {
    settings: { memory: { useLongTermMemory: true } },
    prepareEchoInkKnowledgeMaintenanceScope: async (input: Readonly<{
      request: string;
      attachmentPaths: readonly string[];
    }>) => {
      preparedInput = input;
      if (input.attachmentPaths.length > 1) {
        throw new Error("/maintain 一次只支持一篇 Raw 笔记。");
      }
      return exactScope;
    },
    submitPiChat: async (request: PiChatSubmitRequest) => {
      submitted = request;
      throw new Error("stop after request capture");
    },
    readPiConversationProjection: async () => {
      throw new Error("no durable run in request-capture fixture");
    },
    abortPiConversation: async () => undefined,
    releasePiProductionRun: () => undefined,
    releasePiConversationIfInactive: async () => false
  };
  const view: any = {
    plugin,
    running: false,
    runningSessionIds: new Set<string>(),
    activeRunId: "",
    activeRunKind: "",
    activeRunSessionId: "",
    activeTurnId: "",
    turnStartedAt: 0,
    messagesBottomFollowPaused: false,
    renderTabs: () => undefined,
    renderMessages: () => undefined,
    renderMessagesIfActive: () => undefined,
    renderToolbar: () => undefined,
    applyStatus: () => undefined,
    clearComposerDraft: () => undefined,
    armTurnWatchdog: () => undefined,
    clearTurnWatchdog: () => undefined,
    clearActiveRun: () => undefined
  };
  const item = (attachments: QueuedTurnItem["attachments"]): QueuedTurnItem => ({
    id: "queued-maintain-scope",
    sessionId: session.id,
    text: "/maintain",
    attachments,
    skill: null,
    turnOptions: {
      providerSettingsId: "fixture-provider",
      runtimeProviderId: "fixture-provider",
      model: "",
      reasoning: "high",
      permission: "workspace-write",
      mode: "agent",
      mcpEnabled: false
    },
    kind: "chat",
    createdAt: 2
  });

  assert.equal(await startChatTurn(view, session, item([{
    type: "file",
    name: "a.md",
    path: "/vault/raw/a.md"
  }]), "composer"), "failed");
  assert.deepEqual(preparedInput, {
    request: "",
    attachmentPaths: ["/vault/raw/a.md"]
  });
  assert.deepEqual(submitted?.maintenanceScope, exactScope);

  submitted = null;
  assert.equal(await startChatTurn(view, session, item([{
    type: "file",
    name: "a.md",
    path: "/vault/raw/a.md"
  }, {
    type: "file",
    name: "b.md",
    path: "/vault/raw/b.md"
  }]), "composer"), "failed");
  assert.equal(submitted, null, "invalid maintain scope must stop before ProductRun");
}

function composerModelLabelsOnlyRemoveKnownBrandPrefixes(): void {
  assert.equal(compactBrandedModelLabel("DeepSeek-V4-Flash"), "V4-Flash");
  assert.equal(compactBrandedModelLabel("Kimi-K3"), "K3");
  assert.equal(compactBrandedModelLabel("qWeN-2.5-Coder"), "2.5-Coder");
  assert.equal(compactBrandedModelLabel("Qwen3-32B"), "3-32B");
  assert.equal(compactBrandedModelLabel("GPT-5.2-Codex"), "5.2-Codex");
  assert.equal(compactBrandedModelLabel("gPt4.1-mini"), "4.1-mini");
  assert.equal(compactBrandedModelLabel("Custom-GPT-Model"), "Custom-GPT-Model");
  assert.equal(compactBrandedModelLabel("gptastic-model"), "gptastic-model");
}

async function messageActionContractsStayTruthful(): Promise<void> {
  assert.equal(piConversationDeriveActionLabel({ role: "user" }), null);
  assert.equal(piConversationDeriveActionLabel({ role: "assistant" }), "从这条回复新建会话");

  let copiedText = "";
  const success = await copyAnswerMarkdown(
    { text: "用户消息原文" },
    async () => "unused",
    async (text) => { copiedText = text; }
  );
  assert.equal(success.status, "success");
  assert.equal(copiedText, "用户消息原文");

  const failure = await copyAnswerMarkdown(
    { text: "复制失败原文" },
    async () => "unused",
    async () => { throw new Error("clipboard unavailable"); }
  );
  assert.equal(failure.status, "failure");
}

async function assistantImageDerivationCopiesMetadataWithoutInventingResend():
Promise<void> {
  const userEntryId = "user-image-derive";
  const assistantEntryId = "assistant-image-derive";
  const source = piSessionShell("conversation-image-derive-source");
  source.piImageAttachments = {
    [userEntryId]: [{
      name: "derive.png",
      path: "/missing/derive.png",
      mimeType: "image/png"
    }]
  };
  const targetId = "conversation-image-derive-target";
  let saveCalls = 0;
  const inputEl = {
    value: "",
    focus: () => undefined,
    setSelectionRange: () => undefined
  };
  const plugin: any = {
    settings: {
      sessions: [source],
      activeSessionId: source.id
    },
    getVaultPath: () => "/vault",
    derivePiConversation: async (input: Readonly<{
      anchorEntryId: string;
    }>) => {
      assert.equal(
        input.anchorEntryId,
        assistantEntryId,
        "the product UI exposes derivation only from an assistant reply"
      );
      return {
        sourceConversationId: source.id,
        anchorEntryId: assistantEntryId,
        anchorRole: "assistant" as const,
        editorText: "",
        activation: { status: "activated" as const },
        projection: {
          catalog: {
            conversationId: targetId,
            piSessionId: "pi-image-derive-target",
            vaultId: "vault-turn-runner",
            title: "Derived image conversation",
            status: "active" as const,
            defaultMemoryMode: "normal" as const,
            defaultSkillId: "knowledge-review",
            createdAt: 3,
            updatedAt: 3,
            sessionFile: "/sessions/pi-image-derive-target.jsonl"
          },
          activeLeafId: assistantEntryId,
          messages: [{
            id: piProjectedEntryMessageId(
              "pi-image-derive-target",
              assistantEntryId,
              userEntryId
            ),
            role: "user" as const,
            itemType: "user" as const,
            text: "",
            images: [{
              type: "image" as const,
              name: "图片 1",
              path: "",
              mimeType: "image/png",
              availability: "unavailable" as const
            }],
            createdAt: 2
          }],
          diagnostics: [],
          drafts: []
        }
      };
    },
    saveSettings: async () => { saveCalls += 1; }
  };
  const host: any = {
    app: {},
    plugin,
    turnQueue: new RuntimeTurnQueue(),
    tabBarEl: {},
    running: false,
    runningSessionIds: new Set<string>(),
    activeRunSessionId: "",
    inputEl,
    attachments: [],
    selectedSkill: null,
    closeComposerMenus: () => undefined,
    resetVirtualWindow: () => undefined,
    renderTabs: () => undefined,
    renderMessages: () => undefined,
    renderToolbar: () => undefined,
    updateInputPlaceholder: () => undefined
  };

  await derivePiConversationFromMessage(host, source, assistantEntryId);

  assert.equal(plugin.settings.activeSessionId, targetId);
  assert.equal(inputEl.value, "");
  assert.deepEqual(
    host.attachments,
    [],
    "assistant derivation must not invent a user-message resend surface"
  );
  const derived = plugin.settings.sessions.find(
    (session: StoredSession) => session.id === targetId
  );
  assert.equal(derived?.defaultSkillId, "knowledge-review");
  assert.deepEqual(derived?.piImageAttachments, {
    [userEntryId]: [{
      name: "derive.png",
      path: "/missing/derive.png",
      mimeType: "image/png"
    }]
  });
  assert.deepEqual(derived?.messages[0]?.images, [{
    type: "image",
    name: "derive.png",
    path: "/missing/derive.png",
    mimeType: "image/png",
    availability: "unavailable"
  }]);
  assert.equal(saveCalls, 1);
}

function tableRowsKeepVaultNoteAliasesInsideOneCell(): void {
  assert.deepEqual(
    splitMessageTableRow("| 内链 | [[wiki/Long Note Name|长笔记]] 应保持完整 |"),
    ["内链", "[[wiki/Long Note Name|长笔记]] 应保持完整"]
  );
  assert.deepEqual(
    splitMessageTableRow("| 代码 | `left|right` 与 escaped\\|pipe |"),
    ["代码", "`left|right` 与 escaped|pipe"]
  );
}

function globalMemoryModeOverridesEverySubmit(): void {
  assert.equal(piChatMemoryModeForGlobalSetting(true), "normal");
  assert.equal(piChatMemoryModeForGlobalSetting(false), "no_memory");
  assert.equal(removeTrailingSlashQuery("/bet"), "");
  assert.equal(removeTrailingSlashQuery("保留前文 /bet"), "保留前文");
}

function asyncSkillMenuOnlyReturnsEnabledSkills(): void {
  const enabled = {
    id: "echoink-local:skill:enabled",
    kind: "skill" as const,
    source: "echoink-local" as const,
    name: "enabled",
    description: "Enabled fixture",
    enabled: true,
    bridgeMode: "prompt-only" as const,
    contentPath: "skills/enabled/SKILL.md"
  };
  const savedDisabled = {
    ...enabled,
    enabled: false
  };
  const rediscoveredEnabled = {
    ...enabled,
    name: "rediscovered enabled",
    contentPath: "skills/rediscovered/SKILL.md"
  };
  const falseWinsCatalog = buildActiveEchoInkResourceCatalog({
    settings: { catalog: [savedDisabled] },
    manual: [rediscoveredEnabled]
  });
  assert.equal(falseWinsCatalog[0]?.enabled, false);
  assert.deepEqual(enabledSkillsForComposerMenu(falseWinsCatalog), []);
  assert.deepEqual(
    enabledSkillsForComposerMenu([enabled]).map((skill) => skill.id),
    [enabled.id]
  );
}

async function disabledOrStaleSkillCannotStartTurn(): Promise<void> {
  const session: StoredSession = {
    id: "conversation-disabled-skill",
    title: "Conversation",
    kind: "chat",
    piSessionId: "pi-session-disabled-skill",
    bodyAuthority: "pi_session_only",
    defaultSkillId: "knowledge-review",
    cwd: "/vault",
    messages: [],
    createdAt: 1,
    updatedAt: 1
  };
  const selectedSkill = {
    id: "echoink-local:skill:knowledge-review",
    kind: "skill" as const,
    source: "echoink-local" as const,
    name: "stale knowledge review",
    description: "Stale selected value",
    enabled: true,
    bridgeMode: "prompt-only" as const,
    contentPath: "skills/stale/SKILL.md",
    metadata: { resourceId: "knowledge-review" }
  };
  const item: QueuedTurnItem = {
    id: "queued-disabled-skill",
    sessionId: session.id,
    text: "hello",
    attachments: [],
    skill: selectedSkill,
    turnOptions: {
      providerSettingsId: "fixture-provider",
      runtimeProviderId: "fixture-provider",
      model: "",
      reasoning: "high",
      permission: "read-only",
      mode: "agent",
      mcpEnabled: false
    },
    kind: "chat",
    createdAt: 2
  };
  let submitted: PiChatSubmitRequest | null = null;
  const runtimeSkill = {
    ...selectedSkill,
    name: "current knowledge review",
    contentPath: "skills/current/SKILL.md"
  };
  const disabledCatalog = buildActiveEchoInkResourceCatalog({
    settings: { catalog: [{ ...selectedSkill, enabled: false }] },
    manual: [runtimeSkill]
  });
  const removedCatalog = buildActiveEchoInkResourceCatalog({
    settings: { catalog: [selectedSkill] },
    manual: []
  });
  assert.equal(disabledCatalog[0]?.enabled, false);
  assert.deepEqual(removedCatalog, []);
  const view: any = {
    plugin: {
      buildRuntimeEchoInkResourceCatalog: async () => disabledCatalog,
      submitPiChat: async (request: PiChatSubmitRequest) => {
        submitted = request;
        throw new Error("submission should not complete in this fixture");
      }
    },
    running: false,
    runningSessionIds: new Set<string>(),
    activeRunId: "",
    activeRunKind: "",
    activeRunSessionId: "",
    activeTurnId: "",
    turnStartedAt: 0,
    messagesBottomFollowPaused: false,
    renderTabs: () => undefined,
    renderToolbar: () => undefined,
    applyStatus: () => undefined,
    clearComposerDraft: () => undefined
  };

  openTestNoticeMessages.length = 0;
  assert.equal(await startChatTurn(view, session, item, "composer"), "failed");
  assert.equal(submitted, null, "disabled Skill must fail before Provider submit");
  assert.equal(
    openTestNoticeMessages.some((message) => message.includes("会话默认 Skill")),
    true
  );

  openTestNoticeMessages.length = 0;
  view.plugin.buildRuntimeEchoInkResourceCatalog = async () => removedCatalog;
  assert.equal(await startChatTurn(view, session, item, "queue"), "failed");
  assert.equal(submitted, null, "removed Skill must fail before Provider submit");
  assert.equal(
    openTestNoticeMessages.some((message) => message.includes("会话默认 Skill")),
    true
  );

}

async function agentSettlementOnlyFinalizesPiChatTurn(): Promise<void> {
  const session: StoredSession = {
    id: "conversation-turn-runner",
    title: "Conversation",
    kind: "chat",
    piSessionId: "pi-session-turn-runner",
    bodyAuthority: "pi_session_only",
    defaultSkillId: "knowledge-review",
    cwd: "/vault",
    messages: [],
    createdAt: 1,
    updatedAt: 1
  };
  const item: QueuedTurnItem = {
    id: "queued-turn-runner",
    sessionId: session.id,
    text: "请总结提及笔记",
    attachments: [{
      type: "image",
      name: "memory-personality-v1.webp",
      path: path.resolve(
        process.cwd(),
        "src/knowledge-base/assets/guide/memory-personality-v1.webp"
      ),
      mimeType: "image/webp"
    }, {
      type: "file",
      name: "sample.md",
      path: path.resolve(
        process.cwd(),
        "src/tests/fixtures/document-attachments/sample.md"
      ),
      mimeType: "text/markdown"
    }],
    selectionAnnotations: [annotationFixture()],
    noteMentions: [{
      vaultRelativePath: "projects/项目复盘.md",
      fileName: "项目复盘.md",
      content: "PRIVATE_WHOLE_NOTE_BODY"
    }],
    skill: {
      id: "echoink-local:skill:review",
      kind: "skill",
      source: "echoink-local",
      name: "review",
      description: "Review the current work",
      enabled: true,
      bridgeMode: "prompt-only",
      contentPath: "skills/review/SKILL.md"
    },
    turnOptions: {
      providerSettingsId: "fixture-provider",
      runtimeProviderId: "fixture-provider",
      model: "fixture-model",
      reasoning: "high",
      permission: "read-only",
      mode: "agent",
      mcpEnabled: false
    },
    kind: "chat",
    createdAt: 2
  };
  const defaultSkill = {
    id: "echoink-local:skill:knowledge-review",
    kind: "skill" as const,
    source: "echoink-local" as const,
    name: "knowledge-review",
    description: "Persistent guided Knowledge review",
    enabled: true,
    bridgeMode: "prompt-only" as const,
    contentPath: "skills/knowledge-review/SKILL.md",
    metadata: { resourceId: "knowledge-review" }
  };
  item.preparedDocuments = (await preparePiChatDocuments(
    item.attachments.filter((attachment) => attachment.type === "file"),
    {
      availableInputTokens: 100_000,
      capabilityTarget: {
        providerId: "custom",
        apiProtocol: "openai-completions",
        baseUrl: "https://fixture.example/v1",
        modelId: "fixture-model",
        adapter: PI_ANTHROPIC_PDF_DOCUMENT_ADAPTER
      }
    }
  )).documents;
  const runResult = deferred<Readonly<PiProductRunRecord>>();
  let listener: PiChatRuntimeEventListener | null = null;
  let approvalListener: (() => void) | null = null;
  let approvalSubscriptionIdentity: Readonly<{
    conversationId: string;
    piSessionId: string;
    productRunId: string;
  }> | null = null;
  let approvalRefreshPending = false;
  let projectionReads = 0;
  let settlementProjectionReads = 0;
  let releasedRunId = "";
  let composerCleared = false;
  let submittedRequest: PiChatSubmitRequest | null = null;
  const renderedAssistantStatuses: Array<string | undefined> = [];
  const renderedIncrementalMessages: ChatMessage[] = [];
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.memory.useLongTermMemory = true;
  settings.sessions = [session];
  settings.activeSessionId = session.id;
  const fixtureProvider = createApiProviderConfig("custom", "fixture-provider");
  const fixtureModel = createApiProviderModelConfig(
    "custom",
    "fixture-model",
    "fixture-provider"
  );
  fixtureProvider.runtimeProviderId = "fixture-provider";
  fixtureProvider.apiProtocol = "openai-completions";
  fixtureProvider.baseUrl = "https://fixture.example/v1";
  fixtureModel.contextWindow = 128_000;
  fixtureModel.modelMaxTokens = 8_192;
  fixtureModel.maxOutputTokens = 8_192;
  fixtureProvider.models = [fixtureModel];
  fixtureProvider.defaultModelId = fixtureModel.id;
  settings.apiProviders = [fixtureProvider];
  const plugin = {
    settings,
    getVaultPath: () => "/vault",
    getEchoInkAgentIdentityView: () => ({ displayName: "EchoInk", avatarUrl: null }),
    readRawMessageText: async () => "",
    piAgentApprovalBinding: () => null,
    persistPiNativeSettings: async () => undefined,
    buildRuntimeEchoInkResourceCatalog: async () => [item.skill!, defaultSkill],
    submitPiChat: async (request: PiChatSubmitRequest) => {
      submittedRequest = request;
      return {
        productRunId: "product-run-turn-runner",
        conversationId: session.id,
        piSessionId: session.piSessionId!,
        userEntryId: "entry-user",
        result: runResult.promise
      };
    },
    subscribePiRun: (_productRunId: string, next: PiChatRuntimeEventListener) => {
      listener = next;
      return { unsubscribe: () => { listener = null; } };
    },
    subscribePiAgentApproval: (
      identity: Readonly<{
        conversationId: string;
        piSessionId: string;
        productRunId: string;
      }>,
      next: () => void
    ) => {
      approvalSubscriptionIdentity = identity;
      approvalListener = next;
      return { unsubscribe: () => { approvalListener = null; } };
    },
    readPiConversationProjection: async (): Promise<PiConversationProjection> => {
      projectionReads += 1;
      if (approvalRefreshPending) {
        approvalRefreshPending = false;
        return durableApprovalProjection(session);
      }
      settlementProjectionReads += 1;
      return durableProjection(
        session,
        settlementProjectionReads === 1 ? "running" : "completed"
      );
    },
    abortPiConversation: async () => undefined,
    releasePiProductionRun: (productRunId: string) => {
      releasedRunId = productRunId;
    },
    releasePiConversationIfInactive: async () => false
  };
  const dom = installTurnRunnerMessageDom();
  const messageContext = createTestContext();
  const messageListRenderer = new CodexMessageListRenderer();
  const messagesEl = new FakeElement("div");
  const virtualListEl = new FakeElement("div");
  let running = false;
  let activeRunId = "";
  const view: any = {
    app: messageContext.app,
    plugin,
    get running() { return running; },
    set running(value: boolean) { running = value; },
    get activeRunId() { return activeRunId; },
    set activeRunId(value: string) { activeRunId = value; },
    activeRunKind: "",
    activeRunSessionId: "",
    activeTurnId: "",
    activeRunNativeExecutionRecordIds: [],
    turnStartedAt: 0,
    messagesBottomFollowPaused: false,
    messagesEl,
    virtualListEl,
    jumpToLatestEl: new FakeElement("button"),
    taskPlanDockEl: new FakeElement("div"),
    interactionDockEl: new FakeElement("div"),
    messageListRenderer,
    registerDomEvent: messageContext.component.registerDomEvent,
    inputEl: { value: item.text },
    attachments: item.attachments.map((attachment) => ({ ...attachment })),
    selectedSkill: { ...item.skill! },
    setPendingInteraction: () => undefined,
    clearComposerDraft: () => { composerCleared = true; },
    ensureSession: () => session,
    derivePiConversationFromMessage: async () => undefined,
    handlePiTaskPlanAction: async () => undefined,
    preparePiTaskPlanModification: () => undefined,
    renderTabs: () => undefined,
    renderMessagesIfActive: (
      activeSession: StoredSession,
      updatedMessage?: ChatMessage
    ) => {
      if (updatedMessage) {
        renderedIncrementalMessages.push(structuredClone(updatedMessage));
      }
      renderedAssistantStatuses.push(
        session.messages.find((message) => message.role === "assistant")?.status
      );
      renderMessagesIfActiveThroughController(view, activeSession, updatedMessage);
    },
    renderMessages: () => renderMessagesThroughController(view),
    scheduleRenderMessages: () => renderMessagesThroughController(view),
    scheduleMeasureVirtualRows: () => undefined,
    scheduleKnowledgeBaseRunProgress: () => undefined,
    isMessagesAtBottom: () => true,
    renderTaskPlanDock: () => undefined,
    renderInteractionDock: () => undefined,
    renderToolbar: () => undefined,
    applyStatus: () => undefined,
    armTurnWatchdog: () => undefined,
    clearTurnWatchdog: () => undefined,
    clearActiveRun: () => { activeRunId = ""; }
  };
  try {
  addComposerNoteMentionSelection(view.inputEl, item.noteMentions![0]!);
  restoreSelectionDraft(view.inputEl, { ...emptySelectionDraft(view.inputEl.value), annotations: item.selectionAnnotations!, nextNumber: 2 });

  let turnResolved = false;
  const turn = startChatTurn(view, session, item, "composer").then((outcome) => {
    turnResolved = true;
    return outcome;
  });
  await waitFor(() => listener !== null || turnResolved);
  assert.ok(listener, JSON.stringify(openTestNoticeMessages.slice(-4)));
  assert.deepEqual(approvalSubscriptionIdentity, {
    conversationId: session.id,
    piSessionId: session.piSessionId,
    productRunId: "product-run-turn-runner"
  }, "turn runner subscribes to the exact active Approval run");
  assert.equal(submittedRequest?.skillId, undefined);
  assert.equal(submittedRequest?.skillPath, undefined);
  assert.equal(submittedRequest?.skillName, undefined);
  assert.equal(submittedRequest?.memoryMode, "normal");
  assert.equal(submittedRequest?.images?.length, 1);
  assert.equal(submittedRequest?.documents?.length, 1);
  assert.match(submittedRequest?.documents?.[0]?.text ?? "", /Markdown 文档正文/u);
  assert.match(
    session.piDocumentReplay?.["entry-user"]?.[0]?.text ?? "",
    /Markdown 文档正文/u
  );
  assert.equal(
    JSON.stringify(session.piDocumentReplay).includes(item.attachments[1]!.path),
    false,
    "private replay metadata must persist neither paths nor bytes"
  );
  assert.deepEqual(submittedRequest?.noteMentions, item.noteMentions);
  assert.deepEqual(submittedRequest?.selectionAnnotations, item.selectionAnnotations);
  assert.equal(projectionReads, 0);
  const liveUserMessage = session.messages.find((message) =>
    message.role === "user"
  );
  assert.equal(liveUserMessage?.text, item.text);
  assert.deepEqual(liveUserMessage?.selectionAnnotations, item.selectionAnnotations);
  assert.deepEqual(liveUserMessage?.images, [{
    type: "image",
    name: "memory-personality-v1.webp",
    path: item.attachments[0]!.path,
    mimeType: "image/webp",
    availability: "available"
  }]);
  assert.deepEqual(liveUserMessage?.noteMentions, [{
    vaultRelativePath: "projects/项目复盘.md",
    fileName: "项目复盘.md"
  }]);
  assert.deepEqual(liveUserMessage?.attachments, [{
    type: "file",
    name: "sample.md",
    path: item.attachments[1]!.path,
    mimeType: "text/markdown",
    sizeBytes: submittedRequest?.documents?.[0]?.attachment.sizeBytes,
    availability: "available"
  }]);
  assert.equal(JSON.stringify(liveUserMessage).includes("PRIVATE_WHOLE_NOTE_BODY"), false,
    "live ChatMessage keeps note metadata only");
  const submittedImagePayload = submittedRequest?.images?.[0]?.content.data;
  assert.ok(submittedImagePayload);
  assert.equal(
    JSON.stringify(liveUserMessage).includes(submittedImagePayload),
    false,
    "the immediate live projection must keep metadata only, never a Base64 copy"
  );

  await emit(listener, runtimeEvent({
    type: "message_start",
    messageKey: "user-live",
    role: "user"
  }));
  assert.equal(
    session.messages.filter((message) => message.role === "user").length,
    1,
    "a real user message_start must reuse the optimistic accepted image bubble"
  );
  assert.deepEqual(
    session.messages.find((message) => message.role === "user")?.images,
    liveUserMessage?.images,
    "user message_start must preserve the complete local thumbnail metadata"
  );
  await emit(listener, runtimeEvent({
    type: "message_end",
    messageKey: "user-live",
    role: "user",
    text: item.text,
    status: "completed"
  }));
  assert.equal(
    session.messages.filter((message) => message.role === "user").length,
    1,
    "a user message_end without entryId must not create a second bubble"
  );
  assert.deepEqual(
    session.messages.find((message) => message.role === "user")?.images,
    liveUserMessage?.images,
    "user message_end without entryId must preserve path and availability"
  );
  await emit(listener, runtimeEvent({
    type: "message_entry_resolved",
    messageKey: "user-live",
    entryId: "entry-user"
  }));
  assert.equal(
    session.messages.filter((message) => message.role === "user").length,
    1
  );
  assert.deepEqual(
    session.messages.find((message) => message.role === "user")?.images,
    liveUserMessage?.images,
    "entry resolution must preserve ordered local image metadata"
  );

  await emit(listener, runtimeEvent({
    type: "provider_reasoning_start",
    messageKey: "assistant-reasoning-1",
    reasoningId: "reasoning-turn-runner-1"
  }));
  const fullRenderCountAfterReasoningTopology = virtualListEl.emptyCallCount;
  const reasoningRoot = virtualListEl.findByClass("codex-ai-elements-reasoning");
  assert.ok(reasoningRoot, "the first real Reasoning event creates the required topology");
  await emit(listener, runtimeEvent({
    type: "provider_reasoning_delta",
    messageKey: "assistant-reasoning-1",
    reasoningId: "reasoning-turn-runner-1",
    textDelta: "真实公开推理增量"
  }));
  assert.equal(
    renderedIncrementalMessages.at(-1)?.assistantTurn
      ?.providerReasoningSegments?.[0]?.text,
    "真实公开推理增量",
    "production reasoning delta passes its changed Assistant Turn carrier to the local updater"
  );
  assert.equal(virtualListEl.emptyCallCount, fullRenderCountAfterReasoningTopology,
    "a reasoning delta reaches message-controller and tryUpdateMessage without clearing the virtual list");
  assert.equal(virtualListEl.findByClass("codex-ai-elements-reasoning"), reasoningRoot,
    "the Reasoning DOM keeps identity after its first production delta");
  const reasoningBody = reasoningRoot!.findByClass("codex-ai-elements-reasoning-content");
  assert.ok(reasoningBody);
  dom.selectText(reasoningBody!, "真实公开");
  const selectedBeforeDelta = dom.selectedText();
  await emit(listener, runtimeEvent({
    type: "provider_reasoning_delta",
    messageKey: "assistant-reasoning-1",
    reasoningId: "reasoning-turn-runner-1",
    textDelta: "，第二段"
  }));
  assert.equal(virtualListEl.emptyCallCount, fullRenderCountAfterReasoningTopology,
    "later reasoning status and text changes remain local updates");
  assert.equal(virtualListEl.findByClass("codex-ai-elements-reasoning"), reasoningRoot);
  assert.equal(dom.selectedText(), selectedBeforeDelta,
    "a production reasoning delta restores the existing browser Selection");
  assert.ok(dom.selectionRestoreCalls() >= 1);
  await emit(listener, runtimeEvent({
    type: "provider_reasoning_end",
    messageKey: "assistant-reasoning-1",
    reasoningId: "reasoning-turn-runner-1",
    text: "真实公开推理增量，第二段",
    status: "completed"
  }));
  assert.equal(virtualListEl.emptyCallCount, fullRenderCountAfterReasoningTopology,
    "reasoning end patches status without clearing the virtual list");
  assert.equal(virtualListEl.findByClass("codex-ai-elements-reasoning"), reasoningRoot,
    "reasoning end preserves the original disclosure node");
  assert.equal(dom.selectedText(), selectedBeforeDelta,
    "reasoning end preserves the restored Selection");

  await emit(listener, runtimeEvent({
    type: "tool_execution_start",
    toolCallId: "tool-turn-runner-1",
    toolName: "vault_search",
    args: { query: "局部更新" }
  }));
  await emit(listener, runtimeEvent({
    type: "tool_execution_update",
    toolCallId: "tool-turn-runner-1",
    toolName: "vault_search",
    update: { content: "找到结果" }
  }));
  await emit(listener, runtimeEvent({
    type: "tool_execution_end",
    toolCallId: "tool-turn-runner-1",
    toolName: "vault_search",
    result: { content: "找到结果" },
    isError: false
  }));
  assert.deepEqual(
    renderedIncrementalMessages
      .filter((message) =>
        piToolCallIdFromProjectedMessageId(message.id) === "tool-turn-runner-1"
      )
      .map((message) => message.status),
    ["running", "running", "running"],
    "production Tool status events pass each changed Tool carrier to the local updater"
  );
  assert.equal(
    renderedIncrementalMessages
      .filter((message) =>
        piToolCallIdFromProjectedMessageId(message.id) === "tool-turn-runner-1"
      )
      .at(-1)?.processOutput,
    "找到结果",
    "Tool end carrier includes the latest real output while durable status remains authoritative"
  );

  await emit(listener, runtimeEvent({
    type: "message_start",
    messageKey: "assistant-1",
    role: "assistant"
  }));
  await emit(listener, runtimeEvent({
    type: "message_update",
    messageKey: "assistant-1",
    textDelta: "streaming"
  }));
  assert.equal(
    renderedIncrementalMessages.at(-1)?.text,
    "streaming",
    "production answer delta passes the changed Assistant message carrier to the local updater"
  );
  approvalRefreshPending = true;
  assert.ok(approvalListener);
  approvalListener();
  await waitFor(() => projectionReads === 1);
  assert.equal(
    session.messages.find((message) => message.approval?.status === "pending")
      ?.approval?.target,
    "{\"relativePath\":\"Approval.md\"}",
    "a broker notification refreshes the durable Approval projection"
  );
  await emit(listener, runtimeEvent({ type: "agent_end", willRetry: false }));
  assert.equal(turnResolved, false, "agent_end must not settle the product turn");
  assert.equal(projectionReads, 1, "agent_end must not trigger a settlement readback");
  assert.equal(
    session.messages.find((message) => message.role === "assistant")?.status,
    "running"
  );

  await emit(listener, runtimeEvent({ type: "agent_settled" }));
  await waitFor(() => settlementProjectionReads === 1);
  assert.equal(turnResolved, false, "agent_settled must only enter finalizing");
  assert.equal(
    session.messages.find((message) => message.role === "assistant")?.status,
    "running",
    "agent_settled readback must not fabricate a terminal UI state"
  );

  await emit(listener, runtimeEvent({
    type: "product_run_settled",
    terminalState: "completed",
    assistantEntryId: "entry-assistant"
  }));
  runResult.resolve({
    productRunId: "product-run-turn-runner",
    conversationId: session.id,
    piSessionId: session.piSessionId!,
    userEntryId: "entry-user",
    assistantEntryId: "entry-assistant",
    toolCallIds: [],
    memoryMode: "normal",
    state: "product_run_settled",
    terminalState: "completed",
    activeLeafId: "entry-assistant",
    agentSettledAt: 7,
    settledAt: 8,
    createdAt: 2,
    updatedAt: 8
  });

  assert.equal(await turn, "completed");
  assert.equal(projectionReads, 3,
    "Approval refresh, Agent settlement, and formal ProductRun settlement each read once");
  assert.equal(session.messages.at(-1)?.status, "completed");
  assert.equal(session.messages.at(-1)?.askSourceAttribution, true);
  assert.equal(
    session.defaultSkillId,
    "knowledge-review",
    "durable projection readback preserves the Catalog-owned default Skill"
  );
  assert.deepEqual(session.messages.at(-1)?.personalMemorySources, [
    { id: "memory-turn-runner", title: "Turn runner Memory" }
  ]);
  assert.equal(composerCleared, true, "durable user entry must clear the submitted draft");
  assert.equal(releasedRunId, "product-run-turn-runner");
  assert.equal(approvalListener, null, "the run-scoped Approval subscription is released");
  assert.equal(
    renderedAssistantStatuses.slice(0, -1).includes("completed"),
    true,
    "the formal ProductRun event must be the first event allowed to render terminal status"
  );
  } finally {
    messageListRenderer.dispose();
    dom.restore();
  }
}

async function failedSettlementNoticeMatchesDurableFailureReason():
Promise<void> {
  const session = piSessionShell("conversation-turn-runner");
  session.piSessionId = "pi-session-turn-runner";
  const item: QueuedTurnItem = {
    id: "queued-failed-turn-runner",
    sessionId: session.id,
    text: "测试失败终态",
    attachments: [],
    skill: null,
    turnOptions: {
      providerSettingsId: "fixture-provider",
      runtimeProviderId: "fixture-provider",
      model: "fixture-model",
      reasoning: "high",
      permission: "read-only",
      mode: "agent",
      mcpEnabled: false
    },
    kind: "chat",
    createdAt: 2
  };
  const runResult = deferred<Readonly<PiProductRunRecord>>();
  let listener: PiChatRuntimeEventListener | null = null;
  const failedProjection = (): PiConversationProjection => {
    const projection = durableProjection(session, "completed");
    return {
      ...projection,
      messages: projection.messages.map((message) =>
        message.role === "assistant"
          ? {
              ...message,
              text: "失败前保留的 partial",
              details: "Provider 返回的流数据格式损坏，回答未完成。",
              status: "failed" as const
            }
          : message
      )
    };
  };
  const plugin = {
    settings: {
      memory: { useLongTermMemory: true },
      sessions: [session],
      activeSessionId: session.id
    },
    getVaultPath: () => "/vault",
    persistPiNativeSettings: async () => undefined,
    submitPiChat: async () => ({
      productRunId: "product-run-turn-runner",
      conversationId: session.id,
      piSessionId: session.piSessionId!,
      userEntryId: "entry-user",
      result: runResult.promise
    }),
    subscribePiRun: (
      _productRunId: string,
      next: PiChatRuntimeEventListener
    ) => {
      listener = next;
      return { unsubscribe: () => { listener = null; } };
    },
    subscribePiAgentApproval: () => ({ unsubscribe: () => undefined }),
    readPiConversationProjection: async () => failedProjection(),
    abortPiConversation: async () => undefined,
    releasePiProductionRun: () => undefined,
    releasePiConversationIfInactive: async () => false
  };
  let running = false;
  let activeRunId = "";
  const view: any = {
    plugin,
    get running() { return running; },
    set running(value: boolean) { running = value; },
    get activeRunId() { return activeRunId; },
    set activeRunId(value: string) { activeRunId = value; },
    activeRunKind: "",
    activeRunSessionId: "",
    activeTurnId: "",
    activeRunNativeExecutionRecordIds: [],
    turnStartedAt: 0,
    messagesBottomFollowPaused: false,
    inputEl: { value: item.text },
    attachments: [],
    selectedSkill: null,
    setPendingInteraction: () => undefined,
    clearComposerDraft: () => undefined,
    renderTabs: () => undefined,
    renderMessages: () => undefined,
    renderMessagesIfActive: () => undefined,
    renderToolbar: () => undefined,
    applyStatus: () => undefined,
    armTurnWatchdog: () => undefined,
    clearTurnWatchdog: () => undefined,
    clearActiveRun: () => { activeRunId = ""; }
  };

  openTestNoticeMessages.length = 0;
  const turn = startChatTurn(view, session, item, "composer");
  await waitFor(() => listener !== null);
  await emit(listener, runtimeEvent({ type: "agent_settled" }));
  await emit(listener, runtimeEvent({
    type: "product_run_settled",
    terminalState: "failed",
    assistantEntryId: "entry-assistant"
  }));
  runResult.resolve({
    productRunId: "product-run-turn-runner",
    conversationId: session.id,
    piSessionId: session.piSessionId!,
    userEntryId: "entry-user",
    assistantEntryId: "entry-assistant",
    toolCallIds: [],
    memoryMode: "normal",
    state: "product_run_settled",
    terminalState: "failed",
    activeLeafId: "entry-assistant",
    agentSettledAt: 7,
    settledAt: 8,
    error: "provider_sse_json_invalid",
    createdAt: 2,
    updatedAt: 8
  });
  assert.equal(await turn, "failed");
  assert.equal(
    openTestNoticeMessages.at(-1),
    "Provider 返回的流数据格式损坏，回答未完成。"
  );
  const durableAssistant = session.messages.find((message) =>
    message.role === "assistant"
  );
  assert.equal(durableAssistant?.text, "失败前保留的 partial");
  assert.equal(
    durableAssistant?.details,
    openTestNoticeMessages.at(-1),
    "top-right Notice and durable answer reason must use the same safe copy"
  );
}

async function pendingSubmitKeepsRunningConversationResidentAcrossSessionSwitch():
Promise<void> {
  const runningSession: StoredSession = {
    id: "conversation-turn-runner",
    title: "Running conversation",
    kind: "chat",
    piSessionId: "pi-session-turn-runner",
    bodyAuthority: "pi_session_only",
    cwd: "/vault",
    messages: [{ id: "history-before-submit" } as StoredSession["messages"][number]],
    createdAt: 1,
    updatedAt: 1
  };
  const targetSession: StoredSession = {
    id: "conversation-switch-target",
    title: "Other conversation",
    kind: "chat",
    piSessionId: "pi-session-switch-target",
    bodyAuthority: "pi_session_only",
    cwd: "/vault",
    messages: [],
    createdAt: 1,
    updatedAt: 1
  };
  const item: QueuedTurnItem = {
    id: "queued-pending-submit",
    sessionId: runningSession.id,
    text: "keep the full history",
    attachments: [],
    skill: null,
    turnOptions: {
      providerSettingsId: "fixture-provider",
      runtimeProviderId: "fixture-provider",
      model: "",
      reasoning: "high",
      permission: "read-only",
      mode: "agent",
      mcpEnabled: false
    },
    kind: "chat",
    createdAt: 2
  };
  const runResult = deferred<Readonly<PiProductRunRecord>>();
  const handle = {
    productRunId: "product-run-turn-runner",
    conversationId: runningSession.id,
    piSessionId: runningSession.piSessionId!,
    userEntryId: "entry-user",
    result: runResult.promise
  };
  const pendingSubmit = deferred<typeof handle>();
  let listener: PiChatRuntimeEventListener | null = null;
  let projectionReads = 0;
  let capturedPermission: string | undefined;
  const followUps: string[] = [];
  const steers: string[] = [];
  let unreadPersistenceCalls = 0;
  const plugin = {
    settings: {
      memory: { useLongTermMemory: true },
      sessions: [runningSession, targetSession],
      activeSessionId: runningSession.id
    },
    getVaultPath: () => "/vault",
    submitPiChat: async (request: PiChatSubmitRequest) => { capturedPermission = request.permission; return await pendingSubmit.promise; },
    followUpPiConversation: async (_id: string, text: string) => { followUps.push(text); },
    steerPiConversation: async (_id: string, text: string) => { steers.push(text); },
    subscribePiRun: (_productRunId: string, next: PiChatRuntimeEventListener) => {
      listener = next;
      return { unsubscribe: () => { listener = null; } };
    },
    subscribePiAgentApproval: () => ({ unsubscribe: () => undefined }),
    readPiConversationProjection: async (): Promise<PiConversationProjection> => {
      projectionReads += 1;
      return durableProjection(
        runningSession,
        projectionReads === 1 ? "running" : "completed"
      );
    },
    abortPiConversation: async () => undefined,
    releasePiProductionRun: () => undefined,
    releasePiConversationIfInactive: async (
      conversationId: string,
      isStillInactive: () => boolean
    ) => {
      assert.equal(conversationId, runningSession.id);
      assert.equal(isStillInactive(), true);
      return true;
    },
    switchPiConversation: async (
      _previous: string | null,
      next: string
    ): Promise<PiConversationProjection> => ({
      catalog: {
        conversationId: next,
        piSessionId: targetSession.piSessionId!,
        vaultId: "vault-turn-runner",
        title: targetSession.title,
        status: "active",
        defaultMemoryMode: "normal",
        createdAt: 1,
        updatedAt: 1,
        sessionFile: "/sessions/pi-session-switch-target.jsonl"
      },
      activeLeafId: null,
      messages: [{ id: "target-history" } as PiConversationProjection["messages"][number]],
      diagnostics: [],
      drafts: []
    }),
    saveSettings: async () => undefined,
    persistPiNativeSettings: async () => { unreadPersistenceCalls += 1; }
  };
  let running = false;
  let activeRunId = "";
  const view: any = {
    plugin,
    get running() { return running; },
    set running(value: boolean) { running = value; },
    get activeRunId() { return activeRunId; },
    set activeRunId(value: string) { activeRunId = value; },
    activeRunKind: "",
    activeRunSessionId: "",
    activeTurnId: "",
    turnStartedAt: 0,
    messagesBottomFollowPaused: false,
    renderTabs: () => undefined,
    renderMessages: () => undefined,
    renderMessagesIfActive: () => undefined,
    renderToolbar: () => undefined,
    applyStatus: () => undefined,
    setPendingInteraction: () => undefined,
    clearComposerDraft: () => undefined,
    armTurnWatchdog: () => undefined,
    clearTurnWatchdog: () => undefined,
    clearActiveRun: () => {
      activeRunId = "";
      view.activeRunKind = "";
      view.activeRunSessionId = "";
      view.activeTurnId = "";
    }
  };
  const sessionHost: any = {
    plugin,
    get running() { return view.running; },
    get activeRunSessionId() { return view.activeRunSessionId; },
    get runningSessionIds() { return new Set(view.running && view.activeRunSessionId ? [view.activeRunSessionId] : []); },
    updateInputPlaceholder: () => undefined,
    resetVirtualWindow: () => undefined,
    renderTabs: () => undefined,
    renderMessages: () => undefined,
    renderToolbar: () => undefined
  };

  const turn = startChatTurn(view, runningSession, item, "composer");
  await waitFor(() =>
    view.running
    && view.activeRunKind === "chat"
    && view.activeRunSessionId === runningSession.id
  );
  await activateSession(sessionHost, targetSession);
  assert.equal(plugin.settings.activeSessionId, targetSession.id);
  assert.equal(
    runningSession.messages[0]?.id,
    "history-before-submit",
    "the running session must remain resident while submitPiChat is pending"
  );

  pendingSubmit.resolve(handle);
  await waitFor(() => listener !== null);
  assert.equal(capturedPermission, "read-only", "switching conversations cannot replace the submitted permission");
  view.ensureSession = () => runningSession;
  view.sessionById = () => runningSession;
  view.turnQueue = new RuntimeTurnQueue();
  view.renderQueue = () => undefined;
  const nextMessage = { ...item, id: "same-access-followup", text: "same access", turnOptions: { ...item.turnOptions } };
  view.createQueuedTurnFromComposer = async () => nextMessage;
  await enqueueComposerDraft(view);
  assert.deepEqual(followUps, ["same access"], "matching access keeps Pi follow-up");
  nextMessage.id = "different-access-queued";
  nextMessage.text = "write in next turn";
  nextMessage.turnOptions.permission = "danger-full-access";
  await enqueueComposerDraft(view);
  nextMessage.turnOptions.permission = "read-only";
  assert.deepEqual(followUps, ["same access"]);
  assert.equal(view.turnQueue.itemsForSession(runningSession.id)[0]?.turnOptions.permission, "danger-full-access", "different access queues an independent frozen snapshot");
  view.inputEl = { value: "same access steering" };
  view.attachments = [];
  view.currentTurnOptions = () => nextMessage.turnOptions;
  await steerPiChatFromComposer(view);
  assert.deepEqual(steers, ["same access steering"]);
  nextMessage.id = "different-mode-steering";
  nextMessage.text = "plan this in the next turn";
  nextMessage.turnOptions.mode = "plan";
  await steerPiChatFromComposer(view);
  nextMessage.turnOptions.mode = "agent";
  assert.deepEqual(steers, ["same access steering"], "steering cannot change the active run's access");
  assert.equal(view.turnQueue.itemsForSession(runningSession.id)[1]?.turnOptions.mode, "plan");
  await emit(listener, runtimeEvent({
    type: "message_start",
    messageKey: "assistant-pending",
    role: "assistant"
  }));
  await emit(listener, runtimeEvent({
    type: "message_update",
    messageKey: "assistant-pending",
    textDelta: "streaming after switch"
  }));
  assert.equal(
    runningSession.messages.some((message) =>
      message.id === "history-before-submit"
    ),
    true,
    "post-submit runtime events must build on the retained history, not an empty live projection"
  );

  await emit(listener, runtimeEvent({ type: "agent_settled" }));
  await waitFor(() => projectionReads === 1);
  await emit(listener, runtimeEvent({
    type: "product_run_settled",
    terminalState: "completed",
    assistantEntryId: "entry-assistant"
  }));
  runResult.resolve({
    productRunId: handle.productRunId,
    conversationId: handle.conversationId,
    piSessionId: handle.piSessionId,
    userEntryId: handle.userEntryId,
    assistantEntryId: "entry-assistant",
    toolCallIds: [],
    memoryMode: "normal",
    state: "product_run_settled",
    terminalState: "completed",
    activeLeafId: "entry-assistant",
    agentSettledAt: 7,
    settledAt: 9,
    createdAt: 2,
    updatedAt: 9
  });

  assert.equal(await turn, "completed");
  assert.equal(runningSession.unreadAnswerAt, 9);
  assert.equal(
    runningSession.updatedAt,
    8,
    "marking the answer unread must not change conversation ordering time"
  );
  assert.equal(unreadPersistenceCalls, 1);
  assert.deepEqual(
    targetSession.messages.map((message) => message.id),
    ["target-history"],
    "background events must not enter the foreground conversation"
  );
  assert.equal(view.running, false);
  assert.equal(view.activeRunKind, "");
  assert.equal(view.activeRunSessionId, "");
}

function unreadAnswerRequiresBackgroundCompletedMatchingAssistant(): void {
  const session = piSessionShell("conversation-turn-runner");
  const projection = durableProjection(session, "completed");
  const completedEvent = runtimeEvent({
    type: "product_run_settled",
    terminalState: "completed",
    assistantEntryId: "entry-assistant"
  }) as Extract<PiChatRuntimeEvent, { type: "product_run_settled" }>;
  const completedRun: PiProductRunRecord = {
    productRunId: completedEvent.productRunId,
    conversationId: completedEvent.conversationId,
    piSessionId: completedEvent.piSessionId,
    userEntryId: "entry-user",
    assistantEntryId: "entry-assistant",
    toolCallIds: [],
    memoryMode: "normal",
    state: "product_run_settled",
    terminalState: "completed",
    activeLeafId: "entry-assistant",
    settledAt: 25,
    createdAt: 2,
    updatedAt: 25
  };
  const evaluate = (
    event: typeof completedEvent,
    run: PiProductRunRecord = completedRun,
    finalProjection: PiConversationProjection = projection,
    activeSessionId = "conversation-foreground"
  ) => piConversationUnreadAnswerAt({
    sessionId: session.id,
    activeSessionId,
    event,
    run,
    projection: finalProjection,
    now: 30
  });

  assert.equal(evaluate(completedEvent), 25);
  assert.equal(evaluate(completedEvent, completedRun, projection, session.id), undefined);
  for (const terminalState of ["failed", "cancelled"] as const) {
    assert.equal(evaluate({ ...completedEvent, terminalState }), undefined);
  }
  assert.equal(
    evaluate({ ...completedEvent, assistantEntryId: "entry-other" }),
    undefined
  );
  assert.equal(
    evaluate(completedEvent, completedRun, {
      ...projection,
      messages: projection.messages.filter((message) => message.role !== "assistant")
    }),
    undefined
  );
  assert.equal(
    evaluate(completedEvent, completedRun, {
      ...projection,
      messages: projection.messages.map((message) =>
        message.role === "assistant"
          ? { ...message, status: "running" }
          : message
      )
    }),
    undefined
  );
}

async function unreadPersistenceFailureDoesNotRestoreAfterConcurrentRead():
Promise<void> {
  const session = piSessionShell("conversation-unread-cas");
  session.unreadAnswerAt = 10;
  const projection = durableProjection(session, "completed");
  const event = runtimeEvent({
    type: "product_run_settled",
    terminalState: "completed",
    assistantEntryId: "entry-assistant"
  }) as Extract<PiChatRuntimeEvent, { type: "product_run_settled" }>;
  const run: PiProductRunRecord = {
    productRunId: event.productRunId,
    conversationId: event.conversationId,
    piSessionId: event.piSessionId,
    userEntryId: "entry-user",
    assistantEntryId: "entry-assistant",
    toolCallIds: [],
    memoryMode: "normal",
    state: "product_run_settled",
    terminalState: "completed",
    activeLeafId: "entry-assistant",
    settledAt: 25,
    createdAt: 2,
    updatedAt: 25
  };
  const persistence = deferred<void>();
  const originalConsoleError = console.error;
  console.error = () => undefined;
  try {
    const marking = markUnreadCompletedAnswerIfBackground({
      plugin: {
        settings: { activeSessionId: "conversation-foreground" },
        persistPiNativeSettings: async () => await persistence.promise
      }
    } as never, session, event, run, projection);
    await waitFor(() => session.unreadAnswerAt === 25);

    delete session.unreadAnswerAt;
    persistence.reject(new Error("older unread save failed"));
    await marking;
    assert.equal(
      session.unreadAnswerAt,
      undefined,
      "an older failed save must not overwrite a newer successful read"
    );
  } finally {
    console.error = originalConsoleError;
  }
}

async function busyActionInAnotherConversationDoesNotStopTheActiveRun():
Promise<void> {
  const runningSession = piSessionShell("conversation-running-elsewhere");
  const activeSession = piSessionShell("conversation-being-browsed");
  let stopCalls = 0;
  const view: any = {
    plugin: { settings: structuredClone(DEFAULT_SETTINGS) },
    running: true,
    activeRunSessionId: runningSession.id,
    turnQueue: { isSessionRecoveryRequired: () => false },
    ensureSession: () => activeSession,
    composerStateForSession: () => ({
      viewRunning: true,
      viewRunKind: "chat",
      knowledgeTaskRunning: false,
      hasDraft: false,
      hasQueuedItems: false
    }),
    stopTurn: async () => { stopCalls += 1; }
  };

  openTestNoticeMessages.length = 0;
  await sendMessage(view);
  assert.equal(stopCalls, 0);
  assert.match(
    openTestNoticeMessages.at(-1) ?? "",
    /另一个会话正在运行/u
  );

  await stopTurnFromComposer({
    running: true,
    activeRunSessionId: runningSession.id,
    plugin: { settings: { settingsLanguage: "zh-CN" } },
    stopTurn: async () => { stopCalls += 1; }
  } as never, activeSession);
  assert.equal(
    stopCalls,
    0,
    "the Composer callback rechecks ownership before stopping"
  );

  view.ensureSession = () => runningSession;
  view.activeRunSessionId = runningSession.id;
  await sendMessage(view);
  assert.equal(
    stopCalls,
    1,
    "the explicit stop action still works from the conversation that owns the run"
  );
}

function piSessionShell(id: string): StoredSession {
  return {
    id,
    title: id,
    kind: "chat",
    piSessionId: `pi-${id}`,
    bodyAuthority: "pi_session_only",
    cwd: "/vault",
    messages: [],
    createdAt: 1,
    updatedAt: 1
  };
}

function queuedImageTurn(sessionId: string, imagePath: string): QueuedTurnItem {
  return {
    id: `queued-${sessionId}`,
    sessionId,
    text: "请看图片",
    attachments: [{
      type: "image",
      name: path.basename(imagePath),
      path: imagePath,
      mimeType: "image/png"
    }],
    skill: null,
    turnOptions: {
      providerSettingsId: "queue-image-provider",
      runtimeProviderId: "echoink-custom",
      model: "queue-image-model",
      reasoning: "none",
      permission: "read-only",
      mode: "agent",
      mcpEnabled: false
    },
    kind: "chat",
    createdAt: 2
  };
}

function createQueueImageProviderSettings(imageInput = true) {
  const settings = structuredClone(DEFAULT_SETTINGS);
  const provider = createApiProviderConfig("custom", "queue-image-provider");
  provider.name = "Queue image provider";
  provider.baseUrl = "https://queue-image.example/v1";
  provider.apiKey = "fixture-queue-image-key";
  const model = createApiProviderModelConfig("custom", "queue-image-model");
  model.input = imageInput ? ["text", "image"] : ["text"];
  provider.models = [model];
  provider.defaultModelId = "queue-image-model";
  settings.apiProviders = [provider];
  activateApiProviderModel(settings, provider, "queue-image-model");
  return settings;
}

function imageFailureView(input: Readonly<{
  session: StoredSession;
  composerItem?: Readonly<QueuedTurnItem>;
  onSubmit(request: PiChatSubmitRequest): Promise<never>;
  onClearComposer(): void;
  onPersist?(): Promise<void>;
}>): any {
  let running = false;
  let activeRunId = "";
  return {
    plugin: {
      settings: {
        memory: { useLongTermMemory: true },
        sessions: [input.session],
        activeSessionId: input.session.id
      },
      getVaultPath: () => "/vault",
      submitPiChat: input.onSubmit,
      persistPiNativeSettings: input.onPersist ?? (async () => undefined),
      readPiConversationProjection: async () => {
        throw new Error("no ProductRun projection for rejected submit");
      },
      abortPiConversation: async () => undefined,
      releasePiProductionRun: () => undefined,
      releasePiConversationIfInactive: async () => false
    },
    get running() { return running; },
    set running(value: boolean) { running = value; },
    get activeRunId() { return activeRunId; },
    set activeRunId(value: string) { activeRunId = value; },
    activeRunKind: "",
    activeRunSessionId: "",
    activeTurnId: "",
    turnStartedAt: 0,
    messagesBottomFollowPaused: false,
    inputEl: { value: input.composerItem?.text ?? "" },
    attachments: input.composerItem?.attachments.map((attachment) => ({
      ...attachment
    })) ?? [],
    selectedSkill: input.composerItem?.skill ?? null,
    clearComposerDraft: input.onClearComposer,
    renderTabs: () => undefined,
    renderMessages: () => undefined,
    renderMessagesIfActive: () => undefined,
    renderToolbar: () => undefined,
    applyStatus: () => undefined,
    armTurnWatchdog: () => undefined,
    clearTurnWatchdog: () => undefined,
    clearActiveRun: () => { activeRunId = ""; }
  };
}

function installTurnRunnerMessageDom(): Readonly<{
  selectText(container: FakeElement, text: string): void;
  selectedText(): string;
  selectionRestoreCalls(): number;
  restore(): void;
}> {
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const previousHTMLElement = Object.getOwnPropertyDescriptor(globalThis, "HTMLElement");
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  let selection: {
    rangeCount: number;
    anchorNode: FakeElement;
    anchorOffset: number;
    focusNode: FakeElement;
    focusOffset: number;
    setBaseAndExtent(
      anchorNode: FakeElement,
      anchorOffset: number,
      focusNode: FakeElement,
      focusOffset: number
    ): void;
    removeAllRanges(): void;
    addRange(): void;
  } | null = null;
  let restoreCalls = 0;
  const fakeWindow = {
    NodeFilter: { SHOW_TEXT: 4 },
    setTimeout: () => 1,
    clearTimeout: () => undefined,
    requestAnimationFrame: (callback: (timestamp: number) => void) => {
      callback(0);
      return 1;
    },
    cancelAnimationFrame: () => undefined
  };
  const fakeDocument = {
    body: new FakeElement("body"),
    activeElement: null,
    defaultView: fakeWindow,
    createElement: (tag: string) => Object.assign(new FakeElement(tag), { addEventListener() {}, removeEventListener() {} }),
    createElementNS: (_namespace: string, tag: string) => new FakeElement(tag),
    getSelection: () => selection,
    createRange: () => {
      let root: FakeElement | null = null;
      let endNode: FakeElement | null = null;
      let endOffset = 0;
      return {
        selectNodeContents: (container: FakeElement) => { root = container; },
        setStart: () => undefined,
        setEnd: (node: FakeElement, offset: number) => {
          endNode = node;
          endOffset = offset;
        },
        toString: () => root && endNode
          ? textThroughPoint(root, endNode, endOffset)
          : ""
      };
    },
    createTreeWalker: (container: FakeElement) => {
      const nodes = fakeTextNodes(container);
      let index = 0;
      return { nextNode: () => nodes[index++] ?? null };
    }
  };
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: fakeDocument
  });
  Object.defineProperty(globalThis, "HTMLElement", {
    configurable: true,
    value: FakeElement
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: fakeWindow
  });

  return {
    selectText: (container, text) => {
      const node = fakeTextNodes(container).find((candidate) =>
        candidate.textContent.includes(text)
      );
      assert.ok(node, `selection fixture must find ${text}`);
      const start = node!.textContent.indexOf(text);
      selection = {
        rangeCount: 1,
        anchorNode: node!,
        anchorOffset: start,
        focusNode: node!,
        focusOffset: start + text.length,
        setBaseAndExtent(anchorNode, anchorOffset, focusNode, focusOffset) {
          restoreCalls += 1;
          this.anchorNode = anchorNode;
          this.anchorOffset = anchorOffset;
          this.focusNode = focusNode;
          this.focusOffset = focusOffset;
        },
        removeAllRanges: () => undefined,
        addRange: () => undefined
      };
    },
    selectedText: () => {
      if (!selection) return "";
      if (selection.anchorNode === selection.focusNode) {
        return selection.anchorNode.textContent.slice(
          selection.anchorOffset,
          selection.focusOffset
        );
      }
      return "";
    },
    selectionRestoreCalls: () => restoreCalls,
    restore: () => {
      if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument);
      else delete (globalThis as unknown as { document?: unknown }).document;
      if (previousHTMLElement) Object.defineProperty(globalThis, "HTMLElement", previousHTMLElement);
      else delete (globalThis as unknown as { HTMLElement?: unknown }).HTMLElement;
      if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
      else delete (globalThis as unknown as { window?: unknown }).window;
    }
  };
}

function fakeTextNodes(container: FakeElement): FakeElement[] {
  const nodes: FakeElement[] = [];
  const visit = (element: FakeElement): void => {
    if (element.textContent) nodes.push(element);
    for (const child of element.children) visit(child);
  };
  for (const child of container.children) visit(child);
  return nodes;
}

function textThroughPoint(
  container: FakeElement,
  endNode: FakeElement,
  endOffset: number
): string {
  let text = "";
  for (const node of fakeTextNodes(container)) {
    if (node === endNode) return `${text}${node.textContent.slice(0, endOffset)}`;
    text += node.textContent;
  }
  return text;
}

function documentRequestCaptureView(input: Readonly<{
  settings: typeof DEFAULT_SETTINGS;
  onSubmit(request: PiChatSubmitRequest): Promise<never>;
}>): any {
  let running = false;
  let activeRunId = "";
  return {
    plugin: {
      settings: input.settings,
      getVaultPath: () => "/vault",
      submitPiChat: input.onSubmit,
      readPiConversationProjection: async () => {
        throw new Error("no ProductRun projection for rejected submit");
      },
      abortPiConversation: async () => undefined,
      releasePiProductionRun: () => undefined,
      releasePiConversationIfInactive: async () => false
    },
    get running() { return running; },
    set running(value: boolean) { running = value; },
    get activeRunId() { return activeRunId; },
    set activeRunId(value: string) { activeRunId = value; },
    activeRunKind: "",
    activeRunSessionId: "",
    activeTurnId: "",
    turnStartedAt: 0,
    messagesBottomFollowPaused: false,
    renderTabs: () => undefined,
    renderMessages: () => undefined,
    renderMessagesIfActive: () => undefined,
    renderToolbar: () => undefined,
    applyStatus: () => undefined,
    clearComposerDraft: () => undefined,
    armTurnWatchdog: () => undefined,
    clearTurnWatchdog: () => undefined,
    clearActiveRun: () => { activeRunId = ""; }
  };
}

function runtimeEvent(
  patch: RuntimeEventPatch
): PiChatRuntimeEvent {
  return {
    productRunId: "product-run-turn-runner",
    conversationId: "conversation-turn-runner",
    piSessionId: "pi-session-turn-runner",
    activeLeafId: "entry-assistant",
    occurredAt: 6,
    ...patch
  } as PiChatRuntimeEvent;
}

interface RuntimeEventBase {
  productRunId: string;
  conversationId: string;
  piSessionId: string;
  activeLeafId: string | null;
  occurredAt: number;
}

type RuntimeEventPatch = PiChatRuntimeEvent extends infer Event
  ? Event extends RuntimeEventBase
    ? Omit<Event, keyof RuntimeEventBase>
    : never
  : never;

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function durableProjection(
  session: Readonly<StoredSession>,
  assistantStatus: "running" | "completed"
): PiConversationProjection {
  return {
    catalog: {
      conversationId: session.id,
      piSessionId: session.piSessionId!,
      vaultId: "vault-turn-runner",
      title: session.title,
      status: "active",
      defaultMemoryMode: "normal",
      ...(session.defaultSkillId
        ? { defaultSkillId: session.defaultSkillId }
        : {}),
      createdAt: 1,
      updatedAt: assistantStatus === "completed" ? 8 : 7,
      sessionFile: "/sessions/pi-session-turn-runner.jsonl"
    },
    activeLeafId: "entry-assistant",
    messages: [
      {
        id: piProjectedEntryMessageId(
          session.piSessionId!,
          "entry-assistant",
          "entry-user"
        ),
        role: "user",
        itemType: "user",
        text: session.piImageAttachments?.["entry-user"]?.length ? "" : "hello",
        ...(session.piImageAttachments?.["entry-user"]?.length
          ? {
              images: session.piImageAttachments["entry-user"].map(
                (image, index) => ({
                  type: "image" as const,
                  name: `图片 ${index + 1}`,
                  path: "",
                  mimeType: image.mimeType,
                  availability: "unavailable" as const
                })
              )
            }
          : {}),
        status: "completed",
        runId: "product-run-turn-runner",
        turnId: "product-run-turn-runner",
        createdAt: 2,
        completedAt: 2
      },
      {
        id: piProjectedEntryMessageId(
          session.piSessionId!,
          "entry-assistant",
          "entry-assistant"
        ),
        role: "assistant",
        itemType: "assistant",
        text: assistantStatus === "completed" ? "done" : "streaming",
        status: assistantStatus,
        runId: "product-run-turn-runner",
        turnId: "product-run-turn-runner",
        createdAt: 3,
        ...(assistantStatus === "completed"
          ? {
              completedAt: 8,
              askSourceAttribution: true as const,
              personalMemorySources: [
                { id: "memory-turn-runner", title: "Turn runner Memory" }
              ]
            }
          : {})
      }
    ],
    diagnostics: [],
    drafts: []
  };
}

function durableApprovalProjection(
  session: Readonly<StoredSession>
): PiConversationProjection {
  const projection = durableProjection(session, "running");
  return {
    ...projection,
    messages: [
      ...projection.messages,
      {
        id: "pi:tool:tool-call-approval",
        role: "tool",
        itemType: "dynamicToolCall",
        title: "等待确认",
        text: "pending approval",
        status: "waiting_approval",
        runId: "product-run-turn-runner",
        turnId: "product-run-turn-runner",
        approval: {
          status: "pending",
          target: "{\"relativePath\":\"Approval.md\"}",
          preview: "{\"operation\":\"note_create\"}",
          updatedAt: 6
        },
        createdAt: 3
      }
    ]
  };
}

async function emit(
  listener: PiChatRuntimeEventListener | null,
  event: PiChatRuntimeEvent
): Promise<void> {
  assert.ok(listener, "Pi turn runner must subscribe before events are emitted");
  await listener(event);
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Timed out waiting for Pi turn runner state");
}

if (process.env.ECHOINK_RUN_PI_TURN_RUNNER_TESTS === "1") {
  void runPiNativeTurnRunnerTests().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
