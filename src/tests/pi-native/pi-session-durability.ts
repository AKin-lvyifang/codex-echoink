import * as assert from "node:assert/strict";
import fs from "node:fs";
import {
  appendFile,
  link,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  CURRENT_SESSION_VERSION,
  SessionManager,
  VERSION
} from "@earendil-works/pi-coding-agent";
import {
  ECHOINK_PI_CODING_AGENT_VERSION,
  PiSessionDurabilityError,
  assertPiSessionPreAssistantDurable,
  assertSupportedPiSessionApi,
  assertPiSessionAppendsDurable,
  createDurablePiSession,
  createDurablePiSessionFromPrefix,
  inspectPiSessionJsonl,
  openDurablePiSession,
  persistPiActiveLeaf,
  type PiSessionManagerApi
} from "../../harness/pi-native/pi-session-durability";

const API: PiSessionManagerApi = {
  codingAgentVersion: VERSION,
  currentSessionVersion: CURRENT_SESSION_VERSION,
  open: (sessionFile, sessionRoot, cwdOverride) =>
    SessionManager.open(sessionFile, sessionRoot, cwdOverride)
};

export async function runPiSessionDurabilityTests(): Promise<void> {
  assertPinnedPublicApi();
  await withTemporaryRoot(assertFirstUserAndConfigurationAreDurable);
  await withTemporaryRoot(assertPrefixWithoutAssistantIsMaterialized);
  await withTemporaryRoot(assertActiveLeafSurvivesImmediateReopen);
  await withTemporaryRoot(assertTruncatedTailProducesRecoveryPrefix);
  await withTemporaryRoot(assertMalformedLineStopsAtVerifiedPrefix);
  await withTemporaryRoot(assertUnsafePathsAndSymlinksFailClosed);
  await withTemporaryRoot(assertInvalidLeafPointerFailsClosed);
  await assertSessionOperationsWithoutLinkCounts();
  await withTemporaryRoot(assertSharedSessionFileIsAccepted);
}

async function assertSessionOperationsWithoutLinkCounts(): Promise<void> {
  const originalLstatSync = fs.lstatSync;
  // DriveFS reports zero even for ordinary files. Keep all real I/O and
  // other metadata so the public SessionManager exercises the storage path.
  fs.lstatSync = ((...args: Parameters<typeof fs.lstatSync>) => {
    const stat = originalLstatSync(...args);
    stat.nlink = typeof stat.nlink === "bigint" ? 0n : 0;
    return stat;
  }) as typeof fs.lstatSync;
  syncBuiltinESMExports();
  try {
    await withTemporaryRoot(assertFirstUserAndConfigurationAreDurable);
    await withTemporaryRoot(assertActiveLeafSurvivesImmediateReopen);
    await withTemporaryRoot(assertTruncatedTailProducesRecoveryPrefix);
    await withTemporaryRoot(assertUnsafePathsAndSymlinksFailClosed);
  } finally {
    fs.lstatSync = originalLstatSync;
    syncBuiltinESMExports();
  }
}

async function assertSharedSessionFileIsAccepted(sessionRoot: string): Promise<void> {
  const opened = createDurablePiSession({ api: API, sessionRoot, cwd: sessionRoot });
  const alias = path.join(sessionRoot, "shared-session.jsonl");
  await link(opened.sessionFile, alias);
  const entryId = opened.sessionManager.appendMessage({
    role: "user",
    content: "a shared file must not block the conversation",
    timestamp: Date.now()
  });
  assertPiSessionAppendsDurable({
    sessionRoot,
    sessionManager: opened.sessionManager,
    expectedEntryIds: [entryId]
  });
  persistPiActiveLeaf({ sessionRoot, sessionManager: opened.sessionManager });
  const reopened = openDurablePiSession({
    api: API, sessionRoot, sessionFile: opened.sessionFile, cwd: sessionRoot
  });
  assert.equal(reopened.sessionManager.getLeafId(), entryId);
  assert.deepEqual(await readFile(alias), await readFile(opened.sessionFile));
}

