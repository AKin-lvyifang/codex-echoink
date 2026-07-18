import * as assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  utimes,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  MaintenanceWorkflowSimulatedCrash,
  MaintenanceWorkflowWalError,
  applyMaintenanceWorkflowManagedWrites,
  commitMaintenanceWorkflowSettingsDurably,
  confirmMaintenanceWorkflowNoop,
  confirmMaintenanceWorkflowShadowCommitted,
  createMaintenanceWorkflowNoopProof,
  finalizeMaintenanceWorkflowWal,
  listMaintenanceWorkflowWals,
  loadMaintenanceWorkflowWal,
  markMaintenanceWorkflowWalBlocked,
  mergeMaintenanceWorkflowSettings,
  prepareMaintenanceWorkflowWal,
  removeFinalizedMaintenanceWorkflowWal,
  snapshotMaintenanceWorkflowFileCas,
  type LoadedMaintenanceWorkflowWal,
  type MaintenanceWorkflowManagedUpsertDraft,
  type MaintenanceWorkflowSettingsHost,
  type MaintenanceWorkflowSettingsSnapshot,
  type MaintenanceWorkflowSettingsTransaction,
  type MaintenanceWorkflowWalErrorCode,
  type MaintenanceWorkflowWalIntentDraft,
  type PrepareMaintenanceWorkflowWalInput
} from "../../harness/maintenance/workflow-wal";
import type {
  KnowledgeBaseMaintenanceHistoryEntry,
  KnowledgeBaseProcessedSource
} from "../../settings/settings";
import type { KnowledgeRunAttemptRecord } from "../../knowledge-base/types";
import {
  RAW_DIGEST_REGISTRY_PATH,
  RAW_DIGEST_SCHEMA_VERSION,
  applyRawDigestFrontmatter,
  buildRawDigestRegistryContent,
  normalizeRawDigestRegistry,
  rawDigestFingerprint,
  type RawDigestRegistryEntry
} from "../../knowledge-base/raw-digest";
import {
  applyShadowChangeSet,
  cleanupMaintenanceShadowVault,
  confirmMaintenanceShadowTransportConfigFence,
  createMaintenanceShadowTransportConfigReceipt,
  createMaintenanceShadowVault,
  loadMaintenanceShadowChangeSet,
  maintenanceShadowExecutionBoundary,
  markMaintenanceShadowCommittedFromJournal,
  sealMaintenanceShadowVault
} from "../../harness/maintenance/shadow-vault";

interface FixtureSettings extends MaintenanceWorkflowSettingsSnapshot {
  unrelatedPreference: string;
}

interface WalFixture {
  rootPath: string;
  storageRootPath: string;
  vaultPath: string;
  reportPath: string;
  trackerPath: string;
  sourcePath: string;
  input: PrepareMaintenanceWorkflowWalInput;
  baselineSettings: FixtureSettings;
}

export async function runHarnessV2MaintenanceWorkflowWalTests(): Promise<void> {
  await assertPreparePublishesAtomicallyAndReplays();
  await assertLoadRejectsMissingAndTamperedControlState();
  await assertIntentAndBlobTamperingFailClosed();
  await assertRecoveredWinnerRequiresCompletedAttempt();
  await assertRawMetadataCannotChangeBody();
  await assertRawMetadataExactlyMatchesVerifiedRaw();
  await assertBinaryRawUsesRegistryWithoutMutation();
  await assertShadowReceiptMustMatchDurableJournal();
  await assertRealShadowCoreProducesCommitProof();
  await assertShadowJournalAndLiveCasAreRequired();
  await assertNoopUsesDedicatedProofGate();
  await assertProofGatedPhasesAndConcurrentBlocker();
  await assertManagedApplyPreflightsEveryTarget();
  await assertManagedParentSymlinkFailsClosed();
  await assertManagedDisplacementNeverClobbers();
  await assertManagedCrashReplayMatrix();
  await assertSettingsMergeUsesPerSourceThreeWayCas();
  await assertSettingsPlanRejectsUnverifiedChanges();
  await assertSettingsHistoryRequiresCanonicalRoundTrip();
  await assertScheduledSettingsProjectionIsAtomicAndRunBound();
  await assertSettingsCrashReplayAndManagedDriftBlock();
  await assertSettingsReadbackToPhaseFence();
  await assertFinalizeIsReplayableAndCleanupIsGated();
}

async function assertSettingsHistoryRequiresCanonicalRoundTrip(): Promise<void> {
  await withFixture("settings-history-canonical", async (fixture) => {
    const oversizedAttempt = structuredClone(fixture.input);
    const attempt = oversizedAttempt.draft.attempts[0];
    assert.ok(attempt?.terminal);
    attempt.terminal.message = "t".repeat(700);
    oversizedAttempt.draft.settings.targetTerminal.lastAttempts =
      structuredClone(oversizedAttempt.draft.attempts);
    oversizedAttempt.draft.settings.historyEntry.attempts =
      structuredClone(oversizedAttempt.draft.attempts);
    await rejectsWithWalCode(
      () => prepareMaintenanceWorkflowWal(oversizedAttempt),
      "intent_corrupt"
    );

    const excessiveWarnings = structuredClone(fixture.input);
    const warnings = Array.from({ length: 11 }, (_, index) => ({
      id: `warning-${index + 1}`,
      message: `warning ${index + 1}`
    }));
    excessiveWarnings.draft.warnings = structuredClone(warnings);
    excessiveWarnings.draft.settings.targetTerminal.lastWarnings =
      structuredClone(warnings);
    excessiveWarnings.draft.settings.historyEntry.warnings =
      structuredClone(warnings);
    await rejectsWithWalCode(
      () => prepareMaintenanceWorkflowWal(excessiveWarnings),
      "intent_corrupt"
    );

    const overlongPending = structuredClone(fixture.input);
    const pendingPath = `raw/${"p".repeat(1_100)}.md`;
    overlongPending.draft.completion = "partial";
    overlongPending.draft.pendingSources = [{
      source: {
        relativePath: pendingPath,
        size: 1,
        mtime: 1,
        fingerprint: "pending-fingerprint"
      },
      reason: {
        code: "pending-verification",
        message: "pending source is not yet verified"
      }
    }];
    overlongPending.draft.settings.targetTerminal.lastCompletion = "partial";
    overlongPending.draft.settings.targetTerminal.lastPendingSources = [
      pendingPath
    ];
    overlongPending.draft.settings.historyEntry.completion = "partial";
    overlongPending.draft.settings.historyEntry.pendingSources = [
      pendingPath
    ];
    await rejectsWithWalCode(
      () => prepareMaintenanceWorkflowWal(overlongPending),
      "intent_corrupt"
    );

    const duplicatePending = structuredClone(overlongPending);
    duplicatePending.draft.settings.targetTerminal.lastPendingSources = [
      pendingPath,
      pendingPath
    ];
    duplicatePending.draft.settings.historyEntry.pendingSources = [
      pendingPath,
      pendingPath
    ];
    await rejectsWithWalCode(
      () => prepareMaintenanceWorkflowWal(duplicatePending),
      "intent_corrupt"
    );
  });
}

async function assertPreparePublishesAtomicallyAndReplays(): Promise<void> {
  const points = [
    "after-staging-create",
    "after-blobs",
    "after-intent",
    "after-state",
    "after-publish"
  ] as const;
  for (const point of points) {
    await withFixture(`atomic-${point}`, async (fixture) => {
      await assert.rejects(
        () => prepareMaintenanceWorkflowWal({
          ...fixture.input,
          faultInjector(current) {
            if (current === point) throw new MaintenanceWorkflowSimulatedCrash(point);
          }
        }),
        MaintenanceWorkflowSimulatedCrash
      );
      const afterCrash = await listMaintenanceWorkflowWals(fixture.storageRootPath);
      assert.equal(
        afterCrash.length,
        point === "after-publish" ? 1 : 0,
        `${point} must not expose a half-published WAL`
      );
      const prepared = await prepareMaintenanceWorkflowWal(fixture.input);
      assert.equal(prepared.state.phase, "prepared");
      assert.equal((await listMaintenanceWorkflowWals(fixture.storageRootPath)).length, 1);
      const replay = await prepareMaintenanceWorkflowWal(fixture.input);
      assert.equal(replay.intent.digest, prepared.intent.digest);
    });
  }
}

async function assertLoadRejectsMissingAndTamperedControlState(): Promise<void> {
  await withFixture("missing-state", async (fixture) => {
    const prepared = await prepareMaintenanceWorkflowWal(fixture.input);
    await rm(prepared.handle.statePath);
    await rejectsWithWalCode(
      () => loadMaintenanceWorkflowWal(prepared.handle),
      "state_corrupt"
    );
    const listed = await listMaintenanceWorkflowWals(fixture.storageRootPath);
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.status, "invalid");
  });

  await withFixture("tampered-state", async (fixture) => {
    const prepared = await prepareMaintenanceWorkflowWal(fixture.input);
    const state = JSON.parse(await readFile(prepared.handle.statePath, "utf8"));
    state.phase = "settings_committed";
    await writeFile(prepared.handle.statePath, `${JSON.stringify(state)}\n`, "utf8");
    await rejectsWithWalCode(
      () => loadMaintenanceWorkflowWal(prepared.handle),
      "state_corrupt"
    );
  });
}

async function assertIntentAndBlobTamperingFailClosed(): Promise<void> {
  await withFixture("tampered-intent", async (fixture) => {
    const prepared = await prepareMaintenanceWorkflowWal(fixture.input);
    const intent = JSON.parse(await readFile(prepared.handle.intentPath, "utf8"));
    intent.summary = "tampered without digest";
    await writeFile(prepared.handle.intentPath, `${JSON.stringify(intent)}\n`, "utf8");
    await rejectsWithWalCode(
      () => loadMaintenanceWorkflowWal(prepared.handle),
      "intent_corrupt"
    );
  });

  await withFixture("tampered-blob", async (fixture) => {
    const prepared = await prepareMaintenanceWorkflowWal(fixture.input);
    const blobs = await readdir(prepared.handle.blobRootPath);
    assert.ok(blobs.length >= 2);
    await writeFile(path.join(prepared.handle.blobRootPath, blobs[0]), "tampered", "utf8");
    await rejectsWithWalCode(
      () => loadMaintenanceWorkflowWal(prepared.handle),
      "blob_corrupt"
    );
  });
}

async function assertRecoveredWinnerRequiresCompletedAttempt(): Promise<void> {
  await withFixture("recovered-winner-failed-attempt", async (fixture) => {
    const input = structuredClone(fixture.input);
    const attempt = input.draft.attempts[0];
    assert.ok(attempt);
    attempt.terminal = {
      status: "failed",
      at: 200
    };
    input.draft.completion = "recovered";
    input.draft.settings.targetTerminal.lastCompletion = "recovered";
    input.draft.settings.targetTerminal.lastAttempts = input.draft.attempts;
    input.draft.settings.historyEntry.completion = "recovered";
    input.draft.settings.historyEntry.attempts = input.draft.attempts;

    await rejectsWithWalCode(
      () => prepareMaintenanceWorkflowWal(input),
      "intent_corrupt"
    );
  });
}

