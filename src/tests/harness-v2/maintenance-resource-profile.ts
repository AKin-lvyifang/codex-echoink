import * as assert from "node:assert/strict";
import { getAgentBackendDefinition } from "../../agent/registry";
import {
  MAINTENANCE_AGENT_RESOURCE_PROFILE,
  prepareAgentResources,
  resourceSelectionFromPreparedResources
} from "../../resources/registry";
import type { EchoInkResource } from "../../resources/types";

export function runHarnessV2MaintenanceResourceProfileTests(): void {
  assertDefaultResourcePreparationRemainsBackwardCompatible();
  assertPromptSkillsCanBeSuppressedWithoutRemovingResources();
  assertMaintenanceProfileExcludesOptionalResources();
  assertIncludeSkillsDominatesPromptSkillInjection();
}

function assertDefaultResourcePreparationRemainsBackwardCompatible(): void {
  const catalog = maintenanceProfileCatalog();
  const capabilities = getAgentBackendDefinition("codex-cli").capabilities;
  const implicitDefaults = prepareAgentResources(catalog, {
    scope: "knowledge",
    backendCapabilities: capabilities
  });
  const explicitDefaults = prepareAgentResources(catalog, {
    scope: "knowledge",
    backendCapabilities: capabilities,
    includeSkills: true,
    includePromptSkills: true
  });

  assert.deepEqual(implicitDefaults, explicitDefaults);
  assert.deepEqual(implicitDefaults.enabledResources.map((resource) => resource.id), [
    "codex-import:skill:answer",
    "echoink-local:tool-bundle:knowledge-base",
    "manual:mcp-server:search"
  ]);
  assert.match(implicitDefaults.promptPrefix, /\/answer: 回答知识库问题/);
}

function assertPromptSkillsCanBeSuppressedWithoutRemovingResources(): void {
  const prepared = prepareAgentResources(maintenanceProfileCatalog(), {
    scope: "knowledge",
    backendCapabilities: getAgentBackendDefinition("codex-cli").capabilities,
    includePromptSkills: false
  });

  assert.equal(prepared.promptPrefix, "");
  assert.equal(
    prepared.enabledResources.some((resource) => resource.id === "codex-import:skill:answer"),
    true,
    "includePromptSkills only controls prompt injection"
  );
}

function assertMaintenanceProfileExcludesOptionalResources(): void {
  const prepared = prepareAgentResources(maintenanceProfileCatalog(), {
    scope: "knowledge",
    backendCapabilities: getAgentBackendDefinition("codex-cli").capabilities,
    ...MAINTENANCE_AGENT_RESOURCE_PROFILE
  });

  assert.equal(prepared.promptPrefix, "");
  assert.deepEqual(prepared.enabledResources, []);
  assert.equal(prepared.mcpConfig, null);
  assert.equal(prepared.toolBridge, null);
  assert.deepEqual(resourceSelectionFromPreparedResources(prepared, "codex-cli", 123).selected, []);
}

function assertIncludeSkillsDominatesPromptSkillInjection(): void {
  const prepared = prepareAgentResources(maintenanceProfileCatalog(), {
    scope: "knowledge",
    backendCapabilities: getAgentBackendDefinition("codex-cli").capabilities,
    includeSkills: false,
    includePromptSkills: true
  });

  assert.equal(prepared.promptPrefix, "");
  assert.equal(prepared.enabledResources.some((resource) => resource.kind === "skill"), false);
}

function maintenanceProfileCatalog(): EchoInkResource[] {
  return [
    {
      id: "codex-import:skill:answer",
      kind: "skill",
      source: "codex-import",
      name: "answer",
      description: "回答知识库问题",
      enabled: true,
      scopes: ["knowledge"],
      bridgeMode: "prompt-only",
      contentPath: "answer"
    },
    {
      id: "echoink-local:tool-bundle:knowledge-base",
      kind: "tool-bundle",
      source: "echoink-local",
      name: "knowledge-base",
      description: "知识库安全工具",
      enabled: true,
      scopes: ["knowledge"],
      bridgeMode: "plugin-tool"
    },
    {
      id: "manual:mcp-server:search",
      kind: "mcp-server",
      source: "manual",
      name: "search",
      description: "知识库搜索",
      enabled: true,
      scopes: ["knowledge"],
      bridgeMode: "structured-tools",
      configPath: "mcp/search.json"
    }
  ];
}
