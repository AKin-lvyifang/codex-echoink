import { getDesktopOs, getDesktopPath } from "../platform/desktop-paths";


const os = getDesktopOs();
const path = getDesktopPath();

export function expandHome(value: string, home = os.homedir()): string {
  if (value === "~") return home;
  if (!value.startsWith("~/") && !value.startsWith("~\\")) return value;
  const suffix = value.slice(2);
  return home.includes("\\") ? path.win32.join(home, suffix) : path.join(home, suffix.replace(/\\/g, path.sep));
}

export function normalizeSlashes(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\/+/, "");
}
