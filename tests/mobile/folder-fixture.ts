import { emptyKnowledgeFolderBindings } from "../../src/knowledge-base/folder-bindings";
import type { MobileServices } from "../../src/mobile/services";

/** Browser-only synthetic Vault adapter. No native device or user files are involved. */
export async function prepareFolderFixture(host: any, services: MobileServices): Promise<void> {
  for (const name of [...host.files.keys()] as string[]) {
    const parts = name.split("/"); parts.pop();
    for (let end = 1; end <= parts.length; end++) await host.app.vault.createFolder(parts.slice(0, end).join("/"));
  }
  const original = host.app.vault.getAbstractFileByPath.bind(host.app.vault);
  host.app.vault.getAbstractFileByPath = (path: string) => original(path) ?? ([...host.files.keys()].some((name: string) => name.startsWith(`${path}/`)) ? { path, name: path.split("/").pop(), children: [] } : null);
  Object.assign(host.app, { fileManager: { async renameFile(file: { path: string }, target: string) {
    const source = file.path;
    if (await host.adapter.exists(target)) throw new Error("Synthetic destination exists");
    for (const [name, content] of [...host.files] as [string, string][]) if (name === source || name.startsWith(`${source}/`)) {
      const current = original(name), next = target + name.slice(source.length);
      host.files.delete(name); host.files.set(next, content); if (current) { current.path = next; current.name = next.split("/").pop(); }
    }
    for (const name of [...host.folders] as string[]) if (name === source || name.startsWith(`${source}/`)) { host.folders.delete(name); host.folders.add(target + name.slice(source.length)); }
    file.path = target; host.app.vault.trigger("rename", file, source);
  } } });
  const bindings = emptyKnowledgeFolderBindings();
  for (const [role, path] of [["raw", "Raw"], ["wiki", "Wiki"], ["projects", "Projects"], ["inbox", "Inbox"]] as const) {
    await host.app.vault.createFolder(path);
    bindings.roles[role] = { enabled: true, readPaths: [path], writePath: path, allowedSubdirectories: [] };
  }
  const fresh = await services.knowledgeFolders.read();
  await services.knowledgeFolders.saveBindings(bindings, fresh.token);
}
