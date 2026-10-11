import type { DataAdapter } from "obsidian";

/** Match desktop's legacy data-root selection without loading Node modules. */
export async function mobilePluginDataRoot(adapter: DataAdapter, install: string, id: string, manifestDirectory?: string): Promise<string> {
  const legacyDirectory = (manifestDirectory?.trim() || id).replace(/\\/gu, "/").replace(/^\/+|\/+$/gu, "");
  const previous = legacyDirectory.startsWith(".obsidian/plugins/") ? legacyDirectory : `.obsidian/plugins/${legacyDirectory}`;
  if (previous === install) return install;
  const containsData = async (path: string): Promise<boolean> => {
    const stat = await adapter.stat(path);
    if (!stat) return false;
    if (stat.type === "file") return stat.size > 0;
    const children = await adapter.list(path);
    for (const child of [...children.files, ...children.folders]) if (await containsData(child)) return true;
    return false;
  };
  for (const name of ["pi-agent-product-v1", "home-activity.json", "raw", "clipboard"]) if (await containsData(`${previous}/${name}`)) return previous;
  return install;
}
