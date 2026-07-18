import { createHash } from "node:crypto";
import * as path from "node:path";

export const HERMES_MAINTENANCE_PROPOSAL_VERSION = 1 as const;
export const HERMES_MAINTENANCE_PROPOSAL_ALLOWED_ROOTS = Object.freeze([
  "wiki",
  "projects",
  "outputs",
  "inbox"
] as const);

export interface HermesMaintenanceProposalLimits {
  maxOutputBytes: number;
  maxOperations: number;
  maxSourcesPerOperation: number;
  maxFileBytes: number;
  maxTotalContentBytes: number;
}

export const DEFAULT_HERMES_MAINTENANCE_PROPOSAL_LIMITS:
Readonly<HermesMaintenanceProposalLimits> = Object.freeze({
  maxOutputBytes: 24 * 1024 * 1024,
  maxOperations: 256,
  maxSourcesPerOperation: 64,
  maxFileBytes: 2 * 1024 * 1024,
  maxTotalContentBytes: 16 * 1024 * 1024
});

export interface HermesMaintenanceProposalSourceV1 {
  path: string;
  sha256: string;
}

export interface HermesMaintenanceProposalUpsertV1 {
  op: "upsert";
  path: string;
  content: string;
  sources: readonly HermesMaintenanceProposalSourceV1[];
  baseSha256: string | null;
}

export interface HermesMaintenanceProposalV1 {
  version: typeof HERMES_MAINTENANCE_PROPOSAL_VERSION;
  attemptId: string;
  operations: readonly HermesMaintenanceProposalUpsertV1[];
}

export type HermesProposalOperationRejectionCode =
  | "invalid_operation"
  | "invalid_path"
  | "path_denied"
  | "duplicate_path"
  | "invalid_content"
  | "file_too_large"
  | "invalid_sources"
  | "source_changed"
  | "target_changed"
  | "total_too_large";

export interface HermesProposalOperationRejection {
  index: number;
  code: HermesProposalOperationRejectionCode;
  message: string;
  path?: string;
}

export interface ValidatedHermesMaintenanceProposal {
  readonly version: typeof HERMES_MAINTENANCE_PROPOSAL_VERSION;
  readonly attemptId: string;
  readonly operations: readonly HermesMaintenanceProposalUpsertV1[];
  readonly rejectedOperations: readonly HermesProposalOperationRejection[];
  readonly digest: string;
  readonly outcome: "committable" | "partial" | "noop" | "invalid";
}

export interface HermesProposalValidationContext {
  attemptId: string;
  sourceFingerprints: ReadonlyMap<string, string> | Readonly<Record<string, string>>;
  targetFingerprints: ReadonlyMap<string, string | null> | Readonly<Record<string, string | null>>;
  allowedRoots?: readonly string[];
  limits?: Partial<HermesMaintenanceProposalLimits>;
}

export interface HermesProposalValidationSnapshot {
  readonly attemptId: string;
  readonly sourceFingerprints: readonly (readonly [string, string])[];
  readonly targetFingerprints: readonly (readonly [string, string | null])[];
  readonly allowedRoots: readonly string[];
  readonly limits: Readonly<HermesMaintenanceProposalLimits>;
}

export type HermesProposalContractErrorCode =
  | "malformed_json"
  | "invalid_envelope"
  | "attempt_mismatch"
  | "limit_exceeded";

export class HermesProposalContractError extends Error {
  constructor(
    public readonly code: HermesProposalContractErrorCode,
    message: string
  ) {
    super(message);
    this.name = "HermesProposalContractError";
  }
}

/**
 * Captures the exact host-owned validation baseline used both to bind a
 * proposal lease and to validate the eventual Hermes output. Callers must not
 * digest a mutable Map/record directly because it could change between lease
 * issuance and proposal parsing.
 */
