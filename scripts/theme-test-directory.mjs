import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** Companion source is distributed separately and must never be copied into this repository. */
export async function companionThemeTestDirectory() {
  const directory = path.resolve(process.env.ECHOINK_THEME_DIR?.trim() || path.join(homedir(), "Desktop", "echoink-theme"));
  let info;
  try { info = await stat(directory); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
  if (!info.isDirectory()) throw new Error("ECHOINK_THEME_DIR must point to a theme directory");
  return pathToFileURL(directory + path.sep);
}
