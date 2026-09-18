import { knowledgeRolePath } from "../knowledge-base/root-paths";
import { createHash } from "node:crypto";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { TextDecoder } from "node:util";
import { normalizePath, type App, type TFile } from "obsidian";
import {
  VaultDomainAdapterError,
  type VaultAdapterSearchResult,
  type VaultDomainAdapter,
  type VaultFileSnapshot,
  type VaultSearchAdapterInput,
  type VaultTrashEvidence
} from "../harness/pi-native/vault-domain-service";
import {
  VaultTargetResolutionError,
  VaultTargetResolver,
  normalizeVaultRelativePath,
  type ResolvedVaultTarget,
  type VaultPathStat
} from "../harness/pi-native/vault-target-resolver";

const SEARCH_SCAN_LIMIT_BYTES = 32_000;
const SEARCH_EXCERPT_LIMIT_BYTES = 2_000;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const MANAGED_HIDDEN_UPDATE = Symbol("echoink.managed-hidden-update");

export interface CreatePhase3MaintenanceVaultDomainAdapterOptions {
  readonly base: ObsidianVaultDomainAdapter;
  readonly trackerRelativePath: string;
}

/**
 * Creates the only production view allowed to update a Vault-managed hidden
 * file. The base adapter remains closed, so ordinary Vault Tools cannot use
 * this fallback even when they target the same relative path.
 */
export function createPhase3MaintenanceVaultDomainAdapter(
  options: Readonly<CreatePhase3MaintenanceVaultDomainAdapterOptions>
): VaultDomainAdapter {
  const trackerRelativePath = normalizeManagedHiddenPath(
    options.trackerRelativePath
  );
  return Object.freeze(new Phase3MaintenanceVaultDomainAdapter(
    options.base,
    trackerRelativePath
  ));
}

/**
 * Obsidian-backed implementation of the seven Vault Tool domain port.
 *
 * Paths are always re-resolved before content access. Mutations use Obsidian's
 * own atomic/process, link-aware rename, and recoverable trash APIs so the
 * workspace and metadata cache observe the same side effect.
 */
export class ObsidianVaultDomainAdapter implements VaultDomainAdapter {
  readonly vaultRootPath: string;
  private readonly resolver: VaultTargetResolver;

  constructor(
    private readonly app: App,
    readonly vaultId: string,
    vaultRootPath: string
  ) {
    this.vaultRootPath = path.resolve(vaultRootPath);
    this.resolver = new VaultTargetResolver(this);
  }

  async lstat(absolutePath: string): Promise<Readonly<VaultPathStat> | null> {
    let stats: Awaited<ReturnType<typeof fsp.lstat>>;
    try {
      stats = await fsp.lstat(absolutePath);
    } catch (error) {
      if (nodeErrorCode(error) === "ENOENT") return null;
      throw error;
    }
    return Object.freeze({
      kind: stats.isSymbolicLink()
        ? "symbolic_link"
        : stats.isFile()
          ? "file"
          : stats.isDirectory()
            ? "directory"
            : "other"
    });
  }

  async realpath(absolutePath: string): Promise<string> {
    return await fsp.realpath(absolutePath);
  }

  async search(
    input: Readonly<VaultSearchAdapterInput>
  ): Promise<readonly Readonly<VaultAdapterSearchResult>[]> {
    const query = input.query.toLocaleLowerCase();
    const scopePrefix = input.scope.relativePath
      ? `${input.scope.relativePath}/`
      : "";
    const results: VaultAdapterSearchResult[] = [];
    for (const file of this.app.vault.getFiles().filter((entry) => /\.(md|base|canvas)$/iu.test(entry.path))) {
      if (results.length >= input.maxResults) break;
      if (
        scopePrefix
        && file.path !== input.scope.relativePath
        && !file.path.startsWith(scopePrefix)
      ) continue;

      const target = await this.resolver.resolve({
        vaultId: this.vaultId,
        relativePath: file.path,
        mustExist: true,
        expectedKind: "file"
      });
      const maxBytes = Math.min(SEARCH_SCAN_LIMIT_BYTES, Math.max(1, input.maxExcerptBytes));
      const pathMatches = target.relativePath.toLocaleLowerCase().includes(query);
      if (!pathMatches) {
        const prefix = await readSearchPrefix(target.absolutePath, maxBytes);
        if (!prefix.toLocaleLowerCase().includes(query)) continue;
      }
      // Only matched candidates need the complete content revision. Recheck the
      // match in the returned snapshot in case the file changed during search.
      const snapshot = await this.readFile(target, { maxBytes });
      if (!snapshot) continue;
      const contentIndex = snapshot.content.toLocaleLowerCase().indexOf(query);
      if (!pathMatches && contentIndex < 0) continue;
      results.push(Object.freeze({
        relativePath: target.relativePath,
        excerpt: searchExcerpt(
          snapshot.content,
          Math.max(0, contentIndex),
          Math.min(SEARCH_EXCERPT_LIMIT_BYTES, input.maxExcerptBytes)
        ),
        version: snapshot.version
      }));
    }
    return Object.freeze(results);
  }

