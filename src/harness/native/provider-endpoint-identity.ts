import { createHash } from "node:crypto";

const SAFE_DURABLE_DIGEST = /^endpoint-sha256:[a-f0-9]{64}$/;
const SAFE_INTERNAL_ENDPOINTS = new Set(["codex-login"]);
const SAFE_HERMES_ACP_ENDPOINT =
  /^hermes-acp\+stdio:\/\/local\/[a-z0-9._~%+-]+$/i;

/**
 * Produces the stable, non-secret endpoint identity persisted in Native
 * records. Provider credentials and scoped base paths remain available only
 * to the live transport settings. A bare HTTP(S) origin is safe to retain;
 * every scoped, credential-bearing, query-bearing, fragment-bearing, invalid,
 * or otherwise opaque endpoint is represented only by a deterministic digest.
 */
export function canonicalProviderEndpointIdentity(
  endpoint: string | undefined
): string {
  const raw = endpoint?.trim() ?? "";
  if (!raw) return "";
  if (SAFE_DURABLE_DIGEST.test(raw)) return raw;
  if (SAFE_INTERNAL_ENDPOINTS.has(raw)) return raw;
  if (SAFE_HERMES_ACP_ENDPOINT.test(raw)) return raw;

  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return hashedEndpointIdentity(raw);
    }
    const origin = parsed.origin.replace(/\/$/, "");
    const hasScopedOrSensitiveIdentity = (
      parsed.pathname !== "/"
      || Boolean(parsed.username)
      || Boolean(parsed.password)
      || Boolean(parsed.search)
      || Boolean(parsed.hash)
    );
    if (!hasScopedOrSensitiveIdentity) return origin;
    return hashedEndpointIdentity(JSON.stringify({
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port,
      pathname: parsed.pathname,
      username: parsed.username,
      password: parsed.password,
      search: parsed.search,
      hash: parsed.hash
    }));
  } catch {
    return hashedEndpointIdentity(raw);
  }
}

function hashedEndpointIdentity(endpoint: string): string {
  return `endpoint-sha256:${digestEndpointIdentity(endpoint)}`;
}

function digestEndpointIdentity(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
