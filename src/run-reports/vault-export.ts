import type { App } from "obsidian";
import type { ReportSnapshot } from "./report";

// One lane per Vault: two exports in the same second must never choose the same path.
const lanes = new WeakMap<App["vault"], Promise<unknown>>();
export async function saveRunReport(app: App, snapshot: ReportSnapshot): Promise<string> {
  const save = (lanes.get(app.vault) ?? Promise.resolve()).catch(() => undefined).then(async () => {
    const directory = "EchoInk/运行记录";
    for (const path of ["EchoInk", directory]) if (!await app.vault.adapter.exists(path)) await app.vault.createFolder(path);
    const stem = snapshot.filename.replace(/\.json$/u, ""); let path = `${directory}/${snapshot.filename}`, index = 1;
    while (await app.vault.adapter.exists(path)) path = `${directory}/${stem}-${index++}.json`;
    await app.vault.create(path, snapshot.json); return path;
  });
  lanes.set(app.vault, save);
  try { return await save; } finally { if (lanes.get(app.vault) === save) lanes.delete(app.vault); }
}
