import { createHash } from "node:crypto";

export const STORAGE_INVENTORY_SCHEMA_VERSION = 1 as const;

export const STORAGE_INVENTORY_LOCAL_SOURCE_IDS = Object.freeze([
  "data-json",
  "conversations",
  "history",
  "harness-runs",
  "native-store",
  "raw"
] as const);

export const STORAGE_INVENTORY_PROVIDER_IDS = Object.freeze([
  "codex",
  "opencode",
  "hermes"
] as const);

export const STORAGE_INVENTORY_CONTENT_POLICY = Object.freeze({
  mode: "metadata-only",
  rawBodies: "excluded",
  conversationBodies: "excluded",
  runPayloads: "excluded",
  providerPayloads: "excluded",
  sensitiveValues: "excluded",
  absolutePaths: "excluded",
  identifiers: "opaque-sha256"
} as const);

export const STORAGE_INVENTORY_SAFETY_RECEIPT = Object.freeze({
  readOnly: true,
  actionsApplied: 0,
  deletionsApplied: 0,
  writesOutsideOutputDir: 0,
  rawBodiesRead: false
} as const);

export type StorageInventoryLocalSourceId =
  typeof STORAGE_INVENTORY_LOCAL_SOURCE_IDS[number];

export type StorageInventoryProviderId =
  typeof STORAGE_INVENTORY_PROVIDER_IDS[number];

export type StorageInventorySourceStatus =
  | "scanned"
  | "partial"
  | "unsupported"
  | "unavailable"
  | "error";

export type StorageInventoryNativeScope = "none" | "linked" | "vault";

export type StorageInventoryFindingCategory =
  | "linked"
  | "unlinked"
  | "ambiguous"
  | "missing"
  | "corrupt"
  | "future-schema"
  | "cleanup-pending"
  | "quarantined-candidate";

export type StorageInventoryFindingSeverity = "info" | "warning" | "blocking";

export type StorageInventoryRelationStatus =
  | "linked"
  | "unlinked"
  | "ambiguous"
  | "missing";

export type StorageInventoryCapabilityState =
  | "supported"
  | "unsupported"
  | "unknown";

export interface StorageInventoryScope {
  readonly vaultRef: string;
  readonly pluginDir: string;
  readonly nativeScope: StorageInventoryNativeScope;
}

export interface StorageInventoryTimeRange {
  readonly oldestAt: number | null;
  readonly newestAt: number | null;
}

export interface StorageInventoryMetric {
  readonly name: string;
  readonly value: number;
}

export interface StorageInventorySource {
  readonly sourceId: StorageInventoryLocalSourceId;
  readonly status: StorageInventorySourceStatus;
  readonly schemaVersion: string | null;
  readonly recordCount: number;
  readonly fileCount: number;
  readonly byteCount: number;
  readonly timeRange: StorageInventoryTimeRange;
  readonly missingCount: number;
  readonly corruptCount: number;
  readonly futureSchemaCount: number;
  readonly generation: string | null;
  readonly metrics?: readonly StorageInventoryMetric[];
  readonly statusCode?: string;
}

export interface StorageInventoryProviderCapabilities {
  readonly enumerate: StorageInventoryCapabilityState;
  readonly inspectExistence: StorageInventoryCapabilityState;
  readonly resume: StorageInventoryCapabilityState;
  readonly archive: StorageInventoryCapabilityState;
  readonly delete: StorageInventoryCapabilityState;
}

export interface StorageInventoryProviderSnapshot {
  readonly providerId: StorageInventoryProviderId;
  readonly status: StorageInventorySourceStatus;
  readonly nativeScope: StorageInventoryNativeScope;
  readonly capabilities: StorageInventoryProviderCapabilities;
  readonly linkedCount: number;
  readonly inspectedCount: number;
  readonly existingCount: number;
  readonly missingCount: number;
  readonly unownedCandidateCount: number;
  readonly statusCode?: string;
}

/**
 * `ref` is deliberately an opaque digest. A report must never carry a native
 * execution ID, Conversation ID, Raw path, absolute path, or other source
 * identifier in clear text.
 */
export interface StorageInventoryEntityRef {
  readonly sourceId: string;
  readonly entityType: string;
  readonly ref: string;
}

export interface StorageInventoryRelation {
  readonly kind: string;
  readonly from: StorageInventoryEntityRef;
  readonly to: StorageInventoryEntityRef;
  readonly status: StorageInventoryRelationStatus;
}

export interface StorageInventoryFindingMetadata {
  readonly name: string;
  readonly value: number | boolean | null;
}

export interface StorageInventoryFinding {
  readonly findingId: string;
  readonly category: StorageInventoryFindingCategory;
  readonly code: string;
  readonly severity: StorageInventoryFindingSeverity;
  readonly sourceId: string;
  readonly recordRef?: string;
  readonly relatedRefs?: readonly string[];
  readonly count: number;
  readonly metadata?: readonly StorageInventoryFindingMetadata[];
  readonly blocksMigration: boolean;
  readonly automaticActionAllowed: false;
}

