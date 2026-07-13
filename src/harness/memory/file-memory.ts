import { createHash } from "node:crypto";
import { appendFile, copyFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import * as path from "node:path";
import type { ContextSection } from "../contracts/context";
import type { MemoryBundle, MemoryCandidate, MemoryCommitResult, MemoryItem, MemoryProvider, MemoryProposalRequest, MemoryRetrievalRequest } from "./provider";

export interface EchoInkMemoryLayout {
  root: string;
  current: string;
  spec: string;
  tasks: string;
  archive: string;
  index: string;
  events: string;
  exports: string;
  backups: string;
}

export interface InitializeEchoInkMemoryResult {
  layout: EchoInkMemoryLayout;
  created: string[];
  existing: string[];
}

export interface CodexMemoryMigrationMapping {
  kind: "current" | "spec" | "tasks" | "archive";
  source: string;
  target: string;
  exists: boolean;
}

export interface CodexMemoryMigrationPreview {
  sourceRoot: string;
  targetRoot: string;
  mappings: CodexMemoryMigrationMapping[];
  willDeleteSource: false;
  willRewriteAgentsMd: false;
}

export interface MemoryAuditEvent {
  eventId: string;
  type: "proposed" | "committed" | "superseded" | "deleted" | "expiration-set" | "expired" | "exported" | "backed-up";
  memoryId?: string;
  runId?: string;
  at: number;
  detail?: string;
}

export interface MemoryStoreSummary {
  active: StoredFileMemoryItem[];
  archived: StoredFileMemoryItem[];
  auditEventCount: number;
}

interface FileMemoryIndex {
  version: 1;
  memories: StoredFileMemoryItem[];
}

export type StoredFileMemoryItem = MemoryItem & {
  scope: string;
  evidenceRefs: string[];
  createdAt: number;
  supersededAt?: number;
  supersededReason?: string;
  deletedAt?: number;
  deletedReason?: string;
  expiredAt?: number;
};

export interface FileMemoryProviderOptions {
  vaultPath: string;
  now?: () => number;
}

export class FileMemoryProvider implements MemoryProvider {
  private readonly now: () => number;

  constructor(private readonly options: FileMemoryProviderOptions) {
    this.now = options.now ?? Date.now;
  }

  async retrieve(request: MemoryRetrievalRequest): Promise<MemoryBundle> {
    await this.purgeExpired();
    const index = await readMemoryIndex(this.options.vaultPath);
    const query = tokenize(request.query);
    const items = index.memories
      .filter((item) => isActiveMemory(item, this.now()))
      .map((item) => ({ item, score: scoreMemoryItem(item, query) }))
      .filter((entry) => entry.score > 0 || query.length === 0)
      .sort((left, right) => right.score - left.score || right.item.updatedAt - left.item.updatedAt)
      .slice(0, Math.max(0, request.maxItems))
      .map((entry) => entry.item);
    return {
      providerId: "file-memory",
      items,
      sections: items.map(memoryItemToSection)
    };
  }

  async propose(request: MemoryProposalRequest): Promise<MemoryCandidate[]> {
    await initializeEchoInkMemory({ vaultPath: this.options.vaultPath });
    const index = await readMemoryIndex(this.options.vaultPath);
    const active = index.memories.filter((item) => isActiveMemory(item, this.now()));
    const candidates = extractMemoryCandidates(request);
    for (const candidate of candidates) {
      const duplicate = active.find((item) => normalizeStatement(item.statement) === normalizeStatement(candidate.statement));
      if (duplicate) candidate.duplicateOf = duplicate.id;
      candidate.conflictsWith = active
        .filter((item) => item.kind === candidate.kind && memoryConflictKey(item.statement) === memoryConflictKey(candidate.statement))
        .filter((item) => normalizeStatement(item.statement) !== normalizeStatement(candidate.statement))
        .map((item) => item.id);
    }
    for (const candidate of candidates) {
      await appendAuditEvent(this.options.vaultPath, {
        eventId: auditId("proposed", candidate.id, this.now()),
        type: "proposed",
        memoryId: candidate.id,
        runId: request.runId,
        at: this.now(),
        detail: candidate.statement
      });
    }
    return candidates;
  }

  async commit(candidates: MemoryCandidate[]): Promise<MemoryCommitResult> {
    await initializeEchoInkMemory({ vaultPath: this.options.vaultPath });
    const index = await readMemoryIndex(this.options.vaultPath);
    const committed: string[] = [];
    const skipped: string[] = [];
    const pendingConfirmation: string[] = [];
    const conflicts: string[] = [];
    for (const candidate of candidates) {
      const id = candidate.id.trim();
      const statement = candidate.statement.trim();
      if (!id || !statement) {
        skipped.push(candidate.id);
        continue;
      }
      const active = index.memories.filter((item) => isActiveMemory(item, this.now()));
      const duplicate = active.find((item) => normalizeStatement(item.statement) === normalizeStatement(statement));
      if (duplicate) {
        skipped.push(id);
        continue;
      }
      const conflicting = active
        .filter((item) => item.kind === candidate.kind && memoryConflictKey(item.statement) === memoryConflictKey(statement))
        .filter((item) => normalizeStatement(item.statement) !== normalizeStatement(statement));
      const requiresConfirmation = candidate.requiresConfirmation ?? requiresConfirmationForKind(candidate.kind);
      if ((requiresConfirmation || conflicting.length > 0) && candidate.confirmed !== true) {
        pendingConfirmation.push(id);
        if (conflicting.length) conflicts.push(id);
        continue;
      }
      const now = this.now();
      for (const item of conflicting) {
        item.supersededAt = now;
        item.supersededReason = `Conflicted with confirmed memory ${id}`;
        await appendAuditEvent(this.options.vaultPath, {
          eventId: auditId("superseded", item.id, now),
          type: "superseded",
          memoryId: item.id,
          runId: candidate.sourceRunId,
          at: now,
          detail: item.supersededReason
        });
      }
      const existingIndex = index.memories.findIndex((item) => item.id === id);
      const existing = existingIndex >= 0 ? index.memories[existingIndex] : null;
      const item: StoredFileMemoryItem = {
        id,
        kind: candidate.kind,
        scope: candidate.scope?.trim() || "vault",
        statement,
        sourceRunId: candidate.sourceRunId,
        confidence: candidate.confidence,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        evidenceRefs: [...candidate.evidenceRefs]
      };
      if (existingIndex >= 0) index.memories[existingIndex] = item;
      else index.memories.push(item);
      committed.push(id);
      await appendAuditEvent(this.options.vaultPath, {
        eventId: auditId("committed", id, now),
        type: "committed",
        memoryId: id,
        runId: candidate.sourceRunId,
        at: now,
        detail: statement
      });
    }
    await writeMemoryState(this.options.vaultPath, index, this.now());
    return { committed, skipped, pendingConfirmation, conflicts };
  }

  async supersede(memoryId: string, reason: string): Promise<void> {
    const index = await readMemoryIndex(this.options.vaultPath);
    const item = index.memories.find((entry) => entry.id === memoryId);
    if (!item || !isActiveMemory(item, this.now())) return;
    const now = this.now();
    item.supersededAt = now;
    item.supersededReason = reason;
    await appendAuditEvent(this.options.vaultPath, {
      eventId: auditId("superseded", memoryId, now),
      type: "superseded",
      memoryId,
      at: now,
      detail: reason
    });
    await writeMemoryState(this.options.vaultPath, index, now);
  }

  async remove(memoryId: string, reason: string): Promise<boolean> {
    const index = await readMemoryIndex(this.options.vaultPath);
    const item = index.memories.find((entry) => entry.id === memoryId);
    if (!item || !isActiveMemory(item, this.now())) return false;
    const now = this.now();
    item.deletedAt = now;
    item.deletedReason = reason;
    await appendAuditEvent(this.options.vaultPath, {
      eventId: auditId("deleted", memoryId, now),
      type: "deleted",
      memoryId,
      at: now,
      detail: reason
    });
    await writeMemoryState(this.options.vaultPath, index, now);
    return true;
  }

  async expire(memoryId: string, expiresAt: number): Promise<boolean> {
    const index = await readMemoryIndex(this.options.vaultPath);
    const item = index.memories.find((entry) => entry.id === memoryId);
    if (!item || !isActiveMemory(item, this.now())) return false;
    item.expiresAt = expiresAt;
    item.updatedAt = this.now();
    await appendAuditEvent(this.options.vaultPath, {
      eventId: auditId("expiration-set", memoryId, this.now()),
      type: "expiration-set",
      memoryId,
      at: this.now(),
      detail: String(expiresAt)
    });
    await writeMemoryState(this.options.vaultPath, index, this.now());
    return true;
  }

  async purgeExpired(): Promise<string[]> {
    const index = await readMemoryIndex(this.options.vaultPath);
    const now = this.now();
    const expired = index.memories.filter((item) => !item.supersededAt && !item.deletedAt && !item.expiredAt && typeof item.expiresAt === "number" && item.expiresAt <= now);
    for (const item of expired) {
      item.expiredAt = now;
      await appendAuditEvent(this.options.vaultPath, {
        eventId: auditId("expired", item.id, now),
        type: "expired",
        memoryId: item.id,
        at: now
      });
    }
    if (expired.length) await writeMemoryState(this.options.vaultPath, index, now);
    return expired.map((item) => item.id);
  }

  async inspect(): Promise<MemoryStoreSummary> {
    await initializeEchoInkMemory({ vaultPath: this.options.vaultPath });
    await this.purgeExpired();
    const index = await readMemoryIndex(this.options.vaultPath);
    const events = await readMemoryAudit(this.options.vaultPath);
    return {
      active: index.memories.filter((item) => isActiveMemory(item, this.now())),
      archived: index.memories.filter((item) => !isActiveMemory(item, this.now())),
      auditEventCount: events.length
    };
  }

  async readAudit(): Promise<MemoryAuditEvent[]> {
    return await readMemoryAudit(this.options.vaultPath);
  }

  async export(): Promise<string> {
    await initializeEchoInkMemory({ vaultPath: this.options.vaultPath });
    const layout = echoInkMemoryLayout(this.options.vaultPath);
    const index = await readMemoryIndex(this.options.vaultPath);
    const events = await readMemoryAudit(this.options.vaultPath);
    const now = this.now();
    const output = path.join(layout.exports, `echoink-memory-${timestampTag(now)}.json`);
    await mkdir(layout.exports, { recursive: true });
    await writeFile(output, JSON.stringify({ version: 1, exportedAt: now, memories: index.memories, events }, null, 2), "utf8");
    await appendAuditEvent(this.options.vaultPath, {
      eventId: auditId("exported", "store", now),
      type: "exported",
      at: now,
      detail: output
    });
    return output;
  }

  async backup(): Promise<string> {
    await initializeEchoInkMemory({ vaultPath: this.options.vaultPath });
    const layout = echoInkMemoryLayout(this.options.vaultPath);
    const now = this.now();
    const target = path.join(layout.backups, timestampTag(now));
    await mkdir(target, { recursive: true });
    for (const file of [layout.current, layout.index, layout.events]) {
      if (await pathExists(file)) await copyFile(file, path.join(target, path.basename(file)));
    }
    for (const dir of [layout.spec, layout.tasks, layout.archive]) {
      if (await pathExists(dir)) await copyDirectory(dir, path.join(target, path.basename(dir)));
    }
    await appendAuditEvent(this.options.vaultPath, {
      eventId: auditId("backed-up", "store", now),
      type: "backed-up",
      at: now,
      detail: target
    });
    return target;
  }
}

export function echoInkMemoryLayout(vaultPath: string): EchoInkMemoryLayout {
  const root = path.join(vaultPath, ".echoink", "memory");
  return {
    root,
    current: path.join(root, "current.md"),
    spec: path.join(root, "spec"),
    tasks: path.join(root, "tasks"),
    archive: path.join(root, "archive"),
    index: path.join(root, "index.json"),
    events: path.join(root, "events.jsonl"),
    exports: path.join(root, "exports"),
    backups: path.join(root, "backups")
  };
}

export async function initializeEchoInkMemory(input: { vaultPath: string }): Promise<InitializeEchoInkMemoryResult> {
  const layout = echoInkMemoryLayout(input.vaultPath);
  const created: string[] = [];
  const existing: string[] = [];
  for (const dir of [layout.root, layout.spec, path.join(layout.tasks, "active"), path.join(layout.tasks, "archive"), layout.archive, layout.exports, layout.backups]) {
    await ensureDirectory(dir, created, existing);
  }
  await ensureFile(layout.current, "# Current\n\n", created, existing);
  await ensureFile(path.join(layout.spec, "index.md"), "# Spec\n\n", created, existing);
  await ensureFile(path.join(layout.tasks, "index.md"), "# Tasks\n\n", created, existing);
  await ensureFile(path.join(layout.archive, "index.md"), "# Archive\n\n", created, existing);
  await ensureFile(layout.index, JSON.stringify({ version: 1, memories: [] }, null, 2), created, existing);
  await ensureFile(layout.events, "", created, existing);
  return { layout, created, existing };
}

export async function buildCodexMemoryMigrationPreview(input: { vaultPath: string }): Promise<CodexMemoryMigrationPreview> {
  const sourceRoot = path.join(input.vaultPath, ".codex-memory");
  const targetRoot = echoInkMemoryLayout(input.vaultPath).root;
  const mappings: CodexMemoryMigrationMapping[] = [
    { kind: "current", source: path.join(sourceRoot, "current.md"), target: path.join(targetRoot, "current.md"), exists: await pathExists(path.join(sourceRoot, "current.md")) },
    { kind: "spec", source: path.join(sourceRoot, "spec"), target: path.join(targetRoot, "spec"), exists: await pathExists(path.join(sourceRoot, "spec")) },
    { kind: "tasks", source: path.join(sourceRoot, "tasks"), target: path.join(targetRoot, "tasks"), exists: await pathExists(path.join(sourceRoot, "tasks")) }
  ];
  if (await pathExists(path.join(sourceRoot, "archive"))) {
    mappings.push({
      kind: "archive",
      source: path.join(sourceRoot, "archive"),
      target: path.join(targetRoot, "archive", "legacy-codex-memory"),
      exists: true
    });
  }
  return {
    sourceRoot,
    targetRoot,
    mappings: mappings.filter((mapping) => mapping.exists),
    willDeleteSource: false,
    willRewriteAgentsMd: false
  };
}

function extractMemoryCandidates(request: MemoryProposalRequest): MemoryCandidate[] {
  const patterns: Array<{ kind: MemoryItem["kind"]; regex: RegExp }> = [
    { kind: "preference", regex: /^(?:用户)?偏好[:：]\s*(.+)$/i },
    { kind: "decision", regex: /^(?:决定|决策)[:：]\s*(.+)$/i },
    { kind: "constraint", regex: /^(?:约束|限制)[:：]\s*(.+)$/i },
    { kind: "open-loop", regex: /^(?:待办|下一步|未完成)[:：]\s*(.+)$/i },
    { kind: "task-state", regex: /^(?:任务状态|进度)[:：]\s*(.+)$/i },
    { kind: "workflow-rule", regex: /^(?:工作流规则|规则)[:：]\s*(.+)$/i },
    { kind: "lesson", regex: /^(?:经验|教训)[:：]\s*(.+)$/i },
    { kind: "current-state", regex: /^(?:请)?记住[:：]?\s*(.+)$/i },
    { kind: "current-state", regex: /^当前状态[:：]\s*(.+)$/i }
  ];
  const candidates: MemoryCandidate[] = [];
  const seen = new Set<string>();
  for (const line of request.transcript.split(/\r?\n/)) {
    const compact = memoryTranscriptLineContent(line);
    if (!compact) continue;
    for (const pattern of patterns) {
      const match = compact.match(pattern.regex);
      const statement = cleanMemoryCandidateStatement(match?.[1] ?? "");
      if (!isUsefulMemoryCandidateStatement(statement, pattern.kind)) continue;
      const normalized = normalizeStatement(statement);
      if (seen.has(`${pattern.kind}:${normalized}`)) break;
      seen.add(`${pattern.kind}:${normalized}`);
      candidates.push({
        id: memoryCandidateId("vault", pattern.kind, statement),
        kind: pattern.kind,
        scope: "vault",
        statement,
        evidenceRefs: [`run:${request.runId}`, `session:${request.sessionId}`],
        sourceRunId: request.runId,
        confidence: pattern.kind === "current-state" ? 0.8 : 0.9,
        requiresConfirmation: requiresConfirmationForKind(pattern.kind)
      });
      break;
    }
  }
  return candidates;
}

function memoryTranscriptLineContent(line: string): string {
  let compact = line.replace(/\s+/g, " ").trim();
  compact = compact.replace(/^(?:[-*+]\s+|\d+[.)、]\s*)/, "");
  compact = compact.replace(/^(?:user|assistant|system|tool|用户|助手|系统|工具)\s*[:：]\s*/i, "");
  return compact.replace(/^(?:[-*+]\s+|\d+[.)、]\s*)/, "").trim();
}

