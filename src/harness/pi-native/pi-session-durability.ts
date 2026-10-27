import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  type Stats
} from "node:fs";
import * as path from "node:path";
import { TextDecoder } from "node:util";
import type {
  FileEntry,
  SessionEntry,
  SessionHeader,
  SessionManager
} from "@earendil-works/pi-coding-agent";
import { ECHOINK_TASK_PLAN_ENTRY_TYPE } from "../../types/task-plan";
import { PI_CONTEXT_LEDGER_CUSTOM_TYPE } from "./pi-context-budget";

export const ECHOINK_PI_CODING_AGENT_VERSION = "0.82.1";
export const ECHOINK_PI_SESSION_VERSION = 3;
export const ECHOINK_ACTIVE_LEAF_METADATA_VERSION = 1;

const SESSION_FILE_EXTENSION = ".jsonl";
const SAFE_IDENTIFIER =
  /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

/** The adapter returns the actual public SessionManager for AgentSession. */
export type PiSessionManagerLike = SessionManager;

/**
 * Runtime-owned public surface. Keeping this as a port avoids coupling the
 * durability adapter to any SessionManager private field.
 */
export interface PiSessionManagerApi {
  codingAgentVersion: string;
  currentSessionVersion: number;
  open(
    sessionFile: string,
    sessionRoot: string,
    cwdOverride: string
  ): PiSessionManagerLike;
}

export type PiSessionDurabilityErrorCode =
  | "pi_session_api_incompatible"
  | "pi_session_path_unsafe"
  | "pi_session_jsonl_invalid"
  | "pi_session_readback_mismatch"
  | "pi_session_active_leaf_invalid";

export type PiSessionJsonlDiagnosticCode =
  | "session_jsonl_malformed"
  | "session_jsonl_truncated"
  | "session_recovered_prefix";

export interface PiSessionJsonlDiagnostic {
  code: PiSessionJsonlDiagnosticCode;
  message: string;
  sourcePath: string;
  lineNumber?: number;
  byteOffset?: number;
  verifiedEntryCount: number;
  recoveryPath?: string;
}

export class PiSessionDurabilityError extends Error {
  readonly code: PiSessionDurabilityErrorCode;
  readonly diagnostics: readonly PiSessionJsonlDiagnostic[];
  readonly recoveryPath?: string;

  constructor(input: {
    code: PiSessionDurabilityErrorCode;
    message: string;
    diagnostics?: readonly PiSessionJsonlDiagnostic[];
    recoveryPath?: string;
    cause?: unknown;
  }) {
    super(input.message, input.cause === undefined
      ? undefined
      : { cause: input.cause });
    this.name = "PiSessionDurabilityError";
    this.code = input.code;
    this.diagnostics = Object.freeze([...(input.diagnostics ?? [])]);
    this.recoveryPath = input.recoveryPath;
  }
}