export function createHermesProposalValidationSnapshot(
  context: HermesProposalValidationContext
): HermesProposalValidationSnapshot {
  const attemptId = typeof context.attemptId === "string" ? context.attemptId : "";
  if (
    !attemptId
    || attemptId !== attemptId.trim()
    || /[\u0000-\u001f\u007f]/.test(attemptId)
  ) {
    throw new HermesProposalContractError(
      "invalid_envelope",
      "Hermes proposal validation attemptId 非法"
    );
  }
  const sourceFingerprints = [...canonicalFingerprintMap(context.sourceFingerprints, false).entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([relativePath, fingerprint]) => {
      if (fingerprint === null) {
        throw new HermesProposalContractError(
          "invalid_envelope",
          `来源 fingerprint 不能为空：${relativePath}`
        );
      }
      return Object.freeze([relativePath, fingerprint] as const);
    });
  const targetFingerprints = [...canonicalFingerprintMap(context.targetFingerprints, true).entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([relativePath, fingerprint]) =>
      Object.freeze([relativePath, fingerprint] as const)
    );
  const allowedRoots = [...new Set(
    (context.allowedRoots ?? HERMES_MAINTENANCE_PROPOSAL_ALLOWED_ROOTS)
      .map((root) => normalizeAllowedRoot(root))
  )].sort();
  return deepFreeze({
    attemptId,
    sourceFingerprints,
    targetFingerprints,
    allowedRoots,
    limits: normalizeLimits(context.limits)
  });
}

const PROPOSAL_SCHEMA_DESCRIPTOR = deepFreeze({
  version: 1,
  envelope: {
    version: "literal:1",
    attemptId: "non-empty string",
    operations: "array"
  },
  operation: {
    op: "literal:upsert",
    path: "relative markdown path under wiki/projects/outputs/inbox",
    content: "utf8 string",
    sources: [{ path: "raw-relative path", sha256: "sha256:<64 lowercase hex>" }],
    baseSha256: "sha256:<64 lowercase hex> | null"
  },
  semantics: {
    delete: "forbidden",
    move: "forbidden",
    pluginOwnedPaths: "forbidden",
    sourceAndTargetFingerprints: "required"
  }
});

export const HERMES_MAINTENANCE_PROPOSAL_SCHEMA_DIGEST =
  `sha256:${createHash("sha256").update(stableJson(PROPOSAL_SCHEMA_DESCRIPTOR)).digest("hex")}`;

const trustedValidatedProposals = new WeakSet<object>();
const FINGERPRINT_PATTERN = /^sha256:[a-f0-9]{64}$/;
const WINDOWS_ABSOLUTE_PATTERN = /^[a-zA-Z]:[\\/]/;
const DENIED_EXACT_PATHS = new Set([
  "outputs/.ingest-tracker.md"
]);
const DENIED_PATH_SEGMENTS = new Set([
  ".echoink",
  ".git",
  ".obsidian"
]);

