import { createHash } from "node:crypto";

const MIGRATION_INVENTORY_SCHEMA_VERSION = 1 as const;
const MIGRATION_VALIDATION_SCHEMA_VERSION = 1 as const;
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const MAX_SUBJECTS = 200_000;
const MAX_OWNER_EDGES = 400_000;

export type RecordMigrationDomain = "conversation" | "history";

export type RecordMigrationSubjectKind =
  | "conversation"
  | "message"
  | "snapshot"
  | "deletion-tombstone"
  | "history-reference";

export type RecordMigrationOwnerKind =
  | "raw-owner"
  | "native-execution-owner"
  | "run-record-owner"
  | "settings-projection-owner"
  | "history-source";

export interface RecordMigrationSubject {
  kind: RecordMigrationSubjectKind;
  subjectRef: string;
  parentRef: string | null;
  ordinal: number;
  revision: string;
  contentDigest: string;
}

export interface RecordMigrationOwnerEdge {
  kind: RecordMigrationOwnerKind;
  ownerRef: string;
  resourceRef: string;
}

export interface RecordMigrationInventory {
  schemaVersion: typeof MIGRATION_INVENTORY_SCHEMA_VERSION;
  recordType: "record-migration-inventory";
  domain: RecordMigrationDomain;
  storeVersion: "v1" | "v2";
  subjects: RecordMigrationSubject[];
  ownerEdges: RecordMigrationOwnerEdge[];
  fingerprint: string;
}

export interface RecordMigrationInventoryInput {
  domain: RecordMigrationDomain;
  storeVersion: "v1" | "v2";
  subjects: readonly RecordMigrationSubject[];
  ownerEdges?: readonly RecordMigrationOwnerEdge[];
}

export type RecordMigrationValidationFindingCode =
  | "subject-missing-in-target"
  | "subject-unexpected-in-target"
  | "subject-kind-mismatch"
  | "subject-parent-mismatch"
  | "subject-order-mismatch"
  | "subject-revision-conflict"
  | "subject-content-conflict"
  | "owner-missing-in-target"
  | "owner-unexpected-in-target";

export interface RecordMigrationValidationFinding {
  code: RecordMigrationValidationFindingCode;
  subjectRef: string | null;
  ownerRef: string | null;
  resourceRef: string | null;
  sourceDigest: string | null;
  targetDigest: string | null;
  quarantined: boolean;
}

export interface RecordMigrationConflictQuarantine {
  schemaVersion: typeof MIGRATION_VALIDATION_SCHEMA_VERSION;
  recordType: "record-migration-conflict-quarantine";
  sourceFingerprint: string;
  targetFingerprint: string;
  subjectRefs: string[];
  findingCodes: RecordMigrationValidationFindingCode[];
  digest: string;
}

export interface RecordMigrationValidationReport {
  schemaVersion: typeof MIGRATION_VALIDATION_SCHEMA_VERSION;
  recordType: "record-migration-validation";
  domain: RecordMigrationDomain;
  status: "ready" | "blocked";
  sourceFingerprint: string;
  targetFingerprint: string;
  sourceSubjectCount: number;
  targetSubjectCount: number;
  sourceOwnerCount: number;
  targetOwnerCount: number;
  findings: RecordMigrationValidationFinding[];
  quarantine: RecordMigrationConflictQuarantine | null;
  digest: string;
}

const trustedProofs = new WeakSet<object>();

/**
 * Process-local proof returned only after the validator has compared the full
 * frozen subject and owner ledgers. It is intentionally not serializable as an
 * authorization capability. A restart must validate again before cutover.
 */
export interface RecordMigrationValidationProof {
  readonly report: RecordMigrationValidationReport & { status: "ready" };
}

export class RecordMigrationValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecordMigrationValidationError";
  }
}

export function opaqueMigrationRef(
  kind: string,
  ...identity: readonly string[]
): string {
  if (!kind.trim() || identity.some((value) => !value.trim())) {
    throw new RecordMigrationValidationError(
      "migration opaque ref identity is invalid"
    );
  }
  return `sha256:${createHash("sha256")
    .update(canonicalJson([kind, ...identity]), "utf8")
    .digest("hex")}`;
}

export function migrationContentDigest(value: unknown): string {
  return `sha256:${createHash("sha256")
    .update(canonicalJson(value), "utf8")
    .digest("hex")}`;
}

