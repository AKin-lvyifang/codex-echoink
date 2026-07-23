import * as assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  DurableAppendOnlyCasError,
  publishDurableAppendOnlyChain,
  resolveDurableAppendOnlyLayout
} from "../../harness/storage/durable-append-only-cas";
import {
  createOrLoadRecordRootBinding,
  loadRecordRootBinding,
  parseRecordRootBindingRef,
  parseRecordRootBinding,
  recordRootBindingRef,
  RecordRootRegistryError,
  verifyRecordRootBinding,
  verifyRecordRootBindingRef
} from "../../harness/storage/record-root-registry";

export async function runHarnessV2RecordRootRegistryTests(): Promise<void> {
  await assertPluginOwnedRootBindingIsIdempotentAndOpaque();
  await assertDifferentRootCannotReuseLogicalRootId();
  await assertLegacyEmptyChainClaimIsRecovered();
  await assertConcurrentAtomicChainPublishHasOneWinner();
  await assertAtomicChainClaimDoesNotExposeEmptyWinner();
  await assertAtomicChainClaimCrashHasDurableReadback();
  await assertVerificationRequiresDurableRegistryAuthority();
  await assertRootReplacementAndSymlinkFailClosed();
  await assertVaultManagedRootMustStayInsideItsBoundary();
  await assertConcurrentFirstRegistrationHasOneBindingWinner();
  await assertImmutableBindingChainRejectsRebinding();
  await assertFutureSchemaAndUnknownEntryFailClosed();
}

async function assertPluginOwnedRootBindingIsIdempotentAndOpaque(): Promise<void> {
  await withFixture("idempotent", async ({ storageRootPath }) => {
    const conversationRootPath = path.join(storageRootPath, "conversations-v2");
    await mkdir(conversationRootPath);
    const input = {
      storageRootPath,
      rootId: "conversation-v2",
      rootPath: conversationRootPath,
      boundaryRootPath: storageRootPath,
      authority: "plugin-owned" as const,
      createdAt: 1_721_260_800_000
    };
    const first = await createOrLoadRecordRootBinding(input);
    const replay = await createOrLoadRecordRootBinding({
      ...input,
      createdAt: input.createdAt + 10
    });

    assert.deepEqual(replay, first);
    assert.deepEqual(
      await loadRecordRootBinding({
        storageRootPath,
        rootId: input.rootId
      }),
      first
    );
    assert.deepEqual(recordRootBindingRef(first.binding), {
      registryId: first.binding.registryId,
      rootId: first.binding.rootId,
      authority: first.binding.authority,
      boundaryPathDigest: first.binding.boundaryPathDigest,
      rootPathDigest: first.binding.rootPathDigest,
      rootIdentity: first.binding.rootIdentity,
      revision: 0,
      digest: first.binding.digest
    });
    assert.throws(
      () => parseRecordRootBindingRef({
        ...recordRootBindingRef(first.binding),
        unknown: true
      }),
      RecordRootRegistryError
    );
    assert.deepEqual(
      await verifyRecordRootBindingRef(recordRootBindingRef(first.binding), {
        storageRootPath,
        rootPath: conversationRootPath,
        boundaryRootPath: storageRootPath
      }),
      first
    );
    await assert.rejects(
      () => verifyRecordRootBindingRef({
        ...recordRootBindingRef(first.binding),
        digest: `sha256:${"0".repeat(64)}`
      }, {
        storageRootPath,
        rootPath: conversationRootPath,
        boundaryRootPath: storageRootPath
      }),
      (error: unknown) => (
        error instanceof RecordRootRegistryError
        && error.code === "binding_mismatch"
      )
    );
    assert.equal(
      JSON.stringify(first.binding).includes(conversationRootPath),
      false,
      "binding records must not persist absolute local paths"
    );
    assert.equal(
      await verifyRecordRootBinding(first.binding, {
        storageRootPath,
        rootPath: conversationRootPath,
        boundaryRootPath: storageRootPath
      }),
      await realpath(conversationRootPath)
    );
  });
}

async function assertDifferentRootCannotReuseLogicalRootId(): Promise<void> {
  await withFixture("conflict", async ({ storageRootPath }) => {
    const firstRootPath = path.join(storageRootPath, "conversation-a");
    const secondRootPath = path.join(storageRootPath, "conversation-b");
    await mkdir(firstRootPath);
    await mkdir(secondRootPath);
    await createOrLoadRecordRootBinding({
      storageRootPath,
      rootId: "conversation-v2",
      rootPath: firstRootPath,
      boundaryRootPath: storageRootPath,
      authority: "plugin-owned",
      createdAt: 1_721_260_800_000
    });

    await assert.rejects(
      () => createOrLoadRecordRootBinding({
        storageRootPath,
        rootId: "conversation-v2",
        rootPath: secondRootPath,
        boundaryRootPath: storageRootPath,
        authority: "plugin-owned",
        createdAt: 1_721_260_800_010
      }),
      (error: unknown) => (
        error instanceof RecordRootRegistryError
        && error.code === "registry_conflict"
      )
    );
  });
}

