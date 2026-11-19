/**
 * End-to-end encryption (方哥 11-07 定): the key comes from the account password plus the account id, is derived on
 * the device and never leaves it. Each object carries its own random key wrapped by the master key, plus the
 * encrypted path, so the service sees only ciphertext and a path token. A wrong password simply fails to decrypt:
 * nothing local is touched.
 */
const encoder = new TextEncoder(), decoder = new TextDecoder();
const MAGIC = encoder.encode("EIS1");
export const PBKDF2_ITERATIONS = 600_000;

export interface SyncMasterKey {
  /** The 64 derived bytes, base64, so the device can cache the key without the password. Never leaves the device. */
  readonly raw: string;
  /** AES-256-GCM for wrapping file keys and sealing the key check. */
  readonly wrap: CryptoKey;
  /** HMAC-SHA256 for path tokens. */
  readonly mac: CryptoKey;
  /** Hex fingerprint of the derived material; stored locally to recognise "same password" without the password. */
  readonly fingerprint: string;
}

const subtle = () => crypto.subtle;
const hex = (bytes: ArrayBuffer | Uint8Array) => Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, "0")).join("");
export const bytesToBase64 = (bytes: Uint8Array): string => { let s = ""; for (const b of bytes) s += String.fromCharCode(b); return btoa(s); };
export const base64ToBytes = (text: string): Uint8Array => Uint8Array.from(atob(text), c => c.charCodeAt(0));
export async function sha256Hex(bytes: Uint8Array): Promise<string> { return hex(await subtle().digest("SHA-256", bytes as BufferSource)); }

