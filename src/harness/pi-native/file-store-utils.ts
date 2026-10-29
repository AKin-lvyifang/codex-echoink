import { getDesktopCrypto } from "../../platform/desktop-crypto";
import { getDesktopFsPromises } from "../../platform/desktop-filesystem";
import { getDesktopPath } from "../../platform/desktop-paths";

const { createHash, randomUUID } = getDesktopCrypto();


const { mkdir, open, readFile, rename, unlink } = getDesktopFsPromises();
const path = getDesktopPath();

export const PI_NATIVE_FILE_SCHEMA_VERSION = 1 as const;

export type PiNativeFileStoreErrorCode =
  | "invalid-input"
  | "mapping-conflict"
  | "not-found"
  | "invalid-transition"
  | "store-corrupt"
  | "readback-diverged";

export class PiNativeFileStoreError extends Error {
  readonly code: PiNativeFileStoreErrorCode;

  constructor(code: PiNativeFileStoreErrorCode, message: string) {
    super(message);
    this.name = "PiNativeFileStoreError";
    this.code = code;
  }
}

export interface PiNativeVaultFileLayout {
  storageRootPath: string;
  vaultRootPath: string;
  sessionRootPath: string;
  catalogPath: string;
  productRunsRootPath: string;
  conversationBindingsRootPath: string;
  piSessionBindingsRootPath: string;
}

const writeQueues = new Map<string, Promise<void>>();

export function piNativeVaultFileLayout(
  storageRootPath: string,
  vaultId: string
): PiNativeVaultFileLayout {
  const normalizedStorageRoot = path.resolve(requireNonEmptyString(
    storageRootPath,
    "storageRootPath"
  ));
  const normalizedVaultId = requireNonEmptyString(vaultId, "vaultId");
  const vaultRootPath = path.join(
    normalizedStorageRoot,
    "vaults",
    stablePathToken(normalizedVaultId)
  );
  const bindingsRootPath = path.join(normalizedStorageRoot, "bindings");
  return {
    storageRootPath: normalizedStorageRoot,
    vaultRootPath,
    sessionRootPath: path.join(vaultRootPath, "sessions"),
    catalogPath: path.join(vaultRootPath, "conversation-catalog.v1.json"),
    productRunsRootPath: path.join(vaultRootPath, "product-runs"),
    conversationBindingsRootPath: path.join(bindingsRootPath, "conversations"),
    piSessionBindingsRootPath: path.join(bindingsRootPath, "pi-sessions")
  };
}

export async function ensurePiNativeVaultFileLayout(
  layout: PiNativeVaultFileLayout
): Promise<void> {
  await Promise.all([
    mkdir(layout.vaultRootPath, { recursive: true, mode: 0o700 }),
    mkdir(layout.sessionRootPath, { recursive: true, mode: 0o700 }),
    mkdir(layout.productRunsRootPath, { recursive: true, mode: 0o700 }),
    mkdir(layout.conversationBindingsRootPath, {
      recursive: true,
      mode: 0o700
    }),
    mkdir(layout.piSessionBindingsRootPath, {
      recursive: true,
      mode: 0o700
    })
  ]);
}

/** Serializes every read-modify-write rooted in the same Pi-native repository. */
export function serializePiNativeFileWrite<T>(
  storageRootPath: string,
  operation: () => Promise<T>
): Promise<T> {
  const key = path.resolve(storageRootPath);
  const previous = writeQueues.get(key) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(operation);
  const tail = run.then(
    () => undefined,
    () => undefined
  );
  writeQueues.set(key, tail);
  return run.finally(() => {
    if (writeQueues.get(key) === tail) writeQueues.delete(key);
  });
}

export async function readJsonFileIfPresent(
  filePath: string,
  label: string
): Promise<unknown> {
  let bytes: Buffer;
  try {
    bytes = await readFile(filePath);
  } catch (error) {
    if (isNodeErrorWithCode(error, "ENOENT")) return null;
    throw error;
  }
  try {
    return JSON.parse(bytes.toString("utf8")) as unknown;
  } catch (error) {
    throw new PiNativeFileStoreError(
      "store-corrupt",
      `${label} 不是合法 JSON：${errorMessage(error)}`
    );
  }
}

/**
 * Publishes one complete JSON document through a same-directory temporary file,
 * schema validation before publication, fsync, and atomic rename.
 */
export async function atomicWriteJsonFile<T>(
  filePath: string,
  value: unknown,
  _label: string,
  normalizeValue: (value: unknown) => T
): Promise<T> {
  const normalized = normalizeValue(value);
  const parentPath = path.dirname(filePath);
  await mkdir(parentPath, { recursive: true, mode: 0o700 });
  const bytes = Buffer.from(`${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  const temporaryPath = path.join(
    parentPath,
    `.${path.basename(filePath)}-${randomUUID()}.tmp`
  );
  let temporaryExists = false;
  try {
    const handle = await open(temporaryPath, "wx", 0o600);
    temporaryExists = true;
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, filePath);
    temporaryExists = false;
    await syncDirectory(parentPath);

    return normalized;
  } finally {
    if (temporaryExists) await unlink(temporaryPath).catch(() => undefined);
  }
}

export function stablePathToken(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function runtimeInterruptedDiagnosticId(
  conversationId: string,
  piSessionId: string,
  productRunId: string
): string {
  const namespace = "diagnostic";
  return `${namespace}-${createHash("sha256")
    .update([
      namespace,
      conversationId,
      piSessionId,
      productRunId,
      "runtime_interrupted"
    ].join("\0"), "utf8")
    .digest("hex")
    .slice(0, 32)}`;
}

export function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new PiNativeFileStoreError(
      "invalid-input",
      `${label} 必须是非空字符串`
    );
  }
  return value;
}

export function requireTimestamp(value: unknown, label: string): number {
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value < 0
  ) {
    throw new PiNativeFileStoreError(
      "invalid-input",
      `${label} 必须是非负安全整数时间戳`
    );
  }
  return value;
}

export function requirePlainObject(
  value: unknown,
  label: string
): Record<string, unknown> {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new PiNativeFileStoreError(
      "store-corrupt",
      `${label} 必须是普通对象`
    );
  }
  return value as Record<string, unknown>;
}

export function requireExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  label: string
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      throw new PiNativeFileStoreError(
        "store-corrupt",
        `${label} 缺少字段 ${key}`
      );
    }
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new PiNativeFileStoreError(
        "store-corrupt",
        `${label} 包含未声明字段 ${key}`
      );
    }
  }
}

export function isNodeErrorWithCode(
  error: unknown,
  code: string
): error is NodeJS.ErrnoException {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function syncDirectory(directoryPath: string): Promise<void> {
  const handle = await open(directoryPath, "r");
  try {
    await handle.sync();
  } catch (error) {
    if (
      !isNodeErrorWithCode(error, "EINVAL")
      && !isNodeErrorWithCode(error, "ENOTSUP")
      && !isNodeErrorWithCode(error, "EPERM")
    ) {
      throw error;
    }
  } finally {
    await handle.close();
  }
}
