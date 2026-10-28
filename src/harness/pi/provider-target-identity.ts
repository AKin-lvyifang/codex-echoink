import { getDesktopCrypto } from "../../platform/desktop-crypto";
import { getDesktopNet } from "../../platform/desktop-network";

import { getDesktopUrl } from "../../platform/desktop-paths";

const { createHash } = getDesktopCrypto();
const { isIP } = getDesktopNet();

const { domainToASCII } = getDesktopUrl();

const TARGET_IDENTITY_PREFIX = "echoink-target-identity-v1\0";
const PATH_SCOPE_PREFIX = "echoink-path-scope-v1\0";
export const TARGET_IDENTITY_DIGEST_PATTERN = /^[a-f0-9]{64}$/u;

export type ProviderNetworkClass = "cloud_public" | "local_loopback";
export type ProviderTransport = "https" | "http" | "sse" | "websocket";
export type ProviderRedirectMode = "deny" | "same_origin_manual";
export type ProviderRouteMode = "direct" | "proxy";
export type ProxyTransport = "http" | "https";
export type ProxyTunnelMode =
  | "http_connect_pinned"
  | "https_connect_pinned";

export interface CanonicalProviderEndpoint {
  canonicalOrigin: string;
  canonicalPathPrefix: string;
  pathScopeDigest: string;
  scheme: "http" | "https";
  hostAscii: string;
  effectivePort: number;
}

export interface ProviderTargetIdentityV1 {
  schemaVersion: 1;
  providerId: string;
  endpointRevision: number;
  canonicalOrigin: string;
  pathScopeDigest: string;
  networkClass: ProviderNetworkClass;
  transport: ProviderTransport;
  redirectMode: ProviderRedirectMode;
  redirectMaxHops: 0 | 2;
  routeMode: ProviderRouteMode;
  proxyTargetIdentityDigest: string | null;
}

export interface ProxyTargetIdentityV1 {
  schemaVersion: 1;
  endpointRevision: number;
  canonicalOrigin: string;
  networkClass: ProviderNetworkClass;
  transport: ProxyTransport;
  tunnelMode: ProxyTunnelMode;
}

export interface ProviderTargetIdentityInput {
  providerId: string;
  endpointRevision: number;
  endpoint: string;
  networkClass: ProviderNetworkClass;
  transport: ProviderTransport;
  redirectMode: ProviderRedirectMode;
  redirectMaxHops: number;
  routeMode: ProviderRouteMode;
  proxyTargetIdentityDigest?: string | null;
}

export interface ProxyTargetIdentityInput {
  endpointRevision: number;
  endpoint: string;
  networkClass: ProviderNetworkClass;
  transport: ProxyTransport;
  tunnelMode: ProxyTunnelMode;
}

export interface ProviderTargetIdentityResult {
  identity: Readonly<ProviderTargetIdentityV1>;
  canonicalPathPrefix: string;
  digest: string;
}

export interface ProxyTargetIdentityResult {
  identity: Readonly<ProxyTargetIdentityV1>;
  canonicalPathPrefix: string;
  digest: string;
}

export type ProviderTargetIdentityErrorCode =
  | "endpoint_invalid"
  | "endpoint_contains_forbidden_component"
  | "endpoint_scheme_unsupported"
  | "endpoint_host_invalid"
  | "endpoint_host_ambiguous"
  | "endpoint_path_ambiguous"
  | "provider_target_incomplete"
  | "proxy_target_incomplete"
  | "proxy_target_digest_required"
  | "proxy_target_digest_forbidden"
  | "target_identity_value_invalid";

export class ProviderTargetIdentityError extends Error {
  constructor(readonly code: ProviderTargetIdentityErrorCode) {
    super(code);
    this.name = "ProviderTargetIdentityError";
  }
}

/**
 * Produces RFC 8785-compatible JSON for the JSON subset used by the frozen
 * Provider Target Identity contract. Unsupported values fail closed instead
 * of being omitted or coerced.
 */
export function jcsCanonicalize(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") {
    assertValidUnicode(value);
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw targetError("target_identity_value_invalid");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const entries: string[] = [];
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.prototype.hasOwnProperty.call(value, index)) {
        throw targetError("target_identity_value_invalid");
      }
      entries.push(jcsCanonicalize(value[index]));
    }
    return `[${entries.join(",")}]`;
  }
  if (!isPlainRecord(value)) {
    throw targetError("target_identity_value_invalid");
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw targetError("target_identity_value_invalid");
  }
  const fields = Object.keys(value)
    .sort()
    .map((key) => {
      assertValidUnicode(key);
      return `${JSON.stringify(key)}:${jcsCanonicalize(value[key])}`;
    });
  return `{${fields.join(",")}}`;
}

