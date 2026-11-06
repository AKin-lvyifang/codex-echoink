import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { mock } from "node:test";
import { getDesktopFsPromises } from "../../platform/desktop-filesystem";
import { FileConversationCatalog } from "../../harness/pi-native/file-conversation-catalog";
import { FileProductRunStore } from "../../harness/pi-native/file-product-run-store";
import {
  PI_NATIVE_FILE_SCHEMA_VERSION,
  PiNativeFileStoreError,
  atomicWriteJsonFile,
  serializePiNativeFileWrite
} from "../../harness/pi-native/file-store-utils";
import {
  FilePhase3MaintenanceStateStore,
  readPrivateMaintenanceRecords
} from "../../plugin/pi-knowledge-maintenance-production";
import { createKnowledgeMaintenanceResultEnvelope } from "../../knowledge-base/knowledge-maintenance-result";
import type { KnowledgeMaintenanceRecord } from "../../knowledge-base/maintenance-record";
import {
  knowledgeReferenceEntryDetails
} from "../../knowledge-base/usage";
import type { KnowledgeReference } from "../../knowledge-base/types";
import { runProductRunSnapshotTests } from "../pi-native/product-run-snapshots";

export async function runPiNativeFileStoreTests(): Promise<void> {
  assertKnowledgeReferenceContract();
  const storageRootPath = await mkdtemp(
    path.join(process.env.ECHOINK_TEST_ROOT || os.tmpdir(), "echoink-pi-native-file-stores-")
  );
  try {
    await assertAtomicRenameRetries(path.join(storageRootPath, "rename-retries"));
    await assertStoreRenameRetryChains(path.join(storageRootPath, "retry-chains"));
    let now = 1_000;
    const catalog = new FileConversationCatalog({
      storageRootPath,
      vaultId: "vault-a",
      now: () => ++now
    });
    await catalog.initialize();

    const sessionFile = catalog.sessionFilePath("pi-session-a");
    const created = await catalog.upsert({
      conversationId: "conversation-a",
      piSessionId: "pi-session-a",
      vaultId: "vault-a",
      title: "First",
      status: "active",
      defaultMemoryMode: "normal",
      createdAt: now,
      updatedAt: now
    });
    assert.equal(created.sessionFile, undefined);
    const withSessionFile = await catalog.sessionFile(
      "conversation-a",
      sessionFile,
      ++now
    );
    assert.equal(withSessionFile.sessionFile, sessionFile);
    await writeFile(sessionFile, "{\"type\":\"session\"}\n", "utf8");

    assert.equal((await catalog.list()).length, 1);
    assert.equal(await catalog.sessionFile("conversation-a"), sessionFile);
    assert.equal(
      (await catalog.rename("conversation-a", "Renamed", ++now)).title,
      "Renamed"
    );
    assert.equal(
      (await catalog.status("conversation-a", "archived", ++now)).status,
      "archived"
    );
    await catalog.status("conversation-a", "active", ++now);

    await catalog.drafts("conversation-a", [{
      draftId: "draft-abort",
      conversationId: "conversation-a",
      piSessionId: "pi-session-a",
      source: "abort",
      text: "do not auto-run",
      createdAt: ++now
    }]);
    await catalog.upsertDraft({
      draftId: "draft-follow-up",
      conversationId: "conversation-a",
      piSessionId: "pi-session-a",
      source: "follow_up",
      text: "follow later",
      createdAt: ++now
    });
    assert.deepEqual(
      (await catalog.drafts("conversation-a")).map((draft) => draft.draftId),
      ["draft-abort", "draft-follow-up"]
    );
    assert.equal(await catalog.removeDraft("draft-abort"), true);

    await Promise.all(Array.from({ length: 12 }, (_, index) =>
      catalog.appendDiagnostic({
        diagnosticId: `diagnostic-${index}`,
        conversationId: "conversation-a",
        piSessionId: "pi-session-a",
        code: "runtime_interrupted",
        message: `interrupted-${index}`,
        createdAt: ++now
      })
    ));
    assert.equal((await catalog.diagnostics("conversation-a")).length, 12);

    await assert.rejects(
      catalog.upsert({
        conversationId: "conversation-b",
        piSessionId: "pi-session-a",
        vaultId: "vault-a",
        title: "Reuse",
        status: "active",
        defaultMemoryMode: "normal",
        createdAt: ++now,
        updatedAt: now
      }),
      isStoreError("mapping-conflict")
    );

    const otherVaultCatalog = new FileConversationCatalog({
      storageRootPath,
      vaultId: "vault-b",
      now: () => ++now
    });
    await otherVaultCatalog.initialize();
    await assert.rejects(
      otherVaultCatalog.upsert({
        conversationId: "conversation-in-b",
        piSessionId: "pi-session-a",
        vaultId: "vault-b",
        title: "Cross Vault Reuse",
        status: "active",
        defaultMemoryMode: "normal",
        createdAt: ++now,
        updatedAt: now
      }),
      isStoreError("mapping-conflict")
    );
    await otherVaultCatalog.upsert({
      conversationId: "conversation-in-b",
      piSessionId: "pi-session-b",
      vaultId: "vault-b",
      title: "Independent Vault Conversation",
      status: "active",
      defaultMemoryMode: "normal",
      createdAt: ++now,
      updatedAt: now
    });

    const productRuns = new FileProductRunStore({
      storageRootPath,
      vaultId: "vault-a",
      catalog,
      now: () => ++now
    });
    await productRuns.initialize();
    await productRuns.create({
      productRunId: "run-a",
      conversationId: "conversation-a",
      piSessionId: "pi-session-a",
      userEntryId: "entry-user-a",
      toolCallIds: [],
      memoryMode: "normal",
      state: "accepted",
      activeLeafId: null,
      createdAt: ++now,
      updatedAt: now
    });
    await productRuns.update("run-a", {
      state: "running",
      activeLeafId: "entry-user-a",
      toolCallIds: ["tool-a"],
      memoryRecall: {
        result: "completed",
        stage: "assembling",
        elapsedMs: 28,
        scanned: 105,
        candidates: 12,
        injected: 4,
        remaining: 101,
        exhausted: false
      },
      knowledge: {
        workflow: "ask",
        localRetrievalElapsedMs: 17,
        candidates: 100,
        returned: 12,
        remaining: 88,
        hasMore: true,
        exhausted: false,
        continuationCount: 1,
        knowledgeReadCount: 2,
        memoryRecallUsed: true,
        memorySearchUsed: true,
        memoryReadUsed: false,
        conflictOrFreshnessTriggered: false,
        modelFirstTextLatencyMs: 31
      },
      updatedAt: ++now
    });
    const agentSettledAt = ++now;
    await productRuns.update("run-a", {
      state: "agent_settled",
      assistantEntryId: "entry-assistant-a",
      agentSettledAt,
      updatedAt: agentSettledAt
    });
    await productRuns.update("run-a", {
      state: "finalizing",
      terminalState: "completed",
      updatedAt: ++now
    });
    const settledAt = ++now;
    const settled = await productRuns.update("run-a", {
      state: "product_run_settled",
      settledAt,
      updatedAt: settledAt
    });
    assert.equal(settled.terminalState, "completed");
    assert.equal((await productRuns.read("run-a"))?.assistantEntryId, "entry-assistant-a");
    assert.deepEqual((await productRuns.read("run-a"))?.memoryRecall, {
      result: "completed",
      stage: "assembling",
      elapsedMs: 28,
      scanned: 105,
      candidates: 12,
      injected: 4,
      remaining: 101,
      exhausted: false
    });
    assert.deepEqual((await productRuns.read("run-a"))?.knowledge, {
      workflow: "ask",
      localRetrievalElapsedMs: 17,
      candidates: 100,
      returned: 12,
      remaining: 88,
      hasMore: true,
      exhausted: false,
      continuationCount: 1,
      knowledgeReadCount: 2,
      memoryRecallUsed: true,
      memorySearchUsed: true,
      memoryReadUsed: false,
      conflictOrFreshnessTriggered: false,
      modelFirstTextLatencyMs: 31
    });
    assert.equal((await productRuns.list("conversation-a")).length, 1);
    await assert.rejects(
      productRuns.update("run-a", {
        error: "late mutation",
        updatedAt: ++now
      }),
      isStoreError("invalid-transition")
    );

    const [runFileName] = (await readdir(productRuns.rootPath))
      .filter((name) => name.endsWith(".json"));
    assert.ok(runFileName);
    const runFilePath = path.join(productRuns.rootPath, runFileName);
    const legacyDocument = JSON.parse(
      await readFile(runFilePath, "utf8")
    ) as { run: { knowledge: { workflow: string } } };
    legacyDocument.run.knowledge.workflow = "maintain_preview";
    await writeFile(runFilePath, JSON.stringify(legacyDocument), "utf8");
    assert.equal(
      (await productRuns.list("conversation-a"))[0]?.knowledge?.workflow,
      "maintain_preview"
    );
    legacyDocument.run.knowledge.workflow = "maintain_confirm";
    await writeFile(runFilePath, JSON.stringify(legacyDocument), "utf8");
    assert.equal(
      (await productRuns.list("conversation-a"))[0]?.knowledge?.workflow,
      "maintain_confirm"
    );
    legacyDocument.run.knowledge.workflow = "maintain_unsafe";
    await writeFile(runFilePath, JSON.stringify(legacyDocument), "utf8");
    await assert.rejects(
      productRuns.list("conversation-a"),
      isStoreError("store-corrupt")
    );

    const catalogDocument = JSON.parse(
      await readFile(catalog.filePath, "utf8")
    ) as Record<string, unknown>;
    assert.equal(catalogDocument.schemaVersion, PI_NATIVE_FILE_SCHEMA_VERSION);
    assert.deepEqual(
      Object.keys(catalogDocument).sort(),
      ["diagnostics", "drafts", "entries", "schemaVersion", "vaultId"]
    );
    assert.equal("messages" in catalogDocument, false);
    assert.equal("transcript" in catalogDocument, false);

    await catalog.status("conversation-a", "deleted", ++now);
    await stat(sessionFile);
    await assert.rejects(
      catalog.status("conversation-a", "active", ++now),
      isStoreError("mapping-conflict")
    );

    await runProductRunSnapshotTests(path.join(storageRootPath, "agent-snapshots"));
    const allFiles = await readdir(storageRootPath, { recursive: true });
    assert.equal(allFiles.some((name) => name.endsWith(".tmp")), false);
  } finally {
    await rm(storageRootPath, { recursive: true, force: true });
  }
}

