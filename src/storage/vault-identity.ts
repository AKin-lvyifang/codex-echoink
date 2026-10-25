import { sha256Hex } from "../utils/sha256";

export const VAULT_IDENTITY_FILE = "vault-identity.json";
export const MEMORY_MANIFEST_FILE = ".echoink/shared-user/.runtime/manifest.json";

export interface VaultIdentity {
  schemaVersion: 1;
  vaultId: string;
  copiedFrom?: string;
}
export type VaultMemoryNotice = { kind: "copy"; originalName: string } | { kind: "mismatch"; reason: string };

export function validVaultId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim() === value
    && [...value].every(char => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127);
}
export function parseVaultIdentity(raw: string): VaultIdentity {
  const value = JSON.parse(raw) as Partial<VaultIdentity> | null;
  if (!value || value.schemaVersion !== 1 || !validVaultId(value.vaultId)
    || value.copiedFrom !== undefined && typeof value.copiedFrom !== "string") throw new Error("Invalid EchoInk vault identity file");
  return value as VaultIdentity;
}
/** Keep desktop legacy IDs exactly as written; mobile legacy IDs are valid too. */
export function legacyMemoryVaultId(raw: string | null): string | null {
  if (raw === null) return null;
  try {
    const manifest = JSON.parse(raw) as { schemaVersion?: unknown; vaultId?: unknown } | null;
    return manifest?.schemaVersion === 1 && validVaultId(manifest.vaultId) ? manifest.vaultId : null;
  } catch { return null; }
}
export function newVaultId(): string { return `sha256:${crypto.randomUUID().replaceAll("-", "")}${crypto.randomUUID().replaceAll("-", "")}`; }
export function vaultIdDigest(vaultId: string): string {
  return /^sha256:[a-f0-9]{64}$/u.test(vaultId) ? vaultId : `sha256:${sha256Hex(vaultId)}`;
}
export function vaultWasCopied(currentPath: string, previousPath: string | null, previousIdentity: string | null, vaultId: string): boolean {
  return previousPath !== null && currentPath !== previousPath && previousIdentity === vaultId;
}

/** Rewrite structural ownership only. User text and session transcripts stay byte-for-byte intact. */
export function rebindVaultDocument(value: unknown, oldId: string, nextId: string, sessionRoot: string): unknown {
  if (Array.isArray(value)) return value.map(item => rebindVaultDocument(item, oldId, nextId, sessionRoot));
  if (!value || typeof value !== "object") return value;
  const original = value as Record<string, unknown>;
  const toolContract = typeof original.toolCallId === "string" && Object.hasOwn(original, "normalizedArguments");
  const next: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (["normalizedArguments", "resolvedTarget", "targetVersion", "safeSummary"].includes(key) || key === "preview" && toolContract) next[key] = item;
    else if ((key === "vaultId" || key === "vaultIdDigest") && item === oldId) next[key] = nextId;
    else if (key === "sessionFile" && typeof item === "string") {
      const normalized = item.replaceAll("\\", "/");
      const marker = `/pi-agent-product-v1/vaults/${sha256Hex(oldId)}/sessions/`;
      const offset = normalized.lastIndexOf(marker);
      const relative = offset < 0 ? null : normalized.slice(offset + marker.length);
      // Never turn an arbitrary outside file into an accepted session path.
      next[key] = relative && !relative.split("/").some(part => !part || part === "." || part === "..")
        ? `${sessionRoot}/${relative}` : item;
    } else next[key] = rebindVaultDocument(item, oldId, nextId, sessionRoot);
  }
  if (typeof next.payloadDigest === "string" && Object.hasOwn(next, "payload")
    && JSON.stringify(original.payload) !== JSON.stringify(next.payload)) {
    if (original.payloadDigest !== sha256Hex(stableIdentityJson(original.payload))) throw new Error("Invalid EchoInk payload checksum; original data was preserved");
    next.payloadDigest = sha256Hex(stableIdentityJson(next.payload));
  }
  return next;
}
export function stableIdentityJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableIdentityJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).filter(key => object[key] !== undefined).sort().map(key => `${JSON.stringify(key)}:${stableIdentityJson(object[key])}`).join(",")}}`;
}
