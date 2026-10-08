import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { RequestUrlParam, RequestUrlResponse } from "obsidian";
import { setRequestUrlForTests } from "./obsidian-shim";
import {
  mcpToolContractFingerprint,
  normalizeMcpConnectionRecord
} from "../resources/mcp-connections";
import {
  buildCallableMcpToolCatalog,
  inspectMcpToolList
} from "../resources/mcp-tool-catalog";
import { buildActiveEchoInkResourceCatalog } from "../resources/registry";
import {
  ensureVaultBindingForImportedResource,
  importEchoInkResourceToVault,
  loadVaultEchoInkResources
} from "../resources/vault-resource-catalog";
import { EchoInkResourceCatalogService } from "../plugin/resource-catalog-service";
import { EchoInkMcpSettingsService } from "../plugin/mcp-settings-service";
import { EchoInkMcpBrokerService } from "../resources/mcp-broker-service";
import { closeMcpBrokerConnectionPool, EchoInkMcpBroker, EchoInkMcpBrokerError } from "../resources/mcp-broker";
import { recoverProductionPiMcpDomainReceipts } from "../plugin/pi-production-runtime-composition";
import { FileDomainReceiptStore } from "../harness/pi-native/domain-receipt-store";
import {
  createPiMcpToolSecurity,
  type PiMcpApprovalConfirmationInput
} from "../harness/pi-native/pi-mcp-tool-security";
import {
  FileApprovalTicketStore,
  approvalContractFromTicket,
  createMcpApprovalToolId
} from "../harness/pi-native/tool-authorization";
import { PiAgentApprovalBroker } from "../plugin/pi-agent-approval-broker";
import {
  ResourceMutationError,
  runResourceMutationWithReload
} from "../plugin/resource-mutation-authority";
import { isMissingFileSystemError } from "../harness/resources/vault-store";
import type {
  EchoInkMcpConnectionRecord,
  EchoInkResource,
  EchoInkResourceSettings
} from "../resources/types";

export async function runMcpToolSecurityTests(): Promise<void> {
  await assertHttpMcpTransportLifecycle();
  await assertSharedHttpInitializationWaiterCancellation();
  assertSavedGlobalResourceStateOverridesRuntimeDiscovery();
  await assertResourceCatalogServiceDistinguishesFailureFromDeletion();
  await assertResourceCatalogPersistenceReadbackConsistency();
  await assertResourceCatalogPreservesConcurrentUserChanges();
  await assertResourceMutationReloadBarrier();
  await assertProductionMcpReceiptRecoveryDoesNotReenterResourceLane();
  await assertResourceMutationUnknownFreezesLane();
  await assertVaultBindingMigrationIsSafe();
  await assertBlankSkillImportDoesNotOverwrite();
  await assertBlankMcpImportDoesNotOverwrite();
  assertMissingTrustFailsClosed();
  await assertExplicitTrustAndPolicyAreRequired();
  await assertChangedContractRequiresRetrust();
  await assertMcpAgentApprovalUsesExistingTicketChain();
}

async function assertSharedHttpInitializationWaiterCancellation(): Promise<void> {
  for (const operation of ["list", "call"] as const) {
    const methods: string[] = [];
    let releaseInitialize!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    await withHttpMcpFixture((_request, message) => {
      methods.push(message.method);
      if (message.method === "initialize") {
        return new Promise<RequestUrlResponse>((resolve) => {
          releaseInitialize = () => resolve(httpMcpResponse('{"result":{}}'));
          markStarted();
        });
      }
      return message.method === "notifications/initialized"
        ? httpMcpResponse("", 202)
        : httpMcpResponse('{"result":{"tools":[]}}');
    }, async (broker, resource) => {
      const first = broker.listTools(resource, 1000);
      await started;
      const controller = new AbortController();
      const second = operation === "list"
        ? broker.listTools(resource, 1000, controller.signal)
        : broker.callTool({ resource, toolName: "write_item", timeoutMs: 1000, signal: controller.signal });
      const cancelled = assert.rejects(second, { name: "AbortError" });
      // Let the second call enter the pool wait before cancelling its own signal.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      controller.abort();
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          cancelled,
          new Promise<never>((_resolve, reject) => {
            deadline = setTimeout(() => reject(new Error("shared initialization waiter did not cancel promptly")), 100);
          })
        ]);
        assert.deepEqual(methods, ["initialize"], "cancelled waiter must not initialize or call tools");
      } finally {
        clearTimeout(deadline);
        releaseInitialize();
        await Promise.allSettled([first, cancelled]);
      }
      assert.deepEqual(await first, { tools: [] }, "cancelling another waiter must preserve the first caller");
      assert.deepEqual(await broker.listTools(resource), { tools: [] }, "the surviving connection remains reusable");
      assert.deepEqual(methods, ["initialize", "notifications/initialized", "tools/list", "tools/list"]);
    });
  }
}

function httpMcpResponse(text: string, status = 200, headers: Record<string, string> = {}): RequestUrlResponse {
  return { status, headers, text, arrayBuffer: new ArrayBuffer(0), json: undefined };
}

async function withHttpMcpFixture(
  handler: (request: RequestUrlParam, message: { method: string; id?: number; params?: unknown }) => RequestUrlResponse | Promise<RequestUrlResponse>,
  run: (broker: EchoInkMcpBroker, resource: EchoInkResource) => Promise<void>
): Promise<void> {
  await closeMcpBrokerConnectionPool();
  const restore = setRequestUrlForTests((request) => {
    assert.ok(typeof request !== "string");
    assert.equal(request.method, "POST");
    assert.equal(request.throw, false, "HTTP errors must reach the broker's safe error mapping");
    assert.equal(request.headers?.Authorization, "Bearer fixture");
    return handler(request, JSON.parse(String(request.body)));
  });
  const resource = mcpResource();
  const broker = new EchoInkMcpBroker({ connections: {
    [resource.id]: normalizeMcpConnectionRecord({
      transport: "http", url: "https://example.invalid/mcp", headers: { Authorization: "Bearer fixture" }
    })!
  } });
  try {
    await run(broker, resource);
  } finally {
    await closeMcpBrokerConnectionPool();
    restore();
  }
}

