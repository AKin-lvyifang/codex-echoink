import * as assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { PiConversationCatalogEntry, PiConversationProjection } from "../../harness/pi-native/contracts";
import {
  DEFAULT_SETTINGS,
  normalizeSettingsData,
  type StoredSession
} from "../../settings/settings";
import {
  activateSession,
  archiveSession,
  createSession,
  deleteArchivedConversation,
  deleteSessions,
  derivePiConversationFromMessage,
  discardUnacceptedSession,
  ensureInitialConversation,
  resetSessionNativeCache,
  restoreArchivedConversation
} from "../../ui/codex-view/session-controller";

export async function runPiConversationStartupTests(): Promise<void> {
  await createsOneCurrentConversationForAnEmptyProductGeneration();
  await reusesTheCurrentConversationWhenOneExists();
  await releasesHistoricalBodiesAndReloadsThemOnSelection();
  await keepsAllInFlightConversationBodiesWhileAnotherSessionIsActive();
  await protectsEveryRunningConversationWhileAnIdleSessionIsActive();
  await unreadAnswersClearOnlyAfterSuccessfulOpen();
  unreadAnswerAtNormalizationAcceptsOnlyPositiveFiniteNumbers();
  await rendersLocalHistoryBeforeSettingsPersistenceCompletes();
  await rapidSelectionIsNotBlockedByEarlierSettingsPersistence();
  await lateEarlierProjectionCannotReplaceTheLatestSelection();
  await failedConversationCreationRollsBackCatalogAndShell();
  await laterExistingSelectionBeatsAnEarlierConversationCreation();
  await laterConversationCreationBeatsAnEarlierExistingSelection();
  await archivesWithoutConfirmationAndKeepsRunningConversation();
  await archivingAPendingSelectionInvalidatesItsLateProjection();
  await deletingAPendingSelectionInvalidatesItsLateProjection();
  await laterFallbackSelectionBeatsAnEarlierExistingSelection();
  await laterExistingSelectionPreventsAnEarlierFallbackActivation();
}

async function failedConversationCreationRollsBackCatalogAndShell(): Promise<void> {
  for (const failureStage of ["activation", "persistence"] as const) {
    const current = storedSession(`conversation-current-${failureStage}-failure`);
    const created = storedSession(`conversation-created-${failureStage}-failure`);
    const emptyProjection = {
      ...conversationProjection(created, "unused"),
      messages: []
    } satisfies PiConversationProjection;
    const statusChanges: Array<[string, string]> = [];
    const clearedQueues: string[] = [];
    let saveAttempts = 0;
    const host = conversationHost({
      sessions: [current],
      activeSessionId: current.id,
      switchPiConversation: async () => {
        if (failureStage === "activation") {
          throw new Error("activation_failed");
        }
        return emptyProjection;
      },
      saveSettings: async () => {
        saveAttempts += 1;
        if (failureStage === "persistence" && saveAttempts === 1) {
          throw new Error("persistence_failed");
        }
      },
      rendered: []
    });
    host.plugin.createPiConversation = async () =>
      emptyProjection.catalog;
    host.plugin.getVaultPath = () => "/disposable-vault";
    host.plugin.setPiConversationStatus = async (conversationId: string, status: string) => {
      statusChanges.push([conversationId, status]);
    };
    host.turnQueue = {
      clearSessionQueue: (conversationId: string) => {
        clearedQueues.push(conversationId);
      }
    };

    await assert.rejects(
      createSession(host),
      new RegExp(`${failureStage}_failed`, "u")
    );
    assert.deepEqual(host.plugin.settings.sessions, [current]);
    assert.equal(host.plugin.settings.activeSessionId, current.id);
    assert.deepEqual(statusChanges, [[created.id, "deleted"]]);
    assert.deepEqual(clearedQueues, [created.id]);
    assert.equal(saveAttempts, failureStage === "activation" ? 1 : 2);
  }
}

