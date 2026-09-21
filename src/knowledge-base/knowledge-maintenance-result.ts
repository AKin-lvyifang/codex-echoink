import { knowledgeRolePath, resolveKnowledgePath } from "./root-paths";
import { knowledgeErrorDetail } from "./initialization-error";
import type { KnowledgeBaseMaintainReportPayload } from "./maintain-report-card";

export const KNOWLEDGE_MAINTENANCE_RESULT_SCHEMA =
  "echoink.knowledge-maintenance-result.v1" as const;

export type KnowledgeMaintenanceResultStatus =
  | "completed"
  | "partial"
  | "noop"
  | "failed"
  | "write_uncertain";

export interface KnowledgeMaintenanceResultNote {
  operation: "created" | "updated";
  path: string;
  title: string;
  summary: string;
}

export interface KnowledgeMaintenanceResultIssue {
  code: string;
  message: string;
  path?: string;
}

export type KnowledgeMaintenanceAssessmentStatus =
  | "valid"
  | "needs_supplement"
  | "outdated"
  | "conflict";

export interface KnowledgeMaintenanceAssessment {
  claim: string;
  status: KnowledgeMaintenanceAssessmentStatus;
  evidence: readonly string[];
  asOf: string;
  verification: "local_verified" | "external_verified" | "unverified";
}

export interface KnowledgeMaintenanceResultEnvelope {
  schema: typeof KNOWLEDGE_MAINTENANCE_RESULT_SCHEMA;
  status: KnowledgeMaintenanceResultStatus;
  notes: readonly Readonly<KnowledgeMaintenanceResultNote>[];
  issues: readonly Readonly<KnowledgeMaintenanceResultIssue>[];
  systemPaths: readonly string[];
  assessments: readonly Readonly<KnowledgeMaintenanceAssessment>[];
}

export function knowledgeMaintenanceNoteFromReadback(input: Readonly<{
  operation: "created" | "updated";
  path: string;
  content: string;
}>): Readonly<KnowledgeMaintenanceResultNote> {
  const path = requireKnowledgePath(input.path);
  const fallback = titleFromPath(path);
  return Object.freeze({
    operation: input.operation,
    path,
    title: markdownTitle(input.content, fallback),
    summary: markdownSummary(input.content, fallback)
  });
}

export function createKnowledgeMaintenanceResultEnvelope(input: Readonly<{
  status: KnowledgeMaintenanceResultStatus;
  notes?: readonly Readonly<KnowledgeMaintenanceResultNote>[];
  issues?: readonly Readonly<KnowledgeMaintenanceResultIssue>[];
  systemPaths?: readonly string[];
  assessments?: readonly Readonly<KnowledgeMaintenanceAssessment>[];
}>): Readonly<KnowledgeMaintenanceResultEnvelope> {
  return parseKnowledgeMaintenanceResultEnvelope({
    schema: KNOWLEDGE_MAINTENANCE_RESULT_SCHEMA,
    status: input.status,
    notes: input.notes ?? [],
    issues: input.issues ?? [],
    systemPaths: input.systemPaths ?? [],
    assessments: input.assessments ?? []
  })!;
}