async function assertPrefixWithoutAssistantIsMaterialized(
  sessionRoot: string
): Promise<void> {
  const source = createDurablePiSession({
    api: API,
    sessionRoot,
    cwd: sessionRoot,
    sessionFileName: "derive-source-before-assistant.jsonl"
  });
  const modelEntryId = source.sessionManager.appendModelChange(
    "fixture-provider",
    "fixture-model"
  );
  const thinkingEntryId = source.sessionManager.appendThinkingLevelChange(
    "medium"
  );
  const userEntryId = source.sessionManager.appendMessage({
    role: "user",
    content: "prefill this first user message",
    timestamp: Date.now()
  });

  const derived = createDurablePiSessionFromPrefix({
    api: API,
    sessionRoot,
    sourceSessionFile: source.sessionFile,
    sourceLeafId: thinkingEntryId,
    cwd: sessionRoot
  });
  assert.notEqual(derived.piSessionId, source.piSessionId);
  assert.notEqual(derived.sessionFile, source.sessionFile);
  assert.deepEqual(
    derived.inspection.entries.map((entry) => entry.id),
    [modelEntryId, thinkingEntryId]
  );
  assert.equal(derived.sessionManager.getLeafId(), thinkingEntryId);
  assert.equal(
    derived.inspection.entries.some(
      (entry) => entry.type === "message" && entry.message.role === "user"
    ),
    false
  );
  assert.equal(
    source.sessionManager.getLeafId(),
    userEntryId,
    "deriving through a fresh reader must not move the live source leaf"
  );

  const reopened = openDurablePiSession({
    api: API,
    sessionRoot,
    sessionFile: derived.sessionFile,
    cwd: sessionRoot
  });
  assert.deepEqual(
    reopened.sessionManager.getEntries().map((entry) => entry.id),
    [modelEntryId, thinkingEntryId]
  );
}

function assertPinnedPublicApi(): void {
  assert.deepEqual(assertSupportedPiSessionApi(API), {
    codingAgentVersion: ECHOINK_PI_CODING_AGENT_VERSION,
    sessionVersion: 3
  });
  assert.throws(
    () => assertSupportedPiSessionApi({ ...API, codingAgentVersion: "0.82.2" }),
    (error: unknown) =>
      error instanceof PiSessionDurabilityError
      && error.code === "pi_session_api_incompatible"
  );
}

async function assertFirstUserAndConfigurationAreDurable(
  sessionRoot: string
): Promise<void> {
  const opened = createDurablePiSession({
    api: API,
    sessionRoot,
    cwd: sessionRoot,
    sessionFileName: "first-message.jsonl"
  });
  const headerOnly = await readFile(opened.sessionFile, "utf8");
  assert.equal(headerOnly.trim().split("\n").length, 1);
  assert.equal(JSON.parse(headerOnly).type, "session");

  const modelEntryId = opened.sessionManager.appendModelChange(
    "fixture-provider",
    "fixture-model"
  );
  const thinkingEntryId = opened.sessionManager.appendThinkingLevelChange(
    "medium"
  );
  const userEntryId = opened.sessionManager.appendMessage({
    role: "user",
    content: "first durable user message",
    timestamp: Date.now()
  });
  const readback = assertPiSessionPreAssistantDurable({
    sessionRoot,
    sessionManager: opened.sessionManager,
    expectedEntryIds: [modelEntryId, thinkingEntryId, userEntryId]
  });
  assert.deepEqual(readback.entries.map((entry) => entry.type), [
    "model_change",
    "thinking_level_change",
    "message"
  ]);
  assert.equal(
    readback.entries.some(
      (entry) => entry.type === "message" && entry.message.role === "assistant"
    ),
    false
  );

  const reopened = openDurablePiSession({
    api: API,
    sessionRoot,
    sessionFile: opened.sessionFile,
    cwd: sessionRoot
  });
  assert.equal(reopened.piSessionId, opened.piSessionId);
  assert.deepEqual(
    reopened.sessionManager.getEntries().map((entry) => entry.id),
    [modelEntryId, thinkingEntryId, userEntryId]
  );

  const unsafeManager = SessionManager.create(sessionRoot, sessionRoot);
  unsafeManager.appendMessage({
    role: "user",
    content: "not yet durable in the upstream default path",
    timestamp: Date.now()
  });
  assert.throws(
    () => assertPiSessionPreAssistantDurable({
      sessionRoot,
      sessionManager: unsafeManager
    }),
    (error: unknown) =>
      error instanceof PiSessionDurabilityError
      && (
        error.code === "pi_session_path_unsafe"
        || error.code === "pi_session_readback_mismatch"
      )
  );
}