  async readFile(
    target: Readonly<ResolvedVaultTarget>,
    options: Readonly<{ maxBytes?: number }>
  ): Promise<Readonly<VaultFileSnapshot> | null> {
    const current = await this.resolveExistingFile(target.relativePath);
    if (!current) return null;
    if (path.resolve(current.absolutePath) !== path.resolve(target.absolutePath)) {
      throw adapterError(
        "unsafe_target",
        "Vault target identity changed before read"
      );
    }
    const captured = await readAndDigest(
      current.absolutePath,
      options.maxBytes
    );
    return Object.freeze({
      relativePath: current.relativePath,
      version: captured.sha256,
      byteLength: captured.byteLength,
      content: captured.content,
      contentSha256: captured.sha256,
      truncated: captured.truncated
    });
  }

  async createFile(
    target: Readonly<ResolvedVaultTarget>,
    content: string
  ): Promise<void> {
    await this.assertMissingTargetStable(target);
    try {
      await this.createMissingParentDirectories(target);
      await this.app.vault.create(target.relativePath, content);
    } catch (error) {
      throw mapMutationError(error, "already_exists", "Vault create failed");
    }
  }

  async updateFile(
    target: Readonly<ResolvedVaultTarget>,
    expectedVersion: string,
    content: string
  ): Promise<void> {
    await this.updateFileInternal(target, expectedVersion, content);
  }

  async [MANAGED_HIDDEN_UPDATE](
    target: Readonly<ResolvedVaultTarget>,
    expectedVersion: string,
    content: string,
    trackerRelativePath: string
  ): Promise<void> {
    await this.updateFileInternal(
      target,
      expectedVersion,
      content,
      trackerRelativePath
    );
  }

  private async updateFileInternal(
    target: Readonly<ResolvedVaultTarget>,
    expectedVersion: string,
    content: string,
    managedHiddenRelativePath?: string
  ): Promise<void> {
    const current = await this.resolveExistingFile(target.relativePath);
    if (!current) {
      throw adapterError("not_found", "Vault update target no longer exists");
    }
    if (path.resolve(current.absolutePath) !== path.resolve(target.absolutePath)) {
      throw adapterError("unsafe_target", "Vault update target identity changed");
    }
    const replaceIfVersionMatches = (before: string): string => {
      if (sha256(before) !== expectedVersion) {
        throw adapterError(
          "version_conflict",
          "Vault update expected version no longer matches"
        );
      }
      return content;
    };
    const file = this.app.vault.getFileByPath(current.relativePath);
    try {
      if (file) {
        await this.app.vault.process(file, replaceIfVersionMatches);
        return;
      }
      if (managedHiddenRelativePath !== current.relativePath) {
        throw adapterError("not_file", "Vault target is not a file");
      }
      await this.assertManagedHiddenTargetStable(current);
      await this.app.vault.adapter.process(
        normalizePath(current.relativePath),
        replaceIfVersionMatches
      );
    } catch (error) {
      if (error instanceof VaultDomainAdapterError) throw error;
      throw mapMutationError(error, "io_error", "Vault update failed");
    }
  }