export interface StorageInventoryMigrationPreview {
  readonly status: "ready" | "partial" | "blocked";
  readonly blockingFindingIds: readonly string[];
  readonly candidateRecordCount: number;
  readonly wouldCreateRecordCount: number;
  readonly wouldUpdateRecordCount: number;
  readonly wouldRetainRecordCount: number;
  readonly destructiveActionCount: 0;
  readonly automaticActionAllowed: false;
}

export interface StorageInventoryReportInput {
  readonly generatedAt: number;
  readonly scope: StorageInventoryScope;
  readonly sources: readonly StorageInventorySource[];
  readonly providers: readonly StorageInventoryProviderSnapshot[];
  readonly relations: readonly StorageInventoryRelation[];
  readonly findings: readonly StorageInventoryFinding[];
  readonly migrationPreview: StorageInventoryMigrationPreview;
}

export interface StorageInventoryContentPolicy {
  readonly mode: "metadata-only";
  readonly rawBodies: "excluded";
  readonly conversationBodies: "excluded";
  readonly runPayloads: "excluded";
  readonly providerPayloads: "excluded";
  readonly sensitiveValues: "excluded";
  readonly absolutePaths: "excluded";
  readonly identifiers: "opaque-sha256";
}

export interface StorageInventorySafetyReceipt {
  readonly readOnly: true;
  readonly actionsApplied: 0;
  readonly deletionsApplied: 0;
  readonly writesOutsideOutputDir: 0;
  readonly rawBodiesRead: false;
}

export interface StorageInventoryReport extends StorageInventoryReportInput {
  readonly schemaVersion: typeof STORAGE_INVENTORY_SCHEMA_VERSION;
  readonly reportId: string;
  readonly snapshotFingerprint: string;
  readonly contentPolicy: StorageInventoryContentPolicy;
  readonly safetyReceipt: StorageInventorySafetyReceipt;
}

export type StorageInventoryContractErrorCode =
  | "invalid-envelope"
  | "invalid-value"
  | "unexpected-field"
  | "unsafe-field"
  | "unsafe-string"
  | "duplicate-entry"
  | "invalid-reference"
  | "fingerprint-mismatch";

export class StorageInventoryContractError extends Error {
  constructor(
    public readonly code: StorageInventoryContractErrorCode,
    message: string
  ) {
    super(message);
    this.name = "StorageInventoryContractError";
  }
}

