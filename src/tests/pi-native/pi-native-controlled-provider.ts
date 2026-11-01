import * as assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  ImageContent,
  Model
} from "@earendil-works/pi-ai";
import { AssistantMessageEventStream, getSupportedThinkingLevels, InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createAgentSession, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { ControlledVaultResourceLoader } from "../../harness/pi-native/controlled-resources";
import {
  createPiNativeControlledProvider,
  createPiNativeModelFromCatalog,
  createPiNativeModelFromConfiguration,
  piModelSupportsImageInput,
  PiNativeModelMetadataError
} from "../../harness/pi-native/pi-native-controlled-provider";
import {
  createPiProviderModelDefinition,
  type ControlledPiStreamInput,
  type PiProviderRuntimeConfig
} from "../../harness/pi/production-pi-model-resolver";

export async function runPiNativeControlledProviderTests(): Promise<void> {
  assertCatalogModelMetadataFailsClosed();
  assertCurrentModelImageCapabilityIsCanonical();
  assertConfiguredModelCapabilitiesAndCatalogImageTruthMerge();
  await assertProtocolRequestLimitProjection();
  await assertExecutableAgentToolsProjectToProviderMetadata();
  await assertImageContentSurvivesControlledProviderProjection();
  await assertThrownOverflowRemainsVisibleToAgentSession();
  await assertUnknownProviderFailuresRemainSanitized();
  await assertResponseRevocationStopsFauxStream();
  await assertResponseFinalBoundaryFailsClosed();
  await assertFauxStreamWithoutGuardIsUnchanged();
}

function guardedFauxFixture(assertResponseAllowed?: () => void) {
  const config = providerConfig(), model = providerModel();
  const faux = fauxProvider({ api: config.apiProtocol, provider: config.providerId,
    models: [{ id: model.id, contextWindow: model.contextWindow, maxTokens: model.maxTokens }],
    tokenSize: { min: 1, max: 1 }, tokensPerSecond: 100_000 });
  faux.setResponses([fauxAssistantMessage("SAFEFORBIDDEN_RESPONSE_BODY")]);
  const upstream: AssistantMessageEventStream[] = [];
  const provider = createPiNativeControlledProvider({
    config: { read: async () => structuredClone(config) }, model, assertResponseAllowed,
    controlledStream: { authorityId: "response-guard-authority", storeSetId: "response-guard-store", stream: input => {
      const stream = faux.provider.stream(input.model, input.context, input.options); upstream.push(stream); return stream;
    } },
    currentExecutionContext: () => ({ runId: "response-guard-run", conversationId: "response-guard-conversation", turnId: "response-guard-turn", correlationId: "response-guard-correlation" })
  });
  return { provider, model, upstream };
}

async function assertResponseRevocationStopsFauxStream(): Promise<void> {
  let permitted = true, guardCalls = 0;
  const fixture = guardedFauxFixture(() => { guardCalls++; if (!permitted) throw new Error("expert_package_expired_private_detail"); });
  const stream = fixture.provider.stream(fixture.model, emptyContext(), {});
  const events: AssistantMessageEvent[] = [];
  for await (const event of stream) {
    events.push(event);
    if (event.type === "text_delta") { assert.equal(event.delta, "SAFE"); permitted = false; }
  }
  const result = await stream.result();
  await Promise.all(fixture.upstream.map(source => source.result()));
  assert.equal(events.filter(event => event.type === "text_delta").length, 1);
  assert.equal(events.some(event => event.type === "done"), false);
  assert.equal(events.at(-1)?.type, "error");
  assert.equal(result.stopReason, "error"); assert.equal(result.errorMessage, "controlled_transport_failed");
  assert.deepEqual(result.content, []);
  assert.equal(JSON.stringify(events).includes("FORBIDDEN"), false, "later mutable upstream partials must not alter an already-forwarded snapshot");
  assert.ok(guardCalls >= 4);
}

async function assertResponseFinalBoundaryFailsClosed(): Promise<void> {
  const config = providerConfig(), model = providerModel(); let permitted = true;
  class FinalBoundaryStream extends AssistantMessageEventStream {
    async *[Symbol.asyncIterator](): AsyncGenerator<AssistantMessageEvent> {
      yield { type: "done", reason: "stop", message: fauxAssistantMessage("FINAL_BODY_MUST_NOT_BE_ACCEPTED") };
      permitted = false;
    }
  }
  const provider = createPiNativeControlledProvider({ config: { read: async () => config }, model,
    assertResponseAllowed: () => { if (!permitted) throw new Error("revoked_at_final_boundary"); },
    controlledStream: { authorityId: "final-guard-authority", storeSetId: "final-guard-store", stream: () => new FinalBoundaryStream() },
    currentExecutionContext: () => ({ runId: "final-guard-run", conversationId: "final-guard-conversation", turnId: "final-guard-turn", correlationId: "final-guard-correlation" })
  });
  const stream = provider.stream(model, emptyContext(), {}), events: AssistantMessageEvent[] = [];
  for await (const event of stream) events.push(event);
  assert.deepEqual(events.map(event => event.type), ["error"]);
  const result = await stream.result(); assert.equal(result.stopReason, "error"); assert.deepEqual(result.content, []);
}

async function assertFauxStreamWithoutGuardIsUnchanged(): Promise<void> {
  const fixture = guardedFauxFixture(), stream = fixture.provider.stream(fixture.model, emptyContext(), {});
  const events: AssistantMessageEvent[] = [];
  for await (const event of stream) events.push(event);
  const result = await stream.result(); assert.equal(result.stopReason, "stop");
  assert.equal(events.at(-1)?.type, "done");
  assert.equal(events.filter(event => event.type === "text_delta").map(event => event.type === "text_delta" ? event.delta : "").join(""), "SAFEFORBIDDEN_RESPONSE_BODY");
}

/** Runs the real AgentSession persistence boundary with an offline faux stream. */
export async function runPiNativeControlledProviderPersistenceTests(root: string): Promise<void> {
  let permitted = true;
  const fixture = guardedFauxFixture(() => { if (!permitted) throw new Error("expert_response_revoked"); });
  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(), modelsPath: null, allowModelNetwork: false });
  modelRuntime.registerNativeProvider(fixture.provider);
  const sessionManager = SessionManager.create(root, root);
  const resourceLoader = new ControlledVaultResourceLoader({ vaultRoot: root, systemPrompt: "Offline response authorization fixture." });
  await resourceLoader.reload();
  const { session } = await createAgentSession({ cwd: root, agentDir: root, modelRuntime, model: fixture.model, noTools: "all", sessionManager, resourceLoader,
    settingsManager: SettingsManager.inMemory({ defaultProvider: fixture.model.provider, defaultModel: fixture.model.id, defaultThinkingLevel: "off", compaction: { enabled: false }, retry: { enabled: false }, packages: [], extensions: [], skills: [], prompts: [], themes: [], enableAnalytics: false }) });
  const deltas: string[] = [];
  const unsubscribe = session.subscribe(event => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") { deltas.push(event.assistantMessageEvent.delta); permitted = false; }
  });
  try {
    await session.prompt("Offline guard test");
    await Promise.all(fixture.upstream.map(source => source.result()));
    const saved = sessionManager.getEntries().filter(entry => entry.type === "message").map(entry => entry.message)
      .filter((message): message is AssistantMessage => message.role === "assistant");
    assert.deepEqual(deltas, ["SAFE"]); assert.equal(saved.length, 1);
    assert.equal(saved[0].stopReason, "error"); assert.deepEqual(saved[0].content, []);
    assert.equal(JSON.stringify(sessionManager.getEntries()).includes("FORBIDDEN"), false);
    const sessionFile = sessionManager.getSessionFile(); assert.ok(sessionFile);
    assert.equal((await readFile(sessionFile, "utf8")).includes("FORBIDDEN"), false);
    const reopened = SessionManager.open(sessionFile, root, root);
    const replayed = reopened.getEntries().filter(entry => entry.type === "message").map(entry => entry.message)
      .filter((message): message is AssistantMessage => message.role === "assistant");
    assert.equal(replayed.length, 1); assert.equal(replayed[0].stopReason, "error"); assert.deepEqual(replayed[0].content, []);
  } finally { unsubscribe(); session.dispose(); }
}