async function assertHttpMcpTransportLifecycle(): Promise<void> {
  const methods: string[] = [];
  await withHttpMcpFixture((request, message) => {
    methods.push(message.method);
    if (message.method === "initialize") {
      assert.equal(request.headers?.["Mcp-Session-Id"], undefined);
      return httpMcpResponse('{"jsonrpc":"2.0","result":{}}', 200, { "MCP-Session-Id": "fixture-session" });
    }
    assert.equal(request.headers?.["Mcp-Session-Id"], "fixture-session");
    if (message.method === "notifications/initialized") {
      assert.equal(message.id, undefined);
      return httpMcpResponse("", 202);
    }
    if (message.method === "tools/list") return httpMcpResponse('{"result":{"tools":[]}}');
    assert.deepEqual(message.params, { name: "write_item", arguments: { id: "sample" } });
    return httpMcpResponse('event: message\ndata: {"result":{"ok":true}}\n\ndata: [DONE]\n', 200, { "Content-Type": "text/event-stream" });
  }, async (broker, resource) => {
    assert.deepEqual(await broker.listTools(resource), { tools: [] });
    assert.deepEqual(await broker.callTool({ resource, toolName: "write_item", arguments: { id: "sample" } }), { content: { ok: true } });
  });
  assert.deepEqual(methods, ["initialize", "notifications/initialized", "tools/list", "tools/call"]);

  for (const [response, code] of [
    [httpMcpResponse("", 401), "authentication_failed"],
    [httpMcpResponse("", 403), "authentication_failed"],
    [httpMcpResponse("", 503), "connection_failed"],
    [httpMcpResponse("not json"), "schema_invalid"],
    [httpMcpResponse("") , "schema_invalid"],
    [httpMcpResponse("event: message\n", 200, { "content-type": "text/event-stream" }), "schema_invalid"],
    [httpMcpResponse('{"result":{}}', 200, { "mcp-session-id": "invalid\nsession" }), "schema_invalid"],
    [httpMcpResponse('{"error":{"message":"tool failed"}}'), "call_failed"]
  ] as const) {
    await withHttpMcpFixture(() => response, async (broker, resource) => {
      await assert.rejects(broker.listTools(resource), (error: unknown) => error instanceof EchoInkMcpBrokerError && error.code === code);
    });
  }

  let requests = 0;
  await withHttpMcpFixture(() => { requests++; return httpMcpResponse("{}"); }, async (broker, resource) => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(broker.listTools(resource, 1000, controller.signal), { name: "AbortError" });
  });
  assert.equal(requests, 0, "an already cancelled call must not send any HTTP request");

  // Exercise each awaited HTTP step. Settling the physical request after cancellation
  // must neither continue initialization nor replay a possibly mutating tool call.
  for (const method of ["initialize", "notifications/initialized", "tools/call"]) {
    for (const ending of ["abort-success", "abort-failure", "timeout"] as const) {
      const observed: Array<{ method: string; session?: string }> = [];
      let settleLate!: () => void;
      let markStarted!: () => void;
      const started = new Promise<void>((resolve) => { markStarted = resolve; });
      let block = true;
      await withHttpMcpFixture((request, message) => {
        observed.push({ method: message.method, session: request.headers?.["Mcp-Session-Id"] });
        if (message.method === method && block) {
          block = false;
          return new Promise<RequestUrlResponse>((resolve, reject) => {
            settleLate = () => ending === "abort-failure"
              ? reject(new Error("late network failure"))
              : resolve(httpMcpResponse('{"result":{}}', 200, { "mcp-session-id": "late-session" }));
            markStarted();
          });
        }
        return message.method === "notifications/initialized"
          ? httpMcpResponse("", 202)
          : httpMcpResponse('{"result":{"tools":[]}}');
      }, async (broker, resource) => {
        const controller = new AbortController();
        const failed = assert.rejects(broker.callTool({
          resource, toolName: "write_item", timeoutMs: ending === "timeout" ? 20 : 1000, signal: controller.signal
        }), (error: unknown) => ending === "timeout"
          ? error instanceof EchoInkMcpBrokerError && error.code === "timeout"
          : error instanceof Error && error.name === "AbortError");
        await started;
        if (ending !== "timeout") controller.abort();
        await failed;
        const requestCount = observed.length;
        settleLate();
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        assert.equal(observed.length, requestCount, "late replies must not continue or retry a cancelled operation");
        await broker.listTools(resource);
        assert.equal(observed[requestCount].method, "initialize", "the next explicit call gets a fresh connection");
        assert.equal(observed.slice(requestCount).some((request) => request.session === "late-session"), false);
      });
    }
  }
}