  async moveFile(
    source: Readonly<ResolvedVaultTarget>,
    target: Readonly<ResolvedVaultTarget>,
    expectedSourceVersion: string
  ): Promise<void> {
    const currentSource = await this.resolveExistingFile(source.relativePath);
    const file = currentSource
      ? this.requireObsidianFile(currentSource.relativePath)
      : null;
    if (!currentSource || !file) {
      throw adapterError("not_found", "Vault move source no longer exists");
    }
    await this.assertMissingTargetStable(target);
    const sourceSnapshot = await this.readFile(currentSource, {});
    if (!sourceSnapshot || sourceSnapshot.version !== expectedSourceVersion) {
      throw adapterError(
        "version_conflict",
        "Vault move expected version no longer matches"
      );
    }
    try {
      await this.app.fileManager.renameFile(file, target.relativePath);
    } catch (error) {
      throw mapMutationError(error, "io_error", "Vault move failed");
    }
  }

  async trashFileRecoverably(
    source: Readonly<ResolvedVaultTarget>,
    expectedVersion: string,
    operationIdentity: string
  ): Promise<Readonly<VaultTrashEvidence>> {
    const currentSource = await this.resolveExistingFile(source.relativePath);
    const file = currentSource
      ? this.requireObsidianFile(currentSource.relativePath)
      : null;
    if (!currentSource || !file) {
      throw adapterError("not_found", "Vault delete target no longer exists");
    }
    const sourceSnapshot = await this.readFile(currentSource, {});
    if (!sourceSnapshot || sourceSnapshot.version !== expectedVersion) {
      throw adapterError(
        "version_conflict",
        "Vault delete expected version no longer matches"
      );
    }
    try {
      await this.app.fileManager.trashFile(file);
    } catch (error) {
      throw mapMutationError(error, "io_error", "Vault recoverable trash failed");
    }
    return Object.freeze({
      kind: "obsidian_recoverable",
      operationIdentity,
      originalRelativePath: currentSource.relativePath
    });
  }

  private async resolveExistingFile(
    relativePath: string
  ): Promise<Readonly<ResolvedVaultTarget> | null> {
    try {
      return await this.resolver.resolve({
        vaultId: this.vaultId,
        relativePath,
        mustExist: true,
        expectedKind: "file"
      });
    } catch (error) {
      if (
        error instanceof VaultTargetResolutionError
        && error.code === "target_not_found"
      ) return null;
      throw error;
    }
  }

  private async assertMissingTargetStable(
    target: Readonly<ResolvedVaultTarget>
  ): Promise<void> {
    const refreshed = await this.resolver.resolve({
      vaultId: this.vaultId,
      relativePath: target.relativePath,
      allowMissingParentDirectories: true,
      mustExist: false,
      expectedKind: "file"
    });
    if (refreshed.exists) {
      throw adapterError("already_exists", "Vault target already exists");
    }
    if (path.resolve(refreshed.absolutePath) !== path.resolve(target.absolutePath)) {
      throw adapterError("unsafe_target", "Vault target identity changed");
    }
  }

  private async createMissingParentDirectories(
    target: Readonly<ResolvedVaultTarget>
  ): Promise<void> {
    const parentSegments = target.relativePath.split("/").slice(0, -1);
    let relativeParent = "";
    for (const segment of parentSegments) {
      relativeParent = relativeParent
        ? `${relativeParent}/${segment}`
        : segment;
      const absoluteParent = path.join(this.vaultRootPath, relativeParent);
      const stat = await this.lstat(absoluteParent);
      if (stat) {
        if (stat.kind === "symbolic_link" || stat.kind !== "directory") {
          throw adapterError(
            "unsafe_target",
            "Vault create parent is not a canonical directory"
          );
        }
        if (path.resolve(await this.realpath(absoluteParent)) !== absoluteParent) {
          throw adapterError(
            "unsafe_target",
            "Vault create parent identity changed"
          );
        }
        continue;
      }
      try {
        await this.app.vault.createFolder(normalizePath(relativeParent));
      } catch (error) {
        const raced = await this.lstat(absoluteParent);
        if (!raced) throw error;
        if (
          raced.kind !== "directory"
          || path.resolve(await this.realpath(absoluteParent)) !== absoluteParent
        ) {
          throw adapterError(
            "unsafe_target",
            "Vault create parent changed during creation"
          );
        }
        continue;
      }
      const created = await this.lstat(absoluteParent);
      if (
        !created
        || created.kind !== "directory"
        || path.resolve(await this.realpath(absoluteParent)) !== absoluteParent
      ) {
        throw adapterError(
          "unsafe_target",
          "Vault create parent could not be verified"
        );
      }
    }
  }

