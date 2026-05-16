export interface WorkspaceResourceSearchRow {
  key: string;
  name: string;
  meta?: string;
  desc?: string;
}

export function filterWorkspaceResourceRows<T extends WorkspaceResourceSearchRow>(items: T[], query: string): T[] {
  const tokens = normalizeResourceSearchQuery(query);
  if (!tokens.length) return items;
  return items.filter((item) => {
    const haystack = [item.key, item.name, item.meta ?? "", item.desc ?? ""].join("\n").toLowerCase();
    return tokens.every((token) => haystack.includes(token));
  });
}

function normalizeResourceSearchQuery(query: string): string[] {
  return query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}
