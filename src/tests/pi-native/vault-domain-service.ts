import { rawDigestFingerprint } from "../../knowledge-base/raw-digest";
import { FileApprovalTicketStore } from "../../harness/pi-native/tool-authorization";
import { FileDomainReceiptStore } from "../../harness/pi-native/domain-receipt-store";
import { createPiVaultProductionAuthorizationPort, createPiVaultProductionWriteExecutionPort } from "../../plugin/pi-vault-tool-production";
import { createPiVaultToolDefinitions } from "../../harness/pi-native/pi-vault-tool-contracts";
import { createPiVaultToolSecurityAdapter, createSecurePiVaultToolResultCorrectionPort } from "../../harness/pi-native/pi-vault-tool-security-extension";
import { EchoInkVaultToolEgressPolicy } from "../../harness/pi-native/vault-tool-result-safety";
import { piWorkspaceAllowsTool, type PiWorkspaceAccess } from "../../harness/pi-native/pi-workspace-access";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  VAULT_READ_RESULT_LIMIT_BYTES,
  VAULT_SEARCH_RESULT_LIMIT,
  VAULT_WRITE_RESULT_LIMIT_BYTES,
  VaultDomainAdapterError,
  VaultDomainError,
  VaultDomainService,
  type VaultAdapterSearchResult,
  type VaultDomainAdapter,
  type VaultFileSnapshot,
  type VaultSearchAdapterInput,
  type VaultTrashEvidence
} from "../../harness/pi-native/vault-domain-service";
import {
  VaultTargetResolutionError,
  type ResolvedVaultTarget,
  type VaultPathStat
} from "../../harness/pi-native/vault-target-resolver";
import {
  ObsidianVaultDomainAdapter,
  createPhase3MaintenanceVaultDomainAdapter
} from "../../plugin/obsidian-vault-domain-adapter";

export async function runVaultDomainServiceTests(): Promise<void> {
  await withFixture(assertWorkspacePermissionDispatchAndJournalWrites);
  await withFixture(assertUnsafeTargetsFailBeforeAccess);
  await withFixture(assertSearchAndReadLimits);
  await withFixture(assertWritesUseCasReadbackAndRecoverableTrash);
  await withFixture(assertAbortAndUncertainDoNotRepeatWrites);
  await withFixture(assertMaintenanceCreatesMissingManagedFolders);
}

interface Fixture {
  root: string;
  outsideRoot: string;
  adapter: LocalVaultAdapter;
  service: VaultDomainService;
  write(relativePath: string, content: string): Promise<void>;
  read(relativePath: string): Promise<string>;
}

async function assertUnsafeTargetsFailBeforeAccess(
  fixture: Fixture
): Promise<void> {
  await fixture.write("safe.md", "safe");
  await fixture.write("../must-not-write", "outside fixture helper guard")
    .then(
      () => assert.fail("fixture helper must reject traversal"),
      () => undefined
    );
  await writeFile(path.join(fixture.outsideRoot, "outside.md"), "outside");
  await symlink(fixture.outsideRoot, path.join(fixture.root, "escape"));

  await assert.rejects(
    fixture.service.noteRead({
      vaultId: fixture.adapter.vaultId,
      relativePath: "../outside.md"
    }),
    resolutionError("path_traversal")
  );
  await assert.rejects(
    fixture.service.noteRead({
      vaultId: fixture.adapter.vaultId,
      relativePath: path.join(fixture.outsideRoot, "outside.md")
    }),
    resolutionError("absolute_path")
  );
  await assert.rejects(
    fixture.service.noteRead({
      vaultId: "another-vault",
      relativePath: "safe.md"
    }),
    resolutionError("vault_mismatch")
  );
  await assert.rejects(
    fixture.service.noteRead({
      vaultId: fixture.adapter.vaultId,
      relativePath: "escape/outside.md"
    }),
    resolutionError("symlink_escape")
  );
  assert.equal(fixture.adapter.readCalls, 0);
}