const SOURCE_STATUSES = new Set<StorageInventorySourceStatus>([
  "scanned",
  "partial",
  "unsupported",
  "unavailable",
  "error"
]);
const NATIVE_SCOPES = new Set<StorageInventoryNativeScope>([
  "none",
  "linked",
  "vault"
]);
const FINDING_CATEGORIES = new Set<StorageInventoryFindingCategory>([
  "linked",
  "unlinked",
  "ambiguous",
  "missing",
  "corrupt",
  "future-schema",
  "cleanup-pending",
  "quarantined-candidate"
]);
const FINDING_SEVERITIES = new Set<StorageInventoryFindingSeverity>([
  "info",
  "warning",
  "blocking"
]);
const RELATION_STATUSES = new Set<StorageInventoryRelationStatus>([
  "linked",
  "unlinked",
  "ambiguous",
  "missing"
]);
const CAPABILITY_STATES = new Set<StorageInventoryCapabilityState>([
  "supported",
  "unsupported",
  "unknown"
]);
export const STORAGE_INVENTORY_REPORT_CODES = Object.freeze([
  "cleanup-pending",
  "conversation-directory-unindexed",
  "conversation-index-corrupt",
  "conversation-index-count-drift",
  "conversation-index-drift",
  "conversation-index-duplicate-id",
  "conversation-index-entry-invalid",
  "conversation-index-invalid",
  "conversation-index-missing",
  "conversation-messages-corrupt",
  "conversation-metadata-corrupt",
  "conversation-metadata-directory-drift",
  "conversation-metadata-missing",
  "conversation-session-duplicate-id",
  "conversation-session-unselected",
  "conversation-snapshots-corrupt",
  "conversation-store-unavailable",
  "corrupt-jsonl",
  "data-conversation-divergence",
  "data-conversation-session-missing",
  "data-json-unavailable",
  "data-session-duplicate-id",
  "data-session-invalid",
  "data-sessions-invalid",
  "directory-read-failed",
  "duplicate-message-id",
  "entry-missing",
  "expected-directory",
  "expected-file",
  "file-read-failed",
  "future-schema",
  "history-day-corrupt",
  "history-day-count-drift",
  "history-day-index-drift",
  "history-day-index-duplicate",
  "history-day-index-invalid",
  "history-day-unindexed",
  "history-index-corrupt",
  "history-index-count-drift",
  "history-index-drift",
  "history-index-duplicate-id",
  "history-index-entry-invalid",
  "history-index-invalid",
  "history-index-missing",
  "history-session-unindexed",
  "history-store-unavailable",
  "invalid-data-json",
  "invalid-linked-id",
  "local-scan-blocked",
  "message-metadata-invalid",
  "metadata-read-failed",
  "native-conversation-missing",
  "native-event-id-invalid",
  "native-event-invalid",
  "native-event-record-invalid",
  "native-events-corrupt",
  "native-index-corrupt",
  "native-index-duplicate-id",
  "native-index-event-drift",
  "native-index-missing",
  "native-linked-missing",
  "native-record-invalid",
  "native-run-missing",
  "native-scope-none",
  "native-store-unavailable",
  "native-unlinked-candidate",
  "path-outside-scan-root",
  "path-resolution-failed",
  "provider-linked-inspection-incomplete",
  "provider-linked-kind-mismatch",
  "provider-linked-metadata-ambiguous",
  "provider-probe-failed",
  "provider-probe-partial",
  "provider-probe-unavailable",
  "provider-store-partial",
  "provider-store-unavailable",
  "provider-vault-enumeration-partial",
  "provider-vault-result-truncated",
  "quarantined-candidate",
  "raw-file-unreferenced",
  "raw-reference-missing",
  "raw-store-unavailable",
  "run-event-duplicate-id",
  "run-event-metadata-invalid",
  "run-id-ambiguous",
  "run-ledger-duplicate-id",
  "run-ledger-jsonl-corrupt",
  "run-ledger-unavailable",
  "run-local-commit-missing",
  "run-sequence-drift",
  "run-terminal-ambiguous",
  "run-terminal-missing",
  "scan-root-unavailable",
  "symlink-blocked",
  "symlink-outside-scan-root"
] as const);
const REPORT_CODES = new Set<string>(STORAGE_INVENTORY_REPORT_CODES);
export const STORAGE_INVENTORY_RELATION_KINDS = Object.freeze([
  "conversation-authority",
  "conversation-index-membership",
  "history-conversation-projection",
  "history-message-projection",
  "native-conversation-ownership",
  "native-provider-existence",
  "native-run-ownership",
  "provider-ownership",
  "raw-reference"
] as const);
export const STORAGE_INVENTORY_ENTITY_TYPES = Object.freeze([
  "index-entry",
  "message",
  "native-execution",
  "raw-body",
  "run",
  "session"
] as const);
export const STORAGE_INVENTORY_METRIC_NAMES = Object.freeze([
  "backend-binding-count",
  "cleanup-backlog-count",
  "day-count",
  "event-count",
  "legacy-thread-binding-count",
  "local-commit-run-count",
  "message-count",
  "metadata-entry-count",
  "native-record-count",
  "raw-bodies-read",
  "raw-reference-count",
  "run-count",
  "session-count",
  "terminal-run-count"
] as const);
export const STORAGE_INVENTORY_FINDING_METADATA_NAMES = Object.freeze([
  "actual-count",
  "attempt-count",
  "data-message-count",
  "indexed-count",
  "indexed-day-sum",
  "stored-message-count"
] as const);
const RELATION_KINDS = new Set<string>(STORAGE_INVENTORY_RELATION_KINDS);
const ENTITY_TYPES = new Set<string>(STORAGE_INVENTORY_ENTITY_TYPES);
const METRIC_NAMES = new Set<string>(STORAGE_INVENTORY_METRIC_NAMES);
const FINDING_METADATA_NAMES = new Set<string>(
  STORAGE_INVENTORY_FINDING_METADATA_NAMES
);
const SAFE_TOKEN_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,159}$/;
const CANONICAL_SCHEMA_VERSION_PATTERN = /^(0|[1-9][0-9]{0,15})$/;
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const REPORT_ID_PATTERN = /^storage-inventory-[a-f0-9]{24}$/;
const MAX_DATE_MS = 8_640_000_000_000_000;
const UNSAFE_STRING_PATTERN =
  /(?:^(?:\/|~[\\/]|[a-zA-Z]:[\\/])|(?:file|https?):\/\/|Bearer\s+|(?:sk|ghp|github_pat)[-_][A-Za-z0-9_-]{12,}|xox[baprs]-[A-Za-z0-9-]{12,}|AKIA[A-Z0-9]{16}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.)/;
const FORBIDDEN_FIELD_NAMES = new Set([
  "body",
  "rawbody",
  "messagebody",
  "text",
  "content",
  "prompt",
  "input",
  "output",
  "response",
  "toolinput",
  "tooloutput",
  "diff",
  "patch",
  "error",
  "errormessage",
  "stack",
  "cwd",
  "path",
  "absolutepath",
  "endpoint",
  "providerendpoint",
  "token",
  "accesstoken",
  "refreshtoken",
  "secret",
  "apikey",
  "authorization",
  "cookie",
  "headers"
]);
const MIGRATION_BLOCKING_FINDING_CODES = new Set([
  "path-outside-scan-root",
  "symlink-outside-scan-root",
  "symlink-blocked",
  "path-resolution-failed"
]);

const INPUT_KEYS = [
  "generatedAt",
  "scope",
  "sources",
  "providers",
  "relations",
  "findings",
  "migrationPreview"
] as const;

const REPORT_KEYS = [
  ...INPUT_KEYS,
  "schemaVersion",
  "reportId",
  "snapshotFingerprint",
  "contentPolicy",
  "safetyReceipt"
] as const;

/**
 * Hashes a source identifier before it crosses the inventory report boundary.
 */