function cleanMemoryCandidateStatement(value: string): string {
  return value
    .trim()
    .replace(/[。.!！？；;,，]\s*(?:请)?只(?:需|要)?回复[:：].*$/i, "")
    .replace(/^[`*_"'“”‘’]+|[`*_"'“”‘’]+$/g, "")
    .replace(/[。.!]+$/, "")
    .trim();
}

function isUsefulMemoryCandidateStatement(statement: string, kind: MemoryItem["kind"]): boolean {
  if (statement.length < 3) return false;
  if (/^(?:的|了|和|与|及|并|以及|但|而|或|就是)/.test(statement)) return false;
  if (/<[^<>]{1,120}>|\{[^{}]{1,120}\}|\[[^\[\]]{1,120}\]/.test(statement)) return false;
  if (/^(?:待补充|待确认|待定|暂无|无|未知|未定|n\/?a|none|todo|tbd|placeholder|x{2,})$/i.test(statement)) return false;
  if (kind === "constraint" && isBareConstraintEnumeration(statement)) return false;
  return true;
}

function isBareConstraintEnumeration(statement: string): boolean {
  const parts = statement.split(/[、,，]/).map((part) => part.trim()).filter(Boolean);
  if (parts.length < 2) return false;
  if (/[\d:=<>≤≥]|(?:只|不|低|高|少|多|快|慢|短|长|内|外|前|后|必须|禁止|不得|需要|应该|至少|最多|以内|以外)/.test(statement)) return false;
  return parts.every((part) => /^[\p{L}\s-]{1,12}$/u.test(part));
}

async function readMemoryIndex(vaultPath: string): Promise<FileMemoryIndex> {
  const layout = echoInkMemoryLayout(vaultPath);
  if (!await pathExists(layout.index)) return { version: 1, memories: [] };
  const parsed = JSON.parse(await readFile(layout.index, "utf8")) as Partial<FileMemoryIndex>;
  return {
    version: 1,
    memories: Array.isArray(parsed.memories) ? parsed.memories.filter(isStoredFileMemoryItem).map(normalizeStoredItem) : []
  };
}

async function writeMemoryState(vaultPath: string, index: FileMemoryIndex, now: number): Promise<void> {
  const layout = echoInkMemoryLayout(vaultPath);
  await mkdir(path.dirname(layout.index), { recursive: true });
  await writeFile(layout.index, JSON.stringify(index, null, 2), "utf8");
  await writeMemoryProjections(layout, index.memories, now);
}

async function writeMemoryProjections(layout: EchoInkMemoryLayout, items: StoredFileMemoryItem[], now: number): Promise<void> {
  const active = items.filter((item) => isActiveMemory(item, now));
  const current = active.filter((item) => ["current-state", "open-loop"].includes(item.kind));
  const spec = active.filter((item) => ["preference", "decision", "constraint", "workflow-rule", "lesson"].includes(item.kind));
  const tasks = active.filter((item) => item.kind === "task-state");
  const archived = items.filter((item) => !isActiveMemory(item, now));
  await writeFile(layout.current, renderMemoryMarkdown("Current", current), "utf8");
  await writeFile(path.join(layout.spec, "index.md"), renderMemoryMarkdown("Spec", spec), "utf8");
  await writeFile(path.join(layout.tasks, "index.md"), renderMemoryMarkdown("Tasks", tasks), "utf8");
  await writeFile(path.join(layout.archive, "index.md"), renderMemoryMarkdown("Archive", archived), "utf8");
}

function renderMemoryMarkdown(title: string, items: StoredFileMemoryItem[]): string {
  const lines = [`# ${title}`, ""];
  if (!items.length) return `${lines.join("\n")}\n`;
  for (const item of items) {
    lines.push(`## ${item.id}`, "", item.statement, "", `- Kind: ${item.kind}`, `- Scope: ${item.scope}`, `- Source run: ${item.sourceRunId || "unknown"}`, `- Confidence: ${item.confidence}`);
    if (item.evidenceRefs.length) lines.push(`- Evidence: ${item.evidenceRefs.join(", ")}`);
    if (item.expiresAt) lines.push(`- Expires at: ${new Date(item.expiresAt).toISOString()}`);
    if (item.supersededAt) lines.push(`- Superseded: ${item.supersededReason || "yes"}`);
    if (item.deletedAt) lines.push(`- Deleted: ${item.deletedReason || "yes"}`);
    if (item.expiredAt) lines.push("- Expired: yes");
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

async function appendAuditEvent(vaultPath: string, event: MemoryAuditEvent): Promise<void> {
  const layout = echoInkMemoryLayout(vaultPath);
  await mkdir(path.dirname(layout.events), { recursive: true });
  await appendFile(layout.events, `${JSON.stringify(event)}\n`, "utf8");
}

async function readMemoryAudit(vaultPath: string): Promise<MemoryAuditEvent[]> {
  const file = echoInkMemoryLayout(vaultPath).events;
  if (!await pathExists(file)) return [];
  const events: MemoryAuditEvent[] = [];
  for (const line of (await readFile(file, "utf8")).split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as MemoryAuditEvent;
      if (typeof event.eventId === "string" && typeof event.type === "string" && typeof event.at === "number") events.push(event);
    } catch {
      // Ignore a partial final audit line; later writes remain readable.
    }
  }
  return events;
}

function memoryItemToSection(item: MemoryItem): ContextSection {
  return {
    id: `memory:${item.id}`,
    priority: 500,
    channel: "memory",
    content: item.statement,
    source: "echoink-memory",
    required: false,
    sensitive: false
  };
}

function scoreMemoryItem(item: MemoryItem, queryTokens: string[]): number {
  if (!queryTokens.length) return item.confidence;
  const text = item.statement.toLowerCase();
  let score = 0;
  for (const token of queryTokens) {
    if (text.includes(token)) score += 1;
  }
  return score + item.confidence / 10;
}

function requiresConfirmationForKind(kind: MemoryItem["kind"]): boolean {
  return ["preference", "decision", "constraint", "workflow-rule", "lesson"].includes(kind);
}

function memoryCandidateId(scope: string, kind: MemoryItem["kind"], statement: string): string {
  const hash = createHash("sha256").update(`${scope}\0${kind}\0${normalizeStatement(statement)}`).digest("hex").slice(0, 16);
  return `memory-${hash}`;
}

function normalizeStatement(statement: string): string {
  return statement.toLowerCase().replace(/\s+/g, " ").replace(/[。.!]+$/, "").trim();
}

function memoryConflictKey(statement: string): string {
  const normalized = normalizeStatement(statement).replace(/^(?:用户)?(?:偏好|决定|约束|规则)\s*/, "");
  const [key] = normalized.split(/[:：=]|\s(?:是|为)\s/);
  return (key || normalized).slice(0, 80).trim();
}

function tokenize(text: string): string[] {
  return text.toLowerCase().split(/[\s,.;:!?，。；：！？、/\\()[\]{}"'`]+/).map((item) => item.trim()).filter(Boolean);
}

function isActiveMemory(item: StoredFileMemoryItem, now: number): boolean {
  return !item.supersededAt && !item.deletedAt && !item.expiredAt && !(typeof item.expiresAt === "number" && item.expiresAt <= now);
}

function normalizeStoredItem(item: StoredFileMemoryItem): StoredFileMemoryItem {
  return {
    ...item,
    scope: item.scope || "vault",
    evidenceRefs: Array.isArray(item.evidenceRefs) ? item.evidenceRefs : [],
    createdAt: typeof item.createdAt === "number" ? item.createdAt : item.updatedAt
  };
}

function isStoredFileMemoryItem(value: unknown): value is StoredFileMemoryItem {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<StoredFileMemoryItem>;
  return (
    typeof item.id === "string" &&
    typeof item.statement === "string" &&
    typeof item.kind === "string" &&
    typeof item.confidence === "number" &&
    typeof item.updatedAt === "number"
  );
}

function auditId(type: string, memoryId: string, at: number): string {
  return `${type}:${memoryId}:${at}`;
}

function timestampTag(at: number): string {
  return new Date(at).toISOString().replace(/[:.]/g, "-");
}

async function copyDirectory(source: string, target: string): Promise<void> {
  await mkdir(target, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (entry.isDirectory()) await copyDirectory(from, to);
    else if (entry.isFile()) await copyFile(from, to);
  }
}

async function ensureDirectory(dir: string, created: string[], existing: string[]): Promise<void> {
  if (await pathExists(dir)) {
    existing.push(dir);
    return;
  }
  await mkdir(dir, { recursive: true });
  created.push(dir);
}

async function ensureFile(filePath: string, content: string, created: string[], existing: string[]): Promise<void> {
  if (await pathExists(filePath)) {
    existing.push(filePath);
    return;
  }
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
  created.push(filePath);
}

async function pathExists(filePath: string): Promise<boolean> {
  return stat(filePath).then(() => true, () => false);
}
