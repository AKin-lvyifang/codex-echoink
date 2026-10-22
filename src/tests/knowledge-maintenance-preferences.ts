import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import * as path from "node:path";
import {
  ECHOINK_DEFAULT_KNOWLEDGE_MAINTENANCE_PREFERENCES,
  ECHOINK_LEGACY_DEFAULT_KNOWLEDGE_MAINTENANCE_PREFERENCES,
  ECHOINK_KNOWLEDGE_PREFERENCES_LEGACY_BACKUP_PREFIX,
  ECHOINK_KNOWLEDGE_PREFERENCE_PROFILE_VERSION,
  KnowledgeMaintenancePreferenceError,
  KnowledgeMaintenancePreferenceRepository
} from "../knowledge-base/knowledge-maintenance-preferences";
import {
  ECHOINK_KNOWLEDGE_MAINTENANCE_PROTOCOL_VERSION
} from "../knowledge-base/knowledge-maintenance-protocol";
import type {
  Phase3MaintenancePreview,
  Phase3MaintenanceWalRecord
} from "../knowledge-base/phase3-maintenance-service";
import {
  FilePhase3MaintenanceStateStore
} from "../plugin/pi-knowledge-maintenance-production";
import {
  beginSavingKnowledgeMaintenancePreference,
  createKnowledgeMaintenancePreferenceEditor,
  editKnowledgeMaintenancePreference,
  failSavingKnowledgeMaintenancePreference,
  knowledgeMaintenancePreferenceDraftState,
  knowledgeMaintenancePreferenceIsDirty,
  restoreDefaultKnowledgeMaintenancePreference
} from "../settings/knowledge-maintenance-preference-editor";

export async function runKnowledgeMaintenancePreferenceTests(testRootPath = process.env.ECHOINK_KNOWLEDGE_TEST_ROOT): Promise<void> {
  if (!testRootPath) throw new Error("Select an explicit disposable ECHOINK_KNOWLEDGE_TEST_ROOT for preference tests.");
  const root = path.join(path.resolve(testRootPath), "quality-templates");
  await mkdir(root, { recursive: true });
  await assertRepositoryDefaultSaveCasAndRestore(root);
  await assertRepositoryRejectsInvalidAndLinkedPaths(root);
  await assertLegacyDefaultMigrationAndCustomPreservation(root);
  await assertMigrationBackupFailurePreservesOriginal(root);
  await assertReadSaveSerialization(root);
  await assertWalReloadRetainsRunPreferenceRevision(root);
  assertPreferenceEditorStates();
  console.log("Knowledge maintenance preferences: default migration/backup, custom preservation, notices, serialization and existing editor/WAL checks passed.");
}

