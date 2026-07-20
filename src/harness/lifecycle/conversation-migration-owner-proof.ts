import { lstat, readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import type { ChatMessage, StoredSession } from "../../settings/settings";
import type { ConversationCommitV2 } from "../contracts/conversation-v2";
import type { NativeExecutionRecord } from "../contracts/native-execution";
import type {
  ConversationWorkflowRunInventory,
  RunRecordStoreInventory
} from "../ledger/run-record-store";
import { FileRunRecordStore } from "../ledger/run-record-store";
import {
  NativeExecutionStore,
  type NativeExecutionStoreMigrationSnapshot
} from "../native/native-execution-store";
import {
  migrationContentDigest,
  opaqueMigrationRef,
  type RecordMigrationOwnerEdge,
  type RecordMigrationOwnerKind
} from "./record-migration-validator";
import {
  conversationMigrationInventoryFromLegacySessions,
  legacyExternalOwnerEdges
} from "./conversation-migration-projection";
import {
  FileConversationLegacyEvidenceStore,
  type ConversationLegacyEvidenceReceipt
} from "./conversation-legacy-evidence-store";

const CURRENT_SETTINGS_VERSION = 39;
const SETTINGS_KEYS = new Set([
  "settingsVersion",
  "settingsLanguage",
  "settingsTab",
  "agentBackend",
  "agents",
  "capabilities",
  "cliPath",
  "proxyEnabled",
  "proxyUrl",
  "providerMode",
  "activeApiProviderId",
  "apiProviders",
  "mcpEnabled",
  "defaultModel",
  "defaultReasoning",
  "defaultServiceTier",
  "defaultPermission",
  "defaultMode",
  "autoOpen",
  "autoOpenHome",
  "showContext",
  "setup",
  "memory",
  "resourceManagementTab",
  "promptEnhancer",
  "editorActions",
  "opencode",
  "knowledgeBase",
  "review",
  "resources",
  "workspaceResources",
  "workspaceResourceCache",
  "sessions",
  "activeSessionId"
]);
const STORED_SESSION_KEYS = new Set([
  "id",
  "title",
  "kind",
  "threadId",
  "backendBindings",
  "revision",
  "generation",
  "contextId",
  "contextStartsAfterMessageId",
  "commitId",
  "workspaceFingerprint",
  "contextSnapshot",
  "cwd",
  "messages",
  "rollingSummary",
  "messagesHiddenBefore",
  "historyActiveDate",
  "tokenUsage",
  "createdAt",
  "updatedAt"
]);

export type ConversationMigrationOwnerProofFindingCode =
  | "settings-store-missing"
  | "settings-store-invalid"
  | "native-store-missing"
  | "native-store-invalid"
  | "run-store-missing"
  | "run-store-invalid"
  | "legacy-evidence-store-missing"
  | "legacy-evidence-store-invalid"
  | "owner-unproven";

export interface ConversationMigrationOwnerProofFinding {
  code: ConversationMigrationOwnerProofFindingCode;
  ownerKind: RecordMigrationOwnerKind | null;
  ownerRef: string;
  resourceRef: string | null;
}

export interface ConversationMigrationOwnerProof {
  status: "ready" | "blocked";
  targetExternalOwnerEdges: RecordMigrationOwnerEdge[];
  findings: ConversationMigrationOwnerProofFinding[];
  fingerprint: string;
}

export interface InspectConversationMigrationOwnerProofInput {
  sourceSessions: readonly StoredSession[];
  sourceFingerprint?: string;
  retainedSourceDigest?: string;
  settingsDataPath: string;
  nativeStore: NativeExecutionStore;
  runStore: FileRunRecordStore;
  legacyEvidenceStore?: FileConversationLegacyEvidenceStore;
}

interface SettingsProjectionSnapshot {
  present: boolean;
  sessions: StoredSession[];
  fingerprint: string;
}

/**
 * Builds target owner edges only from strict readback of the three formal
 * stores. Callers cannot submit their own "proved" edges through this API.
 */
export async function inspectConversationMigrationOwnerProof(
  input: InspectConversationMigrationOwnerProofInput
): Promise<ConversationMigrationOwnerProof> {
  const required = legacyExternalOwnerEdges(input.sourceSessions);
  const findings: ConversationMigrationOwnerProofFinding[] = [];
  const settings = await inspectSettingsStore(
    input.settingsDataPath,
    findings
  );
  const native = await inspectNativeStore(input.nativeStore, findings);
  const runs = await inspectRunStore(input.runStore, findings);
  const sourceFingerprint = input.sourceFingerprint
    ?? conversationMigrationInventoryFromLegacySessions(
      input.sourceSessions
    ).fingerprint;
  const legacyEvidence = input.legacyEvidenceStore
    ? await inspectLegacyEvidenceStore(
      input.legacyEvidenceStore,
      sourceFingerprint,
      input.retainedSourceDigest,
      findings
    )
    : null;
  const proven = new Map<string, RecordMigrationOwnerEdge>();

  if (settings) {
    collectSettingsEdges(input.sourceSessions, settings.sessions, proven);
  }
  if (native) {
    collectNativeEdges(
      input.sourceSessions,
      settings?.sessions ?? [],
      native.records,
      proven
    );
  }
  if (runs) {
    collectRunEdges(input.sourceSessions, runs, proven);
  }
  if (legacyEvidence) {
    collectLegacyEvidenceEdges(required, legacyEvidence, proven);
  }

  for (const edge of required) {
    if (proven.has(ownerEdgeKey(edge))) continue;
    findings.push({
      code: "owner-unproven",
      ownerKind: edge.kind,
      ownerRef: edge.ownerRef,
      resourceRef: edge.resourceRef
    });
  }
  findings.sort(compareFindings);
  const targetExternalOwnerEdges = [...proven.values()]
    .filter((edge) => required.some((candidate) =>
      ownerEdgeKey(candidate) === ownerEdgeKey(edge)))
    .sort(compareOwnerEdges);
  const withoutFingerprint = {
    status: findings.length ? "blocked" as const : "ready" as const,
    targetExternalOwnerEdges,
    findings,
    settingsFingerprint: settings?.fingerprint
      ?? opaqueMigrationRef("migration-owner-store-state", "settings"),
    nativeFingerprint: native?.fingerprint
      ?? opaqueMigrationRef("migration-owner-store-state", "native"),
    runFingerprint: runs?.snapshotDigest
      ?? opaqueMigrationRef("migration-owner-store-state", "run"),
    legacyEvidenceFingerprint: legacyEvidence?.digest
      ?? opaqueMigrationRef("migration-owner-store-state", "legacy-evidence")
  };
  return {
    status: withoutFingerprint.status,
    targetExternalOwnerEdges,
    findings,
    fingerprint: migrationContentDigest(withoutFingerprint)
  };
}

async function inspectLegacyEvidenceStore(
  store: FileConversationLegacyEvidenceStore,
  sourceFingerprint: string,
  retainedSourceDigest: string | undefined,
  findings: ConversationMigrationOwnerProofFinding[]
): Promise<ConversationLegacyEvidenceReceipt | null> {
  try {
    const receipt = await store.read(sourceFingerprint);
    if (!receipt) {
      findings.push(storeFinding(
        "legacy-evidence-store-missing",
        "legacy-evidence"
      ));
      return null;
    }
    if (
      retainedSourceDigest !== undefined
      && receipt.retainedSourceDigest !== retainedSourceDigest
    ) {
      throw new Error(
        "legacy evidence does not bind the retained V1 source"
      );
    }
    return receipt;
  } catch {
    findings.push(storeFinding(
      "legacy-evidence-store-invalid",
      "legacy-evidence"
    ));
    return null;
  }
}

/**
 * Rebuilds the external owner ledger for a V2 compatibility export. V2 keeps
 * execution lineage on messages, so each such message must resolve to the
 * exact Workflow/Attempt records read from the formal Run Store.
 */
export async function inspectConversationV2MigrationOwnerProof(
  input: Omit<InspectConversationMigrationOwnerProofInput, "sourceSessions"> & {
    sourceCommits: readonly ConversationCommitV2[];
  }
): Promise<ConversationMigrationOwnerProof> {
  const findings: ConversationMigrationOwnerProofFinding[] = [];
  const settings = await inspectSettingsStore(
    input.settingsDataPath,
    findings
  );
  const native = await inspectNativeStore(input.nativeStore, findings);
  const runs = await inspectRunStore(input.runStore, findings);
  const targetExternalOwnerEdges: RecordMigrationOwnerEdge[] = [];
  for (const commit of input.sourceCommits) {
    for (const message of commit.payload.messages) {
      if (!message.workflowRunId && !message.attemptId) continue;
      const ownerRef = opaqueMigrationRef(
        "message",
        commit.metadata.conversationId,
        message.id
      );
      const resourceRef = migrationContentDigest({
        workflowRunId: message.workflowRunId ?? null,
        attemptId: message.attemptId ?? null
      });
      const edge: RecordMigrationOwnerEdge = {
        kind: "run-record-owner",
        ownerRef,
        resourceRef
      };
      if (
        runs
        && v2MessageLineageIsProven(
          commit.metadata.conversationId,
          message.workflowRunId,
          message.attemptId,
          runs
        )
      ) {
        targetExternalOwnerEdges.push(edge);
      } else {
        findings.push({
          code: "owner-unproven",
          ownerKind: edge.kind,
          ownerRef,
          resourceRef
        });
      }
    }
  }
  findings.sort(compareFindings);
  targetExternalOwnerEdges.sort(compareOwnerEdges);
  const withoutFingerprint = {
    status: findings.length ? "blocked" as const : "ready" as const,
    targetExternalOwnerEdges,
    findings,
    settingsFingerprint: settings?.fingerprint
      ?? opaqueMigrationRef("migration-owner-store-state", "settings"),
    nativeFingerprint: native?.fingerprint
      ?? opaqueMigrationRef("migration-owner-store-state", "native"),
    runFingerprint: runs?.snapshotDigest
      ?? opaqueMigrationRef("migration-owner-store-state", "run")
  };
  return {
    status: withoutFingerprint.status,
    targetExternalOwnerEdges,
    findings,
    fingerprint: migrationContentDigest(withoutFingerprint)
  };
}

async function inspectSettingsStore(
  dataPath: string,
  findings: ConversationMigrationOwnerProofFinding[]
): Promise<SettingsProjectionSnapshot | null> {
  try {
    const first = await readSettingsSnapshotOnce(dataPath);
    const second = await readSettingsSnapshotOnce(dataPath);
    if (first.fingerprint !== second.fingerprint) {
      throw new Error("settings changed during migration inventory");
    }
    if (!second.present) {
      findings.push(storeFinding("settings-store-missing", "settings"));
      return null;
    }
    return second;
  } catch {
    findings.push(storeFinding("settings-store-invalid", "settings"));
    return null;
  }
}

async function inspectNativeStore(
  store: NativeExecutionStore,
  findings: ConversationMigrationOwnerProofFinding[]
): Promise<NativeExecutionStoreMigrationSnapshot | null> {
  try {
    const snapshot = await store.inspectMigrationSnapshot();
    if (!snapshot.present) {
      findings.push(storeFinding("native-store-missing", "native"));
      return null;
    }
    return snapshot;
  } catch {
    findings.push(storeFinding("native-store-invalid", "native"));
    return null;
  }
}

async function inspectRunStore(
  store: FileRunRecordStore,
  findings: ConversationMigrationOwnerProofFinding[]
): Promise<RunRecordStoreInventory | null> {
  try {
    const stats = await lstatOrNull(store.rootPath);
    if (!stats) {
      findings.push(storeFinding("run-store-missing", "run"));
      return null;
    }
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new Error("run store root is not a plain directory");
    }
    const inventory = await store.inventoryRunRecords();
    if (inventory.blockers.length) {
      throw new Error("run store inventory is incomplete");
    }
    return inventory;
  } catch {
    findings.push(storeFinding("run-store-invalid", "run"));
    return null;
  }
}

