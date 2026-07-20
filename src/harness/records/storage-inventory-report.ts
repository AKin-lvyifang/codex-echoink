import { createHash } from "node:crypto";
import {
  STORAGE_INVENTORY_CONTENT_POLICY,
  STORAGE_INVENTORY_LOCAL_SOURCE_IDS,
  STORAGE_INVENTORY_PROVIDER_IDS,
  STORAGE_INVENTORY_SAFETY_RECEIPT,
  STORAGE_INVENTORY_SCHEMA_VERSION,
  StorageInventoryContractError,
  type StorageInventoryEntityRef,
  type StorageInventoryFinding,
  type StorageInventoryFindingMetadata,
  type StorageInventoryMetric,
  type StorageInventoryProviderSnapshot,
  type StorageInventoryRelation,
  type StorageInventoryReport,
  type StorageInventoryReportInput,
  type StorageInventorySource,
  storageInventoryReportId,
  validateStorageInventoryReport,
  validateStorageInventoryReportInput
} from "./storage-inventory-contract";

const SOURCE_ORDER = new Map(
  STORAGE_INVENTORY_LOCAL_SOURCE_IDS.map((sourceId, index) => [sourceId, index])
);
const PROVIDER_ORDER = new Map(
  STORAGE_INVENTORY_PROVIDER_IDS.map((providerId, index) => [providerId, index])
);
const SEVERITY_ORDER = new Map([
  ["blocking", 0],
  ["warning", 1],
  ["info", 2]
]);

/**
 * Validates and canonicalizes a scanner result. Array order from filesystem or
 * provider enumeration is never allowed to affect report output.
 */
export function canonicalizeStorageInventoryReportInput(
  value: unknown
): StorageInventoryReportInput {
  const input = validateStorageInventoryReportInput(value);
  const canonical: StorageInventoryReportInput = {
    generatedAt: input.generatedAt,
    scope: {
      vaultRef: input.scope.vaultRef,
      pluginDir: input.scope.pluginDir,
      nativeScope: input.scope.nativeScope
    },
    sources: input.sources
      .map(canonicalSource)
      .sort((left, right) =>
        (SOURCE_ORDER.get(left.sourceId) ?? Number.MAX_SAFE_INTEGER)
        - (SOURCE_ORDER.get(right.sourceId) ?? Number.MAX_SAFE_INTEGER)
      ),
    providers: input.providers
      .map(canonicalProvider)
      .sort((left, right) =>
        (PROVIDER_ORDER.get(left.providerId) ?? Number.MAX_SAFE_INTEGER)
        - (PROVIDER_ORDER.get(right.providerId) ?? Number.MAX_SAFE_INTEGER)
      ),
    relations: input.relations
      .map(canonicalRelation)
      .sort(compareRelations),
    findings: input.findings
      .map(canonicalFinding)
      .sort(compareFindings),
    migrationPreview: {
      status: input.migrationPreview.status,
      blockingFindingIds: [...input.migrationPreview.blockingFindingIds].sort(compareText),
      candidateRecordCount: input.migrationPreview.candidateRecordCount,
      wouldCreateRecordCount: input.migrationPreview.wouldCreateRecordCount,
      wouldUpdateRecordCount: input.migrationPreview.wouldUpdateRecordCount,
      wouldRetainRecordCount: input.migrationPreview.wouldRetainRecordCount,
      destructiveActionCount: 0,
      automaticActionAllowed: false
    }
  };
  return deepFreeze(canonical);
}

/**
 * Builds the only supported persisted report shape. Volatile `generatedAt`
 * does not participate in the snapshot fingerprint.
 */
export function buildStorageInventoryReport(
  value: unknown
): StorageInventoryReport {
  const input = canonicalizeStorageInventoryReportInput(value);
  const snapshotFingerprint = fingerprintCanonicalInput(input);
  const report: StorageInventoryReport = {
    schemaVersion: STORAGE_INVENTORY_SCHEMA_VERSION,
    reportId: storageInventoryReportId(snapshotFingerprint),
    generatedAt: input.generatedAt,
    snapshotFingerprint,
    contentPolicy: STORAGE_INVENTORY_CONTENT_POLICY,
    safetyReceipt: STORAGE_INVENTORY_SAFETY_RECEIPT,
    scope: input.scope,
    sources: input.sources,
    providers: input.providers,
    relations: input.relations,
    findings: input.findings,
    migrationPreview: input.migrationPreview
  };
  validateStorageInventoryReport(report);
  return deepFreeze(report);
}

