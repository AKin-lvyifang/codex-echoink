import { canonicalMemoryMetadata, canonicalSourceMap, parseCanonicalMemoryManifest, parseCanonicalMemoryRecord, renderPersonalMemoryOverview, type CanonicalMemoryManifest } from "../harness/memory/personal-memory-core";
import { buildSearchIndexV3 } from "../harness/memory/search-index-core";
import { emptyUserProfileState } from "../harness/memory/user-profile-core";
import { renderUserMarkdown } from "../harness/memory/cognitive-projection";
import { sha256Hex } from "../utils/sha256";
import { MEMORY_MANIFEST_FILE, parseVaultIdentity, relativeLegacySessionPath, validVaultId, VAULT_IDENTITY_FILE, type VaultIdentity } from "./vault-identity";

export interface VaultMigrationIO {
  read(file: string): Promise<string | null>;
  write(file: string, bytes: string): Promise<void>;
  remove(file: string): Promise<void>;
  fileExists?(file: string): Promise<boolean>;
  list(directory: string): Promise<{ files: string[]; folders: string[] }>;
}
export interface VaultMigrationReport {
  schemaVersion: 1;
  vaultId: string;
  retainedHistoricalIds: string[];
  importedRecordIds: string[];
  conflictingRecordIds: string[];
  backup: string;
}
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const join = (root: string, file: string) => root ? `${root}/${file}` : file;
const parent = (file: string) => file.slice(0, file.lastIndexOf("/"));
const safe = (file: string) => {
  if (!file || file.startsWith("/") || file.includes("\\") || file.split("/").some(part => !part || part === "." || part === "..")) throw new Error("Unsafe vault migration path");
  return file;
};
async function walk(io: VaultMigrationIO, directory: string): Promise<string[]> {
  const listed = await io.list(directory);
  const children = await Promise.all(listed.folders.map(folder => walk(io, folder)));
  return [...listed.files, ...children.flat()];
}
interface JournalEntry { file: string; before: string | null; afterHash: string | null }
interface Journal { schemaVersion: 1; entries: JournalEntry[] }
const journalPath = (root: string) => join(parent(root) || root, "vault-identity-backups/active-migration.json");

export async function recoverVaultMigration(io: VaultMigrationIO, root: string): Promise<void> {
  const file = journalPath(root), raw = await io.read(file);
  if (raw === null) return;
  const journal = JSON.parse(raw) as Journal;
  if (journal.schemaVersion !== 1 || !Array.isArray(journal.entries)) throw new Error("Invalid vault migration journal");
  const restore: { file: string; before: string | null }[] = [];
  for (const entry of journal.entries) {
    safe(entry.file);
    if (entry.before !== null && (typeof entry.before !== "string" || !safe(entry.before).includes("vault-identity-backups/"))) throw new Error("Invalid vault migration backup");
    const before = entry.before === null ? null : await io.read(entry.before), current = await io.read(entry.file);
    if (entry.before !== null && before === null) throw new Error("Vault migration backup is missing");
    if (current !== before && (current === null ? null : sha256Hex(current)) !== entry.afterHash) throw new Error("Vault migration encountered a newer edit; original files and backup were preserved");
    restore.push({ file: entry.file, before });
  }
  for (const entry of restore.reverse()) {
    if (entry.before === null) { if (await io.read(entry.file) !== null) await io.remove(entry.file); }
    else await io.write(entry.file, entry.before);
  }
  await io.remove(file);
}

/** Before-images and an atomic journal precede all edits; identity is the last publication. */
async function commitMigration(io: VaultMigrationIO, root: string, changes: Map<string, string>, backup: string, legacyRoot?: string): Promise<void> {
  if (legacyRoot) for (const file of await walk(io, legacyRoot)) {
    const bytes = await io.read(file);
    if (bytes !== null) await io.write(`${backup}/legacy-mobile/${file.slice(legacyRoot.length + 1)}`, bytes);
  }
  const entries: JournalEntry[] = [];
  for (const [file, bytes] of changes) {
    safe(file);
    const before = await io.read(file), saved = before === null ? null : `${backup}/files/${entries.length}.txt`;
    if (saved !== null) { await io.write(saved, before!); if (await io.read(saved) !== before) throw new Error("Vault migration backup readback failed"); }
    entries.push({ file, before: saved, afterHash: sha256Hex(bytes) });
  }
  await io.write(journalPath(root), json({ schemaVersion: 1, entries }));
  try {
    for (const [file, bytes] of changes) { await io.write(file, bytes); if (await io.read(file) !== bytes) throw new Error("Vault migration readback failed"); }
    await io.remove(journalPath(root));
  } catch (error) { await recoverVaultMigration(io, root); throw error; }
}

