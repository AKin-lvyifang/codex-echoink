import * as assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  abortRecordMutationJournal,
  commitRecordMutationJournal,
  createRecordMutationJournal,
  finalizeRecordMutationAbort,
  loadRecordMutationJournal,
  RecordMutationJournalError,
  RecordMutationJournalSimulatedCrash,
  stageRecordMutationJournal
} from "../../harness/lifecycle/record-mutation-journal";
import {
  decideRecordMutationRecovery,
  parseRecordMutationRecoveryEvidence,
  recoverFixtureRecordMutation
} from "../../harness/lifecycle/record-mutation-recovery";
import {
  finalizeRecordMutationTrash,
  stageRecordMutationTrash
} from "../../harness/lifecycle/record-mutation-trash";
import type {
  RecordMutationIntent,
  RecordMutationStep
} from "../../harness/lifecycle/record-mutation-contract";
import {
  fixtureRecordMutationRootBindings,
  fixtureRecordRootBindingRef
} from "./record-root-fixtures";

export async function runHarnessV2RecordMutationCrashRecoveryTests(): Promise<void> {
  await assertCrashReadbackShowsOnlyOldOrNewRevision();
  await assertRecoveryDecisionFailsClosedOnContradictoryEvidence();
  await assertRecoveryRejectsReceiptRootBindingOutsideIntent();
  await assertRecoveryCrossChecksTrashPolicyAndTerminalEvidence();
  await assertFixtureRecoveryCanRollForwardOrCompensate();
  await assertRestoreFailureLeavesOnlyCompensationPrepared();
}

async function assertRecoveryRejectsReceiptRootBindingOutsideIntent(): Promise<void> {
  await withFixture(
    "receipt-root-binding-mismatch",
    async ({ storageRootPath, sourceRootPath, trashRootPath }) => {
      await writeFile(path.join(sourceRootPath, "conversation.json"), "before\n");
      const receipt = await stageRecordMutationTrash({
        mutationId: "mutation-receipt-root-binding-mismatch",
        sourceRootPath,
        sourceRootBinding: fixtureRecordRootBindingRef(
          "conversation-store",
          "receipt-rebound"
        ),
        sourceRelativePath: "conversation.json",
        trashRootPath,
        trashRootBinding: fixtureRecordRootBindingRef("record-trash"),
        transfer: "move",
        stagedAt: 1_721_260_800_005
      });
      const planned = await createRecordMutationJournal({
        storageRootPath,
        mutationId: "mutation-receipt-root-binding-mismatch",
        intent: intent(
          "conversation-receipt-root-binding-mismatch",
          "delete-conversation"
        ),
        createdAt: 1_721_260_800_000
      });
      const staged = await stageRecordMutationJournal(planned.handle, {
        expectedRevision: planned.record.revision,
        expectedDigest: planned.record.digest,
        step: step("forward", 1, "conversation", "prepared"),
        updatedAt: 1_721_260_800_010
      });
      await assert.rejects(
        () => recoverFixtureRecordMutation({
          journal: staged,
          evidence: {
            schemaVersion: 1,
            kind: "record-mutation-recovery-evidence",
            mutationId: staged.record.mutationId,
            intentDigest: staged.record.intentDigest,
            rootBindings: staged.record.intent.rootBindings,
            localCommit: "before-target",
            trash: "recoverable"
          },
          compensation: {
            participantId: "conversation",
            receipt,
            sourceRootPath,
            sourceRootBinding: receipt.sourceRootBinding,
            trashRootPath,
            trashRootBinding: receipt.trashRootBinding
          },
          now: 1_721_260_800_020,
          fixtureOnly: true
        }),
        (error: unknown) => (
          error instanceof Error
          && error.message.includes("Root Binding 不在 intent 中")
        )
      );
      assert.equal(
        (await loadRecordMutationJournal(staged.handle)).record.state,
        "staged"
      );
    }
  );
}

