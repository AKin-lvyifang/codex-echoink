import { execFile } from "node:child_process";
import { homedir } from "node:os";
import * as path from "node:path";
import type { NativeExecutionRecord } from "../contracts/native-execution";
import {
  createStorageInventoryOpaqueRef,
  type StorageInventoryFinding,
  type StorageInventoryProviderSnapshot,
  type StorageInventoryRelation
} from "./storage-inventory-contract";

export type NativeProviderId = "codex" | "opencode" | "hermes";
export type NativeInventoryScope = "none" | "linked" | "vault";
export type NativeProviderCapabilityState = "supported" | "unsupported" | "unknown";
export type NativeProviderProbeStatus =
  | "scanned"
  | "partial"
  | "unsupported"
  | "unavailable"
  | "error";

export interface NativeProviderProbeInput {
  backendId: NativeProviderId;
  scope: Exclude<NativeInventoryScope, "none">;
  linkedIds: readonly string[];
  vaultPath: string;
}

/**
 * Metadata only. A probe must never return prompts, messages, tool payloads,
 * credentials, or other provider-owned bodies.
 */
export interface NativeProviderRecordMetadata {
  id: string;
  kind?: "thread" | "session" | "run" | "process";
  exists?: boolean | "unknown";
  cwd?: string;
  createdAt?: number;
  updatedAt?: number;
}

export interface NativeProviderProbeResult {
  status: NativeProviderProbeStatus;
  capabilities?: Partial<{
    enumerate: NativeProviderCapabilityState;
    inspectExistence: NativeProviderCapabilityState;
    resume: NativeProviderCapabilityState;
    archive: NativeProviderCapabilityState;
    delete: NativeProviderCapabilityState;
  }>;
  records?: readonly NativeProviderRecordMetadata[];
  /**
   * True only when every requested linked ID was checked. Without this receipt,
   * an omitted ID remains unknown rather than being reported as missing.
   */
  completeLinkedInspection?: boolean;
  statusCode?: string;
}

export type NativeProviderProbe = (
  input: NativeProviderProbeInput
) => Promise<NativeProviderProbeResult>;

export interface NativeProviderInventoryOptions {
  vaultPath: string;
  scope?: NativeInventoryScope;
  linkedRecords: readonly NativeExecutionRecord[];
  probes?: Partial<Record<NativeProviderId, NativeProviderProbe>>;
}

export interface NativeProviderInventoryResult {
  providers: StorageInventoryProviderSnapshot[];
  relations: StorageInventoryRelation[];
  findings: StorageInventoryFinding[];
}

/**
 * Injectable executor used by local SQLite probes. Arguments are always passed
 * directly to `execFile`; no shell or command string is involved.
 */
export type ReadOnlySqliteExecutor = (
  executable: string,
  args: readonly string[]
) => Promise<string>;

export interface LocalNativeProviderProbeOptions {
  sqliteExecutable?: string;
  databasePaths?: Partial<Record<NativeProviderId, string>>;
  executeSqlite?: ReadOnlySqliteExecutor;
  maxVaultRecords?: number;
}

interface LocalProviderSqlSpec {
  databasePath: string;
  table: "threads" | "session" | "sessions";
  cwdColumn: "cwd" | "directory";
  createdColumn: "created_at" | "time_created" | "started_at";
  updatedColumn: "updated_at" | "time_updated" | "ended_at";
  kind: NativeProviderRecordMetadata["kind"];
  completeLinkedInspection: boolean;
  timestampUnit: "seconds" | "milliseconds";
  capabilities: StorageInventoryProviderSnapshot["capabilities"];
}

/**
 * Creates real local metadata probes for the installed Codex, OpenCode, and
 * Hermes stores. Queries select only ID, cwd/directory, and timestamps.
 * Provider titles, previews, prompts, messages, summaries, model
 * configuration, and other bodies are never selected.
 */
