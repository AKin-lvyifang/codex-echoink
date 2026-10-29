import { getDesktopCrypto } from "../../platform/desktop-crypto";
import { getDesktopFsPromises } from "../../platform/desktop-filesystem";
import { getDesktopPath } from "../../platform/desktop-paths";

import {
  DEVICE_CREDENTIAL_REGISTRY_DIGEST_PATTERN,
  parseDeviceCredentialRegistry,
  type DeviceCredentialRegistryReaderPort,
  type DeviceCredentialRegistryV1
} from "./device-credential-registry";
import type {
  CredentialRegistryCasInput,
  CredentialRegistryPort
} from "./credential-commit-coordinator";
import { jcsCanonicalize } from "./provider-target-identity";
import {
  DurableAppendOnlyCasError,
  durableAppendOnlyChainPath,
  publishDurableAppendOnlyChain,
  publishDurableAppendOnlyEntry,
  readDurableRegularFile,
  resolveDurableAppendOnlyLayout,
  resolveDurablePlainRoot
} from "../storage/durable-append-only-cas";

const { createHash } = getDesktopCrypto();

const fsp = getDesktopFsPromises();
const path = getDesktopPath();

const REGISTRY_DIRECTORY = "credential-registry-v1";
const JOURNAL_NAMESPACE = "registry-journal-v1";
const REVISION_FILE_PATTERN = /^[0-9]{12}\.json$/u;
const SCOPE_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const MAX_REGISTRY_BYTES = 2 * 1024 * 1024;
const MAX_REGISTRY_REVISIONS = 10_000;

export type DeviceCredentialRegistryJournalErrorCode =
  | "invalid_input"
  | "cas_conflict"
  | "corrupt_registry";

export class DeviceCredentialRegistryJournalError extends Error {
  constructor(
    readonly code: DeviceCredentialRegistryJournalErrorCode,
    safeMessage: string
  ) {
    super(safeMessage);
    this.name = "DeviceCredentialRegistryJournalError";
  }
}

/**
 * Device-local append-only authority for DeviceCredentialRegistry snapshots.
 * Every revision is a no-clobber journal entry, so a process crash cannot
 * leave a partially replaced mutable registry file.
 */
