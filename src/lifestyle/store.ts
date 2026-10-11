import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { LifestyleStoreCore, type LifestyleFilePort } from "./store-core";
export * from "./store-core";

/** Desktop file adapter; shared transactions and normalization live in store-core. */
export class LifestyleStore extends LifestyleStoreCore {
  constructor(filePath: string) {
    const file: LifestyleFilePort = {
      read: async () => {
        try { return await fsp.readFile(filePath, "utf8"); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
      },
      backup: async content => {
        try { await fsp.writeFile(`${filePath}.finance-legacy-backup.json`, content, { encoding: "utf8", mode: 0o600, flag: "wx" }); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      },
      write: async content => {
        await fsp.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
        const temporary = `${filePath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
        try {
          await fsp.writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
          await fsp.rename(temporary, filePath);
        } catch (error) { await fsp.rm(temporary, { force: true }).catch(() => undefined); throw error; }
      }
    };
    super(file);
  }
}
