import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { atomicWriteJsonFile, serializePiNativeFileWrite } from "../harness/pi-native/file-store-utils";
import { cognitiveAtomicWrite } from "../harness/memory/cognitive-file-utils";
import { PersonalMemoryRepository } from "../harness/memory/personal-memory-repository";
import { parseCanonicalMemoryManifest } from "../harness/memory/personal-memory-core";
import { MemoryDeveloperBackups } from "./developer-mode/memory-backups";
import { preparePortableVaultData, type VaultMigrationIO } from "../storage/vault-data-migration";
import { legacyPathVaultId, MEMORY_MANIFEST_FILE, parseVaultIdentity, VAULT_IDENTITY_FILE, type VaultIdentity } from "../storage/vault-identity";

const PRODUCT = "pi-agent-product-v1", BACKUPS = "vault-identity-backups", JOURNAL = "active-change.json";
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";
export async function readVaultIdentity(pluginDataRoot: string): Promise<VaultIdentity | null> {
  const raw = await readOptional(path.join(pluginDataRoot, PRODUCT, VAULT_IDENTITY_FILE));
  return raw === null ? null : parseVaultIdentity(raw);
}
export function nodeVaultMigrationIO(vaultRoot: string): VaultMigrationIO {
  const resolve = (relative: string) => {
    const target = path.resolve(vaultRoot, relative), inside = path.relative(vaultRoot, target);
    if (!inside || inside === ".." || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside)) throw new Error("Unsafe vault migration path");
    return target;
  };
  const assertParents = async (target: string) => {
    let cursor = vaultRoot;
    for (const part of path.relative(vaultRoot, target).split(path.sep).slice(0, -1)) {
      cursor = path.join(cursor, part);
      if (!await exists(cursor)) return;
      await assertPlain(cursor, "directory");
    }
  };
  return {
    read: async file => { const target = resolve(file); await assertParents(target); return readOptional(target); },
    write: async (file, bytes) => { const target = resolve(file); await assertParents(target); if (await exists(target)) await assertPlain(target, "file"); await cognitiveAtomicWrite(target, bytes); },
    remove: file => fs.unlink(resolve(file)),
    fileExists: async file => { const target = resolve(file); await assertParents(target); if (!await exists(target)) return false; await assertPlain(target, "file"); return true; },
    list: async directory => {
      const absolute = resolve(directory);
      await assertParents(absolute);
      if (!await exists(absolute)) return { files: [], folders: [] };
      await assertPlain(absolute, "directory");
      const entries = await fs.readdir(absolute, { withFileTypes: true });
      if (entries.some(entry => entry.isSymbolicLink())) throw new Error("Vault migration refuses symbolic links");
      return { files: entries.filter(entry => entry.isFile()).map(entry => `${directory}/${entry.name}`), folders: entries.filter(entry => entry.isDirectory()).map(entry => `${directory}/${entry.name}`) };
    }
  };
}
export async function prepareVaultIdentity(options: { pluginDataRoot: string; vaultRoot: string; recoverDeveloperChange?: boolean }): Promise<VaultIdentity> {
  return serializePiNativeFileWrite(options.pluginDataRoot, async () => {
    await recoverIdentityChange(options.pluginDataRoot);
    const absolute = path.join(options.pluginDataRoot, PRODUCT);
    await fs.mkdir(absolute, { recursive: true });
    const root = path.relative(options.vaultRoot, absolute).split(path.sep).join("/");
    const result = await preparePortableVaultData({ io: nodeVaultMigrationIO(options.vaultRoot), root,
      legacyMemoryRoot: ".echoink", fallbackVaultId: legacyPathVaultId(path.resolve(options.vaultRoot)),
      recoverTransactions: async () => {
        if (options.recoverDeveloperChange !== false) await new MemoryDeveloperBackups(path.join(absolute, ".echoink")).recoverInterruptedChange();
        const repository = new PersonalMemoryRepository({ vaultPath: absolute, vaultId: legacyPathVaultId(path.resolve(options.vaultRoot)), watchExternalChanges: false });
        try { await repository.recoverStorageTransactions(); } finally { await repository.dispose(); }
      }
    });
    return result.identity;
  });
}