async function readSettingsSnapshotOnce(
  dataPath: string
): Promise<SettingsProjectionSnapshot> {
  const stats = await lstatOrNull(dataPath);
  if (!stats) {
    return {
      present: false,
      sessions: [],
      fingerprint: migrationContentDigest({ present: false })
    };
  }
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error("settings projection is not a plain file");
  }
  const parsed = JSON.parse(await readFile(dataPath, "utf8")) as unknown;
  if (!isPlainObject(parsed)) {
    throw new Error("settings projection root is invalid");
  }
  for (const key of Object.keys(parsed)) {
    if (!SETTINGS_KEYS.has(key)) {
      throw new Error("settings projection contains an unknown field");
    }
  }
  if (
    parsed.settingsVersion !== CURRENT_SETTINGS_VERSION
    || !Array.isArray(parsed.sessions)
  ) {
    throw new Error("settings projection schema is unsupported");
  }
  const sessions = parsed.sessions.map((value) => {
    validateSettingsSessionProjection(value);
    return structuredClone(value);
  });
  const ids = new Set<string>();
  for (const session of sessions) {
    if (ids.has(session.id)) {
      throw new Error("settings projection contains duplicate sessions");
    }
    ids.add(session.id);
  }
  return {
    present: true,
    sessions,
    fingerprint: migrationContentDigest({
      present: true,
      settingsVersion: parsed.settingsVersion,
      sessions
    })
  };
}

