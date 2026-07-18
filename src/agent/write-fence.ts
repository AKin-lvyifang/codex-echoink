import * as path from "node:path";
import { createHash } from "node:crypto";
import type {
  AgentBackendKind,
  AgentExactWriteFenceReceipt,
  AgentTaskInput
} from "./types";

export const EXACT_WRITE_FENCE_UNAVAILABLE_CODE = "EXACT_WRITE_FENCE_UNAVAILABLE";
const issuedExactWriteFenceReceipts = new WeakSet<object>();

export class ExactWriteFenceUnavailableError extends Error {
  readonly code = EXACT_WRITE_FENCE_UNAVAILABLE_CODE;

  constructor(
    readonly backend: AgentBackendKind,
    reason: string,
    readonly receipt?: AgentExactWriteFenceReceipt,
    options?: ErrorOptions
  ) {
    super(`${EXACT_WRITE_FENCE_UNAVAILABLE_CODE}: ${backend} 无法证明精确写隔离；${reason}`, options);
    this.name = "ExactWriteFenceUnavailableError";
  }
}

export function exactWriteFenceUnavailable(
  backend: AgentBackendKind,
  reason: string,
  cause?: unknown,
  receipt?: AgentExactWriteFenceReceipt
): ExactWriteFenceUnavailableError {
  return new ExactWriteFenceUnavailableError(
    backend,
    reason,
    receipt,
    cause === undefined ? undefined : { cause }
  );
}

export function exactWriteFenceEventData(error: ExactWriteFenceUnavailableError): Record<string, unknown> {
  return {
    failureCode: error.code,
    exactWriteFence: "required",
    promptSubmitted: false,
    ...(error.receipt ? { exactWriteFenceReceipt: error.receipt } : {})
  };
}

export function assertExactWriteFenceRequest(
  backend: AgentBackendKind,
  input: AgentTaskInput,
  vaultPath: string
): void {
  if (!input.requireExactWriteFence) return;
  if (input.permission !== "workspace-write") {
    throw exactWriteFenceUnavailable(backend, "必须显式使用 workspace-write 权限。");
  }
  const normalizedVault = normalizeFencePath(vaultPath);
  const roots = Array.from(new Set((input.writableRoots ?? [])
    .map(normalizeFencePath)
    .filter(Boolean)));
  if (!normalizedVault || !isAbsoluteFencePath(normalizedVault) || roots.length === 0) {
    throw exactWriteFenceUnavailable(backend, "缺少 Vault 路径或精确 writableRoots。");
  }
  if (roots.some((root) =>
    !isAbsoluteFencePath(root)
    || root === normalizedVault
    || !isStrictDescendant(root, normalizedVault)
  )) {
    throw exactWriteFenceUnavailable(backend, "writableRoots 必须全部是当前隔离 Vault 内的精确子目录，不能包含 Vault 根或外部路径。");
  }
  const context = input.exactWriteFence;
  if (!context?.attemptToken.trim() || !context.leaseToken.trim()) {
    throw exactWriteFenceUnavailable(backend, "缺少 attemptToken 或 leaseToken，无法签发同一 lease 的配置回执。");
  }
  const deniedLivePaths = canonicalFencePaths(context.deniedLivePaths);
  const deniedControlPaths = canonicalFencePaths(context.deniedControlPaths);
  if (!deniedLivePaths.length || !deniedControlPaths.length) {
    throw exactWriteFenceUnavailable(backend, "缺少真实 Vault 或 Shadow control-plane 的拒写路径。");
  }
  const deniedPaths = [...deniedLivePaths, ...deniedControlPaths];
  if (deniedPaths.some((deniedPath) =>
    !isAbsoluteFencePath(deniedPath)
    || roots.some((root) => deniedPath === root || isStrictDescendant(deniedPath, root))
  )) {
    throw exactWriteFenceUnavailable(backend, "拒写路径必须是绝对路径，且不能落入任何 writableRoot。");
  }
}

