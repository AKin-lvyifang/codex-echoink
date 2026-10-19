import { isPiTodoTool, normalizeTodoToolRequest } from "../harness/pi-native/todo-tool-policy";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import * as path from "node:path";
import type { DomainOperationJournal, FileDomainReceiptStore } from "../harness/pi-native/domain-receipt-store";
import type { FileConversationCatalog } from "../harness/pi-native/file-conversation-catalog";
import type { FileProductRunStore } from "../harness/pi-native/file-product-run-store";
import { inspectPiSessionJsonl } from "../harness/pi-native/pi-session-durability";
import type { PiPdfResumeOperation } from "../harness/pi-native/pi-pdf-reading-tools";
import { canonicalJsonStringify, type FileApprovalTicketStore, type JsonValue } from "../harness/pi-native/tool-authorization";
import { normalizeVaultRelativePath } from "../harness/pi-native/vault-target-resolver";

export interface TaskResumeOperation {
  readonly operationIdentity: string;
  readonly productRunId: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly arguments: JsonValue;
  readonly resolvedTarget: JsonValue;
  readonly status: "completed" | "uncertain" | "not_started" | "failed" | "cancelled";
  readonly label: string;
  readonly effectStarted: boolean;
  readonly recordedAt: number;
  readonly resourceId?: string;
  readonly externalToolName?: string;
}

export type TaskResumePendingAction = TaskResumeOperation;
export interface TaskResumeFileVersion {
  readonly relativePath: string;
  readonly expectedVersion: string | null;
  readonly recordedAt: number;
}
export interface TaskResumeFileConflict extends TaskResumeFileVersion {
  readonly observedVersion: string | null;
}
export interface TaskResumeSafetySnapshot {
  readonly conversationId: string;
  readonly piSessionId: string;
  readonly interruptedRunId: string;
  readonly interruptedUserEntryId: string;
  readonly originalUserEntryId: string;
  readonly taskRunIds: readonly string[];
  readonly preparedAt: number;
  readonly operations: readonly TaskResumeOperation[];
  readonly pendingActions: readonly TaskResumePendingAction[];
  readonly fileVersions: readonly TaskResumeFileVersion[];
  readonly fileConflicts: readonly TaskResumeFileConflict[];
  readonly pdfOperations: readonly PiPdfResumeOperation[];
  readonly recoveryInstructions: string;
}
export interface TaskResumeSafetyInput {
  readonly receipts: FileDomainReceiptStore;
  readonly approvals: FileApprovalTicketStore;
  readonly productRuns: FileProductRunStore;
  readonly catalog: FileConversationCatalog;
  readonly vaultRootPath: string;
  readonly conversationId: string;
  readonly interruptedRunId?: string;
  readonly now?: () => number;
}

