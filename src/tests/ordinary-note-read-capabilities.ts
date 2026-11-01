import assert from "node:assert/strict";
import * as path from "node:path";
import { readFile } from "node:fs/promises";
import { checkAgentCapability, checkAgentSkill, checkAgentTool, requireAgentCapability, type AgentCapabilityContext } from "../agents/capability-policy";
import { agentCapabilityDenialText } from "../agents/capability-denial";
import { emptyKnowledgeFolderBindings, migrateKnowledgeFolderBindings } from "../knowledge-base/folder-bindings";
import { createPiAgentCapabilityContext, createProductionPiKnowledgeRuntime, type PiProductionPluginHost } from "../plugin/pi-production-runtime-composition";
import { nativeJournalFixture } from "./native-journal-fixture";
import { officialCliFixture } from "./obsidian-cli";
import { ObsidianVaultDomainAdapter } from "../plugin/obsidian-vault-domain-adapter";
import { VaultDomainService } from "../harness/pi-native/vault-domain-service";
import { createObsidianNativePort } from "../plugin/obsidian-native-tools";
import { PiObsidianToolSecurity, createPiObsidianToolDefinitions } from "../harness/pi-native/pi-obsidian-tools";
import { FileApprovalTicketStore } from "../harness/pi-native/tool-authorization";
import { FileDomainReceiptStore } from "../harness/pi-native/domain-receipt-store";
import { createPiVaultProductionAuthorizationPort, createPiVaultProductionWriteExecutionPort } from "../plugin/pi-vault-tool-production";
import { createPiVaultToolDefinitions } from "../harness/pi-native/pi-vault-tool-contracts";
import { createPiVaultToolSecurityAdapter, createSecurePiVaultToolResultCorrectionPort } from "../harness/pi-native/pi-vault-tool-security-extension";
import { EchoInkVaultToolEgressPolicy } from "../harness/pi-native/vault-tool-result-safety";
import type { EchoInkResource } from "../resources/types";