export function finalizeRecordMigrationInventory(
  input: RecordMigrationInventoryInput
): RecordMigrationInventory {
  if (input.domain !== "conversation" && input.domain !== "history") {
    throw new RecordMigrationValidationError("migration domain is invalid");
  }
  if (input.storeVersion !== "v1" && input.storeVersion !== "v2") {
    throw new RecordMigrationValidationError(
      "migration store version is invalid"
    );
  }
  if (input.subjects.length > MAX_SUBJECTS) {
    throw new RecordMigrationValidationError(
      "migration subject inventory exceeds the safety limit"
    );
  }
  if ((input.ownerEdges?.length ?? 0) > MAX_OWNER_EDGES) {
    throw new RecordMigrationValidationError(
      "migration owner inventory exceeds the safety limit"
    );
  }

  const subjects = input.subjects
    .map((subject) => validateSubject(subject))
    .sort(compareSubjects);
  const subjectRefs = new Set<string>();
  for (const subject of subjects) {
    if (subjectRefs.has(subject.subjectRef)) {
      throw new RecordMigrationValidationError(
        "migration subject inventory contains a duplicate subjectRef"
      );
    }
    subjectRefs.add(subject.subjectRef);
  }
  for (const subject of subjects) {
    if (subject.parentRef !== null && !subjectRefs.has(subject.parentRef)) {
      throw new RecordMigrationValidationError(
        "migration subject parentRef is not present in the same inventory"
      );
    }
  }

  const ownerEdges = (input.ownerEdges ?? [])
    .map((edge) => validateOwnerEdge(edge))
    .sort(compareOwnerEdges);
  const ownerKeys = new Set<string>();
  for (const edge of ownerEdges) {
    const key = ownerEdgeKey(edge);
    if (ownerKeys.has(key)) {
      throw new RecordMigrationValidationError(
        "migration owner inventory contains a duplicate edge"
      );
    }
    ownerKeys.add(key);
  }

  const withoutFingerprint = {
    schemaVersion: MIGRATION_INVENTORY_SCHEMA_VERSION,
    recordType: "record-migration-inventory" as const,
    domain: input.domain,
    storeVersion: input.storeVersion,
    subjects,
    ownerEdges
  };
  return {
    ...withoutFingerprint,
    fingerprint: migrationContentDigest(withoutFingerprint)
  };
}

export function validateRecordMigration(
  sourceInput: RecordMigrationInventory,
  targetInput: RecordMigrationInventory
): {
  report: RecordMigrationValidationReport;
  proof: RecordMigrationValidationProof | null;
} {
  const source = validateInventory(sourceInput);
  const target = validateInventory(targetInput);
  if (source.domain !== target.domain) {
    throw new RecordMigrationValidationError(
      "source and target migration domains do not match"
    );
  }
  if (source.storeVersion !== "v1" || target.storeVersion !== "v2") {
    throw new RecordMigrationValidationError(
      "migration validation requires a V1 source and V2 target"
    );
  }

  const findings: RecordMigrationValidationFinding[] = [];
  const sourceSubjects = new Map(
    source.subjects.map((subject) => [subject.subjectRef, subject] as const)
  );
  const targetSubjects = new Map(
    target.subjects.map((subject) => [subject.subjectRef, subject] as const)
  );

  for (const subject of source.subjects) {
    const candidate = targetSubjects.get(subject.subjectRef);
    if (!candidate) {
      findings.push(subjectFinding(
        "subject-missing-in-target",
        subject.subjectRef,
        subject.contentDigest,
        null
      ));
      continue;
    }
    compareSubject(subject, candidate, findings);
  }
  for (const subject of target.subjects) {
    if (sourceSubjects.has(subject.subjectRef)) continue;
    findings.push(subjectFinding(
      "subject-unexpected-in-target",
      subject.subjectRef,
      null,
      subject.contentDigest
    ));
  }

  const sourceOwners = new Map(
    source.ownerEdges.map((edge) => [ownerEdgeKey(edge), edge] as const)
  );
  const targetOwners = new Map(
    target.ownerEdges.map((edge) => [ownerEdgeKey(edge), edge] as const)
  );
  for (const [key, edge] of sourceOwners) {
    if (targetOwners.has(key)) continue;
    findings.push(ownerFinding("owner-missing-in-target", edge));
  }
  for (const [key, edge] of targetOwners) {
    if (sourceOwners.has(key)) continue;
    findings.push(ownerFinding("owner-unexpected-in-target", edge));
  }
  findings.sort(compareFindings);

  const quarantine = buildConflictQuarantine(
    source.fingerprint,
    target.fingerprint,
    findings
  );
  const withoutDigest = {
    schemaVersion: MIGRATION_VALIDATION_SCHEMA_VERSION,
    recordType: "record-migration-validation" as const,
    domain: source.domain,
    status: findings.length ? "blocked" as const : "ready" as const,
    sourceFingerprint: source.fingerprint,
    targetFingerprint: target.fingerprint,
    sourceSubjectCount: source.subjects.length,
    targetSubjectCount: target.subjects.length,
    sourceOwnerCount: source.ownerEdges.length,
    targetOwnerCount: target.ownerEdges.length,
    findings,
    quarantine
  };
  const report: RecordMigrationValidationReport = {
    ...withoutDigest,
    digest: migrationContentDigest(withoutDigest)
  };
  if (report.status === "blocked") return { report, proof: null };

  const readyReport = report as RecordMigrationValidationReport & {
    status: "ready";
  };
  const proof = Object.freeze({ report: readyReport });
  trustedProofs.add(proof);
  return { report, proof };
}