  private async assertManagedHiddenTargetStable(
    target: Readonly<ResolvedVaultTarget>
  ): Promise<void> {
    const segments = target.relativePath.split("/");
    let requestedPath = this.vaultRootPath;
    for (const [index, segment] of segments.entries()) {
      requestedPath = path.join(requestedPath, segment);
      const stat = await this.lstat(requestedPath);
      if (!stat) {
        throw adapterError(
          "not_found",
          "Managed hidden update target no longer exists"
        );
      }
      if (stat.kind === "symbolic_link") {
        throw adapterError(
          "unsafe_target",
          "Managed hidden update cannot follow a symbolic link"
        );
      }
      if (
        index < segments.length - 1
        ? stat.kind !== "directory"
        : stat.kind !== "file"
      ) {
        throw adapterError("not_file", "Vault target is not a file");
      }
    }
    const canonicalPath = await this.realpath(requestedPath);
    if (path.resolve(canonicalPath) !== path.resolve(target.absolutePath)) {
      throw adapterError(
        "unsafe_target",
        "Managed hidden update target identity changed"
      );
    }
  }

  private requireObsidianFile(relativePath: string): TFile {
    const file = this.app.vault.getFileByPath(relativePath);
    if (!file) throw adapterError("not_file", "Vault target is not a file");
    return file;
  }
}

class Phase3MaintenanceVaultDomainAdapter implements VaultDomainAdapter {
  readonly vaultId: string;
  readonly vaultRootPath: string;

  constructor(
    private readonly base: ObsidianVaultDomainAdapter,
    private readonly trackerRelativePath: string
  ) {
    this.vaultId = base.vaultId;
    this.vaultRootPath = base.vaultRootPath;
  }

  async lstat(absolutePath: string): Promise<Readonly<VaultPathStat> | null> {
    return await this.base.lstat(absolutePath);
  }

  async realpath(absolutePath: string): Promise<string> {
    return await this.base.realpath(absolutePath);
  }

  async search(
    input: Readonly<VaultSearchAdapterInput>
  ): Promise<readonly Readonly<VaultAdapterSearchResult>[]> {
    return await this.base.search(input);
  }

  async readFile(
    target: Readonly<ResolvedVaultTarget>,
    options: Readonly<{ maxBytes?: number }>
  ): Promise<Readonly<VaultFileSnapshot> | null> {
    return await this.base.readFile(target, options);
  }

  async createFile(
    target: Readonly<ResolvedVaultTarget>,
    content: string
  ): Promise<void> {
    if (
      hasHiddenPathSegment(target.relativePath)
      && knowledgeRolePath(target.relativePath) !== knowledgeRolePath(this.trackerRelativePath)
    ) {
      throw adapterError(
        "unsafe_target",
        "Managed hidden files cannot be created"
      );
    }
    await this.base.createFile(target, content);
  }

  async updateFile(
    target: Readonly<ResolvedVaultTarget>,
    expectedVersion: string,
    content: string
  ): Promise<void> {
    await this.base[MANAGED_HIDDEN_UPDATE](
      target,
      expectedVersion,
      content,
      knowledgeRolePath(target.relativePath) === knowledgeRolePath(this.trackerRelativePath) ? target.relativePath : this.trackerRelativePath
    );
  }

  async moveFile(
    source: Readonly<ResolvedVaultTarget>,
    target: Readonly<ResolvedVaultTarget>,
    expectedSourceVersion: string
  ): Promise<void> {
    if (
      hasHiddenPathSegment(source.relativePath)
      || hasHiddenPathSegment(target.relativePath)
    ) {
      throw adapterError(
        "unsafe_target",
        "Managed hidden files cannot be moved"
      );
    }
    await this.base.moveFile(source, target, expectedSourceVersion);
  }

  async trashFileRecoverably(
    source: Readonly<ResolvedVaultTarget>,
    expectedVersion: string,
    operationIdentity: string
  ): Promise<Readonly<VaultTrashEvidence>> {
    if (hasHiddenPathSegment(source.relativePath)) {
      throw adapterError(
        "unsafe_target",
        "Managed hidden files cannot be deleted"
      );
    }
    return await this.base.trashFileRecoverably(
      source,
      expectedVersion,
      operationIdentity
    );
  }
}