async function assertRawMetadataCannotChangeBody(): Promise<void> {
  const userFrontmatter = [
    "---",
    "title: User title",
    "tags:",
    "  - stable",
    "aliases: [User Alias]",
    "---",
    "RAW-SOURCE",
    ""
  ].join("\n");
  const nestedManagedNameBaseline = Buffer.from([
    "---",
    "user:",
    "  已处理: false",
    "---",
    "RAW-SOURCE",
    ""
  ].join("\n"), "utf8");
  const nestedManagedNameApplied = applyRawDigestFrontmatter(
    nestedManagedNameBaseline,
    {
      rawPath: "raw/source.md",
      fingerprint: rawDigestFingerprint(
        "raw/source.md",
        nestedManagedNameBaseline
      ),
      size: nestedManagedNameBaseline.byteLength,
      mtime: 100,
      digestedAt: 100,
      runId: "raw-nested-preservation",
      reportPath: "outputs/maintenance/report.md",
      evidencePaths: ["wiki/topic.md"],
      confidence: "verified"
    }
  );
  assert.ok(
    nestedManagedNameApplied.includes(
      Buffer.from("user:\n  已处理: false\n", "utf8")
    ),
    "applyRawDigestFrontmatter must preserve nested user fields byte-for-byte"
  );
  const managedFrontmatter = [
    "---",
    "title: User title",
    "tags:",
    "  - stable",
    "aliases: [User Alias]",
    "已处理: true",
    "提炼状态: 已提炼",
    "提炼时间: 2026-07-18T00:00:00.000Z",
    "提炼指纹: source-fingerprint",
    "提炼报告: outputs/maintenance/report.md",
    "提炼证据:",
    "  - wiki/topic.md",
    "---",
    "RAW-SOURCE",
    ""
  ].join("\n");

  await withFixture("raw-metadata-proof", async (fixture) => {
    const rawMetadata = await createRawMetadataWriteForTest({
      vaultPath: fixture.vaultPath,
      relativePath: "raw/source.md",
      baselineContent: Buffer.from(userFrontmatter, "utf8"),
      workflowRunId: fixture.input.draft.workflowRunId,
      startedAt: fixture.input.draft.startedAt,
      reportPath: fixture.input.draft.report.relativePath,
      evidencePaths: fixture.input.draft.evidencePaths["raw/source.md"]
    });
    const boundInput = bindFixtureVerifiedRaw(
      fixture.input,
      rawMetadata
    );
    const rawRegistry = await createRawRegistryWriteForTest({
      vaultPath: fixture.vaultPath,
      startedAt: boundInput.draft.startedAt,
      entries: {
        "raw/source.md": {
          rawPath: "raw/source.md",
          fingerprint: rawMetadata.fingerprint,
          size: rawMetadata.desiredContent.byteLength,
          mtime: boundInput.draft.startedAt,
          digestedAt: boundInput.draft.startedAt,
          runId: boundInput.draft.workflowRunId,
          reportPath: boundInput.draft.report.relativePath,
          evidencePaths:
            boundInput.draft.evidencePaths["raw/source.md"],
          confidence: "verified"
        }
      }
    });
    const prepared = await prepareMaintenanceWorkflowWal({
      ...boundInput,
      managedWrites: [
        ...withoutRawDigestWrites(boundInput),
        rawMetadata.write,
        rawRegistry.write
      ]
    });
    const sealedRaw = prepared.intent.managedWrites.find(
      (write) => write.kind === "raw-metadata"
    );
    assert.match(sealedRaw?.rawBodyDigest ?? "", /^sha256:[a-f0-9]{64}$/);
    assert.match(
      sealedRaw?.rawUnmanagedFrontmatterDigest ?? "",
      /^sha256:[a-f0-9]{64}$/
    );
  });

  for (const [suffix, desiredContent] of [
    [
      "changed-body",
      managedFrontmatter.replace("RAW-SOURCE", "CHANGED-BODY")
    ],
    [
      "changed-title",
      managedFrontmatter.replace("title: User title", "title: Changed title")
    ],
    [
      "unknown-field",
      managedFrontmatter.replace(
        "已处理: true",
        "echoink_managed: true\n已处理: true"
      )
    ]
  ] as const) {
    await withFixture(`raw-${suffix}`, async (fixture) => {
      await writeFile(fixture.sourcePath, userFrontmatter, "utf8");
      const baseline = await readFile(fixture.sourcePath);
      const expected = await snapshotMaintenanceWorkflowFileCas(
        fixture.vaultPath,
        "raw/source.md"
      );
      await rejectsWithWalCode(
        () => prepareMaintenanceWorkflowWal({
          ...fixture.input,
          managedWrites: [
            ...withoutRawMetadataWrites(fixture.input),
            {
              kind: "raw-metadata",
              operation: "upsert",
              relativePath: "raw/source.md",
              expected,
              expectedContent: baseline,
              desiredContent: Buffer.from(desiredContent, "utf8"),
              desiredMode: 0o644
            }
          ]
        }),
        "intent_corrupt"
      );
    });
  }

  for (const [suffix, baselineContent, desiredContent] of [
    [
      "changed-nested-managed-name",
      [
        "---",
        "user:",
        "  已处理: false",
        "---",
        "RAW-SOURCE",
        ""
      ].join("\n"),
      [
        "---",
        "user:",
        "  已处理: true",
        "已处理: true",
        "---",
        "RAW-SOURCE",
        ""
      ].join("\n")
    ],
    [
      "changed-user-comment",
      [
        "---",
        "已处理: false",
        "# user-owned retention note",
        "---",
        "RAW-SOURCE",
        ""
      ].join("\n"),
      [
        "---",
        "已处理: true",
        "# changed retention note",
        "---",
        "RAW-SOURCE",
        ""
      ].join("\n")
    ]
  ] as const) {
    await withFixture(`raw-${suffix}`, async (fixture) => {
      await writeFile(fixture.sourcePath, baselineContent, "utf8");
      const baseline = await readFile(fixture.sourcePath);
      const expected = await snapshotMaintenanceWorkflowFileCas(
        fixture.vaultPath,
        "raw/source.md"
      );
      await rejectsWithWalCode(
        () => prepareMaintenanceWorkflowWal({
          ...fixture.input,
          managedWrites: [
            ...withoutRawMetadataWrites(fixture.input),
            {
              kind: "raw-metadata",
              operation: "upsert",
              relativePath: "raw/source.md",
              expected,
              expectedContent: baseline,
              desiredContent: Buffer.from(desiredContent, "utf8"),
              desiredMode: 0o644
            }
          ]
        }),
        "intent_corrupt"
      );
    });
  }

  await withFixture("raw-nested-managed-name-full-block", async (fixture) => {
    const rawMetadata = await createRawMetadataWriteForTest({
      vaultPath: fixture.vaultPath,
      relativePath: "raw/source.md",
      baselineContent: nestedManagedNameBaseline,
      workflowRunId: fixture.input.draft.workflowRunId,
      startedAt: fixture.input.draft.startedAt,
      reportPath: fixture.input.draft.report.relativePath,
      evidencePaths: fixture.input.draft.evidencePaths["raw/source.md"]
    });
    const desiredContent = Buffer.from(
      rawMetadata.desiredContent
        .toString("utf8")
        .replace("  已处理: false", "  已处理: true"),
      "utf8"
    );
    assert.ok(
      desiredContent.includes(Buffer.from("提炼状态: 已提炼", "utf8")),
      "nested-field tamper fixture must retain the complete managed block"
    );
    await assert.rejects(
      () => prepareMaintenanceWorkflowWal({
        ...fixture.input,
        managedWrites: [
          ...withoutRawMetadataWrites(fixture.input),
          {
            ...rawMetadata.write,
            desiredContent
          }
        ]
      }),
      (error: unknown) =>
        error instanceof MaintenanceWorkflowWalError
        && error.code === "intent_corrupt"
        && /用户 frontmatter/.test(error.message)
    );
  });

  await withFixture("raw-user-frontmatter-crlf-bytes", async (fixture) => {
    const baselineContent = Buffer.from(
      "---\r\ntitle: User title\r\n---\r\nRAW-SOURCE\r\n",
      "utf8"
    );
    const rawMetadata = await createRawMetadataWriteForTest({
      vaultPath: fixture.vaultPath,
      relativePath: "raw/source.md",
      baselineContent,
      workflowRunId: fixture.input.draft.workflowRunId,
      startedAt: fixture.input.draft.startedAt,
      reportPath: fixture.input.draft.report.relativePath,
      evidencePaths: fixture.input.draft.evidencePaths["raw/source.md"]
    });
    const body = Buffer.from("RAW-SOURCE\r\n", "utf8");
    const bodyOffset = rawMetadata.desiredContent.indexOf(body);
    assert.ok(bodyOffset > 0);
    const normalizedFrontmatter = Buffer.from(
      rawMetadata.desiredContent
        .subarray(0, bodyOffset)
        .toString("utf8")
        .replace(/\r\n/g, "\n"),
      "utf8"
    );
    await rejectsWithWalCode(
      () => prepareMaintenanceWorkflowWal({
        ...fixture.input,
        managedWrites: [
          ...withoutRawMetadataWrites(fixture.input),
          {
            ...rawMetadata.write,
            desiredContent: Buffer.concat([
              normalizedFrontmatter,
              body
            ])
          }
        ]
      }),
      "intent_corrupt"
    );
  });

  await withFixture("raw-user-frontmatter-invalid-utf8", async (fixture) => {
    const baselineContent = Buffer.concat([
      Buffer.from("---\ntitle: ", "utf8"),
      Buffer.from([0xff]),
      Buffer.from("\n---\nRAW-SOURCE\n", "utf8")
    ]);
    const rawMetadata = await createRawMetadataWriteForTest({
      vaultPath: fixture.vaultPath,
      relativePath: "raw/source.md",
      baselineContent,
      workflowRunId: fixture.input.draft.workflowRunId,
      startedAt: fixture.input.draft.startedAt,
      reportPath: fixture.input.draft.report.relativePath,
      evidencePaths: fixture.input.draft.evidencePaths["raw/source.md"]
    });
    const desiredContent = Buffer.from(rawMetadata.desiredContent);
    const invalidByteOffset = desiredContent.indexOf(0xff);
    assert.ok(invalidByteOffset >= 0);
    desiredContent[invalidByteOffset] = 0xfe;
    await rejectsWithWalCode(
      () => prepareMaintenanceWorkflowWal({
        ...fixture.input,
        managedWrites: [
          ...withoutRawMetadataWrites(fixture.input),
          {
            ...rawMetadata.write,
            desiredContent
          }
        ]
      }),
      "intent_corrupt"
    );
  });
}

async function assertRawMetadataExactlyMatchesVerifiedRaw(): Promise<void> {
  await withFixture("raw-metadata-missing", async (fixture) => {
    await rejectsWithWalCode(
      () => prepareMaintenanceWorkflowWal({
        ...fixture.input,
        managedWrites: withoutRawMetadataWrites(fixture.input)
      }),
      "intent_corrupt"
    );
  });

  await withFixture("raw-metadata-duplicate", async (fixture) => {
    const rawMetadata = fixture.input.managedWrites.find(
      (write) => write.kind === "raw-metadata"
    );
    assert.ok(rawMetadata);
    await rejectsWithWalCode(
      () => prepareMaintenanceWorkflowWal({
        ...fixture.input,
        managedWrites: [
          ...fixture.input.managedWrites,
          rawMetadata
        ]
      }),
      "intent_corrupt"
    );
  });

  await withFixture("raw-metadata-extra", async (fixture) => {
    const extra = await createRawMetadataWriteForTest({
      vaultPath: fixture.vaultPath,
      relativePath: "raw/extra.md",
      baselineContent: Buffer.from("EXTRA-RAW\n", "utf8"),
      workflowRunId: fixture.input.draft.workflowRunId,
      startedAt: fixture.input.draft.startedAt,
      reportPath: fixture.input.draft.report.relativePath,
      evidencePaths: ["wiki/topic.md"]
    });
    await rejectsWithWalCode(
      () => prepareMaintenanceWorkflowWal({
        ...fixture.input,
        managedWrites: [
          ...fixture.input.managedWrites,
          extra.write
        ]
      }),
      "intent_corrupt"
    );
  });

  await withFixture("raw-metadata-path-mismatch", async (fixture) => {
    const mismatched = await createRawMetadataWriteForTest({
      vaultPath: fixture.vaultPath,
      relativePath: "raw/other.md",
      baselineContent: Buffer.from("OTHER-RAW\n", "utf8"),
      workflowRunId: fixture.input.draft.workflowRunId,
      startedAt: fixture.input.draft.startedAt,
      reportPath: fixture.input.draft.report.relativePath,
      evidencePaths: ["wiki/topic.md"]
    });
    await rejectsWithWalCode(
      () => prepareMaintenanceWorkflowWal({
        ...fixture.input,
        managedWrites: [
          ...withoutRawMetadataWrites(fixture.input),
          mismatched.write
        ]
      }),
      "intent_corrupt"
    );
  });

  await withFixture("raw-metadata-non-digest-mode", async (fixture) => {
    await rejectsWithWalCode(
      () => prepareMaintenanceWorkflowWal({
        ...fixture.input,
        draft: {
          ...fixture.input.draft,
          mode: "outputs",
          settings: {
            ...fixture.input.draft.settings,
            historyEntry: {
              ...fixture.input.draft.settings.historyEntry,
              mode: "outputs"
            }
          }
        }
      }),
      "intent_corrupt"
    );

  });
}

