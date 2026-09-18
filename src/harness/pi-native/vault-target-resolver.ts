import { resolveKnowledgePath } from "../../knowledge-base/root-paths";
import * as path from "node:path";

export type VaultPathKind =
  | "file"
  | "directory"
  | "symbolic_link"
  | "other";

export interface VaultPathStat {
  kind: VaultPathKind;
}

/**
 * The production implementation may use Node-backed Obsidian paths while
 * tests inject a local filesystem fixture. `lstat` must not follow links;
 * `realpath` must return the canonical path for an existing entry.
 */
export interface VaultTargetAdapter {
  readonly vaultId: string;
  readonly vaultRootPath: string;
  lstat(absolutePath: string): Promise<Readonly<VaultPathStat> | null>;
  realpath(absolutePath: string): Promise<string>;
}

export type VaultTargetResolutionErrorCode =
  | "vault_mismatch"
  | "absolute_path"
  | "path_traversal"
  | "invalid_path"
  | "vault_root_invalid"
  | "target_not_found"
  | "target_kind_invalid"
  | "symlink_escape"
  | "outside_vault"
  | "adapter_error";

export class VaultTargetResolutionError extends Error {
  constructor(
    readonly code: VaultTargetResolutionErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "VaultTargetResolutionError";
  }
}

export interface ResolveVaultTargetInput {
  vaultId: string;
  relativePath: string;
  allowRoot?: boolean;
  /**
   * Safe create/readback seam. When true, an unresolved suffix
   * may consist entirely of absent path segments. Existing ancestors are
   * still canonicalized one by one and symbolic links remain fail-closed.
   */
  allowMissingParentDirectories?: boolean;
  mustExist?: boolean;
  expectedKind?: "file" | "directory" | "any";
}

export interface ResolvedVaultTarget {
  vaultId: string;
  vaultRootPath: string;
  requestedRelativePath: string;
  relativePath: string;
  requestedAbsolutePath: string;
  absolutePath: string;
  exists: boolean;
  kind: Exclude<VaultPathKind, "symbolic_link"> | "missing";
  encounteredSymbolicLink: boolean;
}

interface ResolvedVaultRoot {
  requestedPath: string;
  canonicalPath: string;
}

/**
 * Resolves a model-provided path into one canonical current-Vault target.
 * No caller may pass the original model path to a filesystem operation.
 */
export class VaultTargetResolver {
  constructor(private readonly adapter: VaultTargetAdapter) {}

  async resolve(
    input: Readonly<ResolveVaultTargetInput>
  ): Promise<Readonly<ResolvedVaultTarget>> {
    if (input.vaultId !== this.adapter.vaultId) {
      throw targetError(
        "vault_mismatch",
        "Vault target does not belong to the current Vault"
      );
    }
    const requestedRelativePath = normalizeVaultRelativePath(
      input.relativePath,
      input.allowRoot === true
    );
    const root = await this.resolveVaultRoot();
    if (!requestedRelativePath) {
      return Object.freeze({
        vaultId: this.adapter.vaultId,
        vaultRootPath: root.canonicalPath,
        requestedRelativePath: "",
        relativePath: "",
        requestedAbsolutePath: root.requestedPath,
        absolutePath: root.canonicalPath,
        exists: true,
        kind: "directory",
        encounteredSymbolicLink: root.requestedPath !== root.canonicalPath
      });
    }

    const segments = resolveKnowledgePath(root.canonicalPath, requestedRelativePath, false).split("/");
    let requestedCursor = root.requestedPath;
    let canonicalCursor = root.canonicalPath;
    let encounteredSymbolicLink = root.requestedPath !== root.canonicalPath;

    for (let index = 0; index < segments.length; index += 1) {
      requestedCursor = path.join(requestedCursor, segments[index]);
      const entry = await this.safeLstat(requestedCursor);
      if (!entry) {
        if (input.mustExist !== false) {
          throw targetError(
            "target_not_found",
            `Vault target does not exist: ${requestedRelativePath}`
          );
        }
        if (index < segments.length - 1) {
          if (input.allowMissingParentDirectories !== true) {
            throw targetError(
              "target_not_found",
              `Vault target parent does not exist: ${segments[index]}`
            );
          }
          const unresolvedSegments = segments.slice(index);
          const canonicalPath = path.join(
            canonicalCursor,
            ...unresolvedSegments
          );
          assertCanonicalInsideVault(
            root.canonicalPath,
            canonicalPath,
            encounteredSymbolicLink
          );
          return Object.freeze({
            vaultId: this.adapter.vaultId,
            vaultRootPath: root.canonicalPath,
            requestedRelativePath,
            relativePath: canonicalVaultRelativePath(
              root.canonicalPath,
              canonicalPath
            ),
            requestedAbsolutePath: path.join(
              root.requestedPath,
              ...segments
            ),
            absolutePath: canonicalPath,
            exists: false,
            kind: "missing",
            encounteredSymbolicLink
          });
        }
        const canonicalPath = path.join(
          canonicalCursor,
          segments[index]
        );
        assertCanonicalInsideVault(
          root.canonicalPath,
          canonicalPath,
          encounteredSymbolicLink
        );
        return Object.freeze({
          vaultId: this.adapter.vaultId,
          vaultRootPath: root.canonicalPath,
          requestedRelativePath,
          relativePath: canonicalVaultRelativePath(
            root.canonicalPath,
            canonicalPath
          ),
          requestedAbsolutePath: path.join(
            root.requestedPath,
            ...segments
          ),
          absolutePath: canonicalPath,
          exists: false,
          kind: "missing",
          encounteredSymbolicLink
        });
      }

      const canonicalPath = await this.safeRealpath(requestedCursor);
      const followedLink = entry.kind === "symbolic_link"
        || path.resolve(requestedCursor) !== path.resolve(canonicalPath);
      encounteredSymbolicLink ||= followedLink;
      assertCanonicalInsideVault(
        root.canonicalPath,
        canonicalPath,
        encounteredSymbolicLink
      );
      const resolvedStat = await this.safeLstat(canonicalPath);
      if (!resolvedStat || resolvedStat.kind === "symbolic_link") {
        throw targetError(
          "adapter_error",
          `Vault adapter returned an unstable canonical target: ${requestedRelativePath}`
        );
      }
      if (
        index < segments.length - 1
        && resolvedStat.kind !== "directory"
      ) {
        throw targetError(
          "target_kind_invalid",
          `Vault target parent is not a directory: ${segments[index]}`
        );
      }
      canonicalCursor = canonicalPath;

      if (index === segments.length - 1) {
        assertExpectedKind(
          requestedRelativePath,
          resolvedStat.kind,
          input.expectedKind ?? "any"
        );
        return Object.freeze({
          vaultId: this.adapter.vaultId,
          vaultRootPath: root.canonicalPath,
          requestedRelativePath,
          relativePath: canonicalVaultRelativePath(
            root.canonicalPath,
            canonicalPath
          ),
          requestedAbsolutePath: path.join(
            root.requestedPath,
            ...segments
          ),
          absolutePath: canonicalPath,
          exists: true,
          kind: resolvedStat.kind,
          encounteredSymbolicLink
        });
      }
    }
    throw targetError("invalid_path", "Vault target has no path segments");
  }