export function createLocalNativeProviderProbes(
  options: LocalNativeProviderProbeOptions = {}
): Record<NativeProviderId, NativeProviderProbe> {
  const userHome = homedir();
  const databasePaths: Record<NativeProviderId, string> = {
    codex: options.databasePaths?.codex
      ?? path.join(userHome, ".codex", "state_5.sqlite"),
    opencode: options.databasePaths?.opencode
      ?? path.join(userHome, ".local", "share", "opencode", "opencode.db"),
    hermes: options.databasePaths?.hermes
      ?? path.join(userHome, ".hermes", "state.db")
  };
  const sqliteExecutable = options.sqliteExecutable ?? "/usr/bin/sqlite3";
  const executeSqlite = options.executeSqlite ?? executeReadOnlySqlite;
  const maxVaultRecords = Math.max(
    1,
    Math.min(50_000, Math.round(options.maxVaultRecords ?? 10_000))
  );
  const specs: Record<NativeProviderId, LocalProviderSqlSpec> = {
    codex: {
      databasePath: databasePaths.codex,
      table: "threads",
      cwdColumn: "cwd",
      createdColumn: "created_at",
      updatedColumn: "updated_at",
      kind: "thread",
      completeLinkedInspection: false,
      timestampUnit: "seconds",
      capabilities: {
        enumerate: "supported",
        inspectExistence: "supported",
        resume: "supported",
        archive: "supported",
        delete: "unsupported"
      }
    },
    opencode: {
      databasePath: databasePaths.opencode,
      table: "session",
      cwdColumn: "directory",
      createdColumn: "time_created",
      updatedColumn: "time_updated",
      kind: "session",
      completeLinkedInspection: false,
      timestampUnit: "milliseconds",
      capabilities: {
        enumerate: "supported",
        inspectExistence: "supported",
        resume: "supported",
        archive: "unknown",
        delete: "supported"
      }
    },
    hermes: {
      databasePath: databasePaths.hermes,
      table: "sessions",
      cwdColumn: "cwd",
      createdColumn: "started_at",
      updatedColumn: "ended_at",
      kind: "session",
      // A local provider database can prove a positive ID match, but the probe
      // input does not carry enough device/endpoint context to prove that an
      // omitted linked ref is missing. Hermes also records EchoInk refs as runs
      // while this database enumerates sessions.
      completeLinkedInspection: false,
      timestampUnit: "seconds",
      capabilities: {
        enumerate: "supported",
        inspectExistence: "supported",
        resume: "unknown",
        archive: "unknown",
        delete: "unknown"
      }
    }
  };
  return Object.fromEntries(PROVIDERS.map((providerId) => [
    providerId,
    async (input: NativeProviderProbeInput) => probeLocalProviderSqlite({
      input,
      spec: specs[providerId],
      sqliteExecutable,
      executeSqlite,
      maxVaultRecords
    })
  ])) as unknown as Record<NativeProviderId, NativeProviderProbe>;
}

async function executeReadOnlySqlite(
  executable: string,
  args: readonly string[]
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      [...args],
      {
        encoding: "utf8",
        maxBuffer: 8 * 1024 * 1024,
        timeout: 10_000,
        windowsHide: true
      },
      (error, stdout) => {
        if (error) {
          reject(error instanceof Error ? error : new Error("sqlite-exec-failed"));
          return;
        }
        resolve(stdout);
      }
    );
  });
}