async function assertCrashReadbackShowsOnlyOldOrNewRevision(): Promise<void> {
  await withFixture("crash", async ({ storageRootPath }) => {
    const planned = await createRecordMutationJournal({
      storageRootPath,
      mutationId: "mutation-crash",
      intent: intent("conversation-crash", "start-new-context"),
      createdAt: 1_721_260_800_000
    });
    const staged = await stageRecordMutationJournal(planned.handle, {
      expectedRevision: planned.record.revision,
      expectedDigest: planned.record.digest,
      step: step("forward", 1, "conversation"),
      updatedAt: 1_721_260_800_010
    });

    await assert.rejects(
      () => commitRecordMutationJournal(staged.handle, {
        expectedRevision: staged.record.revision,
        expectedDigest: staged.record.digest,
        committedAt: 1_721_260_800_020,
        message: "not published",
        faultInjector(point) {
          if (point === "after-staging-sync") {
            throw new RecordMutationJournalSimulatedCrash(point);
          }
        }
      }),
      RecordMutationJournalSimulatedCrash
    );
    assert.equal(
      (await loadRecordMutationJournal(staged.handle)).record.state,
      "staged"
    );

    await assert.rejects(
      () => commitRecordMutationJournal(staged.handle, {
        expectedRevision: staged.record.revision,
        expectedDigest: staged.record.digest,
        committedAt: 1_721_260_800_030,
        message: "published",
        faultInjector(point) {
          if (point === "after-publish") {
            throw new RecordMutationJournalSimulatedCrash(point);
          }
        }
      }),
      RecordMutationJournalSimulatedCrash
    );
    const afterPublish = await loadRecordMutationJournal(staged.handle);
    assert.equal(afterPublish.record.state, "committed");
    assert.equal(afterPublish.record.revision, staged.record.revision + 1);
  });
}

async function assertRecoveryDecisionFailsClosedOnContradictoryEvidence(): Promise<void> {
  await withFixture("decision", async ({ storageRootPath }) => {
    const planned = await createRecordMutationJournal({
      storageRootPath,
      mutationId: "mutation-decision",
      intent: intent("conversation-decision", "delete-conversation"),
      createdAt: 1_721_260_800_000
    });
    const staged = await stageRecordMutationJournal(planned.handle, {
      expectedRevision: planned.record.revision,
      expectedDigest: planned.record.digest,
      step: step("forward", 1, "conversation"),
      updatedAt: 1_721_260_800_010
    });
    const evidence = {
      schemaVersion: 1 as const,
      kind: "record-mutation-recovery-evidence" as const,
      mutationId: staged.record.mutationId,
      intentDigest: staged.record.intentDigest,
      rootBindings: staged.record.intent.rootBindings,
      localCommit: "contradictory" as const,
      trash: "recoverable" as const
    };
    assert.deepEqual(
      decideRecordMutationRecovery(staged.record, evidence),
      { action: "blocked", reason: "contradictory-local-commit" }
    );
    assert.deepEqual(
      decideRecordMutationRecovery(staged.record, {
        ...evidence,
        rootBindings: [
          fixtureRecordRootBindingRef("conversation-store", "rebound"),
          fixtureRecordRootBindingRef("record-trash")
        ]
      }),
      { action: "blocked", reason: "root-binding-mismatch" }
    );
    assert.deepEqual(parseRecordMutationRecoveryEvidence(evidence), evidence);
    assert.throws(
      () => parseRecordMutationRecoveryEvidence({ ...evidence, unknown: true })
    );
    assert.throws(
      () => parseRecordMutationRecoveryEvidence({ ...evidence, schemaVersion: 2 })
    );
  });
}

