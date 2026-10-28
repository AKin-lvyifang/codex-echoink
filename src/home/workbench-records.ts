import { workbenchWeekKey, validWorkbenchDate } from "./workbench-source";
export { localWorkbenchDate, workbenchWeekKey, validWorkbenchDate } from "./workbench-source";
import { getDesktopFsPromises } from "../platform/desktop-filesystem";
import { getDesktopPath } from "../platform/desktop-paths";

import { getDesktopCrypto } from "../platform/desktop-crypto";
import type { App } from "obsidian";
import { pluginDataDir } from "../plugin/plugin-data-paths";
import type { WorkbenchTaskSource } from "./workbench-types";

const { createHash } = getDesktopCrypto();

const fsp = getDesktopFsPromises();
const path = getDesktopPath();

export const workbenchFingerprint = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");
export interface JournalTemplateBaseline { fingerprint: string; lines: string[] }
export interface InboxObservation {
  fingerprint: string;
  /** Missing for items already present at the first successful observation. */
  enteredAt?: number;
  present: boolean;
  processed?: { fingerprint: string; completedAt: number; resultPath: string };
}
export interface WorkbenchRecords {
  version: 1;
  inbox: Record<string, { observedAt: number; entries: Record<string, InboxObservation> }>;
  tasks: Record<string, { source: WorkbenchTaskSource; acceptedAt: number }>;
  journals: Record<string, JournalTemplateBaseline>;
  reviews: Record<string, { completedAt: number; outputPath: string; taskId?: string }>;
}
const emptyRecords = (): WorkbenchRecords => ({ version: 1, inbox: {}, tasks: {}, journals: {}, reviews: {} });
const stores = new Map<string, WorkbenchRecordStore>();

/** One serialized writer shared by the workbench, journal creation and ReviewManager. */
export class WorkbenchRecordStore {
  private queue: Promise<unknown> = Promise.resolve();
  private value: WorkbenchRecords | null = null;
  constructor(readonly filePath: string) {}
  private async read(): Promise<WorkbenchRecords> {
    if (this.value) return this.value;
    let text: string;
    try { text = await fsp.readFile(this.filePath, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return this.value = emptyRecords(); throw error; }
    const saved = JSON.parse(text) as WorkbenchRecords;
    if (saved?.version !== 1 || !saved.inbox || !saved.tasks || !saved.journals || !saved.reviews) throw new Error("工作台本地记录无法读取，已有文件已保留。");
    return this.value = saved;
  }
  async snapshot(): Promise<WorkbenchRecords> { await this.queue; return structuredClone(await this.read()); }
  update(mutate: (draft: WorkbenchRecords) => void): Promise<void> {
    const run = async () => {
      const current = await this.read(), next = structuredClone(current);
      mutate(next);
      if (JSON.stringify(current) === JSON.stringify(next)) return;
      await fsp.mkdir(path.dirname(this.filePath), { recursive: true });
      const temporary = `${this.filePath}.tmp`;
      await fsp.writeFile(temporary, `${JSON.stringify(next)}\n`, { mode: 0o600 });
      await fsp.rename(temporary, this.filePath);
      this.value = next;
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }
}

export function getWorkbenchRecordStore(vaultPath: string, pluginDir?: string): WorkbenchRecordStore {
  const target = path.join(pluginDataDir(vaultPath, pluginDir), "workbench-records.json");
  let store = stores.get(target);
  if (!store) { store = new WorkbenchRecordStore(target); stores.set(target, store); }
  return store;
}

export function workbenchStoreForApp(app: App): WorkbenchRecordStore | null {
  const adapter = app.vault.adapter as unknown as { getBasePath?(): string };
  const root = adapter.getBasePath?.();
  return root ? getWorkbenchRecordStore(root) : null;
}

export async function recordWorkbenchReviewSaved(
  app: App, range: { startDate: string; endDate: string }, outputPath: string, completedAt = Date.now(), taskId?: string
): Promise<void> {
  if (!validWorkbenchDate(range.startDate) || !validWorkbenchDate(range.endDate)) return;
  const start = new Date(`${range.startDate}T12:00:00`), end = new Date(`${range.endDate}T12:00:00`);
  if (workbenchWeekKey(start) !== range.startDate || workbenchWeekKey(end) !== range.startDate || end < start) return;
  const store = workbenchStoreForApp(app);
  if (store) await store.update(draft => { draft.reviews[range.startDate] = { completedAt, outputPath, ...(taskId ? { taskId } : {}) }; });
}