async function probeLocalProviderSqlite(options: {
  input: NativeProviderProbeInput;
  spec: LocalProviderSqlSpec;
  sqliteExecutable: string;
  executeSqlite: ReadOnlySqliteExecutor;
  maxVaultRecords: number;
}): Promise<NativeProviderProbeResult> {
  const { input, spec } = options;
  const invalidLinkedIds = input.linkedIds.filter((id) => !isStrictNativeIdentifier(id));
  const linkedIds = [...new Set(input.linkedIds.filter(isStrictNativeIdentifier))];
  const select = localProviderSelect(spec);
  const linkedWhere = linkedIds.length
    ? `id IN (${linkedIds.map(sqlStringLiteral).join(",")})`
    : "0";
  let linkedRows: NativeProviderRecordMetadata[];
  try {
    linkedRows = normalizeLocalSqlRows(
      await runReadOnlySqliteQuery(
        options.sqliteExecutable,
        options.executeSqlite,
        spec.databasePath,
        `${select} WHERE ${linkedWhere} ORDER BY id;`
      ),
      spec
    );
  } catch (error) {
    return {
      status: sqliteFailureStatus(error),
      capabilities: spec.capabilities,
      records: [],
      completeLinkedInspection: false,
      statusCode: sqliteFailureStatus(error) === "unavailable"
        ? "provider-store-unavailable"
        : "provider-store-partial"
    };
  }

  let records = linkedRows;
  const matchedLinkedIds = new Set(linkedRows.map((record) => record.id));
  const linkedInspectionIncomplete = linkedIds.some((id) => !matchedLinkedIds.has(id));
  let status: NativeProviderProbeStatus = invalidLinkedIds.length || linkedInspectionIncomplete
    ? "partial"
    : "scanned";
  let statusCode = invalidLinkedIds.length
    ? "invalid-linked-id"
    : linkedInspectionIncomplete
      ? "provider-linked-inspection-incomplete"
      : undefined;
  if (input.scope === "vault") {
    const vault = path.resolve(input.vaultPath);
    const prefix = vault.endsWith(path.sep) ? vault : `${vault}${path.sep}`;
    const vaultWhere = `(${spec.cwdColumn} = ${sqlStringLiteral(vault)} OR substr(${spec.cwdColumn},1,length(${sqlStringLiteral(prefix)})) = ${sqlStringLiteral(prefix)})`;
    try {
      const vaultRows = normalizeLocalSqlRows(
        await runReadOnlySqliteQuery(
          options.sqliteExecutable,
          options.executeSqlite,
          spec.databasePath,
          `${select} WHERE ${vaultWhere} ORDER BY id LIMIT ${options.maxVaultRecords};`
        ),
        spec
      );
      const byId = new Map(records.map((record) => [record.id, record]));
      for (const record of vaultRows) byId.set(record.id, record);
      records = [...byId.values()];
      if (vaultRows.length >= options.maxVaultRecords) {
        status = "partial";
        statusCode = "provider-vault-result-truncated";
      }
    } catch {
      // Preserve the linked-query evidence; only vault enumeration degraded.
      status = "partial";
      statusCode = "provider-vault-enumeration-partial";
    }
  }
  return {
    status,
    capabilities: spec.capabilities,
    records,
    completeLinkedInspection:
      spec.completeLinkedInspection && invalidLinkedIds.length === 0,
    ...(statusCode ? { statusCode } : {})
  };
}

async function runReadOnlySqliteQuery(
  executable: string,
  executeSqlite: ReadOnlySqliteExecutor,
  databasePath: string,
  sql: string
): Promise<unknown[]> {
  const stdout = await executeSqlite(executable, [
    "-readonly",
    "-json",
    path.resolve(databasePath),
    sql
  ]);
  if (!stdout.trim()) return [];
  const parsed: unknown = JSON.parse(stdout);
  if (!isUnknownArray(parsed)) throw new Error("invalid-sqlite-json");
  return parsed;
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function localProviderSelect(spec: LocalProviderSqlSpec): string {
  return [
    "SELECT id",
    `${spec.cwdColumn} AS inventory_cwd`,
    `${spec.createdColumn} AS inventory_created_at`,
    `${spec.updatedColumn} AS inventory_updated_at`
  ].join(", ") + ` FROM ${spec.table}`;
}

function normalizeLocalSqlRows(
  rows: readonly unknown[],
  spec: LocalProviderSqlSpec
): NativeProviderRecordMetadata[] {
  return rows.flatMap((value) => {
    const row = value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
    if (!row || typeof row.id !== "string" || !isStrictNativeIdentifier(row.id)) {
      return [];
    }
    const createdAt = providerTimestamp(row.inventory_created_at, spec.timestampUnit);
    const updatedAt = providerTimestamp(row.inventory_updated_at, spec.timestampUnit);
    return [{
      id: row.id,
      kind: spec.kind,
      exists: true,
      ...(typeof row.inventory_cwd === "string" && row.inventory_cwd
        ? { cwd: row.inventory_cwd }
        : {}),
      ...(createdAt !== undefined ? { createdAt } : {}),
      ...(updatedAt !== undefined ? { updatedAt } : {})
    }];
  });
}

function providerTimestamp(
  value: unknown,
  unit: LocalProviderSqlSpec["timestampUnit"]
): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  const milliseconds = unit === "seconds" ? value * 1000 : value;
  return Math.min(8_640_000_000_000_000, Math.round(milliseconds));
}

