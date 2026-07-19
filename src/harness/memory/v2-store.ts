import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import * as path from "node:path";

export const ECHOINK_MEMORY_SCHEMA_VERSION = 2;
export const MAX_MEMORY_EVENT_TEXT_CHARS = 12_000;
export const MAX_MEMORY_EVENT_DATA_CHARS = 8_000;
export const MAX_PENDING_MEMORY_EVENTS = 500;

const pendingJournalTails = new Map<string, Promise<void>>();
const formalMutationTails = new Map<string, Promise<void>>();
const MEMORY_RECORD_KINDS = new Set(["current-state", "preference", "decision", "constraint", "open-loop", "task-state", "workflow-rule", "lesson"]);
const PENDING_MEMORY_EVENT_TYPES = new Set<PendingMemoryEventType>(["user-input", "tool-effect", "file-effect", "final-result", "workflow-result"]);
const UNSAFE_MEMORY_CONTROL_CHARACTER = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

export interface EchoInkMemoryV2Layout {
  root: string;
  manifest: string;
  index: string;
  current: string;
  spec: string;
  tasks: string;
  archive: string;
  runtime: string;
  pending: string;
  transactions: string;
  runs: string;
  audit: string;
  exports: string;
  backups: string;
}

export interface MemoryManifestV2 {
  schemaVersion: 2;
  projectId: string;
  revision: number;
  lastSyncAt: number | null;
  lastOutcome: "never" | "write" | "no-op" | "pending" | "failed";
  lastError: string;
}

export interface MemoryIndexV2<T = unknown> {
  schemaVersion: 2;
  revision: number;
  commitId?: string;
  memories: T[];
  confirmations: unknown[];
}

export interface MemoryProjectionRecordV2 {
  id: string;
  kind: string;
  scope: string;
  statement: string;
  evidenceRefs: string[];
  sourceRunId: string;
  sourceConversationIds?: string[];
  sourceDeletions?: Array<{
    mutationId: string;
    conversationId: string;
    deletedAt: number;
    forwardTransactionId: string;
    restoredAt?: number;
    restoreTransactionId?: string;
  }>;
  confidence: number;
  expiresAt?: number;
  supersededAt?: number;
  supersededReason?: string;
  deletedAt?: number;
  deletedReason?: string;
  expiredAt?: number;
}

export type PendingMemoryEventType = "user-input" | "tool-effect" | "file-effect" | "final-result" | "workflow-result";

export interface PendingMemoryEvent {
  schemaVersion: 2;
  eventId: string;
  runId: string;
  sessionId: string;
  workflow: string;
  backendId: string;
  eventType: PendingMemoryEventType;
  createdAt: number;
  payload: {
    text?: string;
    data?: Record<string, unknown>;
  };
  redacted: boolean;
  checksum: string;
}

export type ExistingMemoryTransactionState =
  | "prepared"
  | "applied"
  | "unresolved"
  | "invalid"
  | "failed"
  | "committing"
  | "committed"
  | "recovered";

export interface ExistingMemoryTransactionSnapshot {
  transactionId: string;
  state: ExistingMemoryTransactionState;
  baseRevision: number;
  targetRevision: number;
  eventIds: string[];
  sourceConversationIds: string[];
  outcome: "no-pending" | "write" | "no-op" | "pending" | "failed";
  committedMemoryIds: string[];
  confirmationIds: string[];
  createdAt: number;
  updatedAt: number;
  error: string;
  operation?: string;
}

export type ExistingEchoInkMemoryV2Snapshot =
  | { state: "missing" }
  | {
      state: "present";
      manifest: MemoryManifestV2;
      index: MemoryIndexV2<MemoryProjectionRecordV2>;
      pendingEvents: PendingMemoryEvent[];
      transactions: ExistingMemoryTransactionSnapshot[];
      snapshotDigest: string;
    };

export function echoInkMemoryV2Layout(vaultPath: string): EchoInkMemoryV2Layout {
  const root = path.join(vaultPath, ".echoink", "memory");
  const runtime = path.join(root, ".runtime");
  return {
    root,
    manifest: path.join(root, "manifest.json"),
    index: path.join(root, "index.json"),
    current: path.join(root, "current.md"),
    spec: path.join(root, "spec"),
    tasks: path.join(root, "tasks"),
    archive: path.join(root, "archive"),
    runtime,
    pending: path.join(runtime, "pending-events.jsonl"),
    transactions: path.join(runtime, "transactions"),
    runs: path.join(runtime, "runs"),
    audit: path.join(runtime, "audit.jsonl"),
    exports: path.join(root, "exports"),
    backups: path.join(root, "backups")
  };
}

