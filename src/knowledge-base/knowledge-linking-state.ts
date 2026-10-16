import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { writeFileAtomic } from "./utils";
import type { KnowledgeLinkingTask } from "./knowledge-linking-types";

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