async function createsOneCurrentConversationForAnEmptyProductGeneration(): Promise<void> {
  const settings = { sessions: [] as StoredSession[], activeSessionId: "" };
  const createdRequests: Array<Record<string, unknown>> = [];
  const switched: Array<[string | null, string]> = [];
  let saves = 0;
  const catalogEntry: PiConversationCatalogEntry = {
    conversationId: "conversation-current-generation",
    title: "新会话",
    piSessionId: "pi-session-current-generation",
    status: "active",
    defaultMemoryMode: "normal",
    createdAt: 10,
    updatedAt: 10
  };
  const projection: PiConversationProjection = {
    catalog: catalogEntry,
    activeLeafId: null,
    messages: [],
    diagnostics: [],
    drafts: []
  };
  const host = {
    runningSessionIds: new Set<string>(),
    plugin: {
      settings,
      createPiConversation: async (request: Record<string, unknown>) => {
        createdRequests.push(request);
        return catalogEntry;
      },
      switchPiConversation: async (previous: string | null, next: string) => {
        switched.push([previous, next]);
        return projection;
      },
      getVaultPath: () => "/disposable-vault",
      saveSettings: async () => { saves += 1; }
    },
    updateInputPlaceholder: () => undefined,
    resetVirtualWindow: () => undefined,
    renderTabs: () => undefined,
    renderMessages: () => undefined,
    renderToolbar: () => undefined
  } as any;

  const result = await ensureInitialConversation(host);

  assert.equal(result.created, true);
  assert.equal(result.session.id, catalogEntry.conversationId);
  assert.equal(settings.activeSessionId, catalogEntry.conversationId);
  assert.equal(settings.sessions.length, 1);
  assert.equal(createdRequests.length, 1);
  assert.deepEqual(switched, [[null, catalogEntry.conversationId]]);
  assert.equal(saves, 1);
}

async function reusesTheCurrentConversationWhenOneExists(): Promise<void> {
  const existing: StoredSession = {
    id: "conversation-existing",
    title: "Existing",
    piSessionId: "pi-session-existing",
    bodyAuthority: "pi_session_only",
    cwd: "/disposable-vault",
    messages: [],
    createdAt: 1,
    updatedAt: 1
  };
  let creates = 0;
  const host = {
    runningSessionIds: new Set<string>(),
    plugin: {
      settings: { sessions: [existing], activeSessionId: existing.id },
      createPiConversation: async () => { creates += 1; }
    }
  } as any;

  const result = await ensureInitialConversation(host);

  assert.equal(result.created, false);
  assert.equal(result.session, existing);
  assert.equal(creates, 0);
}

async function releasesHistoricalBodiesAndReloadsThemOnSelection(): Promise<void> {
  const current = storedSession("conversation-residency-current");
  const historical = storedSession("conversation-residency-historical");
  current.messages = [{ id: "stale-current" } as StoredSession["messages"][number]];
  historical.messages = [{ id: "stale-historical" } as StoredSession["messages"][number]];
  const host = conversationHost({
    sessions: [current, historical],
    activeSessionId: current.id,
    switchPiConversation: async (_previous, next) => conversationProjection(
      next === current.id ? current : historical,
      `durable-${next}`
    ),
    saveSettings: async () => undefined,
    rendered: []
  });

  await activateSession(host, historical);
  assert.equal(current.messages.length, 0);
  assert.equal(historical.messages[0]?.id, `durable-${historical.id}`);

  await activateSession(host, current);
  assert.equal(historical.messages.length, 0);
  assert.equal(
    current.messages[0]?.id,
    `durable-${current.id}`,
    "reopening a released history shell must reload its durable projection"
  );
}

async function keepsAllInFlightConversationBodiesWhileAnotherSessionIsActive(): Promise<void> {
  const running = storedSession("conversation-residency-running");
  const secondRunning = storedSession("conversation-residency-second-running");
  const active = storedSession("conversation-residency-active");
  running.messages = [{ id: "running-body" } as StoredSession["messages"][number]];
  secondRunning.messages = [{ id: "second-running-body" } as StoredSession["messages"][number]];
  const host = conversationHost({
    sessions: [running, secondRunning, active],
    activeSessionId: running.id,
    switchPiConversation: async (_previous, next) => conversationProjection(
      next === running.id ? running : active,
      `durable-${next}`
    ),
    saveSettings: async () => undefined,
    rendered: []
  });
  host.runningSessionIds.add(running.id);
  host.runningSessionIds.add(secondRunning.id);

  await activateSession(host, active);
  assert.equal(
    running.messages[0]?.id,
    "running-body",
    "a running session must retain its body after the active tab changes"
  );
  assert.equal(secondRunning.messages[0]?.id, "second-running-body");
  assert.equal(active.messages[0]?.id, `durable-${active.id}`);

  host.runningSessionIds.delete(running.id);
  await activateSession(host, active);
  assert.equal(running.messages.length, 0);
  assert.equal(secondRunning.messages[0]?.id, "second-running-body",
    "completing one background conversation must not release another running body");

  host.runningSessionIds.delete(secondRunning.id);
  await activateSession(host, running);
  assert.equal(active.messages.length, 0);
  assert.equal(secondRunning.messages.length, 0);
}

