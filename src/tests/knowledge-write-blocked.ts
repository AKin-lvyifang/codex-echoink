import assert from "node:assert/strict";
import { emptyKnowledgeFolderBindings, knowledgeFolderConflicts, knowledgeFolderIssues } from "../knowledge-base/folder-bindings";
import { knowledgeWikiWriteIssue } from "../knowledge-base/knowledge-write-context";
import { normalizePiVaultToolArguments } from "../harness/pi-native/pi-vault-tool-contracts";
import { createPiKnowledgeInlineExtension } from "../plugin/pi-production-runtime-composition";
import { secureVaultToolResult, EchoInkVaultToolEgressPolicy } from "../harness/pi-native/vault-tool-result-safety";

export async function runKnowledgeWriteBlockedTests(): Promise<void> {
  const hash = "a".repeat(64);
  for (const version of [hash, `sha256:${hash}`]) {
    for (const [tool, args] of [
      ["note_update", { relativePath: "Wiki/a.md", content: "body" }],
      ["metadata_update", { relativePath: "Raw/a.md", patch: { set: { topic: "new" } } }],
      ["note_move", { sourcePath: "Wiki/a.md", targetPath: "Wiki/b.md" }],
      ["note_delete", { relativePath: "Wiki/a.md" }]
    ] as const) assert.equal(normalizePiVaultToolArguments(tool, { ...args, expectedVersion: version }).expectedVersion, hash);
  }
  const config = emptyKnowledgeFolderBindings();
  Object.assign(config.roles.raw, { enabled: true, readPaths: ["raw", "资料"], writePath: "资料" });
  Object.assign(config.roles.wiki, { enabled: true, readPaths: ["资料/知识", "旧知识"], writePath: "资料/知识", compatibilityReadScopes: true });
  Object.assign(config.roles.projects, { enabled: true, readPaths: ["项目"], writePath: "项目" });
  assert.deepEqual(knowledgeFolderIssues(config), [], "Raw dual reads, nested Wiki, and legacy multi-read Wiki remain valid");
  assert.equal(knowledgeWikiWriteIssue(config, () => true), null);
  assert.equal(knowledgeWikiWriteIssue(config, () => false), "knowledge_directory_invalid");
  config.roles.projects.readPaths = ["资料/知识"]; config.roles.projects.writePath = "资料/知识";
  const snapshot = JSON.stringify(config);
  assert.equal(knowledgeFolderConflicts(config).length, 1);
  assert(knowledgeFolderIssues(config).some(issue => issue.includes("知识成果与项目")));
  assert.equal(knowledgeWikiWriteIssue(config), "knowledge_directory_conflict");
  assert.equal(JSON.stringify(config), snapshot, "checking old conflicts never deletes or migrates read scopes");
  assert.equal(knowledgeWikiWriteIssue(null), "knowledge_directory_unbound");

  const handlers = new Map<string, (...args: any[]) => any>();
  let activeTools = ["knowledge_read", "note_create", "metadata_update", "workspace_create"];
  const originalTools = [...activeTools];
  const extension = createPiKnowledgeInlineExtension({ vaultSecurity: () => {}, currentTurn: () => ({ kind: "chat", providerResourceText: "", references: [] }),
    knowledgeBindings: () => config, knowledgeDirectoryExists: () => true, pauseKnowledgeWriteTools: () => { activeTools = []; } });
  await extension.factory({ on: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler) } as never);
  const result = await handlers.get("before_agent_start")!({ systemPrompt: "EchoInk", prompt: "帮我整理资料，建立知识库" });
  assert.match(result.systemPrompt, /一次写入都不要尝试/u);
  assert.match(result.systemPrompt, /去设置目录/u);
  assert.deepEqual(activeTools, [], "an invalid destination offers no write or fallback tool to the model");
  // The runtime resets the active tool set from its registry at the start of every turn.
  activeTools = [...originalTools];
  config.roles.projects.readPaths = ["项目"]; config.roles.projects.writePath = "项目";
  const ready = await handlers.get("before_agent_start")!({ systemPrompt: "EchoInk", prompt: "帮我整理资料，建立知识库" });
  assert.match(ready.systemPrompt, /真实绑定/u);
  assert.match(ready.systemPrompt, /资料\/知识/u);
  assert.deepEqual(activeTools, originalTools);

  const failure = await secureVaultToolResult({ toolId: "metadata_update", effectType: "user_write", egressPolicy: "echoink-configured-provider-v1", sizeLimitBytes: 8000,
    value: { status: "failed", readback: { source: { snapshot: { content: "原文".repeat(10000) } } }, error: { code: "version_conflict", message: "Changed" } },
    egress: new EchoInkVaultToolEgressPolicy() });
  const parsed = JSON.parse(failure.text);
  assert.equal(parsed.error.code, "version_conflict");
  assert(parsed.recovery.includes("Read"));
  assert(failure.byteLength <= 8000);
  console.log("Knowledge write binding, revision and failure delivery regressions: PASS");
}