/** Explicit mismatch recovery; all previous content remains in the backup. */
export async function repairVaultMemory(options: { pluginDataRoot: string; identity: VaultIdentity; action: "adopt" | "reset"; validate(): Promise<void> }): Promise<string> {
  return serializePiNativeFileWrite(options.pluginDataRoot, async () => {
    const root = path.join(options.pluginDataRoot, PRODUCT), manifest = path.join(root, MEMORY_MANIFEST_FILE);
    const raw = await readOptional(manifest);
    // Neither action is a general corruption/version/permission repair.
    if (raw === null) throw new Error("Personal Memory manifest is missing");
    const value = parseCanonicalMemoryManifest(raw);
    return withIdentityBackup(options.pluginDataRoot, async backup => {
      if (options.action === "reset") await fs.rename(path.join(root, ".echoink/shared-user"), path.join(backup, "previous-memory"));
      else await writeJson(manifest, { ...value, vaultId: options.identity.vaultId });
      await options.validate();
    });
  });
}

async function withIdentityBackup(pluginRoot: string, action: (backup: string) => Promise<void>): Promise<string> {
  const root = path.join(pluginRoot, PRODUCT), directory = path.join(pluginRoot, BACKUPS);
  const name = `${Date.now()}-${randomUUID()}`;
  const backup = path.join(directory, name);
  await fs.mkdir(backup, { recursive: true });
  await copyPlainTree(root, path.join(backup, "before"));
  const journal = path.join(directory, JOURNAL);
  await writeJson(journal, { schemaVersion: 1, backup: name });
  try {
    await action(backup);
    await fs.unlink(journal);
    return backup;
  } catch (error) {
    await recoverIdentityChange(pluginRoot);
    throw error;
  }
}

async function recoverIdentityChange(pluginRoot: string): Promise<void> {
  const directory = path.join(pluginRoot, BACKUPS), journal = path.join(directory, JOURNAL);
  const raw = await readOptional(journal);
  if (raw === null) return;
  const record = JSON.parse(raw) as { schemaVersion: number; backup: string };
  if (record.schemaVersion !== 1 || !/^\d+-[a-f0-9-]+$/u.test(record.backup)) throw new Error("Invalid EchoInk identity recovery journal");
  const backup = path.join(directory, record.backup), root = path.join(pluginRoot, PRODUCT);
  if (await exists(root)) await fs.rename(root, path.join(backup, `interrupted-${randomUUID()}`));
  await copyPlainTree(path.join(backup, "before"), root);
  await fs.unlink(journal);
}

async function walkPlainFiles(directory: string, visit: (file: string) => void): Promise<void> {
  if (!await exists(directory)) return;
  await assertPlain(directory, "directory");
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error("EchoInk identity migration refuses symbolic links");
    if (entry.isDirectory()) await walkPlainFiles(target, visit);
    else if (entry.isFile()) visit(target);
    else throw new Error("EchoInk identity migration requires ordinary files");
  }
}
async function copyPlainTree(source: string, destination: string): Promise<void> {
  await assertPlain(source, "directory");
  const files: string[] = [];
  await walkPlainFiles(source, file => files.push(file));
  await fs.mkdir(destination, { recursive: true });
  for (const file of files) {
    const target = path.join(destination, path.relative(source, file));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(file, target);
  }
}
async function assertPlain(file: string, type: "file" | "directory"): Promise<void> {
  const stat = await fs.lstat(file);
  if (stat.isSymbolicLink() || (type === "file" ? !stat.isFile() : !stat.isDirectory())) throw new Error("EchoInk identity migration requires an ordinary path");
}
async function exists(file: string): Promise<boolean> {
  try { await fs.lstat(file); return true; } catch (error) { if (missing(error)) return false; throw error; }
}
async function readOptional(file: string): Promise<string | null> {
  try { await assertPlain(file, "file"); return await fs.readFile(file, "utf8"); } catch (error) { if (missing(error)) return null; throw error; }
}
async function writeJson(file: string, value: unknown): Promise<void> {
  if (await exists(file)) await assertPlain(file, "file");
  await atomicWriteJsonFile(file, value, "EchoInk vault identity", value => value);
}
