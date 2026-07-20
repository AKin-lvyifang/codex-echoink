import { createHash, randomUUID } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  unlink
} from "node:fs/promises";
import * as path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  migrationContentDigest,
  type RecordMigrationOwnerEdge,
  type RecordMigrationOwnerKind
} from "./record-migration-validator";

const STORE_DIRECTORY = "conversation-legacy-evidence-v1";
const SCHEMA_VERSION = 1 as const;
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const OWNER_KINDS = new Set<RecordMigrationOwnerKind>([
  "native-execution-owner",
  "run-record-owner",
  "settings-projection-owner"
]);

export interface ConversationLegacyEvidenceReceipt {
  schemaVersion: typeof SCHEMA_VERSION;
  recordType: "conversation-legacy-evidence";
  sourceStoreRef: "retained-legacy-v1";
  sourceFingerprint: string;
  retainedSourceDigest: string;
  externalOwnerEdges: RecordMigrationOwnerEdge[];
  externalOwnerDigest: string;
  createdAt: number;
  digest: string;
}

export interface PrepareConversationLegacyEvidenceInput {
  sourceFingerprint: string;
  retainedSourceDigest: string;
  externalOwnerEdges: readonly RecordMigrationOwnerEdge[];
  createdAt: number;
}

/**
 * Immutable compatibility archive for diagnostics written before the formal
 * Native/Run owner Stores existed. It stores only opaque owner/resource
 * digests and binds them to the exact retained V1 migration fingerprint.
 */
export class FileConversationLegacyEvidenceStore {
  readonly rootPath: string;

  constructor(storageRootPath: string) {
    this.rootPath = path.join(
      path.resolve(storageRootPath),
      STORE_DIRECTORY
    );
  }

  async prepare(
    input: PrepareConversationLegacyEvidenceInput
  ): Promise<ConversationLegacyEvidenceReceipt> {
    const existing = await this.read(input.sourceFingerprint);
    const externalOwnerEdges = normalizeOwnerEdges(
      input.externalOwnerEdges
    );
    if (existing) {
      if (
        existing.retainedSourceDigest !== input.retainedSourceDigest
        || !isDeepStrictEqual(
          existing.externalOwnerEdges,
          externalOwnerEdges
        )
      ) {
        throw new Error(
          "Conversation legacy evidence conflicts with the retained V1 source"
        );
      }
      return existing;
    }
    if (!Number.isSafeInteger(input.createdAt) || input.createdAt < 0) {
      throw new Error("Conversation legacy evidence createdAt is invalid");
    }
    const withoutDigest = {
      schemaVersion: SCHEMA_VERSION,
      recordType: "conversation-legacy-evidence" as const,
      sourceStoreRef: "retained-legacy-v1" as const,
      sourceFingerprint: requireDigest(
        input.sourceFingerprint,
        "source fingerprint"
      ),
      retainedSourceDigest: requireDigest(
        input.retainedSourceDigest,
        "retained source digest"
      ),
      externalOwnerEdges,
      externalOwnerDigest: migrationContentDigest(externalOwnerEdges),
      createdAt: input.createdAt
    };
    const receipt: ConversationLegacyEvidenceReceipt = {
      ...withoutDigest,
      digest: migrationContentDigest(withoutDigest)
    };
    await ensurePlainDirectory(this.rootPath);
    const finalPath = this.receiptPath(receipt.sourceFingerprint);
    const temporaryPath = `${finalPath}.tmp-${randomUUID()}`;
    const handle = await open(temporaryPath, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(receipt)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await link(temporaryPath, finalPath);
      await syncDirectory(this.rootPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    } finally {
      await unlink(temporaryPath).catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      });
    }
    const committed = await this.read(receipt.sourceFingerprint);
    if (!committed) {
      throw new Error("Conversation legacy evidence readback is missing");
    }
    if (!isDeepStrictEqual(
      evidenceIdentity(committed),
      evidenceIdentity(receipt)
    )) {
      throw new Error(
        "Conversation legacy evidence readback conflicts with the source"
      );
    }
    return committed;
  }

  async read(
    sourceFingerprint: string
  ): Promise<ConversationLegacyEvidenceReceipt | null> {
    requireDigest(sourceFingerprint, "source fingerprint");
    const rootStats = await lstatOrNull(this.rootPath);
    if (!rootStats) return null;
    if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
      throw new Error("Conversation legacy evidence root is invalid");
    }
    const receiptPath = this.receiptPath(sourceFingerprint);
    const first = await readReceiptOnce(receiptPath);
    if (!first) return null;
    const second = await readReceiptOnce(receiptPath);
    if (!second || first.digest !== second.digest) {
      throw new Error(
        "Conversation legacy evidence changed during strict readback"
      );
    }
    return second;
  }

  private receiptPath(sourceFingerprint: string): string {
    const token = createHash("sha256")
      .update(sourceFingerprint, "utf8")
      .digest("hex");
    return path.join(this.rootPath, `${token}.json`);
  }
}