function isStrictNativeIdentifier(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value);
}

function sqlStringLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function sqliteFailureStatus(error: unknown): "partial" | "unavailable" {
  const message = error instanceof Error ? error.message : "";
  const codeValue = error && typeof error === "object" && "code" in error
    ? (error as { code?: unknown }).code
    : undefined;
  const code = typeof codeValue === "string"
    ? codeValue
    : typeof codeValue === "number"
      ? String(codeValue)
      : "";
  return code === "ENOENT" || /unable to open database|no such file/i.test(message)
    ? "unavailable"
    : "partial";
}

const PROVIDERS: readonly NativeProviderId[] = ["codex", "opencode", "hermes"];
const PROVIDER_PROBE_STATUS_CODES = new Set([
  "invalid-linked-id",
  "provider-linked-inspection-incomplete",
  "provider-probe-failed",
  "provider-probe-partial",
  "provider-probe-unavailable",
  "provider-store-partial",
  "provider-store-unavailable",
  "provider-vault-enumeration-partial",
  "provider-vault-result-truncated"
]);
const UNKNOWN_CAPABILITIES = Object.freeze({
  enumerate: "unknown",
  inspectExistence: "unknown",
  resume: "unknown",
  archive: "unknown",
  delete: "unknown"
}) satisfies StorageInventoryProviderSnapshot["capabilities"];

/**
 * Probes precisely linked provider IDs by default. Provider enumeration is
 * permitted only for the explicit `vault` scope, and even then an unlinked
 * result is merely a candidate for ownership review. It is never called an
 * orphan and never receives an automatic action.
 */
export async function scanNativeProviderInventory(
  options: NativeProviderInventoryOptions
): Promise<NativeProviderInventoryResult> {
  const scope = options.scope ?? "linked";
  const results = await Promise.all(PROVIDERS.map(async (providerId) =>
    scanProvider(providerId, scope, options)));
  return {
    providers: results.map((result) => result.provider),
    relations: results.flatMap((result) => result.relations),
    findings: results.flatMap((result) => result.findings)
  };
}

