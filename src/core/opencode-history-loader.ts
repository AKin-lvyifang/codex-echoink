export interface OpenCodeHistoryMessage {
  sessionId: string;
  sessionTitle: string;
  directory: string;
  role: string;
  createdAt: number;
  createdAtLabel: string;
  modelLabel: string;
  text: string;
}

export interface OpenCodeHistorySnapshot {
  serverUrl: string;
  sessionsScanned: number;
  sessionsMatched: number;
  messages: OpenCodeHistoryMessage[];
  truncated: boolean;
}

export interface OpenCodeHistoryLoadResult {
  messages: OpenCodeHistoryMessage[];
  truncated: boolean;
}

export async function collectOpenCodeHistoryMessages(input: {
  sessions: Array<Record<string, unknown>>;
  startMs: number;
  endMs: number;
  maxMessages: number;
  maxChars: number;
  fetchMessages(session: Record<string, unknown>): Promise<unknown[]>;
  concurrency?: number;
}): Promise<OpenCodeHistoryLoadResult> {
  const messages: OpenCodeHistoryMessage[] = [];
  let charBudget = input.maxChars;
  let truncated = false;
  const concurrency = Math.max(1, Math.min(10, Math.floor(input.concurrency ?? 8)));

  for (let start = 0; start < input.sessions.length; start += concurrency) {
    if (messages.length >= input.maxMessages || charBudget <= 0) {
      truncated = true;
      break;
    }
    const batch = input.sessions.slice(start, start + concurrency);
    const results = await Promise.all(batch.map(async (session) => ({
      session,
      entries: await input.fetchMessages(session)
    })));
    for (const result of results) {
      for (const entry of result.entries) {
        const record = openCodeRecord(entry);
        const info = openCodeRecord(record.info);
        const createdAt = normalizeOpenCodeTimeMs(openCodeRecord(info.time).created ?? info.created_at);
        if (createdAt < input.startMs || createdAt >= input.endMs) continue;
        const parts = Array.isArray(record.parts) ? record.parts : [];
        const text = compactOpenCodeText(extractOpenCodePartsText(parts), Math.min(1800, charBudget));
        if (!text) continue;
        messages.push({
          sessionId: String(result.session.id ?? info.sessionID ?? ""),
          sessionTitle: String(result.session.title ?? "未命名会话"),
          directory: String(result.session.directory ?? openCodeRecord(info.path).cwd ?? ""),
          role: String(info.role ?? "unknown"),
          createdAt,
          createdAtLabel: formatOpenCodeTimeLabel(createdAt),
          modelLabel: openCodeMessageModelLabel(info, result.session),
          text
        });
        charBudget -= text.length;
        if (messages.length >= input.maxMessages || charBudget <= 0) {
          truncated = true;
          break;
        }
      }
      if (truncated) break;
    }
  }

  messages.sort((left, right) => left.createdAt - right.createdAt);
  return { messages, truncated };
}

export function normalizeOpenCodeTimeMs(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return parsed < 100000000000 ? parsed * 1000 : parsed;
}

function formatOpenCodeTimeLabel(value: number): string {
  const date = new Date(value);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

function openCodeMessageModelLabel(info: Record<string, unknown>, session: Record<string, unknown>): string {
  const infoModel = openCodeRecord(info.model);
  const sessionModel = openCodeRecord(session.model);
  const provider = info.providerID ?? infoModel.providerID ?? sessionModel.providerID ?? "";
  const model = info.modelID ?? infoModel.modelID ?? infoModel.id ?? sessionModel.id ?? "";
  return [provider, model].map((item) => String(item || "")).filter(Boolean).join("/");
}

function extractOpenCodePartsText(parts: unknown[]): string {
  const lines: string[] = [];
  for (const rawPart of parts) {
    const part = openCodeRecord(rawPart);
    if (part.ignored) continue;
    if (part.type === "text" && typeof part.text === "string") {
      lines.push(part.text.trim());
    } else if (part.type === "tool") {
      lines.push(openCodeToolPartSummary(part));
    } else if (part.type === "patch" && Array.isArray(part.files)) {
      lines.push(`文件改动：${part.files.join("，")}`);
    } else if (part.type === "file") {
      lines.push(`引用文件：${part.filename || part.url || "未命名文件"}`);
    } else if (part.type === "agent") {
      lines.push(`切换 Agent：${part.name}`);
    }
  }
  return lines.filter(Boolean).join("\n");
}

function openCodeToolPartSummary(part: Record<string, unknown>): string {
  const tool = part.tool ? `工具 ${part.tool}` : "工具调用";
  const state = openCodeRecord(part.state);
  if (state.status === "completed") {
    const title = state.title ? `：${state.title}` : "";
    const output = typeof state.output === "string" && state.output.trim()
      ? `\n${compactOpenCodeText(state.output, 500)}`
      : "";
    return `${tool}${title}${output}`;
  }
  if (state.status === "error") return `${tool} 失败：${state.error ?? "未知错误"}`;
  if (state.status === "running") return `${tool} 运行中`;
  return tool;
}

function compactOpenCodeText(value: string, limit: number): string {
  const normalized = value
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();
  if (!normalized || normalized.length <= limit) return normalized;
  return `${normalized.slice(0, Math.max(0, limit - 20)).trimEnd()}\n...（已截断）`;
}

function openCodeRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}
