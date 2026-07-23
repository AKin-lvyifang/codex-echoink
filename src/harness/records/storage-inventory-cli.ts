import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  stat,
  unlink
} from "node:fs/promises";
import * as path from "node:path";
import type {
  StorageInventoryNativeScope,
  StorageInventoryReport,
  StorageInventoryReportInput
} from "./storage-inventory-contract";
import { pluginDataDir } from "../../core/raw-message-store";
import {
  buildStorageInventoryReport,
  renderStorageInventoryMarkdown,
  serializeStorageInventoryReport
} from "./storage-inventory-report";
import { scanStorageInventory } from "./storage-inventory";
import {
  createLocalNativeProviderProbes,
  type NativeProviderId,
  type NativeProviderProbe
} from "./native-provider-inventory";

export const STORAGE_INVENTORY_EXIT_CODES = Object.freeze({
  success: 0,
  partial: 1,
  usageBlocked: 2
} as const);

export const STORAGE_INVENTORY_OUTPUT_FILES = Object.freeze({
  json: "storage-inventory.json",
  markdown: "storage-inventory.md"
} as const);

export type StorageInventoryOutputFormat = "json" | "markdown" | "both";

export interface StorageInventoryCliOptions {
  readonly vaultPath: string;
  readonly pluginDir: string;
  readonly outputDir: string;
  readonly nativeScope: StorageInventoryNativeScope;
  readonly format: StorageInventoryOutputFormat;
}

export interface StorageInventoryCliDependencies {
  readonly scan?: (options: {
    vaultPath: string;
    pluginDir: string;
    nativeScope: StorageInventoryNativeScope;
    nativeProviderProbes: Partial<Record<NativeProviderId, NativeProviderProbe>>;
  }) => Promise<StorageInventoryReportInput>;
  readonly nativeProviderProbes?: Partial<Record<NativeProviderId, NativeProviderProbe>>;
  readonly buildReport?: (input: unknown) => StorageInventoryReport;
  readonly serializeReport?: (report: unknown) => string;
  readonly renderMarkdown?: (report: unknown) => string;
  readonly stdout?: (text: string) => void;
  readonly stderr?: (text: string) => void;
}

export class StorageInventoryCliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StorageInventoryCliUsageError";
  }
}

const DEFAULT_PLUGIN_DIR = "codex-echoink";
const DEFAULT_NATIVE_SCOPE: StorageInventoryNativeScope = "linked";
const DEFAULT_FORMAT: StorageInventoryOutputFormat = "both";
const PLUGIN_DIR_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const NATIVE_SCOPES = new Set<StorageInventoryNativeScope>([
  "none",
  "linked",
  "vault"
]);
const OUTPUT_FORMATS = new Set<StorageInventoryOutputFormat>([
  "json",
  "markdown",
  "both"
]);
const VALUE_OPTIONS = new Set([
  "--vault",
  "--plugin-dir",
  "--output-dir",
  "--native-scope",
  "--format"
]);

export const STORAGE_INVENTORY_CLI_USAGE = [
  "Usage: npm run inventory:storage -- \\",
  "  --vault <absolute-vault-path> \\",
  "  [--plugin-dir codex-echoink] \\",
  "  --output-dir <absolute-report-directory> \\",
  "  [--native-scope none|linked|vault] \\",
  "  [--format json|markdown|both]"
].join("\n");

/**
 * Parses CLI arguments without consulting the filesystem. `argv` starts at
 * the first user argument and must not include the Node executable or script.
 */