async function scanProvider(
  providerId: NativeProviderId,
  scope: NativeInventoryScope,
  options: NativeProviderInventoryOptions
): Promise<{
  provider: StorageInventoryProviderSnapshot;
  relations: StorageInventoryRelation[];
  findings: StorageInventoryFinding[];
}> {
  const linkedRecords = options.linkedRecords
    .filter((record) => providerIdForBackend(record.native.backendId) === providerId)
    .sort((left, right) => left.native.id.localeCompare(right.native.id));
  const linkedIds = [...new Set(linkedRecords.map((record) => record.native.id))];
  if (scope === "none") {
    return {
      provider: {
        providerId,
        status: "unsupported",
        nativeScope: scope,
        capabilities: { ...UNKNOWN_CAPABILITIES },
        linkedCount: linkedRecords.length,
        inspectedCount: 0,
        existingCount: 0,
        missingCount: 0,
        unownedCandidateCount: 0,
        statusCode: "native-scope-none"
      },
      relations: [],
      findings: []
    };
  }

  const probe = options.probes?.[providerId];
  if (!probe) {
    return unavailableProviderResult(
      providerId,
      scope,
      linkedRecords,
      "provider-probe-unavailable"
    );
  }

  let result: NativeProviderProbeResult;
  try {
    result = await probe({
      backendId: providerId,
      scope,
      linkedIds,
      vaultPath: options.vaultPath
    });
  } catch {
    return unavailableProviderResult(
      providerId,
      scope,
      linkedRecords,
      "provider-probe-failed"
    );
  }

  const capabilities = normalizeCapabilities(result.capabilities);
  const probeStatus = normalizeProviderProbeStatus(result.status);
  const degradedProbe = probeStatus === "partial"
    || probeStatus === "unavailable"
    || probeStatus === "error";
  let normalizedStatus = probeStatus === "error" ? "partial" : probeStatus;
  let normalizedStatusCode = degradedProbe
    ? normalizeProviderProbeStatusCode(result.statusCode) ?? "provider-probe-partial"
    : undefined;
  const safeRecords = normalizeProviderRecords(result.records ?? []);
  const recordsById = new Map<string, NativeProviderRecordMetadata[]>();
  for (const record of safeRecords) {
    const bucket = recordsById.get(record.id) ?? [];
    bucket.push(record);
    recordsById.set(record.id, bucket);
  }
  const completeLinkedInspection = result.completeLinkedInspection === true;
  const relations: StorageInventoryRelation[] = [];
  const findings: StorageInventoryFinding[] = [];
  let inspectedCount = 0;
  let existingCount = 0;
  let missingCount = 0;

  for (const linked of linkedRecords) {
    const matches = recordsById.get(linked.native.id) ?? [];
    const fromRef = nativeRecordRef(linked.id);
    const toRef = providerRecordRef(providerId, linked.native.id);
    if (matches.length > 1 && providerMetadataConflicts(matches)) {
      inspectedCount += 1;
      relations.push(nativeProviderRelation(providerId, fromRef, toRef, "ambiguous"));
      findings.push(providerFinding({
        providerId,
        code: "provider-linked-metadata-ambiguous",
        category: "ambiguous",
        severity: "warning",
        recordRef: fromRef,
        relatedRefs: [toRef],
        blocksMigration: false
      }));
      continue;
    }
    const match = matches[0];
    if (match) {
      inspectedCount += 1;
      if (match.kind && match.kind !== linked.native.kind) {
        relations.push(nativeProviderRelation(providerId, fromRef, toRef, "ambiguous"));
        findings.push(providerFinding({
          providerId,
          code: "provider-linked-kind-mismatch",
          category: "ambiguous",
          severity: "warning",
          recordRef: fromRef,
          relatedRefs: [toRef],
          blocksMigration: false
        }));
      } else if (match.exists === false) {
        missingCount += 1;
        relations.push(nativeProviderRelation(providerId, fromRef, toRef, "missing"));
        findings.push(providerFinding({
          providerId,
          code: "native-linked-missing",
          category: "missing",
          severity: "blocking",
          recordRef: fromRef,
          relatedRefs: [toRef],
          blocksMigration: true
        }));
      } else if (match.exists === "unknown") {
        relations.push(nativeProviderRelation(providerId, fromRef, toRef, "ambiguous"));
      } else {
        existingCount += 1;
        relations.push(nativeProviderRelation(providerId, fromRef, toRef, "linked"));
      }
      continue;
    }
    if (completeLinkedInspection) {
      inspectedCount += 1;
      missingCount += 1;
      relations.push(nativeProviderRelation(providerId, fromRef, toRef, "missing"));
      findings.push(providerFinding({
        providerId,
        code: "native-linked-missing",
        category: "missing",
        severity: "blocking",
        recordRef: fromRef,
        relatedRefs: [toRef],
        blocksMigration: true
      }));
    } else {
      relations.push(nativeProviderRelation(providerId, fromRef, toRef, "ambiguous"));
    }
  }

  let unownedCandidateCount = 0;
  if (scope === "vault") {
    const linkedSet = new Set(linkedIds);
    for (const record of safeRecords) {
      if (linkedSet.has(record.id) || record.exists === false) continue;
      if (!cwdBelongsToVault(record.cwd, options.vaultPath)) continue;
      unownedCandidateCount += 1;
      const candidateRef = providerRecordRef(providerId, record.id);
      findings.push(providerFinding({
        providerId,
        code: "native-unlinked-candidate",
        category: "unlinked",
        severity: "warning",
        recordRef: candidateRef,
        blocksMigration: false
      }));
      relations.push({
        kind: "provider-ownership",
        from: {
          sourceId: `provider-${providerId}`,
          entityType: "native-execution",
          ref: candidateRef
        },
        to: {
          sourceId: "native-store",
          entityType: "native-execution",
          ref: createStorageInventoryOpaqueRef("native-unowned", `${providerId}:${record.id}`)
        },
        status: "unlinked"
      });
    }
  }

  if (degradedProbe) {
    findings.push(providerFinding({
      providerId,
      code: normalizedStatusCode ?? "provider-probe-partial",
      category: "ambiguous",
      severity: "warning",
      count: Math.max(1, linkedRecords.length - existingCount - missingCount),
      blocksMigration: false
    }));
  }
  const incompleteLinkedCount = relations.filter((relation) =>
    relation.kind === "native-provider-existence"
    && relation.status === "ambiguous"
  ).length;
  if (incompleteLinkedCount > 0 && normalizedStatus === "scanned") {
    normalizedStatus = "partial";
    normalizedStatusCode = "provider-linked-inspection-incomplete";
    findings.push(providerFinding({
      providerId,
      code: normalizedStatusCode,
      category: "ambiguous",
      severity: "warning",
      count: incompleteLinkedCount,
      blocksMigration: false
    }));
  }

  return {
    provider: {
      providerId,
      status: normalizedStatus,
      nativeScope: scope,
      capabilities,
      linkedCount: linkedRecords.length,
      inspectedCount,
      existingCount,
      missingCount,
      unownedCandidateCount,
      ...(normalizedStatusCode ? { statusCode: safeToken(normalizedStatusCode) } : {})
    },
    relations,
    findings
  };
}