async function assertMcpAgentApprovalUsesExistingTicketChain(): Promise<void> {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), "echoink-mcp-agent-approval-test-"));
  try {
    const vaultId = "mcp-agent-approval-vault";
    const clock = 1_800_000_000_000;
    const approvals = new FileApprovalTicketStore({
      storageRootPath: rootPath,
      vaultId,
      now: () => clock
    });
    const receipts = new FileDomainReceiptStore({ storageRootPath: rootPath, vaultId });
    await Promise.all([approvals.initialize(), receipts.initialize()]);
    const broker = new PiAgentApprovalBroker();
    const executionContext = Object.freeze({
      conversationId: "conversation-mcp-agent-approval",
      piSessionId: "pi-session-mcp-agent-approval",
      productRunId: "product-run-mcp-agent-approval",
      vaultId
    });
    const resourceId = "manual:mcp-server:agent-approval";
    const descriptor = Object.freeze({
      name: "echoink_mcp_agent_approval_write",
      resourceId,
      resourceName: "Agent Approval MCP",
      toolName: "write_item",
      readOnly: false,
      destructive: true,
      approvalToolId: createMcpApprovalToolId({
        resourceId,
        toolName: "write_item"
      }),
      contractFingerprint: `sha256:${"a".repeat(64)}`
    });
    const confirmationRequests: PiMcpApprovalConfirmationInput[] = [];
    const security = createPiMcpToolSecurity({
      tools: [descriptor],
      currentExecutionContext: () => executionContext,
      isToolAllowed: async () => true,
      approvals,
      receipts,
      userId: "user-mcp-agent-approval",
      deviceId: "device-mcp-agent-approval",
      now: () => clock,
      confirmation: {
        async confirm(request) {
          confirmationRequests.push(request);
          return await broker.waitForDecision({
            requestId: request.requestId,
            conversationId: request.conversationId,
            piSessionId: request.piSessionId,
            productRunId: request.productRunId,
            toolCallId: request.toolCallId,
            target: JSON.stringify(request.target),
            preview: JSON.stringify(request.preview),
            signal: request.signal
          });
        }
      }
    });
    const identityFor = (toolCallId: string) => ({
      conversationId: executionContext.conversationId,
      piSessionId: executionContext.piSessionId,
      productRunId: executionContext.productRunId,
      toolCallId
    });
    const toolEvent = (toolCallId: string) => ({
      toolName: descriptor.name,
      toolCallId,
      input: { id: toolCallId }
    });

    const approvedEvent = toolEvent("mcp-call-approved");
    const approvedCall = security.handleToolCall(approvedEvent as never, undefined);
    const approvedBinding = await waitForMcpApprovalBinding(
      broker,
      identityFor(approvedEvent.toolCallId)
    );
    assert.equal(approvedBinding.decide("approve"), true);
    assert.equal(await approvedCall, undefined);
    const approvedTicket = await approvals.get(
      executionContext.productRunId,
      approvedEvent.toolCallId
    );
    assert.equal(approvedTicket?.status, "approved");
    assert.equal(
      (await receipts.readOperation(
        approvedTicket!.ticket.operationIdentity
      ))?.effectState,
      "authorized",
      "MCP approve continues through Ticket consume and the existing Receipt journal"
    );

    const deniedEvent = toolEvent("mcp-call-denied");
    const deniedCall = security.handleToolCall(deniedEvent as never, undefined);
    const deniedBinding = await waitForMcpApprovalBinding(
      broker,
      identityFor(deniedEvent.toolCallId)
    );
    assert.equal(deniedBinding.decide("reject"), true);
    assert.deepEqual(await deniedCall, { block: true, reason: "approval_denied" });
    const deniedTicket = await approvals.get(
      executionContext.productRunId,
      deniedEvent.toolCallId
    );
    assert.equal(deniedTicket?.status, "denied");
    assert.equal(
      await receipts.readOperation(deniedTicket!.ticket.operationIdentity),
      null,
      "MCP reject resolves the Ticket without starting a Receipt operation");

    assert.deepEqual(
      confirmationRequests.map((request) => ({
        conversationId: request.conversationId,
        piSessionId: request.piSessionId,
        productRunId: request.productRunId,
        toolCallId: request.toolCallId
      })),
      [approvedEvent.toolCallId, deniedEvent.toolCallId].map(identityFor),
      "MCP confirmation receives the exact Conversation, Pi session, run, and Tool Call identity"
    );
    assert.ok(confirmationRequests.every((request) => request.requestId.trim()));
    assert.deepEqual(confirmationRequests[0]?.target, {
      kind: "mcp_tool",
      resourceId,
      resourceName: descriptor.resourceName,
      toolName: descriptor.toolName
    });
    assert.deepEqual(confirmationRequests[0]?.preview, {
      server: descriptor.resourceName,
      tool: descriptor.toolName,
      destructive: true,
      arguments: { id: approvedEvent.toolCallId }
    });
    broker.dispose();
  } finally {
    await rm(rootPath, { recursive: true, force: true });
  }
}

async function waitForMcpApprovalBinding(
  broker: PiAgentApprovalBroker,
  identity: Readonly<{
    conversationId: string;
    piSessionId: string;
    productRunId: string;
    toolCallId: string;
  }>
) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const binding = broker.bindingFor(identity);
    if (binding) return binding;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Timed out waiting for MCP Agent Approval binding");
}

