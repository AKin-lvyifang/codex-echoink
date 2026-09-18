import * as path from "node:path";
import * as fsp from "node:fs/promises";

export const CURRENT_PLUGIN_ID = "codex-echoink";

interface PluginLocation {
  id: string;
  dir?: string;
}

// Knowledge operations only carry the Vault path. Resolve them to the same
// root selected once at plugin startup, including its canonical-path alias.
const activeRoots = new Map<string, { rootPath: string; pluginDir: string; id: string }>();

export function pluginInstallDir(manifest: PluginLocation, configDir = ".obsidian"): string {
  return normalizePluginDir(manifest.dir?.trim()
    || `${configDir}/plugins/${manifest.id}`);
}

export function pluginDataDir(
  vaultPath: string,
  pluginDir?: string
): string {
  const normalized = normalizePluginDir(pluginDir ?? CURRENT_PLUGIN_ID);
  const active = activeRoots.get(path.resolve(vaultPath));
  if (active && (pluginDir === undefined || normalized === active.pluginDir || normalized === active.id)) {
    return active.rootPath;
  }
  // manifest.dir is Vault-relative, regardless of the config directory name.
  if (normalized.includes("/")) {
    return path.join(vaultPath, normalized);
  }
  return path.join(vaultPath, ".obsidian", "plugins", normalized);
}

export async function preparePluginDataRoot(
  vaultPath: string,
  manifest: PluginLocation,
  configDir: string
): Promise<{
  rootPath: string;
  installRootPath: string;
  usingPreviousRoot: boolean;
  installRootHasData: boolean;
  dispose(): void;
}> {
  const canonicalVaultPath = await fsp.realpath(vaultPath);
  const pluginDir = pluginInstallDir(manifest, configDir);
  const installRootPath = path.join(canonicalVaultPath, pluginDir);
  const previousDir = normalizePluginDir(manifest.dir?.trim() || manifest.id);
  const previousRootPath = previousDir.startsWith(".obsidian/plugins/")
    ? path.join(canonicalVaultPath, previousDir)
    : path.join(canonicalVaultPath, ".obsidian", "plugins", previousDir);
  const usingPreviousRoot = previousRootPath !== installRootPath
    && await hasCurrentPluginData(previousRootPath);
  const installRootHasData = usingPreviousRoot && await hasCurrentPluginData(installRootPath);
  // The previous release used this root. Keep its absolute Pi session paths
  // valid; never merge two independent stores or initialize over either one.
  const rootPath = usingPreviousRoot ? previousRootPath : installRootPath;
  const binding = { rootPath, pluginDir, id: manifest.id };
  const aliases = new Set([path.resolve(vaultPath), canonicalVaultPath]);
  for (const alias of aliases) activeRoots.set(alias, binding);
  return {
    rootPath, installRootPath, usingPreviousRoot, installRootHasData,
    dispose() {
      for (const alias of aliases) {
        if (activeRoots.get(alias) === binding) activeRoots.delete(alias);
      }
    }
  };
}

async function hasCurrentPluginData(rootPath: string): Promise<boolean> {
  // Only current durable stores count, not an empty directory or plugin files.
  for (const name of ["pi-agent-product-v1", "home-activity.json", "raw", "clipboard"]) {
    if (await containsDataFile(path.join(rootPath, name))) return true;
  }
  return false;
}

async function containsDataFile(filePath: string): Promise<boolean> {
  try {
    const stat = await fsp.lstat(filePath);
    if (stat.isFile()) return stat.size > 0;
    if (!stat.isDirectory()) return false;
    for (const entry of await fsp.readdir(filePath)) {
      if (await containsDataFile(path.join(filePath, entry))) return true;
    }
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function normalizePluginDir(value: string): string {
  const normalized = value.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (!normalized) return CURRENT_PLUGIN_ID;
  if (normalized.split("/").includes("..")) throw new Error("非法插件目录");
  return normalized;
}