/**
 * Returns a fingerprint for either a scanner input or a complete report.
 */
export function storageInventorySnapshotFingerprint(value: unknown): string {
  return fingerprintCanonicalInput(reportInputFromUnknown(value));
}

/**
 * Produces deterministic, metadata-only JSON. Integrity is checked before any
 * bytes are returned so a caller cannot serialize a report with a stale or
 * hand-written fingerprint.
 */
export function serializeStorageInventoryReport(value: unknown): string {
  const report = canonicalizeStorageInventoryReport(value);
  assertReportFingerprint(report);
  return `${JSON.stringify(sortObjectKeys(report), null, 2)}\n`;
}

/**
 * Renders aggregates rather than record-level identifiers. The JSON report
 * retains opaque refs for machine comparison; Markdown intentionally exposes
 * only counts and fixed metadata labels.
 */
export function renderStorageInventoryMarkdown(value: unknown): string {
  const report = canonicalizeStorageInventoryReport(value);
  assertReportFingerprint(report);
  const relationAggregates = aggregateRelations(report.relations);
  const findingAggregates = aggregateFindings(report.findings);
  const sourceStatusSummary = aggregateStatuses(report.sources);
  const providerStatusSummary = aggregateStatuses(report.providers);

  const lines = [
    "# EchoInk Record Lifecycle Inventory",
    "",
    `- Schema: \`${report.schemaVersion}\``,
    `- Report: \`${report.reportId}\``,
    `- Snapshot: \`${report.snapshotFingerprint}\``,
    `- Generated: \`${new Date(report.generatedAt).toISOString()}\``,
    `- Vault ref: \`${report.scope.vaultRef}\``,
    `- Plugin dir: \`${report.scope.pluginDir}\``,
    `- Native scope: \`${report.scope.nativeScope}\``,
    "",
    "## Safety receipt",
    "",
    "| Check | Value |",
    "| --- | ---: |",
    `| readOnly | ${report.safetyReceipt.readOnly} |`,
    `| actionsApplied | ${report.safetyReceipt.actionsApplied} |`,
    `| deletionsApplied | ${report.safetyReceipt.deletionsApplied} |`,
    `| writesOutsideOutputDir | ${report.safetyReceipt.writesOutsideOutputDir} |`,
    `| rawBodiesRead | ${report.safetyReceipt.rawBodiesRead} |`,
    "",
    "## Local stores",
    "",
    `Status summary: ${sourceStatusSummary || "none"}.`,
    "",
    "| Source | Status | Schema | Records | Files | Bytes | Oldest | Newest | Missing | Corrupt | Future schema | Generation | Metrics |",
    "| --- | --- | --- | ---: | ---: | ---: | --- | --- | ---: | ---: | ---: | --- | --- |",
    ...report.sources.map((source) => [
      `\`${source.sourceId}\``,
      formatStatus(source.status, source.statusCode),
      formatNullable(source.schemaVersion),
      String(source.recordCount),
      String(source.fileCount),
      String(source.byteCount),
      formatTimestamp(source.timeRange.oldestAt),
      formatTimestamp(source.timeRange.newestAt),
      String(source.missingCount),
      String(source.corruptCount),
      String(source.futureSchemaCount),
      formatNullable(source.generation),
      formatMetrics(source.metrics)
    ].join(" | ").replace(/^/, "| ").concat(" |")),
    "",
    "## Native providers",
    "",
    `Status summary: ${providerStatusSummary || "none"}.`,
    "",
    "| Provider | Status | Scope | Linked | Inspected | Existing | Missing | Unowned candidates | Enumerate | Inspect | Resume | Archive | Delete |",
    "| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- | --- | --- | --- | --- |",
    ...report.providers.map((provider) => [
      `\`${provider.providerId}\``,
      formatStatus(provider.status, provider.statusCode),
      `\`${provider.nativeScope}\``,
      String(provider.linkedCount),
      String(provider.inspectedCount),
      String(provider.existingCount),
      String(provider.missingCount),
      String(provider.unownedCandidateCount),
      provider.capabilities.enumerate,
      provider.capabilities.inspectExistence,
      provider.capabilities.resume,
      provider.capabilities.archive,
      provider.capabilities.delete
    ].join(" | ").replace(/^/, "| ").concat(" |")),
    "",
    "## Relations",
    "",
    "| Kind | Status | Count |",
    "| --- | --- | ---: |",
    ...(relationAggregates.length
      ? relationAggregates.map((item) =>
        `| \`${item.kind}\` | ${item.status} | ${item.count} |`
      )
      : ["| none | none | 0 |"]),
    "",
    "## Findings",
    "",
    "| Severity | Category | Code | Source | Findings | Affected records | Blocks migration | Automatic action |",
    "| --- | --- | --- | --- | ---: | ---: | --- | --- |",
    ...(findingAggregates.length
      ? findingAggregates.map((item) =>
        `| ${item.severity} | ${item.category} | \`${item.code}\` | \`${item.sourceId}\` | ${item.findingCount} | ${item.affectedCount} | ${item.blocksMigration} | false |`
      )
      : ["| info | linked | `none` | `none` | 0 | 0 | false | false |"]),
    "",
    "## Migration preview",
    "",
    `- Status: \`${report.migrationPreview.status}\``,
    `- Blocking findings: ${report.migrationPreview.blockingFindingIds.length}`,
    `- Candidate records: ${report.migrationPreview.candidateRecordCount}`,
    `- Would create: ${report.migrationPreview.wouldCreateRecordCount}`,
    `- Would update: ${report.migrationPreview.wouldUpdateRecordCount}`,
    `- Would retain: ${report.migrationPreview.wouldRetainRecordCount}`,
    `- Destructive actions: ${report.migrationPreview.destructiveActionCount}`,
    `- Automatic action allowed: ${report.migrationPreview.automaticActionAllowed}`,
    "",
    "## Content policy",
    "",
    `- Mode: \`${report.contentPolicy.mode}\``,
    `- Raw bodies: \`${report.contentPolicy.rawBodies}\``,
    `- Conversation bodies: \`${report.contentPolicy.conversationBodies}\``,
    `- Run payloads: \`${report.contentPolicy.runPayloads}\``,
    `- Provider payloads: \`${report.contentPolicy.providerPayloads}\``,
    `- Sensitive values: \`${report.contentPolicy.sensitiveValues}\``,
    `- Absolute paths: \`${report.contentPolicy.absolutePaths}\``,
    `- Identifiers: \`${report.contentPolicy.identifiers}\``,
    ""
  ];
  return lines.join("\n");
}

