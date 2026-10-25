import { PERSONAL_MEMORY_SCHEMA, type PersonalMemoryRecord, type PersonalMemoryKind, type PersonalMemoryStatus, type PersonalMemoryBasis, type PersonalMemoryContentOrigin } from "./personal-memory-contracts";
import { sha256Hex } from "../../utils/sha256";
export interface CanonicalMemoryMetadata extends Omit<PersonalMemoryRecord, "content"> { contentHash?: string }
export interface CanonicalMemoryTombstone { recordId: string; forgottenAt: number; reason: string; backupFile: string; source: string }
export interface CanonicalMemoryManifest extends Record<string, unknown> {
  schemaVersion: 1; vaultId: string; revision: number; records: CanonicalMemoryMetadata[]; tombstones: CanonicalMemoryTombstone[]; updatedAt: number;
  fixedFileHashes?: { agent: string; user: string };
}
export class PersonalMemoryIdentityMismatchError extends Error {
  constructor(readonly expectedVaultId: string, readonly actualVaultId: string) {
    super("Personal Memory manifest belongs to another Vault");
    this.name = "PersonalMemoryIdentityMismatchError";
  }
}
export function parseCanonicalMemoryManifest(raw: string): CanonicalMemoryManifest {
  const value = JSON.parse(raw) as Partial<CanonicalMemoryManifest> | null;
  if (!value || value.schemaVersion !== 1 || typeof value.vaultId !== "string" || !value.vaultId
    || !Number.isSafeInteger(value.revision) || Number(value.revision) < 0 || !Array.isArray(value.records) || !Array.isArray(value.tombstones)
    || typeof value.updatedAt !== "number" || !Number.isFinite(value.updatedAt)
    || value.fixedFileHashes !== undefined && (!value.fixedFileHashes || !/^[a-f0-9]{64}$/u.test(value.fixedFileHashes.agent) || !/^[a-f0-9]{64}$/u.test(value.fixedFileHashes.user))
    || value.records.some(record => !record || typeof record.id !== "string" || typeof record.file !== "string"
      || !/^[a-zA-Z0-9_-]{3,96}$/u.test(record.id) || !/^shared-user\/memory\/(facts|views|decisions|active|episodes)\/[a-zA-Z0-9_-]{3,96}\.md$/u.test(record.file)
      || !["fact", "view", "decision", "goal", "task", "open_loop", "episode"].includes(record.kind)
      || !["current", "superseded", "closed"].includes(record.status) || !["explicit", "observed", "inferred"].includes(record.basis)
      || !Number.isSafeInteger(record.revision) || record.revision < 1 || typeof record.title !== "string" || typeof record.source !== "string" || typeof record.date !== "string"
      || record.contentHash !== undefined && !/^[a-f0-9]{64}$/u.test(record.contentHash))
    || new Set(value.records.map(record => record.id)).size !== value.records.length
    || value.tombstones.some(row => !row || typeof row.recordId !== "string" || typeof row.backupFile !== "string"
      || !row.backupFile.startsWith("shared-user/.runtime/backups/") || !Number.isFinite(row.forgottenAt) || typeof row.reason !== "string" || typeof row.source !== "string")) {
    throw new Error("Personal Memory manifest structure or schema is invalid");
  }
  return value as CanonicalMemoryManifest;
}
export const canonicalMemoryMetadata = (record: PersonalMemoryRecord): CanonicalMemoryMetadata => {
  const { content, ...metadata } = record; return { ...metadata, contentHash: sha256Hex(content) };
};
export function canonicalMemoryPath(kind: PersonalMemoryKind, id: string): string {
  const directory = kind === "fact" ? "facts" : kind === "view" ? "views" : kind === "decision" ? "decisions" : kind === "episode" ? "episodes" : "active";
  return `shared-user/memory/${directory}/${assertSafeId(id)}.md`;
}
export function canonicalSourceMap(manifest: CanonicalMemoryManifest) {
  const sources = new Map<string, string[]>();
  for (const record of manifest.records) sources.set(record.source, [...(sources.get(record.source) ?? []), record.id]);
  return { schemaVersion: 1, revision: manifest.revision, sources: Object.fromEntries([...sources].map(([source, ids]) => [source, ids.sort((a, b) => a.localeCompare(b))])) };
}
const MAX_RECORD_CONTENT_CHARS = 24_000;
const SAFE_ID = /^[a-zA-Z0-9_-]{3,96}$/u;
export class CanonicalMemoryFormatError extends Error { constructor(readonly code: "invalid_request", message: string) { super(message); } }
export function serializeCanonicalMemoryRecord(record: Readonly<PersonalMemoryRecord>, previousText?: string): string {
  const fields: Array<readonly [string, string | number | undefined]> = [
    ["schema", record.schema],
    ["id", record.id],
    ["kind", record.kind],
    ["status", record.status],
    ["date", record.date],
    ["source", record.source],
    ["basis", record.basis],
    ["content_origin", record.contentOrigin],
    ["title", record.title],
    ["recall_when", record.recallWhen],
    ["scope", record.scope],
    ["as_of", record.asOf],
    ["supersedes", record.supersedes],
    ["due", record.due],
    ["remind_at", record.remindAt],
    ["reason", record.reason],
    ["revision", record.revision]
  ];
  const keys = new Set(fields.map(([key]) => key));
  const previousLines = previousText?.split(/\r?\n/u) ?? [], end = previousLines.indexOf("---", 1);
  const unknownFields = previousLines[0] === "---" && end > 0 ? previousLines.slice(1, end).filter(line => { const separator = line.indexOf(":"); return separator > 0 && !keys.has(line.slice(0, separator).trim()); }) : [];
  return [
    "---",
    ...fields.filter(([, value]) => value !== undefined).map(([key, value]) => `${key}: ${JSON.stringify(value)}`),
    ...unknownFields,
    "---",
    "",
    record.content.trim(),
    ""
  ].join("\n");
}

