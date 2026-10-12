import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { LifestyleStoreCore, type LifestyleFilePort } from "./store-core";
export * from "./store-core";

/** Desktop file adapter; shared transactions and normalization live in store-core. */
export class LifestyleStore extends LifestyleStoreCore {
  constructor(filePath: string) {
    let committed: string | null | undefined;
    const file: LifestyleFilePort = {
      read: async readOnly => {
        let content: string | null;
        try { content = await fsp.readFile(filePath, "utf8"); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") content = null; else throw error; }
        if (!readOnly) committed = content;
        return content;
      },
      backup: async content => {
        try { await fsp.writeFile(`${filePath}.finance-legacy-backup.json`, content, { encoding: "utf8", mode: 0o600, flag: "wx" }); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      },
      write: async (content, expected) => {
        const effectiveExpected = expected === undefined ? committed : expected;
        const check = async () => {
          if (effectiveExpected !== undefined && await file.read(true) !== effectiveExpected) throw new Error("finance_version_conflict");
        };
        await check();
        await fsp.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
        const temporary = `${filePath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
        try {
          await fsp.writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
          await check();
          await fsp.rename(temporary, filePath);
          committed = content;
        } catch (error) { await fsp.rm(temporary, { force: true }).catch(() => undefined); throw error; }
      }
    };
    super(file);
  }
}