export function canonicalizeStorageInventoryReport(
  value: unknown
): StorageInventoryReport {
  const report = validateStorageInventoryReport(value);
  const input = canonicalizeStorageInventoryReportInput({
    generatedAt: report.generatedAt,
    scope: report.scope,
    sources: report.sources,
    providers: report.providers,
    relations: report.relations,
    findings: report.findings,
    migrationPreview: report.migrationPreview
  });
  return deepFreeze({
    schemaVersion: STORAGE_INVENTORY_SCHEMA_VERSION,
    reportId: report.reportId,
    generatedAt: input.generatedAt,
    snapshotFingerprint: report.snapshotFingerprint,
    contentPolicy: STORAGE_INVENTORY_CONTENT_POLICY,
    safetyReceipt: STORAGE_INVENTORY_SAFETY_RECEIPT,
    scope: input.scope,
    sources: input.sources,
    providers: input.providers,
    relations: input.relations,
    findings: input.findings,
    migrationPreview: input.migrationPreview
  });
}

function reportInputFromUnknown(value: unknown): StorageInventoryReportInput {
  if (
    value
    && typeof value === "object"
    && Object.prototype.hasOwnProperty.call(value, "schemaVersion")
  ) {
    const report = validateStorageInventoryReport(value);
    return canonicalizeStorageInventoryReportInput({
      generatedAt: report.generatedAt,
      scope: report.scope,
      sources: report.sources,
      providers: report.providers,
      relations: report.relations,
      findings: report.findings,
      migrationPreview: report.migrationPreview
    });
  }
  return canonicalizeStorageInventoryReportInput(value);
}