async function protectsEveryRunningConversationWhileAnIdleSessionIsActive(): Promise<void> {
  const first = storedSession("conversation-protected-first");
  const second = storedSession("conversation-protected-second");
  const idle = storedSession("conversation-protected-idle");
  const statusChanges: string[] = [];
  const released: string[] = [];
  const derivedSources: string[] = [];
  const host = conversationHost({
    sessions: [first, second, idle],
    activeSessionId: idle.id,
    switchPiConversation: async () => conversationProjection(idle, "idle-body"),
    saveSettings: async () => undefined,
    rendered: []
  });
  host.running = false;
  host.activeRunSessionId = "";
  host.runningSessionIds.add(first.id);
  host.runningSessionIds.add(second.id);
  host.plugin.setPiConversationStatus = async (conversationId: string) => {
    statusChanges.push(conversationId);
  };
  host.plugin.releasePiConversation = async (conversationId: string) => {
    released.push(conversationId);
  };
  host.plugin.derivePiConversation = async ({ sourceConversationId }: { sourceConversationId: string }) => {
    derivedSources.push(sourceConversationId);
    const derived = storedSession("conversation-independent-derived");
    return {
      sourceConversationId,
      anchorEntryId: "anchor",
      anchorRole: "assistant",
      editorText: "",
      activation: { status: "activated" },
      projection: conversationProjection(derived, "derived-body")
    };
  };
  let confirmations = 0;
  for (const session of [first, second]) {
    await archiveSession(host, session.id);
    await resetSessionNativeCache(host, session);
    await derivePiConversationFromMessage(host, session, "anchor");
    assert.equal(await discardUnacceptedSession(host, session.id), false);
  }
  await deleteSessions(host, [first.id, second.id], {
    confirm: async () => { confirmations += 1; return true; }
  });
  assert.deepEqual(statusChanges, []);
  assert.deepEqual(released, []);
  assert.deepEqual(derivedSources, []);
  assert.equal(confirmations, 0);

  await resetSessionNativeCache(host, idle);
  assert.deepEqual(released, [idle.id], "background runs must not block an idle session's cache reset");

  host.inputEl = { value: "", focus: () => undefined, setSelectionRange: () => undefined };
  host.closeComposerMenus = () => undefined;
  host.plugin.getVaultPath = () => "/disposable-vault";
  await derivePiConversationFromMessage(host, idle, "anchor");
  assert.deepEqual(derivedSources, [idle.id], "only the source conversation's run may block derivation");
  assert.equal(host.plugin.settings.activeSessionId, "conversation-independent-derived");
}

async function unreadAnswersClearOnlyAfterSuccessfulOpen(): Promise<void> {
  const current = storedSession("conversation-unread-current");
  const target = storedSession("conversation-unread-target");
  target.unreadAnswerAt = 50;
  target.updatedAt = 20;
  const persisted: Array<Readonly<{
    unreadAnswerAt: number | undefined;
    updatedAt: number;
  }>> = [];
  const successHost = conversationHost({
    sessions: [current, target],
    activeSessionId: current.id,
    switchPiConversation: async () => conversationProjection(target, "opened-unread"),
    saveSettings: async () => {
      persisted.push({
        unreadAnswerAt: target.unreadAnswerAt,
        updatedAt: target.updatedAt
      });
    },
    rendered: []
  });

  await activateSession(successHost, target);
  assert.equal(target.unreadAnswerAt, undefined);
  assert.deepEqual(persisted, [{ unreadAnswerAt: undefined, updatedAt: 20 }]);

  const markReadTarget = storedSession("conversation-mark-read-failure");
  markReadTarget.unreadAnswerAt = 55;
  const markReadHost = conversationHost({ sessions: [markReadTarget], activeSessionId: markReadTarget.id,
    switchPiConversation: async () => conversationProjection(markReadTarget, "read-before-mark-failure"),
    saveSettings: async () => undefined, rendered: [] });
  markReadHost.plugin.setPiConversationTaskMetadata = async () => { throw new Error("mark_read_catalog_failed"); };
  await assert.rejects(activateSession(markReadHost, markReadTarget), /mark_read_catalog_failed/);
  assert.equal(markReadTarget.unreadAnswerAt, 55, "Failed Catalog mark-read must retain unread, even when the history was rendered");
  assert.equal(markReadTarget.messages[0]?.id, "read-before-mark-failure", "A failed mark-read must not discard successfully loaded history");

  for (const failureStage of ["projection", "persistence"] as const) {
    const failureCurrent = storedSession(`conversation-${failureStage}-current`);
    const failureTarget = storedSession(`conversation-${failureStage}-target`);
    failureTarget.unreadAnswerAt = 60;
    failureTarget.updatedAt = 30;
    const failureHost = conversationHost({
      sessions: [failureCurrent, failureTarget],
      activeSessionId: failureCurrent.id,
      switchPiConversation: async () => {
        if (failureStage === "projection") {
          throw new Error("projection_open_failed");
        }
        return conversationProjection(failureTarget, "opened-before-save-failed");
      },
      saveSettings: async () => {
        if (failureStage === "persistence") {
          throw new Error("unread_clear_persistence_failed");
        }
      },
      rendered: []
    });

    await assert.rejects(
      activateSession(failureHost, failureTarget),
      failureStage === "projection"
        ? /projection_open_failed/u
        : /unread_clear_persistence_failed/u
    );
    assert.equal(
      failureTarget.unreadAnswerAt,
      failureStage === "projection" ? 60 : undefined,
      "Only a successful read/render may commit mark-read; a later settings failure cannot roll back Catalog"
    );
    assert.equal(failureTarget.updatedAt, 30);
  }

  const concurrentCurrent = storedSession("conversation-concurrent-current");
  const concurrentTarget = storedSession("conversation-concurrent-target");
  concurrentTarget.unreadAnswerAt = 70;
  let rejectSave!: (error: Error) => void;
  const save = new Promise<void>((_resolve, reject) => {
    rejectSave = reject;
  });
  const concurrentHost = conversationHost({
    sessions: [concurrentCurrent, concurrentTarget],
    activeSessionId: concurrentCurrent.id,
    switchPiConversation: async () => conversationProjection(
      concurrentTarget,
      "opened-before-concurrent-answer"
    ),
    saveSettings: async () => await save,
    rendered: []
  });
  const opening = activateSession(concurrentHost, concurrentTarget);
  await flushMicrotasks();
  assert.equal(concurrentTarget.unreadAnswerAt, undefined);
  concurrentTarget.unreadAnswerAt = 80;
  rejectSave(new Error("older unread clear failed"));
  await assert.rejects(opening, /older unread clear failed/u);
  assert.equal(
    concurrentTarget.unreadAnswerAt,
    80,
    "an older failed clear must not overwrite a newer background answer"
  );
}