async function assertProtocolRequestLimitProjection(): Promise<void> {
  const capture = async (
    apiProtocol: PiProviderRuntimeConfig["apiProtocol"],
    configuredMaxTokens?: number,
    requestedMaxTokens?: number,
    automaticOutputLimit = false
  ): Promise<ControlledPiStreamInput["options"]> => {
    const config: PiProviderRuntimeConfig = {
      ...providerConfig(),
      apiProtocol
    };
    const model = createPiProviderModelDefinition({
      providerId: config.providerId,
      apiProtocol,
      baseUrl: config.baseUrl,
      modelRef: config.modelRef,
      maxOutputTokens: 8_192
    });
    let captured: ControlledPiStreamInput["options"] | undefined;
    const provider = createPiNativeControlledProvider({
      config: { read: async () => structuredClone(config) },
      controlledStream: {
        authorityId: "request-limit-authority",
        storeSetId: "request-limit-store",
        stream: (input) => {
          captured = input.options;
          throw new Error("fixture_transport_stop");
        }
      },
      model,
      automaticOutputLimit,
      ...(configuredMaxTokens === undefined
        ? {}
        : { maxTokens: configuredMaxTokens }),
      currentExecutionContext: () => ({
        runId: "request-limit-run",
        conversationId: "request-limit-conversation",
        turnId: "request-limit-turn",
        correlationId: "request-limit-correlation"
      })
    });
    await provider.stream(
      model,
      emptyContext(),
      requestedMaxTokens === undefined ? {} : { maxTokens: requestedMaxTokens }
    ).result();
    assert.ok(captured);
    return captured;
  };

  for (const protocol of [
    "openai-completions",
    "openai-responses",
    "openai-codex-responses"
  ] as const) {
    const inherited = await capture(protocol);
    assert.equal(
      Object.hasOwn(inherited, "maxTokens"),
      false,
      "undefined must delegate the default maximum to protocol streamSimple"
    );
    if (protocol !== "openai-codex-responses") {
      const internallyRequested = await capture(protocol, undefined, 1_024);
      assert.equal(internallyRequested.maxTokens, 1_024);
    }
  }
  const overridden = await capture("openai-completions", 2_048, 1_024);
  assert.equal(overridden.maxTokens, 1_024);
  const anthropic = await capture("anthropic-messages");
  assert.equal(anthropic.maxTokens, 8_192);
  const anthropicLower = await capture(
    "anthropic-messages",
    undefined,
    1_024
  );
  assert.equal(anthropicLower.maxTokens, 1_024);
  for (const protocol of ["openai-completions", "openai-responses", "anthropic-messages"] as const) {
    const automatic = await capture(protocol, 8_192, undefined, true);
    assert.equal(automatic.maxTokens, undefined, "automatic protocol default must reach the Dispatcher without an explicit cap");
    const explicit = await capture(protocol, 8_192, 32, true);
    assert.equal(explicit.maxTokens, 32, "actual caller caps remain explicit for automatic models");
  }
}

