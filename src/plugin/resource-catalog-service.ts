import type CodexForObsidianPlugin from "../main";
import type {
  BuiltinSkillRuntimeSnapshot,
  SkillRuntimeCoordinator
} from "../harness/resources/skill-runtime";
import { buildActiveEchoInkResourceCatalog } from "../resources/registry";
import type { EchoInkResource } from "../resources/types";
import { loadVaultEchoInkResources } from "../resources/vault-resource-catalog";
import type { CodexForObsidianSettings } from "../settings/settings";

type ResourceCatalogHost = Pick<
  CodexForObsidianPlugin,
  | "getVaultPath"
  | "settings"
  | "withEchoInkResourceMutation"
  | "saveEchoInkResourceMutation"
> & {
  getSkillRuntimeCoordinator?: () => SkillRuntimeCoordinator;
};

/**
 * Lightweight runtime catalog boundary shared by Settings and the MCP protocol
 * service. It intentionally does not construct the retired Harness runtime.
 */
export class EchoInkResourceCatalogService {
  constructor(private readonly plugin: ResourceCatalogHost) {}

  async buildRuntimeCatalog(): Promise<EchoInkResource[]> {
    return await this.plugin.withEchoInkResourceMutation(
      async () => await this.scanAndCommitRuntimeCatalog()
    );
  }

  private async scanAndCommitRuntimeCatalog(): Promise<EchoInkResource[]> {
    let builtinSnapshots: readonly BuiltinSkillRuntimeSnapshot[] = [];
    let builtinSnapshotError = "";
    try {
      builtinSnapshots = await this.plugin.getSkillRuntimeCoordinator?.()
        .inspectBuiltinSkills() ?? [];
    } catch (error) {
      builtinSnapshotError = errorMessage(error);
    }
    const builtinStatusWarnings = builtinSkillSnapshotWarnings(builtinSnapshots);
    let vaultResources: Awaited<ReturnType<typeof loadVaultEchoInkResources>>;
    try {
      vaultResources = await loadVaultEchoInkResources({
        vaultPath: this.plugin.getVaultPath(),
        maxSkillBytes: 200_000
      });
    } catch (error) {
      this.plugin.settings.resources.lastError = [
        builtinSnapshotError,
        ...builtinStatusWarnings,
        errorMessage(error)
      ].filter(Boolean).join("\n");
      return this.lastKnownRuntimeCatalog(builtinSnapshots);
    }

    const liveResources = this.plugin.settings.resources;
    const previousResources = structuredClone(liveResources);
    const previousCatalog = structuredClone(liveResources.catalog);
    const previousLastError = liveResources.lastError;
    try {
      const scannedResources = mergeBuiltinSkillSnapshots(
        vaultResources.resources,
        builtinSnapshots,
        previousCatalog
      );
      const nextLastError = [...new Set([
        builtinSnapshotError,
        ...builtinStatusWarnings,
        ...vaultResources.warnings
      ].filter(Boolean))].join("\n");
      const catalog = buildActiveEchoInkResourceCatalog({
        settings: liveResources,
        manual: scannedResources
      });
      const nextSavedCatalog = replaceScannedResources(
        previousCatalog,
        catalog.filter((resource) => resource.source === "echoink-local")
      );
      const consumedLegacyOverrides = consumeLegacyEnabledOverrides(
        liveResources,
        scannedResources
      );
      const snapshotChanged = JSON.stringify(nextSavedCatalog)
        !== JSON.stringify(previousCatalog);
      const errorChanged = previousLastError !== nextLastError;
      if (snapshotChanged) {
        liveResources.catalog = structuredClone(nextSavedCatalog);
        liveResources.lastScannedAt = Date.now();
      }
      liveResources.lastError = nextLastError;
      if (snapshotChanged || errorChanged || consumedLegacyOverrides) {
        await this.plugin.saveEchoInkResourceMutation(previousResources);
      }
      const authoritativeResources = this.plugin.settings.resources;
      return buildActiveEchoInkResourceCatalog({
        settings: authoritativeResources,
        manual: scannedResources
      });
    } catch (error) {
      if (isRollbackSafeResourceMutation(error)) {
        return this.lastKnownRuntimeCatalog(builtinSnapshots);
      }
      throw error;
    }
  }

  private lastKnownRuntimeCatalog(
    builtinSnapshots: readonly BuiltinSkillRuntimeSnapshot[] = []
  ): EchoInkResource[] {
    const settings = this.plugin.settings.resources;
    const manual = mergeBuiltinSkillSnapshots(
      settings.catalog.filter((resource) => resource.source === "echoink-local"),
      builtinSnapshots,
      settings.catalog
    );
    return buildActiveEchoInkResourceCatalog({
      settings,
      manual
    });
  }
}

