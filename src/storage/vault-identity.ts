import { sha256Hex } from "../utils/sha256";

export const VAULT_IDENTITY_FILE = "vault-identity.json";
export const MEMORY_MANIFEST_FILE = ".echoink/shared-user/.runtime/manifest.json";
export interface VaultIdentity { schemaVersion: 1; vaultId: string }
export interface VaultMemoryNotice { kind: "mismatch"; reason: string }
export function validVaultId(value: unknown): value is string { return typeof value === "string" && /^sha256:[a-f0-9]{64}$/u.test(value); }
export function parseVaultIdentity(raw: string): VaultIdentity {
  const value = JSON.parse(raw) as Partial<VaultIdentity> | null;
  if (!value || value.schemaVersion !== 1 || !validVaultId(value.vaultId)) throw new Error("Invalid EchoInk vault identity file");
  return { schemaVersion: 1, vaultId: value.vaultId };
}
export function newVaultId(): string { return `sha256:${crypto.randomUUID().replaceAll("-", "")}${crypto.randomUUID().replaceAll("-", "")}`; }
export function legacyPathVaultId(absolutePath: string): string { return `sha256:${sha256Hex(`echoink-vault-identity-v1\0${absolutePath}`)}`; }

/** Convert only the known old session root; never read a former absolute location. */
export function relativeLegacySessionPath(value: string, vaultId: string): string {
  const normalized = value.replaceAll("\\", "/");
  const marker = `/pi-agent-product-v1/vaults/${sha256Hex(vaultId)}/sessions/`;
  const absolute = normalized.startsWith("/") || /^[a-z]:\//iu.test(normalized);
  const offset = normalized.lastIndexOf(marker);
  const relative = absolute ? offset < 0 ? "" : normalized.slice(offset + marker.length) : normalized;
  if (!relative || relative.split("/").some(part => !part || part === "." || part === "..") || relative.includes(":")) throw new Error("Session path is outside this vault's session directory");
  return relative;
}
