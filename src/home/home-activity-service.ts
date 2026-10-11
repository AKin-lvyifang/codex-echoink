import * as fsp from "node:fs/promises";
import { writeFileAtomic, isMissingPathError } from "../knowledge-base/utils";
import { HomeActivityCore } from "./home-activity-core";
export * from "./home-activity-core";

/** Desktop storage adapter; the shared activity model also runs on mobile. */
export class HomeActivityService extends HomeActivityCore {
  constructor(filePath: string, now: () => number = Date.now) {
    super({
      async read() {
        try { return await fsp.readFile(filePath, "utf8"); }
        catch (error) { if (isMissingPathError(error)) return null; throw error; }
      },
      write: bytes => writeFileAtomic(filePath, bytes)
    }, now);
  }
}
