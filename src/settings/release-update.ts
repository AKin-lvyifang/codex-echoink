import { requestUrl } from "obsidian";
import { readDeviceSettings, writeDeviceSettings, type DeviceSettingsPort } from "../sync/device-settings";

export const ECHOINK_RELEASES_URL = "https://github.com/AKin-lvyifang/codex-echoink/releases";
export const ECHOINK_COMMUNITY_URI = "obsidian://show-plugin?id=codex-echoink";
const RELEASES_API = "https://echoink.cn/api/releases";
const RELEASE_STATE_KEY = "echoink-release-reminders";
const REFRESH_INTERVAL = 12 * 60 * 60 * 1000;
const RETRY_DELAY = 5 * 60 * 1000;
const VERSION_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)(?:-([\w.-]+))?(?:\+[\w.-]+)?$/;
const STABLE_VERSION_PATTERN = /^v?\d+\.\d+\.\d+$/;

interface PublicRelease {
  version: string;
  url: string;
  name: string;
  body: string;
  bodyEn: string;
}

export interface ReleaseNotes {
  version: string;
  title: string;
  markdown: string;
}

export type ReleaseUpdateState =
  | { status: "idle" | "checking" | "error" }
  | { status: "current" | "available"; version: string; url: string };

/** Compare release versions numerically, including SemVer prerelease ordering. */
export function compareReleaseVersions(left: string, right: string): number {
  const parse = (value: string) => {
    const match = VERSION_PATTERN.exec(value.trim());
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

async function readPublicReleases(): Promise<unknown> {
  const response = await requestUrl({ url: RELEASES_API, method: "GET", headers: { Accept: "application/json" }, throw: false });
  if (response.status !== 200) throw new Error(`Release lookup failed (${response.status})`);
  return response.json;
}

function versionValue(value: unknown, pattern: RegExp): string | undefined {
  return typeof value === "string" && pattern.test(value) ? value.replace(/^v/, "") : undefined;
}

function parsePublicReleases(value: unknown): PublicRelease[] {
  if (!value || typeof value !== "object" || !("releases" in value) || !Array.isArray(value.releases)) throw new Error("Invalid releases");
  const entries: unknown[] = value.releases;
  const releases: PublicRelease[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || !("tag" in entry)) continue;
    const fields = entry as Record<string, unknown>;
    const version = versionValue(fields.tag, STABLE_VERSION_PATTERN);
    if (!version || fields.draft === true || fields.prerelease === true) continue;
    const releaseUrl = `${ECHOINK_RELEASES_URL}/tag/`;
    const url = fields.url === releaseUrl + version || fields.url === releaseUrl + "v" + version ? fields.url : ECHOINK_RELEASES_URL;
    releases.push({
      version, url,
      name: typeof fields.name === "string" ? fields.name.trim() : "",
      body: typeof fields.body === "string" ? fields.body : "",
      bodyEn: typeof fields.bodyEn === "string" ? fields.bodyEn : ""
    });
  }
  if (!releases.length) throw new Error("No published releases");
  return releases.sort((a, b) => compareReleaseVersions(b.version, a.version));
}

/** Keep ordinary Markdown, but neutralize HTML and image or vault embed syntax before handing it to Obsidian. */
function prepareReleaseNotes(body: string): string {
  let skipHeadingLevel = 0;
  let fence = "";
  const lines: string[] = [];
  for (const line of body.split(/\r?\n/)) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length && line.trim() === marker) fence = "";
    }
    if (!fence && !marker) {
      const heading = /^ {0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/.exec(line);
      if (heading) {
        const level = heading[1].length;
        if (skipHeadingLevel && level <= skipHeadingLevel) skipHeadingLevel = 0;
        if (!skipHeadingLevel && /^(?:下载与升级|Download and upgrade)$/i.test(heading[2])) skipHeadingLevel = level;
      }
    }
    if (skipHeadingLevel) continue;
    lines.push(line.replace(/</g, "&lt;").replace(/!(?=\[)/g, ""));
  }
  return lines.join("\n").trim();
}

/** The settings button and all workbench views share one cache and one in-flight request. */
export class ReleaseUpdateController {
  state: ReleaseUpdateState = { status: "idle" };
  private readonly listeners = new Set<() => void>();
  private pending: Promise<void> | null = null;
  private releases: PublicRelease[] = [];
  private refreshAfter = 0;
  private retryAfter = 0;
  private device?: DeviceSettingsPort;
  private seenVersion?: string;
  private dismissedVersion?: string;

  constructor(private readonly read: () => Promise<unknown> = readPublicReleases, private readonly now = Date.now) {}

  initialize(device: DeviceSettingsPort, currentVersion: string, emptyData: boolean): void {
    this.device = device;
    const saved = readDeviceSettings(device, RELEASE_STATE_KEY);
    this.seenVersion = versionValue(saved?.seenVersion, VERSION_PATTERN);
    this.dismissedVersion = versionValue(saved?.dismissedVersion, STABLE_VERSION_PATTERN);
    if (emptyData && !this.seenVersion) {
      this.seenVersion = versionValue(currentVersion, VERSION_PATTERN);
      this.persist();
    }
  }

  reminders(currentVersion: string, language: string): { updateVersion?: string; notes?: ReleaseNotes } {
    const version = versionValue(currentVersion, VERSION_PATTERN);
    const latest = this.releases[0]?.version;
    if (!version || !latest) return {};
    const updateVersion = latest !== this.dismissedVersion && compareReleaseVersions(latest, version) > 0 ? latest : undefined;
    if (this.seenVersion && compareReleaseVersions(version, this.seenVersion) <= 0) return { updateVersion };
    const release = this.releases.find(entry => entry.version === version);
    if (!release) return { updateVersion };
    const english = language === "en";
    const markdown = prepareReleaseNotes(english && release.bodyEn.trim() ? release.bodyEn : release.body);
    const title = english ? `What's new in ${version}` : release.name || `${version} 更新了什么`;
    return { updateVersion, notes: markdown ? { version, title, markdown } : undefined };
  }

  markNotesSeen(version: string): void {
    if (this.seenVersion && compareReleaseVersions(version, this.seenVersion) <= 0) return;
    this.seenVersion = version;
    this.persist();
    this.notify();
  }

  dismissUpdate(version: string): void {
    this.dismissedVersion = version;
    this.persist();
    this.notify();
  }

  private persist(): void {
    writeDeviceSettings(this.device, { seenVersion: this.seenVersion, dismissedVersion: this.dismissedVersion }, RELEASE_STATE_KEY);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  checkIfStale(currentVersion: string): Promise<void> {
    if (this.pending) return this.pending;
    const now = this.now();
    if (now < this.refreshAfter || now < this.retryAfter) return Promise.resolve();
    return this.check(currentVersion);
  }

  check(currentVersion: string): Promise<void> {
    if (this.pending) return this.pending;
    this.state = { status: "checking" };
    // Schedule the request after installing the in-flight promise, including for
    // synchronous subscribers and callers that click twice in the same turn.
    this.pending = Promise.resolve().then(async () => {
      try {
        const releases = parsePublicReleases(await this.read());
        const { version, url } = releases[0];
        const available = compareReleaseVersions(version, currentVersion) > 0;
        this.releases = releases;
        this.refreshAfter = this.now() + REFRESH_INTERVAL;
        this.retryAfter = 0;
        this.state = { status: available ? "available" : "current", version, url };
      } catch {
        this.retryAfter = this.now() + RETRY_DELAY;
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