export function createStorageInventoryOpaqueRef(
  namespace: string,
  value: string
): string {
  expectSafeToken(namespace, "opaque-ref.namespace");
  if (typeof value !== "string" || value.length === 0) {
    fail("invalid-value", "opaque-ref.value 必须为非空字符串");
  }
  return `sha256:${createHash("sha256")
    .update(namespace, "utf8")
    .update("\0", "utf8")
    .update(value, "utf8")
    .digest("hex")}`;
}

export function storageInventoryReportId(snapshotFingerprint: string): string {
  expectSha256(snapshotFingerprint, "snapshotFingerprint");
  return `storage-inventory-${snapshotFingerprint.slice("sha256:".length, "sha256:".length + 24)}`;
}

/**
 * Rejects clear-text bodies, paths, provider payloads, secrets, and unknown
 * body-shaped fields before a value can be serialized or rendered.
 */
export function assertStorageInventoryMetadataOnly(value: unknown): void {
  const ancestors = new Set<object>();
  const visit = (current: unknown, location: string): void => {
    if (typeof current === "string") {
      if (
        current.length > 512
        || hasAsciiControlCharacter(current)
        || UNSAFE_STRING_PATTERN.test(current)
      ) {
        fail("unsafe-string", `${location} 含有不允许进入 metadata-only 报告的字符串`);
      }
      return;
    }
    if (!current || typeof current !== "object") return;
    if (ancestors.has(current)) {
      fail("invalid-envelope", `${location} 包含循环引用`);
    }
    ancestors.add(current);
    if (Array.isArray(current)) {
      current.forEach((item, index) => visit(item, `${location}[${index}]`));
      ancestors.delete(current);
      return;
    }
    for (const [key, nested] of Object.entries(current as Record<string, unknown>)) {
      const normalizedKey = key.replace(/[-_]/g, "").toLowerCase();
      if (FORBIDDEN_FIELD_NAMES.has(normalizedKey)) {
        fail("unsafe-field", `${location} 包含禁止字段 ${key}`);
      }
      visit(nested, `${location}.${key}`);
    }
    ancestors.delete(current);
  };
  visit(value, "report");
}

export function validateStorageInventoryReportInput(
  value: unknown
): StorageInventoryReportInput {
  assertStorageInventoryMetadataOnly(value);
  const input = expectPlainObject(value, "reportInput");
  expectExactKeys(input, INPUT_KEYS, "reportInput");
  expectTimestamp(input.generatedAt, "reportInput.generatedAt");
  validateScope(input.scope);
  validateSources(input.sources);
  validateProviders(input.providers);
  validateRelations(input.relations, input.sources, input.providers);
  validateFindings(input.findings, input.sources, input.providers);
  validateMigrationPreview(
    input.migrationPreview,
    input.sources,
    input.providers,
    input.findings
  );
  return input as unknown as StorageInventoryReportInput;
}

export function validateStorageInventoryReport(
  value: unknown
): StorageInventoryReport {
  assertStorageInventoryMetadataOnly(value);
  const report = expectPlainObject(value, "report");
  expectExactKeys(report, REPORT_KEYS, "report");
  if (report.schemaVersion !== STORAGE_INVENTORY_SCHEMA_VERSION) {
    fail("invalid-value", "report.schemaVersion 不受支持");
  }
  expectSha256(report.snapshotFingerprint, "report.snapshotFingerprint");
  if (
    typeof report.reportId !== "string"
    || !REPORT_ID_PATTERN.test(report.reportId)
    || report.reportId !== storageInventoryReportId(report.snapshotFingerprint)
  ) {
    fail("invalid-value", "report.reportId 与 snapshotFingerprint 不匹配");
  }
  validateContentPolicy(report.contentPolicy);
  validateSafetyReceipt(report.safetyReceipt);
  validateStorageInventoryReportInput({
    generatedAt: report.generatedAt,
    scope: report.scope,
    sources: report.sources,
    providers: report.providers,
    relations: report.relations,
    findings: report.findings,
    migrationPreview: report.migrationPreview
  });
  return report as unknown as StorageInventoryReport;
}

function validateScope(value: unknown): void {
  const scope = expectPlainObject(value, "scope");
  expectExactKeys(scope, ["vaultRef", "pluginDir", "nativeScope"], "scope");
  expectSha256(scope.vaultRef, "scope.vaultRef");
  if (
    typeof scope.pluginDir !== "string"
    || scope.pluginDir === "."
    || scope.pluginDir === ".."
    || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(scope.pluginDir)
  ) {
    fail("invalid-value", "scope.pluginDir 必须是单一路径段");
  }
  if (!NATIVE_SCOPES.has(scope.nativeScope as StorageInventoryNativeScope)) {
    fail("invalid-value", "scope.nativeScope 非法");
  }
}

