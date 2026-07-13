import * as assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { parseResourceUri, resourceRefToUri } from "../../harness/resources/resource-ref";
import type { ResourceSelectionSnapshot } from "../../harness/contracts/run";
import { prepareAgentResources, resourceSelectionFromPreparedResources } from "../../resources/registry";
import type { AgentTaskRuntime } from "../../agent/runtime";
import { runKnowledgeAgentTask } from "../../knowledge-base/agent-runner";
import type { HarnessRunWithAdapterInput } from "../../harness/kernel/harness-kernel";
import { getAgentBackendDefinition } from "../../agent/registry";
import { buildCallableMcpToolCatalog } from "../../resources/mcp-tool-catalog";
import { importEchoInkResourceToVault, loadVaultEchoInkResources } from "../../resources/vault-resource-catalog";
import { loadVaultSkill } from "../../harness/resources/skill-loader";
import { resolveResourceContext } from "../../harness/resources/resource-resolver";
import { initializeVaultResourceStore, loadVaultResourceStore } from "../../harness/resources/vault-store";

export async function runHarnessV2ResourceTests(): Promise<void> {
  assertResourceRefNamespacesAreStable();
  await assertVaultSkillLoaderReadsSkillAndReferences();
  await assertVaultSkillLoaderRejectsTraversal();
  await assertVaultResourceStoreSplitsCatalogConnectionBindingPolicy();
  await assertVaultResourceStoreRejectsPlainSecrets();
  await assertVaultResourceStoreFeedsProductionCatalogAndBroker();
  await assertImportToEchoInkCreatesVaultResourcesWithoutSecrets();
  assertPreparedResourcesProduceAuditableSelectionSnapshot();
  assertLocalToolBundlesDoNotBecomeVaultSkillRefs();
  await assertKnowledgeHarnessRequestUsesPreparedResourceSelection();
  await assertResourceResolverLoadsSelectedVaultSkillForAnyBackend();
  await assertResourceResolverSkipsMissingVaultSkillWithWarning();
  await assertResourceResolverDoesNotLeakNativeResourcesAcrossBackends();
}

function assertPreparedResourcesProduceAuditableSelectionSnapshot(): void {
  const selection = resourceSelectionFromPreparedResources({
    promptPrefix: "",
    warnings: ["MCP 已导入但缺少连接配置"],
    mcpConfig: null,
    toolBridge: null,
    enabledResources: [
      {
        id: "echoink-local:skill:product-review",
        kind: "skill",
        source: "echoink-local",
        name: "product-review",
        description: "",
        enabled: true,
        scopes: ["chat"],
        bridgeMode: "prompt-only",
        contentPath: "product-review"
      },
      {
        id: "codex-import:skill:answer",
        kind: "skill",
        source: "codex-import",
        name: "answer",
        description: "",
        enabled: true,
        scopes: ["chat"],
        bridgeMode: "prompt-only"
      },
      {
        id: "hermes-import:mcp-server:browser",
        kind: "mcp-server",
        source: "hermes-import",
        name: "browser",
        description: "",
        enabled: true,
        scopes: ["chat"],
        bridgeMode: "native-mcp"
      },
      {
        id: "opencode-import:mcp-server:reviewer",
        kind: "mcp-server",
        source: "opencode-import",
        name: "reviewer",
        description: "",
        enabled: true,
        scopes: ["chat"],
        bridgeMode: "native-mcp"
      }
    ]
  }, "opencode", 123);

  assert.deepEqual(selection.selected, [
    { plane: "echoink-vault", resourceId: "product-review" },
    { plane: "imported-copy", resourceId: "codex-import:skill:answer" },
    { plane: "agent-native", backendId: "opencode", resourceId: "reviewer" }
  ]);
  assert.deepEqual(selection.warnings, [
    "MCP 已导入但缺少连接配置",
    "资源 browser 属于 hermes 原生资源，当前后端 opencode 不可直接使用。"
  ]);
  assert.equal(selection.resolvedAt, 123);
}