interface RenameFaultTrace {
  attempts: { temporaryPath: string; targetPath: string }[];
  waits: number[];
}

/** Patch only this sequential fixture's Node methods; restore even on failure. */
async function withRenameFaults(
  platform: NodeJS.Platform,
  failure: (targetPath: string, attempt: number) => Error | undefined,
  run: (trace: RenameFaultTrace) => Promise<void>
): Promise<void> {
  const fs = getDesktopFsPromises();
  const originalRename = fs.rename;
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  if (!windowDescriptor) Object.defineProperty(globalThis, "window", { configurable: true, value: globalThis });
  const originalTimeout = window.setTimeout;
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  const trace: RenameFaultTrace = { attempts: [], waits: [] };
  const attempts = new Map<string, number>();
  const snapshots = new Map<string, unknown>();
  Object.defineProperty(process, "platform", { ...platformDescriptor, value: platform });
  const renameMock = mock.method(fs, "rename", async (source, destination) => {
    const temporaryPath = String(source), targetPath = String(destination);
    assert.equal(path.dirname(temporaryPath), path.dirname(targetPath));
    assert.match(temporaryPath, /\.tmp$/u);
    const info = await stat(temporaryPath, { bigint: true });
    const snapshot = {
      bytes: await readFile(temporaryPath, "utf8"),
      ino: info.ino,
      mtimeNs: info.mtimeNs,
      ctimeNs: info.ctimeNs
    };
    if (snapshots.has(temporaryPath)) {
      assert.deepEqual(snapshot, snapshots.get(temporaryPath), "retry reuses the written temp without rewriting it");
    } else snapshots.set(temporaryPath, snapshot);
    trace.attempts.push({ temporaryPath, targetPath });
    const attempt = (attempts.get(targetPath) ?? 0) + 1;
    attempts.set(targetPath, attempt);
    const error = failure(targetPath, attempt);
    if (error) throw error;
    await originalRename(source, destination);
  });
  const timeoutMock = mock.method(window, "setTimeout", ((callback, delay, ...args) => {
    trace.waits.push(delay);
    return originalTimeout(callback, 0, ...args);
  }) as typeof setTimeout);
  try {
    await run(trace);
  } finally {
    timeoutMock.mock.restore();
    if (!windowDescriptor) Reflect.deleteProperty(globalThis, "window");
    renameMock.mock.restore();
    Object.defineProperty(process, "platform", platformDescriptor);
  }
}