function normalizeManagedHiddenPath(value: string): string {
  const relativePath = normalizeVaultRelativePath(value);
  const segments = relativePath.split("/");
  if (
    !hasHiddenPathSegment(relativePath)
    || segments[0] === ".obsidian"
    || segments[0] === ".echoink"
  ) {
    throw new TypeError("managed_hidden_update_path_invalid");
  }
  return relativePath;
}

function hasHiddenPathSegment(relativePath: string): boolean {
  return relativePath.split("/").some((segment) =>
    segment.startsWith(".") && segment.length > 1
  );
}

async function readSearchPrefix(absolutePath: string, limit: number): Promise<string> {
  const handle = await fsp.open(absolutePath, "r");
  try {
    const bytes = Buffer.alloc(limit);
    let offset = 0;
    while (offset < limit) {
      const { bytesRead } = await handle.read(bytes, offset, limit - offset, null);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return decodeUtf8Prefix(bytes.subarray(0, offset));
  } finally {
    await handle.close();
  }
}

async function readAndDigest(
  absolutePath: string,
  maxBytes?: number
): Promise<Readonly<{
  content: string;
  byteLength: number;
  sha256: string;
  truncated: boolean;
}>> {
  const captureLimit = maxBytes === undefined
    ? Number.POSITIVE_INFINITY
    : Math.max(0, Math.floor(maxBytes));
  const digest = createHash("sha256");
  const captured: Buffer[] = [];
  let capturedBytes = 0;
  let byteLength = 0;
  const handle = await fsp.open(absolutePath, "r");
  try {
    const buffer = Buffer.allocUnsafe(64 * 1024);
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      const chunk = buffer.subarray(0, bytesRead);
      digest.update(chunk);
      byteLength += bytesRead;
      if (capturedBytes < captureLimit) {
        const remaining = captureLimit - capturedBytes;
        const part = chunk.subarray(0, Math.min(chunk.length, remaining));
        captured.push(Buffer.from(part));
        capturedBytes += part.length;
      }
    }
  } finally {
    await handle.close();
  }
  const capturedBuffer = Buffer.concat(captured);
  const content = decodeUtf8Prefix(capturedBuffer);
  return Object.freeze({
    content,
    byteLength,
    sha256: digest.digest("hex"),
    truncated: byteLength > Buffer.byteLength(content, "utf8")
  });
}

function decodeUtf8Prefix(bytes: Buffer): string {
  for (let trim = 0; trim <= Math.min(3, bytes.length); trim += 1) {
    try {
      return UTF8_DECODER.decode(
        trim === 0 ? bytes : bytes.subarray(0, bytes.length - trim)
      );
    } catch {
      // A byte limit may split one trailing UTF-8 scalar; trim only that tail.
    }
  }
  throw adapterError("io_error", "Vault file is not valid UTF-8 text");
}

function searchExcerpt(content: string, matchIndex: number, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const start = Math.max(0, matchIndex - Math.floor(maxBytes / 4));
  const candidate = content.slice(start);
  const bytes = Buffer.from(candidate, "utf8");
  if (bytes.length <= maxBytes) return candidate;
  return decodeUtf8Prefix(bytes.subarray(0, maxBytes));
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function mapMutationError(
  error: unknown,
  fallbackCode: "already_exists" | "io_error",
  safeMessage: string
): VaultDomainAdapterError {
  const code = nodeErrorCode(error);
  if (code === "EEXIST") return adapterError("already_exists", safeMessage, error);
  if (code === "ENOENT") return adapterError("not_found", safeMessage, error);
  return adapterError(fallbackCode, safeMessage, error);
}

function adapterError(
  code: ConstructorParameters<typeof VaultDomainAdapterError>[0],
  message: string,
  cause?: unknown
): VaultDomainAdapterError {
  return new VaultDomainAdapterError(
    code,
    message,
    cause === undefined ? undefined : { cause }
  );
}

function nodeErrorCode(error: unknown): string | undefined {
  return error instanceof Error
    ? (error as NodeJS.ErrnoException).code
    : undefined;
}