async function assertBinaryRawUsesRegistryWithoutMutation(): Promise<void> {
  await withFixture("binary-raw-commit", async (fixture) => {
    const binary = await createBinaryRawWorkflowInput(fixture);
    const before = await lstat(binary.absolutePath);
    const prepared = await prepareMaintenanceWorkflowWal(binary.input);
    await confirmShadow(prepared, fixture.vaultPath);
    await applyMaintenanceWorkflowManagedWrites(
      prepared.handle,
      fixture.vaultPath
    );
    const store: MutableSettingsStore<FixtureSettings> = {
      settings: structuredClone(fixture.baselineSettings),
      generation: 1
    };
    const settingsHost = createSettingsHost(store);
    await commitMaintenanceWorkflowSettingsDurably(
      prepared.handle,
      fixture.vaultPath,
      settingsHost
    );
    await finalizeMaintenanceWorkflowWal(
      prepared.handle,
      fixture.vaultPath,
      async (intent) => {
        assert.ok(intent.shadow);
        await cleanupMaintenanceShadowVault(
          shadowHandleFromIntentForTest(intent)
        );
      },
      { settingsHost }
    );

    assert.equal(
      (await readFile(binary.absolutePath)).equals(binary.content),
      true,
      "binary Raw bytes must not change"
    );
    const after = await lstat(binary.absolutePath);
    assert.equal(after.mode & 0o777, before.mode & 0o777);
    assert.equal(after.mtimeMs, before.mtimeMs);
    assert.equal(after.size, before.size);
    const registry = normalizeRawDigestRegistry(JSON.parse(
      await readFile(
        path.join(fixture.vaultPath, RAW_DIGEST_REGISTRY_PATH),
        "utf8"
      )
    ));
    assert.deepEqual(
      registry.entries[binary.relativePath],
      binary.registryEntry
    );
    assert.deepEqual(
      store.settings.processedSources[binary.relativePath],
      binary.processed
    );
  });

  await withFixture("binary-raw-missing-registry", async (fixture) => {
    const binary = await createBinaryRawWorkflowInput(fixture);
    await rejectsWithWalCode(
      () => prepareMaintenanceWorkflowWal({
        ...binary.input,
        managedWrites: binary.input.managedWrites.filter(
          (write) => write.kind !== "raw-registry"
        )
      }),
      "intent_corrupt"
    );
  });

  await withFixture("binary-raw-wrong-fingerprint", async (fixture) => {
    const binary = await createBinaryRawWorkflowInput(fixture);
    const wrongRegistry = await createRawRegistryWriteForTest({
      vaultPath: fixture.vaultPath,
      startedAt: binary.input.draft.startedAt,
      entries: {
        [binary.relativePath]: {
          ...binary.registryEntry,
          fingerprint: `${binary.registryEntry.fingerprint}-wrong`
        }
      }
    });
    await rejectsWithWalCode(
      () => prepareMaintenanceWorkflowWal({
        ...binary.input,
        managedWrites: [
          ...binary.input.managedWrites.filter(
            (write) => write.kind !== "raw-registry"
          ),
          wrongRegistry.write
        ]
      }),
      "intent_corrupt"
    );
  });

  await withFixture("binary-raw-extra-processed", async (fixture) => {
    const binary = await createBinaryRawWorkflowInput(fixture);
    await rejectsWithWalCode(
      () => prepareMaintenanceWorkflowWal({
        ...binary.input,
        draft: {
          ...binary.input.draft,
          settings: {
            ...binary.input.draft.settings,
            targetProcessedSources: {
              ...binary.input.draft.settings.targetProcessedSources,
              "raw/extra.pdf": {
                ...binary.processed,
                path: "raw/extra.pdf"
              }
            }
          }
        }
      }),
      "intent_corrupt"
    );
  });
}

async function assertShadowReceiptMustMatchDurableJournal(): Promise<void> {
  await withFixture("shadow-receipt", async (fixture) => {
    const prepared = await prepareMaintenanceWorkflowWal(fixture.input);
    await writeShadowCommitProof(prepared, fixture.vaultPath);
    const journalPath = path.join(
      requireShadow(prepared).controlRootPath,
      "apply-journal/journal.json"
    );
    const validJournalText = await readFile(journalPath, "utf8");
    const tamperedJournal = JSON.parse(validJournalText);
    tamperedJournal.entries[0].change.size += 1;
    await writeFile(journalPath, `${JSON.stringify(tamperedJournal)}\n`, "utf8");
    await rejectsWithWalCode(
      () => confirmMaintenanceWorkflowShadowCommitted(prepared.handle, fixture.vaultPath, {
        changeSetDigest: requireShadow(prepared).changeSetDigest,
        selectionDigest: requireShadow(prepared).selectionDigest,
        appliedPaths: requireShadow(prepared).expectedAppliedPaths
      }),
      "phase_conflict"
    );
    await writeFile(journalPath, validJournalText, "utf8");
    const safetyFieldMutations: Array<{
      label: string;
      mutate(journal: any): void;
    }> = [
      {
        label: "expectedLiveIdentity",
        mutate(journal) {
          delete journal.entries[0].change.expectedLiveIdentity;
        }
      },
      {
        label: "expectedParentChain",
        mutate(journal) {
          journal.entries[0].change.expectedParentChain = [];
        }
      },
      {
        label: "expectedMissingParentPath",
        mutate(journal) {
          journal.entries[0].change.expectedMissingParentPath = "wiki";
        }
      }
    ];
    for (const mutation of safetyFieldMutations) {
      const mutated = JSON.parse(validJournalText);
      mutation.mutate(mutated);
      const { digest: _digest, ...withoutDigest } = mutated;
      mutated.digest = digestForTest(withoutDigest);
      await writeFile(
        journalPath,
        `${JSON.stringify(mutated)}\n`,
        "utf8"
      );
      await rejectsWithWalCode(
        () => confirmMaintenanceWorkflowShadowCommitted(
          prepared.handle,
          fixture.vaultPath,
          {
            changeSetDigest: requireShadow(prepared).changeSetDigest,
            selectionDigest: requireShadow(prepared).selectionDigest,
            appliedPaths: requireShadow(prepared).expectedAppliedPaths
          }
        ),
        "phase_conflict"
      );
      await writeFile(journalPath, validJournalText, "utf8");
      assert.equal(
        (await loadMaintenanceWorkflowWal(prepared.handle)).state.phase,
        "prepared",
        `${mutation.label} tamper must not advance the WAL`
      );
    }
    const confirmed = await confirmMaintenanceWorkflowShadowCommitted(
      prepared.handle,
      fixture.vaultPath,
      {
        changeSetDigest: requireShadow(prepared).changeSetDigest,
        selectionDigest: requireShadow(prepared).selectionDigest,
        appliedPaths: requireShadow(prepared).expectedAppliedPaths
      }
    );
    assert.equal(confirmed.phase, "shadow_committed");
  });
}

async function assertShadowJournalAndLiveCasAreRequired(): Promise<void> {
  await withFixture("shadow-empty-journal", async (fixture) => {
    const prepared = await prepareMaintenanceWorkflowWal(fixture.input);
    await writeShadowCommitProof(
      prepared,
      fixture.vaultPath,
      { entries: "empty" }
    );
    const shadow = requireShadow(prepared);
    await rejectsWithWalCode(
      () => confirmMaintenanceWorkflowShadowCommitted(
        prepared.handle,
        fixture.vaultPath,
        {
          changeSetDigest: shadow.changeSetDigest,
          selectionDigest: shadow.selectionDigest,
          appliedPaths: shadow.expectedAppliedPaths
        }
      ),
      "phase_conflict"
    );
  });

  await withFixture("shadow-missing-live", async (fixture) => {
    const prepared = await prepareMaintenanceWorkflowWal(fixture.input);
    await writeShadowCommitProof(
      prepared,
      fixture.vaultPath,
      { writeLiveTarget: false }
    );
    const shadow = requireShadow(prepared);
    await rejectsWithWalCode(
      () => confirmMaintenanceWorkflowShadowCommitted(
        prepared.handle,
        fixture.vaultPath,
        {
          changeSetDigest: shadow.changeSetDigest,
          selectionDigest: shadow.selectionDigest,
          appliedPaths: shadow.expectedAppliedPaths
        }
      ),
      "managed_cas_conflict"
    );
  });

  await withFixture("shadow-live-drift", async (fixture) => {
    const prepared = await prepareMaintenanceWorkflowWal(fixture.input);
    await writeShadowCommitProof(prepared, fixture.vaultPath);
    const shadow = requireShadow(prepared);
    await writeFile(
      path.join(fixture.vaultPath, shadow.expectedAppliedPaths[0]),
      "CONCURRENT-WIKI\n",
      "utf8"
    );
    await rejectsWithWalCode(
      () => confirmMaintenanceWorkflowShadowCommitted(
        prepared.handle,
        fixture.vaultPath,
        {
          changeSetDigest: shadow.changeSetDigest,
          selectionDigest: shadow.selectionDigest,
          appliedPaths: shadow.expectedAppliedPaths
        }
      ),
      "managed_cas_conflict"
    );
  });
}

