import * as assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type {
  AgentBackendKind,
  AgentTaskInput
} from "../../agent/types";
import { createExactWriteFenceReceipt } from "../../agent/write-fence";
import type {
  MaintenanceWorkflowSettingsHost,
  MaintenanceWorkflowSettingsTransaction
} from "../../harness/maintenance/workflow-wal";
import { MaintenanceWorkflowWalError } from "../../harness/maintenance/workflow-wal";
import {
  createActiveMaintenanceRunJournal,
  listActiveMaintenanceRunJournals
} from "../../harness/maintenance/active-run-journal";
import { DEFAULT_KNOWLEDGE_BASE_RULES_FILE } from "../../knowledge-base/constants";
import { discoverKnowledgeBaseSources } from "../../knowledge-base/discovery";
import {
  KnowledgeBaseMaintenanceRunner,
  type KnowledgeBaseMaintenanceRunnerContext
} from "../../knowledge-base/maintenance-runner";
import { assertDurableMaintenanceResult } from "../../knowledge-base/maintenance-terminal";
import {
  rawDigestFingerprint,
  rawDigestRecordFromMarkdown,
  rawDigestRecordIsTrusted,
  readRawDigestRegistry
} from "../../knowledge-base/raw-digest";
import type {
  KnowledgeBaseDurableMaintenanceResult,
  KnowledgeBaseRunResult,
  KnowledgeBaseSource
} from "../../knowledge-base/types";
import {
  DEFAULT_SETTINGS,
  normalizeSettingsData,
  type CodexForObsidianSettings,
  type KnowledgeBaseMaintenanceHistoryEntry,
  type KnowledgeBaseProcessedSource,
  type KnowledgeBaseSettings
} from "../../settings/settings";

const SOURCE_COUNT = 20;
const VERIFIED_COUNT = 19;
const PENDING_INDEX = SOURCE_COUNT;

interface AcceptanceFixture {
  rootPath: string;
  vaultPath: string;
  storageRootPath: string;
  reportPath: string;
  sourcePaths: string[];
  bodyFingerprints: Record<string, string>;
  settings: CodexForObsidianSettings;
  readinessChecks: AgentBackendKind[];
  executedBackends: AgentBackendKind[];
  runner: KnowledgeBaseMaintenanceRunner;
  dispose(): Promise<void>;
}

interface HarnessParitySnapshot {
  completion: KnowledgeBaseRunResult["completion"];
  processedPaths: string[];
  pendingPaths: string[];
  attemptBackends: AgentBackendKind[];
  registry: Record<string, {
    rawPath: string;
    fingerprint: string;
    reportPath: string;
    evidencePaths: string[];
    confidence: string;
  }>;
  processed: Record<string, {
    path: string;
    fingerprint?: string;
    reportPath?: string;
    evidencePaths?: string[];
    confidence?: string;
  }>;
  wikiBodies: Record<string, string>;
  reportFacts: {
    completion: string;
    verifiedCount: number;
    pendingCount: number;
  };
}

/**
 * High-value acceptance tests kept out of run-tests.ts while the main suite is
 * under parallel maintenance. This is the single function the main registry
 * can import after the branch settles.
 */
export async function runMaintenanceAcceptanceTests(): Promise<void> {
  await assertTwentySourcePartialCommitIsAtomic();
  await assertTwentyOneSourceBatchLimitStaysPending();
  await assertTwentyOneUnchangedReingestStaysPending();
  await assertBusinessHarnessParityBelowInvocationAdapter();
  await assertDurableNoopPreservesExistingKnowledgeArtifacts();
  await assertMixedReadableAndSkippedSourcesCommitPartial();
  await assertSkippedSourcesCannotBecomeNoop();
  await runOversizedMarkdownAcceptanceTest();
  await runOversizedMarkdownLintAcceptanceTest();
  await assertReingestDurableTerminalRoundTrips();
  await assertActiveRunJournalCleanupRequiresUniqueDurableHistory();
}

export async function runOversizedMarkdownLintAcceptanceTest(): Promise<void> {
  const sourcePath = "raw/articles/source-01.md";
  const original = Buffer.from([
    "---",
    "title: Oversized Lint Acceptance Source",
    "---",
    "# Oversized Lint Source",
    "",
    "y".repeat(294_700),
    ""
  ].join("\n"), "utf8");
  let observedSourcePaths: string[] = [];
  let observedPrompt = "";
  const fixture = await createAcceptanceFixture({
    suffix: "oversized-lint-shadow-chunks",
    mode: "lint",
    selectedBackend: "codex-cli",
    sourceCount: 1,
    materialize: async (shadowVaultPath, input) => {
      observedSourcePaths = [...input.sourcePaths];
      observedPrompt = input.prompt;
      assert.deepEqual(observedSourcePaths, ["wiki/index.md"]);
      await writeText(
        shadowVaultPath,
        input.reportPath,
        [
          "---",
          "mode: lint-only",
          "---",
          "# 知识库体检报告",
          "",
          "已按 lint-only 边界完成知识结构体检；Raw 不作为本轮写入或提炼附件。",
          ""
        ].join("\n")
      );
    }
  });

  try {
    await writeFile(path.join(fixture.vaultPath, sourcePath), original);
    const originalFingerprint = rawDigestFingerprint(sourcePath, original);
    const result = await fixture.runner.runMaintenance(
      "lint",
      "/check acceptance oversized markdown",
      { workflowRunId: "acceptance-oversized-lint-shadow-chunks" },
      "codex-cli"
    );

    assert.equal(result.status, "success", result.error);
    assert.deepEqual(result.processedSources, []);
    assert.match(observedPrompt, /\/check 只体检/);
    assert.match(observedPrompt, /不要写 Wiki \/ Projects 正文/);
    assert.doesNotMatch(observedPrompt, /超限文本安全分块/);
    assert.equal(observedPrompt.includes(sourcePath), false);
    const liveRaw = await readFile(path.join(fixture.vaultPath, sourcePath));
    assert.equal(rawDigestFingerprint(sourcePath, liveRaw), originalFingerprint);
    assert.equal(
      await readFile(path.join(fixture.vaultPath, "wiki", "index.md"), "utf8"),
      "# Wiki\n",
      "/check must not rewrite Wiki while reading an oversized Raw"
    );
    const report = await readFile(
      path.join(fixture.vaultPath, result.reportPath),
      "utf8"
    );
    assert.match(report, /mode: lint-only/);
    assert.equal(report.includes(sourcePath), false);
    assert.doesNotMatch(report, /\.echoink-source-chunks/);
    await assert.rejects(
      () => stat(path.join(fixture.vaultPath, "raw", ".echoink-source-chunks")),
      (error: NodeJS.ErrnoException) => error.code === "ENOENT"
    );
  } finally {
    await fixture.dispose();
  }
}

