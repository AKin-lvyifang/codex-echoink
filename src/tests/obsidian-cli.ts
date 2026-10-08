import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import * as path from "node:path";
import { nativeJournalFixture } from "./native-journal-fixture";
import { nativeJournalPathForDate } from "../home/native-journal";
import { OBSIDIAN_CLI_COMMANDS, normalizeObsidianCliRequest, obsidianCliEffect, obsidianCliArgv } from "../harness/pi-native/obsidian-cli-policy";
import { createObsidianNativePort } from "../plugin/obsidian-native-tools";
import { ObsidianPluginDirectory } from "../plugin/obsidian-plugin-directory";
import { obsidianCliOutputIsError, type ObsidianCliTransport } from "../plugin/obsidian-official-cli";
import { ObsidianVaultDomainAdapter } from "../plugin/obsidian-vault-domain-adapter";
import { PiObsidianToolSecurity, createPiObsidianToolDefinitions } from "../harness/pi-native/pi-obsidian-tools";
import { FileApprovalTicketStore, normalizeJsonValue, type ApprovalOperationContract } from "../harness/pi-native/tool-authorization";
import { FileDomainReceiptStore } from "../harness/pi-native/domain-receipt-store";
import { recoverPiVaultDomainReceipts } from "../plugin/pi-vault-tool-production";
import { VaultDomainService } from "../harness/pi-native/vault-domain-service";
import type { PiWorkspaceAccess } from "../harness/pi-native/pi-workspace-access";
import { piWorkspaceAllowsTool } from "../harness/pi-native/pi-workspace-access";
import { LifestyleFinanceService } from "../lifestyle/finance-service";
import { LifestyleStore } from "../lifestyle/store";
import type { LifestyleService } from "../lifestyle/service";
import { parseFinanceNote } from "../lifestyle/finance-ledger";
import type { CapabilityAccess } from "../membership/types";

