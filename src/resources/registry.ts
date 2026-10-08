import type { WorkspaceResourceToggles } from "../settings/settings";
import type { EchoInkResource, EchoInkResourceSettings } from "./types";
import { resourcePresentation } from "./resource-presentation";

export interface BuildEchoInkResourceCatalogInput {
  manual?: EchoInkResource[];
  settings?: Partial<EchoInkResourceSettings>;
}

export function buildActiveEchoInkResourceCatalog(input: BuildEchoInkResourceCatalogInput = {}): EchoInkResource[] {
  const savedResources = filterActiveResources(input.settings?.catalog ?? []);
  const savedById = new Map(savedResources.map((resource) => [resource.id, resource]));
  const runtimeResources = filterActiveResources(input.manual ?? []).map((resource) => {
    const saved = savedById.get(resource.id);
    const legacyEnabled = input.settings?.legacyEnabledOverrides?.[resource.id];
    return saved
      ? { ...resource, enabled: saved.enabled }
      : typeof legacyEnabled === "boolean"
        ? { ...resource, enabled: legacyEnabled }
        : resource;
  });
  const runtimeIds = new Set(runtimeResources.map((resource) => resource.id));
  return uniqueResources([
    ...savedResources.filter((resource) =>
      resource.source === "manual" && !runtimeIds.has(resource.id)
    ),
    ...runtimeResources
  ]);
}

function filterActiveResources(resources: EchoInkResource[]): EchoInkResource[] {
  return resources.filter((resource) => {
    if (resource.kind === "mcp-server") return true;
    return resource.kind === "skill"
      && (resource.source === "echoink-local" || resource.source === "manual");
  });
}

export function enabledResources(catalog: EchoInkResource[]): EchoInkResource[] {
  return catalog.filter((resource) => resource.enabled);
}

export function enabledSkillResources(catalog: EchoInkResource[]): EchoInkResource[] {
  return enabledResources(catalog)
    .filter((resource) => resource.kind === "skill")
    .sort((left, right) => left.name.toLowerCase().localeCompare(right.name.toLowerCase(), "en") || left.id.localeCompare(right.id));
}

export function filterSkillResources(skills: EchoInkResource[], query: string): EchoInkResource[] {
  const q = query.trim().toLowerCase();
  const seen = new Set<string>();
  return skills
    .filter((skill) => {
      if (!q) return true;
      const chinese = resourcePresentation(skill, "zh-CN");
      const english = resourcePresentation(skill, "en");
      return [...chinese.aliases, chinese.description, english.description, skill.contentPath || ""]
        .some((value) => value.toLowerCase().includes(q));
    })
    .filter((skill) => {
      const key = `${skill.source}:${skill.name}`.trim().toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

export function workspaceResourcesFromEchoInkResources(
  _catalog: EchoInkResource[]
): WorkspaceResourceToggles {
  return { plugins: {}, mcpServers: {}, skills: {} };
}

export const codexResourceOverridesFromEchoInkResources = workspaceResourcesFromEchoInkResources;

export function hasEnabledMcpResources(
  catalog: EchoInkResource[]
): boolean {
  return mcpResourceEnablement(catalog).enabled > 0;
}

export function mcpResourceEnablement(
  catalog: EchoInkResource[]
): Readonly<{ total: number; enabled: number }> {
  const resources = catalog.filter((resource) => resource.kind === "mcp-server");
  return Object.freeze({
    total: resources.length,
    enabled: resources.filter((resource) => resource.enabled).length
  });
}

export function defaultResourceSettings(): EchoInkResourceSettings {
  return {
    catalog: [],
    importedFrom: {},
    mcpConnections: {},
    lastScannedAt: 0,
    lastError: ""
  };
}

function uniqueResources(resources: EchoInkResource[]): EchoInkResource[] {
  const seen = new Map<string, EchoInkResource>();
  for (const resource of resources) {
    if (!resource.id) continue;
    seen.set(resource.id, resource);
  }
  return Array.from(seen.values());
}