export async function initializeEchoInkMemoryV2(
  vaultPath: string,
  options: { beforeProjectionRepairWrite?: (snapshot: MemoryIndexV2<MemoryProjectionRecordV2>) => Promise<void> } = {}
): Promise<EchoInkMemoryV2Layout> {
  const layout = echoInkMemoryV2Layout(vaultPath);
  for (const dir of [layout.root, layout.spec, layout.tasks, layout.archive, layout.runtime, layout.transactions, layout.runs, layout.exports, layout.backups]) {
    await mkdir(dir, { recursive: true });
  }
  const manifestExists = await pathExists(layout.manifest);
  const indexExists = await pathExists(layout.index);
  if (manifestExists) validateMemoryManifest(await readStrictJson(layout.manifest, "manifest.json"));
  let canonicalIndex: MemoryIndexV2<MemoryProjectionRecordV2> = defaultIndex() as MemoryIndexV2<MemoryProjectionRecordV2>;
  let migratedIndex: MemoryIndexV2<MemoryProjectionRecordV2> | null = null;
  if (indexExists) {
    const current = await readStrictJson(layout.index, "index.json");
    if (isLegacyMemoryIndex(current)) {
      migratedIndex = { ...defaultIndex(), memories: [...current.memories] as MemoryProjectionRecordV2[] };
      canonicalIndex = migratedIndex;
    } else {
      canonicalIndex = validateMemoryIndexV2(current) as MemoryIndexV2<MemoryProjectionRecordV2>;
    }
  }
  if (!manifestExists) await atomicWriteJson(layout.manifest, defaultManifest());
  const projectionRepairMarker = path.join(layout.runtime, "projection-repair.json");
  const projectionFiles = memoryProjectionFiles(layout.root);
  const projectionsMissing = (await Promise.all(projectionFiles.map(pathExists))).some((exists) => !exists);
  if (migratedIndex) {
    await atomicWriteJson(projectionRepairMarker, { schemaVersion: 2, revision: migratedIndex.revision, reason: "v1-migration" });
    await atomicWriteJson(layout.index, migratedIndex);
  } else if (!indexExists) {
    await atomicWriteJson(layout.index, canonicalIndex);
  }
  if (projectionsMissing && !await pathExists(projectionRepairMarker)) {
    await atomicWriteJson(projectionRepairMarker, { schemaVersion: 2, revision: canonicalIndex.revision, reason: "missing-projection" });
  }
  if (await pathExists(projectionRepairMarker)) {
    await repairMemoryProjectionSetCas(layout, canonicalIndex, options.beforeProjectionRepairWrite);
    await unlink(projectionRepairMarker).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
  }
  for (const [file, content] of [
    [layout.pending, ""],
    [layout.audit, ""]
  ] as const) {
    if (!await pathExists(file)) await atomicWriteText(file, content);
  }
  return layout;
}

export async function readMemoryManifestV2(vaultPath: string): Promise<MemoryManifestV2> {
  const layout = await initializeEchoInkMemoryV2(vaultPath);
  return validateMemoryManifest(await readStrictJson(layout.manifest, "manifest.json"));
}

export async function readMemoryIndexV2<T = unknown>(vaultPath: string): Promise<MemoryIndexV2<T>> {
  const layout = await initializeEchoInkMemoryV2(vaultPath);
  return validateMemoryIndexV2(await readStrictJson(layout.index, "index.json")) as MemoryIndexV2<T>;
}

/**
 * Reads only the formal existing Store needed by destructive lifecycle
 * planning. Unlike normal Memory reads, this path never initializes the root,
 * migrates a legacy index, repairs projections or creates pending files.
 */
export async function readExistingEchoInkMemoryV2Snapshot(
  vaultPath: string
): Promise<ExistingEchoInkMemoryV2Snapshot> {
  const first = await readExistingEchoInkMemoryV2SnapshotOnce(vaultPath);
  const second = await readExistingEchoInkMemoryV2SnapshotOnce(vaultPath);
  if (
    first.state !== second.state
    || (
      first.state === "present"
      && second.state === "present"
      && first.snapshotDigest !== second.snapshotDigest
    )
  ) {
    throw new Error(
      "EchoInk Memory recovery required: formal Store changed during read-only snapshot"
    );
  }
  return first;
}

export async function appendPendingMemoryEvent(
  vaultPath: string,
  input: Omit<PendingMemoryEvent, "schemaVersion" | "eventId" | "payload" | "redacted" | "checksum"> & {
    eventId?: string;
    payload?: PendingMemoryEvent["payload"];
  }
): Promise<PendingMemoryEvent> {
  return await enqueueVaultMutation(pendingJournalTails, vaultPath, async () => {
    const layout = await initializeEchoInkMemoryV2(vaultPath);
    const current = await readPendingMemoryEvents(vaultPath);
    const eventId = input.eventId?.trim() || `memory-event-${randomUUID()}`;
    const existing = current.find((event) => event.eventId === eventId);
    if (existing) return existing;
    if (current.length >= MAX_PENDING_MEMORY_EVENTS) throw new Error(`EchoInk Memory pending journal reached ${MAX_PENDING_MEMORY_EVENTS} events`);
    const sanitized = sanitizeMemoryPayload(input.payload ?? {});
    const base = {
      schemaVersion: ECHOINK_MEMORY_SCHEMA_VERSION,
      eventId,
      runId: bounded(input.runId, 240),
      sessionId: bounded(input.sessionId, 240),
      workflow: bounded(input.workflow, 120),
      backendId: bounded(input.backendId, 120),
      eventType: input.eventType,
      createdAt: input.createdAt,
      payload: sanitized.payload,
      redacted: sanitized.redacted
    } as const;
    const event: PendingMemoryEvent = {
      ...base,
      checksum: checksum(base)
    };
    await writePendingMemoryEvents(layout.pending, [...current, event]);
    return event;
  });
}

export async function readPendingMemoryEvents(vaultPath: string): Promise<PendingMemoryEvent[]> {
  const layout = await initializeEchoInkMemoryV2(vaultPath);
  const text = await readFile(layout.pending, "utf8").catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  });
  return parsePendingMemoryEventsText(text);
}

