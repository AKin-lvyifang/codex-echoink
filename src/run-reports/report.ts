import { redactEchoInkLocalSecretsV1, REDACTED_SECRET, replaceKnownSecrets } from "../security/local-secrets";

export const RUN_REPORT_LIMIT = 8 * 1024 * 1024;
export interface RunReport {
  format: "echoink-run-report";
  formatVersion: 1;
  createdAt: string;
  description: string;
  contact: string;
  environment: { pluginVersion: string; obsidianVersion: string; platform: string; surface: "desktop" | "iphone" | "ipad"; language: "zh" | "en"; membership: string };
  conversation: { id: string; title: string; agent: string; provider: string; model: string; catalogStatus: "active" | "archived" | "deleted"; activeLeafId: string | null };
  runs: unknown[];
  diagnostics: unknown[];
  recentErrors: unknown[];
  entries: unknown[];
  missing: string[];
  redaction: { applied: true; rules: "v1" };
}
export interface RedactionContext { secrets?: readonly string[]; vaultPath?: string; homePath?: string }
/** No selected conversation: keep the envelope valid without inventing session data. */
export function reportWithoutConversation(environment: RunReport["environment"], recentErrors: unknown[]): RunReport {
  return { format: "echoink-run-report", formatVersion: 1, createdAt: new Date().toISOString(), description: "", contact: "", environment,
    conversation: { id: "", title: "", agent: "", provider: "", model: "", catalogStatus: "active", activeLeafId: null },
    runs: [], diagnostics: [], recentErrors, entries: [], missing: ["conversation_not_open", "catalog_status_not_applicable"], redaction: { applied: true, rules: "v1" } };
}
const sensitiveField = /^(?:cookie|set[-_]?cookie|authorization|proxy[-_]?authorization|password|credential(?:value)?|access|refresh|[\w-]*(?:token|key|secret))$/iu;

/** Only configuration credentials are collected, never the complete settings document. */
export function configuredReportSecrets(settings: { apiProviders?: unknown; resources?: unknown; openAICodexCredential?: unknown; tavily?: unknown }): string[] {
  const values = new Set<string>();
  const visit = (value: unknown, all = false): void => {
    if (typeof value === "string") { if (all && value) values.add(value); return; }
    if (!value || typeof value !== "object") return;
    for (const [key, item] of Object.entries(value)) visit(item, all || sensitiveField.test(key) || /^(?:env|headers)$/iu.test(key));
  };
  visit(settings.apiProviders); visit(settings.resources); visit(settings.openAICodexCredential); visit(settings.tavily);
  return [...values];
}

export function redactReportText(value: string, context: RedactionContext = {}): string {
  const secrets = (context.secrets ?? []).flatMap(secret => [secret, encodeURIComponent(secret), JSON.stringify(secret).slice(1, -1)]);
  let text = replaceKnownSecrets(value, secrets);
  for (const [path, replacement] of [[context.vaultPath, "<vault>"], [context.homePath, "<home>"]] as const) {
    if (!path) continue;
    const normalized = path.replaceAll("\\", "/").replace(/\/$/u, "");
    const variants = [path, normalized, normalized.replaceAll("/", "\\"), normalized.replaceAll("/", "\\\\"), encodeURI(normalized), encodeURIComponent(normalized)];
    for (const variant of [...new Set(variants)].sort((a, b) => b.length - a.length)) if (variant) text = text.split(variant).join(replacement);
  }
  text = text.replace(/([?&](?:[^=&#\s]*(?:key|token|secret|password)|authorization|cookie)=)[^&#\s"'<>]*/giu, `$1${REDACTED_SECRET}`);
  text = redactEchoInkLocalSecretsV1(text);
  text = text.replace(/(?:[A-Z]:[\\/]+Users[\\/]+[^\\/\s"']+|\/Users\/[^/\s"']+|\/home\/[^/\s"']+|\/var\/mobile\/Containers\/Data\/Application\/[A-F0-9-]+)/giu, "<home>");
  // Whole header values, including spaces and multiple cookies.
  text = text.replace(/\b(?:cookie|set-cookie|authorization|proxy-authorization)\s*:\s*[^\r\n]+/giu, REDACTED_SECRET);
  text = text.replace(/((?:["']?)(?:[\w-]*(?:token|key|secret)|password|cookie|authorization)["']?\s*[:=]\s*)(?!\[REDACTED_SECRET\])("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}\][&]+)/giu, `$1"${REDACTED_SECRET}"`);
  return text;
}

export function redactReportValue(value: unknown, context: RedactionContext = {}): unknown {
  if (typeof value === "string") {
    // Tool arguments and log records often contain another serialized JSON document.
    if (/^\s*[[{]/u.test(value)) {
      let parsed: unknown;
      try { parsed = JSON.parse(value); } catch { /* Plain log text follows the same rules. */ }
      if (parsed && typeof parsed === "object") return JSON.stringify(redactReportValue(parsed, context));
    }
    return redactReportText(value, context);
  }
  if (Array.isArray(value)) return value.map(item => redactReportValue(item, context));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [redactReportText(key, context), sensitiveField.test(key) ? REDACTED_SECRET : redactReportValue(item, context)]));
  return value;
}

export interface ReportSnapshot { readonly report: Readonly<RunReport>; readonly json: string; readonly body: string; readonly bytes: number; readonly filename: string }
export function freezeReport(report: RunReport, context: RedactionContext = {}): ReportSnapshot {
  const clean = redactReportValue({ ...report, description: "", contact: "" }, context) as RunReport;
  clean.description = report.description; clean.contact = report.contact;
  const stamp = new Date(report.createdAt);
  const pad = (n: number) => String(n).padStart(2, "0");
  const date = `${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}-${pad(stamp.getHours())}${pad(stamp.getMinutes())}${pad(stamp.getSeconds())}`;
  const title = [...clean.conversation.title.replace(/[<>:"/\\|?*]/gu, "").trim()].filter(char => char.charCodeAt(0) >= 32).slice(0, 20).join("") || "会话";
  const deepFreeze = (value: unknown): void => { if (value && typeof value === "object") { Object.values(value).forEach(deepFreeze); Object.freeze(value); } };
  deepFreeze(clean);
  const body = JSON.stringify({ report: clean });
  return Object.freeze({ report: clean, json: JSON.stringify(clean, null, 2), body, bytes: new TextEncoder().encode(body).byteLength, filename: `EchoInk-运行记录-${title}-${date}.json` });
}

/** Input changes only rebuild the user-provided fields; captured session data never changes. */
export function describeSnapshot(snapshot: ReportSnapshot, description: string, contact: string): ReportSnapshot {
  const report = Object.freeze({ ...snapshot.report, description, contact });
  const body = JSON.stringify({ report });
  return Object.freeze({ ...snapshot, report, json: JSON.stringify(report, null, 2), body, bytes: new TextEncoder().encode(body).byteLength });
}