export function assertRecordMigrationValidationProof(
  proof: RecordMigrationValidationProof,
  expectation: {
    domain: RecordMigrationDomain;
    sourceFingerprint: string;
    targetFingerprint: string;
  }
): void {
  if (!trustedProofs.has(proof)) {
    throw new RecordMigrationValidationError(
      "migration validation proof is not trusted in this process"
    );
  }
  const report = proof.report;
  validateReport(report);
  if (
    report.status !== "ready"
    || report.domain !== expectation.domain
    || report.sourceFingerprint !== expectation.sourceFingerprint
    || report.targetFingerprint !== expectation.targetFingerprint
  ) {
    throw new RecordMigrationValidationError(
      "migration validation proof does not match the requested cutover"
    );
  }
}

export function validateRecordMigrationConflictQuarantine(
  value: RecordMigrationConflictQuarantine
): RecordMigrationConflictQuarantine {
  if (
    value.schemaVersion !== MIGRATION_VALIDATION_SCHEMA_VERSION
    || value.recordType !== "record-migration-conflict-quarantine"
  ) {
    throw new RecordMigrationValidationError(
      "migration conflict quarantine schema is invalid"
    );
  }
  requireDigest(value.sourceFingerprint, "quarantine sourceFingerprint");
  requireDigest(value.targetFingerprint, "quarantine targetFingerprint");
  const subjectRefs = [...value.subjectRefs];
  subjectRefs.forEach((ref) => requireDigest(ref, "quarantine subjectRef"));
  if (
    subjectRefs.length === 0
    || new Set(subjectRefs).size !== subjectRefs.length
    || subjectRefs.some((ref, index) =>
      index > 0 && subjectRefs[index - 1].localeCompare(ref) >= 0)
  ) {
    throw new RecordMigrationValidationError(
      "migration conflict quarantine subjectRefs are invalid"
    );
  }
  const findingCodes = [...value.findingCodes];
  if (
    findingCodes.length === 0
    || new Set(findingCodes).size !== findingCodes.length
    || findingCodes.some((code) =>
      code !== "subject-revision-conflict"
      && code !== "subject-content-conflict")
    || findingCodes.some((code, index) =>
      index > 0 && findingCodes[index - 1].localeCompare(code) >= 0)
  ) {
    throw new RecordMigrationValidationError(
      "migration conflict quarantine findingCodes are invalid"
    );
  }
  const { digest, ...withoutDigest } = value;
  requireDigest(digest, "quarantine digest");
  if (digest !== migrationContentDigest(withoutDigest)) {
    throw new RecordMigrationValidationError(
      "migration conflict quarantine digest does not match its contents"
    );
  }
  return {
    ...value,
    subjectRefs,
    findingCodes
  };
}

function compareSubject(
  source: RecordMigrationSubject,
  target: RecordMigrationSubject,
  findings: RecordMigrationValidationFinding[]
): void {
  if (source.kind !== target.kind) {
    findings.push(subjectFinding(
      "subject-kind-mismatch",
      source.subjectRef,
      source.contentDigest,
      target.contentDigest
    ));
  }
  if (source.parentRef !== target.parentRef) {
    findings.push(subjectFinding(
      "subject-parent-mismatch",
      source.subjectRef,
      source.parentRef,
      target.parentRef
    ));
  }
  if (source.ordinal !== target.ordinal) {
    findings.push(subjectFinding(
      "subject-order-mismatch",
      source.subjectRef,
      migrationContentDigest(source.ordinal),
      migrationContentDigest(target.ordinal)
    ));
  }
  if (source.revision !== target.revision) {
    findings.push(subjectFinding(
      "subject-revision-conflict",
      source.subjectRef,
      source.revision,
      target.revision
    ));
  }
  if (source.contentDigest !== target.contentDigest) {
    findings.push(subjectFinding(
      "subject-content-conflict",
      source.subjectRef,
      source.contentDigest,
      target.contentDigest
    ));
  }
}

function subjectFinding(
  code: RecordMigrationValidationFindingCode,
  subjectRef: string,
  sourceDigest: string | null,
  targetDigest: string | null
): RecordMigrationValidationFinding {
  return {
    code,
    subjectRef,
    ownerRef: null,
    resourceRef: null,
    sourceDigest,
    targetDigest,
    quarantined: code === "subject-revision-conflict"
      || code === "subject-content-conflict"
  };
}