function parsePendingMemoryEventsText(text: string): PendingMemoryEvent[] {
  const events: PendingMemoryEvent[] = [];
  let lineNumber = 0;
  for (const line of text.split(/\r?\n/)) {
    lineNumber += 1;
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch (error) {
      throw new Error(`EchoInk Memory recovery required: pending journal line ${lineNumber} is not valid JSON`, { cause: error });
    }
    if (!isPendingMemoryEvent(parsed) || checksum({ ...parsed, checksum: undefined }) !== parsed.checksum) {
      throw new Error(`EchoInk Memory recovery required: pending journal line ${lineNumber} is invalid or corrupted`);
    }
    events.push(parsed);
  }
  return events;
}

export async function replacePendingMemoryEvents(
  vaultPath: string,
  replacement: PendingMemoryEvent[] | ((current: PendingMemoryEvent[]) => PendingMemoryEvent[])
): Promise<void> {
  await enqueueVaultMutation(pendingJournalTails, vaultPath, async () => {
    const layout = await initializeEchoInkMemoryV2(vaultPath);
    const current = await readPendingMemoryEvents(vaultPath);
    const events = typeof replacement === "function" ? replacement(current) : replacement;
    if (events.length > MAX_PENDING_MEMORY_EVENTS) throw new Error(`EchoInk Memory pending journal reached ${MAX_PENDING_MEMORY_EVENTS} events`);
    await writePendingMemoryEvents(layout.pending, events);
  });
}

export async function withMemoryFormalMutation<T>(vaultPath: string, mutation: () => Promise<T>): Promise<T> {
  return await enqueueVaultMutation(formalMutationTails, vaultPath, mutation);
}

export interface MemoryRunStateV2 {
  schemaVersion: 2;
  runId: string;
  sessionId: string;
  workflow: string;
  backendId: string;
  captureMode: "signal" | "workflow-result";
  eventIds: string[];
  terminalStatus?: "completed" | "failed" | "cancelled";
  finalText?: string;
  localCommit?: "pending" | "completed" | "failed";
  localCommitData?: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export async function writeMemoryRunState(vaultPath: string, state: MemoryRunStateV2): Promise<void> {
  const layout = await initializeEchoInkMemoryV2(vaultPath);
  const sanitized = sanitizeMemoryPayload({ text: state.finalText, data: state.localCommitData });
  await atomicWriteJson(path.join(layout.runs, `${safeName(state.runId)}.json`), {
    ...state,
    finalText: sanitized.payload.text,
    localCommitData: sanitized.payload.data
  });
}

export async function readMemoryRunState(vaultPath: string, runId: string): Promise<MemoryRunStateV2 | null> {
  const layout = await initializeEchoInkMemoryV2(vaultPath);
  try {
    const state = JSON.parse(await readFile(path.join(layout.runs, `${safeName(runId)}.json`), "utf8")) as MemoryRunStateV2;
    return state?.schemaVersion === 2 && state.runId === runId ? state : null;
  } catch {
    return null;
  }
}

export async function listMemoryRunStates(vaultPath: string): Promise<MemoryRunStateV2[]> {
  const layout = await initializeEchoInkMemoryV2(vaultPath);
  const states: MemoryRunStateV2[] = [];
  for (const entry of await readdir(layout.runs, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    try {
      const state = JSON.parse(await readFile(path.join(layout.runs, entry.name), "utf8")) as unknown;
      if (isMemoryRunState(state)) states.push(state);
    } catch {
      // Invalid run-state files remain on disk for explicit inspection.
    }
  }
  return states.sort((left, right) => left.createdAt - right.createdAt || (left.runId < right.runId ? -1 : left.runId > right.runId ? 1 : 0));
}

export async function removeMemoryRunState(vaultPath: string, runId: string): Promise<void> {
  const layout = await initializeEchoInkMemoryV2(vaultPath);
  await unlink(path.join(layout.runs, `${safeName(runId)}.json`)).catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  });
}

export async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  await atomicWriteText(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export async function atomicWriteText(filePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temporary, content, "utf8");
  await rename(temporary, filePath);
}

export async function writeMemoryProjectionSet(root: string, memories: MemoryProjectionRecordV2[], now: number): Promise<void> {
  const active = memories.filter((item) => isProjectionMemoryActive(item, now));
  const groups = {
    current: active.filter((item) => item.kind === "current-state" || item.kind === "open-loop"),
    spec: active.filter((item) => ["preference", "decision", "constraint", "workflow-rule", "lesson"].includes(item.kind)),
    tasks: active.filter((item) => item.kind === "task-state"),
    archive: memories.filter((item) => !isProjectionMemoryActive(item, now))
  };
  const files = memoryProjectionFiles(root);
  const contents = [
    renderMemoryProjection("Current", groups.current),
    renderMemoryProjection("Spec", groups.spec),
    renderMemoryProjection("Tasks", groups.tasks),
    renderMemoryProjection("Archive", groups.archive)
  ];
  await Promise.all(files.map((file, index) => atomicWriteText(file, contents[index])));
}

async function repairMemoryProjectionSetCas(
  layout: EchoInkMemoryV2Layout,
  initial: MemoryIndexV2<MemoryProjectionRecordV2>,
  beforeWrite?: (snapshot: MemoryIndexV2<MemoryProjectionRecordV2>) => Promise<void>
): Promise<void> {
  let snapshot = initial;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await beforeWrite?.(snapshot);
    await writeMemoryProjectionSet(layout.root, snapshot.memories, Date.now());
    const latest = validateMemoryIndexV2(await readStrictJson(layout.index, "index.json")) as MemoryIndexV2<MemoryProjectionRecordV2>;
    if (latest.revision === snapshot.revision && latest.commitId === snapshot.commitId) return;
    snapshot = latest;
  }
  throw new Error("EchoInk Memory recovery required: index changed repeatedly while repairing projections");
}