/** Real production dispatch and executors; only the Obsidian host/CLI transport is simulated. */
export async function runOrdinaryNoteReadCapabilityTests(root: string): Promise<void> {
  const fixture = await nativeJournalFixture(root), settings = fixture.plugin.settings;
  const text = "ORDINARY_READ_JAPAN 旅行计划";
  for (const file of ["旅行/日本.md", "Daily/今日.md", "输出/草稿.md", "模板/旅行.md", "关闭/保密.md"]) await fixture.write(file, text);
  settings.journalDirectory = "Daily";
  settings.englishDiary.enabled = true;
  settings.agentRegistry.agents.push({ id: "knowledge-reader", name: "知识员", avatar: { kind: "default" }, position: "读笔记", styleId: "analysis", capabilityIds: ["knowledge"] },
    { id: "journal-reader", name: "日记员", avatar: { kind: "default" }, position: "读日记", styleId: "analysis", capabilityIds: ["journal"] });
  const sol = settings.agentRegistry.agents[0];
  let agentId = "sol";
  const access = { permission: "workspace-write", mode: "agent", memoryMode: "normal" } as const;
  const resources: EchoInkResource[] = [{ id: "local-mcp", name: "Local", kind: "mcp-server", source: "manual", enabled: true, bridgeMode: "structured-tools", description: "Fixture" },
    { id: "obsidian-markdown", name: "Markdown", kind: "skill", source: "echoink-local", enabled: true, bridgeMode: "prompt-only", description: "Fixture" }];
  const host = { ...fixture.plugin, accountService: { checkCapability: () => true, requireCapability() {}, subscribe: () => () => {} },
    buildRuntimeEchoInkResourceCatalog: async () => resources } as unknown as PiProductionPluginHost;
  const context = (): AgentCapabilityContext => createPiAgentCapabilityContext(host, agentId, resources, access);
  const allowed = async (name: string, args: Readonly<Record<string, unknown>>, target?: unknown) => requireAgentCapability(checkAgentTool(context(), name, args, target));
  const adapter = new ObsidianVaultDomainAdapter(fixture.app, "ordinary-read", root);
  const domain = new VaultDomainService(adapter);
  const identity = { vaultId: "ordinary-read", conversationId: "same-session", piSessionId: "session", productRunId: "run" };
  const approvals = new FileApprovalTicketStore({ storageRootPath: path.join(root, "state"), vaultId: identity.vaultId });
  const receipts = new FileDomainReceiptStore({ storageRootPath: path.join(root, "state"), vaultId: identity.vaultId });
  await approvals.initialize(); await receipts.initialize();
  const security = createPiVaultToolSecurityAdapter({ isToolAllowed: (name, args) => checkAgentTool(context(), name, args).allowed,
    authorization: createPiVaultProductionAuthorizationPort({ approvals, adapter, currentRunIdentity: () => identity, currentWorkspaceAccess: () => access, userId: "fixture", deviceId: "fixture", confirmation: { async confirm() { return true; } } }),
    resultCorrection: createSecurePiVaultToolResultCorrectionPort(new EchoInkVaultToolEgressPolicy()) });
  const events = new Map<string, (...args: any[]) => any>();
  const extension = typeof security.inlineExtension === "function" ? security.inlineExtension : security.inlineExtension.factory;
  await extension({ on: (name: string, handler: (...args: any[]) => any) => events.set(name, handler) } as never);
  const tools = createPiVaultToolDefinitions({ domainService: domain, security, writeExecution: createPiVaultProductionWriteExecutionPort({ receipts, domainService: domain }), assertToolAllowed: allowed });
  let sequence = 0;
  const dispatch = async (name: string, input: Record<string, unknown>) => {
    const toolCallId = `ordinary-${++sequence}`;
    assert.equal(await events.get("tool_call")!({ toolName: name, toolCallId, input }, {}), undefined, `${name} dispatch must be admitted`);
    const result = await tools.find(tool => tool.name === name)!.execute(toolCallId, input, undefined, undefined);
    assert.equal(result.details.status, "completed");
    const corrected = await events.get("tool_result")!({ toolName: name, toolCallId, input, ...result, isError: false }, {});
    return JSON.stringify(corrected);
  };
  const official = officialCliFixture(fixture, root);
  const native = createObsidianNativePort(fixture.app, adapter, () => "Daily", { transport: official.transport });
  const cliSecurity = new PiObsidianToolSecurity({ assertToolAllowed: allowed, currentAccess: () => access, currentRunIdentity: () => identity, approvals, receipts, userId: "fixture", deviceId: "fixture", confirmation: { async confirm() { return true; } } });
  const cli = createPiObsidianToolDefinitions(native, cliSecurity).find(tool => tool.name === "obsidian_cli")!;
  const cliDispatch = async (input: Record<string, unknown>) => {
    const toolCallId = `cli-${++sequence}`;
    assert.equal(await cliSecurity.handleToolCall({ toolName: "obsidian_cli", toolCallId, input } as never), undefined);
    const result = await cli.execute(toolCallId, input, undefined, undefined);
    return cliSecurity.handleToolResult({ toolName: "obsidian_cli", toolCallId, input, ...result, isError: false } as never);
  };

  // A custom-folder migration is the production result used when loading absent bindings.
  for (const bindings of [null, emptyKnowledgeFolderBindings(), { ...emptyKnowledgeFolderBindings(), configured: false },
    { ...emptyKnowledgeFolderBindings(), configured: true }, migrateKnowledgeFolderBindings(["旅行", "Daily", "输出", "模板"])]) {
    settings.knowledgeBase.folderBindings = bindings;
    assert.equal(checkAgentTool(context(), "obsidian_cli", { command: "search", query: text }).allowed, true,
      "unconfigured ordinary CLI search must not depend on the Knowledge directory gate");
    assert.match(await dispatch("note_read", { relativePath: "旅行/日本.md" }), /ORDINARY_READ_JAPAN/u);
    assert.match(await dispatch("vault_search", { query: "日本" }), /旅行\/日本.md/u);
    assert.match(JSON.stringify(await cliDispatch({ command: "read", path: "旅行/日本.md" })), /ORDINARY_READ_JAPAN/u);
    assert.match(JSON.stringify(await cliDispatch({ command: "search", query: "ORDINARY_READ_JAPAN", path: "旅行" })), /旅行\/日本.md/u);
  }
  settings.knowledgeBase.folderBindings = emptyKnowledgeFolderBindings();
  const bindings = settings.knowledgeBase.folderBindings;
  for (const relativePath of ["Daily/今日.md", "输出/草稿.md", "模板/旅行.md"]) {
    assert.match(await dispatch("note_read", { relativePath }), /ORDINARY_READ_JAPAN/u);
  }
  assert.equal(checkAgentTool(context(), "obsidian_cli", { command: "search", query: text, path: "Daily" }).allowed, true);
  for (const command of ["read", "file", "outline", "wordcount", "folder", "files", "folders", "search", "search:context"]) {
    const input = { command, ...(command === "files" || command === "folders" ? { folder: "旅行" }
      : { path: command === "folder" || command.startsWith("search") ? "旅行" : "旅行/日本.md" }),
      ...(command.startsWith("search") ? { query: "日本" } : {}) };
    assert.equal(checkAgentTool(context(), "obsidian_cli", input).allowed, true, command);
  }
  for (const command of ["open", "base:query", "history:read"]) {
    assert.equal(checkAgentTool(context(), "obsidian_cli", { command, path: "旅行/日本.md" }).reason, "module_disabled", command);
  }
  assert.equal(checkAgentTool(context(), "obsidian_cli", { command: "search:open", query: "日本" }).reason, "module_disabled");
  assert.equal(checkAgentTool(context(), "obsidian_cli").allowed, true, "CLI discovery remains conversation-based");
  assert.equal(checkAgentCapability(context(), "knowledge").reason, "module_disabled");
  for (const name of ["knowledge_search", "knowledge_read", "knowledge_maintain", "knowledge_linking_propose"]) {
    assert.equal(checkAgentTool(context(), name, { path: "旅行/日本.md" }).reason, "module_disabled", name);
  }
  assert.equal(checkAgentSkill(context(), "obsidian-markdown").reason, "module_disabled");
  assert.equal(checkAgentTool(context(), "local-read", { path: "旅行/日本.md" }, undefined, { resourceId: "local-mcp", toolName: "read", readOnly: true }).reason, "module_disabled");
  assert.equal(checkAgentTool(context(), "diagram_create", { sourcePaths: ["旅行/日本.md"] }).reason, "module_disabled");
  assert.equal(checkAgentTool(context(), "english_diary_generate", { sourcePath: "旅行/日本.md" }).reason, "module_disabled");
  for (const name of ["note_create", "note_update", "metadata_update", "note_move", "note_delete"]) {
    assert.equal(checkAgentTool(context(), name, { relativePath: "旅行/日本.md", sourcePath: "旅行/日本.md", targetPath: "输出/草稿.md" }).reason, "module_disabled", name);
  }
  assert.match(await dispatch("note_read", { relativePath: "旅行/日本.md" }), /ORDINARY_READ_JAPAN/u);
  assert.equal(checkAgentTool({ ...context(), access: { ...access, permission: "read-only" } }, "note_read", { relativePath: "旅行/日本.md" }).allowed, true);
  assert.equal(checkAgentTool({ ...context(), access: { ...access, permission: "read-only" } }, "note_create", { relativePath: "输出/生成.md" }).reason, "read_only");
  await assert.rejects(tools.find(tool => tool.name === "note_create")!.execute("generation-write", { relativePath: "输出/生成.md", content: text }, undefined, undefined), /module_disabled:knowledge/u);
  await assert.rejects(readFile(path.join(root, "输出/生成.md")), /ENOENT/u);

  agentId = "knowledge-reader";
  for (const name of ["vault_search", "note_read"]) assert.equal(checkAgentTool(context(), name).allowed, true, "ordinary tools remain visible to a Knowledge-only Agent");
  assert.equal(checkAgentTool(context(), "vault_search", { query: text }).reason, "scope_required");
  assert.equal(checkAgentTool(context(), "obsidian_cli", { command: "search", query: text }).reason, "scope_required");
  assert.match(await dispatch("vault_search", { query: "日本", scopePath: "旅行" }), /旅行\/日本.md/u);
  assert.match(await dispatch("note_read", { relativePath: "旅行/日本.md" }), /ORDINARY_READ_JAPAN/u);
  assert.equal(checkAgentTool(context(), "note_read", { relativePath: "Daily/今日.md" }).reason, "agent_disabled");
  agentId = "journal-reader";
  assert.match(await dispatch("note_read", { relativePath: "Daily/今日.md" }), /ORDINARY_READ_JAPAN/u);
  assert.equal(checkAgentTool(context(), "note_read", { relativePath: "旅行/日本.md" }).reason, "agent_disabled");
  agentId = "sol";
  sol.disabledCapabilityIds = ["journal"];
  assert.equal(checkAgentTool(context(), "note_read", { relativePath: "Daily/今日.md" }).reason, "agent_disabled");
  sol.disabledCapabilityIds = ["knowledge"];
  assert.equal(checkAgentTool(context(), "note_read", { relativePath: "旅行/日本.md" }).reason, "agent_disabled");
  sol.disabledCapabilityIds = [];

  for (const role of ["wiki", "journal"] as const) for (const source of ["readPaths", "writePath"] as const) {
    bindings.roles[role][source] = (source === "readPaths" ? ["关闭"] : "关闭") as never;
    for (const input of [{ command: "search", query: text }, { command: "files" }]) assert.equal(checkAgentTool(context(), "obsidian_cli", input).reason, "scope_required");
    assert.equal(checkAgentTool(context(), "vault_search", { query: text }).reason, "scope_required");
    const callsBefore = official.calls.length;
    for (const input of [{ command: "search", query: text }, { command: "files" }]) {
      assert.ok((await cliSecurity.handleToolCall({ toolName: "obsidian_cli", toolCallId: `closed-${++sequence}`, input } as never))?.block);
    }
    assert.equal(official.calls.length, callsBefore, "unscoped denied CLI requests never reach target preparation or transport");
    assert.ok((await events.get("tool_call")!({ toolName: "vault_search", toolCallId: `closed-${++sequence}`, input: { query: text } }, {}))?.block);
    assert.equal(checkAgentTool(context(), "vault_search", { query: text, scopePath: "关闭" }).reason, "module_disabled");
    assert.equal(checkAgentTool(context(), "note_read", { relativePath: "关闭/保密.md" }).reason, "module_disabled");
    assert.match(await dispatch("vault_search", { query: "日本", scopePath: "旅行" }), /旅行\/日本.md/u);
    assert.equal(checkAgentTool(context(), "obsidian_cli", { command: "search", query: text, path: "旅行" }).allowed, true);
    bindings.roles[role].readPaths = []; bindings.roles[role].writePath = null;
  }
  bindings.roles.wiki.readPaths = ["旅行/关闭"];
  assert.equal(checkAgentTool(context(), "vault_search", { query: text, scopePath: "旅行" }).reason, "module_disabled", "broad scopes still inspect nested disabled roots");
  bindings.roles.wiki.readPaths = [];
  for (const relativePath of ["../外部.md", ".obsidian/secret.md", path.join(root, "..", "外部.md")]) assert.equal(checkAgentTool(context(), "note_read", { relativePath }).reason, "invalid_target");

  // These are the same two checks used by dispatch and the executor, with live settings between them.
  const pendingId = `read-revocation-${++sequence}`, input = { relativePath: "旅行/日本.md" };
  assert.equal(await events.get("tool_call")!({ toolName: "note_read", toolCallId: pendingId, input }, {}), undefined);
  sol.disabledCapabilityIds = ["knowledge"];
  await assert.rejects(tools.find(tool => tool.name === "note_read")!.execute(pendingId, input, undefined, undefined), /agent_disabled:knowledge/u);
  sol.disabledCapabilityIds = [];
  assert.match(await dispatch("note_read", input), /ORDINARY_READ_JAPAN/u, "the same session can retry after restoring current permissions");
  const cliId = `cli-revocation-${++sequence}`, cliInput = { command: "read", path: input.relativePath };
  assert.equal(await cliSecurity.handleToolCall({ toolName: "obsidian_cli", toolCallId: cliId, input: cliInput } as never), undefined);
  sol.disabledCapabilityIds = ["knowledge"];
  await assert.rejects(cli.execute(cliId, cliInput, undefined, undefined), /agent_disabled:knowledge/u);
  sol.disabledCapabilityIds = [];
  const prepare = native.prepare!.bind(native);
  native.prepare = async (...args) => { const result = await prepare(...args); sol.disabledCapabilityIds = ["journal"]; return result; };
  try {
    assert.ok((await cliSecurity.handleToolCall({ toolName: "obsidian_cli", toolCallId: "resolved-revoked", input: { command: "read", file: "今日" } } as never))?.block,
      "resolved CLI target rechecks a permission revoked during preparation");
  } finally { native.prepare = prepare; sol.disabledCapabilityIds = []; }
  assert.ok(!official.calls.some(call => call[0] === "read" && call.includes("path=Daily/今日.md")));
  const knowledge = createProductionPiKnowledgeRuntime({ vaultRootPath: root, knowledgePreferences: {} as never, usage: {} as never,
    isConversationKnowledgeAllowed: async () => checkAgentCapability(context(), "knowledge").allowed,
    conversationKnowledgeDecision: async () => checkAgentCapability(context(), "knowledge") });
  const request = { ...identity, question: text, explicitPaths: [], includeUnrefined: false };
  assert.equal((await knowledge.retrieveChat!(request)).status, "no_evidence");
  await assert.rejects(knowledge.retrieveAsk(request), /module_disabled:knowledge/u);
  assert.equal(agentCapabilityDenialText("module_disabled", "knowledge", "zh"), "知识库当前不可用，请前往设置 → 知识库检查目录配置。");
  assert.match(agentCapabilityDenialText("module_disabled", "knowledge", "en"), /Settings → Knowledge/u);
  assert.equal(agentCapabilityDenialText("module_disabled", "journal", "zh"), "日记已关闭，请开启后再继续。");
  console.log("PASS ordinary note reads: real Vault/CLI dispatch, migration, visibility, scoped denials, live revocation and dedicated Knowledge isolation");
}
