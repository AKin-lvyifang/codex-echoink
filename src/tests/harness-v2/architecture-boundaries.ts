import * as assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import * as path from "node:path";

export async function runHarnessV2ArchitectureBoundaryTests(): Promise<void> {
  await assertSingleHarnessCoreDefinitions();
  await assertSingleContextCompilerCallSite();
  await assertKnowledgeDoesNotForkSessionContextCore();
  await assertKnowledgeControllersUseAgentBoundary();
  await assertSingleProductionRunOrchestratorConstruction();
  await assertKnowledgeCodexRichNotificationsUseHub();
  await assertAgentAdapterDeclaresAwaitResult();
  await assertCodexViewOnlyKeepsGlobalNotificationAllowlist();
  await assertEditorSurfaceRemovesLegacyRawWaiters();
  await assertCodexViewRemovesLegacyRawRenderers();
  await assertChatSurfaceRemovesInlineAssistantBranch();
  await assertDestructiveTrashEffectsStayBehindCoordinator();
  await assertProductionRecordMutationRecoveryUsesRunner();
  await assertSourceDeletionParticipantsStayBehindRecoveryRunner();
  await assertLiveContextMutationJournalKeepsAuthorityChain();
  await assertRunRetentionUsesProductionRecoveryEvidenceAuthority();
  await assertReverseStoreActivationUsesValidatedCoordinator();
  await assertProductionConversationStoreUsesManifestRoute();
}