function unreadAnswerAtNormalizationAcceptsOnlyPositiveFiniteNumbers(): void {
  const session = (id: string, unreadAnswerAt: unknown) => ({
    id,
    title: id,
    kind: "chat",
    cwd: "/disposable-vault",
    messages: [],
    createdAt: 1,
    updatedAt: 2,
    unreadAnswerAt
  });
  const normalized = normalizeSettingsData({
    ...structuredClone(DEFAULT_SETTINGS),
    sessions: [
      session("valid", 123.5),
      session("zero", 0),
      session("negative", -1),
      session("infinite", Number.POSITIVE_INFINITY),
      session("string", "123"),
      session("nan", Number.NaN)
    ],
    activeSessionId: "valid"
  }).settings.sessions;

  assert.equal(normalized[0]?.unreadAnswerAt, 123.5);
  for (const invalid of normalized.slice(1)) {
    assert.equal(
      invalid.unreadAnswerAt,
      undefined,
      `${invalid.id} must not retain an invalid unread timestamp`
    );
  }
}

async function rendersLocalHistoryBeforeSettingsPersistenceCompletes():
Promise<void> {
  const current = storedSession("conversation-current");
  const target = storedSession("conversation-target");
  const projection = conversationProjection(target, "history-target");
  const persistence = deferred<void>();
  const rendered: string[] = [];
  let saveStarted = false;
  let settled = false;
  const host = conversationHost({
    sessions: [current, target],
    activeSessionId: current.id,
    switchPiConversation: async () => projection,
    saveSettings: async () => {
      saveStarted = true;
      await persistence.promise;
    },
    rendered
  });

  const opening = activateSession(host, target).finally(() => {
    settled = true;
  });
  await flushMicrotasks();

  assert.equal(saveStarted, true);
  assert.equal(settled, false);
  assert.equal(host.plugin.settings.activeSessionId, target.id);
  assert.equal(target.messages[0]?.id, "history-target");
  assert.ok(rendered.includes(`messages:${target.id}:history-target`));

  persistence.resolve();
  await opening;
}

async function rapidSelectionIsNotBlockedByEarlierSettingsPersistence():
Promise<void> {
  const current = storedSession("conversation-current");
  const first = storedSession("conversation-first");
  const second = storedSession("conversation-second");
  const firstPersistence = deferred<void>();
  const switches: Array<[string | null, string]> = [];
  const rendered: string[] = [];
  let saves = 0;
  const host = conversationHost({
    sessions: [current, first, second],
    activeSessionId: current.id,
    switchPiConversation: async (previous, next) => {
      switches.push([previous, next]);
      const session = next === first.id ? first : second;
      return conversationProjection(session, `history-${next}`);
    },
    saveSettings: async () => {
      saves += 1;
      if (saves === 1) await firstPersistence.promise;
    },
    rendered
  });

  const openingFirst = activateSession(host, first);
  await flushMicrotasks();
  assert.equal(host.plugin.settings.activeSessionId, first.id);

  const openingSecond = activateSession(host, second);
  await flushMicrotasks();
  const activeBeforeEarlierSaveSettled =
    host.plugin.settings.activeSessionId;
  const switchesBeforeEarlierSaveSettled = [...switches];
  const renderedLatestBeforeEarlierSaveSettled = rendered.includes(
    `messages:${second.id}:history-${second.id}`
  );

  firstPersistence.resolve();
  await Promise.all([openingFirst, openingSecond]);

  assert.equal(
    activeBeforeEarlierSaveSettled,
    second.id,
    "an earlier settings save must not block the latest local history"
  );
  assert.deepEqual(switchesBeforeEarlierSaveSettled, [
    [current.id, first.id],
    [first.id, second.id]
  ]);
  assert.equal(renderedLatestBeforeEarlierSaveSettled, true);
  assert.equal(host.plugin.settings.activeSessionId, second.id);
}

