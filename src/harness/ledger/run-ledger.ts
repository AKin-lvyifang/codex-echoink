import { appendFile, mkdir, readFile } from "node:fs/promises";
import * as path from "node:path";
import type { HarnessEvent } from "../contracts/event";

export interface RunLedger {
  append(event: HarnessEvent): Promise<void>;
  readRun(runId: string): Promise<HarnessEvent[]>;
}

export class InMemoryRunLedger implements RunLedger {
  private readonly eventsByRun = new Map<string, HarnessEvent[]>();

  async append(event: HarnessEvent): Promise<void> {
    const events = this.eventsByRun.get(event.runId) ?? [];
    events.push(event);
    this.eventsByRun.set(event.runId, events);
  }

  async readRun(runId: string): Promise<HarnessEvent[]> {
    return [...(this.eventsByRun.get(runId) ?? [])];
  }
}

export interface FileRunLedgerOptions {
  rootPath: string;
}

export class FileRunLedger implements RunLedger {
  constructor(private readonly options: FileRunLedgerOptions) {}

  async append(event: HarnessEvent): Promise<void> {
    const filePath = this.filePathForRun(event.runId);
    await mkdir(path.dirname(filePath), { recursive: true });
    await appendFile(filePath, `${JSON.stringify(event)}\n`, "utf8");
  }

  async readRun(runId: string): Promise<HarnessEvent[]> {
    const filePath = this.filePathForRun(runId);
    const text = await readFile(filePath, "utf8").catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
      throw error;
    });
    return text.split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as HarnessEvent)
      .sort((left, right) => left.sequence - right.sequence);
  }

  private filePathForRun(runId: string): string {
    return path.join(this.options.rootPath, `${safeRunFileName(runId)}.jsonl`);
  }
}

function safeRunFileName(runId: string): string {
  const safe = runId.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return safe || "run";
}
