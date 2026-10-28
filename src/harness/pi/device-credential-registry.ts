import { getDesktopCrypto } from "../../platform/desktop-crypto";
import {
  TARGET_IDENTITY_DIGEST_PATTERN,
  canonicalizeProviderEndpoint,
  jcsCanonicalize,
  type ProviderTransport
} from "./provider-target-identity";

const { createHash, randomBytes } = getDesktopCrypto();

export const ECHOINK_CREDENTIAL_OWNER_NAMESPACE = "codex-echoink" as const;
export const DEVICE_CREDENTIAL_REGISTRY_SCHEMA_VERSION = 1 as const;
export const DEVICE_CREDENTIAL_REGISTRY_RECORD_TYPE =
  "echoink-device-credential-registry" as const;
export const CREDENTIAL_REF_PATTERN = /^cred-[a-f0-9]{32}$/u;
export const SECRET_ID_PATTERN =
  /^codex-echoink-secret-[a-f0-9]{32}$/u;
export const DEVICE_CREDENTIAL_REGISTRY_DIGEST_PATTERN =
  /^sha256:[a-f0-9]{64}$/u;

const REGISTRY_KEYS = new Set([
  "schemaVersion",
  "recordType",
  "ownerNamespace",
  "deviceIdDigest",
  "vaultIdDigest",
  "revision",
  "previousDigest",
  "commitId",
  "entries",
  "digest"
]);
const ENTRY_KEYS = new Set([
  "credentialRef",
  "secretId",
  "purpose",
  "audience",
  "state",
  "createdAt",
  "rotatedAt"
]);
const AUDIENCE_KEYS = new Set([
  "kind",
  "bindingIdDigest",
  "endpointId",
  "endpointRevision",
  "canonicalOrigin",
  "pathPrefixDigest",
  "transport",
  "credentialTargetIdentityDigest",
  "proxyTargetIdentityDigest"
]);

export type CredentialPurpose =
  | "provider_api_key"
  | "proxy_auth"
  | "mcp_header"
  | "mcp_env"
  | "oauth";
export type CredentialAudienceKind = "provider" | "proxy" | "mcp" | "oauth";
export type DeviceCredentialState =
  | "prepared"
  | "write_intent"
  | "secret_written"
  | "secret_readback_verified"
  | "active"
  | "revoked"
  | "orphaned"
  | "poisoned"
  | "physical_delete_unverified";

export interface CredentialAudience {
  kind: CredentialAudienceKind;
  bindingIdDigest: string;
  endpointId: string;
  endpointRevision: number;
  canonicalOrigin: string;
  pathPrefixDigest: string;
  transport: ProviderTransport;
  credentialTargetIdentityDigest: string | null;
  proxyTargetIdentityDigest: string | null;
}

export interface DeviceCredentialRegistryEntry {
  credentialRef: string;
  secretId: string;
  purpose: CredentialPurpose;
  audience: CredentialAudience;
  state: DeviceCredentialState;
  createdAt: string;
  rotatedAt: string | null;
}

export interface DeviceCredentialRegistryV1 {
  schemaVersion: typeof DEVICE_CREDENTIAL_REGISTRY_SCHEMA_VERSION;
  recordType: typeof DEVICE_CREDENTIAL_REGISTRY_RECORD_TYPE;
  ownerNamespace: string;
  deviceIdDigest: string;
  vaultIdDigest: string;
  revision: number;
  previousDigest: string | null;
  commitId: string;
  entries: readonly DeviceCredentialRegistryEntry[];
  digest: string;
}

export interface CreateDeviceCredentialRegistryInput {
  deviceIdDigest: string;
  vaultIdDigest: string;
  revision: number;
  previousDigest: string | null;
  commitId: string;
  entries: readonly DeviceCredentialRegistryEntry[];
}

export interface DeviceCredentialRegistryReaderPort {
  readRegistry(input: {
    deviceIdDigest: string;
    vaultIdDigest: string;
  }): Promise<unknown>;
}

export interface SecretStorageReaderPort {
  getSecret(
    secretId: string
  ): string | null | undefined | Promise<string | null | undefined>;
}

export interface DeviceCredentialResolveInput {
  credentialRef: string;
  deviceIdDigest: string;
  vaultIdDigest: string;
  purpose: CredentialPurpose;
  audience: CredentialAudience;
  expectedRegistryRevision: number;
  expectedRegistryDigest: string;
}

export type CredentialSecurityErrorCode =
  | "credential_registry_poisoned"
  | "credential_owner_mismatch"
  | "credential_audience_mismatch";