function memoryProjectionFiles(root: string): string[] {
  return [
    path.join(root, "current.md"),
    path.join(root, "spec", "index.md"),
    path.join(root, "tasks", "index.md"),
    path.join(root, "archive", "index.md")
  ];
}

function renderMemoryProjection(title: string, memories: MemoryProjectionRecordV2[]): string {
  const lines = [`# ${title}`, "", "<!-- Generated from index.json. Do not edit directly. -->", ""];
  for (const item of [...memories].sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0)) {
    lines.push(`## ${item.id}`, "", item.statement, "", `- Kind: ${item.kind}`, `- Scope: ${item.scope}`, `- Source run: ${item.sourceRunId}`, `- Confidence: ${item.confidence}`);
    if (item.sourceConversationIds?.length) {
      lines.push(`- Source conversations: ${item.sourceConversationIds.join(", ")}`);
    }
    for (const marker of item.sourceDeletions ?? []) {
      lines.push(
        marker.restoredAt === undefined
          ? `- Source deleted: ${marker.conversationId} (${marker.mutationId})`
          : `- Source restored: ${marker.conversationId} (${marker.mutationId})`
      );
    }
    if (item.evidenceRefs.length) lines.push(`- Evidence: ${item.evidenceRefs.join(", ")}`);
    if (item.supersededAt !== undefined) lines.push(`- Superseded: ${item.supersededReason || "yes"}`);
    if (item.deletedAt !== undefined) lines.push(`- Deleted: ${item.deletedReason || "yes"}`);
    if (item.expiredAt !== undefined) lines.push("- Expired: yes");
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

function isProjectionMemoryActive(item: MemoryProjectionRecordV2, now: number): boolean {
  return item.supersededAt === undefined
    && item.deletedAt === undefined
    && item.expiredAt === undefined
    && !(typeof item.expiresAt === "number" && item.expiresAt <= now);
}

async function writePendingMemoryEvents(filePath: string, events: PendingMemoryEvent[]): Promise<void> {
  await atomicWriteText(filePath, events.length ? `${events.map((event) => JSON.stringify(event)).join("\n")}\n` : "");
}

async function enqueueVaultMutation<T>(
  lanes: Map<string, Promise<void>>,
  vaultPath: string,
  mutation: () => Promise<T>
): Promise<T> {
  const key = path.resolve(vaultPath);
  const previous = lanes.get(key) ?? Promise.resolve();
  const operation = previous.catch(() => undefined).then(mutation);
  const tail = operation.then(() => undefined, () => undefined);
  lanes.set(key, tail);
  try {
    return await operation;
  } finally {
    if (lanes.get(key) === tail) lanes.delete(key);
  }
}

export function redactAndBoundMemoryText(value: string, max = MAX_MEMORY_EVENT_TEXT_CHARS): string {
  return bounded(redactSecrets(value), Math.max(1, max));
}

function sanitizeMemoryPayload(payload: PendingMemoryEvent["payload"]): { payload: PendingMemoryEvent["payload"]; redacted: boolean } {
  let redacted = false;
  const redact = (value: string, max: number): string => {
    const result = redactSecrets(value);
    redacted = redacted || result !== value;
    return bounded(result, max);
  };
  const text = typeof payload.text === "string" ? redact(payload.text, MAX_MEMORY_EVENT_TEXT_CHARS) : undefined;
  let data: Record<string, unknown> | undefined;
  if (payload.data && typeof payload.data === "object") {
    const serialized = redact(JSON.stringify(payload.data), MAX_MEMORY_EVENT_DATA_CHARS);
    try {
      const parsed = JSON.parse(serialized) as unknown;
      data = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : { value: serialized };
    } catch {
      data = { value: serialized };
    }
  }
  return { payload: { ...(text !== undefined ? { text } : {}), ...(data ? { data } : {}) }, redacted };
}

function redactSecrets(value: string): string {
  return value
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED_PRIVATE_KEY]")
    .replace(/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{12,}\b/g, "[REDACTED_API_KEY]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, "Bearer [REDACTED_TOKEN]")
    .replace(
      /((?:"?(?:api[_-]?key|token|secret|password)"?)\s*[:=]\s*)("[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}]+)/gi,
      (_match, prefix: string, secret: string) => {
        const quote = secret.startsWith("\"") ? "\"" : secret.startsWith("'") ? "'" : "";
        return `${prefix}${quote}[REDACTED]${quote}`;
      }
    );
}

function checksum(value: unknown): string {
  const normalized = value && typeof value === "object" && "checksum" in value
    ? Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([key, item]) => key !== "checksum" && item !== undefined))
    : value;
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

function isPendingMemoryEvent(value: unknown): value is PendingMemoryEvent {
  if (!isRecord(value)) return false;
  const event = value as Partial<PendingMemoryEvent>;
  return event.schemaVersion === ECHOINK_MEMORY_SCHEMA_VERSION
    && isSafeStoredText(event.eventId, 320, false)
    && isSafeStoredText(event.runId, 240, false)
    && isSafeStoredText(event.sessionId, 240, false)
    && isSafeStoredText(event.workflow, 120, false)
    && isSafeStoredText(event.backendId, 120, false)
    && PENDING_MEMORY_EVENT_TYPES.has(event.eventType as PendingMemoryEventType)
    && isStoredTimestamp(event.createdAt)
    && isRecord(event.payload)
    && (event.payload.text === undefined || (
      typeof event.payload.text === "string"
      && event.payload.text.length <= MAX_MEMORY_EVENT_TEXT_CHARS
      && !UNSAFE_MEMORY_CONTROL_CHARACTER.test(event.payload.text)
    ))
    && (event.payload.data === undefined || (
      isRecord(event.payload.data)
      && JSON.stringify(event.payload.data).length <= MAX_MEMORY_EVENT_DATA_CHARS + 128
    ))
    && typeof event.redacted === "boolean"
    && typeof event.checksum === "string"
    && /^[a-f0-9]{64}$/.test(event.checksum);
}

function isMemoryRunState(value: unknown): value is MemoryRunStateV2 {
  if (!isRecord(value)) return false;
  return value.schemaVersion === 2
    && isSafeStoredText(value.runId, 240, false)
    && isSafeStoredText(value.sessionId, 240, false)
    && isSafeStoredText(value.workflow, 120, false)
    && isSafeStoredText(value.backendId, 120, false)
    && (value.captureMode === "signal" || value.captureMode === "workflow-result")
    && Array.isArray(value.eventIds)
    && value.eventIds.every((eventId) => isSafeStoredText(eventId, 320, false))
    && isStoredTimestamp(value.createdAt)
    && isStoredTimestamp(value.updatedAt);
}

function defaultManifest(): MemoryManifestV2 {
  return {
    schemaVersion: ECHOINK_MEMORY_SCHEMA_VERSION,
    projectId: randomUUID(),
    revision: 0,
    lastSyncAt: null,
    lastOutcome: "never",
    lastError: ""
  };
}

function defaultIndex(): MemoryIndexV2 {
  return {
    schemaVersion: ECHOINK_MEMORY_SCHEMA_VERSION,
    revision: 0,
    commitId: "initial",
    memories: [],
    confirmations: []
  };
}

function bounded(value: string, max: number): string {
  const normalized = value.trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, Math.max(0, max - 1))}…`;
}

function safeName(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "run";
}

async function readStrictJson(filePath: string, label: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as unknown;
  } catch (error) {
    throw new Error(`EchoInk Memory recovery required: ${label} is not valid JSON`, { cause: error });
  }
}

export function validateMemoryManifest(value: unknown): MemoryManifestV2 {
  if (!isRecord(value)) throw new Error("EchoInk Memory recovery required: manifest.json must be an object");
  if (value.schemaVersion !== ECHOINK_MEMORY_SCHEMA_VERSION) {
    const detail = typeof value.schemaVersion === "number" && value.schemaVersion > ECHOINK_MEMORY_SCHEMA_VERSION ? "uses a future schema" : "has an unsupported schema";
    throw new Error(`EchoInk Memory recovery required: manifest.json ${detail}`);
  }
  if (typeof value.projectId !== "string" || !value.projectId.trim() || !isNonNegativeInteger(value.revision)) {
    throw new Error("EchoInk Memory recovery required: manifest.json fields are invalid");
  }
  if (value.lastSyncAt !== null && !(typeof value.lastSyncAt === "number" && Number.isFinite(value.lastSyncAt) && value.lastSyncAt >= 0)) {
    throw new Error("EchoInk Memory recovery required: manifest.json lastSyncAt is invalid");
  }
  if (!(["never", "write", "no-op", "pending", "failed"] as unknown[]).includes(value.lastOutcome) || typeof value.lastError !== "string") {
    throw new Error("EchoInk Memory recovery required: manifest.json outcome fields are invalid");
  }
  return value as unknown as MemoryManifestV2;
}

async function readExistingEchoInkMemoryV2SnapshotOnce(
  vaultPath: string
): Promise<ExistingEchoInkMemoryV2Snapshot> {
  const layout = echoInkMemoryV2Layout(vaultPath);
  const rootStats = await lstatOrNull(layout.root);
  if (!rootStats) return { state: "missing" };
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    throw new Error(
      "EchoInk Memory recovery required: formal Store root is not a plain directory"
    );
  }
  const manifest = validateMemoryManifest(JSON.parse(
    await readExistingMemoryRegularFile(
      layout.manifest,
      "manifest.json",
      1024 * 1024
    )
  ) as unknown);
  const index = validateMemoryIndexV2(JSON.parse(
    await readExistingMemoryRegularFile(
      layout.index,
      "index.json",
      32 * 1024 * 1024
    )
  ) as unknown) as MemoryIndexV2<MemoryProjectionRecordV2>;
  const pendingEvents = parsePendingMemoryEventsText(
    await readExistingMemoryRegularFile(
      layout.pending,
      "pending-events.jsonl",
      32 * 1024 * 1024
    )
  );
  const transactions = await readExistingMemoryTransactions(layout);
  if (manifest.revision !== index.revision) {
    throw new Error(
      "EchoInk Memory recovery required: manifest and index revisions differ"
    );
  }
  const snapshotDigest = `sha256:${checksum({
    manifest,
    index,
    pendingEvents,
    transactions
  })}`;
  return {
    state: "present",
    manifest: { ...manifest },
    index: {
      ...index,
      memories: index.memories.map((memory) => cloneMemoryProjection(memory)),
      confirmations: index.confirmations.map(cloneStoredValue)
    },
    pendingEvents: pendingEvents.map(clonePendingMemoryEvent),
    transactions: transactions.map(cloneExistingMemoryTransaction),
    snapshotDigest
  };
}

async function readExistingMemoryTransactions(
  layout: EchoInkMemoryV2Layout
): Promise<ExistingMemoryTransactionSnapshot[]> {
  const rootStats = await lstatOrNull(layout.transactions);
  if (
    !rootStats
    || !rootStats.isDirectory()
    || rootStats.isSymbolicLink()
  ) {
    throw new Error(
      "EchoInk Memory recovery required: transactions root is missing or unsafe"
    );
  }
  const entries = await readdir(layout.transactions, {
    withFileTypes: true
  });
  const transactions: ExistingMemoryTransactionSnapshot[] = [];
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name)
  )) {
    if (
      !entry.isDirectory()
      || entry.isSymbolicLink()
      || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,319}$/.test(entry.name)
    ) {
      throw new Error(
        `EchoInk Memory recovery required: transactions contains unsafe entry ${entry.name}`
      );
    }
    const transactionRoot = path.join(layout.transactions, entry.name);
    const transaction = parseExistingMemoryTransaction(JSON.parse(
      await readExistingMemoryRegularFile(
        path.join(transactionRoot, "transaction.json"),
        `transactions/${entry.name}/transaction.json`,
        1024 * 1024
      )
    ) as unknown);
    if (safeName(transaction.transactionId) !== entry.name) {
      throw new Error(
        `EchoInk Memory recovery required: transaction ${entry.name} identity mismatch`
      );
    }
    let sourceConversationIds: string[] = [];
    if (transaction.eventIds.length) {
      const source = parseExistingMemoryTransactionSource(JSON.parse(
        await readExistingMemoryRegularFile(
          path.join(transactionRoot, "source.json"),
          `transactions/${entry.name}/source.json`,
          32 * 1024 * 1024
        )
      ) as unknown);
      if (
        source.transactionId !== transaction.transactionId
        || source.baseRevision !== transaction.baseRevision
        || source.eventIds.length !== transaction.eventIds.length
        || source.eventIds.some(
          (eventId, index) => eventId !== transaction.eventIds[index]
        )
      ) {
        throw new Error(
          `EchoInk Memory recovery required: transaction ${entry.name} source identity mismatch`
        );
      }
      sourceConversationIds = [...new Set(
        source.events.map((event) => event.sessionId)
      )].sort(compareText);
    }
    transactions.push({
      ...transaction,
      sourceConversationIds
    });
  }
  return transactions;
}

function parseExistingMemoryTransaction(
  value: unknown
): Omit<ExistingMemoryTransactionSnapshot, "sourceConversationIds"> {
  if (!isRecord(value)) {
    throw new Error(
      "EchoInk Memory recovery required: transaction.json must be an object"
    );
  }
  const allowedKeys = new Set([
    "schemaVersion",
    "transactionId",
    "state",
    "baseRevision",
    "targetRevision",
    "eventIds",
    "outcome",
    "committedMemoryIds",
    "confirmationIds",
    "createdAt",
    "updatedAt",
    "error",
    "operation"
  ]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    throw new Error(
      "EchoInk Memory recovery required: transaction.json contains an unexpected field"
    );
  }
  const states = new Set<ExistingMemoryTransactionState>([
    "prepared",
    "applied",
    "unresolved",
    "invalid",
    "failed",
    "committing",
    "committed",
    "recovered"
  ]);
  const outcomes = new Set([
    "no-pending",
    "write",
    "no-op",
    "pending",
    "failed"
  ]);
  if (
    value.schemaVersion !== ECHOINK_MEMORY_SCHEMA_VERSION
    || !isSafeStoredText(value.transactionId, 320, false)
    || !states.has(value.state as ExistingMemoryTransactionState)
    || !isNonNegativeInteger(value.baseRevision)
    || !isNonNegativeInteger(value.targetRevision)
    || Number(value.targetRevision) < Number(value.baseRevision)
    || !isSafeStoredStringArray(
      value.eventIds,
      MAX_PENDING_MEMORY_EVENTS,
      320
    )
    || new Set(value.eventIds).size !== value.eventIds.length
    || !outcomes.has(String(value.outcome))
    || !isSafeStoredStringArray(
      value.committedMemoryIds,
      MAX_PENDING_MEMORY_EVENTS,
      320
    )
    || !isSafeStoredStringArray(
      value.confirmationIds,
      MAX_PENDING_MEMORY_EVENTS,
      320
    )
    || !isStoredTimestamp(value.createdAt)
    || !isStoredTimestamp(value.updatedAt)
    || Number(value.updatedAt) < Number(value.createdAt)
    || typeof value.error !== "string"
    || value.error.length > 12_000
    || UNSAFE_MEMORY_CONTROL_CHARACTER.test(value.error)
    || (
      value.operation !== undefined
      && !isSafeStoredText(value.operation, 240, false)
    )
  ) {
    throw new Error(
      "EchoInk Memory recovery required: transaction.json fields are invalid"
    );
  }
  return {
    transactionId: value.transactionId,
    state: value.state as ExistingMemoryTransactionState,
    baseRevision: value.baseRevision,
    targetRevision: value.targetRevision,
    eventIds: [...value.eventIds],
    outcome: value.outcome as ExistingMemoryTransactionSnapshot["outcome"],
    committedMemoryIds: [...value.committedMemoryIds],
    confirmationIds: [...value.confirmationIds],
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    error: value.error,
    ...(value.operation !== undefined
      ? { operation: value.operation }
      : {})
  };
}

function parseExistingMemoryTransactionSource(value: unknown): {
  transactionId: string;
  baseRevision: number;
  events: PendingMemoryEvent[];
  eventIds: string[];
} {
  if (
    !isRecord(value)
    || value.schemaVersion !== ECHOINK_MEMORY_SCHEMA_VERSION
    || !isSafeStoredText(value.transactionId, 320, false)
    || !isNonNegativeInteger(value.baseRevision)
    || !Array.isArray(value.events)
    || value.events.length < 1
    || value.events.length > MAX_PENDING_MEMORY_EVENTS
    || !Array.isArray(value.activeMemories)
  ) {
    throw new Error(
      "EchoInk Memory recovery required: transaction source fields are invalid"
    );
  }
  const events = value.events.map((event) => {
    if (
      !isPendingMemoryEvent(event)
      || checksum({ ...event, checksum: undefined }) !== event.checksum
    ) {
      throw new Error(
        "EchoInk Memory recovery required: transaction source contains an invalid event"
      );
    }
    return event;
  });
  for (const memory of value.activeMemories) {
    validateStoredMemoryRecord(memory, true);
  }
  return {
    transactionId: value.transactionId,
    baseRevision: value.baseRevision,
    events,
    eventIds: events.map((event) => event.eventId)
  };
}

async function readExistingMemoryRegularFile(
  filePath: string,
  label: string,
  maxBytes: number
): Promise<string> {
  const before = await lstat(filePath).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        `EchoInk Memory recovery required: ${label} is missing`
      );
    }
    throw error;
  });
  if (
    !before.isFile()
    || before.isSymbolicLink()
    || before.nlink < 1
    || before.nlink > 2
    || before.size > maxBytes
  ) {
    throw new Error(
      `EchoInk Memory recovery required: ${label} is unsafe`
    );
  }
  const text = await readFile(filePath, "utf8");
  const after = await lstat(filePath);
  if (
    !after.isFile()
    || after.isSymbolicLink()
    || before.dev !== after.dev
    || before.ino !== after.ino
    || before.size !== after.size
    || before.mtimeMs !== after.mtimeMs
    || before.ctimeMs !== after.ctimeMs
    || Buffer.byteLength(text, "utf8") !== before.size
  ) {
    throw new Error(
      `EchoInk Memory recovery required: ${label} changed during read-only snapshot`
    );
  }
  return text;
}

function cloneMemoryProjection(
  memory: MemoryProjectionRecordV2
): MemoryProjectionRecordV2 {
  return {
    ...memory,
    evidenceRefs: [...memory.evidenceRefs],
    ...(memory.sourceConversationIds
      ? { sourceConversationIds: [...memory.sourceConversationIds] }
      : {}),
    ...(memory.sourceDeletions
      ? {
          sourceDeletions: memory.sourceDeletions.map((marker) => ({
            ...marker
          }))
        }
      : {})
  };
}

function clonePendingMemoryEvent(
  event: PendingMemoryEvent
): PendingMemoryEvent {
  return {
    ...event,
    payload: cloneStoredValue(event.payload)
  };
}

function cloneExistingMemoryTransaction(
  transaction: ExistingMemoryTransactionSnapshot
): ExistingMemoryTransactionSnapshot {
  return {
    ...transaction,
    eventIds: [...transaction.eventIds],
    sourceConversationIds: [...transaction.sourceConversationIds],
    committedMemoryIds: [...transaction.committedMemoryIds],
    confirmationIds: [...transaction.confirmationIds]
  };
}

function cloneStoredValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

async function lstatOrNull(filePath: string) {
  try {
    return await lstat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export function validateMemoryIndexV2(value: unknown): MemoryIndexV2 {
  if (!isRecord(value)) throw new Error("EchoInk Memory recovery required: index.json must be an object");
  if (value.schemaVersion !== ECHOINK_MEMORY_SCHEMA_VERSION) {
    const detail = typeof value.schemaVersion === "number" && value.schemaVersion > ECHOINK_MEMORY_SCHEMA_VERSION ? "uses a future schema" : "has an unsupported schema";
    throw new Error(`EchoInk Memory recovery required: index.json ${detail}`);
  }
  if (!isNonNegativeInteger(value.revision) || !Array.isArray(value.memories) || !Array.isArray(value.confirmations)) {
    throw new Error("EchoInk Memory recovery required: index.json fields are invalid");
  }
  if (value.commitId !== undefined && !isSafeStoredText(value.commitId, 240, false)) {
    throw new Error("EchoInk Memory recovery required: index.json commitId is invalid");
  }
  const memoryIds = new Set<string>();
  for (const item of value.memories) {
    validateStoredMemoryRecord(item, true);
    if (memoryIds.has(item.id as string)) throw new Error(`EchoInk Memory recovery required: index.json contains duplicate memory id ${(item.id as string)}`);
    memoryIds.add(item.id as string);
  }
  const confirmationIds = new Set<string>();
  for (const confirmation of value.confirmations) {
    validateStoredMemoryConfirmation(confirmation);
    if (confirmationIds.has(confirmation.id as string)) throw new Error(`EchoInk Memory recovery required: index.json contains duplicate confirmation id ${(confirmation.id as string)}`);
    confirmationIds.add(confirmation.id as string);
  }
  return value as unknown as MemoryIndexV2;
}

function isLegacyMemoryIndex(value: unknown): value is { version: 1; memories: unknown[] } {
  return isRecord(value)
    && value.version === 1
    && Array.isArray(value.memories)
    && value.memories.every((item) => isValidStoredMemoryRecord(item, true))
    && (value.confirmations === undefined || (Array.isArray(value.confirmations) && value.confirmations.length === 0));
}

function validateStoredMemoryRecord(value: unknown, requireTimes: boolean): asserts value is Record<string, unknown> {
  if (!isValidStoredMemoryRecord(value, requireTimes)) {
    throw new Error("EchoInk Memory recovery required: index.json contains an invalid memory record");
  }
}

function isValidStoredMemoryRecord(value: unknown, requireTimes: boolean): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  if (!isSafeStoredText(value.id, 240, false) || !MEMORY_RECORD_KINDS.has(value.kind as string) || value.scope !== "vault") return false;
  if (!isSafeStoredText(value.statement, 4_000, true) || !isSafeStoredStringArray(value.evidenceRefs, 32, 320) || !isSafeStoredText(value.sourceRunId, 320, false)) return false;
  if (
    value.sourceConversationIds !== undefined
    && !isSafeStoredStringArray(value.sourceConversationIds, 32, 320)
  ) return false;
  const sourceConversationIds = value.sourceConversationIds;
  if (
    sourceConversationIds !== undefined
    && (
      new Set(sourceConversationIds).size !== sourceConversationIds.length
      || sourceConversationIds.some(
        (id, index) => id !== [...sourceConversationIds].sort(compareText)[index]
      )
    )
  ) return false;
  const sourceDeletions = value.sourceDeletions as Array<Record<string, unknown>> | undefined;
  if (
    sourceDeletions !== undefined
    && (
      !Array.isArray(sourceDeletions)
      || sourceDeletions.length > 64
      || !sourceDeletions.every(isValidMemorySourceDeletion)
      || new Set(sourceDeletions.map((marker) => marker.mutationId)).size
        !== sourceDeletions.length
      || sourceDeletions.some(
        (marker, index) => marker.mutationId
          !== [...sourceDeletions].sort(
            (left, right) => compareText(
              String(left.mutationId),
              String(right.mutationId)
            )
          )[index].mutationId
      )
      || !sourceConversationIds
      || sourceDeletions.some(
        (marker) => !sourceConversationIds.includes(String(marker.conversationId))
      )
    )
  ) return false;
  if (!(typeof value.confidence === "number" && Number.isFinite(value.confidence) && value.confidence >= 0 && value.confidence <= 1)) return false;
  if (requireTimes && (!isStoredTimestamp(value.createdAt) || !isStoredTimestamp(value.updatedAt))) return false;
  if (!requireTimes && (value.createdAt !== undefined || value.updatedAt !== undefined)) return false;
  for (const field of ["expiresAt", "supersededAt", "deletedAt", "expiredAt"] as const) {
    if (value[field] !== undefined && !isStoredTimestamp(value[field])) return false;
  }
  for (const field of ["supersededReason", "deletedReason"] as const) {
    if (value[field] !== undefined && !isSafeStoredText(value[field], 1_000, true)) return false;
  }
  return true;
}

function isValidMemorySourceDeletion(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value).sort();
  const expected = value.restoredAt === undefined
    ? ["conversationId", "deletedAt", "forwardTransactionId", "mutationId"]
    : [
        "conversationId",
        "deletedAt",
        "forwardTransactionId",
        "mutationId",
        "restoreTransactionId",
        "restoredAt"
      ];
  if (
    keys.length !== expected.length
    || keys.some((key, index) => key !== [...expected].sort()[index])
  ) return false;
  return isSafeStoredText(value.mutationId, 320, false)
    && isSafeStoredText(value.conversationId, 320, false)
    && isStoredMutationTimestamp(value.deletedAt)
    && isSafeStoredText(value.forwardTransactionId, 320, false)
    && (
      value.restoredAt === undefined
      || (
        isStoredMutationTimestamp(value.restoredAt)
        && Number(value.restoredAt) >= Number(value.deletedAt)
        && isSafeStoredText(value.restoreTransactionId, 320, false)
      )
    );
}

function validateStoredMemoryConfirmation(value: unknown): asserts value is Record<string, unknown> {
  if (!isRecord(value)
    || !isSafeStoredText(value.id, 260, false)
    || !isValidStoredMemoryRecord(value.candidate, false)
    || !isSafeStoredStringArray(value.sourceEventIds, MAX_PENDING_MEMORY_EVENTS, 320)
    || !isSafeStoredText(value.reason, 1_000, true)
    || !isSafeStoredStringArray(value.conflictsWith, MAX_PENDING_MEMORY_EVENTS, 240)
    || !isStoredTimestamp(value.createdAt)) {
    throw new Error("EchoInk Memory recovery required: index.json contains an invalid confirmation record");
  }
}

function isSafeStoredStringArray(value: unknown, maxItems: number, maxChars: number): value is string[] {
  return Array.isArray(value)
    && value.length <= maxItems
    && value.every((item) => isSafeStoredText(item, maxChars, false));
}

function isSafeStoredText(value: unknown, maxChars: number, allowNewline: boolean): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maxChars
    && !UNSAFE_MEMORY_CONTROL_CHARACTER.test(value)
    && (allowNewline || !/[\r\n]/.test(value));
}

function isStoredTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isStoredMutationTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

async function pathExists(filePath: string): Promise<boolean> {
  return stat(filePath).then(() => true, () => false);
}