function validateSources(value: unknown): void {
  if (!Array.isArray(value)) fail("invalid-envelope", "sources 必须是数组");
  const seen = new Set<string>();
  for (const [index, item] of value.entries()) {
    const source = expectPlainObject(item, `sources[${index}]`);
    expectExactKeys(
      source,
      [
        "sourceId",
        "status",
        "schemaVersion",
        "recordCount",
        "fileCount",
        "byteCount",
        "timeRange",
        "missingCount",
        "corruptCount",
        "futureSchemaCount",
        "generation",
        "metrics",
        "statusCode"
      ],
      `sources[${index}]`,
      ["metrics", "statusCode"]
    );
    if (!STORAGE_INVENTORY_LOCAL_SOURCE_IDS.includes(source.sourceId as StorageInventoryLocalSourceId)) {
      fail("invalid-value", `sources[${index}].sourceId 非法`);
    }
    expectUnique(seen, source.sourceId as string, `sources[${index}].sourceId`);
    if (!SOURCE_STATUSES.has(source.status as StorageInventorySourceStatus)) {
      fail("invalid-value", `sources[${index}].status 非法`);
    }
    if (source.schemaVersion !== null) {
      if (
        typeof source.schemaVersion !== "string"
        || !CANONICAL_SCHEMA_VERSION_PATTERN.test(source.schemaVersion)
      ) {
        fail("invalid-value", `sources[${index}].schemaVersion 非法`);
      }
    }
    for (const key of [
      "recordCount",
      "fileCount",
      "byteCount",
      "missingCount",
      "corruptCount",
      "futureSchemaCount"
    ]) {
      expectNonNegativeInteger(source[key], `sources[${index}].${key}`);
    }
    validateTimeRange(source.timeRange, `sources[${index}].timeRange`);
    if (source.generation !== null) {
      expectSha256(source.generation, `sources[${index}].generation`);
    }
    if ("metrics" in source) validateMetrics(source.metrics, `sources[${index}].metrics`);
    if ("statusCode" in source) {
      expectKnownReportCode(source.statusCode, `sources[${index}].statusCode`);
    }
  }
  if (
    seen.size !== STORAGE_INVENTORY_LOCAL_SOURCE_IDS.length
    || STORAGE_INVENTORY_LOCAL_SOURCE_IDS.some((sourceId) => !seen.has(sourceId))
  ) {
    fail("invalid-envelope", "sources 必须逐一包含六个本地 Store");
  }
}

function validateProviders(value: unknown): void {
  if (!Array.isArray(value)) fail("invalid-envelope", "providers 必须是数组");
  const seen = new Set<string>();
  for (const [index, item] of value.entries()) {
    const provider = expectPlainObject(item, `providers[${index}]`);
    expectExactKeys(
      provider,
      [
        "providerId",
        "status",
        "nativeScope",
        "capabilities",
        "linkedCount",
        "inspectedCount",
        "existingCount",
        "missingCount",
        "unownedCandidateCount",
        "statusCode"
      ],
      `providers[${index}]`,
      ["statusCode"]
    );
    if (!STORAGE_INVENTORY_PROVIDER_IDS.includes(provider.providerId as StorageInventoryProviderId)) {
      fail("invalid-value", `providers[${index}].providerId 非法`);
    }
    expectUnique(seen, provider.providerId as string, `providers[${index}].providerId`);
    if (!SOURCE_STATUSES.has(provider.status as StorageInventorySourceStatus)) {
      fail("invalid-value", `providers[${index}].status 非法`);
    }
    if (!NATIVE_SCOPES.has(provider.nativeScope as StorageInventoryNativeScope)) {
      fail("invalid-value", `providers[${index}].nativeScope 非法`);
    }
    validateProviderCapabilities(provider.capabilities, `providers[${index}].capabilities`);
    for (const key of [
      "linkedCount",
      "inspectedCount",
      "existingCount",
      "missingCount",
      "unownedCandidateCount"
    ]) {
      expectNonNegativeInteger(provider[key], `providers[${index}].${key}`);
    }
    if ("statusCode" in provider) {
      expectKnownReportCode(provider.statusCode, `providers[${index}].statusCode`);
    }
    if ((provider.inspectedCount as number) > (provider.linkedCount as number)) {
      fail("invalid-value", `providers[${index}] 的 inspectedCount 不能超过 linkedCount`);
    }
    if (
      (provider.existingCount as number) + (provider.missingCount as number)
      > (provider.inspectedCount as number)
    ) {
      fail(
        "invalid-value",
        `providers[${index}] 的 existingCount 与 missingCount 不能超过 inspectedCount`
      );
    }
  }
  if (
    seen.size !== STORAGE_INVENTORY_PROVIDER_IDS.length
    || STORAGE_INVENTORY_PROVIDER_IDS.some((providerId) => !seen.has(providerId))
  ) {
    fail("invalid-envelope", "providers 必须逐一包含三个后端");
  }
}

function validateProviderCapabilities(value: unknown, location: string): void {
  const capabilities = expectPlainObject(value, location);
  const keys = ["enumerate", "inspectExistence", "resume", "archive", "delete"] as const;
  expectExactKeys(capabilities, keys, location);
  for (const key of keys) {
    if (!CAPABILITY_STATES.has(capabilities[key] as StorageInventoryCapabilityState)) {
      fail("invalid-value", `${location}.${key} 非法`);
    }
  }
}