async function assertNoopUsesDedicatedProofGate(): Promise<void> {
  await withFixture("noop", async (fixture) => {
    // Use a filesystem-representable timestamp so this test can restore the
    // exact CAS metadata after exercising same-length content drift.
    await utimes(fixture.sourcePath, 1_700_000_000, 1_700_000_000);
    const content = await readFile(fixture.sourcePath);
    const sourceStat = await stat(fixture.sourcePath);
    const sourceRecord = {
      relativePath: "raw/source.md",
      size: content.byteLength,
      mtime: sourceStat.mtimeMs,
      fingerprint: rawDigestFingerprint("raw/source.md", content)
    };
    const proof = await createMaintenanceWorkflowNoopProof({
      liveVaultPath: fixture.vaultPath,
      discoveredSources: [sourceRecord],
      changedSources: []
    });
    const existingProcessed: KnowledgeBaseProcessedSource = {
      path: sourceRecord.relativePath,
      size: sourceRecord.size,
      mtime: sourceRecord.mtime,
      fingerprint: sourceRecord.fingerprint,
      digestedAt: 50,
      reportPath: "outputs/maintenance/previous.md",
      evidencePaths: ["wiki/previous.md"],
      runId: "previous-run",
      confidence: "verified"
    };
    const targetTerminal = {
      ...fixture.input.draft.settings.targetTerminal,
      lastSummary: "maintenance noop",
      lastCompletion: "noop" as const,
      lastAttempts: []
    };
    const noopInput: PrepareMaintenanceWorkflowWalInput = {
      ...fixture.input,
      managedWrites: withoutRawDigestWrites(fixture.input),
      draft: {
        ...fixture.input.draft,
        winner: null,
        completion: "noop",
        attempts: [],
        verifiedSources: [],
        pendingSources: [],
        evidencePaths: {},
        summary: "maintenance noop",
        shadow: null,
        noopProof: proof,
        indexReconciliation: {
          committed: [],
          deferred: [],
          warnings: []
        },
        settings: {
          baselineProcessedSources: {
            [sourceRecord.relativePath]: existingProcessed
          },
          targetProcessedSources: {
            [sourceRecord.relativePath]: existingProcessed
          },
          removedProcessedSourcePaths: [],
          baselineTerminal: fixture.input.draft.settings.baselineTerminal,
          targetTerminal,
          historyEntry: {
            ...fixture.input.draft.settings.historyEntry,
            completion: "noop",
            winnerBackend: null,
            attempts: []
          },
          scheduled: null
        }
      }
    };
    const prepared = await prepareMaintenanceWorkflowWal(noopInput);
    assert.equal(prepared.intent.winner, null);
    assert.equal(prepared.intent.shadow, null);
    await rejectsWithWalCode(
      () => confirmMaintenanceWorkflowShadowCommitted(
        prepared.handle,
        fixture.vaultPath,
        {
          changeSetDigest: sha256Text("none"),
          selectionDigest: sha256Text("none"),
          appliedPaths: []
        }
      ),
      "phase_conflict"
    );
    const sameLengthDrift = Buffer.from(content);
    sameLengthDrift[0] = sameLengthDrift[0] === 0x52 ? 0x58 : 0x52;
    await writeFile(fixture.sourcePath, sameLengthDrift);
    await utimes(
      fixture.sourcePath,
      sourceStat.atime,
      new Date(sourceStat.mtimeMs)
    );
    await rejectsWithWalCode(
      () => confirmMaintenanceWorkflowNoop(
        prepared.handle,
        fixture.vaultPath,
        proof
      ),
      "managed_cas_conflict"
    );
    await writeFile(fixture.sourcePath, content);
    await utimes(
      fixture.sourcePath,
      sourceStat.atime,
      new Date(sourceStat.mtimeMs)
    );
    const confirmed = await confirmMaintenanceWorkflowNoop(
      prepared.handle,
      fixture.vaultPath,
      proof
    );
    assert.equal(confirmed.phase, "shadow_committed");
    await applyMaintenanceWorkflowManagedWrites(
      prepared.handle,
      fixture.vaultPath
    );
    const store: MutableSettingsStore<FixtureSettings> = {
      settings: {
        ...structuredClone(fixture.baselineSettings),
        processedSources: {
          [sourceRecord.relativePath]: existingProcessed
        }
      },
      generation: 1
    };
    const settingsHost = createSettingsHost(store);
    await commitMaintenanceWorkflowSettingsDurably(
      prepared.handle,
      fixture.vaultPath,
      settingsHost
    );
    let cleanupCalls = 0;
    const finalized = await finalizeMaintenanceWorkflowWal(
      prepared.handle,
      fixture.vaultPath,
      () => {
        cleanupCalls += 1;
      },
      { settingsHost }
    );
    assert.equal(finalized.phase, "finalized");
    assert.equal(cleanupCalls, 0, "noop must not fabricate Shadow cleanup");
  });
}

async function assertRealShadowCoreProducesCommitProof(): Promise<void> {
  await withFixture("real-shadow-core", async (fixture) => {
    const winner = fixture.input.draft.winner;
    assert.ok(winner);
    const shadow = fixture.input.draft.shadow;
    assert.ok(shadow);
    const shadowHandle = {
      attemptId: winner.attemptId,
      rootPath: shadow.controlRootPath,
      agentVaultPath: path.join(shadow.controlRootPath, "vault"),
      manifestPath: path.join(shadow.controlRootPath, "manifest.json")
    };
    const changeSet = await loadMaintenanceShadowChangeSet(shadowHandle);
    assert.deepEqual(
      changeSet.changes.map((change) => change.relativePath),
      ["wiki/topic.md"]
    );
    const shadowRelativePath = "wiki/topic.md";
    const selectionOrder = changeSet.changes.map(
      (change) => change.relativePath
    );
    const expectedAppliedPaths = [...selectionOrder].sort();
    const selectionDigest = shadow.selectionDigest;
    const prepared = await prepareMaintenanceWorkflowWal(fixture.input);

    assert.equal(prepared.state.phase, "prepared");
    assert.equal(prepared.state.shadowCommitProof, undefined);
    assert.equal(
      await readFile(
        path.join(fixture.vaultPath, shadowRelativePath),
        "utf8"
      ),
      "WIKI-BASELINE\n"
    );

    const applied = await applyShadowChangeSet(
      fixture.vaultPath,
      changeSet,
      { allowPaths: expectedAppliedPaths }
    );
    assert.deepEqual(applied.appliedPaths, expectedAppliedPaths);
    assert.equal(
      await readFile(
        path.join(fixture.vaultPath, shadowRelativePath),
        "utf8"
      ),
      "WIKI-FINAL\n"
    );
    const beforeConfirm = await loadMaintenanceWorkflowWal(prepared.handle);
    assert.equal(beforeConfirm.state.phase, "prepared");
    assert.equal(beforeConfirm.state.shadowCommitProof, undefined);

    const journal = JSON.parse(await readFile(
      path.join(changeSet.controlRootPath, "apply-journal", "journal.json"),
      "utf8"
    )) as {
      digest: string;
      attemptId: string;
      liveVaultFingerprint: string;
      changeSetDigest: string;
      selectionDigest: string;
      selectedPaths: string[];
      state: "committed";
    };
    const confirmed = await confirmMaintenanceWorkflowShadowCommitted(
      prepared.handle,
      fixture.vaultPath,
      {
        changeSetDigest: changeSet.digest,
        selectionDigest,
        appliedPaths: applied.appliedPaths
      }
    );
    assert.equal(confirmed.phase, "shadow_committed");
    assert.equal(
      confirmed.shadowCommitProof?.applyJournalDigest,
      journal.digest
    );
    assert.equal(
      confirmed.shadowCommitProof?.commitReceipt,
      digestForTest({
        journalDigest: journal.digest,
        attemptId: journal.attemptId,
        liveVaultFingerprint: journal.liveVaultFingerprint,
        changeSetDigest: journal.changeSetDigest,
        selectionDigest: journal.selectionDigest,
        selectedPaths: [...journal.selectedPaths].sort(),
        state: journal.state
      })
    );
    assert.deepEqual(
      confirmed.shadowCommitProof?.liveTargets.map((target) =>
        target.relativePath
      ),
      expectedAppliedPaths
    );
    assert.equal(
      confirmed.shadowCommitProof?.liveTargets[0]?.result.kind,
      "file"
    );

    await applyMaintenanceWorkflowManagedWrites(
      prepared.handle,
      fixture.vaultPath
    );
    const store: MutableSettingsStore<FixtureSettings> = {
      settings: structuredClone(fixture.baselineSettings),
      generation: 1
    };
    const settingsHost = createSettingsHost(store);
    await commitMaintenanceWorkflowSettingsDurably(
      prepared.handle,
      fixture.vaultPath,
      settingsHost
    );
    let crashAfterTerminal = true;
    const replayedShadowHandle = {
      attemptId: shadowHandle.attemptId,
      rootPath: shadowHandle.rootPath,
      agentVaultPath: shadowHandle.agentVaultPath,
      manifestPath: shadowHandle.manifestPath
    };
    await assert.rejects(
      () => finalizeMaintenanceWorkflowWal(
        prepared.handle,
        fixture.vaultPath,
        async () => {
          await markMaintenanceShadowCommittedFromJournal(
            replayedShadowHandle,
            fixture.vaultPath
          );
          if (crashAfterTerminal) {
            crashAfterTerminal = false;
            throw new MaintenanceWorkflowSimulatedCrash(
              "crash after durable Shadow terminal"
            );
          }
          await cleanupMaintenanceShadowVault(replayedShadowHandle);
        },
        { settingsHost }
      ),
      MaintenanceWorkflowSimulatedCrash
    );
    const afterTerminalCrash = await loadMaintenanceWorkflowWal(
      prepared.handle
    );
    assert.equal(afterTerminalCrash.state.phase, "settings_committed");
    assert.equal((await lstat(shadowHandle.rootPath)).isDirectory(), true);

    const finalized = await finalizeMaintenanceWorkflowWal(
      prepared.handle,
      fixture.vaultPath,
      async () => {
        await markMaintenanceShadowCommittedFromJournal(
          { ...replayedShadowHandle },
          fixture.vaultPath
        );
        await cleanupMaintenanceShadowVault({ ...replayedShadowHandle });
      },
      { settingsHost }
    );
    assert.equal(finalized.phase, "finalized");
    await assert.rejects(
      () => lstat(shadowHandle.rootPath),
      (error: NodeJS.ErrnoException) => error.code === "ENOENT"
    );
  });
}

async function assertProofGatedPhasesAndConcurrentBlocker(): Promise<void> {
  await withFixture("proof-gates", async (fixture) => {
    const prepared = await prepareMaintenanceWorkflowWal(fixture.input);
    await rejectsWithWalCode(
      () => applyMaintenanceWorkflowManagedWrites(
        prepared.handle,
        fixture.vaultPath
      ),
      "phase_conflict"
    );
    await rejectsWithWalCode(
      () => finalizeMaintenanceWorkflowWal(
        prepared.handle,
        fixture.vaultPath,
        () => undefined
      ),
      "phase_conflict"
    );

    const outcomes = await Promise.allSettled([
      confirmShadow(prepared, fixture.vaultPath),
      markMaintenanceWorkflowWalBlocked(prepared.handle, {
        code: "concurrent-review",
        message: "concurrent blocker must not be lost"
      })
    ]);
    assert.ok(outcomes.some((outcome) => outcome.status === "fulfilled"));
    const loaded = await loadMaintenanceWorkflowWal(prepared.handle);
    assert.equal(loaded.state.blocked?.code, "concurrent-review");
    assert.ok(
      loaded.state.phase === "prepared"
      || loaded.state.phase === "shadow_committed"
    );
  });
}

async function assertManagedApplyPreflightsEveryTarget(): Promise<void> {
  await withFixture("managed-preflight", async (fixture) => {
    const prepared = await prepareMaintenanceWorkflowWal(fixture.input);
    await confirmShadow(prepared, fixture.vaultPath);
    const originalReport = await readFile(fixture.reportPath, "utf8");
    await writeFile(fixture.trackerPath, "CONCURRENT-TRACKER\n", "utf8");

    await rejectsWithWalCode(
      () => applyMaintenanceWorkflowManagedWrites(
        prepared.handle,
        fixture.vaultPath
      ),
      "managed_cas_conflict"
    );
    assert.equal(await readFile(fixture.reportPath, "utf8"), originalReport);
    const blocked = await loadMaintenanceWorkflowWal(prepared.handle);
    assert.equal(blocked.state.blocked?.code, "managed_cas_conflict");

    await rejectsWithWalCode(
      () => applyMaintenanceWorkflowManagedWrites(
        prepared.handle,
        fixture.vaultPath,
        {
          resumeBlocked: {
            stateSequence: blocked.state.sequence,
            stateDigest: blocked.state.digest
          }
        }
      ),
      "managed_cas_conflict"
    );
    assert.equal(await readFile(fixture.trackerPath, "utf8"), "CONCURRENT-TRACKER\n");
  });
}