export class CredentialSecurityError extends Error {
  constructor(readonly code: CredentialSecurityErrorCode) {
    super(code);
    this.name = "CredentialSecurityError";
  }
}

/**
 * Reads one immutable Registry snapshot and resolves at most one exact Secret
 * ID. Every ownership, CAS, state, and audience check completes before the
 * SecretStorage port becomes reachable.
 */
export class DeviceCredentialResolver {
  constructor(
    private readonly options: {
      registryReader: DeviceCredentialRegistryReaderPort;
      secretStorage: SecretStorageReaderPort;
    }
  ) {
    if (
      typeof options?.registryReader?.readRegistry !== "function"
      || typeof options?.secretStorage?.getSecret !== "function"
    ) {
      throw credentialError("credential_registry_poisoned");
    }
  }

  async resolve(input: DeviceCredentialResolveInput): Promise<string> {
    assertResolveInputShape(input);
    let expectedAudience: CredentialAudience;
    try {
      expectedAudience = parseCredentialAudience(
        input.audience,
        input.purpose
      );
    } catch {
      throw credentialError("credential_audience_mismatch");
    }

    let rawRegistry: unknown;
    try {
      rawRegistry = await this.options.registryReader.readRegistry({
        deviceIdDigest: input.deviceIdDigest,
        vaultIdDigest: input.vaultIdDigest
      });
    } catch {
      throw credentialError("credential_registry_poisoned");
    }

    const registry = parseDeviceCredentialRegistry(rawRegistry);
    if (
      registry.ownerNamespace !== ECHOINK_CREDENTIAL_OWNER_NAMESPACE
      || registry.deviceIdDigest !== input.deviceIdDigest
      || registry.vaultIdDigest !== input.vaultIdDigest
    ) {
      throw credentialError("credential_owner_mismatch");
    }
    if (
      registry.revision !== input.expectedRegistryRevision
      || registry.digest !== input.expectedRegistryDigest
    ) {
      throw credentialError("credential_registry_poisoned");
    }

    const entry = registry.entries.find(
      (candidate) => candidate.credentialRef === input.credentialRef
    );
    if (!entry || entry.state !== "active") {
      throw credentialError("credential_registry_poisoned");
    }
    if (
      entry.purpose !== input.purpose
      || jcsCanonicalize(entry.audience) !== jcsCanonicalize(expectedAudience)
    ) {
      throw credentialError("credential_audience_mismatch");
    }

    let secret: string | null | undefined;
    try {
      secret = await this.options.secretStorage.getSecret(entry.secretId);
    } catch {
      throw credentialError("credential_registry_poisoned");
    }
    if (typeof secret !== "string" || secret.length === 0) {
      throw credentialError("credential_registry_poisoned");
    }
    return secret;
  }
}

export function createCredentialRef(): string {
  return `cred-${randomBytes(16).toString("hex")}`;
}

export function createSecretId(): string {
  return `codex-echoink-secret-${randomBytes(16).toString("hex")}`;
}

export function createDeviceCredentialRegistry(
  input: CreateDeviceCredentialRegistryInput
): DeviceCredentialRegistryV1 {
  const draft = {
    schemaVersion: DEVICE_CREDENTIAL_REGISTRY_SCHEMA_VERSION,
    recordType: DEVICE_CREDENTIAL_REGISTRY_RECORD_TYPE,
    ownerNamespace: ECHOINK_CREDENTIAL_OWNER_NAMESPACE,
    deviceIdDigest: input.deviceIdDigest,
    vaultIdDigest: input.vaultIdDigest,
    revision: input.revision,
    previousDigest: input.previousDigest,
    commitId: input.commitId,
    entries: input.entries
  };
  return parseDeviceCredentialRegistry({
    ...draft,
    digest: deviceCredentialRegistryDigest(draft)
  });
}