function assertCurrentModelImageCapabilityIsCanonical(): void {
  const apiKeyProvider = providerConfig();
  const oauthProvider = oauthProviderConfig();
  const catalogImageModel = {
    ...providerModel(oauthProvider),
    input: ["text", "image"] as Model<Api>["input"]
  };
  const catalogResolved = createPiNativeModelFromConfiguration({
    catalogModel: catalogImageModel,
    provider: oauthProvider,
    configured: configuredModelMetadata(oauthProvider, false)
  });
  assert.equal(piModelSupportsImageInput(catalogResolved), true);
  assert.deepEqual(catalogResolved.input, ["text", "image"]);

  const configuredResolved = createPiNativeModelFromConfiguration({
    catalogModel: undefined,
    provider: apiKeyProvider,
    configured: configuredModelMetadata(apiKeyProvider, true)
  });
  assert.equal(configuredResolved.reasoning, true);
  assert.equal(piModelSupportsImageInput(configuredResolved), true);
  assert.deepEqual(configuredResolved.input, ["text", "image"]);
  assert.deepEqual(getSupportedThinkingLevels(configuredResolved), [
    "off",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max"
  ]);

  const textOnly = createPiNativeModelFromConfiguration({
    catalogModel: providerModel(),
    provider: apiKeyProvider,
    configured: configuredModelMetadata(apiKeyProvider, false)
  });
  assert.equal(piModelSupportsImageInput(textOnly), false);
  assert.deepEqual(textOnly.input, ["text"]);
}