async function readReceiptOnce(
  receiptPath: string
): Promise<ConversationLegacyEvidenceReceipt | null> {
  const stats = await lstatOrNull(receiptPath);
  if (!stats) return null;
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error("Conversation legacy evidence receipt is invalid");
  }
  const parsed = JSON.parse(await readFile(receiptPath, "utf8")) as unknown;
  if (!isPlainObject(parsed)) {
    throw new Error("Conversation legacy evidence receipt is invalid");
  }
  const expectedKeys = [
    "schemaVersion",
    "recordType",
    "sourceStoreRef",
    "sourceFingerprint",
    "retainedSourceDigest",
    "externalOwnerEdges",
    "externalOwnerDigest",
    "createdAt",
    "digest"
  ];
  if (
    Object.keys(parsed).sort().join("\u0000")
    !== expectedKeys.sort().join("\u0000")
    || parsed.schemaVersion !== SCHEMA_VERSION
    || parsed.recordType !== "conversation-legacy-evidence"
    || parsed.sourceStoreRef !== "retained-legacy-v1"
    || !Array.isArray(parsed.externalOwnerEdges)
    || !Number.isSafeInteger(parsed.createdAt)
    || Number(parsed.createdAt) < 0
  ) {
    throw new Error("Conversation legacy evidence receipt is invalid");
  }
  const externalOwnerEdges = normalizeOwnerEdges(
    parsed.externalOwnerEdges as RecordMigrationOwnerEdge[]
  );
  const externalOwnerDigest = requireDigest(
    parsed.externalOwnerDigest,
    "external owner digest"
  );
  if (externalOwnerDigest !== migrationContentDigest(externalOwnerEdges)) {
    throw new Error(
      "Conversation legacy evidence owner digest does not match"
    );
  }
  const sourceFingerprint = requireDigest(
    parsed.sourceFingerprint,
    "source fingerprint"
  );
  const retainedSourceDigest = requireDigest(
    parsed.retainedSourceDigest,
    "retained source digest"
  );
  const digest = requireDigest(parsed.digest, "receipt digest");
  const withoutDigest = {
    schemaVersion: SCHEMA_VERSION,
    recordType: "conversation-legacy-evidence" as const,
    sourceStoreRef: "retained-legacy-v1" as const,
    sourceFingerprint,
    retainedSourceDigest,
    externalOwnerEdges,
    externalOwnerDigest,
    createdAt: Number(parsed.createdAt)
  };
  if (digest !== migrationContentDigest(withoutDigest)) {
    throw new Error(
      "Conversation legacy evidence receipt digest does not match"
    );
  }
  return { ...withoutDigest, digest };
}

function normalizeOwnerEdges(
  input: readonly RecordMigrationOwnerEdge[]
): RecordMigrationOwnerEdge[] {
  const edges = input.map((edge) => {
    if (!OWNER_KINDS.has(edge.kind)) {
      throw new Error(
        "Conversation legacy evidence contains an unsupported owner kind"
      );
    }
    return {
      kind: edge.kind,
      ownerRef: requireDigest(edge.ownerRef, "owner ref"),
      resourceRef: requireDigest(edge.resourceRef, "resource ref")
    };
  }).sort((left, right) => ownerEdgeKey(left).localeCompare(ownerEdgeKey(right)));
  for (let index = 1; index < edges.length; index += 1) {
    if (ownerEdgeKey(edges[index - 1]) === ownerEdgeKey(edges[index])) {
      throw new Error(
        "Conversation legacy evidence contains a duplicate owner edge"
      );
    }
  }
  return edges;
}

function evidenceIdentity(
  receipt: ConversationLegacyEvidenceReceipt
): unknown {
  return {
    sourceFingerprint: receipt.sourceFingerprint,
    retainedSourceDigest: receipt.retainedSourceDigest,
    externalOwnerEdges: receipt.externalOwnerEdges,
    externalOwnerDigest: receipt.externalOwnerDigest
  };
}

function ownerEdgeKey(edge: RecordMigrationOwnerEdge): string {
  return `${edge.kind}\u0000${edge.ownerRef}\u0000${edge.resourceRef}`;
}

function requireDigest(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new Error(`Conversation legacy evidence ${label} is invalid`);
  }
  return value;
}

async function ensurePlainDirectory(rootPath: string): Promise<void> {
  const existing = await lstatOrNull(rootPath);
  if (!existing) await mkdir(rootPath, { recursive: true });
  const stats = await lstat(rootPath);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error("Conversation legacy evidence root is invalid");
  }
}

async function syncDirectory(rootPath: string): Promise<void> {
  const handle = await open(rootPath, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(
    value
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
  );
}

async function lstatOrNull(target: string) {
  try {
    return await lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