async function assertRecoveryCrossChecksTrashPolicyAndTerminalEvidence(): Promise<void> {
  await withFixture("policy-and-terminal", async ({ storageRootPath }) => {
    const destructivePlanned = await createRecordMutationJournal({
      storageRootPath,
      mutationId: "mutation-policy-destructive",
      intent: intent("conversation-policy-destructive", "delete-conversation"),
      createdAt: 1_721_260_800_000
    });
    const destructiveStaged = await stageRecordMutationJournal(
      destructivePlanned.handle,
      {
        expectedRevision: destructivePlanned.record.revision,
        expectedDigest: destructivePlanned.record.digest,
        step: step("forward", 1, "conversation", "prepared"),
        updatedAt: 1_721_260_800_010
      }
    );
    assert.deepEqual(
      decideRecordMutationRecovery(destructiveStaged.record, {
        schemaVersion: 1,
        kind: "record-mutation-recovery-evidence",
        mutationId: destructiveStaged.record.mutationId,
        intentDigest: destructiveStaged.record.intentDigest,
        rootBindings: destructiveStaged.record.intent.rootBindings,
        localCommit: "before-target",
        trash: "not-required"
      }),
      { action: "blocked", reason: "trash-policy-mismatch" }
    );

    const committedPlanned = await createRecordMutationJournal({
      storageRootPath,
      mutationId: "mutation-terminal-committed",
      intent: intent("conversation-terminal-committed", "start-new-context"),
      createdAt: 1_721_260_800_020
    });
    const committedStaged = await stageRecordMutationJournal(
      committedPlanned.handle,
      {
        expectedRevision: committedPlanned.record.revision,
        expectedDigest: committedPlanned.record.digest,
        step: step("forward", 1, "conversation", "prepared"),
        updatedAt: 1_721_260_800_030
      }
    );
    const committed = await commitRecordMutationJournal(committedStaged.handle, {
      expectedRevision: committedStaged.record.revision,
      expectedDigest: committedStaged.record.digest,
      committedAt: 1_721_260_800_040,
      message: "terminal evidence check"
    });
    assert.deepEqual(
      decideRecordMutationRecovery(committed.record, {
        schemaVersion: 1,
        kind: "record-mutation-recovery-evidence",
        mutationId: committed.record.mutationId,
        intentDigest: committed.record.intentDigest,
        rootBindings: committed.record.intent.rootBindings,
        localCommit: "before-target",
        trash: "not-required"
      }),
      { action: "blocked", reason: "terminal-evidence-conflict" }
    );

    const abortedPlanned = await createRecordMutationJournal({
      storageRootPath,
      mutationId: "mutation-terminal-aborted",
      intent: intent("conversation-terminal-aborted", "reset-agent-cache"),
      createdAt: 1_721_260_800_050
    });
    const abortedStaged = await stageRecordMutationJournal(abortedPlanned.handle, {
      expectedRevision: abortedPlanned.record.revision,
      expectedDigest: abortedPlanned.record.digest,
      step: step("forward", 1, "conversation", "prepared"),
      updatedAt: 1_721_260_800_060
    });
    const aborted = await abortRecordMutationJournal(abortedStaged.handle, {
      expectedRevision: abortedStaged.record.revision,
      expectedDigest: abortedStaged.record.digest,
      compensationSteps: [{
        direction: "compensating",
        ordinal: 1,
        participantId: "conversation",
        action: "compensation-prepared",
        evidenceDigest: abortedStaged.record.digest
      }],
      compensatingAt: 1_721_260_800_070,
      abortedAt: 1_721_260_800_080,
      code: "compensated",
      message: "terminal evidence check"
    });
    assert.deepEqual(
      decideRecordMutationRecovery(aborted.record, {
        schemaVersion: 1,
        kind: "record-mutation-recovery-evidence",
        mutationId: aborted.record.mutationId,
        intentDigest: aborted.record.intentDigest,
        rootBindings: aborted.record.intent.rootBindings,
        localCommit: "exact-target",
        trash: "not-required"
      }),
      { action: "blocked", reason: "terminal-evidence-conflict" }
    );
  });
}

