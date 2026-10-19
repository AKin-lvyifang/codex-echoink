import type { MembershipSecretPort } from "../membership/mobile-storage";

const flights = new WeakMap<MembershipSecretPort, Map<string, Promise<string>>>();
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** Also protects callers constructing a store with an injected test identity. */
export function assertMobileTaskInstanceId(value: string): void {
  if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value)) throw new Error("移动端任务实例标识无效，未读取或改写本地资料。");
}

/** A distinct Vault-local secret, independent of membership and shared Vault files. */
export async function getMobileTaskInstanceId(secret: MembershipSecretPort | undefined, namespace: string): Promise<string> {
  if (!secret || !namespace.trim()) throw new Error("移动端任务安全存储不可用，未读取或改写本地资料。");
  let pending = flights.get(secret);
  if (!pending) { pending = new Map(); flights.set(secret, pending); }
  const previous = pending.get(namespace);
  if (previous) return previous;
  const flight = (async () => {
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(namespace))), byte => byte.toString(16).padStart(2, "0")).join("");
    const key = `echoink-mobile-task-instance-${digest}`;
    try {
      const stored = secret.getSecret(key);
      if (stored !== null) {
        if (!uuid.test(stored)) throw new Error("INVALID_TASK_IDENTITY");
        return stored;
      }
      const created = crypto.randomUUID();
      secret.setSecret(key, created);
      if (secret.getSecret(key) !== created) throw new Error("TASK_IDENTITY_WRITE_NOT_CONFIRMED");
      return created;
    } catch { throw new Error("移动端任务安全标识无法读取或确认保存，原资料已保留，请恢复安全存储后重试。"); }
  })();
  pending.set(namespace, flight);
  // Coalesce concurrent calls only; later calls verify the persisted secret again.
  try { return await flight; }
  finally { if (pending.get(namespace) === flight) pending.delete(namespace); }
}
