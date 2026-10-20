import { requestUrl } from "obsidian";

export const ECHOINK_RELEASES_URL = "https://github.com/AKin-lvyifang/codex-echoink/releases";
const LATEST_RELEASE_URL = "https://api.github.com/repos/AKin-lvyifang/codex-echoink/releases/latest";

export type ReleaseUpdateState =
  | { status: "idle" | "checking" | "error" }
  | { status: "current" | "available"; version: string; url: string };

/** Compare release versions numerically, including SemVer prerelease ordering. */
export function compareReleaseVersions(left: string, right: string): number {
  const parse = (value: string) => {
    const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([\w.-]+))?(?:\+[\w.-]+)?$/.exec(value.trim());
    if (!match) throw new Error("Invalid release version");
    return { numbers: match.slice(1, 4).map(Number), pre: match[4]?.split(".") ?? [] };
  };
  const a = parse(left), b = parse(right);
  for (let i = 0; i < 3; i++) if (a.numbers[i] !== b.numbers[i]) return Math.sign(a.numbers[i] - b.numbers[i]);
  if (!a.pre.length || !b.pre.length) return Math.sign(b.pre.length - a.pre.length);
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i], y = b.pre[i];
    if (x === y) continue;
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y);
    if (xn && yn) return Math.sign(Number(x) - Number(y));
    if (xn !== yn) return xn ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

async function readLatestRelease(): Promise<unknown> {
  const response = await requestUrl({ url: LATEST_RELEASE_URL, method: "GET", headers: { Accept: "application/vnd.github+json" }, throw: false });
  if (response.status !== 200) throw new Error(`Release lookup failed (${response.status})`);
  return response.json;
}

/** No timers or startup requests: a check occurs only after the user's click. */
export class ReleaseUpdateController {
  state: ReleaseUpdateState = { status: "idle" };
  private listeners = new Set<() => void>();
  private pending: Promise<void> | null = null;
  constructor(private readonly read: () => Promise<unknown> = readLatestRelease) {}
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  check(currentVersion: string): Promise<void> {
    if (this.pending) return this.pending;
    this.state = { status: "checking" };
    // Schedule the request after installing the in-flight promise, including for
    // synchronous subscribers and callers that click twice in the same turn.
    this.pending = Promise.resolve().then(async () => {
      try {
        const value = await this.read() as { tag_name?: unknown; html_url?: unknown; draft?: boolean; prerelease?: boolean };
        if (!value || typeof value.tag_name !== "string" || value.draft || value.prerelease) throw new Error("Invalid release");
        const available = compareReleaseVersions(value.tag_name, currentVersion) > 0;
        const url = typeof value.html_url === "string" && value.html_url.startsWith(`${ECHOINK_RELEASES_URL}/tag/`)
          ? value.html_url : ECHOINK_RELEASES_URL;
        this.state = { status: available ? "available" : "current", version: value.tag_name.replace(/^v/, ""), url };
      } catch {
        this.state = { status: "error" };
      } finally {
        this.pending = null;
        this.notify();
      }
    });
    this.notify();
    return this.pending;
  }
  private notify(): void { for (const listener of this.listeners) listener(); }
}