function validateSettingsSessionProjection(value: unknown): asserts value is StoredSession {
  if (!isPlainObject(value)) {
    throw new Error("settings session projection is invalid");
  }
  for (const key of Object.keys(value)) {
    if (!STORED_SESSION_KEYS.has(key)) {
      throw new Error("settings session projection contains an unknown field");
    }
  }
  if (
    typeof value.id !== "string"
    || !value.id.trim()
    || !Array.isArray(value.messages)
    || value.messages.length !== 0
    || value.threadId !== undefined
  ) {
    throw new Error("settings session projection is not a data shell");
  }
  if (
    value.backendBindings !== undefined
    && !isPlainObject(value.backendBindings)
  ) {
    throw new Error("settings backend binding projection is invalid");
  }
  if (value.rollingSummary !== undefined) {
    if (
      !isPlainObject(value.rollingSummary)
      || Object.keys(value.rollingSummary).some((key) =>
        key !== "text" && key !== "updatedAt")
      || typeof value.rollingSummary.text !== "string"
      || !isSafeTimestamp(value.rollingSummary.updatedAt)
    ) {
      throw new Error("settings rolling summary projection is invalid");
    }
  }
  if (
    value.messagesHiddenBefore !== undefined
    && !isSafeTimestamp(value.messagesHiddenBefore)
  ) {
    throw new Error("settings hidden-message projection is invalid");
  }
  if (
    value.historyActiveDate !== undefined
    && typeof value.historyActiveDate !== "string"
  ) {
    throw new Error("settings history date projection is invalid");
  }
  if (
    value.tokenUsage !== undefined
    && !isPlainObject(value.tokenUsage)
  ) {
    throw new Error("settings token usage projection is invalid");
  }
}