/** No initialization, expiration, recovery, Provider, or external Tool calls. */
export async function readTaskResumeSafety(input: TaskResumeSafetyInput): Promise<TaskResumeSafetySnapshot> {
  const catalog = await input.catalog.get(input.conversationId);
  if (!catalog || catalog.status === "deleted") throw new Error("task_resume_conversation_unavailable");
  const runs = (await input.productRuns.listReadOnly(input.conversationId)).filter(run => run.piSessionId === catalog.piSessionId);
  const interrupted = input.interruptedRunId
    ? runs.find(run => run.productRunId === input.interruptedRunId)
    : runs.at(-1);
  if (!interrupted) throw new Error("task_resume_run_unavailable");
  const end = runs.indexOf(interrupted);
  let start = end;
  while (start > 0 && runs[start - 1].terminalState !== "completed") start -= 1;
  const taskRunIds = runs.slice(start, end + 1).map(run => run.productRunId);
  const ids = new Set(taskRunIds);
  const [views, tickets] = await Promise.all([
    input.receipts.listUiViews({ conversationId: input.conversationId }),
    input.approvals.listReadOnlyViews({ conversationId: input.conversationId })
  ]);
  const ticketByIdentity = new Map(tickets.map(state => [state.ticket.operationIdentity, state]));
  const operations: TaskResumeOperation[] = [];
  const files = new Map<string, TaskResumeFileVersion>();
  const beforeFiles = new Map<string, TaskResumeFileVersion>();
  for (const view of views) {
    if (!ids.has(view.productRunId) || view.piSessionId !== catalog.piSessionId) continue;
    const journal = await input.receipts.readOperation(view.operationIdentity);
    if (!journal) throw new Error("task_resume_operation_missing");
    const ticket = ticketByIdentity.get(view.operationIdentity)?.ticket;
    const status = view.receipt?.status ?? (view.effectState === "authorized" ? "not_started" : "uncertain");
    const operation = describeOperation(journal, ticket?.normalizedArguments ?? null, status);
    operations.push(operation);
    if (view.receipt?.status === "completed" && view.receipt.readback.readbackVerified) {
      for (const version of afterFileVersions(journal.toolId, journal.resolvedTarget, journal.targetVersion, effectTime(journal), view.receipt.readback.observedTargetVersion)) keepLatest(files, version);
    } else {
      for (const version of beforeFileVersions(journal.toolId, journal.resolvedTarget, journal.targetVersion, journal.authorizedAt)) keepEarliest(beforeFiles, version);
    }
  }
  const known = new Set(operations.map(operation => operation.operationIdentity));
  for (const state of tickets) {
    const ticket = state.ticket;
    if (!ids.has(ticket.productRunId) || ticket.piSessionId !== catalog.piSessionId || known.has(ticket.operationIdentity)) continue;
    if (state.status !== "pending" && state.status !== "approved") continue;
    const target = record(ticket.resolvedTarget);
    operations.push({
      operationIdentity: ticket.operationIdentity, productRunId: ticket.productRunId, toolCallId: ticket.toolCallId,
      toolName: ticket.toolId, arguments: ticket.normalizedArguments, resolvedTarget: ticket.resolvedTarget,
      status: "not_started", effectStarted: false, recordedAt: ticket.issuedAt,
      label: operationLabel(ticket.toolId, ticket.resolvedTarget),
      ...(typeof target?.resourceId === "string" ? { resourceId: target.resourceId } : {}),
      ...(typeof target?.toolName === "string" ? { externalToolName: target.toolName } : {})
    });
    for (const version of beforeFileVersions(ticket.toolId, ticket.resolvedTarget, ticket.targetVersion, ticket.issuedAt)) keepEarliest(beforeFiles, version);
  }
  // A failed/pending approval can have observed an outside edit. It cannot
  // replace the latest version successfully written by this task.
  for (const [relativePath, version] of beforeFiles) if (!files.has(relativePath)) files.set(relativePath, version);
  operations.sort((left, right) => left.recordedAt - right.recordedAt || left.operationIdentity.localeCompare(right.operationIdentity));
  const fileVersions = [...files.values()];
  const fileConflicts = await inspectFileConflicts(input.vaultRootPath, fileVersions);
  const pdfOperations = catalog.sessionFile ? readPdfOperations(input.catalog.sessionRootPath, catalog.sessionFile, catalog.piSessionId,
    catalog.conversationId, runs.slice(start, end + 1).map(run => run.userEntryId)) : [];
  return Object.freeze({
    conversationId: catalog.conversationId, piSessionId: catalog.piSessionId,
    interruptedRunId: interrupted.productRunId, interruptedUserEntryId: interrupted.userEntryId, originalUserEntryId: runs[start].userEntryId,
    taskRunIds: Object.freeze(taskRunIds), preparedAt: (input.now ?? Date.now)(),
    operations: Object.freeze(operations), pendingActions: Object.freeze(operations.filter(operation => operation.status === "not_started" || operation.status === "uncertain")),
    fileVersions: Object.freeze(fileVersions), fileConflicts: Object.freeze(fileConflicts),
    pdfOperations: Object.freeze(pdfOperations),
    recoveryInstructions: recoveryInstructions(operations, fileConflicts)
  });
}