export async function runOversizedMarkdownAcceptanceTest(): Promise<void> {
  const sourcePath = "raw/articles/source-01.md";
  const original = Buffer.from([
    "---",
    "title: Oversized Acceptance Source",
    "tags:",
    "  - acceptance",
    "---",
    "# Oversized Source",
    "",
    "这段正文用于验证超限 Markdown 只通过 Shadow 分块交给 Agent。",
    "x".repeat(294_700),
    ""
  ].join("\n"), "utf8");
  let observedChunkPaths: string[] = [];
  let observedPrompt = "";
  const fixture = await createAcceptanceFixture({
    suffix: "oversized-shadow-chunks",
    selectedBackend: "codex-cli",
    sourceCount: 1,
    materialize: async (shadowVaultPath, input) => {
      observedChunkPaths = [...input.sourcePaths];
      observedPrompt = input.prompt;
      assert.ok(observedChunkPaths.length > 1);
      assert.ok(observedChunkPaths.every((relativePath) =>
        relativePath.startsWith("raw/.echoink-source-chunks/")
      ));
      const reconstructed = Buffer.concat(await Promise.all(
        observedChunkPaths.map((relativePath) =>
          readFile(path.join(shadowVaultPath, relativePath))
        )
      ));
      assert.equal(reconstructed.equals(original), true);
      await materializeIndependentEvidence({
        shadowVaultPath,
        reportPath: input.reportPath,
        sourcePaths: [sourcePath],
        verifiedPaths: [sourcePath],
        includeUnsafeSharedIndexEntry: false
      });
    }
  });

  try {
    await writeFile(path.join(fixture.vaultPath, sourcePath), original);
    const originalFingerprint = rawDigestFingerprint(sourcePath, original);
    const result = await fixture.runner.runMaintenance(
      "maintain",
      "/maintain acceptance oversized markdown",
      { workflowRunId: "acceptance-oversized-shadow-chunks" },
      "codex-cli"
    );

    assert.equal(result.status, "success", result.error);
    assert.equal(result.completion, "full");
    assert.deepEqual(
      result.processedSources.map((source) => source.relativePath),
      [sourcePath]
    );
    assert.match(observedPrompt, /超限文本安全分块/);
    assert.ok(observedPrompt.includes(`原始来源：${sourcePath}`));
    for (const chunkPath of observedChunkPaths) {
      assert.ok(observedPrompt.includes(chunkPath));
    }
    const liveRaw = await readFile(path.join(fixture.vaultPath, sourcePath));
    assert.equal(
      rawDigestFingerprint(sourcePath, liveRaw),
      originalFingerprint,
      "managed metadata may change, but the oversized Raw body must not"
    );
    const report = await readFile(
      path.join(fixture.vaultPath, result.reportPath),
      "utf8"
    );
    const wiki = await readFile(
      path.join(fixture.vaultPath, "wiki", "acceptance-01.md"),
      "utf8"
    );
    assert.ok(report.includes(sourcePath));
    assert.ok(wiki.includes("raw/articles/source-01"));
    assert.doesNotMatch(report, /\.echoink-source-chunks/);
    assert.doesNotMatch(wiki, /\.echoink-source-chunks/);
    await assert.rejects(
      () => stat(path.join(fixture.vaultPath, "raw", ".echoink-source-chunks")),
      (error: NodeJS.ErrnoException) => error.code === "ENOENT"
    );
  } finally {
    await fixture.dispose();
  }
}

/**
 * This is a real KnowledgeBaseMaintenanceRunner + Shadow + WAL + settings
 * transaction test. Only the native Agent invocation is simulated.
 */