export function parseKnowledgeMaintenanceResultEnvelope(
  value: unknown
): Readonly<KnowledgeMaintenanceResultEnvelope> | null {
  if (!isRecord(value) || !exactKeys(value, [
    "schema", "status", "notes", "issues", "systemPaths"
  ], ["assessments"])) return null;
  if (value.schema !== KNOWLEDGE_MAINTENANCE_RESULT_SCHEMA) return null;
  if (!isStatus(value.status)) return null;
  if (!Array.isArray(value.notes) || !Array.isArray(value.issues)
    || !Array.isArray(value.systemPaths)
    || (value.assessments !== undefined && !Array.isArray(value.assessments))) return null;
  const notes: KnowledgeMaintenanceResultNote[] = [];
  for (const raw of value.notes) {
    if (!isRecord(raw) || !exactKeys(raw, ["operation", "path", "title", "summary"])) return null;
    if ((raw.operation !== "created" && raw.operation !== "updated")
      || typeof raw.path !== "string" || !isKnowledgePath(raw.path)
      || typeof raw.title !== "string" || !raw.title.trim()
      || typeof raw.summary !== "string" || !raw.summary.trim()) return null;
    notes.push(Object.freeze({
      operation: raw.operation,
      path: raw.path,
      title: raw.title.trim().slice(0, 200),
      summary: raw.summary.trim().replace(/\s+/g, " ").slice(0, 500)
    }));
  }
  if (new Set(notes.map((note) => note.path)).size !== notes.length) return null;
  const issues: KnowledgeMaintenanceResultIssue[] = [];
  for (const raw of value.issues) {
    if (!isRecord(raw) || !exactKeys(raw, ["code", "message"], ["path"])) return null;
    if (typeof raw.code !== "string" || !safeToken(raw.code)
      || typeof raw.message !== "string" || !raw.message.trim()
      || (raw.path !== undefined && (typeof raw.path !== "string" || !safePath(raw.path)))) return null;
    issues.push(Object.freeze({
      code: raw.code,
      message: knowledgeErrorDetail(raw.message.trim()),
      ...(typeof raw.path === "string" ? { path: raw.path } : {})
    }));
  }
  const systemPaths: string[] = [];
  for (const raw of value.systemPaths) {
    if (typeof raw !== "string" || !safePath(raw) || isKnowledgePath(raw)) return null;
    systemPaths.push(raw);
  }
  if ((value.status === "completed" || value.status === "partial") && notes.length === 0) return null;
  if (value.status === "noop" && notes.length !== 0) return null;
  const assessments: KnowledgeMaintenanceAssessment[] = [];
  for (const raw of value.assessments ?? []) {
    if (!isRecord(raw) || !exactKeys(raw, [
      "claim", "status", "evidence", "asOf", "verification"
    ])) return null;
    if (typeof raw.claim !== "string" || !raw.claim.trim()
      || !isAssessmentStatus(raw.status)
      || !Array.isArray(raw.evidence) || raw.evidence.length > 20
      || raw.evidence.some((item) => typeof item !== "string" || !item.trim())
      || typeof raw.asOf !== "string" || !raw.asOf.trim()
      || !["local_verified", "external_verified", "unverified"].includes(
        String(raw.verification)
      )) return null;
    assessments.push(Object.freeze({
      claim: raw.claim.trim().replace(/\s+/gu, " ").slice(0, 500),
      status: raw.status,
      evidence: Object.freeze((raw.evidence as string[]).map((item) =>
        item.trim().replace(/\s+/gu, " ").slice(0, 500)
      )),
      asOf: raw.asOf.trim().slice(0, 100),
      verification: raw.verification as KnowledgeMaintenanceAssessment["verification"]
    }));
  }
  return Object.freeze({
    schema: KNOWLEDGE_MAINTENANCE_RESULT_SCHEMA,
    status: value.status,
    notes: Object.freeze(notes),
    issues: Object.freeze(issues),
    systemPaths: Object.freeze([...new Set(systemPaths)]),
    assessments: Object.freeze(assessments)
  });
}

export function knowledgeMaintenanceEnvelopeFromToolResult(
  value: unknown
): Readonly<KnowledgeMaintenanceResultEnvelope> | null {
  const outer = isRecord(value) ? value : null;
  const details = isRecord(outer?.details) ? outer.details : outer;
  return parseKnowledgeMaintenanceResultEnvelope(details?.maintenanceResult);
}