async function assertSearchAndReadLimits(fixture: Fixture): Promise<void> {
  await mkdir(path.join(fixture.root, "many"), { recursive: true });
  for (let index = 0; index < 25; index += 1) {
    await fixture.write(
      `many/note-${String(index).padStart(2, "0")}.md`,
      `matching text ${index}`
    );
  }
  const largeText = "你".repeat(20_000);
  await fixture.write("large.md", largeText);

  const search = await fixture.service.vaultSearch({
    vaultId: fixture.adapter.vaultId,
    query: "matching",
    scopePath: "many"
  });
  assert.equal(search.items.length, VAULT_SEARCH_RESULT_LIMIT);
  assert.equal(search.truncated, true);
  assert.ok(search.items.every((item) => item.relativePath.startsWith("many/")));

  const read = await fixture.service.noteRead({
    vaultId: fixture.adapter.vaultId,
    relativePath: "large.md"
  });
  assert.equal(read.snapshot.relativePath, "large.md");
  assert.equal(read.snapshot.truncated, true);
  assert.ok(
    Buffer.byteLength(read.snapshot.content, "utf8")
      <= VAULT_READ_RESULT_LIMIT_BYTES
  );
  assert.equal(read.snapshot.contentSha256, sha256(largeText));
  await fixture.write("raw/large.md", `---\ntags: [test]\n---\n${largeText}`);
  const raw = await fixture.service.noteRead({ vaultId: fixture.adapter.vaultId, relativePath: "raw/large.md" });
  assert.equal(raw.snapshot.truncated, true);
  assert.equal(raw.snapshot.bodyFingerprint, rawDigestFingerprint("raw/large.md", Buffer.from(largeText)));
  assert.notEqual(raw.snapshot.bodyFingerprint, rawDigestFingerprint("raw/large.md", Buffer.from(raw.snapshot.content)));
}