async function assertFixtureRecoveryCanRollForwardOrCompensate(): Promise<void> {
  await withFixture("roll-forward", async ({ storageRootPath }) => {
    const planned = await createRecordMutationJournal({
      storageRootPath,
      mutationId: "mutation-roll-forward",
      intent: intent("conversation-roll-forward", "start-new-context"),
      createdAt: 1_721_260_800_000
    });
    const staged = await stageRecordMutationJournal(planned.handle, {
      expectedRevision: planned.record.revision,
      expectedDigest: planned.record.digest,
      step: step("forward", 1, "conversation"),
      updatedAt: 1_721_260_800_010
    });
    const recovered = await recoverFixtureRecordMutation({
      journal: staged,
      evidence: {
        schemaVersion: 1,
        kind: "record-mutation-recovery-evidence",
        mutationId: staged.record.mutationId,
        intentDigest: staged.record.intentDigest,
        rootBindings: staged.record.intent.rootBindings,
        localCommit: "exact-target",
        trash: "not-required"
      },
      now: 1_721_260_800_020,
      fixtureOnly: true
    });
    assert.equal(recovered.decision.action, "roll-forward");
    assert.equal(recovered.journal.record.state, "committed");
  });

  await withFixture(
    "compensate",
    async ({ storageRootPath, sourceRootPath, trashRootPath }) => {
      await writeFile(path.join(sourceRootPath, "conversation.json"), "before\n");
      const receipt = await stageRecordMutationTrash({
        mutationId: "mutation-compensate",
        sourceRootPath,
        sourceRootBinding: fixtureRecordRootBindingRef("conversation-store"),
        sourceRelativePath: "conversation.json",
        trashRootPath,
        trashRootBinding: fixtureRecordRootBindingRef("record-trash"),
        transfer: "move",
        stagedAt: 1_721_260_800_005
      });
      await finalizeRecordMutationTrash({
        receipt,
        sourceRootPath,
        sourceRootBinding: fixtureRecordRootBindingRef("conversation-store"),
        trashRootPath,
        trashRootBinding: fixtureRecordRootBindingRef("record-trash"),
        finalizedAt: 1_721_260_800_006
      });
      const planned = await createRecordMutationJournal({
        storageRootPath,
        mutationId: "mutation-compensate",
        intent: intent("conversation-compensate", "delete-conversation"),
        createdAt: 1_721_260_800_000
      });
      const trashStaged = await stageRecordMutationJournal(planned.handle, {
        expectedRevision: planned.record.revision,
        expectedDigest: planned.record.digest,
        step: {
          ...step("forward", 1, "conversation", "trash-staged"),
          evidenceDigest: receipt.digest
        },
        updatedAt: 1_721_260_800_010
      });
      const staged = await stageRecordMutationJournal(trashStaged.handle, {
        expectedRevision: trashStaged.record.revision,
        expectedDigest: trashStaged.record.digest,
        step: {
          ...step("forward", 2, "conversation", "source-retired"),
          evidenceDigest: receipt.digest
        },
        updatedAt: 1_721_260_800_011
      });

      const recovered = await recoverFixtureRecordMutation({
        journal: staged,
        evidence: {
          schemaVersion: 1,
          kind: "record-mutation-recovery-evidence",
          mutationId: staged.record.mutationId,
          intentDigest: staged.record.intentDigest,
          rootBindings: staged.record.intent.rootBindings,
          localCommit: "before-target",
          trash: "recoverable"
        },
        compensation: {
          participantId: "conversation",
          receipt,
          sourceRootPath,
          sourceRootBinding: fixtureRecordRootBindingRef("conversation-store"),
          trashRootPath,
          trashRootBinding: fixtureRecordRootBindingRef("record-trash")
        },
        now: 1_721_260_800_020,
        fixtureOnly: true
      });
      assert.equal(recovered.decision.action, "compensate");
      assert.equal(recovered.journal.record.state, "aborted");
      assert.equal(
        await readFile(path.join(sourceRootPath, "conversation.json"), "utf8"),
        "before\n"
      );
      assert.equal(
        await readFile(path.join(trashRootPath, receipt.locator.trashRelativePath), "utf8"),
        "before\n",
        "fixture compensation must preserve recoverable trash evidence"
      );
    }
  );
}