export function parseAndValidateHermesMaintenanceProposal(
  rawOutput: string,
  context: HermesProposalValidationContext
): ValidatedHermesMaintenanceProposal {
  const validation = createHermesProposalValidationSnapshot(context);
  const limits = validation.limits;
  const outputBytes = Buffer.byteLength(rawOutput, "utf8");
  if (outputBytes > limits.maxOutputBytes) {
    throw new HermesProposalContractError(
      "limit_exceeded",
      `Hermes proposal 输出 ${outputBytes} bytes，超过 ${limits.maxOutputBytes} bytes 上限`
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawOutput);
  } catch (error) {
    throw new HermesProposalContractError(
      "malformed_json",
      `Hermes proposal 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (!isPlainObject(parsed)) {
    throw new HermesProposalContractError("invalid_envelope", "Hermes proposal 顶层必须是 JSON object");
  }
  if (parsed.version !== HERMES_MAINTENANCE_PROPOSAL_VERSION) {
    throw new HermesProposalContractError(
      "invalid_envelope",
      `Hermes proposal version 必须为 ${HERMES_MAINTENANCE_PROPOSAL_VERSION}`
    );
  }
  if (typeof parsed.attemptId !== "string" || !parsed.attemptId.trim()) {
    throw new HermesProposalContractError("invalid_envelope", "Hermes proposal 缺少 attemptId");
  }
  if (parsed.attemptId !== validation.attemptId) {
    throw new HermesProposalContractError(
      "attempt_mismatch",
      `Hermes proposal attemptId 不匹配：${parsed.attemptId}`
    );
  }
  if (!Array.isArray(parsed.operations)) {
    throw new HermesProposalContractError("invalid_envelope", "Hermes proposal operations 必须是 array");
  }
  if (parsed.operations.length > limits.maxOperations) {
    throw new HermesProposalContractError(
      "limit_exceeded",
      `Hermes proposal 含 ${parsed.operations.length} 个 operations，超过 ${limits.maxOperations} 个上限`
    );
  }

  const allowedRoots = new Set(validation.allowedRoots);
  const sourceFingerprints = new Map(validation.sourceFingerprints);
  const targetFingerprints = new Map(validation.targetFingerprints);
  const duplicates = duplicateOperationPaths(parsed.operations);
  const operations: HermesMaintenanceProposalUpsertV1[] = [];
  const rejectedOperations: HermesProposalOperationRejection[] = [];
  let totalContentBytes = 0;

  for (const [index, candidate] of parsed.operations.entries()) {
    try {
      const operation = validateOperation(candidate, {
        index,
        allowedRoots,
        duplicates,
        sourceFingerprints,
        targetFingerprints,
        limits
      });
      const contentBytes = Buffer.byteLength(operation.content, "utf8");
      if (totalContentBytes + contentBytes > limits.maxTotalContentBytes) {
        throw operationError(
          "total_too_large",
          `proposal 有效正文累计超过 ${limits.maxTotalContentBytes} bytes`,
          operation.path
        );
      }
      totalContentBytes += contentBytes;
      operations.push(operation);
    } catch (error) {
      if (error instanceof OperationValidationError) {
        rejectedOperations.push(Object.freeze({
          index,
          code: error.code,
          message: error.message,
          ...(error.relativePath ? { path: error.relativePath } : {})
        }));
        continue;
      }
      throw error;
    }
  }

  const outcome = operations.length === 0
    ? (parsed.operations.length === 0 ? "noop" : "invalid")
    : (rejectedOperations.length > 0 ? "partial" : "committable");
  const digest = `sha256:${createHash("sha256").update(stableJson({
    version: 1,
    attemptId: validation.attemptId,
    operations,
    rejectedOperations
  })).digest("hex")}`;
  const validated: ValidatedHermesMaintenanceProposal = Object.freeze({
    version: HERMES_MAINTENANCE_PROPOSAL_VERSION,
    attemptId: validation.attemptId,
    operations: Object.freeze(operations.map(freezeOperation)),
    rejectedOperations: Object.freeze([...rejectedOperations]),
    digest,
    outcome
  });
  trustedValidatedProposals.add(validated);
  return validated;
}

export function isTrustedValidatedHermesMaintenanceProposal(
  value: unknown
): value is ValidatedHermesMaintenanceProposal {
  if (!value || typeof value !== "object" || !trustedValidatedProposals.has(value)) return false;
  const proposal = value as ValidatedHermesMaintenanceProposal;
  return proposal.version === 1
    && Boolean(proposal.attemptId.trim())
    && FINGERPRINT_PATTERN.test(proposal.digest)
    && Object.isFrozen(proposal)
    && Object.isFrozen(proposal.operations)
    && Object.isFrozen(proposal.rejectedOperations);
}

export function hermesMaintenanceProposalJsonSchema(): Readonly<Record<string, unknown>> {
  return PROPOSAL_SCHEMA_DESCRIPTOR;
}

interface OperationValidationInput {
  index: number;
  allowedRoots: ReadonlySet<string>;
  duplicates: ReadonlySet<string>;
  sourceFingerprints: ReadonlyMap<string, string | null>;
  targetFingerprints: ReadonlyMap<string, string | null>;
  limits: HermesMaintenanceProposalLimits;
}

class OperationValidationError extends Error {
  constructor(
    public readonly code: HermesProposalOperationRejectionCode,
    message: string,
    public readonly relativePath?: string
  ) {
    super(message);
    this.name = "OperationValidationError";
  }
}

function operationError(
  code: HermesProposalOperationRejectionCode,
  message: string,
  relativePath?: string
): OperationValidationError {
  return new OperationValidationError(code, message, relativePath);
}

function validateOperation(
  candidate: unknown,
  input: OperationValidationInput
): HermesMaintenanceProposalUpsertV1 {
  if (!isPlainObject(candidate) || candidate.op !== "upsert") {
    throw operationError("invalid_operation", "v1 只允许 op=upsert");
  }
  const relativePath = validateProposalPath(candidate.path, input.allowedRoots);
  if (input.duplicates.has(relativePath.toLowerCase())) {
    throw operationError("duplicate_path", `重复目标路径：${relativePath}`, relativePath);
  }
  if (typeof candidate.content !== "string" || candidate.content.includes("\0")) {
    throw operationError("invalid_content", `正文必须是无 NUL 的 string：${relativePath}`, relativePath);
  }
  const contentBytes = Buffer.byteLength(candidate.content, "utf8");
  if (contentBytes > input.limits.maxFileBytes) {
    throw operationError(
      "file_too_large",
      `${relativePath} 为 ${contentBytes} bytes，超过 ${input.limits.maxFileBytes} bytes`,
      relativePath
    );
  }
  if (candidate.baseSha256 !== null && !isFingerprint(candidate.baseSha256)) {
    throw operationError("target_changed", `baseSha256 非法：${relativePath}`, relativePath);
  }
  const hostRecordedTarget = input.targetFingerprints.has(relativePath);
  if (hostRecordedTarget && input.targetFingerprints.get(relativePath) !== candidate.baseSha256) {
    throw operationError("target_changed", `目标基线已变化：${relativePath}`, relativePath);
  }
  if (!hostRecordedTarget && candidate.baseSha256 !== null) {
    throw operationError(
      "target_changed",
      `新目标必须声明 baseSha256=null：${relativePath}`,
      relativePath
    );
  }
  if (!Array.isArray(candidate.sources)
    || candidate.sources.length === 0
    || candidate.sources.length > input.limits.maxSourcesPerOperation) {
    throw operationError(
      "invalid_sources",
      `${relativePath} 的 sources 必须为 1-${input.limits.maxSourcesPerOperation} 项`,
      relativePath
    );
  }
  const seenSources = new Set<string>();
  const sources: HermesMaintenanceProposalSourceV1[] = [];
  for (const source of candidate.sources) {
    if (!isPlainObject(source) || !isFingerprint(source.sha256)) {
      throw operationError("invalid_sources", `来源 fingerprint 非法：${relativePath}`, relativePath);
    }
    const sourcePath = validateSourcePath(source.path);
    const sourceKey = sourcePath.toLowerCase();
    if (seenSources.has(sourceKey)) {
      throw operationError("invalid_sources", `重复来源：${sourcePath}`, relativePath);
    }
    seenSources.add(sourceKey);
    if (input.sourceFingerprints.get(sourcePath) !== source.sha256) {
      throw operationError("source_changed", `来源基线已变化：${sourcePath}`, relativePath);
    }
    sources.push(Object.freeze({ path: sourcePath, sha256: source.sha256 }));
  }
  return {
    op: "upsert",
    path: relativePath,
    content: candidate.content,
    sources,
    baseSha256: candidate.baseSha256
  };
}

function validateProposalPath(value: unknown, allowedRoots: ReadonlySet<string>): string {
  const relativePath = normalizeRelativePath(value, "目标");
  const segments = relativePath.split("/");
  if (!allowedRoots.has(segments[0] ?? "")) {
    throw operationError("path_denied", `目标不在 maintenance writable roots：${relativePath}`, relativePath);
  }
  if (DENIED_EXACT_PATHS.has(relativePath)
    || segments.some((segment) => DENIED_PATH_SEGMENTS.has(segment.toLowerCase()))
    || segments.some((segment) => segment.toLowerCase() === ".ingest-tracker.md")) {
    throw operationError("path_denied", `目标属于插件托管或控制路径：${relativePath}`, relativePath);
  }
  if (!relativePath.toLowerCase().endsWith(".md")) {
    throw operationError("path_denied", `v1 只允许 Markdown upsert：${relativePath}`, relativePath);
  }
  return relativePath;
}

function validateSourcePath(value: unknown): string {
  const relativePath = normalizeRelativePath(value, "来源");
  if (relativePath !== "raw" && !relativePath.startsWith("raw/")) {
    throw operationError("invalid_sources", `来源必须位于 raw/：${relativePath}`);
  }
  return relativePath;
}

function normalizeRelativePath(value: unknown, label: string): string {
  if (typeof value !== "string"
    || !value
    || value !== value.trim()
    || value.includes("\\")
    || value.includes("\0")
    || /[\u0000-\u001f\u007f]/.test(value)
    || value.startsWith("/")
    || value.startsWith("//")
    || WINDOWS_ABSOLUTE_PATTERN.test(value)) {
    throw operationError("invalid_path", `${label}路径非法：${String(value)}`);
  }
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw operationError("invalid_path", `${label}路径含空段、. 或 ..：${value}`);
  }
  const normalized = path.posix.normalize(value);
  if (normalized !== value || normalized.startsWith("../")) {
    throw operationError("invalid_path", `${label}路径无法规范化：${value}`);
  }
  return normalized;
}

function duplicateOperationPaths(operations: readonly unknown[]): ReadonlySet<string> {
  const counts = new Map<string, number>();
  for (const operation of operations) {
    if (!isPlainObject(operation) || typeof operation.path !== "string") continue;
    try {
      const normalized = normalizeRelativePath(operation.path, "目标").toLowerCase();
      counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
    } catch {
      // The operation-level validator will report the invalid path.
    }
  }
  return new Set([...counts.entries()].filter(([, count]) => count > 1).map(([key]) => key));
}

function canonicalFingerprintMap(
  input: ReadonlyMap<string, string | null> | Readonly<Record<string, string | null>>,
  allowNull: boolean
): ReadonlyMap<string, string | null> {
  const entries = input instanceof Map ? [...input.entries()] : Object.entries(input);
  const result = new Map<string, string | null>();
  for (const [rawPath, fingerprint] of entries) {
    const relativePath = normalizeRelativePath(rawPath, "host 基线");
    if (fingerprint !== null && !isFingerprint(fingerprint)) {
      throw new HermesProposalContractError(
        "invalid_envelope",
        `host 基线 fingerprint 非法：${relativePath}`
      );
    }
    if (fingerprint === null && !allowNull) {
      throw new HermesProposalContractError(
        "invalid_envelope",
        `来源 fingerprint 不能为空：${relativePath}`
      );
    }
    result.set(relativePath, fingerprint);
  }
  return result;
}

function normalizeAllowedRoot(root: string): string {
  const normalized = normalizeRelativePath(root, "allowed root");
  if (normalized.includes("/")) {
    throw new HermesProposalContractError("invalid_envelope", `allowed root 必须为一级目录：${root}`);
  }
  if (!(HERMES_MAINTENANCE_PROPOSAL_ALLOWED_ROOTS as readonly string[]).includes(normalized)) {
    throw new HermesProposalContractError(
      "invalid_envelope",
      `allowed root 不能扩大 Hermes proposal 写入边界：${root}`
    );
  }
  return normalized;
}

function normalizeLimits(
  overrides: Partial<HermesMaintenanceProposalLimits> | undefined
): HermesMaintenanceProposalLimits {
  const result = {
    ...DEFAULT_HERMES_MAINTENANCE_PROPOSAL_LIMITS,
    ...(overrides ?? {})
  };
  for (const [name, value] of Object.entries(result)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new HermesProposalContractError("invalid_envelope", `proposal limit ${name} 必须为正整数`);
    }
  }
  return result;
}

function freezeOperation(
  operation: HermesMaintenanceProposalUpsertV1
): HermesMaintenanceProposalUpsertV1 {
  return Object.freeze({
    ...operation,
    sources: Object.freeze([...operation.sources])
  });
}

function isPlainObject(value: unknown): value is Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isFingerprint(value: unknown): value is string {
  return typeof value === "string" && FINGERPRINT_PATTERN.test(value);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) =>
      `${JSON.stringify(key)}:${stableJson(object[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) {
    return value as Readonly<T>;
  }
  for (const nested of Object.values(value as Record<string, unknown>)) {
    deepFreeze(nested);
  }
  return Object.freeze(value);
}