interface PiSessionFileIdentity {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

// One cursor per opened manager; historical content remains owned by Pi.
const verifiedAppends = new WeakMap<PiSessionManagerLike, {
  sessionFile: string;
  sessionId: string;
  entryCount: number;
  identity: PiSessionFileIdentity;
}>();

export interface PiSessionJsonlInspectionBase {
  sourcePath: string;
  sourceSha256: string;
  sourceByteLength: number;
  verifiedPrefixBytes: number;
  header: SessionHeader | null;
  entries: readonly SessionEntry[];
  fileIdentity: PiSessionFileIdentity;
}

export interface ValidPiSessionJsonlInspection
extends PiSessionJsonlInspectionBase {
  valid: true;
  header: SessionHeader;
}

export interface InvalidPiSessionJsonlInspection
extends PiSessionJsonlInspectionBase {
  valid: false;
  diagnostic: PiSessionJsonlDiagnostic;
}

export type PiSessionJsonlInspection =
  | ValidPiSessionJsonlInspection
  | InvalidPiSessionJsonlInspection;

export interface DurablePiSessionOpenResult {
  sessionManager: PiSessionManagerLike;
  sessionFile: string;
  piSessionId: string;
  created: boolean;
  restoredActiveLeafId: string | null;
  inspection: ValidPiSessionJsonlInspection;
}

export interface CreateDurablePiSessionOptions {
  api: PiSessionManagerApi;
  sessionRoot: string;
  cwd: string;
  sessionFileName?: string;
}

export interface CreateDurablePiSessionFromPrefixOptions {
  api: PiSessionManagerApi;
  sessionRoot: string;
  sourceSessionFile: string;
  sourceLeafId: string | null;
  cwd: string;
}

export interface OpenDurablePiSessionOptions {
  api: PiSessionManagerApi;
  sessionRoot: string;
  sessionFile: string;
  cwd: string;
  createRecoveryOnCorruption?: boolean;
}

export interface AssertPiSessionReadbackOptions {
  sessionRoot: string;
  sessionManager: PiSessionManagerLike;
  expectedEntryIds?: readonly string[];
}

interface ActiveLeafMetadata {
  schemaVersion: typeof ECHOINK_ACTIVE_LEAF_METADATA_VERSION;
  activeLeafId: string | null;
}

interface ResolvedSessionRoot {
  requestedPath: string;
  realPath: string;
}

/**
 * Fail closed unless the runtime is the frozen 0.82.1 public SessionManager
 * contract. The zero-byte open/readback smoke is completed by
 * createDurablePiSession().
 */
export function assertSupportedPiSessionApi(
  api: PiSessionManagerApi
): Readonly<{
  codingAgentVersion: string;
  sessionVersion: number;
}> {
  if (
    api.codingAgentVersion !== ECHOINK_PI_CODING_AGENT_VERSION
    || api.currentSessionVersion !== ECHOINK_PI_SESSION_VERSION
    || typeof api.open !== "function"
  ) {
    throw durabilityError(
      "pi_session_api_incompatible",
      `EchoInk requires @earendil-works/pi-coding-agent@${ECHOINK_PI_CODING_AGENT_VERSION} `
        + `with Session v${ECHOINK_PI_SESSION_VERSION}`
    );
  }
  return Object.freeze({
    codingAgentVersion: api.codingAgentVersion,
    sessionVersion: api.currentSessionVersion
  });
}

/**
 * Create a new durable Pi Session through public 0.82.1 behavior:
 * atomically reserve a zero-byte explicit path, then open that exact path.
 * SessionManager.open() writes its header and marks the same manager flushed,
 * so model/thinking/user entries appended before the first assistant are
 * immediately durable.
 */
export function createDurablePiSession(
  options: CreateDurablePiSessionOptions
): DurablePiSessionOpenResult {
  assertSupportedPiSessionApi(options.api);
  const root = resolveSessionRoot(options.sessionRoot, true);
  const fileName = options.sessionFileName
    ?? defaultSessionFileName();
  const sessionFile = resolveDirectSessionFile(root, fileName);

  let descriptor: number | undefined;
  try {
    descriptor = openSync(sessionFile, "wx", 0o600);
    fsyncSync(descriptor);
  } catch (error) {
    throw durabilityError(
      "pi_session_path_unsafe",
      `Could not reserve a new Pi Session file inside its Session Root: ${sessionFile}`,
      error
    );
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }

  const reservedIdentity = assertRegularOwnedFile(sessionFile);
  let sessionManager: PiSessionManagerLike;
  try {
    sessionManager = options.api.open(
      sessionFile,
      root.realPath,
      options.cwd
    );
  } catch (error) {
    throw durabilityError(
      "pi_session_api_incompatible",
      "The pinned SessionManager could not initialize an explicit zero-byte Session file",
      error
    );
  }

  assertManagerPublicShape(sessionManager);
  assertSameFileIdentity(sessionFile, reservedIdentity);
  const inspection = assertPiSessionPreAssistantDurable({
    sessionRoot: root.realPath,
    sessionManager,
    expectedEntryIds: []
  });
  return Object.freeze({
    sessionManager,
    sessionFile,
    piSessionId: sessionManager.getSessionId(),
    created: true,
    restoredActiveLeafId: sessionManager.getLeafId(),
    inspection
  });
}

/**
 * Create one independent Pi Session from an exact source-tree prefix.
 *
 * A fresh reader owns the SDK's mutating createBranchedSession() call, so the
 * live source manager and its active leaf remain untouched. Pi copies the
 * selected root-to-leaf path with native Entry identities and conversational
 * semantics intact. Source-bound operational custom Entries are removed by the
 * clone policy below. Prefixes with no assistant Entry are materialized here
 * because the upstream SDK intentionally defers those files until an assistant
 * response exists.
 */
export function createDurablePiSessionFromPrefix(
  options: CreateDurablePiSessionFromPrefixOptions
): DurablePiSessionOpenResult {
  if (options.sourceLeafId === null) {
    const empty = createDurablePiSession(options);
    persistPiActiveLeaf({
      sessionRoot: options.sessionRoot,
      sessionManager: empty.sessionManager
    });
    return empty;
  }

  const source = openDurablePiSession({
    api: options.api,
    sessionRoot: options.sessionRoot,
    sessionFile: options.sourceSessionFile,
    cwd: options.cwd,
    createRecoveryOnCorruption: false
  });
  if (!source.sessionManager.getEntry(options.sourceLeafId)) {
    throw durabilityError(
      "pi_session_readback_mismatch",
      `Cannot derive a Pi Session from an unknown source Entry: ${options.sourceLeafId}`
    );
  }

  let derivedPath: string | undefined;
  try {
    derivedPath = source.sessionManager.createBranchedSession(
      options.sourceLeafId
    );
  } catch (error) {
    throw durabilityError(
      "pi_session_api_incompatible",
      "The pinned SessionManager could not create a native prefix Session",
      error
    );
  }
  if (!derivedPath) {
    throw durabilityError(
      "pi_session_api_incompatible",
      "The persistent SessionManager did not return a derived Session file"
    );
  }

  const root = resolveSessionRoot(options.sessionRoot, false);
  const derivedFile = resolveDirectSessionFile(root, derivedPath);
  materializeManagerSnapshotIfNeeded(
    root,
    derivedFile,
    source.sessionManager
  );
  const derivedLeafId = applyDerivedSessionClonePolicy(
    root,
    derivedFile,
    options.sourceLeafId
  );
  const derived = openDurablePiSession({
    api: options.api,
    sessionRoot: root.realPath,
    sessionFile: derivedFile,
    cwd: options.cwd,
    createRecoveryOnCorruption: false
  });
  if (derived.sessionManager.getLeafId() !== derivedLeafId) {
    if (derivedLeafId === null) {
      derived.sessionManager.resetLeaf();
    } else {
      derived.sessionManager.branch(derivedLeafId);
    }
  }
  persistPiActiveLeaf({
    sessionRoot: root.realPath,
    sessionManager: derived.sessionManager
  });
  return derived;
}

const DERIVED_SESSION_OMITTED_CUSTOM_TYPES = new Set<string>([
  ECHOINK_TASK_PLAN_ENTRY_TYPE,
  PI_CONTEXT_LEDGER_CUSTOM_TYPE
]);

/**
 * A derived Conversation inherits conversational context, not runtime state
 * bound to the source Conversation / Pi Session identity. Removing those
 * custom Entries at the durable boundary keeps UI, Prompt assembly, and
 * support-state reads on one clone policy.
 */
function applyDerivedSessionClonePolicy(
  root: ResolvedSessionRoot,
  sessionFile: string,
  sourceLeafId: string
): string | null {
  const inspection = inspectResolvedPiSessionJsonl(root, sessionFile);
  if (!inspection.valid) {
    throw new PiSessionDurabilityError({
      code: "pi_session_jsonl_invalid",
      message: inspection.diagnostic.message,
      diagnostics: [inspection.diagnostic]
    });
  }

  const retainedAncestorById = new Map<string, string | null>();
  const retainedEntries: SessionEntry[] = [];
  let omitted = false;
  for (const entry of inspection.entries) {
    const retainedParentId = retainedDerivedParentId(
      entry,
      retainedAncestorById
    );
    if (
      entry.type === "custom"
      && DERIVED_SESSION_OMITTED_CUSTOM_TYPES.has(entry.customType)
    ) {
      omitted = true;
      retainedAncestorById.set(entry.id, retainedParentId);
      continue;
    }
    retainedEntries.push(
      retainedParentId === entry.parentId
        ? entry
        : { ...entry, parentId: retainedParentId }
    );
    retainedAncestorById.set(entry.id, entry.id);
  }

  const retainedLeafId = retainedAncestorById.get(sourceLeafId);
  if (retainedLeafId === undefined) {
    throw durabilityError(
      "pi_session_readback_mismatch",
      "The derived Pi Session clone policy could not resolve its active leaf"
    );
  }
  if (!omitted) return retainedLeafId;

  const snapshot: FileEntry[] = [inspection.header, ...retainedEntries];
  atomicWriteBytes(
    sessionFile,
    root,
    Buffer.from(
      snapshot.map((entry) => `${JSON.stringify(entry)}\n`).join(""),
      "utf8"
    ),
    true
  );
  const readback = inspectResolvedPiSessionJsonl(root, sessionFile);
  if (
    !readback.valid
    || !sameJson(snapshot, [readback.header, ...readback.entries])
  ) {
    throw new PiSessionDurabilityError({
      code: "pi_session_readback_mismatch",
      message: "The derived Pi Session clone policy failed strict readback",
      diagnostics: readback.valid ? [] : [readback.diagnostic]
    });
  }
  return retainedLeafId;
}

function retainedDerivedParentId(
  entry: Readonly<SessionEntry>,
  retainedAncestorById: ReadonlyMap<string, string | null>
): string | null {
  if (entry.parentId === null) return null;
  if (!retainedAncestorById.has(entry.parentId)) {
    throw durabilityError(
      "pi_session_readback_mismatch",
      `The derived Pi Session contains an unresolved parent: ${entry.parentId}`
    );
  }
  return retainedAncestorById.get(entry.parentId) ?? null;
}

/** Roll back only a newly created, identity-verified Pi Session. */
export function discardCreatedDurablePiSession(input: {
  sessionRoot: string;
  sessionFile: string;
  piSessionId: string;
}): void {
  const root = resolveSessionRoot(input.sessionRoot, false);
  const sessionFile = resolveDirectSessionFile(root, input.sessionFile);
  const inspection = inspectResolvedPiSessionJsonl(root, sessionFile);
  if (!inspection.valid || inspection.header.id !== input.piSessionId) {
    throw durabilityError(
      "pi_session_readback_mismatch",
      "Refused to discard a Pi Session whose durable identity did not match"
    );
  }
  unlinkSync(sessionFile);
  const leafMetadata = activeLeafMetadataPath(root, input.piSessionId);
  if (existsSync(leafMetadata)) {
    assertRegularOwnedFile(leafMetadata);
    unlinkSync(leafMetadata);
  }
}

function materializeManagerSnapshotIfNeeded(
  root: ResolvedSessionRoot,
  sessionFile: string,
  sessionManager: PiSessionManagerLike
): void {
  assertManagerPublicShape(sessionManager);
  const managerFile = sessionManager.getSessionFile();
  if (
    !managerFile
    || resolveDirectSessionFile(root, managerFile) !== sessionFile
    || realpathDirectory(sessionManager.getSessionDir()) !== root.realPath
  ) {
    throw durabilityError(
      "pi_session_path_unsafe",
      "The derived SessionManager is not bound to the expected Session Root"
    );
  }
  if (existsSync(sessionFile)) return;

  const snapshot: FileEntry[] = [
    requireManagerHeader(sessionManager),
    ...sessionManager.getEntries()
  ];
  let descriptor: number | undefined;
  try {
    descriptor = openSync(sessionFile, "wx", 0o600);
    for (const entry of snapshot) {
      writeFileSync(descriptor, `${JSON.stringify(entry)}\n`, "utf8");
    }
    fsyncSync(descriptor);
  } catch (error) {
    throw durabilityError(
      "pi_session_path_unsafe",
      `Could not materialize the derived Pi Session: ${sessionFile}`,
      error
    );
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

/**
 * Strictly inspect before SessionManager.open(), then read back again after
 * open to ensure Pi did not silently skip or rewrite any physical line.
 */
export function openDurablePiSession(
  options: OpenDurablePiSessionOptions
): DurablePiSessionOpenResult {
  assertSupportedPiSessionApi(options.api);
  const root = resolveSessionRoot(options.sessionRoot, false);
  const sessionFile = resolveDirectSessionFile(root, options.sessionFile);
  const beforeOpen = inspectResolvedPiSessionJsonl(root, sessionFile);
  if (!beforeOpen.valid) {
    const diagnostics: PiSessionJsonlDiagnostic[] = [
      beforeOpen.diagnostic
    ];
    let recoveryPath: string | undefined;
    if (options.createRecoveryOnCorruption !== false) {
      recoveryPath = writeVerifiedRecoveryPrefix(root, beforeOpen);
      if (recoveryPath) {
        diagnostics.push({
          code: "session_recovered_prefix",
          message: "Wrote only the verified prefix to a new recovery JSONL; the source file was preserved",
          sourcePath: beforeOpen.sourcePath,
          verifiedEntryCount: beforeOpen.entries.length,
          recoveryPath
        });
      }
    }
    throw new PiSessionDurabilityError({
      code: "pi_session_jsonl_invalid",
      message: beforeOpen.diagnostic.message,
      diagnostics,
      recoveryPath
    });
  }

  let sessionManager: PiSessionManagerLike;
  try {
    sessionManager = options.api.open(
      sessionFile,
      root.realPath,
      options.cwd
    );
  } catch (error) {
    throw durabilityError(
      "pi_session_readback_mismatch",
      "SessionManager.open() rejected a strictly verified Pi Session",
      error
    );
  }
  assertManagerPublicShape(sessionManager);
  assertSameFileIdentity(sessionFile, beforeOpen.fileIdentity);

  const inspection = assertPiSessionPreAssistantDurable({
    sessionRoot: root.realPath,
    sessionManager,
    expectedEntryIds: beforeOpen.entries.map((entry) => entry.id)
  });
  if (inspection.sourceSha256 !== beforeOpen.sourceSha256) {
    throw durabilityError(
      "pi_session_readback_mismatch",
      "The Pi Session changed between strict inspection and SessionManager.open()"
    );
  }

  const restoredActiveLeafId = restorePiActiveLeaf({
    sessionRoot: root.realPath,
    sessionManager
  });
  return Object.freeze({
    sessionManager,
    sessionFile,
    piSessionId: sessionManager.getSessionId(),
    created: false,
    restoredActiveLeafId,
    inspection
  });
}

/**
 * Strict physical readback. Call this after appending model/thinking/user and
 * before starting the first assistant request.
 */
export function assertPiSessionPreAssistantDurable(
  options: AssertPiSessionReadbackOptions
): ValidPiSessionJsonlInspection {
  assertManagerPublicShape(options.sessionManager);
  if (!options.sessionManager.isPersisted()) {
    throw durabilityError(
      "pi_session_readback_mismatch",
      "The Pi SessionManager is not persistent"
    );
  }
  const root = resolveSessionRoot(options.sessionRoot, false);
  const managerFile = options.sessionManager.getSessionFile();
  if (!managerFile) {
    throw durabilityError(
      "pi_session_readback_mismatch",
      "The persistent Pi SessionManager has no Session file"
    );
  }
  const sessionFile = resolveDirectSessionFile(root, managerFile);
  const managerRoot = realpathDirectory(options.sessionManager.getSessionDir());
  if (managerRoot !== root.realPath) {
    throw durabilityError(
      "pi_session_path_unsafe",
      "The Pi SessionManager is bound to a different Session Root"
    );
  }

  const inspection = inspectResolvedPiSessionJsonl(root, sessionFile);
  if (!inspection.valid) {
    throw new PiSessionDurabilityError({
      code: "pi_session_jsonl_invalid",
      message: inspection.diagnostic.message,
      diagnostics: [inspection.diagnostic]
    });
  }
  const diskEntries: FileEntry[] = [
    inspection.header,
    ...inspection.entries
  ];
  const managerHeader = options.sessionManager.getHeader();
  if (!managerHeader) {
    throw durabilityError(
      "pi_session_readback_mismatch",
      "The Pi SessionManager has no Session header"
    );
  }
  const managerEntries: FileEntry[] = [
    managerHeader,
    ...options.sessionManager.getEntries()
  ];
  if (!sameJson(managerEntries, diskEntries)) {
    throw durabilityError(
      "pi_session_readback_mismatch",
      "Pi Session memory and JSONL differ; refusing to start the assistant"
    );
  }
  if (
    options.sessionManager.getSessionId() !== inspection.header.id
    || inspection.header.version !== ECHOINK_PI_SESSION_VERSION
  ) {
    throw durabilityError(
      "pi_session_readback_mismatch",
      "Pi Session identity/version did not survive strict JSONL readback"
    );
  }

  const diskIds = new Set(inspection.entries.map((entry) => entry.id));
  for (const entryId of options.expectedEntryIds ?? []) {
    if (!diskIds.has(entryId)) {
      throw durabilityError(
        "pi_session_readback_mismatch",
        `Expected Pi Session Entry was not durable: ${entryId}`
      );
    }
  }
  verifiedAppends.set(options.sessionManager, {
    sessionFile,
    sessionId: inspection.header.id,
    entryCount: inspection.entries.length,
    identity: inspection.fileIdentity
  });
  return inspection;
}

/** Verify only new physical bytes on the already opened, validated manager. */
export function assertPiSessionAppendsDurable(
  options: AssertPiSessionReadbackOptions
): void {
  const manager = options.sessionManager;
  const previous = verifiedAppends.get(manager);
  if (!previous) {
    assertPiSessionPreAssistantDurable(options);
    return;
  }
  const root = resolveSessionRoot(options.sessionRoot, false);
  const managerFile = manager.getSessionFile();
  if (
    !manager.isPersisted()
    || !managerFile
    || resolveDirectSessionFile(root, managerFile) !== previous.sessionFile
    || realpathDirectory(manager.getSessionDir()) !== root.realPath
    || manager.getSessionId() !== previous.sessionId
  ) {
    throw durabilityError("pi_session_path_unsafe", "The opened Pi Session binding changed");
  }
  const identity = assertRegularOwnedFile(previous.sessionFile);
  assertSameFileIdentity(previous.sessionFile, previous.identity);
  const entries = manager.getEntries();
  const appended = entries.slice(previous.entryCount);
  const pendingIds = new Set(appended.map((entry) => entry.id));
  const knownIds = { has: (id: string) => !pendingIds.has(id) && manager.getEntry(id) !== undefined };
  for (const entry of appended) {
    if (validatePhysicalEntry(entry, 2, knownIds)) {
      assertPiSessionPreAssistantDurable(options);
      return;
    }
    pendingIds.delete(entry.id);
  }
  const expected = Buffer.from(appended.map((entry) => `${JSON.stringify(entry)}\n`).join(""));
  if (
    entries.length < previous.entryCount
    || identity.size !== previous.identity.size + expected.length
    || (expected.length === 0 && (
      identity.mtimeMs !== previous.identity.mtimeMs
      || identity.ctimeMs !== previous.identity.ctimeMs
    ))
  ) {
    // Unexpected rewrites/corruption retain the full diagnostic path.
    assertPiSessionPreAssistantDurable(options);
    return;
  }
  if (expected.length > 0) {
    const actual = Buffer.alloc(expected.length);
    const descriptor = openSync(previous.sessionFile, "r");
    try {
      let offset = 0;
      while (offset < actual.length) {
        const count = readSync(descriptor, actual, offset, actual.length - offset,
          previous.identity.size + offset);
        if (count === 0) break;
        offset += count;
      }
      assertStableFileSnapshot(previous.sessionFile, identity, identity.size);
      if (offset !== actual.length || !actual.equals(expected)) {
        assertPiSessionPreAssistantDurable(options);
        return;
      }
    } finally {
      closeSync(descriptor);
    }
  }
  for (const entryId of options.expectedEntryIds ?? []) {
    if (!manager.getEntry(entryId)) {
      throw durabilityError("pi_session_readback_mismatch",
        `Expected Pi Session Entry was not durable: ${entryId}`);
    }
  }
  verifiedAppends.set(manager, {
    ...previous,
    entryCount: entries.length,
    identity
  });
}

/** Persist only the active leaf pointer, never a Branch Tree copy. */
export function persistPiActiveLeaf(input: {
  sessionRoot: string;
  sessionManager: PiSessionManagerLike;
}): string {
  const root = resolveSessionRoot(input.sessionRoot, false);
  assertPiSessionAppendsDurable(input);
  const header = requireManagerHeader(input.sessionManager);
  const activeLeafId = input.sessionManager.getLeafId();
  if (
    activeLeafId !== null
    && !input.sessionManager.getEntry(activeLeafId)
  ) {
    throw durabilityError(
      "pi_session_active_leaf_invalid",
      `Cannot persist an unknown Pi Session leaf: ${activeLeafId}`
    );
  }
  const metadataPath = activeLeafMetadataPath(root, header.id);
  atomicWriteJson(metadataPath, root, {
    schemaVersion: ECHOINK_ACTIVE_LEAF_METADATA_VERSION,
    activeLeafId
  } satisfies ActiveLeafMetadata);
  return metadataPath;
}

/**
 * Restore a previously committed pointer only after confirming the referenced
 * Entry exists in the strictly loaded Pi Session.
 */
export function restorePiActiveLeaf(input: {
  sessionRoot: string;
  sessionManager: PiSessionManagerLike;
}): string | null {
  const root = resolveSessionRoot(input.sessionRoot, false);
  const header = requireManagerHeader(input.sessionManager);
  const parsed = readPiActiveLeafCheckpoint({ sessionRoot: root.realPath, piSessionId: header.id });
  if (!parsed) return input.sessionManager.getLeafId();

  if (parsed.activeLeafId === null) {
    input.sessionManager.resetLeaf();
  } else {
    if (!input.sessionManager.getEntry(parsed.activeLeafId)) {
      throw durabilityError(
        "pi_session_active_leaf_invalid",
        `The persisted active leaf does not reference a verified Session Entry: ${parsed.activeLeafId}`
      );
    }
    input.sessionManager.branch(parsed.activeLeafId);
  }
  if (input.sessionManager.getLeafId() !== parsed.activeLeafId) {
    throw durabilityError(
      "pi_session_active_leaf_invalid",
      "SessionManager did not restore the persisted active leaf"
    );
  }
  return parsed.activeLeafId;
}

/** Read the selected Branch cursor without opening an AgentSession or changing it. */
export function readPiActiveLeafCheckpoint(input: {
  sessionRoot: string;
  piSessionId: string;
}): Readonly<{ activeLeafId: string | null; modifiedAt: number }> | null {
  const root = resolveSessionRoot(input.sessionRoot, false);
  const metadataPath = activeLeafMetadataPath(root, input.piSessionId);
  if (!existsSync(metadataPath)) return null;

  const identity = assertRegularOwnedFile(metadataPath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(metadataPath, "utf8"));
  } catch (error) {
    throw durabilityError(
      "pi_session_active_leaf_invalid",
      "The Pi Session active-leaf metadata is malformed",
      error
    );
  }
  if (!isActiveLeafMetadata(parsed)) {
    throw durabilityError(
      "pi_session_active_leaf_invalid",
      "The Pi Session active-leaf metadata shape/version is incompatible"
    );
  }

  assertStableFileSnapshot(metadataPath, identity, identity.size);
  return Object.freeze({ activeLeafId: parsed.activeLeafId, modifiedAt: identity.mtimeMs });
}

/** Read-only strict inspection. It never asks Pi to parse or mutate the file. */
export function inspectPiSessionJsonl(input: {
  sessionRoot: string;
  sessionFile: string;
}): PiSessionJsonlInspection {
  const root = resolveSessionRoot(input.sessionRoot, false);
  const sessionFile = resolveDirectSessionFile(root, input.sessionFile);
  return inspectResolvedPiSessionJsonl(root, sessionFile);
}

function inspectResolvedPiSessionJsonl(
  root: ResolvedSessionRoot,
  sessionFile: string
): PiSessionJsonlInspection {
  const identityBefore = assertRegularOwnedFile(sessionFile);
  const bytes = readFileSync(sessionFile);
  assertStableFileSnapshot(sessionFile, identityBefore, bytes.length);
  const digest = createHash("sha256").update(bytes).digest("hex");
  const entries: SessionEntry[] = [];
  let header: SessionHeader | null = null;
  let verifiedPrefixBytes = 0;
  let lineStart = 0;
  let lineNumber = 1;
  const knownIds = new Set<string>();

  if (bytes.length === 0) {
    return invalidInspection({
      sessionFile,
      digest,
      bytes,
      identity: identityBefore,
      header,
      entries,
      verifiedPrefixBytes,
      code: "session_jsonl_truncated",
      lineNumber,
      byteOffset: 0,
      reason: "Pi Session JSONL is empty"
    });
  }

  while (lineStart < bytes.length) {
    const newlineIndex = bytes.indexOf(0x0a, lineStart);
    const terminated = newlineIndex !== -1;
    const lineEnd = terminated ? newlineIndex : bytes.length;
    const lineBytes = bytes.subarray(lineStart, lineEnd);

    if (!terminated) {
      return invalidInspection({
        sessionFile,
        digest,
        bytes,
        identity: identityBefore,
        header,
        entries,
        verifiedPrefixBytes,
        code: "session_jsonl_truncated",
        lineNumber,
        byteOffset: lineStart,
        reason: "Pi Session JSONL has an unterminated final line"
      });
    }

    let line: string;
    try {
      line = UTF8_DECODER.decode(lineBytes);
    } catch {
      return invalidInspection({
        sessionFile,
        digest,
        bytes,
        identity: identityBefore,
        header,
        entries,
        verifiedPrefixBytes,
        code: "session_jsonl_malformed",
        lineNumber,
        byteOffset: lineStart,
        reason: "Pi Session JSONL contains invalid UTF-8"
      });
    }
    if (!line.trim()) {
      return invalidInspection({
        sessionFile,
        digest,
        bytes,
        identity: identityBefore,
        header,
        entries,
        verifiedPrefixBytes,
        code: "session_jsonl_malformed",
        lineNumber,
        byteOffset: lineStart,
        reason: "Pi Session JSONL contains a blank physical line"
      });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return invalidInspection({
        sessionFile,
        digest,
        bytes,
        identity: identityBefore,
        header,
        entries,
        verifiedPrefixBytes,
        code: "session_jsonl_malformed",
        lineNumber,
        byteOffset: lineStart,
        reason: "Pi Session JSONL contains malformed JSON"
      });
    }

    const shapeError = validatePhysicalEntry(
      parsed,
      lineNumber,
      knownIds
    );
    if (shapeError) {
      return invalidInspection({
        sessionFile,
        digest,
        bytes,
        identity: identityBefore,
        header,
        entries,
        verifiedPrefixBytes,
        code: "session_jsonl_malformed",
        lineNumber,
        byteOffset: lineStart,
        reason: shapeError
      });
    }

    if (lineNumber === 1) {
      header = parsed as SessionHeader;
    } else {
      const entry = parsed as SessionEntry;
      entries.push(entry);
      knownIds.add(entry.id);
    }
    verifiedPrefixBytes = lineEnd + 1;
    lineStart = lineEnd + 1;
    lineNumber += 1;
  }

  if (!header) {
    return invalidInspection({
      sessionFile,
      digest,
      bytes,
      identity: identityBefore,
      header,
      entries,
      verifiedPrefixBytes,
      code: "session_jsonl_malformed",
      lineNumber: 1,
      byteOffset: 0,
      reason: "Pi Session JSONL has no Session header"
    });
  }
  return Object.freeze({
    valid: true as const,
    sourcePath: sessionFile,
    sourceSha256: digest,
    sourceByteLength: bytes.length,
    verifiedPrefixBytes,
    header,
    entries: Object.freeze([...entries]),
    fileIdentity: identityBefore
  });
}

function invalidInspection(input: {
  sessionFile: string;
  digest: string;
  bytes: Buffer;
  identity: PiSessionFileIdentity;
  header: SessionHeader | null;
  entries: readonly SessionEntry[];
  verifiedPrefixBytes: number;
  code: "session_jsonl_malformed" | "session_jsonl_truncated";
  lineNumber: number;
  byteOffset: number;
  reason: string;
}): InvalidPiSessionJsonlInspection {
  const diagnostic = Object.freeze({
    code: input.code,
    message: `${input.reason} at line ${input.lineNumber}`,
    sourcePath: input.sessionFile,
    lineNumber: input.lineNumber,
    byteOffset: input.byteOffset,
    verifiedEntryCount: input.entries.length
  });
  return Object.freeze({
    valid: false as const,
    sourcePath: input.sessionFile,
    sourceSha256: input.digest,
    sourceByteLength: input.bytes.length,
    verifiedPrefixBytes: input.verifiedPrefixBytes,
    header: input.header,
    entries: Object.freeze([...input.entries]),
    fileIdentity: input.identity,
    diagnostic
  });
}

function validatePhysicalEntry(
  value: unknown,
  lineNumber: number,
  knownIds: Pick<ReadonlySet<string>, "has">
): string | null {
  if (!isRecord(value)) return "Pi Session line is not a JSON object";
  if (lineNumber === 1) return validateSessionHeader(value);
  if (value.type === "session") {
    return "Pi Session header must be the first and only header";
  }
  const baseError = validateSessionEntryBase(value, knownIds);
  if (baseError) return baseError;

  switch (value.type) {
    case "message":
      return validateMessage(value.message);
    case "thinking_level_change":
      return typeof value.thinkingLevel === "string"
        ? null
        : "thinking_level_change.thinkingLevel must be a string";
    case "model_change":
      return nonEmptyString(value.provider) && nonEmptyString(value.modelId)
        ? null
        : "model_change provider/modelId must be non-empty strings";
    case "compaction":
      if (typeof value.summary !== "string") {
        return "compaction.summary must be a string";
      }
      if (
        !nonEmptyString(value.firstKeptEntryId)
        || !knownIds.has(value.firstKeptEntryId)
      ) {
        return "compaction.firstKeptEntryId must reference a prior Entry";
      }
      return finiteNonNegative(value.tokensBefore)
        ? null
        : "compaction.tokensBefore must be a non-negative number";
    case "branch_summary":
      if (typeof value.summary !== "string") {
        return "branch_summary.summary must be a string";
      }
      return nonEmptyString(value.fromId) && knownIds.has(value.fromId)
        ? null
        : "branch_summary.fromId must reference a prior Entry";
    case "custom":
      return nonEmptyString(value.customType)
        ? null
        : "custom.customType must be a non-empty string";
    case "custom_message":
      return nonEmptyString(value.customType)
        && typeof value.display === "boolean"
        && validTextOrBlocks(value.content)
        ? null
        : "custom_message has an incompatible shape";
    case "label":
      if (!nonEmptyString(value.targetId) || !knownIds.has(value.targetId)) {
        return "label.targetId must reference a prior Entry";
      }
      return value.label === undefined || typeof value.label === "string"
        ? null
        : "label.label must be a string when present";
    case "session_info":
      return value.name === undefined || typeof value.name === "string"
        ? null
        : "session_info.name must be a string when present";
    default:
      return `Unsupported Pi Session Entry type: ${String(value.type)}`;
  }
}

function validateSessionHeader(value: Record<string, unknown>): string | null {
  if (value.type !== "session") return "First line is not a Pi Session header";
  if (value.version !== ECHOINK_PI_SESSION_VERSION) {
    return `Pi Session version must be ${ECHOINK_PI_SESSION_VERSION}`;
  }
  if (!validSafeIdentifier(value.id)) {
    return "Pi Session header id is invalid";
  }
  if (!validTimestamp(value.timestamp)) {
    return "Pi Session header timestamp is invalid";
  }
  if (typeof value.cwd !== "string") {
    return "Pi Session header cwd must be a string";
  }
  return value.parentSession === undefined
    || typeof value.parentSession === "string"
    ? null
    : "Pi Session header parentSession must be a string when present";
}

function validateSessionEntryBase(
  value: Record<string, unknown>,
  knownIds: Pick<ReadonlySet<string>, "has">
): string | null {
  if (!validSafeIdentifier(value.id)) return "Pi Session Entry id is invalid";
  if (knownIds.has(value.id)) return "Pi Session Entry id is duplicated";
  if (!validTimestamp(value.timestamp)) {
    return "Pi Session Entry timestamp is invalid";
  }
  if (value.parentId === null) return null;
  if (!validSafeIdentifier(value.parentId)) {
    return "Pi Session Entry parentId is invalid";
  }
  if (value.parentId === value.id || !knownIds.has(value.parentId)) {
    return "Pi Session Entry parentId must reference a prior Entry";
  }
  return null;
}

function validateMessage(value: unknown): string | null {
  if (!isRecord(value) || !nonEmptyString(value.role)) {
    return "message.message must be an object with a role";
  }
  if (!finiteNonNegative(value.timestamp)) {
    return "message.message.timestamp must be a non-negative number";
  }
  switch (value.role) {
    case "user":
      return validTextOrBlocks(value.content)
        ? null
        : "user message content is invalid";
    case "assistant":
      return Array.isArray(value.content)
        && nonEmptyString(value.api)
        && nonEmptyString(value.provider)
        && nonEmptyString(value.model)
        && isRecord(value.usage)
        && nonEmptyString(value.stopReason)
        ? null
        : "assistant message shape is invalid";
    case "toolResult":
      return nonEmptyString(value.toolCallId)
        && nonEmptyString(value.toolName)
        && Array.isArray(value.content)
        && typeof value.isError === "boolean"
        ? null
        : "toolResult message shape is invalid";
    case "bashExecution":
      return typeof value.command === "string"
        && typeof value.output === "string"
        && (value.exitCode === undefined || typeof value.exitCode === "number")
        && typeof value.cancelled === "boolean"
        && typeof value.truncated === "boolean"
        ? null
        : "bashExecution message shape is invalid";
    case "custom":
      return nonEmptyString(value.customType)
        && validTextOrBlocks(value.content)
        && typeof value.display === "boolean"
        ? null
        : "custom message shape is invalid";
    default:
      return `Unsupported Pi AgentMessage role: ${value.role}`;
  }
}

function writeVerifiedRecoveryPrefix(
  root: ResolvedSessionRoot,
  inspection: InvalidPiSessionJsonlInspection
): string | undefined {
  if (!inspection.header || inspection.verifiedPrefixBytes <= 0) {
    return undefined;
  }
  const currentBytes = readFileSync(inspection.sourcePath);
  const currentDigest = createHash("sha256")
    .update(currentBytes)
    .digest("hex");
  if (currentDigest !== inspection.sourceSha256) {
    throw durabilityError(
      "pi_session_readback_mismatch",
      "The corrupt Pi Session changed before recovery could copy its verified prefix"
    );
  }
  const sourceName = path.basename(
    inspection.sourcePath,
    SESSION_FILE_EXTENSION
  );
  const recoveryName = `${sourceName}.recovery-${Date.now()}-${randomUUID()}${SESSION_FILE_EXTENSION}`;
  const recoveryPath = resolveDirectSessionFile(root, recoveryName);
  atomicWriteBytes(
    recoveryPath,
    root,
    currentBytes.subarray(0, inspection.verifiedPrefixBytes)
  );
  const recovered = inspectResolvedPiSessionJsonl(root, recoveryPath);
  if (!recovered.valid || recovered.entries.length !== inspection.entries.length) {
    throw durabilityError(
      "pi_session_readback_mismatch",
      "The newly written Pi Session recovery prefix failed strict readback"
    );
  }
  return recoveryPath;
}

function resolveSessionRoot(
  sessionRoot: string,
  create: boolean
): ResolvedSessionRoot {
  const requestedPath = path.resolve(sessionRoot);
  if (create && !existsSync(requestedPath)) {
    mkdirSync(requestedPath, { recursive: true, mode: 0o700 });
  }
  let rootStats: Stats;
  let realPath: string;
  try {
    rootStats = statSync(requestedPath);
    realPath = realpathSync(requestedPath);
  } catch (error) {
    throw durabilityError(
      "pi_session_path_unsafe",
      `Pi Session Root is unavailable: ${requestedPath}`,
      error
    );
  }
  if (!rootStats.isDirectory()) {
    throw durabilityError(
      "pi_session_path_unsafe",
      `Pi Session Root is not a directory: ${requestedPath}`
    );
  }
  return Object.freeze({ requestedPath, realPath });
}

function resolveDirectSessionFile(
  root: ResolvedSessionRoot,
  inputPath: string
): string {
  const requested = path.isAbsolute(inputPath)
    ? path.resolve(inputPath)
    : path.resolve(root.requestedPath, inputPath);
  const requestedParent = path.dirname(requested);
  let realParent: string;
  try {
    realParent = realpathSync(requestedParent);
  } catch (error) {
    throw durabilityError(
      "pi_session_path_unsafe",
      `Pi Session file parent is unavailable: ${requestedParent}`,
      error
    );
  }
  if (realParent !== root.realPath) {
    throw durabilityError(
      "pi_session_path_unsafe",
      "Pi Session file must be a direct child of its Session Root"
    );
  }
  const fileName = path.basename(requested);
  if (
    fileName !== path.basename(inputPath)
    || !fileName.endsWith(SESSION_FILE_EXTENSION)
    || fileName.length <= SESSION_FILE_EXTENSION.length
    || fileName.includes("\0")
  ) {
    throw durabilityError(
      "pi_session_path_unsafe",
      "Pi Session filename is invalid"
    );
  }
  return path.join(root.realPath, fileName);
}

function assertRegularOwnedFile(filePath: string): PiSessionFileIdentity {
  let fileStats: Stats;
  try {
    fileStats = lstatSync(filePath);
  } catch (error) {
    throw durabilityError(
      "pi_session_path_unsafe",
      `Pi Session repository file is unavailable: ${filePath}`,
      error
    );
  }
  // Session files may have multiple names, and virtual drives may omit nlink.
  // Scope is enforced by the resolved Session Root, not by the link count.
  if (fileStats.isSymbolicLink() || !fileStats.isFile()) {
    throw durabilityError(
      "pi_session_path_unsafe",
      `Pi Session repository file must be a regular file: ${filePath}`
    );
  }
  return Object.freeze({
    dev: Number(fileStats.dev),
    ino: Number(fileStats.ino),
    size: Number(fileStats.size),
    mtimeMs: fileStats.mtimeMs,
    ctimeMs: fileStats.ctimeMs
  });
}

function assertSameFileIdentity(
  filePath: string,
  expected: PiSessionFileIdentity
): void {
  const actual = assertRegularOwnedFile(filePath);
  if (actual.dev !== expected.dev || actual.ino !== expected.ino) {
    throw durabilityError(
      "pi_session_path_unsafe",
      `Pi Session file identity changed during access: ${filePath}`
    );
  }
}

function assertStableFileSnapshot(
  filePath: string,
  expected: PiSessionFileIdentity,
  bytesRead: number
): void {
  const actual = assertRegularOwnedFile(filePath);
  if (
    actual.dev !== expected.dev
    || actual.ino !== expected.ino
    || actual.size !== expected.size
    || actual.mtimeMs !== expected.mtimeMs
    || actual.ctimeMs !== expected.ctimeMs
    || actual.size !== bytesRead
  ) {
    throw durabilityError(
      "pi_session_readback_mismatch",
      `Pi Session file changed during strict inspection: ${filePath}`
    );
  }
}

function assertManagerPublicShape(
  sessionManager: PiSessionManagerLike
): void {
  const methods: readonly (keyof PiSessionManagerLike)[] = [
    "appendMessage",
    "appendModelChange",
    "appendThinkingLevelChange",
    "branch",
    "createBranchedSession",
    "getCwd",
    "getBranch",
    "getEntries",
    "getEntry",
    "getHeader",
    "getLeafId",
    "getSessionDir",
    "getSessionFile",
    "getSessionId",
    "isPersisted",
    "resetLeaf"
  ];
  if (
    !sessionManager
    || methods.some((method) => typeof sessionManager[method] !== "function")
  ) {
    throw durabilityError(
      "pi_session_api_incompatible",
      "SessionManager does not expose the frozen 0.82.1 public shape"
    );
  }
}

function requireManagerHeader(
  sessionManager: PiSessionManagerLike
): SessionHeader {
  const header = sessionManager.getHeader();
  const error = header && isRecord(header)
    ? validateSessionHeader(header)
    : "SessionManager has no valid Session header";
  if (!header || error) {
    throw durabilityError(
      "pi_session_api_incompatible",
      error ?? "SessionManager has no valid Session header"
    );
  }
  return header;
}

function activeLeafMetadataPath(
  root: ResolvedSessionRoot,
  sessionId: string
): string {
  if (!validSafeIdentifier(sessionId)) {
    throw durabilityError(
      "pi_session_active_leaf_invalid",
      "Cannot resolve active-leaf metadata for an invalid Pi Session id"
    );
  }
  return path.join(root.realPath, `.${sessionId}.active-leaf.json`);
}

function atomicWriteJson(
  targetPath: string,
  root: ResolvedSessionRoot,
  value: ActiveLeafMetadata
): void {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
  atomicWriteBytes(targetPath, root, bytes, true);
}

function atomicWriteBytes(
  targetPath: string,
  root: ResolvedSessionRoot,
  bytes: Uint8Array,
  replace = false
): void {
  if (path.dirname(targetPath) !== root.realPath) {
    throw durabilityError(
      "pi_session_path_unsafe",
      "Atomic Pi Session write escaped its Session Root"
    );
  }
  if (!replace && existsSync(targetPath)) {
    throw durabilityError(
      "pi_session_path_unsafe",
      `Refusing to overwrite an existing Pi Session repository file: ${targetPath}`
    );
  }
  if (replace && existsSync(targetPath)) assertRegularOwnedFile(targetPath);
  const temporaryPath = path.join(
    root.realPath,
    `.${path.basename(targetPath)}.${randomUUID()}.tmp`
  );
  let descriptor: number | undefined;
  let renamed = false;
  try {
    descriptor = openSync(temporaryPath, "wx", 0o600);
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporaryPath, targetPath);
    renamed = true;
    syncDirectoryBestEffort(root.realPath);
    assertRegularOwnedFile(targetPath);
  } catch (error) {
    throw durabilityError(
      "pi_session_path_unsafe",
      `Atomic Pi Session repository write failed: ${targetPath}`,
      error
    );
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (!renamed && existsSync(temporaryPath)) {
      try {
        unlinkSync(temporaryPath);
      } catch {
        // The exact adapter-owned temp file may remain for later diagnosis.
      }
    }
  }
}

function syncDirectoryBestEffort(directoryPath: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(directoryPath, "r");
    fsyncSync(descriptor);
  } catch {
    // Some supported filesystems do not allow fsync on a directory. The temp
    // file itself was fsynced and rename is still atomic.
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function isActiveLeafMetadata(value: unknown): value is ActiveLeafMetadata {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value).sort();
  return keys.length === 2
    && keys[0] === "activeLeafId"
    && keys[1] === "schemaVersion"
    && value.schemaVersion === ECHOINK_ACTIVE_LEAF_METADATA_VERSION
    && (value.activeLeafId === null || validSafeIdentifier(value.activeLeafId));
}

function defaultSessionFileName(): string {
  return `echoink-${Date.now()}-${randomUUID()}${SESSION_FILE_EXTENSION}`;
}

function realpathDirectory(directoryPath: string): string {
  try {
    const realPath = realpathSync(directoryPath);
    if (!statSync(realPath).isDirectory()) throw new Error("not a directory");
    return realPath;
  } catch (error) {
    throw durabilityError(
      "pi_session_path_unsafe",
      `SessionManager Session Root is unavailable: ${directoryPath}`,
      error
    );
  }
}

function validSafeIdentifier(value: unknown): value is string {
  return typeof value === "string" && SAFE_IDENTIFIER.test(value);
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === "number"
    && Number.isFinite(value)
    && value >= 0;
}

function validTextOrBlocks(value: unknown): boolean {
  return typeof value === "string" || Array.isArray(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameJson(left: unknown, right: unknown): boolean {
  return stableJson(left) === stableJson(right);
}

function stableJson(value: unknown): string {
  const normalized = JSON.parse(JSON.stringify(value)) as unknown;
  return JSON.stringify(sortJson(normalized));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortJson(value[key])])
  );
}

function durabilityError(
  code: PiSessionDurabilityErrorCode,
  message: string,
  cause?: unknown
): PiSessionDurabilityError {
  return new PiSessionDurabilityError({ code, message, cause });
}