export function canonicalizeProviderEndpoint(
  endpoint: string
): CanonicalProviderEndpoint {
  if (
    typeof endpoint !== "string"
    || !endpoint
    || endpoint.includes("\\")
    || hasAsciiControlCharacter(endpoint)
  ) {
    throw targetError("endpoint_path_ambiguous");
  }
  const originalHost = rawHostname(endpoint);
  rejectAmbiguousNumericIpv4(originalHost);

  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw targetError("endpoint_invalid");
  }
  if (
    parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
  ) {
    throw targetError("endpoint_contains_forbidden_component");
  }
  const protocol = parsed.protocol.toLowerCase();
  if (protocol !== "https:" && protocol !== "http:") {
    throw targetError("endpoint_scheme_unsupported");
  }

  const hostWithoutTrailingDot = parsed.hostname
    .replace(/\.$/u, "")
    .toLowerCase();
  const hostAscii = domainToASCII(hostWithoutTrailingDot);
  if (!hostAscii) throw targetError("endpoint_host_invalid");
  const normalizedOriginalHost = originalHost
    ?.replace(/\.$/u, "")
    .toLowerCase();
  if (isIP(hostAscii) === 4 && normalizedOriginalHost !== hostAscii) {
    throw targetError("endpoint_host_ambiguous");
  }

  const rawPath = parsed.pathname || "/";
  if (
    /%(?![0-9a-fA-F]{2})/u.test(rawPath)
    || /%2f|%5c/iu.test(rawPath)
    || /%(?:0[0-9a-f]|1[0-9a-f]|7f)/iu.test(rawPath)
  ) {
    throw targetError("endpoint_path_ambiguous");
  }
  const canonicalPath = rawPath.replace(
    /%[0-9a-fA-F]{2}/gu,
    (encoded) => encoded.toUpperCase()
  );
  const canonicalPathPrefix = canonicalPath.endsWith("/")
    ? canonicalPath
    : `${canonicalPath}/`;
  const scheme = protocol === "https:" ? "https" : "http";
  const effectivePortText = parsed.port || (scheme === "https" ? "443" : "80");
  const effectivePort = Number(effectivePortText);
  if (
    !Number.isSafeInteger(effectivePort)
    || effectivePort < 1
    || effectivePort > 65535
  ) {
    throw targetError("endpoint_invalid");
  }
  const canonicalOrigin = `${scheme}://${hostAscii}:${effectivePort}`;

  return Object.freeze({
    canonicalOrigin,
    canonicalPathPrefix,
    pathScopeDigest: sha256LowerHex(
      `${PATH_SCOPE_PREFIX}${canonicalPathPrefix}`
    ),
    scheme,
    hostAscii,
    effectivePort
  });
}

export function createProviderTargetIdentity(
  input: ProviderTargetIdentityInput
): ProviderTargetIdentityResult {
  const endpoint = canonicalizeProviderEndpoint(input.endpoint);
  if (
    !safeProviderId(input.providerId)
    || !positiveRevision(input.endpointRevision)
    || !isNetworkClass(input.networkClass)
    || !isProviderTransport(input.transport)
    || !isRedirectMode(input.redirectMode)
    || !isRouteMode(input.routeMode)
    || !providerEndpointPolicyMatches(
      endpoint,
      input.networkClass,
      input.transport
    )
    || (
      input.redirectMode === "deny"
      && input.redirectMaxHops !== 0
    )
    || (
      input.redirectMode === "same_origin_manual"
      && input.redirectMaxHops !== 2
    )
  ) {
    throw targetError("provider_target_incomplete");
  }

  let proxyTargetIdentityDigest: string | null;
  if (input.routeMode === "proxy") {
    if (
      typeof input.proxyTargetIdentityDigest !== "string"
      || !TARGET_IDENTITY_DIGEST_PATTERN.test(
        input.proxyTargetIdentityDigest
      )
    ) {
      throw targetError("proxy_target_digest_required");
    }
    proxyTargetIdentityDigest = input.proxyTargetIdentityDigest;
  } else {
    if (
      input.proxyTargetIdentityDigest !== undefined
      && input.proxyTargetIdentityDigest !== null
    ) {
      throw targetError("proxy_target_digest_forbidden");
    }
    proxyTargetIdentityDigest = null;
  }

  const identity: ProviderTargetIdentityV1 = {
    schemaVersion: 1,
    providerId: input.providerId,
    endpointRevision: input.endpointRevision,
    canonicalOrigin: endpoint.canonicalOrigin,
    pathScopeDigest: endpoint.pathScopeDigest,
    networkClass: input.networkClass,
    transport: input.transport,
    redirectMode: input.redirectMode,
    redirectMaxHops: input.redirectMaxHops as 0 | 2,
    routeMode: input.routeMode,
    proxyTargetIdentityDigest
  };
  const frozenIdentity = Object.freeze(identity);
  return Object.freeze({
    identity: frozenIdentity,
    canonicalPathPrefix: endpoint.canonicalPathPrefix,
    digest: targetIdentityDigest(frozenIdentity)
  });
}