export function parseStorageInventoryCliArgs(
  argv: readonly string[]
): StorageInventoryCliOptions {
  const values = new Map<string, string>();

  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index];
    if (!raw.startsWith("--")) {
      throw new StorageInventoryCliUsageError("Unexpected positional argument");
    }

    const separator = raw.indexOf("=");
    const name = separator >= 0 ? raw.slice(0, separator) : raw;
    if (!VALUE_OPTIONS.has(name)) {
      throw new StorageInventoryCliUsageError("Unknown option");
    }
    if (values.has(name)) {
      throw new StorageInventoryCliUsageError(`Duplicate option: ${name}`);
    }

    const inlineValue = separator >= 0 ? raw.slice(separator + 1) : "";
    const nextValue = separator < 0 ? argv[index + 1] : undefined;
    const value = separator >= 0 ? inlineValue : nextValue;
    if (!value || (separator < 0 && value.startsWith("--"))) {
      throw new StorageInventoryCliUsageError(`Missing value for ${name}`);
    }
    values.set(name, value);
    if (separator < 0) index += 1;
  }

  const vaultPath = values.get("--vault") ?? "";
  const outputDir = values.get("--output-dir") ?? "";
  const pluginDir = values.get("--plugin-dir") ?? DEFAULT_PLUGIN_DIR;
  const nativeScope = values.get("--native-scope") ?? DEFAULT_NATIVE_SCOPE;
  const format = values.get("--format") ?? DEFAULT_FORMAT;

  if (!vaultPath) {
    throw new StorageInventoryCliUsageError("--vault is required");
  }
  if (!path.isAbsolute(vaultPath)) {
    throw new StorageInventoryCliUsageError("--vault must be an absolute path");
  }
  if (!outputDir) {
    throw new StorageInventoryCliUsageError("--output-dir is required");
  }
  if (!path.isAbsolute(outputDir)) {
    throw new StorageInventoryCliUsageError("--output-dir must be an absolute path");
  }
  if (!PLUGIN_DIR_PATTERN.test(pluginDir)) {
    throw new StorageInventoryCliUsageError(
      "--plugin-dir must be one directory name without path traversal"
    );
  }
  if (!NATIVE_SCOPES.has(nativeScope as StorageInventoryNativeScope)) {
    throw new StorageInventoryCliUsageError(
      "--native-scope must be none, linked, or vault"
    );
  }
  if (!OUTPUT_FORMATS.has(format as StorageInventoryOutputFormat)) {
    throw new StorageInventoryCliUsageError(
      "--format must be json, markdown, or both"
    );
  }

  const normalizedVaultPath = path.resolve(vaultPath);
  const normalizedOutputDir = path.resolve(outputDir);
  if (normalizedOutputDir === path.parse(normalizedOutputDir).root) {
    throw new StorageInventoryCliUsageError(
      "--output-dir cannot be a filesystem root"
    );
  }

  return {
    vaultPath: normalizedVaultPath,
    pluginDir,
    outputDir: normalizedOutputDir,
    nativeScope: nativeScope as StorageInventoryNativeScope,
    format: format as StorageInventoryOutputFormat
  };
}

/**
 * Runs one metadata-only inventory. This function is intentionally testable
 * without process globals; the launcher passes `process.argv.slice(2)`.
 */
export async function runStorageInventoryCli(
  argv: readonly string[],
  dependencies: StorageInventoryCliDependencies = {}
): Promise<number> {
  const stdout = dependencies.stdout ?? ((text: string) => process.stdout.write(text));
  const stderr = dependencies.stderr ?? ((text: string) => process.stderr.write(text));

  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
    stdout(`${STORAGE_INVENTORY_CLI_USAGE}\n`);
    return STORAGE_INVENTORY_EXIT_CODES.success;
  }

  let options: StorageInventoryCliOptions;
  let initialBoundary: OutputBoundary;
  try {
    options = parseStorageInventoryCliArgs(argv);
    initialBoundary = await inspectOutputBoundary(options);
  } catch (error) {
    if (error instanceof StorageInventoryCliUsageError) {
      stderr(`Storage inventory blocked: ${error.message}\n${STORAGE_INVENTORY_CLI_USAGE}\n`);
      return STORAGE_INVENTORY_EXIT_CODES.usageBlocked;
    }
    stderr(`Storage inventory blocked: unable to validate filesystem boundaries.\n`);
    return STORAGE_INVENTORY_EXIT_CODES.usageBlocked;
  }

  try {
    const scan = dependencies.scan ?? scanStorageInventory;
    const input = await scan({
      vaultPath: options.vaultPath,
      pluginDir: options.pluginDir,
      nativeScope: options.nativeScope,
      nativeProviderProbes:
        dependencies.nativeProviderProbes ?? createLocalNativeProviderProbes()
    });
    const buildReport = dependencies.buildReport ?? buildStorageInventoryReport;
    const report = buildReport(input);
    const serializeReport =
      dependencies.serializeReport ?? serializeStorageInventoryReport;
    const renderMarkdown =
      dependencies.renderMarkdown ?? renderStorageInventoryMarkdown;
    const outputs = outputPayloads(
      options.format,
      report,
      serializeReport,
      renderMarkdown
    );

    const outputDir = await prepareOutputDirectory(options, initialBoundary);
    await writeReportsAtomically(outputDir, outputs);

    const exitCode = report.migrationPreview.status === "ready"
      ? STORAGE_INVENTORY_EXIT_CODES.success
      : STORAGE_INVENTORY_EXIT_CODES.partial;
    const outcome = exitCode === STORAGE_INVENTORY_EXIT_CODES.success
      ? "complete"
      : `partial (${report.migrationPreview.status})`;
    stdout(
      `Storage inventory ${outcome}: ${report.reportId} ${report.snapshotFingerprint}\n`
    );
    return exitCode;
  } catch (error) {
    if (error instanceof StorageInventoryCliUsageError) {
      stderr(`Storage inventory blocked: ${error.message}\n`);
      return STORAGE_INVENTORY_EXIT_CODES.usageBlocked;
    }
    // Parser and provider errors may contain source payload fragments. Do not
    // echo arbitrary exception messages from a metadata-only command.
    stderr("Storage inventory failed before a validated report was written.\n");
    return STORAGE_INVENTORY_EXIT_CODES.partial;
  }
}