export class DeviceCredentialRegistryJournal
implements CredentialRegistryPort, DeviceCredentialRegistryReaderPort {
  private constructor(
    private readonly registryRootPath: string,
    readonly deviceIdDigest: string,
    readonly vaultIdDigest: string
  ) {}

  static async open(options: {
    stateRootPath: string;
    deviceIdDigest: string;
    vaultIdDigest: string;
  }): Promise<DeviceCredentialRegistryJournal> {
    assertScopeDigest(options.deviceIdDigest, "device");
    assertScopeDigest(options.vaultIdDigest, "Vault");
    await fsp.mkdir(options.stateRootPath, {
      recursive: true,
      mode: 0o700
    });
    const stateRootPath = await resolveDurablePlainRoot(
      options.stateRootPath,
      "EchoInk device state root"
    );
    const registryRootPath = path.join(
      stateRootPath,
      REGISTRY_DIRECTORY
    );
    await fsp.mkdir(registryRootPath, {
      recursive: true,
      mode: 0o700
    });
    const safeRegistryRoot = await resolveDurablePlainRoot(
      registryRootPath,
      "EchoInk credential registry root"
    );
    return new DeviceCredentialRegistryJournal(
      safeRegistryRoot,
      options.deviceIdDigest,
      options.vaultIdDigest
    );
  }

  async readRegistry(input: {
    deviceIdDigest: string;
    vaultIdDigest: string;
  }): Promise<unknown> {
    this.assertScope(input);
    return await this.readCurrent();
  }

  async compareAndSwap(input: CredentialRegistryCasInput): Promise<void> {
    const target = parseRegistry(input.target);
    this.assertScope(target);
    if (
      input.credentialRef.length === 0
      || !target.entries.some(
        (entry) => entry.credentialRef === input.credentialRef
      )
    ) {
      throw invalidInput("Credential Registry CAS target is invalid.");
    }

    const current = await this.readCurrent();
    if (
      (current?.revision ?? null) !== input.expectedRevision
      || (current?.digest ?? null) !== input.expectedDigest
      || target.revision !== (current?.revision ?? 0) + 1
      || target.previousDigest !== (current?.digest ?? null)
    ) {
      throw new DeviceCredentialRegistryJournalError(
        "cas_conflict",
        "Credential Registry CAS expectation is stale."
      );
    }

    const layout = await resolveDurableAppendOnlyLayout(
      this.registryRootPath,
      JOURNAL_NAMESPACE,
      true
    );
    if (!layout) {
      throw corruptRegistry("Credential Registry Journal was not created.");
    }
    const content = Buffer.from(
      `${jcsCanonicalize(target)}\n`,
      "utf8"
    );
    try {
      if (target.revision === 1) {
        await publishDurableAppendOnlyChain(
          layout,
          this.chainToken(),
          revisionFileName(target.revision),
          content,
          { maxBytes: MAX_REGISTRY_BYTES }
        );
      } else {
        await publishDurableAppendOnlyEntry(
          layout,
          this.chainToken(),
          revisionFileName(target.revision),
          content,
          { maxBytes: MAX_REGISTRY_BYTES }
        );
      }
    } catch (error) {
      if (
        error instanceof DurableAppendOnlyCasError
        && (
          error.code === "already_exists"
          || error.code === "revision_conflict"
        )
      ) {
        throw new DeviceCredentialRegistryJournalError(
          "cas_conflict",
          "Credential Registry revision was committed concurrently."
        );
      }
      throw error;
    }

    const readback = await this.readCurrent();
    if (!readback || jcsCanonicalize(readback) !== jcsCanonicalize(target)) {
      throw corruptRegistry(
        "Credential Registry strict readback does not match its target."
      );
    }
  }

  private async readCurrent():
  Promise<DeviceCredentialRegistryV1 | null> {
    const layout = await resolveDurableAppendOnlyLayout(
      this.registryRootPath,
      JOURNAL_NAMESPACE,
      false
    );
    if (!layout) return null;
    const chainRootPath = durableAppendOnlyChainPath(
      layout,
      this.chainToken()
    );
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fsp.readdir(chainRootPath, {
        withFileTypes: true
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw corruptRegistry("Credential Registry Journal cannot be listed.");
    }
    if (entries.length > MAX_REGISTRY_REVISIONS) {
      throw corruptRegistry("Credential Registry Journal is too large.");
    }
    const names = entries.map((entry) => {
      if (
        !entry.isFile()
        || entry.isSymbolicLink()
        || !REVISION_FILE_PATTERN.test(entry.name)
      ) {
        throw corruptRegistry(
          "Credential Registry Journal contains an unsafe entry."
        );
      }
      return entry.name;
    }).sort();
    for (let index = 0; index < names.length; index += 1) {
      if (names[index] !== revisionFileName(index + 1)) {
        throw corruptRegistry(
          "Credential Registry Journal has a revision gap."
        );
      }
    }

    let previous: DeviceCredentialRegistryV1 | null = null;
    for (const name of names) {
      const file = await readDurableRegularFile(
        path.join(chainRootPath, name),
        MAX_REGISTRY_BYTES,
        [1, 2]
      ).catch(() => {
        throw corruptRegistry(
          "Credential Registry revision cannot be read safely."
        );
      });
      let parsed: unknown;
      try {
        parsed = JSON.parse(file.content.toString("utf8"));
      } catch {
        throw corruptRegistry(
          "Credential Registry revision contains invalid JSON."
        );
      }
      const registry = parseRegistry(parsed);
      this.assertScope(registry);
      if (
        registry.revision !== (previous?.revision ?? 0) + 1
        || registry.previousDigest !== (previous?.digest ?? null)
      ) {
        throw corruptRegistry(
          "Credential Registry revision chain is inconsistent."
        );
      }
      previous = registry;
    }
    return previous;
  }

  private assertScope(input: {
    deviceIdDigest: string;
    vaultIdDigest: string;
  }): void {
    if (
      input.deviceIdDigest !== this.deviceIdDigest
      || input.vaultIdDigest !== this.vaultIdDigest
    ) {
      throw corruptRegistry(
        "Credential Registry belongs to a different device or Vault."
      );
    }
  }

  private chainToken(): string {
    return `registry-${createHash("sha256")
      .update(this.vaultIdDigest, "utf8")
      .digest("hex")}`;
  }
}

function parseRegistry(value: unknown): DeviceCredentialRegistryV1 {
  try {
    return parseDeviceCredentialRegistry(value);
  } catch {
    throw corruptRegistry("Credential Registry revision is corrupt.");
  }
}

function revisionFileName(revision: number): string {
  if (
    !Number.isSafeInteger(revision)
    || revision < 1
    || revision > MAX_REGISTRY_REVISIONS
  ) {
    throw invalidInput("Credential Registry revision is invalid.");
  }
  return `${String(revision).padStart(12, "0")}.json`;
}

function assertScopeDigest(value: string, label: string): void {
  if (
    typeof value !== "string"
    || !SCOPE_DIGEST_PATTERN.test(value)
    || !DEVICE_CREDENTIAL_REGISTRY_DIGEST_PATTERN.test(value)
  ) {
    throw invalidInput(`Credential Registry ${label} identity is invalid.`);
  }
}

function invalidInput(
  message: string
): DeviceCredentialRegistryJournalError {
  return new DeviceCredentialRegistryJournalError(
    "invalid_input",
    message
  );
}

function corruptRegistry(
  message: string
): DeviceCredentialRegistryJournalError {
  return new DeviceCredentialRegistryJournalError(
    "corrupt_registry",
    message
  );
}