export function createProxyTargetIdentity(
  input: ProxyTargetIdentityInput
): ProxyTargetIdentityResult {
  const endpoint = canonicalizeProviderEndpoint(input.endpoint);
  if (
    !positiveRevision(input.endpointRevision)
    || !isNetworkClass(input.networkClass)
    || !isProxyTransport(input.transport)
    || !isProxyTunnelMode(input.tunnelMode)
    || !endpointNetworkClassMatches(endpoint, input.networkClass)
    || endpoint.scheme !== input.transport
    || (
      input.transport === "http"
      && input.tunnelMode !== "http_connect_pinned"
    )
    || (
      input.transport === "https"
      && input.tunnelMode !== "https_connect_pinned"
    )
  ) {
    throw targetError("proxy_target_incomplete");
  }

  const identity: ProxyTargetIdentityV1 = {
    schemaVersion: 1,
    endpointRevision: input.endpointRevision,
    canonicalOrigin: endpoint.canonicalOrigin,
    networkClass: input.networkClass,
    transport: input.transport,
    tunnelMode: input.tunnelMode
  };
  const frozenIdentity = Object.freeze(identity);
  return Object.freeze({
    identity: frozenIdentity,
    canonicalPathPrefix: endpoint.canonicalPathPrefix,
    digest: targetIdentityDigest(frozenIdentity)
  });
}

export function targetIdentityDigest(
  identity: ProviderTargetIdentityV1 | ProxyTargetIdentityV1
): string {
  return sha256LowerHex(
    `${TARGET_IDENTITY_PREFIX}${jcsCanonicalize(identity)}`
  );
}

function rawHostname(input: string): string | null {
  const authority = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/?#]*)/u.exec(input)?.[1];
  if (!authority || authority.includes("@")) return null;
  if (authority.startsWith("[")) {
    const close = authority.indexOf("]");
    return close < 0 ? null : authority.slice(0, close + 1);
  }
  const lastColon = authority.lastIndexOf(":");
  return lastColon >= 0 ? authority.slice(0, lastColon) : authority;
}

function rejectAmbiguousNumericIpv4(rawHost: string | null): void {
  if (!rawHost || rawHost.startsWith("[")) return;
  const withoutTrailingDot = rawHost.endsWith(".")
    ? rawHost.slice(0, -1)
    : rawHost;
  const components = withoutTrailingDot.split(".");
  const numericToken = /^(?:0[xX][0-9a-fA-F]+|[0-9]+)$/u;
  if (!components.every((component) => numericToken.test(component))) return;
  const canonical = (
    !rawHost.endsWith(".")
    && components.length === 4
    && components.every((component) => (
      /^(?:0|[1-9][0-9]{0,2})$/u.test(component)
      && Number(component) <= 255
    ))
  );
  if (!canonical) throw targetError("endpoint_host_ambiguous");
}

function targetError(
  code: ProviderTargetIdentityErrorCode
): ProviderTargetIdentityError {
  return new ProviderTargetIdentityError(code);
}

function sha256LowerHex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Reflect.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertValidUnicode(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw targetError("target_identity_value_invalid");
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw targetError("target_identity_value_invalid");
    }
  }
}

function safeProviderId(value: unknown): value is string {
  return (
    typeof value === "string"
    && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value)
  );
}

function positiveRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 1;
}

function isNetworkClass(value: unknown): value is ProviderNetworkClass {
  return value === "cloud_public" || value === "local_loopback";
}

function isProviderTransport(value: unknown): value is ProviderTransport {
  return (
    value === "https"
    || value === "http"
    || value === "sse"
    || value === "websocket"
  );
}

function isProxyTransport(value: unknown): value is ProxyTransport {
  return value === "http" || value === "https";
}

function isProxyTunnelMode(value: unknown): value is ProxyTunnelMode {
  return (
    value === "http_connect_pinned"
    || value === "https_connect_pinned"
  );
}