function assertConfiguredModelCapabilitiesAndCatalogImageTruthMerge(): void {
  const provider = providerConfig();
  const catalog = {
    ...providerModel(),
    name: "Catalog model",
    reasoning: true,
    input: ["text", "image"] as Array<"text" | "image">,
    contextWindow: 128_000,
    maxTokens: 32_000
  };
  const configured = createPiNativeModelFromConfiguration({
    catalogModel: catalog,
    provider,
    configured: {
      apiProtocol: "openai-completions",
      contextWindow: 96_000,
      maxOutputTokens: 12_000,
      reasoning: false,
      imageInput: false
    }
  });
  assert.equal(
    configured.reasoning,
    true,
    "catalog reasoning truth must ignore a manual false override"
  );
  assert.equal(configured.contextWindow, 96_000);
  assert.equal(configured.maxTokens, 12_000);
  assert.deepEqual(configured.input, ["text", "image"]);

  const configuredImage = createPiNativeModelFromConfiguration({
    catalogModel: { ...catalog, input: ["text"] },
    provider,
    configured: {
      apiProtocol: "openai-completions",
      contextWindow: 96_000,
      maxOutputTokens: 12_000,
      reasoning: false,
      imageInput: true
    }
  });
  assert.deepEqual(configuredImage.input, ["text", "image"]);
}

function assertCatalogModelMetadataFailsClosed(): void {
  const config = providerConfig();
  const valid = providerModel();
  const cases: ReadonlyArray<{
    label: string;
    catalogModel: Model<Api> | undefined;
    expectedCode: PiNativeModelMetadataError["code"];
  }> = [{
    label: "missing catalog model",
    catalogModel: undefined,
    expectedCode: "model_metadata_missing"
  }, {
    label: "zero context window",
    catalogModel: { ...valid, contextWindow: 0 },
    expectedCode: "model_metadata_incompatible"
  }, {
    label: "fractional context window",
    catalogModel: { ...valid, contextWindow: 64_000.5 },
    expectedCode: "model_metadata_incompatible"
  }];

  for (const testCase of cases) {
    assert.throws(
      () => createPiNativeModelFromCatalog({
        catalogModel: testCase.catalogModel,
        provider: config
      }),
      (error: unknown) => {
        assert.ok(
          error instanceof PiNativeModelMetadataError,
          `${testCase.label} must fail closed instead of inventing a context window`
        );
        assert.equal(error.code, testCase.expectedCode);
        return true;
      }
    );
  }
}

async function assertThrownOverflowRemainsVisibleToAgentSession():
Promise<void> {
  const result = await runThrowingProvider("context_length_exceeded");
  assert.equal(result.errorMessage, "context_length_exceeded");
}

async function assertUnknownProviderFailuresRemainSanitized(): Promise<void> {
  const result = await runThrowingProvider("rate limit with secret detail");
  assert.equal(result.errorMessage, "controlled_transport_failed");
}

async function assertExecutableAgentToolsProjectToProviderMetadata():
Promise<void> {
  const model = providerModel();
  const config = providerConfig();
  let captured: Context | undefined;
  const execute = async () => ({
    content: [{ type: "text" as const, text: "fixture" }],
    details: { fixture: true }
  });
  const runtimeTool = {
    name: "echoink_readonly_fixture",
    label: "EchoInk read-only fixture",
    description: "Return deterministic Phase 1 fixture data",
    parameters: {
      type: "object",
      properties: {
        key: { type: "string" }
      },
      required: ["key"],
      additionalProperties: false
    },
    prepareArguments: (value: unknown) => value,
    execute,
    executionMode: "sequential"
  };
  const provider = createPiNativeControlledProvider({
    config: {
      read: async () => structuredClone(config)
    },
    controlledStream: {
      authorityId: "phase1-provider-authority",
      storeSetId: "phase1-provider-store",
      stream: (input) => {
        captured = input.context;
        throw new Error("fixture_transport_stop");
      }
    },
    model,
    currentExecutionContext: () => ({
      runId: "phase1-provider-run",
      conversationId: "phase1-provider-conversation",
      turnId: "phase1-provider-turn",
      correlationId: "phase1-provider-correlation"
    })
  });
  const context: Context = {
    ...emptyContext(),
    tools: [runtimeTool]
  };

  const result = await provider.stream(model, context, {}).result();

  assert.equal(result.errorMessage, "controlled_transport_failed");
  assert.ok(captured, "Provider transport must receive the Context");
  assert.notEqual(captured, context);
  assert.deepEqual(captured.tools, [{
    name: runtimeTool.name,
    description: runtimeTool.description,
    parameters: runtimeTool.parameters
  }]);
  assert.equal("execute" in captured.tools![0]!, false);
  assert.equal(runtimeTool.execute, execute);
}