/** Recovery records facts from local reads only; never dispatches the old effect. */
export async function prepareTaskResumeSafety(input: TaskResumeSafetyInput): Promise<TaskResumeSafetySnapshot> {
  const snapshot = await readTaskResumeSafety(input);
  for (const operation of snapshot.operations) {
    if (operation.status !== "uncertain" || !operation.effectStarted) continue;
    if (await input.receipts.readReceipt(operation.operationIdentity)) continue;
    await input.receipts.recoverMissingReceipt(operation.operationIdentity, async context => {
      const expected = afterFileVersions(context.toolId, context.resolvedTarget, context.targetVersion, 0);
      const verified = expected.length > 0 && (await inspectFileConflicts(input.vaultRootPath, expected)).length === 0
        && context.toolId !== "note_delete";
      return {
        status: verified ? "completed" : "uncertain",
        safeSummary: { reason: verified ? "task_resume_local_readback_verified" : "task_resume_effect_unknown_no_replay" },
        readback: { checkedAt: (input.now ?? Date.now)(), readbackVerified: verified,
          observedTargetVersion: verified ? context.targetVersion : null,
          safeSummary: { reason: "local_readback_only_no_effect_retry" } }
      };
    });
  }
  return await readTaskResumeSafety(input);
}

/** Called both at admission and immediately before the actual side effect. */
export async function assertTaskResumeToolAllowed(input: {
  readonly snapshot: TaskResumeSafetySnapshot | null | undefined;
  readonly receipts: FileDomainReceiptStore;
  readonly approvals: FileApprovalTicketStore;
  readonly vaultRootPath: string;
  readonly toolName: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly resolvedTarget?: unknown;
  readonly currentOperation?: Readonly<{ productRunId: string; toolCallId: string }>;
}): Promise<void> {
  const snapshot = input.snapshot;
  if (!snapshot) return;
  const views = await input.receipts.listUiViews({ conversationId: snapshot.conversationId });
  const tickets = await input.approvals.listReadOnlyViews({ conversationId: snapshot.conversationId });
  const ticketByIdentity = new Map(tickets.map(state => [state.ticket.operationIdentity, state.ticket]));
  const guarded = new Set(snapshot.taskRunIds);
  const operations = new Map(snapshot.operations.map(operation => [operation.operationIdentity, operation]));
  const files = new Map(snapshot.fileVersions.map(version => [version.relativePath, version]));
  const executingOperationIdentities = new Set<string>();
  for (const view of views) {
    if (view.piSessionId !== snapshot.piSessionId) continue;
    const journal = await input.receipts.readOperation(view.operationIdentity);
    if (!journal || !guarded.has(journal.productRunId) && journal.authorizedAt < snapshot.preparedAt) continue;
    if (input.currentOperation?.productRunId === journal.productRunId
      && input.currentOperation.toolCallId === journal.toolCallId
      && journal.effectState === "effect_started" && !view.receipt) executingOperationIdentities.add(journal.operationIdentity);
    const ticket = ticketByIdentity.get(view.operationIdentity);
    operations.set(view.operationIdentity, describeOperation(journal, ticket?.normalizedArguments ?? null,
      view.receipt?.status ?? (journal.effectState === "authorized" ? "not_started" : "uncertain")));
    // Only successful effects may advance the trusted file version. A newly
    // approved write must not bless an outside edit observed during approval.
    if (view.receipt?.status === "completed" && view.receipt.readback.readbackVerified) {
      for (const version of afterFileVersions(journal.toolId, journal.resolvedTarget, journal.targetVersion, effectTime(journal), view.receipt.readback.observedTargetVersion)) keepLatest(files, version);
    }
  }
  const semantic = semanticOperation(input.toolName, input.arguments, input.resolvedTarget);
  for (const operation of operations.values()) {
    // The broker's final check runs after beginExecution journals this call.
    // Exempt that exact live dispatch, while checking every other operation.
    if (executingOperationIdentities.has(operation.operationIdentity)) continue;
    if (!operation.effectStarted || operation.status !== "completed" && operation.status !== "uncertain") continue;
    if (operation.arguments === null && operation.toolName === input.toolName) {
      const oldPaths = affectedFilePaths(operation.toolName, {}, operation.resolvedTarget);
      const newPaths = affectedFilePaths(input.toolName, input.arguments, input.resolvedTarget);
      if (!oldPaths.length || oldPaths.some(oldPath => newPaths.includes(oldPath))) throw new Error("task_resume_effect_arguments_unverified_no_replay");
    }
    if (semantic === semanticOperation(operation.toolName, operation.arguments, operation.resolvedTarget)) {
      throw new Error(operation.status === "completed" ? "task_resume_effect_already_completed" : "task_resume_effect_uncertain_no_replay");
    }
  }
  const paths = affectedFilePaths(input.toolName, input.arguments, input.resolvedTarget);
  const relevantVersions = [...files.values()].filter(version => paths.includes(version.relativePath));
  if ((await inspectFileConflicts(input.vaultRootPath, relevantVersions)).length) throw new Error("task_resume_file_version_conflict");
}