async function assertProductionMcpReceiptRecoveryDoesNotReenterResourceLane(): Promise<void> {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), "echoink-mcp-recovery-lane-test-"));
  try {
    await closeMcpBrokerConnectionPool();
    const vaultId = "mcp-recovery-vault";
    const receipts = new FileDomainReceiptStore({ storageRootPath: rootPath, vaultId });
    const approvals = new FileApprovalTicketStore({ storageRootPath: rootPath, vaultId });
    await Promise.all([receipts.initialize(), approvals.initialize()]);
    const resource = mcpResource({
      id: "manual:mcp-server:recovery-lane",
      source: "manual",
      enabled: false
    });
    const tool = {
      name: "get_item",
      description: "Read back one item",
      readOnly: true,
      destructive: false,
      inputSchema: { type: "object", properties: { id: { type: "string" } } }
    };
    const settings = { resources: resourceSettings([resource]) };
    const persistedCredentialRef = `cred-${"a".repeat(32)}`;
    settings.resources.mcpConnections[resource.id] = {
      transport: "stdio",
      command: "persisted-fixture",
      trusted: true,
      toolPolicies: { [tool.name]: { enabled: true, trusted: true } },
      tools: [tool],
      credential: {
        credentialRef: persistedCredentialRef,
        purpose: "mcp_env",
        targetName: "PERSISTED_TOKEN",
        endpointRevision: 1
      }
    };
    let persistedResources = structuredClone(settings.resources);
    const issuedAt = Date.now();
    const ticket = await approvals.issue({
      productRunId: "mcp-recovery-run",
      toolCallId: "mcp-recovery-call",
      conversationId: "mcp-recovery-conversation",
      piSessionId: "mcp-recovery-session",
      userId: "mcp-recovery-user",
      vaultId,
      deviceId: "mcp-recovery-device",
      toolId: createMcpApprovalToolId({
        resourceId: resource.id,
        toolName: "write_item"
      }),
      toolVersion: "tool-v1",
      policyVersion: "policy-v1",
      normalizedArguments: { id: "fixture" },
      resolvedTarget: { resourceId: resource.id },
      targetVersion: {
        readbackRequired: true,
        readbackContract: {
          toolName: tool.name,
          argumentMap: { id: "id" },
          assertions: [{ resultPath: "item.id", argumentKey: "id" }]
        },
        readbackArguments: { id: "fixture" },
        assertionArguments: { id: "fixture" }
      },
      preview: { effect: "fixture" },
      issuedAt,
      expiresAt: issuedAt + 60_000
    });
    const authorization = await approvals.consume({
      ticketId: ticket.ticketId,
      operationIdentity: ticket.operationIdentity,
      contract: approvalContractFromTicket(ticket)
    });
    const operation = await receipts.beginAuthorizedOperation(authorization);
    await receipts.markEffectStarted(operation.operationIdentity);

    let persistedCatalogReads = 0;
    let runtimeScans = 0;
    let readbackCalls = 0;
    let credentialResolveCalls = 0;
    let transportFactoryCalls = 0;
    let observedTransportConfig: unknown = null;
    const observedTransportRequests: Array<{
      method: string;
      params: unknown;
    }> = [];
    const observedTransportNotifications: string[] = [];
    let reloads = 0;
    let recoveryActive = false;
    const plugin = resourceHost({
      app: { secretStorage: {} },
      settings,
      getVaultPath: () => rootPath,
      saveSettings: async () => {
        persistedResources = structuredClone(settings.resources);
      },
      buildRuntimeEchoInkResourceCatalog: async () => {
        runtimeScans += 1;
        if (recoveryActive) {
          throw new Error("resource discovery must not run during Receipt recovery");
        }
        return structuredClone(settings.resources.catalog);
      },
      callEchoInkMcpTool: async () => {
        throw new Error("ordinary MCP call must not run during Receipt recovery");
      },
      listEchoInkMcpTools: async () => [],
      reloadPiProductionRuntime: async () => {
        reloads += 1;
        const liveCandidate = structuredClone(settings.resources);
        if (reloads === 1) {
          settings.resources.catalog[0]!.enabled = false;
          settings.resources.mcpConnections[resource.id] = {
            transport: "stdio",
            command: "live-conflict",
            trusted: false,
            toolPolicies: { [tool.name]: { enabled: false, trusted: false } },
            tools: [{ ...tool, readOnly: false }],
            credential: {
              credentialRef: "live-conflict-credential-ref",
              purpose: "mcp_env",
              targetName: "LIVE_CONFLICT_TOKEN",
              endpointRevision: 99
            }
          };
        }
        recoveryActive = true;
        try {
          await recoverProductionPiMcpDomainReceipts(plugin as never, receipts);
        } finally {
          recoveryActive = false;
          settings.resources = liveCandidate;
        }
      }
    });
    const recoveryBroker = new EchoInkMcpBrokerService(plugin as never, {
      credentialResolver: async (resolvedResource, connection) => {
        credentialResolveCalls += 1;
        assert.equal(resolvedResource.id, resource.id);
        assert.equal(resolvedResource.enabled, true);
        assert.equal(connection.command, "persisted-fixture");
        assert.equal(connection.trusted, true);
        assert.deepEqual(connection.toolPolicies[tool.name], {
          enabled: true,
          trusted: true
        });
        assert.deepEqual(connection.credential, {
          credentialRef: persistedCredentialRef,
          purpose: "mcp_env",
          targetName: "PERSISTED_TOKEN",
          endpointRevision: 1
        });
        assert.notEqual(
          connection.credential?.credentialRef,
          settings.resources.mcpConnections[resource.id]?.credential?.credentialRef
        );
        return "persisted-secret";
      },
      transportFactory: async (config) => {
        transportFactoryCalls += 1;
        observedTransportConfig = structuredClone(config);
        return {
          request: async (method, params) => {
            observedTransportRequests.push({
              method,
              params: structuredClone(params ?? {})
            });
            if (method === "initialize") return {};
            readbackCalls += 1;
            return { item: { id: "fixture" } };
          },
          notify: async (method) => {
            observedTransportNotifications.push(method);
          },
          close: async () => undefined
        };
      }
    });
    let recoverySnapshot: EchoInkResourceSettings | null = null;
    Object.assign(plugin, {
      readPersistedEchoInkResourceSnapshot: async () => {
        persistedCatalogReads += 1;
        recoverySnapshot = structuredClone(persistedResources);
        return recoverySnapshot;
      },
      callEchoInkMcpToolFromResourceSnapshot: async (
        input: Parameters<EchoInkMcpBrokerService["callToolFromResourceSnapshot"]>[0],
        snapshot: EchoInkResourceSettings
      ) => await recoveryBroker.callToolFromResourceSnapshot(input, snapshot)
    });
    const service = new EchoInkMcpSettingsService(plugin as never);
    await Promise.race([
      service.setServerEnabled(resource.id, true),
      new Promise<never>((_, reject) => setTimeout(
        () => reject(new Error("production MCP recovery re-entered resource mutation lane")),
        1_000
      ))
    ]);
    assert.equal(reloads, 1);
    assert.equal(persistedCatalogReads, 1);
    assert.equal(runtimeScans, 0);
    assert.equal(credentialResolveCalls, 1);
    assert.equal(transportFactoryCalls, 1);
    assert.equal(readbackCalls, 1);
    assert.deepEqual(observedTransportConfig, {
      transport: "stdio",
      command: "persisted-fixture",
      args: undefined,
      cwd: undefined,
      env: { PERSISTED_TOKEN: "persisted-secret" }
    });
    assert.deepEqual(
      observedTransportRequests.map((request) => request.method),
      ["initialize", "tools/call"]
    );
    assert.deepEqual(observedTransportRequests[1]?.params, {
      name: tool.name,
      arguments: { id: "fixture" }
    });
    assert.deepEqual(observedTransportNotifications, ["notifications/initialized"]);
    assert.equal((await receipts.inspectRecovery(operation.operationIdentity)).state, "receipt_present");
    const receipt = await receipts.readReceipt(operation.operationIdentity);
    assert.ok(receipt);
    assert.equal(receipt.status, "completed");
    assert.equal(receipt.readback.readbackVerified, true);

    const ordinaryCatalog = await plugin.buildRuntimeEchoInkResourceCatalog();
    assert.equal(ordinaryCatalog[0]?.id, resource.id);
    await service.setServerTrusted(resource.id, false);
    assert.equal(runtimeScans, 1, "normal resource discovery must remain available after recovery");
    assert.equal(reloads, 2, "a later resource mutation must still own and complete reload");
  } finally {
    await closeMcpBrokerConnectionPool();
    await rm(rootPath, { recursive: true, force: true });
  }
}