function renameError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`synthetic rename ${code}`), { code });
}

async function assertAtomicRenameRetries(root: string): Promise<void> {
  for (const codes of [["EPERM"], ["EBUSY", "EBUSY"], ["EPERM", "EBUSY", "EPERM"]]) {
    const filePath = path.join(root, `${codes.join("-")}.json`);
    let businessWrites = 0, normalizations = 0, serializations = 0;
    await withRenameFaults("win32", (_target, attempt) => codes[attempt - 1] ? renameError(codes[attempt - 1]) : undefined, async trace => {
      const result = await serializePiNativeFileWrite(root, async () => {
        businessWrites++;
        return atomicWriteJsonFile(filePath, { version: 2 }, "retry fixture", value => {
          normalizations++;
          return { toJSON() { serializations++; return value; } };
        });
      });
      assert.ok(result);
      assert.equal(businessWrites, 1);
      assert.equal(normalizations, 1);
      assert.equal(serializations, 1);
      assert.equal(trace.attempts.length, codes.length + 1);
      assert.equal(new Set(trace.attempts.map(attempt => attempt.temporaryPath)).size, 1);
      assert.deepEqual(trace.waits, [25, 75, 150].slice(0, codes.length));
      assert.deepEqual(JSON.parse(await readFile(filePath, "utf8")), { version: 2 });
    });
  }

  for (const scenario of [
    { platform: "win32", codes: ["EPERM", "EPERM", "EPERM", "EPERM"], waits: [25, 75, 150] },
    { platform: "win32", codes: ["EBUSY", "EBUSY", "EBUSY", "EBUSY"], waits: [25, 75, 150] },
    { platform: "win32", codes: ["EACCES"], waits: [] },
    { platform: "win32", codes: ["EIO"], waits: [] },
    { platform: "win32", codes: ["EPERM", "ENOENT"], waits: [25] },
    { platform: "darwin", codes: ["EPERM"], waits: [] },
    { platform: "linux", codes: ["EBUSY"], waits: [] }
  ] as const) {
    const filePath = path.join(root, "failure.json");
    const previousBytes = '{"version":1}\n';
    await writeFile(filePath, previousBytes, "utf8");
    const errors = scenario.codes.map(renameError);
    await withRenameFaults(scenario.platform, (_target, attempt) => errors[attempt - 1], async trace => {
      await assert.rejects(
        atomicWriteJsonFile(filePath, { version: 2 }, "failure fixture", value => value),
        error => error === errors[errors.length - 1],
        "preserve the original filesystem error, including code"
      );
      assert.equal(trace.attempts.length, errors.length);
      assert.deepEqual(trace.waits, scenario.waits);
      assert.equal(await readFile(filePath, "utf8"), previousBytes);
      assert.equal((await readdir(root)).some(name => name.endsWith(".tmp")), false);
    });
  }
}

