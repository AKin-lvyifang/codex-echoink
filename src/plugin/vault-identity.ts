import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { atomicWriteJsonFile, stablePathToken, serializePiNativeFileWrite } from "../harness/pi-native/file-store-utils";
import { legacyMemoryVaultId, MEMORY_MANIFEST_FILE, newVaultId, parseVaultIdentity, rebindVaultDocument, stableIdentityJson, VAULT_IDENTITY_FILE, vaultWasCopied, type VaultIdentity } from "../storage/vault-identity";
import { rebindStoredApprovalTicket } from "../harness/pi-native/tool-authorization";

const PRODUCT = "pi-agent-product-v1";
const BACKUPS = "vault-identity-backups";
const JOURNAL = "active-change.json";
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";

export async function readVaultIdentity(pluginDataRoot: string): Promise<VaultIdentity | null> {
  const raw = await readOptional(path.join(pluginDataRoot, PRODUCT, VAULT_IDENTITY_FILE));
  return raw === null ? null : parseVaultIdentity(raw);
}

/** Identity migration runs before stores/watchers open; backups are outside the stores. */
export async function prepareVaultIdentity(options: {
  pluginDataRoot: string; vaultRoot: string; deviceStateRoot: string;
}): Promise<VaultIdentity> {
  return serializePiNativeFileWrite(options.pluginDataRoot, async () => {
    const root = path.join(options.pluginDataRoot, PRODUCT);
    await recoverIdentityChange(options.pluginDataRoot);
    await fs.mkdir(root, { recursive: true });
    const identityPath = path.join(root, VAULT_IDENTITY_FILE);
    const legacyMobile = path.join(options.vaultRoot, ".echoink");
    const importMobile = !await exists(path.join(root, ".echoink")) && await exists(path.join(legacyMobile, "shared-user"));
    const memoryRaw = await readOptional(path.join(importMobile ? legacyMobile : path.join(root, ".echoink"), "shared-user/.runtime/manifest.json"));
    const raw = await readOptional(identityPath);
    const identity = raw !== null ? parseVaultIdentity(raw) : {
      schemaVersion: 1 as const,
      vaultId: legacyMemoryVaultId(memoryRaw) ?? await conversationIdentity(root) ?? newVaultId()
    };
    const locationPath = path.join(options.deviceStateRoot, "vault-locations", `${stablePathToken(identity.vaultId)}.json`);
    const locationRaw = await readOptional(locationPath);
    const location = locationRaw === null ? null : JSON.parse(locationRaw) as { vaultRoot: string; pluginDirectory: string };
    let previousId: string | null = null;
    if (location && location.vaultRoot !== options.vaultRoot) {
      if (!path.isAbsolute(location.vaultRoot) || path.isAbsolute(location.pluginDirectory)
        || location.pluginDirectory.split(/[\\/]/u).includes("..")) throw new Error("Invalid EchoInk vault location record");
      const old = await readOptional(path.join(location.vaultRoot, location.pluginDirectory, PRODUCT, VAULT_IDENTITY_FILE));
      if (old !== null) {
        try { previousId = parseVaultIdentity(old).vaultId; }
        catch { previousId = null; }
      }
    }
    const copied = vaultWasCopied(options.vaultRoot, location?.vaultRoot ?? null, previousId, identity.vaultId);
    const next = copied ? { schemaVersion: 1 as const, vaultId: newVaultId(), copiedFrom: path.basename(location!.vaultRoot) } : identity;
    const oldId = identity.vaultId;
    const token = stablePathToken(oldId), nextToken = stablePathToken(next.vaultId);
    const sessionRoot = path.join(root, "vaults", nextToken, "sessions");
    const documents = await migrationDocuments(root);
    const parsed: Array<{ file: string; value: unknown }> = [];
    for (const file of documents) {
      const bytes = (await readOptional(file))!;
      let value: unknown;
      try { value = JSON.parse(bytes); } catch {
        // Memory damage is handled by the recovery banner, never overwritten here.
        if (file.startsWith(path.join(root, ".echoink") + path.sep)) continue;
        throw new Error(`Invalid EchoInk store: ${path.relative(root, file)}`);
      }
      parsed.push({ file, value });
    }
    const references = new Map<string, string>();
    if (copied) for (const document of parsed) collectApprovalRebindings(document.value, oldId, next.vaultId, references);
    const changes: Array<{ file: string; bytes: string; nextFile: string }> = [];
    for (const { file, value } of parsed) {
      const changed = rebindDerivedReferences(rebindVaultDocument(value, oldId, next.vaultId, sessionRoot), references);
      let nextFile = file;
      for (const [previous, current] of references) {
        if (previous.startsWith("echoink-operation-v1_") && path.basename(file) === `${stablePathToken(previous)}.json`) {
          nextFile = path.join(path.dirname(file), `${stablePathToken(current)}.json`);
        }
      }
      if (JSON.stringify(value) !== JSON.stringify(changed) || nextFile !== file) changes.push({ file, nextFile, bytes: json(changed) });
    }
    if (raw === null || copied || importMobile || changes.length) {
      await withIdentityBackup(options.pluginDataRoot, async () => {
        if (importMobile) await copyPlainTree(legacyMobile, path.join(root, ".echoink"));
        // All ownership rewrites happen before the identity file is published.
        for (const change of changes) {
          await fs.writeFile(change.file, change.bytes);
          if (change.nextFile !== change.file) await fs.rename(change.file, change.nextFile);
        }
        if (copied && await exists(path.join(root, "vaults", token))) {
          await fs.rename(path.join(root, "vaults", token), path.join(root, "vaults", nextToken));
        }
        await writeJson(identityPath, next);
      });
    }
    await writeJson(path.join(options.deviceStateRoot, "vault-locations", `${stablePathToken(next.vaultId)}.json`), {
      vaultRoot: options.vaultRoot, pluginDirectory: path.relative(options.vaultRoot, options.pluginDataRoot)
    });
    return next;
  });
}