async function assertManagedParentSymlinkFailsClosed(): Promise<void> {
  await withFixture("managed-parent-symlink", async (fixture) => {
    const prepared = await prepareMaintenanceWorkflowWal(fixture.input);
    await confirmShadow(prepared, fixture.vaultPath);
    const outsidePath = path.join(fixture.rootPath, "outside");
    const outsideReportPath = path.join(outsidePath, "report.md");
    await mkdir(outsidePath, { recursive: true });
    await writeFile(outsideReportPath, "OUTSIDE-REPORT\n", "utf8");
    await rm(path.dirname(fixture.reportPath), {
      recursive: true,
      force: true
    });
    await symlink(outsidePath, path.dirname(fixture.reportPath), "dir");

    await rejectsWithWalCode(
      () => applyMaintenanceWorkflowManagedWrites(
        prepared.handle,
        fixture.vaultPath
      ),
      "unsafe_entry"
    );
    assert.equal(
      await readFile(outsideReportPath, "utf8"),
      "OUTSIDE-REPORT\n"
    );
    assert.equal(
      await readFile(fixture.trackerPath, "utf8"),
      "TRACKER-BASELINE\n"
    );
  });

  await withFixture("managed-apply-parent-symlink", async (fixture) => {
    const prepared = await prepareMaintenanceWorkflowWal(fixture.input);
    await confirmShadow(prepared, fixture.vaultPath);
    const outsidePath = path.join(fixture.rootPath, "outside-apply");
    const outsideReportPath = path.join(outsidePath, "report.md");
    await mkdir(outsidePath, { recursive: true });
    await writeFile(outsideReportPath, "OUTSIDE-APPLY\n", "utf8");
    let swapped = false;
    await rejectsWithWalCode(
      () => applyMaintenanceWorkflowManagedWrites(
        prepared.handle,
        fixture.vaultPath,
        {
          async faultInjector(input) {
            if (!swapped && input.point === "before-entry") {
              swapped = true;
              await rm(path.dirname(fixture.reportPath), {
                recursive: true,
                force: true
              });
              await symlink(
                outsidePath,
                path.dirname(fixture.reportPath),
                "dir"
              );
            }
          }
        }
      ),
      "unsafe_entry"
    );
    assert.equal(await readFile(outsideReportPath, "utf8"), "OUTSIDE-APPLY\n");
    assert.equal(
      await readFile(fixture.trackerPath, "utf8"),
      "TRACKER-BASELINE\n"
    );
  });

  await withFixture("managed-verify-parent-symlink", async (fixture) => {
    const prepared = await prepareMaintenanceWorkflowWal(fixture.input);
    await confirmShadow(prepared, fixture.vaultPath);
    await applyMaintenanceWorkflowManagedWrites(
      prepared.handle,
      fixture.vaultPath
    );
    const originalDirectory = path.join(
      fixture.rootPath,
      "original-maintenance"
    );
    const outsidePath = path.join(fixture.rootPath, "outside-verify");
    await rename(path.dirname(fixture.reportPath), originalDirectory);
    await mkdir(outsidePath, { recursive: true });
    await writeFile(
      path.join(outsidePath, "report.md"),
      "REPORT-FINAL\n",
      "utf8"
    );
    await symlink(outsidePath, path.dirname(fixture.reportPath), "dir");
    const store: MutableSettingsStore<FixtureSettings> = {
      settings: structuredClone(fixture.baselineSettings),
      generation: 1
    };
    await rejectsWithWalCode(
      () => commitMaintenanceWorkflowSettingsDurably(
        prepared.handle,
        fixture.vaultPath,
        createSettingsHost(store)
      ),
      "unsafe_entry"
    );
    assert.deepEqual(store.settings, fixture.baselineSettings);
    assert.equal(
      await readFile(path.join(outsidePath, "report.md"), "utf8"),
      "REPORT-FINAL\n"
    );
  });

  await withFixture("managed-cleanup-artifact-symlink", async (fixture) => {
    const prepared = await prepareMaintenanceWorkflowWal(fixture.input);
    await confirmShadow(prepared, fixture.vaultPath);
    const outsidePath = path.join(fixture.rootPath, "outside-cleanup.md");
    await writeFile(outsidePath, "OUTSIDE-CLEANUP\n", "utf8");
    let replaced = false;
    await rejectsWithWalCode(
      () => applyMaintenanceWorkflowManagedWrites(
        prepared.handle,
        fixture.vaultPath,
        {
          async faultInjector(input) {
            if (replaced || input.point !== "after-journal-commit") return;
            replaced = true;
            const journal = JSON.parse(
              await readFile(prepared.handle.managedJournalPath, "utf8")
            ) as {
              entries: Array<{ displacedLiveRelativePath?: string }>;
            };
            const displaced = journal.entries[0]?.displacedLiveRelativePath;
            assert.ok(displaced);
            const displacedPath = path.join(
              fixture.vaultPath,
              ...displaced.split("/")
            );
            await rm(displacedPath, { force: true });
            await symlink(outsidePath, displacedPath);
          }
        }
      ),
      "unsafe_entry"
    );
    assert.equal(await readFile(outsidePath, "utf8"), "OUTSIDE-CLEANUP\n");
  });
}

async function assertManagedDisplacementNeverClobbers(): Promise<void> {
  await withFixture("managed-no-clobber", async (fixture) => {
    const prepared = await prepareMaintenanceWorkflowWal(fixture.input);
    await confirmShadow(prepared, fixture.vaultPath);
    let crashed = false;
    await assert.rejects(
      () => applyMaintenanceWorkflowManagedWrites(
        prepared.handle,
        fixture.vaultPath,
        {
          faultInjector(input) {
            if (!crashed && input.point === "before-entry") {
              crashed = true;
              throw new MaintenanceWorkflowSimulatedCrash("journal prepared");
            }
          }
        }
      ),
      MaintenanceWorkflowSimulatedCrash
    );
    const journal = JSON.parse(
      await readFile(prepared.handle.managedJournalPath, "utf8")
    );
    const displacedRelativePath = journal.entries[0]?.displacedLiveRelativePath;
    assert.equal(typeof displacedRelativePath, "string");
    const displacedPath = path.join(
      fixture.vaultPath,
      displacedRelativePath
    );
    await writeFile(displacedPath, "DO-NOT-OVERWRITE\n", "utf8");
    await rejectsWithWalCode(
      () => applyMaintenanceWorkflowManagedWrites(
        prepared.handle,
        fixture.vaultPath
      ),
      "managed_cas_conflict"
    );
    assert.equal(
      await readFile(displacedPath, "utf8"),
      "DO-NOT-OVERWRITE\n"
    );
  });
}

async function assertManagedCrashReplayMatrix(): Promise<void> {
  const points = [
    "after-displace",
    "after-install",
    "after-journal-commit",
    "after-cleanup-link"
  ] as const;
  for (const point of points) {
    await withFixture(`managed-${point}`, async (fixture) => {
      const prepared = await prepareMaintenanceWorkflowWal(fixture.input);
      await confirmShadow(prepared, fixture.vaultPath);
      let crashed = false;
      await assert.rejects(
        () => applyMaintenanceWorkflowManagedWrites(
          prepared.handle,
          fixture.vaultPath,
          {
            faultInjector(input) {
              if (!crashed && input.point === point) {
                crashed = true;
                throw new MaintenanceWorkflowSimulatedCrash(point);
              }
            }
          }
        ),
        MaintenanceWorkflowSimulatedCrash
      );
      const recovered = await applyMaintenanceWorkflowManagedWrites(
        prepared.handle,
        fixture.vaultPath
      );
      assert.equal(recovered.state.phase, "managed_committed");
      assert.equal(await readFile(fixture.reportPath, "utf8"), "REPORT-FINAL\n");
      assert.equal(await readFile(fixture.trackerPath, "utf8"), "TRACKER-FINAL\n");
      assert.deepEqual(
        (await readdir(path.dirname(fixture.reportPath)))
          .filter((name) => name.startsWith(".echoink-managed-")),
        []
      );
    });
  }
}

async function assertSettingsMergeUsesPerSourceThreeWayCas(): Promise<void> {
  await withFixture("settings-merge", async (fixture) => {
    const prepared = await prepareMaintenanceWorkflowWal(fixture.input);
    const unrelated: KnowledgeBaseProcessedSource = {
      path: "raw/unrelated.md",
      size: 9,
      mtime: 9,
      fingerprint: "unrelated",
      digestedAt: 9
    };
    const current: FixtureSettings = structuredClone(fixture.baselineSettings);
    current.processedSources["raw/unrelated.md"] = unrelated;
    current.unrelatedPreference = "changed-concurrently";
    current.maintenanceHistory.push({
      date: "2026-07-17",
      status: "success",
      at: 90,
      runId: "other-run",
      mode: "maintain",
      reportPath: "outputs/maintenance/other.md"
    });
    const before = structuredClone(current);
    const merged = mergeMaintenanceWorkflowSettings(current, prepared.intent);
    assert.deepEqual(current, before, "merge must not mutate the current settings object");
    assert.deepEqual(
      merged.settings.processedSources["raw/unrelated.md"],
      unrelated
    );
    assert.equal(merged.settings.unrelatedPreference, "changed-concurrently");
    assert.ok(merged.settings.processedSources["raw/source.md"]);
    assert.ok(merged.settings.maintenanceHistory.some((entry) => entry.runId === "other-run"));
    assert.ok(merged.settings.maintenanceHistory.some(
      (entry) => entry.runId === prepared.intent.workflowRunId
    ));

    const thirdValue = structuredClone(fixture.baselineSettings);
    thirdValue.processedSources["raw/source.md"] = {
      path: "raw/source.md",
      size: 999,
      mtime: 999,
      fingerprint: "third-value",
      digestedAt: 999
    };
    assert.throws(
      () => mergeMaintenanceWorkflowSettings(thirdValue, prepared.intent),
      (error: unknown) => isWalError(error, "settings_cas_conflict")
    );

    const newer = structuredClone(fixture.baselineSettings);
    newer.lastRunAt = prepared.intent.settings.targetTerminal.lastRunAt + 100;
    newer.lastRunStatus = "failed";
    newer.lastError = "newer run";
    const preserved = mergeMaintenanceWorkflowSettings(newer, prepared.intent);
    assert.equal(preserved.settings.lastRunAt, newer.lastRunAt);
    assert.equal(preserved.settings.lastError, "newer run");
  });
}

async function assertSettingsPlanRejectsUnverifiedChanges(): Promise<void> {
  await withFixture("settings-plan-gates", async (fixture) => {
    const unauthorized: KnowledgeBaseProcessedSource = {
      path: "raw/unauthorized.md",
      size: 1,
      mtime: 1,
      fingerprint: "unauthorized",
      digestedAt: 1
    };
    await rejectsWithWalCode(
      () => prepareMaintenanceWorkflowWal({
        ...fixture.input,
        draft: {
          ...fixture.input.draft,
          settings: {
            ...fixture.input.draft.settings,
            targetProcessedSources: {
              ...fixture.input.draft.settings.targetProcessedSources,
              "raw/unauthorized.md": unauthorized
            }
          }
        }
      }),
      "intent_corrupt"
    );

    const verified = fixture.input.draft.settings
      .targetProcessedSources["raw/source.md"];
    assert.ok(verified);
    await rejectsWithWalCode(
      () => prepareMaintenanceWorkflowWal({
        ...fixture.input,
        draft: {
          ...fixture.input.draft,
          settings: {
            ...fixture.input.draft.settings,
            targetProcessedSources: {
              ...fixture.input.draft.settings.targetProcessedSources,
              "raw/source.md": {
                ...verified,
                size: verified.size + 1
              }
            }
          }
        }
      }),
      "intent_corrupt"
    );

    await rejectsWithWalCode(
      () => prepareMaintenanceWorkflowWal({
        ...fixture.input,
        draft: {
          ...fixture.input.draft,
          settings: {
            ...fixture.input.draft.settings,
            removedProcessedSourcePaths: ["raw/missing.md"]
          }
        }
      }),
      "intent_corrupt"
    );

    const pendingPath = "raw/pending.md";
    const pendingDraft = structuredClone(fixture.input.draft);
    pendingDraft.completion = "partial";
    pendingDraft.pendingSources = [{
      source: {
        relativePath: pendingPath,
        size: 7,
        mtime: 7,
        fingerprint: "pending-fingerprint"
      },
      reason: {
        code: "pending-verification",
        message: "pending source must remain unchanged"
      }
    }];
    const pendingProcessed: KnowledgeBaseProcessedSource = {
      path: pendingPath,
      size: 7,
      mtime: 7,
      fingerprint: "pending-fingerprint",
      digestedAt: 6,
      reportPath: "outputs/maintenance/previous.md",
      evidencePaths: ["wiki/previous.md"],
      runId: "previous-run",
      confidence: "verified"
    };
    pendingDraft.settings.baselineProcessedSources[pendingPath] =
      pendingProcessed;
    pendingDraft.settings.targetProcessedSources[pendingPath] = {
      ...pendingProcessed,
      size: pendingProcessed.size + 1
    };
    pendingDraft.settings.targetTerminal.lastCompletion = "partial";
    pendingDraft.settings.targetTerminal.lastPendingSources = [pendingPath];
    pendingDraft.settings.historyEntry.completion = "partial";
    pendingDraft.settings.historyEntry.pendingSources = [pendingPath];
    await rejectsWithWalCode(
      () => prepareMaintenanceWorkflowWal({
        ...fixture.input,
        draft: pendingDraft
      }),
      "intent_corrupt"
    );

    await rejectsWithWalCode(
      () => prepareMaintenanceWorkflowWal({
        ...fixture.input,
        draft: {
          ...fixture.input.draft,
          settings: {
            ...fixture.input.draft.settings,
            targetTerminal: {
              ...fixture.input.draft.settings.targetTerminal,
              lastSummary: "terminal projection diverged"
            }
          }
        }
      }),
      "intent_corrupt"
    );

    await rejectsWithWalCode(
      () => prepareMaintenanceWorkflowWal({
        ...fixture.input,
        draft: {
          ...fixture.input.draft,
          settings: {
            ...fixture.input.draft.settings,
            historyEntry: {
              ...fixture.input.draft.settings.historyEntry,
              reportPath: "outputs/maintenance/diverged.md"
            }
          }
        }
      }),
      "intent_corrupt"
    );
  });
}