async function assertConcurrentAtomicChainPublishHasOneWinner(): Promise<void> {
  await withFixture("atomic-publish-race", async ({ storageRootPath }) => {
    const layout = await resolveDurableAppendOnlyLayout(
      storageRootPath,
      "atomic-publish-race-fixture",
      true
    );
    assert.ok(layout);
    let stagedCount = 0;
    let releaseWriters!: () => void;
    let allStaged!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseWriters = resolve;
    });
    const staged = new Promise<void>((resolve) => {
      allStaged = resolve;
    });
    const faultInjector = async (point: string): Promise<void> => {
      if (point !== "after-staging-sync") return;
      stagedCount += 1;
      if (stagedCount === 2) allStaged();
      await release;
    };
    const contents = [Buffer.from("first\n"), Buffer.from("second\n")];
    const writers = contents.map(
      async (content) => await publishDurableAppendOnlyChain(
        layout,
        "root-atomic-publish-race",
        "entry.json",
        content,
        { faultInjector }
      )
    );
    await staged;
    releaseWriters();
    const results = await Promise.allSettled(writers);
    const winnerIndex = results.findIndex(
      (result) => result.status === "fulfilled"
    );
    assert.notEqual(winnerIndex, -1);
    assert.equal(
      results.filter((result) => result.status === "fulfilled").length,
      1
    );
    assert.equal(
      results.filter(
        (result) => result.status === "rejected"
          && result.reason instanceof DurableAppendOnlyCasError
          && result.reason.code === "already_exists"
      ).length,
      1
    );
    assert.deepEqual(
      await readFile(
        path.join(
          layout.namespaceRootPath,
          "root-atomic-publish-race",
          "entry.json"
        )
      ),
      contents[winnerIndex]
    );
  });
}

async function assertLegacyEmptyChainClaimIsRecovered(): Promise<void> {
  await withFixture("legacy-empty-claim", async ({ storageRootPath }) => {
    const rootId = "legacy-empty-claim";
    const rootPath = path.join(storageRootPath, rootId);
    const namespaceRootPath = path.join(
      storageRootPath,
      "record-root-bindings"
    );
    await mkdir(rootPath);
    await mkdir(namespaceRootPath);
    await mkdir(path.join(namespaceRootPath, ".staging"));
    await mkdir(path.join(namespaceRootPath, bindingChainToken(rootId)));

    const recovered = await createOrLoadRecordRootBinding({
      storageRootPath,
      rootId,
      rootPath,
      boundaryRootPath: storageRootPath,
      authority: "plugin-owned",
      createdAt: 1_721_260_800_000
    });
    assert.equal(recovered.binding.rootId, rootId);
  });
}

async function assertAtomicChainClaimDoesNotExposeEmptyWinner(): Promise<void> {
  await withFixture("atomic-claim", async ({ storageRootPath }) => {
    const layout = await resolveDurableAppendOnlyLayout(
      storageRootPath,
      "atomic-claim-fixture",
      true
    );
    assert.ok(layout);
    let releaseFirst!: () => void;
    let firstClaimed!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const claimed = new Promise<void>((resolve) => {
      firstClaimed = resolve;
    });
    const first = publishDurableAppendOnlyChain(
      layout,
      "root-atomic-claim",
      "entry.json",
      Buffer.from("first\n"),
      {
        async faultInjector(point) {
          if (point === "after-chain-claim") {
            firstClaimed();
            await release;
          }
        }
      }
    );
    await claimed;

    let competingReachedClaim = false;
    const competing = await Promise.allSettled([
      publishDurableAppendOnlyChain(
        layout,
        "root-atomic-claim",
        "entry.json",
        Buffer.from("competing\n"),
        {
          faultInjector(point) {
            if (point === "after-chain-claim") {
              competingReachedClaim = true;
            }
          }
        }
      )
    ]);
    releaseFirst();
    const firstResult = await Promise.allSettled([first]);

    assert.equal(firstResult[0]?.status, "fulfilled");
    assert.equal(competing[0]?.status, "rejected");
    assert.equal(
      competing[0]?.status === "rejected"
        && competing[0].reason instanceof DurableAppendOnlyCasError
        && competing[0].reason.code === "already_exists",
      true
    );
    assert.equal(competingReachedClaim, false);
  });
}