function collectSettingsEdges(
  sourceSessions: readonly StoredSession[],
  targetSessions: readonly StoredSession[],
  proven: Map<string, RecordMigrationOwnerEdge>
): void {
  const targetById = new Map(targetSessions.map((session) =>
    [session.id, session] as const));
  for (const source of sourceSessions) {
    const target = targetById.get(source.id);
    if (!target) continue;
    const required = ownerEdgesForSession(
      source,
      "settings-projection-owner"
    );
    const actual = new Set(
      ownerEdgesForSession(target, "settings-projection-owner")
        .map(ownerEdgeKey)
    );
    for (const edge of required) {
      if (actual.has(ownerEdgeKey(edge))) proven.set(ownerEdgeKey(edge), edge);
    }
  }
}

function collectNativeEdges(
  sourceSessions: readonly StoredSession[],
  targetSettingsSessions: readonly StoredSession[],
  records: readonly NativeExecutionRecord[],
  proven: Map<string, RecordMigrationOwnerEdge>
): void {
  const targetSettings = new Map(targetSettingsSessions.map((session) =>
    [session.id, session] as const));
  for (const session of sourceSessions) {
    const conversationRef = opaqueMigrationRef("conversation", session.id);
    const sessionEdge = ownerEdgesForSession(
      session,
      "native-execution-owner"
    ).find((edge) => edge.ownerRef === conversationRef);
    if (
      sessionEdge
      && nativeSessionEvidenceIsProven(
        session,
        targetSettings.get(session.id),
        records
      )
    ) {
      proven.set(ownerEdgeKey(sessionEdge), sessionEdge);
    }
    // Legacy message-native diagnostics have no durable message-level link in
    // the current Native Store schema, so they deliberately remain blocked.
  }
}

function collectRunEdges(
  sessions: readonly StoredSession[],
  inventory: RunRecordStoreInventory,
  proven: Map<string, RecordMigrationOwnerEdge>
): void {
  for (const session of sessions) {
    const workflows = inventory.workflowRuns.filter((workflow) =>
      workflow.summary.conversationRef?.conversationId === session.id);
    for (const message of session.messages) {
      if (!runMessageEvidenceIsProven(message, workflows)) continue;
      const messageRef = opaqueMigrationRef("message", session.id, message.id);
      const edge = ownerEdgesForSession(session, "run-record-owner")
        .find((candidate) => candidate.ownerRef === messageRef);
      if (edge) proven.set(ownerEdgeKey(edge), edge);
    }
    // Aggregated legacy session tokenUsage cannot be reconstructed exactly
    // from independent Workflow summaries, so it remains an explicit blocker.
  }
}

function collectLegacyEvidenceEdges(
  required: readonly RecordMigrationOwnerEdge[],
  receipt: ConversationLegacyEvidenceReceipt,
  proven: Map<string, RecordMigrationOwnerEdge>
): void {
  const requiredKeys = new Set(required.map(ownerEdgeKey));
  for (const edge of receipt.externalOwnerEdges) {
    const key = ownerEdgeKey(edge);
    if (requiredKeys.has(key)) proven.set(key, edge);
  }
}