async function assertWritesUseCasReadbackAndRecoverableTrash(
  fixture: Fixture
): Promise<void> {
  const largeCreate = "x".repeat(12_000);
  const created = await fixture.service.noteCreate({
    vaultId: fixture.adapter.vaultId,
    operationIdentity: "op-create",
    relativePath: "created.md",
    content: largeCreate
  });
  assert.equal(created.status, "completed");
  assert.equal(created.readbackVerified, true);
  assert.equal(created.sideEffectStarted, true);
  assert.ok(
    Buffer.byteLength(
      created.readback.source.snapshot?.content ?? "",
      "utf8"
    ) <= VAULT_WRITE_RESULT_LIMIT_BYTES
  );
  assert.equal(fixture.adapter.createCalls, 1);

  const repeated = await fixture.service.noteCreate({
    vaultId: fixture.adapter.vaultId,
    operationIdentity: "op-create",
    relativePath: "created.md",
    content: largeCreate
  });
  assert.deepEqual(repeated, created);
  assert.equal(fixture.adapter.createCalls, 1);
  await assert.rejects(
    fixture.service.noteCreate({
      vaultId: fixture.adapter.vaultId,
      operationIdentity: "op-create",
      relativePath: "different.md",
      content: "different"
    }),
    domainError("operation_identity_conflict")
  );

  const noOverwrite = await fixture.service.noteCreate({
    vaultId: fixture.adapter.vaultId,
    operationIdentity: "op-create-existing",
    relativePath: "created.md",
    content: "must not overwrite"
  });
  assert.equal(noOverwrite.status, "failed");
  assert.equal(noOverwrite.sideEffectStarted, false);
  assert.equal(await fixture.read("created.md"), largeCreate);

  const createdSnapshot = await fixture.service.noteRead({
    vaultId: fixture.adapter.vaultId,
    relativePath: "created.md"
  });
  await fixture.write("created.md", "external change");
  const conflict = await fixture.service.noteUpdate({
    vaultId: fixture.adapter.vaultId,
    operationIdentity: "op-update-conflict",
    relativePath: "created.md",
    expectedVersion: createdSnapshot.snapshot.version,
    content: "must not replace external change"
  });
  assert.equal(conflict.status, "failed");
  assert.equal(conflict.sideEffectStarted, false);
  assert.equal(await fixture.read("created.md"), "external change");

  const current = await fixture.service.noteRead({
    vaultId: fixture.adapter.vaultId,
    relativePath: "created.md"
  });
  const updated = await fixture.service.noteUpdate({
    vaultId: fixture.adapter.vaultId,
    operationIdentity: "op-update",
    relativePath: "created.md",
    expectedVersion: current.snapshot.version,
    content: "updated once"
  });
  assert.equal(updated.status, "completed");
  assert.equal(updated.readbackVerified, true);
  assert.equal(await fixture.read("created.md"), "updated once");

  const metadataSource = [
    "---",
    "title: Old",
    "keep: yes",
    "---",
    "# Body",
    "must remain byte exact",
    ""
  ].join("\n");
  await fixture.write("raw/metadata.md", metadataSource);
  const metadataBefore = await fixture.service.noteRead({
    vaultId: fixture.adapter.vaultId,
    relativePath: "raw/metadata.md"
  });
  const metadata = await fixture.service.metadataUpdate({
    vaultId: fixture.adapter.vaultId,
    operationIdentity: "op-metadata",
    relativePath: "raw/metadata.md",
    expectedVersion: metadataBefore.snapshot.version,
    patch: {
      set: { title: "New", tags: ["phase2", "vault"] },
      remove: ["keep"]
    }
  });
  assert.equal(metadata.status, "completed");
  assert.equal(metadata.readbackVerified, true);
  const metadataAfter = await fixture.read("raw/metadata.md");
  assert.match(metadataAfter, /title: New/u);
  assert.doesNotMatch(metadataAfter, /^keep:/mu);
  assert.equal(
    bodyAfterFrontmatter(metadataAfter),
    "# Body\nmust remain byte exact\n"
  );

  await fixture.write("move-source.md", "move me");
  await fixture.write("move-existing.md", "do not overwrite");
  const moveBefore = await fixture.service.noteRead({
    vaultId: fixture.adapter.vaultId,
    relativePath: "move-source.md"
  });
  const moveConflict = await fixture.service.noteMove({
    vaultId: fixture.adapter.vaultId,
    operationIdentity: "op-move-conflict",
    sourcePath: "move-source.md",
    targetPath: "move-existing.md",
    expectedVersion: moveBefore.snapshot.version
  });
  assert.equal(moveConflict.status, "failed");
  assert.equal(moveConflict.sideEffectStarted, false);
  assert.equal(await fixture.read("move-existing.md"), "do not overwrite");

  const moved = await fixture.service.noteMove({
    vaultId: fixture.adapter.vaultId,
    operationIdentity: "op-move",
    sourcePath: "move-source.md",
    targetPath: "move-target.md",
    expectedVersion: moveBefore.snapshot.version
  });
  assert.equal(moved.status, "completed");
  assert.equal(moved.readbackVerified, true);
  assert.equal(moved.readback.source.status, "missing");
  assert.equal(moved.readback.target?.status, "present");
  assert.equal(await fixture.read("move-target.md"), "move me");

  const deleteBefore = await fixture.service.noteRead({
    vaultId: fixture.adapter.vaultId,
    relativePath: "move-target.md"
  });
  const deleted = await fixture.service.noteDelete({
    vaultId: fixture.adapter.vaultId,
    operationIdentity: "op-delete",
    relativePath: "move-target.md",
    expectedVersion: deleteBefore.snapshot.version
  });
  assert.equal(deleted.status, "completed");
  assert.equal(deleted.readbackVerified, true);
  assert.equal(deleted.readback.source.status, "missing");
  assert.equal(deleted.readback.trash?.kind, "obsidian_recoverable");
  assert.ok(deleted.readback.trash?.trashRelativePath);
  assert.equal(
    await fixture.read(deleted.readback.trash!.trashRelativePath!),
    "move me"
  );

  await fixture.write("invalid-trash-evidence.md", "must not claim completed");
  const invalidTrashBefore = await fixture.service.noteRead({
    vaultId: fixture.adapter.vaultId,
    relativePath: "invalid-trash-evidence.md"
  });
  fixture.adapter.misidentifyNextTrashEvidence();
  const invalidTrash = await fixture.service.noteDelete({
    vaultId: fixture.adapter.vaultId,
    operationIdentity: "op-delete-invalid-evidence",
    relativePath: "invalid-trash-evidence.md",
    expectedVersion: invalidTrashBefore.snapshot.version
  });
  assert.equal(invalidTrash.status, "uncertain");
  assert.equal(invalidTrash.readbackVerified, false);
  assert.equal(invalidTrash.readback.trash, undefined);
}