async function assertStoreRenameRetryChains(root: string): Promise<void> {
  const catalog = new FileConversationCatalog({ storageRootPath: root, vaultId: "retry-vault" });
  await catalog.initialize();
  await catalog.upsert({
    conversationId: "retry-conversation", piSessionId: "retry-session", vaultId: "retry-vault",
    title: "Initial", status: "active", defaultMemoryMode: "normal", createdAt: 1, updatedAt: 1
  });
  await withRenameFaults("win32", (target, attempt) => target === catalog.filePath && attempt <= 2 ? renameError(attempt === 1 ? "EPERM" : "EBUSY") : undefined, async trace => {
    const results = await Promise.all([
      catalog.rename("retry-conversation", "First queued update", 2),
      catalog.appendDiagnostic({
        diagnosticId: "retry-diagnostic", conversationId: "retry-conversation", piSessionId: "retry-session",
        code: "runtime_interrupted", message: "synthetic", createdAt: 3
      })
    ]);
    assert.equal(results[0].title, "First queued update");
    assert.deepEqual(trace.waits, [25, 75]);
    const writes = trace.attempts.filter(attempt => attempt.targetPath === catalog.filePath);
    assert.equal(writes.length, 4);
    assert.equal(new Set(writes.slice(0, 3).map(attempt => attempt.temporaryPath)).size, 1);
    assert.notEqual(writes[2].temporaryPath, writes[3].temporaryPath, "queued mutation starts after retried publication");
    assert.equal((await catalog.list())[0].title, "First queued update");
    assert.equal((await catalog.diagnostics("retry-conversation")).length, 1);
  });
  const catalogBytes = await readFile(catalog.filePath, "utf8");
  const catalogError = renameError("EBUSY");
  await withRenameFaults("win32", target => target === catalog.filePath ? catalogError : undefined, async trace => {
    await assert.rejects(catalog.rename("retry-conversation", "Must not publish", 4), error => error === catalogError);
    assert.equal(trace.attempts.length, 4);
    assert.equal(await readFile(catalog.filePath, "utf8"), catalogBytes);
  });
  // A rejected write must release the existing queue for the next operation.
  await catalog.rename("retry-conversation", "Queue recovered", 5);

  const stateRoot = path.join(await realpath(root), "maintenance");
  const state = new FilePhase3MaintenanceStateStore({ storageRootPath: stateRoot, vaultId: "retry-vault" });
  const record: KnowledgeMaintenanceRecord = {
    schemaVersion: 1, recordId: `maintenance-${"a".repeat(32)}`, runId: "retry-run", originConversationId: "retry-conversation",
    at: 1, date: "2026-11-01", result: createKnowledgeMaintenanceResultEnvelope({ status: "noop" }), sources: [], summary: "Synthetic initial",
    p1: { version: 1, phase: "plan", sourceFingerprints: {}, decompositions: [], writingPlan: [], drafts: {}, committedPages: {}, finalizedSources: [] }
  };
  await state.saveP1Record(record);
  let progressUpdates = 0;
  await withRenameFaults("win32", (_target, attempt) => attempt <= 2 ? renameError(attempt === 1 ? "EBUSY" : "EPERM") : undefined, async trace => {
    await Promise.all([
      state.updateP1Progress(record.recordId, saved => { progressUpdates++; saved.summary = "Synthetic updated"; }),
      state.updateP1Progress(record.recordId, saved => { progressUpdates++; saved.at++; })
    ]);
    assert.equal(progressUpdates, 2, "each business mutation runs once despite rename retry");
    assert.deepEqual(trace.waits, [25, 75]);
    assert.equal(trace.attempts.length, 4);
    assert.equal(new Set(trace.attempts.slice(0, 3).map(attempt => attempt.temporaryPath)).size, 1);
    const [saved] = await readPrivateMaintenanceRecords(stateRoot, { vaultId: "retry-vault" });
    assert.equal(saved.summary, "Synthetic updated");
    assert.equal(saved.at, 2, "serialized progress update retains preceding mutation");
  });
  const recordPath = path.join(stateRoot, "records", `${record.recordId}.json`);
  const previousRecord = await readFile(recordPath, "utf8");
  const stateError = renameError("EPERM");
  await withRenameFaults("win32", () => stateError, async trace => {
    await assert.rejects(state.updateP1Progress(record.recordId, saved => { saved.summary = "Must not publish"; }), error => error === stateError);
    assert.equal(trace.attempts.length, 4);
    assert.equal(await readFile(recordPath, "utf8"), previousRecord);
  });
  assert.equal((await readdir(root, { recursive: true })).some(name => name.endsWith(".tmp")), false);
}