export function parseCanonicalMemoryRecord(text: string, file: string): PersonalMemoryRecord {
  const lines = text.split(/\r?\n/u);
  if (lines[0] !== "---") throw new CanonicalMemoryFormatError("invalid_request", `Memory ${file} has no frontmatter`);
  const end = lines.indexOf("---", 1);
  if (end < 0) throw new CanonicalMemoryFormatError("invalid_request", `Memory ${file} frontmatter is incomplete`);
  const fields = new Map<string, unknown>();
  for (const line of lines.slice(1, end)) {
    const separator = line.indexOf(":");
    if (separator <= 0) throw new CanonicalMemoryFormatError("invalid_request", `Memory ${file} frontmatter line is invalid`);
    const key = line.slice(0, separator).trim();
    const raw = line.slice(separator + 1).trim();
    try {
      fields.set(key, JSON.parse(raw));
    } catch {
      throw new CanonicalMemoryFormatError("invalid_request", `Memory ${file} frontmatter value is invalid`);
    }
  }
  const kind = fields.get("kind");
  const status = fields.get("status");
  const basis = fields.get("basis");
  if (!isMemoryKind(kind) || !isMemoryStatus(status) || !isMemoryBasis(basis)) {
    throw new CanonicalMemoryFormatError("invalid_request", `Memory ${file} enum field is invalid`);
  }
  const content = lines.slice(end + 1).join("\n").trim();
  const revision = fields.get("revision");
  if (!Number.isSafeInteger(revision)) throw new CanonicalMemoryFormatError("invalid_request", `Memory ${file} revision is invalid`);
  const title = cleanRequired(requiredField(fields, "title"), "title", 200);
  return Object.freeze({
    schema: requiredField(fields, "schema") === PERSONAL_MEMORY_SCHEMA ? PERSONAL_MEMORY_SCHEMA : invalidField(file, "schema"),
    id: assertSafeId(requiredField(fields, "id")),
    kind,
    status,
    date: validateDate(requiredField(fields, "date"), "date"),
    source: cleanRequired(requiredField(fields, "source"), "source", 2_000),
    basis,
    ...(optionalField(fields, "content_origin") ? { contentOrigin: requireContentOrigin(optionalField(fields, "content_origin")!) } : {}),
    title,
    recallWhen: optionalField(fields, "recall_when")
      ? cleanRequired(optionalField(fields, "recall_when")!, "recall_when", 500)
      : title,
    content: cleanRequired(content, "content", MAX_RECORD_CONTENT_CHARS),
    ...(optionalField(fields, "scope") ? { scope: cleanRequired(optionalField(fields, "scope")!, "scope", 240) } : {}),
    ...(optionalField(fields, "as_of") ? { asOf: validateDate(optionalField(fields, "as_of")!, "as_of") } : {}),
    ...(optionalField(fields, "supersedes") ? { supersedes: assertSafeId(optionalField(fields, "supersedes")!) } : {}),
    ...(optionalField(fields, "due") ? { due: validateDateTime(optionalField(fields, "due")!, "due") } : {}),
    ...(optionalField(fields, "remind_at") ? { remindAt: validateDateTime(optionalField(fields, "remind_at")!, "remind_at") } : {}),
    ...(optionalField(fields, "reason") ? { reason: cleanRequired(optionalField(fields, "reason")!, "reason", 2_000) } : {}),
    revision: revision as number,
    file
  });
}