function assertLocalToolBundlesDoNotBecomeVaultSkillRefs(): void {
  const selection = resourceSelectionFromPreparedResources({
    promptPrefix: "",
    warnings: [],
    mcpConfig: null,
    toolBridge: null,
    enabledResources: [
      {
        id: "echoink-local:tool-bundle:knowledge-base",
        kind: "tool-bundle",
        source: "echoink-local",
        name: "knowledge-base",
        description: "Built-in Knowledge tools",
        enabled: true,
        scopes: ["knowledge"],
        bridgeMode: "plugin-tool"
      }
    ]
  }, "codex-cli", 123);

  assert.deepEqual(selection.selected, []);
  assert.deepEqual(selection.warnings, []);
}

async function assertKnowledgeHarnessRequestUsesPreparedResourceSelection(): Promise<void> {
  let captured: HarnessRunWithAdapterInput | null = null;
  const runtime: AgentTaskRuntime = {
    kind: "opencode",
    async connect() {
      return { connected: true, label: "OpenCode", errors: [] };
    },
    async listModels() {
      return [];
    },
    async runTask(input) {
      input.onRunId?.("native-run-1");
      return { text: input.prompt, runId: "native-run-1" };
    },
    async abort() {
      return undefined;
    }
  };

  await runKnowledgeAgentTask(runtime, {
    prompt: "查询知识库",
    workflow: "knowledge.ask",
    outputKind: "plain-text",
    resources: {
      promptPrefix: "",
      warnings: ["MCP 已导入但缺少连接配置"],
      mcpConfig: null,
      toolBridge: null,
      enabledResources: [
        {
          id: "echoink-local:skill:product-review",
          kind: "skill",
          source: "echoink-local",
          name: "product-review",
          description: "",
          enabled: true,
          scopes: ["knowledge"],
          bridgeMode: "prompt-only",
          contentPath: "product-review"
        },
        {
          id: "opencode-import:mcp-server:reviewer",
          kind: "mcp-server",
          source: "opencode-import",
          name: "reviewer",
          description: "",
          enabled: true,
          scopes: ["knowledge"],
          bridgeMode: "native-mcp"
        }
      ]
    }
  }, undefined, {
    vaultPath: "/tmp/echoink-vault",
    sessionId: "knowledge-session",
    async runWithAdapter(input) {
      captured = input;
      return { outputText: "ok" };
    }
  });

  assert.ok(captured);
  assert.deepEqual(captured.request.resourceSelection.selected, [
    { plane: "echoink-vault", resourceId: "product-review" },
    { plane: "agent-native", backendId: "opencode", resourceId: "reviewer" }
  ]);
  assert.deepEqual(captured.request.resourceSelection.warnings, ["MCP 已导入但缺少连接配置"]);
}

function assertResourceRefNamespacesAreStable(): void {
  assert.equal(resourceRefToUri({ plane: "echoink-vault", resourceId: "product-review" }), "echoink://vault/product-review");
  assert.equal(resourceRefToUri({ plane: "echoink-builtin", resourceId: "knowledge.search" }), "echoink://builtin/knowledge.search");
  assert.equal(resourceRefToUri({ plane: "agent-native", backendId: "codex-cli", resourceId: "pdf" }), "native://codex-cli/pdf");

  assert.deepEqual(parseResourceUri("echoink://vault/product-review"), { plane: "echoink-vault", resourceId: "product-review" });
  assert.deepEqual(parseResourceUri("native://hermes/browser"), { plane: "agent-native", backendId: "hermes", resourceId: "browser" });
  assert.throws(() => parseResourceUri("native://browser"), /Invalid native resource URI/);
}