async function lateEarlierProjectionCannotReplaceTheLatestSelection():
Promise<void> {
  const current = storedSession("conversation-current");
  const first = storedSession("conversation-first-late");
  const second = storedSession("conversation-second-latest");
  const firstProjection = deferred<PiConversationProjection>();
  const rendered: string[] = [];
  const switches: Array<[string | null, string]> = [];
  const host = conversationHost({
    sessions: [current, first, second],
    activeSessionId: current.id,
    switchPiConversation: async (previous, next) => {
      switches.push([previous, next]);
      if (next === first.id) return await firstProjection.promise;
      return conversationProjection(second, "history-latest");
    },
    saveSettings: async () => undefined,
    rendered
  });

  const openingFirst = activateSession(host, first);
  const openingSecond = activateSession(host, second);
  await flushMicrotasks();
  firstProjection.resolve(conversationProjection(first, "history-stale"));
  await Promise.all([openingFirst, openingSecond]);

  assert.equal(host.plugin.settings.activeSessionId, second.id);
  assert.equal(first.messages.length, 0);
  assert.equal(second.messages[0]?.id, "history-latest");
  assert.equal(
    rendered.some((entry) => entry.includes("history-stale")),
    false
  );
  assert.deepEqual(switches, [
    [current.id, first.id],
    [current.id, second.id]
  ]);
}

async function laterExistingSelectionBeatsAnEarlierConversationCreation():
Promise<void> {
  const current = storedSession("conversation-current-create-race");
  const target = storedSession("conversation-existing-latest");
  const createdCatalog: PiConversationCatalogEntry = {
    conversationId: "conversation-created-stale",
    piSessionId: "pi-conversation-created-stale",
    title: "新会话",
    status: "active",
    defaultMemoryMode: "normal",
    createdAt: 2,
    updatedAt: 2
  };
  const creation = deferred<PiConversationCatalogEntry>();
  const switches: Array<[string | null, string]> = [];
  const rendered: string[] = [];
  const host = conversationHost({
    sessions: [current, target],
    activeSessionId: current.id,
    switchPiConversation: async (previous, next) => {
      switches.push([previous, next]);
      const session = next === target.id
        ? target
        : storedSession(next);
      return conversationProjection(session, `history-${next}`);
    },
    saveSettings: async () => undefined,
    rendered
  });
  host.plugin.createPiConversation = async () => await creation.promise;
  host.plugin.getVaultPath = () => "/disposable-vault";

  const creating = createSession(host);
  await flushMicrotasks();
  const openingTarget = activateSession(host, target);
  await openingTarget;
  creation.resolve(createdCatalog);
  const created = await creating;

  assert.equal(created.id, createdCatalog.conversationId);
  assert.equal(host.plugin.settings.activeSessionId, target.id);
  assert.equal(target.messages[0]?.id, `history-${target.id}`);
  assert.equal(created.messages.length, 0);
  assert.deepEqual(switches, [[current.id, target.id]]);
}

async function laterConversationCreationBeatsAnEarlierExistingSelection():
Promise<void> {
  const current = storedSession("conversation-current-new-latest");
  const earlier = storedSession("conversation-existing-stale");
  const created = storedSession("conversation-created-latest");
  const earlierProjection = deferred<PiConversationProjection>();
  const rendered: string[] = [];
  const host = conversationHost({
    sessions: [current, earlier],
    activeSessionId: current.id,
    switchPiConversation: async (_previous, next) => {
      if (next === earlier.id) return await earlierProjection.promise;
      return conversationProjection(created, "history-created-latest");
    },
    saveSettings: async () => undefined,
    rendered
  });
  host.plugin.createPiConversation = async () =>
    conversationProjection(created).catalog;
  host.plugin.getVaultPath = () => "/disposable-vault";

  const openingEarlier = activateSession(host, earlier);
  await flushMicrotasks();
  const creating = createSession(host);
  await flushMicrotasks();
  earlierProjection.resolve(conversationProjection(
    earlier,
    "history-existing-stale"
  ));
  const createdResult = await creating;
  await openingEarlier;

  assert.equal(createdResult.id, created.id);
  assert.equal(host.plugin.settings.activeSessionId, created.id);
  assert.equal(earlier.messages.length, 0);
  assert.equal(createdResult.messages[0]?.id, "history-created-latest");
  assert.equal(
    rendered.some((entry) => entry.includes("history-existing-stale")),
    false
  );
}

