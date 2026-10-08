import type { DeviceIdentity, LeaseClaims, MembershipSigningKey } from "./types";
const encoder = new TextEncoder();
export function encode(bytes: Uint8Array): string {
  let s = "";
  for (const byte of bytes) s += String.fromCharCode(byte);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
export function decode(s: string): Uint8Array {
  const plain = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(plain, (c) => c.charCodeAt(0));
}
export async function deviceIdentity(): Promise<DeviceIdentity> {
  const key = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  return {
    publicKey: await crypto.subtle.exportKey("jwk", key.publicKey),
    privateKey: await crypto.subtle.exportKey("jwk", key.privateKey),
  };
}
export async function keyHash(publicKey: JsonWebKey): Promise<string> {
  const canonical = JSON.stringify({
    kty: "EC",
    crv: "P-256",
    x: publicKey.x,
    y: publicKey.y,
  });
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", encoder.encode(canonical)),
    ),
    (x) => x.toString(16).padStart(2, "0"),
  ).join("");
}
export async function signProof(
  identity: DeviceIdentity,
  id: string,
  nonce: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "jwk",
    identity.privateKey,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  return encode(
    new Uint8Array(
      await crypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        key,
        encoder.encode(`echoink-device-v1\n${id}\n${nonce}`),
      ),
    ),
  );
}
export async function verifyLease(
  token: string,
  keys: readonly MembershipSigningKey[],
  accountId: string,
  identity: DeviceIdentity,
  now: number,
): Promise<LeaseClaims> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("LEASE_INVALID");
  const header = JSON.parse(new TextDecoder().decode(decode(parts[0]))) as { kid: string; alg: string; typ: string },
    claims = JSON.parse(
      new TextDecoder().decode(decode(parts[1])),
    ) as LeaseClaims;
  const source = keys.find((k) => k.kid === header.kid && k.alg === "ES256");
  if (header.alg !== "ES256" || header.typ !== "JWT" || !source)
    throw new Error("LEASE_INVALID");
  const key = await crypto.subtle.importKey(
    "jwk",
    source.publicKey,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  if (
    !(await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      decode(parts[2]) as BufferSource,
      encoder.encode(`${parts[0]}.${parts[1]}`),
    ))
  )
    throw new Error("LEASE_INVALID");
  if (
    claims.schema !== 1 ||
    claims.iss !== "echoink" ||
    claims.sub !== accountId ||
    claims.keyHash !== (await keyHash(identity.publicKey)) ||
    claims.major !== 2 ||
    !Array.isArray(claims.capabilities) ||
    !Number.isSafeInteger(claims.exp) ||
    !Number.isSafeInteger(claims.iat) ||
    claims.exp <= claims.iat ||
    claims.exp - claims.iat > 7 * 86400000 ||
    claims.iat > now + 300000
  )
    throw new Error("LEASE_INVALID");
  if (claims.exp <= now) throw new Error("LEASE_EXPIRED");
  return claims;
}
