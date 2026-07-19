import * as assert from "node:assert/strict";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  abortRecordMutationJournal,
  commitRecordMutationJournal,
  createRecordMutationJournal,
  listRecordMutationJournals,
  loadRecordMutationJournal,
  RecordMutationJournalError,
  stageRecordMutationJournal,
  type LoadedRecordMutationJournal,
  type RecordMutationJournalErrorCode
} from "../../harness/lifecycle/record-mutation-journal";
import {
  createPlannedRecordMutationRevision,
  RecordMutationContractError,
  transitionRecordMutationRevision,
  type RecordMutationIntent,
  type RecordMutationStep
} from "../../harness/lifecycle/record-mutation-contract";
import {
  fixtureRecordMutationRootBindings,
  fixtureRecordRootBindingRef
} from "./record-root-fixtures";

export async function runHarnessV2RecordMutationJournalTests(): Promise<void> {
  await assertStrictJournalRoundTripAndMonotonicTransitions();
  await assertDestructiveIntentRequiresFrozenRootBindings();
  await assertCommitAndAbortRaceHasOneOutcomeWinner();
  await assertTerminalRequiresCompleteParticipantEvidence();
  await assertPublishedCreateRemainsSuccessfulAfterConcurrentAdvance();
  await assertPublishedRevisionRemainsSuccessfulAfterConcurrentAdvance();
  await assertStaleCasCannotOverwriteWinner();
  await assertFullChainReadbackRejectsCorruptionAndUnknownEntries();
  await assertFutureSchemaAndSymlinksFailClosed();
}

async function assertDestructiveIntentRequiresFrozenRootBindings(): Promise<void> {
  const validIntent = intent(
    "conversation-root-binding-contract",
    "delete-conversation"
  );
  const create = (candidate: RecordMutationIntent): void => {
    createPlannedRecordMutationRevision({
      mutationId: "mutation-root-binding-contract",
      intent: candidate,
      createdAt: 1_721_260_800_000
    });
  };
  assert.throws(
    () => create({ ...validIntent, rootBindings: [] }),
    RecordMutationContractError
  );
  assert.throws(
    () => create({
      ...validIntent,
      rootBindings: [...validIntent.rootBindings].reverse()
    }),
    RecordMutationContractError
  );
  assert.throws(
    () => create({
      ...validIntent,
      rootBindings: [
        fixtureRecordRootBindingRef("conversation-store", "first"),
        fixtureRecordRootBindingRef("conversation-store", "second")
      ]
    }),
    RecordMutationContractError
  );
  assert.throws(
    () => create({
      ...validIntent,
      rootBindings: [{
        ...validIntent.rootBindings[0],
        unknown: true
      } as never, validIntent.rootBindings[1]]
    }),
    RecordMutationContractError
  );
}