async function assertResourceCatalogServiceDistinguishesFailureFromDeletion(): Promise<void> {
  const vault = await mkdtemp(path.join(os.tmpdir(), "echoink-catalog-service-test-"));
  try {
    const skillRoot = path.join(vault, ".echoink/resources/skills/last-known");
    const mcpRoot = path.join(vault, ".echoink/resources/mcp");
    await mkdir(skillRoot, { recursive: true });
    await mkdir(mcpRoot, { recursive: true });
    await writeFile(path.join(skillRoot, "SKILL.md"), [
      "---", "id: last-known", "name: Last known Skill", "version: 1",
      "description: fixture", "permissions: []", "entry: instruction",
      "---", "", "# Last known"
    ].join("\n"), "utf8");
    await writeFile(path.join(mcpRoot, "servers.json"), '{"servers":{}}\n', "utf8");
    await mkdir(path.join(vault, ".echoink/resources/skills/missing-entry"), {
      recursive: true
    });
    const savedSkill = skillResource({
      id: "echoink-local:skill:last-known",
      name: "Last known Skill"
    });
    const savedMcp = mcpResource({
      id: "echoink-local:mcp-server:last-known",
      name: "Last known MCP"
    });
    const manual = skillResource({
      id: "manual:skill:retained",
      source: "manual",
      name: "Retained manual Skill"
    });
    const resources = {
      catalog: [savedMcp, manual],
      legacyEnabledOverrides: { [savedSkill.id]: false },
      importedFrom: {},
      mcpConnections: {},
      lastScannedAt: 0,
      lastError: ""
    };
    const persistedCatalogs: EchoInkResource[][] = [];
    const persistedLegacyOverrides: Array<Record<string, boolean> | undefined> = [];
    const service = new EchoInkResourceCatalogService(resourceHost({
      getVaultPath: () => vault,
      settings: { resources },
      saveSettings: async () => {
        persistedCatalogs.push(structuredClone(resources.catalog));
        persistedLegacyOverrides.push(resources.legacyEnabledOverrides
          ? structuredClone(resources.legacyEnabledOverrides)
          : undefined);
      }
    }) as never);

    const firstSuccessfulCatalog = await service.buildRuntimeCatalog();
    assert.deepEqual(
      firstSuccessfulCatalog.map((resource) => resource.id).sort(),
      [manual.id, savedSkill.id].sort()
    );
    assert.deepEqual(
      resources.catalog.map((resource) => resource.id).sort(),
      [manual.id, savedSkill.id].sort()
    );
    assert.equal(resources.catalog.find((resource) => resource.id === savedSkill.id)?.enabled, false);
    assert.equal(Object.hasOwn(resources, "legacyEnabledOverrides"), false);
    assert.deepEqual(persistedCatalogs.at(-1), resources.catalog);
    assert.equal(persistedLegacyOverrides.at(-1), undefined);

    await rm(skillRoot, { recursive: true, force: true });
    const successfulEmptyCatalog = await service.buildRuntimeCatalog();
    assert.deepEqual(successfulEmptyCatalog.map((resource) => resource.id), [manual.id]);
    assert.deepEqual(resources.catalog.map((resource) => resource.id), [manual.id]);
    assert.equal(resources.lastError, "");
    const successfulSnapshotSaves = persistedCatalogs.length;
    const successfulScanAt = resources.lastScannedAt;

    for (const invalidEmptyJson of ["", "  \n\t"]) {
      await writeFile(path.join(mcpRoot, "servers.json"), invalidEmptyJson, "utf8");
      const failedEmptyJson = await service.buildRuntimeCatalog();
      assert.deepEqual(failedEmptyJson.map((resource) => resource.id), [manual.id]);
      assert.deepEqual(resources.catalog.map((resource) => resource.id), [manual.id]);
      assert.notEqual(resources.lastError, "");
      assert.equal(persistedCatalogs.length, successfulSnapshotSaves);
      assert.equal(resources.lastScannedAt, successfulScanAt);
    }

    await writeFile(path.join(mcpRoot, "servers.json"), "{ invalid json", "utf8");
    const failedAfterDeletion = await service.buildRuntimeCatalog();
    assert.deepEqual(failedAfterDeletion.map((resource) => resource.id), [manual.id]);
    assert.deepEqual(resources.catalog.map((resource) => resource.id), [manual.id]);
    assert.notEqual(resources.lastError, "");
    assert.equal(persistedCatalogs.length, successfulSnapshotSaves);
    assert.equal(resources.lastScannedAt, successfulScanAt);

    await writeFile(path.join(mcpRoot, "servers.json"), '{"servers":{}}\n', "utf8");
    const skillsPath = path.join(vault, ".echoink/resources/skills");
    await rm(skillsPath, { recursive: true, force: true });
    await writeFile(skillsPath, "not a directory", "utf8");
    const ioFailure = await service.buildRuntimeCatalog();
    assert.deepEqual(ioFailure.map((resource) => resource.id), [manual.id]);
    assert.notEqual(resources.lastError, "");
    assert.equal(persistedCatalogs.length, successfulSnapshotSaves);
    assert.equal(resources.lastScannedAt, successfulScanAt);
    assert.equal(isMissingFileSystemError({ code: "ENOENT" }), true);
    assert.equal(isMissingFileSystemError({ code: "EACCES" }), false);
    assert.equal(isMissingFileSystemError({ code: "EIO" }), false);
  } finally {
    await rm(vault, { recursive: true, force: true });
  }
}

async function assertResourceCatalogPersistenceReadbackConsistency(): Promise<void> {
  const vault = await mkdtemp(path.join(os.tmpdir(), "echoink-catalog-persistence-test-"));
  try {
    const mcpRoot = path.join(vault, ".echoink/resources/mcp");
    await mkdir(path.join(vault, ".echoink/resources/skills"), { recursive: true });
    await mkdir(mcpRoot, { recursive: true });
    await writeFile(path.join(mcpRoot, "servers.json"), '{"servers":{}}\n', "utf8");
    const stale = skillResource({
      id: "echoink-local:skill:confirmed-deleted",
      name: "Confirmed deleted"
    });
    const manual = skillResource({
      id: "manual:skill:persisted",
      source: "manual",
      name: "Persisted manual"
    });

    for (const outcome of ["committed-before-throw", "unknown-readback"] as const) {
      const resources = {
        catalog: [stale, manual],
        legacyEnabledOverrides: {},
        importedFrom: {},
        mcpConnections: {},
        lastScannedAt: 0,
        lastError: ""
      };
      const plugin = resourceHost({
        settings: { resources },
        getVaultPath: () => vault,
        saveSettings: async () => {
          if (outcome === "committed-before-throw") return;
          const persistedSettings = {
            resources: {
              ...structuredClone(resources),
              catalog: resources.catalog.filter((resource) =>
                resource.source !== "echoink-local"),
              lastScannedAt: resources.lastScannedAt + 1
            }
          };
          throw Object.assign(new Error(outcome), {
            persistenceStatus: "unknown",
            persistedSettings
          });
        }
      });
      const service = new EchoInkResourceCatalogService(plugin as never);

      let catalog: EchoInkResource[] = [];
      if (outcome === "committed-before-throw") {
        catalog = await service.buildRuntimeCatalog();
      } else {
        await assert.rejects(
          service.buildRuntimeCatalog(),
          (error: unknown) => error instanceof ResourceMutationError
            && !error.rollbackSafe
            && error.authorityKnown
        );
        catalog = plugin.settings.resources.catalog;
        await assert.rejects(service.buildRuntimeCatalog(), ResourceMutationError);
      }
      assert.equal(catalog.some((resource) => resource.id === stale.id), false);
      assert.equal(plugin.settings.resources.catalog.some((resource) =>
        resource.id === stale.id), false);
      assert.deepEqual(
        plugin.settings.resources.catalog,
        resources.catalog
      );
    }
  } finally {
    await rm(vault, { recursive: true, force: true });
  }
}