async function assertAtomicChainClaimCrashHasDurableReadback(): Promise<void> {
  await withFixture("claim-crash", async ({ storageRootPath }) => {
    const rootPath = path.join(storageRootPath, "crash-root");
    await mkdir(rootPath);
    const input = {
      storageRootPath,
      rootId: "crash-root",
      rootPath,
      boundaryRootPath: storageRootPath,
      authority: "plugin-owned" as const,
      createdAt: 1_721_260_800_000
    };
    await assert.rejects(
      () => createOrLoadRecordRootBinding({
        ...input,
        faultInjector(point) {
          if (point === "after-chain-claim") {
            throw new Error("simulated crash after chain claim");
          }
        }
      }),
      /simulated crash after chain claim/
    );

    assert.equal(
      (
        await loadRecordRootBinding({
          storageRootPath,
          rootId: input.rootId
        })
      )?.binding.rootId,
      input.rootId
    );
    const recovered = await createOrLoadRecordRootBinding(input);
    assert.equal(recovered.binding.rootId, input.rootId);
    assert.equal(recovered.binding.revision, 0);
  });
}

async function assertImmutableBindingChainRejectsRebinding(): Promise<void> {
  await withFixture("immutable-chain", async ({ storageRootPath }) => {
    const rootPath = path.join(storageRootPath, "immutable-root");
    await mkdir(rootPath);
    const loaded = await createOrLoadRecordRootBinding({
      storageRootPath,
      rootId: "immutable-root",
      rootPath,
      boundaryRootPath: storageRootPath,
      authority: "plugin-owned",
      createdAt: 1_721_260_800_000
    });
    const revisionDraft = {
      ...loaded.binding,
      authority: "vault-managed" as const,
      revision: 1,
      previousRevision: 0,
      previousDigest: loaded.binding.digest,
      updatedAt: loaded.binding.updatedAt + 1
    };
    const { digest: _digest, ...withoutDigest } = revisionDraft;
    await writeFile(
      path.join(
        storageRootPath,
        "record-root-bindings",
        loaded.handle.chainToken,
        "binding-000000000001.json"
      ),
      `${stableStringify({
        ...withoutDigest,
        digest: testDigest(withoutDigest)
      })}\n`
    );

    await assert.rejects(
      () => loadRecordRootBinding({
        storageRootPath,
        rootId: loaded.binding.rootId
      }),
      (error: unknown) => (
        error instanceof RecordRootRegistryError
        && error.code === "registry_corrupt"
      )
    );
  });
}

async function assertVerificationRequiresDurableRegistryAuthority(): Promise<void> {
  await withFixture("missing-authority", async ({ storageRootPath }) => {
    const rootPath = path.join(storageRootPath, "authority-root");
    await mkdir(rootPath);
    const loaded = await createOrLoadRecordRootBinding({
      storageRootPath,
      rootId: "authority-root",
      rootPath,
      boundaryRootPath: storageRootPath,
      authority: "plugin-owned",
      createdAt: 1_721_260_800_000
    });

    await rm(
      path.join(
        storageRootPath,
        "record-root-bindings",
        loaded.handle.chainToken
      ),
      { recursive: true }
    );

    await assert.rejects(
      () => verifyRecordRootBinding(loaded.binding, {
        storageRootPath,
        rootPath,
        boundaryRootPath: storageRootPath
      }),
      (error: unknown) => (
        error instanceof RecordRootRegistryError
        && error.code === "binding_mismatch"
      )
    );
  });
}

async function assertRootReplacementAndSymlinkFailClosed(): Promise<void> {
  await withFixture("identity", async ({ rootPath, storageRootPath }) => {
    const boundRootPath = path.join(storageRootPath, "run-records");
    await mkdir(boundRootPath);
    const loaded = await createOrLoadRecordRootBinding({
      storageRootPath,
      rootId: "run-record-v1",
      rootPath: boundRootPath,
      boundaryRootPath: storageRootPath,
      authority: "plugin-owned",
      createdAt: 1_721_260_800_000
    });

    await rename(boundRootPath, path.join(storageRootPath, "run-records-old"));
    await mkdir(boundRootPath);
    await assert.rejects(
      () => verifyRecordRootBinding(loaded.binding, {
        storageRootPath,
        rootPath: boundRootPath,
        boundaryRootPath: storageRootPath
      }),
      (error: unknown) => (
        error instanceof RecordRootRegistryError
        && error.code === "binding_mismatch"
      )
    );

    const outsideRootPath = path.join(rootPath, "outside-root");
    const symlinkRootPath = path.join(storageRootPath, "symlink-root");
    await mkdir(outsideRootPath);
    await symlink(outsideRootPath, symlinkRootPath);
    await assert.rejects(
      () => createOrLoadRecordRootBinding({
        storageRootPath,
        rootId: "unsafe-symlink",
        rootPath: symlinkRootPath,
        boundaryRootPath: storageRootPath,
        authority: "plugin-owned",
        createdAt: 1_721_260_800_020
      }),
      (error: unknown) => (
        error instanceof RecordRootRegistryError
        && error.code === "unsafe_entry"
      )
    );
  });
}

