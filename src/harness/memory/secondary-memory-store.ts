import { getDesktopCrypto } from "../../platform/desktop-crypto";
import { getDesktopPath } from "../../platform/desktop-paths";
import { getDesktopFsPromises } from "../../platform/desktop-filesystem";
import { cognitiveAtomicWrite, cognitivePathExists } from "./cognitive-file-utils";
import type { SecondaryMemoryRecord } from "./personal-memory-contracts";
import { SECONDARY_MEMORY_DIRNAME, secondaryRelativePath, parseSecondaryRecord, serializeSecondaryRecord, assertSecondaryPathIdentity, assertUniqueSecondaryIds, parseSecondaryRecordInternal, SecondaryIdentityError, SecondaryOversizedRecordError } from "./secondary-memory-core";
export * from "./secondary-memory-core";
const { createHash } = getDesktopCrypto();
const path = getDesktopPath();
const { mkdir, readdir, readFile } = getDesktopFsPromises();
const FATAL_UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

export class SecondaryMemoryStore {
  private readonly directory: string;
  private readonly backupDirectory: string;
  private cache: readonly SecondaryMemoryRecord[] | null = null;

  constructor(historyRoot: string) {
    this.directory = path.join(historyRoot, SECONDARY_MEMORY_DIRNAME);
    this.backupDirectory = path.join(
      path.dirname(historyRoot),
      ".runtime",
      "backups",
      "association-clues"
    );
  }

  get rootDirectory(): string {
    return this.directory;
  }

  /** Load (and cache) every secondary record on disk. Invalid files are skipped. */
  async loadAll(): Promise<readonly SecondaryMemoryRecord[]> {
    if (this.cache) return this.cache;
    const records: SecondaryMemoryRecord[] = [];
    if (await cognitivePathExists(this.directory)) {
      const parentEntries = await readdir(this.directory, { withFileTypes: true });
      for (const parentEntry of parentEntries.sort((left, right) => left.name.localeCompare(right.name))) {
        if (!parentEntry.isDirectory()) continue;
        const parentDir = path.join(this.directory, parentEntry.name);
        const fileEntries = await readdir(parentDir, { withFileTypes: true });
        for (const fileEntry of fileEntries.sort((left, right) => left.name.localeCompare(right.name))) {
          if (!fileEntry.isFile() || !fileEntry.name.endsWith(".md")) continue;
          const target = path.join(parentDir, fileEntry.name);
          const fileId = fileEntry.name.replace(/\.md$/u, "");
          const relative = secondaryRelativePath(parentEntry.name, fileId);
          let text = "";
          let originalBytes: Uint8Array | null = null;
          try {
            originalBytes = await readFile(target);
            text = FATAL_UTF8_DECODER.decode(originalBytes);
            const record = parseSecondaryRecord(text, relative);
            assertSecondaryPathIdentity(record, parentEntry.name, fileId);
            records.push(record);
          } catch (error) {
            if (error instanceof SecondaryIdentityError) throw error;
            if (error instanceof SecondaryOversizedRecordError) {
              try {
                const repaired = parseSecondaryRecordInternal(text, relative, true);
                if (!repaired.repaired) throw error;
                assertSecondaryPathIdentity(repaired.record, parentEntry.name, fileId);
                if (!originalBytes) throw error;
                const hash = createHash("sha256").update(originalBytes).digest("hex").slice(0, 16);
                const backup = path.join(
                  this.backupDirectory,
                  `${repaired.record.parentId}-${repaired.record.id}-${hash}.md`
                );
                // Backup must durably land before deterministic replacement.
                await cognitiveAtomicWrite(backup, originalBytes);
                await cognitiveAtomicWrite(target, serializeSecondaryRecord(repaired.record));
                records.push(repaired.record);
              } catch (repairError) {
                if (repairError instanceof SecondaryIdentityError) throw repairError;
                // Structural damage is never guessed, rewritten or deleted.
              }
            }
            // A structurally damaged clue never blocks primary Memory and its
            // original file remains untouched.
          }
        }
      }
    }
    records.sort((left, right) => left.parentId.localeCompare(right.parentId) || left.id.localeCompare(right.id));
    assertUniqueSecondaryIds(records);
    this.cache = Object.freeze(records);
    return this.cache;
  }

  /** Refresh the cache from disk. */
  async refresh(): Promise<readonly SecondaryMemoryRecord[]> {
    this.cache = null;
    return await this.loadAll();
  }

  /** Update the in-memory cache after a transaction committed new files. */
  setCache(records: readonly SecondaryMemoryRecord[]): void {
    assertUniqueSecondaryIds(records);
    this.cache = Object.freeze([...records].sort(
      (left, right) => left.parentId.localeCompare(right.parentId) || left.id.localeCompare(right.id)
    ));
  }

  async listForParent(parentId: string): Promise<readonly SecondaryMemoryRecord[]> {
    const all = await this.loadAll();
    return all.filter((record) => record.parentId === parentId);
  }

  async ensureDirectory(parentId: string): Promise<string> {
    const target = path.join(this.directory, parentId);
    await mkdir(target, { recursive: true });
    return target;
  }

  absolutePathFor(relativePath: string): string {
    return path.join(this.directory, "..", "..", relativePath);
  }
}