async function assertResourceCatalogPreservesConcurrentUserChanges(): Promise<void> {
  const vault = await mkdtemp(path.join(os.tmpdir(), "echoink-catalog-concurrency-test-"));
  try {
    const skillRoot = path.join(vault, ".echoink/resources/skills/concurrent");
    const mcpRoot = path.join(vault, ".echoink/resources/mcp");
    await mkdir(skillRoot, { recursive: true });
    await mkdir(mcpRoot, { recursive: true });
    await writeFile(path.join(skillRoot, "SKILL.md"), [
      "---", "id: concurrent", "name: Concurrent Skill", "version: 1",
      "description: fixture", "permissions: []", "entry: instruction",
      "---", "", "# Concurrent"
    ].join("\n"), "utf8");
    await writeFile(path.join(mcpRoot, "servers.json"), '{"servers":{}}\n', "utf8");
    const scanned = skillResource({
      id: "echoink-local:skill:concurrent",
      name: "Old scan snapshot"
    });
    const resources = {
      catalog: [scanned],
      legacyEnabledOverrides: {},
      importedFrom: {},
      mcpConnections: {},
      lastScannedAt: 0,
      lastError: ""
    };
    const service = new EchoInkResourceCatalogService(resourceHost({
      getVaultPath: () => vault,
      settings: { resources },
      saveSettings: async () => undefined
    }) as never);

    const scan = service.buildRuntimeCatalog();
    resources.catalog[0]!.enabled = false;
    const concurrentManual = skillResource({
      id: "manual:skill:added-during-scan",
      source: "manual",
      name: "Added during scan"
    });
    resources.catalog.push(concurrentManual);
    const catalog = await scan;
    assert.equal(catalog.find((resource) => resource.id === scanned.id)?.enabled, false);
    assert.equal(resources.catalog.find((resource) =>
      resource.id === scanned.id)?.enabled, false);
    assert.equal(resources.catalog.some((resource) =>
      resource.id === concurrentManual.id), true);
  } finally {
    await rm(vault, { recursive: true, force: true });
  }
}

async function assertResourceMutationReloadBarrier(): Promise<void> {
  const resource = mcpResource({ id: "manual:mcp-server:barrier", source: "manual" });
  const settings = { resources: resourceSettings([resource]) };
  settings.resources.mcpConnections[resource.id] = {
    transport: "stdio",
    command: "fixture",
    trusted: false,
    toolPolicies: {},
    tools: []
  };
  let persisted = structuredClone(settings);
  const plugin = resourceHost({
    settings,
    saveSettings: async () => {
      persisted = structuredClone(settings);
    }
  });
  const firstReload = deferred<void>();
  let reloadCount = 0;
  const mutate = async (action: () => void): Promise<void> => {
    await plugin.withEchoInkResourceMutation(async () =>
      await runResourceMutationWithReload({
        snapshot: () => structuredClone(plugin.settings.resources),
        restore: (resources) => { plugin.settings.resources = resources; },
        mutate: action,
        save: async (previous) => await plugin.saveEchoInkResourceMutation(previous),
        closeRuntimeResources: async () => undefined,
        reloadRuntime: async () => {
      reloadCount += 1;
      if (reloadCount === 1) await firstReload.promise;
        }
      })
    );
  };
  const mutationA = mutate(() => {
    plugin.settings.resources.catalog[0]!.enabled = false;
  });
  await nextTurn();
  const mutationB = mutate(() => {
    plugin.settings.resources.mcpConnections[resource.id]!.trusted = true;
  });
  await nextTurn();
  assert.equal(reloadCount, 1);
  firstReload.reject(new Error("reload failed"));
  await assert.rejects(mutationA, (error: unknown) =>
    error instanceof ResourceMutationError && error.rollbackSafe);
  await mutationB;
  assert.equal(plugin.settings.resources.catalog[0]?.enabled, true);
  assert.equal(plugin.settings.resources.mcpConnections[resource.id]?.trusted, true);
  assert.equal(persisted.resources.catalog[0]?.enabled, true);
  assert.equal(persisted.resources.mcpConnections[resource.id]?.trusted, true);
  assert.equal(reloadCount, 3);
}

async function assertResourceMutationUnknownFreezesLane(): Promise<void> {
  const resource = skillResource({ id: "manual:skill:uncertain", source: "manual" });
  const settings = { resources: resourceSettings([resource]) };
  const plugin = resourceHost({
    settings,
    saveSettings: async () => {
      throw new Error("save unknown without readback");
    }
  });
  const previous = structuredClone(settings.resources);
  await assert.rejects(plugin.withEchoInkResourceMutation(async () => {
    settings.resources.catalog[0]!.enabled = false;
    await plugin.saveEchoInkResourceMutation(previous);
  }), (error: unknown) =>
    error instanceof ResourceMutationError
    && !error.rollbackSafe
    && !error.authorityKnown);
  assert.equal(settings.resources.catalog[0]?.enabled, true);
  let ran = false;
  await assert.rejects(plugin.withEchoInkResourceMutation(async () => {
    ran = true;
  }), ResourceMutationError);
  assert.equal(ran, false);
}

async function assertBlankSkillImportDoesNotOverwrite(): Promise<void> {
  for (const content of ["", " \n\t"]) {
    const vault = await mkdtemp(path.join(os.tmpdir(), "echoink-blank-skill-test-"));
    try {
      const skillPath = path.join(vault, ".echoink/resources/skills/fixture/SKILL.md");
      await mkdir(path.dirname(skillPath), { recursive: true });
      await writeFile(skillPath, content, "utf8");
      await assert.rejects(importEchoInkResourceToVault({
        vaultPath: vault,
        resource: skillResource({
          id: "manual:skill:fixture",
          source: "manual",
          contentPath: "fixture"
        })
      }), /已存在/u);
      assert.equal(await readFile(skillPath, "utf8"), content);
    } finally {
      await rm(vault, { recursive: true, force: true });
    }
  }
}

