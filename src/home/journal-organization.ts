import { journalPathForFormat, parseJournalDate, safeJournalPath } from "./journal-format";

export type JournalKeepReason = "duplicate" | "occupied" | "parent" | "unknown" | "changed" | "missing" | "edited" | "links" | "failed";
export interface JournalFileSnapshot { path: string; version: string; ordinary?: boolean; journalHint?: boolean }
export interface JournalMove { from: string; to: string; date: string; version: string; ai?: boolean; evidence?: string }
export interface JournalKeep { from: string; to?: string; reason: JournalKeepReason }
export interface JournalPlan {
  folder: string; format: string; history: string[]; signature: string;
  files: JournalFileSnapshot[]; occupied: string[]; directories?: string[]; moves: JournalMove[]; unknown: JournalFileSnapshot[]; keep: JournalKeep[];
}
const key = (path: string) => path.normalize("NFC").toLocaleLowerCase();
export function buildJournalPlan(input: { folder: string; format: string; history?: readonly string[]; signature: string; files: JournalFileSnapshot[]; occupied?: string[]; directories?: string[] }, dates: ReadonlyMap<string, { date: string; evidence: string }> = new Map(), rejected: ReadonlySet<string> = new Set()): JournalPlan {
  const plan: JournalPlan = { ...input, history: [...input.history ?? []], occupied: input.occupied ?? input.files.map(file => file.path), moves: [], unknown: [], keep: [] };
  const occupied = new Set(plan.occupied.map(key)), targets = new Set([...plan.occupied, ...input.directories ?? []].map(key)), groups = new Map<string, JournalMove[]>();
  for (const file of input.files) {
    if (file.ordinary || !safeJournalPath(file.path) || !/\.md$/iu.test(file.path) || input.folder && !file.path.startsWith(`${input.folder}/`)) continue;
    const parsed = parseJournalDate(file.path, input.folder, input.format, input.history), inferred = dates.get(file.path);
    if (!parsed && !inferred) {
      // Root journals never authorize scanning every ordinary Markdown file.
      if (rejected.has(file.path)) plan.keep.push({ from: file.path, reason: "unknown" });
      else if (input.folder || file.journalHint) plan.unknown.push(file);
      continue;
    }
    const date = parsed ?? inferred!.date;
    let to: string;
    try { to = journalPathForFormat(date, input.folder, input.format); }
    catch { plan.keep.push({ from: file.path, reason: "unknown" }); continue; }
    const group = groups.get(key(to)) ?? [];
    group.push({ from: file.path, to, date, version: file.version, ...(!parsed ? { ai: true, evidence: inferred!.evidence } : {}) }); groups.set(key(to), group);
  }
  for (const group of groups.values()) for (const move of group) {
    if (move.from === move.to) continue;
    const parts = move.to.split("/");
    const parent = parts.slice(0, -1).some((_, index) => occupied.has(key(parts.slice(0, index + 1).join("/"))));
    const reason = targets.has(key(move.to)) ? "occupied" : group.length > 1 ? "duplicate" : parent ? "parent" : null;
    if (reason) plan.keep.push({ from: move.from, to: move.to, reason }); else plan.moves.push(move);
  }
  plan.moves.sort((a, b) => a.from.localeCompare(b.from)); plan.unknown.sort((a, b) => a.path.localeCompare(b.path));
  return plan;
}

export interface JournalMoveRecord extends JournalMove { state: "prepared" | "moved" | "restoring" | "restored" | "skipped"; beforeHash: string; afterHash?: string; reason?: JournalKeepReason }
export interface JournalOrganizationRecord {
  schema: 1; id: string; folder: string; format: string; signature: string; status: "running" | "interrupted" | "done" | "undone";
  entries: JournalMoveRecord[]; keep: JournalKeep[];
}
export function parseJournalOrganizationRecord(raw: string): JournalOrganizationRecord {
  const value = JSON.parse(raw) as JournalOrganizationRecord;
  if (value?.schema !== 1 || typeof value.id !== "string" || typeof value.folder !== "string" || typeof value.format !== "string" || typeof value.signature !== "string"
    || !["running", "interrupted", "done", "undone"].includes(value.status) || !Array.isArray(value.entries) || !Array.isArray(value.keep)) throw new Error("journal_record_invalid");
  for (const entry of value.entries) {
    if (!safeJournalPath(entry.from) || !safeJournalPath(entry.to) || !["prepared", "moved", "restoring", "restored", "skipped"].includes(entry.state)
      || !/^[a-f0-9]{64}$/u.test(entry.beforeHash) || entry.afterHash !== undefined && !/^[a-f0-9]{64}$/u.test(entry.afterHash)) throw new Error("journal_record_invalid");
  }
  for (const item of value.keep) if (!safeJournalPath(item.from) || typeof item.reason !== "string") throw new Error("journal_record_invalid");
  return value;
}