function assertKnowledgeReferenceContract(): void {
  const legacyReference: KnowledgeReference = {
    referenceId: `knowledge-reference:${"a".repeat(64)}`,
    vaultRelativePath: "projects/echoink.md",
    title: "EchoInk",
    excerpt: "项目决定优先使用个人知识。",
    contentRevision: `sha256:${"b".repeat(64)}`,
    lineStart: 1,
    lineEnd: 1
  };
  const currentReference: KnowledgeReference = {
    ...legacyReference,
    sourceType: "projects",
    recordedAt: 1_700_000_000_000.25,
    publishedAt: "2026-08-30",
    verificationStatus: "local_revision_verified"
  };

  const currentDetails = knowledgeReferenceEntryDetails([currentReference]);
  assert.deepEqual(currentDetails.references, [currentReference]);
  assert.equal(Object.isFrozen(currentDetails), true);
  assert.equal(Object.isFrozen(currentDetails.references[0]), true);
  assert.deepEqual(
    knowledgeReferenceEntryDetails([legacyReference]).references,
    [legacyReference]
  );
  for (const sourceType of ["notes", "journal"] as const) {
    assert.equal(knowledgeReferenceEntryDetails([{ ...currentReference, sourceType }]).references[0].sourceType, sourceType);
  }

  const invalidReferences: Record<string, unknown>[] = [
    { ...currentReference, unknownField: true },
    { ...currentReference, sourceType: "assets" },
    { ...currentReference, recordedAt: Number.NaN },
    { ...currentReference, recordedAt: -1 },
    { ...currentReference, publishedAt: "2026-08-30\nforged" },
    { ...currentReference, publishedAt: "x".repeat(101) },
    { ...currentReference, verificationStatus: "web_verified" }
  ];
  for (const reference of invalidReferences) {
    assert.throws(
      () => knowledgeReferenceEntryDetails([
        reference as unknown as KnowledgeReference
      ]),
      isStoreError("invalid-input")
    );
  }
}

function isStoreError(
  code: PiNativeFileStoreError["code"]
): (error: unknown) => boolean {
  return (error) =>
    error instanceof PiNativeFileStoreError && error.code === code;
}
