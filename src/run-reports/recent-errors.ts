import { redactReportText, type RedactionContext } from "./report";

export interface RecentRunError { at: string; source: string; conversationId?: string; runId?: string; code: string; message: string; stack?: string; cause?: string }
/** Per-plugin-load memory only. Never patches console, Notice, or persistent storage. */
export class RunErrorRecorder {
  private readonly records: RecentRunError[] = [];
  constructor(private context: () => RedactionContext = () => ({})) {}
  reset(context: () => RedactionContext = () => ({})): void { this.records.length = 0; this.context = context; }
  record(source: string, error: unknown, ids: { conversationId?: string; runId?: string; code?: string } = {}): void {
    // Logging must never hide the original failure if configuration is unavailable.
    let context: RedactionContext = {}; try { context = this.context(); } catch { /* Early startup. */ }
    const clean = (text: string) => redactReportText(text, context);
    const bounded = (text: string, limit = 2048): string => { let result = clean(text); while (new TextEncoder().encode(result).byteLength > limit) result = result.slice(0, Math.floor(result.length * .8)); return result; };
    const text = (value: unknown): string => { if (value instanceof Error) return value.message; if (typeof value === "string") return value; try { return JSON.stringify(value) ?? "unknown"; } catch { return "unserializable_error"; } };
    const value = error instanceof Error ? error : new Error(text(error));
    const rawCode = (error as { code?: unknown } | null)?.code;
    const record: RecentRunError = { at: new Date().toISOString(), source: clean(source), ...ids,
      code: clean(ids.code ?? (typeof rawCode === "string" ? rawCode : "unknown")), message: clean(value.message),
      ...(value.stack ? { stack: bounded(value.stack, value.cause === undefined ? 2048 : 1536) } : {}), ...(value.cause !== undefined ? { cause: bounded(value.cause instanceof Error ? value.cause.message : text(value.cause), 512) } : {}) };
    this.records.push(record); if (this.records.length > 200) this.records.shift();
  }
  snapshot(): RecentRunError[] { return structuredClone(this.records); }
}
// Each device build is loaded once for the lifetime of its plugin module.
export const runErrors = new RunErrorRecorder();