async function archivesWithoutConfirmationAndKeepsRunningConversation(): Promise<void> {
  const active = storedSession("conversation-archive-active");
  const target = storedSession("conversation-archive-target");
  const archivedStatusChanges: Array<[string, string]> = [];
  const host = conversationHost({
    sessions: [active, target],
    activeSessionId: active.id,
    switchPiConversation: async () => conversationProjection(active, "history-active"),
    saveSettings: async () => undefined,
    rendered: []
  });
  host.plugin.setPiConversationStatus = async (conversationId: string, status: string) => {
    archivedStatusChanges.push([conversationId, status]);
    return { ...conversationProjection(target, "history-target").catalog, status };
  };
  host.plugin.getVaultPath = () => "/disposable-vault";
  host.turnQueue = { clearSessionQueue: () => undefined };

  await archiveSession(host, target.id);

  assert.deepEqual(archivedStatusChanges, [[target.id, "archived"]]);
  assert.deepEqual(
    host.plugin.settings.sessions.map((session: StoredSession) => session.id),
    [active.id],
    "archiving directly removes only the selected conversation shell"
  );

  const archivedEntry = {
    ...conversationProjection(target, "history-target").catalog,
    status: "archived" as const
  };
  await restoreArchivedConversation(host, archivedEntry);
  assert.deepEqual(archivedStatusChanges, [
    [target.id, "archived"],
    [target.id, "active"]
  ]);
  assert.deepEqual(
    host.plugin.settings.sessions.map((session: StoredSession) => session.id),
    [active.id, target.id],
    "an archived conversation returns to the active shells when restored"
  );

  const deleteConfirmation: { title: string; body: string } = { title: "", body: "" };
  const deleted = await deleteArchivedConversation(host, archivedEntry, {
    confirm: async (title, body) => {
      deleteConfirmation.title = title;
      deleteConfirmation.body = body;
      return true;
    }
  });
  assert.equal(deleted, true);
  assert.deepEqual(archivedStatusChanges, [
    [target.id, "archived"],
    [target.id, "active"],
    [target.id, "deleted"]
  ]);
  assert.match(deleteConfirmation.title, /删除会话/u);
  assert.doesNotMatch(deleteConfirmation.title, /已归档|Pi|JSONL|Catalog/u);
  assert.equal(deleteConfirmation.body, "删除后无法在设置中恢复。");

  const sessionControllerSource = readFileSync(
    "src/ui/codex-view/session-controller.ts",
    "utf8"
  );
  const archiveSessionSource = sessionControllerSource.slice(
    sessionControllerSource.indexOf("export async function archiveSession"),
    sessionControllerSource.indexOf("export async function deleteSession")
  );
  assert.doesNotMatch(archiveSessionSource, /defaultRecordMutationConfirm|Pi Session|JSONL/u);
  assert.match(archiveSessionSource, /会话已归档，可在设置中恢复。/u);
  assert.ok(sessionControllerSource.includes("onArchive: () => void host.archiveSession(session.id)"));
  const deleteArchivedConversationSource = sessionControllerSource.slice(
    sessionControllerSource.indexOf("export async function deleteArchivedConversation"),
    sessionControllerSource.indexOf("type ConversationRecordMutationConfirm")
  );
  assert.ok(deleteArchivedConversationSource.includes("删除后无法在设置中恢复。"));
  assert.ok(deleteArchivedConversationSource.includes("\"已删除会话\""));
  assert.doesNotMatch(deleteArchivedConversationSource, /Pi Session|JSONL/u);
  const deleteSessionsSource = sessionControllerSource.slice(
    sessionControllerSource.indexOf("export async function deleteSessions"),
    sessionControllerSource.indexOf("function defaultRecordMutationConfirm")
  );
  assert.ok(deleteSessionsSource.includes("删除后无法在设置中恢复。"));
  assert.ok(deleteSessionsSource.includes("committedCount === 1 ? \"已删除会话\""));
  assert.doesNotMatch(deleteSessionsSource, /Pi Session|JSONL/u);

  const running = storedSession("conversation-archive-running");
  const runningStatusChanges: Array<[string, string]> = [];
  const runningHost = conversationHost({
    sessions: [running],
    activeSessionId: running.id,
    switchPiConversation: async () => conversationProjection(running, "history-running"),
    saveSettings: async () => undefined,
    rendered: []
  });
  runningHost.runningSessionIds.add(running.id);
  runningHost.plugin.setPiConversationStatus = async (conversationId: string, status: string) => {
    runningStatusChanges.push([conversationId, status]);
    return { ...conversationProjection(running, "history-running").catalog, status };
  };

  await archiveSession(runningHost, running.id);

  assert.deepEqual(runningStatusChanges, []);
  assert.deepEqual(
    runningHost.plugin.settings.sessions.map((session: StoredSession) => session.id),
    [running.id],
    "a running conversation remains available and is not archived"
  );
}