interface OutputBoundary {
  readonly pluginDataPath: string;
  readonly physicalPluginDataPath: string;
  readonly requestedOutputDir: string;
  readonly physicalOutputDir: string;
}

interface OutputPayload {
  readonly filename: string;
  readonly content: string;
}

async function inspectOutputBoundary(
  options: StorageInventoryCliOptions
): Promise<OutputBoundary> {
  let vaultInfo: Awaited<ReturnType<typeof lstat>>;
  try {
    vaultInfo = await lstat(options.vaultPath);
  } catch {
    throw new StorageInventoryCliUsageError("--vault must exist and be readable");
  }
  if (!vaultInfo.isDirectory() || vaultInfo.isSymbolicLink()) {
    throw new StorageInventoryCliUsageError(
      "--vault must be a real directory, not a symlink"
    );
  }

  const physicalVaultPath = await realpath(options.vaultPath);
  const pluginDataPath = pluginDataDir(options.vaultPath, options.pluginDir);
  const physicalPluginDataPath = await resolvePhysicalCandidate(
    path.join(physicalVaultPath, path.relative(options.vaultPath, pluginDataPath))
  );
  const physicalOutputDir = await resolvePhysicalCandidate(options.outputDir);

  if (
    isPathWithin(pluginDataPath, options.outputDir)
    || isPathWithin(physicalPluginDataPath, physicalOutputDir)
  ) {
    throw new StorageInventoryCliUsageError(
      "--output-dir must be outside the scanned plugin directory"
    );
  }

  let outputInfo: Awaited<ReturnType<typeof lstat>> | undefined;
  try {
    outputInfo = await lstat(options.outputDir);
  } catch (error) {
    if (!isMissingPathError(error)) {
      throw new StorageInventoryCliUsageError(
        "--output-dir cannot be inspected safely"
      );
    }
  }
  if (outputInfo && (!outputInfo.isDirectory() || outputInfo.isSymbolicLink())) {
    throw new StorageInventoryCliUsageError(
      "--output-dir must be a real directory, not a symlink"
    );
  }

  return {
    pluginDataPath,
    physicalPluginDataPath,
    requestedOutputDir: options.outputDir,
    physicalOutputDir
  };
}

async function prepareOutputDirectory(
  options: StorageInventoryCliOptions,
  initial: OutputBoundary
): Promise<string> {
  const current = await inspectOutputBoundary(options);
  if (
    current.pluginDataPath !== initial.pluginDataPath
    || current.physicalPluginDataPath !== initial.physicalPluginDataPath
    || current.requestedOutputDir !== initial.requestedOutputDir
    || current.physicalOutputDir !== initial.physicalOutputDir
  ) {
    throw new StorageInventoryCliUsageError(
      "filesystem boundaries changed while inventory was running"
    );
  }

  await mkdir(current.physicalOutputDir, {
    recursive: true,
    mode: 0o700
  });
  const outputInfo = await lstat(current.physicalOutputDir);
  if (!outputInfo.isDirectory() || outputInfo.isSymbolicLink()) {
    throw new StorageInventoryCliUsageError(
      "--output-dir changed to an unsafe filesystem object"
    );
  }
  const confirmedPhysicalOutputDir = await realpath(current.physicalOutputDir);
  if (confirmedPhysicalOutputDir !== current.physicalOutputDir) {
    throw new StorageInventoryCliUsageError(
      "--output-dir crossed a symlink boundary"
    );
  }
  if (isPathWithin(current.physicalPluginDataPath, confirmedPhysicalOutputDir)) {
    throw new StorageInventoryCliUsageError(
      "--output-dir resolved inside the scanned plugin directory"
    );
  }
  return confirmedPhysicalOutputDir;
}