export function createExactWriteFenceReceipt(input: {
  backend: AgentBackendKind;
  task: AgentTaskInput;
  transport: string;
  transportAck: Record<string, unknown>;
  configuredAt?: string;
}): AgentExactWriteFenceReceipt {
  if (!input.task.requireExactWriteFence || !input.task.exactWriteFence) {
    throw exactWriteFenceUnavailable(input.backend, "缺少精确写隔离请求上下文，不能签发配置回执。");
  }
  const receiptWithoutDigest = {
    version: 1 as const,
    backend: input.backend,
    attemptToken: input.task.exactWriteFence.attemptToken.trim(),
    leaseToken: input.task.exactWriteFence.leaseToken.trim(),
    enforcedWritableRoots: canonicalFencePaths(input.task.writableRoots ?? []),
    deniedLivePaths: canonicalFencePaths(input.task.exactWriteFence.deniedLivePaths),
    deniedControlPaths: canonicalFencePaths(input.task.exactWriteFence.deniedControlPaths),
    transport: input.transport.trim(),
    configuredAt: input.configuredAt ?? new Date().toISOString()
  };
  if (!receiptWithoutDigest.transport) {
    throw exactWriteFenceUnavailable(input.backend, "transport 标识为空，不能签发配置回执。");
  }
  const configAckDigest = createHash("sha256")
    .update(stableJson({
      ...receiptWithoutDigest,
      transportAck: canonicalJsonValue(input.transportAck)
    }))
    .digest("hex");
  const receipt: AgentExactWriteFenceReceipt = Object.freeze({
    ...receiptWithoutDigest,
    enforcedWritableRoots: Object.freeze([...receiptWithoutDigest.enforcedWritableRoots]),
    deniedLivePaths: Object.freeze([...receiptWithoutDigest.deniedLivePaths]),
    deniedControlPaths: Object.freeze([...receiptWithoutDigest.deniedControlPaths]),
    configAckDigest
  });
  issuedExactWriteFenceReceipts.add(receipt);
  return receipt;
}

export async function deliverExactWriteFenceReceipt(
  input: AgentTaskInput,
  receipt: AgentExactWriteFenceReceipt
): Promise<void> {
  const backend = receipt.backend;
  if (!isTrustedExactWriteFenceReceipt(receipt)) {
    throw exactWriteFenceUnavailable(backend, "拒绝转交非 trusted issuer 签发的配置回执。");
  }
  try {
    await input.onExactWriteFenceConfigured?.(receipt);
  } catch (error) {
    throw exactWriteFenceUnavailable(
      receipt.backend,
      `配置回执回调失败，prompt 尚未提交：${error instanceof Error ? error.message : String(error)}`,
      error,
      receipt
    );
  }
}

export function isTrustedExactWriteFenceReceipt(value: unknown): value is AgentExactWriteFenceReceipt {
  if (!value || typeof value !== "object" || !issuedExactWriteFenceReceipts.has(value)) return false;
  const receipt = value as AgentExactWriteFenceReceipt;
  return receipt.version === 1
    && (receipt.backend === "codex-cli" || receipt.backend === "opencode" || receipt.backend === "hermes")
    && Boolean(receipt.attemptToken.trim())
    && Boolean(receipt.leaseToken.trim())
    && receipt.enforcedWritableRoots.length > 0
    && receipt.deniedLivePaths.length > 0
    && receipt.deniedControlPaths.length > 0
    && Boolean(receipt.transport.trim())
    && /^[a-f0-9]{64}$/.test(receipt.configAckDigest)
    && !Number.isNaN(Date.parse(receipt.configuredAt));
}

function normalizeFencePath(value: string): string {
  const slashNormalized = value.trim().replace(/\\/g, "/").replace(/\/+/g, "/");
  if (!slashNormalized) return "";
  if (/^[A-Za-z]:\//.test(slashNormalized)) {
    const win32Normalized = path.win32.normalize(slashNormalized.replace(/\//g, "\\")).replace(/\\/g, "/");
    return `${win32Normalized.slice(0, 1).toLowerCase()}${win32Normalized.slice(1)}`.replace(/\/+$/, "");
  }
  return path.posix.normalize(slashNormalized).replace(/\/+$/, "") || "/";
}

function isAbsoluteFencePath(value: string): boolean {
  return value.startsWith("/") || /^[a-z]:\//.test(value);
}

function isStrictDescendant(candidate: string, parent: string): boolean {
  const caseInsensitive = /^[a-z]:\//.test(parent);
  const normalizedCandidate = caseInsensitive ? candidate.toLowerCase() : candidate;
  const normalizedParent = caseInsensitive ? parent.toLowerCase() : parent;
  return normalizedCandidate.startsWith(`${normalizedParent}/`);
}

function canonicalFencePaths(values: readonly string[]): string[] {
  return Array.from(new Set(values.map(normalizeFencePath).filter(Boolean))).sort();
}

function stableJson(value: unknown): string {
  return JSON.stringify(canonicalJsonValue(value));
}

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalJsonValue(item)])
  );
}