function unavailableProviderResult(
  providerId: NativeProviderId,
  scope: Exclude<NativeInventoryScope, "none">,
  linkedRecords: readonly NativeExecutionRecord[],
  statusCode: string
): {
  provider: StorageInventoryProviderSnapshot;
  relations: StorageInventoryRelation[];
  findings: StorageInventoryFinding[];
} {
  return {
    provider: {
      providerId,
      status: "partial",
      nativeScope: scope,
      capabilities: { ...UNKNOWN_CAPABILITIES },
      linkedCount: linkedRecords.length,
      inspectedCount: 0,
      existingCount: 0,
      missingCount: 0,
      unownedCandidateCount: 0,
      statusCode
    },
    relations: linkedRecords.map((record) =>
      nativeProviderRelation(
        providerId,
        nativeRecordRef(record.id),
        providerRecordRef(providerId, record.native.id),
        "ambiguous"
      )),
    findings: [
      providerFinding({
        providerId,
        code: statusCode,
        category: "ambiguous",
        severity: "warning",
        count: Math.max(1, linkedRecords.length),
        blocksMigration: false
      })
    ]
  };
}

function normalizeCapabilities(
  capabilities: NativeProviderProbeResult["capabilities"]
): StorageInventoryProviderSnapshot["capabilities"] {
  return {
    enumerate: normalizeCapability(capabilities?.enumerate),
    inspectExistence: normalizeCapability(capabilities?.inspectExistence),
    resume: normalizeCapability(capabilities?.resume),
    archive: normalizeCapability(capabilities?.archive),
    delete: normalizeCapability(capabilities?.delete)
  };
}

function normalizeCapability(value: unknown): NativeProviderCapabilityState {
  return value === "supported" || value === "unsupported" ? value : "unknown";
}

function normalizeProviderProbeStatus(value: unknown): NativeProviderProbeStatus {
  return value === "scanned"
    || value === "partial"
    || value === "unsupported"
    || value === "unavailable"
    || value === "error"
    ? value
    : "error";
}

