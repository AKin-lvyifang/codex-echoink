import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createMembershipStorage, type DeviceEncryptionPort } from "../membership/storage";
import { deviceIdentity, encode, decode } from "../membership/crypto";

const SECRET = "echoink-membership-installation-key";
function secrets(master = encode(randomBytes(32))) {
  const values = new Map([[SECRET, master]]);
  return { master, getSecret: (id: string) => values.get(id) ?? null, setSecret: (id: string, value: string) => { values.set(id, value); } };
}
// Models one OS user's protected store; no host credentials or real Vaults are used.
function encryption(): DeviceEncryptionPort {
  const key = randomBytes(32);
  return {
    isEncryptionAvailable: () => true,
    encryptString(value) {
      const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, iv);
      const valueBytes = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), valueBytes]);
    },
    decryptString(value) {
      const bytes = Buffer.from(value), cipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
      cipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString("utf8");
    },
  };
}
async function legacyPayload(value: unknown, master: string) {
  const key = await crypto.subtle.importKey("raw", decode(master) as BufferSource, "AES-GCM", false, ["encrypt"]);
  const iv = randomBytes(12);
  return JSON.stringify({ iv: encode(iv), value: encode(new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv }, key, new TextEncoder().encode(JSON.stringify(value)),
  ))) });
}
async function directory(root: string, namespace: string) {
  return path.join(root, encode(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(namespace)))).slice(0, 24));
}

export async function runMembershipStorageTests(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "echoink-membership-storage-"));
  const osEncryption = encryption();
  try {
    const namespace = "https://membership-storage-fixture.invalid", aSecrets = secrets(), bSecrets = secrets();
    const options = { root, encryption: osEncryption };
    const a = await createMembershipStorage(aSecrets, true, namespace, options);
    const b = await createMembershipStorage(bSecrets, true, namespace, options);
    assert.equal(a.persistent, true);
    const identity = await a.identity();
    assert.deepEqual(await b.identity(), identity, "different Vault keys use the same device");
    await a.write({ token: "synthetic-a" });
    assert.deepEqual(await b.read(), {}, "a new Vault does not inherit another session");
    await b.write({ token: "synthetic-b" });
    assert.equal((await a.read()).token, "synthetic-a", "another Vault's login cannot overwrite this session");
    const restarted = await createMembershipStorage(bSecrets, true, namespace, options);
    assert.deepEqual(await restarted.identity(), identity);
    assert.equal((await restarted.read()).token, "synthetic-b");
    await b.write({});
    assert.equal((await a.read()).token, "synthetic-a", "another Vault's logout cannot clear this session");
    const stored = await readFile(path.join(await directory(root, namespace), "device.v2.enc"));
    assert.equal(stored.includes(Buffer.from(identity.privateKey.d!)), false, "device private key is encrypted on disk");

    const concurrentNamespace = `${namespace}/concurrent`;
    const windows = await Promise.all(Array.from({ length: 8 }, () => createMembershipStorage(secrets(), true, concurrentNamespace, options)));
    const identities = await Promise.all(windows.map(storage => storage.identity()));
    assert.ok(identities.every(value => JSON.stringify(value) === JSON.stringify(identities[0])), "simultaneous Vault startup publishes only one complete device");
    assert.deepEqual(await readdir(await directory(root, concurrentNamespace)), ["device.v2.enc"], "temporary device writes are cleaned");

    const legacyNamespace = `${namespace}/legacy`, original = secrets(), other = secrets();
    const legacyDirectory = await directory(root, legacyNamespace);
    await mkdir(legacyDirectory);
    const oldDevice = await deviceIdentity();
    const oldDeviceBytes = await legacyPayload(oldDevice, original.master);
    const oldAccountBytes = await legacyPayload({ token: "synthetic-legacy" }, original.master);
    const legacyDevicePath = path.join(legacyDirectory, "device.enc");
    const legacyAccountPath = path.join(legacyDirectory, "account.enc");
    await writeFile(legacyDevicePath, oldDeviceBytes);
    await writeFile(legacyAccountPath, oldAccountBytes);
    const wrongVault = await createMembershipStorage(other, true, legacyNamespace, options);
    await assert.rejects(wrongVault.identity(), /原先成功启用的仓库/, "wrong Vault must not silently generate another device");
    assert.deepEqual(await wrongVault.read(), {});
    await wrongVault.write({ token: "synthetic-new-vault" });
    assert.equal(await readFile(legacyDevicePath, "utf8"), oldDeviceBytes);
    assert.equal(await readFile(legacyAccountPath, "utf8"), oldAccountBytes, "new Vault login preserves the legacy session");
    const originalVault = await createMembershipStorage(original, true, legacyNamespace, options);
    assert.deepEqual(await originalVault.identity(), oldDevice, "upgrade preserves the registered device public key");
    assert.equal((await originalVault.read()).token, "synthetic-legacy");
    assert.deepEqual(await wrongVault.identity(), oldDevice, "already-open Vault can retry immediately after original Vault migrates");
    assert.equal((await wrongVault.read()).token, "synthetic-new-vault");
    await originalVault.write({});
    const loggedOut = await createMembershipStorage(original, true, legacyNamespace, options);
    assert.deepEqual(await loggedOut.read(), {}, "logout does not resurrect the legacy account");
    assert.equal(await readFile(legacyDevicePath, "utf8"), oldDeviceBytes);
    assert.equal(await readFile(legacyAccountPath, "utf8"), oldAccountBytes);

    const devicePath = path.join(await directory(root, namespace), "device.v2.enc");
    await writeFile(devicePath, "synthetic-corrupt-ciphertext");
    const corrupted = await createMembershipStorage(aSecrets, true, namespace, options);
    await assert.rejects(corrupted.identity(), /本机设备凭据无法解密/);
    assert.equal(await readFile(devicePath, "utf8"), "synthetic-corrupt-ciphertext", "unreadable device must never be replaced");
    for (const port of [undefined, { ...osEncryption, isEncryptionAvailable: () => false }, { ...osEncryption, getSelectedStorageBackend: () => "basic_text" }]) {
      const unavailable = await createMembershipStorage(aSecrets, true, namespace, { root, encryption: port });
      assert.equal(unavailable.persistent, false);
      await assert.rejects(unavailable.identity(), /系统安全存储不可用/, "unavailable desktop encryption cannot create temporary extra devices");
    }
    console.log("PASS membership storage: cross-Vault identity, separate sessions, concurrent startup, legacy migration, corruption and unavailable encryption");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