function manifestOrNull(raw: string | null): CanonicalMemoryManifest | null {
  if (raw === null) return null;
  try { return parseCanonicalMemoryManifest(raw); } catch { return null; }
}
async function loadRecords(io: VaultMigrationIO, memoryRoot: string, manifest: CanonicalMemoryManifest) {
  const records = new Map<string, { record: ReturnType<typeof parseCanonicalMemoryRecord>; bytes: string }>();
  for (const metadata of manifest.records) {
    const bytes = await io.read(join(memoryRoot, safe(metadata.file)));
    if (bytes === null) throw new Error(`Memory record is missing: ${metadata.file}`);
    const record = parseCanonicalMemoryRecord(bytes, metadata.file);
    if (record.id !== metadata.id || record.revision !== metadata.revision || metadata.contentHash && sha256Hex(record.content) !== metadata.contentHash) throw new Error(`Memory record does not match its manifest: ${metadata.file}`);
    records.set(record.id, { record, bytes });
  }
  return records;
}

/** Shared by desktop fs and mobile DataAdapter; no device/path registry or ownership rekeying. */
export async function preparePortableVaultData(options: {
  io: VaultMigrationIO; root: string; fallbackVaultId: string; legacyMemoryRoot?: string;
  recoverTransactions?(): Promise<void>;
}): Promise<{ identity: VaultIdentity; report: VaultMigrationReport | null }> {
  const { io, root } = options;
  await recoverVaultMigration(io, root);
  await options.recoverTransactions?.();
  const identityFile = join(root, VAULT_IDENTITY_FILE), identityRaw = await io.read(identityFile);
  const manifestFile = join(root, MEMORY_MANIFEST_FILE);
  let unreadableManifest = false;
  const manifestRaw = await io.read(manifestFile).catch(error => { if (identityRaw === null) throw error; unreadableManifest = true; return null; });
  const manifest = manifestOrNull(manifestRaw);
  const catalogs: { file: string; value: Record<string, unknown>; id: string; populated: boolean }[] = [];
  for (const directory of (await io.list(join(root, "vaults"))).folders) {
    const file = `${directory}/conversation-catalog.v1.json`, raw = await io.read(file);
    if (raw === null) continue;
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (value.schemaVersion !== 1 || !validVaultId(value.vaultId) || directory.split("/").at(-1) !== sha256Hex(value.vaultId) || !Array.isArray(value.entries)) throw new Error("Invalid historical conversation catalog");
    catalogs.push({ file, value, id: value.vaultId, populated: value.entries.length > 0 || Array.isArray(value.drafts) && value.drafts.length > 0 });
  }
  const sources = catalogs.filter(item => item.populated).map(item => item.id);
  if (manifest && validVaultId(manifest.vaultId)) sources.push(manifest.vaultId);
  for (const file of await walk(io, join(root, "bindings"))) {
    if (!file.endsWith(".json")) continue;
    const value = JSON.parse((await io.read(file))!) as { vaultId?: unknown };
    if (!validVaultId(value.vaultId)) throw new Error("Invalid historical conversation binding");
    sources.push(value.vaultId);
  }
  const ids = [...new Set(sources)];
  let selected = ids.length === 1 ? ids[0] : manifest && validVaultId(manifest.vaultId) ? manifest.vaultId : ids.length === 0 ? options.fallbackVaultId : null;
  if (identityRaw !== null) selected = parseVaultIdentity(identityRaw).vaultId;
  if (!selected || !validVaultId(selected)) throw new Error("Historical vault identities disagree; original directories were preserved");
  const identity: VaultIdentity = { schemaVersion: 1, vaultId: selected };
  const changes = new Map<string, string>();
  for (const catalog of catalogs) {
    let changed = false;
    const entries = await Promise.all((catalog.value.entries as Record<string, unknown>[]).map(async entry => {
      if (typeof entry.sessionFile !== "string") return entry;
      const relative = relativeLegacySessionPath(entry.sessionFile, catalog.id);
      if (relative !== entry.sessionFile) {
        const local = `${parent(catalog.file)}/sessions/${relative}`;
        const exists = io.fileExists ? await io.fileExists(local) : await io.read(local) !== null;
        if (!exists) throw new Error("Migrated conversation session is missing from the current vault");
        changed = true;
        return { ...entry, sessionFile: relative };
      }
      return entry;
    }));
    if (changed) changes.set(catalog.file, json({ ...catalog.value, entries }));
  }
  const report: VaultMigrationReport = { schemaVersion: 1, vaultId: selected, retainedHistoricalIds: ids.filter(id => id !== selected), importedRecordIds: [], conflictingRecordIds: [], backup: join(parent(root) || root, `vault-identity-backups/${Date.now()}-${crypto.randomUUID()}`) };
  const legacyRoot = options.legacyMemoryRoot;
  const marker = join(root, "mobile-memory-migration.json");
  const legacyRaw = legacyRoot && legacyRoot !== join(root, ".echoink") ? await io.read(`${legacyRoot}/shared-user/.runtime/manifest.json`) : null;
  const legacyFiles = legacyRoot && legacyRoot !== join(root, ".echoink") ? await walk(io, legacyRoot) : [];
  const legacy = manifestOrNull(legacyRaw) ?? (legacyRaw === null && legacyFiles.length ? {
    schemaVersion: 1 as const, vaultId: selected, revision: 0, records: [], tombstones: [], updatedAt: Date.now()
  } : null);
  const merge = !unreadableManifest && legacyFiles.length > 0 && await io.read(marker) === null && (manifestRaw === null || manifest !== null)
    && (identityRaw === null || manifest === null || manifest.vaultId === selected);
  if (merge) {
    if (!legacy) throw new Error("Legacy mobile memory manifest is damaged or unsupported");
    if (manifestRaw !== null && !manifest) throw new Error("Desktop memory manifest is damaged or unsupported");
    for (const memoryRoot of [legacyRoot!, join(root, ".echoink")]) {
      for (const kind of ["transactions", "mobile-transactions"]) for (const directory of (await io.list(`${memoryRoot}/shared-user/.runtime/${kind}`)).folders) {
        if ((await io.read(`${directory}/state`))?.trim() !== "committed") throw new Error("An existing Memory transaction must be recovered before migration");
      }
    }
    const mobile = await loadRecords(io, legacyRoot!, legacy), desktop = manifest ? await loadRecords(io, join(root, ".echoink"), manifest) : new Map<string, { record: ReturnType<typeof parseCanonicalMemoryRecord>; bytes: string }>();
    const tombstones = new Set(manifest?.tombstones.map(row => row.recordId));
    for (const [id, item] of mobile) {
      const current = desktop.get(id);
      if (current || tombstones.has(id)) {
        if (!current || JSON.stringify(current.record) !== JSON.stringify(item.record)) report.conflictingRecordIds.push(id);
      } else { desktop.set(id, item); report.importedRecordIds.push(id); }
    }
    // Preserve all legacy auxiliary files that have no desktop counterpart.
    for (const file of legacyFiles) {
      const relative = file.slice(legacyRoot!.length + 1), target = join(root, `.echoink/${relative}`);
      if (relative.includes("/.runtime/transactions/") || relative.includes("/.runtime/mobile-transactions/")) continue;
      if (/^shared-user\/memory\/(facts|views|decisions|active|episodes)\//u.test(relative)
        && ![...desktop.values()].some(item => item.record.file === relative && item.bytes === mobile.get(item.record.id)?.bytes)) continue;
      if (relative === "shared-user/user-profile-state.json" && manifest && await io.read(target) === null) {
        const user = await io.read(join(root, ".echoink/shared-user/USER.md"));
        if (user !== null) { changes.set(target, json({ ...emptyUserProfileState(Date.now()), lastProjectedUserHash: sha256Hex(user), legacyUserMigration: "pending" })); continue; }
      }
      if (await io.read(target) === null) changes.set(target, (await io.read(file))!);
    }
    for (const item of desktop.values()) {
      const file = join(root, `.echoink/${item.record.file}`);
      if (await io.read(file) === null) changes.set(file, item.bytes);
    }
    const records = [...desktop.values()].map(item => item.record);
    const next: CanonicalMemoryManifest = { ...(manifest ?? legacy), vaultId: selected, revision: Math.max(manifest?.revision ?? 0, legacy.revision, ...records.map(record => record.revision)) + 1, records: records.map(canonicalMemoryMetadata),
      tombstones: [...(manifest?.tombstones ?? []), ...legacy.tombstones.filter(row => !desktop.has(row.recordId) && !tombstones.has(row.recordId))], updatedAt: Date.now() };
    const memoryRoot = join(root, ".echoink");
    const readNext = async (file: string) => changes.get(file) ?? await io.read(file) ?? "";
    const userFile = `${memoryRoot}/shared-user/USER.md`;
    if (!changes.has(userFile) && await io.read(userFile) === null) changes.set(userFile, renderUserMarkdown(emptyUserProfileState(Date.now())));
    next.fixedFileHashes = { agent: sha256Hex(await readNext(`${memoryRoot}/agents/echoink/AGENT.md`)), user: sha256Hex(await readNext(`${memoryRoot}/shared-user/USER.md`)) };
    changes.set(manifestFile, json(next));
    changes.set(`${memoryRoot}/shared-user/MEMORY.md`, renderPersonalMemoryOverview(next, records));
    changes.set(`${memoryRoot}/shared-user/.runtime/source-map.json`, json(canonicalSourceMap(next)));
    changes.set(`${memoryRoot}/shared-user/.runtime/search-index.json`, json(buildSearchIndexV3(next.revision, records.map(record => ({ ...record, sourceSummary: record.source, summary: record.content.slice(0, 240) })), [])));
    changes.set(marker, json(report));
  } else if (identityRaw === null && manifest && !validVaultId(manifest.vaultId) && /^vault_[a-zA-Z0-9_-]+$/u.test(manifest.vaultId)) {
    changes.set(manifestFile, json({ ...manifest, vaultId: selected }));
  }
  if (identityRaw === null || changes.size) {
    changes.set(join(root, "identity-migration-report.json"), json(report));
    changes.set(identityFile, json(identity));
    await commitMigration(io, root, changes, report.backup, merge ? legacyRoot : undefined);
    return { identity, report };
  }
  const previous = await io.read(join(root, "identity-migration-report.json"));
  return { identity, report: previous === null ? null : JSON.parse(previous) as VaultMigrationReport };
}