function fingerprintCanonicalInput(input: StorageInventoryReportInput): string {
  const snapshot = {
    schemaVersion: STORAGE_INVENTORY_SCHEMA_VERSION,
    scope: input.scope,
    sources: input.sources,
    providers: input.providers,
    relations: input.relations,
    findings: input.findings,
    migrationPreview: input.migrationPreview
  };
  return `sha256:${createHash("sha256")
    .update(stableJson(snapshot), "utf8")
    .digest("hex")}`;
}

function assertReportFingerprint(report: StorageInventoryReport): void {
  const expected = storageInventorySnapshotFingerprint(report);
  if (report.snapshotFingerprint !== expected) {
    throw new StorageInventoryContractError(
      "fingerprint-mismatch",
      "snapshotFingerprint 与 canonical metadata snapshot 不匹配"
    );
  }
}

function canonicalSource(source: StorageInventorySource): StorageInventorySource {
  return {
    sourceId: source.sourceId,
    status: source.status,
    schemaVersion: source.schemaVersion,
    recordCount: source.recordCount,
    fileCount: source.fileCount,
    byteCount: source.byteCount,
    timeRange: {
      oldestAt: source.timeRange.oldestAt,
      newestAt: source.timeRange.newestAt
    },
    missingCount: source.missingCount,
    corruptCount: source.corruptCount,
    futureSchemaCount: source.futureSchemaCount,
    generation: source.generation,
    ...(source.metrics
      ? {
        metrics: source.metrics
          .map(canonicalMetric)
          .sort((left, right) =>
            compareText(left.name, right.name) || left.value - right.value
          )
      }
      : {}),
    ...(source.statusCode ? { statusCode: source.statusCode } : {})
  };
}

function canonicalMetric(metric: StorageInventoryMetric): StorageInventoryMetric {
  return { name: metric.name, value: metric.value };
}

function canonicalProvider(
  provider: StorageInventoryProviderSnapshot
): StorageInventoryProviderSnapshot {
  return {
    providerId: provider.providerId,
    status: provider.status,
    nativeScope: provider.nativeScope,
    capabilities: {
      enumerate: provider.capabilities.enumerate,
      inspectExistence: provider.capabilities.inspectExistence,
      resume: provider.capabilities.resume,
      archive: provider.capabilities.archive,
      delete: provider.capabilities.delete
    },
    linkedCount: provider.linkedCount,
    inspectedCount: provider.inspectedCount,
    existingCount: provider.existingCount,
    missingCount: provider.missingCount,
    unownedCandidateCount: provider.unownedCandidateCount,
    ...(provider.statusCode ? { statusCode: provider.statusCode } : {})
  };
}

function canonicalRelation(
  relation: StorageInventoryRelation
): StorageInventoryRelation {
  return {
    kind: relation.kind,
    from: canonicalEntityRef(relation.from),
    to: canonicalEntityRef(relation.to),
    status: relation.status
  };
}

function canonicalEntityRef(ref: StorageInventoryEntityRef): StorageInventoryEntityRef {
  return {
    sourceId: ref.sourceId,
    entityType: ref.entityType,
    ref: ref.ref
  };
}

function canonicalFinding(
  finding: StorageInventoryFinding
): StorageInventoryFinding {
  return {
    findingId: finding.findingId,
    category: finding.category,
    code: finding.code,
    severity: finding.severity,
    sourceId: finding.sourceId,
    ...(finding.recordRef ? { recordRef: finding.recordRef } : {}),
    ...(finding.relatedRefs
      ? { relatedRefs: [...finding.relatedRefs].sort(compareText) }
      : {}),
    count: finding.count,
    ...(finding.metadata
      ? {
        metadata: finding.metadata
          .map(canonicalFindingMetadata)
          .sort((left, right) =>
            compareText(left.name, right.name)
            || compareMetadataScalar(left.value, right.value)
          )
      }
      : {}),
    blocksMigration: finding.blocksMigration,
    automaticActionAllowed: false
  };
}

function canonicalFindingMetadata(
  metadata: StorageInventoryFindingMetadata
): StorageInventoryFindingMetadata {
  return { name: metadata.name, value: metadata.value };
}

function compareRelations(
  left: StorageInventoryRelation,
  right: StorageInventoryRelation
): number {
  return compareText(left.kind, right.kind)
    || compareEntityRefs(left.from, right.from)
    || compareEntityRefs(left.to, right.to)
    || compareText(left.status, right.status);
}