async function assertActiveLeafSurvivesImmediateReopen(
  sessionRoot: string
): Promise<void> {
  const opened = createDurablePiSession({
    api: API,
    sessionRoot,
    cwd: sessionRoot,
    sessionFileName: "active-leaf.jsonl"
  });
  const firstEntryId = opened.sessionManager.appendMessage({
    role: "user",
    content: "branch root",
    timestamp: Date.now()
  });
  opened.sessionManager.appendMessage({
    role: "user",
    content: "abandoned child",
    timestamp: Date.now()
  });
  opened.sessionManager.branch(firstEntryId);
  const metadataPath = persistPiActiveLeaf({
    sessionRoot,
    sessionManager: opened.sessionManager
  });
  assert.deepEqual(JSON.parse(await readFile(metadataPath, "utf8")), {
    schemaVersion: 1,
    activeLeafId: firstEntryId
  });

  const reopened = openDurablePiSession({
    api: API,
    sessionRoot,
    sessionFile: opened.sessionFile,
    cwd: sessionRoot
  });
  assert.equal(reopened.restoredActiveLeafId, firstEntryId);
  assert.equal(reopened.sessionManager.getLeafId(), firstEntryId);
  assert.equal(reopened.sessionManager.getEntries().length, 2);
}

async function assertTruncatedTailProducesRecoveryPrefix(
  sessionRoot: string
): Promise<void> {
  const opened = createDurablePiSession({
    api: API,
    sessionRoot,
    cwd: sessionRoot,
    sessionFileName: "truncated.jsonl"
  });
  const userEntryId = opened.sessionManager.appendMessage({
    role: "user",
    content: "verified prefix",
    timestamp: Date.now()
  });
  const verifiedPrefix = await readFile(opened.sessionFile);
  await appendFile(opened.sessionFile, "{\"type\":\"message\"");
  const corruptSource = await readFile(opened.sessionFile);

  const error = captureDurabilityError(() => openDurablePiSession({
    api: API,
    sessionRoot,
    sessionFile: opened.sessionFile,
    cwd: sessionRoot
  }));
  assert.equal(error.code, "pi_session_jsonl_invalid");
  assert.equal(error.diagnostics[0]?.code, "session_jsonl_truncated");
  assert.ok(error.recoveryPath);
  assert.deepEqual(await readFile(opened.sessionFile), corruptSource);
  assert.deepEqual(await readFile(error.recoveryPath!), verifiedPrefix);

  const recovered = openDurablePiSession({
    api: API,
    sessionRoot,
    sessionFile: error.recoveryPath!,
    cwd: sessionRoot
  });
  assert.deepEqual(
    recovered.sessionManager.getEntries().map((entry) => entry.id),
    [userEntryId]
  );
}