export async function dismissVaultCopyNotice(pluginDataRoot: string, identity: VaultIdentity): Promise<void> {
  const next = { ...identity }; delete next.copiedFrom;
  await writeJson(path.join(pluginDataRoot, PRODUCT, VAULT_IDENTITY_FILE), next);
  delete identity.copiedFrom;
}

/** Called with the Memory repository stopped. Validation happens before committing the backup journal. */
export async function repairVaultMemory(options: {
  pluginDataRoot: string; identity: VaultIdentity; action: "adopt" | "reset"; validate(): Promise<void>;
}): Promise<string> {
  return serializePiNativeFileWrite(options.pluginDataRoot, async () => {
    const root = path.join(options.pluginDataRoot, PRODUCT);
    const manifest = path.join(root, MEMORY_MANIFEST_FILE);
    const raw = await readOptional(manifest);
    const backup = await withIdentityBackup(options.pluginDataRoot, async backup => {
      if (options.action === "reset") {
        const memory = path.join(root, ".echoink/shared-user");
        if (await exists(memory)) await fs.rename(memory, path.join(backup, "previous-memory"));
      } else if (raw !== null) {
        let value: unknown;
        try { value = JSON.parse(raw); } catch { value = null; }
        if (value && typeof value === "object" && !Array.isArray(value)) {
          // Preserve the claimed content and revision; the repository validates/reconciles it.
          await writeJson(manifest, { ...value, schemaVersion: 1, vaultId: options.identity.vaultId });
        } else {
          await fs.rename(manifest, path.join(backup, "unreadable-manifest.json"));
        }
      }
      await options.validate();
      await writeJson(path.join(root, VAULT_IDENTITY_FILE), { schemaVersion: 1, vaultId: options.identity.vaultId });
    });
    delete options.identity.copiedFrom;
    return backup;
  });
}

async function conversationIdentity(root: string): Promise<string | null> {
  const directory = path.join(root, "vaults");
  const entries = await directories(directory);
  const candidates: Array<{ id: string; count: number }> = [];
  for (const entry of entries) {
    const raw = await readOptional(path.join(directory, entry, "conversation-catalog.v1.json"));
    if (raw === null) continue;
    const id = legacyMemoryVaultId(raw), document = JSON.parse(raw) as { entries?: unknown[] };
    if (id && stablePathToken(id) === entry) candidates.push({ id, count: document.entries?.length ?? 0 });
  }
  const populated = candidates.filter(candidate => candidate.count > 0);
  if (populated.length > 1) throw new Error("Multiple EchoInk conversation identities found; original stores were preserved");
  return populated[0]?.id ?? (candidates.length === 1 ? candidates[0].id : null);
}

async function migrationDocuments(root: string): Promise<string[]> {
  const result: string[] = [];
  for (const name of ["vaults", "bindings", "knowledge", ".echoink"]) {
    const directory = path.join(root, name);
    await walkPlainFiles(directory, file => { if (file.endsWith(".json")) result.push(file); });
  }
  return result;
}

function collectApprovalRebindings(value: unknown, oldId: string, nextId: string, references: Map<string, string>): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) { value.forEach(item => collectApprovalRebindings(item, oldId, nextId, references)); return; }
  const object = value as Record<string, unknown>;
  if (object.vaultId === oldId && typeof object.ticketId === "string" && typeof object.operationIdentity === "string"
    && typeof object.issuedAt === "number" && typeof object.expiresAt === "number") {
    const next = rebindStoredApprovalTicket(object, nextId);
    references.set(object.ticketId, next.ticketId);
    references.set(object.operationIdentity, next.operationIdentity);
    references.set(`echoink-receipt_${stablePathToken(object.operationIdentity)}`, `echoink-receipt_${stablePathToken(next.operationIdentity)}`);
  }
  Object.values(object).forEach(item => collectApprovalRebindings(item, oldId, nextId, references));
}
function rebindDerivedReferences(value: unknown, references: ReadonlyMap<string, string>): unknown {
  if (Array.isArray(value)) return value.map(item => rebindDerivedReferences(item, references));
  if (!value || typeof value !== "object") return value;
  const object = value as Record<string, unknown>, next: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(object)) {
    if (["normalizedArguments", "resolvedTarget", "targetVersion", "safeSummary"].includes(key)
      || key === "preview" && Object.hasOwn(object, "normalizedArguments")) next[key] = item;
    else next[key] = typeof item === "string" && ["ticketId", "operationIdentity", "approvalTicketId", "receiptId"].includes(key)
      ? references.get(item) ?? item : rebindDerivedReferences(item, references);
  }
  if (typeof next.payloadDigest === "string" && Object.hasOwn(next, "payload")
    && JSON.stringify(object.payload) !== JSON.stringify(next.payload)) next.payloadDigest = stablePathToken(stableIdentityJson(next.payload));
  return next;
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

async function directories(directory: string): Promise<string[]> {
  try {
    await assertPlain(directory, "directory");
    const entries = await fs.readdir(directory, { withFileTypes: true });
    if (entries.some(entry => entry.isSymbolicLink())) throw new Error("EchoInk identity migration refuses symbolic links");
    return entries.filter(entry => entry.isDirectory()).map(entry => entry.name);
  } catch (error) { if (missing(error)) return []; throw error; }
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
