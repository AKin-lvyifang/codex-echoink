import { createHash } from "node:crypto";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import type {
  MaintenanceWorkflowCasFile,
  MaintenanceWorkflowFileCas,
  MaintenanceWorkflowManagedUpsertDraft,
  MaintenanceWorkflowManagedWriteKind
} from "../harness/maintenance/workflow-wal";

export interface MaintenanceContentFileBaseline {
  relativePath: string;
  expected: MaintenanceWorkflowFileCas;
  content: Buffer | null;
  mode: number;
  mtimeMs: number;
}

export type MaintenanceContentUpsertPlan = Omit<
  MaintenanceWorkflowManagedUpsertDraft,
  "kind" | "operation"
>;

export async function readMaintenanceContentFileBaseline(
  rootPathInput: string,
  relativePathInput: string,
  options: {
    missingMode?: number;
    requireExisting?: boolean;
  } = {}
): Promise<MaintenanceContentFileBaseline> {
  const rootPath = path.resolve(rootPathInput);
  const rootStat = await fsp.lstat(rootPath).catch(() => null);
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`maintenance content plan 要求普通根目录：${rootPathInput}`);
  }
  const relativePath = normalizeMaintenanceContentRelativePath(relativePathInput);
  const parentExists = await assertSafeMaintenanceContentParentChain(
    rootPath,
    path.posix.dirname(relativePath)
  );
  if (!parentExists) {
    if (options.requireExisting) {
      throw new Error(`maintenance content plan 目标不存在：${relativePath}`);
    }
    return missingMaintenanceContentBaseline(
      relativePath,
      options.missingMode
    );
  }
  const absolutePath = resolveMaintenanceContentPath(rootPath, relativePath);
  const before = await fsp.lstat(absolutePath).catch((error) => {
    if (isMissingPathError(error)) return null;
    throw error;
  });
  if (!before) {
    if (options.requireExisting) {
      throw new Error(`maintenance content plan 目标不存在：${relativePath}`);
    }
    return missingMaintenanceContentBaseline(
      relativePath,
      options.missingMode
    );
  }
  assertPlainMaintenanceContentFile(before, relativePath);
  const content = await fsp.readFile(absolutePath);
  const after = await fsp.lstat(absolutePath);
  assertPlainMaintenanceContentFile(after, relativePath);
  if (!sameMaintenanceContentFileVersion(before, after)) {
    throw new Error(`maintenance content plan 读取期间文件发生变化：${relativePath}`);
  }
  const mode = normalizeMaintenanceContentMode(before.mode);
  return {
    relativePath,
    expected: maintenanceContentFileCas(content, mode),
    content,
    mode,
    mtimeMs: before.mtimeMs
  };
}

export function maintenanceContentFileCas(
  content: Buffer,
  mode: number
): MaintenanceWorkflowCasFile {
  return {
    kind: "file",
    sha256: `sha256:${createHash("sha256").update(content).digest("hex")}`,
    size: content.byteLength,
    mode: normalizeMaintenanceContentMode(mode)
  };
}

export function maintenanceContentUpsertPlan(
  baseline: MaintenanceContentFileBaseline,
  desiredContent: Buffer | string,
  options: {
    includeExpectedContent?: boolean;
    desiredMode?: number;
  } = {}
): MaintenanceContentUpsertPlan {
  const bytes = Buffer.isBuffer(desiredContent)
    ? Buffer.from(desiredContent)
    : Buffer.from(desiredContent, "utf8");
  return {
    relativePath: baseline.relativePath,
    expected: cloneMaintenanceContentCas(baseline.expected),
    ...(options.includeExpectedContent && baseline.content
      ? { expectedContent: Buffer.from(baseline.content) }
      : {}),
    desiredContent: bytes,
    desiredMode: normalizeMaintenanceContentMode(
      options.desiredMode ?? baseline.mode
    )
  };
}

export function asMaintenanceWorkflowManagedUpsertDraft(
  kind: MaintenanceWorkflowManagedWriteKind,
  plan: MaintenanceContentUpsertPlan
): MaintenanceWorkflowManagedUpsertDraft {
  return {
    kind,
    operation: "upsert",
    relativePath: plan.relativePath,
    expected: cloneMaintenanceContentCas(plan.expected),
    ...(plan.expectedContent
      ? { expectedContent: Buffer.from(plan.expectedContent) }
      : {}),
    desiredContent: Buffer.from(plan.desiredContent),
    desiredMode: normalizeMaintenanceContentMode(plan.desiredMode)
  };
}

export function normalizeMaintenanceContentRelativePath(value: string): string {
  const normalized = value
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/\/+/g, "/");
  if (
    !normalized
    || path.posix.isAbsolute(normalized)
    || normalized.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error(`maintenance content plan 路径非法：${value}`);
  }
  return normalized;
}

export function normalizeMaintenanceContentMode(mode: number): number {
  if (!Number.isSafeInteger(mode) || mode < 0) {
    throw new Error(`maintenance content plan mode 非法：${mode}`);
  }
  return mode & 0o777;
}

function missingMaintenanceContentBaseline(
  relativePath: string,
  mode = 0o644
): MaintenanceContentFileBaseline {
  return {
    relativePath,
    expected: { kind: "missing" },
    content: null,
    mode: normalizeMaintenanceContentMode(mode),
    mtimeMs: 0
  };
}

async function assertSafeMaintenanceContentParentChain(
  rootPath: string,
  parentRelativePath: string
): Promise<boolean> {
  if (!parentRelativePath || parentRelativePath === ".") return true;
  let current = rootPath;
  for (const segment of parentRelativePath.split("/")) {
    current = path.join(current, segment);
    const stat = await fsp.lstat(current).catch((error) => {
      if (isMissingPathError(error)) return null;
      throw error;
    });
    if (!stat) return false;
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(
        `maintenance content plan 父目录链不安全：${path.relative(rootPath, current).replace(/\\/g, "/")}`
      );
    }
  }
  return true;
}

function resolveMaintenanceContentPath(
  rootPath: string,
  relativePath: string
): string {
  const absolutePath = path.resolve(rootPath, relativePath);
  if (
    absolutePath === rootPath
    || !absolutePath.startsWith(`${rootPath}${path.sep}`)
  ) {
    throw new Error(`maintenance content plan 路径越界：${relativePath}`);
  }
  return absolutePath;
}

function assertPlainMaintenanceContentFile(
  stat: Awaited<ReturnType<typeof fsp.lstat>>,
  relativePath: string
): void {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new Error(`maintenance content plan 目标不是独立普通文件：${relativePath}`);
  }
}

function sameMaintenanceContentFileVersion(
  left: Awaited<ReturnType<typeof fsp.lstat>>,
  right: Awaited<ReturnType<typeof fsp.lstat>>
): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mode === right.mode
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function cloneMaintenanceContentCas(
  value: MaintenanceWorkflowFileCas
): MaintenanceWorkflowFileCas {
  return value.kind === "missing"
    ? { kind: "missing" }
    : {
        kind: "file",
        sha256: value.sha256,
        size: value.size,
        mode: value.mode
      };
}

function isMissingPathError(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === "object"
    && "code" in error
    && (error as { code?: string }).code === "ENOENT"
  );
}
