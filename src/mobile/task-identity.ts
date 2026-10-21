import type { MembershipSecretPort } from "../membership/mobile-storage";

export interface MobileTaskLocalPort {
  loadLocalStorage(key: string): unknown;
  saveLocalStorage(key: string, value: string): void | Promise<void>;
}

const flights = new WeakMap<object, Map<string, Promise<string>>>();
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type StoredIdentity = { value?: string; writable: boolean; invalid?: boolean };

async function readIdentity(read: () => unknown, local = false): Promise<StoredIdentity> {
  try {
    const value = await read();
    if (value === null || (local && value === undefined)) return { writable: true };
    if (typeof value !== "string" || !uuid.test(value)) return { writable: false, invalid: true };
    return { value, writable: true };
  } catch { return { writable: false }; }
}

async function saveIdentity(write: () => void | Promise<void>, read: () => unknown, value: string): Promise<boolean> {
  try { await write(); return await read() === value; }
  catch { return false; }
}

/** Also protects callers constructing a store with an injected test identity. */
export function assertMobileTaskInstanceId(value: string): void {
  if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value)) throw new Error("移动端任务实例标识无效，未读取或改写本地资料。");
}

/** Device-and-Vault-local storage only; never writes an identity into Vault files. */
export async function getMobileTaskInstanceId(secret: MembershipSecretPort | undefined, namespace: string, local?: MobileTaskLocalPort): Promise<string> {
  if ((!secret && !local) || typeof namespace !== "string" || !namespace.trim()) throw new Error("移动端任务安全存储不可用，未读取或改写本地资料。");
  const pending = [secret, local].filter((port): port is MembershipSecretPort | MobileTaskLocalPort => !!port).map(port => {
    let entries = flights.get(port);
    if (!entries) { entries = new Map(); flights.set(port, entries); }
    return entries;
  });
  for (const entries of pending) {
    const previous = entries.get(namespace);
    if (previous) return previous;
  }
  const flight = (async () => {
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(namespace))), byte => byte.toString(16).padStart(2, "0")).join("");
    // The old 93-character key is read-only. New SecretStorage keys allow at most 64 characters.
    const legacyKey = `echoink-mobile-task-instance-${digest}`;
    const key = `echoink-mobile-task-instance-${digest.slice(0, 32)}`;
    const legacy: StoredIdentity = secret ? await readIdentity(() => secret.getSecret(legacyKey)) : { writable: false };
    const stored: StoredIdentity = secret ? await readIdentity(() => secret.getSecret(key)) : { writable: false };
    const backup: StoredIdentity = local ? await readIdentity(() => local.loadLocalStorage(key), true) : { writable: false };
    const mirrorLocal = async (value: string): Promise<boolean> => {
      if (!local || !backup.writable) return false;
      if (backup.value === value) return true;
      return saveIdentity(() => local.saveLocalStorage(key, value), () => local.loadLocalStorage(key), value);
    };
    const mirrorSecret = async (value: string): Promise<boolean> => {
      if (!secret || !stored.writable || legacy.invalid) return false;
      return saveIdentity(() => secret.setSecret(key, value), () => secret.getSecret(key), value);
    };
    const selected = legacy.value ?? stored.value;
    if (selected) { await mirrorLocal(selected); return selected; }
    // Read the local backup before creating anything, including when SecretStorage is empty.
    if (backup.value) { await mirrorSecret(backup.value); return backup.value; }
    const created = crypto.randomUUID();
    if (await mirrorSecret(created)) { await mirrorLocal(created); return created; }
    if (await mirrorLocal(created)) return created;
    throw new Error("TASK_IDENTITY_WRITE_NOT_CONFIRMED");
  })().catch(() => {
    throw new Error("移动端任务安全标识无法读取或确认保存，原资料已保留，请恢复本机安全存储或本地存储后重试。");
  });
  for (const entries of pending) entries.set(namespace, flight);
  // Coalesce concurrent calls only; later calls verify persisted storage again.
  try { return await flight; }
  finally { for (const entries of pending) if (entries.get(namespace) === flight) entries.delete(namespace); }
}