function compareEntityRefs(
  left: StorageInventoryEntityRef,
  right: StorageInventoryEntityRef
): number {
  return compareText(left.sourceId, right.sourceId)
    || compareText(left.entityType, right.entityType)
    || compareText(left.ref, right.ref);
}

function compareFindings(
  left: StorageInventoryFinding,
  right: StorageInventoryFinding
): number {
  return (SEVERITY_ORDER.get(left.severity) ?? Number.MAX_SAFE_INTEGER)
    - (SEVERITY_ORDER.get(right.severity) ?? Number.MAX_SAFE_INTEGER)
    || compareText(left.category, right.category)
    || compareText(left.code, right.code)
    || compareText(left.sourceId, right.sourceId)
    || compareText(left.recordRef ?? "", right.recordRef ?? "")
    || compareText(left.findingId, right.findingId);
}

function compareMetadataScalar(
  left: number | boolean | null,
  right: number | boolean | null
): number {
  return compareText(String(left), String(right));
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function aggregateStatuses(
  rows: readonly { readonly status: string }[]
): string {
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.status, (counts.get(row.status) ?? 0) + 1);
  return [...counts.entries()]
    .sort(([left], [right]) => compareText(left, right))
    .map(([status, count]) => `${status}=${count}`)
    .join(", ");
}

function aggregateRelations(relations: readonly StorageInventoryRelation[]): Array<{
  kind: string;
  status: string;
  count: number;
}> {
  const counts = new Map<string, { kind: string; status: string; count: number }>();
  for (const relation of relations) {
    const key = `${relation.kind}\0${relation.status}`;
    const current = counts.get(key);
    if (current) current.count += 1;
    else counts.set(key, { kind: relation.kind, status: relation.status, count: 1 });
  }
  return [...counts.values()].sort((left, right) =>
    compareText(left.kind, right.kind) || compareText(left.status, right.status)
  );
}

function aggregateFindings(findings: readonly StorageInventoryFinding[]): Array<{
  severity: string;
  category: string;
  code: string;
  sourceId: string;
  findingCount: number;
  affectedCount: number;
  blocksMigration: boolean;
}> {
  const aggregates = new Map<string, {
    severity: string;
    category: string;
    code: string;
    sourceId: string;
    findingCount: number;
    affectedCount: number;
    blocksMigration: boolean;
  }>();
  for (const finding of findings) {
    const key = [
      finding.severity,
      finding.category,
      finding.code,
      finding.sourceId,
      String(finding.blocksMigration)
    ].join("\0");
    const current = aggregates.get(key);
    if (current) {
      current.findingCount += 1;
      current.affectedCount += finding.count;
    } else {
      aggregates.set(key, {
        severity: finding.severity,
        category: finding.category,
        code: finding.code,
        sourceId: finding.sourceId,
        findingCount: 1,
        affectedCount: finding.count,
        blocksMigration: finding.blocksMigration
      });
    }
  }
  return [...aggregates.values()].sort((left, right) =>
    (SEVERITY_ORDER.get(left.severity) ?? Number.MAX_SAFE_INTEGER)
      - (SEVERITY_ORDER.get(right.severity) ?? Number.MAX_SAFE_INTEGER)
    || compareText(left.category, right.category)
    || compareText(left.code, right.code)
    || compareText(left.sourceId, right.sourceId)
  );
}

function formatStatus(status: string, statusCode?: string): string {
  return statusCode ? `${status} (\`${statusCode}\`)` : status;
}

function formatNullable(value: string | null): string {
  return value === null ? "—" : `\`${value}\``;
}

function formatTimestamp(value: number | null): string {
  return value === null ? "—" : `\`${new Date(value).toISOString()}\``;
}

function formatMetrics(metrics: readonly StorageInventoryMetric[] | undefined): string {
  if (!metrics?.length) return "—";
  return metrics.map((metric) => `\`${metric.name}=${metric.value}\``).join(", ");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort(compareText)
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sortObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortObjectKeys);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort(compareText)
        .map((key) => [key, sortObjectKeys(record[key])])
    );
  }
  return value;
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const nested of Object.values(value as Record<string, unknown>)) {
    deepFreeze(nested);
  }
  return Object.freeze(value);
}