function normalizeProviderProbeStatusCode(value: unknown): string | undefined {
  return typeof value === "string" && PROVIDER_PROBE_STATUS_CODES.has(value)
    ? value
    : undefined;
}

function normalizeProviderRecords(
  records: readonly NativeProviderRecordMetadata[]
): NativeProviderRecordMetadata[] {
  return records.flatMap((record) => {
    if (!record || typeof record.id !== "string" || !record.id.trim()) return [];
    return [{
      id: record.id.trim(),
      ...(record.kind ? { kind: record.kind } : {}),
      ...(record.exists === true || record.exists === false || record.exists === "unknown"
        ? { exists: record.exists }
        : {}),
      ...(typeof record.cwd === "string" ? { cwd: record.cwd } : {}),
      ...(finiteTimestamp(record.createdAt) !== undefined
        ? { createdAt: finiteTimestamp(record.createdAt) }
        : {}),
      ...(finiteTimestamp(record.updatedAt) !== undefined
        ? { updatedAt: finiteTimestamp(record.updatedAt) }
        : {})
    }];
  });
}

function providerMetadataConflicts(records: readonly NativeProviderRecordMetadata[]): boolean {
  if (records.length < 2) return false;
  const canonical = records.map((record) => JSON.stringify({
    kind: record.kind ?? null,
    exists: record.exists ?? null,
    cwd: record.cwd ? path.resolve(record.cwd) : null,
    createdAt: finiteTimestamp(record.createdAt) ?? null,
    updatedAt: finiteTimestamp(record.updatedAt) ?? null
  }));
  return new Set(canonical).size > 1;
}

function providerIdForBackend(backendId: string): NativeProviderId | null {
  if (backendId === "codex" || backendId === "codex-cli") return "codex";
  if (backendId === "opencode") return "opencode";
  if (backendId === "hermes") return "hermes";
  return null;
}

function cwdBelongsToVault(cwd: string | undefined, vaultPath: string): boolean {
  if (!cwd || !path.isAbsolute(cwd)) return false;
  const vault = path.resolve(vaultPath);
  const candidate = path.resolve(cwd);
  return candidate === vault || candidate.startsWith(`${vault}${path.sep}`);
}

function nativeProviderRelation(
  providerId: NativeProviderId,
  nativeRef: string,
  providerRef: string,
  status: StorageInventoryRelation["status"]
): StorageInventoryRelation {
  return {
    kind: "native-provider-existence",
    from: {
      sourceId: "native-store",
      entityType: "native-execution",
      ref: nativeRef
    },
    to: {
      sourceId: `provider-${providerId}`,
      entityType: "native-execution",
      ref: providerRef
    },
    status
  };
}

function providerFinding(input: {
  providerId: NativeProviderId;
  code: string;
  category: StorageInventoryFinding["category"];
  severity: StorageInventoryFinding["severity"];
  recordRef?: string;
  relatedRefs?: string[];
  count?: number;
  blocksMigration: boolean;
}): StorageInventoryFinding {
  const stableInput = [
    input.providerId,
    input.code,
    input.recordRef ?? "",
    ...(input.relatedRefs ?? [])
  ].join("|");
  return {
    findingId: createStorageInventoryOpaqueRef("finding", stableInput),
    category: input.category,
    code: safeToken(input.code),
    severity: input.severity,
    sourceId: `provider-${input.providerId}`,
    ...(input.recordRef ? { recordRef: input.recordRef } : {}),
    ...(input.relatedRefs?.length ? { relatedRefs: input.relatedRefs } : {}),
    count: input.count ?? 1,
    blocksMigration: input.blocksMigration,
    automaticActionAllowed: false
  };
}

function nativeRecordRef(recordId: string): string {
  return createStorageInventoryOpaqueRef("native-record", recordId);
}

function providerRecordRef(providerId: NativeProviderId, nativeId: string): string {
  return createStorageInventoryOpaqueRef(`provider-${providerId}`, nativeId);
}

function safeToken(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 96)
    || "unknown";
}

function finiteTimestamp(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}