function validateRelations(
  value: unknown,
  sourcesValue: unknown,
  providersValue: unknown
): void {
  if (!Array.isArray(value)) fail("invalid-envelope", "relations 必须是数组");
  const validSourceIds = storageSourceIds(sourcesValue, providersValue);
  for (const [index, item] of value.entries()) {
    const relation = expectPlainObject(item, `relations[${index}]`);
    expectExactKeys(relation, ["kind", "from", "to", "status"], `relations[${index}]`);
    expectKnownLabel(
      relation.kind,
      RELATION_KINDS,
      `relations[${index}].kind`,
      "relation kind"
    );
    validateEntityRef(relation.from, `relations[${index}].from`, validSourceIds);
    validateEntityRef(relation.to, `relations[${index}].to`, validSourceIds);
    if (!RELATION_STATUSES.has(relation.status as StorageInventoryRelationStatus)) {
      fail("invalid-value", `relations[${index}].status 非法`);
    }
  }
}

function validateEntityRef(
  value: unknown,
  location: string,
  validSourceIds: ReadonlySet<string>
): void {
  const ref = expectPlainObject(value, location);
  expectExactKeys(ref, ["sourceId", "entityType", "ref"], location);
  expectSafeToken(ref.sourceId, `${location}.sourceId`);
  if (!validSourceIds.has(ref.sourceId)) {
    fail("invalid-reference", `${location}.sourceId 未声明`);
  }
  expectKnownLabel(ref.entityType, ENTITY_TYPES, `${location}.entityType`, "entity type");
  expectSha256(ref.ref, `${location}.ref`);
}

function validateFindings(
  value: unknown,
  sourcesValue: unknown,
  providersValue: unknown
): void {
  if (!Array.isArray(value)) fail("invalid-envelope", "findings 必须是数组");
  const validSourceIds = storageSourceIds(sourcesValue, providersValue);
  const seen = new Set<string>();
  for (const [index, item] of value.entries()) {
    const finding = expectPlainObject(item, `findings[${index}]`);
    expectExactKeys(
      finding,
      [
        "findingId",
        "category",
        "code",
        "severity",
        "sourceId",
        "recordRef",
        "relatedRefs",
        "count",
        "metadata",
        "blocksMigration",
        "automaticActionAllowed"
      ],
      `findings[${index}]`,
      ["recordRef", "relatedRefs", "metadata"]
    );
    expectSha256(finding.findingId, `findings[${index}].findingId`);
    expectUnique(seen, finding.findingId, `findings[${index}].findingId`);
    if (!FINDING_CATEGORIES.has(finding.category as StorageInventoryFindingCategory)) {
      fail("invalid-value", `findings[${index}].category 非法`);
    }
    expectKnownReportCode(finding.code, `findings[${index}].code`);
    if (!FINDING_SEVERITIES.has(finding.severity as StorageInventoryFindingSeverity)) {
      fail("invalid-value", `findings[${index}].severity 非法`);
    }
    expectSafeToken(finding.sourceId, `findings[${index}].sourceId`);
    if (!validSourceIds.has(finding.sourceId)) {
      fail("invalid-reference", `findings[${index}].sourceId 未声明`);
    }
    if ("recordRef" in finding) expectSha256(finding.recordRef, `findings[${index}].recordRef`);
    if ("relatedRefs" in finding) {
      validateOpaqueRefs(finding.relatedRefs, `findings[${index}].relatedRefs`);
    }
    expectNonNegativeInteger(finding.count, `findings[${index}].count`);
    if (finding.count === 0) {
      fail("invalid-value", `findings[${index}].count 必须大于零`);
    }
    if ("metadata" in finding) {
      validateFindingMetadata(finding.metadata, `findings[${index}].metadata`);
    }
    if (typeof finding.blocksMigration !== "boolean") {
      fail("invalid-value", `findings[${index}].blocksMigration 必须是布尔值`);
    }
    if (finding.automaticActionAllowed !== false) {
      fail("invalid-value", `findings[${index}].automaticActionAllowed 必须为 false`);
    }
    if ((finding.severity === "blocking") !== finding.blocksMigration) {
      fail("invalid-value", `findings[${index}] 的 severity 与 blocksMigration 不一致`);
    }
    if (
      (finding.category === "corrupt" || finding.category === "future-schema")
      && !finding.blocksMigration
    ) {
      fail("invalid-value", `findings[${index}] 必须阻断 migration`);
    }
    if (
      MIGRATION_BLOCKING_FINDING_CODES.has(finding.code)
      && !finding.blocksMigration
    ) {
      fail("invalid-value", `findings[${index}] 的越界 finding 必须阻断 migration`);
    }
  }
}