export function knowledgeMaintenanceReportPayloadFromToolResult(
  value: unknown
): KnowledgeBaseMaintainReportPayload | null {
  const envelope = knowledgeMaintenanceEnvelopeFromToolResult(value);
  if (!envelope) return null;
  const success = envelope.status === "completed" || envelope.status === "noop";
  const noteItems = envelope.notes.map((note) => ({
    title: note.title,
    path: note.path,
    description: `${note.operation === "created" ? "新建" : "更新"} · ${note.summary}`,
    tone: "success" as const
  }));
  return {
    kind: "maintain-report",
    mode: "maintain",
    status: success ? "success" : "failed",
    completion: envelope.status === "partial"
      ? "partial"
      : envelope.status === "noop"
        ? "noop"
        : undefined,
    title: envelope.status === "completed"
      ? "知识维护完成"
      : envelope.status === "partial"
        ? "知识维护部分完成"
        : envelope.status === "noop"
          ? "没有需要提炼的知识"
          : envelope.status === "write_uncertain"
            ? "知识写入状态不确定"
            : "知识维护失败",
    reportPath: "",
    careItems: [
      ...(noteItems.length ? [{ tone: "success" as const, text: `已回读验证 ${noteItems.length} 篇知识笔记。` }] : []),
      ...envelope.issues.map((issue) => ({ tone: "warning" as const, text: issue.message }))
    ],
    sections: [
      {
        id: "knowledge-notes",
        title: "知识笔记",
        count: noteItems.length,
        emptyText: "没有生成新的知识笔记。",
        items: noteItems
      },
      ...(envelope.issues.length ? [{
        id: "issues",
        title: "需要关注",
        count: envelope.issues.length,
        emptyText: "没有需要关注的问题。",
        items: envelope.issues.map((issue) => ({
          title: issue.code,
          ...(issue.path ? { path: issue.path } : {}),
          description: issue.message,
          tone: "warning" as const
        }))
      }] : []),
      ...(envelope.assessments.length ? [{
        id: "assessments",
        title: "时效与冲突判断",
        count: envelope.assessments.length,
        emptyText: "没有需要判断的知识主张。",
        items: envelope.assessments.map((assessment) => ({
          title: assessment.claim,
          description: `${assessmentLabel(assessment.status)} · ${assessment.asOf} · ${assessment.verification}`,
          tone: assessment.status === "valid" ? "success" as const : "warning" as const
        }))
      }] : [])
    ]
  };
}

function markdownTitle(text: string, fallback: string): string {
  const body = stripFrontmatter(text);
  for (const line of body.split(/\r?\n/u)) {
    const match = /^#{1,3}\s+(.+)$/u.exec(line.trim());
    if (match?.[1]) return match[1].trim().replace(/\s+#*$/u, "") || fallback;
  }
  return fallback;
}

function markdownSummary(text: string, fallback: string): string {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(text)?.[1] ?? "";
  for (const key of ["summary", "摘要", "description", "描述"]) {
    const match = new RegExp(`^${key}\\s*:\\s*(.+)$`, "imu").exec(frontmatter);
    const value = match?.[1]?.trim().replace(/^["']|["']$/gu, "");
    if (value) return truncate(value, 160);
  }
  for (const raw of stripFrontmatter(text).split(/\r?\n/u)) {
    const line = raw.trim();
    if (!line || /^#{1,6}\s+/u.test(line) || /^\|/u.test(line)) continue;
    const clean = line.replace(/^[-*+]\s+/u, "").replace(/^>\s*/u, "").trim();
    if (clean && !/^<!--/u.test(clean)) return truncate(clean, 160);
  }
  return fallback;
}

function stripFrontmatter(text: string): string {
  return text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/u, "");
}

function truncate(value: string, max: number): string {
  const clean = value.replace(/\s+/gu, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1).trim()}…`;
}

function titleFromPath(path: string): string {
  return path.split("/").pop()!.replace(/\.md$/iu, "");
}

function requireKnowledgePath(value: string): string {
  if (!isKnowledgePath(value)) throw new TypeError("knowledge_maintenance_result_path_invalid");
  return value;
}

function isKnowledgePath(value: string): boolean {
  return /^(?:wiki|projects)\/(?!.*(?:^|\/)\.)[^\\]+\.md$/u.test(knowledgeRolePath(value))
    && safePath(value);
}

function safePath(value: string): boolean {
  return value.length > 0 && value.length <= 500 && !value.startsWith("/")
    && !value.includes("\\") && !value.split("/").includes("..");
}

function safeToken(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u.test(value);
}

function isStatus(value: unknown): value is KnowledgeMaintenanceResultStatus {
  return value === "completed" || value === "partial" || value === "noop"
    || value === "failed" || value === "write_uncertain";
}

function isAssessmentStatus(
  value: unknown
): value is KnowledgeMaintenanceAssessmentStatus {
  return value === "valid" || value === "needs_supplement"
    || value === "outdated" || value === "conflict";
}

function assessmentLabel(value: KnowledgeMaintenanceAssessmentStatus): string {
  if (value === "valid") return "仍有效";
  if (value === "needs_supplement") return "需补充";
  if (value === "outdated") return "已过时";
  return "存在冲突";
}

function exactKeys(
  value: Readonly<Record<string, unknown>>,
  required: readonly string[],
  optional: readonly string[] = []
): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.prototype.hasOwnProperty.call(value, key))
    && Object.keys(value).every((key) => allowed.has(key));
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