function ownerFinding(
  code: "owner-missing-in-target" | "owner-unexpected-in-target",
  edge: RecordMigrationOwnerEdge
): RecordMigrationValidationFinding {
  return {
    code,
    subjectRef: null,
    ownerRef: edge.ownerRef,
    resourceRef: edge.resourceRef,
    sourceDigest: null,
    targetDigest: null,
    quarantined: false
  };
}

function buildConflictQuarantine(
  sourceFingerprint: string,
  targetFingerprint: string,
  findings: readonly RecordMigrationValidationFinding[]
): RecordMigrationConflictQuarantine | null {
  const conflicts = findings.filter((finding) => finding.quarantined);
  if (!conflicts.length) return null;
  const subjectRefs = [...new Set(
    conflicts.flatMap((finding) =>
      finding.subjectRef === null ? [] : [finding.subjectRef])
  )].sort();
  const findingCodes = [...new Set(conflicts.map((finding) => finding.code))]
    .sort();
  const withoutDigest = {
    schemaVersion: MIGRATION_VALIDATION_SCHEMA_VERSION,
    recordType: "record-migration-conflict-quarantine" as const,
    sourceFingerprint,
    targetFingerprint,
    subjectRefs,
    findingCodes
  };
  return {
    ...withoutDigest,
    digest: migrationContentDigest(withoutDigest)
  };
}

function validateInventory(
  input: RecordMigrationInventory
): RecordMigrationInventory {
  const rebuilt = finalizeRecordMigrationInventory(input);
  if (rebuilt.fingerprint !== input.fingerprint) {
    throw new RecordMigrationValidationError(
      "migration inventory fingerprint does not match its contents"
    );
  }
  return rebuilt;
}

function validateReport(report: RecordMigrationValidationReport): void {
  const { digest, ...withoutDigest } = report;
  if (digest !== migrationContentDigest(withoutDigest)) {
    throw new RecordMigrationValidationError(
      "migration validation report digest does not match its contents"
    );
  }
}

function validateSubject(
  value: RecordMigrationSubject
): RecordMigrationSubject {
  if (
    value.kind !== "conversation"
    && value.kind !== "message"
    && value.kind !== "snapshot"
    && value.kind !== "deletion-tombstone"
    && value.kind !== "history-reference"
  ) {
    throw new RecordMigrationValidationError(
      "migration subject kind is invalid"
    );
  }
  requireDigest(value.subjectRef, "migration subjectRef");
  if (value.parentRef !== null) {
    requireDigest(value.parentRef, "migration parentRef");
  }
  if (!Number.isSafeInteger(value.ordinal) || value.ordinal < 0) {
    throw new RecordMigrationValidationError(
      "migration subject ordinal is invalid"
    );
  }
  requireDigest(value.revision, "migration subject revision");
  requireDigest(value.contentDigest, "migration subject contentDigest");
  return { ...value };
}

function validateOwnerEdge(
  value: RecordMigrationOwnerEdge
): RecordMigrationOwnerEdge {
  if (
    value.kind !== "raw-owner"
    && value.kind !== "native-execution-owner"
    && value.kind !== "run-record-owner"
    && value.kind !== "settings-projection-owner"
    && value.kind !== "history-source"
  ) {
    throw new RecordMigrationValidationError(
      "migration owner edge kind is invalid"
    );
  }
  requireDigest(value.ownerRef, "migration ownerRef");
  requireDigest(value.resourceRef, "migration resourceRef");
  return { ...value };
}

function requireDigest(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new RecordMigrationValidationError(`${label} is invalid`);
  }
}

function compareSubjects(
  left: RecordMigrationSubject,
  right: RecordMigrationSubject
): number {
  return left.subjectRef.localeCompare(right.subjectRef)
    || left.kind.localeCompare(right.kind)
    || left.ordinal - right.ordinal;
}

function compareOwnerEdges(
  left: RecordMigrationOwnerEdge,
  right: RecordMigrationOwnerEdge
): number {
  return ownerEdgeKey(left).localeCompare(ownerEdgeKey(right));
}

function ownerEdgeKey(edge: RecordMigrationOwnerEdge): string {
  return `${edge.kind}\u0000${edge.ownerRef}\u0000${edge.resourceRef}`;
}

function compareFindings(
  left: RecordMigrationValidationFinding,
  right: RecordMigrationValidationFinding
): number {
  return left.code.localeCompare(right.code)
    || (left.subjectRef ?? "").localeCompare(right.subjectRef ?? "")
    || (left.ownerRef ?? "").localeCompare(right.ownerRef ?? "")
    || (left.resourceRef ?? "").localeCompare(right.resourceRef ?? "");
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  if (
    typeof value === "object"
    && value !== null
    && Object.getPrototypeOf(value) === Object.prototype
  ) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)])
    );
  }
  return value;
}