async function archivingAPendingSelectionInvalidatesItsLateProjection():
Promise<void> {
  const current = storedSession("conversation-current-archive-pending");
  const target = storedSession("conversation-target-archive-pending");
  const targetProjection = deferred<PiConversationProjection>();
  const queuedActivations: string[] = [];
  const rendered: string[] = [];
  let saves = 0;
  const host = conversationHost({
    sessions: [current, target],
    activeSessionId: current.id,
    switchPiConversation: async (_previous, next, options) => {
      const projection = await targetProjection.promise;
      if (options?.isStillCurrent?.() !== false) {
        queuedActivations.push(next);
      }
      return projection;
    },
    saveSettings: async () => { saves += 1; },
    rendered
  });
  host.plugin.setPiConversationStatus = async () => ({
    ...conversationProjection(target).catalog,
    status: "archived" as const
  });
  host.turnQueue = { clearSessionQueue: () => undefined };

  const openingTarget = activateSession(host, target);
  await flushMicrotasks();
  await archiveSession(host, target.id);
  targetProjection.resolve(conversationProjection(
    target,
    "history-archived-selection-stale"
  ));
  await openingTarget;

  assert.equal(host.plugin.settings.activeSessionId, current.id);
  assert.deepEqual(
    host.plugin.settings.sessions.map((session: StoredSession) => session.id),
    [current.id]
  );
  assert.equal(target.messages.length, 0);
  assert.equal(saves, 1);
  assert.deepEqual(queuedActivations, []);
  assert.equal(
    rendered.some((entry) => entry.includes(target.id)),
    false
  );
}

async function deletingAPendingSelectionInvalidatesItsLateProjection():
Promise<void> {
  const current = storedSession("conversation-current-delete-pending");
  const target = storedSession("conversation-target-delete-pending");
  const targetProjection = deferred<PiConversationProjection>();
  const queuedActivations: string[] = [];
  const rendered: string[] = [];
  let saves = 0;
  const host = conversationHost({
    sessions: [current, target],
    activeSessionId: current.id,
    switchPiConversation: async (_previous, next, options) => {
      const projection = await targetProjection.promise;
      if (options?.isStillCurrent?.() !== false) {
        queuedActivations.push(next);
      }
      return projection;
    },
    saveSettings: async () => { saves += 1; },
    rendered
  });
  host.plugin.setPiConversationStatus = async () => ({
    ...conversationProjection(target).catalog,
    status: "deleted" as const
  });
  host.turnQueue = { clearSessionQueue: () => undefined };

  const openingTarget = activateSession(host, target);
  await flushMicrotasks();
  await deleteSessions(host, [target.id], {
    confirm: async () => true
  });
  targetProjection.resolve(conversationProjection(
    target,
    "history-deleted-selection-stale"
  ));
  await openingTarget;

  assert.equal(host.plugin.settings.activeSessionId, current.id);
  assert.deepEqual(
    host.plugin.settings.sessions.map((session: StoredSession) => session.id),
    [current.id]
  );
  assert.equal(target.messages.length, 0);
  assert.equal(saves, 1);
  assert.deepEqual(queuedActivations, []);
  assert.equal(
    rendered.some((entry) => entry.includes(target.id)),
    false
  );
}

async function laterFallbackSelectionBeatsAnEarlierExistingSelection():
Promise<void> {
  const current = storedSession("conversation-current-delete-latest");
  const fallback = storedSession("conversation-fallback-latest");
  const earlier = storedSession("conversation-click-stale");
  const earlierProjection = deferred<PiConversationProjection>();
  const rendered: string[] = [];
  const host = conversationHost({
    sessions: [current, fallback, earlier],
    activeSessionId: current.id,
    switchPiConversation: async (_previous, next) => {
      if (next === earlier.id) return await earlierProjection.promise;
      return conversationProjection(fallback, "history-fallback-latest");
    },
    saveSettings: async () => undefined,
    rendered
  });
  host.plugin.activatePiConversation = async () =>
    conversationProjection(fallback, "history-fallback-latest");
  host.plugin.setPiConversationStatus = async () => ({
    ...conversationProjection(current).catalog,
    status: "deleted" as const
  });
  host.turnQueue = { clearSessionQueue: () => undefined };

  const openingEarlier = activateSession(host, earlier);
  await flushMicrotasks();
  const deleting = deleteSessions(host, [current.id], {
    confirm: async () => true
  });
  await flushMicrotasks();
  earlierProjection.resolve(conversationProjection(
    earlier,
    "history-click-stale"
  ));
  await Promise.all([openingEarlier, deleting]);

  assert.equal(host.plugin.settings.activeSessionId, fallback.id);
  assert.equal(earlier.messages.length, 0);
  assert.equal(fallback.messages[0]?.id, "history-fallback-latest");
  assert.equal(
    rendered.some((entry) => entry.includes("history-click-stale")),
    false
  );
}