type Fixture = Awaited<ReturnType<typeof nativeJournalFixture>>;
export function officialCliFixture(fixture: Fixture, root: string) {
  const calls: string[][] = [];
  const state = { available: true, failAfterDailyWrite: false, truncate: false, mismatch: false, advertised: [...OBSIDIAN_CLI_COMMANDS], historyContent: "Restored snapshot\n", enabled: new Set<string>(), installed: new Set(["sample-plugin"]), activeFile: "", activeView: "markdown" };
  const app = fixture.app as any;
  app.workspace.getActiveFile = () => app.vault.getFileByPath(state.activeFile);
  app.workspace.activeLeaf = { view: { getViewType: () => state.activeView } };
  app.plugins = { plugins: { "sample-plugin": {} } };
  const transport: ObsidianCliTransport = { async run(argv, signal) {
    calls.push([...argv]);
    const values = Object.fromEntries(argv.slice(1).filter(value => value.includes("=")).map(value => [value.slice(0, value.indexOf("=")), value.slice(value.indexOf("=") + 1).replaceAll("\\n", "\n").replaceAll("\\t", "\t").replaceAll("\\\\", "\\")]));
    const command = argv[0];
    const done = (output = "") => ({ status: "completed" as const, started: true, output });
    if (signal?.aborted) return { status: "cancelled", started: false, output: "" };
    if (!state.available) return { status: "unavailable", started: false, output: "", reason: "fixture_binary_missing" };
    if (command === "vault") return done(state.mismatch ? path.join(root, "other") : root);
    if (command === "help") return done(state.advertised.join("\n"));
    if (command === "version") return done("1.13.7 (installer 1.12.7)");
    if (command === "read") return done(await readFile(path.join(root, values.path!), "utf8"));
    if (command === "diff") return done("local versions");
    if (command === "daily:path") return done(nativeJournalPathForDate(fixture.app, new Date(), "old-directory"));
    if (command === "history") return done("1\t2026-10-09\n");
    if (command === "history:read") return done(state.historyContent);
    if (command === "history:restore") { await fixture.write(values.path!, state.historyContent); return done("Restored"); }
    if (command === "plugins" || command === "plugins:enabled") return done(JSON.stringify([...(command === "plugins" ? state.installed : state.enabled)].map(id => ({ id }))));
    if (command?.startsWith("plugin:")) {
      if (command === "plugin:install") { state.installed.add(values.id!); if (argv.includes("enable")) state.enabled.add(values.id!); }
      if (command === "plugin:enable") state.enabled.add(values.id!);
      if (command === "plugin:disable") state.enabled.delete(values.id!);
      if (command === "plugin:uninstall") { state.installed.delete(values.id!); state.enabled.delete(values.id!); }
      if (command === "plugin:reload") app.plugins.plugins[values.id!] = {};
      return done("Done");
    }
    if (command === "open" || command === "tab:open") { state.activeFile = values.path ?? values.file!; state.activeView = state.activeFile.endsWith(".base") ? "bases" : "markdown"; return done("Opened"); }
    if (command === "daily" || command === "daily:append" || command === "daily:prepend") {
      const relativePath = nativeJournalPathForDate(fixture.app, new Date(), "old-directory");
      let old = ""; try { old = await readFile(path.join(root, relativePath), "utf8"); } catch {}
      const next = command === "daily" ? old || "# Daily\n" : command === "daily:append" ? old + (argv.includes("inline") ? "" : "\n") + values.content! : values.content! + "\n" + old;
      await fixture.write(relativePath, next);
      if (command === "daily" || argv.includes("open")) state.activeFile = relativePath;
      if (state.failAfterDailyWrite) return { status: "failed", started: true, output: "", reason: "fixture_connection_lost" };
      return done("Updated");
    }
    if (command === "base:create") { await fixture.write(`Records/${values.name}.md`, values.content ?? ""); return done("Created"); }
    if (state.truncate) return { status: "truncated", started: true, output: "partial" };
    return done(command === "search" ? "" : "result");
  } };
  return { transport, calls, state };
}
export async function runOfficialCliTests(root: string): Promise<void> {
  const fixture = await nativeJournalFixture(root);
  const fake = officialCliFixture(fixture, root);
  const adapter = new ObsidianVaultDomainAdapter(fixture.app, "cli-vault", root);
  const catalog = new ObsidianPluginDirectory(async () => [{ id: "sample-plugin", name: "Sample Plugin", author: "Official Sample", description: "Synthetic test plugin", repo: "obsidianmd/sample-plugin" }]);
  const port = createObsidianNativePort(fixture.app, adapter, () => "old-directory", { transport: fake.transport, directory: catalog });
  const approvals = new FileApprovalTicketStore({ storageRootPath: path.join(root, ".approvals"), vaultId: adapter.vaultId });
  const receipts = new FileDomainReceiptStore({ storageRootPath: path.join(root, ".receipts"), vaultId: adapter.vaultId });
  await approvals.initialize(); await receipts.initialize();
  let access: PiWorkspaceAccess = { permission: "read-only", mode: "agent", memoryMode: "normal" };
  const identity = { vaultId: adapter.vaultId, conversationId: "cli-conversation", piSessionId: "cli-session", productRunId: "cli-run" };
  let confirmations = 0;
  let confirmResult = true;
  let abortConfirmation = false;
  const security = new PiObsidianToolSecurity({ currentAccess: () => access, currentRunIdentity: () => ({ ...identity }), approvals, receipts, userId: "fixture-user", deviceId: "fixture-device", confirmation: { async confirm(input) { confirmations++; if (abortConfirmation) throw new Error("cancelled"); assert.equal(input.toolId, "obsidian_cli"); return confirmResult; } } });
  const tools = createPiObsidianToolDefinitions(port, security);
  let sequence = 0;
  const call = async (input: any, toolName = "obsidian_cli", signal?: AbortSignal) => {
    const toolCallId = `official-cli-${++sequence}`;
    const event = { toolName, toolCallId, input } as any;
    const block = await security.handleToolCall(event, signal);
    if (block) return block as any;
    const raw = await tools.find(tool => tool.name === toolName)!.execute(toolCallId, input, signal, undefined);
    const result = await security.handleToolResult({ ...event, ...raw, isError: false } as any);
    return { ...result, value: JSON.parse(result.content[0]!.text), toolCallId };
  };
  assert.equal(OBSIDIAN_CLI_COMMANDS.length, 50);
  const required: Record<string, object> = {
    folder: { path: "Records" }, file: { path: "Read.md" }, read: { path: "Read.md" }, outline: { path: "Read.md" }, wordcount: { path: "Read.md" }, search: { query: "text" }, "search:context": { query: "text" }, backlinks: { path: "Read.md" }, links: { path: "Read.md" }, tag: { name: "test" }, "property:read": { name: "date", path: "Read.md" }, task: { path: "Read.md", line: 1 }, "template:read": { name: "test" }, "base:query": { path: "Views/test.base" }, open: { path: "Read.md" }, "base:views": { path: "Views/test.base" }, "base:create": { path: "Views/test.base", name: "New" }, "daily:append": { content: "append" }, "daily:prepend": { content: "prepend" }, diff: { path: "Read.md" }, history: { path: "Read.md" }, "history:read": { path: "Read.md" }, "history:restore": { path: "Read.md", version: 1 }, "history:open": { path: "Read.md" }, plugin: { id: "sample-plugin" }
  };
  for (const command of OBSIDIAN_CLI_COMMANDS) assert.equal(normalizeObsidianCliRequest({ command, ...(required[command] ?? (command.startsWith("plugin:") ? { id: "sample-plugin" } : {})) }).command, command);
  for (const input of [{ command: "eval", code: "1" }, { command: "version", vault: "other" }, { command: "version", executable: "bash" }, { command: "task", path: "Read.md", line: 1, toggle: true }, { command: "task", path: "Read.md", line: 1, status: "x" }, { command: "diff", path: "Read.md", filter: "sync" }, { command: "tab:open", view: "terminal" }]) assert.throws(() => normalizeObsidianCliRequest(input));
  assert.equal(obsidianCliEffect({ command: "daily" }), "note_write");
  assert.equal(obsidianCliEffect({ command: "plugin:install", id: "sample-plugin" }), "plugin_write");
  assert.deepEqual(obsidianCliArgv({ command: "daily:append", content: "line 1\n$(evil) `literal`", inline: true }), ["daily:append", "content=line 1\\n$(evil) `literal`", "inline"]);
  for (const command of ["read", "template:read", "history:read", "search:context", "diff", "property:read", "properties", "outline", "base:query", "aliases"]) assert.equal(obsidianCliOutputIsError(command, "Error: valid note text\nUnknown command is also text", ""), false);
  assert.equal(obsidianCliOutputIsError("plugins", "Error: actual CLI failure", ""), true);
  await fixture.write("Read.md", "Error: user text\nUnknown command is note text\n");
  await fixture.write("Views/test.base", "views:\n  - type: table\n    name: All\n");
  await mkdir(path.join(root, "Records"), { recursive: true });
  assert.equal((await call({ command: "read", path: "Read.md" })).value.status, "completed");
  assert.equal((await call({ command: "search", query: "missing", path: "Records" })).value.status, "empty");
  assert.equal((await call({ command: "folder", path: "Read.md" })).block, true);
  assert.equal((await call({ command: "read", path: "../escape.md" })).block, true);
  await call({ command: "diff", path: "Read.md" });
  assert.ok(fake.calls.some(argv => argv[0] === "diff" && argv.includes("filter=local")));
  const pluginSearch = await call({ query: "sample" }, "obsidian_plugin_search");
  assert.equal(pluginSearch.value.plugins[0].id, "sample-plugin"); assert.equal(pluginSearch.value.installedList, false);
  assert.equal((await call({ query: "no match" }, "obsidian_plugin_search")).value.status, "empty");
  assert.equal(confirmations, 0);
  for (const mode of ["agent", "plan"] as const) {
    access = { ...access, mode };
    for (const input of [{ command: "daily" }, { command: "daily:append", content: "no" }, { command: "history:restore", path: "Read.md", version: 1 }, { command: "plugin:install", id: "sample-plugin" }, { command: "open", path: "Read.md" }, { command: "base:create", path: "Views/test.base", name: "No" }]) {
      assert.equal(piWorkspaceAllowsTool({ ...access, toolName: "obsidian_cli", toolArguments: input, planToolNames: ["obsidian_cli"], memoryToolNames: [], externalReadToolNames: [] }), false);
      assert.equal((await call(input)).block, true);
    }
  }
  access = { ...access, permission: "workspace-write", mode: "plan" };
  assert.equal((await call({ command: "daily:append", content: "no" })).block, true);
  access = { ...access, mode: "agent" };
  for (const command of ["plugin:disable", "plugin:uninstall", "plugin:reload"]) assert.match((await call({ command, id: "codex-echoink" })).reason, /cannot_interrupt/);
  confirmResult = false;
  assert.equal((await call({ command: "daily:append", content: "denied" })).reason, "approval_denied");
  assert.ok(!(await approvals.listViews({ conversationId: identity.conversationId })).some(view => view.status === "pending"));
  confirmResult = true; abortConfirmation = true;
  assert.equal((await call({ command: "daily:append", content: "cancelled" })).reason, "approval_cancelled");
  abortConfirmation = false;
  const dailyTarget = nativeJournalPathForDate(fixture.app, new Date(), "old-directory");
  await fixture.write(dailyTarget, "x".repeat(40_000));
  assert.equal((await call({ command: "daily:path" })).value.status, "completed", "path lookup must not read oversized note content");
  await fixture.write(dailyTarget, "# Daily\n");
  const saved = await call({ command: "daily:append", content: "Saved once" });
  assert.equal(saved.value.status, "completed"); assert.equal(saved.details.readbackVerified, true);
  assert.ok((await receipts.listUiViews()).some(row => row.toolCallId === saved.toolCallId && row.receipt?.status === "completed"));
  assert.equal((await call({ command: "daily:append", content: "line one\r\nline two" })).value.status, "completed", "argv and readback use the same normalized content");
  const restored = await call({ command: "history:restore", path: "Read.md", version: 1 });
  assert.equal(restored.value.status, "completed"); assert.equal(await readFile(path.join(root, "Read.md"), "utf8"), fake.state.historyContent);
  assert.match((await call({ command: "history:restore", path: "Read.md", version: 2 })).reason, /history_version_missing/);
  assert.equal((await call({ command: "base:views", path: "Views/test.base" })).block, true);
  assert.equal((await call({ command: "tab:open", file: "Views/test.base", view: "bases" })).value.status, "completed");
  assert.equal((await call({ command: "base:views", path: "Views/test.base" })).value.status, "completed");
  assert.equal((await call({ command: "base:create", path: "Views/test.base", name: "New", content: "record" })).value.readbackVerified, true);
  assert.equal(await readFile(path.join(root, "Records/New.md"), "utf8"), "record");
  for (const input of [{ command: "plugin:install", id: "sample-plugin", enable: true }, { command: "plugin:disable", id: "sample-plugin" }, { command: "plugin:enable", id: "sample-plugin" }, { command: "plugin:reload", id: "sample-plugin" }, { command: "plugin:uninstall", id: "sample-plugin" }]) assert.equal((await call(input)).value.status, "completed", JSON.stringify(input));
  assert.equal((await call({ command: "plugin:install", id: "unverified-plugin" })).block, true);
  const changed = { command: "daily:append", content: "Must not overwrite newer text" };
  const id = `official-cli-${++sequence}`;
  assert.equal(await security.handleToolCall({ toolName: "obsidian_cli", toolCallId: id, input: changed } as any), undefined);
  const dailyPath = nativeJournalPathForDate(fixture.app, new Date(), "old-directory");
  await fixture.write(dailyPath, "user changed meanwhile");
  const raw = await tools.find(tool => tool.name === "obsidian_cli")!.execute(id, changed as any, undefined, undefined);
  const stale = await security.handleToolResult({ toolName: "obsidian_cli", toolCallId: id, input: changed, ...raw, isError: false } as any);
  assert.equal(stale.isError, true); assert.equal(await readFile(path.join(root, dailyPath), "utf8"), "user changed meanwhile");
  const controller = new AbortController(); controller.abort();
  assert.equal((await call({ command: "daily:append", content: "cancelled before execution" }, "obsidian_cli", controller.signal)).reason, "approval_cancelled");
  fake.state.failAfterDailyWrite = true;
  assert.equal((await call({ command: "daily:append", content: "Uncertain saved once" })).value.status, "uncertain");
  const writeCount = fake.calls.filter(argv => argv[0] === "daily:append").length;
  assert.match((await call({ content: "Uncertain saved once", command: "daily:append" })).reason, /do_not_retry/);
  assert.equal(fake.calls.filter(argv => argv[0] === "daily:append").length, writeCount);
  assert.match((await call({ command: "daily:append", content: "Uncertain saved once", open: true })).reason, /do_not_retry/, "adding a UI flag must not bypass duplicate suppression");
  fake.state.failAfterDailyWrite = false;
  assert.equal((await call({ command: "daily:append", content: "A separate new note" })).value.status, "completed", "uncertainty must not block different approved content forever");
  assert.equal((await call({ command: "daily:read" })).value.status, "completed", "queries remain usable after uncertainty");
  fake.state.available = false;
  assert.equal((await call({ command: "version" })).value.status, "unavailable");
  fake.state.available = true; fake.state.advertised = fake.state.advertised.filter(command => command !== "outline");
  assert.equal((await call({ command: "outline", path: "Read.md" })).value.status, "unsupported");
  fake.state.mismatch = true;
  assert.equal((await call({ command: "files" })).block, true);
  fake.state.mismatch = false;
  fake.state.truncate = true;
  assert.equal((await call({ command: "files" })).value.status, "truncated");
  await assertInterruptedReceiptRecovery(approvals, receipts, identity, adapter);
  await assertFinanceAdapter(fixture, root, adapter, approvals, receipts, identity);
  // The actual current machine may lack the binary; this read-only call never launches a GUI fallback.
  const actualPort = createObsidianNativePort(fixture.app, adapter, () => "old-directory");
  const actual = await actualPort.cli({ command: "version" });
  assert.equal(actual.engine, "obsidian-official-cli");
  console.log(`Actual public CLI availability: ${actual.status}; ${actual.reason ?? "available"}`);
  console.log("PASS official CLI command parameters, raw Error text, current Vault, Plan/read-only, exact approvals/Receipts, daily/history/Base/plugin readback, cancellation and no uncertain retry");
}
async function assertFinanceAdapter(fixture: Fixture, root: string, adapter: ObsidianVaultDomainAdapter, approvals: FileApprovalTicketStore, receipts: FileDomainReceiptStore, identity: any) {
  let paid = true;
  const access: CapabilityAccess = { checkCapability: () => paid, requireCapability: () => { if (!paid) throw new Error("PRO_REQUIRED"); }, subscribe: () => () => {} };
  const store = new LifestyleStore(path.join(root, ".finance-store.json")); await store.initialize();
  const plugin = fixture.plugin as any;
  plugin.registerEvent = () => {};
  (fixture.app.vault as any).on = () => ({});
  const finance = new LifestyleFinanceService({ plugin, store, refresh() {} } as unknown as LifestyleService, access);
  await finance.initialize();
  const fake = officialCliFixture(fixture, root);
  fake.state.available = false; // The business adapter remains usable without a public CLI installation.
  const port = createObsidianNativePort(fixture.app, adapter, () => "old-directory", { transport: fake.transport, finance });
  let confirms = 0;
  const security = new PiObsidianToolSecurity({ currentAccess: () => ({ permission: "workspace-write", mode: "agent", memoryMode: "normal" }), currentRunIdentity: () => ({ ...identity }), approvals, receipts, userId: "fixture-user", deviceId: "fixture-device", confirmation: { async confirm(input) { confirms++; assert.match(JSON.stringify(input.preview), /echoink-finance-service/); return true; } } });
  const tools = createPiObsidianToolDefinitions(port, security);
  const input = { command: "base:create", path: finance.ledger.paths().base, finance: { date: "2026-10-09", merchant: " 早餐店 ", kind: "expense", amountCents: 1200, category: "餐饮" } };
  const event = { toolName: "obsidian_cli", toolCallId: "finance-adapter-create", input } as any;
  assert.equal(await security.handleToolCall(event), undefined);
  const raw = await tools.find(tool => tool.name === "obsidian_cli")!.execute(event.toolCallId, input as any, undefined, undefined);
  const result = await security.handleToolResult({ ...event, ...raw, isError: false });
  const value = JSON.parse(result.content[0]!.text);
  assert.equal(value.engine, "echoink-finance-service"); assert.equal(value.status, "completed"); assert.equal(result.details.readbackVerified, true);
  assert.equal(confirms, 1); assert.equal(fake.calls.length, 0, "financial entry was produced by the real existing service, not simulated CLI execution");
  const entry = finance.entries().at(-1)!;
  const note = parseFinanceNote(await readFile(path.join(root, finance.ledger.pathForNewEntry(entry.id)), "utf8"))!;
  assert.equal(note.amountCents, 1200); assert.equal(note.merchant, "早餐店"); assert.equal(note.source, "manual"); assert.equal(note.sourceId, entry.sourceId);
  paid = false;
  assert.equal((await security.handleToolCall({ ...event, toolCallId: "finance-no-membership" }))?.block, true);
  assert.equal(confirms, 1, "existing membership check runs before approval or creation");
}
async function assertInterruptedReceiptRecovery(approvals: FileApprovalTicketStore, receipts: FileDomainReceiptStore, identity: any, adapter: ObsidianVaultDomainAdapter) {
  const contract: ApprovalOperationContract = { ...identity, userId: "fixture-user", deviceId: "fixture-device", toolId: "obsidian_cli", toolVersion: "obsidian-public-cli-v1", policyVersion: "obsidian-cli-policy-v1", toolCallId: "interrupted-native", normalizedArguments: normalizeJsonValue({ command: "daily:prepend", content: "never replay" }), resolvedTarget: normalizeJsonValue({ command: "daily:prepend", dailyPath: "Daily.md" }), targetVersion: null, preview: null };
  const issuedAt = Date.now();
  const ticket = await approvals.issue({ ...contract, issuedAt, expiresAt: issuedAt + 300_000 });
  const authorization = await approvals.consume({ ticketId: ticket.ticketId, operationIdentity: ticket.operationIdentity, contract });
  await receipts.beginAuthorizedOperation(authorization); await receipts.markEffectStarted(authorization.operationIdentity);
  await recoverPiVaultDomainReceipts({ receipts, domainService: new VaultDomainService(adapter) });
  assert.equal((await receipts.listUiViews()).find(row => row.toolCallId === "interrupted-native")?.receipt?.status, "uncertain");
}