async function assertRestoreFailureLeavesOnlyCompensationPrepared(): Promise<void> {
  await withFixture(
    "compensation-order",
    async ({ storageRootPath, sourceRootPath, trashRootPath }) => {
      await writeFile(path.join(sourceRootPath, "conversation.json"), "before\n");
      const receipt = await stageRecordMutationTrash({
        mutationId: "mutation-compensation-order",
        sourceRootPath,
        sourceRootBinding: fixtureRecordRootBindingRef("conversation-store"),
        sourceRelativePath: "conversation.json",
        trashRootPath,
        trashRootBinding: fixtureRecordRootBindingRef("record-trash"),
        transfer: "move",
        stagedAt: 1_721_260_800_005
      });
      await finalizeRecordMutationTrash({
        receipt,
        sourceRootPath,
        sourceRootBinding: fixtureRecordRootBindingRef("conversation-store"),
        trashRootPath,
        trashRootBinding: fixtureRecordRootBindingRef("record-trash"),
        finalizedAt: 1_721_260_800_006
      });
      const planned = await createRecordMutationJournal({
        storageRootPath,
        mutationId: "mutation-compensation-order",
        intent: intent("conversation-compensation-order", "delete-conversation"),
        createdAt: 1_721_260_800_000
      });
      const trashStaged = await stageRecordMutationJournal(planned.handle, {
        expectedRevision: planned.record.revision,
        expectedDigest: planned.record.digest,
        step: {
          ...step("forward", 1, "conversation", "trash-staged"),
          evidenceDigest: receipt.digest
        },
        updatedAt: 1_721_260_800_010
      });
      const sourceRetired = await stageRecordMutationJournal(trashStaged.handle, {
        expectedRevision: trashStaged.record.revision,
        expectedDigest: trashStaged.record.digest,
        step: {
          ...step("forward", 2, "conversation", "source-retired"),
          evidenceDigest: receipt.digest
        },
        updatedAt: 1_721_260_800_011
      });
      const evidence = {
        schemaVersion: 1 as const,
        kind: "record-mutation-recovery-evidence" as const,
        mutationId: sourceRetired.record.mutationId,
        intentDigest: sourceRetired.record.intentDigest,
        rootBindings: sourceRetired.record.intent.rootBindings,
        localCommit: "before-target" as const,
        trash: "recoverable" as const
      };

      await assert.rejects(() => recoverFixtureRecordMutation({
        journal: sourceRetired,
        evidence,
        compensation: {
          participantId: "conversation",
          receipt,
          sourceRootPath,
          sourceRootBinding: fixtureRecordRootBindingRef("wrong-source-root"),
          trashRootPath,
          trashRootBinding: fixtureRecordRootBindingRef("record-trash")
        },
        now: 1_721_260_800_020,
        fixtureOnly: true
      }));

      const preparedOnly = await loadRecordMutationJournal(sourceRetired.handle);
      assert.equal(preparedOnly.record.state, "compensating");
      assert.deepEqual(
        preparedOnly.chain.flatMap((revision) => (
          revision.step?.direction === "compensating"
            ? [revision.step.action]
            : []
        )),
        ["compensation-prepared"]
      );
      await assert.rejects(
        () => finalizeRecordMutationAbort(preparedOnly.handle, {
          expectedRevision: preparedOnly.record.revision,
          expectedDigest: preparedOnly.record.digest,
          abortedAt: 1_721_260_800_030,
          code: "compensated",
          message: "must not claim restore before the effect succeeds"
        }),
        (error: unknown) => (
          error instanceof RecordMutationJournalError
          && error.code === "journal_blocked"
        )
      );

      const recovered = await recoverFixtureRecordMutation({
        journal: preparedOnly,
        evidence,
        compensation: {
          participantId: "conversation",
          receipt,
          sourceRootPath,
          sourceRootBinding: fixtureRecordRootBindingRef("conversation-store"),
          trashRootPath,
          trashRootBinding: fixtureRecordRootBindingRef("record-trash")
        },
        now: 1_721_260_800_040,
        fixtureOnly: true
      });
      assert.equal(recovered.journal.record.state, "aborted");
      assert.deepEqual(
        recovered.journal.chain.flatMap((revision) => (
          revision.step?.direction === "compensating"
            ? [revision.step.action]
            : []
        )),
        ["compensation-prepared", "trash-restored"]
      );
      assert.equal(
        await readFile(path.join(sourceRootPath, "conversation.json"), "utf8"),
        "before\n"
      );
    }
  );
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
    expectedConversationGeneration: 3,
    expectedConversationCommitId: "conversation-commit-3",
    participants: [{
      id: "conversation",
      recordKind: "conversation",
      action: destructive ? "stage" : "retain"
    }],
    rootBindings: destructive ? fixtureRecordMutationRootBindings() : [],
    trashPolicy: destructive ? "required" : "not-required"
  };
}

function step(
  direction: RecordMutationStep["direction"],
  ordinal: number,
  participantId: string,
  action: RecordMutationStep["action"] = (
    direction === "forward" ? "prepared" : "participant-restored"
  )
): RecordMutationStep {
  return {
    direction,
    ordinal,
    participantId,
    action,
    evidenceDigest: `sha256:${String(ordinal).padStart(64, "0")}`
  };
}

async function withFixture(
  label: string,
  action: (fixture: {
    rootPath: string;
    storageRootPath: string;
    sourceRootPath: string;
    trashRootPath: string;
  }) => Promise<void>
): Promise<void> {
  const rootPath = await mkdtemp(path.join(tmpdir(), `echoink-recovery-${label}-`));
  const storageRootPath = path.join(rootPath, "store");
  const sourceRootPath = path.join(rootPath, "source");
  const trashRootPath = path.join(rootPath, "trash");
  await mkdir(storageRootPath, { recursive: true, mode: 0o700 });
  await mkdir(sourceRootPath, { recursive: true, mode: 0o700 });
  await mkdir(trashRootPath, { recursive: true, mode: 0o700 });
  try {
    await action({ rootPath, storageRootPath, sourceRootPath, trashRootPath });
  } finally {
    await rm(rootPath, { recursive: true, force: true });
  }
}
