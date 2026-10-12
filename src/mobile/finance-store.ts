import type { DataAdapter } from "obsidian";
import { LifestyleStoreCore, type LifestyleFilePort } from "../lifestyle/store-core";
import { readMobileFile, replaceMobileFile } from "./replace-file";

export function mobileAtomicFilePort(adapter: DataAdapter, file: string): LifestyleFilePort {
  const directory = file.slice(0, file.lastIndexOf("/"));
  const replacement = `${file}.finance-replace-backup.json`;
  let expected: string | null | undefined;
  const read = async () => {
    // A stopped save may have parked the ledger before installing its new copy.
    // If a file appeared meanwhile, rename must refuse to overwrite it.
    if (!await adapter.exists(file) && await adapter.exists(replacement)) await adapter.rename(replacement, file);
    return readMobileFile(adapter, file);
  };
  const mkdir = async () => {
    let parent = "";
    for (const segment of directory.split("/")) { parent = parent ? `${parent}/${segment}` : segment; if (!await adapter.exists(parent)) await adapter.mkdir(parent); }
  };
  const port: LifestyleFilePort = {
    read: async readOnly => {
      if (readOnly) return readMobileFile(adapter, await adapter.exists(file) ? file : replacement);
      expected = await read(); return expected;
    },
    backup: async content => {
      const backup = `${file}.finance-legacy-backup.json`;
      await mkdir(); if (!await adapter.exists(backup)) await adapter.write(backup, content);
    },
    write: async (content, expectedContent) => {
      await mkdir();
      const current = await read();
      if (expected === undefined) expected = current;
      const conflict = () => new Error("财务资料已变化，请重新打开账本后再编辑；原资料已保留。");
      const effectiveExpected = expectedContent === undefined ? expected : expectedContent;
      if (current !== effectiveExpected) throw conflict();
      // A completed/interrupted install can leave an older recovery copy. The
      // current ledger stays in place until the next prepared replacement.
      if (current !== null && await adapter.exists(replacement)) await adapter.remove(replacement);
      await replaceMobileFile(adapter, file, content, effectiveExpected, replacement, conflict);
      expected = content;
      // Installation has succeeded; cleanup failure must not report a failed
      // save while the store continues showing its previous snapshot.
      try { if (await adapter.exists(replacement)) await adapter.remove(replacement); } catch { /* The installed ledger and recovery copy are both intact. */ }
    }
  };
  return port;
}
export function mobileLifestyleStore(adapter: DataAdapter, file: string): LifestyleStoreCore { return new LifestyleStoreCore(mobileAtomicFilePort(adapter, file)); }