async function assertVaultManagedRootMustStayInsideItsBoundary(): Promise<void> {
  await withFixture(
    "vault-boundary",
    async ({ rootPath, storageRootPath, vaultRootPath }) => {
      const artifactRootPath = path.join(vaultRootPath, "outputs");
      const outsideRootPath = path.join(rootPath, "outside-vault");
      await mkdir(artifactRootPath);
      await mkdir(outsideRootPath);
      const loaded = await createOrLoadRecordRootBinding({
        storageRootPath,
        rootId: "workflow-artifacts",
        rootPath: artifactRootPath,
        boundaryRootPath: vaultRootPath,
        authority: "vault-managed",
        createdAt: 1_721_260_800_000
      });
      assert.equal(loaded.binding.authority, "vault-managed");

      await assert.rejects(
        () => createOrLoadRecordRootBinding({
          storageRootPath,
          rootId: "outside-artifacts",
          rootPath: outsideRootPath,
          boundaryRootPath: vaultRootPath,
          authority: "vault-managed",
          createdAt: 1_721_260_800_010
        }),
        (error: unknown) => (
          error instanceof RecordRootRegistryError
          && error.code === "invalid_path"
        )
      );
    }
  );
}

async function assertConcurrentFirstRegistrationHasOneBindingWinner(): Promise<void> {
  await withFixture("concurrent", async ({ storageRootPath }) => {
    const rootA = path.join(storageRootPath, "root-a");
    const rootB = path.join(storageRootPath, "root-b");
    await mkdir(rootA);
    await mkdir(rootB);
    const common = {
      storageRootPath,
      rootId: "concurrent-root",
      boundaryRootPath: storageRootPath,
      authority: "plugin-owned" as const,
      createdAt: 1_721_260_800_000
    };
    const results = await Promise.allSettled([
      createOrLoadRecordRootBinding({ ...common, rootPath: rootA }),
      createOrLoadRecordRootBinding({ ...common, rootPath: rootB })
    ]);
    assert.equal(
      results.filter((result) => result.status === "fulfilled").length,
      1
    );
    const rejection = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected"
    );
    assert.equal(
      rejection?.reason instanceof RecordRootRegistryError
        && rejection.reason.code === "registry_conflict",
      true
    );
  });
}

async function assertFutureSchemaAndUnknownEntryFailClosed(): Promise<void> {
  await withFixture("corrupt", async ({ storageRootPath }) => {
    const rootPath = path.join(storageRootPath, "corrupt-root");
    await mkdir(rootPath);
    const loaded = await createOrLoadRecordRootBinding({
      storageRootPath,
      rootId: "corrupt-root",
      rootPath,
      boundaryRootPath: storageRootPath,
      authority: "plugin-owned",
      createdAt: 1_721_260_800_000
    });
    assert.throws(
      () => parseRecordRootBinding({
        ...loaded.binding,
        schemaVersion: 2
      }),
      (error: unknown) => (
        error instanceof RecordRootRegistryError
        && error.code === "future_schema"
      )
    );
    await writeFile(
      path.join(
        storageRootPath,
        "record-root-bindings",
        loaded.handle.chainToken,
        "unknown.json"
      ),
      "{}\n"
    );
    await assert.rejects(
      () => loadRecordRootBinding({
        storageRootPath,
        rootId: loaded.binding.rootId
      }),
      (error: unknown) => (
        error instanceof RecordRootRegistryError
        && error.code === "registry_corrupt"
      )
    );
  });
}

async function withFixture(
  label: string,
  action: (fixture: {
    rootPath: string;
    storageRootPath: string;
    vaultRootPath: string;
  }) => Promise<void>
): Promise<void> {
  const rootPath = await mkdtemp(
    path.join(tmpdir(), `echoink-record-root-${label}-`)
  );
  const storageRootPath = path.join(rootPath, "plugin-data");
  const vaultRootPath = path.join(rootPath, "vault");
  await mkdir(storageRootPath);
  await mkdir(vaultRootPath);
  try {
    await action({ rootPath, storageRootPath, vaultRootPath });
  } finally {
    await rm(rootPath, { recursive: true, force: true });
  }
}

function bindingChainToken(rootId: string): string {
  return `root-${createHash("sha256")
    .update(rootId, "utf8")
    .digest("hex")
    .slice(0, 24)}`;
}

function testDigest(value: unknown): string {
  return `sha256:${createHash("sha256")
    .update(stableStringify(value), "utf8")
    .digest("hex")}`;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}
