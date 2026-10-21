import type { KnowledgeMaintenanceRecord } from "../knowledge-base/maintenance-record";
import { knowledgeRolePath } from "../knowledge-base/root-paths-core";

const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown): value is string => typeof value === "string";
const strings = (value: unknown): value is string[] => Array.isArray(value) && (value as unknown[]).every(text);
const keys = (value: Record<string, unknown>, required: string[], optional: string[] = []): boolean => required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
const safe = (value: string): boolean => value.length > 0 && value.length <= 500 && !value.startsWith("/") && !value.includes("\\") && !value.split("/").includes("..");
const knowledge = (value: string): boolean => /^(?!\/)(?!.*(?:^|\/)\.)[^\\]+\.md$/u.test(value) && safe(value)
  && knowledgeRolePath(value) !== "raw/index.md" && !/^outputs\/(?:maintenance\/)?kb-.*\.md$/u.test(knowledgeRolePath(value));

/** Validate the persisted result DTO without importing the Node maintenance executor. */
export function validateKnowledgePageRecord(value: unknown, id: string): KnowledgeMaintenanceRecord {
  const record = object(value), result = object(record.result);
  const fail = (): never => { throw new Error("维护记录内容或版本无效，未将其计作已完成。"); };
  if (record.schemaVersion !== 1 || record.recordId !== id || !text(record.runId) || !Number.isFinite(record.at)
    || !text(record.date) || !text(record.summary) || record.cancelled !== undefined && typeof record.cancelled !== "boolean"
    || record.originConversationId !== undefined && (!text(record.originConversationId) || !record.originConversationId.trim() || /[\0\r\n]/u.test(record.originConversationId))
    || !Array.isArray(record.sources)) fail();
  for (const raw of record.sources as unknown[]) {
    const source = object(raw);
    if (!text(source.path) || !text(source.fingerprint) || !["processed", "unread", "failed"].some(status => source.status === status) || !strings(source.evidencePaths)) fail();
  }
  if (!keys(result, ["schema", "status", "notes", "issues", "systemPaths"], ["assessments", "linkingTaskId"])
    || result.schema !== "echoink.knowledge-maintenance-result.v1" || !["completed", "partial", "noop", "failed", "write_uncertain"].some(status => result.status === status)
    || !Array.isArray(result.notes) || !Array.isArray(result.issues) || !strings(result.systemPaths)
    || result.assessments !== undefined && !Array.isArray(result.assessments)
    || result.linkingTaskId !== undefined && (!text(result.linkingTaskId) || !/^[a-zA-Z0-9-]+$/u.test(result.linkingTaskId))) fail();
  const notePaths = new Set<string>();
  for (const raw of result.notes as unknown[]) {
    const note = object(raw);
    if (!keys(note, ["operation", "path", "title", "summary"]) || note.operation !== "created" && note.operation !== "updated"
      || !text(note.path) || !knowledge(note.path) || notePaths.has(note.path) || !text(note.title) || !note.title.trim() || !text(note.summary) || !note.summary.trim()) fail();
    notePaths.add(note.path as string);
  }
  for (const raw of result.issues as unknown[]) {
    const issue = object(raw);
    if (!keys(issue, ["code", "message"], ["path"]) || !text(issue.code) || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u.test(issue.code)
      || !text(issue.message) || !issue.message.trim() || issue.path !== undefined && (!text(issue.path) || !safe(issue.path))) fail();
  }
  for (const path of result.systemPaths as string[]) if (!safe(path) || /^(wiki|projects)\//u.test(knowledgeRolePath(path)) || notePaths.has(path)) fail();
  if (result.status === "completed" && !notePaths.size || result.status === "noop" && notePaths.size
    || result.status === "partial" && !notePaths.size && !(result.issues as unknown[]).length) fail();
  for (const raw of (result.assessments ?? []) as unknown[]) {
    const assessment = object(raw);
    if (!keys(assessment, ["claim", "status", "evidence", "asOf", "verification"]) || !text(assessment.claim) || !assessment.claim.trim()
      || !["valid", "needs_supplement", "outdated", "conflict"].some(status => assessment.status === status)
      || !strings(assessment.evidence) || assessment.evidence.length > 20 || assessment.evidence.some(item => !item.trim())
      || !text(assessment.asOf) || !assessment.asOf.trim() || !["local_verified", "external_verified", "unverified"].some(status => assessment.verification === status)) fail();
  }
  if (record.pendingLinking !== undefined) {
    const pending = object(record.pendingLinking);
    if (pending.taskId !== id || !strings(pending.sourcePaths) || !strings(pending.targetPaths)
      || [...pending.sourcePaths, ...pending.targetPaths].some(path => !notePaths.has(path))) fail();
  }
  return structuredClone(record) as unknown as KnowledgeMaintenanceRecord;
}
