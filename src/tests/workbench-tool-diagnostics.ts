import assert from "node:assert/strict";
import { piWorkspaceToolDecision, piWorkspaceAllowsTool } from "../harness/pi-native/pi-workspace-access";
import { createPiVaultToolSecurityAdapter } from "../harness/pi-native/pi-vault-tool-security-extension";
import { createPiKnowledgeMaintenanceToolSecurity } from "../harness/pi-native/pi-knowledge-maintenance-tool";
import { EchoInkVaultToolEgressPolicy } from "../harness/pi-native/vault-tool-result-safety";

export async function runWorkbenchToolDiagnosticTests(): Promise<void> {
  const access = { permission: "workspace-write", mode: "agent", memoryMode: "normal",
    planToolNames: ["note_read"], memoryToolNames: [], externalReadToolNames: [] } as const;
  const missingTarget = piWorkspaceToolDecision({ ...access, toolName: "obsidian_cli", toolArguments: { command: "read" } });
  assert.equal(missingTarget.allowed, false);
  assert.match(!missingTarget.allowed ? missingTarget.reason : "", /file 或 path/u);
  assert.equal(piWorkspaceAllowsTool({ ...access, toolName: "obsidian_cli", toolArguments: { command: "read" } }), false);
  assert.equal(piWorkspaceAllowsTool({ ...access, toolName: "obsidian_cli", toolArguments: { command: "read", path: "raw/articles/source.md" } }), true);
  assert.equal(piWorkspaceAllowsTool({ ...access, permission: "read-only", toolName: "knowledge_maintain" }), false);
  const maintenance = createPiKnowledgeMaintenanceToolSecurity({
    currentRunIdentity: () => ({ conversationId: "diagnostic-conversation", piSessionId: "diagnostic-session", productRunId: "diagnostic-run", vaultId: "diagnostic-vault" }),
    currentCommand: () => ({ mode: "maintain", request: "", scope: { mode: "batch", sourcePaths: ["raw/articles/source.md"] },
      preference: { profileVersion: "diagnostic-v1", state: "default", revision: `sha256:${"a".repeat(64)}`, providerResourceText: "Use the source." } }),
    egress: new EchoInkVaultToolEgressPolicy()
  });
  const adapter = createPiVaultToolSecurityAdapter({
    isToolAllowed: (toolName, args) => piWorkspaceToolDecision({ ...access, toolName, toolArguments: args ? { ...args } : undefined }),
    authorization: { async authorize() { throw new Error("unexpected authorization"); } },
    resultCorrection: { async correct() { throw new Error("unexpected result correction"); } },
    additionalToolSecurity: maintenance
  });
  const handlers = new Map<string, (...args: any[]) => any>();
  await adapter.inlineExtension.factory({ on: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler) } as never);
  const blocked = async (id: string, toolName: string, input: Record<string, unknown>) => {
    const call = { toolCallId: id, toolName, input };
    const rejection = await handlers.get("tool_call")!(call, { signal: undefined });
    assert.equal(rejection?.block, true);
    const result = await handlers.get("tool_result")!({ ...call, content: [{ type: "text", text: rejection.reason }], isError: true, details: {} });
    assert.equal(result.isError, true);
    assert.equal(result.content[0].text, rejection.reason, "the result hook must retain the complete original rejection");
    return rejection.reason as string;
  };
  assert.match(await blocked("missing-target", "obsidian_cli", { command: "read" }), /obsidian_cli_exact_target_required.*file 或 path/u);
  assert.match(await blocked("outside-scope", "knowledge_maintain", { sourcePaths: ["raw/articles/outside.md"], candidateActions: [] }), /knowledge_maintenance_source_scope_invalid.*raw\/articles\/source\.md/u);
  const valid = await handlers.get("tool_call")!({ toolCallId: "corrected-call", toolName: "knowledge_maintain", input: { sourcePaths: ["raw/articles/source.md"], candidateActions: [] } }, { signal: undefined });
  assert.equal(valid, undefined, "a fresh corrected call remains admissible");
  console.log("Workbench tool diagnostics: PASS (workspace decision + sole security extension + result hook)");
}