async function assertRepositoryDefaultSaveCasAndRestore(testRoot: string): Promise<void> {
  const parent = await realpath(await mkdtemp(path.join(
    testRoot,
    "echoink-knowledge-preferences-"
  )));
  const rootPath = path.join(parent, "knowledge");
  try {
    const repository = new KnowledgeMaintenancePreferenceRepository(rootPath);
    const initial = await repository.read();
    assert.equal(initial.state, "default");
    assert.equal(initial.templateNotice, undefined);
    assert.equal(
      initial.profileVersion,
      ECHOINK_KNOWLEDGE_PREFERENCE_PROFILE_VERSION
    );
    assert.equal(
      initial.content,
      ECHOINK_DEFAULT_KNOWLEDGE_MAINTENANCE_PREFERENCES
    );
    await assert.rejects(lstat(rootPath), nodeError("ENOENT"));

    const customContent = "# 自定义偏好\n\n优先保留反例和决策边界。\n";
    const custom = await repository.save({
      content: customContent,
      expectedRevision: initial.revision
    });
    assert.equal(custom.state, "custom");
    assert.match(custom.templateNotice ?? "", /七类新模板可用.*现有偏好编辑器恢复默认.*当前自定义保持/u);
    assert.equal(custom.content, customContent);
    assert.notEqual(custom.revision, initial.revision);
    assert.equal(await readFile(repository.filePath, "utf8"), customContent);
    const fileStat = await lstat(repository.filePath);
    assert.equal(fileStat.isFile(), true);
    assert.equal(fileStat.mode & 0o077, 0);

    await assert.rejects(
      repository.save({
        content: "# stale writer\n",
        expectedRevision: initial.revision
      }),
      preferenceError("revision_conflict")
    );
    assert.equal(await readFile(repository.filePath, "utf8"), customContent);

    const restored = await repository.save({
      content: ECHOINK_DEFAULT_KNOWLEDGE_MAINTENANCE_PREFERENCES,
      expectedRevision: custom.revision
    });
    assert.equal(restored.state, "default");
    assert.equal(restored.revision, initial.revision);
    assert.equal(
      await readFile(repository.filePath, "utf8"),
      ECHOINK_DEFAULT_KNOWLEDGE_MAINTENANCE_PREFERENCES
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}

async function assertRepositoryRejectsInvalidAndLinkedPaths(testRoot: string): Promise<void> {
  const parent = await realpath(await mkdtemp(path.join(
    testRoot,
    "echoink-knowledge-preferences-unsafe-"
  )));
  try {
    const normalRoot = path.join(parent, "normal");
    const repository = new KnowledgeMaintenancePreferenceRepository(normalRoot);
    const initial = await repository.read();
    for (const content of ["", "bad\u0000content"] as const) {
      await assert.rejects(
        repository.save({ content, expectedRevision: initial.revision }),
        preferenceError("invalid_content")
      );
    }

    const realRoot = path.join(parent, "real-root");
    const linkedRoot = path.join(parent, "linked-root");
    await mkdir(realRoot, { recursive: true });
    await symlink(realRoot, linkedRoot, "dir");
    await assert.rejects(
      new KnowledgeMaintenancePreferenceRepository(linkedRoot).read(),
      preferenceError("unsafe_path")
    );

    const linkedFileRoot = path.join(parent, "linked-file-root");
    const outsideFile = path.join(parent, "outside.md");
    await mkdir(linkedFileRoot, { recursive: true });
    await writeFile(outsideFile, "# outside\n", "utf8");
    await symlink(
      outsideFile,
      path.join(linkedFileRoot, "preferences.md"),
      "file"
    );
    await assert.rejects(
      new KnowledgeMaintenancePreferenceRepository(linkedFileRoot).read(),
      preferenceError("unsafe_path")
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}

async function assertLegacyDefaultMigrationAndCustomPreservation(testRoot: string): Promise<void> {
  const parent = await realpath(await mkdtemp(path.join(testRoot, "legacy-default-")));
  const legacy = ECHOINK_LEGACY_DEFAULT_KNOWLEDGE_MAINTENANCE_PREFERENCES;
  const equivalent = `\uFEFF${legacy.replace(/^- /gmu, "  1.  ").replace(/^## /gmu, "###  ").replace(/。/gu, "。  ").replace(/\n/gu, "\r\n")}\r\n  \r\n`;
  try {
    for (const [index, original] of [legacy, equivalent].entries()) {
      const root = path.join(parent, `default-${index}`);
      await mkdir(root);
      const repository = new KnowledgeMaintenancePreferenceRepository(root);
      await writeFile(repository.filePath, original, "utf8");
      const [first, concurrent] = await Promise.all([repository.read(), new KnowledgeMaintenancePreferenceRepository(root).read()]);
      assert.equal(first.state, "default");
      assert.deepEqual(first, concurrent);
      assert.equal(first.content, ECHOINK_DEFAULT_KNOWLEDGE_MAINTENANCE_PREFERENCES);
      assert.equal(first.templateNotice, undefined);
      assert.equal(await readFile(repository.filePath, "utf8"), first.content);
      const backups = (await readdir(root)).filter((name) => name.startsWith(ECHOINK_KNOWLEDGE_PREFERENCES_LEGACY_BACKUP_PREFIX));
      assert.equal(backups.length, 1);
      assert.equal(await readFile(path.join(root, backups[0]), "utf8"), original, "backup preserves exact BOM, CRLF, list markers and whitespace");
      assert.equal((await lstat(path.join(root, backups[0]))).mode & 0o077, 0);
      assert.deepEqual(await repository.read(), first);
      assert.deepEqual((await readdir(root)).sort(), [backups[0], "preferences.md"].sort());
    }
    const customVariants = [
      `${legacy}\n优先保留产品决策。\r\n  `,
      legacy.replace("先提取", "不提取"),
      legacy.replace("## 关注维度", "## 我的关注维度"),
      "# 我的偏好\r\n\r\n只关注反例与行动。\r\n  "
    ];
    for (const [index, original] of customVariants.entries()) {
      const root = path.join(parent, `custom-${index}`);
      await mkdir(root);
      const repository = new KnowledgeMaintenancePreferenceRepository(root);
      await writeFile(repository.filePath, original, "utf8");
      const first = await repository.read();
      assert.equal(first.state, "custom");
      assert.match(first.templateNotice ?? "", /七类新模板可用/u);
      assert.deepEqual(await repository.read(), first);
      assert.equal(await readFile(repository.filePath, "utf8"), original, "custom file is never rewritten by read");
      assert.deepEqual(await readdir(root), ["preferences.md"]);
    }
    const root = path.join(parent, "new-custom");
    const repository = new KnowledgeMaintenancePreferenceRepository(root);
    const initial = await repository.read();
    const custom = await repository.save({ content: `${initial.content}\n额外关注：保留关键决策。\n`, expectedRevision: initial.revision });
    assert.equal(custom.state, "custom");
    assert.equal(custom.templateNotice, undefined, "custom preferences already containing the seven types need no upgrade notice");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}

async function assertMigrationBackupFailurePreservesOriginal(testRoot: string): Promise<void> {
  const parent = await realpath(await mkdtemp(path.join(testRoot, "backup-failure-")));
  const original = ECHOINK_LEGACY_DEFAULT_KNOWLEDGE_MAINTENANCE_PREFERENCES;
  const digest = createHash("sha256").update(original, "utf8").digest("hex");
  try {
    const root = path.join(parent, "knowledge");
    await mkdir(root);
    const repository = new KnowledgeMaintenancePreferenceRepository(root);
    await writeFile(repository.filePath, original, "utf8");
    const backup = path.join(root, `${ECHOINK_KNOWLEDGE_PREFERENCES_LEGACY_BACKUP_PREFIX}${digest}.md`);
    const outside = path.join(parent, "outside.md");
    await writeFile(outside, "私有原文不能被链接覆盖。\n", "utf8");
    await symlink(outside, backup, "file");
    await assert.rejects(repository.read(), preferenceError("unsafe_path"));
    assert.equal(await readFile(repository.filePath, "utf8"), original);
    assert.equal(await readFile(outside, "utf8"), "私有原文不能被链接覆盖。\n");
    await rm(backup);
    await writeFile(backup, "已有备份不能覆盖。\n", "utf8");
    await assert.rejects(repository.read(), preferenceError("write_failed"));
    assert.equal(await readFile(repository.filePath, "utf8"), original);
    assert.equal(await readFile(backup, "utf8"), "已有备份不能覆盖。\n");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}

async function assertReadSaveSerialization(testRoot: string): Promise<void> {
  const parent = await realpath(await mkdtemp(path.join(testRoot, "read-save-")));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const repository = new KnowledgeMaintenancePreferenceRepository(path.join(parent, "knowledge"));
    const initial = await repository.read();
    const operation = async () => {
      const results = await Promise.allSettled([
        repository.save({ content: "# 自定义 A\n", expectedRevision: initial.revision }),
        new KnowledgeMaintenancePreferenceRepository(repository.rootPath).save({ content: "# 自定义 B\n", expectedRevision: initial.revision }),
        repository.read()
      ]);
      assert.equal(results[0].status, "fulfilled");
      assert.equal(results[1].status, "rejected");
      if (results[1].status === "rejected") assert.ok(preferenceError("revision_conflict")(results[1].reason));
      assert.equal(results[2].status, "fulfilled");
      if (results[2].status === "fulfilled") assert.equal(results[2].value.content, "# 自定义 A\n");
    };
    await Promise.race([operation(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Preference read/save queue deadlocked.")), 5_000); })]);
  } finally {
    if (timer) clearTimeout(timer);
    await rm(parent, { recursive: true, force: true });
  }
}

async function assertWalReloadRetainsRunPreferenceRevision(testRoot: string):
Promise<void> {
  const rootPath = await realpath(await mkdtemp(path.join(
    testRoot,
    "echoink-knowledge-wal-reload-"
  )));
  const vaultId = "preference-reload-vault";
  const preferenceRevision = `sha256:${"c".repeat(64)}`;
  const preview: Phase3MaintenancePreview = Object.freeze({
    protocolVersion: ECHOINK_KNOWLEDGE_MAINTENANCE_PROTOCOL_VERSION,
    preferenceProfileVersion: ECHOINK_KNOWLEDGE_PREFERENCE_PROFILE_VERSION,
    preferenceState: "custom",
    preferenceRevision,
    previewId: "preview-preference-reload",
    previewDigest: `sha256:${"d".repeat(64)}`,
    vaultId,
    dateKey: "2026-08-13",
    sourceMode: "explicit",
    selectedSources: Object.freeze([]),
    remainingRawPaths: Object.freeze([]),
    tracker: Object.freeze({
      binding: Object.freeze({ kind: "missing" as const }),
      changedRawPaths: Object.freeze([])
    }),
    shadowId: "shadow-preference-reload",
    shadowRevision: `sha256:${"e".repeat(64)}`,
    reportPath: "outputs/maintenance/kb-maintenance-2026-08-13.md",
    actions: Object.freeze([]),
    createdAt: 1_786_579_200_000
  });
  const wal: Phase3MaintenanceWalRecord = Object.freeze({
    version: 1,
    preview,
    authorization: Object.freeze({
      approvalId: "approval-preference-reload",
      operationIdentity: "operation-preference-reload",
      consumedAt: 1_786_579_200_100,
      contract: Object.freeze({
        productRunId: "run-preference-reload",
        toolCallId: "call-preference-reload",
        conversationId: "conversation-preference-reload",
        piSessionId: "session-preference-reload",
        vaultId,
        userId: "user-preference-reload",
        deviceId: "device-preference-reload",
        previewId: preview.previewId,
        previewDigest: preview.previewDigest,
        preferenceProfileVersion: preview.preferenceProfileVersion,
        preferenceState: preview.preferenceState,
        preferenceRevision,
        orderedActions: Object.freeze([])
      })
    }),
    status: "prepared",
    sequence: 0,
    actions: Object.freeze([]),
    createdAt: 1_786_579_200_100,
    updatedAt: 1_786_579_200_100
  });
  try {
    const first = new FilePhase3MaintenanceStateStore({
      storageRootPath: rootPath,
      vaultId
    });
    await first.createWal(wal);

    const reloaded = new FilePhase3MaintenanceStateStore({
      storageRootPath: rootPath,
      vaultId
    });
    const storedWal = await reloaded.loadWal(preview.previewId);
    assert.equal(storedWal?.preview.preferenceRevision, preferenceRevision);
    assert.equal(
      storedWal?.authorization.contract.preferenceRevision,
      preferenceRevision
    );
  } finally {
    await rm(rootPath, { recursive: true, force: true });
  }
}

function assertPreferenceEditorStates(): void {
  const defaultEditor = createKnowledgeMaintenancePreferenceEditor({
    profileVersion: ECHOINK_KNOWLEDGE_PREFERENCE_PROFILE_VERSION,
    state: "default",
    revision: `sha256:${"1".repeat(64)}`,
    content: ECHOINK_DEFAULT_KNOWLEDGE_MAINTENANCE_PREFERENCES
  });
  assert.equal(knowledgeMaintenancePreferenceIsDirty(defaultEditor), false);
  assert.equal(knowledgeMaintenancePreferenceDraftState(defaultEditor), "default");

  const edited = editKnowledgeMaintenancePreference(
    defaultEditor,
    "# 自定义\n"
  );
  assert.equal(knowledgeMaintenancePreferenceIsDirty(edited), true);
  assert.equal(knowledgeMaintenancePreferenceDraftState(edited), "custom");
  const saving = beginSavingKnowledgeMaintenancePreference(edited);
  assert.equal(saving.saving, true);
  const failed = failSavingKnowledgeMaintenancePreference(
    saving,
    "safe error"
  );
  assert.equal(failed.saving, false);
  assert.equal(failed.error, "safe error");
  assert.equal(knowledgeMaintenancePreferenceIsDirty(failed), true);

  const customSaved = createKnowledgeMaintenancePreferenceEditor({
    profileVersion: ECHOINK_KNOWLEDGE_PREFERENCE_PROFILE_VERSION,
    state: "custom",
    revision: `sha256:${"2".repeat(64)}`,
    content: "# 已保存自定义\n"
  });
  const restoredDraft =
    restoreDefaultKnowledgeMaintenancePreference(customSaved);
  assert.equal(
    knowledgeMaintenancePreferenceDraftState(restoredDraft),
    "default"
  );
  assert.equal(
    knowledgeMaintenancePreferenceIsDirty(restoredDraft),
    true,
    "restore default changes only the draft until the user saves"
  );
}

function preferenceError(
  code: KnowledgeMaintenancePreferenceError["code"]
): (error: unknown) => boolean {
  return (error) => error instanceof KnowledgeMaintenancePreferenceError
    && error.code === code;
}

function nodeError(code: string): (error: unknown) => boolean {
  return (error) => error instanceof Error
    && "code" in error
    && (error as NodeJS.ErrnoException).code === code;
}