  private async resolveVaultRoot(): Promise<ResolvedVaultRoot> {
    const requestedPath = path.resolve(this.adapter.vaultRootPath);
    const requestedStat = await this.safeLstat(requestedPath);
    if (!requestedStat) {
      throw targetError(
        "vault_root_invalid",
        "Current Vault root does not exist"
      );
    }
    const canonicalPath = await this.safeRealpath(requestedPath);
    const canonicalStat = await this.safeLstat(canonicalPath);
    if (!canonicalStat || canonicalStat.kind !== "directory") {
      throw targetError(
        "vault_root_invalid",
        "Current Vault root is not a directory"
      );
    }
    return {
      requestedPath,
      canonicalPath: path.resolve(canonicalPath)
    };
  }

  private async safeLstat(
    absolutePath: string
  ): Promise<Readonly<VaultPathStat> | null> {
    try {
      return await this.adapter.lstat(absolutePath);
    } catch (error) {
      throw targetError(
        "adapter_error",
        "Vault adapter could not inspect a target",
        error
      );
    }
  }

  private async safeRealpath(absolutePath: string): Promise<string> {
    try {
      return path.resolve(await this.adapter.realpath(absolutePath));
    } catch (error) {
      throw targetError(
        "adapter_error",
        "Vault adapter could not canonicalize a target",
        error
      );
    }
  }
}

export function normalizeVaultRelativePath(
  value: unknown,
  allowRoot = false
): string {
  if (typeof value !== "string" || value.includes("\0")) {
    throw targetError("invalid_path", "Vault target path is invalid");
  }
  if (allowRoot && (value === "" || value === ".")) return "";
  if (!value || value.includes("\\")) {
    throw targetError(
      "invalid_path",
      "Vault target must use a non-empty slash-separated relative path"
    );
  }
  if (path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) {
    throw targetError(
      "absolute_path",
      "Absolute Vault target paths are forbidden"
    );
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment === "..")) {
    throw targetError(
      "path_traversal",
      "Parent traversal is forbidden in Vault target paths"
    );
  }
  if (segments.some((segment) => !segment || segment === ".")) {
    throw targetError(
      "invalid_path",
      "Vault target path contains an empty or ambiguous segment"
    );
  }
  return segments.join("/");
}

function assertExpectedKind(
  relativePath: string,
  actual: Exclude<VaultPathKind, "symbolic_link">,
  expected: "file" | "directory" | "any"
): void {
  if (expected === "any" || actual === expected) return;
  throw targetError(
    "target_kind_invalid",
    `Vault target has the wrong type: ${relativePath}`
  );
}

function assertCanonicalInsideVault(
  canonicalRoot: string,
  canonicalTarget: string,
  encounteredSymbolicLink: boolean
): void {
  const relative = path.relative(canonicalRoot, canonicalTarget);
  if (
    relative === ""
    || (
      relative !== ".."
      && !relative.startsWith(`..${path.sep}`)
      && !path.isAbsolute(relative)
    )
  ) {
    return;
  }
  throw targetError(
    encounteredSymbolicLink ? "symlink_escape" : "outside_vault",
    "Vault target resolves outside the current Vault"
  );
}

function canonicalVaultRelativePath(
  canonicalRoot: string,
  canonicalTarget: string
): string {
  const relative = path.relative(canonicalRoot, canonicalTarget);
  if (
    !relative
    || relative === ".."
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)
  ) {
    throw targetError(
      "outside_vault",
      "Vault target does not resolve to a file below the Vault root"
    );
  }
  return relative.split(path.sep).join("/");
}

function targetError(
  code: VaultTargetResolutionErrorCode,
  message: string,
  cause?: unknown
): VaultTargetResolutionError {
  return new VaultTargetResolutionError(
    code,
    message,
    cause === undefined ? undefined : { cause }
  );
}