async function assertMalformedLineStopsAtVerifiedPrefix(
  sessionRoot: string
): Promise<void> {
  const opened = createDurablePiSession({
    api: API,
    sessionRoot,
    cwd: sessionRoot,
    sessionFileName: "malformed.jsonl"
  });
  opened.sessionManager.appendMessage({
    role: "user",
    content: "only this prefix may recover",
    timestamp: Date.now()
  });
  const verifiedPrefix = await readFile(opened.sessionFile);
  await appendFile(
    opened.sessionFile,
    "not-json\n{\"type\":\"custom\",\"id\":\"later123\",\"parentId\":null,\"timestamp\":\"2026-08-02T00:00:00.000Z\",\"customType\":\"must-not-recover\"}\n"
  );

  const inspection = inspectPiSessionJsonl({
    sessionRoot,
    sessionFile: opened.sessionFile
  });
  assert.equal(inspection.valid, false);
  if (inspection.valid) assert.fail("expected malformed inspection");
  assert.equal(inspection.diagnostic.code, "session_jsonl_malformed");
  assert.equal(inspection.entries.length, 1);

  const error = captureDurabilityError(() => openDurablePiSession({
    api: API,
    sessionRoot,
    sessionFile: opened.sessionFile,
    cwd: sessionRoot
  }));
  assert.ok(error.recoveryPath);
  assert.deepEqual(await readFile(error.recoveryPath!), verifiedPrefix);
}

async function assertUnsafePathsAndSymlinksFailClosed(
  sessionRoot: string
): Promise<void> {
  const directoryPath = path.join(sessionRoot, "directory.jsonl");
  await mkdir(directoryPath);
  assert.throws(
    () => inspectPiSessionJsonl({ sessionRoot, sessionFile: directoryPath }),
    (error: unknown) =>
      error instanceof PiSessionDurabilityError
      && error.code === "pi_session_path_unsafe"
  );
  assert.throws(
    () => createDurablePiSession({
      api: API,
      sessionRoot,
      cwd: sessionRoot,
      sessionFileName: "../escaped.jsonl"
    }),
    (error: unknown) =>
      error instanceof PiSessionDurabilityError
      && error.code === "pi_session_path_unsafe"
  );

  const outsidePath = outsideFixturePath(sessionRoot);
  await writeFile(outsidePath, "", { mode: 0o600 });
  const linkedPath = path.join(sessionRoot, "linked.jsonl");
  await symlink(outsidePath, linkedPath);
  assert.throws(
    () => inspectPiSessionJsonl({ sessionRoot, sessionFile: linkedPath }),
    (error: unknown) =>
      error instanceof PiSessionDurabilityError
      && error.code === "pi_session_path_unsafe"
  );
}

async function assertInvalidLeafPointerFailsClosed(
  sessionRoot: string
): Promise<void> {
  const opened = createDurablePiSession({
    api: API,
    sessionRoot,
    cwd: sessionRoot,
    sessionFileName: "invalid-leaf.jsonl"
  });
  opened.sessionManager.appendMessage({
    role: "user",
    content: "valid entry",
    timestamp: Date.now()
  });
  const metadataPath = persistPiActiveLeaf({
    sessionRoot,
    sessionManager: opened.sessionManager
  });
  await writeFile(metadataPath, JSON.stringify({
    schemaVersion: 1,
    activeLeafId: "missing1"
  }));

  const sourceBefore = await readFile(opened.sessionFile);
  assert.throws(
    () => openDurablePiSession({
      api: API,
      sessionRoot,
      sessionFile: opened.sessionFile,
      cwd: sessionRoot
    }),
    (error: unknown) =>
      error instanceof PiSessionDurabilityError
      && error.code === "pi_session_active_leaf_invalid"
  );
  assert.deepEqual(await readFile(opened.sessionFile), sourceBefore);
}

function captureDurabilityError(
  action: () => unknown
): PiSessionDurabilityError {
  try {
    action();
  } catch (error) {
    if (error instanceof PiSessionDurabilityError) return error;
    throw error;
  }
  assert.fail("Expected PiSessionDurabilityError");
}

async function withTemporaryRoot(
  assertion: (sessionRoot: string) => Promise<void>
): Promise<void> {
  const sessionRoot = await mkdtemp(
    path.join(tmpdir(), "echoink-pi-session-durability-")
  );
  try {
    await assertion(sessionRoot);
  } finally {
    await rm(sessionRoot, { recursive: true, force: true });
    await rm(outsideFixturePath(sessionRoot), { force: true });
  }
}

function outsideFixturePath(sessionRoot: string): string {
  return path.join(
    path.dirname(sessionRoot),
    `${path.basename(sessionRoot)}-outside.jsonl`
  );
}
