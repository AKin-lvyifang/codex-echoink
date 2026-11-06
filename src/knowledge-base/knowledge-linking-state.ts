import { getDesktopFsPromises } from "../platform/desktop-filesystem";
import { getDesktopPath } from "../platform/desktop-paths";

import { writeFileAtomic } from "./utils";
import type { KnowledgeLinkingTask } from "./knowledge-linking-types";
import type { KnowledgeSystemMoveFile } from "./knowledge-system-move";
import { rebaseKnowledgePathRecords } from "./root-paths-core";

const fsp = getDesktopFsPromises();
const path = getDesktopPath();

export function rebaseKnowledgeLinkingMove(
  task: KnowledgeLinkingTask,
  files: readonly KnowledgeSystemMoveFile[],
): KnowledgeLinkingTask {
  let next = task;
  for (const file of files) next = rebaseKnowledgePathRecords(next, file.from, file.to);
  const paths = new Map(files.map((file) => [file.from, file.to]));
  for (const queued of next.queuedAutomatic ?? [])
    queued.paths = queued.paths.map((value) => paths.get(value) ?? value);
  delete next.pausedForMove;
  if (["completed", "partial", "cancelled"].includes(next.phase)) return next;
  next.proposals = [];
  next.patches = [];
  next.results = [];
  next.targetVersions = {};
  next.writeConfirmed = false;
  if (next.phase !== "queued") {
    next.phase = "interrupted";
    next.mode = "manual";
    next.error = "笔记已搬家，旧关联建议已作废；继续时重新扫描。";
  }
  return next;
}

/** Private plugin state; never creates a visible Knowledge report or tracker. */
export class KnowledgeLinkingStateStore {
  private queue: Promise<void> = Promise.resolve();
  constructor(readonly filePath: string) {}
  async load(): Promise<KnowledgeLinkingTask | null> {
    let raw: string;
    try { raw = await fsp.readFile(this.filePath, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
    const value = JSON.parse(raw) as KnowledgeLinkingTask;
    if (value.schemaVersion !== 1 || typeof value.id !== "string" || !/^[a-zA-Z0-9-]+$/u.test(value.id) || !Array.isArray(value.patches) || !Array.isArray(value.proposals) || !Array.isArray(value.results)) throw new Error("知识关联恢复记录无效。");
    return value;
  }
  async loadTask(id: string): Promise<KnowledgeLinkingTask | null> {
    if (!/^[a-zA-Z0-9-]+$/u.test(id)) return null;
    try { return JSON.parse(await fsp.readFile(path.join(path.dirname(this.filePath), "linking-results", `${id}.json`), "utf8")) as KnowledgeLinkingTask; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  }
  async saveRecord(task: KnowledgeLinkingTask): Promise<void> {
    if (!/^[a-zA-Z0-9-]+$/u.test(task.id)) throw new Error("知识关联任务标识无效。");
    const record = path.join(path.dirname(this.filePath), "linking-results", `${task.id}.json`);
    await fsp.mkdir(path.dirname(record), { recursive: true, mode: 0o700 });
    await writeFileAtomic(record, JSON.stringify(task));
  }
  async invalidateMoves(files: readonly KnowledgeSystemMoveFile[]): Promise<void> {
    await this.queue;
    const directory = path.join(path.dirname(this.filePath), "linking-results");
    let names: string[];
    try {
      names = await fsp.readdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const name of names.filter((name) => /^[a-zA-Z0-9-]+\.json$/u.test(name))) {
      const saved = await this.loadTask(name.slice(0, -5));
      if (saved) await this.saveRecord(rebaseKnowledgeLinkingMove(saved, files));
    }
  }
  save(task: KnowledgeLinkingTask): Promise<void> {
    const content = JSON.stringify(task);
    const next = this.queue.catch(() => undefined).then(async () => {
      await fsp.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
      await writeFileAtomic(this.filePath, content);
      await this.saveRecord(JSON.parse(content) as KnowledgeLinkingTask);
    });
    this.queue = next;
    return next;
  }
}