export function parseDeviceCredentialRegistry(
  value: unknown
): DeviceCredentialRegistryV1 {
  const record = requireRecord(value);
  assertExactKeys(record, REGISTRY_KEYS);
  if (
    record.schemaVersion !== DEVICE_CREDENTIAL_REGISTRY_SCHEMA_VERSION
    || record.recordType !== DEVICE_CREDENTIAL_REGISTRY_RECORD_TYPE
    || !safeIdentifier(record.ownerNamespace)
    || !deviceScopeDigest(record.deviceIdDigest)
    || !deviceScopeDigest(record.vaultIdDigest)
    || !positiveRevision(record.revision)
    || !safeIdentifier(record.commitId)
    || !Array.isArray(record.entries)
    || typeof record.digest !== "string"
    || !DEVICE_CREDENTIAL_REGISTRY_DIGEST_PATTERN.test(record.digest)
  ) {
    throw credentialError("credential_registry_poisoned");
  }
  const previousDigest = record.previousDigest;
  if (
    (record.revision === 1 && previousDigest !== null)
    || (
      record.revision > 1
      && (
        typeof previousDigest !== "string"
        || !DEVICE_CREDENTIAL_REGISTRY_DIGEST_PATTERN.test(previousDigest)
      )
    )
  ) {
    throw credentialError("credential_registry_poisoned");
  }

  const entries = record.entries.map((entry) =>
    parseDeviceCredentialRegistryEntry(entry)
  );
  const credentialRefs = new Set(entries.map((entry) => entry.credentialRef));
  const secretIds = new Set(entries.map((entry) => entry.secretId));
  if (
    credentialRefs.size !== entries.length
    || secretIds.size !== entries.length
  ) {
    throw credentialError("credential_registry_poisoned");
  }

  const parsed: DeviceCredentialRegistryV1 = {
    schemaVersion: DEVICE_CREDENTIAL_REGISTRY_SCHEMA_VERSION,
    recordType: DEVICE_CREDENTIAL_REGISTRY_RECORD_TYPE,
    ownerNamespace: record.ownerNamespace,
    deviceIdDigest: record.deviceIdDigest,
    vaultIdDigest: record.vaultIdDigest,
    revision: record.revision,
    previousDigest: previousDigest as string | null,
    commitId: record.commitId,
    entries: Object.freeze(entries),
    digest: record.digest
  };
  const { digest: _digest, ...withoutDigest } = parsed;
  if (parsed.digest !== deviceCredentialRegistryDigest(withoutDigest)) {
    throw credentialError("credential_registry_poisoned");
  }
  return deepFreezeRegistry(parsed);
}

export function deviceCredentialRegistryDigest(value: unknown): string {
  return `sha256:${createHash("sha256")
    .update(jcsCanonicalize(value), "utf8")
    .digest("hex")}`;
}

function parseDeviceCredentialRegistryEntry(
  value: unknown
): DeviceCredentialRegistryEntry {
  const record = requireRecord(value);
  assertExactKeys(record, ENTRY_KEYS);
  if (
    typeof record.credentialRef !== "string"
    || !CREDENTIAL_REF_PATTERN.test(record.credentialRef)
    || typeof record.secretId !== "string"
    || !SECRET_ID_PATTERN.test(record.secretId)
    || !isCredentialPurpose(record.purpose)
    || !isCredentialState(record.state)
    || !validIsoTime(record.createdAt)
    || !(record.rotatedAt === null || validIsoTime(record.rotatedAt))
  ) {
    throw credentialError("credential_registry_poisoned");
  }
  return Object.freeze({
    credentialRef: record.credentialRef,
    secretId: record.secretId,
    purpose: record.purpose,
    audience: parseCredentialAudience(record.audience, record.purpose),
    state: record.state,
    createdAt: record.createdAt,
    rotatedAt: record.rotatedAt
  });
}

function parseCredentialAudience(
  value: unknown,
  purpose: CredentialPurpose
): CredentialAudience {
  const record = requireRecord(value);
  assertExactKeys(record, AUDIENCE_KEYS);
  if (
    !isAudienceKind(record.kind)
    || typeof record.bindingIdDigest !== "string"
    || !TARGET_IDENTITY_DIGEST_PATTERN.test(record.bindingIdDigest)
    || !safeIdentifier(record.endpointId)
    || !positiveRevision(record.endpointRevision)
    || !canonicalOrigin(record.canonicalOrigin)
    || typeof record.pathPrefixDigest !== "string"
    || !TARGET_IDENTITY_DIGEST_PATTERN.test(record.pathPrefixDigest)
    || !isProviderTransport(record.transport)
    || !purposeMatchesKind(purpose, record.kind)
  ) {
    throw credentialError("credential_registry_poisoned");
  }
  const credentialTargetIdentityDigest =
    nullableTargetIdentityDigest(record.credentialTargetIdentityDigest);
  const proxyTargetIdentityDigest =
    nullableTargetIdentityDigest(record.proxyTargetIdentityDigest);
  if (
    record.kind === "proxy"
      ? (
        credentialTargetIdentityDigest !== null
        || proxyTargetIdentityDigest === null
        || record.bindingIdDigest !== proxyTargetIdentityDigest
      )
      : (
        credentialTargetIdentityDigest === null
        || proxyTargetIdentityDigest !== null
        || record.bindingIdDigest !== credentialTargetIdentityDigest
      )
  ) {
    throw credentialError("credential_registry_poisoned");
  }
  return Object.freeze({
    kind: record.kind,
    bindingIdDigest: record.bindingIdDigest,
    endpointId: record.endpointId,
    endpointRevision: record.endpointRevision,
    canonicalOrigin: record.canonicalOrigin,
    pathPrefixDigest: record.pathPrefixDigest,
    transport: record.transport,
    credentialTargetIdentityDigest,
    proxyTargetIdentityDigest
  });
}