function validateMigrationPreview(
  value: unknown,
  sourcesValue: unknown,
  providersValue: unknown,
  findingsValue: unknown
): void {
  const preview = expectPlainObject(value, "migrationPreview");
  expectExactKeys(
    preview,
    [
      "status",
      "blockingFindingIds",
      "candidateRecordCount",
      "wouldCreateRecordCount",
      "wouldUpdateRecordCount",
      "wouldRetainRecordCount",
      "destructiveActionCount",
      "automaticActionAllowed"
    ],
    "migrationPreview"
  );
  if (preview.status !== "ready" && preview.status !== "partial" && preview.status !== "blocked") {
    fail("invalid-value", "migrationPreview.status 非法");
  }
  if (!Array.isArray(preview.blockingFindingIds)) {
    fail("invalid-envelope", "migrationPreview.blockingFindingIds 必须是数组");
  }
  const supplied = new Set<string>();
  for (const [index, findingId] of preview.blockingFindingIds.entries()) {
    expectSha256(findingId, `migrationPreview.blockingFindingIds[${index}]`);
    expectUnique(supplied, findingId, `migrationPreview.blockingFindingIds[${index}]`);
  }
  for (const key of [
    "candidateRecordCount",
    "wouldCreateRecordCount",
    "wouldUpdateRecordCount",
    "wouldRetainRecordCount"
  ]) {
    expectNonNegativeInteger(preview[key], `migrationPreview.${key}`);
  }
  if (preview.automaticActionAllowed !== false) {
    fail("invalid-value", "migrationPreview.automaticActionAllowed 必须为 false");
  }
  if (preview.destructiveActionCount !== 0) {
    fail("invalid-value", "migrationPreview.destructiveActionCount 必须为 0");
  }
  const sources = sourcesValue as Array<Record<string, unknown>>;
  const providers = providersValue as Array<Record<string, unknown>>;
  const findings = findingsValue as Array<Record<string, unknown>>;
  const expectedCandidateRecordCount = findings
    .filter((finding) =>
      finding.category === "unlinked"
      || finding.category === "ambiguous"
      || finding.category === "quarantined-candidate")
    .reduce((sum, finding) => sum + (finding.count as number), 0);
  const expectedRetainedRecordCount = sources
    .reduce((sum, source) => sum + (source.recordCount as number), 0);
  if (preview.candidateRecordCount !== expectedCandidateRecordCount) {
    fail("invalid-value", "migrationPreview.candidateRecordCount 与 findings 不一致");
  }
  if (preview.wouldRetainRecordCount !== expectedRetainedRecordCount) {
    fail("invalid-value", "migrationPreview.wouldRetainRecordCount 与本地 Store 记录数不一致");
  }
  if (preview.wouldCreateRecordCount !== 0 || preview.wouldUpdateRecordCount !== 0) {
    fail("invalid-value", "Phase 0 migrationPreview 不允许创建或更新记录");
  }
  for (const source of sources) {
    const corruptCount = source.corruptCount as number;
    const futureSchemaCount = source.futureSchemaCount as number;
    if (
      (corruptCount > 0 || futureSchemaCount > 0)
      && source.status === "scanned"
    ) {
      fail("invalid-value", "本地 Store 的损坏或 future schema 计数与 scanned 状态不一致");
    }
    if (
      corruptCount > 0
      && !findings.some((finding) =>
        finding.sourceId === source.sourceId
        && finding.category === "corrupt"
        && finding.blocksMigration === true)
    ) {
      fail("invalid-reference", "本地 Store 的 corruptCount 缺少对应 blocking finding");
    }
    if (
      futureSchemaCount > 0
      && !findings.some((finding) =>
        finding.sourceId === source.sourceId
        && finding.category === "future-schema"
        && finding.blocksMigration === true)
    ) {
      fail("invalid-reference", "本地 Store 的 futureSchemaCount 缺少对应 blocking finding");
    }
  }
  const expected = new Set(
    findings
      .filter((finding) => Boolean(finding.blocksMigration))
      .map((finding) => finding.findingId as string)
  );
  if (
    expected.size !== supplied.size
    || [...expected].some((findingId) => !supplied.has(findingId))
  ) {
    fail("invalid-reference", "migrationPreview.blockingFindingIds 与 blocking findings 不一致");
  }
  const partial = sources.some((source) => source.status !== "scanned")
    || providers.some((provider) =>
      provider.nativeScope !== "none"
      && provider.status !== "scanned"
      && provider.status !== "unsupported")
    || findings.some((finding) => finding.category !== "linked");
  const expectedStatus = expected.size > 0
    ? "blocked"
    : partial
      ? "partial"
      : "ready";
  if (preview.status !== expectedStatus) {
    fail("invalid-value", "migrationPreview.status 与已验证的 Store 状态和 findings 不一致");
  }
}

function validateContentPolicy(value: unknown): void {
  const policy = expectPlainObject(value, "contentPolicy");
  const expected = STORAGE_INVENTORY_CONTENT_POLICY as Record<string, unknown>;
  expectExactKeys(policy, Object.keys(expected), "contentPolicy");
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (policy[key] !== expectedValue) {
      fail("invalid-value", `contentPolicy.${key} 不符合 metadata-only 策略`);
    }
  }
}

function validateSafetyReceipt(value: unknown): void {
  const receipt = expectPlainObject(value, "safetyReceipt");
  const expected = STORAGE_INVENTORY_SAFETY_RECEIPT as Record<string, unknown>;
  expectExactKeys(receipt, Object.keys(expected), "safetyReceipt");
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (receipt[key] !== expectedValue) {
      fail("invalid-value", `safetyReceipt.${key} 不符合只读收据`);
    }
  }
}

function validateTimeRange(value: unknown, location: string): void {
  const range = expectPlainObject(value, location);
  expectExactKeys(range, ["oldestAt", "newestAt"], location);
  const oldestAt = expectNullableTimestamp(range.oldestAt, `${location}.oldestAt`);
  const newestAt = expectNullableTimestamp(range.newestAt, `${location}.newestAt`);
  if ((oldestAt === null) !== (newestAt === null)) {
    fail("invalid-value", `${location} 必须同时提供或同时省略起止时间`);
  }
  if (oldestAt !== null && newestAt !== null && oldestAt > newestAt) {
    fail("invalid-value", `${location}.oldestAt 不能晚于 newestAt`);
  }
}

