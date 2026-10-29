import { getDesktopCrypto } from "../platform/desktop-crypto";
import { getDesktopFsPromises } from "../platform/desktop-filesystem";
import { getDesktopOs, getDesktopPath } from "../platform/desktop-paths";

import { validVaultId } from "../storage/vault-identity";
import {
  DurableAppendOnlyCasError,
  readDurableRegularFile,
  resolveDurablePlainRoot,
  writeDurableNewFile
} from "../harness/storage/durable-append-only-cas";

const { createHash, randomBytes } = getDesktopCrypto();

const fsp = getDesktopFsPromises();
const { homedir } = getDesktopOs();
const path = getDesktopPath();

const DEVICE_ID_FILE = "device-id-v1";
const SCOPE_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const MAX_DEVICE_ID_BYTES = 256;

export interface EchoInkCredentialDeviceScope {
  stateRootPath: string;
  deviceIdDigest: string;
  vaultIdDigest: string;
}

export class EchoInkCredentialDeviceScopeError extends Error {
  constructor() {
    super("device_state_unavailable");
    this.name = "EchoInkCredentialDeviceScopeError";
  }
}

export async function prepareEchoInkCredentialDeviceScope(options: {
  stateRootPath: string;
  vaultPath: string;
  vaultId?: string;
}): Promise<EchoInkCredentialDeviceScope> {
  try {
    await fsp.mkdir(options.stateRootPath, { recursive: true, mode: 0o700 });
    const stateRootPath = await resolveDurablePlainRoot(
      options.stateRootPath,
      "EchoInk credential device state"
    );
    const deviceIdDigest = await readOrCreateDeviceIdDigest(stateRootPath);
    return await credentialDeviceScope({
      stateRootPath,
      deviceIdDigest,
      vaultId: options.vaultId,
      vaultPath: options.vaultPath
    });
  } catch {
    throw new EchoInkCredentialDeviceScopeError();
  }
}

/** Read-only scope entry that never creates the device root or identity. */
export async function readEchoInkCredentialDeviceScope(options: {
  stateRootPath: string;
  vaultPath: string;
  vaultId?: string;
}): Promise<EchoInkCredentialDeviceScope> {
  try {
    const stateRootPath = await resolveDurablePlainRoot(
      options.stateRootPath,
      "EchoInk credential device state"
    );
    const deviceIdDigest = await readDeviceIdDigest(
      path.join(stateRootPath, DEVICE_ID_FILE)
    );
    if (!deviceIdDigest) throw new EchoInkCredentialDeviceScopeError();
    return await credentialDeviceScope({
      stateRootPath,
      deviceIdDigest,
      vaultId: options.vaultId,
      vaultPath: options.vaultPath
    });
  } catch {
    throw new EchoInkCredentialDeviceScopeError();
  }
}

export function defaultEchoInkDeviceStateRoot(
  platform: NodeJS.Platform = process.platform,
  userHome: string = homedir(),
  environment: NodeJS.ProcessEnv = process.env
): string {
  if (!path.isAbsolute(userHome) || !userHome.trim()) {
    throw new EchoInkCredentialDeviceScopeError();
  }
  if (platform === "darwin") {
    return path.join(userHome, "Library", "Application Support", "codex-echoink", "device-state-v1");
  }
  if (platform === "win32") {
    const localAppData = environment.LOCALAPPDATA;
    if (!localAppData || !path.win32.isAbsolute(localAppData)) {
      throw new EchoInkCredentialDeviceScopeError();
    }
    return path.win32.join(localAppData, "codex-echoink", "device-state-v1");
  }
  const stateHome = environment.XDG_STATE_HOME;
  const base = stateHome && path.isAbsolute(stateHome)
    ? stateHome
    : path.join(userHome, ".local", "state");
  return path.join(base, "codex-echoink", "device-state-v1");
}

async function credentialDeviceScope(options: {
  stateRootPath: string;
  deviceIdDigest: string;
  vaultPath: string;
  vaultId?: string;
}): Promise<EchoInkCredentialDeviceScope> {
  const vaultRealPath = await fsp.realpath(options.vaultPath);
  if (options.vaultId !== undefined && !validVaultId(options.vaultId)) throw new EchoInkCredentialDeviceScopeError();
  return Object.freeze({
    stateRootPath: options.stateRootPath,
    deviceIdDigest: options.deviceIdDigest,
    // Old credential callers can still read the old scope; local stores pass
    // the portable identity. Existing sha256 IDs therefore keep their scope.
    vaultIdDigest: options.vaultId ?? sha256Digest(`echoink-vault-identity-v1\0${path.resolve(vaultRealPath)}`)
  });
}

async function readOrCreateDeviceIdDigest(stateRootPath: string): Promise<string> {
  const filePath = path.join(stateRootPath, DEVICE_ID_FILE);
  const existing = await readDeviceIdDigest(filePath);
  if (existing) return existing;
  const candidate = `sha256:${randomBytes(32).toString("hex")}`;
  try {
    await writeDurableNewFile(
      filePath,
      Buffer.from(`${candidate}\n`, "utf8"),
      MAX_DEVICE_ID_BYTES
    );
  } catch (error) {
    if (!(error instanceof DurableAppendOnlyCasError) || error.code !== "already_exists") {
      throw error;
    }
  }
  const readback = await readDeviceIdDigest(filePath);
  if (!readback) throw new EchoInkCredentialDeviceScopeError();
  return readback;
}

async function readDeviceIdDigest(filePath: string): Promise<string | null> {
  let file: Awaited<ReturnType<typeof readDurableRegularFile>>;
  try {
    file = await readDurableRegularFile(filePath, MAX_DEVICE_ID_BYTES);
  } catch (error) {
    if (error instanceof DurableAppendOnlyCasError && error.code === "missing") {
      return null;
    }
    throw error;
  }
  const value = file.content.toString("utf8").trim();
  if (!SCOPE_DIGEST_PATTERN.test(value)) throw new EchoInkCredentialDeviceScopeError();
  return value;
}

function sha256Digest(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}