async function assertPublishedCreateRemainsSuccessfulAfterConcurrentAdvance(): Promise<void> {
  await withFixture("advanced-create-readback", async (storageRootPath) => {
    let releaseCreate!: () => void;
    let publishedCreate!: () => void;
    const createPublished = new Promise<void>((resolve) => {
      publishedCreate = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    const creating = createRecordMutationJournal({
      storageRootPath,
      mutationId: "mutation-advanced-create-readback",
      intent: intent(
        "conversation-advanced-create-readback",
        "start-new-context"
      ),
      createdAt: 1_721_260_800_000,
      async faultInjector(point) {
        if (point === "after-publish") {
          publishedCreate();
          await release;
        }
      }
    });
    await createPublished;
    const planned = await loadRecordMutationJournal({
      storageRootPath,
      mutationId: "mutation-advanced-create-readback"
    });
    const staged = await stageRecordMutationJournal(planned.handle, {
      ...cas(planned),
      step: forwardStep(1, "conversation", "prepared"),
      updatedAt: 1_721_260_800_010
    });
    releaseCreate();
    const result = await creating;
    assert.equal(result.chain[0]?.digest, planned.record.digest);
    assert.equal(result.record.digest, staged.record.digest);
  });
}

async function assertStrictJournalRoundTripAndMonotonicTransitions(): Promise<void> {
  await withFixture("round-trip", async (storageRootPath) => {
    const planned = await createRecordMutationJournal({
      storageRootPath,
      mutationId: "mutation-round-trip",
      intent: intent("conversation-round-trip", "clear-conversation-records"),
      createdAt: 1_721_260_800_000
    });
    assert.equal(planned.record.state, "planned");
    assert.equal(planned.record.revision, 0);
    assert.equal(planned.record.previousDigest, null);
    assert.match(planned.record.intentDigest, /^sha256:[a-f0-9]{64}$/);
    assert.match(planned.record.digest, /^sha256:[a-f0-9]{64}$/);

    await assert.rejects(
      () => commitRecordMutationJournal(planned.handle, {
        ...cas(planned),
        committedAt: 1_721_260_800_010,
        message: "must stage first"
      }),
      (error: unknown) => hasCode(error, "invalid_transition")
    );

    const trashPrepared = await stageRecordMutationJournal(planned.handle, {
      ...cas(planned),
      step: forwardStep(1, "conversation", "trash-staged"),
      updatedAt: 1_721_260_800_010
    });
    const sourceRetired = await stageRecordMutationJournal(trashPrepared.handle, {
      ...cas(trashPrepared),
      step: forwardStep(2, "conversation", "source-retired"),
      updatedAt: 1_721_260_800_020
    });
    const memoryStaged = await stageRecordMutationJournal(sourceRetired.handle, {
      ...cas(sourceRetired),
      step: forwardStep(3, "memory", "participant-staged"),
      updatedAt: 1_721_260_800_030
    });
    const committed = await commitRecordMutationJournal(memoryStaged.handle, {
      ...cas(memoryStaged),
      committedAt: 1_721_260_800_040,
      message: "local records committed"
    });

    assert.equal(committed.record.state, "committed");
    assert.equal(committed.record.revision, 4);
    assert.equal(committed.record.previousDigest, memoryStaged.record.digest);
    assert.deepEqual(
      (await loadRecordMutationJournal(committed.handle)).record,
      committed.record
    );
    assert.deepEqual(
      (await listRecordMutationJournals(storageRootPath))
        .map((item) => item.record.mutationId),
      ["mutation-round-trip"]
    );
    assert.equal((await lstat(committed.recordPath)).nlink, 1);

    await assert.rejects(
      () => stageRecordMutationJournal(committed.handle, {
        ...cas(committed),
        step: forwardStep(4, "conversation", "source-retired"),
        updatedAt: 1_721_260_800_050
      }),
      (error: unknown) => hasCode(error, "invalid_transition")
    );
  });
}

async function assertCommitAndAbortRaceHasOneOutcomeWinner(): Promise<void> {
  await withFixture("outcome-race", async (storageRootPath) => {
    const planned = await createRecordMutationJournal({
      storageRootPath,
      mutationId: "mutation-outcome-race",
      intent: intent("conversation-outcome-race", "start-new-context"),
      createdAt: 1_721_260_800_000
    });
    const staged = await stageRecordMutationJournal(planned.handle, {
      ...cas(planned),
      step: forwardStep(1, "conversation", "prepared"),
      updatedAt: 1_721_260_800_010
    });

    const results = await Promise.allSettled([
      commitRecordMutationJournal(staged.handle, {
        ...cas(staged),
        committedAt: 1_721_260_800_020,
        message: "commit won"
      }),
      abortRecordMutationJournal(staged.handle, {
        ...cas(staged),
        compensationSteps: [compensatingStep(
          1,
          "conversation",
          "compensation-prepared"
        )],
        compensatingAt: 1_721_260_800_020,
        abortedAt: 1_721_260_800_030,
        code: "compensated",
        message: "abort won"
      })
    ]);
    assert.equal(
      results.filter((result) => result.status === "fulfilled").length,
      1,
      "commit and abort paths must compete for the same immutable revision slot"
    );
    const current = await loadRecordMutationJournal(staged.handle);
    assert.ok(current.record.state === "committed" || current.record.state === "aborted");
    if (current.record.state === "aborted") {
      assert.equal(current.record.revision, 3);
    } else {
      assert.equal(current.record.revision, 2);
    }
  });
}

async function assertTerminalRequiresCompleteParticipantEvidence(): Promise<void> {
  await withFixture("participant-gate", async (storageRootPath) => {
    const planned = await createRecordMutationJournal({
      storageRootPath,
      mutationId: "mutation-participant-gate",
      intent: intent("conversation-participant-gate", "delete-conversation"),
      createdAt: 1_721_260_800_000
    });
    const trashPrepared = await stageRecordMutationJournal(planned.handle, {
      ...cas(planned),
      step: forwardStep(1, "conversation", "trash-staged"),
      updatedAt: 1_721_260_800_010
    });
    await assert.rejects(
      () => commitRecordMutationJournal(trashPrepared.handle, {
        ...cas(trashPrepared),
        committedAt: 1_721_260_800_020,
        message: "source not retired"
      }),
      (error: unknown) => hasCode(error, "journal_blocked")
    );
    const retired = await stageRecordMutationJournal(trashPrepared.handle, {
      ...cas(trashPrepared),
      step: forwardStep(2, "conversation", "source-retired"),
      updatedAt: 1_721_260_800_020
    });
    await assert.rejects(
      () => commitRecordMutationJournal(retired.handle, {
        ...cas(retired),
        committedAt: 1_721_260_800_030,
        message: "memory not staged"
      }),
      (error: unknown) => hasCode(error, "journal_blocked")
    );
    const memory = await stageRecordMutationJournal(retired.handle, {
      ...cas(retired),
      step: forwardStep(3, "memory", "participant-staged"),
      updatedAt: 1_721_260_800_030
    });
    assert.equal(
      (await commitRecordMutationJournal(memory.handle, {
        ...cas(memory),
        committedAt: 1_721_260_800_040,
        message: "all required participants staged"
      })).record.state,
      "committed"
    );
  });

  await withFixture("participant-gate-readback", async (storageRootPath) => {
    const planned = await createRecordMutationJournal({
      storageRootPath,
      mutationId: "mutation-participant-gate-readback",
      intent: intent(
        "conversation-participant-gate-readback",
        "delete-conversation"
      ),
      createdAt: 1_721_260_800_000
    });
    const staged = await stageRecordMutationJournal(planned.handle, {
      ...cas(planned),
      step: forwardStep(1, "conversation", "trash-staged"),
      updatedAt: 1_721_260_800_010
    });
    const incompleteTerminal = transitionRecordMutationRevision(
      staged.record,
      {
        state: "committed",
        step: null,
        terminal: {
          at: 1_721_260_800_020,
          code: "committed",
          message: "fixture bypassed journal terminal gate"
        },
        updatedAt: 1_721_260_800_020
      }
    );
    await writeFile(
      path.join(staged.handle.chainRootPath, "entry-0000000000000002.json"),
      `${JSON.stringify(incompleteTerminal, null, 2)}\n`,
      "utf8"
    );
    await assert.rejects(
      () => loadRecordMutationJournal(staged.handle),
      (error: unknown) => hasCode(error, "journal_corrupt")
    );
  });
}

async function assertPublishedRevisionRemainsSuccessfulAfterConcurrentAdvance(): Promise<void> {
  await withFixture("advanced-readback", async (storageRootPath) => {
    const planned = await createRecordMutationJournal({
      storageRootPath,
      mutationId: "mutation-advanced-readback",
      intent: intent("conversation-advanced-readback", "start-new-context"),
      createdAt: 1_721_260_800_000
    });
    let releaseFirst!: () => void;
    let publishedFirst!: () => void;
    const firstPublished = new Promise<void>((resolve) => {
      publishedFirst = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const writerOne = stageRecordMutationJournal(planned.handle, {
      ...cas(planned),
      step: forwardStep(1, "conversation", "prepared"),
      updatedAt: 1_721_260_800_010,
      async faultInjector(point) {
        if (point === "after-publish") {
          publishedFirst();
          await release;
        }
      }
    });
    await firstPublished;
    const revisionOne = await loadRecordMutationJournal(planned.handle);
    assert.equal(revisionOne.record.revision, 1);
    const revisionTwo = await stageRecordMutationJournal(revisionOne.handle, {
      ...cas(revisionOne),
      step: forwardStep(2, "memory", "prepared"),
      updatedAt: 1_721_260_800_020
    });
    releaseFirst();
    const writerOneResult = await writerOne;
    assert.equal(writerOneResult.chain[1]?.digest, revisionOne.record.digest);
    assert.equal(writerOneResult.record.digest, revisionTwo.record.digest);
  });
}

async function assertStaleCasCannotOverwriteWinner(): Promise<void> {
  await withFixture("stale-cas", async (storageRootPath) => {
    const planned = await createRecordMutationJournal({
      storageRootPath,
      mutationId: "mutation-stale-cas",
      intent: intent("conversation-stale-cas", "start-new-context"),
      createdAt: 1_721_260_800_000
    });
    const staged = await stageRecordMutationJournal(planned.handle, {
      ...cas(planned),
      step: forwardStep(1, "conversation", "prepared"),
      updatedAt: 1_721_260_800_010
    });

    await assert.rejects(
      () => stageRecordMutationJournal(staged.handle, {
        ...cas(planned),
        step: forwardStep(2, "memory", "prepared"),
        updatedAt: 1_721_260_800_020
      }),
      (error: unknown) => hasCode(error, "revision_conflict")
    );
    assert.equal(
      (await loadRecordMutationJournal(staged.handle)).record.digest,
      staged.record.digest
    );
  });
}

async function assertFullChainReadbackRejectsCorruptionAndUnknownEntries(): Promise<void> {
  await withFixture("corrupt-chain", async (storageRootPath) => {
    const planned = await createRecordMutationJournal({
      storageRootPath,
      mutationId: "mutation-corrupt-chain",
      intent: intent("conversation-corrupt-chain", "clear-conversation-records"),
      createdAt: 1_721_260_800_000
    });
    const staged = await stageRecordMutationJournal(planned.handle, {
      ...cas(planned),
      step: forwardStep(1, "conversation", "trash-staged"),
      updatedAt: 1_721_260_800_010
    });
    const entryZero = path.join(planned.handle.chainRootPath, "entry-0000000000000000.json");
    const value = JSON.parse(await readFile(entryZero, "utf8")) as Record<string, unknown>;
    value.extra = true;
    await writeFile(entryZero, `${JSON.stringify(value)}\n`, "utf8");
    await assert.rejects(
      () => loadRecordMutationJournal(staged.handle),
      (error: unknown) => hasCode(error, "journal_corrupt")
    );
  });

  await withFixture("missing-revision", async (storageRootPath) => {
    const planned = await createRecordMutationJournal({
      storageRootPath,
      mutationId: "mutation-missing-revision",
      intent: intent("conversation-missing-revision", "clear-conversation-records"),
      createdAt: 1_721_260_800_000
    });
    const staged = await stageRecordMutationJournal(planned.handle, {
      ...cas(planned),
      step: forwardStep(1, "conversation", "trash-staged"),
      updatedAt: 1_721_260_800_010
    });
    await unlink(staged.recordPath);
    await writeFile(
      path.join(staged.handle.chainRootPath, "entry-0000000000000002.json"),
      "{}\n",
      "utf8"
    );
    await assert.rejects(
      () => loadRecordMutationJournal(staged.handle),
      (error: unknown) => hasCode(error, "journal_corrupt")
    );
  });

  await withFixture("unknown-entry", async (storageRootPath) => {
    const planned = await createRecordMutationJournal({
      storageRootPath,
      mutationId: "mutation-unknown-entry",
      intent: intent("conversation-unknown-entry", "start-new-context"),
      createdAt: 1_721_260_800_000
    });
    await writeFile(path.join(planned.handle.chainRootPath, "notes.txt"), "unknown", "utf8");
    await assert.rejects(
      () => listRecordMutationJournals(storageRootPath),
      (error: unknown) => hasCode(error, "unsafe_entry")
    );
  });
}

async function assertFutureSchemaAndSymlinksFailClosed(): Promise<void> {
  await withFixture("future-schema", async (storageRootPath) => {
    const planned = await createRecordMutationJournal({
      storageRootPath,
      mutationId: "mutation-future-schema",
      intent: intent("conversation-future-schema", "reset-agent-cache"),
      createdAt: 1_721_260_800_000
    });
    const value = JSON.parse(await readFile(planned.recordPath, "utf8")) as Record<string, unknown>;
    value.schemaVersion = 2;
    await writeFile(planned.recordPath, `${JSON.stringify(value)}\n`, "utf8");
    await assert.rejects(
      () => loadRecordMutationJournal(planned.handle),
      (error: unknown) => hasCode(error, "journal_corrupt")
    );
  });

  await withFixture("symlink-entry", async (storageRootPath) => {
    const planned = await createRecordMutationJournal({
      storageRootPath,
      mutationId: "mutation-symlink-entry",
      intent: intent("conversation-symlink-entry", "start-new-context"),
      createdAt: 1_721_260_800_000
    });
    const external = path.join(storageRootPath, "external.json");
    await writeFile(external, await readFile(planned.recordPath));
    await unlink(planned.recordPath);
    await symlink(external, planned.recordPath);
    await assert.rejects(
      () => loadRecordMutationJournal(planned.handle),
      (error: unknown) => hasCode(error, "unsafe_entry")
    );
  });

  await withFixture("symlink-root", async (storageRootPath) => {
    const external = path.join(storageRootPath, "external");
    await mkdir(external);
    const linkedRoot = path.join(storageRootPath, "linked");
    await symlink(external, linkedRoot);
    await assert.rejects(
      () => createRecordMutationJournal({
        storageRootPath: linkedRoot,
        mutationId: "mutation-symlink-root",
        intent: intent("conversation-symlink-root", "start-new-context"),
        createdAt: 1_721_260_800_000
      }),
      (error: unknown) => (
        error instanceof RecordMutationJournalError
        && (error.code === "unsafe_entry" || error.code === "invalid_path")
      )
    );
  });
}

function intent(
  conversationId: string,
  operation: RecordMutationIntent["operation"]
): RecordMutationIntent {
  const destructive = operation === "clear-conversation-records"
    || operation === "delete-conversation";
  return {
    operation,
    conversationId,
    expectedConversationGeneration: 7,
    expectedConversationCommitId: "conversation-commit-7",
    participants: [
      {
        id: "conversation",
        recordKind: "conversation",
        action: destructive ? "stage" : "retain"
      },
      {
        id: "memory",
        recordKind: "memory",
        action: destructive ? "mark-source-deleted" : "retain"
      }
    ],
    rootBindings: destructive ? fixtureRecordMutationRootBindings() : [],
    trashPolicy: destructive ? "required" : "not-required"
  };
}

function forwardStep(
  ordinal: number,
  participantId: string,
  action: Extract<RecordMutationStep["action"],
    "prepared" | "trash-staged" | "source-retired" | "participant-staged">
): RecordMutationStep {
  return {
    direction: "forward",
    ordinal,
    participantId,
    action,
    evidenceDigest: `sha256:${String(ordinal).padStart(64, "0")}`
  };
}

function compensatingStep(
  ordinal: number,
  participantId: string,
  action: Extract<RecordMutationStep["action"],
    "compensation-prepared" | "trash-restored" | "participant-restored">
): RecordMutationStep {
  return {
    direction: "compensating",
    ordinal,
    participantId,
    action,
    evidenceDigest: `sha256:${String(ordinal + 10).padStart(64, "0")}`
  };
}

function cas(loaded: LoadedRecordMutationJournal): {
  expectedRevision: number;
  expectedDigest: string;
} {
  return {
    expectedRevision: loaded.record.revision,
    expectedDigest: loaded.record.digest
  };
}

function hasCode(
  error: unknown,
  code: RecordMutationJournalErrorCode
): boolean {
  return error instanceof RecordMutationJournalError && error.code === code;
}

async function withFixture(
  label: string,
  action: (storageRootPath: string) => Promise<void>
): Promise<void> {
  const rootPath = await mkdtemp(path.join(tmpdir(), `echoink-mutation-${label}-`));
  try {
    await action(rootPath);
  } finally {
    await rm(rootPath, { recursive: true, force: true });
  }
}