export function requireAvailableEchoInkSkillResource(
  catalog: readonly Readonly<EchoInkResource>[],
  skillId: string
): Readonly<EchoInkResource> {
  const id = skillId.trim();
  const resource = catalog.find((candidate) =>
    candidate.kind === "skill"
    && (
      candidate.id === id
      || candidate.metadata?.resourceId === id
    )
  );
  if (!resource) throw new Error(`Skill ${id} 不存在。`);
  if (!resource.enabled) throw new Error(`Skill ${id} 已停用。`);
  const fileStatus = resource.metadata?.fileStatus;
  if (fileStatus === "missing") {
    throw new Error(`Skill ${id} 的 SKILL.md 缺失。`);
  }
  if (fileStatus === "invalid") {
    throw new Error(`Skill ${id} 的 SKILL.md 已损坏。`);
  }
  const lifecycleStatus = resource.metadata?.lifecycleStatus;
  if (
    typeof lifecycleStatus === "string"
    && lifecycleStatus !== "active"
    && lifecycleStatus !== "downranked"
  ) {
    throw new Error(`Skill ${id} 的生命周期状态不可用。`);
  }
  if (!resource.contentPath?.trim()) {
    throw new Error(`Skill ${id} 没有可加载的 SKILL.md。`);
  }
  return resource;
}

function builtinSkillSnapshotWarnings(
  snapshots: readonly BuiltinSkillRuntimeSnapshot[]
): string[] {
  return snapshots.flatMap((snapshot) => {
    if (snapshot.fileStatus === "ready") return [];
    const state = snapshot.fileStatus === "missing" ? "缺失" : "损坏";
    return [
      `内置 Skill ${snapshot.id} 的 SKILL.md ${state}${snapshot.error ? `：${snapshot.error}` : "。"}`
    ];
  });
}

function mergeBuiltinSkillSnapshots(
  resources: EchoInkResource[],
  snapshots: readonly BuiltinSkillRuntimeSnapshot[],
  savedCatalog: EchoInkResource[]
): EchoInkResource[] {
  if (!snapshots.length) return resources;
  const merged = [...resources];
  const savedById = new Map(savedCatalog.map((resource) => [resource.id, resource]));
  const indexById = new Map(merged.map((resource, index) => [resource.id, index]));
  for (const snapshot of snapshots) {
    const id = `echoink-local:skill:${snapshot.id}`;
    const index = indexById.get(id);
    const scanned = index === undefined ? undefined : merged[index];
    const saved = savedById.get(id);
    const source = scanned ?? saved;
    const resource: EchoInkResource = {
      id,
      kind: "skill",
      source: "echoink-local",
      name: snapshot.fileStatus === "ready" && scanned
        ? scanned.name
        : snapshot.title,
      description: snapshot.fileStatus === "ready" && scanned
        ? scanned.description
        : snapshot.description,
      enabled: source?.enabled ?? true,
      bridgeMode: "prompt-only",
      contentPath: snapshot.relativePath,
      metadata: {
        ...(source?.metadata ?? {}),
        resourceId: snapshot.id,
        builtin: snapshot.source !== "user",
        contentSource: snapshot.source ?? "builtin",
        ...(snapshot.source === "official-remote" ? { tier: "pro", compareUrl: snapshot.compareUrl ?? null, remoteVersion: snapshot.remoteVersion ?? "", remoteCatalog: snapshot.remoteCatalog ?? null } : {}),
        userModified: snapshot.userModified,
        fileStatus: snapshot.fileStatus,
        lifecycleStatus: snapshot.lifecycleStatus,
        ...(snapshot.error ? { fileError: snapshot.error } : {})
      }
    };
    if (index === undefined) {
      indexById.set(id, merged.length);
      merged.push(resource);
    } else {
      merged[index] = resource;
    }
  }
  return merged;
}

function consumeLegacyEnabledOverrides(
  settings: CodexForObsidianSettings["resources"],
  scannedResources: EchoInkResource[]
): boolean {
  const overrides = settings.legacyEnabledOverrides;
  if (!overrides || Object.keys(overrides).length === 0) return false;
  const discoveredIds = new Set(scannedResources.map((resource) => resource.id));
  const remaining = Object.fromEntries(
    Object.entries(overrides).filter(([resourceId]) => !discoveredIds.has(resourceId))
  );
  if (Object.keys(remaining).length === Object.keys(overrides).length) return false;
  if (Object.keys(remaining).length) settings.legacyEnabledOverrides = remaining;
  else delete settings.legacyEnabledOverrides;
  return true;
}

function replaceScannedResources(
  liveCatalog: EchoInkResource[],
  scannedResources: EchoInkResource[]
): EchoInkResource[] {
  const liveById = new Map(liveCatalog.map((resource) => [resource.id, resource]));
  return [
    ...liveCatalog.filter((resource) => resource.source !== "echoink-local"),
    ...scannedResources.map((resource) => {
      const live = liveById.get(resource.id);
      return live ? { ...resource, enabled: live.enabled } : resource;
    })
  ];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRollbackSafeResourceMutation(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === "object"
    && (error as { rollbackSafe?: unknown }).rollbackSafe === true
  );
}