/** PBKDF2-SHA256 over password + account id, then HKDF into two purposes. Slow on purpose (about half a second). */
export async function deriveMasterKey(password: string, accountId: string, iterations = PBKDF2_ITERATIONS): Promise<SyncMasterKey> {
  if (!password || !accountId) throw new Error("PASSWORD_REQUIRED");
  const base = await subtle().importKey("raw", encoder.encode(password.normalize("NFKC")), "PBKDF2", false, ["deriveBits"]);
  const salt = encoder.encode(`echoink-sync-v1:${accountId}`);
  const material = await subtle().deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, base, 512);
  return importMasterKey(bytesToBase64(new Uint8Array(material)));
}
/** Rebuilds the key from the cached material (device keychain or local storage). */
export async function importMasterKey(raw: string): Promise<SyncMasterKey> {
  const bytes = base64ToBytes(raw);
  if (bytes.length !== 64) throw new Error("KEY_CACHE");
  const wrap = await subtle().importKey("raw", bytes.slice(0, 32), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  const mac = await subtle().importKey("raw", bytes.slice(32, 64), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const fingerprint = hex(await subtle().digest("SHA-256", encoder.encode(`echoink-sync-fingerprint:${hex(bytes.slice(0, 32))}`)));
  return { raw, wrap, mac, fingerprint };
}

/** The service only ever sees this for a path. */
export async function pathToken(key: SyncMasterKey, path: string): Promise<string> {
  return hex(await subtle().sign("HMAC", key.mac, encoder.encode(path)));
}

/** Envelope: "EIS1" | wrappedKey(12 iv + 48) | pathIv(12) | pathLen(2) | pathCiphertext | bodyIv(12) | bodyCiphertext. */
export async function encryptEntry(key: SyncMasterKey, path: string, body: Uint8Array): Promise<Uint8Array> {
  const fileKeyRaw = crypto.getRandomValues(new Uint8Array(32));
  const fileKey = await subtle().importKey("raw", fileKeyRaw, { name: "AES-GCM" }, false, ["encrypt"]);
  const wrapIv = crypto.getRandomValues(new Uint8Array(12)), pathIv = crypto.getRandomValues(new Uint8Array(12)), bodyIv = crypto.getRandomValues(new Uint8Array(12));
  const wrapped = new Uint8Array(await subtle().encrypt({ name: "AES-GCM", iv: wrapIv }, key.wrap, fileKeyRaw));
  const pathCipher = new Uint8Array(await subtle().encrypt({ name: "AES-GCM", iv: pathIv }, fileKey, encoder.encode(path)));
  const bodyCipher = new Uint8Array(await subtle().encrypt({ name: "AES-GCM", iv: bodyIv }, fileKey, body as BufferSource));
  if (pathCipher.length > 65_535) throw new Error("FILE_TRANSFER");
  const out = new Uint8Array(4 + 12 + wrapped.length + 12 + 2 + pathCipher.length + 12 + bodyCipher.length);
  let offset = 0;
  const put = (part: Uint8Array) => { out.set(part, offset); offset += part.length; };
  put(MAGIC); put(wrapIv); put(wrapped); put(pathIv); put(new Uint8Array([pathCipher.length >> 8, pathCipher.length & 0xff])); put(pathCipher); put(bodyIv); put(bodyCipher);
  return out;
}
export class SyncDecryptError extends Error { constructor(message = "DECRYPT") { super(message); } }
export async function decryptEntry(key: SyncMasterKey, blob: Uint8Array): Promise<{ path: string; body: Uint8Array }> {
  try {
    if (blob.length < 4 + 12 + 48 + 12 + 2 + 12 || blob[0] !== MAGIC[0] || blob[1] !== MAGIC[1] || blob[2] !== MAGIC[2] || blob[3] !== MAGIC[3]) throw new Error("format");
    let offset = 4;
    const take = (n: number) => { const part = new Uint8Array(blob.subarray(offset, offset + n)); offset += n; return part; };
    const wrapIv = take(12), wrapped = take(48);
    const fileKeyRaw = new Uint8Array(await subtle().decrypt({ name: "AES-GCM", iv: wrapIv }, key.wrap, wrapped));
    const fileKey = await subtle().importKey("raw", fileKeyRaw, { name: "AES-GCM" }, false, ["decrypt"]);
    const pathIv = take(12), lengthBytes = take(2), pathLength = (lengthBytes[0] << 8) | lengthBytes[1];
    const path = decoder.decode(await subtle().decrypt({ name: "AES-GCM", iv: pathIv }, fileKey, take(pathLength)));
    const bodyIv = take(12);
    const body = new Uint8Array(await subtle().decrypt({ name: "AES-GCM", iv: bodyIv }, fileKey, new Uint8Array(blob.subarray(offset))));
    return { path, body };
  } catch { throw new SyncDecryptError(); }
}

/** A tiny sealed marker every device uploads once; another device proves its password by opening it. */
export const KEY_CHECK_PATH = "meta/keycheck";
export async function sealKeyCheck(key: SyncMasterKey): Promise<Uint8Array> { return encryptEntry(key, KEY_CHECK_PATH, encoder.encode(`echoink-sync-keycheck:${key.fingerprint}`)); }
export async function verifyKeyCheck(key: SyncMasterKey, blob: Uint8Array): Promise<boolean> {
  try { const { path, body } = await decryptEntry(key, blob); return path === KEY_CHECK_PATH && decoder.decode(body) === `echoink-sync-keycheck:${key.fingerprint}`; } catch { return false; }
}

/** Per-version metadata the service stores opaquely: sealed with the account key, base64. */
export interface CloudVersionMeta {
  /** When the content was last edited on the device that uploaded it (ms). */ readonly editedAt: number;
  /** This version is a folder marker (the folder exists, possibly empty), not a file. */ readonly folder?: boolean;
}
export async function sealMeta(key: SyncMasterKey, meta: CloudVersionMeta): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = new Uint8Array(await subtle().encrypt({ name: "AES-GCM", iv }, key.wrap, encoder.encode(JSON.stringify({ t: meta.editedAt, ...(meta.folder ? { f: 1 } : {}) }))));
  const out = new Uint8Array(12 + cipher.length); out.set(iv); out.set(cipher, 12);
  return bytesToBase64(out);
}
/** Missing or unreadable metadata (older plugins) reads as null; callers fall back to arrival order. */
export async function openMeta(key: SyncMasterKey, sealed: string | undefined): Promise<CloudVersionMeta | null> {
  if (!sealed) return null;
  try {
    const bytes = base64ToBytes(sealed); if (bytes.length < 12 + 16) return null;
    const plain = await subtle().decrypt({ name: "AES-GCM", iv: new Uint8Array(bytes.subarray(0, 12)) }, key.wrap, new Uint8Array(bytes.subarray(12)));
    const parsed = JSON.parse(decoder.decode(plain)) as { t?: unknown; f?: unknown };
    return typeof parsed.t === "number" && Number.isFinite(parsed.t) ? { editedAt: parsed.t, ...(parsed.f === 1 ? { folder: true } : {}) } : null;
  } catch { return null; }
}