function isRedirectMode(value: unknown): value is ProviderRedirectMode {
  return value === "deny" || value === "same_origin_manual";
}

function isRouteMode(value: unknown): value is ProviderRouteMode {
  return value === "direct" || value === "proxy";
}

function providerEndpointPolicyMatches(
  endpoint: CanonicalProviderEndpoint,
  networkClass: ProviderNetworkClass,
  transport: ProviderTransport
): boolean {
  if (!endpointNetworkClassMatches(endpoint, networkClass)) return false;
  if (networkClass === "cloud_public") {
    return endpoint.scheme === "https" && transport !== "http";
  }
  return true;
}

function endpointNetworkClassMatches(
  endpoint: CanonicalProviderEndpoint,
  networkClass: ProviderNetworkClass
): boolean {
  const classified = classifyStaticHost(endpoint.hostAscii);
  return classified === networkClass;
}

function classifyStaticHost(
  hostAscii: string
): ProviderNetworkClass | null {
  if (hostAscii === "localhost") return "local_loopback";
  const address = hostAscii.startsWith("[") && hostAscii.endsWith("]")
    ? hostAscii.slice(1, -1)
    : hostAscii;
  const family = isIP(address);
  if (family === 4) {
    const octets = address.split(".").map(Number);
    if (octets[0] === 127) return "local_loopback";
    return isPublicUnicastIpv4(octets) ? "cloud_public" : null;
  }
  if (family === 6) {
    const words = parseIpv6Words(address);
    if (!words) return null;
    if (isIpv6Loopback(words)) return "local_loopback";
    return isPublicUnicastIpv6(words) ? "cloud_public" : null;
  }
  return "cloud_public";
}

function isPublicUnicastIpv4(octets: number[]): boolean {
  const [a, b, c] = octets;
  return !(
    a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0 && c === 0)
    || (a === 192 && b === 0 && c === 2)
    || (a === 192 && b === 31 && c === 196)
    || (a === 192 && b === 52 && c === 193)
    || (a === 192 && b === 88 && c === 99)
    || (a === 192 && b === 168)
    || (a === 192 && b === 175 && c === 48)
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113)
    || a >= 224
  );
}

function isPublicUnicastIpv6(words: number[]): boolean {
  if (
    isIpv4MappedIpv6(words)
    || words.every((word) => word === 0)
    || (
      words[0] === 0x0064
      && words[1] === 0xff9b
      && (
        words[2] === 0x0001
        || words.slice(2, 6).every((word) => word === 0)
      )
    )
    || (
      words[0] === 0x0100
      && words.slice(1, 4).every((word) => word === 0)
    )
    || (words[0] & 0xfe00) === 0xfc00
    || (words[0] & 0xffc0) === 0xfe80
    || (words[0] & 0xff00) === 0xff00
    || (words[0] === 0x2001 && words[1] <= 0x01ff)
    || (words[0] === 0x2001 && words[1] === 0x0db8)
    || words[0] === 0x2002
    || (words[0] & 0xfff0) === 0x3ff0
    || words[0] === 0x5f00
  ) {
    return false;
  }
  return (words[0] & 0xe000) === 0x2000;
}

function isIpv6Loopback(words: number[]): boolean {
  return words.slice(0, 7).every((word) => word === 0)
    && words[7] === 1;
}

function isIpv4MappedIpv6(words: number[]): boolean {
  return words.slice(0, 5).every((word) => word === 0)
    && words[5] === 0xffff;
}

function parseIpv6Words(address: string): number[] | null {
  const halves = address.split("::");
  if (halves.length > 2) return null;
  const left = parseIpv6Side(halves[0]);
  const right = parseIpv6Side(halves[1] ?? "");
  if (!left || !right) return null;
  const missing = 8 - left.length - right.length;
  if (
    (halves.length === 1 && missing !== 0)
    || (halves.length === 2 && missing < 1)
  ) {
    return null;
  }
  return [...left, ...new Array<number>(missing).fill(0), ...right];
}

function hasAsciiControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function parseIpv6Side(side: string): number[] | null {
  if (!side) return [];
  const tokens = side.split(":");
  const words: number[] = [];
  for (const [index, token] of tokens.entries()) {
    if (token.includes(".")) {
      if (index !== tokens.length - 1 || isIP(token) !== 4) return null;
      const octets = token.split(".").map(Number);
      words.push(
        (octets[0] << 8) | octets[1],
        (octets[2] << 8) | octets[3]
      );
      continue;
    }
    if (!/^[0-9a-f]{1,4}$/iu.test(token)) return null;
    words.push(Number.parseInt(token, 16));
  }
  return words;
}
