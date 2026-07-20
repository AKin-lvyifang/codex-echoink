import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  unlink
} from "node:fs/promises";
import * as path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  validateRecordMigrationConflictQuarantine,
  type RecordMigrationConflictQuarantine
} from "./record-migration-validator";

const STAGING_DIRECTORY = ".staging";
const MAX_QUARANTINE_BYTES = 2 * 1024 * 1024;

export interface PublishRecordMigrationConflictQuarantineInput {
  rootPath: string;
  quarantine: RecordMigrationConflictQuarantine;
}

export interface RecordMigrationConflictQuarantineReceipt {
  quarantineDigest: string;
  absolutePath: string;
  created: boolean;
}

export async function publishRecordMigrationConflictQuarantine(
  input: PublishRecordMigrationConflictQuarantineInput
): Promise<RecordMigrationConflictQuarantineReceipt> {
  const quarantine = validateRecordMigrationConflictQuarantine(
    input.quarantine
  );
  const rootPath = safeRootPath(input.rootPath);
  const stagingRoot = path.join(rootPath, STAGING_DIRECTORY);
  await mkdir(rootPath, { recursive: true });
  await mkdir(stagingRoot, { recursive: true });
  await assertPlainDirectory(rootPath, "migration conflict root");
  await assertPlainDirectory(stagingRoot, "migration conflict staging");

  const token = quarantine.digest.slice("sha256:".length);
  const targetPath = path.join(rootPath, `conflict-${token}.json`);
  const existing = await readQuarantineOrNull(targetPath);
  if (existing) {
    if (!isDeepStrictEqual(existing, quarantine)) {
      throw new Error(
        "Record migration conflict quarantine digest is already occupied"
      );
    }
    return {
      quarantineDigest: quarantine.digest,
      absolutePath: targetPath,
      created: false
    };
  }

  const bytes = Buffer.from(`${JSON.stringify(quarantine, null, 2)}\n`, "utf8");
  if (bytes.byteLength > MAX_QUARANTINE_BYTES) {
    throw new Error("Record migration conflict quarantine is too large");
  }
  const stagedPath = path.join(
    stagingRoot,
    `.conflict-${token}-${randomUUID()}.tmp`
  );
  let staged = false;
  let published = false;
  try {
    const handle = await open(
      stagedPath,
      fsConstants.O_WRONLY
        | fsConstants.O_CREAT
        | fsConstants.O_EXCL
        | noFollowFlag(),
      0o600
    );
    try {
      await handle.writeFile(bytes);
      await handle.chmod(0o600);
      await handle.sync();
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1) {
        throw new Error(
          "Record migration conflict staging file is unsafe"
        );
      }
    } finally {
      await handle.close();
    }
    staged = true;
    await syncDirectory(stagingRoot);
    try {
      await link(stagedPath, targetPath);
      published = true;
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      const winner = await readQuarantineOrNull(targetPath);
      if (!winner || !isDeepStrictEqual(winner, quarantine)) {
        throw new Error(
          "Record migration conflict quarantine has a different winner"
        );
      }
    }
    await syncDirectory(rootPath);
    const readback = await readQuarantineOrNull(targetPath);
    if (!readback || !isDeepStrictEqual(readback, quarantine)) {
      throw new Error(
        "Record migration conflict quarantine readback mismatch"
      );
    }
    await unlink(stagedPath);
    staged = false;
    await syncDirectory(stagingRoot);
    return {
      quarantineDigest: quarantine.digest,
      absolutePath: targetPath,
      created: published
    };
  } catch (error) {
    if (staged) {
      await unlink(stagedPath).catch(() => undefined);
      await syncDirectory(stagingRoot).catch(() => undefined);
    }
    throw error;
  }
}

async function readQuarantineOrNull(
  absolutePath: string
): Promise<RecordMigrationConflictQuarantine | null> {
  const stat = await lstat(absolutePath).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  );
  if (!stat) return null;
  if (!stat.isFile() || stat.isSymbolicLink() || ![1, 2].includes(stat.nlink)) {
    throw new Error("Record migration conflict quarantine file is unsafe");
  }
  const handle = await open(
    absolutePath,
    fsConstants.O_RDONLY | noFollowFlag()
  );
  try {
    const before = await handle.stat();
    if (before.size > MAX_QUARANTINE_BYTES) {
      throw new Error("Record migration conflict quarantine is too large");
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (
      before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs
      || before.ctimeMs !== after.ctimeMs
      || bytes.byteLength !== before.size
    ) {
      throw new Error(
        "Record migration conflict quarantine changed during read"
      );
    }
    const parsed = JSON.parse(
      bytes.toString("utf8")
    ) as RecordMigrationConflictQuarantine;
    return validateRecordMigrationConflictQuarantine(parsed);
  } finally {
    await handle.close();
  }
}

async function assertPlainDirectory(
  absolutePath: string,
  label: string
): Promise<void> {
  const stat = await lstat(absolutePath);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a plain directory`);
  }
}

async function syncDirectory(absolutePath: string): Promise<void> {
  const handle = await open(
    absolutePath,
    fsConstants.O_RDONLY | noFollowFlag()
  );
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function safeRootPath(value: string): string {
  const resolved = path.resolve(value);
  if (resolved === path.parse(resolved).root) {
    throw new Error("Record migration conflict root cannot be a filesystem root");
  }
  return resolved;
}

function noFollowFlag(): number {
  return typeof fsConstants.O_NOFOLLOW === "number"
    ? fsConstants.O_NOFOLLOW
    : 0;
}

function isAlreadyExists(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === "object"
    && (error as NodeJS.ErrnoException).code === "EEXIST"
  );
}
