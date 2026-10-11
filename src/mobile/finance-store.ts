import type { DataAdapter } from "obsidian";
import { LifestyleStoreCore, type LifestyleFilePort } from "../lifestyle/store-core";

export function mobileAtomicFilePort(adapter: DataAdapter, file: string): LifestyleFilePort {
  const directory = file.slice(0, file.lastIndexOf("/"));
  const mkdir = async () => {
    let parent = "";
    for (const segment of directory.split("/")) { parent = parent ? `${parent}/${segment}` : segment; if (!await adapter.exists(parent)) await adapter.mkdir(parent); }
  };
  const port: LifestyleFilePort = {
    read: async () => await adapter.exists(file) ? adapter.read(file) : null,
    backup: async content => {
      const backup = `${file}.finance-legacy-backup.json`;
      await mkdir(); if (!await adapter.exists(backup)) await adapter.write(backup, content);
    },
    write: async content => {
      await mkdir();
      const temporary = `${file}.${Math.random().toString(36).slice(2)}.tmp`;
      try { await adapter.write(temporary, content); await adapter.rename(temporary, file); }
      catch (error) { if (await adapter.exists(temporary)) await adapter.remove(temporary).catch(() => {}); throw error; }
    }
  };
  return port;
}
export function mobileLifestyleStore(adapter: DataAdapter, file: string): LifestyleStoreCore { return new LifestyleStoreCore(mobileAtomicFilePort(adapter, file)); }