async function assertVaultSkillLoaderReadsSkillAndReferences(): Promise<void> {
  const vaultPath = await mkdtemp(path.join(tmpdir(), "echoink-vault-skill-"));
  const skillRoot = path.join(vaultPath, ".echoink", "resources", "skills", "product-review");
  await mkdir(path.join(skillRoot, "references"), { recursive: true });
  await mkdir(path.join(skillRoot, "templates"), { recursive: true });
  await writeFile(path.join(skillRoot, "SKILL.md"), [
    "---",
    "id: product-review",
    "name: 产品评审",
    "version: 1",
    "description: 对产品方案做结构化评审",
    "scopes:",
    "  - chat",
    "  - knowledge",
    "permissions:",
    "  - vault-read",
    "entry: instruction",
    "---",
    "",
    "# 产品评审",
    "",
    "请按 references/checklist.md 工作。"
  ].join("\n"));
  await writeFile(path.join(skillRoot, "references", "checklist.md"), "- 看目标\n- 看风险\n");
  await writeFile(path.join(skillRoot, "templates", "report.md"), "# 评审报告\n");

  const skill = await loadVaultSkill({ vaultPath, skillId: "product-review", maxBytes: 50_000 });

  assert.equal(skill.ref.plane, "echoink-vault");
  assert.equal(skill.ref.resourceId, "product-review");
  assert.equal(skill.frontmatter.id, "product-review");
  assert.equal(skill.frontmatter.name, "产品评审");
  assert.deepEqual(skill.frontmatter.scopes, ["chat", "knowledge"]);
  assert.match(skill.instruction, /# 产品评审/);
  assert.equal(skill.files.some((file) => file.relativePath === "references/checklist.md" && file.content.includes("看风险")), true);
  assert.equal(skill.contentHash.length, 64);
}

async function assertVaultSkillLoaderRejectsTraversal(): Promise<void> {
  const vaultPath = await mkdtemp(path.join(tmpdir(), "echoink-vault-skill-traversal-"));
  await assert.rejects(
    () => loadVaultSkill({ vaultPath, skillId: "../outside", maxBytes: 50_000 }),
    /Invalid skill id/
  );
}

async function assertVaultResourceStoreSplitsCatalogConnectionBindingPolicy(): Promise<void> {
  const vaultPath = await mkdtemp(path.join(tmpdir(), "echoink-resource-store-"));
  await initializeVaultResourceStore({ vaultPath });
  await createProductReviewSkill(vaultPath);
  await writeFile(path.join(vaultPath, ".echoink", "resources", "mcp", "servers.json"), JSON.stringify({
    servers: {
      github: {
        transport: "http",
        url: "https://mcp.example.test",
        headers: {
          Authorization: "${secret:GITHUB_TOKEN}"
        }
      }
    }
  }, null, 2));
  await writeFile(path.join(vaultPath, ".echoink", "resources", "bindings.json"), JSON.stringify({
    bindings: [
      {
        ref: "echoink://vault/product-review",
        scopes: ["chat", "knowledge"],
        enabled: true
      },
      {
        ref: "echoink://vault/mcp/github",
        scopes: ["chat"],
        enabled: true,
        backendIds: ["codex-cli", "opencode", "hermes"]
      }
    ]
  }, null, 2));
  await writeFile(path.join(vaultPath, ".echoink", "resources", "policies.json"), JSON.stringify({
    policies: {
      "echoink://vault/mcp/github": {
        approval: "ask",
        network: true,
        writeFiles: false,
        maxCallsPerRun: 3,
        timeoutMs: 10000
      }
    }
  }, null, 2));

  const store = await loadVaultResourceStore({ vaultPath, maxSkillBytes: 50_000 });

  assert.equal(store.manifest.version, 1);
  assert.equal(store.catalog.some((item) => item.ref.resourceId === "product-review" && item.kind === "skill"), true);
  assert.equal(store.catalog.some((item) => item.ref.resourceId === "mcp/github" && item.kind === "mcp-server"), true);
  assert.equal(store.connections["echoink://vault/mcp/github"].headers?.Authorization?.type, "secret-ref");
  assert.equal(store.connections["echoink://vault/mcp/github"].headers?.Authorization?.name, "GITHUB_TOKEN");
  assert.equal(store.bindings.some((binding) => binding.ref.resourceId === "product-review" && binding.scopes.includes("knowledge")), true);
  assert.equal(store.policies["echoink://vault/mcp/github"].approval, "ask");
}

async function assertVaultResourceStoreRejectsPlainSecrets(): Promise<void> {
  const vaultPath = await mkdtemp(path.join(tmpdir(), "echoink-resource-store-secret-"));
  await initializeVaultResourceStore({ vaultPath });
  await writeFile(path.join(vaultPath, ".echoink", "resources", "mcp", "servers.json"), JSON.stringify({
    servers: {
      github: {
        transport: "http",
        url: "https://mcp.example.test",
        headers: {
          Authorization: "Bearer ghp_plaintext"
        }
      }
    }
  }, null, 2));

  await assert.rejects(
    () => loadVaultResourceStore({ vaultPath, maxSkillBytes: 50_000 }),
    /Secrets must use/
  );
}

async function assertVaultResourceStoreFeedsProductionCatalogAndBroker(): Promise<void> {
  const vaultPath = await mkdtemp(path.join(tmpdir(), "echoink-vault-resource-runtime-"));
  await initializeVaultResourceStore({ vaultPath });
  await createProductReviewSkill(vaultPath);
  await writeFile(path.join(vaultPath, ".echoink", "resources", "mcp", "servers.json"), JSON.stringify({
    servers: {
      search: {
        transport: "http",
        url: "https://mcp.example.test"
      }
    }
  }, null, 2));
  await writeFile(path.join(vaultPath, ".echoink", "resources", "bindings.json"), JSON.stringify({
    bindings: [
      {
        ref: "echoink://vault/product-review",
        scopes: ["chat", "knowledge", "editor-actions"],
        enabled: true
      },
      {
        ref: "echoink://vault/mcp/search",
        scopes: ["chat", "knowledge", "editor-actions"],
        enabled: true
      }
    ]
  }, null, 2));

  const catalog = await loadVaultEchoInkResources({ vaultPath, maxSkillBytes: 50_000 });
  const prepared = prepareAgentResources(catalog.resources, {
    scope: "chat",
    backendCapabilities: getAgentBackendDefinition("opencode").capabilities
  });
  const selection = resourceSelectionFromPreparedResources(prepared, "opencode", 123);
  const callable = await buildCallableMcpToolCatalog({
    resources: catalog.resources,
    scope: "chat",
    listTools: async () => [{ name: "query", description: "Search vault", inputSchema: { type: "object" } }]
  });

  assert.equal(catalog.resources.some((resource) => resource.kind === "skill" && resource.source === "echoink-local" && resource.contentPath === "product-review"), true);
  assert.equal(catalog.resources.some((resource) => resource.kind === "mcp-server" && resource.source === "echoink-local" && resource.contentPath === "mcp/search"), true);
  assert.deepEqual(selection.selected, [
    { plane: "echoink-vault", resourceId: "product-review" },
    { plane: "echoink-vault", resourceId: "mcp/search" }
  ]);
  assert.deepEqual(callable.tools.map((tool) => [tool.name, tool.resourceId]), [
    ["search.query", "echoink-local:mcp-server:mcp-search"]
  ]);
}

async function assertImportToEchoInkCreatesVaultResourcesWithoutSecrets(): Promise<void> {
  const vaultPath = await mkdtemp(path.join(tmpdir(), "echoink-import-resource-"));
  const skillImport = await importEchoInkResourceToVault({
    vaultPath,
    resource: {
      id: "codex-import:skill:answer",
      kind: "skill",
      source: "codex-import",
      name: "answer",
      description: "回答问题",
      enabled: true,
      scopes: ["chat", "knowledge"],
      bridgeMode: "prompt-only",
      contentPath: "answer"
    }
  });
  const skillText = await readFile(path.join(vaultPath, skillImport.relativePath), "utf8");
  assert.equal(skillImport.uri, "echoink://vault/answer");
  assert.match(skillText, /Imported source: codex-import/);

  await assert.rejects(
    () => importEchoInkResourceToVault({
      vaultPath,
      resource: {
        id: "opencode-import:mcp-server:github",
        kind: "mcp-server",
        source: "opencode-import",
        name: "github",
        description: "",
        enabled: true,
        scopes: ["chat"],
        bridgeMode: "native-mcp"
      }
    }),
    /补全 EchoInk 连接配置/
  );

  const mcpImport = await importEchoInkResourceToVault({
    vaultPath,
    resource: {
      id: "opencode-import:mcp-server:github",
      kind: "mcp-server",
      source: "opencode-import",
      name: "github",
      description: "",
      enabled: true,
      scopes: ["chat", "knowledge"],
      bridgeMode: "native-mcp"
    },
    connection: {
      transport: "http",
      url: "https://mcp.example.test",
      headers: { Authorization: "Bearer should-not-enter-vault" }
    }
  });
  const serversJson = await readFile(path.join(vaultPath, mcpImport.relativePath), "utf8");
  const catalog = await loadVaultEchoInkResources({ vaultPath, maxSkillBytes: 50_000 });
  assert.equal(mcpImport.uri, "echoink://vault/mcp/github");
  assert.doesNotMatch(serversJson, /should-not-enter-vault|Authorization/);
  assert.equal(catalog.resources.some((resource) => resource.source === "echoink-local" && resource.contentPath === "answer"), true);
  assert.equal(catalog.resources.some((resource) => resource.source === "echoink-local" && resource.contentPath === "mcp/github"), true);
}

async function createProductReviewSkill(vaultPath: string): Promise<void> {
  const skillRoot = path.join(vaultPath, ".echoink", "resources", "skills", "product-review");
  await mkdir(skillRoot, { recursive: true });
  await writeFile(path.join(skillRoot, "SKILL.md"), [
    "---",
    "id: product-review",
    "name: 产品评审",
    "version: 1",
    "description: 对产品方案做结构化评审",
    "scopes: [chat, knowledge]",
    "permissions: [vault-read]",
    "entry: instruction",
    "---",
    "",
    "# 产品评审",
    "",
    "看目标、风险和验收。"
  ].join("\n"));
}

async function assertResourceResolverLoadsSelectedVaultSkillForAnyBackend(): Promise<void> {
  const vaultPath = await mkdtemp(path.join(tmpdir(), "echoink-resource-resolver-"));
  await initializeVaultResourceStore({ vaultPath });
  await createProductReviewSkill(vaultPath);
  const selection: ResourceSelectionSnapshot = {
    selected: [{ plane: "echoink-vault", resourceId: "product-review" }],
    resolvedAt: 1,
    warnings: []
  };

  const resolved = await resolveResourceContext({
    workspace: { vaultPath, cwd: vaultPath },
    backendId: "hermes",
    selection,
    maxSkillBytes: 50_000
  });

  assert.equal(resolved.echoInkSkills.length, 1);
  assert.match(resolved.echoInkSkills[0].content, /# 产品评审/);
  assert.match(resolved.echoInkSkills[0].content, /看目标、风险和验收/);
}

async function assertResourceResolverSkipsMissingVaultSkillWithWarning(): Promise<void> {
  const vaultPath = await mkdtemp(path.join(tmpdir(), "echoink-resource-missing-skill-"));
  const selection: ResourceSelectionSnapshot = {
    selected: [{ plane: "echoink-vault", resourceId: "knowledge-base" }],
    resolvedAt: 1,
    warnings: []
  };

  const resolved = await resolveResourceContext({
    workspace: { vaultPath, cwd: vaultPath },
    backendId: "codex-cli",
    selection,
    maxSkillBytes: 50_000
  });

  assert.equal(resolved.echoInkSkills.length, 0);
  assert.equal(resolved.warnings.some((warning) => warning.includes("knowledge-base") && warning.includes("missing")), true);
}

async function assertResourceResolverDoesNotLeakNativeResourcesAcrossBackends(): Promise<void> {
  const vaultPath = await mkdtemp(path.join(tmpdir(), "echoink-resource-native-"));
  const selection: ResourceSelectionSnapshot = {
    selected: [
      { plane: "agent-native", backendId: "hermes", resourceId: "browser" },
      { plane: "agent-native", backendId: "opencode", resourceId: "reviewer" }
    ],
    resolvedAt: 1,
    warnings: []
  };

  const resolved = await resolveResourceContext({
    workspace: { vaultPath, cwd: vaultPath },
    backendId: "opencode",
    selection,
    maxSkillBytes: 50_000
  });

  assert.equal(resolved.nativeResourceHints.length, 1);
  assert.match(resolved.nativeResourceHints[0].content, /native:\/\/opencode\/reviewer/);
  assert.equal(resolved.nativeResourceHints.some((section) => section.content.includes("native://hermes/browser")), false);
  assert.equal(resolved.warnings.some((warning) => warning.includes("native://hermes/browser")), true);
}