async function assertTwentySourcePartialCommitIsAtomic(): Promise<void> {
  const fixture = await createAcceptanceFixture({
    suffix: "19-of-20",
    selectedBackend: "codex-cli",
    sourceCount: SOURCE_COUNT,
    materialize: async (shadowVaultPath, input) => {
      await materializeIndependentEvidence({
        shadowVaultPath,
        reportPath: input.reportPath,
        sourcePaths: input.sourcePaths,
        verifiedPaths: input.sourcePaths.slice(0, VERIFIED_COUNT),
        includeUnsafeSharedIndexEntry: true
      });
    }
  });

  try {
    const result = await fixture.runner.runMaintenance(
      "maintain",
      "/maintain acceptance 19 of 20",
      { workflowRunId: "acceptance-19-of-20" },
      "codex-cli"
    );

    assert.equal(result.status, "success", result.error);
    assert.equal(result.completion, "partial");
    assert.equal(result.commitState, "committed");
    assert.equal(result.terminalPhase, "finalized");
    assert.deepEqual(fixture.executedBackends, ["codex-cli"]);
    assert.deepEqual(fixture.readinessChecks, []);
    assert.deepEqual(
      result.processedSources.map((source) => source.relativePath).sort(),
      fixture.sourcePaths.slice(0, VERIFIED_COUNT)
    );
    assert.deepEqual(result.pendingSources, [fixture.sourcePaths[PENDING_INDEX - 1]]);
    assert.deepEqual(
      Object.keys(fixture.settings.knowledgeBase.processedSources).sort(),
      fixture.sourcePaths.slice(0, VERIFIED_COUNT)
    );

    const registry = await readRawDigestRegistry(fixture.vaultPath);
    assert.deepEqual(
      Object.keys(registry.entries).sort(),
      fixture.sourcePaths.slice(0, VERIFIED_COUNT)
    );

    for (const relativePath of fixture.sourcePaths.slice(0, VERIFIED_COUNT)) {
      const raw = await readFile(path.join(fixture.vaultPath, relativePath));
      const fingerprint = fixture.bodyFingerprints[relativePath]!;
      const record = rawDigestRecordFromMarkdown(raw);
      const processed = fixture.settings.knowledgeBase.processedSources[relativePath];
      const registryEntry = registry.entries[relativePath];
      assert.equal(rawDigestFingerprint(relativePath, raw), fingerprint);
      assert.equal(rawDigestRecordIsTrusted(record, fingerprint), true);
      assert.ok(processed, `${relativePath} must be present in settings`);
      assert.ok(registryEntry, `${relativePath} must be present in registry`);
      assertProcessedRegistryAndRawAgree(
        relativePath,
        processed,
        registryEntry,
        record
      );
    }

    const pendingPath = fixture.sourcePaths[PENDING_INDEX - 1]!;
    const pendingRaw = await readFile(path.join(fixture.vaultPath, pendingPath));
    assert.equal(rawDigestRecordFromMarkdown(pendingRaw), null);
    assert.equal(fixture.settings.knowledgeBase.processedSources[pendingPath], undefined);
    assert.equal(registry.entries[pendingPath], undefined);

    const sharedIndex = await readFile(
      path.join(fixture.vaultPath, "wiki", "index.md"),
      "utf8"
    );
    for (let index = 1; index <= VERIFIED_COUNT; index += 1) {
      assert.match(
        sharedIndex,
        new RegExp(`acceptance-${pad(index)}`),
        `shared index must retain committed page ${index}`
      );
    }
    assert.doesNotMatch(
      sharedIndex,
      /acceptance-20/,
      "shared index must not retain the pending source's Agent-authored entry"
    );

    const report = await readFile(
      path.join(fixture.vaultPath, result.reportPath),
      "utf8"
    );
    assert.match(report, /- 结果：partial/);
    assert.match(report, /### 已验证来源（19）/);
    assert.match(report, /### 待处理来源（1）/);
    assert.match(report, /raw\/articles\/source-20\.md/);
    assert.equal(
      fixture.settings.knowledgeBase.maintenanceHistory.filter(
        (entry) => entry.runId === "acceptance-19-of-20"
      ).length,
      1
    );
  } finally {
    await fixture.dispose();
  }
}

async function assertTwentyOneSourceBatchLimitStaysPending(): Promise<void> {
  const fixture = await createAcceptanceFixture({
    suffix: "20-of-21-batch-limit",
    selectedBackend: "codex-cli",
    sourceCount: SOURCE_COUNT + 1,
    materialize: async (shadowVaultPath, input) => {
      assert.equal(
        input.sourcePaths.length,
        SOURCE_COUNT,
        "the Agent must receive only the bounded 20-source batch"
      );
      await materializeIndependentEvidence({
        shadowVaultPath,
        reportPath: input.reportPath,
        sourcePaths: input.sourcePaths,
        verifiedPaths: input.sourcePaths,
        includeUnsafeSharedIndexEntry: false
      });
    }
  });

  try {
    const result = await fixture.runner.runMaintenance(
      "maintain",
      "/maintain acceptance 20 of 21",
      { workflowRunId: "acceptance-20-of-21" },
      "codex-cli"
    );

    assert.equal(result.status, "success", result.error);
    assert.equal(result.completion, "partial");
    assert.deepEqual(result.pendingSources, [fixture.sourcePaths[20]]);
    assert.equal(result.processedSources.length, SOURCE_COUNT);
    assert.equal(
      fixture.settings.knowledgeBase.processedSources[fixture.sourcePaths[20]!],
      undefined,
      "the source outside the bounded Agent batch must remain pending"
    );
    assert.deepEqual(fixture.executedBackends, ["codex-cli"]);
    assert.equal(result.attempts?.length, 1);
  } finally {
    await fixture.dispose();
  }
}

async function assertTwentyOneUnchangedReingestStaysPending(): Promise<void> {
  const attachedBatches: string[][] = [];
  const fixture = await createAcceptanceFixture({
    suffix: "20-of-21-unchanged-reingest",
    selectedBackend: "codex-cli",
    sourceCount: SOURCE_COUNT + 1,
    materialize: async (shadowVaultPath, input) => {
      attachedBatches.push([...input.sourcePaths]);
      await materializeIndependentEvidence({
        shadowVaultPath,
        reportPath: input.reportPath,
        sourcePaths: input.sourcePaths,
        verifiedPaths: input.sourcePaths,
        includeUnsafeSharedIndexEntry: false
      });
    }
  });

  try {
    for (const relativePath of fixture.sourcePaths) {
      const fileStat = await stat(path.join(fixture.vaultPath, relativePath));
      fixture.settings.knowledgeBase.processedSources[relativePath] = {
        path: relativePath,
        size: fileStat.size,
        mtime: fileStat.mtimeMs,
        fingerprint: fixture.bodyFingerprints[relativePath],
        digestedAt: 1,
        reportPath: "outputs/maintenance/kb-maintenance-previous.md",
        evidencePaths: ["wiki/previous.md"],
        runId: "acceptance-reingest-previous",
        confidence: "verified"
      };
    }

    const result = await fixture.runner.runMaintenance(
      "reingest",
      "/reingest",
      { workflowRunId: "acceptance-reingest-20-of-21" },
      "codex-cli"
    );
    const attached = attachedBatches.at(-1) ?? [];
    const attachedSet = new Set(attached);
    const expectedPending = fixture.sourcePaths.filter(
      (relativePath) => !attachedSet.has(relativePath)
    );

    assert.equal(result.status, "success", result.error);
    assert.equal(result.completion, "partial");
    assert.equal(attached.length, SOURCE_COUNT);
    assert.equal(expectedPending.length, 1);
    assert.deepEqual(result.pendingSources, expectedPending);
    assert.equal(result.processedSources.length, SOURCE_COUNT);
    assert.deepEqual(
      fixture.settings.knowledgeBase.maintenanceHistory.find(
        (entry) => entry.runId === "acceptance-reingest-20-of-21"
      )?.pendingSources,
      expectedPending,
      "the durable history must retain the 21st unchanged reingest source"
    );
  } finally {
    await fixture.dispose();
  }
}

async function assertDurableNoopPreservesExistingKnowledgeArtifacts(): Promise<void> {
  const fixture = await createAcceptanceFixture({
    suffix: "durable-noop-preservation",
    selectedBackend: "codex-cli",
    sourceCount: 1,
    materialize: async (shadowVaultPath, input) => {
      await materializeIndependentEvidence({
        shadowVaultPath,
        reportPath: input.reportPath,
        sourcePaths: input.sourcePaths,
        verifiedPaths: input.sourcePaths,
        includeUnsafeSharedIndexEntry: false
      });
    }
  });

  try {
    const seed = await fixture.runner.runMaintenance(
      "maintain",
      "/maintain",
      { workflowRunId: "acceptance-noop-seed" },
      "codex-cli"
    );
    assert.equal(seed.status, "success", seed.error);
    assert.equal(seed.completion, "full");

    const preservedPaths = [
      fixture.reportPath,
      "outputs/.ingest-tracker.md",
      "raw/index.md",
      fixture.sourcePaths[0]!,
      "wiki/index.md",
      "wiki/acceptance-01.md"
    ];
    const before = await snapshotFiles(fixture.vaultPath, preservedPaths);
    const agentCallsBeforeNoop = fixture.executedBackends.length;

    const first = await fixture.runner.runMaintenance(
      "maintain",
      "/maintain",
      { workflowRunId: "acceptance-noop-first" },
      "opencode"
    );
    const second = await fixture.runner.runMaintenance(
      "maintain",
      "/maintain",
      { workflowRunId: "acceptance-noop-second" },
      "hermes"
    );

    for (const result of [first, second]) {
      assert.equal(result.status, "success", result.error);
      assert.equal(result.completion, "noop");
      assert.equal(result.winnerBackend, null);
      assert.deepEqual(result.attempts, []);
      assert.equal(result.performance?.agentCalled, false);
      assert.match(
        result.reportPath,
        /^outputs\/maintenance\/kb-maintenance-noop-\d{4}-\d{2}-\d{2}-[a-f0-9]{64}\.md$/
      );
    }
    assert.notEqual(first.reportPath, fixture.reportPath);
    assert.notEqual(second.reportPath, fixture.reportPath);
    assert.notEqual(first.reportPath, second.reportPath);
    assert.equal(
      fixture.executedBackends.length,
      agentCallsBeforeNoop,
      "durable noop must not invoke any Agent"
    );
    assert.deepEqual(
      await snapshotFiles(fixture.vaultPath, preservedPaths),
      before,
      "noop must preserve all existing report, Raw, Wiki, tracker, and index files byte-for-byte without replacing them"
    );

    const firstReceipt = await readFile(
      path.join(fixture.vaultPath, first.reportPath),
      "utf8"
    );
    const secondReceipt = await readFile(
      path.join(fixture.vaultPath, second.reportPath),
      "utf8"
    );
    assert.match(firstReceipt, /agent_called: false/);
    assert.match(firstReceipt, /- 结果：noop/);
    assert.match(firstReceipt, /acceptance-noop-first/);
    assert.match(secondReceipt, /agent_called: false/);
    assert.match(secondReceipt, /- 结果：noop/);
    assert.match(secondReceipt, /acceptance-noop-second/);

    const noopHistory = fixture.settings.knowledgeBase.maintenanceHistory
      .filter((entry) => entry.runId?.startsWith("acceptance-noop-") && entry.runId !== "acceptance-noop-seed");
    assert.deepEqual(
      noopHistory.map((entry) => ({
        runId: entry.runId,
        reportPath: entry.reportPath,
        completion: entry.completion,
        winnerBackend: entry.winnerBackend,
        attempts: entry.attempts
      })),
      [
        {
          runId: "acceptance-noop-first",
          reportPath: first.reportPath,
          completion: "noop",
          winnerBackend: null,
          attempts: []
        },
        {
          runId: "acceptance-noop-second",
          reportPath: second.reportPath,
          completion: "noop",
          winnerBackend: null,
          attempts: []
        }
      ],
      "each noop run must keep an independent durable history/report binding"
    );
  } finally {
    await fixture.dispose();
  }
}

async function assertSkippedSourcesCannotBecomeNoop(): Promise<void> {
  const fixture = await createAcceptanceFixture({
    suffix: "skipped-source-not-noop",
    selectedBackend: "codex-cli",
    sourceCount: 0,
    materialize: async () => {
      assert.fail("an unreadable pending source must not invoke an Agent or become noop");
    }
  });
  const relativePath = "raw/articles/oversized.pdf";

  try {
    await mkdir(path.dirname(path.join(fixture.vaultPath, relativePath)), {
      recursive: true
    });
    await writeFile(
      path.join(fixture.vaultPath, relativePath),
      Buffer.alloc(262_145, 0x61)
    );
    const result = await fixture.runner.runMaintenance(
      "maintain",
      "/maintain",
      { workflowRunId: "acceptance-skipped-source" },
      "codex-cli"
    );

    assert.equal(result.status, "failed");
    assert.notEqual(result.completion, "noop");
    assert.equal(result.failureCode, "MAINTENANCE_SOURCES_PENDING");
    assert.deepEqual(result.pendingSources, [relativePath]);
    assert.equal(result.winnerBackend, null);
    assert.deepEqual(result.attempts, []);
    assert.deepEqual(fixture.executedBackends, []);
    const history = fixture.settings.knowledgeBase.maintenanceHistory
      .find((entry) => entry.runId === "acceptance-skipped-source");
    assert.deepEqual(history?.pendingSources, [relativePath]);
    assert.equal(history?.completion, undefined);
  } finally {
    await fixture.dispose();
  }
}

async function assertMixedReadableAndSkippedSourcesCommitPartial(): Promise<void> {
  const fixture = await createAcceptanceFixture({
    suffix: "mixed-readable-and-skipped",
    selectedBackend: "codex-cli",
    sourceCount: 1,
    materialize: async (shadowVaultPath, input) => {
      await materializeIndependentEvidence({
        shadowVaultPath,
        reportPath: input.reportPath,
        sourcePaths: input.sourcePaths,
        verifiedPaths: input.sourcePaths,
        includeUnsafeSharedIndexEntry: false
      });
    }
  });
  const skippedPath = "raw/articles/oversized-mixed.pdf";

  try {
    await writeFile(
      path.join(fixture.vaultPath, skippedPath),
      Buffer.alloc(262_145, 0x62)
    );
    const result = await fixture.runner.runMaintenance(
      "maintain",
      "/maintain mixed readable and skipped",
      { workflowRunId: "acceptance-mixed-skipped-partial" },
      "codex-cli"
    );

    assert.equal(result.status, "success", result.error);
    assert.equal(result.completion, "partial");
    assert.deepEqual(result.pendingSources, [skippedPath]);
    assert.deepEqual(
      result.processedSources.map((source) => source.relativePath),
      [fixture.sourcePaths[0]]
    );
    assert.ok(
      fixture.settings.knowledgeBase.processedSources[fixture.sourcePaths[0]!]
    );
    assert.equal(
      fixture.settings.knowledgeBase.processedSources[skippedPath],
      undefined
    );
    assert.deepEqual(
      fixture.settings.knowledgeBase.maintenanceHistory.find(
        (entry) => entry.runId === "acceptance-mixed-skipped-partial"
      )?.pendingSources,
      [skippedPath]
    );

    const report = await readFile(
      path.join(fixture.vaultPath, result.reportPath),
      "utf8"
    );
    assert.match(report, /- 结果：partial/);
    assert.match(report, /### 待处理来源（1）/);
    assert.match(report, /raw\/articles\/oversized-mixed\.pdf/);
  } finally {
    await fixture.dispose();
  }
}

/**
 * Deepest deterministic parity layer available without standing up real
 * Codex/OpenCode/Hermes transports. Each invocation adapter is represented by
 * the same contract-level fence acknowledgement and artifact materialization;
 * everything after that point is production Runner code:
 * Shadow -> evidence verification -> WAL -> managed writes -> settings.
 *
 * This must not be described as a native-adapter parity test.
 */
async function assertBusinessHarnessParityBelowInvocationAdapter(): Promise<void> {
  const snapshots = new Map<AgentBackendKind, HarnessParitySnapshot>();
  for (const backend of ["codex-cli", "opencode", "hermes"] as const) {
    const fixture = await createAcceptanceFixture({
      suffix: `parity-${backend}`,
      selectedBackend: backend,
      sourceCount: 2,
      materialize: async (shadowVaultPath, input) => {
        await materializeIndependentEvidence({
          shadowVaultPath,
          reportPath: input.reportPath,
          sourcePaths: input.sourcePaths,
          verifiedPaths: input.sourcePaths,
          includeUnsafeSharedIndexEntry: false
        });
      }
    });
    try {
      const result = await fixture.runner.runMaintenance(
        "maintain",
        "/maintain acceptance adapter parity",
        { workflowRunId: `acceptance-parity-${backend}` },
        backend
      );
      assert.equal(result.status, "success", result.error);
      assert.equal(result.completion, "full");
      assert.equal(result.commitState, "committed");
      assert.equal(result.terminalPhase, "finalized");
      assert.deepEqual(fixture.executedBackends, [backend]);
      assert.deepEqual(fixture.readinessChecks, []);
      assert.deepEqual(result.attempts?.map((attempt) => attempt.backend), [backend]);
      snapshots.set(
        backend,
        await captureParitySnapshot(fixture, result)
      );
    } finally {
      await fixture.dispose();
    }
  }

  const codex = snapshots.get("codex-cli");
  const opencode = snapshots.get("opencode");
  const hermes = snapshots.get("hermes");
  assert.ok(codex && opencode && hermes);

  const withoutAttemptBackend = (
    snapshot: HarnessParitySnapshot
  ): Omit<HarnessParitySnapshot, "attemptBackends"> => {
    const { attemptBackends: _attemptBackends, ...business } = snapshot;
    return business;
  };
  assert.deepEqual(
    withoutAttemptBackend(opencode),
    withoutAttemptBackend(codex),
    "OpenCode must produce the same post-adapter business commit as Codex"
  );
  assert.deepEqual(
    withoutAttemptBackend(hermes),
    withoutAttemptBackend(codex),
    "Hermes must produce the same post-adapter business commit as Codex"
  );
}

async function assertReingestDurableTerminalRoundTrips(): Promise<void> {
  const workflowRunId = "acceptance-reingest-durable-terminal";
  const fixture = await createAcceptanceFixture({
    suffix: "reingest-durable-terminal",
    mode: "reingest",
    selectedBackend: "opencode",
    sourceCount: 1,
    materialize: async (shadowVaultPath, input) => {
      await materializeIndependentEvidence({
        shadowVaultPath,
        reportPath: input.reportPath,
        sourcePaths: input.sourcePaths,
        verifiedPaths: input.sourcePaths,
        includeUnsafeSharedIndexEntry: false
      });
    }
  });

  try {
    const result = await fixture.runner.runMaintenance(
      "reingest",
      `/reingest ${fixture.sourcePaths[0]}`,
      { workflowRunId },
      "opencode"
    ) as KnowledgeBaseDurableMaintenanceResult;
    assertDurableMaintenanceResult(result);
    assert.equal(result.status, "success", result.error);
    assert.equal(result.workflowRunId, workflowRunId);
    assert.equal(result.selectedBackend, "opencode");
    assert.equal(result.winnerBackend, "opencode");
    assert.equal(result.attempts.length, 1);
    assert.equal(result.attempts[0]?.backend, "opencode");
    assert.equal(result.attempts[0]?.terminal?.status, "completed");
    assert.equal(result.terminalPhase, "finalized");
    assert.equal(result.failureCode, null);
    assert.equal(result.commitState, "committed");
    assert.equal(result.completion, "full");

    const roundTrippedSettings = normalizeSettingsData(
      JSON.parse(JSON.stringify(fixture.settings))
    ).settings;
    const history = roundTrippedSettings.knowledgeBase.maintenanceHistory
      .filter((entry) => entry.runId === workflowRunId);
    assert.equal(history.length, 1);
    assert.equal(history[0]?.mode, "reingest");
    assert.equal(history[0]?.selectedBackend, result.selectedBackend);
    assert.equal(history[0]?.winnerBackend, result.winnerBackend);
    assert.deepEqual(history[0]?.attempts, result.attempts);
    assert.equal(history[0]?.terminalPhase, result.terminalPhase);
    assert.equal(history[0]?.failureCode, result.failureCode);
    assert.equal(history[0]?.commitState, result.commitState);
    assert.equal(history[0]?.completion, result.completion);
  } finally {
    await fixture.dispose();
  }
}

async function assertActiveRunJournalCleanupRequiresUniqueDurableHistory(): Promise<void> {
  const cases = [
    { label: "unique-complete", history: "unique", blocked: false },
    { label: "duplicate", history: "duplicate", blocked: true },
    { label: "incomplete", history: "incomplete", blocked: true }
  ] as const;

  for (const testCase of cases) {
    const fixture = await createAcceptanceFixture({
      suffix: `active-history-${testCase.label}`,
      selectedBackend: "codex-cli",
      sourceCount: 0,
      materialize: async () => {
        assert.fail("deterministic no-op reconciliation must not invoke an Agent");
      }
    });
    const orphanedRunId = `active-history-${testCase.label}-terminal`;
    const nextRunId = `active-history-${testCase.label}-next`;
    try {
      await mkdir(fixture.storageRootPath, { recursive: true, mode: 0o700 });
      const active = await createActiveMaintenanceRunJournal({
        storageRootPath: fixture.storageRootPath,
        workflowRunId: orphanedRunId,
        mode: "maintain",
        startedAt: 1_721_260_800_000,
        selectedBackend: "codex-cli",
        attempts: [],
        terminalPhase: "preflight"
      });
      const canonical: KnowledgeBaseMaintenanceHistoryEntry = {
        date: "2026-07-18",
        status: "failed",
        at: 1_721_260_800_100,
        runId: orphanedRunId,
        mode: "maintain",
        reportPath: "",
        selectedBackend: "codex-cli",
        winnerBackend: null,
        attempts: [],
        failureCode: "prior-pre-wal-failure",
        terminalPhase: "preflight",
        commitState: "pre-wal"
      };
      if (testCase.history === "unique") {
        fixture.settings.knowledgeBase.maintenanceHistory.push(canonical);
      } else if (testCase.history === "duplicate") {
        fixture.settings.knowledgeBase.maintenanceHistory.push(
          canonical,
          structuredClone(canonical)
        );
      } else {
        const incomplete: KnowledgeBaseMaintenanceHistoryEntry = {
          ...canonical
        };
        delete incomplete.commitState;
        fixture.settings.knowledgeBase.maintenanceHistory.push(incomplete);
      }

      const result = await fixture.runner.runMaintenance(
        "maintain",
        `/maintain active history ${testCase.label}`,
        { workflowRunId: nextRunId },
        "codex-cli"
      );
      const remaining = await listActiveMaintenanceRunJournals(
        fixture.storageRootPath
      );

      if (!testCase.blocked) {
        assert.equal(result.status, "success", result.error);
        assert.equal(result.completion, "noop");
        assert.deepEqual(
          remaining,
          [],
          "one complete canonical history must permit terminal journal cleanup"
        );
      } else {
        assert.equal(result.status, "failed");
        assert.equal(result.failureCode, "MAINTENANCE_RECOVERY_BLOCKED");
        assert.equal(result.terminalPhase, "recovery-blocked");
        assert.equal(result.commitState, "pre-wal");
        assert.equal(result.completion, undefined);
        assert.equal(remaining.length, 1);
        assert.deepEqual(
          remaining[0]?.record,
          active.record,
          `${testCase.history} history must preserve the exact active journal`
        );
      }
      assert.deepEqual(fixture.executedBackends, []);
      assert.deepEqual(fixture.readinessChecks, []);
    } finally {
      await fixture.dispose();
    }
  }
}

async function createAcceptanceFixture(input: {
  suffix: string;
  mode?: "maintain" | "reingest" | "lint";
  selectedBackend: AgentBackendKind;
  sourceCount: number;
  materialize(
    shadowVaultPath: string,
    input: {
      reportPath: string;
      sourcePaths: string[];
      backend: AgentBackendKind;
      prompt: string;
    }
  ): Promise<void>;
}): Promise<AcceptanceFixture> {
  const rootPath = await mkdtemp(
    path.join(tmpdir(), `echoink-maintenance-acceptance-${input.suffix}-`)
  );
  const vaultPath = path.join(rootPath, "vault");
  const storageRootPath = path.join(rootPath, "maintenance-storage");
  const settings = normalizeSettingsData({
    ...structuredClone(DEFAULT_SETTINGS),
    settingsVersion: DEFAULT_SETTINGS.settingsVersion,
    agentBackend: input.selectedBackend,
    knowledgeBase: {
      ...structuredClone(DEFAULT_SETTINGS.knowledgeBase),
      useCustomRulesFile: true,
      rulesFilePath: DEFAULT_KNOWLEDGE_BASE_RULES_FILE
    }
  }).settings;
  const sourcePaths: string[] = [];
  const bodyFingerprints: Record<string, string> = {};
  const readinessChecks: AgentBackendKind[] = [];
  const executedBackends: AgentBackendKind[] = [];
  let running = false;
  let commitPhaseLocked = false;

  try {
    await Promise.all([
      mkdir(path.join(vaultPath, "raw", "articles"), { recursive: true }),
      mkdir(path.join(vaultPath, "wiki"), { recursive: true }),
      mkdir(path.dirname(path.join(vaultPath, DEFAULT_KNOWLEDGE_BASE_RULES_FILE)), {
        recursive: true
      })
    ]);
    await writeFile(
      path.join(vaultPath, DEFAULT_KNOWLEDGE_BASE_RULES_FILE),
      "# Acceptance knowledge rules\n",
      "utf8"
    );
    await writeFile(path.join(vaultPath, "raw", "index.md"), "# Raw\n", "utf8");
    await writeFile(path.join(vaultPath, "wiki", "index.md"), "# Wiki\n", "utf8");

    for (let index = 1; index <= input.sourceCount; index += 1) {
      const relativePath = `raw/articles/source-${pad(index)}.md`;
      const content = Buffer.from(
        [
          "---",
          `title: Acceptance Source ${pad(index)}`,
          "tags:",
          "  - acceptance",
          "---",
          `# Source ${pad(index)}`,
          "",
          `独立正文 ${pad(index)}，用于验证逐来源部分提交。`,
          ""
        ].join("\n"),
        "utf8"
      );
      await writeFile(path.join(vaultPath, relativePath), content);
      sourcePaths.push(relativePath);
      bodyFingerprints[relativePath] =
        rawDigestFingerprint(relativePath, content);
    }
    const reportPath = (
      await discoverKnowledgeBaseSources(
        vaultPath,
        settings.knowledgeBase.processedSources,
        input.mode ?? "maintain"
      )
    ).reportPath;
    const settingsHost = createSettingsHost(settings);
    const context: KnowledgeBaseMaintenanceRunnerContext = {
      isRunning: () => running,
      beginRun: () => {
        assert.equal(running, false);
        running = true;
      },
      finishRun: () => {
        running = false;
        commitPhaseLocked = false;
      },
      isCancelRequested: () => false,
      tryEnterCommitPhase: () => {
        if (commitPhaseLocked) return false;
        commitPhaseLocked = true;
        return true;
      },
      isCommitPhaseLocked: () => commitPhaseLocked,
      resolveRulesFile: async () => ({
        relativePath: DEFAULT_KNOWLEDGE_BASE_RULES_FILE,
        absolutePath: path.join(vaultPath, DEFAULT_KNOWLEDGE_BASE_RULES_FILE),
        exists: true,
        useCustomRulesFile: true
      }),
      isMaintenanceBackendReady: async (backend) => {
        readinessChecks.push(backend);
        return true;
      },
      runKnowledgeAgentTask: async (task) => {
        const backend = task.backend;
        assert.ok(backend);
        executedBackends.push(backend);
        assert.ok(task.vaultPathOverride);
        assert.ok(task.exactWriteFence);
        assert.ok(task.onExactWriteFenceConfigured);
        const receipt = createExactWriteFenceReceipt({
          backend,
          task: exactFenceTask(task),
          transport: `acceptance-${backend}-contract-adapter`,
          transportAck: {
            accepted: true,
            boundary: "below-invocation-adapter"
          }
        });
        await task.onExactWriteFenceConfigured(receipt);
        await input.materialize(task.vaultPathOverride, {
          reportPath,
          sourcePaths: task.sources.map((source) => source.relativePath),
          backend,
          prompt: task.prompt
        });
        return {
          text: "Acceptance Agent output: maintenance complete.",
          harnessRunId: `acceptance-harness-${backend}`,
          submittedAt: Date.now()
        };
      }
    };
    const plugin = {
      settings,
      getVaultPath: () => vaultPath,
      getKnowledgeBaseWorkflowStorageRoot: () => storageRootPath,
      getKnowledgeBaseWorkflowSettingsHost: () => settingsHost,
      saveSettings: async () => undefined
    };
    return {
      rootPath,
      vaultPath,
      storageRootPath,
      reportPath,
      sourcePaths,
      bodyFingerprints,
      settings,
      readinessChecks,
      executedBackends,
      runner: new KnowledgeBaseMaintenanceRunner(plugin as never, context),
      async dispose(): Promise<void> {
        await makeOwnerWritable(rootPath);
        await rm(rootPath, { recursive: true, force: true });
      }
    };
  } catch (error) {
    await makeOwnerWritable(rootPath).catch(() => undefined);
    await rm(rootPath, { recursive: true, force: true });
    throw error;
  }
}

function exactFenceTask(
  input: Parameters<KnowledgeBaseMaintenanceRunnerContext["runKnowledgeAgentTask"]>[0]
): AgentTaskInput {
  return {
    prompt: input.prompt,
    permission: input.permission,
    writableRoots: input.writableRootsOverride,
    requireExactWriteFence: true,
    exactWriteFence: input.exactWriteFence
  };
}

async function materializeIndependentEvidence(input: {
  shadowVaultPath: string;
  reportPath: string;
  sourcePaths: string[];
  verifiedPaths: string[];
  includeUnsafeSharedIndexEntry: boolean;
}): Promise<void> {
  const links: string[] = [];
  for (const relativePath of input.verifiedPaths) {
    const index = sourceOrdinal(relativePath);
    const pagePath = `wiki/acceptance-${pad(index)}.md`;
    links.push(`- [[${withoutMarkdownExtension(pagePath)}|Acceptance ${pad(index)}]]`);
    await writeText(
      input.shadowVaultPath,
      pagePath,
      [
        `# Acceptance ${pad(index)}`,
        "",
        `本轮来源：[[${withoutMarkdownExtension(relativePath)}]]`,
        `核心要点：来源 ${pad(index)} 已独立完成结构化提炼，可单独验证和提交。`,
        ""
      ].join("\n")
    );
  }
  if (input.includeUnsafeSharedIndexEntry) {
    links.push("- [[wiki/acceptance-20|Acceptance 20 pending]]");
  }
  await writeText(
    input.shadowVaultPath,
    "wiki/index.md",
    [
      "# Wiki",
      "",
      "人工维护说明必须保留。",
      "",
      ...links,
      ""
    ].join("\n")
  );
  await writeText(
    input.shadowVaultPath,
    input.reportPath,
    [
      "---",
      "source: codex-echoink",
      "---",
      "",
      "# 知识库维护报告",
      "",
      "## 本轮来源",
      ...input.sourcePaths.map(
        (relativePath) => `- [[${withoutMarkdownExtension(relativePath)}]]`
      ),
      ""
    ].join("\n")
  );
}

async function captureParitySnapshot(
  fixture: AcceptanceFixture,
  result: KnowledgeBaseRunResult
): Promise<HarnessParitySnapshot> {
  const registry = await readRawDigestRegistry(fixture.vaultPath);
  const normalizedRegistry = Object.fromEntries(
    Object.entries(registry.entries).map(([relativePath, entry]) => [
      relativePath,
      {
        rawPath: entry.rawPath,
        fingerprint: entry.fingerprint,
        reportPath: normalizeReportPath(entry.reportPath),
        evidencePaths: [...entry.evidencePaths].sort(),
        confidence: entry.confidence
      }
    ])
  );
  const normalizedProcessed = Object.fromEntries(
    Object.entries(fixture.settings.knowledgeBase.processedSources).map(
      ([relativePath, entry]) => [
        relativePath,
        {
          path: entry.path,
          fingerprint: entry.fingerprint,
          reportPath: normalizeReportPath(entry.reportPath ?? ""),
          evidencePaths: [...(entry.evidencePaths ?? [])].sort(),
          confidence: entry.confidence
        }
      ]
    )
  );
  const wikiBodies: Record<string, string> = {};
  for (let index = 1; index <= fixture.sourcePaths.length; index += 1) {
    const relativePath = `wiki/acceptance-${pad(index)}.md`;
    wikiBodies[relativePath] = await readFile(
      path.join(fixture.vaultPath, relativePath),
      "utf8"
    );
  }
  const report = await readFile(
    path.join(fixture.vaultPath, result.reportPath),
    "utf8"
  );
  return {
    completion: result.completion,
    processedPaths: result.processedSources
      .map((source) => source.relativePath)
      .sort(),
    pendingPaths: [...(result.pendingSources ?? [])].sort(),
    attemptBackends: result.attempts?.map((attempt) => attempt.backend) ?? [],
    registry: normalizedRegistry,
    processed: normalizedProcessed,
    wikiBodies,
    reportFacts: {
      completion: report.match(/- 结果：(\w+)/)?.[1] ?? "",
      verifiedCount: Number(report.match(/### 已验证来源（(\d+)）/)?.[1] ?? -1),
      pendingCount: Number(report.match(/### 待处理来源（(\d+)）/)?.[1] ?? -1)
    }
  };
}

function assertProcessedRegistryAndRawAgree(
  relativePath: string,
  processed: KnowledgeBaseProcessedSource,
  registry: Awaited<ReturnType<typeof readRawDigestRegistry>>["entries"][string],
  raw: NonNullable<ReturnType<typeof rawDigestRecordFromMarkdown>>
): void {
  assert.equal(processed.path, relativePath);
  assert.equal(registry.rawPath, relativePath);
  assert.equal(processed.fingerprint, registry.fingerprint);
  assert.equal(raw.fingerprint, registry.fingerprint);
  assert.equal(processed.reportPath, registry.reportPath);
  assert.equal(raw.reportPath, registry.reportPath);
  assert.deepEqual(processed.evidencePaths, registry.evidencePaths);
  assert.deepEqual(raw.evidencePaths, registry.evidencePaths);
  assert.equal(processed.digestedAt, registry.digestedAt);
  assert.equal(raw.digestedAt, registry.digestedAt);
  assert.equal(processed.runId, registry.runId);
  assert.equal(processed.confidence, "verified");
  assert.equal(registry.confidence, "verified");
}

async function snapshotFiles(
  vaultPath: string,
  relativePaths: readonly string[]
): Promise<Record<string, { contentSha256: string; size: number; mtimeMs: number; ino: number }>> {
  return Object.fromEntries(await Promise.all(relativePaths.map(async (relativePath) => {
    const absolutePath = path.join(vaultPath, relativePath);
    const [content, fileStat] = await Promise.all([
      readFile(absolutePath),
      stat(absolutePath)
    ]);
    return [relativePath, {
      contentSha256: createHash("sha256").update(content).digest("hex"),
      size: fileStat.size,
      mtimeMs: fileStat.mtimeMs,
      ino: fileStat.ino
    }];
  })));
}

function createSettingsHost(
  settings: CodexForObsidianSettings
): MaintenanceWorkflowSettingsHost<KnowledgeBaseSettings> {
  let queue: Promise<void> = Promise.resolve();
  return {
    withExclusiveTransaction<R>(
      action: (
        transaction: MaintenanceWorkflowSettingsTransaction<KnowledgeBaseSettings>
      ) => Promise<R>
    ): Promise<R> {
      const run = queue.then(async () => {
        let baseline = structuredClone(settings.knowledgeBase);
        let generation = settingsGeneration(baseline);
        return await action({
          readWithGeneration: async () => ({
            settings: structuredClone(baseline),
            generation
          }),
          persistCas: async (expectedGeneration, target) => {
            const liveGeneration = settingsGeneration(settings.knowledgeBase);
            if (
              expectedGeneration !== generation
              || expectedGeneration !== liveGeneration
            ) {
              throw new MaintenanceWorkflowWalError(
                "settings_cas_conflict",
                "acceptance settings changed during transaction"
              );
            }
            settings.knowledgeBase = structuredClone(target);
            baseline = structuredClone(settings.knowledgeBase);
            generation = settingsGeneration(baseline);
            return {
              settings: structuredClone(baseline),
              generation
            };
          }
        });
      });
      queue = run.then(
        () => undefined,
        () => undefined
      );
      return run;
    }
  };
}

function settingsGeneration(settings: KnowledgeBaseSettings): string {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(settings))
    .digest("hex")}`;
}

async function writeText(
  rootPath: string,
  relativePath: string,
  text: string
): Promise<void> {
  const absolutePath = path.join(rootPath, relativePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, text, "utf8");
}

function withoutMarkdownExtension(relativePath: string): string {
  return relativePath.replace(/\.(?:md|markdown)$/i, "");
}

function sourceOrdinal(relativePath: string): number {
  const matched = relativePath.match(/source-(\d+)\.md$/);
  if (!matched) throw new Error(`unexpected source path: ${relativePath}`);
  return Number(matched[1]);
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function normalizeReportPath(relativePath: string): string {
  return relativePath.replace(
    /kb-maintenance-\d{4}-\d{2}-\d{2}\.md$/,
    "kb-maintenance-DATE.md"
  );
}

async function makeOwnerWritable(rootPath: string): Promise<void> {
  const rootStat = await lstat(rootPath).catch(() => null);
  if (!rootStat) return;
  if (rootStat.isSymbolicLink()) return;
  if (!rootStat.isDirectory()) {
    await chmod(rootPath, 0o600).catch(() => undefined);
    return;
  }
  await chmod(rootPath, 0o700).catch(() => undefined);
  const entries = await readdir(rootPath, { withFileTypes: true })
    .catch(() => []);
  for (const entry of entries) {
    await makeOwnerWritable(path.join(rootPath, entry.name));
  }
}

if (process.env.ECHOINK_RUN_MAINTENANCE_ACCEPTANCE_TEST === "1") {
  runMaintenanceAcceptanceTests().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
