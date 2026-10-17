import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FileConversationCatalog } from "../../harness/pi-native/file-conversation-catalog";
import { FileProductRunStore } from "../../harness/pi-native/file-product-run-store";
import {
  PI_NATIVE_FILE_SCHEMA_VERSION,
  PiNativeFileStoreError
} from "../../harness/pi-native/file-store-utils";
import {
  knowledgeReferenceEntryDetails
} from "../../knowledge-base/usage";
import type { KnowledgeReference } from "../../knowledge-base/types";

export async function runPiNativeFileStoreTests(): Promise<void> {
  assertKnowledgeReferenceContract();
  const storageRootPath = await mkdtemp(
    path.join(os.tmpdir(), "echoink-pi-native-file-stores-")
  );
  try {
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

    const allFiles = await readdir(storageRootPath, { recursive: true });
    assert.equal(allFiles.some((name) => name.endsWith(".tmp")), false);
  } finally {
    await rm(storageRootPath, { recursive: true, force: true });
  }
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