function nativeSessionEvidenceIsProven(
  source: StoredSession,
  targetSettings: StoredSession | undefined,
  records: readonly NativeExecutionRecord[]
): boolean {
  if (
    source.backendBindings !== undefined
    && !isDeepStrictEqual(
      source.backendBindings,
      targetSettings?.backendBindings
    )
  ) {
    return false;
  }
  if (
    source.threadId
    && !records.some((record) =>
      record.sessionId === source.id && record.native.id === source.threadId)
  ) {
    return false;
  }
  for (const binding of Object.values(source.backendBindings ?? {})) {
    const identities = [
      binding.nativeExecutionRef?.id,
      binding.nativeSessionId,
      binding.nativeThreadId
    ].filter((value): value is string => Boolean(value));
    for (const identity of new Set(identities)) {
      const match = records.find((record) =>
        record.sessionId === source.id
        && record.native.backendId === binding.backendId
        && record.native.id === identity);
      if (!match) return false;
      if (
        binding.nativeExecutionRef
        && !isDeepStrictEqual(match.native, binding.nativeExecutionRef)
      ) {
        return false;
      }
    }
  }
  return Boolean(source.threadId || source.backendBindings);
}

function runMessageEvidenceIsProven(
  message: ChatMessage,
  workflows: readonly ConversationWorkflowRunInventory[]
): boolean {
  if (!message.runId) return false;
  if (
    message.phase !== undefined
    || message.processKind !== undefined
    || message.processContentAvailability !== undefined
    || message.processInput !== undefined
    || message.processOutput !== undefined
    || message.runTerminalRecoveryPending !== undefined
    || message.echoInkRunTerminalRecovery !== undefined
    || message.runTerminalRecovered !== undefined
  ) {
    return false;
  }
  const matches = workflows.flatMap((workflow) =>
    workflow.attempts.filter((attempt) =>
      attempt.summary?.harnessRunId === message.runId));
  if (matches.length !== 1 || !matches[0].summary) return false;
  return message.runUsage === undefined
    || isDeepStrictEqual(message.runUsage, matches[0].summary.usage);
}

function v2MessageLineageIsProven(
  conversationId: string,
  workflowRunId: string | undefined,
  attemptId: string | undefined,
  inventory: RunRecordStoreInventory
): boolean {
  if (!workflowRunId) return false;
  const workflows = inventory.workflowRuns.filter((workflow) =>
    workflow.summary.workflowRunId === workflowRunId
    && workflow.summary.conversationRef?.conversationId === conversationId);
  if (workflows.length !== 1) return false;
  if (!attemptId) return true;
  return workflows[0].attempts.some((attempt) =>
    attempt.attemptId === attemptId && attempt.summary !== null);
}

function ownerEdgesForSession(
  session: StoredSession,
  kind: RecordMigrationOwnerKind
): RecordMigrationOwnerEdge[] {
  return legacyExternalOwnerEdges([session]).filter((edge) =>
    edge.kind === kind);
}

function storeFinding(
  code: Exclude<
    ConversationMigrationOwnerProofFindingCode,
    "owner-unproven"
  >,
  store: "settings" | "native" | "run" | "legacy-evidence"
): ConversationMigrationOwnerProofFinding {
  return {
    code,
    ownerKind: null,
    ownerRef: opaqueMigrationRef("migration-owner-store", store),
    resourceRef: null
  };
}

function ownerEdgeKey(edge: RecordMigrationOwnerEdge): string {
  return `${edge.kind}\u0000${edge.ownerRef}\u0000${edge.resourceRef}`;
}

function compareOwnerEdges(
  left: RecordMigrationOwnerEdge,
  right: RecordMigrationOwnerEdge
): number {
  return ownerEdgeKey(left).localeCompare(ownerEdgeKey(right));
}

function compareFindings(
  left: ConversationMigrationOwnerProofFinding,
  right: ConversationMigrationOwnerProofFinding
): number {
  return left.code.localeCompare(right.code)
    || left.ownerRef.localeCompare(right.ownerRef)
    || (left.resourceRef ?? "").localeCompare(right.resourceRef ?? "");
}

function isPlainObject(
  value: unknown
): value is Record<string, unknown> {
  return Boolean(
    value
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
  );
}

function isSafeTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

async function lstatOrNull(target: string) {
  try {
    return await lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