async function assertAbortAndUncertainDoNotRepeatWrites(
  fixture: Fixture
): Promise<void> {
  const cancelled = new AbortController();
  cancelled.abort();
  const beforeStart = await fixture.service.noteCreate({
    vaultId: fixture.adapter.vaultId,
    operationIdentity: "op-abort-before",
    relativePath: "abort-before.md",
    content: "must not start",
    signal: cancelled.signal
  });
  assert.equal(beforeStart.status, "cancelled");
  assert.equal(beforeStart.sideEffectStarted, false);
  assert.equal(fixture.adapter.createCalls, 0);

  const delayed = fixture.adapter.delayNextCreate();
  const afterStartController = new AbortController();
  const afterStartPromise = fixture.service.noteCreate({
    vaultId: fixture.adapter.vaultId,
    operationIdentity: "op-abort-after",
    relativePath: "abort-after.md",
    content: "write already started",
    signal: afterStartController.signal
  });
  await delayed.started;
  afterStartController.abort();
  delayed.release();
  const afterStart = await afterStartPromise;
  assert.equal(afterStart.status, "completed");
  assert.equal(afterStart.readbackVerified, true);
  assert.equal(afterStart.sideEffectStarted, true);
  assert.equal(await fixture.read("abort-after.md"), "write already started");

  await fixture.write("uncertain.md", "before uncertain");
  const uncertainBefore = await fixture.service.noteRead({
    vaultId: fixture.adapter.vaultId,
    relativePath: "uncertain.md"
  });
  fixture.adapter.corruptAndFailNextUpdate();
  const uncertain = await fixture.service.noteUpdate({
    vaultId: fixture.adapter.vaultId,
    operationIdentity: "op-uncertain",
    relativePath: "uncertain.md",
    expectedVersion: uncertainBefore.snapshot.version,
    content: "intended update"
  });
  assert.equal(uncertain.status, "uncertain");
  assert.equal(uncertain.readbackVerified, false);
  assert.equal(fixture.adapter.updateCalls, 1);
  const repeated = await fixture.service.noteUpdate({
    vaultId: fixture.adapter.vaultId,
    operationIdentity: "op-uncertain",
    relativePath: "uncertain.md",
    expectedVersion: uncertainBefore.snapshot.version,
    content: "intended update"
  });
  assert.deepEqual(repeated, uncertain);
  assert.equal(fixture.adapter.updateCalls, 1);
}

async function assertMaintenanceCreatesMissingManagedFolders(
  fixture: Fixture
): Promise<void> {
  const trackerPath = "outputs/.ingest-tracker.md";
  const app = {
    vault: {
      getMarkdownFiles: () => [],
      getFileByPath: () => null,
      createFolder: async (relativePath: string) => {
        await mkdir(path.join(fixture.root, relativePath));
      },
      create: async (relativePath: string, content: string) => {
        const handle = await open(
          path.join(fixture.root, relativePath),
          "wx",
          0o600
        );
        try {
          await handle.writeFile(content, "utf8");
        } finally {
          await handle.close();
        }
      }
    }
  };
  const base = new ObsidianVaultDomainAdapter(
    app as never,
    fixture.adapter.vaultId,
    fixture.root
  );
  const ordinary = new VaultDomainService(base);
  assert.equal(
    (await ordinary.readback({
      vaultId: fixture.adapter.vaultId,
      relativePath: trackerPath
    })).status,
    "unavailable",
    "ordinary Vault operations must keep the existing parent requirement"
  );
  const maintenance = new VaultDomainService(
    createPhase3MaintenanceVaultDomainAdapter({
      base,
      trackerRelativePath: trackerPath
    }),
    { allowMissingParentDirectories: true }
  );

  assert.deepEqual(
    await maintenance.readback({
      vaultId: fixture.adapter.vaultId,
      relativePath: trackerPath
    }),
    { status: "missing" }
  );
  const tracker = await maintenance.noteCreate({
    vaultId: fixture.adapter.vaultId,
    operationIdentity: "maintenance-create-tracker",
    relativePath: trackerPath,
    content: "# Knowledge Maintenance Tracker\n"
  });
  assert.equal(tracker.status, "completed");
  assert.equal(tracker.readbackVerified, true);

  const reportPath = "outputs/maintenance/kb-maintenance-2026-08-13.md";
  assert.deepEqual(
    await maintenance.readback({
      vaultId: fixture.adapter.vaultId,
      relativePath: reportPath
    }),
    { status: "missing" }
  );
  const report = await maintenance.noteCreate({
    vaultId: fixture.adapter.vaultId,
    operationIdentity: "maintenance-create-report",
    relativePath: reportPath,
    content: "# Knowledge Maintenance 2026-08-13\n"
  });
  assert.equal(report.status, "completed");
  assert.equal(report.readbackVerified, true);
}