function cleanRequired(value: unknown, name: string, maxChars: number): string {
  if (typeof value !== "string") throw new CanonicalMemoryFormatError("invalid_request", `${name} must be text`);
  const clean = value.trim();
  if (!clean || clean.length > maxChars || hasDisallowedControlCharacters(clean)) {
    throw new CanonicalMemoryFormatError("invalid_request", `${name} is empty, too large, or contains control characters`);
  }
  return clean;
}

function assertSafeId(value: unknown): string {
  const id = cleanRequired(value, "id", 96);
  if (!SAFE_ID.test(id)) throw new CanonicalMemoryFormatError("invalid_request", "Memory id is unsafe");
  return id;
}

function validateDate(value: unknown, name: string): string {
  const date = cleanRequired(value, name, 32);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) {
    throw new CanonicalMemoryFormatError("invalid_request", `${name} must be YYYY-MM-DD`);
  }
  return date;
}

function validateDateTime(value: unknown, name: string): string {
  const dateTime = cleanRequired(value, name, 64);
  if (Number.isNaN(Date.parse(dateTime))) {
    throw new CanonicalMemoryFormatError("invalid_request", `${name} must be an ISO date-time`);
  }
  return dateTime;
}

function isMemoryKind(value: unknown): value is PersonalMemoryKind {
  return ["fact", "view", "decision", "goal", "task", "open_loop", "episode"].includes(String(value));
}

function isMemoryStatus(value: unknown): value is PersonalMemoryStatus {
  return ["current", "superseded", "closed"].includes(String(value));
}

function isMemoryBasis(value: unknown): value is PersonalMemoryBasis {
  return ["explicit", "observed", "inferred"].includes(String(value));
}

function requireContentOrigin(value: unknown): PersonalMemoryContentOrigin {
  const origin = cleanRequired(value, "content_origin", 64) as PersonalMemoryContentOrigin;
  if (!["user_statement", "user_edit", "confirmed_change", "current_instruction", "quotation", "code", "hypothesis", "knowledge", "tool_output"].includes(origin)) {
    throw new CanonicalMemoryFormatError("invalid_request", "content_origin is invalid");
  }
  return origin;
}

function requiredField(fields: ReadonlyMap<string, unknown>, key: string): string {
  return cleanRequired(fields.get(key), key, 2_000);
}

function optionalField(fields: ReadonlyMap<string, unknown>, key: string): string | undefined {
  const value = fields.get(key);
  return value === undefined ? undefined : cleanRequired(value, key, 2_000);
}

function invalidField(file: string, field: string): never {
  throw new CanonicalMemoryFormatError("invalid_request", `Memory ${file} ${field} is invalid`);
}

function hasDisallowedControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (
      code <= 0x08
      || code === 0x0b
      || code === 0x0c
      || (code >= 0x0e && code <= 0x1f)
      || code === 0x7f
    ) return true;
  }
  return false;
}

export const GENERATED_MEMORY_OVERVIEW_SENTINEL = "这是有上限的当前导航；完整内容按需通过 memory_search / memory_read 读取。";
export interface OverviewRecord { id:string;kind:string;status:string;title:string;date:string;basis:string; }
export function renderPersonalMemoryOverview(manifest: {revision:number}, records: readonly OverviewRecord[]): string {
  const current = records.filter((record) => record.status === "current");
  const groups: Array<readonly [string, readonly string[]]> = [
    ["Facts", ["fact"]],
    ["Views", ["view"]],
    ["Decisions", ["decision"]],
    ["Active", ["goal", "task", "open_loop"]],
    ["Episodes", ["episode"]]
  ];
  const lines = [
    "# Memory",
    "",
    `Revision: ${manifest.revision}`,
    "",
    GENERATED_MEMORY_OVERVIEW_SENTINEL,
    ""
  ];
  for (const [heading, kinds] of groups) {
    lines.push(`## ${heading}`, "");
    const matches = current
      .filter((record) => kinds.includes(record.kind))
      .sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id))
      .slice(0, 8);
    if (!matches.length) lines.push("- 暂无");
    else for (const record of matches) lines.push(`- ${record.title}（${record.date}，${record.basis}，${record.id}）`);
    lines.push("");
  }
  return `${lines.join("\n").slice(0, 20_000 - 1)}\n`;
}

export function renderCanonicalMemoryExport(records: readonly PersonalMemoryRecord[], revision: number): string {
  const lines = ["# EchoInk Memory Export", "", `Revision: ${revision}`, ""];
  for (const record of [...records].sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id))) {
    lines.push(`## ${record.title}`, "", `- ID: ${record.id}`, `- Kind: ${record.kind}`, `- Status: ${record.status}`, `- Basis: ${record.basis}`, `- Date: ${record.date}`, `- Source: ${record.source}`, "", record.content, "");
  }
  return `${lines.join("\n")}\n`;
}