function validateMetrics(value: unknown, location: string): void {
  if (!Array.isArray(value)) fail("invalid-envelope", `${location} 必须是数组`);
  const seen = new Set<string>();
  for (const [index, item] of value.entries()) {
    const metric = expectPlainObject(item, `${location}[${index}]`);
    expectExactKeys(metric, ["name", "value"], `${location}[${index}]`);
    expectKnownLabel(
      metric.name,
      METRIC_NAMES,
      `${location}[${index}].name`,
      "metric name"
    );
    expectUnique(seen, metric.name, `${location}[${index}].name`);
    expectNonNegativeInteger(metric.value, `${location}[${index}].value`);
  }
}

function validateFindingMetadata(value: unknown, location: string): void {
  if (!Array.isArray(value)) fail("invalid-envelope", `${location} 必须是数组`);
  const seen = new Set<string>();
  for (const [index, item] of value.entries()) {
    const metadata = expectPlainObject(item, `${location}[${index}]`);
    expectExactKeys(metadata, ["name", "value"], `${location}[${index}]`);
    expectKnownLabel(
      metadata.name,
      FINDING_METADATA_NAMES,
      `${location}[${index}].name`,
      "finding metadata name"
    );
    expectUnique(seen, metadata.name, `${location}[${index}].name`);
    if (
      metadata.value !== null
      && typeof metadata.value !== "boolean"
      && !(typeof metadata.value === "number" && Number.isSafeInteger(metadata.value))
    ) {
      fail("invalid-value", `${location}[${index}].value 必须是安全的 metadata scalar`);
    }
  }
}

function validateOpaqueRefs(value: unknown, location: string): void {
  if (!Array.isArray(value)) fail("invalid-envelope", `${location} 必须是数组`);
  const seen = new Set<string>();
  for (const [index, ref] of value.entries()) {
    expectSha256(ref, `${location}[${index}]`);
    expectUnique(seen, ref, `${location}[${index}]`);
  }
}

function storageSourceIds(
  sourcesValue: unknown,
  providersValue: unknown
): ReadonlySet<string> {
  return new Set([
    ...(sourcesValue as Array<Record<string, unknown>>).map((source) => source.sourceId as string),
    ...(providersValue as Array<Record<string, unknown>>).map(
      (provider) => `provider-${provider.providerId as string}`
    )
  ]);
}

function expectPlainObject(
  value: unknown,
  location: string
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("invalid-envelope", `${location} 必须是 object`);
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail("invalid-envelope", `${location} 必须是 plain object`);
  }
  return value as Record<string, unknown>;
}

function expectExactKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
  location: string,
  optionalKeys: readonly string[] = []
): void {
  const allowed = new Set(allowedKeys);
  const optional = new Set(optionalKeys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      fail("unexpected-field", `${location} 包含未知字段 ${key}`);
    }
  }
  for (const key of allowedKeys) {
    if (!optional.has(key) && !Object.prototype.hasOwnProperty.call(value, key)) {
      fail("invalid-envelope", `${location} 缺少字段 ${key}`);
    }
  }
}

function expectSafeToken(value: unknown, location: string): asserts value is string {
  if (typeof value !== "string" || !SAFE_TOKEN_PATTERN.test(value)) {
    fail("invalid-value", `${location} 必须是安全 token`);
  }
}

function expectKnownReportCode(value: unknown, location: string): asserts value is string {
  if (typeof value !== "string" || !REPORT_CODES.has(value)) {
    fail("invalid-value", `${location} 必须是已登记的固定报告码`);
  }
}

function expectKnownLabel(
  value: unknown,
  allowed: ReadonlySet<string>,
  location: string,
  label: string
): asserts value is string {
  if (typeof value !== "string" || !allowed.has(value)) {
    fail("invalid-value", `${location} 必须是已登记的 ${label}`);
  }
}

function hasAsciiControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function expectSha256(value: unknown, location: string): asserts value is string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    fail("invalid-value", `${location} 必须是 sha256 opaque ref`);
  }
}

function expectNonNegativeInteger(value: unknown, location: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    fail("invalid-value", `${location} 必须是非负安全整数`);
  }
  return value as number;
}

function expectNullableTimestamp(value: unknown, location: string): number | null {
  if (value === null) return null;
  return expectTimestamp(value, location);
}

function expectTimestamp(value: unknown, location: string): number {
  const timestamp = expectNonNegativeInteger(value, location);
  if (timestamp > MAX_DATE_MS) {
    fail("invalid-value", `${location} 超出可序列化的时间范围`);
  }
  return timestamp;
}

function expectUnique(
  seen: Set<string>,
  value: string,
  location: string
): void {
  if (seen.has(value)) {
    fail("duplicate-entry", `${location} 重复`);
  }
  seen.add(value);
}

function fail(code: StorageInventoryContractErrorCode, message: string): never {
  throw new StorageInventoryContractError(code, message);
}
