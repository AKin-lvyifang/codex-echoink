import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { decode, encode, deviceIdentity } from "./crypto";
import type {
  DeviceIdentity,
  LocalAccountState,
  MembershipStorage,
} from "./types";
interface SecretPort {
  getSecret(id: string): string | null;
  setSecret(id: string, value: string): void;
}
interface EncryptedPayload {
  iv: string;
  value: string;
}
export interface DeviceEncryptionPort {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Uint8Array;
  decryptString(value: Uint8Array): string;
  getSelectedStorageBackend?(): string;
}
interface StorageOptions {
  root?: string;
  encryption?: DeviceEncryptionPort;
}
const SECRET = "echoink-membership-installation-key";
const DEVICE_UNAVAILABLE = "系统安全存储不可用，暂时无法读取本机凭据。请解锁系统钥匙串或恢复安全存储后重试；原有凭据保留。";
const DEVICE_MIGRATION = "无法读取旧版设备凭据。请先在原先成功启用的仓库中更新并打开 EchoInk，再返回此仓库重试；原有凭据保留。";
const DEVICE_UNREADABLE = "本机设备凭据无法解密，请恢复系统安全存储后重试；原有凭据保留，重新登录不会重建设备。";
const digest = async (value: string) => encode(new Uint8Array(
  await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
)).slice(0, 24);
const hasErrorCode = (error: unknown, code: string) =>
  typeof error === "object" && error !== null && "code" in error && error.code === code;

/** The OS protects the shared device; each Vault's SecretStorage protects its session. */
export async function createMembershipStorage(
  secret: SecretPort | undefined,
  desktop: boolean,
  namespace: string,
  options: StorageOptions = {},
): Promise<MembershipStorage> {
  let memory: LocalAccountState = {},
    device: DeviceIdentity | undefined;
  const ephemeral: MembershipStorage = {
    persistent: false,
    read: async () => memory,
    write: async (s) => {
      memory = s;
    },
    identity: async () => device ?? (device = await deviceIdentity()),
  };
  if (!desktop) return ephemeral;
  const unavailable: MembershipStorage = {
    ...ephemeral,
    identity: async () => { throw new Error(DEVICE_UNAVAILABLE); },
  };
  const encryption = options.encryption;
  if (!secret || !encryption) return unavailable;
  try {
    if (!encryption.isEncryptionAvailable() || encryption.getSelectedStorageBackend?.() === "basic_text") return unavailable;
    let master = secret.getSecret(SECRET);
    if (!master) {
      master = encode(crypto.getRandomValues(new Uint8Array(32)));
      secret.setSecret(SECRET, master);
      if (secret.getSecret(SECRET) !== master) return unavailable;
    }
    const key = await crypto.subtle.importKey(
      "raw",
      decode(master) as BufferSource,
      "AES-GCM",
      false,
      ["encrypt", "decrypt"],
    );
    const root =
      options.root || path.join(os.homedir(), ".echoink", "membership");
    const id = await digest(namespace),
      directory = path.join(root, id);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await fs.chmod(directory, 0o700);
    const pack = async (value: unknown) => {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      return JSON.stringify({
        iv: encode(iv),
        value: encode(
          new Uint8Array(
            await crypto.subtle.encrypt(
              { name: "AES-GCM", iv },
              key,
              new TextEncoder().encode(JSON.stringify(value)),
            ),
          ),
        ),
      });
    };
    const unpack = async <T>(content: string): Promise<T> => {
      const data = JSON.parse(content) as EncryptedPayload;
      return JSON.parse(
        new TextDecoder().decode(
          await crypto.subtle.decrypt(
            { name: "AES-GCM", iv: decode(data.iv) as BufferSource },
            key,
            decode(data.value) as BufferSource,
          ),
        ),
      ) as T;
    };
    // Keep the old files intact. Older plugin versions cannot overwrite v2 state.
    const statePath = path.join(directory, `account.${await digest(master)}.enc`),
      legacyStatePath = path.join(directory, "account.enc"),
      legacyIdentityPath = path.join(directory, "device.enc"),
      identityPath = path.join(directory, "device.v2.enc");
    const load = async <T>(file: string, fallback: T): Promise<T> => {
      try {
        return await unpack<T>(await fs.readFile(file, "utf8"));
      } catch (e) {
        if (hasErrorCode(e, "ENOENT")) return fallback;
        throw new Error("登录信息不可读取，请重新登录；原有资料保留。");
      }
    };
    const publish = async (file: string, content: string | Uint8Array, exclusive = false) => {
      const temp = `${file}.${encode(crypto.getRandomValues(new Uint8Array(12)))}.tmp`;
      try {
        await fs.writeFile(temp, content, { mode: 0o600, flag: "wx" });
        // A link publishes the complete file without replacing another window's device.
        if (exclusive) await fs.link(temp, file);
        else await fs.rename(temp, file);
      } finally {
        await fs.unlink(temp).catch(() => {});
      }
    };
    const readDevice = async (): Promise<DeviceIdentity | null> => {
      let content: Uint8Array;
      try { content = await fs.readFile(identityPath); }
      catch (error) {
        if (hasErrorCode(error, "ENOENT")) return null;
        throw new Error(DEVICE_UNREADABLE);
      }
      try {
        if (!encryption.isEncryptionAvailable()) throw new Error(DEVICE_UNAVAILABLE);
        const value = JSON.parse(encryption.decryptString(content)) as DeviceIdentity;
        if (!value?.privateKey?.d || value.publicKey?.kty !== "EC" || value.publicKey.crv !== "P-256"
          || !value.publicKey.x || !value.publicKey.y || value.privateKey.x !== value.publicKey.x
          || value.privateKey.y !== value.publicKey.y) throw new Error(DEVICE_UNREADABLE);
        return value;
      } catch { throw new Error(DEVICE_UNREADABLE); }
    };
    const identity = async (): Promise<DeviceIdentity> => {
      const existing = await readDevice();
      if (existing) return existing;
      let legacy: DeviceIdentity | null;
      try { legacy = await load<DeviceIdentity | null>(legacyIdentityPath, null); }
      catch { throw new Error(DEVICE_MIGRATION); }
      const candidate = legacy ?? await deviceIdentity();
      if (!encryption.isEncryptionAvailable()) throw new Error(DEVICE_UNAVAILABLE);
      try {
        await publish(identityPath, encryption.encryptString(JSON.stringify(candidate)), true);
        return candidate;
      } catch (error) {
        if (hasErrorCode(error, "EEXIST")) {
          const winner = await readDevice();
          if (winner) return winner;
        }
        throw error;
      }
    };
    // Opening the original Vault is sufficient to migrate its device, even before login.
    // A different Vault can retry after migration; never replace an unreadable identity.
    await identity().catch(() => {});
    return {
      persistent: true,
      read: async () => {
        const current = await load<LocalAccountState | null>(statePath, null);
        if (current) return current;
        // The legacy shared session may have been overwritten by another Vault.
        const legacy = await load<LocalAccountState | null>(legacyStatePath, null).catch(() => null);
        if (legacy) await publish(statePath, await pack(legacy));
        return legacy ?? {};
      },
      write: async (state) => { await publish(statePath, await pack(state)); },
      identity,
    };
  } catch {
    return unavailable;
  }
}