async function assertScheduledSettingsProjectionIsAtomicAndRunBound(): Promise<void> {
  await withFixture("scheduled-settings", async (fixture) => {
    const workflowRunId = fixture.input.draft.workflowRunId;
    const scheduledAt = fixture.input.draft.startedAt;
    const scheduled = {
      baseline: {
        lastScheduledRunAt: scheduledAt,
        lastScheduledRunStatus: "running" as const,
        lastScheduledRunId: workflowRunId
      },
      target: {
        lastScheduledRunAt: scheduledAt,
        lastScheduledRunStatus: "success" as const,
        lastScheduledRunId: workflowRunId
      }
    };
    const scheduledInput: PrepareMaintenanceWorkflowWalInput = {
      ...fixture.input,
      draft: {
        ...fixture.input.draft,
        settings: {
          ...fixture.input.draft.settings,
          scheduled
        }
      }
    };
    const baseline: FixtureSettings = {
      ...structuredClone(fixture.baselineSettings),
      ...structuredClone(scheduled.baseline)
    };
    const prepared = await prepareMaintenanceWorkflowWal(scheduledInput);
    const merged = mergeMaintenanceWorkflowSettings(
      baseline,
      prepared.intent
    );
    assert.deepEqual(
      {
        lastScheduledRunAt: merged.settings.lastScheduledRunAt,
        lastScheduledRunStatus: merged.settings.lastScheduledRunStatus,
        lastScheduledRunId: merged.settings.lastScheduledRunId
      },
      scheduled.target
    );

    const wrongRun: PrepareMaintenanceWorkflowWalInput = {
      ...scheduledInput,
      draft: structuredClone(scheduledInput.draft)
    };
    wrongRun.draft.settings.scheduled!.target.lastScheduledRunId =
      "different-workflow";
    await rejectsWithWalCode(
      () => prepareMaintenanceWorkflowWal(wrongRun),
      "intent_corrupt"
    );

    const thirdValue = {
      ...structuredClone(baseline),
      lastScheduledRunId: "newer-scheduled-run",
      lastScheduledRunStatus: "running" as const
    };
    assert.throws(
      () => mergeMaintenanceWorkflowSettings(thirdValue, prepared.intent),
      (error: unknown) => isWalError(error, "settings_cas_conflict")
    );
  });

  await withFixture("manual-scheduled-isolation", async (fixture) => {
    const prepared = await prepareMaintenanceWorkflowWal(fixture.input);
    const current = {
      ...structuredClone(fixture.baselineSettings),
      lastScheduledRunAt: 999,
      lastScheduledRunStatus: "success" as const,
      lastScheduledRunId: "unrelated-scheduled-run"
    };
    const merged = mergeMaintenanceWorkflowSettings(current, prepared.intent);
    assert.equal(prepared.intent.settings.scheduled, null);
    assert.equal(merged.settings.lastScheduledRunAt, 999);
    assert.equal(merged.settings.lastScheduledRunStatus, "success");
    assert.equal(
      merged.settings.lastScheduledRunId,
      "unrelated-scheduled-run"
    );
  });
}

async function assertSettingsCrashReplayAndManagedDriftBlock(): Promise<void> {
  await withFixture("settings-crash", async (fixture) => {
    const prepared = await prepareMaintenanceWorkflowWal(fixture.input);
    await confirmShadow(prepared, fixture.vaultPath);
    await applyMaintenanceWorkflowManagedWrites(prepared.handle, fixture.vaultPath);
    const store: MutableSettingsStore<FixtureSettings> = {
      settings: structuredClone(fixture.baselineSettings),
      generation: 1
    };
    const settingsHost = createSettingsHost(store);
    let crashOnce = true;
    await assert.rejects(
      () => commitMaintenanceWorkflowSettingsDurably(
        prepared.handle,
        fixture.vaultPath,
        {
          ...settingsHost,
          faultInjector() {
            if (crashOnce) {
              crashOnce = false;
              throw new MaintenanceWorkflowSimulatedCrash("settings persisted");
            }
          }
        }
      ),
      MaintenanceWorkflowSimulatedCrash
    );
    assert.equal(
      (await loadMaintenanceWorkflowWal(prepared.handle)).state.phase,
      "managed_committed"
    );
    assert.equal(
      (await loadMaintenanceWorkflowWal(prepared.handle)).state.blocked,
      undefined
    );
    const recovered = await commitMaintenanceWorkflowSettingsDurably(
      prepared.handle,
      fixture.vaultPath,
      settingsHost
    );
    assert.equal(recovered.state.phase, "settings_committed");
    assert.equal(
      store.settings.maintenanceHistory.filter(
        (entry) => entry.runId === prepared.intent.workflowRunId
      ).length,
      1
    );
  });

  await withFixture("settings-managed-drift", async (fixture) => {
    const prepared = await prepareMaintenanceWorkflowWal(fixture.input);
    await confirmShadow(prepared, fixture.vaultPath);
    await applyMaintenanceWorkflowManagedWrites(prepared.handle, fixture.vaultPath);
    await writeFile(fixture.reportPath, "CONCURRENT-REPORT\n", "utf8");
    const store: MutableSettingsStore<FixtureSettings> = {
      settings: structuredClone(fixture.baselineSettings),
      generation: 1
    };
    const settingsHost = createSettingsHost(store);
    await rejectsWithWalCode(
      () => commitMaintenanceWorkflowSettingsDurably(
        prepared.handle,
        fixture.vaultPath,
        settingsHost
      ),
      "managed_cas_conflict"
    );
    const blocked = await loadMaintenanceWorkflowWal(prepared.handle);
    assert.equal(blocked.state.blocked?.code, "managed_cas_conflict");
    assert.deepEqual(store.settings, fixture.baselineSettings);
  });
}

async function assertSettingsReadbackToPhaseFence(): Promise<void> {
  for (const mode of ["generation", "projection"] as const) {
    await withFixture(`settings-pre-phase-${mode}`, async (fixture) => {
      const prepared = await prepareMaintenanceWorkflowWal(fixture.input);
      await confirmShadow(prepared, fixture.vaultPath);
      await applyMaintenanceWorkflowManagedWrites(
        prepared.handle,
        fixture.vaultPath
      );
      const store: MutableSettingsStore<FixtureSettings> = {
        settings: structuredClone(fixture.baselineSettings),
        generation: 1
      };
      const settingsHost = createSettingsHost(store);
      await rejectsWithWalCode(
        () => commitMaintenanceWorkflowSettingsDurably(
          prepared.handle,
          fixture.vaultPath,
          {
            ...settingsHost,
            faultInjector() {
              store.generation += 1;
              if (mode === "projection") {
                const managed =
                  store.settings.processedSources["raw/source.md"];
                assert.ok(managed);
                store.settings.processedSources["raw/source.md"] = {
                  ...managed,
                  size: managed.size + 1
                };
              }
            }
          }
        ),
        "settings_cas_conflict"
      );
      const blocked = await loadMaintenanceWorkflowWal(prepared.handle);
      assert.equal(blocked.state.phase, "managed_committed");
      assert.equal(blocked.state.blocked?.code, "settings_cas_conflict");
      assert.equal(blocked.state.settingsGeneration, undefined);
      assert.equal(blocked.state.settingsTargetProjectionDigest, undefined);
    });
  }
}

async function assertFinalizeIsReplayableAndCleanupIsGated(): Promise<void> {
  await withFixture("finalize", async (fixture) => {
    const prepared = await prepareMaintenanceWorkflowWal(fixture.input);
    await confirmShadow(prepared, fixture.vaultPath);
    await applyMaintenanceWorkflowManagedWrites(prepared.handle, fixture.vaultPath);
    const store: MutableSettingsStore<FixtureSettings> = {
      settings: structuredClone(fixture.baselineSettings),
      generation: 1
    };
    const settingsHost = createSettingsHost(store);
    await commitMaintenanceWorkflowSettingsDurably(
      prepared.handle,
      fixture.vaultPath,
      settingsHost
    );

    await rejectsWithWalCode(
      () => removeFinalizedMaintenanceWorkflowWal({
        ...prepared.handle,
        workflowRunId: prepared.intent.workflowRunId
      }),
      "phase_conflict"
    );
    let cleanupCalls = 0;
    let first = true;
    await assert.rejects(
      () => finalizeMaintenanceWorkflowWal(
        prepared.handle,
        fixture.vaultPath,
        async (intent) => {
          cleanupCalls += 1;
          assert.ok(intent.shadow);
          await cleanupMaintenanceShadowVault(
            shadowHandleFromIntentForTest(intent)
          );
          if (first) {
            first = false;
            throw new MaintenanceWorkflowSimulatedCrash("cleanup completed before phase");
          }
        },
        { settingsHost }
      ),
      MaintenanceWorkflowSimulatedCrash
    );
    const finalized = await finalizeMaintenanceWorkflowWal(
      prepared.handle,
      fixture.vaultPath,
      () => {
        cleanupCalls += 1;
      },
      { settingsHost }
    );
    assert.equal(finalized.phase, "finalized");
    assert.equal(cleanupCalls, 1);
    await removeFinalizedMaintenanceWorkflowWal(prepared.handle);
    await assert.rejects(
      () => lstat(prepared.handle.runRootPath),
      (error: NodeJS.ErrnoException) => error.code === "ENOENT"
    );
  });

  await withFixture("finalize-settings-drift", async (fixture) => {
    const prepared = await prepareMaintenanceWorkflowWal(fixture.input);
    await confirmShadow(prepared, fixture.vaultPath);
    await applyMaintenanceWorkflowManagedWrites(
      prepared.handle,
      fixture.vaultPath
    );
    const store: MutableSettingsStore<FixtureSettings> = {
      settings: structuredClone(fixture.baselineSettings),
      generation: 1
    };
    const settingsHost = createSettingsHost(store);
    await commitMaintenanceWorkflowSettingsDurably(
      prepared.handle,
      fixture.vaultPath,
      settingsHost
    );
    const managed = store.settings.processedSources["raw/source.md"];
    assert.ok(managed);
    store.settings.processedSources["raw/source.md"] = {
      ...managed,
      size: managed.size + 1
    };
    store.generation += 1;
    let cleanupCalls = 0;
    await rejectsWithWalCode(
      () => finalizeMaintenanceWorkflowWal(
        prepared.handle,
        fixture.vaultPath,
        () => {
          cleanupCalls += 1;
        },
        { settingsHost }
      ),
      "settings_cas_conflict"
    );
    assert.equal(cleanupCalls, 0);
    const blocked = await loadMaintenanceWorkflowWal(prepared.handle);
    assert.equal(blocked.state.phase, "settings_committed");
    assert.equal(blocked.state.blocked?.code, "settings_cas_conflict");
  });

  await withFixture("finalize-readback-generation-fence", async (fixture) => {
    const prepared = await prepareMaintenanceWorkflowWal(fixture.input);
    await confirmShadow(prepared, fixture.vaultPath);
    await applyMaintenanceWorkflowManagedWrites(
      prepared.handle,
      fixture.vaultPath
    );
    const store: MutableSettingsStore<FixtureSettings> = {
      settings: structuredClone(fixture.baselineSettings),
      generation: 1
    };
    const settingsHost = createSettingsHost(store);
    await commitMaintenanceWorkflowSettingsDurably(
      prepared.handle,
      fixture.vaultPath,
      settingsHost
    );
    let cleanupCalls = 0;
    await rejectsWithWalCode(
      () => finalizeMaintenanceWorkflowWal(
        prepared.handle,
        fixture.vaultPath,
        async (intent) => {
          cleanupCalls += 1;
          assert.ok(intent.shadow);
          await cleanupMaintenanceShadowVault(
            shadowHandleFromIntentForTest(intent)
          );
          store.generation += 1;
        },
        { settingsHost }
      ),
      "settings_cas_conflict"
    );
    const blocked = await loadMaintenanceWorkflowWal(prepared.handle);
    assert.equal(blocked.state.phase, "settings_committed");
    assert.equal(blocked.state.blocked?.code, "settings_cas_conflict");
    const finalized = await finalizeMaintenanceWorkflowWal(
      prepared.handle,
      fixture.vaultPath,
      () => {
        cleanupCalls += 1;
      },
      {
        settingsHost,
        resumeBlocked: {
          stateSequence: blocked.state.sequence,
          stateDigest: blocked.state.digest
        }
      }
    );
    assert.equal(finalized.phase, "finalized");
    assert.equal(cleanupCalls, 1);
  });
}