function assertResolveInputShape(
  input: DeviceCredentialResolveInput
): void {
  if (
    !input
    || typeof input.credentialRef !== "string"
    || !CREDENTIAL_REF_PATTERN.test(input.credentialRef)
    || !deviceScopeDigest(input.deviceIdDigest)
    || !deviceScopeDigest(input.vaultIdDigest)
    || !isCredentialPurpose(input.purpose)
    || !positiveRevision(input.expectedRegistryRevision)
    || !DEVICE_CREDENTIAL_REGISTRY_DIGEST_PATTERN.test(
      input.expectedRegistryDigest
    )
  ) {
    throw credentialError("credential_registry_poisoned");
  }
}

function nullableTargetIdentityDigest(value: unknown): string | null {
  if (value === null) return null;
  if (
    typeof value !== "string"
    || !TARGET_IDENTITY_DIGEST_PATTERN.test(value)
  ) {
    throw credentialError("credential_registry_poisoned");
  }
  return value;
}

function canonicalOrigin(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    return canonicalizeProviderEndpoint(value).canonicalOrigin === value;
  } catch {
    return false;
  }
}

function purposeMatchesKind(
  purpose: CredentialPurpose,
  kind: CredentialAudienceKind
): boolean {
  if (purpose === "provider_api_key") return kind === "provider";
  if (purpose === "proxy_auth") return kind === "proxy";
  if (purpose === "mcp_header" || purpose === "mcp_env") return kind === "mcp";
  return kind === "oauth";
}

function credentialError(
  code: CredentialSecurityErrorCode
): CredentialSecurityError {
  return new CredentialSecurityError(code);
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
  ) {
    throw credentialError("credential_registry_poisoned");
  }
  const prototype = Reflect.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw credentialError("credential_registry_poisoned");
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(
  record: Record<string, unknown>,
  expected: ReadonlySet<string>
): void {
  const keys = Object.keys(record);
  if (
    keys.length !== expected.size
    || keys.some((key) => !expected.has(key))
  ) {
    throw credentialError("credential_registry_poisoned");
  }
}

function deepFreezeRegistry(
  registry: DeviceCredentialRegistryV1
): DeviceCredentialRegistryV1 {
  for (const entry of registry.entries) {
    Object.freeze(entry.audience);
    Object.freeze(entry);
  }
  Object.freeze(registry.entries);
  return Object.freeze(registry);
}

function deviceScopeDigest(value: unknown): value is string {
  return (
    typeof value === "string"
    && DEVICE_CREDENTIAL_REGISTRY_DIGEST_PATTERN.test(value)
  );
}

function safeIdentifier(value: unknown): value is string {
  return (
    typeof value === "string"
    && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)
  );
}

function positiveRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 1;
}

function validIsoTime(value: unknown): value is string {
  if (typeof value !== "string" || !value) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function isCredentialPurpose(value: unknown): value is CredentialPurpose {
  return (
    value === "provider_api_key"
    || value === "proxy_auth"
    || value === "mcp_header"
    || value === "mcp_env"
    || value === "oauth"
  );
}

function isAudienceKind(value: unknown): value is CredentialAudienceKind {
  return (
    value === "provider"
    || value === "proxy"
    || value === "mcp"
    || value === "oauth"
  );
}

function isProviderTransport(value: unknown): value is ProviderTransport {
  return (
    value === "https"
    || value === "http"
    || value === "sse"
    || value === "websocket"
  );
}

function isCredentialState(value: unknown): value is DeviceCredentialState {
  return (
    value === "prepared"
    || value === "write_intent"
    || value === "secret_written"
    || value === "secret_readback_verified"
    || value === "active"
    || value === "revoked"
    || value === "orphaned"
    || value === "poisoned"
    || value === "physical_delete_unverified"
  );
}