class LocalVaultAdapter implements VaultDomainAdapter {
  readonly vaultId: string;
  readCalls = 0;
  createCalls = 0;
  updateCalls = 0;
  moveCalls = 0;
  trashCalls = 0;
  private createBarrier: Deferred | null = null;
  private corruptNextUpdate = false;
  private misidentifyNextTrash = false;

  constructor(readonly vaultRootPath: string) {
    this.vaultId = `fixture-${path.basename(vaultRootPath)}`;
  }

  async lstat(absolutePath: string): Promise<Readonly<VaultPathStat> | null> {
    try {
      const stat = await lstat(absolutePath);
      return {
        kind: stat.isSymbolicLink()
          ? "symbolic_link"
          : stat.isFile()
            ? "file"
            : stat.isDirectory()
              ? "directory"
              : "other"
      };
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  async realpath(absolutePath: string): Promise<string> {
    return await realpath(absolutePath);
  }

  async search(
    input: Readonly<VaultSearchAdapterInput>
  ): Promise<readonly Readonly<VaultAdapterSearchResult>[]> {
    const files = await listFiles(input.scope.absolutePath);
    const results: VaultAdapterSearchResult[] = [];
    for (const absolutePath of files) {
      const content = await readFile(absolutePath, "utf8");
      const relativePath = toVaultRelative(this.vaultRootPath, absolutePath);
      if (
        !relativePath.toLowerCase().includes(input.query.toLowerCase())
        && !content.toLowerCase().includes(input.query.toLowerCase())
      ) {
        continue;
      }
      results.push({
        relativePath,
        excerpt: content,
        version: await this.versionOf(absolutePath)
      });
    }
    return results;
  }

  async readFile(
    target: Readonly<ResolvedVaultTarget>,
    _options: Readonly<{ maxBytes?: number }>
  ): Promise<Readonly<VaultFileSnapshot> | null> {
    this.readCalls += 1;
    if (!target.exists) return null;
    await this.assertExistingTarget(target);
    try {
      const bytes = await readFile(target.absolutePath);
      const content = bytes.toString("utf8");
      return {
        relativePath: target.relativePath,
        version: await this.versionOf(target.absolutePath),
        byteLength: bytes.length,
        content,
        contentSha256: sha256(content),
        truncated: false
      };
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  async createFile(
    target: Readonly<ResolvedVaultTarget>,
    content: string
  ): Promise<void> {
    this.createCalls += 1;
    await this.assertMissingTarget(target);
    const barrier = this.createBarrier;
    this.createBarrier = null;
    if (barrier) {
      barrier.markStarted();
      await barrier.waitForRelease();
    }
    await mkdir(path.dirname(target.absolutePath), { recursive: true });
    let handle;
    try {
      handle = await open(target.absolutePath, "wx", 0o600);
      await handle.writeFile(content, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code === "EEXIST") {
        throw new VaultDomainAdapterError(
          "already_exists",
          "Create target already exists"
        );
      }
      throw error;
    } finally {
      await handle?.close();
    }
  }

  async updateFile(
    target: Readonly<ResolvedVaultTarget>,
    expectedVersion: string,
    content: string
  ): Promise<void> {
    this.updateCalls += 1;
    await this.assertExistingTarget(target);
    if (await this.versionOf(target.absolutePath) !== expectedVersion) {
      throw new VaultDomainAdapterError(
        "version_conflict",
        "Fixture CAS version changed"
      );
    }
    if (this.corruptNextUpdate) {
      this.corruptNextUpdate = false;
      await writeFile(target.absolutePath, "unexpected partial outcome", "utf8");
      throw new VaultDomainAdapterError(
        "io_error",
        "Fixture injected an indeterminate write outcome"
      );
    }
    await writeFile(target.absolutePath, content, "utf8");
  }

  async moveFile(
    source: Readonly<ResolvedVaultTarget>,
    target: Readonly<ResolvedVaultTarget>,
    expectedSourceVersion: string
  ): Promise<void> {
    this.moveCalls += 1;
    await this.assertExistingTarget(source);
    await this.assertMissingTarget(target);
    if (await this.versionOf(source.absolutePath) !== expectedSourceVersion) {
      throw new VaultDomainAdapterError(
        "version_conflict",
        "Fixture move CAS version changed"
      );
    }
    await mkdir(path.dirname(target.absolutePath), { recursive: true });
    if (await this.lstat(target.absolutePath)) {
      throw new VaultDomainAdapterError(
        "already_exists",
        "Fixture move target already exists"
      );
    }
    await rename(source.absolutePath, target.absolutePath);
  }

  async trashFileRecoverably(
    source: Readonly<ResolvedVaultTarget>,
    expectedVersion: string,
    operationIdentity: string
  ): Promise<Readonly<VaultTrashEvidence>> {
    this.trashCalls += 1;
    await this.assertExistingTarget(source);
    if (await this.versionOf(source.absolutePath) !== expectedVersion) {
      throw new VaultDomainAdapterError(
        "version_conflict",
        "Fixture trash CAS version changed"
      );
    }
    const trashRelativePath = `.trash/${sha256(operationIdentity).slice(0, 12)}-`
      + path.basename(source.relativePath);
    const trashAbsolutePath = path.join(this.vaultRootPath, trashRelativePath);
    await mkdir(path.dirname(trashAbsolutePath), { recursive: true });
    if (await this.lstat(trashAbsolutePath)) {
      throw new VaultDomainAdapterError(
        "already_exists",
        "Fixture trash target already exists"
      );
    }
    await rename(source.absolutePath, trashAbsolutePath);
    const evidenceOperationIdentity = this.misidentifyNextTrash
      ? `${operationIdentity}-mismatch`
      : operationIdentity;
    this.misidentifyNextTrash = false;
    return {
      kind: "obsidian_recoverable",
      operationIdentity: evidenceOperationIdentity,
      originalRelativePath: source.relativePath,
      trashRelativePath
    };
  }

  delayNextCreate(): Readonly<{
    started: Promise<void>;
    release(): void;
  }> {
    const barrier = new Deferred();
    this.createBarrier = barrier;
    return {
      started: barrier.started,
      release: () => barrier.release()
    };
  }

  corruptAndFailNextUpdate(): void {
    this.corruptNextUpdate = true;
  }

  misidentifyNextTrashEvidence(): void {
    this.misidentifyNextTrash = true;
  }

  private async assertExistingTarget(
    target: Readonly<ResolvedVaultTarget>
  ): Promise<void> {
    const canonical = await realpath(target.absolutePath).catch((error) => {
      if (isMissing(error)) {
        throw new VaultDomainAdapterError("not_found", "Target is missing");
      }
      throw error;
    });
    if (canonical !== target.absolutePath) {
      throw new VaultDomainAdapterError(
        "unsafe_target",
        "Target canonical identity changed"
      );
    }
  }

  private async assertMissingTarget(
    target: Readonly<ResolvedVaultTarget>
  ): Promise<void> {
    if (await this.lstat(target.absolutePath)) {
      throw new VaultDomainAdapterError(
        "already_exists",
        "Target already exists"
      );
    }
    const canonicalParent = await realpath(path.dirname(target.absolutePath));
    if (canonicalParent !== path.dirname(target.absolutePath)) {
      throw new VaultDomainAdapterError(
        "unsafe_target",
        "Target parent canonical identity changed"
      );
    }
  }

  private async versionOf(absolutePath: string): Promise<string> {
    const [bytes, stat] = await Promise.all([
      readFile(absolutePath),
      lstat(absolutePath)
    ]);
    return sha256([
      String(stat.dev),
      String(stat.ino),
      String(stat.size),
      String(stat.mtimeMs),
      createHash("sha256").update(bytes).digest("hex")
    ].join(":"));
  }
}

class Deferred {
  readonly started: Promise<void>;
  private readonly released: Promise<void>;
  private resolveStarted: (() => void) | null = null;
  private resolveReleased: (() => void) | null = null;

  constructor() {
    this.started = new Promise((resolve) => {
      this.resolveStarted = resolve;
    });
    this.released = new Promise((resolve) => {
      this.resolveReleased = resolve;
    });
  }

  markStarted(): void {
    this.resolveStarted?.();
    this.resolveStarted = null;
  }

  release(): void {
    this.resolveReleased?.();
    this.resolveReleased = null;
  }

  async waitForRelease(): Promise<void> {
    await this.released;
  }
}

async function withFixture(
  assertion: (fixture: Fixture) => Promise<void>
): Promise<void> {
  const root = await realpath(await mkdtemp(
    path.join(tmpdir(), "echoink-vault-domain-")
  ));
  const outsideRoot = await realpath(await mkdtemp(
    path.join(tmpdir(), "echoink-vault-outside-")
  ));
  const adapter = new LocalVaultAdapter(root);
  const fixture: Fixture = {
    root,
    outsideRoot,
    adapter,
    service: new VaultDomainService(adapter),
    write: async (relativePath, content) => {
      const absolutePath = fixturePath(root, relativePath);
      await mkdir(path.dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, content, "utf8");
    },
    read: async (relativePath) =>
      await readFile(fixturePath(root, relativePath), "utf8")
  };
  try {
    await assertion(fixture);
  } finally {
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(outsideRoot, { recursive: true, force: true })
    ]);
  }
}

async function listFiles(root: string): Promise<string[]> {
  const results: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.name === ".trash" || entry.isSymbolicLink()) continue;
    const absolutePath = path.join(root, entry.name);
    if (entry.isDirectory()) results.push(...await listFiles(absolutePath));
    else if (entry.isFile()) results.push(absolutePath);
  }
  return results.sort();
}