async function assertProductionConversationStoreUsesManifestRoute():
Promise<void> {
  const [settingsStore, router] = await Promise.all([
    readSource("src/plugin/settings-store.ts"),
    readSource("src/plugin/conversation-store-router.ts")
  ]);
  assert.doesNotMatch(
    settingsStore,
    /new FileConversationStore\s*\(/,
    "production settings must not bypass the selected Conversation route"
  );
  assert.match(
    settingsStore,
    /new FileConversationStoreRouter\s*\(/
  );
  assert.match(
    router,
    /resolveConversationStoreSelection\([\s\S]*selection\.activeStore === "v2"[\s\S]*ConversationStoreRoutingError/,
    "V2 active must fail closed until the complete live adapter exists"
  );
}

async function assertReverseStoreActivationUsesValidatedCoordinator():
Promise<void> {
  const directTransitionCallers: string[] = [];
  for (const file of await productionTypeScriptSources()) {
    if (
      file.relativePath
        === "src/harness/conversation/store-restore-manifest.ts"
    ) {
      continue;
    }
    const source = await readFile(file.absolutePath, "utf8");
    if (
      /\badvanceConversationStoreRestoreManifestToActive\s*\(/.test(
        source
      )
    ) {
      directTransitionCallers.push(file.relativePath);
    }
  }
  assert.deepEqual(
    directTransitionCallers,
    ["src/harness/lifecycle/conversation-v1-exporter.ts"],
    "reverse-active publication must stay behind the V1 restore coordinator"
  );
  const exporter = await readSource(
    "src/harness/lifecycle/conversation-v1-exporter.ts"
  );
  const activation = sourceBetween(
    exporter,
    "export async function activateConversationStoreV1RestoreRoute(",
    "\nexport function projectConversationCommitV2ToStoredSessionV1("
  );
  assert.match(
    activation,
    /inspectAndValidateConversationStoreV1Export\([\s\S]*validation\.report\.status !== "ready"[\s\S]*advanceConversationStoreRestoreManifestToActive\(/,
    "the sole reverse-active coordinator must perform fresh full validation before transition"
  );
}

async function assertRunRetentionUsesProductionRecoveryEvidenceAuthority():
Promise<void> {
  const [
    evidence,
    harnessService,
    nativeStartup,
    workflowWal,
    artifactLifecycle,
    destructiveLifecycle
  ] = await Promise.all([
    readSource(
      "src/harness/ledger/run-record-retention-recovery-evidence.ts"
    ),
    readSource("src/plugin/harness-service.ts"),
    readSource("src/plugin/native-startup-reconciliation.ts"),
    readSource("src/harness/maintenance/workflow-wal.ts"),
    readSource("src/harness/artifacts/artifact-lifecycle-store.ts"),
    readSource("src/plugin/conversation-record-mutation-lifecycle.ts")
  ]);
  assert.match(
    evidence,
    /listMaintenanceWorkflowWals[\s\S]*listRecordMutationJournals[\s\S]*loadWorkflowArtifactLifecycleRecord/
  );
  assert.match(
    evidence,
    /withRecordMutationGlobalAuthority[\s\S]*store\.withMutation/
  );
  assert.match(
    harnessService,
    /recoverStartedRunRecordRetentions[\s\S]*createRunRecordRetentionRecoveryEvidenceAuthority[\s\S]*resolveRetirementRoots/
  );
  assert.match(
    nativeStartup,
    /recoverPendingHermesProposalLocalCommits[\s\S]*recoverStartedRunRecordRetentions[\s\S]*listAwaitingRetirements/
  );
  assert.match(workflowWal, /withRecordMutationGlobalAuthority/);
  assert.match(artifactLifecycle, /withRecordMutationGlobalAuthority/);
  assert.match(
    destructiveLifecycle,
    /withConversationMutation\([\s\S]*withRecordMutationGlobalAuthority/
  );
}

async function assertLiveContextMutationJournalKeepsAuthorityChain():
Promise<void> {
  const [lifecycle, settingsStore, harnessService] = await Promise.all([
    readSource("src/plugin/session-context-lifecycle.ts"),
    readSource("src/plugin/settings-store.ts"),
    readSource("src/plugin/harness-service.ts")
  ]);
  assert.match(
    lifecycle,
    /recordMutation:[\s\S]*stageSessionContextRecordMutation[\s\S]*settleSessionContextRecordMutation/
  );
  assert.match(
    lifecycle,
    /withConversationMutation\([\s\S]*session\.id,[\s\S]*rotate/
  );
  assert.match(
    lifecycle,
    /promoteNativeExecutionRetirements\([\s\S]*readRecordMutationAuthority/
  );
  assert.match(
    settingsStore,
    /assertConversationMutationAuthority\([\s\S]*runRecordMutationRecoveryUnderAuthority/
  );
  assert.match(
    harnessService,
    /Native retirement RecordMutation Journal is not committed/
  );

  const callers: string[] = [];
  for (const file of await productionTypeScriptSources()) {
    const source = await readFile(file.absolutePath, "utf8");
    if (/\brunRecordMutationRecoveryUnderAuthority\s*\(/.test(source)) {
      callers.push(file.relativePath);
    }
  }
  assert.deepEqual(callers, [
    "src/harness/lifecycle/record-mutation-recovery-runner.ts",
    "src/plugin/settings-store.ts"
  ]);
}

async function assertSingleHarnessCoreDefinitions(): Promise<void> {
  const sources = await productionTypeScriptSources();
  const expected = new Map<RegExp, string>([
    [/\bclass\s+EchoInkHarnessKernel\b/, "src/harness/kernel/harness-kernel.ts"],
    [/\bclass\s+RunOrchestrator\b/, "src/harness/kernel/run-orchestrator.ts"],
    [/\bfunction\s+compileContextBundle\b/, "src/harness/kernel/context-compiler.ts"],
    [/\binterface\s+RunLedger\b/, "src/harness/ledger/run-ledger.ts"]
  ]);
  for (const [pattern, expectedPath] of expected) {
    const definitions: string[] = [];
    for (const file of sources) {
      if (pattern.test(await readFile(file.absolutePath, "utf8"))) definitions.push(file.relativePath);
    }
    assert.deepEqual(definitions, [expectedPath], `${pattern.source} must have one production definition`);
  }
}

async function assertChatSurfaceRemovesInlineAssistantBranch(): Promise<void> {
  const sources = await Promise.all([
    readSource("src/ui/codex-view/turn-runner.ts"),
    readSource("src/harness/agents/backend-runtime-profile.ts")
  ]);
  assert.doesNotMatch(sources.join("\n"), /chatUsesInlineAssistant|harnessBackendUsesInlineAssistant|inlineAssistant/);
}

async function assertDestructiveTrashEffectsStayBehindCoordinator(): Promise<void> {
  const sources = await productionTypeScriptSources();
  const finalizeCallers: string[] = [];
  const restoreCallers: string[] = [];
  for (const file of sources) {
    if (file.relativePath === "src/harness/lifecycle/record-mutation-trash.ts") {
      continue;
    }
    const source = await readFile(file.absolutePath, "utf8");
    if (/\bfinalizeRecordMutationTrash\s*\(/.test(source)) {
      finalizeCallers.push(file.relativePath);
    }
    if (/\brestoreRecordMutationTrash\s*\(/.test(source)) {
      restoreCallers.push(file.relativePath);
    }
  }
  assert.deepEqual(
    finalizeCallers,
    ["src/harness/lifecycle/record-mutation-coordinator.ts"],
    "production source retirement must stay behind RecordMutation coordinator"
  );
  assert.deepEqual(
    restoreCallers,
    [
      "src/harness/lifecycle/record-mutation-coordinator.ts",
      "src/harness/lifecycle/record-mutation-recovery.ts"
    ],
    "production restore must stay behind coordinator; only temp-fixture recovery may bypass"
  );
  const fixtureRecovery = await readSource(
    "src/harness/lifecycle/record-mutation-recovery.ts"
  );
  assert.match(
    fixtureRecovery,
    /fixtureOnly:\s*true/,
    "the sole restore bypass must remain fixture-only"
  );
  assert.match(
    fixtureRecovery,
    /assertTemporaryFixturePath/,
    "the sole restore bypass must remain confined to temporary fixtures"
  );
}

async function assertProductionRecordMutationRecoveryUsesRunner(): Promise<void> {
  const sources = await productionTypeScriptSources();
  const decisionCallers: string[] = [];
  for (const file of sources) {
    if (file.relativePath === "src/harness/lifecycle/record-mutation-recovery.ts") {
      const source = await readFile(file.absolutePath, "utf8");
      const callCount = source.match(/\bdecideRecordMutationRecovery\s*\(/g)?.length ?? 0;
      assert.equal(
        callCount,
        2,
        "recovery module may contain only the pure definition and fixture-only caller"
      );
      decisionCallers.push(file.relativePath);
      continue;
    }
    const source = await readFile(file.absolutePath, "utf8");
    if (/\bdecideRecordMutationRecovery\s*\(/.test(source)) {
      decisionCallers.push(file.relativePath);
    }
  }
  assert.deepEqual(
    decisionCallers,
    [
      "src/harness/lifecycle/record-mutation-recovery-runner.ts",
      "src/harness/lifecycle/record-mutation-recovery.ts"
    ],
    "production recovery decisions must be built by the evidence-inspecting runner"
  );
}

async function assertSourceDeletionParticipantsStayBehindRecoveryRunner():
Promise<void> {
  const sources = await productionTypeScriptSources();
  const callers: string[] = [];
  const guardedCall = /\b(?:coordinateRecordMutationSourceParticipantForward|coordinateRecordMutationSourceParticipantRestore|reconcileRecordMutationSourceParticipantForward|verifyRecordMutationSourceParticipantForward|verifyRecordMutationSourceParticipantAborted)\s*\(/;
  for (const file of sources) {
    if (
      file.relativePath
        === "src/harness/lifecycle/record-mutation-source-participant.ts"
    ) {
      continue;
    }
    const source = await readFile(file.absolutePath, "utf8");
    if (guardedCall.test(source)) callers.push(file.relativePath);
  }
  assert.deepEqual(
    callers,
    ["src/harness/lifecycle/record-mutation-recovery-runner.ts"],
    "Memory/Artifact source deletion effects must stay behind the production recovery runner"
  );
}

export async function runHarnessV2CodexViewRawParserBoundaryTests(): Promise<void> {
  await assertCodexViewOnlyKeepsGlobalNotificationAllowlist();
}

async function assertAgentAdapterDeclaresAwaitResult(): Promise<void> {
  const adapter = await readSource("src/harness/agents/adapter.ts");
  assert.match(adapter, /awaitResult\?\(runId: string\): Promise<AgentRunResult>/);
}

async function assertCodexViewOnlyKeepsGlobalNotificationAllowlist(): Promise<void> {
  const [view, router] = await Promise.all([
    readSource("src/ui/codex-view.ts"),
    readSource("src/ui/codex-view/notification-router.ts")
  ]);
  const rawHandler = sourceBetween(
    router,
    "  handle(notification: CodexNotification): void {",
    "}\n\nfunction paramsObject"
  );
  assert.doesNotMatch(rawHandler, /method === "(?:item\/|turn\/started|turn\/completed|error)/);
  assert.doesNotMatch(rawHandler, /handleEditorSummaryNotification|editorSummaryRun/);
  assert.doesNotMatch(rawHandler, /account\/rateLimits/);
  assert.match(rawHandler, /method === "thread\/tokenUsage\/updated"/);
  assert.match(rawHandler, /method === "thread\/compacted"/);
  assert.match(view, /this\.notificationRouter\?\.handle\(notification\)/);
}

async function assertCodexViewRemovesLegacyRawRenderers(): Promise<void> {
  const view = await readSource("src/ui/codex-view.ts");
  for (const legacyName of [
    "activeItemMessages",
    "handleEditorActionNotification",
    "appendItemDelta",
    "appendProcessDelta",
    "markThinkingAsStreaming",
    "renderPlanUpdate",
    "renderStartedItem",
    "renderCompletedItem",
    "upsertProcessItem",
    "findProcessMessageByItemId",
    "clearEditorSummaryTimers"
  ]) {
    assert.doesNotMatch(view, new RegExp(`\\b${legacyName}\\b`), `${legacyName} must not remain in production`);
  }
}

async function assertEditorSurfaceRemovesLegacyRawWaiters(): Promise<void> {
  const [view, runner] = await Promise.all([
    readSource("src/ui/codex-view.ts"),
    readSource("src/ui/codex-view/editor-action-runner.ts")
  ]);

  assert.doesNotMatch(view, /editorSummaryRun|handleEditorSummaryNotification|resolveEditorSummaryRun|rejectEditorSummaryRun|releaseEditorSummaryRunLock/);
  assert.doesNotMatch(runner, /waitForResult|resolveEditorActionHarnessOutput|editorActionRun\s*=\s*\{\s*runId[\s\S]*?resolve,\s*reject/s);
  assert.match(runner, /awaitResult\(/);
}

async function assertSingleContextCompilerCallSite(): Promise<void> {
  const sources = await productionTypeScriptSources();
  const callers: string[] = [];
  for (const file of sources) {
    const source = await readFile(file.absolutePath, "utf8");
    if (/compileContextBundle\s*\(/.test(source) && file.relativePath !== "src/harness/kernel/context-compiler.ts") {
      callers.push(file.relativePath);
    }
  }
  assert.deepEqual(callers, ["src/harness/kernel/run-orchestrator.ts"]);
}

async function assertKnowledgeDoesNotForkSessionContextCore(): Promise<void> {
  const sources = await productionTypeScriptSources();
  const forbidden = /KnowledgeContextBridge|buildKnowledgeContextBridgeForThread|appendKnowledgeContextBridge|class\s+\w*ContextManager/;
  const offenders: string[] = [];
  for (const file of sources) {
    const source = await readFile(file.absolutePath, "utf8");
    if (forbidden.test(source)) offenders.push(file.relativePath);
  }
  assert.deepEqual(offenders, []);

  for (const relativePath of [
    "src/harness/kernel/context-compiler.ts",
    "src/harness/kernel/session-service.ts"
  ]) {
    const source = await readFile(path.join(process.cwd(), relativePath), "utf8");
    assert.doesNotMatch(source, /knowledge-base|KnowledgeBase|\/maintain|Raw Digest|LLM-WIKI/);
  }

  const conversationStore = await readSource(
    "src/harness/conversation/conversation-store.ts"
  );
  assertConversationStoreDoesNotForkKnowledgeContext(conversationStore);
  assert.throws(
    () => assertConversationStoreDoesNotForkKnowledgeContext(`
      function chooseContext(session: StoredSession) {
        return session.kind === "knowledge-base" ? buildKnowledgeContext() : buildContext();
      }
    `),
    "the architecture guard must reject a Knowledge-specific Context branch"
  );
}

function assertConversationStoreDoesNotForkKnowledgeContext(source: string): void {
  assert.doesNotMatch(
    source,
    /from\s+["'][^"']*\/knowledge-base(?:\/[^"']*)?["']/,
    "Conversation Store must not depend on the Knowledge controller layer"
  );
  assert.doesNotMatch(
    source,
    /\b(?:KnowledgeContextBridge|KnowledgeBaseManager|KnowledgeBaseHistoryStore|buildKnowledgeContextBridgeForThread|appendKnowledgeContextBridge|buildKnowledgeBasePrompt|handleKnowledgeBaseUserMessage|ensureKnowledgeBaseSession|isKnowledgeBaseSession)\b/,
    "Conversation Store must not own Knowledge-specific Context behavior"
  );
  assert.doesNotMatch(
    source,
    /\b(?:session|conversation|metadata|candidate|before|currentSession|storedSession)\??\.kind\s*(?:===|!==)\s*["']knowledge-base["']/,
    "Conversation Store must not branch Context behavior by Knowledge session kind"
  );
  assert.doesNotMatch(
    source,
    /["']knowledge-base["']\s*(?:===|!==)\s*\b(?:session|conversation|metadata|candidate|before|currentSession|storedSession)\??\.kind/,
    "Conversation Store must not reverse-branch Context behavior by Knowledge session kind"
  );
  assert.doesNotMatch(
    source,
    /\bswitch\s*\(\s*(?:session|conversation|metadata|candidate|before|currentSession|storedSession)\??\.kind\s*\)/,
    "Conversation Store must not switch Context behavior by session kind"
  );
  assert.doesNotMatch(
    source,
    /\/maintain|Raw Digest|LLM-WIKI/,
    "Conversation Store must not embed Knowledge workflow or prompt rules"
  );
}

async function assertKnowledgeControllersUseAgentBoundary(): Promise<void> {
  const [manager, queryJournal] = await Promise.all([
    readSource("src/knowledge-base/manager.ts"),
    readSource("src/knowledge-base/query-journal.ts")
  ]);
  const concreteBackend = /(?:OpenCodeBackend|HermesBackend|CodexService)|new\s+\w*Backend\s*\(/;
  const backendBranch = /backend\s*(?:===|!==)\s*"(?:codex-cli|opencode|hermes)"/;

  assert.doesNotMatch(manager, concreteBackend);
  assert.doesNotMatch(manager, backendBranch);
  assert.doesNotMatch(manager, /testOpenCodeConnection/);
  assert.doesNotMatch(queryJournal, concreteBackend);
  assert.doesNotMatch(queryJournal, backendBranch);
  assert.match(queryJournal, /collectEchoInkJournalEvidenceFromSessions/);
  assert.match(queryJournal, /collectNativeJournalHistory/);
}

async function assertSingleProductionRunOrchestratorConstruction(): Promise<void> {
  const sources = await productionTypeScriptSources();
  const constructors: string[] = [];
  for (const file of sources) {
    const source = await readFile(file.absolutePath, "utf8");
    if (/new\s+RunOrchestrator\s*\(/.test(source)) constructors.push(file.relativePath);
  }
  assert.deepEqual(constructors, ["src/harness/kernel/harness-kernel.ts"]);
}

async function assertKnowledgeCodexRichNotificationsUseHub(): Promise<void> {
  const [manager, main, harnessService] = await Promise.all([
    readSource("src/knowledge-base/manager.ts"),
    readSource("src/main.ts"),
    readSource("src/plugin/harness-service.ts")
  ]);

  assert.doesNotMatch(manager, /CodexKbWaiter|codexWaiter|handleCodexNotification|waitForCodexKnowledgeResult|startTurnPending/);
  assert.doesNotMatch(main, /knowledgeBase\?\.handleCodexNotification|handleKnowledgeBaseCodexNotification/);
  assert.match(main, /getHarnessService\(\)\.handleCodexNotification\(notification\)/);
  assert.match(harnessService, /codexRichNotificationHub\.dispatch\(notification\)/);
}

async function readSource(relativePath: string): Promise<string> {
  return await readFile(path.join(process.cwd(), relativePath), "utf8");
}

function sourceBetween(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.ok(startIndex >= 0, `Missing source marker: ${start}`);
  assert.ok(endIndex > startIndex, `Missing source marker: ${end}`);
  return source.slice(startIndex, endIndex);
}

async function productionTypeScriptSources(): Promise<Array<{ absolutePath: string; relativePath: string }>> {
  const srcRoot = path.join(process.cwd(), "src");
  const files: Array<{ absolutePath: string; relativePath: string }> = [];
  const visit = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const absolutePath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "tests") await visit(absolutePath);
      } else if (entry.isFile() && entry.name.endsWith(".ts")) {
        files.push({ absolutePath, relativePath: path.relative(process.cwd(), absolutePath) });
      }
    }
  };
  await visit(srcRoot);
  return files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}