async function assertBlankMcpImportDoesNotOverwrite(): Promise<void> {
  const connection = {
    transport: "stdio" as const,
    command: "fixture-command"
  };
  for (const content of ["", " \n\t"]) {
    const vault = await mkdtemp(path.join(os.tmpdir(), "echoink-blank-mcp-test-"));
    try {
      const serversPath = path.join(vault, ".echoink/resources/mcp/servers.json");
      await mkdir(path.dirname(serversPath), { recursive: true });
      await writeFile(serversPath, content, "utf8");
      await assert.rejects(importEchoInkResourceToVault({
        vaultPath: vault,
        resource: mcpResource({
          id: "manual:mcp-server:blank-fixture",
          source: "manual",
          name: "Blank fixture"
        }),
        connection
      }), /expected JSON/u);
      assert.equal(await readFile(serversPath, "utf8"), content);
    } finally {
      await rm(vault, { recursive: true, force: true });
    }
  }

  const missingVault = await mkdtemp(path.join(os.tmpdir(), "echoink-missing-mcp-test-"));
  try {
    const imported = await importEchoInkResourceToVault({
      vaultPath: missingVault,
      resource: mcpResource({
        id: "manual:mcp-server:missing-fixture",
        source: "manual",
        name: "Missing fixture"
      }),
      connection
    });
    assert.equal(imported.relativePath, ".echoink/resources/mcp/servers.json");
    const servers = JSON.parse(await readFile(
      path.join(missingVault, imported.relativePath),
      "utf8"
    )) as { servers?: Record<string, unknown> };
    assert.equal(Object.keys(servers.servers ?? {}).length, 1);
  } finally {
    await rm(missingVault, { recursive: true, force: true });
  }
}

async function assertVaultBindingMigrationIsSafe(): Promise<void> {
  const vault = await mkdtemp(path.join(os.tmpdir(), "echoink-binding-test-"));
  try {
    const skillRoot = path.join(vault, ".echoink/resources/skills/fixture");
    await mkdir(skillRoot, { recursive: true });
    await writeFile(path.join(skillRoot, "SKILL.md"), [
      "---", "id: fixture", "name: Fixture", "version: 1",
      "description: fixture", "permissions: []", "entry: instruction",
      "---", "", "# Fixture"
    ].join("\n"), "utf8");
    const bindingsPath = path.join(vault, ".echoink/resources/bindings.json");
    const original = `${JSON.stringify({
      revision: "preserved",
      bindings: [{
        ref: "echoink://vault/fixture",
        scopes: ["chat"],
        enabled: false,
        label: "preserved target"
      }, {
        ref: "echoink://vault/other",
        scopes: ["knowledge"],
        enabled: false,
        custom: { retained: true }
      }]
    }, null, 2)}\n`;
    await writeFile(bindingsPath, original, "utf8");

    const loaded = await loadVaultEchoInkResources({
      vaultPath: vault,
      maxSkillBytes: 200_000
    });
    assert.equal(loaded.resources[0]?.enabled, false);
    assert.equal(Object.hasOwn(loaded.resources[0] ?? {}, "scopes"), false);
    await ensureVaultBindingForImportedResource(
      vault,
      "echoink://vault/fixture"
    );
    assert.equal(await readFile(bindingsPath, "utf8"), original);

    const importedSkill = await importEchoInkResourceToVault({
      vaultPath: vault,
      resource: skillResource({
        id: "manual:skill:imported-skill",
        source: "manual",
        name: "Imported skill",
        contentPath: "imported-skill"
      })
    });
    const afterSkillImport = JSON.parse(
      await readFile(bindingsPath, "utf8")
    ) as Record<string, any>;
    assert.equal(afterSkillImport.revision, "preserved");
    assert.deepEqual(afterSkillImport.bindings[0], {
      ref: "echoink://vault/fixture",
      scopes: ["chat"],
      enabled: false,
      label: "preserved target"
    });
    assert.deepEqual(afterSkillImport.bindings[1], {
      ref: "echoink://vault/other",
      scopes: ["knowledge"],
      enabled: false,
      custom: { retained: true }
    });
    assert.deepEqual(afterSkillImport.bindings[2], {
      ref: importedSkill.uri,
      enabled: true
    });
    assert.equal(Object.hasOwn(afterSkillImport.bindings[2], "scopes"), false);

    const importedMcp = await importEchoInkResourceToVault({
      vaultPath: vault,
      resource: mcpResource({
        id: "manual:mcp-server:imported-mcp",
        source: "manual",
        name: "Imported MCP"
      }),
      connection: {
        transport: "stdio",
        command: "fixture-command"
      }
    });
    const afterMcpImport = JSON.parse(
      await readFile(bindingsPath, "utf8")
    ) as Record<string, any>;
    assert.deepEqual(
      afterMcpImport.bindings.slice(0, 3),
      afterSkillImport.bindings
    );
    assert.deepEqual(afterMcpImport.bindings[3], {
      ref: importedMcp.uri,
      enabled: true
    });
    assert.equal(Object.hasOwn(afterMcpImport.bindings[3], "scopes"), false);

    const reloaded = await loadVaultEchoInkResources({
      vaultPath: vault,
      maxSkillBytes: 200_000
    });
    assert.equal(
      reloaded.resources.find((resource) =>
        resource.id === "echoink-local:skill:fixture")?.enabled,
      false
    );
    assert.equal(
      reloaded.resources.find((resource) =>
        resource.id === "echoink-local:skill:imported-skill")?.enabled,
      true
    );
    assert.equal(
      reloaded.resources.find((resource) =>
        resource.id === "echoink-local:mcp-server:mcp-imported-mcp")?.enabled,
      true
    );
  } finally {
    await rm(vault, { recursive: true, force: true });
  }

  for (const blank of ["", " \n\t"]) {
    const vault = await mkdtemp(path.join(os.tmpdir(), "echoink-blank-binding-test-"));
    try {
      const bindingsPath = path.join(vault, ".echoink/resources/bindings.json");
      await mkdir(path.dirname(bindingsPath), { recursive: true });
      await writeFile(bindingsPath, blank, "utf8");
      await assert.rejects(
        ensureVaultBindingForImportedResource(vault, "echoink://vault/fixture"),
        /expected JSON/u
      );
      assert.equal(await readFile(bindingsPath, "utf8"), blank);
    } finally {
      await rm(vault, { recursive: true, force: true });
    }
  }
}