function describeOperation(journal: Readonly<DomainOperationJournal>, args: JsonValue, status: TaskResumeOperation["status"]): TaskResumeOperation {
  const target = record(journal.resolvedTarget);
  return Object.freeze({
    operationIdentity: journal.operationIdentity, productRunId: journal.productRunId, toolCallId: journal.toolCallId,
    toolName: journal.toolId, arguments: args, resolvedTarget: journal.resolvedTarget, status,
    label: operationLabel(journal.toolId, journal.resolvedTarget), effectStarted: journal.effectState !== "authorized", recordedAt: effectTime(journal),
    ...(typeof target?.resourceId === "string" ? { resourceId: target.resourceId } : {}),
    ...(typeof target?.toolName === "string" ? { externalToolName: target.toolName } : {})
  });
}
function effectTime(journal: Readonly<DomainOperationJournal>): number {
  return journal.effectCompletedAt ?? journal.effectStartedAt ?? journal.authorizedAt;
}
function semanticOperation(toolName: string, args: unknown, target?: unknown): string {
  const value = record(args);
  if (!value) return `${toolName}:missing_arguments`;
  const normalized = isPiTodoTool(toolName) ? normalizeTodoToolRequest(toolName, value) : { ...value };
  if (toolName === "english_diary_generate" && typeof normalized.sourcePath === "string") {
    normalized.sourcePath = normalizeVaultRelativePath(normalized.sourcePath);
  }
  if (isFileTool(toolName)) {
    delete normalized.expectedVersion;
    for (const key of ["relativePath", "sourcePath", "targetPath"]) if (typeof normalized[key] === "string") normalized[key] = normalizeVaultRelativePath(normalized[key]);
  }
  if (toolName === "obsidian_cli") {
    for (const key of Object.keys(normalized)) if (["open", "newtab", "paneType"].includes(key) || normalized[key] === false) delete normalized[key];
    const resolved = record(target);
    const targetPath = resolved?.dailyPath ?? resolved?.path ?? normalized.path ?? normalized.file;
    delete normalized.file;
    if (typeof targetPath === "string") normalized.path = normalizeVaultRelativePath(targetPath);
  }
  if (isTodoWrite(toolName) || ["finance_record", "finance_budget", "finance_bill"].includes(toolName)) {
    // A fresh optimistic-lock version authorizes a current target; it does not
    // make the same financial mutation a new intent during task recovery.
    delete normalized.expectedVersion;
    if (Array.isArray(normalized.targets)) normalized.targets = normalized.targets.map(raw => {
      const target = { ...record(raw) };
      delete target.expectedVersion;
      return target;
    }).sort((left, right) => String(left.id).localeCompare(String(right.id)));
    const budgetScope = record(target)?.budgetScope;
    if (toolName === "finance_budget" && typeof budgetScope === "string") normalized.scope = budgetScope;
  }
  const operationKind = toolName === "note_create" || toolName === "note_update" ? "note_content_write" : toolName;
  return `${operationKind}:${canonicalJsonStringify(normalized)}`;
}
function isFileTool(name: string): boolean {
  return ["note_create", "note_update", "metadata_update", "note_move", "note_delete"].includes(name);
}
function isTodoWrite(name: string): boolean {
  return ["todo_add", "todo_update", "todo_complete"].includes(name);
}
function affectedFilePaths(toolName: string, args: unknown, target?: unknown): string[] {
  if (isTodoWrite(toolName)) return ["EchoInk/待办.md"];
  if (toolName === "english_diary_generate") {
    const input = record(args), resolved = record(target);
    return [resolved?.sourcePath ?? input?.sourcePath, resolved?.englishPath]
      .flatMap(raw => typeof raw === "string" ? [normalizeVaultRelativePath(raw)] : []);
  }
  if (toolName === "obsidian_cli") {
    const input = record(args), resolved = record(target);
    if (!isCliFileWrite(input?.command)) return [];
    return [resolved?.dailyPath ?? resolved?.path ?? input?.path ?? input?.file].flatMap(raw => typeof raw === "string" ? [normalizeVaultRelativePath(raw)] : []);
  }
  if (!isFileTool(toolName)) return [];
  const value = record(target) ?? record(args);
  return [value?.relativePath, value?.sourcePath, value?.targetPath].flatMap(raw => typeof raw === "string" ? [normalizeVaultRelativePath(raw)] : []);
}
function beforeFileVersions(tool: string, target: unknown, version: unknown, recordedAt: number): TaskResumeFileVersion[] {
  if (tool === "english_diary_generate") return englishDiaryFileVersions(target, version, recordedAt);
  if (isTodoWrite(tool)) {
    const item = fileVersion("EchoInk/待办.md", record(version)?.beforeVersion, recordedAt);
    return item ? [item] : [];
  }
  if (tool === "obsidian_cli") {
    const t = record(target), v = record(version);
    if (!isCliFileWrite(t?.command)) return [];
    const item = fileVersion(v?.recordPath ?? t?.dailyPath ?? t?.path, v?.recordPath ? null : v?.beforeVersion ?? v?.baseVersion ?? null, recordedAt);
    return item ? [item] : [];
  }
  if (!isFileTool(tool)) return [];
  const t = record(target), v = record(version);
  if (tool === "note_move") return [fileVersion(t?.sourcePath, v?.sourceBeforeVersion, recordedAt), fileVersion(t?.targetPath, v?.targetBeforeVersion, recordedAt)].flatMap(item => item ? [item] : []);
  const item = fileVersion(t?.relativePath, v?.beforeVersion, recordedAt);
  return item ? [item] : [];
}
function afterFileVersions(tool: string, target: unknown, version: unknown, recordedAt: number, observedVersion?: JsonValue): TaskResumeFileVersion[] {
  if (tool === "english_diary_generate") {
    // Approval only knows the before-version. Without a verified receipt the result remains unknown.
    return observedVersion === undefined ? [] : englishDiaryFileVersions(target, observedVersion, recordedAt);
  }
  if (isTodoWrite(tool)) {
    // No receipt means no known after-version: recovery must not guess success.
    const item = typeof observedVersion === "string" ? fileVersion("EchoInk/待办.md", observedVersion, recordedAt) : null;
    return item ? [item] : [];
  }
  if (tool === "obsidian_cli") {
    const t = record(target), observed = record(observedVersion);
    if (!isCliFileWrite(t?.command) || observedVersion === undefined) return [];
    const item = fileVersion(observed?.recordPath ?? observed?.path ?? t?.dailyPath ?? t?.path,
      typeof observedVersion === "string" ? observedVersion : observed?.version, recordedAt);
    return item ? [item] : [];
  }
  if (!isFileTool(tool)) return [];
  const t = record(target), v = record(version);
  if (tool === "note_move") return [fileVersion(t?.sourcePath, null, recordedAt), fileVersion(t?.targetPath, v?.expectedContentSha256, recordedAt)].flatMap(item => item ? [item] : []);
  const item = fileVersion(t?.relativePath, tool === "note_delete" ? null : v?.expectedAfterSha256, recordedAt);
  return item ? [item] : [];
}
function isCliFileWrite(command: unknown): boolean {
  return typeof command === "string" && ["daily", "daily:append", "daily:prepend", "history:restore", "base:create"].includes(command);
}
function fileVersion(rawPath: unknown, rawVersion: unknown, recordedAt: number): TaskResumeFileVersion | null {
  if (typeof rawPath !== "string" || rawVersion !== null && typeof rawVersion !== "string") return null;
  return { relativePath: normalizeVaultRelativePath(rawPath), expectedVersion: rawVersion, recordedAt };
}
function englishDiaryFileVersions(target: unknown, version: unknown, recordedAt: number): TaskResumeFileVersion[] {
  const t = record(target), v = record(version);
  const entries = [[t?.sourcePath, v?.sourceFingerprint], [t?.englishPath, v?.englishFingerprint]];
  return entries.flatMap(([relativePath, hash]) => {
    // EnglishDiary fingerprint() is a lowercase, unprefixed SHA-256; null means the file was absent.
    if (hash !== null && (typeof hash !== "string" || !/^[a-f0-9]{64}$/u.test(hash))) return [];
    const item = fileVersion(relativePath, hash, recordedAt);
    return item ? [item] : [];
  });
}
function keepLatest(files: Map<string, TaskResumeFileVersion>, version: TaskResumeFileVersion): void {
  if ((files.get(version.relativePath)?.recordedAt ?? -1) <= version.recordedAt) files.set(version.relativePath, version);
}
function keepEarliest(files: Map<string, TaskResumeFileVersion>, version: TaskResumeFileVersion): void {
  if ((files.get(version.relativePath)?.recordedAt ?? Infinity) > version.recordedAt) files.set(version.relativePath, version);
}
async function inspectFileConflicts(root: string, versions: readonly TaskResumeFileVersion[]): Promise<TaskResumeFileConflict[]> {
  const conflicts: TaskResumeFileConflict[] = [];
  for (const version of versions) {
    const observedVersion = await localFileVersion(root, version.relativePath);
    if (observedVersion !== version.expectedVersion) conflicts.push({ ...version, observedVersion });
  }
  return conflicts;
}
async function localFileVersion(root: string, relativePath: string): Promise<string | null> {
  const safePath = normalizeVaultRelativePath(relativePath);
  const rootPath = await realpath(root);
  let cursor = rootPath;
  try {
    for (const part of safePath.split("/")) {
      cursor = path.join(cursor, part);
      const stats = await lstat(cursor);
      if (stats.isSymbolicLink()) throw new Error("task_resume_unsafe_file_target");
    }
    const canonical = await realpath(cursor);
    if (!canonical.startsWith(`${rootPath}${path.sep}`)) throw new Error("task_resume_unsafe_file_target");
    return createHash("sha256").update(await readFile(canonical)).digest("hex");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}
function operationLabel(tool: string, target: JsonValue): string {
  const value = record(target);
  return [value?.resourceName, value?.toolName ?? tool, value?.relativePath ?? value?.sourcePath].filter(item => typeof item === "string").join(" · ");
}
function recoveryInstructions(operations: readonly TaskResumeOperation[], conflicts: readonly TaskResumeFileConflict[]): string {
  return [
    "Resume the interrupted task in the same session. These are product-owned recovery facts, not a request to execute prior actions.",
    "Completed actions must not be replayed. Unknown effects must be reported as unverified and must not be retried; unrelated continuation is allowed. Changed files must not be overwritten.",
    JSON.stringify({ operations: operations.map(operation => ({ operationIdentity: operation.operationIdentity, status: operation.status, label: operation.label, effectStarted: operation.effectStarted })), fileConflicts: conflicts })
  ].join("\n");
}
function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function readPdfOperations(sessionRoot: string, sessionFile: string, piSessionId: string, conversationId: string, userEntryIds: readonly string[]): PiPdfResumeOperation[] {
  const inspection = inspectPiSessionJsonl({ sessionRoot, sessionFile });
  if (!inspection.valid || inspection.header.id !== piSessionId) throw new Error("task_resume_session_unverified");
  const entries = new Map(inspection.entries.map(entry => [entry.id, entry]));
  const users = new Set(userEntryIds);
  const operations: PiPdfResumeOperation[] = [];
  for (const entry of inspection.entries) {
    if (entry.type !== "message" || entry.message.role !== "assistant") continue;
    let ancestor = entry.parentId ? entries.get(entry.parentId) : undefined;
    while (ancestor && !(ancestor.type === "message" && ancestor.message.role === "user")) ancestor = ancestor.parentId ? entries.get(ancestor.parentId) : undefined;
    if (!ancestor || !users.has(ancestor.id)) continue;
    for (const part of entry.message.content) {
      if (part.type !== "toolCall" || part.name !== "pdf_reading_process") continue;
      const args = record(part.arguments);
      if (!args) continue;
      const normalized = Object.fromEntries(Object.entries(args).sort(([left], [right]) => left.localeCompare(right)));
      // The first attempt used its own user entry; resumed attempts use the
      // interrupted chain's original intent. Check both durable identities.
      const jobIds = typeof args.jobId === "string" ? [args.jobId] : [...new Set([ancestor.id, userEntryIds[0]].map(userEntryId =>
        createHash("sha256").update(`${conversationId}:${userEntryId}\n${JSON.stringify(normalized)}`).digest("hex")))];
      for (const jobId of jobIds) operations.push({ toolCallId: part.id, userEntryId: ancestor.id, arguments: normalized, jobId });
    }
  }
  return operations;
}