async function confirmShadow(
  prepared: LoadedMaintenanceWorkflowWal,
  vaultPath: string
): Promise<void> {
  const shadow = requireShadow(prepared);
  await writeShadowCommitProof(prepared, vaultPath);
  await confirmMaintenanceWorkflowShadowCommitted(prepared.handle, vaultPath, {
    changeSetDigest: shadow.changeSetDigest,
    selectionDigest: shadow.selectionDigest,
    appliedPaths: shadow.expectedAppliedPaths
  });
}

async function writeShadowCommitProof(
  prepared: LoadedMaintenanceWorkflowWal,
  vaultPath: string,
  options: {
    entries?: "valid" | "empty";
    writeLiveTarget?: boolean;
  } = {}
): Promise<void> {
  const shadow = requireShadow(prepared);
  const winner = requireWinner(prepared);
  const shadowHandle = {
    attemptId: winner.attemptId,
    rootPath: shadow.controlRootPath,
    agentVaultPath: path.join(shadow.controlRootPath, "vault"),
    manifestPath: path.join(shadow.controlRootPath, "manifest.json")
  };
  const changeSet = await loadMaintenanceShadowChangeSet(shadowHandle);
  const applied = await applyShadowChangeSet(
    vaultPath,
    changeSet,
    { allowPaths: shadow.allowPaths }
  );
  assert.deepEqual(
    applied.appliedPaths,
    shadow.expectedAppliedPaths
  );
  const journalRootPath = path.join(
    shadow.controlRootPath,
    "apply-journal"
  );
  const journalPath = path.join(journalRootPath, "journal.json");
  if (options.entries === "empty") {
    const journal = JSON.parse(await readFile(journalPath, "utf8"));
    journal.entries = [];
    const { digest: _digest, ...withoutDigest } = journal;
    journal.digest = digestForTest(withoutDigest);
    await writeFile(journalPath, `${JSON.stringify(journal)}\n`, "utf8");
  }
  if (options.writeLiveTarget === false) {
    for (const relativePath of shadow.expectedAppliedPaths) {
      await rm(path.join(vaultPath, relativePath), { force: true });
    }
  }
}

function requireShadow(
  prepared: LoadedMaintenanceWorkflowWal
): NonNullable<LoadedMaintenanceWorkflowWal["intent"]["shadow"]> {
  assert.ok(prepared.intent.shadow, "expected non-noop Shadow intent");
  return prepared.intent.shadow;
}

function requireWinner(
  prepared: LoadedMaintenanceWorkflowWal
): NonNullable<LoadedMaintenanceWorkflowWal["intent"]["winner"]> {
  assert.ok(prepared.intent.winner, "expected non-noop winner");
  return prepared.intent.winner;
}

function shadowHandleFromIntentForTest(
  intent: LoadedMaintenanceWorkflowWal["intent"]
) {
  assert.ok(intent.shadow);
  assert.ok(intent.winner);
  return {
    attemptId: intent.winner.attemptId,
    rootPath: intent.shadow.controlRootPath,
    agentVaultPath: path.join(intent.shadow.controlRootPath, "vault"),
    manifestPath: path.join(intent.shadow.controlRootPath, "manifest.json")
  };
}

async function withFixture(
  suffix: string,
  run: (fixture: WalFixture) => Promise<void>
): Promise<void> {
  const rootPath = await mkdtemp(path.join(tmpdir(), "echoink-workflow-wal-test-"));
  try {
    const fixture = await createFixture(rootPath, suffix);
    await run(fixture);
  } finally {
    await makeOwnerWritable(rootPath);
    await rm(rootPath, { recursive: true, force: true });
  }
}

async function createFixture(
  rootPath: string,
  suffix: string
): Promise<WalFixture> {
  const storageRootPath = path.join(rootPath, "storage");
  const vaultPath = path.join(rootPath, "vault");
  const reportPath = path.join(vaultPath, "outputs/maintenance/report.md");
  const trackerPath = path.join(vaultPath, "outputs/.ingest-tracker.md");
  const sourcePath = path.join(vaultPath, "raw/source.md");
  const workflowRunId = `workflow-${suffix}`;
  await mkdir(storageRootPath, { recursive: true });
  await mkdir(path.dirname(reportPath), { recursive: true });
  await mkdir(path.dirname(sourcePath), { recursive: true });
  await mkdir(path.join(vaultPath, "wiki"), { recursive: true });
  await writeFile(reportPath, "REPORT-SHADOW\n", "utf8");
  await writeFile(trackerPath, "TRACKER-BASELINE\n", "utf8");
  await writeFile(
    path.join(vaultPath, "wiki/topic.md"),
    "WIKI-BASELINE\n",
    "utf8"
  );
  const rawMetadata = await createRawMetadataWriteForTest({
    vaultPath,
    relativePath: "raw/source.md",
    baselineContent: Buffer.from("RAW-SOURCE\n", "utf8"),
    workflowRunId,
    startedAt: 100,
    reportPath: "outputs/maintenance/report.md",
    evidencePaths: ["wiki/topic.md"]
  });
  const rawRegistry = await createRawRegistryWriteForTest({
    vaultPath,
    startedAt: 100,
    entries: {
      "raw/source.md": {
        rawPath: "raw/source.md",
        fingerprint: rawMetadata.fingerprint,
        size: rawMetadata.desiredContent.byteLength,
        mtime: 100,
        digestedAt: 100,
        runId: workflowRunId,
        reportPath: "outputs/maintenance/report.md",
        evidencePaths: ["wiki/topic.md"],
        confidence: "verified"
      }
    }
  });
  const attempt: KnowledgeRunAttemptRecord = {
    attemptId: `${workflowRunId}-attempt-1-opencode`,
    ordinal: 1,
    backend: "opencode",
    terminal: {
      status: "completed",
      at: 200
    }
  };
  const shadowHandle = await createMaintenanceShadowVault({
    liveVaultPath: vaultPath,
    attemptId: attempt.attemptId,
    storageRootPath,
    rawPaths: ["raw"],
    rulesPaths: [],
    requiredSourcePaths: ["raw/source.md"],
    copiedPaths: ["wiki"],
    writablePaths: ["wiki"]
  });
  const shadowBoundary = await maintenanceShadowExecutionBoundary(
    shadowHandle
  );
  const transportReceipt = createMaintenanceShadowTransportConfigReceipt({
    backend: "test-transport",
    attemptId: attempt.attemptId,
    leaseId: `lease:${attempt.attemptId}`,
    enforcedWritableRootPaths: shadowBoundary.writableRootPaths,
    enforcedDeniedShadowPaths: shadowBoundary.deniedPaths,
    deniedLiveVaultPath: vaultPath,
    deniedControlPath: shadowBoundary.deniedParentPath,
    transportAck: "test transport installed the exact write fence before prompt",
    transportConfigDigest: digestForTest({
      attemptId: attempt.attemptId,
      writableRootPaths: shadowBoundary.writableRootPaths,
      deniedPaths: shadowBoundary.deniedPaths
    })
  });
  await confirmMaintenanceShadowTransportConfigFence(
    shadowHandle,
    vaultPath,
    transportReceipt
  );
  await mkdir(
    path.dirname(path.join(shadowHandle.agentVaultPath, "wiki/topic.md")),
    { recursive: true }
  );
  await writeFile(
    path.join(shadowHandle.agentVaultPath, "wiki/topic.md"),
    "WIKI-FINAL\n",
    "utf8"
  );
  const shadowChangeSet = await sealMaintenanceShadowVault(shadowHandle);
  const shadowSelectionOrder = shadowChangeSet.changes.map(
    (change) => change.relativePath
  );
  const baselineTerminal = {
    lastRunAt: 100,
    lastRunStatus: "idle" as const,
    lastReportPath: "",
    lastError: "",
    lastSummary: "",
    lastCompletion: "" as const,
    lastAttempts: [] as KnowledgeRunAttemptRecord[],
    lastPendingSources: [] as string[],
    lastFailureCode: "",
    lastWarnings: []
  };
  const targetTerminal = {
    lastRunAt: 200,
    lastRunStatus: "success" as const,
    lastReportPath: "outputs/maintenance/report.md",
    lastError: "",
    lastSummary: "maintenance complete",
    lastCompletion: "full" as const,
    lastAttempts: [attempt],
    lastPendingSources: [] as string[],
    lastFailureCode: "",
    lastWarnings: []
  };
  const processed: KnowledgeBaseProcessedSource = {
    path: "raw/source.md",
    size: rawMetadata.desiredContent.byteLength,
    mtime: 100,
    fingerprint: rawMetadata.fingerprint,
    digestedAt: 100,
    reportPath: "outputs/maintenance/report.md",
    evidencePaths: ["wiki/topic.md"],
    runId: workflowRunId,
    confidence: "verified"
  };
  const historyEntry: KnowledgeBaseMaintenanceHistoryEntry = {
    date: "2026-07-18",
    status: "success",
    at: 200,
    runId: workflowRunId,
    mode: "maintain",
    reportPath: "outputs/maintenance/report.md",
    completion: "full",
    selectedBackend: "opencode",
    winnerBackend: "opencode",
    attempts: [attempt],
    pendingSources: [],
    failureCode: null,
    terminalPhase: "finalized",
    commitState: "committed",
    warnings: []
  };
  const baselineSettings: FixtureSettings = {
    ...structuredClone(baselineTerminal),
    lastScheduledRunAt: 77,
    lastScheduledRunStatus: "failed",
    lastScheduledRunId: "previous-scheduled-run",
    processedSources: {},
    maintenanceHistory: [],
    unrelatedPreference: "keep-me"
  };
  const draft: MaintenanceWorkflowWalIntentDraft = {
    workflowRunId,
    mode: "maintain",
    startedAt: 100,
    createdAt: "2026-07-18T00:00:00.000Z",
    selectedBackend: "opencode",
    candidateBackends: ["opencode", "hermes", "codex-cli"],
    winner: {
      attemptId: attempt.attemptId,
      ordinal: attempt.ordinal,
      backend: attempt.backend
    },
    completion: "full",
    attempts: [attempt],
    verifiedSources: [{
      relativePath: "raw/source.md",
      size: rawMetadata.desiredContent.byteLength,
      mtime: 100,
      fingerprint: rawMetadata.fingerprint
    }],
    pendingSources: [],
    evidencePaths: {
      "raw/source.md": ["wiki/topic.md"]
    },
    warnings: [],
    summary: "maintenance complete",
    shadow: {
      controlRootPath: shadowChangeSet.controlRootPath,
      changeSetDigest: shadowChangeSet.digest,
      selectionDigest: digestForTest(shadowSelectionOrder),
      liveVaultFingerprint: shadowChangeSet.liveVaultFingerprint,
      allowPaths: ["wiki/topic.md"],
      expectedAppliedPaths: [...shadowSelectionOrder].sort(),
      skippedPaths: []
    },
    report: {
      relativePath: "outputs/maintenance/report.md",
      finalBlockDigest: sha256Text("REPORT-FINAL\n")
    },
    indexReconciliation: {
      committed: [],
      deferred: [],
      warnings: []
    },
    settings: {
      baselineProcessedSources: {},
      targetProcessedSources: {
        "raw/source.md": processed
      },
      removedProcessedSourcePaths: [],
      baselineTerminal,
      targetTerminal,
      historyEntry,
      scheduled: null
    }
  };
  const input: PrepareMaintenanceWorkflowWalInput = {
    storageRootPath,
    draft,
    managedWrites: [{
      kind: "report",
      operation: "upsert",
      relativePath: "outputs/maintenance/report.md",
      expected: await snapshotMaintenanceWorkflowFileCas(
        vaultPath,
        "outputs/maintenance/report.md"
      ),
      desiredContent: Buffer.from("REPORT-FINAL\n", "utf8"),
      desiredMode: 0o644
    }, {
      kind: "tracker",
      operation: "upsert",
      relativePath: "outputs/.ingest-tracker.md",
      expected: await snapshotMaintenanceWorkflowFileCas(
        vaultPath,
        "outputs/.ingest-tracker.md"
      ),
      desiredContent: Buffer.from("TRACKER-FINAL\n", "utf8"),
      desiredMode: 0o644
    }, rawMetadata.write, rawRegistry.write]
  };
  return {
    rootPath,
    storageRootPath,
    vaultPath,
    reportPath,
    trackerPath,
    sourcePath,
    input,
    baselineSettings
  };
}

