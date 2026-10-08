/** Only the approved public commands and their documented parameters. */
export const OBSIDIAN_CLI_FIELDS = {
  version: [], files: ["folder", "ext", "total"], file: ["file", "path"],
  folder: ["path", "info"], folders: ["folder", "total"], read: ["file", "path"],
  outline: ["file", "path", "format", "total"], wordcount: ["file", "path", "words", "characters"],
  search: ["query", "path", "limit", "format", "total", "case"],
  "search:context": ["query", "path", "limit", "format", "case"],
  backlinks: ["file", "path", "counts", "total", "format"], links: ["file", "path", "total"],
  unresolved: ["total", "counts", "verbose", "format"], orphans: ["total"], deadends: ["total"],
  tags: ["file", "path", "sort", "total", "counts", "format", "active"], tag: ["name", "total", "verbose"],
  aliases: ["file", "path", "total", "verbose", "active"],
  properties: ["file", "path", "name", "sort", "format", "total", "counts", "active"],
  "property:read": ["file", "path", "name"],
  tasks: ["file", "path", "status", "total", "done", "todo", "verbose", "format", "active", "daily"],
  task: ["ref", "file", "path", "line", "daily"],
  "daily:path": [], "daily:read": [], templates: ["total"], "template:read": ["name", "title", "resolve"],
  bases: [], "base:query": ["file", "path", "view", "format"],
  open: ["file", "path", "newtab"], daily: ["paneType"], "search:open": ["query"],
  "tab:open": ["file", "view"], "base:views": ["path"],
  // finance is an EchoInk adapter argument, never forwarded to the CLI.
  "base:create": ["file", "path", "view", "name", "content", "open", "newtab", "finance"],
  "daily:append": ["content", "paneType", "inline", "open"],
  "daily:prepend": ["content", "paneType", "inline", "open"],
  diff: ["file", "path", "from", "to", "filter"], history: ["file", "path"], "history:list": [],
  "history:read": ["file", "path", "version"], "history:restore": ["file", "path", "version"],
  "history:open": ["file", "path"],
  plugins: ["filter", "versions", "format"], "plugins:enabled": ["filter", "versions", "format"],
  plugin: ["id"], "plugin:enable": ["id", "filter"], "plugin:disable": ["id", "filter"],
  "plugin:install": ["id", "enable"], "plugin:uninstall": ["id"], "plugin:reload": ["id"]
} as const;
export type ObsidianCliCommand = keyof typeof OBSIDIAN_CLI_FIELDS;
export const OBSIDIAN_CLI_COMMANDS = Object.keys(OBSIDIAN_CLI_FIELDS) as ObsidianCliCommand[];
export type ObsidianCliEffect = "read" | "ui" | "note_write" | "plugin_write";
export interface ObsidianFinanceInput {
  date: string; merchant: string; amountCents: number; kind: "expense" | "income" | "refund" | "transfer";
  category?: string; account?: string; description?: string; currency?: string; note?: string; billPlanId?: string;
}
export interface ObsidianCliRequest {
  command: ObsidianCliCommand;
  path?: string; file?: string; folder?: string; query?: string; ext?: string;
  name?: string; title?: string; view?: string; content?: string; id?: string; ref?: string;
  info?: string; format?: string; sort?: string; filter?: string; status?: string; paneType?: string;
  limit?: number; line?: number; version?: number; from?: number; to?: number;
  total?: boolean; counts?: boolean; verbose?: boolean; active?: boolean; daily?: boolean;
  done?: boolean; todo?: boolean; case?: boolean; words?: boolean; characters?: boolean;
  resolve?: boolean; newtab?: boolean; open?: boolean; inline?: boolean; versions?: boolean; enable?: boolean;
  finance?: ObsidianFinanceInput;
}
const FLAGS = new Set("total counts verbose active daily done todo case words characters resolve newtab open inline versions enable".split(" "));
const NUMBERS = new Set(["limit", "line", "version", "from", "to"]);
const FILE_COMMANDS = new Set<ObsidianCliCommand>(["file", "read", "outline", "wordcount", "backlinks", "links", "property:read", "base:query", "base:create", "open", "history", "history:read", "history:restore", "history:open", "diff"]);
export function obsidianCliEffect(request: ObsidianCliRequest): ObsidianCliEffect {
  if (["daily", "daily:append", "daily:prepend", "base:create", "history:restore"].includes(request.command)) return "note_write";
  if (request.command.startsWith("plugin:")) return "plugin_write";
  if (["open", "search:open", "tab:open", "history:open"].includes(request.command)) return "ui";
  return "read";
}
export function normalizeObsidianCliRequest(args: Record<string, unknown>): ObsidianCliRequest {
  const command = args.command;
  if (typeof command !== "string" || !Object.hasOwn(OBSIDIAN_CLI_FIELDS, command)) throw new Error("obsidian_cli_command_not_allowed");
  const fields: readonly string[] = OBSIDIAN_CLI_FIELDS[command as ObsidianCliCommand];
  const result: Record<string, unknown> = { command };
  for (const [key, value] of Object.entries(args)) {
    if (key === "command" || value === undefined) continue;
    if (!fields.includes(key)) throw new Error("obsidian_cli_parameter_not_allowed");
    if (FLAGS.has(key)) { if (typeof value !== "boolean") throw new Error("obsidian_invalid_request"); }
    else if (NUMBERS.has(key)) {
      if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > (key === "limit" ? 20 : 1_000_000)) throw new Error("obsidian_invalid_request");
    } else if (key === "finance") { result[key] = normalizeFinanceInput(value); continue; }
    else if (typeof value !== "string" || !value.trim() || value.length > (key === "content" ? 24_000 : 1_000) || (key === "content" ? /\0/u : /[\0\r\n]/u).test(value)) throw new Error("obsidian_invalid_request");
    result[key] = value;
    if (key === "content" && typeof value === "string") result[key] = value.replaceAll("\r\n", "\n");
  }
  const request = result as unknown as ObsidianCliRequest;
  if (request.path && request.file) throw new Error("obsidian_cli_target_ambiguous");
  if (FILE_COMMANDS.has(request.command) && !request.path && !request.file) throw new Error("obsidian_cli_exact_target_required");
  for (const key of request.command.startsWith("plugin") && request.command !== "plugins" && request.command !== "plugins:enabled" ? ["id"] : []) {
    const value = result[key];
    if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u.test(value)) throw new Error("obsidian_invalid_plugin_id");
  }
  if (["folder", "base:views"].includes(request.command) && !request.path) throw new Error("obsidian_cli_exact_target_required");
  if (["search", "search:context"].includes(request.command) && !request.query) throw new Error("obsidian_invalid_request");
  if (["tag", "property:read", "template:read"].includes(request.command) && !request.name) throw new Error("obsidian_invalid_request");
  if (["daily:append", "daily:prepend"].includes(request.command) && !request.content) throw new Error("obsidian_invalid_request");
  if (request.command === "history:restore" && !request.version) throw new Error("obsidian_invalid_request");
  if (request.command === "task" && !((request.ref && !request.path && !request.file && !request.daily && !request.line) || (request.line && (!!request.daily !== !!(request.path || request.file))))) throw new Error("obsidian_invalid_request");
  if (request.command === "base:create" && !request.finance && (!request.name || /[\\/:*?"<>|]/u.test(request.name) || [".", ".."].includes(request.name))) throw new Error("obsidian_cli_new_name_required");
  if (request.finance && ["name", "content", "view", "open", "newtab"].some(key => result[key] !== undefined)) throw new Error("obsidian_cli_finance_arguments_invalid");
  if (request.daily && (request.path || request.file || request.active) || request.active && (request.path || request.file)) throw new Error("obsidian_cli_target_ambiguous");
  if (request.command === "diff" && request.filter && request.filter !== "local") throw new Error("obsidian_cli_sync_not_allowed");
  const enums: Record<string, readonly string[]> = {
    ext: ["md", "base", "canvas"], info: ["files", "folders", "size"], sort: ["count"], paneType: ["tab", "split", "window"],
    filter: request.command === "diff" ? ["local"] : ["core", "community"], view: request.command === "tab:open" ? ["markdown", "bases", "canvas"] : []
  };
  const formats: Partial<Record<ObsidianCliCommand, readonly string[]>> = {
    outline: ["tree", "md", "json"], "base:query": ["json", "csv", "tsv", "md", "paths"],
    search: ["text", "json"], "search:context": ["text", "json"], properties: ["yaml", "json", "tsv"],
    backlinks: ["json", "tsv", "csv"], unresolved: ["json", "tsv", "csv"], tags: ["json", "tsv", "csv"],
    tasks: ["json", "tsv", "csv"], plugins: ["json", "tsv", "csv"], "plugins:enabled": ["json", "tsv", "csv"]
  };
  if (request.format && !formats[request.command]?.includes(request.format)) throw new Error("obsidian_invalid_request");
  for (const [key, values] of Object.entries(enums)) {
    const value = result[key];
    if (value !== undefined && values.length && (typeof value !== "string" || !values.includes(value))) throw new Error("obsidian_invalid_request");
  }
  if (request.status !== undefined && request.status.length !== 1) throw new Error("obsidian_invalid_request");
  return Object.freeze(request);
}
export function normalizeFinanceInput(value: unknown): ObsidianFinanceInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("obsidian_invalid_finance_entry");
  const input = value as Record<string, unknown>;
  const fields = ["date", "merchant", "amountCents", "kind", "category", "account", "description", "currency", "note", "billPlanId"];
  if (Object.keys(input).some(key => !fields.includes(key)) || !Number.isSafeInteger(input.amountCents) || Number(input.amountCents) <= 0
    || !["expense", "income", "refund", "transfer"].includes(String(input.kind)) || typeof input.date !== "string"
    || !/^\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2}:\d{2})?$/u.test(input.date) || typeof input.merchant !== "string" || !input.merchant.trim()) throw new Error("obsidian_invalid_finance_entry");
  for (const key of fields.filter(key => !["amountCents", "kind"].includes(key))) if (input[key] !== undefined && (typeof input[key] !== "string" || String(input[key]).length > 1_000 || /\0/u.test(String(input[key])))) throw new Error("obsidian_invalid_finance_entry");
  const normalized: Record<string, unknown> = { ...input, merchant: input.merchant.trim() };
  if (typeof input.billPlanId === "string") {
    if (input.billPlanId.trim()) normalized.billPlanId = input.billPlanId.trim();
    else delete normalized.billPlanId;
  }
  return Object.freeze(normalized) as unknown as ObsidianFinanceInput;
}
/** Arguments remain separate argv elements; no shell, model program or Vault selector. */
export function obsidianCliArgv(request: ObsidianCliRequest): string[] {
  return [request.command, ...Object.entries(request).flatMap(([key, value]) => {
    if (key === "command" || key === "finance" || request.command === "base:views" && key === "path") return [];
    if (FLAGS.has(key)) return value === true ? [key] : [];
    return [`${key}=${String(value).replaceAll("\\", "\\\\").replaceAll("\r\n", "\n").replaceAll("\n", "\\n").replaceAll("\t", "\\t")}`];
  })];
}