function assertSavedGlobalResourceStateOverridesRuntimeDiscovery(): void {
  const saved = skillResource({
    name: "Previously scanned name",
    contentPath: "skills/fixture/OLD.md",
    enabled: false,
    metadata: { revision: "saved" }
  });
  const runtime = skillResource({
    name: "Current runtime name",
    contentPath: "skills/fixture/SKILL.md",
    enabled: true,
    metadata: { revision: "runtime" }
  });
  const settingsOnlySkill = skillResource({
    id: "echoink-local:skill:settings-only",
    name: "Removed settings-only Skill",
    enabled: false
  });
  const settingsOnlyMcp = mcpResource({
    id: "echoink-local:mcp-server:settings-only",
    name: "Removed settings-only MCP"
  });
  const manualOnlySkill = skillResource({
    id: "manual:skill:settings-only",
    source: "manual",
    name: "Manual settings-only Skill"
  });
  const manualOnlyMcp = mcpResource({
    id: "manual:mcp-server:settings-only",
    source: "manual",
    name: "Manual settings-only MCP"
  });

  const catalog = buildActiveEchoInkResourceCatalog({
    settings: {
      catalog: [
        saved,
        settingsOnlySkill,
        settingsOnlyMcp,
        manualOnlySkill,
        manualOnlyMcp
      ]
    },
    manual: [runtime]
  });
  const merged = catalog.find((resource) => resource.id === runtime.id);

  assert.equal(merged?.enabled, false);
  assert.equal(merged?.name, "Current runtime name");
  assert.equal(merged?.contentPath, "skills/fixture/SKILL.md");
  assert.deepEqual(merged?.metadata, { revision: "runtime" });
  assert.equal(catalog.some((resource) => resource.id === settingsOnlySkill.id), false);
  assert.equal(catalog.some((resource) => resource.id === settingsOnlyMcp.id), false);
  assert.equal(catalog.some((resource) => resource.id === manualOnlySkill.id), true);
  assert.equal(catalog.some((resource) => resource.id === manualOnlyMcp.id), true);
}

function assertMissingTrustFailsClosed(): void {
  const normalized = normalizeMcpConnectionRecord({
    transport: "stdio",
    command: "fixture-mcp",
    args: [],
    env: {},
    tools: [tool()],
    toolPolicies: {}
  });
  assert.equal(normalized?.trusted, false);
  assert.deepEqual(normalized?.toolPolicies, {});
}

async function assertExplicitTrustAndPolicyAreRequired(): Promise<void> {
  const resource = mcpResource();
  const discovered = tool();
  const raw = rawTool();
  const base = connection(discovered);
  for (const record of [
    { ...base, trusted: false },
    { ...base, toolPolicies: {} },
    {
      ...base,
      toolPolicies: {
        [discovered.name]: { enabled: true, trusted: false }
      }
    }
  ]) {
    const catalog = await buildCallableMcpToolCatalog({
      resources: [resource],
      connections: { [resource.id]: record },
      listTools: async () => [raw]
    });
    assert.deepEqual(catalog.tools, []);
  }

  const catalog = await buildCallableMcpToolCatalog({
    resources: [resource],
    connections: { [resource.id]: base },
    listTools: async () => [raw]
  });
  assert.equal(catalog.tools.length, 1, JSON.stringify(catalog));
  assert.equal(catalog.tools[0]?.toolName, discovered.name);
}

async function assertChangedContractRequiresRetrust(): Promise<void> {
  const resource = mcpResource();
  const cached = tool();
  const changed = { ...rawTool(), description: "changed contract" };
  const catalog = await buildCallableMcpToolCatalog({
    resources: [resource],
    connections: { [resource.id]: connection(cached) },
    listTools: async () => [changed]
  });
  assert.deepEqual(catalog.tools, []);
  assert.ok(catalog.warnings.some((warning) => /Schema 或安全合同已变化/u.test(warning)));
  assert.notEqual(
    mcpToolContractFingerprint(cached),
    mcpToolContractFingerprint(changed)
  );
}

function tool() {
  return inspectMcpToolList([rawTool()]).tools[0]!;
}

function rawTool() {
  return {
    name: "fixture_lookup",
    description: "Read a deterministic fixture",
    inputSchema: {
      type: "object",
      properties: { key: { type: "string" } },
      required: ["key"],
      additionalProperties: false
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false
    }
  };
}

function connection(
  discovered: ReturnType<typeof tool>
): EchoInkMcpConnectionRecord {
  return {
    transport: "stdio",
    command: "fixture-mcp",
    args: [],
    env: {},
    trusted: true,
    toolPolicies: {
      [discovered.name]: {
        enabled: true,
        trusted: true
      }
    },
    tools: [discovered],
    toolsFingerprint: mcpToolContractFingerprint(discovered)
  };
}

function mcpResource(
  overrides: Partial<EchoInkResource> = {}
): EchoInkResource {
  return {
    id: "echoink-local:mcp-server:fixture",
    kind: "mcp-server",
    source: "echoink-local",
    name: "Fixture MCP",
    description: "Fixture",
    enabled: true,
    bridgeMode: "native",
    ...overrides
  };
}

function skillResource(
  overrides: Partial<EchoInkResource> = {}
): EchoInkResource {
  return {
    id: "echoink-local:skill:fixture",
    kind: "skill",
    source: "echoink-local",
    name: "Fixture skill",
    description: "Fixture",
    enabled: true,
    bridgeMode: "prompt-only",
    contentPath: "skills/fixture/SKILL.md",
    ...overrides
  };
}

function resourceHost<T extends {
  settings: { resources: EchoInkResourceSettings };
  saveSettings(force?: boolean): Promise<void>;
}>(input: T): T & {
  withEchoInkResourceMutation<R>(action: () => Promise<R>): Promise<R>;
  saveEchoInkResourceMutation(previous: EchoInkResourceSettings): Promise<void>;
} {
  let tail: Promise<void> = Promise.resolve();
  let recoveryError: ResourceMutationError | null = null;
  return Object.assign(input, {
    withEchoInkResourceMutation: async <R>(action: () => Promise<R>): Promise<R> => {
      const run = tail.then(async () => {
        if (recoveryError) throw recoveryError;
        return await action();
      });
      tail = run.then(() => undefined, () => undefined);
      try {
        return await run;
      } catch (error) {
        if (error instanceof ResourceMutationError && !error.rollbackSafe) {
          recoveryError = error;
        }
        throw error;
      }
    },
    saveEchoInkResourceMutation: async (
      previous: EchoInkResourceSettings
    ): Promise<void> => {
      try {
        await input.saveSettings(true);
      } catch (error) {
        const value = error as {
          persistenceStatus?: unknown;
          persistedSettings?: { resources?: EchoInkResourceSettings };
        };
        if (value.persistenceStatus === "not_committed") {
          input.settings.resources = structuredClone(previous);
          throw new ResourceMutationError("not committed", true, false, true);
        }
        if (value.persistedSettings?.resources) {
          input.settings.resources = structuredClone(value.persistedSettings.resources);
          throw new ResourceMutationError("authoritative readback", false, true, true);
        }
        input.settings.resources = structuredClone(previous);
        throw new ResourceMutationError("unknown", false, true, false);
      }
    }
  });
}

function resourceSettings(catalog: EchoInkResource[] = []): EchoInkResourceSettings {
  return {
    catalog: structuredClone(catalog),
    importedFrom: {},
    mcpConnections: {},
    lastScannedAt: 0,
    lastError: ""
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function nextTurn(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
