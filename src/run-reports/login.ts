import type { ReportSnapshot } from "./report";

export const REPORT_LOGIN_TTL = 10 * 60 * 1000;
interface PendingReport {
  snapshot: ReportSnapshot;
  source: object;
  expiresAt: number;
  resume: (snapshot: ReportSnapshot, active: () => boolean) => void | Promise<void>;
}

/** One plugin-owned, memory-only continuation. Account refreshes never consume it. */
export class RunReportLogin {
  private pending?: PendingReport;
  private timer?: number;
  private disposed = false;
  private generation = 0;
  constructor(private readonly now = () => Date.now()) {}
  request(snapshot: ReportSnapshot, source: object, resume: PendingReport["resume"]): () => void {
    ++this.generation;
    this.clear();
    if (this.disposed) return () => {};
    const pending = { snapshot, source, resume, expiresAt: this.now() + REPORT_LOGIN_TTL };
    this.pending = pending;
    this.timer = window.setTimeout(() => this.clear(), REPORT_LOGIN_TTL);
    return () => { if (this.pending === pending) this.clear(); };
  }
  async returned(): Promise<void> {
    const pending = this.pending;
    const generation = this.generation;
    this.clear();
    if (!this.disposed && pending && pending.expiresAt > this.now()) await pending.resume(pending.snapshot, () => !this.disposed && generation === this.generation);
  }
  private clear(): void {
    if (this.timer !== undefined) window.clearTimeout(this.timer);
    this.timer = undefined; this.pending = undefined;
  }
  dispose(): void { this.disposed = true; this.clear(); }
}

export class RunReportAuthError extends Error {
  readonly code = "AUTH_REQUIRED";
  constructor() { super("Sign in required"); }
}
export function isRunReportAuthError(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return code === "AUTH_REQUIRED" || code === "UNAUTHORIZED";
}
export function reportExportMessage(path: string, english: boolean, support = false): string {
  return english ? `Exported to vault: ${path}.${support ? " If you can't sign in, email this file to support@echoink.cn." : ""}`
    : `已导出到笔记库：${path}${support ? "。登录不了时，把这个文件发到 support@echoink.cn。" : ""}`;
}
