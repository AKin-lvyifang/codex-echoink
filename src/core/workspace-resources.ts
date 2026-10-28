import type { CodexPluginInfo, CodexSkill, McpServerStatus, WorkspaceResourceSnapshot } from "../types/app-server";
import type { ResourceManagementTab, WorkspaceResourceCache } from "../settings/settings";

export type WorkspaceResourceKind = "plugins" | "mcp" | "skills";

export function emptyWorkspaceResourceSnapshot(): WorkspaceResourceSnapshot {
  return {
    plugins: [],
    skills: [],
    mcpServers: [],
    errors: {}
  };
}

export function mergeWorkspaceResourceSnapshot(
  snapshot: WorkspaceResourceSnapshot | null,
  kind: WorkspaceResourceKind,
  data: CodexPluginInfo[] | CodexSkill[] | McpServerStatus[],
  error: string | null
): WorkspaceResourceSnapshot {
  const next = snapshot ? cloneSnapshot(snapshot) : emptyWorkspaceResourceSnapshot();
  if (kind === "plugins") {
    next.plugins = data as CodexPluginInfo[];
    setError(next, "plugins", error);
  } else if (kind === "mcp") {
    next.mcpServers = data;
    setError(next, "mcp", error);
  } else {
    next.skills = data as CodexSkill[];
    setError(next, "skills", error);
  }
  return next;
}

export function snapshotFromWorkspaceResourceCache(cache: WorkspaceResourceCache | undefined): WorkspaceResourceSnapshot {
  return {
    plugins: cache?.plugins?.items ?? [],
    skills: cache?.skills?.items ?? [],
    mcpServers: cache?.mcp?.items ?? [],
    errors: {
      ...(cache?.plugins?.error ? { plugins: cache.plugins.error } : {}),
      ...(cache?.skills?.error ? { skills: cache.skills.error } : {}),
      ...(cache?.mcp?.error ? { mcp: cache.mcp.error } : {})
    }
  };
}

export function loadedTabsFromWorkspaceResourceCache(cache: WorkspaceResourceCache | undefined): Record<ResourceManagementTab, boolean> {
  return {
    plugins: Boolean(cache?.plugins),
    mcp: Boolean(cache?.mcp),
    skills: Boolean(cache?.skills)
  };
}

export function errorsFromWorkspaceResourceCache(cache: WorkspaceResourceCache | undefined): Partial<Record<ResourceManagementTab, string>> {
  return {
    ...(cache?.plugins?.error ? { plugins: cache.plugins.error } : {}),
    ...(cache?.mcp?.error ? { mcp: cache.mcp.error } : {}),
    ...(cache?.skills?.error ? { skills: cache.skills.error } : {})
  };
}

export function updateWorkspaceResourceCache(
  cache: WorkspaceResourceCache | undefined,
  kind: WorkspaceResourceKind,
  data: CodexPluginInfo[] | CodexSkill[] | McpServerStatus[],
  error: string | null
): WorkspaceResourceCache {
  const next: WorkspaceResourceCache = { ...(cache ?? {}) };
  const entry = {
    fetchedAt: Date.now(),
    items: sanitizeCacheItems(kind, data),
    ...(error ? { error } : {})
  };
  if (kind === "plugins") next.plugins = entry as WorkspaceResourceCache["plugins"];
  else if (kind === "mcp") next.mcp = entry;
  else next.skills = entry as WorkspaceResourceCache["skills"];
  return next;
}

export function mergeMcpServers(configuredServers: McpServerStatus[], statusServers: McpServerStatus[]): McpServerStatus[] {
  const byName = new Map<string, McpServerStatus>();
  for (const server of configuredServers) {
    if (server.name) byName.set(server.name, server);
  }
  for (const server of statusServers) {
    if (server.name) byName.set(server.name, { ...byName.get(server.name), ...server });
  }
  return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
}

function cloneSnapshot(snapshot: WorkspaceResourceSnapshot): WorkspaceResourceSnapshot {
  return {
    plugins: [...snapshot.plugins],
    skills: [...snapshot.skills],
    mcpServers: [...snapshot.mcpServers],
    errors: { ...snapshot.errors }
  };
}

function setError(snapshot: WorkspaceResourceSnapshot, key: keyof WorkspaceResourceSnapshot["errors"], error: string | null): void {
  if (error) snapshot.errors[key] = error;
  else delete snapshot.errors[key];
}

function sanitizeCacheItems(kind: WorkspaceResourceKind, data: CodexPluginInfo[] | CodexSkill[] | McpServerStatus[]): CodexPluginInfo[] | CodexSkill[] | McpServerStatus[] {
  if (kind === "mcp") {
    return (data as McpServerStatus[]).map((server) => ({
      name: server.name,
      authStatus: server.authStatus,
      tools: Object.fromEntries(Object.keys(server.tools ?? {}).map((toolName) => [toolName, true])),
      resources: [],
      resourceTemplates: []
    }));
  }
  if (kind === "plugins") {
    return (data as CodexPluginInfo[]).map((plugin) => ({ ...plugin }));
  }
  return (data as CodexSkill[]).map((skill) => ({ ...skill }));
}