async function createRawMetadataWriteForTest(input: {
  vaultPath: string;
  relativePath: string;
  baselineContent: Buffer;
  workflowRunId: string;
  startedAt: number;
  reportPath: string;
  evidencePaths: string[];
}): Promise<{
  write: MaintenanceWorkflowManagedUpsertDraft;
  fingerprint: string;
  desiredContent: Buffer;
}> {
  const absolutePath = path.join(
    input.vaultPath,
    ...input.relativePath.split("/")
  );
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, input.baselineContent);
  const fingerprint = rawDigestFingerprint(
    input.relativePath,
    input.baselineContent
  );
  const desiredContent = applyRawDigestFrontmatter(
    input.baselineContent,
    {
      rawPath: input.relativePath,
      fingerprint,
      size: input.baselineContent.byteLength,
      mtime: input.startedAt,
      digestedAt: input.startedAt,
      runId: input.workflowRunId,
      reportPath: input.reportPath,
      evidencePaths: [...input.evidencePaths],
      confidence: "verified"
    }
  );
  return {
    write: {
      kind: "raw-metadata",
      operation: "upsert",
      relativePath: input.relativePath,
      expected: await snapshotMaintenanceWorkflowFileCas(
        input.vaultPath,
        input.relativePath
      ),
      expectedContent: Buffer.from(input.baselineContent),
      desiredContent,
      desiredMode: 0o644
    },
    fingerprint,
    desiredContent
  };
}

async function createRawRegistryWriteForTest(input: {
  vaultPath: string;
  startedAt: number;
  entries: Record<string, RawDigestRegistryEntry>;
}): Promise<{
  write: MaintenanceWorkflowManagedUpsertDraft;
  desiredContent: Buffer;
}> {
  const desiredContent = buildRawDigestRegistryContent({
    schemaVersion: RAW_DIGEST_SCHEMA_VERSION,
    updatedAt: new Date(input.startedAt).toISOString(),
    entries: structuredClone(input.entries)
  });
  return {
    write: {
      kind: "raw-registry",
      operation: "upsert",
      relativePath: RAW_DIGEST_REGISTRY_PATH,
      expected: await snapshotMaintenanceWorkflowFileCas(
        input.vaultPath,
        RAW_DIGEST_REGISTRY_PATH
      ),
      desiredContent,
      desiredMode: 0o644
    },
    desiredContent
  };
}

function withoutRawMetadataWrites(
  input: PrepareMaintenanceWorkflowWalInput
): PrepareMaintenanceWorkflowWalInput["managedWrites"] {
  return input.managedWrites.filter(
    (write) => write.kind !== "raw-metadata"
  );
}

function withoutRawDigestWrites(
  input: PrepareMaintenanceWorkflowWalInput
): PrepareMaintenanceWorkflowWalInput["managedWrites"] {
  return input.managedWrites.filter(
    (write) =>
      write.kind !== "raw-metadata"
      && write.kind !== "raw-registry"
  );
}

function bindFixtureVerifiedRaw(
  input: PrepareMaintenanceWorkflowWalInput,
  rawMetadata: {
    fingerprint: string;
    desiredContent: Buffer;
  },
  relativePath = "raw/source.md"
): PrepareMaintenanceWorkflowWalInput {
  const target = input.draft.settings.targetProcessedSources[relativePath];
  assert.ok(target, `missing target processed source: ${relativePath}`);
  return {
    ...input,
    draft: {
      ...input.draft,
      verifiedSources: input.draft.verifiedSources.map((source) =>
        source.relativePath === relativePath
          ? {
            ...source,
            size: rawMetadata.desiredContent.byteLength,
            fingerprint: rawMetadata.fingerprint
          }
          : source
      ),
      settings: {
        ...input.draft.settings,
        targetProcessedSources: {
          ...input.draft.settings.targetProcessedSources,
          [relativePath]: {
            ...target,
            size: rawMetadata.desiredContent.byteLength,
            fingerprint: rawMetadata.fingerprint
          }
        }
      }
    }
  };
}

async function createBinaryRawWorkflowInput(
  fixture: WalFixture
): Promise<{
  input: PrepareMaintenanceWorkflowWalInput;
  absolutePath: string;
  relativePath: string;
  content: Buffer;
  processed: KnowledgeBaseProcessedSource;
  registryEntry: RawDigestRegistryEntry;
}> {
  const relativePath = "raw/source.pdf";
  const absolutePath = path.join(fixture.vaultPath, relativePath);
  const content = Buffer.from([
    0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37,
    0x0a, 0x00, 0xff, 0x10, 0x45, 0x4f, 0x46, 0x0a
  ]);
  await writeFile(absolutePath, content);
  await chmod(absolutePath, 0o640);
  await utimes(absolutePath, new Date(50), new Date(50));
  const sourceStat = await lstat(absolutePath);
  const fingerprint = rawDigestFingerprint(relativePath, content);
  const evidencePaths = ["wiki/topic.md"];
  const registryEntry: RawDigestRegistryEntry = {
    rawPath: relativePath,
    fingerprint,
    size: content.byteLength,
    mtime: sourceStat.mtimeMs,
    digestedAt: fixture.input.draft.startedAt,
    runId: fixture.input.draft.workflowRunId,
    reportPath: fixture.input.draft.report.relativePath,
    evidencePaths,
    confidence: "verified"
  };
  const processed: KnowledgeBaseProcessedSource = {
    path: relativePath,
    fingerprint,
    size: content.byteLength,
    mtime: sourceStat.mtimeMs,
    digestedAt: fixture.input.draft.startedAt,
    reportPath: fixture.input.draft.report.relativePath,
    evidencePaths,
    runId: fixture.input.draft.workflowRunId,
    confidence: "verified"
  };
  const registry = await createRawRegistryWriteForTest({
    vaultPath: fixture.vaultPath,
    startedAt: fixture.input.draft.startedAt,
    entries: {
      [relativePath]: registryEntry
    }
  });
  return {
    input: {
      ...fixture.input,
      draft: {
        ...fixture.input.draft,
        verifiedSources: [{
          relativePath,
          fingerprint,
          size: content.byteLength,
          mtime: sourceStat.mtimeMs
        }],
        evidencePaths: {
          [relativePath]: evidencePaths
        },
        settings: {
          ...fixture.input.draft.settings,
          targetProcessedSources: {
            [relativePath]: processed
          }
        }
      },
      managedWrites: [
        ...withoutRawDigestWrites(fixture.input),
        registry.write
      ]
    },
    absolutePath,
    relativePath,
    content,
    processed,
    registryEntry
  };
}

interface MutableSettingsStore<T extends MaintenanceWorkflowSettingsSnapshot> {
  settings: T;
  generation: number;
}

function createSettingsHost<T extends MaintenanceWorkflowSettingsSnapshot>(
  store: MutableSettingsStore<T>
): MaintenanceWorkflowSettingsHost<T> {
  return {
    async withExclusiveTransaction<R>(
      action: (
        transaction: MaintenanceWorkflowSettingsTransaction<T>
      ) => Promise<R>
    ): Promise<R> {
      return await action({
        readWithGeneration() {
          return {
            settings: structuredClone(store.settings),
            generation: `generation-${store.generation}`
          };
        },
        persistCas(expectedGeneration, settings) {
          if (expectedGeneration !== `generation-${store.generation}`) {
            throw new MaintenanceWorkflowWalError(
              "settings_cas_conflict",
              "test settings generation conflict"
            );
          }
          if (
            stableStringifyForTest(settings)
            !== stableStringifyForTest(store.settings)
          ) {
            store.settings = structuredClone(settings);
            store.generation += 1;
          }
          return {
            settings: structuredClone(store.settings),
            generation: `generation-${store.generation}`
          };
        }
      });
    }
  };
}

async function rejectsWithWalCode(
  operation: () => Promise<unknown>,
  code: MaintenanceWorkflowWalErrorCode
): Promise<void> {
  await assert.rejects(
    operation,
    (error: unknown) => isWalError(error, code)
  );
}

function isWalError(
  error: unknown,
  code: MaintenanceWorkflowWalErrorCode
): boolean {
  return error instanceof MaintenanceWorkflowWalError && error.code === code;
}

function sha256Text(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function digestForTest(value: unknown): string {
  return sha256Text(stableStringifyForTest(value));
}

function stableStringifyForTest(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringifyForTest).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringifyForTest(record[key])}`)
      .join(",")}}`;
  }
  return value === undefined ? "null" : JSON.stringify(value);
}

async function makeOwnerWritable(absolutePath: string): Promise<void> {
  const stat = await lstat(absolutePath).catch(() => null);
  if (!stat || stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    await chmod(absolutePath, 0o700).catch(() => undefined);
    for (const child of await readdir(absolutePath).catch(() => [])) {
      await makeOwnerWritable(path.join(absolutePath, child));
    }
  } else if (stat.isFile()) {
    await chmod(absolutePath, 0o600).catch(() => undefined);
  }
}

if (process.env.ECHOINK_RUN_MAINTENANCE_WORKFLOW_WAL_TEST === "1") {
  runHarnessV2MaintenanceWorkflowWalTests().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
