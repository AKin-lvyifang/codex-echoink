import type { App } from "obsidian";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { readNativeJournalContext, nativeJournalPathForDate, readNativeJournalSettings } from "../home/native-journal";
import { normalizeObsidianCliRequest, type ObsidianNativePort, type PreparedObsidianOperation, type ObsidianCliResult } from "../harness/pi-native/pi-obsidian-tools";
import { obsidianCliArgv, obsidianCliEffect, type ObsidianCliRequest } from "../harness/pi-native/obsidian-cli-policy";
import type { VaultDomainAdapter } from "../harness/pi-native/vault-domain-service";
import { VaultTargetResolver } from "../harness/pi-native/vault-target-resolver";
import { normalizeJsonValue, canonicalJsonStringify, type JsonValue } from "../harness/pi-native/tool-authorization";
import { createOfficialObsidianCliTransport, type ObsidianCliTransport } from "./obsidian-official-cli";
import { ObsidianPluginDirectory } from "./obsidian-plugin-directory";
import type { LifestyleFinanceService } from "../lifestyle/finance-service";
import { isEchoInkFinanceBase } from "../lifestyle/finance-paths";
import { parseFinanceNote } from "../lifestyle/finance-ledger";

export interface ObsidianNativeOptions {
  transport?: ObsidianCliTransport;
  directory?: ObsidianPluginDirectory;
  finance?: LifestyleFinanceService;
  ownPluginId?: string;
}
export function createObsidianNativePort(app: App, adapter: VaultDomainAdapter, legacyDirectory: () => string, options: ObsidianNativeOptions = {}): ObsidianNativePort {
  const resolver = new VaultTargetResolver(adapter);
  const transport = options.transport ?? createOfficialObsidianCliTransport(adapter.vaultRootPath);
  const directory = options.directory ?? new ObsidianPluginDirectory();
  const effectEngine = "obsidian-official-cli" as const;
  const checkVault = () => {
    const appAdapter = app.vault.adapter as unknown as { getBasePath?(): string };
    if (!appAdapter?.getBasePath || path.resolve(appAdapter.getBasePath()) !== path.resolve(adapter.vaultRootPath)) throw new Error("obsidian_cli_vault_mismatch");
  };
  const targetFor = async (relativePath: string, mustExist = true, expectedKind: "file" | "directory" = "file") => await resolver.resolve({ vaultId: adapter.vaultId, relativePath, mustExist, expectedKind, allowRoot: expectedKind === "directory", allowMissingParentDirectories: !mustExist });
  const snapshot = async (relativePath: string, maxBytes = 32_000) => {
    const target = await targetFor(relativePath, false);
    const value = target.exists ? await adapter.readFile(target, { maxBytes }) : null;
    if (value?.truncated) throw new Error("obsidian_cli_target_truncated");
    return value;
  };
  const version = async (relativePath: string) => (await snapshot(relativePath))?.version ?? null;
  const run = async (argv: string[], signal?: AbortSignal): Promise<ObsidianCliResult> => {
    const result = await transport.run(argv, signal);
    const rawContent = ["read", "daily:read", "template:read", "history:read", "search:context", "diff", "property:read", "properties", "outline", "base:query", "aliases"].includes(argv[0]!);
    const unsupported = !rawContent && /^(?:unknown command|command not found|not supported)/iu.test(result.output);
    return { available: result.status !== "unavailable", engine: effectEngine, command: argv[0]!, status: unsupported ? "unsupported" : result.status === "completed" && !result.output.trim() ? "empty" : result.status, output: result.output, ...(result.reason ? { reason: result.reason } : {}) };
  };
  const requireOutput = (result: ObsidianCliResult) => {
    if (!["completed", "empty"].includes(result.status)) throw new Error(result.reason ?? `obsidian_cli_${result.status}`);
    return result.output ?? "";
  };
  const preflight = async (signal?: AbortSignal): Promise<ObsidianCliResult | undefined> => {
    checkVault();
    const located = await run(["vault", "info=path"], signal);
    if (!["completed", "empty"].includes(located.status)) return located;
    if (path.resolve((located.output ?? "").trim()) !== path.resolve(adapter.vaultRootPath)) throw new Error("obsidian_cli_vault_mismatch");
  };
  const officialDailyTarget = async (signal?: AbortSignal): Promise<string> => {
    const relativePath = requireOutput(await run(["daily:path"], signal)).trim();
    return (await targetFor(relativePath, false)).relativePath;
  };
  const fileNameTarget = (name: string) => {
    const matches = app.vault.getFiles().filter(file => file.path === name || file.path.replace(/\.[^.\/]+$/u, "") === name || file.path.split("/").at(-1) === name || file.path.split("/").at(-1)?.replace(/\.[^.]+$/u, "") === name);
    if (matches.length !== 1) throw new Error("obsidian_cli_file_name_not_unique_use_path");
    return matches[0]!.path;
  };
  const pluginState = async (id: string, signal?: AbortSignal) => {
    const parseIds = (text: string): Set<string> => {
      const value: unknown = JSON.parse(text);
      if (Array.isArray(value)) return new Set(value.map(entry => typeof entry === "string" ? entry : entry?.id).filter((value): value is string => typeof value === "string"));
      if (value && typeof value === "object") return new Set(Object.keys(value));
      throw new Error("obsidian_cli_plugin_list_invalid");
    };
    const installed = parseIds(requireOutput(await run(["plugins", "format=json"], signal))).has(id);
    const enabled = parseIds(requireOutput(await run(["plugins:enabled", "format=json"], signal))).has(id);
    return { installed, enabled };
  };
  const activeBase = (relativePath: string): boolean => {
    const active = app.workspace.getActiveFile?.();
    return active?.path === relativePath && app.workspace.activeLeaf?.view.getViewType() === "bases";
  };
  const pluginInstance = (id: string) => (app as unknown as { plugins?: { plugins?: Record<string, unknown> } }).plugins?.plugins?.[id];
  const port: ObsidianNativePort = {
    async context() {
      checkVault();
      await targetFor(nativeJournalPathForDate(app, new Date(), legacyDirectory()), false);
      return await readNativeJournalContext(app, { now: new Date(), legacyDirectory: legacyDirectory(), readTemplate: async relativePath => (await snapshot(relativePath, 24_000))?.content ?? null });
    },
    async pluginSearch(query, limit, signal) { return await directory.search(query, limit, signal); },
    async cli(request, signal) {
      const prepared = await port.prepare(request, signal);
      if (prepared.effect !== "read") throw new Error("obsidian_cli_requires_authorized_tool");
      return await prepared.execute(signal);
    },
    async prepare(input, signal): Promise<PreparedObsidianOperation> {
      checkVault();
      const request = { ...normalizeObsidianCliRequest({ ...input }) };
      const effect = obsidianCliEffect(request);
      const writing = effect === "note_write" || effect === "plugin_write";
      if (["plugin:disable", "plugin:uninstall", "plugin:reload"].includes(request.command) && request.id === (options.ownPluginId ?? "codex-echoink")) throw new Error("obsidian_cli_cannot_interrupt_echoink_itself");
      // Bind every file selector before help, confirmation or execution. No active-file fallback.
      if (request.file) {
        const file = request.command === "tab:open" ? request.file : fileNameTarget(request.file);
        request.path = (await targetFor(file)).relativePath;
        if (request.command === "tab:open") { request.file = request.path; delete request.path; }
        else delete request.file;
      }
      if (request.ref) {
        const match = /^(.*):(\d+)$/u.exec(request.ref);
        if (!match) throw new Error("obsidian_invalid_task_reference");
        request.path = (await targetFor(match[1]!)).relativePath;
        request.line = Number(match[2]); delete request.ref;
        if (!Number.isSafeInteger(request.line) || request.line! < 1) throw new Error("obsidian_invalid_task_reference");
      }
      if (request.path) request.path = (await targetFor(request.path, true, ["folder", "search", "search:context"].includes(request.command) ? "directory" : "file")).relativePath;
      if (request.folder) request.folder = (await targetFor(request.folder, true, "directory")).relativePath;
      if (request.active) {
        const active = app.workspace.getActiveFile?.();
        if (!active) throw new Error("obsidian_cli_active_file_missing");
        request.path = (await targetFor(active.path)).relativePath; delete request.active;
      }
      if (request.command === "diff") request.filter = "local";
      let dailyPath: string | undefined;
      if (request.command.startsWith("daily") || request.daily) {
        const unavailable = await preflight(signal);
        if (unavailable) {
          const target = normalizeJsonValue({ command: request.command });
          const failure = { ...unavailable, command: request.command };
          return { effect, target, targetVersion: null, preview: target, unavailable: failure, execute: async () => failure };
        }
        // The public CLI owns its defaults; EchoInk's journal fallback may differ.
        dailyPath = await officialDailyTarget(signal);
      }
      if (request.daily && ["tasks", "task"].includes(request.command)) { request.path = dailyPath; delete request.daily; await targetFor(request.path!); }
      if (request.command === "template:read") {
        const settings = readNativeJournalSettings(app, legacyDirectory());
        const template = request.name!.endsWith(".md") ? request.name! : `${request.name}.md`;
        const scoped = (await targetFor(`${settings.templatesFolder}/${template}`)).relativePath;
        if (!scoped.startsWith(`${settings.templatesFolder}/`)) throw new Error("obsidian_cli_template_outside_folder");
      }
      if (request.command.startsWith("base:") && !request.path?.endsWith(".base")) throw new Error("obsidian_cli_base_file_required");
      if (request.command === "base:views" && !activeBase(request.path!)) throw new Error("obsidian_cli_active_base_mismatch_open_target_first");
      if (request.command === "tab:open" && request.view) {
        const expected = request.file?.endsWith(".base") ? "bases" : request.file?.endsWith(".canvas") ? "canvas" : "markdown";
        if (!request.file || request.view !== expected) throw new Error("obsidian_cli_tab_view_mismatch");
      }
      const before = dailyPath && writing ? await snapshot(dailyPath) : request.path && writing ? await snapshot(request.path) : null;
      const target = normalizeJsonValue({ command: request.command, ...(request.path ? { path: request.path } : {}), ...(request.file ? { path: request.file } : {}), ...(dailyPath ? { dailyPath } : {}), ...(request.id ? { pluginId: request.id } : {}), ...(request.name ? { name: request.name } : {}), ...(request.view ? { view: request.view } : {}) });
      let targetVersion: JsonValue = before ? { beforeVersion: before.version } : null;
      let historyContent: string | undefined;
      let pluginBefore: { installed: boolean; enabled: boolean } | undefined;
      let reloadInstance: unknown;
      let financePrepared: ReturnType<LifestyleFinanceService["prepareManual"]> | undefined;
      let recordPaths: Set<string> | undefined;
      let pluginSource: JsonValue | undefined;
      let backend = effectEngine as string;
      if (request.command === "base:create") {
        const base = await snapshot(request.path!);
        if (base && isEchoInkFinanceBase(base.content)) {
          if (!options.finance || !request.finance || options.finance.ledger.paths().base !== request.path) throw new Error("obsidian_cli_finance_service_and_fields_required");
          const entry = request.finance;
          financePrepared = options.finance.prepareManual({ ...entry, category: entry.category ?? "", account: entry.account ?? "", description: entry.description ?? "", currency: entry.currency ?? "CNY", note: entry.note ?? "", status: "completed" });
          await targetFor(financePrepared.relativePath, false);
          backend = "echoink-finance-service";
          targetVersion = normalizeJsonValue({ baseVersion: base.version, recordPath: financePrepared.relativePath, expectedEntrySha256: createHash("sha256").update(JSON.stringify(financePrepared.entry)).digest("hex") });
        } else if (request.finance) throw new Error("obsidian_cli_finance_base_required");
        else {
          recordPaths = new Set(app.vault.getFiles().map(file => file.path));
          const name = request.name!.replace(/\.md$/iu, "");
          if (app.vault.getFiles().some(file => file.path.split("/").at(-1)?.replace(/\.md$/iu, "") === name)) throw new Error("obsidian_cli_record_name_already_exists");
        }
      }
      const unavailable = financePrepared || dailyPath ? undefined : await preflight(signal);
      if (unavailable) return { effect, target, targetVersion, preview: target, unavailable: { ...unavailable, command: request.command }, execute: async () => ({ ...unavailable, command: request.command }) };
      if (!financePrepared) {
        const help = await run(["help"], signal);
        if (!["completed", "empty"].includes(help.status) || !new RegExp(`(?:^|\\s)${request.command}(?:\\s|$)`, "mu").test(help.output ?? "")) {
          const failure: ObsidianCliResult = { available: true, engine: effectEngine, command: request.command, status: "unsupported", reason: "Installed public CLI does not advertise this command." };
          return { effect, target, targetVersion, preview: target, unavailable: failure, execute: async () => failure };
        }
      }
      if (request.command === "history:restore") {
        const versions = requireOutput(await run(["history", `path=${request.path}`], signal));
        if (!new RegExp(`(?:^|\\n)\\s*${request.version}(?:[\\s.:|])`, "u").test(versions)) throw new Error("obsidian_cli_history_version_missing");
        historyContent = requireOutput(await run(["history:read", `path=${request.path}`, `version=${request.version}`], signal));
        targetVersion = normalizeJsonValue({ beforeVersion: before?.version ?? null, historyVersion: request.version, historyContentSha256: createHash("sha256").update(historyContent).digest("hex") });
      }
      if (effect === "plugin_write") {
        if (request.command === "plugin:install") pluginSource = normalizeJsonValue(await directory.find(request.id!, signal));
        pluginBefore = await pluginState(request.id!, signal);
        if (request.command !== "plugin:install" && !pluginBefore.installed) throw new Error("obsidian_cli_plugin_not_installed");
        reloadInstance = pluginInstance(request.id!);
        targetVersion = normalizeJsonValue(pluginBefore);
      }
      if (writing) {
        // Bind duplicate suppression to the effect's payload. UI flags do not turn a
        // repeated uncertain append/create into a new action; different content can proceed.
        const effectArguments = Object.fromEntries(Object.entries(request).filter(([key, value]) => !["open", "newtab", "paneType"].includes(key) && value !== false));
        const previous = targetVersion && typeof targetVersion === "object" && !Array.isArray(targetVersion) ? targetVersion : {};
        targetVersion = normalizeJsonValue({ ...previous, effectArgumentsSha256: createHash("sha256").update(canonicalJsonStringify(effectArguments)).digest("hex") });
      }
      return {
        effect, target, targetVersion, preview: normalizeJsonValue({ ...request, target, backend, ...(pluginSource ? { officialDirectoryEntry: pluginSource } : {}), ...(financePrepared ? { recordPath: financePrepared.relativePath, entry: financePrepared.entry } : {}), atomicVersionCheck: false }),
        async execute(executionSignal, onEffectStarted) {
          checkVault();
          if (executionSignal?.aborted) return { available: true, engine: financePrepared ? "echoink-finance-service" : effectEngine, command: request.command, status: "cancelled", reason: "obsidian_cli_cancelled" };
          if (!financePrepared) {
            const failure = await preflight(executionSignal);
            if (failure) return { ...failure, command: request.command };
          }
          if (request.path) await targetFor(request.path, true, ["folder", "search", "search:context"].includes(request.command) ? "directory" : "file");
          if (request.command === "base:views" && !activeBase(request.path!)) throw new Error("obsidian_cli_active_base_mismatch_open_target_first");
          if (dailyPath && await officialDailyTarget(executionSignal) !== dailyPath) throw new Error("obsidian_cli_daily_target_changed");
          if (writing && before && await version(request.path ?? dailyPath!) !== before.version) throw new Error("obsidian_cli_target_changed_since_approval");
          if (writing && dailyPath && !before && await version(dailyPath) !== null) throw new Error("obsidian_cli_target_changed_since_approval");
          if (pluginBefore && !isDeepStrictEqual(pluginBefore, await pluginState(request.id!, executionSignal))) throw new Error("obsidian_cli_plugin_changed_since_approval");
          if (historyContent !== undefined && requireOutput(await run(["history:read", `path=${request.path}`, `version=${request.version}`], executionSignal)) !== historyContent) throw new Error("obsidian_cli_history_changed_since_approval");
          if (recordPaths && app.vault.getFiles().some(file => file.path.split("/").at(-1)?.replace(/\.md$/iu, "") === request.name!.replace(/\.md$/iu, ""))) throw new Error("obsidian_cli_record_target_changed_since_approval");
          if (financePrepared) {
            if (options.finance!.ledger.paths().base !== request.path || options.finance!.ledger.pathForNewEntry(financePrepared.entry.id) !== financePrepared.relativePath || (await targetFor(financePrepared.relativePath, false)).exists) throw new Error("obsidian_cli_finance_target_changed");
            await onEffectStarted?.();
            const entry = await financePrepared.create();
            const observed = await snapshot(financePrepared.relativePath);
            const same = !!observed && Object.entries(entry).every(([key, value]) => isDeepStrictEqual(parseFinanceNote(observed.content)?.[key as keyof typeof entry], value));
            return { available: true, engine: "echoink-finance-service", backend, command: request.command, target, status: observed && same ? "completed" : "uncertain", readbackVerified: !!observed && same, observedTargetVersion: normalizeJsonValue({ recordPath: financePrepared.relativePath, version: observed?.version ?? null }) };
          }
          if (writing) {
            if (!onEffectStarted) throw new Error("obsidian_cli_authorization_required");
            await onEffectStarted();
          }
          const result = await run(obsidianCliArgv(request), executionSignal);
          if (!writing) {
            if (request.command === "base:views" && !activeBase(request.path!)) return { ...result, status: "uncertain", reason: "obsidian_cli_active_base_changed", target };
            if (effect === "ui" && ["open", "tab:open"].includes(request.command) && ["completed", "empty"].includes(result.status) && app.workspace.getActiveFile?.()?.path !== (request.path ?? request.file)) return { ...result, status: "uncertain", reason: "obsidian_cli_open_target_not_observed", target };
            return { ...result, status: effect === "ui" && result.status === "empty" ? "completed" : result.status, target };
          }
          if (!["completed", "empty"].includes(result.status)) return { ...result, status: "uncertain", reason: "obsidian_cli_result_uncertain_do_not_retry", target };
          let verified = false;
          let observed: JsonValue = null;
          if (dailyPath) {
            const after = await snapshot(dailyPath);
            if (request.command === "daily") verified = !!after && app.workspace.getActiveFile?.()?.path === dailyPath;
            else if (after && request.content) {
              const old = before?.content ?? "";
              if (request.command === "daily:append") verified = after.content.startsWith(old) && after.content.length >= old.length + request.content.length && after.content.trimEnd().endsWith(request.content.trimEnd());
              else {
                const frontmatter = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n)?/u.exec(old)?.[0] ?? "";
                verified = after.content.startsWith(frontmatter) && after.content.length >= old.length + request.content.length && after.content.slice(frontmatter.length).trimStart().startsWith(request.content.trimStart()) && after.content.endsWith(old.slice(frontmatter.length));
              }
            }
            observed = after?.version ?? null;
          } else if (historyContent !== undefined) { const after = await snapshot(request.path!); verified = after?.content === historyContent; observed = after?.version ?? null; }
          else if (pluginBefore) {
            const after = await pluginState(request.id!, executionSignal);
            verified = request.command === "plugin:uninstall" ? !after.installed : request.command === "plugin:disable" ? after.installed && !after.enabled : request.command === "plugin:enable" ? after.installed && after.enabled : request.command === "plugin:reload" ? after.installed && (!!reloadInstance && pluginInstance(request.id!) !== reloadInstance) : after.installed && (!request.enable || after.enabled);
            observed = normalizeJsonValue(after);
          } else if (recordPaths) {
            const added = app.vault.getFiles().filter(file => !recordPaths!.has(file.path) && file.path.split("/").at(-1)?.replace(/\.md$/iu, "") === request.name!.replace(/\.md$/iu, ""));
            if (added.length === 1) { const after = await snapshot(added[0]!.path); verified = !!after && (!request.content || after.content.includes(request.content)); observed = normalizeJsonValue({ path: added[0]!.path, version: after?.version ?? null }); }
          }
          return { ...result, status: verified ? "completed" : "uncertain", readbackVerified: verified, target, observedTargetVersion: observed, ...(verified ? {} : { reason: "obsidian_cli_readback_unverified_do_not_retry" }) };
        }
      };
    }
  };
  return port;
}