async function laterExistingSelectionPreventsAnEarlierFallbackActivation():
Promise<void> {
  const current = storedSession("conversation-current-delete-stale");
  const fallback = storedSession("conversation-fallback-stale");
  const latest = storedSession("conversation-click-latest");
  const deletion = deferred<Readonly<PiConversationCatalogEntry>>();
  const latestProjection = deferred<PiConversationProjection>();
  const fallbackActivations: string[] = [];
  const rendered: string[] = [];
  const host = conversationHost({
    sessions: [current, fallback, latest],
    activeSessionId: current.id,
    switchPiConversation: async (_previous, next) => {
      if (next === latest.id) return await latestProjection.promise;
      fallbackActivations.push(next);
      return conversationProjection(fallback, "history-fallback-stale");
    },
    saveSettings: async () => undefined,
    rendered
  });
  host.plugin.activatePiConversation = async (conversationId: string) => {
    fallbackActivations.push(conversationId);
    return conversationProjection(fallback, "history-fallback-stale");
  };
  host.plugin.setPiConversationStatus = async () => await deletion.promise;
  host.turnQueue = { clearSessionQueue: () => undefined };

  const deleting = deleteSessions(host, [current.id], {
    confirm: async () => true
  });
  await flushMicrotasks();
  const openingLatest = activateSession(host, latest);
  await flushMicrotasks();
  deletion.resolve({
    ...conversationProjection(current).catalog,
    status: "deleted"
  });
  await flushMicrotasks();
  latestProjection.resolve(conversationProjection(
    latest,
    "history-click-latest"
  ));
  await Promise.all([deleting, openingLatest]);

  assert.equal(host.plugin.settings.activeSessionId, latest.id);
  assert.equal(latest.messages[0]?.id, "history-click-latest");
  assert.deepEqual(
    fallbackActivations,
    [],
    "a stale fallback must not read or activate its AgentSession"
  );
}

function storedSession(id: string): StoredSession {
  return {
    id,
    title: id,
    piSessionId: `pi-${id}`,
    bodyAuthority: "pi_session_only",
    cwd: "/disposable-vault",
    messages: [],
    createdAt: 1,
    updatedAt: 1
  };
}

function conversationProjection(
  session: StoredSession,
  messageId: string
): PiConversationProjection {
  return {
    catalog: {
      conversationId: session.id,
      piSessionId: session.piSessionId ?? `pi-${session.id}`,
      title: session.title,
      status: "active",
      defaultMemoryMode: "normal",
      createdAt: session.createdAt,
      updatedAt: session.updatedAt
    },
    activeLeafId: null,
    messages: [{ id: messageId } as PiConversationProjection["messages"][number]],
    diagnostics: [],
    drafts: []
  };
}

function conversationHost(input: Readonly<{
  sessions: StoredSession[];
  activeSessionId: string;
  switchPiConversation(
    previous: string | null,
    next: string,
    options?: Readonly<{ isStillCurrent?: () => boolean }>
  ): Promise<PiConversationProjection>;
  saveSettings(): Promise<void>;
  rendered: string[];
}>): any {
  const settings = {
    sessions: input.sessions,
    activeSessionId: input.activeSessionId
  };
  const host: any = {
    runningSessionIds: new Set<string>(),
    plugin: {
      settings,
      switchPiConversation: input.switchPiConversation,
      saveSettings: input.saveSettings,
      setPiConversationTaskMetadata: async (id: string, patch: Record<string, unknown>) => {
        const session = settings.sessions.find(session => session.id === id)!;
        // The fixture represents a successful Catalog patch and its projection.
        for (const [key, value] of Object.entries(patch)) {
          if (value === undefined) delete (session as any)[key];
          else (session as any)[key] = value;
        }
      }
    },
    updateInputPlaceholder: () => undefined,
    resetVirtualWindow: () => undefined,
    renderTabs: () => undefined,
    renderMessages: () => {
      const active = settings.sessions.find(
        (session) => session.id === settings.activeSessionId
      );
      input.rendered.push(
        `messages:${settings.activeSessionId}:${active?.messages[0]?.id ?? ""}`
      );
    },
    renderToolbar: () => undefined
  };
  return host;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}