function outputPayloads(
  format: StorageInventoryOutputFormat,
  report: StorageInventoryReport,
  serializeReport: (report: unknown) => string,
  renderMarkdown: (report: unknown) => string
): OutputPayload[] {
  const outputs: OutputPayload[] = [];
  if (format === "json" || format === "both") {
    outputs.push({
      filename: STORAGE_INVENTORY_OUTPUT_FILES.json,
      content: serializeReport(report)
    });
  }
  if (format === "markdown" || format === "both") {
    outputs.push({
      filename: STORAGE_INVENTORY_OUTPUT_FILES.markdown,
      content: renderMarkdown(report)
    });
  }
  return outputs;
}

async function writeReportsAtomically(
  outputDir: string,
  outputs: readonly OutputPayload[]
): Promise<void> {
  const initialDirectory = await stat(outputDir);
  const staged: Array<{ tempPath: string; targetPath: string }> = [];

  try {
    for (const output of outputs) {
      const targetPath = path.join(outputDir, output.filename);
      const tempPath = path.join(
        outputDir,
        `.${output.filename}.${process.pid}.${randomUUID()}.tmp`
      );
      const handle = await open(tempPath, "wx", 0o600);
      try {
        await handle.writeFile(output.content, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      staged.push({ tempPath, targetPath });
    }

    // Each report file is committed by temp + fsync + rename. For `both`, the
    // human-readable Markdown lands first and JSON lands last as the machine
    // commit marker; both embed the same reportId and snapshotFingerprint.
    // This is a cooperative local-filesystem contract. Node does not expose
    // openat-style directory-relative writes, so this does not claim to resist
    // a hostile same-user process racing every path operation.
    const commitOrder = [...staged].sort((left, right) =>
      commitRank(left.targetPath) - commitRank(right.targetPath)
    );
    for (const entry of commitOrder) {
      const currentDirectory = await stat(outputDir);
      if (
        currentDirectory.dev !== initialDirectory.dev
        || currentDirectory.ino !== initialDirectory.ino
      ) {
        throw new StorageInventoryCliUsageError(
          "--output-dir changed before reports could be committed"
        );
      }
      await rename(entry.tempPath, entry.targetPath);
    }
  } finally {
    await Promise.all(staged.map(async (entry) => {
      try {
        await unlink(entry.tempPath);
      } catch (error) {
        if (!isMissingPathError(error)) throw error;
      }
    }));
  }
}

function commitRank(targetPath: string): number {
  return path.basename(targetPath) === STORAGE_INVENTORY_OUTPUT_FILES.json ? 1 : 0;
}

async function resolvePhysicalCandidate(candidatePath: string): Promise<string> {
  let cursor = path.resolve(candidatePath);
  const missingSegments: string[] = [];

  while (true) {
    try {
      await lstat(cursor);
      const physicalAncestor = await realpath(cursor);
      return path.resolve(physicalAncestor, ...missingSegments);
    } catch (error) {
      if (!isMissingPathError(error)) {
        throw new StorageInventoryCliUsageError(
          "filesystem boundary cannot be resolved safely"
        );
      }
      const parent = path.dirname(cursor);
      if (parent === cursor) {
        throw new StorageInventoryCliUsageError(
          "filesystem boundary has no existing ancestor"
        );
      }
      missingSegments.unshift(path.basename(cursor));
      cursor = parent;
    }
  }
}

function isPathWithin(rootPath: string, candidatePath: string): boolean {
  const relative = path.relative(path.resolve(rootPath), path.resolve(candidatePath));
  return relative === ""
    || (relative !== ".."
      && !relative.startsWith(`..${path.sep}`)
      && !path.isAbsolute(relative));
}

function isMissingPathError(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === "object"
    && "code" in error
    && (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