function fixturePath(root: string, relativePath: string): string {
  if (
    path.isAbsolute(relativePath)
    || relativePath.split("/").includes("..")
  ) {
    throw new Error("unsafe fixture path");
  }
  return path.join(root, ...relativePath.split("/"));
}

function toVaultRelative(root: string, absolutePath: string): string {
  return path.relative(root, absolutePath).split(path.sep).join("/");
}

function bodyAfterFrontmatter(content: string): string {
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n(?<body>[\s\S]*)$/u.exec(content);
  assert.ok(match?.groups);
  return match.groups.body;
}

function resolutionError(
  code: VaultTargetResolutionError["code"]
): (error: unknown) => boolean {
  return (error) => error instanceof VaultTargetResolutionError
    && error.code === code;
}

function domainError(
  code: VaultDomainError["code"]
): (error: unknown) => boolean {
  return (error) => error instanceof VaultDomainError && error.code === code;
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function assertWorkspacePermissionDispatchAndJournalWrites(fixture: Fixture): Promise<void> {
  await fixture.write("journal/existing.md", "original body\n");
  const identity = { vaultId: fixture.adapter.vaultId, conversationId: "workspace-permission", piSessionId: "workspace-session", productRunId: "workspace-run" };
  const approvals = new FileApprovalTicketStore({ storageRootPath: fixture.outsideRoot, vaultId: identity.vaultId });
  const receipts = new FileDomainReceiptStore({ storageRootPath: fixture.outsideRoot, vaultId: identity.vaultId });
  await approvals.initialize();
  await receipts.initialize();
  let access: PiWorkspaceAccess = { permission: "read-only", mode: "agent", memoryMode: "normal" };
  let approved = 0;
  let additionalDispatches = 0;
  const security = createPiVaultToolSecurityAdapter({
    isToolAllowed: (toolName) => piWorkspaceAllowsTool({ ...access, toolName, planToolNames: ["note_read"], memoryToolNames: ["memory_read", "memory_search", "memory_write"], externalReadToolNames: ["external_read"] }),
    authorization: createPiVaultProductionAuthorizationPort({
      approvals, adapter: fixture.adapter, currentRunIdentity: () => identity,
      userId: "fixture-user", deviceId: "fixture-device",
      confirmation: { async confirm() { approved += 1; return true; } }
    }),
    resultCorrection: createSecurePiVaultToolResultCorrectionPort(new EchoInkVaultToolEgressPolicy()),
    additionalToolSecurities: ["memory_write", "knowledge_maintain", "external_write", "external_read", "memory_read"].map((toolName) => ({
      toolName,
      async handleToolCall() { additionalDispatches += 1; },
      async handleToolResult() { return { content: [], details: {}, isError: false }; }
    }))
  });
  const handlers = new Map<string, (...args: any[]) => any>();
  await security.inlineExtension.factory({ on: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler) } as never);
  const tools = createPiVaultToolDefinitions({ domainService: fixture.service, security, writeExecution: createPiVaultProductionWriteExecutionPort({ receipts, domainService: fixture.service }) });
  let sequence = 0;
  const call = async (toolName: string, input: Record<string, unknown>) => {
    const toolCallId = `workspace-call-${++sequence}`;
    const blocked = await handlers.get("tool_call")!({ toolName, toolCallId, input }, { signal: undefined });
    if (blocked) return blocked;
    const tool = tools.find((candidate) => candidate.name === toolName);
    if (!tool) return undefined;
    const result = await tool.execute(toolCallId, input, undefined, undefined);
    return await handlers.get("tool_result")!({ toolName, toolCallId, ...result, isError: false });
  };
  assert.deepEqual(await call("note_read", { relativePath: "journal/missing.md" }), {
    block: true, reason: "target_not_found"
  });
  assert.deepEqual(await call("note_read", { relativePath: "journal" }), {
    block: true, reason: "target_kind_invalid"
  });
  assert.deepEqual(await call("note_read", { relativePath: "../outside.md" }), {
    block: true, reason: "tool_policy_blocked"
  });
  assert.equal((await call("note_read", { relativePath: "journal/existing.md" })).isError, false,
    "a missing target does not prevent the next valid read");
  for (const workflow of ["chat", "ask", "maintain", "daily-journal"]) {
    for (const toolName of ["note_create", "note_update", "metadata_update", "note_move", "note_delete", "memory_write", "knowledge_maintain", "external_write"]) {
      assert.deepEqual(await call(toolName, { relativePath: "journal/existing.md", content: workflow }), { block: true, reason: "tool_policy_blocked" });
    }
  }
  assert.equal(approved, 0, "read-only never requests write approval");
  assert.equal(additionalDispatches, 0, "all content write categories are rejected before their own handlers");
  assert.equal(await fixture.read("journal/existing.md"), "original body\n");
  await call("external_read", {});
  assert.equal(additionalDispatches, 1);
  access = { ...access, memoryMode: "no_memory" };
  assert.deepEqual(await call("memory_read", { id: "record" }), { block: true, reason: "tool_policy_blocked" });
  assert.equal(additionalDispatches, 1);

  for (const permission of ["workspace-write", "danger-full-access"] as const) {
    access = { permission, mode: "agent", memoryMode: "normal" };
    const relativePath = `journal/${permission}.md`;
    const body = "# 此刻速记\n今天完成了一件事。\n";
    const created = await call("note_create", { relativePath, content: body });
    assert.equal(created.isError, false);
    assert.equal(await fixture.read(relativePath), body);
    const read = await fixture.service.noteRead({ vaultId: identity.vaultId, relativePath });
    const appended = body + "\n## 补记\n稍后补充的内容。\n";
    assert.equal((await call("note_update", { relativePath, expectedVersion: read.snapshot.version, content: appended })).isError, false);
    assert.equal(await fixture.read(relativePath), appended);
    assert.equal((await call("note_update", { relativePath, expectedVersion: read.snapshot.version, content: "stale overwrite" })).isError, true);
    assert.equal(await fixture.read(relativePath), appended, "CAS preserves the original and appended body on a stale write");
  }
  assert.ok(approved >= 4, "writable tools continue through the production approval and readback path");
}
