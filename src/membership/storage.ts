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
const SECRET = "echoink-membership-installation-key";
/** Install-scoped encrypted storage. No Vault/Sync path is accepted. */
export async function createMembershipStorage(
  secret: SecretPort | undefined,
  desktop: boolean,
  namespace: string,
  rootOverride?: string,
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
  if (!desktop || !secret) return ephemeral;
  try {
    let master = secret.getSecret(SECRET);
    if (!master) {
      master = encode(crypto.getRandomValues(new Uint8Array(32)));
      secret.setSecret(SECRET, master);
      if (secret.getSecret(SECRET) !== master) return ephemeral;
    }
    const key = await crypto.subtle.importKey(
      "raw",
      decode(master) as BufferSource,
      "AES-GCM",
      false,
      ["encrypt", "decrypt"],
    );
    const root =
      rootOverride || path.join(os.homedir(), ".echoink", "membership");
    const id = encode(
        new Uint8Array(
          await crypto.subtle.digest(
            "SHA-256",
            new TextEncoder().encode(namespace),
          ),
        ),
      ).slice(0, 24),
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
    const statePath = path.join(directory, "account.enc"),
      identityPath = path.join(directory, "device.enc");
    const load = async <T>(file: string, fallback: T): Promise<T> => {
      try {
        return await unpack<T>(await fs.readFile(file, "utf8"));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return fallback;
        throw new Error("安全存储不可读取，请重新登录；原有资料保留。");
      }
    };
    return {
      persistent: true,
      read: async () => await load<LocalAccountState>(statePath, {}),
      write: async (state) => {
        const temp =
          statePath +
          "." +
          encode(crypto.getRandomValues(new Uint8Array(12))) +
          ".tmp";
        try {
          await fs.writeFile(temp, await pack(state), {
            mode: 0o600,
            flag: "wx",
          });
          await fs.rename(temp, statePath);
        } finally {
          await fs.unlink(temp).catch(() => {});
        }
      },
      identity: async () => {
        const existing = await load<DeviceIdentity | null>(identityPath, null);
        if (existing) return existing;
        const candidate = await deviceIdentity();
        try {
          await fs.writeFile(identityPath, await pack(candidate), {
            mode: 0o600,
            flag: "wx",
          });
          return candidate;
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === "EEXIST")
            return (await load<DeviceIdentity | null>(identityPath, null))!;
          throw e;
        }
      },
    };
  } catch {
    return ephemeral;
  }
}
