import * as os from "os";
import * as path from "path";

export function expandHome(value: string, home = os.homedir()): string {
  if (value === "~") return home;
  if (!value.startsWith("~/") && !value.startsWith("~\\")) return value;
  const suffix = value.slice(2);
  return home.includes("\\") ? path.win32.join(home, suffix) : path.join(home, suffix.replace(/\\/g, path.sep));
}

export function normalizeSlashes(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\/+/, "");
}