async function assertImageContentSurvivesControlledProviderProjection():
Promise<void> {
  const config = providerConfig();
  const model = createPiNativeModelFromConfiguration({
    catalogModel: {
      ...providerModel(),
      input: ["text", "image"]
    },
    provider: config,
    configured: configuredModelMetadata(config, false)
  });
  assert.equal(piModelSupportsImageInput(model), true);
  const image: ImageContent = {
    type: "image",
    data: "AQIDBA==",
    mimeType: "image/png"
  };
  const context: Context = {
    systemPrompt: "Inspect the ordered image content.",
    messages: [{
      role: "user",
      content: [
        { type: "text", text: "请看图片" },
        image
      ],
      timestamp: 1
    }],
    tools: []
  };
  let captured: Context | undefined;
  const provider = createPiNativeControlledProvider({
    config: {
      read: async () => structuredClone(config)
    },
    controlledStream: {
      authorityId: "phase1-provider-authority",
      storeSetId: "phase1-provider-store",
      stream: (input) => {
        captured = input.context;
        throw new Error("fixture_transport_stop");
      }
    },
    model,
    currentExecutionContext: () => ({
      runId: "phase1-provider-image-run",
      conversationId: "phase1-provider-image-conversation",
      turnId: "phase1-provider-image-turn",
      correlationId: "phase1-provider-image-correlation"
    })
  });

  const result = await provider.stream(model, context, {}).result();

  assert.equal(result.errorMessage, "controlled_transport_failed");
  assert.ok(captured, "the controlled Provider dispatcher must receive Context");
  assert.notEqual(captured, context);
  assert.notEqual(captured.messages[0], context.messages[0]);
  assert.deepEqual(captured.messages[0], context.messages[0]);
  const capturedContent = captured.messages[0]?.content;
  assert.ok(Array.isArray(capturedContent));
  assert.deepEqual(capturedContent, [
    { type: "text", text: "请看图片" },
    { type: "image", data: "AQIDBA==", mimeType: "image/png" }
  ]);
}

async function runThrowingProvider(message: string) {
  const model = providerModel();
  const config = providerConfig();
  const provider = createPiNativeControlledProvider({
    config: {
      read: async () => structuredClone(config)
    },
    controlledStream: {
      authorityId: "phase1-provider-authority",
      storeSetId: "phase1-provider-store",
      stream: () => {
        throw new Error(message);
      }
    },
    model,
    currentExecutionContext: () => ({
      runId: "phase1-provider-run",
      conversationId: "phase1-provider-conversation",
      turnId: "phase1-provider-turn",
      correlationId: "phase1-provider-correlation"
    })
  });
  return await provider.stream(model, emptyContext(), {}).result();
}

function providerModel(
  config: PiProviderRuntimeConfig = providerConfig()
): Model<Api> {
  return createPiProviderModelDefinition({
    providerId: config.providerId,
    apiProtocol: config.apiProtocol,
    baseUrl: config.baseUrl,
    modelRef: config.modelRef
  });
}

function providerConfig(): PiProviderRuntimeConfig {
  return {
    providerId: "custom",
    apiProtocol: "openai-completions",
    authMode: "api-key",
    baseUrl: "https://fixture.example/v1",
    modelRef: "fixture/model"
  };
}

function oauthProviderConfig(): PiProviderRuntimeConfig {
  return {
    providerId: "openai-codex",
    apiProtocol: "openai-codex-responses",
    authMode: "oauth",
    baseUrl: "https://chatgpt.com/backend-api",
    modelRef: "gpt-5.6-sol"
  };
}

function configuredModelMetadata(
  provider: PiProviderRuntimeConfig,
  imageInput: boolean
) {
  return {
    apiProtocol: provider.apiProtocol,
    contextWindow: 64_000,
    maxOutputTokens: 8_192,
    reasoning: true,
    imageInput
  };
}

function emptyContext(): Context {
  return {
    systemPrompt: "Phase 1 controlled Provider fixture",
    messages: [],
    tools: []
  };
}
